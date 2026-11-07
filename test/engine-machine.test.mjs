#!/usr/bin/env node
/**
 * 引擎 × 状态机（08-state-machine.md §3–§7）自检。
 *
 * 同一组行为用例跑两遍：
 *   ① 默认（FLOW_STUDIO_FLOW_MACHINE 未设置）→ actor 驱动；
 *   ② FLOW_STUDIO_FLOW_MACHINE=0 → 旧 _loop（逃生门）。
 * 机器专属用例（快照落盘 / 恢复 / 重放 / machine-restore-failed）只在 ① 跑。
 *
 * 全部走注入桩：不启动 dsh、不 import 任何 dsh 包。run 目录落在项目 `.tmp/` 下。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const engineModule = await import('../src/engine.js')
const store = await import('../src/runstore.js')
const flowStore = await import('../src/store.js')
const flowmachine = await import('../src/flowmachine.js')
const { createActor } = await import('../src/xstate-vendor.js')

const {
  createEngine: createEngineRaw, FLOW_MACHINE_ENGINE_VERSION,
} = engineModule
const {
  compileFlowToMachine, flowMachineImplementations, machineVersion,
} = flowmachine

const {
  appendEvents, createRun, readAllEvents, runsDir, writeRunMeta,
} = store
const { flowsDir, saveFlow: saveFlowRaw } = flowStore

let checks = 0
let assertions = 0
const A = {
  equal(actual, expected, message) {
    assertions += 1
    assert.equal(actual, expected, message)
  },
  deepEqual(actual, expected, message) {
    assertions += 1
    assert.deepEqual(actual, expected, message)
  },
  ok(value, message) {
    assertions += 1
    assert.ok(value, message)
  },
  match(value, pattern, message) {
    assertions += 1
    assert.match(value, pattern, message)
  },
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function stage(id, title, x, extra = {}) {
  return {
    id,
    kind: 'stage',
    title,
    x,
    y: 200,
    mode: 'single',
    role: '',
    task: `${title} 的任务`,
    outputs: `${title} 的产物`,
    skills: [],
    maxRounds: 2,
    team: [],
    model: '',
    ...extra,
  }
}

function startNode(x = 0) {
  return {
    id: 'n_start', kind: 'start', title: '任务输入', x, y: 200,
    mode: 'single', role: '', task: '接任务', outputs: '', skills: [], maxRounds: 2, team: [], model: '',
  }
}

function endNode(x = 900) {
  return {
    id: 'n_end', kind: 'end', title: '完成', x, y: 200,
    mode: 'single', role: '', task: '', outputs: '', skills: [], maxRounds: 2, team: [], model: '',
  }
}

function next(id, from, to) {
  return { id, from, to, kind: 'next', label: '' }
}

function reject(id, from, to) {
  return { id, from, to, kind: 'reject', label: '打回' }
}

function flowOf(id, nodes, edges) {
  return {
    schemaVersion: 1,
    id,
    name: `流程 ${id}`,
    description: '',
    createdAt: '2026-11-07T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z',
    nodes,
    edges,
  }
}

function passResult(nodeId) {
  return {
    structured: {
      verdict: 'pass',
      summary: `${nodeId} 通过`,
      artifacts: [{ name: `${nodeId}-结论.md`, content: `# ${nodeId}\n\n通过。\n` }],
      findings: [],
      checks: {
        ruleSetId: `rules-${nodeId}`, ruleSetVersion: '1', executor: 'test', passedChecks: 1, totalChecks: 1,
      },
      acceptance: [{ itemId: `${nodeId}-R1`, status: 'pass', decidedBy: 'auto' }],
      tests: { suite: `unit-${nodeId}`, executed: 1, passed: 1, failed: 0, skipped: 0 },
    },
    sessionId: `sess-${nodeId}`,
    dispose: async () => {},
  }
}

function rejectResult(nodeId, targetId) {
  const structured = {
    verdict: 'reject',
    summary: `${nodeId} 打回`,
    rejectReason: '测试结论不达标，返工',
    findings: [{ id: `${nodeId}-F1`, severity: 'P1', title: '失败用例', status: 'open' }],
  }
  if (targetId !== undefined) structured.rejectTarget = targetId
  return { structured, sessionId: `sess-${nodeId}`, dispose: async () => {} }
}

function makeEnv(name) {
  const home = mkdtempSync(join(repoRoot, '.tmp', `home-engine-machine-${name}-`))
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  return {
    home,
    workspace,
    runsRoot: runsDir(home),
    flowsRoot: flowsDir(home),
  }
}

function engineFor(env, options = {}) {
  return createEngineRaw({
    runsRoot: env.runsRoot,
    flowsRoot: env.flowsRoot,
    worktree: 'off',
    cwd: env.workspace,
    ...options,
  })
}

async function saveFlow(env, flow) {
  return saveFlowRaw(env.flowsRoot, flow.id, flow)
}

async function makeRun(env, flowId, nodeTotal) {
  return createRun(env.runsRoot, { flowId, flowName: `流程 ${flowId}`, nodeTotal })
}

async function eventsOf(env, runId) {
  const all = await readAllEvents(env.runsRoot, runId)
  return all ? all.events : []
}

function readRawRun(env, runId) {
  return JSON.parse(readFileSync(join(env.runsRoot, runId, 'run.json'), 'utf8'))
}

function countKind(events, kind) {
  return events.filter(event => event.kind === kind).length
}

function startsOf(events) {
  return events.filter(event => event.kind === 'node/start')
}

function deferred() {
  let resolveFn
  const promise = new Promise(resolve => { resolveFn = resolve })
  return { promise, resolve: resolveFn }
}

/** 编译 + 注入实现，返回 { compiled, provided, actor }；path 依次发 PASS 推进。 */
function actorAt(flow, path = []) {
  const compiled = compileFlowToMachine(flow, { engineVersion: FLOW_MACHINE_ENGINE_VERSION })
  const provided = compiled.machine.provide(flowMachineImplementations(compiled.meta))
  const actor = createActor(provided)
  actor.start()
  for (const nodeId of path) actor.send({ type: 'PASS', nodeId, attempt: 1 })
  return { compiled, provided, actor }
}

