#!/usr/bin/env node
/**
 * 实例运行指标自检（0.13.10 E1）：
 *  - 未知不是零（无 usage → null + reasons；有 agent 无 usage → unknown 覆盖）；
 *  - callId 去重替换、activity/end.usage 不双计；
 *  - 按 executionId 的节点耗时 / 错误 / 取消 / 中断；
 *  - 人工等待首次 wait、重放不重复、无新事件按 asOf 继续增长；
 *  - 挂起耗时单列；
 *  - finish_reminder 每次触发、NODE_FINISH_MISSING 按 execution 去重；
 *  - connector execution / attempt 成功率、请求延迟与含退避总耗时；
 *  - 汇总按 createdAt cohort、groupBy=day、分位数从样本合并；
 *  - 缓存绑定 lastSeq/revision/schemaVersion，GET 不启动 runner；
 *  - API 与离线纯函数复算逐字段一致。
 *
 * 运行：node test/instance-metrics.test.mjs
 */

import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const {
  METRICS_REASON, METRICS_SCHEMA_VERSION, aggregateInstanceMetrics, computeInstanceMetrics,
  createMetricsCache, eventsFingerprint, metricsCacheKey, metricsFingerprintFor, percentileMs,
  summarizeLatency,
} = await import('../src/instance-metrics.js')
const { appendInstanceEvents, readInstance } = await import('../src/instance-store.js')
const { createBpmnRuntime } = await import('../src/bpmn-runtime.js')

let homeSeq = 0
function freshHome(label) {
  homeSeq += 1
  return mkdtempSync(join(repoRoot, '.tmp', `home-metrics-${label}-${homeSeq}-`))
}

function iso(offsetMs) {
  return new Date(Date.parse('2026-11-12T00:00:00.000Z') + offsetMs).toISOString()
}

const T0 = '2026-11-12T00:00:00.000Z'

function instanceFact(options = {}) {
  return {
    id: options.id ?? 'i-metrics',
    definitionId: options.definitionId ?? 'flow-metrics',
    definitionVersion: options.definitionVersion ?? 1,
    definitionHash: 'a'.repeat(64),
    status: options.status ?? 'ACTIVE',
    variables: options.variables ?? {},
    result: options.result ?? null,
    artifacts: options.artifacts ?? [],
    lastError: options.lastError ?? null,
    lastAgentOutput: options.lastAgentOutput ?? null,
    pendingTasks: options.pendingTasks ?? [],
    revision: options.revision ?? 1,
    eventCount: options.eventCount ?? 0,
    lastSeq: options.lastSeq ?? 0,
    createdAt: options.createdAt ?? T0,
    updatedAt: options.updatedAt ?? T0,
    completedAt: options.completedAt ?? null,
    definitionSnapshot: 'definition.bpmn',
  }
}

function event(seq, type, offsetMs, extra = {}) {
  return { seq, type, at: iso(offsetMs), ...extra }
}

test('未知不是零：无 usage 时 observedTokens=null，并在 reasons 记原因', () => {
  const metrics = computeInstanceMetrics({
    instance: instanceFact(),
    events: [],
    asOf: iso(10_000),
  })
  assert.equal(metrics.agent.observedTokens, null, '没有 usage 不能给 0 token')
  assert.equal(metrics.agent.modelCalls, 0)
  assert.equal(metrics.agent.invocations, 0)
  assert.deepEqual(metrics.agent.usageCoverage, { known: 0, partial: 0, unknown: 0 })
  assert.equal(metrics.complete, true)
  assert.equal(metrics.duration.wallMs, 10_000)
})

test('有 agent 调用但没有 usage 事件 → modelCalls null、unknown 覆盖、reason 明确', () => {
  const metrics = computeInstanceMetrics({
    instance: instanceFact(),
    events: [
      event(1, 'activity/start', 0, { elementId: 'agent1', activityId: 'e1' }),
      event(2, 'agent/invocation', 10, { elementId: 'agent1', activityId: 'e1', invocationId: 'e1:invoke-1', provider: 'dsh' }),
      event(3, 'activity/end', 100, { elementId: 'agent1', activityId: 'e1', durationMs: 100 }),
    ],
    asOf: iso(1_000),
  })
  assert.equal(metrics.agent.invocations, 1)
  assert.equal(metrics.agent.modelCalls, null, '没有底层观测时模型调用数未知，不是 0')
  assert.equal(metrics.agent.observedTokens, null)
  assert.deepEqual(metrics.agent.usageCoverage, { known: 0, partial: 0, unknown: 1 })
  assert.ok(metrics.dataQuality.reasons.includes(METRICS_REASON.USAGE_UNAVAILABLE))
})

