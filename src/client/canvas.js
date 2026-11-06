/**
 * 画布：React Flow 12（@xyflow/react）承载节点 / 连线 / 拖拽 / 平移缩放。
 *
 * 三条边界：
 *  1. 业务契约不变 —— 页面仍然只管接 `onMoveNode / onAddEdge / onAddNodeAt / onSelect`，
 *     运行中锁结构在回调里也挡一遍（不是只灰 UI）。
 *  2. SSR 安全 —— React Flow 需要 DOM 度量，服务端渲染（以及没有 ResizeObserver 的环境）
 *     走一份语义等价的静态回退：绝对定位的节点卡、SVG 连线、可读的连线列表，同一套 data-*。
 *  3. 几何只保留自研里真正有语义的部分：打回航道仍由 geometry.assignRejectLanes 决定，
 *     6 个槽位 ±8/24/40/56/72/88 与第 7 条起的双线合并规则不交给库。
 *
 * @module @feiyueve/dsh-flow-studio/client/canvas
 */

import {
  BaseEdge, EdgeLabelRenderer, Handle, Position, ReactFlow, ReactFlowProvider,
  applyNodeChanges, getSmoothStepPath, useInternalNode, useReactFlow,
} from '@xyflow/react'

import { EDGE_KIND, EXEC_MODE, NODE_KIND, NODE_W } from '../model.js'
import {
  COL_STEP, FIT_MAX, FIT_MIN, assignRejectLanes, hiddenColumnsOf, lodOf,
  nextPath, nodeHeight, rejectPath, rejectPathRects,
} from './geometry.js'
import { cx, h, rt } from './runtime.js'

/** 与旧画布一致的缩放上限；下限与 fit 地板同源。 */
const ZOOM_MAX = 2
const SNAP = 4
/** 静态回退用固定视口，保证 SSR 字符串确定（不读任何 DOM 度量）。 */
const STATIC_VIEW = { x: 48, y: 24, z: 0.92 }
const LOD_LABEL = { near: '完整视图', mid: '紧凑视图', far: '精简视图' }

/**
 * 滚轮手势口径（01 §5.1 #7/#8）：Shift+滚轮横移，裸滚轮与 Ctrl/Cmd+滚轮（含 pinch）缩放。
 * 横移优先用 deltaY；触控板横向手势只给 deltaX 时同样映射到横移。
 * React Flow 自己管缩放手势，这条纯函数供「Shift+滚轮横移」的捕获层与测试使用。
 */
export function wheelPanDelta(event) {
  if (!event.shiftKey || event.ctrlKey || event.metaKey) return null
  return event.deltaY !== 0 ? event.deltaY : (event.deltaX || 0)
}

/**
 * 运行中锁结构：所有会改图的回调都要过这一层。
 * 返回 undefined 而不是抛错 —— 页面自己有 aria-live 播报，画布只负责别让编辑漏过去。
 */
export function guardStructureEdit(locked, run) {
  return (...args) => {
    if (locked) return undefined
    return run(...args)
  }
}

/** 运行中锁结构时，React Flow 的交互开关必须整体一致（测试与组件共用同一份口径）。 */
export function interactionState(locked) {
  return {
    nodesDraggable: !locked,
    nodesConnectable: !locked,
    edgesFocusable: !locked,
    doubleClickAdds: !locked,
  }
}

/** LOD 文案（画布 aria / HUD 共用）。 */
export function lodText(lod) {
  return LOD_LABEL[lod] || LOD_LABEL.near
}

/**
 * 鼠标拖线只允许「阶段/开始 → 阶段/结束」的组合：
 * 结束节点没有出边、开始节点不接受入边，自环也挡掉；方向（next / reject）仍交给 page 的
 * edgeKindBetween，画布不重复实现一遍可达性。
 */
export function canConnectNodes(flow, fromId, toId) {
  if (!fromId || !toId || fromId === toId) return false
  const nodes = (flow && flow.nodes) || []
  const from = nodes.find(node => node.id === fromId)
  const to = nodes.find(node => node.id === toId)
  if (!from || !to) return false
  if (from.kind === NODE_KIND.END) return false
  if (to.kind === NODE_KIND.START) return false
  return true
}

/** 角色摘要：取第一句，太长交给 CSS 省略。 */
function summaryOf(node) {
  if (node.kind === NODE_KIND.START) return '流程入口'
  if (node.kind === NODE_KIND.END) return '流程出口'
  const text = node.role || node.task || ''
  return text ? text.split(/[。\n]/)[0] : '未设置角色'
}

/** 成员角色短名：卡片一行只放得下几个字，完整内容在 title / aria-label 里。 */
function roleShort(role) {
  // 208px 卡片一行放得下「主 + 3 个成员」，角色取 2 个字；完整角色在 title / aria-label 里。
  return String(role || '').split(/[。，,·\s]/)[0].slice(0, 2)
}

/** 纯形状角标（M3）：不靠颜色也能分辨。skipped 与 aborted 都用 ⊘，文字标签负责区分。 */
export function stateShape(runState) {
  if (runState === 'running') return '◎'
  if (runState === 'passed') return '✓'
  if (runState === 'rejected') return '↺'
  if (runState === 'failed') return '✕'
  if (runState === 'skipped') return '⊘'
  if (runState === 'aborted') return '⊘'
  return ''
}

/** 模式徽章：stage 上必须一眼看出「单 agent / 主管 + 子 agent」。 */
function modeBadge(node) {
  if (node.kind === NODE_KIND.START) return '入口'
  if (node.kind === NODE_KIND.END) return '出口'
  if (node.mode === EXEC_MODE.TEAM && node.team.length > 0) return '主管 + ' + node.team.length
  return '单 agent'
}

/** 节点可读名（画布节点与测试共用同一口径）。 */
export function nodeAriaLabel(node, runtime, options = {}) {
  const parts = [node.title]
  if (node.kind === NODE_KIND.STAGE) {
    const team = node.mode === EXEC_MODE.TEAM && node.team.length > 0
    parts.push(team ? '主管 + ' + node.team.length + ' 名成员' : '单 agent')
  } else {
    parts.push(node.kind === NODE_KIND.START ? '流程入口' : '流程出口')
  }
  if (runtime) {
    parts.push('当前' + (runtime.label || '状态未知'))
    if (runtime.attempt) parts.push('attempt ' + runtime.attempt)
    if (runtime.reworkCount > 0) parts.push('返工 ' + runtime.reworkCount + ' 次')
    if (runtime.invalidated) parts.push('旧通过已失效')
  }
  if (options.locked) parts.push('运行中已锁定结构')
  if (options.activeCandidate) parts.push('键盘连线目标')
  return '节点 ' + parts.join('，')
}

