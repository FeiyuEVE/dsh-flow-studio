#!/usr/bin/env node
/**
 * 实例收件箱客户端自检（0.13.10 D）：
 *  - 客户端 API 的路径 / 查询串（列表、发送、正文、回复）；
 *  - 面板渲染：消息行 / 状态 / 预览 / 目标默认当前 live execution；
 *  - 发送：messageId 自动生成、精确目标、正文原样交给 Host；
 *  - 长正文只显示摘要，点「查看全文」走鉴权正文接口；
 *  - 实例终态时发送按钮禁用；
 *  - 失败文案保留服务端原因；
 *  - 0.13.11 N10–N13：切实例隔离消息/正文/草稿/通知（世代 + 请求序号），
 *    响应丢失后的重试复用 messageId，游标分页（>50 条 / 加载更多 / 新消息高亮），
 *    手选 exact 后执行消失可改发 nextActivation。
 *
 * 交互用最小 hooks 探针（真实 React createElement，hooks 同步可观测），不发真实 fetch。
 * 运行：node test/client-inbox.test.mjs
 */

import assert from 'node:assert/strict'

import React from 'react'

import {
  instanceMessageBodyPath, instanceMessageRepliesPath, instanceMessageSendPath, instanceMessagesPath,
} from '../src/client/api.js'
import {
  InstanceInboxPanel, inboxFailurePlan, messageStatusText, messageStatusTone, messageTargetText,
  shortTime, targetCandidates,
} from '../src/client/instance-inbox.js'
import { bindReact } from '../src/client/runtime.js'

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

function deep(actual, expected, message) {
  assertions += 1
  assert.deepEqual(actual, expected, message)
}

function ok(value, message) {
  assertions += 1
  assert.ok(value, message)
}

// ---------------------------------------------------------------------------
// 最小 hooks 探针
// ---------------------------------------------------------------------------

let currentRender = null

const probeReact = {
  createElement: React.createElement,
  useState(initial) { return currentRender.useState(initial) },
  useEffect(fn, deps) { return currentRender.useEffect(fn, deps) },
}
bindReact(probeReact)

function createHarness(Component, props) {
  const hooks = []
  const effectCache = new Map()
  let tree = null
  let needsRender = false
  let hookIndex = 0
  const renderProps = { ...props }

  const ctx = {
    useState(initial) {
      const index = hookIndex++
      if (!hooks[index]) hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      const hook = hooks[index]
      return [hook.value, next => {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (Object.is(value, hook.value)) return
        hook.value = value
        needsRender = true
      }]
    },
    useEffect(fn, deps) {
      const index = hookIndex++
      const previous = effectCache.get(index)
      const list = Array.isArray(deps) ? deps.slice() : null
      const changed = previous === undefined || previous.deps === null || list === null
        || previous.deps.length !== list.length || previous.deps.some((value, i) => !Object.is(value, list[i]))
      if (!changed) return
      // 与真实 React 一致：deps 变化先执行上一个 effect 的 cleanup，再登记新 effect。
      if (previous && typeof previous.cleanup === 'function') previous.cleanup()
      effectCache.set(index, { deps: list, cleanup: null })
      queueMicrotask(() => {
        const stored = effectCache.get(index)
        if (!stored) return
        try {
          const cleanup = fn()
          stored.cleanup = typeof cleanup === 'function' ? cleanup : null
        } catch (error) {
          stored.error = error
        }
      })
    },
  }

  function renderNode(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map(renderNode)
    if (typeof node.type === 'function') {
      hookIndex = 0
      const previous = currentRender
      currentRender = ctx
      try {
        return renderNode(node.type(node.props || {}))
      } finally {
        currentRender = previous
      }
    }
    const children = Array.isArray(node.props.children)
      ? node.props.children.map(renderNode)
      : [renderNode(node.props.children)]
    return { type: node.type, props: node.props, children: children.flat(Infinity) }
  }

  async function render() {
    needsRender = false
    tree = renderNode(React.createElement(Component, renderProps))
    await Promise.resolve()
  }

  async function flush(rounds = 4) {
    await render()
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve()
      if (needsRender) await render()
      else await Promise.resolve()
      await new Promise(resolveTick => setTimeout(resolveTick, 0))
      if (needsRender) await render()
    }
    return tree
  }

  return {
    flush,
    setProps(next) { Object.assign(renderProps, next); needsRender = true },
    get tree() { return tree },
  }
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) findAll(child, predicate, out)
  return out
}

