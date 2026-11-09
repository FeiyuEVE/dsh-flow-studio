#!/usr/bin/env node
/**
 * 工作流健康审计纯函数自检：判据顺序 / verdict / recommended / nextCheck / 坏输入不抛错。
 *
 * 不需要浏览器也不碰 fs：直接 `node test/audit.test.mjs`。
 */

import assert from 'node:assert/strict'

import { AUDIT_VERDICTS, auditWorkflow } from '../src/audit.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

/** 所有时间都相对同一个基准点，审计结果与真实墙钟无关。 */
const BASE_TS = Date.parse('2026-11-06T12:00:00.000Z')
const isoAt = (minutes = 0, seconds = 0) => new Date(BASE_TS + (minutes * 60 + seconds) * 1000).toISOString()
const msAt = (minutes = 0, seconds = 0) => BASE_TS + (minutes * 60 + seconds) * 1000

const RUN_ID = 'r-audit'

/** 标准六节点模板：开始 → 需求 → 结构 → 开发 → 测试 → 结束，含两条打回边。 */
const FLOW = {
  nodes: [
    { id: 'n_start', kind: 'start', title: '任务输入' },
    { id: 'n_req', kind: 'stage', title: '需求分析' },
    { id: 'n_shape', kind: 'stage', title: '结构设计' },
    { id: 'n_dev', kind: 'stage', title: '开发' },
    { id: 'n_test', kind: 'stage', title: '测试' },
    { id: 'n_end', kind: 'end', title: '完成' },
  ],
  edges: [
    { id: 'e1', from: 'n_start', to: 'n_req', kind: 'next' },
    { id: 'e2', from: 'n_req', to: 'n_shape', kind: 'next' },
    { id: 'e3', from: 'n_shape', to: 'n_dev', kind: 'next' },
    { id: 'e4', from: 'n_dev', to: 'n_test', kind: 'next' },
    { id: 'e5', from: 'n_test', to: 'n_end', kind: 'next' },
    { id: 'er1', from: 'n_dev', to: 'n_req', kind: 'reject' },
    { id: 'er2', from: 'n_test', to: 'n_dev', kind: 'reject' },
  ],
}

const TITLES = {
  n_req: '需求分析',
  n_shape: '结构设计',
  n_dev: '开发',
  n_test: '测试',
}

/** 契约里的固定映射；测试与文档 §14 共用这一份口径。 */
const NEXT_CHECK_SECONDS = {
  pending: 30,
  healthy: 180,
  stalled: 60,
  looping: 60,
  deviating: 60,
  'no-progress': 60,
  failed: null,
  done: null,
  aborted: null,
}
const RECOMMENDED = {
  pending: 'inspect',
  healthy: 'wait',
  stalled: 'inspect',
  looping: 'stop',
  deviating: 'stop',
  'no-progress': 'inspect',
  failed: 'report',
  done: 'report',
  aborted: 'report',
}

/** 每份审计结果都要满足的字段契约 + verdict 对应的 recommended / nextCheck。 */
function assertContract(audit, expectedVerdict) {
  assert.ok(AUDIT_VERDICTS.includes(audit.verdict), `verdict 越界：${audit.verdict}`)
  if (expectedVerdict) assert.equal(audit.verdict, expectedVerdict)
  assert.equal(typeof audit.headline, 'string')
  assert.ok(Array.from(audit.headline).length <= 120, `headline 超过 120 字：${audit.headline}`)
  assert.ok(['wait', 'report', 'stop', 'inspect'].includes(audit.recommended))
  assert.equal(audit.recommended, RECOMMENDED[audit.verdict])
  assert.equal(audit.nextCheckSeconds, NEXT_CHECK_SECONDS[audit.verdict])
  assert.ok(Array.isArray(audit.anomalies))
  assert.ok(Number.isInteger(audit.progress.passed) && audit.progress.passed >= 0)
  assert.ok(Number.isInteger(audit.progress.total) && audit.progress.total >= 0)
  assert.ok(audit.progress.ratio === null || (audit.progress.ratio >= 0 && audit.progress.ratio <= 1))
  assert.ok(Array.isArray(audit.progress.nodes))
  // restart 续跑：跳过节点单列返回（没有 restart 时是空数组 / 0，字段恒定存在）。
  assert.ok(Array.isArray(audit.progress.skipped))
  assert.equal(audit.progress.skippedCount, audit.progress.skipped.length)
  // 判定依据：本次实际用的阈值 + 来源（run.json.limits / 默认值）。
  assert.ok(audit.thresholds && typeof audit.thresholds === 'object')
  assert.ok(Number.isInteger(audit.thresholds.stallMs) && audit.thresholds.stallMs > 0)
  assert.ok(Number.isInteger(audit.thresholds.nodeTimeoutMs) && audit.thresholds.nodeTimeoutMs > 0)
  assert.ok(Number.isInteger(audit.thresholds.runTimeoutMs) && audit.thresholds.runTimeoutMs > 0)
  assert.ok(['run', 'default'].includes(audit.thresholds.source))
  assert.ok(Array.isArray(audit.plan.expected))
  assert.ok(Array.isArray(audit.plan.actual))
  assert.ok(Array.isArray(audit.plan.deviations))
  assert.ok(Array.isArray(audit.rejects.byNode))
  assert.ok(Array.isArray(audit.rejects.looped))
  assert.ok(Number.isInteger(audit.idleMs) && audit.idleMs >= 0)
  assert.ok(audit.currentNode === null || typeof audit.currentNode.id === 'string')
  assert.ok(audit.anomalies.every(anomaly => [
    'stall', 'timeout-risk', 'reject-loop', 'deviation', 'concurrency', 'no-progress', 'failed',
  ].includes(anomaly.kind)))
}

