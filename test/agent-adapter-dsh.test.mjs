#!/usr/bin/env node
/**
 * `agent-adapter-dsh.js` 自检：DSH 适配器（`flow_finish_node` 会话工具 + `turn.stop`
 * 提醒）。契约见 `docs/design/11-node-finish-tool.md` §1–§6。
 *
 * 覆盖：
 *   1. 正常：`agents.create` 的 `setup` 里注册 `flow_finish_node`；模型调工具 → gate 收到
 *      submit、`exited.ok===true`、提醒 0 次；提示词 source.kind='user'；
 *   2. 提醒：第一轮停下没调工具 → 1 次 `agent.steer` 提醒，第二轮调工具 → 成功，
 *      `reminder.onFire` 回调 count=1；
 *   3. 用尽：3 次提醒后的下一次停下 → `exited={ok:false,code:'NODE_FINISH_MISSING',
 *      reminders:3}`，同时 abort 闸门，迟到 submit → `NODE_ALREADY_SETTLED`；
 *      `maxFires=0` 时第一次停下立即结束；
 *   4. 取消 / dispose：`cancel` 幂等、`gate.abort` 生效、`ctx.signal` abort 时迟到创建
 *      结果被 dispose；dispose 视为取消（exited 不再 pending）、MISSING 后 cancel/dispose
 *      仍收掉节点会话；
 *   5. 能力（M1）：probe 前 `finishTool==='unsupported'`，probe 后 `native`；start 自动
 *      probe；缺 `tools.register` / `agentCtx.on` → `NODE_FINISH_TOOL_UNAVAILABLE`；
 *   6. 工具契约：`exec.signal` 提交前/返回前检查、parameters 过宿主 schema 子集、
 *      `documents[].summary` 进 artifact；
 *   7. 注册表：`probeAll` 单适配器超时记 `ok:false`、重复 id、非法能力。
 *
 * 全程用假宿主（不真起 agent、不碰 `~/.dsh`）。临时工作区在 `<repo>/.tmp/`。
 * 运行：node test/agent-adapter-dsh.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  ADAPTER_ERROR, AdapterError, assertFinishToolNative, createAdapterRegistry,
} from '../src/agent-adapter.js'
import {
  DSH_ADAPTER_ID, FINISH_PROMPT_CONTRACT, FINISH_REMINDER_TEXT, FINISH_TOOL_NAME,
  FINISH_TOOL_OUTPUT_SCHEMA, FINISH_TOOL_PARAMETERS,
  NODE_FINISH_CANCELED, NODE_FINISH_MISSING, buildReminderText, createDshAdapter,
  createFinishToolDefinition, dshHelpDigest,
} from '../src/agent-adapter-dsh.js'
import { NODE_FINISH_ERROR, createFinishGate } from '../src/node-finish.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const sandbox = mkdtempSync(join(repoRoot, '.tmp', 'agent-adapter-dsh-'))

let checks = 0
let asserts = 0

/** 每条断言都计数（`A.throws` / `A.rejects` 这类也照常工作）。 */
const A = new Proxy(assert, {
  get(target, property) {
    const value = target[property]
    if (typeof value !== 'function') return value
    return (...args) => {
      asserts += 1
      return value.apply(target, args)
    }
  },
})

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

// ---------------------------------------------------------------------------
// 夹具：假宿主（agents.create / setup / tools.register / turn-stopping）
// ---------------------------------------------------------------------------

function createDeferred() {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue
    rejectPromise = rejectValue
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

/** 让已排队的微任务 / then 回调跑完（不依赖真实时钟）。 */
async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

/** 等到 predicate 为真（有上限；start 里的 probe 是异步的，不能只靠微任务计数）。 */
async function waitUntil(predicate, ms = 1000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil 超时')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
  }
}

/** Promise 在 ms 内是否仍未决议（dispose 后 exited 不许再 pending）。 */
function promiseState(promise, ms = 30) {
  return Promise.race([
    promise.then(value => ({ state: 'settled', value }), error => ({ state: 'rejected', error })),
    new Promise(resolvePromise => setTimeout(() => resolvePromise({ state: 'pending' }), ms)),
  ])
}

/**
 * 加载宿主真实的 JSON Schema 子集校验器（`assertSupportedJsonSchema`）。
 *
 * 仓库不在 node_modules 里依赖宿主，所以按 DSH 全局安装布局解析；解析不到就直接
 * 失败并给出候选路径——这证明的是「与宿主当前实现兼容」，不能静默跳过。
 */