function textOfNode(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOfNode).join('')
  return (node.children || []).map(textOfNode).join('')
}

function makeClient(options = {}) {
  const sent = []
  const bodyReads = []
  const messages = options.messages || [
    {
      messageId: 'ext-1',
      seq: 1,
      target: { activityId: 'agent1', executionId: 'exec-1' },
      replyTargetId: 'operator-session',
      bytes: 24,
      preview: '请补充兼容性说明。',
      body: { kind: 'inline', bytes: 24 },
      status: 'injected',
      delivery: { kind: 'agent', deliveryUnknown: true },
      createdAt: '2026-11-12T01:02:03.000Z',
    },
    {
      messageId: 'ext-2',
      seq: 2,
      target: { activityId: 'review', executionId: 'review_execution_1' },
      replyTargetId: null,
      bytes: 9000,
      preview: '很长的正文摘要…',
      body: { kind: 'file', path: 'inbox/bodies/ext-2.x.txt', sha256: 'c'.repeat(64), bytes: 9000 },
      status: 'queued',
      delivery: null,
      createdAt: '2026-11-12T01:03:03.000Z',
    },
  ]
  const liveExecutions = options.liveExecutions === undefined
    ? [{ activityId: 'agent1', executionId: 'exec-1', kind: 'agent', attempt: 1, adapter: 'dsh' }]
    : options.liveExecutions
  const client = {
    async readInstanceMessages(id) {
      return { ok: true, id, messages, total: messages.length, nextCursor: null, liveExecutions }
    },
    async readInstanceMessageBody(id, messageId) {
      bodyReads.push({ id, messageId })
      return { ok: true, id, messageId, text: '很长的正文全文\n第二行', bytes: 20, sha256: 'd'.repeat(64) }
    },
    async sendInstanceMessage(id, body) {
      sent.push({ id, body })
      return {
        ok: true,
        id,
        duplicate: false,
        message: { messageId: body.messageId, status: 'injected', preview: body.text.slice(0, 20) },
        delivery: { confirmed: [body.messageId], failed: [], remaining: 0 },
      }
    },
  }
  return { client, sent, bodyReads }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function inboxProps(client, overrides = {}) {
  return {
    client,
    instanceId: 'i-1',
    instanceStatus: 'ACTIVE',
    tasks: [],
    notice: () => {},
    onChanged: () => {},
    ...overrides,
  }
}

await check('客户端 API 路径与查询串', async () => {
  eq(instanceMessagesPath('i-1'), '/instances/i-1/messages')
  eq(instanceMessagesPath('i-1', { cursor: 7, limit: 20 }), '/instances/i-1/messages?cursor=7&limit=20')
  eq(instanceMessageSendPath('i-1'), '/instances/i-1/messages')
  eq(instanceMessageBodyPath('i-1', 'ext:1'), '/instances/i-1/messages/ext%3A1/body')
  eq(instanceMessageRepliesPath('i-1', 'ext-1'), '/instances/i-1/messages/ext-1/replies')
})

await check('纯函数：状态 / 目标文案 / 候选 / 失败分流', async () => {
  eq(messageStatusText('injected'), '已注入')
  eq(messageStatusText('weird'), 'weird', '未知状态原样展示')
  eq(messageStatusTone('failed'), 'error')
  eq(messageTargetText({ activityId: 'review', delivery: 'nextActivation' }), 'review · 下次激活')
  eq(messageTargetText({ activityId: 'agent1', executionId: 'exec-1' }), 'agent1 · exec-1')
  eq(shortTime('2026-11-12T01:02:03.000Z'), '2026-11-12 01:02:03')
  const candidates = targetCandidates(
    [{ activityId: 'agent1', executionId: 'exec-1', kind: 'agent' }],
    [{ activityId: 'human1', executionId: 'human_exec_1', name: '人工审批' }],
  )
  eq(candidates.length, 2)
  eq(candidates[0].label, '运行中 agent')
  eq(candidates[1].label, '人工审批')
  const expired = inboxFailurePlan('send', { status: 410, data: { code: 'MESSAGE_TARGET_EXPIRED', error: '目标已结束' } })
  eq(expired.kind, 'warn')
  ok(expired.text.includes('下次激活'))
  const conflict = inboxFailurePlan('send', { status: 409, data: { code: 'MESSAGE_ID_CONFLICT', error: '冲突' } })
  eq(conflict.kind, 'warn')
})

await check('面板渲染：消息行 / 状态 / 预览 / 默认目标', async () => {
  const { client } = makeClient()
  const harness = createHarness(InstanceInboxPanel, {
    client,
    instanceId: 'i-1',
    instanceStatus: 'ACTIVE',
    tasks: [],
    notice: () => {},
    onChanged: () => {},
  })
  const tree = await harness.flush()
  const rows = findAll(tree, node => node.props && node.props['data-message-id'] !== undefined)
  eq(rows.length, 2, '两条消息')
  eq(rows[0].props['data-message-id'], 'ext-1')
  eq(rows[0].props['data-message-status'], 'injected')
  ok(textOfNode(rows[0]).includes('请补充兼容性说明。'), '显示正文预览')
  ok(textOfNode(rows[0]).includes('已注入'), '显示状态')
  ok(textOfNode(rows[0]).includes('2026-11-12 01:02:03'), '显示时间')
  const select = findAll(tree, node => node.type === 'select')[0]
  ok(select, '有目标下拉（默认当前 live execution）')
  eq(select.props.value, 'exec-1')
  const options = findAll(select, node => node.type === 'option')
  ok(textOfNode(options[0]).includes('agent1'), '选项带节点 id')
  const viewButtons = findAll(tree, node => node.props && node.props['data-action'] === 'inbox-view-body')
  eq(viewButtons.length, 1, '只有长正文显示「查看全文」')
})

await check('发送：精确目标 + 自动 messageId + 正文原样交给 Host', async () => {
  const { client, sent } = makeClient()
  const notices = []
  const harness = createHarness(InstanceInboxPanel, {
    client,
    instanceId: 'i-1',
    instanceStatus: 'ACTIVE',
    tasks: [],
    notice: (kind, text) => notices.push({ kind, text }),
    onChanged: () => {},
  })
  let tree = await harness.flush()
  const draft = findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0]
  draft.props.onInput({ target: { value: '请补充兼容性说明。' } })
  tree = await harness.flush()
  const send = findAll(tree, node => node.props && node.props['data-action'] === 'inbox-send')[0]
  eq(send.props.disabled, false, '有正文时可以发送')
  send.props.onClick()
  tree = await harness.flush()
  eq(sent.length, 1)
  eq(sent[0].id, 'i-1')
  ok(sent[0].body.messageId.startsWith('ui-'), '自动生成 UI messageId')
  deep(sent[0].body.target, { activityId: 'agent1', executionId: 'exec-1' })
  eq(sent[0].body.text, '请补充兼容性说明。')
  eq(notices.some(item => item.kind === 'success'), true, '发送成功给 notice')
  const afterDraft = findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0]
  eq(afterDraft.props.value, '', '发送后清空输入框')
})

