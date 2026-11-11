/**
 * 实际 agent 执行的并发保护（0.13.7 C，从旧 `admission.js` 提取**必要**部分）。
 *
 * 只保留：
 *   - 全局 / 每工作区上限；
 *   - 有界队列（`queueMax`，0 = 禁止排队）；
 *   - 排队超时；
 *   - AbortSignal 取消退队（取消**不**泄漏槽位）。
 *
 * **不搬**旧 run 租约、打回、失败语义：槽位只在一次真实 agent 执行期间占用，
 * 人工等待 / 挂起不占槽。`acquire()` 返回 ticket，调用方必须在 `finally` 里
 * `release()`（重复 release 幂等）。
 *
 * @module @feiyueve/dsh-flow-studio/execution-limits
 */

/** 对外错误码。 */
export const EXECUTION_LIMIT_ERROR = Object.freeze({
  INVALID: 'EXECUTION_LIMIT_INVALID',
  QUEUE_FULL: 'EXECUTION_LIMIT_QUEUE_FULL',
  QUEUE_TIMEOUT: 'EXECUTION_LIMIT_QUEUE_TIMEOUT',
  CANCELLED: 'EXECUTION_LIMIT_CANCELLED',
})

/** 默认上限（与旧 admission 同量级，但只服务 agent 执行）。 */
export const EXECUTION_LIMIT_DEFAULTS = Object.freeze({
  global: 4,
  perWorkspace: 2,
  queueMax: 8,
  queueTimeoutMs: 15_000,
})

/** 环境变量旋钮（宿主可覆盖）。 */
export const EXECUTION_LIMIT_ENV = Object.freeze({
  global: 'FLOW_STUDIO_AGENT_GLOBAL',
  perWorkspace: 'FLOW_STUDIO_AGENT_PER_WORKSPACE',
  queueMax: 'FLOW_STUDIO_AGENT_QUEUE_MAX',
  queueTimeoutMs: 'FLOW_STUDIO_AGENT_QUEUE_TIMEOUT_MS',
})

const MAX_QUEUE_TIMEOUT_MS = 600_000
const MAX_LIMIT = 1024
const MAX_QUEUE = 10_000

let ticketCounter = 0

class ExecutionLimitError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ExecutionLimitError'
    this.code = code
    Object.assign(this, extra)
  }

  toPayload() {
    return { ok: false, code: this.code, error: this.message }
  }
}

function fail(code, message, extra) {
  return new ExecutionLimitError(code, message, extra)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback
  const number = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw fail(EXECUTION_LIMIT_ERROR.INVALID, `${label} 必须是 ${min}–${max} 的整数，收到 ${String(value)}`)
  }
  return number
}

function normalizeWorkspaceId(value) {
  if (value === undefined || value === null || value === '') return 'default'
  if (typeof value !== 'string' || value.length > 128 || value.includes('\0')) {
    throw fail(EXECUTION_LIMIT_ERROR.INVALID, 'workspaceId 必须是有界字符串')
  }
  return value
}

function signalAborted(signal) {
  return Boolean(signal && typeof signal === 'object' && signal.aborted === true)
}

/**
 * 创建执行槽位管理器。
 *
 * @param {{
 *   global?: number, perWorkspace?: number, queueMax?: number, queueTimeoutMs?: number,
 *   env?: object, now?: () => Date,
 * }} [options]
 */
