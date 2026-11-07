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
  EDGE_KIND, EXEC_MODE, NODE_KIND, blankEdge, blankFlow, blankNode, runBlockers, summarize, validateFlow,
} from '../model.js'
import { api, createRunsSource, runActionFailureText } from './api.js'
import { FlowCanvas } from './canvas.js'
import { IssuesDialog, PreviewDialog } from './dialogs.js'
import { clearDraft, createDraftScheduler, draftDiffers, readDraft, writeDraft } from './drafts.js'
import { FlowList, extractRunRows, hasNodeStatus, workspacePathOf } from './flowlist.js'
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

/** live.phase（06 §2）→ 中文；未知 phase 不显示，不编造。 */const PHASE_TEXT = { model: '模型调用', tool: '工具调用', spawn: '启动会话', idle: '空闲' }

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
 * 开始运行前的门禁：不建 run、不起引擎。
 *
 * 判据 = `validateFlow` 的 error **加** `runBlockers` 的开跑硬门禁。后者与 Host
 * `validateFlowForRun` 同口径（成环 / 多出边 / 打回指向非阶段节点 / 非法节点 id…）——
 * 这些在画布编辑里只是 warning（作者可能正画到一半），但引擎会 400 拒跑，
 * 所以必须在**发请求之前**拦住（B2）。重复的条目按 message 去重。
 *
 * 返回 target 给调用方打开问题列表 + 定位第一条错误。
 */
export function runPreflight(flow) {
  const issues = validateFlow(flow)
  const seen = new Set(issues.errors.map(item => item.message))
  const extra = runBlockers(flow).filter(item => {
    if (seen.has(item.message)) return false
    seen.add(item.message)
    return true
  })
  const errors = [...issues.errors, ...extra]
  const merged = { ...issues, ok: errors.length === 0, errors }
  if (errors.length === 0) {
    return { ok: true, issues: merged, target: null, message: '' }
  }
  const target = firstErrorTarget(merged)
  const message = '流程校验未通过：' + errors.length + ' 个错误，已取消开始。'
    + (target ? '已定位到第 1 个错误，可在问题列表逐条修复。' : '请在问题列表里逐条修复。')
  return { ok: false, issues: merged, target, message }
}

/**
 * F2：工作区是**运行的必要参数**——画布上点「开始运行」必须把选中的工作区一起发出去。
 * Host 的 `POST /runs` / `POST /runs/<id>/start` 都接受 `{workspace}`；引擎会拒绝没有
 * workspace 的启动（不再回落 `process.cwd()`），所以前端在这里就把空值拦下。
 */
export const WORKSPACE_STORAGE_KEY = 'dsh-flow-studio.workspace'

/** 工作区路径归一化：非字符串 / 空白一律视为「未选择」。 */
export function normalizeWorkspace(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 绝对路径判断（POSIX / Windows 两种写法都认；真正的合法性由 Host 再校验）。 */
export function isAbsoluteWorkspace(value) {
  const path = normalizeWorkspace(value)
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * 工作区门禁：返回可读中文原因（空串 = 通过）。文案必须说明「未选择工作区，无法启动」，
 * 并且明确不会退回默认目录 —— 用户点了没反应 / 静默换目录都不可接受。
 */
export function workspaceBlockReason(workspace) {
  if (normalizeWorkspace(workspace) === '') {
    return '未选择工作区，无法启动：请先在顶栏填写工作区绝对路径（不会退回到默认目录）。'
  }
  if (!isAbsoluteWorkspace(workspace)) {
    return '工作区必须是绝对路径（例如 /home/me/repo 或 C:\\repo），无法启动。'
  }
  return ''
}

/** 从 localStorage 恢复上次选择的工作区（SSR / 隐私模式下退回空串）。 */
export function readStoredWorkspace(storage) {
  try {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null)
    const stored = store && typeof store.getItem === 'function' ? store.getItem(WORKSPACE_STORAGE_KEY) : ''
    return typeof stored === 'string' ? normalizeWorkspace(stored) : ''
  } catch {
    return ''
  }
}

/** 记住工作区选择；清空时删除键，避免下次又悄悄带出一个旧目录。 */
export function writeStoredWorkspace(storage, value) {
  const path = normalizeWorkspace(value)
  try {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null)
    if (!store) return false
    if (path === '') {
      if (typeof store.removeItem === 'function') store.removeItem(WORKSPACE_STORAGE_KEY)
      return true
    }
    if (typeof store.setItem !== 'function') return false
    store.setItem(WORKSPACE_STORAGE_KEY, path)
    return true
  } catch {
    return false
  }
}

/**
 * `POST /runs` 的请求体：workspace 必填。没有工作区时返回 null，**调用方必须在此之前
 * 拦住启动**（绝不构造一个不带 workspace 的建 run 请求）。
 */
export function createRunBodyFor(flow, name, workspace) {
  const path = normalizeWorkspace(workspace)
  if (!isObject(flow) || typeof flow.id !== 'string' || flow.id === '' || path === '') return null
  return {
    flowId: flow.id,
    name: typeof name === 'string' && name !== '' ? name : flow.name,
    workspace: path,
  }
}

/**
 * `POST /runs/<id>/start` 的请求体：同样显式带 workspace。
 * 新建 run 时 Host 已经记下 workspace，但**复用旧 pending run** 的路径也必须显式带上，
 * 否则引擎会退回建 run 时记下的（可能为空的）参数。
 */
export function startRunBodyFor(workspace) {
  const path = normalizeWorkspace(workspace)
  return path === '' ? null : { workspace: path }
}

/**
 * F2：一次「发起运行」的完整请求序列（建 run → start）。抽成独立异步函数，是为了让
 * SSR 测试能用 spy 断言真实载荷：未选工作区时**一次请求都不发**；两次请求的 body 都含
 * 真实的 `workspace` 字段（不是「有传参」这种弱口径）。
 *
 * 复用 pending run 时也只认 workspace 与本次选择一致的那条——否则 start 会退回建 run
 * 时记下的旧参数（引擎会 400，或者跑到错误的目录里）。
 *
 * @param {{ api: object, flow: object, workspace: string, runName?: string, runs?: Array<object> }} input
 * @returns {Promise<{ ok: boolean, error: (Error|string|null), run: object|null,
 *   createdRun: object|null, started: object|null }>}
 */
