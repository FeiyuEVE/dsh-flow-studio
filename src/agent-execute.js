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
 *             ├─ handle.exited 先到 → 成功（gate 必须已 settled）或结构化失败
 *             ├─ ctx.timeoutMs 先到 → adapter.cancel(handle, 'timeout') → BPMN_ACTIVITY_TIMEOUT
 *             └─ ctx.signal abort 先到 → adapter.cancel(handle, 'aborted') → BPMN_ABORTED
 *        └─ finally: gate.abort（未完结时）+ adapter.dispose(handle)
 * ```
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
import { createFinishGate } from './node-finish.js'

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
 * 每个 runtime 一份的 probe 缓存：同一 adapter id **只 probe 一次**，
 * 成功 / 失败都缓存（失败的适配器每次都会失败，不应反复起子进程）。
 *
 * @returns {(adapter: object) => Promise<object>}
 */
export function createAdapterProbeCache() {
  /** @type {Map<string, Promise<object>>} */
  const cache = new Map()
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
    if (!cache.has(id)) {
      cache.set(id, Promise.resolve().then(() => adapter.probe()))
    }
    return cache.get(id)
  }
}

/**
 * admission：先 probe（证明适配器真的可用），再断言原生完结工具能力。
 *
 * probe 失败（codex 不在 / 未登录 / MCP 通道握手失败）与 `finishTool !== 'native'`
 * 都收敛成 `NODE_FINISH_TOOL_UNAVAILABLE`——节点**零派发**，不退回解析文本（11 §1.6）。
 *
 * @param {object} adapter
 * @param {{ probeAdapter?: Function, nodeId?: string }} [options]
 * @returns {Promise<{version: string, helpDigest: string}>}
 * @throws {Error & {code: string}}
 */
export async function admitAdapter(adapter, options = {}) {
  const nodeId = nonEmptyString(options.nodeId) ? options.nodeId : undefined
  const probe = typeof options.probeAdapter === 'function'
    ? options.probeAdapter
    : candidate => Promise.resolve().then(() => candidate.probe())
  let result
  try {
    result = await probe(adapter)
  } catch (error) {
    throw agentHandlerError(
      ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
      `adapter「${adapter?.id ?? '(unknown)'}」probe 失败：${errorText(error)}（按不可用处理，不派发节点）`,
      { adapterId: adapter?.id, nodeId, phase: 'probe', cause: error },
    )
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
 *   instanceId?: string,
 *   probeAdapter?: Function,
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
  const workspaceRoot = resolveWorkspaceRoot(element, options.workspaceRoot)

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
  })

  let handle = null
  let settledBy = null
  let timer = null
  let abortListener = null
  let resolveAborted
  const aborted = new Promise(resolvePromise => { resolveAborted = resolvePromise })
  const timeoutMs = Number.isSafeInteger(ctx.timeoutMs) && ctx.timeoutMs > 0 ? ctx.timeoutMs : 0
  const cancelGraceMs = Number.isSafeInteger(options.cancelGraceMs) && options.cancelGraceMs >= 0
    ? options.cancelGraceMs
    : DEFAULT_CANCEL_GRACE_MS

  const signal = ctx.signal && typeof ctx.signal === 'object'
    && typeof ctx.signal.aborted === 'boolean'
    ? ctx.signal
    : null

  const cancelHandle = async reason => {
    if (handle === null) return
    try {
      await adapter.cancel(handle, reason)
    } catch (error) {
      log('warn', `flow-studio: 取消 agent 活动失败（节点 ${nodeId}）：${errorText(error)}`)
    }
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

    try {
      handle = await adapter.start({
        element,
        ctx,
        finishGate: gate,
        workspaceRoot,
        reminder,
      })
    } catch (error) {
      // 适配器在 start 阶段的失败码：canceled 映射成 abort，其余保留可行动 code。
      if (error && error.code === 'NODE_FINISH_CANCELED') {
        throw agentHandlerError(AGENT_EXECUTE_ERROR.ABORTED, `适配器 ${adapter.id} 在启动阶段被取消：${errorText(error)}`, {
          elementId: nodeId,
          activityId: executionId,
          cause: error,
        })
      }
      if (error && typeof error.code === 'string' && error.code !== '') {
        throw agentHandlerError(error.code, errorText(error), {
          elementId: nodeId,
          activityId: executionId,
          adapter: adapter.id,
          cause: error,
        })
      }
      throw agentHandlerError(ADAPTER_ERROR.INVALID, `适配器 ${adapter.id} 启动失败：${errorText(error)}`, {
        elementId: nodeId,
        activityId: executionId,
        cause: error,
      })
    }

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
    if (timeoutMs > 0) {
      racers.push(new Promise(resolveRace => {
        // 不 unref：活动超时是 handler 的语义，不能因为进程里没有其它句柄就静默消失。
        timer = setTimeout(() => resolveRace({ kind: 'timeout' }), timeoutMs)
      }))
    }
    if (signal && typeof signal.addEventListener === 'function') {
      abortListener = () => resolveAborted({ kind: 'aborted' })
      signal.addEventListener('abort', abortListener, { once: true })
      racers.push(aborted)
    }

    const first = await Promise.race(racers)
    settledBy = first.kind

    if (first.kind === 'timeout') {
      await cancelHandle(`activity timeout after ${timeoutMs}ms`)
      await waitExited()
      throw agentHandlerError(
        AGENT_EXECUTE_ERROR.ACTIVITY_TIMEOUT,
        `活动 ${nodeId} 超过 ${timeoutMs}ms 仍未调用 ${FINISH_TOOL_NAME} 完结（已取消适配器）`,
        { elementId: nodeId, activityId: executionId, adapter: adapter.id, timeoutMs },
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
      // 11 §1.5：完成只认闸门受理的那一条 record；适配器不能「自称完成」。
      if (!gate.settled()) {
        throw agentHandlerError(
          AGENT_EXECUTE_ERROR.FINISH_INVALID,
          `适配器 ${adapter.id} 回报成功，但 ${FINISH_TOOL_NAME} 闸门没有受理过任何提交`,
          { elementId: nodeId, activityId: executionId, adapter: adapter.id },
        )
      }
      let record
      try {
        record = isPlainObject(outcome.record) ? outcome.record : await gate.result
      } catch (error) {
        throw agentHandlerError(
          error && typeof error.code === 'string' ? error.code : AGENT_EXECUTE_ERROR.FINISH_INVALID,
          `节点 ${nodeId} 的完结记录不可用：${errorText(error)}`,
          { elementId: nodeId, activityId: executionId, cause: error },
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
