/**
 * 流程运行实例域存储：`$DSH_HOME/flow-studio/instances/<instanceId>/`
 *
 * 布局（0.13 计划 §2）：
 *   instance.json         实例元数据（可变，原子写；乐观锁 revision）
 *   state.json            引擎快照缓存（{savedAt, state} 包装，可为空）
 *   definition.bpmn       定义快照副本：实例启动时从定义域复制，之后**只读它**
 *   events/<activityId>/<attempt>.jsonl  事件分片（append-only）
 *   .lock                 每个实例一把跨进程粗粒度锁
 *
 * 硬规则：
 *   - 启动时把 `definitionId + definitionVersion + definitionHash` 钉进 instance.json，
 *     定义后续被改 / 被删都不影响本实例（读定义正文一律读快照，不回头问定义域）；
 *   - `seq` 由本模块分配：先在实例锁内把 `lastSeq` 原子写进 instance.json，再追加事件行，
 *     进程中途被杀只会留下「已分配未落盘」的 seq 空洞，**绝不重复**；
 *   - 目录 0700、文件 0600；坏 JSON / 坏形状抛结构化错误，不写半截。
 *
 * @module @feiyueve/dsh-flow-studio/instance-store
 */

import { Buffer } from 'node:buffer'
import { createHash, randomInt } from 'node:crypto'
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { definitionsDir, readDefinition, readDefinitionVersion } from './definition-store.js'
import { MAX_BATCH_EVENTS, MAX_EVENT_BYTES, checkRunId } from './runlog.js'
import { resolveHome } from './store.js'

/** 与 run / flow / definition 存储同口径。 */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

const INSTANCE_FILE = 'instance.json'
const STATE_FILE = 'state.json'
const SNAPSHOT_FILE = 'definition.bpmn'
const EVENTS_DIR = 'events'
const LOCK_FILE = '.lock'

/** instance.json 上限：变量与 result 各有独立预算，这个只是兜底。 */
const MAX_INSTANCE_BYTES = 1024 * 1024
/** 引擎快照上限（计划 §3.2：7–18KB 是常态，4MB 是异常闸门）。 */
export const MAX_INSTANCE_STATE_BYTES = 4 * 1024 * 1024
/** variables / result 的序列化字节预算。 */
const MAX_VARIABLES_BYTES = 256 * 1024
const MAX_RESULT_BYTES = 256 * 1024
/** 单实例事件总数上限（与 run 事件同量级）。 */
const MAX_INSTANCE_EVENTS = 200000

/** 锁参数：临界区只有本地文件读写（毫秒级）。 */
const LOCK_TTL_MS = 10 * 1000
const LOCK_WAIT_MS = 15 * 1000

const HASH_PATTERN = /^[0-9a-f]{64}$/
const ATTEMPT_FILE = /^(\d+)\.jsonl$/

/** 实例状态集合。`blocked` = 卡住（可重试，不是终态）；终态只有 done / aborted。 */
export const INSTANCE_STATUSES = Object.freeze(['pending', 'running', 'waiting', 'blocked', 'done', 'aborted'])
const STATUS_SET = new Set(INSTANCE_STATUSES)
const TERMINAL_STATUSES = Object.freeze(['done', 'aborted'])
const TERMINAL_SET = new Set(TERMINAL_STATUSES)
/** updateInstance 的字段白名单；定义域字段是钉死的，改它们一律 400。 */
const PATCH_KEYS = new Set(['expectedVersion', 'status', 'variables', 'result', 'pendingTasks', 'blockedReason'])
/** 人工待办上限：BPMN 0.13.0 一次只会停在少量 userTask 上，100 是异常闸门。 */
const MAX_PENDING_TASKS = 100

let tmpCounter = 0

const sleep = ms => new Promise(resolveSleep => { setTimeout(resolveSleep, ms) })

/** 带 HTTP 语义的错误：调用方按 status / code / reason 分流。 */
export class InstanceError extends Error {
  constructor(status, code, reason, extra = {}) {
    super(reason)
    this.name = 'InstanceError'
    this.status = status
    this.code = code
    this.reason = reason
    Object.assign(this, extra)
  }

  toPayload() {
    const payload = { ok: false, code: this.code, error: this.reason }
    if (this.field) payload.field = this.field
    if (this.expectedVersion !== undefined) payload.expectedVersion = this.expectedVersion
    if (this.actualVersion !== undefined) payload.actualVersion = this.actualVersion
    return payload
  }
}

/** instances 根目录；每次调用重新解析，便于测试注入 DSH_HOME。 */
export function instancesDir(home) {
  return join(home || resolveHome(process.env), 'flow-studio', 'instances')
}

/** 生成 `i-<base36 时间>-<随机 4 位>`。 */
export function newInstanceId(now = Date.now()) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 4; i += 1) suffix += alphabet[randomInt(alphabet.length)]
  return `i-${now.toString(36)}-${suffix}`
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

function sizeOfJson(value, field) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', `${field} 不能被序列化为 JSON（含循环引用 / BigInt？）`, { field })
  }
}

function instancesRootOf(options = {}) {
  const explicit = options && typeof options.instancesRoot === 'string' ? options.instancesRoot.trim() : ''
  if (explicit.length > 0) return resolve(explicit)
  const home = options && typeof options.home === 'string' && options.home.trim().length > 0
    ? options.home.trim()
    : resolveHome(process.env)
  return instancesDir(home)
}

