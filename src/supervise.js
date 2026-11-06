/**
 * 内建 supervision 调度（07-runtime-0.7 §7 / §8）。
 *
 * 职责边界：本模块**只负责调度**——什么时候该唤醒、同一 `nextDueAt` 只唤醒一次、
 * 连续失败几次后降级。真正调用 `agents.get` / `agents.resume` + `followup` 的
 * `wake(runId, { wakerSessionId })` 由 runtime 注入（runtime 是唯一知道 dsh
 * agents 服务、会话句柄与提示词的地方）；本模块不 import 任何 dsh 包，也不直接
 * 读写 run.json：时钟、审计、唤醒、读写、日志全部由构造参数注入。
 *
 * 间隔口径与 `audit.js` 的 `nextCheckSeconds` 一致：
 *   pending 30s / healthy 180s / 异常 60s / 终态 null（停止）。
 *
 * 时间：对外字段一律 ISO-8601 字符串；任何坏日期（非法字符串 / NaN / 空值）
 * 都不抛错，按「当成 now」处理。
 *
 * @module @feiyueve/dsh-flow-studio/supervise
 */

/** 下次唤醒间隔（秒）：终态不在表里 → null（停止调度）。 */
export const SUPERVISION_INTERVALS = Object.freeze({
  healthy: 180,
  anomaly: 60,
  pending: 30,
})

/** 连续唤醒失败达到这个次数就降级：enabled=false + reason='wake-failed: ...'。 */
const MAX_WAKE_FAILURES = 3

/** 审计 verdict 里的终态全集（顺序无关）。 */
const TERMINAL_VERDICTS = new Set(['done', 'failed', 'aborted'])

/** run 状态里的终态全集（run.status 比 verdict 更权威时也要能收口）。 */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'aborted'])

/** 非终态的已知 verdict：除 pending / healthy 之外一律按异常侧 60s 处理。 */
const KNOWN_VERDICTS = new Set(['pending', 'healthy', 'stalled', 'looping', 'deviating', 'no-progress'])

const DEFAULT_INTERVAL_MS = 15_000

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 宽松时间解析：Date / 毫秒数 / ISO 字符串；解析不了返回 null（绝不抛错）。 */
function toMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/** now 参数收敛成毫秒；坏值退回当前墙钟。 */
function nowMsOf(value) {
  return toMs(value) ?? Date.now()
}

function isoOf(ms) {
  return new Date(ms).toISOString()
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error ?? 'unknown error')
}

/** 非负整数收敛（缺失 / 坏值按 0）。 */
function nonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

/** 把任意 verdict 收敛成字符串；空串 / 非字符串一律视为「未知」。 */
function verdictOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function intervalForReason(reason) {
  if (reason === 'pending') return SUPERVISION_INTERVALS.pending
  if (reason === 'healthy') return SUPERVISION_INTERVALS.healthy
  return SUPERVISION_INTERVALS.anomaly
}

/**
 * 计算「下一次该不该唤醒」。
 *
 * 规则（07 §7）：
 *   - verdict 或 run.status 是终态（done|failed|aborted）→ 不再唤醒；
 *   - pending → 30s；healthy → 180s；其余已知异常 → 60s；
 *   - 未知 verdict → 60s（异常侧保守），reason 写 `unknown-verdict`；
 *   - 基准时间：`lastWokeAt ?? run.startedAt ?? now`，再加间隔；
 *   - `shouldWake = now >= nextDueAt` 且 run 仍在跑（status 明确为 running / pending）。
 *
 * @param {object} [input]
 * @param {object|null} [input.run] run 摘要（至少可能有 status / startedAt）
 * @param {number|Date|string} [input.now] 当前时间（毫秒数 / Date / ISO）
 * @param {string|null} [input.verdict] `auditWorkflow` 的 verdict
 * @param {string|number|Date|null} [input.lastWokeAt] 上次成功/尝试唤醒的时间
 * @returns {{ shouldWake: boolean, nextDueAt: string|null, reason: string }}
 */
