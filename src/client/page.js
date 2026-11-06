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
import { api, runActionFailureText } from './api.js'
import { FlowCanvas } from './canvas.js'
import { IssuesDialog, PreviewDialog } from './dialogs.js'
import { clearDraft, draftDiffers, readDraft, writeDraft } from './drafts.js'
import { FlowList } from './flowlist.js'
import { Inspector } from './inspector.js'
import {
  beginLink, confirmLink, describeLink, edgeKindBetween, moveLink,
} from './link.js'
import {
  FsLogDrawer, conclusionOf, deriveNodeStates, drawerActionFor, eventWindowNote, liveOf,
  runIsActive, runIsPending, runLiveLabel,
} from './logdrawer.js'
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

/** live.phase（06 §2）→ 中文；未知 phase 不显示，不编造。 */
const PHASE_TEXT = { model: '模型调用', tool: '工具调用', spawn: '启动会话', idle: '空闲' }

export function phaseText(phase) {
  return PHASE_TEXT[String(phase || '').toLowerCase()] || ''
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** M1：运行中锁结构的统一原因文案（画布 / 检查器 / 播报共用同一句）。 */
export const RUN_LOCK_REASON = '运行中已锁定结构：拖拽 / 双击新建 / 连线 / 检查器编辑暂不可用，停止运行后恢复'

/** M6：确认停止按钮在第一次点击后至少等 400ms 才可用（防双击击穿）。 */
export const STOP_CONFIRM_DELAY_MS = 400

/** M6：5s 内没有确认就自动解除，并播报（aria-live 由调用方负责）。 */
export const STOP_CONFIRM_TIMEOUT_MS = 5000

/** 校验收口（B2）：错误 → 目标节点/连线 + 可播报文案。纯函数，SSR 也能单测。 */
export function firstErrorTarget(issues) {
  const errors = issues && Array.isArray(issues.errors) ? issues.errors : []
  const first = errors.find(item => isObject(item))
  if (!first) return null
  if (typeof first.nodeId === 'string' && first.nodeId !== '') return { kind: 'node', id: first.nodeId }
  if (typeof first.edgeId === 'string' && first.edgeId !== '') return { kind: 'edge', id: first.edgeId }
  return null
}

/**
 * 开始运行前的门禁：`validateFlow` 有 error 就**不建 run、不起引擎**。
 * 返回 targets 给调用方打开问题列表 + 定位第一条错误。
 */
export function runPreflight(flow) {
  const issues = validateFlow(flow)
  if (issues.errors.length === 0) {
    return { ok: true, issues, target: null, message: '' }
  }
  const target = firstErrorTarget(issues)
  const message = '流程校验未通过：' + issues.errors.length + ' 个错误，已取消开始。'
    + (target ? '已定位到第 1 个错误，可在问题列表逐条修复。' : '请在问题列表里逐条修复。')
  return { ok: false, issues, target, message }
}

/**
 * start 失败后的收口计划（B2）：只有「本次刚新建的 run」才 DELETE，
 * 避免 400 / 409 之后在运行记录里留一条幽灵 pending run；复用的旧 run 不能删。
 */
export function startFailurePlan(action, failure, run, created) {
  return {
    message: runActionFailureText(action, failure && failure.status, failure && failure.data),
    deleteRunId: created && isObject(run) && typeof run.id === 'string' && run.id !== ''
      ? run.id
      : '',
  }
}

/**
 * 运行收口 / 失败的 aria-live 文案（m6）：只在 running → done/failed/aborted 时产生。
 * 纯函数，便于在 SSR 测试里直接断言。
 */
export function runEndAnnouncement(previousStatus, run, summary) {
  if (!isObject(run)) return ''
  const previous = String(previousStatus || '').toLowerCase()
  const status = String(run.status || '').toLowerCase()
  if (previous !== 'running' || status === 'running') return ''
  if (!['done', 'failed', 'aborted'].includes(status)) return ''
  const conclusion = conclusionOf(run, summary)
  const name = run.name || run.id || '本次运行'
  const prefix = status === 'failed' ? '运行失败：' : status === 'aborted' ? '运行已中止：' : '运行已结束：'
  return prefix + name + ' · ' + conclusion.text
}

/**
 * 选「真正带每节点状态」的 progress（B1）：summary / run / detail 三处都可能缺 nodes。
 * 优先 nodes 非空的，其次任意对象，最后 null。
 */
export function progressOf(...candidates) {
  const list = candidates.filter(isObject)
  return list.find(item => isObject(item.nodes) && Object.keys(item.nodes).length > 0)
    || list.find(item => isObject(item))
    || null
}

/**
 * 顶栏 / 画布叠加层的数据源（M2）：跟「当前流程最近活动 run」走，运行中优先；
 * 抽屉里选中历史 run 只影响抽屉自己。
 */
export function activeRunViewOf(snapshot, flow) {
  if (!isObject(snapshot)) return null
  const flowId = flow && flow.id ? String(flow.id) : ''
  const matches = run => isObject(run) && (flowId === '' || String(run.flowId || '') === flowId)
  const build = (run, source) => ({
    run,
    live: source.live || null,
    summary: source.summary || null,
    events: Array.isArray(source.events) ? source.events : [],
    detail: source.detail || null,
    eventsTotal: source.eventsTotal,
    eventsTruncated: source.eventsTruncated === true,
  })
  if (matches(snapshot.activeRun)) {
    return build(snapshot.activeRun, {
      live: snapshot.activeLive,
      summary: snapshot.activeSummary,
      events: snapshot.activeEvents,
      eventsTotal: snapshot.activeEventsTotal,
      eventsTruncated: snapshot.activeEventsTruncated,
    })
  }
  const runs = Array.isArray(snapshot.runs) ? snapshot.runs : []
  const fallback = runs.find(run => matches(run) && runIsActive(run)) || runs.find(run => matches(run))
  if (fallback) {
    const same = snapshot.run && snapshot.run.id === fallback.id
    return build(fallback, same ? snapshot : { live: fallback.live })
  }
  if (matches(snapshot.run)) return build(snapshot.run, snapshot)
  return null
}

/**
 * 顶栏运行控制状态（06 §11）——纯函数，SSR 不跑 useEffect 也能单测。
 *
 * - 运行中：开始按钮禁用并写「运行中」，停止可用；
 * - 第一次点停止只 arm；真正的停止走**独立的「确认停止」按钮**，且要等
 *   `STOP_CONFIRM_DELAY_MS` 才可点（M6：同一按钮双击不再能击穿确认）；
 * - busy 期间两个按钮都禁用，避免连点发出重复 start/stop；
 * - 首次运行列表没回来前禁用「运行」并写清 title（m7）。
 */
export function runControlState(run, {
  busy = false, armed = false, hasFlow = false, listReady = true, confirmReady = false,
} = {}) {
  const running = runIsActive(run)
  const confirming = armed && running
  return {
    running,
    confirming,
    startLabel: busy && !running ? '启动中…' : running ? '运行中' : '运行',
    stopLabel: busy && running ? '停止中…' : '停止',
    confirmLabel: '确认停止',
    startDisabled: !hasFlow || busy || running || !listReady,
    // M6：确认态下主按钮锁死，防止「第一击 arm、第二击 stop」被双击击穿。
    stopDisabled: !hasFlow || !running || busy || confirming,
    confirmDisabled: !confirming || busy || !confirmReady,
    startTitle: !listReady
      ? '正在读取运行记录；确认当前没有运行中的 run 后再开始'
      : running
        ? '当前 run 正在运行；要重新开始请先停止'
        : hasFlow ? '保存当前流程并开始一次新的运行' : '先打开或新建一条流程',
    stopTitle: confirming
      ? '主按钮已锁定：请用右侧「确认停止」按钮（防双击误停）'
      : running
        ? '停止当前运行（第一次点击只进入确认）'
        : '当前没有在运行的 run',
    confirmTitle: confirming
      ? (confirmReady ? '确认停止：会中止在飞的模型请求' : '确认按钮 ' + STOP_CONFIRM_DELAY_MS + 'ms 后才可用（防误触）')
      : '先点「停止」再确认',
  }
}

/**
 * @param {object} [props]
 * @param {object} [props.initialFlow] 启动时预置的流程；省略则从 Host 拉第一份。
 * @param {Array} [props.initialSkills] 预置的 skill 目录，省一次往返。
 * @param {object} [props.initialRunView] 预置运行快照（SSR / 测试用；形状同抽屉
 *   `onRunSnapshot` 的回调参数：`{run, runs, events, summary, live, detail}`）。
 * @param {boolean} [props.initialLogOpen] 抽屉初始是否展开。
 */
export function FlowStudioPage({
  initialFlow = null,
  initialSkills = [],
  initialRunView = null,
  initialLogOpen = false,
  initialError = '',
} = {}) {
  const { useState, useEffect, useRef, useCallback } = rt.React

  const [flows, setFlows] = useState(initialFlow ? [summarize(initialFlow)] : [])
  const [flow, setFlow] = useState(initialFlow)
  const [skills, setSkills] = useState(initialSkills)
  const [selection, setSelection] = useState(null)
  const [saveState, setSaveState] = useState('idle')
  const [issues, setIssues] = useState(() => (initialFlow ? validateFlow(initialFlow) : { ok: true, errors: [], warnings: [] }))
  const [dialog, setDialog] = useState(null)
  const [error, setError] = useState(initialError)
  const [busy, setBusy] = useState(false)
  const [booted, setBooted] = useState(Boolean(initialFlow))
  const [overview, setOverview] = useState(false)
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [keyboardLink, setKeyboardLink] = useState(null)
  const [announce, setAnnounce] = useState('')
  const [draftNotice, setDraftNotice] = useState(null)
  const [logOpen, setLogOpen] = useState(Boolean(initialLogOpen))
  /** 抽屉回传的实时运行快照：顶栏、画布节点状态、停止按钮都从这里取数。 */
  const [runView, setRunView] = useState(initialRunView)
  const [runBusy, setRunBusy] = useState(false)
  const [stopArmed, setStopArmed] = useState(false)
  const [stopConfirmReady, setStopConfirmReady] = useState(false)
  const [logFocus, setLogFocus] = useState(null)
  const [logSync, setLogSync] = useState(0)

  const pinned = useRef(Boolean(initialFlow))
  const flowRef = useRef(null)
  flowRef.current = flow
  const selectionRef = useRef(null)
  selectionRef.current = selection
  const canvasApi = useRef(null)
  const editVersion = useRef(0)
  const savedVersion = useRef(0)
  const draftChecked = useRef('')
  /** M1：运行中锁结构；回调里用 ref 读最新值，避免闭包吃到旧状态。 */
  const lockedRef = useRef(false)
  lockedRef.current = Boolean(runView && runView.activeRun && runIsActive(runView.activeRun))
  /** m6：上一次看到的活动 run 状态，用来只在 running → 收口时播报一次。 */
  const lastRunStatus = useRef({ id: '', status: '' })

  const touch = useCallback(() => {
    editVersion.current += 1
    setSaveState('dirty')
  }, [])

  /** M1：运行中拒绝一切结构编辑，并把原因播报出去（不是静默失效）。 */
  const refuseWhenLocked = useCallback(() => {
    if (!lockedRef.current) return false
    setAnnounce(RUN_LOCK_REASON)
    return true
  }, [])

  const patchFlow = useCallback(patch => {
    touch()
    setFlow(previous => (previous ? { ...previous, ...patch } : previous))
  }, [touch])

  const patchNode = useCallback((id, patch) => {
    if (refuseWhenLocked()) return
    touch()
    setFlow(previous => (previous
      ? { ...previous, nodes: previous.nodes.map(node => (node.id === id ? { ...node, ...patch } : node)) }
      : previous))
  }, [refuseWhenLocked, touch])

  const patchEdge = useCallback((id, patch) => {
    if (refuseWhenLocked()) return
    touch()
    setFlow(previous => (previous
      ? { ...previous, edges: previous.edges.map(edge => (edge.id === id ? { ...edge, ...patch } : edge)) }
      : previous))
  }, [refuseWhenLocked, touch])

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
    if (refuseWhenLocked()) return
    const node = blankNode(NODE_KIND.STAGE, Math.round(x), Math.round(y), '新阶段')
    touch()
    setFlow(previous => (previous ? { ...previous, nodes: [...previous.nodes, node] } : previous))
    setSelection({ kind: 'node', id: node.id })
  }, [refuseWhenLocked, touch])

  const addEdge = useCallback((from, to) => {
    if (refuseWhenLocked()) return null
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
  }, [refuseWhenLocked, touch])

  /** 检查器里的方向微调：单击 4px，按住 Shift 20px。 */
  const nudgeNode = useCallback((id, dx, dy) => {
    if (refuseWhenLocked()) return
    const current = flowRef.current
    if (!current) return
    const node = current.nodes.find(item => item.id === id)
    if (!node) return
    patchNode(id, { x: Math.max(0, Math.round(node.x + dx)), y: Math.max(0, Math.round(node.y + dy)) })
  }, [patchNode, refuseWhenLocked])

  const deleteNode = useCallback(id => {
    if (refuseWhenLocked()) return
    touch()
    setSelection(null)
    setFlow(previous => (previous
      ? {
        ...previous,
        nodes: previous.nodes.filter(node => node.id !== id),
        edges: previous.edges.filter(edge => edge.from !== id && edge.to !== id),
      }
      : previous))
  }, [refuseWhenLocked, touch])

  const deleteEdge = useCallback(id => {
    if (refuseWhenLocked()) return
    touch()
    setSelection(null)
    setFlow(previous => (previous ? { ...previous, edges: previous.edges.filter(edge => edge.id !== id) } : previous))
  }, [refuseWhenLocked, touch])

  const addMember = useCallback(() => {
    if (refuseWhenLocked()) return
    const current = flowRef.current
    const selected = selectionRef.current
    if (!current || !selected || selected.kind !== 'node') return
    const node = current.nodes.find(item => item.id === selected.id)
    if (!node) return
    patchNode(node.id, { team: [...node.team, { name: '', role: '', task: '' }] })
  }, [patchNode, refuseWhenLocked])

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
      // 抽屉里的方向键 / Enter 归事件流自己处理；画布的 C / Delete / 方向键在这里让路。
      const insideLog = Boolean(target && typeof target.closest === 'function' && target.closest('.fs-log'))
      if (drawerActionFor(event) === 'toggle') {
        event.preventDefault()
        setLogOpen(value => !value)
        return
      }
      if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 's') {
        event.preventDefault()
        void saveNow(flowRef.current)
        return
      }
      if (insideLog) {
        // 事件流自己的 Esc 已经在 logdrawer 里 stopPropagation（清详情）；
        // 抽屉其它位置的 Esc 在这里收起抽屉，绝不顺手清掉画布选中。
        if (event.key === 'Escape') {
          event.preventDefault()
          setLogOpen(false)
        }
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
        if (lockedRef.current) {
          event.preventDefault()
          setAnnounce(RUN_LOCK_REASON)
          return
        }
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
        if (lockedRef.current) {
          event.preventDefault()
          setAnnounce(RUN_LOCK_REASON)
          return
        }
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

  // ── 运行控制与实时状态（06 §10/§11）────────────────────────────────────
  // 只认属于当前流程的 run；抽屉里选中别的流程的 run 时，顶栏按「未运行」处理，
  // 画布也不叠加状态（避免把 A 的状态贴到 B 的节点上）。
  // M2：顶栏与画布叠加层跟「当前流程最近活动 run」（运行中优先），与抽屉选中解耦。
  const active = activeRunViewOf(runView, flow)
  const runForFlow = active ? active.run : null
  const runEvents = active ? active.events : []
  const runSummary = active ? active.summary : null
  const runLive = runForFlow ? (active.live || liveOf(runForFlow, active.detail)) : null
  const runStatus = runForFlow ? runForFlow.status : ''
  const stageNodes = flow ? flow.nodes.filter(node => node.kind === NODE_KIND.STAGE) : []
  // B1：状态优先吃 Host 的 progress.nodes（与 nodeDone 同口径），事件只补细节。
  // summary.progress 优先；其次是 run.json 的 progress（列表 / 详情都可能带）。
  const runProgress = progressOf(
    runSummary && runSummary.progress,
    runForFlow && runForFlow.progress,
    active && active.detail && active.detail.run && active.detail.run.progress,
  )
  const nodeStates = runForFlow
    ? deriveNodeStates({
      nodes: stageNodes,
      events: runEvents,
      live: runLive,
      runStatus,
      progress: runProgress,
    })
    : null
  const liveLabel = runForFlow
    ? runLiveLabel(runForFlow, runLive, { nodes: flow.nodes, events: runEvents })
    : ''
  const liveHint = runLive
    ? [liveLabel, phaseText(runLive.phase), runLive.since ? '开始于 ' + runLive.since : '']
      .filter(Boolean).join(' · ')
    : liveLabel
  const locked = Boolean(runForFlow && runIsActive(runForFlow))
  lockedRef.current = locked
  const listReady = Boolean(runView && runView.loaded === true)
  const windowNote = active
    ? eventWindowNote({ truncated: active.eventsTruncated, loadedCount: runEvents.length })
    : ''
  const control = runControlState(runForFlow, {
    busy: runBusy,
    armed: stopArmed,
    hasFlow: Boolean(flow),
    listReady,
    confirmReady: stopConfirmReady,
  })

  const handleRunSnapshot = useCallback(snapshot => { setRunView(snapshot) }, [])

  // M6：第一次点停止只 arm；确认按钮 400ms 后才可用，5s 内不确认自动解除并播报。
  useEffect(() => {
    if (!stopArmed) {
      setStopConfirmReady(false)
      return undefined
    }
    setStopConfirmReady(false)
    const readyTimer = setTimeout(() => setStopConfirmReady(true), STOP_CONFIRM_DELAY_MS)
    const cancelTimer = setTimeout(() => {
      setStopArmed(false)
      setAnnounce('停止确认已超时自动解除，运行继续')
    }, STOP_CONFIRM_TIMEOUT_MS)
    return () => {
      clearTimeout(readyTimer)
      clearTimeout(cancelTimer)
    }
  }, [stopArmed])

  useEffect(() => {
    if (stopArmed && !runIsActive(runForFlow)) setStopArmed(false)
  }, [stopArmed, runForFlow])

  // 切流程退出停止确认，避免把上一条流程的确认态带过去。
  useEffect(() => {
    setStopArmed(false)
    setStopConfirmReady(false)
  }, [flow && flow.id])

  // M1：运行中锁结构时清掉键盘连线待定，避免停在「待连线」却点不出去。
  useEffect(() => {
    if (!locked) return
    setKeyboardLink(null)
  }, [locked])

  // m6：运行收口 / 失败进 aria-live（只在 running → 收口时播报一次）。
  useEffect(() => {
    const previous = lastRunStatus.current
    const message = runEndAnnouncement(previous.status, runForFlow, runSummary)
    if (message !== '') setAnnounce(message)
    lastRunStatus.current = {
      id: runForFlow ? String(runForFlow.id || '') : '',
      status: runForFlow ? String(runForFlow.status || '') : '',
    }
  }, [runForFlow, runSummary])

  /**
   * 开始运行（B2）：
   *  1. 先 `validateFlow`：有 error 就**不建 run、不起引擎**，打开问题列表并定位第一条错误；
   *  2. 未保存改动落盘（引擎读的是 Host 上的流程）；
   *  3. 复用本流程的 pending run 或新建一个，最后 POST start；
   *  4. start 失败且 run 是本次新建的 → DELETE 清掉，绝不留幽灵 run。
   */
  const beginRun = async () => {
    if (!flow || runBusy) return
    if (!listReady) {
      setAnnounce('正在读取运行记录，确认当前没有运行中的 run 后再开始')
      return
    }
    setRunBusy(true)
    setStopArmed(false)
    setStopConfirmReady(false)
    setError('')
    let run = null
    let createdRun = null
    try {
      const preflight = runPreflight(flowRef.current)
      setIssues(preflight.issues)
      if (!preflight.ok) {
        if (preflight.target) setSelection(preflight.target)
        setDialog('issues')
        setAnnounce(preflight.message)
        return
      }
      const warning = await flushBeforeLeave()
      if (warning) {
        setError(warning)
        setAnnounce('流程尚未保存，已取消开始')
        return
      }
      const current = flowRef.current
      if (!current) return
      const known = runView && Array.isArray(runView.runs) ? runView.runs : []
      const pending = known.find(item => item.flowId === current.id && runIsPending(item))
      run = pending || null
      if (!run) {
        const created = await api.createRun({
          flowId: current.id,
          name: current.name + ' · ' + formatSavedAt(new Date().toISOString()),
        })
        run = created && created.run ? created.run : null
        if (run && run.id) createdRun = run
      }
      if (!run || !run.id) throw new Error('Host 没有返回 run')
      const started = await api.startRun(run.id)
      const liveRun = started && started.run ? started.run : run
      // 抽屉自动展开并切到这个 run；同步 token 让它立刻刷新一次。
      setLogOpen(true)
      setLogFocus({ id: run.id, nonce: Date.now() })
      setLogSync(value => value + 1)
      setAnnounce('已开始运行「' + (liveRun.name || run.name || run.id) + '」')
    } catch (failure) {
      const plan = startFailurePlan('start', failure, run, Boolean(createdRun))
      if (plan.deleteRunId !== '') {
        // 本次刚建的 run 启动失败：清掉，避免运行记录里留下一条永远 pending 的幽灵。
        try {
          await api.deleteRun(plan.deleteRunId)
          setAnnounce(plan.message + '（已清理本次新建的 run）')
        } catch {
          setAnnounce(plan.message + '（新建的 run 清理失败，请在运行记录里删除它）')
        }
      } else {
        setAnnounce(plan.message)
      }
      setError(plan.message)
      setLogSync(value => value + 1)
    } finally {
      setRunBusy(false)
    }
  }

  /** M6：第一次点「停止」只 arm；确认由独立的「确认停止」按钮完成。 */
  const requestStop = async () => {
    if (!runForFlow || runBusy || stopArmed) return
    setStopArmed(true)
    setStopConfirmReady(false)
    setAnnounce('停止需要确认：' + STOP_CONFIRM_DELAY_MS + 'ms 后点「确认停止」按钮')
  }

  /** 独立确认按钮：400ms 后可用，真正 POST stop。 */
  const confirmStop = async () => {
    if (!runForFlow || runBusy || !stopArmed || !stopConfirmReady) return
    setRunBusy(true)
    setStopArmed(false)
    setStopConfirmReady(false)
    try {
      const result = await api.stopRun(runForFlow.id)
      const settled = result && result.run ? result.run : null
      if (settled) {
        // 乐观合入 stop 返回的状态；下一次抽屉轮询会以 Host 为准。
        setRunView(previous => {
          if (!previous) return previous
          const next = { ...previous }
          if (previous.run && previous.run.id === settled.id) next.run = { ...previous.run, ...settled }
          if (previous.activeRun && previous.activeRun.id === settled.id) {
            next.activeRun = { ...previous.activeRun, ...settled }
          }
          if (Array.isArray(previous.runs)) {
            next.runs = previous.runs.map(item => (item.id === settled.id ? { ...item, ...settled } : item))
          }
          return next
        })
      }
      setAnnounce('已请求停止运行「' + (runForFlow.name || runForFlow.id) + '」，等待引擎收尾')
      setLogSync(value => value + 1)
    } catch (failure) {
      const message = runActionFailureText('stop', failure && failure.status, failure && failure.data)
      setError(message)
      setAnnounce(message)
      setLogSync(value => value + 1)
    } finally {
      setRunBusy(false)
    }
  }

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
      liveLabel
        // 只做视觉实时读数；播报统一走底栏那个 aria-live，避免同一变化被读两遍。
        ? h('div', { className: 'fs-live', title: liveHint },
          h('span', { className: 'fs-live-dot', 'aria-hidden': true }),
          h('span', { className: 'fs-live-text' }, liveLabel))
        : null,
      h('div', { className: 'fs-runbar' },
        h('button', {
          type: 'button',
          className: 'fs-btn primary run',
          disabled: control.startDisabled,
          title: control.startTitle,
          onClick: () => { void beginRun() },
        }, control.startLabel),
        h('button', {
          type: 'button',
          className: 'fs-btn danger run-stop',
          disabled: control.stopDisabled,
          title: control.stopTitle,
          onClick: () => { void requestStop() },
        }, control.stopLabel),
        // M6：确认停止是独立按钮，落点必须变化，且 400ms 后才可用，双击同一点击不穿。
        control.confirming
          ? h('button', {
            type: 'button',
            className: 'fs-btn danger sm run-stop-confirm',
            disabled: control.confirmDisabled,
            title: control.confirmTitle,
            onClick: () => { void confirmStop() },
          }, control.confirmLabel)
          : null,
        control.confirming
          ? h('button', {
            type: 'button',
            className: 'fs-btn ghost sm',
            onClick: () => {
              setStopArmed(false)
              setStopConfirmReady(false)
              setAnnounce('已取消停止，运行继续')
            },
          }, '取消')
          : null),
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
      ? h('div', { className: 'fs-error', role: 'alert' },
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
          nodeStates,
          locked,
          lockReason: RUN_LOCK_REASON,
          eventWindowNote: windowNote,
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
          locked,
          lockReason: RUN_LOCK_REASON,
          onPatchNode: patchNode,
          onPatchEdge: patchEdge,
          onDeleteNode: deleteNode,
          onDeleteEdge: deleteEdge,
          onAddMember: addMember,
          onPatchMember: (nodeId, index, patch) => {
            if (refuseWhenLocked()) return
            const current = flowRef.current
            if (!current) return
            const node = current.nodes.find(item => item.id === nodeId)
            if (!node) return
            patchNode(nodeId, { team: node.team.map((member, at) => (at === index ? { ...member, ...patch } : member)) })
          },
          onRemoveMember: (nodeId, index) => {
            if (refuseWhenLocked()) return
            const current = flowRef.current
            if (!current) return
            const node = current.nodes.find(item => item.id === nodeId)
            if (!node) return
            patchNode(nodeId, { team: node.team.filter((_, at) => at !== index) })
          },
          onConnect: addEdge,
          onNudge: nudgeNode,
        })),

    h(FsLogDrawer, {
      open: logOpen,
      onToggle: () => setLogOpen(value => !value),
      flowId: flow ? flow.id : '',
      flowName: flow ? flow.name : '',
      onRunSnapshot: handleRunSnapshot,
      focusRun: logFocus,
      syncToken: logSync,
      // 首帧（SSR / 预置快照）就带上抽屉数据，避免打开时先闪一下空态；
      // 浏览器里首次挂载 runView 为 null，抽屉仍走自己的加载路径。
      initialRuns: runView && Array.isArray(runView.runs) ? runView.runs : null,
      initialRunId: runView && runView.run ? runView.run.id : '',
      initialSummary: runView ? runView.summary : null,
      initialDetail: runView ? runView.detail : null,
      initialEvents: runView ? runView.events : null,
      // 复用画布既有选中逻辑：选中节点 + 收起抽屉，让画布拿回高度。
      onJumpToNode: id => {
        const current = flowRef.current
        const node = current ? current.nodes.find(item => item.id === id) : null
        if (!node) {
          setAnnounce('运行日志里的节点「' + id + '」不在当前流程')
          return
        }
        setSelection({ kind: 'node', id })
        setKeyboardLink(null)
        setLogOpen(false)
        setAnnounce('已定位到节点「' + node.title + '」')
      },
    }),

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
