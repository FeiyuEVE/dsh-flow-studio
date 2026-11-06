/**
 * 运行日志抽屉：底部可折叠的 run 列表 / 事件流 / 事件详情。
 *
 * 数据契约见 docs/design/05-run-log.md（§5 接口、§6 客户端）；布局见 DESIGN §7
 * （收起 40px / 展开 200px、最多 2 个自由数字、1Hz 节流）。
 *
 * 三条行为纪律：
 *  1. **收起不轮询**。挂载时取一次列表填 40px 摘要条；只有展开后才每 5s 轮询，
 *     手动刷新再套一层 1Hz 限流（同一秒内的连续点击不重复发请求）。
 *  2. **坏数据不抛错**。Host 没起、run 为空、事件缺字段、usage 缺桶，一律降级成
 *     「未记录 / — / 未识别事件类型」，不允许整块抽屉崩掉。
 *  3. **键盘不抢画布**。事件流是一个 listbox（Tab 进入、↑↓ 选择、Enter 展开），
 *     只吞这四个键；`C` / `Delete` / 方向键等画布快捷键仍归 page.js。
 *
 * @module @feiyueve/dsh-flow-studio/client/logdrawer
 */

import { api, exportUrl } from './api.js'
import { h, rt } from './runtime.js'

/** 收起条高度（DESIGN §7）。 */
export const DRAWER_CLOSED_HEIGHT = 40
/** 展开高度（DESIGN §7）。 */
export const DRAWER_OPEN_HEIGHT = 200
/** 事件流每页条数（05 §5）。 */
export const EVENT_PAGE_SIZE = 200
/** 一次最多取多少条事件；契约上限 1000，用来支撑 200 条/页的前后翻页。 */
export const EVENT_FETCH_LIMIT = 1000
/** 展开后的轮询间隔。 */
export const POLL_MS = 5000

/** 契约里列出的 kind；未知 kind 仍会出现在筛选表里，只是标成「未识别」。 */
export const EVENT_KINDS = [
  'run/start', 'run/end',
  'node/start', 'node/end',
  'member/start', 'member/end',
  'model/call', 'tool/call',
  'skill/load', 'artifact/write',
  'reject/trigger',
  'review/finding', 'review/verdict',
  'check/form',
]

const STATUS_TEXT = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  aborted: '中止',
  pending: '待运行',
  queued: '排队中',
  blocked: '超限',
}

const EVENT_GLYPH = {
  'run/start': '▶',
  'run/end': '■',
  'node/start': '▷',
  'node/end': '◁',
  'member/start': '◇',
  'member/end': '◆',
  'model/call': '≈',
  'tool/call': '⚙',
  'skill/load': '◈',
  'artifact/write': '▣',
  'reject/trigger': '↩',
  'review/finding': '!',
  'review/verdict': '§',
  'check/form': '✓',
}

// ── 小工具 ────────────────────────────────────────────────────────────────

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value, fallback = '') {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return fallback
  return String(value)
}

function num(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * 可缺失的数字：缺失 / 非法返回 null，与 0 严格区分。
 * 用于 Host 返回的 nodeDone / nodeTotal —— 没有记录就是「—」，不许拿 0 顶替。
 */
function optionalNum(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function messageOf(failure) {
  return failure && failure.message ? failure.message : '未知原因'
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 状态 → 中文；未知状态原样显示，不编造。 */
export function statusText(status) {
  const key = text(status).toLowerCase()
  if (key === '') return '状态未知'
  return STATUS_TEXT[key] || text(status)
}

/** 状态 → 色板档（只用于加速识别，文字与形状才是主通道）。 */
export function statusTone(status) {
  const key = text(status).toLowerCase()
  if (key === 'done') return 'success'
  if (key === 'running') return 'business'
  if (key === 'failed') return 'error'
  if (key === 'aborted' || key === 'blocked') return 'warn'
  return 'neutral'
}

/** Ctrl/Cmd+J 是抽屉开合键；Shift/Alt 组合留给浏览器与画布。 */
export function drawerActionFor(event) {
  if (!event || typeof event.key !== 'string') return null
  if (!(event.metaKey || event.ctrlKey)) return null
  if (event.altKey || event.shiftKey) return null
  if (event.repeat === true) return null
  return event.key.toLowerCase() === 'j' ? 'toggle' : null
}

/** 纯开合函数：给出下一步的 open，便于单测状态机。 */
export function nextDrawerOpen(open) {
  return !open
}

// ── 数据归一化（Host 信封变化 / 字段缺失都不抛错）──────────────────────────

/**
 * 把宿主 TokenUsage 的四个互斥桶读成稳定结构。
 * 缺桶按 0 计入合计，同时记在 `missing` 里，UI 用「—」如实显示。
 * `reasoning` 是 output 的子集，不重复加总（05 §3）。
 */
export function readUsage(source) {
  const empty = {
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
    total: 0, recorded: false, missing: ['input', 'cacheRead', 'cacheWrite', 'output'],
  }
  if (source === null || source === undefined || source === '') return empty

  let raw = source
  if (isObject(raw)) {
    if (isObject(raw.usage)) raw = raw.usage
    else if (isObject(raw.data) && isObject(raw.data.usage)) raw = raw.data.usage
  }

  if (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)))) {
    return { ...empty, total: num(raw), recorded: true }
  }
  if (!isObject(raw)) return empty

  const keys = ['input', 'cacheRead', 'cacheWrite', 'output']
  const missing = []
  const values = {}
  for (const key of keys) {
    // 0 是合法读数，只有 null / undefined / 非法值才算「未记录」。
    const value = optionalNum(raw[key])
    if (value === null) missing.push(key)
    values[key] = value === null ? 0 : value
  }

  const present = missing.length < keys.length
  const explicitTotal = optionalNum(raw.total)
  const hasTotal = explicitTotal !== null
  const total = present
    ? values.input + values.cacheRead + values.cacheWrite + values.output
    : (hasTotal ? explicitTotal : 0)

  const reasoning = optionalNum(raw.reasoning)
  return {
    ...values,
    reasoning: reasoning === null ? 0 : reasoning,
    total,
    recorded: present || hasTotal,
    missing: present ? missing : keys.slice(),
  }
}

/** token 数缩写：12.4k / 1.2M；只用 ASCII，避免依赖本地化。 */
export function formatTokens(value) {
  const total = num(value, 0)
  const trim = text => (text.endsWith('.0') ? text.slice(0, -2) : text)
  if (total >= 1000000) return trim((total / 1000000).toFixed(1)) + 'M'
  if (total >= 1000) return trim((total / 1000).toFixed(1)) + 'k'
  return String(Math.round(total))
}

