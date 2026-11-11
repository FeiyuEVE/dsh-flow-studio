/**
 * HTTP connector：BPMN `serviceTask(nodeType="http")` 的真实执行器（0.13.6）。
 *
 * 关键约束（docs/plan/0.14-能力补齐与旧域退役.md §B）：
 *   - 只走 `node:http` / `node:https`，**不使用全局 fetch**，也不继承代理环境变量；
 *   - 目标校验与连接绑定：`validateDestination()` 解析并校验全部 DNS 结果，返回的
 *     `lookup` 被直接交给 request，连接不会二次解析域名；
 *   - 关闭重定向；3xx 直接失败；响应按实际读取字节限流，压缩响应按解压后体积限制；
 *   - 重试只覆盖瞬时网络错误 / 429 / 502 / 503 / 504；GET/HEAD 可重试，有副作用的
 *     方法只有在配置了远端幂等键时才允许自动重试；
 *   - 同一次 execution 的所有尝试共享一个幂等键；BPMN 循环再次激活会得到新 executionId，
 *     因而得到新键；
 *   - 调用记录先落盘再发请求、成功结果落盘后才回调引擎；恢复窗口见 connector-store；
 *   - 输入映射只在局部上下文求值，输出只合并显式映射的短标量（复用 finish 变量预算）；
 *   - 密钥 / 鉴权头值不进 XML、变量、事件、错误文本与日志。
 *
 * 返回 `{ output, status, headers, events }`：`output` 只含显式输出映射，`headers`
 * 只含白名单里的响应头。失败抛带 `code` 的 `HttpConnectorError`，由 bpmn-runner /
 * runtime 落成 `ACTIVE + lastError`（不是 FAILED / STUCK）。
 *
 * @module @feiyueve/dsh-flow-studio/http-connector
 */

import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

import { evaluateFeel } from './bpmn-expr.js'
import { createConnectorStore, ConnectorStoreError } from './connector-store.js'
import { NodeFinishError, validateFinishArgs } from './node-finish.js'
import {
  HTTP_METHODS,
  HttpPolicyError,
  isSecretHeaderName,
  normalizeHttpPolicy,
  redactHttpConfig,
  resolveAuthRef,
  validateDestination,
} from './http-policy.js'

/** 响应头白名单：只回传明确允许的元信息（绝不回 set-cookie / authorization）。 */
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'content-length',
  'etag',
  'last-modified',
  'retry-after',
  'x-request-id',
  'x-correlation-id',
  'cache-control',
  'location',
])

/** 可自动重试的瞬时网络错误码（DNS 永久失败 / 证书错误不在此列）。 */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
])

/** 可重试的 HTTP 状态码。 */
const TRANSIENT_STATUS = new Set([429, 502, 503, 504])

/** 重定向状态码：首版关闭，直接失败。 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** 结构化 connector 错误。 */
export class HttpConnectorError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'HttpConnectorError'
    this.code = code
    this.details = details !== undefined && details !== null && typeof details === 'object' ? details : undefined
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function describeCode(error) {
  if (error && typeof error.code === 'string' && error.code !== '') return error.code
  return 'UNKNOWN'
}

function ensureNotAborted(ctx) {
  if (ctx && ctx.signal && ctx.signal.aborted === true) {
    throw new HttpConnectorError('HTTP_CANCELED', 'HTTP 调用已取消（ctx.signal 已 abort），不把迟到响应写回流程。', {
      elementId: typeof ctx.activityId === 'string' ? ctx.activityId : null,
    })
  }
}

function isAbortError(ctx, error) {
  if (ctx && ctx.signal && ctx.signal.aborted === true) return true
  return error instanceof HttpConnectorError && error.code === 'HTTP_CANCELED'
}

function toHttpConnectorError(error) {
  if (error instanceof HttpConnectorError) return error
  if (error instanceof HttpPolicyError || error instanceof ConnectorStoreError) {
    return new HttpConnectorError(error.code, error.message, error.details)
  }
  return new HttpConnectorError('HTTP_INTERNAL_ERROR', 'HTTP connector 内部错误（详情已省略，避免泄露请求内容）。')
}

/** 把宿主 parse 出来的 headers 对象/字符串归一化成小写 key 的字符串 map。 */
function parseRequestHeaders(raw) {
  let source = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return {}
    try {
      source = JSON.parse(text)
    } catch {
      throw new HttpConnectorError('HTTP_HEADERS_INVALID', 'fs:http@headers 不是合法 JSON。')
    }
  }
  if (source === undefined || source === null) return {}
  if (!isPlainObject(source)) {
    throw new HttpConnectorError('HTTP_HEADERS_INVALID', 'fs:http@headers 必须是 JSON 对象。')
  }
  const headers = {}
  for (const [name, value] of Object.entries(source)) {
    if (typeof name !== 'string' || name.trim() === '') continue
    if (isSecretHeaderName(name)) {
      throw new HttpConnectorError(
        'HTTP_HEADER_SECRET_FORBIDDEN',
        `fs:http@headers 不允许写鉴权/密钥头 ${name}；密钥必须经宿主 authRef 解析，不能进 XML。`,
        { header: name },
      )
    }
    const text = typeof value === 'string' ? value : String(value)
    if (/[\r\n]/.test(text)) {
      throw new HttpConnectorError('HTTP_HEADERS_INVALID', `header ${name} 的值包含换行。`, { header: name })
    }
    headers[name.toLowerCase()] = text
  }
  return headers
}

