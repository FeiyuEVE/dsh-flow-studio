/**
 * 流程定义域存储：`$DSH_HOME/flow-studio/definitions/<definitionId>/`
 *
 * 布局（0.13 计划 §2）：
 *   meta.json         定义元数据（可变，原子写）
 *   <version>.bpmn    BPMN 2.0 XML 正本，**不可变**：同一 (id, version) 一旦落盘，
 *                     只允许写入内容完全相同的字节（hash 相同即幂等成功）
 *   .lock             definitions 根上唯一的一把跨进程粗粒度锁
 *   .deleted/         被删除定义的归档（list/read 都不再看见，内容留在盘上）
 *
 * 边界：
 *   - 纯 fs，不碰网络、不认识 BPMN 语法（XML 只是一段被哈希的字节）；
 *   - 目录 0700、文件 0600；
 *   - JSON 先收敛形状再写，坏形状抛结构化错误，绝不写半截；
 *   - 不可变性只在锁内判定：不同 hash 写同一版本 → {@link DefinitionError}(409)。
 *
 * 与实例域存储（`src/instance-store.js`）互不读写：本模块只管 `definitions/`，
 * 实例域只管 `instances/`，各自的目录与 id 空间不共享。
 *
 * @module @feiyueve/dsh-flow-studio/definition-store
 */

import { Buffer } from 'node:buffer'
import { createHash, randomInt } from 'node:crypto'
import {
  chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile,
} from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { checkRunId, resolveHome } from './storage-contract.js'

/** 与 run / flow 存储同口径。 */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

const META_FILE = 'meta.json'
const LOCK_FILE = '.lock'
const DELETED_DIR = '.deleted'

/** 单份 BPMN XML 上限：真实流程远小于此，超限说明调用方传错了东西。 */
export const MAX_DEFINITION_XML_BYTES = 5 * 1024 * 1024
/** meta.json 上限：版本条目是 4 个短字段，64 KiB 足够放上千个版本。 */
export const MAX_DEFINITION_META_BYTES = 64 * 1024
/** tags 的条数与单条长度上限（与流程模型同口径的量级）。 */
const MAX_TAGS = 20
const MAX_TAG_CHARS = 64
const MAX_NAME_CHARS = 200
const MAX_DESCRIPTION_CHARS = 2000
const MAX_OWNER_CHARS = 128

/** 锁参数：临界区只有本地文件读写（毫秒级），10s ttl / 15s 等待足够宽松。 */
const LOCK_TTL_MS = 10 * 1000
const LOCK_WAIT_MS = 15 * 1000

const HASH_PATTERN = /^[0-9a-f]{64}$/
/** `patch` 里允许出现的键；拼错的字段会 400 而不是被静默忽略。 */
const META_PATCH_KEYS = new Set(['version', 'name', 'description', 'tags', 'owner'])

let tmpCounter = 0

const sleep = ms => new Promise(resolveSleep => { setTimeout(resolveSleep, ms) })

/** 带 HTTP 语义的错误：调用方按 status / code / reason 分流，绝不猜字符串。 */
export class DefinitionError extends Error {
  /**
   * @param {number} status HTTP 状态码（400 / 404 / 409 / 500）
   * @param {string} code 稳定业务码（如 `DEFINITION_VERSION_IMMUTABLE`）
   * @param {string} reason 中文可读原因
   * @param {object} [extra] 附加诊断字段（expectedHash / actualHash / version …）
   */
  constructor(status, code, reason, extra = {}) {
    super(reason)
    this.name = 'DefinitionError'
    this.status = status
    this.code = code
    this.reason = reason
    Object.assign(this, extra)
  }

  toPayload() {
    const payload = { ok: false, code: this.code, error: this.reason }
    if (this.field) payload.field = this.field
    if (this.version !== undefined) payload.version = this.version
    if (this.expectedHash) payload.expectedHash = this.expectedHash
    if (this.actualHash) payload.actualHash = this.actualHash
    if (this.references) payload.references = this.references
    return payload
  }
}

