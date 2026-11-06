/**
 * 面板主体：装配顶栏 / 流程列表 / 画布 / 检查器 / 状态栏，并负责自动保存。
 *
 * 编辑一律走「整份流程对象替换」，Host 侧是整份覆盖写，因此不存在半更新中间态。
 * 设计态与运行态是同一张图的两层（运行层留到 v0.3），所以这里只有一块画布，
 * 不切 Tab、不换页面。
 *
 * @module @feiyueve/dsh-flow-studio/client/page
 */

import {
  EDGE_KIND, EXEC_MODE, NODE_KIND, blankEdge, blankFlow, blankNode, summarize, validateFlow,
} from '../model.js'
import { api } from './api.js'
import { FlowCanvas } from './canvas.js'
import { IssuesDialog, PreviewDialog } from './dialogs.js'
import { clearDraft, draftDiffers, readDraft, writeDraft } from './drafts.js'
import { FlowList } from './flowlist.js'
import { Inspector } from './inspector.js'
import {
  beginLink, confirmLink, describeLink, edgeKindBetween, moveLink,
} from './link.js'
import { h, rt } from './runtime.js'
import { CSS } from './styles.js'

function validationLabel(issues) {
  if (issues.errors.length > 0) return issues.errors.length + ' 个错误'
  if (issues.warnings.length > 0) return issues.warnings.length + ' 个提醒'
  return '结构完整'
}

