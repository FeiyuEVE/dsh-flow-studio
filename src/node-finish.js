/**
 * 节点完成工具 `flow_finish_node` 的**独立校验层**（0.13.1 硬契约）。
 *
 * 职责边界：
 *   1. `validateFinishArgs`：纯函数，不碰 fs。校验顶层键 / `variables` / `documents`
 *      的**形状与上限**，返回归一化结果；
 *   2. `createFinishGate`：一次活动执行（executionId + nodeId + attempt）的完成闸门。
 *      `submit(args)` 先跑纯校验、再做宿主侧文档校验（存在、普通文件、realpath 在
 *      workspaceRoot 内、≤5 MiB、**同一文件句柄**分块读 + 前后 fstat 一致），全部通过
 *      后才产生**唯一一条** record；
 *   3. `abort(reason)`：活动超时 / 取消时让 `result` reject（带 `aborted` 标记），
 *      并让后续 `submit` 永远得到 `NODE_ALREADY_SETTLED`。
 *
 * 本模块**不**接 runtime / runner，不注册模型工具、不写实例目录、不写事件：A4
 * adapter 只拿 `record` 的 `output`（短变量）与 `artifacts`（文件引用）去接线。
 * 契约见 `docs/design/11-node-finish-tool.md`。
 *
 * 闸门是**被动**的：不做「停下来没调工具」的提醒、不计数、不自动失败，也不判定
 * `NODE_FINISH_MISSING`——那是 adapter 的 `turn.stop` hook（11 §3.1）的职责。
 * adapter 只需在每轮结束时查一次 `settled()`（`reason()` 可重复查询）来判断本轮
 * 是否已完结。
 *
 * record 形状（字段冻结）：
 * ```
 * {
 *   executionId, nodeId, attempt,
 *   output,     // 归一化后的短变量（只含标量）
 *   artifacts,  // [{ path, sha256, bytes, kind, title, summary, nodeId, attempt, at }]
 *   summary, at,
 * }
 * ```
 * 文档正文**不进** record，也不进任何错误信息；错误里只出现工作区**相对路径**。
 * `artifacts[].summary` 是 `documents[].summary` 的短投影（≤200 码点，超限整次拒绝），
 * 让工具返回与 `activity/end` 都能看到「这份文档是什么」（m3）。
 *
 * @module @feiyueve/dsh-flow-studio/node-finish
 */

import { Buffer } from 'node:buffer'
import { createHash as nodeCreateHash } from 'node:crypto'
import { constants as fsConstants, promises as fsp } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 错误码（对外契约；测试与 adapter 都按这些字符串判断）。 */
export const NODE_FINISH_ERROR = Object.freeze({
  /** 顶层形状 / 必填 / 未知键 / summary 超限 / 闸门参数非法。 */
  INVALID: 'NODE_FINISH_INVALID',
  /** `variables` 形状或上限不合法。 */
  VARIABLES_INVALID: 'NODE_VARIABLES_INVALID',
  /** `documents` 形状 / 路径 / 宿主校验不合法。 */
  DOCUMENT_INVALID: 'NODE_DOCUMENT_INVALID',
  /** 本次活动已经成功完成过一次（含并发），幂等拒绝，不重复登记产物。 */
  ALREADY_FINISHED: 'NODE_ALREADY_FINISHED',
  /** 闸门已被 abort，不再接受 submit。 */
  ALREADY_SETTLED: 'NODE_ALREADY_SETTLED',
  /** `result` 被 abort 时 reject 的错误码（错误对象带 `aborted: true`）。 */
  ABORTED: 'NODE_FINISH_ABORTED',
})

/**
 * 默认上限。`limits` 可覆盖其中任意一项（正整数），未知键忽略。
 *
 * 口径来自 11 §2：
 *   - 变量键 ≤32、单串 ≤512 Unicode 字符、UTF-8 JSON ≤8192 字节；
 *   - 文档 ≤32 份、单份 ≤5 MiB；path ≤1024 字符；kind/title/summary 有界；
 *   - chunkBytes 只影响读取分块大小，不改变最终 bytes/sha256。
 */
