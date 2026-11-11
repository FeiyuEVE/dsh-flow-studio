/**
 * 实例资源记录（0.13.7 C）：worktree 所有权记录、生命周期锁、独立资源事件。
 *
 * 布局（`<flow-studio>` 是 definitions/instances 的父目录）：
 * ```
 * worktree-registry/<workspaceId>/<instanceId>.json   宿主所有权记录（不放工作树里）
 * instances/<instanceId>/workspace.json               实例冻结的工作区快照
 * instances/<instanceId>/resources/state.json         资源事件序号（独立 resourceSeq）
 * instances/<instanceId>/resources/events.jsonl       资源事件（append-only）
 * instances/<instanceId>/resources/.lock              资源临界区锁
 * ```
 *
 * 硬规则：
 *   - 记录 / 快照 / 序号都原子写（临时文件 + rename，0600）；
 *   - 资源事件**不碰**执行事件 `events/`，`resourceSeq` 也独立分配；
 *   - 终态实例仍可追加资源事件（清理结果要留痕），但执行事件仍由 instance-store 封口；
 *   - 记录损坏显式报 `RESOURCE_RECORD_CORRUPT`，不静默跳过（prune 必须能据此停手）。
 *
 * @module @feiyueve/dsh-flow-studio/instance-resources
 */

import { randomBytes } from 'node:crypto'
import {
  chmod, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, utimes, writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** 资源记录版本。 */
export const RESOURCE_RECORD_VERSION = 1
/** 资源事件状态文件版本。 */
export const RESOURCE_STATE_VERSION = 1

/** `resourceState` 是**资源记录状态**，不是实例状态。 */
export const RESOURCE_STATE = Object.freeze({
  READY: 'ready',
  REMOVING: 'removing',
  REMOVED: 'removed',
  BLOCKED: 'blocked',
})

/** 清理策略（与实例启动选项同口径）。 */
export const CLEANUP_POLICIES = Object.freeze(['retain', 'on-terminal-clean'])
export const CLEANUP_POLICY_SET = new Set(CLEANUP_POLICIES)

/** 资源事件类型（独立于执行事件的 kind）。 */
export const RESOURCE_EVENT = Object.freeze({
  WORKTREE_READY: 'worktree/ready',
  WORKTREE_REMOVE: 'worktree/removed',
  WORKTREE_REMOVE_SKIPPED: 'worktree/remove-skipped',
  BRANCH_REMOVE: 'worktree/branch-removed',
  BRANCH_REMOVE_SKIPPED: 'worktree/branch-remove-skipped',
  CLEANUP_SKIPPED: 'worktree/cleanup-skipped',
})

/** 对外错误码。 */
export const RESOURCE_ERROR = Object.freeze({
  INVALID: 'RESOURCE_INVALID',
  INVALID_ID: 'RESOURCE_ID_INVALID',
  RECORD_INVALID: 'RESOURCE_RECORD_INVALID',
  RECORD_CORRUPT: 'RESOURCE_RECORD_CORRUPT',
  SNAPSHOT_CORRUPT: 'RESOURCE_SNAPSHOT_CORRUPT',
  LOCK_TIMEOUT: 'RESOURCE_LOCK_TIMEOUT',
  WRITE_FAILED: 'RESOURCE_WRITE_FAILED',
})

export const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const WORKSPACE_ID_PATTERN = /^[0-9a-f]{12}$/
const HASH_COMMIT_PATTERN = /^[0-9a-f]{40,64}$/i
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T/

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const MAX_RECORD_BYTES = 64 * 1024
const MAX_RESOURCE_EVENT_BYTES = 8 * 1024
const LOCK_TTL_MS = 10 * 1000
const LOCK_WAIT_MS = 15 * 1000

let tmpCounter = 0

const sleep = ms => new Promise(resolveSleep => { setTimeout(resolveSleep, ms) })

/** 带 code 的资源错误。 */
export class ResourceError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ResourceError'
    this.code = code
    Object.assign(this, extra)
  }

  toPayload() {
    return { ok: false, code: this.code, error: this.message }
  }
}

