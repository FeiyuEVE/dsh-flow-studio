/**
 * 模型工具：让主 agent 在自己的会话里直接开跑一个流程，并定时唤醒自审。
 *
 * 闭环（也是工具描述里必须让模型一眼看懂的三步）：
 *   ① `flow_start` 用**当前会话的 Agent** 作父会话启动 run ——
 *      `request.parent = exec.agent`、`request.cwd` 省略，子 agent 因此继承本会话工作区，
 *      不需要（也不应该）再选目录；
 *   ② 用 `proactive_set` 把返回的 `supervision.alarmPrompt` 挂成定时闹钟
 *      （`after_seconds = supervision.nextCheckSeconds`）；
 *   ③ 每次醒来调 `flow_watch` 审查「整个工作流是否在正常运转」：
 *      healthy 就 `proactive_reclaim` 安静结束，出现异常或已跑完才通知主人。
 *
 * 约定（与 DSH 工具契约一致）：
 *  - `parameters` 是完整 JSON Schema（只用 DSH 强制子集：type/properties/required/items/enum/oneOf/
 *    additionalProperties/description），字段上限写进 description；
 *  - `execute` 只返回 lossless JSON（无 undefined / NaN / Date），失败一律
 *    `{ok:false, error, hint, retryable}`，不抛异常（唯一例外是取消时也走失败返回值）；
 *  - `output.schema` 声明成功与失败两种形状；可空字段一律 `oneOf:[X, null]`；
 *  - 只读工具标 `isConcurrencySafe`；写工具（start / stop）不标，串行执行；
 *  - 审计只报告、不修复、不自动停止：动作留给模型决定（见 `flow_watch`）。
 *
 * 数据来源全部复用既有 Host 逻辑：`listFlows` / `readFlow`（store）、
 * `createRun` / `listRuns` / `readRunDetail` / `readAllEvents`（runstore）、
 * `checkRunId`（runlog）、`validateFlowForRun`（engine），不复制第二份建 run / 开跑逻辑。
 *
 * @module @feiyueve/dsh-flow-studio/tools
 */

import { validateFlowForRun } from './engine.js'
import { deliverInboundMessage, deliverOutboundReply, validateReplyTarget } from './inbox.js'
import { NODE_KIND } from './model.js'
import { checkRunId } from './runlog.js'
import {
  createRun, listRuns, readAllEvents, readNodeSessions, readRunDetail, readRunMeta,
} from './runstore.js'
import { checkId, listFlows, readFlow } from './store.js'

/** 默认审查间隔（秒）：给模型挂 `proactive_set` 的 `after_seconds`。 */
export const DEFAULT_WATCH_SECONDS = 180

/** 工具超时预算（毫秒）。stop 要等循环收尾，给得比 start 宽。 */
const TIMEOUT_LIST_MS = 15_000
const TIMEOUT_START_MS = 120_000
const TIMEOUT_WATCH_MS = 30_000
const TIMEOUT_STOP_MS = 120_000
const TIMEOUT_SEND_MS = 60_000
const TIMEOUT_REPLY_MS = 30_000

/** 审计参数的默认口径（与引擎节点超时一致；可被 deps 覆盖，测试用）。 */
const DEFAULT_STALL_MS = 10 * 60 * 1000
const DEFAULT_NODE_TIMEOUT_MS = 20 * 60 * 1000
const DEFAULT_MAX_REJECTS_PER_EDGE = 3

/** 终态 verdict：到这三个就不必再挂闹钟。 */
const TERMINAL_VERDICTS = new Set(['done', 'failed', 'aborted'])

// ── JSON Schema 小工具 ─────────────────────────────────────────────────────

/** 声明「可空」：可能为 null 的字段必须这么写，否则注册表逐值校验会拒绝。 */
function nullable(node, description) {
  const branch = description === undefined ? node : { ...node, description }
  return {
    oneOf: [branch, { type: 'null', description: '未知或不适用（数据源未返回）' }],
  }
}

/** 任意 JSON 值（审计模块原样返回的字段用它，避免形状差异被注册表拒绝）。 */
function anyJson(description) {
  return {
    description,
    oneOf: [
      { type: 'object' },
      { type: 'array' },
      { type: 'string' },
      { type: 'number' },
      { type: 'integer' },
      { type: 'boolean' },
      { type: 'null' },
    ],
  }
}

/** 失败字段：每个工具的 output 都声明，模型据此分支。 */
const FAILURE_PROPS = {
  ok: { type: 'boolean', description: '成功为 true；失败为 false（失败时看 error / hint / retryable）' },
  error: { type: 'string', description: '失败原因（可读中文，原样告诉模型）' },
  hint: { type: 'string', description: '下一步该做什么（先查列表 / 换 flowId / 等运行结束等）' },
  retryable: { type: 'boolean', description: '是否值得重试；参数错误、404、409 恒为 false' },
}

/** 构造 output：失败字段 + 本工具自己的成功字段 + 人类可读投影。 */
function outputFor(extra, render) {
  return {
    schema: {
      type: 'object',
      properties: { ...FAILURE_PROPS, ...extra },
      required: ['ok'],
      additionalProperties: true,
    },
    render,
  }
}

/** 统一的 render 兜底：模型面拿到规范值，这里只做人类可读投影。 */
function renderJson(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

// ── 参数读取（raw register 不校验参数，这里做最小防御） ─────────────────────

function argsOf(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new ParamError('工具参数必须是一个 JSON 对象', '按工具的参数 schema 传对象参数。')
  }
  return args
}

/** 参数错误：execute 内捕获后转成 `{ok:false, ...}`。 */
class ParamError extends Error {
  constructor(message, hint) {
    super(message)
    this.name = 'ParamError'
    this.hint = hint
    this.retryable = false
  }
}

function optionalString(args, key, { max = 200 } = {}) {
  const value = argsOf(args)[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ParamError(`参数 ${key} 必须是字符串`, `按 ${key} 的说明改正后重发。`)
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > max) throw new ParamError(`参数 ${key} 超过 ${max} 字符`, `把 ${key} 缩短到 ${max} 字符以内。`)
  return trimmed
}

