/**
 * agent 节点的执行生命周期（0.13.1 A3）：**AgentAdapter + `flow_finish_node` 完结门**。
 *
 * 契约：
 *   - `docs/design/11-node-finish-tool.md` §5：runner 不需要知道工具，
 *     `executeAgent(element, ctx)` 返回 `{ output, artifacts, summary, usage, events }`；
 *     `output` 只含短变量，`artifacts` 只含文件引用；
 *   - `docs/design/09-agent-adapter-hooks.md` B-1：适配器冻结形状见 `agent-adapter.js`；
 *   - `docs/design/11-node-finish-tool.md` §3.1：`turn.stop` 提醒由适配器内部完成，
 *     本模块只把它的 `reminder.onFire` 翻成 handler 事件 `agent/reminder`。
 *
 * 本模块只做「一次活动执行」的生命周期：
 *
 * ```
 * resolveAdapter / admit(probe → assertFinishToolNative)
 *   └─ createFinishGate(executionId, nodeId, attempt, workspaceRoot)
 *        └─ adapter.start({ element, ctx, finishGate, workspaceRoot, reminder })
 *             ├─ handle.exited 先到 → 成功只取 `await gate.result`（必须 finished）；
 *             │    gate 已 abort / 未受理 → 失败，绝不采用适配器自报的 record
 *             ├─ 有效时限先到 → adapter.cancel(handle, 'timeout') → BPMN_ACTIVITY_TIMEOUT
 *             └─ ctx.signal abort 先到 → adapter.cancel(handle, 'aborted') → BPMN_ABORTED
 *        └─ finally: gate.abort（未完结时）+ adapter.dispose(handle)
 * ```
 *
 * 有效时限（review-0131 #3）：`ctx.timeoutMs > node.executor.timeoutMs > 0`，同一个
 * deadline 覆盖 probe / start / 执行 / 取消阶段；`executeAgent` 会把 probe 花掉的时间
 * 从剩余预算里扣掉再传给 `runAgentNode`。
 *
 * **不做**：不轮询 stdout、不解析文本猜结论、不判「模型说完成了」；完成只认
 * `finishGate.submit` 产生的那一条 record（11 §1）。
 *
 * @module @feiyueve/dsh-flow-studio/agent-execute
 */

import { resolve as resolvePath } from 'node:path'

import {
  ADAPTER_ERROR, AdapterError, assertFinishToolNative,
} from './agent-adapter.js'
import { NODE_FINISH_ERROR, createFinishGate } from './node-finish.js'
import { WORKSPACE_ERROR, resolveNodeCwd } from './workspace-policy.js'

/** 处理器错误码（runtime 把它们写进 `instance.lastError.code`）。 */
export const AGENT_EXECUTE_ERROR = Object.freeze({
  /** 节点声明了注册表里不存在的 adapter。 */
  ADAPTER_UNSUPPORTED: 'BPMN_AGENT_ADAPTER_UNSUPPORTED',
  /** 没有适配器注册表（旧接线）时 dsh 节点明确失败，不伪造成功。 */
  ADAPTER_UNAVAILABLE: 'BPMN_AGENT_ADAPTER_UNAVAILABLE',
  /** 活动超时：handler 自己先收口并 cancel 适配器。 */
  ACTIVITY_TIMEOUT: 'BPMN_ACTIVITY_TIMEOUT',
  /** ctx.signal abort / 适配器回报 canceled。 */
  ABORTED: 'BPMN_ABORTED',
  /** `adapter.start()` 没返回带 `exited` 的 handle。 */
  HANDLE_INVALID: 'BPMN_AGENT_HANDLE_INVALID',
  /** 适配器说成功但闸门没受理（不允许「假装完结」）。 */
  FINISH_INVALID: 'NODE_FINISH_INVALID',
  /** 实例绑定的工作区记录缺失 / 目录不可用（不静默回退宿主目录）。 */
  WORKSPACE_UNAVAILABLE: WORKSPACE_ERROR.UNAVAILABLE,
  /** worktree 模式下节点 cwd 是绝对路径或 realpath 越界。 */
  WORKSPACE_CWD_OUTSIDE: WORKSPACE_ERROR.CWD_OUTSIDE,
})

