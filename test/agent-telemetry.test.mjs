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
    canonical: 1,
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
    canonical: 1,
  })
  assert.deepEqual(result.observedBuckets.sort(), ['cacheRead', 'cacheWrite', 'input', 'output'])
})

test('reasoning 是 output 子集：不另加进 total；超过 output 时丢弃', () => {
  // 显式上报 cache_write=0：缺桶现在是 null，完整 total 必须由夹具明确给全四桶。
  const ok = normalizeUsage({
    input_tokens: 100,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 40,
    reasoning_output_tokens: 30,
  }, { provider: 'codex' })
  assert.equal(ok.usage.total, 140)
  assert.equal(ok.usage.reasoning, 30)

  const bad = normalizeUsage({
    input_tokens: 100,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
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
    provider: 'dsh', callId: 'c-1',
    usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 40 },
  }))
  recordUsageCall(calls, createUsageCall({
    provider: 'dsh', callId: 'c-1',
    usage: { inputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 },
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
    createUsageCall({
      provider: 'dsh', callId: 'c-1',
      usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
    }),
    createUsageCall({
      provider: 'dsh', callId: 'c-2',
      usage: { inputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 },
    }),
    createUsageCall({ provider: 'dsh', callId: 'c-3', usage: null }),
  ]
  const summary = summarizeUsageCalls(calls)
  assert.equal(summary.known, 2)
  assert.equal(summary.unknown, 1)
  // M7：c-3 的 usage 完全未知 → 它的 token 可能落在任意桶，合计四桶都必须降级为
  // null（旧断言 30/3 把未知调用当成 0 参与求和，正是缺陷本身）。
  assert.deepEqual(summary.usage, {
    input: null, cacheRead: null, cacheWrite: null, output: null, total: null,
  })
  assert.equal(summary.complete, false)
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

test('P2：synthetic 且 usage=null 时显式 unknown 原因透传；非法原因/真实坏数值不覆盖', () => {
  const unavailable = createUsageCall({
    provider: 'acp', callId: 'acp-unknown:1', usage: null, synthetic: true, reason: 'usage-unavailable',
  })
  assert.equal(unavailable.trust, USAGE_TRUST.UNKNOWN)
  assert.equal(unavailable.reason, 'usage-unavailable', '适配器声明的 usage-unavailable 必须透传')
  assert.deepEqual(unavailable.observedBuckets, [])

  const malformed = createUsageCall({
    provider: 'acp', callId: 'acp-unknown:2', usage: null, synthetic: true, reason: USAGE_REASON.MALFORMED,
  })
  assert.equal(malformed.reason, 'usage-malformed')

  const invalid = createUsageCall({
    provider: 'acp', callId: 'acp-unknown:3', usage: null, synthetic: true, reason: 'made-up-reason',
  })
  assert.equal(invalid.reason, USAGE_REASON.MALFORMED, '非法 reason 回落到现规则')

  const notSynthetic = createUsageCall({
    provider: 'acp', callId: 'acp-unknown:4', usage: null, reason: 'usage-unavailable',
  })
  assert.equal(notSynthetic.reason, USAGE_REASON.MALFORMED, '只有 synthetic 未知占位能透传')

  // 给了真实但没有形状的 usage：不能拿 reason 覆盖「数值坏掉」的结论。
  const badNumbers = createUsageCall({
    provider: 'acp', callId: 'acp-unknown:5', usage: { inputTokens: -1 }, synthetic: true, reason: 'usage-unavailable',
  })
  assert.equal(badNumbers.reason, USAGE_REASON.MALFORMED)

  const viaRead = readAdapterUsageCalls({
    usageCalls: [{
      provider: 'acp', callId: 'acp-unknown:6', usage: null, synthetic: true, reason: 'usage-unavailable',
    }],
  })
  assert.equal(viaRead.length, 1)
  assert.equal(viaRead[0].reason, 'usage-unavailable', '读取适配器账本时 reason 不能被丢掉')
  const event = usageEventForCall(viaRead[0])
  assert.equal(event.reason, 'usage-unavailable', '事件里必须保留 unknown 原因')
  assert.equal(event.synthetic, true)
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

// ── 0.14.5 M7：缺失桶 = null（不是 0），显式 0 保留，canonical 只校验不重算 ──────

test('M7：只有 {input_tokens:10} 时其余桶是 null（不是 0），显式 0 保留', () => {
  const partial = normalizeUsage({ input_tokens: 10 }, { provider: 'claude' })
  assert.equal(partial.trust, USAGE_TRUST.KNOWN)
  assert.deepEqual(partial.observedBuckets, ['input'])
  assert.deepEqual(partial.usage, {
    input: 10, cacheRead: null, cacheWrite: null, output: null, total: null, canonical: 1,
  }, '未上报的桶必须是 null；total 在桶不完整时未知')

  const explicitZero = normalizeUsage({
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }, { provider: 'claude' })
  assert.equal(explicitZero.trust, USAGE_TRUST.KNOWN)
  assert.deepEqual(explicitZero.usage, {
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, canonical: 1,
  }, '明确上报的 0 必须保留为 0（不能被当成「未观测」）')
  assert.deepEqual(explicitZero.observedBuckets.sort(), ['cacheRead', 'cacheWrite', 'input', 'output'])
})

test('M7：Codex inclusive input 的 canonical usage 不被二次扣缓存（105 → 不再变 85）', () => {
  const once = normalizeUsage({
    input_tokens: 100,
    cached_input_tokens: 20,
    cache_write_input_tokens: 0,
    output_tokens: 5,
  }, { provider: 'codex' })
  assert.deepEqual({
    input: once.usage.input,
    cacheRead: once.usage.cacheRead,
    cacheWrite: once.usage.cacheWrite,
    output: once.usage.output,
    total: once.usage.total,
  }, { input: 80, cacheRead: 20, cacheWrite: 0, output: 5, total: 105 })
  assert.equal(once.usage.canonical, 1, 'canonical 桶必须带版本标记')

  // 指标层会再次调用 normalizeUsage：canonical 只校验、不重算，cacheRead 不能被再拆一次。
  const twice = normalizeUsage(once.usage, { provider: 'codex' })
  assert.deepEqual({
    input: twice.usage.input,
    cacheRead: twice.usage.cacheRead,
    cacheWrite: twice.usage.cacheWrite,
    output: twice.usage.output,
    total: twice.usage.total,
  }, { input: 80, cacheRead: 20, cacheWrite: 0, output: 5, total: 105 },
  '二次归一化必须得到同一个 105（基线会拆成 60/20/0/5 = 85）')
})

test('M7：summarizeUsageCalls 保留 null 桶并区分 known / partial / unknown', () => {
  const summary = summarizeUsageCalls([
    createUsageCall({ provider: 'claude', callId: 'call-1', usage: { input_tokens: 10 } }),
  ])
  assert.deepEqual(summary.usage, {
    input: 10, cacheRead: null, cacheWrite: null, output: null, total: null,
  })
  assert.equal(summary.coverage.partial, 1)
  assert.equal(summary.coverage.known, 0)
  assert.deepEqual(summary.bucketsMissing.sort(), ['cacheRead', 'cacheWrite', 'output'])
  assert.equal(summary.complete, false)

  const unknownSummary = summarizeUsageCalls([
    createUsageCall({ provider: 'claude', callId: 'call-2', usage: null }),
  ])
  assert.equal(unknownSummary.coverage.unknown, 1)
  assert.deepEqual(unknownSummary.usage, {
    input: null, cacheRead: null, cacheWrite: null, output: null, total: null,
  })
})

test('0.14.6 M2：provisional 调用即使四桶齐全，summarizeUsageCalls 也不得标完整', () => {
  const call = createUsageCall({
    provider: 'claude',
    callId: 'call-provisional',
    provisional: true,
    usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1, total: 11 },
  })
  assert.equal(call.provisional, true)
  assert.deepEqual(call.observedBuckets, ['input', 'cacheRead', 'cacheWrite', 'output'])
  const summary = summarizeUsageCalls([call])
  assert.equal(summary.complete, false, '未结算的占位 output 不能算完整')
  assert.equal(summary.coverage.known, 1, '覆盖档位仍如实说四桶都观测过')
  assert.equal(summary.usage.total, null)
})
