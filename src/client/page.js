/**
 * 流程编排工作室主页面（0.13.3 步骤 5：BPMN 定义 / 实例 + bpmn.io 画布）。
 *
 * 页面结构：
 *
 *   ┌ 顶栏：新建 / 导入 / 模板 / 保存版本 / 运行 / 刷新 / 保存状态 ┐
 *   ├ 左：定义列表（GET /definitions）───────────┬ 中：BPMN 画布 ┬ 右：实例 / 待办 ┤
 *   └ 底：实例事件抽屉（GET /instances/<id>/events?since=）──────────────────────┘
 *
 * 三条不可退让的语义（docs/design/10-bpmn-instance-api.md、计划书步骤 5）：
 *
 * 1. **编辑与保存**：画布 `commandStack.changed` 只递增修订号并去抖写本地 XML 草稿；
 *    点「保存版本」才 `POST /definitions`。保存时先提交属性面板里可能还在去抖中的
 *    输入、再序列化最新 XML；响应只清「提交时那一版」的 dirty，切定义/乱序响应/
 *    失败都不能覆盖新草稿。
 * 2. **运行**：必须已有钉住的 `definitionVersion` 且没有未保存修改；
 *    `POST /instances {definitionId, definitionVersion, variables}`。201 带执行错误时
 *    **保留实例**并展示 `lastError`，不自动删除/重建。
 * 3. **实例视图**：只读 NavigatedViewer + 实例冻结快照
 *    `GET /instances/<id>/definition`；状态只用 `ACTIVE/COMPLETED/SUSPENDED/CANCELED`，
 *    等待人工用 `pendingTasks`、错误用 `lastError`；运行态 marker 不写回 XML。
 *
 * SSR：本模块顶层不访问 `document` / `window`，画布是 `BpmnCanvas` 壳（chunk 只在
 * effect 里加载）；所有请求都在 effect / 事件回调里发起。
 *
 * @module @feiyueve/dsh-flow-studio/client/page
 */

import { api } from './api.js'
import {
  createEditRevision, createSaveQueue, createTaskCompletionGuard,
  completionFailurePlan, nextEventsQuery, projectElementStates,
} from './bpmn-state.js'
import { BpmnCanvas } from './canvas.js'
import { createDefinitionState } from './definition-state.js'
import { clearDraft, draftDiffers, readDraft, writeDraft, DRAFT_DEBOUNCE_MS, DRAFT_MAX_WAIT_MS } from './drafts.js'
import { DefinitionList, definitionsFromPayload } from './flowlist.js'
import { InstanceWorktreePanel } from './instance-worktree.js'
import { InstanceInboxPanel } from './instance-inbox.js'
import { InstanceMetricsPanel, MetricsSummaryPanel } from './instance-metrics.js'
import {
  InstanceEventDrawer, focusBpmnElement, mergeInstanceEvents, nextEventPollDelay,
} from './logdrawer.js'
import { h, rt } from './runtime.js'
import { CSS } from './styles.js'
import {
  InstancePanel, instanceErrorOf, instanceStatusText, isTerminalStatus, normalizeTasks,
  taskSubmitBody,
} from './tasklist.js'
import { getTemplate, listTemplates, templateXml } from './templates.js'

/** 页面标题。 */
export const PAGE_TITLE = '流程编排工作室'
/** 属性面板输入的去抖上限（官方默认 600ms + 一点余量）。 */
export const PROPERTY_COMMIT_WAIT_MS = 650
/** 实例事件轮询间隔（与 logdrawer 的 nextEventPollDelay 共用）。 */
const INSTANCE_POLL_MS = 2000
/** 终态前追平事件的补拉上限：Host 游标异常时也不能死循环。 */
const TERMINAL_EVENT_CATCHUP_LIMIT = 8

/**
 * 生成一个合法的定义 id（新定义 / 导入未命名时用）。
 * 只用小写字母、数字、连字符，≤64 字符，不以点开头。
 */
export function newDefinitionId(now = Date.now(), random = Math.random()) {
  const stamp = Math.max(0, Math.trunc(Number(now) || 0)).toString(36)
  const noise = Math.max(0, Math.floor((Number(random) || 0) * 36 ** 4)).toString(36).padStart(3, '0')
  return `flow-${stamp}-${noise}`.slice(0, 64)
}

/**
 * 「运行」被挡住的原因；空串 = 可以运行。
 * 与 `definition-state.runPayload()` 同口径，页面按钮 title 与提示共用。
 */
export function runBlockReason(state) {
  if (!state || typeof state !== 'object') return '还没有选择定义。'
  if (state.dirty) return '有未保存的修改：先保存版本，再运行。'
  if (!Number.isSafeInteger(state.version) || state.version < 1) {
    return '没有已保存的版本，先保存版本再运行。'
  }
  if (typeof state.definitionId !== 'string' || state.definitionId === '') {
    return '还没有保存过定义，先保存一个版本再运行。'
  }
  return ''
}

/** 保存状态 + 版本 → 顶栏可读文案。 */
export function saveStateText(status, state) {
  if (status === 'saving') return '保存中…'
  if (status === 'error') return '保存失败'
  if (status === 'saved' && state && Number.isSafeInteger(state.version)) return `已保存 v${state.version}`
  if (state && state.dirty) return '有未保存修改'
  if (state && Number.isSafeInteger(state.version)) return `已保存 v${state.version}`
  return '未保存'
}

/**
 * 实例事件 → 画布运行态 marker 列表（`{elementId, state}`）。
 *
 * 只把事件里的 BPMN `elementId` 映射成 marker；`activityId` / `executionId`
 * 不是图元 id，绝不参与。未知事件不参与推导（由 elementStateMap 忽略）。
 */
export function runtimeMarkersFromEvents(events) {
  const states = projectElementStates(events)
  const markers = []
  for (const state of Object.values(states)) {
    const elementId = state && typeof state.elementId === 'string' ? state.elementId : ''
    if (elementId === '') continue
    let marker = ''
    if (state.status === 'running') marker = 'active'
    else if (state.status === 'waiting') marker = 'waiting'
    else if (state.status === 'completed') marker = 'completed'
    else if (state.status === 'failed' || state.status === 'error') marker = 'failed'
    if (marker === '') continue
    markers.push({ elementId, state: marker })
  }
  return markers
}

/**
 * 把运行态 marker 推给画布；**不**触发任何保存 / 草稿调度。
 * @returns {number} marker 数量
 */
export function syncRuntimeMarkers(editor, markers) {
  if (!editor || typeof editor.setRuntimeState !== 'function') return 0
  const list = Array.isArray(markers) ? markers : []
  editor.setRuntimeState(list)
  return list.length
}

/**
 * 保存前等待属性面板输入提交：
 * - 文本输入在 blur 时同步提交（官方 Textfield 的 onBlur 会 flush）；
 * - CodeMirror / contenteditable 的 JSON 编辑器没有 blur flush，需要等去抖窗。
 *
 * @param {object} editor mountEditor() 控制器
 * @param {{waitMs?: number, delay?: (ms:number)=>Promise<any>}} [options]
 * @returns {Promise<{waited: boolean, waitedMs: number, flushed: object|null}>}
 */
export async function commitPendingProperties(editor, options = {}) {
  // 官方弹出编辑器挂在 document.body，不在编辑器容器内：先让画布关闭弹窗并 flush
  // 去抖输入，再做容器内焦点兜底。
  let flushed = null
  if (editor && typeof editor.flushProperties === 'function') {
    try {
      flushed = await editor.flushProperties()
    } catch {
      flushed = null
    }
  }
  const container = editor && typeof editor.getContainer === 'function' ? editor.getContainer() : null
  if (!container) return { waited: false, waitedMs: 0, flushed }
  let field = null
  try {
    field = container.querySelector(
      'input:focus, textarea:focus, select:focus, [contenteditable="true"]:focus, [contenteditable=""]:focus',
    )
  } catch {
    field = null
  }
  if (!field) return { waited: false, waitedMs: 0, flushed }
  const isContentEditable = field.isContentEditable === true
    || field.getAttribute?.('contenteditable') === 'true'
    || field.getAttribute?.('contenteditable') === ''
  try {
    if (typeof field.blur === 'function') field.blur()
  } catch {
    // blur 失败不阻断保存：序列化前还会再取一次最新 XML
  }
  if (!isContentEditable) {
    // blur 已同步提交；让 preact 的命令栈回调先跑完。
    await Promise.resolve()
    return { waited: false, waitedMs: 0, flushed }
  }
  const waitMs = Number.isFinite(options.waitMs) ? Math.max(0, options.waitMs) : PROPERTY_COMMIT_WAIT_MS
  const delay = typeof options.delay === 'function'
    ? options.delay
    : ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
  await delay(waitMs)
  return { waited: true, waitedMs: waitMs, flushed }
}

