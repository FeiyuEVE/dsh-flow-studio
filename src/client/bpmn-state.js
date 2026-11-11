/**
 * 浏览器端实例 / 编辑状态纯逻辑（0.13.3）。
 *
 * 这个模块**不碰 DOM、不碰 React、不发请求**，可以被裸 Node 直接 import：
 *
 * 1. 事件投影：按 `seq` 增量合并去重，未知事件降级保留但不改状态；
 *    图元定位只认事件里的 `elementId`（不能把 `activityId` 当 BPMN 图元 id）。
 * 2. 编辑修订号：`markChanged()` 递增 revision；保存结果只能清掉**提交时**那一版
 *    的 dirty，用户随后继续改的修订仍是 dirty。
 * 3. XML 保存队列：去抖 + maxWait、乱序响应丢弃（旧请求晚到不覆盖新状态）、
 *    失败保留 dirty。队列只负责「什么时候发、结果算不算数」，版本固定与 dirty
 *    的落地由调用方在 `onSaved` 里做。
 * 4. 人工任务完成守卫：同一 `activityId + executionId` 提交期间不允许重复提交；
 *    404 / 409 的收口计划（刷新待办 + 可读原因）。
 *
 * 实例事件契约见 docs/design/10-bpmn-instance-api.md §5。
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn-state
 */

/** 0.13 实例事件 kind（与 design/10 §5 一一对应）。 */
export const KNOWN_INSTANCE_EVENTS = Object.freeze([
  'process/start',
  'process/end',
  'activity/start',
  'activity/end',
  'activity/wait',
  'flow/taken',
  'error',
])

const KNOWN_EVENT_SET = new Set(KNOWN_INSTANCE_EVENTS)

/** 运行时事件用 `type`；兼容只带 `kind` 的旧数据 / 手写事件。 */
export function eventTypeOf(event) {
  if (!event || typeof event !== 'object') return ''
  if (typeof event.type === 'string' && event.type !== '') return event.type
  if (typeof event.kind === 'string' && event.kind !== '') return event.kind
  return ''
}

/** 合法 seq（非负安全整数）；缺失返回 null。 */
export function eventSeq(event) {
  const seq = event && event.seq
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null
}

/** 事件是否属于 0.13 已知 kind；未知事件降级保留，但投影时忽略。 */
export function isKnownInstanceEvent(event) {
  return KNOWN_EVENT_SET.has(eventTypeOf(event))
}

function fallbackEventKey(event) {
  return [
    eventTypeOf(event),
    typeof event?.elementId === 'string' ? event.elementId : '',
    typeof event?.activityId === 'string' ? event.activityId : '',
    typeof event?.at === 'string' ? event.at : '',
    typeof event?.attempt === 'number' ? String(event.attempt) : '',
  ].join('|')
}

/** 去重键：有 seq 用 seq（跨分片全局单调），没有 seq 才退回内容键。 */
export function eventIdentity(event) {
  const seq = eventSeq(event)
  return seq === null ? 'k:' + fallbackEventKey(event) : 's:' + String(seq)
}

/**
 * 归一化一条事件：补齐 `seq/type/elementId/activityId/known`，保留 Host 原始字段。
 * 非对象 / 没有 type 的条目返回 null（坏行跳过，不让整条流失败）。
 */
export function normalizeInstanceEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const type = eventTypeOf(raw)
  if (type === '') return null
  const elementId = typeof raw.elementId === 'string' && raw.elementId !== '' ? raw.elementId : ''
  const activityId = typeof raw.activityId === 'string' ? raw.activityId : ''
  return {
    ...raw,
    type,
    seq: eventSeq(raw),
    elementId,
    activityId,
    known: KNOWN_EVENT_SET.has(type),
  }
}

function normalizedList(list) {
  if (Array.isArray(list)) return list
  if (list === undefined || list === null) return []
  return [list]
}

