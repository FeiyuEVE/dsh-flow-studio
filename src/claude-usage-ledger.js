/**
 * Claude stream-json 用量账本（0.14.5 M1 / M2 / m2）。
 *
 * 本模块是 **Claude 协议语义**的唯一解释处，输出与 provider 无关的事实：
 *
 *   - **调用身份**：一个 assistant 事件是一个模型响应，但同一 `message.id` 的多个
 *     stream 事件（并行工具块）是**同一个响应**。callId 用
 *     `claude-message-v1:<sha256(sessionKey | agentScope | messageId)>` 做稳定身份；
 *     同身份重复上报是「已上报桶的替换」，不是相加。session 身份可能晚于第一个
 *     assistant 事件到达（init 乱序）：第一次确定时把此前记录的调用**重键并合并**，
 *     同一 `message.id` 不会因此变成两次调用。
 *   - **结算快照**：`result` 事件的 usage 是**范围级结算**，不是第 N 次调用。它单独
 *     产出 `agent/usage-snapshot`，按 scope 归约（invocation / session-cumulative /
 *     unknown）；resume 后范围不可证明时 scope=unknown，保留原始快照让指标层降级，
 *     不猜 sum / max。unknown 的 snapshotId 带执行 / 调用范围与账本 nonce，跨执行不会
 *     撞成同一个 key。
 *   - **不裁剪计量**：账本按唯一调用增长（Map），诊断单独限长；不会像诊断缓存那样
 *     裁到 200 条。
 *   - **未知不是零**：assistant 的 output 可能只是响应开始时的占位值，标记
 *     `provisional`；没有 usage 的调用 `usage:null`，绝不补 0。没有 `message.id`
 *     时不伪造确定的调用数（记录标 synthetic，指标层不计入 modelCalls）。
 *
 * 适配器接入方式（下一个单元）：
 *   `const ledger = createClaudeUsageLedger({ sessionScopeId, invocationId })`，
 *   parseStdout 里 `recordAssistant(event)` / `recordResult(event, { resumed })`，
 *   并给 handle 暴露 `usageCalls()` 与 `usageSnapshots()`。
 *
 * @module @feiyueve/dsh-flow-studio/claude-usage-ledger
 */

import { createHash, randomBytes } from 'node:crypto'

import {
  USAGE_BUCKETS, USAGE_SCOPE, USAGE_TRUST, normalizeObservedBuckets, normalizeProvider, normalizeUsage,
} from './agent-telemetry.js'