/** 每个测试独立的事件 seq / 默认时间（默认每秒一条，可被 over.ts 覆盖）。 */
function eventLog() {
  let seq = 0
  return (kind, over = {}) => {
    seq += 1
    return {
      v: 1,
      ts: isoAt(0, seq),
      kind,
      runId: RUN_ID,
      traceId: `trace-${seq}`,
      seq,
      ...over,
    }
  }
}

function nodeStart(ev, nodeId, attemptId = 1, over = {}) {
  return ev('node/start', {
    nodeId,
    attemptId,
    ...over,
    data: { title: TITLES[nodeId] || nodeId, mode: 'single', skills: [], ...(over.data || {}) },
  })
}

function nodeEnd(ev, nodeId, status = 'passed', attemptId = 1, over = {}) {
  return ev('node/end', {
    nodeId,
    attemptId,
    ...over,
    data: { status, durationMs: 1000, ...(over.data || {}) },
  })
}

function rejectEvent(ev, fromNodeId, toNodeId, attemptId = 1, over = {}) {
  const { edgeId = 'er1', ts, data = {} } = over
  return ev('reject/trigger', {
    nodeId: fromNodeId,
    attemptId,
    ...(ts ? { ts } : {}),
    data: { edgeId, fromNodeId, toNodeId, reason: '需要返工', ...data },
  })
}

// ---------------------------------------------------------------------------
// 1. pending
// ---------------------------------------------------------------------------
check('pending：run 建好但还没开始 → pending / inspect / 30s', () => {
  const audit = auditWorkflow({
    flow: FLOW,
    events: [],
    now: msAt(1),
    run: { status: 'pending', startedAt: isoAt(0) },
  })
  assertContract(audit, 'pending')
  assert.equal(audit.status, 'pending')
  assert.match(audit.headline, /还没开始/)
  assert.equal(audit.recommended, 'inspect')
  assert.equal(audit.nextCheckSeconds, 30)
  assert.equal(audit.currentNode, null)
  assert.equal(audit.progress.total, 4)
  assert.equal(audit.progress.ratio, null)
  assert.equal(audit.quality, null)
  assert.equal(audit.tokens, null)
})

// ---------------------------------------------------------------------------
// 2. running 正常推进
// ---------------------------------------------------------------------------
check('running 正常推进：healthy，currentNode / attempt / 进度正确', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', flowName: 'F', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 5) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 10) }),
    nodeStart(ev, 'n_shape', 1, { ts: isoAt(0, 20) }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(0, 50),
    run: { status: 'running', startedAt: isoAt(0) },
  })
  assertContract(audit, 'healthy')
  assert.equal(audit.progress.passed, 1)
  assert.equal(audit.progress.total, 4)
  assert.equal(audit.progress.ratio, 0.25)
  assert.equal(audit.currentNode.id, 'n_shape')
  assert.equal(audit.currentNode.title, '结构设计')
  assert.equal(audit.currentNode.attempt, 1)
  assert.ok(audit.currentNode.elapsedMs >= 30_000)
  assert.equal(audit.anomalies.length, 0)
  assert.deepEqual(audit.plan.expected, ['n_req', 'n_shape', 'n_dev', 'n_test'])
  assert.deepEqual(audit.plan.actual, ['n_req', 'n_shape'])
  assert.equal(audit.plan.deviations.length, 0)
  const states = Object.fromEntries(audit.progress.nodes.map(node => [node.id, node.state]))
  assert.equal(states.n_req, 'passed')
  assert.equal(states.n_shape, 'running')
  assert.equal(states.n_dev, 'pending')
  assert.equal(audit.recommended, 'wait')
  assert.equal(audit.nextCheckSeconds, 180)
})

