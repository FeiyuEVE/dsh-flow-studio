/**
 * 流程模板的 Host 侧存储：$DSH_HOME/flow-studio/flows/<id>.json
 *
 * 单个文件存一份流程，写入走「临时文件 + rename」避免半截文件；
 * 读取失败的文件跳过而不是让整个面板打不开。
 *
 * @module @feiyueve/dsh-flow-studio/store
 */

import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { defaultFlow, makeId, normalizeFlow, summarize } from './model.js'

/** 单份流程文件的最大字节数，防止读进一份畸形大文件。 */
const MAX_FLOW_BYTES = 2 * 1024 * 1024

/** 与 run 日志同口径：目录 0700、文件 0600（05 §1 / 06 §13.7）。 */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** 流程 id 允许的字符集：既当文件名，也进 URL。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 版本从 1 开始；老文件没有 version 字段时按它补默认值，不判坏。 */
const INITIAL_VERSION = 1

/**
 * 版本冲突：调用方带来的 version 与磁盘当前版本不一致。
 *
 * 只带定位冲突所需的元信息（当前版本 / update 时间 / 内容摘要），
 * 不把整份流程塞进 error——错误会进日志与 HTTP 响应，不该夹带用户数据。
 */
export class FlowConflictError extends Error {
  /**
   * @param {number} currentVersion 磁盘上的当前版本
   * @param {string} currentUpdatedAt 磁盘上的 updatedAt（ISO 8601）
   * @param {string} currentDigest 当前内容的短摘要（sha256 前 16 位）
   */
  constructor(currentVersion, currentUpdatedAt, currentDigest) {
    super(`流程已被其他人改过（磁盘当前 v${currentVersion}），请刷新后重试`)
    this.name = 'FlowConflictError'
    this.code = 'FLOW_VERSION_CONFLICT'
    this.currentVersion = currentVersion
    this.currentUpdatedAt = currentUpdatedAt
    this.currentDigest = currentDigest
  }
}

/** 版本收敛：正整数原样保留，缺省 / 非法 / 小于 1 一律回落到 1。 */
function normalizeVersion(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : INITIAL_VERSION
}

/** 当前内容的短摘要，给冲突方一个对账依据（不返回内容本身）。 */
function digestOf(flow) {
  return createHash('sha256').update(JSON.stringify(flow)).digest('hex').slice(0, 16)
}

/**
 * 从请求体取客户端期望的版本。
 *
 * 只有「≥1 的安全整数」才算带了 version；其余（缺省、字符串、0、小数）按未带处理，
 * 保持老调用方 / 脚本的无条件写入语义。HTTP 层会在进到这里之前把非法 version 拦成 400。
 * @param {unknown} body
 * @returns {number | undefined}
 */
function requestedVersion(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const value = body.version
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined
}

/**
 * 进程内按流程分键的串行队列。
 *
 * read-check-write 必须在同一把锁里完成：否则两次并发 saveFlow 会都读到 v3、
 * 都通过校验、都写 v4，后写的静默覆盖先写的。这里用 promise 链把同一流程的
 * 保存排成一条队，不同流程（或不同流程目录）互不阻塞。
 *
 * 边界：**只管本进程**。Host 是单进程，所以够用；跨进程（多个 Host 共用一份
 * DSH_HOME，或外部脚本直接改文件）不在保证范围内——那需要文件锁 / CAS，本版不做。
 */
const flowLocks = new Map()

function withFlowLock(key, task) {
  const previous = flowLocks.get(key) || Promise.resolve()
  // 前一次失败不该卡死队列：成功 / 失败都接着执行下一段任务。
  const result = previous.then(task, task)
  const tail = result.then(() => undefined, () => undefined)
  flowLocks.set(key, tail)
  return result.finally(() => {
    // 队尾没人接就直接清掉，避免 Map 无限增长。
    if (flowLocks.get(key) === tail) flowLocks.delete(key)
  })
}

/** DSH 家目录：容器/多 profile 部署下 homedir() 与 DSH_HOME 并不相等，优先环境变量。 */
export function resolveHome(env) {
  const fromEnv = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** 流程目录。每次调用都重新解析，便于测试注入。 */
export function flowsDir(home) {
  return join(home || resolveHome(process.env), 'flow-studio', 'flows')
}

/** 校验并返回 id；不合法返回 null。 */
export function checkId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id) ? id : null
}

/** 由名称生成一个稳定可用的 id。 */
export function newFlowId() {
  return `flow-${makeId('x').split('_')[1] || Date.now().toString(36)}`
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  // 目录已存在时 mkdir 不会改 mode，显式 chmod 一次，保证与 run 目录同口径。
  await chmod(dir, DIR_MODE).catch(error => {
    if (error && error.code !== 'ENOENT') throw error
  })
}