export const NODE_FINISH_LIMITS = Object.freeze({
  maxVariables: 32,
  maxVariableStringChars: 512,
  maxVariableBytes: 8192,
  maxSummaryChars: 500,
  maxDocuments: 32,
  maxPathChars: 1024,
  maxKindChars: 64,
  maxTitleChars: 200,
  maxDocSummaryChars: 200,
  maxDocumentBytes: 5 * 1024 * 1024,
  chunkBytes: 64 * 1024,
})

const TOP_LEVEL_KEYS = new Set(['variables', 'documents', 'summary'])
const DANGEROUS_VARIABLE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const SHA256_HEX = /^[0-9a-f]{64}$/

/** 带结构化错误码的校验错误。 */
export class NodeFinishError extends Error {
  /**
   * @param {string} code 见 `NODE_FINISH_ERROR`
   * @param {string} message 中文可行动原因
   * @param {object} [details] 结构化定位（field / index / path / reason）
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'NodeFinishError'
    this.code = code
    this.details = details !== undefined && details !== null && typeof details === 'object'
      ? details
      : undefined
    if (this.details && typeof this.details.field === 'string') this.field = this.details.field
    this.aborted = Boolean(this.details && this.details.aborted === true)
  }
}

function fail(code, message, details) {
  return new NodeFinishError(code, message, details)
}

function invalid(message, details) {
  return fail(NODE_FINISH_ERROR.INVALID, message, details)
}

function variablesInvalid(message, details) {
  return fail(NODE_FINISH_ERROR.VARIABLES_INVALID, message, details)
}

function documentInvalid(message, details) {
  return fail(NODE_FINISH_ERROR.DOCUMENT_INVALID, message, details)
}

/** 只接受「普通对象」：数组 / Date / Map / class 实例都不算。 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Unicode 字符数（码点），不是 UTF-16 单元数。 */
function charLength(value) {
  return Array.from(value).length
}

function describeType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 合并 / 校验 limits：只接受正整数，未知键忽略。 */
function normalizeLimits(limits) {
  const merged = { ...NODE_FINISH_LIMITS }
  if (limits === undefined || limits === null) return merged
  if (!isPlainObject(limits)) {
    throw invalid('limits 必须是对象', { field: 'limits' })
  }
  for (const key of Object.keys(NODE_FINISH_LIMITS)) {
    const value = limits[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 1) {
      throw invalid(`limits.${key} 必须是正整数`, { field: `limits.${key}` })
    }
    merged[key] = value
  }
  return merged
}

function normalizeVariableValue(key, value, bounds) {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw variablesInvalid(
        `variables.${key} 必须是有限数字（拒绝 NaN / Infinity）`,
        { field: `variables.${key}`, reason: 'non-finite-number' },
      )
    }
    return value
  }
  if (typeof value === 'string') {
    if (charLength(value) > bounds.maxVariableStringChars) {
      throw variablesInvalid(
        `variables.${key} 超过 ${bounds.maxVariableStringChars} 个 Unicode 字符`,
        { field: `variables.${key}`, reason: 'string-too-long', limit: bounds.maxVariableStringChars },
      )
    }
    return value
  }
  throw variablesInvalid(
    `variables.${key} 只允许 boolean / number / null / 短字符串（收到 ${describeType(value)}）`,
    { field: `variables.${key}`, reason: 'unsupported-type' },
  )
}

/**
 * `variables` 归一化：只保留标量短变量，拒绝原型污染键、嵌套结构与超限。
 * @param {unknown} raw
 * @param {object} bounds
 */
