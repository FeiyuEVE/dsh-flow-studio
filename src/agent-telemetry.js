/**
 * Agent 调用的遥测事实：调用身份、usage 归一化、结算快照、可信来源标记。
 *
 * 口径唯一来源：`docs/design/12-instance-metrics.md`。本模块只做纯函数，不读写文件、
 * 不碰实例状态：
 *
 *   - 调用身份 = `provider + callId`。同一 callId 的多次上报是**替换**，不是累加；
 *     真实的新调用必须由适配器给新的 callId。
 *   - 四桶归一化 `{input, cacheRead, cacheWrite, output, total}`，**缺失桶是 null，
 *     不是 0**；明确上报的 0 保留为 0。`total` 只在四桶都观测到时是数字，否则 null。
 *   - 归一化结果带 `canonical` 版本标记：指标层再次读取事件里的 usage 时**只校验、
 *     不重算**（Codex 的 inclusive input 不会被二次扣缓存）。
 *   - `reasoning` 是 output 的子集：只记录 `0 ≤ reasoning ≤ output`，绝不另加进 total。
 *   - 不可观测不是零：没有 usage 时 `usage:null` + `trust:'unknown'` + `reason`；
 *     只有真的看到数值才标 `known`。范围结算由独立的 `agent/usage-snapshot` 承载
 *     （不计入模型调用数）；synthetic 记录只是未知占位，也不算模型调用。
 *
 * @module @feiyueve/dsh-flow-studio/agent-telemetry
 */

/** 遥测事件（由 `agent-execute` 经 handler `events[]` 透传到实例事件流）。 */
export const AGENT_USAGE_EVENT = 'agent/usage'
/** 范围级结算快照（result 的最终用量）：**不是**一次模型调用。 */
export const AGENT_USAGE_SNAPSHOT_EVENT = 'agent/usage-snapshot'
/** 一次 agent 实际启动 / 提醒续跑轮次。 */
export const AGENT_INVOCATION_EVENT = 'agent/invocation'

/**
 * usage 数据的形状 / 覆盖语义版本。事件与指标都用它判「旧数据能不能当完整」。
 * 历史事件没有 `observedBuckets` 时按「完整性未知」处理。
 */
export const USAGE_SCHEMA_VERSION = 2

/** 归一化 usage 的 canonical 版本（写进 `usage.canonical`）。 */
export const CANONICAL_USAGE_VERSION = 1

/** usage 可信来源。 */
export const USAGE_TRUST = Object.freeze({
  KNOWN: 'known',
  UNKNOWN: 'unknown',
})

/** 观测覆盖档位（`known` 完整 / `partial` 部分 / `unknown` 全未知）。 */
export const USAGE_COVERAGE = Object.freeze({
  KNOWN: 'known',
  PARTIAL: 'partial',
  UNKNOWN: 'unknown',
})

/** 结算快照的统计作用域。 */
export const USAGE_SCOPE = Object.freeze({
  INVOCATION: 'invocation',
  SESSION_CUMULATIVE: 'session-cumulative',
  UNKNOWN: 'unknown',
})

/** 未知原因（稳定字符串，写进 dataQuality.reasons / 事件 reason）。 */
export const USAGE_REASON = Object.freeze({
  /** 适配器没有 usage 能力（或宿主没有暴露）。 */
  UNAVAILABLE: 'usage-unavailable',
  /** 给了 usage 但字段不是一个可认的数值形状。 */
  MALFORMED: 'usage-malformed',
  /** 四桶里有些桶从未上报（纯信息，不把缺桶当成 0 的谎）。 */
  MISSING_BUCKETS: 'usage-missing-buckets',
})

/** 四桶顺序（与 05 §3 / instance metrics 一致，不另立第四套命名）。 */
export const USAGE_BUCKETS = Object.freeze(['input', 'cacheRead', 'cacheWrite', 'output'])