function definitionsRootOf(options = {}) {
  const explicit = options && typeof options.definitionsRoot === 'string' ? options.definitionsRoot.trim() : ''
  if (explicit.length > 0) return resolve(explicit)
  const home = options && typeof options.home === 'string' && options.home.trim().length > 0
    ? options.home.trim()
    : resolveHome(process.env)
  return definitionsDir(home)
}

/** id → 目录；非法 id 返回 null，路径越界也返回 null。 */
function locate(root, id) {
  const checked = checkRunId(id)
  if (!checked) return null
  const base = resolve(root)
  const dir = resolve(base, checked)
  const rel = relative(base, dir)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return { id: checked, root: base, dir }
}

function requireLoc(root, id) {
  const loc = locate(root, id)
  if (!loc) {
    throw new InstanceError(
      400,
      'INSTANCE_INVALID_ID',
      'instanceId 只能由字母 / 数字 / 点 / 下划线 / 连字符组成，不以点开头，且不超过 64 字符',
      { field: 'instanceId' },
    )
  }
  return loc
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
    return path
  } finally {
    if (!renamed) await unlink(tmp).catch(() => {})
  }
}

async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function readJson(path, maxBytes = MAX_INSTANCE_BYTES) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', `${path.split('/').pop()} 超过 ${maxBytes} 字节上限`)
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) }
  } catch {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', `${path.split('/').pop()} 不是合法 JSON`)
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
 * 跨进程互斥（照 `src/runstore.js` 的 `meta.lock` 模式）：`O_EXCL` + nonce 复核 +
 * 过期锁 `rename` 接管。本 helper 不建目录——调用方先确认实例目录存在，
 * 避免对已删除实例的写操作「复活」空目录。
 */
async function withFileLock(dir, task, options = {}) {
  const path = join(dir, options.name || LOCK_FILE)
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : LOCK_TTL_MS
  const waitMs = Number.isSafeInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : LOCK_WAIT_MS
  const conflictCode = options.conflictCode || 'INSTANCE_LOCK_TIMEOUT'
  const conflictReason = options.conflictReason || '另一个进程正在写这个实例，请稍后重试'
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
      throw new InstanceError(409, conflictCode, conflictReason)
    }
    await sleep(8)
  }
}

/** 变量快照：必须是普通对象（浅拷贝隔离调用方后续改动），有界。 */
function normalizeVariables(raw) {
  if (raw === undefined || raw === null) return {}
  if (!isPlainObject(raw)) {
    throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', 'variables 必须是 JSON 对象', { field: 'variables' })
  }
  if (sizeOfJson(raw, 'variables') > MAX_VARIABLES_BYTES) {
    throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', `variables 超过 ${MAX_VARIABLES_BYTES} 字节上限`, { field: 'variables' })
  }
  return { ...raw }
}

/**
 * 阻塞原因（`status==='blocked'` 时的事实留痕）：`{ code, message, nodeId?, activityId?, reminders? }`。
 *
 * 只保留稳定字段；`code` 必填（错误码是消费方分流依据），`message` 缺省成空串。
 * @param {unknown} raw
 * @returns {null | { code: string, message: string, nodeId?: string, activityId?: string, reminders?: number }}
 */
function normalizeBlockedReason(raw) {
  if (raw === undefined || raw === null) return null
  if (!isPlainObject(raw)) {
    throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', 'blockedReason 必须是 JSON 对象或 null', { field: 'blockedReason' })
  }
  const code = typeof raw.code === 'string' && raw.code.trim() !== '' ? raw.code.trim() : null
  if (!code) {
    throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', 'blockedReason.code 必须是非空字符串', { field: 'blockedReason.code' })
  }
  const out = { code, message: typeof raw.message === 'string' ? raw.message : '' }
  if (typeof raw.nodeId === 'string' && raw.nodeId !== '') out.nodeId = raw.nodeId
  if (typeof raw.activityId === 'string' && raw.activityId !== '') out.activityId = raw.activityId
  if (Number.isSafeInteger(raw.reminders) && raw.reminders >= 0) out.reminders = raw.reminders
  return out
}

function normalizeResult(raw) {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (!isPlainObject(raw)) {
    throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', 'result 必须是 JSON 对象或 null', { field: 'result' })
  }
  if (sizeOfJson(raw, 'result') > MAX_RESULT_BYTES) {
    throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', `result 超过 ${MAX_RESULT_BYTES} 字节上限`, { field: 'result' })
  }
  return { ...raw }
}

/**
 * 人工待办表（BPMN userTask）。`pendingTasks` 是**观测面**：由 BPMN 运行时在
 * `activity/wait` 时整表替换，读侧只用来回答「谁在等人」。
 *
 * 只保留稳定字段（activityId / elementId / name / since / executionId），
 * 丢掉调用方塞进来的任意键，避免把无关大对象写进 instance.json。
 * @param {unknown} raw
 * @returns {Array<object>}
 */
