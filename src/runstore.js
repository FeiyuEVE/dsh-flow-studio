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
import { randomInt } from 'node:crypto'
import {
  chmod, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  MAX_BATCH_EVENTS, MAX_EVENT_BYTES, MAX_RUN_EVENTS, checkMemberId, checkRunId, computeProgress,
  normalizeEvent, progressFromNodeStates,
} from './runlog.js'
import { resolveHome } from './store.js'

/** run.json 的体积上限：元数据不该有成百上千行。 */
const MAX_META_BYTES = 1024 * 1024

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
  return {
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
    ...(source.worktree === undefined ? {} : { worktree: normalizeBinding(source.worktree, WORKTREE_KEYS) }),
    ...(source.supervision === undefined ? {} : { supervision: normalizeBinding(source.supervision, SUPERVISION_KEYS) }),
    // 07 §11（R8）：节点自审上报的最新结构化状态，nodeId → 状态对象。
    ...(source.nodeStatus === undefined ? {} : { nodeStatus: normalizeNodeStatus(source.nodeStatus) }),
  }
}

/** 节点状态表：每个节点只留最新一条，最多 200 个节点，字段逐个收敛。 */
const NODE_STATUS_KEYS = ['state', 'progress', 'summary', 'verdict', 'at']
const NODE_STATUS_STATES = new Set(['working', 'done', 'blocked', 'failed'])

function normalizeNodeStatus(raw) {
  if (!isPlainObject(raw)) return null
  const out = {}
  for (const [nodeId, value] of Object.entries(raw).slice(0, 200)) {
    if (!isPlainObject(value)) continue
    const entry = normalizeBinding(value, NODE_STATUS_KEYS)
    if (!entry) continue
    if (!NODE_STATUS_STATES.has(entry.state)) entry.state = 'working'
    if (!Number.isInteger(entry.progress) || entry.progress < 0) entry.progress = 0
    if (entry.progress > 100) entry.progress = 100
    if (entry.summary !== null && entry.summary !== undefined && typeof entry.summary === 'string') {
      entry.summary = entry.summary.length > 2000 ? entry.summary.slice(0, 2000) : entry.summary
    } else {
      delete entry.summary
    }
    if (entry.verdict !== 'pass' && entry.verdict !== 'reject') entry.verdict = null
    // members / blockers 只在事件里留全量；run.json 只留计数，避免元数据膨胀。
    const members = Array.isArray(value.members) ? value.members : []
    const blockers = Array.isArray(value.blockers) ? value.blockers : []
    entry.members = members.slice(0, 20).map(member => {
      if (!isPlainObject(member)) return { name: '', state: 'working' }
      const note = text2(member.note, '')
      return {
        name: text2(member.name, '').slice(0, 200),
        state: NODE_STATUS_STATES.has(member.state) ? member.state : 'working',
        ...(note !== '' ? { note: note.slice(0, 200) } : {}),
      }
    })
    entry.blockers = blockers.slice(0, 20).map(item => text2(item, '').slice(0, 200)).filter(Boolean)
    out[nodeId] = entry
  }
  return out
}

