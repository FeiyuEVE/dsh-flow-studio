/**
 * 实例域业务证据（0.13.12 E2）：**纯函数**把「已完成节点登记的证据报告」解析成
 * 可复核的 claims / findings，不读文件、不碰 runner、不调用 `_ensureRunner()`。
 *
 * 语义唯一来源：`docs/design/13-instance-evidence.md`。本模块只做四件事：
 *
 *   1. 找到 `flow_finish_node.documents[]` 里 `kind:"evidence-report"` 的报告文件；
 *   2. 按报告声明的 `refs[]` 核对引用（优先 `artifacts/<sha256>` 快照，其次工作区）；
 *   3. 把「引用已核对」与「结论成立」分开表达；
 *   4. 暴露缺失、冲突与来源 execution，**不产出任何总评级**。
 *
 * 硬口径（逐条对应计划 §E2）：
 *
 *   - `fixed` ≠ `verified`：没有复验引用、或引用未通过 hash 核对，不得显示为 verified；
 *   - 文件 hash 一致只证明内容一致，不证明结论正确：`verify` 只描述引用，报告结论
 *     永远是 `source:"report-claim"`；
 *   - 来源与可信级别由宿主登记决定：报告自称 `producer:"host"` 只被记录为
 *     「被忽略的自报」，不会获得宿主身份；
 *   - 缺报告是 `missing` / unknown，不是空 claims 的「全部通过」；
 *   - 不同循环（不同 execution）各留来源，不套用「打回使前次通过失效」；
 *   - 引用优先命中 artifact 快照；快照缺失才回落到工作区，并在 dataQuality 标原因。
 *
 * @module @feiyueve/dsh-flow-studio/instance-evidence
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

/** 证据报告 schema；报告正文里必须写这个值。 */
export const EVIDENCE_SCHEMA = 'flow-evidence/v1'
/** `flow_finish_node.documents[].kind` 里登记证据报告用的 kind。 */
export const EVIDENCE_REPORT_KIND = 'evidence-report'

/** `dataQuality.reasons` / `missing[].reason` 的稳定字符串。 */
export const EVIDENCE_REASON = Object.freeze({
  NO_REPORT: 'no-evidence-report',
  REPORT_UNREADABLE: 'report-unreadable',
  REPORT_SCHEMA_MISMATCH: 'report-schema-mismatch',
  REPORT_INVALID: 'report-invalid',
  REPORT_STUB: 'report-stub',
  PRODUCER_SELF_CLAIM_IGNORED: 'producer-self-claim-ignored',
  REPORT_EXECUTION_MISMATCH: 'report-execution-mismatch',
  SNAPSHOT_MISSING: 'artifact-snapshot-missing',
  WORKSPACE_FALLBACK: 'workspace-fallback',
  WORKSPACE_UNAVAILABLE: 'workspace-unavailable',
  WORKSPACE_UNREADABLE: 'workspace-unreadable',
  REF_PATH_INVALID: 'ref-path-invalid',
  REF_SHA_INVALID: 'ref-sha-invalid',
  REF_HASH_MISMATCH: 'ref-hash-mismatch',
  REF_MISSING: 'ref-missing',
  FIXED_WITHOUT_REFS: 'fixed-without-verification-refs',
  FIXED_REFS_UNVERIFIED: 'fixed-refs-unverified',
  SELF_VERIFIED_CLAIM: 'finding-self-verified-claim',
  CLAIM_INVALID: 'claim-invalid',
  FINDING_INVALID: 'finding-invalid',
  CLAIM_VALUE_CONFLICT: 'claim-value-conflict',
  FINDING_STATUS_CONFLICT: 'finding-status-conflict',
  CROSS_EXECUTION_CLAIM_DIVERGENCE: 'cross-execution-claim-divergence',
  CROSS_EXECUTION_FINDING_DIVERGENCE: 'cross-execution-finding-divergence',
  DUPLICATE_CLAIM_ID: 'duplicate-claim-id',
  DUPLICATE_FINDING_ID: 'duplicate-finding-id',
  CLAIM_WITHOUT_REFS: 'claim-without-refs',
  REPORT_EMPTY: 'report-empty',
  EVENTS_SKIPPED: 'events-skipped',
  TRUNCATED: 'evidence-truncated',
})

const MAX_REPORTS = 32
const MAX_CLAIMS = 200
const MAX_FINDINGS = 200
const MAX_REFS = 32
const MAX_ID_CHARS = 128
const MAX_TYPE_CHARS = 64
const MAX_STATUS_CHARS = 64
const MAX_VALUE_CHARS = 2000
const HASH_PATTERN = /^[0-9a-f]{64}$/
const REPORT_KIND = EVIDENCE_REPORT_KIND.toLowerCase()

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** 归一 hash；非法返回 null（不 throw，坏报告不能让整个查询失败）。 */
export function normalizeEvidenceHash(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  return HASH_PATTERN.test(text) ? text : null
}

/**
 * 工作区相对路径校验：与 `flow_finish_node.documents[].path` 同口径。
 * 绝对路径、反斜杠、空段、`.` / `..` 段、超长一律拒绝。
 */