const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CALL_ID_PATTERN = /^[^\u0000-\u001f]{1,256}$/
const SNAPSHOT_SCOPE_VALUES = new Set(Object.values(USAGE_SCOPE))

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function boundedString(value, max = 128) {
  if (typeof value !== 'string' || value === '') return null
  return value.length > max ? value.slice(0, max) : value
}

/** provider 标识归一化；非法一律 `unknown`（不猜 provider 语义）。 */
export function normalizeProvider(provider) {
  if (typeof provider !== 'string') return 'unknown'
  const text = provider.trim().toLowerCase()
  return PROVIDER_PATTERN.test(text) ? text : 'unknown'
}

/**
 * 该 provider 的 `input_tokens` 是否包含缓存子集。
 *
 * @param {string} provider 归一化后的 provider id
 * @returns {boolean}
 */
export function providerInputIncludesCache(provider) {
  const id = normalizeProvider(provider)
  if (id === 'codex' || id.startsWith('codex-') || id === 'openai' || id.startsWith('openai-')) return true
  return false
}

/** 非负整数；不是数值（含 null / undefined / 负数 / NaN / 字符串）一律 null。 */
function nonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

function firstInt(source, keys) {
  for (const key of keys) {
    if (source[key] === undefined || source[key] === null) continue
    const value = nonNegativeInt(source[key])
    if (value !== null) return value
    // 给了字段但不是合法非负数 → 整个 usage 不可信，不把坏值当 0。
    return null
  }
  return undefined
}

const INPUT_KEYS = ['input', 'inputTokens', 'input_tokens']
const OUTPUT_KEYS = ['output', 'outputTokens', 'output_tokens']
const CACHE_READ_KEYS = ['cacheRead', 'cacheReadTokens', 'cache_read_input_tokens', 'cached_input_tokens', 'cachedInputTokens']
// `cache_creation_input_tokens` 是 Anthropic 的字段名；放在最后，显式 cache_write 别名优先。
const CACHE_WRITE_KEYS = ['cacheWrite', 'cacheWriteTokens', 'cache_write_input_tokens', 'cacheWriteInputTokens', 'cache_creation_input_tokens']
const REASONING_KEYS = ['reasoning', 'reasoningTokens', 'reasoning_output_tokens']

/** provider 原始 usage 里**只会出现在原始形状**的字段（判定 canonical 用）。 */
const PROVIDER_RAW_KEYS = [
  'inputTokens', 'input_tokens',
  'outputTokens', 'output_tokens',
  'cacheReadTokens', 'cache_read_input_tokens', 'cached_input_tokens', 'cachedInputTokens',
  'cacheWriteTokens', 'cache_write_input_tokens', 'cacheWriteInputTokens',
  'cache_creation_input_tokens', 'reasoning_output_tokens', 'reasoningTokens',
  'totalTokens', 'total_tokens',
]
const CANONICAL_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output', 'total']

/** 这份 usage 是否已经是 canonical 形状（带版本标记，或只含 canonical 桶键）。 */
function looksCanonicalUsage(raw) {
  if (!isPlainObject(raw)) return false
  if (raw.canonical !== undefined) return true
  if (PROVIDER_RAW_KEYS.some(key => raw[key] !== undefined)) return false
  return CANONICAL_KEYS.some(key => key in raw)
}

/** 观测列表归一化：显式掩码优先；缺掩码时按 usage 里的数字推导。 */
export function normalizeObservedBuckets(list, usage) {
  const out = []
  const source = Array.isArray(list) ? list : null
  for (const bucket of USAGE_BUCKETS) {
    const value = isPlainObject(usage) ? usage[bucket] : null
    if (source === null) {
      if (Number.isInteger(value)) out.push(bucket)
      continue
    }
    if (source.includes(bucket) && Number.isInteger(value)) out.push(bucket)
  }
  return out
}

/**
 * 观测覆盖档位：`known`（四桶都观测到）/ `partial`（部分）/ `unknown`（没有观测）。
 *
 * @param {object|null} usage
 * @param {string[]|undefined} observedBuckets
 * @returns {'known'|'partial'|'unknown'}
 */