/** 单条 run 的摘要归一化；缺 id/name 也不丢，只是不可选中。 */
export function normalizeRun(raw, index = 0) {
  const source = isObject(raw) ? raw : {}
  const id = text(source.id, text(source.runId, ''))
  const usage = readUsage(source.tokens || source.usage || source.tokenTotal)
  return {
    id,
    name: text(source.name, text(source.title, id || '未命名运行')),
    flowId: text(source.flowId, ''),
    flowName: text(source.flowName, ''),
    status: text(source.status, 'unknown'),
    startedAt: text(source.startedAt, text(source.ts, '')),
    endedAt: text(source.endedAt, ''),
    // nodeDone / nodeTotal 只认 Host 返回值；缺失记 null（UI 显示「—」），
    // 不在客户端用事件推算，避免和 Host 的 progress 口径打架（05 §8.3）。
    nodeDone: optionalNum(source.nodeDone),
    nodeTotal: optionalNum(source.nodeTotal) !== null
      ? optionalNum(source.nodeTotal)
      : optionalNum(source.totalNodes),
    tokenTotal: num(source.tokenTotal, usage.total),
    hasTokenTotal: source.tokenTotal !== undefined && source.tokenTotal !== null,
    tokens: isObject(source.tokens) ? source.tokens : null,
    conclusion: source.conclusion,
    index,
  }
}

/**
 * 阶段进度文案：一律取 Host 的 nodeDone / nodeTotal，缺失显示「—」。
 * 不做客户端推算（Host 的 progress 按打回失效，口径见 05 §8.3）。
 */
export function nodeProgressText(run) {
  const done = optionalNum(run && run.nodeDone)
  const total = optionalNum(run && run.nodeTotal)
  if (done === null && total === null) return '—'
  return (done === null ? '—' : String(done)) + '/' + (total === null ? '—' : String(total))
}

/** 兼容 `{runs}` / `{items}` / `{list}` / `{data:{runs}}` / 裸数组。 */
export function normalizeRuns(payload) {
  if (Array.isArray(payload)) return payload.filter(isObject).map(normalizeRun)
  if (!isObject(payload)) return []
  for (const key of ['runs', 'items', 'list']) {
    if (Array.isArray(payload[key])) return payload[key].filter(isObject).map(normalizeRun)
  }
  if (isObject(payload.data)) return normalizeRuns(payload.data)
  return []
}

/** 兼容 `{events,total,truncated}` / `{data:{events}}` / 裸数组。 */
export function normalizeEvents(payload) {
  if (Array.isArray(payload)) {
    const events = payload.filter(isObject)
    return { events, total: events.length, truncated: false }
  }
  if (!isObject(payload)) return { events: [], total: 0, truncated: false }
  if (isObject(payload.data) && !Array.isArray(payload.events)) return normalizeEvents(payload.data)
  const events = Array.isArray(payload.events) ? payload.events.filter(isObject) : []
  return {
    events,
    total: num(payload.total, events.length),
    truncated: payload.truncated === true,
  }
}

/** 时间倒序；ts 坏掉的排到最后但保留原始顺序（稳定排序）。 */
export function sortEventsDesc(events) {
  const list = Array.isArray(events) ? events : []
  return list
    .map((event, index) => ({ event, index, at: Date.parse(text(event.ts, '')) }))
    .sort((a, b) => {
      const left = Number.isFinite(a.at) ? a.at : -1
      const right = Number.isFinite(b.at) ? b.at : -1
      if (left !== right) return right - left
      return a.index - b.index
    })
    .map(item => item.event)
}

/** 节点 / kind 过滤；空值 = 全放行。 */
export function filterEvents(events, filters) {
  const list = Array.isArray(events) ? events : []
  const nodeId = text(filters && filters.nodeId, '')
  const kind = text(filters && filters.kind, '')
  return list.filter(event => {
    if (nodeId !== '' && text(event.nodeId, '') !== nodeId) return false
    if (kind !== '' && text(event.kind, '') !== kind) return false
    return true
  })
}

/** 客户端分页：页码越界自动夹回，返回当前页与总页数。 */
export function pageSlice(items, page, size = EVENT_PAGE_SIZE) {
  const list = Array.isArray(items) ? items : []
  const sizeValue = Math.max(1, Math.floor(num(size, EVENT_PAGE_SIZE)))
  const pageCount = Math.max(1, Math.ceil(list.length / sizeValue))
  const current = Math.min(pageCount, Math.max(1, Math.floor(num(page, 1))))
  const start = (current - 1) * sizeValue
  return {
    items: list.slice(start, start + sizeValue),
    page: current,
    pageCount,
    total: list.length,
  }
}

/**
 * 事件计数文案（05 §8.6 / 审核 m4）：
 * - 数据只来自最近 `loadedCount` 条时，必须写明「基于最近 N 条（截断）」；
 * - 过滤生效时，分母用过滤后的长度，不拿全 run 的 total 冒充同一口径。
 */
export function eventCountText(context = {}) {
  const filtered = Math.max(0, Math.floor(num(context.filteredCount, 0)))
  const loaded = Math.max(filtered, Math.floor(num(context.loadedCount, filtered)))
  const total = Math.max(loaded, Math.floor(num(context.total, loaded)))
  const filterActive = context.filterActive === true
  const denominator = filterActive ? filtered : total
  const parts = [(filterActive ? '筛出 ' : '') + filtered + ' / ' + denominator + ' 条']
  if (context.truncated === true) {
    parts.push('基于最近 ' + loaded + ' 条（截断）')
  }
  return parts.join(' · ')
}

/** ↑↓ 移动时夹在两端，不环绕（列表短时不会突然跳回顶部）。 */
export function moveIndex(current, delta, length) {
  const count = Math.max(0, Math.floor(num(length, 0)))
  if (count === 0) return 0
  const next = Math.floor(num(current, 0)) + Math.floor(num(delta, 0))
  return Math.min(count - 1, Math.max(0, next))
}

/** 事件稳定键：轮询刷新后仍能保持详情选中。 */
export function eventKey(event) {
  if (!isObject(event)) return ''
  if (event.attemptId !== undefined || event.seq !== undefined) {
    return 'a' + text(event.attemptId, '0') + '#' + text(event.seq, '0')
  }
  return [event.ts, event.kind, event.nodeId, event.traceId].map(value => text(value, '')).join('|')
}

/** 时间格式：本地时区，缺失时原样或「—」。 */
export function formatEventTime(ts) {
  const raw = text(ts, '')
  if (raw === '') return '—'
  const time = Date.parse(raw)
  if (!Number.isFinite(time)) return raw
  const date = new Date(time)
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
}

function formatDuration(value) {
  if (value === null || value === undefined || value === '') return ''
  const ms = num(value, -1)
  if (ms < 0) return ''
  if (ms < 1000) return String(Math.round(ms)) + 'ms'
  return (ms / 1000).toFixed(1) + 's'
}