export async function startRunRequest({ api, flow, workspace, runName = '', runs = [] } = {}) {
  const reason = workspaceBlockReason(workspace)
  if (reason !== '') return { ok: false, error: reason, run: null, createdRun: null, started: null }
  const path = normalizeWorkspace(workspace)
  // 选中即记住：下次打开页面默认就是这份工作区（清空才删除）。
  writeStoredWorkspace(undefined, path)
  const known = Array.isArray(runs) ? runs : []
  const pending = known.find(item => item && flow && item.flowId === flow.id && runIsPending(item)
    && workspacePathOf(item) === path)
  let run = pending || null
  let createdRun = null
  if (!run) {
    const body = createRunBodyFor(flow, runName, path)
    if (!body) return { ok: false, error: workspaceBlockReason(path), run: null, createdRun: null, started: null }
    try {
      const created = await api.createRun(body)
      run = created && created.run ? created.run : null
      if (run) createdRun = run
    } catch (error) {
      return { ok: false, error, run: null, createdRun: null, started: null }
    }
  }
  if (!run || typeof run.id !== 'string' || run.id === '') {
    return { ok: false, error: new Error('Host 没有返回 run'), run: null, createdRun, started: null }
  }
  const startBody = startRunBodyFor(path)
  if (!startBody) return { ok: false, error: workspaceBlockReason(path), run, createdRun, started: null }
  try {
    const started = await api.startRun(run.id, startBody)
    return { ok: true, error: null, run, createdRun, started }
  } catch (error) {
    return { ok: false, error, run, createdRun, started: null }
  }
}

/**
 * 保存请求体（0.4.2 乐观锁）：默认带上当前 `version`，让 Host 做冲突检测；
 * `force` 只在用户明确选择「用我的版本覆盖」时使用——剥掉 version 走无条件写入。
 */
export function saveBodyFor(flow, options = {}) {
  const body = flow && typeof flow === 'object' ? { ...flow } : {}
  if (options.force) delete body.version
  return body
}

/**
 * 保存前的形状闸门（0.9.1 实证事故的硬防线）。
 *
 * `PUT /flows/<id>` 是**整份替换**语义：请求体里没有 `nodes` / `edges`（或它们不是数组），
 * 服务器就会把这份流程写成空图 —— 一次「把列表摘要当流程传进来」就能静默清空用户的流程。
 * 这里在发请求之前就拦住：宁可报错让人重试，不许把服务器上的流程覆盖成空。
 *
 * 注意：`nodes: []` / `edges: []` 是**合法**的（用户确实可以删光节点），所以只查类型不查长度。
 *
 * @returns {{ ok: boolean, body?: object, reason?: string }}
 */
export function flowSavePayload(flow, options = {}) {
  if (!flow || typeof flow !== 'object') return { ok: false, reason: '没有要保存的流程' }
  if (!Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    return { ok: false, reason: '这份流程缺少 nodes / edges（可能是列表摘要或损坏的草稿）' }
  }
  return { ok: true, body: saveBodyFor(flow, options) }
}

/**
 * 空图写入防线的判定（0.9.1 实证事故）。
 *
 * `nodes: []` 本身是合法状态 —— 用户确实可以删光节点再保存。所以只在**三条同时成立**时拦：
 *   1. 要保存的是空图；
 *   2. 打开这份流程时服务器上有节点（`guard.nodes > 0`）；
 *   3. 这次会话没有任何结构编辑（`guard.edited === false`，只有增删节点/边才会置位）。
 * 三条同时成立只可能是「图上的东西在客户端丢了」，不是用户的意图。
 *
 * @param {object|null} flow 要保存的流程
 * @param {{ nodes?: number, edited?: boolean }|null} guard 打开时的节点数与本次会话是否编辑过结构
 * @returns {string} 拦截原因（空串 = 允许保存）
 */
export function emptyGraphBlockReason(flow, guard) {
  if (!flow || !Array.isArray(flow.nodes) || flow.nodes.length > 0) return ''
  if (!guard || !(guard.nodes > 0) || guard.edited === true) return ''
  return '服务器上这份流程有 ' + guard.nodes + ' 个节点，而当前要保存的是空图，'
    + '并且这次会话没有删过节点。已取消写入（否则会把流程清空）；重新打开该流程或刷新页面即可恢复。'
}

/**
 * 保存成功后合并服务器回传的元数据（版本 / 更新时间）。
 *
 * 只并这两个字段、不动内容：保存期间用户可能又改了东西，用服务器快照整体覆盖
 * 会把那些改动吞掉。不并版本则下一次保存必然带旧版本号 → 永远 409。
 */
export function mergeSavedFlow(flow, saved) {
  if (!flow || !saved || typeof saved !== 'object' || saved.id !== flow.id) return flow
  const next = { ...flow }
  if (typeof saved.version === 'number') next.version = saved.version
  if (typeof saved.updatedAt === 'string' && saved.updatedAt !== '') next.updatedAt = saved.updatedAt
  return next
}

/**
 * 保存成功后的保存态（0.9.1：修复「停在 saving 导致自动保存永久停摆」）。
 *
 * 自动保存 effect 的前置条件是 `saveState === 'dirty'`。如果保存期间用户又改过
 * （editVersion 变了），成功分支必须回到 `dirty` 让下一轮自动保存排上；沿用旧的
 * `current` 会一直停在 `saving`，自动保存就再也不会触发。
 *
 * @param {number} savedEditVersion 发这次请求时的 editVersion
 * @param {number} currentEditVersion 响应回来时的 editVersion
 * @returns {'saved'|'dirty'}
 */
export function saveStateAfterSuccess(savedEditVersion, currentEditVersion) {
  return savedEditVersion === currentEditVersion ? 'saved' : 'dirty'
}

/**
 * 保存串行化（0.9.1：修复「插件自己撞自己 409」）。
 *
 * `PUT /flows/<id>` 是整份替换 + 乐观锁。第一次响应回来之前 `mergeSavedFlow` 还没把
 * 新 version 写回本地，而自动保存去抖窗只有 700ms —— 只要一次 PUT 慢于这个窗口，
 * 用户继续编辑就会带着旧 version 再发一次，Host 只能判成 409，可实际根本没有第三方。
 * 更糟的是点「运行」前的 flushBeforeLeave 也会撞上，POST /runs 直接发不出去。
 *
 * 队列保证「同一时刻最多一个 PUT 在飞」，并且**出队时才决定版本号**：排队期间前一次
 * 保存可能已经回写了新版本，用它覆盖快照里的 version，第二次请求才不会再撞。
 *
 * `save(snapshot, options)` 是真正发请求的函数（组件里包一层 `api.saveFlow`），返回
 * 形状同 Host：`{ flow: { id, version, ... } }`。失败直接 throw 即可：调用方拿到的
 * run 会 reject，但链尾吞掉结果继续放行后面的保存，一次失败不会把整条链卡死。
 *
 * @param {{ save?: (snapshot: object, options?: object) => Promise<any> }} [options]
 * @returns {{ save: (snapshot: object, options?: object) => Promise<any>, pending: () => number }}
 */