const DEFAULT_PROVIDER = 'claude'
const MAX_DIAGNOSTICS = 50
const MAX_ID_LENGTH = 256
const UNSCOPED_SESSION = 'session:unknown'
const PROVENANCE_CONTRACT = 'claude-result-usage-v1'
const SCOPE_VALUES = new Set(Object.values(USAGE_SCOPE))

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function boundedString(value) {
  if (typeof value !== 'string' || value === '') return null
  return value.length > MAX_ID_LENGTH ? value.slice(0, MAX_ID_LENGTH) : value
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 合并后的 usage 重算 total：四桶齐全才是数字，否则 null（不补 0）。 */
function recomputeTotal(usage) {
  if (!isPlainObject(usage)) return null
  const complete = USAGE_BUCKETS.every(bucket => Number.isInteger(usage[bucket]))
  usage.total = complete ? USAGE_BUCKETS.reduce((acc, bucket) => acc + usage[bucket], 0) : null
  return usage
}

function copyUsage(usage) {
  if (!isPlainObject(usage)) return null
  return { ...usage }
}

/**
 * 创建一个 Claude 用量账本。
 *
 * @param {{provider?: string, invocationId?: string|null, sessionScopeId?: string|null,
 *   agentScope?: string|null}} [options]
 */
export function createClaudeUsageLedger(options = {}) {
  const provider = normalizeProvider(nonEmptyString(options.provider) ? options.provider : DEFAULT_PROVIDER)
  const defaultInvocationId = boundedString(options.invocationId)
  const defaultAgentScope = boundedString(options.agentScope)
  const configuredSessionScopeId = boundedString(options.sessionScopeId)
  /** 账本唯一 nonce：unknown 快照没有稳定外部范围时用它区分不同执行。 */
  const ledgerNonce = randomBytes(8).toString('hex')

  /** callId → 调用记录（Map 不裁剪；计量账本不能用诊断缓存上限）。 */
  const calls = new Map()
  /** snapshotId → 结算快照（同 id 替换 = 取最新）。 */
  const snapshots = new Map()
  const diagnostics = []
  const diagnosticCounts = new Map()
  let boundSessionKey = configuredSessionScopeId
  let unidentifiedSeq = 0
  let unknownSnapshotSeq = 0
  let dedupedObservations = 0
  let conflicts = 0

  /** 有界、脱敏诊断：只留稳定 code 与计数，不留 usage 正文 / 凭据 / 路径。 */
  function diagnose(code) {
    const count = (diagnosticCounts.get(code) ?? 0) + 1
    diagnosticCounts.set(code, count)
    if (diagnostics.length >= MAX_DIAGNOSTICS) return
    diagnostics.push({ code })
  }

  /**
   * session 身份第一次确定时，把此前按 `UNSCOPED_SESSION` 记下的调用**重键**到确定身份，
   * 同一 `message.id` 与后到记录合并成一条（M1 残余：不能因为 init 晚到就算两次）。
   */
  function rebindUnscopedCalls() {
    const sessionKey = boundSessionKey
    if (!nonEmptyString(sessionKey)) return
    const sessionScopeId = boundedString(sessionKey)
    for (const [oldKey, record] of [...calls.entries()]) {
      if (record.sessionKey !== UNSCOPED_SESSION) continue
      // 没有 message.id 的 synthetic 记录本来就是唯一 id 且不可去重，保持原样。
      if (record.synthetic === true || !nonEmptyString(record.messageId)) continue
      const newKey = resolveCallId(sessionKey, record.agentScope ?? 'main', record.messageId)
      if (newKey === oldKey) continue
      const target = calls.get(newKey)
      calls.delete(oldKey)
      record.callId = newKey
      record.sessionKey = sessionKey
      record.sessionScopeId = sessionScopeId
      if (target === undefined) {
        calls.set(newKey, record)
        continue
      }
      // target 是后到的同一次调用：保留后到值，旧记录只补 target 还没观测到的桶。
      if (record.usage !== null && (target.usage === null || target.trust !== USAGE_TRUST.KNOWN)) {
        target.usage = copyUsage(record.usage)
        target.observedBuckets = [...record.observedBuckets]
        target.trust = record.trust
        target.reason = record.reason
      } else if (record.usage !== null && target.usage !== null) {
        for (const bucket of record.observedBuckets) {
          if (target.observedBuckets.includes(bucket)) continue
          if (!Number.isInteger(record.usage[bucket])) continue
          target.usage[bucket] = record.usage[bucket]
          target.observedBuckets = USAGE_BUCKETS.filter(
            name => target.observedBuckets.includes(name) || name === bucket,
          )
        }
        recomputeTotal(target.usage)
      }
      if (record.provisional === true) target.provisional = true
      calls.set(newKey, target)
    }
  }

  function resolveSessionKey(event) {
    const observed = nonEmptyString(event?.session_id)
      ? event.session_id
      : (nonEmptyString(event?.sessionId) ? event.sessionId : null)
    if (boundSessionKey === null && observed !== null) {
      boundSessionKey = boundedString(observed)
      rebindUnscopedCalls()
    }
    if (boundSessionKey !== null && observed !== null && observed !== boundSessionKey) {
      // 晚到 / 冲突的 session 事件不能让已记录的调用换键，只留诊断。
      diagnose('session-mismatch')
    }
    return boundSessionKey ?? UNSCOPED_SESSION
  }

  function resolveAgentScope(event, message) {
    const scope = nonEmptyString(event?.parent_tool_use_id)
      ? event.parent_tool_use_id
      : (nonEmptyString(message?.parent_tool_use_id) ? message.parent_tool_use_id : defaultAgentScope)
    return boundedString(scope) ?? 'main'
  }

  function resolveCallId(sessionKey, agentScope, messageId) {
    return `claude-message-v1:${sha256Hex(`${sessionKey}\u0000${agentScope}\u0000${messageId}`)}`
  }

  function publicCall(record) {
    return {
      callId: record.callId,
      usage: copyUsage(record.usage),
      observedBuckets: [...record.observedBuckets],
      synthetic: record.synthetic,
      provisional: record.provisional,
      trust: record.trust,
      source: 'assistant',
      ...(record.invocationId === null ? {} : { invocationId: record.invocationId }),
      ...(record.sessionScopeId === null ? {} : { sessionScopeId: record.sessionScopeId }),
      ...(record.agentScope === null ? {} : { agentScope: record.agentScope }),
    }
  }

  function publicSnapshot(snapshot) {
    return {
      provider: snapshot.provider,
      snapshotId: snapshot.snapshotId,
      scope: snapshot.scope,
      usage: copyUsage(snapshot.usage),
      observedBuckets: [...snapshot.observedBuckets],
      ...(snapshot.invocationId === null ? {} : { invocationId: snapshot.invocationId }),
      ...(snapshot.sessionScopeId === null ? {} : { sessionScopeId: snapshot.sessionScopeId }),
      ...(snapshot.agentScope === null ? {} : { agentScope: snapshot.agentScope }),
      provenance: { ...snapshot.provenance },
    }
  }

  /**
   * 处理一个 assistant 事件。同一 session + agentScope + message.id 的重复/更新
   * 按**同一调用**处理：只替换新上报的桶，未上报的桶保留旧值。
   */
  function recordAssistant(event) {
    const message = isPlainObject(event?.message) ? event.message : (isPlainObject(event) ? event : null)
    if (message === null) {
      diagnose('assistant-malformed')
      return null
    }
    const sessionKey = resolveSessionKey(event)
    const agentScope = resolveAgentScope(event, message)
    const messageId = nonEmptyString(message.id) ? message.id : null
    // 没有 message.id：无法去重，也不伪造确定的调用数；记录标 synthetic，
    // 指标层不计入 modelCalls，但保留观测到的用量。
    let callId
    if (messageId === null) {
      unidentifiedSeq += 1
      callId = `claude-message-v1:unidentified:${unidentifiedSeq}`
      diagnose('missing-message-id')
    } else {
      callId = resolveCallId(sessionKey, agentScope, messageId)
    }
    const rawUsage = isPlainObject(message.usage)
      ? message.usage
      : (isPlainObject(event?.usage) ? event.usage : null)
    const normalized = normalizeUsage(rawUsage, { provider })
    const observed = normalizeObservedBuckets(undefined, normalized.usage)
    const existing = calls.get(callId)
    if (existing === undefined) {
      const record = {
        callId,
        messageId,
        sessionKey,
        agentScope,
        synthetic: messageId === null,
        provisional: normalized.usage !== null,
        trust: normalized.trust,
        usage: copyUsage(normalized.usage),
        observedBuckets: observed,
        reason: normalized.reason,
        invocationId: defaultInvocationId,
        sessionScopeId: boundedString(sessionKey) === UNSCOPED_SESSION ? null : sessionKey,
      }
      calls.set(callId, record)
      return publicCall(record)
    }
    // 同一调用的再次上报：并集/更新，绝不累加。
    dedupedObservations += 1
    if (normalized.usage !== null) {
      if (existing.usage === null || existing.trust !== USAGE_TRUST.KNOWN) {
        existing.usage = copyUsage(normalized.usage)
        existing.observedBuckets = [...observed]
        existing.trust = USAGE_TRUST.KNOWN
        existing.reason = null
      } else {
        for (const bucket of observed) existing.usage[bucket] = normalized.usage[bucket]
        if (USAGE_BUCKETS.some(bucket => observed.includes(bucket) && !existing.observedBuckets.includes(bucket))) {
          existing.observedBuckets = USAGE_BUCKETS.filter(
            bucket => existing.observedBuckets.includes(bucket) || observed.includes(bucket),
          )
        }
        if (isPlainObject(normalized.usage) && Number.isInteger(normalized.usage.reasoning)) {
          existing.usage.reasoning = normalized.usage.reasoning
        }
        recomputeTotal(existing.usage)
      }
    }
    existing.provisional = true
    return publicCall(existing)
  }

  /** result 的统计范围：显式 scope 优先；resume 后范围不可证明 → unknown。 */
  function resolveScope(meta, invocationId, sessionKey) {
    if (SCOPE_VALUES.has(meta.scope)) return meta.scope
    if (meta.resumed === true) return USAGE_SCOPE.UNKNOWN
    if (nonEmptyString(invocationId)) return USAGE_SCOPE.INVOCATION
    if (nonEmptyString(sessionKey) && sessionKey !== UNSCOPED_SESSION) return USAGE_SCOPE.SESSION_CUMULATIVE
    return USAGE_SCOPE.UNKNOWN
  }

  /**
   * 处理一个 result 事件里的 usage（结算快照）。不增加模型调用数。
   *
   * @param {object} event
   * @param {{invocationId?: string, sessionScopeId?: string, agentScope?: string,
   *   resumed?: boolean, scope?: string}} [meta]
   */
  function recordResult(event, meta = {}) {
    const result = isPlainObject(event) ? event : {}
    const rawUsage = isPlainObject(result.usage)
      ? result.usage
      : (isPlainObject(result.result?.usage) ? result.result.usage : null)
    if (rawUsage === null) {
      diagnose('result-usage-missing')
      return null
    }
    if (nonEmptyString(result.subtype) && result.subtype !== 'success') diagnose('result-error-usage')
    const sessionKey = boundedString(meta.sessionScopeId)
      ?? resolveSessionKey(result)
    const agentScope = boundedString(meta.agentScope) ?? defaultAgentScope ?? 'main'
    const invocationId = boundedString(meta.invocationId) ?? defaultInvocationId
    let scope = resolveScope(isPlainObject(meta) ? meta : {}, invocationId, sessionKey)
    if (scope === USAGE_SCOPE.INVOCATION && invocationId === null) {
      diagnose('snapshot-invocation-missing-id')
      scope = USAGE_SCOPE.UNKNOWN
    }
    if (scope === USAGE_SCOPE.SESSION_CUMULATIVE && (!nonEmptyString(sessionKey) || sessionKey === UNSCOPED_SESSION)) {
      diagnose('snapshot-session-missing-id')
      scope = USAGE_SCOPE.UNKNOWN
    }
    const normalized = normalizeUsage(rawUsage, { provider })
    if (normalized.trust !== USAGE_TRUST.KNOWN || normalized.usage === null) {
      diagnose('result-usage-malformed')
      return null
    }
    const usage = copyUsage(normalized.usage)
    const observedBuckets = normalizeObservedBuckets(undefined, usage)
    let snapshotId
    if (scope === USAGE_SCOPE.INVOCATION) {
      snapshotId = `claude-result-v1:inv:${sha256Hex(`${sessionKey}\u0000${agentScope}\u0000${invocationId}`)}`
    } else if (scope === USAGE_SCOPE.SESSION_CUMULATIVE) {
      snapshotId = `claude-result-v1:cum:${sha256Hex(`${sessionKey}\u0000${agentScope}`)}`
    } else {
      unknownSnapshotSeq += 1
      // F3：scope=unknown 的 snapshotId 必须带执行 / 调用作用域（缺范围时用账本 nonce），
      // 否则每个账本都从 unknown:1 开始，跨执行会把不同快照覆盖成一份。
      const scopeSeed = nonEmptyString(invocationId)
        ? invocationId
        : (nonEmptyString(sessionKey) && sessionKey !== UNSCOPED_SESSION
          ? sessionKey
          : (defaultInvocationId ?? ledgerNonce))
      snapshotId = `claude-result-v1:unknown:${sha256Hex(`${scopeSeed}\u0000${agentScope}\u0000${ledgerNonce}`).slice(0, 24)}:${unknownSnapshotSeq}`
    }
    const previous = snapshots.get(snapshotId)
    if (previous !== undefined && isPlainObject(previous.usage)) {
      const changed = USAGE_BUCKETS.some(bucket => previous.usage[bucket] !== usage[bucket])
      if (changed) {
        conflicts += 1
        diagnose('snapshot-replaced')
      }
    }
    const snapshot = {
      provider,
      snapshotId,
      scope,
      invocationId: scope === USAGE_SCOPE.SESSION_CUMULATIVE ? null : (invocationId ?? null),
      sessionScopeId: !nonEmptyString(sessionKey) || sessionKey === UNSCOPED_SESSION ? null : sessionKey,
      agentScope,
      usage,
      observedBuckets,
      provenance: { contract: PROVENANCE_CONTRACT, realCliVerified: false },
    }
    snapshots.set(snapshotId, snapshot)
    return publicSnapshot(snapshot)
  }

  return {
    recordAssistant,
    recordResult,
    usageCalls() {
      return [...calls.values()].map(publicCall)
    },
    snapshots() {
      return [...snapshots.values()].map(publicSnapshot)
    },
    diagnostics() {
      return diagnostics.map(item => ({ ...item }))
    },
    stats() {
      return {
        calls: calls.size,
        snapshots: snapshots.size,
        diagnostics: diagnostics.length,
        diagnosticCounts: Object.fromEntries([...diagnosticCounts.entries()]),
        dedupedObservations,
        unidentifiedCalls: unidentifiedSeq,
        conflicts,
        sessions: new Set([...calls.values()].map(record => record.sessionKey)).size,
        agents: new Set([...calls.values()].map(record => record.agentScope)).size,
      }
    },
  }
}
