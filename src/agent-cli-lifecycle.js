/**
 * 共享 CLI 进程组生命周期 helper（0.14.4 / U1）。
 *
 * 修复 review-0142b 的两个共享缺陷：
 *   - M5：`graceMs=0` 时只发 SIGTERM 就 return，没有 SIGKILL 升级；子进程忽略 TERM
 *     时 `handle.exited` 永远不完成。
 *   - m1：组长进程退出后立即清掉硬杀计时器，忽略 TERM 的后代仍存活
 *     （cancel-tree 探针：`leaderAlive:false, descendantAlive:true`）。
 *
 * 核心语义：
 *   1. 组杀用 `process.kill(-pgid, signal)`；只有 spawn 时 `detached:true` 的进程才是
 *      进程组组长。**绝不**把父进程组当作可杀目标：track 时用 `process.getpgid()` 校验，
 *      不是组长的进程退回单进程清理。
 *   2. `EPERM` 不算消失，只有 `ESRCH` 才算（`kill(-pgid, 0)` 抛 ESRCH）。
 *   3. `graceMs=0` 跳过宽限等待，但仍然执行完整的 TERM → KILL 升级。
 *      非零 `graceMs` 是「完成后宽限」（等进程自然退出），到期后 TERM；
 *      `killTimeoutMs` 是 TERM 后等待协作退出的窗口，到期仍存活则 SIGKILL。
 *   4. 只有**整组消失**才撤销升级计时器；组长先退、组内后代仍在时继续升级到 KILL。
 *   5. `waitGone` 有界轮询；超时返回 `{ gone:false }`，且 snapshot 仍保留 pending，
 *      绝不谎报成功。
 *   6. `createResourceRegistry`：`add(kind, disposeFn)`；`disposeAll()` 逐个执行，
 *      失败项记进 `pending[]` 并保留（下次 disposeAll 可重试），成功项不重复执行；
 *      错误摘要脱敏、限长、不吞掉信息。
 *   7. 所有计时器都 `.unref()` 并由 settle / disposeAll 显式清理，进程消失后不残留。
 *
 * 与适配器接入方冻结的契约：`track(child, {label})` 返回 handle；
 * `terminateGroup(handle, reason)` / `waitGone(handle, timeoutMs)` 接受该 handle。
 * handle 形状 `{ id, label, pid, pgid, kind, child, alive() }`。
 * `killImpl(signal, target)` 的 target 形状为
 * `{ pid, pgid, child, group }`（`group` 为负的 pgid，单进程清理时为 null）。
 *
 * Windows 行为未实测：组杀退回 `taskkill /T /F`，存活探测只能看组长 pid；
 * 不要用 POSIX 用例宣称覆盖了 Windows。
 *
 * @module @feiyueve/dsh-flow-studio/agent-cli-lifecycle
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { redactText } from './process-output.js'

const DEFAULT_GRACE_MS = 2000
const DEFAULT_KILL_TIMEOUT_MS = 2000
const DEFAULT_POLL_MS = 50
const ERROR_SUMMARY_MAX = 256

function nonNegativeIntOr(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function positiveIntOr(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** 进程 / 进程组是否仍在：只有 ESRCH 算消失，EPERM 视为仍存在。 */
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM'
  }
}

function groupAlive(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM'
  }
}

/** 错误摘要：脱敏 + 截断；绝不把完整错误对象或凭据透出去。 */
function sanitizeError(error) {
  const message = error && typeof error.message === 'string'
    ? error.message
    : error === undefined || error === null ? 'unknown error' : String(error)
  const code = error && typeof error.code === 'string' ? ` [${error.code}]` : ''
  return `${redactText(message)}${code}`.slice(0, ERROR_SUMMARY_MAX)
}

/**
 * 创建进程组 supervisor（一个实例可以 track 多个子进程）。
 *
 * @param {object} [options]
 * @param {number} [options.graceMs=2000] 完成后的宽限等待（0 = 跳过等待但仍升级 KILL）。
 * @param {number} [options.killTimeoutMs=2000] TERM 后等待协作退出的窗口，之后 SIGKILL。
 * @param {number} [options.pollMs=50] 存活探测轮询间隔。
 * @param {(signal: string, target: {pid:number|null, pgid:number|null, child:object, group:number|null}) => void} [options.killImpl]
 *   注入的信号发送实现（测试 / 特殊平台）；不注入时用 `process.kill(-pgid, signal)`。
 */
