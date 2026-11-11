/**
 * 实例域运行指标（0.13.10 E1）：**单实例纯函数 + 跨实例汇总**。
 *
 * 口径唯一来源：`docs/design/12-instance-metrics.md`。本模块不读文件、不碰 runner、
 * 不调用 `_ensureRunner()`；调用方（`bpmn-runtime`）负责把实例事实、事件、connector
 * 记录与资源记录读出来传进来。这样：
 *
 *   - 离线复算与 API 走同一份代码（测试可直接对账）；
 *   - 事件 / 实例事实才是权威，内存缓存只是可删可重建的派生值；
 *   - `asOf` 由调用方决定，当前等待时长不会因为在两次请求之间没有新事件而冻结。
 *
 * 硬口径（逐条对应计划 §E1）：
 *
 *   1. 未知不是零：没有 usage 时 `observedTokens:null` + `dataQuality.reasons` 记原因；
 *   2. 同一 `provider + callId` 的 usage 是**替换**不是累加；
 *   3. 每 execution 的 `activity/end.usage` 只在它没有 `agent/usage` 事件时兜底，
 *      二者不会同时被累计（不双计）；
 *   4. 节点耗时按 `executionId`，循环两次 / 同节点不同 execution 独立；
 *      错误 / 取消 / 中断单列，不伪造 completed；
 *   5. 人工等待：同一 execution 首次 wait→complete/cancel/asOf，重放不重复；
 *   6. 挂起耗时单列（suspend/resume 区间），不混入执行耗时；
 *   7. `finish_reminder` 每次实际触发计一次；`NODE_FINISH_MISSING` 按错误事实 +
 *      execution 去重；
 *   8. connector execution 级与 attempt 级成功率分列；单次请求延迟与含退避总耗时
 *      分列；分位数从样本合并（见 `aggregateInstanceMetrics`）。
 *
 * @module @feiyueve/dsh-flow-studio/instance-metrics
 */

import {
  USAGE_BUCKETS, USAGE_REASON, USAGE_TRUST, createUsageCall, recordUsageCall,
  summarizeUsageCalls, usageCallKey,
} from './agent-telemetry.js'

/** 指标 JSON schema 版本；缓存与 API 都用它判失效。 */
export const METRICS_SCHEMA_VERSION = 1

/** `dataQuality.reasons` 的稳定字符串。 */
export const METRICS_REASON = Object.freeze({
  USAGE_UNAVAILABLE: USAGE_REASON.UNAVAILABLE,
  USAGE_MALFORMED: USAGE_REASON.MALFORMED,
  USAGE_MISSING_BUCKETS: USAGE_REASON.MISSING_BUCKETS,
  LEGACY_USAGE_FALLBACK: 'legacy-usage-fallback',
  INVOCATION_UNAVAILABLE: 'agent-invocation-unavailable',
  EVENTS_SKIPPED: 'events-skipped',
  RESOURCES_SKIPPED: 'resources-skipped',
  EVENT_LOG_GAP: 'event-log-gap',
  INVALID_TIMESTAMPS: 'invalid-timestamps',
  SUSPEND_TIMELINE_UNAVAILABLE: 'suspend-timeline-unavailable',
  CONNECTOR_RECORDS_MISSING: 'connector-records-missing',
  CONNECTOR_RECORD_INVALID: 'connector-record-invalid',
})

const TERMINAL_STATUSES = new Set(['COMPLETED', 'CANCELED'])
const STATUSES = new Set(['ACTIVE', 'COMPLETED', 'SUSPENDED', 'CANCELED'])
const MAX_EXECUTIONS = 500
const MAX_LATENCY_SAMPLES = 5000
const MAX_BUSINESS_SCALARS = 50
const MAX_SCALAR_TEXT = 200

const SUSPEND_TYPES = new Set(['instance/suspended', 'instance/suspend', 'suspend', 'instance/suspension'])
const RESUME_TYPES = new Set(['instance/resumed', 'instance/resume', 'resume', 'instance/unsuspended'])

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** ISO / Date → 毫秒；无法解析返回 null（不用 0 冒充合法时间）。 */
export function parseTimeMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value !== 'string' || value.trim() === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function msSince(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return Math.max(0, Math.round(endMs - startMs))
}

function rate(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000
}

function addReason(reduction, reason) {
  if (typeof reason === 'string' && reason !== '') reduction.reasons.add(reason)
}

/**
 * 最近秩（nearest-rank）分位数：`ceil(p/100*n)`，1-based。
 * 样本为空返回 null；分位数从原始样本合并，绝不平均各实例的 p95。
 */
export function percentileMs(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const clamped = Math.min(100, Math.max(0, Number(p) || 0))
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((clamped / 100) * sorted.length) - 1))
  return sorted[index]
}

/**
 * 一组延迟样本的摘要。`values` 原样保留（有上限），让跨实例汇总能合并样本重算分位数。
 *
 * @param {number[]} raw
 * @returns {{samples:number,minMs:number|null,p50Ms:number|null,p95Ms:number|null,maxMs:number|null,values:number[]}|null}
 */
export function summarizeLatency(raw) {
  const values = (Array.isArray(raw) ? raw : [])
    .filter(value => Number.isFinite(value) && value >= 0)
    .map(value => Math.round(value))
    .slice(0, MAX_LATENCY_SAMPLES)
  if (values.length === 0) return null
  return {
    samples: values.length,
    minMs: Math.min(...values),
    p50Ms: percentileMs(values, 50),
    p95Ms: percentileMs(values, 95),
    maxMs: Math.max(...values),
    values,
  }
}

function normalizeStatus(value) {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return STATUSES.has(text) ? text : (text === '' ? 'ACTIVE' : text)
}

/** 实例里的显式标量变量：只读它们，不推断完成百分比。 */
export function scalarVariablesOf(instance) {
  const variables = isPlainObject(instance?.variables) ? instance.variables : {}
  const out = {}
  let count = 0
  for (const [key, value] of Object.entries(variables)) {
    if (count >= MAX_BUSINESS_SCALARS) break
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    } else if (typeof value === 'boolean') {
      out[key] = value
    } else if (typeof value === 'string') {
      out[key] = value.length > MAX_SCALAR_TEXT ? `${value.slice(0, MAX_SCALAR_TEXT)}…` : value
    } else {
      continue
    }
    count += 1
  }
  return out
}

