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
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  MAX_BATCH_EVENTS, MAX_EVENT_BYTES, MAX_RUN_EVENTS, checkRunId, computeProgress,
  normalizeEvent,
} from './runlog.js'
import { resolveHome } from './store.js'

/** run.json 的体积上限：元数据不该有成百上千行。 */
const MAX_META_BYTES = 1024 * 1024

/**
 * 06 §13.4：给 `run/start` / `run/end` 留的保留额度。
 * 普通事件最多用到 `MAX_RUN_EVENTS - 64`，保证任何致命失败都还有位置落终态。
 */
export const RESERVED_TERMINAL_EVENTS = 64
const NORMAL_EVENT_LIMIT = MAX_RUN_EVENTS - RESERVED_TERMINAL_EVENTS

/** §13.3 单写者租约文件（放在 run 目录里，0600）。 */
const LEASE_FILE = 'lock.json'
/** §13.4 写盘失败的侧车文件（GET /runs/<id> 会把它作为 storageError 返回）。 */
const ERROR_FILE = '.error'
/** 默认租约 TTL：引擎每 30s 续租，90s 过期（3 次心跳）。 */
export const DEFAULT_LEASE_TTL_MS = 90 * 1000

const TERMINAL_STATUS = new Set(['done', 'aborted', 'failed'])
const ALL_STATUS = new Set(['pending', 'running', 'done', 'aborted', 'failed'])

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

/** 06 §2：运行中的 live 视图（currentNodeId / attempt / round / since / lastEventSeq / phase）。 */
const LIVE_PHASES = new Set(['model', 'tool', 'spawn', 'idle'])

function normalizeLive(source) {
  if (!isPlainObject(source)) return null
  const live = {
    currentNodeId: typeof source.currentNodeId === 'string' && checkRunId(source.currentNodeId)
      ? source.currentNodeId
      : null,
    attempt: Number.isInteger(source.attempt) && source.attempt >= 0 ? source.attempt : 0,
    round: Number.isInteger(source.round) && source.round >= 0 ? source.round : 0,
    since: typeof source.since === 'string' && Number.isFinite(Date.parse(source.since))
      ? new Date(Date.parse(source.since)).toISOString()
      : null,
    lastEventSeq: Number.isInteger(source.lastEventSeq) && source.lastEventSeq >= 0
      ? source.lastEventSeq
      : 0,
    phase: LIVE_PHASES.has(source.phase) ? source.phase : 'idle',
  }
  return live
}

