/**
 * 画布：节点拖拽、端口连线、打回线、平移缩放。
 *
 * 坐标系分两层：节点放在被 transform 的 `.fs-world` 里（逻辑坐标），连线画在
 * 容器级 SVG 里（屏幕坐标，每次渲染时把逻辑坐标乘上缩放再加上平移）。
 * 这样 SVG 不需要跟着缩放变大，线宽与箭头也不会随缩放失真。
 *
 * @module @feiyueve/dsh-flow-studio/client/canvas
 */

import { NODE_H, NODE_W, EDGE_KIND, EXEC_MODE, NODE_KIND } from '../model.js'
import { h, rt, clamp } from './runtime.js'

const ZOOM_MIN = 0.35
const ZOOM_MAX = 1.8

/** 屏幕坐标 → 逻辑坐标。 */
function toLogical(clientX, clientY, rect, view) {
  return {
    x: (clientX - rect.left - view.x) / view.z,
    y: (clientY - rect.top - view.y) / view.z,
  }
}

/** 命中测试：返回坐标落在哪个节点上。 */
function nodeAt(nodes, point) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (point.x >= node.x && point.x <= node.x + NODE_W && point.y >= node.y && point.y <= node.y + NODE_H) {
      return node.id
    }
  }
  return null
}

/** 正常流转边：左右锚点之间的三次贝塞尔。 */
function nextPath(a, b) {
  const dx = Math.max(46, Math.abs(b.x - a.x) * 0.45)
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
}

/** 打回边：向下兜一个大弯，视觉上和正常流转区分开。 */
function rejectPath(a, b) {
  const dip = Math.max(a.y, b.y) + Math.max(56, Math.abs(b.x - a.x) * 0.18)
  return `M ${a.x} ${a.y} C ${a.x + 52} ${dip}, ${b.x - 52} ${dip}, ${b.x} ${b.y}`
}

/** 取路径中点，用来摆标签。 */
function midpoint(a, b, isReject) {
  if (!isReject) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const dip = Math.max(a.y, b.y) + Math.max(56, Math.abs(b.x - a.x) * 0.18)
  // 三次贝塞尔在 t=0.5 处的取值（控制点 c1=(a.x+52,dip)、c2=(b.x-52,dip)）。
  return { x: (a.x + 3 * (a.x + 52) + 3 * (b.x - 52) + b.x) / 8, y: (a.y + 6 * dip + b.y) / 8 }
}

function edgeMarkers() {
  const marker = (id, fill) => h('marker', {
    id,
    viewBox: '0 0 8 8',
    refX: 7,
    refY: 4,
    markerWidth: 7,
    markerHeight: 7,
    orient: 'auto-start-reverse',
  }, h('path', { d: 'M0,0 L8,4 L0,8 z', fill }))

  return h('defs', null,
    marker('fs-arrow', 'var(--dsw-alias-border-l4)'),
    marker('fs-arrow-reject', 'var(--dsw-alias-state-warn-primary)'),
    marker('fs-arrow-selected', 'var(--dsw-alias-brand-primary)'))
}