/**
 * 增量合并事件：`existing` 是已投影的事件，`incoming` 是本次（通常 `?since=`）返回的新事件。
 *
 * - 按去重键去重（同一条事件重复到达只留第一条）；
 * - 输出按 `seq` 升序（没有 seq 的保持到达顺序）；
 * - 未知 kind 保留并计入 `unknown`，由 {@link projectElementStates} 忽略；
 * - `lastSeq` 取两者最大 seq，没有有效 seq 时退回 `options.baseSeq`。
 *
 * @param {object[]} existing
 * @param {object[]} incoming
 * @param {{baseSeq?: number}} [options]
 * @returns {{events: object[], added: number, duplicates: number, invalid: number,
 *   unknown: number, lastSeq: number}}
 */
export function mergeInstanceEvents(existing, incoming, options = {}) {
  const seen = new Set()
  const merged = []
  let duplicates = 0
  let invalid = 0
  let unknown = 0
  let lastSeq = Number.isSafeInteger(options.baseSeq) && options.baseSeq >= 0 ? options.baseSeq : 0

  const add = raw => {
    const event = normalizeInstanceEvent(raw)
    if (event === null) {
      invalid += 1
      return false
    }
    const key = eventIdentity(event)
    if (seen.has(key)) {
      duplicates += 1
      return false
    }
    seen.add(key)
    if (!event.known) unknown += 1
    if (event.seq !== null && event.seq > lastSeq) lastSeq = event.seq
    merged.push(event)
    return true
  }

  for (const event of normalizedList(existing)) add(event)
  let added = 0
  for (const event of normalizedList(incoming)) {
    if (add(event)) added += 1
  }

  // seq 升序；没有 seq 的排在后面并保持到达顺序（稳定且可传递）。
  const ordered = merged.map((event, index) => ({ event, index }))
  ordered.sort((left, right) => {
    const a = left.event.seq
    const b = right.event.seq
    if (a === null && b === null) return left.index - right.index
    if (a === null) return 1
    if (b === null) return -1
    return a - b || left.index - right.index
  })

  return {
    events: ordered.map(item => item.event),
    added,
    duplicates,
    invalid,
    unknown,
    lastSeq,
  }
}

/**
 * 最新事件定位（只按 BPMN 图元 id 匹配）。
 *
 * 执行实例的 `activityId` / `executionId` **不是**图元 id：查询 `elementId` 时
 * 绝不能退回 activityId 匹配，否则多实例/多 attempt 会定位到错误的图元。
 */
export function latestEventForElement(events, elementId) {
  if (typeof elementId !== 'string' || elementId === '') return null
  let latest = null
  for (const raw of normalizedList(events)) {
    const event = normalizeInstanceEvent(raw)
    if (event === null || event.elementId !== elementId) continue
    if (latest === null) {
      latest = event
      continue
    }
    if (event.seq !== null && (latest.seq === null || event.seq >= latest.seq)) latest = event
    else if (event.seq === null && latest.seq === null) latest = event
  }
  return latest
}

function errorOf(event) {
  if (!event || event.error === undefined) return null
  return event.error
}

function activityFailureStatus(event) {
  const status = typeof event?.status === 'string' ? event.status.toLowerCase() : ''
  if (status === 'failed' || status === 'error' || status === 'canceled') return true
  return event?.error !== undefined && event?.error !== null
}

/**
 * 由事件流推导每个 BPMN 图元的展示状态（只读、可 JSON 化）。
 *
 * 返回 `Map<elementId, state>`；state 形如
 * `{elementId, status, lastSeq, lastType, attempts, waits, error, lastFlow}`。
 * status 取值：`idle | running | waiting | completed | failed | error`。
 * 未知事件不参与推导（降级为「不影响图元状态」）。
 */