function normalizeMeta(raw, id) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const now = new Date().toISOString()
  const text = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback)
  const count = (value, fallback = 0) => (Number.isInteger(value) && value >= 0 ? value : fallback)
  const status = ALL_STATUS.has(source.status) ? source.status : 'running'
  const progress = normalizeProgress(source.progress)
  const hasProgress = isPlainObject(source.progress) && isPlainObject(source.progress.nodes)
  const lastSeq = Math.max(count(source.lastSeq, 0), count(source.seq, 0))
  const nodeTotal = count(source.nodeTotal)
  // 06 §13.2：`started` 是持久化的「开始过」标志，start 不再用 eventCount 猜。
  // 老 run.json（v0.3 没有 started 字段）按「有事件 / 已终态」推断，避免把从没跑过的
  // running 壳子误判成已开始。
  const started = source.started === true
    ? true
    : source.started === false
      ? false
      : (TERMINAL_STATUS.has(status) || count(source.eventCount) > 0 || lastSeq > 0)
  const engine = source.engine === 'stub' ? 'stub' : 'real'
  return {
    v: 1,
    id,
    name: text(source.name, id),
    flowId: text(source.flowId, ''),
    flowName: text(source.flowName, ''),
    status,
    started,
    engine,
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
    // 06 §2 / §10：live 随 run.json 原子写；结束后由引擎置 null。
    live: normalizeLive(source.live),
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
  const requestedEngine = input.engine === 'stub' ? 'stub' : 'real'
  const meta = normalizeMeta({
    name,
    flowId,
    flowName,
    // 06 §13.2：建出来只是 pending，真正开跑必须走 startRun()。
    status: 'pending',
    started: false,
    engine: requestedEngine,
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
 * 06 §13.2：把 `pending` 原子切成 `running`，并置持久化的 `started` 标志。
 * 不是 pending / 已经 started 一律 409（同一进程内由 withLock 串行化，两个并发 startRun
 * 只有一个能成功）。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {{ now?: Date }} [options]
 * @returns {Promise<object>} 写入后的 meta
 */
export async function startRun(runsRoot, runId, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  return withLock(loc.id, async () => {
    const meta = await readMetaUnlocked(loc)
    if (!meta) throw new RunError(404, 'runId', 'run 不存在')
    if (meta.started === true || meta.status !== 'pending') {
      throw new RunError(
        409,
        'runId',
        meta.started === true
          ? `run 已开始过（当前 ${meta.status}），v0.4 不支持断点续跑`
          : `run 不是 pending（当前 ${meta.status}），不能重复开始`,
      )
    }
    const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
      ? options.now
      : new Date()
    const next = normalizeMeta({
      ...meta,
      status: 'running',
      started: true,
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }, loc.id)
    return writeMetaUnlocked(loc, next)
  })
}

/**
 * 06 §13.3 单写者租约：`runs/<runId>/lock.json`（pid / host / heartbeatAt / ttlMs）。
 * 过期由读取方清理；`sweepExpiredLeases()` 会把过期租约的 running run 标 failed。
 */

function leasePath(dir) {
  return join(dir, LEASE_FILE)
}

function normalizeLease(raw) {
  if (!isPlainObject(raw)) return null
  const pid = Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null
  const host = typeof raw.host === 'string' && raw.host !== '' ? raw.host : null
  const heartbeatAt = typeof raw.heartbeatAt === 'string' && Number.isFinite(Date.parse(raw.heartbeatAt))
    ? new Date(Date.parse(raw.heartbeatAt)).toISOString()
    : null
  const ttlMs = Number.isInteger(raw.ttlMs) && raw.ttlMs > 0 ? raw.ttlMs : DEFAULT_LEASE_TTL_MS
  if (pid === null || host === null || heartbeatAt === null) return null
  const acquiredAt = typeof raw.acquiredAt === 'string' && Number.isFinite(Date.parse(raw.acquiredAt))
    ? new Date(Date.parse(raw.acquiredAt)).toISOString()
    : heartbeatAt
  return { pid, host, ttlMs, acquiredAt, heartbeatAt }
}

function leaseExpired(lease, now) {
  return Date.parse(lease.heartbeatAt) + lease.ttlMs <= now.getTime()
}

function leaseOwner(lease) {
  return `${lease.pid}@${lease.host}`
}

function leaseOwnerMatches(lease, options) {
  const pid = Number.isInteger(options.pid) && options.pid > 0 ? options.pid : process.pid
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : hostname()
  return lease.pid === pid && lease.host === host
}

async function readLeaseFile(dir) {
  let text
  try {
    text = await readFile(leasePath(dir), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  try {
    return normalizeLease(JSON.parse(text))
  } catch {
    return null
  }
}

async function writeLeaseFile(dir, lease) {
  await ensureDirMode(dir)
  const text = `${JSON.stringify(lease, null, 2)}\n`
  const tmp = `${leasePath(dir)}.tmp-${process.pid}-${tmpCounter++}`
  await writeFile(tmp, text, { encoding: 'utf8', mode: FILE_MODE })
  try {
    await rename(tmp, leasePath(dir))
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  await chmod(leasePath(dir), FILE_MODE).catch(() => {})
}

async function removeLeaseFile(dir, lease) {
  if (lease) {
    const current = await readLeaseFile(dir).catch(() => null)
    if (current && leaseOwner(current) !== leaseOwner(lease)) return false
  }
  try {
    await unlink(leasePath(dir))
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

function leaseOptions(options = {}) {
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
    ? options.now
    : new Date()
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0
    ? options.ttlMs
    : DEFAULT_LEASE_TTL_MS
  return {
    now,
    ttlMs,
    pid: Number.isInteger(options.pid) && options.pid > 0 ? options.pid : process.pid,
    host: typeof options.host === 'string' && options.host !== '' ? options.host : hostname(),
  }
}

/**
 * 读当前租约。过期租约视为不存在并顺手清掉；没有租约返回 null。
 * @returns {Promise<object | null>}
 */
export async function readLease(runsRoot, runId, options = {}) {
  const loc = locate(runsRoot, runId)
  if (!loc) return null
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date()
  const lease = await readLeaseFile(loc.dir).catch(() => null)
  if (!lease) return null
  if (leaseExpired(lease, now)) {
    await removeLeaseFile(loc.dir).catch(() => {})
    return null
  }
  return lease
}

/**
 * 抢单写者租约。已有**未过期**租约（任何持有者）一律 409；过期租约可被抢。
 * 同一 run 的 claim 在进程内串行化。
 * @returns {Promise<object>} 新租约
 */
export async function claimLease(runsRoot, runId, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  const { now, ttlMs, pid, host } = leaseOptions(options)
  return withLock(loc.id, async () => {
    const existing = await readLeaseFile(loc.dir)
    if (existing && !leaseExpired(existing, now)) {
      throw new RunError(
        409,
        'runId',
        `该 run 正被 ${leaseOwner(existing)} 持有执行租约（心跳 ${existing.heartbeatAt}），不能重复启动`,
      )
    }
    const iso = now.toISOString()
    const lease = { pid, host, ttlMs, acquiredAt: iso, heartbeatAt: iso }
    await writeLeaseFile(loc.dir, lease)
    return lease
  })
}

/**
 * 续租。租约不存在 / 已过期 / 不是本进程持有 → 409。
 * @returns {Promise<object>} 续租后的租约
 */
export async function renewLease(runsRoot, runId, options = {}) {
  const loc = requireLoc(runsRoot, runId)
  const { now, ttlMs, pid, host } = leaseOptions(options)
  return withLock(loc.id, async () => {
    const existing = await readLeaseFile(loc.dir)
    if (!existing) throw new RunError(409, 'runId', '该 run 没有执行租约，无法续租')
    if (leaseExpired(existing, now)) {
      await removeLeaseFile(loc.dir).catch(() => {})
      throw new RunError(409, 'runId', '执行租约已过期（引擎可能已中断），不能续租')
    }
    if (!leaseOwnerMatches(existing, { pid, host })) {
      throw new RunError(409, 'runId', `执行租约由 ${leaseOwner(existing)} 持有，本实例无权续租`)
    }
    const lease = {
      ...existing,
      ttlMs,
      heartbeatAt: now.toISOString(),
    }
    await writeLeaseFile(loc.dir, lease)
    return lease
  })
}

/**
 * 释放租约；只能释放本实例持有的（`force:true` 可强制清）。
 * @returns {Promise<boolean>} 是否真的删掉
 */
export async function releaseLease(runsRoot, runId, options = {}) {
  const loc = locate(runsRoot, runId)
  if (!loc) return false
  return withLock(loc.id, async () => {
    const existing = await readLeaseFile(loc.dir)
    if (!existing) return false
    if (options.force !== true && !leaseOwnerMatches(existing, options)) {
      throw new RunError(409, 'runId', `执行租约由 ${leaseOwner(existing)} 持有，不能由本实例释放`)
    }
    return removeLeaseFile(loc.dir)
  })
}

/**
 * 启动时清理过期租约：**只扫 `running`**，把租约过期（引擎崩溃）的 run 标 failed，
 * reason 含「引擎中断」。返回被处理的 runId。
 * @returns {Promise<string[]>}
 */
export async function sweepExpiredLeases(runsRoot, options = {}) {
  const root = resolve(runsRoot)
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date()
  let dirents = []
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const recovered = []
  for (const entry of dirents) {
    if (!entry.isDirectory() || !checkRunId(entry.name)) continue
    const loc = locate(root, entry.name)
    if (!loc) continue
    const meta = await readMetaUnlocked(loc).catch(() => null)
    if (!meta || meta.status !== 'running') continue
    const lease = await readLeaseFile(loc.dir).catch(() => null)
    if (!lease || !leaseExpired(lease, now)) continue
    const reason = `引擎中断：执行租约过期（${leaseOwner(lease)}，心跳 ${lease.heartbeatAt}），不自动续跑`
    try {
      await appendEvents(runsRoot, loc.id, [{
        v: 1,
        kind: 'run/end',
        traceId: `tr-${loc.id.slice(0, 80)}-sweep`,
        data: { status: 'failed', reason: reason.slice(0, 2000) },
        extra: { recovered: true, engineInterrupted: true, leaseExpired: true },
      }], { now })
    } catch (error) {
      await markStorageFailure(loc, error).catch(() => {})
      await writeRunMeta(runsRoot, loc.id, {
        status: 'failed',
        endedAt: now.toISOString(),
        live: null,
      }).catch(() => {})
    }
    await removeLeaseFile(loc.dir, lease).catch(() => {})
    recovered.push(loc.id)
  }
  return recovered
}

/**
 * 06 §13.4：启动时修复「run.jsonl 已经有 run/end，但 run.json 还是非终态」的不一致。
 * 只读 run.jsonl（不碰节点文件），返回修复过的 runId。
 * @returns {Promise<string[]>}
 */
export async function repairRunStates(runsRoot, options = {}) {
  const root = resolve(runsRoot)
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date()
  let dirents = []
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const repaired = []
  for (const entry of dirents) {
    if (!entry.isDirectory() || !checkRunId(entry.name)) continue
    const loc = locate(root, entry.name)
    if (!loc) continue
    const meta = await readMetaUnlocked(loc).catch(() => null)
    if (!meta || TERMINAL_STATUS.has(meta.status)) continue
    let text
    try {
      text = await readFile(join(loc.dir, 'run.jsonl'), 'utf8')
    } catch {
      continue
    }
    let lastEnd = null
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let event
      try {
        event = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (event && event.kind === 'run/end' && event.data && TERMINAL_STATUS.has(event.data.status)) {
        lastEnd = event
      }
    }
    if (!lastEnd) continue
    const endedAt = typeof lastEnd.ts === 'string' && Number.isFinite(Date.parse(lastEnd.ts))
      ? new Date(Date.parse(lastEnd.ts)).toISOString()
      : now.toISOString()
    await withLock(loc.id, async () => {
      const fresh = await readMetaUnlocked(loc)
      if (!fresh || TERMINAL_STATUS.has(fresh.status)) return
      await writeMetaUnlocked(loc, normalizeMeta({
        ...fresh,
        status: lastEnd.data.status,
        started: true,
        endedAt,
        live: null,
        updatedAt: now.toISOString(),
      }, loc.id))
    })
    repaired.push(loc.id)
  }
  return repaired
}

/** 写 `.error` 侧车文件：写盘失败时给 GET /runs/<id> 一个可读的 storageError。 */
async function markStorageFailure(loc, error) {
  const raw = error && error.message ? String(error.message) : String(error)
  // 侧车会被 GET /runs/<id> 返回，先把内部绝对路径压掉（§8.5）。
  const sanitized = raw.split(loc.root).join('<runs>').slice(0, 2000)
  const payload = {
    at: new Date().toISOString(),
    error: sanitized,
    code: error && typeof error.code === 'string' ? error.code : null,
  }
  const text = `${JSON.stringify(payload)}\n`
  const tmp = join(loc.dir, `${ERROR_FILE}.tmp-${process.pid}-${tmpCounter++}`)
  await writeFile(tmp, text, { encoding: 'utf8', mode: FILE_MODE })
  await rename(tmp, join(loc.dir, ERROR_FILE))
  await chmod(join(loc.dir, ERROR_FILE), FILE_MODE).catch(() => {})
}

async function readStorageError(dir) {
  let text
  try {
    text = await readFile(join(dir, ERROR_FILE), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    return { at: null, error: '读 .error 侧车文件失败', code: error && error.code ? error.code : null }
  }
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : { at: null, error: text.trim().slice(0, 2000), code: null }
  } catch {
    return { at: null, error: text.trim().slice(0, 2000), code: null }
  }
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

/** 列出 run 目录里所有事件文件（run.jsonl + 每个 node 的 attempt 文件）。 */
async function listEventFiles(loc) {
  const files = []
  const rootFile = join(loc.dir, 'run.jsonl')
  try {
    const info = await stat(rootFile)
    if (info.isFile()) files.push(rootFile)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
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
    let entries = []
    try {
      entries = await readdir(nodePath, { withFileTypes: true })
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
      continue
    }
    const names = entries
      .filter(entry => entry.isFile() && ATTEMPT_FILE.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    for (const name of names) files.push(join(nodePath, name))
  }
  return files
}

/**
 * 单文件倒序行迭代器：从文件尾部按块读，逐行倒着吐。
 * 不把整个文件读进内存，也不会先解析前面的行（06 §13.7 / 05 §8.6 的读放大要求）。
 */
function makeReverseLineIterator(path) {
  let handle = null
  let pos = 0
  let pending = ''
  let bytes = 0
  const buffer = []
  const CHUNK = 64 * 1024

  async function openOnce() {
    if (handle !== null) return
    handle = await open(path, 'r')
    const info = await handle.stat()
    pos = info.size
  }

  async function fill() {
    await openOnce()
    while (buffer.length === 0 && pos > 0) {
      const start = Math.max(0, pos - CHUNK)
      const size = pos - start
      const chunk = Buffer.allocUnsafe(size)
      let offset = 0
      while (offset < size) {
        const { bytesRead } = await handle.read(chunk, offset, size - offset, start + offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      bytes += offset
      pos = start
      const text = chunk.subarray(0, offset).toString('utf8') + pending
      const parts = text.split('\n')
      // start > 0 时第一段可能是被切断的半行，留到下一块拼接。
      pending = pos > 0 ? parts.shift() : ''
      for (const part of parts) {
        const line = part.trim()
        if (line !== '') buffer.push(line)
      }
    }
    if (buffer.length === 0 && pending.trim() !== '') {
      buffer.push(pending.trim())
      pending = ''
    }
  }

  return {
    get bytesRead() {
      return bytes
    },
    async next() {
      await fill()
      if (buffer.length === 0) return null
      const line = buffer.pop()
      try {
        const event = JSON.parse(line)
        if (event !== null && typeof event === 'object' && !Array.isArray(event)) return { event }
        return { event: null }
      } catch {
        return { event: null }
      }
    },
    async close() {
      if (handle !== null) {
        await handle.close().catch(() => {})
        handle = null
      }
    },
  }
}

function matchesFilters(event, filters) {
  if (!event) return false
  if (filters.nodeId && event.nodeId !== filters.nodeId) return false
  if (filters.attemptId !== undefined && event.attemptId !== filters.attemptId) return false
  if (filters.kinds && !filters.kinds.has(event.kind)) return false
  if (filters.since && filters.since.type === 'seq') {
    if (!Number.isFinite(event.seq) || event.seq <= filters.since.value) return false
  }
  if (filters.sinceTs !== null) {
    const ts = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN
    if (!Number.isFinite(ts) || ts <= filters.sinceTs) return false
  }
  return true
}

function eventOrder(event) {
  const seq = Number.isInteger(event && event.seq) ? event.seq : -1
  const ts = typeof event?.ts === 'string' ? Date.parse(event.ts) : Number.NaN
  return { seq, ts: Number.isFinite(ts) ? ts : -1 }
}

/**
 * `order=desc` 的尾部倒读：各文件同时从末尾取一条，做 k 路归并取最大 seq。
 * 取够 limit 条就停——此时未读事件都在各文件头部之前，seq 不会大于已取的最小值，
 * 所以结果就是全局最新的 limit 条，不需要全量解析。
 */
async function readEventsTail(loc, meta, filters) {
  const files = await listEventFiles(loc)
  const iterators = files.map(file => makeReverseLineIterator(file))
  const matched = []
  let scanned = 0
  let skipped = 0
  let exhausted = false
  try {
    while (matched.length < filters.limit) {
      let bestIndex = -1
      let bestSeq = -Infinity
      let bestTs = -Infinity
      for (let index = 0; index < iterators.length; index += 1) {
        const iterator = iterators[index]
        if (iterator.done) continue
        if (iterator.head === undefined) {
          iterator.head = await iterator.next()
          if (iterator.head === null) {
            iterator.done = true
            continue
          }
        }
        const order = eventOrder(iterator.head.event)
        if (bestIndex === -1 || order.seq > bestSeq || (order.seq === bestSeq && order.ts > bestTs)) {
          bestIndex = index
          bestSeq = order.seq
          bestTs = order.ts
        }
      }
      if (bestIndex === -1) {
        exhausted = true
        break
      }
      const iterator = iterators[bestIndex]
      const item = iterator.head
      iterator.head = undefined
      scanned += 1
      if (!item.event) {
        skipped += 1
        continue
      }
      // 该文件剩余事件 seq 只会更小（文件内按 seq 递增追加），可以安全收工。
      if (filters.since && filters.since.type === 'seq'
        && Number.isFinite(item.event.seq) && item.event.seq <= filters.since.value) {
        exhausted = true
        break
      }
      if (matchesFilters(item.event, filters)) matched.push(item.event)
    }
  } finally {
    for (const iterator of iterators) await iterator.close()
  }
  const scannedBytes = iterators.reduce((sum, iterator) => sum + iterator.bytesRead, 0)
  const hasFilters = Boolean(filters.nodeId || filters.attemptId !== undefined || filters.kinds || filters.since)
  let total
  let truncated
  let totalExact
  if (exhausted) {
    total = matched.length
    truncated = false
    totalExact = true
  } else if (!hasFilters) {
    // 无过滤时 run.json 的 eventCount 就是精确总数，不必再扫一遍。
    total = Math.max(meta.eventCount, matched.length)
    truncated = true
    totalExact = true
  } else {
    // 有过滤且提前停：total 是「已读到的匹配数」（≥ limit），truncated 明确表示还有未读区间。
    total = matched.length
    truncated = true
    totalExact = false
  }
  return {
    events: matched,
    total,
    totalExact,
    truncated,
    skipped: exhausted ? skipped : 0,
    scannedEvents: scanned,
    scannedBytes,
    tail: true,
  }
}

/**
 * 读事件流：过滤 + 分页 + 排序。
 *
 * `order=desc` 走尾部倒读（只解析需要的尾部），`order=asc` 仍旧全量读后正序分页。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {{ nodeId?: string, attemptId?: number, kinds?: string[], since?: number|string, limit?: number, order?: 'asc'|'desc' }} [options]
 * @returns {Promise<{ events: object[], total: number, truncated: boolean, skipped: number } | null>}
 */
export async function readEvents(runsRoot, runId, options = {}) {
  const loc = locate(runsRoot, runId)
  if (!loc) return null
  let meta
  try {
    meta = await readMetaUnlocked(loc)
  } catch {
    return null
  }
  if (!meta) return null

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
  const filters = { nodeId, attemptId, kinds, since, sinceTs, limit }

  if (order === 'desc') {
    return readEventsTail(loc, meta, filters)
  }

  const all = await readAllEventsUnlocked(loc, meta)
  const filtered = all.events.filter(event => matchesFilters(event, filters))
  const total = filtered.length
  return {
    events: filtered.slice(0, limit),
    total,
    totalExact: true,
    truncated: total > limit,
    skipped: all.skipped,
    scannedEvents: all.events.length,
    scannedBytes: null,
    tail: false,
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
    // 06 §13.4：普通事件不得占用 run/start / run/end 的保留额度。
    const ordinaryCount = normalized.filter(event => !RUN_LEVEL_KINDS.has(event.kind)).length
    if (ordinaryCount > 0 && meta.eventCount + normalized.length > NORMAL_EVENT_LIMIT) {
      throw new RunError(
        400,
        'events',
        `普通事件已达保留额度上限 ${NORMAL_EVENT_LIMIT}（总上限 ${MAX_RUN_EVENTS}，其中 ${RESERVED_TERMINAL_EVENTS} 条留给 run/start、run/end）`
          + `；已有 ${meta.eventCount}，本批普通事件 ${ordinaryCount}`,
      )
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

    try {
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
          if (event.data.engine === 'stub' || event.data.engine === 'real') meta.engine = event.data.engine
          // 防御式兼容：老引擎直接写 run/start 而不调 startRun() 时，也把 pending 切成 running，
          // 否则 sweep / 列表会把一个已经在跑的 run 当成没开始。新引擎仍应显式调 startRun()。
          if (meta.status === 'pending' && meta.started !== true) {
            meta.status = 'running'
            meta.started = true
            meta.startedAt = typeof event.ts === 'string' ? event.ts : now.toISOString()
          }
          continue
        }
        if (event.kind === 'run/end') {
          if (TERMINAL_STATUS.has(event.data.status)) meta.status = event.data.status
          meta.started = true
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
    } catch (error) {
      // 06 §13.4：写盘失败也必须能落终态——原子改 run.json 为 failed + 写 .error 侧车。
      await markStorageFailure(loc, error).catch(() => {})
      const failedMeta = normalizeMeta({
        ...meta,
        status: 'failed',
        started: true,
        endedAt: now.toISOString(),
        live: null,
        updatedAt: now.toISOString(),
      }, loc.id)
      await writeMetaUnlocked(loc, failedMeta).catch(() => {})
      if (error instanceof RunError) throw error
      // 不回原始错误信息（可能带宿主绝对路径），细节在 .error 侧车里。
      throw new RunError(500, 'storage', '事件写盘失败，run 已被原子标记为 failed（细节见 .error 侧车文件）')
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
      started: meta.started,
      engine: meta.engine,
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
  const storageError = await readStorageError(loc.dir)
  return {
    run: {
      ...meta,
      ...(storageError ? { storageError } : {}),
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
        invalidatedNodes: progress.invalidatedNodes,
        // B1：详情接口也要带每节点状态——只回计数会让客户端拿不到 nodes、
        // 长跑或事件窗口被截断时只能退回事件窗口推导，已通过的节点会显示成未开始。
        nodes: progress.nodes,
        total: progress.total,
        observed: progress.observed,
        denominator: progress.denominator,
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
