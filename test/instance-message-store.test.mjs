#!/usr/bin/env node
/**
 * 实例消息存储自检（0.13.10 D）：
 *  - 内联 / 落盘正文、4 KiB 内联阈值、1 MiB 硬上限（413 且无半文件）；
 *  - 同一 messageId 同内容幂等 / 不同内容 409；
 *  - 分页、正文 sha256 / 字节逐字节一致；
 *  - 回复 outbox 的幂等、更新与恢复；
 *  - 「重启」= 新 store 实例重放 journal（queued / outbox 可恢复）；
 *  - 回归 M2 / M3 / M4：缺末尾换行的完整记录不丢、投递权不按 TTL 接管、
 *    已投递消息 / 回复不被迟到的收尾回退。
 *
 * 产物落在项目 `.tmp/` 下，不占系统 /tmp。
 * 运行：node test/instance-message-store.test.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname } from 'node:os'
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

function deep(actual, expected, message) {
  assertions += 1
  assert.deepEqual(actual, expected, message)
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

// 回归 M2：完整 JSON 只缺末尾换行的记录，重试必须先在锁内补齐换行，不能在下一次
// 追加时被当成坏尾转存 / 截掉（已受理记录会消失）。messages 与 replies 两个 journal 都覆盖。
for (const kind of ['message', 'reply']) {
  await check(`M2 ${kind}：缺末尾换行的完整记录，重试不丢、下次追加不截掉`, async () => {
    const store = storeAt()
    const iid = `i-m2-${kind}`
    const messageInput = { instanceId: iid, messageId: 'm-lf', target, text: '缺末尾换行' }
    const replyInput = { instanceId: iid, messageId: 'm-lf', replyId: 'r-lf', targetId: 'dest', text: '缺末尾换行' }
    const accept = kind === 'message'
      ? () => store.acceptMessage(messageInput)
      : () => store.acceptReply(replyInput)
    await accept()
    const journal = kind === 'message'
      ? store.paths(iid).messages
      : store.paths(iid).replies
    const raw = readFileSync(journal)
    eq(raw[raw.length - 1], 0x0a, '首次受理以换行结尾')
    writeFileSync(journal, raw.subarray(0, raw.length - 1))

    const retry = await accept()
    eq(retry.duplicate, true, '完整记录仍然幂等命中')
    eq(retry.record.seq, 1)
    const repaired = readFileSync(journal)
    eq(repaired[repaired.length - 1], 0x0a, '重试路径已补齐末尾换行')
    eq(existsSync(`${journal}.torn`), false, '合法记录没有被当成坏尾转存')

    // 下一次追加：记录必须还在，seq 连续。
    if (kind === 'message') {
      await store.acceptMessage({ ...messageInput, messageId: 'm-next', text: '下一条' })
    } else {
      await store.acceptReply({ ...replyInput, replyId: 'r-next', text: '下一条' })
    }
    const kept = kind === 'message'
      ? await store.readMessage(iid, 'm-lf')
      : await store.readReply(iid, 'r-lf')
    ok(kept !== null, '已受理记录仍然存在')
    const seqs = kind === 'message'
      ? (await store.listMessages(iid)).messages.map(record => record.seq)
      : (await store.listReplies(iid)).map(record => record.seq)
    deep(seqs, [1, 2], '记录没有被下一次追加截掉')
    eq(existsSync(`${journal}.torn`), false, '仍然没有坏尾转存')
  })
}

await check('M2：journal 追加遇到短写会继续写完，不产生半行', async () => {
  const store = storeAt()
  const iid = 'i-m2-short-write'
  const originalOpen = fsp.open
  let injected = false
  fsp.open = async function (path, flags, ...rest) {
    const handle = await originalOpen.call(this, path, flags, ...rest)
    if (!injected && String(path).endsWith('.jsonl') && flags === 'a') {
      injected = true
      const originalWrite = handle.write.bind(handle)
      let first = true
      handle.write = async function (buffer, offset, length, position) {
        if (first && typeof offset === 'number' && typeof length === 'number') {
          first = false
          const cut = Math.max(1, Math.floor(length / 2))
          const partial = await originalWrite(buffer, offset, cut, position)
          return { bytesWritten: partial.bytesWritten, buffer }
        }
        return originalWrite(buffer, offset, length, position)
      }
    }
    return handle
  }
  syncBuiltinESMExports()
  try {
    await store.acceptMessage({ instanceId: iid, messageId: 'm-short', target, text: '短写测试' })
  } finally {
    fsp.open = originalOpen
    syncBuiltinESMExports()
  }
  eq(injected, true, '短路确实注入到 journal 追加')
  const lines = readFileSync(store.paths(iid).messages, 'utf8').trim().split('\n')
  eq(lines.length, 1, '只写了一行')
  eq(JSON.parse(lines[0]).messageId, 'm-short', '短写后记录仍然是完整合法 JSON')
})

await check('M3：存活的领取者不会被纯 TTL 接管（跨进程防重复外发）', async () => {
  let clock = Date.now()
  const instancesRootForClock = join(home, 'clock-instances')
  mkdirSync(instancesRootForClock, { recursive: true })
  const store = createInstanceMessageStore({ instancesRoot: instancesRootForClock, now: () => new Date(clock) })
  const iid = 'i-m3-live'
  await store.acceptReply({ instanceId: iid, messageId: 'm', replyId: 'r', targetId: 'dest', text: 'x' })
  const first = await store.claimReplyDispatch(iid, 'r')
  eq(first.claimed, true)
  eq(first.record.dispatch.owner.pid, process.pid, '领取记录带 host pid')
  ok(typeof first.record.dispatch.owner.bootId === 'string' && first.record.dispatch.owner.bootId !== '')
  clock += 120001
  const second = await store.claimReplyDispatch(iid, 'r')
  eq(second.claimed, false, '经过 120s 也不能接管仍存活的投递')
  eq(second.reason, 'in-progress')
  eq(second.ownerAlive, true)
  eq(second.record.attempts, 1, '没有产生新的 attempt')
})

await check('M3：旧领取者进程确认退出后可以接管；旧格式 / 跨主机保持未知', async () => {
  const store = storeAt()
  const iid = 'i-m3-takeover'
  await store.acceptReply({ instanceId: iid, messageId: 'm', replyId: 'r', targetId: 'dest', text: 'x' })
  // 用一个真实退出过的子进程 pid 模拟崩溃的旧领取者。
  const child = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' })
  ok(Number.isSafeInteger(child.pid) && child.pid > 0, '拿到已退出子进程 pid')
  await store.updateReply(iid, 'r', {
    attempts: 1,
    dispatch: {
      token: 'stale-token',
      at: new Date().toISOString(),
      attempt: 1,
      owner: { pid: child.pid, host: hostname(), bootId: 'dead-boot', startTime: '0' },
    },
  })
  const taken = await store.claimReplyDispatch(iid, 'r')
  eq(taken.claimed, true, 'pid 不存活时可以接管')
  eq(taken.attempt, 2)
  eq(taken.recovered, true, '记录为恢复接管')

  // 旧格式（没有 owner）与跨主机：无法确认 → 不接管，明确 unknown。
  const legacyId = 'i-m3-legacy'
  await store.acceptReply({ instanceId: legacyId, messageId: 'm', replyId: 'r', targetId: 'dest', text: 'x' })
  await store.updateReply(legacyId, 'r', {
    dispatch: { token: 'legacy-token', at: new Date().toISOString(), attempt: 1 },
  })
  const legacy = await store.claimReplyDispatch(legacyId, 'r')
  eq(legacy.claimed, false, '旧格式没有 owner 时不按时间猜')
  eq(legacy.reason, 'in-progress')
  eq(legacy.unknown, true)

  const remoteId = 'i-m3-remote'
  await store.acceptReply({ instanceId: remoteId, messageId: 'm', replyId: 'r', targetId: 'dest', text: 'x' })
  await store.updateReply(remoteId, 'r', {
    dispatch: {
      token: 'remote-token',
      at: new Date().toISOString(),
      attempt: 1,
      owner: { pid: process.pid, host: 'another-host', bootId: 'remote-boot', startTime: '0' },
    },
  })
  const remote = await store.claimReplyDispatch(remoteId, 'r')
  eq(remote.claimed, false, '跨主机无法验证存活，不接管')
  eq(remote.unknown, true)
})

await check('M4：已投递消息不能被无条件更新回退成 failed', async () => {
  const store = storeAt()
  const iid = 'i-m4-message'
  await store.acceptMessage({ instanceId: iid, messageId: 'm', target, text: '已投递' })
  await store.updateMessage(iid, 'm', { status: 'injected', delivery: { kind: 'agent' } })
  await rejectsCode(
    () => store.updateMessage(iid, 'm', { status: 'failed', delivery: { kind: 'none', reason: 'instance-completed' } }),
    'MESSAGE_STATUS_REGRESSION',
  )
  eq((await store.readMessage(iid, 'm')).status, 'injected', '迟到的收尾没有覆盖成功状态')
  // 条件更新：最新状态不是期望值时拒绝（收尾先读到 queued 之后被投递成功）。
  await rejectsCode(
    () => store.updateMessage(iid, 'm', { status: 'failed' }, { expectStatus: 'queued' }),
    'MESSAGE_CONDITION_FAILED',
  )
  // 重新排队（测试 / 重投语义）仍然允许。
  const requeued = await store.updateMessage(iid, 'm', { status: 'queued' })
  eq(requeued.status, 'queued')
})

await check('M4：已投递回复不能被回退；在飞回复也不允许被标 skipped', async () => {
  const store = storeAt()
  const iid = 'i-m4-reply'
  await store.acceptReply({ instanceId: iid, messageId: 'm', replyId: 'r', targetId: 'dest', text: 'x' })
  const claim = await store.claimReplyDispatch(iid, 'r')
  eq(claim.claimed, true)
  const inFlight = await store.skipQueuedReply(iid, 'r', { delivery: { kind: 'none', reason: 'instance-canceled' } })
  eq(inFlight.updated, false)
  eq(inFlight.reason, 'dispatch-in-flight', '在飞投递不被取消收尾回退')
  eq((await store.readReply(iid, 'r')).status, 'queued')
  await rejectsCode(
    () => store.updateReply(iid, 'r', { status: 'skipped' }),
    'MESSAGE_STATUS_REGRESSION',
  )
  await store.completeReplyDispatch(iid, 'r', {
    token: claim.token,
    status: 'delivered',
    delivery: { kind: 'session', deliveryUnknown: false },
  })
  await rejectsCode(
    () => store.updateReply(iid, 'r', { status: 'skipped' }),
    'MESSAGE_STATUS_REGRESSION',
  )
  const after = await store.skipQueuedReply(iid, 'r', { delivery: { kind: 'none', reason: 'instance-canceled' } })
  eq(after.updated, false)
  eq(after.reason, 'not-queued')
  eq((await store.readReply(iid, 'r')).status, 'delivered', '已送达回复保持 delivered')
})

rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败 / ${checks + failures.length} 项`)
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error && failure.error.stack ? failure.error.stack : failure.error}`)
  process.exit(1)
}
console.log(`\n通过 ${checks} 项、${assertions} 个断言（instance-message-store）`)
