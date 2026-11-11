/**
 * 工作流健康审计（06 §14）：站在「启动流程的主 agent」的视角，判断整条流水线
 * 是否在正常运转 —— 有没有偏航、卡死、打回死循环、并发乱序，而不是单节点细节。
 *
 * 纯函数：不碰 fs、不 import dsh 包、不 import engine/index；事件只读，
 * 进度与 token 复用 runlog.js 的聚合口径（computeProgress / summarize）。
 *
 * 判据顺序（与 docs/design/06-execution-engine.md §14 一一对应）：
 *   1. run.status==='pending'  → pending；
 *   2. 'done'                  → done（headline 只说流程已完成，不再给质量总评分）；
 *   3. 'failed'                → failed（failedNodeId 或最后一条 node/end failed）；
 *   4. 'aborted'               → aborted；
 *   5. 'running'（主路径）      → concurrency / deviation / reject-loop / stall /
 *                                timeout-risk / no-progress，按优先级收敛成 verdict；
 *   6. 坏输入（flow=null、events 非数组、缺字段）→ 按已知信息降级，绝不抛错。
 *
 * @module @feiyueve/dsh-flow-studio/audit
 */

import { computeProgress, isInstanceScopedEnd, summarize } from './runlog.js'

/** verdict 全集；顺序即「从等不到终态」到「已收口」的阅读顺序。 */
export const AUDIT_VERDICTS = Object.freeze([
  'pending',
  'healthy',
  'stalled',
  'looping',
  'deviating',
  'no-progress',
  'failed',
  'done',
  'aborted',
])

const DEFAULT_STALL_MS = 10 * 60 * 1000
const DEFAULT_NODE_TIMEOUT_MS = 20 * 60 * 1000
/** run 级墙钟上限的默认值（与 engine.js 的 DEFAULT_RUN_TIMEOUT_MS 同口径，2 小时）。 */
const DEFAULT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000
const DEFAULT_MAX_REJECTS_PER_EDGE = 3

