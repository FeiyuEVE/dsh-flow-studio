/**
 * 画布：节点、连线、拖拽、连线创建、平移缩放。
 *
 * 坐标系分两层：节点放在被 transform 的 `.fs-world` 里（逻辑坐标），连线画在
 * **容器级 SVG**（屏幕坐标）里 —— 这样线宽与箭头不随缩放失真，SVG 也不需要跟着变大。
 * 打回线走下方航道（`geometry.assignRejectLanes`），不用弧线：弧线跨度越大越深，
 * 四条一叠就糊成一团。
 *
 * @module @feiyueve/dsh-flow-studio/client/canvas
 */

import { EDGE_KIND, EXEC_MODE, NODE_KIND, NODE_W } from '../model.js'
import { FIT_MIN, assignRejectLanes, fitView, hiddenColumnsOf, lodOf, nextPath, nodeAt, nodeHeight } from './geometry.js'
import { h, rt } from './runtime.js'

/** 手动缩放地板与适配地板同源，避免「适配进得去、手动缩不到」。 */
const ZOOM_MIN = FIT_MIN
const ZOOM_MAX = 2
const SNAP = 4
const CORNER = 10

/**
 * 滚轮手势口径（01 §5.1 #7/#8）：Shift+滚轮横移，裸滚轮与 Ctrl/Cmd+滚轮（含 pinch）缩放。
 * 横移优先用 deltaY；触控板横向手势只给 deltaX 时同样映射到横移。
 * 返回横向增量（屏幕 px，方向未取反），非横移返回 null。Ctrl/Cmd 优先于 Shift，保证 pinch 仍缩放。
 */
export function wheelPanDelta(event) {
  if (!event.shiftKey || event.ctrlKey || event.metaKey) return null
  return event.deltaY !== 0 ? event.deltaY : (event.deltaX || 0)
}

/** 屏幕坐标 → 逻辑坐标。 */
function toLogical(clientX, clientY, rect, view) {
  return {
    x: (clientX - rect.left - view.x) / view.z,
    y: (clientY - rect.top - view.y) / view.z,
  }
}

/** 打回线：源底缘下降 → 水平航道 → 目标底缘上升。入参已是屏幕坐标。 */
function rejectScreenPath(sx, sy, tx, ty, laneY) {
  const left = sx > tx
  const step = left ? -CORNER : CORNER
  return {
    d: [
      `M ${sx} ${sy}`,
      `L ${sx} ${laneY - CORNER}`,
      `Q ${sx} ${laneY} ${sx + step} ${laneY}`,
      `L ${tx - step} ${laneY}`,
      `Q ${tx} ${laneY} ${tx} ${laneY - CORNER}`,
      `L ${tx} ${ty}`,
    ].join(' '),
    labelX: sx + (tx - sx) * 0.24,
    labelY: laneY - 5,
  }
}

function ArrowDefs() {
  const one = (id, color) => h('marker', {
    id,
    viewBox: '0 0 10 7',
    refX: 9,
    refY: 3.5,
    markerWidth: 10,
    markerHeight: 7,
    markerUnits: 'userSpaceOnUse',
    orient: 'auto-start-reverse',
  }, h('path', { d: 'M0,0 L10,3.5 L0,7 z', fill: color }))
  return h('defs', null,
    one('fs-arrow', 'var(--dsw-alias-label-tertiary)'),
    one('fs-arrow-reject', 'var(--fs-r1-warn)'),
    one('fs-arrow-sel', 'var(--dsw-alias-state-business-primary)'))
}

/** 角色摘要：取第一句，太长交给 CSS 省略。 */
function summaryOf(node) {
  if (node.kind === NODE_KIND.START) return '流程入口'
  if (node.kind === NODE_KIND.END) return '流程出口'
  return node.role ? node.role.split(/[。\n]/)[0] : '未设置角色'
}

/**
 * 成员点底色：同色系深浅梯度。
 * 宿主没有 categorical 色板，用色相区分身份会违反 token 硬约束（见 02 §4.4）。
 */