function optionalInteger(args, key, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = argsOf(args)[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ParamError(`参数 ${key} 必须是整数`, `按 ${key} 的说明改正后重发。`)
  }
  if (value < min || value > max) {
    throw new ParamError(`参数 ${key} 必须在 ${min}–${max} 之间`, `改成范围内的整数。`)
  }
  return value
}

// ── lossless JSON 收口 ─────────────────────────────────────────────────────

/**
 * 把任意值收敛成 lossless JSON：
 * - `undefined` 在对象里删键、在数组里变 null；
 * - `NaN` / `Infinity` / `-Infinity` → null；
 * - `Date` → ISO 字符串；`bigint` → 字符串；
 * - 循环引用 → null（审计结果正常不会有，这里只做兜底，避免工具调用炸掉）。
 */
function jsonSafe(value, seen = new WeakSet()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (type === 'undefined' || type === 'function' || type === 'symbol') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (type === 'object') {
    if (seen.has(value)) return null
    seen.add(value)
    if (Array.isArray(value)) {
      const out = value.map(item => (item === undefined ? null : jsonSafe(item, seen)))
      seen.delete(value)
      return out
    }
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = jsonSafe(item, seen)
    }
    seen.delete(value)
    return out
  }
  return null
}

function failure(error, hint, retryable = false, extra = {}) {
  return jsonSafe({ ok: false, error, hint, retryable, ...extra })
}

/** 错误对象 → 可读文案（不把堆栈甩给模型）。 */
function messageOf(error) {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return '未知错误'
}

/** 按错误状态给可操作的分流（与 HTTP 层同一口径）。 */
function failureOf(error, { action, extra = {} }) {
  const status = error && Number.isInteger(error.status) ? error.status : null
  const message = messageOf(error)
  if (status === 404) {
    return failure(message, `${action}失败：目标不存在，先调 flow_list / flow_watch 确认 id。`, false, extra)
  }
  if (status === 409) {
    return failure(
      message,
      '冲突（409）：已有 run 在跑或 run 已开始过。等它结束，或先 flow_stop 停掉当前 run 再重试。',
      false,
      extra,
    )
  }
  if (status === 400) {
    return failure(message, `${action}失败：参数或流程不合法，改正后再试；重发同一份请求不会变。`, false, extra)
  }
  if (status === 503) {
    return failure(message, '依赖服务暂不可用（如 subagents），稍后重试。', true, extra)
  }
  return failure(
    message,
    `${action}失败：如果是暂时性故障可以重试一次；仍失败就停下并告诉主人。`,
    true,
    extra,
  )
}

// ── 父会话 / 工作区继承 ────────────────────────────────────────────────────

/** 当前会话 id：模型工具只能证明「父会话是谁」，不猜测工作区路径。 */
function sessionIdOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  return session && typeof session.id === 'string' && session.id !== '' ? session.id : null
}

/**
 * 06 §16：sessionId → { runId, nodeId }。
 * 引擎内存索引优先；没有（或引擎不支持）时扫最近 20 个 run 的 sessions.json 兜底。
 */
async function resolveSessionOwner(deps, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (deps.engine && typeof deps.engine.resolveSessionOwner === 'function') {
    try {
      const owner = await deps.engine.resolveSessionOwner(sessionId)
      if (owner) return owner
    } catch {
      // 引擎反查失败就退回磁盘。
    }
  }
  try {
    const listed = await listRuns(deps.runsRoot, { limit: 20 })
    for (const run of listed.runs || []) {
      const sessions = await readNodeSessions(deps.runsRoot, run.id)
      for (const [nodeId, entry] of Object.entries(sessions || {})) {
        if (entry && entry.sessionId === sessionId) return { runId: run.id, nodeId }
      }
    }
  } catch {
    // 读不到当查不到。
  }
  return null
}

/** 06 §16：省略 runId 时取「当前会话启动的最新 run」，再退回最近一次 run。 */
async function resolveRunId(deps, exec, requested) {
  if (requested !== undefined) {
    if (!checkRunId(requested)) {
      throw new ParamError(
        `runId「${requested}」不合法（只允许字母、数字、点、下划线、连字符，1–64 位）`,
        'runId 来自 flow_start / flow_watch；省略则用当前会话启动的最新 run。',
      )
    }
    return requested
  }
  const sessionId = sessionIdOf(exec)
  const engine = deps.engine
  if (engine && typeof engine.runForSession === 'function') {
    try {
      const fromEngine = engine.runForSession(sessionId)
      if (typeof fromEngine === 'string' && fromEngine !== '') return fromEngine
    } catch {
      // 退回最近一次 run。
    }
  }
  const listed = await listRuns(deps.runsRoot, { limit: 1 })
  const latest = Array.isArray(listed.runs) && listed.runs.length > 0 ? listed.runs[0] : null
  if (!latest) {
    throw new ParamError(
      '没有可用的 run',
      '先用 flow_start 启动一个流程，或显式传 runId。',
    )
  }
  return latest.id
}

// ── 审查闹钟文案 ───────────────────────────────────────────────────────────

/**
 * 给 `proactive_set` 用的完整提示词（≥40 字）：必须包含 runId、flow_watch、
 * proactive_reclaim 三要素，否则模型醒来会不知道干什么。
 */
function watchAlarmPrompt(runId, flowName, seconds) {
  const label = flowName ? `（流程「${flowName}」）` : ''
  return [
    `【工作流审查】runId=${runId}${label}。请调用 flow_watch（runId="${runId}"）审查这个 run 是否在正常运转：`,
    '若 verdict 表示运行正常且没有停滞，就调用 proactive_reclaim 安静结束本轮，不要打扰主人；',
    '只有出现异常（节点停滞、打回过多、节点失败）或整个流程已经跑完（done/failed/aborted），',
    `才把结论、异常点和需要主人决策的地方通知主人。本次是 ${seconds} 秒一次的定期复核。`,
  ].join('')
}

/** 终态时不必再挂闹钟的说明。 */
function terminalPrompt(runId, verdict, headline) {
  const summary = headline ? `（结论：${headline}）` : ''
  return `runId=${runId} 的流程已经结束（verdict=${verdict}）${summary}，不必再挂审查闹钟：`
    + '调用 proactive_reclaim 结束本轮，把这个结论汇报给主人即可。'
}

