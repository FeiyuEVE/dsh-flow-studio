/**
 * 实例执行所有权（跨进程，同机本地文件系统）。
 *
 * 0.14.4 起，一个实例同一时刻只允许一个 **活着的 runtime** 持有可执行 runner：
 * 谁建出 runner 就在实例目录写 `owner.json`，终态 / dispose 时释放。其它进程据此
 * 判断「是不是别人正在执行」，而不是靠时间 TTL 猜。
 *
 * 判据与 `instance-message-store` 的投递权同一套（这里抽成公共模块）：
 *   - 同一主机：pid 存活 + `/proc/<pid>/stat` 的 starttime 对得上 → `alive`；
 *   - pid 不存在 / starttime 变了 / 同 pid 但 bootId 不同 → `gone`；
 *   - 跨主机、坏 JSON、读不到 `/proc` → `unknown`（**不**当成 gone 去抢）。
 *
 * 文件：`<instancesRoot>/<instanceId>/owner.json`
 * 形状：`{pid, host, bootId, startTime, runtimeId, since}`
 *
 * 0.14.6：**夺取所有权是跨进程互斥的**（复审 NEW-1）。`claimInstanceOwner` /
 * `releaseInstanceOwner` 的「读旧记录 → 判定 → 原子替换 / 删除」整段跑在
 * `<instancesRoot>/.locks/<instanceId>.lock` 的内核 flock 临界区里（复用
 * `instance-resources.js` 的宿主 fd + util-linux flock 原语；helper 死亡 fail-closed），
 * 所以两个进程不会同时从「没有 owner」各写一份。拿不到所有权时抛
 * `INSTANCE_OWNED_ELSEWHERE` / `INSTANCE_OWNER_UNKNOWN`（409），调用方必须在
 * recover / signal / adapter 派发前退出。
 *
 * 锁放在实例目录**之外**的隐藏目录里：`withResourceLock` 会为锁文件建父目录，
 * 若把锁放进 `<instanceId>/`，实例被删后一次 release/dispose 就会把空目录复活。
 *
 * 平台边界：Windows / 找不到 util-linux `flock` 时 `withResourceLock` 退回**进程内
 * 队列**，此时只有同进程互斥，跨进程互斥不成立——与 `instance-resources.js` 声明的
 * 降级边界是同一处（`resourceLockBackend()` 可判当前后端）。
 *
 * @module @feiyueve/dsh-flow-studio/instance-owner
 */

import { readFileSync } from 'node:fs'
import { chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { withResourceLock } from './instance-resources.js'
import { checkRunId } from './storage-contract.js'

const FILE_MODE = 0o600
const OWNER_FILE = 'owner.json'
/**
 * 所有权临界区锁目录（宿主 fd + util-linux flock，见 `instance-resources.js`）。
 * 锁文件 `<instancesRoot>/.locks/<instanceId>.lock` 只作 inode 锚点，**常驻不删**：
 * 删除会让等待者与新建者各自锁住不同 inode（ABA）。放在实例目录之外，
 * 避免 `withResourceLock` 的建目录行为把已删除的实例目录复活。
 */
const OWNER_LOCKS_DIR = '.locks'
/** 等所有权锁的上限：拿不到就 fail-closed（调用方必须在派发前退出）。 */
const OWNER_CLAIM_WAIT_MS = 10 * 1000

let tmpCounter = 0

/** 本进程唯一标记：pid 复用时用它区分「同一个 pid 的另一个进程」。 */
export const PROCESS_BOOT_ID = randomUUID()
/** 当前主机名：所有权记录只在同一主机上做存活判定（跨主机不可验证）。 */
export const HOST_NAME = (() => {
  try {
    return hostname()
  } catch {
    return ''
  }
})()
/** 未显式给 runtimeId 的调用方（例如 inbox 投递权）共用一个模块级 id。 */
export const DEFAULT_RUNTIME_ID = randomUUID()

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Linux `/proc/<pid>/stat` 的 starttime（字段 22）；其它平台返回 null。 */
export async function linuxProcessStartTime(pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const statText = await readFile(`/proc/${pid}/stat`, 'utf8')
    return parseStartTime(statText)
  } catch {
    return null
  }
}

/** 同步版（只给 `selfOwner()` 用）：本机 Linux 上一次同步读，足够便宜。 */
function linuxProcessStartTimeSync(pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    return parseStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
}

