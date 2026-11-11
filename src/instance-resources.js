/**
 * 实例资源记录（0.13.7 C）：worktree 所有权记录、生命周期锁、独立资源事件。
 *
 * 布局（`<flow-studio>` 是 definitions/instances 的父目录）：
 * ```
 * worktree-registry/<workspaceId>/<instanceId>.json   宿主所有权记录（不放工作树里）
 * instances/<instanceId>/workspace.json               实例冻结的工作区快照
 * instances/<instanceId>/resources/state.json         资源事件序号（独立 resourceSeq）
 * instances/<instanceId>/resources/events.jsonl       资源事件（append-only）
 * instances/<instanceId>/resources/.lock              资源临界区锁（flock 锚点，常驻不删）
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

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile,
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
  LOCK_FAILED: 'RESOURCE_LOCK_FAILED',
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

/** 资源锁内容格式版本（只作诊断字段；互斥语义由内核 flock 提供）。 */
export const RESOURCE_LOCK_VERSION = 1

/**
 * 锁后端与 ABA 的关系（review-0140 N3）。
 *
 * 旧实现用「锁文件 + pid/TTL + `.steal` guard + 按路径 unlink/rename」做 stale
 * 恢复。guard 自身也要 stale 恢复，于是「读旧 owner → 按路径 unlink」仍有
 * check-then-delete 竞态：迟到的 unlink 删掉继任者的活 guard，迟到的 rename
 * 再搬走活主锁（ABA），两个临界区同时进入。
 *
 * 新实现把互斥交给内核：
 *   - POSIX：spawn util-linux `flock` 持有 `<lock>` 的排他 flock；关闭 stdin
 *     让持锁进程退出即释放。持有者崩溃时内核自动释放——没有 stale 概念，
 *     也就没有 stale 恢复，因此不存在 check-then-delete / ABA。
 *   - Windows 或找不到 flock 的平台：退回**进程内队列**，只保证同一 Node 进程
 *     内的串行；跨进程互斥不成立（明确的平台限制）。
 *   - flock 的可靠性依赖底层文件系统：本地文件系统可靠；NFS/SMB 等共享卷上
 *     跨主机的 flock 语义不保证，锁目录应放在本地盘。
 *
 * 锁文件**永不删除**：删除会让等待者继续持有已 unlink 的 inode，而新路径又能
 * 建出新 inode，形成「两个文件、两把锁」的经典 ABA。文件只作为 flock 的锚点，
 * 里面的 owner/pid 只用于排障，不参与任何 stale / 抢占判定。
 */
const KERNEL_LOCK_BIN = process.env.FLOW_STUDIO_FLOCK_BIN || 'flock'
// 拿到锁后先打标记（父进程据此确认已持有），再由 cat 阻塞读 stdin；关闭 stdin
// 即 EOF → cat 退出 → 内核释放 flock。整个过程没有按路径 unlink/rename。
const KERNEL_LOCK_COMMAND = 'echo locked; exec cat >/dev/null'
const KERNEL_LOCK_RELEASE_MS = 2_000
/** 'unknown' | 'available' | 'unavailable'；首次 acquire 后定案。 */
let kernelLockState = 'unknown'
/** 进程内队列：Windows / 找不到 flock 时的退路。 */
const processLockQueues = new Map()

/** spawn 层面的「后端不可用」错误：只对它们退回进程内队列。 */
function backendUnavailable(error) {
  return Boolean(error && typeof error.code === 'string'
    && ['ENOENT', 'EACCES', 'ENOSYS', 'EPERM'].includes(error.code))
}

/** 等一个已 spawn 的子进程退出（已经退出则立即 resolve）。 */
function waitChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolveWait => { child.once('exit', () => resolveWait()) })
}

/** 锁文件先以 0600 建好并常驻；flock 只把它当 inode 锚点。 */
async function ensureLockFile(lockPath) {
  const handle = await open(lockPath, 'a', FILE_MODE)
  try {
    await handle.chmod(FILE_MODE).catch(() => {})
  } finally {
    await handle.close().catch(() => {})
  }
}

/** 持有者诊断信息（best-effort；互斥与 stale 判定都不读它）。 */
async function writeHolderInfo(lockPath, owner) {
  try {
    await writeFile(lockPath, `${JSON.stringify({
      v: RESOURCE_LOCK_VERSION,
      owner,
      pid: process.pid,
      at: new Date().toISOString(),
      backend: 'flock',
    })}\n`, { encoding: 'utf8', mode: FILE_MODE })
    await chmod(lockPath, FILE_MODE).catch(() => {})
  } catch {
    // 诊断信息写失败不影响互斥本身。
  }
}

/**
 * 用 util-linux `flock` 在 `<lockPath>` 上持有内核排他锁。
 *
 * `-F/--no-fork` 让 flock 直接 exec shell，锁 fd 由 `cat` 继承并一直持有；
 * `-w` 只是内核侧的兜底，JS 计时器负责毫秒级 waitMs。返回的 `release()`
 * 关闭 stdin 并等持锁进程退出，确保「await 返回后锁真的已释放」。
 */
