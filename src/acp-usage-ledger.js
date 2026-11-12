/**
 * ACP prompt 用量账本（0.15.0 P2）。
 *
 * 本模块只解释 **codex-acp 2.6.0 的 prompt usage 语义**，输出与 provider 无关的事实：
 *
 *   - **不差分**：codex-acp 2.6.0 在每次 `session/prompt` 开始前记下
 *     `session.totalTokenUsage`，返回时用 `latest − startTotal` 得到**本轮**用量
 *     （`dist/index.js` 的 `beginPromptTokenUsage` 与 `PromptTokenUsage.usage()`）。
 *     因此适配器拿到的 `usage` 已经是本次 prompt 的量，本账本**直接记 invocation**；
 *     再对相邻 prompt 做差分就是二次扣减。`inputTokens` 也已由 agent 扣掉缓存
 *     （`toPromptUsage`），不能再套 Codex 的 inclusive-input 拆桶规则。
 *   - **只有已验证 profile 才解释数值**：仅
 *     `agentInfo.name='@agentclientprotocol/codex-acp' && agentInfo.version='2.6.0'`
 *     走 prompt profile。其它版本 / 身份一律 unknown：不猜累计、不猜 invocation、
 *     不做差分。
 *   - **未知不是零**：缺桶一律 `null`（明确上报的 0 才进入观测掩码）；非法数值、
 *     `thought > output`、四桶完整却与 `totalTokens` 矛盾 → `usage-malformed`，
 *     整轮降级为 unknown，绝不补 0。没有可靠 prompt usage 时只产出一条
 *     `synthetic` 的 unknown 调用记录。
 *   - **取消不抢先结算**：取消后仍可能有合法尾响应 usage。账本只在适配器判定
 *     「尾窗结束」后由 `sealUnknown()` 落 unknown；`end()` 与 `sealUnknown()` 对同一
 *     invocation 首次终结有效，之后重复调用只记诊断。
 *
 * 适配器接入方式（P4）：
 *   `const ledger = createAcpUsageLedger({ executionId, sessionId, agentInfo })`；
 *   实际派发 prompt 前 `begin(invocationId)`，prompt 响应到达时 `end(invocationId, response)`，
 *   尾窗截止仍未拿到响应时 `sealUnknown(invocationId, reason)`；handle 暴露
 *   `usageCalls()` 与 `usageSnapshots()`。usage 不回填 handle.usage / outcome.usage。
 *
 * @module @feiyueve/dsh-flow-studio/acp-usage-ledger
 */

import { createHash, randomBytes } from 'node:crypto'

import {
  CANONICAL_USAGE_VERSION,
  USAGE_BUCKETS,
  USAGE_REASON,
  USAGE_SCOPE,
  createUsageSnapshot,
} from './agent-telemetry.js'