/** `flow_finish_node` 的默认工具名（11 §1：只能叫这个名字）。 */
export const FINISH_TOOL_NAME = 'flow_finish_node'

/** 默认 adapter id（`fs:node@adapter` 缺失时）。 */
export const DEFAULT_ADAPTER_ID = 'dsh'

/** 活动超时 / abort 之后等适配器收尾的上限（不能挂住 handler）。 */
export const DEFAULT_CANCEL_GRACE_MS = 1500

/** 提醒事件类型（11 §3.1：经 handler `events[]` 透传，不是新的一等 kind）。 */
export const AGENT_REMINDER_EVENT = 'agent/reminder'

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function errorText(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * 构造与 runtime `handlerError` 同形的轻量错误（只保证 `code` / `message`）。
 *
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 * @returns {Error & { code: string }}
 */
export function agentHandlerError(code, message, details = {}) {
  const error = new Error(typeof message === 'string' && message !== '' ? message : String(code))
  error.name = 'BpmnHandlerError'
  error.code = typeof code === 'string' && code !== '' ? code : AGENT_EXECUTE_ERROR.FINISH_INVALID
  if (isPlainObject(details)) Object.assign(error, details)
  return error
}

/**
 * 节点声明的 adapter id：`fs:node@adapter` 优先，旧 `fs:executor@kind` 兜底。
 * 两者都没有 → `dsh`（0.13 的默认 agent 适配器）。
 *
 * @param {object} element BPMN agent 元素
 * @returns {string|null} 小写 id；无法判定时 null
 */
export function resolveAdapterId(element) {
  const node = isPlainObject(element?.node) ? element.node : {}
  const raw = [
    node.adapter,
    isPlainObject(node.executor) ? node.executor.kind : null,
  ].find(nonEmptyString)
  if (raw === undefined) return null
  return raw.trim().toLowerCase()
}

/**
 * 文档路径的相对基准：节点自己的 `fs:executor@cwd` 优先，否则用调用方给的兜底
 * （runtime 传 process.cwd()）。gate 会校验它确实是目录，并在文档校验时用它做
 * realpath 边界。
 *
 * @param {object} element
 * @param {string} [fallback]
 * @returns {string}
 */
export function resolveWorkspaceRoot(element, fallback) {
  const node = isPlainObject(element?.node) ? element.node : {}
  const cwd = isPlainObject(node.executor) && nonEmptyString(node.executor.cwd)
    ? node.executor.cwd.trim()
    : ''
  return resolvePath(cwd !== '' ? cwd : (nonEmptyString(fallback) ? fallback.trim() : process.cwd()))
}

/**
 * 节点 cwd：**优先使用实例冻结的工作区记录**，替换旧 `fs:executor@cwd` 自由解析。
 *
 * - 有 `workspace` 记录（worktree 模式）：cwd 只允许树内相对子目录；绝对路径 /
 *   realpath 越界抛 `WORKSPACE_CWD_OUTSIDE`；
 * - 没有记录（旧实例 / 直调测试）：保持 `resolveWorkspaceRoot()` 行为。
 *
 * @param {{element:object, workspace?:object, workspaceRoot?:string}} input
 * @returns {string}
 */
export function resolveRunWorkspaceRoot({ element, workspace, workspaceRoot } = {}) {
  if (workspace && typeof workspace === 'object') {
    const node = isPlainObject(element?.node) ? element.node : {}
    const cwd = isPlainObject(node.executor) && nonEmptyString(node.executor.cwd)
      ? node.executor.cwd.trim()
      : ''
    return resolveNodeCwd({ workspace, cwd })
  }
  return resolveWorkspaceRoot(element, workspaceRoot)
}

/**
 * 每个 runtime 一份的 probe **进行中合并**（in-flight dedupe）。
 *
 * 只合并「同一 adapter id 已经在跑的那一次 probe」：并发 admission 不会重复起子进程，
 * 但 probe 结束（成功或失败）后立即从表里移除，**不缓存结果**。
 *
 * 结果缓存的有效期由适配器自己拥有（例如 codex 的 `probeCacheTtlMs`，默认 10 分钟）：
 * runtime 若永久缓存，adapter 的 TTL 一过，`capabilities()` 已经变回 `unsupported`，
 * 而 admission 仍握着旧 Promise，节点会被永久拒绝（review-0131 #2）。
 *
 * @returns {(adapter: object) => Promise<object>}
 */
export function createAdapterProbeCache() {
  /** @type {Map<string, Promise<object>>} */
  const inflight = new Map()
  return function probeAdapter(adapter) {
    if (!adapter || typeof adapter !== 'object') {
      throw new AdapterError(ADAPTER_ERROR.INVALID, 'probeAdapter 需要适配器对象', { field: 'adapter' })
    }
    if (typeof adapter.probe !== 'function') {
      throw new AdapterError(
        ADAPTER_ERROR.INVALID,
        `适配器 ${adapter?.id ?? '(unknown)'} 缺少 probe()`,
        { adapterId: adapter?.id, field: 'probe' },
      )
    }
    const id = typeof adapter.id === 'string' && adapter.id !== '' ? adapter.id : '(anonymous)'
    const running = inflight.get(id)
    if (running !== undefined) return running
    const pending = Promise.resolve().then(() => adapter.probe())
    const tracked = pending.finally(() => {
      if (inflight.get(id) === tracked) inflight.delete(id)
    })
    inflight.set(id, tracked)
    return tracked
  }
}

/**
 * 解析一次 agent 活动的有效时限（里程碑 review-0131 #3）。
 *
 * 优先级与旧外部 executor 路径一致：`ctx.timeoutMs > node.executor.timeoutMs > 0`。
 * 0 / 非法值表示不设活动时限（由 runner 的全局 run 时限或调用方控制）。
 *
 * @param {object} element BPMN agent 元素
 * @param {object} [ctx] handler ctx（runner 传入的全局活动时限）
 * @returns {number} 正整数毫秒，或 0
 */
export function resolveAgentTimeoutMs(element, ctx) {
  const fromCtx = Number.isSafeInteger(ctx?.timeoutMs) && ctx.timeoutMs > 0 ? ctx.timeoutMs : 0
  if (fromCtx > 0) return fromCtx
  const node = isPlainObject(element?.node) ? element.node : {}
  const executor = isPlainObject(node.executor) ? node.executor : null
  const fromNode = executor && Number.isSafeInteger(executor.timeoutMs) && executor.timeoutMs > 0
    ? executor.timeoutMs
    : 0
  return fromNode
}

/**
 * admission：先 probe（证明适配器真的可用），再断言原生完结工具能力。
 *
 * probe 失败（codex 不在 / 未登录 / MCP 通道握手失败）与 `finishTool !== 'native'`
 * 都收敛成 `NODE_FINISH_TOOL_UNAVAILABLE`——节点**零派发**，不退回解析文本（11 §1.6）。
 *
 * `options.timeoutMs` 是本次活动的有效时限（review-0131 #3）：probe 也受它约束，
 * 超时报 `BPMN_ACTIVITY_TIMEOUT`（不是「适配器不可用」——probe 慢不等于能力缺失）。
 *
 * @param {object} adapter
 * @param {{ probeAdapter?: Function, nodeId?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{version: string, helpDigest: string}>}
 * @throws {Error & {code: string}}
 */
export async function admitAdapter(adapter, options = {}) {
  const nodeId = nonEmptyString(options.nodeId) ? options.nodeId : undefined
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 0
  const probe = typeof options.probeAdapter === 'function'
    ? options.probeAdapter
    : candidate => Promise.resolve().then(() => candidate.probe())
  let result
  let timer = null
  try {
    const probing = Promise.resolve().then(() => probe(adapter))
    // 超时之后 probe 自己的 rejection 不能让进程崩（适配器仍在后台收尾）。
    probing.catch(() => {})
    result = timeoutMs > 0
      ? await Promise.race([
        probing,
        new Promise((resolvePromise, rejectPromise) => {
          timer = setTimeout(() => {
            rejectPromise(agentHandlerError(
              AGENT_EXECUTE_ERROR.ACTIVITY_TIMEOUT,
              `适配器「${adapter?.id ?? '(unknown)'}」的 probe 超过 ${timeoutMs}ms 仍未返回：`
                + `节点 ${nodeId ?? '(agent)'} 的活动时限已用尽（按超时处理，不派发）`,
              { adapterId: adapter?.id, nodeId, phase: 'probe', timeoutMs, reason: 'timeout' },
            ))
          }, timeoutMs)
        }),
      ])
      : await probing
  } catch (error) {
    if (error && error.code === AGENT_EXECUTE_ERROR.ACTIVITY_TIMEOUT) throw error
    throw agentHandlerError(
      ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
      `adapter「${adapter?.id ?? '(unknown)'}」probe 失败：${errorText(error)}（按不可用处理，不派发节点）`,
      { adapterId: adapter?.id, nodeId, phase: 'probe', cause: error },
    )
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
  try {
    assertFinishToolNative(adapter, { nodeId, phase: 'admission' })
  } catch (error) {
    throw agentHandlerError(
      ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
      error instanceof Error ? error.message : errorText(error),
      { adapterId: adapter?.id, nodeId, phase: 'admission', cause: error },
    )
  }
  return result
}

function defaultReminderEvent(info) {
  const count = Number.isSafeInteger(info?.count) && info.count > 0 ? info.count : null
  if (count === null) return null
  const maxFires = Number.isSafeInteger(info?.maxFires) && info.maxFires >= 0 ? info.maxFires : null
  return {
    type: AGENT_REMINDER_EVENT,
    count,
    ...(maxFires === null ? {} : { maxFires }),
  }
}

function sleep(ms) {
  return new Promise(resolveSleep => {
    const timer = setTimeout(resolveSleep, ms)
    timer.unref?.()
  })
}

/**
 * 跑完一次 agent 活动，返回 runner 契约里的结果对象。
 *
 * @param {{
 *   element: object,
 *   ctx: object,
 *   adapter: object,
 *   workspaceRoot?: string,
 *   workspace?: object,     // 实例冻结的工作区记录（worktree 模式用它约束节点 cwd）
 *   workspaceId?: string,
 *   artifactStore?: object, // 可选：产物按 hash 寻址快照
 *   instanceId?: string,
 *   probeAdapter?: Function,
 *   effectiveTimeoutMs?: number, // 配置口径的有效时限（透传给适配器 ctx.timeoutMs）
 *   timeoutMs?: number,   // 本活动剩余的执行预算（executeAgent 扣掉 probe 后传入）
 *   cancelGraceMs?: number,
 *   log?: (level: string, message: string) => void,
 * }} options
 * @returns {Promise<{output: object, artifacts: object[], summary: string, usage?: object, events?: object[]}>}
 * @throws {Error & {code: string}} handler 错误（由 runtime 写进 lastError）
 */
export async function runAgentNode(options = {}) {
  const element = isPlainObject(options.element) ? options.element : {}
  const ctx = isPlainObject(options.ctx) ? options.ctx : {}
  const adapter = options.adapter
  const log = typeof options.log === 'function' ? options.log : () => {}
  if (!adapter || typeof adapter.start !== 'function') {
    throw agentHandlerError(
      ADAPTER_ERROR.INVALID,
      'runAgentNode 需要实现了 start() 的适配器',
      { elementId: element.id ?? null },
    )
  }

  const nodeId = nonEmptyString(element.id) ? element.id : '(agent)'
  const attempt = Number.isSafeInteger(ctx.attempt) && ctx.attempt >= 1 ? ctx.attempt : 1
  const executionId = nonEmptyString(ctx.executionId)
    ? ctx.executionId
    : `${nonEmptyString(options.instanceId) ? options.instanceId : 'instance'}:${nodeId}:${attempt}`
  let workspaceRoot
  try {
    workspaceRoot = resolveRunWorkspaceRoot({
      element,
      workspace: options.workspace,
      workspaceRoot: options.workspaceRoot,
    })
  } catch (error) {
    throw agentHandlerError(
      typeof error?.code === 'string' && error.code !== '' ? error.code : AGENT_EXECUTE_ERROR.WORKSPACE_UNAVAILABLE,
      error?.message ?? String(error),
      { elementId: nodeId, workspaceId: options.workspaceId ?? options.workspace?.workspaceId ?? null, cause: error },
    )
  }
  const workspaceId = nonEmptyString(options.workspaceId)
    ? options.workspaceId
    : (nonEmptyString(options.workspace?.workspaceId) ? options.workspace.workspaceId : null)

  // 11 §3.1：提醒由适配器内部触发；这里只把每次提醒翻成 handler 事件。
  const events = []
  const reminder = {
    onFire(info) {
      const event = defaultReminderEvent(info)
      if (event !== null) events.push(event)
    },
  }

  const gate = createFinishGate({
    executionId,
    nodeId,
    attempt,
    workspaceRoot,
    ...(workspaceId === null ? {} : { workspaceId }),
    ...(options.artifactStore && typeof options.artifactStore.captureFile === 'function'
      ? { artifactStore: options.artifactStore }
      : {}),
  })

  let handle = null
  let settledBy = null
  let timer = null
  let abortListener = null
  let resolveAborted
  const aborted = new Promise(resolvePromise => { resolveAborted = resolvePromise })
  // review-0131 #3：有效时限 = 显式 options.effectiveTimeoutMs（executeAgent 解析的
  // `ctx.timeoutMs > node.executor.timeoutMs`）> 直接调用时的 ctx / 节点配置。
  // 配置口径的时限透传给适配器（与旧 executor 的 options.timeoutMs 同口径），
  // 真正计时用 `options.timeoutMs`（executeAgent 扣掉 probe 之后的剩余预算）。
  const configuredTimeoutMs = Number.isSafeInteger(options.effectiveTimeoutMs) && options.effectiveTimeoutMs > 0
    ? options.effectiveTimeoutMs
    : resolveAgentTimeoutMs(element, ctx)
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : configuredTimeoutMs
  // 适配器按契约拿到 handler ctx；把有效时限也透给它，与旧 executor 的 options.timeoutMs 同口径。
  const adapterCtx = configuredTimeoutMs > 0 && ctx.timeoutMs !== configuredTimeoutMs
    ? { ...ctx, timeoutMs: configuredTimeoutMs }
    : ctx
  const cancelGraceMs = Number.isSafeInteger(options.cancelGraceMs) && options.cancelGraceMs >= 0
    ? options.cancelGraceMs
    : DEFAULT_CANCEL_GRACE_MS

  const signal = ctx.signal && typeof ctx.signal === 'object'
    && typeof ctx.signal.aborted === 'boolean'
    ? ctx.signal
    : null

  /** 一次活动只有一个 deadline：probe 之后剩下的时间同时约束 start 与执行。 */
  const timeoutRace = timeoutMs > 0
    ? new Promise(resolveRace => {
      // 不 unref：活动超时是 handler 的语义，不能因为进程里没有其它句柄就静默消失。
      timer = setTimeout(() => resolveRace({ kind: 'timeout' }), timeoutMs)
    })
    : null

  const cancelHandle = async reason => {
    if (handle === null) return
    try {
      await adapter.cancel(handle, reason)
    } catch (error) {
      log('warn', `flow-studio: 取消 agent 活动失败（节点 ${nodeId}）：${errorText(error)}`)
    }
  }

  /**
   * start 阶段就超时 / abort 时句柄可能稍后才到：拿到后立刻 cancel + dispose，
   * 不能把已经放弃的活动留在适配器里空转。
   */
  const discardLateHandle = (started, reason) => {
    Promise.resolve(started).then(late => {
      if (!late || typeof late !== 'object') return
      Promise.resolve()
        .then(() => adapter.cancel(late, reason))
        .catch(error => log('warn', `flow-studio: 取消迟到的 agent 句柄失败（节点 ${nodeId}）：${errorText(error)}`))
        .then(() => adapter.dispose(late))
        .catch(error => log('warn', `flow-studio: 释放迟到的 agent 句柄失败（节点 ${nodeId}）：${errorText(error)}`))
    }, () => {})
  }

  /** start 抛错的统一映射：canceled → abort，其余保留可行动 code。 */
  const startFailure = error => {
    if (error && error.code === 'NODE_FINISH_CANCELED') {
      return agentHandlerError(AGENT_EXECUTE_ERROR.ABORTED, `适配器 ${adapter.id} 在启动阶段被取消：${errorText(error)}`, {
        elementId: nodeId,
        activityId: executionId,
        cause: error,
      })
    }
    if (error && typeof error.code === 'string' && error.code !== '') {
      return agentHandlerError(error.code, errorText(error), {
        elementId: nodeId,
        activityId: executionId,
        adapter: adapter.id,
        cause: error,
      })
    }
    return agentHandlerError(ADAPTER_ERROR.INVALID, `适配器 ${adapter.id} 启动失败：${errorText(error)}`, {
      elementId: nodeId,
      activityId: executionId,
      cause: error,
    })
  }

  /** 等适配器把 exited 收掉；超过宽限就不等了（dispose 还会再兜一次底）。 */
  const waitExited = async () => {
    if (handle === null) return
    let exited
    try {
      exited = handle.exited
    } catch {
      return
    }
    if (!exited || typeof exited.then !== 'function') return
    await Promise.race([Promise.resolve(exited).catch(() => undefined), sleep(cancelGraceMs)])
  }

  try {
    if (signal && signal.aborted) {
      throw agentHandlerError(AGENT_EXECUTE_ERROR.ABORTED, `活动 ${nodeId} 在开始前已被取消（ctx.signal 已 abort）`, {
        elementId: nodeId,
        activityId: executionId,
        reason: 'pre-aborted',
      })
    }

    let started
    try {
      started = adapter.start({
        element,
        ctx: adapterCtx,
        finishGate: gate,
        workspaceRoot,
        // 同一份已解析记录的只读投影：adapter 的 cwd / 文档根都从这里来。
        ...(options.workspace && typeof options.workspace === 'object'
          ? {
            workspace: {
              workspaceId: workspaceId ?? options.workspace.workspaceId ?? null,
              mode: options.workspace.mode === 'worktree' ? 'worktree' : 'off',
              effectiveRoot: workspaceRoot,
            },
          }
          : {}),
        reminder,
      })
    } catch (error) {
      throw startFailure(error)
    }

    if (signal && typeof signal.addEventListener === 'function') {
      abortListener = () => resolveAborted({ kind: 'aborted' })
      signal.addEventListener('abort', abortListener, { once: true })
    }
    const startRacers = [
      Promise.resolve(started).then(
        value => ({ kind: 'started', handle: value }),
        error => ({ kind: 'startFailed', error }),
      ),
    ]
    if (timeoutRace !== null) startRacers.push(timeoutRace)
    if (abortListener !== null) startRacers.push(aborted)
    const firstStart = await Promise.race(startRacers)
    if (firstStart.kind === 'timeout') {
      settledBy = 'timeout'
      discardLateHandle(started, `activity timeout after ${timeoutMs}ms (during start)`)
      throw agentHandlerError(
        AGENT_EXECUTE_ERROR.ACTIVITY_TIMEOUT,
        `活动 ${nodeId} 在启动阶段超过 ${configuredTimeoutMs}ms 的活动时限仍未就绪（迟到句柄会被取消并释放）`,
        { elementId: nodeId, activityId: executionId, adapter: adapter.id, timeoutMs: configuredTimeoutMs, remainingTimeoutMs: timeoutMs, phase: 'start' },
      )
    }
    if (firstStart.kind === 'aborted' || (signal && signal.aborted)) {
      settledBy = 'aborted'
      discardLateHandle(started, 'ctx.signal aborted (during start)')
      throw agentHandlerError(
        AGENT_EXECUTE_ERROR.ABORTED,
        `活动 ${nodeId} 在启动阶段被取消（ctx.signal abort；迟到的适配器句柄会被取消并释放）`,
        { elementId: nodeId, activityId: executionId, adapter: adapter.id, reason: 'aborted', phase: 'start' },
      )
    }
    if (firstStart.kind === 'startFailed') {
      throw startFailure(firstStart.error)
    }
    handle = firstStart.handle

    if (!handle || typeof handle !== 'object' || !handle.exited || typeof handle.exited.then !== 'function') {
      throw agentHandlerError(
        AGENT_EXECUTE_ERROR.HANDLE_INVALID,
        `适配器 ${adapter.id} 的 start() 没有返回带 exited Promise 的 handle`,
        { elementId: nodeId, activityId: executionId, adapter: adapter.id },
      )
    }

    const racers = [
      Promise.resolve(handle.exited).then(
        outcome => ({ kind: 'exited', outcome }),
        error => ({ kind: 'failed', error }),
      ),
    ]
    if (timeoutRace !== null) racers.push(timeoutRace)
    if (abortListener !== null) racers.push(aborted)

    const first = await Promise.race(racers)
    settledBy = first.kind

    if (first.kind === 'timeout') {
      await cancelHandle(`activity timeout after ${configuredTimeoutMs}ms`)
      await waitExited()
      throw agentHandlerError(
        AGENT_EXECUTE_ERROR.ACTIVITY_TIMEOUT,
        `活动 ${nodeId} 超过 ${configuredTimeoutMs}ms 的活动时限仍未调用 ${FINISH_TOOL_NAME} 完结（已取消适配器）`,
        { elementId: nodeId, activityId: executionId, adapter: adapter.id, timeoutMs: configuredTimeoutMs, remainingTimeoutMs: timeoutMs, phase: 'activity' },
      )
    }

    if (first.kind === 'aborted' || (signal && signal.aborted)) {
      await cancelHandle('ctx.signal aborted')
      await waitExited()
      throw agentHandlerError(
        AGENT_EXECUTE_ERROR.ABORTED,
        `活动 ${nodeId} 被取消（ctx.signal abort），已取消适配器`,
        { elementId: nodeId, activityId: executionId, adapter: adapter.id, reason: 'aborted' },
      )
    }

    if (first.kind === 'failed') {
      throw agentHandlerError(
        ADAPTER_ERROR.INVALID,
        `适配器 ${adapter.id} 的 exited 以异常结束：${errorText(first.error)}`,
        { elementId: nodeId, activityId: executionId, adapter: adapter.id, cause: first.error },
      )
    }

    const outcome = isPlainObject(first.outcome) ? first.outcome : {}
    if (outcome.ok === true) {
      // 11 §1.5 / review-0136 F5：完成只认闸门**受理**的那一条 record。
      // 适配器的 `outcome.record` 只是它自报的副本，不能替代提交结果——先 abort
      // 再报 ok 的适配器因此必须失败，而不是拿着伪造 record 成功返回。
      if (!gate.settled()) {
        throw agentHandlerError(
          AGENT_EXECUTE_ERROR.FINISH_INVALID,
          `适配器 ${adapter.id} 回报成功，但 ${FINISH_TOOL_NAME} 闸门既没有受理提交也没有被中止`,
          { elementId: nodeId, activityId: executionId, adapter: adapter.id },
        )
      }
      let record
      try {
        // settled() 为真时只有两种状态：finished（result resolve）或 aborted（result reject）。
        record = await gate.result
      } catch (error) {
        const aborted = Boolean(error)
          && (error.aborted === true || error.code === NODE_FINISH_ERROR.ABORTED)
        throw agentHandlerError(
          aborted ? AGENT_EXECUTE_ERROR.ABORTED : AGENT_EXECUTE_ERROR.FINISH_INVALID,
          aborted
            ? `适配器 ${adapter.id} 回报成功，但完结门已被中止（${errorText(error)}）：`
              + `成功结果只认 ${FINISH_TOOL_NAME} 受理的 record，自报 record 一律不采用`
            : `节点 ${nodeId} 的完结记录不可用：${errorText(error)}`,
          { elementId: nodeId, activityId: executionId, adapter: adapter.id, cause: error },
        )
      }
      if (!isPlainObject(record) || !isPlainObject(record.output)) {
        throw agentHandlerError(
          AGENT_EXECUTE_ERROR.FINISH_INVALID,
          `节点 ${nodeId} 的完结记录形状非法（缺 output）`,
          { elementId: nodeId, activityId: executionId },
        )
      }
      const usageCandidate = outcome.usage ?? (handle && handle.usage)
      return {
        output: { ...record.output },
        artifacts: Array.isArray(record.artifacts) ? record.artifacts.map(item => ({ ...item })) : [],
        summary: typeof record.summary === 'string' ? record.summary : '',
        ...(isPlainObject(usageCandidate) ? { usage: { ...usageCandidate } } : {}),
        ...(events.length > 0 ? { events } : {}),
      }
    }

    // 失败结局：NODE_FINISH_MISSING 保持实例 ACTIVE（由 runtime 写 lastError，不判死）；
    // 校验错误（NODE_VARIABLES_INVALID / NODE_DOCUMENT_INVALID / NODE_ALREADY_FINISHED…）
    // 原样冒泡，节点不结束。
    const reminders = Number.isSafeInteger(outcome.reminders) && outcome.reminders >= 0
      ? outcome.reminders
      : undefined
    if (outcome.code === 'NODE_FINISH_CANCELED') {
      await cancelHandle('adapter reported canceled')
      throw agentHandlerError(
        AGENT_EXECUTE_ERROR.ABORTED,
        `活动 ${nodeId} 被取消：${nonEmptyString(outcome.message) ? outcome.message : '适配器回报 canceled'}`,
        { elementId: nodeId, activityId: executionId, adapter: adapter.id, ...(reminders === undefined ? {} : { reminders }) },
      )
    }
    const code = nonEmptyString(outcome.code) ? outcome.code : 'NODE_FINISH_FAILED'
    const message = nonEmptyString(outcome.message)
      ? outcome.message
      : `节点 ${nodeId} 没有通过 ${FINISH_TOOL_NAME} 完结（${code}）`
    throw agentHandlerError(code, message, {
      elementId: nodeId,
      activityId: executionId,
      adapter: adapter.id,
      ...(reminders === undefined ? {} : { reminders }),
      ...(events.length > 0 ? { events } : {}),
    })
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (abortListener !== null && signal && typeof signal.removeEventListener === 'function') {
      try {
        signal.removeEventListener('abort', abortListener)
      } catch {
        // 卸载失败不影响结局。
      }
      abortListener = null
    }
    if (!gate.settled()) {
      try {
        gate.abort(settledBy === null ? 'activity ended without finish' : `activity ended (${settledBy})`)
      } catch {
        // abort 失败不影响后续 dispose。
      }
    }
    if (handle !== null) {
      try {
        await adapter.dispose(handle)
      } catch (error) {
        log('warn', `flow-studio: 释放 agent 句柄失败（节点 ${nodeId}）：${errorText(error)}`)
      }
    }
  }
}
