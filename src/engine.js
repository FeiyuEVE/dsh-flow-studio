/**
 * 执行引擎（Host 半边，v0.4）：把一张流程按 `next` 边真的跑起来。
 *
 * 权威规格：`docs/design/06-execution-engine.md`；事件契约：`docs/design/05-run-log.md`。
 *
 * 设计要点：
 *   - **依赖注入**：唯一模型入口是 `createEngine({ activate, ... })` 里的 `activate`。
 *     没注入时，引擎用 `ctx.subagents.startActivation({ provider:'spawn', delivery:'caller' })`
 *     包一层；引擎不 import 任何 dsh 包。
 *   - **主循环**：run/start → 逐个阶段节点（node/start → 执行 → node/end）→ reject 时
 *     选 reject 边、写 reject/trigger、目标节点 attempt+1 重跑 → run/end。只走 next 边，不并行。
 *   - **单 run 全局锁**：同一时刻只允许一个 run 在跑（`start` 已有运行中 run 时 409）。
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
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { EDGE_KIND, EXEC_MODE, NODE_KIND } from './model.js'
import { checkRunId, normalizeEvent } from './runlog.js'
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
  // 3) key: value / key=value / "key": "value" 形式
  text = text.replace(
    /(["']?(?:token|password|passwd|secret|api[_-]?key|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    (match, prefix, value) => {
      if (/^Bearer$/i.test(String(value).replace(/["']/g, ''))) return match
      return `${prefix}"[REDACTED]"`
    },
  )
  // 4) 超长连续串（哈希 / JWT 片段 / 裸 token）：≥32 个不含空白的可疑字符。
  text = text.replace(/[A-Za-z0-9_+/=.-]{32,}/g, '[REDACTED]')
  return text
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

function upstreamText(upstream) {
  if (!Array.isArray(upstream) || upstream.length === 0) return '（无：这是链路上的第一个阶段节点。）'
  return upstream.map(entry => {
    const paths = Array.isArray(entry.artifactPaths) && entry.artifactPaths.length > 0
      ? entry.artifactPaths.join('、')
      : '（无产物文件）'
    return `- 「${entry.title}」（attempt ${entry.attempt}）：${entry.summary || '（无摘要）'}；产物：${paths}`
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
    '只返回一个 JSON 对象（不要包 Markdown 代码块、不要在 JSON 之外夹带解释），字段如下：',
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
 * @param {{ node: object, attempt: number, upstream?: object[], previous?: object, rejectContext?: object }} input
 */
