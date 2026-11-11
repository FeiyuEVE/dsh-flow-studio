#!/usr/bin/env node
/**
 * 实例收件箱客户端自检（0.13.10 D）：
 *  - 客户端 API 的路径 / 查询串（列表、发送、正文、回复）；
 *  - 面板渲染：消息行 / 状态 / 预览 / 目标默认当前 live execution；
 *  - 发送：messageId 自动生成、精确目标、正文原样交给 Host；
 *  - 长正文只显示摘要，点「查看全文」走鉴权正文接口；
 *  - 实例终态时发送按钮禁用；
 *  - 失败文案保留服务端原因。
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
    tree = renderNode(React.createElement(Component, props))
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

  return { flush, get tree() { return tree } }
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

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败 / ${checks + failures.length} 项`)
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error && failure.error.stack ? failure.error.stack : failure.error}`)
  process.exit(1)
}
console.log(`\n通过 ${checks} 项、${assertions} 个断言（client-inbox）`)