export function usageCoverageOf(usage, observedBuckets) {
  if (!isPlainObject(usage)) return USAGE_COVERAGE.UNKNOWN
  const observed = normalizeObservedBuckets(observedBuckets, usage)
  if (observed.length === 0) return USAGE_COVERAGE.UNKNOWN
  if (observed.length === USAGE_BUCKETS.length) return USAGE_COVERAGE.KNOWN
  return USAGE_COVERAGE.PARTIAL
}

function sumBuckets(usage) {
  return USAGE_BUCKETS.reduce((acc, bucket) => acc + usage[bucket], 0)
}

/** canonical usage 只校验、不重算（Codex inclusive input 不在这里二次拆桶）。 */
function normalizeCanonicalUsage(raw, provider) {
  const usage = { input: null, cacheRead: null, cacheWrite: null, output: null, total: null, canonical: CANONICAL_USAGE_VERSION }
  const observed = []
  for (const bucket of USAGE_BUCKETS) {
    const value = raw[bucket]
    if (value === undefined || value === null) continue
    const normalized = nonNegativeInt(value)
    if (normalized === null) return unknownUsage(provider, USAGE_REASON.MALFORMED)
    usage[bucket] = normalized
    observed.push(bucket)
  }
  if (observed.length === 0) return unknownUsage(provider, USAGE_REASON.MALFORMED)
  let reportedTotal = null
  if (raw.total !== undefined && raw.total !== null) {
    reportedTotal = nonNegativeInt(raw.total)
    if (reportedTotal === null) return unknownUsage(provider, USAGE_REASON.MALFORMED)
  }
  const reasoning = nonNegativeInt(raw.reasoning)
  if (raw.reasoning !== undefined && raw.reasoning !== null && reasoning === null) {
    return unknownUsage(provider, USAGE_REASON.MALFORMED)
  }
  const complete = observed.length === USAGE_BUCKETS.length
  if (complete) usage.total = sumBuckets(usage)
  if (reasoning !== null && usage.output !== null && reasoning <= usage.output) usage.reasoning = reasoning
  const totalMismatch = complete && reportedTotal !== null && reportedTotal !== usage.total
  return {
    trust: USAGE_TRUST.KNOWN,
    provider,
    usage,
    observedBuckets: USAGE_BUCKETS.filter(bucket => observed.includes(bucket)),
    reason: null,
    reportedTotal,
    totalMismatch,
  }
}

/**
 * 归一化一份原始 usage。
 *
 * @param {object} raw
 * @param {{provider?: string, inputIncludesCache?: boolean}} [options]
 * @returns {{trust: 'known'|'unknown', provider: string, usage: null|{
 *   input:number|null, cacheRead:number|null, cacheWrite:number|null, output:number|null,
 *   total:number|null, canonical:number, reasoning?:number, inputInclusiveUnresolved?:boolean,
 * }, observedBuckets: string[], reason: string|null, reportedTotal: number|null}}
 */