/** 事件一行摘要：只读 data 里已知字段，未知 kind 明确写「未识别」。 */
export function eventSummary(event) {
  if (!isObject(event)) return '未识别事件类型'
  const data = isObject(event.data) ? event.data : {}
  const parts = []
  switch (event.kind) {
    case 'run/start':
      parts.push('流程 ' + (text(data.flowName, text(data.flowId, '未知流程'))))
      if (data.nodeTotal !== undefined) parts.push(num(data.nodeTotal) + ' 个阶段')
      break
    case 'run/end':
      parts.push('状态 ' + statusText(data.status))
      if (data.reason) parts.push(text(data.reason))
      break
    case 'node/start':
      parts.push(text(data.title, text(event.nodeId, '节点')) + ' 开始')
      if (data.mode) parts.push(text(data.mode))
      break
    case 'node/end':
      parts.push('节点 ' + statusText(data.status))
      if (data.durationMs !== undefined) parts.push(formatDuration(data.durationMs))
      break
    case 'member/start':
      parts.push(text(data.name, text(event.memberId, '成员')) + ' 开始')
      if (data.role) parts.push(text(data.role))
      break
    case 'member/end':
      parts.push('成员 ' + statusText(data.status))
      if (data.durationMs !== undefined) parts.push(formatDuration(data.durationMs))
      break
    case 'model/call': {
      const usage = readUsage(data)
      parts.push(text(data.provider, '?') + ' / ' + text(data.model, '?'))
      parts.push(usage.recorded ? 'token ' + formatTokens(usage.total) : 'token 未记录')
      if (data.stopReason) parts.push(text(data.stopReason))
      break
    }
    case 'tool/call':
      parts.push(text(data.name, '工具'))
      parts.push(data.ok === true ? '成功' : data.ok === false ? '失败' : '结果未记录')
      if (data.durationMs !== undefined) parts.push(formatDuration(data.durationMs))
      break
    case 'skill/load': {
      const skillState = data.ok === true ? ' 已加载' : data.ok === false ? ' 加载失败' : ' 加载状态未知'
      parts.push(text(data.skill, 'skill') + skillState)
      break
    }
    case 'artifact/write':
      parts.push(text(data.kind, '文件') + ' ' + text(data.path, '路径未记录'))
      if (data.bytes !== undefined) parts.push(num(data.bytes) + 'B')
      break
    case 'reject/trigger':
      parts.push(text(data.fromNodeId, '?') + ' → ' + text(data.toNodeId, '?'))
      if (data.reason) parts.push(text(data.reason))
      break
    case 'review/finding':
      parts.push(text(data.severity, '?') + ' ' + text(data.title, 'finding'))
      if (data.status) parts.push(text(data.status))
      break
    case 'review/verdict':
      parts.push('结论 ' + text(data.verdict, '未给出'))
      if (data.findingCount !== undefined) parts.push(num(data.findingCount) + ' 条 finding')
      break
    case 'check/form':
      parts.push(text(data.ruleSetId, '规范检查'))
      if (data.state) parts.push(text(data.state))
      if (data.totalChecks !== undefined) parts.push(num(data.passedChecks) + '/' + num(data.totalChecks))
      break
    default:
      return '未识别事件类型' + (event.kind ? '（' + text(event.kind) + '）' : '')
  }
  return parts.filter(Boolean).join(' · ')
}

/** 类型前缀符号：形状 + 文字，颜色只作加速（05 §6）。 */
export function eventGlyph(kind) {
  return EVENT_GLYPH[text(kind)] || '·'
}

/** run 级四段合计：summary 优先，其次 run 自身的 tokens / tokenTotal。 */
export function runTokenInfo(run, summary) {
  const candidates = [
    summary && summary.tokens && summary.tokens.run,
    summary && summary.tokens && summary.tokens.total,
    summary && summary.tokens,
    run && run.tokens,
    run && run.usage,
  ]
  for (const candidate of candidates) {
    const info = readUsage(candidate)
    if (info.recorded) return info
  }
  return readUsage(run && run.hasTokenTotal ? run.tokenTotal : undefined)
}