await check('长正文：查看全文走鉴权正文接口', async () => {
  const { client, bodyReads } = makeClient()
  const harness = createHarness(InstanceInboxPanel, {
    client,
    instanceId: 'i-1',
    instanceStatus: 'ACTIVE',
    tasks: [],
    notice: () => {},
    onChanged: () => {},
  })
  let tree = await harness.flush()
  const view = findAll(tree, node => node.props && node.props['data-action'] === 'inbox-view-body')[0]
  view.props.onClick()
  tree = await harness.flush(6)
  eq(bodyReads.length, 1)
  eq(bodyReads[0].messageId, 'ext-2')
  const pre = findAll(tree, node => node.type === 'pre')[0]
  ok(pre, '正文查看区出现')
  ok(textOfNode(pre).includes('很长的正文全文'), '显示接口返回的全文')
})

await check('终态实例：发送按钮禁用', async () => {
  const { client, sent } = makeClient()
  const harness = createHarness(InstanceInboxPanel, {
    client,
    instanceId: 'i-1',
    instanceStatus: 'COMPLETED',
    tasks: [],
    notice: () => {},
    onChanged: () => {},
  })
  let tree = await harness.flush()
  const draft = findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0]
  draft.props.onInput({ target: { value: '终态消息' } })
  tree = await harness.flush()
  const send = findAll(tree, node => node.props && node.props['data-action'] === 'inbox-send')[0]
  eq(send.props.disabled, true, 'COMPLETED 不能发送')
  send.props.onClick()
  await harness.flush()
  eq(sent.length, 0)
  ok(textOfNode(tree).includes('实例已结束'), '给出终态提示')
})

