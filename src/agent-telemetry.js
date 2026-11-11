/**
 * Agent 调用的遥测事实：调用身份、usage 归一化、可信来源标记。
 *
 * 口径唯一来源：`docs/design/12-instance-metrics.md`（`docs/design/05-run-log.md`
 * 的四桶语义在实例域的唯一实现处）。本模块只做纯函数，不读写文件、不碰实例状态：
 *
 *   - 调用身份 = `provider + callId`。同一 callId 的多次上报是**替换**，不是累加；
 *     真实的新调用必须由适配器给新的 callId（例如 codex 每轮 `turn.completed`、
 *     dsh 每个 `attemptId`）。
 *   - 四桶归一化 `{input, cacheRead, cacheWrite, output, total}`：
 *       * 有的 provider（codex / OpenAI 风格）的 `input_tokens` 已经把缓存命中与
 *         缓存写入算在里头，必须先拆出去，不能 cacheRead 再加一遍；
 *       * 有的 provider（dsh / DeepSeek TokenUsage）四桶本来就是互斥的，不能再拆。
 *     `total` 恒等于四桶之和，保证「total 不因拆桶而变大」。
 *   - `reasoning` 是 output 的子集：只记录 `0 ≤ reasoning ≤ output`，绝不另加进 total。
 *   - 不可观测不是零：没有 usage 时 `usage:null` + `trust:'unknown'` + `reason`；
 *     只有真的看到数值才标 `known`。
 *
 * @module @feiyueve/dsh-flow-studio/agent-telemetry
 */

/** 遥测事件（由 `agent-execute` 经 handler `events[]` 透传到实例事件流）。 */
export const AGENT_USAGE_EVENT = 'agent/usage'
/** 一次 agent 实际启动 / 提醒续跑轮次。 */
export const AGENT_INVOCATION_EVENT = 'agent/invocation'