function conclusionText(value) {
  if (typeof value === 'string') return value.trim()
  if (!isObject(value)) return ''
  for (const key of ['verdict', 'label', 'text', 'title', 'conclusion', 'summary']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

/**
 * 结论 pill（05 §8.4 / 04 §3.9.3）。只认结构化 `quality.state`，不再从
 * 任意文本里猜绿色：
 *   pass → 绿（优 / 良），warn → 黄（可），fail → 红（需返工），
 *   unknown → 黄（未检测 / 证据不足，不是绿灯）。
 * 没拿到 `quality` 证据（summary 未回 / 请求失败）时一律中性，绝不显示绿色「完成」。
 * 运行层失败 / 中止优先于质量结论。
 */
export function conclusionOf(run, summary) {
  const status = text(run && run.status, '')
  const statusKey = status.toLowerCase()
  const quality = isObject(summary && summary.quality) ? summary.quality : null
  const qualityState = quality ? conclusionText(quality.state).toLowerCase() : ''
  const qualityLabel = quality ? conclusionText(quality.label) : ''
  const explicit = [
    quality && quality.conclusion,
    summary && summary.conclusion,
    quality && quality.verdict,
    summary && summary.verdict,
    run && run.conclusion,
    run && run.verdict,
  ].map(conclusionText).find(value => value !== '') || ''

  if (statusKey === 'failed') return { text: statusText(status) || '失败', tone: 'error' }
  if (statusKey === 'aborted') return { text: statusText(status) || '中止', tone: 'warn' }
  if (statusKey === 'running') return { text: statusText(status), tone: 'business' }
  // 未收口的 run（pending / queued / blocked…）不拿质量结论冒充已定论。
  if (!['', 'done', 'failed', 'aborted'].includes(statusKey)) {
    return { text: statusText(status), tone: statusKey === 'blocked' ? 'warn' : 'neutral' }
  }

  if (qualityState === 'pass') {
    return { text: qualityLabel || '良：必要质量证据齐全且通过', tone: 'success' }
  }
  if (qualityState === 'warn') {
    return { text: qualityLabel || '可：证据通过但仍有遗留项', tone: 'warn' }
  }
  if (qualityState === 'fail') {
    return { text: qualityLabel || '需返工：质量证据未通过', tone: 'error' }
  }
  if (qualityState === 'unknown') {
    return { text: qualityLabel || '未检测：缺质量证据', tone: 'warn' }
  }

  // 没有 quality 证据：中性展示，不拿 run 状态伪装成质量通过。
  if (status === '') return { text: '状态未知 · 质量未检测', tone: 'neutral' }
  const settled = ['done', 'failed', 'aborted'].includes(statusKey)
  if (!settled) {
    return { text: statusText(status), tone: statusKey === 'blocked' ? 'warn' : 'neutral' }
  }
  if (explicit !== '') return { text: explicit, tone: 'neutral' }
  return { text: statusText(status) + ' · 质量未检测', tone: 'neutral' }
}

/** 在若干候选容器里按 nodeId 找条目：兼容 map / 数组两种写法。 */
function lookupNodeEntry(containers, nodeId) {
  const id = text(nodeId, '')
  if (id === '') return null
  for (const container of containers) {
    if (Array.isArray(container)) {
      const found = container.find(item => isObject(item) && (text(item.id) === id || text(item.nodeId) === id))
      if (found !== undefined) return found
      continue
    }
    if (!isObject(container)) continue
    if (container[id] !== undefined && container[id] !== null) return container[id]
  }
  return null
}

function tokenLine(info) {
  if (!info || !info.recorded) return '未记录'
  const bucket = key => (info.missing && info.missing.includes(key) ? '—' : formatTokens(info[key]))
  return '四段合计 ' + formatTokens(info.total) + ' tok'
    + '（入 ' + bucket('input')
    + ' · 缓存读 ' + bucket('cacheRead')
    + ' · 缓存写 ' + bucket('cacheWrite')
    + ' · 出 ' + bucket('output') + '）'
}

/** 该节点的 token 四桶；没有记录时返回 null 而不是 0，避免假装有数据。 */
export function nodeTokenInfo(summary, nodeId) {
  const entry = lookupNodeEntry([
    summary && summary.tokens && summary.tokens.byNode,
    summary && summary.tokens && summary.tokens.nodes,
    summary && summary.nodeTokens,
    summary && summary.byNode,
    summary && summary.nodes,
    summary && summary.tokens,
  ], nodeId)
  if (entry === null || entry === undefined) return null
  if (typeof entry === 'number') {
    const info = readUsage(entry)
    return info.recorded ? info : null
  }
  if (!isObject(entry)) return null
  const info = readUsage(entry.tokens || entry.usage || entry.tokenUsage || entry)
  return info.recorded ? info : null
}

function severityCounts(entry) {
  const counts = { P0: 0, P1: 0, P2: 0 }
  const source = isObject(entry && entry.bySeverity) ? entry.bySeverity
    : isObject(entry && entry.severity) ? entry.severity
      : isObject(entry) ? entry : {}
  for (const key of Object.keys(counts)) {
    const value = source[key] !== undefined ? source[key] : source[key.toLowerCase()]
    counts[key] = isObject(value) ? num(value.total, num(value.count, 0)) : num(value, 0)
  }
  return counts
}

function findingsFromEntry(entry) {
  const emptySeverity = { P0: 0, P1: 0, P2: 0 }
  if (typeof entry === 'number') {
    return {
      total: num(entry), open: 0, verified: 0, dismissed: 0,
      bySeverity: emptySeverity, reportedCount: num(entry), fromSummary: true,
    }
  }
  if (!isObject(entry)) return null
  const bySeverity = severityCounts(entry)
  let open = num(entry.open, num(entry.unresolved, 0))
  let verified = num(entry.verified, 0)
  let dismissed = num(entry.dismissed, 0)
  const statuses = isObject(entry.byStatus) ? entry.byStatus : isObject(entry.statuses) ? entry.statuses : null
  let statusTotal = 0
  if (statuses) {
    open = num(statuses.open, 0) + num(statuses.accepted, 0) + num(statuses.fixed, 0)
    verified = num(statuses.verified, 0)
    dismissed = num(statuses.dismissed, 0)
    statusTotal = open + verified + dismissed
  }
  const severityTotal = bySeverity.P0 + bySeverity.P1 + bySeverity.P2
  const total = num(entry.total, num(entry.count, Math.max(severityTotal, statusTotal)))
  return {
    total,
    open,
    verified,
    dismissed,
    bySeverity,
    reportedCount: num(entry.reportedCount, total),
    fromSummary: true,
  }
}

/** 事件按 seq 升序（缺 seq 退回 ts，再退回输入顺序）；不改原数组。 */
export function sortEventsAsc(events) {
  const list = Array.isArray(events) ? events : []
  return list
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const leftSeq = optionalNum(a.event && a.event.seq)
      const rightSeq = optionalNum(b.event && b.event.seq)
      if (leftSeq !== null && rightSeq !== null && leftSeq !== rightSeq) return leftSeq - rightSeq
      const leftAt = Date.parse(text(a.event && a.event.ts, ''))
      const rightAt = Date.parse(text(b.event && b.event.ts, ''))
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) {
        return leftAt - rightAt
      }
      return a.index - b.index
    })
    .map(item => item.event)
}

/**
 * 同一 finding id 的最新状态，按 seq 升序覆盖（05 §8.3 / Host `computeFindings` 同口径）。
 * 无效 id 不计（与 Host 一致）；nodeId 为空时统计整个 run。
 */
export function latestFindingStates(events, nodeId = '') {
  const latest = new Map()
  const wanted = text(nodeId, '')
  for (const event of sortEventsAsc(events)) {
    if (!isObject(event) || text(event.kind) !== 'review/finding') continue
    if (wanted !== '' && text(event.nodeId, '') !== wanted) continue
    const data = isObject(event.data) ? event.data : {}
    const findingId = text(data.id, '')
    if (findingId === '') continue
    latest.set(findingId, {
      id: findingId,
      severity: text(data.severity, ''),
      status: text(data.status, ''),
      seq: optionalNum(event.seq),
    })
  }
  return latest
}

/** 该节点的 findings 计数；摘要没有时退化为从事件里数 review/finding。 */
export function nodeFindingsInfo(summary, nodeId, events) {
  const entry = lookupNodeEntry([
    summary && summary.findings && summary.findings.byNode,
    summary && summary.findings && summary.findings.nodes,
    summary && summary.nodeFindings,
    summary && summary.byNode && summary.byNode.findings,
    summary && summary.nodes,
  ], nodeId)
  const fromSummary = entry === null || entry === undefined ? null : findingsFromEntry(entry)
  if (fromSummary) return fromSummary

  const info = {
    total: 0, open: 0, verified: 0, dismissed: 0,
    bySeverity: { P0: 0, P1: 0, P2: 0 }, reportedCount: 0, fromSummary: false,
  }
  const id = text(nodeId, '')
  if (id === '') return info
  // Host summary 只有 run 级 findings；这里退化为从事件里数。
  // 事件流是倒序的，必须按 seq 升序回放：「先 open 后 verified」最终应算已复验。
  const latest = latestFindingStates(events, id)
  let reported = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (!isObject(event) || text(event.kind) !== 'review/finding' || text(event.nodeId) !== id) continue
    if (text(isObject(event.data) ? event.data.id : '') !== '') reported += 1
  }
  info.reportedCount = reported
  for (const finding of latest.values()) {
    info.total += 1
    const severity = ['P0', 'P1', 'P2'].includes(finding.severity) ? finding.severity : 'P2'
    info.bySeverity[severity] += 1
    if (['open', 'accepted', 'fixed'].includes(finding.status)) info.open += 1
    else if (finding.status === 'verified') info.verified += 1
    else if (finding.status === 'dismissed') info.dismissed += 1
  }
  return info
}

/**
 * 详情里的 findings 一行文案。若只统计了最近一批事件（截断），必须如实标注，
 * 不能把「最近 N 条里的计数」说成整个 run 的结论。
 */
export function findingsLineOf(info, context = {}) {
  const total = num(info && info.total, 0)
  const open = num(info && info.open, 0)
  const verified = num(info && info.verified, 0)
  const bySeverity = info && isObject(info.bySeverity) ? info.bySeverity : {}
  const severity = ['P0', 'P1', 'P2']
    .filter(key => num(bySeverity[key], 0) > 0)
    .map(key => key + ' ' + num(bySeverity[key], 0))
    .join(' · ')
  let label = total > 0
    ? '共 ' + total + ' 条 · 未解决 ' + open
      + (verified > 0 ? ' · 已复验 ' + verified : '')
      + (severity !== '' ? ' · ' + severity : '')
    : '没有 finding 记录'
  // 只有「从最近一批事件里数出来的」才需要截断标注；summary 给的是全量口径。
  if (context.truncated === true && !(info && info.fromSummary === true)) {
    label += ' · 基于最近 ' + num(context.loadedCount, 0) + ' 条（截断）'
  }
  return label
}

