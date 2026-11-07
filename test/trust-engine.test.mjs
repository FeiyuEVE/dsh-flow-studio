#!/usr/bin/env node
/**
 * 0.11「可信」引擎侧验收（R1 续租失权 / R5 宿主检查 / R6 自报证据降级）。
 *
 * 与 engine.test.mjs 分开的原因：这三条是 0.11 新增的可信防线，需要频繁做
 * 「把修复改回旧行为 → 用例必红」的 mutation 验证；单独一个文件跑一遍是秒级，
 * 不必每次等 130 组主循环用例。
 *
 * 全部走注入桩：不启动 dsh、不调模型、不 import 任何 dsh 包。
 * 夹具落在项目 `.tmp/` 下，不占系统 /tmp。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-trust-'))
const workspace = join(home, 'workspace')
mkdirSync(workspace, { recursive: true })

const engineModule = await import('../src/engine.js')
const store = await import('../src/runstore.js')
const flowStore = await import('../src/store.js')
const { summarize } = await import('../src/runlog.js')

const { createEngine: createEngineRaw } = engineModule

const runsRoot = store.runsDir(home)
const flowsRoot = flowStore.flowsDir(home)
const createEngine = (options = {}) => createEngineRaw({ worktree: 'off', cwd: workspace, ...options })

let checks = 0
let assertions = 0
const A = {
  equal(actual, expected, message) {
    assertions += 1
    assert.equal(actual, expected, message)
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
    outputs: '',
    skills: [],
    maxRounds: 2,
    team: [],
    model: '',
    ...extra,
  }
}
function startNode() {
  return {
    id: 'n_start', kind: 'start', title: '任务输入', x: 0, y: 200, mode: 'single',
    role: '', task: '接任务', outputs: '', skills: [], maxRounds: 2, team: [], model: '',
  }
}
function endNode() {
  return {
    id: 'n_end', kind: 'end', title: '完成', x: 900, y: 200, mode: 'single',
    role: '', task: '', outputs: '', skills: [], maxRounds: 2, team: [], model: '',
  }
}
function next(id, from, to) {
  return { id, kind: 'next', from, to }
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
async function saveFlow(flow) {
  await flowStore.saveFlow(flowsRoot, flow.id, flow)
}
async function makeRun(flowId, nodeTotal) {
  return store.createRun(runsRoot, { flowId, flowName: `流程 ${flowId}`, nodeTotal })
}
async function eventsOf(runId) {
  const all = await store.readAllEvents(runsRoot, runId)
  return all ? all.events : []
}
function countKind(events, kind) {
  return events.filter(event => event.kind === kind).length
}
function deferred() {
  let resolveFn
  const promise = new Promise(resolve => { resolveFn = resolve })
  return { promise, resolve: resolveFn }
}
function passOf(nodeId) {
  return {
    structured: {
      verdict: 'pass',
      summary: `${nodeId} 通过`,
      findings: [{ id: `${nodeId}-F1`, severity: 'P2', title: '小问题', status: 'verified' }],
    },
    sessionId: `sess-${nodeId}`,
    dispose: async () => {},
  }
}
const oneStageFlow = id => flowOf(id, [startNode(), stage(`n_${id}`, '长任务', 300), endNode()], [
  next('e1', 'n_start', `n_${id}`),
  next('e2', `n_${id}`, 'n_end'),
])

try {
  // -------------------------------------------------------------------------
  // R1/E1：续租 409 → 立即停跑、唯一 failed(lease-lost)、旧实例零业务写
  // -------------------------------------------------------------------------
  const runLeaseLostScenario = async (id, { legacy }) => {
    const flow = oneStageFlow(id)
    await saveFlow(flow)
    const run = await makeRun(id, 1)
    const entered = deferred()
    const gate = deferred()
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      renewLease: async () => {
        const error = new Error('执行租约由 other@host 持有，本实例无权续租')
        error.status = 409
        throw error
      },
      activate: async ({ node }) => {
        entered.resolve()
        await gate.promise
        return passOf(node.id)
      },
    })
    if (legacy) process.env.FLOW_STUDIO_FLOW_MACHINE = '0'
    try {
      await engine.start(run.id, { workspace })
      await entered.promise
      A.equal(engine.leaseLost, false, '正常运行时不能被误判失权')
      await engine._renewLeaseOnce(run.id)
      A.equal(engine.leaseLost, true, '续租 409 必须立刻标记失权')

      const final = await Promise.race([
        engine.wait(run.id),
        new Promise(resolve => setTimeout(() => resolve(null), 3000)),
      ])
      A.ok(Boolean(final), '续租 409 后旧实例必须在 3s 内收口（旧行为会继续跑）')
      if (!final) {
        await engine.stop(run.id).catch(() => {})
        return
      }
      const events = await eventsOf(run.id)
      const end = events.filter(event => event.kind === 'run/end').at(-1)
      A.equal(final.status, 'failed', '失权 run 终态必须是 failed，不能是 aborted / done')
      A.ok(Boolean(end), '失权必须写 run/end')
      A.match(String(end.data.reason), /lease-lost/, 'run/end.reason 必须标明 lease-lost')
      A.equal(end.extra && end.extra.code, 'LEASE_LOST', 'run/end.extra.code=LEASE_LOST')
      A.equal(end.extra && end.extra.terminalScope, 'run', '失权 end 是 run 范围终态')
      A.equal(events.filter(event => event.kind === 'run/end').length, 1, '失权 epoch 只能有一条 run/end')

      const frozen = events.length
      const dropped = await engine._append(run.id, [{
        kind: 'node/start',
        nodeId: `n_${id}`,
        attemptId: 2,
        traceId: `tr-late-${id}`,
        data: { title: '迟到节点', mode: 'single', skills: [] },
      }])
      A.equal(dropped.dropped, 1, '失权后的 _append 必须报告丢弃条数')
      gate.resolve()
      await new Promise(resolve => setTimeout(resolve, 50))
      await engine.flushEvents()
      A.equal((await eventsOf(run.id)).length, frozen, '失权后旧实例不得再写任何事件')
      A.equal(countKind(await eventsOf(run.id), 'node/end'), 0, '迟到的 pass 结果不得补写 node/end')
    } finally {
      if (legacy) delete process.env.FLOW_STUDIO_FLOW_MACHINE
      gate.resolve()
    }
  }

  await check('R1/E1（状态机循环）：续租 409 → 失权停跑、唯一 lease-lost end、旧实例零业务写', async () => {
    await runLeaseLostScenario('flow-lease-lost', { legacy: false })
  })

  await check('R1/E1（旧 while 循环）：续租 409 同样停跑并写 lease-lost end', async () => {
    await runLeaseLostScenario('flow-lease-lost-legacy', { legacy: true })
  })

  await check('R1/E1：续租 I/O 错误（EIO）只 warn，不误判失权，run 照常跑完', async () => {
    const flow = oneStageFlow('flow-lease-eio')
    await saveFlow(flow)
    const run = await makeRun('flow-lease-eio', 1)
    const gate = deferred()
    const warned = []
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      log: (level, message) => {
        if (level === 'warn') warned.push(String(message))
      },
      renewLease: async () => {
        const error = new Error('EIO: i/o error, write lock.json')
        error.code = 'EIO'
        throw error
      },
      activate: async ({ node }) => {
        await gate.promise
        return passOf(node.id)
      },
    })
    await engine.start(run.id, { workspace })
    await engine._renewLeaseOnce(run.id)
    A.equal(engine.leaseLost, false, 'I/O 瞬时错误不能当成失权')
    A.ok(warned.some(line => /续租失败/.test(line)), 'I/O 错误必须 warn（可诊断）')
    gate.resolve()
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done', 'I/O 错误后 run 必须正常跑完')
    A.equal(countKind(await eventsOf(run.id), 'run/end'), 1)
  })

  // -------------------------------------------------------------------------
  // R5：保存的检查命令由宿主真正执行（agent 报 pass 也不能顶掉 host fail）
  // -------------------------------------------------------------------------
  const hostCheckFlow = id => flowOf(id, [
    startNode(),
    stage('n_hostcheck', '实现', 300, { check: { command: 'exit 1', expectExitCode: 0 } }),
    endNode(),
  ], [next('e1', 'n_start', 'n_hostcheck'), next('e2', 'n_hostcheck', 'n_end')])

  await check('R5：宿主检查 exit 1 → producer=host 的 fail 落盘；agent 仍 pass、run done，quality=fail', async () => {
    process.env.FLOW_STUDIO_ALLOW_HOST_CHECKS = '1'
    try {
      const flow = hostCheckFlow('flow-hostcheck-fail')
      await saveFlow(flow)
      const run = await makeRun('flow-hostcheck-fail', 1)
      const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
      await engine.start(run.id, { workspace })
      const final = await engine.wait(run.id)
      const events = await eventsOf(run.id)
      const hostEvent = events.find(event => event.kind === 'check/form' && event.extra && event.extra.producer === 'host')
      const nodeEnd = events.find(event => event.kind === 'node/end')
      const runEnd = events.find(event => event.kind === 'run/end')
      const hostArtifact = events.find(event => event.kind === 'artifact/write'
        && event.extra && event.extra.producer === 'host')
      const summary = summarize(events)

      A.equal(final.status, 'done', '宿主检查失败不能改节点业务 verdict / run 终态')
      A.equal(nodeEnd.data.status, 'passed', 'agent 自报 pass 保留')
      A.equal(runEnd.data.status, 'done')
      A.ok(Boolean(hostEvent), '必须写 producer=host 的 check/form')
      A.equal(hostEvent.data.ruleSetId, 'host:n_hostcheck')
      A.equal(hostEvent.data.executor, 'host')
      A.equal(hostEvent.data.state, 'fail', '真实 exit 1 必须判 fail')
      A.equal(hostEvent.data.passedChecks, 0)
      A.equal(hostEvent.data.totalChecks, 1)
      A.ok(Boolean(hostArtifact), '宿主执行记录必须落成 producer=host 的产物')
      A.ok(events.indexOf(hostEvent) < events.indexOf(nodeEnd), '宿主检查必须在 node/end 之前完成')
      A.equal(summary.quality.state, 'fail', '宿主失败必须压过 agent 自报 pass：quality=fail')
    } finally {
      delete process.env.FLOW_STUDIO_ALLOW_HOST_CHECKS
    }
  })

  await check('R5：检查开关关闭 → 引擎不执行、不伪造 host pass（quality 不会变绿）', async () => {
    delete process.env.FLOW_STUDIO_ALLOW_HOST_CHECKS
    const flow = hostCheckFlow('flow-hostcheck-off')
    await saveFlow(flow)
    const run = await makeRun('flow-hostcheck-off', 1)
    const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
    await engine.start(run.id, { workspace })
    await engine.wait(run.id)
    const events = await eventsOf(run.id)
    A.equal(events.some(event => event.kind === 'check/form' && event.extra && event.extra.producer === 'host'), false,
      '开关关闭时不得执行 / 伪造宿主检查')
    A.ok(summarize(events).quality.state !== 'pass', '开关关闭时 quality 不得为 pass')
  })

  // -------------------------------------------------------------------------
  // R6/E4：模型自报 29/29、报告是引擎自己写的 → 只能算 claimed，不能变绿
  // -------------------------------------------------------------------------
  await check('R6/E4：tests 29/29 无独立报告（引擎自写）→ claimed/unknown，quality 不绿', async () => {
    const flow = flowOf('flow-evidence-claimed', [
      startNode(), stage('n_claim', '测试', 300), endNode(),
    ], [next('e1', 'n_start', 'n_claim'), next('e2', 'n_claim', 'n_end')])
    await saveFlow(flow)
    const run = await makeRun('flow-evidence-claimed', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => ({
        structured: {
          verdict: 'pass',
          summary: '29/29 全过',
          tests: { suite: 'unit-claimed', executed: 29, passed: 29, failed: 0, skipped: 0 },
        },
        sessionId: `sess-${node.id}`,
        dispose: async () => {},
      }),
    })
    await engine.start(run.id, { workspace })
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const testEvent = events.find(event => event.kind === 'test/report')
    const summary = summarize(events)

    A.equal(final.status, 'done')
    A.ok(Boolean(testEvent), 'test/report 必须落盘（自报事实保留）')
    A.equal(testEvent.extra && testEvent.extra.generatedReport, true, '引擎自写报告必须打 generatedReport 标记')
    A.equal(summary.quality.evidence.tests.state, 'unknown', '自写报告的 pass 只能算 claimed，指标不得为 pass')
    A.match(String(summary.quality.evidence.tests.reason), /自报报告/, 'reason 必须说明缺独立证据')
    A.equal(summary.quality.evidence.tests.claimedPassed, 1)
    A.equal(summary.quality.evidence.tests.authoritativePassed, 0)
    A.ok(summary.quality.state !== 'pass', '自报 29/29 不能把 quality 洗绿')
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${checks} 组通过（${assertions} 条断言）`)