function memberTint(index) {
  const weight = Math.min(35, 12 + index * 5)
  return `color-mix(in srgb, var(--dsw-alias-state-business-primary) ${weight}%, var(--dsw-alias-bg-layer-2))`
}

function NodeCard({ node, selected, rejects, candidate, activeCandidate, onPointerDown, onStartLink }) {
  const isStage = node.kind === NODE_KIND.STAGE
  const team = isStage && node.mode === EXEC_MODE.TEAM && node.team.length > 0
  const tags = []
  if (rejects > 0) tags.push(h('span', { key: 'r', className: 'fs-tag reject' }, `↺${rejects}`))
  if (node.skills.length > 0) tags.push(h('span', { key: 's', className: 'fs-tag skill' }, `skill ${node.skills.length}`))

  return h('div', {
    className: 'fs-node kind-' + node.kind + (selected ? ' selected' : '')
      + (candidate ? ' fs-link-target' : '') + (activeCandidate ? ' fs-link-active' : ''),
    style: { left: node.x, top: node.y, width: NODE_W, height: nodeHeight(node) },
    onPointerDown,
    role: 'button',
    tabIndex: 0,
    'aria-label': '节点 ' + node.title + (activeCandidate ? '，键盘连线目标' : ''),
    'aria-pressed': selected ? 'true' : 'false',
  },
  isStage ? h('div', { className: 'fs-port in', 'aria-hidden': true }) : null,
  h('div', { className: 'fs-node-title' },
    node.title,
    team ? h('span', { className: 'fs-tag team' }, '主从 ' + node.team.length) : null),
  h('div', { className: 'fs-node-summary' }, summaryOf(node)),
  team
    ? h('div', { className: 'fs-members', title: '主管 + ' + node.team.length + ' 个子 agent' },
      h('span', { className: 'fs-member lead' }, '主'),
      node.team.slice(0, 5).map((member, at) => h('span', {
        key: at,
        className: 'fs-member',
        title: member.name || '子 agent ' + (at + 1),
        style: {
          background: memberTint(at),
          color: at >= 2 ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-label-primary)',
        },
      }, (member.name || '子').slice(0, 1))),
      node.team.length > 5 ? h('span', { className: 'fs-members-more' }, '+' + (node.team.length - 5)) : null)
    : null,
  h('div', { className: 'fs-node-tags' }, tags),
  node.kind === NODE_KIND.END
    ? null
    : h('div', {
      className: 'fs-port out',
      'aria-hidden': true,
      title: '拖到另一个节点上建立连线',
      onPointerDown: onStartLink,
    }),
  )
}