function normalizePendingTasks(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', 'pendingTasks 必须是数组', { field: 'pendingTasks' })
  }
  if (raw.length > MAX_PENDING_TASKS) {
    throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', `pendingTasks 最多 ${MAX_PENDING_TASKS} 条`, { field: 'pendingTasks' })
  }
  return raw.map((task, index) => {
    if (!isPlainObject(task)) {
      throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', `pendingTasks[${index}] 必须是对象`, { field: `pendingTasks[${index}]` })
    }
    // activityId 是 BPMN 活动 id，只出现在 JSON 与事件里，不参与落盘路径；因此按
    // 「非空、有界字符串」校验即可（BPMN id 可能是中文等非 ASCII，不能套 run id 规则）。
    const activityId = typeof task.activityId === 'string'
      && task.activityId.trim() !== ''
      && task.activityId.length <= 128
      ? task.activityId
      : null
    if (!activityId) {
      throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', `pendingTasks[${index}].activityId 必须是非空字符串（≤128）`, { field: `pendingTasks[${index}].activityId` })
    }
    const normalized = { activityId }
    for (const key of ['elementId', 'name', 'since', 'executionId']) {
      if (typeof task[key] === 'string' && task[key] !== '') normalized[key] = task[key]
      else if (task[key] === null && key === 'name') normalized[key] = null
    }
    return normalized
  })
}

/** 磁盘上的 instance.json → 收敛后的对象；任何字段坏掉都按 INSTANCE_CORRUPT 报。 */
function normalizeInstance(raw, id) {
  if (!isPlainObject(raw)) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', 'instance.json 必须是 JSON 对象')
  }
  if (raw.id !== id) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', 'instance.json 的 id 与目录名不一致')
  }
  if (!checkRunId(raw.definitionId)) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', 'instance.json 的 definitionId 非法')
  }
  if (!Number.isSafeInteger(raw.definitionVersion) || raw.definitionVersion < 1) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', 'instance.json 的 definitionVersion 必须是 ≥1 的整数')
  }
  if (typeof raw.definitionHash !== 'string' || !HASH_PATTERN.test(raw.definitionHash)) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', 'instance.json 的 definitionHash 必须是 64 位小写十六进制')
  }
  if (!STATUS_SET.has(raw.status)) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', `instance.json 的 status 必须是 ${INSTANCE_STATUSES.join(' / ')} 之一`)
  }
  if (!isIsoTimestamp(raw.createdAt) || !isIsoTimestamp(raw.updatedAt)) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', 'instance.json 的 createdAt / updatedAt 必须是 ISO 时间')
  }
  if (raw.completedAt !== null && raw.completedAt !== undefined && !isIsoTimestamp(raw.completedAt)) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', 'instance.json 的 completedAt 必须是 ISO 时间或 null')
  }
  if (!isPlainObject(raw.variables)) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', 'instance.json 的 variables 必须是 JSON 对象')
  }
  if (raw.result !== null && raw.result !== undefined && !isPlainObject(raw.result)) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', 'instance.json 的 result 必须是 JSON 对象或 null')
  }
  let blockedReason = null
  if (raw.blockedReason !== null && raw.blockedReason !== undefined) {
    try {
      blockedReason = normalizeBlockedReason(raw.blockedReason)
    } catch (error) {
      throw new InstanceError(500, 'INSTANCE_CORRUPT', `instance.json 的 blockedReason 形状非法：${error?.reason ?? error?.message ?? error}`)
    }
  }
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', 'instance.json 的 revision 必须是 ≥1 的整数')
  }
  if (!Number.isSafeInteger(raw.eventCount) || raw.eventCount < 0) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', 'instance.json 的 eventCount 必须是非负整数')
  }
  if (!Number.isSafeInteger(raw.lastSeq) || raw.lastSeq < 0) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', 'instance.json 的 lastSeq 必须是非负整数')
  }
  if (raw.lastSeq < raw.eventCount) {
    throw new InstanceError(500, 'INSTANCE_CORRUPT', 'instance.json 的 lastSeq 不能小于 eventCount')
  }
  return {
    id,
    definitionId: raw.definitionId,
    definitionVersion: raw.definitionVersion,
    definitionHash: raw.definitionHash,
    status: raw.status,
    variables: { ...raw.variables },
    result: raw.result === undefined || raw.result === null ? null : { ...raw.result },
    blockedReason,
    pendingTasks: normalizePendingTasks(raw.pendingTasks),
    revision: raw.revision,
    eventCount: raw.eventCount,
    lastSeq: raw.lastSeq,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    completedAt: raw.completedAt === undefined ? null : raw.completedAt,
    definitionSnapshot: SNAPSHOT_FILE,
  }
}

/** 实例目录必须存在；不存在 → 404（不能靠 mkdir 把已删除实例复活）。 */
async function requireInstanceDir(loc) {
  let info
  try {
    info = await stat(loc.dir)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new InstanceError(404, 'INSTANCE_NOT_FOUND', `实例 ${loc.id} 不存在`)
    }
    throw error
  }
  if (!info.isDirectory()) {
    throw new InstanceError(404, 'INSTANCE_NOT_FOUND', `实例 ${loc.id} 不存在`)
  }
}

/** 锁内读 instance.json；不存在 → 404，坏形状 → 500。 */
async function readInstanceUnlocked(loc) {
  const loaded = await readJson(join(loc.dir, INSTANCE_FILE))
  if (loaded.kind === 'missing') {
    throw new InstanceError(404, 'INSTANCE_NOT_FOUND', `实例 ${loc.id} 不存在`)
  }
  return normalizeInstance(loaded.value, loc.id)
}