// ---------------------------------------------------------------------------
// 3. 卡死
// ---------------------------------------------------------------------------
check('卡死：idleMs 超阈值 → stalled，headline 含节点名', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_shape', 1, { ts: isoAt(0, 3) }),
    nodeEnd(ev, 'n_shape', 'passed', 1, { ts: isoAt(0, 4) }),
    nodeStart(ev, 'n_dev', 1, { ts: isoAt(0, 5) }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(12),
    run: { status: 'running', startedAt: isoAt(0) },
  })
  assertContract(audit, 'stalled')
  assert.ok(audit.anomalies.some(anomaly => anomaly.kind === 'stall'))
  assert.equal(audit.currentNode.id, 'n_dev')
  assert.match(audit.headline, /开发/)
  assert.equal(audit.recommended, 'inspect')
  assert.equal(audit.nextCheckSeconds, 60)
})

// ---------------------------------------------------------------------------
// 4. 打回死循环
// ---------------------------------------------------------------------------
check('打回死循环：同一条边 4 次 > 3 → looping，rejects.looped 命中', () => {
  const ev = eventLog()
  const events = [ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } })]
  for (let round = 1; round <= 4; round += 1) {
    const minute = round - 1
    events.push(
      nodeStart(ev, 'n_req', round, { ts: isoAt(minute, 1) }),
      nodeEnd(ev, 'n_req', 'passed', round, { ts: isoAt(minute, 2) }),
      nodeStart(ev, 'n_shape', round, { ts: isoAt(minute, 3) }),
      nodeEnd(ev, 'n_shape', 'passed', round, { ts: isoAt(minute, 4) }),
      nodeStart(ev, 'n_dev', round, { ts: isoAt(minute, 5) }),
      nodeEnd(ev, 'n_dev', 'rejected', round, { ts: isoAt(minute, 6) }),
      rejectEvent(ev, 'n_dev', 'n_req', round, { ts: isoAt(minute, 7) }),
    )
  }
  // 第 5 次尝试重新开始需求分析：仍在跑，不制造卡死 / 无进展。
  events.push(nodeStart(ev, 'n_req', 5, { ts: isoAt(4, 1) }))

  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(4, 30),
    run: { status: 'running', startedAt: isoAt(0) },
  })
  assertContract(audit, 'looping')
  assert.equal(audit.rejects.total, 4)
  assert.equal(audit.rejects.looped.length, 1)
  assert.equal(audit.rejects.looped[0].nodeId, 'n_req')
  assert.equal(audit.rejects.looped[0].title, '需求分析')
  assert.equal(audit.rejects.looped[0].count, 4)
  assert.ok(audit.anomalies.some(anomaly => anomaly.kind === 'reject-loop'))
  assert.equal(audit.plan.deviations.length, 0, '打回后从目标重跑不是偏航')
  assert.equal(audit.recommended, 'stop')
  assert.match(audit.headline, /死循环/)
})

// ---------------------------------------------------------------------------
// 5. 偏航
// ---------------------------------------------------------------------------
check('偏航：跳过中间节点直接跑下游 → deviating，deviations[0].expected 正确', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_test', 1, { ts: isoAt(0, 3) }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(0, 30),
    run: { status: 'running', startedAt: isoAt(0) },
  })
  assertContract(audit, 'deviating')
  assert.equal(audit.plan.deviations.length, 1)
  assert.equal(audit.plan.deviations[0].nodeId, 'n_test')
  assert.equal(audit.plan.deviations[0].expected, 'n_shape')
  assert.equal(audit.plan.deviations[0].index, 1)
  assert.match(audit.plan.deviations[0].reason, /跳过/)
  assert.ok(audit.anomalies.some(anomaly => anomaly.kind === 'deviation'))
  assert.equal(audit.recommended, 'stop')
  assert.match(audit.headline, /偏航/)
  assert.match(audit.headline, /结构设计/)
})

// ---------------------------------------------------------------------------
// 6. 并发乱序
// ---------------------------------------------------------------------------
check('并发：两个节点同时 open → concurrency anomaly', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    nodeStart(ev, 'n_shape', 1, { ts: isoAt(0, 2) }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(0, 20),
    run: { status: 'running', startedAt: isoAt(0) },
  })
  assertContract(audit, 'deviating')
  const concurrency = audit.anomalies.find(anomaly => anomaly.kind === 'concurrency')
  assert.ok(concurrency, '必须报并发异常')
  assert.equal(concurrency.nodeId, 'n_shape')
  assert.match(concurrency.detail, /需求分析/)
  assert.match(concurrency.detail, /结构设计/)
  assert.equal(audit.progress.passed, 0)
  assert.equal(audit.recommended, 'stop')
})