function normalizeVariables(raw, bounds) {
  if (!isPlainObject(raw)) {
    throw variablesInvalid('variables 必须是对象（可空对象 {}）', { field: 'variables', reason: 'not-object' })
  }
  const keys = Object.keys(raw)
  if (keys.length > bounds.maxVariables) {
    throw variablesInvalid(
      `variables 最多 ${bounds.maxVariables} 个键（收到 ${keys.length} 个）`,
      { field: 'variables', reason: 'too-many-keys', limit: bounds.maxVariables },
    )
  }
  const output = {}
  for (const key of keys) {
    if (DANGEROUS_VARIABLE_KEYS.has(key)) {
      throw variablesInvalid(
        `variables 不允许 ${key} 键（防原型污染）`,
        { field: `variables.${key}`, reason: 'forbidden-key' },
      )
    }
    output[key] = normalizeVariableValue(key, raw[key], bounds)
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(output), 'utf8')
  if (serializedBytes > bounds.maxVariableBytes) {
    throw variablesInvalid(
      `variables 序列化后 ${serializedBytes} 字节，超过 ${bounds.maxVariableBytes} 字节上限`,
      { field: 'variables', reason: 'too-many-bytes', bytes: serializedBytes, limit: bounds.maxVariableBytes },
    )
  }
  return output
}

/**
 * 对外共享的短变量校验（E3 实例启动工具与 `flow_finish_node` 同口径）。
 *
 * 只接受 boolean / number / null / 短字符串；键 ≤32、单串 ≤512 Unicode 字符、
 * 序列化后 ≤8 KiB。越限抛 `NodeFinishError(code='NODE_VARIABLES_INVALID')`，
 * 调用方按 `error.code` 分流，不用解析中文。
 *
 * @param {unknown} raw
 * @param {object} [limits] 只覆盖 `NODE_FINISH_LIMITS` 里的同名项
 * @returns {Record<string, boolean|number|string|null>}
 */
export function normalizeShortVariables(raw, limits) {
  return normalizeVariables(raw, normalizeLimits(limits))
}

/**
 * 文档路径规则（沿用 `runlog.js` 的 artifact 路径口径，长度上限按 11 §2 放宽到 1024）：
 * 非空相对路径；拒绝绝对路径、`..` / `.` 段、反斜杠、空段、NUL。
 * @param {unknown} value
 * @param {number} index
 * @param {object} bounds
 */
function normalizeDocumentPath(value, index, bounds) {
  if (typeof value !== 'string' || value === '') {
    throw documentInvalid(`documents[${index}].path 必须是非空字符串`, { index, field: 'path', reason: 'not-string' })
  }
  if (charLength(value) > bounds.maxPathChars) {
    throw documentInvalid(
      `documents[${index}].path 超过 ${bounds.maxPathChars} 个字符`,
      { index, field: 'path', reason: 'path-too-long', limit: bounds.maxPathChars },
    )
  }
  if (value.includes('\0')) {
    throw documentInvalid(`documents[${index}].path 含有 NUL 字符`, { index, field: 'path', reason: 'nul' })
  }
  if (value.includes('\\')) {
    throw documentInvalid(`documents[${index}].path 不允许反斜杠`, { index, field: 'path', reason: 'backslash' })
  }
  if (isAbsolute(value)) {
    throw documentInvalid(`documents[${index}].path 必须是工作区内相对路径（拒绝绝对路径）`, { index, field: 'path', reason: 'absolute' })
  }
  for (const segment of value.split('/')) {
    if (segment === '') {
      throw documentInvalid(`documents[${index}].path 不允许空段`, { index, field: 'path', reason: 'empty-segment' })
    }
    if (segment === '..' || segment === '.') {
      throw documentInvalid(`documents[${index}].path 不允许 ${segment} 段`, { index, field: 'path', reason: 'dot-segment' })
    }
  }
  return value
}

