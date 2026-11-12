/**
 * BPMN 运行时：把「定义域 / 实例域 / bpmn-runner / HTTP 路由」接成 0.13.0 的
 * 最小可用面（灰度开关默认关）。
 *
 * 边界（0.13.0）：
 *   - 只做 headless 引擎 + 定义/实例 API，不碰画布（bpmn.io 在后续阶段）；
 *   - 不重写 `definition-store` / `instance-store`，只调用它们的导出函数；
 *   - agent 节点只走注册过的 AgentAdapter（dsh / codex / claude）+ `flow_finish_node`
 *     完结门；`custom` 外部 executor、缺注册表的任何 adapter、http connector
 *     **明确失败**，不伪造成功、不退回解析 CLI 输出（错误码见下）。
 *
 * 目录（计划 §2：模板域与运行实例域隔离，均与老 `flows/`、`runs/` 平级）：
 * ```
 * <flow-studio>/definitions/<definitionId>/<version>.bpmn
 * <flow-studio>/instances/<instanceId>/{instance.json,state.json,events/...}
 * ```
 * 传入的 `dir` 是 flow-studio 数据根；为兼容旧调用，若它指向名为 `flows` 的
 * 旧数据目录，本模块自动取父目录作为根。也接受显式 `definitionsRoot` /
 * `instancesRoot` 覆盖（测试与嵌入方使用）。
 *
 * 事件桥（runner onEvent → 落盘）：
 *   - `process/start` / `activity/start` → 事件落盘 + 实例 running；
 *   - `activity/wait` → 事件落盘 + 实例 waiting + `pendingTasks` 落 instance.json；
 *   - `activity/end` → 事件落盘 + 刷新 `pendingTasks`；
 *   - `process/end` → 事件落盘 + `completeInstance('COMPLETED')`；
 *   - `error` → 事件落盘 + 实例 `lastError`（status 保持 ACTIVE，不判死）；
 *   - 条件求值失败 / handler 失败都走 runner 的 `error`，这里不额外编故事。
 *
 * 事件写入不吞错：runner 的 `_safeCall` 会吞掉 onEvent 抛错，所以本模块把每次
 * 追加挂在自己的串行链上，失败记进 `_eventFailures`，请求收口时以
 * `BPMN_EVENT_WRITE_FAILED` 显式返回（不会静默丢事件）。
 *
 * 懒恢复：
 *   - 请求碰到不在内存里的实例时，读 `state.json` + 实例目录里的 `definition.bpmn`，
 *     新建 runner 并 `recover(state)`；
 *   - state 缺失 / 不可恢复 / 定义损坏时**不假装成功**：GET 返回元数据 +
 *     `recovered:false` + 可读原因；写操作返回 409 / 500。
 *   - recover 会重放一次 `activity/wait`（runner 已知的坑 g），这里按 state 里的
 *     `pendingTasks[].executionId` 去重，事件流不会出现重复的 wait。
 *
 * @module @feiyueve/dsh-flow-studio/bpmn-runtime
 */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  DefinitionError,
  definitionsDir,
  listDefinitions,
  readDefinition,
  readDefinitionVersion,
  saveDefinitionVersion,
} from './definition-store.js'
import {
  InstanceError,
  appendInstanceEvents,
  completeInstance,
  createInstance,
  instancesDir,
  listInstances,
  readInstance,
  readInstanceDefinition,
  readInstanceEvents,
  readInstanceSnapshot,
  readInstanceState,
  recordExecutionFailure,
  updateInstance,
  writeInstanceState,
} from './instance-store.js'
import {
  claimInstanceOwner,
  readInstanceOwner,
  releaseInstanceOwner,
  selfOwner,
} from './instance-owner.js'
import { parseBpmn } from './bpmn-parse.js'
import { BPMN_RUNNER_STATUS, BpmnRunnerError, createBpmnRunner } from './bpmn-runner.js'
import { createConnectorStore } from './connector-store.js'
import {
  aggregateInstanceMetrics,
  createMetricsCache,
  finalizeInstanceMetrics,
  metricsFingerprintFor,
  parseTimeMs,
  reduceInstanceMetrics,
} from './instance-metrics.js'
import { executeHttpConnector } from './http-connector.js'
import { normalizeHttpPolicy } from './http-policy.js'
import { BPMN_STATE_KIND, BPMN_STATE_VERSION, sha256Hex } from './bpmn-state.js'
import {
  AGENT_EXECUTE_ERROR, DEFAULT_ADAPTER_ID, admitAdapter, createAdapterProbeCache,
  resolveAdapterId, resolveAgentTimeoutMs, runAgentNode,
} from './agent-execute.js'
import { checkRunId } from './storage-contract.js'
import { DEFAULT_ARTIFACT_MAX_BYTES, artifactsRootFor, createArtifactStore } from './artifact-store.js'
import {
  EVIDENCE_REASON,
  EVIDENCE_REPORT_KIND,
  collectInstanceEvidence,
  isSafeEvidencePath,
  normalizeEvidenceHash,
} from './instance-evidence.js'
import { createExecutionLimits } from './execution-limits.js'
import {
  CLEANUP_POLICY_SET,
  RESOURCE_EVENT,
  ResourceError,
  appendResourceEvent,
  readResourceEvents,
  readWorkspaceSnapshot,
  registryRootFor,
  removeResourceRecord,
  scanResourceRecords,
  worktreesRootFor,
  writeResourceRecord,
  writeWorkspaceSnapshot,
} from './instance-resources.js'
import {
  INSTANCE_WORKTREE_ERROR,
  InstanceWorktreeError,
  createInstanceWorktree,
  createPrunePlan,
  inspectInstanceWorktree,
  listInstanceWorktrees,
  pruneInstanceWorktrees,
  removeInstanceBranch,
  removeInstanceWorktree,
  rollbackCreatedWorktree,
} from './instance-worktree.js'
import {
  INSTANCE_INBOX_ERROR,
  InstanceInboxError,
  createInstanceInbox,
} from './instance-inbox.js'
import { createInstanceTools } from './instance-tools.js'
import {
  WORKSPACE_ALLOWLIST_ENV,
  WORKSPACE_ERROR,
  normalizeAllowlist,
  resolveWorkspace,
} from './workspace-policy.js'

/** 引擎版本（计划 §10.4 的 health 字段）。 */
export const BPMN_ENGINE_VERSION = '26.0.6'

/** 活跃实例 LRU 上限。 */
export const BPMN_MAX_ACTIVE_ENV = 'FLOW_STUDIO_BPMN_MAX_ACTIVE'
/** 单活动超时（毫秒）；不设 = 只受 run 时限 / signal 控制。 */
export const BPMN_ACTIVITY_TIMEOUT_ENV = 'FLOW_STUDIO_BPMN_ACTIVITY_TIMEOUT_MS'

/** 默认活跃实例上限（研究 §7：≈450KB/实例，100 常驻 ≈45MB）。 */
export const DEFAULT_MAX_ACTIVE_INSTANCES = 100

/** 实例域终态；终态不再恢复 runner。 */
/**
 * 实例终态（Camunda 8 口径）：只有 COMPLETED / CANCELED。
 * 引擎出错**不改 status**（保持 ACTIVE），事实写进 `lastError`。
 */
const TERMINAL_STATUSES = new Set(['COMPLETED', 'CANCELED'])

/** connector 记录里算「未结算」的状态（挂起前必须等它们结束或人工处置）。 */
const UNSETTLED_CONNECTOR_STATES = new Set(['started', 'sent', 'unknown'])

/**
 * 解析 `POST /instances/<id>/suspend|resume` 的请求体：只认 `{reason?}`。
 * `reason` 是短说明（≤200 字符，不含控制字符），原样写进 `instance/suspended|resumed` 事件。
 */
function parseLifecycleBody(body, label) {
  if (body !== undefined && body !== null && !isPlainObject(body)) {
    return {
      reason: null,
      error: {
        status: 400,
        body: { ok: false, code: 'BPMN_BODY_INVALID', error: `${label}的请求体必须是 JSON 对象：{ reason? }` },
      },
    }
  }
  const raw = isPlainObject(body) ? body.reason : undefined
  if (raw === undefined || raw === null) return { reason: null, error: null }
  if (typeof raw !== 'string') {
    return {
      reason: null,
      error: { status: 400, body: { ok: false, code: 'BPMN_REASON_INVALID', error: `${label}的 reason 必须是字符串` } },
    }
  }
  const reason = raw.trim()
  if (reason.length > 200 || /[\u0000-\u001f\u007f]/.test(reason)) {
    return {
      reason: null,
      error: {
        status: 400,
        body: { ok: false, code: 'BPMN_REASON_INVALID', error: `${label}的 reason 必须是不含控制字符的短字符串（≤200 字符）` },
      },
    }
  }
  return { reason: reason === '' ? null : reason, error: null }
}

/**
 * 运行时错误：`status` 给 HTTP，`code` 是稳定业务码，`reason` 是中文可读原因。
 *
 * handler（executeAgent / executeHttp）抛的是更轻的 `handlerError`（只保证 `code`）；
 * runner 会把它包成 `BPMN_HANDLER_FAILED`，直接调用 handler 的测试可按原始 `code` 分流。
 * 实例失败时 runtime 会把 handler 的原始 code 写进 `instance.json.result.error.code`。
 */
export class BpmnRuntimeError extends Error {
  /**
   * @param {number} status HTTP 状态码（400/404/405/409/500/503）
   * @param {string} code 稳定错误码
   * @param {string} reason 中文可读原因
   * @param {object} [extra] 附加诊断字段
   */
  constructor(status, code, reason, extra = {}) {
    super(reason)
    this.name = 'BpmnRuntimeError'
    this.status = status
    this.code = code
    this.reason = reason
    Object.assign(this, extra)
  }

  toPayload() {
    const payload = { ok: false, code: this.code, error: this.reason }
    if (typeof this.hint === 'string' && this.hint !== '') payload.hint = this.hint
    if (Array.isArray(this.errors) && this.errors.length > 0) payload.errors = this.errors
    if (Array.isArray(this.warnings) && this.warnings.length > 0) payload.warnings = this.warnings
    return payload
  }
}

/** handler 用的轻量结构化错误：只保证 `code` / `message`。 */
function handlerError(code, message, details = {}) {
  const error = new Error(message)
  error.name = 'BpmnHandlerError'
  error.code = code
  Object.assign(error, details)
  return error
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 读取并校验正整数环境变量；非法 / 未设置返回 fallback（不把错配置当 0）。 */
function positiveEnvInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) return fallback
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** 取 flow-studio 根：传进来的是 `.../flows` 时取父目录，否则原样。 */
function baseDirOf(dir) {
  const absolute = resolve(typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : process.cwd())
  return basename(absolute) === 'flows' ? dirname(absolute) : absolute
}

function resolveRoots(options = {}) {
  const explicitDefinitions = typeof options.definitionsRoot === 'string' && options.definitionsRoot.trim() !== ''
    ? resolve(options.definitionsRoot.trim())
    : null
  const explicitInstances = typeof options.instancesRoot === 'string' && options.instancesRoot.trim() !== ''
    ? resolve(options.instancesRoot.trim())
    : null
  const base = baseDirOf(options.dir)
  return {
    base,
    definitionsRoot: explicitDefinitions ?? join(base, 'definitions'),
    instancesRoot: explicitInstances ?? join(base, 'instances'),
  }
}

/** 单条事件落盘预算：store 的硬上限是 8KB，这里留一点 JSON 信封余量。 */
const EVENT_BYTES_BUDGET = 7800

/** 事件分片 id：BPMN id 允许大小写/点/下划线，但 store 只收 1–64 个安全字符。 */
function shardIdOf(event) {
  const raw = typeof event.elementId === 'string' && event.elementId !== ''
    ? event.elementId
    : typeof event.flowId === 'string' && event.flowId !== ''
      ? event.flowId
      : 'process'
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
  return checkRunId(cleaned) ?? 'process'
}

/** 递归裁剪字符串，保证 event 不会因为大输出撑爆 store 的 8KB 单条上限。 */
function clipDeep(value, maxChars, depth = 0) {
  if (depth > 8) return '[depth-limit]'
  if (typeof value === 'string') {
    return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value
  }
  if (Array.isArray(value)) return value.slice(0, 200).map(item => clipDeep(item, maxChars, depth + 1))
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = clipDeep(item, maxChars, depth + 1)
    return out
  }
  return value
}

function safeJsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return null
  }
}

/**
 * 落盘前的事件整形：正常事件原样写；超过 8KB 时递归裁剪字符串并标 `truncated:true`。
 * `activity/end` 的 agent 输出可能很大，事件流是观测面，不能因为输出大就让整个实例失败。
 * 仍超限时退化成「只保留定位字段」的最小事件（至少能看出发生过什么）。
 */
function persistableEvent(event) {
  const size = safeJsonSize(event)
  if (size === null) return null
  if (size <= EVENT_BYTES_BUDGET) return event
  const clipped = clipDeep({ ...event, truncated: true }, 1500)
  const clippedSize = safeJsonSize(clipped)
  if (clippedSize !== null && clippedSize <= EVENT_BYTES_BUDGET) return clipped
  const minimal = {
    type: event.type,
    at: event.at,
    ...(event.elementId === undefined ? {} : { elementId: event.elementId }),
    ...(event.activityId === undefined ? {} : { activityId: event.activityId }),
    truncated: true,
  }
  return minimal
}

function errorText(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/** 把 store / runner 的错误收敛成 HTTP 结果；无法识别的一律 500。 */
/**
 * 收口撞上挂起 / 生命周期 CAS 冲突：磁盘事实已经赢了，调用方不再当成写失败。
 * 与终态保护（`INSTANCE_TERMINAL_IMMUTABLE`）区分：后者仍要按 stop 抢收报给调用方。
 */
function isLifecycleSuspendedError(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  return code === 'INSTANCE_SUSPENDED'
    || code === 'INSTANCE_SUSPENDED_IMMUTABLE'
    || code === 'INSTANCE_LIFECYCLE_CONFLICT'
    || code === 'INSTANCE_LIFECYCLE_USE_ROUTE'
}

function errorResult(error) {
  if (error instanceof BpmnRuntimeError) {
    return { status: error.status, body: error.toPayload() }
  }
  if (error instanceof DefinitionError || error instanceof InstanceError) {
    const body = { ok: false, code: error.code, error: error.reason ?? error.message }
    if (typeof error.hint === 'string' && error.hint !== '') body.hint = error.hint
    return { status: Number.isInteger(error.status) ? error.status : 500, body }
  }
  if (error instanceof BpmnRunnerError) {
    return { status: runnerErrorStatus(error.code), body: { ok: false, code: error.code, error: error.message } }
  }
  if (error instanceof InstanceInboxError) {
    return { status: error.status, body: error.toPayload() }
  }
  return {
    status: 500,
    body: { ok: false, code: 'BPMN_INTERNAL_ERROR', error: errorText(error) },
  }
}

/** runner 错误码 → HTTP 语义（400 入参 / 404 不存在 / 409 冲突 / 503 引擎不可用）。 */
function runnerErrorStatus(code) {
  if (code === 'BPMN_TASK_NOT_FOUND') return 404
  if (code === 'BPMN_INSTANCE_BLOCKED' || code === 'BPMN_STATE_NOT_RESUMABLE'
    || code === 'BPMN_STATE_DEFINITION_MISMATCH' || code === 'BPMN_STATE_VERSION_UNSUPPORTED'
    || code === 'BPMN_STATE_RECOVER_FAILED' || code === 'BPMN_STATE_INVALID'
    || code === 'BPMN_RECOVER_RUNNING') return 409
  if (code === 'BPMN_OPTIONS_INVALID') return 400
  if (code === 'BPMN_HANDLER_MISSING' || code === 'BPMN_HANDLER_FAILED'
    || code === 'BPMN_INSTANCE_ID_CONFLICT' || code === 'BPMN_LRU_EVICT_UNSNAPSHOTTED') return 503
  return 500
}

/**
 * 创建 BPMN 运行时（工厂）。
 *
 * @param {{
 *   ctx?: any,
 *   dir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   definitionsRoot?: string,
 *   instancesRoot?: string,
 *   maxActiveInstances?: number,
 *   adapters?: object,       // AgentAdapter 注册表（createAdapterRegistry()）；缺省时 agent 节点明确失败
 *   workspaceRoot?: string,  // agent 节点的文档相对基准（默认 process.cwd()）
 *   httpPolicy?: object,     // HTTP connector 的全局目标策略（默认只允许 HTTPS 公网地址）
 *   httpPolicies?: object,   // 可选：networkPolicyId → 策略覆盖
 *   httpAuthResolver?: Function, // 可选：authRef → 鉴权 header（缺省读 FLOW_STUDIO_HTTP_AUTH_*）
 *   worktreeRoot?: string,       // 实例 worktree 根（默认 <base>/worktrees）
 *   worktreeRegistryRoot?: string, // 所有权记录根（默认 <base>/worktree-registry）
 *   artifactRoot?: string,       // 产物快照根（默认 <base>/artifacts）
 *   workspaceAllowlist?: string[]|string, // 工作区 allowlist（默认读 FLOW_STUDIO_WORKSPACE_ROOTS）
 *   executionLimits?: object,    // 覆盖 execution-limits 的默认上限
 *   worktreeRunner?: Function,   // 注入 git runner（测试用）
 *   inboxReplyTargets?: object,  // 收件箱回复白名单：id → {kind:'session',sessionId} / {kind:'http',url,authRef}
 *   inboxHttpPolicy?: object,    // 回复 HTTP 目标策略（缺省复用 httpPolicy）
 *   inboxSessionDeliver?: Function, // 宿主会话投递（缺省从 ctx.agents 取 live agent）
 *   inboxHttpRequest?: Function,    // 测试注入：直接替换回复 HTTP 发送
 * }} [options]
 * @returns {BpmnRuntime}
 */
export function createBpmnRuntime(options = {}) {
  if (!isPlainObject(options)) {
    throw new BpmnRuntimeError(400, 'BPMN_OPTIONS_INVALID', 'createBpmnRuntime(options) 需要一个对象')
  }
  const roots = resolveRoots(options)
  const env = isPlainObject(options.env) ? options.env : process.env
  return new BpmnRuntime({
    ctx: options.ctx ?? null,
    ...roots,
    env,
    maxActiveInstances: options.maxActiveInstances,
    adapters: options.adapters,
    workspaceRoot: options.workspaceRoot,
    httpPolicy: options.httpPolicy,
    httpPolicies: options.httpPolicies,
    httpAuthResolver: options.httpAuthResolver,
    worktreeRoot: options.worktreeRoot,
    worktreeRegistryRoot: options.worktreeRegistryRoot,
    artifactRoot: options.artifactRoot,
    workspaceAllowlist: options.workspaceAllowlist,
    executionLimits: options.executionLimits,
    cleanupFinalWaitMs: options.cleanupFinalWaitMs,
    worktreeRunner: options.worktreeRunner,
    inboxReplyTargets: options.inboxReplyTargets,
    inboxHttpPolicy: options.inboxHttpPolicy,
    inboxSessionDeliver: options.inboxSessionDeliver,
    inboxHttpRequest: options.inboxHttpRequest,
  })
}

/**
 * 物理执行生命周期跟踪（review-0137 W4）。
 *
 * handler 结束 != agent 进程已退出：`adapter.start()` 还没返回、或迟到句柄的
 * cancel/dispose 还在后台、或 dispose 抛错 / 报告未清理完成时，本次执行仍占用
 * 槽位与 `_activeAgents`。只有能确认退出（start 失败不产生进程，或 dispose 完成
 * 且没有 `cleanup.disposed=false`）才允许释放，自动清理才可能继续。
 *
 * 包一层 adapter 而不是改 agent-execute：runtime 侧注入 `adapters` 门面即可同时
 * 覆盖正常路径、start 阶段 abort 的迟到句柄、以及 dispose 失败路径。
 */
const DEFAULT_CLEANUP_FINAL_WAIT_MS = 30_000

/**
 * 等适配器的**最终清理 Promise**（review-0141 M1 ③）。
 *
 * 旧实现只读一次 `handle.cleanup` 快照：dispose 返回时 `disposed:false`，之后进程组
 * 才退出也不会释放槽位。适配器若暴露 `cleanupFinal`（start 失败时挂在错误对象上），
 * 这里等它 settle 再决定；没有该 Promise 时退回快照语义（兼容其它适配器）。
 *
 * @returns {Promise<{disposed:boolean, reason?:string, [key:string]:any}|null>}
 */
function awaitFinalCleanup(source, label, timeoutMs) {
  if (!source || typeof source !== 'object') return Promise.resolve(null)
  const final = source.cleanupFinal
  if (!final || typeof final.then !== 'function') {
    return Promise.resolve(source.cleanup && typeof source.cleanup === 'object' ? source.cleanup : null)
  }
  return new Promise(resolveWait => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveWait(value)
    }
    const timer = setTimeout(() => finish({
      disposed: false,
      finalCleanupTimedOut: true,
      reason: `${label}的最终清理未在 ${timeoutMs}ms 内 settle`,
    }), timeoutMs)
    Promise.resolve(final).then(
      value => finish(value && typeof value === 'object' ? value : { disposed: true }),
      error => finish({
        disposed: false,
        reason: `${label}的最终清理失败：${error && error.message ? error.message : String(error)}`,
      }),
    )
  })
}

function createExecutionLifecycle(options = {}) {
  let pending = 0
  let unresolved = 0
  const waiters = []
  /** @type {Map<object, () => void>} handle → settle（只对已返回的句柄计数） */
  const handleOwners = new Map()
  const cleanupFinalWaitMs = Number.isSafeInteger(options.cleanupFinalWaitMs) && options.cleanupFinalWaitMs >= 0
    ? options.cleanupFinalWaitMs
    : DEFAULT_CLEANUP_FINAL_WAIT_MS

  const notifyIfIdle = () => {
    if (pending > 0) return
    const queued = waiters.splice(0)
    for (const resolveWait of queued) resolveWait()
  }

  const settle = () => {
    if (pending > 0) pending -= 1
    notifyIfIdle()
  }

  const releaseHandle = handle => {
    const finish = handle && typeof handle === 'object' ? handleOwners.get(handle) : undefined
    if (typeof finish === 'function') {
      handleOwners.delete(handle)
      finish()
    }
  }

  function trackStart(rawAdapter, request) {
    pending += 1
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      settle()
    }
    let started
    try {
      started = rawAdapter.start.call(rawAdapter, request)
    } catch (error) {
      finish()
      throw error
    }
    const promise = Promise.resolve(started)
    promise.then(handle => {
      if (handle && typeof handle === 'object') handleOwners.set(handle, finish)
      else finish()
    }, error => {
      // start 失败没有句柄：错误对象上可能挂着 cleanupFinal（codex 的物理清理信号）。
      // 等它 settle 再释放占用；未确认清理（disposed:false）按 unresolved 记诊断。
      const finishAfterFinal = final => {
        if (final && final.disposed === false) unresolved += 1
        finish()
      }
      awaitFinalCleanup(error, 'start 失败', cleanupFinalWaitMs).then(finishAfterFinal, () => {
        unresolved += 1
        finish()
      })
    })
    return promise
  }

  function trackDispose(rawAdapter, handle) {
    let result
    try {
      result = rawAdapter.dispose.call(rawAdapter, handle)
    } catch (error) {
      // 同步抛错：退出未确认，保留占用（不自动清理工作目录 / 不释放槽位）。
      unresolved += 1
      throw error
    }
    return Promise.resolve(result).then(async value => {
      const final = await awaitFinalCleanup(handle, 'dispose', cleanupFinalWaitMs)
      if (final && final.disposed === false) {
        // 适配器如实报告「进程组还没确认退出」：不能当已释放。
        unresolved += 1
        // 独立的最终 Promise 之后再变成 disposed:true（迟到的物理退出）时，
        // 仍然要释放占用——这正是旧实现「只读一次快照」的遗留缺口。
        const stillPending = handle && typeof handle === 'object' ? handle.cleanupFinal : null
        if (stillPending && typeof stillPending.then === 'function') {
          Promise.resolve(stillPending).then(late => {
            if (late && late.disposed === true) releaseHandle(handle)
          }, () => {})
        }
        return value
      }
      releaseHandle(handle)
      return value
    }, error => {
      unresolved += 1
      throw error
    })
  }

  function wrap(rawAdapter) {
    if (!rawAdapter || typeof rawAdapter !== 'object') return rawAdapter
    const wrapped = Object.create(rawAdapter)
    // 继承来的方法用原始 adapter 作 this，避免包装对象吞掉适配器内部状态。
    for (const name of ['probe', 'capabilities']) {
      if (typeof rawAdapter[name] === 'function') {
        wrapped[name] = (...args) => rawAdapter[name](...args)
      }
    }
    wrapped.start = request => trackStart(rawAdapter, request)
    wrapped.cancel = (handle, reason) => (
      typeof rawAdapter.cancel === 'function'
        ? rawAdapter.cancel.call(rawAdapter, handle, reason)
        : Promise.resolve()
    )
    wrapped.dispose = handle => (
      typeof rawAdapter.dispose === 'function'
        ? trackDispose(rawAdapter, handle)
        : Promise.resolve(false)
    )
    return wrapped
  }

  return {
    wrap,
    adaptersFor(registry) {
      return {
        get(id) {
          const raw = registry.get(id)
          return raw ? wrap(raw) : undefined
        },
        list() {
          return typeof registry.list === 'function' ? registry.list().map(raw => wrap(raw)) : []
        },
      }
    },
    idle() {
      return pending === 0
    },
    get unresolved() {
      return unresolved
    },
    whenIdle() {
      if (pending === 0) return Promise.resolve()
      return new Promise(resolveIdle => { waiters.push(resolveIdle) })
    },
  }
}