function createExecution(executionId, elementId, atMs) {
  return {
    executionId,
    elementId: nonEmptyString(elementId) ? elementId : null,
    startedAtMs: Number.isFinite(atMs) ? atMs : null,
    endedAtMs: null,
    durationMs: null,
    status: 'running',
    waitStartedAtMs: null,
    waitEndedAtMs: null,
    waitMs: null,
    attempts: null,
    errorCode: null,
  }
}

function ensureExecution(reduction, executionId, elementId, atMs) {
  let execution = reduction.nodes.get(executionId)
  if (execution === undefined) {
    execution = createExecution(executionId, elementId, atMs)
    reduction.nodes.set(executionId, execution)
  } else if (execution.elementId === null && nonEmptyString(elementId)) {
    execution.elementId = elementId
  }
  if (execution.startedAtMs === null && Number.isFinite(atMs)) execution.startedAtMs = atMs
  return execution
}

function closeWait(reduction, execution, endMs, kind) {
  if (execution.waitStartedAtMs === null || execution.waitEndedAtMs !== null) return
  if (!Number.isFinite(endMs)) return
  execution.waitEndedAtMs = endMs
  execution.waitMs = msSince(execution.waitStartedAtMs, endMs)
  if (execution.waitMs === null) return
  if (kind === 'completed') reduction.human.completedWaitMs += execution.waitMs
  else if (kind === 'canceled') reduction.human.canceledWaitMs += execution.waitMs
  else reduction.human.interruptedWaitMs += execution.waitMs
}

function executionDuration(execution, event) {
  if (Number.isInteger(event?.durationMs) && event.durationMs >= 0) return event.durationMs
  return msSince(execution.startedAtMs, execution.endedAtMs)
}

/**
 * 事件 + 实例事实 → 可缓存的「事件侧归约」（不含 asOf 相关投影）。
 *
 * 缓存绑定 `lastSeq / revision / schemaVersion`（以及 connector / 资源记录指纹），
 * 事件或实例事实一变即重算；见 {@link createMetricsCache}。
 *
 * @param {{
 *   instance: object,
 *   events?: object[],
 *   connector?: object[],
 *   resources?: object[]|{events?:object[],skipped?:number,resourceSeq?:number},
 *   skippedEvents?: number,
 *   skippedResources?: number,
 * }} input
 * @returns {object}
 */
