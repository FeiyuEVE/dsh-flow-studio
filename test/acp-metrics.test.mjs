#!/usr/bin/env node
/**
 * ACP 账本 → 遥测事件 → 实例指标 的端到端归约自检（0.15.0 P2）。
 *
 * 账本不直接断言中间结构：先把 `usageCalls()` / `usageSnapshots()` 按适配器真实
 * 路径（`readAdapterUsageCalls` / `readAdapterUsageSnapshots`）转成事件，再交给
 * `instance-metrics` 归约，验证：
 *
 *   - prompt usage 是 invocation 快照，不增加模型调用数（modelCalls=null）；
 *   - 两轮/多轮直接相加，不做累计差分；
 *   - 缺一轮 → 只有该轮 unknown，已观测小计保留、完整 total=null；
 *   - synthetic 未知占位不算模型调用，也不能被同 provider 的另一 session 遮蔽；
 *   - 缺桶不补 0；只有 used/size 时 observedTokens=null。
 *
 * 运行：node test/acp-metrics.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createAcpUsageLedger } from '../src/acp-usage-ledger.js'
import {
  readAdapterUsageCalls,
  readAdapterUsageSnapshots,
  usageEventForCall,
  usageSnapshotEventFor,
} from '../src/agent-telemetry.js'
import { computeInstanceMetrics } from '../src/instance-metrics.js'

const EXECUTION_ID = 'exec-acp-metrics'
const SESSION_ID = 'sess-acp-metrics'
const AGENT_INFO = { name: '@agentclientprotocol/codex-acp', version: '2.6.0' }
const T0 = Date.parse('2026-11-12T00:00:00.000Z')

function iso(offsetMs) {
  return new Date(T0 + offsetMs).toISOString()
}

function instanceFact(overrides = {}) {
  return {
    id: 'i-acp',
    definitionId: 'flow-acp',
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

function ledgerOf(options = {}) {
  return createAcpUsageLedger({
    executionId: EXECUTION_ID,
    sessionId: SESSION_ID,
    agentInfo: AGENT_INFO,
    ...options,
  })
}

function promptUsage(input, cacheRead, cacheWrite, output) {
  return {
    inputTokens: input,
    cachedReadTokens: cacheRead,
    cachedWriteTokens: cacheWrite,
    outputTokens: output,
    totalTokens: input + cacheRead + cacheWrite + output,
    thoughtTokens: 0,
  }
}

/** 复刻执行器读账本的路径（函数式 usageCalls / usageSnapshots → 事件）。 */
function eventsFromLedgers(ledgers, invocationIds) {
  const events = []
  let seq = 0
  for (const invocationId of invocationIds) {
    events.push({
      seq: ++seq, at: iso(seq), type: 'agent/invocation', invocationId, provider: 'acp',
    })
  }
  for (const ledger of ledgers) {
    const handle = {
      usageCalls: () => ledger.usageCalls(),
      usageSnapshots: () => ledger.usageSnapshots(),
    }
    for (const call of readAdapterUsageCalls(handle, 'acp')) {
      events.push({ seq: ++seq, at: iso(seq), ...usageEventForCall(call) })
    }
    for (const snapshot of readAdapterUsageSnapshots(handle, 'acp')) {
      events.push({ seq: ++seq, at: iso(seq), ...usageSnapshotEventFor(snapshot) })
    }
  }
  return events
}

