/**
 * 右侧实例区：实例列表 / 详情 / 人工待办（0.13.3 步骤 5）。
 *
 * 口径（docs/design/10-bpmn-instance-api.md）：
 * - 实例状态只有 `ACTIVE / COMPLETED / SUSPENDED / CANCELED`；「在等人」不是状态，
 *   用 `pendingTasks` 表达；执行错误用 `lastError` 表达，**不伪造 failed 状态**。
 * - 完成人工任务提交 `payload` / `decidedBy` / 当前 `executionId`；
 *   提交期间同一任务在页面上被禁用（`createTaskCompletionGuard` 在 page 里兜底）。
 * - 404 / 409 的收口计划由 `completionFailurePlan()` 给出，本组件只负责显示原因。
 *
 * 组件只做展示与本地表单状态；请求与刷新由 page 注入。
 *
 * @module @feiyueve/dsh-flow-studio/client/tasklist
 */

import { h, rt } from './runtime.js'

/** 没有待办时的可读空态。 */
export const PENDING_TASKS_EMPTY_TEXT = '当前没有人工待办。'
/** 没有实例时的空态。 */
export const INSTANCE_LIST_EMPTY_TEXT = '还没有实例：保存定义后点「运行」。'

const STATUS_TEXT = Object.freeze({
  ACTIVE: '活跃',
  COMPLETED: '已完成',
  SUSPENDED: '已挂起',
  CANCELED: '已取消',
})

const STATUS_TONE = Object.freeze({
  ACTIVE: 'business',
  COMPLETED: 'success',
  SUSPENDED: 'warn',
  CANCELED: 'error',
})

/**
 * 实例状态 → 中文。未知状态降级为「未知状态（X）」，不猜成 ACTIVE。
 * @param {string} status
 */
export function instanceStatusText(status) {
  const text = typeof status === 'string' ? status.trim().toUpperCase() : ''
  return STATUS_TEXT[text] || `未知状态（${status === undefined || status === null ? '空' : String(status)}）`
}

/** 实例状态 → 语义色档（business / success / warn / error）。 */
export function instanceStatusTone(status) {
  const text = typeof status === 'string' ? status.trim().toUpperCase() : ''
  return STATUS_TONE[text] || 'warn'
}

