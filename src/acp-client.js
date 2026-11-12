/**
 * ACP v1 客户端连接层（0.15.0 / P1）。
 *
 * 这一层只做「连接」：NDJSON 分帧、JSON-RPC 路由、请求超时、关闭收口、
 * `session/update` 截获投递、权限请求应答钩子。**不含任何业务状态**：
 * 不知道 session、不认识 update 变体、不决定权限策略（P3/P4 的事）。
 *
 * 实现选型：用官方 `@agentclientprotocol/sdk@2.6.0` 的稳定入口
 * （`ndJsonStream` / `client` / `methods` / `RequestError`），不自写第二套
 * 分帧器或 JSON-RPC 路由。SDK 的实际入口形状与方案描述有两处偏差，按实际 API 落地：
 *   1. `ndJsonStream(output, input, { maxMessageBytes })` —— **写端在前、读端在后**，
 *      与方案里写的 `ndJsonStream(input, output)` 顺序相反（方案描述有误）；
 *   2. 客户端入口是 `client({ name }).onRequest(method, handler).connect(stream)`，
 *      连接句柄为 `connection.agent.request/notify` + `connection.close(error)` +
 *      `connection.signal`（关闭原因在 `signal.reason`）。
 *
 * 为什么要在 SDK 路由**之前**再包一层对象级 TransformStream：
 *   - SDK 的 `ClientApp` 构造时最先注册 `SessionUpdateRouter`，它对每条
 *     `session/update` 做封闭 union 的 `zod.parse`，未知变体抛错后经
 *     `console.error` 旁路输出；万条坏 update 就是万行日志。截获层先校验外壳、
 *     投递 P3：`session/update` 内壳非法只计数丢弃；坏 JSON-RPC 外壳则由
 *     `violate()` 抛错并关闭整条连接，SDK 两者都看不到。
 *   - SDK 的 `Connection.handleResponse` 对**没有匹配请求**的响应执行
 *     `console.error("Got response to unknown request", response.id)` —— 直接把
 *     原始 id 写进日志。截获层记录「我们发出过的请求 id（含原类型，≤64）」，
 *     只放行集合内的响应；孤立 / 重复响应只计数，id 原文既不进日志也不进诊断。
 *   - 其余通知（`_auth/status_update` 等）只计数丢弃；`$/cancel_request` 必须
 *     原样交给 SDK（它负责 abort 反向请求的 `signal`）。
 *
 * 边界（与 P4 的契约）：
 *   - `openAcpClient` 不拥有进程，也不主动关闭底层流；`close()` 只收口连接（reject 全部
 *     pending、停止投递回调、abort `signal`）。注意 SDK 会在连接结束时 cancel 自己的
 *     reader，于是 `input` 的**读端**可能被 cancel（Node `Readable` 会因此 destroy）；
 *     写端不受影响。P4 仍须显式 destroy 两个 Node 流。
 *   - `closed` 只代表**协议连接结束**，原因在 `closedReason` / `signal.reason`，
 *     不代表写流或子进程已关闭。
 *   - 请求超时 = 关闭整条连接（所有 pending 统一失败），不是单个 Promise.race：
 *     留下一半悬挂请求会让调用方的取消计时永远等不到。
 *   - `session/cancel` 是通知不是请求；P4 用 `notify()` 发，且**不** abort 本地
 *     prompt promise，以便收到 `stopReason:"cancelled"`。
 *
 * 权限请求（入站反向请求）的 id 去重契约：**每个请求 id 恰好一次有效决策**。
 * 同一 id 再次到达时不调用 `onPermission`，直接回
 * `{outcome:{outcome:'cancelled'}}`（对端仍能收到一条应答，不会悬挂），
 * 只计 `permissionDuplicates` 并记一条 `permission-duplicate` 诊断；去重集合有界
 * （{@link MAX_PERMISSION_REQUEST_IDS} 条，超出淘汰最早插入项）。
 *
 * 返回句柄约定：
 *   - `request(method, params, { timeoutMs })`：`timeoutMs` 省略时用 `requestTimeoutMs`
 *     （默认 120s）；`0` = 不设超时。超时的那个请求与**全部**其它 pending 一起以
 *     {@link ACP_REQUEST_TIMEOUT} 失败。
 *   - `notify(method, params)`：通知无响应；写失败 / 连接已关闭时 reject 类型化错误。
 *   - `close(reason)`：幂等；`reason` 可以是字符串 / Error / `AcpClientError`（传
 *     {@link ACP_PROCESS_EXITED} 时 pending 继承该 code）。返回 `closed`。
 *   - `closed`：Promise，只在**协议连接结束**时 resolve（不 reject）；原因看
 *     `closedReason` / `signal.reason`。
 *   - `stats`：只读计数快照（`requests` / `updatesDelivered` / `updatesRejected` /
 *     `notificationsDropped` / `strayResponses` / `duplicateResponses` /
 *     `permissionRequests` / `permissionDuplicates` / `callbackFailures` / `diagnostics*` /
 *     `pending` / `closed`），
 *     供 P4 观测与诊断，不可反向驱动状态。
 *   - 已知 SDK 行为：`session/close` / `session/delete` 的 `-32002` 被 SDK 归一成成功 `{}`。
 *
 * @module @feiyueve/dsh-flow-studio/acp-client
 */