/** 审查间隔：审计给了合理值就用它，否则用默认值；钳制在 30–900 秒。 */
function clampSeconds(value, fallback) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return fallback
  return Math.min(900, Math.max(30, value))
}

// ── 审计模块（真实 import，缺失时给出可操作失败） ───────────────────────────

let auditModulePromise = null

/**
 * 加载 `src/audit.js`。
 *
 * 用**动态 import** 而不是顶层静态 import：本仓库的审计模块由另一条工作流并行落地，
 * 文件还没出现时整个插件（含 HTTP 面板）不应因此装不上。`createFlowTools` 支持
 * 注入 `auditWorkflow`（测试用 stub），生产路径仍然走真实模块。
 */
function loadAuditModule() {
  if (!auditModulePromise) {
    auditModulePromise = import('./audit.js').catch(error => {
      auditModulePromise = null
      throw error
    })
  }
  return auditModulePromise
}

async function resolveAudit(deps) {
  if (typeof deps.auditWorkflow === 'function') return deps.auditWorkflow
  const mod = await loadAuditModule()
  if (!mod || typeof mod.auditWorkflow !== 'function') {
    throw new Error('src/audit.js 没有导出 auditWorkflow')
  }
  return mod.auditWorkflow
}

// ── 流程解析 ───────────────────────────────────────────────────────────────

/**
 * 解析目标流程：flowId 优先；没有 id 时按 flowName 精确匹配，再退不区分大小写。
 * 同名多份 → 失败并列出候选 id（让模型用 flowId 指定，而不是瞎猜）。
 */
async function resolveFlow(deps, args) {
  const flowId = optionalString(args, 'flowId', { max: 128 })
  const flowName = optionalString(args, 'flowName', { max: 200 })

  if (flowId !== undefined) {
    if (!checkId(flowId)) {
      return {
        failure: failure(
          `flowId「${flowId}」不合法（只允许小写字母、数字、连字符，≤64 位）`,
          '先调 flow_list，用返回的 id 原样传 flowId。',
        ),
      }
    }
    const flow = await readFlow(deps.flowsRoot, flowId)
    if (!flow) {
      return { failure: failure(`流程不存在：${flowId}`, '先调 flow_list 看当前可用流程（id + name）。') }
    }
    return { flow }
  }

  if (flowName !== undefined) {
    const all = await listFlows(deps.flowsRoot)
    const exact = all.filter(item => item.name === flowName)
    const candidates = exact.length > 0
      ? exact
      : all.filter(item => String(item.name).toLowerCase() === flowName.toLowerCase())
    if (candidates.length === 0) {
      return {
        failure: failure(
          `没有找到名称为「${flowName}」的流程`,
          '先调 flow_list 看可用流程；名称必须与列表里的 name 一致（或换 flowId）。',
        ),
      }
    }
    if (candidates.length > 1) {
      const ids = candidates.map(item => item.id)
      return {
        failure: failure(
          `有 ${candidates.length} 个流程同名「${flowName}」：${ids.join('、')}`,
          `改用 flowId 指定其中一个：${ids.join(' / ')}`,
          false,
          { candidates: ids },
        ),
      }
    }
    // 列表摘要只有 id/name，真正的节点与边要回读完整流程。
    const flow = await readFlow(deps.flowsRoot, candidates[0].id)
    if (!flow) {
      return {
        failure: failure(
          `流程「${flowName}」（${candidates[0].id}）读取失败，可能刚被删除或文件损坏`,
          '先调 flow_list 确认它还在，再用 flowId 重试。',
        ),
      }
    }
    return { flow }
  }

  return {
    failure: failure(
      '缺少 flowId 或 flowName',
      '先调 flow_list 拿到流程 id，再调 flow_start（flowId 与 flowName 二选一；同名时用 flowId）。',
    ),
  }
}

// ── 工具定义 ───────────────────────────────────────────────────────────────

/**
 * 构造模型工具：基础四个（list / start / watch / stop），agents 服务可用时
 * 追加收件箱两个（flow_send_message / flow_reply）。
 *
 * @param {{
 *   flowsRoot: string,
 *   runsRoot: string,
 *   engine: { start: Function, stop: Function, engineName?: string },
 *   auditWorkflow?: Function,
 *   watchSeconds?: number,
 *   stallMs?: number,
 *   nodeTimeoutMs?: number,
 *   maxRejectsPerEdge?: number,
 *   now?: () => Date,
 * }} deps
 */