/** 读 `fs:http` 的幂等配置；未配置返回 null。 */
function normalizeIdempotency(http) {
  const raw = isPlainObject(http.idempotency) ? http.idempotency : null
  const mode = raw && typeof raw.mode === 'string'
    ? raw.mode.trim().toLowerCase()
    : (typeof http.idempotencyMode === 'string' ? http.idempotencyMode.trim().toLowerCase() : '')
  if (mode === '' || mode === 'none') return null
  if (mode !== 'remote-key') {
    throw new HttpConnectorError(
      'HTTP_IDEMPOTENCY_MODE_INVALID',
      `fs:http 的 idempotency mode 只支持 remote-key（当前 ${JSON.stringify(mode)}）。`,
    )
  }
  const header = raw && typeof raw.header === 'string' && raw.header.trim() !== ''
    ? raw.header.trim()
    : (typeof http.idempotencyHeader === 'string' ? http.idempotencyHeader.trim() : '')
  if (header === '' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) {
    throw new HttpConnectorError(
      'HTTP_IDEMPOTENCY_HEADER_INVALID',
      'fs:http 的 idempotency.header 必须是合法的 HTTP header 名（例如 Idempotency-Key）。',
    )
  }
  if (isSecretHeaderName(header)) {
    throw new HttpConnectorError(
      'HTTP_IDEMPOTENCY_HEADER_INVALID',
      'idempotency.header 不能是鉴权/密钥头；它只承载本次调用的幂等键。',
    )
  }
  return { mode, header }
}

/** acceptStatuses 解析（parse 层已归一成整数数组；这里兼容字符串）。 */
function normalizeAcceptStatuses(raw) {
  if (raw === undefined || raw === null) return []
  if (Array.isArray(raw)) {
    return raw.filter(value => Number.isSafeInteger(value) && value >= 100 && value <= 599)
  }
  if (typeof raw === 'string') {
    return raw.split(',')
      .map(item => Number(item.trim()))
      .filter(value => Number.isSafeInteger(value) && value >= 100 && value <= 599)
  }
  return []
}

/**
 * 输入/输出映射：只认 `zeebe:ioMapping`。遗留 `fs:http.inputMapping/outputMapping`
 * 存在时明确拒绝（混用时错误码说明是「混用」）。
 */
function normalizeIoMapping(element, http) {
  const raw = isPlainObject(element.ioMapping) ? element.ioMapping : null
  const input = Array.isArray(raw?.input) ? raw.input : []
  const output = Array.isArray(raw?.output) ? raw.output : []
  const hasZeebe = input.length > 0 || output.length > 0
  const legacyInput = typeof http.inputMapping === 'string' && http.inputMapping.trim() !== ''
  const legacyOutput = typeof http.outputMapping === 'string' && http.outputMapping.trim() !== ''
  if (hasZeebe && (legacyInput || legacyOutput)) {
    throw new HttpConnectorError(
      'HTTP_MAPPING_AMBIGUOUS',
      '同一 http 节点同时配置了 zeebe:ioMapping 与 fs:http.inputMapping/outputMapping；0.13.6 只解释 zeebe:ioMapping，混用会得到两套语义，已拒绝。',
    )
  }
  if (!hasZeebe && (legacyInput || legacyOutput)) {
    throw new HttpConnectorError(
      'HTTP_MAPPING_LEGACY_UNSUPPORTED',
      'fs:http.inputMapping/outputMapping 已退役：请改写成 zeebe:ioMapping 的 inputParameters/outputParameters（FEEL source + target）。',
    )
  }
  return { input, output }
}

/**
 * 输入映射：在 `{ ...ctx.variables }` 的局部副本上求值，不修改实例变量。
 * 支持 target：`body` / `query.<name>` / `headers.<name>`（origin 不允许被映射修改）。
 */
