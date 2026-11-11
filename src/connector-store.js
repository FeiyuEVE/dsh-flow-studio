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
 *   - 人工处置：`resolveInvocation()` 支持 mark-succeeded / mark-failed / retry，
 *     只改记录与追加 `audit.jsonl`，不推进引擎、不伪造活动完成。
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

/** 可选定位字段：缺省 / null → null；非法 → 明确报错。 */
function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return null
  return requireId(value, field)
}

/** 人工处置允许的动作；未知动作直接拒绝（不做「猜意图」）。 */
const RESOLVE_ACTIONS = new Set(['mark-succeeded', 'mark-failed', 'retry', 'clear-tombstone'])
const MAX_EVIDENCE_CHARS = 2000
const MAX_RESOLUTION_RESULT_BYTES = 64 * 1024

function requireEvidence(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConnectorStoreError('HTTP_RESOLVE_INVALID', '人工处置必须带非空 evidence（远端对账依据 / 工单号）。', {
      field: 'evidence',
    })
  }
  const text = value.trim()
  if (text.length > MAX_EVIDENCE_CHARS) {
    throw new ConnectorStoreError('HTTP_RESOLVE_INVALID', `evidence 不能超过 ${MAX_EVIDENCE_CHARS} 字符。`, {
      field: 'evidence',
    })
  }
  return text
}

function requireOperator(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConnectorStoreError('HTTP_RESOLVE_INVALID', 'operator 必须是非空字符串（或省略）。', { field: 'operator' })
  }
  const text = value.trim()
  if (text.length > 128) {
    throw new ConnectorStoreError('HTTP_RESOLVE_INVALID', 'operator 不能超过 128 字符。', { field: 'operator' })
  }
  return text
}

/** 人工补录的 succeeded 结果：只保留短元信息，体积有界。 */
function normalizeManualResult(raw) {
  if (raw === undefined || raw === null) {
    return { status: 0, headers: {}, output: {}, manual: true }
  }
  if (!isPlainObject(raw)) {
    throw new ConnectorStoreError('HTTP_RESOLVE_INVALID', 'result 必须是 { status?, headers?, output? } 对象。', {
      field: 'result',
    })
  }
  const status = raw.status === undefined
    ? 0
    : (Number.isSafeInteger(raw.status) && raw.status >= 0 && raw.status <= 599 ? raw.status : null)
  if (status === null) {
    throw new ConnectorStoreError('HTTP_RESOLVE_INVALID', 'result.status 必须是 0–599 的整数。', { field: 'result.status' })
  }
  if (raw.headers !== undefined && raw.headers !== null && !isPlainObject(raw.headers)) {
    throw new ConnectorStoreError('HTTP_RESOLVE_INVALID', 'result.headers 必须是对象。', { field: 'result.headers' })
  }
  if (raw.output !== undefined && raw.output !== null && !isPlainObject(raw.output)) {
    throw new ConnectorStoreError('HTTP_RESOLVE_INVALID', 'result.output 必须是对象。', { field: 'result.output' })
  }
  const result = {
    status,
    headers: isPlainObject(raw.headers) ? { ...raw.headers } : {},
    output: isPlainObject(raw.output) ? { ...raw.output } : {},
    manual: true,
  }
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
  if (bytes > MAX_RESOLUTION_RESULT_BYTES) {
    throw new ConnectorStoreError(
      'HTTP_RESOLVE_INVALID',
      `人工补录结果 ${bytes} 字节超过上限 ${MAX_RESOLUTION_RESULT_BYTES} 字节。`,
      { field: 'result', bytes, limit: MAX_RESOLUTION_RESULT_BYTES },
    )
  }
  return result
}