/** 连线可读名。 */
export function edgeAriaLabel(edge, byId, nodeStates) {
  const from = byId.get(edge.from)
  const to = byId.get(edge.to)
  const rework = Number(nodeStates && nodeStates[edge.to] && nodeStates[edge.to].reworkCount) || 0
  const kind = edge.kind === EDGE_KIND.REJECT ? '打回' : '正常流转'
  return (from ? from.title : '?') + ' 到 ' + (to ? to.title : '?')
    + '，' + kind + (edge.kind === EDGE_KIND.REJECT && rework > 0 ? '，已打回 ' + rework + ' 次' : '')
}

/** 边的可读列表（SSR 回退与测试用；不回填用户自写的打回说明，避免与「并入航道后收起」冲突）。 */
export function edgeListText(edge, byId) {
  const from = byId.get(edge.from)
  const to = byId.get(edge.to)
  return (from ? from.title : '?') + ' → ' + (to ? to.title : '?')
    + '，' + (edge.kind === EDGE_KIND.REJECT ? '打回' : '正常流转')
}

/** 运行中当前活动边：端点任一是当前节点就做轻微动画。 */
export function isEdgeActive(edge, nodeStates) {
  if (!nodeStates) return false
  const from = nodeStates[edge.from]
  const to = nodeStates[edge.to]
  return Boolean((from && from.current) || (to && to.current))
}

/** 打回线标签：↺n 计数只跟被打回的目标节点，源节点不重复记。 */
function rejectLabelText(edge, nodeStates) {
  const rework = Number(nodeStates && nodeStates[edge.to] && nodeStates[edge.to].reworkCount) || 0
  return (rework > 0 ? '↺' + rework + ' ' : '↺ ') + (edge.label || '打回')
}

function ArrowMarker({ markerId, tone }) {
  return h('marker', {
    id: markerId,
    viewBox: '0 0 10 7',
    refX: 9,
    refY: 3.5,
    markerWidth: 10,
    markerHeight: 7,
    markerUnits: 'userSpaceOnUse',
    orient: 'auto-start-reverse',
  }, h('path', { d: 'M0,0 L10,3.5 L0,7 z', className: 'fs-arrow-head ' + tone }))
}

function markerIdFor(edgeId) {
  return 'fs-mk-' + String(edgeId).replace(/[^a-zA-Z0-9_-]/g, '')
}

/** 节点工具栏动作（静态回退与 React Flow 共用）。 */
function makeNodeActions(props, lockedRef) {
  const read = () => (lockedRef ? lockedRef.current : props)
  return {
    select: id => { if (props.onSelect) props.onSelect({ kind: 'node', id }) },
    openInspector: id => { if (props.onSelect) props.onSelect({ kind: 'node', id }) },
    deleteNode: id => {
      const state = read()
      if (state.locked) return
      if (props.onDeleteNode) props.onDeleteNode(id)
    },
    addDownstream: node => {
      const state = read()
      if (state.locked) return
      const created = props.onAddNodeAt
        ? props.onAddNodeAt(node.x + COL_STEP, node.y)
        : null
      const createdId = created && created.id ? created.id : created
      if (createdId && props.onAddEdge) props.onAddEdge(node.id, createdId)
      if (createdId && props.onSelect) props.onSelect({ kind: 'node', id: createdId })
    },
  }
}