/** 草稿横幅里的时间：固定到分钟，避免每次渲染字节不同。 */
function formatSavedAt(iso) {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return String(iso || '')
  const date = new Date(time)
  const pad = value => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/**
 * @param {object} [props]
 * @param {object} [props.initialFlow] 启动时预置的流程；省略则从 Host 拉第一份。
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
  const [overview, setOverview] = useState(false)
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [keyboardLink, setKeyboardLink] = useState(null)
  const [announce, setAnnounce] = useState('')
  const [draftNotice, setDraftNotice] = useState(null)

  const pinned = useRef(Boolean(initialFlow))
  const flowRef = useRef(null)
  flowRef.current = flow
  const selectionRef = useRef(null)
  selectionRef.current = selection
  const canvasApi = useRef(null)
  const editVersion = useRef(0)
  const savedVersion = useRef(0)
  const draftChecked = useRef('')

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

  /** 把当前快照落到本地草稿（浏览器不可用时退化为内存）。 */
  const persistDraft = useCallback(snapshot => {
    if (!snapshot || !snapshot.id) return null
    try {
      return writeDraft(snapshot, { baseSavedAt: snapshot.updatedAt || '' })
    } catch {
      return null
    }
  }, [])

  const saveNow = useCallback(async target => {
    const snapshot = target || flowRef.current
    if (!snapshot || !snapshot.id) return false
    const version = editVersion.current
    setSaveState('saving')
    try {
      const result = await api.saveFlow(snapshot.id, snapshot)
      const summary = summarize(result.flow)
      setFlows(previous => previous.map(item => (item.id === summary.id ? summary : item)))
      savedVersion.current = version
      setSaveState(current => (editVersion.current === version ? 'saved' : current))
      setError('')
      clearDraft(snapshot.id)
      setDraftNotice(current => (current && current.flowId === snapshot.id ? null : current))
      return true
    } catch (failure) {
      persistDraft(snapshot)
      setSaveState('error')
      setError('保存失败：' + (failure && failure.message ? failure.message : '未知原因')
        + '。改动已存为本地草稿，重试或重新打开该流程可恢复。')
      return false
    }
  }, [persistDraft])

  /** 离开当前流程前：先把改动落草稿，再尝试保存；失败也绝不静默丢弃。 */
  const flushBeforeLeave = useCallback(async () => {
    const current = flowRef.current
    if (!current || !(editVersion.current > savedVersion.current)) return ''
    persistDraft(current)
    const saved = await saveNow(current)
    if (saved) return ''
    return '「' + current.name + '」的改动没能保存，已存本地草稿；重新打开该流程可恢复。'
  }, [persistDraft, saveNow])

  const openFlow = useCallback(async id => {
    const warning = await flushBeforeLeave()
    setBusy(true)
    try {
      const result = await api.readFlow(id)
      // 重新打开时要重新检查草稿：saveNow 失败后刚落的草稿不能因为「这个 id 查过了」被跳过。
      draftChecked.current = ''
      setFlow(result.flow)
      setIssues(result.validation)
      setSelection(null)
      setKeyboardLink(null)
      setSaveState('idle')
      setError(warning || '')
      setBooted(true)
    } catch (failure) {
      setError('打开流程失败：' + (failure && failure.message ? failure.message : '未知原因'))
    } finally {
      setBusy(false)
    }
  }, [flushBeforeLeave])

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
        setError('连不上宿主服务：' + (failure && failure.message ? failure.message : '未知原因'))
        setBooted(true)
      }
    }
    void boot()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (flow) setIssues(validateFlow(flow))
  }, [flow])

  useEffect(() => {
    if (saveState !== 'dirty' || !flow) return undefined
    const timer = setTimeout(() => { void saveNow(flow) }, 700)
    // debounce 被取消（切流程 / 卸载 / 又发生编辑）时先落草稿，定时器清掉不等于改动丢掉。
    return () => {
      clearTimeout(timer)
      const current = flowRef.current
      if (current && editVersion.current > savedVersion.current) persistDraft(current)
    }
  }, [flow, saveState, saveNow, persistDraft])

  // 面板卸载（切页）也不丢：最后一份未保存改动同步落草稿。
  useEffect(() => () => {
    const current = flowRef.current
    if (current && editVersion.current > savedVersion.current) persistDraft(current)
  }, [persistDraft])

  // 打开 / 切到某流程时检查本地草稿；内容与服务器一致就不打扰。
  useEffect(() => {
    const id = flow && flow.id
    if (!id || draftChecked.current === id) return
    draftChecked.current = id
    let record = null
    try {
      record = readDraft(id)
    } catch {
      record = null
    }
    if (!record || !record.flow) return
    if (!draftDiffers(flow, record)) {
      clearDraft(id)
      return
    }
    setDraftNotice({ flowId: id, record })
  }, [flow])

  // 切换流程时退出键盘连线态，避免状态栏还播报上一条流程的候选。
  useEffect(() => {
    setKeyboardLink(null)
    setAnnounce('')
  }, [flow && flow.id])

  // 选中换了节点（点画布别处）就退出连线待定，避免「源」与当前选中不一致。
  useEffect(() => {
    if (keyboardLink && selection && (selection.kind !== 'node' || selection.id !== keyboardLink.fromId)) {
      setKeyboardLink(null)
    }
  }, [keyboardLink, selection])

  const restoreDraft = () => {
    if (!draftNotice) return
    const restored = draftNotice.record.flow
    touch()
    setFlow(restored)
    setIssues(validateFlow(restored))
    setSelection(null)
    setDraftNotice(null)
    setKeyboardLink(null)
    setAnnounce('已恢复本地草稿；保存成功后服务器版本才会覆盖')
    setError('')
  }

  const discardDraft = () => {
    if (!draftNotice) return
    clearDraft(draftNotice.flowId)
    setDraftNotice(null)
    setAnnounce('已丢弃本地草稿')
  }

  const createFlow = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const warning = await flushBeforeLeave()
      const starter = blankFlow('新流程')
      starter.nodes = [
        blankNode(NODE_KIND.START, 60, 220, '任务输入'),
        blankNode(NODE_KIND.STAGE, 320, 220, '新阶段'),
        blankNode(NODE_KIND.END, 580, 220, '完成'),
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
      setKeyboardLink(null)
      setSaveState('idle')
      setError(warning || '')
    } catch (failure) {
      setError('新建失败：' + (failure && failure.message ? failure.message : '未知原因'))
    } finally {
      setBusy(false)
    }
  }, [busy, flushBeforeLeave])

  const removeFlow = useCallback(async id => {
    if (busy) return
    setBusy(true)
    try {
      await api.deleteFlow(id)
      clearDraft(id)
      setDraftNotice(current => (current && current.flowId === id ? null : current))
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
        setKeyboardLink(null)
        editVersion.current = 0
        savedVersion.current = 0
        setSaveState('idle')
      }
    } catch (failure) {
      setError('删除失败：' + (failure && failure.message ? failure.message : '未知原因'))
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
    if (!current || from === to) return null
    if (current.edges.some(edge => edge.from === from && edge.to === to)) {
      setSelection({ kind: 'node', id: to })
      return null
    }
    const kind = edgeKindBetween(current, from, to)
    const edge = blankEdge(from, to, kind)
    touch()
    setFlow(previous => (previous ? { ...previous, edges: [...previous.edges, edge] } : previous))
    setSelection({ kind: 'edge', id: edge.id })
    return edge
  }, [touch])

  /** 检查器里的方向微调：单击 4px，按住 Shift 20px。 */
  const nudgeNode = useCallback((id, dx, dy) => {
    const current = flowRef.current
    if (!current) return
    const node = current.nodes.find(item => item.id === id)
    if (!node) return
    patchNode(id, { x: Math.max(0, Math.round(node.x + dx)), y: Math.max(0, Math.round(node.y + dy)) })
  }, [patchNode])

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

  // 键盘：C 进入连线待定、Tab/方向键换候选、Enter 建边、Esc 退；Delete 删选中、⌘/Ctrl+S 保存。
  useEffect(() => {
    const announceFor = state => {
      const current = flowRef.current
      return current ? describeLink(current, state) + '（Tab 切换，Enter 确认，Esc 取消）' : ''
    }
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
        if (keyboardLink) {
          event.preventDefault()
          setKeyboardLink(null)
          setAnnounce('已取消连线')
        } else if (dialog) setDialog(null)
        else if (overview) setOverview(false)
        else setSelection(null)
        return
      }
      if (typing) return

      if (keyboardLink) {
        if (event.key === 'Tab') {
          event.preventDefault()
          const next = moveLink(keyboardLink, event.shiftKey ? -1 : 1)
          setKeyboardLink(next)
          setAnnounce(announceFor(next))
          return
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          const next = moveLink(keyboardLink, 1)
          setKeyboardLink(next)
          setAnnounce(announceFor(next))
          return
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          const next = moveLink(keyboardLink, -1)
          setKeyboardLink(next)
          setAnnounce(announceFor(next))
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          const pair = confirmLink(keyboardLink)
          const current = flowRef.current
          if (pair && current) {
            const from = current.nodes.find(node => node.id === pair.fromId)
            const to = current.nodes.find(node => node.id === pair.toId)
            const kind = edgeKindBetween(current, pair.fromId, pair.toId)
            addEdge(pair.fromId, pair.toId)
            setKeyboardLink(null)
            setAnnounce('已连接：从「' + (from ? from.title : '?') + '」到「' + (to ? to.title : '?')
              + '」（' + (kind === EDGE_KIND.NEXT ? '正常流转' : '打回') + '）')
          }
          return
        }
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey && String(event.key).toLowerCase() === 'c') {
        const selected = selectionRef.current
        const current = flowRef.current
        if (!selected || selected.kind !== 'node' || !current) return
        const state = beginLink(current.nodes, selected.id)
        if (!state) {
          setAnnounce('没有可连接的节点')
          return
        }
        event.preventDefault()
        setKeyboardLink(state)
        setAnnounce(announceFor(state))
        return
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        const selected = selectionRef.current
        if (!selected) return
        event.preventDefault()
        if (selected.kind === 'node') deleteNode(selected.id)
        else deleteEdge(selected.id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [addEdge, deleteEdge, deleteNode, dialog, keyboardLink, overview, saveNow])

  const saveLabel = saveState === 'dirty' ? '未保存'
    : saveState === 'saving' ? '保存中…'
      : saveState === 'error' ? '保存失败 · 本地草稿'
        : saveState === 'saved' ? '已保存' : '已加载'
  const dotClass = saveState === 'dirty' ? 'dirty'
    : saveState === 'saving' ? 'saving'
      : saveState === 'error' ? 'error' : ''

  const rejectCount = flow ? flow.edges.filter(edge => edge.kind === EDGE_KIND.REJECT).length : 0
  const teamCount = flow ? flow.nodes.filter(node => node.kind === NODE_KIND.STAGE && node.mode === EXEC_MODE.TEAM).length : 0
  const stageCount = flow ? flow.nodes.filter(node => node.kind === NODE_KIND.STAGE).length : 0
  const issueClass = issues.errors.length > 0 ? 'fs-status-bad'
    : issues.warnings.length > 0 ? 'fs-status-warn' : 'fs-status-ok'

  return h('div', { className: 'fs-root' },
    h('style', null, CSS),

    h('header', { className: 'fs-head' },
      h('div', { className: 'fs-head-titles' },
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
            ? stageCount + ' 个阶段 · ' + rejectCount + ' 条打回 · ' + teamCount + ' 个主从节点'
            : '把一条研发流水线画出来，每个节点是一个 agent 角色')),
      h('div', { className: 'fs-save' }, h('span', { className: 'fs-dot ' + dotClass }), saveLabel),
      h('div', { className: 'fs-toolbar' },
        h('button', {
          type: 'button',
          className: 'fs-tool' + (overview ? ' on' : ''),
          title: '全览：临时收起左右两栏，把整条主干放到能读标题的缩放',
          disabled: !flow,
          onClick: () => setOverview(value => !value),
        }, '全览'),
        h('button', {
          type: 'button', className: 'fs-tool', title: '适应内容',
          disabled: !flow,
          onClick: () => canvasApi.current && canvasApi.current.fit(),
        }, '适配'),
        h('button', {
          type: 'button', className: 'fs-btn', disabled: !flow,
          onClick: () => setDialog('preview'),
        }, '预览流转'),
        h('button', { type: 'button', className: 'fs-btn primary', disabled: busy, onClick: createFlow }, '新建流程'))),

    error
      ? h('div', { className: 'fs-error' },
        h('span', null, error),
        h('button', { type: 'button', className: 'fs-tool', onClick: () => setError(''), title: '关闭' }, '✕'))
      : null,

    draftNotice
      ? h('div', { className: 'fs-draft', role: 'status' },
        h('span', { className: 'fs-draft-text' },
          '发现未保存的本地草稿（' + formatSavedAt(draftNotice.record.savedAt) + '）·「'
          + ((draftNotice.record.flow && draftNotice.record.flow.name) || '未命名流程') + '」'),
        h('span', { className: 'fs-status-spacer' }),
        h('button', { type: 'button', className: 'fs-btn sm', onClick: restoreDraft }, '恢复'),
        h('button', { type: 'button', className: 'fs-btn ghost sm', onClick: discardDraft }, '丢弃'))
      : null,

    h('div', { className: 'fs-body' },
      overview
        ? null
        : h(FlowList, {
          flows,
          activeId: flow ? flow.id : '',
          busy,
          collapsed: railCollapsed,
          onToggle: () => setRailCollapsed(value => !value),
          onOpen: id => { void openFlow(id) },
          onCreate: () => { void createFlow() },
          onDelete: id => { void removeFlow(id) },
        }),
      flow
        ? h(FlowCanvas, {
          flow,
          selection,
          apiRef: canvasApi,
          linkState: keyboardLink,
          onSelect: setSelection,
          onMoveNode: (id, x, y) => patchNode(id, { x, y }),
          onAddEdge: addEdge,
          onAddNodeAt: addNodeAt,
          onPickCandidate: id => {
            if (!keyboardLink || !keyboardLink.fromId) return
            const current = flowRef.current
            const from = current ? current.nodes.find(node => node.id === keyboardLink.fromId) : null
            const to = current ? current.nodes.find(node => node.id === id) : null
            const kind = current ? edgeKindBetween(current, keyboardLink.fromId, id) : EDGE_KIND.NEXT
            addEdge(keyboardLink.fromId, id)
            setKeyboardLink(null)
            setAnnounce('已连接：从「' + (from ? from.title : '?') + '」到「' + (to ? to.title : '?')
              + '」（' + (kind === EDGE_KIND.NEXT ? '正常流转' : '打回') + '）')
          },
        })
        : h('div', { className: 'fs-canvas', style: { display: 'flex', alignItems: 'center', justifyContent: 'center' } },
          h('div', { className: 'fs-empty-card' },
            h('div', { className: 'fs-empty-title' }, booted ? '还没有流程模板' : '正在加载…'),
            h('div', { className: 'fs-empty-desc' },
              booted
                ? '新建一条流水线：需求分析 → 方案设计 → 结构设计 → 开发 → 测试 → 代码审查，四处可打回。'
                : '正在从宿主读取流程模板'),
            booted
              ? h('button', { type: 'button', className: 'fs-btn primary', onClick: createFlow }, '新建流程')
              : null)),
      overview
        ? null
        : h(Inspector, {
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
          onConnect: addEdge,
          onNudge: nudgeNode,
        })),

    h('footer', { className: 'fs-status' },
      flow
        ? h('span', null,
          h('b', null, String(flow.nodes.length)), ' 节点 · ',
          h('b', null, String(flow.edges.length)), ' 连线 · ',
          h('b', null, String(rejectCount)), ' 打回')
        : h('span', null, '没有打开任何流程'),
      overview ? h('span', null, '全览模式：Esc 退出') : null,
      h('span', { className: 'fs-status-live', role: 'status', 'aria-live': 'polite' }, announce),
      h('span', { className: 'fs-status-spacer' }),
      h('button', {
        type: 'button',
        className: 'fs-status-btn ' + issueClass,
        disabled: !flow,
        onClick: () => setDialog('issues'),
      }, (issues.errors.length > 0 ? '✕ ' : issues.warnings.length > 0 ? '! ' : '✓ ') + validationLabel(issues))),

    dialog === 'preview' && flow
      ? h(PreviewDialog, { flow, onClose: () => setDialog(null) })
      : null,
    dialog === 'issues'
      ? h(IssuesDialog, { validation: issues, onSelect: setSelection, onClose: () => setDialog(null) })
      : null)
}