/** 追加一条审计记录（JSONL，追加写 + 尽力 fsync）；失败必须显式报出。 */
async function appendAudit(root, entry) {
  await fsp.mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, 'audit.jsonl')
  let handle = null
  try {
    handle = await fsp.open(path, 'a', 0o600)
    await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => {})
    throw new ConnectorStoreError(
      'HTTP_STORE_WRITE_FAILED',
      `写入 HTTP connector 处置审计失败：${error && error.code ? error.code : '未知错误'}`,
      { path },
    )
  }
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

/**
 * 记录写入世代（R2）。
 *
 * 存储写入（recordAttempt / commitResult / mark*）是在**调用方 deadline 之外**继续
 * 执行的：`Promise.race` 只能结束等待，不能取消已经排队的 fs 写入。为了不让「已经
 * 判超时的旧调用」在迟到时覆盖新调用，`beginInvocation` 每次真正取得记录所有权
 * （fresh / unknown / 人工 retry）都会把 `generation` +1；后续写入必须带上它所属的
 * 世代，不匹配就拒绝（`HTTP_STORE_STALE`）。
 *
 * 旧记录没有 generation（0.13.7 之前落盘）时按 0 处理：调用方不带 generation 时
 * 仍然兼容；带了却不匹配的写入一律拒绝。
 */
function recordGeneration(record) {
  return Number.isSafeInteger(record?.generation) && record.generation > 0 ? record.generation : 0
}

function nextGeneration(record) {
  return recordGeneration(record) + 1
}