/** 自定义节点：卡片信息沿用旧版，分区、工具条与运行角标在视觉上升级。 */
function StudioNodeCard({ data }) {
  const { node, runtime, locked, selected, candidate, activeCandidate, actions, staticMode } = data
  const isStage = node.kind === NODE_KIND.STAGE
  const hasIn = node.kind !== NODE_KIND.START
  const hasOut = node.kind !== NODE_KIND.END
  const team = isStage && node.mode === EXEC_MODE.TEAM && node.team.length > 0
  const runState = runtime && runtime.state ? runtime.state : 'idle'
  const rework = runtime ? Math.max(0, Math.round(Number(runtime.reworkCount) || 0)) : 0
  const rejectSource = Boolean(runtime && runtime.rejectRole === 'source')
  const invalidated = Boolean(runtime && runtime.invalidated)
  // far 档只靠形状：运行态用状态角标，空闲节点用「入口 / 阶段 / 出口」的形状，
  // 否则缩到 36% 时只剩几个空边框（实测最简档曾经是一片小点）。
  const shape = runtime ? stateShape(runState) : ''
  const kindShape = node.kind === NODE_KIND.START ? '▸' : node.kind === NODE_KIND.END ? '■' : '◇'
  const markShape = shape || kindShape

  const tags = []
  if (runtime) {
    const numbered = runState === 'rejected' && rework > 0 && !rejectSource
    const stateLabel = rejectSource
      ? (runtime.glyph || '↺') + ' 已判打回'
      : numbered
        ? '↺' + rework + ' ' + (runtime.label || '被打回')
        : (runtime.glyph || '·') + ' ' + (runtime.label || '状态未知')
    const stateHint = rejectSource
      ? '已判定打回：这个节点提出了打回，返工数字只记在被打回的目标节点上'
      : runState === 'rejected'
        ? (rework > 0 ? '被打回：该节点因收到打回重跑了 ' + rework + ' 次' : '被打回：该节点本轮判定未通过')
        : invalidated
          ? (runtime.label || '状态未知') + '；旧通过已失效，等待重跑'
          : runtime.label || '状态未知'
    tags.push(h('span', {
      key: 'state',
      className: 'fs-tag state ' + (runtime.tone || 'neutral'),
      title: stateHint,
    }, stateLabel))
    if (runState !== 'rejected' && rework > 0) {
      tags.push(h('span', {
        key: 'rework',
        className: 'fs-tag reject',
        title: '该节点返工 ' + rework + ' 次（目标返工数）',
      }, '↺' + rework))
    }
    if (invalidated) {
      tags.push(h('span', {
        key: 'invalid',
        className: 'fs-tag invalid',
        title: '旧通过已失效：等待重跑后才会恢复 ✓',
      }, '失效'))
    }
    if (runtime.attempt) {
      tags.push(h('span', {
        key: 'attempt',
        className: 'fs-tag attempt',
        title: '当前 attempt：' + runtime.attempt,
      }, '#' + runtime.attempt))
    }
  }
  if (node.kind === NODE_KIND.STAGE && node.maxRounds > 0) {
    tags.push(h('span', {
      key: 'rounds',
      className: 'fs-tag rounds',
      title: '打回上限 ' + node.maxRounds + ' 轮',
    }, '↺' + node.maxRounds))
  }
  if (node.skills.length > 0) {
    tags.push(h('span', {
      key: 's',
      className: 'fs-tag skill',
      title: '已挂 ' + node.skills.length + ' 个 skill',
    }, 'skill ' + node.skills.length))
  }

  const canAddDownstream = node.kind !== NODE_KIND.END
  const toolbar = h('div', { className: 'fs-node-tools', role: 'group', 'aria-label': '节点操作' },
    canAddDownstream
      ? h('button', {
        type: 'button',
        className: 'fs-node-tool nodrag nopan',
        title: locked ? '运行中已锁定结构：停止运行后才能新增下游' : '新增下游节点',
        'aria-label': '新增下游节点',
        disabled: locked,
        onPointerDown: event => event.stopPropagation(),
        onClick: event => {
          event.stopPropagation()
          if (actions && actions.addDownstream) actions.addDownstream(node)
        },
      }, '＋')
      : null,
    h('button', {
      type: 'button',
      className: 'fs-node-tool nodrag nopan danger',
      title: locked ? '运行中已锁定结构：停止运行后才能删除' : '删除节点',
      'aria-label': '删除节点',
      disabled: locked,
      onPointerDown: event => event.stopPropagation(),
      onClick: event => {
        event.stopPropagation()
        if (actions && actions.deleteNode) actions.deleteNode(node.id)
      },
    }, '✕'),
    h('button', {
      type: 'button',
      className: 'fs-node-tool nodrag nopan',
      title: '打开检查器',
      'aria-label': '打开检查器',
      onPointerDown: event => event.stopPropagation(),
      onClick: event => {
        event.stopPropagation()
        if (actions && actions.openInspector) actions.openInspector(node.id)
      },
    }, '⌕'))

  return h('div', {
    'data-node-id': node.id,
    'data-kind': node.kind,
    'data-state': runState,
    'data-attempt': runtime && runtime.attempt ? String(runtime.attempt) : undefined,
    'data-invalidated': invalidated ? 'true' : undefined,
    'data-selected': selected ? 'true' : 'false',
    className: 'fs-node kind-' + node.kind + (selected ? ' selected' : '')
      + (runtime ? ' run-state-' + runState + ' has-state' : '')
      + (locked ? ' locked' : '')
      + (candidate ? ' fs-link-target' : '') + (activeCandidate ? ' fs-link-active' : '')
      + (team ? ' has-team' : ''),
    style: data.staticStyle,
    // React Flow 自己的节点壳负责可聚焦与 aria-label（node.ariaLabel）；
    // 内层只在静态回退里补 role / tabIndex，避免嵌套两个同名可聚焦元素。
    role: staticMode ? 'button' : undefined,
    tabIndex: staticMode ? 0 : undefined,
    'aria-disabled': locked ? 'true' : undefined,
    'aria-pressed': staticMode ? (selected ? 'true' : 'false') : undefined,
    'aria-label': staticMode ? nodeAriaLabel(node, runtime, { locked, activeCandidate }) : undefined,
    onClick: staticMode
      ? () => { if (actions && actions.select) actions.select(node.id) }
      : undefined,
    onKeyDown: staticMode
      ? event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        if (actions && actions.select) actions.select(node.id)
      }
      : undefined,
  },
  staticMode
    ? (hasIn ? h('span', { className: 'fs-port in', 'aria-hidden': true }) : null)
    : h(Handle, {
      type: 'target',
      position: Position.Left,
      id: 'in',
      className: 'fs-handle fs-handle-in' + (hasIn ? '' : ' fs-handle-disabled'),
      isConnectable: !locked && hasIn,
    }),
  h('div', { className: 'fs-node-head' },
    h('div', { className: 'fs-node-title', title: node.title }, node.title),
    h('span', { className: 'fs-mode-badge' }, modeBadge(node))),
  h('div', { className: 'fs-node-summary', title: node.task || node.role || '' }, summaryOf(node)),
  team
    ? h('div', {
      className: 'fs-members',
      title: '主管 + ' + node.team.length + ' 个子 agent：'
        + node.team.map(member => (member.name || '子 agent') + '（' + (member.role || '未填角色') + '）').join('；'),
    },
    h('span', { className: 'fs-member lead', title: '主管' }, '主'),
    node.team.slice(0, 3).map((member, at) => h('span', {
      key: at,
      className: 'fs-member',
      title: (member.name || '子 agent ' + (at + 1)) + (member.role ? ' · ' + member.role : ''),
      style: { color: 'var(--dsw-alias-label-primary)' },
    },
    h('span', { className: 'fs-member-initial' }, (member.name || '子').slice(0, 1)),
    member.role ? h('span', { className: 'fs-member-role' }, roleShort(member.role)) : null)),
    node.team.length > 3
      ? h('span', { className: 'fs-members-more', title: '还有 ' + (node.team.length - 3) + ' 名成员' }, '+' + (node.team.length - 3))
      : null)
    : null,
  h('div', { className: 'fs-node-tags' }, tags),
  h('span', {
    className: 'fs-state-mark' + (runtime ? ' tone-' + (runtime.tone || 'neutral') : ' kind-mark'),
    'aria-hidden': true,
    title: runtime ? (runtime.label || '状态未知') + '（纯形状）' : markShape + '（' + modeBadge(node) + '）',
  }, markShape),
  toolbar,
  hasOut
    ? (staticMode
      ? h('span', { className: 'fs-port out', 'aria-hidden': true })
      : h(Handle, {
        type: 'source',
        position: Position.Right,
        id: 'out',
        className: 'fs-handle fs-handle-out',
        isConnectable: !locked,
      }))
    : null,
  )
}

// React 由宿主在模块求值之后注入（见 runtime.js），所以 memo 包装延迟到首次渲染时创建。
let studioNodeMemo = null
let studioNextEdgeMemo = null
let studioRejectEdgeMemo = null

/**
 * 节点组件（React.memo 包装）。配合 decorate 复用同一个 data 引用，
 * 未变化的节点在页面其它区域重渲染时不会跟着重建。
 */
export function studioNodeType() {
  if (!studioNodeMemo) studioNodeMemo = rt.React.memo(StudioNodeCard)
  return studioNodeMemo
}

/** 正常流转边组件（React.memo 包装）。 */
export function studioNextEdgeType() {
  if (!studioNextEdgeMemo) studioNextEdgeMemo = rt.React.memo(StudioNextEdgeCard)
  return studioNextEdgeMemo
}

/** 打回边组件（React.memo 包装）。 */
export function studioRejectEdgeType() {
  if (!studioRejectEdgeMemo) studioRejectEdgeMemo = rt.React.memo(StudioRejectEdgeCard)
  return studioRejectEdgeMemo
}