/** 路径段解码：消息 / 回复 id 允许冒号，客户端会 encodeURIComponent。 */
function decodePathSegment(value) {
  if (typeof value !== 'string') return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

class BpmnRuntime {
  constructor(options) {
    this.ctx = options.ctx
    this.base = options.base
    this.definitionsRoot = options.definitionsRoot
    this.instancesRoot = options.instancesRoot
    this.env = options.env
    this.maxActiveInstances = options.maxActiveInstances
    /** AgentAdapter 注册表（dsh / codex / claude）；缺省时 agent 节点明确失败（不再回退外部 executor）。 */
    this.adapters = options.adapters && typeof options.adapters.get === 'function' ? options.adapters : null
    /** agent 节点 documents 的相对基准。 */
    this.workspaceRoot = typeof options.workspaceRoot === 'string' && options.workspaceRoot.trim() !== ''
      ? resolve(options.workspaceRoot.trim())
      : process.cwd()
    /** HTTP connector 目标策略：默认只允许 HTTPS 公网地址；测试台靠宿主精确放行。 */
    this.httpPolicy = normalizeHttpPolicy(options.httpPolicy)
    /** 可选：`networkPolicyId` → 策略覆盖；与全局策略浅合并。 */
    this.httpPolicies = isPlainObject(options.httpPolicies) ? options.httpPolicies : {}
    /** 可选：宿主凭据解析器（authRef → header 对象）；缺省读 FLOW_STUDIO_HTTP_AUTH_*。 */
    this.httpAuthResolver = typeof options.httpAuthResolver === 'function' ? options.httpAuthResolver : null
    /** worktree 根 / 所有权记录根 / artifact 快照根（默认在 flow-studio 根下）。 */
    this.worktreeRoot = typeof options.worktreeRoot === 'string' && options.worktreeRoot.trim() !== ''
      ? resolve(options.worktreeRoot.trim())
      : worktreesRootFor(this.base)
    this.worktreeRegistryRoot = typeof options.worktreeRegistryRoot === 'string' && options.worktreeRegistryRoot.trim() !== ''
      ? resolve(options.worktreeRegistryRoot.trim())
      : registryRootFor(this.base)
    this.artifactRoot = typeof options.artifactRoot === 'string' && options.artifactRoot.trim() !== ''
      ? resolve(options.artifactRoot.trim())
      : artifactsRootFor(this.base)
    /** 宿主 allowlist（空 = 不限制）；写错的条目忽略，不升级成「全部允许」。 */
    this.workspaceAllowlist = normalizeAllowlist(
      options.workspaceAllowlist ?? this.env[WORKSPACE_ALLOWLIST_ENV] ?? '',
    )
    /** 产物快照 store：实例终态清理 worktree 后仍能按 hash 读回正文。 */
    this.artifactStore = createArtifactStore({ root: this.artifactRoot })
    /** agent 执行槽位（按真实执行占槽；人工等待 / 挂起不占）。 */
    this.executionLimits = createExecutionLimits({
      ...(isPlainObject(options.executionLimits) ? options.executionLimits : {}),
      env: this.env,
    })
    /** 等适配器「最终清理 Promise」的上限（M1 ③）；超时按未确认清理处理。 */
    this.cleanupFinalWaitMs = Number.isSafeInteger(options.cleanupFinalWaitMs) && options.cleanupFinalWaitMs >= 0
      ? options.cleanupFinalWaitMs
      : undefined
    /** 可注入 Git runner（测试 / 嵌入方）；缺省由各模块的 execFile 包装。 */
    this.gitRunner = typeof options.worktreeRunner === 'function' ? options.worktreeRunner : undefined
    /** 收件箱回复白名单：只有宿主维护的 id 能被消息 / 模型引用。 */
    this.inboxReplyTargets = isPlainObject(options.inboxReplyTargets) ? options.inboxReplyTargets : {}
    /** 回复 HTTP 策略：缺省复用 connector 的同一份网络策略。 */
    this.inboxHttpPolicy = isPlainObject(options.inboxHttpPolicy) ? options.inboxHttpPolicy : options.httpPolicy
    /** 宿主会话投递（缺省从 ctx 的 agents 服务取 live agent 的 followup）。 */
    this.inboxSessionDeliver = typeof options.inboxSessionDeliver === 'function'
      ? options.inboxSessionDeliver
      : null
    /** 测试注入：替换回复 HTTP 发送（仍先过 validateDestination）。 */
    this.inboxHttpRequest = typeof options.inboxHttpRequest === 'function' ? options.inboxHttpRequest : null
    /** 实例域 inbox：懒建（查看消息不启动 runner，也不构建无用对象）。 */
    this._inbox = null
    /** 本 runtime 恢复过 runner 的实例（用于收件箱 cold/resumed 标注）。 */
    this._recoveredInstances = new Set()
    /** 每个 runtime 的 probe 缓存：同一 adapter id 只 probe 一次（成功/失败都缓存）。 */
    this._probeAdapter = createAdapterProbeCache()

    /** @type {Map<string, any>} instanceId → runner（懒恢复后常驻） */
    this._runners = new Map()
    /** @type {Map<string, Promise<void>>} 同一实例的写操作串行链 */
    this._locks = new Map()
    /** @type {Map<string, Promise<void>>} 同一实例的事件追加串行链 */
    this._eventChains = new Map()
    /** @type {Map<string, Error[]>} 事件追加失败（请求收口时显式报出） */
    this._eventFailures = new Map()
    /** @type {Map<string, Map<string, number>>} instanceId → elementId → attempt */
    this._attempts = new Map()
    /** @type {Map<string, Set<string>>} recover 时抑制重放的 activity/wait */
    this._suppressWait = new Map()
    /** @type {Map<string, {code: string, message: string}>} runner 失败的结构化原因 */
    this._runnerErrors = new Map()
    /** 本 runtime 实例的随机 id：区分同进程多个 runtime 的执行所有权。 */
    this.runtimeId = randomUUID()
    /** @type {Set<string>} 停止闩：置位后该实例的迟到事件与懒恢复一律不再推进 */
    this._stopping = new Set()
    /**
     * @type {Map<string, number>} 未完成的事件提交计数（0.14.4）。
     *
     * `_onRunnerEvent` 在**同步**入队前 +1，队内任务 `finally` 里 -1。挂起看到 >0
     * 说明还有事件在排队 / 在写盘，返回 409 BUSY（kind: 'event-queue'），不把「已出队」
     * 当成「已完成」。
     */
    this._pendingEventCommits = new Map()
    /**
     * @type {Map<string, number>} 首次 workspace / 定义准备 + 首次启动的临时计数（MAJOR-4）。
     * 准备期间挂起会打断创建流程，所以 `_createInstance` 从准备开始到首次 start 收口
     * 期间持有它，`_suspendBusy` 看到 >0 → 409 BUSY（kind: 'preparing'）。
     */
    this._preparing = new Map()
    /** @type {Set<string>} 本 runtime 持有 `owner.json` 的实例（dispose / 终态时释放）。 */
    this._ownedInstances = new Set()
    /**
     * @type {Map<string, object[]>} 被丢弃的迟到事件诊断（有界，最近 20 条 / 实例）。
     * 挂起后晚到的推进事件不写事件流，但保留「发生过什么」用于排障。
     */
    this._eventDiagnostics = new Map()
    /** @type {Map<string, Map<string, {elementId: string|null, executionId: string|null}>>} */
    this._activeAgentActivities = new Map()
    /** @type {Map<string, object>} instanceId → 最后一个成功 agent 节点的 output（process/end 用） */
    this._lastAgentOutputs = new Map()
    /** @type {Map<string, string>} `instanceId\\0executionId` → agent 节点 summary（activity/end 用） */
    this._agentSummaries = new Map()
    /** @type {Map<string, number>} instanceId → agent handler 失败时的提醒次数（lastError.reminders） */
    this._agentReminders = new Map()
    /** @type {Map<string, {workspace: object|null, error: {code:string,message:string}|null}>} */
    this._workspaces = new Map()
    /** @type {Map<string, number>} instanceId → 正在执行的 agent 数（终态清理前必须归零） */
    this._activeAgents = new Map()
    /** @type {Map<string, {plan: object, createdAt: number}>} prune 预览 plan */
    this._prunePlans = new Map()
    /** 运行指标的事件侧归约缓存：只绑 lastSeq/revision/schemaVersion（+ connector/资源指纹） */
    this._metricsCache = createMetricsCache()
    this._disposed = false
  }

  /** 数据根（便于测试 / 运维核对）。 */
  get roots() {
    return {
      definitionsRoot: this.definitionsRoot,
      instancesRoot: this.instancesRoot,
      worktreeRoot: this.worktreeRoot,
      worktreeRegistryRoot: this.worktreeRegistryRoot,
      artifactRoot: this.artifactRoot,
    }
  }

  /**
   * 实例域 inbox（懒建）。只读接口也走它，但**不会** `_ensureRunner()`。
   */
  get inbox() {
    if (this._inbox !== null) return this._inbox
    const sessionDeliver = this.inboxSessionDeliver ?? this._defaultSessionDeliver()
    this._inbox = createInstanceInbox({
      instancesRoot: this.instancesRoot,
      replyTargets: this.inboxReplyTargets,
      httpPolicy: this.inboxHttpPolicy,
      env: this.env,
      ...(sessionDeliver === null ? {} : { sessionDeliver }),
      ...(this.inboxHttpRequest === null ? {} : { httpRequest: this.inboxHttpRequest }),
      activityExists: (instanceId, activityId) => this._activityExists(instanceId, activityId),
      // 精确目标校验优先用内存 runner 的待办（刚落盘的 pendingTasks 可能晚一拍）。
      pendingTasksFor: instanceId => {
        const runner = this._runners.get(instanceId)
        return runner && typeof runner.pendingTasks === 'function' ? runner.pendingTasks() : null
      },
      emitResourceEvent: (instanceId, event) => this._appendResourceEventSafe(instanceId, event),
    })
    return this._inbox
  }

  /** 默认回复通道：只投给宿主注册表里**当前 live** 的会话；没有就不假装送达。 */
  _defaultSessionDeliver() {
    const ctx = this.ctx
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null
    if (!agents || typeof agents.get !== 'function') return null
    return async ({ sessionId, text, replyId, messageId, instanceId, document }) => {
      const agent = agents.get(sessionId)
      if (!agent || typeof agent.followup !== 'function') {
        return {
          ok: false,
          code: 'MESSAGE_REPLY_SESSION_NOT_LIVE',
          error: `回复目标会话 ${sessionId} 当前不在宿主 live 注册表里`,
          deliveryUnknown: false,
          retryable: true,
        }
      }
      // 附件不能静默丢：默认 session 通道把附件表达成带 path / sha256 / 字节数的
      // 可读取引用（相对实例工作区）。没有任何文本也没有附件引用时明确失败。
      const attachmentParts = isPlainObject(document) && typeof document.path === 'string' && document.path !== ''
        ? [
          `[附件] ${document.path}`,
          typeof document.sha256 === 'string' && document.sha256 !== '' ? `sha256 ${document.sha256}` : '',
          Number.isSafeInteger(document.bytes) ? `${document.bytes} 字节` : '',
          '路径相对实例工作区',
        ].filter(part => part !== '')
        : []
      const attachment = attachmentParts.length === 0 ? '' : `\n\n（${attachmentParts.join('；')}）`
      const body = `${typeof text === 'string' ? text : ''}${attachment}`
      if (body.trim() === '') {
        return {
          ok: false,
          code: INSTANCE_INBOX_ERROR.REPLY_UNSUPPORTED,
          error: '回复既没有文本也没有可传递的附件引用，不能标成功',
          deliveryUnknown: false,
          retryable: false,
        }
      }
      agent.followup({
        id: `flow-reply-${replyId}`,
        role: 'user',
        source: {
          kind: 'user',
          // 宿主 MessageSourceMap 只认 `user`；用 meta 区分「外部收件箱回复」来源。
          meta: { untrusted: true, origin: 'flow-studio:inbox-reply', instanceId },
          flowStudio: {
            kind: 'inbox-reply',
            instanceId,
            messageId,
            replyId,
            from: 'flow-studio:inbox',
            untrusted: true,
            ...(isPlainObject(document) && typeof document.path === 'string'
              ? { documentPath: document.path }
              : {}),
          },
        },
        content: [{ type: 'text', text: body }],
      })
      // followup 只保证排进会话；能否被读不确认。
      return { ok: true, deliveryUnknown: true }
    }
  }

  /** 冻结定义里是否存在该 activity（nextActivation 目标校验；读失败时不误杀）。 */
  async _activityExists(instanceId, activityId) {
    try {
      const snapshot = await readInstanceDefinition(instanceId, { instancesRoot: this.instancesRoot })
      if (snapshot === null) return true
      const parsed = await parseBpmn(snapshot.xml)
      if (!parsed.ok || !parsed.definition) return true
      const known = parsed.definition.elementById
      return known instanceof Map ? known.has(activityId) : true
    } catch {
      return true
    }
  }

  /** 活跃实例数（只算真正在跑的：running / waiting；终态与已淘汰的不算）。 */
  get activeCount() {
    let count = 0
    for (const runner of this._runners.values()) {
      if (!runner || typeof runner.status !== 'function') continue
      const status = runner.status()
      if (status === 'running' || status === 'waiting') count += 1
    }
    return count
  }

  /** `GET /health` 用：计数每次现算，不缓存。 */
  async health() {
    let definitions = 0
    let instances = 0
    let error = null
    try {
      definitions = (await listDefinitions({ definitionsRoot: this.definitionsRoot })).length
    } catch (caught) {
      error = errorText(caught)
    }
    try {
      instances = (await listInstances({ instancesRoot: this.instancesRoot, limit: 1000 })).length
    } catch (caught) {
      error = error ? `${error}; ${errorText(caught)}` : errorText(caught)
    }
    return {
      enabled: true,
      engine: BPMN_ENGINE_VERSION,
      definitions,
      instances,
      active: this.activeCount,
      ...(error === null ? {} : { error }),
    }
  }

  /**
   * 处理一条 definitions / instances 路由。**不抛错**：所有失败都收敛成
   * `{status, body}`，由 index 的 `route()` 负责 sendJson（鉴权已在 index 完成）。
   *
   * @param {{method?: string, parts?: string[], url?: URL|string, body?: object}} request
   * @returns {Promise<{status: number, body: object}>}
   */
  async handle(request = {}) {
    try {
      if (this._disposed) {
        return { status: 503, body: { ok: false, code: 'BPMN_RUNTIME_DISPOSED', error: 'BPMN 运行时已释放' } }
      }
      const method = String(request.method ?? 'GET').toUpperCase()
      const parts = Array.isArray(request.parts) ? request.parts.map(String) : []
      const url = request.url instanceof URL
        ? request.url
        : new URL(typeof request.url === 'string' && request.url !== '' ? request.url : '/', 'http://localhost')
      const body = request.body
      if (parts[0] === 'definitions') return await this._handleDefinitions(method, parts, url, body)
      if (parts[0] === 'instances') return await this._handleInstances(method, parts, url, body)
      if (parts[0] === 'instance-worktrees') return await this._handleInstanceWorktrees(method, parts, url, body)
      if (parts[0] === 'metrics') return await this._handleMetrics(method, parts, url)
      return { status: 404, body: { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口' } }
    } catch (error) {
      return errorResult(error)
    }
  }

  /**
   * 能力探测（E3 模型工具用）：本 runtime 是否支持 `POST /instances` 的
   * `workspace` / `worktree` 选项。只读、无副作用，不声明任何业务能力。
   *
   * @returns {{workspace: boolean, worktree: boolean}}
   */
  workspaceCapabilities() {
    return { workspace: true, worktree: true }
  }

  /** 释放内存中的 runner（进程退出 / 测试；不删磁盘数据、不把实例标成终态）。 */
  async dispose() {
    this._disposed = true
    for (const runner of this._runners.values()) {
      try {
        await runner.stop()
      } catch {
        // 释放路径不抛：磁盘上的 state 仍可被新进程恢复。
      }
    }
    this._runners.clear()
    this._locks.clear()
    this._eventChains.clear()
    this._eventFailures.clear()
    this._attempts.clear()
    this._suppressWait.clear()
    this._stopping.clear()
    this._pendingEventCommits.clear()
    this._preparing.clear()
    this._eventDiagnostics.clear()
    for (const instanceId of [...this._ownedInstances]) {
      try {
        await releaseInstanceOwner(instanceId, { instancesRoot: this.instancesRoot, runtimeId: this.runtimeId })
      } catch {
        // 释放所有权失败不阻塞 dispose：下一位持有者会看到 stale owner 并自行接管。
      }
    }
    this._ownedInstances.clear()
    this._activeAgentActivities.clear()
    this._runnerErrors.clear()
    this._lastAgentOutputs.clear()
    this._agentSummaries.clear()
    this._agentReminders.clear()
    this._workspaces.clear()
    this._activeAgents.clear()
    this._prunePlans.clear()
    this._recoveredInstances.clear()
    this._inbox = null
  }

  // -------------------------------------------------------------------------
  // definitions
  // -------------------------------------------------------------------------

  async _handleDefinitions(method, parts, url, body) {
    if (parts.length === 1) {
      if (method === 'GET') return await this._listDefinitions()
      if (method === 'POST') return await this._saveDefinition(body)
      return methodNotAllowed('GET / POST')
    }
    if (parts.length === 2) {
      if (method === 'GET') return await this._readDefinition(parts[1], url)
      return methodNotAllowed('GET')
    }
    return { status: 404, body: { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口' } }
  }

  async _listDefinitions() {
    const summaries = await listDefinitions({ definitionsRoot: this.definitionsRoot })
    const definitions = []
    for (const summary of summaries) {
      let meta = null
      try {
        meta = await readDefinition(summary.id, { definitionsRoot: this.definitionsRoot })
      } catch {
        // 坏 meta 不该让整张列表 500（store 的 list 也是这个口径）。
      }
      definitions.push({
        id: summary.id,
        name: summary.name,
        description: summary.description,
        tags: summary.tags,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        versionCount: summary.versionCount,
        latestVersion: summary.latestVersion,
        latestHash: meta?.latestHash ?? null,
        versions: meta ? meta.versions.map(versionOf) : [],
      })
    }
    return { status: 200, body: { ok: true, definitions } }
  }

  async _saveDefinition(body) {
    if (!isPlainObject(body)) {
      return {
        status: 400,
        body: { ok: false, code: 'BPMN_BODY_INVALID', error: '请求体必须是 JSON 对象：{ id?, name, xml }' },
      }
    }
    const xml = body.xml
    if (typeof xml !== 'string' || xml.trim() === '') {
      return {
        status: 400,
        body: { ok: false, code: 'BPMN_XML_REQUIRED', error: 'xml 必须是非空 BPMN 2.0 XML 字符串' },
      }
    }

    // 先解析校验：ok:false 直接 400，不落盘（坏的模板不允许进定义域）。
    const parsed = await parseBpmn(xml)
    if (!parsed.ok) {
      return {
        status: 400,
        body: {
          ok: false,
          code: 'BPMN_XML_INVALID',
          error: 'BPMN XML 未通过校验',
          errors: parsed.errors,
          warnings: parsed.warnings,
        },
      }
    }

    const id = this._definitionIdFrom(body, parsed.definition)
    if (id === null) {
      return {
        status: 400,
        body: {
          ok: false,
          code: 'BPMN_DEFINITION_ID_INVALID',
          error: 'id 只能由字母 / 数字 / 点 / 下划线 / 连字符组成，不以点开头，且不超过 64 字符',
          hint: '不传 id 时会从 process id 或 name 推导一个合法 id',
        },
      }
    }
    const name = typeof body.name === 'string' && body.name.trim() !== ''
      ? body.name.trim()
      : (parsed.definition.name ?? id)
    const saved = await saveDefinitionVersion(
      id,
      xml,
      { name },
      { definitionsRoot: this.definitionsRoot },
    )
    return {
      status: saved.created ? 201 : 200,
      body: {
        ok: true,
        id: saved.id,
        version: saved.version,
        hash: saved.hash,
        created: saved.created,
        warnings: parsed.warnings,
      },
    }
  }

  /** 显式 id 优先；缺省从 process id / name 推一个 store 能接受的 slug。 */
  _definitionIdFrom(body, definition) {
    if (body.id !== undefined && body.id !== null) {
      if (typeof body.id !== 'string') return null
      return checkRunId(body.id.trim())
    }
    for (const source of [definition?.id, body.name]) {
      if (typeof source !== 'string' || source.trim() === '') continue
      const slug = source
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
      if (checkRunId(slug)) return slug
    }
    return checkRunId(`def-${Date.now().toString(36)}`)
  }

  async _readDefinition(id, url) {
    const definitionId = checkRunId(id)
    if (!definitionId) {
      return { status: 400, body: { ok: false, code: 'BPMN_DEFINITION_ID_INVALID', error: 'definitionId 非法' } }
    }
    const meta = await readDefinition(definitionId, { definitionsRoot: this.definitionsRoot })
    if (meta === null) {
      return { status: 404, body: { ok: false, code: 'DEFINITION_NOT_FOUND', error: `定义 ${definitionId} 不存在` } }
    }
    const rawVersion = url.searchParams.get('version')
    let wanted = meta.latestVersion
    if (rawVersion !== null && rawVersion !== '') {
      if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
        return { status: 400, body: { ok: false, code: 'BPMN_VERSION_INVALID', error: 'version 必须是 ≥1 的整数' } }
      }
      wanted = Number(rawVersion)
    }
    const body = {
      ok: true,
      id: meta.id,
      name: meta.name,
      description: meta.description,
      tags: meta.tags,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      latestVersion: meta.latestVersion,
      latestHash: meta.latestHash,
      versions: meta.versions.map(versionOf),
      version: null,
      hash: null,
      bytes: null,
      xml: null,
    }
    if (wanted === null) return { status: 200, body }
    const version = await readDefinitionVersion(definitionId, wanted, { definitionsRoot: this.definitionsRoot })
    if (version === null) {
      return {
        status: 404,
        body: { ok: false, code: 'DEFINITION_VERSION_NOT_FOUND', error: `定义 ${definitionId} 的 v${wanted} 不存在` },
      }
    }
    body.version = version.version
    body.hash = version.hash
    body.bytes = version.bytes
    body.xml = version.xml
    return { status: 200, body }
  }

  // -------------------------------------------------------------------------
  // instances — 路由
  // -------------------------------------------------------------------------

  async _handleInstances(method, parts, url, body) {
    if (parts.length === 1) {
      if (method === 'GET') return await this._listInstances(url)
      if (method === 'POST') return await this._createInstance(body)
      return methodNotAllowed('GET / POST')
    }
    const id = checkRunId(parts[1])
    if (parts.length === 2) {
      if (method !== 'GET') return methodNotAllowed('GET')
      if (!id) return invalidInstanceId()
      return await this._readInstance(id)
    }
    if (parts.length === 3) {
      if (!id) return invalidInstanceId()
      if (parts[2] === 'events') {
        if (method !== 'GET') return methodNotAllowed('GET')
        return await this._readEvents(id, url)
      }
      if (parts[2] === 'definition') {
        // 实例画布永远读冻结快照，不回查定义域（定义新增版本 / 被删都不影响）。
        if (method !== 'GET') return methodNotAllowed('GET')
        return await this._readInstanceDefinitionSnapshot(id)
      }
      if (parts[2] === 'tasks') {
        if (method !== 'GET') return methodNotAllowed('GET')
        return await this._readTasks(id)
      }
      if (parts[2] === 'messages') {
        if (method === 'GET') return await this._readInstanceMessages(id, url)
        if (method === 'POST') return await this._acceptInstanceMessage(id, body)
        return methodNotAllowed('GET / POST')
      }
      if (parts[2] === 'resource-events') {
        if (method !== 'GET') return methodNotAllowed('GET')
        return await this._readResourceEvents(id, url)
      }
      if (parts[2] === 'metrics') {
        // 0.13.10：运行指标是**纯读**——不调 `_ensureRunner()`、不因看页面推进实例。
        if (method !== 'GET') return methodNotAllowed('GET')
        return await this._readInstanceMetrics(id, url)
      }
      if (parts[2] === 'evidence') {
        // 0.13.12：业务证据是**纯读**——不建 runner、不懒恢复、不改实例状态。
        if (method !== 'GET') return methodNotAllowed('GET')
        return await this._readInstanceEvidence(id, url)
      }
      if (parts[2] === 'worktree') {
        if (method === 'GET') return await this._readInstanceWorktree(id)
        if (method === 'DELETE') return await this._deleteInstanceWorktree(id, body)
        return methodNotAllowed('GET / DELETE')
      }
      if (parts[2] === 'stop') {
        if (method !== 'POST') return methodNotAllowed('POST')
        return await this._stopInstance(id)
      }
      if (parts[2] === 'suspend') {
        if (method !== 'POST') return methodNotAllowed('POST')
        return await this._suspendInstance(id, body)
      }
      if (parts[2] === 'resume') {
        if (method !== 'POST') return methodNotAllowed('POST')
        return await this._resumeInstance(id, body)
      }
      return { status: 404, body: { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口' } }
    }
    if (parts.length === 4 && parts[2] === 'worktree' && parts[3] === 'branch') {
      if (method !== 'DELETE') return methodNotAllowed('DELETE')
      if (!id) return invalidInstanceId()
      return await this._deleteInstanceWorktreeBranch(id, body)
    }
    if (parts.length === 5 && parts[2] === 'tasks' && parts[4] === 'complete') {
      if (method !== 'POST') return methodNotAllowed('POST')
      if (!id) return invalidInstanceId()
      return await this._completeTask(id, parts[3], body)
    }
    if (parts.length === 5 && parts[2] === 'messages' && parts[4] === 'body') {
      if (method !== 'GET') return methodNotAllowed('GET')
      if (!id) return invalidInstanceId()
      return await this._readInstanceMessageBody(id, decodePathSegment(parts[3]))
    }
    if (parts.length === 5 && parts[2] === 'messages' && parts[4] === 'replies') {
      if (method !== 'POST') return methodNotAllowed('POST')
      if (!id) return invalidInstanceId()
      return await this._postInstanceReply(id, decodePathSegment(parts[3]), body)
    }
    // m1：HTTP connector 调用记录的人工处置入口。只改记录，不推进引擎、不伪造活动完成。
    if (parts.length === 5 && parts[2] === 'connector' && parts[4] === 'resolve') {
      if (method !== 'POST') return methodNotAllowed('POST')
      if (!id) return invalidInstanceId()
      return await this._resolveConnectorInvocation(id, parts[3], body)
    }
    return { status: 404, body: { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口' } }
  }

  /**
   * `POST /instances/<id>/connector/<recordId>/resolve`：
   * `{ action: 'mark-succeeded' | 'mark-failed' | 'retry' | 'clear-tombstone', evidence, operator?, result? }`。
   *
   * 安全边界：
   *   - 只操作 connector 调用记录（以及 clear-tombstone 的墓碑快照），**不调用 runner /
   *     不写 activity/end / 不改实例状态**；实例保持 ACTIVE（或它原本的状态）语义，
   *     避免用「处置」伪造一次成功执行；
   *   - 终态实例 / 正在停止的实例拒绝处置；
   *   - evidence 必填，所有真实变更追加 `connector/audit.jsonl`；重复动作幂等；
   *   - retry 只把记录重置为 attempts=0，不自动重发；是否重跑仍由上层受控推进决定；
   *   - clear-tombstone 只删除不可恢复墓碑快照，**不重放任何前序副作用**；清除后
   *     实例不会自动恢复（引擎快照已不存在），仍需人工决定是否新建实例。
   */
  async _resolveConnectorInvocation(instanceId, recordId, body) {
    const wanted = typeof recordId === 'string' ? recordId.trim() : ''
    if (wanted === '' || wanted.length > 256 || !/^[A-Za-z0-9._-]+$/.test(wanted)) {
      return {
        status: 400,
        body: {
          ok: false,
          code: 'HTTP_RESOLVE_INVALID',
          error: 'connector 记录 id 必须是 1–256 个安全字符（记录 executionId / invocationId / 引擎 executionId）。',
        },
      }
    }
    if (body !== undefined && body !== null && !isPlainObject(body)) {
      return {
        status: 400,
        body: { ok: false, code: 'HTTP_RESOLVE_INVALID', error: '请求体必须是 JSON 对象：{ action, evidence, operator?, result? }' },
      }
    }
    const input = isPlainObject(body) ? body : {}
    return await this._withInstance(instanceId, async () => {
      const instance = await readInstance(instanceId, { instancesRoot: this.instancesRoot })
      if (instance === null) return instanceNotFound(instanceId)
      if (this._stopping.has(instanceId)) {
        return {
          status: 409,
          body: { ok: false, code: 'BPMN_INSTANCE_STOPPING', error: `实例 ${instanceId} 正在停止，不能处置 connector 调用记录` },
        }
      }
      if (TERMINAL_STATUSES.has(instance.status)) {
        return {
          status: 409,
          body: {
            ok: false,
            code: 'BPMN_INSTANCE_TERMINAL',
            error: `实例 ${instanceId} 已结束（${instance.status}），不能再处置 connector 调用记录`,
          },
        }
      }
      const store = createConnectorStore({ root: join(this.instancesRoot, instanceId, 'connector') })
      let record
      try {
        record = await store.findInvocation(instanceId, wanted)
      } catch (error) {
        const result = errorResult(error)
        return { status: result.status, body: { ...result.body, id: instanceId } }
      }
      if (record === null) {
        return {
          status: 404,
          body: {
            ok: false,
            code: 'HTTP_INVOCATION_NOT_FOUND',
            error: `实例 ${instanceId} 没有找到 connector 记录 ${wanted}`,
            id: instanceId,
          },
        }
      }
      const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : ''
      let resolved
      try {
        resolved = await store.resolveInvocation({
          instanceId: record.instanceId,
          elementId: record.elementId,
          executionId: record.executionId,
        }, {
          action: input.action,
          evidence: input.evidence,
          operator: input.operator,
          result: input.result,
        })
      } catch (error) {
        if (error?.code === 'HTTP_RESOLVE_INVALID') {
          return { status: 400, body: { ok: false, code: error.code, error: error.message, id: instanceId } }
        }
        if (error?.code === 'HTTP_RESOLVE_CONFLICT') {
          return { status: 409, body: { ok: false, code: error.code, error: error.message, id: instanceId } }
        }
        if (error?.code === 'HTTP_INVOCATION_NOT_FOUND') {
          return { status: 404, body: { ok: false, code: error.code, error: error.message, id: instanceId } }
        }
        throw error
      }
      // clear-tombstone 的实例侧动作：只删墓碑快照；不创建 runner、不落事件、不重放。
      // 放在记录处置之后（evidence / 动作非法时 store 已经先报错，不会误清墓碑）。
      const tombstoneCleared = action === 'clear-tombstone'
        ? await this._clearUnrecoverableTombstone(instanceId)
        : false
      const current = await readInstance(instanceId, { instancesRoot: this.instancesRoot }) ?? instance
      const audit = resolved.audit
      return {
        status: 200,
        body: {
          ok: true,
          id: instanceId,
          status: current.status,
          ...(action === 'clear-tombstone' ? { tombstoneCleared } : {}),
          executionId: record.executionId,
          invocationId: typeof record.invocationId === 'string' ? record.invocationId : null,
          engineExecutionId: typeof record.engineExecutionId === 'string' ? record.engineExecutionId : null,
          action: typeof input.action === 'string' ? input.action.trim().toLowerCase() : null,
          idempotent: resolved.idempotent === true,
          auditId: isPlainObject(audit) && typeof audit.auditId === 'string' ? audit.auditId : null,
          record: resolved.record,
          lastSeq: current.lastSeq,
          pendingTasks: current.pendingTasks ?? [],
          lastError: current.lastError ?? null,
          note: action === 'clear-tombstone'
            ? 'clear-tombstone 只删除不可恢复墓碑快照并追加审计，不重放引擎活动、不伪造 activity/end、不改 instance.json；'
              + '清除后实例没有可恢复的引擎快照，仍不能自动继续，需要人工决定是否新建实例。'
            : '处置只更新 connector 调用记录与审计，不重放引擎活动、不伪造 activity/end；实例状态保持现状。',
        },
      }
    })
  }

  /**
   * 清除失败实例的「不可恢复墓碑」（m1）。
   *
   * 墓碑是 `state.json` 里 `{ unrecoverable }` 标记（`engine` 已被丢弃）。这里只做
   * 一件事：确认它确实是墓碑后删除这份快照。**不创建 runner、不恢复引擎、不重放
   * 任何前序活动 / 副作用**；实例状态、lastError、事件流都保持原样。
   *
   * 删除后 `_ensureRunner` 会报 `BPMN_STATE_MISSING`（仍不能继续），而不是
   * `BPMN_STATE_UNRECOVERABLE`；是否新建实例由人工决定。
   *
   * @returns {Promise<boolean>} 是否真的删除了墓碑（重复处置返回 false）。
   */
  async _clearUnrecoverableTombstone(instanceId) {
    let state
    try {
      state = await readInstanceState(instanceId, { instancesRoot: this.instancesRoot })
    } catch (error) {
      throw new BpmnRuntimeError(
        500,
        'BPMN_STATE_READ_FAILED',
        `读取实例 ${instanceId} 的 state.json 失败：${errorText(error)}`,
        { instanceId },
      )
    }
    if (!isPlainObject(state?.unrecoverable)) return false
    try {
      await rm(join(this.instancesRoot, instanceId, 'state.json'), { force: true })
      // 人工处置同时解除「执行失败」恢复禁止标记：墓碑都没了，实例应回到
      // 「没有可恢复快照」的 BPMN_STATE_MISSING，而不是继续报旧失败码。
      await updateInstance(instanceId, { executionFailure: null }, { instancesRoot: this.instancesRoot })
    } catch (error) {
      throw new BpmnRuntimeError(
        500,
        'BPMN_STATE_WRITE_FAILED',
        `删除实例 ${instanceId} 的不可恢复墓碑失败：${errorText(error)}`,
        { instanceId },
      )
    }
    return true
  }

  async _listInstances(url) {
    const definitionId = url.searchParams.get('definitionId')
    const status = url.searchParams.get('status')
    const limitRaw = url.searchParams.get('limit')
    const filter = { instancesRoot: this.instancesRoot }
    if (definitionId !== null && definitionId !== '') filter.definitionId = definitionId
    if (status !== null && status !== '') filter.status = status
    if (limitRaw !== null && limitRaw !== '') {
      if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) {
        return { status: 400, body: { ok: false, code: 'BPMN_LIMIT_INVALID', error: 'limit 必须是正整数' } }
      }
      filter.limit = Math.min(Number(limitRaw), 1000)
    }
    const instances = await listInstances(filter)
    return {
      status: 200,
      body: {
        ok: true,
        instances: instances.map(instance => ({
          ...instance,
          active: this._runners.has(instance.id),
        })),
        skipped: Array.isArray(instances.skipped) ? instances.skipped : [],
      },
    }
  }

  async _createInstance(body) {
    if (!isPlainObject(body)) {
      return {
        status: 400,
        body: { ok: false, code: 'BPMN_BODY_INVALID', error: '请求体必须是 JSON 对象：{ definitionId, definitionVersion?, variables?, workspace? }' },
      }
    }
    const definitionId = checkRunId(body.definitionId)
    if (!definitionId) {
      return { status: 400, body: { ok: false, code: 'INSTANCE_INVALID_ID', error: 'definitionId 非法' } }
    }
    if (body.variables !== undefined && body.variables !== null && !isPlainObject(body.variables)) {
      return { status: 400, body: { ok: false, code: 'BPMN_VARIABLES_INVALID', error: 'variables 必须是 JSON 对象' } }
    }
    // E3：工具面把调用方会话记进 startedBy（只存定位用的短字符串；GUI 不传时是 null）。
    let startedBy = null
    if (body.startedBy !== undefined && body.startedBy !== null) {
      if (typeof body.startedBy !== 'string') {
        return { status: 400, body: { ok: false, code: 'BPMN_STARTED_BY_INVALID', error: 'startedBy 必须是字符串或 null' } }
      }
      startedBy = body.startedBy.trim()
      if (startedBy === '') startedBy = null
      if (startedBy !== null && (startedBy.length > 200 || /[\u0000-\u001f\u007f]/.test(startedBy))) {
        return {
          status: 400,
          body: { ok: false, code: 'BPMN_STARTED_BY_INVALID', error: 'startedBy 必须是不含控制字符的短字符串（≤200 字符）' },
        }
      }
    }
    let definitionVersion
    if (body.definitionVersion !== undefined && body.definitionVersion !== null) {
      const version = typeof body.definitionVersion === 'string' && /^\d+$/.test(body.definitionVersion)
        ? Number(body.definitionVersion)
        : body.definitionVersion
      if (!Number.isSafeInteger(version) || version < 1) {
        return { status: 400, body: { ok: false, code: 'BPMN_VERSION_INVALID', error: 'definitionVersion 必须是 ≥1 的整数' } }
      }
      definitionVersion = version
    }

    const parsedWorkspace = this._parseWorkspaceOption(body.workspace)
    if (parsedWorkspace.ok !== true) return parsedWorkspace.error
    const workspaceOption = parsedWorkspace.value

    // 工作区解析 / 前置条件在**实例创建之前**完成：模式 on 的非 Git 工作区直接 400，
    // 不留下一个已建但永远起不来的实例。
    let resolvedWorkspace = null
    if (workspaceOption !== null) {
      try {
        resolvedWorkspace = await resolveWorkspace({
          path: workspaceOption.path,
          allowlist: this.workspaceAllowlist,
          requireGit: false,
          ...(this.gitRunner === undefined ? {} : { runner: this.gitRunner }),
        })
      } catch (error) {
        return workspaceErrorResult(error)
      }
      if (workspaceOption.worktree.mode === 'on' && resolvedWorkspace.isGit !== true) {
        return {
          status: 400,
          body: {
            ok: false,
            code: WORKSPACE_ERROR.NOT_GIT,
            error: `工作区不是 Git 仓库根，无法按 worktree.mode="on" 建立实例 worktree：${resolvedWorkspace.realpath}`,
          },
        }
      }
    }

    const instance = await createInstance({
      definitionId,
      ...(definitionVersion === undefined ? {} : { definitionVersion }),
      variables: body.variables ?? {},
      startedBy,
      definitionsRoot: this.definitionsRoot,
      instancesRoot: this.instancesRoot,
    })

    // MAJOR-4 残余 + NEW-1：所有权必须**在准备之前**登记。
    //
    // 0.14.4 只用进程内 `_preparing` 计数挡同进程挂起；跨进程的 `suspend` 看不到它，
    // 于是「准备中」窗口能被打断（创建 409 NOT_ACTIVE、实例永远 STATE_MISSING）。
    // 方案：实例目录一建好就写 owner.json（`claimInstanceOwner` 走跨进程 flock 互斥），
    // 别的进程 `_suspendBusy` 看到活 owner → 409 kind:owner。准备失败 / 首次启动被拒
    // 时交还自己写的那份，绝不留下「占着所有权却不执行」的空壳。
    this._bumpPreparing(instance.id, 1)
    let keepOwner = false
    try {
      await this._claimOwner(instance.id)
      const result = await this._finishCreateInstance(instance, workspaceOption, resolvedWorkspace)
      keepOwner = result.status === 201
      return result
    } finally {
      this._bumpPreparing(instance.id, -1)
      if (!keepOwner) await this._releaseOwner(instance.id).catch(() => {})
    }
  }

  /** `_createInstance` 的准备 → 首次启动收口（执行期间 `_preparing` 计数非 0）。 */
  async _finishCreateInstance(instance, workspaceOption, resolvedWorkspace) {
    let workspaceRecord = null
    if (workspaceOption !== null) {
      const prepared = await this._prepareInstanceWorkspace(instance.id, workspaceOption, resolvedWorkspace)
      if (prepared.error !== null) {
        // 工作区建立失败：实例尚未启动，收成 CANCELED 并保留 lastError，避免 ACTIVE 卡死。
        await this._abortUnstartedInstance(instance.id, prepared.error)
        return {
          status: prepared.error.status,
          body: {
            ok: false,
            id: instance.id,
            definitionId: instance.definitionId,
            code: prepared.error.code,
            error: prepared.error.message,
          },
        }
      }
      workspaceRecord = prepared.workspace
    }

    try {
      const started = await this._withInstance(instance.id, () => this._startInstance(instance.id))
      return {
        status: 201,
        body: {
          ok: true,
          id: started.instance.id,
          status: started.instance.status,
          pendingTasks: started.instance.pendingTasks,
          lastSeq: started.instance.lastSeq,
          definitionId: started.instance.definitionId,
          definitionVersion: started.instance.definitionVersion,
          definitionHash: started.instance.definitionHash,
          startedBy: started.instance.startedBy ?? null,
          ...(workspaceRecord === null ? {} : { workspace: this._publicWorkspaceView(workspaceRecord) }),
          recovered: false,
          ...(started.error === null ? {} : { error: { code: started.error.code, message: started.error.message } }),
        },
      }
    } catch (error) {
      // 实例已经建出来了：把可定位的信息带回给调用方，而不是只给一句 500。
      const result = errorResult(error)
      return {
        status: result.status,
        body: { ...result.body, id: instance.id, definitionId: instance.definitionId },
      }
    }
  }

  /**
   * 解析 `POST /instances` 的 `workspace` 选项（缺省 null = 旧行为，不建 worktree）。
   * 默认 `mode:"auto"`（非 Git 回退原目录）、`cleanup:"retain"`、`baseRef:"HEAD"`。
   */
  _parseWorkspaceOption(raw) {
    if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
    if (!isPlainObject(raw)) {
      return {
        ok: false,
        error: { status: 400, body: { ok: false, code: 'BPMN_WORKSPACE_INVALID', error: 'workspace 必须是 JSON 对象：{ path, worktree? }' } },
      }
    }
    if (typeof raw.path !== 'string' || raw.path.trim() === '' || raw.path.length > 4096) {
      return {
        ok: false,
        error: { status: 400, body: { ok: false, code: 'BPMN_WORKSPACE_INVALID', error: 'workspace.path 必须是非空字符串（≤4096）' } },
      }
    }
    const rawWorktree = raw.worktree
    if (rawWorktree !== undefined && rawWorktree !== null && !isPlainObject(rawWorktree)) {
      return {
        ok: false,
        error: { status: 400, body: { ok: false, code: 'BPMN_WORKSPACE_INVALID', error: 'workspace.worktree 必须是 JSON 对象' } },
      }
    }
    const worktree = isPlainObject(rawWorktree) ? rawWorktree : {}
    const mode = worktree.mode === undefined || worktree.mode === null ? 'auto' : worktree.mode
    if (mode !== 'auto' && mode !== 'on' && mode !== 'off') {
      return {
        ok: false,
        error: { status: 400, body: { ok: false, code: 'BPMN_WORKSPACE_INVALID', error: 'workspace.worktree.mode 只允许 auto / on / off' } },
      }
    }
    const cleanup = worktree.cleanup === undefined || worktree.cleanup === null ? 'retain' : worktree.cleanup
    if (typeof cleanup !== 'string' || !CLEANUP_POLICY_SET.has(cleanup)) {
      return {
        ok: false,
        error: { status: 400, body: { ok: false, code: 'BPMN_WORKSPACE_INVALID', error: 'workspace.worktree.cleanup 只允许 retain / on-terminal-clean' } },
      }
    }
    const baseRef = worktree.baseRef === undefined || worktree.baseRef === null ? 'HEAD' : worktree.baseRef
    if (typeof baseRef !== 'string' || baseRef.trim() === '' || baseRef !== baseRef.trim()
      || baseRef.length > 200 || baseRef.startsWith('-') || /\s/.test(baseRef)) {
      return {
        ok: false,
        error: { status: 400, body: { ok: false, code: 'BPMN_WORKSPACE_INVALID', error: 'workspace.worktree.baseRef 非法' } },
      }
    }
    return { ok: true, value: { path: raw.path.trim(), worktree: { mode, baseRef, cleanup } } }
  }

  /** 建立实例工作区（worktree 或原目录回退），写冻结快照 / 所有权记录 / 资源事件。 */
  async _prepareInstanceWorkspace(instanceId, option, resolved) {
    let worktreeRecord = null
    let mode = 'off'
    if (option.worktree.mode !== 'off' && resolved.isGit === true) {
      try {
        worktreeRecord = await createInstanceWorktree({
          instanceId,
          workspace: resolved,
          baseRef: option.worktree.baseRef,
          cleanupPolicy: option.worktree.cleanup,
          worktreeRoot: this.worktreeRoot,
          ...(this.gitRunner === undefined ? {} : { runner: this.gitRunner }),
        })
      } catch (error) {
        return { workspace: null, error: workspaceErrorObject(error) }
      }
      mode = 'worktree'
    }
    const workspace = {
      v: 1,
      instanceId,
      workspaceId: resolved.workspaceId,
      mode,
      path: resolved.path,
      realpath: resolved.realpath,
      repositoryRoot: resolved.repositoryRoot,
      effectiveRoot: worktreeRecord === null ? resolved.realpath : worktreeRecord.effectiveRoot,
      isGit: resolved.isGit === true,
      isLinkedWorktree: resolved.isLinkedWorktree === true,
      cleanupPolicy: option.worktree.cleanup,
      worktree: worktreeRecord,
      createdAt: new Date().toISOString(),
    }
    try {
      await writeWorkspaceSnapshot({ instancesRoot: this.instancesRoot, instanceId, snapshot: workspace })
      if (worktreeRecord !== null) {
        await writeResourceRecord({ registryRoot: this.worktreeRegistryRoot, record: worktreeRecord })
        await appendResourceEvent({
          instancesRoot: this.instancesRoot,
          instanceId,
          event: {
            type: RESOURCE_EVENT.WORKTREE_READY,
            workspaceId: worktreeRecord.workspaceId,
            branch: worktreeRecord.branch,
            baseCommit: worktreeRecord.baseCommit,
            cleanupPolicy: worktreeRecord.cleanupPolicy,
          },
        })
      }
    } catch (error) {
      // 记录写不进去就不能假装工作区已就绪：回滚走**创建事务所有权证据**，
      // 不用普通 remove（后者可能发仓库级 prune，review-0139 F1）。
      if (worktreeRecord !== null) {
        try {
          await rollbackCreatedWorktree({
            record: worktreeRecord,
            worktreeRoot: this.worktreeRoot,
            ...(this.gitRunner === undefined ? {} : { runner: this.gitRunner }),
          })
        } catch {
          // 回滚失败保留原错误；树的位置在错误信息里可查。
        }
      }
      return { workspace: null, error: workspaceErrorObject(error) }
    }
    this._workspaces.set(instanceId, { workspace, error: null })
    return { workspace, error: null }
  }

  /** 公开响应里的工作区投影（不把 artifact / 记录内部字段整份吐出）。 */
  _publicWorkspaceView(workspace) {
    return {
      mode: workspace.mode,
      workspaceId: workspace.workspaceId,
      effectiveRoot: workspace.effectiveRoot,
      repositoryRoot: workspace.repositoryRoot,
      isGit: workspace.isGit === true,
      isLinkedWorktree: workspace.isLinkedWorktree === true,
      cleanupPolicy: workspace.cleanupPolicy,
      worktree: workspace.worktree === null || workspace.worktree === undefined
        ? null
        : {
          branch: workspace.worktree.branch,
          baseCommit: workspace.worktree.baseCommit,
          cleanupPolicy: workspace.worktree.cleanupPolicy,
          resourceState: workspace.worktree.resourceState,
        },
    }
  }

  /** 工作区建立失败时把还没启动的实例收成 CANCELED（lastError 保留原因）。 */
  async _abortUnstartedInstance(instanceId, error) {
    try {
      await this._markInstanceError(instanceId, { code: error.code, message: error.message })
      await completeInstance(instanceId, 'CANCELED', { instancesRoot: this.instancesRoot })
    } catch {
      // 实例可能已被别的请求处理；不改变返回给调用方的原始错误。
    }
    this._workspaces.delete(instanceId)
  }

  /** `_preparing` 计数（>0 = 该实例处于首次创建 / 准备窗口）。 */
  _bumpPreparing(instanceId, delta) {
    const next = (this._preparing.get(instanceId) ?? 0) + delta
    if (next > 0) this._preparing.set(instanceId, next)
    else this._preparing.delete(instanceId)
  }

  /** `_pendingEventCommits` 计数（>0 = 还有事件在排队 / 在写盘）。 */
  _bumpPendingEventCommits(instanceId, delta) {
    const next = (this._pendingEventCommits.get(instanceId) ?? 0) + delta
    if (next > 0) this._pendingEventCommits.set(instanceId, next)
    else this._pendingEventCommits.delete(instanceId)
  }

  /**
   * 登记本 runtime 的执行所有权（写 `owner.json`）。
   *
   * NEW-1：`claimInstanceOwner` 现在在跨进程 flock 临界区里判定并写入；拿不到
   * （别的活进程持有 / 记录无法确认）就抛 409 业务码。调用方必须在恢复、signal、
   * adapter 派发**之前**处理这个错误——「先读一遍再写」不算互斥。
   */
  async _claimOwner(instanceId) {
    let claimed
    try {
      claimed = await claimInstanceOwner(instanceId, {
        instancesRoot: this.instancesRoot,
        owner: selfOwner(this.runtimeId),
      })
    } catch (error) {
      if (error?.code === 'INSTANCE_OWNED_ELSEWHERE') {
        throw new BpmnRuntimeError(
          409,
          'BPMN_INSTANCE_ACTIVE_ELSEWHERE',
          `实例 ${instanceId} 的执行所有权被另一个活进程持有（pid ${error.owner?.pid ?? '?'} @ ${error.owner?.host ?? '?'}），本次不恢复、不派发`,
          { instanceId, owner: error.owner ?? null },
        )
      }
      if (error?.code === 'INSTANCE_OWNER_UNKNOWN') {
        throw new BpmnRuntimeError(
          409,
          'BPMN_OWNER_UNKNOWN',
          `实例 ${instanceId} 的执行所有权记录无法确认（坏 JSON / 跨主机）：为安全起见不恢复、不派发；请人工核对 owner.json`,
          { instanceId, owner: error.owner ?? null },
        )
      }
      throw error
    }
    this._ownedInstances.add(instanceId)
    return claimed
  }

  /** 只释放自己写的所有权（runtimeId 不匹配不动别人的记录）。 */
  async _releaseOwner(instanceId) {
    if (!this._ownedInstances.has(instanceId)) return false
    this._ownedInstances.delete(instanceId)
    try {
      return await releaseInstanceOwner(instanceId, {
        instancesRoot: this.instancesRoot,
        runtimeId: this.runtimeId,
      })
    } catch {
      return false
    }
  }

  /**
   * 恢复 / 准备没有产出可用 runner 时交还所有权。
   *
   * 只做过准备的进程不能继续占着实例：owner 活着时别的进程既不能执行也不能挂起
   * （`_suspendBusy` 409），会变成事实上的死锁。仍留有 runner 的路径不释放。
   */
  async _releaseOwnerIfIdle(instanceId) {
    if (this._runners.has(instanceId)) return false
    return await this._releaseOwner(instanceId)
  }

  /**
   * 把内存 runner 从缓存里摘掉并停掉：磁盘才是权威事实。
   *
   * 用于「已确认失败」（`executionFailure` 落盘）与「准备完成但准入被拒」——这些
   * runner 不能再被当成与磁盘一致的缓存（复审 NEW-3 / MAJOR-1 残余）。
   */
  async _dropRunner(instanceId) {
    const runner = this._runners.get(instanceId)
    if (runner === undefined) return false
    this._runners.delete(instanceId)
    this._suppressWait.delete(instanceId)
    try {
      await runner.stop()
    } catch {
      // 释放路径不抛：磁盘上的 state 仍可被新进程恢复。
    }
    return true
  }

  /**
   * owner 是否属于**另一个进程**。
   *
   * 同进程内可能有多个 runtime（测试 / 嵌入方）；那不是「另一个执行进程」，
   * 由 runner 自己的进程内活跃表兜底（`BPMN_INSTANCE_ID_CONFLICT`）。真正的跨进程
   * 互斥仍由 pid + bootId + starttime 判定。
   */
  _isForeignOwner(ownerInfo) {
    if (ownerInfo === null || ownerInfo.state === 'gone') return false
    const owner = isPlainObject(ownerInfo.owner) ? ownerInfo.owner : null
    if (owner !== null && owner.pid === process.pid && ownerInfo.state === 'alive') return false
    return true
  }

  /** 记一条被丢弃的迟到事件诊断（有界：每实例最近 20 条）。 */
  _recordEventDiagnostic(instanceId, entry) {
    const list = this._eventDiagnostics.get(instanceId) ?? []
    list.push({ at: new Date().toISOString(), ...entry })
    while (list.length > 20) list.shift()
    this._eventDiagnostics.set(instanceId, list)
  }

  /**
   * 读实例定义快照。抽成方法是为了让测试能暂停「异步准备」这一段，
   * 复现 stop 与启动/恢复的竞态（review-0131 #1）；生产路径就是 store 的直读。
   *
   * @param {string} instanceId
   * @returns {Promise<object|null>}
   */
  async _readDefinitionSnapshot(instanceId) {
    return await readInstanceDefinition(instanceId, { instancesRoot: this.instancesRoot })
  }

  /**
   * 启动 / 恢复共用的同步复查：异步准备（读快照 / 解析 XML）期间 stop 可能已经
   * 置了停止闩并把实例收成 CANCELED。此时**不能再创建/登记 runner**——否则 stop
   * 已经返回 CANCELED 之后仍会派发新的 agent（review-0131 #1）。
   *
   * 只做同步判位；命中后由调用方异步读一次实例状态再返回。
   *
   * @param {string} instanceId
   * @returns {{code: string, message: string, reason: string}|null}
   */
  _latchBlockForPrepare(instanceId) {
    if (this._disposed) {
      return {
        code: 'BPMN_RUNTIME_DISPOSED',
        reason: 'BPMN 运行时已释放，未创建执行器、未派发节点',
        message: `实例 ${instanceId} 的启动/恢复准备期间 runtime 已被 dispose：不创建执行器、不派发节点`,
      }
    }
    if (this._stopping.has(instanceId)) {
      return {
        code: 'BPMN_INSTANCE_STOPPING',
        reason: '实例在启动/恢复准备期间被停止（stop 已置停止闩），未创建执行器、未派发节点',
        message: `实例 ${instanceId} 在启动/恢复准备期间被停止（stop 已置停止闩）：不创建执行器、不派发节点`,
      }
    }
    return null
  }

  /** 建实例后启动；失败不抛 handler 错，收成 `{instance, error}`（status 仍 ACTIVE + lastError）。 */
  async _startInstance(instanceId) {
    const instance = await readInstance(instanceId, { instancesRoot: this.instancesRoot })
    if (instance === null) {
      throw new BpmnRuntimeError(404, 'INSTANCE_NOT_FOUND', `实例 ${instanceId} 不存在`)
    }
    if (instance.status !== 'ACTIVE') {
      throw new BpmnRuntimeError(409, 'INSTANCE_NOT_ACTIVE', `实例 ${instanceId} 当前状态是 ${instance.status}，不能重新启动`)
    }
    const snapshot = await this._readDefinitionSnapshot(instanceId)
    // stop 可能在快照读取期间就返回了；不等解析完就先挡一次（终态实例上任何解析错误都没意义）。
    const stoppedAfterRead = this._latchBlockForPrepare(instanceId)
    if (stoppedAfterRead !== null) {
      const current = await readInstance(instanceId, { instancesRoot: this.instancesRoot }) ?? instance
      return { instance: current, error: { code: stoppedAfterRead.code, message: stoppedAfterRead.message } }
    }
    if (snapshot === null) {
      throw new BpmnRuntimeError(500, 'INSTANCE_SNAPSHOT_MISSING', `实例 ${instanceId} 的定义快照缺失`)
    }
    const parsed = await parseBpmn(snapshot.xml)
    // 解析也是异步的：这里到 runner 创建之间**没有 await**，复查必须同步完成。
    const stoppedAfterParse = this._latchBlockForPrepare(instanceId)
    if (stoppedAfterParse !== null) {
      const current = await readInstance(instanceId, { instancesRoot: this.instancesRoot }) ?? instance
      return { instance: current, error: { code: stoppedAfterParse.code, message: stoppedAfterParse.message } }
    }
    if (!parsed.ok) {
      // 定义快照不可执行：实例 status 不动（ACTIVE），只留 lastError。
      await this._markInstanceError(instanceId, {
        code: 'BPMN_DEFINITION_INVALID',
        message: '实例定义快照未通过 BPMN 校验，无法启动',
        nodeId: parsed.errors?.[0]?.elementId ?? null,
      })
      throw new BpmnRuntimeError(400, 'BPMN_DEFINITION_INVALID', '实例定义快照未通过 BPMN 校验，无法启动', {
        errors: parsed.errors,
      })
    }

    // 新实例不应有别的活进程持有执行；有就说明同一个 id 被两个进程同时启动（配置错误）。
    const createdOwner = await readInstanceOwner(instanceId, { instancesRoot: this.instancesRoot })
    if (createdOwner !== null && createdOwner.state === 'alive'
      && createdOwner.owner?.runtimeId !== this.runtimeId) {
      throw new BpmnRuntimeError(
        409,
        'BPMN_INSTANCE_ACTIVE_ELSEWHERE',
        `实例 ${instanceId} 的执行所有权被另一个进程（pid ${createdOwner.owner?.pid ?? '?'} @ ${createdOwner.owner?.host ?? '?'}）持有，拒绝重复启动`,
        { instanceId, owner: createdOwner.owner },
      )
    }
    const runner = this._newRunner(parsed.definition, snapshot.xml, instanceId, instance.variables, {
      definitionId: instance.definitionId,
      definitionVersion: instance.definitionVersion,
    })
    this._runners.set(instanceId, runner)
    try {
      if (createdOwner?.state !== 'alive') await this._claimOwner(instanceId)
    } catch (error) {
      this._runners.delete(instanceId)
      await runner.stop().catch(() => {})
      throw error
    }
    let startError = null
    try {
      await runner.start()
    } catch (error) {
      startError = error
    }
    await this._afterSettle(instanceId, runner)
    const after = await readInstance(instanceId, { instancesRoot: this.instancesRoot })
    if (after === null) {
      throw new BpmnRuntimeError(500, 'INSTANCE_VANISHED', `实例 ${instanceId} 在启动过程中消失`)
    }
    // handler 失败 / 条件错误 / 启动前校验失败：实例 status 保持 ACTIVE，
    // 只把事实写进 lastError（要不要重试由人/业务决定）。
    if (startError !== null) {
      if (!TERMINAL_STATUSES.has(after.status)) {
        await this._markInstanceError(instanceId, this._lastErrorFor(instanceId, startError))
      }
      const current = await readInstance(instanceId, { instancesRoot: this.instancesRoot }) ?? after
      return {
        instance: current,
        error: {
          // handler 失败时 runner 用包装码 BPMN_HANDLER_FAILED，真正的业务码在 cause 里：
          // 创建响应必须和落盘的 instance.lastError.code 同一口径（否则调用方看到两个码）。
          code: (typeof startError?.cause?.code === 'string' && startError.cause.code !== '')
            ? startError.cause.code
            : (startError.code ?? 'BPMN_ENGINE_ERROR'),
          message: startError.message,
        },
      }
    }
    return { instance: after, error: null }
  }

  async _readInstance(id) {
    return await this._withInstance(id, async () => {
      const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
      if (instance === null) return instanceNotFound(id)
      const ensured = await this._ensureRunner(instance)
      const current = await readInstance(id, { instancesRoot: this.instancesRoot }) ?? instance
      const pendingTasks = ensured.runner !== null
        ? ensured.runner.pendingTasks()
        : (current.pendingTasks ?? [])
      return {
        status: 200,
        body: {
          ok: true,
          id: current.id,
          definitionId: current.definitionId,
          definitionVersion: current.definitionVersion,
          definitionHash: current.definitionHash,
          status: current.status,
          variables: current.variables,
          result: current.result,
          artifacts: Array.isArray(current.artifacts) ? current.artifacts : [],
          lastError: current.lastError ?? null,
          pendingTasks,
          lastSeq: current.lastSeq,
          eventCount: current.eventCount,
          revision: current.revision,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
          completedAt: current.completedAt,
          startedBy: current.startedBy ?? null,
          runnerStatus: ensured.runner === null ? null : ensured.runner.status(),
          recovered: ensured.recovered,
          ...(ensured.reason ? { recovery: { reason: ensured.reason, code: ensured.code ?? null } } : {}),
        },
      }
    })
  }

  async _readEvents(id, url) {
    // MINOR-1：游标只到**实际可见事件**的最大 seq，不拿 instance.lastSeq（已分配水位）
    // 冒充可消费水位；分配了但事件行还没落盘时显式给出 eventLogGap。
    const snapshot = await readInstanceSnapshot(id, { instancesRoot: this.instancesRoot })
    if (snapshot === null) return instanceNotFound(id)
    const events = snapshot.events
    const sinceRaw = url.searchParams.get('since')
    let filtered = events ?? []
    if (sinceRaw !== null && sinceRaw !== '') {
      if (!/^\d+$/.test(sinceRaw)) {
        return { status: 400, body: { ok: false, code: 'BPMN_SEQ_INVALID', error: 'since 必须是非负整数' } }
      }
      const since = Number(sinceRaw)
      filtered = filtered.filter(event => Number.isSafeInteger(event.seq) && event.seq > since)
    }
    return {
      status: 200,
      body: {
        ok: true,
        id,
        events: filtered,
        lastSeq: snapshot.lastSeq,
        ...(snapshot.gap === null ? {} : { eventLogGap: snapshot.gap }),
        skipped: snapshot.skipped,
        shards: snapshot.shards,
        eventsHash: snapshot.eventsHash,
      },
    }
  }

  /**
   * `GET /instances/<id>/metrics[?asOf=ISO]`：单实例运行指标（纯读）。
   *
   * - 不调用 `_ensureRunner()`：查看指标不会恢复/推进实例；
   * - 事件侧归约按 `lastSeq + revision + schemaVersion`（+ connector / 资源指纹）缓存，
   *   事件或实例事实一变即重算；`asOf` 只参与最终投影，所以「没有新事件时人工等待
   *   仍按 asOf 增长」不会被缓存冻结；
   * - `asOf` 可显式传，便于离线纯函数复算与 API 逐字段对账。
   *
   * @param {string} id
   * @param {URL} url
   * @returns {Promise<{status:number, body:object}>}
   */
  async _readInstanceMetrics(id, url) {
    const asOf = this._metricsAsOf(url)
    if (asOf.error !== null) return { status: 400, body: { ok: false, code: 'METRICS_AS_OF_INVALID', error: asOf.error } }
    const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
    if (instance === null) return instanceNotFound(id)
    const reduction = await this._metricsReductionFor(instance)
    return { status: 200, body: finalizeInstanceMetrics(reduction, asOf.value) }
  }

  /** `?asOf=`（可选）：非法时间 400，不静默回落到 now。 */
  _metricsAsOf(url, param = 'asOf') {
    const raw = url?.searchParams?.get(param)
    if (raw === null || raw === undefined || raw === '') {
      return { value: new Date().toISOString(), error: null }
    }
    const ms = parseTimeMs(raw)
    if (ms === null) return { value: null, error: `${param} 必须是可解析的 ISO 时间（收到 ${JSON.stringify(raw)}）` }
    return { value: new Date(ms).toISOString(), error: null }
  }

  /**
   * `GET /instances/<id>/evidence[?asOf=ISO]`：实例业务证据（0.13.12 E2，纯读）。
   *
   * 证据报告由 `flow_finish_node.documents[]` 以 `kind:"evidence-report"` 登记；
   * 报告正文在文件里，`instance.json.artifacts[]` 只存引用。本接口：
   *
   *   - **不调用 `_ensureRunner()`**，不因查看证据恢复 / 推进实例；
   *   - 引用解析优先命中 `artifacts/<sha256>` 快照（worktree 清理后仍可读），
   *     快照缺失才回落到工作区，并在 `dataQuality.reasons` 标 `workspace-fallback`；
   *   - 只返回 claims / findings / 引用核对结果，不产出任何总评级，也不把
   *     findings 写进实例状态或 admission。
   *
   * 两段读取：第一段只读报告正文与报告自身快照；解析出报告内部引用后，再按
   * `sha256` 去 `artifacts` 索引读快照、按相对路径补读工作区，最后复算一次。
   *
   * @param {string} id
   * @param {URL} url
   * @returns {Promise<{status:number, body:object}>}
   */
  async _readInstanceEvidence(id, url) {
    const asOf = this._metricsAsOf(url)
    if (asOf.error !== null) {
      return { status: 400, body: { ok: false, code: 'EVIDENCE_AS_OF_INVALID', error: asOf.error } }
    }
    const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
    if (instance === null) return instanceNotFound(id)
    let events = []
    let skippedEvents = 0
    try {
      const loaded = await readInstanceEvents(id, { instancesRoot: this.instancesRoot })
      events = loaded ?? []
      skippedEvents = Number.isInteger(loaded?.skipped) ? loaded.skipped : 0
    } catch {
      // 事件流损坏不影响证据报告本身；dataQuality 会从 missing / reasons 暴露缺口。
      events = []
    }
    const documents = Array.isArray(instance.artifacts) ? instance.artifacts : []
    const workspaceRoot = await this._evidenceWorkspaceRoot(id)
    const reportDocs = documents.filter(doc => (
      isPlainObject(doc)
      && typeof doc.kind === 'string'
      && doc.kind.trim().toLowerCase() === EVIDENCE_REPORT_KIND
    ))
    const snapshots = new Map()
    const workspaceFiles = new Map()
    await this._loadEvidenceSnapshots(reportDocs, snapshots)
    // 报告自身没有快照时，优先从原工作区读一次（随后 refs 仍按快照优先）。
    for (const doc of reportDocs) {
      const sha = normalizeEvidenceHash(doc.sha256)
      if (sha === null || snapshots.has(sha)) continue
      const content = await this._readEvidenceWorkspaceFile(workspaceRoot, doc.path)
      if (content !== null) workspaceFiles.set(doc.path, content)
    }
    const collect = () => collectInstanceEvidence({
      instance,
      events,
      documents,
      snapshots,
      workspaceFiles,
      workspaceAvailable: workspaceRoot !== null,
      asOf: asOf.value,
      skippedEvents,
    })
    let result = collect()
    // 第二段：报告里引用的文件如果登记过 artifact，按 sha 读快照；否则回落到工作区。
    const wantedHashes = new Set()
    const wantedPaths = new Set()
    for (const item of [...result.claims, ...result.findings]) {
      for (const ref of Array.isArray(item.refs) ? item.refs : []) {
        const sha = normalizeEvidenceHash(ref.sha256)
        // 即使第一段已从工作区核对通过，只要该 hash 有登记产物，也把快照读进来：
        // 下一段会优先命中 artifact 快照，不让「恰好也读得到的工作区」掩盖快照来源。
        if (sha !== null && documents.some(doc => normalizeEvidenceHash(doc.sha256) === sha)) wantedHashes.add(sha)
        if (ref.verified !== true && isSafeEvidencePath(ref.path)) wantedPaths.add(ref.path)
      }
    }
    for (const item of result.missing) {
      if (item.kind !== 'ref' || item.reason !== EVIDENCE_REASON.WORKSPACE_UNREADABLE) continue
      if (isSafeEvidencePath(item.path)) wantedPaths.add(item.path)
    }
    let changed = false
    for (const sha of wantedHashes) {
      if (snapshots.has(sha)) continue
      try {
        const content = await this.artifactStore.read(sha)
        snapshots.set(sha, content)
        changed = true
      } catch {
        // 快照缺失 / 损坏：保持缺失，交给工作区回落与 dataQuality。
      }
    }
    for (const relPath of wantedPaths) {
      if (workspaceFiles.has(relPath)) continue
      const content = await this._readEvidenceWorkspaceFile(workspaceRoot, relPath)
      if (content !== null) {
        workspaceFiles.set(relPath, content)
        changed = true
      }
    }
    if (changed) result = collect()
    return { status: 200, body: { ok: true, ...result } }
  }

  /** 证据回落用的工作区根：冻结快照优先；快照缺失才退回宿主默认工作区。 */
  async _evidenceWorkspaceRoot(instanceId) {
    try {
      const snapshot = await readWorkspaceSnapshot({ instancesRoot: this.instancesRoot, instanceId })
      if (snapshot === null) return this.workspaceRoot
      if (typeof snapshot.effectiveRoot === 'string' && isAbsolute(snapshot.effectiveRoot)) {
        return snapshot.effectiveRoot
      }
      return null
    } catch {
      // 快照损坏：不猜路径（宁可让引用落在 missing，也不读错工作区）。
      return null
    }
  }

  /** 只读已登记文档的 artifact 快照；不存在 / 损坏都跳过，不升级成 500。 */
  async _loadEvidenceSnapshots(documents, snapshots) {
    for (const doc of Array.isArray(documents) ? documents : []) {
      const sha = normalizeEvidenceHash(doc?.sha256)
      if (sha === null || snapshots.has(sha)) continue
      try {
        snapshots.set(sha, await this.artifactStore.read(sha))
      } catch {
        // 缺失由 collectInstanceEvidence 计入 dataQuality / missing。
      }
    }
  }

  /**
   * 安全读一个工作区相对路径（证据回落专用）：拒绝符号链接 / 非普通文件 /
   * 越过工作区 / 超过 5 MiB。worktree 被清理后返回 null，由快照继续兜底。
   */
  async _readEvidenceWorkspaceFile(workspaceRoot, relPath) {
    if (typeof workspaceRoot !== 'string' || workspaceRoot === '') return null
    if (!isSafeEvidencePath(relPath)) return null
    const base = resolve(workspaceRoot)
    const target = resolve(base, relPath)
    const rel = relative(base, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
    let info
    try {
      info = await lstat(target)
    } catch {
      return null
    }
    if (info.isSymbolicLink() || !info.isFile()) return null
    if (info.size > DEFAULT_ARTIFACT_MAX_BYTES) return null
    let realBase
    let realTarget
    try {
      realBase = await realpath(base)
      realTarget = await realpath(target)
    } catch {
      return null
    }
    const realRel = relative(realBase, realTarget)
    if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) return null
    try {
      const content = await readFile(realTarget)
      if (content.length > DEFAULT_ARTIFACT_MAX_BYTES) return null
      return content
    } catch {
      return null
    }
  }

  /**
   * 读一个实例的全部指标输入并做事件侧归约。connector 目录不存在时返回空记录。
   */
  async _metricsReductionFor(instance) {
    const events = await readInstanceEvents(instance.id, { instancesRoot: this.instancesRoot })
    const list = events ?? []
    let connectorRecords = []
    try {
      const store = createConnectorStore({ root: join(this.instancesRoot, instance.id, 'connector') })
      connectorRecords = await store.listInvocations(instance.id)
    } catch {
      // connector 目录损坏 / 不存在：指标照算，dataQuality 会从事件侧暴露缺口。
      connectorRecords = []
    }
    let resources = { events: [], skipped: 0, resourceSeq: 0 }
    try {
      resources = await readResourceEvents({ instancesRoot: this.instancesRoot, instanceId: instance.id })
    } catch {
      resources = { events: [], skipped: 0, resourceSeq: 0 }
    }
    const fingerprint = metricsFingerprintFor(instance, {
      // 事件内容也进指纹（0.14.4）：只按 lastSeq/revision 会在「元数据已提交、事件正文
      // 随后补写」时命中事件尚不完整时算出的旧结果。list 本来就已读出来，不额外读盘。
      events: list,
      skippedEvents: events?.skipped ?? 0,
      connector: connectorFingerprint(connectorRecords),
      resources: Number.isInteger(resources.resourceSeq) ? resources.resourceSeq : 0,
    })
    const cached = this._metricsCache.get(fingerprint, () => reduceInstanceMetrics({
      instance,
      events: list,
      skippedEvents: events?.skipped ?? 0,
      connector: connectorRecords,
      resources,
      skippedResources: resources.skipped ?? 0,
    }))
    return cached.value
  }

  /**
   * `GET /metrics?definitionId=&definitionVersion=&from=&to=&status=&groupBy=day[&asOf=ISO]`
   *
   * 跨实例汇总：遍历 instances 目录下**全部**实例（不用 `listInstances()` 的默认
   * limit 分页，避免漏计），按实例 `createdAt` 选 cohort；延迟分位数由各实例的原始
   * 样本合并后重算，不平均各实例 p95。
   */
  async _handleMetrics(method, parts, url) {
    if (parts.length !== 1) {
      return { status: 404, body: { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口' } }
    }
    if (method !== 'GET') return methodNotAllowed('GET')
    const asOf = this._metricsAsOf(url)
    if (asOf.error !== null) return { status: 400, body: { ok: false, code: 'METRICS_AS_OF_INVALID', error: asOf.error } }
    const definitionId = url.searchParams.get('definitionId')
    if (definitionId !== null && definitionId !== '' && !checkRunId(definitionId)) {
      return { status: 400, body: { ok: false, code: 'METRICS_FILTER_INVALID', error: 'definitionId 非法' } }
    }
    const versionRaw = url.searchParams.get('definitionVersion')
    let definitionVersion = null
    if (versionRaw !== null && versionRaw !== '') {
      if (!/^\d+$/.test(versionRaw) || Number(versionRaw) < 1) {
        return { status: 400, body: { ok: false, code: 'METRICS_FILTER_INVALID', error: 'definitionVersion 必须是 ≥1 的整数' } }
      }
      definitionVersion = Number(versionRaw)
    }
    const statusRaw = url.searchParams.get('status')
    if (statusRaw !== null && statusRaw !== '' && !['ACTIVE', 'COMPLETED', 'SUSPENDED', 'CANCELED'].includes(statusRaw.toUpperCase())) {
      return { status: 400, body: { ok: false, code: 'METRICS_FILTER_INVALID', error: 'status 必须是 ACTIVE / COMPLETED / SUSPENDED / CANCELED 之一' } }
    }
    const fromRaw = url.searchParams.get('from')
    const toRaw = url.searchParams.get('to')
    for (const [name, raw] of [['from', fromRaw], ['to', toRaw]]) {
      if (raw !== null && raw !== '' && parseTimeMs(raw) === null) {
        return { status: 400, body: { ok: false, code: 'METRICS_FILTER_INVALID', error: `${name} 必须是可解析的 ISO 时间` } }
      }
    }
    const groupBy = url.searchParams.get('groupBy')
    if (groupBy !== null && groupBy !== '' && groupBy !== 'day') {
      return { status: 400, body: { ok: false, code: 'METRICS_FILTER_INVALID', error: "groupBy 只支持 'day'" } }
    }

    const entries = []
    let skippedInstances = 0
    for (const instanceId of await this._allInstanceIds()) {
      let instance
      try {
        instance = await readInstance(instanceId, { instancesRoot: this.instancesRoot })
      } catch {
        skippedInstances += 1
        continue
      }
      if (instance === null) {
        skippedInstances += 1
        continue
      }
      try {
        const reduction = await this._metricsReductionFor(instance)
        entries.push({ instance, metrics: finalizeInstanceMetrics(reduction, asOf.value) })
      } catch {
        skippedInstances += 1
      }
    }
    const body = aggregateInstanceMetrics({
      entries,
      ...(definitionId === null || definitionId === '' ? {} : { definitionId }),
      ...(definitionVersion === null ? {} : { definitionVersion }),
      ...(fromRaw === null || fromRaw === '' ? {} : { from: fromRaw }),
      ...(toRaw === null || toRaw === '' ? {} : { to: toRaw }),
      ...(statusRaw === null || statusRaw === '' ? {} : { status: statusRaw.toUpperCase() }),
      ...(groupBy === null || groupBy === '' ? {} : { groupBy }),
      generatedAt: asOf.value,
    })
    body.totals.dataQuality.skippedInstances += skippedInstances
    return { status: 200, body }
  }

  /** 实例目录下全部合法 id（含损坏实例；损坏的由调用方计入 skipped）。 */
  async _allInstanceIds() {
    let names = []
    try {
      names = await readdir(this.instancesRoot)
    } catch {
      return []
    }
    return names.filter(name => !name.startsWith('.') && checkRunId(name) !== null)
  }

  /**
   * `GET /instances/<id>/definition`：返回实例启动时冻结的定义快照。
   *
   * 只调用 `readInstanceDefinition()`（实例目录里的 `definition.bpmn`）——它已经
   * 核对过快照与 `instance.json.definitionHash` 一致，所以这里不读定义域，也不会
   * 因为定义新增版本 / 定义域文件缺失而改变结果。快照缺失 / 损坏沿用 store 的
   * 500 `INSTANCE_SNAPSHOT_MISSING` / `INSTANCE_SNAPSHOT_CORRUPT`；实例不存在返回
   * 404 `INSTANCE_NOT_FOUND`。若 store 以后为快照读取引入 409，`handle()` 的
   * `errorResult()` 会原样带出该既有业务码，不在这里另造新码。
   *
   * 这是只读请求：不创建 runner、不触发懒恢复、不改实例状态。
   *
   * @param {string} id 已通过 `checkRunId` 校验的 instanceId
   * @returns {Promise<{status: number, body: object}>}
   */
  async _readInstanceDefinitionSnapshot(id) {
    const snapshot = await this._readDefinitionSnapshot(id)
    if (snapshot === null) return instanceNotFound(id)
    return {
      status: 200,
      body: {
        ok: true,
        id: snapshot.instanceId,
        definitionId: snapshot.definitionId,
        definitionVersion: snapshot.definitionVersion,
        definitionHash: snapshot.definitionHash,
        xml: snapshot.xml,
      },
    }
  }

  async _readTasks(id) {
    return await this._withInstance(id, async () => {
      const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
      if (instance === null) return instanceNotFound(id)
      const ensured = await this._ensureRunner(instance)
      const current = await readInstance(id, { instancesRoot: this.instancesRoot }) ?? instance
      return {
        status: 200,
        body: {
          ok: true,
          id,
          status: current.status,
          tasks: ensured.runner !== null ? ensured.runner.pendingTasks() : (current.pendingTasks ?? []),
          recovered: ensured.recovered,
          ...(ensured.reason ? { recovery: { reason: ensured.reason, code: ensured.code ?? null } } : {}),
        },
      }
    })
  }

  // -------------------------------------------------------------------------
  // 实例收件箱（0.13.10 D）：只读列表 / 正文读取不启动 runner
  // -------------------------------------------------------------------------

  async _readInstanceMessages(id, url) {
    const cursorRaw = url.searchParams.get('cursor')
    const limitRaw = url.searchParams.get('limit')
    let cursor = 0
    if (cursorRaw !== null && cursorRaw !== '') {
      if (!/^\d+$/.test(cursorRaw)) {
        return { status: 400, body: { ok: false, code: 'MESSAGE_CURSOR_INVALID', error: 'cursor 必须是非负整数' } }
      }
      cursor = Number(cursorRaw)
    }
    let limit = 50
    if (limitRaw !== null && limitRaw !== '') {
      if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) {
        return { status: 400, body: { ok: false, code: 'MESSAGE_LIMIT_INVALID', error: 'limit 必须是正整数' } }
      }
      limit = Number(limitRaw)
    }
    try {
      const page = await this.inbox.listMessages(id, { cursor, limit })
      return {
        status: 200,
        body: {
          ok: true,
          id,
          messages: page.messages,
          total: page.total,
          nextCursor: page.nextCursor,
          cursor: page.cursor,
          limit: page.limit,
          liveExecutions: page.liveExecutions,
        },
      }
    } catch (error) {
      if (error instanceof InstanceInboxError) {
        return { status: error.status, body: error.toPayload({ id }) }
      }
      throw error
    }
  }

  async _acceptInstanceMessage(id, body) {
    if (body !== undefined && body !== null && !isPlainObject(body)) {
      return {
        status: 400,
        body: { ok: false, code: 'BPMN_BODY_INVALID', error: '请求体必须是 JSON 对象：{ messageId, target, text, replyTargetId? }' },
      }
    }
    const input = isPlainObject(body) ? body : {}
    // 不占实例写锁：消息可以在 agent / 人工任务执行期间并发受理；
    // 幂等与持久化由 inbox 自己的跨进程锁保证。
    try {
      const result = await this.inbox.acceptInstanceMessage({
        instanceId: id,
        messageId: input.messageId,
        target: input.target,
        text: input.text,
        ...(input.replyTargetId === undefined ? {} : { replyTargetId: input.replyTargetId }),
      })
      return {
        status: 200,
        body: {
          ok: true,
          id,
          duplicate: result.duplicate,
          message: result.message,
          delivery: result.delivery,
        },
      }
    } catch (error) {
      if (error instanceof InstanceInboxError) {
        return { status: error.status, body: error.toPayload({ id }) }
      }
      throw error
    }
  }

  async _readInstanceMessageBody(id, messageId) {
    try {
      const body = await this.inbox.readMessageBody(id, messageId)
      return { status: 200, body: { ok: true, id, ...body } }
    } catch (error) {
      if (error instanceof InstanceInboxError) {
        return { status: error.status, body: error.toPayload({ id, messageId }) }
      }
      throw error
    }
  }

  async _postInstanceReply(id, messageId, body) {
    if (body !== undefined && body !== null && !isPlainObject(body)) {
      return {
        status: 400,
        body: { ok: false, code: 'BPMN_BODY_INVALID', error: '请求体必须是 JSON 对象：{ replyId?, targetId?, text?, document? }' },
      }
    }
    const input = isPlainObject(body) ? body : {}
    // 回复目标只能是宿主白名单 id：任何 URL / session / target 字段都明确拒绝。
    for (const forbidden of ['url', 'sessionId', 'session', 'target']) {
      if (input[forbidden] !== undefined) {
        return {
          status: 400,
          body: {
            ok: false,
            code: INSTANCE_INBOX_ERROR.REPLY_TARGET_ARBITRARY,
            error: `禁止在回复请求里提供 ${forbidden}：回复目标只能来自宿主维护的 ID（targetId）`,
          },
        }
      }
    }
    // 回复也不占实例写锁：agent 运行中就可以回复；先写 outbox 再投递。
    try {
      const enqueued = await this.inbox.enqueueReply({
        instanceId: id,
        messageId,
        ...(input.replyId === undefined ? {} : { replyId: input.replyId }),
        ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.document === undefined ? {} : { document: input.document }),
      })
      const dispatched = await this.inbox.dispatchReply({ instanceId: id, replyId: enqueued.reply.replyId })
      if (dispatched.inFlight === true) {
        // 另一个进程正持有这条回复的投递权：不并发重复外发，也不把「仍在投递」伪装成失败。
        return {
          status: 409,
          body: {
            ok: false,
            id,
            messageId,
            duplicate: enqueued.duplicate === true,
            enqueued: true,
            delivered: false,
            reply: dispatched.reply,
            code: INSTANCE_INBOX_ERROR.REPLY_DISPATCH_IN_FLIGHT,
            error: dispatched.dispatchUnknown === true
              ? `回复 ${enqueued.reply.replyId} 的投递权归属无法确认（跨主机 / 旧格式领取记录），Host 不按时间猜、不自动接管；为避免重复外发，请人工确认后再处理`
              : `回复 ${enqueued.reply.replyId} 正在另一个进程投递中；不要并发重复外发，稍后用同一 replyId 重试`,
          },
        }
      }
      const reply = dispatched.reply
      const delivered = reply.status === 'delivered'
      const skipped = reply.status === 'skipped'
      return {
        status: delivered ? 200 : (skipped ? 409 : 502),
        body: {
          ok: delivered,
          id,
          messageId,
          duplicate: enqueued.duplicate === true,
          enqueued: true,
          delivered,
          reply,
          ...(skipped
            ? {
              code: INSTANCE_INBOX_ERROR.INSTANCE_TERMINAL,
              error: `实例 ${id} 已取消（CANCELED），未发送回复`,
            }
            : {}),
          ...(!delivered && !skipped
            ? {
              code: typeof reply.lastError?.code === 'string' ? reply.lastError.code : INSTANCE_INBOX_ERROR.DELIVERY_FAILED,
              error: typeof reply.lastError?.message === 'string' ? reply.lastError.message : '回复投递失败',
            }
            : {}),
        },
      }
    } catch (error) {
      if (error instanceof InstanceInboxError) {
        return { status: error.status, body: error.toPayload({ id, messageId }) }
      }
      throw error
    }
  }

  async _completeTask(id, activityId, body) {
    const requested = activityIdLabel(activityId)
    if (requested === null) {
      return {
        status: 400,
        body: { ok: false, code: 'BPMN_ACTIVITY_ID_INVALID', error: 'activityId 必须是非空字符串（≤128）' },
      }
    }
    if (body !== undefined && body !== null && !isPlainObject(body)) {
      return { status: 400, body: { ok: false, code: 'BPMN_BODY_INVALID', error: '请求体必须是 JSON 对象：{ payload?, decidedBy? }' } }
    }
    const payload = body?.payload
    if (payload !== undefined && payload !== null && !isPlainObject(payload)) {
      return { status: 400, body: { ok: false, code: 'BPMN_PAYLOAD_INVALID', error: 'payload 必须是 JSON 对象' } }
    }
    const decidedBy = typeof body?.decidedBy === 'string' && body.decidedBy.trim() !== ''
      ? body.decidedBy.trim()
      : null
    const executionId = typeof body?.executionId === 'string' && body.executionId !== '' ? body.executionId : null

    return await this._withInstance(id, async () => {
      const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
      if (instance === null) return instanceNotFound(id)
      if (this._stopping.has(id)) {
        return {
          status: 409,
          body: { ok: false, code: 'BPMN_INSTANCE_STOPPING', error: `实例 ${id} 正在停止，不能再完成任务` },
        }
      }
      if (TERMINAL_STATUSES.has(instance.status)) {
        return {
          status: 409,
          body: {
            ok: false,
            code: 'BPMN_INSTANCE_TERMINAL',
            error: `实例 ${id} 已结束（${instance.status}），不能再完成人工任务`,
          },
        }
      }
      // 0.14.3：挂起期间不允许完成人工任务（挂起不是「暂停等人点按钮」，是不推进）。
      // 0.14.4：只认磁盘事实（`_suspended` 内存集合已删除，避免跨进程 resume 后闩仍生效）。
      if (instance.status === 'SUSPENDED') {
        return {
          status: 409,
          body: {
            ok: false,
            code: 'INSTANCE_SUSPENDED',
            error: `实例 ${id} 已挂起（SUSPENDED），挂起期间不能完成人工任务；先 POST /instances/${id}/resume 再完成`,
          },
        }
      }
      const ensured = await this._ensureRunner(instance)
      if (ensured.runner === null) {
        // 准备期间被挂起（准入复查发现磁盘已 SUSPENDED）：与入口判定同口径，明确告诉调用方
        // 「先 resume」，而不是含糊的 NOT_RECOVERABLE。
        if (ensured.code === 'BPMN_STATE_SUSPENDED') {
          return {
            status: 409,
            body: {
              ok: false,
              code: 'INSTANCE_SUSPENDED',
              error: `实例 ${id} 已挂起（SUSPENDED），挂起期间不能完成人工任务；先 POST /instances/${id}/resume 再完成`,
            },
          }
        }
        // MAJOR-3 残余（契约）：已落盘的执行失败在冷恢复路径必须与热 runner 同口径——
        // `BPMN_INSTANCE_BLOCKED` + `recoveryCode`（失败码），而不是 NOT_RECOVERABLE。
        if (ensured.blocked === true) {
          return {
            status: 409,
            body: {
              ok: false,
              code: 'BPMN_INSTANCE_BLOCKED',
              error: `实例 ${id} 的执行已停下（lastError），不能再完成任务`,
              ...(ensured.code ? { recoveryCode: ensured.code } : {}),
            },
          }
        }
        return {
          status: 409,
          body: {
            ok: false,
            code: 'BPMN_INSTANCE_NOT_RECOVERABLE',
            error: `实例 ${id} 当前无法恢复：${ensured.reason ?? '未知原因'}`,
            ...(ensured.code ? { recoveryCode: ensured.code } : {}),
          },
        }
      }
      const runner = ensured.runner
      // runner 内部 blocked = 这个实例的执行已经停下（error 事件已发、lastError 已写）：
      // 实例 status 仍是 ACTIVE，但不能再完成人工任务。
      if (runner.status() === BPMN_RUNNER_STATUS.BLOCKED) {
        const blockedCode = this._runnerErrors.get(id)?.code
          ?? (typeof instance.lastError?.code === 'string' && instance.lastError.code !== '' ? instance.lastError.code : null)
        return {
          status: 409,
          body: {
            ok: false,
            code: 'BPMN_INSTANCE_BLOCKED',
            error: `实例 ${id} 的执行已停下（lastError），不能再完成任务`,
            ...(blockedCode !== null ? { recoveryCode: blockedCode } : {}),
          },
        }
      }
      if (runner.status() !== 'waiting') {
        return {
          status: 409,
          body: {
            ok: false,
            code: 'BPMN_INSTANCE_NOT_WAITING',
            error: `实例 ${id} 当前 runner 状态是 ${runner.status()}，没有等待中的人工任务`,
          },
        }
      }
      const tasks = runner.pendingTasks()
      const task = tasks.find(item => item.activityId === requested
        && (executionId === null || item.executionId === executionId))
      if (!task) {
        return {
          status: 404,
          body: {
            ok: false,
            code: 'BPMN_TASK_NOT_FOUND',
            error: `实例 ${id} 没有在等待的任务 ${requested}`,
            tasks,
          },
        }
      }

      // decidedBy 是审计字段：并入任务载荷（同一份会进 variables），不另造事件。
      const effectivePayload = { ...(isPlainObject(payload) ? payload : {}) }
      if (decidedBy !== null && effectivePayload.decidedBy === undefined) {
        effectivePayload.decidedBy = decidedBy
      }

      // MAJOR-1 残余（最后一道准入）：准备 / 恢复是异步的，真正派发之前必须从**磁盘**
      // 再读一次生命周期事实。准备期间别的进程已经提交的 SUSPENDED / 终态在这里拦下，
      // 绝不进入 `runner.signalTask`（否则下游 agent 被派发、事件被 store 闸门丢掉，
      // 内存 runner 已 done、磁盘仍留待办）。
      const admission = await readInstance(id, { instancesRoot: this.instancesRoot })
      if (admission === null) return instanceNotFound(id)
      if (this._stopping.has(id)) {
        return {
          status: 409,
          body: { ok: false, code: 'BPMN_INSTANCE_STOPPING', error: `实例 ${id} 正在停止，本次任务完成未被采纳` },
        }
      }
      if (TERMINAL_STATUSES.has(admission.status)) {
        return {
          status: 409,
          body: {
            ok: false,
            code: 'BPMN_INSTANCE_TERMINAL',
            error: `实例 ${id} 已结束（${admission.status}），本次任务完成未被采纳`,
          },
        }
      }
      if (admission.status === 'SUSPENDED') {
        // 已恢复但不能再推进：从缓存摘掉并停掉，不能继续当 runner 缓存用；所有权交还，
        // 让 resume 之后的下一次请求重新取得准入。
        await this._dropRunner(id)
        await this._releaseOwner(id)
        return {
          status: 409,
          body: {
            ok: false,
            code: 'INSTANCE_SUSPENDED',
            error: `实例 ${id} 已挂起（SUSPENDED），挂起期间不能完成人工任务；本次任务完成未被采纳，先 POST /instances/${id}/resume 再完成`,
          },
        }
      }

      let signalError = null
      try {
        await runner.signalTask({ activityId: task.activityId, executionId: task.executionId, payload: effectivePayload })
      } catch (error) {
        signalError = error
      }
      try {
        await this._afterSettle(id, runner)
      } catch (error) {
        // stop 抢先一步把实例收成 aborted：终态不可逆，把事实返回给调用方。
        if (error?.code === 'INSTANCE_TERMINAL_IMMUTABLE') {
          const current = await readInstance(id, { instancesRoot: this.instancesRoot })
          return {
            status: 409,
            body: { ok: false, code: 'INSTANCE_TERMINAL_IMMUTABLE', error: `实例 ${id} 已被其它请求收成终态 ${current?.status ?? ''}` },
          }
        }
        throw error
      }
      const after = await readInstance(id, { instancesRoot: this.instancesRoot })
      // 返回前复查停止闩：stop 可能在 complete 等 handler 期间抢先收口，
      // 不能把「盘上已 CANCELED、决定被丢弃」报成 200 + ACTIVE（假阳性成功最危险）。
      // 注意：自己跑到 COMPLETED 是正常成功（runner.status()==='done'），不算被抢收。
      if (this._stopping.has(id)) {
        return {
          status: 409,
          body: {
            ok: false,
            code: 'INSTANCE_TERMINAL_IMMUTABLE',
            error: `实例 ${id} 正在停止（stop 已置停止闩），本次任务完成未被采纳（以 stop 收口的终态为准）`,
          },
        }
      }
      if (signalError !== null) {
        const result = errorResult(signalError)
        return { status: result.status, body: { ...result.body, id, tasks: runner.pendingTasks() } }
      }
      return {
        status: 200,
        body: {
          ok: true,
          id,
          status: after?.status ?? 'unknown',
          pendingTasks: after?.pendingTasks ?? runner.pendingTasks(),
          lastSeq: after?.lastSeq ?? 0,
          activityId: task.activityId,
          executionId: task.executionId,
          decidedBy,
          recovered: ensured.recovered,
        },
      }
    })
  }

  /**
   * 中止实例：**先在实例 HTTP 串行队列之外**置停止闩并发取消信号，再落盘 CANCELED。
   *
   * 慢 complete 可能长时间持有 `_withInstance` 锁（等 handler / 等流程静默），
   * stop 不能排在它后面——否则「点了停止却要等五分钟」。所以：
   *   1. 锁外读实例、置 `_stopping` 闩、`runner.stop()`（abort 在飞 handler）；
   *   2. 直接 `completeInstance('CANCELED')`（store 自己的文件锁只覆盖毫秒级写入）；
   *   3. 闩保留到 runtime dispose；期间 runner 的迟到事件一律丢弃。
   */
  async _stopInstance(id) {
    const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
    if (instance === null) return instanceNotFound(id)
    if (TERMINAL_STATUSES.has(instance.status)) {
      return {
        status: 200,
        body: { ok: true, id, status: instance.status, alreadyTerminal: true, pendingTasks: [] },
      }
    }

    // 停止闩：任何新事件 / 懒恢复 / complete 都不能再把实例写回 running。
    this._stopping.add(id)
    const runner = this._runners.get(id) ?? null
    if (runner !== null) {
      try {
        // runner.stop() 同步置停止态 + abort 在飞活动，这里不必等它把引擎收尾。
        await runner.stop()
      } catch {
        // runner.stop 幂等；失败不改变「实例已中止」这个事实。
      }
      this._runners.delete(id)
    }

    let after
    try {
      after = await completeInstance(id, 'CANCELED', { instancesRoot: this.instancesRoot })
    } catch (error) {
      // 另一个请求（慢 complete）先以 done 收口：先成立者保持不变。
      if (error?.code === 'INSTANCE_TERMINAL_IMMUTABLE') {
        const current = await readInstance(id, { instancesRoot: this.instancesRoot })
        if (current !== null) {
          return {
            status: 200,
            body: { ok: true, id, status: current.status, alreadyTerminal: true, pendingTasks: [] },
          }
        }
      }
      throw error
    }
    await this._maybeTerminalCleanup(id).catch(() => {})
    await this._releaseOwner(id)
    await this._finalizeInbox(id, 'CANCELED')
    return {
      status: 200,
      body: {
        ok: true,
        id,
        status: after.status,
        alreadyTerminal: false,
        pendingTasks: after.pendingTasks,
        lastSeq: after.lastSeq,
      },
    }
  }

  /**
   * `POST /instances/<id>/suspend`：**quiesce 式软挂起**（0.14.3，路线 1）。
   *
   * `bpmn-engine@26` 没有 pause 原语，所以这里不碰引擎：
   *   - 只在实例 `ACTIVE` 且**没有在飞活动**（agent / HTTP / runner 正在执行）时允许；
   *   - 状态置 `SUSPENDED` + 写 `instance/suspended` 事件（含 `reason`），一次提交；
   *   - 不杀 runner、不推进、不重放；挂起后 `_ensureRunner` 直接跳过，
   *     `complete` 409 `INSTANCE_SUSPENDED`，入站消息排队；
   *   - 有在飞活动时 409 `INSTANCE_SUSPEND_BUSY`，`activities[]` 列出未结束的活动。
   *
   * 在飞判定必须在实例写锁**之外**先做一次：正在跑的 agent / HTTP 请求会持锁到活动
   * 结束，排在锁后面等于「等活动结束再挂起」，与用户看到的「有活动在跑」不符。
   *
   * @param {string} id
   * @param {object} [body] `{ reason? }`
   */
  async _suspendInstance(id, body) {
    const parsed = parseLifecycleBody(body, '挂起')
    if (parsed.error !== null) return parsed.error

    const pre = await readInstance(id, { instancesRoot: this.instancesRoot })
    if (pre === null) return instanceNotFound(id)
    const preVerdict = this._lifecycleVerdict(pre, 'suspend')
    if (preVerdict !== null) return preVerdict
    const preBusy = await this._suspendBusy(pre)
    if (preBusy !== null) return preBusy

    return await this._withInstance(id, async () => {
      const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
      if (instance === null) return instanceNotFound(id)
      const verdict = this._lifecycleVerdict(instance, 'suspend')
      if (verdict !== null) return verdict
      const busy = await this._suspendBusy(instance)
      if (busy !== null) return busy
      return await this._commitLifecycleStatus(instance, 'SUSPENDED', 'instance/suspended', parsed.reason, 'suspendedAt', 'ACTIVE')
    })
  }

  /**
   * `POST /instances/<id>/resume`：把 `SUSPENDED` 改回 `ACTIVE` + 写 `instance/resumed`。
   *
   * **不主动跑**：不创建 / 不恢复 runner，不派发活动；下一次 `complete` / 消息投递 /
   * `GET` 推进时沿用既有懒恢复。挂起区间由 E1 指标按两条事件收口。
   *
   * @param {string} id
   * @param {object} [body] `{ reason? }`
   */
  async _resumeInstance(id, body) {
    const parsed = parseLifecycleBody(body, '恢复')
    if (parsed.error !== null) return parsed.error
    return await this._withInstance(id, async () => {
      const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
      if (instance === null) return instanceNotFound(id)
      const verdict = this._lifecycleVerdict(instance, 'resume')
      if (verdict !== null) return verdict
      return await this._commitLifecycleStatus(instance, 'ACTIVE', 'instance/resumed', parsed.reason, 'resumedAt', 'SUSPENDED')
    })
  }

  /** 挂起 / 恢复的实例状态前置判定（终态沿用既有 `BPMN_INSTANCE_TERMINAL`）。 */
  _lifecycleVerdict(instance, action) {
    const id = instance.id
    // 终态优先于停止闩：stop 已收口后闩仍会留到进程结束，但可读的原因应该是「终态不可逆」。
    if (TERMINAL_STATUSES.has(instance.status)) {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'BPMN_INSTANCE_TERMINAL',
          error: `实例 ${id} 已结束（${instance.status}），不能${action === 'suspend' ? '挂起' : '恢复'}`,
        },
      }
    }
    if (this._stopping.has(id)) {
      return {
        status: 409,
        body: { ok: false, code: 'BPMN_INSTANCE_STOPPING', error: `实例 ${id} 正在停止，不能${action === 'suspend' ? '挂起' : '恢复'}` },
      }
    }
    if (action === 'suspend' && instance.status === 'SUSPENDED') {
      return {
        status: 409,
        body: { ok: false, code: 'INSTANCE_ALREADY_SUSPENDED', error: `实例 ${id} 已处于 SUSPENDED，不能重复挂起（没有产生新事件）` },
      }
    }
    if (action === 'resume' && instance.status !== 'SUSPENDED') {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'INSTANCE_NOT_SUSPENDED',
          error: `实例 ${id} 当前状态是 ${instance.status}，只有 SUSPENDED 才能恢复（没有产生新事件）`,
        },
      }
    }
    if (action === 'suspend' && instance.status !== 'ACTIVE') {
      return {
        status: 409,
        body: { ok: false, code: 'INSTANCE_NOT_ACTIVE', error: `实例 ${id} 当前状态是 ${instance.status}，只有 ACTIVE 才能挂起` },
      }
    }
    return null
  }

  /**
   * 有在飞活动时返回 409 `INSTANCE_SUSPEND_BUSY`（读不到 connector 记录时按未结算处理，
   * 不把「无法确认」说成「可以安全挂起」）。没有在飞活动返回 `null`。
   */
  async _suspendBusy(instance) {
    const id = instance.id
    const activities = []
    const activeAgents = this._activeAgentActivities.get(id)
    if (this._executionBusy(id)) {
      if (activeAgents !== undefined && activeAgents.size > 0) {
        for (const item of activeAgents.values()) {
          activities.push({
            kind: 'agent',
            activityId: item.elementId ?? null,
            executionId: item.executionId ?? null,
            state: 'running',
          })
        }
      } else {
        activities.push({ kind: 'agent', activityId: null, executionId: null, state: 'running' })
      }
    }
    // runner 正在执行（非 agent / HTTP handler 的同步推进）：也在飞，但它通常只在
    // 持有实例锁的请求里出现；这里只用于锁内复核与给出可读原因。
    const runner = this._runners.get(id) ?? null
    if (runner !== null && runner.status() === BPMN_RUNNER_STATUS.RUNNING && activities.length === 0) {
      activities.push({ kind: 'engine', activityId: null, executionId: null, state: 'running' })
    }
    // 0.14.4：还有事件在排队 / 写盘 → 不能挂起。不能把「已出队」当成「已完成」：
    // 计数只在队内任务 finally 里减；否则挂起会插在事件落盘与状态收口之间。
    const pendingCommits = this._pendingEventCommits.get(id) ?? 0
    if (pendingCommits > 0) {
      activities.push({ kind: 'event-queue', pending: pendingCommits, state: 'pending' })
    }
    // MAJOR-4：首次创建 / workspace 准备窗口 → 挂起会打断首次启动，必须 BUSY。
    const preparing = this._preparing.get(id) ?? 0
    if (preparing > 0) {
      activities.push({ kind: 'preparing', pending: preparing, state: 'preparing' })
    }
    // MAJOR-1：另一个活进程持有执行所有权 → 它才是在推进实例的人，本进程不能替它挂起。
    let ownerInfo = null
    try {
      ownerInfo = await readInstanceOwner(id, { instancesRoot: this.instancesRoot })
    } catch (error) {
      activities.push({
        kind: 'owner',
        pid: null,
        host: null,
        since: null,
        state: 'unreadable',
        error: errorText(error),
      })
    }
    if (ownerInfo !== null) {
      const owner = isPlainObject(ownerInfo.owner) ? ownerInfo.owner : null
      const mine = owner !== null && owner.runtimeId === this.runtimeId
      if (!mine && this._isForeignOwner(ownerInfo)) {
        activities.push({
          kind: 'owner',
          pid: Number.isSafeInteger(owner?.pid) ? owner.pid : null,
          host: typeof owner?.host === 'string' ? owner.host : null,
          since: typeof owner?.since === 'string' ? owner.since : null,
          state: ownerInfo.state,
        })
      }
    }
    // HTTP：started / sent / unknown 都是未结算；succeeded / failed 才算结束。
    try {
      const store = createConnectorStore({ root: join(this.instancesRoot, id, 'connector') })
      const records = await store.listInvocations(id)
      for (const record of records) {
        if (!UNSETTLED_CONNECTOR_STATES.has(record.state)) continue
        activities.push({
          kind: 'http',
          activityId: typeof record.elementId === 'string' ? record.elementId : null,
          executionId: typeof record.executionId === 'string' ? record.executionId : null,
          state: record.state,
          attempts: Number.isSafeInteger(record.attempts) ? record.attempts : null,
        })
      }
    } catch (error) {
      activities.push({
        kind: 'http',
        activityId: null,
        executionId: null,
        state: 'unreadable',
        error: errorText(error),
      })
    }
    if (activities.length === 0) return null

    const describe = activities.map(item => {
      const target = [item.activityId, item.executionId].filter(value => typeof value === 'string' && value !== '').join('/')
      if (item.kind === 'agent') return `agent 活动${target === '' ? '' : ` ${target}`} 正在执行`
      if (item.kind === 'http') return `HTTP 调用${target === '' ? '' : ` ${target}`} 状态 ${item.state}（未结算）`
      if (item.kind === 'event-queue') return `还有 ${item.pending} 条事件提交未完成`
      if (item.kind === 'preparing') return '实例仍在首次创建 / 工作区准备窗口'
      if (item.kind === 'owner') {
        const who = [item.pid === null ? null : `pid ${item.pid}`, item.host].filter(value => typeof value === 'string' && value !== '').join(' @ ')
        const when = typeof item.since === 'string' && item.since !== '' ? `，自 ${item.since}` : ''
        return `另一个活进程${who === '' ? '' : `（${who}）`}持有执行所有权${when}（状态 ${item.state}）`
      }
      return `runner 正在执行（${item.state}）`
    }).join('；')
    return {
      status: 409,
      body: {
        ok: false,
        code: 'INSTANCE_SUSPEND_BUSY',
        error: `实例 ${id} 还有未结束的活动，不能挂起：${describe}。等活动结束（或按 connector 处置）后再挂起。`,
        activities,
      },
    }
  }

  /**
   * 生命周期事件 + 状态的**一次提交**（`appendInstanceEvents` 的 `status` 选项在同一次
   * `instance.json` 写入里改状态，事件行随后追加）。
   *
   * 抽成方法只为让测试能注入 store 的「本次提交事实」契约（见 NEW-2 测试）；生产路径
   * 就是 store 的直调。**不要**在这里根据磁盘状态推断提交结果。
   */
  async _appendLifecycleEvent(instanceId, event, options) {
    return await appendInstanceEvents(instanceId, 'process', 1, event, options)
  }

  /**
   * 生命周期状态 + 事件一次提交。
   *
   * NEW-2：**只认 store 给出的本次提交事实**。`appendInstanceEvents` 在「元数据已提交、
   * 事件正文追加失败」时抛带 `committed:true / eventLogPending:true / lastSeq` 的错误；
   * 只有 `error.committed === true` 才按「已提交、事件日志待补」返回 200。其它失败一律
   * 原样抛——绝不因为「磁盘最终状态等于目标状态」就认领别人的提交（那会把 B 的 resume
   * 当成 A 的提交，还会替 B 编造 reason）。
   */
  async _commitLifecycleStatus(instance, status, eventType, reason, timeKey, expectedStatus) {
    const at = new Date().toISOString()
    const event = {
      type: eventType,
      at,
      status,
      ...(reason === null ? {} : { reason }),
    }
    let appended
    try {
      appended = await this._appendLifecycleEvent(instance.id, event, {
        instancesRoot: this.instancesRoot,
        status,
        expectedStatus,
      })
    } catch (error) {
      if (error?.code === 'INSTANCE_TERMINAL_IMMUTABLE') {
        const current = await readInstance(instance.id, { instancesRoot: this.instancesRoot })
        return {
          status: 409,
          body: {
            ok: false,
            code: 'BPMN_INSTANCE_TERMINAL',
            error: `实例 ${instance.id} 已被其它请求收成终态 ${current?.status ?? ''}，本次${status === 'SUSPENDED' ? '挂起' : '恢复'}未被采纳`,
          },
        }
      }
      // 条件提交失败 = 状态已经被别的请求改过：不能重试，也不能谎报成功。
      if (error?.code === 'INSTANCE_LIFECYCLE_CONFLICT') {
        return {
          status: 409,
          body: {
            ok: false,
            code: error.code,
            error: error.reason ?? error.message,
            // 文档契约要求两个字段都带；store 的 InstanceError 两个都有。
            expectedStatus: error.expectedStatus ?? expectedStatus ?? null,
            actualStatus: error.actualStatus ?? null,
          },
        }
      }
      // 部分提交：只有 store 明确报告「本次元数据已提交」才如实返回 200。
      if (error?.committed === true) {
        return {
          status: 200,
          body: {
            ok: true,
            id: instance.id,
            status,
            reason: reason ?? null,
            lastSeq: Number.isSafeInteger(error.lastSeq) ? error.lastSeq : null,
            [timeKey]: at,
            committed: true,
            eventLogPending: error.eventLogPending === true,
            eventLogError: error?.code ?? error?.message ?? errorText(error),
          },
        }
      }
      throw error
    }
    return {
      status: 200,
      body: {
        ok: true,
        id: instance.id,
        status,
        reason: reason ?? null,
        lastSeq: appended.lastSeq,
        [timeKey]: at,
        committed: true,
        eventLogPending: false,
      },
    }
  }

  // -------------------------------------------------------------------------
  // 实例工作区（worktree）路由：全部只读接口不触发 _ensureRunner
  // -------------------------------------------------------------------------

  async _readInstanceWorktree(id) {
    const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
    if (instance === null) return instanceNotFound(id)
    const state = await this._workspaceFor(id)
    if (state.error !== null) return workspaceErrorResult(state.error)
    if (state.workspace === null) {
      return {
        status: 200,
        body: {
          ok: true,
          id,
          configured: false,
          instanceStatus: instance.status,
          mode: null,
          worktree: null,
          cleanable: false,
        },
      }
    }
    const workspace = state.workspace
    if (workspace.worktree === null || workspace.worktree === undefined) {
      return {
        status: 200,
        body: {
          ok: true,
          id,
          configured: true,
          instanceStatus: instance.status,
          mode: workspace.mode,
          workspaceId: workspace.workspaceId,
          effectiveRoot: workspace.effectiveRoot,
          cleanupPolicy: workspace.cleanupPolicy,
          worktree: null,
          cleanable: false,
        },
      }
    }
    const inspected = await inspectInstanceWorktree({
      record: workspace.worktree,
      ...(this.gitRunner === undefined ? {} : { runner: this.gitRunner }),
      worktreeRoot: this.worktreeRoot,
    })
    return {
      status: 200,
      body: {
        ok: true,
        id,
        configured: true,
        instanceStatus: instance.status,
        mode: workspace.mode,
        workspaceId: workspace.workspaceId,
        cleanupPolicy: workspace.cleanupPolicy,
        worktree: inspected,
        cleanable: TERMINAL_STATUSES.has(instance.status) && inspected.cleanable === true,
      },
    }
  }

  async _deleteInstanceWorktree(id, body) {
    if (body !== undefined && body !== null && !isPlainObject(body)) {
      return { status: 400, body: { ok: false, code: 'BPMN_BODY_INVALID', error: '请求体必须是 JSON 对象：{ force?, removeBranch?, expectedHead? }' } }
    }
    const force = body?.force === true
    const removeBranch = body?.removeBranch === true
    let expectedHead
    if (body?.expectedHead !== undefined && body?.expectedHead !== null) {
      if (typeof body.expectedHead !== 'string' || !/^[0-9a-f]{40,64}$/i.test(body.expectedHead)) {
        return { status: 400, body: { ok: false, code: 'BPMN_EXPECTED_HEAD_INVALID', error: 'expectedHead 必须是 40–64 位十六进制' } }
      }
      expectedHead = body.expectedHead
    }
    const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
    if (instance === null) return instanceNotFound(id)
    if (instance.status === 'ACTIVE' || instance.status === 'SUSPENDED') {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'INSTANCE_WORKTREE_INSTANCE_ACTIVE',
          error: `实例 ${id} 当前是 ${instance.status}：禁止清理工作树（force 不能越过此限制）`,
        },
      }
    }
    if (this._executionBusy(id)) {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'INSTANCE_WORKTREE_EXECUTION_ACTIVE',
          error: `实例 ${id} 仍有 agent 执行未确认退出（进程 / 清理未完成）：禁止清理工作树（force 不能越过此限制）`,
        },
      }
    }
    const state = await this._workspaceFor(id)
    if (state.error !== null) return workspaceErrorResult(state.error)
    if (state.workspace === null || state.workspace.worktree === null || state.workspace.worktree === undefined) {
      return {
        status: 404,
        body: { ok: false, code: 'INSTANCE_WORKTREE_NOT_CONFIGURED', error: `实例 ${id} 没有登记 worktree` },
      }
    }
    let result
    try {
      result = await removeInstanceWorktree({
        record: state.workspace.worktree,
        force,
        ...(expectedHead === undefined ? {} : { expectedHead }),
        ...(this.gitRunner === undefined ? {} : { runner: this.gitRunner }),
        worktreeRoot: this.worktreeRoot,
      })
    } catch (error) {
      return workspaceErrorResult(error)
    }
    const branchRemoval = removeBranch
      ? await this._removeInstanceBranchRecord(state.workspace.worktree, { force })
      : null
    await this._recordWorktreeRemoval(id, state.workspace, result, branchRemoval)
    if (result.removed === true || result.reason === 'not-found') {
      try {
        await removeResourceRecord({
          registryRoot: this.worktreeRegistryRoot,
          workspaceId: state.workspace.workspaceId,
          instanceId: id,
        })
      } catch {
        // 记录已删 / 锁竞争：不改变「树已删」的结论。
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        id,
        removed: result.removed === true,
        reason: result.reason,
        path: result.path ?? null,
        branch: result.branch ?? null,
        ...(branchRemoval === null ? {} : { branchRemoval }),
      },
    }
  }

  async _deleteInstanceWorktreeBranch(id, body) {
    if (body !== undefined && body !== null && !isPlainObject(body)) {
      return { status: 400, body: { ok: false, code: 'BPMN_BODY_INVALID', error: '请求体必须是 JSON 对象：{ force? }' } }
    }
    const force = body?.force === true
    const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
    if (instance === null) return instanceNotFound(id)
    if (instance.status === 'ACTIVE' || instance.status === 'SUSPENDED') {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'INSTANCE_WORKTREE_INSTANCE_ACTIVE',
          error: `实例 ${id} 当前是 ${instance.status}：禁止删除工作树分支`,
        },
      }
    }
    if (this._executionBusy(id)) {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'INSTANCE_WORKTREE_EXECUTION_ACTIVE',
          error: `实例 ${id} 仍有 agent 执行未确认退出（进程 / 清理未完成）：禁止删除工作树分支`,
        },
      }
    }
    const state = await this._workspaceFor(id)
    if (state.error !== null) return workspaceErrorResult(state.error)
    if (state.workspace === null || state.workspace.worktree === null || state.workspace.worktree === undefined) {
      return {
        status: 404,
        body: { ok: false, code: 'INSTANCE_WORKTREE_NOT_CONFIGURED', error: `实例 ${id} 没有登记 worktree 分支` },
      }
    }
    const branchRemoval = await this._removeInstanceBranchRecord(state.workspace.worktree, { force })
    if (branchRemoval.reason === 'not-owned') {
      return {
        status: 409,
        body: {
          ok: false,
          code: INSTANCE_WORKTREE_ERROR.BRANCH_NOT_OWNED,
          error: branchRemoval.warning,
          branchRemoval,
        },
      }
    }
    return { status: 200, body: { ok: true, id, branchRemoval } }
  }

  /** 删记录里的实例分支，并把结果写进资源事件（分支失败不抛）。 */
  async _removeInstanceBranchRecord(record, options = {}) {
    const force = options.force === true
    let result
    try {
      result = await removeInstanceBranch({
        record,
        ...(force ? { force: true } : {}),
        ...(this.gitRunner === undefined ? {} : { runner: this.gitRunner }),
      })
    } catch (error) {
      result = { removed: false, branch: record.branch ?? null, reason: error?.code ?? 'branch-error', warning: error?.message ?? String(error) }
    }
    await this._appendResourceEventSafe(record.instanceId, {
      type: result.removed === true ? RESOURCE_EVENT.BRANCH_REMOVE : RESOURCE_EVENT.BRANCH_REMOVE_SKIPPED,
      instanceId: record.instanceId,
      workspaceId: record.workspaceId,
      branch: result.branch ?? record.branch ?? null,
      removed: result.removed === true,
      reason: result.reason,
      // W3：未证明合并时只报告；显式 force 删除要留下授权痕迹。
      ...(result.forced === true ? { forced: true } : {}),
      ...(result.warning === null || result.warning === undefined ? {} : { warning: result.warning }),
    })
    return result
  }

  async _recordWorktreeRemoval(instanceId, workspace, result, branchRemoval) {
    await this._appendResourceEventSafe(instanceId, {
      type: result.removed === true ? RESOURCE_EVENT.WORKTREE_REMOVE : RESOURCE_EVENT.WORKTREE_REMOVE_SKIPPED,
      instanceId,
      workspaceId: workspace.workspaceId,
      branch: result.branch ?? null,
      removed: result.removed === true,
      reason: result.reason ?? null,
      ...(branchRemoval === null ? {} : {
        branchRemoved: branchRemoval.removed === true,
        ...(branchRemoval.warning ? { branchWarning: branchRemoval.warning } : {}),
      }),
    })
  }

  async _appendResourceEventSafe(instanceId, event) {
    try {
      await appendResourceEvent({ instancesRoot: this.instancesRoot, instanceId, event })
    } catch {
      // 资源事件写失败不改变资源操作的结论；下一次清理仍可继续。
    }
  }

  /**
   * 实例进入终态后的收件箱收尾：COMPLETED / CANCELED 都不再受理新入站消息；
   * 已受理的回复在 COMPLETED 后仍可 dispatch，CANCELED 未发送的回复标 skipped。
   */
  async _finalizeInbox(instanceId, status) {
    try {
      await this.inbox.finalizeInstance(instanceId, status)
    } catch {
      // 收件箱收尾失败不改变实例终态。
    }
  }

  async _readResourceEvents(id, url) {
    const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
    if (instance === null) return instanceNotFound(id)
    const sinceRaw = url.searchParams.get('since')
    let since = 0
    if (sinceRaw !== null && sinceRaw !== '') {
      if (!/^\d+$/.test(sinceRaw)) {
        return { status: 400, body: { ok: false, code: 'BPMN_SEQ_INVALID', error: 'since 必须是非负整数' } }
      }
      since = Number(sinceRaw)
    }
    const { events, resourceSeq, skipped } = await readResourceEvents({
      instancesRoot: this.instancesRoot,
      instanceId: id,
      since,
    })
    return { status: 200, body: { ok: true, id, events, resourceSeq, skipped } }
  }

  async _handleInstanceWorktrees(method, parts, url, body) {
    if (parts.length === 1) {
      if (method !== 'GET') return methodNotAllowed('GET')
      return await this._listInstanceWorktrees(url)
    }
    if (parts.length === 2 && parts[1] === 'prune') {
      if (method !== 'POST') return methodNotAllowed('POST')
      return await this._pruneInstanceWorktrees(body)
    }
    return { status: 404, body: { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口' } }
  }

  async _listInstanceWorktrees(url) {
    let workspaceId
    const raw = url.searchParams.get('workspaceId')
    if (raw !== null && raw !== '') {
      if (!/^[0-9a-f]{12}$/.test(raw)) {
        return { status: 400, body: { ok: false, code: 'BPMN_WORKSPACE_ID_INVALID', error: 'workspaceId 必须是 12 位小写十六进制' } }
      }
      workspaceId = raw
    }
    const listed = await listInstanceWorktrees({
      worktreeRoot: this.worktreeRoot,
      registryRoot: this.worktreeRegistryRoot,
      instancesRoot: this.instancesRoot,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(this.gitRunner === undefined ? {} : { runner: this.gitRunner }),
    })
    return {
      status: 200,
      body: {
        ok: true,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        worktrees: listed.entries,
        orphans: listed.orphans,
        corrupt: listed.corrupt,
        scannedAt: listed.scannedAt,
      },
    }
  }

  async _pruneInstanceWorktrees(body) {
    if (body !== undefined && body !== null && !isPlainObject(body)) {
      return { status: 400, body: { ok: false, code: 'BPMN_BODY_INVALID', error: '请求体必须是 JSON 对象' } }
    }
    const dryRun = body?.dryRun !== false
    let workspaceId
    if (body?.workspaceId !== undefined && body?.workspaceId !== null && body?.workspaceId !== '') {
      if (typeof body.workspaceId !== 'string' || !/^[0-9a-f]{12}$/.test(body.workspaceId)) {
        return { status: 400, body: { ok: false, code: 'BPMN_WORKSPACE_ID_INVALID', error: 'workspaceId 必须是 12 位小写十六进制' } }
      }
      workspaceId = body.workspaceId
    }
    const listed = await listInstanceWorktrees({
      worktreeRoot: this.worktreeRoot,
      registryRoot: this.worktreeRegistryRoot,
      instancesRoot: this.instancesRoot,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(this.gitRunner === undefined ? {} : { runner: this.gitRunner }),
    })
    const plan = createPrunePlan({ entries: listed.entries })
    if (dryRun) {
      const now = Date.now()
      for (const [hash, stored] of this._prunePlans) {
        if (now - stored.createdAt > 10 * 60 * 1000) this._prunePlans.delete(hash)
      }
      this._prunePlans.set(plan.planHash, { plan, createdAt: now })
      return {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          planHash: plan.planHash,
          plan,
          removable: plan.entries.filter(entry => entry.action === 'remove').length,
          reported: plan.entries.filter(entry => entry.action !== 'remove').length,
        },
      }
    }
    if (typeof body?.planHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.planHash)) {
      return { status: 400, body: { ok: false, code: 'INSTANCE_WORKTREE_PLAN_INVALID', error: '执行 prune 必须带预览返回的 planHash' } }
    }
    const stored = this._prunePlans.get(body.planHash)
    if (stored === undefined) {
      return {
        status: 409,
        body: { ok: false, code: INSTANCE_WORKTREE_ERROR.PLAN_STALE, error: 'planHash 已失效（预览已过期或服务已重启），请重新预览' },
      }
    }
    if (Date.now() - stored.createdAt > 10 * 60 * 1000 || plan.planHash !== body.planHash) {
      return {
        status: 409,
        body: { ok: false, code: INSTANCE_WORKTREE_ERROR.PLAN_STALE, error: '工作区状态已变化，旧 planHash 失效，请重新预览' },
      }
    }
    // 与手动 DELETE 共用执行存活检查：prune 也不能在 agent 进程 / 物理清理未确认
    // 退出时把正在使用的树删掉（review-0139 F3）。发现占用就整体拒绝，返回可读原因。
    const busyInstances = [...new Set(
      stored.plan.entries
        .filter(entry => entry.action === 'remove' && isPlainObject(entry.record))
        .map(entry => entry.record.instanceId)
        .filter(instanceId => typeof instanceId === 'string' && this._executionBusy(instanceId)),
    )]
    if (busyInstances.length > 0) {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'INSTANCE_WORKTREE_EXECUTION_ACTIVE',
          error: `以下实例仍有 agent 执行未确认退出，拒绝执行 prune：${busyInstances.join(', ')}`,
          instanceIds: busyInstances,
        },
      }
    }
    let executed
    try {
      executed = await pruneInstanceWorktrees({
        plan: stored.plan,
        ...(this.gitRunner === undefined ? {} : { runner: this.gitRunner }),
        worktreeRoot: this.worktreeRoot,
      })
    } catch (error) {
      return workspaceErrorResult(error)
    }
    this._prunePlans.delete(body.planHash)
    for (const entry of executed.removed) {
      const record = isPlainObject(entry.record) ? entry.record : null
      if (record !== null) {
        const branchRemoval = await this._removeInstanceBranchRecord(record)
        await this._recordWorktreeRemoval(record.instanceId, { workspaceId: record.workspaceId }, { ...entry, removed: true }, branchRemoval)
        try {
          await removeResourceRecord({
            registryRoot: this.worktreeRegistryRoot,
            workspaceId: record.workspaceId,
            instanceId: record.instanceId,
          })
        } catch {
          // 记录删除失败不改变已删目录的结论。
        }
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        dryRun: false,
        planHash: executed.planHash,
        removed: executed.removed,
        skipped: executed.skipped,
      },
    }
  }

  /**
   * 终态清理：`cleanup:"on-terminal-clean"` 只在 agent 进程释放、树干净、产物已保存后执行。
   * 任何失败都只记资源事件，**不改实例状态**。
   */
  async _maybeTerminalCleanup(instanceId, options = {}) {
    // 终态收口：本 runtime 不再持有执行所有权（别的进程写的记录不会被删）。
    await this._releaseOwner(instanceId)
    const state = await this._workspaceFor(instanceId)
    if (state.error !== null || state.workspace === null) return
    const workspace = state.workspace
    if (workspace.cleanupPolicy !== 'on-terminal-clean' || workspace.worktree === null || workspace.worktree === undefined) return
    // 默认等 3s；测试 / 嵌入方可以缩短（判定语义不变：等不到就不清理）。
    const waitMs = Number.isSafeInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : 3000
    const released = await this._waitAgentsReleased(instanceId, waitMs)
    if (!released) {
      await this._appendResourceEventSafe(instanceId, {
        type: RESOURCE_EVENT.CLEANUP_SKIPPED,
        instanceId,
        workspaceId: workspace.workspaceId,
        reason: 'agent-still-running',
      })
      return
    }
    const instance = await readInstance(instanceId, { instancesRoot: this.instancesRoot })
    if (instance === null || !TERMINAL_STATUSES.has(instance.status)) return
    const inspected = await inspectInstanceWorktree({
      record: workspace.worktree,
      ...(this.gitRunner === undefined ? {} : { runner: this.gitRunner }),
      worktreeRoot: this.worktreeRoot,
    })
    if (inspected.cleanable !== true) {
      await this._appendResourceEventSafe(instanceId, {
        type: RESOURCE_EVENT.CLEANUP_SKIPPED,
        instanceId,
        workspaceId: workspace.workspaceId,
        reason: inspected.state,
        ...(inspected.reasons.length > 0 ? { reasons: inspected.reasons } : {}),
      })
      return
    }
    let result
    try {
      result = await removeInstanceWorktree({
        record: workspace.worktree,
        force: false,
        ...(this.gitRunner === undefined ? {} : { runner: this.gitRunner }),
        worktreeRoot: this.worktreeRoot,
      })
    } catch (error) {
      await this._appendResourceEventSafe(instanceId, {
        type: RESOURCE_EVENT.CLEANUP_SKIPPED,
        instanceId,
        workspaceId: workspace.workspaceId,
        reason: error?.code ?? 'remove-failed',
        warning: error?.message ?? String(error),
      })
      return
    }
    const branchRemoval = await this._removeInstanceBranchRecord(workspace.worktree)
    await this._recordWorktreeRemoval(instanceId, workspace, result, branchRemoval)
    if (result.removed === true) {
      try {
        await removeResourceRecord({
          registryRoot: this.worktreeRegistryRoot,
          workspaceId: workspace.workspaceId,
          instanceId,
        })
      } catch {
        // 同上。
      }
    }
  }

  /**
   * 该实例是否还有**物理执行**占用：`_activeAgents` 只在确认退出后才减到 0
   * （start 未返回 / 迟到句柄未 dispose / dispose 抛错 / cleanup.disposed=false 都保留）。
   * 所有删除入口（手动 DELETE、分支删除、prune）都必须先问这一条（review-0139 F3）。
   */
  _executionBusy(instanceId) {
    return (this._activeAgents.get(instanceId) ?? 0) > 0
  }

  async _waitAgentsReleased(instanceId, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if ((this._activeAgents.get(instanceId) ?? 0) === 0) return true
      if (Date.now() >= deadline) return false
      // 等待有界（timeoutMs）且必须让事件循环保持活跃：unref 会让「只有这个等待
      // 还在跑」的进程直接 beforeExit，调用方永远拿不到 false。
      await new Promise(resolveWait => setTimeout(resolveWait, 25))
    }
  }

  /**
   * 记录执行错误：**只写 `lastError`，不改 status**（仍是 ACTIVE）。
   *
   * 这是用户口径的落点：条件求值错 / 超时 / handler 失败 / 恢复失败都只是「发生过一次
   * 错误」，要不要重试、终止还是继续由业务或人决定，引擎不替它判死。
   */
  async _markInstanceError(instanceId, lastError) {
    const instance = await readInstance(instanceId, { instancesRoot: this.instancesRoot })
    if (instance === null) return null
    if (TERMINAL_STATUSES.has(instance.status)) return instance
    try {
      // 执行已停止：待办表清空（否则 UI 会以为人还能接着完成那个节点）。
      return await updateInstance(instanceId, { lastError, pendingTasks: [] }, { instancesRoot: this.instancesRoot })
    } catch (error) {
      if (error?.code === 'INSTANCE_TERMINAL_IMMUTABLE') return null
      throw error
    }
  }

  /** 从 runner 的执行错误生成 `lastError`（保留 handler 自己的 code，例如 adapter 不可用）。 */
  _lastErrorFor(instanceId, error) {
    const recorded = this._runnerErrors.get(instanceId) ?? null
    const code = recorded?.code
      ?? (typeof error?.cause?.code === 'string' && error.cause.code !== '' ? error.cause.code : null)
      ?? (typeof error?.code === 'string' && error.code !== '' ? error.code : null)
      ?? 'BPMN_ENGINE_ERROR'
    const message = recorded?.message ?? errorText(error)
    const lastError = { code, message }
    const reminders = this._agentReminders.get(instanceId)
    if (Number.isSafeInteger(reminders) && reminders >= 0) lastError.reminders = reminders
    if (typeof error?.elementId === 'string' && error.elementId !== '') lastError.nodeId = error.elementId
    if (typeof error?.activityId === 'string' && error.activityId !== '') lastError.activityId = error.activityId
    return lastError
  }

  // -------------------------------------------------------------------------
  // runner 生命周期 / 懒恢复
  // -------------------------------------------------------------------------

  /** 同实例写操作串行（complete / stop / 懒恢复都在同一把锁里）。 */
  async _withInstance(id, task) {
    const previous = this._locks.get(id) ?? Promise.resolve()
    let release
    const gate = new Promise(resolveGate => { release = resolveGate })
    const tail = previous.then(() => gate)
    this._locks.set(id, tail)
    await previous.catch(() => {})
    try {
      return await task()
    } finally {
      release()
      if (this._locks.get(id) === tail) this._locks.delete(id)
    }
  }

  /**
   * 从**实例固定的定义版本 + XML 快照**取 identity：hash 在这里重算（sha256 原文），
   * 不信任任何请求自报值；`readInstanceDefinition` 已核对过快照与 instance.json 的
   * definitionHash 一致，这里只用快照字节本身作为唯一真相。
   *
   * @param {object} definition
   * @param {string} xml
   * @param {string} instanceId
   * @param {object} variables
   * @param {{ definitionId: string, definitionVersion: number }} fixed 实例钉住的定义身份
   */
  _newRunner(definition, xml, instanceId, variables, fixed) {
    const maxActive = positiveEnvInt(this.env[BPMN_MAX_ACTIVE_ENV], this.maxActiveInstances ?? DEFAULT_MAX_ACTIVE_INSTANCES)
    const hash = sha256Hex(xml)
    try {
      return createBpmnRunner({
        definition,
        xml,
        instanceId,
        definitionIdentity: {
          id: fixed.definitionId,
          version: fixed.definitionVersion,
          hash,
        },
        variables: isPlainObject(variables) ? { ...variables } : {},
        services: this._servicesFor(instanceId),
        limits: this._limits(),
        // 快照点由本模块在每次收口后显式 getState()（只取一次），runner 的自动
        // 快照关掉；`getState()` 仍会写 runner 的 `_lastState`，LRU 淘汰检查照常可用。
        shouldSnapshot: () => false,
        maxActiveInstances: maxActive,
      })
    } catch (error) {
      if (error?.code === 'BPMN_INSTANCE_ID_CONFLICT') {
        throw new BpmnRuntimeError(
          503,
          'BPMN_INSTANCE_ACTIVE_ELSEWHERE',
          `同一进程内已有实例 ${instanceId} 的 runner 在活跃表中；先 dispose 旧 runtime 再恢复`,
        )
      }
      throw error
    }
  }

  _servicesFor(instanceId) {
    return {
      executeAgent: (element, ctx) => this._executeAgentFor(instanceId, element, ctx),
      executeHttp: (element, ctx) => this._executeHttpFor(instanceId, element, ctx),
      onEvent: event => this._onRunnerEvent(instanceId, event),
      onTaskWait: () => {},
      onTaskDone: () => {},
      onError: error => this._recordRunnerError(instanceId, error),
    }
  }

  /**
   * http 节点 handler 的 runtime 侧包装：为本次实例注入调用记录目录与宿主策略。
   *
   * 调用记录放在实例目录下（`<instancesRoot>/<instanceId>/connector/`），与实例状态
   * 同生命周期；恢复窗口的「成功复用 / 已发送不重发」由 connector-store 保证。
   */
  async _executeHttpFor(instanceId, element, ctx) {
    const store = createConnectorStore({ root: join(this.instancesRoot, instanceId, 'connector') })
    return await executeHttpConnector(element, ctx, {
      policy: this.httpPolicy,
      policies: this.httpPolicies,
      store,
      env: this.env,
      ...(this.httpAuthResolver === null ? {} : { authResolver: this.httpAuthResolver }),
    })
  }

  /**
   * agent 节点 handler 的 runtime 侧包装：接适配器注册表 + probe 缓存，并记住
   * 最后一个成功 agent 节点的输出 / 本次 activity 的 summary（11 §5）。
   *
   * 注意：`executeAgent` 导出函数本身保持无实例状态的纯行为（测试可单独调用）；
   * 与实例相关的收口（变量合并由 runner 做、产物与 result 由本类做）在这里。
   */
  /**
   * 实例冻结工作区：成功时缓存；缺失 / 损坏 / 目录不可用都返回 WORKSPACE_UNAVAILABLE，
   * **不静默回退宿主目录**。旧实例（从未写过 workspace.json、registry 里也没有记录）
   * 才返回 `workspace:null`，保持 0.13.6 之前的行为。
   */
  async _workspaceFor(instanceId) {
    const cached = this._workspaces.get(instanceId)
    if (cached !== undefined) return cached
    let snapshot
    try {
      snapshot = await readWorkspaceSnapshot({ instancesRoot: this.instancesRoot, instanceId })
    } catch (error) {
      return {
        workspace: null,
        error: {
          code: WORKSPACE_ERROR.UNAVAILABLE,
          message: `实例 ${instanceId} 的工作区快照损坏：${error?.message ?? error}`,
        },
      }
    }
    if (snapshot === null) {
      // 快照丢了但所有权记录还在：说明这个实例**应当**有 worktree，不能回退宿主目录。
      try {
        const { records, corrupt } = await scanResourceRecords({ registryRoot: this.worktreeRegistryRoot })
        const owned = records.some(record => record.instanceId === instanceId)
        const damaged = corrupt.some(item => item.instanceId === instanceId)
        if (owned || damaged) {
          return {
            workspace: null,
            error: {
              code: WORKSPACE_ERROR.UNAVAILABLE,
              message: `实例 ${instanceId} 的 worktree 所有权记录存在但工作区快照缺失（不静默回退宿主目录）`,
            },
          }
        }
      } catch {
        // registry 不可读：旧实例仍按无工作区处理（不把诊断失败升级成启动失败）。
      }
      return { workspace: null, error: null }
    }
    try {
      if (!isPlainObject(snapshot) || snapshot.instanceId !== instanceId) {
        throw new Error('快照 instanceId 不一致')
      }
      if (snapshot.mode !== 'worktree' && snapshot.mode !== 'off') {
        throw new Error(`快照 mode 非法：${String(snapshot.mode)}`)
      }
      if (typeof snapshot.effectiveRoot !== 'string' || !isAbsolute(snapshot.effectiveRoot)) {
        throw new Error('快照 effectiveRoot 不是绝对路径')
      }
      if (snapshot.mode === 'worktree'
        && (!isPlainObject(snapshot.worktree) || snapshot.worktree.v !== 1)) {
        throw new Error('worktree 模式下缺少冻结的 worktree 记录')
      }
      if (!existsSync(snapshot.effectiveRoot)) {
        throw new Error(`工作区目录不可用：${snapshot.effectiveRoot}`)
      }
    } catch (error) {
      return {
        workspace: null,
        error: {
          code: WORKSPACE_ERROR.UNAVAILABLE,
          message: `实例 ${instanceId} 的工作区不可用：${error?.message ?? error}`,
        },
      }
    }
    const state = { workspace: snapshot, error: null }
    this._workspaces.set(instanceId, state)
    return state
  }

  /**
   * agent 节点 handler 的 runtime 侧包装：接适配器注册表 + probe 缓存，并记住
   * 最后一个成功 agent 节点的输出 / 本次 activity 的 summary（11 §5）。
   *
   * 0.13.7 起 document root / adapter cwd 都来自**同一份冻结工作区记录**；worktree
   * 模式下槽位按真实 agent 执行占用，执行结束（含失败 / 取消）立即释放。
   */
  async _executeAgentFor(instanceId, element, ctx) {
    const workspaceState = await this._workspaceFor(instanceId)
    if (workspaceState.error !== null) {
      throw handlerError(workspaceState.error.code, workspaceState.error.message, {
        instanceId,
        nodeId: element?.id ?? null,
        activityId: ctx?.executionId ?? null,
      })
    }
    const workspace = workspaceState.workspace
    const workspaceRoot = workspace === null ? this.workspaceRoot : workspace.effectiveRoot
    const workspaceId = workspace === null ? 'default' : workspace.workspaceId

    let ticket
    try {
      ticket = await this.executionLimits.acquire({ workspaceId, signal: ctx?.signal })
    } catch (error) {
      throw handlerError(
        typeof error?.code === 'string' && error.code !== '' ? error.code : 'EXECUTION_LIMIT_UNAVAILABLE',
        error?.message ?? String(error),
        { instanceId, nodeId: element?.id ?? null, workspaceId },
      )
    }
    this._activeAgents.set(instanceId, (this._activeAgents.get(instanceId) ?? 0) + 1)
    // 在飞活动的定位信息（挂起 409 的可读原因用）；计数仍以 `_activeAgents` 为准。
    const agentKey = typeof ctx?.executionId === 'string' && ctx.executionId !== ''
      ? ctx.executionId
      : `${element?.id ?? 'agent'}:${this._activeAgents.get(instanceId)}`
    const agentActivities = this._activeAgentActivities.get(instanceId) ?? new Map()
    agentActivities.set(agentKey, {
      elementId: typeof element?.id === 'string' && element.id !== '' ? element.id : null,
      executionId: typeof ctx?.executionId === 'string' && ctx.executionId !== '' ? ctx.executionId : null,
    })
    this._activeAgentActivities.set(instanceId, agentActivities)
    // 物理执行生命周期：handler 返回不代表 agent 进程已退出（W4）。
    const lifecycle = createExecutionLifecycle({ cleanupFinalWaitMs: this.cleanupFinalWaitMs })
    const adapters = this.adapters === null ? null : lifecycle.adaptersFor(this.adapters)
    let result
    try {
      result = await executeAgent(element, ctx, {
        adapters,
        probeAdapter: this._probeAdapter,
        workspaceRoot,
        workspace,
        workspaceId,
        artifactStore: this.artifactStore,
        instanceId,
        // 0.13.10：句柄可用后登记 live execution，并把排队消息投给本次执行。
        onStart: async (handle, info) => {
          await this.inbox.registerExecution({
            instanceId,
            activityId: typeof element?.id === 'string' ? element.id : null,
            executionId: info.executionId,
            attempt: info.attempt,
            kind: 'agent',
            adapterId: info.adapterId ?? null,
            adapter: info.adapter ?? null,
            handle,
            workspaceRoot: info.workspaceRoot,
            cold: this._recoveredInstances.has(instanceId),
          })
        },
        // 0.13.10：会话内注册绑定本实例 / 本执行的工具，改参数不能跨实例。
        registerTools: agentCtx => this._registerInboxTools(agentCtx, {
          instanceId,
          executionId: typeof ctx?.executionId === 'string' ? ctx.executionId : null,
          activityId: typeof element?.id === 'string' ? element.id : null,
        }),
      })
    } catch (error) {
      // 失败落点（如 NODE_FINISH_MISSING）也必须让提醒事件进实例事件流：
      // handler 抛错时 runner 不会处理它的 events[]，这里补一次透传。
      if (error && Array.isArray(error.events)) {
        for (const event of error.events) {
          if (!isPlainObject(event) || typeof event.type !== 'string' || event.type === '') continue
          this._onRunnerEvent(instanceId, {
            ...event,
            elementId: typeof element?.id === 'string' ? element.id : undefined,
            activityId: typeof ctx?.executionId === 'string' ? ctx.executionId : undefined,
          })
        }
      }
      if (error && Number.isSafeInteger(error.reminders) && error.reminders >= 0) {
        this._agentReminders.set(instanceId, error.reminders)
      }
      throw error
    } finally {
      // 0.13.10：执行结束（成功 / 失败 / 取消）先摘掉 live 表，未投递完的消息按过期处理。
      if (typeof ctx?.executionId === 'string' && ctx.executionId !== '') {
        try {
          await this.inbox.finishExecution({ instanceId, executionId: ctx.executionId })
        } catch {
          // 收件箱收尾失败不改变节点结局。
        }
      }
      const releaseExecution = () => {
        ticket.release()
        agentActivities.delete(agentKey)
        if (agentActivities.size === 0) this._activeAgentActivities.delete(instanceId)
        const remaining = (this._activeAgents.get(instanceId) ?? 1) - 1
        if (remaining <= 0) this._activeAgents.delete(instanceId)
        else this._activeAgents.set(instanceId, remaining)
      }
      // 槽位 / activeAgents 只在物理执行确认退出后释放；start 未返回、迟到句柄
      // 未 dispose、dispose 抛错或报告 disposed=false 时保持占用（禁止自动清理）。
      if (lifecycle.idle()) releaseExecution()
      else lifecycle.whenIdle().then(releaseExecution, releaseExecution)
    }
    // 成功执行后清掉上一次失败留下的提醒计数（lastError 随后也会被清/覆盖）。
    this._agentReminders.delete(instanceId)
    if (result && isPlainObject(result.output)) {
      // 11 §5：result 取「最后一个成功 agent 节点的 output」；来源 nodeId 一起记住，
      // 并在收口时随 instance.json 持久化（review-0131 #4）。
      this._lastAgentOutputs.set(instanceId, {
        nodeId: typeof element?.id === 'string' && element.id !== '' ? element.id : null,
        output: { ...result.output },
      })
    }
    if (result && typeof result.summary === 'string'
      && ctx && typeof ctx.executionId === 'string' && ctx.executionId !== '') {
      this._agentSummaries.set(`${instanceId}\0${ctx.executionId}`, result.summary)
    }
    return result
  }

  /** 取走本次 activity 的 summary（只消费一次，避免 map 泄漏）。 */
  _takeAgentSummary(instanceId, activityId) {
    if (typeof activityId !== 'string' || activityId === '') return undefined
    const key = `${instanceId}\0${activityId}`
    if (!this._agentSummaries.has(key)) return undefined
    const summary = this._agentSummaries.get(key)
    this._agentSummaries.delete(key)
    return summary
  }

  /**
   * 把收件箱工具注册进**本次 agent 会话**（0.13.10）。
   *
   * binding 固定 instanceId / executionId：模型改 instanceId 会被工具本地拒绝，
   * 因此不能通过参数跨实例投递。只注册 send / reply，不把 worktree 工具塞进节点会话。
   */
  _registerInboxTools(agentCtx, binding) {
    const toolsSvc = agentCtx && agentCtx.tools
    if (!toolsSvc || typeof toolsSvc.register !== 'function') return undefined
    const tools = createInstanceTools({ getRuntime: () => this, binding })
      .filter(tool => tool.name === 'flow_instance_send_message' || tool.name === 'flow_instance_reply')
    const disposers = tools.map(tool => toolsSvc.register(tool))
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // 注销失败不影响节点收尾。
        }
      }
    }
  }

  _limits() {
    const limits = {}
    const activityWaitMs = positiveEnvInt(this.env[BPMN_ACTIVITY_TIMEOUT_ENV], null)
    if (activityWaitMs !== null) limits.activityWaitMs = activityWaitMs
    return limits
  }

  /**
   * 取 runner：内存里有就用；没有且实例非终态时按 state + 定义快照懒恢复。
   * @returns {Promise<{runner: any|null, recovered: boolean, reason?: string, code?: string|null}>}
   */
  async _ensureRunner(instance) {
    // 终态最先判：已结束的实例不需要恢复，也不该被停止闩影响成「恢复失败」。
    if (TERMINAL_STATUSES.has(instance.status)) {
      return {
        runner: null,
        recovered: false,
        reason: `实例已是终态 ${instance.status}，没有可推进的点`,
        code: null,
      }
    }
    // 停止闩：stop 已经接管这个实例，谁都不许再懒恢复 / 推进。
    if (this._stopping.has(instance.id)) {
      return {
        runner: null,
        recovered: false,
        reason: '实例正在停止（stop 已置停止闩）',
        code: 'BPMN_STATE_STOPPING',
      }
    }
    // 0.14.3：挂起（SUSPENDED）不是终态，但和终态一样**不得因读而恢复 / 推进**。
    // 0.14.4：只认磁盘 status 这一份权威事实（`_suspended` 内存闩已删除）。
    if (instance.status === 'SUSPENDED') {
      return {
        runner: null,
        recovered: false,
        reason: `实例 ${instance.id} 已挂起（SUSPENDED）：挂起期间不懒恢复、不派发活动；先 resume 再推进`,
        code: 'BPMN_STATE_SUSPENDED',
      }
    }
    // 恢复「最后一个成功 agent 输出 + 来源节点」（review-0131 #4）：它随 instance.json
    // 的小字段 `lastAgentOutput` 持久化，内存 Map 只是它的一份读缓存；进程重启 /
    // dispose 之后必须能从快照重建，否则流程跑完时 result 会丢。
    if (!this._lastAgentOutputs.has(instance.id)
      && isPlainObject(instance.lastAgentOutput)
      && isPlainObject(instance.lastAgentOutput.output)) {
      this._lastAgentOutputs.set(instance.id, {
        nodeId: typeof instance.lastAgentOutput.nodeId === 'string' && instance.lastAgentOutput.nodeId !== ''
          ? instance.lastAgentOutput.nodeId
          : null,
        output: { ...instance.lastAgentOutput.output },
      })
    }
    // ---------------------------------------------------------------
    // 0.14.4 执行所有权（跨进程）
    // ---------------------------------------------------------------
    // 另一个**活着**的 runtime 持有执行时，本进程既不能恢复 runner，也不能派发
    // （否则同一个实例会有两个执行器）。坏 JSON / 跨主机是 unknown：保守拒绝，
    // 不把它当成 gone 去抢。
    const ownerInfo = await readInstanceOwner(instance.id, { instancesRoot: this.instancesRoot })
    const owner = ownerInfo !== null && isPlainObject(ownerInfo.owner) ? ownerInfo.owner : null
    const mine = owner !== null && owner.runtimeId === this.runtimeId
    if (ownerInfo !== null && !mine && this._isForeignOwner(ownerInfo)) {
      if (ownerInfo.state === 'alive') {
        return {
          runner: null,
          recovered: false,
          reason: `实例 ${instance.id} 的执行权被另一个活进程持有（pid ${owner.pid} @ ${owner.host}，自 ${owner.since ?? '未知时间'}）：本进程不恢复、不派发`,
          code: 'BPMN_INSTANCE_ACTIVE_ELSEWHERE',
          owner,
        }
      }
      return {
        runner: null,
        recovered: false,
        reason: `实例 ${instance.id} 的执行所有权记录无法确认（坏 JSON / 跨主机）：为安全起见不恢复、不派发；请人工核对 owner.json`,
        code: 'BPMN_OWNER_UNKNOWN',
        owner,
      }
    }
    const ownedByMe = mine && ownerInfo.state === 'alive'

    // NEW-1 / MAJOR-1 残余：**在恢复 / 派发之前**真正拿到所有权。
    //
    // 0.14.4 在 runner 建好之后才 claim，且 claim 是无条件覆盖：准备窗口里别的进程
    // 可以 suspend，两个进程也能各写一份 owner 后各自派发。现在 claim 走跨进程
    // flock 互斥，拿不到就在这里返回 409（runner=null），recover / adapter 一步都不走。
    if (!ownedByMe) {
      try {
        await this._claimOwner(instance.id)
      } catch (error) {
        if (error instanceof BpmnRuntimeError) {
          return {
            runner: null,
            recovered: false,
            reason: error.message,
            code: error.code,
            ...(isPlainObject(error.owner) ? { owner: error.owner } : {}),
          }
        }
        throw error
      }
    }

    // NEW-3：已确认的失败事实优先于**任何**缓存 runner。失败标记一旦落盘，
    // 旧 runner 不能再被当缓存使用（否则 complete 会走缓存返回 200 / COMPLETED）。
    if (isPlainObject(instance.executionFailure)) {
      await this._dropRunner(instance.id)
      // `lastError` 可能是更精确的收口错误（handler 的 cause code），与墓碑同一口径。
      const code = (typeof instance.lastError?.code === 'string' && instance.lastError.code !== '')
        ? instance.lastError.code
        : (typeof instance.executionFailure.code === 'string' && instance.executionFailure.code !== ''
          ? instance.executionFailure.code
          : 'BPMN_STATE_UNRECOVERABLE')
      const message = (typeof instance.lastError?.message === 'string' && instance.lastError.message !== '')
        ? instance.lastError.message
        : (typeof instance.executionFailure.message === 'string' ? instance.executionFailure.message : '执行已确认失败')
      await this._releaseOwnerIfIdle(instance.id)
      return {
        runner: null,
        recovered: false,
        blocked: true,
        reason: `实例因执行失败已不可恢复（${code}）：${message}。`
          + '这是已落盘的失败事实，不能自动重放旧执行位置；人工处置：retry / mark-* 只解除 connector 调用记录限制，'
          + '当前实例仍不能继续；若要移除失败标记与墓碑，请用 POST /instances/<id>/connector/<recordId>/resolve '
          + '{ action: "clear-tombstone", evidence }，清除后实例不会自动恢复，仍需人工决定是否新建实例。',
        code,
        failure: instance.executionFailure,
      }
    }

    const cached = this._runners.get(instance.id)
    if (cached !== undefined && cached.status() !== 'idle') {
      return { runner: cached, recovered: false }
    }
    if (cached !== undefined) this._runners.delete(instance.id)

    let state
    try {
      state = await readInstanceState(instance.id, { instancesRoot: this.instancesRoot })
    } catch (error) {
      await this._releaseOwnerIfIdle(instance.id)
      throw new BpmnRuntimeError(500, 'BPMN_STATE_READ_FAILED', `读取实例 ${instance.id} 的 state.json 失败：${errorText(error)}`, {
        instanceId: instance.id,
      })
    }
    if (state === null || state === undefined) {
      await this._releaseOwnerIfIdle(instance.id)
      return {
        runner: null,
        recovered: false,
        reason: '没有可恢复的引擎快照（state.json 不存在或为空）',
        code: 'BPMN_STATE_MISSING',
      }
    }
    // 失败停机后快照被写成「不可恢复」墓碑：保留 ACTIVE + lastError 是事实，但绝不允许
    // 重启 / 淘汰后自动恢复旧执行位置（否则 complete 可以重放失败前的工作）。
    if (isPlainObject(state.unrecoverable)) {
      const code = typeof state.unrecoverable.code === 'string' && state.unrecoverable.code !== ''
        ? state.unrecoverable.code
        : 'BPMN_STATE_UNRECOVERABLE'
      await this._releaseOwnerIfIdle(instance.id)
      return {
        runner: null,
        recovered: false,
        // m1：说明处置边界——retry 只解除调用记录限制；要解除墓碑必须显式
        // clear-tombstone，而且清除后本实例仍不能自动继续（引擎快照已被墓碑替换）。
        reason: `实例因执行失败已停机（${code}），快照被标记为不可恢复：${typeof state.unrecoverable.message === 'string' ? state.unrecoverable.message : '需要人工处理后重新创建实例'}。`
          + '人工处置：retry / mark-* 只解除 connector 调用记录限制，当前实例仍不能继续；'
          + '若要移除本墓碑，请用 POST /instances/<id>/connector/<recordId>/resolve '
          + '{ action: "clear-tombstone", evidence }；清除后实例不会自动恢复，仍需人工决定是否新建实例。',
        code,
      }
    }

    let snapshot
    try {
      snapshot = await this._readDefinitionSnapshot(instance.id)
    } catch (error) {
      await this._releaseOwnerIfIdle(instance.id)
      throw error
    }
    if (snapshot === null) {
      await this._releaseOwnerIfIdle(instance.id)
      throw new BpmnRuntimeError(500, 'INSTANCE_SNAPSHOT_MISSING', `实例 ${instance.id} 的定义快照缺失`, {
        instanceId: instance.id,
      })
    }
    let parsed
    try {
      parsed = await parseBpmn(snapshot.xml)
    } catch (error) {
      await this._releaseOwnerIfIdle(instance.id)
      throw error
    }
    // 恢复准备也是异步的：stop 在读取/解析期间同样可能已经返回 CANCELED。
    // 这里到 runner 创建之间没有 await，复查必须同步完成（review-0131 #1）。
    const stoppedWhilePreparing = this._latchBlockForPrepare(instance.id)
    if (stoppedWhilePreparing !== null) {
      return {
        runner: null,
        recovered: false,
        reason: stoppedWhilePreparing.reason,
        code: stoppedWhilePreparing.code,
      }
    }
    if (!parsed.ok) {
      await this._releaseOwnerIfIdle(instance.id)
      throw new BpmnRuntimeError(500, 'BPMN_DEFINITION_INVALID', `实例 ${instance.id} 的定义快照未通过 BPMN 校验`, {
        errors: parsed.errors,
      })
    }

    // MAJOR-1 残余：准备完成、真正派发之前，从**磁盘**重新取得准入。
    //
    // 准备（state / 定义快照 / 解析）是异步的；期间别的进程可能已经提交 SUSPENDED
    // 或终态。仍然拿进入 `_ensureRunner` 时的旧快照建 runner / recover / 派发，会让
    // 事件被 store 闸门丢掉，内存 runner 与磁盘分裂（复审 O dispatch_after_suspend）。
    const admission = await readInstance(instance.id, { instancesRoot: this.instancesRoot })
    if (admission !== null && TERMINAL_STATUSES.has(admission.status)) {
      await this._releaseOwnerIfIdle(instance.id)
      return {
        runner: null,
        recovered: false,
        reason: `实例 ${instance.id} 在准备期间已是终态 ${admission.status}，本次不恢复、不派发`,
        code: null,
      }
    }
    if (admission !== null && admission.status === 'SUSPENDED') {
      await this._releaseOwnerIfIdle(instance.id)
      return {
        runner: null,
        recovered: false,
        reason: `实例 ${instance.id} 在准备期间被挂起（SUSPENDED）：本次不恢复、不派发，等 resume 后再推进`,
        code: 'BPMN_STATE_SUSPENDED',
      }
    }

    let runner
    try {
      runner = this._newRunner(parsed.definition, snapshot.xml, instance.id, instance.variables, {
        definitionId: snapshot.definitionId,
        definitionVersion: snapshot.definitionVersion,
      })
    } catch (error) {
      // 同进程 runner 活跃表冲突（BPMN_INSTANCE_ID_CONFLICT）等：本次没产出 runner，
      // 不能把所有权留在自己手上（否则别的进程会一直看到活 owner 却没人执行）。
      await this._releaseOwnerIfIdle(instance.id)
      throw error
    }
    this._runners.set(instance.id, runner)
    // recover 会重放一次 activity/wait（runner 坑 g）：按 state 里已知的 executionId 去重。
    const pending = Array.isArray(state?.pendingTasks) ? state.pendingTasks : []
    this._suppressWait.set(instance.id, new Set(
      pending.map(task => (typeof task?.executionId === 'string' ? task.executionId : null)).filter(Boolean),
    ))
    try {
      await runner.recover(state)
    } catch (error) {
      this._suppressWait.delete(instance.id)
      this._runners.delete(instance.id)
      try {
        await runner.stop()
      } catch {
        // 恢复失败时 stop 只是清活跃表；失败不影响「不可恢复」结论。
      }
      await this._releaseOwnerIfIdle(instance.id)
      const code = typeof error?.code === 'string' ? error.code : 'BPMN_STATE_RECOVER_FAILED'
      const reason = `state 不可恢复：${errorText(error)}`
      // 快照/定义无法反序列化或结构不一致 = 引擎不可恢复：实例卡住（blocked），
      // 不是 failed。missing 快照也按卡住处理（等人补数据 / 将来 retry）。
      if (code !== 'BPMN_STATE_STOPPING' && !this._stopping.has(instance.id)) {
        await this._markInstanceError(instance.id, {
          code,
          message: reason,
          ...(typeof error?.elementId === 'string' ? { nodeId: error.elementId } : {}),
        })
      }
      return {
        runner: null,
        recovered: false,
        reason,
        code,
      }
    } finally {
      this._suppressWait.delete(instance.id)
    }

    if (this._stopping.has(instance.id)) {
      // recover 进行中 stop 进来了：恢复出来的 runner 立刻停掉，不参与后续推进。
      try {
        await runner.stop()
      } catch {
        // 同上。
      }
      this._runners.delete(instance.id)
      return { runner: null, recovered: false, reason: '实例在恢复过程中被停止', code: 'BPMN_STATE_STOPPING' }
    }

    await this._afterSettle(instance.id, runner)
    this._recoveredInstances.add(instance.id)
    return { runner, recovered: true }
  }

  /** 每次操作收口：事件落盘 → 快照落盘 → 实例状态同步；任何失败都显式抛出。 */
  async _afterSettle(instanceId, runner) {
    const failures = await this._flushEvents(instanceId)
    if (failures.length > 0) {
      throw new BpmnRuntimeError(
        500,
        'BPMN_EVENT_WRITE_FAILED',
        `实例 ${instanceId} 的事件写入失败（${failures.length} 条）`,
        { instanceId, eventErrors: failures.map(item => ({ code: item.code ?? 'BPMN_EVENT_WRITE_FAILED', message: errorText(item) })) },
      )
    }
    try {
      await this._persistState(instanceId, runner)
    } catch (error) {
      if (error instanceof BpmnRuntimeError) throw error
      throw new BpmnRuntimeError(500, 'BPMN_STATE_WRITE_FAILED', `实例 ${instanceId} 的 state.json 写入失败：${errorText(error)}`, {
        instanceId,
      })
    }
    await this._syncInstanceStatus(instanceId, runner)
  }

  /** 只在等待 / 运行中落盘（done / blocked 不需要恢复）——每次收口只取一次快照。 */
  async _persistState(instanceId, runner) {
    const status = runner.status()
    if (status !== 'waiting' && status !== 'running') return
    const state = await runner.getState()
    try {
      await writeInstanceState(instanceId, state, { instancesRoot: this.instancesRoot })
    } catch (error) {
      // stop 已经先一步把实例收成终态：晚到的快照不许覆盖，按「stop 赢」静默跳过。
      if (error?.code === 'INSTANCE_TERMINAL_IMMUTABLE') return
      // 挂起先一步提交：晚到的执行快照同样不许覆盖（挂起不写引擎快照）。
      if (error?.code === 'INSTANCE_SUSPENDED') return
      throw error
    }
  }

  /**
   * 失败停机：把持久化快照写成**不可恢复墓碑**（保留实例 ACTIVE + lastError）。
   *
   * 旧快照（waiting/running）若留着，重启 / 淘汰后 `_ensureRunner` 会自动恢复它，
   * 后续 complete 就能重放失败前的工作——「保留 ACTIVE」不等于「应该自动重试」。
   * 墓碑里写清 code/message/at；恢复路径遇到它必须给出明确错误码且零派发。
   */
  async _persistUnrecoverableState(instanceId, lastError) {
    try {
      await writeInstanceState(instanceId, {
        v: BPMN_STATE_VERSION,
        kind: BPMN_STATE_KIND,
        instanceId,
        status: BPMN_RUNNER_STATUS.BLOCKED,
        unrecoverable: {
          code: lastError?.code ?? 'BPMN_STATE_UNRECOVERABLE',
          message: lastError?.message ?? '',
          at: new Date().toISOString(),
        },
        engine: null,
      }, { instancesRoot: this.instancesRoot, allowWhileSuspended: true })
    } catch (error) {
      if (error?.code === 'INSTANCE_TERMINAL_IMMUTABLE') return
      throw error
    }
  }

  /**
   * 用 runner 的真实状态校正实例元数据（事件链已写过一次，这里幂等兜底）。
   *
   * 终态（done / aborted）先检查：已经结束的实例绝不再写任何字段。
   * runner 侧 `blocked` → **只写 `lastError`，实例 status 保持 ACTIVE**（不判死）。
   * 最终 variables / result 与 status 在同一次 updateInstance / completeInstance 提交。
   */
  async _syncInstanceStatus(instanceId, runner) {
    const instance = await readInstance(instanceId, { instancesRoot: this.instancesRoot })
    if (instance === null) return
    if (TERMINAL_STATUSES.has(instance.status)) return
    // stop 闩生效期间不要再写状态（stop 自己会把实例收成 aborted）。
    if (this._stopping.has(instanceId)) return
    // 挂起期间收口不得改待办 / 变量，更不能把 status 写回 ACTIVE。
    if (instance.status === 'SUSPENDED') return

    const status = runner.status()
    const variables = isPlainObject(runner.variables) && Object.keys(runner.variables).length > 0
      ? runner.variables
      : undefined
    // 最后一个成功 agent 输出（+来源节点）随快照持久化：恢复后 result 不能靠内存 Map。
    const lastAgent = this._lastAgentOutputs.get(instanceId)
    const lastAgentPatch = isPlainObject(lastAgent) && isPlainObject(lastAgent.output)
      ? {
        lastAgentOutput: {
          nodeId: typeof lastAgent.nodeId === 'string' && lastAgent.nodeId !== '' ? lastAgent.nodeId : null,
          output: { ...lastAgent.output },
        },
      }
      : null

    try {
      if (status === 'done') {
        // 11 §5：process/end 时 instance.result 取最后一个成功 agent 节点的 output
        // （endEvent 不产生输出）。output 在 gate 里已归一化为短变量对象。
        const result = lastAgentPatch === null ? undefined : { ...lastAgentPatch.lastAgentOutput.output }
        await completeInstance(instanceId, 'COMPLETED', {
          instancesRoot: this.instancesRoot,
          ...(variables === undefined ? {} : { variables }),
          ...(result === undefined ? {} : { result }),
        })
        await this._finalizeInbox(instanceId, 'COMPLETED')
        this._lastAgentOutputs.delete(instanceId)
        await this._maybeTerminalCleanup(instanceId).catch(() => {})
        return
      }
      if (status === BPMN_RUNNER_STATUS.BLOCKED) {
        const lastError = this._lastErrorFor(instanceId, runner.failure())
        const marked = await this._markInstanceError(instanceId, lastError)
        // stop 抢先把实例收成终态时不写墓碑（终态实例本来就不会被恢复）。
        if (marked !== null && !TERMINAL_STATUSES.has(marked.status)) {
          await this._persistUnrecoverableState(instanceId, lastError)
        }
        return
      }
      if (status === 'waiting') {
        // 0.14.4：不再写 status:'ACTIVE'——状态迁移只走生命周期路由；这里只更新执行事实。
        const patch = {
          pendingTasks: runner.pendingTasks(),
          ...(variables === undefined ? {} : { variables }),
          ...(lastAgentPatch === null ? {} : lastAgentPatch),
        }
        await updateInstance(instanceId, patch, { instancesRoot: this.instancesRoot })
        return
      }
      if (status === 'running') {
        const patch = {
          ...(variables === undefined ? {} : { variables }),
          ...(lastAgentPatch === null ? {} : lastAgentPatch),
        }
        if (Object.keys(patch).length === 0) return
        await updateInstance(instanceId, patch, { instancesRoot: this.instancesRoot })
      }
    } catch (error) {
      // 收口撞上挂起 / 生命周期切换：磁盘事实优先，不崩、不改写、不丢已有事实。
      // 其它错误照旧抛给调用方（事件写入失败 / 终态保护等）。
      if (isLifecycleSuspendedError(error)) return
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // 事件桥
  // -------------------------------------------------------------------------

  _recordRunnerError(instanceId, error) {
    const innerCode = typeof error?.cause?.code === 'string' && error.cause.code !== ''
      ? error.cause.code
      : (typeof error?.code === 'string' && error.code !== '' ? error.code : 'BPMN_ENGINE_ERROR')
    const innerMessage = typeof error?.cause?.message === 'string' && error.cause.message !== ''
      ? error.cause.message
      : errorText(error)
    this._runnerErrors.set(instanceId, { code: innerCode, message: innerMessage })
  }

  _onRunnerEvent(instanceId, event) {
    if (!isPlainObject(event) || typeof event.type !== 'string' || event.type === '') return
    // stop 闩之后的迟到事件（abort 前已在飞的调用）一律不落盘：不能给 aborted 实例补事件。
    if (this._stopping.has(instanceId)) return
    const runner = this._runners.get(instanceId) ?? null

    // recover 重放的 wait：同一 executionId 已经落过盘，不再写第二条。
    if (event.type === 'activity/wait') {
      const suppress = this._suppressWait.get(instanceId)
      if (suppress !== undefined) {
        const executionId = typeof event.activityId === 'string' ? event.activityId : null
        if (executionId !== null && suppress.has(executionId)) {
          suppress.delete(executionId)
          return
        }
      }
    }

    // 0.13.10：人工任务进入 wait = 一个可投递的 human execution；只登记，不推进。
    if (event.type === 'activity/wait') {
      const elementId = typeof event.elementId === 'string' ? event.elementId : ''
      const executionId = typeof event.activityId === 'string' ? event.activityId : ''
      if (elementId !== '' && executionId !== '') {
        void this.inbox.registerExecution({
          instanceId,
          activityId: elementId,
          executionId,
          attempt: this._attempts.get(elementId) ?? 1,
          kind: 'human',
        }).catch(() => {
          // 收件箱登记失败不影响流程推进。
        })
      }
    }
    // 活动结束（人工完成 / agent 收口）：live execution 失效，未投递消息按过期处理。
    if (event.type === 'activity/end' && typeof event.activityId === 'string' && event.activityId !== '') {
      void this.inbox.finishExecution({ instanceId, executionId: event.activityId }).catch(() => {
        // 同上。
      })
    }

    const activityId = shardIdOf(event)
    const attempt = this._nextAttempt(instanceId, event)
    // 11 §5：activity/end 除了 runner 已带的 output/artifacts，还要带本次 agent 的 summary。
    // summary 只存在 runtime 的短期表里（runner 的 handler 结果契约不额外扩字段）。
    let persistedSource = event
    if (event.type === 'activity/end') {
      const summary = this._takeAgentSummary(instanceId, event.activityId)
      if (summary !== undefined) persistedSource = { ...event, summary }
    }
    const persisted = persistableEvent(persistedSource)
    // 0.14.4：同步登记「未完成的事件提交」。挂起看到 >0 必须 409，不能把已出队当完成。
    this._bumpPendingEventCommits(instanceId, 1)
    this._enqueueEvent(instanceId, async () => {
      try {
        if (persisted === null) {
          throw new BpmnRuntimeError(500, 'BPMN_EVENT_UNSERIALIZABLE', `实例 ${instanceId} 的事件 ${event.type} 不能被序列化为 JSON`)
        }
        // stop 之后不再落盘（同步闩已经挡住绝大多数；排队期间 stop 由终态保护兜底）。
        if (this._stopping.has(instanceId)) {
          this._recordEventDiagnostic(instanceId, { type: event.type, reason: 'stopping' })
          return
        }
        if (event.type === 'error') {
          // MAJOR-3：错误事实通道。即使实例已 SUSPENDED，也要把 error 事件、lastError
          // 和清空后的待办一次写下去（超时不会因为挂起而「没发生过」）。
          const reminders = this._agentReminders.get(instanceId)
          const lastError = {
            code: typeof event.error?.code === 'string' ? event.error.code : 'BPMN_ENGINE_ERROR',
            message: typeof event.error?.message === 'string' ? event.error.message : '',
            ...(Number.isSafeInteger(reminders) && reminders >= 0 ? { reminders } : {}),
            ...(typeof event.elementId === 'string' ? { nodeId: event.elementId } : {}),
            ...(typeof event.activityId === 'string' ? { activityId: event.activityId } : {}),
          }
          await recordExecutionFailure(instanceId, {
            instancesRoot: this.instancesRoot,
            lastError,
            event: persisted,
            activityId,
            attempt,
          })
          // 失败事实一旦落盘，旧快照立刻变成不可恢复（挂起期间也允许写错误墓碑）。
          await this._persistUnrecoverableState(instanceId, lastError)
          return
        }

        // 事件和必要的执行事实（pendingTasks）一次提交；不再单独 updateInstance(ACTIVE)。
        const metaPatch = (event.type === 'activity/wait' || event.type === 'activity/end')
          ? { pendingTasks: runner === null ? [] : runner.pendingTasks() }
          : undefined
        await appendInstanceEvents(instanceId, activityId, attempt, persisted, {
          instancesRoot: this.instancesRoot,
          ...(metaPatch === undefined ? {} : { metaPatch }),
        })
        if (event.type === 'activity/end' && Array.isArray(event.artifacts)) {
          // 产物索引仍走 updateInstance（metaPatch 白名单不含 artifacts）；终态 / 挂起
          // 时 store 会拒绝或本任务已提前丢弃。
          await this._mergeArtifacts(instanceId, event.artifacts)
        }
        // 终态 / blocked 一律由 `_syncInstanceStatus` 在收口时一次提交：
        // 事件链只负责落盘，不抢先把 status 写死（否则最终 variables 会被终态保护挡住）。
      } catch (error) {
        // 另一个请求先收成终态：晚到事件丢弃，不升级成事件写入失败。
        if (error?.code === 'INSTANCE_TERMINAL_IMMUTABLE') return
        // 挂起先一步提交：store 的 SUSPENDED 闸门拒掉这次追加，丢弃并记诊断（零写入）。
        if (error?.code === 'INSTANCE_SUSPENDED') {
          this._recordEventDiagnostic(instanceId, { type: event.type, reason: 'suspended', code: error.code })
          return
        }
        throw error
      } finally {
        this._bumpPendingEventCommits(instanceId, -1)
      }
    })
  }

  /**
   * 把 `flow_finish_node` 登记的产物引用合并进 `instance.json.artifacts[]`。
   *
   * 去重键固定 `path + sha256`：同一活动重试、同一文件被多个节点引用都不会重复追加；
   * 内容变了（hash 不同）则是新产物。终态实例不再写（由 store 的终态保护兜底）。
   */
  async _mergeArtifacts(instanceId, artifacts) {
    if (!Array.isArray(artifacts) || artifacts.length === 0) return
    const instance = await readInstance(instanceId, { instancesRoot: this.instancesRoot })
    if (instance === null || TERMINAL_STATUSES.has(instance.status)) return
    const current = Array.isArray(instance.artifacts) ? instance.artifacts : []
    const artifactKey = item => `${item?.path ?? ''}\0${item?.sha256 ?? ''}`
    const currentList = current.map(item => ({ ...item }))
    const byKey = new Map(currentList.map(item => [artifactKey(item), item]))
    const added = []
    let changed = false
    const sourceOf = item => ({
      ...(typeof item.executionId === 'string' && item.executionId !== '' ? { executionId: item.executionId } : {}),
      ...(typeof item.workspaceId === 'string' && item.workspaceId !== '' ? { workspaceId: item.workspaceId } : {}),
      ...(typeof item.contentRef === 'string' && /^(artifacts\/)?[0-9a-f]{64}$/.test(item.contentRef) ? { contentRef: item.contentRef } : {}),
      ...(typeof item.nodeId === 'string' && item.nodeId !== '' ? { nodeId: item.nodeId } : {}),
      ...(Number.isSafeInteger(item.attempt) && item.attempt >= 1 ? { attempt: item.attempt } : {}),
      ...(typeof item.at === 'string' && item.at !== '' ? { at: item.at } : {}),
    })
    for (const item of artifacts) {
      if (!isPlainObject(item)) continue
      if (typeof item.path !== 'string' || item.path === '') continue
      if (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(item.sha256)) continue
      const sha256 = item.sha256.toLowerCase()
      const key = artifactKey({ path: item.path, sha256 })
      const source = sourceOf({ ...item, sha256 })
      const existing = byKey.get(key)
      if (existing !== undefined) {
        // 同 path + sha256 仍只登记一条（对外契约不变），但把每次执行的来源追加到
        // `sources[]`，不丢失 executionId / workspaceId / contentRef 的关系。
        const sources = Array.isArray(existing.sources) ? existing.sources.map(entry => ({ ...entry })) : []
        const duplicate = sources.some(entry => (
          (entry.executionId ?? '') === (source.executionId ?? '')
          && (entry.workspaceId ?? '') === (source.workspaceId ?? '')
          && (entry.contentRef ?? '') === (source.contentRef ?? '')
        ))
        if (!duplicate) {
          sources.push(source)
          existing.sources = sources
          changed = true
        }
        for (const field of ['executionId', 'workspaceId', 'contentRef']) {
          if (source[field] !== undefined && existing[field] !== source[field]) {
            existing[field] = source[field]
            changed = true
          }
        }
        continue
      }
      const entry = {
        path: item.path,
        sha256,
        bytes: Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? item.bytes : 0,
        kind: typeof item.kind === 'string' ? item.kind : '',
        title: typeof item.title === 'string' ? item.title : '',
        ...(typeof item.nodeId === 'string' && item.nodeId !== '' ? { nodeId: item.nodeId } : {}),
        ...(Number.isSafeInteger(item.attempt) && item.attempt >= 1 ? { attempt: item.attempt } : {}),
        ...(typeof item.at === 'string' && item.at !== '' ? { at: item.at } : {}),
        ...(source.executionId === undefined ? {} : { executionId: source.executionId }),
        ...(source.workspaceId === undefined ? {} : { workspaceId: source.workspaceId }),
        ...(source.contentRef === undefined ? {} : { contentRef: source.contentRef }),
        sources: [source],
      }
      byKey.set(key, entry)
      added.push(entry)
    }
    if (added.length === 0 && changed === false) return
    await updateInstance(instanceId, { artifacts: [...currentList, ...added] }, { instancesRoot: this.instancesRoot })
  }

  _nextAttempt(instanceId, event) {
    let attempts = this._attempts.get(instanceId)
    if (attempts === undefined) {
      attempts = new Map()
      this._attempts.set(instanceId, attempts)
    }
    if (event.type === 'activity/start' && typeof event.elementId === 'string') {
      const next = (attempts.get(event.elementId) ?? 0) + 1
      attempts.set(event.elementId, next)
      return next
    }
    if (typeof event.elementId === 'string' && attempts.has(event.elementId)) {
      return attempts.get(event.elementId)
    }
    if (event.type === 'flow/taken' && typeof event.from === 'string' && attempts.has(event.from)) {
      return attempts.get(event.from)
    }
    return 1
  }

  _enqueueEvent(instanceId, task) {
    const previous = this._eventChains.get(instanceId) ?? Promise.resolve()
    const next = previous
      .then(task)
      .catch(error => {
        const list = this._eventFailures.get(instanceId) ?? []
        list.push(error)
        this._eventFailures.set(instanceId, list)
      })
    this._eventChains.set(instanceId, next)
  }

  async _flushEvents(instanceId) {
    // 等「当前的尾巴」；若期间又有事件入队，继续等新尾巴（迟到的 process/end 也收口）。
    for (;;) {
      const chain = this._eventChains.get(instanceId)
      if (chain === undefined) break
      await chain.catch(() => {})
      if (this._eventChains.get(instanceId) === chain) break
    }
    const failures = this._eventFailures.get(instanceId) ?? []
    this._eventFailures.delete(instanceId)
    return failures
  }
}

/**
 * 工作区 / worktree 错误码 → HTTP 语义。
 * 400 入参 / 403 越界 / 404 不存在 / 409 冲突（脏树、未登记、HEAD 变化、plan 过期）/
 * 503 git 不可用 / 500 其它。
 */
function workspaceErrorStatus(error) {
  if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 600) {
    return error.status
  }
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === WORKSPACE_ERROR.NOT_ALLOWED) return 403
  if (code === WORKSPACE_ERROR.MISSING || code === WORKSPACE_ERROR.NOT_GIT
    || code === WORKSPACE_ERROR.INVALID || code === WORKSPACE_ERROR.CWD_OUTSIDE) return 400
  if (code === WORKSPACE_ERROR.GIT_UNAVAILABLE || code === WORKSPACE_ERROR.GIT_FAILED) return 503
  if (code === WORKSPACE_ERROR.UNAVAILABLE || code === WORKSPACE_ERROR.CORRUPT) return 409
  if (code === INSTANCE_WORKTREE_ERROR.INVALID || code === INSTANCE_WORKTREE_ERROR.NOT_GIT) return 400
  if (code === INSTANCE_WORKTREE_ERROR.GIT_UNAVAILABLE) return 503
  if (code === INSTANCE_WORKTREE_ERROR.NOT_FOUND) return 404
  if (code === INSTANCE_WORKTREE_ERROR.DIRTY || code === INSTANCE_WORKTREE_ERROR.LOCKED
    || code === INSTANCE_WORKTREE_ERROR.NOT_REGISTERED || code === INSTANCE_WORKTREE_ERROR.HEAD_MISMATCH
    || code === INSTANCE_WORKTREE_ERROR.BRANCH_NOT_OWNED || code === INSTANCE_WORKTREE_ERROR.BRANCH_UNMERGED
    || code === INSTANCE_WORKTREE_ERROR.PLAN_STALE) return 409
  if (code === INSTANCE_WORKTREE_ERROR.CREATE_FAILED) {
    return error?.reason === 'path-exists' || error?.reason === 'branch-conflict' ? 409 : 500
  }
  if (error instanceof ResourceError) return 500
  return 500
}