/** 带 generation 的写入：不匹配说明记录已被新调用接管，直接拒绝而不是覆盖。 */
function assertGeneration(existing, input, action) {
  const expected = input.generation
  if (expected === undefined || expected === null) return
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new ConnectorStoreError(
      'HTTP_INVOCATION_INVALID',
      `${action} 的 generation 必须是 ≥1 的整数。`,
      { field: 'generation' },
    )
  }
  const actual = recordGeneration(existing)
  if (actual !== expected) {
    throw new ConnectorStoreError(
      'HTTP_STORE_STALE',
      `${action} 的写入世代已过期（期望 generation=${expected}，记录现在是 ${actual}）：`
      + '迟到的写入不能覆盖新调用。',
      { field: 'generation', expected, actual },
    )
  }
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
    // H5：随记录持久化可复现的激活身份（审计 / 排障用；记录键仍由 executionId 决定）。
    const activationAttempt = Number.isSafeInteger(input.activationAttempt) && input.activationAttempt > 0
      ? input.activationAttempt
      : null
    const engineExecutionId = optionalId(input.engineExecutionId, 'engineExecutionId')
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
            // 新一次 begin 取得记录所有权：旧调用迟到的写入不能覆盖 unknown 结论。
            generation: nextGeneration(existing),
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
          // 重新开始 = 新世代：上一轮未完成的迟到写入不得再改这条记录（R2）。
          generation: nextGeneration(existing),
          ...(activationAttempt === null ? {} : { activationAttempt }),
          ...(engineExecutionId === null ? {} : { engineExecutionId }),
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
        generation: 1,
        ...(activationAttempt === null ? {} : { activationAttempt }),
        ...(engineExecutionId === null ? {} : { engineExecutionId }),
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
      assertGeneration(existing, input, 'recordAttempt')
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
      assertGeneration(existing, input, 'commitResult')
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
      assertGeneration(existing, input, 'markOutcomeUnknown')
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

  /**
   * 请求**没有真正发出**时把记录回滚成可安全重开的状态（H4）：
   * `attempts=0` + state=started，重启后 `beginInvocation` 会当作 fresh。
   * 与 `markOutcomeUnknown` 的区别是语义：这里确定远端没收到任何请求。
   *
   * `input.fence === true` 时顺便把记录推进到新世代（R2）：这次补偿写入之后，
   * 仍排在锁队列里的旧 `recordAttempt` / `commitResult`（携带旧 generation）
   * 会被拒绝，不能让「确定未发送」被迟到的 `sent` 覆盖。
   */
  async function markNotSent(input = {}, reason = null) {
    const key = keyOf(input)
    const path = pathFor(key.digest)
    return withLock(key.digest, async () => {
      const existing = await readJson(path)
      if (existing === null) return null
      assertGeneration(existing, input, 'markNotSent')
      const updated = {
        ...existing,
        state: 'started',
        attempts: 0,
        result: null,
        ...(input.fence === true ? { generation: nextGeneration(existing) } : {}),
        error: {
          code: 'HTTP_NOT_SENT',
          message: typeof reason === 'string' && reason !== ''
            ? reason
            : '请求在发送前被取消 / 超时；远端没有收到请求。',
        },
        updatedAt: nowIso(),
      }
      await writeJsonAtomic(path, updated)
      return updated
    })
  }

  /** 列出本目录下的全部合法调用记录（按 updatedAt 倒序，排障 / 处置查找用）。 */
  async function listInvocations(instanceId) {
    const expected = requireId(instanceId, 'instanceId')
    let names
    try {
      names = await fsp.readdir(root)
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw new ConnectorStoreError(
        'HTTP_STORE_READ_FAILED',
        `读取 HTTP 调用记录目录失败：${error && error.code ? error.code : '未知错误'}`,
        { path: root },
      )
    }
    const records = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      const record = await readJson(join(root, name))
      if (record === null || record.instanceId !== expected) continue
      records.push(record)
    }
    records.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    return records
  }

  /**
   * 按「业务可见 id」找一条记录：`executionId`（稳定激活键）、`invocationId`、
   * 或引擎原始 `engineExecutionId` 都可以（人工从事件 / 日志里拿到哪个都能定位）。
   */
  async function findInvocation(instanceId, id) {
    const wanted = requireId(id, 'executionId')
    const records = await listInvocations(instanceId)
    return records.find(record => record.executionId === wanted
      || record.invocationId === wanted
      || record.engineExecutionId === wanted) ?? null
  }

  /**
   * 人工处置调用记录（m1）。**只改记录，不推进引擎、不伪造 activity/end**：
   *   - `mark-succeeded`：补录远端已确认成功（可带 result；缺省 status=0）；
   *   - `mark-failed`：确认远端失败 / 放弃；
   *   - `retry`：仅对未成功记录重置为 attempts=0，允许下一次同激活重放重新发送；
   *   - `clear-tombstone`：只解除实例的不可恢复墓碑（见 bpmn-runtime），不重放任何
   *     前序副作用、不改调用记录状态；重复提交幂等。
   *
   * 同一个动作对已处于目标状态的记录是幂等的（不重复写记录、不追加审计）。
   * 所有真实变更都追加 `audit.jsonl`（append-only，含 evidence / operator / 前后状态）。
   */
  async function resolveInvocation(input = {}, resolution = {}) {
    const key = keyOf(input)
    const path = pathFor(key.digest)
    const action = typeof resolution.action === 'string' ? resolution.action.trim().toLowerCase() : ''
    if (!RESOLVE_ACTIONS.has(action)) {
      throw new ConnectorStoreError(
        'HTTP_RESOLVE_INVALID',
        `处置动作必须是 mark-succeeded / mark-failed / retry / clear-tombstone（收到 ${JSON.stringify(action)}）。`,
        { field: 'action' },
      )
    }
    const evidence = requireEvidence(resolution.evidence)
    const operator = requireOperator(resolution.operator)
    const manualResult = action === 'mark-succeeded'
      ? normalizeManualResult(resolution.result)
      : null
    return withLock(key.digest, async () => {
      const existing = await readJson(path)
      if (existing === null) {
        throw new ConnectorStoreError(
          'HTTP_INVOCATION_NOT_FOUND',
          `没有找到调用记录 ${key.executionId}（实例 ${key.instanceId} 的 connector 目录）。`,
          { instanceId: key.instanceId, executionId: key.executionId },
        )
      }
      const previousState = existing.state ?? 'unknown'
      const previousAction = typeof existing.resolution?.action === 'string' ? existing.resolution.action : null
      let idempotent = false
      let next = existing
      if (action === 'mark-succeeded') {
        idempotent = existing.state === 'succeeded'
        if (!idempotent) {
          next = {
            ...existing,
            state: 'succeeded',
            result: manualResult,
            error: null,
            updatedAt: nowIso(),
            completedAt: nowIso(),
          }
        }
      } else if (action === 'mark-failed') {
        idempotent = existing.state === 'failed' && existing.error?.code === 'HTTP_MANUAL_FAILED'
        if (!idempotent) {
          next = {
            ...existing,
            state: 'failed',
            error: { code: 'HTTP_MANUAL_FAILED', message: evidence },
            updatedAt: nowIso(),
            completedAt: nowIso(),
          }
        }
      } else if (action === 'clear-tombstone') {
        // 只清记录侧的处置标记；实例的墓碑快照由 runtime 在同一请求里删除。
        // 记录状态、attempts、result、error 一律不动（不重放、不伪造结果）。
        idempotent = existing.tombstoneCleared === true
        if (!idempotent) {
          next = {
            ...existing,
            tombstoneCleared: true,
            tombstoneClearedAt: nowIso(),
            tombstoneEvidence: evidence,
            tombstoneOperator: operator ?? 'operator',
            updatedAt: nowIso(),
          }
        }
      } else {
        // retry：已成功 / 已确认失败且记录本身已是可重开状态时才幂等；其他情况要求显式重置。
        if (existing.state === 'succeeded') {
          throw new ConnectorStoreError(
            'HTTP_RESOLVE_CONFLICT',
            '这条调用记录已经是 succeeded；retry 会重发已成功的副作用，必须改用 mark-failed 明确放弃或新建实例。',
            { executionId: key.executionId },
          )
        }
        idempotent = existing.state === 'started' && (existing.attempts ?? 0) === 0
        if (!idempotent) {
          next = {
            ...existing,
            state: 'started',
            attempts: 0,
            result: null,
            error: null,
            retryAuthorizedAt: nowIso(),
            // 人工 retry 也是一次新世代：旧调用迟到的 recordAttempt / commitResult
            // 不能在重置之后又把记录写回 sent / succeeded（R2）。
            generation: nextGeneration(existing),
            updatedAt: nowIso(),
          }
        }
      }
      if (idempotent) {
        return {
          idempotent: true,
          record: existing,
          audit: isPlainObject(existing.resolution?.lastAudit) ? existing.resolution.lastAudit : null,
        }
      }
      const at = nowIso()
      const audit = {
        v: 1,
        auditId: randomBytes(8).toString('hex'),
        at,
        instanceId: key.instanceId,
        elementId: key.elementId,
        executionId: key.executionId,
        invocationId: typeof existing.invocationId === 'string' ? existing.invocationId : null,
        action,
        evidence,
        operator: operator ?? 'operator',
        fromState: previousState,
        toState: next.state,
        idempotent: false,
        ...(action === 'clear-tombstone' ? { tombstoneCleared: true } : {}),
        ...(previousAction === null ? {} : { previousAction }),
      }
      const history = Array.isArray(existing.resolution?.history) ? existing.resolution.history : []
      next.resolution = {
        action,
        evidence,
        operator: audit.operator,
        at,
        lastAuditId: audit.auditId,
        lastAudit: audit,
        history: [...history, {
          auditId: audit.auditId,
          action,
          evidence,
          operator: audit.operator,
          at,
          fromState: previousState,
          toState: next.state,
        }].slice(-20),
      }
      await writeJsonAtomic(path, next)
      await appendAudit(root, audit)
      return { idempotent: false, record: next, audit }
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
    markNotSent,
    listInvocations,
    findInvocation,
    resolveInvocation,
    readInvocation,
  }
}
