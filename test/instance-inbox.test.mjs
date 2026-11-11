#!/usr/bin/env node
/**
 * 实例 inbox 自检（0.13.10 D）：
 *  - live agent / 冷会话 / 未来节点 / 人工任务四种目标；
 *  - nextActivation 只绑定第一次激活，循环重入不串消息；
 *  - 重复入站幂等、同 id 不同内容 409、已结束 execution 410；
 *  - 6 条首批只确认 5 条，第 6 条仍可投递；
 *  - SUSPENDED 受理排队不唤起 agent；COMPLETED/CANCELED 拒绝新消息；
 *  - 回复 outbox：白名单目标 / CANCELED 停止 / COMPLETED 后续投 / HTTP 重试稳定 replyId；
 *  - 人工任务收消息不写完成变量。
 *
 * 全部用假 adapter / 假实例目录，不启动 runner、不发真实网络。
 * 运行：node test/instance-inbox.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-inbox-'))
const instancesRoot = join(home, 'instances')
const workspaceRoot = join(home, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })

const { createInstanceInbox } = await import('../src/instance-inbox.js')
const { createInstanceTools } = await import('../src/instance-tools.js')

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

async function rejectsCode(fn, code, message) {
  assertions += 1
  await assert.rejects(fn, error => error && error.code === code, message)
}

let instanceSeq = 0
async function makeInstance(options = {}) {
  instanceSeq += 1
  const id = options.id || `i-inbox-${instanceSeq}`
  const dir = join(instancesRoot, id)
  mkdirSync(dir, { recursive: true })
  const now = new Date().toISOString()
  const record = {
    id,
    definitionId: 'flow-inbox',
    definitionVersion: 1,
    definitionHash: 'a'.repeat(64),
    status: options.status || 'ACTIVE',
    variables: {},
    result: null,
    artifacts: [],
    lastError: null,
    pendingTasks: options.pendingTasks || [],
    revision: 1,
    eventCount: 0,
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    definitionSnapshot: 'definition.bpmn',
  }
  writeFileSync(join(dir, 'instance.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return { id, dir, record }
}

function patchInstance(instance, patch) {
  const next = { ...instance.record, ...patch, revision: instance.record.revision + 1, updatedAt: new Date().toISOString() }
  writeFileSync(join(instance.dir, 'instance.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  instance.record = next
}

function makeAdapter(options = {}) {
  const calls = []
  return {
    calls,
    id: 'dsh',
    capabilities() {
      return {
        finishTool: 'native',
        hooks: { 'turn.stop': 'native' },
        messages: options.messages || 'native',
      }
    },
    async deliverMessage(handle, message) {
      calls.push({ handle, message })
      if (options.throws) throw new Error('adapter boom')
      return options.result === undefined ? { ok: true, deliveryUnknown: true } : options.result
    },
  }
}

function makeInbox(options = {}) {
  return createInstanceInbox({
    instancesRoot,
    replyTargets: options.replyTargets,
    httpPolicy: options.httpPolicy,
    sessionDeliver: options.sessionDeliver,
    httpRequest: options.httpRequest,
    now: options.now,
  })
}

await check('精确目标：live agent 注入 + 幂等 / 409', async () => {
  const instance = await makeInstance()
  const adapter = makeAdapter()
  const inbox = makeInbox()
  await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'agent1',
    executionId: 'exec-1',
    attempt: 1,
    kind: 'agent',
    adapterId: 'dsh',
    adapter,
    handle: { id: 'handle-1' },
    workspaceRoot,
  })
  const first = await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-1',
    target: { activityId: 'agent1', executionId: 'exec-1' },
    text: '请补充兼容性说明。',
  })
  eq(first.message.status, 'injected')
  eq(first.message.delivery.kind, 'agent')
  eq(first.message.delivery.deliveryUnknown, true, 'DSH 无法确认模型读过')
  eq(adapter.calls.length, 1)
  eq(adapter.calls[0].message.messageId, 'msg-1')
  eq(adapter.calls[0].message.text.includes('请补充兼容性说明。'), true, '内联正文完整投递')

  const again = await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-1',
    target: { activityId: 'agent1', executionId: 'exec-1' },
    text: '请补充兼容性说明。',
  })
  eq(again.duplicate, true)
  eq(adapter.calls.length, 1, '重复入站不重复投递')
  await rejectsCode(() => inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-1',
    target: { activityId: 'agent1', executionId: 'exec-1' },
    text: '不同内容',
  }), 'MESSAGE_ID_CONFLICT')
  await inbox.finishExecution({ instanceId: instance.id, executionId: 'exec-1' })
})

await check('冷恢复：同一 execution 投递标 resumed', async () => {
  const instance = await makeInstance()
  const adapter = makeAdapter()
  const inbox = makeInbox()
  await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'agent1',
    executionId: 'exec-cold',
    kind: 'agent',
    cold: true,
    adapterId: 'dsh',
    adapter,
    handle: {},
    workspaceRoot,
  })
  const accepted = await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-cold',
    target: { activityId: 'agent1', executionId: 'exec-cold' },
    text: '恢复后继续。',
  })
  eq(accepted.message.status, 'resumed', '冷恢复投递标 resumed')
  eq(adapter.calls.length, 1)
  await inbox.finishExecution({ instanceId: instance.id, executionId: 'exec-cold' })
})

await check('未来节点：只绑定后续第一次激活，循环重入隔离', async () => {
  const instance = await makeInstance()
  const adapter = makeAdapter()
  const inbox = makeInbox()
  const first = await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-next-1',
    target: { activityId: 'review', delivery: 'nextActivation' },
    text: '第一轮的消息',
  })
  eq(first.message.status, 'queued', '未激活前排队')
  eq(adapter.calls.length, 0)

  // 先激活别的节点：不绑定。
  await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'other',
    executionId: 'exec-other',
    adapterId: 'dsh',
    adapter,
    handle: {},
    workspaceRoot,
  })
  let page = await inbox.listMessages(instance.id)
  eq(page.messages.find(item => item.messageId === 'msg-next-1').status, 'queued', '别的节点不会拿走消息')

  // 第一次激活 review：绑定并注入。
  await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'review',
    executionId: 'review_execution_1',
    adapterId: 'dsh',
    adapter,
    handle: { round: 1 },
    workspaceRoot,
  })
  page = await inbox.listMessages(instance.id)
  eq(page.messages.find(item => item.messageId === 'msg-next-1').status, 'injected')
  eq(adapter.calls.length, 1)
  eq(adapter.calls[0].message.executionId, 'review_execution_1')

  // 新一轮激活：不会再收到上一轮的已绑定消息。
  await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'review',
    executionId: 'review_execution_2',
    adapterId: 'dsh',
    adapter,
    handle: { round: 2 },
    workspaceRoot,
  })
  eq(adapter.calls.length, 1, '循环重入不会拿到上一 execution 的消息')
  page = await inbox.listMessages(instance.id)
  eq(page.messages.find(item => item.messageId === 'msg-next-1').binding.executionId, 'review_execution_1')
  await inbox.finishExecution({ instanceId: instance.id, executionId: 'review_execution_1' })
  await inbox.finishExecution({ instanceId: instance.id, executionId: 'review_execution_2' })
  await inbox.finishExecution({ instanceId: instance.id, executionId: 'exec-other' })
})

await check('人工任务：消息只是讨论，不改 pendingTasks / 不调 signalTask', async () => {
  const instance = await makeInstance({
    pendingTasks: [{
      activityId: 'human1',
      elementId: 'human1',
      name: '人工审批',
      since: new Date().toISOString(),
      executionId: 'human_exec_1',
      accepts: [],
    }],
  })
  const before = readFileSync(join(instance.dir, 'instance.json'), 'utf8')
  const adapter = makeAdapter()
  const inbox = makeInbox()
  await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'human1',
    executionId: 'human_exec_1',
    kind: 'human',
  })
  const accepted = await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-human',
    target: { activityId: 'human1', executionId: 'human_exec_1' },
    text: '这是讨论 / 附件，不是完成决定。',
  })
  eq(accepted.message.status, 'delivered')
  eq(accepted.message.delivery.kind, 'human')
  eq(adapter.calls.length, 0, '人工任务不走 agent 投递')
  const after = readFileSync(join(instance.dir, 'instance.json'), 'utf8')
  eq(after, before, '收消息不写 instance.json（不写完成变量、不 signalTask）')
  await inbox.finishExecution({ instanceId: instance.id, executionId: 'human_exec_1' })
})

await check('SUSPENDED 受理排队但不唤起；恢复 ACTIVE 后可投递', async () => {
  const instance = await makeInstance({ status: 'SUSPENDED', pendingTasks: [{
    activityId: 'human1',
    elementId: 'human1',
    executionId: 'human_exec_s',
    accepts: [],
  }] })
  const adapter = makeAdapter()
  const inbox = makeInbox()
  const accepted = await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-suspended',
    target: { activityId: 'human1', executionId: 'human_exec_s' },
    text: '挂起期间排队的消息。',
  })
  eq(accepted.message.status, 'queued')
  eq(accepted.delivery.deferred, true)
  eq(adapter.calls.length, 0, '挂起不唤起 agent')

  patchInstance(instance, { status: 'ACTIVE' })
  await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'human1',
    executionId: 'human_exec_s',
    kind: 'human',
  })
  const page = await inbox.listMessages(instance.id)
  eq(page.messages.find(item => item.messageId === 'msg-suspended').status, 'delivered')
  await inbox.finishExecution({ instanceId: instance.id, executionId: 'human_exec_s' })
})

await check('已结束 execution 410；终态实例拒绝新消息', async () => {
  const instance = await makeInstance()
  const inbox = makeInbox()
  await rejectsCode(() => inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-expired',
    target: { activityId: 'agent1', executionId: 'exec-gone' },
    text: '过期消息',
  }), 'MESSAGE_TARGET_EXPIRED')

  patchInstance(instance, { status: 'COMPLETED', pendingTasks: [] })
  await rejectsCode(() => inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-completed',
    target: { activityId: 'agent1', delivery: 'nextActivation' },
    text: '实例已结束',
  }), 'MESSAGE_INSTANCE_TERMINAL')

  patchInstance(instance, { status: 'CANCELED' })
  await rejectsCode(() => inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-canceled',
    target: { activityId: 'agent1', delivery: 'nextActivation' },
    text: '实例已取消',
  }), 'MESSAGE_INSTANCE_TERMINAL')
})

await check('6 条首批只确认 5 条，第 6 条仍可投递；执行结束未投递按过期', async () => {
  const instance = await makeInstance()
  const adapter = makeAdapter()
  const inbox = makeInbox()
  for (let index = 0; index < 6; index += 1) {
    await inbox.acceptInstanceMessage({
      instanceId: instance.id,
      messageId: `msg-batch-${index}`,
      target: { activityId: 'batch', delivery: 'nextActivation' },
      text: `批量消息 ${index}`,
    })
  }
  const registered = await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'batch',
    executionId: 'batch_exec_1',
    adapterId: 'dsh',
    adapter,
    handle: {},
    workspaceRoot,
  })
  eq(registered.delivery.confirmed.length, 5, '首批只确认 5 条')
  eq(adapter.calls.length, 5)
  let page = await inbox.listMessages(instance.id, { limit: 100 })
  const batch = page.messages.filter(item => item.messageId.startsWith('msg-batch-'))
  eq(batch.filter(item => item.status === 'injected').length, 5)
  eq(batch.filter(item => item.status === 'queued').length, 1, '第 6 条仍排队')

  const second = await inbox.deliverQueued(instance.id, 'batch_exec_1')
  eq(second.confirmed.length, 1, '第 6 条仍可投递')
  eq(adapter.calls.length, 6)

  // 再排 6 条：首批 5 条、结束执行让剩余 1 条过期。
  for (let index = 0; index < 6; index += 1) {
    await inbox.acceptInstanceMessage({
      instanceId: instance.id,
      messageId: `msg-expire-${index}`,
      target: { activityId: 'batch', delivery: 'nextActivation' },
      text: `待过期 ${index}`,
    })
  }
  await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'batch',
    executionId: 'batch_exec_2',
    adapterId: 'dsh',
    adapter,
    handle: {},
    workspaceRoot,
  })
  eq(adapter.calls.length, 11, '第二批又是 5 条')
  const finished = await inbox.finishExecution({ instanceId: instance.id, executionId: 'batch_exec_2' })
  eq(finished.expired.length, 1, '执行结束后剩余消息按过期失败')
  page = await inbox.listMessages(instance.id, { limit: 100 })
  const remain = page.messages.find(item => item.messageId === 'msg-expire-5')
  eq(remain.status, 'failed')
  eq(remain.delivery.reason, 'execution-ended')
})

await check('不适配器消息能力：failed + deliveryUnknown，不假装成功', async () => {
  const instance = await makeInstance()
  const adapter = makeAdapter({ messages: 'unsupported' })
  const inbox = makeInbox()
  await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'agent1',
    executionId: 'exec-unsupported',
    adapterId: 'codex',
    adapter,
    handle: {},
    workspaceRoot,
  })
  const accepted = await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-unsupported',
    target: { activityId: 'agent1', executionId: 'exec-unsupported' },
    text: '不支持投递的消息',
  })
  eq(accepted.message.status, 'failed')
  eq(accepted.message.delivery.deliveryUnknown, true)
  eq(accepted.message.delivery.code, 'MESSAGE_DELIVERY_UNSUPPORTED')
  eq(adapter.calls.length, 0)
  await inbox.finishExecution({ instanceId: instance.id, executionId: 'exec-unsupported' })
})

await check('回复白名单：非白名单 session / 任意目标在受理时被拒', async () => {
  const instance = await makeInstance()
  const inbox = makeInbox({ replyTargets: {
    'operator-session': { kind: 'session', sessionId: 'approved-session' },
  } })
  const adapter = makeAdapter()
  await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'agent1',
    executionId: 'exec-reply',
    adapterId: 'dsh',
    adapter,
    handle: {},
    workspaceRoot,
  })
  await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-reply',
    target: { activityId: 'agent1', executionId: 'exec-reply' },
    text: '需要回复',
    replyTargetId: 'operator-session',
  })
  await rejectsCode(() => inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-reply-bad',
    target: { activityId: 'agent1', executionId: 'exec-reply' },
    text: '恶意回复目标',
    replyTargetId: 'https://evil.example/hook',
  }), 'MESSAGE_REPLY_TARGET_UNKNOWN')

  const sessionCalls = []
  const sessionInbox = makeInbox({
    replyTargets: { 'operator-session': { kind: 'session', sessionId: 'approved-session' } },
    sessionDeliver: async payload => {
      sessionCalls.push(payload)
      return { ok: true, deliveryUnknown: true }
    },
  })
  // 重新登记（新 inbox 的 live 表是空的）；消息在共享 store 里。
  await sessionInbox.registerExecution({
    instanceId: instance.id,
    activityId: 'agent1',
    executionId: 'exec-reply',
    adapterId: 'dsh',
    adapter,
    handle: {},
    workspaceRoot,
  })
  const enqueued = await sessionInbox.enqueueReply({
    instanceId: instance.id,
    messageId: 'msg-reply',
    replyId: 'reply-session-1',
    text: '已收到。',
  })
  eq(enqueued.reply.status, 'queued')
  const dispatched = await sessionInbox.dispatchReply({ instanceId: instance.id, replyId: 'reply-session-1' })
  eq(dispatched.reply.status, 'delivered')
  eq(sessionCalls.length, 1)
  eq(sessionCalls[0].sessionId, 'approved-session', '只投宿主白名单里的 session')
  eq(sessionCalls[0].text, '已收到。')
  const retry = await sessionInbox.dispatchReply({ instanceId: instance.id, replyId: 'reply-session-1' })
  eq(retry.duplicate, true, '已送达的回复重复 dispatch 幂等')
  await sessionInbox.finishExecution({ instanceId: instance.id, executionId: 'exec-reply' })
})

await check('回复 HTTP：共用网络策略；失败重试保持稳定 replyId', async () => {
  const instance = await makeInstance()
  const adapter = makeAdapter()
  const requests = []
  let failures = 1
  const inbox = makeInbox({
    replyTargets: {
      'ticket-hook': { kind: 'http', url: 'https://example.com/hooks/ticket' },
    },
    httpPolicy: {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    },
    httpRequest: async request => {
      requests.push(request)
      if (failures > 0) {
        failures -= 1
        throw Object.assign(new Error('connect reset'), { code: 'MESSAGE_REPLY_NETWORK' })
      }
      return { status: 200, body: '{"ok":true}' }
    },
  })
  await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'agent1',
    executionId: 'exec-http',
    adapterId: 'dsh',
    adapter,
    handle: {},
    workspaceRoot,
  })
  await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-http',
    target: { activityId: 'agent1', executionId: 'exec-http' },
    text: 'HTTP 回复',
    replyTargetId: 'ticket-hook',
  })
  const first = await inbox.enqueueReply({
    instanceId: instance.id,
    messageId: 'msg-http',
    replyId: 'reply-http-1',
    text: '第一次',
  })
  eq(first.duplicate, false)
  const dispatch1 = await inbox.dispatchReply({ instanceId: instance.id, replyId: 'reply-http-1' })
  eq(dispatch1.reply.status, 'failed')
  eq(dispatch1.reply.lastError.retryable, false, '网络异常不自动声称可重试（deliveryUnknown）')
  eq(dispatch1.reply.delivery.deliveryUnknown, true)

  const dispatch2 = await inbox.dispatchReply({ instanceId: instance.id, replyId: 'reply-http-1' })
  eq(dispatch2.reply.status, 'delivered')
  eq(dispatch2.reply.replyId, 'reply-http-1', '重试使用稳定 replyId')
  eq(dispatch2.reply.attempts, 2)
  ok(requests.length >= 2)
  const last = requests[requests.length - 1]
  eq(last.headers['idempotency-key'], 'reply-http-1', 'HTTP 幂等头')
  eq(JSON.parse(last.body).replyId, 'reply-http-1')
  await inbox.finishExecution({ instanceId: instance.id, executionId: 'exec-http' })
})

await check('CANCELED 停止未发送回复；COMPLETED 允许完成此前已受理回复', async () => {
  const instance = await makeInstance()
  const adapter = makeAdapter()
  const inbox = makeInbox({
    replyTargets: { 'operator-session': { kind: 'session', sessionId: 'approved-session' } },
    sessionDeliver: async () => ({ ok: true, deliveryUnknown: true }),
  })
  await inbox.registerExecution({
    instanceId: instance.id,
    activityId: 'agent1',
    executionId: 'exec-terminal',
    adapterId: 'dsh',
    adapter,
    handle: {},
    workspaceRoot,
  })
  await inbox.acceptInstanceMessage({
    instanceId: instance.id,
    messageId: 'msg-terminal',
    target: { activityId: 'agent1', executionId: 'exec-terminal' },
    text: '终态回复测试',
    replyTargetId: 'operator-session',
  })
  await inbox.enqueueReply({
    instanceId: instance.id,
    messageId: 'msg-terminal',
    replyId: 'reply-terminal-1',
    text: 'COMPLETED 后发送',
  })
  patchInstance(instance, { status: 'COMPLETED', pendingTasks: [] })
  const completed = await inbox.dispatchReply({ instanceId: instance.id, replyId: 'reply-terminal-1' })
  eq(completed.reply.status, 'delivered', 'COMPLETED 后可以完成此前已受理的回复')

  await inbox.enqueueReply({
    instanceId: instance.id,
    messageId: 'msg-terminal',
    replyId: 'reply-terminal-2',
    text: 'CANCELED 前已入队',
  })
  patchInstance(instance, { status: 'CANCELED' })
  const canceled = await inbox.dispatchReply({ instanceId: instance.id, replyId: 'reply-terminal-2' })
  eq(canceled.reply.status, 'skipped', 'CANCELED 停止未发送回复')
  eq(canceled.reply.delivery.reason, 'instance-canceled')
  // 已受理回复的重试仍是幂等结果，不因为终态变成新的 409。
  const canceledRetry = await inbox.enqueueReply({
    instanceId: instance.id,
    messageId: 'msg-terminal',
    replyId: 'reply-terminal-2',
    text: 'CANCELED 前已入队',
  })
  eq(canceledRetry.duplicate, true, 'CANCELED 后重试已受理回复幂等')
  await rejectsCode(() => inbox.enqueueReply({
    instanceId: instance.id,
    messageId: 'msg-terminal',
    text: '取消后新回复',
  }), 'MESSAGE_INSTANCE_TERMINAL')
})

await check('工具层跨实例调用被拒（agent 会话绑定身份）', async () => {
  // 用一个最小 runtime 门面验证 binding 在参数层就拦住，不触达 Host。
  const calls = []
  const runtime = {
    async handle(request) {
      calls.push(request)
      return { status: 200, body: { ok: true, id: request.parts[1], message: { messageId: 'x' }, delivery: null } }
    },
  }
  const [sendTool] = createInstanceTools({ runtime, binding: { instanceId: 'i-allowed' } })
    .filter(tool => tool.name === 'flow_instance_send_message')
  ok(sendTool, '找到绑定版发送工具')
  const rejected = await sendTool.execute({
    instanceId: 'i-other',
    messageId: 'msg-cross',
    target: { activityId: 'agent1', delivery: 'nextActivation' },
    text: '跨实例',
  })
  eq(rejected.ok, false)
  eq(calls.length, 0, '跨实例请求没有到达 runtime')
  const allowed = await sendTool.execute({
    messageId: 'msg-bound',
    target: { activityId: 'agent1', delivery: 'nextActivation' },
    text: '绑定实例',
  })
  eq(allowed.ok, true)
  eq(calls.length, 1)
  eq(calls[0].parts[1], 'i-allowed', '省略 instanceId 时落到绑定实例')
})

rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败 / ${checks + failures.length} 项`)
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error && failure.error.stack ? failure.error.stack : failure.error}`)
  process.exit(1)
}
console.log(`\n通过 ${checks} 项、${assertions} 个断言（instance-inbox）`)
