#!/usr/bin/env node
/**
 * connector-store.js 自检：发送前落盘 / 成功结果复用 / 重启窗口不重发。
 *
 * 用真实的临时目录（项目 .tmp/），通过「新建第二个 store」模拟进程重启。
 * 运行：node test/connector-store.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createConnectorStore, ConnectorStoreError } from '../src/connector-store.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

let checks = 0
let assertions = 0

const A = {
  equal(actual, expected, message) {
    assertions += 1
    assert.equal(actual, expected, message)
  },
  deepEqual(actual, expected, message) {
    assertions += 1
    assert.deepEqual(actual, expected, message)
  },
  ok(value, message) {
    assertions += 1
    assert.ok(value, message)
  },
}

async function check(name, fn) {
  const root = mkdtempSync(join(repoRoot, '.tmp', 'connector-store-'))
  try {
    await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

async function rejects(promise, code, message) {
  assertions += 1
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `${message}（实际 code=${error.code}）`)
    return true
  })
}

const IDENTITY = Object.freeze({
  instanceId: 'i-demo',
  elementId: 'submit',
  executionId: 'submit_execution_1',
})
const REQUEST_HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)

function baseInput(extra = {}) {
  return {
    ...IDENTITY,
    requestHash: REQUEST_HASH,
    idempotencyKey: 'fs-key-1',
    invocationId: 'inv-1',
    ...extra,
  }
}

await check('beginInvocation：发送前落盘 started，零请求可安全重开', async (root) => {
  const store = createConnectorStore({ root })
  const begun = await store.beginInvocation(baseInput())
  A.equal(begun.status, 'fresh')
  A.equal(begun.record.state, 'started')
  A.equal(begun.record.attempts, 0)
  A.equal(begun.record.idempotencyKey, 'fs-key-1')

  const path = store.pathFor(IDENTITY)
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  A.equal(onDisk.state, 'started', '记录在发送前已落盘')
  A.equal(onDisk.requestHash, REQUEST_HASH)

  // 进程在 begin 之后、真正发送之前挂了：重启后可以安全重新开始。
  const restarted = createConnectorStore({ root })
  const again = await restarted.beginInvocation(baseInput())
  A.equal(again.status, 'fresh', 'attempts=0 时允许重开（请求一定没发出）')
  A.equal(again.record.attempts, 0)
})

await check('recordAttempt → 重启：已发送但结果不明，不自动重发', async (root) => {
  const store = createConnectorStore({ root })
  await store.beginInvocation(baseInput())
  const recorded = await store.recordAttempt(IDENTITY, { attempt: 1 })
  A.equal(recorded.state, 'sent')
  A.equal(recorded.attempts, 1)

  // 模拟崩溃：另一个进程只看到磁盘上的 sent 记录。
  const restarted = createConnectorStore({ root })
  const begun = await restarted.beginInvocation(baseInput())
  A.equal(begun.status, 'unknown')
  A.equal(begun.record.state, 'unknown')
  A.equal(begun.record.error.code, 'HTTP_OUTCOME_UNKNOWN')
  A.ok(begun.record.error.message.includes('不自动重发'), '错误说明恢复语义')
  A.equal((await restarted.beginInvocation(baseInput())).status, 'unknown', '再次恢复仍然是 unknown，直到人工处理')
})

await check('commitResult(succeeded) → 重启直接复用，不再请求', async (root) => {
  const store = createConnectorStore({ root })
  await store.beginInvocation(baseInput())
  await store.recordAttempt(IDENTITY, { attempt: 1 })
  const result = {
    status: 201,
    headers: { 'content-type': 'application/json' },
    output: { accepted: true, http_status: 201 },
  }
  const committed = await store.commitResult(IDENTITY, { state: 'succeeded', result })
  A.equal(committed.state, 'succeeded')
  A.deepEqual(committed.result.output, { accepted: true, http_status: 201 })

  const restarted = createConnectorStore({ root })
  const begun = await restarted.beginInvocation(baseInput())
  A.equal(begun.status, 'reuse')
  A.equal(begun.result.status, 201)
  A.deepEqual(begun.result.output, { accepted: true, http_status: 201 })
})

await check('commitResult(failed) → 重启按结果不明处理（不因失败重发）', async (root) => {
  const store = createConnectorStore({ root })
  await store.beginInvocation(baseInput())
  await store.recordAttempt(IDENTITY, { attempt: 1 })
  await store.commitResult(IDENTITY, {
    state: 'failed',
    error: { code: 'HTTP_STATUS_NOT_ACCEPTABLE', message: '远端 500' },
  })
  const restarted = createConnectorStore({ root })
  const begun = await restarted.beginInvocation(baseInput())
  A.equal(begun.status, 'unknown', '重试耗尽 / 远端已收到请求 → 重启不得自动重发')
  A.equal(begun.record.requestHash, REQUEST_HASH)
})

await check('requestHash 冲突：不覆盖旧结果、不重复发请求', async (root) => {
  const store = createConnectorStore({ root })
  await store.beginInvocation(baseInput())
  await store.recordAttempt(IDENTITY, { attempt: 1 })
  await store.commitResult(IDENTITY, { state: 'succeeded', result: { status: 200, output: {} } })

  await rejects(
    store.beginInvocation(baseInput({ requestHash: OTHER_HASH })),
    'HTTP_REQUEST_CONFLICT',
    '同一 execution 内容变化必须显式冲突',
  )
  const record = await store.readInvocation(IDENTITY)
  A.equal(record.state, 'succeeded', '旧记录保持不变')
})

await check('markOutcomeUnknown：取消 / 退出后明确标成结果不明', async (root) => {
  const store = createConnectorStore({ root })
  await store.beginInvocation(baseInput())
  await store.recordAttempt(IDENTITY, { attempt: 2 })
  const marked = await store.markOutcomeUnknown(IDENTITY, '取消后结果不明')
  A.equal(marked.state, 'unknown')
  A.equal(marked.error.code, 'HTTP_OUTCOME_UNKNOWN')
  const restarted = createConnectorStore({ root })
  A.equal((await restarted.beginInvocation(baseInput())).status, 'unknown')
})

await check('recordAttempt 之前必须有 begin；非法身份 / 非法 store 明确报错', async (root) => {
  const store = createConnectorStore({ root })
  await rejects(store.recordAttempt(IDENTITY, { attempt: 1 }), 'HTTP_STORE_NOT_STARTED', '未登记就记录尝试必须失败')
  await rejects(
    store.beginInvocation({ ...baseInput(), executionId: '' }),
    'HTTP_INVOCATION_INVALID',
    '缺少 executionId 必须拒绝',
  )
  await rejects(
    store.beginInvocation({ ...baseInput(), requestHash: 'not-a-hash' }),
    'HTTP_INVOCATION_INVALID',
    '非法 requestHash 必须拒绝',
  )
  assertions += 1
  assert.throws(() => createConnectorStore({ root: '' }), (error) => {
    assert.equal(error.code, 'HTTP_STORE_UNAVAILABLE')
    return true
  })
})

await check('原子写：记录 JSON 完整（不残留半截文件）', async (root) => {
  const store = createConnectorStore({ root })
  await store.beginInvocation(baseInput())
  await store.recordAttempt(IDENTITY, { attempt: 1 })
  const text = readFileSync(store.pathFor(IDENTITY), 'utf8')
  A.ok(text.endsWith('\n'), '落盘文件以换行结尾')
  const parsed = JSON.parse(text)
  A.equal(parsed.v, 1)
  A.equal(parsed.executionId, 'submit_execution_1')
  A.equal(parsed.attempts, 1)
  const error = new ConnectorStoreError('X', 'y')
  A.equal(error.code, 'X')
})

await check('m1 处置：mark-succeeded 补录 + 幂等 + 审计 + 冲突保护', async (root) => {
  const store = createConnectorStore({ root })
  await store.beginInvocation(baseInput({ engineExecutionId: 'submit_execution_1', activationAttempt: 1 }))
  await store.recordAttempt(IDENTITY, { attempt: 1 })
  await store.commitResult(IDENTITY, {
    state: 'failed',
    error: { code: 'HTTP_STATUS_NOT_ACCEPTABLE', message: '远端 500' },
  })

  await rejects(
    store.resolveInvocation(IDENTITY, { action: 'mark-succeeded' }),
    'HTTP_RESOLVE_INVALID',
    '没有 evidence 的处置必须拒绝',
  )
  const resolved = await store.resolveInvocation(IDENTITY, {
    action: 'mark-succeeded',
    evidence: '远端工单 #42 确认已入账',
    operator: 'ops-1',
    result: { status: 201, headers: { 'content-type': 'application/json' }, output: { accepted: true } },
  })
  A.equal(resolved.idempotent, false)
  A.equal(resolved.record.state, 'succeeded')
  A.deepEqual(resolved.record.result.output, { accepted: true })
  A.equal(resolved.record.result.manual, true, '人工补录结果带 manual 标记')
  A.equal(typeof resolved.audit.auditId, 'string')
  A.equal(resolved.audit.action, 'mark-succeeded')
  A.equal(resolved.audit.fromState, 'failed')

  const auditText = readFileSync(join(root, 'audit.jsonl'), 'utf8')
  const auditLines = auditText.trim().split('\n').map(line => JSON.parse(line))
  A.equal(auditLines.length, 1, '审计追加一条 JSONL')
  A.equal(auditLines[0].auditId, resolved.audit.auditId)
  A.equal(auditLines[0].evidence, '远端工单 #42 确认已入账')
  A.equal(auditLines[0].operator, 'ops-1')
  A.equal(auditLines[0].fromState, 'failed')
  A.equal(auditLines[0].toState, 'succeeded')

  const twice = await store.resolveInvocation(IDENTITY, {
    action: 'mark-succeeded',
    evidence: '重复提交',
    operator: 'ops-1',
  })
  A.equal(twice.idempotent, true, '同一动作重复提交必须幂等')
  A.equal(twice.record.state, 'succeeded')
  A.equal(twice.record.result.output.accepted, true, '幂等重复不覆盖第一次补录的结果')
  A.equal(readFileSync(join(root, 'audit.jsonl'), 'utf8').trim().split('\n').length, 1, '幂等重复不追加审计')

  await rejects(
    store.resolveInvocation(IDENTITY, { action: 'retry', evidence: '想重发' }),
    'HTTP_RESOLVE_CONFLICT',
    '已成功的记录不能 retry（会重发副作用）',
  )
})

await check('m1 处置：mark-failed / retry（重置为零发送）与可定位 id', async (root) => {
  const store = createConnectorStore({ root })
  await store.beginInvocation(baseInput({ engineExecutionId: 'submit_execution_1', activationAttempt: 1 }))
  await store.recordAttempt(IDENTITY, { attempt: 2 })
  await store.markOutcomeUnknown(IDENTITY, '发送后进程退出')

  const foundByEngineId = await store.findInvocation('i-demo', 'submit_execution_1')
  A.ok(foundByEngineId !== null, '可以用引擎 executionId 定位记录')
  A.equal(foundByEngineId.executionId, 'submit_execution_1')
  const foundByInvocationId = await store.findInvocation('i-demo', 'inv-1')
  A.equal(foundByInvocationId?.executionId, foundByEngineId.executionId, '可以用 invocationId 定位记录')
  A.equal(await store.findInvocation('i-demo', 'missing'), null)

  const retried = await store.resolveInvocation(IDENTITY, {
    action: 'retry',
    evidence: '确认远端未处理，允许受控重试',
    operator: 'ops-2',
  })
  A.equal(retried.record.state, 'started')
  A.equal(retried.record.attempts, 0)
  A.equal(retried.record.error, null)
  A.equal(retried.record.retryAuthorizedAt !== undefined, true, '保留受控重试授权时间')
  const reopened = await store.beginInvocation(baseInput({ engineExecutionId: 'submit_execution_1', activationAttempt: 1 }))
  A.equal(reopened.status, 'fresh', 'retry 之后同一激活可以安全重开')

  await store.recordAttempt(IDENTITY, { attempt: 1 })
  const failed = await store.resolveInvocation(IDENTITY, {
    action: 'mark-failed',
    evidence: '远端确认请求被拒绝（400）',
  })
  A.equal(failed.record.state, 'failed')
  A.equal(failed.record.error.code, 'HTTP_MANUAL_FAILED')
  const failedTwice = await store.resolveInvocation(IDENTITY, { action: 'mark-failed', evidence: '再次确认' })
  A.equal(failedTwice.idempotent, true, 'mark-failed 重复提交幂等')
  const auditLines = readFileSync(join(root, 'audit.jsonl'), 'utf8').trim().split('\n')
  A.equal(auditLines.length, 2, '只有两次真实变更写审计（retry + mark-failed）')
})

await check('markNotSent：发送前超时回滚为可安全重开，不制造假 unknown', async (root) => {
  const store = createConnectorStore({ root })
  await store.beginInvocation(baseInput())
  await store.recordAttempt(IDENTITY, { attempt: 1 })
  const marked = await store.markNotSent(IDENTITY, '整体时限在发送前到期；请求未发出。')
  A.equal(marked.state, 'started')
  A.equal(marked.attempts, 0)
  A.equal(marked.error.code, 'HTTP_NOT_SENT')
  const reopened = await store.beginInvocation(baseInput())
  A.equal(reopened.status, 'fresh', '确认没发出的记录允许重开')
})


await check('R2：迟到写入的世代约束——fence 补偿之后旧 recordAttempt 必须被拒绝', async (root) => {
  const store = createConnectorStore({ root })
  const begun = await store.beginInvocation(baseInput())
  A.equal(begun.record.generation, 1, '新记录从 generation=1 开始')
  const attempt = await store.recordAttempt({ ...IDENTITY, generation: 1 }, { attempt: 1 })
  A.equal(attempt.state, 'sent')

  // 模拟「recordAttempt 超时后立即排补偿」：fence 写入把记录推进到下一代并回滚成未发送。
  const fenced = await store.markNotSent(
    { ...IDENTITY, generation: 1, fence: true },
    '调用记录写入在发送前超时；请求未发出。',
  )
  A.equal(fenced.state, 'started')
  A.equal(fenced.attempts, 0)
  A.equal(fenced.generation, 2, '补偿写入必须推进世代')

  // 迟到的 recordAttempt（旧世代）此时到达：不能把记录写回 sent。
  await rejects(
    store.recordAttempt({ ...IDENTITY, generation: 1 }, { attempt: 2 }),
    'HTTP_STORE_STALE',
    '旧世代的迟到 recordAttempt 必须被拒绝',
  )
  await rejects(
    store.commitResult({ ...IDENTITY, generation: 1 }, { state: 'succeeded', result: { status: 200 } }),
    'HTTP_STORE_STALE',
    '旧世代的迟到 commitResult 必须被拒绝',
  )
  const after = await store.readInvocation(IDENTITY)
  A.equal(after.state, 'started', '「确定未发送」不能被迟到写入覆盖')
  A.equal(after.attempts, 0)

  // 新调用（新世代）可以正常写，且不会与旧写入交叉。
  const reopened = await store.beginInvocation(baseInput())
  A.equal(reopened.status, 'fresh')
  A.equal(reopened.record.generation, 3, '重开取得新世代')
  const rewritten = await store.recordAttempt({ ...IDENTITY, generation: 3 }, { attempt: 1 })
  A.equal(rewritten.state, 'sent')
  A.equal(rewritten.attempts, 1)
})

await check('R2：人工 retry 推进世代，旧调用迟到的写入不能覆盖重置结果', async (root) => {
  const store = createConnectorStore({ root })
  await store.beginInvocation(baseInput())
  await store.recordAttempt(IDENTITY, { attempt: 1 })
  const retried = await store.resolveInvocation(IDENTITY, { action: 'retry', evidence: '工单 #9 允许重发' })
  A.equal(retried.record.state, 'started')
  A.equal(retried.record.attempts, 0)
  A.equal(retried.record.generation, 2, 'retry 重置必须推进世代')
  // 用旧世代写回 sent：必须被拒绝，否则「可安全重开」会被旧调用的迟到写入破坏。
  await rejects(
    store.recordAttempt({ ...IDENTITY, generation: 1 }, { attempt: 1 }),
    'HTTP_STORE_STALE',
    'retry 之后旧世代的迟到 recordAttempt 必须被拒绝',
  )
})

console.log(`\nconnector-store: ${checks} 组 / ${assertions} 条断言通过`)
