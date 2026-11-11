/**
 * DSH 宿主适配器（0.13.1）：把 `flow_finish_node` 注册成**会话级模型工具**，
 * 并在 `agent/turn-stopping` 时用 `agent.steer()` 唤醒提醒。
 *
 * 契约：`docs/design/11-node-finish-tool.md` §4 / §6 / §3.1；适配器形状见
 * `./agent-adapter.js`。
 *
 * 用到的宿主 API 全部来自发行版真实类型（不是实验包，也不依赖
 * `experimental/hook-protocol`——发行版里没有它）：
 *   - `ctx.get('agents').create(options)`：
 *     `@deepseek-ai/dsh-agent/lib/types/index.d.ts:292`
 *   - `options.sessionId` / `meta.cwd,agentPreset` / `agentOptions` / `signal` / `setup`：
 *     `@deepseek-ai/dsh-agent/lib/types/index.d.ts:44-105`（`AgentSetup` / `CreateAgentOptions`）
 *   - `setup(agentCtx, agent)` 里 `agentCtx.tools.register(definition)`：
 *     `@deepseek-ai/dsh-tools/lib/types/index.d.ts:50`
 *   - `setup` 里 `agentCtx.on('agent/turn-stopping', …)`：
 *     `@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:422`
 *   - `agent.steer(message)`：`runtime-types.d.ts:227`；`agent.whenIdle()`：`:191`；
 *     `agent.cancel(cause, options?)`：`:184`；`cause` 取值：
 *     `@deepseek-ai/dsh-session/lib/types/types.d.ts:153`（`{kind:'parent'}`）
 *   - 事件 payload 会注入 `agent` 字段（`@deepseek-ai/dsh-agent/lib/index.js:358-362`）
 *   - `UserMessage` 形状 `{ id, role:'user', source, content:[{type:'text',text}] }`：
 *     `@deepseek-ai/dsh-llm/lib/types/message.d.ts:144`（`MessageBase` 同文件）
 *
 * 生命周期：
 *   start ──► probe（未探测则先探测）──► agents.create(setup: 注册工具 + 挂 turn.stop)
 *     │                                        └─► followup(节点提示词)
 *     │                        工具被调用 ─► finishGate.submit（成功 = 不可逆受理点）
 *     │                                        ─► exited {ok:true, record}
 *     │                        本轮停下但没调 ─► turn-stopping ─► steer(提醒) ×≤maxFires
 *     │                                   提醒用尽 ─► finishGate.abort（未 settled 时）
 *     │                                             ─► exited {ok:false, code:'NODE_FINISH_MISSING', reminders}
 *     │                                             └─ 迟到 submit 一律 NODE_ALREADY_SETTLED
 *     └─ cancel / ctx.signal abort / dispose ─► finishGate.abort + agent.cancel({kind:'parent'})
 *                                     ─► exited {ok:false, code:'NODE_FINISH_CANCELED', reminders}
 *                                     └─ dispose 等待宿主 created.dispose() 有界（默认 2s），
 *                                        超时写 handle.cleanup={disposed:false,timedOut:true}
 *
 * @module @feiyueve/dsh-flow-studio/agent-adapter-dsh
 */

import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  ADAPTER_ERROR, AdapterError, FINISH_TOOL_SUPPORT, HOOK_SUPPORT, assertFinishToolNative,
} from './agent-adapter.js'

/** 注册表里的适配器 id。 */
export const DSH_ADAPTER_ID = 'dsh'

/** 完结工具名（11 §1：只能叫这个名字）。 */
export const FINISH_TOOL_NAME = 'flow_finish_node'

/** 内置 `turn.stop` hook 的默认提醒上限（11 §3.1）。 */
export const DEFAULT_FINISH_REMINDER_MAX_FIRES = 3

/**
 * `dispose()` / `start()` 收尾时等待宿主 `created.dispose()` 的默认 deadline（毫秒）。
 *
 * 宿主释放会话可能永远不 resolve（codex 复审 #6 实测：工具已成功受理、宿主
 * `dispose()` 返回 pending 的 Promise，`runAgentNode()` 的 finally 被无界挂住）。
 * 适配器自己必须有界：超时后返回，并把**真实**清理状态写进 `handle.cleanup`
 * （`disposed:false, timedOut:true`），不声称已清理完成。
 */
export const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000

const TIMED_OUT = Symbol('flow-studio-dispose-timeout')

/**
 * 给一个可能永不决议的 Promise 套 deadline。
 *
 * @param {() => any} factory 真正发起收尾动作（同步抛错也按拒绝处理）
 * @param {number} timeoutMs 正整数 deadline；非法值按「不设上限」处理（调用方已归一）
 * @returns {Promise<{timedOut: true} | {timedOut: false, value?: any, error?: any}>}
 */
async function withDeadline(factory, timeoutMs) {
  let pending
  try {
    pending = Promise.resolve(factory())
  } catch (error) {
    return { timedOut: false, error }
  }
  if (!(Number.isSafeInteger(timeoutMs) && timeoutMs > 0)) {
    return pending.then(
      value => ({ timedOut: false, value }),
      error => ({ timedOut: false, error }),
    )
  }
  let timer = null
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
  })
  const settled = pending.then(
    value => ({ timedOut: false, value }),
    error => ({ timedOut: false, error }),
  )
  const outcome = await Promise.race([settled, timeout])
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  return outcome === TIMED_OUT ? { timedOut: true } : outcome
}

/** 「停下来但没调工具、提醒也用尽」的结局码（11 §3.1；实例仍保持 ACTIVE）。 */
export const NODE_FINISH_MISSING = 'NODE_FINISH_MISSING'

/** 活动被取消（`cancel()` / `ctx.signal` abort）的结局码。 */
export const NODE_FINISH_CANCELED = 'NODE_FINISH_CANCELED'

/**
 * 注入消息的 provenance 标签（**不是**宿主 `MessageSourceMap` 的 `kind`）。
 *
 * 宿主 `MessageSourceMap` 只认 `user | model | tool | system-prompt`
 * （`@deepseek-ai/dsh-llm/lib/types/message.d.ts:101-108`），所以实际消息写成
 * `source.kind='user'` + `source.flowStudio.kind='flow-studio'`：运行时仍是合法
 * user message，审计与 UI 又能按 `flowStudio` 认出是流程注入（m9）。
 */
export const DSH_MESSAGE_SOURCE_KIND = 'flow-studio'

/** 11 §3.1 的固定提醒模板（可被 `reminder.text` 覆盖，不建议）。 */
export const FINISH_REMINDER_TEXT = [
  '【必须调用工具】你还没有调用 flow_finish_node，本节点没有完结，流程不会往下走。',
  '现在就调用它：variables 放后续网关要用的短变量，documents 放你写下的文件相对路径，summary 一句话。',
].join('\n')

/** 11 §6 的节点提示词契约（必须进每一条节点提示词，不是可选项）。 */
export const FINISH_PROMPT_CONTRACT = [
  '做完本节点的活、要往下流转时，必须调用工具 flow_finish_node：',
  '  variables  后续网关要用的短变量（标量）',
  '  documents  你写下的文件的相对路径清单（正文在文件里，不要塞进 variables）',
  '  summary    一句话说明本节点做了什么',
  '不调用该工具就不算完结，流程不会往下走。',
].join('\n')

