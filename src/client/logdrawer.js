/**
 * 运行日志抽屉：底部可折叠的 run 列表 / 事件流 / 事件详情。
 *
 * 数据契约见 docs/design/05-run-log.md（§5 接口、§6 客户端）；布局见 DESIGN §7
 * （收起 40px / 展开 200px、最多 2 个自由数字、1Hz 节流）。
 *
 * 四条行为纪律：
 *  1. **按运行态轮询**。挂载时取一次列表；展开时每 5s 刷新；run 在跑时**无论开合**
 *     每 2s 刷新一次（顶栏要实时显示当前节点，06 §10/§11），停止后立刻回到
 *     不轮询 / 5s 档。手动刷新再套一层 1Hz 限流，避免连点重复发请求。
 *  2. **坏数据不抛错**。Host 没起、run 为空、事件缺字段、usage 缺桶，一律降级成
 *     「未记录 / — / 未识别事件类型」，不允许整块抽屉崩掉。
 *  3. **键盘不抢画布**。事件流是一个 listbox（Tab 进入、↑↓ 选择、Enter 展开），
 *     只吞这四个键；`C` / `Delete` / 方向键等画布快捷键仍归 page.js。
 *  4. **旧响应不覆盖新状态**。详情 / 事件 / 列表各自有请求代次，切 run 或切页时
 *     在飞响应直接作废（见 `isStaleLoad` 与 `listRequest`）。
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
/**
 * 运行中的轮询间隔（06 §10：不做 SSE，每 2s 轮询 run 状态）。
 * 只有 run.status === 'running' 才用这个节奏；停止后立即回到不轮询 / 5s 档。
 */
export const LIVE_POLL_MS = 2000
/**
 * 运行中一轮只拉 `GET /runs/<id>` 拿 live/status；事件走 `since=lastSeq` 增量，
 * 且只取下面这些 kind（节点状态 / 打回 / attempt 细节），不再每轮搬 1000 条全量（M5）。
 */
export const WATCH_EVENT_KINDS = Object.freeze([
  'run/start', 'run/end',
  'node/start', 'node/end',
  'member/start', 'member/end',
  'reject/trigger',
])
/** 后台标签页（document.hidden）的轮询间隔：降到 15s，不跟前台抢请求（M5）。 */
export const HIDDEN_POLL_MS = 15000
/** 请求失败指数退避的上限：2s → 4s → 8s → 16s → 30s（M5）。 */
export const MAX_POLL_MS = 30000

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
  // 节点 / 成员结论（06 §13.10：成员结论不可观测时引擎只写 partial，
  // 这里必须显示成「无结论」——既不是通过，也不是失败）。
  passed: '通过',
  rejected: '打回',
  skipped: '跳过',
  partial: '无结论',
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

// ── 轮询成本与增量窗口（M5；纯函数，SSR 不跑 useEffect 也能单测）──────────

/** 失败次数 → 指数退避（2s→4s→8s→16s→30s），恢复后由调用方把计数清零。 */
export function backoffDelay(failures = 0) {
  const count = Math.max(0, Math.floor(num(failures, 0)))
  return Math.min(MAX_POLL_MS, LIVE_POLL_MS * 2 ** Math.min(count, 5))
}

/**
 * 下一轮轮询延迟：base 不传按运行中的 2s；失败按指数退避；后台标签页至少 15s。
 * `base` 让「停在展开态看历史」可以按 5s 档走，不必强行跟运行中的 2s 一致。
 */
export function pollDelay({ failures = 0, hidden = false, base = LIVE_POLL_MS } = {}) {
  const floor = Math.max(500, Math.floor(num(base, LIVE_POLL_MS)))
  const count = Math.max(0, Math.floor(num(failures, 0)))
  const delay = Math.max(floor, Math.min(MAX_POLL_MS, floor * 2 ** Math.min(count, 5)))
  return hidden ? Math.max(HIDDEN_POLL_MS, delay) : delay
}

/** 事件窗口里最大的 seq；没有合法 seq 返回 null（不是 0）。 */
export function latestSeq(events) {
  let latest = null
  for (const event of Array.isArray(events) ? events : []) {
    const seq = optionalNum(event && event.seq)
    if (seq === null) continue
    if (latest === null || seq > latest) latest = seq
  }
  return latest
}

/**
 * 增量拉取参数：`since=lastSeq` + 运行态 kind 过滤。
 * lastSeq 缺失（首次加载）时 since 省略，由调用方走全量窗口。
 */
export function eventsSince(lastSeq) {
  const cursor = optionalNum(lastSeq)
  return {
    since: cursor === null ? undefined : cursor,
    kinds: WATCH_EVENT_KINDS.slice(),
  }
}

/**
 * 这一轮要不要拉事件（M5）：live.lastEventSeq 没超过游标时，只拉 `GET /runs/<id>`。
 * 没有 live / 没有 lastEventSeq（老 Host）时保守地拉，宁可多一次也不漏状态。
 */
export function needsEventFetch(lastSeq, live) {
  const cursor = optionalNum(lastSeq)
  const info = normalizeLive(live)
  if (cursor === null || info === null || info.lastEventSeq === null) return true
  return info.lastEventSeq > cursor
}

/**
 * 把增量事件并入已有窗口：按 `eventKey` 去重（同键后到整条替换），时间倒序，
 * 超过 limit 时丢最旧的一条并标记 dropped。
 */
export function mergeEventWindows(previous, incoming, limit = EVENT_FETCH_LIMIT) {
  const max = Math.max(1, Math.floor(num(limit, EVENT_FETCH_LIMIT)))
  const incomingList = Array.isArray(incoming) ? incoming : []
  const previousList = Array.isArray(previous) ? previous : []
  const known = new Set(previousList.filter(isObject).map(eventKey))
  let added = 0
  const byKey = new Map()
  for (const event of [...previousList, ...incomingList]) {
    if (!isObject(event)) continue
    const key = eventKey(event)
    if (!known.has(key)) added += 1
    byKey.set(key, event)
  }
  const merged = sortEventsDesc([...byKey.values()])
  const events = merged.slice(0, max)
  return { events, added, dropped: merged.length > events.length, total: merged.length }
}

/** 事件窗口被截断时的显式标注（B1）：空串表示窗口完整。 */
export function eventWindowNote(context = {}) {
  if (context.truncated !== true) return ''
  return '基于最近 ' + Math.max(0, Math.floor(num(context.loadedCount, 0))) + ' 条'
}

/**
 * 当前流程「最近活动的 run」：运行中的优先，其次列表第一条（Host 按 startedAt 倒序）。
 * 顶栏 / 画布叠加层跟它走，与抽屉里选中哪条历史 run 解耦（M2）。
 */