export function isSafeEvidencePath(value) {
  if (typeof value !== 'string' || value === '' || value.length > 1024) return false
  if (value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false
  }
  return true
}

function contentBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (isPlainObject(value)) {
    for (const key of ['bytes', 'content', 'text']) {
      const nested = value[key]
      if (nested !== undefined && nested !== null) return contentBytes(nested)
    }
  }
  return null
}

function contentText(value) {
  const bytes = contentBytes(value)
  return bytes === null ? null : bytes.toString('utf8')
}

/** 计算内容 sha256；拿不到内容返回 null。 */
export function evidenceSha256(value) {
  const bytes = contentBytes(value)
  if (bytes === null) return null
  return createHash('sha256').update(bytes).digest('hex')
}

function lookup(container, key) {
  if (container instanceof Map) {
    return container.has(key) ? { found: true, value: container.get(key) } : { found: false, value: undefined }
  }
  if (isPlainObject(container) && Object.hasOwn(container, key)) {
    return { found: true, value: container[key] }
  }
  return { found: false, value: undefined }
}

function idOf(value, limit) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || text.length > limit) return null
  return text
}

function scalarValue(value) {
  if (value === null || typeof value === 'boolean') return { ok: true, value }
  if (typeof value === 'number') return Number.isFinite(value) ? { ok: true, value } : { ok: false }
  if (typeof value === 'string') {
    if (value.length > MAX_VALUE_CHARS) return { ok: false }
    return { ok: true, value }
  }
  return { ok: false }
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function createReduction() {
  return {
    reasons: new Set(),
    stub: false,
    producerSelfClaims: [],
    snapshotMissing: 0,
    workspaceFallbacks: 0,
    truncated: false,
  }
}

/** 解析报告里的一条引用；结果只描述「引用是否核对」，不描述结论。 */
function resolveRef(raw, context) {
  const { reduction, snapshots, workspaceFiles, workspaceAvailable } = context
  const ref = isPlainObject(raw) ? raw : null
  if (ref === null) {
    return { ok: false, missing: { kind: 'ref', reason: EVIDENCE_REASON.REF_MISSING, message: '引用必须是对象' } }
  }
  const path = typeof ref.path === 'string' ? ref.path : ''
  if (!isSafeEvidencePath(path)) {
    reduction.reasons.add(EVIDENCE_REASON.REF_PATH_INVALID)
    return {
      ok: false,
      missing: {
        kind: 'ref',
        path: path === '' ? null : path,
        reason: EVIDENCE_REASON.REF_PATH_INVALID,
        message: '引用 path 必须是工作区内相对路径（禁止绝对路径、..、反斜杠、空段）',
      },
    }
  }
  const declaredSha = normalizeEvidenceHash(ref.sha256)
  if (declaredSha === null) {
    reduction.reasons.add(EVIDENCE_REASON.REF_SHA_INVALID)
    return {
      ok: false,
      missing: {
        kind: 'ref',
        path,
        sha256: typeof ref.sha256 === 'string' ? ref.sha256.slice(0, 128) : null,
        reason: EVIDENCE_REASON.REF_SHA_INVALID,
        message: '引用 sha256 必须是 64 位小写十六进制',
      },
    }
  }

  const snapshot = lookup(snapshots, declaredSha)
  if (snapshot.found) {
    const actual = evidenceSha256(snapshot.value)
    if (actual === declaredSha) {
      return {
        ok: true,
        ref: { path, sha256: declaredSha, resolvedFrom: 'artifact-snapshot' },
      }
    }
    reduction.reasons.add(EVIDENCE_REASON.REF_HASH_MISMATCH)
    return {
      ok: false,
      conflict: {
        kind: EVIDENCE_REASON.REF_HASH_MISMATCH,
        path,
        sha256: declaredSha,
        actualSha256: actual,
        resolvedFrom: 'artifact-snapshot',
        message: `引用 ${path} 的快照内容 hash 与声明的 sha256 不一致`,
      },
      ref: { path, sha256: declaredSha, resolvedFrom: 'artifact-snapshot', verified: false },
    }
  }

  reduction.snapshotMissing += 1
  reduction.reasons.add(EVIDENCE_REASON.SNAPSHOT_MISSING)
  if (!workspaceAvailable) {
    reduction.reasons.add(EVIDENCE_REASON.WORKSPACE_UNAVAILABLE)
    return {
      ok: false,
      missing: {
        kind: 'ref',
        path,
        sha256: declaredSha,
        reason: EVIDENCE_REASON.WORKSPACE_UNAVAILABLE,
        message: 'artifact 快照缺失，工作区也不可用，无法核对引用',
      },
    }
  }
  const workspace = lookup(workspaceFiles, path)
  if (!workspace.found) {
    reduction.reasons.add(EVIDENCE_REASON.WORKSPACE_UNREADABLE)
    return {
      ok: false,
      missing: {
        kind: 'ref',
        path,
        sha256: declaredSha,
        reason: EVIDENCE_REASON.WORKSPACE_UNREADABLE,
        message: 'artifact 快照缺失，工作区文件也读不到',
      },
    }
  }
  const actual = evidenceSha256(workspace.value)
  if (actual === declaredSha) {
    reduction.workspaceFallbacks += 1
    reduction.reasons.add(EVIDENCE_REASON.WORKSPACE_FALLBACK)
    return {
      ok: true,
      ref: { path, sha256: declaredSha, resolvedFrom: 'workspace' },
    }
  }
  reduction.reasons.add(EVIDENCE_REASON.REF_HASH_MISMATCH)
  return {
    ok: false,
    conflict: {
      kind: EVIDENCE_REASON.REF_HASH_MISMATCH,
      path,
      sha256: declaredSha,
      actualSha256: actual,
      resolvedFrom: 'workspace',
      message: `引用 ${path} 的工作区内容 hash 与声明的 sha256 不一致`,
    },
    ref: { path, sha256: declaredSha, resolvedFrom: 'workspace', verified: false },
  }
}

/** 读报告正文：快照优先，其次工作区；读不到给出可显示的 missing。 */
function readReportContent(doc, context) {
  const declaredSha = normalizeEvidenceHash(doc.sha256)
  if (declaredSha === null) {
    return {
      ok: false,
      missing: {
        kind: 'report',
        path: typeof doc.path === 'string' ? doc.path : null,
        sha256: null,
        reason: EVIDENCE_REASON.REPORT_UNREADABLE,
        message: '证据报告登记缺少合法 sha256',
      },
    }
  }
  const resolved = resolveRef({ path: doc.path, sha256: declaredSha }, context)
  if (!resolved.ok) {
    const source = resolved.missing ?? resolved.conflict ?? {}
    return {
      ok: false,
      missing: {
        kind: 'report',
        path: typeof doc.path === 'string' ? doc.path : null,
        sha256: declaredSha,
        reason: source.reason ?? source.kind ?? EVIDENCE_REASON.REPORT_UNREADABLE,
        message: source.message ?? '证据报告正文读不到',
      },
      ref: resolved.ref ?? null,
      conflict: resolved.conflict ?? null,
    }
  }
  const source = resolved.ref.resolvedFrom === 'artifact-snapshot'
    ? lookup(context.snapshots, declaredSha)
    : lookup(context.workspaceFiles, doc.path)
  const text = contentText(source.value)
  if (text === null) {
    return {
      ok: false,
      missing: {
        kind: 'report',
        path: doc.path,
        sha256: declaredSha,
        reason: EVIDENCE_REASON.REPORT_UNREADABLE,
        message: '证据报告正文不是可读文本',
      },
      ref: resolved.ref,
    }
  }
  return { ok: true, text, ref: resolved.ref }
}

function validateReportShape(raw) {
  if (!isPlainObject(raw)) return { error: '报告正文必须是 JSON 对象' }
  if (raw.schema !== EVIDENCE_SCHEMA) {
    return { error: `报告 schema 必须是 ${EVIDENCE_SCHEMA}（收到 ${JSON.stringify(raw.schema ?? null)}）` }
  }
  if (!Array.isArray(raw.claims)) return { error: '报告 claims 必须是数组' }
  if (!Array.isArray(raw.findings)) return { error: '报告 findings 必须是数组' }
  return { value: raw }
}

function eventArtifactIndex(events) {
  const index = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    if (!isPlainObject(event) || event.type !== 'activity/end') continue
    if (!Array.isArray(event.artifacts)) continue
    const executionId = nonEmptyString(event.activityId) ? event.activityId : null
    if (executionId === null) continue
    for (const artifact of event.artifacts) {
      if (!isPlainObject(artifact)) continue
      if (typeof artifact.path !== 'string' || artifact.path === '') continue
      const sha256 = normalizeEvidenceHash(artifact.sha256)
      if (sha256 === null) continue
      index.set(`${artifact.path}\0${sha256}`, {
        executionId,
        nodeId: nonEmptyString(event.elementId) ? event.elementId : null,
      })
    }
  }
  return index
}

