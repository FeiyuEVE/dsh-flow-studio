/**
 * 进程级 run 注册表 + 内建 supervision 调度（07 §5 / §7 / §8）。
 *
 * 权威规格：`docs/design/07-runtime-0.7.md` §5（并发）/ §7（supervision）/ §8（签名）。
 *
 * 设计要点：
 *   - **按 run 一实例**：`class Engine` 继续持有全部 per-run 字段，但一个实例只服务
 *     一个 run；不同 runId（同工作区 / 跨工作区）各自一个实例并行跑。
 *   - **唯一 409**：同一个 runId 已在跑 → `EngineError(409, '同一 run 已在运行（<runId>）')`。
 *     默认没有 `MAX_CONCURRENT`、没有 per-workspace 上限、没有排队（0.10 旧行为）。
 *   - **可选准入（0.11 · R2/S1）**：显式传 `options.admission`（controller）或
 *     `options.admissionLimits` 时才启用 `admission` 模块：start 先按
 *     `global` / `perWorkspace` 申请槽位（全局满严格 FIFO 排队，工作区满立即 429），
 *     grant 之后才 `newEngine` + `engine.start`；排队期间不建 Engine、不写 run/start。
 *     收尾 / 启动失败 / dispose 各释放一次。不传这两个选项时，本文件的行为与 0.10
 *     逐字一致。
 *   - **收尾摘除**：Engine 在 run 收尾（done/failed/aborted）时回调 `onSettled(runId)`，
 *     runtime 立刻把实例从表里摘掉并释放它的事件订阅；不轮询。run.json 仍然可读。
 *   - **跨 run 共享**：`sessionIndex`（flow_reply / 消息反查）、`startedBy`、logger、now
 *     由 runtime 持有并注入每个实例。
 *   - **Engine 门面**（v0.7）：index.js / tools.js 历史上把 `env.engine` 当「单引擎」用，
 *     runtime 补上同名成员（`engineName` / `resolveSessionOwner` / `runForSession` /
 *     `sweepStaleRuns` / `get` / `sessionIdForNode`），这样 `env.engine = runtime` 后
 *     这些调用照跑，Host 侧改动量最小。**`active` 不再提供**（并发不设上限）。
 *   - **内建 supervision**：runtime 起**唯一一个** `SupervisionScheduler`（`setInterval`
 *     用 `.unref()` 包一层，不吊住事件循环），`evaluate / wake / load / save` 全部在这里注入。
 *   - **节点闹钟（v0.8 / C2）**：同一 runtime 里再起**唯一一个** `NodeSupervisionScheduler`
 *     （与 run 级调度共用注入的定时器 / logger / now），`wake(entry)` 由 runtime 实现：
 *     busy → `agent.inject`、idle → `agent.followup`、冷会话先 `agents.resume`。
 *     每次唤醒先从该 run 的 Engine 取本轮 `{attempt, nonce}`（`attemptEnvelopeFor`）并
 *     写进自审提示词；拿不到凭证就 skip（不发注定被引擎丢弃的回报），skip 原因在
 *     `nodeSupervision.snapshot()` 可见。
 *   - **G7-a 按发起会话合并唤醒**：`wakeRun(runId, { wakerSessionId, runIds })` 接收
 *     调度器合并后的一批 runId，正文列出全部 runId（超过阈值只留摘要），只发**一条**
 *     followup；每会话的小时预算 / 最小间隔由 `SupervisionScheduler` 负责，被限流的
 *     run 保留 due、下一轮再来。旋钮：`wakerHourlyLimit` / `wakerMinIntervalMs`
 *     （或 `FLOW_STUDIO_WAKER_HOURLY_LIMIT` / `FLOW_STUDIO_WAKER_MIN_INTERVAL_MS`）。
 *   - **G7-b 重启恢复节点闹钟**：`supervisionReady` 之后跑一次 `recoverNodeAlarms()`，
 *     对 `status === 'running'` 且**本进程有 Engine 实例**的 run，从
 *     `run.json.nodeStatus` 取非终态节点 + `sessions.json` 的 sessionId 重新登记节点
 *     闹钟（`nextDueAt = now + nodeAlarmMs`，默认 600s，重启瞬间不刷一轮）；缺 sessionId
 *     的节点跳过并计入 `nodeSupervision.snapshot().recovery`，缺 attempt 按 1 处理并
 *     记 warn；重复调用幂等（已登记的 session 不再 register）。
 *   - **额外键单一写路径（E2-d）**：`workspace` / `worktree` / `sessionMode` / `supervision` /
 *     `nodeStatus` / `startOptions` 等 v0.7 字段都已进 `runstore.normalizeMeta()` 白名单，
 *     一律走 `readRunMeta` / `writeRunMeta`；`patchRunJson()` 只是 `writeRunMeta` 的薄封装
 *     （不再「读原文 → 合并 → 改写」），`readStartOptions()` 也只读 `readRunMeta`。
 *   - **重启收口（E2-a）**：初始化时把「status=running 但本进程没有实例负责」的 run
 *     无条件收成 failed（reason=restarted），清租约与唤醒标记；supervision 恢复扫描
 *     不会给这类 run 挂唤醒。
 *   - **卸载中止（E2-b）**：`dispose()` 先同步停掉两个调度器，再 abort 所有活跃 Engine，
 *     在 `disposeTimeoutMs` 内等待其收尾（超时放弃等待并告警），最后释放事件订阅。
 *   - **事件归属过滤（E2-c）**：每个 Engine 的 `session/event` 处理器由 runtime 包一层
 *     归属过滤 + 字节/条数双上限缓冲（只收本 run 的节点会话与 waker 会话）。
 *   - **向后兼容**：`createEngine({...})` / `new Engine({...})` 的既有用法不受影响；
 *     runtime 只是多包了一层注册表。
 *
 * @module @feiyueve/dsh-flow-studio/runtime
 */

import { readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { hostname } from 'node:os'

import { auditWorkflow as defaultAuditWorkflow } from './audit.js'
import { createAdmission } from './admission.js'
import { Engine, EngineError, createEngine, validateFlowForRun } from './engine.js'
import { buildFollowupPayload } from './inbox.js'
import { checkRunId } from './runlog.js'
import {
  appendEvents, claimLease, createRun, listRuns, readAllEvents,
  readLease, readNodeSessions,
  readRunMeta, releaseLease, runsDir, writeNodeSessions, writeRunMeta,
} from './runstore.js'
import { resumeCold } from './resume.js'
import { RESTARTABLE_STATUSES, prepareRestart } from './restart.js'
import { flowsDir, readFlow } from './store.js'
import { NODE_ALARM_DEFAULT_MS, NodeSupervisionScheduler, SupervisionScheduler } from './supervise.js'

/** runtime 自己消费、不往 Engine 透传的选项。 */
const RUNTIME_ONLY_KEYS = new Set([
  'createEngine', 'logger', 'onSettled', 'sessionIndex', 'startedBy',
  'auditWorkflow', 'intervalMs', 'supervisionIntervalMs',
  'nodeSupervisionIntervalMs', 'nodeAlarmMs',
  // G7-a：run 级唤醒的每会话预算（runtime 只透传给 SupervisionScheduler）。
  'wakerHourlyLimit', 'wakerMinIntervalMs',
  'setInterval', 'clearInterval',
  // E2-a / E2-b / E2-c：运行时自己消费的收口 / 卸载 / 事件缓冲旋钮。
  'disposeTimeoutMs', 'sessionEventByteLimit', 'sessionEventLimit',
  // 0.11 · R2/S1：准入控制器 / 内建控制器旋钮（不让 Engine 收到）。
  'admission', 'admissionLimits',
])

// ---------------------------------------------------------------------------
// E2-a：重启收口 / E2-c：session/event 归属过滤的常量
// ---------------------------------------------------------------------------

/** 收口原因（写进 run.json.supervision.reason 与 run/end.data.reason）。 */
export const ORPHAN_REASON = 'restarted'

/** 卸载时等待在飞 run 收尾的上限（毫秒）。超时只告警，不阻塞卸载。 */
const DEFAULT_DISPOSE_TIMEOUT_MS = 2000

/** E2-c：单 Engine 的 pending session 事件缓冲上限（字节 / 条数，双上限）。 */
const DEFAULT_SESSION_EVENT_BYTE_LIMIT = 2 * 1024 * 1024
const DEFAULT_SESSION_EVENT_LIMIT = 4000

/** E2-c：未知会话触发「补 wakerSessionId 缓存」的最小间隔（避免每条外来事件都读 run.json）。 */
const WAKER_REFRESH_MIN_INTERVAL_MS = 1000

/**
 * 本进程里此刻仍有活跃 Engine 负责的 runId（跨 runtime 实例）。
 *
 * 为什么需要：E2-a 的收口判定是「running 且本进程无实例」。同一个进程里可能短暂
 * 存在两个 runtime（测试 / 热重载），一个 runtime 的初始化扫描不能把另一个 runtime
 * 正在跑的 run 当成孤儿收掉。跨进程的判定仍然只看租约（pid + host + 心跳）。
 */
const LIVE_RUN_IDS = new Set()

/** 当前进程的 host（与 runstore.leaseOptions 的默认 host 同一口径）。 */
const LOCAL_HOST = hostname()

/**
 * E2-c：`runsRoot + runId → supervision.wakerSessionId` 的进程内缓存。
 *
 * 为什么放在模块级：`saveSupervision()` 是 runtime / index / tools 共用的唯一落盘入口，
 * 在这里顺手更新缓存后，Engine 的同步 `handleSessionEvent` 就能立刻认出 waker 会话
 * （不用为了一个同步判定去异步读 run.json）。读 run.json 的异步兜底仍然保留，用于
 * 「supervision 是别的进程写的」这种缓存未命中的情况。
 */
const RUN_WAKERS = new Map()

function runWakerKey(runsRoot, runId) {
  return `${typeof runsRoot === 'string' ? runsRoot : ''}\u0000${runId}`
}

/** 把刚写入的 supervision 里的 wakerSessionId 同步进缓存（没有就清掉）。 */
function rememberRunWaker(runsRoot, runId, supervision) {
  if (typeof runId !== 'string' || runId === '') return
  const key = runWakerKey(runsRoot, runId)
  if (isPlainObject(supervision)
    && typeof supervision.wakerSessionId === 'string'
    && supervision.wakerSessionId !== '') {
    RUN_WAKERS.set(key, supervision.wakerSessionId)
  } else {
    RUN_WAKERS.delete(key)
  }
}

/**
 * v0.7 写进 run.json 的运行绑定键（engine 写 workspace/worktree/sessionMode，runtime 写 supervision）。
 *
 * **单一写路径（E2-d）**：`runstore.normalizeMeta()` 已经把 `workspace` / `worktree` /
 * `sessionMode` / `supervision` / `nodeStatus` / `startOptions` 纳入白名单，所以这些键
 * 一律走 `readRunMeta` / `writeRunMeta`，**不再**自己「读原文 → 合并 → 改写」。
 * `startOptions` 的形状收敛（只允许 `workspace` / `worktree` 两个字符串键）由 runstore
 * 负责；读侧 `readStartOptions()` 直接取 `meta.startOptions`，缺省返回 null。
 *
 * 字段契约（与 engine 对齐）：
 *   - `workspace`   `{ id, path, realpath, isGit, gitRoot }`（id = sha256(realpath) 前 12 hex）
 *   - `worktree`    `{ enabled, reason, decidedBy:'initiator', path, branch, baseCommit, createdAt }`
 *   - `sessionMode` `'top-level' | 'legacy-subagent' | 'injected' | 'stub' | 'unavailable'`
 *   - `supervision` `{ enabled, wakerSessionId, lastWokeAt, nextDueAt, wakes, failures, reason }`
 */
export const RUN_EXTRA_KEYS = Object.freeze([
  'workspace', 'worktree', 'sessionMode', 'supervision', 'startOptions',
])

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// 0.11 F2：执行世代（ownerId + epoch）
// ---------------------------------------------------------------------------
//
// Engine 在 `start()` 里用 `runstore.claimLease()` 抢到本次执行的租约（含随机 `ownerId`
// 与单调 `epoch`），并把它挂在 `engine.active.lease` 上。runtime 在 `engine.start()`
// 返回后把这份世代记下来；收尾时只有「持久 `run.json.execution` 仍是这份世代」才允许
// 摘掉本 run 的调度登记 / 落盘 supervision.enabled=false。否则说明接管者已经拿到新
// 世代，旧实例的迟到收尾只许摘自己的资源（Engine 实例 / 配额 / 事件订阅）。

/** 从 Engine 实例读出本次执行的世代；没有（旧 Engine / 桩）返回 null。 */
function engineLeaseGeneration(engine) {
  const lease = engine && engine.active && engine.active.lease
  if (!isPlainObject(lease)) return null
  const generation = {}
  if (typeof lease.ownerId === 'string' && lease.ownerId !== '') generation.ownerId = lease.ownerId
  if (Number.isInteger(lease.epoch)) generation.epoch = lease.epoch
  return generation.ownerId === undefined && generation.epoch === undefined ? null : generation
}

/**
 * 持久 execution 与「本实例世代」是否一致。
 * 只比较双方都带了的字段：老 run 可能没有 ownerId / epoch，不因此误判被接管。
 */
function executionMatchesGeneration(execution, generation) {
  if (!isPlainObject(execution) || !generation) return true
  if (generation.ownerId !== undefined
    && typeof execution.ownerId === 'string' && execution.ownerId !== ''
    && execution.ownerId !== generation.ownerId) {
    return false
  }
  if (generation.epoch !== undefined && Number.isInteger(execution.epoch)
    && execution.epoch !== generation.epoch) {
    return false
  }
  return true
}

/** runstore 的写入门闩：meta.execution 必须仍是这份世代。 */
function generationFence(generation) {
  if (!generation) return {}
  return {
    ...(generation.ownerId === undefined ? {} : { ownerId: generation.ownerId }),
    ...(generation.epoch === undefined ? {} : { leaseEpoch: generation.epoch }),
  }
}

/** 世代的可读标签（日志用）。 */
function generationLabel(generation) {
  if (!generation) return 'unknown'
  const owner = generation.ownerId === undefined ? '?' : generation.ownerId.slice(0, 8)
  const epoch = generation.epoch === undefined ? '?' : String(generation.epoch)
  return `epoch=${epoch}, owner=${owner}`
}

// ---------------------------------------------------------------------------
// E2-c：session/event 归属过滤 + 字节/条数双上限缓冲
// ---------------------------------------------------------------------------
//
// 缺陷：每个 Engine 都在 `ctx.on('session/event', ..., {global:true})` 上无条件收事件，
// 未绑定的会话一律塞进 `pendingSessionEvents`（4000 条），于是 N 个并发 run 互相把
// 对方的会话事件也存一份（O(R×E) 放大，实测单实例 ~8MB）。
//
// 修复：runtime 在创建 Engine 后给它包一层 `handleSessionEvent`：
//   1. 归属过滤——只放行「本 run 的节点会话 / 成员子会话 / waker 会话」；
//      判断依据是 Engine 自己已有的 sessionId 集合（sessionBindings / nodeSessions /
//      sessionIndex / startedBy），不新增字段、不猜。
//   2. 双重上限——引擎自带的 4000 条上限先放开，本层统一按「条数 + 字节」丢最旧，
//      并把 `sessionEventStats` / `pendingSessionBytes` / `sessionEventOverflow` 置在
//      Engine 实例上，便于观测。

/** 单条待重放事件的内存估算：事件 JSON 字节 + 会话 id 字节（会话对象只存引用）。 */
function sessionEventBytes(item) {
  const event = item && item.event ? item.event : {}
  let bytes = 0
  try {
    bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
  } catch {
    bytes = 1024
  }
  const sessionId = item && item.session && typeof item.session.id === 'string' ? item.session.id : ''
  return bytes + Buffer.byteLength(sessionId, 'utf8')
}

/**
 * 这个会话是不是本 run 的？
 *
 * 只用 Engine 里已有的绑定集合判定（不引入新的归属凭据）：
 *   - `sessionBindings`：已绑定的节点主管 / 成员会话；
 *   - 子会话：`session.header.parentSession` 是已绑定会话 → 属于成员内部，先收下等绑定；
 *   - `nodeSessions`：sessions.json 载入 / 本次 run 记录过的节点会话（尚未绑定也要收）；
 *   - `sessionIndex`：共享索引里 owner.runId 等于本 run；
 *   - `startedBy` / `startParent`：启动过本 run 的 waker 会话。
 *
 * @param {object} engine
 * @param {object} session
 * @param {string} sessionId
 * @param {string} runId
 * @returns {boolean}
 */
function sessionBelongsToRun(engine, session, sessionId, runId) {
  const bindings = engine.sessionBindings
  if (bindings && typeof bindings.has === 'function' && bindings.has(sessionId)) return true
  const header = session && session.header
  const parentSessionId = header && typeof header.parentSession === 'string' ? header.parentSession : null
  if (parentSessionId && bindings && typeof bindings.has === 'function' && bindings.has(parentSessionId)) {
    return true
  }
  const nodeSessions = engine.nodeSessions
  if (nodeSessions && typeof nodeSessions.values === 'function') {
    for (const entry of nodeSessions.values()) {
      if (entry && entry.sessionId === sessionId) return true
    }
  }
  const index = engine.sessionIndex
  if (index && typeof index.get === 'function') {
    const owner = index.get(sessionId)
    if (owner && owner.runId === runId) return true
  }
  const startedBy = engine.startedBy
  if (startedBy && typeof startedBy.get === 'function' && startedBy.get(sessionId) === runId) return true
  const waker = engine.startParent || engine.parent
  const wakerId = waker && waker.session && typeof waker.session.id === 'string' ? waker.session.id : null
  return wakerId !== null && wakerId === sessionId
}

/**
 * 按「条数 + 字节」双重上限裁剪 `engine.pendingSessionEvents`：**丢最旧**。
 * 单条就超过字节预算的事件也会被丢掉（内存预算是硬约束，不因为「它是最新的」破例）。
 *
 * @param {object} engine
 * @param {{ array: any[]|null, bytes: number }} state 与数组身份绑定的字节记账
 * @param {object} stats 可观测统计（原地更新）
 */
function enforceSessionEventLimits(engine, state, stats) {
  const list = engine.pendingSessionEvents
  if (!Array.isArray(list)) {
    state.array = null
    state.bytes = 0
    state.count = 0
    stats.events = 0
    stats.bytes = 0
    return
  }
  // Engine 的 bindSession / _flushBufferedFor / _cleanupActive 会整体替换数组：
  // 身份一变就重新记账，避免跨 run 的计数漂移。
  if (state.array !== list) {
    state.array = list
    state.bytes = 0
    state.count = list.length
    for (const item of list) state.bytes += sessionEventBytes(item)
  } else if (list.length > state.count) {
    // 同一数组里追加了条目（Engine 自己 push）：只算增量，不每次 O(n) 全量重算。
    for (let index = state.count; index < list.length; index += 1) {
      state.bytes += sessionEventBytes(list[index])
    }
    state.count = list.length
  }
  while (list.length > stats.limits.events) {
    const removed = list.shift()
    state.bytes -= sessionEventBytes(removed)
    stats.dropped += 1
    stats.overflowed = true
  }
  while (state.bytes > stats.limits.bytes && list.length > 0) {
    const removed = list.shift()
    state.bytes -= sessionEventBytes(removed)
    stats.dropped += 1
    stats.overflowed = true
  }
  if (state.bytes < 0) state.bytes = 0
  state.count = list.length
  stats.events = list.length
  stats.bytes = state.bytes
  // 可观测标记（字段名稳定，测试 / 诊断直接读）。
  engine.pendingSessionBytes = state.bytes
  engine.pendingSessionDropped = stats.dropped
  engine.sessionEventOverflow = stats.overflowed
}

/**
 * 给一个 Engine 实例装上「归属过滤 + 双上限缓冲」。
 *
 * 注意：这是 runtime 层的组合补丁（engine.js 由另一个任务改），对
 * `runtime.start()` 创建的实例生效；单独 `new Engine()` 的用法不受影响。
 *
 * waker 会话：`startedBy` / `startParent` 覆盖常规路径（发起会话启动 run）；显式
 * `flow_supervise` 可能把 waker 指到另一个会话，所以这里再按需（≤1 次/秒）从
 * run.json.supervision.wakerSessionId 补一次缓存，之后该会话的事件也放行。
 *
 * @param {object} engine
 * @param {{ runId: string, runsRoot: string, limitEvents: number, limitBytes: number }} options
 * @returns {object} 同一个 engine（便于链式）
 */
function scopeEngineSessionEvents(engine, options) {
  const original = engine && engine.handleSessionEvent
  if (typeof original !== 'function') return engine
  const runId = options.runId
  const runsRoot = typeof options.runsRoot === 'string' ? options.runsRoot : ''
  const builtinLimit = Number.isInteger(engine.pendingSessionLimit) && engine.pendingSessionLimit > 0
    ? engine.pendingSessionLimit
    : DEFAULT_SESSION_EVENT_LIMIT
  // 引擎自带的条数上限先放开：否则它到 4000 就丢**最新**，本层没法按「丢最旧」统一裁剪。
  engine.pendingSessionLimit = Number.MAX_SAFE_INTEGER
  const stats = {
    runId,
    owned: 0,
    foreign: 0,
    dropped: 0,
    overflowed: false,
    events: 0,
    bytes: 0,
    // waker 会话（run.json.supervision.wakerSessionId 的缓存值；null = 尚未读到）。
    wakerSessionId: null,
    limits: {
      events: Math.max(1, Math.min(options.limitEvents, builtinLimit)),
      bytes: Math.max(1, options.limitBytes),
    },
  }
  const state = { array: null, bytes: 0, count: 0 }
  // run.json.supervision.wakerSessionId 的进程内缓存（见上方注释；读失败不影响过滤）。
  const wakerKey = runWakerKey(runsRoot, runId)
  let wakerSessionId = RUN_WAKERS.get(wakerKey) || null
  let wakerFetchAt = 0
  let wakerFetching = false
  const refreshWaker = () => {
    if (wakerFetching || runsRoot === '') return
    const nowMs = Date.now()
    if (nowMs - wakerFetchAt < WAKER_REFRESH_MIN_INTERVAL_MS) return
    wakerFetchAt = nowMs
    wakerFetching = true
    readRunMeta(runsRoot, runId)
      .then(meta => {
        const stateOfRun = meta && isPlainObject(meta.supervision) ? meta.supervision : null
        rememberRunWaker(runsRoot, runId, stateOfRun)
        const cached = RUN_WAKERS.get(wakerKey) || null
        if (cached !== null) {
          wakerSessionId = cached
          stats.wakerSessionId = cached
        }
      })
      .catch(() => {})
      .finally(() => { wakerFetching = false })
  }
  engine.sessionEventStats = stats
  engine.pendingSessionBytes = 0
  engine.pendingSessionDropped = 0
  engine.sessionEventOverflow = false
  engine.handleSessionEvent = function scopedHandleSessionEvent(session, event) {
    const sessionId = session && typeof session.id === 'string' ? session.id : null
    if (!sessionId || !event || typeof event.type !== 'string') {
      return original.call(this, session, event)
    }
    const activeRunId = this && this.active && typeof this.active.runId === 'string'
      ? this.active.runId
      : null
    // 别的 run / 本实例已收尾：一律丢弃，不缓冲、不写事件。
    if (activeRunId !== runId) {
      stats.foreign += 1
      return undefined
    }
    const currentWaker = RUN_WAKERS.get(wakerKey) || wakerSessionId
    if (currentWaker !== null && stats.wakerSessionId !== currentWaker) stats.wakerSessionId = currentWaker
    const owned = sessionBelongsToRun(this, session, sessionId, runId)
      || (currentWaker !== null && sessionId === currentWaker)
    if (!owned) {
      // 未知会话：先尝试补一次 waker 缓存（下一次再放行），本次仍丢弃。
      refreshWaker()
      stats.foreign += 1
      return undefined
    }
    stats.owned += 1
    const result = original.call(this, session, event)
    enforceSessionEventLimits(this, state, stats)
    return result
  }
  return engine
}

/**
 * 有界等待：promise 在 timeoutMs 内结束就正常返回；超时就放弃等待并回调告警。
 * 永远 resolve，绝不把卸载卡死 / 把拒绝泄漏成 unhandled rejection。
 *
 * @param {Promise<unknown>} promise
 * @param {number} timeoutMs
 * @param {string} label
 * @param {(message: string) => void} log
 * @returns {Promise<{ timedOut: boolean }>}
 */
function waitBounded(promise, timeoutMs, label, log) {
  return new Promise(resolve => {
    let done = false
    let timer = null
    const finish = timedOut => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve({ timedOut })
    }
    // 注意不 unref：卸载路径本身就要在这里有界地等一下；timer 在 race 结束时会清掉，
    // 不会拖住进程退出。
    timer = setTimeout(() => {
      log('warn', `flow-studio: ${label}超时（${timeoutMs}ms），放弃等待（引擎可能仍在收尾）`)
      finish(true)
    }, timeoutMs)
    Promise.resolve(promise).then(
      () => finish(false),
      error => {
        log('warn', `flow-studio: ${label}失败：${error && error.message ? error.message : String(error)}`)
        finish(false)
      },
    )
  })
}

/**
 * 读建 run 时记下的发起参数（`run.json.startOptions`）。
 *
 * 走 `runstore.readRunMeta()`（startOptions 已进 normalizeMeta 白名单），不再裸读原文；
 * 坏文件 / 缺字段一律 null，绝不抛错（调用方按「没有发起参数」处理）。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @returns {Promise<{ workspace?: string, worktree?: string } | null>}
 */
export async function readStartOptions(runsRoot, runId) {
  if (!checkRunId(runId)) return null
  const meta = await readRunMeta(runsRoot, runId)
  if (!meta) return null
  return isPlainObject(meta.startOptions) ? meta.startOptions : null
}

/**
 * 把补丁合并进 `run.json` —— **`runstore.writeRunMeta()` 的薄封装**（E2-d）。
 *
 * 为什么必须这样：旧实现直接「读原文 → 合并 → 临时文件 + rename」，绕过了 runstore
 * 的进程内锁、跨进程文件锁与 1 MiB 守卫，于是 `runtime.patchRunJson` 与
 * `engine._patchRunBinding` 构成**两套锁域**：并发写时后写的整份覆盖先写的，字段
 * 静默丢失。现在只有一条写路径 `writeRunMeta`，函数名 / 签名保持不变，调用方
 * （`index.js` 的 startOptions 交接）不需要改。
 *
 * 返回值兼容：旧实现返回「写入后的完整原始对象」；这里返回 `writeRunMeta` 的完整
 * 规范化 meta（同 `readRunMeta` 形状）。请求里出现 runstore 不认识的键时，
 * `writeRunMeta` 会把它们列在返回值的**不可枚举** `droppedKeys` 上（不落盘），
 * 本函数原样透出——调用方可以据此发现「写了但没落盘」而不是静默成功。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {Record<string, any>} patch 白名单键的补丁；`null` 用于把可选对象键置空。
 *   **注意**：旧实现用 `undefined` 表示「删除该键」，现在合并语义由 runstore 决定
 *   （`undefined` 覆盖后在 normalizeMeta 里大多退回默认值 / 被丢弃，不等价于删除）。
 * @returns {Promise<object|null>} 写入后的完整 meta；run 不存在 / runId 非法返回 null
 */