/** 收敛 updateInstance 的补丁；未知字段 400（定义域字段钉死，不能被 patch 掉）。 */
function normalizePatch(patch) {
  if (patch === undefined || patch === null) patch = {}
  if (!isPlainObject(patch)) {
    throw new InstanceError(400, 'INSTANCE_PATCH_INVALID', 'patch 必须是对象', { field: 'patch' })
  }
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.has(key)) {
      throw new InstanceError(400, 'INSTANCE_PATCH_INVALID', `patch.${key} 不是可更新字段（definitionId / definitionVersion / definitionHash 是钉死的）`, { field: `patch.${key}` })
    }
  }
  const source = {}
  if (patch.expectedVersion !== undefined && patch.expectedVersion !== null) {
    if (!Number.isSafeInteger(patch.expectedVersion) || patch.expectedVersion < 1) {
      throw new InstanceError(400, 'INSTANCE_PATCH_INVALID', 'expectedVersion 必须是 ≥1 的整数', { field: 'expectedVersion' })
    }
    source.expectedVersion = patch.expectedVersion
  }
  if (patch.status !== undefined) {
    if (!STATUS_SET.has(patch.status)) {
      throw new InstanceError(400, 'INSTANCE_PATCH_INVALID', `status 必须是 ${INSTANCE_STATUSES.join(' / ')} 之一`, { field: 'status' })
    }
    source.status = patch.status
  }
  if (patch.variables !== undefined) {
    if (!isPlainObject(patch.variables)) {
      throw new InstanceError(400, 'INSTANCE_PATCH_INVALID', 'variables 必须是 JSON 对象', { field: 'variables' })
    }
    source.variables = { ...patch.variables }
  }
  if (patch.result !== undefined) {
    source.result = normalizeResult(patch.result)
  }
  if (patch.pendingTasks !== undefined) {
    source.pendingTasks = normalizePendingTasks(patch.pendingTasks)
  }
  if (patch.blockedReason !== undefined) {
    source.blockedReason = normalizeBlockedReason(patch.blockedReason)
  }
  return source
}

/**
 * 创建实例：钉住定义版本 / hash，并把定义正文快照复制进实例目录。
 *
 * 定义一旦被读出来，后面所有读取都只看快照（`readInstanceDefinition`），
 * 定义域再改 / 再删都不影响本实例。
 *
 * @param {{definitionId: string, definitionVersion?: number, definitionHash?: string,
 *   variables?: object, home?: string, definitionsRoot?: string, instancesRoot?: string}} input
 * @returns {Promise<object>} 实例元数据（含 id / revision=1 / status='pending'）
 */
export async function createInstance(input = {}) {
  if (!isPlainObject(input)) {
    throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', 'createInstance 需要对象参数', { field: 'input' })
  }
  const definitionId = checkRunId(input.definitionId)
  if (!definitionId) {
    throw new InstanceError(400, 'INSTANCE_INVALID_ID', 'definitionId 非法', { field: 'definitionId' })
  }
  const defsRoot = definitionsRootOf(input)
  const root = instancesRootOf(input)
  const variables = normalizeVariables(input.variables)

  let definition
  if (input.definitionVersion === undefined || input.definitionVersion === null) {
    const meta = await readDefinition(definitionId, { definitionsRoot: defsRoot })
    if (!meta) {
      throw new InstanceError(404, 'DEFINITION_NOT_FOUND', `定义 ${definitionId} 不存在`, { field: 'definitionId' })
    }
    if (meta.latestVersion === null) {
      throw new InstanceError(404, 'DEFINITION_NOT_FOUND', `定义 ${definitionId} 还没有任何版本`, { field: 'definitionId' })
    }
    definition = await readDefinitionVersion(definitionId, meta.latestVersion, { definitionsRoot: defsRoot })
  } else {
    const version = typeof input.definitionVersion === 'string' && /^\d+$/.test(input.definitionVersion)
      ? Number(input.definitionVersion)
      : input.definitionVersion
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', 'definitionVersion 必须是 ≥1 的整数', { field: 'definitionVersion' })
    }
    definition = await readDefinitionVersion(definitionId, version, { definitionsRoot: defsRoot })
  }
  if (!definition) {
    throw new InstanceError(
      404,
      'DEFINITION_NOT_FOUND',
      `定义 ${definitionId} 的指定版本不存在`,
      { field: 'definitionVersion' },
    )
  }
  // 调用方如果带了它读到的 hash，就在建目录前复核一次：定义刚被人改过时拒绝钉住旧假设。
  if (input.definitionHash !== undefined && input.definitionHash !== null
    && input.definitionHash !== definition.hash) {
    throw new InstanceError(
      409,
      'DEFINITION_STALE',
      '定义内容在创建实例前发生了变化，请重新读取后再启动',
      { expectedHash: input.definitionHash, actualHash: definition.hash },
    )
  }

  const now = new Date().toISOString()
  await ensureDir(root)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = newInstanceId()
    const dir = resolve(root, id)
    try {
      // recursive:false → 目录已存在时 EEXIST，天然防 id 撞车。
      await mkdir(dir, { mode: DIR_MODE })
    } catch (error) {
      if (error && error.code === 'EEXIST') continue
      throw error
    }
    try {
      await chmod(dir, DIR_MODE).catch(() => {})
      await writeTextAtomic(join(dir, SNAPSHOT_FILE), definition.xml)
      const instance = {
        id,
        definitionId,
        definitionVersion: definition.version,
        definitionHash: definition.hash,
        status: 'pending',
        variables,
        result: null,
        blockedReason: null,
        pendingTasks: [],
        revision: 1,
        eventCount: 0,
        lastSeq: 0,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        definitionSnapshot: SNAPSHOT_FILE,
      }
      await writeJsonAtomic(join(dir, INSTANCE_FILE), instance)
      return instance
    } catch (error) {
      // 建到一半失败：删掉半成品目录，绝不留下「没有 instance.json 的实例」。
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }
  throw new InstanceError(500, 'INSTANCE_ID_EXHAUSTED', '连续 5 次生成的实例 id 都撞车，请重试')
}