/** definitions 根目录；每次调用重新解析，便于测试注入 DSH_HOME。 */
export function definitionsDir(home) {
  return join(home || resolveHome(process.env), 'flow-studio', 'definitions')
}

/** 定义 id 与 runId 同字符集（也进路径，拒绝 `.` / `..` / 点开头）。 */
function requireId(value, field = 'definitionId') {
  const checked = checkRunId(value)
  if (!checked) {
    throw new DefinitionError(
      400,
      'DEFINITION_INVALID_ID',
      `${field} 只能由字母 / 数字 / 点 / 下划线 / 连字符组成，不以点开头，且不超过 64 字符`,
      { field },
    )
  }
  return checked
}

/** 版本号：接受安全正整数或纯数字字符串（HTTP 路径参数都是字符串）。 */
function requireVersion(value, field = 'version') {
  const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw new DefinitionError(400, 'DEFINITION_INVALID_VERSION', `${field} 必须是 ≥1 的整数`, { field })
  }
  return numeric
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && value.length >= 20 && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 解析根目录：显式 definitionsRoot 优先，否则 `$DSH_HOME` 派生。 */
function definitionsRootOf(options = {}) {
  const explicit = options && typeof options.definitionsRoot === 'string' ? options.definitionsRoot.trim() : ''
  if (explicit.length > 0) return resolve(explicit)
  const home = options && typeof options.home === 'string' && options.home.trim().length > 0
    ? options.home.trim()
    : resolveHome(process.env)
  return definitionsDir(home)
}

/** 实例根目录：删除定义时要检查「有没有实例引用它」。 */
function instancesRootOf(options = {}) {
  const explicit = options && typeof options.instancesRoot === 'string' ? options.instancesRoot.trim() : ''
  if (explicit.length > 0) return resolve(explicit)
  const home = options && typeof options.home === 'string' && options.home.trim().length > 0
    ? options.home.trim()
    : resolveHome(process.env)
  return join(home, 'flow-studio', 'instances')
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  // 目录已存在时 mkdir 不会改 mode，显式 chmod 一次，保证与 run 目录同口径。
  await chmod(dir, DIR_MODE).catch(error => {
    if (!error || error.code !== 'ENOENT') throw error
  })
}

/** 原子写文本：临时文件 + rename，任何一步失败都清掉临时文件；文件 0600。 */
async function writeTextAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
  let renamed = false
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: FILE_MODE })
    await rename(tmp, path)
    renamed = true
    await chmod(path, FILE_MODE).catch(() => {})
    return path
  } finally {
    if (!renamed) await unlink(tmp).catch(() => {})
  }
}

async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** 读一个小 JSON 文件：不存在返回 `{ kind: 'missing' }`，坏 JSON / 超限抛结构化错误。 */
async function readJson(path, maxBytes = MAX_DEFINITION_META_BYTES) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', `${basename(path)} 超过 ${maxBytes} 字节上限`)
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) }
  } catch {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', `${basename(path)} 不是合法 JSON`)
  }
}

