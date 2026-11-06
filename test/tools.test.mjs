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

const { createFlowTools, DEFAULT_WATCH_SECONDS } = await import('../src/tools.js')
const { createEngine } = await import('../src/engine.js')
const { apply } = await import('../src/index.js')
const store = await import('../src/store.js')
const runstore = await import('../src/runstore.js')

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

function makeTools({ engine = makeEngine(), auditWorkflow, watchSeconds, now } = {}) {
  return createFlowTools({ flowsRoot, runsRoot, engine, auditWorkflow, watchSeconds, now })
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

    // 取不到 cwd 就不传 workspace（交给 engine 回落），绝不瞎猜路径。
    const noCwdExec = { agent: { session: { id: 'session-no-cwd', header: {} } } }
    const noCwd = record(await byName(tools, 'flow_start').execute({ flowId: 'flow-main' }, noCwdExec))
    A.equal(noCwd.ok, true)
    A.equal(Object.hasOwn(engine.calls.start[1].options, 'workspace'), false)
    A.equal(noCwd.workspace.path, null)
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

  await check('有 tools 服务时注册五个工具，卸载时逆序撤销', () => {
    const { ctx, registered, disposed, disposeFns } = makeCtx({ toolsService: true })
    apply(ctx)
    // v0.7 新增 flow_supervise（内建 supervision 开关），所以固定数量从 4 变成 5。
    A.equal(registered.length, 5)
    A.deepEqual(registered.map(tool => tool.name).sort(), ['flow_list', 'flow_start', 'flow_stop', 'flow_supervise', 'flow_watch'])
    A.equal(ctx.routes.length, 1)
    A.ok(disposeFns.length >= 1)
    // 最后一个 effect 就是工具注册；调用它的 disposer 应把四个工具都撤掉。
    disposeFns[disposeFns.length - 1]()
    A.deepEqual(disposed.slice().sort(), ['flow_list', 'flow_start', 'flow_stop', 'flow_supervise', 'flow_watch'])
  })

  await check('ctx.tools 属性（不走 ctx.get）也能注册', () => {
    const { ctx, registered } = makeCtx({ toolsService: true, useCtxProperty: true })
    apply(ctx)
    A.equal(registered.length, 5)
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
    await engine.start(run1.id, { parent: overrideParent })
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
    await engine.start(run2.id)
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
      await engine.start(run.id, { parent: 'not-an-agent' })
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