/** 显式阈值：只有正整数才算「传了」，其余一律当没传（宁可退回默认，也不拿 0 / NaN 当上限）。 */
function explicitTimeout(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * restart 续跑跳过节点：`run.json.restart.skippedNodeIds`（上次已完成、本次不执行的阶段）。
 * 读路径宽松：非数组 / 坏元素 / 重复一律丢弃，不抛错。
 */
function skippedNodeIdsOf(run) {
  const restart = isObject(run && run.restart) ? run.restart : null
  const out = []
  const seen = new Set()
  for (const raw of asArray(restart && restart.skippedNodeIds)) {
    const nodeId = idOf(raw)
    if (!nodeId || seen.has(nodeId)) continue
    seen.add(nodeId)
    out.push(nodeId)
  }
  return out
}

/** 一次审计的输出有界：事件可以到 20 万条，报告不能跟着涨。 */
const MAX_DEVIATIONS = 50
const MAX_ANOMALIES = 50
const MAX_ACTUAL = 200
const MAX_HEADLINE = 120

/** recommended 与 verdict 一一对应；'inspect' 是「人工/主 agent 看一眼细节」。 */
const RECOMMENDED = Object.freeze({
  pending: 'inspect',
  healthy: 'wait',
  stalled: 'inspect',
  looping: 'stop',
  deviating: 'stop',
  'no-progress': 'inspect',
  failed: 'report',
  done: 'report',
  aborted: 'report',
})

/** 下次唤醒间隔（秒）：终态不再查，异常 60s 复查，正常 180s。 */
const NEXT_CHECK_SECONDS = Object.freeze({
  pending: 30,
  healthy: 180,
  stalled: 60,
  looping: 60,
  deviating: 60,
  'no-progress': 60,
  failed: null,
  done: null,
  aborted: null,
})

const KNOWN_STATUS = new Set(['pending', 'running', 'done', 'failed', 'aborted'])

// ---------------------------------------------------------------------------
// 输入收敛：任何字段都可能缺失 / 类型不对，这里只做读取，不做假设。
// ---------------------------------------------------------------------------

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function idOf(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

function textOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function finitePositive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** now 接受毫秒数或 Date；非法值退回当前墙钟，保证纯函数在测试里可注入。 */
function normalizeNow(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime()
  return Date.now()
}

/** 事件 ts → 毫秒；解析不了就是 null（不拿 0 冒充有效时间）。 */
function timeOf(event) {
  if (!event || typeof event.ts !== 'string') return null
  const ms = Date.parse(event.ts)
  return Number.isFinite(ms) ? ms : null
}

function sequenceOf(event) {
  return event && Number.isInteger(event.seq) ? event.seq : 0
}

/** 按 seq 升序；seq 相同按 ts，再相同保持原顺序（与 runlog 的稳定排序同口径）。 */
function sortEvents(events) {
  const indexed = events.map((event, index) => ({ event, index }))
  indexed.sort((left, right) => {
    const sl = sequenceOf(left.event)
    const sr = sequenceOf(right.event)
    if (sl !== sr) return sl - sr
    const tl = timeOf(left.event)
    const tr = timeOf(right.event)
    if (tl !== null && tr !== null && tl !== tr) return tl - tr
    if (tl === null && tr !== null) return 1
    if (tl !== null && tr === null) return -1
    return left.index - right.index
  })
  return indexed.map(entry => entry.event)
}

/** 中文可读时长；阈值都是分钟级，不需要毫秒精度。 */
function durationText(ms) {
  const minutes = Math.max(0, ms) / 60000
  if (minutes >= 90) return `${(minutes / 60).toFixed(1)} 小时`
  if (minutes >= 1) return `${Math.round(minutes)} 分钟`
  return `${Math.max(1, Math.round(ms / 1000))} 秒`
}

/** 一句话结论必须能直接贴给用户：按码点截断，保留省略号。 */
function clipHeadline(text) {
  const chars = Array.from(String(text))
  if (chars.length <= MAX_HEADLINE) return chars.join('')
  return `${chars.slice(0, MAX_HEADLINE - 1).join('')}…`
}

/** 报告里的标题：模板优先，其次 node/start.data.title，最后退回 id。 */
function makeTitleLookup(template, sorted) {
  const titles = new Map(template.titles)
  for (const event of sorted) {
    if (!event || event.kind !== 'node/start') continue
    const nodeId = idOf(event.nodeId)
    if (!nodeId || titles.has(nodeId)) continue
    const title = textOf(event.data && event.data.title)
    if (title) titles.set(nodeId, title)
  }
  return id => {
    const nodeId = idOf(id)
    if (!nodeId) return '未知节点'
    if (nodeId === '(unknown)') return '未知节点'
    return titles.get(nodeId) || nodeId
  }
}

// ---------------------------------------------------------------------------
// 模板：把 normalizeFlow 的 nodes/edges 收敛成「正常链路」与「下一阶段」。
// ---------------------------------------------------------------------------

function kindOfNode(node) {
  if (!isObject(node)) return 'stage'
  if (node.kind === 'start' || node.kind === 'end') return node.kind
  return 'stage'
}

/**
 * 正常序列 = 从 start 节点沿 next 边一直走到 end 的阶段节点序列。
 * 引擎保证每个非 end 节点恰好一条 next 出边；这里再套一层环保护，
 * 坏模板（多个 start / 断头路 / 成环）只降级成较短链路，不抛错。
 */
function buildTemplate(flow) {
  const nodes = asArray(flow && flow.nodes).filter(node => isObject(node) && idOf(node.id))
  const edges = asArray(flow && flow.edges)
    .filter(edge => isObject(edge) && idOf(edge.from) && idOf(edge.to))

  const byId = new Map()
  const titles = new Map()
  const stageIds = []
  for (const node of nodes) {
    byId.set(node.id, node)
    const title = textOf(node.title)
    if (title) titles.set(node.id, title)
    if (kindOfNode(node) === 'stage') stageIds.push(node.id)
  }

  // next 只取第一条；validateFlow 已保证不会有多出边，这里只防御手写坏数据。
  const nextFrom = new Map()
  for (const edge of edges) {
    if (edge.kind !== 'next') continue
    if (!nextFrom.has(edge.from)) nextFrom.set(edge.from, edge.to)
  }

  const startNode = nodes.find(node => node.kind === 'start')
    || nodes.find(node => !edges.some(edge => edge.kind === 'next' && edge.to === node.id))
    || nodes[0]
    || null

  const nextStageId = fromId => {
    const seen = new Set([fromId])
    let cursor = fromId
    for (let guard = 0; guard < 200; guard += 1) {
      const next = nextFrom.get(cursor)
      if (!next || seen.has(next)) return null
      seen.add(next)
      const target = byId.get(next)
      if (!target) return null
      const kind = kindOfNode(target)
      if (kind === 'end') return null
      if (kind === 'stage') return next
      cursor = next
    }
    return null
  }

  const chain = []
  if (startNode) {
    let cursor = startNode.id
    // 正常流程从 start 开始；没有 start 节点时把入口阶段本身算进链路。
    if (kindOfNode(startNode) === 'stage') chain.push(cursor)
    const seen = new Set([cursor])
    for (let guard = 0; guard < 200; guard += 1) {
      const next = nextFrom.get(cursor)
      if (!next || seen.has(next)) break
      seen.add(next)
      const target = byId.get(next)
      if (!target) break
      const kind = kindOfNode(target)
      if (kind === 'end') break
      if (kind === 'stage') chain.push(next)
      cursor = next
    }
  }

  return {
    nodes,
    edges,
    byId,
    titles,
    stageIds,
    chain,
    kindOf: nodeId => kindOfNode(byId.get(nodeId)),
    nextStageId,
  }
}

// ---------------------------------------------------------------------------
// run 元数据：状态、开始时间、失败坐标。
// ---------------------------------------------------------------------------

/** run.status 原样优先；缺失时从事件流兜底（坏输入也要能给结论）。 */
function resolveStatus(run, sorted) {
  const reported = run && typeof run.status === 'string' ? run.status : null
  if (reported && KNOWN_STATUS.has(reported)) return { reported, effective: reported }

  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const event = sorted[index]
    if (!event || event.kind !== 'run/end' || !isObject(event.data)) continue
    if (isInstanceScopedEnd(event)) continue
    if (event.data.status === 'done' || event.data.status === 'failed' || event.data.status === 'aborted') {
      return { reported, effective: event.data.status }
    }
  }
  for (const event of sorted) {
    if (!event) continue
    if (event.kind === 'run/start' || event.kind === 'node/start' || event.kind === 'node/end') {
      return { reported, effective: 'running' }
    }
  }
  return { reported, effective: 'pending' }
}

/** run 开始时间：startedAt → createdAt → 第一条事件的 ts。 */
function runStartMs(run, sorted) {
  for (const key of ['startedAt', 'createdAt']) {
    const raw = run && run[key]
    if (typeof raw !== 'string') continue
    const ms = Date.parse(raw)
    if (Number.isFinite(ms)) return ms
  }
  for (const event of sorted) {
    const ms = timeOf(event)
    if (ms !== null) return ms
  }
  return null
}

/** failed 节点与原因：run.failedNodeId 优先，其次最后一条 node/end{status:'failed'}。 */
function findFailure(run, sorted) {
  let nodeId = idOf(run && run.failedNodeId)
  let reason = null
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const event = sorted[index]
    if (!event || !isObject(event.data)) continue
    if (event.kind === 'run/end' && !isInstanceScopedEnd(event) && event.data.status === 'failed' && reason === null) {
      reason = textOf(event.data.reason)
    }
    if (event.kind === 'node/end' && event.data.status === 'failed') {
      if (nodeId === null) nodeId = idOf(event.nodeId)
      if (reason === null) {
        reason = textOf(event.extra && event.extra.reason) || textOf(event.data.reason)
      }
    }
    if (nodeId !== null && reason !== null) break
  }
  return { nodeId, reason }
}

