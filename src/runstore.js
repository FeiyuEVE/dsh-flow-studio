/**
 * run 目录的 Host 侧读写：`$DSH_HOME/flow-studio/runs/<runId>/`。
 *
 * 布局（05 §1）：
 *   run.jsonl                 run 级事件（run/start、run/end）
 *   run.json                  run 元数据（可变，原子写）
 *   <nodeId>/<attemptId>.jsonl 节点事件
 *   <nodeId>/artifacts/       产物（本模块只校验路径，不代写产物）
 *
 * 安全口径：runId 一律过 `checkRunId()`（字符集 + 拒绝 `.`/`..`/点开头），
 * 所有拼出来的路径都要再确认在 runs 根目录内；目录 0700、文件 0600。
 * 单条事件 ≤8KB、单批 ≤200 条、单 run ≤200000 条，超限抛 RunError(400)。
 *
 * @module @feiyueve/dsh-flow-studio/runstore
 */

import { Buffer } from 'node:buffer'
import { randomInt } from 'node:crypto'
import {
  chmod, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  MAX_BATCH_EVENTS, MAX_EVENT_BYTES, MAX_RUN_EVENTS, checkRunId, computeProgress,
  normalizeEvent,
} from './runlog.js'
import { resolveHome } from './store.js'

/** run.json 的体积上限：元数据不该有成百上千行。 */
const MAX_META_BYTES = 1024 * 1024

/** 事件按 run 级 / 节点级分流。 */
const RUN_LEVEL_KINDS = new Set(['run/start', 'run/end'])

const ATTEMPT_FILE = /^\d+\.jsonl$/
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** 带 HTTP 语义的错误：路由层直接按 status / field / reason 回 JSON。 */
export class RunError extends Error {
  constructor(status, field, reason, extra = {}) {
    super(reason || '运行日志操作失败')
    this.name = 'RunError'
    this.status = status
    this.field = field || null
    this.reason = reason || this.message
    Object.assign(this, extra)
  }

  toPayload() {
    const payload = { ok: false, error: this.reason }
    if (this.field) payload.field = this.field
    if (this.index !== undefined) payload.index = this.index
    return payload
  }
}

/**
 * runs 根目录。每次调用重新解析，便于测试注入 DSH_HOME。
 * @param {string} [home]
 */
export function runsDir(home) {
  return join(home || resolveHome(process.env), 'flow-studio', 'runs')
}

/** 生成 `r-<base36 时间>-<随机 4 位>`。 */
export function newRunId(now = Date.now()) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 4; i += 1) suffix += alphabet[randomInt(alphabet.length)]
  return `r-${now.toString(36)}-${suffix}`
}

async function withLock(key, task) {
  const previous = locks.get(key) || Promise.resolve()
  let release
  const gate = new Promise(resolveGate => { release = resolveGate })
  locks.set(key, gate)
  await previous.catch(() => {})
  try {
    return await task()
  } finally {
    release()
    if (locks.get(key) === gate) locks.delete(key)
  }
}

const locks = new Map()

function locate(runsRoot, runId) {
  const id = checkRunId(runId)
  if (!id) return null
  const root = resolve(runsRoot)
  const dir = resolve(root, id)
  if (!isInside(root, dir)) return null
  return { id, root, dir }
}