await check('没有活执行：默认「下次激活」目标', async () => {
  const { client, sent } = makeClient({ liveExecutions: [] })
  const harness = createHarness(InstanceInboxPanel, {
    client,
    instanceId: 'i-1',
    instanceStatus: 'ACTIVE',
    tasks: [],
    notice: () => {},
    onChanged: () => {},
  })
  let tree = await harness.flush()
  const input = findAll(tree, node => node.props && node.props['aria-label'] === '未来激活的节点 id')[0]
  ok(input, '显示未来激活节点输入框')
  input.props.onInput({ target: { value: 'review' } })
  const draft = findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0]
  draft.props.onInput({ target: { value: '给下一轮' } })
  tree = await harness.flush()
  const send = findAll(tree, node => node.props && node.props['data-action'] === 'inbox-send')[0]
  send.props.onClick()
  await harness.flush()
  eq(sent.length, 1)
  deep(sent[0].body.target, { activityId: 'review', delivery: 'nextActivation' })
})

// ---------------------------------------------------------------------------
// 0.13.11 复审 N10–N13 回归
// ---------------------------------------------------------------------------

await check('N10：切实例后旧消息/正文/草稿不显示，迟到响应被丢弃', async () => {
  const pendingB = deferred()
  const pendingBody = deferred()
  const pendingSend = deferred()
  let bLoaded = false
  const notices = []
  const sends = []
  const rowA = {
    messageId: 'a-secret',
    seq: 1,
    target: { activityId: 'a-node', executionId: 'a-exec' },
    bytes: 5000,
    preview: 'A 的机密消息',
    body: { kind: 'file' },
    status: 'queued',
    createdAt: '2026-11-12T01:00:00.000Z',
  }
  const client = {
    async readInstanceMessages(id) {
      if (id === 'A') {
        return {
          messages: [rowA], total: 1, nextCursor: null,
          liveExecutions: [{ activityId: 'a-node', executionId: 'a-exec' }],
        }
      }
      return bLoaded ? { messages: [], total: 0, nextCursor: null, liveExecutions: [] } : pendingB.promise
    },
    async readInstanceMessageBody() { return pendingBody.promise },
    async sendInstanceMessage(id, body) {
      sends.push({ id, body })
      if (id === 'A') return pendingSend.promise
      return { ok: true, message: { messageId: 'from-B', status: 'queued' }, delivery: { confirmed: ['from-B'], failed: [] } }
    },
  }
  const harness = createHarness(InstanceInboxPanel, inboxProps(client, {
    instanceId: 'A',
    notice: (kind, text) => notices.push({ kind, text }),
  }))
  let tree = await harness.flush()
  eq(findAll(tree, node => node.props && node.props['data-message-id'] === 'a-secret').length, 1, 'A 的消息可见')

  findAll(tree, node => node.props && node.props['data-action'] === 'inbox-view-body')[0].props.onClick()
  tree = await harness.flush()
  findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0]
    .props.onInput({ target: { value: '发给 A 的草稿' } })
  tree = await harness.flush()
  findAll(tree, node => node.props && node.props['data-action'] === 'inbox-send')[0].props.onClick()
  await harness.flush()
  eq(sends.length, 1, 'A 的发送已发出')

  harness.setProps({ instanceId: 'B' })
  tree = await harness.flush()
  eq(findAll(tree, node => node.props && node.props['data-message-id'] === 'a-secret').length, 0, 'B 不显示 A 的消息行')
  eq(textOfNode(tree).includes('A 的机密消息'), false, 'B 不显示 A 的摘要')
  eq(textOfNode(tree).includes('A 的机密正文'), false, 'B 不显示 A 的正文')
  eq(findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0].props.value, '', 'B 不显示 A 的草稿')

  // 迟到的旧实例响应（正文 / 发送结果）一律丢弃，不写状态、不通知。
  pendingBody.resolve({ text: 'A 的机密正文' })
  pendingSend.resolve({ ok: true, message: { messageId: 'from-A', status: 'queued' }, delivery: { confirmed: [], failed: [] } })
  tree = await harness.flush()
  eq(textOfNode(tree).includes('A 的机密正文'), false, '迟到的 A 正文不显示')
  eq(notices.some(item => item.text.includes('from-A')), false, '迟到的 A 发送结果不通知')

  // B 自己发送时只带 B 的草稿与目标。
  findAll(tree, node => node.props && node.props['aria-label'] === '未来激活的节点 id')[0]
    .props.onInput({ target: { value: 'b-next' } })
  findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0]
    .props.onInput({ target: { value: '发给 B 的草稿' } })
  bLoaded = true
  pendingB.resolve({ messages: [], total: 0, nextCursor: null, liveExecutions: [] })
  tree = await harness.flush()
  findAll(tree, node => node.props && node.props['data-action'] === 'inbox-send')[0].props.onClick()
  await harness.flush()
  eq(sends.length, 2, 'B 的发送已发出')
  eq(sends[1].id, 'B')
  eq(sends[1].body.text, '发给 B 的草稿', 'B 发送不携带 A 的草稿')
  deep(sends[1].body.target, { activityId: 'b-next', delivery: 'nextActivation' })

  // 切回 A：之前的状态已重置，迟到的正文/草稿不会复活。
  harness.setProps({ instanceId: 'A' })
  tree = await harness.flush()
  eq(findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0].props.value, '', '切回 A 不复用旧草稿')
  eq(textOfNode(tree).includes('A 的机密正文'), false, '切回 A 不残留已读正文')
})