/** 终态 = COMPLETED / CANCELED（不再轮询、不能完成任务）。 */
export function isTerminalStatus(status) {
  const text = typeof status === 'string' ? status.trim().toUpperCase() : ''
  return text === 'COMPLETED' || text === 'CANCELED'
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * `lastError` / 创建响应的 `error` → 可读文本。
 * 支持 `{code,message}` 与字符串两种形状；没有错误返回 ''。
 */
export function errorTextOf(error) {
  if (error === undefined || error === null || error === '') return ''
  if (typeof error === 'string') return error
  if (!isObject(error)) return String(error)
  const code = typeof error.code === 'string' ? error.code : ''
  const message = typeof error.message === 'string' && error.message !== ''
    ? error.message
    : (typeof error.reason === 'string' ? error.reason : '')
  if (code && message) return `${code}：${message}`
  return message || code
}

/** 实例详情里的错误：`lastError` 优先，其次 `result.error`。 */
export function instanceErrorOf(instance) {
  if (!isObject(instance)) return ''
  const lastError = errorTextOf(instance.lastError)
  if (lastError !== '') return lastError
  return errorTextOf(instance.result && instance.result.error)
}

/** 待办数量（数组 / 缺失都安全）。 */
export function pendingTaskCount(instance) {
  if (!isObject(instance) || !Array.isArray(instance.pendingTasks)) return 0
  return instance.pendingTasks.length
}

/** 实例列表行的一行摘要：状态 + 等待人工 + 定义版本。 */
export function instanceSummaryText(instance) {
  if (!isObject(instance)) return ''
  const parts = [instanceStatusText(instance.status)]
  const pending = pendingTaskCount(instance)
  if (pending > 0) parts.push(`等待人工 ${pending}`)
  const version = Number.isSafeInteger(instance.definitionVersion) ? instance.definitionVersion : null
  if (version !== null) parts.push(`定义 v${version}`)
  return parts.join(' · ')
}

/** 任务列表归一化：接受 `{tasks:[…]}`、裸数组、`{pendingTasks:[…]}`。 */
export function normalizeTasks(payload) {
  const list = Array.isArray(payload)
    ? payload
    : (isObject(payload) && Array.isArray(payload.tasks)
      ? payload.tasks
      : (isObject(payload) && Array.isArray(payload.pendingTasks) ? payload.pendingTasks : []))
  const rows = []
  for (const task of list) {
    if (!isObject(task)) continue
    const activityId = typeof task.activityId === 'string' ? task.activityId : ''
    if (activityId === '') continue
    rows.push({
      activityId,
      elementId: typeof task.elementId === 'string' ? task.elementId : '',
      name: typeof task.name === 'string' && task.name !== '' ? task.name : activityId,
      since: typeof task.since === 'string' ? task.since : '',
      executionId: typeof task.executionId === 'string' ? task.executionId : '',
    })
  }
  return rows
}

/** 任务在 UI 里的稳定键（activityId + executionId，与完成守卫同口径）。 */
export function taskKey(task) {
  if (!isObject(task)) return ''
  const activityId = typeof task.activityId === 'string' ? task.activityId : ''
  if (activityId === '') return ''
  return activityId + '::' + (typeof task.executionId === 'string' ? task.executionId : '')
}

/**
 * 待办行 → 提交请求体。
 *
 * - `payload` 必须是对象；
 * - `decidedBy` 空串省略（Host 不把空字符串当决定人）；
 * - `executionId` 由**当前任务**给出，用于同 activity 多执行消歧。
 */
export function taskSubmitBody(task, input = {}) {
  const payload = isObject(input.payload) ? input.payload : {}
  const body = { payload }
  const decidedBy = typeof input.decidedBy === 'string' ? input.decidedBy.trim() : ''
  if (decidedBy !== '') body.decidedBy = decidedBy
  const executionId = isObject(task) && typeof task.executionId === 'string' ? task.executionId : ''
  if (executionId !== '') body.executionId = executionId
  return body
}

/**
 * 解析 payload 文本框：空 = `{}`；必须是 JSON 对象。
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function parseTaskPayload(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw === '') return { ok: true, value: {} }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'payload 不是合法 JSON' }
  }
  if (!isObject(parsed)) return { ok: false, error: 'payload 必须是 JSON 对象' }
  return { ok: true, value: parsed }
}

function TaskRow(props) {
  const React = rt.React
  if (!React) throw new Error('TaskList 需要先由宿主注入 React（bindReact）')
  const { useState } = React
  const { task, submitting, disabled, onComplete } = props
  const [payloadText, setPayloadText] = useState('')
  const [decidedBy, setDecidedBy] = useState('')
  const [error, setError] = useState('')
  const busy = submitting === true
  const submit = () => {
    if (busy || disabled) return
    const parsed = parseTaskPayload(payloadText)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    setError('')
    onComplete(task, { payload: parsed.value, decidedBy })
  }
  return h('div', {
    className: 'fs-task' + (busy ? ' busy' : ''),
    'data-task-activity-id': task.activityId,
    'data-task-execution-id': task.executionId,
  },
  h('div', { className: 'fs-task-head' },
    h('strong', { className: 'fs-task-name' }, task.name),
    h('span', { className: 'fs-task-id' }, task.activityId)),
  task.since !== '' ? h('p', { className: 'fs-task-since' }, `等待自 ${task.since}`) : null,
  task.executionId !== '' ? h('p', { className: 'fs-task-exec' }, `executionId：${task.executionId}`) : null,
  h('label', { className: 'fs-task-field' },
    h('span', null, 'payload（JSON 对象）'),
    h('textarea', {
      className: 'fs-task-payload',
      value: payloadText,
      rows: 2,
      placeholder: '{ "approved": true }',
      disabled: busy || disabled,
      'aria-label': '人工任务 payload（JSON）',
      'aria-invalid': error !== '' ? 'true' : 'false',
      onInput: event => setPayloadText(event.target.value),
    })),
  h('label', { className: 'fs-task-field' },
    h('span', null, 'decidedBy'),
    h('input', {
      className: 'fs-task-decided-by',
      type: 'text',
      value: decidedBy,
      placeholder: '谁做的决定（可省略）',
      disabled: busy || disabled,
      'aria-label': '完成人（decidedBy）',
      onInput: event => setDecidedBy(event.target.value),
    })),
  error !== '' ? h('p', { className: 'fs-task-error', role: 'alert' }, error) : null,
  h('button', {
    type: 'button',
    className: 'fs-btn sm primary fs-task-submit',
    disabled: busy || disabled,
    onClick: submit,
    'data-action': 'complete-task',
  }, busy ? '提交中…' : '完成任务'))
}

/**
 * 人工待办列表。
 *
 * props: `tasks`、`submittingKeys`（string[] / Set）、`disabled`、`onComplete(task, {payload, decidedBy})`。
 */
export function TaskList(props = {}) {
  const tasks = Array.isArray(props.tasks) ? props.tasks : []
  const submitting = props.submittingKeys instanceof Set
    ? props.submittingKeys
    : new Set(Array.isArray(props.submittingKeys) ? props.submittingKeys : [])
  const disabled = props.disabled === true
  const onComplete = typeof props.onComplete === 'function' ? props.onComplete : () => {}
  if (tasks.length === 0) {
    return h('p', { className: 'fs-task-empty' }, PENDING_TASKS_EMPTY_TEXT)
  }
  return h('div', { className: 'fs-task-list', 'data-task-count': String(tasks.length) },
    tasks.map(task => h(TaskRow, {
      key: taskKey(task) || task.activityId,
      task,
      submitting: submitting.has(taskKey(task)),
      disabled,
      onComplete,
    })))
}

/** 实例列表（受控）。 */
export function InstanceList(props = {}) {
  const instances = Array.isArray(props.instances) ? props.instances : []
  const onSelect = typeof props.onSelect === 'function' ? props.onSelect : () => {}
  if (instances.length === 0) {
    return h('p', { className: 'fs-instance-empty' }, INSTANCE_LIST_EMPTY_TEXT)
  }
  return h('ul', { className: 'fs-instance-rows', 'data-instance-count': String(instances.length) },
    instances.map(instance => {
      const id = typeof instance.id === 'string' ? instance.id : ''
      if (id === '') return null
      const status = typeof instance.status === 'string' ? instance.status : ''
      const pending = pendingTaskCount(instance)
      return h('li', { key: id },
        h('button', {
          type: 'button',
          className: 'fs-instance-row' + (id === props.activeId ? ' active' : ''),
          'data-instance-id': id,
          'data-instance-status': status,
          'data-pending-count': String(pending),
          'data-active': id === props.activeId ? 'true' : 'false',
          onClick: () => onSelect(id),
        },
        h('span', { className: 'fs-instance-id' }, instance.name || id),
        h('span', {
          className: 'fs-status-chip ' + instanceStatusTone(status),
        }, instanceStatusText(status)),
        pending > 0
          ? h('span', { className: 'fs-instance-pending' }, `等待人工 ${pending}`)
          : null,
        h('span', { className: 'fs-instance-meta' }, instanceSummaryText(instance)),
        ))
    }))
}

/**
 * 右侧实例区：列表 + 选中实例详情 + 人工待办。
 *
 * props: `instances`、`activeInstance`、`activeInstanceId`、`tasks`、`submittingKeys`、
 * `busy`、`onSelectInstance(id)`、`onRefresh()`、`onStop(id)`、`onCompleteTask(task, input)`。
 */
export function InstancePanel(props = {}) {
  const active = isObject(props.activeInstance) ? props.activeInstance : null
  const tasks = Array.isArray(props.tasks)
    ? props.tasks
    : normalizeTasks(active ? active.pendingTasks : [])
  const busy = props.busy === true
  const onSelectInstance = typeof props.onSelectInstance === 'function' ? props.onSelectInstance : () => {}
  const onRefresh = typeof props.onRefresh === 'function' ? props.onRefresh : () => {}
  const onStop = typeof props.onStop === 'function' ? props.onStop : () => {}
  const onCompleteTask = typeof props.onCompleteTask === 'function' ? props.onCompleteTask : () => {}
  const error = instanceErrorOf(active)
  const status = active && typeof active.status === 'string' ? active.status : ''
  const version = active && Number.isSafeInteger(active.definitionVersion) ? active.definitionVersion : null
  const hash = active && typeof active.definitionHash === 'string' ? active.definitionHash : ''

  return h('aside', {
    className: 'fs-instance-panel',
    'aria-label': '实例与人工待办',
  },
  h('div', { className: 'fs-instance-head' },
    h('strong', null, '实例'),
    h('button', {
      type: 'button', className: 'fs-btn sm ghost', onClick: onRefresh, disabled: busy,
      title: '刷新实例列表与详情',
    }, '刷新')),
  h(InstanceList, {
    instances: Array.isArray(props.instances) ? props.instances : [],
    activeId: props.activeInstanceId || (active ? active.id : ''),
    onSelect: onSelectInstance,
  }),
  active === null
    ? h('p', { className: 'fs-instance-detail-empty' }, '选中一个实例查看状态、待办与错误。')
    : h('section', {
      className: 'fs-instance-detail',
      'data-instance-id': typeof active.id === 'string' ? active.id : '',
      'data-instance-status': status,
      'data-definition-version': version === null ? '' : String(version),
    },
    h('div', { className: 'fs-instance-title' },
      h('strong', null, active.id || '实例'),
      h('span', { className: 'fs-status-chip ' + instanceStatusTone(status) }, instanceStatusText(status))),
    h('dl', { className: 'fs-instance-facts' },
      h('div', null,
        h('dt', null, '状态'),
        h('dd', { 'data-field': 'status' }, instanceStatusText(status))),
      version === null ? null : h('div', null,
        h('dt', null, '定义版本'),
        h('dd', { 'data-field': 'definition-version' }, `v${version}${hash === '' ? '' : ' · ' + hash.slice(0, 12)}`)),
      h('div', null,
        h('dt', null, '待办'),
        h('dd', { 'data-field': 'pending' }, tasks.length === 0 ? '无' : `${tasks.length} 项`)),
      active.recovered === true ? h('div', null,
        h('dt', null, '恢复'),
        h('dd', null, '本次请求重建了 runner')) : null),
    error !== ''
      ? h('div', { className: 'fs-instance-error', role: 'alert', 'data-instance-error': 'true' },
        h('strong', null, '执行错误'),
        h('p', null, error))
      : null,
    status === 'ACTIVE'
      ? h('div', { className: 'fs-instance-actions' },
        h('button', {
          type: 'button', className: 'fs-btn sm danger', onClick: () => onStop(active.id), disabled: busy,
          title: '中止实例（POST /instances/<id>/stop）',
        }, '停止实例'))
      : null,
    h('h4', { className: 'fs-task-title' }, '人工待办'),
    h(TaskList, {
      tasks,
      submittingKeys: props.submittingKeys,
      disabled: busy || isTerminalStatus(status),
      onComplete: onCompleteTask,
    })))
}