// ---------------------------------------------------------------------------
// 7. 节点超时风险
// ---------------------------------------------------------------------------
check('节点超时风险：elapsedMs > nodeTimeoutMs，事件仍在流动 → stalled 类', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_shape', 1, { ts: isoAt(0, 3) }),
    ev('agent/message', { ts: isoAt(8), data: { role: 'assistant', text: '正在推进结构设计' } }),
    ev('agent/message', { ts: isoAt(15), data: { role: 'assistant', text: '仍在推进' } }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(21),
    run: { status: 'running', startedAt: isoAt(0) },
  })
  assertContract(audit, 'stalled')
  const timeout = audit.anomalies.find(anomaly => anomaly.kind === 'timeout-risk')
  assert.ok(timeout, '必须报 timeout-risk')
  assert.equal(timeout.nodeId, 'n_shape')
  assert.equal(audit.currentNode.elapsedMs >= 20 * 60 * 1000, true)
  assert.equal(audit.anomalies.some(anomaly => anomaly.kind === 'stall'), false, '事件仍在流动，不是无事件卡死')
  assert.match(audit.headline, /超时/)
  assert.equal(audit.recommended, 'inspect')
  assert.equal(audit.nextCheckSeconds, 60)
})

// ---------------------------------------------------------------------------
// 8. 无进展
// ---------------------------------------------------------------------------
check('无进展：一个节点都没跑完且超过 stallMs → no-progress', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(15) }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(16),
    run: { status: 'running', startedAt: isoAt(0) },
  })
  assertContract(audit, 'no-progress')
  assert.equal(audit.progress.passed, 0)
  assert.equal(audit.progress.ratio, 0)
  assert.ok(audit.anomalies.some(anomaly => anomaly.kind === 'no-progress'))
  assert.match(audit.headline, /无进展/)
  assert.equal(audit.recommended, 'inspect')
  assert.equal(audit.nextCheckSeconds, 60)
})

// ---------------------------------------------------------------------------
// 9. done + quality pass
// ---------------------------------------------------------------------------
check('done + quality pass：verdict done，headline 带质量结论', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 2 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_shape', 1, { ts: isoAt(0, 3) }),
    nodeEnd(ev, 'n_shape', 'passed', 1, { ts: isoAt(0, 4) }),
    ev('acceptance/verdict', {
      ts: isoAt(0, 5),
      nodeId: 'n_req',
      attemptId: 1,
      // 0.11 N1：pass 档要求权威覆盖 100%；这三条证据按「宿主已核对」的输入形状构造。
      extra: { producer: 'host', authority: 'host' },
      data: { itemId: 'acc-1', status: 'pass', decidedBy: 'human', evidenceRef: 'artifacts/acc.md' },
    }),
    ev('test/report', {
      ts: isoAt(0, 6),
      nodeId: 'n_shape',
      attemptId: 1,
      extra: { producer: 'host', authority: 'host' },
      data: {
        suite: 'unit', executed: 10, passed: 10, failed: 0, skipped: 0,
        reportRef: 'artifacts/test.md',
      },
    }),
    ev('check/form', {
      ts: isoAt(0, 7),
      nodeId: 'n_shape',
      attemptId: 1,
      extra: { producer: 'host', authority: 'host' },
      data: {
        ruleSetId: 'eslint', ruleSetVersion: '9', executor: 'eslint@9', state: 'pass',
        passedChecks: 5, totalChecks: 5, executedAt: isoAt(0, 7),
      },
    }),
    ev('review/finding', {
      ts: isoAt(0, 8),
      nodeId: 'n_dev',
      attemptId: 1,
      data: { id: 'f1', severity: 'P1', title: '小问题', status: 'verified' },
    }),
    ev('review/verdict', {
      ts: isoAt(0, 9),
      nodeId: 'n_dev',
      attemptId: 1,
      data: { verdict: 'approve', findingCount: 1 },
    }),
    ev('run/end', { ts: isoAt(0, 10), data: { status: 'done' } }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(1),
    run: { status: 'done', startedAt: isoAt(0), endedAt: isoAt(0, 10) },
    verifyHostExecution: () => true,
  })
  assertContract(audit, 'done')
  assert.equal(audit.status, 'done')
  assert.ok(audit.quality, 'done 必须有质量结论')
  assert.equal(audit.quality.state, 'pass')
  assert.match(audit.headline, /优/)
  assert.ok(audit.headline.includes(audit.quality.label))
  assert.ok(audit.tokens && typeof audit.tokens.total === 'object')
  assert.equal(audit.currentNode, null)
  assert.equal(audit.anomalies.length, 0)
  assert.equal(audit.recommended, 'report')
  assert.equal(audit.nextCheckSeconds, null)
})

