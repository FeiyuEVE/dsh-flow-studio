#!/usr/bin/env node
/**
 * 实例消息存储自检（0.13.10 D）：
 *  - 内联 / 落盘正文、4 KiB 内联阈值、1 MiB 硬上限（413 且无半文件）；
 *  - 同一 messageId 同内容幂等 / 不同内容 409；
 *  - 分页、正文 sha256 / 字节逐字节一致；
 *  - 回复 outbox 的幂等、更新与恢复；
 *  - 「重启」= 新 store 实例重放 journal（queued / outbox 可恢复）。
 *
 * 产物落在项目 `.tmp/` 下，不占系统 /tmp。
 * 运行：node test/instance-message-store.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-msg-store-'))
const instancesRoot = join(home, 'instances')

const {
  createInstanceMessageStore,
  INBOX_INLINE_BODY_LIMIT,
  INBOX_MAX_BODY_BYTES,
  resolveInboxBodyPath,
} = await import('../src/instance-message-store.js')

let checks = 0
let assertions = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    checks += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}`)
    console.log('    ' + String((error && error.message) || error))
  }
}

function eq(actual, expected, message) {
  assertions += 1
  assert.equal(actual, expected, message)
}

function ok(value, message) {
  assertions += 1
  assert.ok(value, message)
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function rejectsCode(fn, code, message) {
  assertions += 1
  await assert.rejects(fn, error => error && error.code === code, message)
}

function storeAt() {
  return createInstanceMessageStore({ instancesRoot })
}

const instanceId = 'i-store'
const target = { activityId: 'review', executionId: 'review_execution_1' }

await check('内联消息：受理 / 幂等 / 同 id 不同内容 409', async () => {
  const store = storeAt()
  const text = '请补充兼容性说明。'
  const first = await store.acceptMessage({ instanceId, messageId: 'm-1', target, text, replyTargetId: null })
  eq(first.duplicate, false)
  eq(first.record.status, 'queued')
  eq(first.record.body.kind, 'inline')
  eq(first.record.bytes, Buffer.byteLength(text, 'utf8'))

  const again = await store.acceptMessage({ instanceId, messageId: 'm-1', target, text, replyTargetId: null })
  eq(again.duplicate, true, '同内容幂等')
  eq(again.record.seq, first.record.seq, '幂等返回原记录（seq 不变）')

  await rejectsCode(
    () => store.acceptMessage({ instanceId, messageId: 'm-1', target, text: '不同内容', replyTargetId: null }),
    'MESSAGE_ID_CONFLICT',
    '同 messageId 不同内容 409',
  )
  const body = await store.readMessageBody(instanceId, 'm-1')
  eq(body.text, text, '正文逐字节一致')
  eq(body.bodyRef, null, '内联消息没有 bodyRef')
})

await check('分页：cursor 是上一页最后一条 seq，limit 有界', async () => {
  const store = storeAt()
  for (let index = 2; index <= 6; index += 1) {
    await store.acceptMessage({
      instanceId,
      messageId: `m-${index}`,
      target,
      text: `第 ${index} 条`,
    })
  }
  const firstPage = await store.listMessages(instanceId, { limit: 3 })
  eq(firstPage.messages.length, 3)
  eq(firstPage.messages[0].messageId, 'm-1', '按 seq 升序')
  eq(firstPage.nextCursor, firstPage.messages[2].seq, 'nextCursor 指向本页最后一条')
  const secondPage = await store.listMessages(instanceId, { cursor: firstPage.nextCursor, limit: 3 })
  eq(secondPage.messages.length, 3)
  eq(secondPage.messages[0].messageId, 'm-4')
  eq(secondPage.nextCursor, null, '最后一页 nextCursor=null')
  eq(secondPage.total, 6)
  eq(firstPage.messages[0].body.kind, 'inline')
  ok(firstPage.messages[0].body.text === undefined, '列表不返回内联正文全文')
})

await check('超 4 KiB 正文落盘：先写文件再受理，bodyRef 可读且逐字节一致', async () => {
  const store = storeAt()
  const text = `长正文开始：${'兼容性'.repeat(1200)}：结束`
  ok(Buffer.byteLength(text, 'utf8') > INBOX_INLINE_BODY_LIMIT, '测试正文确实超过阈值')
  const accepted = await store.acceptMessage({ instanceId, messageId: 'm-spill', target, text })
  eq(accepted.record.body.kind, 'file')
  ok(accepted.record.body.path.startsWith('inbox/bodies/'), 'bodyRef.path 在 inbox/bodies/ 下')
  eq(accepted.record.body.bytes, Buffer.byteLength(text, 'utf8'))
  eq(accepted.record.body.sha256, sha256(text))
  const absolute = resolveInboxBodyPath(instancesRoot, instanceId, accepted.record.body)
  ok(existsSync(absolute), '正文文件已落盘')
  eq(readFileSync(absolute, 'utf8'), text, '落盘正文与原文逐字节一致')
  const body = await store.readMessageBody(instanceId, 'm-spill')
  eq(body.text, text)
  eq(body.bodyRef.sha256, sha256(text))
  ok(body.record.preview.length < text.length, '记录里只有摘要')
})

await check('超 1 MiB 硬上限：413 且没有半文件', async () => {
  const store = storeAt()
  const text = 'x'.repeat(INBOX_MAX_BODY_BYTES + 1)
  const bodiesDir = join(instancesRoot, instanceId, 'inbox', 'bodies')
  const before = existsSync(bodiesDir) ? readdirSync(bodiesDir).length : 0
  await rejectsCode(
    () => store.acceptMessage({ instanceId, messageId: 'm-too-large', target, text }),
    'MESSAGE_BODY_TOO_LARGE',
  )
  const after = existsSync(bodiesDir) ? readdirSync(bodiesDir).length : 0
  eq(after, before, '被拒绝的超限消息没有产生正文文件')
  const messages = await store.listMessages(instanceId, { limit: 100 })
  ok(!messages.messages.some(item => item.messageId === 'm-too-large'), '超限消息没有进入 journal')
})

await check('重复受理不会重复排队：6 条只产生 6 条记录', async () => {
  const store = storeAt()
  for (let index = 0; index < 6; index += 1) {
    await store.acceptMessage({
      instanceId,
      messageId: `m-batch-${index}`,
      target,
      text: `批量 ${index}`,
    })
    await store.acceptMessage({
      instanceId,
      messageId: `m-batch-${index}`,
      target,
      text: `批量 ${index}`,
    })
  }
  const page = await store.listMessages(instanceId, { limit: 100 })
  const batch = page.messages.filter(item => item.messageId.startsWith('m-batch-'))
  eq(batch.length, 6, '重复入站请求不重复排队')
})

await check('回复 outbox：幂等 / 稳定 replyId / 更新后恢复', async () => {
  const store = storeAt()
  const first = await store.acceptReply({
    instanceId,
    messageId: 'm-1',
    replyId: 'reply-fixed',
    targetId: 'operator-session',
    text: '已收到，稍后处理。',
  })
  eq(first.duplicate, false)
  eq(first.record.status, 'queued')
  const again = await store.acceptReply({
    instanceId,
    messageId: 'm-1',
    replyId: 'reply-fixed',
    targetId: 'operator-session',
    text: '已收到，稍后处理。',
  })
  eq(again.duplicate, true, '同 replyId + 同内容幂等')
  await rejectsCode(
    () => store.acceptReply({
      instanceId,
      messageId: 'm-1',
      replyId: 'reply-fixed',
      targetId: 'operator-session',
      text: '换个说法',
    }),
    'MESSAGE_ID_CONFLICT',
  )
  const generated = await store.acceptReply({
    instanceId,
    messageId: 'm-1',
    targetId: 'operator-session',
    text: '确定性 replyId',
  })
  ok(generated.record.replyId.startsWith('reply-'), '省略 replyId 时确定性生成')
  const generatedAgain = await store.acceptReply({
    instanceId,
    messageId: 'm-1',
    targetId: 'operator-session',
    text: '确定性 replyId',
  })
  eq(generatedAgain.record.replyId, generated.record.replyId, '相同内容重试拿到同一 replyId')
  eq(generatedAgain.duplicate, true)

  await store.updateReply(instanceId, 'reply-fixed', {
    status: 'failed',
    attempts: 1,
    lastError: { code: 'MESSAGE_REPLY_HTTP_STATUS', message: 'HTTP 500', retryable: true },
  })
  const reloaded = storeAt()
  const record = await reloaded.readReply(instanceId, 'reply-fixed')
  eq(record.status, 'failed', '重启后 outbox 恢复')
  eq(record.attempts, 1)
  eq(record.lastError.code, 'MESSAGE_REPLY_HTTP_STATUS')
  const list = await reloaded.listReplies(instanceId, { messageId: 'm-1' })
  eq(list.length, 2)
})

await check('重启后 queued 可恢复；损坏半行不阻断后续记录', async () => {
  const journal = join(instancesRoot, instanceId, 'inbox', 'messages.jsonl')
  writeFileSync(journal, `${readFileSync(journal, 'utf8')}{"messageId":"half`, 'utf8')
  const reloaded = storeAt()
  const page = await reloaded.listMessages(instanceId, { limit: 100 })
  ok(page.messages.length >= 7, '已完整记录仍可读')
  ok(page.messages.every(item => item.status === 'queued'), 'queued 状态从 journal 恢复')
  const body = await reloaded.readMessageBody(instanceId, 'm-spill')
  eq(body.text.length > 0, true, '落盘正文重启后仍可读')
})

// 回归 N5：崩溃遗留的尾部半行必须在追加前隔离，否则下一条已受理记录会被整行吞掉。
await check('journal 尾部半行：锁内转存 .torn + 截断，新记录可读且 seq 连续', async () => {
  const repairedId = 'i-store-torn'
  const store = storeAt()
  const first = await store.acceptMessage({ instanceId: repairedId, messageId: 't-1', target, text: '第一条' })
  const journal = join(instancesRoot, repairedId, 'inbox', 'messages.jsonl')
  appendFileSync(journal, '{"messageId":"crashed"', 'utf8')
  const second = await store.acceptMessage({ instanceId: repairedId, messageId: 't-2', target, text: '第二条' })
  eq(second.record.seq, 2, '新记录拿到连续 seq')
  eq((await store.readMessage(repairedId, 't-2'))?.messageId, 't-2', '新记录可读（没被坏尾行吞掉）')
  eq((await store.listMessages(repairedId)).total, 2)
  const tornLines = readFileSync(`${journal}.torn`, 'utf8').trim().split('\n')
  eq(tornLines.length, 1, '坏尾行转存到 .torn 旁路文件')
  const envelope = JSON.parse(tornLines[0])
  eq(envelope.journal, 'messages.jsonl')
  eq(envelope.bytes, Buffer.byteLength('{"messageId":"crashed"', 'utf8'))
  eq(Buffer.from(envelope.rawBase64, 'base64').toString('utf8'), '{"messageId":"crashed"', '原始字节可恢复')
  const again = await store.acceptMessage({ instanceId: repairedId, messageId: 't-1', target, text: '第一条' })
  eq(again.duplicate, true, '原有幂等语义不变')
  eq(again.record.seq, first.record.seq, '幂等返回原 seq')
})

// 回归 N7：过期必须是条件更新，已投递消息不会被 execution 结束改成 failed。
await check('过期条件更新：已投递消息不被 execution 结束改成 failed', async () => {
  const expireId = 'i-store-expire'
  const store = storeAt()
  await store.acceptMessage({ instanceId: expireId, messageId: 'done-1', target, text: '已投递' })
  await store.acceptMessage({ instanceId: expireId, messageId: 'queued-1', target, text: '未投递' })
  await store.updateMessage(expireId, 'done-1', { status: 'injected' })
  const expired = await store.expireQueuedForExecution(expireId, target.executionId, 'execution-ended')
  eq(expired.length, 1, '只收口仍 queued 的消息')
  eq(expired[0].messageId, 'queued-1')
  eq((await store.readMessage(expireId, 'done-1')).status, 'injected', '已投递状态不被覆盖')
  eq((await store.readMessage(expireId, 'queued-1')).status, 'failed')
})

// 回归 N6：领取投递权 + token/rev CAS；迟到失败不能覆盖已成功的 delivered。
await check('回复投递权：claim 独占、写回 CAS、迟到失败不覆盖 delivered', async () => {
  const claimId = 'i-store-claim'
  const store = storeAt()
  await store.acceptReply({ instanceId: claimId, messageId: 'm', replyId: 'r-1', targetId: 'dest', text: 'answer' })
  const claim = await store.claimReplyDispatch(claimId, 'r-1')
  eq(claim.claimed, true, '第一条调用链拿到投递权')
  eq(claim.attempt, 1, '领取即产生新的 attempt 号')
  const competing = await store.claimReplyDispatch(claimId, 'r-1')
  eq(competing.claimed, false, '同一时刻只允许一次外发')
  eq(competing.reason, 'in-progress')

  const success = await store.completeReplyDispatch(claimId, 'r-1', {
    token: claim.token,
    status: 'delivered',
    attempts: claim.attempt,
    delivery: { kind: 'session', deliveryUnknown: true },
  })
  eq(success.updated, true)
  eq(success.record.status, 'delivered')

  // 迟到的失败结果（旧 token）不能把 delivered 改回 failed。
  const late = await store.completeReplyDispatch(claimId, 'r-1', {
    token: claim.token,
    status: 'failed',
    attempts: claim.attempt,
    lastError: { code: 'LATE_FAILURE', message: '迟到的失败' },
    delivery: { kind: 'session', deliveryUnknown: true },
  })
  eq(late.updated, false, '已 delivered 后拒绝迟到失败写回')
  eq(late.record.status, 'delivered')
  eq((await store.readReply(claimId, 'r-1')).status, 'delivered')

  // 明确失败后可以重新领取并重试；token 不匹配的写回被拒绝。
  await store.acceptReply({ instanceId: claimId, messageId: 'm', replyId: 'r-2', targetId: 'dest', text: 'retry' })
  const claim2 = await store.claimReplyDispatch(claimId, 'r-2')
  const failed = await store.completeReplyDispatch(claimId, 'r-2', {
    token: claim2.token,
    status: 'failed',
    attempts: claim2.attempt,
    lastError: { code: 'MESSAGE_REPLY_HTTP_STATUS', message: 'HTTP 500' },
    delivery: { kind: 'http', deliveryUnknown: true, status: 500 },
  })
  eq(failed.updated, true)
  eq((await store.readReply(claimId, 'r-2')).status, 'failed')
  const claim3 = await store.claimReplyDispatch(claimId, 'r-2')
  eq(claim3.claimed, true, '明确失败后允许重试')
  eq(claim3.attempt, 2, '重试拿到新的 attempt 号')
  const stale = await store.completeReplyDispatch(claimId, 'r-2', {
    token: claim2.token,
    status: 'delivered',
    attempts: claim2.attempt,
  })
  eq(stale.updated, false, '旧 token 不能写回（投递权已被新一次重试接管）')
  await store.completeReplyDispatch(claimId, 'r-2', {
    token: claim3.token,
    status: 'delivered',
    attempts: claim3.attempt,
    delivery: { kind: 'http', deliveryUnknown: false, status: 200 },
  })
  eq((await store.readReply(claimId, 'r-2')).attempts, 2)
})

rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败 / ${checks + failures.length} 项`)
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error && failure.error.stack ? failure.error.stack : failure.error}`)
  process.exit(1)
}
console.log(`\n通过 ${checks} 项、${assertions} 个断言（instance-message-store）`)