export function elementStateMap(events) {
  const map = new Map()
  // 先归一化并按 seq 排队：调用方可能传入乱序窗口，状态必须以最大 seq 的事件为准。
  const ordered = normalizedList(events)
    .map((raw, index) => ({ event: normalizeInstanceEvent(raw), index }))
    .filter(item => item.event !== null && item.event.known)
  ordered.sort((left, right) => {
    const a = left.event.seq
    const b = right.event.seq
    if (a === null && b === null) return left.index - right.index
    if (a === null) return 1
    if (b === null) return -1
    return a - b || left.index - right.index
  })
  for (const { event } of ordered) {
    const elementId = event.elementId
    if (elementId === '') continue
    const state = map.get(elementId) || {
      elementId,
      status: 'idle',
      lastSeq: null,
      lastType: '',
      attempts: 0,
      waits: 0,
      error: null,
      lastFlow: null,
    }
    switch (event.type) {
      case 'process/start':
        if (state.status === 'idle') state.status = 'running'
        break
      case 'activity/start':
        state.status = 'running'
        state.attempts += 1
        state.error = null
        break
      case 'activity/wait':
        state.status = 'waiting'
        state.waits += 1
        break
      case 'activity/end':
        state.status = activityFailureStatus(event) ? 'failed' : 'completed'
        if (activityFailureStatus(event)) state.error = errorOf(event) ?? { message: event.status }
        break
      case 'error':
        state.status = 'error'
        state.error = errorOf(event) ?? { message: '执行出错' }
        break
      case 'process/end':
        state.status = 'completed'
        break
      case 'flow/taken':
        state.lastFlow = {
          flowId: typeof event.flowId === 'string' ? event.flowId : '',
          from: typeof event.from === 'string' ? event.from : '',
          to: typeof event.to === 'string' ? event.to : '',
        }
        break
      default:
        break
    }
    state.lastSeq = event.seq
    state.lastType = event.type
    map.set(elementId, state)
  }
  return map
}

/** {@link elementStateMap} 的普通对象版本（方便直接塞进 React state）。 */
export function projectElementStates(events) {
  const out = {}
  for (const [elementId, state] of elementStateMap(events)) {
    out[elementId] = { ...state }
  }
  return out
}

/**
 * 实例事件投影（有状态包装）：`merge()` 只负责增量合并，调用方用 `since` 拉取。
 *
 * @param {{events?: object[], lastSeq?: number}} [initial]
 */
export function createInstanceProjection(initial = {}) {
  let current = mergeInstanceEvents([], initial.events || [], {
    baseSeq: Number.isSafeInteger(initial.lastSeq) && initial.lastSeq >= 0 ? initial.lastSeq : 0,
  })

  return {
    /** 合并一批事件，返回本次合并统计（`events` 是合并后的完整列表）。 */
    merge(incoming) {
      const result = mergeInstanceEvents(current.events, incoming, { baseSeq: current.lastSeq })
      current = { events: result.events, lastSeq: result.lastSeq }
      return result
    },
    get events() {
      return current.events.slice()
    },
    get lastSeq() {
      return current.lastSeq
    },
    get since() {
      return current.lastSeq
    },
    eventsFor(elementId) {
      const wanted = typeof elementId === 'string' ? elementId : ''
      if (wanted === '') return []
      return current.events.filter(event => event.elementId === wanted)
    },
    latestFor(elementId) {
      return latestEventForElement(current.events, elementId)
    },
    elementStates() {
      return projectElementStates(current.events)
    },
    reset() {
      current = { events: [], lastSeq: 0 }
    },
  }
}

/** 下一次增量拉取的查询参数：`{since: lastSeq}`；不要带旧接口的 kind/order/light。 */
export function nextEventsQuery(lastSeq) {
  const since = Number.isSafeInteger(lastSeq) && lastSeq >= 0 ? lastSeq : 0
  return { since }
}

/**
 * 编辑修订号。
 *
 * `markChanged()` 每次真实编辑 +1；`markSaved(submittedRevision)` 只把「提交时那一版」
 * 标为已保存——提交之后用户又改了，`isDirty()` 仍为 true。
 *
 * @param {{revision?: number, savedRevision?: number}} [initial]
 */