function fail(code, message, extra) {
  return new ResourceError(code, message, extra)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/** `<base>` 下的 worktrees 根。 */
export function worktreesRootFor(base) {
  return join(resolve(base), 'worktrees')
}

/** `<base>` 下的 worktree 所有权记录根。 */
export function registryRootFor(base) {
  return join(resolve(base), 'worktree-registry')
}

/** `<base>` 下的 artifact 快照根。 */
export function artifactsRootFor(base) {
  return join(resolve(base), 'artifacts')
}

/** 单个实例的 workspace 冻结快照路径。 */
export function workspaceSnapshotPath(instancesRoot, instanceId) {
  const id = requireInstanceId(instanceId)
  return join(resolve(instancesRoot), id, 'workspace.json')
}

/** 单个实例的资源目录。 */
export function resourceDirFor(instancesRoot, instanceId) {
  const id = requireInstanceId(instanceId)
  return join(resolve(instancesRoot), id, 'resources')
}

/** 资源事件文件路径。 */
export function resourceEventsPath(instancesRoot, instanceId) {
  return join(resourceDirFor(instancesRoot, instanceId), 'events.jsonl')
}

function requireInstanceId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!RESOURCE_ID_PATTERN.test(text) || text === '.' || text === '..' || text.startsWith('.')) {
    throw fail(RESOURCE_ERROR.INVALID_ID, `instanceId 非法：${String(value)}`)
  }
  return text
}

function requireWorkspaceId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!WORKSPACE_ID_PATTERN.test(text)) {
    throw fail(RESOURCE_ERROR.INVALID_ID, `workspaceId 必须是 12 位小写十六进制：${String(value)}`)
  }
  return text
}

function requireAbsolute(value, field) {
  const text = textOf(value)
  if (text === '' || !isAbsolute(text)) {
    throw fail(RESOURCE_ERROR.RECORD_INVALID, `资源记录的 ${field} 必须是绝对路径：${String(value)}`)
  }
  return resolve(text)
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  await chmod(dir, DIR_MODE).catch(error => {
    if (!error || error.code !== 'ENOENT') throw error
  })
}

async function writeTextAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
  let renamed = false
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: FILE_MODE })
    await rename(tmp, path)
    renamed = true
    await chmod(path, FILE_MODE).catch(() => {})
  } catch (error) {
    throw fail(RESOURCE_ERROR.WRITE_FAILED, `原子写失败：${error?.message ?? error}`, { path, cause: error })
  } finally {
    if (!renamed) await unlink(tmp).catch(() => {})
  }
}

/** 资源锁内容格式版本。 */
export const RESOURCE_LOCK_VERSION = 1

/** pid 是否仍存活：ESRCH = 已退出；EPERM = 存在但无权限（按存活处理）。 */
function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

/**
 * 读锁的持有者事实。
 *
 * 新格式是 `{v, owner, pid, at}`：
 *   - **活进程持有的锁不因 TTL 被抢占**（只有 pid 不存在才算 stale）；
 *   - 无法识别持有者（旧格式 / 半截写入）才退回 mtime TTL。
 */