/** 统一成 `{status, code, message}`，供创建前失败 / 回滚使用。 */
function workspaceErrorObject(error) {
  const code = typeof error?.code === 'string' && error.code !== ''
    ? error.code
    : 'BPMN_WORKSPACE_OPERATION_FAILED'
  return {
    status: workspaceErrorStatus(error),
    code,
    message: typeof error?.message === 'string' && error.message !== '' ? error.message : String(error),
  }
}

function workspaceErrorResult(error) {
  const normalized = workspaceErrorObject(error)
  return {
    status: normalized.status,
    body: {
      ok: false,
      code: normalized.code,
      error: normalized.message,
      ...(error && typeof error.reason === 'string' && error.reason !== '' ? { reason: error.reason } : {}),
      ...(error && typeof error.path === 'string' && error.path !== '' ? { path: error.path } : {}),
    },
  }
}

/** connector 记录指纹：执行级结果的 updatedAt / 数量一变，指标缓存即失效。 */
function connectorFingerprint(records) {
  if (!Array.isArray(records) || records.length === 0) return ''
  let latest = ''
  for (const record of records) {
    if (record && typeof record.updatedAt === 'string' && record.updatedAt > latest) latest = record.updatedAt
  }
  return `${records.length}:${latest}`
}

function methodNotAllowed(supported) {
  return {
    status: 405,
    body: { ok: false, code: 'BPMN_METHOD_NOT_ALLOWED', error: `只支持 ${supported}` },
  }
}