export function createSaveQueue({ save } = {}) {
  /** 每份流程最近一次保存成功后服务器给的版本；按 id 记，切流程时不串号。 */
  const versions = new Map()
  let chain = Promise.resolve()
  let pending = 0
  const enqueue = (snapshot, options = {}) => {
    if (typeof save !== 'function') return Promise.reject(new Error('保存队列缺少 save 实现'))
    if (!isObject(snapshot) || typeof snapshot.id !== 'string' || snapshot.id === '') {
      return Promise.reject(new Error('没有要保存的流程'))
    }
    const id = snapshot.id
    pending += 1
    const run = chain.then(async () => {
      try {
        // 关键：出队时才取版本。入队时带的可能还是前一次响应回来之前的旧值。
        const version = versions.has(id) ? versions.get(id) : snapshot.version
        const request = version === snapshot.version ? snapshot : { ...snapshot, version }
        const result = await save(request, options)
        const saved = result && isObject(result.flow) ? result.flow : null
        if (saved && saved.id === id && typeof saved.version === 'number') versions.set(id, saved.version)
        return result
      } finally {
        pending -= 1
      }
    })
    // 链尾只吞结果、不吞异常：调用方手上的 run 仍然会 reject，后面的保存照常排队。
    chain = run.then(() => {}, () => {})
    return run
  }
  return { save: enqueue, pending: () => pending }
}

/**
 * 冲突处置的落点判定（0.9.1：冲突状态必须按 flowId 隔离）。
 *
 * 409 横幅可能停在界面上，而用户已经切到另一份流程；这时若按「当前打开的流程」
 * 去发无条件写，就会把**另一份流程**上别人刚写的版本静默回退成自己手里的旧内容。
 * 所以「用我的版本覆盖」只允许打到冲突发生时的快照，且当前打开的必须仍是同一份流程。
 *
 * @param {{ flowId?: string, snapshot?: object }|null} conflict
 * @param {object|null} currentFlow
 * @returns {{ ok: boolean, flow: object|null, reason: string }}
 */