export function normalizeUsage(raw, options = {}) {
  const provider = normalizeProvider(options.provider)
  if (!isPlainObject(raw)) {
    return unknownUsage(provider, USAGE_REASON.MALFORMED)
  }
  if (looksCanonicalUsage(raw)) return normalizeCanonicalUsage(raw, provider)

  const rawInput = firstInt(raw, INPUT_KEYS)
  const output = firstInt(raw, OUTPUT_KEYS)
  const cacheReadRaw = firstInt(raw, CACHE_READ_KEYS)
  const cacheWriteRaw = firstInt(raw, CACHE_WRITE_KEYS)
  const reasoningRaw = firstInt(raw, REASONING_KEYS)
  if (rawInput === null || output === null || cacheReadRaw === null || cacheWriteRaw === null || reasoningRaw === null) {
    return unknownUsage(provider, USAGE_REASON.MALFORMED)
  }
  const inputObserved = rawInput !== undefined
  const outputObserved = output !== undefined
  const cacheReadObserved = cacheReadRaw !== undefined
  const cacheWriteObserved = cacheWriteRaw !== undefined
  if (!inputObserved && !outputObserved && !cacheReadObserved && !cacheWriteObserved) {
    return unknownUsage(provider, USAGE_REASON.MALFORMED)
  }
  let reportedTotal = null
  if (raw.total !== undefined || raw.totalTokens !== undefined || raw.total_tokens !== undefined) {
    reportedTotal = firstInt(raw, ['total', 'totalTokens', 'total_tokens'])
    if (reportedTotal === null) return unknownUsage(provider, USAGE_REASON.MALFORMED)
  }

  const includesCache = options.inputIncludesCache !== undefined
    ? options.inputIncludesCache === true
    : providerInputIncludesCache(provider)
  let input = inputObserved ? rawInput : null
  let cacheRead = cacheReadObserved ? cacheReadRaw : null
  let cacheWrite = cacheWriteObserved ? cacheWriteRaw : null
  let inputInclusiveUnresolved = false
  if (includesCache && inputObserved) {
    if (cacheReadObserved && cacheWriteObserved) {
      // 上游可能给出 cached > input 的矛盾数据：先读后写截断，守住四桶之和 === total。
      cacheRead = Math.min(cacheReadRaw, rawInput)
      cacheWrite = Math.min(cacheWriteRaw, rawInput - cacheRead)
      input = Math.max(0, rawInput - cacheRead - cacheWrite)
    } else {
      // inclusive input 缺缓存组成：exclusive input 不能宣称精确（不让缓存被二次扣减）。
      input = null
      inputInclusiveUnresolved = true
    }
  }

  const values = { input, cacheRead, cacheWrite, output: outputObserved ? output : null }
  const observed = []
  if (inputObserved && !inputInclusiveUnresolved) observed.push('input')
  if (cacheReadObserved) observed.push('cacheRead')
  if (cacheWriteObserved) observed.push('cacheWrite')
  if (outputObserved) observed.push('output')
  const usage = {
    input: values.input,
    cacheRead: values.cacheRead,
    cacheWrite: values.cacheWrite,
    output: values.output,
    total: null,
    canonical: CANONICAL_USAGE_VERSION,
  }
  if (inputInclusiveUnresolved) usage.inputInclusiveUnresolved = true
  const complete = USAGE_BUCKETS.every(bucket => Number.isInteger(usage[bucket]))
  if (complete) usage.total = sumBuckets(usage)
  if (reasoningRaw !== null && reasoningRaw !== undefined && Number.isInteger(usage.output) && reasoningRaw <= usage.output) {
    usage.reasoning = reasoningRaw
  }
  return {
    trust: observed.length > 0 ? USAGE_TRUST.KNOWN : USAGE_TRUST.UNKNOWN,
    provider,
    usage,
    observedBuckets: USAGE_BUCKETS.filter(bucket => observed.includes(bucket)),
    reason: observed.length > 0 ? null : USAGE_REASON.UNAVAILABLE,
    reportedTotal,
  }
}

function unknownUsage(provider, reason, detail = undefined) {
  return {
    trust: USAGE_TRUST.UNKNOWN,
    provider: normalizeProvider(provider),
    usage: null,
    observedBuckets: [],
    reason,
    ...(detail === undefined ? {} : { detail }),
    reportedTotal: null,
  }
}

/** 允许 synthetic 未知占位显式透传的 reason（只这两个，不扩枚举）。 */
const UNKNOWN_REASON_PASSTHROUGH = new Set([USAGE_REASON.UNAVAILABLE, USAGE_REASON.MALFORMED])

