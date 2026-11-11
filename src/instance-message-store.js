/**
 * 实例域收件箱存储（0.13.10 D）：消息幂等、正文落盘、投递记录与 outbox。
 *
 * 落盘布局（`<instancesRoot>/<instanceId>/inbox/`）：
 * ```
 * inbox/messages.jsonl          入站消息记录（追加写，同一 messageId 以最后一条为准）
 * inbox/replies.jsonl           回复 outbox（同上，replyId 为键）
 * inbox/bodies/<id>.<sha>.txt   超过内联阈值的正文（先完整落盘，再写记录）
 * inbox/*.jsonl.torn            崩溃遗留半行的旁路存档（追加前自动隔离）
 * inbox/.lock                   跨进程互斥（复用 instance-resources 的锁）
 * ```
 *
 * 设计口径（计划 D「持久化、体积和回复」）：
 *   - 小消息内联（≤ 4 KiB）；超过则先落盘再受理，记录里只留
 *     `bodyRef:{path, sha256, bytes}`（path 相对实例目录）；
 *   - 总上限 1 MiB（UTF-8 字节）：先算字节再决定落盘，超限直接 413，**不写半文件**；
 *   - 同一实例下 messageId 相同：内容指纹相同返回原记录，不同返回 409；
 *   - 追加写先 `fsync` 再返回；记录写失败时删掉本次新建的正文文件；
 *   - 读路径无缓存，重启后直接重放 journal —— queued / outbox 天然可恢复。
 *
 * 本模块只管持久化，不判断实例状态、不投递、不决定回复目标。
 *
 * @module @feiyueve/dsh-flow-studio/instance-message-store
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { withResourceLock } from './instance-resources.js'

/** 内联正文上限（含 4 KiB）。 */
export const INBOX_INLINE_BODY_LIMIT = 4 * 1024
/** 单条正文硬上限（1 MiB，UTF-8 字节）。 */
export const INBOX_MAX_BODY_BYTES = 1024 * 1024
/** 记录 schema 版本。 */
export const INBOX_MESSAGE_RECORD_VERSION = 1
export const INBOX_REPLY_RECORD_VERSION = 1
/** 预览摘要上限（字符）。 */
export const INBOX_PREVIEW_CHARS = 200
/** 单页消息上限。 */
export const INBOX_MAX_PAGE_SIZE = 100
export const INBOX_DEFAULT_PAGE_SIZE = 50
/** 回复投递权占用超过这个时长视为崩溃遗留，可被下一次 dispatch 接管。 */
export const INBOX_REPLY_DISPATCH_TTL_MS = 120_000

/** 入站消息状态。 */
export const INBOX_MESSAGE_STATUS = Object.freeze({
  QUEUED: 'queued',
  INJECTED: 'injected',
  RESUMED: 'resumed',
  DELIVERED: 'delivered',
  FAILED: 'failed',
})

/** 回复 outbox 状态。 */
export const INBOX_REPLY_STATUS = Object.freeze({
  QUEUED: 'queued',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  SKIPPED: 'skipped',
})

/** 对外错误码（路由 / 工具按这些字符串分流）。 */
export const INBOX_STORE_ERROR = Object.freeze({
  INVALID: 'MESSAGE_INVALID',
  BODY_TOO_LARGE: 'MESSAGE_BODY_TOO_LARGE',
  ID_CONFLICT: 'MESSAGE_ID_CONFLICT',
  NOT_FOUND: 'MESSAGE_NOT_FOUND',
  BODY_CORRUPT: 'MESSAGE_BODY_CORRUPT',
  WRITE_FAILED: 'MESSAGE_WRITE_FAILED',
})

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** messageId / replyId：进 URL、进文件名，只允许安全字符。 */
export const INBOX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const FILE_MODE = 0o600
const DIR_MODE = 0o700

let tmpCounter = 0

/** 带 code 的存储错误。 */
export class InstanceMessageStoreError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'InstanceMessageStoreError'
    this.code = code
    Object.assign(this, extra)
  }

  toPayload() {
    return { ok: false, code: this.code, error: this.message }
  }
}

function fail(code, message, extra) {
  return new InstanceMessageStoreError(code, message, extra)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireInstanceId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!INSTANCE_ID_PATTERN.test(text)) {
    throw fail(INBOX_STORE_ERROR.INVALID, `instanceId 非法：${String(value)}`, { field: 'instanceId' })
  }
  return text
}

function requireId(value, field) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!INBOX_ID_PATTERN.test(text)) {
    throw fail(
      INBOX_STORE_ERROR.INVALID,
      `${field} 必须是 1–128 个安全字符（字母/数字开头，只含字母、数字、点、下划线、冒号、连字符）`,
      { field },
    )
  }
  return text
}

function bodyBytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

function previewOf(text) {
  const chars = [...text]
  if (chars.length <= INBOX_PREVIEW_CHARS) return text
  return `${chars.slice(0, INBOX_PREVIEW_CHARS).join('')}…`
}

