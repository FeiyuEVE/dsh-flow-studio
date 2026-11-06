/**
 * 内建 supervision 调度（07-runtime-0.7 §7 / §8 / §11）。
 *
 * 本文件有两级调度器，共用同一套注入风格（时钟 / 唤醒 / 日志 / 定时器全部注入）：
 *   - `SupervisionScheduler`：run 级，按审计 verdict 决定间隔，可落盘恢复；
 *   - `NodeSupervisionScheduler`：节点级（v0.8 / R8），每个节点主管会话一个闹钟，
 *     到点让节点自审并回报结构化状态。节点闹钟**只在内存里**，不落盘，attempt
 *     结束 / run 收尾时由 engine 注销。
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

/**
 * 单条 entry 一轮唤醒的默认超时（毫秒）。
 *
 * 为什么必须有：`wake` 链路最终会 `await agent.whenIdle()` 之类的长操作。某个 run
 * 的节点会话永不 idle 时，没有超时就会把**整轮 tick** 永远吊住——进程还活着，但
 * 调度器事实性死亡，其它 run 再也得不到巡检（E1-a）。
 *
 * 超时后的契约：
 *   - 向注入的 `wake` 传 `AbortSignal` 并 abort（实现可以据此收手）；
 *   - 这一条记为 `timeout`（计入 `timeouts`、按失败累计，连续 3 次同样降级）；
 *   - 推进 `nextDueAt`，同轮其它条照常推进，绝不互相拖累；
 *   - 迟到的结果由 entry.epoch 丢弃，不会污染下一轮状态。
 *
 * 注意这是**每条 entry 一轮**（load / evaluate / wake / persist）的上限，不是
 * 「一次 tick」的上限；整轮 tick 的耗时见 `snapshot().tick.lastDurationMs`。
 */
export const SUPERVISION_WAKE_TIMEOUT_MS = 60_000

/**
 * 一轮 tick 里同时唤醒的最大 entry 数。
 *
 * 有界并发（默认 4）保证一个慢 run 只占住自己那个 worker，不会把整轮拖成串行；
 * 同一条 run 的多个节点仍串行（见 `NodeSupervisionScheduler.tick` 的分组）。
 */
export const SUPERVISION_MAX_CONCURRENCY = 4

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
 * 有界并发跑一组 thunk（thunk 自己负责不 reject）。结果数组与 tasks 顺序一致。
 *
 * 实现是「游标 + N 个 worker」而不是 `Promise.all(chunked)`：任一 task 挂住只占住
 * 它自己那个 worker，其它 worker 继续消费队列；同一时刻在飞的条数永不超过 limit。
 */
async function runPool(tasks, limit) {
  if (!Array.isArray(tasks) || tasks.length === 0) return []
  const size = Math.min(Number.isInteger(limit) && limit > 0 ? limit : SUPERVISION_MAX_CONCURRENCY, tasks.length)
  const results = new Array(tasks.length)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= tasks.length) return
      try {
        results[index] = await tasks[index]()
      } catch {
        // 调用方的 thunk 已有自己的 catch；这里再兜一层，保证 runPool 永不 reject。
        results[index] = undefined
      }
    }
  }
  await Promise.all(Array.from({ length: size }, worker))
  return results
}

/**
 * 每次 entry 唤醒的独立超时执行器（E1-a）。
 *
 * 语义：
 *   - `run(factory, timeoutMs)` 返回 `{ status: 'ok'|'timeout'|'error'|'aborted', value?, error? }`，
 *     **永不 reject**；
 *   - 正常/超时/abort 三路都会清掉 setTimeout，不留悬挂 timer（timer 另外 unref，
 *     即便注入实现忘了清也不会拖住进程退出）；
 *   - 超时先 abort 再结算；底层 promise 后续的 resolve/reject 被 `settled` 丢弃，
 *     迟到的业务结果由调用方的 epoch 守卫再挡一层；
 *   - `abortAll(reason)` 给 stop()/dispose() 用：结算所有在飞 entry，清掉它们的 timer。
 */