function normalizeOptionalDocumentString(raw, index, field, limit) {
  if (raw === undefined) return ''
  if (typeof raw !== 'string') {
    throw documentInvalid(`documents[${index}].${field} 必须是字符串`, { index, field, reason: 'not-string' })
  }
  if (charLength(raw) > limit) {
    throw documentInvalid(
      `documents[${index}].${field} 超过 ${limit} 个字符`,
      { index, field, reason: 'too-long', limit },
    )
  }
  return raw
}

function normalizeDocument(raw, index, bounds) {
  if (!isPlainObject(raw)) {
    throw documentInvalid(`documents[${index}] 必须是对象`, { index, reason: 'not-object' })
  }
  return {
    path: normalizeDocumentPath(raw.path, index, bounds),
    kind: normalizeOptionalDocumentString(raw.kind, index, 'kind', bounds.maxKindChars),
    title: normalizeOptionalDocumentString(raw.title, index, 'title', bounds.maxTitleChars),
    summary: normalizeOptionalDocumentString(raw.summary, index, 'summary', bounds.maxDocSummaryChars),
  }
}

function normalizeDocuments(raw, bounds) {
  if (!Array.isArray(raw)) {
    throw documentInvalid('documents 必须是数组（可空数组 []）', { field: 'documents', reason: 'not-array' })
  }
  if (raw.length > bounds.maxDocuments) {
    throw documentInvalid(
      `documents 最多 ${bounds.maxDocuments} 份（收到 ${raw.length} 份）`,
      { field: 'documents', reason: 'too-many', limit: bounds.maxDocuments },
    )
  }
  return raw.map((entry, index) => normalizeDocument(entry, index, bounds))
}

function normalizeSummary(raw, bounds) {
  if (typeof raw !== 'string') {
    throw invalid('summary 必须是字符串（可为空串）', { field: 'summary', reason: 'not-string' })
  }
  if (charLength(raw) > bounds.maxSummaryChars) {
    throw invalid(
      `summary 超过 ${bounds.maxSummaryChars} 个字符`,
      { field: 'summary', reason: 'too-long', limit: bounds.maxSummaryChars },
    )
  }
  return raw
}

/**
 * 纯校验：顶层形状 → 必填 → variables → documents → summary。
 * 不碰 fs，不产生 record；宿主侧文档校验在 `createFinishGate().submit` 里做。
 *
 * @param {unknown} args 工具入参
 * @param {object} [limits] 覆盖 `NODE_FINISH_LIMITS` 的部分上限
 * @returns {{ variables: object, documents: Array<{path: string, kind: string, title: string, summary: string}>, summary: string }}
 * @throws {NodeFinishError}
 */
export function validateFinishArgs(args, limits) {
  const bounds = normalizeLimits(limits)
  if (!isPlainObject(args)) {
    throw invalid('flow_finish_node 入参必须是对象', { field: 'args', reason: 'not-object' })
  }
  for (const key of Object.keys(args)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw invalid(`flow_finish_node 不接受未知顶层键 ${key}`, { field: key, reason: 'unknown-key' })
    }
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!Object.hasOwn(args, key)) {
      throw invalid(`flow_finish_node 缺少必填键 ${key}`, { field: key, reason: 'missing' })
    }
  }
  return {
    variables: normalizeVariables(args.variables, bounds),
    documents: normalizeDocuments(args.documents, bounds),
    summary: normalizeSummary(args.summary, bounds),
  }
}

