/**
 * 走线几何：正常流转的贝塞尔、打回线的正交航道、端口/槽位分配、命中测试。
 *
 * 打回线不走弧线而走「下方专用航道」，是这份设计里最关键的一条
 * （docs/design/03-semantics.md §2.1–2.2）：弧线跨度越大越深，四条一叠就糊；
 * 航道是固定高度上的平行线，天然可读，而且给多轮打回留了确定位置。
 *
 * @module @feiyueve/dsh-flow-studio/client/geometry
 */

import { EDGE_KIND, NODE_H, NODE_W } from '../model.js'

/** 列距：节点宽 208 + 间隙 52。间隙是贝塞尔与打回端口的共用呼吸区。 */
export const COL_GAP = 52
/** 第一条航道距主干底的偏移。 */
export const LANE_OFFSET = 24
/** 航道间距。 */
export const LANE_GAP = 28
/** 最多画 6 条航道，第 7 条起降级成徽标。 */
export const MAX_LANES = 6
/** 出端口位（相对节点中心 x，底缘右半）。 */
export const OUT_SLOTS = [8, 24, 40, 56]
/** 入槽位（相对节点中心 x，底缘左半）。 */
export const IN_SLOTS = [-56, -40, -24, -8]
/** 折角半径。 */
const CORNER = 10

/** 主从节点比普通阶段节点高 20px，用来放成员点行；多出的高度向下长，中心线不变。 */
export const NODE_H_TEAM = NODE_H + 20

/** 一个节点的视觉高度。 */
export function nodeHeight(node) {
  return node && node.mode === 'team' && Array.isArray(node.team) && node.team.length > 0
    ? NODE_H_TEAM
    : NODE_H
}

/** 节点矩形。 */
export function nodeRect(node) {
  return { x: node.x, y: node.y, w: NODE_W, h: nodeHeight(node) }
}

/** 主干底 y：所有节点里最低的那条底边，航道从这里往下排。 */
export function trunkBottom(nodes) {
  if (nodes.length === 0) return 220 + NODE_H
  return Math.max(...nodes.map(node => node.y + nodeHeight(node)))
}

/**
 * 列号：按节点 x 去重排序后的下标。航道排序、「谁在上游」的视觉判断都靠它。
 * @returns {Map<string, number>}
 */
export function columnOf(nodes) {
  const xs = [...new Set(nodes.map(node => node.x))].sort((a, b) => a - b)
  const index = new Map(xs.map((x, at) => [x, at]))
  return new Map(nodes.map(node => [node.id, index.get(node.x) ?? 0]))
}

/** 正常流转：左右锚点之间的三次贝塞尔。控制点偏移取列隙的六成，长跨也不会甩太开。 */
export function nextPath(from, to) {
  const a = { x: from.x + NODE_W, y: from.y + nodeHeight(from) / 2 }
  const b = { x: to.x, y: to.y + nodeHeight(to) / 2 }
  const c = Math.min(COL_GAP * 0.6, 80)
  return {
    d: `M ${a.x} ${a.y} C ${a.x + c} ${a.y}, ${b.x - c} ${b.y}, ${b.x} ${b.y}`,
    from: a,
    to: b,
    label: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 6 },
  }
}

/**
 * 打回线：源底缘出端口 → 垂直下降 → 水平航道 → 垂直上升 → 目标底缘入槽。
 * 箭头画在上升段末端（朝上），所以终点就是目标底缘。
 */
export function rejectPath(from, to, laneY, outSlot, inSlot) {
  const sx = from.x + NODE_W / 2 + outSlot
  const sy = from.y + nodeHeight(from)
  const tx = to.x + NODE_W / 2 + inSlot
  const ty = to.y + nodeHeight(to)
  const goingLeft = sx > tx
  const d = [
    `M ${sx} ${sy}`,
    `L ${sx} ${laneY - CORNER}`,
    `Q ${sx} ${laneY} ${sx + (goingLeft ? -CORNER : CORNER)} ${laneY}`,
    `L ${tx + (goingLeft ? CORNER : -CORNER)} ${laneY}`,
    `Q ${tx} ${laneY} ${tx} ${laneY - CORNER}`,
    `L ${tx} ${ty}`,
  ].join(' ')
  // 标签放在水平段「靠源端 24%」处：用户视线刚从被打回的源节点跟过来。
  const labelX = sx + (tx - sx) * 0.24
  return {
    d,
    from: { x: sx, y: sy },
    to: { x: tx, y: ty },
    laneY,
    label: { x: labelX, y: laneY - 4 },
    tickStart: tx + (goingLeft ? 12 : -12),
    goingLeft,
  }
}