export function reduceInstanceMetrics(input = {}) {
  if (!isPlainObject(input) || !isPlainObject(input.instance)) {
    const error = new TypeError('reduceInstanceMetrics 需要 { instance, events?, connector?, resources? }')
    error.code = 'INSTANCE_METRICS_INPUT_INVALID'
    throw error
  }
  const instance = input.instance
  const rawEvents = Array.isArray(input.events) ? input.events : []
  const events = rawEvents
    .filter(event => isPlainObject(event) && typeof event.type === 'string' && event.type !== '')
    .map((event, index) => ({ event, index, seq: Number.isInteger(event.seq) ? event.seq : -1 }))
    .sort((left, right) => (left.seq - right.seq) || (left.index - right.index))
    .map(item => item.event)
  const skippedEvents = Number.isSafeInteger(input.skippedEvents)
    ? input.skippedEvents
    : (Number.isSafeInteger(input.events?.skipped) ? input.events.skipped : 0)
  const resourcesObject = isPlainObject(input.resources) ? input.resources : null
  const resources = Array.isArray(input.resources)
    ? input.resources
    : (resourcesObject && Array.isArray(resourcesObject.events) ? resourcesObject.events : [])
  const skippedResources = Number.isSafeInteger(input.skippedResources)
    ? input.skippedResources
    : (resourcesObject && Number.isSafeInteger(resourcesObject.skipped) ? resourcesObject.skipped : 0)
  const resourceSeq = resourcesObject && Number.isSafeInteger(resourcesObject.resourceSeq)
    ? resourcesObject.resourceSeq
    : null

  const status = normalizeStatus(instance.status)
  const createdAtMs = parseTimeMs(instance.createdAt)
  const completedAtMs = parseTimeMs(instance.completedAt)
  const updatedAtMs = parseTimeMs(instance.updatedAt)
  const lastSeq = Number.isSafeInteger(instance.lastSeq) ? instance.lastSeq : null

  const reduction = {
    schemaVersion: METRICS_SCHEMA_VERSION,
    instanceId: typeof instance.id === 'string' ? instance.id : '',
    instance: {
      variables: isPlainObject(instance.variables) ? instance.variables : {},
    },
    pendingTasks: Array.isArray(instance.pendingTasks) ? instance.pendingTasks : [],
    status,
    createdAtMs,
    completedAtMs,
    updatedAtMs,
    lastSeq,
    throughSeq: 0,
    skippedEvents,
    skippedResources,
    resourceSeq,
    resourceEventCount: resources.filter(isPlainObject).length,
    complete: false,
    reasons: new Set(),
    suspension: { intervals: [], openStartedAtMs: null },
    nodes: new Map(),
    human: {
      completedWaitMs: 0,
      canceledWaitMs: 0,
      interruptedWaitMs: 0,
    },
    agent: {
      invocationIds: new Set(),
      reminders: new Set(),
      missingExecutions: new Set(),
      calls: new Map(),
      legacyCandidates: [],
      usageExecutionIds: new Set(),
      hadActivity: false,
    },
    connector: {
      records: [],
      events: [],
    },
  }

  for (const event of events) {
    if (!Number.isInteger(event.seq)) continue
    if (event.seq > reduction.throughSeq) reduction.throughSeq = event.seq
  }
  if (events.length > 0 && reduction.throughSeq === 0) reduction.throughSeq = events.length

  // ── 实例时间轴 / 挂起区间 ────────────────────────────────────────────────
  for (const event of events) {
    const atMs = parseTimeMs(event.at)
    if (SUSPEND_TYPES.has(event.type)) {
      if (reduction.suspension.openStartedAtMs === null) reduction.suspension.openStartedAtMs = atMs
    } else if (RESUME_TYPES.has(event.type)) {
      if (reduction.suspension.openStartedAtMs !== null) {
        if (Number.isFinite(atMs)) {
          reduction.suspension.intervals.push([reduction.suspension.openStartedAtMs, atMs])
        } else {
          addReason(reduction, METRICS_REASON.INVALID_TIMESTAMPS)
        }
        reduction.suspension.openStartedAtMs = null
      }
    }
    if (!Number.isFinite(atMs)) addReason(reduction, METRICS_REASON.INVALID_TIMESTAMPS)
  }

  // ── 节点 / 人工等待 ──────────────────────────────────────────────────────
  for (const event of events) {
    const atMs = parseTimeMs(event.at)
    const executionId = nonEmptyString(event.activityId)
      ? event.activityId
      : (nonEmptyString(event.executionId) ? event.executionId : null)
    if (event.type === 'activity/start') {
      if (executionId === null) continue
      ensureExecution(reduction, executionId, event.elementId, atMs)
    } else if (event.type === 'activity/wait') {
      if (executionId === null) continue
      const execution = ensureExecution(reduction, executionId, event.elementId, atMs)
      if (execution.waitStartedAtMs === null) execution.waitStartedAtMs = atMs
      if (execution.waitEndedAtMs === null) execution.status = 'waiting'
    } else if (event.type === 'activity/end') {
      if (executionId === null) continue
      const execution = ensureExecution(reduction, executionId, event.elementId, atMs)
      if (execution.endedAtMs === null) execution.endedAtMs = atMs
      if (execution.status !== 'error') execution.status = 'completed'
      execution.durationMs = executionDuration(execution, event)
      closeWait(reduction, execution, execution.endedAtMs, 'completed')
      if (isPlainObject(event.usage)) {
        reduction.agent.legacyCandidates.push({
          executionId,
          usage: event.usage,
          seq: Number.isInteger(event.seq) ? event.seq : null,
        })
        reduction.agent.hadActivity = true
      }
    } else if (event.type === 'error') {
      const code = isPlainObject(event.error) && typeof event.error.code === 'string'
        ? event.error.code
        : null
      if (executionId !== null) {
        const execution = ensureExecution(reduction, executionId, event.elementId, atMs)
        if (execution.endedAtMs === null) execution.endedAtMs = atMs
        execution.status = 'error'
        execution.errorCode = code
        execution.durationMs = executionDuration(execution, event)
        closeWait(reduction, execution, execution.endedAtMs, 'canceled')
      }
      if (code === 'NODE_FINISH_MISSING') {
        const key = executionId ?? `lastError:${nonEmptyString(event.elementId) ? event.elementId : 'unknown'}`
        reduction.agent.missingExecutions.add(key)
      }
    }
  }

  // 旧实例没有 agent/invocation 事件：`lastAgentOutput` / agent 类 lastError 至少
  // 证明「确实发生过 agent 执行」，因此不能把 agent 调用数 / token 报成 0。
  if (isPlainObject(instance.lastAgentOutput)) reduction.agent.hadActivity = true
  const lastError = isPlainObject(instance.lastError) ? instance.lastError : null
  if (lastError && typeof lastError.code === 'string'
    && (lastError.code.startsWith('NODE_FINISH_') || lastError.code.startsWith('DSH_AGENT_')
      || lastError.code === 'BPMN_AGENT_ADAPTER_UNAVAILABLE' || lastError.code === 'BPMN_AGENT_ADAPTER_UNSUPPORTED')) {
    reduction.agent.hadActivity = true
  }
  if (lastError && lastError.code === 'NODE_FINISH_MISSING') {
    const key = nonEmptyString(lastError.activityId)
      ? lastError.activityId
      : `lastError:${nonEmptyString(lastError.nodeId) ? lastError.nodeId : 'unknown'}`
    reduction.agent.missingExecutions.add(key)
  }

  // ── agent 调用 / usage / 提醒 ────────────────────────────────────────────
  for (const event of events) {
    if (event.type === 'agent/invocation') {
      reduction.agent.hadActivity = true
      const id = nonEmptyString(event.invocationId)
        ? event.invocationId
        : `event:${Number.isInteger(event.seq) ? event.seq : reduction.agent.invocationIds.size}`
      reduction.agent.invocationIds.add(id)
    } else if (event.type === 'agent/reminder') {
      reduction.agent.hadActivity = true
      const key = Number.isInteger(event.count) && event.count > 0
        ? `${nonEmptyString(event.activityId) ? event.activityId : 'activity'}:${event.count}`
        : `seq:${Number.isInteger(event.seq) ? event.seq : reduction.agent.reminders.size}`
      reduction.agent.reminders.add(key)
    } else if (event.type === 'agent/usage') {
      reduction.agent.hadActivity = true
      if (nonEmptyString(event.activityId)) reduction.agent.usageExecutionIds.add(event.activityId)
      const provider = nonEmptyString(event.provider) ? event.provider : 'unknown'
      const callId = nonEmptyString(event.callId) ? event.callId : null
      if (callId === null) {
        addReason(reduction, METRICS_REASON.USAGE_MALFORMED)
        continue
      }
      const call = createUsageCall({
        provider,
        callId,
        usage: event.usage,
        source: event.source,
        invocationId: event.invocationId,
      })
      // 事件显式说未知（即便带了形状奇怪的 usage）时以事件为准。
      if (event.trust === USAGE_TRUST.UNKNOWN || !isPlainObject(event.usage)) {
        call.trust = USAGE_TRUST.UNKNOWN
        call.usage = null
        call.reason = nonEmptyString(event.reason) ? event.reason : METRICS_REASON.USAGE_UNAVAILABLE
        call.observedBuckets = []
      }
      recordUsageCall(reduction.agent.calls, call)
    }
  }

  // activity/end.usage 只在「这个 execution 没有 agent/usage 事件」时兜底：
  // 两条路都取会翻倍（计划 §E1「不同时累计」）。
  for (const candidate of reduction.agent.legacyCandidates) {
    if (reduction.agent.usageExecutionIds.has(candidate.executionId)) continue
    const call = createUsageCall({
      provider: 'event',
      callId: `legacy:${candidate.executionId}`,
      usage: candidate.usage,
      source: 'activity/end.usage',
    })
    recordUsageCall(reduction.agent.calls, call)
    addReason(reduction, METRICS_REASON.LEGACY_USAGE_FALLBACK)
  }

  // ── connector 记录 / 事件 ────────────────────────────────────────────────
  if (Array.isArray(input.connector)) {
    for (const record of input.connector) {
      if (isPlainObject(record)) reduction.connector.records.push(record)
      else addReason(reduction, METRICS_REASON.CONNECTOR_RECORD_INVALID)
    }
  }
  for (const event of events) {
    if (event.type === 'http/attempt' || event.type === 'http/result') {
      reduction.connector.events.push(event)
    }
  }

  // ── 完整性 ───────────────────────────────────────────────────────────────
  if (skippedEvents > 0) addReason(reduction, METRICS_REASON.EVENTS_SKIPPED)
  if (skippedResources > 0) addReason(reduction, METRICS_REASON.RESOURCES_SKIPPED)
  if (!Number.isFinite(createdAtMs)) addReason(reduction, METRICS_REASON.INVALID_TIMESTAMPS)
  const expectedLastSeq = lastSeq === null ? reduction.throughSeq : lastSeq
  if (expectedLastSeq > reduction.throughSeq) addReason(reduction, METRICS_REASON.EVENT_LOG_GAP)
  reduction.complete = skippedEvents === 0
    && skippedResources === 0
    && expectedLastSeq <= reduction.throughSeq

  return reduction
}