function applyInputMappings(mappings, variables) {
  const local = { ...variables }
  const body = { present: false, value: undefined }
  const query = {}
  const headers = {}
  for (let index = 0; index < mappings.length; index += 1) {
    const mapping = mappings[index]
    const source = typeof mapping?.source === 'string' ? mapping.source.trim() : ''
    const target = typeof mapping?.target === 'string' ? mapping.target.trim() : ''
    if (source === '' || target === '') {
      throw new HttpConnectorError(
        'HTTP_INPUT_MAPPING_FAILED',
        `输入映射第 ${index + 1} 条缺少 source 或 target。`,
        { index },
      )
    }
    if (target.startsWith('url')) {
      throw new HttpConnectorError(
        'HTTP_MAPPING_TARGET_UNSUPPORTED',
        `输入映射 target=${target} 不允许：URL origin 固定在配置里，变量只能进入编码后的路径/查询参数。`,
        { index, target },
      )
    }
    const evaluated = evaluateFeel(source, local)
    if (!evaluated.ok) {
      throw new HttpConnectorError(
        'HTTP_INPUT_MAPPING_FAILED',
        `输入映射第 ${index + 1} 条（target=${target}）求值失败：${evaluated.error?.message ?? 'FEEL 错误'}`,
        { index, target, causeCode: evaluated.error?.code ?? null },
      )
    }
    const value = evaluated.value
    if (target === 'body') {
      body.present = true
      body.value = value
      continue
    }
    if (target.startsWith('query.')) {
      const name = target.slice('query.'.length)
      if (name === '') throw new HttpConnectorError('HTTP_MAPPING_TARGET_UNSUPPORTED', '输入映射 query 目标缺少参数名。', { index })
      query[name] = scalarForMapping(value, index, target)
      continue
    }
    if (target.startsWith('headers.')) {
      const name = target.slice('headers.'.length)
      if (name === '') throw new HttpConnectorError('HTTP_MAPPING_TARGET_UNSUPPORTED', '输入映射 headers 目标缺少 header 名。', { index })
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
        throw new HttpConnectorError(
          'HTTP_HEADER_INVALID',
          `输入映射 headers 目标 ${JSON.stringify(name)} 不是合法的 HTTP header 名。`,
          { index, header: name },
        )
      }
      if (isSecretHeaderName(name)) {
        throw new HttpConnectorError(
          'HTTP_HEADER_SECRET_FORBIDDEN',
          `输入映射不允许写鉴权/密钥头 ${name}；请用 authRef。`,
          { index, header: name },
        )
      }
      const headerValue = String(scalarForMapping(value, index, target))
      if (/[\r\n]/.test(headerValue)) {
        throw new HttpConnectorError(
          'HTTP_HEADER_INVALID',
          `输入映射 header ${name} 的值包含换行。`,
          { index, header: name },
        )
      }
      headers[name.toLowerCase()] = headerValue
      continue
    }
    throw new HttpConnectorError(
      'HTTP_MAPPING_TARGET_UNSUPPORTED',
      `输入映射 target=${target} 不支持；可用 body / query.<name> / headers.<name>。`,
      { index, target },
    )
  }
  return { body, query, headers }
}

function scalarForMapping(value, index, target) {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new HttpConnectorError(
    'HTTP_MAPPING_VALUE_INVALID',
    `映射第 ${index + 1} 条（target=${target}）只接受标量（字符串 / 有限数字 / 布尔 / null）。`,
    { index, target },
  )
}

/** 把映射出来的 body 归一成字符串（对象/数组按 JSON 发送）。 */
function serializeMappedBody(value) {
  if (value === undefined || value === null) return { text: '', isJson: false }
  if (typeof value === 'string') return { text: value, isJson: false }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { text: String(value), isJson: false }
  }
  try {
    return { text: JSON.stringify(value), isJson: true }
  } catch {
    throw new HttpConnectorError('HTTP_INPUT_MAPPING_FAILED', '输入映射的 body 不能被序列化为 JSON（含循环引用 / BigInt？）。')
  }
}

/** 输出映射：在局部响应上下文求值，只产出短标量；预算复用 finish 变量口径。 */
function applyOutputMappings(mappings, response, variables, elementId) {
  if (mappings.length === 0) return {}
  const context = {
    ...variables,
    response: {
      status: response.status,
      headers: { ...response.headers },
      body: response.body,
    },
  }
  const output = {}
  for (let index = 0; index < mappings.length; index += 1) {
    const mapping = mappings[index]
    const source = typeof mapping?.source === 'string' ? mapping.source.trim() : ''
    const target = typeof mapping?.target === 'string' ? mapping.target.trim() : ''
    if (source === '' || target === '') {
      throw new HttpConnectorError(
        'HTTP_OUTPUT_MAPPING_FAILED',
        `输出映射第 ${index + 1} 条缺少 source 或 target。`,
        { index, elementId },
      )
    }
    const evaluated = evaluateFeel(source, context)
    if (!evaluated.ok) {
      throw new HttpConnectorError(
        'HTTP_OUTPUT_MAPPING_FAILED',
        `输出映射第 ${index + 1} 条（target=${target}）求值失败：${evaluated.error?.message ?? 'FEEL 错误'}`,
        { index, target, causeCode: evaluated.error?.code ?? null },
      )
    }
    output[target] = scalarForMapping(evaluated.value, index, target)
  }
  try {
    return validateFinishArgs({ variables: output, documents: [], summary: 'http' }).variables
  } catch (error) {
    if (error instanceof NodeFinishError) {
      throw new HttpConnectorError(
        'HTTP_OUTPUT_INVALID',
        `输出映射未通过变量预算（≤32 键 / 单值 ≤512 字符 / 总 ≤8 KiB）：${error.message}`,
        { elementId, causeCode: error.code },
      )
    }
    throw error
  }
}