function createWakeRunner({ setTimeoutFn, clearTimeoutFn }) {
  const inflight = new Set()
  return {
    get active() {
      return inflight.size
    },
    run(factory, timeoutMs) {
      return new Promise(resolve => {
        const controller = new AbortController()
        let settled = false
        const record = { controller, timer: null, settle: null }
        const finish = outcome => {
          if (settled) return
          settled = true
          if (record.timer !== null) {
            try {
              clearTimeoutFn(record.timer)
            } catch {
              // 清理失败不影响结算。
            }
            record.timer = null
          }
          inflight.delete(record)
          resolve(outcome)
        }
        record.settle = finish
        inflight.add(record)

        try {
          record.timer = setTimeoutFn(() => {
            record.timer = null
            try {
              controller.abort(new Error(`唤醒超时（${timeoutMs}ms）`))
            } catch {
              // abort 失败也要照常结算。
            }
            finish({ status: 'timeout' })
          }, timeoutMs)
          // 不拖住进程退出：真实 setTimeout 返回的 Timeout 带 unref。
          try {
            record.timer?.unref?.()
          } catch {
            // 浏览器 / 桩定时器没有 unref，忽略。
          }
        } catch (error) {
          finish({ status: 'error', error })
          return
        }

        let promise
        try {
          promise = Promise.resolve(factory(controller.signal))
        } catch (error) {
          finish({ status: 'error', error })
          return
        }
        promise.then(
          value => finish({ status: 'ok', value }),
          error => finish({ status: 'error', error }),
        )
      })
    },
    /** 结算所有在飞 entry（stop / dispose）并清 timer；返回被结算的条数。 */
    abortAll(reason = 'scheduler-stopped') {
      const records = [...inflight]
      for (const record of records) {
        const error = new Error(reason)
        try {
          record.controller.abort(error)
        } catch {
          // abort 失败也要照常结算。
        }
        record.settle({ status: 'aborted', error })
      }
      return records.length
    },
  }
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
 *   - `wake(runId, { wakerSessionId, signal })` → 真正的 `agents.get/resume + followup`，
 *     返回 false 表示唤醒失败；抛错同样算失败；`signal` 是本次 entry 的 AbortSignal，
 *     超时 / stop 时会被 abort（实现可以据此收手，不理会也仍然会被 `epoch` 丢弃结果）；
 *   - `load(runId)` / `save(runId, supervision)` → run.json 的 supervision 持久化；
 *   - `log(level, msg)` → 带级别的日志（本模块只用 info / warn）。
 *
 * E1-a 并发口径：`tick()` 对每个 run（entry）起**独立超时**（`wakeTimeoutMs`），
 * 并按 `maxConcurrency` **有界并发**；一条卡死 / 抛错只影响它自己，不会让整轮停摆。
 *
 * 注意：`register()` 是**显式启用**动作。从 run.json 恢复时，runtime 只应为
 * `supervision.enabled !== false` 的 run 调 register；已降级的 run 不要自动登记。
 */
export class SupervisionScheduler {
  /**
   * @param {object} [options]
   * @param {() => (number|Date|string)} [options.now]
   * @param {(runId: string) => Promise<{ verdict?: string, run?: object }>} options.evaluate
   * @param {(runId: string, ctx: { wakerSessionId: string|null, signal?: AbortSignal }) => Promise<unknown>|unknown} options.wake
   * @param {(runId: string) => Promise<object|null>|object|null} options.load
   * @param {(runId: string, supervision: object) => Promise<unknown>|unknown} options.save
   * @param {(level: string, message: string) => void} [options.log]
   * @param {number} [options.intervalMs=15000]
   * @param {number} [options.wakeTimeoutMs=SUPERVISION_WAKE_TIMEOUT_MS] 单条 entry 一轮的超时
   * @param {number} [options.maxConcurrency=SUPERVISION_MAX_CONCURRENCY] 一轮 tick 的并发上限
   * @param {Function} [options.setInterval]
   * @param {Function} [options.clearInterval]
   * @param {Function} [options.setTimeout] 单条超时定时器（测试可注入；缺省 globalThis.setTimeout）
   * @param {Function} [options.clearTimeout]
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
    this._wakeTimeoutMs = Number.isFinite(opts.wakeTimeoutMs) && opts.wakeTimeoutMs > 0
      ? opts.wakeTimeoutMs
      : SUPERVISION_WAKE_TIMEOUT_MS
    this._maxConcurrency = Number.isInteger(opts.maxConcurrency) && opts.maxConcurrency > 0
      ? opts.maxConcurrency
      : SUPERVISION_MAX_CONCURRENCY
    this._setInterval = typeof opts.setInterval === 'function' ? opts.setInterval : globalThis.setInterval
    this._clearInterval = typeof opts.clearInterval === 'function' ? opts.clearInterval : globalThis.clearInterval
    const setTimeoutFn = typeof opts.setTimeout === 'function' ? opts.setTimeout : globalThis.setTimeout
    const clearTimeoutFn = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : globalThis.clearTimeout
    this._wakeRunner = createWakeRunner({ setTimeoutFn, clearTimeoutFn })
    /** runId → 内存状态；持久化状态在 tick 时通过 load() 合并进来。 */
    this._runs = new Map()
    this._timer = null
    this._ticking = false
    // ── 可观测状态（只进 snapshot()，不改 status() 的对外契约） ──────────────
    this._tickCount = 0
    this._tickSkipped = 0
    this._lastTickStartedAt = null
    this._lastTickFinishedAt = null
    this._lastTickDurationMs = null
    this._lastTickStats = null
  }

  /** 单条 entry 一轮的超时（毫秒）。 */
  get wakeTimeoutMs() {
    return this._wakeTimeoutMs
  }

  /** 一轮 tick 的并发上限。 */
  get maxConcurrency() {
    return this._maxConcurrency
  }

  /** 启动周期扫描。幂等：重复调用不叠加定时器。返回是否真的新起了定时器。 */
  start() {
    if (this._timer !== null) return false
    const timer = this._setInterval(() => {
      // tick() 自己保证不 reject；这里再兜一层，避免注入实现意外把进程带崩。
      void this.tick().catch(error => this._safeLog('warn', `supervision tick 异常：${errorMessage(error)}`))
    }, this._intervalMs)
    // 定时器不该拖住进程退出（DSH 宿主里 interval 必须 unref）。
    try {
      timer?.unref?.()
    } catch {
      // 非 Node 定时器（测试桩 / 浏览器）没有 unref，忽略。
    }
    this._timer = timer
    return true
  }

  /**
   * 停掉定时器 + 结算所有在飞的 entry（abort signal 并清掉它们的超时 timer）。
   * 幂等；不清空已注册 run（重启 start 后继续用原状态）。
   */
  stop() {
    const hadTimer = this._timer !== null
    if (hadTimer) {
      const timer = this._timer
      this._timer = null
      try {
        this._clearInterval(timer)
      } catch (error) {
        this._safeLog('warn', `supervision 清理定时器失败：${errorMessage(error)}`)
      }
    }
    // 在飞 entry 不能留着：否则超时 timer / 底层 wake 会一直挂着（E1-a 的收尾要求）。
    const aborted = this._wakeRunner.abortAll('supervision-scheduler-stopped')
    if (aborted > 0) {
      this._safeLog('info', `supervision: 停止时结算 ${aborted} 条在飞唤醒`)
    }
    return hadTimer
  }

  /** `stop()` 的别名：让宿主统一用 dispose 语义收尾。返回是否真的停掉了定时器。 */
  dispose() {
    return this.stop()
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
        // E1-a 可观测 / 迟到结果丢弃：epoch 每轮 +1，超时后旧回合的结果一律作废。
        epoch: 0,
        lastOutcome: null,
        lastDurationMs: null,
        lastFinishedAt: null,
        lastError: null,
        timeouts: 0,
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
   *
   * E1-a 契约：
   *   - 每个 run（entry）一轮都在**独立超时**里跑（`wakeTimeoutMs`），超时记为
   *     `timeout` 并推进 `nextDueAt`，底层 wake 被 abort / 结果被 epoch 丢弃；
   *   - 一轮 tick **有界并发**（`maxConcurrency`），慢 / 挂的 run 只占住自己那个 worker；
   *   - 单个 run 的 load / evaluate / wake / save 抛错只影响该 run（被 catch + log），
   *     其余 run 照常推进；本方法本身永远 resolve。
   *
   * 返回字段保持老契约不变（`skipped/runs/woken/failed`）；超时计入 `failed`，
   * 每条的明细（lastOutcome / timeouts / 耗时）看 `snapshot()`。
   *
   * @returns {Promise<{ skipped: boolean, runs: number, woken: number, failed: number }>}
   */
  async tick() {
    if (this._ticking) {
      // 「上一轮没跑完就跳过」的语义保留，并记进快照便于诊断调度器是否在空转。
      this._tickSkipped += 1
      return { skipped: true, runs: 0, woken: 0, failed: 0 }
    }
    this._ticking = true
    const stats = { skipped: false, runs: 0, woken: 0, failed: 0 }
    const startedAtMs = Date.now()
    this._tickCount += 1
    this._lastTickStartedAt = isoOf(this._nowMs())
    try {
      // 快照当前登记，允许 tick 过程中 unregister 不影响本轮其它 run。
      const tasks = [...this._runs.entries()].map(([runId, entry]) => async () => {
        stats.runs += 1
        try {
          const outcome = await this._runEntry(runId, entry)
          if (outcome === 'woken') stats.woken += 1
          else if (outcome === 'failed' || outcome === 'timeout' || outcome === 'error') stats.failed += 1
        } catch (error) {
          stats.failed += 1
          this._safeLog('warn', `supervision: ${runId} 本轮跳过：${errorMessage(error)}`)
        }
      })
      await runPool(tasks, this._maxConcurrency)
    } finally {
      this._ticking = false
      this._lastTickFinishedAt = isoOf(this._nowMs())
      this._lastTickDurationMs = Math.max(0, Date.now() - startedAtMs)
      this._lastTickStats = { ...stats }
    }
    return stats
  }

  /**
   * 调度器可观测快照（flow_watch / 诊断用）。**只读、纯查询**：不触发 tick、不改状态。
   *
   * 与 `status(runId)` 的分工：`status` 是对外契约（5 个字段，别动）；这里是调度器
   * 健康度——每条的最近结果 / 耗时 / 超时次数，以及整轮 tick 的耗时与并发度。
   *
   * @returns {{
   *   kind: 'run', ticking: boolean, started: boolean, intervalMs: number,
   *   maxConcurrency: number, wakeTimeoutMs: number,
   *   concurrency: { limit: number, active: number },
   *   tick: { count: number, skipped: number, lastStartedAt: string|null,
   *     lastFinishedAt: string|null, lastDurationMs: number|null,
   *     lastStats: { runs: number, woken: number, failed: number }|null },
   *   entries: Array<object>,
   * }}
   */
  snapshot() {
    return {
      kind: 'run',
      ticking: this._ticking,
      started: this._timer !== null,
      intervalMs: this._intervalMs,
      maxConcurrency: this._maxConcurrency,
      wakeTimeoutMs: this._wakeTimeoutMs,
      concurrency: { limit: this._maxConcurrency, active: this._wakeRunner.active },
      tick: {
        count: this._tickCount,
        skipped: this._tickSkipped,
        lastStartedAt: this._lastTickStartedAt,
        lastFinishedAt: this._lastTickFinishedAt,
        lastDurationMs: this._lastTickDurationMs,
        lastStats: this._lastTickStats === null ? null : { ...this._lastTickStats },
      },
      entries: [...this._runs.values()].map(entry => ({
        runId: entry.runId,
        ...this.status(entry.runId),
        lastOutcome: entry.lastOutcome ?? null,
        lastDurationMs: entry.lastDurationMs ?? null,
        lastFinishedAt: entry.lastFinishedAt ?? null,
        timeouts: nonNegativeInt(entry.timeouts),
        lastError: entry.lastError ?? null,
      })),
    }
  }

  // -------------------------------------------------------------------------
  // 内部：单个 run 的一轮
  // -------------------------------------------------------------------------

  /** 单条 entry = 独立超时 + 结果归一化；超时/异常只影响这一条。 */
  async _runEntry(runId, entry) {
    const startedAtMs = Date.now()
    // 本轮的 lastError 由本轮结果决定；先清掉上一轮的残留。
    entry.lastError = null
    const result = await this._wakeRunner.run(
      signal => this._tickRun(runId, entry, signal),
      this._wakeTimeoutMs,
    )
    const durationMs = Math.max(0, Date.now() - startedAtMs)
    entry.lastDurationMs = durationMs
    entry.lastFinishedAt = isoOf(this._nowMs())

    if (result.status === 'timeout') {
      // 迟到的回合作废：_tickRun 每个 await 之后都会比对 epoch。
      entry.epoch = nonNegativeInt(entry.epoch) + 1
      const message = `唤醒超时（${this._wakeTimeoutMs}ms）`
      entry.lastOutcome = 'timeout'
      entry.lastError = message
      entry.timeouts = nonNegativeInt(entry.timeouts) + 1
      entry.failures = nonNegativeInt(entry.failures) + 1
      entry.nextDueAt = isoOf(this._nowMs() + SUPERVISION_INTERVALS.anomaly * 1000)
      entry.lastReason = `wake-timeout: ${message}`
      if (entry.failures >= MAX_WAKE_FAILURES) {
        entry.enabled = false
        // 这里**不 await** 落盘：超时处理已经花掉了预算，save 卡住不能反过来吊住 tick。
        // _persist 自己吞错、不 reject，所以 void 是安全的。
        void this._persist(runId, entry, { enabled: false, reason: entry.lastReason })
        this.unregister(runId)
        this._safeLog('warn', `supervision: ${runId} 连续 ${entry.failures} 次唤醒超时，已降级并停止调度：${message}`)
      } else {
        void this._persist(runId, entry)
        this._safeLog('warn', `supervision: ${runId} 唤醒超时（连续 ${MAX_WAKE_FAILURES} 次后降级）：${message}`)
      }
      return 'timeout'
    }

    if (result.status === 'aborted') {
      entry.lastOutcome = 'aborted'
      entry.lastError = errorMessage(result.error)
      return 'aborted'
    }

    if (result.status === 'error') {
      // 兜底：_tickRun 内部已尽量吞错，这里防止注入实现意外 reject。
      entry.lastOutcome = 'error'
      entry.lastError = errorMessage(result.error)
      entry.failures = nonNegativeInt(entry.failures) + 1
      this._safeLog('warn', `supervision: ${runId} 本轮跳过：${entry.lastError}`)
      return 'error'
    }

    const outcome = typeof result.value === 'string' ? result.value : 'idle'
    entry.lastOutcome = outcome
    return outcome
  }

  /** 当前回合是否已作废（超时 / stop / 被外部摘除）。作废的迟到结果一律不许写状态。 */
  _isStaleTurn(runId, entry, epoch) {
    return entry.epoch !== epoch || this._runs.get(runId) !== entry
  }

  async _tickRun(runId, entry, signal) {
    // 本轮 token：超时 / stop 会把 epoch 推进，之后每个 await 的续体都要比对。
    const epoch = nonNegativeInt(entry.epoch) + 1
    entry.epoch = epoch

    // 1) 读持久化状态：用于重启恢复与「外部禁用」检测。读失败继续用内存状态。
    let persisted = null
    try {
      persisted = normalizeSupervision(await this._require('load', this._load)(runId))
    } catch (error) {
      this._safeLog('warn', `supervision: ${runId} 读取 supervision 失败，沿用内存状态：${errorMessage(error)}`)
    }
    if (this._isStaleTurn(runId, entry, epoch)) return 'stale'

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
    if (this._isStaleTurn(runId, entry, epoch)) return 'stale'
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
      // signal 让 wake 实现有机会在超时 / stop 时收手（不理会也不会污染状态）。
      const result = await this._require('wake', this._wake)(runId, { wakerSessionId, signal })
      wakeOk = result !== false
      if (!wakeOk) failureReason = 'wake 返回 false'
    } catch (error) {
      wakeOk = false
      failureReason = errorMessage(error)
    }
    if (this._isStaleTurn(runId, entry, epoch)) return 'stale'

    const wokeAtIso = isoOf(nowMs)
    // 以本次唤醒时间为新基准重新算间隔；唤醒失败同样推进 nextDueAt。
    const nextPlan = planWake({ run, now: nowMs, verdict, lastWokeAt: wokeAtIso })
    entry.lastWokeAt = wokeAtIso
    entry.nextDueAt = nextPlan.nextDueAt

    if (!wakeOk) {
      entry.failures = nonNegativeInt(entry.failures) + 1
      entry.lastError = failureReason
      if (entry.failures >= MAX_WAKE_FAILURES) {
        entry.enabled = false
        entry.lastReason = `wake-failed: ${failureReason}`
        await this._persist(runId, entry, { enabled: false, reason: entry.lastReason })
        this.unregister(runId)
        this._safeLog('warn', `supervision: ${runId} 连续 ${entry.failures} 次唤醒失败，已降级并停止调度：${failureReason}`)
        return 'failed'
      }
      // 即使还没到降级阈值也把失败原因写进 lastReason，便于 flow_watch 观察。
      entry.lastReason = `wake-failed: ${failureReason}`
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

// ===========================================================================
// 11 节点闹钟（v0.8 / R8）
// ===========================================================================

/**
 * 节点自审默认间隔（毫秒）。`nodeAlarmMs = 600s`（10 分钟，07-runtime-0.7 §11.1；
 * 用户反馈 120s 太频繁，一轮自审要起一次模型回合，别按分钟级挠），
 * 这里按毫秒给：register 时的 `nextDueAt = now + intervalMs`。
 *
 * **与 `SUPERVISION_INTERVALS` 是两套独立的时钟，别混**（07-runtime-0.7 §7 / §11）：
 *   - `SUPERVISION_INTERVALS` 是 **run 级巡检**（30 / 180 / 60 **秒**）：由
 *     `auditWorkflow` 的 verdict 决定，唤醒的是 run 的发起会话，问「整个 run 是否健康」；
 *   - `NODE_ALARM_DEFAULT_MS` 是 **节点闹钟**（默认 600 **秒**，毫秒单位）：每个节点
 *     主管会话一个闹钟，问「你这个节点现在什么状态」。它只在内存里、不落盘，由
 *     engine 在 attempt 结束 / run 收尾时注销。
 * 两者互不驱动：节点自审结果由 engine 自己消费（可提前收口 attempt），不会改 run 级
 * 的 nextDueAt；run 级到点唤醒也不触发节点自审。改一个不影响另一个。
 */
export const NODE_ALARM_DEFAULT_MS = 600_000

/** 连续唤醒失败达到这个次数就停摆：enabled=false + reason='wake-failed: ...'。 */
const NODE_ALARM_MAX_FAILURES = 3

/** 节点自审回报里 state 的合法枚举（缺失 / 非法 → 'working'）。 */
const NODE_STATES = new Set(['working', 'done', 'blocked', 'failed'])

/** 单个回报里 members / blockers 的条数上限。 */
const NODE_LIST_LIMIT = 20

/** summary / blocker 单条的字符上限。 */
const NODE_SUMMARY_LIMIT = 2000
const NODE_BLOCKER_LIMIT = 200

/** 非空字符串 → 去空白后的值；其它（含空串 / 非字符串）→ null。 */
function nonEmptyString(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 文本字段收敛：非字符串 → ''，超长按字符截断。 */
function textOf(value, limit) {
  if (typeof value !== 'string') return ''
  return value.length > limit ? value.slice(0, limit) : value
}

/** 节点 / 成员状态：只认四个枚举，其它一律回落 'working'。 */
function nodeStateOf(value) {
  if (typeof value !== 'string') return 'working'
  const state = value.trim()
  return NODE_STATES.has(state) ? state : 'working'
}

/** progress：0..100 的整数；越界夹紧、非数（含数值字符串）→ 0、小数四舍五入。 */
function progressOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** verdict：只认真实枚举 pass / reject，其它（含大小写不符、非字符串）→ null。 */
function nodeVerdictOf(value) {
  if (typeof value !== 'string') return null
  const verdict = value.trim()
  return verdict === 'pass' || verdict === 'reject' ? verdict : null
}

/** attempt：非负整数才保留，其它 → null。 */
function attemptOf(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** members：最多 20 条；非对象条目丢弃，缺字段给默认值。 */
function membersOf(value) {
  if (!Array.isArray(value)) return []
  const members = []
  for (const item of value) {
    if (members.length >= NODE_LIST_LIMIT) break
    if (!isPlainObject(item)) continue
    members.push({
      name: typeof item.name === 'string' ? item.name.trim() : '',
      state: nodeStateOf(item.state),
      note: typeof item.note === 'string' ? item.note.trim() : '',
    })
  }
  return members
}

/** blockers：最多 20 条、每条 ≤200；非字符串 / 空串丢弃。 */
function blockersOf(value) {
  if (!Array.isArray(value)) return []
  const blockers = []
  for (const item of value) {
    if (blockers.length >= NODE_LIST_LIMIT) break
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    blockers.push(textOf(text, NODE_BLOCKER_LIMIT))
  }
  return blockers
}

/**
 * 从模型输出里挑候选 JSON 片段（顺序即优先级）：
 *   1. ```json / ``` 围栏正文（按出现顺序）；
 *   2. 去掉所有围栏后，首个 `{` 到末个 `}` 的裸 JSON。
 * 围栏正文坏掉时还能回落到裸 JSON；全都解析不出来 → 空数组。
 */
function jsonPayloadCandidates(text) {
  const candidates = []
  const fence = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n?([\s\S]*?)```/g
  let stripped = ''
  let lastIndex = 0
  let match
  while ((match = fence.exec(text)) !== null) {
    const lang = (match[1] ?? '').toLowerCase()
    if (lang === '' || lang === 'json') candidates.push(match[2])
    stripped += `${text.slice(lastIndex, match.index)}\n`
    lastIndex = match.index + match[0].length
  }
  stripped += text.slice(lastIndex)
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(stripped.slice(start, end + 1))
  return candidates
}

/** 解析一个候选片段：只有「顶层是普通对象」才算命中，坏 JSON → null。 */
function tryParseJsonObject(text) {
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 节点回报的解析判定类别（E1-b）：没回报 / 回报了但结构不合法 / 解析成功。 */
export const NODE_REPORT_MISSING = 'missing'
export const NODE_REPORT_INVALID = 'invalid'
export const NODE_REPORT_OK = 'ok'

/** 把已解析的顶层对象收敛成对外回报结构（字段缺失 / 非法一律走默认值）。 */
function normalizeNodePayload(payload) {
  return {
    state: nodeStateOf(payload.state),
    progress: progressOf(payload.progress),
    summary: textOf(payload.summary, NODE_SUMMARY_LIMIT),
    members: membersOf(payload.members),
    blockers: blockersOf(payload.blockers),
    verdict: nodeVerdictOf(payload.verdict),
    nodeId: nonEmptyString(payload.nodeId),
    attempt: attemptOf(payload.attempt),
  }
}

/**
 * 解析节点自审回报，并**保留判定类别**（E1-b）。**纯函数，绝不抛错**。
 *
 * `parseNodeStatus` 返回 `null` 时其实是两件完全不同的事：
 *   - `missing`：这一轮**压根没回报**（非字符串 / 空串 / 纯文字里没有 JSON）；
 *   - `invalid`：**回报了但结构不合法**（有 JSON 围栏或 `{`，但解析失败 / 顶层不是
 *     对象）。后者说明节点在说话、只是格式不对——可能真在干活，也可能在自说自话，
 *     主线不该默默当「没有回报」。
 *
 * 判定可以经 `NodeSupervisionScheduler.recordReport()` 落进调度器快照
 * （`snapshot().entries[].lastReport`），供 flow_watch / run 级主线判断节点是否
 * 真的在干活。
 *
 * @param {string} text 模型输出原文
 * @returns {{ kind: 'missing'|'invalid'|'ok', parsed: object|null, reason: string|null }}
 *   `kind==='ok'` 时 `parsed` 的结构与 `parseNodeStatus` 的返回一致；其余为 `null`。
 */
export function inspectNodeStatus(text) {
  try {
    if (typeof text !== 'string') return { kind: NODE_REPORT_MISSING, parsed: null, reason: '回报不是字符串' }
    if (text.trim() === '') return { kind: NODE_REPORT_MISSING, parsed: null, reason: '回报为空' }
    const candidates = jsonPayloadCandidates(text)
    if (candidates.length === 0) {
      // 没有可用候选：带 JSON 痕迹（`{` 或围栏）说明「回报了但格式错」，否则当没回报。
      const looksLikeJson = text.includes('{') || text.includes('```')
      return looksLikeJson
        ? { kind: NODE_REPORT_INVALID, parsed: null, reason: '有 JSON 痕迹但没有可解析的片段' }
        : { kind: NODE_REPORT_MISSING, parsed: null, reason: '回报里没有 JSON' }
    }
    for (const candidate of candidates) {
      const payload = tryParseJsonObject(candidate)
      if (payload !== null) {
        return { kind: NODE_REPORT_OK, parsed: normalizeNodePayload(payload), reason: null }
      }
    }
    return { kind: NODE_REPORT_INVALID, parsed: null, reason: '有 JSON 片段但解析失败或顶层不是对象' }
  } catch {
    // 防御：任何意外（含超长输入导致的正则异常）都按「结构不合法」上报，而不是当没有。
    return { kind: NODE_REPORT_INVALID, parsed: null, reason: '解析异常' }
  }
}

/**
 * 解析节点自审的结构化回报（07-runtime-0.7 §11.2）。**纯函数，绝不抛错**。
 *
 * 认 ```json 围栏，也认裸 JSON（首个 `{` 到末个 `}`）；两者都有时优先围栏。
 * 字段缺失 / 非法一律走默认值，不做「猜」，也不因为奇怪输入抛错：
 *   - state：`working|done|blocked|failed`，其它 → `working`；
 *   - progress：0..100 的整数（越界夹紧、非数 → 0）；
 *   - summary：字符串，≤2000 字符；
 *   - members：≤20 条，每条 `{name,state,note}`，state 缺省 `working`；
 *   - blockers：≤20 条、每条 ≤200 字符的字符串数组；
 *   - verdict：只认 `pass|reject`，其它 → `null`；
 *   - nodeId / attempt：回报里带了且合法才保留，否则 `null`。
 *
 * 需要区分「没回报」与「回报了但格式错」时用 `inspectNodeStatus`（E1-b）。
 *
 * @param {string} text 模型输出原文
 * @returns {{ state: string, progress: number, summary: string, members: Array<{name: string, state: string, note: string}>, blockers: string[], verdict: 'pass'|'reject'|null, nodeId: string|null, attempt: number|null }|null}
 *   解析不出来 / 顶层不是对象 / 非字符串输入 → `null`。
 */
export function parseNodeStatus(text) {
  return inspectNodeStatus(text).parsed
}

/**
 * 节点级闹钟调度器（07-runtime-0.7 §11.1，与 run 级 `SupervisionScheduler` 并列）。
 *
 * 职责边界与 run 级一致：**只负责什么时候该唤醒**。真正判断会话 busy / idle、
 * 调 `agent.inject` / `agent.followup` / `agents.resume` 的 `wake(entry)` 由
 * runtime 注入；本类不 import 任何 dsh 包、不碰 fs、不写 run.json。
 *
 * 关键口径：
 *   - 键是 `sessionId`：同一 sessionId 重复 `register` = 刷新（重排 nextDueAt、
 *     更新 attempt / runId / nodeId、重新启用），**不叠加**第二条；
 *   - `wake(entry)` 收到的是**只读快照**（改它不影响内部状态），必须返回
 *     `{ action: 'inject'|'followup'|'skip', reason? }` 或抛错；
 *   - `inject` / `followup` = 真的发出去了 → `wakes+1`；`skip` = 这一轮不打扰，
 *     算成功（清失败 streak）但 **`wakes` 不 +1**；三种都推进 `nextDueAt`；
 *   - 抛错 / 返回非法结果 → `failures+1` 并**同样推进** `nextDueAt`
 *     （否则同一 due 每轮重试会刷屏），连续 `maxFailures` 次 → `enabled=false`
 *     + `lastReason='wake-failed: ...'`，此后不再尝试，但**保留在 list 里可查**；
 *   - `tick()` 有重入保护（`_ticking`），单个 entry 失败不影响其它 entry；
 *     entry 在 tick 过程中被注销 → 本轮不再碰它（也不会复活）。
 *   - E1-a：每个 entry 的唤醒都在**独立超时**里跑（`wakeTimeoutMs`，超时记 `timeout`
 *     并推进 due），不同 run 之间**有界并发**（`maxConcurrency`），**同一 run 内部仍
 *     串行**；一条挂死只影响它自己，整轮 tick 有界收口。
 *
 * 时间口径与 run 级一致：对外字段一律 ISO-8601 字符串。
 */
export class NodeSupervisionScheduler {
  /**
   * @param {object} [options]
   * @param {() => (number|Date|string)} [options.now]
   * @param {(entry: object, ctx?: { signal?: AbortSignal }) => Promise<{ action: 'inject'|'followup'|'skip', reason?: string }>|({ action: string, reason?: string })} options.wake
   * @param {(level: string, message: string) => void} [options.log]
   * @param {number} [options.intervalMs=15000] tick 扫描间隔
   * @param {number} [options.nodeAlarmMs=NODE_ALARM_DEFAULT_MS] 节点自审默认间隔
   * @param {number} [options.wakeTimeoutMs=SUPERVISION_WAKE_TIMEOUT_MS] 单条 entry 一轮的超时
   * @param {number} [options.maxConcurrency=SUPERVISION_MAX_CONCURRENCY] 一轮 tick 的并发上限
   * @param {number} [options.maxFailures=3] 连续唤醒失败几次后停摆
   * @param {Function} [options.setInterval]
   * @param {Function} [options.clearInterval]
   * @param {Function} [options.setTimeout] 单条超时定时器（测试可注入；缺省 globalThis.setTimeout）
   * @param {Function} [options.clearTimeout]
   */
  constructor(options = {}) {
    const opts = isPlainObject(options) ? options : {}
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this._wake = typeof opts.wake === 'function' ? opts.wake : null
    this._log = typeof opts.log === 'function' ? opts.log : () => {}
    this._intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0
      ? opts.intervalMs
      : DEFAULT_INTERVAL_MS
    this._nodeAlarmMs = Number.isFinite(opts.nodeAlarmMs) && opts.nodeAlarmMs > 0
      ? opts.nodeAlarmMs
      : NODE_ALARM_DEFAULT_MS
    this._maxFailures = Number.isInteger(opts.maxFailures) && opts.maxFailures > 0
      ? opts.maxFailures
      : NODE_ALARM_MAX_FAILURES
    this._wakeTimeoutMs = Number.isFinite(opts.wakeTimeoutMs) && opts.wakeTimeoutMs > 0
      ? opts.wakeTimeoutMs
      : SUPERVISION_WAKE_TIMEOUT_MS
    this._maxConcurrency = Number.isInteger(opts.maxConcurrency) && opts.maxConcurrency > 0
      ? opts.maxConcurrency
      : SUPERVISION_MAX_CONCURRENCY
    this._setInterval = typeof opts.setInterval === 'function' ? opts.setInterval : globalThis.setInterval
    this._clearInterval = typeof opts.clearInterval === 'function' ? opts.clearInterval : globalThis.clearInterval
    const setTimeoutFn = typeof opts.setTimeout === 'function' ? opts.setTimeout : globalThis.setTimeout
    const clearTimeoutFn = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : globalThis.clearTimeout
    this._wakeRunner = createWakeRunner({ setTimeoutFn, clearTimeoutFn })
    /** sessionId → 内存 entry（不落盘）。 */
    this._nodes = new Map()
    this._timer = null
    this._ticking = false
    // ── 可观测状态（只进 snapshot()，不改 status()/list() 的对外契约） ────────
    this._tickCount = 0
    this._tickSkipped = 0
    this._lastTickStartedAt = null
    this._lastTickFinishedAt = null
    this._lastTickDurationMs = null
    this._lastTickStats = null
  }

  /** 节点自审默认间隔（毫秒），runtime 拼自审提问时用得上。 */
  get nodeAlarmMs() {
    return this._nodeAlarmMs
  }

  /** 连续失败停摆阈值。 */
  get maxFailures() {
    return this._maxFailures
  }

  /** 单条 entry 一轮的超时（毫秒）。 */
  get wakeTimeoutMs() {
    return this._wakeTimeoutMs
  }

  /** 一轮 tick 的并发上限。 */
  get maxConcurrency() {
    return this._maxConcurrency
  }

  /** 启动周期扫描。幂等：重复调用不叠加定时器。返回是否真的新起了定时器。 */
  start() {
    if (this._timer !== null) return false
    const timer = this._setInterval(() => {
      // tick() 自己保证不 reject；这里再兜一层，避免注入实现意外把进程带崩。
      void this.tick().catch(error => this._safeLog('warn', `node-alarm tick 异常：${errorMessage(error)}`))
    }, this._intervalMs)
    // 定时器不该拖住进程退出（DSH 宿主里 interval 必须 unref）。
    try {
      timer?.unref?.()
    } catch {
      // 非 Node 定时器（测试桩 / 浏览器）没有 unref，忽略。
    }
    this._timer = timer
    return true
  }

  /**
   * 停掉定时器 + 结算所有在飞的 entry（abort signal 并清掉它们的超时 timer）。
   * 幂等；不清空已登记的节点（重启 start 后继续用原状态）。
   */
  stop() {
    const hadTimer = this._timer !== null
    if (hadTimer) {
      const timer = this._timer
      this._timer = null
      try {
        this._clearInterval(timer)
      } catch (error) {
        this._safeLog('warn', `node-alarm 清理定时器失败：${errorMessage(error)}`)
      }
    }
    // 在飞 entry 不能留着：否则超时 timer / 底层 wake 会一直挂着（E1-a 的收尾要求）。
    const aborted = this._wakeRunner.abortAll('node-alarm-scheduler-stopped')
    if (aborted > 0) {
      this._safeLog('info', `node-alarm: 停止时结算 ${aborted} 条在飞唤醒`)
    }
    return hadTimer
  }

  /** `stop()` 的别名：让宿主统一用 dispose 语义收尾。返回是否真的停掉了定时器。 */
  dispose() {
    return this.stop()
  }

  /**
   * 登记一个节点闹钟（`agents.create` 成功后由 engine 调用）。
   *
   * 同一 `sessionId` 再次登记 = **刷新**：不新建第二条，重排 `nextDueAt`、
   * 更新 runId / nodeId / attempt、重新启用，并把连续失败 streak 清零
   * （累计 `wakes` 保留，便于观测）。
   *
   * @param {object} input
   * @param {string} input.sessionId 节点主管会话 id（唯一键，必须非空）
   * @param {string} [input.runId]
   * @param {string} [input.nodeId]
   * @param {number} [input.attempt]
   * @param {number} [input.intervalMs] 覆盖该条 entry 的间隔（缺省 `nodeAlarmMs`）
   * @returns {object} 登记后的只读快照（同 `status(sessionId)`）
   */
  register({ runId, nodeId, sessionId, attempt, intervalMs } = {}) {
    const session = nonEmptyString(sessionId)
    if (session === null) throw new TypeError('sessionId 必须是非空字符串')
    const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : this._nodeAlarmMs
    const nowMs = this._nowMs()
    const nextDueAt = isoOf(nowMs + interval)
    const attemptValue = attemptOf(attempt)
    const run = nonEmptyString(runId)
    const node = nonEmptyString(nodeId)

    let entry = this._nodes.get(session)
    if (!entry) {
      entry = {
        sessionId: session,
        runId: run,
        nodeId: node,
        attempt: attemptValue,
        enabled: true,
        intervalMs: interval,
        nextDueAt,
        wakes: 0,
        failures: 0,
        lastReason: null,
        registeredAt: isoOf(nowMs),
        // E1-a 可观测 / 迟到结果丢弃：epoch 每轮 +1，超时后旧回合的结果一律作废。
        epoch: 0,
        lastOutcome: null,
        lastDurationMs: null,
        lastFinishedAt: null,
        lastError: null,
        timeouts: 0,
        // E1-b：最近一次自审回报的解析判定（missing / invalid / ok），由 recordReport 写入。
        lastReport: null,
      }
      this._nodes.set(session, entry)
      this._safeLog('info', `node-alarm: 登记 ${session}（run=${run ?? '-'} node=${node ?? '-'} attempt=${attemptValue ?? '-'}），下次 ${nextDueAt}`)
    } else {
      // 刷新：不叠加、不清累计 wakes，只重排 due 并清失败 streak。
      if (run !== null) entry.runId = run
      if (node !== null) entry.nodeId = node
      if (attemptValue !== null) entry.attempt = attemptValue
      entry.intervalMs = interval
      entry.enabled = true
      entry.failures = 0
      entry.lastReason = null
      entry.nextDueAt = nextDueAt
    }
    return this._publicOf(entry)
  }

  /** 按 sessionId 摘除（attempt 结束 / 会话关闭）。返回是否真的摘掉了。 */
  unregister(sessionId) {
    const session = nonEmptyString(sessionId)
    if (session === null) return false
    return this._nodes.delete(session)
  }

  /** 摘除某 run 下某个节点的所有闹钟。返回摘掉的条数。 */
  unregisterNode(runId, nodeId) {
    const run = nonEmptyString(runId)
    const node = nonEmptyString(nodeId)
    if (run === null || node === null) return 0
    let removed = 0
    for (const [session, entry] of [...this._nodes.entries()]) {
      if (entry.runId === run && entry.nodeId === node) {
        this._nodes.delete(session)
        removed += 1
      }
    }
    return removed
  }

  /** run 收尾：摘除该 run 的全部闹钟。返回摘掉的条数。 */
  unregisterRun(runId) {
    const run = nonEmptyString(runId)
    if (run === null) return 0
    let removed = 0
    for (const [session, entry] of [...this._nodes.entries()]) {
      if (entry.runId === run) {
        this._nodes.delete(session)
        removed += 1
      }
    }
    return removed
  }

  /**
   * 扫描一轮：对 `now >= nextDueAt` 且仍启用的 entry 执行 `wake`。
   *
   * E1-a 契约：
   *   - 每个 entry 的唤醒在**独立超时**里跑（`wakeTimeoutMs`），超时记为 `timeout`；
   *   - 一轮 tick **有界并发**（`maxConcurrency`），但**同一 run 内部仍串行**
   *     （按 runId 分组，组内依次 await；不同 run 才并行）；
   *   - 重入时直接返回 `{ skipped: true }`；单个 entry 的异常只影响它自己。
   *
   * 返回字段保持老契约不变（`skipped/entries/woken/skippedWakes/failed`）；超时计入
   * `failed`，每条的明细（lastOutcome / timeouts / 耗时）看 `snapshot()`。
   *
   * @returns {Promise<{ skipped: boolean, entries: number, woken: number, skippedWakes: number, failed: number }>}
   *   `woken` 只统计真的发出 inject / followup 的次数，`skippedWakes` 统计 skip。
   */
  async tick() {
    if (this._ticking) {
      // 「上一轮没跑完就跳过」的语义保留，并记进快照便于诊断调度器是否在空转。
      this._tickSkipped += 1
      return { skipped: true, entries: 0, woken: 0, skippedWakes: 0, failed: 0 }
    }
    this._ticking = true
    const stats = { skipped: false, entries: 0, woken: 0, skippedWakes: 0, failed: 0 }
    const startedAtMs = Date.now()
    this._tickCount += 1
    this._lastTickStartedAt = isoOf(this._nowMs())
    try {
      // 快照当前登记：允许 tick 过程中 unregister / register 不影响本轮遍历。
      const entries = [...this._nodes.values()]
      stats.entries = entries.length
      // 同一 run 的节点串行（保持既有「同一 run 内部依次自审」的语义），
      // 不同 run 之间才并行，且总并发受 maxConcurrency 限制。
      const groups = new Map()
      for (const entry of entries) {
        const key = entry.runId === null || entry.runId === undefined
          ? `session:${entry.sessionId}`
          : `run:${entry.runId}`
        let group = groups.get(key)
        if (!group) {
          group = []
          groups.set(key, group)
        }
        group.push(entry)
      }
      const tasks = [...groups.values()].map(group => async () => {
        for (const entry of group) {
          try {
            const outcome = await this._runEntry(entry)
            if (outcome === 'woken') stats.woken += 1
            else if (outcome === 'skip') stats.skippedWakes += 1
            else if (outcome === 'failed' || outcome === 'timeout' || outcome === 'error') stats.failed += 1
          } catch (error) {
            // 防御：注入的 now / 内部状态意外抛错时只影响这一条，不打断整轮。
            stats.failed += 1
            this._safeLog('warn', `node-alarm: ${entry.sessionId} 本轮跳过：${errorMessage(error)}`)
          }
        }
      })
      await runPool(tasks, this._maxConcurrency)
    } finally {
      this._ticking = false
      this._lastTickFinishedAt = isoOf(this._nowMs())
      this._lastTickDurationMs = Math.max(0, Date.now() - startedAtMs)
      this._lastTickStats = { ...stats }
    }
    return stats
  }

  /**
   * 记录一次节点自审回报的解析判定（`inspectNodeStatus` 的结果，E1-b）。
   *
   * `parseNodeStatus` 返回 null 有两种完全不同的情况——「这一轮压根没回报」与
   * 「回报了但结构不合法」。前者不代表节点在干活，后者恰恰说明节点在说话但格式
   * 不对（可能真在干活）。把判定落进 entry，`snapshot().entries[].lastReport` 可见，
   * run 级主线（flow_watch）据此判断节点是否真的在干活，而不是默默当没有。
   *
   * @param {string} sessionId
   * @param {{ kind?: 'missing'|'invalid'|'ok', reason?: string|null }|string} diagnostic
   * @returns {boolean} 是否记录成功（未登记的 session 返回 false，不新建 entry）
   */
  recordReport(sessionId, diagnostic) {
    const session = nonEmptyString(sessionId)
    if (session === null) return false
    const entry = this._nodes.get(session)
    if (!entry) return false
    const rawKind = diagnostic && typeof diagnostic === 'object' ? diagnostic.kind : diagnostic
    const rawReason = diagnostic && typeof diagnostic === 'object' ? diagnostic.reason : null
    const kind = rawKind === NODE_REPORT_OK || rawKind === NODE_REPORT_INVALID || rawKind === NODE_REPORT_MISSING
      ? rawKind
      : NODE_REPORT_INVALID
    const reason = nonEmptyString(rawReason)
    entry.lastReport = { kind, reason, at: isoOf(this._nowMs()) }
    if (kind === NODE_REPORT_INVALID) {
      this._safeLog('warn', `node-alarm: ${session} 自审回报结构不合法（${reason ?? 'unknown'}）`)
    }
    return true
  }

  /**
   * 调度器可观测快照（flow_watch / 诊断用）。**只读、纯查询**：不触发 tick、不改状态。
   *
   * 与 `status()` / `list()` 的分工：那两个是对外契约（9 个字段，别动）；这里是调度器
   * 健康度——每条的最近结果 / 耗时 / 超时次数 / 最近回报判定，以及整轮 tick 的耗时
   * 与并发度。
   */
  snapshot() {
    return {
      kind: 'node',
      ticking: this._ticking,
      started: this._timer !== null,
      intervalMs: this._intervalMs,
      nodeAlarmMs: this._nodeAlarmMs,
      maxConcurrency: this._maxConcurrency,
      wakeTimeoutMs: this._wakeTimeoutMs,
      concurrency: { limit: this._maxConcurrency, active: this._wakeRunner.active },
      tick: {
        count: this._tickCount,
        skipped: this._tickSkipped,
        lastStartedAt: this._lastTickStartedAt,
        lastFinishedAt: this._lastTickFinishedAt,
        lastDurationMs: this._lastTickDurationMs,
        lastStats: this._lastTickStats === null ? null : { ...this._lastTickStats },
      },
      entries: [...this._nodes.values()].map(entry => ({
        ...this._publicOf(entry),
        lastOutcome: entry.lastOutcome ?? null,
        lastDurationMs: entry.lastDurationMs ?? null,
        lastFinishedAt: entry.lastFinishedAt ?? null,
        timeouts: nonNegativeInt(entry.timeouts),
        lastError: entry.lastError ?? null,
        lastReport: entry.lastReport === null || entry.lastReport === undefined ? null : { ...entry.lastReport },
      })),
    }
  }

  /**
   * 只读快照。未登记的 session 返回 `enabled:false` + `lastReason:'not-registered'`。
   * @returns {{ sessionId: string|null, runId: string|null, nodeId: string|null, attempt: number|null, enabled: boolean, nextDueAt: string|null, wakes: number, failures: number, lastReason: string|null }}
   */
  status(sessionId) {
    const session = typeof sessionId === 'string' ? sessionId : null
    const entry = session === null ? undefined : this._nodes.get(session)
    if (!entry) {
      return {
        sessionId: session,
        runId: null,
        nodeId: null,
        attempt: null,
        enabled: false,
        nextDueAt: null,
        wakes: 0,
        failures: 0,
        lastReason: 'not-registered',
      }
    }
    return this._publicOf(entry)
  }

  /** 全部登记（含已停摆的）的只读快照数组，按登记顺序。 */
  list() {
    return [...this._nodes.values()].map(entry => this._publicOf(entry))
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 单条 entry = 是否到点判断 + 独立超时 + 结果归一化；超时/异常只影响这一条。
   * 返回 `woken|skip|failed|timeout|aborted|idle|stale`。
   */
  async _runEntry(entry) {
    if (entry.enabled === false) return 'idle'
    // 本轮之前被摘掉 / 被同 sessionId 的新登记替换 → 不再碰这条旧 entry。
    if (this._nodes.get(entry.sessionId) !== entry) return 'stale'
    const nowMs = this._nowMs()
    const dueMs = toMs(entry.nextDueAt)
    if (dueMs === null || nowMs < dueMs) return 'idle'

    const startedAtMs = Date.now()
    // 本轮的 lastError 由本轮结果决定；先清掉上一轮的残留。
    entry.lastError = null
    const result = await this._wakeRunner.run(
      signal => this._tickEntry(entry, nowMs, signal),
      this._wakeTimeoutMs,
    )
    const durationMs = Math.max(0, Date.now() - startedAtMs)
    entry.lastDurationMs = durationMs
    entry.lastFinishedAt = isoOf(this._nowMs())

    if (result.status === 'timeout') {
      // 迟到的回合作废：_tickEntry 每个 await 之后都会比对 epoch。
      entry.epoch = nonNegativeInt(entry.epoch) + 1
      const message = `唤醒超时（${this._wakeTimeoutMs}ms）`
      entry.lastOutcome = 'timeout'
      entry.lastError = message
      entry.timeouts = nonNegativeInt(entry.timeouts) + 1
      return this._recordFailure(entry, isoOf(nowMs + entry.intervalMs), message, 'wake-timeout')
    }

    if (result.status === 'aborted') {
      entry.lastOutcome = 'aborted'
      entry.lastError = errorMessage(result.error)
      return 'aborted'
    }

    if (result.status === 'error') {
      // 兜底：_tickEntry 内部已尽量吞错，这里防止注入实现意外 reject。
      entry.lastOutcome = 'failed'
      entry.lastError = errorMessage(result.error)
      return this._recordFailure(entry, isoOf(nowMs + entry.intervalMs), entry.lastError)
    }

    const outcome = typeof result.value === 'string' ? result.value : 'failed'
    entry.lastOutcome = outcome
    return outcome
  }

  /** 单个 entry 的一轮：成功推进、失败推进 + 计失败、停摆后不再尝试。 */
  async _tickEntry(entry, nowMs, signal) {
    // 本轮 token：超时 / stop 会把 epoch 推进，之后续体一律作废。
    const epoch = nonNegativeInt(entry.epoch) + 1
    entry.epoch = epoch
    let result = null
    let failureReason = null
    try {
      result = await this._require('wake', this._wake)(this._publicOf(entry), { signal })
    } catch (error) {
      failureReason = errorMessage(error)
    }

    // 迟到 / 被注销的结果：不回写状态。
    if (entry.epoch !== epoch) return 'stale'
    // 等待期间被注销 / 被同 sessionId 刷新成新对象：只回统计，绝不复活旧 entry。
    if (this._nodes.get(entry.sessionId) !== entry) {
      return failureReason === null ? 'woken' : 'failed'
    }

    // 成功失败都从「本轮开始时刻」重排，避免同一 due 反复触发。
    const nextDueAt = isoOf(nowMs + entry.intervalMs)
    const action = isPlainObject(result) && typeof result.action === 'string'
      ? result.action.trim()
      : null
    const reason = isPlainObject(result) ? nonEmptyString(result.reason) : null

    if (failureReason === null && action !== 'inject' && action !== 'followup' && action !== 'skip') {
      failureReason = `wake 返回非法结果（action=${action === null ? 'missing' : action}）`
    }
    if (failureReason !== null) {
      entry.lastError = failureReason
      return this._recordFailure(entry, nextDueAt, failureReason)
    }

    entry.failures = 0
    entry.nextDueAt = nextDueAt
    if (action === 'skip') {
      // skip = 「这一轮不打扰」：算成功（不是失败，也不触发降级），
      // 但 wakes 只统计真的发出去的 inject / followup，所以 skip 不 +1。
      entry.lastReason = reason === null ? 'skip' : `skip: ${reason}`
      this._safeLog('info', `node-alarm: ${entry.sessionId} 本轮 skip（${entry.lastReason}），下次 ${entry.nextDueAt}`)
      return 'skip'
    }

    entry.wakes = nonNegativeInt(entry.wakes) + 1
    entry.lastReason = reason
    this._safeLog('info', `node-alarm: ${entry.sessionId} 第 ${entry.wakes} 次唤醒（${action}），下次 ${entry.nextDueAt}`)
    return 'woken'
  }

  /**
   * 记一次失败：推进 due + 计连续失败，到阈值就停摆（保留在 list 里）。
   * `prefix` 区分失败来源：普通失败 `wake-failed`、超时 `wake-timeout`。
   */
  _recordFailure(entry, nextDueAt, reason, prefix = 'wake-failed') {
    entry.failures = nonNegativeInt(entry.failures) + 1
    entry.nextDueAt = nextDueAt
    entry.lastReason = `${prefix}: ${reason}`
    const label = prefix === 'wake-timeout' ? '唤醒超时' : '唤醒失败'
    if (entry.failures >= this._maxFailures) {
      entry.enabled = false
      this._safeLog(
        'warn',
        `node-alarm: ${entry.sessionId}（run=${entry.runId ?? '-'} node=${entry.nodeId ?? '-'}）连续 ${entry.failures} 次${label}，已停摆：${reason}`,
      )
    } else {
      this._safeLog(
        'warn',
        `node-alarm: ${entry.sessionId} 第 ${entry.failures} 次${label}（连续 ${this._maxFailures} 次后停摆）：${reason}`,
      )
    }
    return prefix === 'wake-timeout' ? 'timeout' : 'failed'
  }

  /** 内部 entry → 对外快照（新对象，改它不影响内部状态）。 */
  _publicOf(entry) {
    return {
      sessionId: entry.sessionId,
      runId: entry.runId ?? null,
      nodeId: entry.nodeId ?? null,
      attempt: entry.attempt ?? null,
      enabled: entry.enabled !== false,
      nextDueAt: entry.nextDueAt ?? null,
      wakes: nonNegativeInt(entry.wakes),
      failures: nonNegativeInt(entry.failures),
      lastReason: entry.lastReason ?? null,
    }
  }

  /** 依赖缺失时报明确的错（会被 per-entry catch 转成失败，不崩 tick）。 */
  _require(name, fn) {
    if (typeof fn !== 'function') throw new TypeError(`NodeSupervisionScheduler 缺少注入：${name}`)
    return fn
  }

  _nowMs() {
    return nowMsOf(typeof this._now === 'function' ? this._now() : this._now)
  }

  _safeLog(level, message) {
    try {
      this._log(level, message)
    } catch {
      // 日志实现抛错不该影响调度。
    }
  }
}
