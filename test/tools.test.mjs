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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

/** 假引擎：记录 start / stop 的调用，可按用例注入返回值或抛错。 */
function makeEngine({ startResult, startError, stopResult, stopError, active = null, engineName } = {}) {
  const calls = { start: [], stop: [] }
  return {
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

  await check('flow_start 引擎已有 active run → 提前失败，不建新 run', async () => {
    const engine = makeEngine({ active: { runId: 'r-active' } })
    const tools = makeTools({ engine })
    const before = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    const result = record(await byName(tools, 'flow_start').execute({ flowId: 'flow-main' }, makeExec()))
    A.equal(result.ok, false)
    A.match(result.error, /r-active/)
    A.equal(engine.calls.start.length, 0)
    const after = (await runstore.listRuns(runsRoot, { limit: 100 })).runs.length
    A.equal(after, before)
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

  // ── 8. flow_watch 省略 runId 取最近一次 ────────────────────────────────
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

  await check('有 tools 服务时注册四个工具，卸载时逆序撤销', () => {
    const { ctx, registered, disposed, disposeFns } = makeCtx({ toolsService: true })
    apply(ctx)
    A.equal(registered.length, 4)
    A.deepEqual(registered.map(tool => tool.name).sort(), ['flow_list', 'flow_start', 'flow_stop', 'flow_watch'])
    A.equal(ctx.routes.length, 1)
    A.ok(disposeFns.length >= 1)
    // 最后一个 effect 就是工具注册；调用它的 disposer 应把四个工具都撤掉。
    disposeFns[disposeFns.length - 1]()
    A.deepEqual(disposed.slice().sort(), ['flow_list', 'flow_start', 'flow_stop', 'flow_watch'])
  })

  await check('ctx.tools 属性（不走 ctx.get）也能注册', () => {
    const { ctx, registered } = makeCtx({ toolsService: true, useCtxProperty: true })
    apply(ctx)
    A.equal(registered.length, 4)
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
