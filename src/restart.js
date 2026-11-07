/**
 * 失败 / 中止后的「续跑计划」（v0.9.2 前置 · 任务 3）。
 *
 * 这里只做**只读推导**：从旧 run 的事件流与当前流程结构算出
 *   - 从哪个阶段节点继续（旧 run 失败 / 中止时正在跑的那个节点）；
 *   - 哪些阶段节点已经通过（新 run 不重跑，作为上游上下文注入）；
 *   - 每个已完成节点的 summary / artifactPaths（从旧 run 的 summary.json 读回）。
 *
 * 真正的「建新 run → 复制 sessions.json → engine.start」在 `runtime.restart()` 里，
 * 这样本模块保持无副作用、可单测，也不会和 runtime / engine 形成循环依赖。
 *
 * 设计取舍：restart = **新 run**（不是同一 run 的 continuation）。理由见
 * `docs/reference/host-api.md` §「失败后重启」：旧 run 的终态必须保持不可改写，
 * 新 run 有自己的事件流 / 租约 / supervision，审计上能一眼看出「第几次续跑」。
 *
 * @module @feiyueve/dsh-flow-studio/restart
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { selectFirstNode, selectNextNode } from './engine.js'
import { NODE_KIND } from './model.js'
import { RunError, readAllEvents, readRunMeta } from './runstore.js'
import { isInstanceScopedEnd } from './runlog.js'

/** 允许重启的旧 run 终态（done 已成功，running 还在跑，都不重启）。 */
export const RESTARTABLE_STATUSES = new Set(['failed', 'aborted'])

/**
 * 校验旧 run 是否可重启。
 * @param {object|null} meta
 * @param {string} runId
 * @returns {object} meta（非空）
 */
export function assertRestartable(meta, runId = '') {
  if (!meta) throw new RunError(404, 'runId', `run 不存在（${runId}）`)
  if (!RESTARTABLE_STATUSES.has(meta.status)) {
    if (meta.status === 'running' || meta.status === 'pending') {
      throw new RunError(
        400,
        'restart',
        `run 还没结束（当前 ${meta.status}），不能重启：先等它收尾（或 stop）再续跑`,
      )
    }
    throw new RunError(
      400,
      'restart',
      `run 已成功结束（${meta.status}），不需要重启；要重跑请复制流程另建 run（避免改写历史结论）`,
    )
  }
  return meta
}

/** 节点 id → 节点对象（当前流程）。 */
function byIdMap(flow) {
  const map = new Map()
  for (const node of flow && Array.isArray(flow.nodes) ? flow.nodes : []) {
    if (node && typeof node.id === 'string') map.set(node.id, node)
  }
  return map
}

/** 事件的数据 / extra 都是可选对象。 */
function dataOf(event) {
  return event && event.data && typeof event.data === 'object' ? event.data : {}
}

function extraOf(event) {
  return event && event.extra && typeof event.extra === 'object' ? event.extra : {}
}

/**
 * 从入口沿 next 走到 target，返回路径上的节点 id（含 target）；走不到返回 null。
 * 只用于判断「旧 run 的完成进度是否还落在当前流程结构上」。
 */
export function nextPathTo(flow, targetId) {
  let node = null
  try {
    node = selectFirstNode(flow)
  } catch {
    return null
  }
  const path = []
  const seen = new Set()
  while (node && !seen.has(node.id)) {
    seen.add(node.id)
    path.push(node.id)
    if (node.id === targetId) return path
    if (node.kind === NODE_KIND.END) return null
    try {
      node = selectNextNode(flow, node)
    } catch {
      return null
    }
  }
  return null
}

/**
 * 纯函数：从旧 run 事件 + 当前流程推导续跑起点与已完成节点。
 *
 * @param {{ flow: object, events: object[] }} input
 * @returns {{
 *   startNodeId: string,
 *   skipped: Array<{nodeId: string, title: string, attempt: number}>,
 *   oldFailure: {nodeId: string|null, reason: string, status: string},
 *   attempts: Record<string, number>,
 *   runEnd: object|null,
 * }}
 */