async function seedMachine(env, runId, machine) {
  return writeRunMeta(env.runsRoot, runId, { machine })
}

// ---------------------------------------------------------------------------
// 行为用例（两种模式都跑）
// ---------------------------------------------------------------------------

async function runBehaviourSuite(mode, env) {
  console.log(`\nengine-machine · 行为用例（${mode}）`)

  await check('pass 链：三个节点依次通过 → run done，node/start 顺序正确', async () => {
    const flow = flowOf('flow-machine-pass', [
      startNode(), stage('n_a', '需求', 100), stage('n_b', '设计', 400), stage('n_c', '开发', 700), endNode(1000),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_c'), next('e4', 'n_c', 'n_end'),
    ])
    await saveFlow(env, flow)
    const run = await makeRun(env, flow.id, 3)
    const engine = engineFor(env, { activate: async ({ node }) => passResult(node.id) })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(env, run.id)
    A.equal(final.status, 'done')
    A.deepEqual(startsOf(events).map(event => `${event.nodeId}#${event.attemptId}`), ['n_a#1', 'n_b#1', 'n_c#1'])
    A.equal(events.filter(event => event.kind === 'node/end' && event.data.status === 'passed').length, 3)
    A.equal(countKind(events, 'run/end'), 1)
    const raw = readRawRun(env, run.id)
    if (mode === 'machine') {
      A.ok(raw.machine, 'run.json.machine 必须存在')
      A.equal(raw.machine.version, machineVersion(flow), 'machine.version 必须与 flow 匹配')
      A.equal(raw.machine.snapshot.value, 'done')
    } else {
      A.equal(raw.machine, undefined, 'flag=0 时旧 loop 不写 machine')
      A.equal(countKind(events, 'machine/transition'), 0, 'flag=0 时不写 machine/transition')
    }
  })

  await check('打回（显式目标）：n_c 点名打回 n_b，不取最左的 n_a', async () => {
    const flow = flowOf('flow-machine-reject-explicit', [
      startNode(), stage('n_a', '需求', 100), stage('n_b', '设计', 400), stage('n_c', '测试', 700), endNode(1000),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_c'), next('e4', 'n_c', 'n_end'),
      reject('r1', 'n_c', 'n_a'), reject('r2', 'n_c', 'n_b'),
    ])
    await saveFlow(env, flow)
    const run = await makeRun(env, flow.id, 3)
    const engine = engineFor(env, {
      activate: async ({ node, attempt }) => (node.id === 'n_c' && attempt === 1
        ? rejectResult('n_c', 'n_b')
        : passResult(node.id)),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(env, run.id)
    A.equal(final.status, 'done')
    A.deepEqual(startsOf(events).map(event => `${event.nodeId}#${event.attemptId}`),
      ['n_a#1', 'n_b#1', 'n_c#1', 'n_b#2', 'n_c#2'])
    const trigger = events.find(event => event.kind === 'reject/trigger')
    A.equal(trigger.data.fromNodeId, 'n_c')
    A.equal(trigger.data.toNodeId, 'n_b', '显式 rejectTarget 必须优先于最左兜底')
    A.equal(trigger.data.edgeId, 'r2')
    const rejectedEnd = events.find(event => event.kind === 'node/end' && event.data.status === 'rejected')
    if (mode === 'machine') {
      A.equal(rejectedEnd.data.rejectTarget, 'n_b', 'node/end.data.rejectTarget 供事件重放使用')
      const transition = events.find(event => event.kind === 'machine/transition'
        && event.data.event === 'REJECT')
      A.equal(transition.data.from, 'n_c')
      A.equal(transition.data.to, 'n_b')
    }
  })

  await check('打回（兜底）：未指定 rejectTarget → 取最靠左的上游目标 n_a', async () => {
    const flow = flowOf('flow-machine-reject-fallback', [
      startNode(), stage('n_a', '需求', 100), stage('n_b', '设计', 400), stage('n_c', '测试', 700), endNode(1000),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_c'), next('e4', 'n_c', 'n_end'),
      reject('r1', 'n_c', 'n_a'), reject('r2', 'n_c', 'n_b'),
    ])
    await saveFlow(env, flow)
    const run = await makeRun(env, flow.id, 3)
    const engine = engineFor(env, {
      activate: async ({ node, attempt }) => (node.id === 'n_c' && attempt === 1
        ? rejectResult('n_c')
        : passResult(node.id)),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(env, run.id)
    A.equal(final.status, 'done')
    const trigger = events.find(event => event.kind === 'reject/trigger')
    A.equal(trigger.data.toNodeId, 'n_a', '未指定时必须取最左目标')
    A.deepEqual(startsOf(events).map(event => `${event.nodeId}#${event.attemptId}`),
      ['n_a#1', 'n_b#1', 'n_c#1', 'n_a#2', 'n_b#2', 'n_c#2'])
  })

  await check('打回超上限：maxRounds=1 → 第二次打回落 #failed，目标节点补 node/end failed', async () => {
    const flow = flowOf('flow-machine-max-rounds', [
      startNode(), stage('n_a', '开发', 100, { maxRounds: 1 }), stage('n_b', '测试', 400), endNode(700),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'), reject('r1', 'n_b', 'n_a'),
    ])
    await saveFlow(env, flow)
    const run = await makeRun(env, flow.id, 2)
    const engine = engineFor(env, { activate: async ({ node }) => (node.id === 'n_b'
      ? rejectResult('n_b', 'n_a')
      : passResult(node.id)) })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(env, run.id)
    const runEnd = events.find(event => event.kind === 'run/end')
    A.equal(final.status, 'failed')
    A.match(runEnd.data.reason, /超打回上限/)
    A.equal(countKind(events, 'reject/trigger'), 2)
    const targetFailed = events.find(event => event.kind === 'node/end'
      && event.nodeId === 'n_a' && event.data.status === 'failed')
    A.ok(Boolean(targetFailed), '目标节点必须有一条 node/end failed')
    A.equal(targetFailed.attemptId, 2)
    A.match(targetFailed.extra.reason, /超打回上限/)
    if (mode === 'machine') {
      const transition = events.filter(event => event.kind === 'machine/transition'
        && event.data.event === 'REJECT').pop()
      A.equal(transition.data.to, '#failed', '超上限必须由状态机转到 #failed')
    }
  })

  await check('无 reject 出边却判定打回 → run failed，不猜回退目标', async () => {
    const flow = flowOf('flow-machine-no-reject', [
      startNode(), stage('n_a', '开发', 100), stage('n_b', '测试', 400), endNode(700),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_b'), next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(env, flow)
    const run = await makeRun(env, flow.id, 2)
    const engine = engineFor(env, {
      activate: async ({ node }) => (node.id === 'n_b' ? rejectResult('n_b') : passResult(node.id)),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(env, run.id)
    const runEnd = events.find(event => event.kind === 'run/end')
    A.equal(final.status, 'failed')
    A.match(runEnd.data.reason, /reject 边/)
    A.equal(countKind(events, 'reject/trigger'), 0, '没有目标就不写 reject/trigger')
    if (mode === 'machine') {
      const transition = events.filter(event => event.kind === 'machine/transition').pop()
      A.equal(transition.data.event, 'REJECT')
      A.equal(transition.data.to, '#failed')
    }
  })

  await check('节点超时：CLOCK_TIMEOUT(kind=node) → run failed，节点 extra.timeout 保留', async () => {
    const flow = flowOf('flow-machine-node-timeout', [startNode(), stage('n_wait', '等不到', 300), endNode(700)], [
      next('e1', 'n_start', 'n_wait'), next('e2', 'n_wait', 'n_end'),
    ])
    await saveFlow(env, flow)
    const run = await makeRun(env, flow.id, 1)
    const engine = engineFor(env, {
      nodeTimeoutMs: 30,
      activate: () => new Promise(() => {}),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(env, run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')
    A.equal(final.status, 'failed')
    A.equal(nodeEnd.extra.timeout, true)
    if (mode === 'machine') {
      const raw = readRawRun(env, run.id)
      A.equal(raw.machine.snapshot.context.finishedBy, 'timeout', '节点墙钟必须以 CLOCK_TIMEOUT 事件进入 #failed')
      const transition = events.filter(event => event.kind === 'machine/transition').pop()
      A.equal(transition.data.event, 'CLOCK_TIMEOUT')
      A.equal(transition.data.to, '#failed')
    }
  })

  await check('run 超时：CLOCK_TIMEOUT → run failed（runTimeout 标记），不是 aborted', async () => {
    const flow = flowOf('flow-machine-run-timeout', [startNode(), stage('n_slow', '等待', 300), endNode(700)], [
      next('e1', 'n_start', 'n_slow'), next('e2', 'n_slow', 'n_end'),
    ])
    await saveFlow(env, flow)
    const run = await makeRun(env, flow.id, 1)
    const engine = engineFor(env, {
      runTimeoutMs: 40,
      activate: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('已中止')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      }),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(env, run.id)
    const runEnd = events.find(event => event.kind === 'run/end')
    const nodeEnd = events.find(event => event.kind === 'node/end')
    A.equal(final.status, 'failed')
    A.equal(runEnd.extra.runTimeout, true)
    A.equal(nodeEnd.extra.runTimeout, true)
    if (mode === 'machine') {
      const transition = events.filter(event => event.kind === 'machine/transition').pop()
      A.equal(transition.data.event, 'CLOCK_TIMEOUT')
      A.equal(transition.data.to, '#failed')
    }
  })

  await check('取消：stop → run aborted，CANCEL 让机器进 #aborted', async () => {
    const flow = flowOf('flow-machine-cancel', [startNode(), stage('n_slow', '慢节点', 300), endNode(700)], [
      next('e1', 'n_start', 'n_slow'), next('e2', 'n_slow', 'n_end'),
    ])
    await saveFlow(env, flow)
    const run = await makeRun(env, flow.id, 1)
    const started = deferred()
    const engine = engineFor(env, {
      activate: ({ signal }) => {
        started.resolve()
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('已中止')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      },
    })
    await engine.start(run.id)
    await started.promise
    const stopped = await engine.stop(run.id)
    const events = await eventsOf(env, run.id)
    const runEnd = events.find(event => event.kind === 'run/end')
    A.equal(stopped.status, 'aborted')
    A.equal(runEnd.data.status, 'aborted')
    A.equal(events.find(event => event.kind === 'node/end').extra.aborted, true)
    if (mode === 'machine') {
      const transition = events.filter(event => event.kind === 'machine/transition').pop()
      A.equal(transition.data.event, 'CANCEL')
      A.equal(transition.data.to, '#aborted')
    }
  })

  if (mode !== 'machine') return

  // -------------------------------------------------------------------------
  // 机器专属：快照落盘 / 观测事件 / 恢复
  // -------------------------------------------------------------------------

  await check('run.json.machine：version / savedAt / snapshot 大小与终态', async () => {
    const flow = flowOf('flow-machine-snapshot', [
      startNode(), stage('n_a', '需求', 100), stage('n_b', '开发', 400), endNode(700),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_b'), next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(env, flow)
    const run = await makeRun(env, flow.id, 2)
    const engine = engineFor(env, { activate: async ({ node }) => passResult(node.id) })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    const raw = readRawRun(env, run.id)
    A.ok(raw.machine && typeof raw.machine === 'object', 'run.json.machine 必须存在')
    A.equal(raw.machine.version, machineVersion(flow))
    A.equal(typeof raw.machine.savedAt, 'string')
    A.ok(Number.isFinite(Date.parse(raw.machine.savedAt)), 'savedAt 必须是可解析的 ISO 字符串')
    A.ok(raw.machine.snapshot && typeof raw.machine.snapshot === 'object', 'snapshot 必须是普通对象')
    A.deepEqual(JSON.parse(JSON.stringify(raw.machine.snapshot)), raw.machine.snapshot, 'snapshot 必须能 JSON 往返')
    const bytes = Buffer.byteLength(JSON.stringify(raw.machine.snapshot), 'utf8')
    A.ok(bytes <= 24 * 1024, `snapshot ${bytes} 字节，必须 ≤24 KiB`)
    A.equal(raw.machineTruncated, undefined, '未超预算时不得出现 machineTruncated')
    A.equal(raw.machine.snapshot.value, 'done')
    A.equal(raw.machine.snapshot.context.finishedBy, 'pass')
  })

  await check('machine/transition：每次转移一条，字段齐全且 nodeId + attemptId 都在', async () => {
    const flow = flowOf('flow-machine-transition', [
      startNode(), stage('n_a', '需求', 100), stage('n_b', '开发', 400), endNode(700),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_b'), next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(env, flow)
    const run = await makeRun(env, flow.id, 2)
    const engine = engineFor(env, { activate: async ({ node }) => passResult(node.id) })
    await engine.start(run.id)
    await engine.wait(run.id)
    const events = await eventsOf(env, run.id)
    const transitions = events.filter(event => event.kind === 'machine/transition')
    A.equal(transitions.length, 2, '两次 PASS 转移各一条')
    for (const event of transitions) {
      A.ok(typeof event.nodeId === 'string' && event.nodeId !== '', 'machine/transition 必须带 nodeId')
      A.ok(Number.isInteger(event.attemptId) && event.attemptId >= 1, 'machine/transition 必须带 attemptId')
      A.ok(typeof event.data.from === 'string' && event.data.from !== '', 'from 必须存在（阶段间转移）')
      A.ok(typeof event.data.to === 'string' && event.data.to !== '', 'to 必填')
      A.ok(typeof event.data.event === 'string' && event.data.event !== '', 'event 必填')
      A.ok(typeof event.data.version === 'string' && event.data.version !== '', 'version 必填')
      A.ok(Buffer.byteLength(event.data.from, 'utf8') <= 64 && Buffer.byteLength(event.data.to, 'utf8') <= 64)
      A.ok(Buffer.byteLength(event.data.event, 'utf8') <= 64)
      A.equal(event.data.attempt, event.attemptId, 'data.attempt 与顶层 attemptId 一致')
      A.equal(event.data.version, machineVersion(flow))
    }
    A.deepEqual(transitions.map(event => `${event.data.from}→${event.data.to}:${event.data.event}`),
      ['n_a→n_b:PASS', 'n_b→#done:PASS'])
  })

  await check('快照指纹按 runId 隔离：同一实例先后两个 run 的同形快照都会落盘', async () => {
    const flow = flowOf('flow-machine-fingerprint', [
      startNode(), stage('n_a', '开发', 100), endNode(400),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_end'),
    ])
    await saveFlow(env, flow)
    const runA = await makeRun(env, flow.id, 1)
    const runB = await makeRun(env, flow.id, 1)
    const engine = engineFor(env)
    const snapshot = {
      status: 'active',
      value: { running: 'n_a' },
      historyValue: {},
      context: { attempts: {}, lastVerdict: null },
      children: {},
    }
    const fakeActor = { getPersistedSnapshot: () => snapshot }
    await engine._persistMachine(runA.id, 'same-version-hash', fakeActor)
    await engine._persistMachine(runB.id, 'same-version-hash', fakeActor)
    A.ok(readRawRun(env, runA.id).machine, 'run A 必须写入 machine')
    A.ok(readRawRun(env, runB.id).machine, 'run B 的同形快照不得被 run A 的指纹挡掉')
    A.equal(readRawRun(env, runB.id).machine.version, 'same-version-hash')
  })

  await check('恢复①：run.json.machine 版本匹配 + 快照可用 → 从快照接着跑（跳过 n_a）', async () => {
    const flow = flowOf('flow-machine-restore-snapshot', [
      startNode(), stage('n_a', '需求', 100), stage('n_b', '开发', 400), endNode(700),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_b'), next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(env, flow)
    const { compiled, actor } = actorAt(flow, ['n_a'])
    A.equal(actor.getSnapshot().value.running, 'n_b')
    const run = await makeRun(env, flow.id, 2)
    await seedMachine(env, run.id, {
      version: compiled.version,
      snapshot: JSON.parse(JSON.stringify(actor.getPersistedSnapshot())),
      savedAt: new Date().toISOString(),
    })
    const logs = []
    const engine = engineFor(env, {
      activate: async ({ node }) => passResult(node.id),
      log: (level, message) => logs.push(`${level}:${message}`),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(env, run.id)
    A.equal(final.status, 'done')
    A.deepEqual(startsOf(events).map(event => event.nodeId), ['n_b'], '只执行快照所在节点 n_b')
    A.ok(logs.some(line => /从快照恢复/.test(line)), '日志必须说明恢复来源')
  })

  await check('恢复②：machine.version 不匹配 → 从事件流重放（跳过 n_a）', async () => {
    const flow = flowOf('flow-machine-restore-replay', [
      startNode(), stage('n_a', '需求', 100), stage('n_b', '开发', 400), endNode(700),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_b'), next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(env, flow)
    const { compiled, actor } = actorAt(flow, ['n_a'])
    const run = await makeRun(env, flow.id, 2)
    await seedMachine(env, run.id, {
      version: 'ffffffffffffffff',
      snapshot: JSON.parse(JSON.stringify(actor.getPersistedSnapshot())),
      savedAt: new Date().toISOString(),
    })
    await appendEvents(env.runsRoot, run.id, [{
      v: 1,
      kind: 'node/end',
      nodeId: 'n_a',
      attemptId: 1,
      traceId: `tr-${run.id}-n_a-1`,
      data: { status: 'passed', durationMs: 1 },
    }])
    const logs = []
    const engine = engineFor(env, {
      activate: async ({ node }) => passResult(node.id),
      log: (level, message) => logs.push(`${level}:${message}`),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(env, run.id)
    A.equal(final.status, 'done')
    A.deepEqual(startsOf(events).map(event => event.nodeId), ['n_b'], '重放到 n_b，不再执行 n_a')
    A.ok(logs.some(line => /从事件流重放（1 条）/.test(line)), '日志必须说明走了重放')
    const raw = readRawRun(env, run.id)
    A.equal(raw.machine.version, compiled.version, '跑完后 machine.version 必须更新为本地版本')
  })

  await check('恢复③：两次恢复都失败 → run failed，reason 含 machine-restore-failed', async () => {
    const flow = flowOf('flow-machine-restore-fail', [
      startNode(), stage('n_a', '开发', 100), stage('n_b', '测试', 400), endNode(700),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_b'), next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(env, flow)
    const run = await makeRun(env, flow.id, 2)
    const logs = []
    const engine = engineFor(env, {
      activate: async ({ node }) => passResult(node.id),
      log: (level, message) => logs.push(`${level}:${message}`),
    })
    // 稳定复现「快照/事件流两条恢复都失败」：直接替换恢复入口，不依赖某条 flow
    // 恰好能过校验却编译失败（那种口径不一致已由 validateFlowForRun 收口）。
    engine._restoreMachineActor = async () => ({
      actor: null,
      source: null,
      error: new Error('stub：快照与事件流都不可用'),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(env, run.id)
    const runEnd = events.find(event => event.kind === 'run/end')
    A.equal(final.status, 'failed')
    A.match(runEnd.data.reason, /machine-restore-failed/)
    A.equal(runEnd.extra.error, 'MachineRestoreFailed')
    A.equal(startsOf(events).length, 0, '恢复失败时不得执行任何节点')
    A.ok(logs.some(line => /状态机恢复失败/.test(line)), '恢复失败必须写日志')
  })

  await check('恢复④：快照状态 id 非法 → 在 createActor 之前挡下，改走事件重放', async () => {
    const flow = flowOf('flow-machine-restore-shape', [
      startNode(), stage('n_a', '开发', 100), endNode(400),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_end'),
    ])
    await saveFlow(env, flow)
    const { compiled, provided } = actorAt(flow)
    const run = await makeRun(env, flow.id, 1)
    await seedMachine(env, run.id, {
      version: compiled.version,
      snapshot: { status: 'active', value: { running: 'n_missing' }, context: {}, children: {} },
      savedAt: new Date().toISOString(),
    })
    const engine = engineFor(env)
    const result = await engine._restoreMachineActor(run.id, provided, compiled.version, compiled.meta.stageIds)
    A.equal(Boolean(result.actor), true, '快照不可用时应回退到事件重放（空事件流 → 初始态）')
    A.equal(result.source, 'replay')
    A.equal(result.actor.getSnapshot().value.running, 'n_a')
    A.ok(result.snapshotError instanceof Error, '快照被拒原因必须保留')
  })

  await check('恢复④b：版本匹配但快照结构不可用 → error 通道接住，不抛进程级异常并落回重放', async () => {
    const flow = flowOf('flow-machine-restore-error-channel', [
      startNode(), stage('n_a', '开发', 100), stage('n_b', '测试', 400), endNode(700),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_b'), next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(env, flow)
    const { compiled, provided } = actorAt(flow)
    const run = await makeRun(env, flow.id, 2)
    // value.running 是合法节点（能过形状预检），但多出的 child state 让 XState 在
    // start 时进入 error 状态；它默认会用 setTimeout 重抛，不接 error 通道就是进程级
    // uncaughtException。这条用例专门证明「不会再发生」。
    await seedMachine(env, run.id, {
      version: compiled.version,
      snapshot: {
        status: 'active',
        value: { running: 'n_a', other: 'x' },
        historyValue: {},
        context: {},
        children: {},
      },
      savedAt: new Date().toISOString(),
    })
    const uncaught = []
    const onUncaught = error => { uncaught.push(error) }
    process.on('uncaughtException', onUncaught)
    try {
      const engine = engineFor(env)
      const result = await engine._restoreMachineActor(run.id, provided, compiled.version, compiled.meta.stageIds)
      await new Promise(resolve => setTimeout(resolve, 50))
      A.equal(uncaught.length, 0, '恢复失败不得变成进程级 uncaughtException')
      A.equal(Boolean(result.actor), true, '必须落回事件重放，而不是假装快照可用')
      A.equal(result.source, 'replay')
      A.equal(result.actor.getSnapshot().value.running, 'n_a')
      A.ok(result.snapshotError instanceof Error, '必须保留快照恢复失败的原因')
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })

  await check('恢复⑤：快照版本不匹配 + 事件流也读不出 → _restoreMachineActor 返回 null + error', async () => {
    const flow = flowOf('flow-machine-restore-both', [
      startNode(), stage('n_a', '开发', 100), endNode(400),
    ], [
      next('e1', 'n_start', 'n_a'), next('e2', 'n_a', 'n_end'),
    ])
    await saveFlow(env, flow)
    const { compiled, provided } = actorAt(flow)
    const run = await makeRun(env, flow.id, 1)
    // 版本不匹配 → 快照不能用；把 run.jsonl 换成目录 → 事件流读取必然失败。
    await seedMachine(env, run.id, {
      version: 'ffffffffffffffff',
      snapshot: JSON.parse(JSON.stringify(actorAt(flow, ['n_a']).actor.getPersistedSnapshot())),
      savedAt: new Date().toISOString(),
    })
    const runDir = join(env.runsRoot, run.id)
    rmSync(join(runDir, 'run.jsonl'), { force: true, recursive: true })
    mkdirSync(join(runDir, 'run.jsonl'))
    const engine = engineFor(env)
    const result = await engine._restoreMachineActor(run.id, provided, compiled.version, compiled.meta.stageIds)
    A.equal(Boolean(result.actor), false, '两次恢复都失败时 actor 必须是 null')
    A.ok(Boolean(result.error), '两次恢复都失败时必须带回 error')
  })
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const envs = { machine: makeEnv('machine'), legacy: makeEnv('legacy') }
try {
  console.log('engine-machine · 默认（actor 驱动）')
  delete process.env.FLOW_STUDIO_FLOW_MACHINE
  await runBehaviourSuite('machine', envs.machine)

  console.log('\nengine-machine · FLOW_STUDIO_FLOW_MACHINE=0（旧 loop）')
  process.env.FLOW_STUDIO_FLOW_MACHINE = '0'
  await runBehaviourSuite('legacy', envs.legacy)
} finally {
  delete process.env.FLOW_STUDIO_FLOW_MACHINE
  for (const env of Object.values(envs)) rmSync(env.home, { recursive: true, force: true })
}

console.log(`\n${checks} 组通过（${assertions} 条断言）`)
