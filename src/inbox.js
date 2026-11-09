/**
 * 流程收件箱：外部消息的路由、投递与提示词注入。
 *
 * 06 §16 的口径（与引擎 / HTTP / 模型工具共用同一份实现）：
 *   - 外部消息是 **run 级事实**：入口节点收到后要沿 next 往下游每个阶段节点可见；
 *   - 一个节点只有一个会话：有会话就 followup 注入（活会话）或 resume 后注入（冷会话 /
 *     被压缩过的会话）；没有会话时，pending 的 run 把消息作为启动输入，运行中的 run 入队；
 *   - 回复目标优先级：消息级 reply > run.json.inbox.reply > 未配置（只记 message/out）。
 *
 * 本模块只做**纯函数 + 投递编排**：落盘全部委托给 `runstore.js`，
 * 流程模板读取委托给 `store.js`，不 import engine（避免 engine ↔ inbox 循环依赖）。
 *
 * 安全边界：外部正文**不再静默截断**——≤1200 字全文进提示词；超过就全文落盘
 * （`inbox/<messageId>.md`），事件 / messages.jsonl 只放 ≤2000 字的头部 + `bodyPath`
 * / `bodyChars` 指针；超过硬上限（200000 字）返回可读 400。落盘失败时降级为
 * 「保留可读头部 + warn + 返回体标明未落盘」，绝不吞消息。
 * 回复通道（`reply`）的白名单校验**只在本模块实现一份**，所有入口共用：
 *   - `tokenEnv` 只接受专用前缀 `FLOW_STUDIO_REPLY_TOKEN_*`（大小写敏感，后缀只用
 *     大写字母 / 数字 / 下划线），其它变量名（`DSH_*` / `FLOW_STUDIO_TOKEN` / `PATH`…）
 *     一律拒绝 —— 否则一条流程消息就能把 owner 级令牌当 Bearer 发到外部地址；
 *   - `url` 只允许 `https:`，或回环地址（127.0.0.1 / ::1 / localhost）上的 `http:`，
 *     且禁止带用户名密码（`user:pass@`）；
 *   - 令牌值只以打码形式出现在日志 / 事件 / 错误信息里（`maskSecret` / `redactSecrets`）。
 *
 * @module @feiyueve/dsh-flow-studio/inbox
 */

import { randomUUID } from 'node:crypto'
import { resolve, sep } from 'node:path'

import { EDGE_KIND, NODE_KIND } from './model.js'
import { MESSAGE_BODY_CHARS_MAX, checkRunId, isSafeInboxBodyPath } from './runlog.js'
import { resumeCold } from './resume.js'
import {
  MESSAGE_REPLY_KINDS, RunError, appendEvents, appendRunInputMessages, appendRunMessages,
  normalizeReplyTarget, readNodeSessions, readRunMessages, readRunMeta, updateRunMessageStatus,
  upsertNodeSession, writeRunInboxBody,
} from './runstore.js'
import { readFlow } from './store.js'

/**
 * 回复正文上限（`deliverOutboundReply` 仍按 4000 收口）。
 *
 * 0.11.1 起**不再是入站正文上限**：入站正文改用 {@link MESSAGE_BODY_HARD_MAX_CHARS}
 * （超过阈值落盘）。保留这个导出名只为旧调用方 / 文档兼容。
 */
export const MESSAGE_BODY_MAX_CHARS = 4000
/**
 * 入站正文硬上限（字符，按码点）。超过返回可读 400，绝不静默截断。
 *
 * 与 `runlog.MESSAGE_BODY_CHARS_MAX` 同源（runlog 不能 import inbox，会成环）。
 */
export const MESSAGE_BODY_HARD_MAX_CHARS = MESSAGE_BODY_CHARS_MAX
/** 消息来源标识上限。 */
export const MESSAGE_FROM_MAX_CHARS = 200
/** 写事件时的正文上限（与 runlog.MESSAGE_TEXT_MAX_CHARS 一致）。 */
export const MESSAGE_EVENT_TEXT_MAX_CHARS = 2000
/** 提示词里「外部消息」段的条数 / 单条长度上限（06 §16）。 */
export const PROMPT_INBOX_MAX_MESSAGES = 5
export const PROMPT_INBOX_MESSAGE_MAX_CHARS = 1200
/**
 * 正文超过它就落盘（= 进提示词的 inline 上限，语义统一）。
 *
 * 正好等于 `PROMPT_INBOX_MESSAGE_MAX_CHARS`：≤1200 字的正文全文进提示词，
 * >1200 字落的盘、提示词只放 1200 字头部 + 指针。
 */
export const INBOX_SPILL_THRESHOLD_CHARS = PROMPT_INBOX_MESSAGE_MAX_CHARS
/** 认为「已经投递过」的状态。 */
export const DELIVERED_STATUSES = Object.freeze(['injected', 'resumed', 'delivered'])
/** 回复 HTTP 请求超时（毫秒）。 */
export const REPLY_HTTP_TIMEOUT_MS = 10_000

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 按 Unicode 码点截断。 */
export function clipCodePoints(value, max) {
  const chars = Array.from(String(value ?? ''))
  if (chars.length <= max) return chars.join('')
  if (max <= 1) return chars.slice(0, max).join('')
  return `${chars.slice(0, max - 1).join('')}…`
}