export function planRestart({ flow, events }) {
  const list = Array.isArray(events) ? events : []
  const byId = byIdMap(flow)
  let runEnd = null
  const lastEnd = new Map()
  const open = new Map()
  const attempts = {}
  // nodeId → 最近一次 node/end failed；同一节点后来 passed / rejected 会覆盖掉，
  // 避免把「早先失败、后来重跑通过」的节点误当成续跑起点。
  const failedEnds = new Map()
  for (let index = 0; index < list.length; index += 1) {
    const event = list[index]
    if (!event || typeof event.kind !== 'string') continue
    const nodeId = typeof event.nodeId === 'string' ? event.nodeId : null
    const attempt = Number.isInteger(event.attemptId) ? event.attemptId : null
    if (nodeId !== null && attempt !== null) {
      attempts[nodeId] = Math.max(attempts[nodeId] || 0, attempt)
    }
    if (event.kind === 'run/end') {
      if (!isInstanceScopedEnd(event)) runEnd = event
      continue
    }
    if (nodeId === null) continue
    if (event.kind === 'node/start') {
      open.set(nodeId, { attempt, index })
      continue
    }
    if (event.kind === 'node/end') {
      const status = typeof dataOf(event).status === 'string' ? dataOf(event).status : 'failed'
      lastEnd.set(nodeId, { status, attempt, index, seq: event.seq })
      if (open.get(nodeId) && (open.get(nodeId).attempt === attempt || attempt === null)) open.delete(nodeId)
      if (status === 'failed') failedEnds.set(nodeId, { nodeId, attempt, index, event })
      else failedEnds.delete(nodeId)
    }
  }

  // 1) 旧 run 终结事件指认的失败坐标（引擎两条收口路径分别写在 data / extra）。
  let startNodeId = null
  const runEndData = dataOf(runEnd)
  const runEndExtra = extraOf(runEnd)
  if (typeof runEndData.failedNodeId === 'string') startNodeId = runEndData.failedNodeId
  else if (typeof runEndExtra.nodeId === 'string') startNodeId = runEndExtra.nodeId
  // 2) 事件流里最后一条 node/end failed（同一节点后来的终态已覆盖它）。
  let lastFailed = null
  for (const entry of failedEnds.values()) {
    if (!lastFailed || entry.index > lastFailed.index) lastFailed = entry
  }
  if (startNodeId === null && lastFailed) startNodeId = lastFailed.nodeId
  // 3) 中止时正在跑、还没写 node/end 的节点（start 之后没有对应 end）。
  if (startNodeId === null && open.size > 0) {
    let latest = null
    for (const [nodeId, entry] of open) {
      if (!latest || entry.index > latest.index) latest = { nodeId, index: entry.index }
    }
    if (latest) startNodeId = latest.nodeId
  }

  const passed = []
  for (const [nodeId, entry] of lastEnd) {
    if (entry.status !== 'passed') continue
    const node = byId.get(nodeId)
    if (!node || node.kind !== NODE_KIND.STAGE) continue
    passed.push({ nodeId, title: node.title || nodeId, attempt: entry.attempt || 1 })
  }

  // 4) 中止发生在两个节点之间：沿 next 找第一个还没通过的阶段节点。
  if (startNodeId === null) {
    let node = null
    try {
      node = selectFirstNode(flow)
    } catch {
      node = null
    }
    const passedIds = new Set(passed.map(entry => entry.nodeId))
    const seen = new Set()
    while (node && !seen.has(node.id)) {
      seen.add(node.id)
      if (node.kind === NODE_KIND.STAGE && !passedIds.has(node.id)) {
        startNodeId = node.id
        break
      }
      if (node.kind === NODE_KIND.END) break
      try {
        node = selectNextNode(flow, node)
      } catch {
        node = null
      }
    }
  }

  if (startNodeId === null) {
    throw new RunError(
      400,
      'restart',
      '旧 run 没有可续跑的阶段节点（可能已经全部完成）：没有失败 / 中止坐标，也没有未通过的阶段节点',
    )
  }
  const startNode = byId.get(startNodeId)
  if (!startNode) {
    throw new RunError(
      400,
      'restart',
      `流程结构已变化：旧 run 失败 / 中止的节点「${startNodeId}」在当前流程里不存在，无法续跑`,
    )
  }
  if (startNode.kind !== NODE_KIND.STAGE) {
    throw new RunError(
      400,
      'restart',
      `流程结构已变化：旧 run 的续跑坐标「${startNodeId}」在当前流程里不是阶段节点，无法续跑`,
    )
  }
  // 起点必须还能从入口沿 next 到达；否则「跳过已完成节点」的假设不成立。
  const path = nextPathTo(flow, startNodeId)
  if (!path) {
    throw new RunError(
      400,
      'restart',
      `流程结构已变化：续跑起点「${startNodeId}」在当前流程里不在入口 next 路径上（请检查 next 边）`,
    )
  }
  const onPath = new Set(path)
  // 只保留「仍在续跑起点上游路径上」的已通过节点；结构变化后失效的节点不跳过，
  // 保证新 run 不会把旧结论当成当前流程的既成事实。
  const skipped = passed
    .filter(entry => entry.nodeId !== startNodeId && onPath.has(entry.nodeId))
    .sort((a, b) => path.indexOf(a.nodeId) - path.indexOf(b.nodeId))

  const oldStatus = typeof runEndData.status === 'string' ? runEndData.status : 'failed'
  const oldReason = typeof runEndData.reason === 'string' && runEndData.reason !== ''
    ? runEndData.reason
    : (typeof runEndExtra.detail === 'string' && runEndExtra.detail !== ''
      ? runEndExtra.detail
      : (lastFailed && extraOf(lastFailed.event).reason) || '（旧 run 没有记录失败原因）')

  return {
    startNodeId,
    skipped,
    oldFailure: {
      nodeId: startNodeId,
      reason: String(oldReason).slice(0, 2000),
      status: oldStatus,
    },
    attempts,
    runEnd: runEnd || null,
  }
}