export function pickWatchRun(runs, flowId = '') {
  const list = Array.isArray(runs) ? runs.filter(isObject) : []
  const scoped = text(flowId, '') === ''
    ? list
    : list.filter(run => text(run.flowId, '') === text(flowId, ''))
  return scoped.find(run => runIsActive(run)) || scoped[0] || null
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
    started: source.started === true ? true : source.started === false ? false : null,
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
    // 06 §2：运行中的 live 快照（currentNodeId / attempt / round / phase…）。
    // 列表接口不保证带，详情接口会带；读取方统一走 liveOf()。
    live: isObject(source.live) ? source.live : null,
    /**
     * run.json 的进度计数器（B1）：`nodes[nodeId]` 与 `invalidatedNodes`。
     * 列表 / 详情接口都可能带；状态推导优先用它，事件只补细节。
     */
    progress: isObject(source.progress) ? source.progress : null,
    eventCount: optionalNum(source.eventCount),
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

// ── 运行状态推导（06 §11；纯函数，SSR 不跑 useEffect 也能单测）────────────

/**
 * 「建了但还没 start」的 run（06 §2 的 pending）。
 * 有些 Host 版本建 run 时就写 `status: 'running'`；此时既没有 live、也没有任何事件，
 * 不能据此点亮「运行中」或开放「停止」（stop 只会 409）。有 live 或已有事件才是真在跑。
 */
export function runIsPending(run) {
  if (!isObject(run)) return false
  // Host v0.4 的 run.json 有持久化 `started` 标志：比 eventCount / live 猜得更准。
  if (run.started === false) return true
  if (run.started === true) return false
  const status = text(run.status, '').toLowerCase()
  if (status === 'pending') return true
  if (status !== 'running') return false
  if (normalizeLive(run.live)) return false
  const events = optionalNum(run.eventCount)
  const done = optionalNum(run.nodeDone)
  // 只有明确「0 事件且 0 进度」才算 pending；字段缺失不猜（老 Host 没这个计数）。
  return events === 0 && (done === null || done === 0)
}

/** run 是否在跑。只认 `status`（06 §2）；`live` 是运行中的附加信息，不作为状态来源。 */
export function runIsRunning(run) {
  return text(run && run.status, '').toLowerCase() === 'running'
}

/**
 * 「真的在跑」：status=running 且不是刚建未 start 的空 run。
 * 顶栏按钮、2s 轮询、实时文案都用这个；`runIsRunning` 只回答契约字段本身。
 */
export function runIsActive(run) {
  return runIsRunning(run) && !runIsPending(run)
}

/** 展示用状态：空壳 run 一律显示「待运行」，不把 Host 的默认 running 当成真在跑。 */
export function runStatusOf(run) {
  if (runIsPending(run)) return 'pending'
  return text(run && run.status, 'unknown')
}

/** 归一化 `live` 快照；空对象 / 全缺字段返回 null（不伪造 currentNodeId）。 */
export function normalizeLive(source) {
  if (!isObject(source)) return null
  const keys = ['currentNodeId', 'attempt', 'round', 'since', 'lastEventSeq', 'phase']
  const present = keys.some(key => source[key] !== undefined && source[key] !== null && source[key] !== '')
  if (!present) return null
  return {
    currentNodeId: text(source.currentNodeId, ''),
    attempt: optionalNum(source.attempt),
    round: optionalNum(source.round),
    since: text(source.since, ''),
    lastEventSeq: optionalNum(source.lastEventSeq),
    phase: text(source.phase, ''),
  }
}

/**
 * 从 run 详情与归一化 run 里取 live；详情优先（列表接口通常不带 live）。
 * run 与 detail.run 不是同一个 run 时忽略详情，避免切 run 瞬间张冠李戴。
 */
export function liveOf(run, detail) {
  const runId = text(run && run.id, '')
  const detailRun = detail && isObject(detail.run) ? detail.run : null
  const detailOk = detailRun === null || runId === '' || text(detailRun.id, '') === runId
  const candidates = [
    detailOk && detailRun ? detailRun.live : null,
    detailOk && detail ? detail.live : null,
    run && run.live,
  ]
  for (const candidate of candidates) {
    const info = normalizeLive(candidate)
    if (info) return info
  }
  return null
}

function nodeTitleOf(nodes, id) {
  const wanted = text(id, '')
  if (wanted === '') return ''
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (isObject(node) && text(node.id, '') === wanted) return text(node.title, wanted)
  }
  return ''
}

/**
 * 顶栏运行文案（06 §11）：`当前节点 · 第 N 轮 · attempt M`。
 * live 缺字段时从事件回退（最近一次 node/start + node/start 条数），
 * 仍然缺就写「—」，不拿 0 冒充。
 */
export function runLiveLabel(run, live, context = {}) {
  if (!runIsActive(run)) return ''
  const info = normalizeLive(live)
  const events = sortEventsAsc(context.events)
  let fallbackId = ''
  let fallbackAttempt = null
  let starts = 0
  for (const event of events) {
    if (!isObject(event) || text(event.kind, '') !== 'node/start') continue
    starts += 1
    if (text(event.nodeId, '') !== '') {
      fallbackId = text(event.nodeId, '')
      fallbackAttempt = optionalNum(event.attemptId)
    }
  }
  const nodeId = info && info.currentNodeId !== '' ? info.currentNodeId : fallbackId
  const title = nodeTitleOf(context.nodes, nodeId) || nodeId || '—'
  const attempt = info && info.attempt !== null ? info.attempt : fallbackAttempt
  const round = info && info.round !== null ? info.round : (starts > 0 ? starts : null)
  // start 202 之后、首个 node/start 落盘之前：live 是 currentNodeId=null / attempt=0 / round=0。
  // 这时候写「第 0 轮 · attempt 0」只会让人以为出错了，明确说在等第一个节点。
  // m4：带上 since 与 lastSeq，用户能据此判断是「刚启动」还是「卡住不动」。
  if (nodeId === '' && (attempt === null || attempt === 0) && (round === null || round === 0)) {
    const extra = []
    if (info && info.since !== '') extra.push('since ' + info.since)
    if (info && info.lastEventSeq !== null) extra.push('lastSeq ' + info.lastEventSeq)
    return '运行中 · 等待首个节点' + (extra.length > 0 ? '（' + extra.join(' · ') + '）' : '')
  }
  return '当前节点 ' + title
    + ' · 第 ' + (round === null ? '—' : String(round)) + ' 轮'
    + ' · attempt ' + (attempt === null ? '—' : String(attempt))
}

/**
 * 节点运行态词汇表（06 §11）：形状 + 文字是主通道，颜色只加速。
 * 多出的 `skipped` 来自 05 事件契约（node/end.status=skipped），如实显示，不硬塞进五态；
 * `aborted` 给「中止时仍在飞的节点」（m3）：不能写成「未开始」，那不是同一件事。
 */
export const NODE_RUN_STATE = Object.freeze({
  idle: Object.freeze({ label: '未开始', glyph: '○', tone: 'idle' }),
  running: Object.freeze({ label: '运行中', glyph: '◉', tone: 'business' }),
  passed: Object.freeze({ label: '已通过', glyph: '✓', tone: 'success' }),
  rejected: Object.freeze({ label: '被打回', glyph: '↺', tone: 'warn' }),
  failed: Object.freeze({ label: '失败', glyph: '✕', tone: 'error' }),
  skipped: Object.freeze({ label: '已跳过', glyph: '–', tone: 'neutral' }),
  aborted: Object.freeze({ label: '已中止（无结论）', glyph: '⊘', tone: 'neutral' }),
})

export function nodeStateInfo(state) {
  return NODE_RUN_STATE[text(state, '')] || NODE_RUN_STATE.idle
}

/**
 * 列表摘要 + 详情合并：详情更新（live / status），但**不要**用它盖掉列表里更完整的
 * `progress.nodes` —— readRunDetail 可能只回计数、不带每节点状态（B1 依赖 nodes）。
 */