/** 结果里可以回传的响应头（白名单 + 小写）。 */
function allowedResponseHeaders(raw) {
  const output = {}
  for (const [name, value] of Object.entries(raw ?? {})) {
    const lower = name.toLowerCase()
    if (!RESPONSE_HEADER_ALLOWLIST.has(lower)) continue
    if (Array.isArray(value)) output[lower] = value.join(', ')
    else if (value !== undefined) output[lower] = String(value)
  }
  return output
}

function retryAfterMs(headers) {
  const raw = headers && headers['retry-after']
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const text = raw.trim()
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, 600_000)
  const at = Date.parse(text)
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.min(at - Date.now(), 600_000))
}

function backoffMs(policy, attempt, retryAfter) {
  if (retryAfter !== null && retryAfter !== undefined) return retryAfter
  const base = policy.retryBackoffBaseMs * (2 ** Math.max(0, attempt - 1))
  return Math.min(policy.retryBackoffMaxMs, base)
}

async function sleepUntil(ms, ctx) {
  if (!(ms > 0)) return
  try {
    await delay(ms, undefined, { signal: ctx?.signal })
  } catch {
    throw new HttpConnectorError('HTTP_CANCELED', 'HTTP 退避等待期间调用被取消。')
  }
}

/**
 * 发一次请求并按字节限制读取响应。
 * 返回 `{ status, headers, body, rawBytes, decodedBytes }`；超限 / 重定向已在此层拒绝。
 */
function performRequest(options) {
  const { method, url, headers, bodyText, validated, deadline, ctx } = options
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    let req = null
    let res = null

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (ctx?.signal && typeof ctx.signal.removeEventListener === 'function') {
        ctx.signal.removeEventListener('abort', onAbort)
      }
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => {
      const error = new HttpConnectorError('HTTP_CANCELED', 'HTTP 调用被取消，迟到响应不得推动流程。')
      // 先落定，再销毁流：destroy 可能同步触发 abort/error 事件，不能让它改写原因。
      finish(error)
      if (res !== null) res.destroy(error)
      if (req !== null) req.destroy(error)
    }

    if (ctx?.signal) {
      if (ctx.signal.aborted) {
        finish(new HttpConnectorError('HTTP_CANCELED', 'HTTP 调用已取消。'))
        return
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
    }

    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    const requestOptions = {
      method,
      protocol: url.protocol,
      hostname: validated.hostname,
      port: validated.port,
      path: `${url.pathname}${url.search}`,
      headers,
      // 关键：连接只使用 validateDestination() 校验过的地址。
      lookup: validated.lookup,
      // 不继承全局 agent / 代理；每次请求独立连接。
      agent: false,
      ...(url.protocol === 'https:'
        ? { servername: validated.hostname, rejectUnauthorized: true }
        : {}),
    }

    try {
      req = transport(requestOptions, response => {
        res = response
        if (settled) {
          response.destroy()
          return
        }
        readResponse(response, {
          method,
          url,
          requestOptions,
          ctx,
          deadline,
          limitBytes: options.limitBytes,
          finish,
          onAbort,
          isSettled: () => settled,
          setResponse: value => { res = value },
        })
      })
    } catch (error) {
      finish(classifyNetworkError(error))
      return
    }

    req.on('error', error => {
      if (settled) return
      if (error instanceof HttpConnectorError) {
        finish(error)
        return
      }
      finish(isAbortError(ctx, error) ? new HttpConnectorError('HTTP_CANCELED', 'HTTP 调用被取消。') : classifyNetworkError(error))
    })

    const remaining = Math.max(1, deadline - Date.now())
    timer = setTimeout(() => {
      const error = new HttpConnectorError('HTTP_TIMEOUT', `HTTP 请求超过整体时限（剩余 ${remaining}ms）未完成。`)
      finish(error)
      if (res !== null) res.destroy(error)
      req.destroy(error)
    }, remaining)
    if (typeof req.setTimeout === 'function') {
      req.setTimeout(remaining, () => {
        req.destroy(new HttpConnectorError('HTTP_TIMEOUT', 'HTTP 请求读取超时。'))
      })
    }

    if (bodyText !== undefined && bodyText !== null && bodyText !== '') {
      req.write(bodyText)
    }
    req.end()
  })
}

function classifyNetworkError(error) {
  const code = describeCode(error)
  const transient = TRANSIENT_NETWORK_CODES.has(code)
  return new HttpConnectorError(
    'HTTP_NETWORK_ERROR',
    `HTTP 请求失败（${code}）${transient ? '，属于可重试的瞬时网络错误' : ''}。`,
    { networkCode: code, transient },
  )
}