/**
 * 读一个实例；不存在返回 null，坏 JSON / 坏形状抛 INSTANCE_CORRUPT。
 * @param {string} id
 * @param {{ home?: string, instancesRoot?: string }} [options]
 */
export async function readInstance(id, options = {}) {
  const loc = locate(instancesRootOf(options), id)
  if (!loc) return null
  const loaded = await readJson(join(loc.dir, INSTANCE_FILE))
  if (loaded.kind === 'missing') return null
  return normalizeInstance(loaded.value, loc.id)
}

/**
 * 列实例（按 createdAt 倒序），可按定义 / 状态过滤。
 * 坏实例跳过（不让一条坏 instance.json 让整张列表 500）。
 *
 * @param {{definitionId?: string, status?: string, limit?: number,
 *   home?: string, instancesRoot?: string}} [filter]
 */
export async function listInstances(filter = {}) {
  const source = isPlainObject(filter) ? filter : {}
  let definitionId = null
  if (source.definitionId !== undefined && source.definitionId !== null) {
    definitionId = checkRunId(source.definitionId)
    if (!definitionId) {
      throw new InstanceError(400, 'INSTANCE_INVALID_ID', 'definitionId 非法', { field: 'definitionId' })
    }
  }
  let status = null
  if (source.status !== undefined && source.status !== null) {
    if (!STATUS_SET.has(source.status)) {
      throw new InstanceError(400, 'INSTANCE_FILTER_INVALID', `status 必须是 ${INSTANCE_STATUSES.join(' / ')} 之一`, { field: 'status' })
    }
    status = source.status
  }
  let limit = 200
  if (source.limit !== undefined) {
    if (!Number.isSafeInteger(source.limit) || source.limit < 1) {
      throw new InstanceError(400, 'INSTANCE_FILTER_INVALID', 'limit 必须是正整数', { field: 'limit' })
    }
    limit = Math.min(source.limit, 1000)
  }

  const root = instancesRootOf(source)
  await ensureDir(root)
  let names = []
  try {
    names = await readdir(root)
  } catch {
    names = []
  }
  const instances = []
  const skippedIds = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (!checkRunId(name)) continue
    try {
      const loaded = await readJson(join(root, name, INSTANCE_FILE))
      if (loaded.kind === 'missing') continue
      const instance = normalizeInstance(loaded.value, name)
      if (definitionId && instance.definitionId !== definitionId) continue
      if (status && instance.status !== status) continue
      instances.push(instance)
    } catch {
      skippedIds.push(name)
    }
  }
  instances.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  const page = instances.slice(0, limit)
  Object.defineProperty(page, 'skipped', {
    value: skippedIds, enumerable: false, configurable: true, writable: false,
  })
  return page
}

/**
 * 更新实例元数据（乐观锁）。
 *
 * `patch.expectedVersion` 与磁盘上的 `revision` 不一致 → 409 `INSTANCE_VERSION_CONFLICT`，
 * **一个字节都不写**；不给 expectedVersion 即无条件更新（版本号照样 +1）。
 * `variables` 是浅合并；`status` / `result` / `pendingTasks` 是替换；进入终态时
 * `pendingTasks` 自动清空。
 *
 * @param {string} id
 * @param {{expectedVersion?: number, status?: string, variables?: object, result?: object|null,
 *   pendingTasks?: Array<object>}} patch
 * @param {{ home?: string, instancesRoot?: string }} [options]
 */