await check('N10：同实例切走再切回，迟到列表响应按请求序号丢弃', async () => {
  const firstA = deferred()
  const secondA = deferred()
  const bLoad = deferred()
  let aCalls = 0
  const client = {
    async readInstanceMessages(id) {
      if (id === 'A') {
        aCalls += 1
        return aCalls === 1 ? firstA.promise : secondA.promise
      }
      return bLoad.promise
    },
  }
  const harness = createHarness(InstanceInboxPanel, inboxProps(client, { instanceId: 'A' }))
  await harness.flush()
  harness.setProps({ instanceId: 'B' })
  await harness.flush()
  harness.setProps({ instanceId: 'A' })
  await harness.flush()

  secondA.resolve({
    messages: [{ messageId: 'a-second', seq: 1, target: {}, preview: '第二次', status: 'queued' }],
    total: 1, nextCursor: null, liveExecutions: [],
  })
  let tree = await harness.flush()
  eq(findAll(tree, node => node.props && node.props['data-message-id'] === 'a-second').length, 1, '第二次 A 请求生效')

  firstA.resolve({
    messages: [{ messageId: 'a-first', seq: 1, target: {}, preview: '第一次', status: 'queued' }],
    total: 1, nextCursor: null, liveExecutions: [],
  })
  tree = await harness.flush()
  eq(findAll(tree, node => node.props && node.props['data-message-id'] === 'a-first').length, 0, '同一实例的迟到响应被请求序号拒绝')
  eq(findAll(tree, node => node.props && node.props['data-message-id'] === 'a-second').length, 1)

  bLoad.resolve({
    messages: [{ messageId: 'b-late', seq: 1, target: {}, preview: 'B 迟到', status: 'queued' }],
    total: 1, nextCursor: null, liveExecutions: [],
  })
  tree = await harness.flush()
  eq(findAll(tree, node => node.props && node.props['data-message-id'] === 'b-late').length, 0, '离开 B 后迟到的 B 响应被世代拒绝')
})