/** 读一个文件并解析；不存在返回 null，解析失败抛错交给调用方决定。 */
async function readJson(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  if (text.length > MAX_FLOW_BYTES) throw new Error(`${basename(path)} 超过 ${MAX_FLOW_BYTES} 字节`)
  return JSON.parse(text)
}

/** 原子写：先写 .tmp 再 rename，中途崩溃不会留下半份流程；文件 0600。 */
async function writeJsonAtomic(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_FLOW_BYTES) {
    throw new Error(`流程超过 ${MAX_FLOW_BYTES} 字节，存不下`)
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, text, { encoding: 'utf8', mode: FILE_MODE })
  await rename(tmp, path)
  await chmod(path, FILE_MODE).catch(() => {})
}

/**
 * 列出全部流程摘要（按更新时间倒序）。
 * 目录为空时种一份出厂模板，让人一打开面板就有东西可看。
 * @param {string} dir
 */
export async function listFlows(dir) {
  await ensureDir(dir)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    names = []
  }
  const flows = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!checkId(id)) continue
    try {
      const raw = await readJson(join(dir, name))
      if (!raw) continue
      flows.push(summarize(normalizeFlow({ ...raw, id }, '未命名流程')))
    } catch {
      // 坏文件跳过：一份手改坏的 JSON 不该让整个列表 500。
    }
  }
  if (flows.length === 0) {
    const seeded = await seedDefaultFlow(dir)
    if (seeded) flows.push(summarize(seeded))
  }
  flows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return flows
}

/** 写入出厂模板（只在目录为空时调用一次）。 */
async function seedDefaultFlow(dir) {
  const flow = defaultFlow()
  flow.id = newFlowId()
  flow.version = INITIAL_VERSION
  flow.createdAt = new Date().toISOString()
  flow.updatedAt = flow.createdAt
  try {
    await writeJsonAtomic(join(dir, `${flow.id}.json`), flow)
    return flow
  } catch {
    return null
  }
}

/**
 * 保存前把磁盘上的旧版本另存一份（0.9.1 实证事故的兜底）。
 *
 * 起因是一次「客户端手里是一张空图 → PUT 整份替换 → 服务器上的流程被写成 nodes: []」
 * 的事故：文件确实被覆盖了，但没有任何地方留着事故前的样子。备份放在
 * `flows/.history/<id>.v<version>.json`，每份流程只留最近 KEEP 份；
 * 备份失败绝不挡保存（这是兜底，不是主路径）。
 */
const HISTORY_DIR = '.history'
/** 删除流程后，活动历史挪进这个子目录，避免与「重建后同名同 version」的备份混在一起。 */
const HISTORY_DELETED_DIR = 'deleted'
const HISTORY_KEEP = 3

/** 备份目标是否已存在；除 ENOENT 外一律按「已存在」处理——宁可少备份，也不覆盖已有证据。 */
async function historyExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    return !(error && error.code === 'ENOENT')
  }
}

async function stashFlowHistory(dir, id, version) {
  const from = join(dir, `${id}.json`)
  const historyDir = join(dir, HISTORY_DIR)
  const to = join(historyDir, `${id}.v${version}.json`)
  try {
    await mkdir(historyDir, { recursive: true, mode: DIR_MODE })
    // 同一 version 只留第一次备份：删除流程后按新文件从 v1 重建、再保存，会再次走到 v1，
    // 这里若直接 copyFile 就会把删除前那份事故证据覆盖掉。
    if (!(await historyExists(to))) await copyFile(from, to)
  } catch {
    return
  }
  try {
    const names = await readdir(historyDir)
    const mine = names
      .filter(name => name.startsWith(`${id}.v`) && name.endsWith('.json'))
      .map(name => ({ name, version: Number(name.slice(id.length + 2, -'.json'.length)) }))
      .filter(item => Number.isFinite(item.version))
      .sort((a, b) => b.version - a.version)
    for (const item of mine.slice(HISTORY_KEEP)) {
      await unlink(join(historyDir, item.name)).catch(() => {})
    }
  } catch {
    // 清理失败只是多留几份备份，不影响正确性。
  }
}

