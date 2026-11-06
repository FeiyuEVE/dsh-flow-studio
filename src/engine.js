/**
 * 执行引擎（Host 半边，v0.4）：把一张流程按 `next` 边真的跑起来。
 *
 * 权威规格：`docs/design/06-execution-engine.md`、`docs/design/07-runtime-0.7.md`；
 * 事件契约：`docs/design/05-run-log.md`。
 *
 * 设计要点：
 *   - **依赖注入**：唯一模型入口是 `createEngine({ activate, ... })` 里的 `activate`。
 *     没注入时走默认实现（07 §3.1）：`agents.create({ sessionId, meta:{ cwd } })` 新建
 *     **顶层**节点主管会话（不传 parentAgent / parentSession / origin / delegationDepth），
 *     再 followup 提示词、whenIdle、从 assistant 原文解析结构化输出。引擎不 import 任何
 *     dsh 包。
 *   - **主循环**：run/start → 逐个阶段节点（node/start → 执行 → node/end）→ reject 时
 *     选 reject 边、写 reject/trigger、目标节点 attempt+1 重跑 → run/end。只走 next 边，不并行。
 *   - **一个实例一个 run（07 §5，R3）**：没有模块级锁 / 并发上限 / 排队；跨 run 的注册表
 *     与 409 由 `src/runtime.js` 负责，不同 runId 各自一个实例并行。
 *   - **产物与证据**：产物落 `runs/<runId>/<nodeId>/artifacts/<attempt>/` 并写 artifact/write；
 *     acceptance / tests / checks / findings 落成 05 的事件，quality 才有证据可算。
 *   - **用量**：订阅 `session/event`（global），assistant/message 的 usage → model/call，
 *     tool/call 里的 skill → skill/load，其余工具 → tool/call；成员会话按 memberId 归属。
 *   - **取消 / 超时 / 失败**：每个 run 一个 AbortController；单节点 20 分钟（可用
 *     FLOW_STUDIO_NODE_TIMEOUT_MS 覆盖）；异常一律落 run/end{status:'failed',reason}。
 *   - **可测性**：FLOW_STUDIO_STUB_ENGINE=1 用内置桩，产出 pass/reject + 合成 usage + 证据。
 *
 * @module @feiyueve/dsh-flow-studio/engine
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, realpath as realpathAsync, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { EDGE_KIND, EXEC_MODE, EXECUTOR, NODE_KIND } from './model.js'
import { checkRunId, isSafeRelPath, normalizeEvent } from './runlog.js'
import { consumeInboxForNode, buildFollowupPayload } from './inbox.js'
// 07 §4（R1+R4）：工作区解析 / worktree 决策是 start 时的一次性判断，纯逻辑 + 真 git。
import { createWorktree, decideWorktree, resolveWorkspace, workspaceIdFor } from './worktree.js'
// 07 §6（R6）：外部 executor（codex / custom）的运行与事件归一化。
import { normalizeExecutor, runExternalExecutor } from './executor.js'
import {
  RunError, appendEvents, readAllEvents, readRunMeta, runsDir, writeRunMeta,
} from './runstore.js'
// 06 §13.2/§13.3 的原子状态迁移与单写者租约由 Host 侧（runstore）并行任务提供。
// 用命名空间导入 + 可选链兜底：并行改动尚未落地时引擎仍能工作（否则 ESM 命名导入会直接报错）。
import * as runstoreModule from './runstore.js'
import { flowsDir, readFlow } from './store.js'

/** 单节点默认超时：20 分钟（06 §9）。 */
export const DEFAULT_NODE_TIMEOUT_MS = 20 * 60 * 1000

/** 崩溃残留 run 的判定窗口：30 分钟无新事件（06 §9）。 */
export const DEFAULT_STALE_MS = 30 * 60 * 1000

/** run 级墙钟上限：默认 2 小时（06 §13.5，`FLOW_STUDIO_RUN_TIMEOUT_MS` 可覆盖）。 */
export const DEFAULT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000

/** 单产物上限 1 MiB、单 run 产物总预算 64 MiB（06 §13.9）。 */
export const MAX_ARTIFACT_BYTES = 1024 * 1024
export const MAX_RUN_ARTIFACT_BYTES = 64 * 1024 * 1024

/** 提示词硬上限（06 §6）。 */
export const PROMPT_MAX_CHARS = 8000

/**
 * 节点级失败的重试次数（06 §9）：默认重试 1 次（共 2 次尝试）。
 * `FLOW_STUDIO_NODE_RETRIES` 可覆盖；为防配置把人拖死，钳制在 0–5（最多 6 次尝试）。
 */
export const DEFAULT_NODE_RETRIES = 1
export const MAX_NODE_RETRIES = 5

/**
 * 上游产物正文的注入预算（06 §6，单位：Unicode 码点）。
 *
 * 为什么是 1200 / 3000 / 2 个文件：
 *   - 下游真正需要的是「上一棒做了什么、有什么约束」，不是整份文档；1200 字够放
 *     一段结论 + 关键清单，再长就应该让下游按路径自己去读。
 *   - 七段骨架总共 8000 字，上游段还要放摘要与路径；内容给 3000 字约留 37% 余量，
 *     既不挤掉任务 / 输出格式，也不会因为两个产物就把提示词撑爆。
 *   - 最近 2 个产物：覆盖「上一阶段 + 再上一个阶段」两条最相关上下文；再多只是
 *     重复摘要里已经有的信息。
 */
export const UPSTREAM_ARTIFACT_MAX_CHARS = 1200
export const UPSTREAM_ARTIFACT_TOTAL_CHARS = 3000
export const UPSTREAM_ARTIFACT_MAX_FILES = 2

/**
 * 单个上游产物文件的最大读取字节数。产物本身已有 1 MiB 上限，但正文只取头部
 * 1200 字；超过这个上限就不读正文（降级为只给路径），避免为了一段摘要把接近
 * 1 MiB 的文本读进主进程内存。读不到 / 超限都不算错误。
 */
export const UPSTREAM_ARTIFACT_READ_MAX_BYTES = 256 * 1024

/** 桩执行器每次 attempt 的合成用量（四桶 + reasoning，reasoning 是 output 子集）。 */
export const STUB_USAGE = Object.freeze({
  input: 100, cacheRead: 20, cacheWrite: 0, output: 30, reasoning: 10,
})

/** 引擎侧可预期的 HTTP 语义错误：路由层按 status 回 JSON。 */
export class EngineError extends RunError {
  constructor(status, message, extra = {}) {
    super(Number.isInteger(status) ? status : 500, null, message, extra)
    this.name = 'EngineError'
  }
}

/** 节点超时（与普通失败区分，便于写 extra.timeout）。 */
class NodeTimeoutError extends Error {
  constructor(nodeId, timeoutMs) {
    super(`节点「${nodeId}」执行超时（${timeoutMs}ms）`)
    this.name = 'NodeTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** 结构不合格（缺 verdict / 不是对象）。 */
class StructuredOutputError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'StructuredOutputError'
    this.validationError = reason
  }
}

