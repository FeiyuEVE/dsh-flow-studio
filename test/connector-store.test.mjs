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

console.log(`\nconnector-store: ${checks} 组 / ${assertions} 条断言通过`)