export async function patchRunJson(runsRoot, runId, patch = {}) {
  if (!checkRunId(runId)) return null
  const existing = await readRunMeta(runsRoot, runId)
  if (!existing) return null
  try {
    return await writeRunMeta(runsRoot, runId, isPlainObject(patch) ? patch : {})
  } catch (error) {
    // 旧契约：run 不存在返回 null（writeRunMeta 会抛 404）。
    if (error && error.status === 404) return null
    throw error
  }
}

/**
 * 读 run 的 v0.7 绑定字段（**统一走 runstore 白名单**）。
 * 缺字段一律 null，run 不存在整体返回 null。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @returns {Promise<{ workspace: object|null, worktree: object|null,
 *   sessionMode: string|null, supervision: object|null,
 *   startOptions: object|null } | null>}
 */
export async function readRunExtras(runsRoot, runId) {
  const meta = await readRunMeta(runsRoot, runId)
  if (!meta) return null
  return {
    workspace: isPlainObject(meta.workspace) ? meta.workspace : null,
    worktree: isPlainObject(meta.worktree) ? meta.worktree : null,
    sessionMode: typeof meta.sessionMode === 'string' && meta.sessionMode !== '' ? meta.sessionMode : null,
    supervision: isPlainObject(meta.supervision) ? meta.supervision : null,
    startOptions: await readStartOptions(runsRoot, runId),
  }
}

/**
 * 合并写入 `run.json.supervision`（07 §7）：先读现有对象，再只覆盖给定字段。
 *
 * 走 `runstore.writeRunMeta()`（supervision 已进白名单，局部合并不互相覆盖
 * workspace / worktree / sessionMode）——不自己改写原文，避免两条写路径打架。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {object} patch
 * @returns {Promise<object|null>} 写入后的 supervision 对象；run 不存在返回 null
 */
export async function saveSupervision(runsRoot, runId, patch = {}) {
  const meta = await readRunMeta(runsRoot, runId)
  if (!meta) return null
  const previous = isPlainObject(meta.supervision) ? meta.supervision : {}
  const next = { ...previous, ...(isPlainObject(patch) ? patch : {}) }
  await writeRunMeta(runsRoot, runId, { supervision: next })
  // E2-c：同步更新 waker 缓存（Engine 的 handleSessionEvent 是同步的，读不了 run.json）。
  rememberRunWaker(runsRoot, runId, next)
  return next
}

// ---------------------------------------------------------------------------
// supervision 的唤醒提示词（原文见交付说明；只写 runId，不写环境事实）
// ---------------------------------------------------------------------------

/** 合并唤醒提示词里最多逐个列出的 runId 数；超出的只给摘要（避免一条上万字）。 */
export const SUPERVISION_WAKE_PROMPT_MAX_RUNS = 20

/** 单个 runId 在提示词里的渲染上限（runId 有长度上限，这里只是防御坏数据）。 */
const WAKE_PROMPT_RUN_ID_MAX = 80

/**
 * 内建 supervision 到点唤醒发起会话时的提示词。
 * 必须包含三要素：runId、`flow_watch`、以及「不要重复挂手动闹钟」。
 */
export function supervisionWakePrompt(runId) {
  return [
    `【工作流自动复查】runId=${runId} 到了定时审查点（这是内置 supervision 调度发起的唤醒，`,
    '不需要你再手动挂 proactive_set 闹钟）。请调用 flow_watch（runId="' + runId + '"）审查这个 run 是否在正常运转：',
    '① 若 verdict 表示运行正常且没有停滞，直接结束本轮，不要打扰主人；',
    '② 只有出现异常（节点停滞、打回过多、节点失败）或整个流程已经跑完（done/failed/aborted），'
      + '才把结论、异常点和需要主人决策的地方通知主人；',
    '③ 之后仍由内置调度按 60 / 180 秒的间隔继续唤醒你，直到这个 run 收尾为止。',
  ].join('')
}

