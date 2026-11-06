/**
 * 键盘连线：把「选中 → C → Tab 选目标 → Enter 建边」拆成可测的纯状态机。
 *
 * 页面只负责把按键喂给这里，方向规则与 Web UI 的鼠标连线共用同一份判定，
 * 所以两条路径不会给出不同结果。
 *
 * @module @feiyueve/dsh-flow-studio/client/link
 */

import { EDGE_KIND } from '../model.js'

/** 沿正常流转边做可达判定：决定新连线是前进还是回退。 */
export function canReach(flow, fromId, toId) {
  const nodes = flow && Array.isArray(flow.nodes) ? flow.nodes : []
  const adjacency = new Map(nodes.map(node => [node.id, []]))
  for (const edge of flow.edges || []) {
    if (edge.kind !== EDGE_KIND.NEXT) continue
    const bucket = adjacency.get(edge.from)
    if (bucket) bucket.push(edge.to)
  }
  const seen = new Set()
  const queue = [fromId]
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === toId) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const next of adjacency.get(id) || []) if (!seen.has(next)) queue.push(next)
  }
  return false
}

/** 方向规则：目标在下游建 next，在上游建 reject。 */
export function edgeKindBetween(flow, fromId, toId) {
  return canReach(flow, fromId, toId) ? EDGE_KIND.NEXT : EDGE_KIND.REJECT
}

/** 候选节点：除源节点外的全部节点，顺序就是 flow.nodes 顺序（确定性）。 */
export function linkCandidates(nodes, fromId) {
  return (Array.isArray(nodes) ? nodes : []).filter(node => node.id !== fromId).map(node => node.id)
}

/**
 * 进入「连线待定」态。
 * @returns {{ fromId: string, index: number, candidates: string[] } | null}
 */
export function beginLink(nodes, fromId) {
  if (!fromId) return null
  const candidates = linkCandidates(nodes, fromId)
  if (candidates.length === 0) return null
  return { fromId, index: 0, candidates }
}

/** 在候选间循环移动（Tab +1 / Shift+Tab -1 / 方向键同理）。 */
export function moveLink(state, delta) {
  if (!state || state.candidates.length === 0) return state
  const count = state.candidates.length
  return { ...state, index: ((state.index + delta) % count + count) % count }
}

/** 当前高亮的候选 id。 */
export function activeCandidate(state) {
  if (!state || state.candidates.length === 0) return ''
  return state.candidates[state.index] || ''
}

/** Enter 确认：返回要建的边端点；没有候选时返回 null。 */
export function confirmLink(state) {
  if (!state || state.candidates.length === 0) return null
  return { fromId: state.fromId, toId: state.candidates[state.index] }
}

/** 状态播报（aria-live）：可读的「从 X 到 Y」，不依赖颜色或图形。 */
export function describeLink(flow, state) {
  if (!state) return ''
  const byId = new Map(((flow && flow.nodes) || []).map(node => [node.id, node]))
  const from = byId.get(state.fromId)
  const to = byId.get(activeCandidate(state))
  return '连线待定：从「' + (from ? from.title : '?') + '」到「' + (to ? to.title : '?') + '」'
}
