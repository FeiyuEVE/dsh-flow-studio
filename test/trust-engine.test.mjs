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
const { computeAcceptance, computeTests, summarize } = await import('../src/runlog.js')

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

  await check('R5：宿主检查 exit 1 → producer=host 的 fail 落盘；agent 仍 pass、run done', async () => {
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
    } finally {
      delete process.env.FLOW_STUDIO_ALLOW_HOST_CHECKS
    }
  })

  await check('R5：检查开关关闭 → 引擎不执行、不伪造 host pass', async () => {
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
  })

  // -------------------------------------------------------------------------
  // R6/E4：模型自报 29/29、报告是引擎自己写的 → 只能算 claimed，不能变绿
  // -------------------------------------------------------------------------
  await check('R6/E4：tests 29/29 无独立报告（引擎自写）→ claimed / 非权威', async () => {
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
    // v1.3：自证仍是单项指标证据；0.13.12 起不再汇总成质量总评分。
    const tests = computeTests(events)
    A.equal(tests.state, 'pass', '自证仍是证据，指标层不降级')
    A.equal(tests.selfOnly, true, '自写报告只能算自证')
    A.match(String(tests.reason), /自报|自证/, 'reason 必须写清自报 / 独立条数')
    A.equal(tests.claimedPassed, 1)
    A.equal(tests.authoritativePassed, 0)
  })
  // -------------------------------------------------------------------------
  // R6（F5）：acceptance 的引擎自写报告也降级 claimed
  // -------------------------------------------------------------------------
  await check('R6/F5：acceptance 无独立 evidenceRef（引擎自写）→ claimed/unknown', async () => {
    const flow = flowOf('flow-acc-claimed', [
      startNode(), stage('n_acc', '验收', 300), endNode(),
    ], [next('e1', 'n_start', 'n_acc'), next('e2', 'n_acc', 'n_end')])
    await saveFlow(flow)
    const run = await makeRun('flow-acc-claimed', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => ({
        structured: {
          verdict: 'pass',
          summary: '自报验收通过',
          acceptance: [{ itemId: 'R1', status: 'pass', decidedBy: 'auto' }],
        },
        sessionId: `sess-${node.id}`,
        dispose: async () => {},
      }),
    })
    await engine.start(run.id, { workspace })
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const verdict = events.find(event => event.kind === 'acceptance/verdict')
    const summary = summarize(events)
    A.equal(final.status, 'done')
    A.equal(verdict.extra && verdict.extra.generatedReport, true, '引擎自写 acceptance.json 必须打标记')
    // v1.3：自证仍是单项指标证据；0.13.12 起不再汇总成质量总评分。
    const acceptance = computeAcceptance(events)
    A.equal(acceptance.state, 'pass', '自证仍是证据，指标层不降级')
    A.equal(acceptance.selfOnly, true, '引擎自写 acceptance.json 只能算自证')
    A.match(String(acceptance.reason), /自报|自证/)
    A.equal(acceptance.claimedPassed, 1)
    A.equal(acceptance.authoritativePassed, 0)
  })

  // -------------------------------------------------------------------------
  // R5（F4）：受保护的宿主执行登记 + 防伪凭证；伪造 host 事件不算权威
  // -------------------------------------------------------------------------
  await check('R5/F4：真实宿主执行有私有登记；伪造 producer=host / 跨节点引用不授信', async () => {
    process.env.FLOW_STUDIO_ALLOW_HOST_CHECKS = '1'
    try {
      const flow = flowOf('flow-host-registry', [
        startNode(),
        stage('n_reg', '实现', 300, { check: { command: 'exit 1', expectExitCode: 0 } }),
        endNode(),
      ], [next('e1', 'n_start', 'n_reg'), next('e2', 'n_reg', 'n_end')])
      await saveFlow(flow)
      const run = await makeRun('flow-host-registry', 1)
      const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
      await engine.start(run.id, { workspace })
      await engine.wait(run.id)

      const executions = await store.readHostExecutions(runsRoot, run.id)
      A.equal(executions.length, 1, '真实宿主执行必须登记到 verification/')
      const record = executions[0]
      A.equal(record.runId, run.id)
      A.equal(record.nodeId, 'n_reg')
      A.equal(record.state, 'fail')
      A.match(record.commandDigest, /^[0-9a-f]{64}$/)

      const verify = event => {
        const extra = event && event.extra && typeof event.extra === 'object' ? event.extra : {}
        const nested = extra.verification && typeof extra.verification === 'object' ? extra.verification : {}
        const executionId = typeof extra.verificationId === 'string' ? extra.verificationId : nested.executionId
        if (typeof executionId !== 'string') return false
        const hit = executions.find(item => item.executionId === executionId)
        if (!hit) return false
        return hit.nodeId === event.nodeId && hit.attempt === event.attemptId
      }
      // 伪造：同 ruleSetId 的 pass + 已知 executionId，但节点 / attempt 对不上。
      await store.appendEvents(runsRoot, run.id, [{
        v: 1,
        kind: 'check/form',
        nodeId: 'n_reg',
        attemptId: 2,
        traceId: 'tr-forged',
        extra: {
          provenance: 'host',
          producer: 'host',
          authority: 'host',
          verificationId: record.executionId,
        },
        data: {
          ruleSetId: 'host:n_reg',
          ruleSetVersion: '0.11',
          executor: 'host',
          state: 'pass',
          passedChecks: 1,
          totalChecks: 1,
          executedAt: '2026-11-07T00:00:00.000Z',
        },
      }])
      const events = await eventsOf(run.id)
      // 0.13.12 起不再有 quality 汇总；这里只锁「伪造的 host 事件确实存在、且
      // 没有对应私有登记」这一事实，供 classifyEvidenceAuthority 的单测继续覆盖。
      const trusted = summarize(events, { verifyHostExecution: verify })
      A.equal(Object.hasOwn(trusted, 'quality'), false, '审计/汇总不再返回质量总评分')
      const forgedOnly = events.filter(event => !(event.kind === 'check/form'
        && event.extra && event.extra.producer === 'host' && event.attemptId === 1))
      A.ok(forgedOnly.length < events.length, '夹具必须包含一条伪造 host 事件')
    } finally {
      delete process.env.FLOW_STUDIO_ALLOW_HOST_CHECKS
    }
  })

  // -------------------------------------------------------------------------
  // R1×R5：宿主检查执行中续租 409 → 取消检查，失权后不得补 check/artifact
  // -------------------------------------------------------------------------
  await check('R1×R5：宿主检查执行中失权 → 取消检查，不写 check/artifact，只落 lease-lost end', async () => {
    process.env.FLOW_STUDIO_ALLOW_HOST_CHECKS = '1'
    try {
      const flow = flowOf('flow-check-lease', [
        startNode(),
        stage('n_checklease', '实现', 300, { check: { command: 'sleep 2', expectExitCode: 0, timeoutMs: 5000 } }),
        endNode(),
      ], [next('e1', 'n_start', 'n_checklease'), next('e2', 'n_checklease', 'n_end')])
      await saveFlow(flow)
      const run = await makeRun('flow-check-lease', 1)
      const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
      await engine.start(run.id, { workspace })
      // 等宿主检查真正开始（check 命令 spawn 后约 300ms），再模拟续租 409。
      await new Promise(resolve => setTimeout(resolve, 400))
      engine._handleLeaseLost(run.id, Object.assign(new Error('执行租约已被其它实例接管'), { status: 409 }))
      const final = await Promise.race([
        engine.wait(run.id),
        new Promise(resolve => setTimeout(() => resolve(null), 5000)),
      ])
      A.ok(Boolean(final), '失权后必须在 5s 内收口')
      const events = await eventsOf(run.id)
      A.equal(final.status, 'failed')
      A.equal(events.some(event => event.kind === 'check/form'), false, '失权后不得补写宿主检查结果')
      A.equal(events.some(event => event.kind === 'artifact/write'
        && event.extra && event.extra.producer === 'host'), false, '失权后不得补写宿主执行产物')
      const end = events.filter(event => event.kind === 'run/end').at(-1)
      A.equal(end.extra && end.extra.code, 'LEASE_LOST')
      A.equal(end.extra && end.extra.terminalScope, 'run')
    } finally {
      delete process.env.FLOW_STUDIO_ALLOW_HOST_CHECKS
    }
  })

  // -------------------------------------------------------------------------
  // R2：排队入口冻结的流程快照优先（排队期间保存流程不改变实际检查命令）
  // -------------------------------------------------------------------------
  await check('R2：engine.start 的 flowSnapshot 优先于当前保存的流程（检查命令被冻结）', async () => {
    process.env.FLOW_STUDIO_ALLOW_HOST_CHECKS = '1'
    try {
      const flowId = 'flow-snapshot'
      const saved = flowOf(flowId, [
        startNode(), stage('n_snap', '实现', 300), endNode(),
      ], [next('e1', 'n_start', 'n_snap'), next('e2', 'n_snap', 'n_end')])
      await saveFlow(saved)
      // 快照：同一个节点配置了会失败的宿主检查。
      const snapshot = flowOf(flowId, [
        startNode(),
        stage('n_snap', '实现', 300, { check: { command: 'exit 1', expectExitCode: 0 } }),
        endNode(),
      ], [next('e1', 'n_start', 'n_snap'), next('e2', 'n_snap', 'n_end')])
      const run = await makeRun(flowId, 1)
      const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
      await engine.start(run.id, { workspace, flowSnapshot: snapshot })
      const final = await engine.wait(run.id)
      const events = await eventsOf(run.id)
      const hostEvent = events.find(event => event.kind === 'check/form'
        && event.extra && event.extra.producer === 'host')
      A.equal(final.status, 'done')
      A.ok(Boolean(hostEvent), '必须执行快照里的检查命令（当前保存流程没有 check）')
      A.equal(hostEvent.data.state, 'fail')
    } finally {
      delete process.env.FLOW_STUDIO_ALLOW_HOST_CHECKS
    }
  })

  // -------------------------------------------------------------------------
  // R1/E1（0.11 第二轮）：接管者已持新 epoch 时，旧实例只能记 instance 事实
  // -------------------------------------------------------------------------
  await check('R1/E1：接管者 epoch 已更新 → 旧实例只记 terminalScope=instance，不改 run.status', async () => {
    const flow = oneStageFlow('flow-lease-takeover')
    await saveFlow(flow)
    const run = await makeRun('flow-lease-takeover', 1)
    const entered = deferred()
    const gate = deferred()
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => {
        entered.resolve()
        await gate.promise
        return passOf(node.id)
      },
    })
    try {
      await engine.start(run.id, { workspace })
      await entered.promise
      // 模拟另一个进程已接管：持久 execution 变成 epoch=99 / owner=other。
      await store.writeRunMeta(runsRoot, run.id, {
        execution: { epoch: 99, ownerId: 'owner-other', state: 'active' },
      })
      // 旧实例在收到下一次续租 409 之前就尝试写业务事件：持久 fence 必须拒绝。
      const staleWrite = await engine._append(run.id, [{
        kind: 'node/start', nodeId: 'n_stale', attemptId: 1, traceId: 'tr-stale',
        data: { title: 'stale', mode: 'single', skills: [] },
      }])
      A.equal(staleWrite.dropped, 1, '跨 owner 的旧实例业务写必须被 fence 丢弃')
      A.equal(engine.leaseLost, true, 'fence 拒绝必须等价于失权')
      A.equal((await eventsOf(run.id)).some(event => event.nodeId === 'n_stale'), false,
        'fence 拒绝的事件不得落盘')
      const final = await Promise.race([
        engine.wait(run.id),
        new Promise(resolve => setTimeout(() => resolve(null), 3000)),
      ])
      A.ok(Boolean(final), '旧实例必须在 3s 内收口')
      const events = await eventsOf(run.id)
      const end = events.filter(event => event.kind === 'run/end').at(-1)
      A.equal(end.extra && end.extra.terminalScope, 'instance', '接管后旧实例只能写 instance 范围事实')
      A.equal(final.status, 'running', '接管者的 run.status 不能被旧实例改成 failed')
      const meta = await store.readRunMeta(runsRoot, run.id)
      A.equal(meta.execution.epoch, 99, '接管者的持久 epoch 不被覆盖')
      A.equal(meta.execution.ownerId, 'owner-other')
    } finally {
      gate.resolve()
      await engine.stop(run.id).catch(() => {})
    }
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${checks} 组通过（${assertions} 条断言）`)