function parseStartTime(statText) {
  const closeParen = statText.lastIndexOf(')')
  if (closeParen < 0) return null
  // 字段 3 起：state ppid pgrp session ...；starttime 是字段 22 → 下标 19。
  const fields = statText.slice(closeParen + 1).trim().split(/\s+/)
  const startTime = fields[19]
  return typeof startTime === 'string' && startTime !== '' ? startTime : null
}

let selfStartTimePromise = null
/** 本进程 starttime（异步，结果缓存；读不到返回 null）。 */
export async function selfProcessStartTime() {
  if (selfStartTimePromise === null) selfStartTimePromise = linuxProcessStartTime(process.pid)
  return await selfStartTimePromise
}

let cachedSelfStartTime = null
function selfStartTimeSync() {
  if (cachedSelfStartTime === null) cachedSelfStartTime = linuxProcessStartTimeSync(process.pid)
  return cachedSelfStartTime
}

/** pid 是否仍存在（EPERM 表示存在但无权限，按存活处理）。 */
export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 本进程的所有权记录。
 *
 * `runtimeId` 用于区分**同一进程内的多个 runtime**：它们共享 pid / bootId，
 * 只有 runtimeId 能判断 owner 是不是「我自己」。
 *
 * @param {string} [runtimeId]
 * @returns {{pid: number, host: string, bootId: string, startTime: string|null, runtimeId: string}}
 */
export function selfOwner(runtimeId = DEFAULT_RUNTIME_ID) {
  return {
    pid: process.pid,
    host: HOST_NAME,
    bootId: PROCESS_BOOT_ID,
    startTime: selfStartTimeSync(),
    runtimeId: typeof runtimeId === 'string' && runtimeId !== '' ? runtimeId : DEFAULT_RUNTIME_ID,
  }
}

/**
 * 判定一条所有权记录的主人是否还在：
 *   - `alive`   ：确认仍在（同主机、pid 存活且 starttime 对得上；或就是本进程当前 boot）；
 *   - `gone`    ：确认不在了（pid 不存在；pid 被复用且 starttime 不同；同 pid 但 bootId 不同）；
 *   - `unknown` ：无法确认（跨主机、旧格式没有 owner、坏 JSON、读不到 /proc 等）。
 *
 * 只有 `gone` 允许接管；`unknown` 保持保守，绝不按时间猜。
 *
 * @param {unknown} owner
 * @returns {Promise<'alive'|'gone'|'unknown'>}
 */
export async function ownerState(owner) {
  if (!isPlainObject(owner)) return 'unknown'
  const pid = owner.pid
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown'
  if (typeof owner.host === 'string' && owner.host !== '' && HOST_NAME !== '' && owner.host !== HOST_NAME) {
    return 'unknown'
  }
  if (pid === process.pid && typeof owner.bootId === 'string' && owner.bootId !== '') {
    return owner.bootId === PROCESS_BOOT_ID ? 'alive' : 'gone'
  }
  if (pid === process.pid) return 'alive'
  if (!processIsAlive(pid)) return 'gone'
  if (typeof owner.startTime === 'string' && owner.startTime !== '') {
    const current = await linuxProcessStartTime(pid)
    if (current !== null && current !== owner.startTime) return 'gone'
  }
  return 'alive'
}

/** `<instanceDir>/owner.json`。 */
export function ownerFilePath(instanceDir) {
  return join(instanceDir, OWNER_FILE)
}

/** `<instancesRoot>/.locks/<instanceId>.lock`（跨进程所有权临界区锚点）。 */
export function ownerLockFilePath(instancesRoot, instanceId) {
  const checked = checkRunId(instanceId)
  if (checked === null) return null
  return join(resolve(instancesRoot), OWNER_LOCKS_DIR, `${checked}.lock`)
}

/** id → 实例目录；非法 id / 越界返回 null。 */
function instanceDirOf(instancesRoot, instanceId) {
  const checked = checkRunId(instanceId)
  if (!checked) return null
  const root = resolve(instancesRoot)
  const dir = resolve(root, checked)
  const rel = relative(root, dir)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return dir
}

async function dirExists(dir) {
  try {
    const info = await stat(dir)
    return info.isDirectory()
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

/** 读 owner.json 原文；缺失 / 坏 JSON 都返回 `{kind}`，不抛。 */
async function readOwnerPayload(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) return { kind: 'corrupt' }
    return { kind: 'ok', value: parsed }
  } catch {
    return { kind: 'corrupt' }
  }
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
  let renamed = false
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE })
    await rename(tmp, path)
    renamed = true
    await chmod(path, FILE_MODE).catch(() => {})
  } finally {
    if (!renamed) await unlink(tmp).catch(() => {})
  }
}