await check('N11：响应丢失后的重试复用同一 messageId 与内容', async () => {
  const attempts = []
  let loseFirst = true
  const client = {
    async readInstanceMessages() {
      return {
        messages: [], total: 0, nextCursor: null,
        liveExecutions: [
          { activityId: 'node', executionId: 'exec-1', kind: 'agent' },
          { activityId: 'node2', executionId: 'exec-2', kind: 'agent' },
        ],
      }
    },
    async sendInstanceMessage(id, body) {
      attempts.push({ id, body })
      if (loseFirst) {
        loseFirst = false
        // 模拟「Host 已受理但响应丢失」：请求失败，客户端不知道结果。
        throw new Error('connection lost after accept')
      }
      return {
        ok: true, duplicate: false,
        message: { messageId: body.messageId, status: 'injected' },
        delivery: { confirmed: [body.messageId], failed: [] },
      }
    },
  }
  const harness = createHarness(InstanceInboxPanel, inboxProps(client))
  let tree = await harness.flush()
  findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0]
    .props.onInput({ target: { value: '同一条消息' } })
  tree = await harness.flush()
  findAll(tree, node => node.props && node.props['data-action'] === 'inbox-send')[0].props.onClick()
  tree = await harness.flush()
  eq(attempts.length, 1)
  eq(findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0].props.value, '同一条消息', '失败后保留草稿')

  findAll(tree, node => node.props && node.props['data-action'] === 'inbox-send')[0].props.onClick()
  tree = await harness.flush()
  eq(attempts.length, 2)
  eq(attempts[1].body.messageId, attempts[0].body.messageId, '重试复用同一个 messageId')
  eq(attempts[1].body.text, attempts[0].body.text, '重试复用同一份内容')
  deep(attempts[1].body.target, attempts[0].body.target, '重试复用同一个目标')

  // 改目标 → 新 messageId。
  const select = findAll(tree, node => node.type === 'select')[0]
  select.props.onChange({ target: { value: 'exec-2' } })
  tree = await harness.flush()
  findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0]
    .props.onInput({ target: { value: '改目标后的消息' } })
  tree = await harness.flush()
  findAll(tree, node => node.props && node.props['data-action'] === 'inbox-send')[0].props.onClick()
  tree = await harness.flush()
  eq(attempts.length, 3)
  ok(attempts[2].body.messageId !== attempts[0].body.messageId, '目标改变后换新 messageId')

  // 改正文 → 新 messageId。
  const firstEditedId = attempts[2].body.messageId
  findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0]
    .props.onInput({ target: { value: '又改了一次正文' } })
  tree = await harness.flush()
  findAll(tree, node => node.props && node.props['data-action'] === 'inbox-send')[0].props.onClick()
  await harness.flush()
  eq(attempts.length, 4)
  ok(attempts[3].body.messageId !== firstEditedId, '正文改变后换新 messageId')
})

