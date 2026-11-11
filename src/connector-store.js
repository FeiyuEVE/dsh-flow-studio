/**
 * HTTP connector 的调用记录存储（0.13.6 恢复语义）。
 *
 * 每次 execution 一条记录，目录由 runtime 注入（通常是
 * `<instancesRoot>/<instanceId>/connector/`）。记录文件按 instanceId + elementId +
 * executionId 的 sha256 命名，内容只放定位、hash、幂等键与**已校验的短结果**，
 * 不放请求/响应正文，也不放任何密钥值。
 *
 * 语义（docs/plan/0.14 §B）：
 *   - `beginInvocation()` 在发送前落盘（state=started，attempts=0）；
 *   - `recordAttempt()` 在每次真正发出请求前落盘（state=sent，attempts=N）；
 *   - `commitResult()` 在把结果返回引擎前落盘（state=succeeded/failed）；
 *   - 重启后：
 *       * 已持久化成功结果 → 直接复用，不再请求远端；
 *       * 有 attempts 但没有成功结果（远端可能已处理、本地不知道）→ 返回
 *         outcomeUnknown，由 connector 报 `HTTP_OUTCOME_UNKNOWN`，**不自动重发**；
 *       * 只有 started 且 attempts=0（请求一定没发出）→ 允许重新发送。
 *
 * 写文件用 tmp + fsync + rename，避免断电后留下半截 JSON 被当成事实。
 *
 * @module @feiyueve/dsh-flow-studio/connector-store
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const STORE_VERSION = 1
const MAX_ID_CHARS = 256

/** 结构化存储错误（`code` 供 connector 透传成 lastError.code）。 */
export class ConnectorStoreError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'ConnectorStoreError'
    this.code = code
    this.details = details !== undefined && details !== null && typeof details === 'object' ? details : undefined
  }
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ID_CHARS) {
    throw new ConnectorStoreError(
      'HTTP_INVOCATION_INVALID',
      `调用记录的 ${field} 必须是非空字符串（≤${MAX_ID_CHARS} 字符）。`,
      { field },
    )
  }
  return value.trim()
}

function requireHash(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ConnectorStoreError('HTTP_INVOCATION_INVALID', '调用记录的 requestHash 必须是 sha256 小写 hex。', {
      field: 'requestHash',
    })
  }
  return value
}

function keyOf(input) {
  const instanceId = requireId(input.instanceId, 'instanceId')
  const elementId = requireId(input.elementId, 'elementId')
  const executionId = requireId(input.executionId, 'executionId')
  const digest = createHash('sha256')
    .update(`${instanceId}\0${elementId}\0${executionId}`, 'utf8')
    .digest('hex')
  return { instanceId, elementId, executionId, digest }
}

