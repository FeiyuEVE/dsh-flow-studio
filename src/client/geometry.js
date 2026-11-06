/**
 * 走线几何：正常流转的贝塞尔、打回线的正交航道、端口/槽位分配、命中测试。
 *
 * 打回线不走弧线而走「下方专用航道」，是这份设计里最关键的一条
 * （docs/design/03-semantics.md §2.1–2.2）：弧线跨度越大越深，四条一叠就糊；
 * 航道是固定高度上的平行线，天然可读，而且给多轮打回留了确定位置。
 *
 * 全览数学只有一个世界坐标源：`worldBounds()`。任何「适配 / 概览 / 全览」
 * 的宽度、边距、缩放都必须从它出发，不许在页面里再算第二套。
 *
 * @module @feiyueve/dsh-flow-studio/client/geometry
 */

import { EDGE_KIND, NODE_H, NODE_W } from '../model.js'

/** 列距：节点宽 208 + 间隙 52。间隙是贝塞尔与打回端口的共用呼吸区。 */
export const COL_GAP = 52
/** 一列的步进：208 + 52 = 260（DESIGN.md §6 的列距）。 */
export const COL_STEP = NODE_W + COL_GAP
/** 8 列主干（开始 + 6 阶段 + 结束）的世界宽：7×260 + 208 = 2028。 */
export const EIGHT_COL_WORLD_W = 7 * COL_STEP + NODE_W
/** 适配全览的屏幕边距（px）。这是屏幕 px，不参与世界坐标换算。 */
export const PAD = 48
/** 适配缩放下限：30 节点串行链在 25% 也装不下，地板降到 15%。 */
export const FIT_MIN = 0.15
/** 适配缩放上限：全览不把 3 个节点撑到 200%，最多 100%（01/02 的 clamp [15%, 100%]）。 */
export const FIT_MAX = 1

/** 第一条航道距主干底的偏移。 */
export const LANE_OFFSET = 24
/** 航道间距。 */
export const LANE_GAP = 28
/** 航道槽位数：6 条航道、每条两个端口位，第 7 条起并入最外航道。 */
export const MAX_LANES = 6
/** 出端口位（相对节点中心 x，底缘右半）。 */
export const OUT_SLOTS = [8, 24, 40, 56, 72, 88]
/** 入槽位（相对节点中心 x，底缘左半）。 */
export const IN_SLOTS = [-88, -72, -56, -40, -24, -8]
/** 折角半径。 */
const CORNER = 10

/**
 * G5-e：逻辑吸附步长（01 §5.1 #12 / 02 §125：4px 逻辑网格，视觉点阵 20px）。
 * 拖拽落位默认吸附到 4px；按住 Alt（macOS 的 Option）临时绕过，自由落位但仍取整到 1px。
 */
export const SNAP_GRID = 4

/**
 * 单轴落位：默认吸附到 `grid`；`bypassSnap` 时只取整到 1px。
 * 非有限数按 0 处理（拖动中的坏值不能污染流程坐标）。
 */
export function snapCoordinate(value, options = {}) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  if (options && options.bypassSnap === true) return Math.round(number)
  const grid = Number.isFinite(Number(options && options.grid)) && Number(options.grid) > 0
    ? Number(options.grid)
    : SNAP_GRID
  return Math.round(number / grid) * grid
}

/**
 * G5-e：二维落位纯函数。`bypassSnap: true`（Alt 按下）不再吸附网格，
 * 松开 Alt 后调用方传 false 即恢复 4px 吸附。
 */
export function snapPosition(position, options = {}) {
  const point = position && typeof position === 'object' ? position : {}
  return {
    x: snapCoordinate(point.x, options),
    y: snapCoordinate(point.y, options),
  }
}

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

/**
 * 世界边界 —— 全览数学的唯一来源。
 *
 * 只用节点矩形求，不读列距 / 端点坐标 / 任何第二套假设；
 * `minX/minY/maxX/maxY` 是节点矩形的真实包围盒，`w/h` 是它的尺寸。
 *
 * @param {object[]} [nodes]
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number, w: number, h: number, columns: number }}
 */