/** usage 可信来源。 */
export const USAGE_TRUST = Object.freeze({
  KNOWN: 'known',
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

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
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

function hasAny(source, keys) {
  return keys.some(key => source[key] !== undefined && source[key] !== null)
}

const INPUT_KEYS = ['input', 'inputTokens', 'input_tokens']
const OUTPUT_KEYS = ['output', 'outputTokens', 'output_tokens']
const CACHE_READ_KEYS = ['cacheRead', 'cacheReadTokens', 'cache_read_input_tokens', 'cached_input_tokens', 'cachedInputTokens']
const CACHE_WRITE_KEYS = ['cacheWrite', 'cacheWriteTokens', 'cache_write_input_tokens', 'cacheWriteInputTokens']
const REASONING_KEYS = ['reasoning', 'reasoningTokens', 'reasoning_output_tokens', 'reasoningTokens']

/**
 * 归一化一份原始 usage。
 *
 * @param {object} raw
 * @param {{provider?: string, inputIncludesCache?: boolean}} [options]
 * @returns {{trust: 'known'|'unknown', provider: string, usage: null|{input:number,cacheRead:number,cacheWrite:number,output:number,total:number,reasoning?:number}, observedBuckets: string[], reason: string|null, reportedTotal: number|null}}
 */
export function normalizeUsage(raw, options = {}) {
  const provider = normalizeProvider(options.provider)
  if (!isPlainObject(raw)) {
    return unknownUsage(provider, USAGE_REASON.MALFORMED)
  }
  const rawInput = firstInt(raw, INPUT_KEYS)
  const output = firstInt(raw, OUTPUT_KEYS)
  if (rawInput === undefined && output === undefined) {
    return unknownUsage(provider, USAGE_REASON.MALFORMED)
  }
  // 只要有 input/output 其中一项，缺的另一项按 0 参与求和；但记录它「没上报」。
  if (rawInput === null || output === null) {
    return unknownUsage(provider, USAGE_REASON.MALFORMED)
  }
  const inputValue = rawInput === undefined ? 0 : rawInput
  const outputValue = output === undefined ? 0 : output
  const cacheReadRaw = firstInt(raw, CACHE_READ_KEYS)
  const cacheWriteRaw = firstInt(raw, CACHE_WRITE_KEYS)
  const reasoningRaw = firstInt(raw, REASONING_KEYS)
  if (cacheReadRaw === null || cacheWriteRaw === null || reasoningRaw === null) {
    return unknownUsage(provider, USAGE_REASON.MALFORMED)
  }
  const reportedTotal = firstInt(raw, ['total', 'totalTokens', 'total_tokens'])

  const includesCache = options.inputIncludesCache !== undefined
    ? options.inputIncludesCache === true
    : providerInputIncludesCache(provider)
  const cacheRead = cacheReadRaw ?? 0
  const cacheWrite = cacheWriteRaw ?? 0
  let input = inputValue
  let cacheReadValue = cacheRead
  let cacheWriteValue = cacheWrite
  if (includesCache) {
    // 上游可能给出 cached > input 的矛盾数据：先读后写截断，守住四桶之和 === total。
    cacheReadValue = Math.min(cacheRead, inputValue)
    cacheWriteValue = Math.min(cacheWrite, inputValue - cacheReadValue)
    input = Math.max(0, inputValue - cacheReadValue - cacheWriteValue)
  }
  const total = input + cacheReadValue + cacheWriteValue + outputValue
  const usage = {
    input,
    cacheRead: cacheReadValue,
    cacheWrite: cacheWriteValue,
    output: outputValue,
    total,
  }
  if (reasoningRaw !== null && reasoningRaw >= 0 && reasoningRaw <= outputValue) {
    usage.reasoning = reasoningRaw
  }
  const observedBuckets = []
  if (rawInput !== undefined) observedBuckets.push('input')
  if (cacheReadRaw !== null && cacheReadRaw !== undefined) observedBuckets.push('cacheRead')
  if (cacheWriteRaw !== null && cacheWriteRaw !== undefined) observedBuckets.push('cacheWrite')
  if (output !== undefined) observedBuckets.push('output')
  return {
    trust: USAGE_TRUST.KNOWN,
    provider,
    usage,
    observedBuckets,
    reason: null,
    reportedTotal: reportedTotal === undefined ? null : reportedTotal,
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

/**
 * 一条调用遥测记录：适配器只给原始 usage，这里统一成可落盘的事实。
 *
 * @param {{provider?: string, callId: string, usage?: object, source?: string,
 *   invocationId?: string|null, inputIncludesCache?: boolean, at?: string}} input
 * @returns {{provider: string, callId: string, trust: string, usage: object|null,
 *   observedBuckets: string[], reason: string|null, source: string|null,
 *   invocationId: string|null}}
 */
export function createUsageCall(input = {}) {
  const provider = normalizeProvider(input.provider)
  const callId = nonEmptyString(input.callId) && CALL_ID_PATTERN.test(input.callId)
    ? input.callId
    : null
  if (callId === null) {
    return {
      provider,
      callId: null,
      trust: USAGE_TRUST.UNKNOWN,
      usage: null,
      observedBuckets: [],
      reason: USAGE_REASON.MALFORMED,
      source: input.source ?? null,
      invocationId: input.invocationId ?? null,
    }
  }
  const normalized = normalizeUsage(input.usage, {
    provider,
    ...(input.inputIncludesCache === undefined ? {} : { inputIncludesCache: input.inputIncludesCache }),
  })
  return {
    provider,
    callId,
    trust: normalized.trust,
    usage: normalized.usage,
    observedBuckets: normalized.observedBuckets,
    reason: normalized.reason,
    source: typeof input.source === 'string' && input.source !== '' ? input.source : null,
    invocationId: typeof input.invocationId === 'string' && input.invocationId !== '' ? input.invocationId : null,
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
 * @param {Iterable<object>} calls
 * @returns {{known:number, unknown:number, usage:null|object, bucketsSeen:string[], bucketsMissing:string[]}}
 */
export function summarizeUsageCalls(calls) {
  const sums = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
  const seen = new Set()
  let known = 0
  let unknown = 0
  for (const call of calls ?? []) {
    if (!isPlainObject(call)) continue
    if (call.trust !== USAGE_TRUST.KNOWN || !isPlainObject(call.usage)) {
      unknown += 1
      continue
    }
    known += 1
    for (const bucket of USAGE_BUCKETS) {
      const value = call.usage[bucket]
      if (Number.isInteger(value) && value >= 0) sums[bucket] += value
    }
    sums.total += Number.isInteger(call.usage.total) && call.usage.total >= 0
      ? call.usage.total
      : USAGE_BUCKETS.reduce((acc, bucket) => acc + (Number.isInteger(call.usage[bucket]) ? call.usage[bucket] : 0), 0)
    for (const bucket of Array.isArray(call.observedBuckets) ? call.observedBuckets : []) {
      if (USAGE_BUCKETS.includes(bucket)) seen.add(bucket)
    }
  }
  return {
    known,
    unknown,
    usage: known > 0 ? sums : null,
    bucketsSeen: USAGE_BUCKETS.filter(bucket => seen.has(bucket)),
    bucketsMissing: USAGE_BUCKETS.filter(bucket => !seen.has(bucket)),
  }
}

/**
 * 从适配器 handle 读取 usage 调用记录。
 *
 * 约定（可选扩展，不破坏冻结接口）：
 *   - `handle.usageCalls` 是数组，或返回数组的函数；
 *   - 每条 `{ provider?, callId, usage, source? }`；
 *   - 适配器不提供或没有观测到 usage 时返回 `[]`（由调用方标 unknown）。
 *
 * @param {object|null} handle
 * @param {string} fallbackProvider
 * @returns {object[]} 已按 callId 去重的调用记录
 */
export function readAdapterUsageCalls(handle, fallbackProvider = 'unknown') {
  if (!handle || typeof handle !== 'object') return []
  let raw
  try {
    raw = typeof handle.usageCalls === 'function' ? handle.usageCalls() : handle.usageCalls
  } catch {
    return []
  }
  if (!Array.isArray(raw) || raw.length === 0) return []
  const deduped = new Map()
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const call = createUsageCall({
      provider: nonEmptyString(item.provider) ? item.provider : fallbackProvider,
      callId: item.callId,
      usage: item.usage,
      source: item.source,
      invocationId: item.invocationId,
      ...(item.inputIncludesCache === undefined ? {} : { inputIncludesCache: item.inputIncludesCache }),
    })
    if (!nonEmptyString(call.callId)) continue
    recordUsageCall(deduped, call)
  }
  return [...deduped.values()]
}

/**
 * 调用记录 → 可落盘的 `agent/usage` 事件（不含 at / elementId / activityId，
 * 由 runner 补齐）。
 *
 * @param {object} call
 * @returns {object}
 */
export function usageEventForCall(call) {
  return {
    type: AGENT_USAGE_EVENT,
    provider: call.provider,
    callId: call.callId,
    trust: call.trust,
    ...(call.usage === null ? {} : { usage: call.usage }),
    ...(call.reason === null ? {} : { reason: call.reason }),
    ...(call.observedBuckets.length === 0 ? {} : { observedBuckets: [...call.observedBuckets] }),
    ...(call.source === null ? {} : { source: call.source }),
    ...(call.invocationId === null ? {} : { invocationId: call.invocationId }),
  }
}

/**
 * 「这次调用没有 usage」的事实事件（不是 0，是 unknown）。
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