async function loadHostSchemaValidator() {
  const candidates = []
  const explicit = process.env.DSH_TOOLS_MODULE
  if (typeof explicit === 'string' && explicit !== '') candidates.push(explicit)
  const globalRoot = join(dirname(process.execPath), '..', 'lib', 'node_modules')
  candidates.push(join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
  const failures = []
  for (const candidate of candidates) {
    try {
      const module = await import(pathToFileURL(candidate).href)
      if (typeof module.assertSupportedJsonSchema === 'function') return module.assertSupportedJsonSchema
      failures.push(`${candidate}: 没有导出 assertSupportedJsonSchema`)
    } catch (error) {
      failures.push(`${candidate}: ${error?.code ?? error?.message ?? error}`)
    }
  }
  throw new Error(`找不到宿主 dsh-tools（可用 DSH_TOOLS_MODULE 指定）：${failures.join('；')}`)
}

let caseSeq = 0
function freshWorkspace() {
  const dir = join(sandbox, `case-${++caseSeq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeGate(workspace) {
  return createFinishGate({
    executionId: 'exec-1',
    nodeId: 'agent-1',
    attempt: 1,
    workspaceRoot: workspace,
  })
}

const ELEMENT = {
  id: 'agent-1',
  name: '方案设计',
  kind: 'agent',
  node: {
    kind: 'agent',
    prompt: '为本需求写一份实施方案，落成 markdown 文件。',
    roleCard: '你是方案设计专员。',
  },
}

/**
 * 假宿主：只实现适配器用到的真实 API 形状。
 *   - `agents.create(options)` 记录 options，在 setup 里注册工具 / 挂 turn-stopping；
 *   - `tools.register` 记录定义并返回 disposer；
 *   - `agent.followup/steer/cancel/whenIdle` 记录调用；`whenIdle` 由测试显式 resolve。
 *
 * @param {{ noTools?: boolean, noOn?: boolean }} [features]
 */
function createFakeHost(features = {}) {
  const host = {
    createCalls: [],
    registered: [],
    unregistered: [],
    listeners: [],
    disposeCalls: 0,
    agent: null,
    turn: 0,
    holdCreate: null,
    async create(createOptions) {
      host.createCalls.push(createOptions)
      if (host.holdCreate) await host.holdCreate.promise
      const tools = features.noTools ? {} : {
        register(definition) {
          host.registered.push(definition)
          return () => host.unregistered.push(definition.name)
        },
      }
      const agentCtx = {
        tools,
        ...(features.noOn ? {} : {
          on(name, fn) {
            const entry = { name, fn, disposed: false }
            host.listeners.push(entry)
            return () => { entry.disposed = true }
          },
        }),
      }
      const idle = createDeferred()
      const agent = {
        session: { id: createOptions.sessionId },
        followupCalls: 0,
        followupMessages: [],
        steerMessages: [],
        cancelCauses: [],
        followup(message) {
          agent.followupCalls += 1
          agent.followupMessages.push(message)
        },
        steer(message) { agent.steerMessages.push(message) },
        cancel(cause) { agent.cancelCauses.push(cause) },
        whenIdle() { return idle.promise },
        idle,
      }
      host.agent = agent
      await createOptions.setup(agentCtx, agent)
      return {
        agent,
        dispose: async () => { host.disposeCalls += 1 },
      }
    },
  }
  return host
}

/** 模拟「agent 这一轮停下来」（宿主 `agent/turn-stopping` 的 serial 派发）。 */
async function endTurn(host) {
  host.turn += 1
  const payload = {
    agent: host.agent,
    turn: host.turn,
    signal: new AbortController().signal,
  }
  const handlers = host.listeners.filter(entry => entry.name === 'agent/turn-stopping' && !entry.disposed)
  for (const entry of handlers) await entry.fn(payload)
  return handlers.length
}

function makeAdapter(host, options = {}) {
  // 不默认注入 version：probe 版本解析本身也在测试范围内（m9）。
  return createDshAdapter({ agents: host, ...options })
}

function reminderCollector() {
  const fired = []
  return { fired, reminder: { onFire: info => fired.push(info) } }
}

// ---------------------------------------------------------------------------
// 1. 正常：注册工具 → 调工具 → 完结
// ---------------------------------------------------------------------------

await check('正常：setup 注册 flow_finish_node → 调工具 → exited.ok、零提醒', async () => {
  const host = createFakeHost()
  const gate = makeGate(freshWorkspace())
  const { fired, reminder } = reminderCollector()
  const adapter = makeAdapter(host)
  const handle = await adapter.start({
    element: ELEMENT,
    ctx: { attempt: 1, variables: { need: 'x' } },
    finishGate: gate,
    workspaceRoot: freshWorkspace(),
    reminder,
  })

  A.equal(handle.sessionId, host.createCalls[0].sessionId)
  A.equal(host.createCalls.length, 1, 'agents.create 只调一次')
  A.equal(host.registered.length, 1, 'setup 里注册了一个工具')
  const tool = host.registered[0]
  A.equal(tool.name, FINISH_TOOL_NAME)
  A.deepEqual(tool.parameters.required, ['variables', 'documents', 'summary'])
  A.equal(tool.parameters.additionalProperties, false)
  A.equal(typeof tool.execute, 'function')
  A.equal(typeof tool.output.schema, 'object', '工具带 output.schema（DSH ToolDefinition 契约）')

  A.equal(host.agent.followupCalls, 1, '注册完成之后才 followup')
  const prompt = host.agent.followupMessages[0]
  A.equal(prompt.role, 'user')
  A.equal(prompt.source.kind, 'user', '宿主 MessageSourceMap 只认 user（m9）')
  A.equal(prompt.source.flowStudio.kind, 'flow-studio', '流程 provenance 放在 flowStudio 元数据')
  A.equal(prompt.source.flowStudio.phase, 'prompt')
  A.ok(prompt.content[0].text.includes('flow_finish_node'), '提示词带完结约定')
  A.ok(prompt.content[0].text.includes(FINISH_PROMPT_CONTRACT), '提示词带 11 §6 模板')
  A.ok(prompt.content[0].text.includes('attempt=1'))

  const value = await tool.execute({
    variables: { verdict: 'pass', score: 87 },
    documents: [],
    summary: '完成方案',
  })
  A.equal(value.ok, true)
  A.deepEqual(value.variables, { verdict: 'pass', score: 87 })
  A.deepEqual(value.artifacts, [])
  A.equal(gate.settled(), true, 'gate 已收口')

  const exited = await handle.exited
  A.equal(exited.ok, true)
  A.equal(exited.record.output.verdict, 'pass')
  A.equal(exited.record.summary, '完成方案')
  A.equal(host.agent.steerMessages.length, 0, '提醒 0 次')
  A.equal(fired.length, 0, 'onFire 0 次')

  host.agent.idle.resolve()
  await adapter.dispose(handle)
  A.deepEqual(host.unregistered, [FINISH_TOOL_NAME], 'dispose 注销了会话工具')
})

// ---------------------------------------------------------------------------
// 2. 提醒一次 → 第二轮调工具
// ---------------------------------------------------------------------------

await check('提醒：第一轮停下 1 次 steer → 第二轮调工具 → 成功、onFire count=1', async () => {
  const host = createFakeHost()
  const gate = makeGate(freshWorkspace())
  const { fired, reminder } = reminderCollector()
  const adapter = makeAdapter(host)
  const handle = await adapter.start({
    element: ELEMENT,
    ctx: { attempt: 1 },
    finishGate: gate,
    workspaceRoot: freshWorkspace(),
    reminder,
  })
  const tool = host.registered[0]

  A.equal(await endTurn(host), 1, '挂了一个 turn-stopping 监听')
  A.equal(host.agent.steerMessages.length, 1, '收到 1 次 steer 提醒')
  const steerText = host.agent.steerMessages[0].content[0].text
  A.equal(host.agent.steerMessages[0].source.kind, 'user')
  A.equal(host.agent.steerMessages[0].source.flowStudio.phase, 'reminder')
  A.ok(steerText.startsWith('【必须调用工具】'), '提醒以固定模板开头')
  A.ok(steerText.includes(FINISH_TOOL_NAME))
  A.ok(steerText.includes('第 1/3 次提醒'), '提醒带计数后缀')
  A.ok(steerText.includes(buildReminderText({ count: 1, maxFires: 3 }).split('\n')[0]), '提醒正文与模板一致')
  A.deepEqual(fired.map(info => info.count), [1])
  A.equal(fired[0].maxFires, 3)
  A.equal(gate.settled(), false, '提醒轮不算完结')
  A.equal(handle.exited instanceof Promise, true)

  const value = await tool.execute({ variables: { verdict: 'pass' }, documents: [], summary: '第二轮完结' })
  A.equal(value.ok, true)
  const exited = await handle.exited
  A.equal(exited.ok, true)
  A.equal(host.agent.steerMessages.length, 1, '成功之后不再 steer')
  A.equal(fired.length, 1)

  await endTurn(host)
  A.equal(host.agent.steerMessages.length, 1, '完结后 turn-stopping 不再提醒')

  host.agent.idle.resolve()
  await adapter.dispose(handle)
})

await check('BPMN provider/model 成对传给 agents.create（不被静默丢弃）', async () => {
  // codex 复审发现：BPMN 里 provider / model 是两个字符串属性，旧实现只把 node.model
  // 当候选、pickRoute 要成对，于是整条路由被丢掉，节点以「has no provider/model」失败。
  const host = createFakeHost()
  const gate = makeGate(freshWorkspace())
  const adapter = makeAdapter(host)
  const element = {
    ...ELEMENT,
    node: { ...ELEMENT.node, provider: 'deepseek', model: 'deepseek-chat' },
  }
  const handle = await adapter.start({
    element,
    ctx: { attempt: 1 },
    finishGate: gate,
    workspaceRoot: freshWorkspace(),
  })
  A.deepEqual(host.createCalls[0].agentOptions, { provider: 'deepseek', model: 'deepseek-chat' })
  host.agent.idle.resolve()
  await adapter.dispose(handle)
  const exited = await handle.exited
  A.equal(exited.code, 'NODE_FINISH_CANCELED', 'dispose 视为取消')
})

// ---------------------------------------------------------------------------
// 3. 提醒用尽 → NODE_FINISH_MISSING
// ---------------------------------------------------------------------------

await check('用尽：3 轮都不调工具 → 3 次 steer 后 MISSING（reminders:3）', async () => {
  const host = createFakeHost()
  const gate = makeGate(freshWorkspace())
  const { fired, reminder } = reminderCollector()
  const adapter = makeAdapter(host)
  const handle = await adapter.start({
    element: ELEMENT,
    ctx: { attempt: 1 },
    finishGate: gate,
    workspaceRoot: freshWorkspace(),
    reminder,
  })

  for (let round = 1; round <= 3; round += 1) {
    A.equal(await endTurn(host), 1)
    A.equal(host.agent.steerMessages.length, round, `第 ${round} 轮 steer 一次`)
    A.equal(gate.settled(), false, `第 ${round} 轮还没结束节点`)
  }
  A.equal(await endTurn(host), 1, '第 4 次停下：提醒已用尽')

  const exited = await handle.exited
  A.deepEqual(exited, { ok: false, code: NODE_FINISH_MISSING, reminders: 3 })
  A.equal(host.agent.steerMessages.length, 3, '恰 3 次 steer')
  A.deepEqual(fired.map(info => info.count), [1, 2, 3])
  A.equal(host.agent.cancelCauses.length, 0, 'MISSING 本身不 cancel 会话（实例保持 ACTIVE）')
  A.equal(gate.settled(), true, 'MISSING 之后闸门必须已 abort，不能停在 pending（M3）')
  A.match(String(gate.reason()), /NODE_FINISH_MISSING/, 'abort 原因能看出是 MISSING')
  await A.rejects(gate.result, error => {
    A.equal(error.code, NODE_FINISH_ERROR.ABORTED)
    A.equal(error.aborted, true)
    return true
  })

  // 迟到工具调用：闸门已 abort，submit 永久拒绝，不能把 FAIL 追认成一次完成。
  const late = await host.registered[0].execute({
    variables: { late: true },
    documents: [],
    summary: '迟到的完成',
  })
  A.equal(late.ok, false, 'MISSING 之后迟到工具调用被拒绝')
  A.equal(late.code, NODE_FINISH_ERROR.ALREADY_SETTLED)
  A.equal(gate.settled(), true, '闸门保持 settled（aborted）')
  A.deepEqual(await handle.exited, exited, 'exited 仍是 MISSING，不因迟到调用改变')

  host.agent.idle.resolve()
  await adapter.dispose(handle)
})

await check('maxFires=0：第一次停下立即 MISSING、零 steer', async () => {
  const host = createFakeHost()
  const gate = makeGate(freshWorkspace())
  const { fired, reminder } = reminderCollector()
  const adapter = makeAdapter(host)
  const handle = await adapter.start({
    element: ELEMENT,
    ctx: { attempt: 1 },
    finishGate: gate,
    workspaceRoot: freshWorkspace(),
    reminder: { ...reminder, maxFires: 0 },
  })

  A.equal(await endTurn(host), 1)
  const exited = await handle.exited
  A.deepEqual(exited, { ok: false, code: NODE_FINISH_MISSING, reminders: 0 })
  A.equal(host.agent.steerMessages.length, 0)
  A.equal(fired.length, 0)
  A.equal(gate.settled(), true, 'MISSING 同时 abort 闸门（M3）')

  host.agent.idle.resolve()
  await adapter.dispose(handle)
})

await check('agent/error：真实会话错误冒泡成 DSH_AGENT_FAILED，不被 whenIdle 掩成 MISSING', async () => {
  // 2026-11-11 容器测试台实测：agent 会话报错（无模型凭据）后 whenIdle 兜底记成
  // NODE_FINISH_MISSING（0.3s、reminders:0），把故障掩盖成「没调工具」。这里锁住
  // 「真实错误必须冒泡 + 闸门同时 abort」。
  const host = createFakeHost()
  const gate = makeGate(freshWorkspace())
  const { fired, reminder } = reminderCollector()
  const adapter = makeAdapter(host)
  const handle = await adapter.start({
    element: ELEMENT,
    ctx: { attempt: 1 },
    finishGate: gate,
    workspaceRoot: freshWorkspace(),
    reminder,
  })

  const handlers = host.listeners.filter(entry => entry.name === 'agent/error' && !entry.disposed)
  A.equal(handlers.length, 1, 'setup 里订阅了 agent/error')
  await handlers[0].fn({
    agent: host.agent,
    turn: 1,
    step: 1,
    error: new Error('模型路由不可用：no provider configured'),
  })

  const exited = await handle.exited
  A.equal(exited.ok, false)
  A.equal(exited.code, 'DSH_AGENT_FAILED', '不是 NODE_FINISH_MISSING')
  A.equal(exited.reminders, 0)
  A.match(String(exited.message), /模型路由不可用/, '真实原因带出来')
  A.equal(gate.settled(), true, '错误同时 abort 闸门（迟到 submit 一律拒绝）')
  A.equal(fired.length, 0, '没有提醒')

  host.agent.idle.resolve()
  await adapter.dispose(handle)
})

// ---------------------------------------------------------------------------
// 4. 取消 / abort
// ---------------------------------------------------------------------------

await check('cancel：agent.cancel 恰一次、gate.abort 生效、重复 cancel 无效', async () => {
  const host = createFakeHost()
  const gate = makeGate(freshWorkspace())
  const adapter = makeAdapter(host)
  const handle = await adapter.start({
    element: ELEMENT,
    ctx: { attempt: 1 },
    finishGate: gate,
    workspaceRoot: freshWorkspace(),
  })

  A.equal(await adapter.cancel(handle, 'activity-timeout'), true)
  A.equal(host.agent.cancelCauses.length, 1, 'agent.cancel 恰一次')
  A.deepEqual(host.agent.cancelCauses[0], { kind: 'parent' })
  A.equal(gate.settled(), true, 'gate.abort 生效')
  await A.rejects(gate.result, error => error && error.aborted === true)

  const exited = await handle.exited
  A.deepEqual(exited, { ok: false, code: NODE_FINISH_CANCELED, reminders: 0 })

  A.equal(await adapter.cancel(handle, 'again'), false, '重复 cancel 返回 false')
  A.equal(host.agent.cancelCauses.length, 1, 'agent.cancel 仍然只有一次')

  host.agent.idle.resolve()
  await adapter.dispose(handle)
})

await check('ctx.signal abort：迟到 create 结果被 dispose、不 followup', async () => {
  const host = createFakeHost()
  host.holdCreate = createDeferred()
  const gate = makeGate(freshWorkspace())
  const adapter = makeAdapter(host)
  const controller = new AbortController()

  const startPromise = adapter.start({
    element: ELEMENT,
    ctx: { attempt: 1, signal: controller.signal },
    finishGate: gate,
    workspaceRoot: freshWorkspace(),
  })
  await waitUntil(() => host.createCalls.length === 1)
  A.equal(host.createCalls.length, 1, 'create 已经在飞')

  controller.abort()
  await flush()
  A.equal(gate.settled(), true, 'abort 立即 abort 闸门')
  A.equal(host.disposeCalls, 0, 'create 还没回来，没有句柄可释放')

  host.holdCreate.resolve()
  const handle = await startPromise
  await flush()

  A.equal(host.disposeCalls, 1, '迟到创建的结果被 dispose')
  A.equal(host.agent.followupCalls, 0, '取消后不投递提示词')
  A.equal(host.agent.cancelCauses.length, 0, '会话从未可用，不调用 agent.cancel')
  const exited = await handle.exited
  A.equal(exited.ok, false)
  A.equal(exited.code, NODE_FINISH_CANCELED)

  host.agent.idle.resolve()
  await adapter.dispose(handle)
  A.equal(host.disposeCalls, 1, 'dispose 幂等，不重复释放')
})

// ---------------------------------------------------------------------------
// 5. 能力表 / 没有 tools.register
// ---------------------------------------------------------------------------

await check('能力：未 probe → unsupported；probe 成功 → native；start 会自动 probe', async () => {
  const host = createFakeHost()
  const adapter = makeAdapter(host)
  const before = adapter.capabilities()
  A.equal(before.finishTool, 'unsupported', '未 probe 前不得宣称 native（M1）')
  A.equal(before.hooks['turn.stop'], 'unsupported', '未 probe 前 hook 也不宣称 native')
  A.equal(adapter.id, DSH_ADAPTER_ID)
  A.throws(
    () => assertFinishToolNative(adapter),
    error => error.code === ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
    '未 probe 时 assertFinishToolNative 必须拒绝',
  )
  A.equal(host.createCalls.length, 0, '仅读 capabilities 不会创建会话')

  const probe = await adapter.probe()
  A.ok(typeof probe.version === 'string' && probe.version !== '', 'probe 版本非空')
  A.match(probe.helpDigest, /^[0-9a-f]{64}$/)
  A.equal(adapter.capabilities().finishTool, 'native', 'probe 成功后返回 native')
  A.equal(adapter.capabilities().hooks['turn.stop'], 'native')
  A.equal(assertFinishToolNative(adapter), true)

  // 另起一个从未显式 probe 的适配器：start 必须先 probe 再创建会话。
  const autoHost = createFakeHost()
  const autoAdapter = makeAdapter(autoHost)
  const gate = makeGate(freshWorkspace())
  const handle = await autoAdapter.start({
    element: ELEMENT,
    ctx: { attempt: 1 },
    finishGate: gate,
    workspaceRoot: freshWorkspace(),
  })
  A.equal(autoHost.createCalls.length, 1, 'start 自动 probe 后创建会话')
  A.equal(autoAdapter.capabilities().finishTool, 'native')
  await autoAdapter.cancel(handle, 'test-cleanup')
  autoHost.agent.idle.resolve()
  await autoAdapter.dispose(handle)
})

await check('probe：版本来自注入；源码树取不到时如实 unknown 且 helpDigest 体现', async () => {
  const host = createFakeHost()
  const injected = makeAdapter(host, { version: '9.9.9-test' })
  const injectedProbe = await injected.probe()
  A.equal(injectedProbe.version, '9.9.9-test', '注入版本优先')
  A.equal(injectedProbe.helpDigest, dshHelpDigest('9.9.9-test'), 'digest 由 API 面 + 版本算出')
  A.equal(injectedProbe.helpDigest, dshHelpDigest('9.9.9-test'))
  A.notEqual(dshHelpDigest('unknown'), dshHelpDigest('9.9.9-test'), 'unknown 不能被掩盖成正常版本')

  const sourceTree = makeAdapter(createFakeHost())
  const sourceProbe = await sourceTree.probe()
  A.equal(sourceProbe.version, 'unknown', '源码树里取不到宿主版本时如实返回 unknown')
  A.equal(sourceProbe.helpDigest, dshHelpDigest('unknown'), 'helpDigest 体现 unknown')

  // 没有 agents.create：start 的自动 probe 失败要收敛成「工具通道不可用」。
  const noHost = createDshAdapter({})
  await A.rejects(
    noHost.start({ element: ELEMENT, ctx: {}, finishGate: makeGate(freshWorkspace()) }),
    (error) => {
      A.equal(error instanceof AdapterError, true)
      A.equal(error.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE, 'probe 失败按不可用拒绝启动')
      return true
    },
  )
})

await check('没有 agentCtx.on：拒绝启动 → NODE_FINISH_TOOL_UNAVAILABLE，工具被回收', async () => {
  const host = createFakeHost({ noOn: true })
  const adapter = makeAdapter(host)
  const gate = makeGate(freshWorkspace())
  await A.rejects(
    adapter.start({
      element: ELEMENT,
      ctx: { attempt: 1 },
      finishGate: gate,
      workspaceRoot: freshWorkspace(),
    }),
    (error) => {
      A.equal(error instanceof AdapterError, true)
      A.equal(error.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE, '缺 hook 能力按工具通道不可用处理（M1）')
      return true
    },
  )
  A.equal(host.agent.followupCalls, 0, '没有提醒能力时绝不 followup')
  A.deepEqual(host.unregistered, [FINISH_TOOL_NAME], '注册过的工具在失败路径被注销')
  A.equal(gate.settled(), false, '不会伪造完结')
})

await check('没有 agentCtx.tools.register：拒绝启动 → NODE_FINISH_TOOL_UNAVAILABLE', async () => {
  const host = createFakeHost({ noTools: true })
  const adapter = makeAdapter(host)
  const gate = makeGate(freshWorkspace())
  await A.rejects(
    adapter.start({
      element: ELEMENT,
      ctx: { attempt: 1 },
      finishGate: gate,
      workspaceRoot: freshWorkspace(),
    }),
    (error) => {
      A.equal(error instanceof AdapterError, true)
      A.equal(error.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE)
      return true
    },
  )
  A.equal(host.agent.followupCalls, 0, '没有工具能力时绝不 followup')
  A.equal(host.registered.length, 0)
  A.equal(gate.settled(), false, '不会伪造完结')
})

await check('tool schema：与宿主 assertSupportedJsonSchema 子集兼容（m4）', async () => {
  const assertSupportedJsonSchema = await loadHostSchemaValidator()
  A.doesNotThrow(() => assertSupportedJsonSchema(FINISH_TOOL_PARAMETERS), 'parameters 必须过宿主子集')
  A.doesNotThrow(() => assertSupportedJsonSchema(FINISH_TOOL_OUTPUT_SCHEMA), 'output schema 必须过宿主子集')
  A.equal(
    FINISH_TOOL_PARAMETERS.properties.variables.additionalProperties,
    true,
    'additionalProperties 用宿主支持的 boolean 形状',
  )
})

// ---------------------------------------------------------------------------
// 5.1 dispose / MISSING 收尾（m2）与迟到工具（M3）
// ---------------------------------------------------------------------------

await check('dispose：未 settle 视为取消 → exited=CANCELED、gate aborted、agent.cancel 一次（m2）', async () => {
  const host = createFakeHost()
  const gate = makeGate(freshWorkspace())
  const adapter = makeAdapter(host)
  const handle = await adapter.start({
    element: ELEMENT,
    ctx: { attempt: 1 },
    finishGate: gate,
    workspaceRoot: freshWorkspace(),
  })

  A.equal((await promiseState(handle.exited)).state, 'pending', 'dispose 之前 exited 在等完结')
  A.equal(await adapter.dispose(handle), true)

  const after = await promiseState(handle.exited)
  A.equal(after.state, 'settled', 'dispose 之后 exited 不再 pending')
  A.deepEqual(after.value, { ok: false, code: NODE_FINISH_CANCELED, reminders: 0 })
  A.equal(gate.settled(), true, 'dispose 未 settle 时 abort 闸门')
  await A.rejects(gate.result, error => error.aborted === true)
  A.equal(host.agent.cancelCauses.length, 1, 'dispose 收掉节点会话')
  A.equal(host.disposeCalls, 1, 'agents.create 的句柄被释放')
  A.equal(await adapter.dispose(handle), false, 'dispose 幂等')

  host.agent.idle.resolve()
})

await check('MISSING 后 cancel / dispose 仍收掉节点会话（m2）', async () => {
  // 场景 A：MISSING 之后显式 cancel
  const hostA = createFakeHost()
  const adapterA = makeAdapter(hostA)
  const handleA = await adapterA.start({
    element: ELEMENT,
    ctx: { attempt: 1 },
    finishGate: makeGate(freshWorkspace()),
    workspaceRoot: freshWorkspace(),
  })
  for (let round = 1; round <= 4; round += 1) await endTurn(hostA)
  A.equal((await handleA.exited).code, NODE_FINISH_MISSING, '4 次停下 → MISSING')
  A.equal(hostA.agent.cancelCauses.length, 0, 'MISSING 本身不 cancel')
  A.equal(await adapterA.cancel(handleA, 'after-missing'), true, 'MISSING 后 cancel 仍生效')
  A.equal(hostA.agent.cancelCauses.length, 1, 'cancel 收掉会话')
  hostA.agent.idle.resolve()
  await adapterA.dispose(handleA)
  A.equal(hostA.agent.cancelCauses.length, 1, 'dispose 不再重复 cancel')

  // 场景 B：MISSING 之后只走 dispose
  const hostB = createFakeHost()
  const adapterB = makeAdapter(hostB)
  const handleB = await adapterB.start({
    element: ELEMENT,
    ctx: { attempt: 1 },
    finishGate: makeGate(freshWorkspace()),
    workspaceRoot: freshWorkspace(),
  })
  for (let round = 1; round <= 4; round += 1) await endTurn(hostB)
  A.equal((await handleB.exited).code, NODE_FINISH_MISSING)
  A.equal(hostB.agent.cancelCauses.length, 0)
  await adapterB.dispose(handleB)
  A.equal(hostB.agent.cancelCauses.length, 1, 'dispose 承担 MISSING 后的会话清理')
})

await check('documents[].summary 持久化到 artifact，工具返回与 record 都能看到（m3）', async () => {
  const workspace = freshWorkspace()
  writeFileSync(join(workspace, 'plan.md'), '# 方案\n')
  const gate = makeGate(workspace)
  const host = createFakeHost()
  const active = makeAdapter(host)
  const handle = await active.start({
    element: ELEMENT,
    ctx: { attempt: 1 },
    finishGate: gate,
    workspaceRoot: workspace,
  })
  const tool = host.registered[0]
  const value = await tool.execute({
    variables: {},
    documents: [{ path: 'plan.md', kind: 'markdown', title: '方案', summary: '一句话说明这份文档' }],
    summary: '写了方案',
  })
  A.equal(value.ok, true)
  A.equal(value.artifacts[0].summary, '一句话说明这份文档', '工具返回带文档摘要')
  const record = await gate.result
  A.equal(record.artifacts[0].summary, '一句话说明这份文档', 'record（activity/end 的来源）带文档摘要')
  A.equal(record.artifacts[0].path, 'plan.md')
  host.agent.idle.resolve()
  await active.dispose(handle)
})

await check('tool execute：exec.signal 提交前/返回前都检查，取消后不报成功（m4）', async () => {
  // 提交前已 abort：不碰闸门。
  const gateBefore = makeGate(freshWorkspace())
  const toolBefore = createFinishToolDefinition({ finishGate: gateBefore, element: ELEMENT })
  const abortedBefore = new AbortController()
  abortedBefore.abort()
  const beforeValue = await toolBefore.execute(
    { variables: {}, documents: [], summary: '取消前' },
    { signal: abortedBefore.signal },
  )
  A.equal(beforeValue.ok, false)
  A.equal(beforeValue.code, NODE_FINISH_CANCELED)
  A.equal(gateBefore.settled(), false, '取消的调用不占用闸门')

  // 提交成功后、返回前 abort：结果必须报告取消（即使闸门已经受理）。
  const workspace = freshWorkspace()
  const gateAfter = makeGate(workspace)
  const abortedAfter = new AbortController()
  const toolAfter = createFinishToolDefinition({
    finishGate: {
      submit: async args => {
        const submitted = await gateAfter.submit(args)
        abortedAfter.abort()
        return submitted
      },
      settled: () => gateAfter.settled(),
      abort: reason => gateAfter.abort(reason),
      result: gateAfter.result,
    },
    element: ELEMENT,
  })
  const afterValue = await toolAfter.execute(
    { variables: {}, documents: [], summary: '取消后' },
    { signal: abortedAfter.signal },
  )
  A.equal(afterValue.ok, false, '返回前 abort 不把结果报成成功')
  A.equal(afterValue.code, NODE_FINISH_CANCELED)
  A.equal(gateAfter.settled(), true, '闸门本身已经受理（取消只影响工具返回值）')
})

await check('probeAll：单个适配器探测超时 → ok:false，后续适配器照常（m9）', async () => {
  const registry = createAdapterRegistry({ probeTimeoutMs: 60 })
  registry.register({
    id: 'hang',
    probe: () => new Promise(() => {}),
    capabilities: () => ({ finishTool: 'unsupported', hooks: { 'turn.stop': 'unsupported' } }),
    start: async () => {},
    cancel: async () => {},
    dispose: async () => {},
  })
  registry.register({
    id: 'good',
    probe: async () => ({ version: '1.0.0', helpDigest: 'digest' }),
    capabilities: () => ({ finishTool: 'unsupported', hooks: { 'turn.stop': 'unsupported' } }),
    start: async () => {},
    cancel: async () => {},
    dispose: async () => {},
  })
  const results = await registry.probeAll()
  A.deepEqual(results.map(item => item.id), ['hang', 'good'])
  A.equal(results[0].ok, false, '超时按不可用记录')
  A.equal(results[0].error.code, ADAPTER_ERROR.PROBE_INVALID)
  A.match(results[0].error.message, /超时|未返回/)
  A.equal(results[1].ok, true, '一个适配器超时不影响后面的探测')
})

await check('finishGate 缺 result：start 拒绝（不把 undefined 当成成功记录）', async () => {
  const host = createFakeHost()
  const adapter = makeAdapter(host)
  await A.rejects(
    adapter.start({
      element: ELEMENT,
      ctx: { attempt: 1 },
      // 只有 submit / settled / abort：旧实现会 Promise.resolve(undefined) 后 settle ok。
      finishGate: {
        submit: async () => ({ ok: true, record: {} }),
        settled: () => false,
        abort: () => false,
      },
      workspaceRoot: freshWorkspace(),
    }),
    (error) => {
      A.equal(error instanceof AdapterError, true)
      A.equal(error.code, ADAPTER_ERROR.INVALID, '缺 result 是参数非法，不是可用性失败')
      return true
    },
  )
  A.equal(host.createCalls.length, 0, '参数非法时不创建会话')
})

// ---------------------------------------------------------------------------
// 6. 注册表（agent-adapter.js 冻结接口）
// ---------------------------------------------------------------------------

await check('注册表：register/get/list/probeAll、重复 id、非法能力、unsupported 适配器', async () => {
  const registry = createAdapterRegistry()
  const host = createFakeHost()
  const dsh = makeAdapter(host, { version: 'test-0' })
  const off = registry.register(dsh)
  A.equal(registry.get(DSH_ADAPTER_ID), dsh)
  A.deepEqual(registry.list().map(item => item.id), [DSH_ADAPTER_ID])
  A.throws(() => registry.register(dsh), error => error.code === ADAPTER_ERROR.DUPLICATE_ID)
  A.throws(
    () => registry.register({ id: 'broken-shape' }),
    error => error.code === ADAPTER_ERROR.INVALID,
  )
  A.throws(
    () => registry.register({
      id: 'bad-capability',
      probe: async () => ({ version: '1', helpDigest: 'x' }),
      capabilities: () => ({ finishTool: 'emulated', hooks: { 'turn.stop': 'native' } }),
      start: async () => {},
      cancel: async () => {},
      dispose: async () => {},
    }),
    error => error.code === ADAPTER_ERROR.CAPABILITY_INVALID,
  )

  const legacy = {
    id: 'legacy',
    probe: async () => ({ version: '0', helpDigest: 'digest' }),
    capabilities: () => ({ finishTool: 'unsupported', hooks: { 'turn.stop': 'unsupported' } }),
    start: async () => assertFinishToolNative(legacy, { phase: 'start' }),
    cancel: async () => {},
    dispose: async () => {},
  }
  registry.register(legacy)
  await A.rejects(legacy.start(), error => error.code === ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE)

  registry.register({
    id: 'broken-probe',
    probe: async () => { throw new Error('boom') },
    capabilities: () => ({ finishTool: 'unsupported', hooks: { 'turn.stop': 'unsupported' } }),
    start: async () => {},
    cancel: async () => {},
    dispose: async () => {},
  })

  const probed = await registry.probeAll()
  A.deepEqual(probed.map(item => item.id), [DSH_ADAPTER_ID, 'legacy', 'broken-probe'])
  A.equal(probed[0].ok, true)
  A.equal(probed[0].version, 'test-0')
  A.equal(typeof probed[0].helpDigest, 'string')
  A.ok(probed[0].helpDigest.length === 64, 'helpDigest 是 sha256 十六进制')
  A.equal(probed[1].ok, true)
  A.equal(probed[2].ok, false)
  A.equal(probed[2].error.code, ADAPTER_ERROR.PROBE_INVALID)

  off()
  A.equal(registry.get(DSH_ADAPTER_ID), undefined, '注销器生效')
})

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log('agent-adapter-dsh.test.mjs')
console.log(`\n${checks} 组通过（${asserts} 条断言）`)

try {
  rmSync(sandbox, { recursive: true, force: true })
} catch {
  // 清理失败不影响测试结论（临时目录仍在 .tmp/ 下）。
}