function metricsFor(ledgers, invocationIds) {
  const events = eventsFromLedgers(ledgers, invocationIds)
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

test('真实录制：单个 invocation 18666，modelCalls=null（prompt 不冒充模型调用）', () => {
  const ledger = ledgerOf()
  ledger.begin('inv-real')
  ledger.end('inv-real', {
    stopReason: 'end_turn',
    usage: {
      totalTokens: 18666,
      inputTokens: 6501,
      cachedReadTokens: 12160,
      cachedWriteTokens: 0,
      outputTokens: 5,
      thoughtTokens: 0,
    },
  })
  const metrics = metricsFor([ledger], ['inv-real'])
  assert.deepEqual(bucketValues(metrics.agent.observedTokens), {
    input: 6501, cacheRead: 12160, cacheWrite: 0, output: 5, total: 18666,
  })
  assert.equal(metrics.agent.observedTokens.partial, false, '四桶完整 + 无未知来源')
  assert.equal(metrics.agent.modelCalls, null, 'prompt 可能含多次模型调用，不猜 modelCalls')
  assert.equal(metrics.agent.invocations, 1)
  assert.deepEqual(metrics.agent.usageCoverage, { known: 1, partial: 0, unknown: 0 })
  assert.deepEqual(metrics.agent.snapshots, {
    total: 1, invocation: 1, sessionCumulative: 0, unknown: 0,
  })
})

test('两轮 (10,0,0,1)、(30,0,0,3) → 44，直接相加不差分', () => {
  const ledger = ledgerOf()
  ledger.begin('inv-1')
  ledger.end('inv-1', { stopReason: 'end_turn', usage: promptUsage(10, 0, 0, 1) })
  ledger.begin('inv-2')
  ledger.end('inv-2', { stopReason: 'end_turn', usage: promptUsage(30, 0, 0, 3) })
  const metrics = metricsFor([ledger], ['inv-1', 'inv-2'])
  assert.deepEqual(bucketValues(metrics.agent.observedTokens), {
    input: 40, cacheRead: 0, cacheWrite: 0, output: 4, total: 44,
  })
  assert.equal(metrics.agent.modelCalls, null)
  assert.deepEqual(metrics.agent.usageCoverage, { known: 2, partial: 0, unknown: 0 })

  // 重复归约同一条事件流：不能把快照再累加一次。
  const again = metricsFor([ledger], ['inv-1', 'inv-2'])
  assert.deepEqual(again, metrics)
})

test('P1 有效、P2 缺失、P3 有效 → 只有 P2 unknown；小计保留、完整 total=null', () => {
  const ledger = ledgerOf()
  ledger.begin('inv-1')
  ledger.end('inv-1', { stopReason: 'end_turn', usage: promptUsage(10, 0, 0, 1) })
  ledger.begin('inv-2')
  ledger.sealUnknown('inv-2')
  ledger.begin('inv-3')
  ledger.end('inv-3', { stopReason: 'end_turn', usage: promptUsage(40, 0, 0, 4) })

  const metrics = metricsFor([ledger], ['inv-1', 'inv-2', 'inv-3'])
  assert.deepEqual(metrics.agent.usageCoverage, { known: 2, partial: 0, unknown: 1 })
  assert.deepEqual(metrics.agent.observedTokensPartial, {
    input: 50, cacheRead: 0, cacheWrite: 0, output: 5,
  }, '缺口轮不能被补成 0；已观测小计仍要保留')
  assert.deepEqual(bucketValues(metrics.agent.observedTokens), {
    input: null, cacheRead: null, cacheWrite: null, output: null, total: null,
  }, '存在未知来源时不能宣称任何桶完整')
  assert.equal(metrics.agent.observedTokens.partial, true)
  assert.equal(metrics.agent.modelCalls, null, 'synthetic unknown 不算模型调用')
  assert.ok(metrics.dataQuality.reasons.includes('usage-unavailable'))
})

test('未验证 profile / 仅 used+size → unknown，observedTokens=null', () => {
  const unknownProfile = createAcpUsageLedger({
    executionId: EXECUTION_ID,
    sessionId: SESSION_ID,
    agentInfo: { name: '@agentclientprotocol/codex-acp', version: '2.6.9' },
  })
  unknownProfile.begin('inv-x')
  unknownProfile.end('inv-x', { stopReason: 'end_turn', usage: promptUsage(30, 0, 0, 3) })

  const unknown = metricsFor([unknownProfile], ['inv-x'])
  assert.equal(unknown.agent.observedTokens, null, '未知 profile 的数字不能进指标')
  assert.deepEqual(unknown.agent.usageCoverage, { known: 0, partial: 0, unknown: 1 })
  assert.equal(unknown.agent.modelCalls, null, 'synthetic 未知占位不算模型调用')
  assert.ok(unknown.dataQuality.reasons.includes('usage-unavailable'))

  const contextOnly = ledgerOf()
  contextOnly.begin('inv-context')
  contextOnly.end('inv-context', { stopReason: 'end_turn', used: 18666, size: 258400 })
  const context = metricsFor([contextOnly], ['inv-context'])
  assert.equal(context.agent.observedTokens, null, 'used/size 是上下文，不是 token 用量')
  assert.deepEqual(context.agent.usageCoverage, { known: 0, partial: 0, unknown: 1 })
})

test('同 provider 第二 session 没有 usage：第一 session 不能遮蔽它的 unknown', () => {
  const knownSession = ledgerOf({ sessionId: 'sess-known' })
  knownSession.begin('inv-known')
  knownSession.end('inv-known', { stopReason: 'end_turn', usage: promptUsage(10, 0, 0, 1) })

  // 第二 session 真实派发过 prompt，但没有任何 usage 事实（模拟尾窗内丢失）。
  const missingSession = ledgerOf({ sessionId: 'sess-missing' })
  missingSession.begin('inv-missing')

  const metrics = metricsFor([knownSession, missingSession], ['inv-known', 'inv-missing'])
  assert.deepEqual(metrics.agent.usageCoverage, { known: 1, partial: 0, unknown: 1 },
    '同 provider 的另一 session 有快照，也不能把缺失轮当成已覆盖')
  assert.deepEqual(metrics.agent.observedTokensPartial, {
    input: 10, cacheRead: 0, cacheWrite: 0, output: 1,
  })
  assert.equal(metrics.agent.observedTokens.total, null)
  assert.ok(metrics.dataQuality.reasons.includes('usage-unavailable'))
})

test('缺缓存桶：partial、null 不补 0；明确 0 才完整', () => {
  const partialLedger = ledgerOf()
  partialLedger.begin('inv-partial')
  partialLedger.end('inv-partial', {
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 3 },
  })
  const partial = metricsFor([partialLedger], ['inv-partial'])
  assert.deepEqual(bucketValues(partial.agent.observedTokens), {
    input: 10, cacheRead: null, cacheWrite: null, output: 3, total: null,
  }, '缺桶保持 null，不补 0，也不宣称 total')
  assert.equal(partial.agent.observedTokens.partial, true)
  assert.deepEqual(partial.agent.usageCoverage, { known: 0, partial: 1, unknown: 0 })
  assert.ok(partial.dataQuality.reasons.includes('usage-partial'))

  const zeroLedger = ledgerOf()
  zeroLedger.begin('inv-zero')
  zeroLedger.end('inv-zero', {
    stopReason: 'end_turn',
    usage: {
      inputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 0, totalTokens: 0,
    },
  })
  const zero = metricsFor([zeroLedger], ['inv-zero'])
  assert.deepEqual(bucketValues(zero.agent.observedTokens), {
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0,
  })
  assert.deepEqual(zero.agent.usageCoverage, { known: 1, partial: 0, unknown: 0 })
})

test('取消后合法尾 usage 仍被指标消费（不是 unknown，也不回填成 0）', () => {
  const ledger = ledgerOf()
  ledger.begin('inv-cancel')
  ledger.end('inv-cancel', {
    stopReason: 'cancelled',
    usage: promptUsage(7, 0, 0, 2),
  })
  const metrics = metricsFor([ledger], ['inv-cancel'])
  assert.deepEqual(bucketValues(metrics.agent.observedTokens), {
    input: 7, cacheRead: 0, cacheWrite: 0, output: 2, total: 9,
  })
  assert.deepEqual(metrics.agent.usageCoverage, { known: 1, partial: 0, unknown: 0 })
})