/** 读旧 run 某节点某 attempt 的 summary.json；缺失 / 坏 JSON / 超限都降级为空。 */
async function readNodeSummary(runsRoot, runId, nodeId, attempt) {
  const file = join(runsRoot, runId, nodeId, 'artifacts', String(attempt), 'summary.json')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { summary: '', artifactPaths: [] }
  }
  if (text.length > 1024 * 1024) return { summary: '', artifactPaths: [] }
  try {
    const parsed = JSON.parse(text)
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 400) : '',
      artifactPaths: Array.isArray(parsed.artifactPaths)
        ? parsed.artifactPaths.filter(item => typeof item === 'string').slice(0, 50)
        : [],
    }
  } catch {
    return { summary: '', artifactPaths: [] }
  }
}

/**
 * 读旧 run 事件 → 推导续跑计划，并补齐已完成节点的 summary / artifactPaths。
 *
 * @param {{ runsRoot: string, runId: string, flow: object }} input
 * @returns {Promise<ReturnType<typeof planRestart>>}
 */
export async function loadRestartPlan({ runsRoot, runId, flow }) {
  const all = await readAllEvents(runsRoot, runId)
  if (!all) throw new RunError(404, 'runId', `run 不存在（${runId}）`)
  const plan = planRestart({ flow, events: all.events })
  const skipped = []
  for (const entry of plan.skipped) {
    const detail = await readNodeSummary(runsRoot, runId, entry.nodeId, entry.attempt)
    skipped.push({ ...entry, ...detail })
  }
  return { ...plan, skipped }
}

/**
 * 重启前把「旧 run / 当前流程 / 会话继承」三件事拼成一个可执行计划，并做可读校验。
 * 这里不建 run、不写盘（唯一副作用是读）。
 *
 * @param {{ runsRoot: string, runId: string, flow: object, runstore: object }} input
 */
export async function prepareRestart({ runsRoot, runId, flow }) {
  const meta = assertRestartable(await readRunMeta(runsRoot, runId), runId)
  const plan = await loadRestartPlan({ runsRoot, runId, flow })
  return { meta, plan }
}