/** run 详情里的节点索引 + 事件里出现过的节点，合成筛选下拉选项。 */
export function nodeOptionsOf(detail, events) {
  const map = new Map()
  const add = (id, title) => {
    const key = text(id, '')
    if (key === '') return
    const previous = map.get(key)
    const candidate = text(title, '')
    const nextTitle = candidate !== ''
      ? candidate
      : (previous && previous.title && previous.title !== key ? previous.title : key)
    map.set(key, { id: key, title: nextTitle })
  }
  const containers = [
    detail && detail.nodes,
    detail && detail.nodeIndex,
    detail && detail.index && detail.index.nodes,
    detail && detail.data && detail.data.nodes,
  ]
  for (const container of containers) {
    if (Array.isArray(container)) {
      for (const item of container) {
        if (!isObject(item)) continue
        add(item.id || item.nodeId, item.title || item.name || (isObject(item.data) ? item.data.title : ''))
      }
    } else if (isObject(container)) {
      for (const [id, item] of Object.entries(container)) {
        if (isObject(item)) add(id, item.title || item.name)
        else add(id, '')
      }
    }
  }
  for (const event of Array.isArray(events) ? events : []) {
    if (!isObject(event)) continue
    const data = isObject(event.data) ? event.data : {}
    add(event.nodeId, data.title)
  }
  return [...map.values()]
}

/** ref 提示：`{sessionId, logLine}` 指回 DSH 原生会话日志（05 §2）。 */
export function refLabel(ref) {
  if (ref === null || ref === undefined || ref === '') return ''
  if (typeof ref === 'string') return ref
  if (!isObject(ref)) return text(ref)
  const session = text(ref.sessionId, text(ref.session, ''))
  const line = ref.logLine !== undefined ? ref.logLine : ref.line
  const parts = []
  if (session !== '') parts.push('会话 ' + session)
  if (line !== undefined && line !== null) parts.push('第 ' + text(line) + ' 行')
  if (ref.url) parts.push(text(ref.url))
  return parts.join(' · ')
}

function safeJson(value) {
  try {
    const encoded = JSON.stringify(value, null, 2)
    return encoded === undefined ? String(value) : encoded
  } catch {
    return String(value)
  }
}

function copyText(value) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(value)
  }
  if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', 'readonly')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok ? Promise.resolve() : Promise.reject(new Error('浏览器拒绝了复制'))
  }
  return Promise.reject(new Error('当前环境不支持复制'))
}

/**
 * 请求代次判定（审核 m5）：响应回来时若已有更新的请求，或当前选中的 run
 * 已经变了，就丢弃这次响应，避免旧 run 的数据覆盖新 run。
 * 抽成纯函数便于在 SSR 测试里直接断言（useEffect 不跑）。
 */
export function isStaleLoad({ requestId, latestRequestId, runId, selectedRunId } = {}) {
  return requestId !== latestRequestId || text(runId, '') !== text(selectedRunId, '')
}

// ── 组件 ──────────────────────────────────────────────────────────────────

/**
 * @param {object} [props]
 * @param {boolean} [props.open] 展开态（由 page.js 的 Ctrl/Cmd+J 控制）。
 * @param {() => void} [props.onToggle] 收起/展开。
 * @param {(nodeId: string) => void} [props.onJumpToNode] 从事件详情跳回画布定位节点。
 * @param {string} [props.flowId] 当前流程 id（仅用于说明；列表是全局的）。
 * @param {string} [props.flowName] 当前流程名。
 * @param {Array|object} [props.initialRuns] 预置 run 列表（SSR / 测试用）。
 * @param {string} [props.initialRunId] 预选中 run。
 * @param {object} [props.initialSummary] 预置聚合结果。
 * @param {object} [props.initialDetail] 预置 run 详情。
 * @param {Array|object} [props.initialEvents] 预置事件。
 * @param {string} [props.initialSelectedEventKey] 预选事件的稳定键。
 * @param {string} [props.initialError] 预置错误文案（SSR / 测试用）。
 * @param {number} [props.pollMs] 轮询间隔，默认 5000。
 */
