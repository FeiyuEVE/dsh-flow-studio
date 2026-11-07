/**
 * 执行槽位准入（0.11 · R2/S1：全局并发不设上限 → 可配置上限 + 排队）。
 *
 * 职责边界：**只**做「能不能开始跑」的记账，不 import engine / runtime / index，
 * 不创建 Engine、不建 worktree、不碰 session。runtime 在 `start()` 里先 `acquire`
 * 拿到槽位，再创建 Engine；Engine 收尾 / start 抛错 / dispose 时把槽位还回来。
 *
 * 语义（与 0.11 设计一致）：
 *   - 两层上限：`global`（全进程/全控制器）与 `perWorkspace`（工作区）。工作区上限
 *     **立即**拒绝（reason=`workspace-full`），不排队——排了也轮不到它，早拒绝早报错。
 *   - 全局满时进入**严格 FIFO** 队列：只看队头。队头因工作区满而等待时，后面的
 *     条目即使能跑也不得越过队头（避免小 run 无限插队饿死大队头）。
 *   - 队列容量 `queueMax`（0 = 禁止排队）；排队超时 / AbortSignal 取消都必须
 *     **原子摘票**（清计时器、摘 abort 监听、从队里删掉），绝不留下幽灵条目。
 *
 * 进程单例：不显式注入 `controller` 时，状态挂在
 * `globalThis[Symbol.for('dsh-flow-studio.admission.v1')]` 上——同一个进程里
 * 多个 runtime（热重载 / 测试 / tools 与 index 各建一份）共享同一份槽位账本；
 * ES module 被重新 import 也不会重置。已有控制器但 limits 不一致 → 抛可读错误，
 * 而不是悄悄按新 limits 记账（那会让「全局上限」形同虚设）。
 *
 * @module @feiyueve/dsh-flow-studio/admission
 */

/** 进程级单例的 key（Symbol.for：跨模块实例 / 热重载仍是同一个）。 */
const SINGLETON_KEY = Symbol.for('dsh-flow-studio.admission.v1')

/** 控制器对象上存内部状态的键（字符串：模块重载后仍能识别旧状态）。 */
const STATE_KEY = '__dshFlowStudioAdmissionStateV1'

const DEFAULT_GLOBAL = 4
const DEFAULT_PER_WORKSPACE = 2
const DEFAULT_QUEUE_MAX = 8
const DEFAULT_QUEUE_TIMEOUT_MS = 15_000
const MAX_QUEUE_TIMEOUT_MS = 600_000
const RETRY_AFTER_MS = 30_000