/**
 * 工具入参 schema（11 §2）。
 *
 * `variables` 用 `additionalProperties` 描述标量值；`documents` 只要求 `path`
 * 必填，其余字段有界可选。真正的上限由 `node-finish.js` 的闸门复核（schema 只是
 * 给模型的约束，不能替代服务端校验）。
 */
export const FINISH_TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    variables: {
      type: 'object',
      description: '后续网关条件要用的短变量：只允许 boolean / number / ≤512 字符的字符串 / null；'
        + '最多 32 个键、序列化后 ≤8 KiB；禁止嵌套对象、数组、文档正文',
      // 宿主 `assertSupportedJsonSchema` 只接受 boolean 的 additionalProperties（m4）：
      // 这里用开放的 `true`，值的形状与上限由 node-finish.js 的闸门真正复核。
      additionalProperties: true,
    },
    documents: {
      type: 'array',
      description: '你写下的文件引用（正文在文件里；最多 32 份，每份 ≤5 MiB，路径必须是工作区内相对路径）',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区内相对路径（禁止绝对路径、`..` 段、反斜杠）' },
          kind: { type: 'string', description: '文档类型，如 markdown / json / text' },
          title: { type: 'string', description: '给人看的标题' },
          summary: { type: 'string', description: '一句话说明这份文档是什么（≤200 字）' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    summary: {
      type: 'string',
      description: '一句话说明本节点做了什么、结论是什么（≤500 字）',
    },
  },
  required: ['variables', 'documents', 'summary'],
  additionalProperties: false,
})

/**
 * 工具输出 schema：成功只回短变量 + 产物**引用**（不含文档正文），
 * 失败回可行动的 `code` / `message`，让模型能改参数重试。
 */
export const FINISH_TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '是否成功受理（同一活动只成功一次）' },
    nodeId: { type: 'string', description: '当前节点 id' },
    summary: { type: 'string', description: '本次受理的 summary' },
    variables: { type: 'object', description: '归一化后的短变量（与网关读到的同一份）' },
    artifacts: {
      type: 'array',
      description: '产物引用（path / sha256 / bytes / kind / title / summary；不含正文）',
      items: { type: 'object' },
    },
    code: { type: 'string', description: '失败错误码，如 NODE_VARIABLES_INVALID' },
    message: { type: 'string', description: '失败的可读原因（含字段定位）' },
    hint: { type: 'string', description: '下一步该怎么做' },
  },
  required: ['ok'],
  additionalProperties: true,
})

/**
 * 适配器能力表（**probe 成功之后**；冻结）。`finishTool: 'native'` 是实测结论：
 * 未成功 `probe()` 前 `capabilities()` 返回 {@link DSH_ADAPTER_UNPROBED_CAPABILITIES}
 * （`unsupported`），不得静态宣称 native（M1）。
 */
export const DSH_ADAPTER_CAPABILITIES = Object.freeze({
  finishTool: FINISH_TOOL_SUPPORT.NATIVE,
  hooks: Object.freeze({ 'turn.stop': HOOK_SUPPORT.NATIVE }),
  cancel: FINISH_TOOL_SUPPORT.NATIVE,
  // 0.13.10：收件箱消息通过 `agent.followup` 投递（新的一轮 / 队列尾部），宿主只能
  // 确认「已交给会话」，不能确认模型一定读过——上层必须显示 deliveryUnknown。
  messages: 'native',
  reminder: Object.freeze({
    mechanism: 'agent.steer',
    maxFires: DEFAULT_FINISH_REMINDER_MAX_FIRES,
  }),
  evidence: Object.freeze({
    finishTool: [
      'agents.create: @deepseek-ai/dsh-agent/lib/types/index.d.ts:292',
      'CreateAgentOptions.setup: @deepseek-ai/dsh-agent/lib/types/index.d.ts:105',
      'agentCtx.tools.register: @deepseek-ai/dsh-tools/lib/types/index.d.ts:50',
    ],
    'turn.stop': [
      'agent/turn-stopping: @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:422',
      'agent.steer: @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:227',
    ],
    cancel: [
      'agent.cancel: @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:184',
      "AgentCancelCause {kind:'parent'}: @deepseek-ai/dsh-session/lib/types/types.d.ts:153",
    ],
    messages: [
      'agent.followup: @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts',
    ],
  }),
})

/**
 * 未 probe（或 probe 失败）时的能力表：只敢声明 `unsupported`。
 *
 * 这不是降级路径——admission 会先 `probe()` 再 `assertFinishToolNative()`；
 * 这里的作用是让任何**直接读** `capabilities()` 的消费者（注册表 / 看板 / UI）
 * 在没探测前不会被误导成「这个适配器能提供原生完结工具」。
 */
export const DSH_ADAPTER_UNPROBED_CAPABILITIES = Object.freeze({
  finishTool: FINISH_TOOL_SUPPORT.UNSUPPORTED,
  hooks: Object.freeze({ 'turn.stop': HOOK_SUPPORT.UNSUPPORTED }),
  cancel: FINISH_TOOL_SUPPORT.NATIVE,
  // probe 之前不宣称可投递：没有会话就没有 followup 通道。
  messages: 'unsupported',
  reminder: DSH_ADAPTER_CAPABILITIES.reminder,
  evidence: Object.freeze({
    finishTool: ['probe() 尚未成功：在 probe() 成功前 finishTool 只能是 unsupported'],
    'turn.stop': ['probe() 尚未成功：宿主会话能力未验证'],
    cancel: DSH_ADAPTER_CAPABILITIES.evidence.cancel,
    messages: ['probe() 尚未成功：收件箱投递能力未验证'],
  }),
})

/**
 * `probe()` 的 helpDigest 物料：把「这个适配器依赖的宿主 API 面」写成固定文本再
 * 取 sha256。宿主升级改变形状时，digest 跟着变，便于把版本漂移写进运行日志。
 */
const DSH_HELP_SURFACE = [
  'dsh-agent CreateAgentOptions{sessionId,meta,agentOptions,signal,setup}',
  'dsh-agent AgentSetup(agentCtx, agent)',
  'dsh-tools agentCtx.tools.register(ToolDefinition) -> disposer',
  'dsh-agent event agent/turn-stopping{agent,turn,signal} (serial)',
  'dsh-agent Agent.followup/steer/whenIdle/cancel',
  'dsh-session AgentCancelCause{user|parent|hook|disposed}',
].join('\n')

/**
 * 由宿主版本与 API 面文本算 `probe().helpDigest`。
 *
 * 版本进摘要（而不是只夹在返回值里）：安装目录取不到版本时 probe 如实报
 * `version:'unknown'`，digest 也随之不同——运行日志里能直接看出「这次探测是在
 * 版本未知的源码树里做的」，测试也不会把 `unknown` 掩盖成正常版本（m9）。
 *
 * @param {string} version
 * @returns {string} sha256 十六进制
 */
export function dshHelpDigest(version) {
  const label = nonEmptyString(version) ? version : 'unknown'
  return createHash('sha256').update(`${DSH_HELP_SURFACE}\nversion:${label}`).digest('hex')
}

/** API 面基线 digest（不含版本；probe 返回的是 {@link dshHelpDigest}(version)）。 */
export const DSH_HELP_DIGEST = createHash('sha256').update(DSH_HELP_SURFACE).digest('hex')