function closeTerminalExecutions(reduction, wallEndMs) {
  const executions = new Map()
  for (const [key, execution] of reduction.nodes) executions.set(key, { ...execution })
  const extra = { completedWaitMs: 0, canceledWaitMs: 0, interruptedWaitMs: 0 }
  const terminal = TERMINAL_STATUSES.has(reduction.status)
  if (terminal) {
    for (const execution of executions.values()) {
      if (execution.endedAtMs !== null) continue
      execution.endedAtMs = wallEndMs
      execution.durationMs = msSince(execution.startedAtMs, execution.endedAtMs)
      execution.status = reduction.status === 'CANCELED' ? 'canceled' : 'interrupted'
      if (execution.waitStartedAtMs !== null && execution.waitEndedAtMs === null) {
        execution.waitEndedAtMs = wallEndMs
        execution.waitMs = msSince(execution.waitStartedAtMs, wallEndMs)
        if (execution.waitMs !== null) {
          if (reduction.status === 'CANCELED') extra.canceledWaitMs += execution.waitMs
          else extra.interruptedWaitMs += execution.waitMs
        }
      }
    }
  }
  return { executions, extra }
}

/** 等待任务合并：事件里的 open wait 优先，pendingTasks 只补没有 executionId 的空位。 */
function mergeWaitingTasks(eventWaits, pendingTasks, asOfMs) {
  const rows = [...eventWaits]
  const seen = new Set(rows.filter(row => nonEmptyString(row.executionId)).map(row => row.executionId))
  for (const task of Array.isArray(pendingTasks) ? pendingTasks : []) {
    if (!isPlainObject(task)) continue
    const executionId = nonEmptyString(task.executionId) ? task.executionId : null
    if (executionId !== null && seen.has(executionId)) continue
    if (executionId !== null) seen.add(executionId)
    rows.push({
      executionId,
      elementId: nonEmptyString(task.elementId)
        ? task.elementId
        : (nonEmptyString(task.activityId) ? task.activityId : null),
      since: typeof task.since === 'string' ? task.since : null,
      waitedMs: msSince(parseTimeMs(task.since), asOfMs),
      source: 'pendingTasks',
    })
  }
  return rows
}

function waiteSummary(waits) {
  return waits.map(wait => ({
    executionId: wait.execution.executionId,
    elementId: wait.execution.elementId,
    since: toIso(wait.execution.waitStartedAtMs),
    waitedMs: wait.waitedMs,
  }))
}

/**
 * 归约 + `asOf` → API 形状（asOf 相关字段在这一步才计算，所以缓存可以复用）。
 *
 * @param {object} reduction {@link reduceInstanceMetrics} 的返回值
 * @param {string|Date} [asOf]
 * @returns {object}
 */