const VERDICTS = new Set(['pass', 'reject'])
const SEVERITIES = new Set(['P0', 'P1', 'P2'])
const FINDING_STATUSES = new Set(['open', 'accepted', 'fixed', 'verified', 'dismissed'])
const ACCEPTANCE_STATUSES = new Set(['pass', 'fail', 'skip', 'na'])
const DECIDED_BY = new Set(['human', 'auto'])
const CHECK_STATES = new Set(['pass', 'fail', 'skipped', 'na'])
const ARTIFACT_KINDS = new Set(['md', 'diff', 'json', 'log'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** run.json 绑定补写的临时文件计数器（与 runstore 的 tmp 名分开，避免撞名）。 */
let patchCounter = 0

/** 目录/文件是否存在；坏路径一律 false（只用于「建完复核」，不抛错）。 */
function existsSyncSafe(path) {
  if (typeof path !== 'string' || path === '') return false
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** 未启用 worktree 时的 run.json 记录（字段给 null，形状固定，客户端不用判 undefined）。 */
function disabledWorktree(reason) {
  return {
    enabled: false,
    reason: typeof reason === 'string' && reason !== '' ? reason : 'not-a-git-repo',
    decidedBy: 'initiator',
    path: null,
    branch: null,
    baseCommit: null,
    createdAt: null,
  }
}

/** 复用 run.json 里已有的 worktree 记录：只接受 enabled + 非空 path，字段做类型归一。 */
function normalizeWorktreeRecord(saved) {
  if (!saved || typeof saved !== 'object') return disabledWorktree('not-a-git-repo')
  if (saved.enabled !== true) return disabledWorktree(saved.reason)
  return {
    enabled: true,
    reason: typeof saved.reason === 'string' && saved.reason !== '' ? saved.reason : 'git-workspace',
    decidedBy: 'initiator',
    path: typeof saved.path === 'string' ? saved.path : null,
    branch: typeof saved.branch === 'string' ? saved.branch : null,
    baseCommit: typeof saved.baseCommit === 'string' ? saved.baseCommit : null,
    createdAt: typeof saved.createdAt === 'string' ? saved.createdAt : null,
  }
}

function intOr(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function clip(value, max) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 长度按 Unicode 码点截断（中文场景比 UTF-16 长度更接近「字」）。 */
function clipChars(value, max) {
  const chars = Array.from(String(value ?? ''))
  if (chars.length <= max) return chars.join('')
  if (max <= 1) return chars.slice(0, max).join('')
  return `${chars.slice(0, max - 1).join('')}…`
}

/** 按 UTF-8 字节数安全截断（不会写出半个多字节字符）。 */
function clipBytes(value, maxBytes) {
  const buffer = Buffer.from(String(value ?? ''), 'utf8')
  if (buffer.length <= maxBytes) return { text: String(value ?? ''), bytes: buffer.length }
  const slice = buffer.subarray(0, Math.max(0, maxBytes)).toString('utf8')
  return { text: slice, bytes: Buffer.byteLength(slice, 'utf8') }
}

/**
 * 工具参数摘要脱敏（06 §13.9 m3）：凭据原文不得进日志与导出。
 * 覆盖 `Bearer …`、`sk-…`、`token|password|secret|api_key` 的值，以及超长连续串。
 * @param {unknown} raw
 * @returns {string}
 */
export function redactArguments(raw) {
  let text = typeof raw === 'string' ? raw : String(raw ?? '')
  // 1) Authorization: Bearer <token>
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer [REDACTED]')
  // 2) sk- 开头的 API key（保留前缀给排查看，值抹掉）
  text = text.replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-[REDACTED]')
  // 3) key: value / key=value / "key": "value" 形式（；，也算分隔符，中文句子里的多组凭据才不会漏）
  text = text.replace(
    /(["']?(?:token|password|passwd|secret|api[_-]?key|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}；，]+)/gi,
    (match, prefix, value) => {
      if (/^Bearer$/i.test(String(value).replace(/["']/g, ''))) return match
      return `${prefix}"[REDACTED]"`
    },
  )
  // 4) 超长连续串（哈希 / JWT 片段 / 裸 token）：≥32 个不含空白的可疑字符。
  text = text.replace(/[A-Za-z0-9_+/=.-]{32,}/g, '[REDACTED]')
  return text
}

/** §8.2：agent/message 文本上限（码点）。 */
export const AGENT_MESSAGE_MAX_CHARS = 2000
/** §8.2：文本的 UTF-8 兜底上限，保证单条事件仍 < MAX_EVENT_BYTES(8KB)。 */
export const AGENT_MESSAGE_MAX_BYTES = 4096
/** §13.12：live.lastMessage.text 上限（码点）。 */
export const LIVE_MESSAGE_MAX_CHARS = 200
/** §13.12：live.nodeTitle 上限（码点）。 */
export const LIVE_NODE_TITLE_MAX_CHARS = 200
/** §13.12：live.members 上限。 */
export const LIVE_MEMBERS_MAX = 16
/** §8.2：同会话连续相同文本去重表的上限。 */
const ASSISTANT_TEXT_CACHE_MAX = 64

function textOfContentBlock(block) {
  if (typeof block === 'string') return block
  if (!block || typeof block !== 'object') return ''
  // 宿主 ContentBlock：{ type:'text', text }；只取可见文本，reasoning 等其它块不算。
  if (typeof block.type === 'string') {
    return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
  }
  // 防御简化形状：{ text } / 嵌套 content。
  if (typeof block.text === 'string') return block.text
  if (block.content !== undefined) return extractAssistantText(block)
  return ''
}

/**
 * 防御性提取 assistant 消息的可见文本（06 §13.12 / 05 §8.2）。
 *
 * 真宿主形状（`dsh-llm` 的 `AssistantMessage`）：
 *   `{ role:'assistant', content:[{ type:'text', text }], source:{ kind:'model', provider, model } }`
 * 同时兼容 `content` 为字符串、`message.text`、以及直接给字符串的测试夹具。
 * 提不到文本（空串 / 全空白）返回 ''，调用方据此不发事件。
 *
 * @param {unknown} message
 * @returns {string}
 */
export function extractAssistantText(message) {
  if (typeof message === 'string') return message
  if (!message || typeof message !== 'object') return ''
  let text = ''
  if (typeof message.content === 'string') text = message.content
  else if (Array.isArray(message.content)) {
    text = message.content.map(textOfContentBlock).filter(part => part !== '').join('\n')
  } else if (message.content && typeof message.content === 'object') {
    text = textOfContentBlock(message.content)
  }
  if (text === '' && typeof message.text === 'string') text = message.text
  return text.trim() === '' ? '' : text
}

/** 按码点截断到 2000 字符；再用 UTF-8 字节兜底，确保 8KB 事件上限不会踩线。 */
function clipAssistantText(raw) {
  const chars = Array.from(raw)
  let text = raw
  let truncated = false
  if (chars.length > AGENT_MESSAGE_MAX_CHARS) {
    text = `${chars.slice(0, AGENT_MESSAGE_MAX_CHARS - 1).join('')}…`
    truncated = true
  }
  if (Buffer.byteLength(text, 'utf8') > AGENT_MESSAGE_MAX_BYTES) {
    const prefix = Buffer.from(text, 'utf8').subarray(0, AGENT_MESSAGE_MAX_BYTES - 3).toString('utf8')
    text = `${prefix.replace(/\uFFFD+$/u, '')}…`
    truncated = true
  }
  return { text, truncated }
}

/**
 * 成员 id：`<nodeId>:<序号>`（06 §4.2），总长压到 64 以内。
 * 06 §13.10：截断可能碰撞（两个长 nodeId 前 50 字相同），超长时把完整 nodeId 的
 * 短哈希编进 id，保证不同节点不会拿到同一个 memberId。
 */
export function memberIdFor(nodeId, index) {
  const id = String(nodeId)
  if (id.length <= 50) return `${id}:${index}`
  const digest = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 8)
  return `${id.slice(0, 40)}-${digest}:${index}`
}

/** 节点会话 id 的总长上限（会话 id 会进持久化路径，留足余量）。 */
export const NODE_SESSION_ID_MAX = 96

/** 会话 id 片段：只保留 [A-Za-z0-9._-]；发生替换 / 修剪 / 为空都算「有损」。 */
function sessionSlug(value, fallback) {
  const raw = String(value ?? '')
  const slug = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return { slug: slug === '' ? fallback : slug, lossy: slug === '' || slug !== raw }
}

/**
 * 节点主管会话 id（07 §3.2）：`<runId>--<nodeId>`，只含 `[A-Za-z0-9._-]`。
 *
 * - **稳定**：`attempt` 不进 id —— 同一 `(runId, nodeId)` 的二次激活 / 打回重跑
 *   复用同一个会话（0.6.0 已定的「一个节点一个会话」）。
 * - **唯一**：节点 id 可能是中文或含路径分隔符；slug 化有损（发生替换、截断、
 *   为空）时追加 `-` + 8 位内容哈希。纯函数没有跨调用状态，因此用内容哈希而不是
 *   「运行时发现冲突再改」，这样并发 / 跨进程也稳定。
 * - `attempt` 参数保留在签名里只是为了对齐契约，不参与计算。
 *
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} [_attempt]
 * @returns {string}
 */
export function nodeSessionId(runId, nodeId, _attempt) {
  const run = sessionSlug(runId, 'run')
  const node = sessionSlug(nodeId, 'node')
  const baseLimit = NODE_SESSION_ID_MAX - 9 // `-` + 8 位哈希
  let base = `${run.slug}--${node.slug}`
  let lossy = run.lossy || node.lossy
  if (base.length > baseLimit) {
    base = base.slice(0, baseLimit)
    lossy = true
  }
  if (!lossy) return base
  const digest = createHash('sha256').update(`${runId}\u0000${nodeId}`, 'utf8').digest('hex').slice(0, 8)
  return `${base}-${digest}`
}

/** 节点 traceId：同一次 attempt 的所有事件共用一条因果链，且不超过 128 字符。 */
function nodeTraceId(runId, nodeId, attempt) {
  return `tr-${String(runId).slice(0, 44)}-${String(nodeId).slice(0, 48)}-${attempt}`
}

function runTraceId(runId) {
  return `tr-${String(runId).slice(0, 80)}-run`
}

function isoOf(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date().toISOString()
}

function isAbortError(error) {
  return Boolean(error) && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
}

function abortError(signal) {
  const reason = signal && signal.reason
  if (reason instanceof Error) return reason
  const error = new Error('中止')
  error.name = 'AbortError'
  return error
}

/** 给一个 promise 套上 abort 竞争（底层 promise 仍会被消费，避免 unhandled rejection）。 */
function raceAbort(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {})
    return Promise.reject(abortError(signal))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function combineSignals(signals) {
  const list = signals.filter(Boolean)
  if (list.length === 0) return undefined
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  const controller = new AbortController()
  const onAbort = signal => controller.abort(signal.reason)
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => onAbort(signal), { once: true })
  }
  return controller.signal
}

function envInt(name, fallback) {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** 与 {@link envInt} 相同，但允许 0 并把值钳制在 [min, max]（重试次数用）。 */
function envIntClamped(name, fallback, min, max) {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

// ---------------------------------------------------------------------------
// 流程导航（只认 next 边；打回只认 reject 边）
// ---------------------------------------------------------------------------

function byIdMap(flow) {
  return new Map((flow.nodes || []).map(node => [node.id, node]))
}

/** 目标列最靠前 = x 最小；同列按 y、再按 id，保证确定性。 */
function leftmost(nodes) {
  return [...nodes].sort((a, b) => {
    const ax = Number.isFinite(a.x) ? a.x : Number.MAX_SAFE_INTEGER
    const bx = Number.isFinite(b.x) ? b.x : Number.MAX_SAFE_INTEGER
    if (ax !== bx) return ax - bx
    const ay = Number.isFinite(a.y) ? a.y : Number.MAX_SAFE_INTEGER
    const by = Number.isFinite(b.y) ? b.y : Number.MAX_SAFE_INTEGER
    if (ay !== by) return ay - by
    return String(a.id).localeCompare(String(b.id))
  })[0]
}

/** 沿 next 边选下一个节点（不并行：多出边时取最左）。 */
export function selectNextNode(flow, node) {
  const byId = byIdMap(flow)
  const edges = (flow.edges || []).filter(edge => edge.from === node.id && edge.kind === EDGE_KIND.NEXT)
  if (edges.length === 0) return null
  const targets = edges.map(edge => byId.get(edge.to)).filter(Boolean)
  return targets.length === 0 ? null : leftmost(targets)
}

/** 开始节点之后的第一个阶段节点；start 直接连 end 时返回 end。 */
export function selectFirstNode(flow) {
  const starts = (flow.nodes || []).filter(node => node.kind === NODE_KIND.START)
  if (starts.length === 0) throw new EngineError(400, '流程没有「开始」节点，无法执行')
  const start = leftmost(starts)
  const next = selectNextNode(flow, start)
  if (!next) return null
  return next
}

/** 打回目标（06 §5.2）：`rejectTarget` 命中某条 reject 边的 to 就用它；
 * 否则取该节点所有出向 reject 边里目标列最靠前的那条。
 * @returns {{ edge: object, target: object } | null}
 */
export function selectRejectTarget(flow, node, rejectTarget) {
  const byId = byIdMap(flow)
  const edges = (flow.edges || []).filter(edge => edge.from === node.id && edge.kind === EDGE_KIND.REJECT)
  if (edges.length === 0) return null
  if (typeof rejectTarget === 'string' && rejectTarget !== '') {
    const hit = edges.find(edge => edge.to === rejectTarget)
    if (hit) return { edge: hit, target: byId.get(hit.to) }
  }
  const candidates = edges
    .map(edge => ({ edge, target: byId.get(edge.to) }))
    .filter(item => item.target)
  if (candidates.length === 0) return null
  const target = leftmost(candidates.map(item => item.target))
  const picked = candidates.find(item => item.target.id === target.id)
  return picked || null
}

/** 沿 next 边能否从 from 走到 to（用于「上游」判定与重跑上下文过滤）。 */
export function canReachViaNext(flow, from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return false
  const byId = byIdMap(flow)
  if (!byId.has(from) || !byId.has(to)) return false
  const nextEdges = (flow.edges || []).filter(edge => edge.kind === EDGE_KIND.NEXT)
  const seen = new Set([from])
  const queue = [from]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === to) return true
    for (const edge of nextEdges) {
      if (edge.from !== current || seen.has(edge.to)) continue
      if (!byId.has(edge.to)) continue
      seen.add(edge.to)
      queue.push(edge.to)
    }
  }
  return false
}

/** 在 next 边构成的有向图里找一条环（不含 reject 边）；有就返回节点 id 序列。 */
function findNextCycle(flow) {
  const byId = byIdMap(flow)
  const nextEdges = (flow.edges || []).filter(edge => edge.kind === EDGE_KIND.NEXT && byId.has(edge.to))
  const color = new Map()
  const trail = []
  const visit = nodeId => {
    const state = color.get(nodeId)
    if (state === 'gray') {
      const start = trail.indexOf(nodeId)
      return [...trail.slice(start >= 0 ? start : 0), nodeId]
    }
    if (state === 'black') return null
    color.set(nodeId, 'gray')
    trail.push(nodeId)
    for (const edge of nextEdges) {
      if (edge.from !== nodeId) continue
      const found = visit(edge.to)
      if (found) return found
    }
    trail.pop()
    color.set(nodeId, 'black')
    return null
  }
  for (const node of byId.values()) {
    if (color.get(node.id) === 'black') continue
    const found = visit(node.id)
    if (found) return found
  }
  return null
}

/**
 * 06 §13.5 v1.1 开跑前校验（引擎侧，独立于设计器的 `validateFlow`）：
 *   1. 恰好一个 start、至少一个 end、至少一个 stage；
 *   2. 每个非 end 节点恰好一条 next 出边（多出边直接 error，不取最左）；
 *   3. next 边目标必须存在；reject 目标必须存在且在上游；
 *   4. 所有阶段都必须能沿 next 到达 end；
 *   5. next 边成环 → error。
 * @returns {{ ok: boolean, errors: { message: string, nodeId?: string, edgeId?: string }[], warnings: [] }}
 */
export function validateFlowForRun(flow) {
  const errors = []
  const nodes = Array.isArray(flow && flow.nodes) ? flow.nodes : []
  const edges = Array.isArray(flow && flow.edges) ? flow.edges : []
  const byId = new Map(nodes.map(node => [node.id, node]))
  const starts = nodes.filter(node => node.kind === NODE_KIND.START)
  const ends = nodes.filter(node => node.kind === NODE_KIND.END)
  const stages = nodes.filter(node => node.kind === NODE_KIND.STAGE)

  if (starts.length !== 1) {
    errors.push({ message: `必须恰好有一个「开始」节点（当前 ${starts.length} 个）`, nodeId: starts[0] && starts[0].id })
  }
  if (ends.length === 0) errors.push({ message: '至少需要一个「结束」节点' })
  if (stages.length === 0) errors.push({ message: '流程没有阶段节点，无法执行' })

  // 节点 id 会进 run 目录与事件（reject/trigger 的 nodeId 要求 checkRunId），
  // 开跑前就要挡住 `../../escape` 这类路径穿越 / 非法字符。
  for (const node of nodes) {
    if (!checkRunId(node.id)) {
      errors.push({ message: `节点 id 不合法：「${node.id}」（只允许字母、数字、点、下划线、连字符，1–64 位）`, nodeId: node.id })
    }
  }

  if (starts.length === 1) {
    for (const node of nodes) {
      if (node.id === starts[0].id) continue
      if (!canReachViaNext(flow, starts[0].id, node.id)) {
        errors.push({ message: `「${node.title || node.id}」从开始节点沿 next 走不到，是孤立的断头路`, nodeId: node.id })
      }
    }
  }

  for (const node of nodes) {
    if (node.kind === NODE_KIND.END) continue
    const outs = edges.filter(edge => edge.from === node.id && edge.kind === EDGE_KIND.NEXT)
    if (outs.length !== 1) {
      errors.push({
        message: outs.length === 0
          ? `「${node.title || node.id}」没有 next 出边：是一条断头路`
          : `「${node.title || node.id}」有 ${outs.length} 条 next 出边：v1.1 要求恰好一条`,
        nodeId: node.id,
      })
    }
    for (const edge of outs) {
      if (!byId.has(edge.to)) {
        errors.push({ message: `next 边「${edge.id}」指向了不存在的节点 ${edge.to}`, edgeId: edge.id })
      }
    }
  }

  // 07 §6 / §7.1：外部 executor 的配置合法性必须在**开跑前**拦住。
  // 保存是宽松的（画布 600ms 防抖自动保存，半成品节点也要存得下），启动是严格的：
  // 一个 custom 却没填命令的节点跑起来只会在节点里失败，不如在 start 就 400。
  for (const node of nodes) {
    if (node.kind !== NODE_KIND.STAGE) continue
    const executor = node.executor || EXECUTOR.DSH
    if (!Object.values(EXECUTOR).includes(executor)) {
      errors.push({
        message: `「${node.title || node.id}」的 executor「${String(node.executor)}」不合法：只允许 dsh / codex / custom`,
        nodeId: node.id,
      })
      continue
    }
    if (executor === EXECUTOR.CUSTOM && !String(node.executorCommand || '').trim()) {
      errors.push({
        message: `「${node.title || node.id}」选择了自定义 executor，但没填 executorCommand：外部命令不知道该跑什么。`,
        nodeId: node.id,
      })
    }
    if (executor !== EXECUTOR.DSH && node.mode !== EXEC_MODE.SINGLE) {
      errors.push({
        message: `「${node.title || node.id}」使用外部 executor（${executor}）时，执行方式必须是「单个 agent」：team 模式需要引擎观察成员会话，外部进程做不到。`,
        nodeId: node.id,
      })
    }
  }

  for (const edge of edges) {
    if (edge.kind !== EDGE_KIND.REJECT) continue
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      errors.push({ message: `reject 边「${edge.id}」指向了不存在的节点`, edgeId: edge.id })
      continue
    }
    // 打回目标必须是阶段节点：start/end 不执行，回退到它们会让主循环停在非法节点。
    if (byId.get(edge.to).kind !== NODE_KIND.STAGE) {
      errors.push({
        message: `打回线「${byId.get(edge.from).title || edge.from} → ${byId.get(edge.to).title || edge.to}」的目标不是阶段节点`,
        edgeId: edge.id,
      })
      continue
    }
    // 上游 = 从目标沿 next 能到达打回方。
    if (!canReachViaNext(flow, edge.to, edge.from)) {
      errors.push({
        message: `打回线「${byId.get(edge.from).title || edge.from} → ${byId.get(edge.to).title || edge.to}」的目标不在上游，不构成回退`,
        edgeId: edge.id,
      })
    }
  }

  if (ends.length > 0) {
    for (const node of stages) {
      const reachesEnd = ends.some(end => node.id === end.id || canReachViaNext(flow, node.id, end.id))
      if (!reachesEnd) {
        errors.push({ message: `阶段「${node.title || node.id}」沿 next 到不了任何结束节点`, nodeId: node.id })
      }
    }
  }

  const cycle = findNextCycle(flow)
  if (cycle) {
    errors.push({ message: `next 边成环：${cycle.join(' → ')}` })
  }

  return { ok: errors.length === 0, errors, warnings: [] }
}

// ---------------------------------------------------------------------------
// 提示词（06 §6：七段骨架，8000 字上限，上游产物先截）
// ---------------------------------------------------------------------------

function section(title, body) {
  return `## ${title}\n${String(body ?? '').trim()}`
}

/**
 * 读上游产物正文，挂到 `upstream[].artifactContents`（宿主侧，06 §6）。
 *
 * **为什么不在 buildPrompt 里读盘**：buildPrompt 是导出的纯函数，单测直接构造
 * 上游对象就能验证提示词骨架与长度，不用编造文件系统；读盘失败也只影响「正文」
 * 这一层，摘要与路径行照旧下传，不能因为一个读不到的文件让整个 run 挂掉。
 * 因此由主循环在拼提示词前调用本函数，把结果作为 `artifactContents` 传入。
 *
 * 只认 `<nodeId>/artifacts/<attempt>/<文件名>` 这一层（attempt 来自 passed 记录）：
 * 打回重跑后同名文件在 `<attempt+1>` 目录里，历史 attempt 的内容不会被混进来。
 * 路径先过 `isSafeRelPath`，再用 resolve 复核必须落在 run 目录内。
 *
 * 读取失败 / 不存在 / 超过大小上限一律静默降级（该产物不提供正文，路径行保留）。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {object[]} upstream 主循环挑出的上游 passed 记录
 * @returns {Promise<object[]>} 新数组，每条附 `artifactContents: [{ path, content, truncated }]`
 */
export async function loadUpstreamArtifactContents(runsRoot, runId, upstream = []) {
  if (!Array.isArray(upstream) || upstream.length === 0) return []
  const out = upstream.map(entry => ({ ...entry, artifactContents: [] }))
  const runRootAbs = resolve(String(runsRoot), String(runId))
  let budget = UPSTREAM_ARTIFACT_TOTAL_CHARS
  let picked = 0
  // 从最近的上游节点往前取：每个节点最多 1 个产物、总共最多 2 个，
  // 这样拿到的是「上一棒」和「再上一棒」的核心产物，而不是同一节点的两份报告。
  for (let index = out.length - 1; index >= 0 && picked < UPSTREAM_ARTIFACT_MAX_FILES; index -= 1) {
    const entry = out[index]
    if (typeof entry.nodeId !== 'string' || !Number.isInteger(entry.attempt) || entry.attempt < 1) continue
    if (budget <= 0) break
    const prefix = `${entry.nodeId}/artifacts/${entry.attempt}/`
    const files = (Array.isArray(entry.artifactPaths) ? entry.artifactPaths : [])
      .filter(path => typeof path === 'string'
        && path.startsWith(prefix)
        && !path.slice(prefix.length).includes('/')
        && isSafeRelPath(path))
    // 优先取模型写的正文产物：evidence 报告与 summary.json 是引擎生成的索引，
    // 信息量低且摘要行已经带过，排到最后。
    const preference = path => {
      if (path.endsWith('/summary.json')) return 2
      if (/\/(?:checks-report|acceptance|test-report)\.json$/.test(path)) return 1
      return 0
    }
    files.sort((a, b) => preference(a) - preference(b))
    // 每个上游节点只取 1 个产物；若首选文件读不到 / 超限，按优先级继续试同节点的下一个，
    // 实在都不行就只留路径行（降级不等于整段失败）。
    for (const chosen of files) {
      if (budget <= 0) break
      const abs = resolve(runRootAbs, chosen)
      // resolve 复核：即使 isSafeRelPath 有疏漏，也不允许读到 run 目录之外。
      if (abs !== runRootAbs && !abs.startsWith(`${runRootAbs}${sep}`)) continue
      let text
      try {
        // 用 lstat 而不是 stat：产物目录是引擎自己写的普通文件，出现符号链接就当作不可读，
        // 避免有人用指向 run 目录外的软链把内容带进提示词。
        const info = await lstat(abs)
        if (!info.isFile() || info.size > UPSTREAM_ARTIFACT_READ_MAX_BYTES) continue
        text = await readFile(abs, 'utf8')
      } catch {
        // 文件不存在 / 权限问题 / 编码问题：降级为只给路径。
        continue
      }
      const limit = Math.min(UPSTREAM_ARTIFACT_MAX_CHARS, budget)
      const truncated = charLength(text) > limit
      const content = truncated ? clipChars(text, limit) : text
      const cost = charLength(content)
      if (cost === 0) continue
      entry.artifactContents.push({ path: chosen, content, truncated })
      budget -= cost
      picked += 1
      break
    }
  }
  return out
}

/** 上游产物正文在提示词里的缩进块（避免正文里的 Markdown 与骨架标题混淆）。 */
function indentBlock(text) {
  return String(text ?? '').split('\n').map(line => `    ${line}`).join('\n')
}

function upstreamText(upstream) {
  if (!Array.isArray(upstream) || upstream.length === 0) return '（无：这是链路上的第一个阶段节点。）'
  return upstream.map(entry => {
    const paths = Array.isArray(entry.artifactPaths) && entry.artifactPaths.length > 0
      ? entry.artifactPaths.join('、')
      : '（无产物文件）'
    let block = `- 「${entry.title}」（attempt ${entry.attempt}）：${entry.summary || '（无摘要）'}；产物：${paths}`
    // 06 §6：只给路径等于让下游猜；把最近产物的有界正文一并带上（宿主预读，纯函数不碰 fs）。
    const contents = Array.isArray(entry.artifactContents) ? entry.artifactContents : []
    for (const item of contents) {
      if (!item || typeof item.content !== 'string' || item.content.trim() === '') continue
      const note = item.truncated ? `（仅取前 ${charLength(item.content)} 字，已截断）` : ''
      block += `\n  产物内容「${item.path}」${note}：\n${indentBlock(item.content)}`
    }
    return block
  }).join('\n')
}

/** 未关闭 = 还没到 verified / dismissed（open / accepted / fixed 都算）。 */
function isOpenFinding(finding) {
  return finding && finding.status !== 'verified' && finding.status !== 'dismissed'
}

function findingLine(finding) {
  const id = typeof finding.id === 'string' && finding.id !== '' ? finding.id : '（无 id）'
  return `  - [${finding.severity || '?'}] ${id} ${finding.title || '（未命名问题）'}（${finding.status || 'unknown'}）`
}

function rejectText(previous, rejectContext) {
  const lines = []
  const seen = new Set()
  const openFromReject = Array.isArray(rejectContext && rejectContext.findings)
    ? rejectContext.findings.filter(isOpenFinding)
    : []
  if (rejectContext) {
    lines.push(`- 打回来源：「${rejectContext.fromTitle || rejectContext.fromNodeId}」（attempt ${rejectContext.fromAttempt}）`)
    lines.push(`- 打回原因：${rejectContext.reason || '（未提供）'}`)
    if (openFromReject.length > 0) {
      lines.push('- 打回方列出的未关闭问题（本轮必须**复用同一 id 更新 status**，不要新造 id）：')
      for (const finding of openFromReject.slice(0, 12)) {
        if (finding.id) seen.add(finding.id)
        lines.push(findingLine(finding))
      }
    }
    if (typeof rejectContext.rejectTarget === 'string' && rejectContext.rejectTarget !== '') {
      lines.push(`- 打回方指定的目标节点：${rejectContext.rejectTarget}`)
    }
  }
  const previousOpen = previous && Array.isArray(previous.findings)
    ? previous.findings.filter(finding => isOpenFinding(finding) && !seen.has(finding.id))
    : []
  if (previous) {
    lines.push(`- 你上一轮（attempt ${previous.attempt}）的判定：${previous.verdict}`)
    if (previous.summary) lines.push(`- 你上一轮的结论：${previous.summary}`)
    if (previousOpen.length > 0) {
      lines.push('- 你上一轮未关闭的问题（本轮必须**复用同一 id 更新 status**，不要新造 id）：')
      for (const finding of previousOpen.slice(0, 12)) lines.push(findingLine(finding))
    }
  }
  // 06 §13.7 B4：上一轮的证据标识必须随打回上下文下传，本轮全量重报。
  const evidence = (rejectContext && rejectContext.previousEvidence) || (previous && previous.evidence) || null
  if (evidence) {
    const acceptanceIds = Array.isArray(evidence.acceptance) ? evidence.acceptance : []
    const suites = Array.isArray(evidence.testsSuites) ? evidence.testsSuites : []
    const ruleSets = Array.isArray(evidence.ruleSetIds) ? evidence.ruleSetIds : []
    if (acceptanceIds.length > 0 || suites.length > 0 || ruleSets.length > 0) {
      lines.push('- 上一轮已报的证据标识（本轮必须**全量重报**；漏报的旧 fail 项会被聚合层判 unknown，不允许靠少报洗绿）：')
      if (acceptanceIds.length > 0) lines.push(`  - 验收条目 itemId：${acceptanceIds.slice(0, 50).join('、')}`)
      if (suites.length > 0) lines.push(`  - 测试套件 suite：${suites.slice(0, 20).join('、')}`)
      if (ruleSets.length > 0) lines.push(`  - 规范集 ruleSetId：${ruleSets.slice(0, 20).join('、')}`)
    }
  }
  return lines.join('\n')
}

function teamText(node) {
  if (node.mode !== EXEC_MODE.TEAM) return ''
  const members = Array.isArray(node.team) ? node.team : []
  if (members.length === 0) {
    return '\n## 团队分工\n本节点选择了「主管 + 子 agent」，但没有配置成员：你可以自行决定是否拆分子任务。'
  }
  const lines = members.map((member, index) => {
    const name = member.name || `成员${index + 1}`
    return `${index + 1}. ${name}：${member.role || '（未写角色）'}；任务：${member.task || '（未写任务）'}`
  })
  return [
    '',
    '## 团队分工',
    '你是主管，负责拆解、分发、汇总与最终判定；用子 agent 工具把下列分工分发出去，并收集成员结论。',
    ...lines,
  ].join('\n')
}

function outputFormatText() {
  return [
    // 07 §3.1：节点主管会话走 agents.create，没有 schema 驱动通道；统一要求 ```json
    // 代码块，引擎用 parseAssistantStructured 解析（纯 JSON / 夹带解释也能兼容）。
    '用一个 ```json 代码块返回唯一的 JSON 对象（代码块之外不要夹带解释），字段如下：',
    '{',
    '  "verdict": "pass | reject",',
    '  "summary": "一句话结论（≤400 字）",',
    '  "artifacts": [{ "name": "需求清单.md", "content": "…" }],',
    '  "findings": [{ "id": "F1", "severity": "P0|P1|P2", "title": "…", "status": "open|accepted|fixed|verified|dismissed" }],',
    '  "checks": { "ruleSetId": "…", "ruleSetVersion": "…", "executor": "…", "passedChecks": 12, "totalChecks": 12 },',
    '  "acceptance": [{ "itemId": "R1", "status": "pass|fail|skip|na", "decidedBy": "auto" }],',
    '  "tests": { "suite": "unit", "executed": 29, "passed": 29, "failed": 0, "skipped": 0 },',
    '  "rejectTarget": "上游节点 id（可选）",',
    '  "rejectReason": "打回原因（reject 时必填）"',
    '}',
    '硬性要求：`verdict` 必填；判定 reject 时必须写 `rejectReason`，并把需要返工的问题写进 findings。',
    '证据要求：验收 / 检查条目判 pass 时，evidenceRef 优先引用上游节点的产物（跨节点引用才算独立复核）；只引用本节点刚写的产物属于自证，单独不足以支撑通过结论。可以同时给多条证据；自己在产物里写「已通过」不算证据。',
  ].join('\n')
}

function charLength(text) {
  return Array.from(String(text ?? '')).length
}

/**
 * 拼提示词（导出的纯函数，便于单测长度与骨架）。
 *
 * 06 §6 / §13.9 m5：总长硬上限 8000 字；超出时**先截上游产物、再截任务**，
 * 「输出格式」段是硬保留段，任何情况下都不能被截掉。
 *
 * `upstream[].artifactContents` 由宿主侧 {@link loadUpstreamArtifactContents}
 * 预读（有界：单产物 1200 字、总 3000 字），本函数只做格式化与长度截断，不碰 fs；
 * 没有正文时只输出摘要 + 路径行，行为与旧版一致。
 *
 * @param {{
 *   node: object,
 *   attempt: number,
 *   upstream?: object[],
 *   previous?: object,
 *   rejectContext?: object,
 *   inboxText?: string,
 * }} input
 */
export function buildPrompt({
  node, attempt, upstream = [], previous = null, rejectContext = null, inboxText = '',
}) {
  const role = String(node.role || '').trim() || node.title || '（未命名角色）'
  let task = String(node.task || '').trim() || '（节点没有写任务说明）'
  const team = teamText(node)
  let outputs = String(node.outputs || '').trim() || '（未指定，按任务自行决定交付物）'
  const skills = Array.isArray(node.skills) ? node.skills.filter(name => typeof name === 'string' && name.trim() !== '') : []
  let skillsText = skills.length === 0
    ? '（本节点没有声明 skill，不需要调用 skill 工具。）'
    : skills.map(name => `- ${name}：动手前先调用 skill 工具加载它，再按它的要求执行。`).join('\n')
  let upstreamBody = upstreamText(upstream)

  const formatSection = section('输出格式', outputFormatText())
  const rejectBody = attempt > 1 || rejectContext || previous ? rejectText(previous, rejectContext) : ''
  // 06 §16：外部消息段（宿主侧已拼好并有界；空串时不占提示词预算）。
  let inboxBody = String(inboxText || '').trim()

  const assemble = () => {
    const sections = [
      section('你是谁', role),
      section('你负责什么', `${task}${team}`),
      section('期望产物', outputs),
      section('必须加载的 skill', skillsText),
      section('上游产物', upstreamBody),
    ]
    if (inboxBody !== '') sections.push(section('外部消息', inboxBody))
    if (rejectBody.trim() !== '') sections.push(section('打回上下文', rejectBody))
    sections.push(formatSection)
    return sections.join('\n\n')
  }

  let prompt = assemble()
  if (charLength(prompt) <= PROMPT_MAX_CHARS) return prompt

  // 1) 上游产物先截：算出其余段占用的固定开销。
  const overhead = charLength(prompt) - charLength(section('上游产物', upstreamBody))
  upstreamBody = clipChars(upstreamBody, Math.max(0, PROMPT_MAX_CHARS - overhead - 8))
  prompt = assemble()
  if (charLength(prompt) <= PROMPT_MAX_CHARS) return prompt

  // 2) 再截任务（团队分工跟着任务一起缩）：按超出的字数逐轮收紧，尽量少丢内容。
  for (let round = 0; round < 6; round += 1) {
    const length = charLength(assemble())
    if (length <= PROMPT_MAX_CHARS) return assemble()
    const excess = length - PROMPT_MAX_CHARS
    task = clipChars(task, Math.max(0, charLength(task) - excess - 4))
  }
  prompt = assemble()
  if (charLength(prompt) <= PROMPT_MAX_CHARS) return prompt

  // 3) 最后按顺序缩次要段；任何情况下保留「输出格式」整段。
  for (const shrink of [
    value => { outputs = value },
    value => { skillsText = value },
    value => { inboxBody = value },
    value => { task = value },
  ]) {
    shrink('…')
    prompt = assemble()
    if (charLength(prompt) <= PROMPT_MAX_CHARS) return prompt
  }

  const head = (() => {
    const sections = [
      section('你是谁', role),
      section('你负责什么', `${task}${team}`),
      section('期望产物', outputs),
      section('必须加载的 skill', skillsText),
      section('上游产物', upstreamBody),
    ]
    if (inboxBody !== '') sections.push(section('外部消息', inboxBody))
    if (rejectBody.trim() !== '') sections.push(section('打回上下文', rejectBody))
    return sections.join('\n\n')
  })()
  const room = Math.max(0, PROMPT_MAX_CHARS - charLength(formatSection) - 2)
  return room === 0 ? formatSection : `${clipChars(head, room)}\n\n${formatSection}`
}

// ---------------------------------------------------------------------------
// 内置桩执行器（FLOW_STUDIO_STUB_ENGINE=1；06 §12，仅测试台）
// ---------------------------------------------------------------------------

/**
 * 桩剧本：**只让「测试」节点首轮打回一次**，其余通过。
 *
 * 为什么只打一次：出厂模板里「测试打回」和「审查打回」都指向「开发」，若两个节点都打回，
 * 开发会在同一 run 里被重跑两次、直接撞上 maxRounds 上限，e2e 永远收不了口。
 * 桩的目的是验证「打回一次 → attempt=2 → 重跑通过」这条链，不是压测上限。
 */
export function stubShouldReject(node, attempt, flow) {
  if (attempt !== 1) return false
  const hasRejectEdge = (flow.edges || []).some(edge => edge.from === node.id && edge.kind === EDGE_KIND.REJECT)
  if (!hasRejectEdge) return false
  return /(^|[^审])测试|\btest\b/i.test(`${node.title || ''} ${node.id || ''}`)
}

/**
 * 桩的结构化产物：pass 带齐 acceptance/tests/checks/findings（quality 能算 pass），
 * reject 带打回原因与目标，首轮 finding 是 open、通过轮改成 verified。
 */
export function stubStructured(node, attempt, flow, now) {
  const reject = stubShouldReject(node, attempt, flow)
  const target = selectRejectTarget(flow, node)
  const base = {
    summary: reject
      ? `stub：第 ${attempt} 轮判定需要返工，打回上游。`
      : `stub：第 ${attempt} 轮通过，产物与证据已生成。`,
    artifacts: [{
      name: '结论.md',
      content: `# ${node.title}\n\n- 节点：${node.id}\n- attempt：${attempt}\n- 结论：${reject ? 'reject' : 'pass'}\n- 生成时间：${isoOf(now)}\n`,
    }],
    findings: [{
      id: `${node.id}-F1`,
      severity: reject ? 'P1' : 'P2',
      title: reject ? 'stub：需要返工的问题' : 'stub：已复验的小问题',
      status: reject ? 'open' : 'verified',
    }],
    checks: {
      ruleSetId: `stub:${node.id}`,
      ruleSetVersion: '1',
      executor: 'stub',
      passedChecks: 4,
      totalChecks: 4,
    },
    acceptance: [{ itemId: `${node.id}-R1`, status: reject ? 'fail' : 'pass', decidedBy: 'auto' }],
    tests: { suite: `unit:${node.id}`, executed: 3, passed: reject ? 2 : 3, failed: reject ? 1 : 0, skipped: 0 },
  }
  if (reject) {
    const out = {
      ...base,
      verdict: 'reject',
      rejectReason: 'stub：首轮按剧本要求打回，返工后复验。',
    }
    // 只有真的有 reject 边目标时才带 rejectTarget（JSON 里不出现 undefined）。
    if (target) out.rejectTarget = target.target.id
    return out
  }
  return { ...base, verdict: 'pass' }
}

// ---------------------------------------------------------------------------
// 结构化产物 → 05 事件
// ---------------------------------------------------------------------------

/** 证据命名空间（06 §13.7 B3）：`<nodeId>:<原始 id>`；缺省 ruleSetId 也带前缀。 */
function namespaceEvidenceId(nodeId, rawId, fallback) {
  const base = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : fallback
  return clip(`${nodeId}:${base}`, 128)
}

function normalizeFindings(input, nodeId) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (let index = 0; index < input.length && index < 50; index += 1) {
    const raw = input[index]
    if (!isPlainObject(raw)) throw new StructuredOutputError(`findings[${index}] 不是 JSON 对象`)
    // 06 §13.9 m6：非法 severity / status 是结构不合格，不再悄悄默认 P2 / open。
    if (!SEVERITIES.has(raw.severity)) {
      throw new StructuredOutputError(`findings[${index}].severity 非法（必须是 P0 / P1 / P2）`)
    }
    if (!FINDING_STATUSES.has(raw.status)) {
      throw new StructuredOutputError(`findings[${index}].status 非法（必须是 open / accepted / fixed / verified / dismissed）`)
    }
    const id = namespaceEvidenceId(nodeId, raw.id, `F${index + 1}`)
    if (seen.has(id)) {
      throw new StructuredOutputError(`findings 中 id 重复：${id}（同一份报告里同 id 只能有一条）`)
    }
    seen.add(id)
    const title = clip(typeof raw.title === 'string' ? raw.title.trim() : '', 512) || '（未命名问题）'
    const finding = { id, severity: raw.severity, title, status: raw.status }
    if (typeof raw.category === 'string' && raw.category.trim() !== '') finding.category = clip(raw.category.trim(), 64)
    out.push(finding)
  }
  return out
}

function normalizeTests(raw, nodeId) {
  if (raw === undefined || raw === null) return null
  if (!isPlainObject(raw)) throw new StructuredOutputError('tests 必须是 JSON 对象')
  const suite = typeof raw.suite === 'string' ? raw.suite.trim() : ''
  if (suite === '') throw new StructuredOutputError('tests.suite 必填')
  const count = key => {
    const value = raw[key]
    if (!Number.isInteger(value) || value < 0) {
      throw new StructuredOutputError(`tests.${key} 必须是非负整数`)
    }
    return value
  }
  const tests = {
    suite: namespaceEvidenceId(nodeId, suite, 'suite'),
    executed: count('executed'),
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
  }
  // 06 §13.9 m6：passed + failed + skipped 必须等于 executed。
  if (tests.passed + tests.failed + tests.skipped !== tests.executed) {
    throw new StructuredOutputError(
      `tests 计数不自洽：passed(${tests.passed}) + failed(${tests.failed}) + skipped(${tests.skipped}) !== executed(${tests.executed})`,
    )
  }
  // 06 §13.7 m7：模型给的 reportRef 只是候选，宿主在 _writeStructured 里对照
  // artifact/write 索引 + 文件 sha256 校验后才透传；这里不信任、不计算 self/peer。
  if (typeof raw.reportRef === 'string' && raw.reportRef.trim() !== '') {
    tests.reportRef = clip(raw.reportRef.trim(), 512)
  }
  if (Array.isArray(raw.failures)) {
    tests.failures = raw.failures
      .filter(item => typeof item === 'string' && item.trim() !== '')
      .slice(0, 50)
      .map(item => clip(item.trim(), 200))
  }
  return tests
}

function normalizeChecks(raw, nodeId) {
  if (!isPlainObject(raw)) return null
  // 06 §13.7：缺省 ruleSetId 也要带节点前缀，避免跨节点串味。
  const ruleSetId = namespaceEvidenceId(
    nodeId,
    typeof raw.ruleSetId === 'string' && raw.ruleSetId.trim() !== '' ? raw.ruleSetId.trim() : '',
    'engine-rules',
  )
  const ruleSetVersion = raw.ruleSetVersion === undefined || raw.ruleSetVersion === null
    ? '1'
    : clip(String(raw.ruleSetVersion), 128)
  const executor = typeof raw.executor === 'string' && raw.executor.trim() !== ''
    ? clip(raw.executor.trim(), 128)
    : 'engine'
  const passedChecks = Number.isInteger(raw.passedChecks) && raw.passedChecks >= 0 ? raw.passedChecks : undefined
  const totalChecks = Number.isInteger(raw.totalChecks) && raw.totalChecks >= 0 ? raw.totalChecks : undefined
  let state
  if (CHECK_STATES.has(raw.state)) state = raw.state
  else if (totalChecks !== undefined && totalChecks > 0 && passedChecks !== undefined) {
    state = passedChecks === totalChecks ? 'pass' : 'fail'
  } else state = 'skipped'
  const checks = { ruleSetId, ruleSetVersion, executor, state }
  if (passedChecks !== undefined && totalChecks !== undefined && passedChecks <= totalChecks) {
    checks.passedChecks = passedChecks
    checks.totalChecks = totalChecks
  }
  // 06 §13.7 m7：reportRef 候选（校验后再决定是否采用，见 _writeStructured）。
  if (typeof raw.reportRef === 'string' && raw.reportRef.trim() !== '') {
    checks.reportRef = clip(raw.reportRef.trim(), 512)
  }
  return checks
}

function normalizeAcceptance(input, nodeId, now) {
  if (!Array.isArray(input)) return []
  const items = []
  const seen = new Set()
  for (let index = 0; index < input.length && index < 200; index += 1) {
    const raw = input[index]
    if (!isPlainObject(raw)) throw new StructuredOutputError(`acceptance[${index}] 不是 JSON 对象`)
    if (typeof raw.itemId !== 'string' || raw.itemId.trim() === '') {
      throw new StructuredOutputError(`acceptance[${index}].itemId 必填`)
    }
    const itemId = namespaceEvidenceId(nodeId, raw.itemId, '')
    if (seen.has(itemId)) {
      throw new StructuredOutputError(`acceptance 中 itemId 重复：${itemId}`)
    }
    seen.add(itemId)
    if (!ACCEPTANCE_STATUSES.has(raw.status)) {
      throw new StructuredOutputError(`acceptance[${index}].status 非法（必须是 pass / fail / skip / na）`)
    }
    items.push({
      itemId,
      status: raw.status,
      decidedBy: DECIDED_BY.has(raw.decidedBy) ? raw.decidedBy : 'auto',
      // 06 §13.9 m6：decidedAt 用注入的 now，不用真实时钟（测试可确定）。
      decidedAt: isoOf(now instanceof Date ? now : new Date()),
      // 06 §13.7 m7：evidenceRef 候选（校验后再决定是否采用，见 _writeStructured）。
      ...(typeof raw.evidenceRef === 'string' && raw.evidenceRef.trim() !== ''
        ? { evidenceRef: clip(raw.evidenceRef.trim(), 512) }
        : {}),
    })
  }
  return items
}

function normalizeStructured(value) {
  let structured = value
  if (typeof structured === 'string') {
    try {
      structured = JSON.parse(structured)
    } catch {
      throw new StructuredOutputError('结构化输出不是合法 JSON')
    }
  }
  if (!isPlainObject(structured)) throw new StructuredOutputError('结构化输出不是 JSON 对象')
  if (!VERDICTS.has(structured.verdict)) {
    throw new StructuredOutputError('缺少 verdict（必须是 pass / reject）')
  }
  // 06 §13.10：「打回原因」缺失判结构不合格，不允许只写一个 reject 就回退。
  if (structured.verdict === 'reject'
    && (typeof structured.rejectReason !== 'string' || structured.rejectReason.trim() === '')) {
    throw new StructuredOutputError('判定 reject 时必须写 rejectReason')
  }
  return structured
}

/** 从 activate 的返回值里取结构化产物（兼容 output 文本里的 JSON）。 */
function extractStructured(raw) {
  if (!isPlainObject(raw)) return raw
  if (raw.structured !== undefined) return raw.structured
  if (raw.verdict !== undefined) return raw
  if (Array.isArray(raw.output)) {
    const text = raw.output
      .filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text !== '') {
      const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      try {
        return JSON.parse(unfenced)
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/**
 * 06 §16：从复用会话的 assistant 原文里解析结构化输出。
 * 兼容：纯 JSON / Markdown 代码块包裹 / JSON 前后夹带解释文字。
 * @returns {object | null}
 */
export function parseAssistantStructured(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const text = raw.trim()
  const candidates = [text]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced) candidates.push(fenced[1].trim())
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (isPlainObject(parsed)) return parsed
    } catch {
      // 换下一个候选。
    }
  }
  return null
}

/** 把宿主的 TokenUsage 映射成 05 §3 的四桶；reasoning 仅在 ≤ output 时带上。 */
export function mapHostUsage(usage) {
  if (!isPlainObject(usage)) return null
  // 既接受宿主 TokenUsage（inputTokens/...），也接受已经映射好的 05 四桶。
  const alreadyMapped = 'input' in usage || 'cacheRead' in usage || 'cacheWrite' in usage || 'output' in usage
  const input = alreadyMapped ? intOr(usage.input) : intOr(usage.inputTokens)
  const output = alreadyMapped ? intOr(usage.output) : intOr(usage.outputTokens)
  const mapped = {
    input,
    cacheRead: alreadyMapped ? intOr(usage.cacheRead) : intOr(usage.cacheReadTokens),
    cacheWrite: alreadyMapped ? intOr(usage.cacheWrite) : intOr(usage.cacheWriteTokens),
    output,
  }
  const reasoning = alreadyMapped ? usage.reasoning : usage.reasoningTokens
  if (Number.isInteger(reasoning) && reasoning >= 0 && reasoning <= output) mapped.reasoning = reasoning
  return mapped
}

function safeArtifactName(raw, index = 0) {
  let name = typeof raw === 'string' ? raw.trim() : ''
  name = name.split(/[\\/]/).pop() || ''
  name = name.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim()
  name = name.replace(/^\.+/, '')
  if (name === '') name = `artifact-${index + 1}`
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) name += '.md'
  if (name.length > 120) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot) : ''
    name = `${name.slice(0, Math.max(1, 120 - ext.length))}${ext}`
  }
  return name
}

function artifactKind(name) {
  const ext = name.toLowerCase().split('.').pop()
  if (ext === 'md' || ext === 'markdown') return 'md'
  if (ext === 'diff' || ext === 'patch') return 'diff'
  if (ext === 'json') return 'json'
  return 'log'
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * 07 §5（R3）：**没有**模块级开始锁 / 并发上限 / 排队。
 * 一个 Engine 实例只服务一个 run；跨 run 的并发由 `src/runtime.js` 的 `runs` 注册表
 * 管理，同一 runId 二次 start 才 409。这里只保留实例级占位（`this.active`），
 * 防止同一个实例被误用来同时跑两个 run。
 */

/** 一探到底：宿主 runlog 是否已支持 member/end.status='partial'（并行任务可能尚未落地）。 */
let partialMemberStatusSupported = null
function supportsPartialMemberStatus() {
  if (partialMemberStatusSupported !== null) return partialMemberStatusSupported
  try {
    const probe = normalizeEvent({
      v: 1,
      kind: 'member/end',
      memberId: 'n_probe:1',
      nodeId: 'n_probe',
      attemptId: 1,
      data: { status: 'partial', durationMs: 0 },
    }, { runId: 'r_probe', now: new Date(0) })
    partialMemberStatusSupported = probe.ok === true
  } catch {
    partialMemberStatusSupported = false
  }
  return partialMemberStatusSupported
}

/**
 * 创建执行引擎。
 *
 * @param {{
 *   activate?: Function, now?: () => Date, readUsage?: Function, log?: Function,
 *   ctx?: any, runsRoot?: string, flowsRoot?: string, readFlow?: Function,
 *   nodeTimeoutMs?: number, nodeRetries?: number, staleMs?: number, stub?: boolean,
 *   runTimeoutMs?: number, maxTotalSteps?: number, maxArtifactBytes?: number,
 *   maxRunArtifactBytes?: number, parent?: object, resolveParent?: Function,
 *   cwd?: string, agentPreset?: string, sessionIndex?: Map, startedBy?: Map,
 *   onSettled?: (runId: string) => void,
 * }} [options]
 */
export function createEngine(options = {}) {
  return new FlowEngine(options)
}

class FlowEngine {
  constructor(options = {}) {
    this.ctx = options.ctx || null
    this.now = typeof options.now === 'function' ? options.now : () => new Date()
    this.readUsage = typeof options.readUsage === 'function' ? options.readUsage : null
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.runsRoot = typeof options.runsRoot === 'string' && options.runsRoot !== '' ? options.runsRoot : runsDir()
    this.flowsRoot = typeof options.flowsRoot === 'string' && options.flowsRoot !== '' ? options.flowsRoot : flowsDir()
    this.readFlowFn = typeof options.readFlow === 'function'
      ? options.readFlow
      : flowId => readFlow(this.flowsRoot, flowId)
    this.nodeTimeoutMs = Number.isInteger(options.nodeTimeoutMs) && options.nodeTimeoutMs > 0
      ? options.nodeTimeoutMs
      : envInt('FLOW_STUDIO_NODE_TIMEOUT_MS', DEFAULT_NODE_TIMEOUT_MS)
    // 06 §9：节点失败先重试（默认 1 次）；FLOW_STUDIO_NODE_RETRIES 覆盖并钳制在 0–5。
    this.nodeRetries = Number.isInteger(options.nodeRetries) && options.nodeRetries >= 0
      ? Math.min(options.nodeRetries, MAX_NODE_RETRIES)
      : envIntClamped('FLOW_STUDIO_NODE_RETRIES', DEFAULT_NODE_RETRIES, 0, MAX_NODE_RETRIES)
    // 06 §13.5：run 级墙钟上限（默认 2 小时）与步数上限（阶段数 × 3）。
    this.runTimeoutMs = Number.isInteger(options.runTimeoutMs) && options.runTimeoutMs > 0
      ? options.runTimeoutMs
      : envInt('FLOW_STUDIO_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS)
    this.maxTotalSteps = Number.isInteger(options.maxTotalSteps) && options.maxTotalSteps > 0
      ? options.maxTotalSteps
      : null
    this.configuredMaxTotalSteps = this.maxTotalSteps
    // 06 §13.9：单产物 1 MiB / 单 run 64 MiB（测试可注入更小值）。
    this.maxArtifactBytes = Number.isInteger(options.maxArtifactBytes) && options.maxArtifactBytes >= 0
      ? options.maxArtifactBytes
      : MAX_ARTIFACT_BYTES
    this.maxRunArtifactBytes = Number.isInteger(options.maxRunArtifactBytes) && options.maxRunArtifactBytes >= 0
      ? options.maxRunArtifactBytes
      : MAX_RUN_ARTIFACT_BYTES
    this.staleMs = Number.isInteger(options.staleMs) && options.staleMs > 0
      ? options.staleMs
      : DEFAULT_STALE_MS
    this.stub = options.stub === undefined
      ? process.env.FLOW_STUDIO_STUB_ENGINE === '1'
      : options.stub === true
    this.engineName = this.stub ? 'stub' : 'real'
    this.parent = options.parent || null
    this.resolveParentFn = typeof options.resolveParent === 'function' ? options.resolveParent : null
    // 07 §3.1：节点主管会话的 cwd / preset（可注入；没有就交给宿主默认）。
    this.cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : null
    this.agentPreset = typeof options.agentPreset === 'string' && options.agentPreset !== ''
      ? options.agentPreset
      : null
    // 07 §5：由 runtime 创建时，run 收尾回调 runtime 把实例从注册表摘掉（不轮询）。
    this.onSettled = typeof options.onSettled === 'function' ? options.onSettled : null
    // 06 §15：per-start 父会话覆盖（模型工具 flow_start 传当前会话的 Agent）。
    // 只活在一次 run 的生命周期内，_cleanupActive() 清掉，避免影响下一次 start。
    // R2 起默认路径不再把它传给 agents.create（那是领养关系，不是所有权）。
    this.startParent = null
    // 07 §4：per-start 的 cwd / preset（只活一次 run）。
    this.startCwd = null
    this.startAgentPreset = null
    // 07 §4：构造时注入的 worktree 默认策略（start(options.worktree) 可覆盖）。
    // 校验交给 decideWorktree（非法值在 start 时按 400 报错），这里只记原值。
    this.defaultWorktreePolicy = typeof options.worktree === 'string' && options.worktree !== ''
      ? options.worktree
      : 'auto'
    // 07 §4：本次 run 的工作区 / worktree 决策结果（start 时算一次，run 内只读）。
    this.workspaceRecord = null
    this.worktreeRecord = null
    // 07 §3「降级必须可见」：默认会话路径的实际形态（top-level / legacy-subagent / …）。
    this.sessionMode = null

    this.activateInjected = !this.stub && typeof options.activate === 'function'
    if (this.stub) this.activate = null
    else if (this.activateInjected) this.activate = options.activate
    else this.activate = this._defaultActivate.bind(this)

    this.active = null
    this.live = null
    this.current = null
    this.attempts = new Map()
    this.lastResults = new Map()
    this.rejectContexts = new Map()
    this.passedNodes = []
    this.round = 0
    this.artifactBytes = 0
    this.runTimedOut = false
    this.failedNode = null
    this.sessionBindings = new Map()
    this.pendingSessionEvents = []
    this.pendingSessionLimit = 4000
    this.pendingToolCalls = new Map()
    // §8.2：sessionId → 上一条 agent/message 文本 hash（去重 / 心跳），上限 64。
    this.lastAssistantText = new Map()
    // §13.12：traceId+callId → 最近一次 usage，用于 live.tokens 的「后到整条替换」。
    this.liveUsage = new Map()
    // 06 §13.7：本 run 已落盘的产物索引（path → { nodeId, attemptId, sha256 }），
    // 校验模型给的 evidenceRef / reportRef 是否真的对应一条 artifact/write。
    this.artifactIndex = new Map()
    // 06 §16 / 07 §3.3：节点会话复用。
    //   nodeSessions     nodeId → { sessionId, handle, agent, createdAt, lastUsedAt, attempt }（本次 run 内）
    //   disposalHandles  本次 run 里所有会话句柄（只有 dispose，run 结束/停止时统一释放）
    //   sessionIndex     跨 run 共享的 sessionId → { runId, nodeId, firstAttempt, lastAttempt, createdAt }
    //                    （flow_reply / flow_send_message 反查；由 runtime 注入，单用 Engine 时实例内兜底）
    //   lastAssistantBySession  sessionId → 最近一条 assistant 原文（复用会话时解析结构化输出）
    //   startupMessages  run.json.input.messages（启动前投递进来的消息）
    this.sessionIndex = options.sessionIndex instanceof Map ? options.sessionIndex : new Map()
    // 07 §5：跨 run 共享「哪个会话启动过哪个 run」的索引（runtime 注入；单用 Engine 时实例内兜底）。
    this.startedBy = options.startedBy instanceof Map ? options.startedBy : new Map()
    this.lastStartedRunId = null
    this.eventQueue = Promise.resolve()
    this._resetInboxState()

    if (this.ctx && typeof this.ctx.on === 'function') {
      this.unsubscribe = this.ctx.on(
        'session/event',
        (session, event) => this.handleSessionEvent(session, event),
        { global: true },
      )
    }
  }

  /** 供 /health 使用：'stub' / 'real'。 */
  get name() {
    return this.engineName
  }

  // -- 默认 activate：agents.create（顶层会话）；subagents 只留给兼容路径 -----

  _subagentService() {
    if (!this.ctx || typeof this.ctx.get !== 'function') return undefined
    return this.ctx.get('subagents')
  }

  // -- 06 §16：节点会话复用 / 收件箱 ---------------------------------------

  /** agents 服务（可选依赖；拿不到就退化为「每次新会话」）。 */
  _agentsService() {
    if (!this.ctx) return undefined
    try {
      if (typeof this.ctx.get === 'function') {
        const service = this.ctx.get('agents')
        if (service) return service
      }
      return this.ctx.agents
    } catch {
      return undefined
    }
  }

  /**
   * 具备 create / get / resume 之一就算可用的 agents 服务（测试台里可能只注入 roots）。
   * 07 §3.1：新建节点主管会话靠 `agents.create`；get / resume 只用于复用已有会话。
   */
  _agentsUsable() {
    const agents = this._agentsService()
    return Boolean(agents && (
      typeof agents.create === 'function'
      || typeof agents.get === 'function'
      || typeof agents.resume === 'function'
    ))
  }

  _agentSessionId(agent) {
    const sessionId = agent && agent.session && agent.session.id
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
  }

  /** run.json.input.messages → 本次 run 的启动消息（有界）。 */
  _startupMessagesOf(meta) {
    const list = meta && meta.input && Array.isArray(meta.input.messages) ? meta.input.messages : []
    return list.slice(0, 20)
      .filter(item => item && typeof item.id === 'string' && item.id !== '')
      .map(item => ({
        id: item.id,
        from: typeof item.from === 'string' && item.from !== '' ? item.from : 'unknown',
        text: typeof item.text === 'string' ? item.text : '',
        at: typeof item.at === 'string' ? item.at : isoOf(this.now()),
        ...(typeof item.targetNodeId === 'string' ? { targetNodeId: item.targetNodeId } : {}),
      }))
  }

  /** 入口阶段节点：开始节点沿 next 走到的第一个 stage（找不到返回 null）。 */
  _firstStageId(flow) {
    let node = null
    try {
      node = selectFirstNode(flow)
    } catch {
      return null
    }
    const seen = new Set()
    while (node && !seen.has(node.id)) {
      seen.add(node.id)
      if (node.kind === NODE_KIND.STAGE) return node.id
      if (node.kind === NODE_KIND.END) return null
      node = selectNextNode(flow, node)
    }
    return null
  }

  /** 启动时加载 sessions.json（存在就复用；坏文件按空表处理）。 */
  async _loadNodeSessions(runId) {
    if (typeof runstoreModule.readNodeSessions !== 'function') return
    try {
      const sessions = await runstoreModule.readNodeSessions(this.runsRoot, runId)
      for (const [nodeId, entry] of Object.entries(sessions || {})) {
        if (!entry || typeof entry.sessionId !== 'string') continue
        this.nodeSessions.set(nodeId, {
          sessionId: entry.sessionId,
          handle: null,
          agent: null,
          createdAt: entry.createdAt,
          lastUsedAt: entry.lastUsedAt,
          attempt: null,
        })
        this._rememberSessionOwner(entry.sessionId, runId, nodeId)
      }
    } catch (error) {
      this.log('warn', `flow-studio: 读 sessions.json 失败（${runId}）：${error.message}`)
    }
  }

  _sessionsSnapshot() {
    const out = {}
    for (const [nodeId, entry] of this.nodeSessions) {
      if (!entry || typeof entry.sessionId !== 'string') continue
      out[nodeId] = {
        sessionId: entry.sessionId,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
      }
    }
    return out
  }

  /** 原子落 sessions.json；失败只告警（会话复用退化为本次进程内有效）。 */
  async _persistNodeSessions(runId) {
    if (typeof runstoreModule.writeNodeSessions !== 'function') return
    try {
      await runstoreModule.writeNodeSessions(this.runsRoot, runId, this._sessionsSnapshot())
    } catch (error) {
      this.log('warn', `flow-studio: 写 sessions.json 失败（${runId}）：${error.message}`)
    }
  }

  /**
   * 记录一个节点会话：`{ sessionId, handle, agent, createdAt, lastUsedAt, attempt }`。
   * 07 §3.3：句柄与 `handle.agent` 分开存 —— 释放只对 handle，会话本身不删。
   */
  _recordNodeSession(runId, nodeId, sessionId, {
    handle = null, agent = null, createdAt = null, attempt = null,
  } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const nowIso = isoOf(this.now())
    const previous = this.nodeSessions.get(nodeId)
    const sameSession = Boolean(previous && previous.sessionId === sessionId)
    const keepHandle = sameSession ? previous.handle || null : null
    const keepAgent = sameSession ? previous.agent || null : null
    this.nodeSessions.set(nodeId, {
      sessionId,
      handle: handle || keepHandle,
      agent: agent || keepAgent,
      createdAt: createdAt
        || (sameSession ? previous.createdAt : null)
        || nowIso,
      lastUsedAt: nowIso,
      attempt: Number.isInteger(attempt) ? attempt : (sameSession ? previous.attempt ?? null : null),
    })
    this._rememberSessionOwner(sessionId, runId, nodeId, attempt)
    if (handle && typeof handle.dispose === 'function') this.disposalHandles.add(handle)
  }

  /**
   * 跨 run 共享的 sessionId → { runId, nodeId, firstAttempt, lastAttempt, createdAt }（LRU 500）。
   * `firstAttempt` 只在第一次登记时写入，后续只推进 `lastAttempt`。
   */
  _rememberSessionOwner(sessionId, runId, nodeId, attempt = null) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const previous = this.sessionIndex.get(sessionId)
    if (previous) this.sessionIndex.delete(sessionId)
    else if (this.sessionIndex.size >= 500) {
      const oldest = this.sessionIndex.keys().next().value
      if (oldest !== undefined) this.sessionIndex.delete(oldest)
    }
    const attemptValue = Number.isInteger(attempt) ? attempt : null
    const firstAttempt = previous && Number.isInteger(previous.firstAttempt)
      ? previous.firstAttempt
      : attemptValue
    const lastAttempt = attemptValue !== null
      ? attemptValue
      : (previous && Number.isInteger(previous.lastAttempt) ? previous.lastAttempt : null)
    this.sessionIndex.set(sessionId, {
      runId,
      nodeId,
      firstAttempt,
      lastAttempt,
      createdAt: (previous && typeof previous.createdAt === 'string' && previous.createdAt !== '')
        ? previous.createdAt
        : isoOf(this.now()),
    })
  }

  /** 某 run / 节点是否已有会话（路由与工具共用；同步读内存）。 */
  sessionIdForNode(runId, nodeId) {
    if (this.active && this.active.runId === runId) {
      const entry = this.nodeSessions.get(nodeId)
      if (entry && typeof entry.sessionId === 'string') return entry.sessionId
    }
    for (const [sessionId, owner] of this.sessionIndex) {
      if (owner.runId === runId && owner.nodeId === nodeId) return sessionId
    }
    return null
  }

  /** flow_send_message：省略 runId 时取「当前会话启动的最新 run」。 */
  runForSession(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') {
      const started = this.startedBy.get(sessionId)
      if (started) return started
      const owner = this.sessionIndex.get(sessionId)
      if (owner && typeof owner.runId === 'string') return owner.runId
      if (this.active && this.active.runId) return this.active.runId
    }
    return this.latestRunId()
  }

  latestRunId() {
    if (this.active && typeof this.active.runId === 'string') return this.active.runId
    return this.lastStartedRunId || null
  }

  /**
   * flow_reply：sessionId 反查 run / 节点。
   * 内存索引优先；查不到再扫最近 20 个 run 的 sessions.json 兜底。
   * @returns {Promise<{ runId: string, nodeId: string } | null>}
   */
  async resolveSessionOwner(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const hit = this.sessionIndex.get(sessionId)
    if (hit) return hit
    if (typeof runstoreModule.listRuns !== 'function' || typeof runstoreModule.readNodeSessions !== 'function') {
      return null
    }
    try {
      const listed = await runstoreModule.listRuns(this.runsRoot, { limit: 20 })
      for (const run of listed.runs || []) {
        const sessions = await runstoreModule.readNodeSessions(this.runsRoot, run.id)
        for (const [nodeId, entry] of Object.entries(sessions || {})) {
          if (entry && entry.sessionId === sessionId) {
            this._rememberSessionOwner(sessionId, run.id, nodeId)
            return { runId: run.id, nodeId }
          }
        }
      }
    } catch (error) {
      this.log('warn', `flow-studio: 反查会话归属失败：${error.message}`)
    }
    return null
  }

  /** 冷会话 resume 时给一个可用的默认模型（取不到就用宿主默认）。 */
  _defaultAgentSelection() {
    try {
      const service = this.ctx && typeof this.ctx.get === 'function'
        ? this.ctx.get('agentDefaultModel')
        : null
      const selection = service && typeof service.currentSelection === 'function'
        ? service.currentSelection()
        : null
      if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined
      if (selection.provider === '' || selection.model === '') return undefined
      return {
        provider: selection.provider,
        model: selection.model,
        ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      }
    } catch {
      return undefined
    }
  }

  /**
   * 向一个节点会话投一轮提示词，然后从该会话最后一条 assistant 消息里解析结构化输出。
   *
   * 07 §3.1：新建（agents.create）与复用（followup）是**同一段协议**——都靠
   * `buildFollowupPayload` 投递、`whenIdle()` 等空闲、`parseAssistantStructured`
   * 解析。解析失败抛 StructuredOutputError（走既有「结构化输出不合格」失败路径）。
   */
  async _promptNodeSession({ agent, sessionId, prompt, runId, node, attempt, traceId, signal }) {
    // 清掉上一条 assistant 文本，避免把上一轮的结果误当成本轮输出。
    this.lastAssistantBySession.delete(sessionId)
    // 同一会话被二次激活：把事件绑定改挂到新的 attemptId / traceId 上。
    this.bindSession(sessionId, { nodeId: node.id, attemptId: attempt, memberId: null, traceId }, { rebind: true })
    agent.followup(buildFollowupPayload({
      text: prompt,
      runId,
      nodeId: node.id,
      from: 'flow-studio',
    }))
    if (typeof agent.whenIdle === 'function') {
      const idle = agent.whenIdle()
      if (idle && typeof idle.then === 'function') await raceAbort(idle, signal)
    }
    // 让 whenIdle 之后到达的 session/event 先落到订阅处理器（assistant 原文）。
    await new Promise(resolve => setTimeout(resolve, 0))
    const raw = this.lastAssistantBySession.get(sessionId)
    const structured = parseAssistantStructured(raw)
    if (!structured) {
      throw new StructuredOutputError(
        `会话 ${sessionId} 的最近一条 assistant 消息里没有可解析的 JSON（需要与输出格式相同的结构）`,
      )
    }
    return structured
  }

  /**
   * 复用已有节点会话（sessions.json / 本 run 内已登记）：活会话直接 followup，
   * 冷会话或已被压缩的会话先 resume。
   */
  async _followupNodeSession({ runId, node, attempt, prompt, combined, traceId, entry }) {
    const agents = this._agentsService()
    const sessionId = entry.sessionId
    let agent = null
    let mode = 'injected'
    try {
      if (typeof agents.get === 'function') agent = agents.get(sessionId) || null
    } catch {
      agent = null
    }
    if (!agent) {
      if (typeof agents.resume !== 'function') {
        throw new EngineError(503, `节点「${node.id}」的会话已不可用，且 agents.resume 不可用`)
      }
      const resumeOptions = { resumeSessionId: sessionId }
      const selection = this._defaultAgentSelection()
      if (selection) resumeOptions.agentOptions = selection
      const resumed = await raceAbort(agents.resume(resumeOptions), combined)
      agent = resumed && resumed.agent ? resumed.agent : null
      mode = 'resumed'
    }
    if (!agent || typeof agent.followup !== 'function') {
      throw new EngineError(503, `节点「${node.id}」的会话 ${sessionId} 无法接收消息（没有 followup）`)
    }
    const structured = await this._promptNodeSession({
      agent, sessionId, prompt, runId, node, attempt, traceId, signal: combined,
    })
    return { structured, sessionId, mode, agent }
  }

  /**
   * run 收尾统一释放会话：用 Set 去重，单个失败只告警。
   * 中途节点失败不提前 dispose（节点可能还要被二次激活）。
   */
  async _disposeRunSessions(runId) {
    const handles = [...this.disposalHandles]
    this.disposalHandles.clear()
    this.nodeSessions.clear()
    for (const handle of handles) {
      if (!handle || typeof handle.dispose !== 'function') continue
      try {
        await handle.dispose()
      } catch (error) {
        this.log('warn', `flow-studio: dispose 会话失败（${runId}）：${error.message}`)
      }
    }
  }

  /**
   * 节点主管会话 / 外部 executor 的工作目录（07 §4.1）。
   *
   * worktree 开着就用 `worktree.path`（真正隔离的那份），否则用 `workspace.path`；
   * 两者都还没算出来（例如非 start 入口的兼容用法）时退回旧语义：
   * per-start 覆盖 > 引擎配置 > 发起会话 header.cwd > 不传（交给宿主默认）。
   */
  _sessionCwd() {
    if (this.worktreeRecord && this.worktreeRecord.enabled === true
      && typeof this.worktreeRecord.path === 'string' && this.worktreeRecord.path !== '') {
      return this.worktreeRecord.path
    }
    if (this.workspaceRecord && typeof this.workspaceRecord.path === 'string'
      && this.workspaceRecord.path !== '') {
      return this.workspaceRecord.path
    }
    if (typeof this.startCwd === 'string' && this.startCwd !== '') return this.startCwd
    if (typeof this.cwd === 'string' && this.cwd !== '') return this.cwd
    const parent = this.startParent || this.parent
    const header = parent && parent.session && parent.session.header
    return header && typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined
  }

  /**
   * 07 §3「降级必须可见」：本次 run 的默认会话路径形态。
   *
   * - `top-level`：正常路径（`agents.create` 可用，节点主管会话是顶层会话）；
   * - `legacy-subagent`：兼容路径（没有 agents.create，只有 subagents.startActivation）；
   * - `injected`：宿主/测试注入了 activate（会话形态由注入方负责，引擎不做承诺）；
   * - `stub`：内置桩引擎（不建会话）；
   * - `unavailable`：既没有 agents.create、也没有 subagents，默认 activate 会在节点处 503。
   *
   * 注意：判「是否顶层会话」要看 session header 的 `parentSession` / `origin`，
   * 不能看 `ctx.agents.roots()`——resume 之后 agent 在运行时是 root，但持久化血缘不变。
   */
  _resolveSessionMode() {
    if (this.stub) return 'stub'
    if (this.activateInjected) return 'injected'
    const agents = this._agentsService()
    if (agents && typeof agents.create === 'function') return 'top-level'
    const subagents = this._subagentService()
    if (subagents && typeof subagents.startActivation === 'function') return 'legacy-subagent'
    return 'unavailable'
  }

  /**
   * 07 §4：本次 start 的工作区路径候选（优先级由高到低）：
   * `options.workspace`（也接受已解析对象）→ `options.cwd` →
   * 构造时注入的 `cwd` / per-start `startCwd` → 发起会话 header.cwd → process.cwd()。
   *
   * `strict` 只对显式 options 生效：显式给的路径不存在 → 400；从引擎/会话上下文
   * 兜底来的路径（例如宿主会话的 cwd 已被删）按「非 git 工作区」继续，不拖死启动。
   */
  _workspaceRequestOf(options, parentOverride) {
    const opts = options && typeof options === 'object' ? options : {}
    const text = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
    const explicit = opts.workspace
    if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
      const rawPath = text(explicit.path) || text(explicit.realpath)
      if (rawPath) {
        return {
          source: 'options.workspace',
          strict: true,
          preset: {
            path: rawPath,
            realpath: text(explicit.realpath) || rawPath,
            isGit: explicit.isGit === true,
            gitRoot: text(explicit.gitRoot),
            id: text(explicit.id),
          },
        }
      }
    }
    const explicitWorkspace = text(explicit)
    if (explicitWorkspace) return { source: 'options.workspace', strict: true, path: explicitWorkspace }

    const startCwd = text(opts.cwd)
    if (startCwd) return { source: 'options.cwd', strict: true, path: startCwd }

    const engineCwd = text(this.startCwd) || text(this.cwd)
    if (engineCwd) return { source: 'engine.cwd', strict: false, path: engineCwd }

    const parent = parentOverride || this.parent
    const header = parent && parent.session && parent.session.header
    const headerCwd = header ? text(header.cwd) : null
    if (headerCwd) return { source: 'initiator-session', strict: false, path: headerCwd }

    return { source: 'process.cwd', strict: false, path: process.cwd() }
  }

  /** worktrees 根目录：`runsRoot` 的父级 + `worktrees`（`<home>/flow-studio/worktrees`）。 */
  _worktreesRoot() {
    return join(dirname(this.runsRoot), 'worktrees')
  }

  /**
   * 把 start 时算出的工作区 / worktree / sessionMode 写进 run.json。
   *
   * 为什么不走 `writeRunMeta`：runstore 的 `normalizeMeta` 只保留白名单字段，会把
   * `workspace` / `worktree` / `sessionMode` 当未知字段丢掉（runstore.js 不在本次
   * 改动范围内）。这里按「读原文 → 合并 → 临时文件 + rename」原子写，写完仍能被
   * 普通 JSON 读取方看到；`readRunMeta()` 是否透传要由 runstore 侧决定（已交接）。
   * 每次 run.json 被 writeRunMeta 重写后（live 刷新）都要补一次，失败只告警。
   */
  async _patchRunBinding(runId) {
    if (typeof runId !== 'string' || runId === '') return
    if (!this.workspaceRecord && !this.sessionMode) return
    const file = join(this.runsRoot, runId, 'run.json')
    let raw
    try {
      raw = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    // 已经一致就不写：live 每次刷新都补一次，但正常 run 里只有第一次真的落盘。
    const sameWorkspace = !this.workspaceRecord || (raw.workspace
      && raw.workspace.id === this.workspaceRecord.id
      && raw.workspace.path === this.workspaceRecord.path)
    const sameWorktree = !this.worktreeRecord || (raw.worktree
      && raw.worktree.enabled === this.worktreeRecord.enabled
      && raw.worktree.path === this.worktreeRecord.path
      && raw.worktree.reason === this.worktreeRecord.reason
      && raw.worktree.baseCommit === this.worktreeRecord.baseCommit)
    const sameMode = !this.sessionMode || raw.sessionMode === this.sessionMode
    if (sameWorkspace && sameWorktree && sameMode) return
    const next = { ...raw }
    if (this.workspaceRecord) next.workspace = this.workspaceRecord
    if (this.worktreeRecord) next.worktree = this.worktreeRecord
    if (this.sessionMode) next.sessionMode = this.sessionMode
    const tmp = `${file}.tmp-binding-${process.pid}-${patchCounter++}`
    try {
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, file)
      await chmod(file, 0o600).catch(() => {})
    } catch (error) {
      await unlink(tmp).catch(() => {})
      this.log('warn', `flow-studio: 写 run.json 工作区绑定失败（${runId}）：${error.message}`)
    }
  }

  /**
   * 07 §4（R1+R4）第一步：解析工作区 + 校验「启动开始后不许换工作区」。
   *
   * 错误语义：
   *   - 显式 workspace / cwd 不可用 → 400；
   *   - git 不可用（GIT_UNAVAILABLE）→ 按「不是 git 仓库」处理并记录原因，不拖死启动；
   *   - run.json 已有 workspace.id 且与本次不同 → 400（「该 run 已绑定工作区，不能中途更换」）。
   *
   * 只做解析与绑定校验，不建 worktree——已结束/已开始的 run 不该在二次 start 时白建一份。
   */
  async _resolveWorkspaceBinding(runId, options, parentOverride) {
    const request = this._workspaceRequestOf(options, parentOverride)
    const warnings = []
    let workspace = null

    if (request.preset) {
      const absolute = isAbsolute(request.preset.path) ? resolve(request.preset.path) : resolve(process.cwd(), request.preset.path)
      const realpath = isAbsolute(request.preset.realpath)
        ? resolve(request.preset.realpath)
        : resolve(process.cwd(), request.preset.realpath)
      workspace = {
        id: typeof request.preset.id === 'string' && /^[0-9a-f]{12}$/.test(request.preset.id)
          ? request.preset.id
          : workspaceIdFor(realpath),
        path: absolute,
        realpath,
        isGit: request.preset.isGit === true,
        gitRoot: typeof request.preset.gitRoot === 'string' ? request.preset.gitRoot : null,
      }
    } else {
      try {
        workspace = await resolveWorkspace({ cwd: request.path })
      } catch (error) {
        const code = error && error.code
        const detail = error && error.message ? error.message : String(error)
        // 显式指定的工作区坏了就是 400；git 不可用按「不是 git 仓库」处理（07 §4/§6）。
        if (code !== 'GIT_UNAVAILABLE' && request.strict) {
          throw new EngineError(400, `工作区不可用：${detail}`)
        }
        const absolute = isAbsolute(request.path) ? resolve(request.path) : resolve(process.cwd(), request.path)
        let realpath = absolute
        try {
          realpath = await realpathAsync(absolute)
        } catch {
          // 路径都不在：保留词法绝对路径，至少 workspace.id 稳定。
        }
        workspace = {
          id: workspaceIdFor(realpath),
          path: absolute,
          realpath,
          isGit: false,
          gitRoot: null,
        }
        warnings.push(
          code === 'GIT_UNAVAILABLE'
            ? `git 不可用，按「不是 git 仓库」处理：${detail}`
            : `工作区无法解析，按「不是 git 仓库」继续（${request.source}）：${detail}`,
        )
      }
    }

    // 启动开始后不许换工作区：已有 workspace.id 与本次不同 → 400。
    const rawMeta = await this._readRawRunMeta(runId)
    const bound = rawMeta && rawMeta.workspace && typeof rawMeta.workspace === 'object'
      ? rawMeta.workspace
      : null
    if (bound && typeof bound.id === 'string' && bound.id !== '' && bound.id !== workspace.id) {
      throw new EngineError(400, '该 run 已绑定工作区，不能中途更换')
    }

    this.workspaceRecord = workspace
    return { workspace, rawMeta, warnings, source: request.source }
  }

  /**
   * 07 §4（R1+R4）第二步：按策略（默认 auto / on / off）决定并创建 worktree。
   *
   * - `on` + 非 git 根 / 建失败 → 400（不许静默降级）；
   * - `auto` + 非 git → `enabled:false, reason:'not-a-git-repo'`；
   * - `auto` 建失败 → `enabled:false, reason:'create-failed: …'` + 一条 warn；
   * - 建完再 existsSync 复核：**绝不允许** `enabled:true` 但目录实际没建出来。
   */
  async _resolveWorktreeRecord(runId, options, { workspace, rawMeta, warnings, source }) {
    const policy = options && typeof options.worktree === 'string' && options.worktree !== ''
      ? options.worktree
      : this.defaultWorktreePolicy || 'auto'
    let decision
    try {
      decision = decideWorktree({ workspace, policy })
    } catch (error) {
      // WORKTREE_UNAVAILABLE / WORKTREE_POLICY_INVALID：按 400 拒绝启动，不静默降级。
      throw new EngineError(400, error && error.message ? error.message : 'worktree 策略不合法')
    }

    // 兜底工作区（没有发起方 workspace / 会话 cwd / 引擎 cwd，只能落到 process.cwd()）
    // 不擅自开 worktree：连「这是谁的工作区」都没确定，隔离一份服务进程的 cwd 毫无意义，
    // 还会把测试/宿主进程自己的仓库拖进 worktree 台账。显式 `on` 仍按用户要求照建。
    if (decision.enabled && policy === 'auto' && source === 'process.cwd') {
      decision = { enabled: false, reason: 'auto-without-initiator' }
      warnings.push(
        `没有发起方工作区（options.workspace / cwd / 会话 header.cwd 都没有），只能回落 process.cwd()；`
        + `auto 不擅自建 worktree：${workspace.path}`,
      )
    }

    // 同一个 run 的旧绑定还可用（进程重启 / 上次启动失败）：复用，不再建一份。
    const existingWorktree = rawMeta && rawMeta.worktree && typeof rawMeta.worktree === 'object'
      && rawMeta.worktree.enabled === true && typeof rawMeta.worktree.path === 'string'
      ? rawMeta.worktree
      : null
    if (decision.enabled && existingWorktree && existsSyncSafe(existingWorktree.path)) {
      this.worktreeRecord = normalizeWorktreeRecord(existingWorktree)
      return { workspace, worktree: this.worktreeRecord, warnings }
    }

    let worktree
    if (!decision.enabled) {
      worktree = disabledWorktree(decision.reason)
    } else {
      try {
        const created = await createWorktree({
          workspace,
          runId,
          // 07 §4.2：根 = <home>/flow-studio/worktrees，由 runsRoot 的父级推（不硬编码）。
          root: this._worktreesRoot(),
          branchPrefix: 'flow/',
          baseRef: 'HEAD',
        })
        if (!existsSyncSafe(created.path)) {
          throw new Error(`git 报告成功但目录不存在：${created.path}`)
        }
        worktree = {
          enabled: true,
          reason: created.reason || 'git-workspace',
          decidedBy: 'initiator',
          path: created.path,
          branch: created.branch,
          baseCommit: created.baseCommit,
          createdAt: created.createdAt,
        }
      } catch (error) {
        const detail = error && error.message ? error.message : String(error)
        if (policy === 'on') {
          throw new EngineError(400, `按 on 创建 worktree 失败：${detail}`)
        }
        // auto：不假装隔离，落 enabled:false + 原因，并留一条 warn。
        worktree = disabledWorktree(`create-failed: ${detail}`)
        warnings.push(`worktree 创建失败，已按不隔离继续：${detail}`)
      }
    }

    this.worktreeRecord = worktree
    return { workspace, worktree, warnings }
  }

  /** run.json 原始内容（绕过 normalizeMeta 的白名单，用来读 workspace/worktree 绑定）。 */
  async _readRawRunMeta(runId) {
    try {
      const raw = JSON.parse(await readFile(join(this.runsRoot, runId, 'run.json'), 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
    } catch {
      return null
    }
  }

  /** 节点主管会话的 agent preset（per-start > 引擎配置；都没有就交给宿主默认）。 */
  _sessionPreset() {
    if (typeof this.startAgentPreset === 'string' && this.startAgentPreset !== '') return this.startAgentPreset
    if (typeof this.agentPreset === 'string' && this.agentPreset !== '') return this.agentPreset
    return undefined
  }

  /**
   * 默认 activate（07 §3.1，R2）：节点主管会话 = **独立的顶层会话**。
   *
   * `agents.create({ sessionId, meta: { cwd, agentPreset }, agentOptions })`：
   * **绝不**传 `parentAgent` / `meta.parentSession` / `meta.origin` /
   * `meta.delegationDepth` —— 其中任何一个都会让宿主把它记成子会话，从顶层会话
   * 列表里消失。团队成员的会话由主管自己委派（引擎靠 `parentSession === lead`
   * 的 `_bindMember` 发现），不为成员建会话。
   *
   * 结构化输出：`agents.create` 没有 schema 驱动通道，提示词统一要求 ```json
   * 代码块，返回后用 `parseAssistantStructured` 解析（与复用会话同一段代码）。
   */
  async _defaultActivate(args) {
    const agents = this._agentsService()
    if (agents && typeof agents.create === 'function') {
      return this._createNodeSession(args)
    }
    const subagents = this._subagentService()
    if (subagents && typeof subagents.startActivation === 'function') {
      // 兼容旧宿主 / 纯注入测试环境（没有 agents.create）：退回旧 spawn 路径。
      // 真实宿主一律有 agents.create，因此 R2 的默认路径不会走这里。
      this.log('warn', 'flow-studio: agents.create 不可用，退回旧 spawn 路径创建节点会话（兼容模式）')
      return this._legacyActivate(args)
    }
    throw new EngineError(503, 'agents.create 不可用：宿主 agents 服务无法创建节点主管会话')
  }

  /** 07 §3.1：用 `agents.create` 新建一个顶层节点主管会话。 */
  async _createNodeSession({ prompt, signal, onSession, agentOptions, node, attempt, runId, traceId }) {
    const agents = this._agentsService()
    const sessionId = nodeSessionId(runId, node.id, attempt)
    // 只放会话元数据：cwd / agentPreset。父会话 / origin / 委派深度一律不传。
    const meta = {}
    const cwd = this._sessionCwd()
    if (cwd) meta.cwd = cwd
    const preset = this._sessionPreset()
    if (preset) meta.agentPreset = preset
    const createOptions = {
      sessionId,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      // 06 §13.11 M5：node.model 必须真正传给会话创建（不只是界面上填）。
      ...(agentOptions && Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
    }
    if (signal && signal.aborted) throw abortError(signal)

    let handle = null
    let agent = null
    let abandoned = false
    const creating = Promise.resolve().then(() => agents.create(createOptions))
    // abort 与 create 竞争时，句柄仍可能晚到：晚到就立刻释放，别泄漏一个活会话。
    creating.then(value => {
      if (abandoned && value && typeof value.dispose === 'function') value.dispose().catch(() => {})
    }).catch(() => {})
    try {
      handle = await raceAbort(creating, signal)
      agent = handle && handle.agent ? handle.agent : null
    } catch (error) {
      abandoned = true
      if (signal && signal.aborted) throw abortError(signal)
      // 宿主里已有同 id 的活会话（例如进程重启前的会话还没释放）：复用它，不重复创建。
      try {
        agent = typeof agents.get === 'function' ? agents.get(sessionId) || null : null
      } catch {
        agent = null
      }
      if (!agent) throw error
    }
    if (!agent || typeof agent.followup !== 'function') {
      if (handle && typeof handle.dispose === 'function') await handle.dispose().catch(() => {})
      throw new EngineError(503, `节点「${node.id}」的会话 ${sessionId} 创建后不可用（没有 followup）`)
    }
    if (typeof onSession === 'function') {
      try {
        onSession(sessionId)
      } catch {
        // 记录会话 id 失败不该阻断执行。
      }
    }
    let structured
    try {
      structured = await this._promptNodeSession({
        agent, sessionId, prompt, runId, node, attempt, traceId, signal,
      })
    } catch (error) {
      // 结构化输出不合格 / 超时：节点可能还会重试，这里不立即 dispose；把句柄登记到
      // run 级收口，run 结束时统一 handle.dispose()（不删会话文件）。
      if (handle && typeof handle.dispose === 'function') this.disposalHandles.add(handle)
      throw error
    }
    return {
      structured,
      sessionId,
      agent,
      // 07 §3.3：disposalHandles 存宿主句柄；nodeSessions 另存 agent。
      handle,
      output: [],
      // 只释放句柄（dispose），不删会话 / 不删持久化文件。
      dispose: handle && typeof handle.dispose === 'function'
        ? () => handle.dispose()
        : async () => {},
    }
  }

  /**
   * 兼容路径：旧宿主没有 `agents.create` 时，仍用 `ctx.subagents.startActivation`
   * 起一个 spawn 子会话（不是 R2 的默认实现；真实宿主不会走到这里）。
   */
  async _legacyActivate({ prompt, outputSchema, signal, label, onSession, agentOptions }) {
    const subagents = this._subagentService()
    if (!subagents || typeof subagents.startActivation !== 'function') {
      throw new EngineError(503, 'subagents 服务不可用：无法启动子 agent')
    }
    const parent = await this._resolveParent()
    if (!parent) throw new EngineError(503, '没有可用的父会话：无法启动子 agent')
    let started
    try {
      started = await subagents.startActivation({
        provider: 'spawn',
        label: clip(label, 128),
        delivery: 'caller',
        signal,
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent,
          ...(outputSchema === undefined ? {} : { outputSchema }),
          // 06 §13.11 M5：node.model 必须真正传给 spawn provider，不能只在界面上填。
          ...(agentOptions && Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        },
      })
    } catch (error) {
      throw error
    }
    if (typeof onSession === 'function') {
      try {
        onSession(started.childId)
      } catch {
        // 记录会话 id 失败不该阻断执行。
      }
    }
    // abort（stop / 超时）时即使 result 还没落地也要释放子会话资源。
    const onAbort = () => {
      started.dispose().catch(error => {
        this.log('warn', `flow-studio: abort 后 dispose 失败：${error.message}`)
      })
    }
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    let result
    try {
      result = await started.result
    } catch (error) {
      await started.dispose().catch(() => {})
      throw error
    } finally {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
    }
    return {
      structured: result.structured,
      output: result.output,
      stopReason: result.stopReason,
      diagnostic: result.diagnostic,
      sessionId: started.childId,
      dispose: () => started.dispose(),
    }
  }

  async _resolveParent() {
    // 06 §15：本次 start 显式指定了父会话时优先用它（模型工具从当前会话启动流程）。
    // 只在这次 run 内有效；不传时 startParent 为 null，下面三段回落的既有语义完全不变。
    if (this.startParent) return this.startParent
    if (this.parent) return this.parent
    if (this.resolveParentFn) return this.resolveParentFn()
    const agents = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('agents') : undefined
    if (!agents || typeof agents.roots !== 'function') return null
    const roots = agents.roots()
    return Array.isArray(roots) && roots.length > 0 ? roots[roots.length - 1] : null
  }

  // -- 对外：start / stop / wait / sweep -----------------------------------

  /**
   * 开始一个 run。返回时 run/start 已落盘、循环已启动；HTTP 层回 202。
   *
   * 07 §5（R3）：**没有**模块级锁 / 并发上限 / 排队。一个实例只服务一个 run：
   * `start` 在**第一个 await 之前**同步占位（`this.active`）并做实例级校验，失败释放。
   * 同一 runId 的二次 start 由 `src/runtime.js` 的注册表挡（409）；不同 runId 各起
   * 一个实例并行。进入临界区后重读 run.json，确认 `started===false && status==='pending'`。
   * 06 §13.2：真正的 `pending -> running` 由 runstore.startRun() 原子完成（不存在时兜底）。
   * run 不存在 → 404；已开始过 / 流程非法 → 409 / 400。
   *
   * 06 §15：`options.parent` 可为**本次 run** 指定父会话（Agent 对象，模型工具传 `exec.agent`）。
   * R2 起它只用于兼容路径与 `startedBy` 归属，**不再**传给 `agents.create`（节点主管
   * 会话是顶层会话）。覆盖只活到本次 run 收尾（`_cleanupActive()` 清空）。
   *
   * 07 §4（R1+R4）：`options.workspace` 是本次 run 的工作区路径（也接受已解析
   * `{id,path,realpath,isGit,gitRoot}` 对象）；`options.worktree` 是策略
   * `auto`（默认）/ `on` / `off`。工作区在 start 当场解析，worktree 当场决定并创建，
   * 结果写进 run.json（workspace / worktree），run 开始后不可更换。
   *
   * `options.cwd` 既可作为工作区路径候选（优先于构造时 cwd），也继续作为节点主管
   * 会话的工作目录；`options.agentPreset` 透传给节点主管会话。
   *
   * @param {string} runId
   * @param {{ parent?: object | null, workspace?: string | object, worktree?: 'auto'|'on'|'off',
   *   cwd?: string, agentPreset?: string }} [options]
   */
  async start(runId, options = {}) {
    if (!checkRunId(runId)) throw new EngineError(400, 'runId 不合法')
    // 06 §15：只接受 Agent 对象覆盖；null/undefined 都按「不覆盖」处理。
    const parentOverride = options && typeof options === 'object' ? options.parent : undefined
    if (parentOverride !== undefined && parentOverride !== null && typeof parentOverride !== 'object') {
      throw new EngineError(400, 'parent 必须是 Agent 对象（或省略以沿用既有父会话解析）')
    }
    // —— 同步占位：这一行之前不许有任何 await ——
    // 07 §5：实例级占位（一个实例只服务一个 run）。跨 run 的并发由 runtime 管，
    // 这里只防「同一个实例被同时塞两个 run」这种误用。
    if (this.active) {
      throw new EngineError(409, `该 Engine 实例已有运行中的 run（${this.active.runId}），一个实例只服务一个 run`)
    }
    const controller = new AbortController()
    const active = { runId, flow: null, controller, promise: null, starting: true, engine: this }
    this.active = active
    this._resetRunState()
    // 06 §15：把本次 start 的父会话覆盖挂到运行态上；_cleanupActive() 负责清掉。
    this.startParent = parentOverride || null
    this.startCwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : null
    this.startAgentPreset = typeof options.agentPreset === 'string' && options.agentPreset !== ''
      ? options.agentPreset
      : null
    // 07 §3「降级必须可见」：先定下本次 run 的会话形态（run.json / run/start 都要带）。
    this.sessionMode = this._resolveSessionMode()
    this.live = {
      currentNodeId: null,
      attempt: 0,
      round: 0,
      since: isoOf(this.now()),
      lastEventSeq: 0,
      phase: 'idle',
      // §13.12 运行详情快照字段（客户端轮询 run.json.live 显示「正在干什么」）。
      nodeTitle: null,
      nodeMode: null,
      activeMemberId: null,
      lastTool: null,
      lastMessage: null,
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      members: [],
    }

    let transitioned = false
    /** 工作区 / worktree 的降级原因（run/start.data.worktreeWarning + 宿主日志）。 */
    let startWarnings = []
    try {
      // 临界区内重读：别的实例 / 进程可能刚刚改动过 run.json。
      const meta = await readRunMeta(this.runsRoot, runId)
      if (!meta) throw new EngineError(404, 'run 不存在')

      // 07 §4（R1+R4）：工作区在 start 当场解析；已绑定的 run 换工作区 → 400。
      // 放在「已开始 / 已结束」判定之前，让「中途换工作区」得到明确的 400 而不是笼统 409。
      const workspaceState = await this._resolveWorkspaceBinding(runId, options, parentOverride)
      startWarnings = workspaceState.warnings

      if (meta.status === 'done' || meta.status === 'aborted' || meta.status === 'failed') {
        throw new EngineError(409, `run 已结束（${meta.status}），不能重复开始`)
      }
      const startRun = typeof runstoreModule.startRun === 'function' ? runstoreModule.startRun : null
      const legacyRunning = startRun === null && meta.status === 'running'
        && meta.started !== true && (meta.eventCount || 0) === 0
      if (meta.started === true || (meta.status !== 'pending' && !legacyRunning)) {
        throw new EngineError(409, 'run 已开始过，不支持断点续跑')
      }

      const flow = await this.readFlowFn(meta.flowId)
      if (!flow) throw new EngineError(404, '流程不存在')
      // 06 §13.5：开跑前校验；断头路 / 成环 / 多出边 / 非法 reject 一律 400，不开跑。
      const validation = validateFlowForRun(flow)
      if (!validation.ok) {
        throw new EngineError(400, `流程不合法，不能开跑：${validation.errors.map(item => item.message).join('；')}`)
      }
      const stages = (flow.nodes || []).filter(node => node.kind === NODE_KIND.STAGE)

      // 07 §4（R1+R4）：流程校验通过后再决定/创建 worktree（校验失败的流程不该留下 worktree）。
      const resolved = await this._resolveWorktreeRecord(runId, options, workspaceState)
      startWarnings = resolved.warnings
      // 降级/跳过隔离一律 warn 级可见（run/start.data.worktreeWarning 之外再落宿主日志）。
      for (const warning of startWarnings) this.log('warn', `flow-studio: ${warning}`)

      // 06 §16：启动前投递进来的消息、入口阶段节点、以及可能已存在的节点会话表。
      this.startupMessages = this._startupMessagesOf(meta)
      this.entryStageId = this._firstStageId(flow)
      await this._loadNodeSessions(runId)

      // 06 §13.3：先抢单写者租约；抢不到 409（Host 侧 claimLease 才存在时启用）。
      if (typeof runstoreModule.claimLease === 'function') {
        try {
          await runstoreModule.claimLease(this.runsRoot, runId)
          active.lease = true
        } catch (error) {
          if (error && error.status === 409) {
            throw new EngineError(409, error.message || '该 run 已持有执行租约')
          }
          throw error
        }
      }

      // 06 §13.2：原子 pending -> running（同时写 started / startedAt）。
      if (startRun) {
        try {
          await startRun(this.runsRoot, runId)
        } catch (error) {
          if (error && error.status === 409) {
            throw new EngineError(409, error.message || 'run 已在运行，不能重复开始')
          }
          throw error
        }
      } else {
        // 兜底（并行任务尚未落地时）：用 writeRunMeta 原子合并做同样的迁移。
        const latest = await readRunMeta(this.runsRoot, runId)
        if (!latest) throw new EngineError(404, 'run 不存在')
        const legacy = latest.status === 'running' && latest.started !== true && (latest.eventCount || 0) === 0
        if (latest.status !== 'pending' && !legacy) {
          throw new EngineError(409, 'run 已开始过，不支持断点续跑')
        }
        await writeRunMeta(this.runsRoot, runId, {
          status: 'running',
          startedAt: isoOf(this.now()),
          started: true,
          engine: this.engineName,
        })
      }
      transitioned = true
      // 07 §4：工作区 / worktree / sessionMode 写进 run.json（runstore 白名单会丢未知字段，
      // 所以这里按原始 JSON 原子合并；之后每次 live 刷新都会再补一次）。
      await this._patchRunBinding(runId)
      this.lastStartedRunId = runId
      const starterSessionId = this._agentSessionId(parentOverride || this.parent)
      if (starterSessionId) this.startedBy.set(starterSessionId, runId)

      active.flow = flow
      active.starting = false
      this.maxTotalSteps = this.maxTotalSteps || stages.length * 3

      const appended = await this._append(runId, [{
        kind: 'run/start',
        traceId: runTraceId(runId),
        data: {
          flowId: flow.id,
          flowName: flow.name || flow.id,
          nodeTotal: stages.length,
          // 06 §13.8 M7：stub / real 一眼可见。
          engine: this.engineName,
          // 07 §4（R4）/§3：工作区与 worktree 决策贴在同一处，客户端不用再读 run.json。
          ...(this.workspaceRecord
            ? { workspaceId: this.workspaceRecord.id, worktreeEnabled: this.worktreeRecord ? this.worktreeRecord.enabled === true : false }
            : {}),
          ...(this.sessionMode ? { sessionMode: this.sessionMode } : {}),
          // 降级原因（git 不可用 / worktree 建失败）：不新造 kind，挂在 run/start.data 上。
          ...(startWarnings.length > 0 ? { worktreeWarning: clip(startWarnings.join('；'), 2000) } : {}),
        },
      }])
      this.live.lastEventSeq = appended.lastSeq
      await this._persistLive()

      this.active.promise = this._loop(runId, flow, stages.length)
      // 让循环先跑出第一步再返回，202 里就能看到 live.currentNodeId。
      await Promise.resolve()
      return readRunMeta(this.runsRoot, runId)
    } catch (error) {
      // 失败释放占位；已经把 run 迁到 running 的，尽量把终态写回去，不让它悬挂。
      if (transitioned) {
        await writeRunMeta(this.runsRoot, runId, { status: 'failed' }).catch(() => {})
      }
      if (active.lease && typeof runstoreModule.releaseLease === 'function') {
        await runstoreModule.releaseLease(this.runsRoot, runId).catch(() => {})
      }
      if (this.active === active) this._cleanupActive()
      throw error
    }
  }

  /** 每个 run 从零开始的运行态（一个引擎实例可以依次跑多个 run）。 */
  _resetRunState() {
    this.attempts = new Map()
    this.lastResults = new Map()
    this.rejectContexts = new Map()
    this.passedNodes = []
    this.round = 0
    this.artifactBytes = 0
    this.runTimedOut = false
    // 06 §9：最近一次节点级失败的坐标；run/end failed 用 failedNodeId 指认「死在哪」。
    this.failedNode = null
    this.maxTotalSteps = this.configuredMaxTotalSteps
    this.sessionBindings.clear()
    this.pendingSessionEvents = []
    this.pendingToolCalls.clear()
    this.lastAssistantText.clear()
    this.liveUsage.clear()
    this.artifactIndex = new Map()
    // 07 §4：本次 run 的工作区 / worktree 决策（start 时重算）。
    this.workspaceRecord = null
    this.worktreeRecord = null
    this.sessionMode = null
    this._resetInboxState()
  }

  /** 06 §16：每 run 从零开始的收件箱 / 节点会话运行态（跨 run 的 sessionIndex 不清）。 */
  _resetInboxState() {
    this.nodeSessions = new Map()
    this.disposalHandles = new Set()
    this.startupMessages = []
    this.entryStageId = null
    this.sessionDegraded = false
    this.lastAssistantBySession = new Map()
  }

  /** 停止当前 run（06 §9）：abort 在飞请求，等循环收尾后返回最新 run 元数据。 */
  async stop(runId) {
    if (!checkRunId(runId)) throw new EngineError(400, 'runId 不合法')
    if (!this.active || this.active.runId !== runId) {
      throw new EngineError(409, '该 run 不在运行中')
    }
    const active = this.active
    active.controller.abort(new Error('用户停止'))
    // start 可能正卡在 run/start 落盘；等 promise 挂上再等收尾。
    let waited = 0
    while (!active.promise && waited < 2000) {
      await new Promise(resolve => setTimeout(resolve, 5))
      waited += 5
    }
    if (active.promise) await active.promise.catch(() => {})
    return readRunMeta(this.runsRoot, runId)
  }

  /** 等当前（或指定）run 收尾。 */
  async wait(runId) {
    if (this.active && (runId === undefined || this.active.runId === runId)) {
      if (this.active.promise) await this.active.promise.catch(() => {})
    }
    if (typeof runId !== 'string') return null
    return readRunMeta(this.runsRoot, runId)
  }

  async whenIdle() {
    await this.eventQueue.catch(() => {})
    if (this.active && this.active.promise) await this.active.promise.catch(() => {})
  }

  /** 把 pending 的会话事件队列写完（测试 / 收尾用）。 */
  async flushEvents() {
    await this.eventQueue.catch(() => {})
  }

  /**
   * 启动时清理崩溃残留（06 §9）：status=running 且 30 分钟无新事件 → failed。
   * 不自动续跑。
   * @returns {Promise<string[]>} 被标记的 runId
   */
  async sweepStaleRuns() {
    const recovered = []
    let entries
    try {
      entries = await readdir(this.runsRoot, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') return recovered
      throw error
    }
    const cutoff = this.now().getTime() - this.staleMs
    for (const entry of entries) {
      if (!entry.isDirectory() || !checkRunId(entry.name)) continue
      if (this.active && this.active.runId === entry.name) continue
      const meta = await readRunMeta(this.runsRoot, entry.name).catch(() => null)
      if (!meta || meta.status !== 'running') continue
      let lastTs = meta.eventCount > 0 ? 0 : Date.parse(meta.createdAt)
      if (!Number.isFinite(lastTs)) lastTs = Date.parse(meta.createdAt)
      const all = await readAllEvents(this.runsRoot, entry.name).catch(() => null)
      if (all && all.events.length > 0) {
        for (const event of all.events) {
          const ts = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN
          if (Number.isFinite(ts) && ts > lastTs) lastTs = ts
        }
        // 事件 ts 全部不可解析时退回 updatedAt，避免把坏数据当“刚活动”。
        if (lastTs === 0) lastTs = Date.parse(meta.updatedAt)
      }
      if (!Number.isFinite(lastTs) || lastTs >= cutoff) continue
      try {
        await this._append(entry.name, [{
          kind: 'run/end',
          traceId: runTraceId(entry.name),
          data: {
            status: 'failed',
            reason: `引擎中断：超过 ${Math.round(this.staleMs / 60000)} 分钟无新事件（不自动续跑）`,
          },
          extra: { recovered: true, engineInterrupted: true },
        }], { live: false })
        await writeRunMeta(this.runsRoot, entry.name, { live: null })
        recovered.push(entry.name)
        this.log('warn', `flow-studio: run ${entry.name} 标记为引擎中断`)
      } catch (error) {
        this.log('warn', `flow-studio: 清理残留 run ${entry.name} 失败：${error.message}`)
      }
    }
    return recovered
  }

  // -- 主循环 -------------------------------------------------------------

  /** 06 §13.5：循环内的访问集 / 步数 / 墙钟三重终止性防护。 */
  async _loop(runId, flow, stageTotal) {
    const active = this.active
    const signal = active.controller.signal
    const maxSteps = this.maxTotalSteps || stageTotal * 3
    const visited = new Set()
    let node = null
    let aborted = false
    let arrivedByReject = false
    let steps = 0
    const deadline = setTimeout(() => {
      this.runTimedOut = true
      active.controller.abort(new Error(`run 超过墙钟上限（${this.runTimeoutMs}ms）`))
    }, this.runTimeoutMs)
    // 06 §13.3：每 30s 续租；续租失败只告警（租约过期由 Host sweep 收尾）。
    const leaseTimer = active.lease && typeof runstoreModule.renewLease === 'function'
      ? setInterval(() => {
        runstoreModule.renewLease(this.runsRoot, runId).catch(error => {
          this.log('warn', `flow-studio: 续租失败（${runId}）：${error.message}`)
        })
      }, 30000)
      : null
    if (leaseTimer && typeof leaseTimer.unref === 'function') leaseTimer.unref()
    try {
      node = selectFirstNode(flow)
      if (!node) throw new Error('流程没有可执行节点：开始节点没有 next 出边')
      while (node && node.kind !== NODE_KIND.END) {
        if (this.runTimedOut) throw new Error(`超过 run 墙钟上限（${this.runTimeoutMs}ms）`)
        if (signal.aborted) {
          aborted = true
          break
        }
        if (node.kind !== NODE_KIND.STAGE) {
          throw new Error(`节点「${node.title || node.id}」不是阶段节点，无法执行`)
        }
        if (!arrivedByReject && visited.has(node.id)) {
          // 06 §13.5：next 边成环（不是打回）→ node/end failed + run/end failed，不得 done。
          this.round += 1
          const attempt = (this.attempts.get(node.id) || 0) + 1
          this.attempts.set(node.id, attempt)
          const traceId = nodeTraceId(runId, node.id, attempt)
          await this._append(runId, [this._nodeStartEvent(node, attempt, traceId)])
          await this._failNode(runId, node, attempt, traceId,
            `next 边成环：节点「${node.title || node.id}」被重复访问（不是打回）`, { cycle: true })
          throw new Error(`next 边成环：节点「${node.title || node.id}」被重复访问（不是打回）`)
        }
        arrivedByReject = false
        visited.add(node.id)
        this.round += 1
        steps += 1
        const attempt = (this.attempts.get(node.id) || 0) + 1
        this.attempts.set(node.id, attempt)
        const traceId = nodeTraceId(runId, node.id, attempt)
        if (steps > maxSteps) {
          // 06 §13.5：run 级步数上限（阶段数 × 3）。
          await this._append(runId, [this._nodeStartEvent(node, attempt, traceId)])
          await this._failNode(runId, node, attempt, traceId,
            `超过 run 级步数上限（阶段数 × 3 = ${maxSteps}），已执行 ${steps} 步`, { maxTotalSteps: maxSteps })
          throw new Error(`超过 run 级步数上限（阶段数 × 3 = ${maxSteps}）`)
        }
        const previous = this.lastResults.get(node.id) || null
        const rejectContext = this.rejectContexts.get(node.id) || null
        const startedAt = this.now()
        this.current = {
          node,
          attempt,
          round: this.round,
          traceId,
          startedAt,
          members: new Map(),
          memberSeq: 0,
        }
        await this._setLive({
          currentNodeId: node.id,
          attempt,
          round: this.round,
          since: isoOf(startedAt),
          phase: 'spawn',
          // §13.12：节点级快照字段在每次换节点时重置；tokens 是 run 级累计，不清零。
          nodeTitle: clip(String(node.title || node.id), LIVE_NODE_TITLE_MAX_CHARS),
          nodeMode: node.mode === EXEC_MODE.TEAM ? 'team' : 'single',
          activeMemberId: null,
          lastTool: null,
          lastMessage: null,
          members: [],
        })
        await this._append(runId, [this._nodeStartEvent(node, attempt, traceId)])

        let outcome = null
        let lastError = null
        let retries = 0
        // 06 §9：节点级失败先重试（默认 1 次）。重试不新增 attemptId——attemptId 仍表示
        // 「打回意义上的第几次」，不能因为一次崩溃就吃掉目标的 maxRounds；同 attemptId
        // 再写一条 node/start（data.retry / data.retryReason）作为重试痕迹，不新增事件 kind。
        for (;;) {
          try {
            outcome = await this._executeNode(runId, flow, node, attempt, stageTotal, {
              traceId, previous, rejectContext, startedAt, signal,
            })
            break
          } catch (error) {
            lastError = error
            // 用户停止 / run 墙钟：重试只会被同一个信号再打断，直接走中止/超时收尾。
            if (signal.aborted || this.runTimedOut) break
            if (retries >= this.nodeRetries) break
            retries += 1
            const retryReason = clip(error.message || String(error), 256)
            this.log('warn', `flow-studio: 节点「${node.id}」attempt ${attempt} 失败，第 ${retries}/${this.nodeRetries} 次重试：${retryReason}`)
            await this._setLive({ phase: 'spawn', since: isoOf(this.now()) })
            await this._append(runId, [
              this._nodeStartEvent(node, attempt, traceId, { retry: retries, retryReason }),
            ]).catch(() => {})
          }
        }

        if (!outcome) {
          const error = lastError || new Error('节点执行失败（原因未知）')
          const durationMs = Math.max(0, this.now().getTime() - startedAt.getTime())
          const validationError = error instanceof StructuredOutputError ? error.validationError : undefined
          const reason = clip(error.message || String(error), 256)
          const extra = {
            reason,
            ...(retries > 0 ? { retries } : {}),
            ...(validationError ? { validationError: clip(validationError, 256) } : {}),
            ...(error instanceof NodeTimeoutError ? { timeout: true, timeoutMs: error.timeoutMs } : {}),
            ...(signal.aborted && !this.runTimedOut ? { aborted: true } : {}),
            ...(this.runTimedOut ? { runTimeout: true } : {}),
          }
          await this._append(runId, [{
            kind: 'node/end',
            nodeId: node.id,
            attemptId: attempt,
            traceId,
            data: { status: 'failed', durationMs, ...(retries > 0 ? { retries } : {}) },
            extra,
          }]).catch(() => {})
          this.current = null
          this.failedNode = { nodeId: node.id, attempt, reason: clip(error.message || String(error), 2000) }
          if (this.runTimedOut) throw error
          if (signal.aborted) {
            aborted = true
            break
          }
          // 06 §9：失败隔离——重试用尽只判该节点失败，已通过节点的事件/产物全部保留；
          // 跳出主循环，由下面的统一收口写 run/end{status:'failed', failedNodeId}。
          break
        }

        const durationMs = Math.max(0, this.now().getTime() - startedAt.getTime())
        this.lastResults.set(node.id, {
          attempt,
          verdict: outcome.verdict,
          summary: outcome.summary,
          findings: outcome.findings,
          artifactPaths: outcome.artifactPaths,
          acceptance: outcome.acceptance,
          tests: outcome.tests,
          checks: outcome.checks,
          evidence: outcome.evidence,
        })
        this.rejectContexts.delete(node.id)

        if (outcome.verdict === 'reject') {
          await this._append(runId, [{
            kind: 'node/end',
            nodeId: node.id,
            attemptId: attempt,
            traceId,
            data: {
              status: 'rejected',
              durationMs,
              ...(retries > 0 ? { retries } : {}),
              ...(outcome.membersPartial ? { membersPartial: true } : {}),
            },
            ...(outcome.membersPartial ? { extra: { membersPartial: true } } : {}),
          }])
          const choice = selectRejectTarget(flow, node, outcome.rejectTarget)
          if (!choice) {
            const reason = `节点「${node.title || node.id}」判定打回，但没有任何 reject 边（无法确定回退目标）`
            this.failedNode = { nodeId: node.id, attempt, reason }
            throw new Error(reason)
          }
          const reason = clip(outcome.rejectReason || '未提供打回原因', 2000)
          await this._append(runId, [{
            kind: 'reject/trigger',
            nodeId: node.id,
            attemptId: attempt,
            traceId,
            data: {
              edgeId: String(choice.edge.id),
              fromNodeId: node.id,
              toNodeId: choice.target.id,
              reason,
            },
          }])
          const targetRuns = this.attempts.get(choice.target.id) || 0
          const maxRounds = Number.isInteger(choice.target.maxRounds) && choice.target.maxRounds >= 1
            ? choice.target.maxRounds
            : 2
          // 06 §13.10：maxRounds = **允许的重跑次数**，所以 total attempts 上限是 maxRounds + 1。
          // 已经重跑过 (targetRuns - 1) 次；达到上限就先写目标节点 node/end failed，再失败收尾。
          if (targetRuns - 1 >= maxRounds) {
            const targetAttempt = targetRuns
            const targetTraceId = nodeTraceId(runId, choice.target.id, targetAttempt)
            await this._failNode(runId, choice.target, targetAttempt, targetTraceId,
              `超打回上限：目标「${choice.target.title || choice.target.id}」已重跑 ${targetRuns - 1} 次（上限 ${maxRounds}）`,
              { rejectLimit: true, maxRounds })
            throw new Error(`超打回上限：目标「${choice.target.title || choice.target.id}」已重跑 ${targetRuns - 1} 次（上限 ${maxRounds}）`)
          }
          const targetPrevious = this.lastResults.get(choice.target.id) || null
          // 06 §13.7 B4：把上一轮（目标节点上次 attempt）的证据标识下传，要求本轮全量重报。
          const previousEvidence = targetPrevious && targetPrevious.evidence ? targetPrevious.evidence : null
          this.rejectContexts.set(choice.target.id, {
            fromNodeId: node.id,
            fromTitle: node.title || node.id,
            fromAttempt: attempt,
            reason,
            rejectTarget: typeof outcome.rejectTarget === 'string' ? outcome.rejectTarget : undefined,
            findings: outcome.findings,
            previousEvidence,
          })
          // 06 §13.10：打回时把失效路径从 passed 集合移除（只保留沿 next 能到达新目标的记录）。
          this._invalidatePassedFrom(flow, choice.target.id)
          // 同一条失效路径上的节点允许被重新执行（否则会被访问集误判成 next 成环）。
          for (const visitedId of [...visited]) {
            if (visitedId === choice.target.id || canReachViaNext(flow, choice.target.id, visitedId)) {
              visited.delete(visitedId)
            }
          }
          node = choice.target
          arrivedByReject = true
          continue
        }

        // 06 §13.5：selectNextNode 返回 null 且当前不是 end → node/end failed，不得 done。
        const nextNode = selectNextNode(flow, node)
        if (!nextNode) {
          await this._failNode(runId, node, attempt, traceId,
            `断头路：节点「${node.title || node.id}」没有 next 出边且不是结束节点`, { deadEnd: true })
          throw new Error(`断头路：节点「${node.title || node.id}」没有 next 出边且不是结束节点`)
        }
        await this._append(runId, [{
          kind: 'node/end',
          nodeId: node.id,
          attemptId: attempt,
          traceId,
          data: {
            status: 'passed',
            durationMs,
            ...(retries > 0 ? { retries } : {}),
            ...(outcome.membersPartial ? { membersPartial: true } : {}),
          },
          ...(outcome.membersPartial ? { extra: { membersPartial: true } } : {}),
        }])
        this.passedNodes.push({
          nodeId: node.id,
          title: node.title || node.id,
          attempt,
          summary: outcome.summary,
          artifactPaths: outcome.artifactPaths,
        })
        this.current = null
        node = nextNode
      }

      if (this.runTimedOut) throw new Error(`超过 run 墙钟上限（${this.runTimeoutMs}ms）`)
      if (signal.aborted) aborted = true
      if (this.failedNode && !aborted) {
        // 06 §9 失败隔离：节点失败收口为 run failed，但已通过节点的事件 / 产物一条不动；
        // failedNodeId 明确告诉查看者「死在哪」，而不是只有一个笼统 reason。
        const failure = this.failedNode
        await this._append(runId, [{
          kind: 'run/end',
          traceId: runTraceId(runId),
          data: {
            status: 'failed',
            reason: clip(failure.reason || '节点执行失败', 2000),
            failedNodeId: failure.nodeId,
          },
          extra: {
            error: 'NodeFailure',
            detail: clip(failure.reason || '', 256),
            nodeId: failure.nodeId,
            ...(Number.isInteger(failure.attempt) ? { attempt: failure.attempt } : {}),
          },
        }])
      } else {
        await this._append(runId, [{
          kind: 'run/end',
          traceId: runTraceId(runId),
          data: aborted ? { status: 'aborted', reason: '已停止' } : { status: 'done' },
        }])
      }
    } catch (error) {
      const timedOut = this.runTimedOut
      const abortedNow = !timedOut && (signal.aborted || isAbortError(error))
      // 06 §9：失败坐标为 null 时退回 this.current（例如在主循环外抛错时仍尽量指认节点）。
      const failure = this.failedNode
        || (this.current ? { nodeId: this.current.node.id, attempt: this.current.attempt } : null)
      try {
        await this._append(runId, [{
          kind: 'run/end',
          traceId: runTraceId(runId),
          data: abortedNow
            ? { status: 'aborted', reason: '已停止' }
            : {
              status: 'failed',
              reason: clip(error.message || String(error), 2000),
              ...(failure ? { failedNodeId: failure.nodeId } : {}),
            },
          ...(abortedNow ? {} : {
            extra: {
              error: clip(error.name || 'Error', 64),
              detail: clip(error.message || String(error), 256),
              ...(failure ? { nodeId: failure.nodeId } : {}),
              ...(failure && Number.isInteger(failure.attempt) ? { attempt: failure.attempt } : {}),
              ...(error instanceof StructuredOutputError ? { validationError: clip(error.validationError, 256) } : {}),
              ...(error instanceof NodeTimeoutError ? { timeout: true } : {}),
              ...(timedOut ? { runTimeout: true } : {}),
            },
          }),
        }])
      } catch (writeError) {
        this.log('error', `flow-studio: 写 run/end 失败：${writeError.message}`)
      }
    } finally {
      clearTimeout(deadline)
      if (leaseTimer) clearInterval(leaseTimer)
      await this.eventQueue.catch(() => {})
      await writeRunMeta(this.runsRoot, runId, { live: null }).catch(() => {})
      // 收尾这次 writeRunMeta 同样会重写 run.json：终态也要保留工作区绑定。
      await this._patchRunBinding(runId)
      if (active.lease && typeof runstoreModule.releaseLease === 'function') {
        await runstoreModule.releaseLease(this.runsRoot, runId).catch(error => {
          this.log('warn', `flow-studio: 释放租约失败（${runId}）：${error.message}`)
        })
      }
      // 06 §16：run 结束（done/failed/aborted）或 stop 收口时，统一释放本次 run 的会话。
      await this._disposeRunSessions(runId)
      this._cleanupActive()
      // 07 §5：由 runtime 创建的实例，收尾后通知 runtime 把本实例从注册表摘掉（不轮询）。
      this._notifySettled(runId)
    }
  }

  /** run 收尾回调（每个 run 一次；单个失败只告警，不影响收尾）。 */
  _notifySettled(runId) {
    if (typeof this.onSettled !== 'function') return
    try {
      this.onSettled(runId)
    } catch (error) {
      this.log('warn', `flow-studio: onSettled 回调失败（${runId}）：${error.message}`)
    }
  }

  /**
   * node/start 事件。
   *
   * 06 §9：重试不新增 attemptId（attemptId 仍表示「打回意义上的第几次尝试」，
   * 不能因为一次崩溃就吃掉 maxRounds），而是在同一个 attemptId 上再写一条
   * node/start，用 `data.retry` 标出第几次重试、`data.retryReason` 留失败原因。
   * 这样不新增事件 kind、不改 runlog.js 契约，时间线也能看出「这条是重试」。
   */
  _nodeStartEvent(node, attempt, traceId, extra = {}) {
    return {
      kind: 'node/start',
      nodeId: node.id,
      attemptId: attempt,
      traceId,
      data: {
        title: clip(String(node.title || node.id), 512),
        mode: node.mode === EXEC_MODE.TEAM ? 'team' : 'single',
        ...(typeof node.model === 'string' && node.model.trim() !== '' ? { model: clip(node.model, 128) } : {}),
        skills: Array.isArray(node.skills)
          ? node.skills.filter(name => typeof name === 'string' && name.trim() !== '').slice(0, 12).map(name => clip(name, 64))
          : [],
        ...extra,
      },
    }
  }

  /** 06 §13.5/§13.10：失败收尾时给节点补一条 node/end failed（带 reason）。 */
  async _failNode(runId, node, attempt, traceId, reason, extra = {}) {
    // 06 §9：把失败坐标留给 run/end 的 failedNodeId（外层的 this.current 此时可能已清空）。
    this.failedNode = { nodeId: node.id, attempt, reason: clip(reason, 2000) }
    await this._append(runId, [{
      kind: 'node/end',
      nodeId: node.id,
      attemptId: attempt,
      traceId,
      data: { status: 'failed', durationMs: 0 },
      extra: { reason: clip(reason, 256), ...extra },
    }]).catch(() => {})
  }

  /** 06 §13.10：打回把失效路径从 passed 集合移除（含目标节点本身）。 */
  _invalidatePassedFrom(flow, targetId) {
    this.passedNodes = this.passedNodes.filter(entry =>
      entry.nodeId !== targetId && !canReachViaNext(flow, targetId, entry.nodeId))
  }

  /**
   * 07 §6（R6）：把节点的 executor 配置归一化成可执行 spec。
   *
   * 非法组合（未知 executor / custom 缺 executorCommand / 外部 executor 配了 team）
   * 按「结构不合格」失败：抛 StructuredOutputError，节点走既有的打回/失败路径，
   * 错误文案带中文原因（来自 executor.normalizeExecutor）。
   */
  _executorSpecOf(node) {
    try {
      return normalizeExecutor(node)
    } catch (error) {
      throw new StructuredOutputError(
        `executor 配置不合法：${error && error.message ? error.message : String(error)}`,
      )
    }
  }

  /**
   * 07 §6：外部 executor 的 schema 文件路径与内容。
   *
   * 位置固定为 `<runsRoot>/<runId>/executors/<attemptId>.schema.json`（不写 /tmp）；
   * 内容就是引擎既有的节点输出 schema（ENGINE_OUTPUT_SCHEMA），与 dsh 路径同一口径。
   */
  async _writeExecutorSchema(runId, attempt) {
    const dir = join(this.runsRoot, runId, 'executors')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${attempt}.schema.json`)
    await writeFile(file, `${JSON.stringify(ENGINE_OUTPUT_SCHEMA, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await chmod(file, 0o600).catch(() => {})
    return file
  }

  /**
   * 07 §6（R6）：跑一个外部 executor 节点（codex / custom），返回结构化对象。
   *
   * 口径与 dsh executor 对齐：
   *   - prompt 用同一个 `buildPrompt` 结果；cwd 用 `this._sessionCwd()`（worktree 开着就是
   *     worktree.path）；超时用它同一个 nodeTimeoutMs；signal 是本次 attempt 的 combined；
   *   - 过程事件复用既有 `agent/message` 通道写节点日志（role=assistant，text≤2000 码点）；
   *   - usage 非空才写一条 `model/call`（四桶归一化，缺桶补 0；callId 稳定，重试整条替换）；
   *   - 没有 structured → StructuredOutputError；非 0 退出 → 错误消息带 stderr 尾；
   *   - timeout → NodeTimeoutError；abort → AbortError（run 收成 aborted，不是 failed）。
   */
  async _runExternalNode({ runId, node, attempt, traceId, prompt, spec, signal, isTimedOut }) {
    const schemaPath = await this._writeExecutorSchema(runId, attempt)
    const runnable = { ...spec, schemaPath }
    const provider = spec.kind === 'codex' ? 'codex' : 'custom'
    let logCount = 0
    const LOG_LIMIT = 200
    let logChain = Promise.resolve()
    const appendLog = text => {
      if (logCount >= LOG_LIMIT) return
      const raw = String(text ?? '')
      const body = clipChars(raw, AGENT_MESSAGE_MAX_CHARS)
      if (body.trim() === '') return
      logCount += 1
      logChain = logChain.then(() => this._append(runId, [{
        kind: 'agent/message',
        nodeId: node.id,
        attemptId: attempt,
        traceId,
        data: {
          role: 'assistant',
          text: body,
          // runlog 的 agent/message 契约要求 truncated 必填（布尔）。
          truncated: body !== raw,
          provider,
          ...(runnable.model ? { model: clip(runnable.model, 128) } : {}),
        },
      }])).catch(() => {})
    }

    let lastUsage = null
    const result = await runExternalExecutor({
      spec: runnable,
      prompt,
      cwd: this._sessionCwd() || process.cwd(),
      timeoutMs: this.nodeTimeoutMs,
      signal,
      onEvent: event => {
        if (!event || typeof event !== 'object') return
        if (event.kind === 'usage') {
          lastUsage = event.usage || lastUsage
          return
        }
        // final 已经在 result.text / result.structured 里收口，不再重复写一条日志。
        if (event.kind === 'final') return
        if (typeof event.text === 'string') appendLog(event.text)
      },
    })
    await logChain

    // 5) 用量：有才记，不编造（四桶归一化由 mapHostUsage 完成，缺桶补 0）。
    const usage = result.usage || lastUsage
    if (usage) {
      const mapped = mapHostUsage(usage)
      if (mapped) {
        await this._append(runId, [{
          kind: 'model/call',
          nodeId: node.id,
          attemptId: attempt,
          traceId,
          data: {
            provider,
            model: runnable.model || 'unknown',
            // 同一 attempt 的重试沿用同一 callId：聚合时「后到整条替换」，不重复计。
            callId: clip(`executor:${node.id}:${attempt}`, 128),
            usage: mapped,
          },
        }]).catch(() => {})
      }
    }

    if (!result.ok) {
      if (result.reason === 'timeout' || (result.reason === 'aborted' && typeof isTimedOut === 'function' && isTimedOut())) {
        throw new NodeTimeoutError(node.id, this.nodeTimeoutMs)
      }
      if (result.reason === 'aborted') throw abortError(signal)
      if (result.reason === 'spawn') {
        throw new Error(`无法启动外部 executor（${provider}）：${result.message || '未知错误'}`)
      }
      const tail = typeof result.tail === 'string' && result.tail.trim() !== '' ? result.tail.trim() : ''
      const code = Number.isInteger(result.exitCode) ? String(result.exitCode) : '未知'
      throw new Error(clip(
        `外部 executor（${provider}）非 0 退出（${code}）：${tail || '没有 stderr 输出'}`,
        2000,
      ))
    }

    if (!result.structured) {
      const tail = typeof result.tail === 'string' && result.tail.trim() !== '' ? result.tail.trim() : ''
      throw new StructuredOutputError(
        `外部 executor（${provider}）没有返回可解析的结构化输出${tail ? `：${clip(tail, 300)}` : ''}`,
      )
    }
    return result.structured
  }

  /** 执行一个节点：拼提示词 → activate / 外部 executor / stub → 校验 → 落产物与证据。 */
  async _executeNode(runId, flow, node, attempt, stageTotal, context) {
    const { traceId, previous, rejectContext, signal } = context
    // 06 §13.10：上游产物只能取「沿 next 能到达当前节点」且仍有效的 passed 记录。
    const upstream = []
    const seenUpstream = new Set()
    for (let index = this.passedNodes.length - 1; index >= 0 && upstream.length < 3; index -= 1) {
      const entry = this.passedNodes[index]
      if (seenUpstream.has(entry.nodeId)) continue
      if (entry.nodeId === node.id) continue
      if (!canReachViaNext(flow, entry.nodeId, node.id)) continue
      seenUpstream.add(entry.nodeId)
      upstream.unshift(entry)
    }
    // 06 §6：宿主侧预读最近上游产物的有界正文（buildPrompt 保持纯函数，不碰 fs）；
    // 读取失败 / 文件缺失 / 超限都降级为空内容，路径行照旧下传。
    const upstreamWithContents = await loadUpstreamArtifactContents(this.runsRoot, runId, upstream)
    // 06 §16：把「发给本节点的、尚未投递的入站消息」拼进提示词，并把它们标记为已投递；
    // 入口节点收到的消息会作为「来自流程收件箱」继续出现在后续每个阶段节点里。
    const inboxText = await consumeInboxForNode(
      { runsRoot: this.runsRoot, log: this.log },
      runId,
      node.id,
      { startupMessages: this.startupMessages },
    )
    const prompt = buildPrompt({
      node,
      attempt,
      upstream: upstreamWithContents,
      previous,
      rejectContext,
      inboxText,
    })
    // 06 §13.11 M5：node.model 传给子 agent（注入的 activate 同样能收到 agentOptions）。
    const model = typeof node.model === 'string' && node.model.trim() !== '' ? clip(node.model.trim(), 128) : ''
    const agentOptions = model === '' ? undefined : { model }

    let structuredRaw
    // 07 §6（R6）：本节点是否由外部进程执行（影响 readUsage 兜底与会话缓存）。
    let externalExecutor = false
    const timeoutController = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      timeoutController.abort(new NodeTimeoutError(node.id, this.nodeTimeoutMs))
    }, this.nodeTimeoutMs)
    const combined = combineSignals([signal, timeoutController.signal])

    try {
      if (this.stub) {
        await new Promise(resolve => setTimeout(resolve, 0))
        if (combined.aborted) throw abortError(combined)
        structuredRaw = stubStructured(node, attempt, flow, this.now())
        await this._writeStubEvidence(runId, node, attempt, traceId)
      } else {
        const label = `${runId}/${node.id}#${attempt}`
        // 07 §6（R6）：node.executor ∈ dsh | codex | custom（model.js 已做保存时校验）。
        // 非 dsh 一律起外部进程，**不走** this.activate，也不复用节点会话。
        const executorSpec = this._executorSpecOf(node)
        const existingSession = this.nodeSessions.get(node.id)
        if (executorSpec.kind !== 'dsh') {
          externalExecutor = true
          structuredRaw = await this._runExternalNode({
            runId,
            node,
            attempt,
            traceId,
            prompt,
            spec: executorSpec,
            signal: combined,
            isTimedOut: () => timedOut,
          })
        } else if (existingSession && typeof existingSession.sessionId === 'string' && this._agentsUsable()) {
          // 06 §16：一个节点一个会话。二次激活 / 打回重跑都投进同一个会话（活会话直接
          // followup，冷会话或已被压缩的会话先 resume），**不再新起会话**。
          try {
            const reused = await this._followupNodeSession({
              runId, node, attempt, prompt, signal, combined, traceId, entry: existingSession,
            })
            structuredRaw = reused.structured
            this._recordNodeSession(runId, node.id, reused.sessionId, {
              createdAt: existingSession.createdAt,
              agent: reused.agent || null,
              attempt,
            })
            await this._persistNodeSessions(runId)
          } catch (error) {
            if (timedOut) throw new NodeTimeoutError(node.id, this.nodeTimeoutMs)
            throw error
          }
        } else {
          if (!this._agentsUsable() && !this.sessionDegraded) {
            // 06 §16 降级：测试台 / 纯注入环境没有 agents 服务，无法复用会话；退回每次新会话。
            this.sessionDegraded = true
            this.log('warn', 'flow-studio: 缺少 ctx.agents 服务，节点会话无法复用，已退化为每次新会话')
          }
          let activation
          try {
            activation = await raceAbort(this.activate({
              prompt,
              outputSchema: ENGINE_OUTPUT_SCHEMA,
              signal: combined,
              label,
              // 附加字段：注入的 activate 可忽略；默认包装器靠它提前登记 sessionId。
              onSession: sessionId => this.bindSession(sessionId, {
                nodeId: node.id,
                attemptId: attempt,
                memberId: null,
                traceId,
              }),
              node,
              attempt,
              // 07 §3.1：默认实现用 (runId, node, attempt) 生成稳定的顶层会话 id。
              runId,
              traceId,
              ...(agentOptions ? { agentOptions } : {}),
            }), combined)
          } catch (error) {
            if (timedOut) throw new NodeTimeoutError(node.id, this.nodeTimeoutMs)
            throw error
          }
          // 06 §16：**不**在节点结束时 dispose —— 句柄留到 run 结束（done/failed/aborted）
          // 或 stop 时统一释放，节点可能在打回循环里被二次激活。
          // 07 §3.3：优先拿宿主句柄（activation.handle），注入 activate 则用返回对象本身。
          const sessionHandle = activation && activation.handle
            && typeof activation.handle.dispose === 'function'
            ? activation.handle
            : activation
          if (sessionHandle && typeof sessionHandle.dispose === 'function') {
            this.disposalHandles.add(sessionHandle)
          }
          if (activation && typeof activation.sessionId === 'string') {
            this.bindSession(activation.sessionId, { nodeId: node.id, attemptId: attempt, memberId: null, traceId })
            this._recordNodeSession(runId, node.id, activation.sessionId, {
              handle: sessionHandle,
              agent: activation.agent || null,
              attempt,
            })
            await this._persistNodeSessions(runId)
          }
          structuredRaw = extractStructured(activation)
        }
      }

      if (timedOut) throw new NodeTimeoutError(node.id, this.nodeTimeoutMs)
      if (signal.aborted) throw abortError(signal)

      const structured = normalizeStructured(structuredRaw)
      await this.flushEvents()
      const written = await this._writeStructured(runId, node, attempt, traceId, structured, stageTotal)
      await this.flushEvents()
      const membersPartial = await this._closeMembers(runId, node, attempt, traceId)

      // readUsage 是可选注入：订阅之外的兜底（同一 traceId+callId 的重复会被聚合替换）。
      // 外部 executor 的用量已经由 _runExternalNode 按同一口径写过 model/call，不再重复读宿主会话。
      if (this.readUsage && !externalExecutor) {
        await this._collectUsageFromReader(runId, node, attempt, traceId, structured)
      }

      return {
        verdict: structured.verdict,
        summary: typeof structured.summary === 'string' ? clip(structured.summary, 400) : '',
        findings: written.findings,
        rejectTarget: typeof structured.rejectTarget === 'string' ? structured.rejectTarget : undefined,
        rejectReason: typeof structured.rejectReason === 'string' ? structured.rejectReason : undefined,
        artifactPaths: written.paths,
        acceptance: written.acceptance,
        tests: written.tests,
        checks: written.checks,
        evidence: written.evidence,
        membersPartial,
      }
    } catch (error) {
      // 失败也要给已登记的成员收尾，避免 member/start 悬挂。
      await this.flushEvents().catch(() => {})
      await this._closeMembers(runId, node, attempt, traceId).catch(() => {})
      throw error
    } finally {
      clearTimeout(timer)
      // 06 §16：会话句柄**不在这里** dispose（节点可能被二次激活）。
      // 统一由 run 收尾的 _disposeRunSessions() 释放，stop 也走同一条路径。
      timeoutController.abort()
    }
  }

  /** 桩的合成用量与 skill/load。 */
  async _writeStubEvidence(runId, node, attempt, traceId) {
    const events = []
    if (Array.isArray(node.skills)) {
      for (const name of node.skills.filter(item => typeof item === 'string' && item.trim() !== '').slice(0, 12)) {
        events.push({
          kind: 'skill/load',
          nodeId: node.id,
          attemptId: attempt,
          traceId,
          data: { skill: clip(name, 128), ok: true },
        })
      }
    }
    events.push({
      kind: 'model/call',
      nodeId: node.id,
      attemptId: attempt,
      traceId,
      data: {
        provider: 'stub',
        model: 'stub-model',
        callId: clip(`stub:${node.id}:${attempt}`, 128),
        usage: { ...STUB_USAGE },
      },
    })
    await this._append(runId, events)
  }

  /** 可选注入：从外部读取会话用量。 */
  async _collectUsageFromReader(runId, node, attempt, traceId, structured) {
    try {
      const rows = await this.readUsage({ nodeId: node.id, attemptId: attempt, runId, structured })
      if (!Array.isArray(rows)) return
      const events = []
      for (let index = 0; index < rows.length && index < 200; index += 1) {
        const row = rows[index]
        if (!isPlainObject(row) || !isPlainObject(row.usage)) continue
        const usage = mapHostUsage(row.usage)
        if (!usage) continue
        events.push({
          kind: 'model/call',
          nodeId: node.id,
          attemptId: attempt,
          traceId,
          ...(typeof row.memberId === 'string' ? { memberId: row.memberId } : {}),
          data: {
            provider: typeof row.provider === 'string' && row.provider !== '' ? clip(row.provider, 128) : 'unknown',
            model: typeof row.model === 'string' && row.model !== '' ? clip(row.model, 128) : 'unknown',
            callId: clip(typeof row.callId === 'string' && row.callId !== '' ? row.callId : `${node.id}:${attempt}:${index}`, 128),
            usage,
          },
        })
      }
      if (events.length > 0) await this._append(runId, events)
    } catch (error) {
      this.log('warn', `flow-studio: readUsage 失败（${node.id}#${attempt}）：${error.message}`)
    }
  }

  // -- 结构化产物落盘 -----------------------------------------------------

  /**
   * 校验模型给的证据引用（06 §13.7 m7 / §8.4 v1.3）。
   *
   * 模型可以在 acceptance[].evidenceRef / checks.reportRef / tests.reportRef 里引用
   * **上游节点产物**（跨节点引用在聚合层算 peer，才算独立复核）。但模型输出不可信，
   * 宿主按下面顺序逐条校验，任何一步失败都退回引擎自己落盘的那份报告，并在事件
   * `extra` 里留可读原因（runlog 只保留 data 白名单字段，未知 data 字段会被丢掉，
   * 所以拒绝标记放 `extra`，字段名 evidenceRefRejected / reportRefRejected）：
   *
   *   1. 必须是 run 目录内的安全相对路径（isSafeRelPath，拒绝绝对路径 / `..` / 空段）；
   *   2. 必须对应本 run 的一条 artifact/write（路径在内存索引里，带写入时的 sha256）；
   *   3. resolve 后仍必须在 run 目录内（双保险，防软链 / 拼接绕过）；
   *   4. 文件必须真实存在（lstat 普通文件）；
   *   5. 文件内容的 sha256 必须与 artifact/write 记录一致（不信任模型，也不信任事后改盘）。
   *
   * @param {string} runId
   * @param {unknown} candidate 模型给的引用（可为空）
   * @param {string|undefined} fallbackPath 校验失败时退回的引擎报告路径
   * @param {Map<string, {path?: string, rejected?: string}>} [cache] 同节点内按引用去重
   * @returns {Promise<{ path?: string, rejected?: string }>}
   */
  async _resolveEvidenceRef(runId, candidate, fallbackPath, cache = new Map()) {
    if (typeof candidate !== 'string' || candidate.trim() === '') return { path: fallbackPath }
    const ref = candidate.trim()
    if (cache.has(ref)) {
      const hit = cache.get(ref)
      return hit.path ? hit : { path: fallbackPath, rejected: hit.rejected }
    }
    const reject = reason => {
      const result = { rejected: clip(`引用「${ref}」：${reason}`, 200) }
      cache.set(ref, result)
      return { path: fallbackPath, rejected: result.rejected }
    }
    if (!isSafeRelPath(ref)) return reject('不是 run 目录内的安全相对路径')
    const entry = this.artifactIndex.get(ref)
    if (!entry) return reject('没有对应的 artifact/write 事件')
    const runRootAbs = resolve(this.runsRoot, runId)
    const abs = resolve(runRootAbs, ref)
    if (abs !== runRootAbs && !abs.startsWith(`${runRootAbs}${sep}`)) return reject('路径跑出了 run 目录')
    try {
      const info = await lstat(abs)
      if (!info.isFile()) return reject('文件不存在')
      const body = await readFile(abs)
      const sha256 = createHash('sha256').update(body).digest('hex')
      if (sha256 !== entry.sha256) return reject('文件内容与 artifact/write.sha256 不符')
    } catch {
      return reject('文件不存在')
    }
    const result = { path: ref }
    cache.set(ref, result)
    return result
  }

  async _writeStructured(runId, node, attempt, traceId, structured, stageTotal) {
    const paths = []
    const usedNames = new Set()

    const addArtifact = async (name, content) => {
      let filename = safeArtifactName(name, usedNames.size)
      if (usedNames.has(filename)) {
        const dot = filename.lastIndexOf('.')
        const ext = dot > 0 ? filename.slice(dot) : ''
        const stem = dot > 0 ? filename.slice(0, dot) : filename
        let index = 2
        while (usedNames.has(`${stem}-${index}${ext}`)) index += 1
        filename = `${stem}-${index}${ext}`
      }
      usedNames.add(filename)
      const written = await this._writeArtifactFile(runId, node.id, attempt, filename, content, traceId)
      paths.push(written.path)
      return written
    }

    // 06 §13.7/§13.9：先把证据结构校验完（非法 severity/status、id 重复、tests 不自洽）
    // 再落盘产物，避免「坏输出」留下半套证据文件。
    const findings = normalizeFindings(structured.findings, node.id)
    const checks = normalizeChecks(structured.checks, node.id)
    const acceptance = normalizeAcceptance(structured.acceptance, node.id, this.now())
    const tests = normalizeTests(structured.tests, node.id)

    if (Array.isArray(structured.artifacts)) {
      for (const artifact of structured.artifacts.slice(0, 20)) {
        if (!isPlainObject(artifact)) continue
        const content = typeof artifact.content === 'string' ? artifact.content : String(artifact.content ?? '')
        await addArtifact(artifact.name, content)
      }
    }

    for (const finding of findings) {
      await this._append(runId, [{
        kind: 'review/finding',
        nodeId: node.id,
        attemptId: attempt,
        traceId,
        data: finding,
      }])
    }
    await this._append(runId, [{
      kind: 'review/verdict',
      nodeId: node.id,
      attemptId: attempt,
      traceId,
      data: {
        verdict: structured.verdict === 'pass' ? 'approve' : 'reject',
        findingCount: findings.length,
      },
    }])

    if (checks) {
      const report = await addArtifact('checks-report.json', `${JSON.stringify({ nodeId: node.id, attempt, checks }, null, 2)}\n`)
      // 模型给的 reportRef 只是候选；校验通过才采用（可指向上游产物 = peer 证据），
      // 否则退回引擎刚写的 checks-report.json。checks-report.json 本身永远保留（审计）。
      const resolved = await this._resolveEvidenceRef(runId, checks.reportRef, report.path)
      checks.reportRef = resolved.path
      if (resolved.rejected) checks.reportRefRejected = resolved.rejected
      checks.executedAt = isoOf(this.now())
      await this._append(runId, [{
        kind: 'check/form',
        nodeId: node.id,
        attemptId: attempt,
        traceId,
        // 06 §13.7：模型自述证据必须自带 provenance，聚合层才会做 artifact 对账。
        extra: {
          provenance: this.stub ? 'stub-synthetic' : 'model-claim',
          // runlog 的 data 白名单会丢弃未知字段，拒绝原因放 extra 才留得住。
          ...(resolved.rejected ? { reportRefRejected: resolved.rejected } : {}),
        },
        data: checks,
      }])
    }

    if (acceptance.length > 0) {
      const report = await addArtifact('acceptance.json', `${JSON.stringify({ nodeId: node.id, attempt, acceptance }, null, 2)}\n`)
      const verifiedRefs = new Map()
      for (const item of acceptance) {
        const resolved = await this._resolveEvidenceRef(runId, item.evidenceRef, report.path, verifiedRefs)
        item.evidenceRef = resolved.path
        if (resolved.rejected) item.evidenceRefRejected = resolved.rejected
        await this._append(runId, [{
          kind: 'acceptance/verdict',
          nodeId: node.id,
          attemptId: attempt,
          traceId,
          extra: {
            provenance: this.stub ? 'stub-synthetic' : 'model-claim',
            ...(resolved.rejected ? { evidenceRefRejected: resolved.rejected } : {}),
          },
          data: item,
        }])
      }
    }

    if (tests) {
      const report = tests.executed > 0
        ? await addArtifact('test-report.json', `${JSON.stringify({ nodeId: node.id, attempt, tests }, null, 2)}\n`)
        : null
      const resolved = await this._resolveEvidenceRef(runId, tests.reportRef, report ? report.path : undefined)
      if (resolved.path) tests.reportRef = resolved.path
      else delete tests.reportRef
      if (resolved.rejected) tests.reportRefRejected = resolved.rejected
      await this._append(runId, [{
        kind: 'test/report',
        nodeId: node.id,
        attemptId: attempt,
        traceId,
        extra: {
          provenance: this.stub ? 'stub-synthetic' : 'model-claim',
          ...(resolved.rejected ? { reportRefRejected: resolved.rejected } : {}),
        },
        data: tests,
      }])
    }

    const evidence = {
      acceptance: acceptance.map(item => item.itemId),
      testsSuites: tests ? [tests.suite] : [],
      ruleSetIds: checks ? [checks.ruleSetId] : [],
    }
    const summary = {
      v: 1,
      nodeId: node.id,
      title: node.title || node.id,
      attempt,
      round: this.current ? this.current.round : null,
      verdict: structured.verdict,
      summary: typeof structured.summary === 'string' ? clip(structured.summary, 400) : '',
      artifactPaths: [...paths],
      findings,
      checks: checks || null,
      acceptance,
      tests,
      membersPartial: this._membersPartial(node),
      members: this.current
        ? [...this.current.members.values()].map(member => ({
          memberId: member.memberId,
          sessionId: member.sessionId,
          name: member.name,
          role: member.role,
          model: member.model,
        }))
        : [],
      stageTotal,
      finishedAt: isoOf(this.now()),
    }
    const summaryArtifact = await addArtifact('summary.json', `${JSON.stringify(summary, null, 2)}\n`)
    summary.artifactPaths.push(summaryArtifact.path)
    return {
      paths: summary.artifactPaths,
      summary,
      findings,
      checks,
      acceptance,
      tests,
      evidence,
    }
  }

  /**
   * 写一个产物文件并落 artifact/write 事件。
   * 06 §13.9：单产物 1 MiB、单 run 64 MiB；超限截断，并在事件里标 truncated / originalBytes。
   *
   * 证据独立性（§8.4 v1.3）：这里写的都是**模型结构化输出转写**的产物，属于自证，
   * 不能标 `extra.producer='host'`；宿主自己观测/落盘的产物才打这个标记，本次没有。
   */
  async _writeArtifactFile(runId, nodeId, attempt, filename, content, traceId) {
    const dir = join(this.runsRoot, runId, nodeId, 'artifacts', String(attempt))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})
    const abs = join(dir, filename)
    const text = typeof content === 'string' ? content : String(content ?? '')
    const originalBytes = Buffer.byteLength(text, 'utf8')
    const remainingRunBytes = Math.max(0, this.maxRunArtifactBytes - this.artifactBytes)
    const limit = Math.min(this.maxArtifactBytes, remainingRunBytes)
    let body = text
    let bytes = originalBytes
    let truncated = false
    if (originalBytes > limit) {
      const clipped = clipBytes(text, limit)
      body = clipped.text
      bytes = clipped.bytes
      truncated = true
    }
    this.artifactBytes += bytes
    await writeFile(abs, body, { encoding: 'utf8', mode: 0o600 })
    await chmod(abs, 0o600).catch(() => {})
    const sha256 = createHash('sha256').update(body, 'utf8').digest('hex')
    const rel = `${nodeId}/artifacts/${attempt}/${filename}`
    await this._append(runId, [{
      kind: 'artifact/write',
      nodeId,
      attemptId: attempt,
      traceId,
      data: {
        path: rel,
        bytes,
        kind: artifactKind(filename),
        sha256,
        ...(truncated ? { truncated: true, originalBytes } : {}),
      },
    }])
    // 06 §13.7 m7：记住「本 run 写过哪些产物 + 内容 sha256」，供证据引用校验用。
    // 同一路径重试覆写时以最后一次写入为准（与 runlog.collectArtifactIndex 的 seq 口径一致）。
    this.artifactIndex.set(rel, { nodeId, attemptId: attempt, sha256 })
    return { path: rel, bytes, sha256, truncated, originalBytes }
  }

  // -- 会话事件 → 用量 / 工具 / skill -------------------------------------

  /** ctx.on('session/event') 的处理器；测试也可以直接喂假 session/event。 */
  handleSessionEvent(session, event) {
    const sessionId = session && typeof session.id === 'string' ? session.id : null
    if (!sessionId || !event || typeof event.type !== 'string') return
    // 06 §16：复用会话要靠「最后一条 assistant 消息」拿结构化输出，所以这里先留存原文
    //（有界 LRU；只在本进程内存里，不落盘）。
    if (event.type === 'assistant/message') {
      const rawText = extractAssistantText(event.data && event.data.message)
      if (rawText !== '') this._rememberAssistantRaw(sessionId, rawText)
    }
    let binding = this.sessionBindings.get(sessionId)
    if (!binding) {
      const parentSessionId = session.header && typeof session.header.parentSession === 'string'
        ? session.header.parentSession
        : null
      if (parentSessionId) {
        const parentBinding = this.sessionBindings.get(parentSessionId)
        // 成员自己的子会话不是节点成员：直接忽略，别缓冲成垃圾。
        if (parentBinding && parentBinding.memberId !== null) return
        if (parentBinding) binding = this._bindMember(session, parentSessionId, parentBinding)
      }
    }
    if (!binding) {
      if (this.pendingSessionEvents.length < this.pendingSessionLimit) {
        this.pendingSessionEvents.push({ session, event })
      }
      return
    }
    this._queueSessionEvent(sessionId, binding, event, session)
  }

  /** 06 §16：sessionId → 最近一条 assistant 原文（LRU 64，用于复用会话解析结构化输出）。 */
  _rememberAssistantRaw(sessionId, rawText) {
    const map = this.lastAssistantBySession
    if (map.has(sessionId)) map.delete(sessionId)
    else if (map.size >= ASSISTANT_TEXT_CACHE_MAX) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(sessionId, clipChars(rawText, 20000))
  }

  /** 登记 lead 会话；顺便把缓冲里属于它 / 它子会话的事件补写出去。 */
  bindSession(sessionId, info, options = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const existing = this.sessionBindings.get(sessionId)
    if (existing) {
      if (options.rebind === true) {
        // 06 §16：同一节点会话被二次激活，把因果链改挂到新的 attempt / trace。
        existing.nodeId = info.nodeId
        existing.attemptId = info.attemptId
        existing.memberId = info.memberId ?? null
        existing.traceId = info.traceId
      }
      return
    }
    const binding = {
      sessionId,
      nodeId: info.nodeId,
      attemptId: info.attemptId,
      memberId: info.memberId ?? null,
      traceId: info.traceId,
    }
    this.sessionBindings.set(sessionId, binding)
    this._flushBufferedFor(sessionId)
    // 缓冲里可能已有该 lead 的子会话事件（注入 activate 时首条事件先到）。
    const children = new Set()
    for (const item of this.pendingSessionEvents) {
      const parentSessionId = item.session && item.session.header && item.session.header.parentSession
      if (parentSessionId === sessionId) children.add(item.session.id)
    }
    for (const childId of children) {
      if (this.sessionBindings.has(childId)) continue
      const childItem = this.pendingSessionEvents.find(item => item.session && item.session.id === childId)
      if (!childItem) continue
      const member = this._bindMember(childItem.session, sessionId, binding)
      if (member) this._flushBufferedFor(childId)
    }
  }

  _bindMember(session, parentSessionId, parentBinding) {
    if (!this.current) return null
    // 只认 lead 的直接子会话（parentSessionId === leadSessionId）；成员自己的
    // 孙会话属于成员内部，不再重复记成节点成员。
    if (parentBinding.memberId !== null) return null
    if (this.current.node.id !== parentBinding.nodeId || this.current.attempt !== parentBinding.attemptId) return null
    const sessionId = session && typeof session.id === 'string' ? session.id : null
    if (!sessionId) return null
    const existing = this.sessionBindings.get(sessionId)
    if (existing) return existing
    this.current.memberSeq += 1
    const index = this.current.memberSeq
    const configured = Array.isArray(this.current.node.team) ? this.current.node.team[index - 1] : null
    const memberId = memberIdFor(this.current.node.id, index)
    const binding = {
      sessionId,
      nodeId: parentBinding.nodeId,
      attemptId: parentBinding.attemptId,
      memberId,
      traceId: parentBinding.traceId,
    }
    const member = {
      memberId,
      sessionId,
      name: configured && typeof configured.name === 'string' && configured.name.trim() !== ''
        ? clip(configured.name.trim(), 200)
        : `成员${index}`,
      role: configured && typeof configured.role === 'string' && configured.role.trim() !== ''
        ? clip(configured.role.trim(), 64)
        : undefined,
      model: session.header && typeof session.header.model === 'string' && session.header.model !== ''
        ? clip(session.header.model, 128)
        : undefined,
      startedAt: this.now(),
      // §13.12：先标 starting；member/start 落盘后转 running，节点收尾转 done。
      state: 'starting',
    }
    this.current.members.set(sessionId, member)
    this.sessionBindings.set(sessionId, binding)
    this._syncLiveMembers()
    this._scheduleLivePersist()
    this._queueSessionWrite(async () => {
      await this._append(this.active ? this.active.runId : '', [{
        kind: 'member/start',
        nodeId: binding.nodeId,
        attemptId: binding.attemptId,
        memberId,
        traceId: binding.traceId,
        data: {
          name: member.name,
          ...(member.role ? { role: member.role } : {}),
          ...(member.model ? { model: member.model } : {}),
        },
      }])
      member.state = 'running'
      this._syncLiveMembers()
      this._scheduleLivePersist()
    })
    return binding
  }

  _flushBufferedFor(sessionId) {
    const keep = []
    const replay = []
    for (const item of this.pendingSessionEvents) {
      if (item.session && item.session.id === sessionId) replay.push(item)
      else keep.push(item)
    }
    this.pendingSessionEvents = keep
    for (const item of replay) {
      const binding = this.sessionBindings.get(sessionId)
      if (binding) this._queueSessionEvent(sessionId, binding, item.event, item.session)
    }
  }

  _queueSessionEvent(sessionId, binding, event, session) {
    this._queueSessionWrite(async () => {
      const mapped = this._mapSessionEvent(sessionId, binding, event, session)
      if (!mapped) return
      if (Array.isArray(mapped)) {
        if (mapped.length > 0) await this._append(this.active ? this.active.runId : '', mapped)
      } else {
        await this._append(this.active ? this.active.runId : '', [mapped])
      }
    })
  }

  _queueSessionWrite(task) {
    const next = this.eventQueue.then(task)
    this.eventQueue = next.catch(error => {
      this.log('warn', `flow-studio: 会话事件写入失败：${error.message}`)
    })
  }

  _mapSessionEvent(sessionId, binding, event, session) {
    if (!this.active) return null
    if (event.type === 'assistant/message') {
      const message = event.data && event.data.message
      const source = message && message.source
      const provider = source && typeof source.provider === 'string' && source.provider !== ''
        ? clip(source.provider, 128)
        : null
      const model = source && typeof source.model === 'string' && source.model !== ''
        ? clip(source.model, 128)
        : null
      const out = []

      // 1) 原有口径：有 usage 才写 model/call（token 聚合口径不动）。
      const usage = mapHostUsage(event.data && event.data.usage)
      if (usage) {
        const callId = message && typeof message.id === 'string' && message.id !== ''
          ? clip(message.id, 128)
          : clip(`${sessionId}:${event.seq ?? 0}`, 128)
        const payload = {
          provider: provider || 'unknown',
          model: model || 'unknown',
          callId,
          usage,
        }
        if (message && typeof message.stopReason === 'string' && message.stopReason !== '') {
          payload.stopReason = clip(message.stopReason, 128)
        }
        out.push({
          kind: 'model/call',
          nodeId: binding.nodeId,
          attemptId: binding.attemptId,
          memberId: binding.memberId,
          traceId: binding.traceId,
          data: payload,
        })
      }

      this.liveStateChanged('model')
      if (this.live) this.live.activeMemberId = binding.memberId ?? null

      // 2) §8.2：额外摘出 assistant 可见文本，写 agent/message（脱敏 + 截断 + 同会话去重）。
      const rawText = extractAssistantText(message)
      if (rawText !== '') {
        const clean = redactArguments(rawText)
        if (this.live) {
          this.live.lastMessage = {
            text: clipChars(clean, LIVE_MESSAGE_MAX_CHARS),
            at: isoOf(this.now()),
            memberId: binding.memberId ?? null,
          }
        }
        const clipped = clipAssistantText(clean)
        const hash = createHash('sha256').update(clipped.text, 'utf8').digest('hex')
        if (this.lastAssistantText.get(sessionId) !== hash) {
          this._rememberAssistantText(sessionId, hash)
          out.push({
            kind: 'agent/message',
            nodeId: binding.nodeId,
            attemptId: binding.attemptId,
            memberId: binding.memberId,
            traceId: binding.traceId,
            data: {
              role: 'assistant',
              text: clipped.text,
              truncated: clipped.truncated,
              ...(provider ? { provider } : {}),
              ...(model ? { model } : {}),
            },
          })
        } else {
          // 文本被去重（重放 / 心跳），但 live.lastMessage 可能已刷新，仍需可见。
          this._scheduleLivePersist()
        }
      }
      return out.length > 0 ? out : null
    }

    if (event.type === 'tool/call') {
      const callId = event.data && typeof event.data.callId === 'string' ? event.data.callId : null
      if (!callId) return null
      const name = typeof event.data.name === 'string' ? event.data.name : 'unknown'
      const startedAt = this.now()
      this.pendingToolCalls.set(`${sessionId}\u0000${callId}`, {
        name,
        arguments: typeof event.data.arguments === 'string' ? event.data.arguments : '',
        startedAt: startedAt.getTime(),
        binding,
        sessionId,
      })
      this.liveStateChanged('tool')
      if (this.live) {
        this.live.activeMemberId = binding.memberId ?? null
        // §13.12：工具一开始就让客户端看到「正在跑哪个工具」，不等 tool/result。
        this.live.lastTool = { name: clip(name, 200), startedAt: isoOf(startedAt), ok: null }
        this._scheduleLivePersist()
      }
      return null
    }

    if (event.type === 'tool/result') {
      const message = event.data && event.data.message
      const callId = message && typeof message.toolCallId === 'string'
        ? message.toolCallId
        : (message && message.source && typeof message.source.callId === 'string' ? message.source.callId : null)
      if (!callId) return null
      const key = `${sessionId}\u0000${callId}`
      const pending = this.pendingToolCalls.get(key)
      if (!pending) return null
      this.pendingToolCalls.delete(key)
      const ok = !(message && message.isError === true) && !(event.data && event.data.error)
      const durationMs = Math.max(0, this.now().getTime() - pending.startedAt)
      if (this.live) {
        this.live.activeMemberId = pending.binding.memberId ?? null
        this.live.lastTool = {
          name: clip(pending.name, 200),
          startedAt: isoOf(new Date(pending.startedAt)),
          ok,
        }
      }
      if (pending.name === 'skill') {
        let skill = 'unknown'
        try {
          const parsed = JSON.parse(pending.arguments)
          if (parsed && typeof parsed.name === 'string' && parsed.name.trim() !== '') skill = parsed.name.trim()
        } catch {
          // 参数不是 JSON：skill 名退回 unknown，不丢事件。
        }
        return {
          kind: 'skill/load',
          nodeId: pending.binding.nodeId,
          attemptId: pending.binding.attemptId,
          memberId: pending.binding.memberId,
          traceId: pending.binding.traceId,
          data: { skill: clip(skill, 128), ok },
        }
      }
      return {
        kind: 'tool/call',
        nodeId: pending.binding.nodeId,
        attemptId: pending.binding.attemptId,
        memberId: pending.binding.memberId,
        traceId: pending.binding.traceId,
        data: {
          name: clip(pending.name, 200),
          // 06 §13.9 m3：参数摘要必须脱敏；凭据原文不得进入日志与导出。
          argumentsDigest: clipChars(redactArguments(pending.arguments), 200),
          ok,
          durationMs,
        },
      }
    }
    return null
  }

  /** §8.2：记住会话的上一条文本 hash（LRU，最多 64 个会话，防内存泄漏）。 */
  _rememberAssistantText(sessionId, hash) {
    const map = this.lastAssistantText
    if (map.has(sessionId)) map.delete(sessionId)
    else if (map.size >= ASSISTANT_TEXT_CACHE_MAX) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(sessionId, hash)
  }

  liveStateChanged(phase) {
    if (!this.live) return false
    if (this.live.phase === phase) return false
    this.live.phase = phase
    return true
  }

  // -- 内部事件 / live -----------------------------------------------------

  async _append(runId, events, { live = true } = {}) {
    if (typeof runId !== 'string' || runId === '') throw new Error('_append：runId 为空')
    const normalized = events.map(event => ({
      v: 1,
      ts: isoOf(this.now()),
      runId,
      memberId: null,
      ...event,
    }))
    const result = await appendEvents(this.runsRoot, runId, normalized, { now: this.now() })
    if (live && this.live && this.active && this.active.runId === runId) {
      this.live.lastEventSeq = result.lastSeq
      this.live.currentNodeId = this.current ? this.current.node.id : this.live.currentNodeId
      this.live.attempt = this.current ? this.current.attempt : this.live.attempt
      this.live.round = this.current ? this.current.round : this.live.round
      if (this.current) {
        this.live.nodeTitle = clip(
          String(this.current.node.title || this.current.node.id),
          LIVE_NODE_TITLE_MAX_CHARS,
        )
        this.live.nodeMode = this.current.node.mode === EXEC_MODE.TEAM ? 'team' : 'single'
        this._syncLiveMembers()
      }
      // §13.12：live.tokens 与本 run 已落盘的 model/call 同口径（同 traceId+callId 后到替换）。
      this._accumulateLiveTokens(normalized)
      await this._persistLive()
    }
    return result
  }

  /** 用当前节点的成员表刷新 live.members（≤16 条，只带展示必需字段）。 */
  _syncLiveMembers() {
    if (!this.live) return
    this.live.members = this._liveMemberSnapshots()
  }

  _liveMemberSnapshots() {
    if (!this.current) return []
    const out = []
    for (const member of this.current.members.values()) {
      if (out.length >= LIVE_MEMBERS_MAX) break
      out.push({
        memberId: member.memberId,
        name: clip(member.name, 64),
        ...(member.role ? { role: clip(member.role, 32) } : {}),
        ...(member.model ? { model: clip(member.model, 64) } : {}),
        state: member.state === 'starting' || member.state === 'running' || member.state === 'done'
          ? member.state
          : 'unknown',
      })
    }
    return out
  }

  /** live.tokens 四桶累计：keyed 按「后到整条替换」，unkeyed 逐条累加（与 §3 一致）。 */
  _accumulateLiveTokens(events) {
    if (!this.live || !this.live.tokens) return
    for (const event of events) {
      if (!event || event.kind !== 'model/call') continue
      const data = event.data && typeof event.data === 'object' ? event.data : null
      const usage = data && data.usage
      if (!usage || typeof usage !== 'object') continue
      const next = {
        input: intOr(usage.input),
        cacheRead: intOr(usage.cacheRead),
        cacheWrite: intOr(usage.cacheWrite),
        output: intOr(usage.output),
      }
      const callId = typeof data.callId === 'string' && data.callId !== '' ? data.callId : ''
      const key = callId === '' ? null : `${event.traceId}\u0000${callId}`
      const previous = key ? this.liveUsage.get(key) : null
      for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output']) {
        const delta = next[bucket] - (previous ? previous[bucket] : 0)
        this.live.tokens[bucket] = Math.max(0, (this.live.tokens[bucket] || 0) + delta)
      }
      if (key) this.liveUsage.set(key, next)
    }
  }

  /** 不产生新事件也要让 live 立刻可见（如工具刚开跑）：异步补写 run.json.live。 */
  _scheduleLivePersist() {
    if (!this.live || !this.active) return
    this._persistLive()
  }

  async _setLive(patch) {
    if (!this.live) return
    Object.assign(this.live, patch)
    await this._persistLive()
  }

  async _persistLive() {
    if (!this.active || !this.live) return
    await writeRunMeta(this.runsRoot, this.active.runId, { live: { ...this.live } }).catch(error => {
      this.log('warn', `flow-studio: 写 live 失败：${error.message}`)
    })
    // runstore 的 normalizeMeta 只保留白名单字段，会把 workspace / worktree / sessionMode
    // 丢掉；每次 live 刷新后补写一次，保证运行中读 run.json 也能看到绑定。
    await this._patchRunBinding(this.active.runId)
  }

  /** 团队节点是否缺成员明细：配了 N 个成员但只观察到更少，或一个都没观察到。 */
  _membersPartial(node) {
    if (node.mode !== EXEC_MODE.TEAM) return false
    const observed = this.current ? this.current.members.size : 0
    const expected = Array.isArray(node.team) ? node.team.length : 0
    return expected > 0 ? observed < expected : observed === 0
  }

  /**
   * 给已观察到的成员收尾。
   * 06 §13.10：**不得**由 lead 的 verdict 反推成员 passed/failed——我们观察不到成员
   * 自己上报的结论，只能标 `partial`（宿主 runlog 尚不认识 partial 时宁可不写，也不编造）。
   * 返回值必须与 summary.json / node/end 用的是同一口径（membersPartial）。
   */
  async _closeMembers(runId, node, attempt, traceId) {
    const membersPartial = this._membersPartial(node)
    if (!this.current || this.current.members.size === 0) return membersPartial
    // §13.12：节点收尾一律标 done（即使宿主不支持 member/end，live 也不能停在 running）。
    for (const member of this.current.members.values()) member.state = 'done'
    this._syncLiveMembers()
    if (!supportsPartialMemberStatus()) {
      // 不写 member/end 时也要让 live.members 立刻落到 done。
      await this._persistLive()
      this.log('warn', 'flow-studio: 宿主 runlog 不支持 member/end.status=partial；本轮不写成员结论（不伪造 passed/failed）')
      return membersPartial
    }
    const events = []
    for (const member of this.current.members.values()) {
      events.push({
        kind: 'member/end',
        nodeId: node.id,
        attemptId: attempt,
        memberId: member.memberId,
        traceId,
        data: {
          status: 'partial',
          durationMs: Math.max(0, this.now().getTime() - member.startedAt.getTime()),
        },
      })
    }
    if (events.length > 0) await this._append(runId, events)
    return membersPartial
  }

  _cleanupActive() {
    // 07 §5：没有模块级锁；只释放本实例的占位（一个实例只服务一个 run）。
    this.active = null
    // 06 §15：父会话覆盖只属于刚结束的这一次 start，必须清掉，避免影响下一次 start。
    this.startParent = null
    // 07 §4：per-start 的 cwd / preset 同样只活一次 run。
    this.startCwd = null
    this.startAgentPreset = null
    // 07 §4：工作区 / worktree / sessionMode 只属于刚结束的这次 run。
    this.workspaceRecord = null
    this.worktreeRecord = null
    this.sessionMode = null
    this.live = null
    this.current = null
    this.sessionBindings.clear()
    this.pendingSessionEvents = []
    this.pendingToolCalls.clear()
    this.lastAssistantText.clear()
    this.liveUsage.clear()
    this.artifactIndex.clear()
    // 06 §16：run 级收件箱 / 节点会话运行态归零；跨 run 的 sessionIndex 保留。
    this._resetInboxState()
    this.eventQueue = Promise.resolve()
  }

  /** 注销 session/event 订阅（插件卸载时由 Cordis 作用域自动做，这里给测试/手动用）。 */
  dispose() {
    if (typeof this.unsubscribe === 'function') {
      this.unsubscribe()
      this.unsubscribe = undefined
    }
  }
}

/** 对外类名（07 §8）：`new Engine(options)` 与 `createEngine(options)` 等价。 */
export { FlowEngine as Engine }

/**
 * 输出结构（06 §4.3）。`verdict` 必填；其余字段引擎按存在与否写事件。
 * 用标准 JSON Schema 的子集，DSH 子 agent 的 outputSchema 支持它。
 */
export const ENGINE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['verdict'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'reject'] },
    summary: { type: 'string' },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'content'],
        properties: {
          name: { type: 'string' },
          content: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'severity', 'title', 'status'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2'] },
          title: { type: 'string' },
          status: { type: 'string', enum: ['open', 'accepted', 'fixed', 'verified', 'dismissed'] },
          category: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
    checks: {
      type: 'object',
      properties: {
        ruleSetId: { type: 'string' },
        ruleSetVersion: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        executor: { type: 'string' },
        state: { type: 'string', enum: ['pass', 'fail', 'skipped', 'na'] },
        passedChecks: { type: 'integer' },
        totalChecks: { type: 'integer' },
      },
      additionalProperties: true,
    },
    acceptance: {
      type: 'array',
      items: {
        type: 'object',
        required: ['itemId', 'status', 'decidedBy'],
        properties: {
          itemId: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail', 'skip', 'na'] },
          decidedBy: { type: 'string', enum: ['human', 'auto'] },
        },
        additionalProperties: true,
      },
    },
    tests: {
      type: 'object',
      required: ['suite', 'executed', 'passed', 'failed', 'skipped'],
      properties: {
        suite: { type: 'string' },
        executed: { type: 'integer' },
        passed: { type: 'integer' },
        failed: { type: 'integer' },
        skipped: { type: 'integer' },
        failures: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: true,
    },
    rejectTarget: { type: 'string' },
    rejectReason: { type: 'string' },
  },
  additionalProperties: true,
})