export async function updateInstance(id, patch = {}, options = {}) {
  const loc = requireLoc(instancesRootOf(options), id)
  const source = normalizePatch(patch)
  await requireInstanceDir(loc)
  return withFileLock(loc.dir, async () => {
    const current = await readInstanceUnlocked(loc)
    if (source.expectedVersion !== undefined && source.expectedVersion !== current.revision) {
      throw new InstanceError(
        409,
        'INSTANCE_VERSION_CONFLICT',
        `实例已被更新（期望 revision ${source.expectedVersion}，当前 ${current.revision}），请重新读取后再写入`,
        { expectedVersion: source.expectedVersion, actualVersion: current.revision },
      )
    }
    const hasChange = source.status !== undefined || source.variables !== undefined
      || source.result !== undefined || source.pendingTasks !== undefined
      || source.blockedReason !== undefined
    if (!hasChange) return current

    // 终态不可逆（同一把写锁内判定）：晚到的 variables / result / 待办 / 产物 /
    // 状态切换一律拒绝，且**一个字节都不写**。blocked 不是终态，可以被重试或 stop 改掉。
    if (TERMINAL_SET.has(current.status)) {
      throw new InstanceError(
        409,
        'INSTANCE_TERMINAL_IMMUTABLE',
        `实例 ${loc.id} 已是终态 ${current.status}，拒绝任何后续写入（status/variables/result/pendingTasks/blockedReason）；终态不可逆`,
        { field: 'status', actualStatus: current.status },
      )
    }

    const now = new Date().toISOString()
    const next = {
      ...current,
      revision: current.revision + 1,
      updatedAt: now,
    }
    if (source.status !== undefined) {
      next.status = source.status
      next.completedAt = TERMINAL_SET.has(source.status) ? (current.completedAt || now) : null
      // 终态不再有「谁在等人」：即便调用方漏了 pendingTasks，也在这里清空。
      if (TERMINAL_SET.has(source.status) && source.pendingTasks === undefined) next.pendingTasks = []
    }
    if (source.variables !== undefined) {
      next.variables = { ...current.variables, ...source.variables }
      if (sizeOfJson(next.variables, 'variables') > MAX_VARIABLES_BYTES) {
        throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', `variables 超过 ${MAX_VARIABLES_BYTES} 字节上限`, { field: 'variables' })
      }
    }
    if (source.result !== undefined) next.result = source.result
    if (source.pendingTasks !== undefined) next.pendingTasks = source.pendingTasks
    if (source.blockedReason !== undefined) next.blockedReason = source.blockedReason
    // 离开 blocked（例如后续 retry 写回 running）时自动清掉旧原因；同一次提交显式给的
    // blockedReason 优先。
    if (source.status !== undefined && source.status !== 'blocked'
      && source.blockedReason === undefined && current.blockedReason !== null) {
      next.blockedReason = null
    }
    // blocked 必须带原因：这是「卡在哪」的唯一可读事实，不允许只写状态。
    if (next.status === 'blocked' && next.blockedReason === null) {
      throw new InstanceError(
        400,
        'INSTANCE_BLOCKED_REASON_REQUIRED',
        'status=blocked 必须同时提供 blockedReason{code,message}',
        { field: 'blockedReason' },
      )
    }
    const normalized = normalizeInstance(next, loc.id)
    await writeJsonAtomic(join(loc.dir, INSTANCE_FILE), normalized)
    return normalized
  })
}

/** 文件末尾是否缺换行（"半行"）：崩溃 / 写满会在 JSONL 尾部留下没换行的残行。 */
async function needsLeadingNewline(path) {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
  if (!info.isFile() || info.size === 0) return false
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(1)
    const { bytesRead } = await handle.read(buffer, 0, 1, info.size - 1)
    return bytesRead === 1 && buffer[0] !== 0x0a
  } finally {
    await handle.close()
  }
}

/**
 * 追加一批事件到 `events/<activityId>/<attempt>.jsonl`。
 *
 * seq 口径与 `runstore.appendEvents` 一致：**先分配后写事件**——先在实例锁内把
 * `lastSeq = lastSeq + N` 原子写进 instance.json，再追加事件行。进程在两步之间被杀
 * 只留下 seq 空洞（读侧允许空洞），绝不重复；文件末尾是半行时先补一个 `\n`，
 * 新事件不会粘进坏行。
 *
 * @param {string} id
 * @param {string} activityId
 * @param {number} attempt
 * @param {object|object[]} rawEvents 单条或数组
 * @param {{ home?: string, instancesRoot?: string }} [options]
 * @returns {Promise<{instanceId: string, activityId: string, attempt: number,
 *   firstSeq: number, lastSeq: number, events: object[], instance: object}>}
 */
export async function appendInstanceEvents(id, activityId, attempt, rawEvents, options = {}) {
  const loc = requireLoc(instancesRootOf(options), id)
  const activity = checkRunId(activityId)
  if (!activity) {
    throw new InstanceError(400, 'INSTANCE_INVALID_ID', 'activityId 非法', { field: 'activityId' })
  }
  const attemptNo = typeof attempt === 'string' && /^\d+$/.test(attempt) ? Number(attempt) : attempt
  if (!Number.isSafeInteger(attemptNo) || attemptNo < 1) {
    throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', 'attempt 必须是 ≥1 的整数', { field: 'attempt' })
  }
  const list = Array.isArray(rawEvents) ? rawEvents : [rawEvents]
  if (list.length === 0) {
    throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', '至少需要一条事件', { field: 'events' })
  }
  if (list.length > MAX_BATCH_EVENTS) {
    throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', `单批最多 ${MAX_BATCH_EVENTS} 条事件`, { field: 'events' })
  }
  for (let index = 0; index < list.length; index += 1) {
    if (!isPlainObject(list[index])) {
      throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', `events[${index}] 必须是对象`, { field: `events[${index}]` })
    }
  }
  await requireInstanceDir(loc)

  return withFileLock(loc.dir, async () => {
    const current = await readInstanceUnlocked(loc)
    if (current.eventCount + list.length > MAX_INSTANCE_EVENTS) {
      throw new InstanceError(400, 'INSTANCE_EVENTS_LIMIT', `单实例事件总数上限 ${MAX_INSTANCE_EVENTS}`, { field: 'events' })
    }
    const firstSeq = current.lastSeq + 1
    const lastSeq = current.lastSeq + list.length
    const assigned = []
    for (let index = 0; index < list.length; index += 1) {
      const event = { ...list[index], seq: firstSeq + index }
      let line
      try {
        line = JSON.stringify(event)
      } catch {
        throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', `events[${index}] 不能被序列化为 JSON`, { field: `events[${index}]` })
      }
      if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
        throw new InstanceError(400, 'INSTANCE_SHAPE_INVALID', `单条事件超过 ${MAX_EVENT_BYTES} 字节`, { field: `events[${index}]` })
      }
      assigned.push({ event, line })
    }

    const now = new Date().toISOString()
    const next = normalizeInstance({
      ...current,
      eventCount: current.eventCount + list.length,
      lastSeq,
      revision: current.revision + 1,
      updatedAt: now,
    }, loc.id)
    // ① 先原子分配 seq 区间：instance.json 写不进去就整批不写。
    await writeJsonAtomic(join(loc.dir, INSTANCE_FILE), next)

    // ② 再追加事件行；文件末尾是半行时先补换行。
    const shard = join(loc.dir, EVENTS_DIR, activity, `${attemptNo}.jsonl`)
    await ensureDir(join(loc.dir, EVENTS_DIR, activity))
    const prefix = await needsLeadingNewline(shard) ? '\n' : ''
    const text = assigned.map(item => `${item.line}\n`).join('')
    const handle = await open(shard, 'a', FILE_MODE)
    try {
      await handle.writeFile(`${prefix}${text}`, 'utf8')
    } finally {
      await handle.close()
    }
    await chmod(shard, FILE_MODE).catch(() => {})

    return {
      instanceId: loc.id,
      activityId: activity,
      attempt: attemptNo,
      firstSeq,
      lastSeq,
      events: assigned.map(item => item.event),
      instance: next,
    }
  })
}