export function finalizeInstanceMetrics(reduction, asOf = new Date().toISOString()) {
  if (!isPlainObject(reduction) || !(reduction.nodes instanceof Map)) {
    const error = new TypeError('finalizeInstanceMetrics 需要 reduceInstanceMetrics 的返回值')
    error.code = 'INSTANCE_METRICS_INPUT_INVALID'
    throw error
  }
  const asOfMs = parseTimeMs(asOf)
  const effectiveAsOfMs = asOfMs === null ? Date.now() : asOfMs
  const asOfIso = toIso(effectiveAsOfMs)
  const terminal = TERMINAL_STATUSES.has(reduction.status)
  const wallEndMs = terminal
    ? (reduction.completedAtMs ?? reduction.updatedAtMs ?? effectiveAsOfMs)
    : effectiveAsOfMs
  const wallMs = msSince(reduction.createdAtMs, wallEndMs)

  const closed = closeTerminalExecutions(reduction, wallEndMs)
  const executions = closed.executions

  // 挂起区间：截止到实例墙钟终点；区间内非法时间不计入。
  let suspendedMs = 0
  let suspendKnown = true
  const intervals = [...reduction.suspension.intervals]
  if (reduction.suspension.openStartedAtMs !== null) intervals.push([reduction.suspension.openStartedAtMs, wallEndMs])
  for (const [startMs, endMs] of intervals) {
    const duration = msSince(startMs, endMs)
    if (duration === null) {
      suspendKnown = false
      continue
    }
    suspendedMs += duration
  }
  let suspendedValue = suspendedMs
  if (!suspendKnown) suspendedValue = null
  if (reduction.status === 'SUSPENDED' && reduction.suspension.openStartedAtMs === null && suspendedMs === 0) {
    // 只有状态没有区间：不能把「正在挂起」报成 0ms。
    suspendedValue = null
    addReason(reduction, METRICS_REASON.SUSPEND_TIMELINE_UNAVAILABLE)
  }

  let completedWaitMs = reduction.human.completedWaitMs + closed.extra.completedWaitMs
  let canceledWaitMs = reduction.human.canceledWaitMs + closed.extra.canceledWaitMs
  let interruptedWaitMs = reduction.human.interruptedWaitMs + closed.extra.interruptedWaitMs
  let currentWaitMs = 0
  const waiting = []
  for (const execution of executions.values()) {
    if (execution.waitStartedAtMs === null) continue
    if (execution.waitEndedAtMs !== null) {
      waiting.push({ execution, waitedMs: execution.waitMs, open: false })
      continue
    }
    // 没有 end 的等待：终态按墙钟收口（已在 closeTerminalExecutions 里处理过），
    // 活跃实例按 asOf 继续增长——不能冻结在最后一个事件的时间。
    const waited = msSince(execution.waitStartedAtMs, effectiveAsOfMs)
    if (waited === null) continue
    currentWaitMs += waited
    waiting.push({ execution, waitedMs: waited, open: true })
  }

  const executionRows = [...executions.values()]
  const counts = { completed: 0, errored: 0, canceled: 0, interrupted: 0, running: 0, waiting: 0 }
  for (const execution of executionRows) {
    if (execution.status === 'completed') counts.completed += 1
    else if (execution.status === 'error') counts.errored += 1
    else if (execution.status === 'canceled') counts.canceled += 1
    else if (execution.status === 'interrupted') counts.interrupted += 1
    else if (execution.status === 'waiting') counts.waiting += 1
    else counts.running += 1
  }
  const active = executionRows
    .filter(execution => execution.status === 'running' || execution.status === 'waiting')
    .map(execution => ({
      executionId: execution.executionId,
      elementId: execution.elementId,
      status: execution.status,
      startedAt: toIso(execution.startedAtMs),
      elapsedMs: msSince(execution.startedAtMs, effectiveAsOfMs),
      waitingSince: toIso(execution.waitStartedAtMs),
    }))
  const pendingTasks = Array.isArray(reduction.pendingTasks) ? reduction.pendingTasks : []

  // ── agent usage ──────────────────────────────────────────────────────────
  const calls = [...reduction.agent.calls.values()]
  const usageSummary = summarizeUsageCalls(calls)
  const invocationIds = reduction.agent.invocationIds
  let invocations = null
  if (invocationIds.size > 0) {
    invocations = invocationIds.size
  } else if (calls.length > 0) {
    const callInvocations = new Set(calls.map(call => call.invocationId).filter(id => nonEmptyString(id)))
    if (callInvocations.size > 0) invocations = callInvocations.size
  }
  if (invocations === null && !reduction.agent.hadActivity) invocations = 0
  if (invocations === null) addReason(reduction, METRICS_REASON.INVOCATION_UNAVAILABLE)

  let unknownCoverage = usageSummary.unknown
  if (usageSummary.known === 0 && calls.length === 0) {
    // 一次 agent 都没有 → 0 个未知调用；有 agent 但没有任何 usage 事件 → 至少
    // 每个 invocation 都是未知，不能报 known:0 / unknown:0 说「全都零」。
    unknownCoverage = invocations ?? (reduction.agent.hadActivity ? 1 : 0)
  }
  if (unknownCoverage > 0 || (reduction.agent.hadActivity && usageSummary.known === 0)) {
    addReason(reduction, METRICS_REASON.USAGE_UNAVAILABLE)
  }
  if (usageSummary.known > 0 && usageSummary.bucketsMissing.length > 0) {
    addReason(reduction, METRICS_REASON.USAGE_MISSING_BUCKETS)
  }
  const modelCalls = calls.length > 0 ? calls.length : (reduction.agent.hadActivity ? null : 0)

  const observedTokens = usageSummary.usage === null
    ? null
    : {
      input: usageSummary.usage.input,
      cacheRead: usageSummary.usage.cacheRead,
      cacheWrite: usageSummary.usage.cacheWrite,
      output: usageSummary.usage.output,
      total: usageSummary.usage.total,
    }

  // ── connector ────────────────────────────────────────────────────────────
  const connector = finalizeConnector(reduction.connector.records, reduction.connector.events, reduction)

  // ── dataQuality ──────────────────────────────────────────────────────────
  if (connector.recordCount === 0 && connector.attemptEvents > 0) {
    addReason(reduction, METRICS_REASON.CONNECTOR_RECORDS_MISSING)
  }
  const reasons = [...reduction.reasons].sort()

  const nodeRows = executionRows.slice(0, MAX_EXECUTIONS).map(execution => ({
    executionId: execution.executionId,
    elementId: execution.elementId,
    status: execution.status,
    startedAt: toIso(execution.startedAtMs),
    endedAt: toIso(execution.endedAtMs),
    durationMs: execution.durationMs,
    waitMs: execution.waitMs,
    errorCode: execution.errorCode,
  }))

  return {
    ok: true,
    schemaVersion: METRICS_SCHEMA_VERSION,
    instanceId: reduction.instanceId,
    status: reduction.status,
    asOf: asOfIso,
    throughSeq: reduction.throughSeq,
    lastSeq: reduction.lastSeq,
    complete: reduction.complete,
    duration: {
      wallMs,
      suspendedMs: suspendedValue,
      wallIncludesSuspended: true,
    },
    agent: {
      invocations,
      modelCalls,
      observedTokens,
      usageCoverage: {
        known: usageSummary.known,
        unknown: unknownCoverage,
      },
      buckets: {
        seen: usageSummary.bucketsSeen,
        missing: usageSummary.bucketsMissing,
      },
    },
    human: {
      completedWaitMs,
      currentWaitMs,
      canceledWaitMs,
      interruptedWaitMs,
    },
    finishReminder: {
      fires: reduction.agent.reminders.size,
      missingExecutions: reduction.agent.missingExecutions.size,
    },
    connector,
    nodes: {
      executed: executionRows.length,
      completed: counts.completed,
      errored: counts.errored,
      canceled: counts.canceled,
      interrupted: counts.interrupted,
      running: counts.running,
      waiting: counts.waiting,
      executions: nodeRows,
      active,
      waitingTasks: mergeWaitingTasks(waiteSummary(waiting.filter(item => item.open)), pendingTasks, effectiveAsOfMs),
    },
    business: {
      source: 'instance.variables',
      note: '业务指标（显式标量变量），不是流程完成百分比',
      scalars: scalarVariablesOf(reduction.instance),
    },
    dataQuality: {
      skippedEvents: reduction.skippedEvents,
      skippedResources: reduction.skippedResources,
      reasons,
    },
  }
}