import { Buffer } from 'node:buffer'
import { Readable, Writable } from 'node:stream'

import { redactText } from './process-output.js'

/** 协议层失败（坏外壳 / 非法响应 / 超长帧 / 远端 rpc 错误 / EOF）。 */
export const ACP_PROTOCOL_ERROR = 'ACP_PROTOCOL_ERROR'

/** 请求超时（超时即关闭连接，全部 pending 统一失败）。 */
export const ACP_REQUEST_TIMEOUT = 'ACP_REQUEST_TIMEOUT'

/** 子进程退出 / stdout EOF（由 P4 在进程收口时显式传入；本层不猜进程状态）。 */
export const ACP_PROCESS_EXITED = 'ACP_PROCESS_EXITED'

/** 单条 NDJSON 消息默认上限：32 MiB（与 `agent-cli-stream.js` 的读行口径一致）。 */
export const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024

/** 请求默认超时：120s。`0` 表示不设超时（由调用方显式承担悬挂风险）。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

/** 错误正文硬上限（UTF-8 字节）。 */
export const MAX_ERROR_MESSAGE_BYTES = 1000

/** 诊断条数默认上限（按 code 去重后仍然有界）。 */
const DEFAULT_MAX_DIAGNOSTICS = 50

/** 同一 code 的诊断最多投递几条，之后只计数。 */
const DIAGNOSTICS_PER_CODE = 5

/** 单条诊断正文最大字符数。 */
const MAX_DIAGNOSTIC_CHARS = 200

/** 错误正文最大字符数（之后还会按字节再截一次）。 */
const MAX_ERROR_CHARS = 400

/** 追踪的 id 集合上限（请求 id / 已应答 id / 已见响应 id 各自独立）。 */
const MAX_TRACKED_IDS = 64

/** 入站权限请求 id 去重集合上限；同一 id 只允许一次有效决策。 */
const MAX_PERMISSION_REQUEST_IDS = 256

const SESSION_UPDATE_METHOD = 'session/update'
const CANCEL_REQUEST_METHOD = '$/cancel_request'
const PERMISSION_METHOD = 'session/request_permission'

/** ACP 方法名（日志 / 诊断里只回填符合该形状的名字，防日志注入与 secret 外泄）。 */
const METHOD_PATTERN = /^[A-Za-z0-9_$][A-Za-z0-9_$./-]{0,63}$/

/** `onPermission` 默认/兜底应答：cancelled。绝不把不认识的 outcome 当同意。 */
function cancelledPermission() {
  return { outcome: { outcome: 'cancelled' } }
}

/**
 * ACP 连接层的类型化错误。
 *
 * - `code`：{@link ACP_PROTOCOL_ERROR} / {@link ACP_REQUEST_TIMEOUT} /
 *   {@link ACP_PROCESS_EXITED}；
 * - `details`：**只放非敏感结构化字段**（`reason`、`rpcCode`、`timeoutMs`、
 *   `maxMessageBytes`），原始 JSON-RPC code 在这里，正文已脱敏并截到 1000 字节内。
 */
export class AcpClientError extends Error {
  constructor(code, message, details) {
    super(boundedUtf8Text(message, MAX_ERROR_MESSAGE_BYTES, MAX_ERROR_CHARS))
    this.name = 'AcpClientError'
    this.code = code
    this.details = Object.freeze({ ...(details ?? {}) })
  }
}

