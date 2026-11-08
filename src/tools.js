/**
 * 模型工具：让主 agent 在自己的会话里直接开跑一个流程，并定时唤醒自审。
 *
 * 闭环（也是工具描述里必须让模型一眼看懂的三步）：
 *   ① `flow_start` 用**当前会话的 Agent** 作父会话启动 run ——
 *      `request.parent = exec.agent`、`request.workspace = 会话 cwd`，子 agent 因此继承本会话工作区；
 *   ② start 成功后**自动开启内建 supervision**（`engine.enableSupervision`），到点由调度器
 *      唤醒发起会话；不需要再挂 `proactive_set` 闹钟（引擎没有该能力时才回落到手动闹钟）；
 *   ③ 每次醒来调 `flow_watch` 审查「整个工作流是否在正常运转」：
 *      healthy 就直接结束本轮，出现异常或已跑完才通知主人。
 *
 * 约定（与 DSH 工具契约一致）：
 *  - `parameters` 是完整 JSON Schema（只用 DSH 强制子集：type/properties/required/items/enum/oneOf/
 *    additionalProperties/description），字段上限写进 description；
 *  - `execute` 只返回 lossless JSON（无 undefined / NaN / Date），失败一律
 *    `{ok:false, error, hint, retryable}`，不抛异常（唯一例外是取消时也走失败返回值）；
 *  - `output.schema` 声明成功与失败两种形状；可空字段一律 `oneOf:[X, null]`；
 *  - 只读工具标 `isConcurrencySafe`；写工具（start / stop）不标，串行执行；
 *  - 审计只报告、不修复、不自动停止：动作留给模型决定（见 `flow_watch`）。
 *
 * 数据来源全部复用既有 Host 逻辑：`listFlows` / `readFlow`（store）、
 * `createRun` / `listRuns` / `readRunDetail` / `readAllEvents`（runstore）、
 * `checkRunId`（runlog）、`validateFlowForRun`（engine），不复制第二份建 run / 开跑逻辑。
 *
 * @module @feiyueve/dsh-flow-studio/tools
 */

import { realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import * as worktreeModule from './worktree.js'
import { validateFlowForRun } from './engine.js'
import {
  MESSAGE_BODY_HARD_MAX_CHARS, REPLY_TOKEN_ENV_PREFIX, deliverInboundMessage, deliverOutboundReply,
  redactSecrets, validateReplyTargetStrict,
} from './inbox.js'
import { normalizeExecutor } from './executor.js'
import { NODE_KIND } from './model.js'
import { checkRunId } from './runlog.js'
import { saveSupervision } from './runtime.js'
import {
  createRun, listRuns, normalizeReplyTarget, readAllEvents, readNodeSessions, readRunDetail,
  readRunMessages, readRunMeta,
} from './runstore.js'
import { checkId, listFlows, readFlow } from './store.js'

/** 默认审查间隔（秒）：给模型挂 `proactive_set` 的 `after_seconds`。 */
export const DEFAULT_WATCH_SECONDS = 180

/** 07 §4.1：worktree 策略全集（`auto` 是默认）。 */
const WORKTREE_POLICIES = Object.freeze(['auto', 'on', 'off'])

/** 工具超时预算（毫秒）。stop 要等循环收尾，给得比 start 宽。 */
const TIMEOUT_LIST_MS = 15_000
const TIMEOUT_START_MS = 120_000
const TIMEOUT_WATCH_MS = 30_000
const TIMEOUT_STOP_MS = 120_000
const TIMEOUT_SEND_MS = 60_000
const TIMEOUT_REPLY_MS = 30_000
const TIMEOUT_WORKTREE_MS = 60_000

/** G6-d：一次 `flow_watch` 最多合并审查多少个 run（超过 → 可读参数失败）。 */
const MAX_WATCH_RUNS = 20

/** G6-b：`flow_worktrees` 一次 prune 允许额外保留的 runId 上限。 */
const MAX_KEEP_RUN_IDS = 200

/** 审计参数的默认口径（与引擎节点超时一致；可被 deps 覆盖，测试用）。 */
const DEFAULT_STALL_MS = 10 * 60 * 1000
const DEFAULT_MAX_REJECTS_PER_EDGE = 3

/** 终态 verdict：到这三个就不必再挂闹钟。 */
const TERMINAL_VERDICTS = new Set(['done', 'failed', 'aborted'])

// ── 主机级安全策略（index.js 也 import 这一份，避免两份口径） ─────────────
//
// G6-a：FLOW_STUDIO_TOKEN 是全权令牌，但「能调面板 API」不等于「能在宿主上执行任意
// shell」。以下三组开关/白名单把最危险的两件事（custom executor、任意 workspace）
// 从「任何持令牌者都能做」收回给运维：
//   1. FLOW_STUDIO_READ_TOKEN：只读令牌，只允许 GET（HTTP 层拦写请求）；
//   2. FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR：默认关，关着时保存 / 启动含 executor:'custom'
//      的流程一律 400（custom 走 `sh -c <模板>`，等价宿主 RCE）；
//   3. FLOW_STUDIO_WORKSPACE_ROOTS：冒号分隔的绝对路径白名单；配置后 workspace 必须
//      落在其中之一，否则 400。不配置 = 维持原有行为（不打断现有部署）。
//
// 这些函数**在调用时读 process.env**（不是模块加载时快照），测试与运维都能动态开关。

/** 允许流程使用 `executor:'custom'` 的主机级开关（默认关）。 */
export const CUSTOM_EXECUTOR_ENV = 'FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR'

/** workspace 白名单：冒号分隔的绝对路径；不配置 = 不限制。 */
export const WORKSPACE_ROOTS_ENV = 'FLOW_STUDIO_WORKSPACE_ROOTS'

/** 引擎时限的环境变量兜底（G6-c：显式参数 > 环境变量 > 默认值）。 */
export const RUN_TIMEOUT_ENV = 'FLOW_STUDIO_RUN_TIMEOUT_MS'
export const NODE_TIMEOUT_ENV = 'FLOW_STUDIO_NODE_TIMEOUT_MS'

/** 引擎 run 级 / 节点级时限的默认值（与 engine.js 同口径；工具描述里要明示）。 */
export const DEFAULT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000
export const DEFAULT_NODE_TIMEOUT_MS = 20 * 60 * 1000

/** JavaScript 定时器上限（2^31-1 ms ≈ 24.8 天）；超过它 setTimeout 会立刻触发。 */
export const MAX_TIMEOUT_MS = 2_147_483_647

/** 读一个环境变量并 trim；非字符串 / 空串一律当未设置。 */
function envText(env, name) {
  if (!env || typeof env !== 'object') return ''
  const raw = env[name]
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 主机是否显式允许 custom executor（只认 `1` / `true`，大小写不敏感）。 */
export function customExecutorAllowed(env = process.env) {
  const raw = envText(env, CUSTOM_EXECUTOR_ENV).toLowerCase()
  return raw === '1' || raw === 'true'
}

/** 关闭状态下给调用方的可操作文案（保存 / 启动 / 工具失败共用）。 */
export function customExecutorDisabledMessage(nodeIds = []) {
  const which = Array.isArray(nodeIds) && nodeIds.length > 0
    ? `（节点：${nodeIds.join('、')}）`
    : ''
  return `流程里有节点使用 executor:'custom'${which}：它会在宿主上执行任意 shell 命令（等价宿主 RCE），`
    + `默认被主机级开关关闭。要启用必须由运维设置 ${CUSTOM_EXECUTOR_ENV}=1 并重启 Host；`
    + '调用方不能自行绕过。'
}

/** 列出流程里使用 `executor:'custom'` 的阶段节点 id（大小写 / 空白归一）。 */
export function flowUsesCustomExecutor(flow) {
  const ids = []
  for (const node of (flow && flow.nodes) || []) {
    if (!node || typeof node !== 'object') continue
    const value = typeof node.executor === 'string' ? node.executor.trim().toLowerCase() : ''
    if (value === 'custom') ids.push(typeof node.id === 'string' && node.id !== '' ? node.id : '(未命名节点)')
  }
  return ids
}

/**
 * custom executor 的门禁：开关关着且流程里有用到 → 返回 blocker 列表（空 = 放行）。
 * @returns {Array<{ nodeIds: string[], message: string }>}
 */
export function customExecutorBlockers(flow, env = process.env) {
  if (customExecutorAllowed(env)) return []
  const nodeIds = flowUsesCustomExecutor(flow)
  if (nodeIds.length === 0) return []
  return [{ nodeIds, message: customExecutorDisabledMessage(nodeIds) }]
}

/**
 * 解析 workspace 白名单：冒号分隔；空段忽略；非绝对路径记进 invalid（启动时告警、
 * 不参与匹配——宁可不放行某个写错的根，也不把整份配置当成「未配置」）。
 * @returns {{ roots: Array<{ configured: string, resolved: string }>, invalid: string[] }}
 */
export function parseWorkspaceRoots(env = process.env) {
  const raw = envText(env, WORKSPACE_ROOTS_ENV)
  const roots = []
  const invalid = []
  if (raw === '') return { roots, invalid }
  for (const piece of raw.split(':')) {
    const trimmed = piece.trim()
    if (trimmed === '') continue
    if (!isAbsolute(trimmed)) {
      invalid.push(trimmed)
      continue
    }
    roots.push({ configured: trimmed, resolved: resolve(trimmed) })
  }
  return { roots, invalid }
}

/** candidate 是否等于 root 或落在 root 之下（按路径段比较，`/a/bc` 不算在 `/a/b` 内）。 */
function isInsideRoot(candidate, root) {
  if (typeof candidate !== 'string' || candidate === '') return false
  if (candidate === root) return true
  const base = root.endsWith(sep) ? root : `${root}${sep}`
  return candidate.startsWith(base)
}

/**
 * workspace 白名单判定（G6-a ③）。
 * @param {string} workspacePath 绝对路径（已是 resolve 后的值也可）
 * @returns {string|null} null = 放行；否则是可读中文原因
 */
export function workspaceAllowlistReason(workspacePath, env = process.env) {
  const { roots } = parseWorkspaceRoots(env)
  if (roots.length === 0) return null
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') {
    return 'workspace 必须是非空绝对路径'
  }
  if (!isAbsolute(workspacePath.trim())) return 'workspace 必须是绝对路径'
  const candidate = resolve(workspacePath.trim())
  let real = candidate
  try {
    real = realpathSync(candidate)
  } catch {
    // 路径还不存在时按词法路径比较（创建 run 前就可能被问；不能因此直接放行）。
    real = candidate
  }
  for (const root of roots) {
    let rootReal = root.resolved
    try {
      rootReal = realpathSync(root.resolved)
    } catch {
      rootReal = root.resolved
    }
    if (isInsideRoot(real, rootReal) || isInsideRoot(real, root.resolved)
      || isInsideRoot(candidate, rootReal) || isInsideRoot(candidate, root.resolved)) {
      return null
    }
  }
  return `workspace 不在允许的根目录内（${WORKSPACE_ROOTS_ENV} 配置了 ${roots.length} 个根）：${candidate}`
}

/** worktrees 根目录：`<runsRoot 的父级>/worktrees`（与 engine._worktreesRoot 同口径）。 */
export function worktreesRootFor(runsRoot) {
  return join(dirname(runsRoot), 'worktrees')
}

/** run.json.worktree 里真正可操作的记录（必须有绝对 path）；缺省 / 坏形状返回 null。 */
export function worktreeRecordOf(meta) {
  const value = meta && meta.worktree
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.path !== 'string' || value.path === '') return null
  return value
}