// N1 反向锁：同一份证据内容改回旧 run 的 legacy 形状（无 extra 来源）后，不得再 pass。
// 否则将来有人把上面的夹具改回无 extra，N1 会静默回退且本文件无测试发现。
check('N1：legacy 形状（证据无 extra）的 done run 不得 pass，headline 写明来源未知', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 2 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_shape', 1, { ts: isoAt(0, 3) }),
    nodeEnd(ev, 'n_shape', 'passed', 1, { ts: isoAt(0, 4) }),
    ev('acceptance/verdict', {
      ts: isoAt(0, 5),
      nodeId: 'n_req',
      attemptId: 1,
      data: { itemId: 'acc-1', status: 'pass', decidedBy: 'human', evidenceRef: 'artifacts/acc.md' },
    }),
    ev('test/report', {
      ts: isoAt(0, 6),
      nodeId: 'n_shape',
      attemptId: 1,
      data: {
        suite: 'unit', executed: 10, passed: 10, failed: 0, skipped: 0,
        reportRef: 'artifacts/test.md',
      },
    }),
    ev('check/form', {
      ts: isoAt(0, 7),
      nodeId: 'n_shape',
      attemptId: 1,
      data: {
        ruleSetId: 'eslint', ruleSetVersion: '9', executor: 'eslint@9', state: 'pass',
        passedChecks: 5, totalChecks: 5, executedAt: isoAt(0, 7),
      },
    }),
    ev('review/finding', {
      ts: isoAt(0, 8),
      nodeId: 'n_dev',
      attemptId: 1,
      data: { id: 'f1', severity: 'P1', title: '小问题', status: 'verified' },
    }),
    ev('review/verdict', {
      ts: isoAt(0, 9),
      nodeId: 'n_dev',
      attemptId: 1,
      data: { verdict: 'approve', findingCount: 1 },
    }),
    ev('run/end', { ts: isoAt(0, 10), data: { status: 'done' } }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(1),
    run: { status: 'done', startedAt: isoAt(0), endedAt: isoAt(0, 10) },
  })
  assertContract(audit, 'done')
  assert.ok(audit.quality, 'done 必须有质量结论')
  // 质量分类归 runlog 的质量层：v1.3 起 legacy（无产物归属）从 unknown 细分成 warn，
  // 但「legacy 形状不得算通过」这条不能松——只断言不是 pass。
  assert.ok(
    audit.quality.state !== 'pass',
    `legacy 形状不得 pass（实际 ${audit.quality.state}：${audit.quality.label}）`,
  )
  // 措辞同样归 runlog（可能说「来源未知 / 找不到产物归属 / 缺独立复核 / 证据不足」）；
  // 审计这边只要求可读文案指明了「证据不足」这一类原因。
  assert.match(audit.quality.label, /legacy|来源未知|找不到产物归属|缺独立复核|证据不足|无法判定/)
  assert.match(audit.headline, /unknown|warn/)
  assert.match(audit.headline, /legacy|来源未知|找不到产物归属|缺独立复核|证据不足|无法判定/)
})

// ---------------------------------------------------------------------------
// 10. failed
// ---------------------------------------------------------------------------
check('failed：headline 含失败节点 id，anomaly=kind failed', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_shape', 1, { ts: isoAt(0, 3) }),
    nodeEnd(ev, 'n_shape', 'failed', 1, { ts: isoAt(0, 4), extra: { reason: '模型调用超时' } }),
    ev('run/end', {
      ts: isoAt(0, 5),
      data: { status: 'failed', reason: '模型调用超时', failedNodeId: 'n_shape' },
    }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(1),
    run: { status: 'failed', failedNodeId: 'n_shape', startedAt: isoAt(0), endedAt: isoAt(0, 5) },
  })
  assertContract(audit, 'failed')
  assert.equal(audit.status, 'failed')
  assert.match(audit.headline, /n_shape/)
  assert.match(audit.headline, /模型调用超时/)
  const failed = audit.anomalies.find(anomaly => anomaly.kind === 'failed')
  assert.ok(failed)
  assert.equal(failed.nodeId, 'n_shape')
  assert.equal(audit.recommended, 'report')
  assert.equal(audit.nextCheckSeconds, null)
})

// ---------------------------------------------------------------------------
// 11. aborted
// ---------------------------------------------------------------------------
check('aborted：verdict aborted / report / 不再轮询', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    ev('run/end', { ts: isoAt(0, 2), data: { status: 'aborted', reason: '已停止' } }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(1),
    run: { status: 'aborted', startedAt: isoAt(0), endedAt: isoAt(0, 2) },
  })
  assertContract(audit, 'aborted')
  assert.equal(audit.status, 'aborted')
  assert.match(audit.headline, /中止/)
  assert.equal(audit.recommended, 'report')
  assert.equal(audit.nextCheckSeconds, null)
})

// ---------------------------------------------------------------------------
// 12. 坏输入
// ---------------------------------------------------------------------------
check('坏输入不抛错：flow null / events 非数组 / run 缺失 / 空调用', () => {
  const first = auditWorkflow({
    flow: null,
    events: null,
    now: msAt(1),
    run: { status: 'running', startedAt: isoAt(0) },
  })
  assertContract(first, 'healthy')
  assert.deepEqual(first.plan.expected, [])
  assert.deepEqual(first.plan.deviations, [])
  assert.equal(first.progress.total, 0)

  const second = auditWorkflow({ flow: null, events: 'oops', run: null, now: 'not-a-time' })
  assertContract(second, 'pending')
  assert.equal(second.status, null)

  assert.doesNotThrow(() => auditWorkflow())
  const third = auditWorkflow()
  assertContract(third, 'pending')
  assert.equal(third.headline.length > 0, true)
})