export function createEditRevision(initial = {}) {
  let revision = Number.isSafeInteger(initial.revision) && initial.revision >= 0 ? initial.revision : 0
  let savedRevision = Number.isSafeInteger(initial.savedRevision) && initial.savedRevision >= 0
    ? Math.min(initial.savedRevision, revision)
    : revision

  return {
    get revision() {
      return revision
    },
    get savedRevision() {
      return savedRevision
    },
    /** 记一次编辑，返回新 revision。 */
    markChanged(by = 1) {
      const step = Number.isFinite(by) && by > 0 ? Math.max(1, Math.trunc(by)) : 1
      revision += step
      return revision
    },
    /** 当前 revision 是否比「已保存的 revision」新。 */
    isDirty(current = revision) {
      return (Number.isSafeInteger(current) ? current : revision) > savedRevision
    },
    /**
     * 保存成功：只清掉提交时的 revision。乱序/旧响应不该推进已保存位置，
     * 所以这里只接受 `savedRevision < submittedRevision <= revision`。
     */
    markSaved(submittedRevision) {
      if (!Number.isSafeInteger(submittedRevision)) return savedRevision
      if (submittedRevision > savedRevision && submittedRevision <= revision) {
        savedRevision = submittedRevision
      }
      return savedRevision
    },
    /** 切定义 / 重新加载：revision 归零，dirty 清空。 */
    reset(nextRevision = 0) {
      revision = Number.isSafeInteger(nextRevision) && nextRevision >= 0 ? nextRevision : 0
      savedRevision = revision
      return revision
    },
  }
}

/**
 * XML 保存队列（去抖 + maxWait + 乱序丢弃 + 失败保 dirty）。
 *
 * 关键语义：
 * - `schedule(snapshot)` 只记最新快照，去抖窗内多次编辑只发一次；
 * - 每个真正发出的请求有单调 token；只有**最新发出**的请求结果会触发
 *   `onSaved` / `onFailed`，旧请求晚到返回 `{stale:true}`（不覆盖新状态）；
 * - 失败不调用 `markSaved`，dirty 由调用方保留；`snapshot.revision` 原样带回；
 * - `flush()` 立即发（切页 / 运行前等待保存完成），返回该次请求的 Promise。
 *
 * @param {object} [options]
 * @param {(snapshot: object) => Promise<object>} [options.save]
 * @param {number} [options.debounceMs]
 * @param {number} [options.maxWaitMs]
 * @param {(result: object, snapshot: object) => void} [options.onSaved]
 * @param {(error: Error, snapshot: object) => void} [options.onFailed]
 * @param {(fn: Function, ms: number) => any} [options.setTimeout]
 * @param {(id: any) => void} [options.clearTimeout]
 */