export function FlowCanvas({ flow, selection, onSelect, onMoveNode, onAddEdge, onAddNodeAt }) {
  const { useState, useEffect, useRef } = rt.React
  const containerRef = useRef(null)
  const [view, setView] = useState({ x: 48, y: 24, z: 0.92 })
  const [dragKind, setDragKind] = useState(null)
  const [link, setLink] = useState(null)

  // 拖动 / 缩放的回调在 window 上，读最新值一律走 ref，避免每帧重建监听器。
  const viewRef = useRef(view)
  viewRef.current = view
  const flowRef = useRef(flow)
  flowRef.current = flow
  const dragRef = useRef(null)
  const linkRef = useRef(null)
  linkRef.current = link

  const nodes = flow.nodes
  const byId = new Map(nodes.map(node => [node.id, node]))
  const rejectCount = new Map()
  for (const edge of flow.edges) {
    if (edge.kind === EDGE_KIND.REJECT) rejectCount.set(edge.from, (rejectCount.get(edge.from) || 0) + 1)
  }

  /** 把逻辑矩形换算成屏幕坐标矩形。 */
  const screenRect = node => ({
    x: node.x * view.z + view.x,
    y: node.y * view.z + view.y,
    w: NODE_W * view.z,
    h: NODE_H * view.z,
  })

  /** 起点/终点锚点（屏幕坐标）。 */
  const anchors = (fromId, toId) => {
    const from = byId.get(fromId)
    const to = byId.get(toId)
    if (!from || !to) return null
    const a = screenRect(from)
    const b = screenRect(to)
    return {
      a: { x: a.x + a.w, y: a.y + a.h / 2 },
      b: { x: b.x, y: b.y + b.h / 2 },
    }
  }

  // 滚轮缩放：React 的 onWheel 在部分环境是 passive，这里用原生监听显式 preventDefault。
  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined
    const onWheel = event => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const current = viewRef.current
      const factor = Math.exp(-event.deltaY * 0.0016)
      const nextZ = clamp(current.z * factor, ZOOM_MIN, ZOOM_MAX)
      if (nextZ === current.z) return
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      setView({
        x: px - (px - current.x) * (nextZ / current.z),
        y: py - (py - current.y) * (nextZ / current.z),
        z: nextZ,
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  // 拖动期间只挂一次 window 监听。
  useEffect(() => {
    if (dragKind === null) return undefined
    const element = containerRef.current

    const onMove = event => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.mode === 'pan') {
        setView(current => ({ ...current, x: drag.viewX + (event.clientX - drag.clientX), y: drag.viewY + (event.clientY - drag.clientY) }))
        return
      }
      if (drag.mode === 'node') {
        const z = viewRef.current.z
        onMoveNode(drag.id, Math.round(drag.nodeX + (event.clientX - drag.clientX) / z), Math.round(drag.nodeY + (event.clientY - drag.clientY) / z))
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
    if (target && typeof target.closest === 'function' && target.closest('.fs-node, .fs-edge-hit, .fs-zoom')) return
    dragRef.current = { mode: 'pan', clientX: event.clientX, clientY: event.clientY, viewX: view.x, viewY: view.y }
    setDragKind('pan')
  }

  const startNodeDrag = (event, node) => {
    if (event.button !== 0) return
    event.stopPropagation()
    onSelect({ kind: 'node', id: node.id })
    dragRef.current = {
      mode: 'node',
      id: node.id,
      clientX: event.clientX,
      clientY: event.clientY,
      nodeX: node.x,
      nodeY: node.y,
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

  const zoomBy = ratio => {
    const element = containerRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const current = viewRef.current
    const nextZ = clamp(current.z * ratio, ZOOM_MIN, ZOOM_MAX)
    const px = rect.width / 2
    const py = rect.height / 2
    setView({
      x: px - (px - current.x) * (nextZ / current.z),
      y: py - (py - current.y) * (nextZ / current.z),
      z: nextZ,
    })
  }

  const fitView = () => {
    const element = containerRef.current
    if (!element || nodes.length === 0) return
    const rect = element.getBoundingClientRect()
    const minX = Math.min(...nodes.map(n => n.x))
    const minY = Math.min(...nodes.map(n => n.y))
    const maxX = Math.max(...nodes.map(n => n.x + NODE_W))
    const maxY = Math.max(...nodes.map(n => n.y + NODE_H))
    const pad = 56
    const z = clamp(Math.min((rect.width - pad * 2) / Math.max(1, maxX - minX), (rect.height - pad * 2) / Math.max(1, maxY - minY)), ZOOM_MIN, 1.2)
    setView({
      x: (rect.width - (maxX - minX) * z) / 2 - minX * z,
      y: (rect.height - (maxY - minY) * z) / 2 - minY * z,
      z,
    })
  }

  // 首次拿到有内容的流程时把视图对准内容。
  const fittedRef = useRef('')
  useEffect(() => {
    const key = `${flow.id}:${nodes.length}`
    if (nodes.length > 0 && fittedRef.current !== key) {
      fittedRef.current = key
      fitView()
    }
  }, [flow.id, nodes.length])

  const onDoubleClick = event => {
    const target = event.target
    if (target && typeof target.closest === 'function' && target.closest('.fs-node, .fs-edge-hit, .fs-zoom')) return
    const rect = containerRef.current.getBoundingClientRect()
    const point = toLogical(event.clientX, event.clientY, rect, view)
    onAddNodeAt(point.x - NODE_W / 2, point.y - NODE_H / 2)
  }

  const renderEdges = () => {
    const items = []
    for (const edge of flow.edges) {
      const anchor = anchors(edge.from, edge.to)
      if (!anchor) continue
      const isReject = edge.kind === EDGE_KIND.REJECT
      const selected = selection && selection.kind === 'edge' && selection.id === edge.id
      const d = isReject ? rejectPath(anchor.a, anchor.b) : nextPath(anchor.a, anchor.b)
      const marker = selected ? 'url(#fs-arrow-selected)' : isReject ? 'url(#fs-arrow-reject)' : 'url(#fs-arrow)'
      items.push(h('g', { key: edge.id },
        h('path', {
          className: 'fs-edge-hit',
          d,
          onPointerDown: event => {
            event.stopPropagation()
            onSelect({ kind: 'edge', id: edge.id })
          },
        }),
        h('path', {
          className: `fs-edge${isReject ? ' reject' : ''}${selected ? ' selected' : ''}`,
          d,
          markerEnd: marker,
          style: { pointerEvents: 'none' },
        })))
      if (isReject) {
        const mid = midpoint(anchor.a, anchor.b, true)
        items.push(h('text', {
          key: `${edge.id}-label`,
          className: 'fs-edge-label reject',
          x: mid.x,
          y: mid.y - 4,
          textAnchor: 'middle',
          style: { pointerEvents: 'none' },
        }, edge.label || '打回'))
      }
    }
    if (link) {
      const fromNode = byId.get(link.from)
      if (fromNode) {
        const rect = screenRect(fromNode)
        const a = { x: rect.x + rect.w, y: rect.y + rect.h / 2 }
        items.push(h('path', {
          key: 'link-preview',
          className: 'fs-link-preview',
          d: nextPath(a, { x: link.x, y: link.y }),
          style: { pointerEvents: 'none' },
        }))
      }
    }
    return items
  }

  return h('div', {
    ref: containerRef,
    className: `fs-canvas${dragKind === 'pan' ? ' panning' : ''}`,
    onPointerDown: startPan,
    onDoubleClick,
  },
  h('div', {
    className: 'fs-world',
    style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` },
  }, nodes.map(node => {
    const selected = selection && selection.kind === 'node' && selection.id === node.id
    const rejects = rejectCount.get(node.id) || 0
    const tags = []
    if (node.kind === NODE_KIND.STAGE && node.mode === EXEC_MODE.TEAM) {
      tags.push(h('span', { key: 'team', className: 'fs-tag team' }, `主从 ${node.team.length}`))
    }
    if (rejects > 0) tags.push(h('span', { key: 'reject', className: 'fs-tag reject' }, `打回 ${rejects}`))
    if (node.skills.length > 0) tags.push(h('span', { key: 'skill', className: 'fs-tag skill' }, `skill ${node.skills.length}`))
    const meta = node.kind === NODE_KIND.START
      ? '流程入口'
      : node.kind === NODE_KIND.END
        ? '流程出口'
        : (node.role ? node.role.split(/[。\n]/)[0].slice(0, 26) : '未设置角色')

    return h('div', {
      key: node.id,
      className: `fs-node kind-${node.kind}${selected ? ' selected' : ''}`,
      style: { left: node.x, top: node.y, width: NODE_W, height: NODE_H },
      onPointerDown: event => startNodeDrag(event, node),
    },
    node.kind === NODE_KIND.STAGE
      ? h('div', { className: 'fs-port in', title: '输入' })
      : null,
    h('div', { className: 'fs-node-title' }, node.title),
    h('div', { className: 'fs-node-meta' }, meta),
    tags.length > 0 ? h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } }, tags) : null,
    node.kind === NODE_KIND.END
      ? null
      : h('div', {
        className: 'fs-port out',
        title: '拖到另一个节点上创建连线',
        onPointerDown: event => startLink(event, node),
      }),
    )
  })),
  h('svg', { className: 'fs-svg', width: '100%', height: '100%' },
    edgeMarkers(),
    renderEdges()),
  h('div', { className: 'fs-zoom' },
    h('button', { type: 'button', title: '缩小', onClick: () => zoomBy(1 / 1.2) }, '−'),
    h('span', { className: 'fs-zoom-level' }, `${Math.round(view.z * 100)}%`),
    h('button', { type: 'button', title: '放大', onClick: () => zoomBy(1.2) }, '+'),
    h('button', { type: 'button', title: '适应内容', onClick: fitView }, '⤢')),
  )
}