function hostExecutionOf(doc, eventIndex) {
  if (nonEmptyString(doc.executionId)) {
    return { executionId: doc.executionId, nodeId: nonEmptyString(doc.nodeId) ? doc.nodeId : null }
  }
  const sha256 = normalizeEvidenceHash(doc.sha256)
  if (sha256 !== null && typeof doc.path === 'string') {
    const hit = eventIndex.get(`${doc.path}\0${sha256}`)
    if (hit !== undefined) return { executionId: hit.executionId, nodeId: hit.nodeId ?? (nonEmptyString(doc.nodeId) ? doc.nodeId : null) }
  }
  if (Array.isArray(doc.sources)) {
    for (const source of doc.sources) {
      if (isPlainObject(source) && nonEmptyString(source.executionId)) {
        return {
          executionId: source.executionId,
          nodeId: nonEmptyString(source.nodeId) ? source.nodeId : (nonEmptyString(doc.nodeId) ? doc.nodeId : null),
        }
      }
    }
  }
  return { executionId: null, nodeId: nonEmptyString(doc.nodeId) ? doc.nodeId : null }
}

function executionKey(doc, eventIndex) {
  const host = hostExecutionOf(doc, eventIndex)
  return host.executionId === null ? `unknown\0${doc.path}\0${doc.sha256}` : host.executionId
}