/** `GET /instances` 信封 / 裸数组 → 实例数组（丢掉没有 id 的坏行）。 */
export function instancesFromPayload(payload) {
  const list = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === 'object' && Array.isArray(payload.instances) ? payload.instances : [])
  const rows = []
  const seen = new Set()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    rows.push(entry)
  }
  return rows
}

/** 错误对象 → 可读原因（网络错误 / Host 业务错误都覆盖）。 */
export function failureMessage(error) {
  if (!error) return '未知原因'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/**
 * 编辑器控制器报告的「不可用」原因（导入回滚重建失败后的显式降级态）。
 * 页面必须据此把画布标成 error 并展示原因，不能继续提示“导入成功”。
 */
export function editorUnavailableReason(editor) {
  if (!editor || typeof editor.getUnavailableReason !== 'function') return ''
  const reason = editor.getUnavailableReason()
  return typeof reason === 'string' ? reason : (reason ? String(reason) : '')
}

/** 事件游标：取事件 max(seq) 与提供值里的较大者。 */
export function eventCursorOf(events, fallback = 0) {
  let cursor = Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : 0
  for (const event of Array.isArray(events) ? events : []) {
    if (event && Number.isSafeInteger(event.seq) && event.seq > cursor) cursor = event.seq
  }
  return cursor
}

/**
 * 面板主体。
 *
 * 测试注入（全部可选）：`initialDefinitions` / `initialDefinition` /
 * `initialInstances` / `initialInstance` / `initialInstanceDefinition` /
 * `initialTasks` / `initialEvents` / `initialDrawerOpen` / `initialNotice` /
 * `initialDirty` / `apiClient` / `hostRequire`。
 */
export function FlowStudioPage(props = {}) {
  const React = rt.React
  if (!React) throw new Error('FlowStudioPage 需要先由宿主注入 React（bindReact）')
  const { useCallback, useEffect, useMemo, useRef, useState } = React

  const client = props.apiClient && typeof props.apiClient.readDefinition === 'function'
    ? props.apiClient
    : api

  const initialDefinition = props.initialDefinition && typeof props.initialDefinition === 'object'
    ? props.initialDefinition
    : null
  const initialInstance = props.initialInstance && typeof props.initialInstance === 'object'
    ? props.initialInstance
    : null
  const initialEvents = Array.isArray(props.initialEvents) ? props.initialEvents : []
  const initialInstanceXml = props.initialInstanceDefinition
    && typeof props.initialInstanceDefinition.xml === 'string'
    ? props.initialInstanceDefinition.xml
    : ''

  const definitionStateRef = useRef(null)
  if (definitionStateRef.current === null) {
    definitionStateRef.current = createDefinitionState(initialDefinition || {})
    if (props.initialDirty === true) definitionStateRef.current.markDirty()
  }
  const revisionRef = useRef(null)
  if (revisionRef.current === null) revisionRef.current = createEditRevision()
  const draftIdRef = useRef(initialDefinition && initialDefinition.id ? initialDefinition.id : newDefinitionId())
  const editorRef = useRef(null)
  const viewRef = useRef(initialInstance
    ? {
      kind: 'instance',
      instanceId: typeof initialInstance.id === 'string' ? initialInstance.id : '',
      xml: initialInstanceXml,
      markers: runtimeMarkersFromEvents(initialEvents),
    }
    : { kind: 'definition', xml: initialDefinition && typeof initialDefinition.xml === 'string' ? initialDefinition.xml : '', markers: [] })
  const viewSeqRef = useRef(0)
  // 视图选择世代：定义与实例**共用**同一个计数器。打开定义 / 打开实例 / 新建 / 导入
  // 都 +1，让两条加载链上的所有在飞请求一起失效；响应回来先比对世代再落地，
  // 迟到的实例响应因此不能覆盖后来选择的定义（反之亦然）。
  const selectSeqRef = useRef(0)
  // 在飞的「视图选择事务」世代集合（复审 R3）：迟到请求只允许在**没有更新选择在途**
  // 时修复画布；否则会把正在加载的最新视图替换掉。每个选择入口开始时登记、结束时注销。
  const inFlightSelectionsRef = useRef(new Set())
  const beginSelection = () => {
    const seq = ++selectSeqRef.current
    inFlightSelectionsRef.current.add(seq)
    return seq
  }
  const endSelection = seq => { inFlightSelectionsRef.current.delete(seq) }
  const hasNewerSelectionInFlight = seq => {
    for (const other of inFlightSelectionsRef.current) {
      if (other > seq) return true
    }
    return false
  }
  const eventsRef = useRef(initialEvents.slice())
  // 已消费游标：只取**实际返回事件**的最大 seq。Host 的 `lastSeq` 是「预留游标」
  // （先写 instance.lastSeq、后追加事件），可能超前于可读事件；拿它当 since 会
  // 永久跳过尚未落盘的事件（0.13.4 复审 M3）。
  const lastSeqRef = useRef(eventCursorOf(initialEvents))
  // Host 目标游标：只用于判断「终态是否已经追平」，绝不作为 since 使用。
  const targetSeqRef = useRef(initialInstance && Number.isSafeInteger(initialInstance.lastSeq)
    ? initialInstance.lastSeq
    : 0)
  // 「实例已终态」与「事件已追平」是两件事：只有后者为 true 才能停轮询。
  const initialCaughtUp = initialInstance !== null && isTerminalStatus(initialInstance.status)
    ? eventCursorOf(initialEvents) >= targetSeqRef.current
    : false
  const eventsCaughtUpRef = useRef(initialCaughtUp)
  // 事件缓存属于哪个实例：切实例时立即清空，绝不复用上一个实例的事件 / 游标。
  const eventsInstanceRef = useRef(initialInstance && typeof initialInstance.id === 'string'
    ? initialInstance.id
    : '')
  // 「最后一次成功提交的画布视图」：实例详情 / 任务 / 事件 / 视图是同一事务
  // （复审 N1）。加载期间只把结果放本地，全部成功才一起提交；失败或过期时页面
  // 状态本来就还停在上一次提交的那一组，过期导入只允许恢复到这个视图。
  const committedViewRef = useRef(viewRef.current)
  const tasksGuardRef = useRef(createTaskCompletionGuard())
  const draftQueueRef = useRef(null)
  const saveInFlightRef = useRef(false)
  const runInFlightRef = useRef(false)
  const mountedRef = useRef(true)

  const [definitions, setDefinitions] = useState(() => definitionsFromPayload(props.initialDefinitions))
  const [instances, setInstances] = useState(() => instancesFromPayload(props.initialInstances))
  const [activeInstance, setActiveInstance] = useState(initialInstance)
  const [tasks, setTasks] = useState(() => {
    if (Array.isArray(props.initialTasks)) return normalizeTasks(props.initialTasks)
    return normalizeTasks(initialInstance ? initialInstance.pendingTasks : [])
  })
  const [events, setEvents] = useState(() => initialEvents.slice())
  const [lastSeq, setLastSeq] = useState(() => lastSeqRef.current)
  const [eventsCaughtUp, setEventsCaughtUp] = useState(initialCaughtUp)
  const [drawerOpen, setDrawerOpen] = useState(props.initialDrawerOpen === true || Boolean(initialInstance))
  const [selectedElementId, setSelectedElementId] = useState('')
  const [submittingTasks, setSubmittingTasks] = useState(() => new Set())
  const [notice, setNotice] = useState(() => {
    if (props.initialNotice && typeof props.initialNotice === 'object') return props.initialNotice
    return null
  })
  const [draftNotice, setDraftNotice] = useState(null)
  const [meta, setMeta] = useState(() => definitionStateRef.current.state)
  const [dirty, setDirty] = useState(Boolean(props.initialDirty))
  const [name, setName] = useState(initialDefinition && typeof initialDefinition.name === 'string'
    ? initialDefinition.name
    : '')
  const [saveStatus, setSaveStatus] = useState(initialDefinition ? 'saved' : 'idle')
  const [runStatus, setRunStatus] = useState('idle')
  const [canvasStatus, setCanvasStatus] = useState('loading')
  const [viewKind, setViewKind] = useState(initialInstance ? 'instance' : 'definition')
  const [loadingDefinition, setLoadingDefinition] = useState(false)
  const [loadingInstance, setLoadingInstance] = useState(false)
  const [eventError, setEventError] = useState('')

  const templates = useMemo(() => listTemplates(), [])

  const activeInstanceId = activeInstance && typeof activeInstance.id === 'string' ? activeInstance.id : ''

  /** 同步「事件是否已追平」：ref 供异步路径读，state 驱动轮询 effect 的停/续。 */
  const markCaughtUp = useCallback(value => {
    const next = value === true
    eventsCaughtUpRef.current = next
    setEventsCaughtUp(current => (current === next ? current : next))
  }, [])

  // ── 本地 XML 草稿：去抖 + maxWait + 乱序丢弃；只写 localStorage，不建服务端版本 ──
  useEffect(() => {
    const queue = createSaveQueue({
      debounceMs: DRAFT_DEBOUNCE_MS,
      maxWaitMs: DRAFT_MAX_WAIT_MS,
      save: async snapshot => {
        const editor = editorRef.current
        if (!editor) return { skipped: true }
        // 切定义之后旧快照不能再拿新画布的 XML 落盘。
        if (snapshot.definitionId !== draftIdRef.current) return { skipped: true }
        if (snapshot.viewToken !== viewSeqRef.current) return { skipped: true }
        const xml = await editor.saveXML({ format: true })
        if (snapshot.definitionId !== draftIdRef.current || snapshot.viewToken !== viewSeqRef.current) {
          return { skipped: true }
        }
        const record = writeDraft({
          definitionId: snapshot.definitionId,
          baseVersion: snapshot.baseVersion,
          baseHash: snapshot.baseHash,
          xml,
        })
        return { record }
      },
      onFailed: (error, snapshot) => {
        if (snapshot && snapshot.definitionId === draftIdRef.current) {
          setNotice({ kind: 'warn', text: '本地草稿写入失败：' + failureMessage(error) })
        }
      },
    })
    draftQueueRef.current = queue
    return () => {
      draftQueueRef.current = null
      // 卸载前尽量把最后一版落到本地（编辑器可能已经销毁，失败静默）。
      try {
        void queue.flush()
      } catch {
        // 卸载路径不抛
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const scheduleLocalDraft = useCallback(() => {
    const queue = draftQueueRef.current
    const state = definitionStateRef.current
    if (!queue) return false
    const definitionId = state.definitionId || draftIdRef.current
    if (!definitionId) return false
    return queue.schedule({
      definitionId,
      baseVersion: state.version,
      baseHash: state.hash,
      revision: revisionRef.current.revision,
      viewToken: viewSeqRef.current,
    })
  }, [])

  const flushLocalDraft = useCallback(async () => {
    // 实例视图的画布是只读快照，绝不能把实例 XML 当成定义草稿落盘。
    if (viewRef.current.kind !== 'definition') return null
    const queue = draftQueueRef.current
    if (!queue) return null
    try {
      return await queue.flush()
    } catch {
      return null
    }
  }, [])

  /**
   * 合并一批实例事件：只追新、按 seq 去重升序，并同步游标 / 画布 marker。
   * 事件与 lastSeq 都挂在实例级 ref 上，切实例前先清空，绝不回退到上一个实例。
   *
   * `payload.lastSeq` 是 Host 的**预留游标**（先写 instance.lastSeq，再追加事件），
   * 不能拿来推进 since；已消费游标只认实际返回事件的最大 seq。
   *
   * @returns {number} 合并后的显示游标（已加载事件的最大 seq）
   */
  const applyEventBatch = useCallback(payload => {
    const merged = mergeInstanceEvents(
      eventsRef.current,
      payload && Array.isArray(payload.events) ? payload.events : [],
      { baseSeq: lastSeqRef.current },
    )
    const cursor = merged.lastSeq
    eventsRef.current = merged.events
    lastSeqRef.current = cursor
    setEvents(merged.events)
    setLastSeq(cursor)
    setEventError('')
    syncRuntimeMarkers(editorRef.current, runtimeMarkersFromEvents(merged.events))
    return cursor
  }, [])

  /**
   * 进入终态、停轮询**之前**先追平 `targetSeq`。
   *
   * 轮询顺序是先读事件、再读详情，两次请求之间实例可能已经结束：
   * 详情返回 `COMPLETED,lastSeq=4` 而事件只到 seq=2 时，直接停轮询会让最后的
   * activity/end、process/end 永远不再读取。这里循环补拉到已消费游标 >= target，
   * 并用 `TERMINAL_EVENT_CATCHUP_LIMIT` 防止单次 tick 死循环；返回 false 时调用方
   * 必须继续安排重试（不能把「暂时失败」当成「已经追平」）。
   */
  const catchUpInstanceEvents = useCallback(async (instanceId, targetSeq, generation) => {
    const target = Number.isSafeInteger(targetSeq) && targetSeq >= 0 ? targetSeq : 0
    for (let round = 0; round < TERMINAL_EVENT_CATCHUP_LIMIT && lastSeqRef.current < target; round += 1) {
      let data
      try {
        data = await client.readInstanceEvents(instanceId, nextEventsQuery(lastSeqRef.current))
      } catch (error) {
        if (generation === selectSeqRef.current && mountedRef.current) {
          setEventError('读取实例事件失败：' + failureMessage(error))
        }
        return false
      }
      // 迟到响应 / 已切走：按世代 + instanceId 丢弃。
      if (generation !== selectSeqRef.current || !mountedRef.current) return false
      if (eventsInstanceRef.current !== instanceId) return false
      const before = lastSeqRef.current
      applyEventBatch(data)
      // 游标没有推进：再拉也是同一批，交给调用方退避重试（不能静默停）。
      if (lastSeqRef.current <= before) return false
    }
    return lastSeqRef.current >= target
  }, [applyEventBatch, client])

  /** 画布变更：修订号 + dirty + 去抖草稿（拖动过程不序列化）。 */
  const handleCanvasChange = useCallback(info => {
    if (!info || info.dirty !== true) return
    if (viewRef.current.kind !== 'definition') return
    revisionRef.current.markChanged()
    definitionStateRef.current.markDirty()
    setMeta(definitionStateRef.current.state)
    setDirty(true)
    setSaveStatus(current => (current === 'saved' ? 'idle' : current))
    scheduleLocalDraft()
  }, [scheduleLocalDraft])

  /**
   * 把一次视图提交给编辑器。
   *
   * 编辑器支持原子 `applyView({ viewer, xml, token })` 时优先用它：模式切换与
   * 导入在同一队列任务里完成，并按页面视图世代（token）作废过期请求；否则退回
   * 旧的 `setViewerMode` + `importXML` 两步（测试注入的假编辑器走这条）。
   *
   * @returns {Promise<{stale: boolean}>}
   */
  const applyEditorView = useCallback(async (editor, { viewer, xml, token }) => {
    const text = typeof xml === 'string' ? xml : ''
    if (typeof editor.applyView === 'function') {
      const result = await editor.applyView({ viewer, xml: text, token })
      if (result && result.ok === false && result.stale !== true) {
        throw new Error(result.reason || '画布加载失败')
      }
      return { stale: Boolean(result && result.stale) }
    }
    if (viewer) await editor.setViewerMode(true)
    else await editor.setViewerMode(false)
    if (text.trim() !== '') await editor.importXML(text)
    return { stale: false }
  }, [])

  /** 把一份 XML / marker 应用到画布；返回是否成功。 */
  const applyCanvasView = useCallback(async (view, selection) => {
    // 选择世代已经过期：连编辑器模型都不要碰，否则过期导入会把别的实例画上去。
    if (selection !== undefined && selection !== selectSeqRef.current) {
      return { ok: false, stale: true, reason: '已被新的选择取代' }
    }
    viewRef.current = view
    setViewKind(view.kind === 'instance' ? 'instance' : 'definition')
    const editor = editorRef.current
    // 画布还没就绪：视图意图已经记下，等 handleCanvasReady 再应用；这不算失败。
    if (!editor) return { ok: false, pending: true, reason: '画布尚未加载' }
    const seq = ++viewSeqRef.current
    const viewer = view.kind === 'instance'
    const xml = typeof view.xml === 'string' ? view.xml : ''
    try {
      // 过期请求在编辑器内部就被丢弃；这里再按页面世代 / 选择世代确认一次。
      const applied = await applyEditorView(editor, { viewer, xml, token: seq })
      if (applied.stale || seq !== viewSeqRef.current
        || (selection !== undefined && selection !== selectSeqRef.current)) {
        return { ok: false, stale: true, reason: '已被新的画布请求取代' }
      }
      // 导入是异步的：期间轮询可能已经收到终态事件。实例视图必须按**当前归属的
      // 最新事件缓存**重算 marker，不能把调用时捕获的旧 markers 写回（复审 M4）。
      const markers = view.kind === 'instance' && eventsInstanceRef.current === view.instanceId
        ? runtimeMarkersFromEvents(eventsRef.current)
        : (Array.isArray(view.markers) ? view.markers : [])
      editor.setRuntimeState(markers)
      // 只有真正应用成功才更新「最后提交的视图」：过期 / 失败都不能当基线。
      committedViewRef.current = { ...view, markers }
      // 成功恢复画布：统一回到 ready（复审 F3）。否则回滚失败后的 error 态
      // 会一直禁用保存按钮，即使编辑器已经恢复可用。
      setCanvasStatus('ready')
      return { ok: true, markers }
    } catch (error) {
      // 选择世代已过期：这次失败属于旧事务，不能改画布状态、不能覆盖新事务的通知。
      if (selection !== undefined && selection !== selectSeqRef.current) {
        return { ok: false, stale: true, reason: '已被新的选择取代' }
      }
      const unavailable = editorUnavailableReason(editor)
      if (seq === viewSeqRef.current) {
        if (unavailable !== '') setCanvasStatus('error')
        setNotice({
          kind: 'error',
          text: '画布加载失败（保留原图）：' + failureMessage(error)
            + (unavailable !== '' ? `；画布不可用：${unavailable}` : ''),
        })
      }
      return { ok: false, reason: failureMessage(error), unavailable }
    }
  }, [applyEditorView])

  const handleCanvasReady = useCallback(async (chunk, editor) => {
    editorRef.current = editor
    try {
      const ready = await editor.ready
      if (ready && ready.ok === false) {
        setCanvasStatus('error')
        setNotice({ kind: 'error', text: 'BPMN 画布初始化失败：' + failureMessage(ready.error) })
        return
      }
      if (!mountedRef.current) return
      setCanvasStatus('ready')
      const view = viewRef.current
      const result = await applyCanvasView(view)
      if (!result.ok && result.reason !== '已被新的画布请求取代') {
        setCanvasStatus('error')
      }
    } catch (error) {
      setCanvasStatus('error')
      setNotice({ kind: 'error', text: 'BPMN 画布初始化失败：' + failureMessage(error) })
    }
  }, [applyCanvasView])

  const handleCanvasError = useCallback(error => {
    setCanvasStatus('error')
    setNotice({ kind: 'error', text: 'BPMN 画布加载失败：' + failureMessage(error) })
  }, [])

  const refreshDefinitions = useCallback(async () => {
    try {
      const data = await client.listDefinitions()
      if (!mountedRef.current) return []
      const rows = definitionsFromPayload(data)
      setDefinitions(rows)
      return rows
    } catch (error) {
      if (mountedRef.current) setNotice({ kind: 'error', text: '读取定义列表失败：' + failureMessage(error) })
      return []
    }
  }, [client])

  const refreshInstances = useCallback(async () => {
    try {
      const data = await client.listInstances({ limit: 50 })
      if (!mountedRef.current) return []
      const rows = instancesFromPayload(data)
      setInstances(rows)
      return rows
    } catch (error) {
      if (mountedRef.current) setNotice({ kind: 'error', text: '读取实例列表失败：' + failureMessage(error) })
      return []
    }
  }, [client])

  /** 打开定义（GET /definitions/<id>）：钉住返回的 version + hash。 */
  const openDefinition = useCallback(async (id, options = {}) => {
    if (typeof id !== 'string' || id === '') return false
    // 与实例共用同一个选择世代：这次选择让两条链上的所有在飞请求一起失效。
    const seq = beginSelection()
    setLoadingInstance(false)
    setLoadingDefinition(true)
    setNotice(null)
    setDraftNotice(null)
    try {
      const data = await client.readDefinition(id, options.version ? { version: options.version } : undefined)
      if (seq !== selectSeqRef.current || !mountedRef.current) return false
      // 响应回来到真正切画布之间，当前画布仍是旧定义：先把这期间的新改动落本地草稿。
      await flushLocalDraft()
      if (seq !== selectSeqRef.current || !mountedRef.current) return false
      const state = createDefinitionState(data)
      definitionStateRef.current = state
      draftIdRef.current = data.id
      revisionRef.current.reset()
      setMeta(state.state)
      setDirty(false)
      setSaveStatus('saved')
      setName(state.state.name)
      setLoadingDefinition(false)
      const applied = await applyCanvasView({ kind: 'definition', xml: data.xml, markers: [] }, seq)
      // 迟到的定义响应不能覆盖后选的定义 / 实例。
      if (applied.stale || seq !== selectSeqRef.current) return false
      const draft = readDraft(data.id)
      if (draft !== null && draftDiffers(draft, data.xml)) {
        setDraftNotice({ definitionId: data.id, savedAt: draft.savedAt, record: draft })
      }
      return true
    } catch (error) {
      if (seq !== selectSeqRef.current || !mountedRef.current) return false
      setLoadingDefinition(false)
      setNotice({ kind: 'error', text: `打开定义 ${id} 失败：` + failureMessage(error) })
      return false
    } finally {
      endSelection(seq)
    }
  }, [applyCanvasView, client, flushLocalDraft])

  /**
   * 打开实例：详情 + 冻结快照 + 待办 + 事件；画布切只读。
   *
   * 详情 / 任务 / 事件 / 视图是**同一事务**（复审 N1）：加载期间结果先放在本地，
   * 任何一步失败或世代过期都不改页面状态，因此不会出现「显示 B、事件却属于 A」
   * 的半提交；过期请求也不能执行末尾提交或覆盖画布。
   */
  const openInstance = useCallback(async (id, options = {}) => {
    if (typeof id !== 'string' || id === '') return false
    // 选择世代：实例加载同样让定义链上的在飞请求失效（统一计数器）。
    const seq = beginSelection()
    // 从定义编辑切到实例视图前，先把当前画布的去抖草稿落盘（实例视图不能写定义草稿）。
    if (viewRef.current.kind === 'definition') await flushLocalDraft()
    if (seq !== selectSeqRef.current || !mountedRef.current) {
      // 这个提前返回发生在 try 之外，必须显式注销在飞登记，避免永久占着「更新选择」。
      endSelection(seq)
      return false
    }
    setLoadingDefinition(false)
    setLoadingInstance(true)
    // 刷新待办后要保留 404 / 409 的服务端原因，不能被刷新动作立即清掉。
    if (options.preserveNotice !== true) setNotice(null)
    // 切换实例时事件从空集合开始；同一实例刷新才在当前事件上增量合并。
    const switched = eventsInstanceRef.current !== id
    let viewAttempted = false

    /**
     * 失败 / 过期时把画布恢复到「最近一次成功提交的视图」。
     *
     * 恢复必须属于**仍然持有选择世代的当前事务**（复审 R3）：旧请求（seq 已过期）
     * 不得借执行时的 `selectSeqRef.current` 发起恢复，否则会以新世代把正在加载的
     * 最新视图替换掉。此时新事务自己会落最终视图，旧请求只负责安静退出。
     * 不 await：编辑器队列可能还在等一个挂起的导入，等待会把加载态卡死。
     *
     * @returns {boolean} 是否真的发起了恢复（调用方可据此收口 loading）。
     */
    const restoreCommittedView = () => {
      if (!viewAttempted) return false
      if (!mountedRef.current || hasNewerSelectionInFlight(seq)) return false
      // 没有更新选择在途：可以安全地用当前世代修复画布（恢复的是最后一次成功提交的
      // 视图）。若有更新选择在途，则交给它自己落最终视图，旧请求安静退出。
      void applyCanvasView(committedViewRef.current, selectSeqRef.current)
      return true
    }

    try {
      const [detail, snapshot, tasksPayload, eventsPayload] = await Promise.all([
        client.readInstance(id),
        client.readInstanceDefinition(id).catch(error => ({ __error: error })),
        client.readInstanceTasks(id).catch(error => ({ __error: error })),
        client.readInstanceEvents(id).catch(error => ({ __error: error })),
      ])
      if (seq !== selectSeqRef.current || !mountedRef.current) {
        restoreCommittedView()
        return false
      }

      const detailTarget = detail && Number.isSafeInteger(detail.lastSeq) ? detail.lastSeq : 0
      const eventsTarget = eventsPayload && !eventsPayload.__error
        && Number.isSafeInteger(eventsPayload.lastSeq) ? eventsPayload.lastSeq : 0
      // Host 目标游标：只用于判断终态是否追平，绝不作为 since 使用。
      let targetSeq = Math.max(detailTarget, eventsTarget)
      // 事务内的事件副本：提交前绝不写 eventsRef / 状态。
      let nextEvents = switched ? [] : eventsRef.current
      let nextCursor = switched ? 0 : lastSeqRef.current
      let eventError = ''
      if (eventsPayload && !eventsPayload.__error) {
        const merged = mergeInstanceEvents(
          nextEvents,
          Array.isArray(eventsPayload.events) ? eventsPayload.events : [],
          { baseSeq: nextCursor },
        )
        nextEvents = merged.events
        // 已消费游标 = 实际事件的最大 seq；Host 的 lastSeq 可能先于事件落盘。
        nextCursor = merged.lastSeq
      } else if (eventsPayload && eventsPayload.__error) {
        // 请求失败：新实例保留空集合 + 错误提示，绝不回退到上一个实例的事件 / 游标。
        eventError = '读取实例事件失败：' + failureMessage(eventsPayload.__error)
      }

      const terminal = isTerminalStatus(detail && detail.status)
      let caughtUp = false
      if (terminal) {
        // 详情已终态但事件可能还没追平：在本地补拉，停轮询前必须到 targetSeq。
        // 补拉失败不置为「已追平」：轮询 effect 会继续退避重试（复审 M2）。
        for (let round = 0; round < TERMINAL_EVENT_CATCHUP_LIMIT && nextCursor < targetSeq; round += 1) {
          let data
          try {
            data = await client.readInstanceEvents(id, nextEventsQuery(nextCursor))
          } catch (error) {
            if (seq === selectSeqRef.current && mountedRef.current) {
              eventError = '读取实例事件失败：' + failureMessage(error)
            }
            break
          }
          if (seq !== selectSeqRef.current || !mountedRef.current) {
            restoreCommittedView()
            return false
          }
          const before = nextCursor
          const merged = mergeInstanceEvents(
            nextEvents,
            Array.isArray(data.events) ? data.events : [],
            { baseSeq: nextCursor },
          )
          nextEvents = merged.events
          nextCursor = merged.lastSeq
          // 游标没有推进：再拉也是同一批，交给轮询退避重试（不能静默停）。
          if (nextCursor <= before) break
        }
        caughtUp = nextCursor >= targetSeq
      }

      // 视图也是事务的一部分：快照失败不提交半组状态，统一停在最后一次成功提交。
      if (snapshot && snapshot.__error) {
        throw new Error('读取实例定义快照失败：' + failureMessage(snapshot.__error))
      }
      if (snapshot && typeof snapshot.xml === 'string') {
        viewAttempted = true
        const applied = await applyCanvasView({
          kind: 'instance',
          instanceId: id,
          xml: snapshot.xml,
          markers: runtimeMarkersFromEvents(nextEvents),
        }, seq)
        if (seq !== selectSeqRef.current || !mountedRef.current) {
          restoreCommittedView()
          return false
        }
        if (applied.stale) {
          // handleCanvasReady 可能在同一时刻用 viewRef.current 又提交了一次**同一视图**：
          // 此时 committedViewRef 已经是它，事务可以继续。只有视图确实被换掉才回滚。
          const committedView = committedViewRef.current
          const sameViewApplied = committedView !== null && committedView.kind === 'instance'
            && committedView.instanceId === id && committedView.xml === snapshot.xml
          if (!sameViewApplied) {
            // 过期导入可能已经把模型换成别的实例：恢复最近一次提交的视图。
            // 这是当前事务的提前返回，必须在这里结束 loading（不会走到末尾提交）。
            restoreCommittedView()
            setLoadingInstance(false)
            return false
          }
        } else if (applied.pending !== true && applied.ok !== true) {
          throw new Error(applied.reason || '画布加载失败')
        }
      }

      // 到这里所有异步步骤已完成且世代仍有效：同步提交整组状态。
      // 提交块内不再出现 await —— 过期请求不可能执行到这次提交之后。
      if (seq !== selectSeqRef.current || !mountedRef.current) return false
      // 同一实例刷新时轮询可能在加载期间又推进了事件：把事务结果并回当前缓存。
      const committed = switched
        ? { events: nextEvents, lastSeq: nextCursor }
        : mergeInstanceEvents(eventsRef.current, nextEvents, { baseSeq: lastSeqRef.current })
      if (!switched) targetSeq = Math.max(targetSeq, targetSeqRef.current)
      // 画布还没就绪（pending）时视图会在 handleCanvasReady 应用，但它已经属于
      // 这次成功提交；后续失败 / 过期必须恢复到它，而不是更早的视图。
      if (viewAttempted) committedViewRef.current = viewRef.current
      eventsInstanceRef.current = id
      eventsRef.current = committed.events
      lastSeqRef.current = committed.lastSeq
      targetSeqRef.current = targetSeq
      setEvents(committed.events)
      setLastSeq(committed.lastSeq)
      setEventError(eventError)
      markCaughtUp(terminal ? caughtUp : false)
      setActiveInstance(detail)
      setTasks(normalizeTasks(tasksPayload && !tasksPayload.__error
        ? tasksPayload
        : (detail && detail.pendingTasks)))
      setDrawerOpen(true)
      setLoadingInstance(false)
      syncRuntimeMarkers(editorRef.current, runtimeMarkersFromEvents(committed.events))
      return true
    } catch (error) {
      if (seq !== selectSeqRef.current || !mountedRef.current) return false
      // 失败即整组不提交：页面仍停在上次成功提交的状态；画布若被这次尝试改过就恢复。
      restoreCommittedView()
      setLoadingInstance(false)
      setNotice({ kind: 'error', text: `打开实例 ${id} 失败：` + failureMessage(error) })
      return false
    } finally {
      endSelection(seq)
    }
  }, [applyCanvasView, client, flushLocalDraft, markCaughtUp])

  /** 保存版本：提交属性输入 → 序列化最新 XML → POST /definitions → 钉版本。 */
  const saveDefinition = useCallback(async () => {
    if (saveInFlightRef.current) return false
    const editor = editorRef.current
    const state = definitionStateRef.current
    if (!editor) {
      setNotice({ kind: 'warn', text: 'BPMN 画布还没加载完成，稍后再保存。' })
      return false
    }
    saveInFlightRef.current = true
    setSaveStatus('saving')
    setNotice(null)
    try {
      const startedView = viewSeqRef.current
      await commitPendingProperties(editor)
      if (startedView !== viewSeqRef.current) {
        // 属性提交期间用户切走了：这次保存不成立，恢复按钮状态。
        setSaveStatus('idle')
        return false
      }
      const submittedView = viewSeqRef.current
      const submittedRevision = revisionRef.current.revision
      const xml = await editor.saveXML({ format: true })
      if (typeof xml !== 'string' || xml.trim() === '') throw new Error('画布还没有可保存的 BPMN XML')
      const id = state.definitionId || draftIdRef.current
      const definitionName = name.trim() !== '' ? name.trim() : (state.name || '未命名流程')
      const result = await client.saveDefinition({ id, name: definitionName, xml })
      if (submittedView !== viewSeqRef.current || definitionStateRef.current !== state) {
        // 保存响应晚到且用户已经切走：丢弃这次结果，绝不能把新定义的 dirty 清掉。
        setSaveStatus(current => (current === 'saving' ? 'idle' : current))
        return false
      }
      const pinned = state.pinSaved(result, {
        revision: revisionRef.current.revision,
        savedRevision: submittedRevision,
      })
      if (!pinned.pinned) {
        setSaveStatus('error')
        setNotice({ kind: 'error', text: '保存返回缺少 id / version：' + pinned.reason })
        return false
      }
      const savedId = state.definitionId
      // 保存期间用户又改了：最新 XML 属于**新定义**，要按新 id 重新落草稿，
      // 不能把旧快照（可能是临时 id）写回，也不能直接 cancel 丢掉这段改动。
      const newerRevision = revisionRef.current.revision > submittedRevision
      draftQueueRef.current?.cancel()
      if (draftIdRef.current !== savedId) {
        clearDraft(draftIdRef.current)
        draftIdRef.current = savedId
      }
      if (!newerRevision) clearDraft(savedId)
      setMeta(state.state)
      setDirty(state.dirty)
      setName(definitionName)
      setSaveStatus('saved')
      setNotice({ kind: 'success', text: `已保存 ${savedId} v${result.version}` })
      if (newerRevision) {
        scheduleLocalDraft()
        await flushLocalDraft()
      }
      await refreshDefinitions()
      return true
    } catch (error) {
      setSaveStatus('error')
      setNotice({ kind: 'error', text: '保存失败：' + failureMessage(error) })
      return false
    } finally {
      saveInFlightRef.current = false
    }
  }, [client, flushLocalDraft, name, refreshDefinitions, scheduleLocalDraft])

  /** 运行：必须已有钉住版本且没有未保存修改；201 带 error 也保留实例。 */
  const runDefinition = useCallback(async () => {
    if (runInFlightRef.current) return false
    const editor = editorRef.current
    if (editor) {
      // 属性面板里可能还有未提交的输入（contenteditable JSON 走 600ms 去抖）：
      // 先提交，再判断 dirty —— 有未保存修改时必须先保存，不能拿旧版本启动。
      const startedView = viewSeqRef.current
      await commitPendingProperties(editor)
      if (startedView !== viewSeqRef.current) return false
    }
    const state = definitionStateRef.current
    const blocked = runBlockReason(state.state)
    if (blocked !== '') {
      setNotice({ kind: 'warn', text: blocked })
      return false
    }
    const payload = state.runPayload()
    if (!payload.ok) {
      setNotice({ kind: 'warn', text: payload.reason })
      return false
    }
    runInFlightRef.current = true
    setRunStatus('starting')
    setNotice(null)
    try {
      const data = await client.createInstance(payload.body)
      if (!mountedRef.current) return false
      setRunStatus('idle')
      await refreshInstances()
      await openInstance(data.id)
      if (data.error) {
        setNotice({
          kind: 'warn',
          text: `实例 ${data.id} 已创建，但执行出错：${instanceErrorText(data.error)}。实例已保留，可直接查看/处理。`,
        })
      } else {
        setNotice({ kind: 'success', text: `实例 ${data.id} 已创建（${instanceStatusText(data.status)}）` })
      }
      return true
    } catch (error) {
      setRunStatus('idle')
      setNotice({ kind: 'error', text: '运行失败：' + failureMessage(error) })
      return false
    } finally {
      runInFlightRef.current = false
    }
  }, [client, openInstance, refreshInstances])

  const stopInstance = useCallback(async id => {
    if (typeof id !== 'string' || id === '') return false
    setLoadingInstance(true)
    try {
      await client.stopInstance(id)
      if (!mountedRef.current) return false
      await refreshInstances()
      await openInstance(id)
      setNotice({ kind: 'success', text: `实例 ${id} 已停止` })
      return true
    } catch (error) {
      setLoadingInstance(false)
      setNotice({ kind: 'error', text: '停止实例失败：' + failureMessage(error) })
      return false
    }
  }, [client, openInstance, refreshInstances])

  /** 完成人工待办：payload / decidedBy / 当前 executionId；提交期间禁用重复操作。 */
  const completeTask = useCallback(async (task, input) => {
    const key = tasksGuardRef.current.begin(task)
    if (key === null || key === '') return false
    setSubmittingTasks(current => {
      const next = new Set(current)
      next.add(key)
      return next
    })
    const instanceId = activeInstance && typeof activeInstance.id === 'string' ? activeInstance.id : ''
    try {
      const body = taskSubmitBody(task, input)
      await client.completeInstanceTask(instanceId, task.activityId, body)
      if (!mountedRef.current) return true
      // 刷新本身会清空通知，成功提示必须放在刷新之后写。
      if (instanceId !== '') await openInstance(instanceId, { preserveNotice: true })
      setNotice({ kind: 'success', text: `人工任务 ${task.activityId} 已完成` })
      await refreshInstances()
      return true
    } catch (error) {
      if (!mountedRef.current) return false
      const plan = completionFailurePlan(error && error.status, error && error.data)
      // 404 / 409 要刷新待办，但刷新动作不能把服务端原因提示清掉。
      if (plan.refresh && instanceId !== '') await openInstance(instanceId, { preserveNotice: true })
      // 最后写原因：刷新过程中的其它通知（例如快照失败）不能盖掉 404/409 原因。
      setNotice({ kind: 'error', text: plan.message })
      return false
    } finally {
      tasksGuardRef.current.end(key)
      if (mountedRef.current) {
        setSubmittingTasks(current => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      }
    }
  }, [activeInstance, client, openInstance, refreshInstances])

  /** 画布定位：只认事件的 elementId。 */
  const selectEvent = useCallback(event => {
    const elementId = event && typeof event.elementId === 'string' ? event.elementId : ''
    if (elementId === '') {
      setNotice({ kind: 'warn', text: '这条事件没有 BPMN elementId，无法在画布上定位。' })
      return false
    }
    setSelectedElementId(elementId)
    const editor = editorRef.current
    if (!editor) return false
    const found = focusBpmnElement(editor, elementId)
    if (!found) {
      setNotice({ kind: 'warn', text: `画布上找不到图元 ${elementId}（快照可能不含该元素）。` })
    }
    return found
  }, [])

  const restoreDraft = useCallback(async () => {
    const record = draftNotice && draftNotice.record
    const editor = editorRef.current
    if (!record || !editor) return false
    try {
      const seq = ++viewSeqRef.current
      const applied = await applyEditorView(editor, { viewer: false, xml: record.xml, token: seq })
      if (applied.stale || seq !== viewSeqRef.current) return false
      revisionRef.current.reset()
      revisionRef.current.markChanged()
      definitionStateRef.current.markDirty()
      setDirty(true)
      setSaveStatus('idle')
      setDraftNotice(null)
      // 恢复草稿同样是一次成功的画布提交：统一把页面恢复到 ready。
      setCanvasStatus('ready')
      setNotice({ kind: 'success', text: '已恢复本地草稿（尚未保存为服务端版本）' })
      return true
    } catch (error) {
      setNotice({ kind: 'error', text: '恢复本地草稿失败：' + failureMessage(error) })
      return false
    }
  }, [applyEditorView, draftNotice])

  const discardDraft = useCallback(() => {
    if (!draftNotice) return
    clearDraft(draftNotice.definitionId)
    setDraftNotice(null)
    setNotice({ kind: 'success', text: '已丢弃本地草稿' })
  }, [draftNotice])

  /** 新建：从最小人工模板开始，显式生成定义 id（不覆盖模板 process id）。 */
  const startNewDefinition = useCallback(async ({ definitionName, xml }) => {
    // 新建也是一次视图选择：让定义 / 实例两条链上的在飞请求一起失效。
    const selection = beginSelection()
    try {
      setLoadingDefinition(false)
      setLoadingInstance(false)
      await flushLocalDraft()
      if (selection !== selectSeqRef.current || !mountedRef.current) return false
      const state = createDefinitionState()
      state.markDirty()
      definitionStateRef.current = state
      draftIdRef.current = newDefinitionId()
      revisionRef.current.reset()
      revisionRef.current.markChanged()
      setMeta(state.state)
      setDirty(true)
      setName(definitionName)
      setSaveStatus('idle')
      setDraftNotice(null)
      setNotice(null)
      await applyCanvasView({ kind: 'definition', xml, markers: [] }, selection)
      return true
    } finally {
      endSelection(selection)
    }
  }, [applyCanvasView, flushLocalDraft])

  const handleOpenDefinition = useCallback(async (id, options) => {
    // 用户的选择动作一发生就让在飞请求失效：flushLocalDraft 是 await，
    // 不能给这一刻之前发出的实例响应留落地窗口（openDefinition 会再取新世代）。
    const selection = beginSelection()
    try {
      await flushLocalDraft()
      if (selection !== selectSeqRef.current || !mountedRef.current) return false
      return openDefinition(id, options)
    } finally {
      endSelection(selection)
    }
  }, [flushLocalDraft, openDefinition])

  const handleNewDefinition = useCallback(async () => {
    return startNewDefinition({ definitionName: '未命名流程', xml: templateXml('manual') })
  }, [startNewDefinition])

  const handleTemplate = useCallback(async templateId => {
    const template = getTemplate(templateId)
    if (template === null) return false
    return startNewDefinition({ definitionName: template.name, xml: template.xml })
  }, [startNewDefinition])

  /** 导入本地文件：失败保留原定义与错误，不用空图覆盖。 */
  const handleImport = useCallback(async file => {
    if (!file || typeof file.text !== 'function') {
      setNotice({ kind: 'error', text: '没有拿到可读的文件。' })
      return false
    }
    let text
    try {
      text = await file.text()
    } catch (error) {
      setNotice({ kind: 'error', text: '读取文件失败：' + failureMessage(error) })
      return false
    }
    const editor = editorRef.current
    if (!editor) {
      setNotice({ kind: 'warn', text: 'BPMN 画布还没加载完成，稍后再导入。' })
      return false
    }
    // 导入同样是一次视图选择：让在飞的定义 / 实例请求失效。
    const selection = beginSelection()
    try {
      setLoadingDefinition(false)
      setLoadingInstance(false)
      await flushLocalDraft()
      if (selection !== selectSeqRef.current || !mountedRef.current) return false
      const previousView = viewRef.current
      const seq = ++viewSeqRef.current
      try {
        // 导入也走原子的「模式 + XML」提交：与在飞的视图请求串行化，
        // 过期导入在触碰真实模型之前就会被丢弃（复审 F2）。
        const applied = await applyEditorView(editor, { viewer: false, xml: text, token: seq })
        if (applied.stale || seq !== viewSeqRef.current || selection !== selectSeqRef.current) return false
        const state = createDefinitionState()
        state.markDirty()
        definitionStateRef.current = state
        draftIdRef.current = newDefinitionId()
        revisionRef.current.reset()
        revisionRef.current.markChanged()
        const baseName = typeof file.name === 'string' ? file.name.replace(/\.(bpmn|xml)$/i, '') : ''
        setName(baseName || '导入的流程')
        setMeta(state.state)
        setDirty(true)
        setSaveStatus('idle')
        setDraftNotice(null)
        setNotice({ kind: 'success', text: '已导入 BPMN（尚未保存为服务端版本）' })
        viewRef.current = { kind: 'definition', xml: text, markers: [] }
        committedViewRef.current = viewRef.current
        setViewKind('definition')
        editor.setRuntimeState([])
        // 恢复失败后再次导入成功（编辑器已重建）：画布重新可用。
        if (editorUnavailableReason(editor) === '') setCanvasStatus('ready')
        return true
      } catch (error) {
        // 过期导入（复审 F6 / R3）：选择世代已经前进，视图恢复 / 画布状态 / 通知都属于
        // 旧事务，必须交给新事务落最终视图，旧导入只负责安静失败。
        if (selection !== selectSeqRef.current || !mountedRef.current) return false
        // 回滚重建失败时编辑器进入不可用态：必须显式显示原因并降级画布状态，
        // 不能继续提示“导入成功”（复审 M6）。
        const restoreReason = error && error.restoreError ? failureMessage(error.restoreError) : ''
        const unavailable = editorUnavailableReason(editor)
        if (unavailable !== '') setCanvasStatus('error')
        setNotice({
          kind: 'error',
          text: '导入失败（保留原定义）：' + failureMessage(error)
            + (restoreReason !== '' ? `；画布恢复失败：${restoreReason}` : '')
            + (unavailable !== '' ? '；画布不可用，请重新导入 BPMN 或刷新页面。' : ''),
        })
        // 画布可能已经从 viewer 切到 modeler：恢复原视图。恢复同样属于本次选择世代，
        // 过期后 applyCanvasView 会直接丢弃，不会以新世代覆盖最新视图。
        if (previousView.kind === 'instance') {
          await applyCanvasView(previousView, selection)
        }
        return false
      }
    } finally {
      endSelection(selection)
    }
  }, [applyCanvasView, applyEditorView, flushLocalDraft])

  const handleRefresh = useCallback(async () => {
    await refreshDefinitions()
    await refreshInstances()
    const id = activeInstance && typeof activeInstance.id === 'string' ? activeInstance.id : ''
    if (viewRef.current.kind === 'instance' && id !== '') await openInstance(id)
  }, [activeInstance, openInstance, refreshDefinitions, refreshInstances])

  // ── 首次挂载：拉定义 / 实例；没有初始数据时自动打开第一份定义 ──────────────
  useEffect(() => {
    if (props.initialDefinition || props.initialInstance) return undefined
    let cancelled = false
    void (async () => {
      const rows = await refreshDefinitions()
      if (cancelled) return
      await refreshInstances()
      if (cancelled) return
      if (rows.length > 0) await openDefinition(rows[0].id)
    })()
    return () => { cancelled = true }
    // 只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 实例事件增量轮询：?since=已消费游标；终态且追平后才停 ─────────────────
  useEffect(() => {
    if (viewKind !== 'instance' || activeInstanceId === '') return undefined
    // 「实例已终态」与「事件已追平」分别记录：只有两者都成立才停止轮询。
    if (isTerminalStatus(activeInstance && activeInstance.status) && eventsCaughtUp) return undefined
    let cancelled = false
    let timer = null
    let failures = 0
    const tick = async () => {
      if (cancelled) return
      // 本次 tick 开始时的选择世代：追平事件期间用户切走就不能再写状态。
      const generation = selectSeqRef.current
      const scheduleNext = () => {
        if (cancelled) return
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
        timer = setTimeout(tick, nextEventPollDelay({ failures, hidden }))
      }
      // 终态分支：只补拉事件；补拉失败必须继续退避重试，不能静默停。
      if (isTerminalStatus(activeInstance && activeInstance.status)) {
        const target = targetSeqRef.current
        const done = await catchUpInstanceEvents(activeInstanceId, target, generation)
        if (cancelled || !mountedRef.current) return
        if (generation !== selectSeqRef.current) {
          scheduleNext()
          return
        }
        if (!done) {
          failures += 1
          if (eventsInstanceRef.current === activeInstanceId) {
            setEventError(`终态事件尚未追平（已到 seq=${lastSeqRef.current}，目标 ${target}）：继续重试。`)
          }
          scheduleNext()
          return
        }
        markCaughtUp(true)
        void refreshInstances()
        return
      }
      try {
        const data = await client.readInstanceEvents(activeInstanceId, nextEventsQuery(lastSeqRef.current))
        if (cancelled || !mountedRef.current) return
        // 已切到别的实例（openInstance 已把事件缓存换成新实例）：旧实例的迟到响应绝不能落地。
        // 但仍要保留轮询节奏：新实例详情若加载失败、页面退回旧实例，下一次 tick 可以恢复。
        if (eventsInstanceRef.current !== activeInstanceId) {
          scheduleNext()
          return
        }
        applyEventBatch(data)
        failures = 0
        const detail = await client.readInstance(activeInstanceId)
        if (cancelled || !mountedRef.current) return
        if (eventsInstanceRef.current !== activeInstanceId) {
          scheduleNext()
          return
        }
        setActiveInstance(detail)
        const targetSeq = detail && Number.isSafeInteger(detail.lastSeq) ? detail.lastSeq : 0
        if (targetSeq > targetSeqRef.current) targetSeqRef.current = targetSeq
        if (Array.isArray(detail.pendingTasks)) setTasks(normalizeTasks(detail.pendingTasks))
        if (isTerminalStatus(detail.status)) {
          // 先追平目标游标再停轮询：否则最后一批 activity/end、process/end 永远读不到。
          const target = Math.max(targetSeq, lastSeqRef.current)
          targetSeqRef.current = target
          const done = await catchUpInstanceEvents(activeInstanceId, target, generation)
          if (!mountedRef.current) return
          if (generation !== selectSeqRef.current) {
            // 同一实例被重新选择（刷新）时本次追平已失效；下一轮按新世代继续。
            scheduleNext()
            return
          }
          if (!done) {
            // 一次暂时性失败不能永久丢掉收尾事件：保留轮询并按退避继续重试。
            failures += 1
            if (eventsInstanceRef.current === activeInstanceId) {
              setEventError(`终态事件尚未追平（已到 seq=${lastSeqRef.current}，目标 ${target}）：继续重试。`)
            }
            scheduleNext()
            return
          }
          markCaughtUp(true)
          void refreshInstances()
          return
        }
      } catch (error) {
        failures += 1
        if (!cancelled && mountedRef.current) {
          setEventError('读取实例事件失败：' + failureMessage(error))
        }
      }
      scheduleNext()
    }
    timer = setTimeout(tick, INSTANCE_POLL_MS)
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [activeInstanceId, activeInstance && activeInstance.status, applyEventBatch,
    catchUpInstanceEvents, client, eventsCaughtUp, markCaughtUp, refreshInstances, viewKind])

  // ── 页面隐藏 / 卸载前把最后一版草稿落盘 ──────────────────────────────────
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void flushLocalDraft()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      void flushLocalDraft()
    }
  }, [flushLocalDraft])

  const blockedReason = runBlockReason(meta)
  const canSave = canvasStatus === 'ready' && viewKind === 'definition' && !loadingDefinition && saveStatus !== 'saving'
  const canRun = canvasStatus === 'ready' && viewKind === 'definition'
    && runStatus !== 'starting'
    && blockedReason === ''
  const activeError = instanceErrorOf(activeInstance)
  const definitionVersion = meta && Number.isSafeInteger(meta.version) ? meta.version : null
  const definitionHash = meta && typeof meta.hash === 'string' ? meta.hash : ''
  const latestVersion = meta && Number.isSafeInteger(meta.latestVersion) ? meta.latestVersion : definitionVersion
  const instanceVersion = activeInstance && Number.isSafeInteger(activeInstance.definitionVersion)
    ? activeInstance.definitionVersion
    : null
  const instanceHash = activeInstance && typeof activeInstance.definitionHash === 'string'
    ? activeInstance.definitionHash
    : ''

  return h('div', {
    className: 'fs-root fs-bpmn-page',
    'data-view': viewKind,
  },
  h('style', null, CSS),
  h('header', { className: 'fs-bpmn-top' },
    h('div', { className: 'fs-bpmn-top-title' },
      h('strong', null, PAGE_TITLE),
      h('span', { className: 'fs-sub' },
        viewKind === 'instance' ? '实例只读视图' : 'BPMN 定义编辑')),
    h('div', { className: 'fs-bpmn-toolbar', role: 'toolbar', 'aria-label': '流程操作' },
      h('button', {
        type: 'button', className: 'fs-btn sm', onClick: handleNewDefinition,
        disabled: loadingDefinition || loadingInstance, 'data-action': 'new-definition',
      }, '新建'),
      h('label', { className: 'fs-btn sm fs-bpmn-import', title: '导入本地 .bpmn / .xml 文件' },
        '导入',
        h('input', {
          type: 'file',
          className: 'fs-bpmn-import-input',
          accept: '.bpmn,.xml,application/xml,text/xml',
          'aria-label': '导入 BPMN 文件',
          'data-action': 'import-definition',
          disabled: loadingDefinition || loadingInstance,
          onChange: event => {
            const input = event && event.target
            const file = input && input.files && input.files[0]
            if (file) void handleImport(file)
            if (input) {
              try { input.value = '' } catch { /* 只读控件 */ }
            }
          },
        })),
      h('select', {
        className: 'fs-bpmn-template',
        value: '',
        'aria-label': '从模板新建定义',
        'data-action': 'template-definition',
        disabled: loadingDefinition || loadingInstance,
        onChange: event => {
          const id = event && event.target ? event.target.value : ''
          if (id) void handleTemplate(id)
        },
      },
      h('option', { value: '' }, '模板'),
      ...templates.map(template => h('option', { key: template.id, value: template.id }, template.name))),
      h('span', { className: 'fs-bpmn-sep', 'aria-hidden': 'true' }),
      h('button', {
        type: 'button',
        className: 'fs-btn sm primary fs-save-version',
        onClick: saveDefinition,
        disabled: !canSave,
        title: canvasStatus !== 'ready' ? '画布加载完成后再保存' : '把当前画布保存为新版本（POST /definitions）',
        'data-action': 'save-definition',
      }, saveStatus === 'saving' ? '保存中…' : '保存版本'),
      h('button', {
        type: 'button',
        className: 'fs-btn sm fs-run-definition',
        onClick: runDefinition,
        disabled: !canRun,
        title: blockedReason !== '' ? blockedReason : '使用当前钉住版本创建实例（POST /instances）',
        'data-action': 'run-definition',
      }, runStatus === 'starting' ? '启动中…' : '运行'),
      h('button', {
        type: 'button', className: 'fs-btn sm ghost', onClick: handleRefresh,
        disabled: loadingDefinition || loadingInstance,
      }, '刷新'),
      h('span', {
        className: 'fs-bpmn-save-state',
        role: 'status',
        'aria-live': 'polite',
        'data-save-state': saveStatus,
      }, saveStateText(saveStatus, meta)))),

  notice !== null
    ? h('div', {
      className: 'fs-bpmn-notice ' + (notice.kind === 'error' ? 'error' : (notice.kind === 'warn' ? 'warn' : 'success')),
      role: notice.kind === 'error' ? 'alert' : 'status',
      'data-notice-kind': notice.kind || 'info',
    }, notice.text)
    : null,

  draftNotice !== null
    ? h('div', { className: 'fs-bpmn-notice warn', role: 'status', 'data-draft-notice': 'true' },
      h('span', null, `检测到未保存的本地草稿${draftNotice.savedAt ? `（${draftNotice.savedAt}）` : ''}。`),
      h('button', { type: 'button', className: 'fs-btn sm', onClick: restoreDraft }, '恢复草稿'),
      h('button', { type: 'button', className: 'fs-btn sm ghost', onClick: discardDraft }, '丢弃'))
    : null,

  h('div', { className: 'fs-bpmn-main' },
    h(DefinitionList, {
      definitions,
      activeId: viewKind === 'definition' ? meta.definitionId : '',
      busy: loadingDefinition || loadingInstance,
      templates,
      onOpen: handleOpenDefinition,
      onNew: handleNewDefinition,
      onImport: handleImport,
      onTemplate: handleTemplate,
      onRefresh: handleRefresh,
    }),
    h('section', { className: 'fs-bpmn-center', 'aria-label': 'BPMN 画布区' },
      h('div', { className: 'fs-bpmn-viewhead' },
        viewKind === 'instance'
          ? [
            h('span', { key: 'title', className: 'fs-view-title' }, activeInstance ? (activeInstance.id || '实例') : '实例'),
            h('span', { key: 'status',
              className: 'fs-status-chip ' + (activeInstance ? (activeInstance.status === 'COMPLETED' ? 'success' : (activeInstance.status === 'CANCELED' ? 'error' : 'business')) : 'warn'),
              'data-instance-status': activeInstance ? String(activeInstance.status || '') : '',
            }, activeInstance ? instanceStatusText(activeInstance.status) : '未选择实例'),
            instanceVersion === null
              ? null
              : h('span', { key: 'version', className: 'fs-view-meta', 'data-instance-version': String(instanceVersion) },
                `实例快照 v${instanceVersion}${instanceHash === '' ? '' : ' · ' + instanceHash.slice(0, 12)}`),
            h('span', { key: 'readonly', className: 'fs-view-badge' }, '只读'),
          ]
          : [
            h('span', { key: 'title', className: 'fs-view-title' }, meta.definitionId || (loadingDefinition ? '正在读取定义…' : '未保存的新定义')),
            h('input', {
              key: 'name',
              className: 'fs-view-name',
              type: 'text',
              value: name,
              placeholder: '定义名称',
              'aria-label': '定义名称',
              'data-definition-name': '',
              disabled: loadingDefinition || viewKind !== 'definition',
              onInput: event => setName(event.target.value),
            }),
            meta.versions && meta.versions.length > 1
              ? h('select', {
                key: 'version-select',
                className: 'fs-view-version',
                'aria-label': '定义版本',
                'data-definition-version-select': '',
                value: definitionVersion === null ? '' : String(definitionVersion),
                onChange: event => {
                  const version = Number(event && event.target ? event.target.value : 0)
                  if (Number.isSafeInteger(version) && version >= 1 && version !== definitionVersion) {
                    void handleOpenDefinition(meta.definitionId, { version })
                  }
                },
              }, meta.versions.map(row => h('option', { key: row.version, value: String(row.version) },
                `v${row.version}${row.version === latestVersion ? '（最新）' : ''}`)))
              : null,
            h('span', { key: 'version',
              className: 'fs-view-meta',
              'data-definition-version': definitionVersion === null ? '' : String(definitionVersion),
            }, definitionVersion === null ? '未保存版本' : `当前 v${definitionVersion}`),
            definitionVersion !== null && definitionHash !== ''
              ? h('span', { key: 'hash', className: 'fs-view-meta' }, `hash ${definitionHash.slice(0, 12)}`)
              : null,
            latestVersion !== null && definitionVersion !== null && latestVersion > definitionVersion
              ? h('span', { key: 'latest', className: 'fs-view-badge warn' }, `服务器已有 v${latestVersion}`)
              : null,
            dirty ? h('span', { key: 'dirty', className: 'fs-view-badge warn' }, '有未保存修改') : null,
          ]),
      h(BpmnCanvas, {
        title: viewKind === 'instance' ? '实例画布（只读）' : '定义画布',
        className: 'fs-bpmn-canvas-main',
        hostRequire: props.hostRequire,
        // 关键接线：编辑器创建时捕获这个回调，commandStack.changed 时才会通知页面
        // 递增修订号 / 标 dirty / 调度本地草稿（0.13.3 审查 BLOCKER-1）。
        mountOptions: { onChange: handleCanvasChange },
        onReady: handleCanvasReady,
        onError: handleCanvasError,
      })),
    h(InstancePanel, {
      instances,
      activeInstance,
      activeInstanceId,
      tasks,
      submittingKeys: submittingTasks,
      busy: loadingInstance,
      onSelectInstance: id => { void openInstance(id) },
      onRefresh: () => { void refreshInstances() },
      onStop: id => { void stopInstance(id) },
      onCompleteTask: (task, input) => { void completeTask(task, input) },
      // 0.13.8：工作区 / worktree 检查与清理（面板自己读 worktree，页面只给通知与列表刷新）。
      // 0.13.10：实例详情里的「消息」区（只读列表 + 发送；长正文走鉴权正文接口）。
      panelExtras: h('div', null,
        // 0.13.10 E1：运行指标（单实例 + 跨实例汇总）。都是纯读；不启动 runner。
        h(InstanceMetricsPanel, {
          client,
          instanceId: activeInstanceId,
          instanceStatus: activeInstance ? activeInstance.status : '',
          notice: (kind, text) => setNotice({ kind, text }),
        }),
        h(MetricsSummaryPanel, { client }),
        h(InstanceInboxPanel, {
          // 0.13.11 N10：切实例强制重建面板，组件内部的世代守卫再兜一层迟到响应。
          key: activeInstanceId || 'none',
          client,
          instanceId: activeInstanceId,
          instanceStatus: activeInstance ? activeInstance.status : '',
          tasks,
          notice: (kind, text) => setNotice({ kind, text }),
          onChanged: () => { void refreshInstances() },
        }),
        h(InstanceWorktreePanel, {
          client,
          instanceId: activeInstanceId,
          instanceStatus: activeInstance ? activeInstance.status : '',
          notice: (kind, text) => setNotice({ kind, text }),
          onChanged: () => { void refreshInstances() },
        })),
    })),

  h(InstanceEventDrawer, {
    open: drawerOpen,
    onToggle: () => setDrawerOpen(current => !current),
    events,
    lastSeq,
    instanceId: activeInstanceId,
    status: activeInstance ? activeInstance.status : '',
    selectedElementId,
    error: eventError,
    onSelectEvent: selectEvent,
  }),

  activeError !== '' && viewKind === 'instance'
    ? h('p', { className: 'fs-sr-only', 'data-active-instance-error': 'true' }, activeError)
    : null,
  )
}

/** 与 tasklist.errorTextOf 同口径的错误文案（避免 page ↔ tasklist 循环依赖）。 */
function instanceErrorText(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  const code = error && typeof error.code === 'string' ? error.code : ''
  const message = error && typeof error.message === 'string' ? error.message : ''
  if (code && message) return `${code}：${message}`
  return message || code || '未知错误'
}

/** 任务提交请求体（从 tasklist 重新导出，页面与测试共用同一个实现）。 */
export { taskSubmitBody }