function isoOf(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function logWarn(deps, message) {
  try {
    if (deps && typeof deps.log === 'function') deps.log('warn', message)
  } catch {
    // 日志失败不该影响投递。
  }
}

// ---------------------------------------------------------------------------
// 纯函数：回复通道白名单（所有入口共用同一份实现）
// ---------------------------------------------------------------------------

/** 允许作为 Bearer 来源的环境变量名前缀（专用前缀；别的变量绝不能当令牌用）。 */
export const REPLY_TOKEN_ENV_PREFIX = 'FLOW_STUDIO_REPLY_TOKEN_'

/** 严格形态：前缀大小写敏感，后缀只允许大写字母 / 数字 / 下划线（非空）。 */
const REPLY_TOKEN_ENV_PATTERN = /^FLOW_STUDIO_REPLY_TOKEN_[A-Z0-9_]+$/
const REPLY_TOKEN_ENV_MAX_CHARS = 128
const REPLY_URL_MAX_CHARS = 2048

/** 允许走明文 http 的回环主机名（`new URL().hostname` 形式，IPv6 含方括号）。 */
export const REPLY_LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1', 'localhost'])

const REPLY_TOKEN_ENV_ALLOWED_FORM = `只接受 ${REPLY_TOKEN_ENV_PREFIX}<后缀> 形式的变量名`
  + `（前缀大小写敏感；后缀只用大写字母 / 数字 / 下划线，例如 ${REPLY_TOKEN_ENV_PREFIX}OPS）；`
  + '其它变量（含 DSH_*、FLOW_STUDIO_TOKEN、PATH）一律拒绝'

/** 在错误信息里回显用户输入时先收口：去控制字符、按码点截断。 */
function displayInput(value, max = 64) {
  if (typeof value !== 'string') return String(value)
  const chars = Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, max * 2))
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`
}

/**
 * 令牌值打码：只保留前 2 / 后 2 位与长度；短令牌（≤8）整段隐藏。
 * 任何日志 / 事件 / 返回体要用到令牌值的地方都必须先经过它。
 */
export function maskSecret(value) {
  if (typeof value !== 'string' || value === '') return ''
  const chars = Array.from(value)
  const length = chars.length
  if (length <= 8) return `***（长度 ${length}）`
  return `${chars.slice(0, 2).join('')}***${chars.slice(-2).join('')}（长度 ${length}）`
}

/** 把文本里出现的令牌值替换成打码形式（错误信息兜底，防止上游把令牌带出来）。 */
export function redactSecrets(text, secrets = []) {
  let out = typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text)
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (typeof secret !== 'string' || secret === '') continue
    out = out.split(secret).join(maskSecret(secret))
  }
  return out
}

/**
 * 校验 `tokenEnv`：省略 = 不带令牌（合法）；给了就必须是专用前缀的白名单变量名。
 * @returns {{ ok: true, tokenEnv?: string } | { ok: false, error: string }}
 */
export function validateReplyTokenEnv(value) {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'string') {
    return { ok: false, error: `tokenEnv 必须是环境变量名字符串；${REPLY_TOKEN_ENV_ALLOWED_FORM}` }
  }
  const name = value.trim()
  if (name === '') {
    return { ok: false, error: `tokenEnv 不能为空；${REPLY_TOKEN_ENV_ALLOWED_FORM}` }
  }
  if (name.length > REPLY_TOKEN_ENV_MAX_CHARS) {
    return { ok: false, error: `tokenEnv 超过 ${REPLY_TOKEN_ENV_MAX_CHARS} 字符；${REPLY_TOKEN_ENV_ALLOWED_FORM}` }
  }
  if (!REPLY_TOKEN_ENV_PATTERN.test(name)) {
    return {
      ok: false,
      error: `tokenEnv「${displayInput(name)}」不允许：${REPLY_TOKEN_ENV_ALLOWED_FORM}。`,
    }
  }
  return { ok: true, tokenEnv: name }
}

/** 回环判断：URL hostname 去掉 IPv6 方括号后精确匹配（不做 DNS 解析，避免 TOCTOU）。 */
function isReplyLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  return REPLY_LOOPBACK_HOSTS.includes(host)
}

/**
 * 校验 http 回复的 `url`：只允许 https，或回环地址上的 http；禁止 user:pass@。
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
export function validateReplyUrl(value) {
  const allowed = 'http 回复地址只允许 https，或回环地址（127.0.0.1 / ::1 / localhost）上的 http'
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: `缺少 url：${allowed}。` }
  }
  if (value.length > REPLY_URL_MAX_CHARS) {
    return { ok: false, error: `url 超过 ${REPLY_URL_MAX_CHARS} 字符；${allowed}。` }
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, error: `url 不是合法地址：${allowed}。` }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, error: 'url 不允许带用户名 / 密码（user:pass@）；请改用令牌环境变量或去掉凭据。' }
  }
  if (parsed.protocol === 'https:') return { ok: true, url: parsed.toString() }
  if (parsed.protocol !== 'http:') {
    return { ok: false, error: `url 协议 ${displayInput(parsed.protocol)} 不允许：${allowed}。` }
  }
  if (!isReplyLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      error: `http 只允许回环地址（127.0.0.1 / ::1 / localhost），不接受 ${displayInput(parsed.hostname)}；`
        + '对外地址必须用 https。',
    }
  }
  return { ok: true, url: parsed.toString() }
}

/**
 * 严格版 reply 校验（HTTP 路由 / 模型工具 / 已保存的回复通道**共用这一份**）。
 *
 * - `session` / `none` 沿用 runstore 的归一化口径；
 * - `http` 额外套上 url / tokenEnv 白名单；
 * - 省略（undefined / null）= 未配置回复通道（合法，返回 reply: undefined）。
 *
 * @returns {{ ok: true, reply: object|undefined } | { ok: false, error: string }}
 */
export function validateReplyTargetStrict(raw) {
  if (raw === undefined || raw === null) return { ok: true, reply: undefined }
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'reply 必须是对象（kind 必填：session / http / none）。' }
  }
  if (raw.kind === 'http') {
    const url = validateReplyUrl(raw.url)
    if (!url.ok) return { ok: false, error: url.error }
    const tokenEnv = validateReplyTokenEnv(raw.tokenEnv)
    if (!tokenEnv.ok) return { ok: false, error: tokenEnv.error }
    return {
      ok: true,
      reply: {
        kind: 'http',
        url: url.url,
        ...(tokenEnv.tokenEnv === undefined ? {} : { tokenEnv: tokenEnv.tokenEnv }),
      },
    }
  }
  const normalized = normalizeReplyTarget(raw)
  if (!normalized) {
    return {
      ok: false,
      error: 'reply 不合法（kind 必须是 session / http / none；kind=session 必须给非空 sessionId）。',
    }
  }
  return { ok: true, reply: normalized }
}

// ---------------------------------------------------------------------------
// 纯函数：请求校验
// ---------------------------------------------------------------------------

/**
 * 校验 `{ from, text, nodeId?, reply? }`。
 * @returns {{ ok: true, message: object } | { ok: false, error: string }}
 */
export function validateInboundBody(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: '请求体必须是 JSON 对象' }
  if (typeof raw.from !== 'string' || raw.from.trim() === '') {
    return { ok: false, error: '缺少 from（消息来源标识，必填）' }
  }
  const from = clipCodePoints(raw.from.trim(), MESSAGE_FROM_MAX_CHARS)
  if (typeof raw.text !== 'string' || raw.text.trim() === '') {
    return { ok: false, error: '缺少 text（消息正文，必填）' }
  }
  // 0.11.1：正文不再在这里截断（旧实现按 4000 静默截）。超硬上限给可读错误，
  // 阈值以上的正文交给 deliverInboundMessage 落盘，提示词靠 bodyPath 指回全文。
  const textChars = Array.from(raw.text).length
  if (textChars > MESSAGE_BODY_HARD_MAX_CHARS) {
    return {
      ok: false,
      error: `正文 ${textChars} 字超过上限 ${MESSAGE_BODY_HARD_MAX_CHARS} 字，`
        + '请拆成多条或改用文件（把长内容写成文件后只发摘要 / 路径）',
    }
  }
  const text = raw.text
  let nodeId
  if (raw.nodeId !== undefined && raw.nodeId !== null && raw.nodeId !== '') {
    if (typeof raw.nodeId !== 'string' || !checkRunId(raw.nodeId)) {
      return { ok: false, error: 'nodeId 不合法（只允许字母、数字、点、下划线、连字符）' }
    }
    nodeId = raw.nodeId
  }
  let reply
  if (raw.reply !== undefined && raw.reply !== null) {
    // F1：与 HTTP /inbox、flow_send_message 同一份严格校验（tokenEnv / url 白名单）。
    const checked = validateReplyTargetStrict(raw.reply)
    if (!checked.ok) return { ok: false, error: checked.error }
    reply = checked.reply
  }
  return {
    ok: true,
    message: {
      from,
      text,
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(reply === undefined ? {} : { reply }),
    },
  }
}

/**
 * 校验一个消息级回复目标（HTTP `POST /runs/<id>/inbox` 与 flow_send_message 共用）。
 * 与 `validateReplyTargetStrict` 同一口径，但要求**必须给出**一个目标（省略 → 不合法）。
 * @returns {{ ok: true, reply: object } | { ok: false, error: string }}
 */
export function validateReplyTarget(raw) {
  const checked = validateReplyTargetStrict(raw)
  if (!checked.ok) return checked
  if (!checked.reply) {
    return {
      ok: false,
      error: `reply 不合法（kind 必须是 ${MESSAGE_REPLY_KINDS.join(' / ')}）`,
    }
  }
  return checked
}

// ---------------------------------------------------------------------------
// 纯函数：目标节点路由
// ---------------------------------------------------------------------------

/** 流程里的阶段节点 id 集合。 */
export function stageNodeIds(flow) {
  const set = new Set()
  for (const node of (flow && Array.isArray(flow.nodes) ? flow.nodes : [])) {
    if (node && node.kind === NODE_KIND.STAGE && checkRunId(node.id)) set.add(node.id)
  }
  return set
}

/**
 * 入口节点：开始节点沿 next 边（多出边取与引擎一致的「最左」）走到的第一个阶段节点。
 * @returns {string | null}
 */
export function entryStageNodeId(flow) {
  if (!isPlainObject(flow) || !Array.isArray(flow.nodes)) return null
  const byId = new Map(flow.nodes.map(node => [node.id, node]))
  const starts = flow.nodes.filter(node => node && node.kind === NODE_KIND.START)
  if (starts.length === 0) return null
  const leftmost = nodes => [...nodes].sort((a, b) => {
    const ax = Number.isFinite(a.x) ? a.x : Number.MAX_SAFE_INTEGER
    const bx = Number.isFinite(b.x) ? b.x : Number.MAX_SAFE_INTEGER
    if (ax !== bx) return ax - bx
    const ay = Number.isFinite(a.y) ? a.y : Number.MAX_SAFE_INTEGER
    const by = Number.isFinite(b.y) ? b.y : Number.MAX_SAFE_INTEGER
    if (ay !== by) return ay - by
    return String(a.id).localeCompare(String(b.id))
  })[0]
  let node = leftmost(starts)
  const seen = new Set()
  while (node && !seen.has(node.id)) {
    seen.add(node.id)
    if (node.kind === NODE_KIND.STAGE) return checkRunId(node.id) ? node.id : null
    if (node.kind === NODE_KIND.END) return null
    const edges = (flow.edges || []).filter(edge => edge.from === node.id && edge.kind === EDGE_KIND.NEXT)
    const targets = edges.map(edge => byId.get(edge.to)).filter(Boolean)
    node = targets.length === 0 ? null : leftmost(targets)
  }
  return null
}

/**
 * 06 §16 的目标解析：显式 nodeId > run 当前节点 > pending 时入口节点。
 * @returns {{ ok: true, nodeId: string, via: 'explicit'|'current'|'entry' } | { ok: false, error: string }}
 */
export function resolveTargetNode({ flow, meta, explicitNodeId }) {
  const stages = stageNodeIds(flow)
  if (explicitNodeId !== undefined && explicitNodeId !== null && explicitNodeId !== '') {
    if (typeof explicitNodeId !== 'string' || !checkRunId(explicitNodeId)) {
      return { ok: false, error: 'nodeId 不合法（只允许字母、数字、点、下划线、连字符）' }
    }
    if (!stages.has(explicitNodeId)) {
      return { ok: false, error: `nodeId「${explicitNodeId}」不是阶段节点（只能是流程里的阶段节点）` }
    }
    return { ok: true, nodeId: explicitNodeId, via: 'explicit' }
  }
  const liveCurrent = meta && meta.live && typeof meta.live.currentNodeId === 'string'
    ? meta.live.currentNodeId
    : null
  const running = meta && (meta.status === 'running' || meta.started === true)
  if (running && liveCurrent && stages.has(liveCurrent)) {
    return { ok: true, nodeId: liveCurrent, via: 'current' }
  }
  const entry = entryStageNodeId(flow)
  if (!entry) return { ok: false, error: '流程里没有可投递的阶段节点（开始节点没有走到阶段节点的 next 出边）' }
  return { ok: true, nodeId: entry, via: 'entry' }
}

// ---------------------------------------------------------------------------
// 纯函数：提示词段 / 事件 / followup
// ---------------------------------------------------------------------------

/**
 * 0.11.1：长正文的显式指针（提示词 / 活会话注入共用）。
 *
 * 为什么还带绝对路径：节点会话的 cwd 是工作区，不是 run 目录；只给
 * `inbox/m-xxx.md` 模型无从解析。相对路径是落盘事实（事件 / messages.jsonl /
 * run.json.input），绝对路径是「现在就能 read」的可执行指针——两者都由
 * `runsRoot + runId + 校验过的 bodyPath` 拼出，不拼外部输入。
 *
 * @param {{ bodyPath: string, bodyChars?: number, runDir?: string, indent?: string }} input
 */
export function formatInboxBodyPointer({ bodyPath, bodyChars, runDir, indent = '  ' } = {}) {
  const chars = Number.isInteger(bodyChars) && bodyChars > 0 ? bodyChars : null
  const countText = chars === null ? '正文超过内联上限' : `正文共 ${chars} 字`
  let absText = ''
  if (typeof runDir === 'string' && runDir !== '' && isSafeInboxBodyPath(bodyPath)) {
    try {
      const root = resolve(runDir)
      const abs = resolve(root, bodyPath)
      if (abs !== root && abs.startsWith(`${root}${sep}`)) absText = `（绝对路径 ${abs}）`
    } catch {
      // 绝对路径只是便利信息，拼不出来就不给；相对路径与指针仍然生效。
    }
  }
  return `${indent}⚠ ${countText}，此处只放头部；**全文在 ${bodyPath}${absText}，`
    + '必须先用 read 工具读完再作答**'
}

/**
 * 「外部消息」段的一条：带 from / 时间 / 正文。
 *
 * 有 `bodyPath` 时正文只是头部，下一行给「必须读全文」的指针；没有 `bodyPath`
 * 时正文本来就是全文（≤阈值），保持旧格式。`options.runDir` 用来补绝对路径。
 */
export function formatInboxMessageLine(message, note, options = {}) {
  const at = typeof message.ts === 'string' ? message.ts : ''
  const from = typeof message.from === 'string' && message.from !== '' ? message.from : 'unknown'
  const text = clipCodePoints(message.text, PROMPT_INBOX_MESSAGE_MAX_CHARS)
  const head = `- [${at} · ${from}]（${note}）${text}`
  if (typeof message.bodyPath !== 'string' || !isSafeInboxBodyPath(message.bodyPath)) return head
  return `${head}\n${formatInboxBodyPointer({
    bodyPath: message.bodyPath,
    bodyChars: message.bodyChars,
    runDir: options.runDir,
  })}`
}

/**
 * 把「新到的」与「之前已投递、向下游流转的」消息拼成提示词段。
 * 最多 5 条、每条 ≤1200 字头部；没有消息时返回空串（不占提示词预算）。
 *
 * @param {{ fresh?: object[], prior?: object[], runDir?: string }} [input]
 */
export function buildPromptInboxSection({ fresh = [], prior = [], runDir } = {}) {
  const freshShown = Array.isArray(fresh) ? fresh.slice(0, PROMPT_INBOX_MAX_MESSAGES) : []
  const priorShown = Array.isArray(prior) ? prior.slice(-PROMPT_INBOX_MAX_MESSAGES) : []
  const lines = []
  for (const message of freshShown) {
    lines.push(formatInboxMessageLine(message, '来自流程收件箱 · 新到，本节点处理', { runDir }))
  }
  for (const message of priorShown) {
    lines.push(formatInboxMessageLine(message, '来自流程收件箱 · 上游节点已收到', { runDir }))
  }
  if (lines.length === 0) return ''
  const hasPointer = [...freshShown, ...priorShown]
    .some(message => message && typeof message.bodyPath === 'string' && isSafeInboxBodyPath(message.bodyPath))
  const intro = hasPointer
    ? '以下消息由外部发进本流程的收件箱（按到达时间排序；带「全文在 …」的消息只放了头部，'
      + '必须先用 read 工具读完全文再作答）。'
    : '以下消息由外部发进本流程的收件箱（按到达时间排序；单条正文即全文）。'
  return [intro, ...lines].join('\n')
}

/**
 * 从收件箱记录里挑出本节点要看的消息：
 *   fresh —— 目标就是本节点、还没投递的；
 *   prior —— 之前已投递过的（入口节点收到的消息在后续节点继续可见）。
 */
export function selectPromptMessages(messages, nodeId) {
  const inbound = (Array.isArray(messages) ? messages : []).filter(item => item && item.direction === 'in')
  const fresh = inbound
    .filter(item => item.status === 'pending' && item.targetNodeId === nodeId)
    .slice(0, PROMPT_INBOX_MAX_MESSAGES)
  const freshIds = new Set(fresh.map(item => item.id))
  const prior = inbound
    .filter(item => !freshIds.has(item.id) && DELIVERED_STATUSES.includes(item.status))
    .slice(-PROMPT_INBOX_MAX_MESSAGES)
  return { fresh, prior }
}

/** 投递到会话时用的 followup payload（角色是 user，来源标成 flow-studio）。 */
export function buildFollowupPayload({ text, runId, nodeId, from = 'flow-studio' }) {
  return {
    id: `flow-${String(runId).slice(0, 40)}-${String(nodeId || 'run').slice(0, 32)}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    role: 'user',
    source: {
      kind: 'flow-studio',
      room: `${runId}${nodeId ? `/${nodeId}` : ''}`,
      from,
      at: new Date().toISOString(),
    },
    content: [{ type: 'text', text }],
  }
}