export function planWake({ run, now, verdict, lastWokeAt } = {}) {
  const nowMs = nowMsOf(now)
  const runObject = isPlainObject(run) ? run : {}
  const status = typeof runObject.status === 'string' ? runObject.status : null
  const normalizedVerdict = verdictOf(verdict)

  // 终态优先：verdict 与 run.status 任一收口，都停止调度（宁可少叫一次，不叫醒已结束的 run）。
  const terminal = (normalizedVerdict !== null && TERMINAL_VERDICTS.has(normalizedVerdict))
    || (status !== null && TERMINAL_STATUSES.has(status))
  if (terminal) {
    return { shouldWake: false, nextDueAt: null, reason: 'terminal' }
  }

  let reason
  if (normalizedVerdict === 'pending') reason = 'pending'
  else if (normalizedVerdict === 'healthy') reason = 'healthy'
  else if (normalizedVerdict !== null && KNOWN_VERDICTS.has(normalizedVerdict)) reason = 'anomaly'
  else reason = 'unknown-verdict'

  // 基准时间：lastWokeAt 存在就只认它（坏值按 now），否则退 run.startedAt，再退 now。
  let baseMs
  if (lastWokeAt !== undefined && lastWokeAt !== null) {
    baseMs = toMs(lastWokeAt) ?? nowMs
  } else if (runObject.startedAt !== undefined && runObject.startedAt !== null) {
    baseMs = toMs(runObject.startedAt) ?? nowMs
  } else {
    baseMs = nowMs
  }

  const nextDueMs = baseMs + intervalForReason(reason) * 1000
  // 「仍在跑」只认明确的运行态：missing / 未知 status 都不唤醒（宁可少叫一次，
  // 也不叫醒一个状态不明的 run）。pending 也算在跑，只是间隔更短。
  const stillRunning = status === 'running' || status === 'pending'
  return {
    shouldWake: stillRunning && nowMs >= nextDueMs,
    nextDueAt: isoOf(nextDueMs),
    reason,
  }
}

/** 把 load() 的结果收敛成已知字段；非法输入返回 null（按「无持久化状态」处理）。 */
function normalizeSupervision(raw) {
  if (!isPlainObject(raw)) return null
  return {
    enabled: raw.enabled !== false,
    wakerSessionId: typeof raw.wakerSessionId === 'string' && raw.wakerSessionId !== '' ? raw.wakerSessionId : null,
    lastWokeAt: typeof raw.lastWokeAt === 'string' && toMs(raw.lastWokeAt) !== null ? raw.lastWokeAt : null,
    nextDueAt: typeof raw.nextDueAt === 'string' && toMs(raw.nextDueAt) !== null ? raw.nextDueAt : null,
    wakes: nonNegativeInt(raw.wakes),
    failures: nonNegativeInt(raw.failures),
    reason: typeof raw.reason === 'string' && raw.reason !== '' ? raw.reason : null,
  }
}

/**
 * supervision 调度器。一个 FlowRuntime 只起一个实例、只起一个 `setInterval`。
 *
 * 依赖全部注入（测试里用假时钟 / 假审计 / 假唤醒）：
 *   - `now()` → 当前时间（Date / 毫秒数 / ISO 均可）；
 *   - `evaluate(runId)` → `{ verdict, run }`（runtime 内部调 auditWorkflow 后喂进来）；
 *   - `wake(runId, { wakerSessionId })` → 真正的 `agents.get/resume + followup`，
 *     返回 false 表示唤醒失败；抛错同样算失败；
 *   - `load(runId)` / `save(runId, supervision)` → run.json 的 supervision 持久化；
 *   - `log(level, msg)` → 带级别的日志（本模块只用 info / warn）。
 *
 * 注意：`register()` 是**显式启用**动作。从 run.json 恢复时，runtime 只应为
 * `supervision.enabled !== false` 的 run 调 register；已降级的 run 不要自动登记。
 */