export function worldBounds(nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  if (list.length === 0) {
    return { minX: 0, minY: 0, maxX: NODE_W, maxY: NODE_H, w: NODE_W, h: NODE_H, columns: 0 }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const xs = new Set()
  for (const node of list) {
    const rect = nodeRect(node)
    xs.add(rect.x)
    if (rect.x < minX) minX = rect.x
    if (rect.y < minY) minY = rect.y
    if (rect.x + rect.w > maxX) maxX = rect.x + rect.w
    if (rect.y + rect.h > maxY) maxY = rect.y + rect.h
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, columns: xs.size }
}

/** 主干底 y：所有节点里最低的那条底边，航道从这里往下排。 */
export function trunkBottom(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return 220 + NODE_H
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
  return rejectPathRects(nodeRect(from), nodeRect(to), laneY, outSlot, inSlot)
}

/**
 * 同上，但直接吃矩形（{x,y,w,h}）。React Flow 的自定义边只有节点内部快照，
 * 没有整份 flow 节点对象，用矩形版本可以避免在边组件里重新猜尺寸。
 */
export function rejectPathRects(fromRect, toRect, laneY, outSlot, inSlot) {
  const sx = fromRect.x + fromRect.w / 2 + outSlot
  const sy = fromRect.y + fromRect.h
  const tx = toRect.x + toRect.w / 2 + inSlot
  const ty = toRect.y + toRect.h
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
 * 航道与端口分配（确定性，不依赖数组顺序或 sort 稳定性）。
 *
 * 排序：目标列升序 → 同目标时源列降序 → 源节点在 `flow.nodes` 中的顺序 →
 * 源/目标 id 字面序 → 连线 id。前 6 条各占一条航道；
 * 第 7 条起确定性降级：并入最外航道，按 0/1px 交替偏移成双线，
 * 调用方（canvas）丢弃这些边的标签，只画 `+N` 汇总角标。
 *
 * @param {object[]} nodes
 * @param {object[]} edges
 * @returns {{ lanes: Map<string, object>, overflow: Set<string>, overflowCount: number, laneCount: number, outerLaneY: number|null, baseLaneY: number }}
 */
export function assignRejectLanes(nodes, edges) {
  const list = Array.isArray(nodes) ? nodes : []
  const cols = columnOf(list)
  const byId = new Map(list.map(node => [node.id, node]))
  const order = new Map(list.map((node, index) => [node.id, index]))
  const rejects = (Array.isArray(edges) ? edges : [])
    .filter(edge => edge.kind === EDGE_KIND.REJECT && byId.has(edge.from) && byId.has(edge.to))

  const compareId = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  const compareNode = (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0) || compareId(a, b)

  const items = rejects.map(edge => ({
    edge,
    fromCol: cols.get(edge.from) ?? 0,
    toCol: cols.get(edge.to) ?? 0,
  }))

  // 目标越靠左越深：先排回的远的，再把最深的航道给它。所有并列都有确定 tie-break。
  items.sort((a, b) =>
    (a.toCol - b.toCol)
    || (b.fromCol - a.fromCol)
    || compareNode(a.edge.from, b.edge.from)
    || compareNode(a.edge.to, b.edge.to)
    || compareId(a.edge.id, b.edge.id))

  const laneCount = Math.min(items.length, MAX_LANES)
  const base = trunkBottom(list) + LANE_OFFSET
  const outerLaneY = laneCount > 0 ? base + (laneCount - 1) * LANE_GAP : null

  // 出端口：按源分组，组内目标列升序 → 依次占据右半口位（最远目标拿最外侧）。
  const outSlotOf = new Map()
  const outBySource = new Map()
  for (const item of items) {
    if (!outBySource.has(item.edge.from)) outBySource.set(item.edge.from, [])
    outBySource.get(item.edge.from).push(item)
  }
  for (const [, group] of outBySource) {
    group.sort((a, b) =>
      (a.toCol - b.toCol)
      || compareNode(a.edge.to, b.edge.to)
      || compareId(a.edge.id, b.edge.id))
    group.forEach((item, index) => {
      outSlotOf.set(item.edge.id, OUT_SLOTS[Math.min(index, OUT_SLOTS.length - 1)])
    })
  }

  // 入槽位：按目标分组，组内源列降序 → 依次占据左半槽位（最远源拿最外侧）。
  const inSlotOf = new Map()
  const inByTarget = new Map()
  for (const item of items) {
    if (!inByTarget.has(item.edge.to)) inByTarget.set(item.edge.to, [])
    inByTarget.get(item.edge.to).push(item)
  }
  for (const [, group] of inByTarget) {
    group.sort((a, b) =>
      (b.fromCol - a.fromCol)
      || compareNode(a.edge.from, b.edge.from)
      || compareId(a.edge.id, b.edge.id))
    group.forEach((item, index) => {
      inSlotOf.set(item.edge.id, IN_SLOTS[Math.min(index, IN_SLOTS.length - 1)])
    })
  }

  const lanes = new Map()
  const overflow = new Set()
  items.forEach((item, index) => {
    const isOverflow = index >= MAX_LANES
    if (isOverflow) overflow.add(item.edge.id)
    // 排序靠前的拿深航道：index 0 → 最深；第 7 条起全部并入最外航道。
    const laneY = isOverflow
      ? outerLaneY + ((index - MAX_LANES) % 2)
      : base + (laneCount - 1 - index) * LANE_GAP
    lanes.set(item.edge.id, {
      laneY,
      laneIndex: isOverflow ? MAX_LANES : laneCount - index,
      outSlot: outSlotOf.get(item.edge.id) ?? OUT_SLOTS[0],
      inSlot: inSlotOf.get(item.edge.id) ?? IN_SLOTS[0],
      overflow: isOverflow,
    })
  })

  return {
    lanes,
    overflow,
    overflowCount: overflow.size,
    laneCount,
    outerLaneY,
    baseLaneY: base,
  }
}

/**
 * 视口自适应：把全部节点装进给定尺寸，留屏幕边距。
 *
 * fit = min((width - 2×PAD)/boundsW, (height - 2×PAD)/boundsH)；
 * 低于 FIT_MIN 时不再缩小（画布会提示还有几列在视野外）。
 *
 * @param {object[]} nodes
 * @param {number} width 屏幕宽（px）
 * @param {number} height 屏幕高（px）
 * @param {number} [padding] 屏幕边距（px）
 */
export function fitView(nodes, width, height, padding = PAD) {
  const list = Array.isArray(nodes) ? nodes : []
  if (list.length === 0) {
    return { x: 0, y: 0, z: 1, clamped: false, hiddenColumns: 0, bounds: worldBounds(list) }
  }
  const bounds = worldBounds(list)
  const availW = Math.max(1, width - padding * 2)
  const availH = Math.max(1, height - padding * 2)
  const raw = Math.min(availW / bounds.w, availH / bounds.h)
  const z = Math.max(FIT_MIN, Math.min(FIT_MAX, raw))

  let x
  let y
  if (raw < FIT_MIN) {
    // 装不下时不居中：从左上角开始读，视野外只可能是右侧/下方的列。
    x = padding - bounds.minX * z
    y = padding - bounds.minY * z
  } else {
    x = (width - bounds.w * z) / 2 - bounds.minX * z
    y = (height - bounds.h * z) / 2 - bounds.minY * z
  }

  return {
    x,
    y,
    z,
    clamped: raw < FIT_MIN,
    hiddenColumns: hiddenColumnsOf(list, width, x, z),
    bounds,
  }
}

/** 视口外还有几列（按 x 去重的列数）。确定性提示用，不做插值。 */
export function hiddenColumnsOf(nodes, width, viewX, zoom) {
  const seen = new Set()
  let hidden = 0
  for (const node of nodes) {
    if (seen.has(node.x)) continue
    seen.add(node.x)
    const left = node.x * zoom + viewX
    const right = (node.x + NODE_W) * zoom + viewX
    if (left < 0 || right > width) hidden += 1
  }
  return hidden
}

/** 缩放等级：只影响显示什么，不影响位置。低于 45% 就是「精简」档。 */
export function lodOf(zoom) {
  if (zoom < 0.45) return 'far'
  if (zoom < 0.6) return 'mid'
  return 'near'
}