function finalizeConnector(records, events, reduction) {
  const stateCounts = { succeeded: 0, errored: 0, canceled: 0, inFlight: 0, unknown: 0 }
  let attemptsFromRecords = 0
  let validRecords = 0
  for (const record of records) {
    if (!isPlainObject(record)) continue
    validRecords += 1
    if (Number.isInteger(record.attempts) && record.attempts >= 0) attemptsFromRecords += record.attempts
    const state = nonEmptyString(record.state) ? record.state : 'started'
    const errorCode = isPlainObject(record.error) && typeof record.error.code === 'string' ? record.error.code : ''
    if (state === 'succeeded') stateCounts.succeeded += 1
    else if (state === 'failed') {
      if (errorCode === 'HTTP_CANCELED' || errorCode === 'HTTP_ABORTED') stateCounts.canceled += 1
      else stateCounts.errored += 1
    } else if (state === 'unknown') stateCounts.unknown += 1
    else stateCounts.inFlight += 1
  }

  let attemptEvents = 0
  let attemptResults = 0
  let attemptSucceeded = 0
  const requestSamples = []
  const totalSamples = []
  for (const event of events) {
    if (event.type === 'http/attempt') {
      attemptEvents += 1
    } else if (event.type === 'http/result') {
      // `reused` / 没有 attempt 的是「复用已有成功结果」，不是一次真实请求尝试；
      // 计入 attempt 成功率会凭空多出一次成功。
      if (event.reused === true || !Number.isInteger(event.attempt)) continue
      attemptResults += 1
      if (Number.isInteger(event.status)) {
        if (event.status >= 200 && event.status <= 299) attemptSucceeded += 1
      }
      if (Number.isFinite(event.durationMs) && event.durationMs >= 0) requestSamples.push(event.durationMs)
    }
  }
  for (const record of records) {
    if (!isPlainObject(record)) continue
    const startMs = parseTimeMs(record.createdAt)
    const endMs = parseTimeMs(record.completedAt)
    const duration = msSince(startMs, endMs)
    if (duration !== null) totalSamples.push(duration)
  }

  // 没有记录时用 attempt 事件兜底 execution 级（但会标 connector-records-missing）。
  const attemptsTotal = attemptsFromRecords > 0
    ? attemptsFromRecords
    : Math.max(attemptEvents, attemptResults)
  const terminalExecutions = stateCounts.succeeded + stateCounts.errored + stateCounts.canceled
  return {
    succeeded: stateCounts.succeeded,
    errored: stateCounts.errored,
    canceled: stateCounts.canceled,
    inFlight: stateCounts.inFlight,
    unknown: stateCounts.unknown,
    successRate: rate(stateCounts.succeeded, terminalExecutions),
    attempts: {
      total: attemptsTotal,
      results: attemptResults,
      succeeded: attemptSucceeded,
      successRate: rate(attemptSucceeded, attemptResults),
    },
    latency: {
      request: summarizeLatency(requestSamples),
      total: summarizeLatency(totalSamples),
      totalIncludesBackoff: true,
    },
    recordCount: validRecords,
    attemptEvents,
  }
}

/**
 * 单实例指标（纯函数）。
 *
 * @param {{
 *   instance: object,
 *   events?: object[],
 *   connector?: object[],
 *   resources?: object[]|{events?:object[],skipped?:number,resourceSeq?:number},
 *   asOf?: string|Date,
 *   skippedEvents?: number,
 *   skippedResources?: number,
 * }} input
 * @returns {object}
 */
export function computeInstanceMetrics(input = {}) {
  const reduction = reduceInstanceMetrics(input)
  return finalizeInstanceMetrics(reduction, input.asOf ?? new Date().toISOString())
}

/**
 * 事件侧归约缓存：只绑定内容指纹，不绑定 asOf。
 *
 * 同一个指纹（`schemaVersion + lastSeq + revision`，再加 connector / 资源记录指纹）
 * 命中即复用；实例事实或事件一变，指纹变化 → 自动重算。缓存可整体清空且不丢事实：
 * 事件与实例事实才是权威。
 *
 * @param {{max?: number}} [options]
 * @returns {{get: Function, clear: Function, size: number}}
 */