async function readTextOrNull(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * 跨进程互斥（本模块自有的最小实现）：
 * `O_EXCL` 原子创建 + nonce 复核 + 过期锁「rename 接管」。
 *
 * 用 rename 而不是「读 → unlink」做接管：同一时刻只有一个进程能 rename 成功，
 * 另一个会拿到 ENOENT 并回去重试，避免两个进程都以为自己清掉了同一把旧锁。
 *
 * 调用方必须先保证目录存在；这个 helper **不会**顺手把目录建回来，
 * 否则对已删除定义 / 实例的写操作会「复活」一个空目录。
 */
async function withFileLock(dir, task, options = {}) {
  const path = join(dir, options.name || LOCK_FILE)
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : LOCK_TTL_MS
  const waitMs = Number.isSafeInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : LOCK_WAIT_MS
  const conflictCode = options.conflictCode || 'DEFINITION_LOCK_TIMEOUT'
  const conflictReason = options.conflictReason || '另一个进程正在写定义目录，请稍后重试'
  const deadline = Date.now() + waitMs
  const nonce = `${process.pid}-${Date.now().toString(36)}-${tmpCounter++}-${Math.random().toString(36).slice(2, 8)}`

  const createExclusive = async () => {
    let handle
    try {
      handle = await open(path, 'wx', FILE_MODE)
    } catch (error) {
      if (error && error.code === 'EEXIST') return false
      throw error
    }
    try {
      await handle.writeFile(`${nonce}\n`, 'utf8')
      await chmod(path, FILE_MODE).catch(() => {})
      return true
    } catch (error) {
      await unlink(path).catch(() => {})
      throw error
    } finally {
      await handle.close().catch(() => {})
    }
  }

  const clearStale = async () => {
    let info
    try {
      info = await stat(path)
    } catch (error) {
      if (error && error.code === 'ENOENT') return true
      throw error
    }
    if (Date.now() - info.mtimeMs <= ttlMs) return false
    const junk = `${path}.stale-${process.pid}-${tmpCounter++}`
    try {
      await rename(path, junk)
    } catch (error) {
      if (error && error.code === 'ENOENT') return true
      throw error
    }
    await unlink(junk).catch(() => {})
    return true
  }

  for (;;) {
    if (await createExclusive()) {
      // 建好后再复核 nonce：正常路径下没人能接管一把未过期的锁，这一步只是兜底。
      const holder = await readFile(path, 'utf8').catch(() => null)
      if (holder !== null && holder.trim() === nonce) {
        try {
          return await task()
        } finally {
          const current = await readFile(path, 'utf8').catch(() => null)
          if (current !== null && current.trim() === nonce) await unlink(path).catch(() => {})
        }
      }
    } else if (await clearStale()) {
      continue
    }
    if (Date.now() > deadline) {
      throw new DefinitionError(409, conflictCode, conflictReason)
    }
    await sleep(8)
  }
}

/** 单个版本条目的形状收敛；任何字段坏掉都说明 meta.json 被手改坏 / 写坏了。 */
function normalizeVersionEntry(raw) {
  if (!isPlainObject(raw)) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', 'meta.json 的 versions 条目必须是对象')
  }
  if (!Number.isSafeInteger(raw.version) || raw.version < 1) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', 'meta.json 的 versions[].version 必须是 ≥1 的整数')
  }
  if (typeof raw.hash !== 'string' || !HASH_PATTERN.test(raw.hash)) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', 'meta.json 的 versions[].hash 必须是 64 位小写十六进制')
  }
  if (!isIsoTimestamp(raw.createdAt)) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', 'meta.json 的 versions[].createdAt 必须是 ISO 时间')
  }
  if (!Number.isSafeInteger(raw.bytes) || raw.bytes < 0) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', 'meta.json 的 versions[].bytes 必须是非负整数')
  }
  return { version: raw.version, hash: raw.hash, createdAt: raw.createdAt, bytes: raw.bytes }
}

function normalizeTags(raw) {
  if (!Array.isArray(raw)) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', 'meta.json 的 tags 必须是数组')
  }
  if (raw.length > MAX_TAGS) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', `meta.json 的 tags 不能超过 ${MAX_TAGS} 条`)
  }
  const tags = []
  for (const value of raw) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TAG_CHARS) {
      throw new DefinitionError(500, 'DEFINITION_CORRUPT', `meta.json 的 tags 单条必须是 1–${MAX_TAG_CHARS} 字符的字符串`)
    }
    if (!tags.includes(value)) tags.push(value)
  }
  return tags
}

