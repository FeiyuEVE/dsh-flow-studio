/**
 * run 目录的 Host 侧读写：`$DSH_HOME/flow-studio/runs/<runId>/`。
 *
 * 布局（05 §1）：
 *   run.jsonl                 run 级事件（run/start、run/end）
 *   run.json                  run 元数据（可变，原子写）
 *   <nodeId>/<attemptId>.jsonl 节点事件
 *   <nodeId>/artifacts/       产物（本模块只校验路径，不代写产物）
 *
 * 安全口径：runId 一律过 `checkRunId()`（字符集 + 拒绝 `.`/`..`/点开头），
 * 所有拼出来的路径都要再确认在 runs 根目录内；目录 0700、文件 0600。
 * 单条事件 ≤8KB、单批 ≤200 条、单 run ≤200000 条，超限抛 RunError(400)。
 *
 * @module @feiyueve/dsh-flow-studio/runstore
 */

import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import {
  chmod, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  MAX_BATCH_EVENTS, MAX_EVENT_BYTES, MAX_RUN_EVENTS, checkMemberId, checkRunId, computeProgress,
  isInstanceScopedEnd,
  normalizeEvent, progressFromNodeStates,
  // 08 §7：事件 kind 白名单与 runlog **同源**（基础 17 种 + 各扩展白名单），
  // 这里不再手写第二份字符串——手抄那份曾经漏掉 `node/status`，过滤直接 400。
  EVENT_KINDS as BASE_EVENT_KINDS, INBOX_EVENT_KINDS, NODE_STATUS_EVENT_KINDS, MACHINE_EVENT_KINDS,
  // 0.10 §2.2（R6）：`node/tools` 也是扩展白名单的一员，`?kinds=node/tools` 不能 400。
  NODE_TOOLS_EVENT_KINDS,
} from './runlog.js'
import { resolveHome } from './store.js'

/** run.json 的体积上限：元数据不该有成百上千行。 */
const MAX_META_BYTES = 1024 * 1024

/**
 * D2：`nodeStatus` 的序列化字节预算（256 KiB）。
 *
 * 为什么单独给一个预算：`nodeStatus` 是唯一「节点数 × 成员数」双维度膨胀的字段，
 * 200 节点 × 20 成员 ×（200 字姓名 + 200 字备注 + 2000 字摘要 + 20 条 blocker）
 * 实测能把 run.json 顶到 2.6MB，而读取侧上限是 1MiB（`MAX_META_BYTES`）——
 * 一旦超限，旧实现会在下一次 patch 时把整份 meta 重置成默认值（D1 灾难）。
 * 所以在**序列化之前**按预算裁剪，保证 run.json 远低于 1MiB。
 *
 * 裁剪顺序（确定性）：① 先摘掉所有 members[].note；② 再按「成员最后更新时间」
 * 从旧到新淘汰成员（没有时间戳就回落到节点 `at`）；③ 仍超预算才淘汰最旧的**节点**
 * （最近更新的节点一定保留）。任何一步发生裁剪都会置 `nodeStatusTruncated: true`，
 * 绝不静默。
 */
export const MAX_NODE_STATUS_BYTES = 256 * 1024

/**
 * 引擎状态机快照（`run.json.machine`，XState `getPersistedSnapshot()`）的字节预算：24 KiB。
 *
 * 语义是「缓存，不是真相」：快照随时可以被下一次 `getPersistedSnapshot()` 覆盖，
 * 丢了只丢一个恢复起点，**绝不能因此让 run 的元数据写不进去**。所以超预算不 400，
 * 而是丢掉 `snapshot`、保留 `version`，并落 `machineTruncated: true`（可见，不静默）。
 *
 * 与 `nodeStatus` 是**两条独立通道**：本预算只量 `snapshot` 自身，machine 既不参与
 * `nodeStatus` 的 256 KiB 预算，也不因 nodeStatus 被裁剪而受影响。
 */
export const MAX_MACHINE_SNAPSHOT_BYTES = 24 * 1024
/** 快照版本号的字符上限（非空字符串，必填；读侧超限整条丢弃）。 */
const MACHINE_VERSION_MAX_CHARS = 200
/** `savedAt` 的长度上限（ISO 字符串远短于此，纯属兜底）。 */
const MACHINE_SAVED_AT_MAX_CHARS = 64
/** `machine` 的内层白名单；其余键写侧进 `droppedKeys`（`machine.<key>`）。 */
const MACHINE_KEYS = ['version', 'snapshot', 'savedAt']

/** nodeStatus 的节点数上限（与引擎侧 `_rememberNodeStatus` 同口径）。 */
const NODE_STATUS_MAX_NODES = 200
/** 单节点 members / blockers 条数上限。 */
const NODE_STATUS_MAX_MEMBERS = 20
const NODE_STATUS_MAX_BLOCKERS = 20
/** summary / note 的单字段字符上限。 */
const NODE_STATUS_MAX_SUMMARY_CHARS = 2000
const NODE_STATUS_MAX_NOTE_CHARS = 200

/**
 * D3：`run.json.sessions`（nodeId → sessionId）的条数与单值上限。
 * 512 与 flow 的 2MB 上限留足余量（一个 run 实际不会跑 512 个节点），
 * 目的是「有界 + 超限显式报错」，而不是让正常流程撞上限制。
 */
const MAX_META_SESSIONS = 512
const MAX_SESSION_KEY_CHARS = 128
const MAX_SESSION_VALUE_CHARS = 128

/**
 * D3：`run.json.startOptions`（创建 run 时记下的发起参数）。
 *
 * 06 §13.8 / `runtime.readStartOptions()` 的契约：只允许这两个键，
 *   - `workspace`：非空字符串（工作区路径）；
 *   - `worktree`：字符串（`auto` / `on` / `off`）。
 * 它是「发起参数」而不是第二份权威记录，体积很小（两条短字符串），
 * **不参与** `nodeStatus` 的 256KiB 字节预算；run.json 损坏时也绝不重建它
 * （D1 的 writeRunMeta 会拒绝覆盖并备份）。
 */
const START_OPTIONS_KEYS = ['workspace', 'worktree']
const START_OPTION_TEXT_MAX_CHARS = 2048

/**
 * G2 额外契约：`run.json.limits`（引擎侧通过 writeRunMeta 写入的超时配置）。
 *
 * 只接受两个可选正整数键，形状收敛与 workspace / worktree 一样：
 *   - 读路径宽松：非对象 / 非法值丢弃（不能让手改坏的 run.json 让整个 run 不可读）；
 *   - 写路径严格：类型错 → 400（`validateMetaPatch`）；
 *   - 未传就不出现（绝不凭空造一个 `{}`）。
 */
const LIMITS_KEYS = ['runTimeoutMs', 'nodeTimeoutMs']

/**
 * 06 §13.4：给 `run/start` / `run/end` 留的保留额度。
 * 普通事件最多用到 `MAX_RUN_EVENTS - 64`，保证任何致命失败都还有位置落终态。
 */
export const RESERVED_TERMINAL_EVENTS = 64
const NORMAL_EVENT_LIMIT = MAX_RUN_EVENTS - RESERVED_TERMINAL_EVENTS

/** §13.3 单写者租约文件（放在 run 目录里，0600）。 */
const LEASE_FILE = 'lock.json'
/** 进程间互斥用的短锁文件（startRun 的读-改-写）：不参与租约语义。 */
const START_LOCK_FILE = 'start.lock'
/**
 * G2-b：run.json 的跨进程写锁。
 *
 * 与 `lock.json`（单写者**执行**租约）是两件不同的事：租约只在 `engine.start` 抢、
 * 运行期续租，而 run.json 的写路径（appendEvents / writeRunMeta / messages /
 * sessions …）以前只有进程内 `withLock`，两个进程各自「读 meta → +1 → 写回」就会
 * 产生重复 seq。这里用一把独立的 `meta.lock`（O_EXCL）把**所有** run.json 写路径
 * 串起来；两把锁不会互相嵌套（不持 meta.lock 去抢租约），所以不会死锁。
 */
const META_LOCK_FILE = 'meta.lock'
/**
 * meta.lock 的 ttl：临界区只有本地文件读写（毫秒级），10s 足够宽松；持有者崩溃时
 * mtime 超过 ttl 即按陈旧锁接管。wait 必须 > ttl，否则一次调用永远等不到接管窗口。
 */
const META_LOCK_TTL_MS = 10 * 1000
/** 等 meta.lock 的上限：超时抛可读 409（调用方可重试），绝不静默丢写。 */
const META_LOCK_WAIT_MS = 15 * 1000
/** 写盘失败的侧车文件（GET /runs/<id> 会把它作为 storageError 返回）。 */
const ERROR_FILE = '.error'
/** startRun 短锁：崩溃残留的锁 mtime 超过这个值就当作陈旧锁挪走。 */
const FILE_LOCK_TTL_MS = 10 * 1000
/** startRun 等锁的最长时间（超时 409，让调用方重试，不无限排队）。 */
const FILE_LOCK_WAIT_MS = 5000
/** 陈旧锁 / 过期租约的「接管权」选举：意图文件前缀。 */
const TAKEOVER_PREFIX = 'lock.takeover-'
/** 选举窗口：写完意图后等这么久，让并发者都现身。 */
const TAKEOVER_ELECTION_MS = 15
/** 太老的意图文件视为崩溃残留（否则会永远霸占选举）。 */
const TAKEOVER_STALE_MS = 5000
/** O_EXCL 建成后等这么久再复核内容，用来发现「刚建好就被接管走」。 */
const LOCK_SETTLE_MS = 4
/** 默认租约 TTL：引擎每 30s 续租，90s 过期（3 次心跳）。 */
export const DEFAULT_LEASE_TTL_MS = 90 * 1000

const TERMINAL_STATUS = new Set(['done', 'aborted', 'failed'])
const ALL_STATUS = new Set(['pending', 'running', 'done', 'aborted', 'failed'])

/** 事件按 run 级 / 节点级分流。06 §16：收件箱消息是 run 级事实（可能先于节点到达）。 */
const RUN_LEVEL_KINDS = new Set(['run/start', 'run/end', 'message/in', 'message/out'])

const ATTEMPT_FILE = /^\d+\.jsonl$/
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** 带 HTTP 语义的错误：路由层直接按 status / field / reason 回 JSON。 */
export class RunError extends Error {
  constructor(status, field, reason, extra = {}) {
    super(reason || '运行日志操作失败')
    this.name = 'RunError'
    this.status = status
    this.field = field || null
    this.reason = reason || this.message
    Object.assign(this, extra)
  }

  toPayload() {
    const payload = { ok: false, error: this.reason }
    if (this.field) payload.field = this.field
    if (this.index !== undefined) payload.index = this.index
    return payload
  }
}

/**
 * runs 根目录。每次调用重新解析，便于测试注入 DSH_HOME。
 * @param {string} [home]
 */
export function runsDir(home) {
  return join(home || resolveHome(process.env), 'flow-studio', 'runs')
}

/** 生成 `r-<base36 时间>-<随机 4 位>`。 */
export function newRunId(now = Date.now()) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 4; i += 1) suffix += alphabet[randomInt(alphabet.length)]
  return `r-${now.toString(36)}-${suffix}`
}

async function withLock(key, task) {
  const previous = locks.get(key) || Promise.resolve()
  let release
  const gate = new Promise(resolveGate => { release = resolveGate })
  locks.set(key, gate)
  await previous.catch(() => {})
  try {
    return await task()
  } finally {
    release()
    if (locks.get(key) === gate) locks.delete(key)
  }
}

const locks = new Map()

function locate(runsRoot, runId) {
  const id = checkRunId(runId)
  if (!id) return null
  const root = resolve(runsRoot)
  const dir = resolve(root, id)
  if (!isInside(root, dir)) return null
  return { id, root, dir }
}