// ---------------------------------------------------------------------------
// 审计主体
// ---------------------------------------------------------------------------

/**
 * 工作流级健康审计。
 *
 * @param {object} input
 * @param {object|null} input.flow normalizeFlow 后的流程模板（nodes/edges）
 * @param {object[]} input.events runlog 事件数组（node/start、node/end、reject/trigger…）
 * @param {object|null} input.run run.json（status/startedAt/endedAt/failedNodeId…）
 * @param {number|Date} [input.now=Date.now()]
 * @param {number} [input.stallMs=600000] 多久没新事件算卡死
 * @param {number} [input.nodeTimeoutMs] 单节点超过多久算「有时限风险」。
 *   取值链：显式参数 > `input.run.limits.nodeTimeoutMs` > 默认 1200000（20 分钟）。
 *   下沉到审计内部是为了覆盖所有调用方：flow_watch 与引擎侧 supervision 都不会因为
 *   忘记传阈值而把一个配了 30 分钟的节点按 20 分钟判超时。
 * @param {number} [input.runTimeoutMs] 整轮 run 的墙钟上限，只用于报告/判定依据；
 *   取值链同上（`input.run.limits.runTimeoutMs` > 默认 7200000）。
 * @param {'run'|'default'} [input.thresholdSource] 阈值来源（run.json.limits / 默认值），
 *   省略时按「显式传了 / run.limits 里有」推断
 * @param {number} [input.maxRejectsPerEdge=3] 同一条打回边触发几次算死循环
 * @returns {object} 字段契约见 06 §14（verdict/status/headline/progress/plan/…）
 */
export function auditWorkflow(input) {
  const options = isObject(input) ? input : {}
  try {
    return inspect(options)
  } catch {
    // 审计是定时唤醒的旁路，坏数据只能降级，不能把主 agent 叫醒流程打断。
    const run = isObject(options.run) ? options.run : null
    return emptyResult({
      verdict: 'pending',
      status: run && typeof run.status === 'string' ? run.status : null,
      headline: '审计无法完成：输入数据异常，建议人工查看 run.json 与事件流',
    })
  }
}

