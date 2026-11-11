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
 * 0.13.11（N10–N13）：所有状态按实例归属（世代 + 请求序号丢弃迟到响应），
 * 列表按 Host 的 nextCursor 分页（可「加载更多」），目标模式可显式切换，
 * exact 目标消失时回退到「下次激活」，一次逻辑提交固定 messageId。
 *
 * 0.13.13 复审 M7 / M8 / N10：messageId 只由「规范化目标 + 正文」签名决定，
 * 点击当前模式/重选目标/编辑正文都不提前丢弃 pendingId；手选 exact 目标消失时
 * 保留失效选择并要求重选（不静默改投 candidates[0]）；组件 unmount 时使在飞
 * 回调失效，迟到发送结果不再触发全局通知或列表刷新。
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

/** 目标规范化签名：只包含 Host 会看到的活动 / 执行 / 投递方式。 */
function targetSignatureOf(target) {
  return JSON.stringify([target.activityId, target.executionId || '', target.delivery || ''])
}

/** 一次逻辑提交的签名：目标 + 正文。只有签名变化才换 messageId。 */
function submissionSignatureOf(target, text) {
  return JSON.stringify([target.activityId, target.executionId || '', target.delivery || '', text])
}

/** `error.data.error` 优先；没有就给通用文案。 */
function errorTextOf(error) {
  return inboxFailurePlan('list', error).text
}

/** 每页条数：Host 列表默认 50、上限 100（见 instance-message-store）。 */
const INBOX_PAGE_SIZE = 100
/** 首屏 / 每次「加载更多」最多连续翻多少页，避免一次点击拉爆 Host。 */
const INBOX_MAX_PAGES = 10

/** 空白列表态；`instanceId` 标记归属，渲染时据此拒绝跨实例数据。 */
function emptyList(instanceId) {
  return {
    instanceId,
    loading: instanceId !== '',
    error: '',
    messages: [],
    total: 0,
    nextCursor: null,
    liveExecutions: [],
    loadingMore: false,
  }
}

/** 空白编辑态；一次逻辑提交（messageId + 内容/目标签名）也放在这里。 */
function emptyCompose(instanceId) {
  return {
    instanceId,
    text: '',
    mode: 'auto',
    nextActivityId: '',
    selectedExecutionId: '',
    sending: false,
    pendingId: '',
    pendingKey: '',
  }
}

/** 列表去重键：优先 messageId，其次 seq。 */
function messageKey(message) {
  const messageId = isObject(message) ? textOf(message.messageId) : ''
  if (messageId !== '') return 'id:' + messageId
  return 'seq:' + String(isObject(message) && Number.isSafeInteger(message.seq) ? message.seq : '')
}

/**
 * 按 Host 的 `nextCursor`（上一页最后一条的 seq）连续翻页。
 *
 * `isCurrent()` 由调用方提供：实例世代 / 请求序号失效时返回 false，结果整页丢弃。
 * 返回 `null` 表示本次读取已过期。翻页有硬上限（INBOX_MAX_PAGES），
 * 余下的交给「加载更多」，不把已取回的列表再截断。
 */