function isInside(root, target) {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function ensureDirMode(dir, mode = DIR_MODE) {
  await mkdir(dir, { recursive: true, mode })
  try {
    await chmod(dir, mode)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
}

function metaPath(dir) {
  return join(dir, 'run.json')
}

/** §8.6：run.json 里的进度计数器状态（追加时原子更新）。 */
const PROGRESS_STATUS = new Set(['passed', 'rejected', 'failed', 'skipped', 'pending'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeProgress(source) {
  const out = { nodes: {} }
  if (!isPlainObject(source) || !isPlainObject(source.nodes)) return out
  for (const [nodeId, entry] of Object.entries(source.nodes)) {
    if (!checkRunId(nodeId) || !isPlainObject(entry)) continue
    const attemptId = Number.isInteger(entry.attemptId) && entry.attemptId >= 1 ? entry.attemptId : 1
    const status = PROGRESS_STATUS.has(entry.status) ? entry.status : 'pending'
    const endSeq = Number.isInteger(entry.endSeq) && entry.endSeq >= 0 ? entry.endSeq : 0
    out.nodes[nodeId] = { attemptId, status, endSeq, invalidated: entry.invalidated === true }
  }
  return out
}

function countPassed(progress) {
  let passed = 0
  for (const entry of Object.values(progress.nodes)) {
    if (entry.status === 'passed' && !entry.invalidated) passed += 1
  }
  return passed
}

/** 06 §16：run.json.input 里保存的启动消息上限（有界，防止外部把元数据撑爆）。 */
export const RUN_INPUT_MAX_MESSAGES = 20
/** 06 §16：入站消息正文的持久化上限（码点）。 */
export const RUN_MESSAGE_TEXT_MAX_CHARS = 4000
/** 06 §16：来源标识上限。 */
export const RUN_MESSAGE_FROM_MAX_CHARS = 200
/** 06 §16：消息级回复目标的 kind 白名单。 */
export const MESSAGE_REPLY_KINDS = Object.freeze(['session', 'http', 'none'])
const MESSAGE_REPLY_KIND_SET = new Set(MESSAGE_REPLY_KINDS)
/** 06 §16：messages.jsonl 里记录的投递状态。 */
export const MESSAGE_STATUSES = Object.freeze(['pending', 'injected', 'resumed', 'delivered'])
const MESSAGE_STATUS_SET = new Set(MESSAGE_STATUSES)

function clipText(value, max) {
  const chars = Array.from(String(value ?? ''))
  if (chars.length <= max) return chars.join('')
  if (max <= 1) return chars.slice(0, max).join('')
  return `${chars.slice(0, max - 1).join('')}…`
}

/**
 * 06 §16：回复目标归一化（run.json.inbox.reply 与请求体 reply 共用同一口径）。
 * 返回 null 表示不合法；调用方决定回 400 还是忽略。
 * @returns {{ kind: string, sessionId?: string, url?: string, tokenEnv?: string } | null}
 */
export function normalizeReplyTarget(source) {
  if (!isPlainObject(source)) return null
  const kind = source.kind
  if (typeof kind !== 'string' || !MESSAGE_REPLY_KIND_SET.has(kind)) return null
  if (kind === 'none') return { kind: 'none' }
  if (kind === 'session') {
    if (typeof source.sessionId !== 'string') return null
    const sessionId = source.sessionId.trim()
    if (sessionId === '' || sessionId.length > 128 || /[\u0000-\u001f\u007f]/.test(sessionId)) return null
    return { kind: 'session', sessionId }
  }
  // kind === 'http'
  if (typeof source.url !== 'string' || source.url.length > 2048) return null
  let parsed
  try {
    parsed = new URL(source.url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const reply = { kind: 'http', url: parsed.toString() }
  if (source.tokenEnv !== undefined && source.tokenEnv !== null) {
    if (typeof source.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(source.tokenEnv)) return null
    reply.tokenEnv = source.tokenEnv
  }
  return reply
}

function normalizeRunInput(source) {
  if (!isPlainObject(source) || !Array.isArray(source.messages)) return null
  const messages = []
  for (const item of source.messages.slice(0, RUN_INPUT_MAX_MESSAGES)) {
    if (!isPlainObject(item)) continue
    if (typeof item.text !== 'string' || item.text.trim() === '') continue
    const entry = {
      id: typeof item.id === 'string' && item.id !== '' ? clipText(item.id, 128) : `seed-${messages.length + 1}`,
      from: typeof item.from === 'string' && item.from.trim() !== ''
        ? clipText(item.from.trim(), RUN_MESSAGE_FROM_MAX_CHARS)
        : 'unknown',
      text: clipText(item.text, RUN_MESSAGE_TEXT_MAX_CHARS),
      at: normalizeIso(item.at) || new Date().toISOString(),
    }
    if (typeof item.targetNodeId === 'string' && checkRunId(item.targetNodeId)) {
      entry.targetNodeId = item.targetNodeId
    }
    messages.push(entry)
  }
  return messages.length > 0 ? { messages } : null
}

function normalizeRunInbox(source) {
  if (!isPlainObject(source)) return null
  const reply = normalizeReplyTarget(source.reply)
  if (!reply) return null
  return {
    reply,
    updatedAt: normalizeIso(source.updatedAt),
  }
}

/** 06 §2：运行中的 live 视图（currentNodeId / attempt / round / since / lastEventSeq / phase）。 */
const LIVE_PHASES = new Set(['model', 'tool', 'spawn', 'idle'])
/** §13.12：live.members[].state 白名单。 */
const LIVE_MEMBER_STATES = new Set(['starting', 'running', 'done', 'unknown'])
const LIVE_MEMBERS_MAX = 16
const LIVE_MESSAGE_MAX_CHARS = 200
const LIVE_NODE_TITLE_MAX_CHARS = 200

function normalizeIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : null
}

function liveMemberList(source) {
  if (!Array.isArray(source)) return []
  const out = []
  for (const item of source) {
    if (!isPlainObject(item) || out.length >= LIVE_MEMBERS_MAX) continue
    const memberId = checkMemberId(item.memberId)
    if (!memberId) continue
    const name = typeof item.name === 'string' && item.name !== '' ? item.name.slice(0, 64) : memberId
    const entry = { memberId, name }
    if (typeof item.role === 'string' && item.role !== '') entry.role = item.role.slice(0, 32)
    if (typeof item.model === 'string' && item.model !== '') entry.model = item.model.slice(0, 64)
    entry.state = LIVE_MEMBER_STATES.has(item.state) ? item.state : 'unknown'
    out.push(entry)
  }
  return out
}

function normalizeLive(source) {
  if (!isPlainObject(source)) return null
  const live = {
    currentNodeId: typeof source.currentNodeId === 'string' && checkRunId(source.currentNodeId)
      ? source.currentNodeId
      : null,
    attempt: Number.isInteger(source.attempt) && source.attempt >= 0 ? source.attempt : 0,
    round: Number.isInteger(source.round) && source.round >= 0 ? source.round : 0,
    since: typeof source.since === 'string' && Number.isFinite(Date.parse(source.since))
      ? new Date(Date.parse(source.since)).toISOString()
      : null,
    lastEventSeq: Number.isInteger(source.lastEventSeq) && source.lastEventSeq >= 0
      ? source.lastEventSeq
      : 0,
    phase: LIVE_PHASES.has(source.phase) ? source.phase : 'idle',
    // §13.12：客户端轮询 run.json.live 显示「正在干什么」。字段全部有界，坏值回落 null/0。
    nodeTitle: typeof source.nodeTitle === 'string' && source.nodeTitle !== ''
      ? source.nodeTitle.slice(0, LIVE_NODE_TITLE_MAX_CHARS)
      : null,
    nodeMode: source.nodeMode === 'single' || source.nodeMode === 'team' ? source.nodeMode : null,
    activeMemberId: checkMemberId(source.activeMemberId),
    lastTool: null,
    lastMessage: null,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    members: liveMemberList(source.members),
  }
  const tool = source.lastTool
  if (isPlainObject(tool) && typeof tool.name === 'string' && tool.name !== '') {
    live.lastTool = {
      name: tool.name.slice(0, 200),
      startedAt: normalizeIso(tool.startedAt),
      ok: typeof tool.ok === 'boolean' ? tool.ok : null,
    }
  }
  const message = source.lastMessage
  if (isPlainObject(message) && typeof message.text === 'string' && message.text !== '') {
    live.lastMessage = {
      text: message.text.slice(0, LIVE_MESSAGE_MAX_CHARS),
      at: normalizeIso(message.at),
      memberId: checkMemberId(message.memberId),
    }
  }
  const tokens = isPlainObject(source.tokens) ? source.tokens : {}
  for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output']) {
    live.tokens[bucket] = Number.isInteger(tokens[bucket]) && tokens[bucket] >= 0 ? tokens[bucket] : 0
  }
  return live
}

/**
 * 0.11 R1：run.json.execution = { epoch, ownerId, state }。
 * epoch 单调递增，每次 claim +1；ownerId 是 claim 时的随机身份；state ∈ active/released/settled。
 */
function normalizeExecution(raw) {
  if (!isPlainObject(raw)) return null
  const epoch = Number.isInteger(raw.epoch) && raw.epoch >= 0 ? raw.epoch : null
  const ownerId = typeof raw.ownerId === 'string' && raw.ownerId !== '' ? raw.ownerId.slice(0, 128) : ''
  const state = raw.state === 'active' || raw.state === 'released' || raw.state === 'settled' ? raw.state : 'active'
  if (epoch === null && ownerId === '') return null
  return { epoch: epoch === null ? 0 : epoch, ownerId, state }
}

function normalizeMeta(raw, id) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const now = new Date().toISOString()
  const text = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback)
  const count = (value, fallback = 0) => (Number.isInteger(value) && value >= 0 ? value : fallback)
  const status = ALL_STATUS.has(source.status) ? source.status : 'running'
  const progress = normalizeProgress(source.progress)
  const hasProgress = isPlainObject(source.progress) && isPlainObject(source.progress.nodes)
  const lastSeq = Math.max(count(source.lastSeq, 0), count(source.seq, 0))
  const nodeTotal = count(source.nodeTotal)
  // 06 §13.2：`started` 是持久化的「开始过」标志，start 不再用 eventCount 猜。
  // 老 run.json（v0.3 没有 started 字段）按「有事件 / 已终态」推断，避免把从没跑过的
  // running 壳子误判成已开始。
  const started = source.started === true
    ? true
    : source.started === false
      ? false
      : (TERMINAL_STATUS.has(status) || count(source.eventCount) > 0 || lastSeq > 0)
  const engine = source.engine === 'stub' ? 'stub' : 'real'
  // 07 §11（R8）：节点自审状态先做形状收敛 + 字节预算裁剪（D2）。
  const nodeStatus = source.nodeStatus === undefined ? null : normalizeNodeStatus(source.nodeStatus)
  // D4：engine 状态机快照（缓存不是真相）：读路径宽松 + 24 KiB 独立预算。
  // 与 nodeStatus 互不影响——两条通道各自量各自的字节。
  const machine = normalizeMachine(source.machine)
  // 0.11 R1：持久执行世代 {epoch, ownerId, state}。老 run 没有这个字段 → 不出现。
  const execution = normalizeExecution(source.execution)
  // v0.9.2：`restart` 用 undefined 区分「没传」与「显式清除」；显式 null / 坏形状都落成 null。
  const restart = source.restart === undefined ? null : normalizeRestart(source.restart)
  // v0.9.2 P0：run.json.agentPreset = { value, source }；未知 / 坏形状整条省略。
  const agentPresetBinding = source.agentPreset === undefined
    ? null
    : normalizeBinding(source.agentPreset, AGENT_PRESET_KEYS)
  const meta = {
    v: 1,
    id,
    name: text(source.name, id),
    flowId: text(source.flowId, ''),
    flowName: text(source.flowName, ''),
    status,
    started,
    engine,
    startedAt: text(source.startedAt, now),
    endedAt: typeof source.endedAt === 'string' && source.endedAt !== '' ? source.endedAt : null,
    nodeDone: hasProgress ? countPassed(progress) : count(source.nodeDone),
    nodeTotal,
    tokenTotal: count(source.tokenTotal),
    eventCount: count(source.eventCount),
    lastSeq,
    // 兼容 v0.2：老字段 seq 与 lastSeq 同值。
    seq: lastSeq,
    unkeyedCalls: count(source.unkeyedCalls),
    tokenTotalApprox: source.tokenTotalApprox === true,
    createdAt: text(source.createdAt, now),
    updatedAt: text(source.updatedAt, now),
    progress,
    // 06 §2 / §10：live 随 run.json 原子写；结束后由引擎置 null。
    live: normalizeLive(source.live),
    // 06 §16：可选字段（老 run.json 没有就是 null，不影响既有口径）。
    //   input：run 还没开始就被投递进来的消息（engine.start 时并进入口节点提示词）；
    //   inbox：运行中动态配置的回复目标（flow_reply 的 run 级默认值）。
    input: normalizeRunInput(source.input),
    inbox: normalizeRunInbox(source.inbox),
    // 07 §4/§5/§7：运行绑定（工作区 / worktree / 节点会话模式 / 自审调度）。
    // 这些键以前会被白名单丢掉，逼得 engine 与 runtime 各自「读原文→合并→改写」；
    // 在这里收敛一次，读写两条路就都稳了。形状收敛、超长文本截断，不认识的键丢弃。
    ...(source.sessionMode === undefined ? {} : { sessionMode: normalizeSessionMode(source.sessionMode) }),
    ...(source.workspace === undefined ? {} : { workspace: normalizeBinding(source.workspace, WORKSPACE_KEYS) }),
    ...(source.worktree === undefined ? {} : { worktree: normalizeWorktree(source.worktree) }),
    ...(source.supervision === undefined ? {} : { supervision: normalizeBinding(source.supervision, SUPERVISION_KEYS) }),
    // v0.9.2 P0：本次 run 生效的默认 agent preset + 来源（node/start 事件另有节点级覆盖）。
    ...(agentPresetBinding === null ? {} : { agentPreset: agentPresetBinding }),
    ...(nodeStatus === null ? {} : { nodeStatus: nodeStatus.value }),
    // D2：预算裁剪必须可观测（绝不静默）；一旦发生过裁剪就持久化这个标志。
    ...(source.nodeStatusTruncated === true || (nodeStatus !== null && nodeStatus.truncated)
      ? { nodeStatusTruncated: true }
      : {}),
    // D3：节点 → 会话 id 的映射（形如 `{ [nodeId]: sessionId }`），由调用方经 patch 写入。
    ...(source.sessions === undefined ? {} : { sessions: normalizeMetaSessions(source.sessions) }),
    // v0.9.2：失败后重启的续跑记录（从哪个 run / 第几次 / 旧失败原因 / 跳过节点）。
    ...(restart === null ? {} : { restart }),
    // D3：创建 run 时记下的发起参数（06 §13.8）。只保留 { workspace?, worktree? }；
    // 未传就不出现（绝不凭空造一个空对象），传了空对象则保留为空对象。
    ...(source.startOptions === undefined ? {} : { startOptions: normalizeStartOptions(source.startOptions) }),
    // G2 额外契约：limits（{ runTimeoutMs?, nodeTimeoutMs? }，两个可选正整数）。
    // 未传不出现；读侧非法值直接丢弃，写侧由 validateMetaPatch 严格 400。
    ...(source.limits === undefined ? {} : { limits: normalizeLimits(source.limits) }),
    ...(execution === null ? {} : { execution }),
    // D4：engine 状态机快照。整条替换语义：未传 / 传 null → 不出现（清除）；
    // version 不合法 → 整条丢弃（读路径宽松，不报错）。
    ...(machine.value === null ? {} : { machine: machine.value }),
    // 快照被裁过必须可见（绝不静默）；machine 整条不在时这个标志也没有意义，
    // 所以跟着一起清掉（`machine: null` 能同时清掉两个键）。
    ...(machine.value !== null && (source.machineTruncated === true || machine.truncated)
      ? { machineTruncated: true }
      : {}),
  }
  if (nodeStatus !== null && nodeStatus.truncated && nodeStatus.stats) {
    // 诊断细节不落盘（不进 JSON），但写回值上能直接读到裁了多少，便于测试与排障。
    Object.defineProperty(meta, 'nodeStatusBudget', {
      value: nodeStatus.stats, enumerable: false, configurable: true, writable: false,
    })
  }
  return meta
}

/** 节点状态表：每个节点只留最新一条，最多 200 个节点，字段逐个收敛。 */
// `attempt`：runtime 重启后靠它恢复节点闹钟（真实 attempt 而不是一律 1）。
// 只接受非负整数，坏值在下面单独剔除（其它字段照常保留，不整条丢节点）。
const NODE_STATUS_KEYS = ['state', 'progress', 'summary', 'verdict', 'attempt', 'at']
const NODE_STATUS_STATES = new Set(['working', 'done', 'blocked', 'failed'])

function measureJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** 节点 / 成员的时间戳：只用于确定性排序（不落盘）。 */
function nodeStatusTime(value) {
  const raw = value && typeof value === 'object' ? value.at : undefined
  const parsed = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function memberStatusTime(member, entryAt) {
  if (isPlainObject(member)) {
    for (const key of ['at', 'updatedAt', 'lastActiveAt', 'lastUpdateAt']) {
      const raw = member[key]
      const parsed = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
      if (Number.isFinite(parsed)) return parsed
    }
  }
  const parsed = typeof entryAt === 'string' ? Date.parse(entryAt) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 把 `kept`（规范化后的节点表）按「保留哪些成员 / 哪些节点」重新序列化成对象。
 * `keepMembers === null` 表示全留；否则是 `Map<节点下标, Set<成员下标>>`。
 * `keepNodes === null` 表示全留；否则是节点下标集合。
 */
function buildNodeStatus(kept, keepMembers, keepNodes) {
  const out = {}
  for (let index = 0; index < kept.length; index += 1) {
    if (keepNodes !== null && !keepNodes.has(index)) continue
    const { nodeId, entry } = kept[index]
    const copy = { ...entry }
    if (keepMembers === null) {
      copy.members = entry.members.map(member => ({ ...member }))
    } else {
      const allowed = keepMembers.get(index)
      const members = []
      for (let m = 0; m < entry.members.length; m += 1) {
        if (allowed && allowed.has(m)) members.push({ ...entry.members[m] })
      }
      copy.members = members
    }
    copy.blockers = entry.blockers.slice()
    out[nodeId] = copy
  }
  return out
}

/**
 * D2：nodeStatus 的规范化 + 字节预算裁剪。
 *
 * @returns {{ value: object | null, truncated: boolean,
 *   stats: { limitBytes: number, bytesBefore: number, bytesAfter: number,
 *     removedNotes: number, evictedMembers: number, evictedNodes: number } | null }}
 */
function normalizeNodeStatus(raw) {
  if (!isPlainObject(raw)) return { value: null, truncated: false, stats: null }
  const entries = Object.entries(raw)
  let truncated = false

  // 节点数超限：按 `at` 保留最近更新的 200 个（同时间按插入顺序靠后的优先），
  // 输出仍按原插入顺序，避免读一次改一次顺序。
  let refs = entries
  if (entries.length > NODE_STATUS_MAX_NODES) {
    truncated = true
    refs = entries
      .map(([, value], index) => ({ index, time: nodeStatusTime(value) }))
      .sort((a, b) => (b.time - a.time) || (b.index - a.index))
      .slice(0, NODE_STATUS_MAX_NODES)
      .sort((a, b) => a.index - b.index)
      .map(ref => entries[ref.index])
  }

  const kept = []
  for (const [nodeId, value] of refs) {
    if (!isPlainObject(value)) continue
    const entry = normalizeBinding(value, NODE_STATUS_KEYS)
    if (!entry) continue
    // runtime 重启恢复节点闹钟只看 `attempt`：非负整数才保留，否则只丢这一个键。
    if (entry.attempt !== undefined && (!Number.isInteger(entry.attempt) || entry.attempt < 0)) {
      delete entry.attempt
    }
    if (!NODE_STATUS_STATES.has(entry.state)) entry.state = 'working'
    if (!Number.isInteger(entry.progress) || entry.progress < 0) entry.progress = 0
    if (entry.progress > 100) entry.progress = 100
    if (entry.summary !== null && entry.summary !== undefined && typeof entry.summary === 'string') {
      entry.summary = entry.summary.length > NODE_STATUS_MAX_SUMMARY_CHARS
        ? entry.summary.slice(0, NODE_STATUS_MAX_SUMMARY_CHARS)
        : entry.summary
    } else {
      delete entry.summary
    }
    if (entry.verdict !== 'pass' && entry.verdict !== 'reject') entry.verdict = null
    // members / blockers 只在事件里留全量；run.json 只留收敛后的摘要。
    const rawMembers = Array.isArray(value.members) ? value.members : []
    const rawBlockers = Array.isArray(value.blockers) ? value.blockers : []
    if (rawMembers.length > NODE_STATUS_MAX_MEMBERS) truncated = true
    if (rawBlockers.length > NODE_STATUS_MAX_BLOCKERS) truncated = true
    const memberTimes = []
    entry.members = rawMembers.slice(0, NODE_STATUS_MAX_MEMBERS).map(member => {
      if (!isPlainObject(member)) {
        memberTimes.push(nodeStatusTime(entry))
        return { name: '', state: 'working' }
      }
      const note = text2(member.note, '')
      memberTimes.push(memberStatusTime(member, entry.at))
      return {
        name: text2(member.name, '').slice(0, 200),
        state: NODE_STATUS_STATES.has(member.state) ? member.state : 'working',
        ...(note !== '' ? { note: note.slice(0, NODE_STATUS_MAX_NOTE_CHARS) } : {}),
      }
    })
    entry.blockers = rawBlockers
      .slice(0, NODE_STATUS_MAX_BLOCKERS)
      .map(item => text2(item, '').slice(0, 200))
      .filter(Boolean)
    kept.push({ nodeId, entry, memberTimes })
  }

  const stats = {
    limitBytes: MAX_NODE_STATUS_BYTES,
    bytesBefore: 0,
    bytesAfter: 0,
    removedNotes: 0,
    evictedMembers: 0,
    evictedNodes: 0,
  }
  let value = buildNodeStatus(kept, null, null)
  let bytes = measureJsonBytes(value)
  stats.bytesBefore = bytes

  // ① 先裁 members[].note（一次性摘掉所有备注，语义最简单也最省字节）。
  if (bytes > MAX_NODE_STATUS_BYTES) {
    for (const item of kept) {
      for (const member of item.entry.members) {
        if (member.note !== undefined) {
          delete member.note
          stats.removedNotes += 1
        }
      }
    }
    value = buildNodeStatus(kept, null, null)
    bytes = measureJsonBytes(value)
    if (stats.removedNotes > 0) truncated = true
  }

  // ② 仍超预算：按「成员最后更新时间」从旧到新淘汰成员（保留最新的）。
  //   时间相同按「节点下标 / 成员下标」倒序保留后出现者，保证结果确定。
  const flatMembers = []
  kept.forEach((item, nodeIndex) => {
    item.entry.members.forEach((member, memberIndex) => {
      flatMembers.push({ nodeIndex, memberIndex, time: item.memberTimes[memberIndex] })
    })
  })
  if (bytes > MAX_NODE_STATUS_BYTES && flatMembers.length > 0) {
    flatMembers.sort((a, b) => (b.time - a.time)
      || (b.nodeIndex - a.nodeIndex)
      || (b.memberIndex - a.memberIndex))
    const buildWithMembers = keep => {
      const allowed = new Map()
      for (let i = 0; i < keep; i += 1) {
        const ref = flatMembers[i]
        if (!allowed.has(ref.nodeIndex)) allowed.set(ref.nodeIndex, new Set())
        allowed.get(ref.nodeIndex).add(ref.memberIndex)
      }
      return buildNodeStatus(kept, allowed, null)
    }
    let bestKeep = 0
    let bestValue = buildWithMembers(0)
    let bestBytes = measureJsonBytes(bestValue)
    if (bestBytes <= MAX_NODE_STATUS_BYTES) {
      // 单调性：留的成员越少字节越少 → 二分找「不超过预算的最大保留数」。
      let low = 0
      let high = flatMembers.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        const candidate = buildWithMembers(mid)
        if (measureJsonBytes(candidate) <= MAX_NODE_STATUS_BYTES) {
          low = mid
          bestKeep = mid
          bestValue = candidate
          bestBytes = measureJsonBytes(candidate)
        } else {
          high = mid - 1
        }
      }
      if (bestKeep === 0) {
        bestValue = buildWithMembers(0)
        bestBytes = measureJsonBytes(bestValue)
      }
    }
    value = bestValue
    bytes = bestBytes
    stats.evictedMembers = flatMembers.length - bestKeep
    if (stats.evictedMembers > 0) truncated = true
  }

  // ③ 仍超预算：淘汰最旧的整个节点（最近更新的节点一定保留，绝不整块清空）。
  if (bytes > MAX_NODE_STATUS_BYTES && kept.length > 0) {
    const order = kept
      .map((item, index) => ({ index, time: nodeStatusTime(item.entry) }))
      .sort((a, b) => (b.time - a.time) || (b.index - a.index))
    const buildWithNodes = keep => {
      const allowed = new Set(order.slice(0, keep).map(ref => ref.index))
      return buildNodeStatus(kept, new Map(), allowed)
    }
    let bestKeep = 0
    let bestValue = buildWithNodes(0)
    let bestBytes = measureJsonBytes(bestValue)
    if (bestBytes <= MAX_NODE_STATUS_BYTES) {
      let low = 0
      let high = kept.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        const candidate = buildWithNodes(mid)
        if (measureJsonBytes(candidate) <= MAX_NODE_STATUS_BYTES) {
          low = mid
          bestKeep = mid
          bestValue = candidate
          bestBytes = measureJsonBytes(candidate)
        } else {
          high = mid - 1
        }
      }
      if (bestKeep === 0) {
        bestValue = buildWithNodes(0)
        bestBytes = measureJsonBytes(bestValue)
      }
    }
    value = bestValue
    bytes = bestBytes
    stats.evictedNodes = kept.length - bestKeep
    if (stats.evictedNodes > 0) truncated = true
  }

  // 兜底：极端情况下（单节点就超预算）退化成空表，但仍然标记 truncated。
  if (bytes > MAX_NODE_STATUS_BYTES) {
    value = {}
    bytes = measureJsonBytes(value)
    truncated = true
  }

  stats.bytesAfter = bytes
  return { value, truncated, stats }
}

/**
 * 比 `isPlainObject` 更严一档的「普通数据对象」判定：数组 / null / null 原型对象 /
 * 类实例（Date、Map、XState 内部类型…）都不算。
 *
 * 用在 `machine` 与 `machine.snapshot` 上：这两处的内容会被原样写进 run.json
 * 当作恢复起点，形状必须能被 JSON 往返，不能是「看起来像对象」的别的东西。
 */
function isPlainDataObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.getPrototypeOf(value) === Object.prototype
}

/**
 * 量快照的序列化字节数。循环引用 / BigInt 等不可序列化内容 → Infinity，
 * 由调用方按「超预算」裁掉：快照只是缓存，不能因为一个坏对象让整份元数据写不进去。
 */
function machineSnapshotBytes(value) {
  try {
    return measureJsonBytes(value)
  } catch {
    return Infinity
  }
}

/**
 * D4：`run.json.machine`（引擎状态机快照，XState `getPersistedSnapshot()`）的读路径收敛。
 *
 * 语义是「缓存，不是真相」，所以读路径**永远宽松、绝不报错**：
 *   - `version` 必须是非空字符串且 ≤200 字符，否则**整条 machine 丢弃**——没有版本号
 *     的快照无法安全恢复，留着只会误导引擎；
 *   - `snapshot` 必须是普通数据对象且序列化 ≤24 KiB；超限或形状不对 → 只丢这一个键、
 *     保留 `version`，并置 `machineTruncated: true`（可见，不静默）；
 *   - `savedAt` 是 ISO 字符串且 ≤64 字符才保留，否则丢该键；
 *   - 未知内层键在这里丢弃；**写侧**会在 `droppedKeys` 里以 `machine.<key>` 报出来。
 *
 * 与 `nodeStatus` 是两条独立通道：本函数只量 `snapshot` 自身，既不参与 nodeStatus 的
 * 256 KiB 预算，也不因 nodeStatus 被裁剪而受影响。
 *
 * @returns {{ value: object | null, truncated: boolean }}
 */
function normalizeMachine(raw) {
  if (!isPlainDataObject(raw)) return { value: null, truncated: false }
  const version = typeof raw.version === 'string'
    && raw.version.trim() !== ''
    && raw.version.length <= MACHINE_VERSION_MAX_CHARS
    ? raw.version
    : null
  if (version === null) return { value: null, truncated: false }
  const machine = { version }
  let truncated = false
  if (hasOwn(raw, 'snapshot')) {
    const bytes = isPlainDataObject(raw.snapshot) ? machineSnapshotBytes(raw.snapshot) : null
    if (bytes !== null && bytes <= MAX_MACHINE_SNAPSHOT_BYTES) {
      machine.snapshot = raw.snapshot
    } else {
      truncated = true
    }
  }
  if (typeof raw.savedAt === 'string'
    && raw.savedAt !== ''
    && raw.savedAt.length <= MACHINE_SAVED_AT_MAX_CHARS
    && normalizeIso(raw.savedAt) !== null) {
    // 原样保留（不改成 toISOString 的规范形式）：savedAt 是给人看的落盘时间，
    // 偏移量信息比「统一成 Z」更有用，也避免读一次改一次。
    machine.savedAt = raw.savedAt
  }
  return { value: machine, truncated }
}

function text2(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/**
 * D3：`run.json.sessions`（nodeId → sessionId）的形状收敛。
 *
 * 读路径用宽松口径（坏条目跳过，否则一份手改坏的 run.json 会让整个 run 不可读）；
 * **写路径**（`writeRunMeta`）在合并前另有严格校验：类型不对 / 超上限一律 400，
 * 不静默丢。
 */
function normalizeMetaSessions(raw) {
  if (!isPlainObject(raw)) return null
  const out = {}
  let count = 0
  for (const [nodeId, sessionId] of Object.entries(raw)) {
    if (count >= MAX_META_SESSIONS) break
    if (typeof nodeId !== 'string' || nodeId === '' || nodeId.length > MAX_SESSION_KEY_CHARS) continue
    if (typeof sessionId !== 'string') continue
    if (sessionId.trim() === '' || sessionId.length > MAX_SESSION_VALUE_CHARS) continue
    out[nodeId] = sessionId
    count += 1
  }
  return out
}

/**
 * D3：`run.json.startOptions`（创建 run 时记下的发起参数）的形状收敛。
 *
 * 读路径宽松（坏值直接省略，不能让一份手改坏的 run.json 让整个 run 不可读）；
 * **写路径**在 `validateMetaPatch` 里严格校验（非对象 / workspace 空串或非字符串 /
 * worktree 非字符串 → 400）。多余键在读侧丢弃，写侧另由 `writeRunMeta` 记进
 * `droppedKeys`（`startOptions.<key>`），不静默。
 *
 * 未传时由 `normalizeMeta` 直接省略该键（不会凭空出现 `{}`）；显式传 `{}` 则保留 `{}`。
 */
function normalizeStartOptions(raw) {
  if (!isPlainObject(raw)) return null
  const out = {}
  if (typeof raw.workspace === 'string' && raw.workspace !== '') {
    out.workspace = raw.workspace.length > START_OPTION_TEXT_MAX_CHARS
      ? raw.workspace.slice(0, START_OPTION_TEXT_MAX_CHARS)
      : raw.workspace
  }
  if (typeof raw.worktree === 'string') {
    out.worktree = raw.worktree.length > START_OPTION_TEXT_MAX_CHARS
      ? raw.worktree.slice(0, START_OPTION_TEXT_MAX_CHARS)
      : raw.worktree
  }
  return out
}

/**
 * G2 额外契约：`run.json.limits` 的形状收敛（读路径宽松口径）。
 *
 * 只保留两个可选正整数键；不是对象返回 null（与 workspace / worktree 一样：
 * 显式存在但坏掉时落成 null，而不是悄悄变成 `{}`）。
 */
function normalizeLimits(raw) {
  if (!isPlainObject(raw)) return null
  const out = {}
  for (const key of LIMITS_KEYS) {
    const value = raw[key]
    if (Number.isInteger(value) && value > 0) out[key] = value
  }
  return out
}

/**
 * v0.9.2「失败后重启」的续跑记录（`run.json.restart`）。
 *
 * 新 run 用这份 meta 说明「我从哪个终态 run 续出来、旧 run 为什么失败、这是第几次
 * 续跑、从哪个节点开始、哪些节点已完成而跳过」。读路径宽松（形状坏就整条省略），
 * 写路径严格（`validateMetaPatch` 校验 fromRunId / attempt）。
 */
const RESTART_TEXT_MAX_CHARS = 2000
const RESTART_NOTE_MAX_CHARS = 500
const RESTART_NODE_IDS_MAX = 512

function normalizeRestart(raw) {
  if (!isPlainObject(raw)) return null
  const fromRunId = typeof raw.fromRunId === 'string' && checkRunId(raw.fromRunId) ? raw.fromRunId : null
  if (fromRunId === null) return null
  const out = {
    fromRunId,
    attempt: Number.isInteger(raw.attempt) && raw.attempt >= 1 ? raw.attempt : 1,
  }
  if (raw.oldStatus === 'failed' || raw.oldStatus === 'aborted') out.oldStatus = raw.oldStatus
  if (typeof raw.oldReason === 'string' && raw.oldReason !== '') {
    out.oldReason = raw.oldReason.length > RESTART_TEXT_MAX_CHARS
      ? raw.oldReason.slice(0, RESTART_TEXT_MAX_CHARS)
      : raw.oldReason
  }
  if (typeof raw.startNodeId === 'string' && checkRunId(raw.startNodeId)) out.startNodeId = raw.startNodeId
  if (Array.isArray(raw.skippedNodeIds)) {
    out.skippedNodeIds = [...new Set(raw.skippedNodeIds
      .filter(item => typeof item === 'string' && checkRunId(item)))]
      .slice(0, RESTART_NODE_IDS_MAX)
  }
  if (Array.isArray(raw.inheritedNodeIds)) {
    out.inheritedNodeIds = [...new Set(raw.inheritedNodeIds
      .filter(item => typeof item === 'string' && checkRunId(item)))]
      .slice(0, RESTART_NODE_IDS_MAX)
  }
  if (typeof raw.note === 'string' && raw.note.trim() !== '') {
    out.note = raw.note.trim().slice(0, RESTART_NOTE_MAX_CHARS)
  }
  if (typeof raw.at === 'string' && raw.at !== '') out.at = raw.at.slice(0, 64)
  // 0.11 R2：准入 429 后保留可重试标记；同一个 childRunId 下一次 restart 复用它。
  if (isPlainObject(raw.startRejected)) {
    const rejected = raw.startRejected
    out.startRejected = {
      code: typeof rejected.code === 'string' && rejected.code !== '' ? rejected.code.slice(0, 64) : 'RUN_CONCURRENCY_LIMIT',
      reason: typeof rejected.reason === 'string' ? rejected.reason.slice(0, 64) : 'queue-full',
      at: typeof rejected.at === 'string' ? rejected.at.slice(0, 64) : '',
      retryable: rejected.retryable !== false,
    }
  }
  return out
}

/** 节点会话模式（07 §3）：未知值一律 null，不猜一个看起来合理的。 */
const SESSION_MODES = new Set(['top-level', 'legacy-subagent', 'injected', 'stub', 'unavailable'])
const WORKSPACE_KEYS = ['id', 'path', 'realpath', 'isGit', 'gitRoot']
const WORKTREE_KEYS = ['enabled', 'reason', 'decidedBy', 'path', 'branch', 'baseCommit', 'createdAt']
/** worktree.warnings 的边界：最多 20 条、每条 ≤500 字符（worktree 模块的告警透传）。 */
const WORKTREE_WARNINGS_MAX = 20
const WORKTREE_WARNING_MAX_CHARS = 500
/** worktree.root 的长度上限（超过就整键丢弃：截断后的绝对路径会变成错误的删除前缀）。 */
const WORKTREE_ROOT_MAX_CHARS = 2048
const SUPERVISION_KEYS = ['enabled', 'wakerSessionId', 'lastWokeAt', 'nextDueAt', 'wakes', 'failures', 'reason']
/** v0.9.2 P0：run.json.agentPreset = { value, source }（本次 run 生效的默认 preset）。 */
const AGENT_PRESET_KEYS = ['value', 'source']

function normalizeSessionMode(value) {
  return SESSION_MODES.has(value) ? value : null
}

/** 绑定对象只保留白名单里的标量键；不是对象就 null（宁可没有，也别塞半个坏对象）。 */
function normalizeBinding(value, keys) {
  if (!isPlainObject(value)) return null
  const out = {}
  for (const key of keys) {
    if (value[key] === undefined) continue
    const raw = value[key]
    if (raw === null || typeof raw === 'boolean') out[key] = raw
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw
    else if (typeof raw === 'string') out[key] = raw.length > 2048 ? raw.slice(0, 2048) : raw
  }
  return out
}

/**
 * `run.json.worktree` 的归一化：固定标量字段之外，还透传两个 worktree 模块新增的键：
 *   - `root`：**绝对路径**字符串（删除时的严格路径前缀校验依据）。非字符串 / 相对路径 /
 *     超长一律丢弃该键——截断一个绝对路径会变成错误的删除前缀，比丢掉更危险；
 *   - `warnings`：字符串数组（工作区有未提交修改 / 敏感文件不会复制等告警），
 *     非数组忽略整键；非法项（非字符串 / 空串）过滤，每条 ≤500 字符，最多 20 条。
 * 两者都可缺省；坏值只丢该键，不整条丢 worktree。
 */
function normalizeWorktree(raw) {
  if (!isPlainObject(raw)) return null
  const out = normalizeBinding(raw, WORKTREE_KEYS)
  if (typeof raw.root === 'string' && raw.root !== '' && isAbsolute(raw.root)
    && raw.root.length <= WORKTREE_ROOT_MAX_CHARS) {
    out.root = raw.root
  }
  if (Array.isArray(raw.warnings)) {
    const warnings = []
    for (const item of raw.warnings) {
      if (warnings.length >= WORKTREE_WARNINGS_MAX) break
      if (typeof item !== 'string' || item.trim() === '') continue
      warnings.push(item.length > WORKTREE_WARNING_MAX_CHARS
        ? item.slice(0, WORKTREE_WARNING_MAX_CHARS)
        : item)
    }
    out.warnings = warnings
  }
  return out
}

/**
 * 读 run.json（不加锁）。
 *
 * D1 契约：**三种情况必须区分**，不能再用 `null` 把「不存在」和「读不出来」混在一起：
 *   ① 文件不存在（ENOENT）→ 返回 `null`；只有这一种允许上层按「新建」处理；
 *   ② 内容不可解析 / 不是 JSON 对象 → 抛 RunError(500, code=EBADJSON)；
 *   ③ 超过 `MAX_META_BYTES` → 抛 RunError(500, code=EMETATOOLARGE)。
 * 其它 IO 错误（EISDIR / EACCES / …）同样抛结构化 RunError，并带上原始 `code`，
 * 供 `listRuns` 生成可读的 skipped 原因。
 *
 * 调用方口径：只读接口（readRunMeta / readEvents / readAllEvents / readRunDetail）
 * 捕获后按「不存在」回 null；`writeRunMeta` 捕获后**拒绝覆盖**（D1 的核心）。
 *
 * @returns {Promise<object | null>}
 */
async function readMetaUnlocked(loc) {
  let text
  try {
    text = await readFile(metaPath(loc.dir), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw new RunError(500, 'run', describeMetaError(error), {
      code: error && typeof error.code === 'string' ? error.code : 'EMETAIO',
      cause: error,
    })
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_META_BYTES) {
    throw new RunError(
      500,
      'run',
      `run.json 超过 1MiB 上限（实际 ${bytes} 字节），元数据异常`,
      { code: 'EMETATOOLARGE', bytes },
    )
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new RunError(500, 'run', 'run.json 内容损坏：不是合法 JSON（无法解析）', {
      code: 'EBADJSON',
      cause: error,
    })
  }
  if (!isPlainObject(parsed)) {
    throw new RunError(500, 'run', 'run.json 内容损坏：不是合法 JSON 对象', { code: 'EBADJSON' })
  }
  return normalizeMeta(parsed, loc.id)
}

/** D1：损坏 run.json 的备份文件名前缀。 */
const CORRUPT_META_PREFIX = 'run.json.corrupt-'

let tmpCounter = 0

/**
 * G2-c：原子写临时文件的名字特征。崩溃 / 满盘后可能留下 0600 的 `*.tmp-*`，
 * 启动恢复要把它们清掉（每次失败都留一份会放大满盘）。
 */
const TMP_FILE_RE = /\.tmp-\d+-\d+$/

/**
 * G2-c：可注入的写函数（**只给测试用**，生产不调用）。
 *
 * 满盘（ENOSPC / EFBIG）没法在单元测试里可靠复现：`ulimit -f` 触发的是 SIGXFSZ，
 * 直接杀进程，测不到「catch 里的两条写也失败」这条分支。这里留一个显式注入点，
 * 让测试把 `writeFile(tmp)` 换成「抛 ENOSPC 的假写函数」。默认 null = 走真实 fs。
 */
let writeFileHook = null
export function __setWriteFileHook(hook) {
  writeFileHook = typeof hook === 'function' ? hook : null
}

async function writeFileWith(path, data, options) {
  if (writeFileHook) return writeFileHook(path, data, options)
  return writeFile(path, data, options)
}

/**
 * G2-c：原子写（临时文件 + rename），**任何一步失败都 unlink 临时文件**。
 *
 * 旧实现把 `writeFile(tmp)` 放在 try 之外：写一半失败（满盘）就把 0600 的
 * `*.tmp-*` 永久留在 run 目录里，下一次再写再留一份。
 */
async function writeTempAtomic(path, text) {
  // 为什么带一次重试：`cleanupTempFiles`（插件挂载时的启动恢复，见 index.js 的
  // repairRunStates / sweepExpiredLeases）会清掉 run 目录里的 `*.tmp-*`。它和
  // 「另一个引擎正在写 run.json」并发时，可能在 write 与 rename 之间把临时文件删掉，
  // rename 于是 ENOENT；旧实现把这个 ENOENT 当存储故障，`appendEvents` 的 catch
  // 会把 run 直接标成 failed——事件流里明明是 run/end done，run.json 却是 failed。
  // 临时文件的名字每次都是新的，所以「换个名字重写一次」就能自愈；除 ENOENT 之外
  // （满盘 ENOSPC、权限 EACCES、目标目录被删）重试没有意义，直接抛出。
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
    let renamed = false
    try {
      await writeFileWith(tmp, text, { encoding: 'utf8', mode: FILE_MODE })
      await rename(tmp, path)
      renamed = true
      await chmod(path, FILE_MODE).catch(() => {})
      return path
    } catch (error) {
      lastError = error
      if (!error || error.code !== 'ENOENT') break
    } finally {
      if (!renamed) await unlink(tmp).catch(() => {})
    }
  }
  throw lastError
}

/**
 * G2-a：目标 JSONL 文件末尾是不是缺一个换行？
 *
 * 崩溃 / 写满可能留下「半行」（最后一个字节不是 `\n`）。以前 `open('a')` 直接追加整行，
 * 新事件会粘在坏行后面一起被读侧 skip；现在追加前先看最后一个字节，缺就先补 `\n`。
 * 文件不存在 / 为空不补（不需要凭空造一个空行）。
 */
async function needsLeadingNewline(path) {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
  if (!info.isFile() || info.size === 0) return false
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(1)
    const { bytesRead } = await handle.read(buffer, 0, 1, info.size - 1)
    return bytesRead === 1 && buffer[0] !== 0x0a
  } finally {
    await handle.close()
  }
}

async function writeMetaUnlocked(loc, meta) {
  await ensureDirMode(loc.dir)
  const text = `${JSON.stringify(meta, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_META_BYTES) {
    throw new RunError(500, 'run', 'run.json 超过 1MiB，元数据异常')
  }
  await writeTempAtomic(metaPath(loc.dir), text)
  return meta
}

/**
 * D1：把读不出来的 run.json **原样复制**一份到 `run.json.corrupt-<时间戳>-<短哈希>`。
 *
 * - 只复制、不搬走：原文件必须保持原样（要求「保持原文件不动」）；
 * - 同一份损坏内容只备份一次（按内容哈希去重）：live 刷新每次失败都会再走一遍
 *   `writeRunMeta`，不去重会在 run 目录里堆出成百上千份备份。
 *
 * @returns {Promise<string | null>} 备份文件名（不含目录）；无法备份时 null
 */
async function backupCorruptMeta(loc) {
  let bytes
  try {
    bytes = await readFile(metaPath(loc.dir))
  } catch {
    // run.json 是目录 / 权限拒绝 → 没有内容可备份，交由调用方给出人工处理路径。
    return null
  }
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  let names = []
  try {
    names = await readdir(loc.dir)
  } catch {
    names = []
  }
  const existing = names.find(name => name.startsWith(CORRUPT_META_PREFIX) && name.endsWith(`-${hash}`))
  if (existing) return existing
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `${CORRUPT_META_PREFIX}${stamp}-${hash}`
  try {
    await writeFile(join(loc.dir, name), bytes, { mode: FILE_MODE, flag: 'wx' })
    await chmod(join(loc.dir, name), FILE_MODE).catch(() => {})
    return name
  } catch (error) {
    if (error && error.code === 'EEXIST') return name
    return null
  }
}

/** D1：把「run.json 存在但读不出来」包装成可读的 RunError（含恢复路径，不含绝对路径）。 */
function corruptMetaError(cause, backupName) {
  const base = cause && cause.reason ? cause.reason : 'run.json 存在但读不出来'
  const recovery = backupName
    ? `原内容已另存为 ${backupName}，run.json 保持原样未改动；请人工修复 run.json 或从该备份恢复后重试`
    : 'run.json 保持原样未改动；请人工检查该文件（可能是目录 / 权限问题）后重试'
  return new RunError(
    500,
    'run',
    `${base}；为保护元数据，本次拒绝用默认值覆盖。${recovery}`,
    { code: 'EMETACORRUPT', backup: backupName || null, cause },
  )
}

/**
 * D3：`writeRunMeta` 认得的全部元数据键。
 *
 * 只有这些键会进 `normalizeMeta`；其余键仍然丢弃，但会通过返回值的
 * `droppedKeys`（不可枚举属性，不落盘、不进 API 形状）暴露出来，避免
 * 「静默丢字段」类故障再次发生。
 */
const META_FIELD_KEYS = new Set([
  'id', 'name', 'flowId', 'flowName', 'status', 'started', 'engine',
  'startedAt', 'endedAt', 'nodeDone', 'nodeTotal', 'tokenTotal', 'eventCount',
  'lastSeq', 'seq', 'unkeyedCalls', 'tokenTotalApprox', 'createdAt', 'updatedAt',
  'progress', 'live', 'input', 'inbox',
  // 07 §4/§5/§7 运行绑定 + 07 §11 节点自审状态（D3 白名单）
  'sessionMode', 'workspace', 'worktree', 'supervision', 'agentPreset', 'nodeStatus',
  'nodeStatusTruncated', 'sessions',
  // 06 §13.8：创建 run 时记下的发起参数（runtime.patchRunJson 的唯一写路径）
  'startOptions',
  // G2 额外契约：引擎侧写入的超时配置（{ runTimeoutMs?, nodeTimeoutMs? }，可选正整数）
  'limits',
  // D4：engine 状态机快照（{ version, snapshot?, savedAt? }）+ 裁剪标志。
  // `machineTruncated` 显式出现时必须是布尔或 null（false / null 表示清除）。
  'machine', 'machineTruncated',
  // v0.9.2：失败后重启的续跑记录（runtime.restart 写入；形状见 normalizeRestart）。
  'restart',
])

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

/**
 * D3：写路径上的严格类型校验（只校验 patch 里**显式出现**的键）。
 *
 * 读路径保持宽松（坏值收敛成 null / 跳过），否则一份手改坏的 run.json 会让整个
 * run 不可读；写路径则必须报错——「静默丢字段」正是这次要消除的故障类型。
 */
function validateMetaPatch(patch) {
  if (hasOwn(patch, 'status') && !ALL_STATUS.has(patch.status)) {
    throw new RunError(400, 'status', `status 必须是 ${[...ALL_STATUS].join(' / ')} 之一`)
  }
  if (hasOwn(patch, 'sessionMode') && patch.sessionMode !== null && !SESSION_MODES.has(patch.sessionMode)) {
    throw new RunError(400, 'sessionMode', `sessionMode 必须是 ${[...SESSION_MODES].join(' / ')} 之一或 null`)
  }
  for (const [key, label] of [['workspace', 'workspace'], ['worktree', 'worktree'], ['supervision', 'supervision'], ['agentPreset', 'agentPreset']]) {
    if (hasOwn(patch, key) && patch[key] !== null && !isPlainObject(patch[key])) {
      throw new RunError(400, label, `${label} 必须是对象或 null`)
    }
  }
  if (hasOwn(patch, 'nodeStatus') && patch.nodeStatus !== null && !isPlainObject(patch.nodeStatus)) {
    throw new RunError(400, 'nodeStatus', 'nodeStatus 必须是对象或 null')
  }
  if (hasOwn(patch, 'nodeStatusTruncated') && typeof patch.nodeStatusTruncated !== 'boolean') {
    throw new RunError(400, 'nodeStatusTruncated', 'nodeStatusTruncated 必须是布尔值')
  }
  // v0.9.2：续跑记录。写路径严格：null 表示清除；否则必须是对象且 fromRunId 合法。
  if (hasOwn(patch, 'restart') && patch.restart !== null) {
    if (!isPlainObject(patch.restart)) {
      throw new RunError(400, 'restart', 'restart 必须是对象或 null')
    }
    if (typeof patch.restart.fromRunId !== 'string' || !checkRunId(patch.restart.fromRunId)) {
      throw new RunError(400, 'restart.fromRunId', 'restart.fromRunId 必须是合法的 runId')
    }
    if (patch.restart.attempt !== undefined
      && (!Number.isInteger(patch.restart.attempt) || patch.restart.attempt < 1)) {
      throw new RunError(400, 'restart.attempt', 'restart.attempt 必须是 ≥1 的整数')
    }
  }
  // D4：engine 状态机快照。整条替换语义，`version` 必填。
  // 注意：`snapshot` 超 24 KiB **不** 400（快照是缓存不是真相，超预算走读路径的裁剪，
  // 绝不能因为一个缓存字段让 run 的元数据写不进去）；只有形状错才 400。
  if (hasOwn(patch, 'machine') && patch.machine !== null) {
    if (!isPlainDataObject(patch.machine)) {
      throw new RunError(400, 'machine', 'machine 必须是 { version, snapshot?, savedAt? } 对象或 null')
    }
    const machine = patch.machine
    if (typeof machine.version !== 'string' || machine.version.trim() === '') {
      throw new RunError(400, 'machine',
        `machine.version 必须是 1–${MACHINE_VERSION_MAX_CHARS} 字符的非空字符串`)
    }
    if (machine.version.length > MACHINE_VERSION_MAX_CHARS) {
      throw new RunError(400, 'machine', `machine.version 超过 ${MACHINE_VERSION_MAX_CHARS} 字符`)
    }
    if (hasOwn(machine, 'snapshot') && !isPlainDataObject(machine.snapshot)) {
      throw new RunError(400, 'machine',
        'machine.snapshot 必须是普通对象（数组 / null / 类实例都不行；清空快照请省略该键）')
    }
  }
  // D4：`machineTruncated` 是布尔标志；显式 `false` / `null` 都表示「清除」
  // （null 与 machine: null 一样当作清空，不算类型错）。
  if (hasOwn(patch, 'machineTruncated')
    && patch.machineTruncated !== null
    && typeof patch.machineTruncated !== 'boolean') {
    throw new RunError(400, 'machineTruncated', 'machineTruncated 必须是布尔值或 null')
  }
  // 06 §13.8：startOptions 只接受 { workspace?: string, worktree?: string }，类型错必须 400。
  if (hasOwn(patch, 'startOptions') && patch.startOptions !== null) {
    if (!isPlainObject(patch.startOptions)) {
      throw new RunError(400, 'startOptions', 'startOptions 必须是 { workspace?, worktree? } 对象或 null')
    }
    const options = patch.startOptions
    if (options.workspace !== undefined && options.workspace !== null) {
      if (typeof options.workspace !== 'string' || options.workspace.trim() === '') {
        throw new RunError(400, 'startOptions', 'startOptions.workspace 必须是非空字符串（工作区路径）')
      }
    }
    if (options.worktree !== undefined && options.worktree !== null) {
      if (typeof options.worktree !== 'string') {
        throw new RunError(400, 'startOptions', 'startOptions.worktree 必须是字符串')
      }
    }
  }
  // G2 额外契约：limits 只接受 { runTimeoutMs?: 正整数, nodeTimeoutMs?: 正整数 } 或 null。
  if (hasOwn(patch, 'limits') && patch.limits !== null) {
    if (!isPlainObject(patch.limits)) {
      throw new RunError(400, 'limits', 'limits 必须是 { runTimeoutMs?, nodeTimeoutMs? } 对象或 null')
    }
    for (const key of LIMITS_KEYS) {
      const value = patch.limits[key]
      if (value === undefined) continue
      if (!Number.isInteger(value) || value <= 0) {
        throw new RunError(400, 'limits', `limits.${key} 必须是正整数（毫秒）`)
      }
    }
  }
  if (hasOwn(patch, 'sessions') && patch.sessions !== null) {
    if (!isPlainObject(patch.sessions)) {
      throw new RunError(400, 'sessions', 'sessions 必须是 { [nodeId]: sessionId } 对象或 null')
    }
    const entries = Object.entries(patch.sessions)
    if (entries.length > MAX_META_SESSIONS) {
      throw new RunError(400, 'sessions', `节点会话表最多 ${MAX_META_SESSIONS} 项（本次 ${entries.length} 项）`)
    }
    for (const [nodeId, sessionId] of entries) {
      if (nodeId === '' || nodeId.length > MAX_SESSION_KEY_CHARS) {
        throw new RunError(400, 'sessions', `sessions 的 nodeId 必须是 1–${MAX_SESSION_KEY_CHARS} 字符的字符串`)
      }
      if (typeof sessionId !== 'string') {
        throw new RunError(400, 'sessions', `sessions[${nodeId}] 必须是字符串`)
      }
      if (sessionId.trim() === '' || sessionId.length > MAX_SESSION_VALUE_CHARS) {
        throw new RunError(400, 'sessions',
          `sessions[${nodeId}] 必须是非空字符串（≤${MAX_SESSION_VALUE_CHARS} 字符）`)
      }
    }
  }
}

function requireLoc(runsRoot, runId) {
  const loc = locate(runsRoot, runId)
  if (!loc) {
    throw new RunError(400, 'runId', 'runId 不合法（只允许字母、数字、点、下划线、连字符，1–64 位，且不能以点开头）')
  }
  return loc
}

function assertString(value, field, { max = 128, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new RunError(400, field, '缺少必填字段')
    return undefined
  }
  if (typeof value !== 'string') throw new RunError(400, field, '必须是字符串')
  if (value.trim() === '') throw new RunError(400, field, '不能为空字符串')
  if (value.length > max) throw new RunError(400, field, `超过 ${max} 字符`)
  return value
}

/**
 * 新建一个 run 目录并写入 run.json。
 *
 * @param {string} runsRoot
 * @param {{ id?: string, name: string, flowId: string, flowName?: string, nodeTotal: number }} input
 */
export async function createRun(runsRoot, input = {}) {
  const flowId = assertString(input.flowId, 'flowId', { max: 128 })
  const flowName = typeof input.flowName === 'string' && input.flowName !== ''
    ? input.flowName
    : flowId
  if (flowName.length > 200) throw new RunError(400, 'flowName', '超过 200 字符')
  const name = typeof input.name === 'string' && input.name.trim() !== ''
    ? input.name
    : flowName
  if (name.length > 200) throw new RunError(400, 'name', '超过 200 字符')
  if (!Number.isInteger(input.nodeTotal) || input.nodeTotal < 0) {
    throw new RunError(400, 'nodeTotal', '必须是非负整数')
  }

  const fixedId = input.id === undefined || input.id === null ? null : checkRunId(input.id)
  if (input.id !== undefined && input.id !== null && !fixedId) {
    throw new RunError(400, 'runId', 'runId 不合法')
  }

  await ensureDirMode(resolve(runsRoot))

  let loc = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = fixedId || newRunId()
    const next = locate(runsRoot, candidate)
    if (!next) continue
    try {
      await mkdir(next.dir, { recursive: false, mode: DIR_MODE })
      await chmod(next.dir, DIR_MODE)
      loc = next
      break
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        if (fixedId) throw new RunError(400, 'runId', 'run 已存在')
        continue
      }
      throw error
    }
  }
  if (!loc) throw new RunError(500, 'runId', '生成 runId 失败（连续冲突）')

  const now = new Date().toISOString()
  const requestedEngine = input.engine === 'stub' ? 'stub' : 'real'
  const meta = normalizeMeta({
    name,
    flowId,
    flowName,
    // 06 §13.2：建出来只是 pending，真正开跑必须走 startRun()。
    status: 'pending',
    started: false,
    engine: requestedEngine,
    startedAt: now,
    endedAt: null,
    nodeDone: 0,
    nodeTotal: input.nodeTotal,
    tokenTotal: 0,
    eventCount: 0,
    seq: 0,
    createdAt: now,
    updatedAt: now,
  }, loc.id)

  try {
    await writeMetaUnlocked(loc, meta)
  } catch (error) {
    await rm(loc.dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return meta
}

/**
 * 06 §13.2：把 `pending` 原子切成 `running`，并置持久化的 `started` 标志。
 * 不是 pending / 已经 started 一律 409（同一进程内由 withLock 串行化，两个并发 startRun
 * 只有一个能成功）。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {{ now?: Date }} [options]
 * @returns {Promise<object>} 写入后的 meta
 */
export async function startRun(runsRoot, runId, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  // 三层并发防线：进程内 withLock（快）→ 进程间 start.lock（O_EXCL，跨进程也只有一个
  // 赢家）→ 跨进程 meta.lock（与 appendEvents / writeRunMeta 串起来，避免它从旧快照
  // 写回 run.json 时把新的 started 覆盖掉）。
  return withLock(loc.id, () => withRunFileLock(loc.dir, START_LOCK_FILE, () => withMetaLock(loc, async () => {
    const meta = await readMetaUnlocked(loc)
    if (!meta) throw new RunError(404, 'runId', 'run 不存在')
    if (meta.started === true || meta.status !== 'pending') {
      throw new RunError(
        409,
        'runId',
        meta.started === true
          ? `run 已开始过（当前 ${meta.status}），v0.4 不支持断点续跑`
          : `run 不是 pending（当前 ${meta.status}），不能重复开始`,
      )
    }
    const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
      ? options.now
      : new Date()
    const next = normalizeMeta({
      ...meta,
      status: 'running',
      started: true,
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }, loc.id)
    return writeMetaUnlocked(loc, next)
  })))
}

/**
 * 06 §13.3 单写者租约：`runs/<runId>/lock.json`（pid / host / heartbeatAt / ttlMs）。
 * 过期租约由 claimLease 的接管选举 / sweepExpiredLeases 的崩溃收口清理（读接口不再删文件）。
 */

function sleep(ms) {
  return new Promise(done => { setTimeout(done, ms) })
}

function leasePath(dir) {
  return join(dir, LEASE_FILE)
}

function normalizeLease(raw) {
  if (!isPlainObject(raw)) return null
  const pid = Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null
  const host = typeof raw.host === 'string' && raw.host !== '' ? raw.host : null
  const heartbeatAt = typeof raw.heartbeatAt === 'string' && Number.isFinite(Date.parse(raw.heartbeatAt))
    ? new Date(Date.parse(raw.heartbeatAt)).toISOString()
    : null
  const ttlMs = Number.isInteger(raw.ttlMs) && raw.ttlMs > 0 ? raw.ttlMs : DEFAULT_LEASE_TTL_MS
  if (pid === null || host === null || heartbeatAt === null) return null
  const acquiredAt = typeof raw.acquiredAt === 'string' && Number.isFinite(Date.parse(raw.acquiredAt))
    ? new Date(Date.parse(raw.acquiredAt)).toISOString()
    : heartbeatAt
  const ownerId = typeof raw.ownerId === 'string' && raw.ownerId !== '' ? raw.ownerId : null
  // 0.11 审查 F1：lock.json 也带 epoch。renew / release 要拿它和 run.json.execution 对账，
  // 才能防「claim 已推进世代、但 lock.json 还是旧 owner」的崩溃窗口（同 pid@host 的 ABA）。
  const epoch = Number.isInteger(raw.epoch) && raw.epoch > 0 ? raw.epoch : null
  return {
    pid,
    host,
    ttlMs,
    acquiredAt,
    heartbeatAt,
    ...(epoch !== null ? { epoch } : {}),
    ...(ownerId ? { ownerId } : {}),
  }
}

function leaseExpired(lease, now) {
  return Date.parse(lease.heartbeatAt) + lease.ttlMs <= now.getTime()
}

function leaseOwner(lease) {
  return `${lease.pid}@${lease.host}`
}

/**
 * 0.11 R1（返工）：持久执行 fence。options 里带 ownerId / leaseEpoch（或 guard）时，
 * 存储层在**自己的锁内**复核 run.json.execution，不符就 409 LEASE_FENCED 且整批不写。
 *
 * 0.11 审查 F6：`requireActive=true` 时还要求 `execution.state === 'active'`——已收口
 * （settled / released）的世代不能再借旧 fence 追加 run 级终态。默认不查 state，因为
 * 正常收尾里「先写 run/end → 再清 live」是同一 owner 的合法两步。
 */
function fenceMatches(meta, options) {
  if (!options || (options.leaseEpoch === undefined && options.ownerId === undefined)) return true
  const current = meta && meta.execution
  if (!current) return false
  const epochOk = options.leaseEpoch === undefined
    || String(current.epoch) === String(options.leaseEpoch)
  const ownerOk = options.ownerId === undefined || current.ownerId === options.ownerId
  const stateOk = options.requireActive !== true || current.state === 'active'
  return epochOk && ownerOk && stateOk
}

function assertFence(meta, options) {
  if (!fenceMatches(meta, options)) {
    throw new RunError(409, 'runId', '执行世代已失效（lease-fenced），旧实例不能写入该 run', {
      code: 'LEASE_FENCED',
    })
  }
}

/**
 * 0.11 审查 F1：续租 / 释放的持有者比对（必须在**跨进程 meta.lock 内**用锁内读到的
 * `meta` / `lease` 调用）。
 *
 * - 调用方显式给 ownerId：lock.json 与 run.json.execution 的 ownerId 必须同时相等，epoch
 *   也不能矛盾；任一侧缺失都按「无法证明持权」处理（409），杜绝同 pid@host 的 ABA。
 * - 调用方没给 ownerId（0.10 旧调用方）：退回 pid@host；只要持久 execution 存在，就要求
 *   它与租约的 ownerId / epoch 自洽。claim 先写 execution、再发布 lock.json，两步之间崩溃
 *   会留下「execution 已是新世代、lock.json 还是旧 owner」——旧 owner 不能凭它续租/释放。
 */
function leaseHeldBy(lease, meta, options = {}) {
  const execution = meta && isPlainObject(meta.execution) ? meta.execution : null
  const explicitOwnerId = typeof options.ownerId === 'string' && options.ownerId !== '' ? options.ownerId : ''
  if (explicitOwnerId !== '') {
    if (typeof lease.ownerId !== 'string' || lease.ownerId === '' || lease.ownerId !== explicitOwnerId) {
      return false
    }
    if (!execution || typeof execution.ownerId !== 'string' || execution.ownerId === ''
      || execution.ownerId !== explicitOwnerId) {
      return false
    }
    if (Number.isInteger(execution.epoch) && Number.isInteger(lease.epoch)
      && lease.epoch !== execution.epoch) {
      return false
    }
    return true
  }
  const pid = Number.isInteger(options.pid) && options.pid > 0 ? options.pid : process.pid
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : hostname()
  if (lease.pid !== pid || lease.host !== host) return false
  if (execution) {
    // 持久 execution 存在时，ownerId 不能「丢失」：claim 一定写过它。空值 / 对不上都按
    // 无法证明持权处理（execution.ownerId 丢失 → 409）。
    if (typeof execution.ownerId !== 'string' || execution.ownerId === ''
      || execution.ownerId !== lease.ownerId) {
      return false
    }
    if (Number.isInteger(execution.epoch) && Number.isInteger(lease.epoch)
      && lease.epoch !== execution.epoch) {
      return false
    }
  }
  return true
}

/**
 * 原子创建（O_EXCL）：只在文件不存在时成功，用来做**跨进程**互斥。
 * 返回 true = 抢到；false = 别人已持有。目录不存在会先建（0700）。
 */
async function createExclusive(path, text) {
  let handle
  try {
    handle = await open(path, 'wx', FILE_MODE)
  } catch (error) {
    if (error && error.code === 'EEXIST') return false
    if (error && error.code === 'ENOENT') {
      await ensureDirMode(dirname(path))
      handle = await open(path, 'wx', FILE_MODE).catch(inner => {
        if (inner && inner.code === 'EEXIST') return null
        throw inner
      })
      if (!handle) return false
    } else {
      throw error
    }
  }
  let writeError = null
  try {
    await handle.writeFile(text)
  } catch (error) {
    writeError = error
  } finally {
    await handle.close().catch(() => {})
  }
  if (writeError) {
    // G2-c：写锁内容失败（满盘等）不能留下一个 0 字节锁文件——那会让下一个持有者
    // 解析失败、把锁当成「不可用」。失败即删，错误照常抛出。
    await unlink(path).catch(() => {})
    throw writeError
  }
  await chmod(path, FILE_MODE).catch(() => {})
  return true
}

/**
 * 陈旧锁接管选举：先写一个带 `(毫秒, pid, 序号)` 的意图文件，等一个选举窗口，
 * 再读目录里所有未过期意图，按文件名全序取最小者。
 *
 * 为什么不是「读 → rename 搬走」：**那不是 CAS**。A 读到「过期租约」的瞬间，B 可能刚把
 * 同一路径换成新租约；A 随后 rename 搬走的就是 B 的新锁，而 B 仍以为自己持有 —— 两个赢家。
 * 选举不碰锁本身：所有并发接管者先在「谁有资格接管」上达成一致（全序比较），
 * 只有最小者去删旧锁 / 建新锁，其余等一个窗口后重读（通常已被新租约挡住 → 409）。
 *
 * @returns {Promise<boolean>} true = 本进程赢得接管权
 */
async function winTakeoverElection(dir) {
  await ensureDirMode(dir)
  const at = Date.now()
  const name = `${TAKEOVER_PREFIX}${String(at).padStart(16, '0')}-${String(process.pid).padStart(8, '0')}-${String(tmpCounter++).padStart(4, '0')}`
  const mine = join(dir, name)
  await writeFile(mine, `${process.pid}\n`, { encoding: 'utf8', mode: FILE_MODE })
  try {
    await sleep(TAKEOVER_ELECTION_MS)
    let names = []
    try {
      names = await readdir(dir)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    const alive = []
    for (const entry of names) {
      if (!entry.startsWith(TAKEOVER_PREFIX)) continue
      const ms = Number(entry.slice(TAKEOVER_PREFIX.length).split('-')[0])
      if (!Number.isFinite(ms)) continue
      if (Date.now() - ms > TAKEOVER_STALE_MS) {
        await unlink(join(dir, entry)).catch(() => {})
        continue
      }
      alive.push(entry)
    }
    alive.sort()
    return alive.length > 0 && alive[0] === name
  } finally {
    await unlink(mine).catch(() => {})
  }
}

/**
 * 清理陈旧锁：先确认陈旧，再打赢接管选举，再二次确认仍然陈旧，才删掉。
 * 二次确认是为了挡住「选举期间锁已经被别人换成新的」这一小段窗口。
 *
 * @returns {Promise<boolean>} true = 锁已经不在了 / 本轮清掉了，可以重试创建
 */
async function clearStaleLock(dir, path, ttlMs) {
  const stale = async () => {
    try {
      const info = await stat(path)
      return Date.now() - info.mtimeMs > ttlMs
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw error
    }
  }
  const first = await stale()
  if (first === null) return true
  if (first === false) return false
  if (!await winTakeoverElection(dir)) return false
  const again = await stale()
  if (again === null) return true
  if (again === false) return false
  await unlink(path).catch(() => {})
  return true
}

/**
 * 进程间互斥的短临界区（startRun 这类「读-改-写」元数据的操作）。
 *
 * O_EXCL 原子创建锁文件，写入唯一 nonce；建成后等一个短窗口再复核 nonce 仍是自己的
 * （期间若被别人接管走，就不算持有、重试）。持有者崩溃留下的陈旧锁走
 * {@link clearStaleLock}（选举 + 二次确认），不会出现两个进程同时清同一把锁。
 */
async function withRunFileLock(dir, name, task, options = {}) {
  const path = join(dir, name)
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : FILE_LOCK_TTL_MS
  const waitMs = Number.isInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : FILE_LOCK_WAIT_MS
  const settleMs = Number.isInteger(options.settleMs) && options.settleMs >= 0
    ? options.settleMs
    : LOCK_SETTLE_MS
  const conflictReason = typeof options.conflictReason === 'string' && options.conflictReason !== ''
    ? options.conflictReason
    : '另一个进程正在处理这个 run，请稍后重试'
  const deadline = Date.now() + waitMs
  const nonce = `${process.pid}-${Date.now().toString(36)}-${tmpCounter++}-${Math.random().toString(36).slice(2, 8)}`
  for (;;) {
    if (await createExclusive(path, `${nonce}\n`)) {
      if (settleMs > 0) await sleep(settleMs)
      const holder = await readFile(path, 'utf8').catch(() => null)
      if (holder !== null && holder.trim() === nonce) {
        try {
          return await task()
        } finally {
          const current = await readFile(path, 'utf8').catch(() => null)
          if (current !== null && current.trim() === nonce) await unlink(path).catch(() => {})
        }
      }
      // 抢到又被并发接管走：不当成持有，退回去重试。
    } else if (await clearStaleLock(dir, path, ttlMs)) {
      continue
    }
    if (Date.now() > deadline) {
      throw new RunError(409, 'runId', conflictReason)
    }
    await sleep(8)
  }
}

/**
 * G2-b：run.json 的跨进程写锁（进程内 `withLock` 之外的二层）。
 *
 * 目录不存在时直接 404，**不**像 `createExclusive` 那样顺手把目录建回来——
 * 否则对已删除 run 的 append / writeRunMeta 会「复活」一个空目录。
 */
async function withMetaLock(loc, task) {
  let info
  try {
    info = await stat(loc.dir)
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new RunError(404, 'runId', 'run 不存在')
    throw error
  }
  if (!info.isDirectory()) throw new RunError(404, 'runId', 'run 不存在')
  return withRunFileLock(loc.dir, META_LOCK_FILE, task, {
    ttlMs: META_LOCK_TTL_MS,
    waitMs: META_LOCK_WAIT_MS,
    // meta.lock 的接管只可能发生在「陈旧锁」路径（ttl 30s），刚建好的锁不可能被接管，
    // 所以不需要 start.lock 那样的 settle 复核窗口，省掉每次写 4ms。
    settleMs: 0,
    conflictReason: 'run.json 正被另一个进程写入（跨进程锁等待超时），请稍后重试',
  })
}

/**
 * G2-d：读租约文件，**区分 ENOENT 与不可解析**。
 *
 * 旧实现把两者都折成 `null`：进程在 `open('wx')` 与写入之间被杀留下的 0 字节
 * lock.json 会被当成「没有租约」——claimLease 五次后 409、sweep 又跳过，run 永远
 * 无法重开或自动收口。现在不可解析返回 `{ kind: 'corrupt' }`，调用方按「可接管」
 * （claimLease 走 takeover 选举）或「崩溃残留」（sweep 收口）处理。
 *
 * @returns {Promise<{ kind: 'missing' } | { kind: 'corrupt', reason: string } | { kind: 'ok', lease: object }>}
 */
async function readLeaseState(dir) {
  let text
  try {
    text = await readFile(leasePath(dir), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'corrupt', reason: 'lock.json 不是合法 JSON' }
  }
  const lease = normalizeLease(parsed)
  if (!lease) return { kind: 'corrupt', reason: 'lock.json 字段不完整（pid / host / heartbeatAt）' }
  return { kind: 'ok', lease }
}

/** 兼容旧调用点：只关心「能不能拿到一份可解析的租约」。 */
async function readLeaseFile(dir) {
  const state = await readLeaseState(dir)
  return state.kind === 'ok' ? state.lease : null
}

async function writeLeaseFile(dir, lease) {
  await ensureDirMode(dir)
  const text = `${JSON.stringify(lease, null, 2)}\n`
  await writeTempAtomic(leasePath(dir), text)
}

/**
 * 删除租约文件。给了 `lease` 时先核对当前内容（避免删掉别人刚接管的新租约）：
 *   - 默认核对持有者（pid@host）与执行身份（ownerId / epoch）——续租会刷新 heartbeatAt，
 *     但持有者不变；**pid@host 相同不等于同一份租约**（0.11 审查 F1：ABA）；
 *   - `exact: true` 还要求 acquiredAt / heartbeatAt 都与传入值一致（sweep 收口用：
 *     期间若有人重新抢占过，文件已经不是它读到的那一份，不能删）。
 * 文件已经不存在 / 不可解析且没给 exact 时返回 false（不动来路不明的文件）。
 */
async function removeLeaseFile(dir, lease, options = {}) {
  if (lease) {
    let current
    try {
      current = await readLeaseFile(dir)
    } catch {
      return false
    }
    if (!current) return false
    if (leaseOwner(current) !== leaseOwner(lease)) return false
    // 0.11 审查 F1：拿 ownerId / epoch 当执行身份比对；对不上就是新 owner 的租约。
    if (typeof lease.ownerId === 'string' && lease.ownerId !== ''
      && current.ownerId !== lease.ownerId) {
      return false
    }
    if (Number.isInteger(lease.epoch) && current.epoch !== lease.epoch) return false
    if (options.exact === true
      && (current.acquiredAt !== lease.acquiredAt || current.heartbeatAt !== lease.heartbeatAt)) {
      return false
    }
  }
  try {
    await unlink(leasePath(dir))
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

function leaseOptions(options = {}) {
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
    ? options.now
    : new Date()
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0
    ? options.ttlMs
    : DEFAULT_LEASE_TTL_MS
  return {
    now,
    ttlMs,
    pid: Number.isInteger(options.pid) && options.pid > 0 ? options.pid : process.pid,
    host: typeof options.host === 'string' && options.host !== '' ? options.host : hostname(),
    // 0.11 R1：每次 claim 的随机 owner 身份；renew/release 带同一个值才允许。
    ownerId: typeof options.ownerId === 'string' && options.ownerId !== '' ? options.ownerId : randomUUID(),
  }
}

/**
 * 读当前租约。过期 / 不可解析都视为「没有有效租约」返回 null。
 *
 * G2-d：**不再顺手删文件**。以前读到过期就 unlink，后果是：
 *   - 持有者刚好在续租（就地 re-claim）时，读方把新租约删了；
 *   - sweep 再读时 `if (!lease) continue`，于是过期租约的 run 永远停在 running。
 * 过期租约的清理交给两条已具备选举/收口语义的路径：claimLease（接管选举）与
 * sweepExpiredLeases（崩溃残留收口）。
 * @returns {Promise<object | null>}
 */
export async function readLease(runsRoot, runId, options = {}) {
  const loc = locate(runsRoot, runId)
  if (!loc) return null
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date()
  let state
  try {
    state = await readLeaseState(loc.dir)
  } catch {
    return null
  }
  if (state.kind !== 'ok') return null
  if (leaseExpired(state.lease, now)) return null
  return state.lease
}

/**
 * 抢单写者租约。已有**未过期**租约（任何持有者）一律 409；过期租约可被抢。
 *
 * 互斥靠**文件系统**而不是进程内锁（06 §13.6 B1），分两条路：
 * - 没有租约：`lock.json` 用 `O_EXCL` 原子创建，两个进程同抢只有一个成功；建成后立刻
 *   回读复核（pid/host/acquiredAt 都对得上）才认账，防止刚建好就被并发接管者搬走。
 * - 租约过期：先打赢 {@link winTakeoverElection} 的接管选举（全序比较，只有一个赢家），
 *   再由赢家删旧锁并 O_EXCL 建新锁；其他进程等一个窗口后重读，通常已被新租约挡住 → 409。
 *
 * 把「读 → 搬走 → 创建」当成 CAS 是错的：读到的瞬间锁可能已被别人换成新的，搬走的就是
 * 别人的新锁。选举把这一步变成「先就谁有资格动手达成一致」。
 * @returns {Promise<object>} 新租约
 */
export async function claimLease(runsRoot, runId, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  if (!await readMetaUnlocked(loc)) throw new RunError(404, 'runId', 'run 不存在')
  const { now, ttlMs, pid, host, ownerId } = leaseOptions(options)
  const path = leasePath(loc.dir)
  // 0.11 R1（本轮）：整个 claim 在跨进程 meta.lock 内完成，并且**先**递增持久 execution、
  // **再**发布 lock.json。这样「新租约对外可见」与「旧 owner 的 fence 失效」是同一个
  // 临界区：任何在飞旧写要么先拿到 meta.lock（claim 等它写完，之后才 409），要么在
  // claim 之后拿锁（看到新 epoch 被 fence 拒绝）。不存在「新租约已可见但旧写仍提交」。
  return withLock(loc.id, () => withMetaLock(loc, async () => {
    const iso = now.toISOString()
    const lease = { pid, host, ttlMs, acquiredAt: iso, heartbeatAt: iso, ownerId }
    const busy = existing => new RunError(
      409,
      'runId',
      `该 run 正被 ${leaseOwner(existing)} 持有执行租约（心跳 ${existing.heartbeatAt}），不能重复启动`,
    )
    const state = await readLeaseState(loc.dir)
    if (state.kind === 'ok' && !leaseExpired(state.lease, now)) throw busy(state.lease)
    // 过期 / 缺失 / 损坏：先推进持久世代（旧实例的 fence 从此刻起全部失效）。
    const latest = await readMetaUnlocked(loc)
    if (!latest) throw new RunError(404, 'runId', 'run 不存在')
    const previous = latest.execution && Number.isInteger(latest.execution.epoch) ? latest.execution.epoch : 0
    const epoch = previous + 1
    latest.execution = { epoch, ownerId, state: 'active' }
    latest.updatedAt = now.toISOString()
    await writeMetaUnlocked(loc, normalizeMeta(latest, loc.id))
    lease.epoch = epoch
    // 0.11 审查 F1：epoch 进 lock.json，renew / release 才能拿它和 execution 对账。
    const text = `${JSON.stringify(lease, null, 2)}\n`
    // 让新租约对外可见：旧文件先清掉（过期/损坏），再 O_EXCL 创建。
    if (state.kind !== 'missing') await unlink(path).catch(() => {})
    if (!await createExclusive(path, text)) {
      // meta.lock 已串行化所有 claim；走到这里只能是外部异常文件，保守失败。
      throw new RunError(409, 'runId', '执行租约文件发布失败，请重试')
    }
    const current = await readLeaseFile(loc.dir)
    if (!(current && current.pid === pid && current.host === host
      && current.ownerId === ownerId && current.epoch === epoch
      && current.acquiredAt === iso)) {
      throw new RunError(409, 'runId', '执行租约刚被其它进程接管，请重试')
    }
    return lease
  }))
}

/**
 * 续租。租约不存在 / 已过期且不是本实例持有 / 不是本实例持有 → 409。
 *
 * G2-d：**过期但持有者匹配时就地 re-claim**（只刷新 heartbeatAt，保留 acquiredAt），
 * 绝不先删文件。旧实现「先 removeLeaseFile 再抛 409」会留下一个没有租约的 running run：
 * 引擎只 log warn 继续跑，sweep 因为 `if (!lease) continue` 永不收口。
 *
 * 0.11 审查 F1：整个「读 lease → 核对 owner → 写回」在**与 claimLease 同一把跨进程
 * meta.lock** 内完成，并且比对里纳入调用方 ownerId 与 run.json.execution.ownerId。
 * 旧实现只拿 pid@host 核对、写回前也不与 claim 串行：新 owner 可在两次读之间接管，
 * 随后被旧 owner 的 rename 覆盖成自己的（同进程不同 owner 甚至能直接续租成功）。
 * @returns {Promise<object>} 续租后的租约
 */
export async function renewLease(runsRoot, runId, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  const { now, ttlMs } = leaseOptions(options)
  return withLock(loc.id, () => withMetaLock(loc, async () => {
    const meta = await readMetaUnlocked(loc)
    if (!meta) throw new RunError(404, 'runId', 'run 不存在')
    const state = await readLeaseState(loc.dir)
    if (state.kind === 'missing') throw new RunError(409, 'runId', '该 run 没有执行租约，无法续租')
    if (state.kind === 'corrupt') {
      throw new RunError(409, 'runId', '执行租约文件不可解析（lock.json 损坏），不能续租；请重新启动该 run')
    }
    const existing = state.lease
    if (!leaseHeldBy(existing, meta, options)) {
      throw new RunError(409, 'runId', `执行租约由 ${leaseOwner(existing)} 持有，本实例无权续租`)
    }
    // 锁内 claim 已被串行化；这次复读只挡「有人绕过锁直接改 lock.json」。不核对就 rename
    // 会把别人的新租约覆盖成自己的——「两个赢家」。
    const check = await readLeaseState(loc.dir)
    if (check.kind !== 'ok' || !leaseHeldBy(check.lease, meta, options)
      || check.lease.acquiredAt !== existing.acquiredAt) {
      throw new RunError(409, 'runId', '执行租约已被其它实例接管或释放，本实例不能续租')
    }
    const lease = {
      ...existing,
      ttlMs,
      heartbeatAt: now.toISOString(),
    }
    await writeLeaseFile(loc.dir, lease)
    return lease
  }))
}

/**
 * 释放租约；只能释放本实例持有的（`force:true` 可强制清）。
 * 租约文件不可解析时：非 force 返回 false（无法核对持有者），force 则清掉。
 *
 * 0.11 审查 F1：与 claimLease / renewLease 共用同一把跨进程 meta.lock；非 force 时
 * 还要把调用方 ownerId 与 run.json.execution 对账，防止旧 owner 借旧 lock.json 删掉
 * 新 owner 的租约（ABA）。`force:true` 是人工/重启收口的显式逃生口，不做身份证明。
 * @returns {Promise<boolean>} 是否真的删掉
 */
export async function releaseLease(runsRoot, runId, options = {}) {
  const loc = locate(runsRoot, runId)
  if (!loc) return false
  const force = options.force === true
  try {
    return await withLock(loc.id, () => withMetaLock(loc, async () => {
      let state
      try {
        state = await readLeaseState(loc.dir)
      } catch {
        return false
      }
      if (state.kind === 'missing') return false
      if (state.kind === 'corrupt') {
        if (!force) return false
        return removeLeaseFile(loc.dir)
      }
      if (!force) {
        let meta
        try {
          meta = await readMetaUnlocked(loc)
        } catch {
          // run.json 读不出来就无法证明持权：不动租约，交给人工处理。
          return false
        }
        if (!meta) return false
        if (!leaseHeldBy(state.lease, meta, options)) {
          throw new RunError(409, 'runId', `执行租约由 ${leaseOwner(state.lease)} 持有，不能由本实例释放`)
        }
      }
      // 传入手上的这份租约：如果期间已被别人接管/释放，removeLeaseFile 会拒绝删除。
      return removeLeaseFile(loc.dir, state.lease)
    }))
  } catch (error) {
    // run 目录已被删除：旧实现按「没有可释放的租约」返回 false。
    if (error && error.status === 404) return false
    throw error
  }
}

/**
 * R1/E1：失权 epoch 的存储专用收口（0.11）。
 *
 * 引擎续租拿到 409 = 确知本实例已不是该 run 的执行者。此时旧实例**不能**再走普通的
 * `appendEvents` 收尾（那会与接管者抢写），只能调用这里：以幂等键确认本 epoch 是否
 * 已经收口过，未收口才追加**唯一**一条 `run/end failed`（reason 含 `lease-lost`、
 * `extra.code='LEASE_LOST'`、`extra.terminalScope='run'`）。
 *
 * 幂等实现：按 `extra.idempotencyKey` 扫描已落盘事件；扫描、终态判定、判权与追加在
 * **同一个 withLock + 跨进程 meta.lock 事务**里完成（0.11 审查 F6），并发/重试的相同
 * finalizer 最多落一条 end。JSONL 是追加事实日志，不重写历史行。run 已经是终态时直接
 * 返回 `idempotent:true`（不重复追加、不覆盖接管者终态）。
 *
 * 边界：本函数不负责「接管者仍在跑时只记 instance 事实」的完整跨进程投影（那需要
 * 持久 epoch + 读端统一投影，见 docs/plan/0.11-方案.md §3.3）；本实现覆盖同一进程
 * 内的失权收口与幂等重试，跨进程接管检测由租约 409 本身保证。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {{ cause?: string, reason?: string, expectedEpoch?: string|number, ownerId?: string,
 *   idempotencyKey?: string, now?: Date }} [options]
 * @returns {Promise<{ ok: boolean, appended: boolean, idempotent: boolean, event?: object, status?: string }>}
 */
export async function finalizeEpoch(runsRoot, runId, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date()
  const expectedEpoch = typeof options.expectedEpoch === 'string'
    ? options.expectedEpoch
    : (Number.isInteger(options.expectedEpoch) ? String(options.expectedEpoch) : '')
  const ownerId = typeof options.ownerId === 'string' && options.ownerId !== '' ? options.ownerId : ''
  const idempotencyKey = typeof options.idempotencyKey === 'string' && options.idempotencyKey !== ''
    ? options.idempotencyKey
    : `loss:${expectedEpoch || 'unknown'}`
  const reason = (typeof options.reason === 'string' && options.reason.trim() !== ''
    ? options.reason
    : 'lease-lost：执行租约已被其它实例接管 / 释放，本实例停止写入').slice(0, 2000)

  // 0.11 审查 F6：幂等键扫描、终态判定、判权与追加全部在**同一个跨进程锁事务**里。
  // 旧实现把扫描放在锁外：两个相同的 finalizer 都会读到「还没有 loss end」，随后各追加
  // 一条；追加前的 guard 只比 epoch/owner、不看 execution.state，第二条不会被挡住。
  return withLock(loc.id, () => withMetaLock(loc, async () => {
    const meta = await readMetaUnlocked(loc)
    if (!meta) throw new RunError(404, 'runId', 'run 不存在')
    const all = await readAllEventsUnlocked(loc, meta)
    const existing = all.events.filter(event => event && event.kind === 'run/end'
      && event.extra && event.extra.idempotencyKey === idempotencyKey)
    if (existing.length > 0) {
      return { ok: true, appended: false, idempotent: true, event: existing[existing.length - 1] }
    }
    if (TERMINAL_STATUS.has(meta.status)) {
      // 接管者 / 旧路径已经写了终态：不覆盖，只报告幂等。
      return { ok: true, appended: false, idempotent: true, status: meta.status }
    }
    // 判权用锁内读到的 meta：当前 epoch 仍是本实例的、且该世代尚未收口（state=active），
    // 才能把整个 run 收成 failed；否则只留下 instance 范围的失权审计事实。
    const ownsEpoch = fenceMatches(meta, {
      ownerId: ownerId || undefined,
      leaseEpoch: expectedEpoch || '0',
      requireActive: true,
    })
    const terminalScope = ownsEpoch ? 'run' : 'instance'
    const event = {
      v: 1,
      ts: now.toISOString(),
      runId: loc.id,
      memberId: null,
      kind: 'run/end',
      traceId: `tr-${String(loc.id).slice(0, 80)}-run`,
      data: { status: 'failed', reason },
      extra: {
        code: 'LEASE_LOST',
        leaseLost: true,
        cause: typeof options.cause === 'string' && options.cause !== '' ? options.cause : 'lease-lost',
        idempotencyKey,
        terminalScope,
        ...(expectedEpoch !== '' ? { leaseEpoch: expectedEpoch } : {}),
        ...(ownerId !== '' ? { ownerId } : {}),
      },
    }
    const appended = await appendEventsInLock(loc, [event], { now })
    return {
      ok: true,
      appended: true,
      idempotent: false,
      terminalScope,
      event: appended.events[0] || event,
      status: terminalScope === 'run' ? 'failed' : meta.status,
    }
  }))
}

/**
 * 0.11 R5（返工）：构造宿主证据验证器（index / runtime 共用同一实现）。
 * 事件可信元数据优先读扁平键（extra 有界化只保留标量），并重读持久化报告副本核对 sha256。
 *
 * @param {object[]} records 私有 verification 登记
 * @param {object[]} events 该 run 的全部事件
 * @param {string} runId
 * @param {string} runDir runs/<runId> 绝对路径
 * @returns {(event: object) => boolean}
 */
export function buildHostExecutionVerifier(records, events, runId, runDir) {
  const byId = new Map()
  for (const record of records || []) {
    if (record && typeof record.executionId === 'string') byId.set(record.executionId, record)
  }
  const reportCopies = new Map()
  for (const event of events || []) {
    if (!event || event.kind !== 'artifact/write' || !event.data) continue
    const extra = event.extra && typeof event.extra === 'object' ? event.extra : {}
    const nested = extra.verification && typeof extra.verification === 'object' ? extra.verification : {}
    const executionId = typeof extra.verificationId === 'string' ? extra.verificationId : nested.executionId
    const kind = typeof extra.verificationKind === 'string' ? extra.verificationKind : nested.kind
    if (typeof executionId !== 'string' || executionId === '' || kind !== 'report-copy') continue
    if (typeof event.data.path === 'string') reportCopies.set(executionId, event.data.path)
  }
  return event => {
    const extra = event && event.extra && typeof event.extra === 'object' ? event.extra : {}
    const nested = extra.verification && typeof extra.verification === 'object' ? extra.verification : {}
    const executionId = typeof extra.verificationId === 'string' ? extra.verificationId : nested.executionId
    if (typeof executionId !== 'string' || executionId === '') return false
    const record = byId.get(executionId)
    if (!record || record.runId !== runId) return false
    if (typeof record.nodeId === 'string' && record.nodeId !== '' && event.nodeId !== record.nodeId) return false
    if (Number.isInteger(record.attempt) && event.attemptId !== record.attempt) return false
    if (typeof record.reportSha256 === 'string' && record.reportSha256 !== '') {
      const rel = reportCopies.get(executionId)
      if (!rel) return false
      try {
        const body = readFileSync(join(runDir, rel))
        const digest = createHash('sha256').update(body).digest('hex')
        if (digest !== record.reportSha256) return false
      } catch {
        return false
      }
    }
    return true
  }
}

// ---------------------------------------------------------------------------
// 0.11 R5（F4）：受保护的宿主执行登记与防伪凭证
// ---------------------------------------------------------------------------

/** 只有 createHostExecutionReceipt() 造出来的对象才在 WeakSet 里（能力凭证）。 */
const HOST_EXECUTION_RECEIPTS = new WeakSet()

/**
 * 造一张宿主执行凭证。真实调用点只有引擎在 runHostCheck 真正返回之后；
 * 模型 / HTTP / 普通 artifact writer 都拿不到这个对象。
 * @param {string} executionId
 * @returns {object} 冻结的凭证
 */
export function createHostExecutionReceipt(executionId) {
  if (typeof executionId !== 'string' || executionId === '') {
    throw new RunError(400, 'executionId', '宿主执行凭证需要非空 executionId')
  }
  const receipt = Object.freeze({ executionId, nonce: randomUUID() })
  HOST_EXECUTION_RECEIPTS.add(receipt)
  return receipt
}

function verificationDir(dir, executionId) {
  if (typeof executionId !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(executionId)) return null
  return join(dir, 'verification', executionId)
}

/**
 * 登记一次宿主执行：只有持凭证的调用方才能写入私有 verification/<executionId>/record.json。
 * 普通 artifact/write / HTTP 通道无法登记，因此 producer='host' 字符串本身不授信。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {object} record 宿主执行记录（必须含 executionId / runId / nodeId / attempt）
 * @param {{ receipt: object, reportBytes?: Buffer }} [options]
 */
export async function recordHostExecution(runsRoot, runId, record, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  const receipt = options.receipt
  if (!receipt || !HOST_EXECUTION_RECEIPTS.has(receipt)) {
    throw new RunError(403, 'verification', '没有宿主执行凭证，不能登记可信执行')
  }
  if (!isPlainObject(record) || typeof record.executionId !== 'string' || record.executionId === '') {
    throw new RunError(400, 'verification', '宿主执行记录缺少 executionId')
  }
  if (receipt.executionId !== record.executionId) {
    throw new RunError(403, 'verification', '宿主执行凭证与记录不匹配')
  }
  const dir = verificationDir(loc.dir, record.executionId)
  if (!dir) throw new RunError(400, 'verification', 'executionId 不合法')
  await ensureDirMode(dir)
  const bounded = {
    executionId: record.executionId,
    runId: loc.id,
    nodeId: typeof record.nodeId === 'string' ? record.nodeId : '',
    attempt: Number.isInteger(record.attempt) ? record.attempt : null,
    checkId: typeof record.checkId === 'string' ? record.checkId.slice(0, 128) : '',
    commandDigest: typeof record.commandDigest === 'string' ? record.commandDigest : '',
    expectedExitCode: Number.isInteger(record.expectedExitCode) ? record.expectedExitCode : null,
    exitCode: Number.isInteger(record.exitCode) ? record.exitCode : null,
    state: record.state === 'pass' || record.state === 'fail' || record.state === 'skipped' ? record.state : 'fail',
    reasonCode: typeof record.reasonCode === 'string' ? record.reasonCode.slice(0, 128) : null,
    reportPath: typeof record.reportPath === 'string' ? record.reportPath.slice(0, 512) : null,
    reportSha256: typeof record.reportSha256 === 'string' ? record.reportSha256 : null,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : null,
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : null,
    recordedAt: new Date().toISOString(),
  }
  const text = `${JSON.stringify(bounded, null, 2)}\n`
  await writeTempAtomic(join(dir, 'record.json'), text)
  return { path: `${record.executionId}/record.json`, record: bounded }
}

/**
 * 读一个 run 的全部宿主执行登记（损坏条目跳过；最多 200 条）。
 * @returns {Promise<object[]>}
 */
export async function readHostExecutions(runsRoot, runId) {
  const loc = locate(runsRoot, runId)
  if (!loc) return []
  let entries
  try {
    entries = await readdir(join(loc.dir, 'verification'), { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9._-]{1,96}$/.test(entry.name)) continue
    try {
      const parsed = JSON.parse(await readFile(join(loc.dir, 'verification', entry.name, 'record.json'), 'utf8'))
      if (!isPlainObject(parsed) || parsed.executionId !== entry.name) continue
      out.push(parsed)
    } catch {
      // 坏记录不授信。
    }
    if (out.length >= 200) break
  }
  return out
}

/**
 * 启动清理时「多大的 `*.tmp-*` 才算遗留」：默认只删 60 秒之前的。
 *
 * 原子写的临时文件生命周期是**毫秒级**（write → rename），所以 60 秒还没消失的
 * 一定是崩溃 / 满盘留下的。反过来，如果无条件全删，就会把**正在写**的临时文件
 * 一起删掉：插件挂载时的启动恢复（`repairRunStates` / `sweepExpiredLeases`，
 * 见 index.js）是 fire-and-forget，可能与另一个引擎的 `appendEvents` 并发——
 * 那条路径上的 rename 会 ENOENT，`appendEvents` 的 catch 就把一个**已经跑完**的
 * run 标成 failed（事件流里是 run/end done）。年龄闸门是这个 bug 的根因修复。
 */
export const TMP_SWEEP_MIN_AGE_MS = 60_000

/**
 * G2-c：清理 run 目录下遗留的 `*.tmp-*`（崩溃 / 满盘留下的 0600 临时文件）。
 *
 * 只扫 run 根目录与一层节点目录；默认只删 {@link TMP_SWEEP_MIN_AGE_MS} 之前的
 * （按 mtime），正在写的临时文件不动。清理只在启动恢复阶段调用
 * （sweep / repairRunStates）。
 *
 * @param {string} runsRoot
 * @param {string} [runId] 省略时清理 runsRoot 下所有 run
 * @param {{ minAgeMs?: number, now?: Date }} [options] `minAgeMs: 0` = 不做年龄闸门（测试用）
 * @returns {Promise<string[]>} 被删掉的相对路径（`<runId>/<name>`）
 */
export async function cleanupTempFiles(runsRoot, runId, options = {}) {
  const root = resolve(runsRoot)
  const minAgeMs = Number.isFinite(options.minAgeMs) && options.minAgeMs >= 0
    ? options.minAgeMs
    : TMP_SWEEP_MIN_AGE_MS
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date()
  const targets = []
  if (runId !== undefined && runId !== null) {
    const loc = locate(root, runId)
    if (!loc) return []
    targets.push(loc)
  } else {
    let dirents = []
    try {
      dirents = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    for (const entry of dirents) {
      if (!entry.isDirectory() || !checkRunId(entry.name)) continue
      const loc = locate(root, entry.name)
      if (loc) targets.push(loc)
    }
  }
  const removed = []
  const sweepDir = async (dir, prefix) => {
    let names = []
    try {
      names = await readdir(dir)
    } catch (error) {
      // ENOENT：目录已被删；ENOTDIR：同名路径是个普通文件（坏 run 的常见形态）。
      // 都不是清理失败，跳过即可。
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return
      throw error
    }
    for (const name of names) {
      if (!TMP_FILE_RE.test(name)) continue
      const path = join(dir, name)
      // 年龄闸门：正在写的临时文件（mtime 就在刚才）不动，否则会把别人的原子写删掉。
      let info
      try {
        info = await stat(path)
      } catch (error) {
        if (error && error.code === 'ENOENT') continue
        throw error
      }
      if (now.getTime() - info.mtimeMs < minAgeMs) continue
      try {
        await unlink(path)
        removed.push(`${prefix}${name}`)
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error
      }
    }
  }
  for (const loc of targets) {
    await sweepDir(loc.dir, `${loc.id}/`)
    let names = []
    try {
      names = await readdir(loc.dir)
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue
      throw error
    }
    for (const name of names) {
      if (!checkRunId(name)) continue
      await sweepDir(join(loc.dir, name), `${loc.id}/${name}/`)
    }
  }
  return removed
}

/**
 * G2-a：扫事件文件，把 `run.json.seq` / `lastSeq` / `eventCount` 修到磁盘真实值。
 *
 * 为什么要修：`appendEvents` 以前先写事件、最后写 meta，进程在两步之间被杀时磁盘
 * 上事件的 seq 已超前于 `meta.seq`；启动时若直接用旧 `meta.seq` 续写 run/end，就会
 * 产生重复 seq（读侧按「文件内 seq 单调」增量读，重复后会永久丢一条）。
 *
 * 现在的口径：
 *   - `eventCount` = 磁盘上**实际可解析的事件行数**（坏行只进 `skipped`）；
 *   - `seq` / `lastSeq` = `max(meta 里已有的 seq, 磁盘事件 max(seq))`——既修「事件超前」
 *     也绝不回退，避免复用「已分配但还没落事件」的 seq 区间（允许空洞，禁止重复）。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @returns {Promise<{ repaired: boolean, seq: number, eventCount: number, skipped: number, files: number }>}
 */
export async function repairRunCounters(runsRoot, runId) {
  const loc = requireLoc(runsRoot, runId)
  return withLock(loc.id, () => withMetaLock(loc, async () => {
    const meta = await readMetaUnlocked(loc)
    if (!meta) throw new RunError(404, 'runId', 'run 不存在')
    const scan = await scanEventFiles(loc)
    const nextSeq = Math.max(meta.seq, meta.lastSeq, scan.maxSeq)
    const repaired = meta.eventCount !== scan.count || meta.seq !== nextSeq || meta.lastSeq !== nextSeq
    if (!repaired) {
      return { repaired: false, seq: nextSeq, eventCount: scan.count, skipped: scan.skipped, files: scan.files }
    }
    const next = normalizeMeta({
      ...meta,
      seq: nextSeq,
      lastSeq: nextSeq,
      eventCount: scan.count,
    }, loc.id)
    await writeMetaUnlocked(loc, next)
    return { repaired: true, seq: nextSeq, eventCount: scan.count, skipped: scan.skipped, files: scan.files }
  }))
}

/** G2-a：只读扫一遍事件文件，数「可解析事件行数」与 max(seq)。 */
async function scanEventFiles(loc) {
  const files = await listEventFiles(loc)
  let count = 0
  let skipped = 0
  let maxSeq = 0
  for (const file of files) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') continue
      throw error
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let event
      try {
        event = JSON.parse(trimmed)
      } catch {
        skipped += 1
        continue
      }
      if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        skipped += 1
        continue
      }
      count += 1
      if (Number.isInteger(event.seq) && event.seq > maxSeq) maxSeq = event.seq
    }
  }
  return { count, skipped, maxSeq, files: files.length }
}

/**
 * 启动时清理过期租约：**只扫 `running`**，把「引擎崩溃」的 run 标 failed，
 * reason 含「引擎中断」。返回被处理的 runId。
 *
 * G2-d：收口条件不止「租约有但过期」：
 *   - 无租约文件（started=true）→ 崩溃残留（旧实现 `if (!lease) continue` 永不收口）；
 *   - 租约不可解析（0 字节 / 坏 JSON，started=true）→ 同样按崩溃残留收口，并把坏文件删掉。
 * 另外收口前先 `repairRunCounters()`，否则续写 run/end 会沿用超前的旧 meta.seq 产生重复。
 * @returns {Promise<string[]>}
 */
export async function sweepExpiredLeases(runsRoot, options = {}) {
  const root = resolve(runsRoot)
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date()
  let dirents = []
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const recovered = []
  for (const entry of dirents) {
    if (!entry.isDirectory() || !checkRunId(entry.name)) continue
    const loc = locate(root, entry.name)
    if (!loc) continue
    await cleanupTempFiles(root, loc.id).catch(() => {})
    const meta = await readMetaUnlocked(loc).catch(() => null)
    if (!meta || meta.status !== 'running') continue
    let state
    try {
      state = await readLeaseState(loc.dir)
    } catch {
      // 租约文件读不出来（EACCES 等）：不猜，交给人工 / 下一轮。
      continue
    }
    let lease = null
    let reason = ''
    if (state.kind === 'ok') {
      if (!leaseExpired(state.lease, now)) continue
      lease = state.lease
      reason = `引擎中断：执行租约过期（${leaseOwner(lease)}，心跳 ${lease.heartbeatAt}），不自动续跑`
    } else {
      // `started !== true` 的 running 壳子不是崩溃残留（与旧口径一致：只收 started 的 run）。
      if (meta.started !== true) continue
      if (state.kind === 'missing') {
        reason = '引擎中断：run 处于 running 但执行租约文件缺失（崩溃残留），不自动续跑'
      } else {
        reason = `引擎中断：执行租约文件不可解析（${state.reason || 'lock.json 损坏'}），按崩溃残留收口，不自动续跑`
      }
    }
    try {
      // G2-a：先修正计数器，再允许续写终态事件（否则 seq 会从旧值重复）。
      await repairRunCounters(root, loc.id).catch(() => null)
      await appendEvents(runsRoot, loc.id, [{
        v: 1,
        kind: 'run/end',
        traceId: `tr-${loc.id.slice(0, 80)}-sweep`,
        data: { status: 'failed', reason: reason.slice(0, 2000) },
        extra: { recovered: true, engineInterrupted: true, leaseExpired: Boolean(lease) },
      }], { now })
    } catch (error) {
      await markStorageFailure(loc, error).catch(() => {})
      await writeRunMeta(runsRoot, loc.id, {
        status: 'failed',
        endedAt: now.toISOString(),
        live: null,
      }).catch(() => {})
    }
    if (lease) {
      // 只删「它当时读到的那一份」：期间若被别的实例重新抢占，新租约必须留着。
      await removeLeaseFile(loc.dir, lease, { exact: true }).catch(() => {})
    } else {
      // 无租约 / 坏租约：收口后再确认一次——期间若有人合法接管了，不删它的新租约。
      const now2 = await readLeaseState(loc.dir).catch(() => null)
      if (!now2 || now2.kind !== 'ok') await removeLeaseFile(loc.dir).catch(() => {})
    }
    recovered.push(loc.id)
  }
  return recovered
}

/**
 * 06 §13.4：启动时修复「run.jsonl 已经有 run/end，但 run.json 还是非终态」的不一致。
 * 只读 run.jsonl（不碰节点文件），返回修复过的 runId。
 * @returns {Promise<string[]>}
 */
export async function repairRunStates(runsRoot, options = {}) {
  const root = resolve(runsRoot)
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date()
  let dirents = []
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const repaired = []
  for (const entry of dirents) {
    if (!entry.isDirectory() || !checkRunId(entry.name)) continue
    const loc = locate(root, entry.name)
    if (!loc) continue
    // G2-c：顺手清掉上次崩溃 / 满盘留下的 *.tmp-*（只在这个启动恢复入口做）。
    await cleanupTempFiles(root, loc.id).catch(() => {})
    const meta = await readMetaUnlocked(loc).catch(() => null)
    if (!meta || TERMINAL_STATUS.has(meta.status)) continue
    // G2-a：先按磁盘事件修正 seq / eventCount，再决定是否续写终态。
    await repairRunCounters(root, loc.id).catch(() => null)
    let text
    try {
      text = await readFile(join(loc.dir, 'run.jsonl'), 'utf8')
    } catch {
      continue
    }
    let lastEnd = null
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let event
      try {
        event = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (event && event.kind === 'run/end' && event.data && TERMINAL_STATUS.has(event.data.status)
        && !isInstanceScopedEnd(event)) {
        lastEnd = event
      }
    }
    if (!lastEnd) continue
    const endedAt = typeof lastEnd.ts === 'string' && Number.isFinite(Date.parse(lastEnd.ts))
      ? new Date(Date.parse(lastEnd.ts)).toISOString()
      : now.toISOString()
    await withLock(loc.id, async () => {
      const fresh = await readMetaUnlocked(loc)
      if (!fresh || TERMINAL_STATUS.has(fresh.status)) return
      await writeMetaUnlocked(loc, normalizeMeta({
        ...fresh,
        status: lastEnd.data.status,
        started: true,
        endedAt,
        live: null,
        updatedAt: now.toISOString(),
      }, loc.id))
    })
    repaired.push(loc.id)
  }
  return repaired
}

/** 写 `.error` 侧车文件：写盘失败时给 GET /runs/<id> 一个可读的 storageError。 */
async function markStorageFailure(loc, error) {
  const raw = error && error.message ? String(error.message) : String(error)
  // 侧车会被 GET /runs/<id> 返回，先把内部绝对路径压掉（§8.5）。
  const sanitized = raw.split(loc.root).join('<runs>').slice(0, 2000)
  const payload = {
    at: new Date().toISOString(),
    error: sanitized,
    code: error && typeof error.code === 'string' ? error.code : null,
  }
  const text = `${JSON.stringify(payload)}\n`
  await writeTempAtomic(join(loc.dir, ERROR_FILE), text)
}

async function readStorageError(dir) {
  let text
  try {
    text = await readFile(join(dir, ERROR_FILE), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    return { at: null, error: '读 .error 侧车文件失败', code: error && error.code ? error.code : null }
  }
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : { at: null, error: text.trim().slice(0, 2000), code: null }
  } catch {
    return { at: null, error: text.trim().slice(0, 2000), code: null }
  }
}

/**
 * 读 run 元数据；runId 非法或 run.json 不存在 / 坏掉都返回 null。
 * @returns {Promise<object | null>}
 */
export async function readRunMeta(runsRoot, runId) {
  const loc = locate(runsRoot, runId)
  if (!loc) return null
  try {
    return await readMetaUnlocked(loc)
  } catch {
    // run.json 是目录 / 权限拒绝 / 其它 IO 错误：单条读取按「不存在」处理（404），
    // 列表侧会把它记进 skipped 而不是让整张表 500（§8.6）。
    return null
  }
}

/**
 * 原子写 run 元数据（临时文件 + rename）。给了部分字段时与现有 meta 合并；
 * `id` 永远以路径为准，不接受请求体伪造。目录不存在 → RunError(404)。
 *
 * D1（BLOCKER）：`run.json` **存在但读不出来**时绝不覆盖。
 *   - 读失败（坏 JSON / 超 1MiB / 目录 / 权限）→ 先把原内容另存为
 *     `run.json.corrupt-<时间戳>-<短哈希>`，再抛 RunError(500, code=EMETACORRUPT)，
 *     **原文件一个字节都不动**；
 *   - 只有 `readMetaUnlocked` 返回 null（真正的 ENOENT）才允许按「新建」写默认值。
 * 旧行为（读不出来就重建默认 meta）会把 status / 绑定 / seq 全部重置，导致 run
 * 从列表消失、事件序号从 1 重新开始。
 *
 * D3：patch 里未声明的键仍然丢弃，但会挂在返回值的 `droppedKeys`（不可枚举属性，
 * 不会被 JSON.stringify 写进 run.json，也不改变既有返回结构）上。
 *
 * @returns {Promise<object>} 写入后的完整 meta（可能带不可枚举的 `droppedKeys` /
 *   `nodeStatusBudget` 诊断属性）
 */
export async function writeRunMeta(runsRoot, runId, patch = {}, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  // 进程内 withLock → 跨进程 meta.lock：两个 dsh 进程并发 patch 也不会互相覆盖。
  return withLock(loc.id, () => withMetaLock(loc, async () => {
    try {
      const info = await stat(loc.dir)
      if (!info.isDirectory()) throw new RunError(404, 'runId', 'run 不存在')
    } catch (error) {
      if (error && error.code === 'ENOENT') throw new RunError(404, 'runId', 'run 不存在')
      throw error
    }
    const source = isPlainObject(patch) ? patch : {}
    // D3：显式出现的键先严格校验（类型不对 / sessions 超限 → 400，不静默丢）。
    validateMetaPatch(source)
    const droppedKeys = Object.keys(source).filter(key => !META_FIELD_KEYS.has(key))
    // startOptions 是「白名单里的对象 + 对象内还有白名单」：多余的内层键也要可见。
    if (isPlainObject(source.startOptions)) {
      for (const key of Object.keys(source.startOptions)) {
        if (!START_OPTIONS_KEYS.includes(key)) droppedKeys.push(`startOptions.${key}`)
      }
    }
    // limits 同理：内层多余键丢弃但可见（`limits.<key>`）。
    if (isPlainObject(source.limits)) {
      for (const key of Object.keys(source.limits)) {
        if (!LIMITS_KEYS.includes(key)) droppedKeys.push(`limits.${key}`)
      }
    }
    // D4 machine 同理：内层多余键丢弃但可见（`machine.<key>`）。
    if (isPlainDataObject(source.machine)) {
      for (const key of Object.keys(source.machine)) {
        if (!MACHINE_KEYS.includes(key)) droppedKeys.push(`machine.${key}`)
      }
    }
    let existing
    try {
      existing = await readMetaUnlocked(loc)
    } catch (error) {
      // D1：文件存在但读不出来 → 备份 + 拒绝覆盖，保持原文件不动。
      const backup = await backupCorruptMeta(loc).catch(() => null)
      throw corruptMetaError(error, backup)
    }
    // 0.11 R1（返工）：带 fence 的元数据写（live / 绑定）同样在锁内复核世代。
    assertFence(existing, options)
    const merged = normalizeMeta({ ...(existing || {}), ...source }, loc.id)
    merged.updatedAt = new Date().toISOString()
    if (!existing) merged.createdAt = merged.updatedAt
    const written = await writeMetaUnlocked(loc, merged)
    if (droppedKeys.length > 0) {
      Object.defineProperty(written, 'droppedKeys', {
        value: droppedKeys, enumerable: false, configurable: true, writable: false,
      })
    }
    return written
  }))
}

// ---------------------------------------------------------------------------
// 06 §16：流程收件箱（messages.jsonl）与节点会话表（sessions.json）
// ---------------------------------------------------------------------------

/** 收件箱消息文件（run 目录内相对路径，JSONL 追加写）。 */
const MESSAGES_FILE = 'messages.jsonl'
/** 节点会话表（run 目录内相对路径，原子整写）。 */
const SESSIONS_FILE = 'sessions.json'
/** 单条消息行 / 整个文件的体积闸门：外部文本已在入口处有界，这里是最后的兜底。 */
const MAX_MESSAGE_LINE_BYTES = 16 * 1024
const MAX_MESSAGES_FILE_BYTES = 8 * 1024 * 1024
const MAX_SESSIONS_BYTES = 512 * 1024
const MAX_MESSAGE_RECORDS = 5000

function messagesPath(dir) {
  return join(dir, MESSAGES_FILE)
}

function sessionsPath(dir) {
  return join(dir, SESSIONS_FILE)
}

function optionalIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : undefined
}

function optionalText(value, max) {
  return typeof value === 'string' && value !== '' ? clipText(value, max) : undefined
}

/**
 * 归一化一条 messages.jsonl 行。
 * 完整记录（带 direction）与投递状态补丁（只有 id + status）共用同一套字段上限。
 */
function normalizeMessageRecord(raw) {
  if (!isPlainObject(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.trim() === '' || raw.id.length > 128) return null
  if (/[\u0000-\u001f\u007f]/.test(raw.id)) return null
  const direction = raw.direction
  if (direction !== 'in' && direction !== 'out') return null
  const record = { v: 1, id: raw.id }
  record.direction = direction
  record.ts = normalizeIso(raw.ts) || new Date().toISOString()
  if (direction === 'in') {
    record.from = optionalText(raw.from, RUN_MESSAGE_FROM_MAX_CHARS) || 'unknown'
    record.text = clipText(typeof raw.text === 'string' ? raw.text : '', RUN_MESSAGE_TEXT_MAX_CHARS)
    if (typeof raw.targetNodeId === 'string' && checkRunId(raw.targetNodeId)) record.targetNodeId = raw.targetNodeId
    const reply = normalizeReplyTarget(raw.reply)
    if (reply) record.reply = reply
    if (typeof raw.replyKind === 'string' && MESSAGE_REPLY_KIND_SET.has(raw.replyKind)) {
      record.replyKind = raw.replyKind
    }
  } else {
    record.text = clipText(typeof raw.text === 'string' ? raw.text : '', RUN_MESSAGE_TEXT_MAX_CHARS)
    const replyTo = optionalText(raw.inReplyTo, 128)
    if (replyTo) record.inReplyTo = replyTo
    if (typeof raw.nodeId === 'string' && checkRunId(raw.nodeId)) record.nodeId = raw.nodeId
    if (typeof raw.delivery === 'string' && raw.delivery.length <= 32) record.delivery = raw.delivery
  }
  if (typeof raw.status === 'string' && MESSAGE_STATUS_SET.has(raw.status)) record.status = raw.status
  else record.status = direction === 'in' ? 'pending' : 'delivered'
  for (const key of ['sessionId', 'mode', 'deliveredByNodeId']) {
    const value = optionalText(raw[key], key === 'sessionId' ? 128 : 64)
    if (value) record[key] = value
  }
  const deliveredAt = optionalIso(raw.deliveredAt)
  if (deliveredAt) record.deliveredAt = deliveredAt
  return record
}

/** 状态补丁行：只带 id + status（以及投递细节），不改正文。 */
function normalizeMessagePatch(raw) {
  if (!isPlainObject(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.trim() === '' || raw.id.length > 128) return null
  if (raw.direction === 'in' || raw.direction === 'out') return null
  if (typeof raw.status !== 'string' || !MESSAGE_STATUS_SET.has(raw.status)) return null
  const patch = { v: 1, id: raw.id, status: raw.status, ts: normalizeIso(raw.ts) || new Date().toISOString() }
  for (const key of ['sessionId', 'mode', 'deliveredByNodeId']) {
    const value = optionalText(raw[key], key === 'sessionId' ? 128 : 64)
    if (value) patch[key] = value
  }
  const deliveredAt = optionalIso(raw.deliveredAt)
  if (deliveredAt) patch.deliveredAt = deliveredAt
  const error = optionalText(raw.error, 256)
  if (error) patch.error = error
  return patch
}

function mergeMessageRecords(records) {
  const order = new Map()
  const map = new Map()
  let skipped = 0
  for (const entry of records) {
    const id = entry.id
    if (!order.has(id)) order.set(id, order.size)
    if (entry.direction === 'in' || entry.direction === 'out') {
      const prev = map.get(id)
      map.set(id, prev ? { ...prev, ...entry } : entry)
      continue
    }
    // 补丁：只更新状态与投递细节。
    const prev = map.get(id)
    if (!prev) {
      skipped += 1
      continue
    }
    const next = { ...prev, status: entry.status }
    for (const key of ['sessionId', 'mode', 'deliveredByNodeId', 'deliveredAt', 'error']) {
      if (entry[key] !== undefined) next[key] = entry[key]
    }
    map.set(id, next)
  }
  const messages = [...map.values()]
  messages.sort((a, b) => {
    const ta = Date.parse(a.ts)
    const tb = Date.parse(b.ts)
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
    return (order.get(a.id) || 0) - (order.get(b.id) || 0)
  })
  return { messages, skipped }
}

async function readMessagesUnlocked(loc) {
  let text
  try {
    text = await readFile(messagesPath(loc.dir), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { messages: [], skipped: 0 }
    throw error
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGES_FILE_BYTES) {
    return { messages: [], skipped: 1, oversized: true }
  }
  const records = []
  let skipped = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_MESSAGE_LINE_BYTES) {
      skipped += 1
      continue
    }
    let raw
    try {
      raw = JSON.parse(trimmed)
    } catch {
      skipped += 1
      continue
    }
    const record = normalizeMessageRecord(raw) || normalizeMessagePatch(raw)
    if (!record) {
      skipped += 1
      continue
    }
    records.push(record)
    if (records.length >= MAX_MESSAGE_RECORDS) break
  }
  const merged = mergeMessageRecords(records)
  return { messages: merged.messages, skipped: skipped + merged.skipped }
}

/**
 * 读 run 的收件箱（in/out 合并，按 ts 升序）。
 * `limit` 取最近 N 条但仍按时间升序返回；run 不存在 / runId 非法返回 null。
 * @returns {Promise<{ messages: object[], total: number, truncated: boolean, skipped: number } | null>}
 */
export async function readRunMessages(runsRoot, runId, options = {}) {
  const loc = locate(runsRoot, runId)
  if (!loc) return null
  let limit = 100
  if (options.limit !== undefined && options.limit !== null && options.limit !== '') {
    const value = typeof options.limit === 'string' ? Number(options.limit) : options.limit
    if (!Number.isInteger(value) || value < 1) throw new RunError(400, 'limit', '必须是正整数')
    limit = Math.min(value, 1000)
  }
  const merged = await readMessagesUnlocked(loc)
  const total = merged.messages.length
  const messages = total > limit ? merged.messages.slice(total - limit) : merged.messages
  return { messages, total, truncated: total > messages.length, skipped: merged.skipped }
}

/**
 * 追加若干收件箱记录（JSONL 追加写，0600）。
 * @returns {Promise<{ appended: number }>}
 */
export async function appendRunMessages(runsRoot, runId, records) {
  const loc = requireLoc(runsRoot, runId)
  const list = Array.isArray(records) ? records : [records]
  const lines = []
  for (const item of list) {
    const record = normalizeMessageRecord(item) || normalizeMessagePatch(item)
    if (!record) throw new RunError(400, 'message', '消息记录不合法（需要 id + direction=in/out，或 id + status 补丁）')
    const line = JSON.stringify(record)
    if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_LINE_BYTES) {
      throw new RunError(400, 'message', '单条消息超过 16KB 上限')
    }
    lines.push(`${line}\n`)
  }
  if (lines.length === 0) throw new RunError(400, 'message', '至少需要一条消息记录')
  // G2-b：收件箱也是同一个 run 的持久状态，run.json 写锁把跨进程追加串起来（避免半行 /
  // 上限判断竞态）。G2-a：追加前补换行，坏半行不会把下一条记录粘进去。
  return withLock(loc.id, () => withMetaLock(loc, async () => {
    const path = messagesPath(loc.dir)
    // 文件体积闸门：超限时不再追加（读取侧仍能读旧记录）。
    try {
      const info = await stat(path)
      if (info.size + Buffer.byteLength(lines.join(''), 'utf8') > MAX_MESSAGES_FILE_BYTES) {
        throw new RunError(400, 'message', '收件箱文件已达 8MiB 上限，拒绝继续追加')
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
    }
    const prefix = await needsLeadingNewline(path) ? '\n' : ''
    const handle = await open(path, 'a', FILE_MODE)
    try {
      await handle.writeFile(`${prefix}${lines.join('')}`, 'utf8')
    } finally {
      await handle.close()
    }
    await chmod(path, FILE_MODE).catch(() => {})
    return { appended: lines.length }
  }))
}

/**
 * 给一条消息补一个投递状态（追加补丁行；`readRunMessages` 会合并）。
 */
export async function updateRunMessageStatus(runsRoot, runId, id, status, extra = {}) {
  const loc = requireLoc(runsRoot, runId)
  if (!MESSAGE_STATUS_SET.has(status)) {
    throw new RunError(400, 'status', `必须是 ${MESSAGE_STATUSES.join(' / ')}`)
  }
  const patch = normalizeMessagePatch({
    id,
    status,
    ts: new Date().toISOString(),
    ...(extra && typeof extra === 'object' ? extra : {}),
  })
  if (!patch) throw new RunError(400, 'message', '消息 id 不合法')
  return appendRunMessages(runsRoot, runId, [patch])
}

/**
 * 0.10 §2.1（R1/S2）：`sessions.json` 条目的可选 `agentOptions`（节点会话创建时实际
 * 传给 `agents.create` 的模型路由对）。
 *
 * 这是**形状**归一化，不是语义判断（「这一对能不能用」由引擎的 `resolveModelRoute` 决定）：
 *   - provider / model 必须同时是非空字符串（≤64 / ≤128），半对整条作废；
 *   - `reasoningEffort` 可选（≤64；空串视为没写）；
 *   - 任何坏形状（数组 / 数字 / 半对 / 超长）返回 `null`，调用方整条丢弃该字段，
 *     但**保留** sessionId 等其它字段（旧 run / 手改坏的文件不炸）。
 *
 * 读 / 写 / upsert 三处共用，避免条目形状出现第二份实现（结构设计 S2）。
 *
 * @param {unknown} value
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | null}
 */
export function normalizeSessionAgentOptions(value) {
  if (!isPlainObject(value)) return null
  const provider = value.provider
  const model = value.model
  if (typeof provider !== 'string' || provider.trim() === '' || provider.length > 64) return null
  if (typeof model !== 'string' || model.trim() === '' || model.length > 128) return null
  const out = { provider, model }
  const effort = value.reasoningEffort
  if (effort !== undefined && effort !== null) {
    if (typeof effort !== 'string') return null
    if (effort.trim() !== '') {
      if (effort.length > 64) return null
      out.reasoningEffort = effort
    }
  }
  return out
}

/** 读节点会话表；文件缺失 / 坏 JSON / 字段不合法一律返回空表，不抛错。 */
export async function readNodeSessions(runsRoot, runId) {
  const loc = locate(runsRoot, runId)
  if (!loc) return {}
  let text
  try {
    text = await readFile(sessionsPath(loc.dir), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return {}
    return {}
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_SESSIONS_BYTES) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (!isPlainObject(parsed)) return {}
  const out = {}
  for (const [nodeId, entry] of Object.entries(parsed)) {
    if (!checkRunId(nodeId) || !isPlainObject(entry)) continue
    if (typeof entry.sessionId !== 'string' || entry.sessionId.trim() === '' || entry.sessionId.length > 128) continue
    const agentOptions = normalizeSessionAgentOptions(entry.agentOptions)
    out[nodeId] = {
      sessionId: entry.sessionId,
      createdAt: normalizeIso(entry.createdAt) || new Date().toISOString(),
      lastUsedAt: normalizeIso(entry.lastUsedAt) || normalizeIso(entry.createdAt) || new Date().toISOString(),
      ...(agentOptions ? { agentOptions } : {}),
    }
  }
  return out
}

/** 原子整写节点会话表（临时文件 + rename，0600）。 */
async function writeSessionsUnlocked(loc, sessions) {
  const normalized = {}
  if (isPlainObject(sessions)) {
    for (const [nodeId, entry] of Object.entries(sessions)) {
      if (!checkRunId(nodeId) || !isPlainObject(entry)) continue
      if (typeof entry.sessionId !== 'string' || entry.sessionId.trim() === '' || entry.sessionId.length > 128) continue
      const agentOptions = normalizeSessionAgentOptions(entry.agentOptions)
      normalized[nodeId] = {
        sessionId: entry.sessionId,
        createdAt: normalizeIso(entry.createdAt) || new Date().toISOString(),
        lastUsedAt: normalizeIso(entry.lastUsedAt) || normalizeIso(entry.createdAt) || new Date().toISOString(),
        ...(agentOptions ? { agentOptions } : {}),
      }
    }
  }
  const text = `${JSON.stringify(normalized, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_SESSIONS_BYTES) {
    throw new RunError(400, 'sessions', 'sessions.json 超过 512KB 上限')
  }
  await ensureDirMode(loc.dir)
  const path = sessionsPath(loc.dir)
  await writeTempAtomic(path, text)
  return normalized
}

/** 原子整写节点会话表（临时文件 + rename，0600）。 */
export async function writeNodeSessions(runsRoot, runId, sessions) {
  const loc = requireLoc(runsRoot, runId)
  return withLock(loc.id, () => withMetaLock(loc, () => writeSessionsUnlocked(loc, sessions)))
}

/**
 * 写入/更新一个节点的会话（读-改-写在同一把进程内锁 + 跨进程 meta.lock 里完成，
 * 两个进程同时 upsert 不会丢对方的条目）。
 *
 * 0.10 §2.1（R1）：`options.agentOptions` 是本次实际使用的模型路由对；同 sessionId
 * 时未显式传（或传了坏形状）就保留旧 route，换 sessionId 则不继承。
 *
 * @param {{ now?: Date, resetCreatedAt?: boolean, agentOptions?: object }} [options]
 * @returns {Promise<Record<string, object>>} 写入后的会话表
 */
export async function upsertNodeSession(runsRoot, runId, nodeId, sessionId, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  if (!checkRunId(nodeId)) throw new RunError(400, 'nodeId', 'nodeId 不合法')
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 128) {
    throw new RunError(400, 'sessionId', 'sessionId 必须是非空字符串（≤128 字符）')
  }
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
    ? options.now
    : new Date()
  return withLock(loc.id, () => withMetaLock(loc, async () => {
    const current = await readNodeSessions(runsRoot, runId)
    const previous = current[nodeId]
    const sameSession = Boolean(previous && previous.sessionId === sessionId)
    // 0.10 §2.1（R1）：**同 sessionId** 才保留旧 route（除非本次显式传了新的合法值）；
    // 换了 sessionId 就是新会话，不能凭空继承旧节点的 route（那会让模型路由漂移）。
    const requested = normalizeSessionAgentOptions(options.agentOptions)
    const inherited = sameSession && previous.agentOptions ? previous.agentOptions : null
    const agentOptions = requested || inherited
    const entry = {
      sessionId,
      createdAt: sameSession && options.resetCreatedAt !== true
        ? previous.createdAt
        : now.toISOString(),
      lastUsedAt: now.toISOString(),
      ...(agentOptions ? { agentOptions } : {}),
    }
    current[nodeId] = entry
    return writeSessionsUnlocked(loc, current)
  }))
}

/** 运行中动态配置回复目标（写 run.json.inbox）。 */
export async function writeRunInbox(runsRoot, runId, reply) {
  const normalized = normalizeReplyTarget(reply)
  if (!normalized) {
    throw new RunError(400, 'reply', '回复目标不合法（kind 必须是 session / http / none；http 只允许 http/https）')
  }
  return writeRunMeta(runsRoot, runId, {
    inbox: { reply: normalized, updatedAt: new Date().toISOString() },
  })
}

/**
 * 把「启动前收到」的消息并入 run.json.input.messages（幂等按 id 去重，最多保留 20 条）。
 * @returns {Promise<object>} 写入后的完整 meta
 */
export async function appendRunInputMessages(runsRoot, runId, messages) {
  const loc = requireLoc(runsRoot, runId)
  const incoming = normalizeRunInput({ messages })
  if (!incoming) return readRunMeta(runsRoot, runId)
  return withLock(loc.id, () => withMetaLock(loc, async () => {
    const meta = await readMetaUnlocked(loc)
    if (!meta) throw new RunError(404, 'runId', 'run 不存在')
    const existing = normalizeRunInput(meta.input)
    const merged = new Map()
    for (const item of existing ? existing.messages : []) merged.set(item.id, item)
    for (const item of incoming.messages) merged.set(item.id, item)
    const list = [...merged.values()].slice(-RUN_INPUT_MAX_MESSAGES)
    const next = normalizeMeta({ ...meta, input: { messages: list } }, loc.id)
    next.updatedAt = new Date().toISOString()
    return writeMetaUnlocked(loc, next)
  }))
}


async function readAllEventsUnlocked(loc, meta) {
  const events = []
  let order = 0
  let skipped = 0

  const pushLines = text => {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const event = JSON.parse(trimmed)
        if (event !== null && typeof event === 'object' && !Array.isArray(event)) {
          events.push({ event, order: order++ })
        } else {
          skipped += 1
        }
      } catch {
        skipped += 1
      }
    }
  }

  const readFileSafe = async path => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw error
    }
  }

  const rootFile = await readFileSafe(join(loc.dir, 'run.jsonl'))
  if (rootFile !== null) pushLines(rootFile)

  let dirents = []
  try {
    dirents = await readdir(loc.dir, { withFileTypes: true })
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  const nodeDirs = dirents
    .filter(entry => entry.isDirectory() && checkRunId(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))

  for (const nodeId of nodeDirs) {
    const nodePath = join(loc.dir, nodeId)
    let files = []
    try {
      files = await readdir(nodePath, { withFileTypes: true })
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
      continue
    }
    const names = files
      .filter(entry => entry.isFile() && ATTEMPT_FILE.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    for (const name of names) {
      const text = await readFileSafe(join(nodePath, name))
      if (text !== null) pushLines(text)
    }
  }

  events.sort((a, b) => {
    const sa = Number.isFinite(a.event.seq) ? a.event.seq : null
    const sb = Number.isFinite(b.event.seq) ? b.event.seq : null
    if (sa !== null && sb !== null && sa !== sb) return sa - sb
    const ta = typeof a.event.ts === 'string' ? Date.parse(a.event.ts) : Number.NaN
    const tb = typeof b.event.ts === 'string' ? Date.parse(b.event.ts) : Number.NaN
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
    return a.order - b.order
  })

  return { events: events.map(entry => entry.event), skipped, meta }
}

/**
 * 读一个 run 的全部事件（按 seq 升序）。runId 非法 / run 不存在返回 null。
 * @returns {Promise<{ events: object[], skipped: number, meta: object } | null>}
 */
export async function readAllEvents(runsRoot, runId) {
  const loc = locate(runsRoot, runId)
  if (!loc) return null
  let meta
  try {
    meta = await readMetaUnlocked(loc)
  } catch {
    return null
  }
  if (!meta) return null
  return readAllEventsUnlocked(loc, meta)
}

function parseSince(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new RunError(400, 'since', '必须是非负整数 seq 或 ISO 时间')
    return { type: 'seq', value }
  }
  if (typeof value !== 'string') throw new RunError(400, 'since', '必须是非负整数 seq 或 ISO 时间')
  if (/^\d+$/.test(value)) return { type: 'seq', value: Number(value) }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new RunError(400, 'since', '必须是非负整数 seq 或 ISO 时间')
  return { type: 'ts', value: parsed }
}