/** 兜底结果：字段齐全、能读，缺的全给空值。 */
function emptyResult({ verdict, status, headline }) {
  return {
    verdict,
    status: status ?? null,
    headline: clipHeadline(headline),
    progress: { passed: 0, total: 0, ratio: null, skipped: [], skippedCount: 0, nodes: [] },
    plan: { expected: [], actual: [], deviations: [] },
    currentNode: null,
    rejects: { total: 0, byNode: [], looped: [] },
    anomalies: [],
    tokens: null,
    idleMs: 0,
    thresholds: {
      stallMs: DEFAULT_STALL_MS,
      nodeTimeoutMs: DEFAULT_NODE_TIMEOUT_MS,
      runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
      source: 'default',
    },
    recommended: RECOMMENDED[verdict] || 'inspect',
    nextCheckSeconds: NEXT_CHECK_SECONDS[verdict] ?? null,
  }
}

/** run.json.limits 的宽松读数：只认正整数（读路径不猜、不补 0）。 */
function runLimitTimeout(run, key) {
  const limits = isObject(run && run.limits) ? run.limits : null
  return explicitTimeout(limits && limits[key])
}

function inspect(options) {
  const nowMs = normalizeNow(options.now)
  const stallMs = finitePositive(options.stallMs, DEFAULT_STALL_MS)
  // 阈值来源链：显式 options > run.json.limits > 默认。
  // 下沉到这里的理由：引擎侧 supervision（runtime 的 evaluate）也调 auditWorkflow，
  // 它只传 run，不传阈值；来源留在调用方就会让「30 分钟的节点被 20 分钟默认值判超时」
  // 在另一条路径上原样存活。
  const run = isObject(options.run) ? options.run : null
  const explicitNodeTimeoutMs = explicitTimeout(options.nodeTimeoutMs)
  const explicitRunTimeoutMs = explicitTimeout(options.runTimeoutMs)
  const limitNodeTimeoutMs = runLimitTimeout(run, 'nodeTimeoutMs')
  const limitRunTimeoutMs = runLimitTimeout(run, 'runTimeoutMs')
  const nodeTimeoutMs = explicitNodeTimeoutMs ?? limitNodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS
  const runTimeoutMs = explicitRunTimeoutMs ?? limitRunTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  const maxRejectsPerEdge = finitePositive(options.maxRejectsPerEdge, DEFAULT_MAX_REJECTS_PER_EDGE)
  // 阈值来源：调用方显式声明优先；否则「显式传了 / run.json.limits 里有」都算 run 来源。
  const fromRunLimits = limitNodeTimeoutMs !== null || limitRunTimeoutMs !== null
  const thresholdSource = options.thresholdSource === 'run' || options.thresholdSource === 'default'
    ? options.thresholdSource
    : (explicitNodeTimeoutMs !== null || explicitRunTimeoutMs !== null || fromRunLimits ? 'run' : 'default')
  const thresholds = {
    stallMs,
    nodeTimeoutMs,
    runTimeoutMs,
    source: thresholdSource,
  }

  const flow = isObject(options.flow) ? options.flow : null
  const sorted = sortEvents(asArray(options.events).filter(event => isObject(event)))

  // restart 续跑：上次已完成、本次跳过的阶段 —— 既不算未执行，也不算偏航。
  const skipped = skippedNodeIdsOf(run)
  const skippedSet = new Set(skipped)

  const template = buildTemplate(flow)
  const titleOf = makeTitleLookup(template, sorted)
  const { reported, effective } = resolveStatus(run, sorted)
  // status 按契约「run.status 原样」：元数据缺失就是 null，不拿推断值冒充。
  const status = reported

  // -- 全局时间口径 --------------------------------------------------------
  let lastEventMs = null
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const ms = timeOf(sorted[index])
    if (ms !== null) {
      lastEventMs = ms
      break
    }
  }
  const startedMs = runStartMs(run, sorted)
  const idleMs = Math.max(0, nowMs - (lastEventMs ?? startedMs ?? nowMs))
  const elapsedRunMs = startedMs === null ? 0 : Math.max(0, nowMs - startedMs)

  // -- 进度（runlog 同口径） ----------------------------------------------
  let rawProgress = null
  try {
    rawProgress = computeProgress(sorted)
  } catch {
    rawProgress = null
  }
  const progressMap = rawProgress && isObject(rawProgress.nodes) ? rawProgress.nodes : {}
  const observedIds = []
  const seenObserved = new Set()
  for (const event of sorted) {
    if (!event) continue
    if (event.kind !== 'node/start' && event.kind !== 'node/end') continue
    const nodeId = idOf(event.nodeId)
    if (!nodeId || seenObserved.has(nodeId)) continue
    seenObserved.add(nodeId)
    observedIds.push(nodeId)
  }
  const stageIds = template.chain.length > 0 ? template.chain : template.stageIds
  const progressIds = [...stageIds]
  for (const nodeId of observedIds) {
    if (!progressIds.includes(nodeId)) progressIds.push(nodeId)
  }
  const observedTotal = rawProgress && Number.isInteger(rawProgress.total) ? rawProgress.total : 0
  const total = observedTotal > 0 ? observedTotal : progressIds.length
  const passed = rawProgress && Number.isInteger(rawProgress.passed) ? rawProgress.passed : 0
  const skippedCount = skipped.length
  // 分母 = 节点总数 − restart 跳过数（跳过节点本次不执行，不能拉低进度）；
  // 没有 restart 时 denominator === total，与既有口径完全一致。
  const baseDenominator = rawProgress && Number.isInteger(rawProgress.denominator)
    ? rawProgress.denominator
    : total
  const denominator = Math.max(0, baseDenominator - skippedCount)
  let ratio = rawProgress && typeof rawProgress.ratio === 'number' ? rawProgress.ratio : null
  if (skippedCount > 0) {
    ratio = denominator === 0 ? null : Math.min(1, passed / denominator)
  } else if (ratio === null && observedTotal > 0) {
    ratio = Math.min(1, passed / denominator)
  }

  const progressNodes = progressIds.map(nodeId => {
    const entry = progressMap[nodeId]
    // restart 跳过的阶段：本次不会执行，标 skipped（不是 pending / 未执行）。
    let state = skippedSet.has(nodeId) ? 'skipped' : 'pending'
    let attempt = 0
    if (entry) {
      attempt = Number.isInteger(entry.attemptId) ? entry.attemptId : 0
      if (entry.status === 'pending') {
        // runlog 把「已 node/start 未 node/end」记成 pending；审计里明确叫 running。
        state = 'running'
      } else if (entry.status === 'passed' && entry.invalidated === true) {
        state = 'invalidated'
      } else if (typeof entry.status === 'string') {
        state = entry.status
      }
    }
    return { id: nodeId, title: titleOf(nodeId), state, attempt }
  })
  const progressResult = {
    passed,
    total,
    ratio,
    skipped: skipped.slice(),
    skippedCount,
    nodes: progressNodes,
  }

  // -- 打开中的节点：并发判定 + 当前节点 + 节点空闲 ------------------------
  const open = new Map()
  const lastEventAtByNode = new Map()
  let concurrency = null
  for (const event of sorted) {
    if (!event) continue
    const nodeId = idOf(event.nodeId)
    const ts = timeOf(event)
    if (nodeId && ts !== null) {
      const previous = lastEventAtByNode.get(nodeId)
      if (previous === undefined || ts > previous) lastEventAtByNode.set(nodeId, ts)
    }
    if (!nodeId) continue
    const attempt = Number.isInteger(event.attemptId) ? event.attemptId : 1
    const key = `${nodeId}\u0000${attempt}`
    if (event.kind === 'node/start') {
      open.set(key, { nodeId, attempt, at: ts ?? nowMs })
      if (concurrency === null && open.size >= 2) {
        const titles = [...open.values()].map(item => `「${titleOf(item.nodeId)}」`).join('')
        concurrency = {
          kind: 'concurrency',
          nodeId,
          detail: `${titles}同时处于运行中（${open.size} 个节点未结束；引擎设计为串行，出现即 bug）`,
        }
      }
    } else if (event.kind === 'node/end') {
      open.delete(key)
    }
  }

  let currentNode = null
  if (effective === 'running' && open.size > 0) {
    let latest = null
    for (const entry of open.values()) {
      if (!latest || entry.at >= latest.at) latest = entry
    }
    if (latest) {
      const lastNodeMs = lastEventAtByNode.get(latest.nodeId)
      currentNode = {
        id: latest.nodeId,
        title: titleOf(latest.nodeId),
        attempt: latest.attempt,
        elapsedMs: Math.max(0, nowMs - latest.at),
        idleMs: Math.max(0, nowMs - (lastNodeMs ?? latest.at)),
      }
    }
  }

  // -- 打回计数：按边与被打回节点各一份；超阈值进 looped ------------------
  const rejectsByNode = new Map()
  const rejectsByEdge = new Map()
  let rejectsTotal = 0
  for (const event of sorted) {
    if (!event || event.kind !== 'reject/trigger') continue
    rejectsTotal += 1
    const data = isObject(event.data) ? event.data : {}
    const fromNodeId = idOf(data.fromNodeId)
    const toNodeId = idOf(data.toNodeId)
    const edgeId = idOf(data.edgeId)
    const edgeKey = fromNodeId && toNodeId
      ? `${fromNodeId}\u0000${toNodeId}`
      : `${edgeId || '(unknown)'}\u0000${rejectsTotal}`
    const record = rejectsByEdge.get(edgeKey) || {
      edgeId,
      fromNodeId,
      toNodeId,
      count: 0,
    }
    record.count += 1
    if (edgeId && !record.edgeId) record.edgeId = edgeId
    rejectsByEdge.set(edgeKey, record)

    const target = toNodeId || '(unknown)'
    rejectsByNode.set(target, (rejectsByNode.get(target) || 0) + 1)
  }

  const byNode = [...rejectsByNode.entries()]
    .map(([nodeId, count]) => ({ nodeId, title: titleOf(nodeId), count }))
    .sort((left, right) => (right.count - left.count) || left.nodeId.localeCompare(right.nodeId))

  // 同一条打回边（from→to）超阈值即死循环；looped 按被打回节点汇总，count 取最大边计数。
  const loopedByNode = new Map()
  for (const edge of rejectsByEdge.values()) {
    if (edge.count <= maxRejectsPerEdge) continue
    const nodeId = edge.toNodeId || '(unknown)'
    const previous = loopedByNode.get(nodeId)
    if (!previous || edge.count > previous.count) {
      loopedByNode.set(nodeId, { nodeId, title: titleOf(nodeId), count: edge.count })
    }
  }
  const looped = [...loopedByNode.values()]
    .sort((left, right) => (right.count - left.count) || left.nodeId.localeCompare(right.nodeId))

  // -- 偏航：node/start 序列对照模板 next 链；打回后从 to 重新开始 ---------
  //
  // restart 续跑的 run 不是从流程第一个阶段起跑：`restart.skippedNodeIds` 里的阶段
  // 上次已经完成、本次不执行。所以「预期链」要扣掉它们，否则「从第 4 阶段续跑」会被
  // 判成「跳过前 3 个阶段」（误报 deviating + recommended=stop）。
  const expected = template.chain.filter(nodeId => !skippedSet.has(nodeId))
  const chainKnown = expected.length > 0
  let expectedNext = chainKnown ? expected[0] : null
  // next 边可能指向被跳过的阶段：继续沿链前进到下一个本次真正要跑的阶段。
  const nextExpectedAfter = fromId => {
    let cursor = fromId
    const walked = new Set([fromId])
    for (let guard = 0; guard < 200; guard += 1) {
      const next = template.nextStageId(cursor)
      if (!next || walked.has(next)) return null
      walked.add(next)
      if (!skippedSet.has(next)) return next
      cursor = next
    }
    return null
  }
  const actual = []
  const deviations = []
  const seenStarts = new Set()
  for (const event of sorted) {
    if (!event) continue
    if (event.kind === 'reject/trigger') {
      const toNodeId = isObject(event.data) ? idOf(event.data.toNodeId) : null
      // 打回目标是合法「重新开始」：下一条 node/start 落到 to 上不算偏航。
      // 打回落到「本次跳过」的节点时忽略（它不会在本 run 里重新执行）。
      if (chainKnown && toNodeId && !skippedSet.has(toNodeId)) expectedNext = toNodeId
      continue
    }
    if (event.kind !== 'node/start') continue
    const nodeId = idOf(event.nodeId)
    if (!nodeId) continue
    const attempt = Number.isInteger(event.attemptId) ? event.attemptId : 1
    const startKey = `${nodeId}\u0000${attempt}`
    // 同一 attempt 的重试会再写一条 node/start（06 §9），不能算两阶段、也不能算偏航。
    if (seenStarts.has(startKey)) continue
    seenStarts.add(startKey)
    // restart 跳过节点不是「未执行」：不推进 actual、不生成 deviation。
    if (skippedSet.has(nodeId)) continue
    if (chainKnown && template.byId.has(nodeId)) {
      const kind = template.kindOf(nodeId)
      if (kind !== 'stage') continue
    }
    actual.push(nodeId)
    if (!chainKnown) continue

    if (expectedNext === null) {
      if (deviations.length < MAX_DEVIATIONS) {
        deviations.push({
          index: actual.length - 1,
          nodeId,
          expected: null,
          reason: `阶段链已走完，仍开始了「${titleOf(nodeId)}」`,
        })
      }
      expectedNext = nextExpectedAfter(nodeId)
      continue
    }

    if (nodeId !== expectedNext) {
      const expectedIndex = expected.indexOf(expectedNext)
      const actualIndex = expected.indexOf(nodeId)
      let reason
      if (actualIndex === -1) {
        reason = `「${titleOf(nodeId)}」不在模板正常链路上（预期「${titleOf(expectedNext)}」）`
      } else if (expectedIndex === -1) {
        reason = `预期节点「${titleOf(expectedNext)}」不在正常链路上`
      } else if (actualIndex > expectedIndex) {
        reason = `跳过中间阶段，从「${titleOf(expectedNext)}」直接开始「${titleOf(nodeId)}」`
      } else {
        reason = `没有打回却回退到「${titleOf(nodeId)}」（预期「${titleOf(expectedNext)}」）`
      }
      if (deviations.length < MAX_DEVIATIONS) {
        deviations.push({ index: actual.length - 1, nodeId, expected: expectedNext, reason })
      }
      // 偏航时以实际节点重新对齐，避免一次跳过把后面整条链都算成偏航。
      expectedNext = nextExpectedAfter(nodeId)
      continue
    }
    expectedNext = nextExpectedAfter(nodeId)
  }

  // -- token：有事件才复用 summarize（终态与运行中都可算） -------------------
  let summary = null
  if (sorted.length > 0) {
    try {
      const summaryOptions = { now: new Date(nowMs) }
      if (run && (run.engine === 'stub' || run.engine === 'real')) summaryOptions.engine = run.engine
      summary = summarize(sorted, summaryOptions)
    } catch {
      summary = null
    }
  }
  const tokens = summary && isObject(summary.tokens) ? summary.tokens : null

  // -- 终态：先收口，不再拿运行期异常改 verdict --------------------------
  if (effective !== 'running') {
    const terminal = terminalResult({
      effective,
      status,
      tokens,
      sorted,
      nowMs,
      run,
      titleOf,
      progress: progressResult,
      plan: { expected, actual: actual.slice(0, MAX_ACTUAL), deviations },
      rejects: { total: rejectsTotal, byNode, looped },
      currentNode,
      idleMs,
      thresholds,
    })
    return terminal
  }

  // -- running 主路径：按判据顺序收集异常 ---------------------------------
  const anomalies = []
  const addAnomaly = anomaly => {
    if (anomalies.length < MAX_ANOMALIES) anomalies.push(anomaly)
  }

  if (concurrency) addAnomaly(concurrency)
  for (const deviation of deviations) {
    addAnomaly({ kind: 'deviation', nodeId: deviation.nodeId, detail: deviation.reason })
  }
  for (const item of looped) {
    const edge = [...rejectsByEdge.values()]
      .filter(candidate => candidate.toNodeId === item.nodeId && candidate.count > maxRejectsPerEdge)
      .sort((left, right) => right.count - left.count)[0]
    const fromText = edge && edge.fromNodeId ? `「${titleOf(edge.fromNodeId)}」→` : ''
    addAnomaly({
      kind: 'reject-loop',
      nodeId: item.nodeId,
      detail: `${fromText}「${item.title}」累计打回 ${item.count} 次（单边上限 ${maxRejectsPerEdge} 次）`,
    })
  }

  const stalled = idleMs > stallMs
  const timeoutRisk = Boolean(currentNode && currentNode.elapsedMs > nodeTimeoutMs)
  const noProgress = ratio === 0 && elapsedRunMs > stallMs

  if (stalled) {
    addAnomaly({
      kind: 'stall',
      ...(currentNode ? { nodeId: currentNode.id } : {}),
      detail: `已 ${durationText(idleMs)} 无新事件（阈值 ${durationText(stallMs)}），run 仍为 running`,
    })
  }
  if (timeoutRisk && currentNode) {
    // 阈值必须写「这次实际用的值」：run.json.limits 与默认值可能差很多（例如 30 分钟 vs 20 分钟）。
    const sourceText = thresholdSource === 'run' ? 'run.json.limits' : '默认值'
    addAnomaly({
      kind: 'timeout-risk',
      nodeId: currentNode.id,
      detail: `节点「${currentNode.title}」已运行 ${durationText(currentNode.elapsedMs)}`
        + `（阈值 ${durationText(nodeTimeoutMs)}，来源 ${sourceText}）`,
    })
  }
  if (noProgress) {
    // 只说明「还没跑完一个阶段」，同时把已观测事实写清楚：事件还在流时不是「卡住了」。
    const idleText = idleMs < stallMs
      ? (idleMs === 0
        ? '事件仍在流（idle=0）'
        : `事件仍在流（idle=${Math.round(idleMs / 1000)} 秒，最近仍有新事件）`)
      : `最近 ${durationText(idleMs)} 无新事件`
    addAnomaly({
      kind: 'no-progress',
      detail: `已运行 ${durationText(elapsedRunMs)}，完成 ${passed}/${total} 阶段（ratio=0；`
        + `无进展判定阈值 ${durationText(stallMs)}）；${idleText}`,
    })
  }

  // verdict 优先级（06 §14）：deviating > looping > stalled > no-progress > healthy。
  // timeout-risk 归入 stalled 类（再等下去就是超时失败），headline 里写清是哪一种。
  let verdict = 'healthy'
  if (concurrency || deviations.length > 0) verdict = 'deviating'
  else if (looped.length > 0) verdict = 'looping'
  else if (stalled || timeoutRisk) verdict = 'stalled'
  else if (noProgress) verdict = 'no-progress'

  const headline = runningHeadline({
    verdict,
    concurrency,
    deviations,
    looped,
    stalled,
    timeoutRisk,
    noProgress,
    currentNode,
    idleMs,
    stallMs,
    nodeTimeoutMs,
    thresholdSource,
    elapsedRunMs,
    passed,
    total,
    titleOf,
  })

  return {
    verdict,
    status,
    headline: clipHeadline(headline),
    progress: progressResult,
    plan: {
      expected,
      actual: actual.slice(0, MAX_ACTUAL),
      deviations,
    },
    currentNode,
    rejects: { total: rejectsTotal, byNode, looped },
    anomalies,
    tokens,
    idleMs,
    thresholds,
    recommended: RECOMMENDED[verdict],
    nextCheckSeconds: NEXT_CHECK_SECONDS[verdict],
  }
}