function positiveIntOr(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeIntOr(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonRpcId(value) {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

/** 方法名清洗：形状不对一律 'unknown'，绝不把原文写进诊断。 */
function sanitizeMethod(method) {
  if (typeof method !== 'string') return 'unknown'
  return METHOD_PATTERN.test(method) ? method : 'unknown'
}

/** 按码点截断（不切开代理对）。 */
function truncateCodePoints(text, maxChars) {
  if (text.length <= maxChars) return text
  let end = maxChars
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/** 按 UTF-8 字节截断：先编码再解码，末尾残字节产生的替换符整体去掉。 */
function truncateUtf8Bytes(text, maxBytes) {
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.length <= maxBytes) return text
  return encoded.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '')
}

/**
 * 脱敏 + 去控制字符 + 双重上限（字符数 + UTF-8 字节数）的展示文本。
 *
 * 诊断和错误正文都可能来自子进程 / 远端 / 回调异常，必须按同一口径收口。
 */
function boundedUtf8Text(raw, maxBytes, maxChars) {
  const text = redactText(typeof raw === 'string' ? raw : String(raw ?? ''))
  const normalized = text
    .replace(/[\u0000-\u001F\u007F]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return truncateUtf8Bytes(truncateCodePoints(normalized, maxChars), maxBytes)
}

/** 提取可展示的错误摘要（脱敏 + 有界）。 */
function errorMessage(error) {
  if (error instanceof Error) return boundedUtf8Text(error.message || error.name, 512, MAX_DIAGNOSTIC_CHARS)
  return boundedUtf8Text(error, 512, MAX_DIAGNOSTIC_CHARS)
}

/** 有界集合写入：超过上限时淘汰最早插入的一项。 */
function rememberBounded(set, value, limit = MAX_TRACKED_IDS) {
  if (set.has(value)) return
  if (set.size >= limit) {
    const oldest = set.values().next().value
    set.delete(oldest)
  }
  set.add(value)
}

function asWebReadable(value, label) {
  if (value && typeof value.getReader === 'function') return value
  if (value && typeof value.pipe === 'function' && typeof value.read === 'function') {
    return Readable.toWeb(value)
  }
  throw new AcpClientError(ACP_PROTOCOL_ERROR, `${label} 必须是 ReadableStream 或 Node Readable`, {
    reason: 'invalid-argument',
  })
}

function asWebWritable(value, label) {
  if (value && typeof value.getWriter === 'function') return value
  if (value && typeof value.write === 'function' && typeof value.on === 'function') {
    return Writable.toWeb(value)
  }
  throw new AcpClientError(ACP_PROTOCOL_ERROR, `${label} 必须是 WritableStream 或 Node Writable`, {
    reason: 'invalid-argument',
  })
}

/**
 * 打开一条 ACP v1 连接。
 *
 * @param {object} options
 * @param {ReadableStream<Uint8Array>|import('node:stream').Readable} options.input  agent → client 字节流
 * @param {WritableStream<Uint8Array>|import('node:stream').Writable} options.output client → agent 字节流
 * @param {(params: object) => void} [options.onUpdate] `session/update` 的 params（外壳已校验，同步投递，异常收敛）
 * @param {(context: {params: object, requestId: unknown, signal: AbortSignal}) => object} [options.onPermission]
 *   同步返回 ACP permission response；抛异常 / 形状不对一律按 cancelled 处理。
 *   同一 `requestId` 只会调用一次：重复 id 直接回 cancelled，不进入回调。
 * @param {(summary: {code: string, message: string}) => void} [options.onDiagnostic] 有界诊断
 * @param {number} [options.maxMessageBytes] 单行上限（默认 32 MiB，测试可注入小值）
 * @param {number} [options.requestTimeoutMs] 单请求默认超时（默认 120s；`0` = 不设）
 * @param {number} [options.maxDiagnostics] 诊断条数上限（默认 50）
 * @param {string} [options.clientName] SDK 诊断名（不含业务语义）
 * @returns {Promise<{request: Function, notify: Function, close: Function, closed: Promise<void>, signal: AbortSignal, pendingCount: number, closedReason: Error|null, stats: object}>}
 */
export async function openAcpClient(options = {}) {
  const {
    input,
    output,
    onUpdate,
    onPermission,
    onDiagnostic,
    clientName = 'dsh-flow-studio-acp',
  } = options

  const maxMessageBytes = positiveIntOr(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES)
  const defaultTimeoutMs = nonNegativeIntOr(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
  const maxDiagnostics = nonNegativeIntOr(options.maxDiagnostics, DEFAULT_MAX_DIAGNOSTICS)

  const sdk = await import('@agentclientprotocol/sdk')
  const webInput = asWebReadable(input, 'input')
  const webOutput = asWebWritable(output, 'output')

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  const counters = {
    requests: 0,
    updatesDelivered: 0,
    updatesRejected: 0,
    notificationsDropped: 0,
    invalidMessages: 0,
    strayResponses: 0,
    duplicateResponses: 0,
    permissionRequests: 0,
    permissionDuplicates: 0,
    callbackFailures: 0,
    diagnosticsSeen: 0,
    diagnosticsEmitted: 0,
    diagnosticsSuppressed: 0,
  }

  let pendingCount = 0
  let inputEnded = false
  let closedState = null
  let resolveClosed
  const closedPromise = new Promise(resolve => { resolveClosed = resolve })

  /** 我们发出过的请求 id（原类型，≤64）。只有集合内的 response 能进 SDK。 */
  const sentRequestIds = new Set()
  /** 已结算过的 id（含被丢弃的孤立响应），用于区分「重复」与「孤立」。 */
  const seenResponseIds = new Set()
  /** 已应答过的请求 id（诊断用途，暂未参与路由，保留给 P4 观察）。 */
  const answeredRequestIds = new Set()
  /**
   * 入站权限请求 id（有界）：每个 id 恰好一次有效决策。
   * 重复 id 仍回一条 cancelled 应答，但不再调用 onPermission、不产生第二条事件。
   */
  const permissionRequestIds = new Set()

  const diagnosticsByCode = new Map()

  function diagnose(code, message, extra) {
    counters.diagnosticsSeen += 1
    const seen = diagnosticsByCode.get(code) ?? 0
    diagnosticsByCode.set(code, seen + 1)
    if (seen >= DIAGNOSTICS_PER_CODE || counters.diagnosticsEmitted >= maxDiagnostics) {
      counters.diagnosticsSuppressed += 1
      return
    }
    counters.diagnosticsEmitted += 1
    if (typeof onDiagnostic !== 'function') return
    const summary = { code, message: boundedUtf8Text(message, 512, MAX_DIAGNOSTIC_CHARS), ...(extra ?? {}) }
    try {
      onDiagnostic(summary)
    }
    catch {
      counters.callbackFailures += 1
    }
  }

  function snapshotStats() {
    return Object.freeze({ ...counters, pending: pendingCount, closed: closedState !== null })
  }

  // -------------------------------------------------------------------------
  // 错误归一化
  // -------------------------------------------------------------------------

  function isTooLarge(error) {
    return typeof error === 'object' && error !== null
      && (error instanceof sdk.MessageTooLargeError || error.name === 'MessageTooLargeError')
  }

  function normalizeFailure(error) {
    if (error instanceof AcpClientError) return error
    if (isTooLarge(error)) {
      return new AcpClientError(ACP_PROTOCOL_ERROR, `ACP 入站单行超过 ${maxMessageBytes} 字节上限`, {
        reason: 'message-too-large',
        maxMessageBytes,
      })
    }
    if (typeof error?.code === 'number') {
      return new AcpClientError(ACP_PROTOCOL_ERROR, error.message || 'ACP 远端返回错误', {
        reason: 'rpc-error',
        rpcCode: error.code,
      })
    }
    const reason = inputEnded ? 'stream-eof' : 'connection-closed'
    return new AcpClientError(ACP_PROTOCOL_ERROR, error?.message || 'ACP 连接已关闭', { reason })
  }

  function makeCloseError(reason) {
    if (reason instanceof AcpClientError) return reason
    if (reason instanceof Error) {
      return new AcpClientError(ACP_PROTOCOL_ERROR, reason.message || 'ACP 客户端已关闭', { reason: 'client-closed' })
    }
    if (typeof reason === 'string' && reason.length > 0) {
      return new AcpClientError(ACP_PROTOCOL_ERROR, `ACP 客户端已关闭：${reason}`, { reason: 'client-closed' })
    }
    return new AcpClientError(ACP_PROTOCOL_ERROR, 'ACP 客户端已关闭', { reason: 'client-closed' })
  }

  function writeFailureError(error) {
    if (error instanceof AcpClientError) return error
    return new AcpClientError(ACP_PROTOCOL_ERROR, `ACP 输出流写入失败：${errorMessage(error)}`, {
      reason: 'write-failed',
    })
  }

  // -------------------------------------------------------------------------
  // 入站路由（在 SDK 路由之前）
  // -------------------------------------------------------------------------

  function violate(message) {
    counters.invalidMessages += 1
    diagnose('invalid-shell', message)
    throw new AcpClientError(ACP_PROTOCOL_ERROR, message, { reason: 'invalid-shell' })
  }

  function isValidUpdateShell(params) {
    return isRecord(params)
      && typeof params.sessionId === 'string' && params.sessionId.length > 0
      && isRecord(params.update)
      && typeof params.update.sessionUpdate === 'string' && params.update.sessionUpdate.length > 0
  }

  function deliverUpdate(params) {
    counters.updatesDelivered += 1
    if (typeof onUpdate !== 'function') return
    try {
      onUpdate(params)
    }
    catch (error) {
      counters.callbackFailures += 1
      diagnose('update-callback-failed', `onUpdate 抛异常：${errorMessage(error)}`)
    }
  }

  function routeNotification(message, controller) {
    const method = message.method
    if (method === SESSION_UPDATE_METHOD) {
      if (!isValidUpdateShell(message.params)) {
        counters.updatesRejected += 1
        diagnose('invalid-session-update', 'session/update 外壳不合法，已丢弃')
        return
      }
      deliverUpdate(message.params)
      return
    }
    if (method === CANCEL_REQUEST_METHOD) {
      // SDK 需要它来 abort 反向请求（如权限请求）的 signal，原样放行。
      controller.enqueue(message)
      return
    }
    counters.notificationsDropped += 1
    diagnose('notification-dropped', `未处理的通知已丢弃：${sanitizeMethod(method)}`)
  }

  function routeResponse(message, controller) {
    const id = message.id
    if (sentRequestIds.has(id)) {
      sentRequestIds.delete(id)
      rememberBounded(seenResponseIds, id)
      rememberBounded(answeredRequestIds, id)
      controller.enqueue(message)
      return
    }
    const duplicated = seenResponseIds.has(id)
    if (duplicated) counters.duplicateResponses += 1
    else counters.strayResponses += 1
    rememberBounded(seenResponseIds, id)
    diagnose(
      'response-dropped',
      duplicated
        ? '重复的 ACP 响应已丢弃（id 不对应任何在途请求）'
        : '孤立的 ACP 响应已丢弃（id 不对应任何在途请求）',
    )
  }

  function routeInbound(message, controller) {
    if (closedState) return
    if (!isRecord(message)) violate('入站 ACP 消息不是 JSON 对象')
    if (message.jsonrpc !== '2.0') violate('入站 ACP 消息不是 JSON-RPC 2.0')
    if (typeof message.method === 'string') {
      if (!Object.hasOwn(message, 'id')) {
        routeNotification(message, controller)
        return
      }
      if (!isJsonRpcId(message.id)) violate('入站 ACP 请求的 id 类型不合法')
      controller.enqueue(message)
      return
    }
    if (Object.hasOwn(message, 'id')) {
      routeResponse(message, controller)
      return
    }
    violate('入站 ACP 消息既没有 method 也没有 id')
  }

  // -------------------------------------------------------------------------
  // 传输：SDK NDJSON ↔ 对象级截获层
  // -------------------------------------------------------------------------

  // 注意 SDK 的实际签名是 (output, input, options)，写端在前。
  const rawStream = sdk.ndJsonStream(webOutput, webInput, { maxMessageBytes })

  const inboundTransform = new TransformStream({
    transform(message, controller) {
      routeInbound(message, controller)
    },
    flush() {
      inputEnded = true
    },
  })

  const outboundTransform = new TransformStream({
    transform(message, controller) {
      // 只有「我们发出的请求」才把 id 记进集合；响应 / 通知不记。
      if (isRecord(message) && typeof message.method === 'string'
        && Object.hasOwn(message, 'id') && isJsonRpcId(message.id)) {
        rememberBounded(sentRequestIds, message.id)
      }
      controller.enqueue(message)
    },
  })

  let connection = null

  function closeInternal(error) {
    if (closedState || !connection) return
    connection.close(error)
  }

  void outboundTransform.readable.pipeTo(rawStream.writable).catch(error => {
    closeInternal(writeFailureError(error))
  })

  const permissionHandler = context => {
    counters.permissionRequests += 1
    const { params, requestId, signal } = context ?? {}
    // 每个请求 id 恰好一次有效决策：重复 id 只回一条 cancelled（对端不悬挂），
    // 不再调用 onPermission，也不产生第二条 agent/permission 事件。
    if (isJsonRpcId(requestId) && permissionRequestIds.has(requestId)) {
      counters.permissionDuplicates += 1
      diagnose('permission-duplicate', '同一权限请求 id 重复到达：只回 cancelled，不再调用 onPermission')
      return cancelledPermission()
    }
    if (isJsonRpcId(requestId)) rememberBounded(permissionRequestIds, requestId, MAX_PERMISSION_REQUEST_IDS)
    if (typeof onPermission !== 'function') return cancelledPermission()
    let response
    try {
      response = onPermission({ params, requestId, signal })
    }
    catch (error) {
      counters.callbackFailures += 1
      diagnose('permission-callback-failed', `onPermission 抛异常：${errorMessage(error)}`)
      return cancelledPermission()
    }
    if (!isRecord(response) || !isRecord(response.outcome)) return cancelledPermission()
    const { outcome } = response
    if (outcome.outcome === 'selected') {
      return typeof outcome.optionId === 'string' && outcome.optionId.length > 0
        ? { outcome: { outcome: 'selected', optionId: outcome.optionId } }
        : cancelledPermission()
    }
    return cancelledPermission()
  }

  const app = sdk.client({ name: clientName })
  app.onRequest(PERMISSION_METHOD, permissionHandler)
  connection = app.connect({
    readable: rawStream.readable.pipeThrough(inboundTransform),
    writable: outboundTransform.writable,
  })

  void connection.closed.then(() => {
    if (!closedState) {
      closedState = { error: normalizeFailure(connection.signal?.reason) }
    }
    sentRequestIds.clear()
    answeredRequestIds.clear()
    permissionRequestIds.clear()
    seenResponseIds.clear()
    resolveClosed()
  })

  // -------------------------------------------------------------------------
  // 请求 / 通知 / 关闭
  // -------------------------------------------------------------------------

  function resolveTimeoutMs(requested) {
    if (Number.isSafeInteger(requested) && requested >= 0) return requested
    return defaultTimeoutMs
  }

  function withDeadline(response, timeoutMs, method) {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const error = new AcpClientError(ACP_REQUEST_TIMEOUT, `ACP 请求 '${method}' 超时（${timeoutMs}ms）`, {
          reason: 'timeout',
          timeoutMs,
        })
        // 超时收口整条连接：绝不让其它 pending 继续悬挂。
        closeInternal(error)
        reject(error)
      }, timeoutMs)
      response.then(
        value => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  async function request(method, params, requestOptions = {}) {
    if (closedState) throw closedState.error
    const name = sanitizeMethod(method)
    if (name === 'unknown') {
      throw new AcpClientError(ACP_PROTOCOL_ERROR, 'request 的 method 不是合法 ACP 方法名', {
        reason: 'invalid-argument',
      })
    }
    counters.requests += 1
    pendingCount += 1
    const timeoutMs = resolveTimeoutMs(requestOptions?.timeoutMs)
    try {
      const response = connection.agent.request(method, params)
      if (timeoutMs > 0) return await withDeadline(response, timeoutMs, name)
      return await response
    }
    catch (error) {
      throw normalizeFailure(error)
    }
    finally {
      pendingCount -= 1
    }
  }

  function notify(method, params) {
    if (closedState) return Promise.reject(closedState.error)
    const name = sanitizeMethod(method)
    if (name === 'unknown') {
      return Promise.reject(new AcpClientError(ACP_PROTOCOL_ERROR, 'notify 的 method 不是合法 ACP 方法名', {
        reason: 'invalid-argument',
      }))
    }
    return Promise.resolve()
      .then(() => connection.agent.notify(method, params))
      .catch(error => { throw normalizeFailure(error) })
  }

  function close(reason) {
    if (!closedState) closeInternal(makeCloseError(reason))
    return closedPromise
  }

  return {
    request,
    notify,
    close,
    closed: closedPromise,
    get signal() { return connection.signal },
    get pendingCount() { return pendingCount },
    get closedReason() { return closedState ? closedState.error : null },
    get stats() { return snapshotStats() },
  }
}