export class SupervisionScheduler {
  /**
   * @param {object} [options]
   * @param {() => (number|Date|string)} [options.now]
   * @param {(runId: string) => Promise<{ verdict?: string, run?: object }>} options.evaluate
   * @param {(runId: string, ctx: { wakerSessionId: string|null }) => Promise<unknown>|unknown} options.wake
   * @param {(runId: string) => Promise<object|null>|object|null} options.load
   * @param {(runId: string, supervision: object) => Promise<unknown>|unknown} options.save
   * @param {(level: string, message: string) => void} [options.log]
   * @param {number} [options.intervalMs=15000]
   * @param {Function} [options.setInterval]
   * @param {Function} [options.clearInterval]
   */
  constructor(options = {}) {
    const opts = isPlainObject(options) ? options : {}
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this._evaluate = typeof opts.evaluate === 'function' ? opts.evaluate : null
    this._wake = typeof opts.wake === 'function' ? opts.wake : null
    this._load = typeof opts.load === 'function' ? opts.load : null
    this._save = typeof opts.save === 'function' ? opts.save : null
    this._log = typeof opts.log === 'function' ? opts.log : () => {}
    this._intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0
      ? opts.intervalMs
      : DEFAULT_INTERVAL_MS
    this._setInterval = typeof opts.setInterval === 'function' ? opts.setInterval : globalThis.setInterval
    this._clearInterval = typeof opts.clearInterval === 'function' ? opts.clearInterval : globalThis.clearInterval
    /** runId → 内存状态；持久化状态在 tick 时通过 load() 合并进来。 */
    this._runs = new Map()
    this._timer = null
    this._ticking = false
  }

  /** 启动周期扫描。幂等：重复调用不叠加定时器。返回是否真的新起了定时器。 */
  start() {
    if (this._timer !== null) return false
    this._timer = this._setInterval(() => {
      // tick() 自己保证不 reject；这里再兜一层，避免注入实现意外把进程带崩。
      void this.tick().catch(error => this._safeLog('warn', `supervision tick 异常：${errorMessage(error)}`))
    }, this._intervalMs)
    return true
  }

  /** 停掉定时器。幂等；不清空已注册 run（重启 start 后继续用原状态）。 */
  stop() {
    if (this._timer === null) return false
    const timer = this._timer
    this._timer = null
    try {
      this._clearInterval(timer)
    } catch (error) {
      this._safeLog('warn', `supervision 清理定时器失败：${errorMessage(error)}`)
    }
    return true
  }

  /**
   * 登记一个需要 supervision 的 run（显式启用）。
   * @param {string} runId
   * @param {{ wakerSessionId?: string }} [options]
   * @returns {{ enabled: boolean, nextDueAt: string|null, wakes: number, failures: number, lastReason: string|null }}
   */
  register(runId, options = {}) {
    if (typeof runId !== 'string' || runId === '') throw new TypeError('runId 必须是非空字符串')
    const wakerSessionId = isPlainObject(options) && typeof options.wakerSessionId === 'string' && options.wakerSessionId !== ''
      ? options.wakerSessionId
      : null
    let entry = this._runs.get(runId)
    if (!entry) {
      entry = {
        runId,
        wakerSessionId,
        enabled: true,
        initialized: false,
        lastWokeAt: null,
        nextDueAt: null,
        wakes: 0,
        failures: 0,
        lastReason: null,
        registeredAt: isoOf(this._nowMs()),
      }
      this._runs.set(runId, entry)
    } else {
      // 重复登记不叠加、不清零；只补 wakerSessionId（后者优先）。
      entry.enabled = true
      if (wakerSessionId !== null) entry.wakerSessionId = wakerSessionId
    }
    return this.status(runId)
  }

  /** 摘除登记（降级 / 终态 / 用户关闭 / 外部禁用都会走到这里）。返回是否真的摘掉了。 */
  unregister(runId) {
    return this._runs.delete(runId)
  }

  /**
   * 查询内存里的调度状态。未登记的 run 返回 `enabled:false` + `lastReason:'not-registered'`。
   * @returns {{ enabled: boolean, nextDueAt: string|null, wakes: number, failures: number, lastReason: string|null }}
   */
  status(runId) {
    const entry = this._runs.get(runId)
    if (!entry) {
      return { enabled: false, nextDueAt: null, wakes: 0, failures: 0, lastReason: 'not-registered' }
    }
    return {
      enabled: entry.enabled !== false,
      nextDueAt: entry.nextDueAt ?? null,
      wakes: nonNegativeInt(entry.wakes),
      failures: nonNegativeInt(entry.failures),
      lastReason: entry.lastReason ?? null,
    }
  }