/** 把 runIds 收敛成非空、去重、有序的字符串数组（保持传入顺序）。 */
function normalizeWakeRunIds(runIds) {
  const out = []
  const seen = new Set()
  for (const value of Array.isArray(runIds) ? runIds : [runIds]) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * G7-a：一次唤醒服务多个 run 时的提示词。
 *
 * 单个 run → 逐字沿用 {@link supervisionWakePrompt}（既有行为不变）；多个 run → 一条
 * 提示词列出全部 runId（最多 `SUPERVISION_WAKE_PROMPT_MAX_RUNS` 个，超出的给摘要），
 * 让发起会话用一条 followup 逐个 `flow_watch`，而不是每个 run 各叫一次。
 *
 * @param {string|string[]} runIds
 * @returns {string}
 */
export function supervisionWakePromptBatch(runIds) {
  const ids = normalizeWakeRunIds(runIds)
  if (ids.length === 0) return supervisionWakePrompt('')
  if (ids.length === 1) return supervisionWakePrompt(ids[0])
  const listed = ids.slice(0, SUPERVISION_WAKE_PROMPT_MAX_RUNS)
  const rest = ids.length - listed.length
  const lines = [
    `【工作流自动复查】本轮有 ${ids.length} 个 run 到了定时审查点，已合并成这一次唤醒`
      + '（内置 supervision 调度发起，不需要你再手动挂 proactive_set 闹钟）。runId：',
    ...listed.map(id => `- ${id.slice(0, WAKE_PROMPT_RUN_ID_MAX)}`),
  ]
  if (rest > 0) {
    lines.push(`- …另有 ${rest} 个同批到期的 run 未逐个列出（本次已合并唤醒，可按需处理）`)
  }
  lines.push(
    '请对上面列出的每个 run 分别调用一次 flow_watch（runId 用列表里的 id）审查它是否在正常运转：',
    '① 若 verdict 表示运行正常且没有停滞，直接结束该 run 的复查，不要打扰主人；',
    '② 只有出现异常（节点停滞、打回过多、节点失败）或该 run 已经跑完（done/failed/aborted），'
      + '才把结论、异常点和需要主人决策的地方通知主人；',
    '③ 之后仍由内置调度按 60 / 180 秒的间隔继续唤醒你，直到这些 run 收尾为止。',
  )
  return lines.join('\n')
}

/**
 * 节点自审闹钟的提问词（07 v0.8 §11.2）。
 *
 * 与 run 级 supervision 的差别：它问的是**单个节点主管**「你这个节点现在什么状态」，
 * 而不是「整个 run 是否正常」。要求只用 ```json 代码块回报结构化状态，方便
 * `parseNodeStatus` / 引擎按 `state` + `verdict` 驱动流转。
 *
 * C2（07 §11.3）：引擎只接受**回显本轮 attempt + 一次性 nonce** 的回报；提示词必须
 * 带上真实值，并在 JSON 示例里给出字段名 `attempt` / `nonce`，不能只让模型猜。
 *
 * @param {{ runId: string, nodeId: string, attempt?: number, nonce?: string }} entry
 * @returns {string}
 */
export function nodeSelfCheckPrompt(entry = {}) {
  const runId = typeof entry.runId === 'string' ? entry.runId : String(entry.runId ?? '')
  const nodeId = typeof entry.nodeId === 'string' ? entry.nodeId : String(entry.nodeId ?? '')
  const attempt = Number.isInteger(entry.attempt) ? entry.attempt : 0
  const nonce = typeof entry.nonce === 'string' && entry.nonce !== '' ? entry.nonce : ''
  const authLine = nonce
    ? `runId=${runId}，nodeId=${nodeId}，attempt=${attempt}，nonce=${nonce}。`
    : `runId=${runId}，nodeId=${nodeId}，attempt=${attempt}（缺 nonce，回报会被丢弃）。`
  const example = '{"nodeId":"' + nodeId + '","attempt":' + attempt
    + (nonce ? ',"nonce":"' + nonce + '"' : '')
    + ',"state":"working|done|blocked|failed","progress":0,"summary":"…",'
    + '"members":[{"name":"…","state":"working|done|blocked","note":"…"}],'
    + '"blockers":[],"verdict":"pass|reject|null"}'
  return [
    '【节点自审闹钟】不是新任务。',
    authLine,
    '只回一段 ```json 状态块：',
    example,
    nonce
      ? `必须原样回显 attempt=${attempt} 与 nonce=${nonce}（缺失或不匹配会被引擎丢弃）。`
      : '必须原样回显 attempt（缺失或不匹配会被引擎丢弃）。',
    'state=done 且 verdict 有值即认为节点完成；不确定写 working，不要谎报完成。',
    // inject 会把这段问话塞进正在跑的回合：必须明确「别用状态 JSON 顶替正式交付」，
    // 否则节点的正式结论会被状态块盖掉（引擎侧另有 parseAssistantStructured 的防御）。
    '正在做本轮任务时：只把状态块放在答复最后，不要用它替代正式交付物与结论。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 0.11 · R2/S1：准入控制（可选启用；不传 admission / admissionLimits 时保持 0.10 旧行为）
// ---------------------------------------------------------------------------

/** 是否是 `createAdmission()` 返回的准入 API（而不是裸 controller 状态对象）。 */
function isAdmissionLike(value) {
  return Boolean(value && typeof value === 'object'
    && typeof value.acquire === 'function'
    && typeof value.release === 'function'
    && typeof value.cancel === 'function'
    && typeof value.markRunning === 'function'
    && typeof value.admissionOf === 'function'
    && typeof value.snapshot === 'function')
}

/**
 * 解析 runtime 的准入配置。
 *
 *   - `options.admission`：显式控制器——既接受 `createAdmission()` 的返回值，
 *     也接受裸 controller 对象（内部再包一层 createAdmission）。
 *   - `options.admissionLimits`：启用内建 controller（进程共享单例）。
 *   - 两者都不给 → 返回 null，runtime 保持 0.10 的「并发不设上限」。
 */
function resolveRuntimeAdmission(options) {
  if (options.admission !== undefined && options.admission !== null) {
    if (isAdmissionLike(options.admission)) return options.admission
    if (!isPlainObject(options.admission)) {
      throw new TypeError('createRuntime 的 admission 必须是 createAdmission() 返回值或 controller 对象')
    }
    return createAdmission({ controller: options.admission })
  }
  if (options.admissionLimits !== undefined && options.admissionLimits !== null) {
    const limits = isPlainObject(options.admissionLimits) ? options.admissionLimits : {}
    return createAdmission({
      limits,
      queueMax: limits.queueMax,
      queueTimeoutMs: limits.queueTimeoutMs,
    })
  }
  return null
}

// ---------------------------------------------------------------------------
// createRuntime
// ---------------------------------------------------------------------------

/**
 * 创建进程级运行时。
 *
 * @param {{
 *   ctx?: any, runsRoot?: string, flowsRoot?: string,
 *   logger?: (level: string, message: string) => void,
 *   log?: (level: string, message: string) => void,
 *   now?: () => Date,
 *   stub?: boolean,
 *   createEngine?: (options: object) => object,
 *   onSettled?: (runId: string) => void,
 *   auditWorkflow?: Function,
 *   intervalMs?: number,
 *   nodeAlarmMs?: number, nodeSupervisionIntervalMs?: number,
 *   supervisionIntervalMs?: number,
 *   wakerHourlyLimit?: number, wakerMinIntervalMs?: number,
 *   setInterval?: Function, clearInterval?: Function,
 *   disposeTimeoutMs?: number,
 *   sessionEventByteLimit?: number, sessionEventLimit?: number,
 *   [key: string]: any,
 * }} [options] 其余字段原样透传给 Engine（activate / nodeTimeoutMs / staleMs / ...）
 */
export function createRuntime(options = {}) {
  const runs = new Map()
  /** 0.10 审查 F11：同一旧 run 的 restart 正在处理时不允许并发出第二个续跑 run。 */
  const restarting = new Set()
  const sessionIndex = new Map()
  const startedBy = new Map()
  /** G7-b：dispose 之后恢复扫描不再往调度器里登记新闹钟。 */
  let disposedRuntime = false
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const logger = typeof options.logger === 'function'
    ? options.logger
    : (typeof options.log === 'function' ? options.log : null)
  const runsRoot = typeof options.runsRoot === 'string' && options.runsRoot !== ''
    ? options.runsRoot
    : runsDir()
  const flowsRoot = typeof options.flowsRoot === 'string' && options.flowsRoot !== ''
    ? options.flowsRoot
    : flowsDir()
  const settledHook = typeof options.onSettled === 'function' ? options.onSettled : null
  const makeEngine = typeof options.createEngine === 'function'
    ? options.createEngine
    : engineOptions => createEngine(engineOptions)
  const auditFn = typeof options.auditWorkflow === 'function' ? options.auditWorkflow : defaultAuditWorkflow
  // 与 Engine 同一口径：显式 stub 优先，否则只看 env（index.js 会显式传判定结果）。
  const stub = options.stub === undefined
    ? process.env.FLOW_STUDIO_STUB_ENGINE === '1'
    : options.stub === true
  const engineName = stub ? 'stub' : 'real'

  const log = (level, message) => {
    if (!logger) return
    try {
      logger(level, message)
    } catch {
      // 日志实现抛错不该影响调度。
    }
  }

  // E2-b：卸载时等待在飞 Engine 收尾的上限；E2-c：每个 Engine 的事件缓冲双上限。
  const disposeTimeoutMs = Number.isFinite(options.disposeTimeoutMs) && options.disposeTimeoutMs > 0
    ? options.disposeTimeoutMs
    : DEFAULT_DISPOSE_TIMEOUT_MS
  const sessionEventByteLimit = Number.isInteger(options.sessionEventByteLimit) && options.sessionEventByteLimit > 0
    ? options.sessionEventByteLimit
    : DEFAULT_SESSION_EVENT_BYTE_LIMIT
  const sessionEventLimit = Number.isInteger(options.sessionEventLimit) && options.sessionEventLimit > 0
    ? options.sessionEventLimit
    : DEFAULT_SESSION_EVENT_LIMIT

  // 0.11 · R2/S1：准入控制器。**只有显式提供才启用**——不提供时下面的代码路径
  // 与 0.10 逐字一致（并发不设上限、没有排队）。
  const admission = resolveRuntimeAdmission(options)
  /**
   * 0.11 F5：从「发起 start」到「拿到槽位 / 建好 Engine」之间同步占住的 runId。
   * 读快照 / realpath 都是 await，不先占就是 await 穿透：两个并发 start 会一起通过
   * `runs.has()` 预检（第一个收尾很快时第二个甚至能再建一个 Engine）。
   */
  const starting = new Set()
  /** 0.11 F2：Engine 实例 → 本次执行世代（ownerId + epoch）；收尾时用来核对是否仍是持有者。 */
  const engineGenerations = new WeakMap()
  /** 本 runtime 正在排队等槽位的 runId（dispose 只取消自己的队，不碰共享 controller 里别人的）。 */
  const pendingStarts = new Set()
  /** runId → 一次性 release 包装（settleInstance 与 start 抛错共用，保证只还一次）。 */
  const admissionReleases = new Map()

  function trackAdmissionRelease(runId, release) {
    if (!admission) return null
    let called = false
    const once = () => {
      if (called) return
      called = true
      admissionReleases.delete(runId)
      try {
        release()
      } catch (error) {
        log('warn', `flow-studio: 释放执行槽位失败（${runId}）：${error && error.message ? error.message : String(error)}`)
      }
    }
    admissionReleases.set(runId, once)
    return once
  }

  /** 收尾 / 启动失败 / dispose 都走这里：同一个 run 的槽位只释放一次。 */
  function releaseAdmissionSlot(runId) {
    const once = admissionReleases.get(runId)
    if (!once) return false
    once()
    return true
  }

  // engineDeps：除 runtime 自己消费的键之外，全部透传（activate / stub / 超时 / ...）。
  const engineDeps = {}
  for (const [key, value] of Object.entries(options)) {
    if (RUNTIME_ONLY_KEYS.has(key)) continue
    engineDeps[key] = value
  }
  engineDeps.runsRoot = runsRoot
  engineDeps.flowsRoot = flowsRoot
  if (logger) engineDeps.log = logger

  // ── supervision：唯一一个调度器（07 §7） ────────────────────────────────

  /**
   * 到点唤醒发起会话：`agents.get` 优先，冷会话 `agents.resume`，再 `followup`。
   * 失败一律抛错 / 返回 false——连续 3 次由 scheduler 降级并停止调度。
   *
   * G7-a：调度器把「同一会话本轮到期的 run」合并后调用一次，`runIds` 带全部 runId；
   * 正文由 `supervisionWakePromptBatch` 生成（单个 run 的正文与旧版逐字相同）。
   *
   * @param {string} runId 主 run（payload 的 room / id 用它）
   * @param {{ wakerSessionId?: string, runIds?: string[] }} [options]
   */
  async function wakeRun(runId, { wakerSessionId, runIds } = {}) {
    const ctx = options.ctx
    let agents = null
    try {
      agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : (ctx && ctx.agents)
    } catch {
      agents = null
    }
    if (!agents || (typeof agents.get !== 'function' && typeof agents.resume !== 'function')) {
      throw new Error('agents 服务不可用，无法唤醒发起会话')
    }
    if (typeof wakerSessionId !== 'string' || wakerSessionId === '') {
      throw new Error('run.json 里没有 wakerSessionId，无法唤醒发起会话')
    }
    let agent = null
    try {
      if (typeof agents.get === 'function') agent = agents.get(wakerSessionId) || null
    } catch {
      agent = null
    }
    if (!agent) {
      if (typeof agents.resume !== 'function') {
        throw new Error(`发起会话 ${wakerSessionId} 不在线，且 agents.resume 不可用`)
      }
      // P0：冷 resume 必须带 setup 才能在宿主里挂 preset 组合（否则只剩宿主插件工具面）。
      const resumed = await resumeCold(ctx, agents, wakerSessionId, { log })
      agent = resumed && resumed.agent ? resumed.agent : null
    }
    if (!agent || typeof agent.followup !== 'function') {
      throw new Error(`发起会话 ${wakerSessionId} 无法接收消息（没有 followup）`)
    }
    // 合并批次：runId 作为主 id，runIds 缺省时就是它自己（单 run 行为不变）。
    const batch = normalizeWakeRunIds(Array.isArray(runIds) && runIds.length > 0 ? runIds : [runId])
    const primaryRunId = batch.length > 0 ? batch[0] : runId
    agent.followup(buildFollowupPayload({
      text: supervisionWakePromptBatch(batch.length > 0 ? batch : [runId]),
      runId: primaryRunId,
      nodeId: null,
      from: 'flow-studio',
    }))
    return true
  }

  /** 审计一个 run：readRunMeta + 全量事件 + 流程模板 → { verdict, run }。 */
  async function evaluateRun(runId) {
    const meta = await readRunMeta(runsRoot, runId)
    if (!meta) return { verdict: null, run: null }
    let events = []
    try {
      const all = await readAllEvents(runsRoot, runId)
      if (all && Array.isArray(all.events)) events = all.events
    } catch {
      events = []
    }
    let flow = null
    if (typeof meta.flowId === 'string' && meta.flowId !== '') {
      try {
        flow = await readFlow(flowsRoot, meta.flowId)
      } catch {
        flow = null
      }
    }
    let audited = null
    try {
      audited = auditFn({ flow, events, run: meta, now: now() })
    } catch (error) {
      log('warn', `supervision: 审计 run ${runId} 失败：${error && error.message ? error.message : String(error)}`)
      audited = null
    }
    return {
      verdict: audited && typeof audited.verdict === 'string' ? audited.verdict : null,
      run: { status: meta.status, startedAt: meta.startedAt },
    }
  }

  const defaultSetInterval = (fn, ms) => {
    const timer = setInterval(fn, ms)
    // 07 §7：别吊住事件循环（测试台 / dsh 退出时不因为 supervision 定时器卡住）。
    if (timer && typeof timer.unref === 'function') timer.unref()
    return timer
  }
  // 环境变量兜底：默认值太频繁时可以不改代码，起进程前设一下就行。
  //   扫描粒度：FLOW_STUDIO_SUPERVISION_INTERVAL_MS（两个调度器共用）
  //   节点自审：FLOW_STUDIO_NODE_ALARM_MS
  //   G7-a 会话预算：FLOW_STUDIO_WAKER_HOURLY_LIMIT / FLOW_STUDIO_WAKER_MIN_INTERVAL_MS
  const envMs = name => {
    const raw = process.env && process.env[name]
    const value = Number(raw)
    return Number.isInteger(value) && value > 0 ? value : undefined
  }
  // 最小间隔允许 0（显式关掉间隔限制），所以单独一个「非负整数」读法。
  const envNonNegativeInt = name => {
    const raw = process.env && process.env[name]
    const value = Number(raw)
    return Number.isInteger(value) && value >= 0 ? value : undefined
  }
  const intervalMs = Number.isFinite(options.supervisionIntervalMs) && options.supervisionIntervalMs > 0
    ? options.supervisionIntervalMs
    : (envMs('FLOW_STUDIO_SUPERVISION_INTERVAL_MS')
      ?? (Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : undefined))
  const wakerHourlyLimit = Number.isInteger(options.wakerHourlyLimit) && options.wakerHourlyLimit > 0
    ? options.wakerHourlyLimit
    : (envMs('FLOW_STUDIO_WAKER_HOURLY_LIMIT') ?? undefined)
  const wakerMinIntervalMs = Number.isInteger(options.wakerMinIntervalMs) && options.wakerMinIntervalMs >= 0
    ? options.wakerMinIntervalMs
    : (envNonNegativeInt('FLOW_STUDIO_WAKER_MIN_INTERVAL_MS') ?? undefined)

  const supervision = new SupervisionScheduler({
    now,
    intervalMs,
    ...(wakerHourlyLimit === undefined ? {} : { wakerHourlyLimit }),
    ...(wakerMinIntervalMs === undefined ? {} : { wakerMinIntervalMs }),
    setInterval: typeof options.setInterval === 'function' ? options.setInterval : defaultSetInterval,
    clearInterval: typeof options.clearInterval === 'function' ? options.clearInterval : undefined,
    log,
    evaluate: evaluateRun,
    wake: wakeRun,
    load: async runId => {
      const meta = await readRunMeta(runsRoot, runId)
      return meta && isPlainObject(meta.supervision) ? meta.supervision : null
    },
    save: async (runId, next) => {
      await saveSupervision(runsRoot, runId, next)
    },
  })

  // 07 §7：runtime 起来就把调度器挂上（唯一一个 interval，幂等）。
  supervision.start()

  // ── 节点闹钟：每个节点主管会话的定时自审（v0.8 §11） ──────────────────
  //
  // 与 run 级 supervision 共用同一个 runtime / 同一份 logger / 同一个
  // `setInterval` 注入（测试里可以一起替换成假定时器）；调度器本身只管
  // 「什么时候叫、失败几次后停」，真正把提问送进节点会话的 `wake(entry)` 在这里实现。
  const nodeAlarmMs = Number.isFinite(options.nodeAlarmMs) && options.nodeAlarmMs > 0
    ? options.nodeAlarmMs
    : envMs('FLOW_STUDIO_NODE_ALARM_MS')
  const nodeIntervalMs = Number.isFinite(options.nodeSupervisionIntervalMs)
    && options.nodeSupervisionIntervalMs > 0
    ? options.nodeSupervisionIntervalMs
    : intervalMs

  /**
   * 节点闹钟到点动作（v0.8 §11.1 + C2 凭证回显）：busy → inject（不新开回合）；
   * idle → followup；冷会话先 `agents.resume`。任何拿不到会话 / 投不出去的情况
   * 返回 `{action:'skip', reason}`，**真正的异常不在这里吞**——抛给 scheduler 计 failures。
   *
   * C2（07 §11.3）：引擎只接受**回显本轮 attempt + 一次性 nonce** 的自审回报。凭证由
   * 引擎的 `attemptEnvelopeFor(sessionId)` 给出；拿不到（没有活跃实例 / 当前不在
   * attempt 中 / 引擎未实现）时**这一次不发**——发出去注定被引擎丢弃，只会是噪音。
   * 跳过不是失败：scheduler 会把它记成 `lastOutcome:'skip'` + `lastReason:'skip: <原因>'`，
   * 在 `nodeSupervision.snapshot().entries[]` 里可见。
   */
  // 「引擎未实现 attemptEnvelopeFor」的告警每个实例只打一次，避免每次闹钟刷日志。
  const envelopeUnavailableWarned = new WeakSet()

  async function wakeNode(entry) {
    const ctx = options.ctx
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (!agents) return { action: 'skip', reason: 'no-agents-service' }

    // ── C2 前置条件：本 run 的活跃 Engine + 本轮 attempt/nonce 凭证 ──────────
    // 注意顺序：先确认「能发」再决定要不要 resume 冷会话 / 拿 agent（避免白 resume）。
    const runId = typeof entry.runId === 'string' ? entry.runId : ''
    const engine = runId === '' ? null : runs.get(runId) || null
    if (!engine) {
      log('warn', `flow-studio: 节点闹钟跳过 ${entry.sessionId}：run ${runId || '(空)'} 没有活跃 Engine 实例（无法取 attempt/nonce 凭证）`)
      return { action: 'skip', reason: 'no-engine-instance' }
    }
    if (typeof engine.attemptEnvelopeFor !== 'function') {
      if (!envelopeUnavailableWarned.has(engine)) {
        envelopeUnavailableWarned.add(engine)
        log('warn', 'flow-studio: 当前 Engine 没有 attemptEnvelopeFor()，节点自审无法回显 nonce；已跳过节点闹钟（等引擎实现后自动恢复）')
      }
      return { action: 'skip', reason: 'no-attempt-envelope' }
    }
    let envelope = null
    try {
      envelope = engine.attemptEnvelopeFor(entry.sessionId)
    } catch (error) {
      log('warn', `flow-studio: 节点闹钟读取 attempt/nonce 凭证失败（${entry.sessionId}）：${error && error.message ? error.message : String(error)}`)
      return { action: 'skip', reason: 'no-attempt-envelope' }
    }
    if (!isPlainObject(envelope)
      || !Number.isInteger(envelope.attempt)
      || typeof envelope.nonce !== 'string'
      || envelope.nonce === '') {
      // 典型场景：节点当前不在 `_promptNodeSession` 的 attempt 期间（两次 attempt 之间），
      // 引擎已经丢弃凭证；这时发提示词只会被引擎按「没有下发中的 attempt 凭证」丢掉。
      log('warn', `flow-studio: 节点闹钟跳过 ${entry.sessionId}：当前没有可回显的 attempt/nonce 凭证（回报会被引擎丢弃）`)
      return { action: 'skip', reason: 'no-attempt-envelope' }
    }
    const nodeId = typeof envelope.nodeId === 'string' && envelope.nodeId !== ''
      ? envelope.nodeId
      : entry.nodeId

    let agent = typeof agents.get === 'function' ? agents.get(entry.sessionId) : null
    if (!agent) {
      if (typeof agents.resume !== 'function') return { action: 'skip', reason: 'no-resume' }
      // P0：同 wakeRun —— 冷 resume 的 setup 是挂 preset 组合的唯一入口。
      const handle = await resumeCold(ctx, agents, entry.sessionId, { log })
      agent = handle && handle.agent ? handle.agent : null
    }
    if (!agent) return { action: 'skip', reason: 'no-agent' }
    const payload = buildFollowupPayload({
      // 用引擎给的本轮凭证（attempt 以引擎为准，entry.attempt 可能滞后）。
      text: nodeSelfCheckPrompt({
        runId,
        nodeId,
        attempt: envelope.attempt,
        nonce: envelope.nonce,
      }),
      runId,
      nodeId,
      from: 'flow-studio',
    })
    const status = typeof agent.status === 'string' ? agent.status : ''
    if (status === 'idle' && typeof agent.followup === 'function') {
      agent.followup(payload)
      return { action: 'followup' }
    }
    if (typeof agent.inject === 'function') {
      agent.inject(payload)
      return { action: 'inject' }
    }
    if (typeof agent.followup === 'function') {
      agent.followup(payload)
      return { action: 'followup' }
    }
    return { action: 'skip', reason: 'no-delivery' }
  }

  const nodeSupervision = new NodeSupervisionScheduler({
    now,
    log,
    wake: wakeNode,
    ...(nodeIntervalMs === undefined ? {} : { intervalMs: nodeIntervalMs }),
    ...(nodeAlarmMs === undefined ? {} : { nodeAlarmMs }),
    setInterval: typeof options.setInterval === 'function' ? options.setInterval : defaultSetInterval,
    clearInterval: typeof options.clearInterval === 'function' ? options.clearInterval : undefined,
  })

  // 与 run 级 supervision 同时起（幂等）：engine 在 create 成功后 register，到点由这里叫。
  nodeSupervision.start()

  // engine 那一路会用它 register / unregister（v0.8 §11.1）。
  engineDeps.nodeSupervision = nodeSupervision

  // ── E2-a：重启收口（running 但本进程没有实例负责的 run） ─────────────────
  //
  // **「凭什么判断不是本进程负责」的完整判定链**（顺序执行，越靠前越权威）：
  //   1. 本进程实例注册表 `runs`（本 runtime 的 runId → Engine）；
  //   2. 本进程活跃集合 `LIVE_RUN_IDS`（同进程另一个 runtime 的实例）；
  //   3. 跨进程：runstore 单写者租约 `runs/<runId>/lock.json`
  //      `{ pid, host, heartbeatAt, ttlMs }`。Engine 开跑时 `claimLease()`（O_EXCL 原子
  //      创建 + 复核），运行期每 30s `renewLease()`；`readLease()` 会把过期租约当成
  //      无主并清掉（TTL 由 runstore 决定，默认 90s）。判定：
  //        - 没有租约（从未持有 / 已被 readLease 清掉）→ 本进程可收口；
  //        - 租约 host == 本机且 pid == 本进程 → 是本进程的残留（没有实例）→ 可收口；
  //        - 租约 host == 本机、pid != 本进程 → `process.kill(pid, 0)` 探活：
  //          活着（含 EPERM）→ **另一个进程正在跑，禁止收口**；ESRCH → 进程已死 → 可收口；
  //        - 租约 host != 本机 → 无法探活，**保守跳过**（宁可留着让过期 sweep 收，也不跨机误杀）。
  //   4. 拿到「可收口」判定后仍要**抢收口权**：先清掉可安全接管的旧租约，再自己
  //      `claimLease()` 一次（O_EXCL）。抢到 = 这段时间不会有另一个进程同时 start；
  //      抢不到（409）= 别人刚接管，直接跳过。然后再读一次 run.json 确认仍是 running
  //      才写终态，最后在收口里释放这份临时租约。
  //
  // 跨进程前提：`appendEvents` 的 `withLock` 只保证**进程内**串行，同 DSH_HOME 的多个
  // 进程之间没有文件锁——单写者租约就是唯一的互斥依据。所以这里绝不能在租约可被
  // 别人持有时写 run.json / run.jsonl；上面的「抢租约 → 二次确认」就是为此。
  //
  // 已知边界：心跳判定同样是「以租约为准」——另一个进程若卡死超过 TTL，它的租约会
  // 过期并被当作无主（与 runstore.sweepExpiredLeases 的既有口径一致）；这时收口是
  // 预期行为，不是误杀。

  /**
   * 这个租约还能不能证明「别的进程正在跑」？
   *
   * 判定依据（只用 runstore 现有的租约字段 pid / host / heartbeatAt / ttlMs）：
   *   - 没有租约（含已过期被 readLease 清掉）→ 无主，可收口；
   *   - 同一台机器 + 同一个 pid → 是本进程的残留（本进程此刻没有实例）→ 可收口；
   *   - 同一台机器 + 别的 pid → `process.kill(pid, 0)` 探活：活着 / 无权限 → **不许收**，
   *     进程已不存在（ESRCH）→ 可收口；
   *   - 别的 host → 无法探活，保守跳过（不跨机误杀）。
   *
   * @param {{ pid: number, host: string } | null} lease
   * @returns {boolean} true = 可以安全收口
   */
  function leaseIsReapable(lease) {
    if (!lease) return true
    if (lease.host !== LOCAL_HOST) return false
    if (lease.pid === process.pid) return true
    try {
      process.kill(lease.pid, 0)
      return false
    } catch (error) {
      return Boolean(error && error.code === 'ESRCH')
    }
  }

  /**
   * 把一个无实例的 running run 收成 failed（重启收口）。
   *
   * 落三样东西：run/end 事件（可读原因 + 时间戳）、run.json 终态、supervision
   * 关闭标记（enabled=false / reason=restarted / 清 nextDueAt、lastWokeAt），
   * 再释放租约并摘掉任何调度登记。
   *
   * @param {string} runId
   * @returns {Promise<string>} 收口时间（ISO）
   */
  async function failRestartedRun(runId) {
    const at = now().toISOString()
    const reason = `进程重启后该 run 没有执行实例（${ORPHAN_REASON} at ${at}）`
    // 1) 历史可读：run/end 带 reason + ts（不带 nodeId/attemptId，否则 runlog 会 400）。
    try {
      await appendEvents(runsRoot, runId, [{
        v: 1,
        kind: 'run/end',
        traceId: `tr-${String(runId).slice(0, 80)}-run`,
        data: { status: 'failed', reason },
        extra: { recovered: true, restartOrphan: true, detectedAt: at },
      }], { now: now() })
    } catch (error) {
      log('warn', `flow-studio: 重启收口写 run/end 失败（${runId}）：${error && error.message ? error.message : String(error)}`)
    }
    // 2) 终态；live 清空（不要再让面板显示「还在跑」）。
    try {
      await writeRunMeta(runsRoot, runId, { status: 'failed', endedAt: at, live: null })
    } catch (error) {
      log('warn', `flow-studio: 重启收口写 run.json 失败（${runId}）：${error && error.message ? error.message : String(error)}`)
    }
    // 3) 清唤醒标记（合并写，只动 supervision 这一个键）。
    await saveSupervision(runsRoot, runId, {
      enabled: false,
      reason: ORPHAN_REASON,
      lastWokeAt: null,
      nextDueAt: null,
      // 唤醒目标也清掉：已收口的 run 不该再留着「到点叫谁」的标记。
      wakerSessionId: null,
    }).catch(error => {
      log('warn', `flow-studio: 重启收口写 supervision 失败（${runId}）：${error.message}`)
    })
    // 4) 摘调度登记（幂等）+ 释放租约（reclaimOrphanRuns 抢到的临时收口租约）。
    try {
      supervision.unregister(runId)
    } catch {
      // 调度器清理失败不该影响收口。
    }
    try {
      nodeSupervision.unregisterRun(runId)
    } catch {
      // 调度器清理失败不该影响收口。
    }
    await releaseLease(runsRoot, runId, { force: true }).catch(() => {})
    return at
  }

  /**
   * 初始化 / 首次扫描的收口：对 `status === 'running'` 且本进程没有实例负责的 run，
   * **无条件**收成 failed。幂等：已经 failed 的 run 不在扫描范围内，重复调用无副作用。
   *
   * @returns {Promise<string[]>} 本次被收口的 runId
   */
  async function reclaimOrphanRuns() {
    let entries = []
    try {
      entries = await readdir(runsRoot, { withFileTypes: true })
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        log('warn', `flow-studio: 重启收口扫描失败：${error && error.message ? error.message : String(error)}`)
      }
      return []
    }
    const reclaimed = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !checkRunId(entry.name)) continue
      const runId = entry.name
      // 本进程有实例（本 runtime 或同进程另一个 runtime）→ 不是孤儿。
      if (runs.has(runId) || LIVE_RUN_IDS.has(runId)) continue
      const meta = await readRunMeta(runsRoot, runId).catch(() => null)
      if (!meta || meta.status !== 'running') continue
      let lease = null
      try {
        lease = await readLease(runsRoot, runId)
      } catch (error) {
        log('warn', `flow-studio: 重启收口读租约失败（${runId}）：${error && error.message ? error.message : String(error)}`)
        continue
      }
      if (!leaseIsReapable(lease)) {
        log('info', `flow-studio: 重启收口跳过 ${runId}：执行租约由 ${lease.pid}@${lease.host} 持有（另一个进程仍在跑）`)
        continue
      }
      // 跨进程收口权：旧租约已判定「可安全接管」→ 先清掉它，再用 O_EXCL 抢一份新租约。
      // 这样另一个进程同时 start 会在 claimLease 处 409，不会出现「两边同时写 run.json」。
      if (lease) {
        try {
          await releaseLease(runsRoot, runId, { force: true })
        } catch (error) {
          log('warn', `flow-studio: 重启收口清旧租约失败（${runId}）：${error && error.message ? error.message : String(error)}`)
          continue
        }
      }
      try {
        await claimLease(runsRoot, runId)
      } catch (error) {
        // 409 = 另一个进程刚接管了单写者角色：本次不碰它，交给对方 / 下一轮扫描。
        log('info', `flow-studio: 重启收口跳过 ${runId}：抢收口租约失败（${error && error.message ? error.message : String(error)}）`)
        continue
      }
      // 抢到租约后二次确认：期间 run 可能已经被别人收尾（或状态已变），也可能本进程
      // 刚好把它 start 起来（runs/LIVE 注册晚于第一次检查）——这两种情况都不能动它。
      if (runs.has(runId) || LIVE_RUN_IDS.has(runId)) {
        await releaseLease(runsRoot, runId, { force: true }).catch(() => {})
        continue
      }
      const latest = await readRunMeta(runsRoot, runId).catch(() => null)
      if (!latest || latest.status !== 'running') {
        await releaseLease(runsRoot, runId, { force: true }).catch(() => {})
        continue
      }
      try {
        const at = await failRestartedRun(runId)
        reclaimed.push(runId)
        log('warn', `flow-studio: 重启收口：run ${runId} 没有执行实例，标记 failed（${ORPHAN_REASON} at ${at}）`)
      } catch (error) {
        await releaseLease(runsRoot, runId, { force: true }).catch(() => {})
        log('warn', `flow-studio: 重启收口 ${runId} 失败：${error && error.message ? error.message : String(error)}`)
      }
    }
    return reclaimed
  }

  /** 摘掉已收尾的实例（只摘自己那一份，避免误删后来者）。 */
  function settleInstance(runId, engine) {
    if (runId !== null && runs.get(runId) !== engine) return
    if (runId !== null) {
      runs.delete(runId)
      LIVE_RUN_IDS.delete(runId)
      // 0.11 · R2/S1：run 收尾即还槽位（幂等；start 抛错路径也调同一个包装）。
      releaseAdmissionSlot(runId)
    }
    // 收尾后不再需要 session/event 订阅；不释放会让每个结束的 run 继续缓冲全局会话事件。
    try {
      engine.dispose()
    } catch {
      // 释放失败不该影响收尾。
    }
    if (runId !== null) {
      // 0.11 F2：本实例的世代。失权（lease-lost）后的迟到收尾必须拿它核对当前持有者，
      // 不能无条件摘掉接管者刚登记的 supervision / 落盘 enabled=false。
      const generation = engineGenerations.get(engine) || null
      engineGenerations.delete(engine)
      const cleanup = async () => {
        let meta = null
        try {
          meta = await readRunMeta(runsRoot, runId)
        } catch {
          meta = null
        }
        // 落盘前核对：run.json.execution 仍是本实例 claim 到的世代吗？
        if (meta && !executionMatchesGeneration(meta.execution, generation)) {
          log('info', `flow-studio: run ${runId} 的持久世代已属于接管者（${generationLabel(generation)} 已失效），`
            + '旧实例只摘自己的资源，跳过 supervision / 节点闹钟清理')
          return
        }
        // 落盘用持久 fence 再原子核对一次：检查与写入之间若发生接管，runstore 会 409
        // LEASE_FENCED，绝不覆盖接管者的 supervision。
        const supervisionPatch = {
          ...(meta && isPlainObject(meta.supervision) ? meta.supervision : {}),
          enabled: false,
          reason: 'terminal',
        }
        const fence = meta && isPlainObject(meta.execution) ? generationFence(generation) : {}
        try {
          if (meta) await writeRunMeta(runsRoot, runId, { supervision: supervisionPatch }, fence)
        } catch (error) {
          if (error && (error.status === 409 || error.code === 'LEASE_FENCED')) {
            log('info', `flow-studio: run ${runId} 收尾写 supervision 被 fence 拒绝（世代已属于接管者），`
              + '保留接管者的调度登记')
            return
          }
          log('warn', `flow-studio: runtime 收尾写 supervision 失败（${runId}）：${error.message}`)
          return
        }
        // 只有「仍持有 + 落盘成功」才摘掉本 run 的两个调度登记。
        try {
          supervision.unregister(runId)
        } catch {
          // 调度器状态清理失败不该影响收尾。
        }
        try {
          nodeSupervision.unregisterRun(runId)
        } catch {
          // 调度器状态清理失败不该影响收尾。
        }
        // 终态 run 不再需要 waker 缓存（避免进程内 Map 随历史 run 累积）。
        RUN_WAKERS.delete(runWakerKey(runsRoot, runId))
      }
      // settleInstance 由 Engine 的同步回调调用：本地资源同步摘，持久清理异步完成。
      void cleanup().catch(error => {
        log('warn', `flow-studio: runtime 收尾清理失败（${runId}）：${error && error.message ? error.message : String(error)}`)
      })
    }
    if (runId !== null && settledHook) {
      try {
        settledHook(runId)
      } catch (error) {
        if (logger) logger('warn', `flow-studio: runtime onSettled 失败（${runId}）：${error.message}`)
      }
    }
  }

  /** 为一次 run 创建 Engine 实例；onSettled 捕获实例引用，便于精确摘除。 */
  function newEngine(runId) {
    let engine = null
    engine = makeEngine({
      ...engineDeps,
      sessionIndex,
      startedBy,
      now,
      onSettled: settledRunId => settleInstance(settledRunId, engine),
    })
    // E2-c：runtime 创建的实例才装归属过滤 / 双上限缓冲（暂存型 sweep 实例不装）。
    if (typeof runId === 'string' && runId !== '') {
      try {
        scopeEngineSessionEvents(engine, {
          runId,
          runsRoot,
          limitEvents: sessionEventLimit,
          limitBytes: sessionEventByteLimit,
        })
      } catch (error) {
        log('warn', `flow-studio: 装 session/event 归属过滤失败（${runId}）：${error && error.message ? error.message : String(error)}`)
      }
    }
    return engine
  }

  /**
   * 0.11 F5：每工作区配额键。
   *
   * 必须用**来源工作区**（startOptions.workspace，其次 cwd，其次 run.json 绑定）的
   * realpath——两个软链别名指向同一目录时归一到同一个键，不能各占一份额度。
   * 路径不存在 / realpath 失败时退回绝对化后的原值（仍然比 raw 相对路径稳定）。
   */
  async function workspaceQuotaKey(startOptions, meta) {
    const candidates = []
    if (typeof startOptions.workspace === 'string' && startOptions.workspace !== '') {
      candidates.push(startOptions.workspace)
    } else if (typeof startOptions.cwd === 'string' && startOptions.cwd !== '') {
      candidates.push(startOptions.cwd)
    } else if (meta && isPlainObject(meta.workspace)) {
      if (typeof meta.workspace.realpath === 'string' && meta.workspace.realpath !== '') {
        candidates.push(meta.workspace.realpath)
      } else if (typeof meta.workspace.path === 'string' && meta.workspace.path !== '') {
        candidates.push(meta.workspace.path)
      }
    }
    if (candidates.length === 0) return 'default'
    const absolute = resolve(candidates[0])
    try {
      return await realpath(absolute)
    } catch {
      return absolute
    }
  }

  async function start(runId, startOptions = {}) {
    if (!checkRunId(runId)) throw new EngineError(400, 'runId 不合法')
    // 07 §5：唯一 409 就是「同一个 runId 已在跑」。
    if (runs.has(runId)) throw new EngineError(409, `同一 run 已在运行（${runId}）`)
    // 已有准入票（queued / reserved / running）：保持既有 409 payload（AdmissionError），
    // 不能因为新增的同步占位就把它降级成一条普通 EngineError。
    if (admission && admission.admissionOf(runId)) {
      return admission.acquire({ runId })
    }
    // 0.11 F5：读快照 / realpath 之前先同步占住 runId，堵住 await 穿透：
    // 两个并发 start 同一 runId 时，第二个在预检处直接 409，不会重复读快照、
    // 更不会在第一个刚收尾后另建一个 Engine。
    if (starting.has(runId)) throw new EngineError(409, `同一 run 已在运行（${runId}）`)
    if (!admission) return startReserved(runId, startOptions, null)

    starting.add(runId)
    try {
      // 0.11 R2：入队前冻结流程快照（含 node.check）；排队期间保存流程不改变实际执行命令。
      let meta = null
      try {
        meta = await readRunMeta(runsRoot, runId)
      } catch {
        meta = null
      }
      let effectiveOptions = startOptions
      if (!effectiveOptions.flowSnapshot && meta && typeof meta.flowId === 'string' && meta.flowId !== '') {
        let snapshot
        try {
          snapshot = await readFlow(flowsRoot, meta.flowId)
        } catch (error) {
          // F5：快照读失败显式报错（不能退化成出队时读「最新流程」）。
          throw new EngineError(500, `读取流程快照失败（${meta.flowId}），不能启动：${error && error.message ? error.message : String(error)}`)
        }
        if (!snapshot) {
          throw new EngineError(404, `流程快照不存在（${meta.flowId}），不能启动`)
        }
        effectiveOptions = { ...effectiveOptions, flowSnapshot: snapshot }
      }
      // F5：配额键用来源工作区 realpath 规范化，软链别名不能绕过每工作区额度。
      const workspaceKey = await workspaceQuotaKey(startOptions, meta)
      // 0.11 · R2/S1：`acquire` 在返回 Promise 之前就同步登记了 queued / reserved，
      // 所以两个并发 start 同一 runId 时，第二个会在 acquire 的重复检查处直接 409，
      // 不会穿透到 newEngine（不会出现两个 Engine 实例）。
      pendingStarts.add(runId)
      let slotRelease = null
      try {
        slotRelease = await admission.acquire({
          runId,
          workspaceKey,
          signal: effectiveOptions ? effectiveOptions.signal : undefined,
        })
      } catch (error) {
        pendingStarts.delete(runId)
        throw error
      }
      pendingStarts.delete(runId)
      return startReserved(runId, effectiveOptions, slotRelease)
    } finally {
      starting.delete(runId)
    }
  }

  /**
   * 拿到槽位之后的启动路径：这里才创建 Engine / 写 run/start。
   * 排队期间（acquire 未 resolve）不碰 Engine，也不写 run.json。
   */
  async function startReserved(runId, startOptions, slotRelease) {
    // v0.8 §11：节点闹钟随 runtime 起（幂等；engine 在 create 成功后自行 register）。
    nodeSupervision.start()
    if (admission) trackAdmissionRelease(runId, slotRelease)
    let engine = null
    try {
      engine = newEngine(runId)
      runs.set(runId, engine)
      LIVE_RUN_IDS.add(runId)
      // 槽位从 reserved 变 running（只影响 admissionOf 的可观测状态，不额外计数）。
      if (admission) {
        try {
          admission.markRunning(runId)
        } catch (error) {
          log('warn', `flow-studio: 标记 run 执行态失败（${runId}）：${error && error.message ? error.message : String(error)}`)
        }
      }
      const started = await engine.start(runId, startOptions)
      // 0.11 F2：记下本次执行世代（claimLease 产出的 ownerId + epoch）。
      // Engine 在收尾时先 releaseLease 再 onSettled，所以必须在这里（active 还在时）抓。
      if (runs.get(runId) === engine) {
        const generation = engineLeaseGeneration(engine)
        if (generation) engineGenerations.set(engine, generation)
      }
      return started
    } catch (error) {
      // 启动失败：把实例从表里摘掉（调用方拿到的错误照原样抛）。
      if (engine && runs.get(runId) === engine) {
        runs.delete(runId)
        LIVE_RUN_IDS.delete(runId)
      }
      if (engine) {
        try {
          engine.dispose()
        } catch {
          // 忽略释放失败。
        }
      }
      // 槽位必须还回去（若 Engine 已经自己收尾过，这里的包装是幂等的 no-op）。
      releaseAdmissionSlot(runId)
      throw error
    }
  }

  function requireRunning(runId) {
    if (!checkRunId(runId)) throw new EngineError(400, 'runId 不合法')
    const engine = runs.get(runId)
    if (!engine) throw new EngineError(409, '该 run 不在运行中')
    return engine
  }

  async function stop(runId) {
    if (!checkRunId(runId)) throw new EngineError(400, 'runId 不合法')
    // 0.11 · R2/S1：还在排队的 run 没有 Engine 可 stop——原子摘票并 409。
    if (admission) {
      const queued = admission.admissionOf(runId)
      if (queued && queued.state === 'queued') {
        admission.cancel(runId, 'stop')
        const limits = admission.limits
        const current = admission.snapshot()
        throw new EngineError(409, `run 正在排队（${runId}），已取消执行请求`, {
          code: 'RUN_CONCURRENCY_LIMIT',
          reason: 'stop',
          scope: 'global',
          runId,
          active: current.active,
          max: limits.global,
          limits: { global: limits.global, perWorkspace: limits.perWorkspace },
          retryAfterMs: 30000,
        })
      }
    }
    const engine = requireRunning(runId)
    return engine.stop(runId)
  }

  /** 宿主 agents 服务（可选依赖；restart 用它判断「旧会话还能不能 resume」）。 */
  function agentsService() {
    const ctx = options.ctx
    if (!ctx) return null
    try {
      if (typeof ctx.get === 'function') return ctx.get('agents') || null
      return ctx.agents || null
    } catch {
      return null
    }
  }

  /**
   * 失败 / 中止后重启（v0.9.2 · 任务 3）。
   *
   * 语义：**新建一个 run**，继承旧 run 已完成的进度与节点会话，从旧 run 失败 /
   * 中止的节点继续；旧 run 保持终态、一个字都不改写。
   *
   * 步骤：
   *   ① 校验旧 run：必须存在且是 failed / aborted（pending/running/done 都 400，中文原因）；
   *   ② 校验当前流程结构（`validateFlowForRun`）；从旧事件流推导续跑起点与已完成节点；
   *   ③ 读旧 `sessions.json`，只把当前流程里仍存在的阶段节点会话复制进新 run
   *      （新 run 的引擎 `_loadNodeSessions` 会加载它，冷会话靠 `agents.resume` 续跑）；
   *   ④ 写 `run.json.restart`（fromRunId / 第几次续跑 / 旧失败原因 / 跳过节点 / note）；
   *   ⑤ 带 `resumePlan` 启动新 run（续跑 run 走旧主循环，支持显式起点）。
   *
   * 为什么不改写旧 run 做 continuation：旧 run 的 run/end、租约、supervision、
   * 事件序号都是「已经发生过的事实」；原地续跑要么改写历史终态（违反审计），要么
   * 让 run.json 的 status 在 done/failed 之间来回跳（前端 / 指标会看到两次收尾）。
   * 新 run 有独立事件流，`restart.fromRunId` + `restart.attempt` 足以还原世系。
   *
   * @param {string} oldRunId
   * @param {{ note?: string }} [restartOptions]
   * @returns {Promise<{ run: object, restart: object, plan: object }>}
   */
  async function restart(oldRunId, restartOptions = {}) {
    if (!checkRunId(oldRunId)) throw new EngineError(400, 'runId 不合法')
    // 0.10 审查 F11：并发 restart 会各自复制同一批 sessions.json，产生两个续跑 run
    // 同时 resume 同一会话。这里做进程内互斥 + 持久化子 run 检查（跨请求/跨进程第二道）。
    if (restarting.has(oldRunId)) {
      throw new EngineError(400, `run 正在重启中（${oldRunId}），请等上一次 restart 返回后再试`)
    }
    restarting.add(oldRunId)
    try {
      return await restartOnce(oldRunId, restartOptions)
    } finally {
      restarting.delete(oldRunId)
    }
  }

  /** restart 的实际实现（互斥壳见上）。 */
  async function restartOnce(oldRunId, restartOptions = {}) {
    if (runs.has(oldRunId)) {
      throw new EngineError(400, `run 还在运行中（${oldRunId}），不能重启：先等它收尾或 stop 再续跑`)
    }
    const oldMeta = await readRunMeta(runsRoot, oldRunId)
    if (!oldMeta) throw new EngineError(404, `run 不存在（${oldRunId}）`)
    // 持久化互斥：已经有一个续跑自该 run 的子 run 时，再重启会重复复制会话。
    // 让用户继续/停止那个子 run（续跑失败就重启子 run），而不是并排两个。
    let retryChild = null
    try {
      const listed = await listRuns(runsRoot, { limit: 100 })
      for (const item of listed.runs || []) {
        if (!item || item.id === oldRunId) continue
        const meta = await readRunMeta(runsRoot, item.id)
        if (!meta || !meta.restart || meta.restart.fromRunId !== oldRunId) continue
        // 0.11 R2：上次 restart 在准入处被 429 拒绝、run/start 从未写出 → 同一个子 run
        // 可重试（复用 childRunId / resumePlan），不能被「存在任意 child」永久挡住。
        if (meta.restart.startRejected && meta.status === 'pending' && meta.started !== true) {
          retryChild = meta
          continue
        }
        throw new EngineError(400, `该 run 已经有续跑 run（${item.id}）；请继续或停止它，不要重复重启`)
      }
    } catch (error) {
      if (error instanceof EngineError) throw error
      // 列表读失败不阻塞 restart（互斥仍由进程内 Set 保护）。
    }
    if (!RESTARTABLE_STATUSES.has(oldMeta.status)) {
      if (oldMeta.status === 'pending' || oldMeta.status === 'running') {
        throw new EngineError(400, `run 还没结束（当前 ${oldMeta.status}），不能重启：先等它收尾或 stop 再续跑`)
      }
      throw new EngineError(400, `run 已成功结束（${oldMeta.status}），不需要重启`)
    }
    const flow = await readFlow(flowsRoot, oldMeta.flowId)
    if (!flow) throw new EngineError(404, `流程不存在（${oldMeta.flowId}）`)
    const validation = validateFlowForRun(flow)
    if (!validation.ok) {
      throw new EngineError(
        400,
        `当前流程结构不合法，不能续跑：${validation.errors.map(item => item.message).join('；')}`,
      )
    }
    const { plan } = await prepareRestart({ runsRoot, runId: oldRunId, flow })
    const stages = (flow.nodes || []).filter(node => node.kind === 'stage')
    const stageIds = new Set(stages.map(node => node.id))
    const oldSessions = await readNodeSessions(runsRoot, oldRunId)
    const inherited = {}
    for (const [nodeId, entry] of Object.entries(oldSessions)) {
      if (!stageIds.has(nodeId)) continue
      if (!entry || typeof entry.sessionId !== 'string' || entry.sessionId === '') continue
      inherited[nodeId] = entry
    }
    // 只有真的要复用旧会话时才要求 agents 能力；没有会话可继承（stub / 纯新节点）照常重启。
    if (Object.keys(inherited).length > 0) {
      const agents = agentsService()
      const canAttach = Boolean(agents
        && (typeof agents.get === 'function' || typeof agents.resume === 'function'))
      if (!canAttach) {
        throw new EngineError(
          503,
          '旧 run 有可继承的节点会话，但宿主 agents 服务不可用（既没有 get 也没有 resume），'
          + '无法在原会话续跑；请恢复 agents 服务后重启，或从画布另建一个全新 run',
        )
      }
    }
    const attempt = (oldMeta.restart && Number.isInteger(oldMeta.restart.attempt)
      ? oldMeta.restart.attempt
      : 0) + 1
    const note = typeof restartOptions.note === 'string' && restartOptions.note.trim() !== ''
      ? restartOptions.note.trim().slice(0, 500)
      : undefined
    const name = `${oldMeta.name || oldMeta.flowName || oldMeta.flowId}（续跑 ${attempt}）`
    const created = retryChild
      ? { id: retryChild.id }
      : await createRun(runsRoot, {
        flowId: oldMeta.flowId,
        flowName: oldMeta.flowName || oldMeta.flowId,
        name,
        nodeTotal: stages.length,
        engine: oldMeta.engine === 'stub' ? 'stub' : 'real',
      })
    // 继承旧 run 的节点会话：新 run 的 engine.start → _loadNodeSessions 会读这份表；
    // 每个节点仍用同一个 sessionId，冷会话由 _followupNodeSession → agents.resume 续上。
    if (!retryChild && Object.keys(inherited).length > 0) {
      await writeNodeSessions(runsRoot, created.id, inherited)
    }
    const restartInfo = {
      fromRunId: oldRunId,
      attempt,
      oldStatus: oldMeta.status,
      oldReason: plan.oldFailure.reason,
      startNodeId: plan.startNodeId,
      skippedNodeIds: plan.skipped.map(item => item.nodeId),
      inheritedNodeIds: Object.keys(inherited),
      at: now().toISOString(),
      ...(note === undefined ? {} : { note }),
    }
    const workspacePath = (oldMeta.worktree && oldMeta.worktree.enabled === true
      && typeof oldMeta.worktree.path === 'string' && oldMeta.worktree.path !== '')
      ? oldMeta.worktree.path
      : (oldMeta.workspace && typeof oldMeta.workspace.path === 'string' ? oldMeta.workspace.path : null)
    await writeRunMeta(runsRoot, created.id, {
      restart: restartInfo,
      ...(workspacePath === null ? {} : { startOptions: { workspace: workspacePath, worktree: 'off' } }),
    })
    // 续跑 run 同样带上工作区绑定（引擎 start 会再校验一次，这里提前定死便于 202 即读）。
    if (oldMeta.workspace && typeof oldMeta.workspace === 'object') {
      await writeRunMeta(runsRoot, created.id, { workspace: oldMeta.workspace })
    }
    // 保留旧 run 的监视/回复约定：新 run 的 wakerSessionId 沿用旧 run 的 supervision。
    const wakerSessionId = oldMeta.supervision && typeof oldMeta.supervision.wakerSessionId === 'string'
      ? oldMeta.supervision.wakerSessionId
      : undefined
    if (wakerSessionId) {
      await writeRunMeta(runsRoot, created.id, {
        supervision: { enabled: false, wakerSessionId, reason: 'restarted' },
      }).catch(() => {})
    }
    let started
    try {
      started = await start(created.id, {
        ...(workspacePath === null ? {} : { workspace: workspacePath, worktree: 'off' }),
        resumePlan: {
          fromRunId: oldRunId,
          startNodeId: plan.startNodeId,
          skipped: plan.skipped,
          oldFailure: plan.oldFailure,
        },
      })
    } catch (error) {
      // 0.11 R2：准入拒绝（429）不删除子 run；记 startRejected 供下一次 restart 复用。
      if (error && error.status === 429) {
        await writeRunMeta(runsRoot, created.id, {
          restart: {
            ...restartInfo,
            startRejected: {
              code: error.code || 'RUN_CONCURRENCY_LIMIT',
              reason: error.reason || 'queue-full',
              at: now().toISOString(),
              retryable: true,
            },
          },
        }).catch(() => {})
        if (error && typeof error === 'object') {
          error.childRunId = created.id
          error.retryable = true
        }
      } else {
        // 其它启动失败：同样保留目录与 childRunId，避免调用方失去线索。
        if (error && typeof error === 'object' && !error.childRunId) error.childRunId = created.id
      }
      throw error
    }
    log(
      'info',
      `flow-studio: run ${created.id} 从 ${oldRunId} 续跑（第 ${attempt} 次，起点 ${plan.startNodeId}，`
      + `跳过 ${plan.skipped.length} 个已完成节点，继承 ${Object.keys(inherited).length} 个会话）`,
    )
    return {
      run: started,
      restart: restartInfo,
      plan: {
        startNodeId: plan.startNodeId,
        skipped: plan.skipped.map(item => item.nodeId),
        inherited: Object.keys(inherited),
      },
    }
  }

  /** 等指定 run 收尾：在跑就等它，已收尾（或没在本进程跑过）就读 run.json 终态。 */
  async function wait(runId) {
    if (!checkRunId(runId)) throw new EngineError(400, 'runId 不合法')
    const engine = runs.get(runId)
    if (engine) return engine.wait(runId)
    return readRunMeta(runsRoot, runId)
  }

  /**
   * 对所有实例跑崩溃残留清理。顺序执行：前一个实例把残留 run 标成 failed 后，
   * 后一个实例重读 run.json 会跳过它，不会重复写 run/end。
   */
  async function sweep() {
    const live = [...runs.values()]
    if (live.length === 0) {
      const temp = newEngine(null)
      try {
        return await temp.sweepStaleRuns()
      } finally {
        temp.dispose()
      }
    }
    const recovered = new Set()
    for (const engine of live) {
      try {
        const swept = await engine.sweepStaleRuns()
        for (const id of swept) recovered.add(id)
      } catch (error) {
        if (logger) logger('warn', `flow-studio: sweep 失败：${error.message}`)
      }
    }
    return [...recovered]
  }

  function get(runId) {
    return runs.get(runId) || null
  }

  /** 当前在跑的 runId 列表。 */
  function list() {
    return [...runs.keys()]
  }

  /** 当前活的 Engine 实例（与 list() 同序）。 */
  function engines() {
    return [...runs.values()]
  }

  // ── Engine 门面（让 index.js / tools.js 把 runtime 当单引擎用） ───────────

  /** 06 §16：sessionId → { runId, nodeId, firstAttempt, lastAttempt }；读共享 sessionIndex。 */
  function resolveSessionOwner(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const owner = sessionIndex.get(sessionId)
    return owner ? { ...owner } : null
  }

  /** flow_send_message：省略 runId 时取「当前会话启动的最新 run」。 */
  function runForSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const started = startedBy.get(sessionId)
    if (typeof started === 'string' && started !== '') return started
    const owner = sessionIndex.get(sessionId)
    return owner && typeof owner.runId === 'string' && owner.runId !== '' ? owner.runId : null
  }

  /** 节点会话查找：在跑就路由到对应实例，否则返回 null（inbox 会回落到 sessions.json）。 */
  function sessionIdForNode(runId, nodeId) {
    const engine = runs.get(runId)
    if (!engine || typeof engine.sessionIdForNode !== 'function') return null
    try {
      return engine.sessionIdForNode(runId, nodeId) || null
    } catch {
      return null
    }
  }

  /** 终态 run 再开调度没有意义（scheduler 的 planWake 也直接停）。 */
  const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'aborted'])

  /**
   * 07 §7 的**唯一开关实现**：HTTP `POST /runs/<id>/supervision` 与模型工具（flow_start
   * 自动开启、flow_supervise 手动开关）都走它，避免登记 / 落盘两条逻辑漂移。
   *
   * @param {string} runId
   * @param {{ enabled?: boolean, wakerSessionId?: string }} [options]
   * @returns {Promise<{ runId: string, enabled: boolean, supervision: object|null,
   *   scheduler: object }>}
   * @throws {EngineError} 400（runId 非法 / run 已收尾却要开启）或 404（run 不存在）
   */
  async function enableSupervision(runId, options = {}) {
    if (!checkRunId(runId)) throw new EngineError(400, 'runId 不合法')
    const enabled = options.enabled !== false
    const wakerSessionId = typeof options.wakerSessionId === 'string' && options.wakerSessionId.trim() !== ''
      ? options.wakerSessionId.trim()
      : null
    const meta = await readRunMeta(runsRoot, runId)
    if (!meta) throw new EngineError(404, `run 不存在（${runId}）`)
    if (enabled && TERMINAL_RUN_STATUSES.has(meta.status)) {
      throw new EngineError(400, `run 已结束（${meta.status}），不能开启 supervision；要定时自审请对运行中的 run 开启`)
    }
    if (enabled) {
      supervision.register(runId, wakerSessionId === null ? {} : { wakerSessionId })
      const saved = await saveSupervision(runsRoot, runId, {
        enabled: true,
        ...(wakerSessionId === null ? {} : { wakerSessionId }),
        reason: null,
        failures: 0,
      })
      return { runId, enabled: true, supervision: saved, scheduler: supervision.status(runId) }
    }
    supervision.unregister(runId)
    const saved = await saveSupervision(runsRoot, runId, { enabled: false, reason: 'disabled-by-caller' })
    return { runId, enabled: false, supervision: saved, scheduler: supervision.status(runId) }
  }

  /**
   * 07 §7 / v0.8 §11 / E2-b：停止调度并 abort、释放所有实例（插件卸载 / 测试收尾）。
   *
   * 顺序（同步段先做，保证调用方一返回定时器就没了）：
   *   1. 停掉两个调度器（interval 立刻清掉）；
   *   2. 清空注册表 / 摘掉调度登记 / 从跨 runtime 的活跃集合里移除；
   *   3. 对每个活跃 Engine 调用现有 abort 能力（`abort` → `stop` → `active.controller.abort`），
   *      并立刻 `engine.dispose()` 摘掉 session/event 订阅（卸载后不再写新事件）；
   *   4. 在 `disposeTimeoutMs` 内等待其收尾，超时只告警（不阻塞卸载）；
   *   5. **0.11 F7**：配额槽只在 Engine 真实终止后归还。超时仍占着——Engine / 外部进程
   *      还没退出时把槽还回去，会让新 run 突破全局限额；迟到终止由终止 promise 归还。
   *
   * @returns {Promise<{ aborted: number, timedOut: boolean }>} 永不 reject
   */
  function dispose() {
    disposedRuntime = true
    try {
      supervision.stop()
    } catch {
      // 停止定时器失败不该影响卸载。
    }
    try {
      nodeSupervision.stop()
    } catch {
      // 停止节点闹钟失败不该影响卸载。
    }
    // 0.11 · R2/S1：先取消本 runtime 正在排队的 run（原子摘票），只取消自己登记的
    // runId——共享 controller 里别的 runtime 的队不动。
    if (admission) {
      for (const queuedRunId of [...pendingStarts]) {
        try {
          admission.cancel(queuedRunId, 'dispose')
        } catch (error) {
          log('warn', `flow-studio: 卸载取消排队 ${queuedRunId} 失败：${error && error.message ? error.message : String(error)}`)
        }
      }
      pendingStarts.clear()
    }
    const snapshot = [...runs.entries()]
    runs.clear()
    const waits = []
    for (const [runId, engine] of snapshot) {
      // F7：槽位释放包装按「本次启动」捕获，不在迟到终止时按 runId 重新查表——
      // 否则 dispose 之后同 runId 若被重新 start，旧 Engine 的迟到终止会误还新 run 的槽。
      const releaseSlot = admissionReleases.get(runId) || null
      LIVE_RUN_IDS.delete(runId)
      RUN_WAKERS.delete(runWakerKey(runsRoot, runId))
      try {
        supervision.unregister(runId)
      } catch {
        // 调度器状态清理失败不该影响卸载。
      }
      try {
        nodeSupervision.unregisterRun(runId)
      } catch {
        // 调度器状态清理失败不该影响卸载。
      }
      let pending = null
      if (engine && typeof engine === 'object') {
        try {
          if (typeof engine.abort === 'function') {
            pending = engine.abort(runId)
          } else if (typeof engine.stop === 'function') {
            // Engine.stop(runId)：abort 在飞请求 + 等循环收尾，返回 run 元数据。
            pending = engine.stop(runId, { source: 'engine' })
          } else {
            const controller = engine.active && engine.active.controller
            if (controller && typeof controller.abort === 'function') {
              controller.abort(new Error('插件卸载：中止在飞执行'))
            }
          }
        } catch (error) {
          log('warn', `flow-studio: 卸载 abort ${runId} 失败：${error && error.message ? error.message : String(error)}`)
        }
        // 先摘订阅再等：即便引擎卡住，卸载后也不会再接收 / 写入 session 事件。
        try {
          engine.dispose()
        } catch {
          // 释放失败不该影响卸载。
        }
      }
      let termination = null
      if (pending && typeof pending.then === 'function') {
        termination = Promise.resolve(pending).then(() => undefined, () => undefined)
      } else if (engine && typeof engine.wait === 'function') {
        try {
          termination = Promise.resolve(engine.wait(runId)).then(() => undefined, () => undefined)
        } catch {
          termination = null
        }
      }
      if (termination) {
        waits.push(termination)
        // 0.11 F7：待真实终止才还槽。dispose 的有界等待超时后槽位仍然占着，直到
        // Engine（含外部进程组）真正退出；正常终止在这里立刻归还（与 settleInstance 的
        // 一次性包装共享同一个 release，重复调用是 no-op）。
        void termination.then(() => {
          if (releaseSlot) releaseSlot()
        })
      } else if (releaseSlot) {
        // 没有可等待的终止信号（同步 abort 的桩 / 已收尾实例）：按已终止处理。
        releaseSlot()
      }
    }
    if (waits.length === 0) {
      return Promise.resolve({ aborted: snapshot.length, timedOut: false })
    }
    return waitBounded(
      Promise.all(waits),
      disposeTimeoutMs,
      `卸载等待 ${waits.length} 个 Engine 收尾`,
      log,
    ).then(result => ({ aborted: snapshot.length, timedOut: result.timedOut }))
  }

  /**
   * 07 §7：重启恢复——对 `status ∈ {pending, running}` 且
   * `supervision.enabled !== false` 的 run 自动 register（wakerSessionId 从 run.json 取）。
   * 只登记，不立刻唤醒（第一次唤醒由调度器的 nextDueAt 决定）。
   *
   * E2-a：先做一次重启收口（running 无实例 → failed），再恢复登记；恢复扫描本身也
   * 不再给「running 但没有本进程实例」的 run 挂唤醒。`pending` 保持旧行为（老测试与
   * 「建好 run 再显式开启 supervision」的用法都依赖它：pending 还没开始，登记后可被
   * flow_supervise 正常调度，不算「已收口/无实例的 running」）。
   */
  const supervisionReady = (async () => {
    let reclaimed = []
    try {
      reclaimed = await reclaimOrphanRuns()
    } catch (error) {
      log('warn', `supervision: 重启收口失败：${error && error.message ? error.message : String(error)}`)
    }
    if (reclaimed.length > 0) {
      log('warn', `supervision: 重启收口 ${reclaimed.length} 个无执行实例的 running run：${reclaimed.join(', ')}`)
    }
    let listed
    try {
      listed = await listRuns(runsRoot, { limit: 100 })
    } catch (error) {
      log('warn', `supervision: 恢复扫描失败：${error && error.message ? error.message : String(error)}`)
      return []
    }
    const registered = []
    const skipped = []
    for (const run of listed.runs || []) {
      if (run.status !== 'pending' && run.status !== 'running') continue
      // E2-a：running 但没有活跃实例的 run 不恢复唤醒（它们要么已被收口成 failed，
      // 要么正被另一个进程用租约持有——本进程都不该叫醒它）。
      if (run.status === 'running' && !runs.has(run.id) && !LIVE_RUN_IDS.has(run.id)) {
        skipped.push(run.id)
        continue
      }
      const meta = await readRunMeta(runsRoot, run.id).catch(() => null)
      const state = meta && isPlainObject(meta.supervision) ? meta.supervision : null
      // 只有「显式开启过 + 知道唤醒谁」才恢复；没 waker 的 run 登记进去只会连续 3 次唤醒失败
      // 被写成 wake-failed（纯噪音），而用户之后仍可用 flow_supervise 手动开启。
      const wakerSessionId = state && typeof state.wakerSessionId === 'string'
        ? state.wakerSessionId.trim()
        : ''
      if (!state || state.enabled !== true || wakerSessionId === '') {
        skipped.push(run.id)
        continue
      }
      // E2-c：把已知的 waker 预热进进程内缓存（Engine 事件过滤是同步判定）。
      rememberRunWaker(runsRoot, run.id, state)
      try {
        supervision.register(run.id, { wakerSessionId })
        registered.push(run.id)
      } catch (error) {
        log('warn', `supervision: 恢复登记 ${run.id} 失败：${error && error.message ? error.message : String(error)}`)
      }
    }
    if (skipped.length > 0) {
      log('info', `supervision: 跳过 ${skipped.length} 个没有开启记录 / 缺 wakerSessionId / 无活跃实例的 run（可之后用 flow_supervise 手动开启）：${skipped.join(', ')}`)
    }
    if (registered.length > 0) {
      log('info', `supervision: 已恢复 ${registered.length} 个 run 的定时自审：${registered.join(', ')}`)
    }
    return registered
  })()

  // ── G7-b：重启恢复节点自审闹钟（节点闹钟只在内存、重启会丢） ───────────────
  //
  // 节点闹钟是纯内存状态：进程重启后，仍在跑的 run 的节点自审闹钟全部消失，
  // run.json.nodeStatus 停在旧值，flow_watch 的 blocked 建议也随之失效。
  //
  // 恢复口径（只对本进程**确实有 Engine 实例**的 running run 做，避免叫醒别的进程
  // / 已收口 run 的会话）：
  //   1. 从 run.json.nodeStatus 取 `state` 不是终态（done / failed）的节点；
  //   2. 从 sessions.json（nodeId → { sessionId }）取该节点的会话；
  //      没有会话的节点**跳过**并计数（不造一个叫不醒的条目）；
  //   3. `register({ runId, nodeId, sessionId, attempt, intervalMs })`，`intervalMs`
  //      用调度器的 nodeAlarmMs（默认 NODE_ALARM_DEFAULT_MS = 600s）→ 恢复后第一轮
  //      不立刻唤醒，按 now + 间隔重排；
  //   4. attempt 缺失按 1 处理并记 warn（runstore 目前不持久化 attempt，见文档）；
  //   5. 幂等：已有登记的 session 直接跳过（`nodeSupervision.has()`），不重排 due。
  const NODE_TERMINAL_STATES = new Set(['done', 'failed'])

  /** 最近一次恢复扫描的统计（也是 `nodeSupervision.snapshot().recovery` 的最新值）。 */
  let lastNodeRecovery = null

  /**
   * 扫一遍「本进程有 Engine 实例的 running run」，给非终态节点重新登记闹钟。
   *
   * @returns {Promise<{ runsScanned: number, runsRecovered: number, restored: number,
   *   skipped: number, skippedTerminal: number, missingSession: number,
   *   missingAttempt: number, alreadyRegistered: number }>}
   */
  async function recoverNodeAlarms() {
    const summary = {
      runsScanned: 0,
      runsRecovered: 0,
      restored: 0,
      skipped: 0,
      skippedTerminal: 0,
      missingSession: 0,
      missingAttempt: 0,
      alreadyRegistered: 0,
    }
    const recoverIntervalMs = Number.isFinite(nodeSupervision.nodeAlarmMs) && nodeSupervision.nodeAlarmMs > 0
      ? nodeSupervision.nodeAlarmMs
      : NODE_ALARM_DEFAULT_MS
    let entries = []
    try {
      entries = await readdir(runsRoot, { withFileTypes: true })
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        log('warn', `flow-studio: 节点闹钟恢复扫描失败：${error && error.message ? error.message : String(error)}`)
      }
      return summary
    }
    for (const entry of entries) {
      if (disposedRuntime) break
      if (!entry.isDirectory() || !checkRunId(entry.name)) continue
      const runId = entry.name
      // 只恢复「本进程有 Engine 实例」的 run：别的进程负责的 run 不该在本进程再挂一份闹钟。
      if (!runs.has(runId)) continue
      const meta = await readRunMeta(runsRoot, runId).catch(() => null)
      if (!meta || meta.status !== 'running') continue
      summary.runsScanned += 1
      const nodeStatus = isPlainObject(meta.nodeStatus) ? meta.nodeStatus : {}
      let sessions = {}
      try {
        sessions = await readNodeSessions(runsRoot, runId)
      } catch (error) {
        log('warn', `flow-studio: 节点闹钟恢复读 sessions.json 失败（${runId}）：${error && error.message ? error.message : String(error)}`)
        sessions = {}
      }
      let restoredThisRun = 0
      for (const [nodeId, status] of Object.entries(nodeStatus)) {
        if (disposedRuntime) break
        if (!isPlainObject(status)) {
          summary.skipped += 1
          continue
        }
        const state = typeof status.state === 'string' ? status.state : 'working'
        if (NODE_TERMINAL_STATES.has(state)) {
          summary.skippedTerminal += 1
          summary.skipped += 1
          continue
        }
        const sessionEntry = sessions[nodeId]
        const sessionId = sessionEntry && typeof sessionEntry.sessionId === 'string'
          ? sessionEntry.sessionId
          : ''
        if (sessionId === '') {
          // 没有会话就没人可叫：跳过并计数，不造一个叫不醒的条目。
          summary.missingSession += 1
          summary.skipped += 1
          log('warn', `flow-studio: 节点闹钟恢复跳过 run ${runId} 的节点 ${nodeId}：sessions.json 里没有 sessionId`)
          continue
        }
        if (nodeSupervision.has(sessionId)) {
          // 幂等：已经登记过（含已停摆的）就不再 register，避免把 nextDueAt 重排。
          summary.alreadyRegistered += 1
          summary.skipped += 1
          continue
        }
        let attempt = Number.isInteger(status.attempt) && status.attempt >= 1 ? status.attempt : null
        if (attempt === null) {
          attempt = 1
          summary.missingAttempt += 1
          log('warn', `flow-studio: 节点闹钟恢复：run ${runId} 节点 ${nodeId} 的 nodeStatus 没有 attempt，按 1 处理`)
        }
        try {
          nodeSupervision.register({
            runId,
            nodeId,
            sessionId,
            attempt,
            intervalMs: recoverIntervalMs,
          })
          restoredThisRun += 1
        } catch (error) {
          summary.skipped += 1
          log('warn', `flow-studio: 节点闹钟恢复登记失败（${runId}/${nodeId}）：${error && error.message ? error.message : String(error)}`)
        }
      }
      if (restoredThisRun > 0) {
        summary.runsRecovered += 1
        summary.restored += restoredThisRun
        log('info', `flow-studio: 重启恢复 ${runId} 的 ${restoredThisRun} 个节点闹钟（${Math.round(recoverIntervalMs / 1000)}s 后首轮）`)
      }
    }
    lastNodeRecovery = nodeSupervision.recordRecovery(summary)
    if (summary.skipped > 0 || summary.restored > 0) {
      log(
        'info',
        `flow-studio: 节点闹钟恢复扫描完成：恢复 ${summary.restored} 条，跳过 ${summary.skipped} 条`
          + `（终态 ${summary.skippedTerminal} / 缺 sessionId ${summary.missingSession}`
          + ` / 已登记 ${summary.alreadyRegistered}），缺 attempt 按 1 处理 ${summary.missingAttempt} 条`,
      )
    }
    return summary
  }

  /** G7-b：`supervisionReady` 之后跑一次节点闹钟恢复（初始化扫描）。 */
  const nodeAlarmsReady = (async () => {
    try {
      await supervisionReady
    } catch (error) {
      log('warn', `flow-studio: 节点闹钟恢复等待 supervisionReady 失败：${error && error.message ? error.message : String(error)}`)
      return lastNodeRecovery
    }
    if (disposedRuntime) return lastNodeRecovery
    try {
      return await recoverNodeAlarms()
    } catch (error) {
      log('warn', `flow-studio: 节点闹钟恢复失败：${error && error.message ? error.message : String(error)}`)
      return lastNodeRecovery
    }
  })()

  return {
    runs,
    start,
    stop,
    restart,
    wait,
    sweep,
    get,
    list,
    engines,
    sessionIndex,
    startedBy,
    supervision,
    supervisionReady,
    nodeSupervision,
    /** G7-b：初始化扫描（`supervisionReady` 之后跑一次）——恢复 running run 的非终态节点闹钟。 */
    nodeAlarmsReady,
    /** G7-b：显式再跑一次节点闹钟恢复（幂等：已登记的 session 跳过，返回本次统计）。 */
    recoverNodeAlarms,
    /** G7-b：最近一次恢复扫描的累计统计（同 `nodeSupervision.snapshot().recovery`）。 */
    get nodeRecovery() {
      return lastNodeRecovery === null ? { ...nodeSupervision.snapshot().recovery } : { ...lastNodeRecovery }
    },
    /** v0.8 §11.1：节点闹钟到点动作（调度器注入的同一实现；导出便于测试 / 诊断）。 */
    wake: wakeNode,
    enableSupervision,
    /** E2-a：显式再跑一次重启收口（初始化扫描同一实现；幂等，返回本次收口的 runId）。 */
    reclaimOrphans: reclaimOrphanRuns,
    dispose,
    // ── 0.11 · R2/S1：准入（未启用时全部为 null，旧调用方拿不到也不受影响） ──
    /** 某个 run 的准入状态：queued / reserved / running / null（未启用准入时为 null）。 */
    admissionOf(runId) {
      return admission ? admission.admissionOf(runId) : null
    },
    /** 当前生效的并发限制（含 env 非法值的 warnings）；未启用准入时为 null。 */
    get admissionLimits() {
      return admission ? admission.limits : null
    },
    /** 准入快照：{ active, global, workspaces, queued }；未启用准入时为 null。 */
    admissionSnapshot() {
      return admission ? admission.snapshot() : null
    },
    // ── Engine 门面：`env.engine = runtime` 后旧调用照跑 ──────────────────
    /** 供 /health 使用：'stub' / 'real'（与 Engine 同一口径）。 */
    get engineName() {
      return engineName
    },
    /** 供 inbox.js 的 `deps.engine.ctx` 回落使用。 */
    get ctx() {
      return options.ctx ?? null
    },
    resolveSessionOwner,
    runForSession,
    sessionIdForNode,
    /** 旧名字：index.js 启动清理调 `engine.sweepStaleRuns()`。 */
    sweepStaleRuns: sweep,
  }
}

export { Engine }