// ---------------------------------------------------------------------------
// 13. 正常打回后从目标重跑
// ---------------------------------------------------------------------------
check('打回后从打回目标重跑不算偏航（正常 reject 循环不误报）', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_shape', 1, { ts: isoAt(0, 3) }),
    nodeEnd(ev, 'n_shape', 'passed', 1, { ts: isoAt(0, 4) }),
    nodeStart(ev, 'n_dev', 1, { ts: isoAt(0, 5) }),
    nodeEnd(ev, 'n_dev', 'rejected', 1, { ts: isoAt(0, 6) }),
    rejectEvent(ev, 'n_dev', 'n_req', 1, { ts: isoAt(0, 7) }),
    nodeStart(ev, 'n_req', 2, { ts: isoAt(0, 8) }),
    nodeEnd(ev, 'n_req', 'passed', 2, { ts: isoAt(0, 9) }),
    nodeStart(ev, 'n_shape', 2, { ts: isoAt(0, 10) }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(0, 40),
    run: { status: 'running', startedAt: isoAt(0) },
  })
  assertContract(audit, 'healthy')
  assert.deepEqual(audit.plan.deviations, [])
  assert.equal(audit.rejects.total, 1)
  assert.equal(audit.rejects.looped.length, 0)
  assert.equal(audit.currentNode.id, 'n_shape')
  assert.equal(audit.currentNode.attempt, 2)
  assert.equal(audit.recommended, 'wait')
})

// ---------------------------------------------------------------------------
// 14. done 但证据不足
// ---------------------------------------------------------------------------
check('done 但无证据：quality unknown，headline 明说未检测', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 2 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_shape', 1, { ts: isoAt(0, 3) }),
    nodeEnd(ev, 'n_shape', 'passed', 1, { ts: isoAt(0, 4) }),
    ev('run/end', { ts: isoAt(0, 5), data: { status: 'done' } }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(1),
    run: { status: 'done', startedAt: isoAt(0), endedAt: isoAt(0, 5) },
  })
  assertContract(audit, 'done')
  assert.ok(audit.quality)
  assert.equal(audit.quality.state, 'unknown')
  assert.match(audit.headline, /未检测/)
})

// ---------------------------------------------------------------------------
// 15. 阈值来源：run.json.limits 优先，默认值兜底
// ---------------------------------------------------------------------------
check('阈值：显式 nodeTimeoutMs=30 分钟 → 26 分钟的节点不报超时风险（默认 20 分钟会报）', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_shape', 1, { ts: isoAt(0, 3) }),
  ]
  // 节点已跑 26 分钟，但期间事件一直在流（不是「无事件卡死」）。
  const mid = [
    ev('agent/message', { ts: isoAt(20), data: { role: 'assistant', text: '仍在推进' } }),
    ev('agent/message', { ts: isoAt(25), data: { role: 'assistant', text: '快好了' } }),
  ]
  const base = {
    flow: FLOW,
    events: [...events, ...mid],
    now: msAt(26),
    run: { status: 'running', startedAt: isoAt(0) },
  }

  // 默认阈值（20 分钟）→ 误报 timeout-risk。
  const withDefault = auditWorkflow(base)
  assertContract(withDefault, 'stalled')
  assert.ok(withDefault.anomalies.some(anomaly => anomaly.kind === 'timeout-risk'))
  assert.equal(withDefault.thresholds.source, 'default')
  assert.equal(withDefault.thresholds.nodeTimeoutMs, 20 * 60 * 1000)

  // run 配置 30 分钟 → 同一份事件不该再报超时风险。
  const withRunLimit = auditWorkflow({ ...base, nodeTimeoutMs: 30 * 60 * 1000, thresholdSource: 'run' })
  assertContract(withRunLimit, 'healthy')
  assert.equal(withRunLimit.anomalies.length, 0)
  assert.equal(withRunLimit.thresholds.nodeTimeoutMs, 30 * 60 * 1000)
  assert.equal(withRunLimit.thresholds.source, 'run')

  // 显式传了但 thresholdSource 没传：按「有显式值」推断成 run。
  const inferred = auditWorkflow({ ...base, nodeTimeoutMs: 30 * 60 * 1000 })
  assert.equal(inferred.thresholds.source, 'run')

  // 整轮上限也接受透传（只进判定依据；不改变 verdict）。
  const withRunLimitBoth = auditWorkflow({
    ...base,
    nodeTimeoutMs: 30 * 60 * 1000,
    runTimeoutMs: 45 * 60 * 1000,
    thresholdSource: 'run',
  })
  assert.equal(withRunLimitBoth.thresholds.runTimeoutMs, 45 * 60 * 1000)
})

