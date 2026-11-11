/**
 * 底部实例事件抽屉（0.13.3 步骤 5）。
 *
 * 旧版这里是 run 日志（节点 / 成员 / agent 消息 / 指标 / 分页 / 缩放）；页面切到
 * 实例域后只保留**实例事件流**（docs/design/10-bpmn-instance-api.md §5）：
 *
 * - 事件按 `seq` 增量合并去重（`?since=<lastSeq>`），本模块复用
 *   `bpmn-state.mergeInstanceEvents`，不另写一套合并逻辑；
 * - 点击事件按 `elementId` 在画布定位（`focusBpmnElement`），**绝不**拿
 *   `activityId` / `executionId` 当 BPMN 图元 id；
 * - 未知 kind 原样保留并显示「未知事件（kind）」，不抛错、不影响图元状态；
 * - 抽屉可折叠：收起时只留一条计数条，展开时列出事件行。
 *
 * 纯函数部分可在裸 Node import；组件只在渲染时读 `rt.React`。
 *
 * @module @feiyueve/dsh-flow-studio/client/logdrawer
 */

import { eventIdentity, eventSeq, eventTypeOf, isKnownInstanceEvent } from './bpmn-state.js'
import { h } from './runtime.js'

export { mergeInstanceEvents, nextEventsQuery } from './bpmn-state.js'
export { createInstanceProjection } from './bpmn-state.js'

/** 展开档高度（px）；收起档是 40px 条，高度由 CSS 决定。 */
export const EVENT_DRAWER_HEIGHT = 240
/** 轮询基础间隔 / 上限 / 后台标签页间隔。 */
export const EVENT_POLL_MS = 2000
export const EVENT_POLL_MAX_MS = 30000
export const EVENT_POLL_HIDDEN_MS = 15000
/** 首次拉取后的最多保留条数（避免一次渲染上万行）。 */
export const EVENT_KEEP_LIMIT = 500

const TYPE_TEXT = Object.freeze({
  'process/start': '流程开始',
  'process/end': '流程结束',
  'activity/start': '活动开始',
  'activity/end': '活动结束',
  'activity/wait': '等待人工',
  'flow/taken': '连线走过',
  error: '执行错误',
})

/** kind → 中文；未知 kind 返回空串（由调用方降级显示）。 */
export function eventTypeText(type) {
  const text = typeof type === 'string' ? type : ''
  return TYPE_TEXT[text] || ''
}

/** 未知事件的可读降级文案；已知事件返回空串。 */
export function unknownEventText(event) {
  if (isKnownInstanceEvent(event)) return ''
  const type = eventTypeOf(event)
  return type === '' ? '未知事件（缺少类型）' : `未知事件（${type}）`
}

/** 事件行 key：有 seq 用 seq，否则用事件身份兜底。 */
export function eventRowKey(event) {
  return eventIdentity(event)
}

/** 事件时间：只显示时分秒；缺失返回 ''。 */
export function eventTimeText(event) {
  const at = event && typeof event.at === 'string' ? event.at : ''
  if (at === '') return ''
  const match = /(\d{2}:\d{2}:\d{2})/.exec(at)
  if (match) return match[1]
  return at
}

/** 事件的图元 id（只认 `elementId`）。 */
export function eventElementIdOf(event) {
  return event && typeof event.elementId === 'string' ? event.elementId : ''
}

/**
 * 事件一行摘要：类型 + 图元 + 关键业务字段。
 * 未知事件只写 kind，不猜字段。
 */
export function eventSummaryText(event) {
  if (!event || typeof event !== 'object') return ''
  if (!isKnownInstanceEvent(event)) return unknownEventText(event)
  const type = eventTypeOf(event)
  const elementId = eventElementIdOf(event)
  const parts = []
  if (type === 'flow/taken') {
    const from = typeof event.from === 'string' ? event.from : ''
    const to = typeof event.to === 'string' ? event.to : ''
    if (from || to) parts.push(`${from || '?'} → ${to || '?'}`)
    if (typeof event.flowId === 'string' && event.flowId !== '') parts.push(event.flowId)
  } else {
    if (elementId !== '') parts.push(elementId)
    if (type === 'error') {
      const message = event.error && typeof event.error.message === 'string'
        ? event.error.message
        : (typeof event.message === 'string' ? event.message : '')
      if (message !== '') parts.push(message)
    } else if (type === 'activity/end') {
      if (typeof event.status === 'string' && event.status !== '') parts.push(event.status)
    }
  }
  if (parts.length === 0 && typeof event.activityId === 'string' && event.activityId !== '') {
    parts.push(`activity ${event.activityId}`)
  }
  return parts.join(' · ')
}

/**
 * 事件 → 表格行（归一化 + 显示字段）。坏行返回 null，由调用方跳过。
 * 未知事件 `unknown:true`，仍保留 seq / elementId 供定位。
 */
export function eventRows(events) {
  const list = Array.isArray(events) ? events : []
  const rows = []
  for (const event of list) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue
    const type = eventTypeOf(event)
    if (type === '') continue
    const seq = eventSeq(event)
    rows.push({
      event,
      key: eventRowKey(event),
      seq,
      seqText: seq === null ? '—' : String(seq),
      type,
      typeText: eventTypeText(type) || type,
      unknown: !isKnownInstanceEvent(event),
      elementId: eventElementIdOf(event),
      summary: eventSummaryText(event),
      timeText: eventTimeText(event),
    })
  }
  return rows
}

