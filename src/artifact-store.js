/**
 * 产物内容快照（0.13.7 C）：已登记文档按 hash 寻址保存受控副本。
 *
 * worktree 在实例终态可能被清理，但 `flow_finish_node` 登记的产物不能因此失效。
 * 本模块提供 `<base>/artifacts/<sha256>` 的原子写与安全读取：
 *   - 写入只接受宿主侧安全读取得到的字节（`captureFile` 用 O_NOFOLLOW + 句柄 fstat）；
 *   - 对外契约仍是 `path + sha256 + bytes`，`contentRef` 只是新增的来源指针；
 *   - `contentRef` 统一为 `artifacts/<sha256>`，读取时只接受 64 位小写十六进制，
 *     不接受 `..` / 绝对路径（不把用户输入拼进文件路径）。
 *
 * @module @feiyueve/dsh-flow-studio/artifact-store
 */

import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants, promises as fsp } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** 对外错误码。 */
export const ARTIFACT_ERROR = Object.freeze({
  INVALID: 'ARTIFACT_INVALID',
  TOO_LARGE: 'ARTIFACT_TOO_LARGE',
  NOT_FOUND: 'ARTIFACT_NOT_FOUND',
  HASH_MISMATCH: 'ARTIFACT_HASH_MISMATCH',
  CAPTURE_FAILED: 'ARTIFACT_CAPTURE_FAILED',
  /** 存储目标是符号链接 / 非普通文件：拒绝跟随、拒绝写入（review-0137 W8）。 */
  UNSAFE_TARGET: 'ARTIFACT_UNSAFE_TARGET',
})

/** 64 位小写十六进制摘要（对外唯一合法寻址键）。 */
export const ARTIFACT_HASH_PATTERN = /^[0-9a-f]{64}$/
/** 默认单份产物上限（与 node-finish 的文档上限一致）。 */
export const DEFAULT_ARTIFACT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_CHUNK_BYTES = 64 * 1024
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** artifact 快照根（`<base>/artifacts`）。 */
export function artifactsRootFor(base) {
  return join(resolve(base), 'artifacts')
}

/** 对外 contentRef：`artifacts/<sha256>`。 */
export function contentRefFor(sha256) {
  const hash = normalizeHash(sha256)
  return `artifacts/${hash}`
}

/** 从 contentRef / 裸 hash 取 hash；非法返回 null。 */
export function hashFromContentRef(ref) {
  if (typeof ref !== 'string' || ref === '') return null
  const text = ref.startsWith('artifacts/') ? ref.slice('artifacts/'.length) : ref
  return ARTIFACT_HASH_PATTERN.test(text) ? text : null
}

function normalizeHash(value) {
  const text = typeof value === 'string' ? value.toLowerCase() : ''
  if (!ARTIFACT_HASH_PATTERN.test(text)) {
    throw artifactError(ARTIFACT_ERROR.INVALID, `产物 hash 必须是 64 位小写十六进制：${String(value)}`)
  }
  return text
}

function artifactError(code, message, extra = {}) {
  const error = new Error(message)
  error.name = 'ArtifactError'
  error.code = code
  Object.assign(error, extra)
  return error
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE })
  // 存储根不能是符号链接：否则所有 hash 寻址都跟着链接跑到别处。
  const info = await fsp.lstat(dir)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw artifactError(ARTIFACT_ERROR.UNSAFE_TARGET, `artifact 存储根必须是真实目录（不是符号链接）：${dir}`, {
      path: dir,
      reason: info.isSymbolicLink() ? 'symlink-root' : 'not-directory',
    })
  }
  await fsp.chmod(dir, DIR_MODE).catch(() => {})
}

/** 判断两个 fstat 结果是否是同一个、未被改动的普通文件。 */
function sameFileState(before, after) {
  if (before.size !== after.size) return false
  if (before.mtimeMs !== undefined && after.mtimeMs !== undefined && before.mtimeMs !== after.mtimeMs) return false
  if (before.ctimeMs !== undefined && after.ctimeMs !== undefined && before.ctimeMs !== after.ctimeMs) return false
  return true
}

/**
 * 创建 artifact store（一个根目录一份，实例共享）。
 *
 * @param {{root:string, maxBytes?:number, chunkBytes?:number}} options
 */