export function FlowCanvas({ flow, selection, apiRef, linkState, onSelect, onMoveNode, onAddEdge, onAddNodeAt, onPickCandidate }) {
  const { useState, useEffect, useRef, useCallback } = rt.React
  const containerRef = useRef(null)
  const [view, setView] = useState({ x: 48, y: 24, z: 0.92 })
  const [dragKind, setDragKind] = useState(null)
  const [link, setLink] = useState(null)

  const viewRef = useRef(view)
  viewRef.current = view
  const flowRef = useRef(flow)
  flowRef.current = flow
  const dragRef = useRef(null)
  const fittedFor = useRef('')

  const nodes = flow.nodes
  const byId = new Map(nodes.map(node => [node.id, node]))
  const heights = new Map(nodes.map(node => [node.id, nodeHeight(node)]))
  const lanes = assignRejectLanes(nodes, flow.edges)
  const linkSource = linkState ? byId.get(linkState.fromId) : null
  const candidateIds = linkState && Array.isArray(linkState.candidates) ? linkState.candidates : []
  const candidateSet = new Set(candidateIds)
  const activeCandidateId = linkState ? candidateIds[linkState.index] || '' : ''
  const rejectCount = new Map()
  for (const edge of flow.edges) {
    if (edge.kind === EDGE_KIND.REJECT) rejectCount.set(edge.from, (rejectCount.get(edge.from) || 0) + 1)
  }

  const doFit = useCallback(() => {
    const element = containerRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    if (rect.width < 10 || rect.height < 10) return
    setView(fitView(flowRef.current.nodes, rect.width, rect.height))
  }, [])

  useEffect(() => {
    if (!apiRef) return undefined
    apiRef.current = {
      fit: doFit,
      zoomBy: ratio => {
        const element = containerRef.current
        if (!element) return
        const rect = element.getBoundingClientRect()
        setView(current => {
          const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, current.z * ratio))
          const px = rect.width / 2
          const py = rect.height / 2
          const x = px - (px - current.x) * (next / current.z)
          const y = py - (py - current.y) * (next / current.z)
          return {
            x,
            y,
            z: next,
            clamped: current.clamped,
            hiddenColumns: hiddenColumnsOf(flowRef.current.nodes, rect.width, x, next),
          }
        })
      },
    }
    return () => { apiRef.current = null }
  }, [apiRef, doFit])

  useEffect(() => {
    const key = flow.id || 'draft'
    if (nodes.length > 0 && fittedFor.current !== key) {
      fittedFor.current = key
      doFit()
    }
  }, [flow.id, nodes.length, doFit])

  // 面板宽度变化（例如「全览」收起左右栏）后重新适配。
  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    let timer = 0
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => doFit(), 140)
    })
    observer.observe(element)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [doFit])

  // 滚轮：裸滚轮 / Ctrl-Cmd 缩放（以指针为中心），Shift+滚轮横向平移。
  // React 的 onWheel 可能是 passive，用原生监听显式 preventDefault。
  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined
    const onWheel = event => {
      event.preventDefault()
      const pan = wheelPanDelta(event)
      if (pan !== null) {
        // 1px 滚轮增量 = 1px 视口位移，与中键 / 空格拖动同一手感；横移只改 x，不改 z。
        if (pan !== 0) setView(current => ({ ...current, x: current.x - pan }))
        return
      }
      const rect = element.getBoundingClientRect()
      const current = viewRef.current
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, current.z * Math.exp(-event.deltaY * 0.0016)))
      if (next === current.z) return
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      const x = px - (px - current.x) * (next / current.z)
      const y = py - (py - current.y) * (next / current.z)
      setView({
        x,
        y,
        z: next,
        clamped: current.clamped,
        hiddenColumns: hiddenColumnsOf(flowRef.current.nodes, rect.width, x, next),
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  // 拖动期间只挂一次 window 监听，读最新值一律走 ref。
  useEffect(() => {
    if (dragKind === null) return undefined
    const element = containerRef.current

    const onMove = event => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.mode === 'pan') {
        setView(current => ({
          ...current,
          x: drag.viewX + (event.clientX - drag.clientX),
          y: drag.viewY + (event.clientY - drag.clientY),
        }))
        return
      }
      if (drag.mode === 'node') {
        const z = viewRef.current.z
        let nx = drag.nodeX + (event.clientX - drag.clientX) / z
        let ny = drag.nodeY + (event.clientY - drag.clientY) / z
        if (!event.altKey) {
          nx = Math.round(nx / SNAP) * SNAP
          ny = Math.round(ny / SNAP) * SNAP
        }
        onMoveNode(drag.id, nx, ny)
        return
      }
      if (drag.mode === 'link' && element) {
        const rect = element.getBoundingClientRect()
        setLink({ from: drag.id, x: event.clientX - rect.left, y: event.clientY - rect.top })
      }
    }

    const onUp = event => {
      const drag = dragRef.current
      dragRef.current = null
      setDragKind(null)
      if (drag && drag.mode === 'link' && element) {
        const rect = element.getBoundingClientRect()
        const point = toLogical(event.clientX, event.clientY, rect, viewRef.current)
        const target = nodeAt(flowRef.current.nodes, point)
        if (target && target !== drag.id) onAddEdge(drag.id, target)
        setLink(null)
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragKind, onMoveNode, onAddEdge])

  const startPan = event => {
    if (event.button !== 0) return
    const target = event.target
    if (target && typeof target.closest === 'function' && target.closest('.fs-node, .fs-edge-hit, .fs-hud, .fs-link-picker, .fs-canvas-note, .fs-canvas-hint')) return
    onSelect(null)
    dragRef.current = { mode: 'pan', clientX: event.clientX, clientY: event.clientY, viewX: view.x, viewY: view.y }
    setDragKind('pan')
  }

  const startNodeDrag = (event, node) => {
    if (event.button !== 0) return
    event.stopPropagation()
    onSelect({ kind: 'node', id: node.id })
    dragRef.current = {
      mode: 'node', id: node.id,
      clientX: event.clientX, clientY: event.clientY,
      nodeX: node.x, nodeY: node.y,
    }
    setDragKind('node')
  }

  const startLink = (event, node) => {
    if (event.button !== 0) return
    event.stopPropagation()
    const rect = containerRef.current.getBoundingClientRect()
    dragRef.current = { mode: 'link', id: node.id }
    setLink({ from: node.id, x: event.clientX - rect.left, y: event.clientY - rect.top })
    setDragKind('link')
  }

  const onDoubleClick = event => {
    const target = event.target
    if (target && typeof target.closest === 'function' && target.closest('.fs-node, .fs-edge-hit, .fs-hud, .fs-link-picker, .fs-canvas-note, .fs-canvas-hint')) return
    const rect = containerRef.current.getBoundingClientRect()
    const point = toLogical(event.clientX, event.clientY, rect, view)
    onAddNodeAt(
      Math.round((point.x - NODE_W / 2) / SNAP) * SNAP,
      Math.round((point.y - 48) / SNAP) * SNAP,
    )
  }

  /** 屏幕坐标下一条线的路径。 */
  const geometryFor = edge => {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) return null
    const scale = view.z
    const fx = from.x * scale + view.x
    const fy = from.y * scale + view.y
    const tx = to.x * scale + view.x
    const ty = to.y * scale + view.y
    const fh = (heights.get(from.id) || 96) * scale
    const th = (heights.get(to.id) || 96) * scale

    if (edge.kind === EDGE_KIND.REJECT) {
      const lane = lanes.lanes.get(edge.id)
      if (!lane) return null
      const sx = fx + (NODE_W / 2 + lane.outSlot) * scale
      const ex = tx + (NODE_W / 2 + lane.inSlot) * scale
      const path = rejectScreenPath(sx, fy + fh, ex, ty + th, lane.laneY * scale + view.y)
      return { d: path.d, label: { x: path.labelX, y: path.labelY }, reject: true }
    }

    const path = nextPath({ x: fx, y: fy + fh / 2 }, { x: tx, y: ty + th / 2 })
    return { d: path.d, label: null, reject: false }
  }

  const renderEdges = () => {
    const items = []
    for (const edge of flow.edges) {
      const geometry = geometryFor(edge)
      if (!geometry) continue
      const selected = Boolean(selection && selection.kind === 'edge' && selection.id === edge.id)
      const marker = selected
        ? 'url(#fs-arrow-sel)'
        : geometry.reject ? 'url(#fs-arrow-reject)' : 'url(#fs-arrow)'
      items.push(h('g', { key: edge.id },
        h('path', {
          className: 'fs-edge-hit',
          d: geometry.d,
          onPointerDown: event => {
            event.stopPropagation()
            onSelect({ kind: 'edge', id: edge.id })
          },
        }),
        h('path', {
          className: 'fs-edge' + (geometry.reject ? ' reject' : '') + (selected ? ' selected' : ''),
          d: geometry.d,
          markerEnd: marker,
          style: { pointerEvents: 'none' },
        })))
      if (geometry.reject && !lanes.overflow.has(edge.id)) {
        items.push(h('text', {
          key: edge.id + '-l',
          className: 'fs-edge-label',
          x: geometry.label.x,
          y: geometry.label.y,
          textAnchor: 'middle',
        }, edge.label || '打回'))
      }
    }

    // 第 7 条起并入最外航道：这些边不再各带标签，只在航道末端汇总一个 +N。
    if (lanes.overflowCount > 0 && lanes.outerLaneY !== null) {
      let laneEndX = -Infinity
      for (const edge of flow.edges) {
        if (!lanes.overflow.has(edge.id)) continue
        const lane = lanes.lanes.get(edge.id)
        const from = byId.get(edge.from)
        const to = byId.get(edge.to)
        if (!lane || !from || !to) continue
        const sx = from.x * view.z + view.x + (NODE_W / 2 + lane.outSlot) * view.z
        const ex = to.x * view.z + view.x + (NODE_W / 2 + lane.inSlot) * view.z
        laneEndX = Math.max(laneEndX, sx, ex)
      }
      if (Number.isFinite(laneEndX)) {
        items.push(h('text', {
          key: 'lane-overflow',
          className: 'fs-edge-flag',
          x: laneEndX,
          y: lanes.outerLaneY * view.z + view.y - 4,
          textAnchor: 'end',
        }, '+' + lanes.overflowCount))
      }
    }

    if (link) {
      const from = byId.get(link.from)
      if (from) {
        const fx = from.x * view.z + view.x + NODE_W * view.z
        const fy = from.y * view.z + view.y + ((heights.get(from.id) || 96) * view.z) / 2
        items.push(h('path', {
          key: 'link-preview',
          className: 'fs-link-preview',
          d: nextPath({ x: fx, y: fy }, { x: link.x, y: link.y }).d,
          style: { pointerEvents: 'none' },
        }))
      }
    }
    return items
  }

  const lod = lodOf(view.z)
  const overflow = lanes.overflowCount
  const hiddenColumns = view.hiddenColumns || 0

  return h('div', {
    ref: containerRef,
    className: 'fs-canvas' + (dragKind === 'pan' ? ' panning' : '') + (dragKind === 'link' ? ' linking' : ''),
    'data-lod': lod,
    onPointerDown: startPan,
    onDoubleClick,
  },
  h('div', {
    className: 'fs-world',
    style: { transform: 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.z + ')' },
  }, nodes.map(node => h(NodeCard, {
    key: node.id,
    node,
    selected: Boolean(selection && selection.kind === 'node' && selection.id === node.id),
    rejects: rejectCount.get(node.id) || 0,
    candidate: candidateSet.has(node.id),
    activeCandidate: node.id === activeCandidateId,
    onPointerDown: event => startNodeDrag(event, node),
    onStartLink: event => startLink(event, node),
  }))),

  h('svg', { className: 'fs-edges', width: '100%', height: '100%' },
    h(ArrowDefs, null),
    renderEdges()),

  // 键盘连线待定：候选以「到 <节点名>」的可读名字列出，Tab 移、Enter 确认、Esc 取消。
  linkState && linkSource
    ? h('div', {
      className: 'fs-link-picker',
      role: 'group',
      'aria-label': '连线候选',
      onPointerDown: event => event.stopPropagation(),
    },
    h('div', { className: 'fs-link-picker-head' },
      '连线待定：从「' + linkSource.title + '」到'),
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

  hiddenColumns > 0
    ? h('div', { className: 'fs-canvas-note' }, '还有 ' + hiddenColumns + ' 列在视野外')
    : null,

  overflow > 0
    ? h('div', { className: 'fs-canvas-hint' }, '另有 ' + overflow + ' 条打回线并入最外航道（标签已收起）')
    : null,

  h('div', { className: 'fs-hud' },
    h('button', {
      type: 'button', className: 'fs-hud-btn', title: '缩小',
      onClick: () => apiRef.current && apiRef.current.zoomBy(1 / 1.2),
    }, '−'),
    h('span', { className: 'fs-hud-val' }, Math.round(view.z * 100) + '%'),
    h('button', {
      type: 'button', className: 'fs-hud-btn', title: '放大',
      onClick: () => apiRef.current && apiRef.current.zoomBy(1.2),
    }, '+'),
    h('button', { type: 'button', className: 'fs-hud-btn', title: '适应内容', onClick: doFit }, '⤢')))
}