/** 轮询间隔：失败退避 2s → 4s → 8s → 16s → 30s；后台标签页 15s。 */
export function nextEventPollDelay(options = {}) {
  const failures = Number.isFinite(options.failures) && options.failures > 0
    ? Math.min(Math.trunc(options.failures), 10)
    : 0
  if (options.hidden === true) return EVENT_POLL_HIDDEN_MS
  return Math.min(EVENT_POLL_MAX_MS, EVENT_POLL_MS * 2 ** failures)
}

/**
 * 在 BPMN 画布上定位图元（只读；不产生命令、不制造 dirty）。
 *
 * @param {object} editor `mountEditor()` 返回的控制器（有 `getModeler()`）
 * @param {string} elementId BPMN 图元 id（来自事件的 `elementId`）
 * @returns {boolean} 找到并滚动到图元
 */
export function focusBpmnElement(editor, elementId) {
  const wanted = typeof elementId === 'string' ? elementId : ''
  if (wanted === '') return false
  if (!editor || typeof editor.getModeler !== 'function') return false
  const modeler = editor.getModeler()
  if (!modeler || typeof modeler.get !== 'function') return false
  let registry = null
  let canvas = null
  try {
    registry = modeler.get('elementRegistry', false)
    canvas = modeler.get('canvas', false)
  } catch {
    return false
  }
  if (!registry || typeof registry.get !== 'function') return false
  const element = registry.get(wanted)
  if (!element) return false
  if (!canvas || typeof canvas.scrollToElement !== 'function') return false
  try {
    canvas.scrollToElement(element)
  } catch {
    return false
  }
  return true
}

/** 收起 / 展开的状态文案。 */
export function drawerToggleText(open, count) {
  const total = Number.isSafeInteger(count) && count >= 0 ? count : 0
  return `${open ? '收起' : '展开'}实例事件（${total}）`
}

/**
 * 实例事件抽屉。
 *
 * props:
 * - `open` / `onToggle()`；
 * - `events`：已合并的事件数组；
 * - `lastSeq`：当前游标；
 * - `instanceId` / `status`；
 * - `selectedElementId`：当前定位的图元（行高亮）；
 * - `onSelectEvent(event)`：点击行 → 页面去 `focusBpmnElement`；
 * - `error`：轮询/读取失败原因（可省略）。
 */
export function InstanceEventDrawer(props = {}) {
  const events = Array.isArray(props.events) ? props.events : []
  const rows = eventRows(events)
  const start = Math.max(0, rows.length - EVENT_KEEP_LIMIT)
  const visible = rows.slice(start)
  const open = props.open === true
  const onToggle = typeof props.onToggle === 'function' ? props.onToggle : () => {}
  const onSelectEvent = typeof props.onSelectEvent === 'function' ? props.onSelectEvent : () => {}
  const lastSeq = Number.isSafeInteger(props.lastSeq) && props.lastSeq >= 0 ? props.lastSeq : 0
  const instanceId = typeof props.instanceId === 'string' ? props.instanceId : ''
  const error = typeof props.error === 'string' ? props.error : ''
  const selected = typeof props.selectedElementId === 'string' ? props.selectedElementId : ''

  return h('section', {
    className: 'fs-event-drawer' + (open ? ' open' : ''),
    'data-open': open ? 'true' : 'false',
    'data-instance-id': instanceId,
    'aria-label': '实例事件抽屉',
  },
  h('div', { className: 'fs-event-bar' },
    h('button', {
      type: 'button',
      className: 'fs-event-toggle',
      'aria-expanded': open ? 'true' : 'false',
      onClick: onToggle,
      title: drawerToggleText(open, rows.length),
    }, h('span', { className: 'fs-event-caret' }, open ? '▾' : '▸'),
    h('strong', null, '实例事件'),
    h('span', { className: 'fs-event-count', 'data-event-count': String(rows.length) },
      `${rows.length} 条`)),
    h('span', { className: 'fs-event-cursor' }, `seq ${lastSeq}`),
    error !== '' ? h('span', { className: 'fs-event-error', role: 'alert' }, error) : null),
  open
    ? h('div', { className: 'fs-event-body' },
      visible.length === 0
        ? h('p', { className: 'fs-event-empty' }, '还没有事件；运行实例后这里会出现 process / activity / flow 事件。')
        : h('ol', { className: 'fs-event-rows' },
          visible.map(row => h('li', { key: row.key },
            h('button', {
              type: 'button',
              className: 'fs-event-row'
                + (row.unknown ? ' unknown' : '')
                + (row.elementId !== '' && row.elementId === selected ? ' selected' : ''),
              'data-event-seq': row.seq === null ? '' : String(row.seq),
              'data-event-type': row.type,
              'data-element-id': row.elementId,
              'data-unknown': row.unknown ? 'true' : 'false',
              onClick: () => onSelectEvent(row.event),
              title: row.elementId === '' ? row.summary : `定位到图元 ${row.elementId}`,
            },
            h('span', { className: 'fs-event-seq' }, row.seqText),
            h('span', { className: 'fs-event-time' }, row.timeText || '—'),
            h('span', { className: 'fs-event-kind' }, row.typeText),
            h('span', { className: 'fs-event-summary' }, row.summary),
            )))))
    : null,
  )
}