function readResponse(response, context) {
  const { method, url, ctx, deadline, finish, isSettled } = context
  const status = Number(response.statusCode ?? 0)
  const rawHeaders = isPlainObject(response.headers) ? response.headers : {}
  const headers = allowedResponseHeaders(rawHeaders)
  const rawDeclared = Number(rawHeaders['content-length'])
  const declaredLength = Number.isFinite(rawDeclared) && rawDeclared >= 0 ? rawDeclared : null
  const contentEncoding = String(rawHeaders['content-encoding'] ?? '').trim().toLowerCase()
  const limit = context.limitBytes

  // 重定向首版一律拒绝：不读正文，直接返回给调用方转成错误。
  if (REDIRECT_STATUS.has(status)) {
    finish(null, { status, headers, body: null, rawBytes: 0, decodedBytes: 0, redirect: true })
    response.destroy()
    return
  }

  const noBody = method === 'HEAD' || status === 204 || status === 304
  if (!noBody && declaredLength !== null && declaredLength > limit) {
    const error = new HttpConnectorError(
      'HTTP_RESPONSE_TOO_LARGE',
      `响应 content-length=${declaredLength} 超过上限 ${limit} 字节，已中止。`,
      { limit, declaredLength },
    )
    finish(error)
    response.destroy(error)
    return
  }
  let decoder = null
  if (!noBody && contentEncoding !== '' && contentEncoding !== 'identity') {
    if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') decoder = createGunzip()
    else if (contentEncoding === 'deflate') decoder = createInflate()
    else if (contentEncoding === 'br') decoder = createBrotliDecompress()
    else {
      const error = new HttpConnectorError(
        'HTTP_RESPONSE_ENCODING_UNSUPPORTED',
        `响应压缩算法 ${contentEncoding} 不在支持列表（gzip / deflate / br）。`,
        { contentEncoding },
      )
      finish(error)
      response.destroy(error)
      return
    }
  }

  let rawBytes = 0
  let decodedBytes = 0
  const chunks = []
  const exceed = () => {
    const error = new HttpConnectorError(
      'HTTP_RESPONSE_TOO_LARGE',
      `响应超过上限 ${limit} 字节（读取时按字节中止）。`,
      { limit, rawBytes, decodedBytes },
    )
    finish(error)
    if (decoder !== null) decoder.destroy(error)
    response.destroy(error)
  }

  const onData = chunk => {
    if (isSettled()) return
    rawBytes += chunk.length
    // 原始字节和（解压后的）实际字节都受限：压缩炸弹在解压侧被截断。
    if (rawBytes > limit) {
      exceed()
      return
    }
    if (decoder === null) {
      decodedBytes += chunk.length
      if (decodedBytes > limit) {
        exceed()
        return
      }
      chunks.push(chunk)
    }
  }

  response.on('data', onData)
  response.on('error', error => {
    if (isSettled()) return
    if (error instanceof HttpConnectorError) {
      finish(error)
      return
    }
    if (isAbortError(ctx, error)) {
      finish(new HttpConnectorError('HTTP_CANCELED', 'HTTP 调用被取消。'))
      return
    }
    finish(new HttpConnectorError('HTTP_RESPONSE_READ_FAILED', `读取响应失败（${describeCode(error)}）。`, { networkCode: describeCode(error) }))
  })
  response.on('aborted', () => {
    if (isSettled()) return
    if (isAbortError(ctx)) {
      finish(new HttpConnectorError('HTTP_CANCELED', 'HTTP 调用被取消。'))
      return
    }
    const timedOut = Date.now() >= context.deadline
    finish(new HttpConnectorError(
      timedOut ? 'HTTP_TIMEOUT' : 'HTTP_RESPONSE_ABORTED',
      timedOut ? '响应读取超过整体时限。' : '响应在读取完成前被远端中断。',
    ))
  })

  const done = () => {
    if (isSettled()) return
    if (declaredLength !== null && noBody === false && rawBytes !== declaredLength) {
      finish(new HttpConnectorError(
        'HTTP_CONTENT_LENGTH_MISMATCH',
        `响应声明的 content-length=${declaredLength} 与实际读取 ${rawBytes} 字节不一致，已中止。`,
        { declaredLength, rawBytes },
      ))
      return
    }
    finish(null, {
      status,
      headers,
      body: parseResponseBody(Buffer.concat(chunks), rawHeaders['content-type']),
      rawBytes,
      decodedBytes: noBody ? rawBytes : decodedBytes,
    })
  }

  if (noBody) {
    response.resume()
    response.on('end', done)
    return
  }
  if (decoder === null) {
    response.on('end', done)
    return
  }

  decoder.on('data', chunk => {
    if (isSettled()) return
    decodedBytes += chunk.length
    if (decodedBytes > limit) {
      exceed()
      return
    }
    chunks.push(chunk)
  })
  decoder.on('error', error => {
    if (isSettled()) return
    if (error instanceof HttpConnectorError) {
      finish(error)
      return
    }
    finish(new HttpConnectorError('HTTP_RESPONSE_DECODE_FAILED', `响应解压失败（${describeCode(error)}）。`, { networkCode: describeCode(error) }))
  })
  decoder.on('end', done)
  response.pipe(decoder)
}