/** pending / done / failed / aborted：状态本身就是结论，不再看运行期异常。 */
function terminalResult(context) {
  const {
    effective, status, tokens, sorted, nowMs, run, titleOf,
    progress, plan, rejects, currentNode, idleMs, thresholds,
  } = context
  const anomalies = []
  let headline = ''

  if (effective === 'pending') {
    headline = 'run 已建好但还没开始'
  } else if (effective === 'done') {
    headline = '流程已完成（业务证据见实例证据页签；不产出质量总评分）'
  } else if (effective === 'failed') {
    const failure = findFailure(run, sorted)
    if (failure.nodeId) {
      const suffix = failure.reason ? `——${failure.reason}` : ''
      headline = `流程失败：节点「${titleOf(failure.nodeId)}」(${failure.nodeId}) 失败${suffix}`
      anomalies.push({
        kind: 'failed',
        nodeId: failure.nodeId,
        detail: failure.reason || '节点执行失败（事件未记录原因）',
      })
    } else {
      headline = failure.reason ? `流程失败：${failure.reason}` : '流程失败：事件未记录失败节点与原因'
      anomalies.push({ kind: 'failed', detail: failure.reason || '事件未记录失败节点与原因' })
    }
  } else {
    // aborted
    let reason = null
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const event = sorted[index]
      if (!event || event.kind !== 'run/end' || !isObject(event.data)) continue
      if (isInstanceScopedEnd(event)) continue
      if (event.data.status === 'aborted') {
        reason = textOf(event.data.reason)
        break
      }
    }
    headline = reason ? `流程已中止：${reason}` : '流程已中止（已停止）'
  }

  return {
    verdict: effective,
    status,
    headline: clipHeadline(headline),
    progress,
    plan,
    currentNode: effective === 'running' ? currentNode : null,
    rejects,
    anomalies,
    tokens,
    idleMs,
    thresholds,
    recommended: RECOMMENDED[effective],
    nextCheckSeconds: NEXT_CHECK_SECONDS[effective],
  }
}