async function acquireKernelLock(lockPath, waitMs) {
  const startedAt = Date.now()
  const timeoutSeconds = Math.max(1, Math.ceil(Math.max(1, waitMs) / 1000))
  const child = spawn(KERNEL_LOCK_BIN, [
    '-x', '-w', String(timeoutSeconds), '-F', lockPath, 'sh', '-c', KERNEL_LOCK_COMMAND,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  let settled = false
  let timer = null
  // 子进程可能先退出（超时 / 后端报错），此时写 stdin 会 EPIPE；不能让它变成未捕获异常。
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})
  child.stderr.on('error', () => {})
  return await new Promise((resolveAcquire, rejectAcquire) => {
    const finishReject = error => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      try {
        child.kill('SIGKILL')
      } catch {
        // 已经退出
      }
      rejectAcquire(error)
    }
    timer = setTimeout(() => {
      finishReject(fail(
        RESOURCE_ERROR.LOCK_TIMEOUT,
        `等待资源锁超时（${waitMs}ms）：${lockPath}`,
        { path: lockPath },
      ))
    }, Math.max(1, waitMs))
    timer.unref?.()
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      if (settled || !stdout.includes('locked')) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolveAcquire({
        async release() {
          try {
            child.stdin.end()
          } catch {
            // 已经退出
          }
          // 等内核真正释放锁：不能让调用方在锁仍被持有时继续。
          await Promise.race([waitChildExit(child), sleep(KERNEL_LOCK_RELEASE_MS)])
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill('SIGKILL')
            } catch {
              // 已经退出
            }
            await Promise.race([waitChildExit(child), sleep(1_000)])
          }
        },
      })
    })
    child.stderr.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-2_048)
    })
    child.once('error', error => finishReject(error))
    child.once('exit', code => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      const elapsed = Date.now() - startedAt
      const timedOut = elapsed >= Math.max(1, waitMs) - 50 || (code === 1 && elapsed >= waitMs / 2)
      rejectAcquire(fail(
        timedOut ? RESOURCE_ERROR.LOCK_TIMEOUT : RESOURCE_ERROR.LOCK_FAILED,
        timedOut
          ? `等待资源锁超时（${waitMs}ms）：${lockPath}`
          : `资源锁后端失败（flock 退出码 ${code}）：${stderr.trim() || lockPath}`,
        { path: lockPath, ...(timedOut ? {} : { exitCode: code }) },
      ))
    })
  })
}

/** 进程内串行队列：只保证同进程互斥（Windows / 无 flock 的退路）。 */
async function withProcessQueue(lockPath, task) {
  const key = resolve(lockPath)
  const previous = processLockQueues.get(key) ?? Promise.resolve()
  let releaseGate
  const gate = new Promise(resolveGate => { releaseGate = resolveGate })
  const tail = previous.then(() => gate)
  processLockQueues.set(key, tail)
  await previous.catch(() => {})
  try {
    return await task()
  } finally {
    releaseGate()
    if (processLockQueues.get(key) === tail) processLockQueues.delete(key)
  }
}

/**
 * 当前实际使用的锁后端：`flock`（内核互斥）/ `process`（仅进程内）/ `unknown`。
 * 供测试与排障读取；不参与锁语义。
 */
export function resourceLockBackend() {
  if (process.platform === 'win32') return 'process'
  return kernelLockState === 'available' ? 'flock' : (kernelLockState === 'unavailable' ? 'process' : 'unknown')
}

/**
 * 跨进程粗粒度锁：**内核 flock**（POSIX）或进程内队列（Windows / 无 flock）。
 *
 * 与旧实现的关键区别：没有 stale 恢复，也没有 `.steal` guard。持有者崩溃时
 * 内核自动释放，不存在「读旧 owner → 按路径删除/搬走」的 check-then-delete
 * 窗口，因此不会误删 / 搬走继任者的活锁（review-0140 N3）。
 *
 * `ttlMs` 仅为兼容旧调用保留：flock 后端不使用 TTL（活锁不需要续租，死锁由
 * 内核判定），进程内退路也不需要。
 *
 * @param {string} lockPath
 * @param {() => Promise<any>} task
 * @param {{ttlMs?:number, waitMs?:number}} [options]
 */
export async function withResourceLock(lockPath, task, options = {}) {
  if (typeof task !== 'function') {
    throw fail(RESOURCE_ERROR.INVALID, 'withResourceLock 需要 task 函数')
  }
  const waitMs = Number.isSafeInteger(options.waitMs) && options.waitMs > 0 ? options.waitMs : LOCK_WAIT_MS
  await ensureDir(dirname(lockPath))
  await ensureLockFile(lockPath)

  if (process.platform !== 'win32' && kernelLockState !== 'unavailable') {
    let kernelLock = null
    try {
      kernelLock = await acquireKernelLock(lockPath, waitMs)
    } catch (error) {
      // 只有「从未成功用过内核后端」且确实是后端不可用（如 macOS / 精简容器
      // 没有 util-linux flock）才降级；已经证明可用之后绝不再静默退回进程内
      // 队列（那会把跨进程互斥悄悄降成只保证单进程）。
      if (kernelLockState === 'available' || !backendUnavailable(error)) throw error
      kernelLockState = 'unavailable'
    }
    if (kernelLock !== null) {
      kernelLockState = 'available'
      // 诊断信息：owner token 与 pid 只用于排障，不参与互斥 / stale 判定。
      await writeHolderInfo(lockPath, `${process.pid}-${randomBytes(8).toString('hex')}`)
      try {
        return await task()
      } finally {
        await kernelLock.release()
      }
    }
  }

  return await withProcessQueue(lockPath, task)
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