/** 列出 run 目录里所有事件文件（run.jsonl + 每个 node 的 attempt 文件）。 */
async function listEventFiles(loc) {
  const files = []
  const rootFile = join(loc.dir, 'run.jsonl')
  try {
    const info = await stat(rootFile)
    if (info.isFile()) files.push(rootFile)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  let dirents = []
  try {
    dirents = await readdir(loc.dir, { withFileTypes: true })
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  const nodeDirs = dirents
    .filter(entry => entry.isDirectory() && checkRunId(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))
  for (const nodeId of nodeDirs) {
    const nodePath = join(loc.dir, nodeId)
    let entries = []
    try {
      entries = await readdir(nodePath, { withFileTypes: true })
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
      continue
    }
    const names = entries
      .filter(entry => entry.isFile() && ATTEMPT_FILE.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    for (const name of names) files.push(join(nodePath, name))
  }
  return files
}

/**
 * 单文件倒序行迭代器：从文件尾部按块读，逐行倒着吐。
 * 不把整个文件读进内存，也不会先解析前面的行（06 §13.7 / 05 §8.6 的读放大要求）。
 */
function makeReverseLineIterator(path) {
  let handle = null
  let pos = 0
  let pending = ''
  let bytes = 0
  const buffer = []
  const CHUNK = 64 * 1024

  async function openOnce() {
    if (handle !== null) return
    handle = await open(path, 'r')
    const info = await handle.stat()
    pos = info.size
  }

  async function fill() {
    await openOnce()
    while (buffer.length === 0 && pos > 0) {
      const start = Math.max(0, pos - CHUNK)
      const size = pos - start
      const chunk = Buffer.allocUnsafe(size)
      let offset = 0
      while (offset < size) {
        const { bytesRead } = await handle.read(chunk, offset, size - offset, start + offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      bytes += offset
      pos = start
      const text = chunk.subarray(0, offset).toString('utf8') + pending
      const parts = text.split('\n')
      // start > 0 时第一段可能是被切断的半行，留到下一块拼接。
      pending = pos > 0 ? parts.shift() : ''
      for (const part of parts) {
        const line = part.trim()
        if (line !== '') buffer.push(line)
      }
    }
    if (buffer.length === 0 && pending.trim() !== '') {
      buffer.push(pending.trim())
      pending = ''
    }
  }

  return {
    get bytesRead() {
      return bytes
    },
    async next() {
      await fill()
      if (buffer.length === 0) return null
      const line = buffer.pop()
      try {
        const event = JSON.parse(line)
        if (event !== null && typeof event === 'object' && !Array.isArray(event)) return { event }
        return { event: null }
      } catch {
        return { event: null }
      }
    },
    async close() {
      if (handle !== null) {
        await handle.close().catch(() => {})
        handle = null
      }
    },
  }
}

function matchesFilters(event, filters) {
  if (!event) return false
  if (filters.nodeId && event.nodeId !== filters.nodeId) return false
  if (filters.attemptId !== undefined && event.attemptId !== filters.attemptId) return false
  if (filters.kinds && !filters.kinds.has(event.kind)) return false
  if (filters.since && filters.since.type === 'seq') {
    if (!Number.isFinite(event.seq) || event.seq <= filters.since.value) return false
  }
  if (filters.sinceTs !== null) {
    const ts = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN
    if (!Number.isFinite(ts) || ts <= filters.sinceTs) return false
  }
  return true
}

function eventOrder(event) {
  const seq = Number.isInteger(event && event.seq) ? event.seq : -1
  const ts = typeof event?.ts === 'string' ? Date.parse(event.ts) : Number.NaN
  return { seq, ts: Number.isFinite(ts) ? ts : -1 }
}

/**
 * `order=desc` 的尾部倒读：各文件同时从末尾取一条，做 k 路归并取最大 seq。
 * 取够 limit 条就停——此时未读事件都在各文件头部之前，seq 不会大于已取的最小值，
 * 所以结果就是全局最新的 limit 条，不需要全量解析。
 */
async function readEventsTail(loc, meta, filters) {
  const files = await listEventFiles(loc)
  const iterators = files.map(file => makeReverseLineIterator(file))
  const matched = []
  let scanned = 0
  let skipped = 0
  let exhausted = false
  try {
    while (matched.length < filters.limit) {
      let bestIndex = -1
      let bestSeq = -Infinity
      let bestTs = -Infinity
      for (let index = 0; index < iterators.length; index += 1) {
        const iterator = iterators[index]
        if (iterator.done) continue
        if (iterator.head === undefined) {
          iterator.head = await iterator.next()
          if (iterator.head === null) {
            iterator.done = true
            continue
          }
        }
        const order = eventOrder(iterator.head.event)
        if (bestIndex === -1 || order.seq > bestSeq || (order.seq === bestSeq && order.ts > bestTs)) {
          bestIndex = index
          bestSeq = order.seq
          bestTs = order.ts
        }
      }
      if (bestIndex === -1) {
        exhausted = true
        break
      }
      const iterator = iterators[bestIndex]
      const item = iterator.head
      iterator.head = undefined
      scanned += 1
      if (!item.event) {
        skipped += 1
        continue
      }
      // 该文件剩余事件 seq 只会更小（文件内按 seq 递增追加），可以安全收工。
      if (filters.since && filters.since.type === 'seq'
        && Number.isFinite(item.event.seq) && item.event.seq <= filters.since.value) {
        exhausted = true
        break
      }
      if (matchesFilters(item.event, filters)) matched.push(item.event)
    }
  } finally {
    for (const iterator of iterators) await iterator.close()
  }
  const scannedBytes = iterators.reduce((sum, iterator) => sum + iterator.bytesRead, 0)
  const hasFilters = Boolean(filters.nodeId || filters.attemptId !== undefined || filters.kinds || filters.since)
  let total
  let truncated
  let totalExact
  if (exhausted) {
    total = matched.length
    truncated = false
    totalExact = true
  } else if (!hasFilters) {
    // 无过滤时 run.json 的 eventCount 就是精确总数，不必再扫一遍。
    total = Math.max(meta.eventCount, matched.length)
    truncated = true
    totalExact = true
  } else {
    // 有过滤且提前停：total 是「已读到的匹配数」（≥ limit），truncated 明确表示还有未读区间。
    total = matched.length
    truncated = true
    totalExact = false
  }
  return {
    events: matched,
    total,
    totalExact,
    truncated,
    skipped: exhausted ? skipped : 0,
    scannedEvents: scanned,
    scannedBytes,
    tail: true,
  }
}

/**
 * 读事件流：过滤 + 分页 + 排序。
 *
 * `order=desc` 走尾部倒读（只解析需要的尾部），`order=asc` 仍旧全量读后正序分页。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {{ nodeId?: string, attemptId?: number, kinds?: string[], since?: number|string, limit?: number, order?: 'asc'|'desc' }} [options]
 * @returns {Promise<{ events: object[], total: number, truncated: boolean, skipped: number } | null>}
 */
export async function readEvents(runsRoot, runId, options = {}) {
  const loc = locate(runsRoot, runId)
  if (!loc) return null
  let meta
  try {
    meta = await readMetaUnlocked(loc)
  } catch {
    return null
  }
  if (!meta) return null

  let nodeId
  if (options.nodeId !== undefined && options.nodeId !== null && options.nodeId !== '') {
    nodeId = checkRunId(options.nodeId)
    if (!nodeId) throw new RunError(400, 'nodeId', 'nodeId 不合法')
  }

  let attemptId
  if (options.attemptId !== undefined && options.attemptId !== null && options.attemptId !== '') {
    const value = typeof options.attemptId === 'string' ? Number(options.attemptId) : options.attemptId
    if (!Number.isInteger(value) || value < 1) throw new RunError(400, 'attemptId', '必须是从 1 开始的正整数')
    attemptId = value
  }

  let kinds
  if (options.kinds !== undefined && options.kinds !== null) {
    if (!Array.isArray(options.kinds)) throw new RunError(400, 'kind', 'kind 必须是白名单内的字符串')
    const set = new Set()
    for (const kind of options.kinds) {
      if (typeof kind !== 'string' || !whitelistKind(kind)) {
        throw new RunError(400, 'kind', `未知事件类型：${String(kind)}`)
      }
      set.add(kind)
    }
    if (set.size > 0) kinds = set
  }

  const since = parseSince(options.since)

  let order = 'asc'
  if (options.order !== undefined && options.order !== null && options.order !== '') {
    if (options.order !== 'asc' && options.order !== 'desc') {
      throw new RunError(400, 'order', '只支持 asc / desc')
    }
    order = options.order
  }

  let limit = 200
  if (options.limit !== undefined && options.limit !== null && options.limit !== '') {
    const value = typeof options.limit === 'string' ? Number(options.limit) : options.limit
    if (!Number.isInteger(value) || value < 1) throw new RunError(400, 'limit', '必须是正整数')
    limit = Math.min(value, 1000)
  }

  const sinceTs = since && since.type === 'ts' ? since.value : null
  const filters = { nodeId, attemptId, kinds, since, sinceTs, limit }

  if (order === 'desc') {
    return readEventsTail(loc, meta, filters)
  }

  const all = await readAllEventsUnlocked(loc, meta)
  const filtered = all.events.filter(event => matchesFilters(event, filters))
  const total = filtered.length
  return {
    events: filtered.slice(0, limit),
    total,
    totalExact: true,
    truncated: total > limit,
    skipped: all.skipped,
    scannedEvents: all.events.length,
    scannedBytes: null,
    tail: false,
  }
}

// 与 runlog 的事件白名单**同源**（基础 17 种 + 收件箱 / 节点状态 / 状态机转移扩展），
// 不再手写第二份字符串：手抄那份曾经漏掉 `node/status`，`?kinds=` 过滤直接 400。
// `whitelistKind` 只作用于 `readEvents` 的 kinds 过滤器；写路径的白名单在 runlog 的
// 校验器里，所以这里放宽**不会**让未校验的事件进库。
const EVENT_KINDS = new Set([
  ...BASE_EVENT_KINDS, ...INBOX_EVENT_KINDS, ...NODE_STATUS_EVENT_KINDS, ...MACHINE_EVENT_KINDS,
  ...NODE_TOOLS_EVENT_KINDS,
])

function whitelistKind(kind) {
  return EVENT_KINDS.has(kind)
}

/** §8.6：用量的替换语义需要记住每个 (traceId, callId) 上一次的贡献。 */
const USAGE_FILE = '.usage.json'

function usageTotal(usage) {
  if (!isPlainObject(usage)) return 0
  const part = key => (Number.isFinite(usage[key]) ? usage[key] : 0)
  return part('input') + part('cacheRead') + part('cacheWrite') + part('output')
}

async function readUsageLedger(dir) {
  let text
  try {
    text = await readFile(join(dir, USAGE_FILE), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ledger: { keys: {} }, corrupt: false }
    return { ledger: { keys: {} }, corrupt: true }
  }
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed) || !isPlainObject(parsed.keys)) return { ledger: { keys: {} }, corrupt: true }
    return { ledger: { keys: parsed.keys }, corrupt: false }
  } catch {
    return { ledger: { keys: {} }, corrupt: true }
  }
}

async function writeUsageLedger(dir, ledger) {
  const text = `${JSON.stringify(ledger)}\n`
  await writeTempAtomic(join(dir, USAGE_FILE), text)
}

/** 追加时按事件顺序增量维护 run.json 里的进度计数器（与 runlog.computeProgress 同口径）。 */
function applyProgressEvent(progress, event) {
  if (event.kind === 'node/start' && event.data) {
    const existing = progress.nodes[event.nodeId]
    if (!existing || event.attemptId >= existing.attemptId) {
      progress.nodes[event.nodeId] = {
        attemptId: event.attemptId,
        status: 'pending',
        endSeq: 0,
        invalidated: false,
      }
    }
    return
  }
  if (event.kind === 'node/end' && event.data) {
    const existing = progress.nodes[event.nodeId]
    if (!existing || event.attemptId >= existing.attemptId) {
      progress.nodes[event.nodeId] = {
        attemptId: event.attemptId,
        status: event.data.status,
        endSeq: event.seq,
        invalidated: false,
      }
    }
    return
  }
  if (event.kind === 'reject/trigger' && event.data) {
    const fromNodeId = event.data.fromNodeId
    const toNodeId = event.data.toNodeId
    if (typeof fromNodeId !== 'string' || typeof toNodeId !== 'string') return
    const target = progress.nodes[toNodeId]
    const windowStart = target && target.status === 'passed' && target.endSeq > 0
      && target.endSeq < event.seq ? target.endSeq : null
    for (const [nodeId, entry] of Object.entries(progress.nodes)) {
      if (entry.status !== 'passed' || entry.invalidated) continue
      if (entry.endSeq <= 0 || entry.endSeq >= event.seq) continue
      const onPath = nodeId === fromNodeId || nodeId === toNodeId
        || (windowStart !== null && entry.endSeq >= windowStart)
      if (onPath) entry.invalidated = true
    }
  }
}

/**
 * G2-c：写盘失败时对外文案**必须与 run.json 的真实状态一致**。
 * 只有 failedMeta 真的落盘成功才说「已标记 failed」；否则明确说「状态未知」。
 */
function storageFailureMessage({ failedOk, sidecarOk }) {
  if (failedOk) {
    return sidecarOk
      ? '事件追加失败，run 已被原子标记为 failed（细节见 .error 侧车文件）'
      : '事件追加失败，run 已被原子标记为 failed（.error 侧车文件也写不进去）'
  }
  return sidecarOk
    ? '事件追加失败，且 run.json 也写不进去，run 状态未知（细节见 .error 侧车文件）'
    : '事件追加失败，且 run.json 与 .error 都写不进去，run 状态未知'
}

/**
 * 追加一批事件。整批校验：任何一条不合法就一条都不写。
 *
 * **并发边界**（G2-b 之后）：
 *   - 进程内由 `withLock(runId)` 串行化；
 *   - 跨进程由 `meta.lock`（O_EXCL，见 {@link withMetaLock}）串行化——同一 `DSH_HOME`
 *     起多个 dsh 进程同时写同一个 run 时，`读 meta → 分配 seq → 写 meta` 整体在锁内，
 *     不会再各自读到同一个 seq 各写一遍。它与 `lock.json` 执行租约是两把独立的锁
 *     （不在持有租约的前提下再抢 meta.lock，反之亦然），不会死锁。
 *
 * **seq 口径（G2-a）**：**先分配后写事件**——先把 `seq .. seq+N-1` 原子写进 run.json，
 * 再追加事件行。进程在两步之间被杀只会留下「空洞」（seq 已分配、事件没写），
 * 启动恢复由 {@link repairRunCounters} 按磁盘真实值修正；**绝不重复**。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {object|object[]} rawEvents 单条或数组
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ events: object[], run: object, firstSeq: number, lastSeq: number }>}
 */
export async function appendEvents(runsRoot, runId, rawEvents, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  return withLock(loc.id, () => withMetaLock(loc, () => appendEventsInLock(loc, rawEvents, options)))
}

/**
 * `appendEvents` 的锁内实现：调用方**必须**已经持有 `withLock(loc.id)` 与
 * `withMetaLock(loc)`（0.11 审查 F6：finalizeEpoch 需要把「幂等扫描 + 判定 + 追加」
 * 放进同一个跨进程锁事务，不能在这里再抢一次锁——那会自死锁）。
 *
 * @param {{ id: string, dir: string }} loc
 * @param {object|object[]} rawEvents
 * @param {object} [options]
 * @returns {Promise<{ events: object[], run: object, firstSeq: number, lastSeq: number }>}
 */
async function appendEventsInLock(loc, rawEvents, options = {}) {
  const meta = await readMetaUnlocked(loc)
  if (!meta) throw new RunError(404, 'runId', 'run 不存在')
  // 0.11 R1（返工）：业务写必须带持久 owner/epoch，或在锁内 guard 里复核。
  assertFence(meta, options)
  if (typeof options.guard === 'function') await options.guard(meta)

  const list = Array.isArray(rawEvents)
    ? rawEvents
    : (rawEvents === undefined || rawEvents === null ? [] : [rawEvents])
  if (list.length === 0) throw new RunError(400, 'events', '至少需要一条事件')
  if (list.length > MAX_BATCH_EVENTS) {
    throw new RunError(400, 'events', `单批最多 ${MAX_BATCH_EVENTS} 条（本次 ${list.length} 条）`)
  }
  if (meta.eventCount + list.length > MAX_RUN_EVENTS) {
    throw new RunError(
      400,
      'events',
      `超过单 run 事件总数上限 ${MAX_RUN_EVENTS}（已有 ${meta.eventCount}，本批 ${list.length}）`,
    )
  }

  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
    ? options.now
    : new Date()
  const normalized = []
  for (let index = 0; index < list.length; index += 1) {
    const checked = normalizeEvent(list[index], { runId: loc.id, now })
    if (!checked.ok) {
      throw new RunError(400, `events[${index}].${checked.field}`, checked.reason, { index })
    }
    normalized.push(checked.event)
  }

  let seq = meta.seq
  for (const event of normalized) {
    seq += 1
    event.seq = seq
    if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) {
      throw new RunError(400, 'events', `单条事件超过 ${MAX_EVENT_BYTES} 字节（事件行上限 8KB）`)
    }
  }
  // 06 §13.4：普通事件不得占用 run/start / run/end 的保留额度。
  const ordinaryCount = normalized.filter(event => !RUN_LEVEL_KINDS.has(event.kind)).length
  if (ordinaryCount > 0 && meta.eventCount + normalized.length > NORMAL_EVENT_LIMIT) {
    throw new RunError(
      400,
      'events',
      `普通事件已达保留额度上限 ${NORMAL_EVENT_LIMIT}（总上限 ${MAX_RUN_EVENTS}，其中 ${RESERVED_TERMINAL_EVENTS} 条留给 run/start、run/end）`
        + `；已有 ${meta.eventCount}，本批普通事件 ${ordinaryCount}`,
    )
  }
  const firstSeq = normalized[0].seq
  const lastSeq = normalized[normalized.length - 1].seq

  // 按目标文件分组，保持输入顺序；run 级写 run.jsonl，节点级写 <nodeId>/<attemptId>.jsonl。
  const groups = new Map()
  for (const event of normalized) {
    const rel = RUN_LEVEL_KINDS.has(event.kind)
      ? 'run.jsonl'
      : join(event.nodeId, `${event.attemptId}.jsonl`)
    if (!groups.has(rel)) groups.set(rel, [])
    groups.get(rel).push(event)
  }

  try {
    // G2-a ①：**先**原子分配 seq 区间（run.json 写不进去就整批不写，绝不只写事件）。
    meta.seq = lastSeq
    meta.lastSeq = lastSeq
    meta.updatedAt = now.toISOString()
    await writeMetaUnlocked(loc, meta)

    // G2-a ②：再追加事件行。文件末尾是半行（崩溃 / 写满）时先补一个换行，
    // 否则新事件会粘进坏行被读侧整条 skip。
    for (const [rel, events] of groups) {
      const abs = resolve(loc.dir, rel)
      if (!isInside(loc.dir, abs)) throw new RunError(500, 'runId', '事件路径越出 run 目录')
      await ensureDirMode(dirname(abs))
      const prefix = await needsLeadingNewline(abs) ? '\n' : ''
      const text = events.map(event => `${JSON.stringify(event)}\n`).join('')
      const handle = await open(abs, 'a', FILE_MODE)
      try {
        await handle.writeFile(`${prefix}${text}`, 'utf8')
      } finally {
        await handle.close()
      }
      await chmod(abs, FILE_MODE).catch(() => {})
    }

    // G2-a ③：事件落盘后再更新计数器（§8.6：列表只读 run.json）。
    const progress = meta.progress
    let tokenTotal = meta.tokenTotal
    let unkeyedCalls = meta.unkeyedCalls
    let tokenTotalApprox = meta.tokenTotalApprox
    const hasUsageEvents = normalized.some(event => event.kind === 'model/call')
    let ledger = null
    if (hasUsageEvents) {
      const loaded = await readUsageLedger(loc.dir)
      ledger = loaded.ledger
      if (loaded.corrupt) tokenTotalApprox = true
    }

    for (const event of normalized) {
      if (!event.data) continue
      if (event.kind === 'run/start') {
        if (Number.isInteger(event.data.nodeTotal) && event.data.nodeTotal >= 0) {
          meta.nodeTotal = event.data.nodeTotal
        }
        if (typeof event.data.flowId === 'string' && event.data.flowId !== '') meta.flowId = event.data.flowId
        if (typeof event.data.flowName === 'string' && event.data.flowName !== '') meta.flowName = event.data.flowName
        if (event.data.engine === 'stub' || event.data.engine === 'real') meta.engine = event.data.engine
        // 防御式兼容：老引擎直接写 run/start 而不调 startRun() 时，也把 pending 切成 running，
        // 否则 sweep / 列表会把一个已经在跑的 run 当成没开始。新引擎仍应显式调 startRun()。
        if (meta.status === 'pending' && meta.started !== true) {
          meta.status = 'running'
          meta.started = true
          meta.startedAt = typeof event.ts === 'string' ? event.ts : now.toISOString()
        }
        continue
      }
      if (event.kind === 'run/end') {
        // 0.11 R1：instance 范围的失权事实不参与生命周期投影（不改 status/endedAt）。
        if (event.extra && event.extra.terminalScope === 'instance') continue
        if (TERMINAL_STATUS.has(event.data.status)) meta.status = event.data.status
        meta.started = true
        if (typeof event.ts === 'string') meta.endedAt = event.ts
        if (meta.execution && meta.execution.state === 'active') meta.execution.state = 'settled'
        continue
      }
      if (event.kind === 'node/start' || event.kind === 'node/end' || event.kind === 'reject/trigger') {
        applyProgressEvent(progress, event)
        continue
      }
      if (event.kind === 'model/call') {
        const usage = event.data.usage
        const total = usageTotal(usage)
        const callId = event.data.callId
        if (typeof callId === 'string' && callId !== '') {
          const key = `${event.traceId}\u0000${callId}`
          const previous = Number.isFinite(ledger.keys[key]) ? ledger.keys[key] : 0
          tokenTotal += total - previous
          ledger.keys[key] = total
        } else {
          // §8.1：没有 callId 的用量按逐条累加，并单列供核对。
          tokenTotal += total
          unkeyedCalls += 1
        }
      }
    }

    meta.eventCount += normalized.length
    meta.nodeDone = countPassed(progress)
    meta.tokenTotal = tokenTotal
    meta.unkeyedCalls = unkeyedCalls
    meta.tokenTotalApprox = tokenTotalApprox
    meta.updatedAt = now.toISOString()
    await writeMetaUnlocked(loc, meta)
    if (ledger) {
      // 计数器已落盘；账本写失败只影响下一次追加的替换精度，不回滚已写入的事件。
      await writeUsageLedger(loc.dir, ledger).catch(() => {})
    }
  } catch (error) {
    // 06 §13.4：写盘失败也要尽量落终态——写 .error 侧车 + 原子改 run.json 为 failed。
    // G2-c：**只有 failedMeta 真的写成功才能对外宣称「已标记 failed」**；满盘时两条写
    // 都可能失败，以前把它们 .catch(()=>{}) 吞掉后仍然谎报状态。
    const sidecarOk = await markStorageFailure(loc, error).then(() => true, () => false)
    const failedMeta = normalizeMeta({
      ...meta,
      status: 'failed',
      started: true,
      endedAt: now.toISOString(),
      live: null,
      updatedAt: now.toISOString(),
    }, loc.id)
    const failedOk = await writeMetaUnlocked(loc, failedMeta).then(() => true, () => false)
    if (error instanceof RunError) throw error
    // 不回原始错误信息（可能带宿主绝对路径），细节在 .error 侧车里。
    throw new RunError(500, 'storage', storageFailureMessage({ failedOk, sidecarOk }))
  }

  return { events: normalized, run: meta, firstSeq, lastSeq }
}

/**
 * 删除整个 run 目录（日志即证据，不做软删）。
 * @returns {Promise<boolean>} 原本是否存在
 */
export async function deleteRun(runsRoot, runId) {
  const loc = locate(runsRoot, runId)
  if (!loc) return false
  return withLock(loc.id, async () => {
    try {
      await rm(loc.dir, { recursive: true, force: false })
      return true
    } catch (error) {
      if (error && error.code === 'ENOENT') return false
      throw error
    }
  })
}

function describeMetaError(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (code === 'EISDIR') return 'run.json 是目录'
  if (code === 'EACCES' || code === 'EPERM') return 'run.json 权限拒绝'
  if (code === 'ENOENT') return 'run.json 不存在'
  if (code === 'ENOTDIR') return 'run 目录路径异常（不是目录）'
  // D1：readMetaUnlocked 的结构化错误码 → 可读原因（listRuns 的 skipped.reason 用）。
  if (code === 'EBADJSON') return 'run.json 内容损坏（不是合法 JSON）'
  if (code === 'EMETATOOLARGE') return 'run.json 超过 1MiB 上限'
  return `run.json 不可读（${code || '未知错误'}）`
}

/**
 * run 列表（按 startedAt 倒序）。§8.6：只读 run.json 的计数器，不逐 run 读事件。
 * 坏 run（run.json 是目录 / 权限拒绝 / 坏 JSON）跳过并记进 `skipped`，不让整表 500。
 *
 * @param {string} runsRoot
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ runs: object[], skipped: { id: string, reason: string }[] }>}
 */
export async function listRuns(runsRoot, options = {}) {
  let limit = 20
  if (options.limit !== undefined && options.limit !== null && options.limit !== '') {
    const value = typeof options.limit === 'string' ? Number(options.limit) : options.limit
    if (!Number.isInteger(value) || value < 1) throw new RunError(400, 'limit', '必须是正整数')
    limit = Math.min(value, 100)
  }
  const root = resolve(runsRoot)
  let dirents = []
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return { runs: [], skipped: [] }
    throw error
  }

  const runs = []
  const skipped = []
  for (const entry of dirents) {
    if (!entry.isDirectory() || !checkRunId(entry.name)) continue
    const loc = locate(root, entry.name)
    if (!loc) continue
    let meta
    try {
      meta = await readMetaUnlocked(loc)
    } catch (error) {
      skipped.push({ id: entry.name, reason: describeMetaError(error) })
      continue
    }
    if (!meta) {
      skipped.push({ id: entry.name, reason: 'run.json 缺失、为空或不是合法 JSON' })
      continue
    }
    runs.push({
      id: meta.id,
      name: meta.name,
      flowId: meta.flowId,
      flowName: meta.flowName,
      status: meta.status,
      started: meta.started,
      engine: meta.engine,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      nodeDone: meta.nodeDone,
      nodeTotal: meta.nodeTotal,
      tokenTotal: meta.tokenTotal,
      eventCount: meta.eventCount,
      // 05 §8.3：progress（含每节点状态）三个端点都要发；列表只读 run.json 的增量计数器，
      // 不扫事件，所以和详情同口径靠 progressFromNodeStates 保证。
      progress: meta.progress && meta.progress.nodes
        ? progressFromNodeStates(meta.progress.nodes, meta.nodeTotal)
        : undefined,
    })
  }

  runs.sort((a, b) => {
    const ta = Date.parse(a.startedAt)
    const tb = Date.parse(b.startedAt)
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta
    return String(b.startedAt).localeCompare(String(a.startedAt))
  })
  return { runs: runs.slice(0, limit), skipped }
}