/** 稳定 JSON（键排序）：内容指纹与幂等键都从它算。 */
function stableJson(value) {
  const walk = item => {
    if (Array.isArray(item)) return `[${item.map(walk).join(',')}]`
    if (isPlainObject(item)) {
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${walk(item[key])}`).join(',')}}`
    }
    return JSON.stringify(item === undefined ? null : item)
  }
  return walk(value)
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 消息幂等键：target + 正文 + 回复目标。HTTP 路由与工具共用同一口径。 */
export function messageContentHash({ target, text, replyTargetId }) {
  return sha256(stableJson({
    target: isPlainObject(target) ? target : {},
    text: typeof text === 'string' ? text : '',
    replyTargetId: replyTargetId === undefined || replyTargetId === null || replyTargetId === '' ? null : replyTargetId,
  }))
}

/** 回复幂等键：消息 / 目标 / 正文 / 附件摘要。 */
export function replyContentHash({ messageId, targetId, text, document }) {
  return sha256(stableJson({
    messageId,
    targetId,
    text: typeof text === 'string' ? text : '',
    document: document === undefined ? null : document,
  }))
}

/** 实例目录下的 inbox 根。 */
export function inboxDirFor(instancesRoot, instanceId) {
  return join(resolve(instancesRoot), requireInstanceId(instanceId), 'inbox')
}

/** 正文 ref 的绝对路径；只接受 `inbox/bodies/` 下、无路径穿越的相对路径。 */
export function resolveInboxBodyPath(instancesRoot, instanceId, bodyRef) {
  if (!isPlainObject(bodyRef) || typeof bodyRef.path !== 'string') {
    throw fail(INBOX_STORE_ERROR.INVALID, '正文引用必须带 path', { field: 'bodyRef' })
  }
  const rel = bodyRef.path.split('\\').join('/')
  if (!rel.startsWith('inbox/bodies/') || rel.includes('../') || rel.includes('\0')) {
    throw fail(INBOX_STORE_ERROR.BODY_CORRUPT, `正文路径不在 inbox/bodies/ 下：${bodyRef.path}`, { path: bodyRef.path })
  }
  const absolute = resolve(resolve(instancesRoot), requireInstanceId(instanceId), rel)
  const root = resolve(instancesRoot, instanceId, 'inbox', 'bodies')
  if (!isWithin(root, absolute)) {
    throw fail(INBOX_STORE_ERROR.BODY_CORRUPT, `正文路径越界：${bodyRef.path}`, { path: bodyRef.path })
  }
  return absolute
}

function isWithin(root, target) {
  const normalizedRoot = root.endsWith('/') ? root : `${root}/`
  return target === root || target.startsWith(normalizedRoot)
}

/** 读 journal：坏行（崩溃时写了半行）跳过，不阻断已完整记录。 */
async function readJournal(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed)
      if (isPlainObject(parsed)) records.push(parsed)
    } catch {
      // 半行 / 损坏行：只丢这一行，保留其它记录。
    }
  }
  return records
}

/** journal 尾部半行旁路文件的后缀；坏尾行原样（base64）转存到这里。 */
export const INBOX_TORN_TAIL_SUFFIX = '.torn'
const JOURNAL_TAIL_CHUNK_BYTES = 64 * 1024

/** 从 handle 精确读出 length 字节（`FileHandle.read` 允许短读）。 */
async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset)
    if (bytesRead <= 0) break
    offset += bytesRead
  }
  return offset === length ? buffer : buffer.subarray(0, offset)
}