/** 收敛所有权记录：pid / runtimeId 必填，host / bootId / startTime 可选但按字符串收敛。 */
function normalizeOwner(raw) {
  if (!isPlainObject(raw)) {
    throw new TypeError('instance owner 必须是 JSON 对象')
  }
  if (!Number.isSafeInteger(raw.pid) || raw.pid <= 0) {
    throw new TypeError('instance owner.pid 必须是正整数')
  }
  if (typeof raw.runtimeId !== 'string' || raw.runtimeId === '') {
    throw new TypeError('instance owner.runtimeId 必须是非空字符串')
  }
  const owner = {
    pid: raw.pid,
    host: typeof raw.host === 'string' ? raw.host : '',
    bootId: typeof raw.bootId === 'string' ? raw.bootId : '',
    startTime: typeof raw.startTime === 'string' && raw.startTime !== '' ? raw.startTime : null,
    runtimeId: raw.runtimeId,
  }
  if (typeof raw.since === 'string' && raw.since !== '') owner.since = raw.since
  return owner
}

/** 带 code / status 的所有权错误（runtime 据此映射 409 / 404）。 */
function ownerError(code, message, status, extra = {}) {
  const error = new Error(message)
  error.code = code
  error.status = status
  Object.assign(error, extra)
  return error
}

/**
 * 夺取 / 登记实例执行所有权（**跨进程互斥**）。
 *
 * 互斥由 `withResourceLock` 提供（宿主 fd 上的内核 flock；helper 死亡 fail-closed），
 * 因此「读旧 owner → 判定 → 原子 rename」整段落在同一个临界区里：两个进程不可能
 * 同时读到「没有 owner」再各自写入。复审 NEW-1 的双派发就来自这里缺少互斥。
 *
 * 判定（与 `readInstanceOwner` / `ownerState` 同一套事实口径）：
 *   - 没有记录 → 写入本 runtime 的记录，`previous:null`；
 *   - 记录是 `alive` 的**别的进程** → 抛 `INSTANCE_OWNED_ELSEWHERE`（409），**不写盘**；
 *   - 记录是 `alive` 的**同一进程其它 runtime** → 允许接管：同进程内由 runner 活跃表
 *     （`BPMN_INSTANCE_ID_CONFLICT`）兜底串行，不构成跨进程双执行；
 *   - 记录是 `gone`（pid 不存在 / starttime 变了 / bootId 变了）→ 接管并返回 `previous`；
 *   - 坏 JSON / 跨主机 / 读不到 pid = `unknown` → 抛 `INSTANCE_OWNER_UNKNOWN`（409），
 *     保持 fail-closed；人工核对后可删除 `owner.json` 由持有者重新登记。
 *
 * @param {string} instanceId
 * @param {{instancesRoot: string, owner?: object}} input
 * @returns {Promise<{owner: object, previous: object|null, state: 'alive'|'gone'|'unknown'|null, takeover: boolean}>}
 */