/**
 * 给事件数组挂两个不可枚举的读侧诊断字段（`skipped` 坏行数 / `shards` 分片数），
 * 不污染 JSON 输出，也不改变「返回值就是事件数组」的契约。
 */
function decorateEvents(events, { skipped = 0, shards = 0 } = {}) {
  Object.defineProperty(events, 'skipped', {
    value: skipped, enumerable: false, configurable: true, writable: false,
  })
  Object.defineProperty(events, 'shards', {
    value: shards, enumerable: false, configurable: true, writable: false,
  })
  return events
}

/**
 * 读一个实例的全部事件，按 seq 升序合并所有分片。
 *
 * 读侧宽容：坏行（半行 / 手改坏）跳过而不是整批失败，跳过条数挂在返回数组的
 * 不可枚举属性 `skipped` 上。实例不存在返回 null。
 *
 * @param {string} id
 * @param {{ home?: string, instancesRoot?: string }} [options]
 * @returns {Promise<object[] | null>}
 */
export async function readInstanceEvents(id, options = {}) {
  const loc = locate(instancesRootOf(options), id)
  if (!loc) return null
  try {
    const info = await stat(loc.dir)
    if (!info.isDirectory()) return null
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  const eventsRoot = join(loc.dir, EVENTS_DIR)
  let activityDirs = []
  try {
    activityDirs = await readdir(eventsRoot, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return decorateEvents([])
    throw error
  }
  const merged = []
  let skipped = 0
  let shards = 0
  for (const activityEntry of activityDirs) {
    if (!activityEntry.isDirectory() || activityEntry.name.startsWith('.')) continue
    let files = []
    try {
      files = await readdir(join(eventsRoot, activityEntry.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const fileEntry of files) {
      if (!fileEntry.isFile()) continue
      const match = ATTEMPT_FILE.exec(fileEntry.name)
      if (!match) continue
      shards += 1
      const path = join(eventsRoot, activityEntry.name, fileEntry.name)
      let text = ''
      try {
        text = await readFile(path, 'utf8')
      } catch {
        skipped += 1
        continue
      }
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        let parsed
        try {
          parsed = JSON.parse(line)
        } catch {
          skipped += 1
          continue
        }
        if (!isPlainObject(parsed)) {
          skipped += 1
          continue
        }
        merged.push({
          activityId: activityEntry.name,
          attempt: Number(match[1]),
          file: `${activityEntry.name}/${fileEntry.name}`,
          seq: Number.isSafeInteger(parsed.seq) ? parsed.seq : -1,
          event: parsed,
        })
      }
    }
  }
  merged.sort((a, b) => (a.seq - b.seq) || String(a.file).localeCompare(String(b.file)))
  const events = merged.map(item => item.event)
  return decorateEvents(events, { skipped, shards })
}

/** state.json 可以是空文件 / 不存在：都按「没有快照」处理。 */
async function readStateText(loc) {
  let text
  try {
    text = await readFile(join(loc.dir, STATE_FILE), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_INSTANCE_STATE_BYTES) {
    throw new InstanceError(500, 'INSTANCE_STATE_CORRUPT', `state.json 超过 ${MAX_INSTANCE_STATE_BYTES} 字节上限`)
  }
  return text.trim() === '' ? null : text
}

/**
 * 写引擎快照（`state.json`）。state 是**缓存不是真相**：只原子整写，不参与乐观锁。
 * 实例不存在 → 404。
 *
 * @param {string} id
 * @param {object|null} state `engine.getState()` 的结果；null/undefined 写空快照
 * @param {{ home?: string, instancesRoot?: string }} [options]
 * @returns {Promise<{instanceId: string, savedAt: string, bytes: number}>}
 */
export async function writeInstanceState(id, state, options = {}) {
  const loc = requireLoc(instancesRootOf(options), id)
  await requireInstanceDir(loc)
  const payloadState = state === undefined || state === null ? {} : state
  if (!isPlainObject(payloadState)) {
    throw new InstanceError(400, 'INSTANCE_STATE_INVALID', '引擎快照必须是 JSON 对象', { field: 'state' })
  }
  const savedAt = new Date().toISOString()
  const text = `${JSON.stringify({ savedAt, state: payloadState }, null, 2)}\n`
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_INSTANCE_STATE_BYTES) {
    throw new InstanceError(400, 'INSTANCE_STATE_INVALID', `引擎快照超过 ${MAX_INSTANCE_STATE_BYTES} 字节上限`, { field: 'state' })
  }
  await writeTextAtomic(join(loc.dir, STATE_FILE), text)
  return { instanceId: loc.id, savedAt, bytes }
}

/**
 * 读引擎快照；文件不存在 / 空 → null，坏 JSON → `INSTANCE_STATE_CORRUPT`。
 *
 * @param {string} id
 * @param {{ home?: string, instancesRoot?: string }} [options]
 * @returns {Promise<object | null>}
 */
export async function readInstanceState(id, options = {}) {
  const loc = requireLoc(instancesRootOf(options), id)
  await requireInstanceDir(loc)
  const text = await readStateText(loc)
  if (text === null) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new InstanceError(500, 'INSTANCE_STATE_CORRUPT', 'state.json 不是合法 JSON')
  }
  if (!isPlainObject(parsed)) {
    throw new InstanceError(500, 'INSTANCE_STATE_CORRUPT', 'state.json 必须是 JSON 对象')
  }
  // 新格式 {savedAt, state}；老/手写文件直接把快照当根对象。
  if (Object.prototype.hasOwnProperty.call(parsed, 'state')
    && (Object.prototype.hasOwnProperty.call(parsed, 'savedAt') || Object.prototype.hasOwnProperty.call(parsed, 'v'))) {
    return parsed.state
  }
  return parsed
}

/**
 * 把实例收口成终态（**只有 done / aborted**；blocked 不是终态，用 updateInstance）。
 *
 * 同一终态重复提交幂等：不写盘、不涨 revision、不接受晚到的 result/variables；
 * 一个终态改成另一个终态 → 409 `INSTANCE_TERMINAL_IMMUTABLE`。
 * `options.variables` / `options.result` 会与终态**一次提交**。
 *
 * @param {string} id
 * @param {'done'|'aborted'} status
 * @param {{ home?: string, instancesRoot?: string, variables?: object, result?: object|null }} [options]
 */
export async function completeInstance(id, status, options = {}) {
  const loc = requireLoc(instancesRootOf(options), id)
  if (!TERMINAL_SET.has(status)) {
    throw new InstanceError(
      400,
      'INSTANCE_STATUS_INVALID',
      `终态只能是 ${TERMINAL_STATUSES.join(' / ')}；blocked（卡住）用 updateInstance 写`,
      { field: 'status' },
    )
  }
  await requireInstanceDir(loc)
  return withFileLock(loc.dir, async () => {
    const current = await readInstanceUnlocked(loc)
    // 同终态重复提交：幂等，不写盘、不涨 revision、不接受晚到的 result/variables。
    if (current.status === status) return current
    // 终态不可逆：done ↔ aborted 也不行。
    if (TERMINAL_SET.has(current.status)) {
      throw new InstanceError(
        409,
        'INSTANCE_TERMINAL_IMMUTABLE',
        `实例 ${loc.id} 已经是终态 ${current.status}，不能再改成 ${status}`,
        { actualStatus: current.status },
      )
    }
    const now = new Date().toISOString()
    const next = {
      ...current,
      status,
      completedAt: current.completedAt || now,
      pendingTasks: [],
      blockedReason: null,
      revision: current.revision + 1,
      updatedAt: now,
    }
    // 最终 result / variables 与终态**一次提交**：避免「先写终态、再补原因」被
    // 自己的终态保护挡住，也避免已 done 但最终输出未提交的窗口。
    if (options.variables !== undefined) {
      next.variables = { ...current.variables, ...normalizeVariables(options.variables) }
    }
    if (options.result !== undefined) next.result = normalizeResult(options.result)
    const normalized = normalizeInstance(next, loc.id)
    await writeJsonAtomic(join(loc.dir, INSTANCE_FILE), normalized)
    return normalized
  })
}

/**
 * 读实例目录里的定义快照（`definition.bpmn`）——**实例只读这份，不回头问定义域**。
 * 返回前按 instance.json 里的 `definitionHash` 复核，防快照被改。
 *
 * @param {string} id
 * @param {{ home?: string, instancesRoot?: string }} [options]
 * @returns {Promise<{instanceId: string, definitionId: string, definitionVersion: number,
 *   definitionHash: string, xml: string} | null>}
 */
export async function readInstanceDefinition(id, options = {}) {
  const loc = locate(instancesRootOf(options), id)
  if (!loc) return null
  const instance = await readInstance(id, options)
  if (!instance) return null
  const xml = await readTextOrNull(join(loc.dir, instance.definitionSnapshot))
  if (xml === null) {
    throw new InstanceError(500, 'INSTANCE_SNAPSHOT_MISSING', `实例 ${loc.id} 的定义快照 ${SNAPSHOT_FILE} 不存在`)
  }
  const actual = sha256(xml)
  if (actual !== instance.definitionHash) {
    throw new InstanceError(
      500,
      'INSTANCE_SNAPSHOT_CORRUPT',
      `实例 ${loc.id} 的定义快照与 definitionHash 不一致`,
      { expectedHash: instance.definitionHash, actualHash: actual },
    )
  }
  return {
    instanceId: instance.id,
    definitionId: instance.definitionId,
    definitionVersion: instance.definitionVersion,
    definitionHash: instance.definitionHash,
    xml,
  }
}