/**
 * 一条调用遥测记录：适配器只给原始 usage，这里统一成可落盘的事实。
 *
 * `reason` 只对 **synthetic 且 usage 为 null** 的未知占位生效，且只接受
 * `usage-unavailable` / `usage-malformed`：适配器能区分「没有能力」与「给了坏形状」，
 * 但这条透传不能覆盖真实坏数值（usage 不是 null 时仍走归一化结论）。
 *
 * @param {{provider?: string, callId: string, usage?: object|null, source?: string,
 *   invocationId?: string|null, sessionScopeId?: string|null, agentScope?: string|null,
 *   observedBuckets?: string[], inputIncludesCache?: boolean, synthetic?: boolean,
 *   provisional?: boolean, reason?: string}} input
 * @returns {object}
 */
export function createUsageCall(input = {}) {
  const provider = normalizeProvider(input.provider)
  const callId = nonEmptyString(input.callId) && CALL_ID_PATTERN.test(input.callId)
    ? input.callId
    : null
  const flags = {
    synthetic: input.synthetic === true,
    provisional: input.provisional === true,
  }
  const scope = {
    source: typeof input.source === 'string' && input.source !== '' ? input.source : null,
    invocationId: boundedString(input.invocationId),
    sessionScopeId: boundedString(input.sessionScopeId),
    agentScope: boundedString(input.agentScope),
  }
  if (callId === null) {
    return {
      provider,
      callId: null,
      trust: USAGE_TRUST.UNKNOWN,
      usage: null,
      observedBuckets: [],
      reason: USAGE_REASON.MALFORMED,
      ...scope,
      ...flags,
    }
  }
  const normalized = normalizeUsage(input.usage, {
    provider,
    ...(input.inputIncludesCache === undefined ? {} : { inputIncludesCache: input.inputIncludesCache }),
  })
  const observedBuckets = normalized.usage === null
    ? []
    : normalizeObservedBuckets(
      Array.isArray(input.observedBuckets) ? input.observedBuckets : undefined,
      normalized.usage,
    )
  const usageAbsent = input.usage === null || input.usage === undefined
  const explicitReason = typeof input.reason === 'string' ? input.reason : null
  const reason = flags.synthetic && usageAbsent && explicitReason !== null
    && UNKNOWN_REASON_PASSTHROUGH.has(explicitReason)
    ? explicitReason
    : normalized.reason
  return {
    provider,
    callId,
    trust: normalized.trust,
    usage: normalized.usage,
    observedBuckets,
    reason,
    ...scope,
    ...flags,
    ...(normalized.totalMismatch === true ? { totalMismatch: true } : {}),
  }
}

/**
 * 一条范围级结算快照。`usage` 不合法 / 无法识别时返回 `null`（调用方记诊断）。
 *
 * @param {{provider?: string, snapshotId: string, scope?: string, usage?: object,
 *   observedBuckets?: string[], invocationId?: string|null, sessionScopeId?: string|null,
 *   agentScope?: string|null, provenance?: object, inputIncludesCache?: boolean}} input
 * @returns {object|null}
 */
export function createUsageSnapshot(input = {}) {
  const provider = normalizeProvider(input.provider)
  const snapshotId = nonEmptyString(input.snapshotId) && CALL_ID_PATTERN.test(input.snapshotId)
    ? input.snapshotId
    : null
  if (snapshotId === null) return null
  const normalized = normalizeUsage(input.usage, {
    provider,
    ...(input.inputIncludesCache === undefined ? {} : { inputIncludesCache: input.inputIncludesCache }),
  })
  if (normalized.trust !== USAGE_TRUST.KNOWN) return null
  if (input.scope !== undefined && input.scope !== null && !SNAPSHOT_SCOPE_VALUES.has(input.scope)) return null
  const scope = SNAPSHOT_SCOPE_VALUES.has(input.scope) ? input.scope : USAGE_SCOPE.UNKNOWN
  const observedBuckets = normalizeObservedBuckets(
    Array.isArray(input.observedBuckets) ? input.observedBuckets : undefined,
    normalized.usage,
  )
  const provenance = isPlainObject(input.provenance) ? input.provenance : {}
  return {
    provider,
    snapshotId,
    scope,
    invocationId: boundedString(input.invocationId),
    sessionScopeId: boundedString(input.sessionScopeId),
    agentScope: boundedString(input.agentScope),
    usage: normalized.usage,
    observedBuckets,
    provenance: {
      contract: boundedString(provenance.contract) ?? 'usage-snapshot-v1',
      realCliVerified: provenance.realCliVerified === true,
    },
  }
}