/** 磁盘上的 meta.json → 收敛后的对象（附加 latestVersion / latestHash 两个派生字段）。 */
function normalizeMeta(raw, id) {
  if (!isPlainObject(raw)) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', 'meta.json 必须是 JSON 对象')
  }
  if (raw.id !== undefined && raw.id !== id) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', 'meta.json 的 id 与目录名不一致')
  }
  if (typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > MAX_NAME_CHARS) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', `meta.json 的 name 必须是 1–${MAX_NAME_CHARS} 字符的字符串`)
  }
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > MAX_DESCRIPTION_CHARS)) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', `meta.json 的 description 必须是不超过 ${MAX_DESCRIPTION_CHARS} 字符的字符串`)
  }
  if (raw.owner !== undefined && raw.owner !== null
    && (typeof raw.owner !== 'string' || raw.owner.length > MAX_OWNER_CHARS)) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', `meta.json 的 owner 必须是不超过 ${MAX_OWNER_CHARS} 字符的字符串或 null`)
  }
  if (!isIsoTimestamp(raw.createdAt) || !isIsoTimestamp(raw.updatedAt)) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', 'meta.json 的 createdAt / updatedAt 必须是 ISO 时间')
  }
  if (!Array.isArray(raw.versions)) {
    throw new DefinitionError(500, 'DEFINITION_CORRUPT', 'meta.json 的 versions 必须是数组')
  }
  const versions = raw.versions.map(normalizeVersionEntry)
  const seen = new Set()
  for (const entry of versions) {
    if (seen.has(entry.version)) {
      throw new DefinitionError(500, 'DEFINITION_CORRUPT', `meta.json 里版本 ${entry.version} 重复出现`)
    }
    seen.add(entry.version)
  }
  versions.sort((a, b) => a.version - b.version)
  const latest = versions.length > 0 ? versions[versions.length - 1] : null
  return {
    id,
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    owner: typeof raw.owner === 'string' ? raw.owner : null,
    tags: normalizeTags(raw.tags === undefined ? [] : raw.tags),
    versions,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    latestVersion: latest ? latest.version : null,
    latestHash: latest ? latest.hash : null,
  }
}