export function mergeRunDetail(base, detail) {
  if (!isObject(base)) return isObject(detail) ? detail : null
  if (!isObject(detail)) return base
  const next = { ...base, ...detail }
  const baseProgress = isObject(base.progress) ? base.progress : null
  const detailProgress = isObject(detail.progress) ? detail.progress : null
  const baseNodes = baseProgress && isObject(baseProgress.nodes) ? baseProgress.nodes : null
  const detailNodes = detailProgress && isObject(detailProgress.nodes) ? detailProgress.nodes : null
  if (baseNodes && !detailNodes) {
    next.progress = { ...(detailProgress || {}), ...(baseProgress || {}), nodes: baseNodes }
  }
  return next
}

/**
 * `summary.progress` 归一化（B1）：Host 的 `progress.nodes[nodeId]` 可能是对象 / 数组 /
 * Map（SSR 测试里直接传 Map 也接受）；`invalidatedNodes` 顶层列表与条目自身的
 * `invalidated` 合并成同一个集合。
 */
export function normalizeProgress(progress) {
  const source = isObject(progress) ? progress : null
  const entries = new Map()
  const invalidated = new Set()
  if (!source) return { entries, invalidated, present: false }
  const put = (id, entry) => {
    const key = text(id, '')
    if (key === '' || !isObject(entry)) return
    entries.set(key, {
      attemptId: optionalNum(entry.attemptId),
      status: text(entry.status, '').toLowerCase(),
      endSeq: optionalNum(entry.endSeq),
      invalidated: entry.invalidated === true,
    })
  }
  const nodes = source.nodes
  if (nodes && typeof nodes.get === 'function' && typeof nodes.forEach === 'function') {
    nodes.forEach((entry, id) => put(id, entry))
  } else if (Array.isArray(nodes)) {
    for (const entry of nodes) if (isObject(entry)) put(entry.nodeId || entry.id, entry)
  } else if (isObject(nodes)) {
    for (const [id, entry] of Object.entries(nodes)) put(id, entry)
  }
  const list = Array.isArray(source.invalidatedNodes) ? source.invalidatedNodes : []
  for (const id of list) invalidated.add(text(id, ''))
  for (const [id, entry] of entries) if (entry.invalidated) invalidated.add(id)
  return { entries, invalidated, present: entries.size > 0 }
}

/** 按 seq 重放 node/start、node/end、reject/trigger；返回事件侧的细节索引。 */
function replayNodeEvents(events) {
  const progress = new Map()
  const lastKind = new Map()
  const attemptsSeen = new Map()
  const rejectRoles = new Map()
  const touchAttempt = (nodeId, attemptId) => {
    if (attemptId === null) return
    if (!attemptsSeen.has(nodeId)) attemptsSeen.set(nodeId, new Set())
    attemptsSeen.get(nodeId).add(attemptId)
  }
  for (const event of sortEventsAsc(events)) {
    if (!isObject(event)) continue
    const nodeId = text(event.nodeId, '')
    const rawSeq = optionalNum(event.seq)
    const seq = rawSeq === null ? 0 : rawSeq
    const attemptId = optionalNum(event.attemptId)

    if (event.kind === 'node/start' && nodeId !== '') {
      const existing = progress.get(nodeId)
      if (attemptId !== null && (!existing || attemptId >= existing.attemptId)) {
        progress.set(nodeId, { attemptId, status: 'pending', endSeq: 0, invalidated: false })
      }
      touchAttempt(nodeId, attemptId)
      lastKind.set(nodeId, { kind: 'node/start', seq, attemptId })
      continue
    }

    if (event.kind === 'node/end' && nodeId !== '') {
      const status = text(isObject(event.data) ? event.data.status : '', '')
      if (attemptId !== null && status !== '') {
        const existing = progress.get(nodeId)
        if (!existing || attemptId >= existing.attemptId) {
          progress.set(nodeId, { attemptId, status, endSeq: seq, invalidated: false })
        }
      }
      touchAttempt(nodeId, attemptId)
      lastKind.set(nodeId, { kind: 'node/end', seq, attemptId, status })
      continue
    }

    if (event.kind === 'reject/trigger') {
      const data = isObject(event.data) ? event.data : {}
      const fromNodeId = text(data.fromNodeId, '')
      const toNodeId = text(data.toNodeId, '')
      if (fromNodeId === '' || toNodeId === '') continue
      // 与 runlog.computeProgress 同一套失效窗口。
      const target = progress.get(toNodeId)
      const windowStart = target && target.status === 'passed' && target.endSeq > 0
        && target.endSeq < seq ? target.endSeq : null
      for (const [id, entry] of progress) {
        if (entry.status !== 'passed' || entry.invalidated) continue
        if (entry.endSeq <= 0 || entry.endSeq >= seq) continue
        const onPath = id === fromNodeId || id === toNodeId
          || (windowStart !== null && entry.endSeq >= windowStart)
        if (onPath) entry.invalidated = true
      }
      // m8：源节点只写「已判打回」，↺n 只记在目标节点；同一节点既判又被打回时按目标算。
      if (fromNodeId !== toNodeId) rejectRoles.set(fromNodeId, 'source')
      rejectRoles.set(toNodeId, 'target')
      lastKind.set(toNodeId, { kind: 'reject/trigger', seq, attemptId })
    }
  }
  return { progress, lastKind, attemptsSeen, rejectRoles }
}

/**
 * 每个阶段节点的运行态（06 §11）。
 *
 * **状态优先级（B1）**：`progress.nodes[nodeId].status` + `invalidatedNodes` 优先——
 * 它与 `nodeDone` 同口径，事件窗口被截断也不会让已通过节点在画布上退化成「未开始」。
 * 但两种缺口由事件补：progress 里没有的节点、以及事件 `node/end` 的 endSeq 比
 * progress 条目更新（progress 是较旧快照）。事件还补运行中 / 被打回 / attempt / 返工次数。
 * 完全没有 progress 时（老 Host / 详情接口失败）退回纯事件重放。
 * 注：Host 的 `readRunDetail` 目前会用计数对象覆盖 run.json 的 progress.nodes，
 * 客户端因此同时读列表 run.progress 与事件；Host 侧最好在 summary.progress 里直接带 nodes。
 *
 * 其余规则（与 Host `computeProgress` 同口径）：
 *  1. `↺n` 是**目标返工数**：该节点 attemptId > 1 的去重次数（没重跑不算），
 *     只显示在被打回的目标节点上；源节点不显示发起数（04 §4.2 / m8）；
 *  2. `live.currentNodeId` 命中且 run 仍在跑 → 运行中（优先于历史结论）；
 *  3. run 中止时，在飞 / 仍 pending 的节点显示「已中止（无结论）」（m3）。
 *
 * @param {{nodes?: Array, events?: Array, live?: object, runStatus?: string,
 *   progress?: object}} input
 * @returns {Record<string, {state:string,label:string,glyph:string,tone:string,
 *   attempt:number|null, reworkCount:number, invalidated:boolean, current:boolean,
 *   rejectRole:string, fromProgress:boolean}>}
 */