function parseResponseBody(buffer, contentType) {
  if (buffer.length === 0) return null
  const text = buffer.toString('utf8')
  const type = typeof contentType === 'string' ? contentType.toLowerCase() : ''
  if (type.includes('json') || type.includes('+json')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

/** 发 `http/attempt` / `http/result` 短事件；字段固定、无密钥。 */
function emitHttpEvent(ctx, elementId, executionId, event) {
  if (typeof ctx?.emit !== 'function') return
  const payload = {
    type: event.type,
    at: new Date().toISOString(),
    elementId: elementId ?? undefined,
    activityId: executionId ?? undefined,
    invocationId: event.invocationId,
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    ...(event.method !== undefined ? { method: event.method } : {}),
    ...(event.origin !== undefined ? { origin: event.origin } : {}),
    ...(event.path !== undefined ? { path: event.path } : {}),
    ...(event.status !== undefined ? { status: event.status } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.idempotencyKey !== undefined ? { idempotencyKey: event.idempotencyKey } : {}),
    ...(event.reused !== undefined ? { reused: event.reused } : {}),
    ...(event.effectiveRetries !== undefined ? { effectiveRetries: event.effectiveRetries } : {}),
  }
  try {
    ctx.emit(payload)
  } catch {
    // 观测面失败不能影响请求本身。
  }
}

function acceptStatus(status, acceptStatuses) {
  if (status >= 200 && status <= 299) return true
  return acceptStatuses.includes(status)
}

/**
 * 执行一次 HTTP serviceTask。
 *
 * @param {object} element 解析后的 BPMN 元素（`node.http` + `ioMapping`）
 * @param {{signal?: AbortSignal, variables?: object, instanceId?: string, executionId?: string, attempt?: number, emit?: Function}} ctx
 * @param {{
 *   policy?: object,
 *   store?: ReturnType<typeof createConnectorStore>,
 *   storeRoot?: string,
 *   policies?: Record<string, object>,
 *   env?: object,
 *   authResolver?: Function,
 *   resolve?: Function,
 * }} [options]
 * @returns {Promise<{output: object, status: number, headers: object, events: object[]}>}
 */
export async function executeHttpConnector(element, ctx = {}, options = {}) {
  ensureNotAborted(ctx)
  const http = isPlainObject(element?.node?.http) ? element.node.http : null
  if (http === null) {
    throw new HttpConnectorError(
      'HTTP_CONFIG_MISSING',
      'http 节点没有 fs:http 配置；至少需要 method 与 url。',
      { elementId: element?.id ?? null },
    )
  }
  const elementId = typeof element.id === 'string' && element.id !== '' ? element.id : 'http'
  const instanceId = typeof ctx.instanceId === 'string' && ctx.instanceId !== '' ? ctx.instanceId : 'local'
  const executionId = typeof ctx.executionId === 'string' && ctx.executionId !== ''
    ? ctx.executionId
    : `${elementId}_execution_1`
  const variables = isPlainObject(ctx.variables) ? ctx.variables : {}

  // networkPolicyId：节点显式引用宿主策略集里的一条（不存在时回落到全局默认）。
  const policyId = typeof http.networkPolicyId === 'string' ? http.networkPolicyId.trim() : ''
  const selectedPolicy = policyId !== '' && isPlainObject(options.policies) && isPlainObject(options.policies[policyId])
    ? { ...(isPlainObject(options.policy) ? options.policy : {}), ...options.policies[policyId] }
    : (options.policy ?? {})
  const policy = normalizeHttpPolicy(selectedPolicy)
  let store = options.store
  if (!store) {
    try {
      store = createConnectorStore({ root: options.storeRoot })
    } catch (error) {
      throw toHttpConnectorError(error)
    }
  }

  const io = normalizeIoMapping(element, http)

  const method = typeof http.method === 'string' && http.method.trim() !== ''
    ? http.method.trim().toUpperCase()
    : 'GET'
  if (!HTTP_METHODS.includes(method)) {
    throw new HttpConnectorError(
      'HTTP_METHOD_UNSUPPORTED',
      `不支持的 HTTP 方法 ${JSON.stringify(method)}（允许：${HTTP_METHODS.join(' / ')}）。`,
    )
  }
  if (typeof http.url !== 'string' || http.url.trim() === '') {
    throw new HttpConnectorError('HTTP_URL_INVALID', 'http 节点缺少 url。')
  }

  let url
  try {
    url = new URL(http.url.trim())
  } catch {
    throw new HttpConnectorError('HTTP_URL_INVALID', 'http 节点的 url 不是合法 URL。')
  }

  const input = applyInputMappings(io.input, variables)
  for (const [name, value] of Object.entries(input.query)) url.searchParams.set(name, String(value))

  const headers = parseRequestHeaders(http.headers)
  Object.assign(headers, input.headers)

  // 凭据：只从宿主解析，错误信息不包含值。
  if (typeof http.authRef === 'string' && http.authRef.trim() !== '') {
    let authHeaders
    try {
      authHeaders = await resolveAuthRef(http.authRef.trim(), {
        env: options.env ?? policy.env ?? process.env,
        resolve: options.authResolver ?? policy.authResolver,
      })
    } catch (error) {
      throw toHttpConnectorError(error)
    }
    Object.assign(headers, authHeaders)
  }

  const idempotency = normalizeIdempotency(http)
  const identityDigest = sha256(`${instanceId}\0${elementId}\0${executionId}`)
  const invocationId = `inv-${identityDigest.slice(0, 16)}`
  let idempotencyKey = null
  if (idempotency !== null) {
    // 同一次 execution 的所有重试共享该键；循环再次激活会得到新的 executionId → 新键。
    idempotencyKey = `fs-${sha256(`${instanceId}\0${elementId}\0${executionId}\0${method}\0${url.href}`).slice(0, 40)}`
    headers[idempotency.header.toLowerCase()] = idempotencyKey
  }

  // body：输入映射优先；没有映射时使用静态 fs:http 正文。
  let bodyText = ''
  if (input.body.present) {
    const serialized = serializeMappedBody(input.body.value)
    bodyText = serialized.text
    if (bodyText !== '' && headers['content-type'] === undefined) {
      headers['content-type'] = serialized.isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'
    }
  } else if (typeof http.body === 'string' && http.body !== '') {
    bodyText = http.body
  }
  if ((method === 'GET' || method === 'HEAD') && bodyText !== '') {
    throw new HttpConnectorError('HTTP_BODY_NOT_ALLOWED', `${method} 请求不允许携带请求体。`)
  }
  const bodyBytes = Buffer.byteLength(bodyText, 'utf8')
  if (bodyBytes > policy.maxRequestBytes) {
    throw new HttpConnectorError(
      'HTTP_REQUEST_TOO_LARGE',
      `请求体 ${bodyBytes} 字节超过上限 ${policy.maxRequestBytes} 字节。`,
      { bytes: bodyBytes, limit: policy.maxRequestBytes },
    )
  }
  if (bodyText !== '') {
    headers['content-length'] = String(bodyBytes)
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/json; charset=utf-8'
  }
  if (headers.accept === undefined) headers.accept = 'application/json, text/plain, */*'
  headers['user-agent'] = headers['user-agent'] ?? 'dsh-flow-studio-http-connector/0.13.6'

  // 目标校验放在 body/headers 定稿后、发送前；校验结果里的 lookup 直接用于连接。
  let validated
  try {
    validated = await validateDestination(url.href, policy)
  } catch (error) {
    throw toHttpConnectorError(error)
  }

  const acceptStatuses = normalizeAcceptStatuses(http.acceptStatuses)
  const configuredRetries = Number.isSafeInteger(http.retries) && http.retries > 0
    ? Math.min(http.retries, policy.maxRetries)
    : 0
  const retriableMethod = method === 'GET' || method === 'HEAD'
  const sideEffectRetryAllowed = idempotencyKey !== null
  const effectiveRetries = retriableMethod || sideEffectRetryAllowed ? configuredRetries : 0
  const maxAttempts = 1 + effectiveRetries
  const timeoutMs = Number.isSafeInteger(http.timeoutMs) && http.timeoutMs > 0
    ? Math.min(http.timeoutMs, policy.maxTimeoutMs)
    : policy.defaultTimeoutMs
  const deadline = Date.now() + timeoutMs
  const configuredLimit = Number.isSafeInteger(http.maxResponseBytes) && http.maxResponseBytes > 0
    ? http.maxResponseBytes
    : policy.defaultResponseBytes
  const limitBytes = Math.min(configuredLimit, policy.hardResponseBytes)

  const requestHash = sha256(JSON.stringify({
    v: 1,
    method,
    url: url.href,
    headers: Object.fromEntries(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))),
    bodyHash: sha256(bodyText),
  }))

  const identity = { instanceId, elementId, executionId }
  let begun
  try {
    begun = await store.beginInvocation({
      ...identity,
      requestHash,
      idempotencyKey,
      invocationId,
    })
  } catch (error) {
    throw toHttpConnectorError(error)
  }

  if (begun.status === 'reuse') {
    const result = begun.result
    emitHttpEvent(ctx, elementId, executionId, {
      type: 'http/result',
      invocationId,
      status: result.status,
      reused: true,
      idempotencyKey: idempotencyKey ?? undefined,
    })
    return {
      output: isPlainObject(result.output) ? result.output : {},
      status: typeof result.status === 'number' ? result.status : 0,
      headers: isPlainObject(result.headers) ? result.headers : {},
      events: [],
    }
  }
  if (begun.status === 'unknown') {
    throw new HttpConnectorError(
      'HTTP_OUTCOME_UNKNOWN',
      '上次 HTTP 调用已发送但结果未落盘；为避免重复副作用，重启后不自动重发，请人工核对远端状态。',
      { invocationId, idempotencyKey },
    )
  }

  let lastError = null
  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
    ensureNotAborted(ctx)
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      lastError = new HttpConnectorError('HTTP_TIMEOUT', `HTTP 调用超过整体时限 ${timeoutMs}ms（重试也已用尽）。`, {
        timeoutMs,
      })
      break
    }
    try {
      await store.recordAttempt(identity, { attempt: attemptNo, at: new Date().toISOString() })
    } catch (error) {
      throw toHttpConnectorError(error)
    }
    emitHttpEvent(ctx, elementId, executionId, {
      type: 'http/attempt',
      invocationId,
      attempt: attemptNo,
      method,
      origin: validated.origin,
      path: url.pathname,
      idempotencyKey: idempotencyKey ?? undefined,
      effectiveRetries,
    })

    const startedAt = Date.now()
    let response
    try {
      response = await performRequest({
        method,
        url,
        headers,
        bodyText,
        validated,
        deadline,
        ctx,
        limitBytes,
      })
    } catch (error) {
      if (isAbortError(ctx, error)) {
        // 已发送但结果不明：记录为 unknown，重启后不自动重发。
        await store.markOutcomeUnknown(identity, 'HTTP 调用在等待结果时被取消。').catch(() => {})
        throw new HttpConnectorError('HTTP_CANCELED', 'HTTP 调用已取消，迟到响应不得推动流程。', { invocationId })
      }
      const failure = toHttpConnectorError(error)
      lastError = failure
      const transient = failure.details?.transient === true || failure.code === 'HTTP_TIMEOUT'
      if (attemptNo < maxAttempts && transient) {
        const wait = backoffMs(policy, attemptNo, null)
        if (Date.now() + wait < deadline) {
          try {
            await sleepUntil(wait, ctx)
          } catch (errorCancel) {
            await store.markOutcomeUnknown(identity, 'HTTP 调用在重试退避期间被取消。').catch(() => {})
            throw errorCancel
          }
          continue
        }
      }
      await store.commitResult(identity, {
        state: 'failed',
        error: { code: failure.code, message: failure.message },
      }).catch(() => {})
      throw failure
    }

    // 校验之后再次检查取消：响应已经到达，但流程可能已经被 stop/suspend。
    ensureNotAborted(ctx)

    if (response.redirect === true) {
      const error = new HttpConnectorError(
        'HTTP_REDIRECT_FORBIDDEN',
        `目标返回 ${response.status} 重定向；首版不允许跟随（避免每一跳重新校验与跨 origin 转发凭据）。`,
        { status: response.status, location: response.headers.location ?? null },
      )
      await store.commitResult(identity, { state: 'failed', error: { code: error.code, message: error.message } }).catch(() => {})
      throw error
    }

    if (!acceptStatus(response.status, acceptStatuses)) {
      const retryable = TRANSIENT_STATUS.has(response.status)
      if (attemptNo < maxAttempts && retryable) {
        const wait = backoffMs(policy, attemptNo, retryAfterMs(response.headers))
        if (Date.now() + wait < deadline) {
          emitHttpEvent(ctx, elementId, executionId, {
            type: 'http/result',
            invocationId,
            attempt: attemptNo,
            status: response.status,
            durationMs: Date.now() - startedAt,
            idempotencyKey: idempotencyKey ?? undefined,
            effectiveRetries,
          })
          try {
            await sleepUntil(wait, ctx)
          } catch (errorCancel) {
            await store.markOutcomeUnknown(identity, 'HTTP 调用在重试退避期间被取消。').catch(() => {})
            throw errorCancel
          }
          continue
        }
      }
      const error = new HttpConnectorError(
        'HTTP_STATUS_NOT_ACCEPTABLE',
        `远端返回 ${response.status}，不在可接受状态内（默认只接受 2xx）。`,
        { status: response.status, acceptStatuses },
      )
      await store.commitResult(identity, { state: 'failed', error: { code: error.code, message: error.message } }).catch(() => {})
      throw error
    }

    let output
    try {
      output = applyOutputMappings(io.output, response, variables, elementId)
    } catch (error) {
      const failure = toHttpConnectorError(error)
      await store.commitResult(identity, {
        state: 'failed',
        error: { code: failure.code, message: failure.message },
      }).catch(() => {})
      throw failure
    }

    const result = {
      status: response.status,
      headers: response.headers,
      output,
      completedAt: new Date().toISOString(),
    }
    try {
      await store.commitResult(identity, { state: 'succeeded', result })
    } catch (error) {
      throw toHttpConnectorError(error)
    }
    emitHttpEvent(ctx, elementId, executionId, {
      type: 'http/result',
      invocationId,
      attempt: attemptNo,
      status: response.status,
      durationMs: Date.now() - startedAt,
      idempotencyKey: idempotencyKey ?? undefined,
      effectiveRetries,
    })
    return {
      output,
      status: response.status,
      headers: response.headers,
      events: [],
    }
  }

  const failure = lastError ?? new HttpConnectorError('HTTP_TIMEOUT', 'HTTP 调用在整体时限内没有完成。', { timeoutMs })
  await store.commitResult(identity, {
    state: 'failed',
    error: { code: failure.code, message: failure.message },
  }).catch(() => {})
  throw failure
}

/** 供 runtime / 测试核对：只暴露白名单响应头与脱敏后的配置。 */
export function describeHttpNode(element) {
  const http = isPlainObject(element?.node?.http) ? element.node.http : {}
  return {
    id: typeof element?.id === 'string' ? element.id : null,
    kind: 'http',
    method: typeof http.method === 'string' ? http.method : 'GET',
    url: typeof http.url === 'string' ? redactHttpUrl(http.url) : null,
    config: redactHttpConfig(http),
  }
}

function redactHttpUrl(url) {
  try {
    const parsed = new URL(url)
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSecretHeaderName(key)) parsed.searchParams.set(key, '[redacted]')
    }
    return parsed.toString()
  } catch {
    return null
  }
}
