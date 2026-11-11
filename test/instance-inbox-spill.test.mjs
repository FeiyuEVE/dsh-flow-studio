#!/usr/bin/env node
/**
 * 实例 inbox 正文落盘自检（0.13.10 D）：
 *  - 4 KiB 内联阈值边界（4096 内联 / 4097 落盘）；
 *  - 超阈值正文逐字节一致（含多字节中文），sha256 / bytes 与正文对得上；
 *  - 超 1 MiB 硬上限 413，且不产生半文件、不进 journal；
 *  - 给 agent 的正文物化在**有效工作区**里，提示词只拿相对路径 + 摘要；
 *  - 人工任务不物化到工作区，走鉴权正文接口。
 *
 * 运行：node test/instance-inbox-spill.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-inbox-spill-'))
const instancesRoot = join(home, 'instances')
const workspaceRoot = join(home, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })

const { createInstanceInbox } = await import('../src/instance-inbox.js')
const {
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

async function rejectsCode(fn, code, message) {
  assertions += 1
  await assert.rejects(fn, error => error && error.code === code, message)
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function makeInstance(id) {
  const dir = join(instancesRoot, id)
  mkdirSync(dir, { recursive: true })
  const now = new Date().toISOString()
  writeFileSync(join(dir, 'instance.json'), `${JSON.stringify({
    id,
    definitionId: 'flow-spill',
    definitionVersion: 1,
    definitionHash: 'b'.repeat(64),
    status: 'ACTIVE',
    variables: {},
    result: null,
    artifacts: [],
    lastError: null,
    pendingTasks: [],
    revision: 1,
    eventCount: 0,
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    definitionSnapshot: 'definition.bpmn',
  }, null, 2)}\n`, 'utf8')
  return { id, dir }
}

function makeAdapter() {
  const calls = []
  return {
    calls,
    id: 'dsh',
    capabilities: () => ({ finishTool: 'native', hooks: { 'turn.stop': 'native' }, messages: 'native' }),
    async deliverMessage(handle, message) {
      calls.push(message)
      return { ok: true, deliveryUnknown: true }
    },
  }
}

function makeInbox() {
  return createInstanceInbox({ instancesRoot })
}

async function registerAgent(inbox, instanceId, executionId) {
  const adapter = makeAdapter()
  await inbox.registerExecution({
    instanceId,
    activityId: 'agent1',
    executionId,
    adapterId: 'dsh',
    adapter,
    handle: {},
    workspaceRoot,
  })
  return adapter
}

await check('内联阈值边界：4096 内联 / 4097 落盘', async () => {
  const instance = await makeInstance('i-threshold')
  // 用 ASCII 精确控制字节数，避免多字节字符干扰边界判断。
  const inlineText = 'a'.repeat(INBOX_INLINE_BODY_LIMIT)
  const spillText = 'a'.repeat(INBOX_INLINE_BODY_LIMIT + 1)
  eq(Buffer.byteLength(inlineText, 'utf8'), 4096)
  const inbox = makeInbox()
  const inline = await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'm-inline',
    target: { activityId: 'agent1', delivery: 'nextActivation' },
    text: inlineText,
  })
  eq(inline.message.body.kind, 'inline')
  const spilled = await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'm-spill-boundary',
    target: { activityId: 'agent1', delivery: 'nextActivation' },
    text: spillText,
  })
  eq(spilled.message.body.kind, 'file')
  eq(spilled.message.body.bytes, INBOX_INLINE_BODY_LIMIT + 1)
  eq(spilled.message.bytes, INBOX_INLINE_BODY_LIMIT + 1)
})

await check('超阈值正文逐字节一致；agent 只拿工作区相对路径 + 摘要', async () => {
  const instance = await makeInstance('i-spill')
  const inbox = makeInbox()
  const adapter = await registerAgent(inbox, instance.id, 'exec-spill')
  const text = `第一段：兼容性说明。\n${'多字节正文🙂'.repeat(2000)}\n最后一行：逐字节核对。`
  ok(Buffer.byteLength(text, 'utf8') > INBOX_INLINE_BODY_LIMIT)
  const accepted = await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'm-spill',
    target: { activityId: 'agent1', executionId: 'exec-spill' },
    text,
    replyTargetId: null,
  })
  eq(accepted.message.status, 'injected')
  eq(adapter.calls.length, 1)
  const payload = adapter.calls[0]
  ok(payload.bodyRef !== null, '投递载荷带 bodyRef')
  eq(payload.bodyRef.sha256, sha256(text), 'bodyRef.sha256 是正文本身')
  eq(payload.bodyRef.bytes, Buffer.byteLength(text, 'utf8'))
  eq(payload.bodyPath, `.flow-studio-inbox/${instance.id}/m-spill.${sha256(text).slice(0, 16)}.md`, '实例隔离 + 内容 hash 的工作区相对路径')
  const materialized = join(workspaceRoot, payload.bodyPath)
  ok(existsSync(materialized), '正文已物化到有效工作区')
  eq(readFileSync(materialized, 'utf8'), text, '物化正文逐字节一致')
  ok(!payload.text.includes(text), '长正文不整段进提示词')
  ok(payload.text.includes(payload.bodyPath), '提示词给出相对路径')
  ok(payload.text.includes(payload.preview.slice(0, 20)), '提示词包含短摘要')

  // 正文接口读回同一份字节。
  const body = await inbox.readMessageBody(instance.id, 'm-spill')
  eq(body.text, text)
  eq(body.bytes, Buffer.byteLength(text, 'utf8'))
  eq(body.sha256, sha256(text))
  const absolute = resolveInboxBodyPath(instancesRoot, instance.id, body.bodyRef)
  eq(readFileSync(absolute, 'utf8'), text, '落盘文件与正文接口一致')
  await inbox.finishExecution({ instanceId: instance.id, executionId: 'exec-spill' })
})

await check('人工任务落盘正文不物化到工作区', async () => {
  const instance = await makeInstance('i-human-spill')
  const inbox = makeInbox()
  await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'human1',
    executionId: 'human_exec_spill',
    kind: 'human',
  })
  const text = '人工讨论正文：'.repeat(1200)
  const accepted = await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'm-human-spill',
    target: { activityId: 'human1', executionId: 'human_exec_spill' },
    text,
  })
  eq(accepted.message.status, 'delivered')
  eq(accepted.message.delivery.kind, 'human')
  const humanFile = join(workspaceRoot, '.flow-studio-inbox', instance.id, 'm-human-spill.md')
  eq(existsSync(humanFile), false, '人工任务不把正文物化进工作区')
  const body = await inbox.readMessageBody(instance.id, 'm-human-spill')
  eq(body.text, text, '人工任务走鉴权正文接口读全文')
  await inbox.finishExecution({ instanceId: instance.id, executionId: 'human_exec_spill' })
})

await check('超 1 MiB：413，无半文件，不进 journal', async () => {
  const instance = await makeInstance('i-too-large')
  const inbox = makeInbox()
  const bodiesDir = join(instancesRoot, instance.id, 'inbox', 'bodies')
  const beforeCount = existsSync(bodiesDir) ? readdirSync(bodiesDir).length : 0
  const text = 'z'.repeat(INBOX_MAX_BODY_BYTES + 1)
  await rejectsCode(() => inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'm-too-large',
    target: { activityId: 'agent1', delivery: 'nextActivation' },
    text,
  }), 'MESSAGE_BODY_TOO_LARGE')
  const afterCount = existsSync(bodiesDir) ? readdirSync(bodiesDir).length : 0
  eq(afterCount, beforeCount, '拒绝时没有留下正文文件')
  const page = await inbox.listMessages(instance.id)
  eq(page.messages.some(item => item.messageId === 'm-too-large'), false, '超限消息没有进入 journal')
})

await check('恰好 1 MiB 可以受理（上限是闭区间）', async () => {
  const instance = await makeInstance('i-limit-ok')
  const inbox = makeInbox()
  const text = 'q'.repeat(INBOX_MAX_BODY_BYTES)
  const accepted = await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'm-limit-ok',
    target: { activityId: 'agent1', delivery: 'nextActivation' },
    text,
  })
  eq(accepted.message.bytes, INBOX_MAX_BODY_BYTES)
  eq(accepted.message.body.kind, 'file')
  const body = await inbox.readMessageBody(instance.id, 'm-limit-ok')
  eq(Buffer.byteLength(body.text, 'utf8'), INBOX_MAX_BODY_BYTES)
})

rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败 / ${checks + failures.length} 项`)
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error && failure.error.stack ? failure.error.stack : failure.error}`)
  process.exit(1)
}
console.log(`\n通过 ${checks} 项、${assertions} 个断言（instance-inbox-spill）`)