function addVerifiedRef(verifiedRefs, byKey, ref, meta) {
  const key = `${ref.path}\0${ref.sha256}`
  const existing = byKey.get(key)
  if (existing !== undefined) {
    if (!existing.claimIds.includes(meta.claimId) && meta.claimId !== undefined) existing.claimIds.push(meta.claimId)
    if (!existing.findingIds.includes(meta.findingId) && meta.findingId !== undefined) existing.findingIds.push(meta.findingId)
    if (!existing.reportPaths.includes(meta.reportPath) && meta.reportPath !== undefined) existing.reportPaths.push(meta.reportPath)
    if (ref.resolvedFrom === 'artifact-snapshot') existing.resolvedFrom = 'artifact-snapshot'
    return
  }
  const entry = {
    path: ref.path,
    sha256: ref.sha256,
    resolvedFrom: ref.resolvedFrom,
    contexts: meta.context === undefined ? [] : [meta.context],
    claimIds: meta.claimId === undefined ? [] : [meta.claimId],
    findingIds: meta.findingId === undefined ? [] : [meta.findingId],
    reportPaths: meta.reportPath === undefined ? [] : [meta.reportPath],
    executionIds: meta.executionId === undefined ? [] : [meta.executionId],
  }
  byKey.set(key, entry)
  verifiedRefs.push(entry)
}

function addReason(reduction, reason) {
  if (typeof reason === 'string' && reason !== '') reduction.reasons.add(reason)
}

function asOfIso(value, fallback) {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback
  }
  return fallback
}

/**
 * 把实例事实、事件、完成节点登记的 documents、artifact 快照索引与工作区回退内容
 * 解析成业务证据视图。**纯函数**：不做任何 IO，所有内容由调用方读好传进来。
 *
 * @param {object} input
 * @param {object} [input.instance] 实例事实（目前只用 id / status / createdAt）
 * @param {object[]} [input.events] 实例事件；只用于把 `activity/end.artifacts` 关联到 execution
 * @param {object[]} [input.documents] 完成节点登记的文档（`instance.artifacts[]` 形状）
 * @param {Map|object} [input.snapshots] sha256 → 内容（`artifacts/<sha256>` 快照索引）
 * @param {Map|object} [input.workspaceFiles] 工作区相对路径 → 内容（仅快照缺失时回退）
 * @param {boolean} [input.workspaceAvailable] 工作区当前是否可读（清理后为 false）
 * @param {string|Date} [input.asOf] 观测时间
 * @param {number} [input.skippedEvents] 读取事件时跳过的坏行数
 * @returns {{schema:string,instanceId:string|null,asOf:string,claims:object[],findings:object[],
 *   verifiedRefs:object[],missing:object[],conflicts:object[],sourceExecutions:object[],
 *   dataQuality:object}}
 */