await check('N12：游标分页加载全部消息，不截断到 50 条', async () => {
  const all = Array.from({ length: 130 }, (_, index) => ({
    messageId: `m-${index + 1}`,
    seq: index + 1,
    target: { activityId: 'node', delivery: 'nextActivation' },
    bytes: 0,
    body: { kind: 'inline', bytes: 0 },
    preview: `第 ${index + 1} 条`,
    status: 'queued',
    createdAt: '',
  }))
  const requests = []
  const client = {
    async readInstanceMessages(id, options = {}) {
      requests.push({ ...options })
      const cursor = Number.isSafeInteger(options.cursor) ? options.cursor : 0
      const limit = Number.isSafeInteger(options.limit) ? options.limit : 50
      const page = all.filter(item => item.seq > cursor).slice(0, limit)
      const last = page.length > 0 ? page[page.length - 1].seq : cursor
      return {
        messages: page,
        total: all.length,
        nextCursor: last < all.length ? last : null,
        liveExecutions: [],
      }
    },
  }
  const harness = createHarness(InstanceInboxPanel, inboxProps(client, { instanceId: 'P' }))
  const tree = await harness.flush()
  eq(findAll(tree, node => node.props && node.props['data-message-id'] !== undefined).length, 130, '130 条全部可见')
  eq(findAll(tree, node => node.props && node.props['data-message-id'] === 'm-130').length, 1, '最后一条也可见')
  ok(requests.length >= 2, '按 nextCursor 继续拉取')
  eq(requests[0].limit, 100, '首屏带 limit')
  eq(requests[1].cursor, 100, '翻页请求带 cursor')
  eq(requests[1].limit, 100)
  ok(textOfNode(tree).includes('130'), '总条数可见')
})

await check('N12：超过自动加载上限时「加载更多」带 cursor 且能继续', async () => {
  const all = Array.from({ length: 1200 }, (_, index) => ({
    messageId: `n-${index + 1}`,
    seq: index + 1,
    target: { activityId: 'node', delivery: 'nextActivation' },
    bytes: 0,
    body: { kind: 'inline', bytes: 0 },
    preview: `第 ${index + 1} 条`,
    status: 'queued',
    createdAt: '',
  }))
  const requests = []
  const client = {
    async readInstanceMessages(id, options = {}) {
      requests.push({ ...options })
      const cursor = Number.isSafeInteger(options.cursor) ? options.cursor : 0
      const limit = Number.isSafeInteger(options.limit) ? options.limit : 50
      const page = all.filter(item => item.seq > cursor).slice(0, limit)
      const last = page.length > 0 ? page[page.length - 1].seq : cursor
      return {
        messages: page,
        total: all.length,
        nextCursor: last < all.length ? last : null,
        liveExecutions: [],
      }
    },
  }
  const harness = createHarness(InstanceInboxPanel, inboxProps(client, { instanceId: 'Q' }))
  let tree = await harness.flush()
  const initialRows = findAll(tree, node => node.props && node.props['data-message-id'] !== undefined).length
  ok(initialRows > 50, `首屏超过 50 条（实际 ${initialRows}）`)
  const more = findAll(tree, node => node.props && node.props['data-action'] === 'inbox-load-more')[0]
  ok(more, '达到自动加载上限后提供「加载更多」')
  more.props.onClick()
  tree = await harness.flush(8)
  ok(requests.some(item => item.cursor === initialRows), '「加载更多」请求带 cursor')
  eq(findAll(tree, node => node.props && node.props['data-message-id'] !== undefined).length, 1200, '继续加载后全部可见')
  eq(findAll(tree, node => node.props && node.props['data-action'] === 'inbox-load-more').length, 0, '没有更多时按钮消失')
})

await check('N12：发送成功后重新拉取并高亮新消息', async () => {
  const rows = []
  const client = {
    async readInstanceMessages() {
      return {
        messages: rows.slice(), total: rows.length, nextCursor: null,
        liveExecutions: [{ activityId: 'node', executionId: 'e1', kind: 'agent' }],
      }
    },
    async sendInstanceMessage(id, body) {
      rows.push({
        messageId: body.messageId,
        seq: rows.length + 1,
        target: body.target,
        bytes: 0,
        body: { kind: 'inline', bytes: 0 },
        preview: body.text.slice(0, 12),
        status: 'injected',
        createdAt: '',
      })
      return {
        ok: true, duplicate: false,
        message: { messageId: body.messageId, status: 'injected' },
        delivery: { confirmed: [body.messageId], failed: [] },
      }
    },
  }
  const harness = createHarness(InstanceInboxPanel, inboxProps(client))
  let tree = await harness.flush()
  eq(findAll(tree, node => node.props && node.props['data-message-id'] !== undefined).length, 0)
  findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0]
    .props.onInput({ target: { value: '新消息' } })
  tree = await harness.flush()
  findAll(tree, node => node.props && node.props['data-action'] === 'inbox-send')[0].props.onClick()
  tree = await harness.flush()
  const row = findAll(tree, node => node.props && node.props['data-message-id'] !== undefined)[0]
  ok(row, '发送成功后重新拉取到新消息')
  eq(row.props['data-message-focus'], 'true', '新消息被标记')
  ok(String(row.props.className).includes('fs-inbox-row-focus'), '新消息高亮')
})