/** 正常流转：smooth-step 正交折线 + 居中标签。 */
function StudioNextEdgeCard({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  label, selected, data,
}) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
    borderRadius: 10, offset: 24,
  })
  const markerId = markerIdFor(id)
  const animated = Boolean(data && data.active)
  const tone = selected ? 'selected' : 'next'
  return h(rt.React.Fragment, null,
    h('defs', null, h(ArrowMarker, { markerId, tone })),
    h(BaseEdge, {
      id,
      path,
      interactionWidth: 16,
      markerEnd: 'url(#' + markerId + ')',
      className: cx('fs-edge-path', 'fs-edge-next', selected ? 'selected' : '', animated ? 'active' : ''),
    }),
    label
      ? h(EdgeLabelRenderer, null, h('div', {
        className: 'fs-edge-tag' + (selected ? ' selected' : ''),
        style: { transform: 'translate(-50%,-50%) translate(' + labelX + 'px,' + labelY + 'px)' },
      }, label))
      : null,
  )
}

/** 打回：走节点下方的正交航道（槽位与航道由 geometry 决定），虚线 + ↺n。 */
function StudioRejectEdgeCard({
  id, source, target, sourceX, sourceY, targetX, targetY, selected, data,
}) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  const fallbackFrom = (data && data.fromRect) || { x: sourceX - NODE_W / 2, y: sourceY - 96, w: NODE_W, h: 96 }
  const fallbackTo = (data && data.toRect) || { x: targetX - NODE_W / 2, y: targetY - 96, w: NODE_W, h: 96 }
  const fromRect = sourceNode
    ? {
      x: sourceNode.internals.positionAbsolute.x,
      y: sourceNode.internals.positionAbsolute.y,
      w: (sourceNode.measured && sourceNode.measured.width) || NODE_W,
      h: (sourceNode.measured && sourceNode.measured.height) || fallbackFrom.h,
    }
    : fallbackFrom
  const toRect = targetNode
    ? {
      x: targetNode.internals.positionAbsolute.x,
      y: targetNode.internals.positionAbsolute.y,
      w: (targetNode.measured && targetNode.measured.width) || NODE_W,
      h: (targetNode.measured && targetNode.measured.height) || fallbackTo.h,
    }
    : fallbackTo
  const geometry = rejectPathRects(fromRect, toRect, data.laneY, data.outSlot, data.inSlot)
  const markerId = markerIdFor(id)
  const animated = Boolean(data && data.active)
  const tone = selected ? 'selected' : 'reject'
  return h(rt.React.Fragment, null,
    h('defs', null, h(ArrowMarker, { markerId, tone })),
    h(BaseEdge, {
      id,
      path: geometry.d,
      interactionWidth: 16,
      markerEnd: 'url(#' + markerId + ')',
      className: cx('fs-edge-path', 'fs-edge-reject', selected ? 'selected' : '', animated ? 'active' : ''),
    }),
    !data.overflow && data.label
      ? h(EdgeLabelRenderer, null, h('div', {
        className: 'fs-edge-tag reject' + (selected ? ' selected' : ''),
        style: {
          transform: 'translate(-50%,-50%) translate('
            + geometry.label.x + 'px,' + geometry.label.y + 'px)',
        },
      }, data.label))
      : null,
    data.overflowFlag > 0
      ? h(EdgeLabelRenderer, null, h('div', {
        className: 'fs-edge-tag reject overflow',
        style: {
          transform: 'translate(-50%,-50%) translate('
            + Math.max(geometry.from.x, geometry.to.x) + 'px,' + (data.laneY - 4) + 'px)',
        },
      }, '+' + data.overflowFlag))
      : null,
  )
}

/**
 * React Flow 的组件表必须引用稳定对象：每次渲染换一份映射会让库重建所有节点。
 * 组件本身延迟 memo（rt.React 在模块求值后才注入），这里只返回同一个引用。
 */
let flowTypesCache = null
export function flowComponentTypes() {
  if (!flowTypesCache) {
    flowTypesCache = {
      nodeTypes: { studio: studioNodeType() },
      edgeTypes: { studioNext: studioNextEdgeType(), studioReject: studioRejectEdgeType() },
    }
  }
  return flowTypesCache
}

function canvasAria(flow, lod, extra = '') {
  const nodes = (flow && flow.nodes) || []
  const edges = (flow && flow.edges) || []
  return '流程画布：' + nodes.length + ' 个节点，' + edges.length + ' 条连线；'
    + lodText(lod) + '；双击空白新增节点，Shift+拖拽框选'
    + (extra ? '；' + extra : '')
}