check('阈值：不传 options、只给 run.limits.nodeTimeoutMs → 也用 run 值（引擎 supervision 的调用形状）', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_shape', 1, { ts: isoAt(0, 3) }),
    ev('agent/message', { ts: isoAt(25), data: { role: 'assistant', text: '仍在推进' } }),
  ]
  // runtime.js 的 evaluate 就是这么调的：只有 run 元数据，一个阈值参数都不传。
  const runWithLimits = {
    status: 'running',
    startedAt: isoAt(0),
    limits: { nodeTimeoutMs: 30 * 60 * 1000, runTimeoutMs: 45 * 60 * 1000 },
  }
  const viaRunLimits = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(26),
    run: runWithLimits,
  })
  assertContract(viaRunLimits, 'healthy')
  assert.equal(viaRunLimits.anomalies.some(anomaly => anomaly.kind === 'timeout-risk'), false,
    '26 分钟 < run 配的 30 分钟，不得报超时风险')
  assert.equal(viaRunLimits.anomalies.some(anomaly => anomaly.kind === 'stall'), false)
  assert.equal(viaRunLimits.thresholds.nodeTimeoutMs, 30 * 60 * 1000)
  assert.equal(viaRunLimits.thresholds.runTimeoutMs, 45 * 60 * 1000)
  assert.equal(viaRunLimits.thresholds.source, 'run')

  // 对照：同一个 run 不配 limits（runtime 里的老 run）→ 仍按默认 20 分钟报超时。
  const withoutLimits = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(26),
    run: { status: 'running', startedAt: isoAt(0) },
  })
  assertContract(withoutLimits, 'stalled')
  assert.ok(withoutLimits.anomalies.some(anomaly => anomaly.kind === 'timeout-risk'))
  assert.equal(withoutLimits.thresholds.source, 'default')

  // 显式参数仍最优先：调用方明确给 10 分钟时，run.json.limits 的 30 分钟不能盖掉它。
  const explicitWins = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(26),
    run: runWithLimits,
    nodeTimeoutMs: 10 * 60 * 1000,
  })
  assert.equal(explicitWins.thresholds.nodeTimeoutMs, 10 * 60 * 1000)
  assert.ok(explicitWins.anomalies.some(anomaly => anomaly.kind === 'timeout-risk'))

  // limits 里的坏值（0 / 字符串）当没配，退回默认，不抛错。
  const brokenLimits = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(26),
    run: { status: 'running', startedAt: isoAt(0), limits: { nodeTimeoutMs: 0, runTimeoutMs: 'soon' } },
  })
  assert.equal(brokenLimits.thresholds.nodeTimeoutMs, 20 * 60 * 1000)
  assert.equal(brokenLimits.thresholds.source, 'default')
})

check('阈值：超时风险 detail / headline 写的是实际用的阈值，不是默认值', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_shape', 1, { ts: isoAt(0, 3) }),
    ev('agent/message', { ts: isoAt(8), data: { role: 'assistant', text: '仍在推进' } }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(21),
    run: { status: 'running', startedAt: isoAt(0) },
    nodeTimeoutMs: 15 * 60 * 1000,
    thresholdSource: 'run',
  })
  assertContract(audit, 'stalled')
  const timeout = audit.anomalies.find(anomaly => anomaly.kind === 'timeout-risk')
  assert.ok(timeout)
  assert.match(timeout.detail, /阈值 15 分钟/)
  assert.match(timeout.detail, /run\.json\.limits/)
  assert.doesNotMatch(timeout.detail, /20 分钟/)
  assert.match(audit.headline, /15 分钟/)
})

// ---------------------------------------------------------------------------
// 16. no-progress：detail 补上已观测事实（事件仍在流 / idle）
// ---------------------------------------------------------------------------
check('no-progress：detail 写清「事件仍在流（idle=…）」，阈值文字与实际一致', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(15) }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(16),
    run: { status: 'running', startedAt: isoAt(0) },
  })
  assertContract(audit, 'no-progress')
  const anomaly = audit.anomalies.find(item => item.kind === 'no-progress')
  assert.ok(anomaly)
  assert.match(anomaly.detail, /事件仍在流/)
  assert.match(anomaly.detail, /idle=/)
  assert.match(anomaly.detail, /无进展判定阈值 10 分钟/)
  assert.match(audit.headline, /事件仍在流/)

  // 事件确实停了超过阈值：detail 不再说「仍在流」，而是说「最近 X 无新事件」。
  const stopped = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(40),
    run: { status: 'running', startedAt: isoAt(0) },
  })
  // 事件停了 25 分钟，同时触发 stall → verdict 仍是 stalled，但 no-progress 条目仍要如实描述。
  const stoppedAnomaly = stopped.anomalies.find(item => item.kind === 'no-progress')
  assert.ok(stoppedAnomaly)
  assert.match(stoppedAnomaly.detail, /无新事件/)
  assert.doesNotMatch(stoppedAnomaly.detail, /事件仍在流/)
})