function isInside(root, target) {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function ensureDirMode(dir, mode = DIR_MODE) {
  await mkdir(dir, { recursive: true, mode })
  try {
    await chmod(dir, mode)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
}

function metaPath(dir) {
  return join(dir, 'run.json')
}

/** §8.6：run.json 里的进度计数器状态（追加时原子更新）。 */
const PROGRESS_STATUS = new Set(['passed', 'rejected', 'failed', 'skipped', 'pending'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeProgress(source) {
  const out = { nodes: {} }
  if (!isPlainObject(source) || !isPlainObject(source.nodes)) return out
  for (const [nodeId, entry] of Object.entries(source.nodes)) {
    if (!checkRunId(nodeId) || !isPlainObject(entry)) continue
    const attemptId = Number.isInteger(entry.attemptId) && entry.attemptId >= 1 ? entry.attemptId : 1
    const status = PROGRESS_STATUS.has(entry.status) ? entry.status : 'pending'
    const endSeq = Number.isInteger(entry.endSeq) && entry.endSeq >= 0 ? entry.endSeq : 0
    out.nodes[nodeId] = { attemptId, status, endSeq, invalidated: entry.invalidated === true }
  }
  return out
}

function countPassed(progress) {
  let passed = 0
  for (const entry of Object.values(progress.nodes)) {
    if (entry.status === 'passed' && !entry.invalidated) passed += 1
  }
  return passed
}

function normalizeMeta(raw, id) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const now = new Date().toISOString()
  const text = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback)
  const count = (value, fallback = 0) => (Number.isInteger(value) && value >= 0 ? value : fallback)
  const status = ['running', 'done', 'aborted', 'failed'].includes(source.status)
    ? source.status
    : 'running'
  const progress = normalizeProgress(source.progress)
  const hasProgress = isPlainObject(source.progress) && isPlainObject(source.progress.nodes)
  const lastSeq = count(source.lastSeq, count(source.seq))
  const nodeTotal = count(source.nodeTotal)
  return {
    v: 1,
    id,
    name: text(source.name, id),
    flowId: text(source.flowId, ''),
    flowName: text(source.flowName, ''),
    status,
    startedAt: text(source.startedAt, now),
    endedAt: typeof source.endedAt === 'string' && source.endedAt !== '' ? source.endedAt : null,
    nodeDone: hasProgress ? countPassed(progress) : count(source.nodeDone),
    nodeTotal,
    tokenTotal: count(source.tokenTotal),
    eventCount: count(source.eventCount),
    lastSeq,
    // 兼容 v0.2：老字段 seq 与 lastSeq 同值。
    seq: lastSeq,
    unkeyedCalls: count(source.unkeyedCalls),
    tokenTotalApprox: source.tokenTotalApprox === true,
    createdAt: text(source.createdAt, now),
    updatedAt: text(source.updatedAt, now),
    progress,
  }
}

async function readMetaUnlocked(loc) {
  let text
  try {
    text = await readFile(metaPath(loc.dir), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_META_BYTES) return null
  try {
    return normalizeMeta(JSON.parse(text), loc.id)
  } catch {
    // 坏 meta 当成不存在：一份手改坏的 JSON 不该让整个 run 列表 500。
    return null
  }
}

let tmpCounter = 0

async function writeMetaUnlocked(loc, meta) {
  await ensureDirMode(loc.dir)
  const text = `${JSON.stringify(meta, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_META_BYTES) {
    throw new RunError(500, 'run', 'run.json 超过 1MiB，元数据异常')
  }
  const tmp = `${metaPath(loc.dir)}.tmp-${process.pid}-${tmpCounter++}`
  await writeFile(tmp, text, { encoding: 'utf8', mode: FILE_MODE })
  try {
    await rename(tmp, metaPath(loc.dir))
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  await chmod(metaPath(loc.dir), FILE_MODE).catch(() => {})
  return meta
}

function requireLoc(runsRoot, runId) {
  const loc = locate(runsRoot, runId)
  if (!loc) {
    throw new RunError(400, 'runId', 'runId 不合法（只允许字母、数字、点、下划线、连字符，1–64 位，且不能以点开头）')
  }
  return loc
}

function assertString(value, field, { max = 128, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new RunError(400, field, '缺少必填字段')
    return undefined
  }
  if (typeof value !== 'string') throw new RunError(400, field, '必须是字符串')
  if (value.trim() === '') throw new RunError(400, field, '不能为空字符串')
  if (value.length > max) throw new RunError(400, field, `超过 ${max} 字符`)
  return value
}

/**
 * 新建一个 run 目录并写入 run.json。
 *
 * @param {string} runsRoot
 * @param {{ id?: string, name: string, flowId: string, flowName?: string, nodeTotal: number }} input
 */
export async function createRun(runsRoot, input = {}) {
  const flowId = assertString(input.flowId, 'flowId', { max: 128 })
  const flowName = typeof input.flowName === 'string' && input.flowName !== ''
    ? input.flowName
    : flowId
  if (flowName.length > 200) throw new RunError(400, 'flowName', '超过 200 字符')
  const name = typeof input.name === 'string' && input.name.trim() !== ''
    ? input.name
    : flowName
  if (name.length > 200) throw new RunError(400, 'name', '超过 200 字符')
  if (!Number.isInteger(input.nodeTotal) || input.nodeTotal < 0) {
    throw new RunError(400, 'nodeTotal', '必须是非负整数')
  }

  const fixedId = input.id === undefined || input.id === null ? null : checkRunId(input.id)
  if (input.id !== undefined && input.id !== null && !fixedId) {
    throw new RunError(400, 'runId', 'runId 不合法')
  }

  await ensureDirMode(resolve(runsRoot))

  let loc = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = fixedId || newRunId()
    const next = locate(runsRoot, candidate)
    if (!next) continue
    try {
      await mkdir(next.dir, { recursive: false, mode: DIR_MODE })
      await chmod(next.dir, DIR_MODE)
      loc = next
      break
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        if (fixedId) throw new RunError(400, 'runId', 'run 已存在')
        continue
      }
      throw error
    }
  }
  if (!loc) throw new RunError(500, 'runId', '生成 runId 失败（连续冲突）')

  const now = new Date().toISOString()
  const meta = normalizeMeta({
    name,
    flowId,
    flowName,
    status: 'running',
    startedAt: now,
    endedAt: null,
    nodeDone: 0,
    nodeTotal: input.nodeTotal,
    tokenTotal: 0,
    eventCount: 0,
    seq: 0,
    createdAt: now,
    updatedAt: now,
  }, loc.id)

  try {
    await writeMetaUnlocked(loc, meta)
  } catch (error) {
    await rm(loc.dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return meta
}

/**
 * 读 run 元数据；runId 非法或 run.json 不存在 / 坏掉都返回 null。
 * @returns {Promise<object | null>}
 */
export async function readRunMeta(runsRoot, runId) {
  const loc = locate(runsRoot, runId)
  if (!loc) return null
  try {
    return await readMetaUnlocked(loc)
  } catch {
    // run.json 是目录 / 权限拒绝 / 其它 IO 错误：单条读取按「不存在」处理（404），
    // 列表侧会把它记进 skipped 而不是让整张表 500（§8.6）。
    return null
  }
}

/**
 * 原子写 run 元数据（临时文件 + rename）。给了部分字段时与现有 meta 合并；
 * `id` 永远以路径为准，不接受请求体伪造。目录不存在 → RunError(404)。
 * @returns {Promise<object>} 写入后的完整 meta
 */
export async function writeRunMeta(runsRoot, runId, patch = {}) {
  const loc = requireLoc(runsRoot, runId)
  return withLock(loc.id, async () => {
    try {
      const info = await stat(loc.dir)
      if (!info.isDirectory()) throw new RunError(404, 'runId', 'run 不存在')
    } catch (error) {
      if (error && error.code === 'ENOENT') throw new RunError(404, 'runId', 'run 不存在')
      throw error
    }
    const existing = await readMetaUnlocked(loc)
    const merged = normalizeMeta({ ...(existing || {}), ...(patch && typeof patch === 'object' ? patch : {}) }, loc.id)
    merged.updatedAt = new Date().toISOString()
    if (!existing) merged.createdAt = merged.updatedAt
    return writeMetaUnlocked(loc, merged)
  })
}

async function readAllEventsUnlocked(loc, meta) {
  const events = []
  let order = 0
  let skipped = 0

  const pushLines = text => {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const event = JSON.parse(trimmed)
        if (event !== null && typeof event === 'object' && !Array.isArray(event)) {
          events.push({ event, order: order++ })
        } else {
          skipped += 1
        }
      } catch {
        skipped += 1
      }
    }
  }

  const readFileSafe = async path => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw error
    }
  }

  const rootFile = await readFileSafe(join(loc.dir, 'run.jsonl'))
  if (rootFile !== null) pushLines(rootFile)

  let dirents = []
  try {
    dirents = await readdir(loc.dir, { withFileTypes: true })
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  const nodeDirs = dirents
    .filter(entry => entry.isDirectory() && checkRunId(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))

  for (const nodeId of nodeDirs) {
    const nodePath = join(loc.dir, nodeId)
    let files = []
    try {
      files = await readdir(nodePath, { withFileTypes: true })
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
      continue
    }
    const names = files
      .filter(entry => entry.isFile() && ATTEMPT_FILE.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    for (const name of names) {
      const text = await readFileSafe(join(nodePath, name))
      if (text !== null) pushLines(text)
    }
  }

  events.sort((a, b) => {
    const sa = Number.isFinite(a.event.seq) ? a.event.seq : null
    const sb = Number.isFinite(b.event.seq) ? b.event.seq : null
    if (sa !== null && sb !== null && sa !== sb) return sa - sb
    const ta = typeof a.event.ts === 'string' ? Date.parse(a.event.ts) : Number.NaN
    const tb = typeof b.event.ts === 'string' ? Date.parse(b.event.ts) : Number.NaN
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
    return a.order - b.order
  })

  return { events: events.map(entry => entry.event), skipped, meta }
}

/**
 * 读一个 run 的全部事件（按 seq 升序）。runId 非法 / run 不存在返回 null。
 * @returns {Promise<{ events: object[], skipped: number, meta: object } | null>}
 */
export async function readAllEvents(runsRoot, runId) {
  const loc = locate(runsRoot, runId)
  if (!loc) return null
  let meta
  try {
    meta = await readMetaUnlocked(loc)
  } catch {
    return null
  }
  if (!meta) return null
  return readAllEventsUnlocked(loc, meta)
}

function parseSince(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new RunError(400, 'since', '必须是非负整数 seq 或 ISO 时间')
    return { type: 'seq', value }
  }
  if (typeof value !== 'string') throw new RunError(400, 'since', '必须是非负整数 seq 或 ISO 时间')
  if (/^\d+$/.test(value)) return { type: 'seq', value: Number(value) }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new RunError(400, 'since', '必须是非负整数 seq 或 ISO 时间')
  return { type: 'ts', value: parsed }
}

/**
 * 读事件流：过滤 + 分页 + 排序。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {{ nodeId?: string, attemptId?: number, kinds?: string[], since?: number|string, limit?: number, order?: 'asc'|'desc' }} [options]
 * @returns {Promise<{ events: object[], total: number, truncated: boolean, skipped: number } | null>}
 */
export async function readEvents(runsRoot, runId, options = {}) {
  const all = await readAllEvents(runsRoot, runId)
  if (!all) return null

  let nodeId
  if (options.nodeId !== undefined && options.nodeId !== null && options.nodeId !== '') {
    nodeId = checkRunId(options.nodeId)
    if (!nodeId) throw new RunError(400, 'nodeId', 'nodeId 不合法')
  }

  let attemptId
  if (options.attemptId !== undefined && options.attemptId !== null && options.attemptId !== '') {
    const value = typeof options.attemptId === 'string' ? Number(options.attemptId) : options.attemptId
    if (!Number.isInteger(value) || value < 1) throw new RunError(400, 'attemptId', '必须是从 1 开始的正整数')
    attemptId = value
  }

  let kinds
  if (options.kinds !== undefined && options.kinds !== null) {
    if (!Array.isArray(options.kinds)) throw new RunError(400, 'kind', 'kind 必须是白名单内的字符串')
    const set = new Set()
    for (const kind of options.kinds) {
      if (typeof kind !== 'string' || !whitelistKind(kind)) {
        throw new RunError(400, 'kind', `未知事件类型：${String(kind)}`)
      }
      set.add(kind)
    }
    if (set.size > 0) kinds = set
  }

  const since = parseSince(options.since)

  let order = 'asc'
  if (options.order !== undefined && options.order !== null && options.order !== '') {
    if (options.order !== 'asc' && options.order !== 'desc') {
      throw new RunError(400, 'order', '只支持 asc / desc')
    }
    order = options.order
  }

  let limit = 200
  if (options.limit !== undefined && options.limit !== null && options.limit !== '') {
    const value = typeof options.limit === 'string' ? Number(options.limit) : options.limit
    if (!Number.isInteger(value) || value < 1) throw new RunError(400, 'limit', '必须是正整数')
    limit = Math.min(value, 1000)
  }

  const sinceTs = since && since.type === 'ts' ? since.value : null
  const filtered = all.events.filter(event => {
    if (nodeId && event.nodeId !== nodeId) return false
    if (attemptId !== undefined && event.attemptId !== attemptId) return false
    if (kinds && !kinds.has(event.kind)) return false
    if (since && since.type === 'seq') {
      if (!Number.isFinite(event.seq) || event.seq <= since.value) return false
    }
    if (sinceTs !== null) {
      const ts = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN
      if (!Number.isFinite(ts) || ts <= sinceTs) return false
    }
    return true
  })

  const total = filtered.length
  const ordered = order === 'desc' ? [...filtered].reverse() : filtered
  return {
    events: ordered.slice(0, limit),
    total,
    truncated: total > limit,
    skipped: all.skipped,
  }
}

// 与 runlog.EVENT_KINDS 保持一致；单独列一份避免这里 import 整个校验器。
const EVENT_KINDS = new Set([
  'run/start', 'run/end', 'node/start', 'node/end', 'member/start', 'member/end',
  'model/call', 'tool/call', 'skill/load', 'artifact/write', 'reject/trigger',
  'review/finding', 'review/verdict', 'check/form',
  'acceptance/verdict', 'test/report',
])

function whitelistKind(kind) {
  return EVENT_KINDS.has(kind)
}

/** §8.6：用量的替换语义需要记住每个 (traceId, callId) 上一次的贡献。 */
const USAGE_FILE = '.usage.json'

function usageTotal(usage) {
  if (!isPlainObject(usage)) return 0
  const part = key => (Number.isFinite(usage[key]) ? usage[key] : 0)
  return part('input') + part('cacheRead') + part('cacheWrite') + part('output')
}

async function readUsageLedger(dir) {
  let text
  try {
    text = await readFile(join(dir, USAGE_FILE), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ledger: { keys: {} }, corrupt: false }
    return { ledger: { keys: {} }, corrupt: true }
  }
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed) || !isPlainObject(parsed.keys)) return { ledger: { keys: {} }, corrupt: true }
    return { ledger: { keys: parsed.keys }, corrupt: false }
  } catch {
    return { ledger: { keys: {} }, corrupt: true }
  }
}

async function writeUsageLedger(dir, ledger) {
  const text = `${JSON.stringify(ledger)}\n`
  const tmp = join(dir, `${USAGE_FILE}.tmp-${process.pid}-${tmpCounter++}`)
  await writeFile(tmp, text, { encoding: 'utf8', mode: FILE_MODE })
  try {
    await rename(tmp, join(dir, USAGE_FILE))
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  await chmod(join(dir, USAGE_FILE), FILE_MODE).catch(() => {})
}

/** 追加时按事件顺序增量维护 run.json 里的进度计数器（与 runlog.computeProgress 同口径）。 */
function applyProgressEvent(progress, event) {
  if (event.kind === 'node/start' && event.data) {
    const existing = progress.nodes[event.nodeId]
    if (!existing || event.attemptId >= existing.attemptId) {
      progress.nodes[event.nodeId] = {
        attemptId: event.attemptId,
        status: 'pending',
        endSeq: 0,
        invalidated: false,
      }
    }
    return
  }
  if (event.kind === 'node/end' && event.data) {
    const existing = progress.nodes[event.nodeId]
    if (!existing || event.attemptId >= existing.attemptId) {
      progress.nodes[event.nodeId] = {
        attemptId: event.attemptId,
        status: event.data.status,
        endSeq: event.seq,
        invalidated: false,
      }
    }
    return
  }
  if (event.kind === 'reject/trigger' && event.data) {
    const fromNodeId = event.data.fromNodeId
    const toNodeId = event.data.toNodeId
    if (typeof fromNodeId !== 'string' || typeof toNodeId !== 'string') return
    const target = progress.nodes[toNodeId]
    const windowStart = target && target.status === 'passed' && target.endSeq > 0
      && target.endSeq < event.seq ? target.endSeq : null
    for (const [nodeId, entry] of Object.entries(progress.nodes)) {
      if (entry.status !== 'passed' || entry.invalidated) continue
      if (entry.endSeq <= 0 || entry.endSeq >= event.seq) continue
      const onPath = nodeId === fromNodeId || nodeId === toNodeId
        || (windowStart !== null && entry.endSeq >= windowStart)
      if (onPath) entry.invalidated = true
    }
  }
}

/**
 * 追加一批事件。整批校验：任何一条不合法就一条都不写。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {object|object[]} rawEvents 单条或数组
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ events: object[], run: object, firstSeq: number, lastSeq: number }>}
 */
export async function appendEvents(runsRoot, runId, rawEvents, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  return withLock(loc.id, async () => {
    const meta = await readMetaUnlocked(loc)
    if (!meta) throw new RunError(404, 'runId', 'run 不存在')

    const list = Array.isArray(rawEvents)
      ? rawEvents
      : (rawEvents === undefined || rawEvents === null ? [] : [rawEvents])
    if (list.length === 0) throw new RunError(400, 'events', '至少需要一条事件')
    if (list.length > MAX_BATCH_EVENTS) {
      throw new RunError(400, 'events', `单批最多 ${MAX_BATCH_EVENTS} 条（本次 ${list.length} 条）`)
    }
    if (meta.eventCount + list.length > MAX_RUN_EVENTS) {
      throw new RunError(
        400,
        'events',
        `超过单 run 事件总数上限 ${MAX_RUN_EVENTS}（已有 ${meta.eventCount}，本批 ${list.length}）`,
      )
    }

    const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
      ? options.now
      : new Date()
    const normalized = []
    for (let index = 0; index < list.length; index += 1) {
      const checked = normalizeEvent(list[index], { runId: loc.id, now })
      if (!checked.ok) {
        throw new RunError(400, `events[${index}].${checked.field}`, checked.reason, { index })
      }
      normalized.push(checked.event)
    }

    let seq = meta.seq
    for (const event of normalized) {
      seq += 1
      event.seq = seq
      if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) {
        throw new RunError(400, 'events', `单条事件超过 ${MAX_EVENT_BYTES} 字节（事件行上限 8KB）`)
      }
    }
    const firstSeq = normalized[0].seq
    const lastSeq = normalized[normalized.length - 1].seq

    // 按目标文件分组，保持输入顺序；run 级写 run.jsonl，节点级写 <nodeId>/<attemptId>.jsonl。
    const groups = new Map()
    for (const event of normalized) {
      const rel = RUN_LEVEL_KINDS.has(event.kind)
        ? 'run.jsonl'
        : join(event.nodeId, `${event.attemptId}.jsonl`)
      if (!groups.has(rel)) groups.set(rel, [])
      groups.get(rel).push(event)
    }

    for (const [rel, events] of groups) {
      const abs = resolve(loc.dir, rel)
      if (!isInside(loc.dir, abs)) throw new RunError(500, 'runId', '事件路径越出 run 目录')
      await ensureDirMode(dirname(abs))
      const text = events.map(event => `${JSON.stringify(event)}\n`).join('')
      const handle = await open(abs, 'a', FILE_MODE)
      try {
        await handle.writeFile(text, 'utf8')
      } finally {
        await handle.close()
      }
      await chmod(abs, FILE_MODE).catch(() => {})
    }

    // §8.6：计数器在追加时原子更新，列表只需读 run.json。
    const progress = meta.progress
    let tokenTotal = meta.tokenTotal
    let unkeyedCalls = meta.unkeyedCalls
    let tokenTotalApprox = meta.tokenTotalApprox
    const hasUsageEvents = normalized.some(event => event.kind === 'model/call')
    let ledger = null
    if (hasUsageEvents) {
      const loaded = await readUsageLedger(loc.dir)
      ledger = loaded.ledger
      if (loaded.corrupt) tokenTotalApprox = true
    }

    for (const event of normalized) {
      if (!event.data) continue
      if (event.kind === 'run/start') {
        if (Number.isInteger(event.data.nodeTotal) && event.data.nodeTotal >= 0) {
          meta.nodeTotal = event.data.nodeTotal
        }
        if (typeof event.data.flowId === 'string' && event.data.flowId !== '') meta.flowId = event.data.flowId
        if (typeof event.data.flowName === 'string' && event.data.flowName !== '') meta.flowName = event.data.flowName
        continue
      }
      if (event.kind === 'run/end') {
        if (['done', 'aborted', 'failed'].includes(event.data.status)) meta.status = event.data.status
        if (typeof event.ts === 'string') meta.endedAt = event.ts
        continue
      }
      if (event.kind === 'node/start' || event.kind === 'node/end' || event.kind === 'reject/trigger') {
        applyProgressEvent(progress, event)
        continue
      }
      if (event.kind === 'model/call') {
        const usage = event.data.usage
        const total = usageTotal(usage)
        const callId = event.data.callId
        if (typeof callId === 'string' && callId !== '') {
          const key = `${event.traceId}\u0000${callId}`
          const previous = Number.isFinite(ledger.keys[key]) ? ledger.keys[key] : 0
          tokenTotal += total - previous
          ledger.keys[key] = total
        } else {
          // §8.1：没有 callId 的用量按逐条累加，并单列供核对。
          tokenTotal += total
          unkeyedCalls += 1
        }
      }
    }

    meta.eventCount += normalized.length
    meta.lastSeq = lastSeq
    meta.seq = lastSeq
    meta.nodeDone = countPassed(progress)
    meta.tokenTotal = tokenTotal
    meta.unkeyedCalls = unkeyedCalls
    meta.tokenTotalApprox = tokenTotalApprox
    meta.updatedAt = now.toISOString()
    await writeMetaUnlocked(loc, meta)
    if (ledger) {
      // 计数器已落盘；账本写失败只影响下一次追加的替换精度，不回滚已写入的事件。
      await writeUsageLedger(loc.dir, ledger).catch(() => {})
    }

    return { events: normalized, run: meta, firstSeq, lastSeq }
  })
}

/**
 * 删除整个 run 目录（日志即证据，不做软删）。
 * @returns {Promise<boolean>} 原本是否存在
 */
export async function deleteRun(runsRoot, runId) {
  const loc = locate(runsRoot, runId)
  if (!loc) return false
  return withLock(loc.id, async () => {
    try {
      await rm(loc.dir, { recursive: true, force: false })
      return true
    } catch (error) {
      if (error && error.code === 'ENOENT') return false
      throw error
    }
  })
}

function describeMetaError(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (code === 'EISDIR') return 'run.json 是目录'
  if (code === 'EACCES' || code === 'EPERM') return 'run.json 权限拒绝'
  if (code === 'ENOENT') return 'run.json 不存在'
  if (code === 'ENOTDIR') return 'run 目录路径异常（不是目录）'
  return `run.json 不可读（${code || '未知错误'}）`
}

/**
 * run 列表（按 startedAt 倒序）。§8.6：只读 run.json 的计数器，不逐 run 读事件。
 * 坏 run（run.json 是目录 / 权限拒绝 / 坏 JSON）跳过并记进 `skipped`，不让整表 500。
 *
 * @param {string} runsRoot
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ runs: object[], skipped: { id: string, reason: string }[] }>}
 */
export async function listRuns(runsRoot, options = {}) {
  let limit = 20
  if (options.limit !== undefined && options.limit !== null && options.limit !== '') {
    const value = typeof options.limit === 'string' ? Number(options.limit) : options.limit
    if (!Number.isInteger(value) || value < 1) throw new RunError(400, 'limit', '必须是正整数')
    limit = Math.min(value, 100)
  }
  const root = resolve(runsRoot)
  let dirents = []
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return { runs: [], skipped: [] }
    throw error
  }

  const runs = []
  const skipped = []
  for (const entry of dirents) {
    if (!entry.isDirectory() || !checkRunId(entry.name)) continue
    const loc = locate(root, entry.name)
    if (!loc) continue
    let meta
    try {
      meta = await readMetaUnlocked(loc)
    } catch (error) {
      skipped.push({ id: entry.name, reason: describeMetaError(error) })
      continue
    }
    if (!meta) {
      skipped.push({ id: entry.name, reason: 'run.json 缺失、为空或不是合法 JSON' })
      continue
    }
    runs.push({
      id: meta.id,
      name: meta.name,
      flowId: meta.flowId,
      flowName: meta.flowName,
      status: meta.status,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      nodeDone: meta.nodeDone,
      nodeTotal: meta.nodeTotal,
      tokenTotal: meta.tokenTotal,
      eventCount: meta.eventCount,
    })
  }

  runs.sort((a, b) => {
    const ta = Date.parse(a.startedAt)
    const tb = Date.parse(b.startedAt)
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta
    return String(b.startedAt).localeCompare(String(a.startedAt))
  })
  return { runs: runs.slice(0, limit), skipped }
}

/**
 * run 详情：元数据 + 节点 / attempt 索引（每个 attempt 的事件数与首末时间）。
 * @returns {Promise<{ run: object, nodes: object[], eventCount: number } | null>}
 */
export async function readRunDetail(runsRoot, runId) {
  const loc = locate(runsRoot, runId)
  if (!loc) return null
  let meta
  try {
    meta = await readMetaUnlocked(loc)
  } catch {
    return null
  }
  if (!meta) return null
  const all = await readAllEventsUnlocked(loc, meta)
  const nodes = new Map()

  for (const event of all.events) {
    if (typeof event.nodeId !== 'string' || !checkRunId(event.nodeId)) continue
    if (!nodes.has(event.nodeId)) nodes.set(event.nodeId, { nodeId: event.nodeId, attempts: new Map(), eventCount: 0 })
    const node = nodes.get(event.nodeId)
    node.eventCount += 1
    if (!Number.isInteger(event.attemptId)) continue
    if (!node.attempts.has(event.attemptId)) {
      node.attempts.set(event.attemptId, {
        attemptId: event.attemptId,
        eventCount: 0,
        firstTs: event.ts,
        lastTs: event.ts,
        status: null,
      })
    }
    const attempt = node.attempts.get(event.attemptId)
    attempt.eventCount += 1
    if (typeof event.ts === 'string') {
      if (!attempt.firstTs) attempt.firstTs = event.ts
      attempt.lastTs = event.ts
    }
    if (event.kind === 'node/end' && event.data && typeof event.data.status === 'string') {
      attempt.status = event.data.status
    }
  }

  const progress = computeProgress(all.events)
  return {
    run: {
      ...meta,
      // §8.3 / §8.6：nodeDone / tokenTotal 一律取 run.json 计数器，保证
      // GET /runs 与 GET /runs/<id> 同口径同值；progress 仅供核对。
      nodeDone: meta.nodeDone,
      tokenTotal: meta.tokenTotal,
      nodeTotal: meta.nodeTotal,
      progress: {
        passed: progress.passed,
        skipped: progress.skipped,
        failed: progress.failed,
        rejected: progress.rejected,
        invalidated: progress.invalidated,
        ratio: progress.ratio,
      },
    },
    nodes: [...nodes.values()]
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .map(node => ({
        nodeId: node.nodeId,
        eventCount: node.eventCount,
        attempts: [...node.attempts.values()].sort((a, b) => a.attemptId - b.attemptId),
      })),
    eventCount: all.events.length,
    skipped: all.skipped,
  }
}