async function readMessagePages(client, instanceId, options = {}) {
  const maxPages = Number.isSafeInteger(options.maxPages) && options.maxPages > 0
    ? options.maxPages
    : INBOX_MAX_PAGES
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true
  let cursor = Number.isSafeInteger(options.cursor) ? options.cursor : null
  const messages = []
  const seen = new Set()
  let total = 0
  let nextCursor = null
  let liveExecutions = []
  for (let pageNo = 0; pageNo < maxPages; pageNo += 1) {
    const query = cursor === null ? { limit: INBOX_PAGE_SIZE } : { cursor, limit: INBOX_PAGE_SIZE }
    const data = await client.readInstanceMessages(instanceId, query)
    if (!isCurrent()) return null
    const page = isObject(data) ? data : {}
    const pageMessages = Array.isArray(page.messages) ? page.messages.filter(isObject) : []
    const before = messages.length
    for (const message of pageMessages) {
      const key = messageKey(message)
      if (seen.has(key)) continue
      seen.add(key)
      messages.push(message)
    }
    if (Number.isSafeInteger(page.total) && page.total >= 0) total = page.total
    if (Array.isArray(page.liveExecutions)) liveExecutions = page.liveExecutions
    const returned = Number.isSafeInteger(page.nextCursor) && page.nextCursor > 0 ? page.nextCursor : null
    if (returned === null) {
      nextCursor = null
      break
    }
    // 游标没有前进 / 整页都是重复项：停止，避免死循环。
    if (returned === cursor || messages.length === before) {
      nextCursor = null
      break
    }
    nextCursor = returned
    if (pageNo + 1 >= maxPages) break
    cursor = returned
  }
  return { messages, total, nextCursor, liveExecutions }
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

  // 实例世代 + 请求序号守卫：`useState` 持有可变对象（不依赖 useRef，探针只需
  // useState/useEffect）。世代在实例切换时 +1；列表/正文各自再有一个递增序号，
  // 同实例切走再切回、连续刷新时的迟到响应都会被丢弃。
  const [guard] = useState(() => ({
    instanceId: '',
    epoch: 0,
    // keyed unmount 后置 false 并推进 epoch：旧组件在飞的回调不能再碰全局通知/刷新。
    alive: true,
    listSeq: 0,
    listApplied: 0,
    bodySeq: 0,
    bodyApplied: 0,
  }))
  // 所有随实例变化的状态都带 `instanceId` 归属；渲染时只看属于当前实例的那份。
  const [list, setList] = useState(() => emptyList(instanceId))
  const [compose, setCompose] = useState(() => emptyCompose(instanceId))
  const [bodyView, setBodyView] = useState(null)
  const [bodyTick, setBodyTick] = useState(0)
  const [reloadTick, setReloadTick] = useState(0)
  const [focus, setFocus] = useState({ instanceId, messageId: '' })

  // 实例切换由 page.js 的 `key` 强制重挂；旧组件的列表/正文 effect cleanup 只会
  // 停掉它们自己的请求，发送回调仍持有旧的 notice / onChanged。这里在卸载时让
  // 世代失效，把所有在飞回调（发送成功通知、onChanged 刷新、迟到正文）一起作废。
  useEffect(() => {
    guard.alive = true
    return () => {
      guard.alive = false
      guard.epoch += 1
    }
  }, [])

  useEffect(() => {
    const switched = guard.instanceId !== instanceId
    if (switched) {
      guard.instanceId = instanceId
      guard.epoch += 1
      guard.listSeq = 0
      guard.listApplied = 0
      guard.bodySeq = 0
      guard.bodyApplied = 0
      setList(emptyList(instanceId))
      setCompose(emptyCompose(instanceId))
      setBodyView(null)
      setFocus({ instanceId, messageId: '' })
    }
    if (instanceId === '') return undefined
    const epoch = guard.epoch
    const seq = ++guard.listSeq
    let cancelled = false
    const isCurrent = () => guard.alive && !cancelled && guard.epoch === epoch && seq >= guard.listApplied
    setList(current => (current.instanceId === instanceId
      ? { ...current, loading: true, error: '' }
      : { ...emptyList(instanceId), loading: true }))
    void readMessagePages(client, instanceId, { isCurrent }).then(result => {
      if (result === null || !isCurrent()) return
      guard.listApplied = seq
      setList({
        instanceId,
        loading: false,
        error: '',
        messages: result.messages,
        total: result.total,
        nextCursor: result.nextCursor,
        liveExecutions: result.liveExecutions,
        loadingMore: false,
      })
    }, error => {
      if (!isCurrent()) return
      // 失败也算「这一代请求已结束」：更旧的响应不能把错误态覆盖回旧数据。
      guard.listApplied = seq
      const plan = inboxFailurePlan('list', error)
      setList(current => (current.instanceId === instanceId
        ? { ...current, loading: false, error: plan.text }
        : current))
      if (guard.alive && guard.epoch === epoch && guard.instanceId === instanceId) notice(plan.kind, plan.text)
    })
    return () => { cancelled = true }
  }, [client, instanceId, reloadTick])

  useEffect(() => {
    const view = bodyView
    if (view === null || view.instanceId !== instanceId) return undefined
    if (view.text !== undefined || view.error !== undefined || view.loading === true) return undefined
    const epoch = guard.epoch
    const seq = ++guard.bodySeq
    let cancelled = false
    const messageId = view.messageId
    setBodyView(current => (current && current.instanceId === instanceId && current.messageId === messageId
      && current.text === undefined && current.error === undefined
      ? { ...current, loading: true }
      : current))
    client.readInstanceMessageBody(instanceId, messageId).then(data => {
      if (cancelled || guard.epoch !== epoch || guard.instanceId !== instanceId) return
      if (seq < guard.bodyApplied) return
      guard.bodyApplied = seq
      setBodyView(current => (current && current.instanceId === instanceId && current.messageId === messageId
        ? { instanceId, messageId, text: typeof data?.text === 'string' ? data.text : '' }
        : current))
    }, error => {
      if (cancelled || guard.epoch !== epoch || guard.instanceId !== instanceId) return
      const plan = inboxFailurePlan('body', error)
      setBodyView(current => (current && current.instanceId === instanceId && current.messageId === messageId
        ? { instanceId, messageId, error: plan.text }
        : current))
      notice(plan.kind, plan.text)
    })
    return () => { cancelled = true }
  }, [client, instanceId, bodyView === null ? '' : bodyView.messageId, bodyTick])

  const shown = list.instanceId === instanceId ? list : emptyList(instanceId)
  const comp = compose.instanceId === instanceId ? compose : emptyCompose(instanceId)
  const messages = shown.messages
  const live = shown.liveExecutions
  const shownTotal = Math.max(shown.total, messages.length)
  const candidates = targetCandidates(live, tasks)
  const hasCandidates = candidates.length > 0
  // 手选的 exact 目标只按 executionId 精确匹配；找不到就是「已失效」，绝不落到 candidates[0]。
  const explicitSelected = comp.mode === 'exact'
    ? candidates.find(item => item.executionId === comp.selectedExecutionId) || null
    : null
  const selected = comp.mode === 'exact'
    ? explicitSelected
    : comp.mode === 'auto'
      ? (candidates[0] || null)
      : null
  // 手选过 exact、之后执行结束且没有其它候选：自动回退到「下次激活」并在界面上说明。
  const fallbackToNext = comp.mode === 'exact' && !hasCandidates
  // 手选目标消失但仍有其它执行：保留失效选择，要求用户重选（M8）。
  const invalidExactTarget = comp.mode === 'exact' && hasCandidates && explicitSelected === null
  const targetMode = fallbackToNext
    ? 'next'
    : comp.mode === 'auto'
      ? (hasCandidates ? 'exact' : 'next')
      : comp.mode
  const terminal = status === 'COMPLETED' || status === 'CANCELED'
  const sendable = !terminal && instanceId !== '' && comp.text.trim() !== '' && !comp.sending
    && !invalidExactTarget
    && (targetMode === 'exact' ? selected !== null : comp.nextActivityId.trim() !== '')

  function updateCompose(fn) {
    setCompose(current => (current.instanceId === instanceId ? fn(current) : current))
  }

  function editText(text) {
    if (comp.sending) return
    // 不在这里丢弃 pendingId：messageId 是否复用由发送时的「目标 + 正文」签名决定，
    // 失败后编辑再改回原文也能安全重试同一条提交。
    updateCompose(current => (current.text === text ? current : { ...current, text }))
  }

  function chooseMode(nextMode) {
    if (comp.sending) return
    if (nextMode === 'exact' && !hasCandidates) return
    // 目标没变就完全 no-op：重复点击当前已选模式不能清 pendingId。
    const currentTarget = targetOf()
    const nextTarget = nextMode === 'exact'
      ? (selected === null ? null : { activityId: selected.activityId, executionId: selected.executionId })
      : (comp.nextActivityId.trim() === ''
        ? null
        : { activityId: comp.nextActivityId.trim(), delivery: 'nextActivation' })
    const sameTarget = currentTarget === null || nextTarget === null
      ? currentTarget === nextTarget
      : targetSignatureOf(currentTarget) === targetSignatureOf(nextTarget)
    if (targetMode === nextMode && sameTarget) return
    updateCompose(current => {
      if (current.instanceId !== instanceId || current.sending) return current
      if (nextMode === 'next') return current.mode === 'next' ? current : { ...current, mode: 'next' }
      // 切回「当前执行」：保留仍然存在的显式选择，否则落到第一个候选（模式切换本身
      // 就是用户动作，但仍不会把已失效的旧选择静默换成另一个执行）。
      const keep = current.selectedExecutionId !== ''
        && candidates.some(item => item.executionId === current.selectedExecutionId)
      if (keep) return current.mode === 'exact' ? current : { ...current, mode: 'exact' }
      const first = candidates[0]
      if (!first) return current
      return { ...current, mode: 'exact', selectedExecutionId: first.executionId }
    })
  }

  function chooseExecution(executionId) {
    if (comp.sending) return
    updateCompose(current => {
      if (current.instanceId !== instanceId || current.sending) return current
      if (current.mode === 'exact' && current.selectedExecutionId === executionId) return current
      return { ...current, mode: 'exact', selectedExecutionId: executionId }
    })
  }

  function editNextActivityId(value) {
    if (comp.sending) return
    updateCompose(current => (current.nextActivityId === value
      ? current
      : { ...current, nextActivityId: value }))
  }

  function targetOf() {
    if (targetMode === 'exact') {
      return selected === null
        ? null
        : { activityId: selected.activityId, executionId: selected.executionId }
    }
    const activityId = comp.nextActivityId.trim()
    return activityId === '' ? null : { activityId, delivery: 'nextActivation' }
  }

  async function send() {
    if (!sendable || comp.sending) return
    const target = targetOf()
    if (target === null) return
    const epoch = guard.epoch
    const text = comp.text
    // 一次逻辑提交 = 内容 + 目标 + messageId。响应丢失后的重试必须复用同一个
    // messageId；只有规范化签名变了才生成新 id。
    const signature = submissionSignatureOf(target, text)
    const reuse = comp.pendingId !== '' && comp.pendingKey === signature
    const messageId = reuse ? comp.pendingId : messageIdForUi()
    updateCompose(current => ({ ...current, sending: true, pendingId: messageId, pendingKey: signature }))
    try {
      const data = await client.sendInstanceMessage(instanceId, { messageId, target, text })
      if (!guard.alive || guard.epoch !== epoch || guard.instanceId !== instanceId) return
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
      const locatedId = textOf(message.messageId) || messageId
      updateCompose(current => (current.pendingId === messageId
        ? { ...current, text: '', sending: false, pendingId: '', pendingKey: '' }
        : current))
      // 重新拉首屏并高亮新消息；列表较长时「加载更多」继续定位。
      setFocus({ instanceId, messageId: locatedId })
      setReloadTick(tick => tick + 1)
      onChanged()
    } catch (error) {
      if (!guard.alive || guard.epoch !== epoch || guard.instanceId !== instanceId) return
      // 草稿与 pendingId 都保留：同一个 messageId + 同一份内容可以直接重试。
      const plan = inboxFailurePlan('send', error)
      notice(plan.kind, plan.text)
    } finally {
      if (guard.alive && guard.epoch === epoch && guard.instanceId === instanceId) {
        updateCompose(current => (current.sending ? { ...current, sending: false } : current))
      }
    }
  }

  async function loadMore() {
    if (shown.instanceId !== instanceId || shown.nextCursor === null || shown.loadingMore) return
    const epoch = guard.epoch
    const seq = guard.listSeq
    const startCursor = shown.nextCursor
    const isCurrent = () => guard.alive && guard.epoch === epoch && guard.listSeq === seq
    setList(current => (current.instanceId === instanceId ? { ...current, loadingMore: true, error: '' } : current))
    try {
      const result = await readMessagePages(client, instanceId, { cursor: startCursor, isCurrent })
      if (result === null || !isCurrent()) return
      setList(current => {
        if (current.instanceId !== instanceId || current.nextCursor !== startCursor || guard.listSeq !== seq) return current
        const merged = current.messages.slice()
        const seen = new Set(merged.map(messageKey))
        for (const message of result.messages) {
          const key = messageKey(message)
          if (seen.has(key)) continue
          seen.add(key)
          merged.push(message)
        }
        return {
          ...current,
          loadingMore: false,
          messages: merged,
          total: Math.max(current.total, result.total, merged.length),
          nextCursor: result.nextCursor,
        }
      })
    } catch (error) {
      if (!isCurrent()) return
      const plan = inboxFailurePlan('list', error)
      setList(current => (current.instanceId === instanceId ? { ...current, loadingMore: false, error: plan.text } : current))
      notice(plan.kind, plan.text)
    }
  }

  function refresh() {
    setReloadTick(tick => tick + 1)
  }

  const focusMessageId = focus.instanceId === instanceId ? focus.messageId : ''
  const focusVisible = focusMessageId !== '' && messages.some(message => textOf(message.messageId) === focusMessageId)
  const shownBody = bodyView !== null && bodyView.instanceId === instanceId ? bodyView : null
  const sendHint = terminal
    ? '实例已结束：不再受理新消息。'
    : invalidExactTarget
      ? '原选中的执行已结束：目标已失效，请重新选择目标（不会自动改投其他执行）。'
      : fallbackToNext
        ? '原选中的执行已结束：已自动改发「下次激活」，填写节点 id 即可发送。'
        : targetMode === 'exact'
          ? `将发给当前 ${selected.label}（${selected.activityId}）。`
          : hasCandidates
            ? '将发给节点的下一次激活（需填写节点 id）。'
            : '当前没有活执行：默认发给节点的下一次激活。'

  return h('section', {
    className: 'fs-inbox',
    'aria-label': '实例消息',
    'data-inbox-instance': instanceId,
  },
  h('div', { className: 'fs-inbox-head' },
    h('strong', null, '消息'),
    h('button', {
      type: 'button', className: 'fs-btn sm ghost',
      disabled: !instanceId || shown.loading || comp.sending,
      'data-action': 'inbox-refresh',
      onClick: refresh,
      title: '重新读取消息列表（只读，不启动 runner）',
    }, shown.loading ? '读取中…' : '刷新')),

  shownTotal > 0
    ? h('p', { className: 'fs-inbox-total', 'data-inbox-total': String(shownTotal) },
      shownTotal > messages.length
        ? `共 ${shownTotal} 条 · 已显示 ${messages.length} 条`
        : `共 ${messages.length} 条`)
    : null,

  shown.error !== ''
    ? h('p', { className: 'fs-inbox-error', role: 'alert', 'data-inbox-error': 'true' }, shown.error)
    : null,

  messages.length === 0
    ? h('p', { className: 'fs-inbox-empty' },
      instanceId === '' ? '选中实例后显示它的消息。' : shown.loading ? '读取中…' : '还没有消息。')
    : h('ul', { className: 'fs-inbox-rows', 'data-inbox-count': String(messages.length) },
      messages.map(message => {
        const messageId = textOf(message.messageId)
        const body = isObject(message.body) ? message.body : {}
        const long = body.kind === 'file' || (Number.isInteger(message.bytes) && message.bytes > 4096)
        const focused = focusMessageId !== '' && messageId === focusMessageId
        return h('li', {
          key: messageId || String(message.seq),
          className: 'fs-inbox-row' + (focused ? ' fs-inbox-row-focus' : ''),
          'data-message-id': messageId,
          'data-message-status': textOf(message.status),
          'data-message-focus': focused ? 'true' : undefined,
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
              setBodyView({ instanceId, messageId })
              setBodyTick(tick => tick + 1)
            },
          }, '查看全文' + (Number.isInteger(message.bytes) ? `（${message.bytes} 字节）` : ''))
          : null)
      })),

  shown.nextCursor !== null
    ? h('button', {
      type: 'button', className: 'fs-btn sm ghost',
      'data-action': 'inbox-load-more',
      disabled: shown.loadingMore || shown.loading || comp.sending,
      onClick: () => { void loadMore() },
    }, shown.loadingMore ? '加载中…' : `加载更多（还有 ${Math.max(0, shownTotal - messages.length)} 条）`)
    : null,

  focusMessageId !== '' && !shown.loading && !focusVisible
    ? h('p', { className: 'fs-inbox-hint', 'data-inbox-focus-missing': 'true' },
      `已发送消息 ${focusMessageId}；它不在已加载的 ${messages.length} 条里，点「加载更多」继续定位。`)
    : null,

  shownBody !== null
    ? h('div', { className: 'fs-inbox-body-view', 'data-inbox-body-for': shownBody.messageId },
      h('div', { className: 'fs-inbox-row-head' },
        h('strong', null, `正文 ${shownBody.messageId}`),
        h('button', {
          type: 'button', className: 'fs-btn sm ghost',
          'data-action': 'inbox-hide-body',
          onClick: () => setBodyView(null),
        }, '收起')),
      shownBody.error !== undefined
        ? h('p', { className: 'fs-inbox-error', role: 'alert' }, shownBody.error)
        : shownBody.text === undefined
          ? h('p', { className: 'fs-inbox-empty' }, '读取中…')
          : h('pre', { className: 'fs-inbox-body-text' }, shownBody.text))
    : null,

  h('div', { className: 'fs-inbox-compose' },
    h('p', { className: 'fs-inbox-hint' }, sendHint),
    h('div', { className: 'fs-inbox-mode', role: 'group', 'aria-label': '消息目标模式' },
      h('button', {
        type: 'button',
        className: 'fs-btn sm ' + (targetMode === 'exact' ? 'primary' : 'ghost'),
        'data-action': 'inbox-mode-exact',
        'aria-pressed': targetMode === 'exact',
        disabled: !hasCandidates || comp.sending,
        onClick: () => chooseMode('exact'),
      }, '当前执行'),
      h('button', {
        type: 'button',
        className: 'fs-btn sm ' + (targetMode === 'next' ? 'primary' : 'ghost'),
        'data-action': 'inbox-mode-next',
        'aria-pressed': targetMode === 'next',
        disabled: comp.sending,
        onClick: () => chooseMode('next'),
      }, '下次激活')),
    targetMode === 'exact'
      ? h('select', {
        className: 'fs-inbox-target',
        value: selected ? selected.executionId : '',
        'aria-label': '消息目标',
        disabled: comp.sending || terminal,
        onChange: event => chooseExecution(event.target.value),
      }, [
        selected === null
          ? h('option', { key: '__reselect', value: '', disabled: true },
            invalidExactTarget ? '目标已失效，请重新选择' : '请选择目标')
          : null,
        ...candidates.map(item => h('option', { key: item.executionId, value: item.executionId },
          `${item.label} · ${item.activityId}`)),
      ])
      : h('input', {
        className: 'fs-inbox-target',
        type: 'text',
        value: comp.nextActivityId,
        placeholder: '未来激活的节点 id（如 review）',
        'aria-label': '未来激活的节点 id',
        disabled: comp.sending || terminal,
        onInput: event => editNextActivityId(event.target.value),
      }),
    h('textarea', {
      className: 'fs-inbox-draft',
      rows: 3,
      value: comp.text,
      placeholder: '输入消息正文（长正文由 Host 落盘，列表只显示摘要）',
      'aria-label': '消息正文',
      disabled: terminal || comp.sending,
      onInput: event => editText(event.target.value),
    }),
    h('button', {
      type: 'button', className: 'fs-btn sm',
      disabled: !sendable,
      'data-action': 'inbox-send',
      title: '发送消息（POST /instances/<id>/messages）',
      onClick: () => { void send() },
    }, comp.sending ? '发送中…' : '发送消息')))
}

// 兼容未使用导出的静态检查：errorTextOf 在面板外也有复用价值。
export { errorTextOf }