function text2(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** 节点会话模式（07 §3）：未知值一律 null，不猜一个看起来合理的。 */
const SESSION_MODES = new Set(['top-level', 'legacy-subagent', 'injected', 'stub', 'unavailable'])
const WORKSPACE_KEYS = ['id', 'path', 'realpath', 'isGit', 'gitRoot']
const WORKTREE_KEYS = ['enabled', 'reason', 'decidedBy', 'path', 'branch', 'baseCommit', 'createdAt']
const SUPERVISION_KEYS = ['enabled', 'wakerSessionId', 'lastWokeAt', 'nextDueAt', 'wakes', 'failures', 'reason']

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

async function readMetaUnlocked(loc) {
  let text
  try {
    text = await readFile(metaPath(loc.dir), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_META_BYTES) return null
  try {
    return normalizeMeta(JSON.parse(text), loc.id)
  } catch {
    // 坏 meta 当成不存在：一份手改坏的 JSON 不该让整个 run 列表 500。
    return null
  }
}

let tmpCounter = 0

async function writeMetaUnlocked(loc, meta) {
  await ensureDirMode(loc.dir)
  const text = `${JSON.stringify(meta, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_META_BYTES) {
    throw new RunError(500, 'run', 'run.json 超过 1MiB，元数据异常')
  }
  const tmp = `${metaPath(loc.dir)}.tmp-${process.pid}-${tmpCounter++}`
  await writeFile(tmp, text, { encoding: 'utf8', mode: FILE_MODE })
  try {
    await rename(tmp, metaPath(loc.dir))
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  await chmod(metaPath(loc.dir), FILE_MODE).catch(() => {})
  return meta
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
  // 两条并发防线：进程内 withLock（快），进程间 start.lock（O_EXCL，跨 host / 跨进程也只有一个赢家）。
  return withLock(loc.id, () => withRunFileLock(loc.dir, START_LOCK_FILE, async () => {
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
  }))
}

/**
 * 06 §13.3 单写者租约：`runs/<runId>/lock.json`（pid / host / heartbeatAt / ttlMs）。
 * 过期由读取方清理；`sweepExpiredLeases()` 会把过期租约的 running run 标 failed。
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
  return { pid, host, ttlMs, acquiredAt, heartbeatAt }
}

function leaseExpired(lease, now) {
  return Date.parse(lease.heartbeatAt) + lease.ttlMs <= now.getTime()
}

function leaseOwner(lease) {
  return `${lease.pid}@${lease.host}`
}

function leaseOwnerMatches(lease, options) {
  const pid = Number.isInteger(options.pid) && options.pid > 0 ? options.pid : process.pid
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : hostname()
  return lease.pid === pid && lease.host === host
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
  try {
    await handle.writeFile(text)
  } finally {
    await handle.close()
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
  const deadline = Date.now() + waitMs
  const nonce = `${process.pid}-${Date.now().toString(36)}-${tmpCounter++}-${Math.random().toString(36).slice(2, 8)}`
  for (;;) {
    if (await createExclusive(path, `${nonce}\n`)) {
      await sleep(LOCK_SETTLE_MS)
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
      throw new RunError(409, 'runId', '另一个进程正在处理这个 run，请稍后重试')
    }
    await sleep(8)
  }
}

async function readLeaseFile(dir) {
  let text
  try {
    text = await readFile(leasePath(dir), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  try {
    return normalizeLease(JSON.parse(text))
  } catch {
    return null
  }
}

async function writeLeaseFile(dir, lease) {
  await ensureDirMode(dir)
  const text = `${JSON.stringify(lease, null, 2)}\n`
  const tmp = `${leasePath(dir)}.tmp-${process.pid}-${tmpCounter++}`
  await writeFile(tmp, text, { encoding: 'utf8', mode: FILE_MODE })
  try {
    await rename(tmp, leasePath(dir))
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  await chmod(leasePath(dir), FILE_MODE).catch(() => {})
}

async function removeLeaseFile(dir, lease) {
  if (lease) {
    const current = await readLeaseFile(dir).catch(() => null)
    if (current && leaseOwner(current) !== leaseOwner(lease)) return false
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
  }
}

/**
 * 读当前租约。过期租约视为不存在并顺手清掉；没有租约返回 null。
 * @returns {Promise<object | null>}
 */
export async function readLease(runsRoot, runId, options = {}) {
  const loc = locate(runsRoot, runId)
  if (!loc) return null
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date()
  const lease = await readLeaseFile(loc.dir).catch(() => null)
  if (!lease) return null
  if (leaseExpired(lease, now)) {
    await removeLeaseFile(loc.dir).catch(() => {})
    return null
  }
  return lease
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
  const { now, ttlMs, pid, host } = leaseOptions(options)
  const path = leasePath(loc.dir)
  return withLock(loc.id, async () => {
    const iso = now.toISOString()
    const lease = { pid, host, ttlMs, acquiredAt: iso, heartbeatAt: iso }
    const text = `${JSON.stringify(lease, null, 2)}\n`
    const owned = async () => {
      const current = await readLeaseFile(loc.dir)
      return Boolean(current && current.pid === pid && current.host === host && current.acquiredAt === iso)
    }
    const busy = existing => new RunError(
      409,
      'runId',
      `该 run 正被 ${leaseOwner(existing)} 持有执行租约（心跳 ${existing.heartbeatAt}），不能重复启动`,
    )
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (await createExclusive(path, text)) {
        if (await owned()) return lease
        throw new RunError(409, 'runId', '执行租约刚被其它进程接管，请重试')
      }
      const existing = await readLeaseFile(loc.dir)
      // 持有者刚好释放：直接重试创建。
      if (!existing) continue
      if (!leaseExpired(existing, now)) throw busy(existing)
      if (!await winTakeoverElection(loc.dir)) {
        // 输掉选举：等赢家落定，再重读（通常已经被新租约挡住）。
        await sleep(TAKEOVER_ELECTION_MS)
        continue
      }
      const again = await readLeaseFile(loc.dir)
      if (!again) continue
      if (!leaseExpired(again, now)) throw busy(again)
      await unlink(path).catch(() => {})
      if (await createExclusive(path, text)) {
        if (await owned()) return lease
        throw new RunError(409, 'runId', '执行租约刚被其它进程接管，请重试')
      }
    }
    throw new RunError(409, 'runId', '并发抢占执行租约失败，请重试')
  })
}

/**
 * 续租。租约不存在 / 已过期 / 不是本进程持有 → 409。
 * @returns {Promise<object>} 续租后的租约
 */
export async function renewLease(runsRoot, runId, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  const { now, ttlMs, pid, host } = leaseOptions(options)
  return withLock(loc.id, async () => {
    const existing = await readLeaseFile(loc.dir)
    if (!existing) throw new RunError(409, 'runId', '该 run 没有执行租约，无法续租')
    if (leaseExpired(existing, now)) {
      await removeLeaseFile(loc.dir).catch(() => {})
      throw new RunError(409, 'runId', '执行租约已过期（引擎可能已中断），不能续租')
    }
    if (!leaseOwnerMatches(existing, { pid, host })) {
      throw new RunError(409, 'runId', `执行租约由 ${leaseOwner(existing)} 持有，本实例无权续租`)
    }
    const lease = {
      ...existing,
      ttlMs,
      heartbeatAt: now.toISOString(),
    }
    await writeLeaseFile(loc.dir, lease)
    return lease
  })
}

/**
 * 释放租约；只能释放本实例持有的（`force:true` 可强制清）。
 * @returns {Promise<boolean>} 是否真的删掉
 */
export async function releaseLease(runsRoot, runId, options = {}) {
  const loc = locate(runsRoot, runId)
  if (!loc) return false
  return withLock(loc.id, async () => {
    const existing = await readLeaseFile(loc.dir)
    if (!existing) return false
    if (options.force !== true && !leaseOwnerMatches(existing, options)) {
      throw new RunError(409, 'runId', `执行租约由 ${leaseOwner(existing)} 持有，不能由本实例释放`)
    }
    return removeLeaseFile(loc.dir)
  })
}

/**
 * 启动时清理过期租约：**只扫 `running`**，把租约过期（引擎崩溃）的 run 标 failed，
 * reason 含「引擎中断」。返回被处理的 runId。
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
    const meta = await readMetaUnlocked(loc).catch(() => null)
    if (!meta || meta.status !== 'running') continue
    const lease = await readLeaseFile(loc.dir).catch(() => null)
    if (!lease || !leaseExpired(lease, now)) continue
    const reason = `引擎中断：执行租约过期（${leaseOwner(lease)}，心跳 ${lease.heartbeatAt}），不自动续跑`
    try {
      await appendEvents(runsRoot, loc.id, [{
        v: 1,
        kind: 'run/end',
        traceId: `tr-${loc.id.slice(0, 80)}-sweep`,
        data: { status: 'failed', reason: reason.slice(0, 2000) },
        extra: { recovered: true, engineInterrupted: true, leaseExpired: true },
      }], { now })
    } catch (error) {
      await markStorageFailure(loc, error).catch(() => {})
      await writeRunMeta(runsRoot, loc.id, {
        status: 'failed',
        endedAt: now.toISOString(),
        live: null,
      }).catch(() => {})
    }
    await removeLeaseFile(loc.dir, lease).catch(() => {})
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
    const meta = await readMetaUnlocked(loc).catch(() => null)
    if (!meta || TERMINAL_STATUS.has(meta.status)) continue
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
      if (event && event.kind === 'run/end' && event.data && TERMINAL_STATUS.has(event.data.status)) {
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
  const tmp = join(loc.dir, `${ERROR_FILE}.tmp-${process.pid}-${tmpCounter++}`)
  await writeFile(tmp, text, { encoding: 'utf8', mode: FILE_MODE })
  await rename(tmp, join(loc.dir, ERROR_FILE))
  await chmod(join(loc.dir, ERROR_FILE), FILE_MODE).catch(() => {})
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
 * @returns {Promise<object>} 写入后的完整 meta
 */
export async function writeRunMeta(runsRoot, runId, patch = {}) {
  const loc = requireLoc(runsRoot, runId)
  return withLock(loc.id, async () => {
    try {
      const info = await stat(loc.dir)
      if (!info.isDirectory()) throw new RunError(404, 'runId', 'run 不存在')
    } catch (error) {
      if (error && error.code === 'ENOENT') throw new RunError(404, 'runId', 'run 不存在')
      throw error
    }
    const existing = await readMetaUnlocked(loc)
    const merged = normalizeMeta({ ...(existing || {}), ...(patch && typeof patch === 'object' ? patch : {}) }, loc.id)
    merged.updatedAt = new Date().toISOString()
    if (!existing) merged.createdAt = merged.updatedAt
    return writeMetaUnlocked(loc, merged)
  })
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
  return withLock(loc.id, async () => {
    await ensureDirMode(loc.dir)
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
    const handle = await open(path, 'a', FILE_MODE)
    try {
      await handle.writeFile(lines.join(''), 'utf8')
    } finally {
      await handle.close()
    }
    await chmod(path, FILE_MODE).catch(() => {})
    return { appended: lines.length }
  })
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
    out[nodeId] = {
      sessionId: entry.sessionId,
      createdAt: normalizeIso(entry.createdAt) || new Date().toISOString(),
      lastUsedAt: normalizeIso(entry.lastUsedAt) || normalizeIso(entry.createdAt) || new Date().toISOString(),
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
      normalized[nodeId] = {
        sessionId: entry.sessionId,
        createdAt: normalizeIso(entry.createdAt) || new Date().toISOString(),
        lastUsedAt: normalizeIso(entry.lastUsedAt) || normalizeIso(entry.createdAt) || new Date().toISOString(),
      }
    }
  }
  const text = `${JSON.stringify(normalized, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_SESSIONS_BYTES) {
    throw new RunError(400, 'sessions', 'sessions.json 超过 512KB 上限')
  }
  await ensureDirMode(loc.dir)
  const path = sessionsPath(loc.dir)
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
  await writeFile(tmp, text, { encoding: 'utf8', mode: FILE_MODE })
  try {
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  await chmod(path, FILE_MODE).catch(() => {})
  return normalized
}

/** 原子整写节点会话表（临时文件 + rename，0600）。 */
export async function writeNodeSessions(runsRoot, runId, sessions) {
  const loc = requireLoc(runsRoot, runId)
  return withLock(loc.id, () => writeSessionsUnlocked(loc, sessions))
}

/**
 * 写入/更新一个节点的会话（读-改-写在同一把进程内锁里完成）。
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
  return withLock(loc.id, async () => {
    const current = await readNodeSessions(runsRoot, runId)
    const previous = current[nodeId]
    const entry = {
      sessionId,
      createdAt: previous && previous.sessionId === sessionId && options.resetCreatedAt !== true
        ? previous.createdAt
        : now.toISOString(),
      lastUsedAt: now.toISOString(),
    }
    current[nodeId] = entry
    return writeSessionsUnlocked(loc, current)
  })
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
  return withLock(loc.id, async () => {
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
  })
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

// 与 runlog 的事件白名单（EVENT_KINDS + INBOX_EVENT_KINDS）保持一致；
// 单独列一份避免这里 import 整个校验器。
const EVENT_KINDS = new Set([
  'run/start', 'run/end', 'node/start', 'node/end', 'member/start', 'member/end',
  'model/call', 'tool/call', 'skill/load', 'artifact/write', 'reject/trigger',
  'review/finding', 'review/verdict', 'check/form',
  'acceptance/verdict', 'test/report', 'agent/message',
  // 06 §16：流程收件箱事件。
  'message/in', 'message/out',
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
  const tmp = join(dir, `${USAGE_FILE}.tmp-${process.pid}-${tmpCounter++}`)
  await writeFile(tmp, text, { encoding: 'utf8', mode: FILE_MODE })
  try {
    await rename(tmp, join(dir, USAGE_FILE))
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  await chmod(join(dir, USAGE_FILE), FILE_MODE).catch(() => {})
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
 * 追加一批事件。整批校验：任何一条不合法就一条都不写。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {object|object[]} rawEvents 单条或数组
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ events: object[], run: object, firstSeq: number, lastSeq: number }>}
 */
export async function appendEvents(runsRoot, runId, rawEvents, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  return withLock(loc.id, async () => {
    const meta = await readMetaUnlocked(loc)
    if (!meta) throw new RunError(404, 'runId', 'run 不存在')

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
      for (const [rel, events] of groups) {
        const abs = resolve(loc.dir, rel)
        if (!isInside(loc.dir, abs)) throw new RunError(500, 'runId', '事件路径越出 run 目录')
        await ensureDirMode(dirname(abs))
        const text = events.map(event => `${JSON.stringify(event)}\n`).join('')
        const handle = await open(abs, 'a', FILE_MODE)
        try {
          await handle.writeFile(text, 'utf8')
        } finally {
          await handle.close()
        }
        await chmod(abs, FILE_MODE).catch(() => {})
      }

      // §8.6：计数器在追加时原子更新，列表只需读 run.json。
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
          if (TERMINAL_STATUS.has(event.data.status)) meta.status = event.data.status
          meta.started = true
          if (typeof event.ts === 'string') meta.endedAt = event.ts
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
      meta.lastSeq = lastSeq
      meta.seq = lastSeq
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
      // 06 §13.4：写盘失败也必须能落终态——原子改 run.json 为 failed + 写 .error 侧车。
      await markStorageFailure(loc, error).catch(() => {})
      const failedMeta = normalizeMeta({
        ...meta,
        status: 'failed',
        started: true,
        endedAt: now.toISOString(),
        live: null,
        updatedAt: now.toISOString(),
      }, loc.id)
      await writeMetaUnlocked(loc, failedMeta).catch(() => {})
      if (error instanceof RunError) throw error
      // 不回原始错误信息（可能带宿主绝对路径），细节在 .error 侧车里。
      throw new RunError(500, 'storage', '事件写盘失败，run 已被原子标记为 failed（细节见 .error 侧车文件）')
    }

    return { events: normalized, run: meta, firstSeq, lastSeq }
  })
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
