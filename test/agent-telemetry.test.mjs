#!/usr/bin/env node
/**
 * agent 遥测自检（0.13.10 E1）：
 *  - provider 黄金样例：codex 的 input_tokens 含缓存 → 先拆再算；
 *  - dsh 四桶互斥 → 不重复拆（cacheRead 不双计）；
 *  - reasoning 是 output 子集，不另加 total；
 *  - 同一 provider + callId 的 usage 是替换不是累加；
 *  - 不可观测 / 坏形状 → unknown，绝不伪造 0；
 *  - handle.usageCalls 读取与调用身份事件。
 *
 * 运行：node test/agent-telemetry.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_INVOCATION_EVENT, AGENT_USAGE_EVENT, USAGE_REASON, USAGE_TRUST,
  createUsageCall, invocationEvent, normalizeProvider, normalizeUsage, readAdapterUsageCalls,
  recordUsageCall, summarizeUsageCalls, unknownUsageEvent, usageCallKey, usageEventForCall,
} from '../src/agent-telemetry.js'

test('codex 黄金样例：input 含缓存，先拆再算，四桶之和 === total', () => {
  const result = normalizeUsage({
    input_tokens: 100,
    cached_input_tokens: 80,
    cache_write_input_tokens: 10,
    output_tokens: 5,
    total_tokens: 105,
  }, { provider: 'codex' })
  assert.equal(result.trust, USAGE_TRUST.KNOWN)
  assert.deepEqual(result.usage, {
    input: 10,
    cacheRead: 80,
    cacheWrite: 10,
    output: 5,
    total: 105,
  })
  assert.deepEqual(result.observedBuckets.sort(), ['cacheRead', 'cacheWrite', 'input', 'output'])
  const sum = result.usage.input + result.usage.cacheRead + result.usage.cacheWrite + result.usage.output
  assert.equal(sum, result.usage.total, '四桶之和必须等于 total')
  assert.equal(result.usage.input + result.usage.cacheRead + result.usage.cacheWrite, 100,
    '拆出的缓存桶必须仍然包含在原始 input_tokens 里')
})

test('dsh 黄金样例：四桶互斥，不再拆缓存（cacheRead 不双计）', () => {
  const result = normalizeUsage({
    inputTokens: 100,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    outputTokens: 40,
    totalTokens: 160,
  }, { provider: 'dsh' })
  assert.equal(result.trust, USAGE_TRUST.KNOWN)
  assert.deepEqual(result.usage, {
    input: 100,
    cacheRead: 20,
    cacheWrite: 0,
    output: 40,
    total: 160,
  })
  assert.deepEqual(result.observedBuckets.sort(), ['cacheRead', 'cacheWrite', 'input', 'output'])
})

test('reasoning 是 output 子集：不另加进 total；超过 output 时丢弃', () => {
  const ok = normalizeUsage({
    input_tokens: 100,
    cached_input_tokens: 0,
    output_tokens: 40,
    reasoning_output_tokens: 30,
  }, { provider: 'codex' })
  assert.equal(ok.usage.total, 140)
  assert.equal(ok.usage.reasoning, 30)

  const bad = normalizeUsage({
    input_tokens: 100,
    output_tokens: 40,
    reasoning_output_tokens: 50,
  }, { provider: 'codex' })
  assert.equal(bad.usage.total, 140)
  assert.equal('reasoning' in bad.usage, false, 'reasoning > output 不是可信子集，不记录')
})

test('矛盾缓存数据按 input 截断，守住四桶之和 === total', () => {
  const result = normalizeUsage({
    input_tokens: 10,
    cached_input_tokens: 99,
    cache_write_input_tokens: 4,
    output_tokens: 3,
  }, { provider: 'codex' })
  assert.equal(result.usage.cacheRead, 10)
  assert.equal(result.usage.cacheWrite, 0)
  assert.equal(result.usage.input, 0)
  assert.equal(result.usage.total, 13)
})

test('不可观测 / 坏形状 → unknown，不是 0', () => {
  for (const raw of [null, undefined, {}, 'x', [], { input_tokens: -1, output_tokens: 1 }, { input_tokens: '10' }]) {
    const result = normalizeUsage(raw, { provider: 'dsh' })
    assert.equal(result.trust, USAGE_TRUST.UNKNOWN, JSON.stringify(raw))
    assert.equal(result.usage, null)
    assert.ok(result.reason)
  }
  const missingCallId = createUsageCall({ provider: 'dsh', usage: { inputTokens: 1, outputTokens: 2 } })
  assert.equal(missingCallId.trust, USAGE_TRUST.UNKNOWN)
  assert.equal(missingCallId.reason, USAGE_REASON.MALFORMED)
})

test('同一 provider + callId 的 usage 更新是替换不是累加', () => {
  const calls = new Map()
  recordUsageCall(calls, createUsageCall({
    provider: 'dsh', callId: 'c-1', usage: { inputTokens: 100, outputTokens: 40 },
  }))
  recordUsageCall(calls, createUsageCall({
    provider: 'dsh', callId: 'c-1', usage: { inputTokens: 120, outputTokens: 50 },
  }))
  assert.equal(calls.size, 1, '同一 callId 只能有一条最新值')
  const summary = summarizeUsageCalls(calls.values())
  assert.equal(summary.known, 1)
  assert.deepEqual(summary.usage, {
    input: 120, cacheRead: 0, cacheWrite: 0, output: 50, total: 170,
  }, '不能把两次上报相加成 input 220')
  assert.equal(usageCallKey({ provider: 'DSH', callId: 'c-1' }), 'dsh\u0000c-1',
    '去重键必须归一化 provider 大小写')
})

test('不同 callId 才累加；unknown 单独计数且不污染已知四桶', () => {
  const calls = [
    createUsageCall({ provider: 'dsh', callId: 'c-1', usage: { inputTokens: 10, outputTokens: 1 } }),
    createUsageCall({ provider: 'dsh', callId: 'c-2', usage: { inputTokens: 20, outputTokens: 2 } }),
    createUsageCall({ provider: 'dsh', callId: 'c-3', usage: null }),
  ]
  const summary = summarizeUsageCalls(calls)
  assert.equal(summary.known, 2)
  assert.equal(summary.unknown, 1)
  assert.deepEqual(summary.usage, {
    input: 30, cacheRead: 0, cacheWrite: 0, output: 3, total: 33,
  })
})

test('readAdapterUsageCalls：支持数组/函数，坏记录跳过，provider 可兜底', () => {
  const direct = readAdapterUsageCalls({
    usageCalls: [
      { callId: 'turn-1', usage: { inputTokens: 1, outputTokens: 2 } },
      { callId: '', usage: { inputTokens: 9 } },
      null,
    ],
  }, 'codex')
  assert.equal(direct.length, 1)
  assert.equal(direct[0].provider, 'codex')
  assert.equal(direct[0].trust, USAGE_TRUST.KNOWN)

  const viaFunction = readAdapterUsageCalls({ usageCalls: () => [{ provider: 'dsh', callId: 'a', usage: null }] })
  assert.equal(viaFunction.length, 1)
  assert.equal(viaFunction[0].trust, USAGE_TRUST.UNKNOWN)

  assert.deepEqual(readAdapterUsageCalls(null), [])
  assert.deepEqual(readAdapterUsageCalls({ usageCalls: () => { throw new Error('boom') } }), [])
})

test('usage / invocation 事件形状与 provider 归一化', () => {
  const call = createUsageCall({
    provider: 'Dsh', callId: 's:1', usage: { inputTokens: 3, outputTokens: 2 },
    source: 'agent/assistant-stream',
  })
  const event = usageEventForCall({ ...call, invocationId: 'e:invoke-1' })
  assert.equal(event.type, AGENT_USAGE_EVENT)
  assert.equal(event.provider, 'dsh')
  assert.equal(event.trust, 'known')
  assert.equal(event.invocationId, 'e:invoke-1')
  assert.equal(event.source, 'agent/assistant-stream')

  const unknown = unknownUsageEvent({ provider: 'dsh', invocationId: 'e:invoke-1' })
  assert.equal(unknown.type, AGENT_USAGE_EVENT)
  assert.equal(unknown.trust, 'unknown')
  assert.equal(unknown.callId, 'dsh:e:invoke-1:unobserved')

  const start = invocationEvent({ invocationId: 'e:invoke-1', provider: 'dsh', phase: 'start', attempt: 2 })
  assert.equal(start.type, AGENT_INVOCATION_EVENT)
  assert.deepEqual(start, {
    type: 'agent/invocation', invocationId: 'e:invoke-1', provider: 'dsh', phase: 'start', attempt: 2,
  })
  const reminder = invocationEvent({ invocationId: 'e:invoke-r1', provider: 'dsh', phase: 'reminder', count: 1 })
  assert.equal(reminder.phase, 'reminder')
  assert.equal(reminder.count, 1)

  assert.equal(normalizeProvider('OpenAI'), 'openai')
  assert.equal(normalizeProvider('bad provider!'), 'unknown')
  assert.equal(normalizeProvider(''), 'unknown')
})