// ---------------------------------------------------------------------------
// 17. restart 续跑：跳过节点不算未执行、不算偏航
// ---------------------------------------------------------------------------
check('restart 续跑：从第 3 阶段起跑不算偏航，跳过节点单列、分母扣减', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    // 上次已完成 n_req / n_shape，本次直接跑 n_dev。
    nodeStart(ev, 'n_dev', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_dev', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_test', 1, { ts: isoAt(0, 3) }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(0, 30),
    run: {
      status: 'running',
      startedAt: isoAt(0),
      restart: { fromRunId: 'r-old', attempt: 1, startNodeId: 'n_dev', skippedNodeIds: ['n_req', 'n_shape'] },
    },
  })
  assertContract(audit, 'healthy')
  assert.deepEqual(audit.plan.deviations, [])
  assert.deepEqual(audit.plan.expected, ['n_dev', 'n_test'])
  assert.deepEqual(audit.plan.actual, ['n_dev', 'n_test'])
  assert.deepEqual(audit.progress.skipped, ['n_req', 'n_shape'])
  assert.equal(audit.progress.skippedCount, 2)
  assert.equal(audit.progress.passed, 1)
  assert.equal(audit.progress.total, 4)
  assert.equal(audit.progress.ratio, 1 / 2, 'ratio = passed / (total - skipped)')
  const states = Object.fromEntries(audit.progress.nodes.map(node => [node.id, node.state]))
  assert.equal(states.n_req, 'skipped')
  assert.equal(states.n_shape, 'skipped')
  assert.equal(states.n_dev, 'passed')
  assert.equal(states.n_test, 'running')
  assert.equal(audit.anomalies.length, 0)
  assert.equal(audit.recommended, 'wait')
})

check('restart 续跑（全部跑完）：done + ratio=1，不再有偏航条目', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_dev', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_dev', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_test', 1, { ts: isoAt(0, 3) }),
    nodeEnd(ev, 'n_test', 'passed', 1, { ts: isoAt(0, 4) }),
    ev('run/end', { ts: isoAt(0, 5), data: { status: 'done' } }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(1),
    run: {
      status: 'done',
      startedAt: isoAt(0),
      endedAt: isoAt(0, 5),
      restart: { fromRunId: 'r-old', attempt: 2, startNodeId: 'n_dev', skippedNodeIds: ['n_req', 'n_shape'] },
    },
  })
  assertContract(audit, 'done')
  assert.equal(audit.progress.passed, 2)
  assert.equal(audit.progress.total, 4)
  assert.equal(audit.progress.ratio, 1)
  assert.deepEqual(audit.plan.deviations, [])
  assert.deepEqual(audit.progress.skipped, ['n_req', 'n_shape'])
})

check('没有 restart 的 run：行为完全不变（skipped 为空、ratio 仍是 passed/total）', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 1) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 2) }),
    nodeStart(ev, 'n_shape', 1, { ts: isoAt(0, 3) }),
    nodeEnd(ev, 'n_shape', 'passed', 1, { ts: isoAt(0, 4) }),
    nodeStart(ev, 'n_dev', 1, { ts: isoAt(0, 5) }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(0, 40),
    run: { status: 'running', startedAt: isoAt(0) },
  })
  assertContract(audit, 'healthy')
  assert.deepEqual(audit.plan.expected, ['n_req', 'n_shape', 'n_dev', 'n_test'])
  assert.deepEqual(audit.progress.skipped, [])
  assert.equal(audit.progress.skippedCount, 0)
  assert.equal(audit.progress.ratio, 0.5)
  assert.ok(audit.progress.nodes.every(node => node.state !== 'skipped'))
})

check('restart 跳过节点若被引擎重新执行（异常数据）：不生成偏航条目', () => {
  const ev = eventLog()
  const events = [
    ev('run/start', { ts: isoAt(0), data: { flowId: 'f', nodeTotal: 4 } }),
    nodeStart(ev, 'n_dev', 1, { ts: isoAt(0, 1) }),
    // 理论上不该出现：被跳过的阶段又被 node/start（比如续跑计划被手改）。
    nodeStart(ev, 'n_req', 1, { ts: isoAt(0, 2) }),
    nodeEnd(ev, 'n_req', 'passed', 1, { ts: isoAt(0, 3) }),
  ]
  const audit = auditWorkflow({
    flow: FLOW,
    events,
    now: msAt(0, 30),
    run: {
      status: 'running',
      startedAt: isoAt(0),
      restart: { fromRunId: 'r-old', attempt: 1, startNodeId: 'n_dev', skippedNodeIds: ['n_req', 'n_shape'] },
    },
  })
  assert.deepEqual(audit.plan.deviations, [])
  assert.deepEqual(audit.plan.actual, ['n_dev'])
  assert.equal(audit.anomalies.some(anomaly => anomaly.kind === 'deviation'), false)
})

console.log(`\n${checks} 组通过`)
