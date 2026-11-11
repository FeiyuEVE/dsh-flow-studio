/**
 * 实例收件箱面板（0.13.10 D）。
 *
 * 实例详情里的「消息」区：
 *   - 列出消息（状态 / 目标 / 时间 / 正文预览）；长正文只显示摘要，点「查看全文」
 *     走鉴权正文接口，不在列表里铺 1 MiB；
 *   - 输入框发送消息；目标默认当前激活的 agent / 人工任务（来自
 *     `GET /instances/<id>/messages` 的 `liveExecutions` 与实例待办），
 *     没有活执行时退化为「下次激活」目标；
 *   - 发送成功只表示「已受理」；投递状态以消息行的 status / delivery 为准，
 *     不能把「已受理」当成 agent 已读。
 *
 * @module @feiyueve/dsh-flow-studio/client/instance-inbox
 */

import { api } from './api.js'
import { h, rt } from './runtime.js'

/** 消息状态 → 中文。 */
export const MESSAGE_STATUS_TEXT = Object.freeze({
  queued: '排队中',
  injected: '已注入',
  resumed: '已恢复投递',
  delivered: '已送达',
  failed: '失败',
})

/** 消息状态 → 语义色档（复用 fs-status-chip 的 tone）。 */
const STATUS_TONE = Object.freeze({
  queued: 'warn',
  injected: 'business',
  resumed: 'success',
  delivered: 'success',
  failed: 'error',
})

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 状态文案；未知状态原样展示，不猜。 */
export function messageStatusText(status) {
  const key = textOf(status)
  if (key === '') return '未知'
  return MESSAGE_STATUS_TEXT[key] || key
}

/** 状态色档。 */
export function messageStatusTone(status) {
  return STATUS_TONE[textOf(status)] || 'warn'
}

/** 目标文案：精确目标 vs 下次激活。 */
export function messageTargetText(target) {
  if (!isObject(target)) return '—'
  const activityId = textOf(target.activityId) || '?'
  if (target.delivery === 'nextActivation') return `${activityId} · 下次激活`
  const executionId = textOf(target.executionId)
  if (executionId === '') return activityId
  return `${activityId} · ${executionId.length > 28 ? executionId.slice(0, 28) + '…' : executionId}`
}

/** ISO 时间 → 稳定的短格式（不依赖浏览器 locale）。 */
export function shortTime(value) {
  const text = textOf(value)
  if (text === '') return '—'
  return text.replace('T', ' ').slice(0, 19)
}

/** 失败计划：保留服务端原因，区分「已受理但投递失败」与「请求被拒」。 */
export function inboxFailurePlan(action, error) {
  const status = isObject(error) && Number.isInteger(error.status) ? error.status : 0
  const data = isObject(error) && isObject(error.data) ? error.data : null
  const server = data && typeof data.error === 'string' ? data.error.trim() : ''
  const code = (data && typeof data.code === 'string' ? data.code : '')
    || (isObject(error) && typeof error.code === 'string' ? error.code : '')
  const prefix = action === 'send' ? '发送消息失败：' : action === 'body' ? '读取正文失败：' : '读取消息失败：'
  const base = prefix + (server || (error && typeof error.message === 'string' ? error.message : '未知错误'))
  if (code === 'MESSAGE_TARGET_EXPIRED' || status === 410) {
    return { kind: 'warn', text: `${base}。目标执行已结束，要发给未来激活请选「下次激活」。` }
  }
  if (code === 'MESSAGE_ID_CONFLICT' || status === 409) {
    return { kind: 'warn', text: `${base}。刷新列表后重试；同一 messageId 不能改内容。` }
  }
  if (status === 413) return { kind: 'warn', text: `${base}。正文超过 1 MiB，请缩短。` }
  if (status === 0) return { kind: 'error', text: `${base}（连不上 Host）。` }
  return { kind: 'error', text: `${base}。` }
}

/**
 * 发送目标候选：活执行优先，其次当前人工待办。
 *
 * @param {object[]} liveExecutions
 * @param {object[]} tasks
 * @returns {Array<{activityId: string, executionId: string, kind: string, label: string}>}
 */
export function targetCandidates(liveExecutions, tasks) {
  const out = []
  const seen = new Set()
  const push = (activityId, executionId, kind, label) => {
    if (activityId === '' || executionId === '' || seen.has(executionId)) return
    seen.add(executionId)
    out.push({ activityId, executionId, kind, label })
  }
  for (const entry of Array.isArray(liveExecutions) ? liveExecutions : []) {
    if (!isObject(entry)) continue
    const kind = entry.kind === 'human' ? 'human' : 'agent'
    push(textOf(entry.activityId), textOf(entry.executionId), kind, kind === 'human' ? '人工任务' : '运行中 agent')
  }
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!isObject(task)) continue
    const name = textOf(task.name)
    push(textOf(task.activityId), textOf(task.executionId), 'human', name === '' ? '人工待办' : name)
  }
  return out
}

function messageIdForUi() {
  const stamp = Date.now().toString(36)
  const salt = Math.random().toString(36).slice(2, 8)
  return `ui-${stamp}-${salt}`
}