/**
 * 外部消息投进会话时的正文（带来源标记，避免模型误以为是用户当前轮输入）。
 *
 * 0.11.1：长正文已落盘时，注入文本同样给「必须读全文」的指针——否则活会话里的
 * 节点也会把头部当成全文（这正是设计 run 误判「原文不完整」的原因）。
 */
export function inboundSessionText({ from, text, bodyPath, bodyChars, runDir } = {}) {
  const head = `[流程收件箱 · 来自 ${clipCodePoints(from, MESSAGE_FROM_MAX_CHARS)}]`
  const body = clipCodePoints(text, MESSAGE_BODY_HARD_MAX_CHARS)
  if (typeof bodyPath !== 'string' || !isSafeInboxBodyPath(bodyPath)) return `${head}\n${body}`
  return `${head}\n${body}\n${formatInboxBodyPointer({ bodyPath, bodyChars, runDir })}`
}

/** 回复正文的前缀：告诉接收方这条消息来自哪个流程 / 哪个节点。 */
export function replyMarker({ flowName, nodeTitle }) {
  const flow = clipCodePoints(flowName || '未命名流程', 80)
  const node = clipCodePoints(nodeTitle || '未知节点', 80)
  return `[flow:${flow} · ${node}]`
}

/** 构造 run 级 `message/in` 事件（字段与 runlog 白名单一致）。 */
export function buildMessageInEvent({
  id, from, text, targetNodeId, replyKind, bodyPath, bodyChars,
}, { traceId } = {}) {
  const safeBodyPath = typeof bodyPath === 'string' && isSafeInboxBodyPath(bodyPath) ? bodyPath : null
  return {
    v: 1,
    kind: 'message/in',
    ...(traceId ? { traceId } : {}),
    data: {
      id: String(id),
      from: clipCodePoints(from, MESSAGE_FROM_MAX_CHARS),
      text: clipCodePoints(text, MESSAGE_EVENT_TEXT_MAX_CHARS),
      ...(targetNodeId ? { targetNodeId } : {}),
      ...(replyKind ? { replyKind } : {}),
      ...(safeBodyPath ? { bodyPath: safeBodyPath } : {}),
      ...(safeBodyPath && Number.isInteger(bodyChars) && bodyChars > 0 ? { bodyChars } : {}),
    },
  }
}

