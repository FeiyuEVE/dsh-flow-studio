#!/usr/bin/env node
/**
 * Claude 用量账本自检（0.14.5）：
 *  - M1：同一 message.id 的重复/并行工具块是**一次**模型调用，桶取并集/更新（不相加）；
 *  - M2：assistant 的 output 占位值 + result 的最终用量 → 结算快照（scope=invocation）；
 *  - M2：result-only 两轮在 invocation / session-cumulative / unknown 三种作用域下的归约；
 *  - M2：没有 result 时 output 保持「未最终观测」（不是 0，也不算完整）；
 *  - m2：201 次调用全保留（计量账本不按诊断缓存上限裁剪）；
 *  - 事件序列化后重放（写盘 → 读回 → 归约）与内存一致，单条事件 < 8 KiB。
 *
 * 事件由账本产出后交给 `agent-telemetry` / `instance-metrics` 走真实归约链，
 * 不直接断言中间结构——这样「账本 → 事件 → 指标」三段契约一起被验证。
 *
 * 运行：node test/claude-usage-ledger.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createClaudeUsageLedger } from '../src/claude-usage-ledger.js'
import { usageEventForCall } from '../src/agent-telemetry.js'
import { aggregateInstanceMetrics, computeInstanceMetrics } from '../src/instance-metrics.js'
import { appendInstanceEvents, readInstance, readInstanceEvents } from '../src/instance-store.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const T0 = Date.parse('2026-11-12T00:00:00.000Z')
function iso(offsetMs) {
  return new Date(T0 + offsetMs).toISOString()
}

function instanceFact(overrides = {}) {
  return {
    id: 'i-ledger',
    definitionId: 'flow-ledger',
    definitionVersion: 1,
    definitionHash: 'a'.repeat(64),
    status: 'ACTIVE',
    variables: {},
    result: null,
    artifacts: [],
    lastError: null,
    lastAgentOutput: null,
    pendingTasks: [],
    revision: 1,
    eventCount: 0,
    lastSeq: 0,
    createdAt: iso(0),
    updatedAt: iso(0),
    completedAt: null,
    definitionSnapshot: 'definition.bpmn',
    ...overrides,
  }
}

/** Claude stream-json assistant 事件（message.usage 是 provider 原始字段）。 */
function assistantEvent(messageId, usage, extra = {}) {
  return {
    type: 'assistant',
    session_id: 'sess-1',
    message: { id: messageId, role: 'assistant', content: [], usage },
    ...extra,
  }
}

/** Claude stream-json result 事件（最终用量在这里，assistant 里可能只是占位值）。 */
function resultEvent(usage, extra = {}) {
  return { type: 'result', subtype: 'success', session_id: 'sess-1', usage, ...extra }
}