export function buildPrompt({ node, attempt, upstream = [], previous = null, rejectContext = null }) {
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

  const assemble = () => {
    const sections = [
      section('你是谁', role),
      section('你负责什么', `${task}${team}`),
      section('期望产物', outputs),
      section('必须加载的 skill', skillsText),
      section('上游产物', upstreamBody),
    ]
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
 * 模块级开始锁（06 §13.6 B1）：跨引擎实例共享。
 * `start` 在**第一个 await 之前**同步占位，失败再释放；临界区内重读 run.json 校验。
 */
const START_LOCK = { holder: null }

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
 *   nodeTimeoutMs?: number, staleMs?: number, stub?: boolean,
 *   runTimeoutMs?: number, maxTotalSteps?: number, maxArtifactBytes?: number,
 *   maxRunArtifactBytes?: number, parent?: object, resolveParent?: Function,
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

    if (this.stub) this.activate = null
    else if (typeof options.activate === 'function') this.activate = options.activate
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
    this.sessionBindings = new Map()
    this.pendingSessionEvents = []
    this.pendingSessionLimit = 4000
    this.pendingToolCalls = new Map()
    this.eventQueue = Promise.resolve()

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

  // -- 默认 activate：包 ctx.subagents.startActivation ---------------------

  _subagentService() {
    if (!this.ctx || typeof this.ctx.get !== 'function') return undefined
    return this.ctx.get('subagents')
  }

  async _defaultActivate({ prompt, outputSchema, signal, label, onSession, agentOptions }) {
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
   * 06 §13.6 B1：**第一个 await 之前**同步占位（模块级 `START_LOCK` + `starting`），
   * 失败释放；进入临界区后重读 run.json，确认 `started===false && status==='pending'`。
   * 06 §13.2：真正的 `pending -> running` 由 runstore.startRun() 原子完成（不存在时兜底）。
   * 已有运行中 run → 409；run 不存在 → 404；已开始过 / 流程非法 → 409 / 400。
   */
  async start(runId) {
    if (!checkRunId(runId)) throw new EngineError(400, 'runId 不合法')
    // —— 同步占位：这一行之前不许有任何 await ——
    if (START_LOCK.holder) {
      throw new EngineError(409, `已有运行中的 run（${START_LOCK.holder.runId}），同一时刻只允许一个 run`)
    }
    const controller = new AbortController()
    const active = { runId, flow: null, controller, promise: null, starting: true, engine: this }
    START_LOCK.holder = active
    this.active = active
    this._resetRunState()
    this.live = {
      currentNodeId: null,
      attempt: 0,
      round: 0,
      since: isoOf(this.now()),
      lastEventSeq: 0,
      phase: 'idle',
    }

    let transitioned = false
    try {
      // 临界区内重读：别的实例 / 进程可能刚刚改动过 run.json。
      const meta = await readRunMeta(this.runsRoot, runId)
      if (!meta) throw new EngineError(404, 'run 不存在')
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
    this.maxTotalSteps = this.configuredMaxTotalSteps
    this.sessionBindings.clear()
    this.pendingSessionEvents = []
    this.pendingToolCalls.clear()
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
        })
        await this._append(runId, [this._nodeStartEvent(node, attempt, traceId)])

        let outcome
        try {
          outcome = await this._executeNode(runId, flow, node, attempt, stageTotal, {
            traceId, previous, rejectContext, startedAt, signal,
          })
        } catch (error) {
          const durationMs = Math.max(0, this.now().getTime() - startedAt.getTime())
          const validationError = error instanceof StructuredOutputError ? error.validationError : undefined
          const extra = {
            reason: clip(error.message || String(error), 256),
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
            data: { status: 'failed', durationMs },
            extra,
          }]).catch(() => {})
          this.current = null
          if (this.runTimedOut) throw error
          if (signal.aborted) {
            aborted = true
            break
          }
          throw error
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
              ...(outcome.membersPartial ? { membersPartial: true } : {}),
            },
            ...(outcome.membersPartial ? { extra: { membersPartial: true } } : {}),
          }])
          const choice = selectRejectTarget(flow, node, outcome.rejectTarget)
          if (!choice) {
            throw new Error(`节点「${node.title || node.id}」判定打回，但没有任何 reject 边（无法确定回退目标）`)
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
      await this._append(runId, [{
        kind: 'run/end',
        traceId: runTraceId(runId),
        data: aborted ? { status: 'aborted', reason: '已停止' } : { status: 'done' },
      }])
    } catch (error) {
      const timedOut = this.runTimedOut
      const abortedNow = !timedOut && (signal.aborted || isAbortError(error))
      try {
        await this._append(runId, [{
          kind: 'run/end',
          traceId: runTraceId(runId),
          data: abortedNow
            ? { status: 'aborted', reason: '已停止' }
            : { status: 'failed', reason: clip(error.message || String(error), 2000) },
          ...(abortedNow ? {} : {
            extra: {
              error: clip(error.name || 'Error', 64),
              detail: clip(error.message || String(error), 256),
              ...(this.current ? { nodeId: this.current.node.id, attempt: this.current.attempt } : {}),
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
      if (active.lease && typeof runstoreModule.releaseLease === 'function') {
        await runstoreModule.releaseLease(this.runsRoot, runId).catch(error => {
          this.log('warn', `flow-studio: 释放租约失败（${runId}）：${error.message}`)
        })
      }
      this._cleanupActive()
    }
  }

  _nodeStartEvent(node, attempt, traceId) {
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
      },
    }
  }

  /** 06 §13.5/§13.10：失败收尾时给节点补一条 node/end failed（带 reason）。 */
  async _failNode(runId, node, attempt, traceId, reason, extra = {}) {
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

  /** 执行一个节点：拼提示词 → activate / stub → 校验 → 落产物与证据。 */
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
    const prompt = buildPrompt({
      node,
      attempt,
      upstream,
      previous,
      rejectContext,
    })
    // 06 §13.11 M5：node.model 传给子 agent（注入的 activate 同样能收到 agentOptions）。
    const model = typeof node.model === 'string' && node.model.trim() !== '' ? clip(node.model.trim(), 128) : ''
    const agentOptions = model === '' ? undefined : { model }

    let structuredRaw
    let disposed = null
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
            ...(agentOptions ? { agentOptions } : {}),
          }), combined)
        } catch (error) {
          if (timedOut) throw new NodeTimeoutError(node.id, this.nodeTimeoutMs)
          throw error
        }
        disposed = activation && typeof activation.dispose === 'function' ? activation.dispose : null
        if (activation && typeof activation.sessionId === 'string') {
          this.bindSession(activation.sessionId, { nodeId: node.id, attemptId: attempt, memberId: null, traceId })
        }
        structuredRaw = extractStructured(activation)
      }

      if (timedOut) throw new NodeTimeoutError(node.id, this.nodeTimeoutMs)
      if (signal.aborted) throw abortError(signal)

      const structured = normalizeStructured(structuredRaw)
      await this.flushEvents()
      const written = await this._writeStructured(runId, node, attempt, traceId, structured, stageTotal)
      await this.flushEvents()
      const membersPartial = await this._closeMembers(runId, node, attempt, traceId)

      // readUsage 是可选注入：订阅之外的兜底（同一 traceId+callId 的重复会被聚合替换）。
      if (this.readUsage) await this._collectUsageFromReader(runId, node, attempt, traceId, structured)

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
      if (disposed) {
        try {
          await disposed()
        } catch (error) {
          this.log('warn', `flow-studio: dispose 失败（${node.id}#${attempt}）：${error.message}`)
        }
      }
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
      checks.reportRef = report.path
      checks.executedAt = isoOf(this.now())
      await this._append(runId, [{
        kind: 'check/form',
        nodeId: node.id,
        attemptId: attempt,
        traceId,
        // 06 §13.7：模型自述证据必须自带 provenance，聚合层才会做 artifact 对账。
        extra: { provenance: this.stub ? 'stub-synthetic' : 'model-claim' },
        data: checks,
      }])
    }

    if (acceptance.length > 0) {
      const report = await addArtifact('acceptance.json', `${JSON.stringify({ nodeId: node.id, attempt, acceptance }, null, 2)}\n`)
      for (const item of acceptance) {
        await this._append(runId, [{
          kind: 'acceptance/verdict',
          nodeId: node.id,
          attemptId: attempt,
          traceId,
          extra: { provenance: this.stub ? 'stub-synthetic' : 'model-claim' },
          data: { ...item, evidenceRef: report.path },
        }])
      }
    }

    if (tests) {
      if (tests.executed > 0) {
        const report = await addArtifact('test-report.json', `${JSON.stringify({ nodeId: node.id, attempt, tests }, null, 2)}\n`)
        tests.reportRef = report.path
      }
      await this._append(runId, [{
        kind: 'test/report',
        nodeId: node.id,
        attemptId: attempt,
        traceId,
        extra: { provenance: this.stub ? 'stub-synthetic' : 'model-claim' },
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
    return { path: rel, bytes, sha256, truncated, originalBytes }
  }

  // -- 会话事件 → 用量 / 工具 / skill -------------------------------------

  /** ctx.on('session/event') 的处理器；测试也可以直接喂假 session/event。 */
  handleSessionEvent(session, event) {
    const sessionId = session && typeof session.id === 'string' ? session.id : null
    if (!sessionId || !event || typeof event.type !== 'string') return
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

  /** 登记 lead 会话；顺便把缓冲里属于它 / 它子会话的事件补写出去。 */
  bindSession(sessionId, info) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (this.sessionBindings.has(sessionId)) return
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
    }
    this.current.members.set(sessionId, member)
    this.sessionBindings.set(sessionId, binding)
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
      const usage = mapHostUsage(event.data && event.data.usage)
      if (!usage) return null
      const message = event.data && event.data.message
      const source = message && message.source
      const callId = message && typeof message.id === 'string' && message.id !== ''
        ? clip(message.id, 128)
        : clip(`${sessionId}:${event.seq ?? 0}`, 128)
      this.liveStateChanged('model')
      const payload = {
        provider: source && typeof source.provider === 'string' && source.provider !== '' ? clip(source.provider, 128) : 'unknown',
        model: source && typeof source.model === 'string' && source.model !== '' ? clip(source.model, 128) : 'unknown',
        callId,
        usage,
      }
      if (message && typeof message.stopReason === 'string' && message.stopReason !== '') {
        payload.stopReason = clip(message.stopReason, 128)
      }
      return {
        kind: 'model/call',
        nodeId: binding.nodeId,
        attemptId: binding.attemptId,
        memberId: binding.memberId,
        traceId: binding.traceId,
        data: payload,
      }
    }

    if (event.type === 'tool/call') {
      const callId = event.data && typeof event.data.callId === 'string' ? event.data.callId : null
      if (!callId) return null
      this.pendingToolCalls.set(`${sessionId}\u0000${callId}`, {
        name: typeof event.data.name === 'string' ? event.data.name : 'unknown',
        arguments: typeof event.data.arguments === 'string' ? event.data.arguments : '',
        startedAt: this.now().getTime(),
        binding,
        sessionId,
      })
      this.liveStateChanged('tool')
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
      await this._persistLive()
    }
    return result
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
    if (!supportsPartialMemberStatus()) {
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
    // 06 §13.6：释放模块级开始锁（只释放自己持有的那一把）。
    if (START_LOCK.holder && (START_LOCK.holder === this.active || START_LOCK.holder.engine === this)) {
      START_LOCK.holder = null
    }
    this.active = null
    this.live = null
    this.current = null
    this.sessionBindings.clear()
    this.pendingSessionEvents = []
    this.pendingToolCalls.clear()
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
