#!/usr/bin/env node
/**
 * 模型工具自检（06-execution-engine.md · §15 会话内启停）。
 *
 * 全部走注入桩：不启动 dsh、不 import 任何 dsh 包。run / flow 模板落在项目 `.tmp/`
 * 下（不占系统 /tmp）。真实 import 只用本仓库的 src/store.js / src/runstore.js。
 *
 * 覆盖：flow_list 摘要、flow_start 按 id / 名字启动（parent = 当前会话）、同名多份、
 * 流程不存在 / 不合法、engine.start 409、supervision 闹钟文案、flow_watch（stub 审计 +
 * 省略 runId 取最近一次）、flow_stop 成功 / 不在运行中、输出 lossless、无 tools 服务时
 * apply() 不炸、参数 schema 的必填项。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-tools-'))
process.env.DSH_HOME = home

const {
  createFlowTools, DEFAULT_WATCH_SECONDS, MAX_TIMEOUT_MS,
} = await import('../src/tools.js')
// F1：白名单校验的唯一实现在 inbox.js（HTTP /inbox、/messages 与两个模型工具共用）。
const {
  REPLY_LOOPBACK_HOSTS, REPLY_TOKEN_ENV_PREFIX, maskSecret, redactSecrets,
  validateInboundBody, validateReplyTarget, validateReplyTargetStrict, validateReplyTokenEnv,
  validateReplyUrl,
} = await import('../src/inbox.js')
const { deliverInboundMessage } = await import('../src/inbox.js')
const { createEngine } = await import('../src/engine.js')
const { apply } = await import('../src/index.js')
const store = await import('../src/store.js')
const runstore = await import('../src/runstore.js')
// F2：前端的纯逻辑（工作区门禁 / 建 run 与 start 的请求体）在这里一起断言。
const {
  createRunBodyFor, isAbsoluteWorkspace, normalizeWorkspace, readStoredWorkspace,
  runControlState, startFailurePlan, startRunBodyFor, startRunRequest, workspaceBlockReason,
  writeStoredWorkspace,
} = await import('../src/client/page.js')
// F2：HTTP 载荷级断言走真实客户端 api（fetch spy），不是「有传参」这种弱断言。
// G7：轻量轮询（?light=1）的降级路径也在客户端，这里一并验证「正常时不会回退」。
const {
  api: clientApi, createLightRunReader, readRunPath,
} = await import('../src/client/api.js')

const flowsRoot = store.flowsDir(home)
const runsRoot = runstore.runsDir(home)

let checks = 0
let assertionCount = 0
const A = {
  equal(actual, expected, message) {
    assertionCount += 1
    assert.equal(actual, expected, message)
  },
  deepEqual(actual, expected, message) {
    assertionCount += 1
    assert.deepEqual(actual, expected, message)
  },
  ok(value, message) {
    assertionCount += 1
    assert.ok(value, message)
  },
  match(value, pattern, message) {
    assertionCount += 1
    assert.match(value, pattern, message)
  },
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

// ── 流程模板 / 假引擎 / 假上下文 ───────────────────────────────────────────

const FIXED_TS = '2026-11-06T00:00:00.000Z'

function nodeBase(id, kind, title) {
  return {
    id, kind, title, x: 0, y: 200, mode: 'single', role: '', task: `${title} 的任务`,
    outputs: '', skills: [], maxRounds: 2, team: [], model: '',
  }
}

function makeFlow(id, name, stages = [{ id: 'n_a', title: '阶段 A' }]) {
  const nodes = [nodeBase('n_start', 'start', '任务输入')]
  const edges = []
  let prev = 'n_start'
  stages.forEach((stage, index) => {
    nodes.push(nodeBase(stage.id, 'stage', stage.title))
    edges.push({ id: `e${index}`, from: prev, to: stage.id, kind: 'next', label: '' })
    prev = stage.id
  })
  nodes.push(nodeBase('n_end', 'end', '完成'))
  edges.push({ id: 'e_end', from: prev, to: 'n_end', kind: 'next', label: '' })
  return {
    schemaVersion: 1,
    id,
    name,
    description: '',
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    nodes,
    edges,
  }
}

/**
 * 假引擎：记录 start / stop 的调用，可按用例注入返回值或抛错。
 * `get` 模拟 runtime 的 `get(runId)`（07 §5：唯一冲突是「同一个 runId 已在跑」）；
 * `supervision` 模拟 runtime 暴露的 SupervisionScheduler。
 */
function makeEngine({
  startResult, startError, stopResult, stopError, active = null, engineName, get, supervision,
  enableSupervision,
} = {}) {
  const calls = { start: [], stop: [] }
  const engine = {
    calls,
    active,
    engineName,
    async start(runId, options) {
      calls.start.push({ runId, options })
      if (startError) throw startError
      return typeof startResult === 'function' ? startResult(runId, options) : { id: runId, status: 'running' }
    },
    async stop(runId) {
      calls.stop.push({ runId })
      if (stopError) throw stopError
      return typeof stopResult === 'function' ? stopResult(runId) : { id: runId, status: 'aborted' }
    },
  }
  if (typeof get === 'function') engine.get = get
  if (supervision !== undefined) engine.supervision = supervision
  if (typeof enableSupervision === 'function') engine.enableSupervision = enableSupervision
  return engine
}

function makeTools({ engine = makeEngine(), auditWorkflow, watchSeconds, now, worktree, worktreeRunner } = {}) {
  return createFlowTools({
    flowsRoot, runsRoot, engine, auditWorkflow, watchSeconds, now, worktree, worktreeRunner,
  })
}

/**
 * F1：注册收件箱两个工具需要 ctx 提供 agents 服务（只看形状，不做真投递）。
 * 传进来的 agents 故意是最小形状：pending run 的投递路径根本不会用到它。
 */
function makeToolsWithInbox({ engine = makeEngine(), agents } = {}) {
  const service = agents || {
    get() { return undefined },
    resume: async () => ({ agent: null }),
    roots: () => [],
  }
  const ctx = {
    get(name) {
      return name === 'agents' ? service : undefined
    },
  }
  return createFlowTools({ flowsRoot, runsRoot, engine, ctx })
}

/** 假 storage：与 localStorage 同形，够断言「记住工作区 / 清空即删除」。 */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)) },
    removeItem: key => { data.delete(key) },
    has: key => data.has(key),
    raw: key => data.get(key),
  }
}

function byName(tools, name) {
  return tools.find(tool => tool.name === name)
}

function makeExec(sessionId = 'session-a') {
  const agent = { session: { id: sessionId, header: { cwd: '/workspace/inherited' } } }
  return { agent, signal: undefined }
}