/** 列出当前真实存在的 run id（按 run 目录判断；用于判定 worktree 是否孤儿）。 */
export async function listExistingRunIds(runsRoot) {
  let dirents = []
  try {
    dirents = await readdir(runsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const ids = []
  for (const entry of dirents) {
    if (!entry.isDirectory() || !checkRunId(entry.name)) continue
    ids.push(entry.name)
  }
  return ids
}

// ── F1：外部回复通道的安全边界 ──────────────────────────────────────────────
//
// 白名单校验（tokenEnv 专用前缀 / https 或回环 http / 令牌打码）的**唯一实现**
// 在 `inbox.js`：HTTP `POST /runs/<id>/messages`、`POST /runs/<id>/inbox`、以及
// `flow_send_message` / `flow_reply` 全部走同一份函数。这里只保留「把 reply 参数
// 交给 inbox 校验」的壳，不再复制第二份规则（见下面的 execute 与 storedReplyTargetOf）。

/** 读一个回复目标实际会用的令牌值（只用于打码 / 脱敏，绝不外传）。 */
function tokenValueOf(target) {
  if (!target || target.kind !== 'http' || typeof target.tokenEnv !== 'string' || target.tokenEnv === '') return ''
  try {
    const value = process.env[target.tokenEnv]
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/**
 * 取这个 run 当前生效的回复目标（与 inbox.deliverOutboundReply 同优先级：
 * 消息级 reply > run.json.inbox.reply）。读不出来一律当「未配置」。
 */
async function storedReplyTargetOf(deps, runId, inReplyTo) {
  let target = null
  if (typeof inReplyTo === 'string' && inReplyTo !== '') {
    try {
      const listed = await readRunMessages(deps.runsRoot, runId, { limit: 1000 })
      const source = listed && Array.isArray(listed.messages)
        ? listed.messages.find(item => item && item.id === inReplyTo && item.direction === 'in')
        : null
      if (source) target = normalizeReplyTarget(source.reply)
    } catch {
      target = null
    }
  }
  if (!target) {
    try {
      const meta = await readRunMeta(deps.runsRoot, runId)
      target = normalizeReplyTarget(meta && meta.inbox ? meta.inbox.reply : null)
    } catch {
      target = null
    }
  }
  return target
}

// ── v0.8 §11：节点自审状态（flow_watch / recommended） ────────────────────

/** run.json.nodeStatus 的宽松读取：缺省 / 坏形状一律 `{}`。 */
function nodeStatusOfRun(run) {
  const value = run && run.nodeStatus
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** progress 收敛成数字（缺失 / 坏值按 0，与 parseNodeStatus 的默认值一致）。 */
function progressOf(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : 0
}

/**
 * v0.8 §11.3：`state==='blocked'` 且连续两次自审的 `progress` 不变 → 给一句 recommended。
 *
 * 「上一次」取事件流里同一节点最近两条 `node/status`（事件是追加的，run.json 只留最新），
 * 因此不依赖内存状态、重启后照样能判。只有 run.json 的最新进度与事件最新一条一致时才报，
 * 避免事件与快照不同步时误报。
 *
 * @param {object} nodeStatus run.json.nodeStatus
 * @param {Array<object>} events 该 run 的全量事件（升序）
 * @returns {string[]}
 */
function blockedNodeAdvice(nodeStatus, events) {
  const advice = []
  const list = Array.isArray(events) ? events : []
  for (const [nodeId, entry] of Object.entries(nodeStatus || {})) {
    if (!entry || entry.state !== 'blocked') continue
    const reports = []
    for (let index = list.length - 1; index >= 0 && reports.length < 2; index -= 1) {
      const event = list[index]
      if (!event || event.kind !== 'node/status' || event.nodeId !== nodeId) continue
      reports.push(event)
    }
    if (reports.length < 2) continue
    const latestProgress = progressOf(reports[0].data && reports[0].data.progress)
    const previousProgress = progressOf(reports[1].data && reports[1].data.progress)
    if (latestProgress !== previousProgress) continue
    if (progressOf(entry.progress) !== latestProgress) continue
    advice.push(`节点 ${nodeId} 报告 blocked 且无进展，建议先看它卡在哪。`)
  }
  return advice
}

/** 把节点建议并进审计给的 recommended（保持原有类型：数组追加 / 字符串续写）。 */
function withRecommendations(recommended, advice) {
  if (advice.length === 0) return recommended
  if (Array.isArray(recommended)) return [...recommended, ...advice]
  if (typeof recommended === 'string' && recommended.trim() !== '') {
    return `${recommended}；${advice.join('；')}`
  }
  if (recommended && typeof recommended === 'object') {
    return { ...recommended, nodeStatus: advice }
  }
  return advice
}

// ── 调度器实时快照（flow_watch：卡住 / 超时 / 自审回报格式错要看得见） ──────
//
// `status()` 是对外契约（9 个字段），不够诊断；可观测字段都在 `snapshot()`：
// run 级 `entries[].{lastOutcome,lastDurationMs,lastFinishedAt,lastError,timeouts}` +
// `tick.lastDurationMs`；节点级还有 `entries[].lastReport`。
// 老版本 / 注入桩可能没有 snapshot()，这里必须**不抛错**并明确标注不可用。

/**
 * 读一个调度器的 snapshot()，永不抛错。
 * @returns {{ available: boolean, snapshot?: object, reason?: string }}
 */
function supervisionSnapshotOf(scheduler, label) {
  if (!scheduler || typeof scheduler !== 'object') {
    return { available: false, reason: `引擎没有暴露${label}调度器（老版本 / 未启用）` }
  }
  if (typeof scheduler.snapshot !== 'function') {
    return { available: false, reason: `${label}调度器没有 snapshot()（老版本 / 注入桩），无法看实时健康度` }
  }
  try {
    const snapshot = scheduler.snapshot()
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return { available: false, reason: `${label}调度器的 snapshot() 返回了非对象` }
    }
    return { available: true, snapshot }
  } catch (error) {
    return { available: false, reason: `${label}调度器的 snapshot() 抛错：${messageOf(error)}` }
  }
}

/** 计数字段收敛：非负整数原样，缺省 / 坏值一律 0（快照可能来自老版本 / 注入桩）。 */
function nonNegativeCount(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

/** 节点闹钟恢复统计的字段全集（runtime.recordRecovery 的契约）。 */
const RECOVERY_KEYS = Object.freeze([
  'scans', 'runsScanned', 'runsRecovered', 'restored',
  'skipped', 'skippedTerminal', 'missingSession', 'missingAttempt', 'alreadyRegistered',
])

/**
 * 收敛 `nodeSupervision.snapshot().recovery`：缺省 / 坏形状返回 null（而不是伪造全 0），
 * 有对象就只保留契约里的计数字段 + `at`。
 */
function recoveryOf(snapshot) {
  const raw = snapshot && typeof snapshot === 'object' ? snapshot.recovery : undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const recovery = { at: typeof raw.at === 'string' && raw.at !== '' ? raw.at : null }
  for (const key of RECOVERY_KEYS) recovery[key] = nonNegativeCount(raw[key])
  return recovery
}

/**
 * 从快照里挑出「调度器超时 / 停摆 / 自审回报格式错」这三类信号，外加 G7-a/G7-b 的
 * 计数（`wokenThisHour` / `throttled` / `coalesced` / `recovery`）。
 *
 * 计数类信号只在非零时写成人类可读的 `notices`（不混进 `warnings`，避免改变旧字段口径；
 * 健康时也不给结论刷噪音）；字段本身总是出现在返回值里（缺省 0 / null）。
 */
function supervisionHealthOf(runLevel, nodeLevel) {
  const warnings = []
  const notices = []
  let timeouts = 0
  let invalidReports = 0

  const runEntries = runLevel && runLevel.available && runLevel.snapshot
    && Array.isArray(runLevel.snapshot.entries) ? runLevel.snapshot.entries : []
  for (const entry of runEntries) {
    if (!entry || typeof entry !== 'object') continue
    const rawTimeouts = Number(entry.timeouts)
    const entryTimeouts = Number.isFinite(rawTimeouts) && rawTimeouts > 0 ? rawTimeouts : 0
    const lastTimeout = entry.lastOutcome === 'timeout'
    if (entryTimeouts > 0 || lastTimeout) {
      const count = Math.max(1, entryTimeouts)
      timeouts += count
      warnings.push(
        `run 级调度器报告超时：run ${entry.runId || '未知'}（累计 ${count} 次`
          + `${lastTimeout ? '，最近一次结果 timeout' : ''}`
          + `${entry.lastError ? '：' + entry.lastError : ''}）`,
      )
    }
  }
  const runTick = runLevel && runLevel.available && runLevel.snapshot ? runLevel.snapshot.tick : null
  if (runTick && Number.isFinite(runTick.lastDurationMs) && Number.isFinite(runLevel.snapshot.wakeTimeoutMs)
    && runTick.lastDurationMs > runLevel.snapshot.wakeTimeoutMs) {
    warnings.push(
      `run 级调度器整轮 tick 耗时 ${runTick.lastDurationMs}ms，已超过单条唤醒超时 `
        + `${runLevel.snapshot.wakeTimeoutMs}ms，可能在停摆。`,
    )
  }

  const nodeEntries = nodeLevel && nodeLevel.available && nodeLevel.snapshot
    && Array.isArray(nodeLevel.snapshot.entries) ? nodeLevel.snapshot.entries : []
  for (const entry of nodeEntries) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.lastReport && entry.lastReport.kind === 'invalid') {
      invalidReports += 1
      warnings.push(
        `节点自审回报格式不合规（invalid）：节点 ${entry.nodeId || entry.sessionId || '未知'}`
          + `${entry.lastReport.reason ? '（' + entry.lastReport.reason + '）' : ''}，建议检查该节点的自审输出格式。`,
      )
    }
  }
  const nodeTick = nodeLevel && nodeLevel.available && nodeLevel.snapshot ? nodeLevel.snapshot.tick : null
  if (nodeTick && Number.isFinite(nodeTick.lastDurationMs) && Number.isFinite(nodeLevel.snapshot.wakeTimeoutMs)
    && nodeTick.lastDurationMs > nodeLevel.snapshot.wakeTimeoutMs) {
    warnings.push(
      `节点级调度器整轮 tick 耗时 ${nodeTick.lastDurationMs}ms，已超过单条唤醒超时 `
        + `${nodeLevel.snapshot.wakeTimeoutMs}ms，可能在停摆。`,
    )
  }

  // G7-a：发起会话的唤醒预算 / 合并唤醒（runtime 级累计计数，缺省 0）。
  const runSnapshotValue = runLevel && runLevel.available && runLevel.snapshot ? runLevel.snapshot : null
  const wokenThisHour = nonNegativeCount(runSnapshotValue && runSnapshotValue.wokenThisHour)
  const throttled = nonNegativeCount(runSnapshotValue && runSnapshotValue.throttled)
  const coalesced = nonNegativeCount(runSnapshotValue && runSnapshotValue.coalesced)
  if (throttled > 0) {
    notices.push(
      `发起会话唤醒被限流 ${throttled} 次（同一会话的小时预算 / 最小间隔生效；`
        + '到期 run 不会丢，下一轮 tick 会再来）',
    )
  }
  if (coalesced > 0) {
    notices.push(
      `合并 ${coalesced} 个 run 为一次唤醒（同一发起会话的多条到期 run 只发一条提示）`,
    )
  }

  // G7-b：节点闹钟重启恢复扫描（runtime 每次扫描后累加；没有该字段就是 null）。
  const nodeSnapshotValue = nodeLevel && nodeLevel.available && nodeLevel.snapshot ? nodeLevel.snapshot : null
  const recovery = recoveryOf(nodeSnapshotValue)
  if (recovery && recovery.restored > 0) {
    notices.push(
      `节点闹钟恢复扫描恢复了 ${recovery.restored} 个 run 的定时自审`
        + `（已扫描 ${recovery.scans} 轮 / 覆盖 ${recovery.runsScanned} 个 run）`,
    )
  }

  return {
    warnings, notices, timeouts, invalidReports, wokenThisHour, throttled, coalesced, recovery,
  }
}

// ── JSON Schema 小工具 ─────────────────────────────────────────────────────

/** 声明「可空」：可能为 null 的字段必须这么写，否则注册表逐值校验会拒绝。 */
function nullable(node, description) {
  const branch = description === undefined ? node : { ...node, description }
  return {
    oneOf: [branch, { type: 'null', description: '未知或不适用（数据源未返回）' }],
  }
}

/** 任意 JSON 值（审计模块原样返回的字段用它，避免形状差异被注册表拒绝）。 */
function anyJson(description) {
  return {
    description,
    oneOf: [
      { type: 'object' },
      { type: 'array' },
      { type: 'string' },
      { type: 'number' },
      { type: 'integer' },
      { type: 'boolean' },
      { type: 'null' },
    ],
  }
}

/** 失败字段：每个工具的 output 都声明，模型据此分支。 */
const FAILURE_PROPS = {
  ok: { type: 'boolean', description: '成功为 true；失败为 false（失败时看 error / hint / retryable）' },
  error: { type: 'string', description: '失败原因（可读中文，原样告诉模型）' },
  hint: { type: 'string', description: '下一步该做什么（先查列表 / 换 flowId / 等运行结束等）' },
  retryable: { type: 'boolean', description: '是否值得重试；参数错误、404、409 恒为 false' },
}

/** 构造 output：失败字段 + 本工具自己的成功字段 + 人类可读投影。 */
function outputFor(extra, render) {
  return {
    schema: {
      type: 'object',
      properties: { ...FAILURE_PROPS, ...extra },
      required: ['ok'],
      additionalProperties: true,
    },
    render,
  }
}

/** 统一的 render 兜底：模型面拿到规范值，这里只做人类可读投影。 */
function renderJson(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

// ── 参数读取（raw register 不校验参数，这里做最小防御） ─────────────────────

function argsOf(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new ParamError('工具参数必须是一个 JSON 对象', '按工具的参数 schema 传对象参数。')
  }
  return args
}

/** 参数错误：execute 内捕获后转成 `{ok:false, ...}`。 */
class ParamError extends Error {
  constructor(message, hint) {
    super(message)
    this.name = 'ParamError'
    this.hint = hint
    this.retryable = false
  }
}

function optionalString(args, key, { max = 200 } = {}) {
  const value = argsOf(args)[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ParamError(`参数 ${key} 必须是字符串`, `按 ${key} 的说明改正后重发。`)
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > max) throw new ParamError(`参数 ${key} 超过 ${max} 字符`, `把 ${key} 缩短到 ${max} 字符以内。`)
  return trimmed
}

function optionalInteger(args, key, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = argsOf(args)[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ParamError(`参数 ${key} 必须是整数`, `按 ${key} 的说明改正后重发。`)
  }
  if (value < min || value > max) {
    throw new ParamError(`参数 ${key} 必须在 ${min}–${max} 之间`, `改成范围内的整数。`)
  }
  return value
}

function optionalEnum(args, key, allowed) {
  const value = argsOf(args)[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !allowed.includes(value.trim())) {
    throw new ParamError(
      `参数 ${key} 必须是 ${allowed.join(' / ')} 之一`,
      `按 ${key} 的说明改正后重发（只接受 ${allowed.join(' / ')}）。`,
    )
  }
  return value.trim()
}

/**
 * G6-d：`runIds` 数组参数（一次审查多个 run）。
 * 去重后返回；空数组 / 非字符串 / 非法 id / 超过上限都是参数错误（即使失败也不读任何 run）。
 */
function optionalRunIdList(args, key, max) {
  const value = argsOf(args)[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new ParamError(`参数 ${key} 必须是 runId 字符串数组`, `按 ${key} 的说明传数组，例如 runIds=["r-xxx"]。`)
  }
  const seen = new Set()
  const list = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ParamError(`参数 ${key} 里的每一项都必须是非空字符串`, '每一项都是 flow_start 返回的 runId。')
    }
    const id = item.trim()
    if (!checkRunId(id)) {
      throw new ParamError(
        `参数 ${key} 里有不合法的 runId「${id}」（只允许字母、数字、点、下划线、连字符，1–64 位）`,
        'runId 来自 flow_start / flow_watch；不要手写或是拼接路径。',
      )
    }
    if (seen.has(id)) continue
    seen.add(id)
    list.push(id)
  }
  if (list.length === 0) {
    throw new ParamError(`参数 ${key} 至少要给一个 runId`, '一次审查多个 run 时传 runIds:[...]；单个 run 用 runId。')
  }
  if (list.length > max) {
    throw new ParamError(
      `参数 ${key} 最多 ${max} 个 run（去重后收到 ${list.length} 个）`,
      `分几次调用，每次不超过 ${max} 个 runId。`,
    )
  }
  return list
}

// ── lossless JSON 收口 ─────────────────────────────────────────────────────

/**
 * 把任意值收敛成 lossless JSON：
 * - `undefined` 在对象里删键、在数组里变 null；
 * - `NaN` / `Infinity` / `-Infinity` → null；
 * - `Date` → ISO 字符串；`bigint` → 字符串；
 * - 循环引用 → null（审计结果正常不会有，这里只做兜底，避免工具调用炸掉）。
 */
function jsonSafe(value, seen = new WeakSet()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (type === 'undefined' || type === 'function' || type === 'symbol') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (type === 'object') {
    if (seen.has(value)) return null
    seen.add(value)
    if (Array.isArray(value)) {
      const out = value.map(item => (item === undefined ? null : jsonSafe(item, seen)))
      seen.delete(value)
      return out
    }
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = jsonSafe(item, seen)
    }
    seen.delete(value)
    return out
  }
  return null
}

function failure(error, hint, retryable = false, extra = {}) {
  return jsonSafe({ ok: false, error, hint, retryable, ...extra })
}

/** 错误对象 → 可读文案（不把堆栈甩给模型）。 */
function messageOf(error) {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return '未知错误'
}

/** 按错误状态给可操作的分流（与 HTTP 层同一口径）。 */
function failureOf(error, { action, extra = {} }) {
  const status = error && Number.isInteger(error.status) ? error.status : null
  const message = messageOf(error)
  if (status === 404) {
    return failure(message, `${action}失败：目标不存在，先调 flow_list / flow_watch 确认 id。`, false, extra)
  }
  if (status === 409) {
    return failure(
      message,
      '冲突（409）：已有 run 在跑或 run 已开始过。等它结束，或先 flow_stop 停掉当前 run 再重试。',
      false,
      extra,
    )
  }
  if (status === 429) {
    // 0.11 · R2/S1：并发配额拒绝是可重试的排队/限额问题，不能吞成 500 或 409。
    return failure(message, `${action}失败：并发配额已满（429，${error && error.reason ? error.reason : 'global-full'}），等已有 run 收尾后重试；不要循环重试刷屏。`, true, {
      ...extra,
      code: error && error.code ? error.code : 'RUN_CONCURRENCY_LIMIT',
      scope: error && error.scope ? error.scope : null,
      reason: error && error.reason ? error.reason : null,
      retryAfterMs: error && Number.isInteger(error.retryAfterMs) ? error.retryAfterMs : 30000,
      ...(error && error.limits ? { limits: error.limits } : {}),
    })
  }
  if (status === 400) {
    return failure(message, `${action}失败：参数或流程不合法，改正后再试；重发同一份请求不会变。`, false, extra)
  }
  if (status === 503) {
    return failure(message, '依赖服务暂不可用（如 subagents），稍后重试。', true, extra)
  }
  return failure(
    message,
    `${action}失败：如果是暂时性故障可以重试一次；仍失败就停下并告诉主人。`,
    true,
    extra,
  )
}