/** URL 里的 activityId：先解码，再按「非空、有界字符串」校验（不套 run id 路径规则）。 */
function activityIdLabel(raw) {
  let decoded = String(raw ?? '')
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // 非法百分号编码：保留原文，交给长度校验。
  }
  return decoded.trim() !== '' && decoded.length <= 128 ? decoded : null
}

function invalidInstanceId() {
  return {
    status: 400,
    body: {
      ok: false,
      code: 'BPMN_INSTANCE_ID_INVALID',
      error: 'instanceId 只能由字母 / 数字 / 点 / 下划线 / 连字符组成，不以点开头，且不超过 64 字符',
    },
  }
}

function instanceNotFound(id) {
  return {
    status: 404,
    body: { ok: false, code: 'INSTANCE_NOT_FOUND', error: `实例 ${id} 不存在` },
  }
}

function versionOf(entry) {
  return {
    version: entry.version,
    hash: entry.hash,
    createdAt: entry.createdAt,
    bytes: entry.bytes,
  }
}

// ---------------------------------------------------------------------------
// 服务处理器（0.13.x 范围：AgentAdapter + 完结门；其余明确失败）
// ---------------------------------------------------------------------------

function throwIfAborted(ctx) {
  if (ctx?.signal?.aborted) {
    throw handlerError('BPMN_ABORTED', '活动已被取消（ctx.signal 已 abort）', {
      reason: 'aborted',
    })
  }
}