export function createArtifactStore(options = {}) {
  if (!isPlainObject(options)) throw artifactError(ARTIFACT_ERROR.INVALID, 'createArtifactStore 需要对象参数')
  if (typeof options.root !== 'string' || options.root.trim() === '' || !isAbsolute(options.root.trim())) {
    throw artifactError(ARTIFACT_ERROR.INVALID, 'artifact store 需要绝对路径 root')
  }
  const root = resolve(options.root.trim())
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_ARTIFACT_MAX_BYTES
  const chunkBytes = Number.isSafeInteger(options.chunkBytes) && options.chunkBytes > 0
    ? options.chunkBytes
    : DEFAULT_CHUNK_BYTES
  const nofollowFlag = fsConstants.O_NOFOLLOW ?? 0

  function unsafeTarget(path, reason, extra = {}) {
    return artifactError(
      ARTIFACT_ERROR.UNSAFE_TARGET,
      `产物存储目标是符号链接 / 非普通文件，拒绝操作（${reason}）：${path}`,
      { path, reason, ...extra },
    )
  }

  /** 存储根存在时必须是真实目录（不是 symlink）。 */
  async function assertSafeRoot() {
    let info
    try {
      info = await fsp.lstat(root)
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      throw error
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw unsafeTarget(root, info.isSymbolicLink() ? 'symlink-root' : 'not-directory')
    }
  }

  /**
   * 打开一个已存在的快照：先 lstat 拒绝 symlink / 非普通文件，再用 O_NOFOLLOW 打开，
   * 句柄 fstat 复核类型与大小（不跟随链接，也不对未知大小文件整读）。
   *
   * @returns {Promise<{handle:any, info:any}|null>} 不存在返回 null
   */
  async function openExisting(target) {
    let linkInfo
    try {
      linkInfo = await fsp.lstat(target)
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw error
    }
    if (linkInfo.isSymbolicLink()) throw unsafeTarget(target, 'symlink')
    if (!linkInfo.isFile()) throw unsafeTarget(target, 'not-regular-file')
    let handle
    try {
      handle = await fsp.open(target, fsConstants.O_RDONLY | nofollowFlag)
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      if (error && (error.code === 'ELOOP' || error.code === 'EMLINK')) throw unsafeTarget(target, 'symlink')
      throw error
    }
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw unsafeTarget(target, 'not-regular-file')
      if (info.size > maxBytes) {
        throw artifactError(ARTIFACT_ERROR.TOO_LARGE, `产物 ${info.size} 字节超过 ${maxBytes} 字节上限`, {
          path: target,
        })
      }
      return { handle, info }
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  /** 已存在的 `<root>/<sha256>` 必须重算 hash 与字节数都一致才可复用。 */
  async function contentMatches(target, sha256, bytes) {
    let opened
    try {
      opened = await openExisting(target)
    } catch (error) {
      // 既有目标大到不可读：按「内容不可信」处理，由调用方原子替换。
      if (error && error.code === ARTIFACT_ERROR.TOO_LARGE) return false
      throw error
    }
    if (opened === null) return false
    try {
      if (opened.info.size !== bytes) return false
      const content = await opened.handle.readFile()
      if (content.length !== bytes) return false
      return createHash('sha256').update(content).digest('hex') === sha256
    } finally {
      await opened.handle.close().catch(() => {})
    }
  }

  function pathOf(sha256) {
    return join(root, normalizeHash(sha256))
  }

  function has(sha256) {
    try {
      return Boolean(pathOf(sha256))
    } catch {
      return false
    }
  }

  /**
   * 写入一份已读入内存的字节；已存在（同 hash）不重写。
   * @param {Buffer} buffer
   * @returns {Promise<{sha256:string, bytes:number, contentRef:string}>}
   */
  async function put(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      throw artifactError(ARTIFACT_ERROR.INVALID, 'put(buffer) 需要 Buffer')
    }
    if (buffer.length > maxBytes) {
      throw artifactError(ARTIFACT_ERROR.TOO_LARGE, `产物 ${buffer.length} 字节超过 ${maxBytes} 字节上限`)
    }
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const target = join(root, sha256)
    await ensureDir(root)
    await assertSafeRoot()
    // 已存在不能只比 size：必须重算 hash 一致才复用（review-0137 W8）。
    if (await contentMatches(target, sha256, buffer.length)) {
      return { sha256, bytes: buffer.length, contentRef: contentRefFor(sha256) }
    }
    const tmp = join(root, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
    let renamed = false
    try {
      await fsp.writeFile(tmp, buffer, { mode: FILE_MODE })
      await fsp.chmod(tmp, FILE_MODE).catch(() => {})
      // 临时文件 + rename 原子替换损坏对象；rename 不会跟随目标 symlink。
      await fsp.rename(tmp, target)
      renamed = true
      return { sha256, bytes: buffer.length, contentRef: contentRefFor(sha256) }
    } catch (error) {
      throw artifactError(ARTIFACT_ERROR.CAPTURE_FAILED, `写入产物快照失败：${error?.message ?? error}`, {
        sha256,
        cause: error,
      })
    } finally {
      if (!renamed) await fsp.unlink(tmp).catch(() => {})
    }
  }

  /**
   * 安全读取一个文件并落成 hash 寻址快照。
   *
   * 与 node-finish 的文档校验同口径：拒绝符号链接、只接受普通文件、句柄前后 fstat
   * 一致、最多 maxBytes；读到的字节流写临时文件（边读边 hash），最后 rename 成
   * `<root>/<sha256>`。
   *
   * @param {string} filePath
   * @returns {Promise<{sha256:string, bytes:number, contentRef:string}>}
   */
  async function captureFile(filePath) {
    if (typeof filePath !== 'string' || filePath === '') {
      throw artifactError(ARTIFACT_ERROR.INVALID, 'captureFile 需要文件路径')
    }
    const absolute = resolve(filePath)
    let linkInfo
    try {
      linkInfo = await fsp.lstat(absolute)
    } catch (error) {
      throw artifactError(ARTIFACT_ERROR.CAPTURE_FAILED, `产物文件不存在或不可访问：${absolute}`, {
        path: absolute,
        reason: error?.code ?? 'lstat-failed',
      })
    }
    if (linkInfo.isSymbolicLink()) {
      throw artifactError(ARTIFACT_ERROR.CAPTURE_FAILED, `产物文件是符号链接，拒绝快照：${absolute}`, {
        path: absolute,
        reason: 'symlink',
      })
    }
    if (!linkInfo.isFile()) {
      throw artifactError(ARTIFACT_ERROR.CAPTURE_FAILED, `产物不是普通文件：${absolute}`, {
        path: absolute,
        reason: 'not-regular-file',
      })
    }
    if (linkInfo.size > maxBytes) {
      throw artifactError(ARTIFACT_ERROR.TOO_LARGE, `产物 ${linkInfo.size} 字节超过 ${maxBytes} 字节上限`, {
        path: absolute,
      })
    }

    await ensureDir(root)
    await assertSafeRoot()
    const tmp = join(root, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
    let handle = null
    let out = null
    try {
      handle = await fsp.open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      const before = await handle.stat()
      if (!before.isFile()) {
        throw artifactError(ARTIFACT_ERROR.CAPTURE_FAILED, `产物不是普通文件：${absolute}`, {
          path: absolute,
          reason: 'not-regular-file',
        })
      }
      if (before.size > maxBytes) {
        throw artifactError(ARTIFACT_ERROR.TOO_LARGE, `产物 ${before.size} 字节超过 ${maxBytes} 字节上限`, {
          path: absolute,
        })
      }
      out = await fsp.open(tmp, 'wx', FILE_MODE)
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, before.size || 1)))
      let position = 0
      let remaining = before.size
      let bytes = 0
      while (remaining > 0) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), position)
        if (bytesRead === 0) break
        const chunk = buffer.subarray(0, bytesRead)
        hash.update(chunk)
        await out.write(chunk)
        position += bytesRead
        remaining -= bytesRead
        bytes += bytesRead
      }
      if (remaining === 0) {
        const { bytesRead: grew } = await handle.read(buffer, 0, 1, position)
        if (grew > 0) {
          throw artifactError(ARTIFACT_ERROR.CAPTURE_FAILED, '产物在读取期间变大，拒绝快照', {
            path: absolute,
            reason: 'changed',
          })
        }
      }
      if (bytes !== before.size) {
        throw artifactError(ARTIFACT_ERROR.CAPTURE_FAILED, '读到的字节数与文件大小不符（读取期间被修改）', {
          path: absolute,
          reason: 'changed',
        })
      }
      const after = await handle.stat()
      if (!sameFileState(before, after)) {
        throw artifactError(ARTIFACT_ERROR.CAPTURE_FAILED, '产物在读取期间被修改，拒绝快照', {
          path: absolute,
          reason: 'changed',
        })
      }
      const sha256 = hash.digest('hex')
      // 权限落在我们自己新建的临时文件上（不 chmod 已存在目标，避免跟随 symlink）。
      await out.chmod(FILE_MODE).catch(() => {})
      await out.close()
      out = null
      const target = join(root, sha256)
      // 既有对象必须重算 hash 一致才复用；size 相同但内容不同 → 原子替换。
      const reuse = await contentMatches(target, sha256, bytes)
      if (reuse) await fsp.unlink(tmp).catch(() => {})
      else await fsp.rename(tmp, target)
      return { sha256, bytes, contentRef: contentRefFor(sha256) }
    } catch (error) {
      if (error && error.code && String(error.code).startsWith('ARTIFACT_')) throw error
      throw artifactError(ARTIFACT_ERROR.CAPTURE_FAILED, `产物快照失败：${error?.message ?? error}`, {
        path: absolute,
        cause: error,
      })
    } finally {
      if (out !== null) await out.close().catch(() => {})
      if (handle !== null) await handle.close().catch(() => {})
      await fsp.unlink(tmp).catch(() => {})
    }
  }

  /**
   * 按 hash 读回字节；不存在 / 内容被篡改都明确报错。
   * @param {string} sha256
   * @returns {Promise<Buffer>}
   */
  async function read(sha256) {
    const hash = normalizeHash(sha256)
    const target = join(root, hash)
    await assertSafeRoot()
    // 不跟随 symlink、先限制大小再读，最后仍以 hash 校验兜底。
    const opened = await openExisting(target)
    if (opened === null) {
      throw artifactError(ARTIFACT_ERROR.NOT_FOUND, `产物 ${sha256} 不存在`, { sha256 })
    }
    let content
    try {
      content = await opened.handle.readFile()
    } finally {
      await opened.handle.close().catch(() => {})
    }
    const actual = createHash('sha256').update(content).digest('hex')
    if (actual !== hash) {
      throw artifactError(ARTIFACT_ERROR.HASH_MISMATCH, `产物 ${sha256} 的内容 hash 不匹配（实际 ${actual}）`, {
        sha256,
        actual,
      })
    }
    return content
  }

  /** 读回并核对字节数（只做存在性与 hash 校验，不返回正文）。 */
  async function verify(sha256, expectedBytes) {
    const content = await read(sha256)
    if (Number.isSafeInteger(expectedBytes) && expectedBytes >= 0 && content.length !== expectedBytes) {
      throw artifactError(
        ARTIFACT_ERROR.HASH_MISMATCH,
        `产物 ${sha256} 字节数不匹配：期望 ${expectedBytes}，实际 ${content.length}`,
        { sha256, expectedBytes, actualBytes: content.length },
      )
    }
    return { sha256, bytes: content.length }
  }

  return {
    root,
    maxBytes,
    pathOf,
    has,
    put,
    captureFile,
    read,
    verify,
    contentRefFor,
    hashFromContentRef,
  }
}

/** 校验 / 归一一个 artifact 引用（instance-store 与 API 共用）。 */
export function normalizeArtifactRef(raw) {
  if (!isPlainObject(raw)) return null
  if (typeof raw.path !== 'string' || raw.path === '' || raw.path.length > 1024) return null
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.toLowerCase() : ''
  if (!ARTIFACT_HASH_PATTERN.test(sha256)) return null
  const normalized = {
    ...raw,
    sha256,
  }
  for (const key of ['executionId', 'workspaceId']) {
    if (typeof raw[key] !== 'string' || raw[key] === '') delete normalized[key]
  }
  const refHash = hashFromContentRef(raw.contentRef)
  if (refHash === null) delete normalized.contentRef
  else normalized.contentRef = contentRefFor(refHash)
  return normalized
}

/** 防路径穿越：确认 contentRef 只指向 artifact 根下的 64 位 hash 文件。 */
export function artifactPathUnder(root, contentRef) {
  const hash = hashFromContentRef(contentRef)
  if (hash === null) return null
  const base = resolve(root)
  const target = resolve(base, hash)
  const rel = relative(base, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return target
}