/** 调用去重键：provider + callId。 */
export function usageCallKey(call) {
  const provider = normalizeProvider(call?.provider)
  const callId = typeof call?.callId === 'string' ? call.callId : ''
  return `${provider}\u0000${callId}`
}

/**
 * 把调用放进去重账本（同一 callId 替换，不累加）。
 *
 * @param {Map<string, object>} calls
 * @param {object} call
 * @returns {Map<string, object>} 原 map（便于链式）
 */
export function recordUsageCall(calls, call) {
  if (!(calls instanceof Map) || !isPlainObject(call)) return calls
  const key = usageCallKey(call)
  if (key.endsWith('\u0000')) return calls
  calls.set(key, call)
  return calls
}

/**
 * 汇总一组调用（已按 callId 去重后的最新值）。
 *
 * 缺失桶汇总后仍是 `null`；`total` 只在所有调用都完整观测时才是数字。
 *
 * @param {Iterable<object>} calls
 * @returns {{known:number, partial:number, unknown:number,
 *   coverage:{known:number,partial:number,unknown:number}, usage:null|object,
 *   bucketsSeen:string[], bucketsMissing:string[], complete:boolean}}
 */
export function summarizeUsageCalls(calls) {
  const sums = { input: null, cacheRead: null, cacheWrite: null, output: null, total: null }
  const missing = new Set()
  const seen = new Set()
  const coverage = { known: 0, partial: 0, unknown: 0 }
  let any = false
  let complete = true
  for (const call of calls ?? []) {
    if (!isPlainObject(call)) continue
    any = true
    const level = usageCoverageOf(call.usage, call.observedBuckets)
    coverage[level] += 1
    if (level !== USAGE_COVERAGE.KNOWN) complete = false
    // provisional（assistant output 占位、没有 result 结算）不能算完整调用；
    // 覆盖档位仍如实说「四桶都观测过」，但 total 不能当最终值。
    if (call.provisional === true) complete = false
    for (const bucket of USAGE_BUCKETS) {
      const value = isPlainObject(call.usage) ? call.usage[bucket] : null
      if (!Number.isInteger(value)) {
        missing.add(bucket)
        sums[bucket] = null
        continue
      }
      seen.add(bucket)
      if (!missing.has(bucket)) sums[bucket] = (sums[bucket] ?? 0) + value
    }
  }
  const bucketsSeen = USAGE_BUCKETS.filter(bucket => seen.has(bucket))
  const bucketsMissing = USAGE_BUCKETS.filter(bucket => !seen.has(bucket))
  if (complete && USAGE_BUCKETS.every(bucket => Number.isInteger(sums[bucket]))) {
    sums.total = USAGE_BUCKETS.reduce((acc, bucket) => acc + sums[bucket], 0)
  }
  return {
    known: coverage.known,
    partial: coverage.partial,
    unknown: coverage.unknown,
    coverage,
    usage: any ? sums : null,
    bucketsSeen,
    bucketsMissing,
    complete: complete && bucketsMissing.length === 0,
  }
}

function readHandleList(handle, methodName, propertyName) {
  if (!handle || typeof handle !== 'object') return []
  let raw
  try {
    if (typeof handle[methodName] === 'function') raw = handle[methodName]()
    else raw = handle[propertyName]
  } catch {
    return []
  }
  return Array.isArray(raw) ? raw : []
}