// ── 父会话 / 工作区继承 ────────────────────────────────────────────────────

/**
 * 当前会话 id：模型工具只能证明「父会话是谁」，不猜测工作区路径。
 * 主口径是 `agent.session.id`（与 engine._agentSessionId / agents.get 一致）；
 * 少数组合只在 `session.header.id` 上给出 id，这里顺带兜底。
 */
function sessionIdOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  if (!session) return null
  if (typeof session.id === 'string' && session.id !== '') return session.id
  const header = session.header
  if (header && typeof header.id === 'string' && header.id !== '') return header.id
  return null
}

/**
 * 07 §6 的两条 executor 规则（custom 必须填 `executorCommand`；外部 executor 只能 single）
 * 不在 `validateFlowForRun` 里，只在节点执行时被 `normalizeExecutor` 拦住。模型工具在
 * 建 run **之前**按同一份规则预检，非法配置直接失败，不留下一个跑不动的 run。
 */
function executorBlockers(flow) {
  const blockers = []
  for (const node of (flow && flow.nodes) || []) {
    if (!node || node.kind !== NODE_KIND.STAGE) continue
    try {
      normalizeExecutor(node)
    } catch (error) {
      blockers.push({ nodeId: node.id, message: error && error.message ? error.message : String(error) })
    }
  }
  return blockers
}

/**
 * 07 §4.1：默认 workspace = **调用方会话的 cwd**（`exec.agent.session.header.cwd`）。
 * 取不到就不传，交给 engine 回落（绝不瞎猜一个路径）。
 */
function workspaceOfSession(exec) {
  const session = exec && exec.agent && exec.agent.session
  const header = session && session.header
  const cwd = header && typeof header.cwd === 'string' ? header.cwd.trim() : ''
  return cwd !== '' ? cwd : undefined
}

/**
 * 06 §16：sessionId → { runId, nodeId }。
 * 引擎内存索引优先；没有（或引擎不支持）时扫最近 20 个 run 的 sessions.json 兜底。
 */
async function resolveSessionOwner(deps, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (deps.engine && typeof deps.engine.resolveSessionOwner === 'function') {
    try {
      const owner = await deps.engine.resolveSessionOwner(sessionId)
      if (owner) return owner
    } catch {
      // 引擎反查失败就退回磁盘。
    }
  }
  try {
    const listed = await listRuns(deps.runsRoot, { limit: 20 })
    for (const run of listed.runs || []) {
      const sessions = await readNodeSessions(deps.runsRoot, run.id)
      for (const [nodeId, entry] of Object.entries(sessions || {})) {
        if (entry && entry.sessionId === sessionId) return { runId: run.id, nodeId }
      }
    }
  } catch {
    // 读不到当查不到。
  }
  return null
}

/** 06 §16：省略 runId 时取「当前会话启动的最新 run」，再退回最近一次 run。 */
async function resolveRunId(deps, exec, requested) {
  if (requested !== undefined) {
    if (!checkRunId(requested)) {
      throw new ParamError(
        `runId「${requested}」不合法（只允许字母、数字、点、下划线、连字符，1–64 位）`,
        'runId 来自 flow_start / flow_watch；省略则用当前会话启动的最新 run。',
      )
    }
    return requested
  }
  const sessionId = sessionIdOf(exec)
  const engine = deps.engine
  if (engine && typeof engine.runForSession === 'function') {
    try {
      const fromEngine = engine.runForSession(sessionId)
      if (typeof fromEngine === 'string' && fromEngine !== '') return fromEngine
    } catch {
      // 退回最近一次 run。
    }
  }
  const listed = await listRuns(deps.runsRoot, { limit: 1 })
  const latest = Array.isArray(listed.runs) && listed.runs.length > 0 ? listed.runs[0] : null
  if (!latest) {
    throw new ParamError(
      '没有可用的 run',
      '先用 flow_start 启动一个流程，或显式传 runId。',
    )
  }
  return latest.id
}

// ── 审查闹钟文案 ───────────────────────────────────────────────────────────

/**
 * 给 `proactive_set` 用的完整提示词（≥40 字）：必须包含 runId、flow_watch、
 * proactive_reclaim 三要素，否则模型醒来会不知道干什么。
 */
function watchAlarmPrompt(runId, flowName, seconds) {
  const label = flowName ? `（流程「${flowName}」）` : ''
  return [
    `【工作流审查】runId=${runId}${label}。请调用 flow_watch（runId="${runId}"）审查这个 run 是否在正常运转：`,
    '若 verdict 表示运行正常且没有停滞，就调用 proactive_reclaim 安静结束本轮，不要打扰主人；',
    '只有出现异常（节点停滞、打回过多、节点失败）或整个流程已经跑完（done/failed/aborted），',
    `才把结论、异常点和需要主人决策的地方通知主人。本次是 ${seconds} 秒一次的定期复核。`,
  ].join('')
}

/** 终态时不必再挂闹钟的说明。 */
function terminalPrompt(runId, verdict, headline) {
  const summary = headline ? `（结论：${headline}）` : ''
  return `runId=${runId} 的流程已经结束（verdict=${verdict}）${summary}，不必再挂审查闹钟：`
    + '调用 proactive_reclaim 结束本轮，把这个结论汇报给主人即可。'
}

/** 审查间隔：审计给了合理值就用它，否则用默认值；钳制在 30–900 秒。 */
function clampSeconds(value, fallback) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return fallback
  return Math.min(900, Math.max(30, value))
}

// ── 审计模块（真实 import，缺失时给出可操作失败） ───────────────────────────

let auditModulePromise = null

/**
 * 加载 `src/audit.js`。
 *
 * 用**动态 import** 而不是顶层静态 import：本仓库的审计模块由另一条工作流并行落地，
 * 文件还没出现时整个插件（含 HTTP 面板）不应因此装不上。`createFlowTools` 支持
 * 注入 `auditWorkflow`（测试用 stub），生产路径仍然走真实模块。
 */
function loadAuditModule() {
  if (!auditModulePromise) {
    auditModulePromise = import('./audit.js').catch(error => {
      auditModulePromise = null
      throw error
    })
  }
  return auditModulePromise
}

async function resolveAudit(deps) {
  if (typeof deps.auditWorkflow === 'function') return deps.auditWorkflow
  const mod = await loadAuditModule()
  if (!mod || typeof mod.auditWorkflow !== 'function') {
    throw new Error('src/audit.js 没有导出 auditWorkflow')
  }
  return mod.auditWorkflow
}

// ── 流程解析 ───────────────────────────────────────────────────────────────

/**
 * 解析目标流程：flowId 优先；没有 id 时按 flowName 精确匹配，再退不区分大小写。
 * 同名多份 → 失败并列出候选 id（让模型用 flowId 指定，而不是瞎猜）。
 */
async function resolveFlow(deps, args) {
  const flowId = optionalString(args, 'flowId', { max: 128 })
  const flowName = optionalString(args, 'flowName', { max: 200 })

  if (flowId !== undefined) {
    if (!checkId(flowId)) {
      return {
        failure: failure(
          `flowId「${flowId}」不合法（只允许小写字母、数字、连字符，≤64 位）`,
          '先调 flow_list，用返回的 id 原样传 flowId。',
        ),
      }
    }
    const flow = await readFlow(deps.flowsRoot, flowId)
    if (!flow) {
      return { failure: failure(`流程不存在：${flowId}`, '先调 flow_list 看当前可用流程（id + name）。') }
    }
    return { flow }
  }

  if (flowName !== undefined) {
    const all = await listFlows(deps.flowsRoot)
    const exact = all.filter(item => item.name === flowName)
    const candidates = exact.length > 0
      ? exact
      : all.filter(item => String(item.name).toLowerCase() === flowName.toLowerCase())
    if (candidates.length === 0) {
      return {
        failure: failure(
          `没有找到名称为「${flowName}」的流程`,
          '先调 flow_list 看可用流程；名称必须与列表里的 name 一致（或换 flowId）。',
        ),
      }
    }
    if (candidates.length > 1) {
      const ids = candidates.map(item => item.id)
      return {
        failure: failure(
          `有 ${candidates.length} 个流程同名「${flowName}」：${ids.join('、')}`,
          `改用 flowId 指定其中一个：${ids.join(' / ')}`,
          false,
          { candidates: ids },
        ),
      }
    }
    // 列表摘要只有 id/name，真正的节点与边要回读完整流程。
    const flow = await readFlow(deps.flowsRoot, candidates[0].id)
    if (!flow) {
      return {
        failure: failure(
          `流程「${flowName}」（${candidates[0].id}）读取失败，可能刚被删除或文件损坏`,
          '先调 flow_list 确认它还在，再用 flowId 重试。',
        ),
      }
    }
    return { flow }
  }

  return {
    failure: failure(
      '缺少 flowId 或 flowName',
      '先调 flow_list 拿到流程 id，再调 flow_start（flowId 与 flowName 二选一；同名时用 flowId）。',
    ),
  }
}

// ── 工具定义 ───────────────────────────────────────────────────────────────

/**
 * 构造模型工具：基础五个（list / start / watch / stop / supervise），agents 服务
 * 可用时追加收件箱两个（flow_send_message / flow_reply）。
 *
 * @param {{
 *   flowsRoot: string,
 *   runsRoot: string,
 *   engine: { start: Function, stop: Function, engineName?: string },
 *   auditWorkflow?: Function,
 *   watchSeconds?: number,
 *   stallMs?: number,
 *   nodeTimeoutMs?: number,
 *   maxRejectsPerEdge?: number,
 *   now?: () => Date,
 *   worktree?: object,           // 注入 worktree 模块（测试用桩；默认真实 ./worktree.js）
 *   worktreesRoot?: string,      // 默认 <runsRoot 的父级>/worktrees
 *   worktreeRunner?: Function,   // 注入 git runner（透传给 worktree 模块）
 * }} deps
 */