async function readLockSnapshot(lockPath, ttlMs) {
  let info
  try {
    info = await lstat(lockPath)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  let text = ''
  try {
    text = await readFile(lockPath, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  let owner = parsed && typeof parsed === 'object' && typeof parsed.owner === 'string' ? parsed.owner : null
  let pid = parsed && typeof parsed === 'object' && Number.isSafeInteger(parsed.pid) ? parsed.pid : null
  if (pid === null) {
    // 兼容旧格式：首行是 pid。
    const first = text.split('\n')[0].trim()
    if (/^\d+$/.test(first)) pid = Number(first)
    if (pid !== null) owner = null
  }
  const ageMs = Date.now() - info.mtimeMs
  const recognized = owner !== null && pid !== null
  let stale = false
  let reason = ''
  if (recognized) {
    if (!pidIsAlive(pid)) {
      stale = true
      reason = 'pid-dead'
    }
  } else if (ageMs > ttlMs) {
    // 无法证明持有者还活着：超过 TTL 的半截 / 旧锁按 stale 处理。
    stale = true
    reason = 'unrecognized-ttl'
  }
  return { info, owner, pid, recognized, ageMs, stale, reason }
}

/**
 * 抢占 stale 锁：先在**抢占互斥**（`<lock>.steal`）里复核锁 inode，再把同一
 * inode 的旧锁搬走并删除。
 *
 * 旧实现「先 lstat、再 rename、发现搬错就尽量放回」有一个确定的 ABA：
 * B 读到旧死锁 inode → A 抢占成功并建了新锁 → B 迟到的 rename 把 A 的新锁搬走
 * → C 在空窗拿锁 → B 发现 inode 不符、放回失败后仍删掉 parking 里的 A 锁
 * （review-0139 F4：`activeTasks=[A,C]`，A 的锁消失）。
 *
 * 现在所有抢占者先串行拿 `<lock>.steal`，再复核“仍是同一 inode 且仍 stale”。
 * 复核后到 rename 之间不会再有别的抢占者插进来；而锁的当前持有者若还活着，
 * 复核会直接放弃。搬错（理论上不可达）也**绝不删除** parking，只返回失败。
 */
async function stealStaleLock(lockPath, snapshot, ttlMs, hooks) {
  const guard = await acquireStealGuard(lockPath, ttlMs)
  if (guard === null) return false
  try {
    const current = await readLockSnapshot(lockPath, ttlMs)
    if (current === null) return true
    if (!current.stale) return false
    if (current.info.ino !== snapshot.info.ino || current.info.dev !== snapshot.info.dev) return false
    if (typeof hooks?.beforeStealRemove === 'function') {
      await hooks.beforeStealRemove({ lockPath })
    }
    const parking = `${lockPath}.stale-${process.pid}-${tmpCounter++}-${randomBytes(4).toString('hex')}`
    try {
      await rename(lockPath, parking)
    } catch (error) {
      if (error && error.code === 'ENOENT') return true
      return false
    }
    let moved
    try {
      moved = await lstat(parking)
    } catch {
      return true
    }
    if (moved.ino !== snapshot.info.ino || moved.dev !== snapshot.info.dev) {
      // 复核之后仍搬错：不 link 回去（那会再次移动继任者的锁），也不删除 parking。
      // 让这份复制留在私有路径上，至少不会破坏当前 lockPath 的互斥。
      return false
    }
    await unlink(parking).catch(() => {})
    return true
  } finally {
    await guard.release()
  }
}

/**
 * 抢占互斥：`<lock>.steal` 的短临界区，只保护「复核 + 搬走 stale 锁」。
 * guard 自己带 pid，活进程持有不会被 TTL 抢；崩溃留下的 guard 只有 pid 不存在
 * 或超过 TTL 才清掉。
 */
async function acquireStealGuard(lockPath, ttlMs) {
  const guardPath = `${lockPath}.steal`
  const waitMs = Math.max(250, Math.min(ttlMs, 2_000))
  const deadline = Date.now() + waitMs
  const owner = `guard-${process.pid}-${randomBytes(6).toString('hex')}`
  for (;;) {
    let handle = null
    try {
      handle = await open(guardPath, 'wx', FILE_MODE)
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return null
      const snapshot = await readLockSnapshot(guardPath, ttlMs)
      if (snapshot === null) continue
      if (snapshot.stale) {
        await unlink(guardPath).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) return null
      await sleep(2)
      continue
    }
    let ino
    let dev
    try {
      const info = await handle.stat()
      ino = info.ino
      dev = info.dev
      await handle.writeFile(
        `${JSON.stringify({ v: RESOURCE_LOCK_VERSION, owner, pid: process.pid, at: new Date().toISOString() })}\n`,
        'utf8',
      )
    } finally {
      await handle.close().catch(() => {})
    }
    return {
      async release() {
        try {
          const info = await lstat(guardPath)
          if (info.ino === ino && info.dev === dev) await unlink(guardPath)
        } catch {
          // 已被清掉 / 被替换：不是我们的 guard 就不动。
        }
      },
    }
  }
}

/** 只有「inode 未变 + owner token 一致」的持有者才能释放锁。 */
async function releaseOwnedLock(lockPath, owner, ino, dev) {
  if (ino === undefined || dev === undefined) return false
  let info
  try {
    info = await lstat(lockPath)
  } catch {
    return false
  }
  if (info.isSymbolicLink() || info.ino !== ino || info.dev !== dev) return false
  let parsed = null
  try {
    parsed = JSON.parse(await readFile(lockPath, 'utf8'))
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || parsed.owner !== owner) return false
  await unlink(lockPath).catch(() => {})
  return true
}

/**
 * 跨进程粗粒度锁：`open(lock, 'wx')` + owner token + pid + 心跳。
 *
 * - 持有者内容带 `owner`（随机 token）与 `pid`，并周期性 touch mtime 续租；
 * - **活进程持有的锁不会被 TTL 抢占**；只有 pid 不存在（或无法识别的旧锁超过 TTL）
 *   才按 stale 处理（review-0137 W7）；
 * - 释放时比对 inode + owner token：旧持有者不会删掉继任者的锁；
 * - 等待超时报 LOCK_TIMEOUT。
 *
 * @param {string} lockPath
 * @param {() => Promise<any>} task
 * @param {{ttlMs?:number, waitMs?:number}} [options]
 */
export async function withResourceLock(lockPath, task, options = {}) {
  if (typeof task !== 'function') {
    throw fail(RESOURCE_ERROR.INVALID, 'withResourceLock 需要 task 函数')
  }
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : LOCK_TTL_MS
  const waitMs = Number.isSafeInteger(options.waitMs) && options.waitMs > 0 ? options.waitMs : LOCK_WAIT_MS
  await ensureDir(dirname(lockPath))
  const startedAt = Date.now()
  const owner = `${process.pid}-${randomBytes(8).toString('hex')}`
  const hooks = isPlainObject(options.hooks) ? options.hooks : null
  for (;;) {
    let handle = null
    try {
      handle = await open(lockPath, 'wx', FILE_MODE)
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      const snapshot = await readLockSnapshot(lockPath, ttlMs)
      if (snapshot === null) continue
      if (snapshot.stale) {
        if (typeof hooks?.beforeSteal === 'function') await hooks.beforeSteal({ lockPath, snapshot })
        const stolen = await stealStaleLock(lockPath, snapshot, ttlMs, hooks)
        // 抢占失败（锁刚被换掉 / 权限问题）也要退避，不能空转成忙等。
        if (!stolen) {
          if (Date.now() - startedAt >= waitMs) {
            throw fail(RESOURCE_ERROR.LOCK_TIMEOUT, `等待资源锁超时（${waitMs}ms）：${lockPath}`, { path: lockPath })
          }
          await sleep(20)
        }
        continue
      }
      if (Date.now() - startedAt >= waitMs) {
        throw fail(RESOURCE_ERROR.LOCK_TIMEOUT, `等待资源锁超时（${waitMs}ms）：${lockPath}`, { path: lockPath })
      }
      await sleep(20)
      continue
    }
    let ino
    let dev
    let heartbeat = null
    try {
      const info = await handle.stat()
      ino = info.ino
      dev = info.dev
      await handle.writeFile(
        `${JSON.stringify({ v: RESOURCE_LOCK_VERSION, owner, pid: process.pid, at: new Date().toISOString() })}\n`,
        'utf8',
      )
      // 心跳：只 touch mtime（不动 token 内容），避免读写内容时出现半截 JSON。
      heartbeat = setInterval(() => {
        utimes(lockPath, new Date(), new Date()).catch(() => {})
      }, Math.max(25, Math.floor(ttlMs / 3)))
      heartbeat.unref?.()
      return await task()
    } finally {
      if (heartbeat !== null) clearInterval(heartbeat)
      await handle.close().catch(() => {})
      await releaseOwnedLock(lockPath, owner, ino, dev)
    }
  }
}

/** 资源记录形状校验（读 / 写共用）。 */
export function normalizeResourceRecord(raw) {
  if (!isPlainObject(raw)) {
    throw fail(RESOURCE_ERROR.RECORD_INVALID, '资源记录必须是 JSON 对象')
  }
  if (raw.v !== RESOURCE_RECORD_VERSION) {
    throw fail(RESOURCE_ERROR.RECORD_INVALID, `资源记录版本必须是 v=${RESOURCE_RECORD_VERSION}`)
  }
  const instanceId = requireInstanceId(raw.instanceId)
  const workspaceId = requireWorkspaceId(raw.workspaceId)
  const repositoryRoot = requireAbsolute(raw.repositoryRoot, 'repositoryRoot')
  const effectiveRoot = requireAbsolute(raw.effectiveRoot, 'effectiveRoot')
  const branch = textOf(raw.branch)
  if (branch === '' || branch.length > 255 || branch.startsWith('-') || /\s/.test(branch)) {
    throw fail(RESOURCE_ERROR.RECORD_INVALID, `资源记录的 branch 非法：${String(raw.branch)}`)
  }
  const baseCommit = raw.baseCommit === null || raw.baseCommit === undefined
    ? null
    : (typeof raw.baseCommit === 'string' && HASH_COMMIT_PATTERN.test(raw.baseCommit)
      ? raw.baseCommit.toLowerCase()
      : null)
  if (raw.baseCommit !== null && raw.baseCommit !== undefined && baseCommit === null) {
    throw fail(RESOURCE_ERROR.RECORD_INVALID, '资源记录的 baseCommit 必须是 40–64 位十六进制或 null')
  }
  const cleanupPolicy = typeof raw.cleanupPolicy === 'string' && CLEANUP_POLICY_SET.has(raw.cleanupPolicy)
    ? raw.cleanupPolicy
    : 'retain'
  const resourceState = typeof raw.resourceState === 'string'
    && Object.values(RESOURCE_STATE).includes(raw.resourceState)
    ? raw.resourceState
    : RESOURCE_STATE.READY
  const createdAt = typeof raw.createdAt === 'string' && ISO_PATTERN.test(raw.createdAt)
    ? raw.createdAt
    : new Date().toISOString()
  return {
    v: RESOURCE_RECORD_VERSION,
    instanceId,
    workspaceId,
    repositoryRoot,
    effectiveRoot,
    branch,
    baseCommit,
    cleanupPolicy,
    resourceState,
    createdAt,
  }
}

function recordPath({ registryRoot, workspaceId, instanceId }) {
  const ws = requireWorkspaceId(workspaceId)
  const id = requireInstanceId(instanceId)
  return join(resolve(registryRoot), ws, `${id}.json`)
}

/**
 * 读一份所有权记录；不存在返回 null，损坏抛 RECORD_CORRUPT。
 */
export async function readResourceRecord({ registryRoot, workspaceId, instanceId } = {}) {
  if (typeof registryRoot !== 'string' || registryRoot.trim() === '') {
    throw fail(RESOURCE_ERROR.INVALID, 'readResourceRecord 需要 registryRoot')
  }
  const path = recordPath({ registryRoot, workspaceId, instanceId })
  let text
  try {
    const info = await stat(path)
    if (info.size > MAX_RECORD_BYTES) {
      throw fail(RESOURCE_ERROR.RECORD_CORRUPT, `资源记录超过 ${MAX_RECORD_BYTES} 字节上限`, { path })
    }
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    if (error instanceof ResourceError) throw error
    throw fail(RESOURCE_ERROR.RECORD_CORRUPT, `读取资源记录失败：${error?.message ?? error}`, { path, cause: error })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw fail(RESOURCE_ERROR.RECORD_CORRUPT, `资源记录不是合法 JSON：${error?.message ?? error}`, { path })
  }
  try {
    return normalizeResourceRecord(parsed)
  } catch (error) {
    throw fail(RESOURCE_ERROR.RECORD_CORRUPT, `资源记录形状非法：${error?.message ?? error}`, { path, cause: error })
  }
}

/**
 * 写一份所有权记录（原子 + 锁）。
 */
export async function writeResourceRecord({ registryRoot, record } = {}) {
  if (typeof registryRoot !== 'string' || registryRoot.trim() === '') {
    throw fail(RESOURCE_ERROR.INVALID, 'writeResourceRecord 需要 registryRoot')
  }
  const normalized = normalizeResourceRecord(record)
  const path = recordPath({
    registryRoot,
    workspaceId: normalized.workspaceId,
    instanceId: normalized.instanceId,
  })
  const lockPath = join(resolve(registryRoot), normalized.workspaceId, '.lock')
  await ensureDir(resolve(path, '..'))
  return await withResourceLock(lockPath, async () => {
    await writeTextAtomic(path, `${JSON.stringify(normalized, null, 2)}\n`)
    return { ...normalized }
  })
}

/** 删除所有权记录（不存在不算失败）。 */
export async function removeResourceRecord({ registryRoot, workspaceId, instanceId } = {}) {
  if (typeof registryRoot !== 'string' || registryRoot.trim() === '') {
    throw fail(RESOURCE_ERROR.INVALID, 'removeResourceRecord 需要 registryRoot')
  }
  const path = recordPath({ registryRoot, workspaceId, instanceId })
  const lockPath = join(resolve(registryRoot), workspaceId, '.lock')
  return await withResourceLock(lockPath, async () => {
    try {
      await unlink(path)
      return true
    } catch (error) {
      if (error && error.code === 'ENOENT') return false
      throw error
    }
  })
}

/**
 * 扫描 registry；损坏记录单独列出（列表 / prune 需要看得见，不能静默跳过）。
 *
 * @returns {Promise<{records: object[], corrupt: object[]}>}
 */
export async function scanResourceRecords({ registryRoot, workspaceId } = {}) {
  if (typeof registryRoot !== 'string' || registryRoot.trim() === '') {
    throw fail(RESOURCE_ERROR.INVALID, 'scanResourceRecords 需要 registryRoot')
  }
  const root = resolve(registryRoot)
  const workspaceIds = workspaceId === undefined || workspaceId === null || workspaceId === ''
    ? await listWorkspaceDirs(root)
    : [requireWorkspaceId(workspaceId)]
  const records = []
  const corrupt = []
  for (const ws of workspaceIds) {
    const dir = join(root, ws)
    let names = []
    try {
      names = await readdir(dir)
    } catch (error) {
      if (error && error.code === 'ENOENT') continue
      corrupt.push({ workspaceId: ws, instanceId: null, file: dir, code: RESOURCE_ERROR.RECORD_CORRUPT, reason: `目录不可读：${error?.message ?? error}` })
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const instanceId = name.slice(0, -'.json'.length)
      if (!RESOURCE_ID_PATTERN.test(instanceId)) {
        corrupt.push({ workspaceId: ws, instanceId, file: join(dir, name), code: RESOURCE_ERROR.RECORD_CORRUPT, reason: '文件名不是合法 instanceId' })
        continue
      }
      try {
        const record = await readResourceRecord({ registryRoot: root, workspaceId: ws, instanceId })
        if (record !== null) records.push(record)
      } catch (error) {
        corrupt.push({
          workspaceId: ws,
          instanceId,
          file: join(dir, name),
          code: error?.code ?? RESOURCE_ERROR.RECORD_CORRUPT,
          reason: error?.message ?? String(error),
        })
      }
    }
  }
  return { records, corrupt }
}

async function listWorkspaceDirs(root) {
  try {
    const dirents = await readdir(root, { withFileTypes: true })
    return dirents
      .filter(item => item.isDirectory() && WORKSPACE_ID_PATTERN.test(item.name))
      .map(item => item.name)
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
}

/** 读实例冻结的工作区快照；不存在 null，损坏抛 SNAPSHOT_CORRUPT。 */
export async function readWorkspaceSnapshot({ instancesRoot, instanceId } = {}) {
  if (typeof instancesRoot !== 'string' || instancesRoot.trim() === '') {
    throw fail(RESOURCE_ERROR.INVALID, 'readWorkspaceSnapshot 需要 instancesRoot')
  }
  const path = workspaceSnapshotPath(instancesRoot, instanceId)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw fail(RESOURCE_ERROR.SNAPSHOT_CORRUPT, `读取工作区快照失败：${error?.message ?? error}`, { path, cause: error })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw fail(RESOURCE_ERROR.SNAPSHOT_CORRUPT, `工作区快照不是合法 JSON：${error?.message ?? error}`, { path })
  }
  if (!isPlainObject(parsed) || parsed.v !== RESOURCE_RECORD_VERSION) {
    throw fail(RESOURCE_ERROR.SNAPSHOT_CORRUPT, '工作区快照版本非法', { path })
  }
  if (parsed.instanceId !== requireInstanceId(instanceId)) {
    throw fail(RESOURCE_ERROR.SNAPSHOT_CORRUPT, '工作区快照的 instanceId 与目录不一致', { path })
  }
  if (typeof parsed.effectiveRoot !== 'string' || !isAbsolute(parsed.effectiveRoot)) {
    throw fail(RESOURCE_ERROR.SNAPSHOT_CORRUPT, '工作区快照缺少绝对路径 effectiveRoot', { path })
  }
  return parsed
}

/** 写实例冻结的工作区快照（原子写；资源事件与工作区快照同一把锁）。 */
export async function writeWorkspaceSnapshot({ instancesRoot, instanceId, snapshot } = {}) {
  if (typeof instancesRoot !== 'string' || instancesRoot.trim() === '') {
    throw fail(RESOURCE_ERROR.INVALID, 'writeWorkspaceSnapshot 需要 instancesRoot')
  }
  const id = requireInstanceId(instanceId)
  if (!isPlainObject(snapshot)) {
    throw fail(RESOURCE_ERROR.INVALID, '工作区快照必须是 JSON 对象')
  }
  const value = { ...snapshot, v: RESOURCE_RECORD_VERSION, instanceId: id }
  const path = workspaceSnapshotPath(instancesRoot, id)
  await ensureDir(resolve(path, '..'))
  const lockPath = join(resourceDirFor(instancesRoot, id), '.lock')
  return await withResourceLock(lockPath, async () => {
    await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
    return value
  })
}

async function readResourceState(instancesRoot, instanceId) {
  const path = join(resourceDirFor(instancesRoot, instanceId), 'state.json')
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    const resourceSeq = isPlainObject(parsed) && Number.isSafeInteger(parsed.resourceSeq) && parsed.resourceSeq >= 0
      ? parsed.resourceSeq
      : 0
    return { resourceSeq }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { resourceSeq: 0 }
    // 坏序号文件不能把事件流永久卡死：退回 0 并让下一条重新编号（读取会暴露重复风险）。
    return { resourceSeq: 0 }
  }
}

/**
 * 追加一条资源事件（独立 resourceSeq；不碰执行事件）。
 *
 * @param {{instancesRoot:string, instanceId:string, event:object, now?:()=>Date}} input
 * @returns {Promise<{seq:number, event:object}>}
 */
export async function appendResourceEvent({ instancesRoot, instanceId, event, now } = {}) {
  if (typeof instancesRoot !== 'string' || instancesRoot.trim() === '') {
    throw fail(RESOURCE_ERROR.INVALID, 'appendResourceEvent 需要 instancesRoot')
  }
  const id = requireInstanceId(instanceId)
  if (!isPlainObject(event) || typeof event.type !== 'string' || event.type.trim() === '') {
    throw fail(RESOURCE_ERROR.INVALID, '资源事件必须是有 type 的 JSON 对象')
  }
  const dir = resourceDirFor(instancesRoot, id)
  await ensureDir(dir)
  const lockPath = join(dir, '.lock')
  const at = typeof now === 'function' && now() instanceof Date
    ? now().toISOString()
    : new Date().toISOString()
  return await withResourceLock(lockPath, async () => {
    const state = await readResourceState(instancesRoot, id)
    const seq = state.resourceSeq + 1
    const normalized = { ...event, seq, at }
    const line = `${JSON.stringify(normalized)}\n`
    if (Buffer.byteLength(line, 'utf8') > MAX_RESOURCE_EVENT_BYTES) {
      throw fail(
        RESOURCE_ERROR.INVALID,
        `资源事件超过 ${MAX_RESOURCE_EVENT_BYTES} 字节上限`,
        { instanceId: id, type: event.type },
      )
    }
    await writeTextAtomic(join(dir, 'state.json'), `${JSON.stringify({ v: RESOURCE_STATE_VERSION, resourceSeq: seq }, null, 2)}\n`)
    await writeFile(join(dir, 'events.jsonl'), line, { encoding: 'utf8', mode: FILE_MODE, flag: 'a' })
    return { seq, event: normalized }
  })
}

/**
 * 读资源事件（`since` 为独占下界）。坏行跳过并计数，不让单条坏行让整个读取 500。
 *
 * @returns {Promise<{events:object[], resourceSeq:number, skipped:number}>}
 */
export async function readResourceEvents({ instancesRoot, instanceId, since = 0 } = {}) {
  if (typeof instancesRoot !== 'string' || instancesRoot.trim() === '') {
    throw fail(RESOURCE_ERROR.INVALID, 'readResourceEvents 需要 instancesRoot')
  }
  const id = requireInstanceId(instanceId)
  const state = await readResourceState(instancesRoot, id)
  let text = ''
  try {
    text = await readFile(resourceEventsPath(instancesRoot, id), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { events: [], resourceSeq: state.resourceSeq, skipped: 0 }
    throw error
  }
  const events = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      skipped += 1
      continue
    }
    if (!isPlainObject(parsed) || !Number.isSafeInteger(parsed.seq) || parsed.seq <= since) continue
    events.push(parsed)
  }
  events.sort((left, right) => left.seq - right.seq)
  return { events, resourceSeq: state.resourceSeq, skipped }
}

/** 以 `<base>` 为根的工作区目录名（防止调用方拼出越界路径）。 */
export function workspaceDirFor(base, workspaceId) {
  const ws = requireWorkspaceId(workspaceId)
  const root = resolve(base)
  const dir = resolve(root, ws)
  const rel = relative(root, dir)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw fail(RESOURCE_ERROR.INVALID_ID, `workspaceId 越界：${workspaceId}`)
  }
  return dir
}