/**
 * 航道与端口分配（确定性，不依赖数组顺序）。
 *
 * 排序：目标列升序 → 同目标时源列降序；排第 1 的拿最深航道，依次向浅排。
 * 出端口：同一源节点里，目标越靠左占越靠右的口位。
 * 入槽位：同一目标节点里，源越靠右占越靠左的槽位。
 *
 * @param {object[]} nodes
 * @param {object[]} edges
 * @returns {{ lanes: Map<string, object>, overflow: Set<string>, laneCount: number }}
 */
export function assignRejectLanes(nodes, edges) {
  const cols = columnOf(nodes)
  const byId = new Map(nodes.map(node => [node.id, node]))
  const rejects = edges.filter(edge => edge.kind === EDGE_KIND.REJECT && byId.has(edge.from) && byId.has(edge.to))

  const items = rejects.map(edge => ({
    edge,
    fromCol: cols.get(edge.from) ?? 0,
    toCol: cols.get(edge.to) ?? 0,
  }))

  // 目标越靠左越深：先排回的远的，再把最深的航道给它。
  items.sort((a, b) => (a.toCol - b.toCol) || (b.fromCol - a.fromCol))

  const drawn = items.slice(0, MAX_LANES)
  const overflow = new Set(items.slice(MAX_LANES).map(item => item.edge.id))

  // 出端口：按源分组，组内目标列升序 → 依次占据右半口位（最远目标拿 +56）。
  const outBySource = new Map()
  for (const item of drawn) {
    if (!outBySource.has(item.edge.from)) outBySource.set(item.edge.from, [])
    outBySource.get(item.edge.from).push(item)
  }
  const outSlotOf = new Map()
  for (const [, group] of outBySource) {
    group.sort((a, b) => a.toCol - b.toCol)
    group.forEach((item, index) => {
      outSlotOf.set(item.edge.id, OUT_SLOTS[Math.min(index, OUT_SLOTS.length - 1)])
    })
  }

  // 入槽位：按目标分组，组内源列降序 → 依次占据左半槽位（最远源拿 −56）。
  const inByTarget = new Map()
  for (const item of drawn) {
    if (!inByTarget.has(item.edge.to)) inByTarget.set(item.edge.to, [])
    inByTarget.get(item.edge.to).push(item)
  }
  const inSlotOf = new Map()
  for (const [, group] of inByTarget) {
    group.sort((a, b) => b.fromCol - a.fromCol)
    group.forEach((item, index) => {
      inSlotOf.set(item.edge.id, IN_SLOTS[Math.min(index, IN_SLOTS.length - 1)])
    })
  }

  // 排序靠前的拿深航道：drawn[0] → T(drawn.length)，最后一个 → T1。
  const lanes = new Map()
  const base = trunkBottom(nodes) + LANE_OFFSET
  drawn.forEach((item, index) => {
    const depth = drawn.length - index
    lanes.set(item.edge.id, {
      laneY: base + (depth - 1) * LANE_GAP,
      laneIndex: depth,
      outSlot: outSlotOf.get(item.edge.id) ?? OUT_SLOTS[0],
      inSlot: inSlotOf.get(item.edge.id) ?? IN_SLOTS[0],
    })
  })

  return { lanes, overflow, laneCount: drawn.length }
}

/** 命中测试：逻辑坐标落在哪个节点上（后画的优先）。 */
export function nodeAt(nodes, point) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (point.x >= node.x && point.x <= node.x + NODE_W && point.y >= node.y && point.y <= node.y + nodeHeight(node)) {
      return node.id
    }
  }
  return null
}

/** 视口自适应：把全部节点装进给定尺寸，留边距。 */
export function fitView(nodes, width, height, padding = 56) {
  if (nodes.length === 0) return { x: 0, y: 0, z: 1 }
  const minX = Math.min(...nodes.map(node => node.x))
  const minY = Math.min(...nodes.map(node => node.y))
  const maxX = Math.max(...nodes.map(node => node.x + NODE_W))
  const maxY = Math.max(...nodes.map(node => node.y + nodeHeight(node)))
  const z = Math.min(
    (width - padding * 2) / Math.max(1, maxX - minX),
    (height - padding * 2) / Math.max(1, maxY - minY),
    1.2,
  )
  const zoom = Math.max(0.25, Math.min(2, z))
  return {
    x: (width - (maxX - minX) * zoom) / 2 - minX * zoom,
    y: (height - (maxY - minY) * zoom) / 2 - minY * zoom,
    z: zoom,
  }
}

/** 缩放等级：只影响显示什么，不影响位置。 */
export function lodOf(zoom) {
  if (zoom < 0.45) return 'far'
  if (zoom < 0.6) return 'mid'
  return 'near'
}