test('旧实例没有遥测事件：lastAgentOutput 证明 agent 跑过 → 调用数未知而不是 0', () => {
  const metrics = computeInstanceMetrics({
    instance: instanceFact({ lastAgentOutput: { nodeId: 'agent1', output: { verdict: 'pass' } } }),
    events: [],
    asOf: iso(1_000),
  })
  assert.equal(metrics.agent.invocations, null)
  assert.equal(metrics.agent.modelCalls, null)
  assert.equal(metrics.agent.observedTokens, null)
  assert.deepEqual(metrics.agent.usageCoverage, { known: 0, partial: 0, unknown: 1 })
  assert.ok(metrics.dataQuality.reasons.includes(METRICS_REASON.INVOCATION_UNAVAILABLE))
  assert.ok(metrics.dataQuality.reasons.includes(METRICS_REASON.USAGE_UNAVAILABLE))
})

test('callId 去重替换；activity/end.usage 不与 agent/usage 双计', () => {
  const metrics = computeInstanceMetrics({
    instance: instanceFact(),
    events: [
      event(1, 'activity/start', 0, { elementId: 'agent1', activityId: 'e1' }),
      event(2, 'agent/invocation', 10, { elementId: 'agent1', activityId: 'e1', invocationId: 'e1:invoke-1', provider: 'dsh' }),
      event(3, 'agent/usage', 20, {
        elementId: 'agent1', activityId: 'e1', invocationId: 'e1:invoke-1',
        provider: 'dsh', callId: 'call-1', trust: 'known',
        usage: { input: 100, cacheRead: 20, cacheWrite: 0, output: 40, total: 160 },
      }),
      // 同一 callId 后到的是替换：input 120 / output 50 → total 170
      event(4, 'agent/usage', 30, {
        elementId: 'agent1', activityId: 'e1', invocationId: 'e1:invoke-1',
        provider: 'dsh', callId: 'call-1', trust: 'known',
        usage: { input: 120, cacheRead: 0, cacheWrite: 0, output: 50, total: 170 },
      }),
      // 这一份 activity/end.usage 必须被忽略（同一 execution 已有 agent/usage）
      event(5, 'activity/end', 100, {
        elementId: 'agent1', activityId: 'e1', durationMs: 100,
        usage: { input_tokens: 999, output_tokens: 999 },
      }),
      // 第二个 execution 只有 activity/end.usage：允许旧口径兜底
      event(6, 'activity/start', 200, { elementId: 'agent2', activityId: 'e2' }),
      event(7, 'activity/end', 300, {
        elementId: 'agent2', activityId: 'e2', durationMs: 100,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ],
    asOf: iso(1_000),
  })
  assert.equal(metrics.agent.observedTokens.input, 130, 'call-1 替换成 120 + 兜底 10')
  assert.equal(metrics.agent.observedTokens.output, 55)
  // M7：legacy 兜底那份 usage 没有 cache 两桶，旧断言 total=185 是拿补零算出来的；
  // 缺桶后完整 total 必须未知，但已观测小计仍可展示。
  assert.equal(metrics.agent.observedTokens.total, null)
  assert.equal(metrics.agent.observedTokens.partial, true)
  assert.deepEqual(metrics.agent.observedTokensPartial, { input: 130, cacheRead: 0, cacheWrite: 0, output: 55 })
  assert.deepEqual(metrics.agent.usageCoverage, { known: 0, partial: 2, unknown: 0 })
  assert.equal(metrics.agent.buckets.complete, false, 'seen 并集不能证明完整')
  assert.ok(metrics.dataQuality.reasons.includes(METRICS_REASON.LEGACY_USAGE_FALLBACK))
  assert.ok(metrics.dataQuality.reasons.includes(METRICS_REASON.USAGE_HISTORY_MASK_MISSING),
    '旧事件没有 observedBuckets → 完整性未知')
})

test('节点耗时按 executionId：循环两次独立；错误 / 取消 / 中断不伪造 completed', () => {
  const metrics = computeInstanceMetrics({
    instance: instanceFact({ status: 'CANCELED', completedAt: iso(50_000), updatedAt: iso(50_000) }),
    events: [
      event(1, 'activity/start', 0, { elementId: 'loop', activityId: 'e1' }),
      event(2, 'activity/end', 1_000, { elementId: 'loop', activityId: 'e1', durationMs: 1_000 }),
      event(3, 'activity/start', 2_000, { elementId: 'loop', activityId: 'e2' }),
      event(4, 'activity/end', 5_000, { elementId: 'loop', activityId: 'e2', durationMs: 3_000 }),
      event(5, 'activity/start', 6_000, { elementId: 'bad', activityId: 'e3' }),
      event(6, 'error', 7_000, { elementId: 'bad', activityId: 'e3', error: { code: 'BPMN_HANDLER_FAILED' } }),
      event(7, 'activity/start', 8_000, { elementId: 'open', activityId: 'e4' }),
    ],
    asOf: iso(60_000),
  })
  const rows = metrics.nodes.executions
  assert.equal(rows.length, 4)
  assert.equal(rows.find(row => row.executionId === 'e1').durationMs, 1_000)
  assert.equal(rows.find(row => row.executionId === 'e2').durationMs, 3_000, '同一节点第二次 execution 独立计时')
  assert.equal(rows.find(row => row.executionId === 'e3').status, 'error')
  assert.equal(rows.find(row => row.executionId === 'e4').status, 'canceled', '终态取消后的未结束 execution 标 canceled')
  assert.equal(metrics.nodes.completed, 2)
  assert.equal(metrics.nodes.errored, 1)
  assert.equal(metrics.nodes.canceled, 1)
  assert.equal(metrics.nodes.executed, 4)
})

test('人工等待：首次 wait、重放不重复、无新事件按 asOf 继续增长', () => {
  const events = [
    event(1, 'activity/start', 0, { elementId: 'human1', activityId: 'e1' }),
    event(2, 'activity/wait', 1_000, { elementId: 'human1', activityId: 'e1' }),
    // 恢复重放的 wait：不能把起点重置到 5s
    event(3, 'activity/wait', 5_000, { elementId: 'human1', activityId: 'e1' }),
    event(4, 'activity/end', 8_000, { elementId: 'human1', activityId: 'e1', durationMs: 8_000 }),
    event(5, 'activity/start', 9_000, { elementId: 'human2', activityId: 'e2' }),
    event(6, 'activity/wait', 9_000, { elementId: 'human2', activityId: 'e2' }),
  ]
  const first = computeInstanceMetrics({ instance: instanceFact(), events, asOf: iso(20_000) })
  assert.equal(first.human.completedWaitMs, 7_000, '首次 wait 1s → end 8s = 7s，不被 5s 重放重置')
  assert.equal(first.human.currentWaitMs, 11_000, '9s 开始等待，asOf 20s = 11s')

  const later = computeInstanceMetrics({ instance: instanceFact(), events, asOf: iso(30_000) })
  assert.equal(later.human.currentWaitMs, 21_000, '没有新事件也必须按 asOf 继续增长')
  assert.equal(later.human.completedWaitMs, 7_000)
})

test('挂起耗时单列：suspend/resume 区间不与执行耗时混算', () => {
  const metrics = computeInstanceMetrics({
    instance: instanceFact({ status: 'COMPLETED', completedAt: iso(20_000), updatedAt: iso(20_000) }),
    events: [
      event(1, 'instance/suspended', 5_000),
      event(2, 'instance/resumed', 9_000),
      event(3, 'activity/start', 10_000, { elementId: 'a', activityId: 'e1' }),
      event(4, 'activity/end', 12_000, { elementId: 'a', activityId: 'e1', durationMs: 2_000 }),
    ],
    asOf: iso(30_000),
  })
  assert.equal(metrics.duration.wallMs, 20_000)
  assert.equal(metrics.duration.suspendedMs, 4_000, '挂起 4s 单列，不混入执行耗时')
  assert.equal(metrics.nodes.executions[0].durationMs, 2_000)

  const onlyStatus = computeInstanceMetrics({
    instance: instanceFact({ status: 'SUSPENDED' }),
    events: [],
    asOf: iso(10_000),
  })
  assert.equal(onlyStatus.duration.suspendedMs, null, '只有 SUSPENDED 状态、没有区间 → 未知，不是 0')
  assert.ok(onlyStatus.dataQuality.reasons.includes(METRICS_REASON.SUSPEND_TIMELINE_UNAVAILABLE)
    || onlyStatus.duration.suspendedMs === null)
})

// MINOR-1（0.14.4）：磁盘是 ACTIVE、事件流最后一条生命周期事件却是 suspended
// （resume 事件追加失败）→ 挂起时长未知，不能继续按 now 累计。
test('MINOR-1：ACTIVE 但缺 resume 事件 → suspendedMs null + suspend-timeline-unavailable', () => {
  // lastSeq=2 表示元数据已经公布了 resume 的 seq，但事件正文没写进去（append 失败）。
  const fact = instanceFact({ status: 'ACTIVE', lastSeq: 2, eventCount: 2 })
  const events = [event(1, 'instance/suspended', 1_000)]
  const early = computeInstanceMetrics({ instance: fact, events, asOf: iso(14_000) })
  const later = computeInstanceMetrics({ instance: fact, events, asOf: iso(120_000) })

  assert.equal(early.status, 'ACTIVE')
  assert.equal(early.duration.suspendedMs, null, '缺 resume 时挂起时长未知，不是 13s')
  assert.equal(later.duration.suspendedMs, null, '不能从 13s 继续增长到 119s')
  assert.ok(
    early.dataQuality.reasons.includes(METRICS_REASON.SUSPEND_TIMELINE_UNAVAILABLE),
    '必须明确给出 suspend-timeline-unavailable',
  )
  assert.equal(early.complete, false, '事件正文没完成时不是完整结果')
})

// MINOR-1（0.14.4）：挂起期间允许写「执行失败事实」（error 事件 + lastError），
// 因此区间内的 error 事件不能结束挂起区间。
test('MINOR-1：挂起区间内的 error 事件不结束区间', () => {
  const metrics = computeInstanceMetrics({
    instance: instanceFact({ status: 'ACTIVE', lastSeq: 3, eventCount: 3 }),
    events: [
      event(1, 'instance/suspended', 1_000),
      event(2, 'error', 3_000, { elementId: 'agent1', error: { code: 'BPMN_AGENT_TIMEOUT' } }),
      event(3, 'instance/resumed', 9_000),
    ],
    asOf: iso(20_000),
  })
  assert.equal(metrics.duration.suspendedMs, 8_000, '1s→9s，中间的 error 不断开区间')
  assert.ok(!metrics.dataQuality.reasons.includes(METRICS_REASON.SUSPEND_TIMELINE_UNAVAILABLE))
})

// MINOR-1（0.14.4）：事件补写时元数据（lastSeq/revision）可以完全不变。缓存指纹必须
// 包含事件内容；而「事件日志不完整」的归约根本不能进缓存（补写后同 key 也要重算）。
test('MINOR-1：补写 resume 事件后数值正确；事件内容进指纹，残缺归约不入缓存', () => {
  const fact = instanceFact({ status: 'ACTIVE', lastSeq: 2, eventCount: 2, revision: 7 })
  const broken = [event(1, 'instance/suspended', 1_000)]
  const repaired = [event(1, 'instance/suspended', 1_000), event(2, 'instance/resumed', 9_000)]

  const before = computeInstanceMetrics({ instance: fact, events: broken, asOf: iso(20_000) })
  assert.equal(before.duration.suspendedMs, null)
  assert.equal(before.complete, false)

  const cache = createMetricsCache()
  const brokenKey = metricsFingerprintFor(fact, { events: broken })
  const first = cache.get(brokenKey, () => before)
  assert.equal(first.hit, false)
  assert.equal(cache.size, 0, '残缺归约不写入缓存')

  // 元数据不变，但事件已补写：同 key 请求也必须重算，不能命中窗口期的残缺值。
  const second = cache.get(brokenKey, () => computeInstanceMetrics({
    instance: fact,
    events: repaired,
    asOf: iso(20_000),
  }))
  assert.equal(second.hit, false, '残缺结果不得命中旧缓存')
  assert.equal(second.value.duration.suspendedMs, 8_000, '补写 resume 后 1s→9s = 8s')
  assert.equal(second.value.complete, true)

  // 事件内容进入指纹：lastSeq/revision 不变，事件正文一变 key 就变。
  const repairedKey = metricsFingerprintFor(fact, { events: repaired })
  assert.notEqual(metricsCacheKey(repairedKey), metricsCacheKey(brokenKey))
  assert.notEqual(eventsFingerprint(broken), eventsFingerprint(repaired))

  // 完整结果正常进缓存，同 key 第二次命中。
  const healthy = computeInstanceMetrics({ instance: fact, events: repaired, asOf: iso(20_000) })
  const a = cache.get(metricsCacheKey(repairedKey), () => healthy)
  const b = cache.get(metricsCacheKey(repairedKey), () => healthy)
  assert.equal(a.hit, false)
  assert.equal(b.hit, true, '完整结果照常缓存')
})

test('finish_reminder 每次触发各计一次；NODE_FINISH_MISSING 按 execution 去重', () => {
  const metrics = computeInstanceMetrics({
    instance: instanceFact({ lastError: { code: 'NODE_FINISH_MISSING', activityId: 'e1', remenders: 3 } }),
    events: [
      event(1, 'agent/reminder', 0, { elementId: 'a', activityId: 'e1', count: 1, maxFires: 3 }),
      event(2, 'agent/reminder', 10, { elementId: 'a', activityId: 'e1', count: 2, maxFires: 3 }),
      event(3, 'agent/reminder', 20, { elementId: 'a', activityId: 'e1', count: 3, maxFires: 3 }),
      event(4, 'error', 30, { elementId: 'a', activityId: 'e1', error: { code: 'NODE_FINISH_MISSING' } }),
      // 同一个 execution 的重复错误事实：不能累加成 2
      event(5, 'error', 40, { elementId: 'a', activityId: 'e1', error: { code: 'NODE_FINISH_MISSING' } }),
    ],
    asOf: iso(100),
  })
  assert.equal(metrics.finishReminder.fires, 3)
  assert.equal(metrics.finishReminder.missingExecutions, 1, 'lastError 与 error 事件同一 execution 只算 1')
})

test('connector：execution 级与 attempt 级分列；请求延迟与含退避总耗时分开', () => {
  const record = (overrides) => ({
    v: 1,
    instanceId: 'i-metrics',
    elementId: 'http1',
    executionId: 'e1',
    invocationId: 'inv-1',
    requestHash: 'b'.repeat(64),
    state: 'succeeded',
    attempts: 1,
    result: null,
    error: null,
    createdAt: iso(0),
    completedAt: iso(1_000),
    updatedAt: iso(1_000),
    ...overrides,
  })
  const metrics = computeInstanceMetrics({
    instance: instanceFact(),
    events: [
      event(1, 'http/attempt', 0, { elementId: 'http1', attempt: 1 }),
      event(2, 'http/result', 100, { elementId: 'http1', attempt: 1, status: 200, durationMs: 100 }),
      event(3, 'http/attempt', 200, { elementId: 'http1', attempt: 2 }),
      event(4, 'http/result', 500, { elementId: 'http1', attempt: 2, status: 500, durationMs: 300 }),
    ],
    connector: [
      record({ executionId: 'e1', state: 'succeeded' }),
      record({ executionId: 'e2', state: 'succeeded', createdAt: iso(2_000), completedAt: iso(4_000) }),
      record({ executionId: 'e3', state: 'failed', error: { code: 'HTTP_STATUS_NOT_ACCEPTABLE' } }),
      record({ executionId: 'e4', state: 'failed', error: { code: 'HTTP_CANCELED' } }),
      record({ executionId: 'e5', state: 'started', attempts: 0, completedAt: null }),
    ],
    asOf: iso(10_000),
  })
  assert.equal(metrics.connector.succeeded, 2)
  assert.equal(metrics.connector.errored, 1)
  assert.equal(metrics.connector.canceled, 1)
  assert.equal(metrics.connector.inFlight, 1)
  assert.equal(metrics.connector.successRate, 0.5, '2 / (2+1+1)')
  assert.equal(metrics.connector.attempts.results, 2)
  assert.equal(metrics.connector.attempts.succeeded, 1)
  assert.equal(metrics.connector.attempts.successRate, 0.5)
  assert.equal(metrics.connector.latency.request.p95Ms, 300, '单次请求延迟取 http/result.durationMs')
  assert.equal(metrics.connector.latency.total.p95Ms, 2_000, '含退避总耗时取记录 createdAt→completedAt')
  assert.equal(metrics.connector.latency.totalIncludesBackoff, true)
})

test('汇总：按实例 createdAt 选 cohort，groupBy=day，分位数从样本合并', () => {
  const make = (id, createdAt, latencyValues) => {
    const metrics = computeInstanceMetrics({
      instance: instanceFact({ id, createdAt }),
      events: latencyValues.map((value, index) => event(index + 1, 'http/result', index * 10, {
        elementId: 'http1', attempt: index + 1, status: 200, durationMs: value,
      })),
      connector: [{
        instanceId: id, elementId: 'http1', executionId: 'e1', state: 'succeeded', attempts: latencyValues.length,
        createdAt, completedAt: new Date(Date.parse(createdAt) + 1_000).toISOString(),
        updatedAt: createdAt,
      }],
      asOf: new Date(Date.parse(createdAt) + 10_000).toISOString(),
    })
    return { instance: { id, status: 'COMPLETED', createdAt, definitionId: 'flow-metrics', definitionVersion: 1 }, metrics }
  }
  const day1 = '2026-11-11T01:00:00.000Z'
  const day2 = '2026-11-12T01:00:00.000Z'
  const entries = [make('i-a', day1, [10, 100]), make('i-b', day2, [20])]
  const result = aggregateInstanceMetrics({ entries, groupBy: 'day', from: day1, to: day2 })
  assert.equal(result.schemaVersion, METRICS_SCHEMA_VERSION)
  assert.equal(result.totals.instances, 2)
  assert.deepEqual(result.groups.map(group => group.key), ['2026-11-11', '2026-11-12'])
  // 合并样本 [10,100,20] 的 p95 是 100；各实例 p95 平均会得到 (100+20)/2=60，那是错的。
  assert.equal(result.totals.connector.latency.request.p95Ms, 100)
  assert.notEqual(result.totals.connector.latency.request.p95Ms, 60)

  const filtered = aggregateInstanceMetrics({ entries, from: day2, to: day2, definitionId: 'flow-metrics', definitionVersion: 1 })
  assert.equal(filtered.totals.instances, 1)
  assert.equal(filtered.totals.byStatus.COMPLETED, 1)
})

test('缓存绑定 lastSeq/revision/schemaVersion；分位数与样本工具可独立复算', () => {
  const cache = createMetricsCache()
  let builds = 0
  const build = () => ({ value: ++builds })
  const first = cache.get(metricsCacheKey({ lastSeq: 3, revision: 2 }), build)
  const second = cache.get(metricsCacheKey({ lastSeq: 3, revision: 2 }), build)
  assert.equal(first.hit, false)
  assert.equal(second.hit, true, '同一指纹命中缓存')
  assert.equal(second.value.value, 1)
  const changed = cache.get(metricsCacheKey({ lastSeq: 4, revision: 2 }), build)
  assert.equal(changed.hit, false, 'lastSeq 一变即失效')
  assert.equal(changed.value.value, 2)
  cache.clear()
  assert.equal(cache.size, 0)

  assert.equal(percentileMs([10, 100, 20], 95), 100)
  assert.equal(percentileMs([], 95), null)
  assert.equal(summarizeLatency([]), null)
  assert.equal(summarizeLatency([1, 2, 3]).p50Ms, 2)
})

test('API 与离线纯函数逐字段一致；追加事件后缓存失效；GET 不启动 runner', async () => {
  const home = freshHome('api')
  const instancesRoot = join(home, 'instances')
  const id = 'i-metrics-api'
  const dir = join(instancesRoot, id)
  mkdirSync(dir, { recursive: true })
  const fact = instanceFact({ id })
  writeFileSync(join(dir, 'instance.json'), `${JSON.stringify(fact, null, 2)}\n`, 'utf8')
  await appendInstanceEvents(id, 'agent1', 1, [
    event(0, 'process/start', 0),
    event(0, 'activity/start', 1_000, { elementId: 'agent1', activityId: 'e1' }),
    event(0, 'agent/invocation', 1_100, { elementId: 'agent1', activityId: 'e1', invocationId: 'e1:invoke-1', provider: 'dsh' }),
    event(0, 'agent/usage', 1_200, {
      elementId: 'agent1', activityId: 'e1', invocationId: 'e1:invoke-1', provider: 'dsh',
      callId: 'call-1', trust: 'known', usage: { input: 10, cacheRead: 2, cacheWrite: 0, output: 3, total: 15 },
    }),
    event(0, 'activity/wait', 2_000, { elementId: 'human1', activityId: 'e2' }),
  ], { instancesRoot })

  const runtime = createBpmnRuntime({ dir: join(home, 'flows'), instancesRoot, definitionsRoot: join(home, 'definitions'), env: {} })
  try {
    const asOf = iso(10_000)
    const response = await runtime.handle({
      method: 'GET',
      parts: ['instances', id, 'metrics'],
      url: `http://localhost/instances/${id}/metrics?asOf=${encodeURIComponent(asOf)}`,
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(runtime._runners.size, 0, 'GET 指标绝不能启动 runner')
    assert.equal(runtime._metricsCache.size, 1)

    const instance = await readInstance(id, { instancesRoot })
    const events = await import('../src/instance-store.js').then(mod => mod.readInstanceEvents(id, { instancesRoot }))
    const offline = computeInstanceMetrics({ instance, events, asOf, skippedEvents: events.skipped ?? 0 })
    assert.deepEqual(response.body, offline, 'API 必须与离线纯函数逐字段一致')

    // 同一指纹第二次请求命中缓存（asOf 只参与最终投影，不参与归约指纹）。
    const again = await runtime.handle({
      method: 'GET',
      parts: ['instances', id, 'metrics'],
      url: `http://localhost/instances/${id}/metrics?asOf=${encodeURIComponent(asOf)}`,
    })
    assert.deepEqual(again.body, response.body)
    assert.equal(runtime._metricsCache.size, 1, '同一指纹不重复建缓存')

    // 追加事件 → instance.json 的 lastSeq/revision 变 → 新指纹、新归约。
    await appendInstanceEvents(id, 'human1', 2, [
      event(0, 'activity/start', 9_000, { elementId: 'human1', activityId: 'e2' }),
      event(0, 'activity/end', 9_500, { elementId: 'human1', activityId: 'e2', durationMs: 500 }),
    ], { instancesRoot })
    const changed = await runtime.handle({
      method: 'GET',
      parts: ['instances', id, 'metrics'],
      url: `http://localhost/instances/${id}/metrics?asOf=${encodeURIComponent(iso(20_000))}`,
    })
    assert.equal(changed.status, 200)
    assert.equal(changed.body.throughSeq, 7)
    assert.equal(runtime._metricsCache.size, 2, '事件一变即产生新指纹（旧缓存不再复用）')
    assert.equal(changed.body.human.completedWaitMs, 7_500, 'wait 2s → end 9.5s = 7.5s')

    // 汇总路由直接扫 instances/ 目录：第二个实例（没有事件）也必须被计入。
    const otherId = 'i-metrics-api-2'
    const otherDir = join(instancesRoot, otherId)
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(otherDir, 'instance.json'), `${JSON.stringify(instanceFact({ id: otherId }), null, 2)}\n`, 'utf8')
    const summary = await runtime.handle({
      method: 'GET',
      parts: ['metrics'],
      url: 'http://localhost/metrics?definitionId=flow-metrics&definitionVersion=1&groupBy=day',
    })
    assert.equal(summary.status, 200, JSON.stringify(summary.body))
    assert.equal(summary.body.totals.instances, 2, '默认 listInstances limit 不能漏计')
    assert.equal(summary.body.totals.byStatus.ACTIVE, 2)
    assert.deepEqual(summary.body.groups.map(group => group.key), ['2026-11-12'])
  } finally {
    await runtime.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

// MINOR-1（0.14.4）API 侧：事件正文的补写可以**不改变** instance.json 的
// lastSeq / revision（失败重试只补投影）。此时缓存指纹不变，唯一能阻止旧值的是
// 「残缺归约不写入缓存」——补写后同指纹请求必须重算并给出正确数值。
test('MINOR-1：API 侧同指纹重算——补写事件后不再命中窗口期的残缺缓存', async () => {
  const home = freshHome('backfill-api')
  const instancesRoot = join(home, 'instances')
  const id = 'i-metrics-backfill'
  const dir = join(instancesRoot, id)
  mkdirSync(dir, { recursive: true })
  const stale = instanceFact({ id, status: 'ACTIVE', lastSeq: 2, eventCount: 2, revision: 7 })
  const staleText = `${JSON.stringify(stale, null, 2)}\n`
  writeFileSync(join(dir, 'instance.json'), staleText, 'utf8')
  // 先只有 suspend 事件正文：resume 的 seq 2 已在元数据里公布，但正文还没补上。
  // 直接写 JSONL（不经过 appendInstanceEvents），才能把元数据固定在旧值。
  const shard = join(dir, 'events', 'process', '1.jsonl')
  mkdirSync(join(dir, 'events', 'process'), { recursive: true })
  writeFileSync(shard, `${JSON.stringify({ ...event(1, 'instance/suspended', 1_000) })}\n`, 'utf8')

  const runtime = createBpmnRuntime({
    dir: join(home, 'flows'),
    instancesRoot,
    definitionsRoot: join(home, 'definitions'),
    env: {},
  })
  const request = asOf => ({
    method: 'GET',
    parts: ['instances', id, 'metrics'],
    url: `http://localhost/instances/${id}/metrics?asOf=${encodeURIComponent(asOf)}`,
  })
  try {
    const asOf = iso(20_000)
    const first = await runtime.handle(request(asOf))
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.complete, false)
    assert.equal(runtime._metricsCache.size, 0, '残缺归约不写入缓存')
    assert.equal(first.body.duration.suspendedMs, null, '缺 resume 事件 → 未知')

    // 补写 resume 正文（seq 2）；instance.json 仍是同一份旧元数据（lastSeq=2 / revision=7 不变）。
    appendFileSync(shard, `${JSON.stringify({ ...event(2, 'instance/resumed', 9_000) })}\n`, 'utf8')
    const instance = await readInstance(id, { instancesRoot })
    assert.equal(instance.lastSeq, 2, '指纹里的元数据没变')
    assert.equal(instance.revision, 7)

    const second = await runtime.handle(request(asOf))
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.duration.suspendedMs, 8_000, '补写后按 1s→9s 给出正确挂起时长')
    assert.equal(second.body.complete, true)
    assert.equal(runtime._metricsCache.size, 1, '完整结果才进缓存')
  } finally {
    await runtime.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 0.14.5 M7 / M2：null 桶、partial 覆盖、结算快照、缓存指纹 ──────────────────

test('M7：只上报 input 时其余桶是 null、覆盖 partial、total 未知', () => {
  const metrics = computeInstanceMetrics({
    instance: instanceFact(),
    events: [
      event(1, 'agent/invocation', 0, { elementId: 'agent1', activityId: 'e1', invocationId: 'e1:invoke-1', provider: 'claude' }),
      event(2, 'agent/usage', 10, {
        elementId: 'agent1', activityId: 'e1', invocationId: 'e1:invoke-1', provider: 'claude',
        callId: 'call-1', trust: 'known', observedBuckets: ['input'], usage: { input: 10 },
      }),
    ],
    asOf: iso(1_000),
  })
  assert.deepEqual(metrics.agent.observedTokens, {
    input: 10, cacheRead: null, cacheWrite: null, output: null, total: null, partial: true,
  }, '未观测桶是 null；显式 0 才保留为 0')
  assert.deepEqual(metrics.agent.usageCoverage, { known: 0, partial: 1, unknown: 0 })
  assert.deepEqual(metrics.agent.buckets.seen, ['input'])
  assert.deepEqual(metrics.agent.buckets.missing, ['cacheRead', 'cacheWrite', 'output'])
  assert.equal(metrics.agent.buckets.complete, false)
  assert.ok(metrics.dataQuality.reasons.includes(METRICS_REASON.USAGE_MISSING_BUCKETS))
})

test('M2：agent/usage-snapshot 按 scope 覆盖调用桶，且不增加模型调用数', () => {
  const metrics = computeInstanceMetrics({
    instance: instanceFact(),
    events: [
      event(1, 'agent/invocation', 0, { elementId: 'agent1', activityId: 'e1', invocationId: 'inv-1', provider: 'claude' }),
      event(2, 'agent/usage', 10, {
        elementId: 'agent1', activityId: 'e1', invocationId: 'inv-1', provider: 'claude',
        callId: 'call-1', trust: 'known', observedBuckets: ['input', 'output'], usage: { input: 10, output: 1 },
      }),
      event(3, 'agent/usage', 20, {
        elementId: 'agent1', activityId: 'e1', invocationId: 'inv-1', provider: 'claude',
        callId: 'call-2', trust: 'known', observedBuckets: ['input', 'output'], usage: { input: 5, output: 2 },
      }),
      event(4, 'agent/usage-snapshot', 30, {
        elementId: 'agent1', activityId: 'e1', invocationId: 'inv-1', provider: 'claude',
        snapshotId: 'snap-1', scope: 'invocation', agentScope: 'main', sessionScopeId: 'sess-1',
        usage: { input: 15, cacheRead: 0, cacheWrite: 0, output: 33, total: 48 },
        observedBuckets: ['input', 'cacheRead', 'cacheWrite', 'output'],
        provenance: { contract: 'claude-result-usage-v1', realCliVerified: false },
      }),
    ],
    asOf: iso(1_000),
  })
  assert.equal(metrics.agent.modelCalls, 2, '快照是结算，不是第 3 次模型调用')
  assert.deepEqual(metrics.agent.observedTokens, {
    input: 15, cacheRead: 0, cacheWrite: 0, output: 33, total: 48, partial: false,
  }, '有效快照覆盖的桶用快照值（output 33 而非占位的 1+2）')
  assert.equal(metrics.agent.snapshots.invocation, 1)
})

test('M7：历史事件没有 observedBuckets → 完整性未知（不把补零反推成已知）', () => {
  const metrics = computeInstanceMetrics({
    instance: instanceFact(),
    events: [
      event(1, 'agent/invocation', 0, { elementId: 'agent1', activityId: 'e1', invocationId: 'e1:invoke-1', provider: 'dsh' }),
      event(2, 'agent/usage', 10, {
        elementId: 'agent1', activityId: 'e1', invocationId: 'e1:invoke-1', provider: 'dsh',
        callId: 'legacy-call', trust: 'known',
        usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, total: 15 },
      }),
    ],
    asOf: iso(1_000),
  })
  assert.equal(metrics.agent.observedTokens.input, 10)
  assert.equal(metrics.agent.observedTokens.output, 5)
  assert.equal(metrics.agent.observedTokens.total, null, '旧事件无法证明补零来自真实观测 → 总量未知')
  assert.equal(metrics.agent.usageCoverage.known, 0)
  assert.equal(metrics.agent.usageCoverage.partial, 1)
  assert.ok(metrics.dataQuality.reasons.includes('usage-history-mask-missing'))
})

test('M7：指标缓存 key 包含 usage schema 与快照指纹', () => {
  const base = instanceFact({ lastSeq: 1, revision: 1 })
  const callUsage = input => [
    event(1, 'agent/usage', 0, {
      elementId: 'agent1', activityId: 'e1', invocationId: 'inv-1', provider: 'claude',
      callId: 'call-1', trust: 'known', observedBuckets: ['input'], usage: { input },
    }),
  ]
  const keyA = metricsCacheKey(metricsFingerprintFor(base, { events: callUsage(10) }))
  const keyB = metricsCacheKey(metricsFingerprintFor(base, { events: callUsage(20) }))
  assert.notEqual(keyA, keyB, '同一 seq/type/at 但 usage 正文不同 → key 必须不同')

  const snapshot = scope => [event(1, 'agent/usage-snapshot', 0, {
    elementId: 'agent1', activityId: 'e1', invocationId: 'inv-1', provider: 'claude',
    snapshotId: 'snap-1', scope, usage: { input: 10 }, observedBuckets: ['input'],
  })]
  const keyC = metricsCacheKey(metricsFingerprintFor(base, { events: snapshot('invocation') }))
  const keyD = metricsCacheKey(metricsFingerprintFor(base, { events: snapshot('unknown') }))
  assert.notEqual(keyC, keyD, '同一 seq/type/at 但快照 scope 不同 → key 必须不同')

  const parsed = JSON.parse(metricsCacheKey({}))
  assert.equal(parsed.schemaVersion, METRICS_SCHEMA_VERSION)
  assert.equal(parsed.schemaVersion, 2, 'M7 要求 METRICS_SCHEMA_VERSION 升到 2')
  assert.equal(parsed.usageSchema, 2)
})
