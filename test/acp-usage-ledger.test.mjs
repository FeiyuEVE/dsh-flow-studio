#!/usr/bin/env node
/**
 * ACP prompt 用量账本自检（0.15.0 P2）。
 *
 * 目标：未知不造零、累计不双计、prompt 不冒充一次模型调用。
 *
 *   - codex-acp 2.6.0 的 prompt usage 已是本轮量（agent 内部 latest − startTotal），
 *     账本直接记 invocation，绝不再次差分；
 *   - 只有精确的 agent 身份 / 版本走 prompt profile，其它一律 unknown；
 *   - 缺桶 null、明确 0 才 observed；负数 / 非整数 / 求和溢出 / thought>output /
 *     四桶与 total 矛盾 → usage-malformed → unknown（不是 0）；
 *   - 取消后仍可能来合法尾响应：end 先到就正常结算，只在尾窗截止后 sealUnknown；
 *   - 真实录制口径：6501 + 12160 + 0 + 5 = 18666（不因 input 已扣缓存再减一次）。
 *
 * 运行：node test/acp-usage-ledger.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createAcpUsageLedger } from '../src/acp-usage-ledger.js'

const EXECUTION_ID = 'exec-acp-1'
const SESSION_ID = 'sess-acp-1'
const AGENT_INFO = { name: '@agentclientprotocol/codex-acp', version: '2.6.0' }
const CONTRACT = 'acp-codex-2.6.0-prompt-v1'

function ledgerOf(options = {}) {
  return createAcpUsageLedger({
    executionId: EXECUTION_ID,
    sessionId: SESSION_ID,
    agentInfo: AGENT_INFO,
    ...options,
  })
}

function promptUsage(input, cacheRead, cacheWrite, output, extra = {}) {
  return {
    inputTokens: input,
    cachedReadTokens: cacheRead,
    cachedWriteTokens: cacheWrite,
    outputTokens: output,
    totalTokens: input + cacheRead + cacheWrite + output,
    thoughtTokens: 0,
    ...extra,
  }
}

function response(usage, extra = {}) {
  return { stopReason: 'end_turn', usage, ...extra }
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function expectedSnapshotId(invocationId) {
  return `acp-prompt:${sha256Hex(`${EXECUTION_ID}\u0000${invocationId}`)}`
}

function expectedCallId(invocationId) {
  return `acp-unknown:${sha256Hex(`${EXECUTION_ID}\u0000${invocationId}`)}`
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

function sumSnapshots(snapshots) {
  const sums = { input: null, cacheRead: null, cacheWrite: null, output: null, total: null }
  for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output']) {
    const values = snapshots.map(snapshot => snapshot.usage[bucket]).filter(Number.isInteger)
    if (values.length > 0) sums[bucket] = values.reduce((acc, value) => acc + value, 0)
  }
  if (['input', 'cacheRead', 'cacheWrite', 'output'].every(bucket => Number.isInteger(sums[bucket]))) {
    sums.total = sums.input + sums.cacheRead + sums.cacheWrite + sums.output
  }
  return sums
}

test('目标 profile 两响应 (10,0,0,1)、(30,0,0,3) → 44、两 invocation、不差分', () => {
  const ledger = ledgerOf()
  ledger.begin('inv-1')
  const first = ledger.end('inv-1', response(promptUsage(10, 0, 0, 1)))
  ledger.begin('inv-2')
  const second = ledger.end('inv-2', response(promptUsage(30, 0, 0, 3)))

  const snapshots = ledger.usageSnapshots()
  assert.equal(snapshots.length, 2, '每个 prompt 响应是一份 invocation 结算快照')
  assert.equal(ledger.usageCalls().length, 0, '有效 prompt usage 不走 unknown 调用记录')
  assert.equal(first.scope, 'invocation')
  assert.equal(second.scope, 'invocation')
  assert.equal(first.snapshotId, expectedSnapshotId('inv-1'), 'snapshotId 用 §P2 的 sha256 配方')
  assert.equal(second.snapshotId, expectedSnapshotId('inv-2'))
  assert.deepEqual(first.provenance, { contract: CONTRACT, realCliVerified: false },
    '真实多轮未验收，必须标 realCliVerified:false')
  assert.equal(first.invocationId, 'inv-1')
  assert.equal(first.sessionScopeId, SESSION_ID)
  assert.equal(first.agentScope, 'main')

  assert.deepEqual(sumSnapshots(snapshots), {
    input: 40, cacheRead: 0, cacheWrite: 0, output: 4, total: 44,
  }, '两轮直接相加 = 44；若对 prompt 再差分，第二轮会变成 20/2，总量虽同但记录错误')

  // 导出是深拷贝；重复导出 / 重复 end 不增加快照。
  const exported = ledger.usageSnapshots()
  exported[0].usage.input = 999
  exported[0].observedBuckets.push('bogus')
  assert.equal(ledger.usageSnapshots()[0].usage.input, 10, '导出快照必须与账本隔离')
  assert.equal(ledger.end('inv-2', response(promptUsage(99, 0, 0, 9))), null, '同 invocation 首次终结有效')
  assert.equal(ledger.usageSnapshots().length, 2, '重复 end 不新增快照')
  assert.ok(ledger.diagnostics().some(item => item.code === 'end-after-settlement'))
})

test('第二轮改 (5,0,0,1) → 17 而不是回退/差分', () => {
  const ledger = ledgerOf()
  ledger.begin('inv-1')
  ledger.end('inv-1', response(promptUsage(10, 0, 0, 1)))
  ledger.begin('inv-2')
  ledger.end('inv-2', response(promptUsage(5, 0, 0, 1)))

  const snapshots = ledger.usageSnapshots()
  assert.equal(snapshots.length, 2)
  assert.deepEqual(bucketValues(snapshots[1].usage), {
    input: 5, cacheRead: 0, cacheWrite: 0, output: 1, total: 6,
  }, '每个 prompt usage 是本轮量：5 不能被当成「比上一轮 10 回退」')
  assert.deepEqual(sumSnapshots(snapshots), {
    input: 15, cacheRead: 0, cacheWrite: 0, output: 2, total: 17,
  })
  assert.equal(ledger.usageCalls().length, 0, '没有 unknown')
})

test('真实录制口径：6501+12160+0+5=18666，input 已扣缓存不再减一次', () => {
  const ledger = ledgerOf()
  ledger.begin('inv-real')
  ledger.end('inv-real', response({
    totalTokens: 18666,
    inputTokens: 6501,
    cachedReadTokens: 12160,
    cachedWriteTokens: 0,
    outputTokens: 5,
    thoughtTokens: 0,
  }))

  const snapshots = ledger.usageSnapshots()
  assert.equal(snapshots.length, 1)
  const usage = snapshots[0].usage
  assert.deepEqual(bucketValues(usage), {
    input: 6501, cacheRead: 12160, cacheWrite: 0, output: 5, total: 18666,
  })
  assert.equal(usage.input + usage.cacheRead + usage.cacheWrite + usage.output, 18666)
  assert.equal(usage.input, 6501, 'inputTokens 已是 exclusive input，不能减成负数')
  assert.deepEqual(snapshots[0].observedBuckets, ['input', 'cacheRead', 'cacheWrite', 'output'])
})

test('未知 agent 身份 / 版本：数值一律 unknown，不猜累计、不猜 invocation', () => {
  for (const agentInfo of [
    { name: '@agentclientprotocol/codex-acp', version: '2.6.1' },
    { name: '@agentclientprotocol/codex-acp', version: '2.5.0' },
    { name: 'other-acp-agent', version: '2.6.0' },
    null,
  ]) {
    const ledger = createAcpUsageLedger({
      executionId: EXECUTION_ID, sessionId: SESSION_ID, agentInfo,
    })
    ledger.begin('inv-x')
    const call = ledger.end('inv-x', response(promptUsage(30, 0, 0, 3)))
    assert.equal(ledger.usageSnapshots().length, 0, `未验证 profile 不能产出数值快照：${JSON.stringify(agentInfo)}`)
    assert.equal(call.provider, 'acp')
    assert.equal(call.callId, expectedCallId('inv-x'))
    assert.equal(call.usage, null)
    assert.equal(call.synthetic, true)
    assert.equal(call.source, 'acp-prompt')
    assert.equal(call.invocationId, 'inv-x')
    assert.equal(call.sessionScopeId, SESSION_ID)
    assert.equal(call.agentScope, 'main')
    assert.equal(call.reason, 'usage-unavailable', '未知 profile 不是 malformed，是「无法解释」')
    assert.deepEqual(call.observedBuckets, [])
    assert.ok(ledger.diagnostics().some(item => item.code === 'profile-unverified'))
  }
})

test('坏数值：负数 / 非整数 / 求和溢出 / thought>output / total 矛盾 → malformed unknown', () => {
  const cases = [
    { inputTokens: -1, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 1 },
    { inputTokens: 1.5, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 1 },
    { inputTokens: 10, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 1, totalTokens: 12 },
    { inputTokens: 10, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 1, thoughtTokens: 2 },
    { inputTokens: Number.MAX_SAFE_INTEGER, cachedReadTokens: 1, cachedWriteTokens: 0, outputTokens: 0 },
    { totalTokens: 18666 },
    { inputTokens: '10', outputTokens: 1 },
    {},
  ]
  for (const [index, usage] of cases.entries()) {
    const ledger = ledgerOf()
    const invocationId = `inv-bad-${index}`
    ledger.begin(invocationId)
    const call = ledger.end(invocationId, response(usage))
    assert.equal(ledger.usageSnapshots().length, 0, `坏形状不能变成数值快照：${JSON.stringify(usage)}`)
    assert.equal(call.usage, null)
    assert.equal(call.reason, 'usage-malformed', `坏形状必须标 malformed：${JSON.stringify(usage)}`)
    assert.deepEqual(call.observedBuckets, [], '未知不是 0，也不能有观测桶')
    assert.equal(call.callId, expectedCallId(invocationId))
  }
})

test('缺桶 null 且 total=null；明确上报的 0 进入观测掩码', () => {
  const partial = ledgerOf()
  partial.begin('inv-partial')
  partial.end('inv-partial', response({ inputTokens: 10, outputTokens: 3 }))
  const [partialSnapshot] = partial.usageSnapshots()
  assert.deepEqual(bucketValues(partialSnapshot.usage), {
    input: 10, cacheRead: null, cacheWrite: null, output: 3, total: null,
  }, '缺桶是 null，不补 0；桶不完整时 total 未知')
  assert.deepEqual(partialSnapshot.observedBuckets, ['input', 'output'])

  const zeros = ledgerOf()
  zeros.begin('inv-zero')
  zeros.end('inv-zero', response({
    inputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 0, totalTokens: 0, thoughtTokens: 0,
  }))
  const [zeroSnapshot] = zeros.usageSnapshots()
  assert.deepEqual(bucketValues(zeroSnapshot.usage), {
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0,
  }, '明确上报的 0 必须保留（不是缺桶）')
  assert.deepEqual(zeroSnapshot.observedBuckets, ['input', 'cacheRead', 'cacheWrite', 'output'])
})

test('P1=(10,0,0,1)、P2 缺失、P3=(40,0,0,4) → 仅 P2 unknown，小计完整保留', () => {
  const ledger = ledgerOf()
  ledger.begin('inv-1')
  ledger.end('inv-1', response(promptUsage(10, 0, 0, 1)))
  ledger.begin('inv-2')
  ledger.sealUnknown('inv-2')
  ledger.begin('inv-3')
  ledger.end('inv-3', response(promptUsage(40, 0, 0, 4)))

  const snapshots = ledger.usageSnapshots()
  const calls = ledger.usageCalls()
  assert.equal(snapshots.length, 2)
  assert.equal(calls.length, 1, '只有缺口那轮是 unknown')
  assert.equal(calls[0].invocationId, 'inv-2')
  assert.equal(calls[0].reason, 'usage-unavailable')
  assert.equal(calls[0].callId, expectedCallId('inv-2'))
  const sums = sumSnapshots(snapshots)
  assert.deepEqual({
    input: sums.input, cacheRead: sums.cacheRead, cacheWrite: sums.cacheWrite, output: sums.output,
  }, { input: 50, cacheRead: 0, cacheWrite: 0, output: 5 },
  '已观测小计 50/0/0/5；缺失轮不能被补成 0')
  // 账本层每份快照自身完整，所以四桶可加；「缺口轮导致 total 不可宣称」由指标层降级
  // （test/acp-metrics.test.mjs 断言 observedTokens.total === null）。
})

test('取消后有合法尾响应 → 正常结算，不抢写 unknown；截止后才 seal', () => {
  const cancelledWithUsage = ledgerOf()
  cancelledWithUsage.begin('inv-cancel')
  cancelledWithUsage.end('inv-cancel', {
    stopReason: 'cancelled',
    usage: promptUsage(7, 0, 0, 2),
  })
  assert.equal(cancelledWithUsage.usageSnapshots().length, 1, '取消仍有合法尾 usage → 结算快照')
  assert.equal(cancelledWithUsage.usageCalls().length, 0, '不能因为 stopReason=cancelled 就抢写 unknown')
  assert.equal(cancelledWithUsage.sealUnknown('inv-cancel'), null, '已结算后 seal 是 no-op')
  assert.equal(cancelledWithUsage.usageCalls().length, 0)
  assert.equal(cancelledWithUsage.usageSnapshots().length, 1)

  const cancelledNoUsage = ledgerOf()
  cancelledNoUsage.begin('inv-timeout')
  const unknown = cancelledNoUsage.sealUnknown('inv-timeout')
  assert.equal(cancelledNoUsage.usageSnapshots().length, 0)
  assert.equal(cancelledNoUsage.usageCalls().length, 1)
  assert.equal(unknown.reason, 'usage-unavailable', '无尾响应才落 unknown')
  assert.equal(cancelledNoUsage.end('inv-timeout', response(promptUsage(9, 0, 0, 1))), null,
    '尾窗截止后迟到的响应被拒收（首次终结有效）')
  assert.equal(cancelledNoUsage.usageSnapshots().length, 0)
  assert.equal(cancelledNoUsage.usageCalls().length, 1)
})

test('sealUnknown 原因只认 usage-unavailable / usage-malformed，非法值回落', () => {
  const ledger = ledgerOf()
  ledger.begin('inv-a')
  const fallback = ledger.sealUnknown('inv-a', 'because-cancelled')
  assert.equal(fallback.reason, 'usage-unavailable')
  assert.ok(ledger.diagnostics().some(item => item.code === 'unknown-reason-invalid'))

  const malformed = ledgerOf()
  malformed.begin('inv-b')
  const call = malformed.sealUnknown('inv-b', 'usage-malformed')
  assert.equal(call.reason, 'usage-malformed')
})

test('仅上下文 used/size 不是 token 用量：observedBuckets 空、没有快照', () => {
  const ledger = ledgerOf()
  ledger.begin('inv-context')
  const call = ledger.end('inv-context', {
    stopReason: 'end_turn',
    used: 18666,
    size: 258400,
  })
  assert.equal(ledger.usageSnapshots().length, 0)
  assert.equal(call.usage, null)
  assert.deepEqual(call.observedBuckets, [], 'used/size 只能当上下文诊断，不能变成 token')
  assert.equal(call.reason, 'usage-unavailable')

  const noUsage = ledgerOf()
  noUsage.begin('inv-null')
  const nullCall = noUsage.end('inv-null', { stopReason: 'end_turn', usage: null })
  assert.equal(nullCall.reason, 'usage-unavailable')
  assert.equal(noUsage.usageSnapshots().length, 0)
})

test('begin 幂等、未 begin 不结算；诊断有界，计量账本不裁剪', () => {
  const ledger = ledgerOf()
  assert.deepEqual(ledger.begin('inv-1'), { invocationId: 'inv-1' })
  assert.equal(ledger.begin('inv-1'), null)
  assert.ok(ledger.diagnostics().some(item => item.code === 'invocation-duplicate-begin'))
  assert.equal(ledger.sealUnknown('never-begun'), null, '未派发 prompt 不伪造 unknown 调用')
  assert.deepEqual(ledger.usageCalls(), [])

  for (let index = 0; index < 60; index += 1) ledger.begin(`bad-${index}`)
  for (let index = 0; index < 60; index += 1) ledger.sealUnknown(`bad-${index}`)
  assert.equal(ledger.usageCalls().length, 60, '计量账本不能被诊断上限裁掉')
  assert.ok(ledger.diagnostics().length <= 50, '诊断必须有界')
})