// ── SSR / 无 DOM 环境的语义等价回退 ──────────────────────────────────────
function StaticCanvas({
  flow, selection, apiRef, linkState, nodeStates = null,
  onSelect, onMoveNode, onAddEdge, onAddNodeAt, onPickCandidate, onDeleteNode,
  locked = false, lockReason = '', eventWindowNote = '',
}) {
  const nodes = flow.nodes
  const edges = flow.edges
  const byId = new Map(nodes.map(node => [node.id, node]))
  const lanes = assignRejectLanes(nodes, edges)
  const lod = lodOf(STATIC_VIEW.z)
  const linkSource = linkState ? byId.get(linkState.fromId) : null
  const candidateIds = linkState && Array.isArray(linkState.candidates) ? linkState.candidates : []
  const candidateSet = new Set(candidateIds)
  const activeCandidateId = linkState ? candidateIds[linkState.index] || '' : ''
  const actions = makeNodeActions({
    onSelect, onAddNodeAt, onAddEdge, onDeleteNode,
  }, { current: locked })

  const edgeItems = []
  let laneEndX = -Infinity
  for (const edge of edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    const selected = Boolean(selection && selection.kind === 'edge' && selection.id === edge.id)
    if (edge.kind === EDGE_KIND.REJECT) {
      const lane = lanes.lanes.get(edge.id)
      if (!lane) continue
      const path = rejectPath(from, to, lane.laneY, lane.outSlot, lane.inSlot)
      const overflow = lanes.overflow.has(edge.id)
      edgeItems.push(h('path', {
        key: edge.id,
        className: 'fs-edge-path fs-edge-reject' + (selected ? ' selected' : ''),
        d: path.d,
        markerEnd: 'url(#fs-static-arrow-reject)',
      }))
      if (!overflow) {
        edgeItems.push(h('text', {
          key: edge.id + '-l',
          className: 'fs-edge-label reject',
          x: path.label.x,
          y: path.label.y,
          textAnchor: 'middle',
        }, rejectLabelText(edge, nodeStates)))
      } else {
        laneEndX = Math.max(laneEndX, path.from.x, path.to.x)
      }
      continue
    }
    const path = nextPath(from, to)
    edgeItems.push(h('path', {
      key: edge.id,
      className: 'fs-edge-path fs-edge-next' + (selected ? ' selected' : ''),
      d: path.d,
      markerEnd: 'url(#fs-static-arrow-next)',
    }))
    if (edge.label) {
      edgeItems.push(h('text', {
        key: edge.id + '-l',
        className: 'fs-edge-label',
        x: path.label.x,
        y: path.label.y,
        textAnchor: 'middle',
      }, edge.label))
    }
  }

  return h('div', {
    className: 'fs-canvas' + (locked ? ' locked' : '') + ' fs-canvas-static',
    'data-canvas-mode': 'static',
    'data-lod': lod,
    role: 'region',
    'aria-label': canvasAria(flow, lod, locked ? '运行中已锁定结构' : ''),
  },
  h('div', {
    className: 'fs-world',
    style: { transform: 'translate(' + STATIC_VIEW.x + 'px, ' + STATIC_VIEW.y + 'px) scale(' + STATIC_VIEW.z + ')' },
  }, nodes.map(node => h(studioNodeType(), {
    key: node.id,
    id: node.id,
    data: {
      node,
      runtime: nodeStates ? nodeStates[node.id] || null : null,
      locked,
      selected: Boolean(selection && selection.kind === 'node' && selection.id === node.id),
      linkActive: Boolean(linkState),
      candidate: candidateSet.has(node.id),
      activeCandidate: node.id === activeCandidateId,
      actions,
      staticMode: true,
      staticStyle: {
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: NODE_W,
        height: nodeHeight(node),
      },
    },
  }))),

  h('svg', { className: 'fs-edges', width: '100%', height: '100%', 'aria-hidden': 'true' },
    h('defs', null,
      h(ArrowMarker, { markerId: 'fs-static-arrow-next', tone: 'next' }),
      h(ArrowMarker, { markerId: 'fs-static-arrow-reject', tone: 'reject' })),
    h('g', { transform: 'translate(' + STATIC_VIEW.x + ' ' + STATIC_VIEW.y + ') scale(' + STATIC_VIEW.z + ')' },
      edgeItems,
      lanes.overflowCount > 0 && Number.isFinite(laneEndX)
        ? h('text', {
          className: 'fs-edge-flag reject',
          x: laneEndX,
          y: (lanes.outerLaneY || 0) - 4,
          textAnchor: 'end',
        }, '+' + lanes.overflowCount)
        : null)),

  h('ul', { className: 'fs-sr-only fs-edge-list', 'aria-label': '连线列表' },
    edges.map(edge => h('li', {
      key: edge.id,
      'data-edge-id': edge.id,
      'data-edge-kind': edge.kind,
    }, edgeListText(edge, byId)))),

  linkState && linkSource
    ? h('div', {
      className: 'fs-link-picker',
      role: 'group',
      'aria-label': '连线候选',
    },
    h('div', { className: 'fs-link-picker-head' }, '连线待定：从「' + linkSource.title + '」到'),
    h('div', { className: 'fs-link-list' },
      candidateIds.map(id => {
        const target = byId.get(id)
        if (!target) return null
        const active = id === activeCandidateId
        return h('button', {
          key: id,
          type: 'button',
          className: 'fs-link-option' + (active ? ' on' : ''),
          onClick: () => onPickCandidate && onPickCandidate(id),
        }, '到 ' + target.title)
      })),
    h('div', { className: 'fs-link-picker-hint' }, 'Tab 切换 · Enter 确认 · Esc 取消'))
    : null,

  locked
    ? h('div', { className: 'fs-canvas-lock', role: 'status' },
      lockReason || '运行中已锁定结构：拖拽 / 双击新建 / 连线 / 检查器编辑暂不可用，停止运行后恢复')
    : null,

  eventWindowNote !== ''
    ? h('div', {
      className: 'fs-canvas-note fs-canvas-event-note',
      title: '节点状态优先取 Host summary.progress；事件只补运行中 / 打回 / attempt 细节',
    }, eventWindowNote)
    : null,

  nodes.length === 0
    ? h('div', { className: 'fs-canvas-empty' }, '画布还是空的：双击空白处新增第一个节点')
    : null,

  lanes.overflowCount > 0
    ? h('div', { className: 'fs-canvas-hint' }, '另有 ' + lanes.overflowCount + ' 条打回线并入最外航道（标签已收起）')
    : null,

  h('div', { className: 'fs-hud' },
    h('button', { type: 'button', className: 'fs-hud-btn', title: '缩小', onClick: () => apiRef && apiRef.current && apiRef.current.zoomBy(1 / 1.2) }, '−'),
    h('span', { className: 'fs-hud-val' }, Math.round(STATIC_VIEW.z * 100) + '%'),
    h('button', { type: 'button', className: 'fs-hud-btn', title: '放大', onClick: () => apiRef && apiRef.current && apiRef.current.zoomBy(1.2) }, '+'),
    h('button', { type: 'button', className: 'fs-hud-btn', title: '适应内容', onClick: () => apiRef && apiRef.current && apiRef.current.fit() }, '⤢'),
    h('span', { className: 'fs-hud-lod', title: '当前缩放等级：' + lodText(lod) }, lodText(lod))))
}

// ── React Flow 载入后的真实画布 ───────────────────────────────────────────

/**
 * 节点装饰器：把业务节点转成 React Flow 节点，并在输入没变时复用同一个对象。
 *
 * 缺陷 7 的关键：只要 node 引用、运行态、选中 / 锁定 / 连线候选都没变，
 * 就返回上一次的同一份 `{...data}`；配合 StudioNode 的 React.memo，
 * 未变化的节点在页面其它 state 变化时不会重渲染。
 *
 * @param {object} options
 * @param {() => object} options.readState 每次取最新页面状态（flow / selection / nodeStates / locked / linkState）
 * @param {object} options.actions 稳定的节点工具条动作
 * @returns {Function & { prune: (ids: Set<string>) => void }}
 */
export function createNodeDecorator(options = {}) {
  const readState = typeof options.readState === 'function' ? options.readState : () => ({})
  const actions = options.actions || {}
  const cache = new Map()

  const decorate = node => {
    const state = readState()
    const runtime = state.nodeStates ? state.nodeStates[node.id] || null : null
    const selected = Boolean(state.selection && state.selection.kind === 'node' && state.selection.id === node.id)
    const locked = Boolean(state.locked)
    const linkActive = Boolean(state.linkState)
    const candidate = Boolean(state.linkState && Array.isArray(state.linkState.candidates)
      && state.linkState.candidates.includes(node.id))
    const activeCandidate = Boolean(state.linkState && Array.isArray(state.linkState.candidates)
      && state.linkState.candidates[state.linkState.index] === node.id)

    const cached = cache.get(node.id)
    if (cached
      && cached.node === node
      && cached.runtime === runtime
      && cached.selected === selected
      && cached.locked === locked
      && cached.linkActive === linkActive
      && cached.candidate === candidate
      && cached.activeCandidate === activeCandidate) {
      return cached.value
    }

    const value = {
      id: node.id,
      type: 'studio',
      position: { x: node.x, y: node.y },
      width: NODE_W,
      height: nodeHeight(node),
      draggable: !locked,
      selectable: true,
      focusable: true,
      selected,
      ariaLabel: nodeAriaLabel(node, runtime, { locked }),
      data: {
        node,
        runtime,
        locked,
        selected,
        linkActive,
        candidate,
        activeCandidate,
        actions,
      },
    }
    cache.set(node.id, {
      node,
      runtime,
      selected,
      locked,
      linkActive,
      candidate,
      activeCandidate,
      value,
    })
    return value
  }

  /** 删掉已不存在的节点，避免长时间编辑后缓存只增不减。 */
  decorate.prune = ids => {
    for (const id of cache.keys()) {
      if (!ids.has(id)) cache.delete(id)
    }
  }

  return decorate
}