export function createFlowTools(deps) {
  if (!deps || typeof deps.flowsRoot !== 'string' || deps.flowsRoot === '') {
    throw new TypeError('createFlowTools 需要 flowsRoot')
  }
  if (typeof deps.runsRoot !== 'string' || deps.runsRoot === '') {
    throw new TypeError('createFlowTools 需要 runsRoot')
  }
  if (!deps.engine || typeof deps.engine.start !== 'function' || typeof deps.engine.stop !== 'function') {
    throw new TypeError('createFlowTools 需要 { start, stop } 引擎')
  }

  const watchSeconds = clampSeconds(deps.watchSeconds, DEFAULT_WATCH_SECONDS)
  const stallMs = Number.isInteger(deps.stallMs) && deps.stallMs > 0 ? deps.stallMs : DEFAULT_STALL_MS
  const nodeTimeoutMs = Number.isInteger(deps.nodeTimeoutMs) && deps.nodeTimeoutMs > 0
    ? deps.nodeTimeoutMs
    : DEFAULT_NODE_TIMEOUT_MS
  const maxRejectsPerEdge = Number.isInteger(deps.maxRejectsPerEdge) && deps.maxRejectsPerEdge > 0
    ? deps.maxRejectsPerEdge
    : DEFAULT_MAX_REJECTS_PER_EDGE
  const now = typeof deps.now === 'function' ? deps.now : () => new Date()
  const engineName = deps.engine.engineName === 'stub' ? 'stub' : 'real'
  // 06 §16：收件箱 / 回复工具依赖 agents 服务（没有它无法向会话注入消息，flow_reply
  // 也没有可用的会话反查）。测试台 / 纯注入环境拿不到 agents 时只注册前四个工具，
  // 既有 profile 的注册数量与卸载语义保持不变。
  const inboxToolsEnabled = ctxHasAgents(deps.ctx)

  return [
    // ── flow_list ──────────────────────────────────────────────────────────
    {
      name: 'flow_list',
      description:
        '列出当前可用的流程模板（画布上每个节点是一个 agent，按图顺序执行）。'
        + '返回 { ok, flows: [{ id, name, nodeCount, edgeCount, updatedAt }] }，按更新时间倒序，默认 20 条（最多 100）。'
        + '这是「从会话里启动流程」的第一步：先拿到 id 或 name，再用 flow_start 启动；'
        + '启动后用 flow_watch 定时审查，形成「列流程 → 启动 → 定时自审」的闭环。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '返回条数，默认 20，最大 100；超出按 100 截断' },
        },
        required: [],
      },
      output: outputFor({
        flows: {
          type: 'array',
          description: '流程模板摘要（不含节点与边的完整内容）',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '流程 id（唯一，传给 flow_start 的 flowId）' },
              name: { type: 'string', description: '流程显示名（可能重名，重名时用 flowId）' },
              nodeCount: { type: 'integer', description: '节点总数（含开始 / 结束节点）' },
              edgeCount: { type: 'integer', description: '连线总数（next + reject）' },
              updatedAt: { type: 'string', description: '最后更新时间（ISO 8601）' },
            },
            required: ['id', 'name'],
            additionalProperties: true,
          },
        },
      }, (args, value) => {
        if (!value || value.ok !== true || !Array.isArray(value.flows)) return renderJson(value)
        if (value.flows.length === 0) return [{ type: 'text', text: '当前没有流程模板。' }]
        const lines = value.flows.map(item => `- ${item.id} · ${item.name}（${item.nodeCount} 节点 / ${item.edgeCount} 连线）`)
        return [{ type: 'text', text: `共 ${value.flows.length} 个流程：\n${lines.join('\n')}` }]
      }),
      timeoutMs: TIMEOUT_LIST_MS,
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const a = argsOf(args)
          const raw = a.limit
          let limit = 20
          if (raw !== undefined && raw !== null) {
            if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
              throw new ParamError('参数 limit 必须是正整数', '省略 limit 用默认 20，或传 1–100 的整数。')
            }
            limit = Math.min(raw, 100)
          }
          const flows = await listFlows(deps.flowsRoot)
          return jsonSafe({
            ok: true,
            flows: flows.slice(0, limit).map(item => ({
              id: String(item.id),
              name: typeof item.name === 'string' && item.name !== '' ? item.name : String(item.id),
              nodeCount: Number.isInteger(item.nodeCount) ? item.nodeCount : 0,
              edgeCount: Number.isInteger(item.edgeCount) ? item.edgeCount : 0,
              updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
            })),
          })
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`读取流程列表失败：${messageOf(error)}`, '稍后重试；持续失败说明 Host 侧存储不可读，先告诉主人。', true)
        }
      },
    },

    // ── flow_start ─────────────────────────────────────────────────────────
    {
      name: 'flow_start',
      description:
        '在**当前会话**里直接启动一个流程 run（不用去 Web 面板点运行）。三步闭环：'
        + '① 本工具用当前会话的 Agent 作父会话启动 run（request.parent=当前会话、request.cwd 省略），'
        + '子 agent 因此**继承本会话的工作区**，不需要也不应该再选目录；'
        + '② 拿到返回的 supervision 后，调用 proactive_set 把 supervision.alarmPrompt 挂成定时闹钟，'
        + 'after_seconds 用 supervision.nextCheckSeconds；'
        + '③ 每次闹钟醒来调用 flow_watch（runId=返回的 runId）审查整个工作流是否正常，'
        + 'healthy 就 proactive_reclaim 安静结束，出现异常或跑完才通知主人。'
        + '流程选择：flowId 优先；没有 id 时按 flowName 精确匹配（再退不区分大小写）；都不给会失败并提示先调 flow_list；'
        + '同名多份会失败并列出候选 id。task 是用户这次要跑的任务原文（可选，写进 run 的 name）；'
        + 'name 是本次 run 的显示名（可选，优先于 task）。流程不存在 / 不合法会在建 run 之前失败；已有 run 在跑（409）会返回可读原因，'
        + '不会把两个流程叠在一起跑。',
      parameters: {
        type: 'object',
        properties: {
          flowId: { type: 'string', description: '流程 id（来自 flow_list 的 id；与 flowName 二选一，优先）' },
          flowName: { type: 'string', description: '流程名称（没有 flowId 时用；精确匹配优先，再退不区分大小写；重名会失败并列候选）' },
          task: { type: 'string', description: '用户这次要跑的任务原文（可选，≤2000 字符；写进 run.json 的 name，超过 200 字符截断）' },
          name: { type: 'string', description: '本次 run 的显示名（可选，≤200 字符；优先于 task）' },
        },
        required: [],
      },
      output: outputFor({
        runId: nullable({ type: 'string' }, '新建的 run id（后续 flow_watch / flow_stop 都用它）'),
        flowId: nullable({ type: 'string' }, '实际启动的流程 id'),
        flowName: nullable({ type: 'string' }, '实际启动的流程名'),
        status: nullable({ type: 'string' }, '启动后的 run 状态（正常为 running）'),
        candidates: { type: 'array', items: { type: 'string' }, description: '同名流程的候选 id（仅「同名多份」失败时出现）' },
        workspace: nullable({
          type: 'object',
          description: '工作区继承信息：子 agent 用当前会话的工作区',
          properties: {
            inheritedFrom: nullable({ type: 'string' }, '父会话 id；子 agent 从它继承工作目录'),
          },
          additionalProperties: true,
        }),
        supervision: nullable({
          type: 'object',
          description: '如何挂定时审查闹钟（交给 proactive_set）',
          properties: {
            nextCheckSeconds: { type: 'integer', description: '建议的审查间隔秒数（proactive_set 的 after_seconds）' },
            alarmPrompt: { type: 'string', description: '完整提示词，原样作为 proactive_set 的 prompt' },
            watchTool: { type: 'string', description: '醒来后要调用的工具名（恒为 flow_watch）' },
            hint: { type: 'string', description: '给模型的一句话操作说明' },
          },
          required: ['nextCheckSeconds', 'alarmPrompt', 'watchTool'],
          additionalProperties: true,
        }),
      }, (args, value) => {
        if (!value || value.ok !== true) {
          const candidates = value && Array.isArray(value.candidates) && value.candidates.length > 0
            ? `\n候选：${value.candidates.join(' / ')}`
            : ''
          return [{ type: 'text', text: `启动失败：${value && value.error ? value.error : '未知错误'}${candidates}` }]
        }
        return [{
          type: 'text',
          text: `已在本会话启动 run ${value.runId}（流程「${value.flowName}」，状态 ${value.status}）。\n`
            + `下一步：用 proactive_set 的 after_seconds=${value.supervision ? value.supervision.nextCheckSeconds : watchSeconds} `
            + `挂上 supervision.alarmPrompt，之后每次醒来调 flow_watch（runId=${value.runId}）。`,
        }]
      }),
      timeoutMs: TIMEOUT_START_MS,
      async execute(args, exec) {
        let resolved
        try {
          resolved = await resolveFlow(deps, args)
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`解析流程失败：${messageOf(error)}`, '先调 flow_list 确认流程存在，再试一次。', true)
        }
        if (resolved.failure) return resolved.failure
        const flow = resolved.flow

        // 结构校验前移：不合法就不建 run，避免留下一个永远 pending 的目录。
        const validation = validateFlowForRun(flow)
        if (!validation.ok) {
          const detail = validation.errors.map(item => item.message).join('；')
          return failure(
            `流程不合法，不能开跑：${detail}`,
            '先到画布上修好流程（恰好一个开始节点、至少一个阶段节点、每条 next 恰好一条出边、打回目标必须是阶段节点），再启动。',
          )
        }

        let runName
        try {
          const explicitName = optionalString(args, 'name', { max: 200 })
          const task = optionalString(args, 'task', { max: 2000 })
          runName = explicitName || (task ? clipChars(task, 200) : flow.name)
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`读取参数失败：${messageOf(error)}`, '按参数说明改正后重发。')
        }

        const nodeTotal = (flow.nodes || []).filter(node => node.kind === NODE_KIND.STAGE).length

        // 引擎同一时刻只允许一个 run：先在这里挡掉，避免建出一个永远 pending 的 run 目录。
        // （跨引擎实例的并发仍由 engine.start 的模块级锁兜底，下面 catch 会接住 409。）
        const active = deps.engine.active
        if (active && typeof active.runId === 'string' && active.runId !== '') {
          return failure(
            `已有运行中的 run（${active.runId}），同一时刻只允许一个 run`,
            '等它结束，或先调 flow_stop 停掉它，再重新 flow_start。',
          )
        }

        let run
        try {
          run = await createRun(deps.runsRoot, {
            flowId: flow.id,
            flowName: flow.name,
            name: runName,
            nodeTotal,
            // 与 HTTP 建 run 同一口径：run.json.engine 从建 run 那一刻就带上。
            engine: engineName,
          })
        } catch (error) {
          return failureOf(error, { action: '创建 run ' })
        }

        // 父会话 = 当前会话。cwd 不传（引擎省略），子 agent 因此继承本会话工作区。
        const parent = exec && exec.agent ? exec.agent : undefined
        let started
        try {
          started = await deps.engine.start(run.id, { parent })
        } catch (error) {
          // 建出来的 run 可能停在 pending：把 runId 一并带回，模型知道要去 flow_watch 看一眼。
          return failureOf(error, { action: '启动 run ', extra: { runId: run.id } })
        }

        const status = started && typeof started.status === 'string' ? started.status : 'running'
        const runId = typeof run.id === 'string' ? run.id : started && typeof started.id === 'string' ? started.id : ''
        return jsonSafe({
          ok: true,
          runId,
          flowId: flow.id,
          flowName: flow.name,
          status,
          workspace: { inheritedFrom: sessionIdOf(exec) },
          supervision: {
            nextCheckSeconds: watchSeconds,
            alarmPrompt: watchAlarmPrompt(runId, flow.name, watchSeconds),
            watchTool: 'flow_watch',
            hint: `用 proactive_set 的 after_seconds=${watchSeconds} 挂上 supervision.alarmPrompt；`
              + `之后每次醒来调 flow_watch（runId="${runId}"），healthy 就 proactive_reclaim 安静结束。`,
          },
        })
      },
    },

    // ── flow_watch ─────────────────────────────────────────────────────────
    {
      name: 'flow_watch',
      description:
        '审查「整个工作流是否在正常运转」（只读，不改任何状态、不自动修复、不自动停止）。'
        + '读 run.json + 事件 + 流程模板，调用审计模块给出 verdict / headline / progress / plan / '
        + 'currentNode / rejects / anomalies / quality / tokens / idleMs / recommended 等结论，'
        + '并附 supervision：运行中给出下次审查间隔与完整闹钟提示词（交给 proactive_set），'
        + 'verdict 为 done/failed/aborted 时 nextCheckSeconds 为 null、alarmPrompt 说明不必再挂闹钟。'
        + '典型用法：flow_start 之后按 supervision.nextCheckSeconds 挂 proactive_set 闹钟，每次醒来调本工具；'
        + 'verdict 正常就 proactive_reclaim 安静结束，异常或跑完才通知主人。'
        + 'runId 省略时取最近一次 run（按 startedAt 倒序）。',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '要审查的 run id；省略 = 最近一次 run' },
        },
        required: [],
      },
      output: outputFor({
        runId: nullable({ type: 'string', description: '本次审查的 run id' }),
        flowId: nullable({ type: 'string', description: '该 run 使用的流程 id' }),
        verdict: nullable({ type: 'string', description: '审计结论（如 healthy / done / failed / aborted / stalled / degraded）' }),
        status: nullable({ type: 'string', description: 'run.json.status' }),
        headline: nullable({ type: 'string', description: '一句话结论（人类可读）' }),
        // 审计字段的形状由 audit.js 决定（另一条工作流并行实现），这里用宽松 schema
        // 只声明「字段存在」，避免形状差异让注册表的逐值校验直接拒绝合法结果。
        progress: anyJson('进度摘要（对象；审计模块原样返回）'),
        plan: anyJson('剩余计划（通常是节点数组；审计模块原样返回）'),
        currentNode: anyJson('当前节点（对象或 null；审计模块原样返回）'),
        rejects: anyJson('打回统计（对象；审计模块原样返回）'),
        anomalies: anyJson('异常列表（通常是数组；审计模块原样返回）'),
        quality: anyJson('质量摘要（对象；审计模块原样返回）'),
        tokens: anyJson('用量摘要（对象；审计模块原样返回）'),
        idleMs: nullable({ type: 'integer' }, '距最近一次事件的毫秒数'),
        recommended: anyJson('建议动作（只报告，是否执行由模型决定）'),
        supervision: {
          type: 'object',
          description: '定时自审信号：运行中给间隔与闹钟提示词，终态给 null 与「不必再挂」说明',
          properties: {
            nextCheckSeconds: nullable({ type: 'integer' }, '下次审查间隔秒数；终态为 null（不必再挂闹钟）'),
            alarmPrompt: { type: 'string', description: '给 proactive_set 的完整提示词' },
            watchTool: { type: 'string', description: '审查工具名（恒为 flow_watch）' },
          },
          required: ['alarmPrompt', 'watchTool'],
          additionalProperties: true,
        },
      }, (args, value) => {
        if (!value || value.ok !== true) return renderJson(value)
        const head = value.headline ? value.headline : '（审计未给出结论摘要）'
        const lines = [`run ${value.runId}：${value.verdict || value.status || 'unknown'} — ${head}`]
        if (value.currentNode && value.currentNode.title) lines.push(`当前节点：${value.currentNode.title}`)
        if (Array.isArray(value.anomalies) && value.anomalies.length > 0) lines.push(`异常 ${value.anomalies.length} 条`)
        if (value.supervision && value.supervision.nextCheckSeconds === null) {
          lines.push('已到终态：不必再挂闹钟，proactive_reclaim 结束本轮。')
        } else if (value.supervision) {
          lines.push(`建议 ${value.supervision.nextCheckSeconds} 秒后再次审查。`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      }),
      timeoutMs: TIMEOUT_WATCH_MS,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        let requested
        try {
          requested = optionalString(args, 'runId', { max: 128 })
          if (requested !== undefined && !checkRunId(requested)) {
            throw new ParamError(
              `runId「${requested}」不合法（只允许字母、数字、点、下划线、连字符，1–64 位）`,
              'runId 来自 flow_start 的返回值；省略则审查最近一次 run。',
            )
          }
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`读取参数失败：${messageOf(error)}`, '按参数说明改正后重发。')
        }

        let runId = requested
        try {
          if (runId === undefined) {
            const listed = await listRuns(deps.runsRoot, { limit: 1 })
            const latest = Array.isArray(listed.runs) && listed.runs.length > 0 ? listed.runs[0] : null
            if (!latest) {
              return failure('还没有任何 run，无法审查', '先用 flow_start 启动一个流程（或先 flow_list 选流程）。')
            }
            runId = latest.id
          }

          const detail = await readRunDetail(deps.runsRoot, runId)
          if (!detail) {
            return failure(`run 不存在：${runId}`, '用 flow_list 之外的方式确认 runId；省略 runId 则审查最近一次 run。')
          }
          const all = await readAllEvents(deps.runsRoot, runId)
          if (!all) {
            return failure(`run 的事件日志不可读：${runId}`, '稍后重试；持续失败说明 Host 侧存储损坏，先告诉主人。', true)
          }
          const flow = await readFlow(deps.flowsRoot, detail.run.flowId)
          if (!flow) {
            return failure(
              `run ${runId} 使用的流程模板不存在（flowId=${detail.run.flowId}，可能已被删除）`,
              '到面板确认流程是否还在；没有模板就无法判断节点计划。',
            )
          }

          const auditWorkflow = await resolveAudit(deps)
          const audited = await auditWorkflow({
            flow,
            events: all.events,
            run: detail.run,
            now: now(),
            stallMs,
            nodeTimeoutMs,
            maxRejectsPerEdge,
          })
          if (!audited || typeof audited !== 'object' || Array.isArray(audited)) {
            return failure('审计模块返回了非法结果', '把这条失败与审计模块的现状告诉主人（属于实现缺陷，不是调用方问题）。')
          }

          const verdict = typeof audited.verdict === 'string'
            ? audited.verdict
            : (typeof audited.status === 'string' ? audited.status : null)
          const terminal = verdict !== null && TERMINAL_VERDICTS.has(verdict)
          const nextCheckSeconds = terminal ? null : clampSeconds(audited.nextCheckSeconds, watchSeconds)
          const alarmPrompt = terminal
            ? terminalPrompt(runId, verdict, typeof audited.headline === 'string' ? audited.headline : '')
            : watchAlarmPrompt(runId, detail.run.flowName, nextCheckSeconds)

          return jsonSafe({
            ...audited,
            ok: true,
            runId,
            flowId: detail.run.flowId,
            supervision: {
              nextCheckSeconds,
              alarmPrompt,
              watchTool: 'flow_watch',
            },
          })
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          const status = error && Number.isInteger(error.status) ? error.status : null
          if (status === 400 || status === 404) return failureOf(error, { action: '审查 run ' })
          // 审计模块缺失 / 抛错：属于实现或部署问题，重试同一份请求通常也不会变。
          return failure(
            `审查失败：${messageOf(error)}`,
            '如果提示 src/audit.js 不存在，说明审计模块还没落地；其余情况先 flow_watch 重试一次，仍失败就告诉主人。',
            false,
          )
        }
      },
    },

    // ── flow_stop ──────────────────────────────────────────────────────────
    {
      name: 'flow_stop',
      description:
        '停止一次正在运行的流程 run（写操作，会 abort 在飞请求并写 run/end{status:"aborted"}）。'
        + 'runId 必填，来自 flow_start 或 flow_watch。run 不在运行中（已结束 / 不存在 / 不是当前进程启动的）会失败，'
        + 'hint 会写「这个 run 不在运行中」；停止后建议再调一次 flow_watch 复核终态，然后 proactive_reclaim 结束本轮。'
        + '本工具只停止，不做清理（run 的日志与产物保留）。',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '要停止的 run id（必填，来自 flow_start / flow_watch）' },
        },
        required: ['runId'],
      },
      output: outputFor({
        runId: { type: 'string', description: '被停止的 run id' },
        status: nullable({ type: 'string', description: '停止后的 run 状态（通常为 aborted）' }),
      }, (args, value) => {
        if (!value || value.ok !== true) return renderJson(value)
        return [{ type: 'text', text: `已停止 run ${value.runId}（状态 ${value.status}）。` }]
      }),
      timeoutMs: TIMEOUT_STOP_MS,
      async execute(args) {
        let runId
        try {
          runId = optionalString(args, 'runId', { max: 128 })
          if (runId === undefined) {
            throw new ParamError('缺少必填参数 runId', '传 flow_start 返回的 runId；不知道就用 flow_watch 省略 runId 查最近一次 run。')
          }
          if (!checkRunId(runId)) {
            throw new ParamError(
              `runId「${runId}」不合法（只允许字母、数字、点、下划线、连字符，1–64 位）`,
              'runId 来自 flow_start 的返回值，原样传。',
            )
          }
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`读取参数失败：${messageOf(error)}`, '按参数说明改正后重发。')
        }

        try {
          const meta = await deps.engine.stop(runId)
          const status = meta && typeof meta.status === 'string' ? meta.status : 'aborted'
          return jsonSafe({ ok: true, runId, status })
        } catch (error) {
          const status = error && Number.isInteger(error.status) ? error.status : null
          if (status === 409) {
            return failure(
              messageOf(error),
              '这个 run 不在运行中：可能已经结束，或不是当前进程启动的。用 flow_watch 看它当前状态。',
            )
          }
          if (status === 400) return failureOf(error, { action: '停止 run ' })
          return failure(
            `停止 run 失败：${messageOf(error)}`,
            '稍后重试一次；仍失败就告诉主人（可能引擎已中断但 run.json 还没收尾）。',
            true,
          )
        }
      },
    },

    // ── flow_send_message ──────────────────────────────────────────────────
    ...(inboxToolsEnabled ? [
    {
      name: 'flow_send_message',
      description:
        '给一个流程 run 的收件箱发一条外部消息（与 Web 面板的 POST /runs/<id>/messages 是同一条内部逻辑）。'
        + '目标节点：nodeId 显式指定（必须是阶段节点）→ 否则取 run 当前节点 → 否则（pending）入口节点。'
        + '投递方式由引擎现状决定：目标节点已有活会话 → 立即注入（injected）；只有冷会话 → resume 后注入（resumed）；'
        + 'run 还没开始 → 作为本 run 的启动输入（started）；run 在跑但节点还没到 → 入队，等引擎推进到该节点时并入提示词（queued）。'
        + '省略 runId 时取当前会话启动的最新 run，再退回最近一次 run。reply 可选：指定节点回消息时要发给谁'
        + '（session 会话 / http 回调地址 / none 只记日志；http 的 tokenEnv 只写环境变量名）。',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '目标 run id；省略 = 当前会话启动的最新 run，再退回最近一次 run' },
          nodeId: { type: 'string', description: '目标阶段节点 id（可选；不传则按「当前节点 → 入口节点」推断）' },
          text: { type: 'string', description: '消息正文（必填，≤4000 字符，超过按码点截断）' },
          reply: {
            type: 'object',
            description: '节点回复消息时要投递到的目标（可选）',
            properties: {
              kind: { type: 'string', enum: ['session', 'http', 'none'], description: '回复通道：会话 / HTTP 回调 / 不回复' },
              sessionId: { type: 'string', description: 'kind=session 时的目标会话 id' },
              url: { type: 'string', description: 'kind=http 时的回调地址（只允许 http/https）' },
              tokenEnv: { type: 'string', description: 'kind=http 时从哪个环境变量取 Bearer 令牌（只写变量名，不落盘）' },
            },
            required: ['kind'],
            additionalProperties: false,
          },
        },
        required: ['text'],
      },
      output: outputFor({
        runId: { type: 'string', description: '实际投递到的 run id' },
        messageId: { type: 'string', description: '这条入站消息的 id（后续 inReplyTo 用它）' },
        targetNodeId: { type: 'string', description: '解析出的目标阶段节点 id' },
        mode: {
          type: 'string',
          description: '投递方式：injected（活会话注入）/ resumed（冷会话 resume 后注入）/ started（作为启动输入）/ queued（入队）',
        },
        sessionId: nullable({ type: 'string' }, '目标节点的会话 id（started / queued 时为空，表示还没有会话）'),
      }, (args, value) => {
        if (!value || value.ok !== true) return renderJson(value)
        return [{
          type: 'text',
          text: `消息 ${value.messageId} 已投递到 run ${value.runId} 的节点 ${value.targetNodeId}（${value.mode}）。`,
        }]
      }),
      timeoutMs: TIMEOUT_SEND_MS,
      async execute(args, exec) {
        let text
        let nodeId
        let reply
        try {
          text = optionalString(args, 'text', { max: 4000 })
          if (text === undefined) {
            throw new ParamError('缺少必填参数 text', '传要发进流程的消息正文（≤4000 字符）。')
          }
          nodeId = optionalString(args, 'nodeId', { max: 64 })
          if (nodeId !== undefined && !checkRunId(nodeId)) {
            throw new ParamError(
              `nodeId「${nodeId}」不合法（只允许字母、数字、点、下划线、连字符）`,
              'nodeId 是流程里的阶段节点 id；不确定就从 run 详情里看。',
            )
          }
          const rawReply = argsOf(args).reply
          if (rawReply !== undefined && rawReply !== null) {
            const validated = validateReplyTarget(rawReply)
            if (!validated.ok) throw new ParamError(validated.error, '按参数说明改正 reply（kind 必填；http 只允许 http/https）。')
            reply = validated.reply
          }
          const requestedRunId = optionalString(args, 'runId', { max: 128 })
          const runId = await resolveRunId(deps, exec, requestedRunId)
          const sessionId = sessionIdOf(exec)
          const delivered = await deliverInboundMessage({
            runsRoot: deps.runsRoot,
            flowsRoot: deps.flowsRoot,
            engine: deps.engine,
            ctx: deps.ctx,
            log: deps.log,
          }, runId, {
            from: sessionId ? clipChars(`agent:${sessionId}`, 200) : 'agent:unknown',
            text,
            ...(nodeId === undefined ? {} : { nodeId }),
            ...(reply === undefined ? {} : { reply }),
          })
          return jsonSafe({
            ok: true,
            runId,
            messageId: delivered.messageId,
            targetNodeId: delivered.targetNodeId,
            mode: delivered.mode,
            sessionId: delivered.sessionId ?? null,
          })
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          const status = error && Number.isInteger(error.status) ? error.status : null
          if (status === 409) {
            return failure(
              `投递失败：${messageOf(error)}`,
              'run 已结束就不能再收消息；用 flow_watch 看它的状态，必要时用 flow_start 新开一个 run。',
            )
          }
          if (status === 400 || status === 404) return failureOf(error, { action: '发送消息 ' })
          return failure(
            `发送消息失败：${messageOf(error)}`,
            '如果是暂时性故障可以重试一次；仍失败就告诉主人。',
            true,
          )
        }
      },
    },

    // ── flow_reply ─────────────────────────────────────────────────────────
    {
      name: 'flow_reply',
      description:
        '在流程节点会话里给「把消息发进流程的来源」回一条消息（外部消息的返回通道）。'
        + '这个工具只对**属于某个流程 run 的节点会话**有效：会话 id 查不到对应 run/节点时直接失败。'
        + '回复目标优先级：消息级 reply（inReplyTo 指向的那条入站消息的配置）> run.json 的 inbox.reply > 未配置。'
        + 'session 目标直接投进会话（活会话 followup / 冷会话 resume）；http 目标 POST 到回调地址'
        + '（tokenEnv 指向的环境变量作为 Bearer，超时 10s，失败不抛异常）；未配置 / none 只记 message/out 事件，'
        + '返回值 ok:true 并由 hint 说明「没有外部回复通道，已记录在运行日志」。'
        + '正文前会自动加来源标记 [flow:<流程名> · <节点标题>]。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '回复正文（必填，≤4000 字符，超过按码点截断）' },
          inReplyTo: { type: 'string', description: '要回复的入站消息 id（可选；用于选中该消息自己的 reply 配置）' },
        },
        required: ['text'],
      },
      output: outputFor({
        runId: { type: 'string', description: '这条回复所属的 run id' },
        messageId: { type: 'string', description: '这条回复的 id（message/out 事件的 id）' },
        inReplyTo: nullable({ type: 'string' }, '被回复的入站消息 id'),
        nodeId: nullable({ type: 'string' }, '发起回复的节点 id'),
        delivery: { type: 'string', description: '实际回复通道：session / http / local（未配置时只记日志）' },
        sessionId: nullable({ type: 'string' }, 'kind=session 时的目标会话 id'),
        httpStatus: nullable({ type: 'integer' }, 'kind=http 时的 HTTP 状态码'),
      }, (args, value) => {
        if (!value || value.ok !== true) return renderJson(value)
        return [{
          type: 'text',
          text: `回复已记录（${value.delivery}${value.httpStatus ? ` / HTTP ${value.httpStatus}` : ''}）。`
            + (value.hint ? `\n${value.hint}` : ''),
        }]
      }),
      timeoutMs: TIMEOUT_REPLY_MS,
      async execute(args, exec) {
        let text
        let inReplyTo
        try {
          text = optionalString(args, 'text', { max: 4000 })
          if (text === undefined) {
            throw new ParamError('缺少必填参数 text', '传要回复的正文（≤4000 字符）。')
          }
          inReplyTo = optionalString(args, 'inReplyTo', { max: 128 })
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`读取参数失败：${messageOf(error)}`, '按参数说明改正后重发。')
        }

        const sessionId = sessionIdOf(exec)
        if (!sessionId) {
          return failure(
            '拿不到当前会话 id，无法判断这条回复属于哪个流程 run',
            'flow_reply 只能在流程节点（run 内的 agent 会话）里调用。',
          )
        }
        const owner = await resolveSessionOwner(deps, sessionId)
        if (!owner) {
          return failure(
            '这个会话不属于任何流程 run',
            '这个会话不属于任何流程 run：只有流程 run 里的节点会话才能用 flow_reply；普通对话里请直接回复用户。',
            false,
            { sessionId },
          )
        }

        try {
          const delivered = await deliverOutboundReply({
            runsRoot: deps.runsRoot,
            flowsRoot: deps.flowsRoot,
            engine: deps.engine,
            ctx: deps.ctx,
            log: deps.log,
          }, {
            runId: owner.runId,
            nodeId: owner.nodeId,
            sessionId,
            text,
            ...(inReplyTo === undefined ? {} : { inReplyTo }),
            signal: exec && exec.signal,
          })
          if (delivered.ok !== true) {
            return failure(
              delivered.error || '回复投递失败',
              '回复已写进运行日志（message/out），但外部通道没有确认收到；检查 reply 配置 / 回调地址 / 令牌环境变量。',
              true,
              {
                runId: owner.runId,
                messageId: delivered.messageId,
                nodeId: delivered.nodeId,
                delivery: delivered.delivery,
                ...(delivered.httpStatus === null || delivered.httpStatus === undefined
                  ? {}
                  : { httpStatus: delivered.httpStatus }),
              },
            )
          }
          return jsonSafe({ ok: true, runId: owner.runId, ...delivered })
        } catch (error) {
          const status = error && Number.isInteger(error.status) ? error.status : null
          if (status === 400 || status === 404) {
            return failureOf(error, { action: '回复消息 ', extra: { runId: owner.runId, nodeId: owner.nodeId } })
          }
          return failure(
            `回复失败：${messageOf(error)}`,
            '稍后重试一次；仍失败就告诉主人（回复通道可能配置错了）。',
            true,
          )
        }
      },
    },
    ] : []),
  ]
}

/** ctx 是否提供可用的 agents 服务（决定是否注册收件箱 / 回复工具）。 */
function ctxHasAgents(ctx) {
  if (!ctx) return false
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents
    return Boolean(service && (typeof service.get === 'function' || typeof service.resume === 'function'))
  } catch {
    return false
  }
}

/** 按码点截断（不把代理对切成半个字符）。 */
function clipChars(text, max) {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}