/** running 的一句话结论：必须写清「哪一类异常、哪个节点」。 */
function runningHeadline(context) {
  const {
    verdict, concurrency, deviations, looped, stalled, timeoutRisk, noProgress,
    currentNode, idleMs, stallMs, nodeTimeoutMs, thresholdSource, elapsedRunMs, passed, total, titleOf,
  } = context

  if (verdict === 'deviating') {
    const parts = []
    if (concurrency) parts.push(`并发 ${concurrency.detail}`)
    if (deviations.length > 0) {
      const first = deviations[0]
      const expectedText = first.expected === null ? '阶段链已走完' : `预期「${titleOf(first.expected)}」`
      parts.push(`${expectedText}，实际开始「${titleOf(first.nodeId)}」`)
      if (deviations.length > 1) parts.push(`另有 ${deviations.length - 1} 处偏航`)
    }
    return `流程偏航：${parts.join('；')}`
  }

  if (verdict === 'looping') {
    const first = looped[0]
    const targetText = first ? `节点「${first.title}」` : '某节点'
    const countText = first ? `已打回 ${first.count} 次` : ''
    const moreText = looped.length > 1 ? `（共 ${looped.length} 条边超限）` : ''
    return `打回死循环：${targetText}${countText}，建议人工确认是否放宽轮次或修上游${moreText}`
  }

  if (verdict === 'stalled') {
    const parts = []
    if (stalled) {
      const where = currentNode ? `节点「${currentNode.title}」已` : '整个 run 已'
      parts.push(`${where} ${durationText(idleMs)} 无新事件（阈值 ${durationText(stallMs)}）`)
    }
    if (timeoutRisk && currentNode) {
      const sourceText = thresholdSource === 'run' ? 'run.json.limits' : '默认值'
      parts.push(`节点「${currentNode.title}」已运行 ${durationText(currentNode.elapsedMs)}`
        + `（超时阈值 ${durationText(nodeTimeoutMs)}，来源 ${sourceText}）`)
    }
    return `疑似卡死：${parts.join('；')}`
  }

  if (verdict === 'no-progress') {
    const idleText = idleMs < stallMs ? '，事件仍在流' : ''
    return `无进展：已运行 ${durationText(elapsedRunMs)}，完成 ${passed}/${total} 阶段（还没跑完一个节点${idleText}）`
  }

  if (currentNode) {
    return `工作流正常推进：当前「${currentNode.title}」第 ${currentNode.attempt} 次尝试，已完成 ${passed}/${total} 阶段`
  }
  if (total > 0) return `工作流正常：已完成 ${passed}/${total} 阶段，事件流未见异常`
  return '工作流正常：事件流未见异常'
}