export function collectInstanceEvidence(input = {}) {
  const source = isPlainObject(input) ? input : {}
  const nowFallback = new Date().toISOString()
  const asOf = asOfIso(source.asOf, nowFallback)
  const instance = isPlainObject(source.instance) ? source.instance : {}
  const events = Array.isArray(source.events) ? source.events : []
  const documents = Array.isArray(source.documents) ? source.documents : []
  const snapshots = source.snapshots ?? new Map()
  const workspaceFiles = source.workspaceFiles ?? new Map()
  const workspaceAvailable = source.workspaceAvailable === true
  const reduction = createReduction()
  const eventIndex = eventArtifactIndex(events)
  const claims = []
  const findings = []
  const missing = []
  const conflicts = []
  const verifiedRefs = []
  const verifiedByKey = new Map()
  const sourceExecutions = []
  const executionById = new Map()
  const claimById = new Map()
  const findingById = new Map()
  let parsedReportCount = 0
  const reportDocs = documents.filter(doc => (
    isPlainObject(doc)
    && typeof doc.kind === 'string'
    && doc.kind.trim().toLowerCase() === REPORT_KIND
  ))

  if (Number.isInteger(source.skippedEvents) && source.skippedEvents > 0) {
    addReason(reduction, EVIDENCE_REASON.EVENTS_SKIPPED)
  }

  if (reportDocs.length === 0) {
    addReason(reduction, EVIDENCE_REASON.NO_REPORT)
    missing.push({
      kind: 'report',
      reason: EVIDENCE_REASON.NO_REPORT,
      message: '实例没有登记 kind=evidence-report 的证据报告；质量结论未知，不是「全部通过」',
    })
  }

  const reportLimit = Math.min(reportDocs.length, MAX_REPORTS)
  if (reportDocs.length > MAX_REPORTS) {
    reduction.truncated = true
    addReason(reduction, EVIDENCE_REASON.TRUNCATED)
  }

  for (let reportIndex = 0; reportIndex < reportLimit; reportIndex += 1) {
    const doc = reportDocs[reportIndex]
    const docPath = typeof doc.path === 'string' ? doc.path : null
    const docSha = normalizeEvidenceHash(doc.sha256)
    const host = hostExecutionOf(doc, eventIndex)
    const executionId = host.executionId
    const reportPath = docPath
    const reportKey = executionKey(doc, eventIndex)

    const context = {
      reduction,
      snapshots,
      workspaceFiles,
      workspaceAvailable,
    }
    const content = readReportContent(doc, context)
    const reportVerified = content.ok === true
    if (content.conflict !== undefined && content.conflict !== null) conflicts.push(content.conflict)
    if (!content.ok) {
      missing.push(content.missing)
      addReason(reduction, content.missing.reason)
    }

    let sourceEntry = executionById.get(reportKey)
    if (sourceEntry === undefined) {
      sourceEntry = {
        executionId,
        nodeId: host.nodeId,
        reportPaths: [],
        reportSha256: [],
        reportHashVerified: reportVerified,
        source: 'host-registration',
      }
      executionById.set(reportKey, sourceEntry)
      sourceExecutions.push(sourceEntry)
    } else if (reportVerified) {
      sourceEntry.reportHashVerified = true
    }
    if (reportPath !== null) sourceEntry.reportPaths.push(reportPath)
    if (docSha !== null) sourceEntry.reportSha256.push(docSha)
    if (content.ref !== undefined && content.ref !== null && content.ok) {
      addVerifiedRef(verifiedRefs, verifiedByKey, content.ref, {
        context: 'report',
        reportPath: reportPath ?? undefined,
        executionId: executionId ?? undefined,
      })
    }

    if (!content.ok) continue

    let raw
    try {
      raw = JSON.parse(content.text)
    } catch {
      addReason(reduction, EVIDENCE_REASON.REPORT_UNREADABLE)
      missing.push({
        kind: 'report',
        path: reportPath,
        sha256: docSha,
        reason: EVIDENCE_REASON.REPORT_UNREADABLE,
        message: '证据报告不是合法 JSON',
      })
      continue
    }
    const shape = validateReportShape(raw)
    if (shape.error !== undefined) {
      addReason(reduction, EVIDENCE_REASON.REPORT_SCHEMA_MISMATCH)
      missing.push({
        kind: 'report',
        path: reportPath,
        sha256: docSha,
        reason: EVIDENCE_REASON.REPORT_SCHEMA_MISMATCH,
        message: shape.error,
      })
      continue
    }
    const report = shape.value
    parsedReportCount += 1
    if (report.claims.length === 0 && report.findings.length === 0) {
      addReason(reduction, EVIDENCE_REASON.REPORT_EMPTY)
      missing.push({
        kind: 'report',
        path: reportPath,
        sha256: docSha,
        reason: EVIDENCE_REASON.REPORT_EMPTY,
        message: '证据报告没有任何 claims / findings；不能据此认为全部通过',
      })
    }
    const declaredExecutionId = nonEmptyString(report.executionId) ? report.executionId : null
    if (declaredExecutionId !== null && executionId !== null && declaredExecutionId !== executionId) {
      addReason(reduction, EVIDENCE_REASON.REPORT_EXECUTION_MISMATCH)
      conflicts.push({
        kind: EVIDENCE_REASON.REPORT_EXECUTION_MISMATCH,
        executionId,
        declaredExecutionId,
        path: reportPath,
        sha256: docSha,
        message: '报告自称的 executionId 与宿主登记的执行不一致；以宿主登记为准',
      })
    }
    if (report.stub === true || report.synthetic === true) {
      reduction.stub = true
      addReason(reduction, EVIDENCE_REASON.REPORT_STUB)
    }
    for (const key of ['producer', 'authority', 'trust']) {
      if (nonEmptyString(report[key])) {
        reduction.producerSelfClaims.push({
          path: reportPath,
          field: key,
          value: report[key].slice(0, 200),
          reason: EVIDENCE_REASON.PRODUCER_SELF_CLAIM_IGNORED,
        })
        addReason(reduction, EVIDENCE_REASON.PRODUCER_SELF_CLAIM_IGNORED)
      }
    }

    const claimLimit = Math.min(report.claims.length, MAX_CLAIMS)
    if (report.claims.length > MAX_CLAIMS) {
      reduction.truncated = true
      addReason(reduction, EVIDENCE_REASON.TRUNCATED)
    }
    for (let claimIndex = 0; claimIndex < claimLimit; claimIndex += 1) {
      const rawClaim = report.claims[claimIndex]
      const claim = isPlainObject(rawClaim) ? rawClaim : null
      const id = claim === null ? null : idOf(claim.id, MAX_ID_CHARS)
      if (claim === null || id === null) {
        addReason(reduction, EVIDENCE_REASON.CLAIM_INVALID)
        conflicts.push({
          kind: EVIDENCE_REASON.CLAIM_INVALID,
          executionId,
          path: reportPath,
          index: claimIndex,
          message: 'claim 必须是对象且 id 是非空字符串（≤128 字符）',
        })
        continue
      }
      const type = claim.type === undefined || claim.type === null
        ? ''
        : idOf(claim.type, MAX_TYPE_CHARS)
      if (type === null) {
        addReason(reduction, EVIDENCE_REASON.CLAIM_INVALID)
        conflicts.push({
          kind: EVIDENCE_REASON.CLAIM_INVALID,
          id,
          executionId,
          path: reportPath,
          message: 'claim.type 必须是非空字符串（≤64 字符）',
        })
        continue
      }
      const value = scalarValue(claim.value)
      if (!value.ok) {
        addReason(reduction, EVIDENCE_REASON.CLAIM_INVALID)
        conflicts.push({
          kind: EVIDENCE_REASON.CLAIM_INVALID,
          id,
          executionId,
          path: reportPath,
          message: 'claim.value 只接受字符串 / 数字 / 布尔 / null（字符串 ≤2000 字符）',
        })
        continue
      }
      if (claim.refs !== undefined && claim.refs !== null && !Array.isArray(claim.refs)) {
        addReason(reduction, EVIDENCE_REASON.CLAIM_INVALID)
        conflicts.push({
          kind: EVIDENCE_REASON.CLAIM_INVALID,
          id,
          executionId,
          path: reportPath,
          message: 'claim.refs 必须是数组',
        })
        continue
      }
      const rawRefs = Array.isArray(claim.refs) ? claim.refs.slice(0, MAX_REFS) : []
      if (Array.isArray(claim.refs) && claim.refs.length > MAX_REFS) {
        reduction.truncated = true
        addReason(reduction, EVIDENCE_REASON.TRUNCATED)
      }
      const refs = []
      let refsVerified = rawRefs.length > 0
      for (let refIndex = 0; refIndex < rawRefs.length; refIndex += 1) {
        const resolved = resolveRef(rawRefs[refIndex], context)
        if (resolved.conflict !== undefined) conflicts.push({
          ...resolved.conflict,
          executionId,
          claimId: id,
          reportPath,
        })
        if (resolved.missing !== undefined) missing.push({
          ...resolved.missing,
          executionId,
          claimId: id,
          reportPath,
        })
        if (resolved.ok) {
          addVerifiedRef(verifiedRefs, verifiedByKey, resolved.ref, {
            context: 'claim',
            claimId: id,
            reportPath: reportPath ?? undefined,
            executionId: executionId ?? undefined,
          })
          refs.push({ ...resolved.ref, verified: true })
        } else {
          refsVerified = false
          if (resolved.ref !== undefined) refs.push({ ...resolved.ref, verified: false })
          else refs.push({
            path: typeof rawRefs[refIndex]?.path === 'string' ? rawRefs[refIndex].path : null,
            sha256: typeof rawRefs[refIndex]?.sha256 === 'string' ? rawRefs[refIndex].sha256 : null,
            verified: false,
          })
        }
      }
      if (rawRefs.length === 0) {
        addReason(reduction, EVIDENCE_REASON.CLAIM_WITHOUT_REFS)
        missing.push({
          kind: 'claim',
          id,
          executionId,
          reportPath,
          reason: EVIDENCE_REASON.CLAIM_WITHOUT_REFS,
          message: 'claim 没有引用；value 只是报告自述，不能当作已核对事实',
        })
      }
      const entry = {
        id,
        type,
        value: value.value,
        // 结论永远是报告自述；hash 核对只证明「引用内容一致」。
        source: 'report-claim',
        trust: 'report-claim',
        valueTrust: 'report-claim',
        executionId,
        nodeId: host.nodeId,
        attempt: Number.isSafeInteger(doc.attempt) && doc.attempt >= 1 ? doc.attempt : null,
        reportPath,
        reportSha256: docSha,
        declaredExecutionId,
        refs,
        refsChecked: refsVerified,
        verifiedRefs: refs.filter(ref => ref.verified === true),
        conflict: false,
      }
      const entryKey = `${executionId ?? 'unknown'}\0${entry.id}`
      const previous = claimById.get(entryKey)
      if (previous !== undefined) {
        if (!jsonEqual(previous.value, entry.value)) {
          addReason(reduction, EVIDENCE_REASON.CLAIM_VALUE_CONFLICT)
          conflicts.push({
            kind: EVIDENCE_REASON.CLAIM_VALUE_CONFLICT,
            id: entry.id,
            executionId,
            values: [previous.value, entry.value],
            message: '同一 execution 内 claim id 相同但 value 不同',
          })
          entry.conflict = true
          previous.conflict = true
        } else {
          addReason(reduction, EVIDENCE_REASON.DUPLICATE_CLAIM_ID)
          conflicts.push({
            kind: EVIDENCE_REASON.DUPLICATE_CLAIM_ID,
            id: entry.id,
            executionId,
            message: '同一 execution 内 claim id 重复（value 相同，保留一条）',
          })
          continue
        }
      } else {
        // 跨 execution 的同 ID 不合并、不失效；但不同 value 必须可见。
        for (const existing of claims) {
          if (existing.id !== entry.id || existing.executionId === entry.executionId) continue
          if (jsonEqual(existing.value, entry.value)) continue
          addReason(reduction, EVIDENCE_REASON.CROSS_EXECUTION_CLAIM_DIVERGENCE)
          conflicts.push({
            kind: EVIDENCE_REASON.CROSS_EXECUTION_CLAIM_DIVERGENCE,
            id: entry.id,
            executionIds: [existing.executionId, entry.executionId],
            values: [existing.value, entry.value],
            message: '不同 execution 对同一 claim id 给出不同 value；两条来源都保留，不互相失效',
          })
        }
        claimById.set(entryKey, entry)
      }
      claims.push(entry)
    }

    const findingLimit = Math.min(report.findings.length, MAX_FINDINGS)
    if (report.findings.length > MAX_FINDINGS) {
      reduction.truncated = true
      addReason(reduction, EVIDENCE_REASON.TRUNCATED)
    }
    for (let findingIndex = 0; findingIndex < findingLimit; findingIndex += 1) {
      const rawFinding = report.findings[findingIndex]
      const finding = isPlainObject(rawFinding) ? rawFinding : null
      const id = finding === null ? null : idOf(finding.id, MAX_ID_CHARS)
      if (finding === null || id === null) {
        addReason(reduction, EVIDENCE_REASON.FINDING_INVALID)
        conflicts.push({
          kind: EVIDENCE_REASON.FINDING_INVALID,
          executionId,
          path: reportPath,
          index: findingIndex,
          message: 'finding 必须是对象且 id 是非空字符串（≤128 字符）',
        })
        continue
      }
      const status = idOf(finding.status, MAX_STATUS_CHARS)
      if (status === null) {
        addReason(reduction, EVIDENCE_REASON.FINDING_INVALID)
        conflicts.push({
          kind: EVIDENCE_REASON.FINDING_INVALID,
          id,
          executionId,
          path: reportPath,
          message: 'finding.status 必须是非空字符串（≤64 字符）',
        })
        continue
      }
      if (finding.refs !== undefined && finding.refs !== null && !Array.isArray(finding.refs)) {
        addReason(reduction, EVIDENCE_REASON.FINDING_INVALID)
        conflicts.push({
          kind: EVIDENCE_REASON.FINDING_INVALID,
          id,
          executionId,
          path: reportPath,
          message: 'finding.refs 必须是数组',
        })
        continue
      }
      const rawRefs = Array.isArray(finding.refs) ? finding.refs.slice(0, MAX_REFS) : []
      if (Array.isArray(finding.refs) && finding.refs.length > MAX_REFS) {
        reduction.truncated = true
        addReason(reduction, EVIDENCE_REASON.TRUNCATED)
      }
      const refs = []
      let allRefsVerified = rawRefs.length > 0
      for (let refIndex = 0; refIndex < rawRefs.length; refIndex += 1) {
        const resolved = resolveRef(rawRefs[refIndex], context)
        if (resolved.conflict !== undefined) conflicts.push({
          ...resolved.conflict,
          executionId,
          findingId: id,
          reportPath,
        })
        if (resolved.missing !== undefined) missing.push({
          ...resolved.missing,
          executionId,
          findingId: id,
          reportPath,
        })
        if (resolved.ok) {
          addVerifiedRef(verifiedRefs, verifiedByKey, resolved.ref, {
            context: 'finding',
            findingId: id,
            reportPath: reportPath ?? undefined,
            executionId: executionId ?? undefined,
          })
          refs.push({ ...resolved.ref, verified: true })
        } else {
          allRefsVerified = false
          if (resolved.ref !== undefined) refs.push({ ...resolved.ref, verified: false })
          else refs.push({
            path: typeof rawRefs[refIndex]?.path === 'string' ? rawRefs[refIndex].path : null,
            sha256: typeof rawRefs[refIndex]?.sha256 === 'string' ? rawRefs[refIndex].sha256 : null,
            verified: false,
          })
        }
      }
      const statusKey = status.toLowerCase()
      const isFixed = statusKey === 'fixed'
      // fixed 只有带复验引用、且引用全部命中**归档快照**并核对通过，才允许显示成
      // verified；只靠工作区回落不算复验。即便显示 verified，也只表示「复验引用已核对」，
      // 不表示结论成立。
      const archivedRefsVerified = rawRefs.length > 0
        && refs.every(ref => ref.verified === true && ref.resolvedFrom === 'artifact-snapshot')
      const verified = isFixed && allRefsVerified && archivedRefsVerified
      if (statusKey === 'verified' && !verified) {
        addReason(reduction, EVIDENCE_REASON.SELF_VERIFIED_CLAIM)
        missing.push({
          kind: 'finding',
          id,
          executionId,
          reportPath,
          reason: EVIDENCE_REASON.SELF_VERIFIED_CLAIM,
          message: '报告自称 verified，但没有经宿主核对的复验引用；不显示为 verified',
        })
      }
      if (isFixed && rawRefs.length === 0) {
        addReason(reduction, EVIDENCE_REASON.FIXED_WITHOUT_REFS)
        missing.push({
          kind: 'finding',
          id,
          executionId,
          reportPath,
          reason: EVIDENCE_REASON.FIXED_WITHOUT_REFS,
          message: 'finding 自称 fixed，但没有复验引用；不显示为 verified',
        })
      } else if (isFixed && (!allRefsVerified || !archivedRefsVerified)) {
        addReason(reduction, EVIDENCE_REASON.FIXED_REFS_UNVERIFIED)
        missing.push({
          kind: 'finding',
          id,
          executionId,
          reportPath,
          reason: EVIDENCE_REASON.FIXED_REFS_UNVERIFIED,
          message: 'finding 自称 fixed，但复验引用未全部命中归档快照 / 核对通过；不显示为 verified',
        })
      }
      const entry = {
        id,
        status,
        declaredStatus: status,
        displayStatus: verified ? 'verified' : (statusKey === 'verified' ? 'claimed-verified' : status),
        verified,
        refsChecked: allRefsVerified,
        refs,
        verifiedRefs: refs.filter(ref => ref.verified === true),
        conclusion: 'report-claim',
        conclusionVerified: false,
        source: 'report-claim',
        trust: 'report-claim',
        executionId,
        nodeId: host.nodeId,
        attempt: Number.isSafeInteger(doc.attempt) && doc.attempt >= 1 ? doc.attempt : null,
        reportPath,
        reportSha256: docSha,
        declaredExecutionId,
        conflict: false,
      }
      const entryKey = `${executionId ?? 'unknown'}\0${entry.id}`
      const previous = findingById.get(entryKey)
      if (previous !== undefined) {
        if (previous.status !== entry.status) {
          addReason(reduction, EVIDENCE_REASON.FINDING_STATUS_CONFLICT)
          conflicts.push({
            kind: EVIDENCE_REASON.FINDING_STATUS_CONFLICT,
            id: entry.id,
            executionId,
            statuses: [previous.status, entry.status],
            message: '同一 execution 内 finding id 相同但 status 不同',
          })
          entry.conflict = true
          previous.conflict = true
        } else {
          addReason(reduction, EVIDENCE_REASON.DUPLICATE_FINDING_ID)
          conflicts.push({
            kind: EVIDENCE_REASON.DUPLICATE_FINDING_ID,
            id: entry.id,
            executionId,
            message: '同一 execution 内 finding id 重复（status 相同，保留一条）',
          })
          continue
        }
      } else {
        for (const existing of findings) {
          if (existing.id !== entry.id || existing.executionId === entry.executionId) continue
          if (existing.status === entry.status) continue
          addReason(reduction, EVIDENCE_REASON.CROSS_EXECUTION_FINDING_DIVERGENCE)
          conflicts.push({
            kind: EVIDENCE_REASON.CROSS_EXECUTION_FINDING_DIVERGENCE,
            id: entry.id,
            executionIds: [existing.executionId, entry.executionId],
            statuses: [existing.status, entry.status],
            message: '不同 execution 对同一 finding id 给出不同 status；两条来源都保留，不互相失效',
          })
        }
        findingById.set(entryKey, entry)
      }
      findings.push(entry)
    }
  }

  const evidenceStatus = reportDocs.length === 0
    ? 'missing'
    : (parsedReportCount === 0 ? 'invalid' : ((missing.length > 0 || conflicts.length > 0) ? 'partial' : 'present'))
  const dataQuality = {
    // 明确的状态词：missing / invalid / partial / present；不是 pass/warn/fail 评级。
    evidenceStatus,
    // 缺报告 / 报告不可读 = 未知；有报告但引用有缺口时仍如实给出已有事实。
    unknown: evidenceStatus === 'missing' || evidenceStatus === 'invalid',
    stub: reduction.stub,
    reportCount: reportDocs.length,
    parsedReportCount,
    reportLimit: MAX_REPORTS,
    claimCount: claims.length,
    findingCount: findings.length,
    verifiedRefCount: verifiedRefs.length,
    missingCount: missing.length,
    conflictCount: conflicts.length,
    snapshotMissing: reduction.snapshotMissing,
    workspaceFallbacks: reduction.workspaceFallbacks,
    skippedEvents: Number.isInteger(source.skippedEvents) && source.skippedEvents > 0 ? source.skippedEvents : 0,
    truncated: reduction.truncated,
    reasons: [...reduction.reasons].sort((a, b) => a.localeCompare(b)),
    producerSelfClaims: reduction.producerSelfClaims,
    // 让调用方一眼看到「没有总评级」：本字段固定为 false，findings 不参与 admission。
    contributesToAdmission: false,
    injectedIntoInstanceState: false,
  }

  return {
    schema: EVIDENCE_SCHEMA,
    instanceId: nonEmptyString(instance.id) ? instance.id : null,
    instanceStatus: nonEmptyString(instance.status) ? instance.status : null,
    asOf,
    claims,
    findings,
    verifiedRefs,
    missing,
    conflicts,
    sourceExecutions,
    dataQuality,
  }
}