  /**
   * 扫描一轮。重入时直接返回 `{ skipped: true }`，绝不并发跑两轮。
   * 单个 run 的 load / evaluate / wake / save 抛错只影响该 run（被 catch + log），
   * 其余 run 照常推进；本方法本身永远 resolve。
   *
   * @returns {Promise<{ skipped: boolean, runs: number, woken: number, failed: number }>}
   */
  async tick() {
    if (this._ticking) return { skipped: true, runs: 0, woken: 0, failed: 0 }
    this._ticking = true
    const stats = { skipped: false, runs: 0, woken: 0, failed: 0 }
    try {
      // 快照当前登记，允许 tick 过程中 unregister 不影响本轮其它 run。
      for (const [runId, entry] of [...this._runs.entries()]) {
        stats.runs += 1
        try {
          const outcome = await this._tickRun(runId, entry)
          if (outcome === 'woken') stats.woken += 1
          else if (outcome === 'failed') stats.failed += 1
        } catch (error) {
          stats.failed += 1
          this._safeLog('warn', `supervision: ${runId} 本轮跳过：${errorMessage(error)}`)
        }
      }
    } finally {
      this._ticking = false
    }
    return stats
  }

  // -------------------------------------------------------------------------
  // 内部：单个 run 的一轮
  // -------------------------------------------------------------------------

  async _tickRun(runId, entry) {
    // 1) 读持久化状态：用于重启恢复与「外部禁用」检测。读失败继续用内存状态。
    let persisted = null
    try {
      persisted = normalizeSupervision(await this._require('load', this._load)(runId))
    } catch (error) {
      this._safeLog('warn', `supervision: ${runId} 读取 supervision 失败，沿用内存状态：${errorMessage(error)}`)
    }

    let reEnabled = false
    if (persisted) {
      if (persisted.enabled === false) {
        if (entry.initialized) {
          // 本实例已经跑过至少一轮，此时磁盘上是 disabled → 尊重它（外部关闭 / 另一进程降级）。
          this.unregister(runId)
          this._safeLog('info', `supervision: ${runId} 已禁用（${persisted.reason || 'unknown'}），停止唤醒`)
          return 'skipped'
        }
        // 首次 tick 且磁盘是 disabled：register 是显式重新启用，旧计数作废，重新开始。
        entry.wakes = 0
        entry.failures = 0
        entry.lastWokeAt = null
        entry.nextDueAt = null
        entry.lastReason = null
        reEnabled = true
      } else if (!entry.initialized) {
        // 重启恢复：沿用落盘的计数与基准时间。
        entry.wakes = persisted.wakes
        entry.failures = persisted.failures
        entry.lastWokeAt = persisted.lastWokeAt
        entry.nextDueAt = persisted.nextDueAt
        if (entry.wakerSessionId === null && persisted.wakerSessionId) entry.wakerSessionId = persisted.wakerSessionId
        if (persisted.reason) entry.lastReason = persisted.reason
      } else if (this._isFresher(persisted, entry)) {
        // 另一个进程刚唤醒过：以更新的 lastWokeAt 为准，避免重复唤醒。
        entry.lastWokeAt = persisted.lastWokeAt
        entry.nextDueAt = persisted.nextDueAt
        entry.wakes = Math.max(entry.wakes, persisted.wakes)
        entry.failures = Math.max(entry.failures, persisted.failures)
        if (entry.wakerSessionId === null && persisted.wakerSessionId) entry.wakerSessionId = persisted.wakerSessionId
      }
    }
    entry.initialized = true

    // 2) 审计 → verdict / run 摘要由 runtime 的 evaluate 注入。
    const evaluation = await this._require('evaluate', this._evaluate)(runId)
    const run = isPlainObject(evaluation) && isPlainObject(evaluation.run) ? evaluation.run : null
    const verdict = isPlainObject(evaluation) ? verdictOf(evaluation.verdict) : null
    const nowMs = this._nowMs()
    const plan = planWake({ run, now: nowMs, verdict, lastWokeAt: entry.lastWokeAt })
    entry.lastReason = plan.reason
    entry.nextDueAt = plan.nextDueAt

    // 3) 终态：落盘 enabled=false、摘除登记，此后不再尝试。
    if (plan.reason === 'terminal') {
      entry.enabled = false
      entry.nextDueAt = null
      await this._persist(runId, entry, { enabled: false, reason: 'terminal' })
      this.unregister(runId)
      this._safeLog('info', `supervision: ${runId} 已收口（terminal），停止调度`)
      return 'terminal'
    }

    // 4) 未到点：只更新/初始化 nextDueAt，不唤醒。
    if (!plan.shouldWake) {
      if (reEnabled || !persisted || persisted.nextDueAt !== plan.nextDueAt) {
        await this._persist(runId, entry)
      }
      return 'idle'
    }

    // 5) 到点：唤醒一次，并立刻推进 nextDueAt（成功失败都推进，避免同一 due 反复叫）。
    const wakerSessionId = entry.wakerSessionId ?? null
    let wakeOk = false
    let failureReason = null
    try {
      const result = await this._require('wake', this._wake)(runId, { wakerSessionId })
      wakeOk = result !== false
      if (!wakeOk) failureReason = 'wake 返回 false'
    } catch (error) {
      wakeOk = false
      failureReason = errorMessage(error)
    }

    const wokeAtIso = isoOf(nowMs)
    // 以本次唤醒时间为新基准重新算间隔；唤醒失败同样推进 nextDueAt。
    const nextPlan = planWake({ run, now: nowMs, verdict, lastWokeAt: wokeAtIso })
    entry.lastWokeAt = wokeAtIso
    entry.nextDueAt = nextPlan.nextDueAt

    if (!wakeOk) {
      entry.failures = nonNegativeInt(entry.failures) + 1
      if (entry.failures >= MAX_WAKE_FAILURES) {
        entry.enabled = false
        entry.lastReason = `wake-failed: ${failureReason}`
        await this._persist(runId, entry, { enabled: false, reason: entry.lastReason })
        this.unregister(runId)
        this._safeLog('warn', `supervision: ${runId} 连续 ${entry.failures} 次唤醒失败，已降级并停止调度：${failureReason}`)
        return 'failed'
      }
      await this._persist(runId, entry)
      this._safeLog('warn', `supervision: ${runId} 第 ${entry.failures} 次唤醒失败（连续 ${MAX_WAKE_FAILURES} 次后降级）：${failureReason}`)
      return 'failed'
    }

    entry.wakes = nonNegativeInt(entry.wakes) + 1
    entry.failures = 0
    await this._persist(runId, entry)
    this._safeLog('info', `supervision: ${runId} 第 ${entry.wakes} 次唤醒成功（${plan.reason}），下次 ${entry.nextDueAt}`)
    return 'woken'
  }