/**
 * run 详情：元数据 + 节点 / attempt 索引（每个 attempt 的事件数与首末时间）。
 * @returns {Promise<{ run: object, nodes: object[], eventCount: number } | null>}
 */
export async function readRunDetail(runsRoot, runId) {
  const loc = locate(runsRoot, runId)
  if (!loc) return null
  let meta
  try {
    meta = await readMetaUnlocked(loc)
  } catch {
    return null
  }
  if (!meta) return null
  const all = await readAllEventsUnlocked(loc, meta)
  const nodes = new Map()

  for (const event of all.events) {
    if (typeof event.nodeId !== 'string' || !checkRunId(event.nodeId)) continue
    if (!nodes.has(event.nodeId)) nodes.set(event.nodeId, { nodeId: event.nodeId, title: null, attempts: new Map(), eventCount: 0 })
    const node = nodes.get(event.nodeId)
    node.eventCount += 1
    // 节点标题只在 node/start 的 data.title 里出现过一次；客户端要按标题展示节点状态，
    // 这里顺手记下来（没有就保持 null，客户端回落到 nodeId）。
    if (node.title === null && event.kind === 'node/start'
      && event.data && typeof event.data.title === 'string' && event.data.title !== '') {
      node.title = event.data.title.slice(0, 200)
    }
    if (!Number.isInteger(event.attemptId)) continue
    if (!node.attempts.has(event.attemptId)) {
      node.attempts.set(event.attemptId, {
        attemptId: event.attemptId,
        eventCount: 0,
        firstTs: event.ts,
        lastTs: event.ts,
        status: null,
      })
    }
    const attempt = node.attempts.get(event.attemptId)
    attempt.eventCount += 1
    if (typeof event.ts === 'string') {
      if (!attempt.firstTs) attempt.firstTs = event.ts
      attempt.lastTs = event.ts
    }
    if (event.kind === 'node/end' && event.data && typeof event.data.status === 'string') {
      attempt.status = event.data.status
    }
  }

  const progress = computeProgress(all.events)
  const storageError = await readStorageError(loc.dir)
  return {
    run: {
      ...meta,
      ...(storageError ? { storageError } : {}),
      // §8.3 / §8.6：nodeDone / tokenTotal 一律取 run.json 计数器，保证
      // GET /runs 与 GET /runs/<id> 同口径同值；progress 仅供核对。
      nodeDone: meta.nodeDone,
      tokenTotal: meta.tokenTotal,
      nodeTotal: meta.nodeTotal,
      progress: {
        passed: progress.passed,
        skipped: progress.skipped,
        failed: progress.failed,
        rejected: progress.rejected,
        invalidated: progress.invalidated,
        invalidatedNodes: progress.invalidatedNodes,
        // B1：详情接口也要带每节点状态——只回计数会让客户端拿不到 nodes、
        // 长跑或事件窗口被截断时只能退回事件窗口推导，已通过的节点会显示成未开始。
        nodes: progress.nodes,
        total: progress.total,
        observed: progress.observed,
        denominator: progress.denominator,
        ratio: progress.ratio,
      },
    },
    nodes: [...nodes.values()]
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .map(node => ({
        nodeId: node.nodeId,
        title: node.title,
        eventCount: node.eventCount,
        attempts: [...node.attempts.values()].sort((a, b) => a.attemptId - b.attemptId),
      })),
    eventCount: all.events.length,
    skipped: all.skipped,
  }
}