/**
 * 从适配器 handle 读取 usage 调用记录。
 *
 * 约定（可选扩展，不破坏冻结接口）：
 *   - `handle.usageCalls` 是数组，或返回数组的函数；
 *   - 每条 `{ provider?, callId, usage, observedBuckets?, source?, invocationId?,
 *     sessionScopeId?, synthetic?, provisional? }`；
 *   - 适配器不提供或没有观测到 usage 时返回 `[]`（由调用方标 unknown）。
 *
 * @param {object|null} handle
 * @param {string} fallbackProvider
 * @returns {object[]} 已按 callId 去重的调用记录
 */
export function readAdapterUsageCalls(handle, fallbackProvider = 'unknown') {
  const raw = readHandleList(handle, 'usageCalls', 'usageCalls')
  if (raw.length === 0) return []
  const deduped = new Map()
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const call = createUsageCall({
      provider: nonEmptyString(item.provider) ? item.provider : fallbackProvider,
      callId: item.callId,
      usage: item.usage,
      source: item.source,
      invocationId: item.invocationId,
      sessionScopeId: item.sessionScopeId,
      agentScope: item.agentScope,
      synthetic: item.synthetic,
      provisional: item.provisional,
      reason: item.reason,
      ...(Array.isArray(item.observedBuckets) ? { observedBuckets: item.observedBuckets } : {}),
      ...(item.inputIncludesCache === undefined ? {} : { inputIncludesCache: item.inputIncludesCache }),
    })
    if (!nonEmptyString(call.callId)) continue
    recordUsageCall(deduped, call)
  }
  return [...deduped.values()]
}

/**
 * 从适配器 handle 读取可选的结算快照（`handle.usageSnapshots` / `handle.usageSnapshots()`）。
 *
 * @param {object|null} handle
 * @param {string} fallbackProvider
 * @returns {object[]} 已校验的快照记录（同一 snapshotId 取最后一次）
 */
export function readAdapterUsageSnapshots(handle, fallbackProvider = 'unknown') {
  const raw = readHandleList(handle, 'usageSnapshots', 'usageSnapshots')
  if (raw.length === 0) return []
  const deduped = new Map()
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const snapshot = createUsageSnapshot({
      provider: nonEmptyString(item.provider) ? item.provider : fallbackProvider,
      snapshotId: item.snapshotId,
      scope: item.scope,
      usage: item.usage,
      observedBuckets: item.observedBuckets,
      invocationId: item.invocationId,
      sessionScopeId: item.sessionScopeId,
      agentScope: item.agentScope,
      provenance: item.provenance,
      ...(item.inputIncludesCache === undefined ? {} : { inputIncludesCache: item.inputIncludesCache }),
    })
    if (snapshot === null) continue
    deduped.set(snapshot.snapshotId, snapshot)
  }
  return [...deduped.values()]
}

/**
 * 调用记录 → 可落盘的 `agent/usage` 事件（不含 at / elementId / activityId，
 * 由 runner 补齐）。`observedBuckets` **始终**出现在事件里（空数组也写），
 * 这样读取侧不需要从补零结果反推观测范围。
 *
 * @param {object} call
 * @returns {object}
 */
export function usageEventForCall(call) {
  const invocationId = boundedString(call.invocationId)
  const sessionScopeId = boundedString(call.sessionScopeId)
  const agentScope = boundedString(call.agentScope)
  return {
    type: AGENT_USAGE_EVENT,
    provider: normalizeProvider(call.provider),
    callId: call.callId,
    trust: call.trust,
    ...(call.usage === null || call.usage === undefined ? {} : { usage: call.usage }),
    ...(call.reason === null || call.reason === undefined ? {} : { reason: call.reason }),
    observedBuckets: Array.isArray(call.observedBuckets) ? [...call.observedBuckets] : [],
    ...(typeof call.source === 'string' && call.source !== '' ? { source: call.source } : {}),
    ...(invocationId === null ? {} : { invocationId }),
    ...(sessionScopeId === null ? {} : { sessionScopeId }),
    ...(agentScope === null ? {} : { agentScope }),
    ...(call.synthetic === true ? { synthetic: true } : {}),
    ...(call.provisional === true ? { provisional: true } : {}),
  }
}