const CLAUDE_ZERO_CACHE = { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function eventsFromLedger(ledger, options = {}) {
  const fallbackInvocationId = options.invocationId ?? 'exec-1:invoke-1'
  const invocationIds = Array.isArray(options.invocationIds) ? options.invocationIds : [fallbackInvocationId]
  const events = []
  let seq = 0
  for (const invocationId of invocationIds) {
    events.push({ seq: ++seq, at: iso(seq), type: 'agent/invocation', invocationId, provider: 'claude' })
  }
  for (const call of ledger.usageCalls()) {
    events.push({
      seq: ++seq,
      at: iso(seq),
      ...usageEventForCall({ ...call, invocationId: call.invocationId ?? fallbackInvocationId }),
    })
  }
  for (const snapshot of ledger.snapshots()) {
    events.push({ seq: ++seq, at: iso(seq), type: 'agent/usage-snapshot', ...snapshot })
  }
  return events
}

function metricsFor(ledger, options = {}) {
  const events = eventsFromLedger(ledger, options)
  return computeInstanceMetrics({
    instance: instanceFact({ lastSeq: events.length, eventCount: events.length }),
    events,
    asOf: iso(60_000),
  })
}

function bucketValues(usage) {
  return {
    input: usage.input,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    output: usage.output,
    total: usage.total,
  }
}

test('M1：同一 message.id 两个并行工具块 → 1 次调用，用量取并集/更新而不是相加', () => {
  const ledger = createClaudeUsageLedger()
  const usage = { input_tokens: 10, output_tokens: 30, ...CLAUDE_ZERO_CACHE }
  ledger.recordAssistant(assistantEvent('msg-same', usage))
  // 并行工具块共享 message.id：同一响应的第二次上报，不能变成第二次调用。
  ledger.recordAssistant(assistantEvent('msg-same', usage))
  let calls = ledger.usageCalls()
  assert.equal(calls.length, 1, '同一 message.id 只能计 1 次模型调用（基线：2）')
  assert.deepEqual(bucketValues(calls[0].usage), { input: 10, cacheRead: 0, cacheWrite: 0, output: 30, total: 40 },
    '重复上报是替换/并集，不是相加（基线：80）')
  assert.deepEqual(calls[0].observedBuckets, ['input', 'cacheRead', 'cacheWrite', 'output'],
    '调用记录必须保留观测掩码')

  // 不同 message.id 必须分别计数。
  ledger.recordAssistant(assistantEvent('msg-other', usage))
  calls = ledger.usageCalls()
  assert.equal(calls.length, 2, '不同 message.id 是两次真实模型响应')

  // 同 ID 的增量更新：只带 output 的更新不能把 input/cache 清零，也不能相加。
  ledger.recordAssistant(assistantEvent('msg-same', { output_tokens: 31 }))
  calls = ledger.usageCalls()
  assert.equal(calls.length, 2)
  assert.deepEqual(bucketValues(calls[0].usage), { input: 10, cacheRead: 0, cacheWrite: 0, output: 31, total: 41 },
    '未上报的桶保留旧观测值，只替换上报过的桶')
})

test('M2：assistant 10/1 → result 10/30（缓存两桶显式 0）→ 调用 1、总量 40', () => {
  const ledger = createClaudeUsageLedger({ sessionScopeId: 'sess-1' })
  ledger.recordAssistant(assistantEvent('msg-1', { input_tokens: 10, output_tokens: 1 }))
  assert.equal(ledger.usageCalls().length, 1)
  assert.equal(ledger.usageCalls()[0].usage.output, 1, 'assistant output 是未经结算的占位观测')

  ledger.recordResult(resultEvent({ input_tokens: 10, output_tokens: 30, ...CLAUDE_ZERO_CACHE }), {
    invocationId: 'inv-1',
    sessionScopeId: 'sess-1',
  })
  assert.equal(ledger.snapshots().length, 1, 'result 必须是结算快照，不是第 2 次模型调用')
  assert.equal(ledger.snapshots()[0].scope, 'invocation', '未 resume 的新会话 result 是本次 invocation 的结算')
  assert.deepEqual(
    ledger.snapshots()[0].provenance,
    { contract: 'claude-result-usage-v1', realCliVerified: false },
    '快照必须标注合同版本与「真实 CLI 未验证」',
  )

  const metrics = metricsFor(ledger, { invocationId: 'inv-1' })
  assert.equal(metrics.agent.modelCalls, 1, 'result 不增加模型调用数')
  assert.deepEqual(bucketValues(metrics.agent.observedTokens), {
    input: 10, cacheRead: 0, cacheWrite: 0, output: 30, total: 40,
  }, '结算快照覆盖调用桶：output 从占位 1 变成 30，总量 40')
  assert.deepEqual(metrics.agent.usageCoverage, { known: 1, partial: 0, unknown: 0 })
})

test('M2：result-only 两轮 10/1、30/3 的三种作用域', () => {
  // ① invocation：各自结算本次执行 → 相加 40/4。
  const invocationLedger = createClaudeUsageLedger({ sessionScopeId: 'sess-1' })
  invocationLedger.recordResult(resultEvent({ input_tokens: 10, output_tokens: 1, ...CLAUDE_ZERO_CACHE }), {
    invocationId: 'inv-1', sessionScopeId: 'sess-1',
  })
  invocationLedger.recordResult(resultEvent({ input_tokens: 30, output_tokens: 3, ...CLAUDE_ZERO_CACHE }), {
    invocationId: 'inv-2', sessionScopeId: 'sess-1',
  })
  const invocation = metricsFor(invocationLedger, { invocationIds: ['inv-1', 'inv-2'] })
  assert.equal(invocation.agent.observedTokens.input, 40, 'invocation scope 的不同执行可以相加')
  assert.equal(invocation.agent.observedTokens.output, 4)
  assert.equal(invocation.agent.observedTokens.total, 44)
  assert.equal(invocation.agent.usageCoverage.known, 2)

  // ② session-cumulative：同一累计范围只取最新 → 30/3。
  const cumulativeLedger = createClaudeUsageLedger({ sessionScopeId: 'sess-1' })
  cumulativeLedger.recordResult(resultEvent({ input_tokens: 10, output_tokens: 1, ...CLAUDE_ZERO_CACHE }), {
    invocationId: 'inv-1', sessionScopeId: 'sess-1', scope: 'session-cumulative',
  })
  cumulativeLedger.recordResult(resultEvent({ input_tokens: 30, output_tokens: 3, ...CLAUDE_ZERO_CACHE }), {
    invocationId: 'inv-2', sessionScopeId: 'sess-1', scope: 'session-cumulative',
  })
  assert.equal(cumulativeLedger.snapshots().length, 1, '同一累计范围只保留最新有效快照')
  const cumulative = metricsFor(cumulativeLedger, { invocationIds: ['inv-1', 'inv-2'] })
  assert.equal(cumulative.agent.observedTokens.input, 30, '累计值不能相加成 40')
  assert.equal(cumulative.agent.observedTokens.output, 3)
  assert.equal(cumulative.agent.observedTokens.total, 33)

  // ③ unknown（resume 后范围不可证明）：保留原始快照，不按数值猜 sum/max。
  const unknownLedger = createClaudeUsageLedger({ sessionScopeId: 'sess-1' })
  unknownLedger.recordResult(resultEvent({ input_tokens: 10, output_tokens: 1, ...CLAUDE_ZERO_CACHE }), {
    invocationId: 'inv-1', sessionScopeId: 'sess-1', resumed: true,
  })
  unknownLedger.recordResult(resultEvent({ input_tokens: 30, output_tokens: 3, ...CLAUDE_ZERO_CACHE }), {
    invocationId: 'inv-2', sessionScopeId: 'sess-1', resumed: true,
  })
  assert.equal(unknownLedger.snapshots().length, 2, 'unknown 作用域保留每一份原始快照')
  assert.ok(unknownLedger.snapshots().every(snapshot => snapshot.scope === 'unknown'))
  const unknown = metricsFor(unknownLedger, { invocationIds: ['inv-1', 'inv-2'] })
  assert.equal(unknown.agent.snapshots.unknown, 2)
  assert.equal(unknown.agent.observedTokens, null, 'unknown 范围不能给出确定总量')
  assert.deepEqual(unknown.agent.usageCoverage, { known: 0, partial: 0, unknown: 2 })
  assert.ok(unknown.dataQuality.reasons.includes('usage-scope-unknown'))
})

test('M2：没有 result 时 assistant output 保持「未最终观测」（不是 0、也不是完整）', () => {
  const ledger = createClaudeUsageLedger({ sessionScopeId: 'sess-1' })
  ledger.recordAssistant(assistantEvent('msg-1', { input_tokens: 10, output_tokens: 1 }))
  assert.deepEqual(ledger.snapshots(), [], '没有 result 就没有结算快照')
  const metrics = metricsFor(ledger, { invocationId: 'inv-1' })
  assert.equal(metrics.agent.observedTokens.input, 10)
  assert.equal(metrics.agent.observedTokens.output, 1, '未结算的 output 保留观测值，不是 0')
  assert.equal(metrics.agent.observedTokens.cacheRead, null)
  assert.equal(metrics.agent.observedTokens.cacheWrite, null)
  assert.equal(metrics.agent.observedTokens.total, null, '缺桶 + 未结算 → 完整总量未知')
  assert.equal(metrics.agent.observedTokens.partial, true)
  assert.deepEqual(metrics.agent.usageCoverage, { known: 0, partial: 1, unknown: 0 })
  assert.ok(metrics.dataQuality.reasons.includes('usage-output-provisional'),
    '必须明确标记 output 只是占位观测')
})

test('m2：201 次调用全保留；同 ID 更新后仍是 201 次（402 → 403 token）', () => {
  const ledger = createClaudeUsageLedger({ sessionScopeId: 'sess-1' })
  for (let index = 0; index < 201; index += 1) {
    ledger.recordAssistant(assistantEvent(`msg-${index}`, {
      input_tokens: 1, output_tokens: 1, ...CLAUDE_ZERO_CACHE,
    }))
  }
  assert.equal(ledger.usageCalls().length, 201, '计量账本不能被诊断缓存上限裁到 200')
  const before = metricsFor(ledger, { invocationId: 'inv-1' })
  assert.equal(before.agent.modelCalls, 201)
  // M2 残余：这 201 条都只是 assistant 观测（没有 result 结算），总量可以展示为
  // 「已观测小计」，但不能宣称完整 total（旧断言 total=402 把占位值当结案）。
  assert.equal(before.agent.observedTokens.total, null, '未结算的 assistant 不能给完整 total')
  assert.deepEqual(before.agent.observedTokensPartial, { input: 201, cacheRead: 0, cacheWrite: 0, output: 201 },
    '201 次 × 2 token 的已观测小计必须完整保留')

  ledger.recordAssistant(assistantEvent('msg-0', { output_tokens: 2 }))
  assert.equal(ledger.usageCalls().length, 201, '更新同 ID 不增加调用数')
  const after = metricsFor(ledger, { invocationId: 'inv-1' })
  assert.equal(after.agent.modelCalls, 201)
  assert.equal(after.agent.observedTokens.total, null)
  assert.deepEqual(after.agent.observedTokensPartial, { input: 201, cacheRead: 0, cacheWrite: 0, output: 202 },
    '旧值被替换：200×1 + 2 = 202 output（201 input）')
})

test('跨实例汇总区分 null / partial：缺失桶不补 0，未知实例让合计降级', () => {
  const complete = computeInstanceMetrics({
    instance: instanceFact({ id: 'i-complete' }),
    events: [
      { seq: 1, at: iso(1), type: 'agent/invocation', invocationId: 'inv-a', provider: 'claude' },
      {
        seq: 2, at: iso(2), type: 'agent/usage', invocationId: 'inv-a', provider: 'claude',
        callId: 'call-a', trust: 'known', observedBuckets: ['input', 'cacheRead', 'cacheWrite', 'output'],
        usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 30, total: 40 },
      },
    ],
    asOf: iso(1_000),
  })
  const partial = computeInstanceMetrics({
    instance: instanceFact({ id: 'i-partial' }),
    events: [
      { seq: 1, at: iso(1), type: 'agent/invocation', invocationId: 'inv-b', provider: 'claude' },
      {
        seq: 2, at: iso(2), type: 'agent/usage', invocationId: 'inv-b', provider: 'claude',
        callId: 'call-b', trust: 'known', observedBuckets: ['input'],
        usage: { input: 10 },
      },
    ],
    asOf: iso(1_000),
  })
  const unknown = computeInstanceMetrics({
    instance: instanceFact({ id: 'i-unknown' }),
    events: [
      { seq: 1, at: iso(1), type: 'agent/invocation', invocationId: 'inv-c', provider: 'claude' },
      { seq: 2, at: iso(2), type: 'agent/usage', invocationId: 'inv-c', provider: 'claude', callId: 'claude:unobserved', trust: 'unknown', synthetic: true },
    ],
    asOf: iso(1_000),
  })
  assert.equal(unknown.agent.modelCalls, null, 'synthetic 未知占位不算模型调用')

  const aggregate = aggregateInstanceMetrics({
    entries: [complete, partial, unknown].map(metrics => ({ instance: { id: metrics.instanceId, status: 'ACTIVE', createdAt: iso(0) }, metrics })),
  })
  const tokens = aggregate.totals.agent.observedTokens
  assert.equal(tokens.input, null, '有未知实例时合计 input 不能声称精确')
  assert.deepEqual(tokens, {
    input: null, cacheRead: null, cacheWrite: null, output: null, total: null, partial: true,
  })
  assert.equal(aggregate.totals.agent.observedTokensPartial.input, 20, '已观测小计允许给出（10+10）')
  assert.deepEqual(aggregate.totals.agent.usageCoverage, { known: 1, partial: 1, unknown: 1 })
})