  /** 判断持久化状态是否比内存状态更新（lastWokeAt 更晚）。 */
  _isFresher(persisted, entry) {
    const persistedAt = toMs(persisted.lastWokeAt)
    if (persistedAt === null) return false
    const entryAt = toMs(entry.lastWokeAt)
    return entryAt === null || persistedAt > entryAt
  }

  /** 依赖缺失时报明确的错（会被 per-run catch 转成 warn，不崩 tick）。 */
  _require(name, fn) {
    if (typeof fn !== 'function') throw new TypeError(`SupervisionScheduler 缺少注入：${name}`)
    return fn
  }

  _nowMs() {
    return nowMsOf(typeof this._now === 'function' ? this._now() : this._now)
  }

  /** 落盘当前内存状态；save 抛错只记 warn，绝不打断 tick。返回是否写成功。 */
  async _persist(runId, entry, overrides = {}) {
    const payload = {
      enabled: entry.enabled !== false,
      wakerSessionId: entry.wakerSessionId ?? null,
      lastWokeAt: entry.lastWokeAt ?? null,
      nextDueAt: entry.nextDueAt ?? null,
      wakes: nonNegativeInt(entry.wakes),
      failures: nonNegativeInt(entry.failures),
      reason: entry.lastReason ?? null,
      ...overrides,
    }
    try {
      await this._require('save', this._save)(runId, payload)
      return true
    } catch (error) {
      this._safeLog('warn', `supervision: ${runId} 写入 supervision 失败（内存状态已推进）：${errorMessage(error)}`)
      return false
    }
  }

  _safeLog(level, message) {
    try {
      this._log(level, message)
    } catch {
      // 日志实现抛错不该影响调度。
    }
  }
}