/**
 * 删除流程成功后，把它在 `.history` 下的活动备份挪进 `.history/deleted/`。
 *
 * 选择「挪走」而不是「直接删」：0.9.1 这套备份的存在意义就是留着事故前的样子，
 * 删除流程本身也是一次不可逆操作（客户端可能只是误删、随后撤销重建）。挪进归档
 * 子目录既保住了证据，又让重建后的流程从干净的活动历史重新开始——否则同 version
 * 的旧备份会让「不覆盖」规则把新流程的 v1 证据挡掉。
 *
 * 历史目录不存在 / 挪动失败一律静默：这是兜底，不改变 deleteFlow 的返回值语义。
 */
async function retireFlowHistory(dir, id) {
  const historyDir = join(dir, HISTORY_DIR)
  let names
  try {
    names = await readdir(historyDir)
  } catch {
    return
  }
  const mine = names.filter(name => name.startsWith(`${id}.v`) && name.endsWith('.json'))
  if (mine.length === 0) return
  const deletedDir = join(historyDir, HISTORY_DELETED_DIR)
  try {
    await mkdir(deletedDir, { recursive: true, mode: DIR_MODE })
  } catch {
    return
  }
  for (const name of mine) {
    const from = join(historyDir, name)
    const to = join(deletedDir, name)
    // 同一个 id 被反复建 / 删时归档名可能重名：加时间戳后缀，绝不覆盖已归档的证据。
    const target = (await historyExists(to))
      ? join(deletedDir, `${name.slice(0, -'.json'.length)}-${Date.now()}.json`)
      : to
    await rename(from, target).catch(() => {})
  }
}

/**
 * 读一份流程。
 * @returns {Promise<object | null>} 不存在返回 null
 */
export async function readFlow(dir, id) {
  const safe = checkId(id)
  if (!safe) return null
  const raw = await readJson(join(dir, `${safe}.json`))
  if (!raw) return null
  const flow = normalizeFlow({ ...raw, id: safe }, '未命名流程')
  // normalizeFlow 只保留已知字段，version 由存储层补：老文件没有该字段就按 v1 读，不判坏。
  flow.version = normalizeVersion(raw.version)
  return flow
}

/**
 * 保存一份流程（整份替换语义 + 乐观锁）。id 由 Host 决定，不信任请求体里的 id。
 *
 * 版本规则：
 * - 新建（磁盘上没有该文件）→ version = 1，忽略 body.version（POST 新建不需要预条件）；
 * - 更新且 body 带合法 version → 必须等于磁盘当前版本，否则抛 FlowConflictError；
 * - 更新且 body 不带 version → 无条件写入（兼容老调用方 / 脚本），版本照样 +1。
 *
 * 读版本、比版本、写文件三步在同一把按 flowId 的进程内锁里完成，见 withFlowLock。
 * @param {string} dir
 * @param {string} id
 * @param {unknown} body
 * @param {{ name?: string }} [fallback]
 * @returns {Promise<object>} 写入后的流程（含新 version）
 */
export async function saveFlow(dir, id, body, fallback) {
  const safe = checkId(id)
  if (!safe) throw new Error('流程 id 不合法（只允许小写字母、数字、连字符）')
  await ensureDir(dir)
  return withFlowLock(`${dir}\u0000${safe}`, async () => {
    const existing = await readFlow(dir, safe).catch(() => null)
    const expected = requestedVersion(body)
    // 冲突路径先校验后写：不匹配就直接抛，磁盘一个字节都不动。
    if (existing && expected !== undefined && expected !== existing.version) {
      throw new FlowConflictError(existing.version, existing.updatedAt, digestOf(existing))
    }
    // 覆盖之前先留一份旧版本：任何一次「整份替换」都不该是不可逆的。
    if (existing) await stashFlowHistory(dir, safe, existing.version)
    const now = new Date().toISOString()
    const flow = normalizeFlow(body, (existing && existing.name) || (fallback && fallback.name) || '未命名流程')
    flow.id = safe
    flow.version = existing ? normalizeVersion(existing.version) + 1 : INITIAL_VERSION
    flow.createdAt = existing ? existing.createdAt : flow.createdAt || now
    flow.updatedAt = now
    await writeJsonAtomic(join(dir, `${safe}.json`), flow)
    return flow
  })
}

/**
 * 删除一份流程。
 *
 * 文件真的删掉（返回 true）之后，才把它在 `.history` 下的活动备份归档进
 * `.history/deleted/`；归档只是兜底，读写历史失败都不影响「文件在不在」这个返回值。
 * @returns {Promise<boolean>} 原本是否存在
 */
export async function deleteFlow(dir, id) {
  const safe = checkId(id)
  if (!safe) return false
  try {
    await unlink(join(dir, `${safe}.json`))
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
  await retireFlowHistory(dir, safe).catch(() => {})
  return true
}