const ENV = Object.freeze({
  global: 'FLOW_STUDIO_MAX_CONCURRENT_RUNS',
  perWorkspace: 'FLOW_STUDIO_MAX_CONCURRENT_RUNS_PER_WORKSPACE',
  queueMax: 'FLOW_STUDIO_RUN_QUEUE_MAX',
  queueTimeoutMs: 'FLOW_STUDIO_RUN_QUEUE_TIMEOUT_MS',
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 完整字符串数字校验：只认 /^\d+$/（不接受 '1.5' / '-1' / ' 1' / '1e3'）。 */
function numericValue(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

/**
 * 读取一个旋钮：显式参数 > 环境变量 > 默认值。
 *
 * 非法值一律回退默认值并写进 `warnings`；**警告里不回显原值**（原值可能是用户误
 * 粘贴进来的敏感串，日志/接口都不该带出去）。
 */
function readKnob({ explicit, env, envKey, fallback, min, max, hint, label, warnings }) {
  let source = null
  let raw
  if (explicit !== undefined && explicit !== null) {
    source = label
    raw = explicit
  } else if (isPlainObject(env) && env[envKey] !== undefined && env[envKey] !== null) {
    source = envKey
    raw = env[envKey]
  }
  if (source === null) return fallback
  const value = numericValue(raw)
  if (value === null || value < min || value > max) {
    warnings.push(`${source} 不是${hint}，已回退默认值 ${fallback}`)
    return fallback
  }
  return value
}

/** 归一化配置（env 可注入，便于测试；默认读 process.env）。 */
function normalizeConfig(options = {}) {
  const warnings = []
  const env = options.env !== undefined ? options.env : process.env
  const limits = isPlainObject(options.limits) ? options.limits : {}
  const firstDefined = (...values) => {
    for (const value of values) {
      if (value !== undefined && value !== null) return value
    }
    return undefined
  }
  const global = readKnob({
    explicit: limits.global,
    env,
    envKey: ENV.global,
    fallback: DEFAULT_GLOBAL,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    hint: '正整数',
    label: 'limits.global',
    warnings,
  })
  const perWorkspaceRaw = readKnob({
    explicit: limits.perWorkspace,
    env,
    envKey: ENV.perWorkspace,
    fallback: DEFAULT_PER_WORKSPACE,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    hint: '正整数',
    label: 'limits.perWorkspace',
    warnings,
  })
  // 有效工作区上限不能高于全局上限（否则工作区上限永远不生效）。
  const perWorkspace = Math.min(perWorkspaceRaw, global)
  const queueMax = readKnob({
    explicit: firstDefined(options.queueMax, limits.queueMax),
    env,
    envKey: ENV.queueMax,
    fallback: DEFAULT_QUEUE_MAX,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    hint: '非负整数',
    label: 'queueMax',
    warnings,
  })
  const queueTimeoutMs = readKnob({
    explicit: firstDefined(options.queueTimeoutMs, limits.queueTimeoutMs),
    env,
    envKey: ENV.queueTimeoutMs,
    fallback: DEFAULT_QUEUE_TIMEOUT_MS,
    min: 1,
    max: MAX_QUEUE_TIMEOUT_MS,
    hint: `1..${MAX_QUEUE_TIMEOUT_MS} 的正整数`,
    label: 'queueTimeoutMs',
    warnings,
  })
  return { global, perWorkspace, queueMax, queueTimeoutMs, warnings }
}

function sameConfig(a, b) {
  return a.global === b.global
    && a.perWorkspace === b.perWorkspace
    && a.queueMax === b.queueMax
    && a.queueTimeoutMs === b.queueTimeoutMs
}

function isoOf(now) {
  const value = typeof now === 'function' ? now() : new Date()
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return new Date().toISOString()
}

function signalAborted(signal) {
  return Boolean(signal && signal.aborted === true)
}

function limitSnapshot(state) {
  return { global: state.global, perWorkspace: state.perWorkspace }
}

/**
 * 准入失败错误（429 / 409）。
 *
 * 字段是给 Host / 前端直接消费的：`status` / `code` / `scope` / `reason` /
 * `active` / `max` / `limits` / `retryAfterMs`，`message` 是可读中文。
 */
export class AdmissionError extends Error {
  constructor(details = {}) {
    const {
      message,
      status = 429,
      code = 'RUN_CONCURRENCY_LIMIT',
      scope = 'global',
      reason = null,
      active = 0,
      max = 0,
      limits = null,
      retryAfterMs = RETRY_AFTER_MS,
      runId = null,
      ...extra
    } = details
    super(typeof message === 'string' && message !== '' ? message : (reason || '执行槽位申请失败'))
    this.name = 'AdmissionError'
    this.status = Number.isInteger(status) ? status : 429
    this.code = code
    this.scope = scope
    this.reason = reason
    this.active = active
    this.max = max
    this.limits = limits === null ? null : { ...limits }
    this.retryAfterMs = retryAfterMs
    if (runId !== null) this.runId = runId
    Object.assign(this, extra)
  }

  toJSON() {
    const payload = {
      status: this.status,
      code: this.code,
      scope: this.scope,
      reason: this.reason,
      active: this.active,
      max: this.max,
      limits: this.limits,
      retryAfterMs: this.retryAfterMs,
      message: this.message,
    }
    if (this.runId !== undefined) payload.runId = this.runId
    return payload
  }
}

/**
 * 创建一个准入控制器（facade）。同一个 `controller` 上的多次调用共享账本。
 *
 * @param {{
 *   controller?: object,
 *   limits?: { global?: number, perWorkspace?: number, queueMax?: number, queueTimeoutMs?: number },
 *   queueMax?: number,
 *   queueTimeoutMs?: number,
 *   env?: object,
 *   now?: () => (Date | number),
 * }} [options]
 * @returns {{
 *   acquire: (input: { runId: string, workspaceKey?: string, signal?: AbortSignal }) => Promise<() => void>,
 *   admissionOf: (runId: string) => null | { state: string, queuedAt?: string, position?: number, timeoutMs?: number },
 *   markRunning: (runId: string) => boolean,
 *   release: (runId: string) => boolean,
 *   cancel: (runId: string, reason?: string) => boolean,
 *   snapshot: () => { active: number, global: number, workspaces: object, queued: object[] },
 *   limits: { global: number, perWorkspace: number, warnings: string[] },
 *   queueMax: number,
 *   queueTimeoutMs: number,
 *   controller: object,
 * }}
 */
export function createAdmission(options = {}) {
  const config = normalizeConfig(options)
  let controller
  if (options.controller !== undefined && options.controller !== null) {
    if (!isPlainObject(options.controller) && typeof options.controller !== 'object') {
      throw new TypeError('createAdmission 的 controller 必须是对象')
    }
    controller = options.controller
  } else {
    controller = globalThis[SINGLETON_KEY]
    if (!controller) {
      controller = {}
      globalThis[SINGLETON_KEY] = controller
    }
  }

  let state = controller[STATE_KEY]
  if (!state) {
    state = {
      global: config.global,
      perWorkspace: config.perWorkspace,
      queueMax: config.queueMax,
      queueTimeoutMs: config.queueTimeoutMs,
      warnings: [...config.warnings],
      active: 0,
      workspaces: new Map(),
      entries: new Map(),
      queue: [],
    }
    Object.defineProperty(controller, STATE_KEY, {
      value: state,
      enumerable: false,
      configurable: true,
      writable: false,
    })
  } else if (!sameConfig(state, config)) {
    throw new Error(
      '准入控制器已存在且并发限制不同：'
      + `已有 global=${state.global} / perWorkspace=${state.perWorkspace}`
      + ` / queueMax=${state.queueMax} / queueTimeoutMs=${state.queueTimeoutMs}，`
      + `本次 global=${config.global} / perWorkspace=${config.perWorkspace}`
      + ` / queueMax=${config.queueMax} / queueTimeoutMs=${config.queueTimeoutMs}；`
      + '全局槽位账本只能有一套限制，请复用同一份 controller 或显式注入独立的 controller',
    )
  }

  const now = typeof options.now === 'function' ? options.now : () => new Date()

  // ── 内部：错误构造 ────────────────────────────────────────────────────

  function limitError({ reason, scope, runId, workspaceKey, active, max }) {
    let message
    if (reason === 'workspace-full') {
      message = `工作区「${workspaceKey}」的执行槽位已满（${active}/${max}），`
        + '请等该工作区正在跑的 run 收尾后重试'
    } else if (reason === 'queue-full') {
      const queueDetail = state.queueMax === 0
        ? '（当前配置禁止排队）'
        : `（${state.queue.length}/${state.queueMax}）`
      message = `全局执行槽位已满（${active}/${max}），且排队已满${queueDetail}，请稍后重试`
    } else if (reason === 'queue-timeout') {
      message = `排队等待超过 ${state.queueTimeoutMs}ms 仍未获得执行槽位（${runId}）`
    } else {
      message = `执行槽位申请失败（${runId}）`
    }
    return new AdmissionError({
      message,
      status: 429,
      code: 'RUN_CONCURRENCY_LIMIT',
      scope,
      reason,
      active,
      max,
      limits: limitSnapshot(state),
      retryAfterMs: RETRY_AFTER_MS,
      runId,
      workspaceKey,
    })
  }

  function alreadyActiveError(runId, currentState) {
    return new AdmissionError({
      message: `同一 run 已在运行（${runId}），不能重复申请执行槽位`,
      status: 409,
      code: 'RUN_ALREADY_ACTIVE',
      scope: 'global',
      reason: 'already-active',
      active: state.active,
      max: state.global,
      limits: limitSnapshot(state),
      retryAfterMs: RETRY_AFTER_MS,
      runId,
      state: currentState,
    })
  }

  function cancelledError(runId, cancelReason) {
    const suffix = typeof cancelReason === 'string' && cancelReason !== '' && cancelReason !== 'cancelled'
      ? `（${cancelReason}）`
      : ''
    return new AdmissionError({
      message: `执行槽位申请已取消（${runId}）${suffix}`,
      status: 429,
      code: 'RUN_CONCURRENCY_LIMIT',
      scope: 'global',
      reason: 'cancelled',
      active: state.active,
      max: state.global,
      limits: limitSnapshot(state),
      retryAfterMs: RETRY_AFTER_MS,
      runId,
      cancelReason: typeof cancelReason === 'string' ? cancelReason : 'cancelled',
    })
  }

  // ── 内部：队列 / 槽位记账 ──────────────────────────────────────────────

  function dequeue(entry) {
    const index = state.queue.indexOf(entry)
    if (index >= 0) state.queue.splice(index, 1)
  }

  function cleanupEntry(entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.signal && typeof entry.signal.removeEventListener === 'function' && entry.onAbort) {
      try {
        entry.signal.removeEventListener('abort', entry.onAbort)
      } catch {
        // 摘监听失败不该影响记账。
      }
    }
    entry.onAbort = null
    entry.signal = null
  }

  function reserve(entry) {
    entry.state = 'reserved'
    cleanupEntry(entry)
    state.active += 1
    state.workspaces.set(entry.workspaceKey, (state.workspaces.get(entry.workspaceKey) || 0) + 1)
    entry.release = () => releaseEntry(entry, { cancelReason: 'released' })
    entry.resolve(entry.release)
  }

  /** 释放一个槽位 / 摘掉一张排队票；只生效一次。 */
  function releaseEntry(entry, { cancelReason = 'cancelled' } = {}) {
    if (entry.released) return false
    entry.released = true
    cleanupEntry(entry)
    if (state.entries.get(entry.runId) === entry) state.entries.delete(entry.runId)
    if (entry.state === 'queued') {
      dequeue(entry)
      entry.reject(cancelledError(entry.runId, cancelReason))
      pump()
      return true
    }
    state.active = Math.max(0, state.active - 1)
    const used = state.workspaces.get(entry.workspaceKey) || 0
    if (used <= 1) state.workspaces.delete(entry.workspaceKey)
    else state.workspaces.set(entry.workspaceKey, used - 1)
    pump()
    return true
  }

  /**
   * 严格 FIFO：永远只看队头。
   *
   * 队头的工作区满 → 停住（后面的条目不得越过）；队头可跑 → 发槽位并继续看新的队头。
   * 全局槽位用完即停。
   */
  function pump() {
    while (state.queue.length > 0) {
      if (state.active >= state.global) return
      const head = state.queue[0]
      if (head.released) {
        state.queue.shift()
        continue
      }
      const used = state.workspaces.get(head.workspaceKey) || 0
      // 队头被工作区上限挡住：后面的 run 即使能跑也等着（严格 FIFO，不越过队头）。
      if (used >= state.perWorkspace) return
      state.queue.shift()
      reserve(head)
    }
  }

  // ── 公开 API ─────────────────────────────────────────────────────────

  function acquire({ runId, workspaceKey, signal } = {}) {
    if (typeof runId !== 'string' || runId === '') {
      return Promise.reject(new AdmissionError({
        message: 'acquire 需要非空的 runId',
        status: 400,
        code: 'RUN_ID_REQUIRED',
        scope: 'global',
        reason: 'invalid-run-id',
      }))
    }
    const key = typeof workspaceKey === 'string' && workspaceKey !== '' ? workspaceKey : 'default'
    return new Promise((resolve, reject) => {
      // 1) 同一 runId 在 queued / reserved / running 都拒绝（一个 run 只能占一张票）。
      const existing = state.entries.get(runId)
      if (existing) {
        reject(alreadyActiveError(runId, existing.state))
        return
      }
      // 2) 已 abort 的 signal 直接取消，不占任何账。
      if (signalAborted(signal)) {
        reject(cancelledError(runId, 'signal'))
        return
      }
      // 3) 工作区满：立即拒绝（不排队）。
      const workspaceUsed = state.workspaces.get(key) || 0
      if (workspaceUsed >= state.perWorkspace) {
        reject(limitError({
          reason: 'workspace-full',
          scope: 'workspace',
          runId,
          workspaceKey: key,
          active: workspaceUsed,
          max: state.perWorkspace,
        }))
        return
      }
      // 4) 队列为空且全局有空位：直接发槽位（不经过队列）。
      if (state.queue.length === 0 && state.active < state.global) {
        const entry = {
          runId,
          workspaceKey: key,
          state: 'reserved',
          queuedAt: null,
          timer: null,
          onAbort: null,
          signal: null,
          resolve,
          reject,
          release: null,
          released: false,
        }
        state.entries.set(runId, entry)
        reserve(entry)
        return
      }
      // 5) 需要排队：队列满 / 禁止排队 → queue-full。
      if (state.queueMax <= 0 || state.queue.length >= state.queueMax) {
        reject(limitError({
          reason: 'queue-full',
          scope: 'global',
          runId,
          workspaceKey: key,
          active: state.active,
          max: state.global,
        }))
        return
      }
      const entry = {
        runId,
        workspaceKey: key,
        state: 'queued',
        queuedAt: isoOf(now),
        timer: null,
        onAbort: null,
        signal,
        resolve,
        reject,
        release: null,
        released: false,
      }
      state.entries.set(runId, entry)
      state.queue.push(entry)
      // 排队超时：原子摘票后拒绝（不占槽位、不留在队里），reason 必须是 queue-timeout。
      entry.timer = setTimeout(() => {
        if (entry.state !== 'queued' || entry.released) return
        entry.released = true
        cleanupEntry(entry)
        dequeue(entry)
        if (state.entries.get(runId) === entry) state.entries.delete(runId)
        reject(limitError({
          reason: 'queue-timeout',
          scope: 'global',
          runId,
          workspaceKey: key,
          active: state.active,
          max: state.global,
        }))
        pump()
      }, state.queueTimeoutMs)
      // 故意**不** unref 排队计时器：排队中的 acquire 是一个真实等待，
      // 进程若只剩这个等待也应该让超时按时触发（dispose 会 cancel 并清掉计时器）。
      if (signal && typeof signal.addEventListener === 'function') {
        entry.onAbort = () => {
          if (entry.state !== 'queued' || entry.released) return
          releaseEntry(entry, { cancelReason: 'signal' })
        }
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
    })
  }

  function admissionOf(runId) {
    const entry = state.entries.get(runId)
    if (!entry) return null
    if (entry.state === 'queued') {
      const index = state.queue.indexOf(entry)
      return {
        state: 'queued',
        queuedAt: entry.queuedAt,
        position: index < 0 ? 0 : index + 1,
        timeoutMs: state.queueTimeoutMs,
      }
    }
    return { state: entry.state }
  }

  function markRunning(runId) {
    const entry = state.entries.get(runId)
    if (!entry) return false
    if (entry.state === 'reserved') entry.state = 'running'
    return entry.state === 'running'
  }

  function release(runId) {
    const entry = state.entries.get(runId)
    if (!entry) return false
    return releaseEntry(entry, { cancelReason: 'released' })
  }

  function cancel(runId, reason = 'cancelled') {
    const entry = state.entries.get(runId)
    if (!entry) return false
    return releaseEntry(entry, { cancelReason: typeof reason === 'string' && reason !== '' ? reason : 'cancelled' })
  }

  function snapshot() {
    return {
      active: state.active,
      global: state.global,
      workspaces: Object.fromEntries([...state.workspaces.entries()].filter(([, used]) => used > 0)),
      queued: state.queue
        .filter(entry => !entry.released)
        .map((entry, index) => ({
          runId: entry.runId,
          workspaceKey: entry.workspaceKey,
          queuedAt: entry.queuedAt,
          position: index + 1,
          timeoutMs: state.queueTimeoutMs,
        })),
    }
  }

  return {
    acquire,
    admissionOf,
    markRunning,
    release,
    cancel,
    snapshot,
    get limits() {
      return {
        global: state.global,
        perWorkspace: state.perWorkspace,
        warnings: [...state.warnings],
      }
    },
    get queueMax() {
      return state.queueMax
    },
    get queueTimeoutMs() {
      return state.queueTimeoutMs
    },
    /** 共享状态容器（测试注入 / 诊断用；不要直接改内部字段）。 */
    controller,
  }
}