/** 落盘形状：派生字段（latestVersion / latestHash）不写进 meta.json，避免第二个真相源。 */
function toStoredMeta(meta) {
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    owner: meta.owner,
    tags: meta.tags,
    versions: meta.versions,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

/** 收敛调用方给的 meta 补丁；未知字段 400（拼错不能被静默吞掉）。 */
function normalizeMetaPatch(meta) {
  if (meta === undefined || meta === null) return {}
  if (!isPlainObject(meta)) {
    throw new DefinitionError(400, 'DEFINITION_META_INVALID', 'meta 必须是对象', { field: 'meta' })
  }
  for (const key of Object.keys(meta)) {
    if (!META_PATCH_KEYS.has(key)) {
      throw new DefinitionError(400, 'DEFINITION_META_INVALID', `meta.${key} 不是已知字段`, { field: `meta.${key}` })
    }
  }
  const patch = {}
  if (meta.version !== undefined && meta.version !== null) {
    patch.version = requireVersion(meta.version, 'meta.version')
  }
  if (meta.name !== undefined) {
    if (typeof meta.name !== 'string') {
      throw new DefinitionError(400, 'DEFINITION_META_INVALID', 'meta.name 必须是字符串', { field: 'meta.name' })
    }
    const name = meta.name.trim()
    if (name.length === 0 || name.length > MAX_NAME_CHARS) {
      throw new DefinitionError(400, 'DEFINITION_META_INVALID', `meta.name 必须是 1–${MAX_NAME_CHARS} 字符`, { field: 'meta.name' })
    }
    patch.name = name
  }
  if (meta.description !== undefined) {
    if (typeof meta.description !== 'string' || meta.description.length > MAX_DESCRIPTION_CHARS) {
      throw new DefinitionError(400, 'DEFINITION_META_INVALID', `meta.description 必须是不超过 ${MAX_DESCRIPTION_CHARS} 字符的字符串`, { field: 'meta.description' })
    }
    patch.description = meta.description
  }
  if (meta.owner !== undefined) {
    if (meta.owner !== null && (typeof meta.owner !== 'string' || meta.owner.length > MAX_OWNER_CHARS)) {
      throw new DefinitionError(400, 'DEFINITION_META_INVALID', `meta.owner 必须是不超过 ${MAX_OWNER_CHARS} 字符的字符串或 null`, { field: 'meta.owner' })
    }
    patch.owner = meta.owner
  }
  if (meta.tags !== undefined) {
    if (!Array.isArray(meta.tags) || meta.tags.length > MAX_TAGS) {
      throw new DefinitionError(400, 'DEFINITION_META_INVALID', `meta.tags 必须是不超过 ${MAX_TAGS} 条的数组`, { field: 'meta.tags' })
    }
    const tags = []
    for (const value of meta.tags) {
      if (typeof value !== 'string') {
        throw new DefinitionError(400, 'DEFINITION_META_INVALID', 'meta.tags 的每一项必须是字符串', { field: 'meta.tags' })
      }
      const tag = value.trim()
      if (tag.length === 0 || tag.length > MAX_TAG_CHARS) {
        throw new DefinitionError(400, 'DEFINITION_META_INVALID', `meta.tags 单条必须是 1–${MAX_TAG_CHARS} 字符`, { field: 'meta.tags' })
      }
      if (!tags.includes(tag)) tags.push(tag)
    }
    patch.tags = tags
  }
  return patch
}

function normalizeXml(xml) {
  if (typeof xml !== 'string') {
    throw new DefinitionError(400, 'DEFINITION_XML_INVALID', '定义正文必须是 BPMN XML 字符串', { field: 'xml' })
  }
  const bytes = Buffer.byteLength(xml, 'utf8')
  if (bytes === 0) {
    throw new DefinitionError(400, 'DEFINITION_XML_INVALID', '定义正文不能为空', { field: 'xml' })
  }
  if (bytes > MAX_DEFINITION_XML_BYTES) {
    throw new DefinitionError(400, 'DEFINITION_XML_INVALID', `定义正文超过 ${MAX_DEFINITION_XML_BYTES} 字节上限`, { field: 'xml' })
  }
  return { text: xml, bytes }
}

/** 读 meta.json（锁内用）：不存在返回 null，坏形状抛 DEFINITION_CORRUPT。 */
async function readMetaUnlocked(dir, id) {
  const loaded = await readJson(join(dir, META_FILE))
  if (loaded.kind === 'missing') return null
  return normalizeMeta(loaded.value, id)
}

/**
 * 目录里已存在的 `<n>.bpmn` 版本号（只用于版本号分配，不作为真相源）。
 * 写入中途被杀会留下「有文件没 meta」的孤儿文件，分配版本号时必须绕开它。
 */
async function scanVersionFiles(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const versions = []
  for (const name of names) {
    const match = /^(\d+)\.bpmn$/.exec(name)
    if (!match) continue
    const version = Number(match[1])
    if (Number.isSafeInteger(version) && version >= 1) versions.push(version)
  }
  return versions.sort((a, b) => a - b)
}

/** 组装下一个 meta 对象（含新版本条目）；调用方保证 passed 条目还没出现过。 */
function buildMeta(existing, patch, entry, id, now) {
  const versions = (existing ? existing.versions : []).filter(item => item.version !== entry.version)
  versions.push(entry)
  versions.sort((a, b) => a.version - b.version)
  return normalizeMeta({
    id,
    name: patch.name !== undefined ? patch.name : (existing ? existing.name : id),
    description: patch.description !== undefined ? patch.description : (existing ? existing.description : ''),
    owner: patch.owner !== undefined ? patch.owner : (existing ? existing.owner : null),
    tags: patch.tags !== undefined ? patch.tags : (existing ? existing.tags : []),
    versions,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  }, id)
}

/**
 * 列定义摘要（按 updatedAt 倒序）。
 *
 * 返回的是摘要而不是整份 meta：列表只需要能画出来的字段，版本正本由
 * {@link readDefinition} / {@link readDefinitionVersion} 单独读。
 * 坏定义跳过（不因一个手改坏的文件让整张列表 500）。
 *
 * @param {{ home?: string, definitionsRoot?: string }} [options]
 * @returns {Promise<Array<{id: string, name: string, description: string, tags: string[],
 *   createdAt: string, updatedAt: string, versionCount: number, latestVersion: number|null}>>}
 */
export async function listDefinitions(options = {}) {
  const root = definitionsRootOf(options)
  await ensureDir(root)
  let names = []
  try {
    names = await readdir(root)
  } catch {
    names = []
  }
  const definitions = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (!checkRunId(name)) continue
    try {
      const meta = await readMetaUnlocked(join(root, name), name)
      if (!meta) continue
      definitions.push({
        id: meta.id,
        name: meta.name,
        description: meta.description,
        tags: meta.tags,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        versionCount: meta.versions.length,
        latestVersion: meta.latestVersion,
      })
    } catch {
      // 坏定义跳过：一份手改坏的 meta.json 不该让整个列表 500。
    }
  }
  definitions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return definitions
}