export async function claimInstanceOwner(instanceId, input = {}) {
  const dir = instanceDirOf(input.instancesRoot, instanceId)
  if (dir === null || !(await dirExists(dir))) {
    throw ownerError('INSTANCE_NOT_FOUND', `实例 ${String(instanceId)} 不存在，不能登记执行所有权`, 404)
  }
  const path = ownerFilePath(dir)
  const lockPath = ownerLockFilePath(input.instancesRoot, instanceId)
  if (lockPath === null) {
    throw ownerError('INSTANCE_NOT_FOUND', `实例 ${String(instanceId)} 不存在，不能登记执行所有权`, 404)
  }
  return await withResourceLock(lockPath, async () => {
    // 目录可能在等锁期间被删：临界区里再确认一次（claim 不能复活实例目录）。
    if (!(await dirExists(dir))) {
      throw ownerError('INSTANCE_NOT_FOUND', `实例 ${String(instanceId)} 不存在，不能登记执行所有权`, 404)
    }
    const previousPayload = await readOwnerPayload(path)
    const previous = previousPayload.kind === 'ok' ? previousPayload.value : null
    const owner = normalizeOwner(input.owner ?? selfOwner())
    if (owner.startTime === null && owner.pid === process.pid) {
      // selfOwner() 在 /proc 首次读取失败时可能给 null；claim 是异步路径，补一次。
      owner.startTime = await selfProcessStartTime()
    }
    if (owner.since === undefined) owner.since = new Date().toISOString()

    if (previousPayload.kind === 'corrupt') {
      // 坏 JSON 不能当成「没有 owner」直接覆盖：那会掩盖一个可能还活着的执行者。
      throw ownerError(
        'INSTANCE_OWNER_UNKNOWN',
        `实例 ${String(instanceId)} 的 owner.json 无法解析，不能确认执行所有权：为安全起见拒绝夺取；请人工核对 ${path}`,
        409,
        { owner: null, state: 'unknown', path },
      )
    }

    let state = null
    if (previous !== null) {
      state = await ownerState(previous)
      const sameRuntime = previous.runtimeId === owner.runtimeId
      const sameProcess = previous.pid === process.pid
      if (state === 'alive' && !sameRuntime && !sameProcess) {
        throw ownerError(
          'INSTANCE_OWNED_ELSEWHERE',
          `实例 ${String(instanceId)} 的执行所有权被另一个活进程持有（pid ${previous.pid} @ ${previous.host || '?'}，自 ${previous.since ?? '未知时间'}），本次不夺取、不派发`,
          409,
          { owner: previous, state },
        )
      }
      if (state === 'unknown') {
        throw ownerError(
          'INSTANCE_OWNER_UNKNOWN',
          `实例 ${String(instanceId)} 的执行所有权记录无法确认（跨主机 / 读不到进程信息）：为安全起见拒绝夺取；请人工核对 ${path}`,
          409,
          { owner: previous, state },
        )
      }
      // 同一 runtime 重复 claim（准备 / 恢复路径会多次进入）：保留原始 since，不制造时间漂移。
      if (sameRuntime && state === 'alive' && typeof previous.since === 'string' && previous.since !== '') {
        owner.since = previous.since
      }
    }
    await writeJsonAtomic(path, owner)
    return {
      owner,
      previous,
      state,
      takeover: previous !== null && state === 'gone',
    }
  }, { waitMs: OWNER_CLAIM_WAIT_MS })
}

/**
 * 读所有权记录（无锁纯读：`owner.json` 是 rename 原子替换，读到的总是完整一份）。
 *
 * @param {string} instanceId
 * @param {{instancesRoot: string}} input
 * @returns {Promise<null | {owner: object|null, state: 'alive'|'gone'|'unknown'}>}
 *   文件缺失 → null；坏 JSON → `{owner: null, state: 'unknown'}`（**不**当成 gone）。
 */
export async function readInstanceOwner(instanceId, input = {}) {
  const dir = instanceDirOf(input.instancesRoot, instanceId)
  if (dir === null) return null
  const payload = await readOwnerPayload(ownerFilePath(dir))
  if (payload.kind === 'missing') return null
  if (payload.kind === 'corrupt') return { owner: null, state: 'unknown' }
  const owner = payload.value
  return { owner, state: await ownerState(owner) }
}

/**
 * 释放所有权：只删自己写的（runtimeId 不匹配不删）。与 claim 同一把跨进程锁，
 * 避免「读到的还是自己 → 删除期间被接管 → 删掉继任者的记录」。
 *
 * @param {string} instanceId
 * @param {{instancesRoot: string, runtimeId: string}} input
 * @returns {Promise<boolean>} 是否真的删除了文件
 */
export async function releaseInstanceOwner(instanceId, input = {}) {
  const dir = instanceDirOf(input.instancesRoot, instanceId)
  if (dir === null) return false
  if (!(await dirExists(dir))) return false
  const path = ownerFilePath(dir)
  const lockPath = ownerLockFilePath(input.instancesRoot, instanceId)
  if (lockPath === null) return false
  const runtimeId = typeof input.runtimeId === 'string' ? input.runtimeId : ''
  if (runtimeId === '') return false
  return await withResourceLock(lockPath, async () => {
    const payload = await readOwnerPayload(path)
    if (payload.kind !== 'ok') return false
    if (payload.value.runtimeId !== runtimeId) return false
    try {
      await unlink(path)
      return true
    } catch (error) {
      if (error && error.code === 'ENOENT') return false
      throw error
    }
  }, { waitMs: OWNER_CLAIM_WAIT_MS })
}