/**
 * 拖拽提交器（缺陷 7）。
 *
 * React Flow 在拖动中通过 onNodesChange 更新自己的受控节点数组，**不经过这里**；
 * `onNodeDrag` 只记最新位置，绝不调用页面回调，所以拖动多少帧都不会写顶层 flow、
 * 不会触发自动保存 / localStorage。`onNodeDragStop` 恰好提交一次最终位置（取整）。
 * 运行中锁定（locked）时即使收到 stop 也不提交，与 guardStructureEdit 同口径。
 */
export function createDragHandlers(options = {}) {
  const isLocked = typeof options.isLocked === 'function' ? options.isLocked : () => false
  const onMoveNode = typeof options.onMoveNode === 'function' ? options.onMoveNode : null
  const last = { id: '', x: 0, y: 0 }

  return {
    onNodeDrag(event, node) {
      if (!node || !node.id || !node.position) return
      last.id = node.id
      last.x = node.position.x
      last.y = node.position.y
    },
    onNodeDragStop(event, node) {
      if (!node || !node.id) return
      if (isLocked()) return
      const x = Math.round(node.position ? node.position.x : last.x)
      const y = Math.round(node.position ? node.position.y : last.y)
      if (onMoveNode) onMoveNode(node.id, x, y)
    },
  }
}