export function createProcessGroupSupervisor(options = {}) {
  const graceMs = nonNegativeIntOr(options.graceMs, DEFAULT_GRACE_MS)
  const killTimeoutMs = nonNegativeIntOr(options.killTimeoutMs, DEFAULT_KILL_TIMEOUT_MS)
  const pollMs = positiveIntOr(options.pollMs, DEFAULT_POLL_MS)
  const killImpl = typeof options.killImpl === 'function' ? options.killImpl : null

  const groups = new Map()
  const owner = Symbol('cli-process-group-supervisor')
  let sequence = 0

  function readProcPgrp(pid) {
    // Linux：/proc/<pid>/stat 的第 5 个字段是 pgrp（comm 可能含空格，从最后一个 ')' 切）。
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      if (close < 0) return null
      const fields = stat.slice(close + 2).split(' ')
      const pgrp = Number(fields[2])
      return Number.isSafeInteger(pgrp) && pgrp > 0 ? pgrp : null
    } catch {
      return null
    }
  }

  function resolveGroupLeader(pid) {
    if (process.platform === 'win32') return null
    if (!Number.isSafeInteger(pid) || pid <= 0) return null
    const pgrp = readProcPgrp(pid)
    if (pgrp !== null) {
      // 只有「自己就是组长」的进程才能安全地整组清理；
      // 否则 process.kill(-pid) 可能打向父进程组，绝不这么做。
      return pgrp === pid ? pid : null
    }
    // 非 Linux / 无 /proc：用组存在性探测；EPERM 说明组存在（仍按组登记，发送时再判断）。
    try {
      process.kill(-pid, 0)
      return pid
    } catch (error) {
      return Boolean(error) && error.code === 'EPERM' ? pid : null
    }
  }

  function clearTimers(record) {
    for (const timer of record.timers) clearTimeout(timer)
    record.timers.clear()
  }

  function isRecordAlive(record) {
    if (record.gone) return false
    if (record.kind === 'group') return groupAlive(record.pgid)
    return pidAlive(record.pid)
  }

  function finalizeGone(record) {
    if (record.gone) return
    record.gone = true
    record.pending = false
    clearTimers(record)
    for (const waiter of [...record.waiters]) waiter.abort(true)
    record.waiters.clear()
    try {
      record.child.off?.('exit', record.onExit)
      record.child.off?.('error', record.onError)
    } catch {
      // 老版本 EventEmitter 没有 off；once 监听器会随进程对象释放
    }
    groups.delete(record.id)
  }

  function abortWaiters(record, value) {
    for (const waiter of [...record.waiters]) waiter.abort(value)
    record.waiters.clear()
  }

  function publicEntry(record) {
    return {
      id: record.id,
      label: record.label,
      pid: record.pid,
      pgid: record.pgid,
      kind: record.kind,
      pending: record.pending,
      leaderExited: record.leaderExited,
      signals: record.signals.slice(),
      timers: record.timers.size,
      alive: isRecordAlive(record),
    }
  }

  function sendSignal(record, signal) {
    record.signals.push(signal)
    const target = {
      pid: record.pid,
      pgid: record.pgid,
      child: record.child,
      group: record.kind === 'group' ? -record.pgid : null,
    }
    if (record.kind === 'win32') {
      try {
        spawnSync('taskkill', ['/T', '/F', '/PID', String(record.pid)], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch (error) {
        record.lastKillError = sanitizeError(error)
        try {
          record.child.kill?.(signal)
        } catch {
          // 已经退出
        }
      }
      return
    }
    if (killImpl) {
      try {
        killImpl(signal, target)
      } catch (error) {
        record.lastKillError = sanitizeError(error)
      }
      return
    }
    try {
      if (record.kind === 'group') {
        process.kill(-record.pgid, signal)
      } else {
        record.child.kill?.(signal)
      }
    } catch (error) {
      const code = error && error.code
      if (code === 'ESRCH' || code === 'EPERM') {
        // ESRCH：目标已消失；EPERM：无权限（不算消失，也不重试）。
        return
      }
      record.lastKillError = sanitizeError(error)
      // 非预期错误：退回单进程尽力而为。
      try {
        record.child.kill?.(signal)
      } catch {
        // 已经退出
      }
    }
  }

  /**
   * 有界轮询到进程/进程组消失。
   * @returns {Promise<boolean>} true=已消失，false=超时或外部 abort。
   */
  function waitForGone(record, timeoutMs, { allowDisposed = false } = {}) {
    if (record.gone) return Promise.resolve(true)
    if (record.disposed && !allowDisposed) return Promise.resolve(false)
    if (!isRecordAlive(record)) {
      finalizeGone(record)
      return Promise.resolve(true)
    }
    const deadline = Date.now() + Math.max(0, timeoutMs)
    return new Promise(resolve => {
      let timer = null
      let done = false
      const waiter = {
        abort(value) {
          finish(Boolean(value))
        },
      }
      function finish(value) {
        if (done) return
        done = true
        if (timer) {
          clearTimeout(timer)
          record.timers.delete(timer)
          timer = null
        }
        record.waiters.delete(waiter)
        resolve(value)
      }
      function tick() {
        timer = null
        if (record.gone) {
          finish(true)
          return
        }
        if (!isRecordAlive(record)) {
          finalizeGone(record)
          finish(true)
          return
        }
        if (Date.now() >= deadline) {
          finish(false)
          return
        }
        timer = setTimeout(tick, pollMs)
        timer.unref?.()
        record.timers.add(timer)
      }
      record.waiters.add(waiter)
      const firstDelay = Math.max(1, Math.min(pollMs, deadline - Date.now()))
      timer = setTimeout(tick, firstDelay)
      timer.unref?.()
      record.timers.add(timer)
    })
  }

  async function runTermination(record, reason) {
    record.reason = reason === undefined || reason === null ? null : sanitizeError(reason)
    // 宽限：先给进程自然退出的机会（graceMs=0 时跳过等待，不是跳过升级）。
    if (graceMs > 0) {
      const goneDuringGrace = await waitForGone(record, graceMs)
      if (record.disposed) return disposedResult(record)
      if (goneDuringGrace) {
        return { gone: true, escalated: false, signals: record.signals.slice() }
      }
    }

    sendSignal(record, 'SIGTERM')
    const goneAfterTerm = await waitForGone(record, killTimeoutMs)
    if (record.disposed) return disposedResult(record)
    if (goneAfterTerm) {
      return { gone: true, escalated: false, signals: record.signals.slice() }
    }

    // 关键修复：即使 graceMs=0 / 组长已退出，只要整组还活着就升级 KILL。
    sendSignal(record, 'SIGKILL')
    const goneAfterKill = await waitForGone(record, Math.max(killTimeoutMs, pollMs))
    if (goneAfterKill) {
      return { gone: true, escalated: true, signals: record.signals.slice() }
    }

    record.pending = true
    return {
      gone: false,
      escalated: true,
      pending: true,
      reason: record.reason,
      signals: record.signals.slice(),
    }
  }

  function handleOf(record) {
    if (record.handle) return record.handle
    const handle = {
      id: record.id,
      label: record.label,
      pid: record.pid,
      pgid: record.pgid,
      kind: record.kind,
      child: record.child,
      alive: () => isRecordAlive(record),
    }
    record.handle = handle
    return handle
  }

  function recordOf(handle) {
    if (!handle || handle.__cliProcessGroup !== owner) {
      throw new TypeError('terminateGroup / waitGone 需要一个由本 supervisor.track() 返回的 handle')
    }
    return groups.get(handle.id) || null
  }

  /** dispose 与 in-flight terminate 竞争时，等 disposeAll 收口后再如实报告结果。 */
  async function disposedResult(record) {
    if (record.disposal) {
      try {
        await record.disposal
      } catch {
        // disposeAll 自己不抛错；这里只防御性兜底。
      }
    }
    return {
      gone: record.gone || !isRecordAlive(record),
      disposed: true,
      signals: record.signals.slice(),
    }
  }

  return {
    /**
     * 登记一个子进程的清理责任。
     * @param {import('node:child_process').ChildProcess} child spawn 成功的子进程（进程组清理需 detached:true）
     * @param {{label?: string}} [meta]
     */
    track(child, { label = '' } = {}) {
      if (!child || typeof child !== 'object' || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
        throw new TypeError('supervisor.track 需要一个 spawn 成功、有 pid 的子进程')
      }
      for (const existing of groups.values()) {
        if (existing.child === child) return handleOf(existing)
      }
      const pgid = resolveGroupLeader(child.pid)
      const record = {
        id: ++sequence,
        label: String(label || ''),
        child,
        pid: child.pid,
        pgid,
        kind: process.platform === 'win32' ? 'win32' : pgid ? 'group' : 'process',
        pending: false,
        gone: false,
        disposed: false,
        leaderExited: false,
        signals: [],
        timers: new Set(),
        waiters: new Set(),
        termination: null,
        reason: null,
        lastKillError: null,
      }
      record.onExit = () => {
        record.leaderExited = true
        // m1：组长退出**不**撤销升级计时器；只有整组消失（finalizeGone）才清。
        if (record.terminating || record.disposed) return
        if (!isRecordAlive(record)) finalizeGone(record)
      }
      record.onError = error => {
        record.lastKillError = sanitizeError(error)
      }
      child.once('exit', record.onExit)
      child.once('error', record.onError)
      groups.set(record.id, record)
      const handle = handleOf(record)
      Object.defineProperty(handle, '__cliProcessGroup', {
        value: owner,
        enumerable: false,
        configurable: false,
        writable: false,
      })
      return handle
    },

    /**
     * 发起宽限 → TERM → KILL 的整组清理。幂等：同一 handle 重复调用返回同一个 Promise。
     * @returns {Promise<{gone:boolean, escalated?:boolean, pending?:boolean, disposed?:boolean, signals:string[]}>}
     */
    terminateGroup(handle, reason) {
      const record = recordOf(handle)
      if (!record) return Promise.resolve({ gone: true, signals: [] })
      if (record.termination) return record.termination
      if (record.kind !== 'group' && process.platform !== 'win32') {
        const pgid = resolveGroupLeader(record.pid)
        if (pgid) {
          record.pgid = pgid
          record.kind = 'group'
        }
      }
      record.terminating = true
      record.termination = runTermination(record, reason).finally(() => {
        record.terminating = false
      })
      return record.termination
    },

    /**
     * 有界等待整组消失。
     * @returns {Promise<{gone:boolean}>}
     */
    async waitGone(handle, timeoutMs) {
      const record = recordOf(handle)
      if (!record) return { gone: true }
      const timeout = nonNegativeIntOr(timeoutMs, killTimeoutMs)
      return { gone: await waitForGone(record, timeout) }
    },

    /**
     * 强制清理所有登记项（dispose / 进程退出收尾）：清计时器、立即 SIGKILL、有界确认。
     * 未确认消失的项保留在 snapshot().groups 且 pending=true。
     * @returns {Promise<{pending: object[], groups: number, disposed: number}>}
     */
    async disposeAll() {
      const records = [...groups.values()]
      const summaryPromise = (async () => {
        let disposedCount = 0
        for (const record of records) {
          record.disposed = true
          clearTimers(record)
          abortWaiters(record, false)
          if (!isRecordAlive(record)) {
            finalizeGone(record)
            disposedCount += 1
            continue
          }
          sendSignal(record, 'SIGKILL')
          const gone = await waitForGone(record, Math.max(killTimeoutMs, pollMs), { allowDisposed: true })
          if (gone) {
            disposedCount += 1
          } else {
            record.pending = true
          }
        }
        const pending = [...groups.values()].filter(record => record.pending).map(publicEntry)
        return { pending, groups: groups.size, disposed: disposedCount }
      })()
      for (const record of records) record.disposal = summaryPromise
      return summaryPromise
    },

    /** 只读快照：仍在登记表中的进程组 + 活跃计时器数。 */
    snapshot() {
      const list = [...groups.values()]
      return {
        groups: list.map(publicEntry),
        pending: list.filter(record => record.pending).length,
        timers: list.reduce((total, record) => total + record.timers.size, 0),
      }
    },
  }
}

/**
 * 资源清理登记表：每个资源一条 disposeFn，集中清理并保留失败项。
 *
 * `disposeAll()` 返回 `{ disposed: string[], pending: [{kind,error}], total }`；
 * `snapshot()` 返回 `{ total, disposed, pending: [{kind,attempts,error}] }`。
 * 失败项不会被吞掉：保留在 pending 里，下次 disposeAll 会重试；
 * 已成功的项绝不会重复执行。
 */
export function createResourceRegistry() {
  const entries = []
  let sequence = 0

  return {
    /**
     * @param {string} kind 资源类型（channel / dir / listener / timer / process-group…）
     * @param {() => void|Promise<void>} disposeFn 清理函数
     * @returns {{id:number, kind:string}}
     */
    add(kind, disposeFn) {
      if (typeof disposeFn !== 'function') {
        throw new TypeError('resourceRegistry.add 需要一个清理函数')
      }
      const entry = {
        id: ++sequence,
        kind: String(kind || 'unknown'),
        disposeFn,
        done: false,
        attempts: 0,
        error: null,
      }
      entries.push(entry)
      return { id: entry.id, kind: entry.kind }
    },

    /** 逐个执行未完成的清理；失败项保留在 pending 并允许下次重试。 */
    async disposeAll() {
      const disposed = []
      const pending = []
      for (const entry of entries) {
        if (entry.done) continue
        entry.attempts += 1
        try {
          await entry.disposeFn()
          entry.done = true
          entry.error = null
          disposed.push(entry.kind)
        } catch (error) {
          entry.error = sanitizeError(error)
          pending.push({ id: entry.id, kind: entry.kind, error: entry.error })
        }
      }
      return {
        disposed,
        pending,
        pendingCount: pending.length,
        total: entries.length,
      }
    },

    /** 只读统计。 */
    snapshot() {
      return {
        total: entries.length,
        disposed: entries.filter(entry => entry.done).length,
        pending: entries
          .filter(entry => !entry.done)
          .map(entry => ({ kind: entry.kind, attempts: entry.attempts, error: entry.error })),
      }
    },
  }
}