/**
 * 读一份定义的元数据（含 versions 与派生的 latestVersion / latestHash）。
 *
 * @param {string} id
 * @param {{ home?: string, definitionsRoot?: string }} [options]
 * @returns {Promise<object | null>} 不存在返回 null；坏 JSON / 坏形状抛 DEFINITION_CORRUPT
 */
export async function readDefinition(id, options = {}) {
  const defId = requireId(id)
  const dir = resolve(definitionsRootOf(options), defId)
  let info
  try {
    info = await stat(dir)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  if (!info.isDirectory()) return null
  const meta = await readMetaUnlocked(dir, defId)
  return meta
}

/**
 * 读某个版本的 XML 正本（同时校验 hash 与 meta 记录一致）。
 *
 * @param {string} id
 * @param {number|string} version
 * @param {{ home?: string, definitionsRoot?: string }} [options]
 * @returns {Promise<{id: string, version: number, hash: string, createdAt: string,
 *   bytes: number, xml: string} | null>} 定义或版本不存在返回 null
 */
export async function readDefinitionVersion(id, version, options = {}) {
  const defId = requireId(id)
  const wanted = requireVersion(version)
  const dir = resolve(definitionsRootOf(options), defId)
  const meta = await readDefinition(defId, options)
  if (!meta) return null
  const entry = meta.versions.find(item => item.version === wanted)
  if (!entry) return null
  const xml = await readTextOrNull(join(dir, `${wanted}.bpmn`))
  if (xml === null) {
    throw new DefinitionError(
      500,
      'DEFINITION_CORRUPT',
      `meta.json 记录了 v${wanted}，但 ${wanted}.bpmn 不存在`,
      { version: wanted },
    )
  }
  const actual = sha256(xml)
  if (actual !== entry.hash) {
    throw new DefinitionError(
      500,
      'DEFINITION_CORRUPT',
      `v${wanted}.bpmn 的内容与 meta.json 记录的 hash 不一致（文件被改过）`,
      { version: wanted, expectedHash: entry.hash, actualHash: actual },
    )
  }
  return {
    id: defId,
    version: wanted,
    hash: entry.hash,
    createdAt: entry.createdAt,
    bytes: Buffer.byteLength(xml, 'utf8'),
    xml,
  }
}

/**
 * 写入一个新版本（不可变）。语义：
 *
 * - **幂等**：同一版本 + 同一 hash → 成功返回 `created: false`，meta 一个字节都不动；
 * - **不可变**：同一版本 + 不同 hash → 409 `DEFINITION_VERSION_IMMUTABLE`，**不覆盖**；
 * - 版本号：`meta.version` 显式给了就用它（允许出现空洞）；否则取
 *   `max(meta 里最大版本, 磁盘上最大 <n>.bpmn 文件名) + 1`；
 * - 先写 XML 再写 meta：中途被杀最多留下「孤儿版本文件」，下次同内容写入会把它认领并补进 meta；
 *   绝不出现「meta 指向一个不存在的文件」（下次读会明确报 CORRUPT 而不是静默少一版）。
 *
 * @param {string} id
 * @param {string} xml BPMN 2.0 XML 正本
 * @param {{version?: number, name?: string, description?: string, tags?: string[], owner?: string|null}} [meta]
 * @param {{ home?: string, definitionsRoot?: string }} [options]
 * @returns {Promise<{id: string, version: number, hash: string, created: boolean,
 *   bytes: number, meta: object}>}
 */
export async function saveDefinitionVersion(id, xml, meta = {}, options = {}) {
  const defId = requireId(id)
  const { text, bytes } = normalizeXml(xml)
  const patch = normalizeMetaPatch(meta)
  const root = definitionsRootOf(options)
  const hash = sha256(text)
  const now = new Date().toISOString()

  await ensureDir(root)
  const dir = resolve(root, defId)

  return withFileLock(root, async () => {
    const existing = await readMetaUnlocked(dir, defId)
    const versionFiles = await scanVersionFiles(dir)
    if (existing === null && versionFiles.length > 0) {
      throw new DefinitionError(
        500,
        'DEFINITION_CORRUPT',
        'definition 目录里有版本文件但缺少 meta.json，拒绝继续写入（避免把已有版本当成不存在）',
      )
    }
    const knownMax = Math.max(
      0,
      ...(existing ? existing.versions.map(item => item.version) : []),
      ...versionFiles,
    )
    const version = patch.version !== undefined ? patch.version : knownMax + 1
    const file = join(dir, `${version}.bpmn`)
    const recorded = existing ? existing.versions.find(item => item.version === version) : null

    // ① meta 已记录这个版本：只允许相同 hash（幂等）；文件丢了就按记录的内容补回去。
    if (recorded) {
      if (recorded.hash !== hash) {
        throw new DefinitionError(
          409,
          'DEFINITION_VERSION_IMMUTABLE',
          `定义 ${defId} 的 v${version} 已存在且内容不同，版本一经写入不可修改`,
          { version, expectedHash: recorded.hash, actualHash: hash, field: 'version' },
        )
      }
      const onDisk = await readTextOrNull(file)
      if (onDisk === null) {
        await ensureDir(dir)
        await writeTextAtomic(file, text)
      } else if (sha256(onDisk) !== recorded.hash) {
        throw new DefinitionError(
          500,
          'DEFINITION_CORRUPT',
          `v${version}.bpmn 的内容与 meta.json 记录的 hash 不一致（文件被改过）`,
          { version, expectedHash: recorded.hash, actualHash: sha256(onDisk) },
        )
      }
      return { id: defId, version, hash, created: false, bytes: recorded.bytes, meta: existing }
    }

    // ② 磁盘上已有同版本文件、meta 没记录（上次写入在中途被杀）：内容一致就认领，不一致就拒绝。
    const orphan = await readTextOrNull(file)
    if (orphan !== null) {
      const orphanHash = sha256(orphan)
      if (orphanHash !== hash) {
        throw new DefinitionError(
          409,
          'DEFINITION_VERSION_IMMUTABLE',
          `定义 ${defId} 的 v${version} 已存在于磁盘且内容不同，版本一经写入不可修改`,
          { version, expectedHash: orphanHash, actualHash: hash, field: 'version' },
        )
      }
      await ensureDir(dir)
      const info = await stat(file).catch(() => null)
      const createdAt = info ? info.mtime.toISOString() : now
      const healed = buildMeta(existing, patch, {
        version, hash, createdAt, bytes: Buffer.byteLength(orphan, 'utf8'),
      }, defId, now)
      await writeJsonAtomic(join(dir, META_FILE), toStoredMeta(healed))
      return {
        id: defId,
        version,
        hash,
        created: false,
        bytes: Buffer.byteLength(orphan, 'utf8'),
        meta: healed,
      }
    }

    // ③ 真正写入：先 XML（不可变正本），再 meta。
    await ensureDir(dir)
    await writeTextAtomic(file, text)
    const next = buildMeta(existing, patch, { version, hash, createdAt: now, bytes }, defId, now)
    await writeJsonAtomic(join(dir, META_FILE), toStoredMeta(next))
    return { id: defId, version, hash, created: true, bytes, meta: next }
  })
}

/**
 * 删除一份定义（默认拒绝删除被实例引用的定义）。
 *
 * 删除不是 `rm -rf`：目录被**移进** `<definitionsRoot>/.deleted/`，内容留在盘上，
 * 既能人工恢复，也不影响已钉住 hash 的实例（实例还有自己的 `definition.bpmn` 快照）。
 *
 * @param {string} id
 * @param {{ force?: boolean, home?: string, definitionsRoot?: string, instancesRoot?: string }} [options]
 * @returns {Promise<{id: string, deleted: boolean, forced: boolean, archivedTo: string}>}
 */
export async function deleteDefinition(id, options = {}) {
  const defId = requireId(id)
  const force = options.force === true
  const root = definitionsRootOf(options)
  const dir = resolve(root, defId)

  // 根目录都不存在时 withFileLock 建锁会 ENOENT：先归成明确的 404。
  try {
    await stat(root)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new DefinitionError(404, 'DEFINITION_NOT_FOUND', `定义 ${defId} 不存在`)
    }
    throw error
  }

  return withFileLock(root, async () => {
    let info
    try {
      info = await stat(dir)
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new DefinitionError(404, 'DEFINITION_NOT_FOUND', `定义 ${defId} 不存在`)
      }
      throw error
    }
    if (!info.isDirectory()) {
      throw new DefinitionError(404, 'DEFINITION_NOT_FOUND', `定义 ${defId} 不存在`)
    }
    if (!force) {
      const references = await findReferencingInstances(defId, instancesRootOf(options))
      if (references.length > 0) {
        throw new DefinitionError(
          409,
          'DEFINITION_IN_USE',
          `定义 ${defId} 仍被 ${references.length} 个实例引用，不能删除（确认要删就用 force）`,
          { references },
        )
      }
    }
    const archiveRoot = join(root, DELETED_DIR)
    await ensureDir(archiveRoot)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let target = join(archiveRoot, `${defId}-${stamp}`)
    if (await stat(target).then(() => true, () => false)) {
      target = join(archiveRoot, `${defId}-${stamp}-${randomInt(1e6).toString(36)}`)
    }
    await rename(dir, target)
    return {
      id: defId,
      deleted: true,
      forced: force,
      archivedTo: `${DELETED_DIR}/${target.slice(archiveRoot.length + 1)}`,
    }
  })
}

/** 扫描实例域，找出钉住某个定义的实例 id（有界：最多返回 100 条）。 */
async function findReferencingInstances(definitionId, instancesRoot) {
  let names
  try {
    names = await readdir(instancesRoot)
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const references = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (!checkRunId(name)) continue
    const loaded = await readJson(join(instancesRoot, name, 'instance.json'))
    if (loaded.kind !== 'ok' || !isPlainObject(loaded.value)) continue
    if (loaded.value.definitionId !== definitionId) continue
    references.push(name)
    if (references.length >= 100) break
  }
  return references
}