function FlowCanvasInner(props) {
  const {
    flow, selection, apiRef, linkState, nodeStates = null,
    onSelect, onMoveNode, onAddEdge, onAddNodeAt, onPickCandidate, onDeleteNode,
    locked = false, lockReason = '', eventWindowNote = '',
  } = props
  const { useState, useEffect, useRef, useCallback, useMemo } = rt.React
  const rf = useReactFlow()
  const wrapperRef = useRef(null)
  const [rfNodes, setRfNodes] = useState([])
  const [zoomPercent, setZoomPercent] = useState(92)
  const [lod, setLod] = useState('near')
  const [hiddenColumns, setHiddenColumns] = useState(0)
  const zoomRef = useRef(92)
  const lodRef = useRef('near')
  const hiddenRef = useRef(0)
  const sizeRef = useRef({ width: 0, height: 0 })
  const fittedFor = useRef('')
  const initialised = useRef(false)
  const lastSelectionKey = useRef(selection && selection.id ? selection.kind + ':' + selection.id : '')
  const latest = useRef({})
  latest.current = {
    flow, selection, nodeStates, locked, linkState,
    onSelect, onMoveNode, onAddEdge, onAddNodeAt, onDeleteNode,
  }

  // 工具栏动作必须稳定：每次渲染换函数会让节点 data 变、deps 连锁触发重建。
  const actionsRef = useRef(null)
  if (!actionsRef.current) {
    actionsRef.current = {
      select: id => { if (latest.current.onSelect) latest.current.onSelect({ kind: 'node', id }) },
      openInspector: id => { if (latest.current.onSelect) latest.current.onSelect({ kind: 'node', id }) },
      deleteNode: id => {
        if (latest.current.locked) return
        if (latest.current.onDeleteNode) latest.current.onDeleteNode(id)
      },
      addDownstream: node => {
        if (latest.current.locked) return
        const created = latest.current.onAddNodeAt
          ? latest.current.onAddNodeAt(node.x + COL_STEP, node.y)
          : null
        const createdId = created && created.id ? created.id : created
        if (createdId && latest.current.onAddEdge) latest.current.onAddEdge(node.id, createdId)
        if (createdId && latest.current.onSelect) latest.current.onSelect({ kind: 'node', id: createdId })
      },
    }
  }
  const actions = actionsRef.current

  // 装饰器只创建一次：内部按节点缓存「输入没变就复用同一份 React Flow 节点」。
  const decorate = useMemo(() => createNodeDecorator({
    readState: () => latest.current,
    actions,
  }), [actions])

  // 节点位置只在 flow 变化时重建；运行状态 / 选中 / 锁定只改 data，避免拖拽中被轮询重置。
  useEffect(() => {
    const nodes = flow.nodes
    decorate.prune(new Set(nodes.map(node => node.id)))
    setRfNodes(nodes.map(decorate))
  }, [flow, decorate])

  useEffect(() => {
    setRfNodes(previous => previous.map(node => {
      const source = latest.current.flow.nodes.find(item => item.id === node.id)
      if (!source) return node
      const next = decorate(source)
      // 缓存命中时保持同一个对象身份（含拖拽中的实时位置），memo 才有意义。
      return next === node ? node : { ...next, position: node.position, dragging: node.dragging }
    }))
  }, [decorate, nodeStates, selection, locked, linkState])

  const onNodesChange = useCallback(changes => {
    setRfNodes(previous => applyNodeChanges(changes, previous))
  }, [])

  const handleSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }) => {
    const nodeIds = selectedNodes.map(node => node.id).sort()
    const edgeIds = selectedEdges.map(edge => edge.id).sort()
    const key = nodeIds.length > 0 ? 'node:' + nodeIds.join(',') : edgeIds.length > 0 ? 'edge:' + edgeIds.join(',') : ''
    if (key === lastSelectionKey.current) return
    lastSelectionKey.current = key
    if (selectedEdges.length === 1 && selectedNodes.length === 0) {
      onSelect && onSelect({ kind: 'edge', id: selectedEdges[0].id })
      return
    }
    if (selectedNodes.length > 0) {
      onSelect && onSelect({ kind: 'node', id: selectedNodes[0].id })
      return
    }
    if (selectedEdges.length > 0) {
      onSelect && onSelect({ kind: 'edge', id: selectedEdges[0].id })
      return
    }
    onSelect && onSelect(null)
  }, [onSelect])

  // 直接点选是主通道：React Flow 的 onSelectionChange 仍负责框选 / Esc 后的同步，
  // 但边 / 节点的单击不依赖那条异步链路（controlled nodes/edges 下更稳）。
  const handleNodeClick = useCallback((event, node) => {
    lastSelectionKey.current = 'node:' + node.id
    if (onSelect) onSelect({ kind: 'node', id: node.id })
  }, [onSelect])

  const handleEdgeClick = useCallback((event, edge) => {
    lastSelectionKey.current = 'edge:' + edge.id
    if (onSelect) onSelect({ kind: 'edge', id: edge.id })
  }, [onSelect])

  const fit = useCallback(() => {
    if (!latest.current.flow.nodes.length) return
    rf.fitView({ padding: 0.08, minZoom: FIT_MIN, maxZoom: FIT_MAX, duration: 220 })
  }, [rf])

  useEffect(() => {
    if (!apiRef) return undefined
    apiRef.current = {
      fit,
      zoomBy: ratio => {
        const next = Math.max(FIT_MIN, Math.min(ZOOM_MAX, rf.getZoom() * ratio))
        void rf.zoomTo(next, { duration: 120 })
      },
      focusNode: id => {
        const node = latest.current.flow.nodes.find(item => item.id === id)
        if (!node) return
        void rf.setCenter(node.x + NODE_W / 2, node.y + nodeHeight(node) / 2, {
          zoom: Math.max(0.6, rf.getZoom()),
          duration: 260,
        })
      },
    }
    return () => { apiRef.current = null }
  }, [apiRef, fit, rf])

  useEffect(() => {
    if (!initialised.current) {
      initialised.current = true
      fittedFor.current = flow.id || 'draft'
      return undefined
    }
    if (flow.id && fittedFor.current !== flow.id && flow.nodes.length > 0) {
      fittedFor.current = flow.id
      const timer = setTimeout(() => fit(), 30)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [flow.id, flow.nodes.length, fit])

  // 面板宽度变化（例如「全览」收起左右栏）后重新适配。
  useEffect(() => {
    const element = wrapperRef.current
    if (!element) return undefined
    const readSize = () => {
      const rect = element.getBoundingClientRect()
      sizeRef.current = { width: rect.width, height: rect.height }
    }
    readSize()
    if (typeof ResizeObserver === 'undefined') return undefined
    let timer = 0
    const observer = new ResizeObserver(() => {
      readSize()
      clearTimeout(timer)
      timer = setTimeout(() => fit(), 140)
    })
    observer.observe(element)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [fit])

  // Shift+滚轮横移：React Flow 自己管缩放，这条在捕获阶段先吃掉 Shift 手势。
  useEffect(() => {
    const element = wrapperRef.current
    if (!element) return undefined
    const onWheel = event => {
      const pan = wheelPanDelta(event)
      if (pan === null) return
      event.preventDefault()
      event.stopPropagation()
      const viewport = rf.getViewport()
      void rf.setViewport({ ...viewport, x: viewport.x - pan }, { duration: 0 })
    }
    element.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => element.removeEventListener('wheel', onWheel, { capture: true })
  }, [rf])

  const onMove = useCallback((event, viewport) => {
    const percent = Math.round(viewport.zoom * 100)
    if (percent !== zoomRef.current) {
      zoomRef.current = percent
      setZoomPercent(percent)
    }
    const nextLod = lodOf(viewport.zoom)
    if (nextLod !== lodRef.current) {
      lodRef.current = nextLod
      setLod(nextLod)
    }
    const width = sizeRef.current.width
    if (width > 0) {
      const hidden = hiddenColumnsOf(latest.current.flow.nodes, width, viewport.x, viewport.zoom)
      if (hidden !== hiddenRef.current) {
        hiddenRef.current = hidden
        setHiddenColumns(hidden)
      }
    }
  }, [])

  // 拖动中的位置变化只走 React Flow 自己的 onNodesChange；这里默认不回调页面，
  // 松手（onNodeDragStop）时才提交一次最终位置。
  const dragHandlers = useMemo(() => createDragHandlers({
    isLocked: () => Boolean(latest.current.locked),
    onMoveNode: (id, x, y) => {
      if (latest.current.onMoveNode) latest.current.onMoveNode(id, x, y)
    },
  }), [])

  const handleConnect = useCallback(guardStructureEdit(locked, connection => {
    if (!connection || !connection.source || !connection.target) return
    if (!canConnectNodes(latest.current.flow, connection.source, connection.target)) return
    if (onAddEdge) onAddEdge(connection.source, connection.target)
  }), [locked, onAddEdge])

  const handleValidConnection = useCallback(connection => !latest.current.locked
    && canConnectNodes(latest.current.flow, connection.source, connection.target), [])

  const handleDoubleClick = useCallback(guardStructureEdit(locked, event => {
    const target = event.target
    if (target && typeof target.closest === 'function'
      && target.closest('.react-flow__node, .react-flow__edge, .fs-node, .fs-hud, .fs-link-picker, .fs-canvas-note, .fs-canvas-lock, .react-flow__attribution')) return
    const point = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    if (onAddNodeAt) {
      onAddNodeAt(
        Math.round((point.x - NODE_W / 2) / SNAP) * SNAP,
        Math.round((point.y - 48) / SNAP) * SNAP,
      )
    }
  }), [locked, onAddNodeAt, rf])

  // 边只随「节点/边数据、选中、运行状态」变化重建；页面其它 state 变化时复用同一批
  // React Flow edge 对象与 data，避免每帧把所有边重新挂一遍。
  const edgeModel = useMemo(() => {
    const byId = new Map(flow.nodes.map(node => [node.id, node]))
    const lanes = assignRejectLanes(flow.nodes, flow.edges)
    // 第 7 条起并入最外航道：只让其中一条带 +N 汇总角标（确定性：航道末端最右的那条）。
    let flagEdgeId = ''
    let flagX = -Infinity
    for (const edge of flow.edges) {
      if (!lanes.overflow.has(edge.id)) continue
      const lane = lanes.lanes.get(edge.id)
      if (!lane) continue
      const x = Math.max(lane.outSlot, Math.abs(lane.inSlot))
      if (x > flagX) {
        flagX = x
        flagEdgeId = edge.id
      }
    }
    return { byId, lanes, flagEdgeId }
  }, [flow.nodes, flow.edges])
  const { byId, lanes, flagEdgeId } = edgeModel

  const rfEdges = useMemo(() => {
    const out = []
    for (const edge of flow.edges) {
      const from = byId.get(edge.from)
      const to = byId.get(edge.to)
      if (!from || !to) continue
      const selected = Boolean(selection && selection.kind === 'edge' && selection.id === edge.id)
      const active = isEdgeActive(edge, nodeStates)
      const ariaLabel = edgeAriaLabel(edge, byId, nodeStates)
      if (edge.kind === EDGE_KIND.REJECT) {
        const lane = lanes.lanes.get(edge.id)
        if (!lane) continue
        out.push({
          id: edge.id,
          type: 'studioReject',
          source: edge.from,
          target: edge.to,
          sourceHandle: 'out',
          targetHandle: 'in',
          selected,
          animated: active,
          ariaLabel,
          data: {
            laneY: lane.laneY,
            outSlot: lane.outSlot,
            inSlot: lane.inSlot,
            overflow: lanes.overflow.has(edge.id),
            overflowFlag: edge.id === flagEdgeId ? lanes.overflowCount : 0,
            active,
            label: rejectLabelText(edge, nodeStates),
            fromRect: { x: from.x, y: from.y, w: NODE_W, h: nodeHeight(from) },
            toRect: { x: to.x, y: to.y, w: NODE_W, h: nodeHeight(to) },
          },
        })
        continue
      }
      out.push({
        id: edge.id,
        type: 'studioNext',
        source: edge.from,
        target: edge.to,
        sourceHandle: 'out',
        targetHandle: 'in',
        label: edge.label || '',
        selected,
        animated: active,
        ariaLabel,
        data: { active },
      })
    }
    return out
  }, [byId, flagEdgeId, flow.edges, lanes, nodeStates, selection])

  const componentTypes = flowComponentTypes()

  const linkSource = linkState ? byId.get(linkState.fromId) : null
  const candidateIds = linkState && Array.isArray(linkState.candidates) ? linkState.candidates : []
  const activeCandidateId = linkState ? candidateIds[linkState.index] || '' : ''
  const interaction = interactionState(locked)

  return h('div', {
    ref: wrapperRef,
    className: 'fs-canvas' + (locked ? ' locked' : '') + ' fs-canvas-flow',
    'data-canvas-mode': 'flow',
    'data-lod': lod,
    role: 'region',
    'aria-label': canvasAria(flow, lod, locked ? '运行中已锁定结构' : ''),
    onDoubleClick: handleDoubleClick,
  },
  h(ReactFlow, {
    nodes: rfNodes,
    edges: rfEdges,
    nodeTypes: componentTypes.nodeTypes,
    edgeTypes: componentTypes.edgeTypes,
    onNodesChange,
    onNodeClick: handleNodeClick,
    onEdgeClick: handleEdgeClick,
    onSelectionChange: handleSelectionChange,
    onNodeDrag: dragHandlers.onNodeDrag,
    onNodeDragStop: dragHandlers.onNodeDragStop,
    onConnect: handleConnect,
    isValidConnection: handleValidConnection,
    fitView: true,
    fitViewOptions: { padding: 0.08, minZoom: FIT_MIN, maxZoom: FIT_MAX },
    minZoom: FIT_MIN,
    maxZoom: ZOOM_MAX,
    defaultViewport: { x: 48, y: 24, zoom: 0.92 },
    nodesDraggable: interaction.nodesDraggable,
    nodesConnectable: interaction.nodesConnectable,
    nodesFocusable: true,
    edgesFocusable: interaction.edgesFocusable,
    elementsSelectable: true,
    edgesReconnectable: false,
    deleteKeyCode: null,
    zoomOnDoubleClick: false,
    panOnDrag: true,
    selectionOnDrag: false,
    selectionKeyCode: 'Shift',
    snapToGrid: true,
    snapGrid: [SNAP, SNAP],
    connectionLineType: 'smoothstep',
    connectionLineStyle: { stroke: 'var(--dsw-alias-state-business-primary)', strokeWidth: 1.5, strokeDasharray: '4 3' },
    proOptions: { hideAttribution: true },
    ariaLabelConfig: {
      'node.a11yDescription.default': '按 Enter 选中节点；使用方向键在节点间移动',
      'edge.a11yDescription.default': '按 Enter 选中连线',
    },
    onMove,
    className: 'fs-flow',
    style: { width: '100%', height: '100%' },
  }),

  linkState && linkSource
    ? h('div', {
      className: 'fs-link-picker',
      role: 'group',
      'aria-label': '连线候选',
      onPointerDown: event => event.stopPropagation(),
    },
    h('div', { className: 'fs-link-picker-head' }, '连线待定：从「' + linkSource.title + '」到'),
    h('div', { className: 'fs-link-list' },
      candidateIds.map(id => {
        const target = byId.get(id)
        if (!target) return null
        const active = id === activeCandidateId
        return h('button', {
          key: id,
          type: 'button',
          className: 'fs-link-option' + (active ? ' on' : ''),
          onClick: () => onPickCandidate && onPickCandidate(id),
        }, '到 ' + target.title)
      })),
    h('div', { className: 'fs-link-picker-hint' }, 'Tab 切换 · Enter 确认 · Esc 取消'))
    : null,

  locked
    ? h('div', { className: 'fs-canvas-lock', role: 'status' },
      lockReason || '运行中已锁定结构：拖拽 / 双击新建 / 连线 / 检查器编辑暂不可用，停止运行后恢复')
    : null,

  eventWindowNote !== ''
    ? h('div', {
      className: 'fs-canvas-note fs-canvas-event-note',
      title: '节点状态优先取 Host summary.progress；事件只补运行中 / 打回 / attempt 细节',
    }, eventWindowNote)
    : null,

  flow.nodes.length === 0
    ? h('div', { className: 'fs-canvas-empty' }, '画布还是空的：双击空白处新增第一个节点')
    : null,

  hiddenColumns > 0
    ? h('div', { className: 'fs-canvas-note' }, '还有 ' + hiddenColumns + ' 列在视野外')
    : null,

  lanes.overflowCount > 0
    ? h('div', { className: 'fs-canvas-hint' }, '另有 ' + lanes.overflowCount + ' 条打回线并入最外航道（标签已收起）')
    : null,

  h('div', { className: 'fs-hud' },
    h('button', { type: 'button', className: 'fs-hud-btn', title: '缩小', onClick: () => apiRef && apiRef.current && apiRef.current.zoomBy(1 / 1.2) }, '−'),
    h('span', { className: 'fs-hud-val' }, zoomPercent + '%'),
    h('button', { type: 'button', className: 'fs-hud-btn', title: '放大', onClick: () => apiRef && apiRef.current && apiRef.current.zoomBy(1.2) }, '+'),
    h('button', { type: 'button', className: 'fs-hud-btn', title: '适应内容', onClick: fit }, '⤢'),
    h('span', { className: 'fs-hud-lod', title: '当前缩放等级：' + lodText(lod) }, lodText(lod))))
}

/**
 * 对外入口：先给静态回退，客户端挂载且具备 DOM 度量能力后再切 React Flow。
 * 这样 SSR 测试与首帧 HTML 都是完整语义，而不是一个空 div。
 */
export function FlowCanvas(props) {
  const { useState, useEffect } = rt.React
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const canUseFlow = typeof window !== 'undefined' && typeof ResizeObserver !== 'undefined'
  if (!canUseFlow || !mounted) return h(StaticCanvas, props)
  return h(ReactFlowProvider, null, h(FlowCanvasInner, props))
}