/** `error.data.error` 优先；没有就给通用文案。 */
function errorTextOf(error) {
  return inboxFailurePlan('list', error).text
}

/**
 * @param {{
 *   client?: object,          // 默认全局 api；测试可注入桩
 *   instanceId?: string,
 *   instanceStatus?: string,
 *   tasks?: object[],
 *   notice?: (kind: string, text: string) => void,
 *   onChanged?: () => void,
 * }} props
 */
export function InstanceInboxPanel(props = {}) {
  const React = rt.React
  const { useEffect, useState } = React
  const client = props.client && typeof props.client.readInstanceMessages === 'function' ? props.client : api
  const instanceId = textOf(props.instanceId)
  const status = textOf(props.instanceStatus).toUpperCase()
  const tasks = Array.isArray(props.tasks) ? props.tasks : []
  const notice = typeof props.notice === 'function' ? props.notice : () => {}
  const onChanged = typeof props.onChanged === 'function' ? props.onChanged : () => {}

  const [payload, setPayload] = useState(null)
  const [loading, setLoading] = useState(instanceId !== '')
  const [listError, setListError] = useState('')
  const [reloadTick, setReloadTick] = useState(0)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [mode, setMode] = useState('auto')
  const [nextActivityId, setNextActivityId] = useState('')
  const [selectedExecutionId, setSelectedExecutionId] = useState('')
  const [bodyView, setBodyView] = useState(null)
  const [bodyTick, setBodyTick] = useState(0)

  useEffect(() => {
    if (instanceId === '') {
      setPayload(null)
      setLoading(false)
      setListError('')
      return undefined
    }
    let cancelled = false
    setLoading(true)
    setListError('')
    client.readInstanceMessages(instanceId).then(data => {
      if (cancelled) return
      setPayload(isObject(data) ? data : null)
      setLoading(false)
    }, error => {
      if (cancelled) return
      setLoading(false)
      const plan = inboxFailurePlan('list', error)
      setListError(plan.text)
      notice(plan.kind, plan.text)
    })
    return () => { cancelled = true }
  }, [client, instanceId, reloadTick])

  useEffect(() => {
    if (bodyView === null || bodyView.text !== undefined || bodyView.loading === true) return undefined
    let cancelled = false
    const messageId = bodyView.messageId
    setBodyView(current => (current && current.messageId === messageId ? { ...current, loading: true } : current))
    client.readInstanceMessageBody(instanceId, messageId).then(data => {
      if (cancelled) return
      setBodyView({ messageId, text: typeof data?.text === 'string' ? data.text : '' })
    }, error => {
      if (cancelled) return
      const plan = inboxFailurePlan('body', error)
      setBodyView({ messageId, error: plan.text })
      notice(plan.kind, plan.text)
    })
    return () => { cancelled = true }
  }, [client, instanceId, bodyView === null ? '' : bodyView.messageId, bodyTick])

  const messages = isObject(payload) && Array.isArray(payload.messages) ? payload.messages : []
  const live = isObject(payload) && Array.isArray(payload.liveExecutions) ? payload.liveExecutions : []
  const candidates = targetCandidates(live, tasks)
  const effectiveMode = mode === 'auto' ? (candidates.length > 0 ? 'exact' : 'next') : mode
  const selected = candidates.find(item => item.executionId === selectedExecutionId) || candidates[0] || null
  const sendable = status !== 'COMPLETED' && status !== 'CANCELED'
    && draft.trim() !== '' && !sending && instanceId !== ''
    && (effectiveMode === 'exact' ? selected !== null : nextActivityId.trim() !== '')

  async function send() {
    if (!sendable) return
    setSending(true)
    const messageId = messageIdForUi()
    const target = effectiveMode === 'exact'
      ? { activityId: selected.activityId, executionId: selected.executionId }
      : { activityId: nextActivityId.trim(), delivery: 'nextActivation' }
    try {
      const data = await client.sendInstanceMessage(instanceId, { messageId, target, text: draft })
      const message = isObject(data) && isObject(data.message) ? data.message : {}
      const delivery = isObject(data) && isObject(data.delivery) ? data.delivery : null
      const failed = delivery && Array.isArray(delivery.failed) ? delivery.failed.length : 0
      const confirmed = delivery && Array.isArray(delivery.confirmed) ? delivery.confirmed.length : 0
      if (failed > 0) {
        notice('warn', `消息已受理，但投递失败 ${failed} 条（状态以列表为准）。`)
      } else if (data?.duplicate === true) {
        notice('info', `消息 ${message.messageId || messageId} 已存在，返回原受理结果。`)
      } else if (delivery?.deferred === true) {
        notice('info', '实例已挂起：消息已排队，恢复后才会投递。')
      } else {
        notice('success', `消息 ${message.messageId || messageId} 已受理（状态 ${messageStatusText(message.status)}）`
          + `${confirmed > 0 ? `，本次确认投递 ${confirmed} 条` : ''}。`)
      }
      setDraft('')
      setReloadTick(tick => tick + 1)
      onChanged()
    } catch (error) {
      const plan = inboxFailurePlan('send', error)
      notice(plan.kind, plan.text)
    } finally {
      setSending(false)
    }
  }

  function refresh() {
    setReloadTick(tick => tick + 1)
  }

  const sendHint = status === 'COMPLETED' || status === 'CANCELED'
    ? '实例已结束：不再受理新消息。'
    : candidates.length === 0
      ? '当前没有活执行：默认发给节点的下一次激活。'
      : `将发给当前 ${effectiveMode === 'exact' ? selected.label : '节点下次激活'}。`

  return h('section', {
    className: 'fs-inbox',
    'aria-label': '实例消息',
    'data-inbox-instance': instanceId,
  },
  h('div', { className: 'fs-inbox-head' },
    h('strong', null, '消息'),
    h('button', {
      type: 'button', className: 'fs-btn sm ghost',
      disabled: !instanceId || loading || sending,
      'data-action': 'inbox-refresh',
      onClick: refresh,
      title: '重新读取消息列表（只读，不启动 runner）',
    }, loading ? '读取中…' : '刷新')),

  listError !== ''
    ? h('p', { className: 'fs-inbox-error', role: 'alert', 'data-inbox-error': 'true' }, listError)
    : null,

  messages.length === 0
    ? h('p', { className: 'fs-inbox-empty' }, instanceId === '' ? '选中实例后显示它的消息。' : '还没有消息。')
    : h('ul', { className: 'fs-inbox-rows', 'data-inbox-count': String(messages.length) },
      messages.slice(0, 50).map(message => {
        const messageId = textOf(message.messageId)
        const body = isObject(message.body) ? message.body : {}
        const long = body.kind === 'file' || (Number.isInteger(message.bytes) && message.bytes > 4096)
        return h('li', {
          key: messageId || String(message.seq),
          className: 'fs-inbox-row',
          'data-message-id': messageId,
          'data-message-status': textOf(message.status),
        },
        h('div', { className: 'fs-inbox-row-head' },
          h('span', { className: 'fs-status-chip ' + messageStatusTone(message.status) }, messageStatusText(message.status)),
          h('span', { className: 'fs-inbox-row-id' }, messageId || '?'),
          h('span', { className: 'fs-inbox-row-time' }, shortTime(message.createdAt))),
        h('div', { className: 'fs-inbox-row-target' }, messageTargetText(message.target)),
        h('p', { className: 'fs-inbox-preview' }, textOf(message.preview) || '（无正文摘要）'),
        long
          ? h('button', {
            type: 'button', className: 'fs-btn sm ghost',
            'data-action': 'inbox-view-body',
            onClick: () => {
              setBodyView({ messageId })
              setBodyTick(tick => tick + 1)
            },
          }, '查看全文' + (Number.isInteger(message.bytes) ? `（${message.bytes} 字节）` : ''))
          : null)
      })),

  bodyView !== null
    ? h('div', { className: 'fs-inbox-body-view', 'data-inbox-body-for': bodyView.messageId },
      h('div', { className: 'fs-inbox-row-head' },
        h('strong', null, `正文 ${bodyView.messageId}`),
        h('button', {
          type: 'button', className: 'fs-btn sm ghost',
          onClick: () => setBodyView(null),
        }, '收起')),
      bodyView.error !== undefined
        ? h('p', { className: 'fs-inbox-error', role: 'alert' }, bodyView.error)
        : bodyView.text === undefined
          ? h('p', { className: 'fs-inbox-empty' }, '读取中…')
          : h('pre', { className: 'fs-inbox-body-text' }, bodyView.text))
    : null,

  h('div', { className: 'fs-inbox-compose' },
    h('p', { className: 'fs-inbox-hint' }, sendHint),
    candidates.length > 0
      ? h('select', {
        className: 'fs-inbox-target',
        value: selected ? selected.executionId : '',
        'aria-label': '消息目标',
        disabled: !sendable && sending,
        onChange: event => {
          setSelectedExecutionId(event.target.value)
          setMode('exact')
        },
      }, candidates.map(item => h('option', { key: item.executionId, value: item.executionId },
        `${item.label} · ${item.activityId}`)))
      : h('input', {
        className: 'fs-inbox-target',
        type: 'text',
        value: nextActivityId,
        placeholder: '未来激活的节点 id（如 review）',
        'aria-label': '未来激活的节点 id',
        disabled: !sendable && sending,
        onInput: event => setNextActivityId(event.target.value),
      }),
    h('textarea', {
      className: 'fs-inbox-draft',
      rows: 3,
      value: draft,
      placeholder: '输入消息正文（长正文由 Host 落盘，列表只显示摘要）',
      'aria-label': '消息正文',
      disabled: status === 'COMPLETED' || status === 'CANCELED' || sending,
      onInput: event => setDraft(event.target.value),
    }),
    h('button', {
      type: 'button', className: 'fs-btn sm',
      disabled: !sendable,
      'data-action': 'inbox-send',
      title: '发送消息（POST /instances/<id>/messages）',
      onClick: () => { void send() },
    }, sending ? '发送中…' : '发送消息')))
}

// 兼容未使用导出的静态检查：errorTextOf 在面板外也有复用价值。
export { errorTextOf }