/** `target` 的 realpath 是否落在 `rootReal` 之内（含 root 自身）。 */
function isPathInside(rootReal, targetReal) {
  const rel = relative(rootReal, targetReal)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** 注入的 stat / handle.stat 之间的基本同一性：防止 realpath 与 open 之间被替换。 */
function sameFileIdentity(before, after) {
  if (!before || typeof before !== 'object' || !after || typeof after !== 'object') return false
  if (before.size !== after.size) return false
  if (before.dev !== undefined && after.dev !== undefined && before.dev !== after.dev) return false
  if (before.ino !== undefined && after.ino !== undefined && before.ino !== after.ino) return false
  return true
}

/** 同一文件句柄读前 / 读后：size、mtime、ctime 任一变化都算「校验中被改」。 */
function sameFileState(before, after) {
  if (before.size !== after.size) return false
  if (before.mtimeMs !== undefined && after.mtimeMs !== undefined && before.mtimeMs !== after.mtimeMs) return false
  if (before.ctimeMs !== undefined && after.ctimeMs !== undefined && before.ctimeMs !== after.ctimeMs) return false
  return true
}

function statReason(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') return error.code
  return 'stat-failed'
}

/** 是否硬链接（`nlink > 1`）。注入的 stat 可能不带 nlink：缺省按「不是」处理。 */
function isHardLink(info) {
  return Boolean(info && typeof info === 'object'
    && Number.isSafeInteger(info.nlink) && info.nlink > 1)
}

/**
 * 宿主侧校验一份文档，返回**不含** nodeId/attempt/at 的产物引用。
 * 读取始终从同一个 FileHandle 分块进行（默认 64 KiB/块），读完前后各 fstat 一次；
 * 注入 `readFile` 时改用注入实现作为字节源（测试用），但前后 fstat 与字节数核对照旧。
 */
async function verifyDocument(doc, index, deps, bounds) {
  const { workspaceRoot, rootReal, stat, realpath, readFile, createHash } = deps
  const absolute = join(workspaceRoot, doc.path)
  const details = { index, path: doc.path }
  const failDoc = (reason, message) => documentInvalid(
    `文档 ${doc.path}：${message}`,
    { ...details, reason },
  )

  let info
  try {
    info = await stat(absolute)
  } catch (error) {
    throw failDoc('not-found', `不存在或无法访问（${statReason(error)}）`)
  }
  if (!info || typeof info !== 'object' || typeof info.isFile !== 'function' || !info.isFile()) {
    throw failDoc('not-regular-file', '不是普通文件')
  }
  // m8：工作区内路径但 nlink>1 = 硬链接到别处（可能在工区外）。只登记引用虽然不泄漏
  // 正文，但「工作区内的独立文件」这条口径会被绕过；直接拒绝，错误里说明原因。
  if (isHardLink(info)) {
    throw failDoc('hardlink', '文档必须是工作区内的独立文件，不接受硬链接（nlink>1）')
  }
  if (info.size > bounds.maxDocumentBytes) {
    throw failDoc('too-large', `${info.size} 字节，超过 ${bounds.maxDocumentBytes} 字节上限`)
  }

  let realPath
  try {
    realPath = await realpath(absolute)
  } catch (error) {
    throw failDoc('realpath-failed', `无法解析真实路径（${statReason(error)}）`)
  }
  if (typeof realPath !== 'string' || realPath === '' || !isPathInside(rootReal, realPath)) {
    throw failDoc('outside-workspace', 'realpath 落在工作区之外（符号链接逃逸）')
  }

  let handle = null
  try {
    try {
      handle = await fsp.open(realPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    } catch (error) {
      throw failDoc('open-failed', `无法打开（${statReason(error)}）`)
    }

    let before
    try {
      before = await handle.stat()
    } catch (error) {
      throw failDoc('fstat-failed', `无法读取文件句柄状态（${statReason(error)}）`)
    }
    if (typeof before.isFile !== 'function' || !before.isFile()) {
      throw failDoc('not-regular-file', '不是普通文件')
    }
    // stat 与 fstat 之间被换成硬链接也要拒（race 兜底）。
    if (isHardLink(before)) {
      throw failDoc('hardlink', '文档必须是工作区内的独立文件，不接受硬链接（nlink>1）')
    }
    if (before.size > bounds.maxDocumentBytes) {
      throw failDoc('too-large', `${before.size} 字节，超过 ${bounds.maxDocumentBytes} 字节上限`)
    }
    // stat（路径）与 fstat（句柄）必须是同一个文件；中间被替换就拒绝，不读新内容。
    if (!sameFileIdentity(info, before)) {
      throw failDoc('changed', '校验期间文件被替换（stat 与 fstat 不一致）')
    }

    const hash = createHash('sha256')
    let bytes = 0

    if (typeof readFile === 'function') {
      // 仅测试 / 嵌入方注入：字节源换成注入实现；仍按 before.size 与前后 fstat 核对。
      let content
      try {
        content = await readFile(realPath)
      } catch (error) {
        throw failDoc('read-failed', `读取失败（${statReason(error)}）`)
      }
      if (!Buffer.isBuffer(content)) {
        throw failDoc('read-failed', '注入的 readFile 没有返回 Buffer')
      }
      if (content.length > bounds.maxDocumentBytes) {
        throw failDoc('too-large', `${content.length} 字节，超过 ${bounds.maxDocumentBytes} 字节上限`)
      }
      hash.update(content)
      bytes = content.length
    } else {
      // 有界分块读取：最多读到 before.size；同时多探 1 字节，文件变长立刻拒绝。
      const chunkSize = Math.max(1, Math.min(bounds.chunkBytes, before.size || 1))
      const buffer = Buffer.allocUnsafe(chunkSize)
      let position = 0
      let remaining = before.size
      while (remaining > 0) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), position)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
        remaining -= bytesRead
        bytes += bytesRead
      }
      if (remaining === 0) {
        const { bytesRead: grew } = await handle.read(buffer, 0, 1, position)
        if (grew > 0) {
          throw failDoc('changed', '校验期间文件变长')
        }
      }
    }

    if (bytes !== before.size) {
      throw failDoc('size-mismatch', `读到的字节数 ${bytes} 与文件大小 ${before.size} 不符（校验期间文件被修改）`)
    }

    let after
    try {
      after = await handle.stat()
    } catch (error) {
      throw failDoc('fstat-failed', `无法复核文件句柄状态（${statReason(error)}）`)
    }
    if (!sameFileState(before, after)) {
      throw failDoc('changed', '校验期间文件被修改（size / mtime / ctime 变化）')
    }

    const sha256 = hash.digest('hex')
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      throw failDoc('hash-failed', 'sha256 不是 64 位十六进制摘要')
    }

    return {
      path: doc.path,
      sha256: sha256.toLowerCase(),
      bytes,
      kind: doc.kind,
      title: doc.title,
      // 短字段持久化：flow_finish_node 返回与 activity/end 都能看到（m3）。
      summary: doc.summary,
    }
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // 关闭失败不影响已经完成的校验结论。
      }
    }
  }
}