export function deriveNodeStates({ nodes, events, live, runStatus, progress } = {}) {
  const ids = []
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const id = text(isObject(node) ? node.id : node, '')
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }

  const eventReplay = replayNodeEvents(events)
  const hostProgress = normalizeProgress(progress)
  const running = text(runStatus, '').toLowerCase() === 'running'
  const aborted = text(runStatus, '').toLowerCase() === 'aborted'
  const liveInfo = normalizeLive(live)
  const currentId = liveInfo ? liveInfo.currentNodeId : ''
  const states = {}

  for (const id of ids) {
    const eventEntry = eventReplay.progress.get(id) || null
    const hostEntry = hostProgress.entries.get(id) || null
    const latest = eventReplay.lastKind.get(id) || null
    const rejectRole = eventReplay.rejectRoles.get(id) || ''
    /**
     * progress 优先，但两种情况下让事件说话：
     *  1. progress 里根本没有这个节点（Host 还没落 / 事件窗口里的新节点）；
     *  2. 事件里的 node/end 比 progress 条目更新（endSeq 更大且 attempt 不更旧）——
     *     事件窗口可能比一份旧的 progress 快照更新，不能让它把新结论压回 pending。
     */
    const eventNewer = Boolean(eventEntry && (
      !hostEntry
      || ((eventEntry.endSeq || 0) > (hostEntry.endSeq || 0)
        && (eventEntry.attemptId === null || hostEntry.attemptId === null
          || eventEntry.attemptId >= hostEntry.attemptId))
    ))
    const chosen = eventNewer ? eventEntry : hostEntry
    const attemptId = chosen && chosen.attemptId !== null && chosen.attemptId !== undefined
      ? chosen.attemptId
      : (hostEntry && hostEntry.attemptId !== null
        ? hostEntry.attemptId
        : (eventEntry && eventEntry.attemptId !== undefined ? eventEntry.attemptId : null))

    // 目标返工数 = 该节点 attemptId > 1 的去重次数；没有事件时按 attemptId-1 兜底。
    const seen = eventReplay.attemptsSeen.get(id)
    let reworkCount = 0
    if (seen) for (const seenAttempt of seen) if (seenAttempt > 1) reworkCount += 1
    if (reworkCount === 0 && attemptId !== null && attemptId > 1) reworkCount = attemptId - 1
    if (rejectRole === 'source') reworkCount = 0

    // 事件比 progress 新且已经重跑通过时，旧的 invalidated 不再算数（否则新 ✓ 会被压成打回）。
    const invalidated = eventNewer && eventEntry.status === 'passed'
      ? Boolean(eventEntry.invalidated)
      : hostProgress.invalidated.has(id)
        || Boolean(hostEntry && hostEntry.invalidated)
        || Boolean(eventEntry && eventEntry.invalidated)
    const status = chosen ? chosen.status : ''

    let state = 'idle'
    if (running && currentId !== '' && id === currentId) state = 'running'
    else if (status === 'passed') state = invalidated ? 'rejected' : 'passed'
    else if (status === 'failed') state = 'failed'
    else if (status === 'rejected') state = 'rejected'
    else if (status === 'skipped') state = 'skipped'
    else if (status === 'pending') {
      if (aborted) state = 'aborted'
      else if (running && (currentId === '' || id === currentId)) state = 'running'
      else state = 'idle'
    } else if (latest && latest.kind === 'reject/trigger') {
      state = 'rejected'
    } else if (running && currentId === '' && latest && latest.kind === 'node/start') {
      state = 'running'
    } else if (aborted && latest && latest.kind === 'node/start') {
      state = 'aborted'
    } else if (aborted && hostEntry && hostEntry.status === 'pending') {
      state = 'aborted'
    }

    const info = nodeStateInfo(state)
    states[id] = {
      state,
      label: info.label,
      glyph: info.glyph,
      tone: info.tone,
      attempt: attemptId,
      reworkCount,
      invalidated,
      current: running && currentId !== '' && id === currentId,
      rejectRole,
      fromProgress: Boolean(hostEntry && !eventNewer),
    }
  }
  return states
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

/** 时长缩写：<1s 毫秒、<60s 秒（一位小数）、再往上分:秒；缺失返回空串。 */
export function formatDuration(value) {
  if (value === null || value === undefined || value === '') return ''
  const ms = num(value, -1)
  if (ms < 0) return ''
  if (ms < 1000) return String(Math.round(ms)) + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
  const totalSeconds = Math.floor(ms / 1000)
  return Math.floor(totalSeconds / 60) + ':' + pad2(totalSeconds % 60)
}

/**
 * run 总耗时：startedAt → endedAt；仍在跑（无 endedAt）时用 now 走秒。
 * 时间戳缺失 / 非法返回 null（UI 显示「—」，不拿 0 冒充）。
 */
export function runDurationMs(run, now) {
  const started = Date.parse(text(run && run.startedAt, ''))
  if (!Number.isFinite(started)) return null
  const ended = Date.parse(text(run && run.endedAt, ''))
  const reference = Number.isFinite(ended)
    ? ended
    : (typeof now === 'number' && Number.isFinite(now) ? now : Date.now())
  return Math.max(0, reference - started)
}

/**
 * 验收条目通过率（M4）：只认 Host 补进 summary 的 `acceptance {passed,total,rate}`。
 * 字段暂时缺失就显示「验收 —」，绝不用阶段进度或事件自己编一个比例。
 */
export function acceptanceOf(summary) {
  const raw = isObject(summary) && isObject(summary.acceptance) ? summary.acceptance : null
  const passed = raw ? optionalNum(raw.passed !== undefined ? raw.passed : raw['pass']) : null
  const total = raw ? optionalNum(raw.total !== undefined ? raw.total : raw.items) : null
  let rate = raw ? optionalNum(raw.rate !== undefined ? raw.rate : raw.ratio) : null
  // Host 的 rate 契约是 0–1；若未来给百分数（78）也按 0.78 归一化，避免写出 7800%。
  if (rate !== null && rate > 1) rate = rate / 100
  if (rate === null && passed !== null && total !== null && total > 0) rate = passed / total
  const comparable = passed !== null && total !== null && total > 0
  const rateText = comparable && rate !== null ? Math.round(Math.min(1, rate) * 100) + '%' : ''
  return {
    passed: comparable ? passed : null,
    total: comparable ? total : null,
    rate: comparable ? rate : null,
    valueText: comparable ? passed + '/' + total : '—',
    rateText,
    // 收起条主值：`验收 7/9 · 78%`；缺失时只写 `验收 —`。
    text: comparable ? '验收 ' + passed + '/' + total + (rateText === '' ? '' : ' · ' + rateText) : '验收 —',
    missing: !comparable,
  }
}

/**
 * 展开态的五项（+ token 明细）聚合：总耗时 / P0 未解决 / 审查采纳率 / skill 覆盖率 / 返工轮次。
 * 每一项缺数据都返回「—」，不拿 0 或 100% 顶替（04 §3.2 空数据态）。
 */