function nowIso() {
  return new Date().toISOString()
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readJson(path) {
  let text
  try {
    text = await fsp.readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw new ConnectorStoreError(
      'HTTP_STORE_READ_FAILED',
      `读取 HTTP 调用记录失败：${error && error.code ? error.code : '未知错误'}`,
      { path },
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    // 半截文件（非原子写的历史残留）不能当成事实：报损坏而不是猜。
    throw new ConnectorStoreError('HTTP_STORE_CORRUPT', 'HTTP 调用记录不是合法 JSON（可能被截断）。', { path })
  }
}

/** tmp + fsync + rename，保证读者只会看到完整 JSON。 */
async function writeJsonAtomic(path, value) {
  const dir = dirname(path)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.${randomBytes(8).toString('hex')}.tmp`)
  const body = `${JSON.stringify(value, null, 2)}\n`
  let handle = null
  try {
    handle = await fsp.open(tmp, 'w', 0o600)
    await handle.writeFile(body, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fsp.rename(tmp, path)
    // 目录 fsync 尽力而为：平台不支持（Windows）时忽略。
    try {
      const dirHandle = await fsp.open(dir, 'r')
      try {
        await dirHandle.sync()
      } finally {
        await dirHandle.close()
      }
    } catch {
      // 目录 fsync 在部分平台不可用；文件本身已 fsync + rename。
    }
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => {})
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw new ConnectorStoreError(
      'HTTP_STORE_WRITE_FAILED',
      `写入 HTTP 调用记录失败：${error && error.code ? error.code : '未知错误'}`,
      { path },
    )
  }
}

/**
 * 创建一个调用记录存储。`root` 必须由宿主显式给出（不回落当前目录）。
 *
 * @param {{ root: string }} options
 */
export function createConnectorStore(options = {}) {
  if (!isPlainObject(options) || typeof options.root !== 'string' || options.root.trim() === '') {
    throw new ConnectorStoreError('HTTP_STORE_UNAVAILABLE', 'HTTP connector 缺少调用记录目录（store.root）。')
  }
  const root = resolve(options.root)
  /** 同一条记录的文件锁：同一 execution 的重复 begin/attempt 不交叉写。 */
  const locks = new Map()

  async function withLock(digest, task) {
    const previous = locks.get(digest) ?? Promise.resolve()
    let release
    const gate = new Promise(resolveGate => { release = resolveGate })
    const tail = previous.then(() => gate)
    locks.set(digest, tail)
    await previous.catch(() => {})
    try {
      return await task()
    } finally {
      release()
      if (locks.get(digest) === tail) locks.delete(digest)
    }
  }

  function pathFor(digest) {
    return join(root, `${digest}.json`)
  }

  async function readByKey(input) {
    const key = keyOf(input)
    const path = pathFor(key.digest)
    return { key, path, record: await readJson(path) }
  }

  /**
   * 发送前登记。返回：
   *   - `{ status: 'fresh', record }`：没有历史记录，或历史记录在发送前中断；
   *   - `{ status: 'reuse', result }`：已有成功结果，直接复用；
   *   - `{ status: 'unknown', record }`：已发出但结果不明，调用方必须报
   *     `HTTP_OUTCOME_UNKNOWN` 且不得重发。
   */
  async function beginInvocation(input = {}) {
    const key = keyOf(input)
    const requestHash = requireHash(input.requestHash)
    const idempotencyKey = input.idempotencyKey === undefined || input.idempotencyKey === null
      ? null
      : String(input.idempotencyKey)
    const invocationId = requireId(input.invocationId ?? `${key.executionId}-inv`, 'invocationId')
    const path = pathFor(key.digest)

    return withLock(key.digest, async () => {
      const existing = await readJson(path)
      if (existing !== null) {
        if (typeof existing.requestHash === 'string' && existing.requestHash !== requestHash) {
          throw new ConnectorStoreError(
            'HTTP_REQUEST_CONFLICT',
            `调用记录 ${invocationId} 已存在但请求内容不同（requestHash 不匹配）；不覆盖旧结果，也不会发第二次请求。`,
            { instanceId: key.instanceId, elementId: key.elementId, executionId: key.executionId },
          )
        }
        if (existing.state === 'succeeded' && isPlainObject(existing.result)) {
          return { status: 'reuse', record: existing, result: existing.result }
        }
        const attempts = Number.isSafeInteger(existing.attempts) ? existing.attempts : 0
        if (attempts > 0) {
          const updated = {
            ...existing,
            state: 'unknown',
            error: {
              code: 'HTTP_OUTCOME_UNKNOWN',
              message: '上次调用已发送但结果未落盘；为避免重复副作用，重启后不自动重发。',
            },
            updatedAt: nowIso(),
          }
          await writeJsonAtomic(path, updated)
          return { status: 'unknown', record: updated }
        }
        // 只有 started / attempts=0：请求一定没有发出，可以安全重新开始。
        const restarted = {
          ...existing,
          state: 'started',
          attempts: 0,
          result: null,
          error: null,
          idempotencyKey,
          invocationId,
          updatedAt: nowIso(),
        }
        await writeJsonAtomic(path, restarted)
        return { status: 'fresh', record: restarted }
      }

      const createdAt = nowIso()
      const record = {
        v: STORE_VERSION,
        instanceId: key.instanceId,
        elementId: key.elementId,
        executionId: key.executionId,
        invocationId,
        requestHash,
        idempotencyKey,
        state: 'started',
        attempts: 0,
        result: null,
        error: null,
        createdAt,
        updatedAt: createdAt,
      }
      await writeJsonAtomic(path, record)
      return { status: 'fresh', record }
    })
  }

  /** 真正发请求前落盘 attempts / state=sent。 */
  async function recordAttempt(input = {}, attemptInfo = {}) {
    const key = keyOf(input)
    const path = pathFor(key.digest)
    const attempt = Number(attemptInfo.attempt)
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new ConnectorStoreError('HTTP_INVOCATION_INVALID', 'recordAttempt 的 attempt 必须是 ≥1 的整数。', { field: 'attempt' })
    }
    return withLock(key.digest, async () => {
      const existing = await readJson(path)
      if (existing === null) {
        throw new ConnectorStoreError('HTTP_STORE_NOT_STARTED', 'recordAttempt 之前没有 beginInvocation 记录。', {
          executionId: key.executionId,
        })
      }
      const updated = {
        ...existing,
        state: 'sent',
        attempts: attempt,
        lastAttemptAt: typeof attemptInfo.at === 'string' ? attemptInfo.at : nowIso(),
        updatedAt: nowIso(),
      }
      await writeJsonAtomic(path, updated)
      return updated
    })
  }

  /**
   * 落盘最终结果（在回调引擎之前）。`state` 只接受 succeeded / failed。
   * `result` 只放短元信息（status / headers / 已校验的 output），不放响应正文。
   */
  async function commitResult(input = {}, outcome = {}) {
    const key = keyOf(input)
    const path = pathFor(key.digest)
    const state = outcome.state === 'failed' ? 'failed' : 'succeeded'
    const result = isPlainObject(outcome.result) ? outcome.result : null
    const error = isPlainObject(outcome.error) ? outcome.error : null
    return withLock(key.digest, async () => {
      const existing = await readJson(path)
      if (existing === null) {
        throw new ConnectorStoreError('HTTP_STORE_NOT_STARTED', 'commitResult 之前没有 beginInvocation 记录。', {
          executionId: key.executionId,
        })
      }
      const updated = {
        ...existing,
        state,
        result: state === 'succeeded' ? result : existing.result ?? null,
        error: state === 'failed' ? error : null,
        updatedAt: nowIso(),
        completedAt: nowIso(),
      }
      await writeJsonAtomic(path, updated)
      return updated
    })
  }

  /** 取消 / 进程退出等场景：明确标成结果不明，后续不自动重发。 */
  async function markOutcomeUnknown(input = {}, reason = null) {
    const key = keyOf(input)
    const path = pathFor(key.digest)
    return withLock(key.digest, async () => {
      const existing = await readJson(path)
      if (existing === null) return null
      const updated = {
        ...existing,
        state: 'unknown',
        error: {
          code: 'HTTP_OUTCOME_UNKNOWN',
          message: typeof reason === 'string' && reason !== ''
            ? reason
            : 'HTTP 调用结果不明（已发送但未收到可确认的结果）。',
        },
        updatedAt: nowIso(),
      }
      await writeJsonAtomic(path, updated)
      return updated
    })
  }

  /** 只读：按 execution 身份取记录（测试 / 排障）。 */
  async function readInvocation(input = {}) {
    const { record } = await readByKey(input)
    return record
  }

  return {
    root,
    pathFor: input => pathFor(keyOf(input).digest),
    beginInvocation,
    recordAttempt,
    commitResult,
    markOutcomeUnknown,
    readInvocation,
  }
}