export function createExecutionLimits(options = {}) {
  if (!isPlainObject(options)) {
    throw fail(EXECUTION_LIMIT_ERROR.INVALID, 'createExecutionLimits 需要对象参数')
  }
  const env = isPlainObject(options.env) ? options.env : {}
  const limits = {
    global: normalizeInteger(
      options.global ?? env[EXECUTION_LIMIT_ENV.global],
      EXECUTION_LIMIT_DEFAULTS.global, 1, MAX_LIMIT, 'global',
    ),
    perWorkspace: normalizeInteger(
      options.perWorkspace ?? env[EXECUTION_LIMIT_ENV.perWorkspace],
      EXECUTION_LIMIT_DEFAULTS.perWorkspace, 1, MAX_LIMIT, 'perWorkspace',
    ),
    queueMax: normalizeInteger(
      options.queueMax ?? env[EXECUTION_LIMIT_ENV.queueMax],
      EXECUTION_LIMIT_DEFAULTS.queueMax, 0, MAX_QUEUE, 'queueMax',
    ),
    queueTimeoutMs: normalizeInteger(
      options.queueTimeoutMs ?? env[EXECUTION_LIMIT_ENV.queueTimeoutMs],
      EXECUTION_LIMIT_DEFAULTS.queueTimeoutMs, 1, MAX_QUEUE_TIMEOUT_MS, 'queueTimeoutMs',
    ),
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date()

  const state = {
    active: 0,
    /** @type {Map<string, number>} workspaceId → 活跃数 */
    workspaces: new Map(),
    /** @type {object[]} */
    queue: [],
  }

  function isoNow() {
    const value = now()
    return value instanceof Date ? value.toISOString() : new Date().toISOString()
  }

  function snapshot() {
    return {
      active: state.active,
      global: limits.global,
      perWorkspace: limits.perWorkspace,
      queueMax: limits.queueMax,
      queueTimeoutMs: limits.queueTimeoutMs,
      workspaces: Object.fromEntries(state.workspaces),
      queued: state.queue.map((entry, index) => ({
        id: entry.id,
        workspaceId: entry.workspaceId,
        position: index + 1,
        queuedAt: entry.queuedAt,
      })),
    }
  }

  function workspaceActive(workspaceId) {
    return state.workspaces.get(workspaceId) ?? 0
  }

  function hasCapacity(workspaceId) {
    return state.active < limits.global
      && workspaceActive(workspaceId) < limits.perWorkspace
  }

  function grant(entry) {
    entry.settled = true
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.signalOff !== null) {
      entry.signalOff()
      entry.signalOff = null
    }
    state.active += 1
    state.workspaces.set(entry.workspaceId, workspaceActive(entry.workspaceId) + 1)
    let released = false
    const ticket = {
      id: entry.id,
      workspaceId: entry.workspaceId,
      acquiredAt: isoNow(),
      queuedMs: Date.now() - entry.enqueuedAtMs,
      released: false,
      release() {
        if (released) return false
        released = true
        ticket.released = true
        releaseSlot(entry.workspaceId)
        return true
      },
    }
    entry.resolve(ticket)
  }

  function releaseSlot(workspaceId) {
    if (state.active > 0) state.active -= 1
    const current = workspaceActive(workspaceId)
    if (current <= 1) state.workspaces.delete(workspaceId)
    else state.workspaces.set(workspaceId, current - 1)
    pump()
  }

  function dequeue(entry) {
    const index = state.queue.indexOf(entry)
    if (index >= 0) state.queue.splice(index, 1)
  }

  function cleanupEntry(entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.signalOff !== null) {
      try {
        entry.signalOff()
      } catch {
        // 卸载失败不影响取消结论。
      }
      entry.signalOff = null
    }
  }

  function cancelEntry(entry, reason) {
    if (entry.settled) return false
    entry.settled = true
    dequeue(entry)
    cleanupEntry(entry)
    entry.reject(fail(
      EXECUTION_LIMIT_ERROR.CANCELLED,
      `排队等待执行槽位时被取消（${reason}）`,
      { workspaceId: entry.workspaceId, reason },
    ))
    return true
  }

  function pump() {
    for (let index = 0; index < state.queue.length;) {
      const entry = state.queue[index]
      if (!hasCapacity(entry.workspaceId)) {
        index += 1
        continue
      }
      state.queue.splice(index, 1)
      grant(entry)
    }
  }

  /**
   * 申请一个执行槽位。
   *
   * @param {{workspaceId?: string, signal?: AbortSignal, label?: string}} [input]
   * @returns {Promise<{id:string, workspaceId:string, acquiredAt:string, queuedMs:number,
   *   released:boolean, release:() => boolean}>}
   */
  function acquire(input = {}) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const signal = input.signal && typeof input.signal === 'object' ? input.signal : null
    if (signalAborted(signal)) {
      return Promise.reject(fail(
        EXECUTION_LIMIT_ERROR.CANCELLED,
        '申请执行槽位前已被取消（signal 已 abort）',
        { workspaceId, reason: 'pre-aborted' },
      ))
    }
    return new Promise((resolveTicket, rejectTicket) => {
      if (hasCapacity(workspaceId)) {
        grant({
          id: `slot-${++ticketCounter}`,
          workspaceId,
          resolve: resolveTicket,
          reject: rejectTicket,
          enqueuedAtMs: Date.now(),
          queuedAt: isoNow(),
          timer: null,
          signalOff: null,
          settled: false,
        })
        return
      }
      if (limits.queueMax <= 0 || state.queue.length >= limits.queueMax) {
        rejectTicket(fail(
          EXECUTION_LIMIT_ERROR.QUEUE_FULL,
          `执行槽位已满（全局 ${state.active}/${limits.global}，本工作区 ${workspaceActive(workspaceId)}/${limits.perWorkspace}），`
            + `且排队已满（${state.queue.length}/${limits.queueMax}）`,
          { workspaceId, active: state.active, global: limits.global, queued: state.queue.length, queueMax: limits.queueMax },
        ))
        return
      }
      const entry = {
        id: `slot-${++ticketCounter}`,
        workspaceId,
        resolve: resolveTicket,
        reject: rejectTicket,
        enqueuedAtMs: Date.now(),
        queuedAt: isoNow(),
        timer: null,
        signalOff: null,
        settled: false,
      }
      entry.timer = setTimeout(() => {
        if (entry.settled) return
        entry.settled = true
        dequeue(entry)
        cleanupEntry(entry)
        entry.reject(fail(
          EXECUTION_LIMIT_ERROR.QUEUE_TIMEOUT,
          `排队等待执行槽位超过 ${limits.queueTimeoutMs}ms（${entry.id}）`,
          { workspaceId, queueTimeoutMs: limits.queueTimeoutMs },
        ))
      }, limits.queueTimeoutMs)
      if (signal && typeof signal.addEventListener === 'function') {
        const onAbort = () => cancelEntry(entry, 'signal')
        signal.addEventListener('abort', onAbort, { once: true })
        entry.signalOff = () => signal.removeEventListener('abort', onAbort)
      }
      state.queue.push(entry)
    })
  }

  /** 主动取消一个排队中的 ticket（按 id）；活跃槽位不能这样取消。 */
  function cancel(id) {
    const entry = state.queue.find(item => item.id === id)
    if (!entry) return false
    return cancelEntry(entry, 'cancelled-by-caller')
  }

  return {
    ...limits,
    acquire,
    cancel,
    snapshot,
    get active() {
      return state.active
    },
    get queued() {
      return state.queue.length
    },
  }
}