/** 构造 run 级 `message/out` 事件（字段与 runlog 白名单一致）。 */
export function buildMessageOutEvent({ id, inReplyTo, text, nodeId, delivery }, { traceId } = {}) {
  return {
    v: 1,
    kind: 'message/out',
    ...(traceId ? { traceId } : {}),
    data: {
      id: String(id),
      ...(inReplyTo ? { inReplyTo: String(inReplyTo) } : {}),
      text: clipCodePoints(text, MESSAGE_EVENT_TEXT_MAX_CHARS),
      ...(nodeId ? { nodeId } : {}),
      delivery,
    },
  }
}

// ---------------------------------------------------------------------------
// 投递编排（HTTP 路由与 flow_* 工具共用）
// ---------------------------------------------------------------------------

/** 从 deps（路由 env 或工具 deps）里取 agents 服务；取不到返回 undefined。 */
export function agentsOf(deps) {
  const ctx = (deps && deps.ctx) || (deps && deps.engine && deps.engine.ctx) || null
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get('agents')
      if (service) return service
    }
    return ctx.agents
  } catch {
    return undefined
  }
}

function agentsUsable(agents) {
  return Boolean(agents && (typeof agents.get === 'function' || typeof agents.resume === 'function'))
}

/** 冷会话 resume 时给一个可用的默认模型（取不到就用宿主默认）。 */
export function defaultAgentSelection(ctx) {
  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
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
 * 把一段文本投进一个已存在的会话：活会话直接 followup，冷会话先 resume。
 * 返回 `{ mode, sessionId }`；不可用时抛 RunError(503)。
 *
 * P0（0.12.1）：冷会话 resume 必须带 `setup`，否则宿主不会挂 agent preset 组合，
 * 恢复出来的会话只剩宿主层插件工具（bash/read/write 全部 missing）。`ctx` 由调用方
 * 从 deps 里穿进来（本函数只做投递，不持有宿主上下文）。
 */
export async function deliverToAgentSession(
  agents, sessionId, text, { runId, nodeId, from, agentOptions, ctx, log } = {},
) {
  if (!agentsUsable(agents)) {
    throw new RunError(503, 'agents', 'agents 服务不可用：无法向已有会话注入消息')
  }
  let agent = null
  let mode = 'injected'
  try {
    if (typeof agents.get === 'function') agent = agents.get(sessionId) || null
  } catch {
    agent = null
  }
  if (!agent) {
    if (typeof agents.resume !== 'function') {
      throw new RunError(503, 'agents', '会话不存在，且 agents.resume 不可用')
    }
    const resumed = await resumeCold(ctx, agents, sessionId, {
      ...(agentOptions ? { agentOptions } : {}),
      log,
    })
    agent = resumed && resumed.agent ? resumed.agent : null
    mode = 'resumed'
  }
  if (!agent || typeof agent.followup !== 'function') {
    throw new RunError(503, 'agents', `会话 ${sessionId} 无法接收消息（agent 不可用或没有 followup）`)
  }
  agent.followup(buildFollowupPayload({ text, runId, nodeId, from }))
  return { mode, sessionId }
}

/** 查节点会话：先问引擎内存，再回 sessions.json。 */
export async function sessionForNode(deps, runId, nodeId) {
  const engine = deps && deps.engine
  if (engine && typeof engine.sessionIdForNode === 'function') {
    try {
      const fromMemory = await engine.sessionIdForNode(runId, nodeId)
      if (typeof fromMemory === 'string' && fromMemory !== '') return fromMemory
    } catch {
      // 内存索引不可用就退回磁盘。
    }
  }
  try {
    const sessions = await readNodeSessions(deps.runsRoot, runId)
    return sessions[nodeId] && typeof sessions[nodeId].sessionId === 'string' ? sessions[nodeId].sessionId : null
  } catch {
    return null
  }
}

async function appendRunLevelEvent(deps, runId, event) {
  try {
    await appendEvents(deps.runsRoot, runId, [event])
    return true
  } catch (error) {
    logWarn(deps, `flow-studio: 写 ${event.kind} 事件失败（${runId}）：${error.message}`)
    return false
  }
}

function messageTraceId(runId) {
  return `tr-${String(runId).slice(0, 80)}-inbox`
}

/** 把入站消息写进 messages.jsonl 与事件流（失败不影响主流程，但会记 warn）。 */
async function recordInbound(deps, runId, record) {
  await appendRunMessages(deps.runsRoot, runId, [record])
  const replyKind = record.reply ? record.reply.kind : undefined
  await appendRunLevelEvent(deps, runId, buildMessageInEvent({
    id: record.id,
    from: record.from,
    text: record.text,
    targetNodeId: record.targetNodeId,
    replyKind,
    bodyPath: record.bodyPath,
    bodyChars: record.bodyChars,
  }, { traceId: messageTraceId(runId) }))
}

/**
 * 外部消息入口（HTTP `POST /runs/<runId>/messages` 与 `flow_send_message` 共用）。
 *
 * 目标节点：显式 nodeId > 运行中当前节点 > pending 时入口节点。
 * 投递四分支：injected（活会话）/ resumed（冷会话）/ started（未开始 → 启动输入）/
 * queued（运行中但节点未到 → 入队，等引擎推进时并入提示词）。
 *
 * @param {{ runsRoot: string, flowsRoot: string, engine?: object, ctx?: object, log?: Function }} deps
 * @returns {Promise<{ ok: true, messageId: string, targetNodeId: string, mode: string, sessionId?: string }>}
 */
export async function deliverInboundMessage(deps, runId, body) {
  if (!deps || typeof deps.runsRoot !== 'string' || deps.runsRoot === '') {
    throw new RunError(500, 'runsRoot', '缺少 runsRoot')
  }
  if (!checkRunId(runId)) throw new RunError(400, 'runId', 'runId 不合法')
  const meta = await readRunMeta(deps.runsRoot, runId)
  if (!meta) throw new RunError(404, 'runId', 'run 不存在')

  const validated = validateInboundBody(body)
  if (!validated.ok) throw new RunError(400, 'body', validated.error)
  const input = validated.message

  let flow = null
  try {
    flow = await readFlow(deps.flowsRoot, meta.flowId)
  } catch {
    flow = null
  }
  if (!flow) throw new RunError(404, 'flowId', 'run 使用的流程模板不存在，无法确定目标节点')

  const target = resolveTargetNode({ flow, meta, explicitNodeId: input.nodeId })
  if (!target.ok) throw new RunError(400, 'nodeId', target.error)
  // 终态 run 不再接收新消息（有会话也不行：run 已经结束，注入没有执行上下文）。
  if (meta.status === 'done' || meta.status === 'failed' || meta.status === 'aborted') {
    throw new RunError(409, 'runId', `run 已结束（${meta.status}），无法再投递消息`)
  }

  const messageId = `m-${randomUUID()}`
  const createdAt = isoOf(new Date())
  const runDir = resolve(deps.runsRoot, runId)
  const bodyChars = Array.from(input.text).length

  // 0.11.1：长正文全文落盘，事件 / messages.jsonl / run.json.input 只放头部。
  // 落盘失败**不丢消息**：降级为「保留可读头部 + warn」，返回体带 bodySpillError。
  let bodyPath
  let bodySpillError
  let storedText = input.text
  if (bodyChars > INBOX_SPILL_THRESHOLD_CHARS) {
    try {
      const written = await writeRunInboxBody(deps.runsRoot, runId, messageId, input.text)
      bodyPath = written.path
      storedText = clipCodePoints(input.text, INBOX_SPILL_THRESHOLD_CHARS)
    } catch (error) {
      const reason = error && error.message ? error.message : '写入失败'
      bodySpillError = `正文 ${bodyChars} 字未落盘（${reason}）；本次只保留前 ${MESSAGE_EVENT_TEXT_MAX_CHARS} 字`
      logWarn(deps, `flow-studio: ${bodySpillError}（${runId}/${messageId}）`)
      storedText = clipCodePoints(input.text, MESSAGE_EVENT_TEXT_MAX_CHARS)
    }
  }
  const spillFields = {
    ...(bodyPath ? { bodyPath, bodyChars } : {}),
    ...(bodySpillError ? { bodySpillError } : {}),
  }

  const record = {
    v: 1,
    id: messageId,
    direction: 'in',
    ts: createdAt,
    from: input.from,
    text: storedText,
    targetNodeId: target.nodeId,
    status: 'pending',
    ...(bodyPath ? { bodyPath, bodyChars } : {}),
    ...(input.reply ? { reply: input.reply, replyKind: input.reply.kind } : {}),
  }

  const sessionId = await sessionForNode(deps, runId, target.nodeId)
  if (sessionId) {
    const agents = agentsOf(deps)
    if (!agentsUsable(agents)) {
      // 06 §16 降级：没有 agents 服务时不能注入，运行中的 run 只能入队；
      // pending 的 run 走启动输入。显式记 warn，避免静默丢消息。
      logWarn(deps, 'flow-studio: 没有可用的 agents 服务，收件箱消息改为入队 / 启动输入')
    } else {
      const sessionText = inboundSessionText({
        from: input.from,
        text: storedText,
        bodyPath,
        bodyChars,
        runDir,
      })
      const delivered = await deliverToAgentSession(agents, sessionId, sessionText, {
        runId,
        nodeId: target.nodeId,
        from: input.from,
        agentOptions: defaultAgentSelection(deps.ctx || (deps.engine && deps.engine.ctx)),
        // P0：冷 resume 的 setup 需要宿主 ctx 才能拿 sessionController / agentPresets。
        ctx: deps.ctx || (deps.engine && deps.engine.ctx),
        log: deps.log,
      })
      record.status = delivered.mode
      record.sessionId = sessionId
      record.mode = delivered.mode
      record.deliveredAt = isoOf(new Date())
      record.deliveredByNodeId = target.nodeId
      await recordInbound(deps, runId, record)
      // 复用会话时刷新 lastUsedAt（失败不影响投递结果）。
      try {
        await upsertNodeSession(deps.runsRoot, runId, target.nodeId, sessionId)
      } catch (error) {
        logWarn(deps, `flow-studio: 刷新 sessions.json 失败（${runId}/${target.nodeId}）：${error.message}`)
      }
      return {
        ok: true,
        messageId,
        targetNodeId: target.nodeId,
        mode: delivered.mode,
        sessionId,
        ...spillFields,
      }
    }
  }

  // 没有会话：pending → 启动输入；running → 入队；终态 → 409。
  if (meta.status === 'done' || meta.status === 'failed' || meta.status === 'aborted') {
    throw new RunError(409, 'runId', `run 已结束（${meta.status}），无法再投递消息`)
  }
  if (meta.status === 'running' || meta.started === true) {
    record.status = 'pending'
    await recordInbound(deps, runId, record)
    return { ok: true, messageId, targetNodeId: target.nodeId, mode: 'queued', ...spillFields }
  }

  record.status = 'pending'
  await recordInbound(deps, runId, record)
  await appendRunInputMessages(deps.runsRoot, runId, [{
    id: messageId,
    from: input.from,
    text: storedText,
    at: createdAt,
    targetNodeId: target.nodeId,
    ...(bodyPath ? { bodyPath, bodyChars } : {}),
  }])
  return { ok: true, messageId, targetNodeId: target.nodeId, mode: 'started', ...spillFields }
}

/**
 * 引擎侧：读取本节点要展示的收件箱消息，并把 fresh 标记为 delivered。
 * 返回提示词段（空串表示没有消息）。
 *
 * @param {{ runsRoot: string }} deps
 * @param {string} runId
 * @param {string} nodeId
 * @param {{ startupMessages?: object[], log?: Function }} options
 */
export async function consumeInboxForNode(deps, runId, nodeId, options = {}) {
  let messages = []
  try {
    const listed = await readRunMessages(deps.runsRoot, runId, { limit: 1000 })
    messages = listed ? listed.messages : []
  } catch (error) {
    logWarn(deps, `flow-studio: 读收件箱失败（${runId}）：${error.message}`)
    return ''
  }
  // run.json.input 里的启动消息可能还没写进 messages.jsonl（旧 run / 手工恢复），按 id 去重补上。
  const known = new Set(messages.filter(item => item && item.direction === 'in').map(item => item.id))
  const startup = Array.isArray(options.startupMessages) ? options.startupMessages : []
  for (const item of startup) {
    if (!item || typeof item.id !== 'string' || known.has(item.id)) continue
    messages.push({
      v: 1,
      id: item.id,
      direction: 'in',
      ts: typeof item.at === 'string' ? item.at : isoOf(new Date()),
      from: typeof item.from === 'string' ? item.from : 'unknown',
      text: typeof item.text === 'string' ? item.text : '',
      targetNodeId: typeof item.targetNodeId === 'string' ? item.targetNodeId : nodeId,
      status: 'pending',
      // 0.11.1：启动输入里的全文指针要透传，否则重启 / 续跑后节点只看得到头部。
      ...(typeof item.bodyPath === 'string' && isSafeInboxBodyPath(item.bodyPath)
        ? {
          bodyPath: item.bodyPath,
          ...(Number.isInteger(item.bodyChars) && item.bodyChars > 0 ? { bodyChars: item.bodyChars } : {}),
        }
        : {}),
    })
  }
  const selected = selectPromptMessages(messages, nodeId)
  const section = buildPromptInboxSection({
    ...selected,
    runDir: resolve(deps.runsRoot, runId),
  })
  // 本节点要处理的消息全部标记 delivered（提示词里只展示前 5 条，其余也已消费）。
  for (const message of messages.filter(item => item.direction === 'in'
    && item.status === 'pending' && item.targetNodeId === nodeId)) {
    try {
      await updateRunMessageStatus(deps.runsRoot, runId, message.id, 'delivered', {
        deliveredAt: isoOf(new Date()),
        deliveredByNodeId: nodeId,
      })
    } catch (error) {
      logWarn(deps, `flow-studio: 标记消息已投递失败（${message.id}）：${error.message}`)
    }
  }
  return section
}

// ---------------------------------------------------------------------------
// 回复投递（flow_reply 与 message/out）
// ---------------------------------------------------------------------------

async function postHttpReply(url, payload, { token, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('回复 HTTP 超时')), REPLY_HTTP_TIMEOUT_MS)
  const onAbort = () => controller.abort(signal && signal.reason)
  if (signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await response.text().catch(() => '')
    return { ok: response.ok, status: response.status, body: clipCodePoints(text, 500) }
  } catch (error) {
    return { ok: false, status: null, error: clipCodePoints(error && error.message ? error.message : String(error), 300) }
  } finally {
    clearTimeout(timer)
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * 节点回复外部消息。回复目标优先级：消息级 reply > run.json.inbox.reply > 未配置。
 * 任何一条回复都会写 message/out 事件；HTTP / 会话投递失败不抛异常，返回值里说明。
 *
 * @param {{ runsRoot: string, flowsRoot: string, engine?: object, ctx?: object, log?: Function }} deps
 * @param {{ runId: string, sessionId?: string, nodeId?: string, text: string, inReplyTo?: string, reply?: object }} input
 */
export async function deliverOutboundReply(deps, input) {
  const runId = input && input.runId
  if (!checkRunId(runId)) throw new RunError(400, 'runId', 'runId 不合法')
  const meta = await readRunMeta(deps.runsRoot, runId)
  if (!meta) throw new RunError(404, 'runId', 'run 不存在')

  // 0.11.1：出站回复同样不再静默截断到 4000——超硬上限直接报可读错误。
  const rawText = typeof input.text === 'string' ? input.text : ''
  const rawChars = Array.from(rawText).length
  if (rawChars > MESSAGE_BODY_HARD_MAX_CHARS) {
    throw new RunError(400, 'text', `回复正文 ${rawChars} 字超过上限 ${MESSAGE_BODY_HARD_MAX_CHARS} 字，请拆成多条`)
  }
  // 不再按 4000 截断：投递用全文（事件侧 message/out 仍按 2000 字留审计，那是展示上限）。
  const text = rawText
  if (text.trim() === '') throw new RunError(400, 'text', '回复正文不能为空')

  let inReplyTo = typeof input.inReplyTo === 'string' && input.inReplyTo !== '' ? input.inReplyTo : undefined
  let target = normalizeReplyTarget(input.reply)
  if (!target && inReplyTo) {
    // 消息级 reply 优先：从收件箱记录里找这条入站消息自己的回复配置。
    const listed = await readRunMessages(deps.runsRoot, runId, { limit: 1000 })
    const source = listed ? listed.messages.find(item => item.id === inReplyTo && item.direction === 'in') : null
    if (!source) throw new RunError(404, 'inReplyTo', '找不到这条入站消息（inReplyTo 无效）')
    target = normalizeReplyTarget(source.reply)
  }
  if (!target) target = normalizeReplyTarget(meta.inbox ? meta.inbox.reply : null)
  // F1：投递前再做一次严格校验（防御旧版本 / 手工改 run.json 写进来的不合规通道）。
  // 不合规直接 400，绝不读取令牌、绝不发请求。
  if (target) {
    const checked = validateReplyTargetStrict(target)
    if (!checked.ok) throw new RunError(400, 'reply', `回复通道不合规：${checked.error}`)
    target = checked.reply
  }

  let flow = null
  try {
    flow = await readFlow(deps.flowsRoot, meta.flowId)
  } catch {
    flow = null
  }
  const nodeId = typeof input.nodeId === 'string' && checkRunId(input.nodeId) ? input.nodeId : undefined
  let nodeTitle = nodeId
  if (flow && Array.isArray(flow.nodes) && nodeId) {
    const node = flow.nodes.find(item => item.id === nodeId)
    if (node && typeof node.title === 'string' && node.title !== '') nodeTitle = node.title
  }
  const marker = replyMarker({ flowName: meta.flowName || meta.flowId, nodeTitle: nodeTitle || '未知节点' })
  const body = `${marker} ${text}`
  const messageId = `o-${randomUUID()}`
  const eventRecord = {
    id: messageId,
    inReplyTo,
    text,
    nodeId,
    delivery: 'local',
  }

  let delivery = 'local'
  let ok = true
  let error
  let httpStatus = null
  let sessionId = target && target.kind === 'session' ? target.sessionId : undefined

  if (target && target.kind === 'session') {
    delivery = 'session'
    const agents = agentsOf(deps)
    try {
      await deliverToAgentSession(agents, target.sessionId, body, {
        runId,
        nodeId,
        from: marker,
        agentOptions: defaultAgentSelection(deps.ctx || (deps.engine && deps.engine.ctx)),
        // P0：同入站投递——冷会话 resume 必须带 setup 才挂得上 preset 组合。
        ctx: deps.ctx || (deps.engine && deps.engine.ctx),
        log: deps.log,
      })
    } catch (failure) {
      ok = false
      error = failure && failure.message ? failure.message : String(failure)
    }
  } else if (target && target.kind === 'http') {
    delivery = 'http'
    let token
    if (target.tokenEnv) {
      try {
        token = process.env[target.tokenEnv]
      } catch {
        token = undefined
      }
    }
    const posted = await postHttpReply(target.url, {
      runId,
      nodeId: nodeId || null,
      messageId: inReplyTo || messageId,
      text: body,
    }, { token, signal: input.signal })
    ok = posted.ok
    httpStatus = posted.status
    // F1：令牌值永远打码——上游（fetch / 代理）若把 Authorization 抄进错误文本，
    // 写进 messages.jsonl / 返回体之前先脱敏。
    if (!posted.ok) error = redactSecrets(posted.error || `HTTP ${posted.status ?? 'error'}`, [token])
  }
  eventRecord.delivery = delivery

  // 先落审计（messages.jsonl + message/out 事件），再返回；投递失败也保留证据。
  try {
    await appendRunMessages(deps.runsRoot, runId, [{
      v: 1,
      id: messageId,
      direction: 'out',
      ts: isoOf(new Date()),
      text: body,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(nodeId ? { nodeId } : {}),
      delivery,
      status: ok ? 'delivered' : 'pending',
      ...(error ? { error } : {}),
    }])
  } catch (writeError) {
    logWarn(deps, `flow-studio: 写回复记录失败（${runId}）：${writeError.message}`)
  }
  await appendRunLevelEvent(deps, runId, buildMessageOutEvent(eventRecord, { traceId: messageTraceId(runId) }))

  const result = {
    ok,
    messageId,
    inReplyTo: inReplyTo || null,
    nodeId: nodeId || null,
    delivery,
    ...(sessionId ? { sessionId } : {}),
    ...(httpStatus === null ? {} : { httpStatus }),
    ...(error ? { error } : {}),
  }
  if (delivery === 'local') {
    result.hint = '没有外部回复通道，已记录在运行日志（reply 未设置或 kind=none）'
  }
  return result
}