test('事件序列化后重放（写盘 → 读回 → 归约）与内存一致；单条事件 < 8 KiB', async () => {
  const home = mkdtempSync(join(repoRoot, '.tmp', 'home-ledger-replay-'))
  const instancesRoot = join(home, 'instances')
  const id = 'i-ledger-replay'
  const dir = join(instancesRoot, id)
  mkdirSync(dir, { recursive: true })
  const fact = instanceFact({ id })
  writeFileSync(join(dir, 'instance.json'), `${JSON.stringify(fact, null, 2)}\n`, 'utf8')

  const ledger = createClaudeUsageLedger({ sessionScopeId: 'sess-1' })
  ledger.recordAssistant(assistantEvent('msg-1', { input_tokens: 10, output_tokens: 1 }))
  ledger.recordResult(resultEvent({ input_tokens: 10, output_tokens: 30, ...CLAUDE_ZERO_CACHE }), {
    invocationId: 'inv-1', sessionScopeId: 'sess-1',
  })
  const rawEvents = eventsFromLedger(ledger, { invocationId: 'inv-1' }).map(({ seq, ...event }) => event)
  for (const event of rawEvents) {
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
    assert.ok(bytes < 8 * 1024, `${event.type} 事件 ${bytes} 字节必须 < 8 KiB`)
  }

  try {
    const written = await appendInstanceEvents(id, 'agent1', 1, rawEvents, { instancesRoot })
    const persisted = await readInstanceEvents(id, { instancesRoot })
    const instance = await readInstance(id, { instancesRoot })
    assert.ok(persisted.some(event => event.type === 'agent/usage-snapshot'), '快照事件必须落盘（不是只在适配器内存里）')
    assert.ok(persisted.some(event => event.type === 'agent/usage'))

    const asOf = iso(60_000)
    const fromMemory = computeInstanceMetrics({ instance, events: written.events, asOf })
    const fromDisk = computeInstanceMetrics({ instance, events: persisted, asOf })
    assert.deepEqual(fromDisk, fromMemory, '写盘 → 读回 → 归约 必须与内存归约逐字段一致')
    assert.equal(fromDisk.agent.observedTokens.total, 40)
    assert.equal(fromDisk.agent.modelCalls, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 0.14.6 M1 残余 / M2 残余 / F3 ───────────────────────────────────────────

test('0.14.6 M1：assistant 先到、session_id 后到 → 同一 message.id 重键合并，不重复计数', () => {
  const ledger = createClaudeUsageLedger()
  const usage = { input_tokens: 10, output_tokens: 30, ...CLAUDE_ZERO_CACHE }
  // 第一条 assistant 没有 session_id（Claude 的 init 可能晚到）。
  ledger.recordAssistant({ type: 'assistant', message: { id: 'msg-late', role: 'assistant', content: [], usage } })
  assert.equal(ledger.usageCalls().length, 1)
  assert.equal(ledger.usageCalls()[0].sessionScopeId ?? null, null, '先记录时 session 身份还不知道')

  // session_id 到达后，同一个 message.id 必须重键到同一调用，而不是新增一条。
  ledger.recordAssistant({ type: 'assistant', session_id: 'sess-late', message: { id: 'msg-late', role: 'assistant', content: [], usage } })
  const calls = ledger.usageCalls()
  assert.equal(calls.length, 1, '同一 message.id 只能有 1 次调用（基线：2 次）')
  assert.deepEqual(bucketValues(calls[0].usage), { input: 10, cacheRead: 0, cacheWrite: 0, output: 30, total: 40 },
    '用量是替换/并集，不是累加成 80')
  assert.equal(calls[0].sessionScopeId, 'sess-late', '重键后身份使用确定的 session')

  const metrics = metricsFor(ledger, { invocationId: 'inv-late' })
  assert.equal(metrics.agent.modelCalls, 1)
  // 没有 result 结算 → total 不完整，但已观测小计必须是 40（不是 80）。
  assert.equal(metrics.agent.observedTokens.total, null)
  assert.deepEqual(metrics.agent.observedTokensPartial, { input: 10, cacheRead: 0, cacheWrite: 0, output: 30 })
})

test('0.14.6 M1：晚绑 session 时多个未绑定调用各自重键，不合并成一次', () => {
  const ledger = createClaudeUsageLedger()
  const usage = { input_tokens: 1, output_tokens: 1, ...CLAUDE_ZERO_CACHE }
  ledger.recordAssistant({ type: 'assistant', message: { id: 'msg-a', usage } })
  ledger.recordAssistant({ type: 'assistant', message: { id: 'msg-b', usage } })
  assert.equal(ledger.usageCalls().length, 2)
  ledger.recordAssistant({ type: 'assistant', session_id: 'sess-late', message: { id: 'msg-b', usage: { output_tokens: 2 } } })
  const calls = ledger.usageCalls()
  assert.equal(calls.length, 2, '不同 message.id 仍是两次调用')
  assert.ok(calls.every(call => call.sessionScopeId === 'sess-late'), '两条都已重键')
})

test('0.14.6 M2：四桶齐全但 provisional 的 assistant 没有 result → 指标不标完整', () => {
  const ledger = createClaudeUsageLedger({ sessionScopeId: 'sess-1' })
  ledger.recordAssistant(assistantEvent('msg-1', { input_tokens: 10, output_tokens: 1, ...CLAUDE_ZERO_CACHE }))
  const metrics = metricsFor(ledger, { invocationId: 'inv-1' })
  assert.equal(metrics.agent.observedTokens.input, 10)
  assert.equal(metrics.agent.observedTokens.output, 1, '占位值保留，不走失也不当结案')
  assert.equal(metrics.agent.observedTokens.total, null, '没有 result 结算时不能宣称完整 11')
  assert.equal(metrics.agent.observedTokens.partial, true)
  assert.deepEqual(metrics.agent.usageCoverage, { known: 0, partial: 1, unknown: 0 })
  assert.ok(metrics.dataQuality.reasons.includes('usage-output-provisional'))
})

test('0.14.6 F3：unknown snapshotId 带执行作用域——两个账本不再撞同一个 id', () => {
  const run = (invocationId, input) => {
    const ledger = createClaudeUsageLedger({ sessionScopeId: 'sess-1', invocationId })
    ledger.recordResult(resultEvent({ input_tokens: input, output_tokens: 0, ...CLAUDE_ZERO_CACHE }), {
      invocationId, sessionScopeId: 'sess-1', resumed: true,
    })
    assert.equal(ledger.snapshots().length, 1)
    assert.equal(ledger.snapshots()[0].scope, 'unknown')
    return ledger
  }
  const 第一轮 = run('exec-1:invoke-1', 10)
  const 第二轮 = run('exec-2:invoke-1', 30)
  const ids = [...第一轮.snapshots(), ...第二轮.snapshots()].map(snapshot => snapshot.snapshotId)
  assert.equal(new Set(ids).size, 2, '两次独立执行的 unknown 快照必须各自唯一')

  // 落到同一实例事件流后归约：两份 unknown 事实都要保留，不能去重成 1 份。
  const firstEvents = eventsFromLedger(第一轮, { invocationId: 'exec-1:invoke-1' })
  const events = [
    ...firstEvents,
    ...eventsFromLedger(第二轮, { invocationId: 'exec-2:invoke-1' }).map(event => ({
      ...event,
      seq: event.seq + firstEvents.length,
    })),
  ]
  const metrics = computeInstanceMetrics({
    instance: instanceFact({ lastSeq: events.length, eventCount: events.length }),
    events,
    asOf: iso(60_000),
  })
  assert.equal(metrics.agent.snapshots.total, 2, '磁盘两份 unknown 快照，指标不能只剩 1 份')
  assert.equal(metrics.agent.snapshots.unknown, 2)
  assert.deepEqual(metrics.agent.usageCoverage, { known: 0, partial: 0, unknown: 2 })
  assert.equal(metrics.agent.observedTokens, null)
})