/** 失败结局里可行动的一句「接下来怎么办」。 */
const FINISH_ERROR_HINT = {
  NODE_VARIABLES_INVALID: 'variables 只能放短标量（boolean / number / 短字符串 / null）；文档正文请写进文件并用 documents 引用。',
  NODE_DOCUMENT_INVALID: 'documents 的 path 必须是工作区内相对路径，文件要真实存在且 ≤5 MiB。',
  NODE_FINISH_INVALID: '按 schema 传 { variables, documents, summary } 三个字段。',
  NODE_ALREADY_FINISHED: '本节点已经完结，不要再调用；直接结束本轮。',
  NODE_ALREADY_SETTLED: '本次活动已被中止，调用不会再被受理；结束本轮即可。',
  NODE_FINISH_CANCELED: '工具调用已被取消，本次提交没有被受理；不要再重试，等宿主收尾。',
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

function errorText(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

/** 节点提示词正文：先取 `node.prompt` / `node.roleCard`，都没有才退回标题 / id。 */
function nodePromptBody(element) {
  const node = isPlainObject(element && element.node) ? element.node : {}
  const pieces = [node.prompt, node.roleCard]
    .filter(value => typeof value === 'string' && value.trim() !== '')
    .map(value => value.trim())
  if (pieces.length > 0) return pieces.join('\n\n')
  if (element && nonEmptyString(element.name) && element.name.trim() !== '') return element.name.trim()
  return element && nonEmptyString(element.id) ? element.id : '执行节点'
}

/**
 * 构造节点提示词：节点正文 + 执行上下文 + 11 §6 的完结契约。
 *
 * @param {object} element BPMN agent 元素（`{ id, name, node: { prompt, roleCard } }`）
 * @param {object} [ctx] runner 的 activity context（`{ attempt, variables, … }`）
 * @param {{ workspaceRoot?: string }} [options]
 * @returns {string}
 */
export function buildNodePrompt(element, ctx = {}, options = {}) {
  const attempt = ctx && Number.isSafeInteger(ctx.attempt) && ctx.attempt >= 1 ? ctx.attempt : 1
  const lines = [nodePromptBody(element), `执行上下文：attempt=${attempt}`]
  const variables = isPlainObject(ctx && ctx.variables) ? ctx.variables : {}
  const serialized = safeJson(variables)
  if (serialized !== '{}' && serialized.length <= 4000) lines.push(`当前变量：\n${serialized}`)
  const workspaceRoot = options && nonEmptyString(options.workspaceRoot) ? options.workspaceRoot : ''
  if (workspaceRoot !== '' && workspaceRoot.length <= 1024) {
    lines.push(`工作区（documents.path 的相对基准）：${workspaceRoot}`)
  }
  lines.push(FINISH_PROMPT_CONTRACT)
  return lines.join('\n\n')
}

/**
 * 提醒文本：固定模板 + 本次计数（计数用尽后会以 NODE_FINISH_MISSING 停下）。
 *
 * @param {{ count?: number, maxFires?: number, text?: string }} [options]
 * @returns {string}
 */
export function buildReminderText(options = {}) {
  const base = nonEmptyString(options.text) ? options.text : FINISH_REMINDER_TEXT
  const count = Number.isSafeInteger(options.count) && options.count > 0 ? options.count : null
  const maxFires = Number.isSafeInteger(options.maxFires) && options.maxFires >= 0 ? options.maxFires : null
  if (count === null || maxFires === null) return base
  return `${base}\n（第 ${count}/${maxFires} 次提醒；提醒用尽后本节点会以 ${NODE_FINISH_MISSING} 停下，流程不会继续。）`
}

/**
 * 收件箱消息的模型侧文本（0.13.10）。
 *
 * 正文已在 `instance-inbox` 侧裁剪：长正文只给工作区相对路径 + 摘要，这里不再展开，
 * 也不把 messageId 之外的内部路径写进提示词。
 *
 * @param {object} message `deliverMessage(handle, message)` 的第二个参数
 * @returns {string}
 */
export function buildInboxMessageText(message = {}) {
  const messageId = nonEmptyString(message.messageId) ? message.messageId : '(未知)'
  const reply = nonEmptyString(message.replyTargetId)
    ? `\n可回复目标：${message.replyTargetId}（用 flow_instance_reply）`
    : ''
  const text = typeof message.text === 'string' ? message.text : ''
  return `[流程收件箱消息 ${messageId}]${reply}\n${text}`
}

/** 工具结果的人类可读投影（成功 / 失败都给模型一段可行动文本）。 */
function renderFinishResult(value) {
  const result = isPlainObject(value) ? value : {}
  if (result.ok === true) {
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : []
    const docs = artifacts
      .slice(0, 8)
      .map(item => (item && typeof item.path === 'string' ? item.path : '?'))
    return [{
      type: 'text',
      text: `已受理本节点完结（节点 ${result.nodeId ?? '?'}）。`
        + `summary：${typeof result.summary === 'string' ? result.summary : ''}`
        + (docs.length > 0 ? `；产物：${docs.join('、')}${artifacts.length > docs.length ? '…' : ''}` : '')
        + ' 结束本轮即可，流程会按 variables 继续。',
    }]
  }
  const code = typeof result.code === 'string' ? result.code : 'NODE_FINISH_INVALID'
  const message = typeof result.message === 'string' ? result.message : '未知原因'
  const hint = typeof result.hint === 'string' ? result.hint : '按工具参数说明修正后重试。'
  return [{ type: 'text', text: `完结受理失败（${code}）：${message} ${hint}` }]
}

/**
 * 工具调用是否已被宿主取消（`ToolDefinition.timeoutMs` 的配套契约）。
 * @param {unknown} exec `ToolRunContext`（可能缺省：测试 / 直接调用）
 * @returns {boolean}
 */
function isExecAborted(exec) {
  return Boolean(exec && typeof exec === 'object'
    && exec.signal && typeof exec.signal === 'object' && exec.signal.aborted === true)
}

/** 提交**之前**已取消的工具结果：明确「未受理」，不伪装成完成也不抛出。 */
function abortedToolResult() {
  return {
    ok: false,
    code: NODE_FINISH_CANCELED,
    message: '工具调用在受理之前已被取消（exec.signal 已 abort），本次提交没有被受理。',
    hint: FINISH_ERROR_HINT[NODE_FINISH_CANCELED],
  }
}

/**
 * 创建 `flow_finish_node` 工具定义（每活动执行一份，闭包绑定 `finishGate`）。
 *
 * 工具**只**做一件事：把模型参数交给闸门。校验、文档核验、唯一性、abort 全在
 * `node-finish.js`；成功/失败都以结构化对象返回（失败不抛），让模型能按提示修正重试。
 *
 * @param {{ finishGate: object, element?: object }} options
 * @returns {object} DSH `ToolDefinition`
 */
export function createFinishToolDefinition({ finishGate, element } = {}) {
  if (!finishGate || typeof finishGate.submit !== 'function') {
    throw new AdapterError(
      ADAPTER_ERROR.INVALID,
      'createFinishToolDefinition 需要 node-finish 的 finishGate（含 submit）',
      { field: 'finishGate' },
    )
  }
  const nodeId = element && nonEmptyString(element.id) ? element.id : ''
  return {
    name: FINISH_TOOL_NAME,
    description:
      '完结当前流程节点并让流程继续：把后续网关要用的短变量放进 variables，'
      + '把你写下的文件用 documents 引用（正文在文件里），再用 summary 一句话说明本节点做了什么。'
      + '一次活动只接受一次成功调用；不调用就不算完结，流程不会往下走。'
      + (nodeId !== '' ? `当前节点：${nodeId}。` : ''),
    parameters: FINISH_TOOL_PARAMETERS,
    output: {
      schema: FINISH_TOOL_OUTPUT_SCHEMA,
      render: renderFinishResult,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // 声明了 timeoutMs 就必须遵守 exec.signal（m4）：**提交前**已取消则不碰闸门。
      //
      // 语义（codex 复审 #10）：`finishGate.submit()` 成功返回是**不可逆的受理点**；
      // 一旦它 resolve，闸门已 settled、适配器会按成功推进，工具就必须如实返回
      // `ok:true + record`。提交后再 abort 不能再把「已受理」改写成「没有被受理」——
      // 那是事后篡改事实，只会让模型以为节点没完成而重试。取消只能阻止**尚未受理**
      // 的提交，所以 abort 检查只放在提交之前。
      if (isExecAborted(exec)) return abortedToolResult()
      let submitted
      try {
        submitted = await finishGate.submit(args)
      } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : 'NODE_FINISH_INVALID'
        const result = {
          ok: false,
          code,
          message: errorText(error),
          hint: FINISH_ERROR_HINT[code] || '按工具参数说明修正后重试；不要编造完成结论。',
        }
        if (error && isPlainObject(error.details)) result.details = error.details
        return result
      }
      const record = submitted && submitted.record ? submitted.record : {}
      const artifacts = Array.isArray(record.artifacts)
        ? record.artifacts.map(item => ({
          path: item && item.path,
          sha256: item && item.sha256,
          bytes: item && item.bytes,
          kind: item && item.kind,
          title: item && item.title,
          summary: item && typeof item.summary === 'string' ? item.summary : '',
        }))
        : []
      return {
        ok: true,
        nodeId,
        summary: typeof record.summary === 'string' ? record.summary : '',
        variables: isPlainObject(record.output) ? record.output : {},
        artifacts,
        hint: '本节点已完结；结束本轮即可，流程会按 variables 继续。',
      }
    },
  }
}

/**
 * 释放 `agents.create` 返回的句柄（幂等；失败只 warn，不把释放失败当节点失败）。
 *
 * **有界**：等待宿主 `created.dispose()` 最多 `timeoutMs`。宿主不返回时不再等待，
 * 而是如实返回 `{disposed:false, timedOut:true}`——调用方据此把真实清理状态记到
 * `handle.cleanup`，不能把「等不到」说成「已清理」。
 *
 * @param {{dispose?: Function}|null} created
 * @param {(level: string, message: string) => void} log
 * @param {string} sessionId
 * @param {number} timeoutMs 收尾 deadline（正整数毫秒）
 * @returns {Promise<{disposed: boolean, timedOut: boolean, timeoutMs?: number, elapsedMs?: number, reason?: string, error?: string}>}
 */
async function disposeAgentHandle(created, log, sessionId, timeoutMs) {
  if (!created || typeof created.dispose !== 'function') {
    return { disposed: true, timedOut: false, reason: created ? 'no-dispose' : 'no-handle' }
  }
  const startedAt = Date.now()
  const outcome = await withDeadline(() => created.dispose(), timeoutMs)
  const elapsedMs = Date.now() - startedAt
  if (outcome.timedOut) {
    log('warn', `flow-studio: 释放节点会话超时（${sessionId}，deadline=${timeoutMs}ms）：`
      + '宿主 created.dispose() 仍未返回；不再等待，按未完成清理记录（disposed=false, timedOut=true）')
    return { disposed: false, timedOut: true, timeoutMs, elapsedMs }
  }
  if (Object.prototype.hasOwnProperty.call(outcome, 'error')) {
    log('warn', `flow-studio: 释放节点会话失败（${sessionId}）：${errorText(outcome.error)}`)
    return { disposed: false, timedOut: false, timeoutMs, elapsedMs, error: errorText(outcome.error) }
  }
  return { disposed: true, timedOut: false, timeoutMs, elapsedMs }
}

function normalizeMaxFires(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function safeService(hostCtx, name) {
  if (!hostCtx || typeof hostCtx !== 'object') return undefined
  try {
    if (typeof hostCtx.get === 'function') {
      const service = hostCtx.get(name)
      if (service) return service
    }
  } catch {
    // ctx.get 在未加载该服务时可能抛错：按「没有」处理。
  }
  const direct = hostCtx[name]
  return direct || undefined
}

/** 优先用 start 的 runner ctx（接线方可能注入），再退回工厂时的宿主 ctx。 */
function resolveAgents(options, runnerCtx) {
  const fromRunner = safeService(runnerCtx, 'agents')
  if (fromRunner && typeof fromRunner.create === 'function') return fromRunner
  const injected = options && options.agents
  if (injected && typeof injected.create === 'function') return injected
  return safeService(options && options.ctx, 'agents')
}

function pickRoute(value) {
  if (!isPlainObject(value)) return null
  if (!nonEmptyString(value.provider) || !nonEmptyString(value.model)) return null
  const route = { provider: value.provider, model: value.model }
  if (nonEmptyString(value.reasoningEffort)) route.reasoningEffort = value.reasoningEffort
  return route
}

function resolveAgentOptions(options, runnerCtx, element) {
  const node = isPlainObject(element && element.node) ? element.node : {}
  // BPMN 里 provider / model 是**两个字符串属性**（`fs:node@provider` / `@model`），
  // 必须自己拼成 pair，否则 pickRoute 只看到单个 model 会整条丢掉——节点就会以
  // 「has no provider/model」失败（codex 复审实测）。
  const nodeRoute = { provider: node.provider, model: node.model }
  const candidates = [
    options && options.agentOptions,
    runnerCtx && runnerCtx.agentOptions,
    node.agentOptions,
    nodeRoute,
    node.model,
  ]
  for (const candidate of candidates) {
    const route = pickRoute(candidate)
    if (route) return route
  }
  return null
}

function resolveAgentPreset(options, runnerCtx, element) {
  const node = isPlainObject(element && element.node) ? element.node : {}
  const candidates = [
    options && options.agentPreset,
    runnerCtx && runnerCtx.agentPreset,
    node.agentPreset,
  ]
  for (const candidate of candidates) {
    if (nonEmptyString(candidate)) return candidate
  }
  return null
}

function resolveSessionId(options, runnerCtx, element) {
  const explicit = [
    options && options.sessionId,
    runnerCtx && runnerCtx.sessionId,
  ].find(nonEmptyString)
  if (explicit) return explicit
  const rawId = element && nonEmptyString(element.id) ? element.id : 'node'
  const safe = rawId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'node'
  return `flow-${safe}-${randomUUID().slice(0, 8)}`
}

/**
 * 解析宿主版本：注入的 `version`（接线方已知）→ `versionProvider()`（嵌入方注入的
 * 取值器）→ 从可解析的 `@deepseek-ai/dsh/package.json` 读 → 宿主 app-boot 的
 * `getDshRuntimeVersion()` → 如实返回 `'unknown'`。
 *
 * 源码树里（包不在 node_modules）最后一步会失败，这是**正常结果**，不伪造
 * `0.0.0`：probe 与 helpDigest 都会把 `unknown` 暴露出来（m9）。
 *
 * @param {object} options createDshAdapter 的 options
 * @returns {Promise<string>}
 */
async function resolveHostVersion(options) {
  if (options && nonEmptyString(options.version) && options.version.trim() !== '') {
    return options.version.trim()
  }
  if (options && typeof options.versionProvider === 'function') {
    try {
      const value = await options.versionProvider()
      if (nonEmptyString(value) && value.trim() !== '') return value.trim()
    } catch {
      // 取值器失败按「没取到」处理，继续尝试后面的来源。
    }
  }
  try {
    const requireFromHere = createRequire(import.meta.url)
    const pkg = requireFromHere('@deepseek-ai/dsh/package.json')
    if (pkg && nonEmptyString(pkg.version)) return pkg.version
  } catch {
    // 源码树 / 非 pnpm 布局下解析不到：继续。
  }
  try {
    const boot = await import('@deepseek-ai/dsh-app-boot')
    if (boot && typeof boot.getDshRuntimeVersion === 'function') {
      const value = boot.getDshRuntimeVersion()
      if (nonEmptyString(value)) return value
    }
  } catch {
    // 宿主没有暴露 app-boot（或解析不到）：继续。
  }
  return 'unknown'
}

/**
 * 创建 DSH 适配器。
 *
 * @param {{
 *   ctx?: object,            // 宿主 Cordis context（`ctx.get('agents')`）
 *   agents?: object,         // 直接注入 agents 服务（测试 / 特殊接线）
 *   agentOptions?: object,   // 默认模型路由（provider + model 成对才生效）
 *   agentPreset?: string,
 *   sessionId?: string,
 *   version?: string,        // probe() 报告的宿主版本（最高优先级）
 *   versionProvider?: () => (string|Promise<string>), // 嵌入方提供版本来源（次优先）
 *   maxFires?: number,       // 提醒上限默认值（默认 3）
 *   disposeTimeoutMs?: number, // 等待宿主 created.dispose() 的 deadline（默认 2000ms）
 *   now?: () => Date,
 *   log?: (level: string, message: string) => void,
 * }} [options]
 * @returns {object} 适配器（形状见 `./agent-adapter.js`）
 */
export function createDshAdapter(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const log = typeof options.log === 'function' ? options.log : () => {}
  const defaultMaxFires = normalizeMaxFires(options.maxFires, DEFAULT_FINISH_REMINDER_MAX_FIRES)
  // 收尾 deadline 必须有界（codex 复审 #6）：非法 / 未配置都退回 2s。
  const disposeTimeoutMs = Number.isSafeInteger(options.disposeTimeoutMs) && options.disposeTimeoutMs > 0
    ? options.disposeTimeoutMs
    : DEFAULT_DISPOSE_TIMEOUT_MS
  /** @type {WeakMap<object, object>} handle → 内部状态 */
  const states = new WeakMap()

  /** probe 成功后才允许宣称 native（M1）；成功结果缓存，失败可重试。 */
  let probed = false
  /** @type {{version: string, helpDigest: string}|null} */
  let probeResult = null
  /** @type {Promise<{version: string, helpDigest: string}>|null} */
  let probeInflight = null

  const adapter = {
    id: DSH_ADAPTER_ID,

    capabilities() {
      return probed ? DSH_ADAPTER_CAPABILITIES : DSH_ADAPTER_UNPROBED_CAPABILITIES
    },

    async probe() {
      if (probed && probeResult) return { ...probeResult }
      if (probeInflight) return probeInflight
      probeInflight = (async () => {
        const agents = resolveAgents(options, undefined)
        if (!agents || typeof agents.create !== 'function') {
          throw new AdapterError(
            ADAPTER_ERROR.PROBE_INVALID,
            'dsh 宿主没有可用的 agents.create：无法创建节点会话，也就无法提供 flow_finish_node',
            { adapterId: DSH_ADAPTER_ID, field: 'agents.create', reason: 'missing' },
          )
        }
        const version = (await resolveHostVersion(options)) || 'unknown'
        const result = { version, helpDigest: dshHelpDigest(version) }
        probed = true
        probeResult = result
        return result
      })()
      try {
        return await probeInflight
      } finally {
        probeInflight = null
      }
    },

    async start(request) {
      const req = isPlainObject(request) ? request : {}
      const element = isPlainObject(req.element) ? req.element : {}
      const runnerCtx = isPlainObject(req.ctx) ? req.ctx : {}
      const finishGate = req.finishGate
      if (!finishGate
        || typeof finishGate.submit !== 'function'
        || typeof finishGate.settled !== 'function'
        || typeof finishGate.abort !== 'function'
        || !finishGate.result
        || typeof finishGate.result.then !== 'function') {
        throw new AdapterError(
          ADAPTER_ERROR.INVALID,
          'start 需要 node-finish 的 finishGate（submit / settled / abort / result；result 必须是 Promise）',
          { adapterId: DSH_ADAPTER_ID, field: 'finishGate' },
        )
      }
      const signal = runnerCtx.signal && typeof runnerCtx.signal === 'object'
        && typeof runnerCtx.signal.aborted === 'boolean'
        ? runnerCtx.signal
        : null
      if (signal && signal.aborted) {
        throw new AdapterError(
          NODE_FINISH_CANCELED,
          'start 时 ctx.signal 已经 abort：不创建节点会话',
          { adapterId: DSH_ADAPTER_ID, field: 'ctx.signal', reason: 'pre-aborted' },
        )
      }

      // M1：capabilities 在 probe 成功前是 unsupported，所以 start 必须先确保 probe；
      // probe 失败按「没有原生完结工具」拒绝启动（11 §1.6），不静默降级。
      try {
        await adapter.probe()
      } catch (error) {
        throw new AdapterError(
          ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
          `dsh 适配器 probe 失败：${errorText(error)}（按不可用处理，不派发节点）`,
          { adapterId: DSH_ADAPTER_ID, phase: 'start', field: 'probe', reason: 'probe-failed', cause: error },
        )
      }
      // 契约：没有 native 工具能力的适配器直接拒绝启动（11 §1.6）。
      assertFinishToolNative(adapter, { phase: 'start' })

      const agents = resolveAgents(options, runnerCtx)
      if (!agents || typeof agents.create !== 'function') {
        throw new AdapterError(
          'DSH_AGENTS_UNAVAILABLE',
          '宿主 agents 服务不可用（没有 create）：无法创建节点会话',
          { adapterId: DSH_ADAPTER_ID, field: 'agents' },
        )
      }

      const nodeId = nonEmptyString(element.id) ? element.id : ''
      const reminderConfig = isPlainObject(req.reminder) ? req.reminder : {}
      const maxFires = normalizeMaxFires(reminderConfig.maxFires, defaultMaxFires)
      const workspaceRoot = nonEmptyString(req.workspaceRoot)
        ? req.workspaceRoot
        : (isPlainObject(req.workspace) && nonEmptyString(req.workspace.effectiveRoot)
          ? req.workspace.effectiveRoot
          : '')
      const sessionId = resolveSessionId(options, runnerCtx, element)

      let resolveExited
      const exited = new Promise(resolve => { resolveExited = resolve })

      /** 单活动执行状态（闭包；handle 通过 WeakMap 反查）。 */
      const st = {
        settled: false,
        outcome: null,
        canceled: false,
        agentCanceled: false,
        cancelReason: null,
        reminders: 0,
        maxFires,
        agent: null,
        createdHandle: null,
        sessionId,
        toolDispose: null,
        inboxToolDispose: null,
        unlisteners: [],
        signalOff: null,
        disposed: false,
        cleanup: null,
        handle: null,
      }

      const settle = outcome => {
        if (st.settled) return false
        st.settled = true
        st.outcome = outcome
        cleanupSignal()
        resolveExited(outcome)
        return true
      }

      /**
       * 提醒用尽：结局是 `NODE_FINISH_MISSING`，但闸门**不能继续 pending**——
       * 未 settled 时先 `abort`，迟到的 `submit` 永远得到 `NODE_ALREADY_SETTLED`，
       * 不能被后来的工具调用追认成一次完成（M3）。
       */
      const settleMissing = () => {
        if (st.settled) return false
        if (!finishGate.settled()) {
          try {
            finishGate.abort(`${NODE_FINISH_MISSING} after ${st.reminders} reminder(s)`)
          } catch (error) {
            log('warn', `flow-studio: MISSING 时 finishGate.abort 失败：${errorText(error)}`)
          }
        }
        return settle({
          ok: false,
          code: NODE_FINISH_MISSING,
          reminders: st.reminders,
        })
      }

      function cleanupSignal() {
        if (st.signalOff) {
          try {
            st.signalOff()
          } catch {
            // removeEventListener 失败不影响结局。
          }
          st.signalOff = null
        }
      }

      function cleanupTransient() {
        cleanupSignal()
        for (const off of st.unlisteners.splice(0)) {
          try {
            off()
          } catch (error) {
            log('warn', `flow-studio: 卸载 turn.stop 监听失败：${errorText(error)}`)
          }
        }
        if (st.toolDispose) {
          const dispose = st.toolDispose
          st.toolDispose = null
          try {
            dispose()
          } catch (error) {
            log('warn', `flow-studio: 注销 ${FINISH_TOOL_NAME} 失败：${errorText(error)}`)
          }
        }
        if (st.inboxToolDispose) {
          const dispose = st.inboxToolDispose
          st.inboxToolDispose = null
          try {
            dispose()
          } catch (error) {
            log('warn', `flow-studio: 注销收件箱工具失败：${errorText(error)}`)
          }
        }
      }
      // cancel / dispose 是适配器级方法（在 start 之外），通过状态对象拿到本次执行的闭包。
      st.cleanupTransient = cleanupTransient

      /**
       * 收掉节点会话（幂等）：`agent.cancel({kind:'parent'})` 恰好一次。
       * MISSING 之后句柄还没 dispose 时也要靠它把会话停住（m2）。
       * @returns {boolean} 本次是否真的发出 cancel
       */
      const cancelAgent = (reason) => {
        if (st.agentCanceled) return false
        if (!st.agent || typeof st.agent.cancel !== 'function') return false
        st.agentCanceled = true
        const reasonText = reason === undefined ? 'cancel' : String(reason)
        try {
          const pending = st.agent.cancel({ kind: 'parent' })
          // cancel 不等待宿主收尾（有界性见 cancel()），但必须接住宿主返回的
          // Promise 的 rejection，否则会变成 unhandled rejection。
          if (pending && typeof pending.then === 'function') {
            Promise.resolve(pending).catch((error) => {
              log('warn', `flow-studio: agent.cancel 异步失败（${reasonText}）：${errorText(error)}`)
            })
          }
        } catch (error) {
          log('warn', `flow-studio: agent.cancel 失败（${reasonText}）：${errorText(error)}`)
        }
        return true
      }

      /**
       * 取消（幂等，第一次生效）：abort 闸门 → `agent.cancel({kind:'parent'})` → 结局 canceled。
       * 创建还没回来时也先记下，迟到句柄在 start 收尾时 dispose。
       */
      const cancelState = reason => {
        if (st.canceled) return false
        st.canceled = true
        st.cancelReason = reason === undefined ? null : reason
        const reasonText = st.cancelReason === null ? 'canceled' : String(st.cancelReason)
        if (!finishGate.settled()) {
          try {
            finishGate.abort(reasonText)
          } catch (error) {
            log('warn', `flow-studio: finishGate.abort 失败：${errorText(error)}`)
          }
        }
        cancelAgent(reasonText)
        settle({ ok: false, code: NODE_FINISH_CANCELED, reminders: st.reminders })
        return true
      }
      st.cancelState = cancelState
      st.cancelAgent = cancelAgent

      const onAbort = () => {
        const reason = signal && signal.reason !== undefined ? signal.reason : 'ctx.signal aborted'
        cancelState(reason)
      }
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true })
        st.signalOff = () => signal.removeEventListener('abort', onAbort)
      }

      // 闸门自己收口（工具成功 / 外部 abort）时同步结局，adapter 不再另判一套。
      Promise.resolve(finishGate.result).then((record) => {
        if (st.settled) return
        settle({ ok: true, record })
      }, (error) => {
        if (st.settled) return
        if (error && error.aborted === true) {
          cancelState(error.reason !== undefined ? error.reason : 'gate aborted')
          return
        }
        settle({
          ok: false,
          code: 'NODE_FINISH_FAILED',
          reminders: st.reminders,
          message: errorText(error),
        })
      })

      const userMessage = (text, phase) => ({
        id: `flow-${nodeId || 'node'}-${randomUUID()}`,
        role: 'user',
        // 宿主 MessageSourceMap 只认 `user`（m9）；流程来源放进同级的 flowStudio 元数据。
        source: {
          kind: 'user',
          flowStudio: {
            kind: DSH_MESSAGE_SOURCE_KIND,
            nodeId,
            from: `flow-studio:${DSH_ADAPTER_ID}`,
            phase,
            at: now().toISOString(),
          },
        },
        content: [{ type: 'text', text }],
      })

      /** `turn.stop` hook：没完结就 steer 一条提醒；次数用尽则记 NODE_FINISH_MISSING。 */
      const onTurnStopping = async (payload) => {
        if (st.settled || st.canceled) return
        if (finishGate.settled()) return
        if (st.reminders >= st.maxFires) {
          settleMissing()
          return
        }
        st.reminders += 1
        const count = st.reminders
        const info = {
          count,
          maxFires: st.maxFires,
          nodeId,
          sessionId: st.sessionId,
          at: now().toISOString(),
        }
        if (typeof reminderConfig.onFire === 'function') {
          try {
            await reminderConfig.onFire(info)
          } catch (error) {
            log('warn', `flow-studio: reminder.onFire 抛错（不影响提醒）：${errorText(error)}`)
          }
        }
        const agent = (payload && payload.agent) || st.agent
        if (!agent || typeof agent.steer !== 'function') {
          log('warn', `flow-studio: 节点 ${nodeId} 的会话不能 steer，提醒 ${count} 未发送`)
          return
        }
        try {
          agent.steer(userMessage(buildReminderText({
            count,
            maxFires: st.maxFires,
            text: reminderConfig.text,
          }), 'reminder'))
        } catch (error) {
          log('warn', `flow-studio: steer 提醒失败（节点 ${nodeId}）：${errorText(error)}`)
        }
      }

      /**
       * 会话级错误（模型路由不可用 / provider 鉴权失败等）：真实原因必须冒泡。
       *
       * 不订阅它时，`whenIdle` 兜底会把「会话根本没跑起来」记成
       * `NODE_FINISH_MISSING`（没调工具），把故障掩盖成 agent 行为问题——2026-11-11
       * 在容器测试台第一次跑 dsh 节点时实际踩到（0.3s、reminders:0）。
       *
       * `agent/error` 是终态错误；可重试的单次请求失败走 `agent/request-error`，不在这里拦。
       */
      const onAgentError = (payload) => {
        if (st.settled || st.canceled) return
        if (finishGate.settled()) return
        if (!finishGate.settled()) {
          try {
            finishGate.abort('agent failed')
          } catch (error) {
            log('warn', `flow-studio: finishGate.abort 失败：${errorText(error)}`)
          }
        }
        settle({
          ok: false,
          code: 'DSH_AGENT_FAILED',
          reminders: st.reminders,
          message: errorText(payload && payload.error !== undefined ? payload.error : 'agent 报错'),
        })
      }

      /**
       * setup 在会话**发布之前**执行（`agent/created` 之前），所以工具与监听一定在
       * `followup` 的第一个 step 之前就绪。
       */
      const setup = async (agentCtx) => {
        const tools = agentCtx && agentCtx.tools
        if (!tools || typeof tools.register !== 'function') {
          throw new AdapterError(
            ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
            `DSH 会话没有 tools.register：无法把 ${FINISH_TOOL_NAME} 暴露给模型；`
              + '按 11 §1.6 拒绝启动，不退回解析文本',
            { adapterId: DSH_ADAPTER_ID, nodeId, field: 'agentCtx.tools.register' },
          )
        }
        const dispose = tools.register(createFinishToolDefinition({ finishGate, element }))
        if (typeof dispose !== 'function') {
          throw new AdapterError(
            ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
            `tools.register 没有返回 disposer：${FINISH_TOOL_NAME} 无法安全回收，按不可用处理`,
            { adapterId: DSH_ADAPTER_ID, nodeId, field: 'agentCtx.tools.register' },
          )
        }
        st.toolDispose = dispose
        if (!agentCtx || typeof agentCtx.on !== 'function') {
          // `agent/turn-stopping` 只能在会话里拿到：缺了就没有提醒能力，按「工具通道
          // 不可用」拒绝启动，不静默退化成无提醒（M1）。
          throw new AdapterError(
            ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
            'DSH 会话没有 agentCtx.on：无法订阅 agent/turn-stopping，`turn.stop` 提醒不可用；'
              + '按 11 §1.6 拒绝启动',
            { adapterId: DSH_ADAPTER_ID, nodeId, field: 'agentCtx.on', reason: 'hook-unavailable' },
          )
        }
        const off = agentCtx.on('agent/turn-stopping', payload => onTurnStopping(payload))
        if (typeof off === 'function') st.unlisteners.push(off)
        // 会话错误必须让真实原因冒泡，不能被 whenIdle 兜底成 NODE_FINISH_MISSING。
        const offError = agentCtx.on('agent/error', payload => onAgentError(payload))
        if (typeof offError === 'function') st.unlisteners.push(offError)
        // 0.13.10：宿主可把「绑定本实例/执行身份」的收件箱工具注册进这个会话。
        // 未提供时保持旧行为（全局工具仍在宿主 tools 服务里）。
        if (typeof req.registerTools === 'function') {
          let disposeTools
          try {
            disposeTools = await req.registerTools(agentCtx, { element, ctx: runnerCtx })
          } catch (error) {
            throw new AdapterError(
              'DSH_INBOX_TOOLS_UNAVAILABLE',
              `注册收件箱工具失败（节点 ${nodeId}）：${errorText(error)}`,
              { adapterId: DSH_ADAPTER_ID, nodeId, field: 'registerTools', cause: error },
            )
          }
          if (typeof disposeTools === 'function') st.inboxToolDispose = disposeTools
        }
      }

      const meta = {}
      if (workspaceRoot !== '') meta.cwd = workspaceRoot
      const preset = resolveAgentPreset(options, runnerCtx, element)
      if (preset) meta.agentPreset = preset
      const agentOptions = resolveAgentOptions(options, runnerCtx, element)

      const createOptions = {
        sessionId,
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
        ...(agentOptions ? { agentOptions } : {}),
        ...(signal ? { signal } : {}),
        setup,
      }

      const makeHandle = () => {
        if (st.handle) return st.handle
        const handle = {
          exited,
          get sessionId() { return st.sessionId },
          // DSH 里 agent 的注册身份就是 sessionId（没有独立的 agentId）。
          get agentId() { return st.sessionId },
          get agent() { return st.agent },
          // dispose 之前为 null；之后是真实清理状态（宿主不返回时 disposed=false、
          // timedOut=true——调用方据此知道「没清完」，不能当成已释放）。
          get cleanup() { return st.cleanup },
        }
        st.handle = handle
        states.set(handle, st)
        return handle
      }

      const disposeCreated = created => disposeAgentHandle(created, log, sessionId, disposeTimeoutMs)

      let created = null
      try {
        created = await agents.create(createOptions)
      } catch (error) {
        cleanupTransient()
        if (st.canceled) return makeHandle()
        if (error instanceof AdapterError) throw error
        throw new AdapterError(
          'DSH_AGENT_CREATE_FAILED',
          `创建节点会话失败（${sessionId}）：${errorText(error)}`,
          { adapterId: DSH_ADAPTER_ID, nodeId, sessionId, reason: 'create-failed' },
        )
      }
      st.createdHandle = created

      if (st.canceled) {
        // 迟到创建结果：取消发生在 create 期间，句柄一回来就释放，绝不留活会话。
        // 释放同样有界；超时也要如实记到即将返回的 handle 上，不能被后来的 dispose
        // 用「没有句柄可释放」覆盖成已清理。
        cleanupTransient()
        const cleanup = await disposeCreated(created)
        st.createdHandle = null
        st.cleanup = { ...cleanup, finishedAt: now().toISOString() }
        return makeHandle()
      }

      const agent = created && created.agent ? created.agent : null
      if (!agent || typeof agent.followup !== 'function') {
        cleanupTransient()
        await disposeCreated(created)
        throw new AdapterError(
          'DSH_AGENT_UNAVAILABLE',
          `会话 ${sessionId} 创建后不可用（没有 followup）`,
          { adapterId: DSH_ADAPTER_ID, nodeId, sessionId },
        )
      }
      st.agent = agent
      /**
       * 收件箱投递通道（0.13.10）：`followup` 在宿主里是「排队一轮新用户消息」，
       * 不等待这一轮结束，所以投递是**有界**的；但只能确认消息已交给会话，
       * 不能确认模型读过，上层据此标 deliveryUnknown / 非 exactly-once。
       */
      st.deliverInbox = text => {
        if (st.settled || st.canceled) return false
        const pending = agent.followup(userMessage(text, 'inbox'))
        if (pending && typeof pending.then === 'function') {
          Promise.resolve(pending).catch((error) => {
            log('warn', `flow-studio: 收件箱消息投递异步失败（节点 ${nodeId}）：${errorText(error)}`)
          })
        }
        return true
      }

      try {
        agent.followup(userMessage(buildNodePrompt(element, runnerCtx, { workspaceRoot }), 'prompt'))
      } catch (error) {
        cleanupTransient()
        await disposeCreated(created)
        throw new AdapterError(
          'DSH_FOLLOWUP_FAILED',
          `投递节点提示词失败（${sessionId}）：${errorText(error)}`,
          { adapterId: DSH_ADAPTER_ID, nodeId, sessionId },
        )
      }

      // whenIdle 收口仍没完结：hook 没触发（或宿主没有 hook）时的兜底，结局同样是
      // NODE_FINISH_MISSING，不伪造成功。
      if (typeof agent.whenIdle === 'function') {
        Promise.resolve().then(() => agent.whenIdle()).then(() => {
          if (st.settled || st.canceled) return
          if (finishGate.settled()) return
          settleMissing()
        }, (error) => {
          if (st.settled || st.canceled) return
          settle({
            ok: false,
            code: 'DSH_AGENT_FAILED',
            reminders: st.reminders,
            message: errorText(error),
          })
        })
      }

      return makeHandle()
    },

    /**
     * 可选能力（0.13.10）：把收件箱消息投递给本次节点会话。
     *
     * 返回 `{ok:true, deliveryUnknown:true}`：`followup` 只保证消息排进会话队列，
     * 不保证模型在本次完结前读到（因此不声称 exactly-once）。会话已完结 / 已取消
     * 时明确拒绝，宿主会把消息记为 failed，而不是假投递。
     *
     * @param {object} handle `start()` 返回的句柄
     * @param {object} message 收件箱投递载荷
     */
    async deliverMessage(handle, message) {
      const st = handle && typeof handle === 'object' ? states.get(handle) : undefined
      if (!st) {
        throw new AdapterError(
          ADAPTER_ERROR.INVALID,
          'deliverMessage 收到不认识的 handle（必须用 start 返回的句柄）',
          { adapterId: DSH_ADAPTER_ID, field: 'handle' },
        )
      }
      if (st.settled || st.canceled) {
        return {
          ok: false,
          code: 'DSH_SESSION_NOT_ACTIVE',
          error: '节点会话已完结或已取消，不能继续投递收件箱消息',
          deliveryUnknown: true,
        }
      }
      if (typeof st.deliverInbox !== 'function') {
        return {
          ok: false,
          code: 'DSH_DELIVERY_UNAVAILABLE',
          error: '节点会话还没有 followup 通道（创建尚未完成）',
          deliveryUnknown: true,
        }
      }
      try {
        const accepted = st.deliverInbox(buildInboxMessageText(isPlainObject(message) ? message : {}))
        if (accepted !== true) {
          return {
            ok: false,
            code: 'DSH_SESSION_NOT_ACTIVE',
            error: '节点会话已收口，投递被拒绝',
            deliveryUnknown: true,
          }
        }
      } catch (error) {
        return {
          ok: false,
          code: 'DSH_INBOX_DELIVERY_FAILED',
          error: errorText(error),
          deliveryUnknown: true,
        }
      }
      return {
        ok: true,
        // 只确认「已交给会话」；不承诺模型读过，也不承诺 exactly-once。
        deliveryUnknown: true,
        accepted: true,
      }
    },

    async cancel(handle, reason) {
      // cancel **全程同步**：abort 闸门 + `agent.cancel()` + resolve exited，不 await
      // 宿主任何 Promise（`agent.cancel` 的返回值也刻意不等待），所以它天然有界，
      // 不需要单独的 deadline；真正可能挂住的是 dispose 里的 `created.dispose()`，
      // 那一段由 disposeTimeoutMs 限制（codex 复审 #6）。
      const st = handle && typeof handle === 'object' ? states.get(handle) : undefined
      if (!st) {
        throw new AdapterError(
          ADAPTER_ERROR.INVALID,
          'cancel 收到不认识的 handle（必须用 start 返回的句柄）',
          { adapterId: DSH_ADAPTER_ID, field: 'handle' },
        )
      }
      if (st.canceled) return false
      if (st.settled) {
        // 已经以 NODE_FINISH_MISSING 停下、但句柄还没 dispose：仍要把节点会话收掉。
        // 成功完结（有 record）不在这里 cancel——那由 dispose 句柄负责释放。
        if (st.outcome && st.outcome.code === NODE_FINISH_MISSING
          && typeof st.cancelAgent === 'function') {
          return st.cancelAgent(reason === undefined ? 'cancel-after-missing' : reason)
        }
        return false
      }
      if (typeof st.cancelState !== 'function') return false
      return st.cancelState(reason)
    },

    async dispose(handle) {
      const st = handle && typeof handle === 'object' ? states.get(handle) : undefined
      if (!st) {
        throw new AdapterError(
          ADAPTER_ERROR.INVALID,
          'dispose 收到不认识的 handle（必须用 start 返回的句柄）',
          { adapterId: DSH_ADAPTER_ID, field: 'handle' },
        )
      }
      if (st.disposed) return false
      st.disposed = true
      // dispose 视为一次取消：未 settle 时**先** abort 闸门并把 exited resolve 成
      // NODE_FINISH_CANCELED——绝不留一个永远 pending 的 exited（m2）。
      if (!st.settled && typeof st.cancelState === 'function') {
        st.cancelState('disposed')
      } else if (st.outcome && st.outcome.code === NODE_FINISH_MISSING
        && typeof st.cancelAgent === 'function') {
        // MISSING 之后 runner 可能只走 dispose：这里补上 agent.cancel，会话不留活口。
        st.cancelAgent('disposed-after-missing')
      }
      if (typeof st.cleanupTransient === 'function') st.cleanupTransient()
      // 收尾有界（codex 复审 #6）：宿主 created.dispose() 永不 resolve 时，
      // disposeAgentHandle 在 disposeTimeoutMs 后返回；这里如实记录清理状态，
      // 不能无限等待、也不能声称已清理完成。
      const previousCleanup = st.cleanup
      const created = st.createdHandle
      st.createdHandle = null
      const result = await disposeAgentHandle(created, log, st.sessionId, disposeTimeoutMs)
      const finishedAt = now().toISOString()
      if (previousCleanup
        && previousCleanup.timedOut === true
        && previousCleanup.disposed === false
        && created === null) {
        // 之前那次宿主 dispose 已超时、会话可能还活着；这次没有新句柄可释放。
        // 保留「未完成清理」的事实，只补记一次重试时间。
        st.cleanup = { ...previousCleanup, retriedAt: finishedAt }
        return true
      }
      st.cleanup = {
        disposed: result.disposed === true,
        timedOut: result.timedOut === true,
        timeoutMs: disposeTimeoutMs,
        startedAt: previousCleanup && previousCleanup.startedAt ? previousCleanup.startedAt : finishedAt,
        finishedAt,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(typeof result.elapsedMs === 'number' ? { elapsedMs: result.elapsedMs } : {}),
        ...(result.error ? { error: result.error } : {}),
      }
      return true
    },
  }

  return adapter
}