await check('N13：精确目标消失后自动回退到下次激活并可发送', async () => {
  let live = [{ activityId: 'node', executionId: 'e1', kind: 'agent' }]
  const sent = []
  const client = {
    async readInstanceMessages() { return { messages: [], total: 0, nextCursor: null, liveExecutions: live } },
    async sendInstanceMessage(id, body) {
      sent.push({ id, body })
      return { ok: true, message: { messageId: body.messageId, status: 'queued' }, delivery: { confirmed: [], failed: [] } }
    },
  }
  const harness = createHarness(InstanceInboxPanel, inboxProps(client, { instanceId: 'M' }))
  let tree = await harness.flush()
  findAll(tree, node => node.type === 'select')[0].props.onChange({ target: { value: 'e1' } })
  findAll(tree, node => node.props && node.props['aria-label'] === '消息正文')[0]
    .props.onInput({ target: { value: '发给下一轮' } })
  tree = await harness.flush()

  live = []
  findAll(tree, node => node.props && node.props['data-action'] === 'inbox-refresh')[0].props.onClick()
  tree = await harness.flush()
  const nextInput = findAll(tree, node => node.props && node.props['aria-label'] === '未来激活的节点 id')[0]
  ok(nextInput, '执行消失后显示「下次激活」输入框')
  nextInput.props.onInput({ target: { value: 'next' } })
  tree = await harness.flush()
  const send = findAll(tree, node => node.props && node.props['data-action'] === 'inbox-send')[0]
  eq(send.props.disabled, false, '有效 nextActivation 目标可发送')
  ok(textOfNode(tree).includes('已自动改发'), '说明已回退到下次激活')
  send.props.onClick()
  await harness.flush()
  eq(sent.length, 1)
  deep(sent[0].body.target, { activityId: 'next', delivery: 'nextActivation' })
})

await check('N13：目标模式可显式切换（当前执行 ↔ 下次激活）', async () => {
  const client = {
    async readInstanceMessages() {
      return {
        messages: [], total: 0, nextCursor: null,
        liveExecutions: [{ activityId: 'node', executionId: 'e1', kind: 'agent' }],
      }
    },
    async sendInstanceMessage(id, body) {
      return { ok: true, message: { messageId: body.messageId, status: 'queued' }, delivery: { confirmed: [], failed: [] } }
    },
  }
  const harness = createHarness(InstanceInboxPanel, inboxProps(client))
  let tree = await harness.flush()
  eq(findAll(tree, node => node.type === 'select').length, 1, '默认按当前执行选目标')
  findAll(tree, node => node.props && node.props['data-action'] === 'inbox-mode-next')[0].props.onClick()
  tree = await harness.flush()
  eq(findAll(tree, node => node.type === 'select').length, 0, '切到下次激活后不再显示执行下拉')
  ok(findAll(tree, node => node.props && node.props['aria-label'] === '未来激活的节点 id')[0], '显示下次激活输入框')
  findAll(tree, node => node.props && node.props['data-action'] === 'inbox-mode-exact')[0].props.onClick()
  tree = await harness.flush()
  eq(findAll(tree, node => node.type === 'select').length, 1, '可以切回当前执行')
})

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败 / ${checks + failures.length} 项`)
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error && failure.error.stack ? failure.error.stack : failure.error}`)
  process.exit(1)
}
console.log(`\n通过 ${checks} 项、${assertions} 个断言（client-inbox）`)