const PROVIDER = 'acp'
/** 唯一启用 prompt profile 的 agent 身份（精确匹配，不做前缀/大小写猜测）。 */
const PROFILE_NAME = '@agentclientprotocol/codex-acp'
const PROFILE_VERSION = '2.6.0'
const PROVENANCE_CONTRACT = 'acp-codex-2.6.0-prompt-v1'
const AGENT_SCOPE = 'main'
const MAX_DIAGNOSTICS = 50
const MAX_ID_LENGTH = 256
const SCOPE = USAGE_SCOPE.INVOCATION
/** 允许透传给 `agent-telemetry` 的 unknown 原因（不扩枚举）。 */
const UNKNOWN_REASONS = new Set([USAGE_REASON.UNAVAILABLE, USAGE_REASON.MALFORMED])

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function boundedString(value) {
  if (typeof value !== 'string' || value === '') return null
  return value.length > MAX_ID_LENGTH ? value.slice(0, MAX_ID_LENGTH) : value
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** §P2 的稳定身份配方：`sha256(executionId + '\0' + invocationId)`。 */
function scopedId(prefix, executionId, invocationId) {
  return `${prefix}:${sha256Hex(`${executionId}\u0000${invocationId}`)}`
}

/**
 * 读一个 prompt usage 字段。
 *
 * @returns {{observed:boolean, value:number|null}|null} `null` 表示字段存在但不是
 *   非负 safe integer（整轮 malformed）；未出现 / 显式 null 视为缺桶。
 */
function readCount(source, key) {
  const value = source[key]
  if (value === undefined || value === null) return { observed: false, value: null }
  if (!Number.isSafeInteger(value) || value < 0) return null
  return { observed: true, value }
}

/**
 * 解析 codex-acp 的 prompt usage（已扣缓存、已按本轮差分）。
 *
 * 四桶映射：`inputTokens/cachedReadTokens/cachedWriteTokens/outputTokens →
 * input/cacheRead/cacheWrite/output`；`thoughtTokens` 只是 output 的子集，绝不另加。
 *
 * @returns {{usage:object, observedBuckets:string[]}|null} 不可信形状返回 `null`。
 */
function parsePromptUsage(raw) {
  if (!isPlainObject(raw)) return null
  const input = readCount(raw, 'inputTokens')
  const cacheRead = readCount(raw, 'cachedReadTokens')
  const cacheWrite = readCount(raw, 'cachedWriteTokens')
  const output = readCount(raw, 'outputTokens')
  const total = readCount(raw, 'totalTokens')
  const thought = readCount(raw, 'thoughtTokens')
  if (input === null || cacheRead === null || cacheWrite === null || output === null
    || total === null || thought === null) {
    return null
  }
  const cells = { input, cacheRead, cacheWrite, output }
  const observedBuckets = USAGE_BUCKETS.filter(bucket => cells[bucket].observed)
  // 只有 total 没有桶：不可认的数值形状，不猜桶。
  if (observedBuckets.length === 0) return null
  const usage = {
    input: input.value,
    cacheRead: cacheRead.value,
    cacheWrite: cacheWrite.value,
    output: output.value,
    total: null,
    canonical: CANONICAL_USAGE_VERSION,
  }
  if (observedBuckets.length === USAGE_BUCKETS.length) {
    const sum = USAGE_BUCKETS.reduce((acc, bucket) => acc + cells[bucket].value, 0)
    if (!Number.isSafeInteger(sum)) return null
    // 四桶完整却与 agent 上报的 total 矛盾 → 整轮不可信（不是取 max、不是修正）。
    if (total.observed && total.value !== sum) return null
    usage.total = sum
  }
  // thought 是 output 的子集：超过 output 或没有 output 可证明时不记录。
  if (thought.observed && output.observed) {
    if (thought.value > output.value) return null
    usage.reasoning = thought.value
  }
  return { usage, observedBuckets }
}

function publicSnapshot(snapshot) {
  return {
    provider: snapshot.provider,
    snapshotId: snapshot.snapshotId,
    scope: snapshot.scope,
    usage: isPlainObject(snapshot.usage) ? { ...snapshot.usage } : null,
    observedBuckets: [...snapshot.observedBuckets],
    ...(snapshot.invocationId === null ? {} : { invocationId: snapshot.invocationId }),
    ...(snapshot.sessionScopeId === null ? {} : { sessionScopeId: snapshot.sessionScopeId }),
    ...(snapshot.agentScope === null ? {} : { agentScope: snapshot.agentScope }),
    provenance: { ...snapshot.provenance },
  }
}

function publicCall(record) {
  return {
    provider: record.provider,
    callId: record.callId,
    usage: null,
    observedBuckets: [],
    synthetic: true,
    source: record.source,
    invocationId: record.invocationId,
    sessionScopeId: record.sessionScopeId,
    agentScope: record.agentScope,
    reason: record.reason,
  }
}

/**
 * 创建一个 ACP 用量账本。
 *
 * @param {{executionId?: string, sessionId?: string, agentInfo?: object|null}} [options]
 * @returns {{
 *   begin: (invocationId: string) => object|null,
 *   end: (invocationId: string, response?: object) => object|null,
 *   sealUnknown: (invocationId: string, reason?: string) => object|null,
 *   usageCalls: () => object[],
 *   usageSnapshots: () => object[],
 *   diagnostics: () => Array<{code: string}>,
 * }}
 */
export function createAcpUsageLedger(options = {}) {
  const configuredExecutionId = boundedString(options.executionId)
  // 缺 executionId 时用账本 nonce：身份仍唯一，但不假装跨执行可复现。
  const executionId = configuredExecutionId
    ?? `execution:${randomBytes(8).toString('hex')}`
  const sessionId = boundedString(options.sessionId)
  const agentInfo = isPlainObject(options.agentInfo) ? options.agentInfo : null
  const profileVerified = agentInfo !== null
    && agentInfo.name === PROFILE_NAME
    && agentInfo.version === PROFILE_VERSION

  /** invocationId → {invocationId, settled, outcome}。 */
  const invocations = new Map()
  /** callId → unknown 调用记录（同 invocation 只一条）。 */
  const calls = new Map()
  /** snapshotId → invocation 结算快照。 */
  const snapshots = new Map()
  const diagnostics = []
  const diagnosticCounts = new Map()

  function diagnose(code) {
    const count = (diagnosticCounts.get(code) ?? 0) + 1
    diagnosticCounts.set(code, count)
    // 诊断有界；计量账本本身（calls / snapshots）不裁剪。
    if (diagnostics.length >= MAX_DIAGNOSTICS) return
    diagnostics.push({ code })
  }

  if (configuredExecutionId === null) diagnose('execution-id-missing')

  /** 首次终结写入；同一 invocation 之后的状态变化只记诊断。 */
  function settleUnknown(record, reason) {
    const resolved = UNKNOWN_REASONS.has(reason) ? reason : USAGE_REASON.UNAVAILABLE
    const callId = scopedId('acp-unknown', executionId, record.invocationId)
    const call = {
      provider: PROVIDER,
      callId,
      usage: null,
      observedBuckets: [],
      synthetic: true,
      source: 'acp-prompt',
      invocationId: record.invocationId,
      sessionScopeId: sessionId,
      agentScope: AGENT_SCOPE,
      reason: resolved,
    }
    calls.set(callId, call)
    record.settled = true
    record.outcome = 'unknown'
    return call
  }

  function settleSnapshot(record, parsed) {
    const snapshotId = scopedId('acp-prompt', executionId, record.invocationId)
    const snapshot = createUsageSnapshot({
      provider: PROVIDER,
      snapshotId,
      scope: SCOPE,
      usage: parsed.usage,
      observedBuckets: parsed.observedBuckets,
      invocationId: record.invocationId,
      sessionScopeId: sessionId,
      agentScope: AGENT_SCOPE,
      provenance: { contract: PROVENANCE_CONTRACT, realCliVerified: false },
    })
    if (snapshot === null) {
      // 防御：形状已在本模块校验过；走到这里说明契约漂移，按 malformed 记 unknown。
      diagnose('snapshot-rejected')
      return settleUnknown(record, USAGE_REASON.MALFORMED)
    }
    snapshots.set(snapshotId, snapshot)
    record.settled = true
    record.outcome = 'snapshot'
    return snapshot
  }

  function begin(invocationId) {
    const id = boundedString(invocationId)
    if (id === null) {
      diagnose('invocation-id-invalid')
      return null
    }
    if (invocations.has(id)) {
      diagnose('invocation-duplicate-begin')
      return null
    }
    const record = { invocationId: id, settled: false, outcome: null }
    invocations.set(id, record)
    return { invocationId: id }
  }

  function end(invocationId, response) {
    const id = boundedString(invocationId)
    if (id === null) {
      diagnose('invocation-id-invalid')
      return null
    }
    let record = invocations.get(id)
    if (record === undefined) {
      diagnose('end-without-begin')
      record = { invocationId: id, settled: false, outcome: null }
      invocations.set(id, record)
    }
    if (record.settled) {
      diagnose('end-after-settlement')
      return null
    }
    const rawUsage = isPlainObject(response) && isPlainObject(response.usage)
      ? response.usage
      : null
    // 未验证 profile：有数值也不解释，不猜累计、不猜 invocation。
    if (!profileVerified) {
      diagnose('profile-unverified')
      return settleUnknown(record, USAGE_REASON.UNAVAILABLE)
    }
    if (rawUsage === null) {
      diagnose('prompt-usage-missing')
      return settleUnknown(record, USAGE_REASON.UNAVAILABLE)
    }
    const parsed = parsePromptUsage(rawUsage)
    if (parsed === null) {
      diagnose('prompt-usage-malformed')
      return settleUnknown(record, USAGE_REASON.MALFORMED)
    }
    return settleSnapshot(record, parsed)
  }

  /**
   * 尾窗截止仍没有可结算的 prompt usage 时落 unknown。取消/超时由适配器在
   * **收完尾响应之后**调用；账本自己不会因为 `stopReason:'cancelled'` 抢先结算。
   */
  function sealUnknown(invocationId, reason) {
    const id = boundedString(invocationId)
    if (id === null) {
      diagnose('invocation-id-invalid')
      return null
    }
    const record = invocations.get(id)
    if (record === undefined) {
      diagnose('seal-without-begin')
      return null
    }
    if (record.settled) {
      diagnose('seal-after-settlement')
      return null
    }
    const provided = typeof reason === 'string' && reason !== '' ? reason : null
    if (provided !== null && !UNKNOWN_REASONS.has(provided)) diagnose('unknown-reason-invalid')
    return settleUnknown(record, provided ?? USAGE_REASON.UNAVAILABLE)
  }

  return {
    begin,
    end,
    sealUnknown,
    usageCalls() {
      return [...calls.values()].map(publicCall)
    },
    usageSnapshots() {
      return [...snapshots.values()].map(publicSnapshot)
    },
    diagnostics() {
      return diagnostics.map(item => ({ ...item }))
    },
  }
}