/**
 * agent 节点处理器（签名固定 `(element, ctx)`）。
 *
 * `dsh` / `codex` / `claude` 等**注册过**的 adapter 走 **AgentAdapter + flow_finish_node
 * 完结门**（`agent-execute.js`）：
 *
 * 1. `fs:node@adapter` 决定 adapter id（缺失默认 `dsh`；旧 `fs:executor@kind` 兜底）；
 * 2. admission：`adapter.probe()`（每个 runtime 只 probe 一次）→ `assertFinishToolNative`；
 *    非 native / probe 失败 → 节点**零派发**，`NODE_FINISH_TOOL_UNAVAILABLE`；
 * 3. `createFinishGate` + `adapter.start` → 等 `handle.exited`（不轮询 stdout）；
 * 4. 成功只认闸门受理的 record：返回 `{ output, artifacts, summary, usage, events }`；
 * 5. 失败码原样冒泡（`NODE_FINISH_MISSING` / `NODE_VARIABLES_INVALID` / …），
 *    由 runtime 写 lastError、实例保持 ACTIVE。
 *
 * 不再有外部 CLI 逃生门：`adapter=custom` 明确报 `BPMN_AGENT_ADAPTER_UNSUPPORTED`；
 * 没有适配器注册表时任何 id（含 `codex`）都明确失败，不退回旧外部 CLI executor。
 *
 * 第三个参数是本模块内部注入点（测试用 adapter 注册表）；公开契约仍是两个参数。
 *
 * @param {object} element
 * @param {{attempt?: number, variables?: object, signal?: AbortSignal, timeoutMs?: number|null,
 *   executionId?: string}} ctx
 * @param {{adapters?: object, probeAdapter?: Function, workspaceRoot?: string,
 *   instanceId?: string, log?: Function}} [options]
 * @returns {Promise<{output?: unknown, usage?: object, artifacts?: object[], summary?: string,
 *   events?: object[]}>}
 */