export function createFlowTools(deps) {
  if (!deps || typeof deps.flowsRoot !== 'string' || deps.flowsRoot === '') {
    throw new TypeError('createFlowTools 需要 flowsRoot')
  }
  if (typeof deps.runsRoot !== 'string' || deps.runsRoot === '') {
    throw new TypeError('createFlowTools 需要 runsRoot')
  }
  if (!deps.engine || typeof deps.engine.start !== 'function' || typeof deps.engine.stop !== 'function') {
    throw new TypeError('createFlowTools 需要 { start, stop } 引擎')
  }

  const watchSeconds = clampSeconds(deps.watchSeconds, DEFAULT_WATCH_SECONDS)
  const stallMs = Number.isInteger(deps.stallMs) && deps.stallMs > 0 ? deps.stallMs : DEFAULT_STALL_MS
  const nodeTimeoutMs = Number.isInteger(deps.nodeTimeoutMs) && deps.nodeTimeoutMs > 0
    ? deps.nodeTimeoutMs
    : DEFAULT_NODE_TIMEOUT_MS
  const maxRejectsPerEdge = Number.isInteger(deps.maxRejectsPerEdge) && deps.maxRejectsPerEdge > 0
    ? deps.maxRejectsPerEdge
    : DEFAULT_MAX_REJECTS_PER_EDGE
  const now = typeof deps.now === 'function' ? deps.now : () => new Date()
  const engineName = deps.engine.engineName === 'stub' ? 'stub' : 'real'
  // G6-b：worktree 生命周期 API（真实模块 or 注入桩）。缺 list/prune 时对应动作给出
  // 明确失败，而不是假装成功——模块由另一条工作流并行落地。
  const worktreeApi = deps.worktree && typeof deps.worktree === 'object' ? deps.worktree : worktreeModule
  const worktreesRoot = typeof deps.worktreesRoot === 'string' && deps.worktreesRoot !== ''
    ? deps.worktreesRoot
    : worktreesRootFor(deps.runsRoot)
  const worktreeRunner = typeof deps.worktreeRunner === 'function' ? deps.worktreeRunner : undefined
  // 06 §16：收件箱 / 回复工具依赖 agents 服务（没有它无法向会话注入消息，flow_reply
  // 也没有可用的会话反查）。测试台 / 纯注入环境拿不到 agents 时只注册基础五个工具
  //（v0.7 起多了 flow_supervise；它只写调度状态，不依赖 agents，拿不到 agents 也能注册，
  // 唤醒失败会由 scheduler 按「连续 3 次降级」处理）。
  const inboxToolsEnabled = ctxHasAgents(deps.ctx)

  // ── G6-d：flow_watch 的「一次读、多 run 共用」上下文 ─────────────────────
  //
  // 多 run 审查不是把单 run 逻辑循环 N 遍：每个 run 的 detail / events / flow 只读一次，
  // 同一份 events 同时喂给审计与 blockedNodeAdvice（同一次调用内共享一次事件读取）。
  // eventCache 还顺带保证重复 runId（理论上已去重）不会二次读盘。

  /** 读一个 run 的审查上下文；失败返回 {failure}（可读、可操作）。 */
  async function loadWatchContext(runId, eventCache) {
    const detail = await readRunDetail(deps.runsRoot, runId)
    if (!detail) {
      return {
        runId,
        failure: failure(
          `run 不存在：${runId}`,
          '用 flow_start 的返回值确认 runId；省略 runId 则审查最近一次 run。',
          false,
          { runId },
        ),
      }
    }
    let all = eventCache.get(runId)
    if (all === undefined) {
      all = await readAllEvents(deps.runsRoot, runId)
      eventCache.set(runId, all || null)
    }
    if (!all) {
      return {
        runId,
        failure: failure(
          `run 的事件日志不可读：${runId}`,
          '稍后重试；持续失败说明 Host 侧存储损坏，先告诉主人。',
          true,
          { runId },
        ),
      }
    }
    const flow = await readFlow(deps.flowsRoot, detail.run.flowId)
    if (!flow) {
      return {
        runId,
        failure: failure(
          `run ${runId} 使用的流程模板不存在（flowId=${detail.run.flowId}，可能已被删除）`,
          '到面板确认流程是否还在；没有模板就无法判断节点计划。',
          false,
          { runId },
        ),
      }
    }
    return { runId, detail, events: all.events, flow }
  }

  /** 审查一个上下文，返回与单 run 完全同形状的结论（多 run 时每个元素就是它）。 */
  async function auditRunContext(context) {
    const { runId, detail, events, flow } = context
    const auditWorkflow = await resolveAudit(deps)
    const audited = await auditWorkflow({
      flow,
      events,
      run: detail.run,
      now: now(),
      stallMs,
      nodeTimeoutMs,
      maxRejectsPerEdge,
    })
    if (!audited || typeof audited !== 'object' || Array.isArray(audited)) {
      return failure(
        '审计模块返回了非法结果',
        '把这条失败与审计模块的现状告诉主人（属于实现缺陷，不是调用方问题）。',
        false,
        { runId },
      )
    }

    const verdict = typeof audited.verdict === 'string'
      ? audited.verdict
      : (typeof audited.status === 'string' ? audited.status : null)
    const terminal = verdict !== null && TERMINAL_VERDICTS.has(verdict)
    const nextCheckSeconds = terminal ? null : clampSeconds(audited.nextCheckSeconds, watchSeconds)
    const alarmPrompt = terminal
      ? terminalPrompt(runId, verdict, typeof audited.headline === 'string' ? audited.headline : '')
      : watchAlarmPrompt(runId, detail.run.flowName, nextCheckSeconds)

    // v0.8 §11.4：节点最新自审状态直接读 run.json；blocked 且进度不变时补一条建议。
    // 与审计共用同一份 events（同一次读取），不再为 nodeStatus 单独读一遍事件。
    const nodeStatus = nodeStatusOfRun(detail.run)
    const nodeAdvice = blockedNodeAdvice(nodeStatus, events)
    // 调度器实时健康度（只读、宽松透传）：status() 的 9 个字段不够诊断，
    // 超时 / 停摆 / 自审回报格式错都在 snapshot() 里。
    const runLevelSnapshot = supervisionSnapshotOf(deps.engine && deps.engine.supervision, 'run 级')
    const nodeLevelSnapshot = supervisionSnapshotOf(deps.engine && deps.engine.nodeSupervision, '节点级')
    const schedulerHealth = supervisionHealthOf(runLevelSnapshot, nodeLevelSnapshot)

    return jsonSafe({
      ...audited,
      recommended: withRecommendations(
        withRecommendations(audited.recommended, nodeAdvice),
        [...schedulerHealth.warnings, ...schedulerHealth.notices],
      ),
      ok: true,
      runId,
      flowId: detail.run.flowId,
      nodeStatus,
      supervision: {
        nextCheckSeconds,
        alarmPrompt,
        watchTool: 'flow_watch',
        // 07 §7：run.json.supervision 的只读快照（内建调度是否开启、上次/下次唤醒）。
        scheduler: detail.run.supervision && typeof detail.run.supervision === 'object'
          ? detail.run.supervision
          : null,
        // 新增：调度器内存中的实时快照（缺 snapshot() 时 available=false + reason）。
        schedulerSnapshot: runLevelSnapshot,
        nodeSchedulerSnapshot: nodeLevelSnapshot,
        // 把「超时 / 停摆 / invalid 回报 / 限流 / 合并唤醒 / 恢复扫描」收成可读结论
        //（同时并入 recommended）。
        health: {
          timeouts: schedulerHealth.timeouts,
          invalidReports: schedulerHealth.invalidReports,
          // G7-a：run 级调度器的累计计数（缺省 0）。
          wokenThisHour: schedulerHealth.wokenThisHour,
          throttled: schedulerHealth.throttled,
          coalesced: schedulerHealth.coalesced,
          // G7-b：节点闹钟重启恢复扫描（没有该字段时为 null）。
          recovery: schedulerHealth.recovery,
          warnings: schedulerHealth.warnings,
        },
      },
    })
  }

  /**
   * G6-d：把 N 份逐 run 结论合成一份建议。
   * - terminal：所有「存在且审得动」的 run 都到终态（或没有这类 run）；
   * - nextCheckSeconds：所有非终态 run 里最小的间隔（谁先到期就按谁挂闹钟）；
   * - recommended：逐 run 前缀化的合并建议（异常 / 审计建议 / 失败原因都收进来）。
   */
  function mergeWatchResults(results) {
    const total = results.length
    const okResults = results.filter(item => item && item.ok === true)
    const failedResults = results.filter(item => !item || item.ok !== true)
    const verdicts = {}
    const recommended = []
    let nextCheckSeconds = null
    let allTerminal = true

    for (const item of results) {
      if (!item || item.ok !== true) {
        recommended.push(
          `run ${item && item.runId ? item.runId : '(未知)'}：${item && item.error ? item.error : '审查失败'}`,
        )
        continue
      }
      const verdict = typeof item.verdict === 'string'
        ? item.verdict
        : (typeof item.status === 'string' ? item.status : 'unknown')
      verdicts[verdict] = (verdicts[verdict] || 0) + 1
      const supervision = item.supervision && typeof item.supervision === 'object' ? item.supervision : null
      const terminal = TERMINAL_VERDICTS.has(verdict)
        || !supervision || supervision.nextCheckSeconds === null
      if (!terminal) {
        allTerminal = false
        const seconds = Number.isInteger(supervision.nextCheckSeconds)
          ? supervision.nextCheckSeconds
          : watchSeconds
        nextCheckSeconds = nextCheckSeconds === null ? seconds : Math.min(nextCheckSeconds, seconds)
      }
      if (Array.isArray(item.anomalies) && item.anomalies.length > 0) {
        recommended.push(`run ${item.runId}：异常 ${item.anomalies.length} 条`)
      }
      if (Array.isArray(item.recommended)) {
        for (const entry of item.recommended) {
          if (typeof entry === 'string' && entry.trim() !== '') recommended.push(`run ${item.runId}：${entry}`)
        }
      } else if (typeof item.recommended === 'string' && item.recommended.trim() !== '') {
        recommended.push(`run ${item.runId}：${item.recommended}`)
      }
    }

    // 一个可审的 run 都没有（全部 404 / 事件不可读）时，没有「再等一轮」的意义。
    const finished = okResults.length === 0 ? true : allTerminal
    // 调度器级告警（限流 / 合并唤醒 / 恢复扫描）对同一轮里的每个 run 都相同，
    // 去重后只出现一次，避免 N 个 run 把同一条结论刷 N 遍。
    const uniqueRecommended = [...new Set(recommended)]
    const runIds = results
      .map(item => (item && typeof item.runId === 'string' ? item.runId : null))
      .filter(id => id !== null)
    const quoted = runIds.map(id => `"${id}"`).join(', ')
    const alarmPrompt = finished
      ? `runIds=[${quoted}] 的流程都已结束或无法继续，不必再挂审查闹钟：调用 proactive_reclaim 结束本轮，把结论汇报给主人。`
      : `【工作流审查】请在 ${nextCheckSeconds} 秒后再次调用 flow_watch（runIds=[${quoted}]）`
        + '一次性审查这些 run 是否正常运转：healthy 就 proactive_reclaim 安静结束本轮；'
        + '出现异常（节点停滞、打回过多、节点失败）或跑完才通知主人。'
    return {
      total,
      ok: okResults.length,
      failed: failedResults.length,
      verdicts,
      recommended: uniqueRecommended,
      terminal: finished,
      nextCheckSeconds: finished ? null : nextCheckSeconds,
      alarmPrompt,
      watchTool: 'flow_watch',
      runIds,
      hint: finished
        ? '这些 run 都已到终态（或不存在），不需要再定时审查。'
        : `建议 ${nextCheckSeconds} 秒后再审查一次（合并建议见 recommended）。`,
    }
  }

  return [
    // ── flow_list ──────────────────────────────────────────────────────────
    {
      name: 'flow_list',
      description:
        '列出当前可用的流程模板（画布上每个节点是一个 agent，按图顺序执行）。'
        + '返回 { ok, flows: [{ id, name, nodeCount, edgeCount, updatedAt }] }，按更新时间倒序，默认 20 条（最多 100）。'
        + '这是「从会话里启动流程」的第一步：先拿到 id 或 name，再用 flow_start 启动；'
        + '启动后用 flow_watch 定时审查，形成「列流程 → 启动 → 定时自审」的闭环。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '返回条数，默认 20，最大 100；超出按 100 截断' },
        },
        required: [],
      },
      output: outputFor({
        flows: {
          type: 'array',
          description: '流程模板摘要（不含节点与边的完整内容）',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '流程 id（唯一，传给 flow_start 的 flowId）' },
              name: { type: 'string', description: '流程显示名（可能重名，重名时用 flowId）' },
              nodeCount: { type: 'integer', description: '节点总数（含开始 / 结束节点）' },
              edgeCount: { type: 'integer', description: '连线总数（next + reject）' },
              updatedAt: { type: 'string', description: '最后更新时间（ISO 8601）' },
            },
            required: ['id', 'name'],
            additionalProperties: true,
          },
        },
      }, (args, value) => {
        if (!value || value.ok !== true || !Array.isArray(value.flows)) return renderJson(value)
        if (value.flows.length === 0) return [{ type: 'text', text: '当前没有流程模板。' }]
        const lines = value.flows.map(item => `- ${item.id} · ${item.name}（${item.nodeCount} 节点 / ${item.edgeCount} 连线）`)
        return [{ type: 'text', text: `共 ${value.flows.length} 个流程：\n${lines.join('\n')}` }]
      }),
      timeoutMs: TIMEOUT_LIST_MS,
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const a = argsOf(args)
          const raw = a.limit
          let limit = 20
          if (raw !== undefined && raw !== null) {
            if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
              throw new ParamError('参数 limit 必须是正整数', '省略 limit 用默认 20，或传 1–100 的整数。')
            }
            limit = Math.min(raw, 100)
          }
          const flows = await listFlows(deps.flowsRoot)
          return jsonSafe({
            ok: true,
            flows: flows.slice(0, limit).map(item => ({
              id: String(item.id),
              name: typeof item.name === 'string' && item.name !== '' ? item.name : String(item.id),
              nodeCount: Number.isInteger(item.nodeCount) ? item.nodeCount : 0,
              edgeCount: Number.isInteger(item.edgeCount) ? item.edgeCount : 0,
              updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
            })),
          })
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`读取流程列表失败：${messageOf(error)}`, '稍后重试；持续失败说明 Host 侧存储不可读，先告诉主人。', true)
        }
      },
    },

    // ── flow_worktrees（G6-b：worktree 生命周期） ─────────────────────────
    {
      name: 'flow_worktrees',
      description:
        '查看 / 清理 run 的 git worktree 生命周期（G6-b）。'
        + 'action=list：列出 worktrees 根目录下的全部 worktree（path / workspaceId / runId / exists / dirty / head / registered），'
        + '并标出 orphan=true（对应 run 已被删除、但目录 / .git/worktrees 记录 / 分支还留下的孤儿）。'
        + 'action=prune：调用 pruneWorktrees 删除「不对应任何现有 run」的 worktree；keepRunIds 可额外保留指定 run 的 worktree。'
        + 'DELETE /runs/<id> 只删 run 目录、保留 worktree 并把指针记进孤儿清单；'
        + '所以清理顺序是：先 prune（或对仍存在的 run 用 HTTP DELETE /runs/<id>/worktree），再确认目录已消失。'
        + 'prune 会连前缀匹配的 git 分支（默认 flow/）一起回收；分支删不掉（未合并保护 / 前缀不符 / 主仓库已删）'
        + '不影响目录清理，会记进 skipped 并给出 branchWarning。只删 flow/ 开头的分支，绝不碰用户分支。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'prune'],
            description: 'list = 列出 worktree（含 orphan 标记）；prune = 删除不对应任何现有 run 的 worktree',
          },
          keepRunIds: {
            type: 'array',
            items: { type: 'string' },
            description: `action=prune 时额外保留的 runId（可选，去重后 ≤${MAX_KEEP_RUN_IDS} 个）；现有 run 永远自动保留`,
          },
        },
        required: ['action'],
      },
      output: outputFor({
        action: { type: 'string', description: '本次执行的动作：list / prune' },
        root: nullable({ type: 'string' }, 'worktrees 根目录（<home>/flow-studio/worktrees）'),
        available: { type: 'boolean', description: 'worktree 模块是否提供了所需导出（false 时看 reason / error）' },
        worktrees: {
          type: 'array',
          description: 'action=list：worktree 清单（每项含 path / workspaceId / runId / exists / dirty / head / registered / orphan）',
          items: anyJson('单个 worktree 的状态'),
        },
        orphans: {
          type: 'array',
          description: 'action=list：清单里对应 run 已不存在的项（需要清理的孤儿）',
          items: anyJson('孤儿 worktree'),
        },
        removed: anyJson('action=prune：pruneWorktrees 返回的已删除项'),
        skipped: anyJson('action=prune：pruneWorktrees 返回的跳过项（含原因）'),
        keepRunIds: { type: 'integer', description: 'action=prune：实际保留的 runId 数量（现有 run + 额外保留）' },
      }, (args, value) => {
        if (!value || value.ok !== true) return renderJson(value)
        if (value.action === 'prune') {
          const removed = Array.isArray(value.removed) ? value.removed.length : 0
          const skipped = Array.isArray(value.skipped) ? value.skipped.length : 0
          return [{
            type: 'text',
            text: `worktree 清理完成：删除 ${removed} 个、跳过 ${skipped} 个（保留 ${value.keepRunIds} 个 run 的 worktree）。`,
          }]
        }
        const list = Array.isArray(value.worktrees) ? value.worktrees : []
        const orphans = Array.isArray(value.orphans) ? value.orphans : []
        const lines = list.slice(0, 50).map(item => (
          `- ${item.runId || '?'}${item.orphan === true ? '（孤儿）' : ''}：${item.path || '(无 path)'}`
            + `${item.exists === false ? '（目录已不存在）' : ''}`
        ))
        const tail = list.length > 50 ? `\n…还有 ${list.length - 50} 个` : ''
        return [{
          type: 'text',
          text: `共 ${list.length} 个 worktree，其中孤儿 ${orphans.length} 个：\n${lines.join('\n')}${tail}`,
        }]
      }),
      timeoutMs: TIMEOUT_WORKTREE_MS,
      // 同一工具既能 list 也能 prune（写操作），因此不标 isConcurrencySafe：串行执行。
      async execute(args) {
        let action
        let keepRunIds
        try {
          action = optionalEnum(args, 'action', ['list', 'prune'])
          if (action === undefined) {
            throw new ParamError('缺少必填参数 action', '传 action:"list" 或 action:"prune"。')
          }
          const rawKeep = argsOf(args).keepRunIds
          keepRunIds = []
          if (rawKeep !== undefined && rawKeep !== null) {
            if (!Array.isArray(rawKeep)) {
              throw new ParamError('参数 keepRunIds 必须是 runId 字符串数组', '传数组，例如 keepRunIds=["r-xxx"]。')
            }
            const seen = new Set()
            for (const item of rawKeep) {
              if (typeof item !== 'string' || !checkRunId(item.trim())) {
                throw new ParamError(
                  `参数 keepRunIds 里有不合法的 runId「${String(item)}」`,
                  '每一项都是 flow_start 返回的 runId。',
                )
              }
              const id = item.trim()
              if (seen.has(id)) continue
              seen.add(id)
              keepRunIds.push(id)
            }
            if (keepRunIds.length > MAX_KEEP_RUN_IDS) {
              throw new ParamError(
                `参数 keepRunIds 最多 ${MAX_KEEP_RUN_IDS} 个 runId`,
                '分几次清理，或先 flow_list 确认要保留哪些。',
              )
            }
          }
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`读取参数失败：${messageOf(error)}`, '按参数说明改正后重发。')
        }

        if (action === 'list') {
          if (typeof worktreeApi.listWorktrees !== 'function') {
            return failure(
              'worktree 模块还没有导出 listWorktrees（生命周期模块未落地）',
              '这属于实现缺口，不是参数问题；等 src/worktree.js 落地后重试，或先用 HTTP GET /worktrees 看 recorded 指针。',
            )
          }
          try {
            const existing = new Set(await listExistingRunIds(deps.runsRoot))
            const listed = await worktreeApi.listWorktrees({ root: worktreesRoot, run: worktreeRunner })
            const entries = Array.isArray(listed)
              ? listed.filter(item => item && typeof item === 'object' && !Array.isArray(item))
              : []
            const worktrees = entries.map(item => ({
              ...item,
              orphan: !existing.has(item.runId),
            }))
            return jsonSafe({
              ok: true,
              action: 'list',
              root: worktreesRoot,
              available: true,
              worktrees,
              orphans: worktrees.filter(item => item.orphan === true),
            })
          } catch (error) {
            return failure(
              `列出 worktree 失败：${messageOf(error)}`,
              '检查 worktrees 根目录权限 / git 是否可用；仍失败就告诉主人。',
              true,
            )
          }
        }

        if (typeof worktreeApi.pruneWorktrees !== 'function') {
          return failure(
            'worktree 模块还没有导出 pruneWorktrees（生命周期模块未落地）',
            '这属于实现缺口，不是参数问题；等 src/worktree.js 落地后重试。',
          )
        }
        try {
          const existing = await listExistingRunIds(deps.runsRoot)
          const keep = [...new Set([...existing, ...keepRunIds])]
          const result = await worktreeApi.pruneWorktrees({
            root: worktreesRoot,
            keepRunIds: keep,
            run: worktreeRunner,
          })
          return jsonSafe({
            ok: true,
            action: 'prune',
            root: worktreesRoot,
            keepRunIds: keep.length,
            removed: result && result.removed !== undefined ? result.removed : [],
            skipped: result && result.skipped !== undefined ? result.skipped : [],
          })
        } catch (error) {
          return failure(
            `清理 worktree 失败：${messageOf(error)}`,
            '检查 git 是否可用、目录权限；持续失败就告诉主人。',
            true,
          )
        }
      },
    },

    // ── flow_start ─────────────────────────────────────────────────────────
    {
      name: 'flow_start',
      description:
        '在**当前会话**里直接启动一个流程 run（不用去 Web 面板点运行）。三步闭环：'
        + '① 本工具用当前会话的 Agent 作父会话启动 run（request.parent=当前会话、workspace=本会话 cwd），'
        + '子 agent 因此**继承本会话的工作区**，不需要也不应该再选目录；'
        + '② 启动成功后**自动开启内建 supervision 调度**（返回 supervision.enabled=true 即已开启）：'
        + '不需要再挂 proactive_set 闹钟，到点会自动唤醒你（同一会话）来复查；'
        + '只有在 supervision.enabled=false（引擎不支持/登记失败）时才用旧方式：'
        + 'proactive_set 的 after_seconds=supervision.nextCheckSeconds 挂 supervision.alarmPrompt；'
        + '③ 每次被唤醒后调用 flow_watch（runId=返回的 runId）审查整个工作流是否正常，'
        + 'healthy 就直接结束本轮，出现异常或跑完才通知主人。'
        + '流程选择：flowId 优先；没有 id 时按 flowName 精确匹配（再退不区分大小写）；都不给会失败并提示先调 flow_list；'
        + '同名多份会失败并列出候选 id。task 是用户这次要跑的任务原文（可选，写进 run 的 name）；'
        + 'name 是本次 run 的显示名（可选，优先于 task）。流程不存在 / 不合法会在建 run 之前失败；'
        + '同一 runId 已在跑（409）会返回可读原因——v0.7 起并发不设上限，不同 run 可以同时跑。'
        + 'workspace 必须能显式确定：显式传 workspace（绝对路径）或从带 cwd 的会话里启动；'
        + '两者都拿不到会直接失败（**不会**悄悄回落到进程 cwd）。'
        + 'worktree 决定是否给这个 run 单独开 git worktree'
        + '（auto = 工作区是 git 仓库就开，默认；on = 必须开，不是 git 仓库会 400；off = 不开）。'
        + `时限：runTimeoutMs / nodeTimeoutMs 可选（正整数毫秒），分别限制整轮 run 与单个节点；`
        + `不给就用引擎默认值 —— run 级 ${DEFAULT_RUN_TIMEOUT_MS}ms（2 小时）、`
        + `节点级 ${DEFAULT_NODE_TIMEOUT_MS}ms（20 分钟），`
        + '也可由环境变量 FLOW_STUDIO_RUN_TIMEOUT_MS / FLOW_STUDIO_NODE_TIMEOUT_MS 覆盖；'
        + '长任务（>2 小时）必须显式调大 runTimeoutMs，否则开局就注定被超时收掉。',
      parameters: {
        type: 'object',
        properties: {
          flowId: { type: 'string', description: '流程 id（来自 flow_list 的 id；与 flowName 二选一，优先）' },
          flowName: { type: 'string', description: '流程名称（没有 flowId 时用；精确匹配优先，再退不区分大小写；重名会失败并列候选）' },
          task: { type: 'string', description: '用户这次要跑的任务原文（可选，≤2000 字符；写进 run.json 的 name，超过 200 字符截断）' },
          name: { type: 'string', description: '本次 run 的显示名（可选，≤200 字符；优先于 task）' },
          workspace: {
            type: 'string',
            description: '工作区绝对路径（可选；省略时取调用方会话的 cwd）。'
              + '显式值与会话 cwd 都拿不到时 flow_start 直接失败，不会回落到进程 cwd',
          },
          worktree: { type: 'string', enum: ['auto', 'on', 'off'], description: 'worktree 策略：auto（默认，git 仓库才开）/ on（必须开，否则 400）/ off（不开）' },
          runTimeoutMs: {
            type: 'integer',
            description: `整轮 run 的时限（毫秒，可选正整数，上限 ${MAX_TIMEOUT_MS}）。`
              + `省略 = 引擎默认 ${DEFAULT_RUN_TIMEOUT_MS}ms（2 小时）或环境变量 FLOW_STUDIO_RUN_TIMEOUT_MS；`
              + '长任务必须显式调大，否则会被超时收掉',
          },
          nodeTimeoutMs: {
            type: 'integer',
            description: `单个节点的时限（毫秒，可选正整数，上限 ${MAX_TIMEOUT_MS}）。`
              + `省略 = 引擎默认 ${DEFAULT_NODE_TIMEOUT_MS}ms（20 分钟）或环境变量 FLOW_STUDIO_NODE_TIMEOUT_MS`,
          },
        },
        required: [],
      },
      output: outputFor({
        runId: nullable({ type: 'string' }, '新建的 run id（后续 flow_watch / flow_stop 都用它）'),
        flowId: nullable({ type: 'string' }, '实际启动的流程 id'),
        flowName: nullable({ type: 'string' }, '实际启动的流程名'),
        status: nullable({ type: 'string' }, '启动后的 run 状态（正常为 running）'),
        candidates: { type: 'array', items: { type: 'string' }, description: '同名流程的候选 id（仅「同名多份」失败时出现）' },
        workspace: nullable({
          type: 'object',
          description: '工作区信息：默认继承当前会话的 cwd；worktree 由 engine 在 start 时最终裁决并写进 run.json',
          properties: {
            inheritedFrom: nullable({ type: 'string' }, '父会话 id；子 agent 从它继承工作目录'),
            path: nullable({ type: 'string' }, '实际工作区路径（run.json.workspace.path；未裁决时回落请求值）'),
            workspaceId: nullable({ type: 'string' }, 'run.json.workspace.id（12 位 hex；未裁决为 null）'),
            worktree: nullable({ type: 'string' }, '请求的 worktree 策略：auto / on / off'),
            worktreeEnabled: nullable({ type: 'boolean' }, 'run.json.worktree.enabled（未裁决为 null）'),
            worktreeReason: nullable({ type: 'string' }, 'run.json.worktree.reason（未裁决为 null）'),
          },
          additionalProperties: true,
        }),
        limits: {
          type: 'object',
          description: '本次 run 的时限（毫秒）：显式传入值 + 引擎默认值（G6-c）',
          properties: {
            runTimeoutMs: nullable({ type: 'integer' }, '本次显式传入的 run 级时限；null = 用引擎默认 / 环境变量'),
            nodeTimeoutMs: nullable({ type: 'integer' }, '本次显式传入的节点级时限；null = 用引擎默认 / 环境变量'),
            defaultRunTimeoutMs: { type: 'integer', description: `引擎默认 run 级时限 ${DEFAULT_RUN_TIMEOUT_MS}ms（2 小时）` },
            defaultNodeTimeoutMs: { type: 'integer', description: `引擎默认节点级时限 ${DEFAULT_NODE_TIMEOUT_MS}ms（20 分钟）` },
          },
          required: ['defaultRunTimeoutMs', 'defaultNodeTimeoutMs'],
          additionalProperties: true,
        },
        supervision: nullable({
          type: 'object',
          description: '内建 supervision 调度状态 + 向后兼容的闹钟参数（v0.7 起默认自动开启，不需要手动挂闹钟）',
          properties: {
            nextCheckSeconds: { type: 'integer', description: '建议的审查间隔秒数（旧口径：proactive_set 的 after_seconds；现在仅供向后兼容）' },
            alarmPrompt: { type: 'string', description: '完整提示词（向后兼容保留：只有 enabled=false 时才需要用它挂 proactive_set）' },
            watchTool: { type: 'string', description: '醒来后要调用的工具名（恒为 flow_watch）' },
            enabled: { type: 'boolean', description: '内建 supervision 调度是否已在这个 run 上开启' },
            scheduler: anyJson('run.json.supervision 的只读快照（enabled / wakerSessionId / nextDueAt / wakes / failures / reason）；未开启为 null'),
            hint: { type: 'string', description: '给模型的一句话操作说明（已开启时不再要求挂 proactive_set）' },
          },
          required: ['nextCheckSeconds', 'alarmPrompt', 'watchTool'],
          additionalProperties: true,
        }),
      }, (args, value) => {
        if (!value || value.ok !== true) {
          const candidates = value && Array.isArray(value.candidates) && value.candidates.length > 0
            ? `\n候选：${value.candidates.join(' / ')}`
            : ''
          return [{ type: 'text', text: `启动失败：${value && value.error ? value.error : '未知错误'}${candidates}` }]
        }
        const on = Boolean(value.supervision && value.supervision.enabled === true)
        const next = on
          ? `下一步：内置 supervision 调度已开启（下次唤醒 ${value.supervision.nextDueAt || '稍后'}），到点会自动唤醒本会话；`
            + `醒来后调 flow_watch（runId=${value.runId}）复查即可，**不需要**再挂 proactive_set 闹钟。`
          : `下一步：内置调度没开启（${(value.supervision && value.supervision.hint) || '引擎不支持或登记失败'}）；`
            + `如需定时自审，用 proactive_set 的 after_seconds=${value.supervision ? value.supervision.nextCheckSeconds : watchSeconds} `
            + `挂上 supervision.alarmPrompt，之后每次醒来调 flow_watch（runId=${value.runId}）。`
        return [{
          type: 'text',
          text: `已在本会话启动 run ${value.runId}（流程「${value.flowName}」，状态 ${value.status}）。\n${next}`,
        }]
      }),
      timeoutMs: TIMEOUT_START_MS,
      async execute(args, exec) {
        let resolved
        try {
          resolved = await resolveFlow(deps, args)
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`解析流程失败：${messageOf(error)}`, '先调 flow_list 确认流程存在，再试一次。', true)
        }
        if (resolved.failure) return resolved.failure
        const flow = resolved.flow

        // 结构校验前移：不合法就不建 run，避免留下一个永远 pending 的目录。
        const validation = validateFlowForRun(flow)
        if (!validation.ok) {
          const detail = validation.errors.map(item => item.message).join('；')
          return failure(
            `流程不合法，不能开跑：${detail}`,
            '先到画布上修好流程（恰好一个开始节点、至少一个阶段节点、每条 next 恰好一条出边、打回目标必须是阶段节点），再启动。',
          )
        }
        // 07 §6：executor 的两条规则同样在开跑前拦住（校验器里没有，执行时才拦就太晚了）。
        const blockers = executorBlockers(flow)
        if (blockers.length > 0) {
          const detail = blockers.map(item => item.message).join('；')
          return failure(
            `流程里有非法的 executor 配置，不能开跑：${detail}`,
            '到节点检查器里修：custom 必须填 executorCommand；codex / custom 只允许「单个 agent」（team 需要引擎观察成员会话）。',
          )
        }
        // G6-a ②：custom executor 是宿主 RCE 面，默认关；开关由运维在主机级打开。
        const customBlocker = customExecutorBlockers(flow)
        if (customBlocker.length > 0) {
          return failure(
            `流程不能开跑：${customBlocker[0].message}`,
            `这是主机级安全开关（${CUSTOM_EXECUTOR_ENV}），调用方无法绕过；`
              + '要么让运维开启后重试，要么把节点改回内建 dsh / codex executor。',
          )
        }

        let runName
        let workspace
        let worktree
        let runTimeoutMs
        let nodeTimeoutMs
        try {
          const explicitName = optionalString(args, 'name', { max: 200 })
          const task = optionalString(args, 'task', { max: 2000 })
          runName = explicitName || (task ? clipChars(task, 200) : flow.name)
          // 07 §4.1：worktree 策略与 workspace。F2：workspace 必须显式可确定——
          // 显式参数优先，其次继承调用方会话的 cwd；两者都没有就失败，绝不悄悄回落到
          // 进程 cwd（那会让 run 在错误的仓库里开跑）。
          worktree = optionalEnum(args, 'worktree', WORKTREE_POLICIES)
          // G6-c：时限参数（可选正整数毫秒）；非法值在建 run 之前就是参数错误。
          runTimeoutMs = optionalInteger(args, 'runTimeoutMs', { min: 1, max: MAX_TIMEOUT_MS })
          nodeTimeoutMs = optionalInteger(args, 'nodeTimeoutMs', { min: 1, max: MAX_TIMEOUT_MS })
          const explicitWorkspace = optionalString(args, 'workspace', { max: 1000 })
          const candidate = explicitWorkspace !== undefined ? explicitWorkspace : workspaceOfSession(exec)
          if (candidate === undefined || candidate === '') {
            throw new ParamError(
              '缺少 workspace：本次运行没有可用的工作区（调用方会话也没有 cwd）',
              '显式传 workspace（工作区绝对路径），或从一个带工作目录的会话里启动；'
                + 'flow_start 不会回落到进程 cwd。',
            )
          }
          if (!isAbsolute(candidate)) {
            throw new ParamError(
              `workspace 必须是绝对路径：${clipChars(candidate, 200)}`,
              '传工作区的绝对路径（例如 /home/me/repo）；相对路径会被引擎拒绝。',
            )
          }
          // G6-a ③：配置了 workspace 白名单就必须落在其中（不配置则维持现状）。
          const allowlistReason = workspaceAllowlistReason(candidate)
          if (allowlistReason !== null) {
            throw new ParamError(
              allowlistReason,
              `workspace 必须落在 ${WORKSPACE_ROOTS_ENV} 配置的根目录内；`
                + '联系运维确认白名单，或改用允许的工作区。',
            )
          }
          workspace = candidate
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`读取参数失败：${messageOf(error)}`, '按参数说明改正后重发。')
        }

        const nodeTotal = (flow.nodes || []).filter(node => node.kind === NODE_KIND.STAGE).length

        let run
        try {
          run = await createRun(deps.runsRoot, {
            flowId: flow.id,
            flowName: flow.name,
            name: runName,
            nodeTotal,
            // 与 HTTP 建 run 同一口径：run.json.engine 从建 run 那一刻就带上。
            engine: engineName,
          })
        } catch (error) {
          return failureOf(error, { action: '创建 run ' })
        }

        // 07 §5：并发不设上限——不再有「同一时刻只允许一个 run」的前置判断。
        // 唯一的冲突是「同一个 runId 已在跑」（runtime.get(runId)）；新建的 runId 正常永远为
        // null，只有重复 / 复用 runId 的路径才会命中。文案保持可操作。
        const alreadyRunning = typeof deps.engine.get === 'function' ? deps.engine.get(run.id) : null
        if (alreadyRunning) {
          return failure(
            `同一 run 已在运行（${run.id}），不能重复启动`,
            '等它结束，或先调 flow_stop 停掉它，再重新 flow_start。',
            false,
            { runId: run.id },
          )
        }

        // 父会话 = 当前会话；workspace / worktree 一并交给 engine.start 裁决（07 §4.1）。
        // F2：workspace 到这里一定存在（上面缺了就失败），所以无条件带上。
        const parent = exec && exec.agent ? exec.agent : undefined
        const startOptions = { parent, workspace }
        if (worktree !== undefined) startOptions.worktree = worktree
        // G6-c：只带显式值；省略时交给引擎默认 / 环境变量（不在工具层替引擎写死）。
        if (runTimeoutMs !== undefined) startOptions.runTimeoutMs = runTimeoutMs
        if (nodeTimeoutMs !== undefined) startOptions.nodeTimeoutMs = nodeTimeoutMs
        let started
        try {
          started = await deps.engine.start(run.id, startOptions)
        } catch (error) {
          // 建出来的 run 可能停在 pending：把 runId 一并带回，模型知道要去 flow_watch 看一眼。
          return failureOf(error, { action: '启动 run ', extra: { runId: run.id } })
        }

        const status = started && typeof started.status === 'string' ? started.status : 'running'
        const runId = typeof run.id === 'string' ? run.id : started && typeof started.id === 'string' ? started.id : ''

        // 07 §7（R7）：模型工具起的 run **默认开启内建 supervision**——发起会话就是它的
        // 主 agent，到点由调度器唤醒它调 flow_watch 自查。失败只 warn，绝不让 flow_start 失败。
        const wakerSessionId = sessionIdOf(exec)
        let schedulerState = null
        if (typeof deps.engine.enableSupervision === 'function' && wakerSessionId !== null) {
          try {
            const registered = await deps.engine.enableSupervision(runId, { enabled: true, wakerSessionId })
            schedulerState = registered ? registered.scheduler || null : null
          } catch (error) {
            if (typeof deps.log === 'function') {
              deps.log('warn', `flow-studio: flow_start 自动开启 supervision 失败（${runId}）：${messageOf(error)}`)
            }
          }
        }
        const supervisionOn = Boolean(schedulerState && schedulerState.enabled === true)

        // 07 §4.1：workspace / worktree 由 engine 在 start 时裁决并写进 run.json；
        // engine.start 返回的就是 readRunMeta 结果（runstore 白名单已覆盖这两个键），
        // 这里只读回来展示（尚未裁决时回落请求值）。
        const decidedWorkspace = started && started.workspace && typeof started.workspace === 'object'
          ? started.workspace
          : null
        const decidedWorktree = started && started.worktree && typeof started.worktree === 'object'
          ? started.worktree
          : null
        return jsonSafe({
          ok: true,
          runId,
          flowId: flow.id,
          flowName: flow.name,
          status,
          workspace: {
            inheritedFrom: sessionIdOf(exec),
            path: decidedWorkspace && typeof decidedWorkspace.path === 'string'
              ? decidedWorkspace.path
              : (workspace ?? null),
            workspaceId: decidedWorkspace && typeof decidedWorkspace.id === 'string' ? decidedWorkspace.id : null,
            worktree: worktree ?? 'auto',
            worktreeEnabled: decidedWorktree ? decidedWorktree.enabled === true : null,
            worktreeReason: decidedWorktree && typeof decidedWorktree.reason === 'string'
              ? decidedWorktree.reason
              : null,
          },
          limits: {
            runTimeoutMs: runTimeoutMs ?? null,
            nodeTimeoutMs: nodeTimeoutMs ?? null,
            defaultRunTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
            defaultNodeTimeoutMs: DEFAULT_NODE_TIMEOUT_MS,
          },
          supervision: {
            nextCheckSeconds: watchSeconds,
            // 向后兼容：字段保留（客户端 / 旧调用方仍在读），只是不再是唯一路径。
            alarmPrompt: watchAlarmPrompt(runId, flow.name, watchSeconds),
            watchTool: 'flow_watch',
            enabled: supervisionOn,
            scheduler: schedulerState,
            hint: supervisionOn
              ? `内置 supervision 调度已开启：不需要再挂 proactive_set 闹钟，到点会自动唤醒你。`
                + `醒来后调 flow_watch（runId="${runId}"），healthy 就直接结束本轮，异常或跑完才通知主人。`
              : `内置 supervision 未能开启（引擎没有 enableSupervision 或登记失败）：退回到手动闹钟——`
                + `用 proactive_set 的 after_seconds=${watchSeconds} 挂上 supervision.alarmPrompt，`
                + `之后每次醒来调 flow_watch（runId="${runId}"）。`,
          },
        })
      },
    },

    // ── flow_watch ─────────────────────────────────────────────────────────
    {
      name: 'flow_watch',
      description:
        '审查「整个工作流是否在正常运转」（只读，不改任何状态、不自动修复、不自动停止）。'
        + '读 run.json + 事件 + 流程模板，调用审计模块给出 verdict / headline / progress / plan / '
        + 'currentNode / rejects / anomalies / quality / tokens / idleMs / recommended 等结论，'
        + '并附 supervision：运行中给出下次审查间隔、内建调度状态（scheduler）与向后兼容的闹钟提示词，'
        + 'verdict 为 done/failed/aborted 时 nextCheckSeconds 为 null、alarmPrompt 说明不必再挂闹钟。'
        + '另附调度器实时快照（schedulerSnapshot = engine.supervision.snapshot()、'
        + 'nodeSchedulerSnapshot = engine.nodeSupervision.snapshot()，老版本没有 snapshot() 时为 '
        + '{available:false, reason} 并标注「不可用」）与 health{timeouts, invalidReports, warnings}：'
        + '调度器超时 / 整轮 tick 停摆 / 节点自审回报格式错（lastReport.kind=invalid）会写进 '
        + 'recommended 与人类可读结论，不用翻原始 JSON。'
        + '典型用法：flow_start 之后内置 supervision 会自动唤醒本会话（不需要手动挂 proactive_set 闹钟），'
        + '每次醒来调本工具审查；verdict 正常就 proactive_reclaim 安静结束，异常或跑完才通知主人。'
        + `多 run 合并审查：传 runIds:[...]（≤${MAX_WATCH_RUNS} 个，去重），一次返回 runs[]（每个 run 一份结论，`
        + '字段与单 run 相同）与 merged（合并建议：verdicts / recommended / terminal / nextCheckSeconds / alarmPrompt）；'
        + `内部对每个 run 只读一次事件并复用，runId 与 runIds 只能二选一。`
        + 'runId 省略时取最近一次 run（按 startedAt 倒序）。',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '要审查的单个 run id；省略 = 最近一次 run。与 runIds 二选一' },
          runIds: {
            type: 'array',
            items: { type: 'string' },
            description: `一次审查多个 run（可选，去重后 ≤${MAX_WATCH_RUNS} 个）；`
              + '返回每个 run 一份结论 + 一份合并建议。与 runId 二选一；超过上限会失败并要求分批',
          },
        },
        required: [],
      },
      output: outputFor({
        runs: {
          type: 'array',
          description: '多 run 模式下的逐 run 结论（每项字段与单 run 相同；不存在的 run 是 ok:false + error/hint）',
          items: anyJson('单个 run 的审查结论（含 runId / verdict / supervision）'),
        },
        merged: anyJson(
          '多 run 合并建议：{total, ok, failed, verdicts, recommended[], terminal, nextCheckSeconds, '
          + 'alarmPrompt, watchTool, runIds[]}；只在 runIds 模式下出现' ,
        ),
        runId: nullable({ type: 'string', description: '本次审查的 run id' }),
        flowId: nullable({ type: 'string', description: '该 run 使用的流程 id' }),
        verdict: nullable({ type: 'string', description: '审计结论（如 healthy / done / failed / aborted / stalled / degraded）' }),
        status: nullable({ type: 'string', description: 'run.json.status' }),
        headline: nullable({ type: 'string', description: '一句话结论（人类可读）' }),
        // 审计字段的形状由 audit.js 决定（另一条工作流并行实现），这里用宽松 schema
        // 只声明「字段存在」，避免形状差异让注册表的逐值校验直接拒绝合法结果。
        progress: anyJson('进度摘要（对象；审计模块原样返回）'),
        plan: anyJson('剩余计划（通常是节点数组；审计模块原样返回）'),
        currentNode: anyJson('当前节点（对象或 null；审计模块原样返回）'),
        rejects: anyJson('打回统计（对象；审计模块原样返回）'),
        anomalies: anyJson('异常列表（通常是数组；审计模块原样返回）'),
        quality: anyJson('质量摘要（对象；审计模块原样返回）'),
        tokens: anyJson('用量摘要（对象；审计模块原样返回）'),
        idleMs: nullable({ type: 'integer' }, '距最近一次事件的毫秒数'),
        recommended: anyJson('建议动作（只报告，是否执行由模型决定）'),
        nodeStatus: anyJson(
          '各节点最新自审状态（nodeId → {state, progress, summary, verdict, members, blockers, at}；'
          + '来自 run.json.nodeStatus，缺省为空对象 {}。state=blocked 且连续两次 progress 不变时，'
          + 'recommended 里会多一句提示）',
        ),
        supervision: {
          type: 'object',
          description: '定时自审信号 + 调度器实时健康度：运行中给间隔与闹钟提示词，终态给 null 与「不必再挂」说明',
          properties: {
            nextCheckSeconds: nullable({ type: 'integer' }, '下次审查间隔秒数；终态为 null（不必再挂闹钟）'),
            alarmPrompt: { type: 'string', description: '给 proactive_set 的完整提示词' },
            watchTool: { type: 'string', description: '审查工具名（恒为 flow_watch）' },
            scheduler: anyJson('run.json.supervision 的只读快照（内建调度：enabled / wakerSessionId / lastWokeAt / nextDueAt / wakes / failures / reason；未开启为 null）'),
            // 新增：调度器实时快照（run 级 / 节点级）。缺 snapshot() 时是
            // { available:false, reason }，明确标注「不可用」而不是空对象。
            schedulerSnapshot: anyJson(
              'run 级调度器 engine.supervision.snapshot() 的宽松透传：'
              + '{available, snapshot?{ticking,started,intervalMs,wakeTimeoutMs,concurrency,'
              + 'tick{count,skipped,lastStartedAt,lastFinishedAt,lastDurationMs,lastStats},'
              + 'entries[{runId,lastOutcome,lastDurationMs,lastFinishedAt,timeouts,lastError,...}]}}；'
              + '不可用时 {available:false, reason}',
            ),
            nodeSchedulerSnapshot: anyJson(
              '节点级调度器 engine.nodeSupervision.snapshot() 的宽松透传：形状同上，'
              + 'entries[] 额外带 lastReport{kind,reason,at}；不可用时 {available:false, reason}',
            ),
            health: {
              type: 'object',
              description: '调度器健康度（同时会并入 recommended 与人类可读结论）：'
                + 'timeouts / invalidReports / warnings 之外，G7-a 增加 run 级累计计数；'
                + '限流 / 合并唤醒 / 恢复扫描非零时这些文字会进 recommended',
              properties: {
                timeouts: { type: 'integer', description: 'run 级调度器累计超时次数（跨 entry 求和）' },
                invalidReports: { type: 'integer', description: '节点自审回报格式不合规（invalid）的条数' },
                // G7-a：发起会话唤醒预算 / 合并唤醒（runtime 级累计，缺省 0）。
                wokenThisHour: {
                  type: 'integer',
                  description: 'run 级调度器最近一小时内成功唤醒发起会话的次数（跨会话求和；缺省 0）',
                },
                throttled: {
                  type: 'integer',
                  description: '发起会话唤醒被限流（小时预算 / 最小间隔）的次数（累计；缺省 0）',
                },
                coalesced: {
                  type: 'integer',
                  description: '同一发起会话多条到期 run 被合并成一次唤醒的 run 数（累计；缺省 0）',
                },
                // G7-b：节点闹钟重启恢复扫描统计；节点级调度器不可用时为 null。
                recovery: anyJson(
                  '节点闹钟重启恢复扫描统计 {at, scans, runsScanned, runsRecovered, restored, '
                    + 'skipped, skippedTerminal, missingSession, missingAttempt, alreadyRegistered}；'
                    + '节点级调度器不可用 / 老版本没有该字段时为 null',
                ),
                warnings: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '可读告警（超时 / 停摆 / invalid 回报）；为空表示没发现这类信号'
                    + '（限流 / 合并唤醒 / 恢复扫描在非零时进 recommended，不混进 warnings）',
                },
              },
              required: ['timeouts', 'invalidReports', 'warnings'],
              additionalProperties: true,
            },
          },
          required: ['alarmPrompt', 'watchTool'],
          additionalProperties: true,
        },
      }, (args, value) => {
        if (!value || value.ok !== true) return renderJson(value)
        // G6-d：多 run 模式的人话投影（逐 run 一行 + 合并建议）。
        if (Array.isArray(value.runs)) {
          const lines = value.runs.map(item => {
            if (!item || item.ok !== true) {
              return `- ${item && item.runId ? item.runId : '(未知)'}：失败 — ${item && item.error ? item.error : '未知错误'}`
            }
            const head = item.headline ? ` — ${item.headline}` : ''
            return `- ${item.runId}：${item.verdict || item.status || 'unknown'}${head}`
          })
          const merged = value.merged && typeof value.merged === 'object' ? value.merged : {}
          const advice = Array.isArray(merged.recommended) && merged.recommended.length > 0
            ? `\n合并建议：\n  - ${merged.recommended.join('\n  - ')}`
            : ''
          const next = merged.terminal
            ? '\n全部到终态：不必再挂闹钟，proactive_reclaim 结束本轮。'
            : `\n建议 ${merged.nextCheckSeconds} 秒后再次审查（flow_watch runIds=${JSON.stringify(merged.runIds || [])}）。`
          return [{
            type: 'text',
            text: `审查 ${value.runs.length} 个 run：\n${lines.join('\n')}${advice}${next}`,
          }]
        }
        const head = value.headline ? value.headline : '（审计未给出结论摘要）'
        const lines = [`run ${value.runId}：${value.verdict || value.status || 'unknown'} — ${head}`]
        if (value.currentNode && value.currentNode.title) lines.push(`当前节点：${value.currentNode.title}`)
        if (Array.isArray(value.anomalies) && value.anomalies.length > 0) lines.push(`异常 ${value.anomalies.length} 条`)
        if (value.supervision && value.supervision.nextCheckSeconds === null) {
          lines.push('已到终态：不必再挂闹钟，proactive_reclaim 结束本轮。')
        } else if (value.supervision) {
          lines.push(`建议 ${value.supervision.nextCheckSeconds} 秒后再次审查。`)
        }
        // 07 §7：内建 supervision 的落盘状态（只读）也进人类可读投影。
        const scheduler = value.supervision && value.supervision.scheduler
        if (scheduler && scheduler.enabled === true) {
          const wakes = Number.isInteger(scheduler.wakes) ? scheduler.wakes : 0
          const due = typeof scheduler.nextDueAt === 'string' ? scheduler.nextDueAt : '待定'
          lines.push(`内建调度：开启（已唤醒 ${wakes} 次，下次 ${due}）。`)
        }
        // 调度器超时 / 停摆 / 自审回报格式错：必须出现在可读结论里，不能只埋在 JSON 深处。
        const health = value.supervision && value.supervision.health
        if (health && Array.isArray(health.warnings) && health.warnings.length > 0) {
          lines.push(`调度器健康：${health.warnings.join('；')}`)
        } else {
          const runSnapshot = value.supervision && value.supervision.schedulerSnapshot
          const nodeSnapshot = value.supervision && value.supervision.nodeSchedulerSnapshot
          if (runSnapshot && runSnapshot.available === false) lines.push(`调度器快照：run 级不可用（${runSnapshot.reason || '原因未知'}）。`)
          if (nodeSnapshot && nodeSnapshot.available === false) lines.push(`调度器快照：节点级不可用（${nodeSnapshot.reason || '原因未知'}）。`)
        }
        // G7-a / G7-b：限流 / 合并唤醒 / 恢复扫描——只报非零，健康时不刷噪音。
        if (health) {
          if (Number.isInteger(health.throttled) && health.throttled > 0) {
            lines.push(`发起会话唤醒被限流 ${health.throttled} 次。`)
          }
          if (Number.isInteger(health.coalesced) && health.coalesced > 0) {
            lines.push(`合并 ${health.coalesced} 个 run 为一次唤醒。`)
          }
          const restored = health.recovery && Number.isInteger(health.recovery.restored)
            ? health.recovery.restored
            : 0
          if (restored > 0) {
            lines.push(`节点闹钟恢复扫描恢复了 ${restored} 个 run 的定时自审。`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      }),
      timeoutMs: TIMEOUT_WATCH_MS,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        let requested
        let requestedList
        try {
          requested = optionalString(args, 'runId', { max: 128 })
          if (requested !== undefined && !checkRunId(requested)) {
            throw new ParamError(
              `runId「${requested}」不合法（只允许字母、数字、点、下划线、连字符，1–64 位）`,
              'runId 来自 flow_start 的返回值；省略则审查最近一次 run。',
            )
          }
          requestedList = optionalRunIdList(args, 'runIds', MAX_WATCH_RUNS)
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`读取参数失败：${messageOf(error)}`, '按参数说明改正后重发。')
        }
        if (requested !== undefined && requestedList !== undefined) {
          return failure(
            '参数 runId 与 runIds 只能二选一',
            '审查单个 run 传 runId；一次审查多个传 runIds:[...]。',
          )
        }

        try {
          // G6-d：多 run 合并审查。每个 run 的事件只读一次（eventCache 复用），
          // 单个 run 审查失败不会拖垮整批。
          if (requestedList !== undefined) {
            const eventCache = new Map()
            const results = []
            for (const id of requestedList) {
              const context = await loadWatchContext(id, eventCache)
              if (context.failure) {
                results.push({ ...context.failure, runId: id })
                continue
              }
              try {
                results.push(await auditRunContext(context))
              } catch (error) {
                results.push(failure(
                  `审查 run ${id} 失败：${messageOf(error)}`,
                  '先看其他 run 的结论；这一个稍后重试，仍失败就告诉主人。',
                  false,
                  { runId: id },
                ))
              }
            }
            return jsonSafe({
              ok: true,
              mode: 'multi',
              runs: results,
              merged: mergeWatchResults(results),
            })
          }

          let runId = requested
          if (runId === undefined) {
            const listed = await listRuns(deps.runsRoot, { limit: 1 })
            const latest = Array.isArray(listed.runs) && listed.runs.length > 0 ? listed.runs[0] : null
            if (!latest) {
              return failure('还没有任何 run，无法审查', '先用 flow_start 启动一个流程（或先 flow_list 选流程）。')
            }
            runId = latest.id
          }

          // 单 run：与多 run 共用同一份读取 / 审计实现，返回形状保持既有契约。
          const context = await loadWatchContext(runId, new Map())
          if (context.failure) return context.failure
          return await auditRunContext(context)
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          const status = error && Number.isInteger(error.status) ? error.status : null
          if (status === 400 || status === 404) return failureOf(error, { action: '审查 run ' })
          // 审计模块缺失 / 抛错：属于实现或部署问题，重试同一份请求通常也不会变。
          return failure(
            `审查失败：${messageOf(error)}`,
            '如果提示 src/audit.js 不存在，说明审计模块还没落地；其余情况先 flow_watch 重试一次，仍失败就告诉主人。',
            false,
          )
        }
      },
    },

    // ── flow_stop ──────────────────────────────────────────────────────────
    {
      name: 'flow_stop',
      description:
        '停止一次正在运行的流程 run（写操作，会 abort 在飞请求并写 run/end{status:"aborted"}）。'
        + 'runId 必填，来自 flow_start 或 flow_watch。run 不在运行中（已结束 / 不存在 / 不是当前进程启动的）会失败，'
        + 'hint 会写「这个 run 不在运行中」；停止后建议再调一次 flow_watch 复核终态，然后 proactive_reclaim 结束本轮。'
        + '本工具只停止，不做清理（run 的日志与产物保留）。',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '要停止的 run id（必填，来自 flow_start / flow_watch）' },
        },
        required: ['runId'],
      },
      output: outputFor({
        runId: { type: 'string', description: '被停止的 run id' },
        status: nullable({ type: 'string', description: '停止后的 run 状态（通常为 aborted）' }),
      }, (args, value) => {
        if (!value || value.ok !== true) return renderJson(value)
        return [{ type: 'text', text: `已停止 run ${value.runId}（状态 ${value.status}）。` }]
      }),
      timeoutMs: TIMEOUT_STOP_MS,
      async execute(args) {
        let runId
        try {
          runId = optionalString(args, 'runId', { max: 128 })
          if (runId === undefined) {
            throw new ParamError('缺少必填参数 runId', '传 flow_start 返回的 runId；不知道就用 flow_watch 省略 runId 查最近一次 run。')
          }
          if (!checkRunId(runId)) {
            throw new ParamError(
              `runId「${runId}」不合法（只允许字母、数字、点、下划线、连字符，1–64 位）`,
              'runId 来自 flow_start 的返回值，原样传。',
            )
          }
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`读取参数失败：${messageOf(error)}`, '按参数说明改正后重发。')
        }

        try {
          const meta = await deps.engine.stop(runId)
          const status = meta && typeof meta.status === 'string' ? meta.status : 'aborted'
          return jsonSafe({ ok: true, runId, status })
        } catch (error) {
          const status = error && Number.isInteger(error.status) ? error.status : null
          if (status === 409) {
            return failure(
              messageOf(error),
              '这个 run 不在运行中：可能已经结束，或不是当前进程启动的。用 flow_watch 看它当前状态。',
            )
          }
          if (status === 400) return failureOf(error, { action: '停止 run ' })
          return failure(
            `停止 run 失败：${messageOf(error)}`,
            '稍后重试一次；仍失败就告诉主人（可能引擎已中断但 run.json 还没收尾）。',
            true,
          )
        }
      },
    },

    // ── flow_restart（v0.9.2 · 任务 3：失败后重启并在原会话续跑） ──────────
    {
      name: 'flow_restart',
      description:
        '把一次**已失败 / 已中止**的流程 run 重启为**新 run**，并从旧 run 失败 / 中止的节点继续。'
        + '新 run 继承旧 run 的节点会话（同一 node 复用原 sessionId，冷会话靠 agents.resume 续跑）、'
        + '跳过已完成节点（用它们的 summary 作为上游上下文），旧 run 保持终态、事件一个字不改。'
        + 'runId 必填（旧 run）；note 可选（写进新 run 的 restart 记录，例如为什么重启）。'
        + '只接受 failed / aborted：pending / running 先等收尾或 flow_stop；done 不需要重启。'
        + '成功返回新 run（newRunId）与 restart{fromRunId, attempt, startNodeId, skippedNodeIds, ...}；'
        + '失败时 error/hint 给出中文原因（非终态 run / 流程结构不合法 / 会话无法继承）。',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '旧 run 的 id（必须是 failed / aborted）' },
          note: { type: 'string', description: '可选：重启原因 / 备注（≤500 字符，写进新 run 的 restart 记录）' },
        },
        required: ['runId'],
      },
      output: outputFor({
        fromRunId: { type: 'string', description: '被重启的旧 run id' },
        newRunId: { type: 'string', description: '新建的续跑 run id' },
        status: nullable({ type: 'string', description: '新 run 当前状态（通常为 running）' }),
        restart: anyJson('续跑记录：{fromRunId, attempt, oldStatus, oldReason, startNodeId, skippedNodeIds, inheritedNodeIds, note?}'),
        plan: anyJson('实际执行的续跑计划：{startNodeId, skipped[], inherited[]}'),
      }, (args, value) => {
        if (!value || value.ok !== true) return renderJson(value)
        const skipped = value.plan && Array.isArray(value.plan.skipped) ? value.plan.skipped : []
        return [{
          type: 'text',
          text: `已从 ${value.fromRunId} 创建续跑 run ${value.newRunId}（状态 ${value.status}）。`
            + `起点 ${value.plan && value.plan.startNodeId ? value.plan.startNodeId : '未知'}，`
            + `跳过 ${skipped.length} 个已完成节点。旧 run 终态未被改写。`,
        }]
      }),
      timeoutMs: TIMEOUT_STOP_MS,
      async execute(args) {
        let runId
        let note
        try {
          runId = optionalString(args, 'runId', { max: 128 })
          if (runId === undefined) {
            throw new ParamError(
              '缺少必填参数 runId',
              '传旧 run 的 id（failed / aborted）；不知道就用 flow_list / flow_watch 查。',
            )
          }
          if (!checkRunId(runId)) {
            throw new ParamError(
              `runId「${runId}」不合法（只允许字母、数字、点、下划线、连字符，1–64 位）`,
              'runId 来自 flow_start / flow_watch 的返回值，原样传。',
            )
          }
          note = optionalString(args, 'note', { max: 500 })
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`读取参数失败：${messageOf(error)}`, '按参数说明改正后重发。')
        }
        if (typeof deps.engine.restart !== 'function') {
          return failure(
            '当前运行时没有 restart 能力（运行时未升级 / 旧版本）',
            '升级 dsh-flow-studio 到包含 restart 的版本后再试；旧 run 的进度不会因此丢失。',
          )
        }
        try {
          const result = await deps.engine.restart(runId, note === undefined ? {} : { note })
          const run = result && result.run ? result.run : null
          return jsonSafe({
            ok: true,
            fromRunId: runId,
            newRunId: run && typeof run.id === 'string' ? run.id : '',
            status: run && typeof run.status === 'string' ? run.status : 'running',
            restart: result && result.restart ? result.restart : null,
            plan: result && result.plan ? result.plan : null,
          })
        } catch (error) {
          const status = error && Number.isInteger(error.status) ? error.status : null
          if (status === 400) {
            return failureOf(error, { action: '重启 run ' })
          }
          if (status === 404) {
            return failure(messageOf(error), '先 flow_watch 确认这个 run 存在，再重启。')
          }
          if (status === 503) {
            return failure(
              messageOf(error),
              '宿主 agents 服务不可用 / 旧会话无法 resume：恢复服务后再重启，或从画布另建全新 run。',
            )
          }
          return failure(
            `重启 run 失败：${messageOf(error)}`,
            '稍后重试一次；仍失败就告诉主人（旧 run 不会被改写，可先导出日志排查）。',
            true,
          )
        }
      },
    },

    // ── flow_supervise ─────────────────────────────────────────────────────
    {
      name: 'flow_supervise',
      description:
        '开关一个 run 的**内建 supervision 调度**（07 §7；不用外部插件、不用自己挂定时器）。'
        + 'enabled=true → 登记这个 run，调度器按审计结论定时唤醒发起会话（健康 180s / 异常 60s / pending 30s，'
        + '连续 3 次唤醒失败自动降级关闭）；enabled=false → 摘除登记并落盘 enabled=false。'
        + '唤醒目标是**调用本工具的会话**（当前会话 id），所以要在你想被唤醒的那个会话里调它。'
        + '返回调度状态（enabled / nextDueAt / wakes / failures / lastReason）与 run.json.supervision 的落盘结果。'
        + '只读的当前状态用 flow_watch 的 supervision.scheduler 看。',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '要开关调度的 run id（必填，来自 flow_start / flow_watch）' },
          enabled: { type: 'boolean', description: 'true 开启内建调度；false 关闭（并落盘 enabled=false）' },
        },
        required: ['runId', 'enabled'],
      },
      output: outputFor({
        runId: { type: 'string', description: '被开关调度的 run id' },
        enabled: { type: 'boolean', description: '本次操作后调度是否开启' },
        supervision: nullable({
          type: 'object',
          description: 'run.json.supervision 的落盘结果（只读展示）',
          properties: {
            enabled: { type: 'boolean', description: '是否仍在调度' },
            wakerSessionId: nullable({ type: 'string' }, '被唤醒的发起会话 id'),
            lastWokeAt: nullable({ type: 'string' }, '上次唤醒时间（ISO 8601）'),
            nextDueAt: nullable({ type: 'string' }, '下次唤醒时间（ISO 8601）'),
            wakes: { type: 'integer', description: '累计成功唤醒次数' },
            failures: { type: 'integer', description: '连续失败次数（达到 3 次降级）' },
            reason: nullable({ type: 'string' }, '停用 / 降级原因（如 terminal / wake-failed: ...）'),
          },
          additionalProperties: true,
        }),
        scheduler: anyJson('调度器的内存状态（enabled / nextDueAt / wakes / failures / lastReason）'),
      }, (args, value) => {
        if (!value || value.ok !== true) return renderJson(value)
        return [{
          type: 'text',
          text: value.enabled
            ? `已开启 run ${value.runId} 的内建定时自审（下次 ${value.supervision && value.supervision.nextDueAt ? value.supervision.nextDueAt : '由调度器决定'}）。`
            : `已关闭 run ${value.runId} 的内建定时自审。`,
        }]
      }),
      timeoutMs: TIMEOUT_REPLY_MS,
      async execute(args, exec) {
        let runId
        let enabled
        try {
          runId = optionalString(args, 'runId', { max: 128 })
          if (runId === undefined) {
            throw new ParamError('缺少必填参数 runId', '传 flow_start 返回的 runId；不知道就用 flow_watch 省略 runId 查最近一次 run。')
          }
          if (!checkRunId(runId)) {
            throw new ParamError(
              `runId「${runId}」不合法（只允许字母、数字、点、下划线、连字符，1-64 位）`,
              'runId 来自 flow_start 的返回值，原样传。',
            )
          }
          const raw = argsOf(args).enabled
          if (typeof raw !== 'boolean') {
            throw new ParamError('参数 enabled 必须是布尔值', '开启传 true，关闭传 false。')
          }
          enabled = raw
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`读取参数失败：${messageOf(error)}`, '按参数说明改正后重发。')
        }

        // 与 HTTP 端点共用 runtime.enableSupervision（登记 + 落盘只有一份实现）；
        // 注入的假引擎没有它就退回本地实现（测试 / 旧调用方）。
        const sharedEnable = typeof deps.engine.enableSupervision === 'function'
        const scheduler = deps.engine && deps.engine.supervision
        if (!sharedEnable && (!scheduler
          || typeof scheduler.register !== 'function'
          || typeof scheduler.unregister !== 'function')) {
          return failure(
            '内建 supervision 调度不可用（引擎不是 runtime 门面）',
            '确认 Host 侧已按 07 §7 起 runtime（engine.enableSupervision / engine.supervision）；这不是参数问题，重发同一请求不会变。',
          )
        }
        const meta = await readRunMeta(deps.runsRoot, runId)
        if (!meta) {
          return failure(`run 不存在：${runId}`, '用 flow_watch 确认 runId；省略 runId 则审查最近一次 run。')
        }
        // 07 §7：已收尾的 run 登记进去也永远不会被唤醒（planWake 的 terminal 分支直接停），
        // 所以 enable 直接拒绝，不制造一个「开着但不会响」的假象。
        if (enabled && TERMINAL_VERDICTS.has(meta.status)) {
          return failure(
            `run 已结束（${meta.status}），不能开启 supervision`,
            '已收尾的 run 不需要定时自审；要自审就用 flow_start 起一个新 run，再对它开启。',
            false,
            { runId },
          )
        }

        const wakerSessionId = sessionIdOf(exec)
        if (enabled && !wakerSessionId) {
          return failure(
            '拿不到当前会话 id，无法确定「到点唤醒谁」',
            'flow_supervise 必须在会话里调用；或改用 POST /runs/<id>/supervision 并显式传 wakerSessionId。',
          )
        }

        let result
        try {
          if (sharedEnable) {
            result = await deps.engine.enableSupervision(runId, enabled
              ? { enabled: true, wakerSessionId }
              : { enabled: false })
          } else if (enabled) {
            scheduler.register(runId, { wakerSessionId })
            const saved = await saveSupervision(deps.runsRoot, runId, {
              enabled: true,
              wakerSessionId,
              reason: null,
              failures: 0,
            })
            result = {
              runId,
              enabled: true,
              supervision: saved,
              scheduler: typeof scheduler.status === 'function' ? scheduler.status(runId) : null,
            }
          } else {
            scheduler.unregister(runId)
            const saved = await saveSupervision(deps.runsRoot, runId, { enabled: false, reason: 'disabled-by-caller' })
            result = {
              runId,
              enabled: false,
              supervision: saved,
              scheduler: typeof scheduler.status === 'function' ? scheduler.status(runId) : null,
            }
          }
        } catch (error) {
          const status = error && Number.isInteger(error.status) ? error.status : null
          if (status === 400 || status === 404) return failureOf(error, { action: '开关 supervision ' })
          // 写盘失败（权限 / 目录被删的竞态）：调度器内存状态已改，如实报错而不是假装成功。
          return failure(
            `开关 supervision 失败：${messageOf(error)}`,
            '调度器内存状态可能已变更；稍后重试一次，仍失败就告诉主人（run.json 可能不可写）。',
            true,
            { runId },
          )
        }
        if (!result || !result.supervision) {
          return failure(`run 不存在：${runId}`, 'run.json 读不到；用 flow_watch 确认这个 run 还在。')
        }
        return jsonSafe({
          ok: true,
          runId,
          enabled: result.enabled,
          supervision: result.supervision,
          scheduler: result.scheduler ?? null,
        })
      },
    },

    // ── flow_send_message ──────────────────────────────────────────────────
    ...(inboxToolsEnabled ? [
    {
      name: 'flow_send_message',
      description:
        '给一个流程 run 的收件箱发一条外部消息（与 Web 面板的 POST /runs/<id>/messages 是同一条内部逻辑）。'
        + '目标节点：nodeId 显式指定（必须是阶段节点）→ 否则取 run 当前节点 → 否则（pending）入口节点。'
        + '投递方式由引擎现状决定：目标节点已有活会话 → 立即注入（injected）；只有冷会话 → resume 后注入（resumed）；'
        + 'run 还没开始 → 作为本 run 的启动输入（started）；run 在跑但节点还没到 → 入队，等引擎推进到该节点时并入提示词（queued）。'
        + '省略 runId 时取当前会话启动的最新 run，再退回最近一次 run。reply 可选：指定节点回消息时要发给谁'
        + '（session 会话 / http 回调地址 / none 只记日志；http 的 url 只允许 https 或回环地址上的 http，'
        + `tokenEnv 只接受 ${REPLY_TOKEN_ENV_PREFIX}* 形式的专用环境变量名）。`,
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '目标 run id；省略 = 当前会话启动的最新 run，再退回最近一次 run' },
          nodeId: { type: 'string', description: '目标阶段节点 id（可选；不传则按「当前节点 → 入口节点」推断）' },
          text: { type: 'string', description: `消息正文（必填）。无实际长度限制：≤1200 字直接进节点提示词；更长的正文会落盘（inbox/<messageId>.md），提示词里给出全文路径，节点会自己读完。硬上限 ${MESSAGE_BODY_HARD_MAX_CHARS} 字，超过直接报错而不是截断。` },
          reply: {
            type: 'object',
            description: '节点回复消息时要投递到的目标（可选）',
            properties: {
              kind: { type: 'string', enum: ['session', 'http', 'none'], description: '回复通道：会话 / HTTP 回调 / 不回复' },
              sessionId: { type: 'string', description: 'kind=session 时的目标会话 id' },
              url: {
                type: 'string',
                description: 'kind=http 时的回调地址：只允许 https，或回环地址（127.0.0.1 / ::1 / localhost）上的 http；'
                  + '不允许带用户名密码（user:pass@）',
              },
              tokenEnv: {
                type: 'string',
                description: `kind=http 时从哪个环境变量取 Bearer 令牌（只写变量名，不落盘）：`
                  + `只接受 ${REPLY_TOKEN_ENV_PREFIX}<后缀> 形式（前缀大小写敏感，后缀只用大写字母 / 数字 / 下划线）；`
                  + '其它变量名一律拒绝',
              },
            },
            required: ['kind'],
            additionalProperties: false,
          },
        },
        required: ['text'],
      },
      output: outputFor({
        runId: { type: 'string', description: '实际投递到的 run id' },
        messageId: { type: 'string', description: '这条入站消息的 id（后续 inReplyTo 用它）' },
        targetNodeId: { type: 'string', description: '解析出的目标阶段节点 id' },
        mode: {
          type: 'string',
          description: '投递方式：injected（活会话注入）/ resumed（冷会话 resume 后注入）/ started（作为启动输入）/ queued（入队）',
        },
        sessionId: nullable({ type: 'string' }, '目标节点的会话 id（started / queued 时为空，表示还没有会话）'),
      }, (args, value) => {
        if (!value || value.ok !== true) return renderJson(value)
        return [{
          type: 'text',
          text: `消息 ${value.messageId} 已投递到 run ${value.runId} 的节点 ${value.targetNodeId}（${value.mode}）。`,
        }]
      }),
      timeoutMs: TIMEOUT_SEND_MS,
      async execute(args, exec) {
        let text
        let nodeId
        let reply
        try {
          text = optionalString(args, 'text', { max: MESSAGE_BODY_HARD_MAX_CHARS })
          if (text === undefined) {
            throw new ParamError('缺少必填参数 text', '传要发进流程的消息正文（≤4000 字符）。')
          }
          nodeId = optionalString(args, 'nodeId', { max: 64 })
          if (nodeId !== undefined && !checkRunId(nodeId)) {
            throw new ParamError(
              `nodeId「${nodeId}」不合法（只允许字母、数字、点、下划线、连字符）`,
              'nodeId 是流程里的阶段节点 id；不确定就从 run 详情里看。',
            )
          }
          const rawReply = argsOf(args).reply
          if (rawReply !== undefined && rawReply !== null) {
            // F1：tokenEnv 白名单 + url 白名单（https 或回环 http），不再放行任意环境变量。
            const validated = validateReplyTargetStrict(rawReply)
            if (!validated.ok) {
              throw new ParamError(
                validated.error,
                '按参数说明改正 reply：kind 必填；http 的 url 只允许 https 或回环地址（127.0.0.1 / ::1 / localhost）上的 http，'
                  + `tokenEnv 只接受 ${REPLY_TOKEN_ENV_PREFIX}<后缀> 形式的环境变量名；`
                  + 'kind=session 必须给非空 sessionId。',
              )
            }
            reply = validated.reply
          }
          const requestedRunId = optionalString(args, 'runId', { max: 128 })
          const runId = await resolveRunId(deps, exec, requestedRunId)
          const sessionId = sessionIdOf(exec)
          const delivered = await deliverInboundMessage({
            runsRoot: deps.runsRoot,
            flowsRoot: deps.flowsRoot,
            engine: deps.engine,
            ctx: deps.ctx,
            log: deps.log,
          }, runId, {
            from: sessionId ? clipChars(`agent:${sessionId}`, 200) : 'agent:unknown',
            text,
            ...(nodeId === undefined ? {} : { nodeId }),
            ...(reply === undefined ? {} : { reply }),
          })
          return jsonSafe({
            ok: true,
            runId,
            messageId: delivered.messageId,
            targetNodeId: delivered.targetNodeId,
            mode: delivered.mode,
            sessionId: delivered.sessionId ?? null,
          })
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          const status = error && Number.isInteger(error.status) ? error.status : null
          if (status === 409) {
            return failure(
              `投递失败：${messageOf(error)}`,
              'run 已结束就不能再收消息；用 flow_watch 看它的状态，必要时用 flow_start 新开一个 run。',
            )
          }
          if (status === 400 || status === 404) return failureOf(error, { action: '发送消息 ' })
          return failure(
            `发送消息失败：${messageOf(error)}`,
            '如果是暂时性故障可以重试一次；仍失败就告诉主人。',
            true,
          )
        }
      },
    },

    // ── flow_reply ─────────────────────────────────────────────────────────
    {
      name: 'flow_reply',
      description:
        '在流程节点会话里给「把消息发进流程的来源」回一条消息（外部消息的返回通道）。'
        + '这个工具只对**属于某个流程 run 的节点会话**有效：会话 id 查不到对应 run/节点时直接失败。'
        + '回复目标优先级：消息级 reply（inReplyTo 指向的那条入站消息的配置）> run.json 的 inbox.reply > 未配置。'
        + 'session 目标直接投进会话（活会话 followup / 冷会话 resume）；http 目标 POST 到回调地址'
        + '（tokenEnv 指向的环境变量作为 Bearer，超时 10s，失败不抛异常）；未配置 / none 只记 message/out 事件，'
        + '返回值 ok:true 并由 hint 说明「没有外部回复通道，已记录在运行日志」。'
        + '安全边界：已保存的 http 回复通道同样要过白名单——url 只允许 https 或回环地址上的 http，'
        + `tokenEnv 只接受 ${REPLY_TOKEN_ENV_PREFIX}*；不合规的通道会被拒绝投递（令牌值永远打码）。`
        + '正文前会自动加来源标记 [flow:<流程名> · <节点标题>]。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '回复正文（必填，≤4000 字符，超过按码点截断）' },
          inReplyTo: { type: 'string', description: '要回复的入站消息 id（可选；用于选中该消息自己的 reply 配置）' },
        },
        required: ['text'],
      },
      output: outputFor({
        runId: { type: 'string', description: '这条回复所属的 run id' },
        messageId: { type: 'string', description: '这条回复的 id（message/out 事件的 id）' },
        inReplyTo: nullable({ type: 'string' }, '被回复的入站消息 id'),
        nodeId: nullable({ type: 'string' }, '发起回复的节点 id'),
        delivery: { type: 'string', description: '实际回复通道：session / http / local（未配置时只记日志）/ blocked（回复通道不合规被拒绝）' },
        sessionId: nullable({ type: 'string' }, 'kind=session 时的目标会话 id'),
        httpStatus: nullable({ type: 'integer' }, 'kind=http 时的 HTTP 状态码'),
      }, (args, value) => {
        if (!value || value.ok !== true) return renderJson(value)
        return [{
          type: 'text',
          text: `回复已记录（${value.delivery}${value.httpStatus ? ` / HTTP ${value.httpStatus}` : ''}）。`
            + (value.hint ? `\n${value.hint}` : ''),
        }]
      }),
      timeoutMs: TIMEOUT_REPLY_MS,
      async execute(args, exec) {
        let text
        let inReplyTo
        try {
          text = optionalString(args, 'text', { max: MESSAGE_BODY_HARD_MAX_CHARS })
          if (text === undefined) {
            throw new ParamError('缺少必填参数 text', `传要回复的正文（硬上限 ${MESSAGE_BODY_HARD_MAX_CHARS} 字）。`)
          }
          inReplyTo = optionalString(args, 'inReplyTo', { max: 128 })
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure(`读取参数失败：${messageOf(error)}`, '按参数说明改正后重发。')
        }

        const sessionId = sessionIdOf(exec)
        if (!sessionId) {
          return failure(
            '拿不到当前会话 id，无法判断这条回复属于哪个流程 run',
            'flow_reply 只能在流程节点（run 内的 agent 会话）里调用。',
          )
        }
        const owner = await resolveSessionOwner(deps, sessionId)
        if (!owner) {
          return failure(
            '这个会话不属于任何流程 run',
            '这个会话不属于任何流程 run：只有流程 run 里的节点会话才能用 flow_reply；普通对话里请直接回复用户。',
            false,
            { sessionId },
          )
        }

        // F1：投递前先按「这个 run 实际会用的回复目标」做白名单校验（与 inbox 同优先级：
        // 消息级 reply > run.json.inbox.reply）。已保存的通道可能来自旧版本或 HTTP 入口，
        // 这里在读取令牌之前就拦下不合规目标，令牌值不会进入任何请求 / 错误信息。
        const storedTarget = await storedReplyTargetOf(deps, owner.runId, inReplyTo)
        const checkedTarget = validateReplyTargetStrict(storedTarget)
        if (!checkedTarget.ok) {
          return failure(
            `回复通道不合规，已拒绝投递：${checkedTarget.error}`,
            '改掉这个 run 的 inbox.reply / 重新发一条带合规 reply 的消息后再回复：'
              + 'http 只允许 https 或回环地址（127.0.0.1 / ::1 / localhost）上的 http，'
              + `tokenEnv 只接受 ${REPLY_TOKEN_ENV_PREFIX}<后缀> 形式的环境变量名。`,
            false,
            { runId: owner.runId, nodeId: owner.nodeId, delivery: 'blocked' },
          )
        }
        const replyToken = tokenValueOf(checkedTarget.reply)

        try {
          const delivered = await deliverOutboundReply({
            runsRoot: deps.runsRoot,
            flowsRoot: deps.flowsRoot,
            engine: deps.engine,
            ctx: deps.ctx,
            log: deps.log,
          }, {
            runId: owner.runId,
            nodeId: owner.nodeId,
            sessionId,
            text,
            ...(inReplyTo === undefined ? {} : { inReplyTo }),
            signal: exec && exec.signal,
          })
          if (delivered.ok !== true) {
            return failure(
              // 令牌值永远打码：上游（fetch / 代理）若把 Authorization 带进错误文本，这里再脱敏一次。
              redactSecrets(delivered.error || '回复投递失败', [replyToken]),
              '回复已写进运行日志（message/out），但外部通道没有确认收到；检查 reply 配置 / 回调地址 / 令牌环境变量。',
              true,
              {
                runId: owner.runId,
                messageId: delivered.messageId,
                nodeId: delivered.nodeId,
                delivery: delivered.delivery,
                ...(delivered.httpStatus === null || delivered.httpStatus === undefined
                  ? {}
                  : { httpStatus: delivered.httpStatus }),
              },
            )
          }
          return jsonSafe({ ok: true, runId: owner.runId, ...delivered })
        } catch (error) {
          const status = error && Number.isInteger(error.status) ? error.status : null
          if (status === 400 || status === 404) {
            return failureOf(error, { action: '回复消息 ', extra: { runId: owner.runId, nodeId: owner.nodeId } })
          }
          return failure(
            redactSecrets(`回复失败：${messageOf(error)}`, [replyToken]),
            '稍后重试一次；仍失败就告诉主人（回复通道可能配置错了）。',
            true,
          )
        }
      },
    },
    ] : []),
  ]
}

/** ctx 是否提供可用的 agents 服务（决定是否注册收件箱 / 回复工具）。 */
function ctxHasAgents(ctx) {
  if (!ctx) return false
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents
    return Boolean(service && (typeof service.get === 'function' || typeof service.resume === 'function'))
  } catch {
    return false
  }
}

/** 按码点截断（不把代理对切成半个字符）。 */
function clipChars(text, max) {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}
