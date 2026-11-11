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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const {
  METRICS_REASON, METRICS_SCHEMA_VERSION, aggregateInstanceMetrics, computeInstanceMetrics,
  createMetricsCache, metricsCacheKey, percentileMs, summarizeLatency,
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
  assert.deepEqual(metrics.agent.usageCoverage, { known: 0, unknown: 0 })
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
  assert.deepEqual(metrics.agent.usageCoverage, { known: 0, unknown: 1 })
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
  assert.deepEqual(metrics.agent.usageCoverage, { known: 0, unknown: 1 })
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
  assert.equal(metrics.agent.observedTokens.total, 185)
  assert.equal(metrics.agent.usageCoverage.known, 2)
  assert.ok(metrics.dataQuality.reasons.includes(METRICS_REASON.LEGACY_USAGE_FALLBACK))
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