export async function executeAgent(element, ctx, options = {}) {
  throwIfAborted(ctx)
  const declared = resolveAdapterId(element)
  const adapterId = declared ?? DEFAULT_ADAPTER_ID
  const adapters = options.adapters && typeof options.adapters.get === 'function' ? options.adapters : null

  // 旧口径的逃生门：custom 曾直接走外部 CLI executor（不经过 flow_finish_node）。
  // 新口径只认工具完结核验，custom 不再是 agent 完结路径，必须明确拒绝。
  if (adapterId === 'custom') {
    throw handlerError(
      AGENT_EXECUTE_ERROR.ADAPTER_UNSUPPORTED,
      'agent adapter「custom」不再受支持：custom 外部 executor 不再是 agent 完结路径；'
        + '请用注册过的 adapter（dsh/codex/claude），节点必须调用 flow_finish_node',
      { adapter: adapterId, elementId: element?.id ?? null },
    )
  }

  if (adapters === null) {
    // 没有注册表：任何 id 都明确失败，不回退到外部 CLI executor。
    if (adapterId === 'dsh' || adapterId === 'codex') {
      throw handlerError(
        AGENT_EXECUTE_ERROR.ADAPTER_UNAVAILABLE,
        `${adapterId} 走 AgentAdapter + flow_finish_node，但当前 runtime 没有适配器注册表`
          + '（createAdapterRegistry + createDshAdapter / createCodexAdapter）；'
          + '节点必须调用 flow_finish_node 完结，不退回外部 CLI 输出',
        { adapter: adapterId, elementId: element?.id ?? null },
      )
    }
    throw handlerError(
      AGENT_EXECUTE_ERROR.ADAPTER_UNSUPPORTED,
      `不支持的 agent adapter「${adapterId}」：当前 runtime 没有适配器注册表，`
        + '且 custom 外部 executor 不再是 agent 完结路径；请注册 dsh/codex/claude 适配器，'
        + '节点必须调用 flow_finish_node',
      { adapter: adapterId, elementId: element?.id ?? null },
    )
  }

  const adapter = adapters.get(adapterId)
  if (!adapter) {
    const available = typeof adapters.list === 'function'
      ? adapters.list().map(item => item && item.id).filter(Boolean)
      : []
    throw handlerError(
      AGENT_EXECUTE_ERROR.ADAPTER_UNSUPPORTED,
      `不支持的 agent adapter「${adapterId}」：没有注册这个 id`
        + (available.length > 0 ? `（已注册：${available.join(' / ')}）` : '（注册表为空）'),
      { adapter: adapterId, elementId: element?.id ?? null },
    )
  }

  // admission：probe + 原生 finishTool 断言。失败时零派发（不调用 adapter.start）。
  //
  // review-0131 #3：有效时限与旧 executor 路径同优先级（ctx > node.executor.timeoutMs），
  // 且是**整个活动**的 deadline——probe 花掉的时间从预算里扣，剩余部分交给 runAgentNode
  // 约束 start / 执行 / 取消阶段；没有全局活动超时时，节点自己的 executor.timeoutMs 生效。
  const effectiveTimeoutMs = resolveAgentTimeoutMs(element, ctx)
  const admissionStartedAt = Date.now()
  await admitAdapter(adapter, {
    probeAdapter: options.probeAdapter,
    nodeId: element?.id,
    timeoutMs: effectiveTimeoutMs,
  })
  const remainingTimeoutMs = effectiveTimeoutMs > 0
    ? effectiveTimeoutMs - (Date.now() - admissionStartedAt)
    : 0
  if (effectiveTimeoutMs > 0 && remainingTimeoutMs <= 0) {
    throw handlerError(
      AGENT_EXECUTE_ERROR.ACTIVITY_TIMEOUT,
      `活动 ${element?.id ?? '(agent)'} 的 ${effectiveTimeoutMs}ms 时限在 admission 阶段已用尽（未派发节点）`,
      { elementId: element?.id ?? null, adapter: adapterId, timeoutMs: effectiveTimeoutMs, phase: 'admission' },
    )
  }

  return await runAgentNode({
    element,
    ctx,
    adapter,
    workspaceRoot: options.workspaceRoot,
    ...(options.workspace && typeof options.workspace === 'object' ? { workspace: options.workspace } : {}),
    ...(typeof options.workspaceId === 'string' && options.workspaceId !== '' ? { workspaceId: options.workspaceId } : {}),
    ...(options.artifactStore && typeof options.artifactStore.captureFile === 'function'
      ? { artifactStore: options.artifactStore }
      : {}),
    instanceId: options.instanceId,
    // 0.13.10 收件箱：句柄可用后的登记回调 / 会话内收件箱工具注册。
    ...(typeof options.onStart === 'function' ? { onStart: options.onStart } : {}),
    ...(typeof options.registerTools === 'function' ? { registerTools: options.registerTools } : {}),
    // 配置口径的总时限（透传给适配器 ctx.timeoutMs）与扣掉 probe 后剩余的执行预算。
    effectiveTimeoutMs,
    ...(remainingTimeoutMs > 0 ? { timeoutMs: remainingTimeoutMs } : {}),
    log: typeof options.log === 'function' ? options.log : undefined,
  })
}

/**
 * http connector 处理器（签名固定 `(element, ctx)`）。
 *
 * 0.13.6 起接到真实 connector：目标策略、受控 DNS、超时/重试/幂等、IO 映射与
 * 调用记录都由 `http-connector.js` / `http-policy.js` / `connector-store.js` 提供。
 * 失败抛带 `code` 的 `HttpConnectorError`，runner 会落成 `ACTIVE + lastError`。
 *
 * 直接调用（测试 / 嵌入）时必须通过 `options.store` 或 `options.storeRoot` 指定
 * 调用记录目录；runtime 会按实例目录自动注入。
 *
 * @param {object} element
 * @param {{signal?: AbortSignal, variables?: object, instanceId?: string, executionId?: string}} ctx
 * @param {{policy?: object, store?: object, storeRoot?: string, env?: object, authResolver?: Function}} [options]
 * @returns {Promise<{output: object, status: number, headers: object, events: object[]}>}
 */
export async function executeHttp(element, ctx, options = {}) {
  return executeHttpConnector(element, ctx, options)
}

/** 导出目录 helper，便于运维/测试核对根位置（与 store 同口径）。 */
export { definitionsDir, instancesDir }
