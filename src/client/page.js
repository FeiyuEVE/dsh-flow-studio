/**
 * 面板主体：装配流程列表 / 画布 / 检查器 / 校验与预览，并负责自动保存。
 *
 * 编辑一律走「整份流程对象替换」，Host 侧是整份覆盖写；没有增量补丁协议，
 * 因此不存在半更新的中间态。
 *
 * @module @feiyueve/dsh-flow-studio/client/page
 */

import {
  EDGE_KIND, EXEC_MODE, NODE_KIND, blankEdge, blankFlow, blankNode, makeId, summarize, validateFlow,
} from '../model.js'
import { api } from './api.js'
import { FlowCanvas } from './canvas.js'
import { IssuesDialog, PreviewDialog } from './dialogs.js'
import { FlowList } from './flowlist.js'
import { Inspector } from './inspector.js'
import { h, rt } from './runtime.js'
import { CSS } from './styles.js'

/** 沿正常流转边做可达判定：判断新连线是往前走还是往回退。 */
function canReach(flow, fromId, toId) {
  const adjacency = new Map(flow.nodes.map(node => [node.id, []]))
  for (const edge of flow.edges) {
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

/** 校验摘要文案。 */
function validationText(issues) {
  if (issues.errors.length > 0) return `${issues.errors.length} 个错误`
  if (issues.warnings.length > 0) return `${issues.warnings.length} 个提醒`
  return '结构完整'
}

/**
 * @param {object} [props]
 * @param {object} [props.initialFlow] 启动时预置的流程。省略则从 Host 拉取第一份。
 *   预置时仍会拉列表与 skill 目录，但不会用列表里的流程覆盖它 —— 测试与将来的深链都用这条。
 * @param {Array} [props.initialSkills] 预置的 skill 目录，省一次往返。
 */
export function FlowStudioPage({ initialFlow = null, initialSkills = [] } = {}) {
  const { useState, useEffect, useRef, useCallback } = rt.React

  const [flows, setFlows] = useState(initialFlow ? [summarize(initialFlow)] : [])
  const [flow, setFlow] = useState(initialFlow)
  const [skills, setSkills] = useState(initialSkills)
  const [selection, setSelection] = useState(null)
  const [saveState, setSaveState] = useState('idle')
  const [issues, setIssues] = useState(() => (initialFlow ? validateFlow(initialFlow) : { ok: true, errors: [], warnings: [] }))
  const [dialog, setDialog] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [booted, setBooted] = useState(Boolean(initialFlow))

  const pinned = useRef(Boolean(initialFlow))

  const flowRef = useRef(null)
  flowRef.current = flow
  const selectionRef = useRef(null)
  selectionRef.current = selection
  const editVersion = useRef(0)
  const savedVersion = useRef(0)

  /** 任何编辑：标脏 + 递增版本号。 */
  const touch = useCallback(() => {
    editVersion.current += 1
    setSaveState('dirty')
  }, [])

  const patchFlow = useCallback(patch => {
    touch()
    setFlow(previous => (previous ? { ...previous, ...patch } : previous))
  }, [touch])

  const patchNode = useCallback((id, patch) => {
    touch()
    setFlow(previous => (previous
      ? { ...previous, nodes: previous.nodes.map(node => (node.id === id ? { ...node, ...patch } : node)) }
      : previous))
  }, [touch])

  const patchEdge = useCallback((id, patch) => {
    touch()
    setFlow(previous => (previous
      ? { ...previous, edges: previous.edges.map(edge => (edge.id === id ? { ...edge, ...patch } : edge)) }
      : previous))
  }, [touch])

  /** 立即保存当前流程。失败只标错，不打断编辑。 */
  const saveNow = useCallback(async target => {
    const snapshot = target || flowRef.current
    if (!snapshot || !snapshot.id) return
    const version = editVersion.current
    setSaveState('saving')
    try {
      const result = await api.saveFlow(snapshot.id, snapshot)
      const summary = summarize(result.flow)
      setFlows(previous => previous.map(item => (item.id === summary.id ? summary : item)))
      savedVersion.current = version
      setSaveState(current => (editVersion.current === version ? 'saved' : current))
      setError('')
    } catch (failure) {
      setSaveState('error')
      setError(failure && failure.message ? failure.message : '保存失败')
    }
  }, [])

  /** 打开一份流程；切走前把未落盘的改动先写完。 */
  const openFlow = useCallback(async id => {
    if (editVersion.current > savedVersion.current && flowRef.current) {
      await saveNow(flowRef.current)
    }
    setBusy(true)
    try {
      const result = await api.readFlow(id)
      setFlow(result.flow)
      setIssues(result.validation)
      setSelection(null)
      setSaveState('idle')
      setError('')
    } catch (failure) {
      setError(failure && failure.message ? failure.message : '打开流程失败')
    } finally {
      setBusy(false)
    }
  }, [saveNow])

  // 首次进入：拉流程列表、skill 目录，并打开第一份。
  useEffect(() => {
    let alive = true
    const boot = async () => {
      try {
        const [list, skillResult] = await Promise.all([
          api.listFlows(),
          api.listSkills().catch(() => ({ skills: [] })),
        ])
        if (!alive) return
        setFlows(list.flows)
        setSkills(skillResult.skills || [])
        if (!pinned.current && list.flows.length > 0) {
          const first = await api.readFlow(list.flows[0].id)
          if (!alive) return
          setFlow(first.flow)
          setIssues(first.validation)
          setSaveState('idle')
        }
        setBooted(true)
      } catch (failure) {
        if (!alive) return
        setError(failure && failure.message ? failure.message : '初始化失败')
        setBooted(true)
      }
    }
    void boot()
    return () => { alive = false }
  }, [])

  // 每次流程变化都重算校验：图小，算得起，省一套脏标记。
  useEffect(() => {
    if (flow) setIssues(validateFlow(flow))
  }, [flow])

  // 自动保存：停止编辑 700ms 后落盘。
  useEffect(() => {
    if (saveState !== 'dirty' || !flow) return undefined
    const timer = setTimeout(() => { void saveNow(flow) }, 700)
    return () => clearTimeout(timer)
  }, [flow, saveState, saveNow])

  const createFlow = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      if (editVersion.current > savedVersion.current && flowRef.current) await saveNow(flowRef.current)
      const starter = blankFlow('新流程')
      starter.nodes = [
        blankNode(NODE_KIND.START, 60, 180, '任务输入'),
        blankNode(NODE_KIND.STAGE, 340, 180, '新阶段'),
        blankNode(NODE_KIND.END, 620, 180, '完成'),
      ]
      starter.edges = [
        blankEdge(starter.nodes[0].id, starter.nodes[1].id),
        blankEdge(starter.nodes[1].id, starter.nodes[2].id),
      ]
      const created = await api.createFlow(starter)
      setFlows(previous => [summarize(created.flow), ...previous])
      setFlow(created.flow)
      setIssues(created.validation)
      setSelection({ kind: 'node', id: starter.nodes[1].id })
      setSaveState('idle')
      setError('')
    } catch (failure) {
      setError(failure && failure.message ? failure.message : '新建失败')
    } finally {
      setBusy(false)
    }
  }, [busy, saveNow])

  const removeFlow = useCallback(async id => {
    if (busy) return
    setBusy(true)
    try {
      await api.deleteFlow(id)
      const remaining = flows.filter(item => item.id !== id)
      setFlows(remaining)
      if (flowRef.current && flowRef.current.id === id) {
        if (remaining.length > 0) {
          const next = await api.readFlow(remaining[0].id)
          setFlow(next.flow)
          setIssues(next.validation)
        } else {
          setFlow(null)
          setIssues({ ok: true, errors: [], warnings: [] })
        }
        setSelection(null)
        editVersion.current = 0
        savedVersion.current = 0
        setSaveState('idle')
      }
    } catch (failure) {
      setError(failure && failure.message ? failure.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }, [busy, flows])

  const addNodeAt = useCallback((x, y) => {
    const node = blankNode(NODE_KIND.STAGE, Math.round(x), Math.round(y), '新阶段')
    touch()
    setFlow(previous => (previous ? { ...previous, nodes: [...previous.nodes, node] } : previous))
    setSelection({ kind: 'node', id: node.id })
  }, [touch])

  const addEdge = useCallback((from, to) => {
    const current = flowRef.current
    if (!current || from === to) return
    if (current.edges.some(edge => edge.from === from && edge.to === to)) {
      setSelection({ kind: 'node', id: to })
      return
    }
    // 目标在上游 → 这是一条回退线，自动按「打回」建；否则按正常流转。
    const kind = canReach(current, from, to) ? EDGE_KIND.NEXT : EDGE_KIND.REJECT
    const edge = blankEdge(from, to, kind)
    touch()
    setFlow(previous => (previous ? { ...previous, edges: [...previous.edges, edge] } : previous))
    setSelection({ kind: 'edge', id: edge.id })
  }, [touch])

  const deleteNode = useCallback(id => {
    touch()
    setSelection(null)
    setFlow(previous => (previous
      ? {
        ...previous,
        nodes: previous.nodes.filter(node => node.id !== id),
        edges: previous.edges.filter(edge => edge.from !== id && edge.to !== id),
      }
      : previous))
  }, [touch])

  const deleteEdge = useCallback(id => {
    touch()
    setSelection(null)
    setFlow(previous => (previous ? { ...previous, edges: previous.edges.filter(edge => edge.id !== id) } : previous))
  }, [touch])

  const addMember = useCallback(() => {
    const current = flowRef.current
    const selected = selectionRef.current
    if (!current || !selected || selected.kind !== 'node') return
    const node = current.nodes.find(item => item.id === selected.id)
    if (!node) return
    patchNode(node.id, { team: [...node.team, { name: '', role: '', task: '' }] })
  }, [patchNode])

  // 键盘：Delete 删选中、Esc 取消选中、⌘/Ctrl+S 立即保存。
  useEffect(() => {
    const onKeyDown = event => {
      const target = event.target
      const tag = target && target.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target && target.isContentEditable)
      if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 's') {
        event.preventDefault()
        void saveNow(flowRef.current)
        return
      }
      if (event.key === 'Escape') {
        if (dialog) setDialog(null)
        else setSelection(null)
        return
      }
      if (typing) return
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const selected = selectionRef.current
      if (!selected) return
      event.preventDefault()
      if (selected.kind === 'node') deleteNode(selected.id)
      else deleteEdge(selected.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleteEdge, deleteNode, dialog, saveNow])

  const saveLabel = saveState === 'dirty'
    ? '未保存'
    : saveState === 'saving'
      ? '保存中…'
      : saveState === 'saved'
        ? '已保存'
        : saveState === 'error'
          ? '保存失败'
          : '已同步'
  const saveDotClass = saveState === 'dirty'
    ? 'dirty'
    : saveState === 'saving'
      ? 'busy'
      : saveState === 'error'
        ? 'error'
        : ''

  const rejectCount = flow ? flow.edges.filter(edge => edge.kind === EDGE_KIND.REJECT).length : 0
  const teamCount = flow ? flow.nodes.filter(node => node.kind === NODE_KIND.STAGE && node.mode === EXEC_MODE.TEAM).length : 0

  return h('div', { className: 'fs-root' },
    h('style', null, CSS),

    h('div', { className: 'fs-head' },
      h('div', { className: 'fs-head-title', style: { flex: 1, minWidth: 0 } },
        h('input', {
          className: 'fs-title-input',
          value: flow ? flow.name : '流程编排工作室',
          placeholder: '流程名称',
          readOnly: !flow,
          maxLength: 40,
          onChange: event => patchFlow({ name: event.target.value }),
        }),
        h('div', { className: 'fs-sub' },
          flow
            ? `${flow.nodes.length} 节点 · ${flow.edges.length} 连线 · ${rejectCount} 打回`
            : '可视化配置每个阶段的 agent 角色与流转')),
      h('div', { className: 'fs-save-state' }, h('span', { className: `fs-dot ${saveDotClass}` }), saveLabel),
      h('button', { type: 'button', className: 'fs-btn', disabled: !flow, onClick: () => setDialog('preview') }, '预览流转'),
      h('button', { type: 'button', className: 'fs-btn primary', onClick: createFlow, disabled: busy }, '新建流程')),

    error
      ? h('div', { className: 'fs-error-bar' },
        h('span', null, error),
        h('button', { type: 'button', onClick: () => setError(''), title: '关闭' }, '✕'))
      : null,

    h('div', { className: 'fs-body' },
      h(FlowList, {
        flows,
        activeId: flow ? flow.id : '',
        busy,
        onOpen: id => { void openFlow(id) },
        onCreate: () => { void createFlow() },
        onDelete: id => { void removeFlow(id) },
      }),
      flow
        ? h(FlowCanvas, {
          flow,
          selection,
          onSelect: setSelection,
          onMoveNode: (id, x, y) => patchNode(id, { x, y }),
          onAddEdge: addEdge,
          onAddNodeAt: addNodeAt,
        })
        : h('div', { className: 'fs-canvas', style: { cursor: 'default' } },
          h('div', { className: 'fs-spinner', style: { marginTop: 80 } },
            booted ? '还没有流程模板，点右上角「新建流程」开始。' : '正在加载…')),
      h(Inspector, {
        flow: flow || { nodes: [], edges: [] },
        selection,
        skills,
        onPatchNode: patchNode,
        onPatchEdge: patchEdge,
        onDeleteNode: deleteNode,
        onDeleteEdge: deleteEdge,
        onAddMember: addMember,
        onPatchMember: (nodeId, index, patch) => {
          const current = flowRef.current
          if (!current) return
          const node = current.nodes.find(item => item.id === nodeId)
          if (!node) return
          patchNode(nodeId, { team: node.team.map((member, at) => (at === index ? { ...member, ...patch } : member)) })
        },
        onRemoveMember: (nodeId, index) => {
          const current = flowRef.current
          if (!current) return
          const node = current.nodes.find(item => item.id === nodeId)
          if (!node) return
          patchNode(nodeId, { team: node.team.filter((_, at) => at !== index) })
        },
      })),

    h('div', { className: 'fs-foot' },
      flow
        ? h('span', null, h('b', null, String(flow.nodes.length)), ' 节点 · ', h('b', null, String(flow.edges.length)), ' 连线 · ', h('b', null, String(teamCount)), ' 个主从节点 · ', h('b', null, String(rejectCount)), ' 条打回')
        : h('span', null, '没有打开任何流程'),
      h('span', { className: 'fs-foot-spacer' }),
      h('button', {
        type: 'button',
        className: 'fs-issue-toggle',
        onClick: () => setDialog('issues'),
        disabled: !flow,
      },
      h('span', { className: issues.errors.length > 0 ? 'bad' : issues.warnings.length > 0 ? 'warn' : 'ok' },
        issues.errors.length > 0 ? '✕ ' : issues.warnings.length > 0 ? '! ' : '✓ ',
        validationText(issues)))),

    dialog === 'preview' && flow
      ? h(PreviewDialog, { flow, onClose: () => setDialog(null) })
      : null,
    dialog === 'issues'
      ? h(IssuesDialog, {
        validation: issues,
        onSelect: setSelection,
        onClose: () => setDialog(null),
      })
      : null)
}