/** 把坏尾行转存到旁路文件（先落盘 + fsync，成功后才允许截断主 journal）。 */
async function appendTornTail(path, now, journal, raw) {
  const envelope = JSON.stringify({
    v: 1,
    at: nowIso(now),
    journal,
    bytes: raw.length,
    rawBase64: raw.toString('base64'),
  })
  let handle
  try {
    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
    handle = await open(path, 'a', FILE_MODE)
    await handle.write(`${envelope}\n`, null, 'utf8')
    await handle.sync()
  } catch (error) {
    throw fail(INBOX_STORE_ERROR.WRITE_FAILED, `转存 journal 坏尾行失败（${path}）：${error?.message ?? error}`, {
      path,
      reason: 'torn-tail-salvage-failed',
      cause: error,
    })
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/**
 * 锁内修复 journal 尾部：
 *   - 文件以 `\n` 结尾（或为空）→ 没有不完整尾部，什么都不做；
 *   - 否则从文件尾向前找最后一个 `\n`，把其后字节原样转存到 `<journal>.torn`，
 *     再把主 journal 截断到最后一个完整行并 fsync。
 *
 * 这样下一次 append 不会把新记录拼到坏尾行后面（否则整行都会被解析跳过），
 * 同时坏尾行的原始字节仍可人工恢复。
 *
 * @returns {Promise<{repaired: boolean, keptBytes?: number, salvagedBytes?: number}>}
 */
export async function repairJournalTail(path, now = () => new Date()) {
  let handle
  try {
    handle = await open(path, 'r+')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { repaired: false }
    throw fail(INBOX_STORE_ERROR.WRITE_FAILED, `检查 journal 尾部失败（${path}）：${error?.message ?? error}`, {
      path,
      cause: error,
    })
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size === 0) return { repaired: false }
    let end = info.size
    let lastNewline = -1
    while (end > 0) {
      const start = Math.max(0, end - JOURNAL_TAIL_CHUNK_BYTES)
      const chunk = await readExact(handle, end - start, start)
      const index = chunk.lastIndexOf(0x0a)
      if (index !== -1) {
        lastNewline = start + index
        break
      }
      if (chunk.length === 0) break
      end = start
    }
    if (lastNewline === info.size - 1) return { repaired: false }
    const keep = lastNewline === -1 ? 0 : lastNewline + 1
    const raw = await readExact(handle, info.size - keep, keep)
    await appendTornTail(`${path}${INBOX_TORN_TAIL_SUFFIX}`, now, basename(path), raw)
    await handle.truncate(keep)
    await handle.sync()
    return { repaired: true, keptBytes: keep, salvagedBytes: raw.length }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 追加一条完整记录并 fsync。一次 write 写完整行，避免多段拼出半行。
 *
 * 追加前先修复崩溃遗留的不完整尾部：所有调用方都持有 `inbox/.lock`，所以这次
 * 检测 / 截断与新记录追加对同一 journal 是串行的。
 */
async function appendJournal(path, record, now) {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  await repairJournalTail(path, now)
  const line = `${JSON.stringify(record)}\n`
  let handle
  try {
    handle = await open(path, 'a', FILE_MODE)
    await handle.write(line, null, 'utf8')
    await handle.sync()
  } catch (error) {
    throw fail(INBOX_STORE_ERROR.WRITE_FAILED, `写入 ${path} 失败：${error?.message ?? error}`, { path, cause: error })
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/** 重放 journal：同 key 以**最后一条**为准，按 seq 升序返回。 */
function replay(records, keyOf) {
  const byKey = new Map()
  for (const record of records) {
    const key = keyOf(record)
    if (typeof key !== 'string' || key === '') continue
    byKey.set(key, record)
  }
  return [...byKey.values()]
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
}

function nextSeq(records) {
  let max = 0
  for (const record of records) {
    if (Number.isSafeInteger(record.seq) && record.seq > max) max = record.seq
  }
  return max + 1
}

function nowIso(now) {
  return (typeof now === 'function' ? now() : new Date()).toISOString()
}

/**
 * 创建消息存储。所有写操作在 `inbox/.lock` 下串行（跨进程）；读操作直接重放。
 *
 * @param {{instancesRoot: string, now?: () => Date}} options
 */
export function createInstanceMessageStore(options = {}) {
  if (!isPlainObject(options)) {
    throw fail(INBOX_STORE_ERROR.INVALID, 'createInstanceMessageStore 需要对象参数')
  }
  if (typeof options.instancesRoot !== 'string' || options.instancesRoot.trim() === '') {
    throw fail(INBOX_STORE_ERROR.INVALID, 'createInstanceMessageStore 需要 instancesRoot')
  }
  const instancesRoot = resolve(options.instancesRoot)
  const now = typeof options.now === 'function' ? options.now : () => new Date()

  function paths(instanceId) {
    const dir = inboxDirFor(instancesRoot, instanceId)
    return {
      dir,
      messages: join(dir, 'messages.jsonl'),
      replies: join(dir, 'replies.jsonl'),
      lock: join(dir, '.lock'),
      bodies: join(dir, 'bodies'),
    }
  }

  async function loadMessages(instanceId) {
    const { messages } = paths(instanceId)
    return replay(await readJournal(messages), record => record.messageId)
  }

  async function loadReplies(instanceId) {
    const { replies } = paths(instanceId)
    return replay(await readJournal(replies), record => record.replyId)
  }

  /** 把正文写到最终路径：先写临时文件再 rename，最终路径不会出现半文件。 */
  async function writeBodyFile(instanceId, id, text) {
    const { bodies } = paths(instanceId)
    await mkdir(bodies, { recursive: true, mode: DIR_MODE })
    // bodyRef.sha256 是**正文本身**的摘要（与幂等用的 contentHash 分开）。
    const digest = sha256(text)
    const name = `${id}.${digest.slice(0, 16)}.txt`
    const target = join(bodies, name)
    tmpCounter += 1
    const temp = join(bodies, `.${name}.${process.pid}.${tmpCounter}.tmp`)
    const existedBefore = existsSync(target)
    let handle = null
    try {
      // 完整写入 + fsync 后再 rename：最终路径不会出现半文件，也不靠 OS 缓存碰运气。
      handle = await open(temp, 'w', FILE_MODE)
      await handle.writeFile(text, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temp, target)
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => {})
      await rm(temp, { force: true }).catch(() => {})
      throw fail(INBOX_STORE_ERROR.WRITE_FAILED, `正文落盘失败：${error?.message ?? error}`, {
        reason: 'body-write-failed',
        cause: error,
      })
    }
    return {
      target,
      existedBefore,
      ref: {
        path: `inbox/bodies/${name}`,
        sha256: digest,
        bytes: bodyBytes(text),
      },
    }
  }

  /**
   * 受理一条入站消息（幂等）。
   *
   * @param {{instanceId: string, messageId: string, target: object, text: string,
   *   replyTargetId?: string|null}} input
   * @returns {Promise<{record: object, duplicate: boolean}>}
   */
  async function acceptMessage(input) {
    if (!isPlainObject(input)) throw fail(INBOX_STORE_ERROR.INVALID, 'acceptMessage 需要对象参数')
    const instanceId = requireInstanceId(input.instanceId)
    const messageId = requireId(input.messageId, 'messageId')
    if (!isPlainObject(input.target)) throw fail(INBOX_STORE_ERROR.INVALID, 'message.target 必须是对象', { field: 'target' })
    if (typeof input.text !== 'string') throw fail(INBOX_STORE_ERROR.INVALID, 'message.text 必须是字符串', { field: 'text' })
    const replyTargetId = input.replyTargetId === undefined || input.replyTargetId === null || input.replyTargetId === ''
      ? null
      : requireId(input.replyTargetId, 'replyTargetId')
    const text = input.text
    const bytes = bodyBytes(text)
    if (bytes > INBOX_MAX_BODY_BYTES) {
      throw fail(
        INBOX_STORE_ERROR.BODY_TOO_LARGE,
        `消息正文 ${bytes} 字节，超过硬上限 ${INBOX_MAX_BODY_BYTES} 字节（1 MiB）；未写入任何文件`,
        { bytes, limit: INBOX_MAX_BODY_BYTES },
      )
    }
    const contentHash = messageContentHash({ target: input.target, text, replyTargetId })
    const { messages, lock } = paths(instanceId)

    return await withResourceLock(lock, async () => {
      const records = replay(await readJournal(messages), record => record.messageId)
      const existing = records.find(record => record.messageId === messageId)
      if (existing) {
        if (existing.contentHash === contentHash) return { record: existing, duplicate: true }
        throw fail(
          INBOX_STORE_ERROR.ID_CONFLICT,
          `消息 ${messageId} 已存在且内容不同（同一 messageId 必须对应同一内容）`,
          { messageId, existingHash: existing.contentHash, incomingHash: contentHash },
        )
      }
      const seq = nextSeq(records)
      const at = nowIso(now)
      let body
      let created = null
      if (bytes <= INBOX_INLINE_BODY_LIMIT) {
        body = { kind: 'inline', text }
      } else {
        created = await writeBodyFile(instanceId, messageId, text)
        body = { kind: 'file', ...created.ref }
      }
      const record = {
        v: INBOX_MESSAGE_RECORD_VERSION,
        instanceId,
        messageId,
        seq,
        target: { ...input.target },
        replyTargetId,
        contentHash,
        bytes,
        preview: previewOf(text),
        body,
        status: INBOX_MESSAGE_STATUS.QUEUED,
        delivery: null,
        createdAt: at,
        updatedAt: at,
        rev: 0,
      }
      try {
        await appendJournal(messages, record, now)
      } catch (error) {
        // 持久化失败不返回成功：本次新建的正文文件一并清掉（不留孤儿半成品）。
        if (created !== null && created.existedBefore !== true) {
          await rm(created.target, { force: true }).catch(() => {})
        }
        throw error
      }
      return { record, duplicate: false }
    })
  }

  /** 按 messageId 读一条消息（不含正文）。 */
  async function readMessage(instanceId, messageId) {
    const id = requireInstanceId(instanceId)
    const wanted = requireId(messageId, 'messageId')
    const records = await loadMessages(id)
    return records.find(record => record.messageId === wanted) ?? null
  }

  /**
   * 分页列消息：`cursor` 是上一页最后一条的 seq（不含），按 seq 升序。
   *
   * @param {string} instanceId
   * @param {{cursor?: number|null, limit?: number}} [options]
   */
  async function listMessages(instanceId, options = {}) {
    const id = requireInstanceId(instanceId)
    const cursor = Number.isSafeInteger(options.cursor) && options.cursor >= 0 ? options.cursor : 0
    const rawLimit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : INBOX_DEFAULT_PAGE_SIZE
    const limit = Math.min(rawLimit, INBOX_MAX_PAGE_SIZE)
    const records = await loadMessages(id)
    const candidates = records.filter(record => (record.seq ?? 0) > cursor)
    const page = candidates.slice(0, limit)
    const nextCursor = page.length < candidates.length && page.length > 0
      ? page[page.length - 1].seq
      : null
    return {
      messages: page.map(publicMessage),
      total: records.length,
      nextCursor,
      cursor,
      limit,
    }
  }

  /** 对外投影：不返回内联正文全文，只给摘要 + 正文引用。 */
  function publicMessage(record) {
    const body = isPlainObject(record.body) ? record.body : { kind: 'inline', text: '' }
    return {
      v: record.v ?? INBOX_MESSAGE_RECORD_VERSION,
      messageId: record.messageId,
      seq: record.seq ?? 0,
      target: isPlainObject(record.target) ? { ...record.target } : {},
      replyTargetId: record.replyTargetId ?? null,
      contentHash: record.contentHash ?? '',
      bytes: record.bytes ?? 0,
      preview: record.preview ?? '',
      body: body.kind === 'file'
        ? { kind: 'file', path: body.path, sha256: body.sha256, bytes: body.bytes }
        : { kind: 'inline', bytes: record.bytes ?? 0 },
      status: record.status ?? INBOX_MESSAGE_STATUS.QUEUED,
      delivery: isPlainObject(record.delivery) ? { ...record.delivery } : null,
      binding: isPlainObject(record.binding) ? { ...record.binding } : null,
      createdAt: record.createdAt ?? null,
      updatedAt: record.updatedAt ?? null,
      rev: record.rev ?? 0,
    }
  }

  /**
   * 读正文全文；内联直接返回，落盘正文读回后核对 sha256。
   *
   * @returns {Promise<{record: object, text: string, bodyRef: object|null}>}
   */
  async function readMessageBody(instanceId, messageId) {
    const record = await readMessage(instanceId, messageId)
    if (record === null) return null
    const body = isPlainObject(record.body) ? record.body : null
    if (body === null) throw fail(INBOX_STORE_ERROR.BODY_CORRUPT, `消息 ${messageId} 缺少正文记录`, { messageId })
    if (body.kind === 'inline') {
      return { record, text: typeof body.text === 'string' ? body.text : '', bodyRef: null }
    }
    const path = resolveInboxBodyPath(instancesRoot, instanceId, body)
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      throw fail(INBOX_STORE_ERROR.NOT_FOUND, `消息 ${messageId} 的正文文件不存在：${body.path}`, { path: body.path, cause: error })
    }
    if (sha256(text) !== body.sha256 || bodyBytes(text) !== body.bytes) {
      throw fail(INBOX_STORE_ERROR.BODY_CORRUPT, `消息 ${messageId} 的正文文件与记录不一致`, { messageId, path: body.path })
    }
    return { record, text, bodyRef: { path: body.path, sha256: body.sha256, bytes: body.bytes } }
  }

  /** 更新一条消息（追加新版本记录）。 */
  async function updateMessage(instanceId, messageId, patch) {
    const id = requireInstanceId(instanceId)
    const wanted = requireId(messageId, 'messageId')
    if (!isPlainObject(patch)) throw fail(INBOX_STORE_ERROR.INVALID, 'updateMessage 需要对象 patch')
    const { messages, lock } = paths(id)
    return await withResourceLock(lock, async () => {
      const records = replay(await readJournal(messages), record => record.messageId)
      const existing = records.find(record => record.messageId === wanted)
      if (!existing) throw fail(INBOX_STORE_ERROR.NOT_FOUND, `消息 ${wanted} 不存在`, { messageId: wanted })
      const at = nowIso(now)
      const next = {
        ...existing,
        ...patch,
        messageId: wanted,
        updatedAt: at,
        rev: (existing.rev ?? 0) + 1,
      }
      await appendJournal(messages, next, now)
      return next
    })
  }

  /**
   * 把「尚未激活节点」的消息绑定到**第一次**激活的 execution。
   *
   * 同一 activityId 后续激活不会再拿到已绑定的消息（循环重入隔离）；已经绑定过的
   * 消息不重复绑定。
   */
  async function bindNextActivation({ instanceId, activityId, executionId, attempt = 1 } = {}) {
    const id = requireInstanceId(instanceId)
    const activity = requireId(activityId, 'activityId')
    const execution = requireId(executionId, 'executionId')
    const { messages, lock } = paths(id)
    return await withResourceLock(lock, async () => {
      const records = replay(await readJournal(messages), record => record.messageId)
      const bound = []
      for (const record of records) {
        if (record.status !== INBOX_MESSAGE_STATUS.QUEUED) continue
        if (isPlainObject(record.binding)) continue
        const target = isPlainObject(record.target) ? record.target : {}
        if (target.delivery !== 'nextActivation' || target.activityId !== activity) continue
        const at = nowIso(now)
        const next = {
          ...record,
          binding: {
            activityId: activity,
            executionId: execution,
            attempt: Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : 1,
            at,
          },
          updatedAt: at,
          rev: (record.rev ?? 0) + 1,
        }
        await appendJournal(messages, next, now)
        bound.push(next)
      }
      return bound
    })
  }

  /** 某个 execution 名下仍处于 queued 的消息（按 seq 升序）。 */
  async function listQueuedForExecution(instanceId, executionId) {
    const id = requireInstanceId(instanceId)
    const execution = requireId(executionId, 'executionId')
    const records = await loadMessages(id)
    return records.filter(record => {
      if (record.status !== INBOX_MESSAGE_STATUS.QUEUED) return false
      const target = isPlainObject(record.target) ? record.target : {}
      if (target.executionId === execution) return true
      const binding = isPlainObject(record.binding) ? record.binding : null
      return binding !== null && binding.executionId === execution
    })
  }

  /**
   * 条件更新：只有记录**当前仍是 queued** 时才标 failed 并返回 `{updated:true}`。
   *
   * 这是「执行结束 / 实例终态」收口与「正在投递 / 已投递」之间的唯一协调点：
   * 迟到的过期请求看到 `injected` / `resumed` / `delivered` 就原样返回，绝不把
   * 已投递的消息改成过期失败。
   */
  async function failQueuedMessage(instanceId, messageId, delivery) {
    const id = requireInstanceId(instanceId)
    const wanted = requireId(messageId, 'messageId')
    if (!isPlainObject(delivery)) throw fail(INBOX_STORE_ERROR.INVALID, 'failQueuedMessage 需要对象 delivery')
    const { messages, lock } = paths(id)
    return await withResourceLock(lock, async () => {
      const records = replay(await readJournal(messages), record => record.messageId)
      const existing = records.find(record => record.messageId === wanted)
      if (!existing) throw fail(INBOX_STORE_ERROR.NOT_FOUND, `消息 ${wanted} 不存在`, { messageId: wanted })
      if (existing.status !== INBOX_MESSAGE_STATUS.QUEUED) return { updated: false, record: existing }
      const at = nowIso(now)
      const next = {
        ...existing,
        status: INBOX_MESSAGE_STATUS.FAILED,
        delivery,
        updatedAt: at,
        rev: (existing.rev ?? 0) + 1,
      }
      await appendJournal(messages, next, now)
      return { updated: true, record: next }
    })
  }

  /** 该 execution 名下仍 queued 的全量消息（用于 execution 结束时统一过期，条件更新）。 */
  async function expireQueuedForExecution(instanceId, executionId, reason) {
    const queued = await listQueuedForExecution(instanceId, executionId)
    const out = []
    for (const record of queued) {
      const result = await failQueuedMessage(instanceId, record.messageId, {
        kind: 'none',
        reason,
        at: nowIso(now),
      })
      if (result.updated) out.push(result.record)
    }
    return out
  }

  /**
   * 收一条回复进 outbox。replyId 可由调用方给（重试稳定），也可从内容确定性生成。
   *
   * @returns {Promise<{record: object, duplicate: boolean}>}
   */
  async function acceptReply(input) {
    if (!isPlainObject(input)) throw fail(INBOX_STORE_ERROR.INVALID, 'acceptReply 需要对象参数')
    const instanceId = requireInstanceId(input.instanceId)
    const messageId = requireId(input.messageId, 'messageId')
    const targetId = requireId(input.targetId, 'targetId')
    if (typeof input.text !== 'string') throw fail(INBOX_STORE_ERROR.INVALID, 'reply.text 必须是字符串', { field: 'text' })
    const text = input.text
    const bytes = bodyBytes(text)
    if (bytes > INBOX_MAX_BODY_BYTES) {
      throw fail(
        INBOX_STORE_ERROR.BODY_TOO_LARGE,
        `回复正文 ${bytes} 字节，超过硬上限 ${INBOX_MAX_BODY_BYTES} 字节（1 MiB）；未写入任何文件`,
        { bytes, limit: INBOX_MAX_BODY_BYTES },
      )
    }
    const document = input.document === undefined || input.document === null ? null : input.document
    if (document !== null && (!isPlainObject(document)
      || typeof document.path !== 'string'
      || typeof document.sha256 !== 'string'
      || !Number.isSafeInteger(document.bytes))) {
      throw fail(INBOX_STORE_ERROR.INVALID, 'reply.document 必须是已解析的 { path, sha256, bytes }', { field: 'document' })
    }
    const contentHash = replyContentHash({ messageId, targetId, text, document })
    const replyId = input.replyId === undefined || input.replyId === null || input.replyId === ''
      ? `reply-${contentHash.slice(0, 16)}`
      : requireId(input.replyId, 'replyId')
    const { replies, lock } = paths(instanceId)

    return await withResourceLock(lock, async () => {
      const records = replay(await readJournal(replies), record => record.replyId)
      const existing = records.find(record => record.replyId === replyId)
      if (existing) {
        if (existing.contentHash === contentHash) return { record: existing, duplicate: true }
        throw fail(
          INBOX_STORE_ERROR.ID_CONFLICT,
          `回复 ${replyId} 已存在且内容不同（同一 replyId 必须对应同一内容）`,
          { replyId, existingHash: existing.contentHash, incomingHash: contentHash },
        )
      }
      const seq = nextSeq(records)
      const at = nowIso(now)
      let body
      let created = null
      if (bytes <= INBOX_INLINE_BODY_LIMIT) {
        body = { kind: 'inline', text }
      } else {
        created = await writeBodyFile(instanceId, replyId, text)
        body = { kind: 'file', ...created.ref }
      }
      const record = {
        v: INBOX_REPLY_RECORD_VERSION,
        instanceId,
        replyId,
        messageId,
        targetId,
        seq,
        contentHash,
        bytes,
        preview: previewOf(text),
        document,
        body,
        status: INBOX_REPLY_STATUS.QUEUED,
        attempts: 0,
        lastError: null,
        createdAt: at,
        updatedAt: at,
        rev: 0,
      }
      try {
        await appendJournal(replies, record, now)
      } catch (error) {
        if (created !== null && created.existedBefore !== true) {
          await rm(created.target, { force: true }).catch(() => {})
        }
        throw error
      }
      return { record, duplicate: false }
    })
  }

  async function readReply(instanceId, replyId) {
    const id = requireInstanceId(instanceId)
    const wanted = requireId(replyId, 'replyId')
    const records = await loadReplies(id)
    return records.find(record => record.replyId === wanted) ?? null
  }

  /** 列 outbox；可按 messageId 过滤。 */
  async function listReplies(instanceId, options = {}) {
    const id = requireInstanceId(instanceId)
    const wanted = options.messageId === undefined || options.messageId === null || options.messageId === ''
      ? null
      : requireId(options.messageId, 'messageId')
    const records = await loadReplies(id)
    return records
      .filter(record => wanted === null || record.messageId === wanted)
      .map(publicReply)
  }

  function publicReply(record) {
    const body = isPlainObject(record.body) ? record.body : { kind: 'inline' }
    return {
      v: record.v ?? INBOX_REPLY_RECORD_VERSION,
      replyId: record.replyId,
      messageId: record.messageId,
      targetId: record.targetId,
      seq: record.seq ?? 0,
      contentHash: record.contentHash ?? '',
      bytes: record.bytes ?? 0,
      preview: record.preview ?? '',
      body: body.kind === 'file'
        ? { kind: 'file', path: body.path, sha256: body.sha256, bytes: body.bytes }
        : { kind: 'inline', bytes: record.bytes ?? 0 },
      document: isPlainObject(record.document) ? { ...record.document } : null,
      status: record.status ?? INBOX_REPLY_STATUS.QUEUED,
      attempts: record.attempts ?? 0,
      lastError: isPlainObject(record.lastError) ? { ...record.lastError } : null,
      delivery: isPlainObject(record.delivery) ? { ...record.delivery } : null,
      createdAt: record.createdAt ?? null,
      updatedAt: record.updatedAt ?? null,
      rev: record.rev ?? 0,
    }
  }

  /** 读回复正文全文（与消息正文同一套落盘 / 校验）。 */
  async function readReplyBody(instanceId, replyId) {
    const record = await readReply(instanceId, replyId)
    if (record === null) return null
    const body = isPlainObject(record.body) ? record.body : null
    if (body === null) throw fail(INBOX_STORE_ERROR.BODY_CORRUPT, `回复 ${replyId} 缺少正文记录`, { replyId })
    if (body.kind === 'inline') {
      return { record, text: typeof body.text === 'string' ? body.text : '', bodyRef: null }
    }
    const path = resolveInboxBodyPath(instancesRoot, instanceId, body)
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      throw fail(INBOX_STORE_ERROR.NOT_FOUND, `回复 ${replyId} 的正文文件不存在：${body.path}`, { path: body.path, cause: error })
    }
    if (sha256(text) !== body.sha256 || bodyBytes(text) !== body.bytes) {
      throw fail(INBOX_STORE_ERROR.BODY_CORRUPT, `回复 ${replyId} 的正文文件与记录不一致`, { replyId, path: body.path })
    }
    return { record, text, bodyRef: { path: body.path, sha256: body.sha256, bytes: body.bytes } }
  }

  /** 更新一条 outbox 记录（追加新版本）。 */
  async function updateReply(instanceId, replyId, patch) {
    const id = requireInstanceId(instanceId)
    const wanted = requireId(replyId, 'replyId')
    if (!isPlainObject(patch)) throw fail(INBOX_STORE_ERROR.INVALID, 'updateReply 需要对象 patch')
    const { replies, lock } = paths(id)
    return await withResourceLock(lock, async () => {
      const records = replay(await readJournal(replies), record => record.replyId)
      const existing = records.find(record => record.replyId === wanted)
      if (!existing) throw fail(INBOX_STORE_ERROR.NOT_FOUND, `回复 ${wanted} 不存在`, { replyId: wanted })
      const at = nowIso(now)
      const next = {
        ...existing,
        ...patch,
        replyId: wanted,
        updatedAt: at,
        rev: (existing.rev ?? 0) + 1,
      }
      await appendJournal(replies, next, now)
      return next
    })
  }

  /**
   * 领取一条回复的投递权（锁内）。
   *
   * - 已 `delivered` / `skipped`：不给投递权；
   * - 已有未过期的 `dispatch.token`：另一条调用链正在外发，不给投递权；
   * - 否则写入新的 `dispatch:{token, at, attempt}` 并 `attempts = attempts + 1`。
   *
   * 外发本身不持文件锁（网络可能很慢）；靠 token 与 `rev` 把「领取 → 外发 → 写回」
   * 串成一次可判定归属的尝试。
   *
   * @returns {Promise<{claimed: boolean, reason?: string, token?: string, attempt?: number, record: object}>}
   */
  async function claimReplyDispatch(instanceId, replyId) {
    const id = requireInstanceId(instanceId)
    const wanted = requireId(replyId, 'replyId')
    const { replies, lock } = paths(id)
    return await withResourceLock(lock, async () => {
      const records = replay(await readJournal(replies), record => record.replyId)
      const existing = records.find(record => record.replyId === wanted)
      if (!existing) throw fail(INBOX_STORE_ERROR.NOT_FOUND, `回复 ${wanted} 不存在`, { replyId: wanted })
      if (existing.status === INBOX_REPLY_STATUS.DELIVERED) {
        return { claimed: false, reason: 'delivered', record: existing }
      }
      if (existing.status === INBOX_REPLY_STATUS.SKIPPED) {
        return { claimed: false, reason: 'skipped', record: existing }
      }
      const current = isPlainObject(existing.dispatch) ? existing.dispatch : null
      if (current !== null && typeof current.token === 'string' && current.token !== '') {
        const claimedAt = typeof current.at === 'string' ? Date.parse(current.at) : Number.NaN
        if (Number.isFinite(claimedAt) && now() - claimedAt < INBOX_REPLY_DISPATCH_TTL_MS) {
          return { claimed: false, reason: 'in-progress', record: existing }
        }
      }
      const token = randomUUID()
      const attempt = (existing.attempts ?? 0) + 1
      const at = nowIso(now)
      const next = {
        ...existing,
        dispatch: { token, at, attempt },
        attempts: attempt,
        updatedAt: at,
        rev: (existing.rev ?? 0) + 1,
      }
      await appendJournal(replies, next, now)
      return { claimed: true, token, attempt, record: next }
    })
  }

  /**
   * 用领取时拿到的 token 写回投递结果（锁内 CAS）。
   *
   * - token 不匹配（投递权已被接管 / 已清理）：不写，返回当前记录；
   * - 当前已是 `delivered` 而本次结果是失败：不写，返回 delivered（迟到失败不能
   *   覆盖已成功的外发）；
   * - 只有仍持有投递权时才写入本次结果并清掉 `dispatch`，让明确失败可再次重试。
   *
   * @returns {Promise<{updated: boolean, reason?: string, record: object}>}
   */
  async function completeReplyDispatch(instanceId, replyId, input) {
    const id = requireInstanceId(instanceId)
    const wanted = requireId(replyId, 'replyId')
    if (!isPlainObject(input)) throw fail(INBOX_STORE_ERROR.INVALID, 'completeReplyDispatch 需要对象参数')
    const token = typeof input.token === 'string' ? input.token : ''
    if (token === '') throw fail(INBOX_STORE_ERROR.INVALID, 'completeReplyDispatch 需要投递权 token')
    const status = input.status
    if (status !== INBOX_REPLY_STATUS.DELIVERED
      && status !== INBOX_REPLY_STATUS.FAILED
      && status !== INBOX_REPLY_STATUS.SKIPPED) {
      throw fail(INBOX_STORE_ERROR.INVALID, `completeReplyDispatch 不支持状态 ${String(status)}`)
    }
    const { replies, lock } = paths(id)
    return await withResourceLock(lock, async () => {
      const records = replay(await readJournal(replies), record => record.replyId)
      const existing = records.find(record => record.replyId === wanted)
      if (!existing) throw fail(INBOX_STORE_ERROR.NOT_FOUND, `回复 ${wanted} 不存在`, { replyId: wanted })
      if (existing.status === INBOX_REPLY_STATUS.DELIVERED && status !== INBOX_REPLY_STATUS.DELIVERED) {
        return { updated: false, reason: 'delivered', record: existing }
      }
      const current = isPlainObject(existing.dispatch) ? existing.dispatch : null
      if (current === null || current.token !== token) {
        return { updated: false, reason: 'claim-lost', record: existing }
      }
      const at = nowIso(now)
      const next = {
        ...existing,
        status,
        attempts: Number.isSafeInteger(input.attempts) && input.attempts >= 0 ? input.attempts : (existing.attempts ?? 0),
        lastError: isPlainObject(input.lastError) ? input.lastError : null,
        delivery: isPlainObject(input.delivery) ? input.delivery : existing.delivery ?? null,
        dispatch: null,
        updatedAt: at,
        rev: (existing.rev ?? 0) + 1,
      }
      await appendJournal(replies, next, now)
      return { updated: true, record: next }
    })
  }

  return {
    instancesRoot,
    paths,
    acceptMessage,
    readMessage,
    listMessages,
    readMessageBody,
    updateMessage,
    bindNextActivation,
    listQueuedForExecution,
    failQueuedMessage,
    expireQueuedForExecution,
    acceptReply,
    readReply,
    listReplies,
    readReplyBody,
    updateReply,
    claimReplyDispatch,
    completeReplyDispatch,
  }
}

/** 供路由 / 测试复用的附件解析结果形状（不是 store 的持久化格式）。 */
export function previewText(text) {
  return previewOf(typeof text === 'string' ? text : '')
}

/** 正文摘要用的字节数。 */
export function utf8Bytes(text) {
  return bodyBytes(typeof text === 'string' ? text : '')
}
