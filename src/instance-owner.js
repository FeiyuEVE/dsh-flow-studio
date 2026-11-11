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
 * @module @feiyueve/dsh-flow-studio/instance-owner
 */

import { readFileSync } from 'node:fs'
import { chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { checkRunId } from './storage-contract.js'

const FILE_MODE = 0o600
const OWNER_FILE = 'owner.json'

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

/**
 * 原子写 owner.json（不建目录：实例被删后不能靠写 owner 把目录复活）。
 *
 * @param {string} instanceId
 * @param {{instancesRoot: string, owner?: object}} input
 * @returns {Promise<{owner: object, previous: object|null}>}
 */
export async function claimInstanceOwner(instanceId, input = {}) {
  const dir = instanceDirOf(input.instancesRoot, instanceId)
  if (dir === null || !(await dirExists(dir))) {
    const error = new Error(`实例 ${String(instanceId)} 不存在，不能登记执行所有权`)
    error.code = 'INSTANCE_NOT_FOUND'
    error.status = 404
    throw error
  }
  const path = ownerFilePath(dir)
  const previousPayload = await readOwnerPayload(path)
  const previous = previousPayload.kind === 'ok' ? previousPayload.value : null
  const owner = normalizeOwner(input.owner ?? selfOwner())
  if (owner.startTime === null && owner.pid === process.pid) {
    // selfOwner() 在 /proc 首次读取失败时可能给 null；claim 是异步路径，补一次。
    owner.startTime = await selfProcessStartTime()
  }
  if (owner.since === undefined) owner.since = new Date().toISOString()
  await writeJsonAtomic(path, owner)
  return { owner, previous }
}

/**
 * 读所有权记录。
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
 * 释放所有权：只删自己写的（runtimeId 不匹配不删）。
 *
 * @param {string} instanceId
 * @param {{instancesRoot: string, runtimeId: string}} input
 * @returns {Promise<boolean>} 是否真的删除了文件
 */
export async function releaseInstanceOwner(instanceId, input = {}) {
  const dir = instanceDirOf(input.instancesRoot, instanceId)
  if (dir === null) return false
  const path = ownerFilePath(dir)
  const payload = await readOwnerPayload(path)
  if (payload.kind !== 'ok') return false
  const runtimeId = typeof input.runtimeId === 'string' ? input.runtimeId : ''
  if (runtimeId === '' || payload.value.runtimeId !== runtimeId) return false
  try {
    await unlink(path)
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}