export function createMetricsCache(options = {}) {
  const max = Number.isSafeInteger(options.max) && options.max > 0 ? options.max : 200
  const entries = new Map()
  return {
    get(fingerprint, build) {
      const key = typeof fingerprint === 'string' ? fingerprint : metricsCacheKey(fingerprint)
      if (entries.has(key)) {
        const value = entries.get(key)
        entries.delete(key)
        entries.set(key, value)
        return { value, hit: true, key }
      }
      const value = build()
      entries.set(key, value)
      while (entries.size > max) entries.delete(entries.keys().next().value)
      return { value, hit: false, key }
    },
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}

/** 缓存指纹的稳定序列化（字段固定，缺省按 0）。 */
export function metricsCacheKey(input = {}) {
  const source = isPlainObject(input) ? input : {}
  return JSON.stringify({
    schemaVersion: Number.isInteger(source.schemaVersion) ? source.schemaVersion : METRICS_SCHEMA_VERSION,
    lastSeq: Number.isInteger(source.lastSeq) ? source.lastSeq : 0,
    revision: Number.isInteger(source.revision) ? source.revision : 0,
    connector: typeof source.connector === 'string' ? source.connector : '',
    resources: Number.isInteger(source.resources) ? source.resources : 0,
  })
}

// ---------------------------------------------------------------------------
// 跨实例汇总
// ---------------------------------------------------------------------------

function emptyTotals() {
  return {
    instances: 0,
    byStatus: { ACTIVE: 0, COMPLETED: 0, SUSPENDED: 0, CANCELED: 0 },
    duration: { wallMs: 0, suspendedMs: 0, wallKnown: 0, wallUnknown: 0, suspendKnown: 0, suspendUnknown: 0 },
    agent: {
      invocations: 0,
      invocationKnown: 0,
      invocationUnknown: 0,
      modelCalls: 0,
      modelCallsUnknown: 0,
      observedTokens: null,
      usageCoverage: { known: 0, unknown: 0 },
      bucketsSeen: new Set(),
    },
    human: {
      completedWaitMs: 0,
      currentWaitMs: 0,
      canceledWaitMs: 0,
      interruptedWaitMs: 0,
    },
    finishReminder: { fires: 0, missingExecutions: 0 },
    connector: {
      succeeded: 0,
      errored: 0,
      canceled: 0,
      inFlight: 0,
      unknown: 0,
      attempts: { total: 0, results: 0, succeeded: 0 },
      requestSamples: [],
      totalSamples: [],
    },
    nodes: { executed: 0, completed: 0, errored: 0, canceled: 0, interrupted: 0, running: 0, waiting: 0 },
    dataQuality: { skippedEvents: 0, skippedResources: 0, reasons: new Set() },
  }
}

function mergeMetricsIntoTotals(totals, entry) {
  const metrics = isPlainObject(entry?.metrics) ? entry.metrics : null
  const instance = isPlainObject(entry?.instance) ? entry.instance : null
  if (metrics === null) return false
  totals.instances += 1
  const status = normalizeStatus(instance?.status ?? metrics.status)
  if (totals.byStatus[status] !== undefined) totals.byStatus[status] += 1

  if (Number.isFinite(metrics.duration?.wallMs)) {
    totals.duration.wallMs += metrics.duration.wallMs
    totals.duration.wallKnown += 1
  } else {
    totals.duration.wallUnknown += 1
  }
  if (Number.isFinite(metrics.duration?.suspendedMs)) {
    totals.duration.suspendedMs += metrics.duration.suspendedMs
    totals.duration.suspendKnown += 1
  } else {
    totals.duration.suspendUnknown += 1
  }

  const agent = isPlainObject(metrics.agent) ? metrics.agent : {}
  if (Number.isFinite(agent.invocations)) {
    totals.agent.invocations += agent.invocations
    totals.agent.invocationKnown += 1
  } else if (agent.invocations === null) {
    totals.agent.invocationUnknown += 1
  }
  if (Number.isFinite(agent.modelCalls)) totals.agent.modelCalls += agent.modelCalls
  else if (agent.modelCalls === null) totals.agent.modelCallsUnknown += 1
  if (isPlainObject(agent.observedTokens)) {
    if (totals.agent.observedTokens === null) {
      totals.agent.observedTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
    }
    for (const bucket of [...USAGE_BUCKETS, 'total']) {
      if (Number.isFinite(agent.observedTokens[bucket])) {
        totals.agent.observedTokens[bucket] += agent.observedTokens[bucket]
      }
    }
  }
  if (isPlainObject(agent.usageCoverage)) {
    if (Number.isFinite(agent.usageCoverage.known)) totals.agent.usageCoverage.known += agent.usageCoverage.known
    if (Number.isFinite(agent.usageCoverage.unknown)) totals.agent.usageCoverage.unknown += agent.usageCoverage.unknown
  }
  for (const bucket of Array.isArray(agent.buckets?.seen) ? agent.buckets.seen : []) {
    if (USAGE_BUCKETS.includes(bucket)) totals.agent.bucketsSeen.add(bucket)
  }

  const human = isPlainObject(metrics.human) ? metrics.human : {}
  for (const key of ['completedWaitMs', 'currentWaitMs', 'canceledWaitMs', 'interruptedWaitMs']) {
    if (Number.isFinite(human[key])) totals.human[key] += human[key]
  }
  const reminders = isPlainObject(metrics.finishReminder) ? metrics.finishReminder : {}
  if (Number.isFinite(reminders.fires)) totals.finishReminder.fires += reminders.fires
  if (Number.isFinite(reminders.missingExecutions)) totals.finishReminder.missingExecutions += reminders.missingExecutions

  const connector = isPlainObject(metrics.connector) ? metrics.connector : {}
  for (const key of ['succeeded', 'errored', 'canceled', 'inFlight', 'unknown']) {
    if (Number.isFinite(connector[key])) totals.connector[key] += connector[key]
  }
  if (isPlainObject(connector.attempts)) {
    for (const key of ['total', 'results', 'succeeded']) {
      if (Number.isFinite(connector.attempts[key])) totals.connector.attempts[key] += connector.attempts[key]
    }
  }
  for (const key of ['request', 'total']) {
    const values = connector.latency?.[key]?.values
    if (Array.isArray(values)) {
      for (const value of values) {
        if (Number.isFinite(value) && totals.connector[`${key}Samples`].length < MAX_LATENCY_SAMPLES) {
          totals.connector[`${key}Samples`].push(value)
        }
      }
    }
  }

  const nodes = isPlainObject(metrics.nodes) ? metrics.nodes : {}
  for (const key of ['executed', 'completed', 'errored', 'canceled', 'interrupted', 'running', 'waiting']) {
    if (Number.isFinite(nodes[key])) totals.nodes[key] += nodes[key]
  }

  const quality = isPlainObject(metrics.dataQuality) ? metrics.dataQuality : {}
  if (Number.isFinite(quality.skippedEvents)) totals.dataQuality.skippedEvents += quality.skippedEvents
  if (Number.isFinite(quality.skippedResources)) totals.dataQuality.skippedResources += quality.skippedResources
  for (const reason of Array.isArray(quality.reasons) ? quality.reasons : []) {
    if (typeof reason === 'string' && reason !== '') totals.dataQuality.reasons.add(reason)
  }
  return true
}

function finalizeAggregateTotals(totals) {
  const terminal = totals.connector.succeeded + totals.connector.errored + totals.connector.canceled
  return {
    instances: totals.instances,
    byStatus: { ...totals.byStatus },
    duration: {
      wallMs: totals.duration.wallMs,
      suspendedMs: totals.duration.suspendedMs,
      wallKnown: totals.duration.wallKnown,
      wallUnknown: totals.duration.wallUnknown,
      suspendKnown: totals.duration.suspendKnown,
      suspendUnknown: totals.duration.suspendUnknown,
    },
    agent: {
      invocations: totals.agent.invocationUnknown > 0 && totals.agent.invocationKnown === 0
        ? null
        : totals.agent.invocations,
      invocationUnknown: totals.agent.invocationUnknown,
      modelCalls: totals.agent.modelCallsUnknown > 0 && totals.agent.modelCalls === 0
        ? null
        : totals.agent.modelCalls,
      modelCallsUnknown: totals.agent.modelCallsUnknown,
      observedTokens: totals.agent.observedTokens,
      usageCoverage: { ...totals.agent.usageCoverage },
      bucketsSeen: USAGE_BUCKETS.filter(bucket => totals.agent.bucketsSeen.has(bucket)),
    },
    human: { ...totals.human },
    finishReminder: { ...totals.finishReminder },
    connector: {
      succeeded: totals.connector.succeeded,
      errored: totals.connector.errored,
      canceled: totals.connector.canceled,
      inFlight: totals.connector.inFlight,
      unknown: totals.connector.unknown,
      successRate: rate(totals.connector.succeeded, terminal),
      attempts: {
        total: totals.connector.attempts.total,
        results: totals.connector.attempts.results,
        succeeded: totals.connector.attempts.succeeded,
        successRate: rate(totals.connector.attempts.succeeded, totals.connector.attempts.results),
      },
      latency: {
        request: summarizeLatency(totals.connector.requestSamples),
        total: summarizeLatency(totals.connector.totalSamples),
        totalIncludesBackoff: true,
      },
    },
    nodes: { ...totals.nodes },
    dataQuality: {
      skippedEvents: totals.dataQuality.skippedEvents,
      skippedResources: totals.dataQuality.skippedResources,
      reasons: [...totals.dataQuality.reasons].sort(),
    },
  }
}

function inCohort(instance, cohort) {
  if (!isPlainObject(instance)) return false
  if (cohort.definitionId !== null && instance.definitionId !== cohort.definitionId) return false
  if (cohort.definitionVersion !== null && instance.definitionVersion !== cohort.definitionVersion) return false
  if (cohort.status !== null && normalizeStatus(instance.status) !== cohort.status) return false
  const createdAtMs = parseTimeMs(instance.createdAt)
  if (cohort.fromMs !== null && (createdAtMs === null || createdAtMs < cohort.fromMs)) return false
  if (cohort.toMs !== null && (createdAtMs === null || createdAtMs > cohort.toMs)) return false
  return true
}

function cohortOf(input = {}) {
  const status = nonEmptyString(input.status) ? normalizeStatus(input.status) : null
  if (status !== null && !STATUSES.has(status)) {
    const error = new TypeError(`status 必须是 ${[...STATUSES].join(' / ')} 之一`)
    error.code = 'INSTANCE_METRICS_FILTER_INVALID'
    throw error
  }
  const definitionVersion = input.definitionVersion === undefined || input.definitionVersion === null
    ? null
    : Number(input.definitionVersion)
  if (definitionVersion !== null && (!Number.isInteger(definitionVersion) || definitionVersion < 1)) {
    const error = new TypeError('definitionVersion 必须是 ≥1 的整数')
    error.code = 'INSTANCE_METRICS_FILTER_INVALID'
    throw error
  }
  const fromMs = input.from === undefined || input.from === null || input.from === '' ? null : parseTimeMs(input.from)
  if (input.from !== undefined && input.from !== null && input.from !== '' && fromMs === null) {
    const error = new TypeError('from 必须是可解析的 ISO 时间')
    error.code = 'INSTANCE_METRICS_FILTER_INVALID'
    throw error
  }
  const toMs = input.to === undefined || input.to === null || input.to === '' ? null : parseTimeMs(input.to)
  if (input.to !== undefined && input.to !== null && input.to !== '' && toMs === null) {
    const error = new TypeError('to 必须是可解析的 ISO 时间')
    error.code = 'INSTANCE_METRICS_FILTER_INVALID'
    throw error
  }
  const groupBy = nonEmptyString(input.groupBy) ? input.groupBy.trim() : null
  if (groupBy !== null && groupBy !== 'day') {
    const error = new TypeError("groupBy 只支持 'day'")
    error.code = 'INSTANCE_METRICS_FILTER_INVALID'
    throw error
  }
  return {
    definitionId: nonEmptyString(input.definitionId) ? input.definitionId : null,
    definitionVersion,
    status,
    fromMs,
    toMs,
    groupBy,
  }
}

function cohortPayload(cohort) {
  return {
    createdAt: 'instance.createdAt',
    definitionId: cohort.definitionId,
    definitionVersion: cohort.definitionVersion,
    status: cohort.status,
    from: toIso(cohort.fromMs),
    to: toIso(cohort.toMs),
    groupBy: cohort.groupBy,
  }
}

/**
 * 跨实例汇总（纯函数）。
 *
 * 时间范围按**实例 `createdAt`** 选择 cohort（不是事件时间）；`from` / `to` 均为闭区间。
 * `entries` 必须是已经算好的 `{ instance, metrics }`（调用方负责分页遍历全部实例，
 * 不能沿用 `listInstances()` 的默认 limit）。
 *
 * @param {{
 *   entries?: Array<{instance: object, metrics: object}>,
 *   definitionId?: string,
 *   definitionVersion?: number,
 *   from?: string,
 *   to?: string,
 *   status?: string,
 *   groupBy?: 'day',
 *   generatedAt?: string,
 * }} input
 * @returns {object}
 */
export function aggregateInstanceMetrics(input = {}) {
  const source = isPlainObject(input) ? input : {}
  const cohort = cohortOf(source)
  const entries = Array.isArray(source.entries) ? source.entries : []
  const totals = emptyTotals()
  const groups = new Map()
  let skippedInstances = 0

  for (const entry of entries) {
    if (!isPlainObject(entry) || !isPlainObject(entry.instance) || !isPlainObject(entry.metrics)) {
      skippedInstances += 1
      continue
    }
    if (!inCohort(entry.instance, cohort)) continue
    if (!mergeMetricsIntoTotals(totals, entry)) {
      skippedInstances += 1
      continue
    }
    if (cohort.groupBy === 'day') {
      const createdAtMs = parseTimeMs(entry.instance.createdAt)
      if (createdAtMs === null) continue
      const key = new Date(createdAtMs).toISOString().slice(0, 10)
      if (!groups.has(key)) groups.set(key, emptyTotals())
      mergeMetricsIntoTotals(groups.get(key), entry)
    }
  }

  const generatedAt = typeof source.generatedAt === 'string' && source.generatedAt !== ''
    ? source.generatedAt
    : new Date().toISOString()
  const groupRows = cohort.groupBy === 'day'
    ? [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, groupTotals]) => ({ key, day: key, ...finalizeAggregateTotals(groupTotals) }))
    : []

  const finalized = finalizeAggregateTotals(totals)
  return {
    ok: true,
    schemaVersion: METRICS_SCHEMA_VERSION,
    generatedAt,
    cohort: cohortPayload(cohort),
    totals: {
      ...finalized,
      dataQuality: {
        ...finalized.dataQuality,
        skippedInstances,
      },
    },
    groups: groupRows,
  }
}

/** 给 runtime 用：这次归约对应的缓存指纹（不含 asOf）。 */
export function metricsFingerprintFor(instance, options = {}) {
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    lastSeq: Number.isInteger(instance?.lastSeq) ? instance.lastSeq : 0,
    revision: Number.isInteger(instance?.revision) ? instance.revision : 0,
    connector: typeof options.connector === 'string' ? options.connector : '',
    resources: Number.isInteger(options.resources) ? options.resources : 0,
  }
}

// 保留导出：测试可核对「同一 callId 替换而不是累加」。
export { usageCallKey, recordUsageCall }