export function createSaveQueue(options = {}) {
  const save = typeof options.save === 'function' ? options.save : null
  const debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 500
  const maxWaitMs = Number.isFinite(options.maxWaitMs)
    ? Math.max(debounceMs, options.maxWaitMs)
    : Math.max(debounceMs, 2000)
  const setTimer = typeof options.setTimeout === 'function'
    ? options.setTimeout
    : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof options.clearTimeout === 'function'
    ? options.clearTimeout
    : id => clearTimeout(id)
  const onSaved = typeof options.onSaved === 'function' ? options.onSaved : () => {}
  const onFailed = typeof options.onFailed === 'function' ? options.onFailed : () => {}

  let pending = null
  let debounceTimer = null
  let maxWaitTimer = null
  let tokenSeq = 0
  let latestToken = 0
  let inflight = 0
  let lastResult = null
  let lastError = null

  function clearTimers() {
    if (debounceTimer !== null) {
      clearTimer(debounceTimer)
      debounceTimer = null
    }
    if (maxWaitTimer !== null) {
      clearTimer(maxWaitTimer)
      maxWaitTimer = null
    }
  }

  function run() {
    clearTimers()
    if (pending === null) return null
    const snapshot = pending
    pending = null
    if (save === null) {
      const error = new Error('保存队列缺少 save 实现')
      lastError = error
      onFailed(error, snapshot)
      return Promise.resolve({ ok: false, stale: false, token: 0, snapshot, error })
    }
    const token = ++tokenSeq
    latestToken = token
    inflight += 1
    const promise = (async () => {
      try {
        const result = await save(snapshot)
        const stale = token !== latestToken
        if (!stale) {
          lastResult = result
          lastError = null
          onSaved(result, snapshot)
        }
        return { ok: true, stale, token, snapshot, result }
      } catch (error) {
        const stale = token !== latestToken
        if (!stale) {
          lastError = error
          onFailed(error, snapshot)
        }
        return { ok: false, stale, token, snapshot, error }
      } finally {
        inflight -= 1
      }
    })()
    return promise
  }

  function schedule(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false
    if (pending === null) {
      maxWaitTimer = setTimer(run, maxWaitMs)
    }
    pending = snapshot
    if (debounceTimer !== null) clearTimer(debounceTimer)
    debounceTimer = setTimer(run, debounceMs)
    return true
  }

  return {
    schedule,
    /** 立即发；没有待发内容返回 null。 */
    flush: run,
    /** 丢弃待发内容（保存成功 / 删除定义时）；在飞请求不受影响。 */
    cancel() {
      clearTimers()
      pending = null
      return true
    },
    pending: () => pending,
    inflight: () => inflight,
    get lastResult() {
      return lastResult
    },
    get lastError() {
      return lastError
    },
    debounceMs,
    maxWaitMs,
  }
}

/** 人工任务在「提交中」集合里的键；executionId 用于同 activity 多执行消歧。 */
export function taskCompletionKey(task) {
  if (!task || typeof task !== 'object') return ''
  const activityId = typeof task.activityId === 'string' ? task.activityId : ''
  if (activityId === '') return ''
  const executionId = typeof task.executionId === 'string' ? task.executionId : ''
  return activityId + '::' + executionId
}

/**
 * 人工任务完成守卫：同一任务提交期间必须禁用重复操作。
 *
 * @param {{now?: () => number}} [options]
 */
export function createTaskCompletionGuard() {
  const inflight = new Set()
  return {
    /** 若该任务已在提交中返回 null；否则登记并返回答复键。 */
    begin(task) {
      const key = taskCompletionKey(task)
      if (key === '' || inflight.has(key)) return null
      inflight.add(key)
      return key
    },
    /** 提交结束（成功或失败）释放。 */
    end(key) {
      inflight.delete(key)
      return inflight.has(key)
    },
    has(task) {
      return inflight.has(taskCompletionKey(task))
    },
    get size() {
      return inflight.size
    },
  }
}

/**
 * 完成人工任务失败后的收口计划：
 * - 404 / `BPMN_TASK_NOT_FOUND`：待办已被别人处理 → 刷新待办并显示原因；
 * - 409：实例状态已变化（终态 / 非 waiting / 不可恢复）→ 刷新详情；
 * - 其它错误保持原样，不清空本地待办。
 */
export function completionFailurePlan(status, data) {
  const code = data && typeof data.code === 'string' ? data.code : ''
  const detail = data && typeof data.error === 'string' && data.error.trim() !== '' ? data.error.trim() : ''
  if (status === 404 || code === 'BPMN_TASK_NOT_FOUND') {
    return {
      refresh: true,
      terminal: false,
      message: detail || '人工任务已不存在（可能已被处理），已刷新待办。',
    }
  }
  if (status === 409) {
    return {
      refresh: true,
      terminal: code === 'BPMN_INSTANCE_TERMINAL',
      message: detail || '实例状态已变化，不能完成这个任务；已刷新详情。',
    }
  }
  return {
    refresh: false,
    terminal: false,
    message: detail || (typeof status === 'number' && status > 0 ? `提交失败（HTTP ${status}）` : '连不上 Host 或响应不可读。'),
  }
}