export function conflictTarget(conflict, currentFlow) {
  const snapshot = isObject(conflict) && isObject(conflict.snapshot) ? conflict.snapshot : null
  if (!snapshot || typeof snapshot.id !== 'string' || snapshot.id === '') {
    return { ok: false, flow: null, reason: '没有冲突发生时的流程快照，已放弃这次覆盖' }
  }
  const currentId = currentFlow && typeof currentFlow.id === 'string' ? currentFlow.id : ''
  if (currentId === '' || currentId !== conflict.flowId || currentId !== snapshot.id) {
    return { ok: false, flow: null, reason: '冲突属于另一份流程，已放弃这次覆盖' }
  }
  return { ok: true, flow: snapshot, reason: '' }
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
 * G5-b：删除流程的安全序列（可单测）。
 *
 * 顺序是硬性的：**先拿完整快照 → 先落草稿 → 再 DELETE → 服务器成功后才清草稿**。
 *  - 拿不到快照就不删（没有备份的删除等于单点毁灭）；
 *  - DELETE 失败时草稿原样保留，`backup` 也在返回值里，调用方可重试或保留撤销入口；
 *  - DELETE 成功才调用 `drafts.clear`。
 *
 * @param {{ api: object, id: string, snapshot?: object|null,
 *   drafts?: { write?: (flow: object) => void, clear?: (id: string) => void }|null }} input
 */
export async function deleteFlowRequest({ api: apiClient, id, snapshot = null, drafts = null } = {}) {
  if (!isObject(apiClient) || typeof apiClient.deleteFlow !== 'function') {
    return { ok: false, error: new Error('缺少删除接口'), backup: null, draftKept: false, stage: 'api' }
  }
  let backup = isObject(snapshot) && snapshot.id === id ? snapshot : null
  if (!backup) {
    try {
      const result = await apiClient.readFlow(id)
      backup = result && isObject(result.flow) ? result.flow : null
    } catch (error) {
      return { ok: false, error, backup: null, draftKept: false, stage: 'snapshot' }
    }
  }
  if (!backup) {
    return { ok: false, error: new Error('拿不到流程快照，已取消删除'), backup: null, draftKept: false, stage: 'snapshot' }
  }
  if (drafts && typeof drafts.write === 'function') {
    try {
      drafts.write(backup)
    } catch {
      // 草稿写失败不阻塞删除，但内存快照仍然在，撤销入口还能用。
    }
  }
  try {
    await apiClient.deleteFlow(id)
  } catch (error) {
    return { ok: false, error, backup, draftKept: true, stage: 'delete' }
  }
  if (drafts && typeof drafts.clear === 'function') {
    try {
      drafts.clear(id)
    } catch {
      // 清理失败不影响「服务器已经删掉」这个事实。
    }
  }
  return { ok: true, error: null, backup, draftKept: false, stage: 'done' }
}

/**
 * G5-b：撤销删除——把内存快照按原 id 写回（Host 的 PUT /flows/<id> 是 upsert，
 * 磁盘上没有该文件就按 version=1 新建，所以 id 不会变）。
 */
export async function restoreFlowRequest({ api: apiClient, backup } = {}) {
  if (!isObject(apiClient) || typeof apiClient.saveFlow !== 'function') {
    return { ok: false, error: new Error('缺少保存接口'), flow: null }
  }
  if (!isObject(backup) || typeof backup.id !== 'string' || backup.id === '') {
    return { ok: false, error: new Error('没有可撤销的流程快照'), flow: null }
  }
  try {
    const result = await apiClient.saveFlow(backup.id, { ...backup })
    return { ok: true, error: null, flow: result && result.flow ? result.flow : null }
  } catch (error) {
    return { ok: false, error, flow: null }
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
 * - 停止只看 run 本身：只要当前流程对应的 run 在跑，即使流程已被删掉（flow 为空）
 *   也要能停，否则这个 run 在 UI 上就失去唯一入口；
 * - 首次运行列表没回来前禁用「运行」并写清 title（m7）；
 * - F2：没有选工作区时禁用「运行」并在 title 里写明原因（不允许发一个不带 workspace 的运行）。
 */
export function runControlState(run, {
  busy = false, armed = false, hasFlow = false, listReady = true, confirmReady = false, hasWorkspace = true,
} = {}) {
  const running = runIsActive(run)
  const confirming = armed && running
  // F2：两个禁用原因可以同时成立（首次列表未回 + 未选工作区），title 必须把两条都写出来，
  // 否则用户只看到一半原因。
  const workspaceTitle = hasWorkspace ? '' : '未选择工作区，无法启动：先填写工作区绝对路径'
  const listTitle = listReady ? '' : '正在读取运行记录；确认当前没有运行中的 run 后再开始'
  return {
    running,
    confirming,
    startLabel: busy && !running ? '启动中…' : running ? '运行中' : '运行',
    stopLabel: busy && running ? '停止中…' : '停止',
    confirmLabel: '确认停止',
    startDisabled: !hasFlow || busy || running || !listReady || !hasWorkspace,
    // M6：确认态下主按钮锁死，防止「第一击 arm、第二击 stop」被双击击穿。
    // 停止只看「当前流程的 run 在不在跑」：流程被删掉之后 flow 为 null，但那个 run
    // 还在跑 —— 抽屉里没有第二个停止入口，这里再禁掉就再也停不掉了。
    stopDisabled: !run || !running || busy || confirming,
    confirmDisabled: !confirming || busy || !confirmReady,
    startTitle: workspaceTitle !== '' && listTitle !== ''
      ? `${workspaceTitle}（${listTitle}）`
      : workspaceTitle || listTitle || (running
        ? '当前 run 正在运行；要重新开始请先停止'
        : hasFlow ? '保存当前流程并开始一次新的运行' : '先打开或新建一条流程'),
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
 * @param {object} [props.initialDraftNotice] 预置草稿横幅（SSR / 测试用；形状同内部
 *   `draftNotice`：`{flowId, record: {savedAt, flow}}`），SSR 不跑 effect 也能验横幅状态。
 * @param {boolean} [props.initialLogOpen] 抽屉初始是否展开。
 * @param {string} [props.initialWorkspace] 预置工作区绝对路径（SSR / 测试用）；省略则读 localStorage。
 */
export function FlowStudioPage({
  initialFlow = null,
  initialSkills = [],
  initialRunView = null,
  initialDraftNotice = null,
  initialLogOpen = false,
  initialError = '',
  initialWorkspace = '',
} = {}) {
  const { useState, useEffect, useRef, useCallback, useMemo } = rt.React

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
  const [draftNotice, setDraftNotice] = useState(initialDraftNotice)
  /** 0.4.2：保存撞上别人的改动（409）时挂起，等用户选「覆盖」还是「载入服务器版本」。 */
  const [conflict, setConflict] = useState(null)
  const [logOpen, setLogOpen] = useState(Boolean(initialLogOpen))
  /** 抽屉回传的实时运行快照：顶栏、画布节点状态、停止按钮都从这里取数。 */
  const [runView, setRunView] = useState(initialRunView)
  const [runBusy, setRunBusy] = useState(false)
  const [stopArmed, setStopArmed] = useState(false)
  const [stopConfirmReady, setStopConfirmReady] = useState(false)
  const [logFocus, setLogFocus] = useState(null)
  const [logSync, setLogSync] = useState(0)
  /**
   * v0.7 §4.3：运行列表要按工作区分组，需要 raw run 行（workspace* / worktree* / supervision）。
   * 抽屉回传的 runs 经 logdrawer 归一化会丢掉这些新字段，所以这里单独读 `GET /runs`；
   * 读取失败时保留上一份数据（含 initialRunView 的旧数据），整列退化为「未标注工作区」。
   */
  const [runRows, setRunRows] = useState(() => (
    initialRunView && Array.isArray(initialRunView.runs) ? initialRunView.runs : []
  ))
  const [runRowsLoaded, setRunRowsLoaded] = useState(() => Boolean(
    initialRunView && Array.isArray(initialRunView.runs),
  ))
  /**
   * G5-d：左栏与抽屉共用同一个 runs 数据源（一份轮询结果 + 一个 tick）。
   * 空闲也按 15s 轮询（降频而不是停），切前台 / 重新打开面板立即刷新一次。
   */
  const runsSource = useMemo(() => createRunsSource({ read: () => api.listRuns(20) }), [])
  /** G5-b：删除成功后保留的内存快照，供「撤销」原 id 写回。 */
  const [deletedFlow, setDeletedFlow] = useState(null)
  /** G5-b：删除失败时保留的快照（下次重试复用，不用重新读盘）。 */
  const deleteSnapshots = useRef(new Map())
  /**
   * v0.8 §11.4：节点状态行要显示节点标题，标题只在 `GET /runs/<id>` 的 `nodes` 里
   *（列表行没有）。只对确实上报过 nodeStatus 的 run 拉一次；拉不到就退回显示 nodeId。
   */
  const [runNodesById, setRunNodesById] = useState({})
  const runNodesFetched = useRef(new Set())
  /**
   * F2：这次运行落在哪个工作区。必须是用户显式选择（或上次记住的一份）绝对路径；
   * 空值 = 未选择 → 不允许发起运行（见 workspaceBlockReason / beginRun）。
   */
  const [workspace, setWorkspace] = useState(() => {
    const preset = normalizeWorkspace(initialWorkspace)
    return preset !== '' ? preset : readStoredWorkspace()
  })
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace

  const pinned = useRef(Boolean(initialFlow))
  const flowRef = useRef(null)
  flowRef.current = flow
  const selectionRef = useRef(null)
  selectionRef.current = selection
  const canvasApi = useRef(null)
  const editVersion = useRef(0)
  const savedVersion = useRef(0)
  const draftChecked = useRef('')
  /**
   * 空图写入防线（0.9.1 实证事故）：`nodes: []` 本身是合法状态（用户可能删光节点），
   * 但「服务器上有节点、这次会话又没删过节点、却要保存一份空图」只可能是图上东西丢了。
   * 记录打开时的节点数 + 这次会话有没有做过结构编辑，保存前据此拦一道。
   */
  const graphGuard = useRef({ nodes: 0, edited: false })
  /** 结构编辑（增删节点/增减边/恢复草稿）——只有这些操作能把图变空。 */
  const markGraphEdited = useCallback(() => {
    graphGuard.current.edited = true
  }, [])
  /**
   * 把「从服务器读回来的那份 flow」装进界面，并重算空图防线基线。
   *
   * 基线只能跟着服务器的现状走：同一份流程被别处清空后，本端重新读到的是空图（id 没变，
   * 只按 id 触发的那条 effect 不会重算），基线若还停在旧的 8，之后任何非结构编辑
   *（例如改流程名）都会被 emptyGraphBlockReason 拦下，而且提示「重新打开该流程即可恢复」
   * 也是错的 —— 重新打开并不会重算基线。草稿 / 编辑路径绝不能走这里：它们不是服务器的
   * 现状，重置基线会放过真正的「图上东西丢了」。
   */
  const applyServerFlow = useCallback(next => {
    setFlow(next)
    setIssues(next ? validateFlow(next) : { ok: true, errors: [], warnings: [] })
    graphGuard.current = { nodes: next && Array.isArray(next.nodes) ? next.nodes.length : 0, edited: false }
    return next
  }, [])
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

  /** F2：工作区选择变化立刻落 storage；清空即删除，避免下次悄悄带出旧目录。 */
  const updateWorkspace = useCallback(value => {
    setWorkspace(value)
    writeStoredWorkspace(undefined, value)
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
  }, [markGraphEdited, refuseWhenLocked, touch])

  const patchEdge = useCallback((id, patch) => {
    if (refuseWhenLocked()) return
    touch()
    setFlow(previous => (previous
      ? { ...previous, edges: previous.edges.map(edge => (edge.id === id ? { ...edge, ...patch } : edge)) }
      : previous))
  }, [markGraphEdited, refuseWhenLocked, touch])

  /**
   * 拖拽结束后的位置提交（缺陷 7）：画布只在 onNodeDragStop 调一次，
   * 引用稳定，避免每次页面渲染都换 props。
   */
  const moveNode = useCallback((id, x, y) => {
    patchNode(id, { x, y })
  }, [patchNode])

  /** 把当前快照落到本地草稿（浏览器不可用时退化为内存）。 */
  const persistDraft = useCallback(snapshot => {
    if (!snapshot || !snapshot.id) return null
    try {
      return writeDraft(snapshot, { baseSavedAt: snapshot.updatedAt || '' })
    } catch {
      return null
    }
  }, [])

  /**
   * 草稿写盘调度（缺陷 8）：连续输入只在去抖窗（600ms）后写一次，
   * 连续不停手也有 2s 上限；切页 / 页面隐藏 / 卸载由下面的 effect 立即 flush。
   */
  const draftScheduler = useMemo(() => createDraftScheduler({ write: persistDraft }), [persistDraft])

  /**
   * 保存队列（0.9.1）：同一时刻最多一个 PUT 在飞，后续保存排队等在飞请求完成后再发。
   * 请求体在出队时才生成，所以排队期间前一次保存回写的新 version 会被带上，
   * 不会再出现「自己撞自己」的假 409。队列是组件级单例（切换流程也复用同一份版本表）。
   */
  const saveQueue = useMemo(() => createSaveQueue({
    save: (snapshot, options) => {
      // 入队前已经过形状闸门，这里再取一次 body 只是为了把（可能被队列刷新过的）version 带上。
      const payload = flowSavePayload(snapshot, options)
      return api.saveFlow(snapshot.id, payload.body)
    },
  }), [])

  /**
   * 保存当前流程（0.4.2 乐观锁）。
   *
   * 请求体照常带 `version`；成功后把服务器回传的新 version 收回本地，
   * 否则下一次保存必然重复带旧版本号而永远 409。`force` 只在用户明确选择
   * 「用我的版本覆盖」时使用：剥掉 version，走 Host 的无条件写入分支。
   */
  const saveNow = useCallback(async (target, options = {}) => {
    const snapshot = target || flowRef.current
    if (!snapshot || !snapshot.id) return false
    // 形状闸门：整份替换语义下，缺 nodes/edges 的请求体会把服务器上的流程清空。
    const payload = flowSavePayload(snapshot, options)
    if (!payload.ok) {
      setSaveState('error')
      setError('保存被拦下：' + payload.reason + '，未写入，服务器上的流程保持原样。')
      return false
    }
    // 空图防线：服务器上有节点、这次会话没删过节点，却要写入空图 —— 停手。
    const blockReason = emptyGraphBlockReason(snapshot, graphGuard.current)
    if (blockReason !== '') {
      setSaveState('error')
      setError('保存被拦下：' + blockReason)
      return false
    }
    const version = editVersion.current
    setSaveState('saving')
    try {
      // 串行队列：上一次 PUT 还没回来时，这次会排在它后面；出队时会用上一次回写的
      // 新 version 覆盖快照里的旧值，所以不会拿旧版本撞出一个假的 409。
      const result = await saveQueue.save(snapshot, options)
      const summary = summarize(result.flow)
      setFlows(previous => previous.map(item => (item.id === summary.id ? summary : item)))
      setFlow(previous => mergeSavedFlow(previous, result.flow))
      setConflict(null)
      savedVersion.current = version
      // 保存期间又编辑过：必须回到 dirty 让自动保存重新排上；停在 saving 会让
      // 前置条件 `saveState === 'dirty'` 永远不成立，自动保存就此永久停摆。
      setSaveState(saveStateAfterSuccess(version, editVersion.current))
      // 写成功后以「服务器的现状」重新计基线：这次如果真的是用户删光了节点，也算数。
      graphGuard.current = { nodes: snapshot.nodes.length, edited: false }
      setError('')
      clearDraft(snapshot.id)
      // 没有更新改动时才取消待写草稿；保存期间又敲的字不能被取消掉。
      if (editVersion.current === version) draftScheduler.cancel(snapshot.id)
      setDraftNotice(current => (current && current.flowId === snapshot.id ? null : current))
      return true
    } catch (failure) {
      // 保存失败必须立即落草稿（不等去抖）：这是用户唯一的副本。
      draftScheduler.cancel(snapshot.id)
      persistDraft(snapshot)
      setSaveState('error')
      // 409 = 别人先改了这份流程：不是网络故障，必须给出「覆盖 / 载入服务器版本」两条路。
      if (failure && failure.status === 409) {
        const currentVersion = failure.data && typeof failure.data.currentVersion === 'number'
          ? failure.data.currentVersion
          : null
        setConflict({
          flowId: snapshot.id,
          // 存下当时要写的那份快照：「用我的版本覆盖」只对这份生效，
          // 绝不能退化成「覆盖当前打开的流程」（那会打到别人的改动上）。
          snapshot,
          currentVersion,
          updatedAt: failure.data && failure.data.updatedAt ? failure.data.updatedAt : '',
        })
        setError('保存失败：这份流程已被其他人改过'
          + (currentVersion === null ? '' : `（服务器版本 v${currentVersion}）`)
          + '。你的改动已存为本地草稿；选择「用我的版本覆盖」或「载入服务器版本」。')
        return false
      }
      setError('保存失败：' + (failure && failure.message ? failure.message : '未知原因')
        + '。改动已存为本地草稿，重试或重新打开该流程可恢复。')
      return false
    }
  }, [draftScheduler, persistDraft, saveQueue])

  /** 冲突处置一：用户确认用本地版本覆盖服务器（只针对冲突发生时的快照）。 */
  const overwriteConflict = useCallback(async () => {
    const target = conflictTarget(conflict, flowRef.current)
    setConflict(null)
    if (!target.ok) {
      // 用户已经切到别的流程：绝不能拿当前流程去发无条件写 —— 那会把别人刚写的新版本
      // 静默回退成自己手里的旧内容。提示后放弃这次覆盖，冲突横幅也一并清掉。
      setError(target.reason)
      setAnnounce(target.reason)
      return
    }
    const ok = await saveNow(target.flow, { force: true })
    setAnnounce(ok ? '已用你的版本覆盖服务器上的改动' : '覆盖失败，改动仍在本地草稿里')
  }, [conflict, saveNow])

  /** 冲突处置二：放弃本地改动，载入服务器上的最新版本。 */
  const reloadServerFlow = useCallback(async () => {
    const target = conflict && conflict.flowId
    if (!target) return
    setBusy(true)
    try {
      const result = await api.readFlow(target)
      draftChecked.current = ''
      // 服务器读回来的 flow 统一走 applyServerFlow：空图防线基线跟着服务器的现状重算。
      applyServerFlow(result.flow)
      setSelection(null)
      setConflict(null)
      savedVersion.current = editVersion.current
      setSaveState('idle')
      setError('')
      clearDraft(target)
      setAnnounce('已载入服务器上的最新版本，本地草稿已丢弃')
    } catch (failure) {
      setError('载入服务器版本失败：' + (failure && failure.message ? failure.message : '未知原因'))
    } finally {
      setBusy(false)
    }
  }, [applyServerFlow, conflict])

  /** 离开当前流程前：先把改动落草稿，再尝试保存；失败也绝不静默丢弃。 */
  const flushBeforeLeave = useCallback(async () => {
    const current = flowRef.current
    if (!current || !(editVersion.current > savedVersion.current)) return ''
    draftScheduler.cancel(current.id)
    persistDraft(current)
    const saved = await saveNow(current)
    if (saved) return ''
    return '「' + current.name + '」的改动没能保存，已存本地草稿；重新打开该流程可恢复。'
  }, [draftScheduler, persistDraft, saveNow])

  const openFlow = useCallback(async id => {
    const warning = await flushBeforeLeave()
    // 切流程必须清掉上一份流程留下的 409 横幅，否则它会被当成当前流程的冲突。
    setConflict(null)
    setBusy(true)
    try {
      const result = await api.readFlow(id)
      // 重新打开时要重新检查草稿：saveNow 失败后刚落的草稿不能因为「这个 id 查过了」被跳过。
      draftChecked.current = ''
      applyServerFlow(result.flow)
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
  }, [applyServerFlow, flushBeforeLeave])

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
          applyServerFlow(first.flow)
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
  }, [applyServerFlow])

  useEffect(() => {
    if (flow) setIssues(validateFlow(flow))
  }, [flow])

  /**
   * 只按**流程 id** 重置空图防线：同一份流程被整体换成空图（图上东西丢了）时，
   * `edited` 必须还是 false，这道防线才拦得住；换到另一份流程才重新计数。
   */
  useEffect(() => {
    graphGuard.current = { nodes: flow ? flow.nodes.length : 0, edited: false }
  }, [flow && flow.id])

  useEffect(() => {
    if (saveState !== 'dirty' || !flow) return undefined
    // 缺陷 8：草稿写盘走去抖（600ms，最长 2s），输入一个字不再同步写整份 JSON。
    draftScheduler.schedule(flow)
    const timer = setTimeout(() => { void saveNow(flow) }, 700)
    return () => {
      clearTimeout(timer)
    }
  }, [draftScheduler, flow, saveState, saveNow])

  // 面板卸载（切页）也不丢：先 flush 去抖中的草稿，快照比它新时再补一份。
  useEffect(() => () => {
    const flushed = draftScheduler.flush()
    const current = flowRef.current
    if (current && editVersion.current > savedVersion.current && (!flushed || flushed.flow !== current)) {
      persistDraft(current)
    }
  }, [draftScheduler, persistDraft])

  // 页面隐藏（切标签 / 锁屏 / 关闭前）立即 flush，不能把最后一个字符留在去抖窗里。
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
    const onVisibility = () => {
      if (document.visibilityState && document.visibilityState !== 'hidden') return
      const flushed = draftScheduler.flush()
      const current = flowRef.current
      if (current && editVersion.current > savedVersion.current && (!flushed || flushed.flow !== current)) {
        persistDraft(current)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [draftScheduler, persistDraft])

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
    // 运行中锁结构：草稿是另一份图（节点数可能完全不同），换上去会违反「运行中锁结构」
    // 不变式（引擎按节点重读流程）。与 patchNode / addNodeAt / deleteNode 同口径。
    if (refuseWhenLocked()) return
    const restored = draftNotice.record.flow
    touch()
    markGraphEdited()
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
      // 新建也会切走当前流程：清掉上一份留下的冲突横幅，并用服务器返回的图重算基线。
      setConflict(null)
      applyServerFlow(created.flow)
      setSelection({ kind: 'node', id: starter.nodes[1].id })
      setKeyboardLink(null)
      setSaveState('idle')
      setError(warning || '')
    } catch (failure) {
      setError('新建失败：' + (failure && failure.message ? failure.message : '未知原因'))
    } finally {
      setBusy(false)
    }
  }, [applyServerFlow, busy, flushBeforeLeave])

  /**
   * G5-b：删除流程。确认由 FlowList 的二次确认负责；这里保证「先备份（草稿 + 内存快照）
   * → 再删 → 服务器成功后才清草稿」，失败时草稿原样保留。
   */
  const removeFlow = useCallback(async id => {
    if (busy) return
    const target = (flows || []).find(item => item.id === id)
    const name = (flowRef.current && flowRef.current.id === id ? flowRef.current.name : '')
      || (target && target.name) || id
    setBusy(true)
    setError('')
    try {
      const outcome = await deleteFlowRequest({
        api,
        id,
        // 当前打开且未保存的版本优先；非活动流程用上次失败时留下的内存快照，再退回读盘。
        snapshot: flowRef.current && flowRef.current.id === id
          ? flowRef.current
          : (deleteSnapshots.current.get(id) || null),
        drafts: {
          write: snapshot => { persistDraft(snapshot) },
          clear: flowId => {
            clearDraft(flowId)
            draftScheduler.cancel(flowId)
          },
        },
      })
      if (!outcome.ok) {
        // 删除失败也要留住内存快照：重试不必重新读盘，用户的唯一副本也还在。
        if (outcome.backup) deleteSnapshots.current.set(id, outcome.backup)
        const detail = outcome.error && outcome.error.message ? outcome.error.message : '未知原因'
        const prefix = outcome.stage === 'snapshot' ? '删除已取消：' : '删除失败：'
        setError(prefix + detail + '。删除前的本地草稿与内存快照都保留着，可以重试；服务器上这份流程没有被改动。')
        setAnnounce(prefix + name)
        return
      }
      deleteSnapshots.current.delete(id)
      // 只有服务器删除成功，才把「可撤销快照」挂出来并清草稿（clear 已在 deleteFlowRequest 里做）。
      setDeletedFlow({ flow: outcome.backup, id: outcome.backup.id || id, name })
      setDraftNotice(current => (current && current.flowId === id ? null : current))
      const remaining = flows.filter(item => item.id !== id)
      setFlows(remaining)
      if (flowRef.current && flowRef.current.id === id) {
        // 删除后必然离开这份流程：它留下的冲突横幅不能再挂到下一份流程上。
        setConflict(null)
        if (remaining.length > 0) {
          // 服务器删除已经成功；打开下一条失败不能误报成「删除失败」。
          try {
            const next = await api.readFlow(remaining[0].id)
            applyServerFlow(next.flow)
          } catch (failure) {
            applyServerFlow(null)
            setError('流程已删除，但打开下一条流程失败：'
              + (failure && failure.message ? failure.message : '未知原因') + '。可用「撤销」恢复刚删的流程。')
          }
        } else {
          applyServerFlow(null)
        }
        setSelection(null)
        setKeyboardLink(null)
        editVersion.current = 0
        savedVersion.current = 0
        setSaveState('idle')
      }
      setAnnounce('已删除流程「' + name + '」，可用「撤销」恢复')
    } catch (failure) {
      setError('删除失败：' + (failure && failure.message ? failure.message : '未知原因'))
    } finally {
      setBusy(false)
    }
  }, [applyServerFlow, busy, draftScheduler, flows, persistDraft])

  /** G5-b：撤销删除——把删除前的内存快照按原 id 写回服务器。 */
  const undoDeleteFlow = useCallback(async () => {
    if (!deletedFlow || busy) return
    setBusy(true)
    setError('')
    try {
      const outcome = await restoreFlowRequest({ api, backup: deletedFlow.flow })
      if (!outcome.ok || !outcome.flow) {
        const detail = outcome.error && outcome.error.message ? outcome.error.message : '未知原因'
        setError('撤销删除失败：' + detail + '。快照仍保留，可以再试一次。')
        setAnnounce('撤销删除失败')
        return
      }
      const restored = outcome.flow
      setFlows(previous => {
        const without = previous.filter(item => item.id !== restored.id)
        return [summarize(restored), ...without]
      })
      // 撤销删除会切回这份流程（服务器写回了它）：走 applyServerFlow 重算空图防线基线，
      // 同时清掉删除前遗留的冲突横幅。
      setConflict(null)
      applyServerFlow(restored)
      setSelection(null)
      setKeyboardLink(null)
      setSaveState('idle')
      editVersion.current = 0
      savedVersion.current = 0
      setDraftNotice(null)
      setDeletedFlow(null)
      setAnnounce('已撤销删除，恢复流程「' + (restored.name || restored.id) + '」')
    } catch (failure) {
      setError('撤销删除失败：' + (failure && failure.message ? failure.message : '未知原因'))
    } finally {
      setBusy(false)
    }
  }, [applyServerFlow, busy, deletedFlow])

  const addNodeAt = useCallback((x, y) => {
    if (refuseWhenLocked()) return null
    const node = blankNode(NODE_KIND.STAGE, Math.round(x), Math.round(y), '新阶段')
    touch()
    markGraphEdited()
    setFlow(previous => (previous ? { ...previous, nodes: [...previous.nodes, node] } : previous))
    setSelection({ kind: 'node', id: node.id })
    // 画布节点工具条的「新增下游」要立刻拿到 id 建边；双击新增忽略返回值。
    return node
  }, [markGraphEdited, refuseWhenLocked, touch])

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
    markGraphEdited()
    setFlow(previous => (previous ? { ...previous, edges: [...previous.edges, edge] } : previous))
    setSelection({ kind: 'edge', id: edge.id })
    return edge
  }, [markGraphEdited, refuseWhenLocked, touch])

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
    markGraphEdited()
    setSelection(null)
    setFlow(previous => (previous
      ? {
        ...previous,
        nodes: previous.nodes.filter(node => node.id !== id),
        edges: previous.edges.filter(edge => edge.from !== id && edge.to !== id),
      }
      : previous))
  }, [markGraphEdited, refuseWhenLocked, touch])

  const deleteEdge = useCallback(id => {
    if (refuseWhenLocked()) return
    touch()
    markGraphEdited()
    setSelection(null)
    setFlow(previous => (previous ? { ...previous, edges: previous.edges.filter(edge => edge.id !== id) } : previous))
  }, [markGraphEdited, refuseWhenLocked, touch])

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
  // 没打开任何流程时 `flow` 为 null（流程被删光 / 首次进入且库里没有流程），
  // 但库里可能仍有历史 run —— 顶栏照样要能显示「当前节点」，所以这里不能直接点 `flow.nodes`。
  const flowNodes = flow ? flow.nodes : []
  const liveLabel = runForFlow
    ? runLiveLabel(runForFlow, runLive, { nodes: flowNodes, events: runEvents })
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
    // F2：没有工作区时「运行」按钮禁用并写明原因。
    hasWorkspace: workspaceBlockReason(workspace) === '',
  })
  // v0.7 §4.3：运行列高亮跟抽屉选中；没有选中时退回当前流程的活动 run。
  const selectedRunId = runView && typeof runView.selectedRunId === 'string' && runView.selectedRunId !== ''
    ? runView.selectedRunId
    : (runForFlow ? String(runForFlow.id || '') : '')
  const activeRunId = runView && runView.activeRun && typeof runView.activeRun.id === 'string'
    ? runView.activeRun.id
    : ''

  const handleRunSnapshot = useCallback(snapshot => { setRunView(snapshot) }, [])

  /** G5-d：抽屉刷新列表时走同一个共享数据源，返回 Host 原始 payload（不是第二份轮询）。 */
  const refreshRunRows = useCallback(async options => {
    const snapshot = await runsSource.refresh({ force: Boolean(options && options.force) })
    // 首次就失败（还没有任何成功 payload）时把错误交给抽屉，让「运行日志读取失败 + 重试」照常出现；
    // 已有旧数据时不抛，列表保留上一份（与旧行为一致）。
    if (snapshot.payload === null && snapshot.error) throw new Error(snapshot.error)
    return snapshot.payload
  }, [runsSource])

  /**
   * G5-d：运行列表只有一个数据源。
   *  - 左栏与抽屉都吃 `runRows`（同一份 payload / 同一个 tick）；
   *  - 空闲也按 15s 轮询（createRunsSource 内建），不是「没在跑就完全不刷新」；
   *  - 切回前台、重新打开抽屉立即刷新一次。
   */
  useEffect(() => {
    const unsubscribe = runsSource.subscribe(snapshot => {
      if (snapshot.payload !== null && snapshot.payload !== undefined) {
        setRunRows(extractRunRows(snapshot.payload))
        setRunRowsLoaded(true)
      }
      // 首次加载就失败时保持 loaded=false：抽屉会按自己的错误态显示「读取失败 + 重试」，
      // 不能被一份空的 externalRuns 覆盖成「还没有运行记录」。
    })
    runsSource.start()
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') runsSource.foreground()
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibility)
    }
    return () => {
      unsubscribe()
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      runsSource.stop()
    }
  }, [runsSource])

  // 开始 / 停止后的强制刷新仍然只打一次数据源（force 跳过 1s 新鲜度保护）。
  useEffect(() => {
    if (!logSync) return
    void runsSource.refresh({ force: true })
  }, [logSync, runsSource])

  // G5-d：重新打开面板（抽屉）时立即刷新一次，不必等下一个 15s tick。
  useEffect(() => {
    if (!logOpen) return
    void runsSource.refresh({ force: true })
  }, [logOpen, runsSource])

  /**
   * v0.8 §11.4：详情里的节点标题（`nodes: [{id,title}]`）只用于把 nodeId 显示成人话。
   * 没有 nodeStatus 的老 run 不额外发请求；失败静默保留旧数据（下一次列表刷新再试）。
   */
  useEffect(() => {
    if (selectedRunId === '' || runNodesFetched.current.has(selectedRunId)) return undefined
    const rows = Array.isArray(runRows) ? runRows : []
    const row = rows.find(item => String(item.id || '') === selectedRunId) || null
    if (!row || !hasNodeStatus(row)) return undefined
    let cancelled = false
    void (async () => {
      try {
        const payload = await api.readRun(selectedRunId)
        if (cancelled) return
        runNodesFetched.current.add(selectedRunId)
        setRunNodesById(previous => ({
          ...previous,
          [selectedRunId]: payload && Array.isArray(payload.nodes) ? payload.nodes : [],
        }))
      } catch {
        // 旧 Host / 网络抖动：标题退回 nodeId，不打断运行记录本身。
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedRunId, runRows])

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
    // F2：没有工作区就不允许发起运行（不能点了没反应，也不能静默用默认目录）。
    const blockReason = workspaceBlockReason(workspaceRef.current)
    if (blockReason !== '') {
      setError(blockReason)
      setAnnounce(blockReason)
      return
    }
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
      const selectedWorkspace = normalizeWorkspace(workspaceRef.current)
      const known = runView && Array.isArray(runView.runs) ? runView.runs : []
      // F2：建 run → start 的请求序列走 startRunRequest（它保证两次请求都带 workspace，
      // 且只复用同工作区的 pending run）；失败时带回 run / createdRun 供收口清理。
      const outcome = await startRunRequest({
        api,
        flow: current,
        workspace: selectedWorkspace,
        runName: current.name + ' · ' + formatSavedAt(new Date().toISOString()),
        runs: known,
      })
      run = outcome.run
      createdRun = outcome.createdRun
      if (!outcome.ok) {
        const plan = startFailurePlan('start', outcome.error, run, Boolean(createdRun))
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
        return
      }
      const started = outcome.started
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
      // F2：运行必须有显式工作区；顶栏常驻输入，选中值会记住（localStorage）。
      h('label', {
        className: 'fs-workspace',
        title: '这次运行的工作区绝对路径（必填）。空着时「运行」不可点，不会退回到默认目录。',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          marginLeft: '12px',
          minWidth: '260px',
          flex: '0 1 320px',
        },
      },
      h('span', {
        style: { fontSize: '12px', color: 'var(--fs-muted, #8b949e)', whiteSpace: 'nowrap' },
      }, '工作区'),
      h('input', {
        className: 'fs-workspace-input',
        type: 'text',
        value: workspace,
        placeholder: '/path/to/workspace（绝对路径）',
        'aria-label': '工作区绝对路径',
        'aria-invalid': workspaceBlockReason(workspace) !== '' ? 'true' : 'false',
        spellCheck: false,
        style: {
          flex: '1 1 auto',
          minWidth: '0',
          padding: '4px 8px',
          fontSize: '12px',
          borderRadius: '6px',
          border: '1px solid var(--fs-border, #30363d)',
          background: 'var(--fs-input-bg, #0d1117)',
          color: 'inherit',
        },
        onChange: event => updateWorkspace(event.target.value),
      })),
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

    // 0.4.2：并发保存冲突必须给出可执行的出口，不能只弹一句「保存失败」。
    conflict
      ? h('div', { className: 'fs-error', role: 'alert' },
        h('span', null,
          '服务器上这份流程已被改过（' + (conflict.currentVersion === null ? '未知版本' : '版本 v' + conflict.currentVersion)
          + (conflict.updatedAt ? ' · ' + formatSavedAt(conflict.updatedAt) : '') + '）。怎么处理？'),
        h('span', { className: 'fs-status-spacer' }),
        h('button', { type: 'button', className: 'fs-btn sm danger', onClick: () => { void overwriteConflict() } },
          '用我的版本覆盖'),
        h('button', { type: 'button', className: 'fs-btn sm', onClick: () => { void reloadServerFlow() } },
          '载入服务器版本'))
      : null,

    draftNotice
      ? h('div', { className: 'fs-draft', role: 'status' },
        h('span', { className: 'fs-draft-text' },
          '发现未保存的本地草稿（' + formatSavedAt(draftNotice.record.savedAt) + '）·「'
          + ((draftNotice.record.flow && draftNotice.record.flow.name) || '未命名流程') + '」'),
        h('span', { className: 'fs-status-spacer' }),
        h('button', {
          type: 'button',
          className: 'fs-btn sm',
          // 运行中锁结构：草稿是另一份图，恢复会破坏运行中的图；按钮直接禁用而不是点了没反应。
          disabled: locked,
          title: locked ? RUN_LOCK_REASON : '用本地草稿替换当前图（保存后才会覆盖服务器版本）',
          onClick: restoreDraft,
        }, '恢复'),
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
          // v0.7 §4.3：运行记录（按工作区分组）+ 只读 supervision；点击行切到抽屉里的该 run。
          runs: runRows,
          // v0.8 §11.4：节点状态行用详情里的 nodes 把 nodeId 换成标题（拿不到就显示 nodeId）。
          nodes: selectedRunId === '' ? null : (runNodesById[selectedRunId] || null),
          selectedRunId,
          activeRunId,
          // G5-b：删除成功后的撤销入口（快照在页面内存里）。
          undoDelete: deletedFlow,
          onUndoDelete: () => { void undoDeleteFlow() },
          onFocusRun: run => {
            if (!run || typeof run.id !== 'string' || run.id === '') return
            setLogFocus({ id: run.id, nonce: Date.now() })
            setLogOpen(true)
            setLogSync(value => value + 1)
            setAnnounce('已切换到运行「' + (run.name || run.id) + '」')
          },
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
          onMoveNode: moveNode,
          onAddEdge: addEdge,
          onAddNodeAt: addNodeAt,
          onDeleteNode: deleteNode,
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
      // B4：「点节点」也打开节点运行详情——复用画布选中态，抽屉只读 id（不改选中）。
      focusNode: selection && selection.kind === 'node' ? selection : null,
      syncToken: logSync,
      // 首帧（SSR / 预置快照）就带上抽屉数据，避免打开时先闪一下空态；
      // 浏览器里首次挂载 runView 为 null，抽屉仍走自己的加载路径。
      initialRuns: runView && Array.isArray(runView.runs) ? runView.runs : null,
      // G5-d：抽屉的运行列表与左栏共用页面这一份（同一数据源 / 同一 tick），不再自己轮询。
      externalRuns: runRows,
      externalRunsLoaded: runRowsLoaded,
      onRefreshRuns: refreshRunRows,
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