/** 注入依赖归一化：默认 fs / crypto，注入的可以是同步或异步实现。 */
function resolveDeps(options) {
  return {
    stat: typeof options.stat === 'function' ? options.stat : path => fsp.stat(path),
    realpath: typeof options.realpath === 'function' ? options.realpath : path => fsp.realpath(path),
    readFile: typeof options.readFile === 'function' ? options.readFile : null,
    createHash: typeof options.createHash === 'function' ? options.createHash : nodeCreateHash,
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value === '') {
    throw invalid(`createFinishGate 的 ${field} 必须是非空字符串`, { field, reason: 'not-string' })
  }
  return value
}

function normalizeAttempt(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid('createFinishGate 的 attempt 必须是 ≥1 的整数', { field: 'attempt', reason: 'not-positive-integer' })
  }
  return value
}

function normalizeNow(now) {
  const value = typeof now === 'function' ? now() : new Date()
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  throw invalid('now() 没有返回合法时间', { field: 'now', reason: 'invalid-time' })
}

/**
 * 一次活动执行的完成闸门。
 *
 * @param {object} options
 * @param {string} options.executionId 活动执行 id
 * @param {string} options.nodeId 节点 id
 * @param {number} options.attempt 第几次 attempt（≥1）
 * @param {string} options.workspaceRoot 工作区根目录（文档路径的相对基准）
 * @param {object} [options.limits] 覆盖 `NODE_FINISH_LIMITS` 的部分上限
 * @param {{captureFile: (path: string) => Promise<{sha256: string, bytes: number, contentRef: string}>}} [options.artifactStore]
 *   可选：把文档正文按 hash 寻址保存受控副本（worktree 清理后仍可读）；只做安全读取
 * @param {string} [options.workspaceId] 产物来源工作区（写进 artifact 来源字段）
 * @param {() => (Date|number|string)} [options.now] 时间注入（默认 `new Date()`）
 * @param {(path: string) => (Buffer|Promise<Buffer>)} [options.readFile] 字节源注入（测试用）
 * @param {(path: string) => (object|Promise<object>)} [options.stat] fs.stat 注入
 * @param {(path: string) => (string|Promise<string>)} [options.realpath] fs.realpath 注入
 * @param {(algorithm: string) => object} [options.createHash] crypto.createHash 注入
 * @returns {{ submit: (args: unknown) => Promise<{ok: true, record: object}>, result: Promise<object>, abort: (reason?: unknown) => boolean, settled: () => boolean, reason: () => unknown }}
 */