export function runMetrics(run, summary, options = {}) {
  const info = isObject(summary) ? summary : {}
  const quality = isObject(info.quality) ? info.quality : {}
  const findings = isObject(info.findings) ? info.findings : {}
  const unresolved = isObject(findings.unresolvedBySeverity) ? findings.unresolvedBySeverity : {}
  const skillUsage = isObject(info.skillUsage) ? info.skillUsage : {}
  const tokens = runTokenInfo(run, info)
  const acceptance = acceptanceOf(info)
  const durationMs = runDurationMs(run, options.now)
  const p0 = optionalNum(quality.p0Unresolved) !== null
    ? optionalNum(quality.p0Unresolved)
    : optionalNum(unresolved.P0)
  const p1 = optionalNum(quality.p1Unresolved) !== null
    ? optionalNum(quality.p1Unresolved)
    : optionalNum(unresolved.P1)
  const p2 = optionalNum(unresolved.P2)
  const acceptedRate = optionalNum(quality.acceptedRate) !== null
    ? optionalNum(quality.acceptedRate)
    : optionalNum(findings.acceptedRate)
  const reworkRounds = optionalNum(quality.reworkRounds)
  const declared = optionalNum(skillUsage.declaredCount)
  const loaded = optionalNum(skillUsage.loadedCount)
  const coverage = optionalNum(skillUsage.coverage)
  const loads = isObject(skillUsage.loads) ? skillUsage.loads : {}
  const loadTotal = optionalNum(loads.total)
  const skillComparable = declared !== null && loaded !== null && declared > 0
  return {
    acceptance,
    durationMs,
    durationText: formatDuration(durationMs) || '—',
    tokens,
    p0: p0 === null ? '—' : String(p0),
    p1: p1 === null ? '—' : String(p1),
    p2: p2 === null ? '—' : String(p2),
    acceptedRate,
    acceptedRateText: acceptedRate === null ? '—' : Math.round(Math.min(1, acceptedRate) * 100) + '%',
    reworkRounds,
    reworkText: reworkRounds === null ? '—' : reworkRounds + ' 轮',
    skillDeclared: declared,
    skillLoaded: loaded,
    skillCoverage: coverage,
    skillText: skillComparable ? loaded + '/' + declared : '—',
    skillHint: coverage === null || !skillComparable
      ? '加载次数未记录'
      : Math.round(Math.min(1, coverage) * 100) + '%'
        + (loadTotal === null ? '' : ' · 加载 ' + loadTotal + ' 次'),
  }
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
 * 06 §13.8：桩数据的 badge 文案。桩引擎的结论一律 unknown，但那只是「不判定」，
 * 读者仍需要一眼看出这批数据**不是真实证据**，不能拿去做质量判断。
 * @returns {string} 非桩返回 ''
 */
export function stubBadgeOf(summary) {
  if (!isObject(summary)) return ''
  if (summary.engine === 'stub') return '桩数据，不是真实证据'
  const quality = isObject(summary.quality) ? summary.quality : null
  if (quality && quality.stub === true) return '桩数据，不是真实证据'
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
  // 建了没 start 的空 run：显示「待运行」，不当运行中、也不给质量结论。
  if (runIsPending(run)) return { text: statusText('pending'), tone: 'neutral' }
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
    // m1：quality=fail 用 warn 黄；红只留给「运行失败」这一档（01 §… 语义色分级）。
    return { text: qualityLabel || '需返工：质量证据未通过', tone: 'warn' }
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
 * @param {(snapshot: object) => void} [props.onRunSnapshot] 把选中 run 的实时快照
 *   （run/live/events/summary）回传给 page，供顶栏与画布节点状态使用。
 * @param {{id: string, nonce: number}|null} [props.focusRun] 要求切到某个 run
 *   （开始运行后由 page 指定）；nonce 变化即重新聚焦。
 * @param {number} [props.syncToken] 变化时立即强制刷新一次（开始 / 停止后）。
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
  onRunSnapshot = null,
  focusRun = null,
  syncToken = 0,
} = {}) {
  const { useState, useEffect, useRef, useCallback, useMemo } = rt.React

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
  /**
   * 与抽屉选中解耦的「当前流程最近活动 run」观测窗口（M2）。
   * 抽屉点历史 run 时，顶栏 / 画布仍看这条；运行中的优先。
   */
  const [watchDetail, setWatchDetail] = useState(null)
  const [watchSummary, setWatchSummary] = useState(null)
  const [watchEvents, setWatchEvents] = useState([])
  const [watchEventsTotal, setWatchEventsTotal] = useState(0)
  const [watchEventsTruncated, setWatchEventsTruncated] = useState(false)
  const [watchError, setWatchError] = useState('')
  /** 后台标签页标记：document.hidden 时轮询降到 15s（M5）。 */
  const [hidden, setHidden] = useState(false)

  const stateRef = useRef({})
  stateRef.current = { selectedRunId, page, nodeFilter, kindFilter, open }
  const mounted = useRef(true)
  const lastRefresh = useRef(0)
  /** 每个 run 各有一份请求代次；切 run / 新轮询会让旧响应自动作废（审核 m5）。 */
  const detailRequest = useRef(0)
  const eventsRequest = useRef(0)
  /** run 列表也有代次：两次列表请求乱序返回时，旧列表不能覆盖新列表。 */
  const listRequest = useRef(0)
  const listRef = useRef(null)
  /**
   * 刚创建 / 刚聚焦的 run 可能还没出现在列表里；这段时间内列表刷新不许把选中项
   * 切回列表第一条（否则开始运行后 2s 内抽屉会跳到别的 run）。
   */
  const holdSelection = useRef({ id: '', until: 0 })
  /** 已经渲染过详情的 run；切 run 时清掉上一份 summary / events，避免张冠李戴。 */
  const renderedRun = useRef(initialSelectedRun)
  /** 活动 run 观测窗口的代次、增量游标与失败计数（M5）。 */
  const watchRequest = useRef(0)
  const watchWindow = useRef({ runId: '', events: [], lastSeq: null })
  const watchFailures = useRef(0)
  const watchSummaryFor = useRef('')
  /** 选中 run 的事件增量游标；切 run 时清空，避免把上一条 run 的 seq 当 since。 */
  const selectedCursor = useRef(null)
  const selectedFailures = useRef(0)

  // ── 选中 run 的合并视图：列表摘要 + 详情（详情里有 live / 最新状态）──────
  const selectedRun = useMemo(
    () => runs.find(run => run.id === selectedRunId) || null,
    [runs, selectedRunId],
  )
  const detailRunRaw = detail && isObject(detail.run) ? detail.run : null
  const detailRun = useMemo(
    () => (detailRunRaw ? normalizeRun(detailRunRaw) : null),
    [detailRunRaw],
  )
  const currentRun = selectedRun || detailRun
  /**
   * 列表与详情合并：状态 / live 以详情为准（它是最新的一次 GET /runs/<id>），
   * 但只有 id 对得上时才合并，避免切 run 的瞬间把 A 的 live 贴到 B 上。
   */
  const feedRun = useMemo(() => {
    if (!currentRun) return null
    if (detailRunRaw && text(detailRunRaw.id, '') === text(currentRun.id, '')) {
      return normalizeRun(mergeRunDetail(currentRun, detailRunRaw))
    }
    return currentRun
  }, [currentRun, detailRunRaw])
  const currentLive = useMemo(
    () => (feedRun ? liveOf(feedRun, detail) : null),
    [feedRun, detail],
  )

  // ── 活动 run（M2）：列表里挑「运行中优先、否则最近一条」；与抽屉选中解耦 ──
  const watchCandidate = useMemo(() => pickWatchRun(runs, flowId), [runs, flowId])
  /**
   * 活动 run id：列表里有运行中的优先；列表还没回（刚开始的新 run）时，
   * 若当前选中 run 的详情已经是 running，就先盯它，避免顶栏空等一次列表刷新。
   */
  const watchRunId = watchCandidate && runIsActive(watchCandidate)
    ? text(watchCandidate.id, '')
    : (runIsActive(feedRun) ? selectedRunId : (watchCandidate ? text(watchCandidate.id, '') : ''))
  const watchRun = useMemo(() => {
    if (watchRunId === '') return null
    const detailRaw = watchDetail && isObject(watchDetail.run) ? watchDetail.run : null
    if (detailRaw && text(detailRaw.id, '') === watchRunId) {
      return normalizeRun(mergeRunDetail(watchCandidate, detailRaw))
    }
    return watchCandidate
  }, [watchRunId, watchCandidate, watchDetail])
  const watchLive = useMemo(
    () => (watchRun ? liveOf(watchRun, watchDetail) : null),
    [watchRun, watchDetail],
  )
  const watchRunning = runIsActive(watchRun)
  /** 选中 run 就是活动 run 时，两套数据同源，复用选中窗口避免重复请求。 */
  const watchIsSelected = watchRunId !== '' && watchRunId === selectedRunId

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  /** 拉 run 列表；返回实际选中的 runId，供同一次刷新继续拉详情。 */
  const loadRuns = useCallback(async ({ silent = false } = {}) => {
    const requestId = ++listRequest.current
    if (!silent) setLoading(true)
    try {
      const payload = await api.listRuns(20)
      if (!mounted.current || requestId !== listRequest.current) return ''
      const list = normalizeRuns(payload)
      setRuns(list)
      setLoaded(true)
      setRunError('')
      const current = stateRef.current.selectedRunId
      const hold = holdSelection.current
      const held = hold.id !== '' && hold.id === current && Date.now() < hold.until
      const inList = current !== '' && list.some(run => run.id === current)
      if (inList) holdSelection.current = { id: '', until: 0 }
      // 没有选中项时优先盯住正在跑的 run：顶栏的「停止」与实时节点要对准它，
      // 而不是列表第一条（可能是一条已结束的记录）。
      const activeRun = list.find(run => runIsActive(run))
      const nextId = current !== '' && (inList || held)
        ? current
        : (activeRun ? activeRun.id : (list.length > 0 ? list[0].id : ''))
      stateRef.current.selectedRunId = nextId
      setSelectedRunId(nextId)
      return nextId
    } catch (failure) {
      if (!mounted.current || requestId !== listRequest.current) return ''
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

  /**
   * 事件窗口：full 走最近 EVENT_FETCH_LIMIT 条（切 run / 手动刷新）；
   * 其余轮次只取 `since=selectedCursor` 之后的新事件再并入（M5，不再每轮搬全量）。
   */
  const loadEvents = useCallback(async (runId, { silent = false, full = true } = {}) => {
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
      selectedCursor.current = null
      return
    }
    if (!silent) setEventsLoading(true)
    try {
      const cursor = full ? null : selectedCursor.current
      const result = await api.readEvents(runId, {
        since: cursor === null ? undefined : cursor,
        limit: full ? EVENT_FETCH_LIMIT : 500,
        order: full ? 'desc' : 'asc',
      })
      if (!mounted.current || stale()) return
      const normalized = normalizeEvents(result)
      if (full) {
        const nextEvents = sortEventsDesc(normalized.events)
        selectedCursor.current = latestSeq(nextEvents)
        setEvents(nextEvents)
        setEventsTotal(normalized.total)
        setTruncated(normalized.truncated || normalized.total > nextEvents.length)
      } else {
        // 增量必须并进当前事件列表（用函数式 setState 拿最新值）。
        const incoming = normalized.events
        setEvents(previous => {
          const combined = mergeEventWindows(previous, incoming, EVENT_FETCH_LIMIT)
          selectedCursor.current = latestSeq(combined.events)
          return combined.events
        })
        setEventsTotal(previous => Math.max(previous, num(normalized.total, previous)))
        setTruncated(previous => previous || normalized.truncated)
      }
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
    if (runId !== '') await Promise.all([loadDetail(runId), loadEvents(runId, { silent, full: true })])
  }, [loadRuns, loadDetail, loadEvents])

  /**
   * 活动 run 的一轮观测（M2 + M5）：
   *  1. 只拉 `GET /runs/<id>` 拿 live / status；
   *  2. 事件走 `since=lastSeq` 增量，活动窗口只取 WATCH_EVENT_KINDS；
   *  3. 选中 run 就是它时，把详情 / 增量事件 / summary 同步进抽屉自己的窗口；
   *  4. 只在收口时补一次 summary（运行中不每轮拉），成功后清零失败计数。
   */
  const runWatchRound = useCallback(async runId => {
    if (runId === '') return true
    const requestId = ++watchRequest.current
    const current = () => mounted.current && requestId === watchRequest.current
    try {
      const detailResult = await api.readRun(runId)
      if (!current()) return true
      setWatchDetail(detailResult)
      const watched = normalizeRun(detailResult && detailResult.run ? detailResult.run : {})
      const forSelected = text(stateRef.current.selectedRunId, '') === runId
      const cursor = watchWindow.current.runId === runId ? watchWindow.current.lastSeq : null
      // M5：live.lastEventSeq 没往前走时，这一轮就只拉 GET /runs/<id>，不重复搬事件。
      const needsEvents = needsEventFetch(cursor, liveOf(watched, detailResult))
      if (needsEvents) {
        const params = eventsSince(cursor)
        const eventResult = await api.readEvents(runId, {
          // 抽屉要展示全部事件；只有活动窗口才按 kind 过滤省钱。
          kinds: forSelected ? undefined : params.kinds,
          since: params.since,
          limit: cursor === null ? EVENT_FETCH_LIMIT : 500,
          order: cursor === null ? 'desc' : 'asc',
        })
        if (!current()) return true
        const normalized = normalizeEvents(eventResult)
        const baseEvents = cursor === null ? [] : watchWindow.current.events
        const merged = mergeEventWindows(baseEvents, normalized.events, EVENT_FETCH_LIMIT)
        const nextEvents = cursor === null ? sortEventsDesc(normalized.events) : merged.events
        const previousTotal = cursor === null ? 0 : num(watchWindow.current.total, 0)
        const nextTotal = Math.max(
          nextEvents.length,
          num(normalized.total, nextEvents.length),
          previousTotal,
        )
        const nextTruncated = normalized.truncated || merged.dropped || nextTotal > nextEvents.length
        watchWindow.current = { runId, events: nextEvents, lastSeq: latestSeq(nextEvents), total: nextTotal }
        setWatchEvents(nextEvents)
        setWatchEventsTotal(nextTotal)
        setWatchEventsTruncated(nextTruncated)
        if (forSelected) {
          detailRequest.current += 1
          eventsRequest.current += 1
          setEvents(previous => (cursor === null ? nextEvents : mergeEventWindows(previous, normalized.events, EVENT_FETCH_LIMIT).events))
          setEventsTotal(nextTotal)
          setTruncated(nextTruncated)
          selectedCursor.current = latestSeq(nextEvents)
          setEventsError('')
        }
      }
      if (!current()) return true
      setWatchError('')
      watchFailures.current = 0
      if (forSelected) {
        detailRequest.current += 1
        setDetail(detailResult)
        setDetailError('')
      }
      if (!runIsActive(watched) && watchSummaryFor.current !== runId) {
        watchSummaryFor.current = runId
        try {
          const summaryResult = await api.readSummary(runId)
          if (!current()) return true
          const nextSummary = summaryResult && summaryResult.summary ? summaryResult.summary : summaryResult
          setWatchSummary(nextSummary)
          if (forSelected) setSummary(nextSummary)
        } catch {
          // summary 失败不阻塞状态刷新；下一个收口轮会重试。
          watchSummaryFor.current = ''
        }
        // 收口后刷新一次列表，让「运行中」状态从列表里落定（之后不再 2s 拉列表）。
        void loadRuns({ silent: true })
      }
      return true
    } catch (failure) {
      if (current()) {
        watchFailures.current += 1
        setWatchError('运行状态刷新失败：' + messageOf(failure))
      }
      return false
    }
  }, [loadRuns])

  // 挂载 / 切流程：只取一次列表（填 40px 摘要条），不进入轮询。
  useEffect(() => {
    void loadRuns()
  }, [flowId, loadRuns])

  // 选中变化：取 run 详情与 summary（收起时也需要 token / 结论）。
  useEffect(() => {
    selectedCursor.current = null
    selectedFailures.current = 0
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

  // 展开时才拉事件（全量窗口）；收起后不再产生事件请求。
  useEffect(() => {
    if (!open || selectedRunId === '') return
    void loadEvents(selectedRunId, { full: true })
  }, [open, selectedRunId, loadEvents])

  /**
   * page 要求聚焦某个 run（开始运行后自动切到该 run）。
   * 先同步选中值与请求代次，再拉详情；旧 run 的在飞响应立即作废。
   */
  useEffect(() => {
    const id = text(focusRun && focusRun.id, '')
    if (id === '') return
    stateRef.current.selectedRunId = id
    detailRequest.current += 1
    eventsRequest.current += 1
    holdSelection.current = { id, until: Date.now() + 15000 }
    setSelectedRunId(id)
    setSelectedEventKey('')
    setPage(1)
    void loadRuns({ silent: true })
    // nonce 变化时即使 id 相同也重新聚焦（例如对同一个 run 再次点运行）。
  }, [focusRun && focusRun.id, focusRun && focusRun.nonce, loadRuns])

  /** 开始 / 停止后由 page 触发一次强制刷新：立刻拿到新状态与新 run。 */
  useEffect(() => {
    if (!syncToken) return
    void refreshAll({ force: true })
  }, [syncToken, refreshAll])

  /** 后台标签页：document.hidden 时轮询降到 15s（M5）；SSR 不跑 effect。 */
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const update = () => setHidden(document.hidden === true)
    update()
    if (typeof document.addEventListener !== 'function') return undefined
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  /**
   * 活动 run 切人 / 首次出现：重建增量窗口并立刻拉一轮。
   * 选中 run 就是它时不重复拉（选中窗口已经在拉）。
   */
  useEffect(() => {
    watchRequest.current += 1
    watchWindow.current = { runId: watchRunId, events: [], lastSeq: null, total: 0 }
    watchFailures.current = 0
    watchSummaryFor.current = ''
    setWatchDetail(null)
    setWatchSummary(null)
    setWatchEvents([])
    setWatchEventsTotal(0)
    setWatchEventsTruncated(false)
    setWatchError('')
  }, [watchRunId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (watchRunId === '' || watchRunId === selectedRunId) return
    void runWatchRound(watchRunId)
  }, [watchRunId, selectedRunId, runWatchRound])

  /**
   * 活动 run 轮询（M2 + M5）：运行中 2s 一轮、抽屉展开看历史 5s 一轮；
   * 失败按 2s→4s→8s→16s→30s 退避，成功后清零；后台标签页至少 15s。
   * 运行中一轮只拉 `GET /runs/<id>` + since 增量事件，不拉列表、不拉 summary。
   */
  useEffect(() => {
    if (watchRunId === '') return undefined
    if (!watchRunning && !open) return undefined
    let cancelled = false
    let timer = 0
    const schedule = () => {
      const delay = pollDelay({
        failures: watchFailures.current,
        hidden,
        base: watchRunning ? LIVE_POLL_MS : Math.max(1000, num(pollMs, POLL_MS)),
      })
      timer = setTimeout(async () => {
        if (cancelled) return
        await runWatchRound(watchRunId)
        if (!cancelled) schedule()
      }, delay)
    }
    schedule()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [watchRunId, watchRunning, open, hidden, pollMs, runWatchRound])

  /**
   * 抽屉展开且活动 run 已收口（或选中历史 run）时，按 5s 档刷新选中窗口。
   * 运行中的选中 run 由上面的活动 window 负责，这里不重复发请求。
   */
  useEffect(() => {
    if (selectedRunId === '') return undefined
    if (!open) return undefined
    if (watchIsSelected && watchRunning) return undefined
    let cancelled = false
    let timer = 0
    const schedule = () => {
      const delay = pollDelay({
        failures: selectedFailures.current,
        hidden,
        base: Math.max(1000, num(pollMs, POLL_MS)),
      })
      timer = setTimeout(async () => {
        if (cancelled) return
        try {
          await loadDetail(selectedRunId)
          await loadEvents(selectedRunId, { silent: true, full: false })
          selectedFailures.current = 0
        } catch {
          selectedFailures.current += 1
        }
        if (!cancelled) schedule()
      }, delay)
    }
    schedule()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [selectedRunId, open, watchIsSelected, watchRunning, hidden, pollMs, loadDetail, loadEvents])

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

  /**
   * 选中 run 就是活动 run 时把窗口镜像进 watch 状态：用户随后点历史 run 的那一帧，
   * 顶栏 / 画布不会因为 watch 窗口还没拉回来而先闪回空态。
   */
  useEffect(() => {
    if (!watchIsSelected) return
    setWatchDetail(detail)
    setWatchSummary(summary)
    setWatchEvents(events)
    setWatchEventsTotal(eventsTotal)
    setWatchEventsTruncated(eventsTruncated)
  }, [watchIsSelected, detail, summary, events, eventsTotal, eventsTruncated])

  /**
   * 把实时快照回传给 page：顶栏 / 画布叠加层跟「当前流程最近活动 run」走（M2），
   * 抽屉选中哪条历史 run 不影响它们；选中的窗口仍单独回传，供抽屉自己用。
   */
  useEffect(() => {
    if (typeof onRunSnapshot !== 'function') return
    const source = watchIsSelected || watchRunId === ''
      ? { run: feedRun, live: currentLive, summary, events, truncated: eventsTruncated, total: eventsTotal }
      : { run: watchRun, live: watchLive, summary: watchSummary, events: watchEvents, truncated: watchEventsTruncated, total: watchEventsTotal }
    const activeEvents = Array.isArray(source.events) ? source.events : []
    onRunSnapshot({
      run: feedRun,
      runs,
      loaded,
      live: currentLive,
      summary,
      events,
      detail,
      selectedRunId,
      eventsTotal,
      eventsTruncated,
      // 活动 run（运行中优先），与抽屉选中解耦
      activeRun: source.run,
      activeLive: source.live,
      activeSummary: source.summary,
      activeEvents,
      activeEventsTotal: source.total,
      activeEventsTruncated: source.truncated === true,
      activeRunId: source.run ? source.run.id : '',
      watchRunId,
      eventWindowNote: eventWindowNote({ truncated: source.truncated === true, loadedCount: activeEvents.length }),
    })
  }, [
    onRunSnapshot, feedRun, runs, loaded, currentLive, summary, events, detail, selectedRunId,
    eventsTotal, eventsTruncated, watchIsSelected, watchRunId, watchRun, watchLive,
    watchSummary, watchEvents, watchEventsTotal, watchEventsTruncated,
  ])

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

  const tokenInfo = runTokenInfo(feedRun, summary)
  const acceptance = acceptanceOf(summary)
  const metrics = runMetrics(feedRun, summary)
  const conclusion = feedRun ? conclusionOf(feedRun, summary) : null
  // 06 §13.8：桩 run 必须能一眼辨认，badge 同时进 40px 收起条与展开后的头行。
  const stubBadge = stubBadgeOf(summary)
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
  /** 06 §11：`live.currentNodeId` 对应的事件行高亮（文字仍是主通道）。 */
  const liveNodeId = currentLive ? text(currentLive.currentNodeId, '') : ''

  const runTitle = feedRun
    ? feedRun.name
    : runError !== ''
      ? '运行日志读取失败'
      : loaded ? '还没有运行记录' : '正在读取运行记录…'
  const bucket = key => (tokenInfo.missing.includes(key) ? '—' : formatTokens(tokenInfo[key]))
  const tokenLabel = tokenInfo.recorded ? '四段合计 ' + formatTokens(tokenInfo.total) + ' tok' : 'token 未记录'
  const tokenBreakdown = tokenInfo.recorded && tokenInfo.missing.length < 4
    ? '入 ' + bucket('input') + ' · 缓存读 ' + bucket('cacheRead')
      + ' · 缓存写 ' + bucket('cacheWrite') + ' · 出 ' + bucket('output')
    : ''
  const barLabel = feedRun
    ? '运行日志：' + feedRun.name + ' · ' + statusText(runStatusOf(feedRun))
      + ' · ' + acceptance.text + (conclusion ? ' · ' + conclusion.text : '')
      + (stubBadge !== '' ? ' · ' + stubBadge : '')
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
        const meta = statusText(runStatusOf(run))
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
            holdSelection.current = { id: '', until: 0 }
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
      'data-current-node': liveNodeId !== '' && text(event.nodeId, '') === liveNodeId ? 'true' : undefined,
      className: 'fs-log-event' + (index === activeIndex ? ' active' : '')
        + (liveNodeId !== '' && text(event.nodeId, '') === liveNodeId ? ' current' : ''),
      title: (liveNodeId !== '' && text(event.nodeId, '') === liveNodeId ? '当前节点 · ' : '')
        + eventSummary(event),
      onClick: () => {
        setActiveIndex(index)
        setSelectedEventKey(eventKey(event))
      },
    },
    h('span', { className: 'fs-log-glyph', 'aria-hidden': true }, eventGlyph(event.kind)),
    h('span', { className: 'fs-log-ts', title: text(event.ts, '') }, formatEventTime(event.ts)),
    h('span', { className: 'fs-log-kind' }, text(event.kind, '未识别')),
    // m10：当前节点事件行除了左侧竖条，还要有「当前」文字徽标（文字是主通道）。
    liveNodeId !== '' && text(event.nodeId, '') === liveNodeId
      ? h('span', { className: 'fs-log-current-badge' }, '当前')
      : null,
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

  // 展开态明细：五项聚合（04 §3.2）+ token 四段；收起条只留验收通过率。
  const stat = (key, label, value, hint, tone) => h('div', {
    key,
    className: 'fs-stat fs-stat-' + tone,
    title: label + '：' + value + (hint ? '（' + hint + '）' : ''),
  },
  h('span', { className: 'fs-stat-label' }, label),
  h('span', { className: 'fs-stat-value' }, value),
  hint ? h('span', { className: 'fs-stat-hint', title: hint }, hint) : null)

  const stats = !feedRun ? null : h('div', { className: 'fs-log-stats', 'aria-label': '运行指标' },
    stat('acceptance', '验收通过率', metrics.acceptance.valueText,
      '阶段 ' + nodeProgressText(feedRun) + ' · 跳过不计', 'success'),
    stat('duration', '总耗时', metrics.durationText, '运行中走秒，结束定格', 'neutral'),
    stat('tokens', '总 token', metrics.tokens.recorded ? formatTokens(metrics.tokens.total) : '—',
      tokenBreakdown === '' ? tokenLabel : tokenBreakdown, 'brand'),
    stat('p0', 'P0 未解决', metrics.p0, 'P1 ' + metrics.p1 + ' · P2 ' + metrics.p2, 'error'),
    stat('accept-rate', '审查采纳率', metrics.acceptedRateText, '已采纳 / 应回应', 'warn'),
    stat('skills', 'skill 覆盖率', metrics.skillText, metrics.skillHint, 'business'),
    stat('rework', '返工轮次', metrics.reworkText, '打回后重跑', 'neutral'))

  // 收起态 40px（M4）：状态点 + 验收通过率主值 + 结论 pill；token 明细下沉到展开态。
  // m2：状态点与结论 pill 同源（都用 conclusion.tone），不再一个看 run 状态一个看质量。
  const dotTone = conclusion ? conclusion.tone : statusTone(runStatusOf(feedRun || {}))
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
    feedRun
      ? h('span', {
        className: 'fs-log-dot ' + dotTone,
        'aria-hidden': true,
        title: conclusion ? conclusion.text : statusText(runStatusOf(feedRun)),
      })
      : null,
    h('span', { className: 'fs-log-title', title: runTitle }, runTitle),
    feedRun
      ? h('span', {
        className: 'fs-log-main' + (acceptance.missing ? ' missing' : ''),
        title: '验收条目通过率（主值）' + (acceptance.rateText === '' ? '' : ' · ' + acceptance.rateText),
      }, acceptance.text)
      : null,
    feedRun && conclusion
      ? h('span', { className: 'fs-log-pill ' + conclusion.tone, title: conclusion.text }, conclusion.text)
      : null,
    feedRun && stubBadge !== ''
      ? h('span', { className: 'fs-log-pill stub', title: '桩引擎产出：不是真实证据，不能用于质量判断' }, stubBadge)
      : null,
    !feedRun && runError !== ''
      ? h('span', { className: 'fs-log-note', title: runError }, runError)
      : feedRun && runError !== ''
        ? h('span', { className: 'fs-log-note', title: runError }, '刷新失败')
        : null),
    h('div', { className: 'fs-log-actions' },
      !feedRun && !open
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
              download: (feedRun ? feedRun.name : selectedRunId) + '.md',
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
    watchError !== '' && watchRunId !== '' && !watchIsSelected
      ? h('div', { className: 'fs-log-banner', role: 'alert' }, watchError)
      : null,
    feedRun
      ? stats
      : h('div', { className: 'fs-log-stats fs-log-stats-empty' },
        '尚未运行：展开明细会显示验收通过率 / 总耗时 / P0 未解决 / 审查采纳率 / skill 覆盖率 / 返工轮次'),
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