/** 极简 ctx：只实现 apply 用到的成员。 */
function makeCtx({ toolsService = true, useCtxProperty = false } = {}) {
  const registered = []
  const disposed = []
  const disposeFns = []
  const ctx = {
    routes: [],
    webServer: {
      register(route) {
        ctx.routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposeFns.push(dispose)
      return dispose
    },
    logger: { warn() {}, error() {}, info() {} },
    get(name) {
      if (name === 'tools' && toolsService && !useCtxProperty) {
        return {
          register(tool) {
            registered.push(tool)
            return () => disposed.push(tool.name)
          },
        }
      }
      return undefined
    },
  }
  if (toolsService && useCtxProperty) {
    ctx.tools = {
      register(tool) {
        registered.push(tool)
        return () => disposed.push(tool.name)
      },
    }
  }
  return { ctx, registered, disposed, disposeFns }
}

try {
  // ── 准备流程模板 ────────────────────────────────────────────────────────
  await store.saveFlow(flowsRoot, 'flow-main', makeFlow('flow-main', '主流程'))
  await store.saveFlow(flowsRoot, 'flow-alt', makeFlow('flow-alt', '备用流程'))
  await store.saveFlow(flowsRoot, 'flow-dup-a', makeFlow('flow-dup-a', '重名流程'))
  await store.saveFlow(flowsRoot, 'flow-dup-b', makeFlow('flow-dup-b', '重名流程'))
  // 没有阶段节点：结构不合法，flow_start 必须在建 run 之前就挡下。
  await store.saveFlow(flowsRoot, 'flow-bad', makeFlow('flow-bad', '坏流程', []))

  const outputs = []
  const record = value => {
    outputs.push(value)
    return value
  }

  // ── 1. flow_list ────────────────────────────────────────────────────────
  await check('flow_list 返回模板摘要（id / name / nodeCount / edgeCount / updatedAt）', async () => {
    const tools = makeTools()
    const list = byName(tools, 'flow_list')
    const result = record(await list.execute({}, makeExec()))
    A.equal(result.ok, true)
    A.ok(Array.isArray(result.flows))
    A.ok(result.flows.length >= 5)
    const main = result.flows.find(item => item.id === 'flow-main')
    A.ok(main)
    A.equal(main.name, '主流程')
    A.equal(main.nodeCount, 3)
    A.equal(main.edgeCount, 2)
    A.ok(typeof main.updatedAt === 'string' && main.updatedAt !== '')
    for (const item of result.flows) {
      A.equal(typeof item.id, 'string')
      A.equal(typeof item.name, 'string')
      A.equal(typeof item.nodeCount, 'number')
      A.equal(typeof item.edgeCount, 'number')
      A.equal(typeof item.updatedAt, 'string')
    }
  })

  await check('flow_list 的 limit 截断（默认 20 / 上限 100）', async () => {
    const tools = makeTools()
    const list = byName(tools, 'flow_list')
    const limited = record(await list.execute({ limit: 2 }, makeExec()))
    A.equal(limited.flows.length, 2)
    const invalid = record(await list.execute({ limit: 0 }, makeExec()))
    A.equal(invalid.ok, false)
    A.ok(invalid.hint)
  })

  // ── 2. flow_start 按 id：parent = 当前会话 ──────────────────────────────
  await check('flow_start 按 id 启动：engine.start 收到 options.parent === exec.agent', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const start = byName(tools, 'flow_start')
    const exec = makeExec('session-xyz')
    const result = record(await start.execute({ flowId: 'flow-main', task: '把登录页做出来' }, exec))

    A.equal(result.ok, true)
    A.ok(typeof result.runId === 'string' && result.runId.length > 0)
    A.equal(result.flowId, 'flow-main')
    A.equal(result.flowName, '主流程')
    A.equal(result.status, 'running')
    A.equal(result.workspace.inheritedFrom, 'session-xyz')

    A.equal(engine.calls.start.length, 1)
    A.equal(engine.calls.start[0].runId, result.runId)
    A.equal(engine.calls.start[0].options.parent, exec.agent)
    A.equal(engine.calls.start[0].options.parent.session.id, 'session-xyz')

    const meta = await runstore.readRunMeta(runsRoot, result.runId)
    A.ok(meta)
    A.equal(meta.flowId, 'flow-main')
    A.equal(meta.name, '把登录页做出来')
  })

  await check('flow_start 的 name 优先于 task（写进 run.json.name）', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const result = record(await byName(tools, 'flow_start').execute(
      { flowId: 'flow-alt', task: '原始任务文本', name: '自定义 run 名' },
      makeExec('session-n'),
    ))
    A.equal(result.ok, true)
    const meta = await runstore.readRunMeta(runsRoot, result.runId)
    A.equal(meta.name, '自定义 run 名')
  })

  // ── 3. flow_start 按名字 / 同名多份 ────────────────────────────────────
  await check('flow_start 按名字启动（精确匹配）', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const result = record(await byName(tools, 'flow_start').execute({ flowName: '备用流程' }, makeExec()))
    A.equal(result.ok, true)
    A.equal(result.flowId, 'flow-alt')
    A.equal(engine.calls.start.length, 1)
  })

  await check('flow_start 按名字启动（不区分大小写兜底）', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    // 模板名是中文，这里另存一份英文名的流程验证大小写兜底。
    await store.saveFlow(flowsRoot, 'flow-case', makeFlow('flow-case', 'CaseFlow'))
    const result = record(await byName(tools, 'flow_start').execute({ flowName: 'caseflow' }, makeExec()))
    A.equal(result.ok, true)
    A.equal(result.flowId, 'flow-case')
  })

  await check('flow_start 同名多份 → 失败并列出候选 id，不调 engine.start', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const result = record(await byName(tools, 'flow_start').execute({ flowName: '重名流程' }, makeExec()))
    A.equal(result.ok, false)
    A.ok(result.hint)
    A.ok(Array.isArray(result.candidates))
    A.deepEqual(result.candidates.slice().sort(), ['flow-dup-a', 'flow-dup-b'])
    A.match(result.error, /同名/)
    A.equal(engine.calls.start.length, 0)
  })

  // ── 4. 流程不存在 / 不合法 ─────────────────────────────────────────────
  await check('flow_start 流程不存在 → {ok:false, hint}，不调 engine.start', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const start = byName(tools, 'flow_start')

    const missing = record(await start.execute({ flowId: 'no-such-flow' }, makeExec()))
    A.equal(missing.ok, false)
    A.match(missing.error, /流程不存在/)
    A.ok(missing.hint)
    A.equal(missing.retryable, false)

    const noArgs = record(await start.execute({}, makeExec()))
    A.equal(noArgs.ok, false)
    A.match(noArgs.hint, /flow_list/)

    const badName = record(await start.execute({ flowName: '根本不存在的名字' }, makeExec()))
    A.equal(badName.ok, false)
    A.ok(badName.hint)

    A.equal(engine.calls.start.length, 0)
  })

  await check('flow_start 流程不合法 → 失败且不建 run（结构性错误前移）', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const before = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    const result = record(await byName(tools, 'flow_start').execute({ flowId: 'flow-bad' }, makeExec()))
    A.equal(result.ok, false)
    A.match(result.error, /不合法/)
    A.equal(engine.calls.start.length, 0)
    const after = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    A.equal(after, before)
  })

  // ── 5. engine.start 抛 409 ─────────────────────────────────────────────
  await check('flow_start engine.start 抛 409 → 失败带可读原因与 hint', async () => {
    const conflict = new Error('已有运行中的 run（r-abc），同一时刻只允许一个 run')
    conflict.status = 409
    const engine = makeEngine({ startError: conflict })
    const tools = makeTools({ engine })
    const result = record(await byName(tools, 'flow_start').execute({ flowId: 'flow-main' }, makeExec()))
    A.equal(result.ok, false)
    A.match(result.error, /已有运行中的 run/)
    A.match(result.hint, /409|flow_stop/)
    A.equal(result.retryable, false)
    A.equal(engine.calls.start.length, 1)
    // 建出来的 run 还在（pending），runId 一并带回，模型知道去看一眼。
    A.ok(typeof result.runId === 'string' && result.runId.length > 0)
  })

  await check('flow_start 不再因「已有 run 在跑」提前失败（07 §5 并发不设上限）', async () => {
    // 旧口径是 engine.active 全局唯一；07 §5 起不同 run 一律并行，engine.active 不再参与判断。
    const engine = makeEngine({ active: { runId: 'r-active' } })
    const tools = makeTools({ engine })
    const result = record(await byName(tools, 'flow_start').execute({ flowId: 'flow-main' }, makeExec()))
    A.equal(result.ok, true, '已有 run 在跑时仍允许再开一个（不同 runId 并行）')
    A.equal(engine.calls.start.length, 1)
  })

  await check('flow_start 唯一冲突：runtime.get(runId) 显示同一 run 已在跑 → 友好失败、不调 engine.start', async () => {
    const engine = makeEngine({ get: runId => ({ runId }) })
    const tools = makeTools({ engine })
    const before = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    const result = record(await byName(tools, 'flow_start').execute({ flowId: 'flow-main' }, makeExec()))
    A.equal(result.ok, false)
    A.match(result.error, /同一 run 已在运行|已在运行/)
    A.ok(result.hint)
    A.equal(result.retryable, false)
    A.equal(engine.calls.start.length, 0, '冲突必须在 engine.start 之前挡下')
    const after = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    A.equal(after, before + 1, 'run 目录被建出来（runId 与冲突 run 相同），但没有启动')
  })

  // ── 6. supervision ─────────────────────────────────────────────────────
  await check('flow_start 的 supervision：正数间隔 + 含 runId / flow_watch / proactive_reclaim 的闹钟提示词', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const result = record(await byName(tools, 'flow_start').execute({ flowId: 'flow-main' }, makeExec('session-sup')))
    A.equal(result.ok, true)
    A.equal(result.supervision.watchTool, 'flow_watch')
    A.ok(Number.isInteger(result.supervision.nextCheckSeconds))
    A.ok(result.supervision.nextCheckSeconds > 0)
    A.equal(result.supervision.nextCheckSeconds, DEFAULT_WATCH_SECONDS)
    A.ok(Array.from(result.supervision.alarmPrompt).length >= 40)
    A.ok(result.supervision.alarmPrompt.includes(result.runId))
    A.match(result.supervision.alarmPrompt, /flow_watch/)
    A.match(result.supervision.alarmPrompt, /proactive_reclaim/)
    A.match(result.supervision.alarmPrompt, /proactive|安静结束|通知主人/)
    A.match(result.supervision.hint, /proactive_set/)
    A.match(result.supervision.hint, /flow_watch/)
    A.match(result.supervision.hint, new RegExp(String(result.supervision.nextCheckSeconds)))
    // 假引擎没有 enableSupervision → 内建调度没开，退回手动闹钟（提示语保留 proactive_set 说明）。
    A.equal(result.supervision.enabled, false)
  })

  await check('flow_start 自动开启内建 supervision：登记 wakerSessionId、返回体提示不再要求 proactive_set', async () => {
    const registrations = []
    const engine = makeEngine({
      enableSupervision: async (runId, options) => {
        registrations.push({ runId, options })
        return {
          runId,
          enabled: true,
          supervision: { enabled: true, wakerSessionId: options.wakerSessionId },
          scheduler: { enabled: true, nextDueAt: null, wakes: 0, failures: 0, lastReason: null },
        }
      },
    })
    const tools = makeTools({ engine })
    const exec = makeExec('session-auto-sup')
    const result = record(await byName(tools, 'flow_start').execute({ flowId: 'flow-main' }, exec))

    A.equal(result.ok, true)
    A.equal(registrations.length, 1, 'start 成功后必须自动登记监督')
    A.equal(registrations[0].runId, result.runId)
    A.deepEqual(registrations[0].options, { enabled: true, wakerSessionId: 'session-auto-sup' })
    A.equal(result.supervision.enabled, true)
    A.equal(result.supervision.scheduler.enabled, true)
    // 提示语：内置调度已开启，不再要求挂 proactive_set 闹钟；字段仍向后兼容保留。
    A.match(result.supervision.hint, /内置 supervision/)
    A.match(result.supervision.hint, /不需要再挂 proactive_set/)
    A.equal(result.supervision.hint.includes('挂上 supervision.alarmPrompt'), false)
    A.ok(Number.isInteger(result.supervision.nextCheckSeconds))
    A.ok(typeof result.supervision.alarmPrompt === 'string' && result.supervision.alarmPrompt.includes(result.runId))
    A.equal(result.supervision.watchTool, 'flow_watch')
  })

  await check('flow_start 自动开启失败只 warn，不让启动失败', async () => {
    const warnings = []
    const engine = makeEngine({
      enableSupervision: async () => { throw new Error('调度器坏了（测试）') },
    })
    const tools = createFlowTools({
      flowsRoot, runsRoot, engine, log: (level, message) => warnings.push({ level, message }),
    })
    const result = record(await byName(tools, 'flow_start').execute({ flowId: 'flow-main' }, makeExec('session-warn')))
    A.equal(result.ok, true, '监督登记失败不能拖垮 flow_start')
    A.equal(result.status, 'running')
    A.equal(result.supervision.enabled, false)
    A.equal(warnings.some(item => item.level === 'warn' && /supervision/.test(item.message)), true)
    // 退回手动闹钟的提示语。
    A.match(result.supervision.hint, /proactive_set/)
  })

  await check('flow_start 开跑前拦非法 executor（custom 缺 executorCommand），不建 run', async () => {
    await store.saveFlow(flowsRoot, 'flow-bad-executor', {
      schemaVersion: 1,
      id: 'flow-bad-executor',
      name: '非法 executor',
      description: '',
      createdAt: FIXED_TS,
      updatedAt: FIXED_TS,
      nodes: [
        nodeBase('n_start', 'start', '任务输入'),
        { ...nodeBase('n_a', 'stage', '外部执行'), executor: 'custom', executorCommand: '' },
        nodeBase('n_end', 'end', '完成'),
      ],
      edges: [
        { id: 'e1', from: 'n_start', to: 'n_a', kind: 'next', label: '' },
        { id: 'e2', from: 'n_a', to: 'n_end', kind: 'next', label: '' },
      ],
    })
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const before = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    const result = record(await byName(tools, 'flow_start').execute({ flowId: 'flow-bad-executor' }, makeExec()))
    A.equal(result.ok, false)
    A.match(result.error, /executor/i)
    A.match(result.error, /executorCommand/)
    A.equal(engine.calls.start.length, 0)
    const after = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    A.equal(after, before, '非法 executor 不建 run')
  })

  // ── 6.5 workspace / worktree 透传（07 §4.1） ───────────────────────────
  await check('flow_start 默认 workspace 取调用方会话 cwd，options 原样交给 engine.start', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const exec = makeExec('session-ws')
    const result = record(await byName(tools, 'flow_start').execute({ flowId: 'flow-main' }, exec))
    A.equal(result.ok, true)
    A.equal(engine.calls.start.length, 1)
    const options = engine.calls.start[0].options
    A.equal(options.parent, exec.agent)
    A.equal(options.workspace, '/workspace/inherited', '默认取 exec.agent.session.header.cwd')
    A.equal(Object.hasOwn(options, 'worktree'), false, '没传 worktree 就不带该键（交给 engine 按 auto 裁决）')
    A.equal(result.workspace.path, '/workspace/inherited')
    A.equal(result.workspace.worktree, 'auto')
    A.equal(result.workspace.worktreeEnabled, null)

    // F2：取不到 cwd 时**不再**把 workspace 交给 engine 回落（那会落到 process.cwd()），
    // 必须在建 run / 调 engine.start 之前失败，并给可操作原因。
    const noCwdExec = { agent: { session: { id: 'session-no-cwd', header: {} } } }
    const noCwd = record(await byName(tools, 'flow_start').execute({ flowId: 'flow-main' }, noCwdExec))
    A.equal(noCwd.ok, false, '拿不到 workspace 必须失败，不能悄悄落到进程 cwd')
    A.match(noCwd.error, /workspace/)
    A.match(noCwd.hint, /workspace/)
    A.match(noCwd.hint, /绝对路径|cwd/)
    A.equal(noCwd.retryable, false)
    A.equal(engine.calls.start.length, 1, '缺 workspace 不能进 engine.start')
  })

  await check('F2：flow_start 显式 workspace 必须是绝对路径（相对路径在建 run 前失败）', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const before = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    const result = record(await byName(tools, 'flow_start').execute(
      { flowId: 'flow-main', workspace: 'relative/path' },
      makeExec('session-rel'),
    ))
    A.equal(result.ok, false)
    A.match(result.error, /绝对路径/)
    A.ok(result.hint)
    A.equal(result.retryable, false)
    A.equal(engine.calls.start.length, 0, '非法 workspace 不能进 engine.start')
    const after = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    A.equal(after, before, '非法 workspace 不建 run')
  })

  await check('flow_start 显式 workspace / worktree 原样透传；非法 worktree → 失败且不建 run', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const exec = makeExec('session-ws2')
    const result = record(await byName(tools, 'flow_start').execute(
      { flowId: 'flow-main', workspace: '/repo/explicit', worktree: 'off' },
      exec,
    ))
    A.equal(result.ok, true)
    const options = engine.calls.start[0].options
    A.equal(options.parent, exec.agent)
    A.equal(options.workspace, '/repo/explicit')
    A.equal(options.worktree, 'off')
    A.equal(result.workspace.worktree, 'off')
    A.equal(result.workspace.path, '/repo/explicit')

    // 非法枚举：参数错误，一条 run 都不建。
    const before = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    const bad = record(await byName(tools, 'flow_start').execute(
      { flowId: 'flow-main', worktree: 'always' },
      makeExec('session-ws3'),
    ))
    A.equal(bad.ok, false)
    A.match(bad.error, /worktree/)
    A.equal(engine.calls.start.length, 1, '非法参数不能进 engine.start')
    const after = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    A.equal(after, before)
  })

  // ── 6.6 flow_supervise（07 §7 内建调度开关） ───────────────────────────
  await check('flow_supervise 存在、参数校验正确', async () => {
    const tools = makeTools()
    const supervise = byName(tools, 'flow_supervise')
    A.ok(supervise, 'flow_supervise 必须注册')
    A.deepEqual(supervise.parameters.required, ['runId', 'enabled'])
    A.equal(supervise.parameters.properties.runId.type, 'string')
    A.equal(supervise.parameters.properties.enabled.type, 'boolean')
    A.ok(supervise.output && supervise.output.schema && typeof supervise.output.render === 'function')

    // 参数校验：缺 runId / runId 非法 / enabled 缺失或不是布尔。
    const cases = [
      {},
      { runId: 'r-x' },
      { runId: 'r-x', enabled: 'yes' },
      { runId: '../etc/passwd', enabled: true },
    ]
    for (const args of cases) {
      const failed = record(await supervise.execute(args, makeExec()))
      A.equal(failed.ok, false, JSON.stringify(args))
      A.ok(failed.hint, JSON.stringify(args))
      A.equal(failed.retryable, false)
    }

    // 没有 runtime 门面（假引擎没有 supervision）→ 明确失败，不崩。
    const unavailable = record(await supervise.execute({ runId: 'r-x', enabled: true }, makeExec()))
    A.equal(unavailable.ok, false)
    A.match(unavailable.error, /supervision/)
  })

  await check('flow_supervise enable / disable：登记摘除 + run.json.supervision 落盘', async () => {
    const run = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: '开关调度', nodeTotal: 1, engine: 'real',
    })
    const registrations = []
    const supervision = {
      register(runId, options) {
        registrations.push({ kind: 'register', runId, options })
        return { enabled: true, nextDueAt: null, wakes: 0, failures: 0, lastReason: null }
      },
      unregister(runId) {
        registrations.push({ kind: 'unregister', runId })
        return true
      },
      status() {
        return { enabled: true, nextDueAt: null, wakes: 0, failures: 0, lastReason: null }
      },
    }
    const engine = makeEngine({ supervision })
    const tools = makeTools({ engine })
    const supervise = byName(tools, 'flow_supervise')
    const runPath = join(runsRoot, run.id, 'run.json')

    const enabled = record(await supervise.execute({ runId: run.id, enabled: true }, makeExec('session-waker')))
    A.equal(enabled.ok, true)
    A.equal(enabled.enabled, true)
    A.equal(enabled.supervision.enabled, true)
    A.equal(enabled.supervision.wakerSessionId, 'session-waker')
    A.deepEqual(registrations[0], {
      kind: 'register',
      runId: run.id,
      options: { wakerSessionId: 'session-waker' },
    })
    const rawEnabled = JSON.parse(readFileSync(runPath, 'utf8'))
    A.equal(rawEnabled.supervision.enabled, true)
    A.equal(rawEnabled.supervision.wakerSessionId, 'session-waker')
    // 只合并 supervision：run.json 的既有字段一个都不能丢。
    A.equal(rawEnabled.id, run.id)
    A.equal(rawEnabled.flowId, 'flow-main')

    const disabled = record(await supervise.execute({ runId: run.id, enabled: false }, makeExec('session-waker')))
    A.equal(disabled.ok, true)
    A.equal(disabled.enabled, false)
    A.equal(disabled.supervision.enabled, false)
    A.equal(disabled.supervision.reason, 'disabled-by-caller')
    A.deepEqual(registrations[1], { kind: 'unregister', runId: run.id })
    const rawDisabled = JSON.parse(readFileSync(runPath, 'utf8'))
    A.equal(rawDisabled.supervision.enabled, false)

    // 有 enableSupervision（runtime 门面）时走**共用实现**，工具不再自己碰 scheduler。
    const sharedCalls = []
    const sharedEngine = makeEngine({
      enableSupervision: async (runId, options) => {
        sharedCalls.push({ runId, options })
        return {
          runId,
          enabled: options.enabled,
          supervision: { enabled: options.enabled, reason: options.enabled ? null : 'disabled-by-caller' },
          scheduler: { enabled: options.enabled, nextDueAt: null, wakes: 0, failures: 0, lastReason: null },
        }
      },
    })
    const sharedTool = byName(makeTools({ engine: sharedEngine }), 'flow_supervise')
    const sharedOff = record(await sharedTool.execute({ runId: run.id, enabled: false }, makeExec('session-waker')))
    A.equal(sharedOff.ok, true)
    A.deepEqual(sharedCalls, [{ runId: run.id, options: { enabled: false } }])
    A.equal(sharedOff.supervision.enabled, false)
    const sharedOn = record(await sharedTool.execute({ runId: run.id, enabled: true }, makeExec('session-waker')))
    A.equal(sharedOn.ok, true)
    A.deepEqual(sharedCalls[1], { runId: run.id, options: { enabled: true, wakerSessionId: 'session-waker' } })

    // flow_watch 的 supervision.scheduler 是只读快照。
    const watchAudit = async () => ({ verdict: 'healthy', status: 'running', headline: 'ok', nextCheckSeconds: 120 })
    const watch = byName(makeTools({ engine: makeEngine(), auditWorkflow: watchAudit }), 'flow_watch')
    const watched = record(await watch.execute({ runId: run.id }, makeExec()))
    A.equal(watched.ok, true)
    A.equal(watched.supervision.scheduler.enabled, false)

    // 已收尾的 run 不能开启（07 §7：planWake 的 terminal 分支永远不会唤醒它）。
    // supervision 已进 runstore 白名单：writeRunMeta 局部合并不再丢它。
    await runstore.writeRunMeta(runsRoot, run.id, {
      status: 'done', started: true, endedAt: new Date().toISOString(),
    })
    const terminal = record(await supervise.execute({ runId: run.id, enabled: true }, makeExec('session-waker')))
    A.equal(terminal.ok, false)
    A.match(terminal.error, /已结束/)
    A.equal(terminal.retryable, false)
    // 被拒绝的开启不能留下 supervision 字段 / 不能新增登记。
    const rawTerminal = JSON.parse(readFileSync(runPath, 'utf8'))
    A.equal(rawTerminal.supervision.enabled, false)
    A.equal(registrations.length, 2, '被拒绝的开启不调 register')
  })

  // ── 7. flow_watch（stub 审计） ─────────────────────────────────────────
  const auditCalls = []
  let auditResult = {
    verdict: 'done',
    status: 'done',
    headline: '全部阶段通过，流程已结束',
    progress: { passed: 1, total: 1, ratio: 1 },
    plan: [],
    currentNode: null,
    rejects: { total: 0, byEdge: {} },
    anomalies: [],
    quality: { passed: 1 },
    tokens: { input: 10, output: 20 },
    idleMs: 0,
    recommended: [],
    nextCheckSeconds: 30,
    // 故意混入不可序列化的值：验证工具出口做了 lossless 收口。
    extraDate: new Date('2026-11-06T00:00:09.000Z'),
    omitted: undefined,
    nan: Number.NaN,
  }
  const stubAudit = async input => {
    auditCalls.push(input)
    return auditResult
  }

  await check('flow_watch 调审计（stub）并原样返回；verdict=done 时 nextCheckSeconds=null', async () => {
    const engine = makeEngine()
    const tools = makeTools({
      engine,
      auditWorkflow: stubAudit,
      now: () => new Date('2026-11-06T00:10:00.000Z'),
    })
    const watch = byName(tools, 'flow_watch')

    const started = await byName(tools, 'flow_start').execute({ flowId: 'flow-main' }, makeExec('session-watch'))
    A.equal(started.ok, true)

    const result = record(await watch.execute({ runId: started.runId }, makeExec()))
    A.equal(result.ok, true)
    A.equal(result.runId, started.runId)
    A.equal(result.flowId, 'flow-main')
    A.equal(result.verdict, 'done')
    A.equal(result.headline, '全部阶段通过，流程已结束')
    A.deepEqual(result.progress, { passed: 1, total: 1, ratio: 1 })
    A.deepEqual(result.anomalies, [])
    A.equal(result.supervision.nextCheckSeconds, null)
    A.equal(result.supervision.watchTool, 'flow_watch')
    A.match(result.supervision.alarmPrompt, /不必再挂/)
    A.match(result.supervision.alarmPrompt, new RegExp(started.runId))

    // 审计入参：真实 flow / events / run + 三个阈值 + now。
    A.equal(auditCalls.length, 1)
    const input = auditCalls[0]
    A.equal(input.flow.id, 'flow-main')
    A.ok(Array.isArray(input.events))
    A.equal(input.run.id, started.runId)
    A.ok(input.now instanceof Date)
    A.ok(Number.isInteger(input.stallMs) && input.stallMs > 0)
    A.ok(Number.isInteger(input.nodeTimeoutMs) && input.nodeTimeoutMs > 0)
    A.ok(Number.isInteger(input.maxRejectsPerEdge) && input.maxRejectsPerEdge > 0)

    // lossless 收口：Date → ISO、NaN → null、undefined 键消失。
    A.equal(result.extraDate, '2026-11-06T00:00:09.000Z')
    A.equal(result.nan, null)
    A.ok(!Object.hasOwn(result, 'omitted'))
  })

  await check('flow_watch 运行中：supervision 用审计给的间隔并给出完整闹钟提示词', async () => {
    auditResult = {
      verdict: 'healthy',
      status: 'running',
      headline: '正在节点 n_a 执行',
      progress: { passed: 0, total: 1, ratio: 0 },
      plan: [{ nodeId: 'n_a' }],
      currentNode: { nodeId: 'n_a', title: '阶段 A' },
      rejects: { total: 0 },
      anomalies: [],
      quality: { passed: 0 },
      tokens: { input: 5, output: 6 },
      idleMs: 1234,
      recommended: ['继续等待'],
      nextCheckSeconds: 120,
    }
    const engine = makeEngine()
    const tools = makeTools({ engine, auditWorkflow: stubAudit })
    const started = await byName(tools, 'flow_start').execute({ flowId: 'flow-main' }, makeExec())
    const result = record(await byName(tools, 'flow_watch').execute({ runId: started.runId }, makeExec()))
    A.equal(result.ok, true)
    A.equal(result.verdict, 'healthy')
    A.equal(result.supervision.nextCheckSeconds, 120)
    A.match(result.supervision.alarmPrompt, /proactive_reclaim/)
    A.match(result.supervision.alarmPrompt, /flow_watch/)
    A.ok(result.supervision.alarmPrompt.includes(started.runId))
  })

  // ── 8. flow_watch · 节点自审状态（v0.8 §11.4） ──────────────────────────
  await check('flow_watch 返回 nodeStatus；blocked 且连续两次 progress 不变 → recommended 提示', async () => {
    const run = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: '节点自审状态', nodeTotal: 2, engine: 'real',
    })
    const startedAt = '2026-11-06T00:00:00.000Z'
    await runstore.writeRunMeta(runsRoot, run.id, {
      status: 'running',
      started: true,
      startedAt,
      nodeStatus: {
        // n_a：连续两次 progress 都是 40 → 报「blocked 且无进展」。
        n_a: { state: 'blocked', progress: 40, summary: '等接口', verdict: null, members: [], blockers: ['等接口'], at: startedAt },
        // n_b：30 → 40 有进展，不该报。
        n_b: { state: 'blocked', progress: 40, summary: '在推进', verdict: null, members: [], blockers: [], at: startedAt },
      },
    })
    // 事件历史走真实 appendEvents（node/status 已在 runlog 白名单里）。
    // n_a 连续两次 progress=40；n_b 30→40（有进展）。
    const statusEvent = (nodeId, progress) => ({
      v: 1,
      ts: startedAt,
      kind: 'node/status',
      nodeId,
      attemptId: 1,
      traceId: `run:${run.id}`,
      data: { nodeId, attempt: 1, state: 'blocked', progress, summary: '…', members: [], blockers: [], verdict: null },
    })
    await runstore.appendEvents(runsRoot, run.id, [
      statusEvent('n_a', 40),
      statusEvent('n_a', 40),
      statusEvent('n_b', 30),
      statusEvent('n_b', 40),
    ])

    auditResult = {
      verdict: 'stalled',
      status: 'running',
      headline: '节点停滞',
      progress: { passed: 0, total: 2, ratio: 0 },
      plan: [],
      currentNode: { nodeId: 'n_a', title: '阶段 A' },
      rejects: { total: 0 },
      anomalies: [],
      quality: {},
      tokens: {},
      idleMs: 60_000,
      recommended: ['先看日志'],
      nextCheckSeconds: 60,
    }
    const tools = makeTools({ engine: makeEngine(), auditWorkflow: stubAudit })
    const result = record(await byName(tools, 'flow_watch').execute({ runId: run.id }, makeExec()))
    A.equal(result.ok, true)
    A.equal(result.nodeStatus.n_a.state, 'blocked')
    A.equal(result.nodeStatus.n_a.progress, 40)
    A.equal(result.nodeStatus.n_a.summary, '等接口')
    A.ok(Array.isArray(result.recommended), 'recommended 原类型（数组）要保留')
    A.ok(result.recommended.includes('先看日志'), '审计原有建议不能丢')
    A.ok(result.recommended.some(item => /节点 n_a 报告 blocked 且无进展，建议先看它卡在哪/.test(item)))
    A.ok(!result.recommended.some(item => /节点 n_b 报告 blocked/.test(item)), '有进展的节点不该报')
  })

  // ── 9. flow_watch 省略 runId 取最近一次 ────────────────────────────────
  await check('flow_watch 省略 runId → 取最近一次 run（按 startedAt 倒序）', async () => {
    const older = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: '旧 run', nodeTotal: 1, engine: 'real',
    })
    await runstore.writeRunMeta(runsRoot, older.id, { startedAt: '2099-01-01T00:00:01.000Z' })
    const newer = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: '新 run', nodeTotal: 1, engine: 'real',
    })
    await runstore.writeRunMeta(runsRoot, newer.id, { startedAt: '2099-01-01T00:00:02.000Z' })

    auditResult = {
      verdict: 'healthy',
      status: 'running',
      headline: '最近一次 run 正在跑',
      progress: { passed: 0, total: 1, ratio: 0 },
      plan: [],
      currentNode: null,
      rejects: { total: 0 },
      anomalies: [],
      quality: {},
      tokens: {},
      idleMs: 10,
      recommended: [],
      nextCheckSeconds: 90,
    }
    const callsBefore = auditCalls.length
    const tools = makeTools({ engine: makeEngine(), auditWorkflow: stubAudit })
    const result = record(await byName(tools, 'flow_watch').execute({}, makeExec()))
    A.equal(result.ok, true)
    A.equal(result.runId, newer.id)
    A.equal(auditCalls.length, callsBefore + 1)
    A.equal(auditCalls[auditCalls.length - 1].run.id, newer.id)
  })

  await check('flow_watch 真实 import src/audit.js（无注入）→ 结果可被 schema 接受并附 supervision', async () => {
    // 联调：不注入 stub，走 tools.js → 动态 import('./audit.js') 的真实路径。
    // 造一个 running 的 run + 一条 node/start，审计应给出非终态结论与正数间隔。
    const run = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: '真实审计联调', nodeTotal: 1, engine: 'real',
    })
    const startedAt = new Date().toISOString()
    await runstore.writeRunMeta(runsRoot, run.id, { status: 'running', started: true, startedAt })
    await runstore.appendEvents(runsRoot, run.id, [
      { v: 1, kind: 'run/start', traceId: `run:${run.id}`, data: { flowId: 'flow-main', flowName: '主流程', nodeTotal: 1, engine: 'real' } },
      {
        v: 1,
        kind: 'node/start',
        nodeId: 'n_a',
        attemptId: 1,
        traceId: `run:${run.id}`,
        ts: new Date().toISOString(),
        data: { title: '阶段 A', mode: 'single', skills: [] },
      },
    ])

    const tools = makeTools({ engine: makeEngine() })
    const result = record(await byName(tools, 'flow_watch').execute({ runId: run.id }, makeExec()))
    A.equal(result.ok, true)
    A.equal(result.runId, run.id)
    A.equal(typeof result.verdict, 'string')
    A.ok(result.verdict.length > 0)
    A.ok(Object.hasOwn(result, 'plan'))
    A.ok(Object.hasOwn(result, 'recommended'))
    A.equal(result.supervision.watchTool, 'flow_watch')
    A.ok(result.supervision.alarmPrompt.includes(run.id))
    if (['done', 'failed', 'aborted'].includes(result.verdict)) {
      A.equal(result.supervision.nextCheckSeconds, null)
    } else {
      A.ok(Number.isInteger(result.supervision.nextCheckSeconds))
      A.ok(result.supervision.nextCheckSeconds > 0)
    }
  })

  // ── 9.5 flow_watch：调度器实时快照（timeout / 停摆 / invalid 回报要可见） ──
  function healthyAudit(extra = {}) {
    return {
      verdict: 'healthy',
      status: 'running',
      headline: '正在跑',
      progress: { passed: 0, total: 1, ratio: 0 },
      plan: [],
      currentNode: null,
      rejects: { total: 0 },
      anomalies: [],
      quality: {},
      tokens: {},
      idleMs: 10,
      recommended: [],
      nextCheckSeconds: 120,
      ...extra,
    }
  }

  await check('flow_watch：run 级 / 节点级调度器快照原样透传（status 字段保持不变）', async () => {
    auditResult = healthyAudit()
    const run = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: '调度器快照正常', nodeTotal: 1, engine: 'real',
    })
    const engine = makeEngine()
    const statusCalls = []
    engine.supervision = {
      status(runId) {
        statusCalls.push(runId)
        return { enabled: true, wakes: 2, nextDueAt: null }
      },
      snapshot() {
        return {
          kind: 'run',
          ticking: false,
          started: true,
          intervalMs: 15000,
          wakeTimeoutMs: 20000,
          concurrency: { limit: 4, active: 0 },
          tick: { count: 3, skipped: 0, lastDurationMs: 42, lastStats: { runs: 1, woken: 0, failed: 0 } },
          entries: [{
            runId: run.id,
            lastOutcome: 'healthy',
            lastDurationMs: 55,
            lastFinishedAt: '2026-11-06T00:00:05.000Z',
            timeouts: 0,
            lastError: null,
          }],
        }
      },
    }
    engine.nodeSupervision = {
      snapshot() {
        return {
          kind: 'node',
          ticking: false,
          started: true,
          wakeTimeoutMs: 30000,
          tick: { count: 2, skipped: 0, lastDurationMs: 7, lastStats: null },
          entries: [{
            sessionId: 'sess-1',
            runId: run.id,
            nodeId: 'n_a',
            lastOutcome: 'reported',
            lastDurationMs: 9,
            timeouts: 0,
            lastError: null,
            lastReport: { kind: 'valid', reason: null, at: '2026-11-06T00:00:06.000Z' },
          }],
        }
      },
    }
    const tools = makeTools({ engine, auditWorkflow: stubAudit })
    const result = record(await byName(tools, 'flow_watch').execute({ runId: run.id }, makeExec()))

    A.equal(result.ok, true)
    A.equal(result.supervision.schedulerSnapshot.available, true)
    A.equal(result.supervision.schedulerSnapshot.snapshot.kind, 'run')
    A.equal(result.supervision.schedulerSnapshot.snapshot.tick.lastDurationMs, 42)
    A.equal(result.supervision.schedulerSnapshot.snapshot.entries[0].lastOutcome, 'healthy')
    A.equal(result.supervision.nodeSchedulerSnapshot.available, true)
    A.equal(result.supervision.nodeSchedulerSnapshot.snapshot.kind, 'node')
    A.equal(result.supervision.nodeSchedulerSnapshot.snapshot.entries[0].lastReport.kind, 'valid')
    // 旧字段：run.json.supervision 的只读快照（这里为 null）与 status 契约都不变。
    A.ok(Object.hasOwn(result.supervision, 'scheduler'))
    // 旧字段不变；G7-a / G7-b 追加的计数缺省为 0 / null（只加不改）。
    A.deepEqual(result.supervision.health, {
      timeouts: 0,
      invalidReports: 0,
      wokenThisHour: 0,
      throttled: 0,
      coalesced: 0,
      recovery: null,
      warnings: [],
    })
    A.equal(statusCalls.length, 0, '快照读取不走 status()（status 契约保持不变）')
  })

  await check('flow_watch：调度器缺 snapshot() / 没有调度器时标注「不可用」且不抛错', async () => {
    auditResult = healthyAudit({ verdict: 'healthy', headline: '老引擎' })
    const run = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: '调度器快照缺失', nodeTotal: 1, engine: 'real',
    })
    const engine = makeEngine()
    // 老版本只暴露 status()，没有 snapshot()；节点级调度器干脆不存在。
    engine.supervision = { status: () => ({ enabled: true, wakes: 0 }) }
    const tools = makeTools({ engine, auditWorkflow: stubAudit })
    const result = record(await byName(tools, 'flow_watch').execute({ runId: run.id }, makeExec()))

    A.equal(result.ok, true, '缺 snapshot() 不能让 flow_watch 失败')
    A.equal(result.supervision.schedulerSnapshot.available, false)
    A.equal(typeof result.supervision.schedulerSnapshot.reason, 'string')
    A.match(result.supervision.schedulerSnapshot.reason, /snapshot/)
    A.equal(result.supervision.nodeSchedulerSnapshot.available, false)
    A.match(result.supervision.nodeSchedulerSnapshot.reason, /节点级|没有暴露/)
    A.deepEqual(result.supervision.health.warnings, [])
    // 人类可读结论里也要明确写「不可用」，不能静默空对象。
    const rendered = byName(tools, 'flow_watch').output.render({}, result)
    A.match(rendered[0].text, /调度器快照：run 级不可用/)
    A.match(rendered[0].text, /调度器快照：节点级不可用/)
  })

  await check('flow_watch：timeout / 整轮 tick 停摆 / invalid 回报 → 可读结论与 recommended 都能看出', async () => {
    auditResult = healthyAudit({ verdict: 'stalled', headline: '疑似卡住' })
    const run = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: '调度器超时', nodeTotal: 1, engine: 'real',
    })
    const engine = makeEngine()
    engine.supervision = {
      snapshot: () => ({
        kind: 'run',
        ticking: true,
        started: true,
        intervalMs: 15000,
        wakeTimeoutMs: 1000,
        concurrency: { limit: 4, active: 1 },
        tick: { count: 9, skipped: 2, lastDurationMs: 5000, lastStats: { runs: 1, woken: 1, failed: 1 } },
        entries: [{
          runId: run.id,
          lastOutcome: 'timeout',
          lastDurationMs: 1000,
          lastFinishedAt: '2026-11-06T00:00:09.000Z',
          timeouts: 2,
          lastError: '唤醒超时（1000ms）',
        }],
      }),
    }
    engine.nodeSupervision = {
      snapshot: () => ({
        kind: 'node',
        ticking: true,
        started: true,
        wakeTimeoutMs: 30000,
        tick: { count: 4, skipped: 0, lastDurationMs: 10, lastStats: null },
        entries: [{
          sessionId: 'sess-1',
          runId: run.id,
          nodeId: 'n_a',
          lastOutcome: 'reported',
          timeouts: 0,
          lastError: null,
          lastReport: { kind: 'invalid', reason: '结构化输出不是 JSON', at: '2026-11-06T00:00:08.000Z' },
        }],
      }),
    }
    const tools = makeTools({ engine, auditWorkflow: stubAudit })
    const result = record(await byName(tools, 'flow_watch').execute({ runId: run.id }, makeExec()))

    A.equal(result.ok, true)
    A.equal(result.supervision.health.timeouts, 2)
    A.equal(result.supervision.health.invalidReports, 1)
    A.ok(result.supervision.health.warnings.length >= 3, '超时 + tick 停摆 + invalid 都要有告警')
    A.ok(result.supervision.health.warnings.some(text => /超时/.test(text)))
    A.ok(result.supervision.health.warnings.some(text => /停摆/.test(text)))
    A.ok(result.supervision.health.warnings.some(text => /不合规/.test(text)))

    // 不只放在原始 JSON 深处：recommended 里要有同样两件事。
    A.ok(Array.isArray(result.recommended), 'recommended 保持原类型（数组）')
    A.ok(result.recommended.some(text => /调度器报告超时/.test(text)))
    A.ok(result.recommended.some(text => /格式不合规/.test(text)))

    // 人类可读结论（render）也要能读出来。
    const rendered = byName(tools, 'flow_watch').output.render({}, result)
    const text = rendered.map(item => item.text).join('\n')
    A.match(text, /调度器健康/)
    A.match(text, /超时/)
    A.match(text, /格式不合规/)
    A.match(text, /停摆/)
  })

  await check('flow_watch：限流 / 合并唤醒 / 恢复扫描——非零可见，全零不刷噪音', async () => {
    auditResult = healthyAudit({ verdict: 'healthy', headline: '正常' })
    const run = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: '调度器限流', nodeTotal: 1, engine: 'real',
    })
    const engine = makeEngine()
    engine.supervision = {
      snapshot: () => ({
        kind: 'run',
        ticking: true,
        started: true,
        intervalMs: 15000,
        wakeTimeoutMs: 1000,
        // G7-a：发起会话唤醒预算 / 合并唤醒（顶层累计计数）。
        wokenThisHour: 3,
        throttled: 2,
        coalesced: 9,
        tick: { count: 3, skipped: 0, lastDurationMs: 10, lastStats: { runs: 1, woken: 1, failed: 0 } },
        entries: [],
      }),
    }
    engine.nodeSupervision = {
      snapshot: () => ({
        kind: 'node',
        ticking: true,
        started: true,
        wakeTimeoutMs: 30000,
        // G7-b：重启恢复扫描统计。
        recovery: {
          at: '2026-11-06T00:00:00.000Z',
          scans: 2,
          runsScanned: 5,
          runsRecovered: 3,
          restored: 2,
          skipped: 1,
          skippedTerminal: 0,
          missingSession: 0,
          missingAttempt: 1,
          alreadyRegistered: 0,
        },
        tick: { count: 2, skipped: 0, lastDurationMs: 10, lastStats: null },
        entries: [],
      }),
    }
    const tools = makeTools({ engine, auditWorkflow: stubAudit })
    const result = record(await byName(tools, 'flow_watch').execute({ runId: run.id }, makeExec()))
    A.equal(result.ok, true)
    // 字段齐全（原 timeouts / invalidReports / warnings 不变）。
    A.equal(result.supervision.health.timeouts, 0)
    A.equal(result.supervision.health.invalidReports, 0)
    A.deepEqual(result.supervision.health.warnings, [])
    A.equal(result.supervision.health.wokenThisHour, 3)
    A.equal(result.supervision.health.throttled, 2)
    A.equal(result.supervision.health.coalesced, 9)
    A.equal(result.supervision.health.recovery.restored, 2)
    A.equal(result.supervision.health.recovery.scans, 2)
    A.equal(result.supervision.health.recovery.missingAttempt, 1)

    // 三件事都进 recommended（机器侧）与人类可读投影。
    A.ok(result.recommended.some(text => /限流 2 次/.test(text)), JSON.stringify(result.recommended))
    A.ok(result.recommended.some(text => /合并 9 个 run/.test(text)))
    A.ok(result.recommended.some(text => /恢复扫描恢复了 2 个 run/.test(text)))
    const rendered = byName(tools, 'flow_watch').output.render({}, result)
    const text = rendered.map(item => item.text).join('\n')
    A.match(text, /发起会话唤醒被限流 2 次/)
    A.match(text, /合并 9 个 run 为一次唤醒/)
    A.match(text, /节点闹钟恢复扫描恢复了 2 个 run/)

    // 全零：字段存在，但可读结论里不出现这三句（健康时不刷噪音）。
    const quiet = makeEngine()
    quiet.supervision = {
      snapshot: () => ({
        kind: 'run',
        ticking: true,
        started: true,
        wakeTimeoutMs: 1000,
        wokenThisHour: 0,
        throttled: 0,
        coalesced: 0,
        tick: { count: 1, skipped: 0, lastDurationMs: 5, lastStats: null },
        entries: [],
      }),
    }
    quiet.nodeSupervision = {
      snapshot: () => ({
        kind: 'node',
        ticking: true,
        started: true,
        wakeTimeoutMs: 30000,
        recovery: {
          at: null,
          scans: 1,
          runsScanned: 2,
          runsRecovered: 0,
          restored: 0,
          skipped: 2,
          skippedTerminal: 1,
          missingSession: 1,
          missingAttempt: 0,
          alreadyRegistered: 0,
        },
        tick: { count: 1, skipped: 0, lastDurationMs: 5, lastStats: null },
        entries: [],
      }),
    }
    const quietTools = makeTools({ engine: quiet, auditWorkflow: stubAudit })
    const quietResult = record(await byName(quietTools, 'flow_watch').execute({ runId: run.id }, makeExec()))
    A.equal(quietResult.supervision.health.throttled, 0)
    A.equal(quietResult.supervision.health.coalesced, 0)
    A.equal(quietResult.supervision.health.recovery.restored, 0)
    const quietText = byName(quietTools, 'flow_watch').output
      .render({}, quietResult).map(item => item.text).join('\n')
    A.equal(/限流/.test(quietText), false, '健康时不出现限流句子')
    A.equal(/合并 .* run/.test(quietText), false, '健康时不出现合并唤醒句子')
    A.equal(/恢复扫描/.test(quietText), false, '健康时不出现恢复扫描句子')
  })

  await check('flow_watch runId 不存在 → {ok:false, hint}', async () => {
    const tools = makeTools({ auditWorkflow: stubAudit })
    const result = record(await byName(tools, 'flow_watch').execute({ runId: 'r-no-such-run' }, makeExec()))
    A.equal(result.ok, false)
    A.match(result.error, /不存在/)
    A.ok(result.hint)
  })

  // ── 9. flow_stop ───────────────────────────────────────────────────────
  await check('flow_stop 成功 → {ok, runId, status}', async () => {
    const engine = makeEngine({ stopResult: runId => ({ id: runId, status: 'aborted' }) })
    const tools = makeTools({ engine })
    const result = record(await byName(tools, 'flow_stop').execute({ runId: 'r-stop-me' }, makeExec()))
    A.equal(result.ok, true)
    A.equal(result.runId, 'r-stop-me')
    A.equal(result.status, 'aborted')
    A.deepEqual(engine.calls.stop, [{ runId: 'r-stop-me' }])
  })

  await check('flow_stop 不在运行中（409）→ 失败且 hint 含「不在运行中」', async () => {
    const conflict = new Error('该 run 不在运行中')
    conflict.status = 409
    const engine = makeEngine({ stopError: conflict })
    const tools = makeTools({ engine })
    const result = record(await byName(tools, 'flow_stop').execute({ runId: 'r-already-done' }, makeExec()))
    A.equal(result.ok, false)
    A.equal(result.retryable, false)
    A.match(result.hint, /不在运行中/)
    A.match(result.error, /不在运行中/)
  })

  await check('flow_stop 缺 runId → 参数失败，不调 engine.stop', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const result = record(await byName(tools, 'flow_stop').execute({}, makeExec()))
    A.equal(result.ok, false)
    A.match(result.error, /runId/)
    A.equal(engine.calls.stop.length, 0)
  })

  // ── 9.5 F1：外部回复通道的安全边界（tokenEnv 白名单 / url 白名单 / 打码） ──
  await check('F1：tokenEnv 只接受 FLOW_STUDIO_REPLY_TOKEN_* 专用前缀（大小写 / 下划线严格）', () => {
    A.equal(REPLY_TOKEN_ENV_PREFIX, 'FLOW_STUDIO_REPLY_TOKEN_')
    A.deepEqual(REPLY_LOOPBACK_HOSTS.slice().sort(), ['127.0.0.1', '::1', 'localhost'].sort())

    const ok = validateReplyTokenEnv('FLOW_STUDIO_REPLY_TOKEN_OPS')
    A.equal(ok.ok, true)
    A.equal(ok.tokenEnv, 'FLOW_STUDIO_REPLY_TOKEN_OPS')
    A.equal(validateReplyTokenEnv(undefined).ok, true, '省略 tokenEnv = 不带令牌，合法')
    A.equal(validateReplyTokenEnv(null).ok, true)

    const rejected = [
      'DSH_HOME', 'FLOW_STUDIO_TOKEN', 'PATH', '',
      'FLOW_STUDIO_REPLY_TOKEN_', 'FLOW_STUDIO_REPLY_TOKEN_A..B',
      'FLOW_STUDIO_REPLY_TOKEN_A/B', 'FLOW_STUDIO_REPLY_TOKEN_A-B',
      'FLOW_STUDIO_REPLY_TOKEN_A B', 'flow_studio_reply_token_x',
      '../FLOW_STUDIO_REPLY_TOKEN_X', 'FLOW_STUDIO_REPLY_TOKEN_X\u0000',
      'FLOW_STUDIO_REPLY_TOKEN_É', 'FLOW_STUDIO_REPLY_TOKEN_中文',
    ]
    for (const name of rejected) {
      const out = validateReplyTokenEnv(name)
      A.equal(out.ok, false, `必须拒绝 ${JSON.stringify(name)}`)
      A.match(out.error, /FLOW_STUDIO_REPLY_TOKEN_/, `错误信息要写出允许的形式（${JSON.stringify(name)}）`)
      A.equal(typeof out.error, 'string')
    }
    A.equal(validateReplyTokenEnv(42).ok, false, '非字符串一律拒绝')
  })

  await check('F1：http 回复地址只允许 https 或回环地址上的 http，且禁止 user:pass@', () => {
    for (const good of [
      'https://example.com/hook',
      'http://127.0.0.1:38217/hook',
      'http://localhost:3000/hook',
      'http://[::1]:8080/hook',
    ]) {
      const out = validateReplyUrl(good)
      A.equal(out.ok, true, good)
      A.equal(typeof out.url, 'string')
    }
    const external = validateReplyUrl('http://example.com/hook')
    A.equal(external.ok, false)
    A.match(external.error, /回环|https/)

    for (const bad of [
      'http://192.168.1.10/hook',
      'http://169.254.169.254/latest/meta-data',
      'ftp://example.com/x',
      'file:///etc/passwd',
      '',
    ]) {
      A.equal(validateReplyUrl(bad).ok, false, bad)
    }
    // 凭据塞进 URL（user:pass@）：http / https 都拒绝，避免令牌/密码落进日志。
    for (const userinfo of [
      'http://user:pass@127.0.0.1:9/hook',
      'https://user:pass@example.com/hook',
      'https://user@example.com/hook',
    ]) {
      const out = validateReplyUrl(userinfo)
      A.equal(out.ok, false, userinfo)
      A.match(out.error, /用户名|密码|user:pass/)
    }
    A.equal(validateReplyUrl(42).ok, false)
  })

  await check('F1：reply 组合校验——合法组合通过，跨组合（外部 http + 任意变量名）被拒', () => {
    const good = validateReplyTargetStrict({
      kind: 'http',
      url: 'http://127.0.0.1:4010/cb',
      tokenEnv: 'FLOW_STUDIO_REPLY_TOKEN_CI',
    })
    A.equal(good.ok, true)
    A.equal(good.reply.kind, 'http')
    A.equal(good.reply.tokenEnv, 'FLOW_STUDIO_REPLY_TOKEN_CI')
    A.equal(good.reply.url, 'http://127.0.0.1:4010/cb')

    const badEnv = validateReplyTargetStrict({
      kind: 'http', url: 'https://example.com/cb', tokenEnv: 'DSH_HOME',
    })
    A.equal(badEnv.ok, false)
    A.match(badEnv.error, /FLOW_STUDIO_REPLY_TOKEN_/)

    const badUrl = validateReplyTargetStrict({
      kind: 'http', url: 'http://example.com/cb', tokenEnv: 'FLOW_STUDIO_REPLY_TOKEN_X',
    })
    A.equal(badUrl.ok, false)
    A.match(badUrl.error, /回环|https/)

    A.equal(validateReplyTargetStrict({ kind: 'none' }).ok, true)
    A.equal(validateReplyTargetStrict({ kind: 'none' }).reply.kind, 'none')
    A.equal(validateReplyTargetStrict({ kind: 'session', sessionId: 's-1' }).ok, true)
    A.equal(validateReplyTargetStrict({ kind: 'session' }).ok, false)
    A.equal(validateReplyTargetStrict({ kind: 'weird' }).ok, false)
    A.equal(validateReplyTargetStrict(undefined).ok, true)
  })

  await check('F1：令牌值打码——maskSecret / redactSecrets 永不吐出完整令牌', () => {
    const token = 'sk-live-super-secret-value-1234'
    const masked = maskSecret(token)
    A.equal(masked.includes(token), false)
    A.ok(masked.startsWith('sk'))
    A.ok(masked.includes('34'), '保留末 2 位')
    A.ok(masked.includes('***'))
    A.ok(masked.includes('长度'))
    A.equal(maskSecret('short').includes('short'), false, '短令牌整段隐藏')
    A.equal(maskSecret(''), '')
    const redacted = redactSecrets(`connect failed for ${token}`, [token])
    A.equal(redacted.includes(token), false)
    A.ok(redacted.includes(maskSecret(token)))
  })

  await check('F1：flow_send_message 拒绝任意 tokenEnv / 外部 http，错误信息不含令牌值', async () => {
    const secret = 'sk-do-not-leak-9876543210'
    process.env.FLOW_STUDIO_TOKEN = secret
    process.env.FLOW_STUDIO_REPLY_TOKEN_DEMO = secret
    try {
      const tools = makeToolsWithInbox()
      const send = byName(tools, 'flow_send_message')
      A.ok(send, '有 agents 服务时必须注册 flow_send_message')

      const badEnv = record(await send.execute({
        text: '注入',
        reply: { kind: 'http', url: 'https://example.com/cb', tokenEnv: 'FLOW_STUDIO_TOKEN' },
      }, makeExec()))
      A.equal(badEnv.ok, false)
      A.match(badEnv.error, /FLOW_STUDIO_REPLY_TOKEN_/)
      A.equal(badEnv.retryable, false)
      A.equal(JSON.stringify(badEnv).includes(secret), false, '返回体里不能出现令牌值')

      const badUrl = record(await send.execute({
        text: '注入',
        reply: { kind: 'http', url: 'http://example.com/cb' },
      }, makeExec()))
      A.equal(badUrl.ok, false)
      A.match(badUrl.error, /回环|https/)
      A.equal(JSON.stringify(badUrl).includes(secret), false)

      // 合法组合要真的走得通：pending run 收下消息（started 输入）并原样保存 reply。
      const run = await runstore.createRun(runsRoot, {
        flowId: 'flow-main', flowName: '主流程', name: 'F1 合法通道', nodeTotal: 1, engine: 'real',
      })
      const good = record(await send.execute({
        runId: run.id,
        text: '走合规通道',
        reply: { kind: 'http', url: 'http://127.0.0.1:9/cb', tokenEnv: 'FLOW_STUDIO_REPLY_TOKEN_DEMO' },
      }, makeExec()))
      A.equal(good.ok, true)
      A.equal(good.runId, run.id)
      A.equal(good.mode, 'started')
      const listed = await runstore.readRunMessages(runsRoot, run.id, { limit: 10 })
      const stored = listed.messages.find(item => item.id === good.messageId)
      A.ok(stored, '消息要落进 messages.jsonl')
      A.equal(stored.reply.tokenEnv, 'FLOW_STUDIO_REPLY_TOKEN_DEMO')
      A.equal(stored.reply.url, 'http://127.0.0.1:9/cb')
      const all = await runstore.readAllEvents(runsRoot, run.id)
      A.equal(JSON.stringify(all.events).includes(secret), false, '事件里不能出现令牌值')
    } finally {
      delete process.env.FLOW_STUDIO_TOKEN
      delete process.env.FLOW_STUDIO_REPLY_TOKEN_DEMO
    }
  })

  await check('F1：flow_reply 拒绝已保存的不合规通道——不发请求、不读令牌、不泄漏', async () => {
    const secret = 'sk-stored-secret-1122334455'
    process.env.FLOW_STUDIO_TOKEN = secret
    // 两个敌意组合都来自旧版本 / HTTP 入口能写进 run.json.inbox.reply 的形状：
    //   ① 外部明文 http（SSRF 到云元数据地址）+ owner 级令牌变量；
    //   ② 合法 https，但 tokenEnv 指向 owner 级令牌（凭据外泄面）。
    const hostileUrlRun = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: 'F1 敌意 url', nodeTotal: 1, engine: 'real',
    })
    await runstore.writeRunInbox(runsRoot, hostileUrlRun.id, {
      kind: 'http', url: 'http://169.254.169.254/latest/meta-data', tokenEnv: 'FLOW_STUDIO_TOKEN',
    })
    const hostileEnvRun = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: 'F1 敌意 tokenEnv', nodeTotal: 1, engine: 'real',
    })
    await runstore.writeRunInbox(runsRoot, hostileEnvRun.id, {
      kind: 'http', url: 'https://example.com/cb', tokenEnv: 'FLOW_STUDIO_TOKEN',
    })
    let owned = hostileUrlRun.id
    const engine = makeEngine()
    engine.resolveSessionOwner = async () => ({ runId: owned, nodeId: 'n_a' })
    const tools = makeToolsWithInbox({ engine })
    const reply = byName(tools, 'flow_reply')
    A.ok(reply, '有 agents 服务时必须注册 flow_reply')

    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (...args) => {
      calls.push(args)
      throw new Error('不合规通道不应该发起请求')
    }
    try {
      // ① 外部明文 http：URL 白名单先拒。
      const urlResult = record(await reply.execute({ text: '回复外部来源' }, makeExec('session-node')))
      A.equal(urlResult.ok, false)
      A.match(urlResult.error, /回复通道不合规/)
      A.match(urlResult.error, /回环|https/)
      A.match(urlResult.hint, /FLOW_STUDIO_REPLY_TOKEN_/)
      A.equal(urlResult.delivery, 'blocked')
      A.equal(JSON.stringify(urlResult).includes(secret), false, '返回体里不能出现令牌值')

      // ② 合法 https + owner 级令牌变量：tokenEnv 白名单拒。
      owned = hostileEnvRun.id
      const envResult = record(await reply.execute({ text: '回复外部来源' }, makeExec('session-node')))
      A.equal(envResult.ok, false)
      A.match(envResult.error, /回复通道不合规/)
      A.match(envResult.error, /FLOW_STUDIO_REPLY_TOKEN_/)
      A.equal(envResult.delivery, 'blocked')
      A.equal(JSON.stringify(envResult).includes(secret), false, '返回体里不能出现令牌值')

      // ③ 消息级 reply（inReplyTo）同样拦截：不能只防 run.json.inbox.reply。
      await runstore.appendRunMessages(runsRoot, hostileEnvRun.id, [{
        v: 1,
        id: 'm-hostile',
        direction: 'in',
        ts: new Date().toISOString(),
        from: 'ext',
        text: '带敌意 reply 的入站消息',
        targetNodeId: 'n_a',
        status: 'pending',
        reply: { kind: 'http', url: 'https://example.com/cb', tokenEnv: 'FLOW_STUDIO_TOKEN' },
      }])
      const messageResult = record(await reply.execute(
        { text: '回复消息级来源', inReplyTo: 'm-hostile' },
        makeExec('session-node'),
      ))
      A.equal(messageResult.ok, false)
      A.match(messageResult.error, /回复通道不合规/)
      A.match(messageResult.error, /FLOW_STUDIO_REPLY_TOKEN_/)
      A.equal(messageResult.delivery, 'blocked')
      A.equal(JSON.stringify(messageResult).includes(secret), false, '返回体里不能出现令牌值')

      A.equal(calls.length, 0, '必须在读取令牌 / 发请求之前拦下')
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.FLOW_STUDIO_TOKEN
    }
  })

  await check('F1：同一 payload 打四个入口——白名单口径一致，错误 / 事件不含令牌值', async () => {
    const secret = 'sk-cross-entry-secret-abcdef'
    process.env.FLOW_STUDIO_TOKEN = secret
    process.env.FLOW_STUDIO_REPLY_TOKEN_OK = secret
    const send = byName(makeToolsWithInbox(), 'flow_send_message')
    const fetchCalls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init })
      return { ok: true, status: 200, text: async () => 'ok' }
    }
    try {
      const payloads = [
        {
          name: '合法：https + 专用前缀',
          reply: { kind: 'http', url: 'https://example.com/hook', tokenEnv: 'FLOW_STUDIO_REPLY_TOKEN_OK' },
          accepted: true,
        },
        {
          name: '拒绝：tokenEnv=FLOW_STUDIO_TOKEN',
          reply: { kind: 'http', url: 'https://example.com/hook', tokenEnv: 'FLOW_STUDIO_TOKEN' },
          accepted: false,
        },
        {
          name: '拒绝：tokenEnv=DSH_HOME',
          reply: { kind: 'http', url: 'https://example.com/hook', tokenEnv: 'DSH_HOME' },
          accepted: false,
        },
        {
          name: '拒绝：tokenEnv 无专用前缀',
          reply: { kind: 'http', url: 'https://example.com/hook', tokenEnv: 'REPLY_HOOK_TOKEN' },
          accepted: false,
        },
        {
          name: '拒绝：外部明文 http',
          reply: { kind: 'http', url: 'http://example.com/hook', tokenEnv: 'FLOW_STUDIO_REPLY_TOKEN_OK' },
          accepted: false,
        },
        {
          name: '拒绝：url 带 user:pass@',
          reply: { kind: 'http', url: 'https://user:pass@example.com/hook', tokenEnv: 'FLOW_STUDIO_REPLY_TOKEN_OK' },
          accepted: false,
        },
      ]

      for (const item of payloads) {
        const label = item.name
        // ① POST /runs/<id>/inbox（index.js 调的就是 inbox.validateReplyTarget）
        const inbox = validateReplyTarget(item.reply)
        A.equal(inbox.ok, item.accepted, `${label} · /inbox`)
        if (!item.accepted) A.ok(inbox.error, `${label} · /inbox 要给出可读原因`)

        // ② POST /runs/<id>/messages（deliverInboundMessage → validateInboundBody）
        const direct = validateInboundBody({ from: 'ext', text: '同一载荷', reply: item.reply })
        A.equal(direct.ok, item.accepted, `${label} · validateInboundBody`)
        const run = await runstore.createRun(runsRoot, {
          flowId: 'flow-main', flowName: '主流程', name: `F1 四入口 ${label}`, nodeTotal: 1, engine: 'real',
        })
        const routeEngine = makeEngine()
        let messagesOk = false
        let messagesError = ''
        try {
          await deliverInboundMessage(
            { runsRoot, flowsRoot, engine: routeEngine, ctx: {}, log() {} },
            run.id,
            { from: 'ext', text: '同一载荷', reply: item.reply },
          )
          messagesOk = true
        } catch (error) {
          messagesError = error && error.message ? error.message : String(error)
        }
        A.equal(messagesOk, item.accepted, `${label} · /messages`)

        // ③ flow_send_message（模型工具入口）
        const sent = record(await send.execute({ runId: run.id, text: '同一载荷', reply: item.reply }, makeExec()))
        A.equal(sent.ok, item.accepted, `${label} · flow_send_message`)

        // ④ flow_reply（已保存的 run 级回复通道）
        await runstore.writeRunInbox(runsRoot, run.id, item.reply)
        const ownerEngine = makeEngine()
        ownerEngine.resolveSessionOwner = async () => ({ runId: run.id, nodeId: 'n_a' })
        const replyTool = byName(makeToolsWithInbox({ engine: ownerEngine }), 'flow_reply')
        const replied = record(await replyTool.execute({ text: '同一载荷' }, makeExec('session-node')))
        A.equal(replied.ok, item.accepted, `${label} · flow_reply`)

        // 错误信息 / 返回体 / 事件里都不能出现令牌值（变量名可以出现）。
        const visible = [
          inbox.error || '',
          direct.error || '',
          messagesError,
          sent.error || '',
          replied.error || '',
          JSON.stringify(sent),
          JSON.stringify(replied),
        ]
        for (const text of visible) {
          A.equal(text.includes(secret), false, `${label} · 令牌值不能出现在错误 / 返回体里`)
        }
        const events = await runstore.readAllEvents(runsRoot, run.id)
        A.equal(JSON.stringify(events.events).includes(secret), false, `${label} · 事件里不能出现令牌值`)
      }

      // 只有「合法」那一条的 flow_reply 会真的发一次 HTTP；不合规的一律在发请求前拦下。
      A.equal(fetchCalls.length, 1, '不合规的回复通道一个请求都不能发')
      A.equal(fetchCalls[0].init.headers.authorization, `Bearer ${secret}`)
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.FLOW_STUDIO_TOKEN
      delete process.env.FLOW_STUDIO_REPLY_TOKEN_OK
    }
  })

  await check('F1：消息级 reply（inReplyTo）的 tokenEnv / url 矩阵与 run 级同口径', async () => {
    const secret = 'sk-message-level-secret-xy'
    process.env.FLOW_STUDIO_TOKEN = secret
    process.env.FLOW_STUDIO_REPLY_TOKEN_MSG = secret
    const payloads = [
      {
        name: '合法：https + 专用前缀',
        reply: { kind: 'http', url: 'https://example.com/cb', tokenEnv: 'FLOW_STUDIO_REPLY_TOKEN_MSG' },
        accepted: true,
      },
      {
        name: '拒绝：tokenEnv=FLOW_STUDIO_TOKEN',
        reply: { kind: 'http', url: 'https://example.com/cb', tokenEnv: 'FLOW_STUDIO_TOKEN' },
        accepted: false,
      },
      {
        name: '拒绝：tokenEnv=DSH_HOME',
        reply: { kind: 'http', url: 'https://example.com/cb', tokenEnv: 'DSH_HOME' },
        accepted: false,
      },
      {
        name: '拒绝：tokenEnv 无专用前缀',
        reply: { kind: 'http', url: 'https://example.com/cb', tokenEnv: 'REPLY_MSG_TOKEN' },
        accepted: false,
      },
      {
        name: '拒绝：外部明文 http',
        reply: { kind: 'http', url: 'http://example.com/cb', tokenEnv: 'FLOW_STUDIO_REPLY_TOKEN_MSG' },
        accepted: false,
      },
      {
        name: '拒绝：url 带 user:pass@',
        reply: { kind: 'http', url: 'https://user:pass@example.com/cb', tokenEnv: 'FLOW_STUDIO_REPLY_TOKEN_MSG' },
        accepted: false,
      },
    ]
    const fetchCalls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init })
      return { ok: true, status: 200, text: async () => 'ok' }
    }
    try {
      let index = 0
      for (const item of payloads) {
        index += 1
        const run = await runstore.createRun(runsRoot, {
          flowId: 'flow-main', flowName: '主流程', name: `F1 消息级 ${item.name}`, nodeTotal: 1, engine: 'real',
        })
        const messageId = `m-level-${index}`
        await runstore.appendRunMessages(runsRoot, run.id, [{
          v: 1,
          id: messageId,
          direction: 'in',
          ts: new Date().toISOString(),
          from: 'ext',
          text: `带消息级 reply 的入站消息（${item.name}）`,
          targetNodeId: 'n_a',
          status: 'pending',
          reply: item.reply,
        }])
        const engine = makeEngine()
        engine.resolveSessionOwner = async () => ({ runId: run.id, nodeId: 'n_a' })
        const replyTool = byName(makeToolsWithInbox({ engine }), 'flow_reply')
        const result = record(await replyTool.execute(
          { text: '回复消息级来源', inReplyTo: messageId },
          makeExec('session-node'),
        ))

        A.equal(result.ok, item.accepted, `${item.name} · 消息级 flow_reply`)
        if (!item.accepted) {
          A.match(result.error, /回复通道不合规/, `${item.name} · 要给出可读原因`)
          A.equal(result.delivery, 'blocked')
          A.equal(result.retryable, false)
        } else {
          A.equal(result.delivery, 'http')
          A.equal(result.httpStatus, 200)
        }
        A.equal(JSON.stringify(result).includes(secret), false, `${item.name} · 返回体不能出现令牌值`)
        const events = await runstore.readAllEvents(runsRoot, run.id)
        A.equal(JSON.stringify(events.events).includes(secret), false, `${item.name} · 事件不能出现令牌值`)
      }
      A.equal(fetchCalls.length, 1, '只有合法消息级 reply 会真的发一次请求')
      A.equal(fetchCalls[0].init.headers.authorization, `Bearer ${secret}`)
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.FLOW_STUDIO_TOKEN
      delete process.env.FLOW_STUDIO_REPLY_TOKEN_MSG
    }
  })

  await check('F1：flow_reply 投递失败时令牌值打码（返回体 / 事件都不含完整令牌）', async () => {
    const secret = 'sk-leak-check-abcdefghijkl'
    process.env.FLOW_STUDIO_REPLY_TOKEN_LEAK = secret
    const run = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: 'F1 打码', nodeTotal: 1, engine: 'real',
    })
    await runstore.writeRunInbox(runsRoot, run.id, {
      kind: 'http', url: 'https://example.com/cb', tokenEnv: 'FLOW_STUDIO_REPLY_TOKEN_LEAK',
    })
    const engine = makeEngine()
    engine.resolveSessionOwner = async () => ({ runId: run.id, nodeId: 'n_a' })
    const tools = makeToolsWithInbox({ engine })

    const calls = []
    const originalFetch = globalThis.fetch
    // 模拟「上游把 Authorization 抄进错误文本」的最坏情况。
    globalThis.fetch = async (url, init) => {
      calls.push({ url, authorization: init && init.headers ? init.headers.authorization : '' })
      throw new Error(`连接失败：Authorization=${init && init.headers ? init.headers.authorization : ''}`)
    }
    try {
      const result = record(await byName(tools, 'flow_reply').execute({ text: '回复' }, makeExec('session-node')))
      A.equal(calls.length, 1, '合规通道必须真的发一次请求')
      A.equal(calls[0].authorization, `Bearer ${secret}`, '令牌只作为 Authorization 头发送')
      A.equal(result.ok, false)
      A.equal(JSON.stringify(result).includes(secret), false, '错误信息 / 返回体里不能含令牌值')
      A.ok(String(result.error).includes(maskSecret(secret)), '错误里的令牌应替换成打码形式')
      const all = await runstore.readAllEvents(runsRoot, run.id)
      A.equal(JSON.stringify(all.events).includes(secret), false, '事件里不能出现令牌值')
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.FLOW_STUDIO_REPLY_TOKEN_LEAK
    }
  })

  // ── 9.6 F2：画布「开始运行」必须带 workspace ──────────────────────────
  await check('F2 前端：建 run / start 的请求体都含 workspace；没有工作区返回 null', () => {
    const flow = { id: 'flow-main', name: '主流程' }
    A.deepEqual(createRunBodyFor(flow, '本次运行', '/repo/a'), {
      flowId: 'flow-main', name: '本次运行', workspace: '/repo/a',
    })
    A.deepEqual(createRunBodyFor(flow, '', '/repo/a'), {
      flowId: 'flow-main', name: '主流程', workspace: '/repo/a',
    })
    A.equal(createRunBodyFor(flow, '本次运行', ''), null, '没工作区不能构造建 run 请求')
    A.equal(createRunBodyFor(flow, '本次运行', '   '), null)
    A.equal(createRunBodyFor(null, '本次运行', '/repo/a'), null)

    A.deepEqual(startRunBodyFor(' /repo/a '), { workspace: '/repo/a' })
    A.equal(startRunBodyFor(''), null, '没工作区不能构造 start 请求')
    A.equal(startRunBodyFor('  '), null)

    A.equal(normalizeWorkspace('  /repo/a  '), '/repo/a')
    A.equal(normalizeWorkspace(42), '')
    A.equal(isAbsoluteWorkspace('/repo/a'), true)
    A.equal(isAbsoluteWorkspace('C:\\repo'), true)
    A.equal(isAbsoluteWorkspace('relative/path'), false)
  })

  await check('F2 前端：未选择工作区不允许启动（可读提示 + 按钮禁用 + 不退回默认目录）', () => {
    const empty = workspaceBlockReason('')
    A.match(empty, /未选择工作区/)
    A.match(empty, /无法启动/)
    A.match(empty, /默认目录/, '必须说明不会退回默认目录')
    A.match(workspaceBlockReason('   '), /未选择工作区/)
    A.match(workspaceBlockReason('relative/path'), /绝对路径/)
    A.equal(workspaceBlockReason('/repo/a'), '')

    const blocked = runControlState({ id: 'r1', status: 'pending' }, { hasFlow: true, hasWorkspace: false })
    A.equal(blocked.startDisabled, true, '没工作区时「运行」必须禁用')
    A.match(blocked.startTitle, /未选择工作区/)
    const ready = runControlState({ id: 'r1', status: 'pending' }, { hasFlow: true, hasWorkspace: true })
    A.equal(ready.startDisabled, false)
    // 与 m7（运行列表未回）同时成立时，两条原因都要写出来，不能只报一条。
    const both = runControlState(null, { hasFlow: true, hasWorkspace: false, listReady: false })
    A.match(both.startTitle, /未选择工作区/)
    A.match(both.startTitle, /正在读取运行记录/)
  })

  await check('F2 前端：工作区选择会记住；清空即删除（不会悄悄带出旧目录）', () => {
    const storage = fakeStorage()
    A.equal(readStoredWorkspace(storage), '')
    A.equal(writeStoredWorkspace(storage, '  /repo/a  '), true)
    A.equal(readStoredWorkspace(storage), '/repo/a')
    A.equal(storage.raw('dsh-flow-studio.workspace'), '/repo/a')
    A.equal(writeStoredWorkspace(storage, '   '), true)
    A.equal(storage.has('dsh-flow-studio.workspace'), false)
    A.equal(readStoredWorkspace(storage), '')
    // localStorage 不存在的 SSR 环境：读回空串，不抛错。
    A.equal(readStoredWorkspace(null), '')
  })

  await check('F2 前端：startRunRequest 未选工作区时 0 请求；选了就两次请求都带 workspace', async () => {
    const flow = { id: 'flow-main', name: '主流程' }
    const calls = { create: [], start: [], delete: [] }
    const spyApi = {
      async createRun(body) {
        calls.create.push(body)
        return { ok: true, run: { id: 'r-new', flowId: body.flowId, status: 'pending', workspacePath: body.workspace } }
      },
      async startRun(id, body) {
        calls.start.push({ id, body })
        return { ok: true, run: { id, status: 'running' } }
      },
      async deleteRun(id) {
        calls.delete.push(id)
        return { ok: true }
      },
    }

    // ① 未选工作区：直接拦下，**一次请求都不能发**。
    const blocked = await startRunRequest({ api: spyApi, flow, workspace: '' })
    A.equal(blocked.ok, false)
    A.match(blocked.error, /未选择工作区/)
    A.equal(calls.create.length + calls.start.length, 0, '未选工作区不能发任何请求（不靠后端 400 兜底）')

    // ② 选了工作区：建 run 与 start 的真实载荷都含 workspace 字段。
    const ok = await startRunRequest({ api: spyApi, flow, workspace: ' /repo/a ', runName: '本次运行', runs: [] })
    A.equal(ok.ok, true)
    A.deepEqual(calls.create[0], { flowId: 'flow-main', name: '本次运行', workspace: '/repo/a' })
    A.deepEqual(calls.start[0], { id: 'r-new', body: { workspace: '/repo/a' } })

    // ③ 工作区不一致的 pending run 不复用（否则 start 会退回旧参数）。
    calls.create.length = 0
    calls.start.length = 0
    const mismatch = await startRunRequest({
      api: spyApi, flow, workspace: '/repo/a',
      runs: [{ id: 'r-old', flowId: 'flow-main', status: 'pending', workspacePath: '/repo/other' }],
    })
    A.equal(mismatch.ok, true)
    A.equal(calls.create.length, 1, '工作区不一致的 pending run 必须新建')
    A.equal(calls.start[0].id, 'r-new')

    // ④ 工作区一致的 pending run 才复用（且 start 仍显式带 workspace）。
    calls.create.length = 0
    calls.start.length = 0
    const reused = await startRunRequest({
      api: spyApi, flow, workspace: '/repo/a',
      runs: [{ id: 'r-match', flowId: 'flow-main', status: 'pending', workspacePath: '/repo/a' }],
    })
    A.equal(reused.ok, true)
    A.equal(calls.create.length, 0, '同工作区的 pending run 应复用')
    A.deepEqual(calls.start[0], { id: 'r-match', body: { workspace: '/repo/a' } })

    // ⑤ start 失败时把「本次新建的 run」带回去，供 beginRun 清理幽灵 run。
    const failingApi = {
      async createRun() { return { ok: true, run: { id: 'r-ghost', flowId: 'flow-main', status: 'pending' } } },
      async startRun() {
        const error = new Error('工作区不可用')
        error.status = 400
        throw error
      },
    }
    const failed = await startRunRequest({ api: failingApi, flow, workspace: '/repo/a' })
    A.equal(failed.ok, false)
    A.equal(failed.run.id, 'r-ghost')
    A.equal(failed.createdRun.id, 'r-ghost')
    A.equal(startFailurePlan('start', failed.error, failed.run, Boolean(failed.createdRun)).deleteRunId, 'r-ghost')
  })

  await check('F2 前端：HTTP 层真实载荷（fetch spy）——POST /runs 与 /runs/<id>/start 的 body 都含 workspace', async () => {
    const flow = { id: 'flow-main', name: '主流程' }
    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      const data = calls.length === 1
        ? { ok: true, run: { id: 'r-http', flowId: 'flow-main', status: 'pending', workspacePath: '/repo/a' } }
        : { ok: true, run: { id: 'r-http', status: 'running' } }
      return { ok: true, status: calls.length === 1 ? 201 : 202, json: async () => data }
    }
    try {
      const outcome = await startRunRequest({ api: clientApi, flow, workspace: '/repo/a', runName: 'HTTP 载荷', runs: [] })
      A.equal(outcome.ok, true)
      A.equal(calls.length, 2)
      A.ok(calls[0].url.endsWith('/runs'), calls[0].url)
      A.equal(calls[0].init.method, 'POST')
      A.deepEqual(JSON.parse(calls[0].init.body), {
        flowId: 'flow-main', name: 'HTTP 载荷', workspace: '/repo/a',
      }, 'POST /runs 的 body 必须真实包含 workspace')
      A.ok(calls[1].url.endsWith('/runs/r-http/start'), calls[1].url)
      A.equal(calls[1].init.method, 'POST')
      A.deepEqual(JSON.parse(calls[1].init.body), { workspace: '/repo/a' },
        'POST /runs/<id>/start 的 body 必须真实包含 workspace')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await check('F2 前端：page.js 的两个发起运行调用点都带 workspace（源码级护栏）', () => {
    const pageSource = readFileSync(join(repoRoot, 'src/client/page.js'), 'utf8')
    // beginRun 走 startRunRequest（未选工作区的拦截 / 载荷构造都在它里面）。
    A.match(pageSource, /const outcome = await startRunRequest\(/, 'beginRun 必须走 startRunRequest')
    A.match(pageSource, /workspaceBlockReason\(workspaceRef\.current\)/, 'beginRun 必须先过工作区门禁')
    // 建 run：请求体只能由 createRunBodyFor 构造（它保证 workspace 存在，否则返回 null）。
    A.match(pageSource, /const body = createRunBodyFor\(flow, runName, path\)/, 'POST /runs 的请求体必须带 workspace')
    A.match(pageSource, /api\.createRun\(body\)/)
    A.match(pageSource, /if \(!body\) return \{ ok: false, error: workspaceBlockReason\(path\)/, '没有 workspace 不构造请求')
    // start：同样显式带 workspace（复用的旧 pending run 不依赖建 run 时的参数）。
    A.match(pageSource, /const startBody = startRunBodyFor\(path\)/, 'POST /runs/<id>/start 必须带 workspace')
    A.match(pageSource, /api\.startRun\(run\.id, startBody\)/)
    A.match(pageSource, /workspacePathOf\(item\) === path/, '只复用同工作区的 pending run')

    // api.js 必须把 start 的 body 转发出去，否则页面传了也发不出去（F2 的 HTTP 面）。
    const apiSource = readFileSync(join(repoRoot, 'src/client/api.js'), 'utf8')
    A.match(apiSource, /startRun: \(id, body\) => request\('POST', `\/runs\/\$\{segment\(id\)\}\/start`, body\)/)

    const canvasSource = readFileSync(join(repoRoot, 'src/client/canvas.js'), 'utf8')
    A.equal(/api\.(createRun|startRun)\(/.test(canvasSource), false, 'canvas.js 不直接发起运行')
  })

  // ── 9.5 G6：主机级开关 / 时限 / 多 run 审查 / worktree 生命周期 ────────
  /**
   * 带 executor:'custom' 的合法流程（有 executorCommand，所以 executor 规则本身不拦；
   * 拦它的是主机级开关 FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR）。
   */
  function makeCustomFlow(id, name) {
    const flow = makeFlow(id, name)
    const stage = flow.nodes.find(node => node.kind === 'stage')
    stage.executor = 'custom'
    stage.executorCommand = 'echo hi'
    return flow
  }

  await check('G6-c flow_start 接受 runTimeoutMs / nodeTimeoutMs 并透传；非法值不建 run；默认值明示', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const start = byName(tools, 'flow_start')
    // 默认值必须在描述 / schema 里明示（避免 6 小时任务开局即注定超时失败）。
    A.match(start.description, /2 小时|7200000/)
    A.match(start.description, /20 分钟|1200000/)
    A.ok(start.parameters.properties.runTimeoutMs)
    A.ok(start.parameters.properties.nodeTimeoutMs)
    A.match(start.parameters.properties.runTimeoutMs.description, /正整数|毫秒/)

    const before = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    const runTimeoutMs = 6 * 60 * 60 * 1000
    const nodeTimeoutMs = 30 * 60 * 1000
    const result = record(await byName(tools, 'flow_start').execute(
      { flowId: 'flow-main', workspace: '/repo/timeouts', runTimeoutMs, nodeTimeoutMs },
      makeExec('session-timeout'),
    ))
    A.equal(result.ok, true)
    A.equal(engine.calls.start.length, 1)
    A.equal(engine.calls.start[0].options.runTimeoutMs, runTimeoutMs)
    A.equal(engine.calls.start[0].options.nodeTimeoutMs, nodeTimeoutMs)
    A.equal(result.limits.runTimeoutMs, runTimeoutMs)
    A.equal(result.limits.nodeTimeoutMs, nodeTimeoutMs)
    A.equal(result.limits.defaultRunTimeoutMs, 2 * 60 * 60 * 1000)
    A.equal(result.limits.defaultNodeTimeoutMs, 20 * 60 * 1000)

    // 省略 = 不替引擎写死（交给默认值 / 环境变量），返回里标注 null。
    const plain = record(await byName(tools, 'flow_start').execute(
      { flowId: 'flow-main', workspace: '/repo/timeouts' },
      makeExec('session-timeout-plain'),
    ))
    A.equal(plain.ok, true)
    A.equal(Object.hasOwn(engine.calls.start[1].options, 'runTimeoutMs'), false)
    A.equal(Object.hasOwn(engine.calls.start[1].options, 'nodeTimeoutMs'), false)
    A.equal(plain.limits.runTimeoutMs, null)
    A.equal(plain.limits.nodeTimeoutMs, null)

    // 非法值：参数失败、不建 run、不进 engine.start。
    const beforeBad = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    for (const [key, value] of [
      ['runTimeoutMs', 0],
      ['runTimeoutMs', -5],
      ['runTimeoutMs', 1.5],
      ['runTimeoutMs', '60000'],
      ['nodeTimeoutMs', true],
      ['nodeTimeoutMs', MAX_TIMEOUT_MS + 1],
    ]) {
      const failed = record(await byName(tools, 'flow_start').execute(
        { flowId: 'flow-main', workspace: '/repo/timeouts', [key]: value },
        makeExec('session-timeout-bad'),
      ))
      A.equal(failed.ok, false, `${key}=${String(value)}`)
      A.match(failed.error, /整数|之间/)
      A.equal(failed.retryable, false)
    }
    A.equal(engine.calls.start.length, 2, '非法时限不能进 engine.start')
    const afterBad = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    A.equal(afterBad, beforeBad, '非法时限不能建 run')
    A.equal(beforeBad, before + 2, '前面两次成功启动各建了一个 run')
  })

  await check('G6-a flow_start：custom executor 默认被拒，主机开关打开后放行', async () => {
    await store.saveFlow(flowsRoot, 'flow-custom-command', makeCustomFlow('flow-custom-command', 'custom 有命令'))
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const start = byName(tools, 'flow_start')
    const before = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length

    const blocked = record(await byName(tools, 'flow_start').execute(
      { flowId: 'flow-custom-command', workspace: '/repo/custom' },
      makeExec('session-custom'),
    ))
    A.equal(blocked.ok, false)
    A.match(blocked.error, /FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR/)
    A.match(blocked.error, /executor/)
    A.equal(blocked.retryable, false)
    A.equal(engine.calls.start.length, 0, '被开关拦下的流程不能进 engine.start')
    A.equal((await runstore.listRuns(runsRoot, { limit: 100 })).runs.length, before, '被拒时不建 run')

    process.env.FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR = '1'
    try {
      const allowed = record(await start.execute(
        { flowId: 'flow-custom-command', workspace: '/repo/custom' },
        makeExec('session-custom-on'),
      ))
      A.equal(allowed.ok, true, JSON.stringify(allowed))
      A.equal(engine.calls.start.length, 1)
    } finally {
      delete process.env.FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR
    }
  })

  await check('G6-a flow_start：workspace 白名单越界失败且不建 run；根内放行', async () => {
    const engine = makeEngine()
    const tools = makeTools({ engine })
    const start = byName(tools, 'flow_start')
    process.env.FLOW_STUDIO_WORKSPACE_ROOTS = '/allowed/root'
    try {
      const before = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
      const failed = record(await start.execute(
        { flowId: 'flow-main', workspace: '/elsewhere/repo' },
        makeExec('session-scope'),
      ))
      A.equal(failed.ok, false)
      A.match(failed.error, /允许的根目录/)
      A.match(failed.hint, /FLOW_STUDIO_WORKSPACE_ROOTS/)
      A.equal(failed.retryable, false)
      A.equal(engine.calls.start.length, 0)
      A.equal((await runstore.listRuns(runsRoot, { limit: 100 })).runs.length, before, '越界 workspace 不能建 run')

      const inside = record(await start.execute(
        { flowId: 'flow-main', workspace: '/allowed/root/sub/dir' },
        makeExec('session-scope-ok'),
      ))
      A.equal(inside.ok, true, JSON.stringify(inside))
      A.equal(engine.calls.start[0].options.workspace, '/allowed/root/sub/dir')
    } finally {
      delete process.env.FLOW_STUDIO_WORKSPACE_ROOTS
    }
  })

  await check('G6-d flow_watch runIds：多 run 一次审查 + 每 run 结论 + 合并建议（runId 单数兼容）', async () => {
    auditResult = {
      verdict: 'healthy',
      status: 'running',
      headline: '正在执行',
      progress: { passed: 0, total: 1, ratio: 0 },
      plan: [],
      currentNode: null,
      rejects: { total: 0 },
      anomalies: [],
      quality: {},
      tokens: {},
      idleMs: 10,
      recommended: ['继续等待'],
      nextCheckSeconds: 60,
    }
    const startedAt = '2026-11-06T00:00:00.000Z'
    const makeRun = async name => {
      const run = await runstore.createRun(runsRoot, {
        flowId: 'flow-main', flowName: '主流程', name, nodeTotal: 1, engine: 'real',
      })
      await runstore.writeRunMeta(runsRoot, run.id, { status: 'running', started: true, startedAt })
      return run
    }
    const statusEvent = (run, progress) => ({
      v: 1,
      ts: startedAt,
      kind: 'node/status',
      nodeId: 'n_a',
      attemptId: 1,
      traceId: `run:${run.id}`,
      data: {
        nodeId: 'n_a', attempt: 1, state: 'working', progress,
        summary: '…', members: [], blockers: [], verdict: null,
      },
    })
    // G6-d 基准建立：只为了让 run 走审计；eventCount 不是重点。
    // 每个 run 单独一份事件（一次读取后复用给审计与 nodeStatus 建议）。
    const runA = await makeRun('多 run A')
    const runB = await makeRun('多 run B')
    await runstore.appendEvents(runsRoot, runA.id, [statusEvent(runA, 30)])
    await runstore.appendEvents(runsRoot, runB.id, [statusEvent(runB, 70)])

    const tools = makeTools({ engine: makeEngine(), auditWorkflow: stubAudit })
    const watch = byName(tools, 'flow_watch')
    const callsBefore = auditCalls.length
    const multi = record(await watch.execute({ runIds: [runA.id, runB.id] }, makeExec()))
    A.equal(multi.ok, true, JSON.stringify(multi))
    A.equal(multi.mode, 'multi')
    A.equal(multi.runs.length, 2)
    A.equal(auditCalls.length, callsBefore + 2, '每个 run 只审一次（事件也只读一次）')
    A.deepEqual(multi.runs.map(item => item.runId).sort(), [runA.id, runB.id].sort())
    for (const entry of multi.runs) {
      A.equal(entry.ok, true)
      A.equal(entry.verdict, 'healthy')
      A.equal(entry.supervision.nextCheckSeconds, 60)
    }
    A.equal(multi.merged.total, 2)
    A.equal(multi.merged.ok, 2)
    A.equal(multi.merged.failed, 0)
    A.equal(multi.merged.terminal, false)
    A.equal(multi.merged.nextCheckSeconds, 60)
    A.equal(multi.merged.watchTool, 'flow_watch')
    A.ok(Array.isArray(multi.merged.recommended))
    A.ok(multi.merged.recommended.some(item => item.includes(runA.id)), '合并建议要能定位到具体 run')
    A.match(multi.merged.alarmPrompt, new RegExp(runA.id))
    A.match(multi.merged.alarmPrompt, /flow_watch/)
    A.ok(typeof multi.merged.hint === 'string' && multi.merged.hint.length > 0)

    // 重复 runId 去重 → 只审一次（不重复读事件 / 不重复审计）。
    const dupBefore = auditCalls.length
    const dup = record(await watch.execute({ runIds: [runA.id, runA.id] }, makeExec()))
    A.equal(dup.runs.length, 1)
    A.equal(auditCalls.length, dupBefore + 1)

    // 混入不存在的 run：其它 run 照常出结论，失败项带可读 hint。
    const mixed = record(await watch.execute({ runIds: [runA.id, 'r-missing-probe'] }, makeExec()))
    A.equal(mixed.ok, true)
    A.equal(mixed.merged.ok, 1)
    A.equal(mixed.merged.failed, 1)
    const missingEntry = mixed.runs.find(item => item.runId === 'r-missing-probe')
    A.equal(missingEntry.ok, false)
    A.ok(missingEntry.hint)
    A.equal(missingEntry.retryable, false)

    // 上限 20：超过 → 可读参数失败（400 风格），一条 run 都不读。
    const auditBeforeLimit = auditCalls.length
    const tooMany = record(await watch.execute(
      { runIds: Array.from({ length: 21 }, (_, index) => `r-probe-${index}`) },
      makeExec(),
    ))
    A.equal(tooMany.ok, false)
    A.match(tooMany.error, /20/)
    A.equal(tooMany.retryable, false)
    A.equal(auditCalls.length, auditBeforeLimit, '超限不能读任何 run')

    // runId 与 runIds 二选一。
    const both = record(await watch.execute({ runId: runA.id, runIds: [runB.id] }, makeExec()))
    A.equal(both.ok, false)
    A.match(both.error, /二选一/)

    // 单 run 兼容：返回形状仍是老契约（没有 runs / merged）。
    const single = record(await watch.execute({ runId: runA.id }, makeExec()))
    A.equal(single.ok, true)
    A.equal(single.runId, runA.id)
    A.equal(single.runs, undefined)
    A.equal(single.merged, undefined)

    // 全部终态 → merged.terminal=true、nextCheckSeconds=null（不必再挂闹钟）。
    auditResult = { verdict: 'done', status: 'done', headline: '完成', anomalies: [], recommended: [], nextCheckSeconds: 30 }
    const doneRun = await makeRun('多 run done')
    const done = record(await watch.execute({ runIds: [doneRun.id] }, makeExec()))
    A.equal(done.merged.terminal, true)
    A.equal(done.merged.nextCheckSeconds, null)
    A.match(done.merged.alarmPrompt, /不必再挂/)
  })

  await check('G6-b flow_worktrees：list 标孤儿 / prune 透传 keepRunIds；参数与失败可读', async () => {
    const runForWorktrees = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: 'worktree list 锚点', nodeTotal: 1, engine: 'real',
    })
    const listCalls = []
    const pruneCalls = []
    const stub = {
      async listWorktrees(input) {
        listCalls.push(input)
        return [
          {
            path: `/wt/${runForWorktrees.id}`, workspaceId: '0123456789ab', runId: runForWorktrees.id,
            exists: true, dirty: false, head: 'abc123', registered: true,
          },
          {
            path: '/wt/r-orphan-probe', workspaceId: '0123456789ab', runId: 'r-orphan-probe',
            exists: false, dirty: null, head: null, registered: null,
          },
        ]
      },
      async pruneWorktrees(input) {
        pruneCalls.push(input)
        return {
          removed: [{ path: '/wt/r-orphan-probe', runId: 'r-orphan-probe' }],
          skipped: [{ path: '/wt/r-skip-probe', reason: 'remove-failed' }],
        }
      },
    }
    const tools = makeTools({ engine: makeEngine(), worktree: stub })
    const worktrees = byName(tools, 'flow_worktrees')
    A.ok(worktrees, 'flow_worktrees 必须注册')
    A.deepEqual(worktrees.parameters.required, ['action'])
    A.deepEqual(worktrees.parameters.properties.action.enum, ['list', 'prune'])
    A.ok(worktrees.output && worktrees.output.schema && typeof worktrees.output.render === 'function')
    A.equal(worktrees.isConcurrencySafe, undefined, '同一工具能 prune（写），不能标并发安全')

    const listed = record(await worktrees.execute({ action: 'list' }))
    A.equal(listed.ok, true, JSON.stringify(listed))
    A.equal(listed.action, 'list')
    A.equal(listed.available, true)
    A.equal(listed.worktrees.length, 2)
    A.equal(listed.worktrees.find(item => item.runId === runForWorktrees.id).orphan, false)
    A.deepEqual(listed.orphans.map(item => item.runId), ['r-orphan-probe'])
    A.equal(listCalls.length, 1)
    A.equal(listCalls[0].root, join(dirname(runsRoot), 'worktrees'))

    const pruned = record(await worktrees.execute({ action: 'prune', keepRunIds: [runForWorktrees.id] }))
    A.equal(pruned.ok, true, JSON.stringify(pruned))
    A.equal(pruned.action, 'prune')
    A.deepEqual(pruned.removed.map(item => item.path), ['/wt/r-orphan-probe'])
    A.equal(pruned.skipped.length, 1)
    A.equal(pruned.keepRunIds, pruneCalls[0].keepRunIds.length)
    A.ok(pruneCalls[0].keepRunIds.includes(runForWorktrees.id))
    A.equal(pruneCalls[0].root, join(dirname(runsRoot), 'worktrees'))

    // 参数校验：缺 action / 未知 action / keepRunIds 形状错 / 非法 runId。
    for (const args of [{}, { action: 'nope' }, { action: 'list', keepRunIds: 'x' }, { action: 'prune', keepRunIds: ['../etc'] }]) {
      const failed = record(await worktrees.execute(args))
      A.equal(failed.ok, false, JSON.stringify(args))
      A.ok(failed.hint)
    }

    // 注入一个没有导出的桩：明确失败（不假装清理成功）。
    const unavailableTools = makeTools({ engine: makeEngine(), worktree: {} })
    const unavailable = record(await byName(unavailableTools, 'flow_worktrees').execute({ action: 'list' }))
    A.equal(unavailable.ok, false)
    A.match(unavailable.error, /listWorktrees/)

    // 真实模块（src/worktree.js 已导出 listWorktrees）：空 worktrees 根 → []，不报错。
    const realTools = makeTools({ engine: makeEngine() })
    const realList = record(await byName(realTools, 'flow_worktrees').execute({ action: 'list' }))
    A.equal(realList.ok, true, JSON.stringify(realList))
    A.equal(realList.available, true)
    A.ok(Array.isArray(realList.worktrees))
  })

  await check('G7 前端轻量轮询：light 正常时不会回退（createLightRunReader 一直走 ?light=1）', async () => {
    const calls = []
    const warnings = []
    const reader = createLightRunReader({
      readRun: async (id, options) => {
        calls.push({ id, options })
        return { ok: true, run: { id, live: null, worktree: { enabled: false } } }
      },
      warn: message => warnings.push(message),
    })
    const first = await reader.read('r-light')
    A.equal(first.light, true)
    A.equal(first.degraded, false)
    A.equal(reader.lightSupported, true)
    A.equal(calls.length, 1)
    A.deepEqual(calls[0].options, { light: true })
    A.deepEqual(warnings, [], 'light 正常时不能出现降级提示')

    // 第二轮（2s 轮询）仍然走 light，不会「先试 light 再回退」。
    await reader.read('r-light')
    A.equal(calls.length, 2)
    A.deepEqual(calls[1].options, { light: true })
    A.deepEqual(warnings, [])

    // 客户端拼出来的就是后端的 `?light=1`（与 Host 路由契约一致）。
    A.equal(readRunPath('r-light', { light: true }), '/runs/r-light?light=1')
    A.equal(readRunPath('r-light'), '/runs/r-light')
  })

  // ── 10. lossless JSON ──────────────────────────────────────────────────
  await check('所有工具输出都能 JSON 往返（无 undefined / NaN / Date）', () => {
    A.ok(outputs.length >= 10)
    for (const value of outputs) {
      const roundTrip = JSON.parse(JSON.stringify(value))
      assert.deepEqual(roundTrip, value)
      assertionCount += 1
    }
  })

  // ── 11. apply() 的注册条件 ─────────────────────────────────────────────
  await check('ctx 没有 tools 服务时 apply() 不炸（只跳过注册）', () => {
    const { ctx, registered } = makeCtx({ toolsService: false })
    apply(ctx)
    A.equal(registered.length, 0)
    A.equal(ctx.routes.length, 1)
  })

  await check('有 tools 服务时注册七个工具，卸载时逆序撤销', () => {
    const { ctx, registered, disposed, disposeFns } = makeCtx({ toolsService: true })
    apply(ctx)
    // v0.7 新增 flow_supervise；G6-b 新增 flow_worktrees；v0.9.2 新增 flow_restart
    //（失败后重启并在原会话续跑），所以固定数量从 4 → 5 → 6 → 7。
    A.equal(registered.length, 7)
    A.deepEqual(
      registered.map(tool => tool.name).sort(),
      ['flow_list', 'flow_restart', 'flow_start', 'flow_stop', 'flow_supervise', 'flow_watch', 'flow_worktrees'],
    )
    A.equal(ctx.routes.length, 1)
    A.ok(disposeFns.length >= 1)
    // 最后一个 effect 就是工具注册；调用它的 disposer 应把六个工具都撤掉。
    disposeFns[disposeFns.length - 1]()
    A.deepEqual(
      disposed.slice().sort(),
      ['flow_list', 'flow_restart', 'flow_start', 'flow_stop', 'flow_supervise', 'flow_watch', 'flow_worktrees'],
    )
  })

  await check('ctx.tools 属性（不走 ctx.get）也能注册', () => {
    const { ctx, registered } = makeCtx({ toolsService: true, useCtxProperty: true })
    apply(ctx)
    A.equal(registered.length, 7)
  })

  // ── 11.5 engine.start 的 per-start parent（06 §15） ──────────────────
  // 工具层传 parent 只证明「参数传对了」；这里用**真实引擎** + 假 subagents 服务
  // 证明它真的落到 request.parent 上，并且 run 结束后覆盖被清掉、下一次 start 回落既有语义。
  function structuredPass(nodeId) {
    return {
      verdict: 'pass',
      summary: `${nodeId} 通过`,
      artifacts: [{ name: `${nodeId}-结论.md`, content: `# ${nodeId}\n` }],
      findings: [{ id: 'F1', severity: 'P2', title: '小问题', status: 'verified' }],
      checks: { ruleSetId: 'rules', ruleSetVersion: '1', executor: 'test', passedChecks: 1, totalChecks: 1 },
      acceptance: [{ itemId: 'R1', status: 'pass', decidedBy: 'auto' }],
      tests: { suite: 'unit', executed: 1, passed: 1, failed: 0, skipped: 0 },
    }
  }

  function engineCtx(subagents, roots = []) {
    return {
      get(name) {
        if (name === 'subagents') return subagents
        if (name === 'agents') return { roots: () => roots }
        return undefined
      },
      on() {
        return () => {}
      },
    }
  }

  await check('真实引擎：per-start parent 落到 request.parent，run 结束后覆盖清掉', async () => {
    const activations = []
    let childSeq = 0
    const subagents = {
      async startActivation({ request }) {
        activations.push(request)
        childSeq += 1
        return {
          childId: `child-${childSeq}`,
          result: Promise.resolve({
            structured: structuredPass('n_a'),
            output: '',
            stopReason: 'done',
            diagnostic: undefined,
          }),
          async dispose() {},
        }
      },
    }
    const fallbackParent = { session: { id: 'fallback-root' } }
    const overrideParent = { session: { id: 'override-session' } }
    const engine = createEngine({ ctx: engineCtx(subagents, [fallbackParent]), runsRoot, flowsRoot })

    const run1 = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: 'parent 覆盖', nodeTotal: 1, engine: 'real',
    })
    // 引擎 C3 起 workspace 必填：显式给临时目录，worktree off 避免测试里建 worktree。
    await engine.start(run1.id, { parent: overrideParent, workspace: home, worktree: 'off' })
    const final1 = await engine.wait(run1.id)
    A.equal(final1.status, 'done')
    A.equal(activations.length, 1)
    A.equal(activations[0].parent, overrideParent)
    A.equal(activations[0].parent.session.id, 'override-session')
    // 一次性覆盖：run 结束必须清掉，不污染下一次 start。
    A.equal(engine.startParent, null)

    const run2 = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: '回落父会话', nodeTotal: 1, engine: 'real',
    })
    await engine.start(run2.id, { workspace: home, worktree: 'off' })
    const final2 = await engine.wait(run2.id)
    A.equal(final2.status, 'done')
    A.equal(activations.length, 2)
    // 不传 parent → 与旧调用完全一致：_resolveParent 回落到 agents.roots() 最后一个。
    A.equal(activations[1].parent, fallbackParent)
  })

  await check('真实引擎：非法 parent 在同步占位前被挡下（400，不占锁）', async () => {
    const engine = createEngine({ ctx: engineCtx({ async startActivation() { throw new Error('不应被调用') } }), runsRoot, flowsRoot })
    const run = await runstore.createRun(runsRoot, {
      flowId: 'flow-main', flowName: '主流程', name: '非法 parent', nodeTotal: 1, engine: 'real',
    })
    let caught = null
    try {
      await engine.start(run.id, { parent: 'not-an-agent', workspace: home, worktree: 'off' })
    } catch (error) {
      caught = error
    }
    A.ok(caught)
    A.equal(caught.status, 400)
    A.equal(engine.active, null)
    // run 保持 pending，没被这次失败调用动过。
    const meta = await runstore.readRunMeta(runsRoot, run.id)
    A.equal(meta.status, 'pending')
  })

  // ── 12. 参数 schema ────────────────────────────────────────────────────
  await check('参数 schema：flow_start 的 flowId / flowName 都非必填，flow_stop 的 runId 必填', () => {
    const tools = makeTools()
    for (const tool of tools) {
      A.ok(tool.parameters && tool.parameters.type === 'object')
      A.ok(tool.output && tool.output.schema && typeof tool.output.render === 'function')
      A.ok(Number.isInteger(tool.timeoutMs) && tool.timeoutMs > 0)
    }
    const start = byName(tools, 'flow_start')
    const required = start.parameters.required || []
    A.equal(required.includes('flowId'), false)
    A.equal(required.includes('flowName'), false)
    A.ok(start.parameters.properties.flowId)
    A.ok(start.parameters.properties.flowName)

    const stop = byName(tools, 'flow_stop')
    A.deepEqual(stop.parameters.required, ['runId'])

    A.equal(byName(tools, 'flow_list').isConcurrencySafe(), true)
    A.equal(byName(tools, 'flow_watch').isConcurrencySafe(), true)
    A.equal(byName(tools, 'flow_start').isConcurrencySafe, undefined)
    A.equal(byName(tools, 'flow_stop').isConcurrencySafe, undefined)
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${checks} 组通过（${assertionCount} 条断言）`)