export function createFinishGate(options) {
  if (!isPlainObject(options)) {
    throw invalid('createFinishGate 需要 options 对象', { field: 'options', reason: 'not-object' })
  }
  const executionId = requireNonEmptyString(options.executionId, 'executionId')
  const nodeId = requireNonEmptyString(options.nodeId, 'nodeId')
  const attempt = normalizeAttempt(options.attempt)
  const workspaceRoot = resolve(requireNonEmptyString(options.workspaceRoot, 'workspaceRoot'))
  const bounds = normalizeLimits(options.limits)
  const deps = resolveDeps(options)
  const artifactStore = options.artifactStore && typeof options.artifactStore.captureFile === 'function'
    ? options.artifactStore
    : null
  const workspaceId = typeof options.workspaceId === 'string' && options.workspaceId !== ''
    ? options.workspaceId
    : null
  const now = typeof options.now === 'function'
    ? options.now
    : () => new Date()

  /** @type {'pending'|'running'|'finished'|'aborted'} */
  let state = 'pending'
  let abortReason = null

  let resolveResult
  let rejectResult
  const result = new Promise((resolvePromise, rejectPromise) => {
    resolveResult = resolvePromise
    rejectResult = rejectPromise
  })
  // 调用方可能只等 submit 而从不 await result：先挂一个空 handler，避免 abort 时出现
  // 未处理的 rejection；真正 await result 的调用方仍会拿到原 reject 原因。
  result.catch(() => {})

  async function resolveWorkspace() {
    let rootInfo
    try {
      rootInfo = await deps.stat(workspaceRoot)
    } catch (error) {
      throw documentInvalid(
        `工作区目录不可用（${statReason(error)}）`,
        { field: 'workspaceRoot', reason: 'stat-failed' },
      )
    }
    if (!rootInfo || typeof rootInfo.isDirectory !== 'function' || !rootInfo.isDirectory()) {
      throw documentInvalid('工作区路径不是目录', { field: 'workspaceRoot', reason: 'not-directory' })
    }
    try {
      return await deps.realpath(workspaceRoot)
    } catch (error) {
      throw documentInvalid(
        `无法解析工作区真实路径（${statReason(error)}）`,
        { field: 'workspaceRoot', reason: 'realpath-failed' },
      )
    }
  }

  async function verifyDocuments(documents) {
    if (documents.length === 0) return []
    const rootReal = await resolveWorkspace()
    const verified = []
    for (let index = 0; index < documents.length; index += 1) {
      verified.push(await verifyDocument(documents[index], index, { ...deps, workspaceRoot, rootReal }, bounds))
    }
    return verified
  }

  /**
   * 已登记文档的受控快照（0.13.7 C）：使用 artifact store 再安全读一次并核对 hash。
   * 只有调用方显式注入 store 时才写快照 / 加来源字段，保持旧直调测试的 record 形状。
   */
  async function captureArtifacts(verified) {
    if (artifactStore === null) return verified
    const captured = []
    for (const artifact of verified) {
      let stored
      try {
        stored = await artifactStore.captureFile(join(workspaceRoot, artifact.path))
      } catch (error) {
        throw documentInvalid(
          `文档 ${artifact.path}：保存产物快照失败（${error?.message ?? error}）`,
          { field: 'documents', path: artifact.path, reason: 'artifact-snapshot-failed' },
        )
      }
      if (!stored || stored.sha256 !== artifact.sha256 || stored.bytes !== artifact.bytes) {
        throw documentInvalid(
          `文档 ${artifact.path}：快照内容与校验结果不一致（校验期间文件被修改）`,
          { field: 'documents', path: artifact.path, reason: 'artifact-changed' },
        )
      }
      captured.push({
        ...artifact,
        contentRef: stored.contentRef,
        executionId,
        ...(workspaceId === null ? {} : { workspaceId }),
      })
    }
    return captured
  }

  async function submit(args) {
    if (state === 'aborted') {
      throw fail(
        NODE_FINISH_ERROR.ALREADY_SETTLED,
        '节点完成等待已中止，不能再提交（abort 之后 submit 永久拒绝）',
        { executionId, nodeId, attempt, reason: 'aborted' },
      )
    }
    if (state === 'finished' || state === 'running') {
      throw fail(
        NODE_FINISH_ERROR.ALREADY_FINISHED,
        '本次活动已经受理过完成提交（或已完成），重复提交被拒绝（幂等，不重复登记产物）',
        { executionId, nodeId, attempt, reason: 'already-finished' },
      )
    }

    // 纯校验是同步的：非法参数不会占用闸门，失败后可以修正重试。
    const normalized = validateFinishArgs(args, bounds)
    state = 'running'
    try {
      const verified = await verifyDocuments(normalized.documents)
      // 宿主校验期间被 abort：不能产生 record，也不能 resolve result。
      if (state !== 'running') {
        throw fail(
          NODE_FINISH_ERROR.ALREADY_SETTLED,
          '节点完成等待在文档校验期间被中止',
          { executionId, nodeId, attempt, reason: 'aborted' },
        )
      }
      const at = normalizeNow(now)
      const captured = await captureArtifacts(verified)
      // 快照写入期间也可能被 abort：同样不能产生 record。
      if (state !== 'running') {
        throw fail(
          NODE_FINISH_ERROR.ALREADY_SETTLED,
          '节点完成等待在产物快照期间被中止',
          { executionId, nodeId, attempt, reason: 'aborted' },
        )
      }
      const record = {
        executionId,
        nodeId,
        attempt,
        output: normalized.variables,
        artifacts: captured.map(artifact => ({ ...artifact, nodeId, attempt, at })),
        summary: normalized.summary,
        at,
      }
      state = 'finished'
      resolveResult(record)
      return { ok: true, record }
    } catch (error) {
      // 只有仍处于 running 才回到 pending；被 abort 的闸门保持 aborted。
      if (state === 'running') state = 'pending'
      throw error
    }
  }

  function abort(reason) {
    if (state === 'finished' || state === 'aborted') return false
    state = 'aborted'
    abortReason = reason === undefined ? null : reason
    const suffix = abortReason === null || abortReason === '' ? '' : `：${String(abortReason)}`
    const error = new NodeFinishError(
      NODE_FINISH_ERROR.ABORTED,
      `节点完成等待被中止${suffix}`,
      { aborted: true, reason: abortReason, executionId, nodeId, attempt },
    )
    error.reason = abortReason
    rejectResult(error)
    return true
  }

  return {
    submit,
    result,
    abort,
    settled: () => state === 'finished' || state === 'aborted',
    reason: () => abortReason,
  }
}