export function FsLogDrawer({
  open = false,
  onToggle = () => {},
  onJumpToNode = null,
  flowId = '',
  flowName = '',
  initialRuns = null,
  initialRunId = '',
  initialSummary = null,
  initialDetail = null,
  initialEvents = null,
  initialSelectedEventKey = '',
  initialError = '',
  pollMs = POLL_MS,
} = {}) {
  const { useState, useEffect, useRef, useCallback } = rt.React

  const initialList = initialRuns === null || initialRuns === undefined ? [] : normalizeRuns(initialRuns)
  const initialEventPayload = initialEvents === null || initialEvents === undefined
    ? { events: [], total: 0, truncated: false }
    : normalizeEvents(initialEvents)
  const initialSelectedRun = text(initialRunId, '') || (initialList.length > 0 ? initialList[0].id : '')

  const [runs, setRuns] = useState(initialList)
  const [loaded, setLoaded] = useState(initialRuns !== null && initialRuns !== undefined)
  const [loading, setLoading] = useState(false)
  const [runError, setRunError] = useState(text(initialError, ''))
  const [selectedRunId, setSelectedRunId] = useState(initialSelectedRun)
  const [detail, setDetail] = useState(initialDetail)
  const [summary, setSummary] = useState(initialSummary)
  const [detailError, setDetailError] = useState('')
  const [events, setEvents] = useState(() => sortEventsDesc(initialEventPayload.events))
  const [eventsTotal, setEventsTotal] = useState(initialEventPayload.total)
  const [truncated, setTruncated] = useState(initialEventPayload.truncated)
  const [eventsError, setEventsError] = useState('')
  const [eventsLoading, setEventsLoading] = useState(false)
  const [nodeFilter, setNodeFilter] = useState('')
  const [kindFilter, setKindFilter] = useState('')
  const [page, setPage] = useState(1)
  const [activeIndex, setActiveIndex] = useState(0)
  const [selectedEventKey, setSelectedEventKey] = useState(text(initialSelectedEventKey, ''))
  const [copyState, setCopyState] = useState('')

  const stateRef = useRef({})
  stateRef.current = { selectedRunId, page, nodeFilter, kindFilter, open }
  const mounted = useRef(true)
  const lastRefresh = useRef(0)
  /** 每个 run 各有一份请求代次；切 run / 新轮询会让旧响应自动作废（审核 m5）。 */
  const detailRequest = useRef(0)
  const eventsRequest = useRef(0)
  const listRef = useRef(null)
  /** 已经渲染过详情的 run；切 run 时清掉上一份 summary / events，避免张冠李戴。 */
  const renderedRun = useRef(initialSelectedRun)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  /** 拉 run 列表；返回实际选中的 runId，供同一次刷新继续拉详情。 */
  const loadRuns = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)
    try {
      const payload = await api.listRuns(20)
      if (!mounted.current) return ''
      const list = normalizeRuns(payload)
      setRuns(list)
      setLoaded(true)
      setRunError('')
      const current = stateRef.current.selectedRunId
      const nextId = current !== '' && list.some(run => run.id === current)
        ? current
        : (list.length > 0 ? list[0].id : '')
      stateRef.current.selectedRunId = nextId
      setSelectedRunId(nextId)
      return nextId
    } catch (failure) {
      if (!mounted.current) return ''
      setLoaded(true)
      setRunError('运行日志读取失败：' + messageOf(failure))
      return ''
    } finally {
      if (mounted.current && !silent) setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async runId => {
    const requestId = ++detailRequest.current
    const stale = () => isStaleLoad({
      requestId,
      latestRequestId: detailRequest.current,
      runId,
      selectedRunId: stateRef.current.selectedRunId,
    })
    if (runId === '') {
      setDetail(null)
      setSummary(null)
      setDetailError('')
      return
    }
    try {
      const result = await api.readRun(runId)
      if (!mounted.current || stale()) return
      setDetail(result)
      setDetailError('')
    } catch (failure) {
      if (!mounted.current || stale()) return
      setDetailError('run 详情读取失败：' + messageOf(failure))
    }
    try {
      const result = await api.readSummary(runId)
      if (!mounted.current || stale()) return
      setSummary(result && result.summary ? result.summary : result)
    } catch {
      // 保留上一次成功结果；下一轮轮询会重试，不能因为一次抖动把结论 pill 清空。
    }
  }, [])

  const loadEvents = useCallback(async (runId, { silent = false } = {}) => {
    const requestId = ++eventsRequest.current
    const stale = () => isStaleLoad({
      requestId,
      latestRequestId: eventsRequest.current,
      runId,
      selectedRunId: stateRef.current.selectedRunId,
    })
    if (runId === '') {
      setEvents([])
      setEventsTotal(0)
      setTruncated(false)
      setEventsError('')
      return
    }
    if (!silent) setEventsLoading(true)
    try {
      const result = await api.readEvents(runId, { limit: EVENT_FETCH_LIMIT, order: 'desc' })
      if (!mounted.current || stale()) return
      const normalized = normalizeEvents(result)
      setEvents(sortEventsDesc(normalized.events))
      setEventsTotal(normalized.total)
      setTruncated(normalized.truncated)
      setEventsError('')
    } catch (failure) {
      if (!mounted.current || stale()) return
      setEventsError('事件流读取失败：' + messageOf(failure))
    } finally {
      if (mounted.current && !silent && eventsRequest.current === requestId) setEventsLoading(false)
    }
  }, [])

  /** 手动刷新与轮询共用；非 force 时 1 秒内不重复发请求（1Hz 节流）。 */
  const refreshAll = useCallback(async ({ silent = false, force = false } = {}) => {
    const now = Date.now()
    if (!force && now - lastRefresh.current < 1000) return
    lastRefresh.current = now
    const runId = await loadRuns({ silent })
    if (runId !== '') await Promise.all([loadDetail(runId), loadEvents(runId, { silent })])
  }, [loadRuns, loadDetail, loadEvents])

  // 挂载 / 切流程：只取一次列表（填 40px 摘要条），不进入轮询。
  useEffect(() => {
    void loadRuns()
  }, [flowId, loadRuns])

  // 选中变化：取 run 详情与 summary（收起时也需要 token / 结论）。
  useEffect(() => {
    if (selectedRunId === '') {
      renderedRun.current = ''
      setDetail(null)
      setSummary(null)
      setEvents([])
      setEventsTotal(0)
      setTruncated(false)
      setDetailError('')
      setEventsError('')
      return
    }
    if (renderedRun.current !== selectedRunId) {
      renderedRun.current = selectedRunId
      setDetail(null)
      setSummary(null)
      setDetailError('')
      setEvents([])
      setEventsTotal(0)
      setTruncated(false)
      setEventsError('')
      setSelectedEventKey('')
      setPage(1)
    }
    void loadDetail(selectedRunId)
  }, [selectedRunId, loadDetail])

  // 展开时才拉事件；收起后不再产生事件请求。
  useEffect(() => {
    if (!open || selectedRunId === '') return
    void loadEvents(selectedRunId)
  }, [open, selectedRunId, loadEvents])

  // 展开期间 5s 轮询；收起立即清掉定时器（「不发无谓请求」）。
  useEffect(() => {
    if (!open || selectedRunId === '') return undefined
    const interval = Math.max(1000, num(pollMs, POLL_MS))
    const timer = setInterval(() => { void refreshAll({ silent: true }) }, interval)
    return () => clearInterval(timer)
  }, [open, selectedRunId, pollMs, refreshAll])

  // 筛选变化回到第一页；翻页后把高亮行放到第一条。
  useEffect(() => {
    setPage(1)
    setActiveIndex(0)
  }, [nodeFilter, kindFilter])

  useEffect(() => {
    setActiveIndex(0)
  }, [page])

  const filteredEvents = filterEvents(events, { nodeId: nodeFilter, kind: kindFilter })
  const paged = pageSlice(filteredEvents, page, EVENT_PAGE_SIZE)
  const pageEvents = paged.items
  const filterActive = nodeFilter !== '' || kindFilter !== ''
  // 事件流最多取最近 EVENT_FETCH_LIMIT 条；只要 loaded < total 就算截断，
  // 不单靠 Host 的 truncated 标记（老 Host 可能不返回）。
  const eventsTruncated = truncated || eventsTotal > events.length
  const countText = eventCountText({
    filteredCount: filteredEvents.length,
    loadedCount: events.length,
    total: eventsTotal,
    truncated: eventsTruncated,
    filterActive,
  })

  useEffect(() => {
    setActiveIndex(current => Math.min(current, Math.max(0, pageEvents.length - 1)))
  }, [pageEvents.length])

  // 高亮行始终滚进可视区（SSR 不跑 effect；浏览器里才有节点）。
  useEffect(() => {
    if (!open) return
    const root = listRef.current
    if (!root || typeof root.querySelector !== 'function') return
    const row = root.querySelector('[data-active="true"]')
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex, page, nodeFilter, kindFilter, pageEvents.length])

  const selectedRun = runs.find(run => run.id === selectedRunId) || null
  const tokenInfo = runTokenInfo(selectedRun, summary)
  const conclusion = selectedRun ? conclusionOf(selectedRun, summary) : null
  const detailEvent = selectedEventKey === ''
    ? null
    : (events.find(event => eventKey(event) === selectedEventKey) || null)
  const nodeOptions = nodeOptionsOf(detail, events)
  const kindList = [...EVENT_KINDS]
  for (const event of events) {
    const kind = text(event.kind, '')
    if (kind !== '' && !kindList.includes(kind)) kindList.push(kind)
  }
  const nodeTitles = new Map(nodeOptions.map(option => [option.id, option.title]))

  const runTitle = selectedRun
    ? selectedRun.name
    : runError !== ''
      ? '运行日志读取失败'
      : loaded ? '还没有运行记录' : '正在读取运行记录…'
  const bucket = key => (tokenInfo.missing.includes(key) ? '—' : formatTokens(tokenInfo[key]))
  const tokenLabel = tokenInfo.recorded ? '四段合计 ' + formatTokens(tokenInfo.total) + ' tok' : 'token 未记录'
  const tokenBreakdown = tokenInfo.recorded && tokenInfo.missing.length < 4
    ? '入 ' + bucket('input') + ' · 缓存读 ' + bucket('cacheRead')
      + ' · 缓存写 ' + bucket('cacheWrite') + ' · 出 ' + bucket('output')
    : ''
  const barLabel = selectedRun
    ? '运行日志：' + selectedRun.name + ' · ' + statusText(selectedRun.status)
      + ' · ' + tokenLabel + (conclusion ? ' · ' + conclusion.text : '')
    : runTitle

  const refresh = () => { void refreshAll({ force: true }) }

  const copyRunId = () => {
    if (!selectedRunId) return
    copyText(selectedRunId).then(
      () => { if (mounted.current) setCopyState('已复制') },
      () => { if (mounted.current) setCopyState('复制失败') },
    ).finally(() => {
      if (typeof setTimeout !== 'function') return
      setTimeout(() => { if (mounted.current) setCopyState('') }, 1600)
    })
  }

  const onEventKeyDown = event => {
    const key = event.key
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape'].includes(key)) return
    // 只在这里吞掉事件流的四个导航键；C / Delete / 其它方向键继续归 page.js。
    event.stopPropagation()
    if (key === 'Escape') {
      event.preventDefault()
      setSelectedEventKey('')
      return
    }
    event.preventDefault()
    if (pageEvents.length === 0) return
    if (key === 'ArrowDown') setActiveIndex(current => moveIndex(current, 1, pageEvents.length))
    else if (key === 'ArrowUp') setActiveIndex(current => moveIndex(current, -1, pageEvents.length))
    else if (key === 'Home') setActiveIndex(0)
    else if (key === 'End') setActiveIndex(pageEvents.length - 1)
    else if (key === 'Enter') {
      const event = pageEvents[activeIndex]
      if (event) setSelectedEventKey(eventKey(event))
    }
  }

  const renderRunList = () => {
    if (runs.length === 0) {
      if (runError !== '') {
        return h('div', { className: 'fs-log-empty', role: 'alert' },
          h('span', null, runError),
          h('button', { type: 'button', className: 'fs-log-mini', onClick: refresh, disabled: loading },
            loading ? '刷新中…' : '重试'))
      }
      return h('div', { className: 'fs-log-empty' },
        h('span', null, loading ? '正在读取运行记录…' : '还没有运行记录'),
        h('button', { type: 'button', className: 'fs-log-mini', onClick: refresh, disabled: loading },
          loading ? '刷新中…' : '刷新'))
    }
    return h('div', { className: 'fs-log-run-list', role: 'listbox', 'aria-label': '运行记录' },
      runs.slice(0, 20).map((run, index) => {
        const info = runTokenInfo(run, run.id === selectedRunId ? summary : null)
        // nodeDone / nodeTotal 只取 Host 的返回值；缺失显示「—」，不自行推算。
        const meta = statusText(run.status)
          + (info.recorded ? ' · ' + formatTokens(info.total) + ' tok' : '')
          + ' · ' + nodeProgressText(run)
        return h('button', {
          key: run.id || 'run-' + index,
          type: 'button',
          role: 'option',
          'aria-selected': run.id === selectedRunId ? 'true' : 'false',
          className: 'fs-log-run' + (run.id === selectedRunId ? ' on' : ''),
          title: run.id || run.name,
          onClick: () => {
            // 先同步选中值与请求代次，避免点击后、effect 跑之前旧响应抢先落盘。
            stateRef.current.selectedRunId = run.id
            detailRequest.current += 1
            eventsRequest.current += 1
            setSelectedRunId(run.id)
            setSelectedEventKey('')
            setPage(1)
          },
        },
        h('span', { className: 'fs-log-run-name' }, run.name),
        h('span', { className: 'fs-log-run-meta' }, meta))
      }))
  }

  const renderEvents = () => {
    if (eventsError !== '' && events.length === 0) {
      return h('div', { className: 'fs-log-empty', role: 'alert' },
        h('span', null, eventsError),
        h('button', { type: 'button', className: 'fs-log-mini', onClick: () => { void loadEvents(selectedRunId) } }, '重试'))
    }
    if (eventsLoading && events.length === 0) {
      return h('div', { className: 'fs-log-empty' }, '正在读取事件流…')
    }
    if (events.length === 0) return h('div', { className: 'fs-log-empty' }, '这个 run 还没有事件')
    if (filteredEvents.length === 0) return h('div', { className: 'fs-log-empty' }, '没有符合筛选条件的事件')

    return h('div', { className: 'fs-log-event-list', role: 'listbox', tabIndex: 0, ref: listRef,
      'aria-label': '事件流：Tab 进入，↑↓ 选择，Enter 展开详情',
      'aria-activedescendant': pageEvents.length > 0 ? 'fs-log-ev-' + activeIndex : undefined,
      onKeyDown: onEventKeyDown },
    pageEvents.map((event, index) => h('div', {
      key: eventKey(event) + '-' + index,
      id: 'fs-log-ev-' + index,
      role: 'option',
      'aria-selected': index === activeIndex ? 'true' : 'false',
      'data-active': index === activeIndex ? 'true' : 'false',
      className: 'fs-log-event' + (index === activeIndex ? ' active' : ''),
      title: eventSummary(event),
      onClick: () => {
        setActiveIndex(index)
        setSelectedEventKey(eventKey(event))
      },
    },
    h('span', { className: 'fs-log-glyph', 'aria-hidden': true }, eventGlyph(event.kind)),
    h('span', { className: 'fs-log-ts', title: text(event.ts, '') }, formatEventTime(event.ts)),
    h('span', { className: 'fs-log-kind' }, text(event.kind, '未识别')),
    h('span', { className: 'fs-log-summary' }, eventSummary(event)))))
  }

  const renderDetail = () => {
    if (!detailEvent) {
      return h('div', { className: 'fs-log-empty' },
        detailError !== '' ? detailError : '选中一条事件，查看原始 JSON、ref 与节点聚合数字')
    }
    const nodeId = text(detailEvent.nodeId, '')
    const tokens = nodeTokenInfo(summary, nodeId)
    const findings = nodeFindingsInfo(summary, nodeId, events)
    const findingsLine = findingsLineOf(findings, {
      truncated: eventsTruncated,
      loadedCount: events.length,
    })
    const ref = refLabel(detailEvent.ref)
    return h('div', { className: 'fs-log-detail-body' },
      h('div', { className: 'fs-log-detail-meta' },
        eventGlyph(detailEvent.kind) + ' ' + text(detailEvent.kind, '未识别事件类型')
        + ' · ' + formatEventTime(detailEvent.ts)
        + (detailEvent.attemptId !== undefined ? ' · 第 ' + text(detailEvent.attemptId) + ' 次尝试' : '')),
      h('pre', { className: 'fs-log-json' }, safeJson(detailEvent)),
      h('div', { className: 'fs-log-ref' },
        'ref：' + (ref === '' ? '无（没有指回原始会话日志）' : ref)),
      nodeId === ''
        ? h('div', { className: 'fs-log-ref' }, 'run 级事件，没有节点归属')
        : h('div', { className: 'fs-log-node' },
          h('div', { className: 'fs-log-node-title' },
            '节点 · ' + (nodeTitles.get(nodeId) || nodeId)),
          h('div', { className: 'fs-log-node-line' }, 'token：' + tokenLine(tokens)),
          h('div', { className: 'fs-log-node-line' }, 'findings：' + findingsLine),
          onJumpToNode
            ? h('button', {
              type: 'button',
              className: 'fs-log-mini',
              onClick: () => onJumpToNode(nodeId),
            }, '跳回画布 · 定位节点')
            : null))
  }

  // 收起态 40px：run 名 · 状态点 · 四段合计 · 结论 pill；无 run 时给空态与刷新。
  const bar = h('div', { className: 'fs-log-bar' },
    h('button', {
      type: 'button',
      className: 'fs-log-toggle',
      'aria-expanded': open ? 'true' : 'false',
      'aria-controls': 'fs-log-body',
      'aria-label': barLabel,
      title: open ? '收起运行日志（Ctrl/Cmd+J）' : '展开运行日志（Ctrl/Cmd+J）',
      onClick: onToggle,
    },
    h('span', { className: 'fs-log-caret', 'aria-hidden': true }, open ? '⌄' : '⌃'),
    selectedRun
      ? h('span', {
        className: 'fs-log-dot ' + statusTone(selectedRun.status),
        'aria-hidden': true,
        title: statusText(selectedRun.status),
      })
      : null,
    h('span', { className: 'fs-log-title', title: runTitle }, runTitle),
    selectedRun ? h('span', { className: 'fs-log-tokens' }, tokenLabel) : null,
    selectedRun && tokenBreakdown !== ''
      ? h('span', { className: 'fs-log-breakdown' }, tokenBreakdown)
      : null,
    selectedRun && conclusion
      ? h('span', { className: 'fs-log-pill ' + conclusion.tone, title: conclusion.text }, conclusion.text)
      : null,
    !selectedRun && runError !== ''
      ? h('span', { className: 'fs-log-note', title: runError }, runError)
      : selectedRun && runError !== ''
        ? h('span', { className: 'fs-log-note', title: runError }, '刷新失败')
        : null),
    h('div', { className: 'fs-log-actions' },
      !selectedRun && !open
        ? h('button', { type: 'button', className: 'fs-log-action', onClick: refresh, disabled: loading },
          loading ? '刷新中…' : '刷新')
        : null,
      open
        ? [
          h('button', { key: 'refresh', type: 'button', className: 'fs-log-action', onClick: refresh, disabled: loading },
            loading ? '刷新中…' : '刷新'),
          selectedRunId
            ? h('a', {
              key: 'export',
              className: 'fs-log-action',
              href: exportUrl(selectedRunId),
              download: (selectedRun ? selectedRun.name : selectedRunId) + '.md',
              title: '导出 markdown（/runs/' + selectedRunId + '/export）',
            }, '导出 md')
            : null,
          selectedRunId
            ? h('button', { key: 'copy', type: 'button', className: 'fs-log-action', onClick: copyRunId },
              copyState || '复制 runId')
            : null,
          h('button', { key: 'collapse', type: 'button', className: 'fs-log-action', onClick: onToggle }, '收起'),
        ]
        : null))

  const body = !open ? null : h('div', { className: 'fs-log-body', id: 'fs-log-body' },
    runError !== '' && runs.length > 0
      ? h('div', { className: 'fs-log-banner', role: 'alert' },
        h('span', null, runError),
        h('button', { type: 'button', className: 'fs-log-mini', onClick: refresh }, '重试'))
      : null,
    h('div', { className: 'fs-log-grid' },
      h('section', { className: 'fs-log-col fs-log-runs', 'aria-label': 'run 列表' },
        h('div', { className: 'fs-log-col-head' },
          h('span', null, '运行记录 · 最近 20'),
          h('span', { className: 'fs-log-count' }, runs.length > 0 ? runs.length + ' 条' : '')),
        renderRunList()),
      h('section', { className: 'fs-log-col fs-log-events', 'aria-label': '事件流' },
        h('div', { className: 'fs-log-col-head' },
          h('span', null, '事件流'),
          h('span', { className: 'fs-log-count' }, countText)),
        eventsError !== '' && events.length > 0
          ? h('div', { className: 'fs-log-banner', role: 'alert' },
            h('span', null, eventsError),
            h('button', {
              type: 'button', className: 'fs-log-mini', onClick: () => { void loadEvents(selectedRunId) },
            }, '重试'))
          : null,
        h('div', { className: 'fs-log-filters' },
          h('label', { className: 'fs-log-filter' },
            h('span', null, '节点'),
            h('select', {
              className: 'fs-log-select',
              value: nodeFilter,
              onChange: event => setNodeFilter(event.target.value),
              'aria-label': '按节点过滤事件',
            },
            h('option', { value: '' }, '全部节点'),
            nodeOptions.map(option => h('option', { key: option.id, value: option.id }, option.title)))),
          h('label', { className: 'fs-log-filter' },
            h('span', null, '类型'),
            h('select', {
              className: 'fs-log-select',
              value: kindFilter,
              onChange: event => setKindFilter(event.target.value),
              'aria-label': '按事件类型过滤',
            },
            h('option', { value: '' }, '全部类型'),
            kindList.map(kind => h('option', { key: kind, value: kind }, kind))))),
        renderEvents(),
        h('div', { className: 'fs-log-pager' },
          h('button', {
            type: 'button', className: 'fs-log-mini', disabled: paged.page <= 1,
            onClick: () => setPage(current => Math.max(1, current - 1)),
          }, '‹ 上一页'),
          h('span', { className: 'fs-log-page' },
            '第 ' + paged.page + '/' + paged.pageCount + ' 页 · ' + EVENT_PAGE_SIZE + ' 条/页'),
          h('button', {
            type: 'button', className: 'fs-log-mini', disabled: paged.page >= paged.pageCount,
            onClick: () => setPage(current => Math.min(paged.pageCount, current + 1)),
          }, '下一页 ›'))),
      h('section', { className: 'fs-log-col fs-log-detail', 'aria-label': '事件详情' },
        h('div', { className: 'fs-log-col-head' }, h('span', null, '事件详情')),
        h('div', { className: 'fs-log-detail-wrap' }, renderDetail()))))

  return h('section', {
    className: 'fs-log' + (open ? ' open' : ''),
    'aria-label': '运行日志',
    'data-flow-name': flowName || undefined,
    'data-flow-id': flowId || undefined,
  }, bar, body)
}