/**
 * 结算快照 → 可落盘的 `agent/usage-snapshot` 事件。
 *
 * 事件保持短小：不带 callId 数组，只带范围标量与本次快照的用量。
 *
 * @param {object} snapshot
 * @returns {object}
 */
export function usageSnapshotEventFor(snapshot) {
  const invocationId = boundedString(snapshot.invocationId)
  const sessionScopeId = boundedString(snapshot.sessionScopeId)
  const agentScope = boundedString(snapshot.agentScope)
  return {
    type: AGENT_USAGE_SNAPSHOT_EVENT,
    provider: normalizeProvider(snapshot.provider),
    snapshotId: snapshot.snapshotId,
    scope: SNAPSHOT_SCOPE_VALUES.has(snapshot.scope) ? snapshot.scope : USAGE_SCOPE.UNKNOWN,
    usage: snapshot.usage,
    observedBuckets: Array.isArray(snapshot.observedBuckets) ? [...snapshot.observedBuckets] : [],
    // 合同字段始终出现（未知就是 null），读取侧不用猜「缺字段」还是「没有范围」。
    invocationId: invocationId ?? null,
    sessionScopeId: sessionScopeId ?? null,
    agentScope: agentScope ?? null,
    provenance: {
      contract: boundedString(snapshot.provenance?.contract) ?? 'usage-snapshot-v1',
      realCliVerified: snapshot.provenance?.realCliVerified === true,
    },
  }
}

/**
 * 「这次调用没有 usage」的事实事件（不是 0，是 unknown）。`synthetic: true` 显式
 * 标记它是未知占位记录：**不算一次已识别模型调用**。
 *
 * @param {{provider?: string, invocationId: string, callId?: string, reason?: string}} input
 * @returns {object}
 */
export function unknownUsageEvent(input = {}) {
  const provider = normalizeProvider(input.provider)
  const invocationId = typeof input.invocationId === 'string' && input.invocationId !== ''
    ? input.invocationId
    : null
  return {
    type: AGENT_USAGE_EVENT,
    provider,
    callId: typeof input.callId === 'string' && input.callId !== ''
      ? input.callId
      : `${provider}:${invocationId ?? 'unknown'}:unobserved`,
    trust: USAGE_TRUST.UNKNOWN,
    reason: typeof input.reason === 'string' && input.reason !== '' ? input.reason : USAGE_REASON.UNAVAILABLE,
    observedBuckets: [],
    synthetic: true,
    ...(invocationId === null ? {} : { invocationId }),
  }
}

/**
 * 一次实际启动 / 提醒续跑的调用身份事件。
 *
 * `invocationId` 必须稳定且唯一：初始轮 `=<executionId>:invoke-1`，
 * 第 N 次提醒续跑 `=<executionId>:invoke-rN`。这样「提醒续跑计调用、不计新
 * BPMN attempt」可以由事件账本直接算出来。
 *
 * @param {{invocationId: string, provider?: string, phase?: string,
 *   attempt?: number, count?: number}} input
 * @returns {object}
 */
export function invocationEvent(input = {}) {
  const invocationId = typeof input.invocationId === 'string' ? input.invocationId : ''
  return {
    type: AGENT_INVOCATION_EVENT,
    invocationId,
    provider: normalizeProvider(input.provider),
    phase: input.phase === 'reminder' ? 'reminder' : 'start',
    ...(Number.isInteger(input.attempt) && input.attempt >= 1 ? { attempt: input.attempt } : {}),
    ...(Number.isInteger(input.count) && input.count >= 1 ? { count: input.count } : {}),
  }
}

/**
 * 面向适配器的能力档位（`capabilities().usage`）。
 * 与 `agent-adapter.js` 的校验共用同一组值；缺省按 `unknown` 处理。
 */
export const USAGE_SUPPORT = Object.freeze({
  NATIVE: 'native',
  UNKNOWN: 'unknown',
})
