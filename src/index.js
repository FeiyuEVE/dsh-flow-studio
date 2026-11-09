/**
 * Host 半边：流程模板 + 运行日志的读写接口。
 *
 * 浏览器端（client bundle）通过同源 fetch 调用 `/api/flow-studio/*`；
 * 面板本身不做任何持久化，所有流程与运行日志都落在 $DSH_HOME 下。
 *
 * 路由是 `prefix` 注册的一条：webserver 对插件路由不做自动鉴权
 * （内置 `/api` 的 connection.admit 只挂在通用 `/api` 前缀上，最长前缀会把请求先接走），
 * 所以这里自己挡跨站请求：带了 Origin 且与 Host 不一致就 403。
 *
 * routes：
 *   GET/POST        /api/flow-studio/flows, /flows/<id> …
 *   GET/POST        /api/flow-studio/runs
 *   GET/DELETE      /api/flow-studio/runs/<runId>
 *   POST            /api/flow-studio/runs/<runId>/start|stop
 *   GET/POST        /api/flow-studio/runs/<runId>/events
 *   GET/POST        /api/flow-studio/runs/<runId>/messages
 *   POST            /api/flow-studio/runs/<runId>/inbox
 *   GET             /api/flow-studio/runs/<runId>/summary
 *   GET             /api/flow-studio/runs/<runId>/export
 *
 * @module @feiyueve/dsh-flow-studio
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { deliverInboundMessage, validateReplyTarget } from './inbox.js'
import { normalizeExecutor } from './executor.js'
import { NODE_KIND, normalizeFlow, normalizeNodeCheck, validateFlow, validateNodeCheck } from './model.js'
import { compileFlowFiles, readFlowDir, writeFlowDir } from './flowdir.js'
import { checkRunId, isSafeRelPath, renderRunMarkdown, summarize } from './runlog.js'
import { createRuntime, patchRunJson, readStartOptions, saveSupervision } from './runtime.js'
import * as worktreeModule from './worktree.js'
import {
  CUSTOM_EXECUTOR_ENV, DEFAULT_NODE_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS, MAX_TIMEOUT_MS,
  NODE_TIMEOUT_ENV, RUN_TIMEOUT_ENV, WORKSPACE_ROOTS_ENV,
  createFlowTools, customExecutorBlockers, customExecutorAllowed, listExistingRunIds,
  parseWorkspaceRoots, workspaceAllowlistReason, worktreeRecordOf, worktreesRootFor,
} from './tools.js'
import {
  RunError, appendEvents, createRun, deleteRun, listRuns, readAllEvents, readEvents,
  buildHostExecutionVerifier, readHostExecutions, readLease, readRunDetail, readRunMessages, readRunMeta,
  normalizeCoverageBuckets,
  repairRunStates, runsDir,
  sweepExpiredLeases, writeRunInbox, writeRunMeta,
} from './runstore.js'
import { workspaceIdFor } from './worktree.js'
import {
  FlowConflictError, checkId, deleteFlow, flowsDir, listFlows, newFlowId, readFlow, saveFlow,
} from './store.js'

/** 硬依赖：没有 webServer 就没有面板的数据通道。 */
export const inject = ['webServer']

export const name = 'flow-studio'

/** 可选加固（§8.5）：设置该环境变量后所有 /api/flow-studio/* 都要求 token。 */
export const AUTH_ENV = 'FLOW_STUDIO_TOKEN'

/**
 * G6-a ①：只读令牌（可选）。它只允许 GET；任何写请求（POST / PUT / DELETE…）→ 403。
 * 全权令牌仍是 {@link AUTH_ENV}。两个都配置时按「先匹配全权、再匹配只读」判定。
 */
export const READ_AUTH_ENV = 'FLOW_STUDIO_READ_TOKEN'

/** G6-a ②③ / G6-c：从 tools.js 与 HTTP 层共用的主机级开关（再导出，便于测试与运维引用）。 */
export { CUSTOM_EXECUTOR_ENV, WORKSPACE_ROOTS_ENV, RUN_TIMEOUT_ENV, NODE_TIMEOUT_ENV }

/** 插件版本，用于 GET /health（§8.5）。 */
export const PLUGIN_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 单个请求体的硬上限：2 MiB（达到即 413；200 条 8KB 事件仍装得下）。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** 面板路由前缀。 */
const BASE = '/api/flow-studio'

/** 06 §13.7：`/summary` 按 lastSeq 的增量缓存（runId → 上次聚合结果）。 */
const summaryCache = new Map()

function sendJson(res, status, payload, extraHeaders = null) {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}),
  })
  res.end(body)
}

/**
 * 读请求体（带大小上限）。
 *
 * §8.6：超限时**不** `req.destroy()`（那会让客户端看到 ECONNRESET），而是停止缓存、
 * 继续消费剩余数据，等请求结束后回一个可读的 413。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let overflow = false
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', chunk => {
      if (overflow) return
      size += chunk.length
      if (size >= MAX_BODY_BYTES) {
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) {
        const error = new Error(`请求体过大（上限 ${MAX_BODY_BYTES} 字节）`)
        error.status = 413
        settle(reject, error)
        return
      }
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return settle(resolve, undefined)
      try {
        settle(resolve, JSON.parse(text))
      } catch {
        const error = new Error('请求体不是合法 JSON')
        error.status = 400
        settle(reject, error)
      }
    })
    req.on('error', error => settle(reject, error))
  })
}

/** 跨站请求一律拒绝：只接受同源页面发来的调用。 */
function isSameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** 06 §13.1：FLOW_STUDIO_TOKEN 至少 16 字符，否则启动即拒绝。 */
export const TOKEN_MIN_LENGTH = 16

/** §13.1：读一个 token 环境变量 → {present, valid, token}；空串 = 未配置。 */
function inspectTokenEnv(envName, env = process.env) {
  const raw = env ? env[envName] : undefined
  if (typeof raw !== 'string') return { present: false, valid: false, token: '' }
  const token = raw.trim()
  if (token === '') return { present: false, valid: false, token: '' }
  return { present: true, valid: token.length >= TOKEN_MIN_LENGTH, token }
}

/** 兼容口径：全权令牌（FLOW_STUDIO_TOKEN）的检查结果。 */
function inspectToken(env = process.env) {
  return inspectTokenEnv(AUTH_ENV, env)
}

/** 只读令牌（FLOW_STUDIO_READ_TOKEN）的检查结果。 */
function inspectReadToken(env = process.env) {
  return inspectTokenEnv(READ_AUTH_ENV, env)
}

/** 两档令牌的合并视图：任一配置就算启用鉴权；过短的记进 misconfigured（启动即拒绝）。 */
function inspectAuth(env = process.env) {
  const full = inspectToken(env)
  const read = inspectReadToken(env)
  const misconfigured = []
  if (full.present && !full.valid) misconfigured.push({ env: AUTH_ENV, length: full.token.length })
  if (read.present && !read.valid) misconfigured.push({ env: READ_AUTH_ENV, length: read.token.length })
  return { present: full.present || read.present, full, read, misconfigured }
}

/** 兼容导出：返回当前生效的全权 token；未配置或配置过短（fail-closed）返回 null。 */
export function configuredToken() {
  const inspected = inspectToken()
  return inspected.valid ? inspected.token : null
}

function requestToken(req, url, { allowQueryToken = false } = {}) {
  const header = req.headers.authorization
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match) return match[1].trim()
  }
  // 06 §13.1：`?token=` 只保留给 export（浏览器 <a download> 带不了请求头）。
  if (!allowQueryToken) return null
  const fromQuery = url.searchParams.get('token')
  return typeof fromQuery === 'string' && fromQuery !== '' ? fromQuery : null
}

function tokenMatches(expected, provided) {
  if (typeof provided !== 'string' || provided === '') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 返回鉴权结论（G6-a ①）。
 *   - `{ ok:true, mode:'connection', readOnly:false }`：没配置任何 token（沿用宿主鉴权）；
 *   - `{ ok:true, mode:'full' }`：全权令牌（FLOW_STUDIO_TOKEN）；
 *   - `{ ok:true, mode:'read', readOnly:true }`：只读令牌（FLOW_STUDIO_READ_TOKEN），只允许 GET；
 *   - `{ ok:false }`：缺 / 错令牌，或配置了过短令牌（fail-closed）。
 * token 档位只认 Authorization: Bearer（export 另允许 ?token=）。
 */
function authorizeRequest(req, url, options = {}) {
  const inspected = inspectAuth()
  if (!inspected.present) return { ok: true, mode: 'connection', readOnly: false }
  // 配置了但不足 16 字符：不悄悄退回同源，直接拒绝（启动时也会拒绝注册）。
  if (inspected.misconfigured.length > 0) return { ok: false, mode: 'none', readOnly: false }
  const provided = requestToken(req, url, options)
  // 先匹配全权：两档令牌配成同一个值时，全权优先（启动时会告警）。
  if (inspected.full.valid && tokenMatches(inspected.full.token, provided)) {
    return { ok: true, mode: 'full', readOnly: false }
  }
  if (inspected.read.valid && tokenMatches(inspected.read.token, provided)) {
    return { ok: true, mode: 'read', readOnly: true }
  }
  return { ok: false, mode: 'none', readOnly: false }
}

/**
 * 06 §13.1：handler 最前面接回宿主鉴权。
 * 拿到数字（401/403）原样返回；拿不到 connection 服务或它抛错 → fail-closed 503。
 * @returns {number | null} null 表示放行
 */
function connectionRejection(env, req) {
  let connection
  try {
    connection = env && env.ctx && typeof env.ctx.get === 'function' ? env.ctx.get('connection') : undefined
    if (!connection && env && env.ctx) connection = env.ctx.connection
  } catch {
    return 503
  }
  if (!connection || typeof connection.requestRejection !== 'function') return 503
  try {
    const rejection = connection.requestRejection(req)
    if (rejection === undefined || rejection === null) return null
    if (Number.isInteger(rejection)) return rejection
    return 503
  } catch {
    return 503
  }
}

/** 回环请求判定（127.0.0.1 / ::1 / IPv4-mapped）。 */
function isLoopbackRequest(req) {
  const raw = req && req.socket && typeof req.socket.remoteAddress === 'string'
    ? req.socket.remoteAddress
    : ''
  return raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1'
}

/**
 * 可选兼容：`If-Match: "<version>"`（也接受裸数字、`W/"3"`）。
 * 没有该头返回 undefined；格式不合法返回 NaN，由调用方回 400。
 * 主路径仍是 body.version，If-Match 只在 body 没带版本时补位。
 * @param {string | undefined} header
 * @returns {number | undefined}
 */
function parseIfMatch(header) {
  if (typeof header !== 'string' || header.trim() === '') return undefined
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(header.trim())
  if (!match) return Number.NaN
  const version = Number(match[1])
  return Number.isSafeInteger(version) && version >= 1 ? version : Number.NaN
}

/**
 * 06 §13.8：`FLOW_STUDIO_STUB_ENGINE=1` 必须同时 `FLOW_STUDIO_TESTBED=1` 才生效；
 * 否则忽略并告警（引擎构造函数仍会被显式 stub 参数覆盖，不让它自己去猜 env）。
 */
export function resolveStubMode(env = process.env) {
  const requested = env.FLOW_STUDIO_STUB_ENGINE === '1'
  const testbed = env.FLOW_STUDIO_TESTBED === '1'
  return { requested, testbed, stub: requested && testbed }
}

/**
 * 证据文件校验（06 §13.7）：模型自述的 evidenceRef / reportRef 必须
 *   - 在 run 目录内（相对路径、无 ..）；
 *   - 文件真实存在；
 *   - 内容 sha256 与对应 artifact/write 事件记录的 sha256 一致。
 * @param {string} runDir
 * @returns {(ref: string, expectedSha: string) => boolean}
 */
function makeEvidenceVerifier(runDir) {
  return (ref, expectedSha) => {
    if (typeof ref !== 'string' || !isSafeRelPath(ref)) return false
    const abs = join(runDir, ref)
    try {
      const info = statSync(abs)
      if (!info.isFile()) return false
      if (typeof expectedSha !== 'string' || expectedSha === '') return false
      const digest = createHash('sha256').update(readFileSync(abs)).digest('hex')
      return digest === expectedSha.toLowerCase()
    } catch {
      return false
    }
  }
}

/**
 * 0.11 R5（F4）：宿主检查的权威验证器。只有 runstore 私有 verification 登记过的
 * executionId + 同节点/attempt + 报告 hash 对得上，才承认 producer='host'。
 * 普通 artifact/write、外部 HTTP 或手写 extra.producer 都过不了这一关。
 */
function hostVerificationOf(event) {
  const extra = event && event.extra && typeof event.extra === 'object' ? event.extra : {}
  const nested = extra.verification && typeof extra.verification === 'object' ? extra.verification : {}
  return {
    executionId: typeof extra.verificationId === 'string' ? extra.verificationId
      : (typeof nested.executionId === 'string' ? nested.executionId : ''),
    kind: typeof extra.verificationKind === 'string' ? extra.verificationKind
      : (typeof nested.kind === 'string' ? nested.kind : ''),
    reportSha256: typeof extra.reportSha256 === 'string' ? extra.reportSha256
      : (typeof nested.reportSha256 === 'string' ? nested.reportSha256 : ''),
  }
}

function makeHostExecutionVerifier(runId, records, events = [], runDir = '') {
  // 与 runtime 自审共用 runstore 的同一实现（报告副本 sha256 必核）。
  return buildHostExecutionVerifier(records, events, runId, runDir)
}

/**
 * 0.11 R5（返工）：宿主证据指纹。记录或任一报告副本的字节变化都会改变指纹，
 * summary 缓存据此失效，避免删除 / 损坏报告后仍复用旧的权威结论。
 */
function hostEvidenceDigest(runId, records, events = [], runDir = '') {
  const hash = createHash('sha256')
  hash.update(String(runId))
  const sorted = [...(records || [])].sort((a, b) => String(a.executionId).localeCompare(String(b.executionId)))
  for (const record of sorted) {
    hash.update(JSON.stringify(record))
    if (typeof record.reportSha256 === 'string' && record.reportSha256 !== '') {
      const copy = (events || []).find(event => event && event.kind === 'artifact/write'
        && hostVerificationOf(event).executionId === record.executionId
        && hostVerificationOf(event).kind === 'report-copy')
      if (!copy) {
        hash.update('report-missing')
        continue
      }
      try {
        hash.update(createHash('sha256').update(readFileSync(join(runDir, copy.data.path))).digest('hex'))
      } catch {
        hash.update('report-unreadable')
      }
    }
  }
  return hash.digest('hex')
}

function newTraceId() {
  return `tr-${randomUUID()}`
}

/**
 * §8.5：500 只回通用文案 + traceId，详细错误写进程日志，绝不把内部绝对路径回给客户端。
 */
function sendInternalError(res, env, error) {
  const traceId = newTraceId()
  const detail = error && error.stack ? error.stack : (error && error.message ? error.message : String(error))
  try {
    if (env && env.ctx && env.ctx.logger && typeof env.ctx.logger.warn === 'function') {
      env.ctx.logger.warn(`flow-studio: [${traceId}] ${detail}`)
    }
  } catch {
    // 日志本身失败不该掩盖 500 响应。
  }
  sendJson(res, 500, { ok: false, error: '内部错误', traceId })
}

function parseLimit(raw, fallback, max) {
  if (raw === null || raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(String(raw))) throw new RunError(400, 'limit', '必须是正整数')
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new RunError(400, 'limit', '必须是正整数')
  return Math.min(value, max)
}

function parseAttemptId(raw) {
  if (raw === null || raw === undefined || raw === '') return undefined
  if (!/^\d+$/.test(String(raw))) throw new RunError(400, 'attemptId', '必须是从 1 开始的正整数')
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new RunError(400, 'attemptId', '必须是从 1 开始的正整数')
  return value
}

function parseKinds(url) {
  const kinds = []
  for (const raw of url.searchParams.getAll('kind')) {
    for (const piece of raw.split(',')) {
      const kind = piece.trim()
      if (kind !== '') kinds.push(kind)
    }
  }
  return kinds
}

/** 07 §4.1：worktree 策略全集（与 `worktree.js` 的 WORKTREE_POLICIES 同口径）。 */
const WORKTREE_POLICIES = Object.freeze(['auto', 'on', 'off'])

/**
 * 建 run 时记下的发起参数，在**同进程内**从 `POST /runs` 传到 `POST /runs/<id>/start`。
 *
 * 持久化已是可靠的：`startOptions` 已进 runstore 白名单（只允许 `workspace` / `worktree`
 * 两个键），`patchRunJson` → `writeRunMeta` 会校验并落进 `run.json.startOptions`，后续任何
 * runstore 写入（开 supervision、投消息、startRun 迁移……）都不会再把它丢掉，进程重启后
 * 也能读回。这张内存表只是同进程内的快速通道（start 时少一次读盘），不是唯一存储。
 * 只在内存里留最近 MAX_PENDING_START_OPTIONS 条，读走即删，不无界增长。
 */
const MAX_PENDING_START_OPTIONS = 200

/** 把发起参数记进内存表（超上限丢最旧的）。 */
function rememberStartOptions(store, runId, options) {
  if (!(store instanceof Map) || typeof runId !== 'string' || runId === '') return
  if (Object.keys(options || {}).length === 0) return
  while (store.size >= MAX_PENDING_START_OPTIONS) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
  // 后写覆盖：同一次创建重复记录时以最后一次为准。
  store.delete(runId)
  store.set(runId, { ...options })
}

/**
 * E3-a：统一的 workspace 400 错误。`field` 是既有 RunError 口径，
 * `code` 额外带上同一个标识（调用方按错误码分流时不用猜字段名）。
 */
function workspaceError(reason) {
  return new RunError(400, 'workspace', reason, { code: 'workspace' })
}

/**
 * 07 §4.1：解析 start / 建 run 的 `{workspace, worktree}`。
 * 省略 = 不带该键（worktree 由 engine 按默认 `auto` 裁决）；非法值一律 400。
 * @returns {{ workspace?: string, worktree?: string }}
 */
function parseStartOptions(body) {
  if (body === undefined || body === null) return {}
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new RunError(400, 'body', '请求体必须是 JSON 对象')
  }
  const options = {}
  if (body.workspace !== undefined && body.workspace !== null) {
    if (typeof body.workspace !== 'string' || body.workspace.trim() === '') {
      throw workspaceError('workspace 必须是非空字符串（工作区路径）')
    }
    const workspace = body.workspace.trim()
    if (!isAbsolute(workspace)) throw workspaceError('workspace 必须是绝对路径')
    options.workspace = workspace
  }
  if (body.worktree !== undefined && body.worktree !== null) {
    const worktree = typeof body.worktree === 'string' ? body.worktree.trim() : ''
    if (!WORKTREE_POLICIES.includes(worktree)) {
      throw new RunError(400, 'worktree', 'worktree 只允许 auto / on / off')
    }
    options.worktree = worktree
  }
  return options
}

/**
 * G6-c：`POST /runs/<id>/start` 请求体里的可选时限。
 *
 * 只接受「正整数毫秒」；上限用 JavaScript 定时器上限（2^31-1 ms ≈ 24.8 天），
 * 超过它 setTimeout 会立刻触发，等于把 run 立刻收掉。省略 = 引擎默认
 * （run 2h / 节点 20min）或环境变量 FLOW_STUDIO_RUN_TIMEOUT_MS / FLOW_STUDIO_NODE_TIMEOUT_MS。
 *
 * @param {unknown} body
 * @returns {{ runTimeoutMs?: number, nodeTimeoutMs?: number }}
 */
function parseTimeoutOptions(body) {
  if (body === undefined || body === null) return {}
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new RunError(400, 'body', '请求体必须是 JSON 对象')
  }
  const options = {}
  const fields = [
    ['runTimeoutMs', '整轮 run 的时限'],
    ['nodeTimeoutMs', '单个节点的时限'],
  ]
  for (const [key, label] of fields) {
    const raw = body[key]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
      throw new RunError(
        400,
        key,
        `${label} ${key} 必须是正整数（毫秒）；想用默认值就不要传这个字段`,
        { code: key },
      )
    }
    if (raw > MAX_TIMEOUT_MS) {
      throw new RunError(
        400,
        key,
        `${label} ${key} 不能超过 ${MAX_TIMEOUT_MS}ms（约 24.8 天，JavaScript 定时器上限）`,
        { code: key },
      )
    }
    options[key] = raw
  }
  return options
}

/** 错误对象 → 可读文案（不把堆栈甩给客户端）。 */
function errorMessage(error) {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return '未知错误'
}

// ── G6-b：worktree 生命周期接线（模块逻辑在 worktree.js，这里只接线） ─────

/** worktree 模块 or 注入桩（测试用）。缺导出时路由给可读失败，不假装成功。 */
function worktreeApiOf(env) {
  return env && env.worktree && typeof env.worktree === 'object' ? env.worktree : worktreeModule
}

/** 注入的 git runner（透传给 worktree 模块；生产不注入）。 */
function worktreeRunnerOf(env) {
  return env && typeof env.worktreeRunner === 'function' ? env.worktreeRunner : undefined
}

/**
 * 孤儿 worktree 清单：`DELETE /runs/<id>` 只删 run 目录，但 run.json.worktree.path
 * 是 worktree 的唯一指针——删掉就永久失联。所以删除前把 `{path, branch, workspaceId}`
 * 记进 `<runsRoot>/.worktree-orphans.json`（0600，原子写），供 GET /worktrees 查询。
 */
const ORPHAN_FILE = '.worktree-orphans.json'

/** 按 runsRoot 串行化孤儿清单的读-改-写（进程内，够用；Host 单进程）。 */
const orphanQueues = new Map()

function withOrphanLock(runsRoot, task) {
  const key = resolve(runsRoot)
  const previous = orphanQueues.get(key) || Promise.resolve()
  const result = previous.then(task, task)
  const tail = result.then(() => undefined, () => undefined)
  orphanQueues.set(key, tail)
  return result.finally(() => {
    if (orphanQueues.get(key) === tail) orphanQueues.delete(key)
  })
}

function orphanFilePath(runsRoot) {
  return join(runsRoot, ORPHAN_FILE)
}

function isOrphanRecordShape(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof value.path === 'string' && value.path !== ''
}

async function readOrphanWorktrees(runsRoot) {
  let text
  try {
    text = await readFile(orphanFilePath(runsRoot), 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.orphans) ? parsed.orphans : [])
    return list.filter(isOrphanRecordShape)
  } catch {
    // 坏文件按空清单处理（不因为一条手改坏的 JSON 让 DELETE /runs 失败）。
    return []
  }
}

async function writeOrphanWorktrees(runsRoot, list) {
  await mkdir(runsRoot, { recursive: true, mode: 0o700 })
  const target = orphanFilePath(runsRoot)
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  const body = `${JSON.stringify({ version: 1, orphans: list }, null, 2)}\n`
  await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, target)
}

/** 从 run.json 的 workspace + worktree 记录收敛成孤儿条目（字段至少含 path/branch/workspaceId）。 */
function orphanRecordOf(meta, record) {
  const workspace = meta && meta.workspace && typeof meta.workspace === 'object' ? meta.workspace : null
  let workspaceId = workspace && typeof workspace.id === 'string' && workspace.id !== '' ? workspace.id : null
  if (workspaceId === null && typeof record.path === 'string') {
    // 兜底：worktree 布局是 <root>/<workspaceId>/<runId>，父目录名就是 workspaceId。
    const parent = basename(dirname(record.path))
    if (/^[0-9a-f]{12}$/.test(parent)) workspaceId = parent
  }
  return {
    runId: meta && typeof meta.id === 'string' ? meta.id : null,
    flowId: meta && typeof meta.flowId === 'string' ? meta.flowId : null,
    flowName: meta && typeof meta.flowName === 'string' ? meta.flowName : null,
    path: record.path,
    branch: typeof record.branch === 'string' ? record.branch : null,
    workspaceId,
    workspacePath: workspace && typeof workspace.path === 'string' ? workspace.path : null,
    recordedAt: new Date().toISOString(),
    reason: 'run-deleted',
  }
}

async function recordOrphanWorktree(runsRoot, meta, record) {
  return withOrphanLock(runsRoot, async () => {
    const list = await readOrphanWorktrees(runsRoot)
    const entry = orphanRecordOf(meta, record)
    const next = [entry, ...list.filter(item => !(item.runId === entry.runId && item.path === entry.path))]
    await writeOrphanWorktrees(runsRoot, next)
    return entry
  })
}

async function dropOrphanWorktree(runsRoot, { runId, path }) {
  return withOrphanLock(runsRoot, async () => {
    const list = await readOrphanWorktrees(runsRoot)
    const next = list.filter(item => !(item.runId === runId && (path === undefined || item.path === path)))
    if (next.length === list.length) return false
    await writeOrphanWorktrees(runsRoot, next)
    return true
  })
}

/** prune 之后同步清单：已删除 / 目录不存在的条目移出（保留仍需要的指针）。 */
async function syncOrphanWorktrees(runsRoot, removedPaths) {
  return withOrphanLock(runsRoot, async () => {
    const list = await readOrphanWorktrees(runsRoot)
    const next = list.filter(item => !(removedPaths.has(item.path) || !existsSync(item.path)))
    if (next.length !== list.length) await writeOrphanWorktrees(runsRoot, next)
    return next
  })
}

/**
 * G6-b ①：run 详情的 worktreeStatus（exists / dirty / head，来自 inspectWorktree）。
 * 拿不到（没有记录 / 没 workspace / 模块缺导出 / git 探针失败）一律 `{unknown:true, reason}`，
 * 绝不假装「目录不存在」。
 */
async function worktreeStatusOf(env, meta) {
  const record = worktreeRecordOf(meta)
  if (!record) return { unknown: true, enabled: false, reason: 'no-worktree-record' }
  const api = worktreeApiOf(env)
  if (typeof api.inspectWorktree !== 'function') {
    return { unknown: true, enabled: true, reason: 'worktree 模块没有 inspectWorktree 导出' }
  }
  const workspace = meta && meta.workspace && typeof meta.workspace === 'object' ? meta.workspace : null
  if (!workspace) return { unknown: true, enabled: true, reason: 'run.json 没有 workspace 记录' }
  try {
    const inspected = await api.inspectWorktree({ workspace, record, run: worktreeRunnerOf(env) })
    if (!inspected || typeof inspected !== 'object' || Array.isArray(inspected)) {
      return { unknown: true, enabled: true, reason: 'inspectWorktree 返回了非法结果' }
    }
    return {
      enabled: true,
      exists: inspected.exists === true,
      dirty: inspected.dirty === true ? true : (inspected.dirty === false ? false : null),
      head: typeof inspected.head === 'string' && inspected.head !== '' ? inspected.head : null,
      ...(typeof inspected.error === 'string' && inspected.error !== '' ? { reason: inspected.error } : {}),
    }
  } catch (error) {
    return { unknown: true, enabled: true, reason: errorMessage(error) }
  }
}

/**
 * E3-a：run 是否跑在测试桩上。桩引擎不需要真实工作区（也不该被工作目录拖死），
 * 这是「启动必须给 workspace」唯一豁免。入口只有两处判据：引擎自己声明 stub，
 * 或 run.json 已经记下 `sessionMode:'stub'` / `engine:'stub'`。
 */
function isStubEngine(engine) {
  return Boolean(engine && engine.engineName === 'stub')
}

function isStubRun(meta, engine) {
  if (isStubEngine(engine)) return true
  return Boolean(meta && (meta.sessionMode === 'stub' || meta.engine === 'stub'))
}

/**
 * E3-a：工作区硬校验（路由侧）。
 *
 * 只认「绝对路径 + 真实存在 + 是目录」——不接受空串，也不在缺失时回落
 * `process.cwd()`（那会把节点写进 dsh 服务进程自己的目录）。不合格一律
 * `400 + code:'workspace'`（可读中文原因），调用方拿得到该修什么。
 *
 * 返回值形状与 `runstore.normalizeMeta()` 的 `workspace` 白名单键一致
 * （`id/path/realpath`；`isGit/gitRoot` 由引擎在 start 时解析后覆盖）。
 *
 * @param {unknown} value 调用方给的路径（字符串）
 * @returns {{ id: string, path: string, realpath: string }}
 */
function resolveWorkspaceRecord(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw workspaceError('缺少 workspace：启动 run 必须给出工作区绝对路径（不会再回落到服务进程的当前目录）')
  }
  const workspace = value.trim()
  if (!isAbsolute(workspace)) {
    throw workspaceError('workspace 必须是绝对路径')
  }
  const absolute = resolve(workspace)
  let info
  try {
    info = statSync(absolute)
  } catch {
    throw workspaceError(`workspace 不存在：${absolute}`)
  }
  if (!info.isDirectory()) {
    throw workspaceError(`workspace 必须是目录，但它是文件：${absolute}`)
  }
  let realpath
  try {
    realpath = realpathSync(absolute)
  } catch {
    throw workspaceError(`workspace 路径无法解析：${absolute}`)
  }
  // G6-a ③：配置了 FLOW_STUDIO_WORKSPACE_ROOTS 就必须落在白名单内（不配置 = 不限制）。
  // 用 realpath 比较，避免「白名单外建一个指向白名单内的 symlink」绕过。
  const allowlistReason = workspaceAllowlistReason(realpath)
  if (allowlistReason !== null) throw workspaceError(allowlistReason)
  return { id: workspaceIdFor(realpath), path: absolute, realpath }
}

/**
 * E3-b：外部写入通道（`POST /runs/<id>/events`）的**允许集合**。
 *
 * 这是白名单，不是「黑名单几条例外」：只有纯观测类事件可以外部追加，
 * 其余一律 400。生命周期必须由引擎 / 运行时内部推进——
 *   - `run/start`  会把 `pending` 切成 `running`（且 `started=true`，之后永远 409）；
 *   - `run/end`    会直接把 run 置成终态；
 *   - `node/start`、`node/end`、`reject/trigger` 会改节点进度 / 打回重跑；
 *   - `member/start`、`member/end` 是成员生命周期。
 * 这些一旦开放给外部，就等于把状态机交给了 HTTP 调用方（而且无法回滚）。
 *
 * 允许的是：消息（`agent/message` / `message/in` / `message/out`）、
 * 节点上报（`node/status`）、以及执行侧的事实上报（工具 / 模型调用、证据、
 * 评审、检查、验收、测试报告）——它们只追加事实，不推状态机。
 */
const EXTERNAL_EVENT_KINDS = new Set([
  // 消息 / 日志类
  'agent/message',
  'message/in',
  'message/out',
  // 节点自审上报
  'node/status',
  // 执行侧事实上报（只影响聚合与展示，不推 run 状态机）
  'model/call',
  'tool/call',
  'skill/load',
  'artifact/write',
  'review/finding',
  'review/verdict',
  'check/form',
  'acceptance/verdict',
  'test/report',
])

/** 生命周期 kind（只用来生成可读报错，白名单才是唯一判定）。 */
const LIFECYCLE_EVENT_KINDS = Object.freeze([
  'run/start',
  'run/end',
  'node/start',
  'node/end',
  'member/start',
  'member/end',
  'reject/trigger',
])

/**
 * E3-b：整批校验外部事件。任何一条不是观测类 → 400，且一条都不写
 * （`appendEvents` 本身就是整批语义；这里在它之前挡住，保证状态机完全不受影响）。
 * @param {unknown} rawEvents 单条或数组（与 appendEvents 入参同口径）
 */
function assertExternalEvents(rawEvents) {
  const list = Array.isArray(rawEvents) ? rawEvents : [rawEvents]
  for (let index = 0; index < list.length; index += 1) {
    const event = list[index]
    const kind = event && typeof event === 'object' && !Array.isArray(event) ? event.kind : undefined
    if (typeof kind === 'string' && EXTERNAL_EVENT_KINDS.has(kind)) continue
    const shown = typeof kind === 'string' ? kind : String(kind)
    const hint = LIFECYCLE_EVENT_KINDS.includes(shown)
      ? '生命周期事件只能由引擎 / 运行时内部推进，外部通道不能追加'
      : `外部事件通道只接受纯观测类事件（${[...EXTERNAL_EVENT_KINDS].join(' / ')}）`
    throw new RunError(400, `events[${index}].kind`, `${hint}：${shown}`, { index })
  }
}

/**
 * R4/S3（0.11）：外部通道的事件**来源不可伪造**。
 *
 * `extra` 里这些字段是宿主 / 引擎的授信元数据，来客一个都不许自带：来源、生产者、
 * 权威级别、可信执行登记、epoch / 终态作用域、幂等键、引擎自写报告标记。服务端
 * 一律先剥离、再覆盖成 external/unverified；data 原文保留为「未验证观察」。
 */
const PROTECTED_EXTERNAL_EXTRA = new Set([
  'source',
  'producer',
  'authority',
  'verification',
  'executionId',
  'trustedExecution',
  'terminalScope',
  'leaseEpoch',
  'leaseLost',
  'epoch',
  'idempotencyKey',
  'generatedReport',
])

/**
 * R4/S3：给外部事件整批盖来源章。返回新数组（不改调用方对象）。
 * @param {unknown} rawEvents 单条或数组
 */
function stampExternalEvents(rawEvents) {
  const list = Array.isArray(rawEvents) ? rawEvents : [rawEvents]
  return list.map(event => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return event
    const extra = event.extra && typeof event.extra === 'object' && !Array.isArray(event.extra)
      ? { ...event.extra }
      : {}
    for (const key of PROTECTED_EXTERNAL_EXTRA) delete extra[key]
    return {
      ...event,
      extra: {
        ...extra,
        source: 'external',
        producer: 'external',
        authority: 'unverified',
      },
    }
  })
}

/** run 的终态：到了这里就不再有「定时唤醒」的意义（supervise.planWake 也直接停）。 */
const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'aborted'])

/**
 * 07 §4.3：把 run 元数据的 workspace / worktree 收敛成列表行要的三个扁平字段
 * （缺字段 = null / false）。来源是 `readRunMeta`——runstore 白名单已覆盖这四个键。
 */
function runWorkspaceFields(meta) {
  const workspace = meta && meta.workspace && typeof meta.workspace === 'object' ? meta.workspace : null
  const worktree = meta && meta.worktree && typeof meta.worktree === 'object' ? meta.worktree : null
  return {
    workspaceId: workspace && typeof workspace.id === 'string' && workspace.id !== '' ? workspace.id : null,
    workspacePath: workspace && typeof workspace.path === 'string' && workspace.path !== '' ? workspace.path : null,
    worktreeEnabled: Boolean(worktree && worktree.enabled === true),
  }
}

/** 07 §4.3：列表行 / 详情 / summary 都要能读到 supervision（只读）。 */
function runSupervisionOf(meta) {
  return meta && meta.supervision && typeof meta.supervision === 'object' ? meta.supervision : null
}

/**
 * v0.8 §11.4：节点最新自审状态（nodeId → {state, progress, summary, verdict,
 * members, blockers, at}）。runstore 白名单已覆盖 `nodeStatus`；缺省给 `{}`。
 */
function runNodeStatusOf(meta) {
  const value = meta && meta.nodeStatus
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * 07 §6 的两条 executor 规则（custom 必须填 `executorCommand`；外部 executor 只能 single）
 * 目前**不在** `engine.validateFlowForRun()` 里——那是独立的结构校验器，executor 只在
 * 节点执行时由 `normalizeExecutor` 拦住（节点会失败）。为了「开跑前」就报 400，Host 侧的
 * start 路径在这里按同一份规则预检一次（engine 执行时再拦属于双保险）。
 *
 * @returns {Array<{ nodeId: string, message: string }>}
 */
/** 0.11 · R5：宿主检查默认关，只有显式 `FLOW_STUDIO_ALLOW_HOST_CHECKS=1` 才允许执行。 */
function hostChecksAllowed() {
  return process.env.FLOW_STUDIO_ALLOW_HOST_CHECKS === '1'
}

/**
 * 0.11 · R5：启动前拦截「配了检查但开关没开 / 配置非法」的流程。
 * 不等到节点收口才失败——那会让 run 白跑一轮且留下半套证据。
 * @returns {Array<{ nodeId: string, code: string, message: string }>}
 */
function hostCheckBlockers(flow) {
  const blockers = []
  const allowed = hostChecksAllowed()
  const nodes = flow && Array.isArray(flow.nodes) ? flow.nodes : []
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (!node || node.kind !== NODE_KIND.STAGE) continue
    if (node.check === undefined || node.check === null) continue
    if (!allowed) {
      blockers.push({
        nodeId: node.id,
        code: 'HOST_CHECKS_DISABLED',
        message: `nodes[${index}]（${node.id}）配置了宿主检查命令，但 FLOW_STUDIO_ALLOW_HOST_CHECKS 未开启（只有字符串 1 才执行）；请移除检查配置，或由部署方显式开启后再启动。`,
      })
      continue
    }
    const verdict = validateNodeCheck(normalizeNodeCheck(node.check))
    if (!verdict.ok) {
      blockers.push({
        nodeId: node.id,
        code: 'HOST_CHECK_INVALID',
        message: `nodes[${index}].check.${verdict.field}：${verdict.message}`,
      })
    }
  }
  return blockers
}

function executorBlockers(flow) {
  const blockers = []
  for (const node of (flow && flow.nodes) || []) {
    if (!node || node.kind !== NODE_KIND.STAGE) continue
    try {
      normalizeExecutor(node)
    } catch (error) {
      blockers.push({ nodeId: node.id, message: error && error.message ? error.message : String(error) })
    }
  }
  return blockers
}

/** 07 §4 / §7 / v0.8 §11.4：列表行 / 详情 / summary 的五字段（同一口径）。 */
function runBindingFields(meta) {
  return {
    workspace: meta && meta.workspace ? meta.workspace : null,
    worktree: meta && meta.worktree ? meta.worktree : null,
    sessionMode: meta && typeof meta.sessionMode === 'string' ? meta.sessionMode : null,
    supervision: runSupervisionOf(meta),
    nodeStatus: runNodeStatusOf(meta),
  }
}

/**
 * B：把 run.json.tokenCoverage 收敛成对外形状。
 *
 * - 老 run 没有这个字段（或形状坏掉）→ 按 `{ complete: true, missing: [] }` 处理，
 *   不报错、不把「没记录」误报成「有缺口」；
 * - `full=false` 只回 `{ complete }`（列表 / light 投影够用，省字节）；
 * - `full=true` 回完整 `{ complete, missing: [{ nodeId, attemptId }], buckets }`（详情用）。
 *   `buckets = { seen, missing }` 是四桶覆盖（`input|cacheRead|cacheWrite|output`），
 *   纯信息、不参与 `complete`；老 run 没有这个字段时收敛成空数组对。
 *
 * runstore 的 `normalizeMeta` 已经做过有界收敛（missing ≤50、每条只留 nodeId/attemptId），
 * 这里只做「缺省 + 投影」，不重新发明口径。
 *
 * @param {object|null|undefined} meta
 * @param {{ full?: boolean }} [options]
 * @returns {{ complete: boolean, missing?: {nodeId: string, attemptId: number}[], buckets?: {seen: string[], missing: string[]} }}
 */
function tokenCoverageOf(meta, options = {}) {
  const source = meta && typeof meta === 'object' && meta.tokenCoverage && typeof meta.tokenCoverage === 'object'
    ? meta.tokenCoverage
    : null
  const complete = source ? source.complete === true : true
  if (options.full !== true) return { complete }
  const missing = []
  if (source && Array.isArray(source.missing)) {
    for (const item of source.missing) {
      if (missing.length >= 50) break
      if (!item || typeof item !== 'object') continue
      if (typeof item.nodeId !== 'string' || item.nodeId === '') continue
      if (!Number.isInteger(item.attemptId) || item.attemptId < 1) continue
      missing.push({ nodeId: item.nodeId, attemptId: item.attemptId })
    }
  }
  return { complete, missing, buckets: normalizeCoverageBuckets(source && source.buckets) }
}

/**
 * G7：`GET /runs/<runId>?light=1` 的轻量投影（前端契约，字段集固定）。
 *
 * **只读 run.json 元数据**（`readRunMeta`），绝不调用 `readRunDetail()`：
 * 后者会 `readAllEventsUnlocked()` 并逐事件建节点索引，正是要消掉的 ~113ms/次。
 * 因此这里不返回 `nodes` / `events`；`eventCount` 直接取 run.json 计数器
 * （不做任何事件解析），`live` 原样透传 run.json 里那份（可能为 null）。
 *
 * @param {object} meta readRunMeta 的结果
 * @returns {object}
 */
function lightRunOf(meta) {
  const worktree = meta && meta.worktree && typeof meta.worktree === 'object' ? meta.worktree : null
  const run = {
    id: meta.id,
    flowId: meta.flowId,
    flowName: meta.flowName,
    name: meta.name,
    status: meta.status,
    started: meta.started === true,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    nodeDone: meta.nodeDone,
    nodeTotal: meta.nodeTotal,
    tokenTotal: meta.tokenTotal,
    // B：light 投影只放 { complete }（缺口明细在详情里）。
    tokenCoverage: tokenCoverageOf(meta),
    // progress? 可选：run.json 里有什么给什么（不重算）。
    ...(meta.progress && typeof meta.progress === 'object' ? { progress: meta.progress } : {}),
    // eventCount? 可选：直接取 run.json 计数器；拿不到就省略，绝不为此解析事件。
    ...(Number.isInteger(meta.eventCount) && meta.eventCount >= 0 ? { eventCount: meta.eventCount } : {}),
    engine: meta.engine,
    // live 必须是 run.json 里那份（可能为 null），不伪造。
    live: meta.live ?? null,
    nodeStatus: runNodeStatusOf(meta),
    workspace: meta.workspace && typeof meta.workspace === 'object' ? meta.workspace : null,
    // 契约字段集：{ enabled, reason, path, branch }；worktree 模块新增的 root / warnings
    //（前端要展示「为什么要单独清理 / 有哪些告警」）与 baseCommit（空仓库时为 null）一并带上。
    worktree: {
      enabled: Boolean(worktree && worktree.enabled === true),
      reason: worktree && typeof worktree.reason === 'string' ? worktree.reason : null,
      path: worktree && typeof worktree.path === 'string' ? worktree.path : null,
      branch: worktree && typeof worktree.branch === 'string' ? worktree.branch : null,
      root: worktree && typeof worktree.root === 'string' ? worktree.root : null,
      // 空仓库的 baseCommit 可能是 null —— 容忍 null，别在这里做 40 位 hex 校验。
      baseCommit: worktree && typeof worktree.baseCommit === 'string' ? worktree.baseCommit : null,
      warnings: worktree && Array.isArray(worktree.warnings)
        ? worktree.warnings.filter(item => typeof item === 'string' && item !== '')
        : [],
    },
    sessionMode: typeof meta.sessionMode === 'string' ? meta.sessionMode : null,
    supervision: runSupervisionOf(meta),
  }
  return run
}

/**
 * 流程保存的**形状门槛**：只有「请求体不是 JSON 对象」这种垃圾才 400。
 *
 * 保存**不因 `validation.errors` 拒绝**（0.7 产品拍板）：客户端画布是自动保存（600ms 防抖），
 * 用户拖一个还没填任务内容的空节点、或新建空流程，`validateFlow` 都会报 error；把它当 400
 * 会让每一次中间态都存不进去，直接毁掉编辑体验。真正该严的是**启动 run**——
 * `engine.validateFlowForRun()` 才是严格口径（同样是 `validateFlow`，executor 的两条新规则
 * 在那儿一样会拦住），所以非法流程可以存，但开不了跑。
 *
 * @param {unknown} body
 * @returns {boolean} true 表示形状不合法（调用方回 400 后 return）
 */
function rejectMalformedFlowBody(res, body) {
  if (body === undefined || body === null) return false
  if (typeof body === 'object' && !Array.isArray(body)) return false
  sendJson(res, 400, { ok: false, error: '流程内容必须是 JSON 对象' })
  return true
}

/**
 * 0.9.1 实证事故：`PUT /flows/<id>` 是**整份替换**语义。请求体里连 `nodes` / `edges`
 * 键都没有（典型是把「流程列表摘要」`{id,name,nodeCount,…}` 当流程发过来），或键在但值
 * 不是数组（`nodes: null` / `nodes: 'nope'`）时，`normalizeFlow` 会兜成空数组，
 * 服务器上的流程就被静默写成空图。
 *
 * 因此这里要求两个键**存在且都是数组**。空数组仍然放行 —— 那是 0.7 拍板的宽松保存口径
 * （画布自动保存的中间态必然非法，一律 200 + validation，严格口径留给启动 run）。
 * 只用于 PUT：POST 新建的宽松口径有既有契约，不在此列。
 */
function rejectIncompleteFlowBody(res, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const invalid = ['nodes', 'edges'].filter(key => !Array.isArray(body[key]))
  if (invalid.length === 0) return false
  sendJson(res, 400, {
    ok: false,
    code: 'FLOW_BODY_INCOMPLETE',
    error: '保存流程必须带 nodes / edges 数组：PUT 是整份替换语义，缺字段或类型不对会把流程写成空图（不合格：'
      + invalid.join(' / ') + '）',
  })
  return true
}

/**
 * 原始 URL 的路径段防线。WHATWG URL 会把 `..` / `%2e%2e` 规范化掉，
 * 规范化之后再看就分不清「用户想穿越」还是「本来就没有这个接口」，
 * 所以先在原始 req.url 上挡一道，统一回 400。
 */
function assertSafeRawPath(req) {
  const rawPath = (req.url || '').split('?')[0]
  if (rawPath.includes('//')) {
    throw new RunError(400, 'path', '路径不合法（出现空路径段）')
  }
  for (const piece of rawPath.split('/')) {
    let decoded
    try {
      decoded = decodeURIComponent(piece)
    } catch {
      throw new RunError(400, 'path', '路径编码不合法')
    }
    if (decoded === '.' || decoded === '..') {
      throw new RunError(400, 'path', '路径不合法（禁止 . / .. 段）')
    }
  }
}

/**
 * 路由分发。所有错误都在这里收口，不让异常逃出请求处理器。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ dir: string, runsRoot: string, ctx: any, engine: any, startOptions?: Map }} env
 */
async function handle(req, res, env) {
  // 06 §13.1：鉴权必须是 handler 的第一件事，不能只靠 Origin。
  const rejection = connectionRejection(env, req)
  if (rejection !== null) {
    if (rejection === 503) {
      sendJson(res, 503, {
        ok: false,
        code: 'AUTH_SERVICE_UNAVAILABLE',
        error: '鉴权服务不可用（拿不到 connection 服务或其 requestRejection 抛错），已按 fail-closed 拒绝请求',
      })
      return
    }
    sendJson(res, rejection, {
      ok: false,
      code: rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
      error: rejection === 401
        ? '未授权：需要通过宿主 connection 鉴权（缺少或无效的登录凭据）'
        : '拒绝访问：请求未通过宿主的同源 / 信任校验',
    })
    return
  }

  if (!isSameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: '拒绝跨站请求' })
    return
  }

  try {
    await route(req, res, env)
  } catch (error) {
    if (res.headersSent) {
      try {
        res.end()
      } catch {
        // 响应已经发出，能做的只有结束它。
      }
      return
    }
    if (error instanceof RunError) {
      const payload = error.toPayload()
      // 错误码：RunError.toPayload() 只带 field/index，额外挂在 error.code 上的
      // 业务码（例如 workspace）在这里补出去，调用方可按 code 分流。
      if (typeof error.code === 'string' && error.code !== '') payload.code = error.code
      sendJson(res, error.status, payload)
      return
    }
    // 0.11 · R2/S1：并发配额拒绝要保留结构化原因（scope / reason / limits /
    // retryAfterMs），并带 Retry-After；不能退化成一句笼统的 429 文案。
    if (error && error.status === 429 && error.code === 'RUN_CONCURRENCY_LIMIT') {
      const payload = {
        ok: false,
        code: error.code,
        error: error.message,
        scope: error.scope,
        reason: error.reason,
        active: error.active,
        max: error.max,
        retryAfterMs: error.retryAfterMs,
        ...(error.limits ? { limits: error.limits } : {}),
        ...(error.runId ? { runId: error.runId } : {}),
        ...(error.childRunId ? { childRunId: error.childRunId } : {}),
      }
      sendJson(res, 429, payload, {
        'retry-after': String(Math.max(1, Math.ceil((error.retryAfterMs || 30000) / 1000))),
      })
      return
    }
    if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
      sendJson(res, error.status, { ok: false, error: error.message })
      return
    }
    sendInternalError(res, env, error)
  }
}

/**
 * 把插件路由绑成一个 HTTP 处理器（`env` 里带 dir / runsRoot / ctx / engine / startOptions）。
 *
 * 单独导出是为了让测试能用**注入的假引擎**验证「参数有没有透传到 engine.start」——
 * 真引擎要起 agents 才能跑，而透传这件事不该只能靠集成测试覆盖。
 *
 * @param {{ dir: string, runsRoot: string, ctx: any, engine: any, startOptions?: Map }} env
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createHandler(env) {
  return (req, res) => {
    // prefix 路由会被 /api/flow-studio-x 这类同前缀路径命中，这里再挡一道。
    const path = (req.url || '').split('?')[0]
    if (path !== BASE && !path.startsWith(`${BASE}/`)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    handle(req, res, env).catch(error => {
      if (!res.headersSent) {
        sendInternalError(res, env, error)
        return
      }
      res.end()
    })
  }
}

async function route(req, res, env) {
  assertSafeRawPath(req)
  const url = new URL(req.url || '/', 'http://localhost')
  const rest = url.pathname.slice(BASE.length)
  const parts = rest.split('/').filter(part => part.length > 0)
  // 06 §13.1：token 档位只认 Authorization: Bearer；`?token=` 仅 export 路由保留
  //（浏览器 <a download> 没法带请求头）。
  const isExportRoute = parts[0] === 'runs' && parts.length === 3 && parts[2] === 'export'
  const authz = authorizeRequest(req, url, { allowQueryToken: isExportRoute })
  if (!authz.ok) {
    sendJson(res, 401, { ok: false, error: '未授权：需要 Authorization: Bearer <token>' })
    return
  }
  // G6-a ①：只读令牌只能 GET；任何写请求（POST / PUT / DELETE / PATCH…）一律 403。
  if (authz.readOnly && req.method !== 'GET') {
    sendJson(res, 403, {
      ok: false,
      code: 'READ_ONLY_TOKEN',
      error: `当前令牌是只读令牌（${READ_AUTH_ENV}）：只允许 GET，不能执行 ${req.method} 写操作`,
      hint: `写操作请改用全权令牌（${AUTH_ENV}）或宿主的登录凭据`,
    })
    return
  }

  // GET /api/flow-studio/health
  if (parts.length === 1 && parts[0] === 'health') {
    // 06 §13.1：目录只在「已通过鉴权」或「回环请求」时返回，避免把宿主路径泄露给 LAN。
    const exposePaths = authz.ok || isLoopbackRequest(req)
    const authState = inspectAuth()
    const rootsConfig = parseWorkspaceRoots()
    sendJson(res, 200, {
      ok: true,
      ...(exposePaths ? { dir: env.dir, runsDir: env.runsRoot } : {}),
      // §8.5：运维一眼看出当前鉴权档位（旧字段保持字符串，向后兼容）。
      auth: authState.present ? 'token' : 'connection',
      // G6-a ④：让调用方知道自己的令牌能干什么（per-request）。
      authMode: authz.mode,
      readOnly: authz.readOnly,
      customExecutor: customExecutorAllowed(),
      // G6-c：默认时限（调用方可据此决定要不要显式调大 runTimeoutMs）。
      limits: {
        defaultRunTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
        defaultNodeTimeoutMs: DEFAULT_NODE_TIMEOUT_MS,
      },
      capabilities: {
        mode: authz.mode,
        readOnly: authz.readOnly,
        write: !authz.readOnly,
        customExecutor: customExecutorAllowed(),
        workspaceAllowlist: { configured: rootsConfig.roots.length > 0, count: rootsConfig.roots.length },
      },
      version: PLUGIN_VERSION,
      schemaVersion: 1,
      // 06 §12 / §13.8：stub 判定结果（只有 TESTBED=1 才算数）。
      engine: env.engine ? env.engine.engineName : 'real',
      skills: Boolean(env.ctx.get && env.ctx.get('skills')),
    })
    return
  }

  // GET /api/flow-studio/skills — 供节点「引用 skills」下拉使用
  if (parts.length === 1 && parts[0] === 'skills') {
    const skills = await listSkills(env.ctx)
    sendJson(res, 200, { ok: true, skills })
    return
  }

  // G6-b：worktree 生命周期入口
  //   GET  /api/flow-studio/worktrees        —— 实时清单（listWorktrees）+ 孤儿标记 + 记录指针
  //   POST /api/flow-studio/worktrees/prune  —— 清理不对应任何现有 run 的 worktree
  if (parts[0] === 'worktrees') {
    if (parts.length === 1 && req.method === 'GET') {
      await listWorktreesRoute(req, res, env)
      return
    }
    if (parts.length === 2 && parts[1] === 'prune' && req.method === 'POST') {
      await pruneWorktreesRoute(res, env, await readBody(req))
      return
    }
    if (parts.length > 2 || (parts.length === 2 && parts[1] !== 'prune')) {
      sendJson(res, 404, { ok: false, error: '未知接口' })
      return
    }
    sendJson(res, 405, { ok: false, error: parts.length === 1 ? '只支持 GET' : '只支持 POST' })
    return
  }

  // /api/flow-studio/runs[/<runId>[/events|summary|export]]
  if (parts[0] === 'runs') {
    await handleRuns(req, res, env, url, parts)
    return
  }

  // /api/flow-studio/flows[/<id>]
  if (parts[0] === 'flows') {
    const id = parts[1]

    // 0.12 目录化（附加路径，不动既有 POST/PUT 语义）：
    //   POST /flows/import-dir          { dir, name? }  目录 → 编译 → 存成**新流程**（新 id）
    //   POST /flows/<id>/export-dir     { dir }         已有流程 → 写成一个目录
    //
    // 「导入生成新 id」是刻意的：目录是编辑期真源、JSON 是运行期真源，两者不做双向同步，
    // 靠新 id 避免出现两个真源互相覆盖。
    if (parts.length === 2 && id === 'import-dir') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const body = await readBody(req)
      if (!body || typeof body !== 'object' || typeof body.dir !== 'string' || body.dir.trim() === '') {
        sendJson(res, 400, {
          ok: false,
          code: 'FLOW_DIR_REQUIRED',
          error: '需要 dir：流程目录的绝对路径',
        })
        return
      }
      // 相对路径在 host 进程的 cwd 下解析，含义随启动方式变化；与 flow_compile 工具同口径，一律要求绝对路径。
      if (!isAbsolute(body.dir.trim())) {
        sendJson(res, 400, {
          ok: false,
          code: 'FLOW_DIR_NOT_ABSOLUTE',
          error: 'dir 必须是绝对路径：相对路径在不同工作目录下含义不同',
        })
        return
      }
      const read = await readFlowDir(body.dir)
      const compiled = compileFlowFiles(read.files)
      // IO 层错误（路径穿越 / 超限）与语义错误（缺文件 / 布局外文件 / 结构非法）必须合并报，
      // 只报其中一半会让调用方以为「只是某个文件读失败」。
      const errors = [...read.errors, ...compiled.errors]
      if (errors.length > 0) {
        sendJson(res, 400, {
          ok: false,
          code: 'FLOW_COMPILE_FAILED',
          error: errors[0].message,
          errors,
        })
        return
      }
      // compileFlowFiles 返回的是「文件里写了什么就是什么」的组装结果，不补默认值；
      // 入库前必须走 normalizeFlow，否则默认字段（executor/maxRounds/extras…）会是空的。
      const wantedName = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : ''
      const normalized = normalizeFlow(compiled.flow, wantedName || '新流程')
      // 显式给了 name 就以它为准（normalizeFlow 的第二个参数只是 fallback，目录里有 name 时会被它盖住）。
      if (wantedName !== '') normalized.name = wantedName
      const customGate = customExecutorBlockers(normalized)
      if (customGate.length > 0) {
        sendJson(res, 400, {
          ok: false,
          code: 'CUSTOM_EXECUTOR_DISABLED',
          field: 'nodes',
          error: customGate[0].message,
          errors: customGate,
        })
        return
      }
      const flowId = newFlowId()
      const saved = await saveFlow(env.dir, flowId, normalized, { name: '新流程' })
      sendJson(res, 200, {
        ok: true,
        flow: saved,
        validation: validateFlow(saved),
        files: [...read.files.keys()].sort(),
      })
      return
    }

    if (parts.length === 3 && checkId(id) && parts[2] === 'export-dir') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const body = await readBody(req)
      if (!body || typeof body !== 'object' || typeof body.dir !== 'string' || body.dir.trim() === '') {
        sendJson(res, 400, {
          ok: false,
          code: 'FLOW_DIR_REQUIRED',
          error: '需要 dir：导出目录的绝对路径',
        })
        return
      }
      if (!isAbsolute(body.dir.trim())) {
        sendJson(res, 400, {
          ok: false,
          code: 'FLOW_DIR_NOT_ABSOLUTE',
          error: 'dir 必须是绝对路径：相对路径在不同工作目录下含义不同',
        })
        return
      }
      const flow = await readFlow(env.dir, id)
      if (!flow) {
        sendJson(res, 404, { ok: false, error: '流程不存在' })
        return
      }
      try {
        const written = await writeFlowDir(body.dir, flow)
        sendJson(res, 200, { ok: true, dir: written.dir, files: written.files, bytes: written.bytes })
      } catch (error) {
        // 拒绝覆盖「不是本模块产物」的非空目录：这是防误删，不是存储故障，回 409 更准确。
        const code = error && typeof error.code === 'string' ? error.code : ''
        if (code.startsWith('flowdir-')) {
          sendJson(res, 409, {
            ok: false,
            code: 'FLOW_DIR_REFUSED',
            error: error && error.message ? error.message : String(error),
          })
          return
        }
        throw error
      }
      return
    }

    if (parts.length === 1) {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, flows: await listFlows(env.dir) })
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        // 只有形状垃圾才 400；validation.errors 不拦保存（空流程/半成品都能存，见 rejectMalformedFlowBody）。
        if (rejectMalformedFlowBody(res, body)) return
        // G6-a ②：custom executor 是宿主 RCE 面；主机开关关着时连保存都拒绝
        //（不能只在前端拦——HTTP 调用方可以绕过画布直接 PUT）。
        const customGate = customExecutorBlockers(body)
        if (customGate.length > 0) {
          sendJson(res, 400, {
            ok: false,
            code: 'CUSTOM_EXECUTOR_DISABLED',
            field: 'nodes',
            error: customGate[0].message,
          })
          return
        }
        const flowId = newFlowId()
        const saved = await saveFlow(env.dir, flowId, body, { name: '新流程' })
        sendJson(res, 200, { ok: true, flow: saved, validation: validateFlow(saved) })
        return
      }
      sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
      return
    }

    if (parts.length === 2 && checkId(id)) {
      if (req.method === 'GET') {
        const flow = await readFlow(env.dir, id)
        if (!flow) {
          sendJson(res, 404, { ok: false, error: '流程不存在' })
          return
        }
        sendJson(res, 200, { ok: true, flow, validation: validateFlow(flow) })
        return
      }
      if (req.method === 'PUT') {
        const body = await readBody(req)
        if (body === undefined) {
          sendJson(res, 400, { ok: false, error: '缺少流程内容' })
          return
        }
        // 乐观锁：body.version 是主路径；If-Match 只作为可选兼容（body 没带版本时补位）。
        const ifMatch = parseIfMatch(req.headers['if-match'])
        if (Number.isNaN(ifMatch)) {
          sendJson(res, 400, {
            ok: false,
            error: 'If-Match 必须是正整数版本号',
            code: 'FLOW_VERSION_INVALID',
          })
          return
        }
        let payload = body
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          if (body.version !== undefined && !(Number.isSafeInteger(body.version) && body.version >= 1)) {
            sendJson(res, 400, {
              ok: false,
              error: 'version 必须是 ≥1 的整数',
              code: 'FLOW_VERSION_INVALID',
            })
            return
          }
          if (body.version === undefined && ifMatch !== undefined) {
            payload = { ...body, version: ifMatch }
          }
        }
        // 保存不因 validation.errors 拒绝（自动保存 + 中间态必然非法）；只有形状垃圾才是 400。
        if (rejectMalformedFlowBody(res, payload)) return
        // 0.9.1：缺 nodes/edges 键或值不是数组的「整份替换」一律拒绝，否则会把流程写成空图。
        if (rejectIncompleteFlowBody(res, payload)) return
        // G6-a ②：含 executor:'custom' 的流程，主机开关关着时保存即 400（与启动同口径）。
        const customGate = customExecutorBlockers(payload)
        if (customGate.length > 0) {
          sendJson(res, 400, {
            ok: false,
            code: 'CUSTOM_EXECUTOR_DISABLED',
            field: 'nodes',
            error: customGate[0].message,
          })
          return
        }
        try {
          const saved = await saveFlow(env.dir, id, payload)
          sendJson(res, 200, { ok: true, flow: saved, validation: validateFlow(saved) })
        } catch (error) {
          if (error instanceof FlowConflictError) {
            sendJson(res, 409, {
              ok: false,
              error: '流程已被其他人改过，请刷新后重试',
              code: 'FLOW_VERSION_CONFLICT',
              currentVersion: error.currentVersion,
              updatedAt: error.currentUpdatedAt,
            })
            return
          }
          throw error
        }
        return
      }
      if (req.method === 'DELETE') {
        const existed = await deleteFlow(env.dir, id)
        sendJson(res, existed ? 200 : 404, existed ? { ok: true } : { ok: false, error: '流程不存在' })
        return
      }
      sendJson(res, 405, { ok: false, error: '只支持 GET / PUT / DELETE' })
      return
    }

    sendJson(res, 400, { ok: false, error: '流程 id 不合法' })
    return
  }

  sendJson(res, 404, { ok: false, error: '未知接口' })
}

// ── G6-b：worktree 生命周期路由 ────────────────────────────────────────────

/** 把 listWorktrees 的条目收敛成可安全 JSON 化的行（只保留已知字段 + orphan 标记）。 */
function worktreeRowOf(entry, existingRunIds) {
  const row = {
    path: typeof entry.path === 'string' ? entry.path : null,
    workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : null,
    runId: typeof entry.runId === 'string' ? entry.runId : null,
    exists: entry.exists === true,
    dirty: entry.dirty === true ? true : (entry.dirty === false ? false : null),
    head: typeof entry.head === 'string' && entry.head !== '' ? entry.head : null,
    // registered 可能是 null（查不到主仓库），保留三态，不塌缩成 false。
    registered: entry.registered === true ? true : (entry.registered === false ? false : null),
    orphan: false,
  }
  if (typeof entry.error === 'string' && entry.error !== '') row.error = entry.error
  if (row.runId !== null) row.orphan = !existingRunIds.has(row.runId)
  return row
}

/**
 * `GET /api/flow-studio/worktrees`
 *
 * 两个来源合并：listWorktrees 的实时清单（孤儿 = 对应 run 已不存在）+
 * DELETE /runs 时记下的指针（recorded）。模块新导出还没落地时，实时部分标
 * available:false + reason，但 recorded 仍然可查（孤儿指针不会因此丢失）。
 */
async function listWorktreesRoute(req, res, env) {
  const root = env.runsRoot
  const worktreesRoot = worktreesRootFor(root)
  const api = worktreeApiOf(env)
  const existingRunIds = new Set(await listExistingRunIds(root))
  const recorded = await readOrphanWorktrees(root)

  if (typeof api.listWorktrees !== 'function') {
    sendJson(res, 200, {
      ok: true,
      root: worktreesRoot,
      available: false,
      reason: 'src/worktree.js 还没有导出 listWorktrees（worktree 生命周期模块尚未落地）；'
        + 'recorded 是 DELETE /runs 时留下的孤儿指针',
      worktrees: [],
      orphans: [],
      recorded,
      keptRunCount: existingRunIds.size,
    })
    return
  }

  let listed
  try {
    listed = await api.listWorktrees({ root: worktreesRoot, run: worktreeRunnerOf(env) })
  } catch (error) {
    throw new RunError(500, 'worktree', `读取 worktree 列表失败：${errorMessage(error)}`)
  }
  const entries = Array.isArray(listed) ? listed : []
  const worktrees = entries
    .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(entry => worktreeRowOf(entry, existingRunIds))
  sendJson(res, 200, {
    ok: true,
    root: worktreesRoot,
    available: true,
    worktrees,
    orphans: worktrees.filter(row => row.orphan === true),
    recorded,
    keptRunCount: existingRunIds.size,
  })
}

/** `POST /api/flow-studio/worktrees/prune`：清理不对应任何现有 run 的 worktree。 */
async function pruneWorktreesRoute(res, env, body) {
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) {
    throw new RunError(400, 'body', '请求体必须是 JSON 对象（可省略）')
  }
  const root = env.runsRoot
  const worktreesRoot = worktreesRootFor(root)
  const api = worktreeApiOf(env)
  if (typeof api.pruneWorktrees !== 'function') {
    throw new RunError(
      501,
      'worktree',
      'src/worktree.js 还没有导出 pruneWorktrees（worktree 生命周期模块尚未落地），无法清理',
    )
  }

  // 额外保留的 runId（可选）：现有 run 永远自动保留。
  const extraKeep = []
  const rawKeep = body && body.keepRunIds !== undefined && body.keepRunIds !== null ? body.keepRunIds : []
  if (!Array.isArray(rawKeep)) throw new RunError(400, 'keepRunIds', 'keepRunIds 必须是 runId 字符串数组')
  if (rawKeep.length > 200) throw new RunError(400, 'keepRunIds', 'keepRunIds 最多 200 个 runId')
  for (const item of rawKeep) {
    if (typeof item !== 'string' || !checkRunId(item.trim())) {
      throw new RunError(400, 'keepRunIds', `keepRunIds 里有不合法的 runId：${String(item)}`)
    }
    const id = item.trim()
    if (!extraKeep.includes(id)) extraKeep.push(id)
  }

  const existingRunIds = await listExistingRunIds(root)
  const keepRunIds = [...new Set([...existingRunIds, ...extraKeep])]
  let result
  try {
    result = await api.pruneWorktrees({ root: worktreesRoot, run: worktreeRunnerOf(env), keepRunIds })
  } catch (error) {
    throw new RunError(500, 'worktree', `清理 worktree 失败：${errorMessage(error)}`)
  }
  const removed = result && result.removed !== undefined ? result.removed : []
  const skipped = result && result.skipped !== undefined ? result.skipped : []
  const removedPaths = new Set()
  for (const item of Array.isArray(removed) ? removed : []) {
    const path = typeof item === 'string' ? item : (item && typeof item.path === 'string' ? item.path : null)
    if (path !== null) removedPaths.add(path)
  }
  // prune 已经生效；清单同步失败只作为 warning 报告，不改写这次清理的成功结论。
  let remaining = null
  let recordedError = null
  try {
    remaining = await syncOrphanWorktrees(root, removedPaths)
  } catch (error) {
    recordedError = errorMessage(error)
  }
  sendJson(res, 200, {
    ok: true,
    root: worktreesRoot,
    keepRunIds: keepRunIds.length,
    removed,
    skipped,
    recorded: remaining,
    ...(recordedError === null ? {} : { warning: `孤儿清单同步失败：${recordedError}` }),
  })
}

/**
 * `DELETE /api/flow-studio/runs/<id>/worktree`（G6-b ②）。
 *
 * 只删这一个 run 的 worktree，不动 run 目录。可读原因都要给全：
 *   - run 不存在 → 404；
 *   - 持租约（正在跑）→ 409；
 *   - 没有 worktree 记录 / 没有 workspace → 200 + removed:false + reason；
 *   - 模块没导出 / git 失败 → 501 / 400 / 500 + 中文原因。
 */
async function deleteRunWorktreeRoute(res, env, url, root, runId) {
  const meta = await readRunMeta(root, runId)
  if (!meta) throw new RunError(404, 'runId', 'run 不存在')
  const lease = await readLease(root, runId)
  if (lease) {
    throw new RunError(
      409,
      'runId',
      `该 run 正被 ${lease.pid}@${lease.host} 持有执行租约，运行中不能删除它的 worktree`,
    )
  }
  const record = worktreeRecordOf(meta)
  if (!record) {
    sendJson(res, 200, {
      ok: true,
      removed: false,
      reason: 'no-worktree',
      error: '该 run 没有可删除的 worktree 记录（worktree.enabled=false 或从未创建）',
    })
    return
  }
  const workspace = meta.workspace && typeof meta.workspace === 'object' ? meta.workspace : null
  if (!workspace || (typeof workspace.path !== 'string' && typeof workspace.realpath !== 'string')) {
    sendJson(res, 200, {
      ok: true,
      removed: false,
      reason: 'no-workspace',
      error: 'run.json 里没有工作区记录，无法执行 git worktree remove；请用 POST /worktrees/prune 或手工清理',
    })
    return
  }
  const api = worktreeApiOf(env)
  if (typeof api.removeWorktree !== 'function') {
    throw new RunError(501, 'worktree', 'src/worktree.js 没有 removeWorktree 导出，无法删除')
  }
  // G6-b（模块口径）：必须显式传 root（旧记录可能没有 record.root，不传会退化成宽松校验），
  // 且路由语义就是「用户明确要求删掉这个 run 的 worktree」→ force: true（脏 / 被 lock 也要删）。
  let result
  try {
    result = await api.removeWorktree({
      workspace,
      record,
      run: worktreeRunnerOf(env),
      force: true,
      root: worktreesRootFor(root),
    })
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : ''
    const status = code === 'WORKTREE_PATH_UNSAFE' || code === 'WORKTREE_INVALID' || code === 'WORKSPACE_INVALID'
      ? 400
      : 500
    // 原样透出模块的结构化 reason（unsafe-path / still-registered / 具体 git 错），
    // 调用方不用从中文文案里猜。
    sendJson(res, status, {
      ok: false,
      field: 'worktree',
      reason: error && typeof error.reason === 'string' ? error.reason : null,
      error: `删除 worktree 失败：${errorMessage(error)}`,
    })
    return
  }
  const removed = Boolean(result && result.removed === true)
  const reason = result && typeof result.reason === 'string' && result.reason !== ''
    ? result.reason
    : (removed ? 'removed' : 'not-found')
  // v0.8.2：分支回收结果原样透出（模块在删目录成功后会自动删 flow/<runId> 分支）。
  let branchRemoved = result && typeof result.branchRemoved === 'boolean' ? result.branchRemoved : null
  let branchWarning = result && typeof result.branchWarning === 'string' && result.branchWarning !== ''
    ? result.branchWarning
    : null
  if (!removed) {
    // 目录已被手工删过（not-found）或删除失败时，worktree 目录没了但**分支可能还在** ——
    // 这是审计点名的「只增不减」最后一条尾巴。单独清一次分支（模块只删 flow/ 前缀，绝不碰用户分支）。
    if (typeof api.removeRunBranch === 'function'
      && typeof record.branch === 'string' && record.branch !== '') {
      try {
        const branchResult = await api.removeRunBranch({
          workspace,
          branch: record.branch,
          run: worktreeRunnerOf(env),
        })
        branchRemoved = Boolean(branchResult && branchResult.removed === true)
        branchWarning = branchResult && typeof branchResult.warning === 'string' && branchResult.warning !== ''
          ? branchResult.warning
          : null
      } catch (error) {
        branchWarning = `清理分支失败：${errorMessage(error)}`
      }
    }
  }
  // 删除已经生效；清单同步失败只 warning，不改写成功结论。
  let orphanDropError = null
  if (removed) {
    try {
      await dropOrphanWorktree(root, { runId, path: record.path })
    } catch (error) {
      orphanDropError = errorMessage(error)
    }
  }
  sendJson(res, 200, {
    ok: true,
    removed,
    reason,
    path: record.path,
    branch: typeof record.branch === 'string' ? record.branch : null,
    branchRemoved,
    ...(branchWarning === null ? {} : { branchWarning }),
    root: typeof record.root === 'string' ? record.root : null,
    ...(orphanDropError === null ? {} : { warning: `孤儿清单同步失败：${orphanDropError}` }),
  })
}

async function handleRuns(req, res, env, url, parts) {
  const root = env.runsRoot

  if (parts.length === 1) {
    if (req.method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'), 20, 100)
      const workspaceId = url.searchParams.get('workspaceId')
      // 07 §4.3：`?workspaceId=` 是内存过滤——先取满上限（100）再按 workspace.id 过滤，
      // 最后截到调用方要的条数，避免「前 20 条恰好都不属于该工作区」时返回空表。
      const fetchLimit = typeof workspaceId === 'string' && workspaceId !== ''
        ? Math.max(limit, 100)
        : limit
      // §8.6：列表只读 run.json；坏 run 记进 skipped，不让整表 500。
      const result = await listRuns(root, { limit: fetchLimit })
      const rows = []
      for (const row of result.runs || []) {
        // listRuns 的行是精简投影；四个绑定字段直接取 run.store 白名单里的元数据。
        const meta = await readRunMeta(root, row.id).catch(() => null)
        const fields = runWorkspaceFields(meta)
        if (typeof workspaceId === 'string' && workspaceId !== '' && fields.workspaceId !== workspaceId) continue
        rows.push({
          ...row,
          ...fields,
          ...runBindingFields(meta),
          // B：列表只放 { complete }；listRuns 行本身也已带一份，这里以 run.json 为准。
          tokenCoverage: tokenCoverageOf(meta),
        })
        if (rows.length >= limit) break
      }
      sendJson(res, 200, { ok: true, runs: rows, skipped: result.skipped })
      return
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new RunError(400, 'body', '请求体必须是 JSON 对象')
      }
      if (typeof body.flowId !== 'string' || body.flowId.trim() === '') {
        throw new RunError(400, 'flowId', '缺少 flowId')
      }
      const flowId = checkId(body.flowId)
      if (!flowId) throw new RunError(400, 'flowId', '流程 id 不合法（只允许小写字母、数字、连字符）')
      let name
      if (body.name !== undefined) {
        if (typeof body.name !== 'string') throw new RunError(400, 'name', 'name 必须是字符串')
        name = body.name.trim()
        if (name.length > 200) throw new RunError(400, 'name', '超过 200 字符')
      }
      const flow = await readFlow(env.dir, flowId)
      if (!flow) throw new RunError(404, 'flowId', '流程不存在')
      // 07 §4.1：建 run 时记下发起参数（workspace / worktree），start 时由 engine 最终裁决
      // 并写权威字段（run.json.workspace / run.json.worktree）。
      const startOptions = parseStartOptions(body)
      // E3-a：建 run 就能确定工作区 → 这里就要（stub 除外）。缺失时不在 start 补默认值，
      // 直接把问题挡在创建阶段，避免画布留下一堆「开始运行才发现没工作区」的幽灵 run。
      let workspaceRecord = null
      if (startOptions.workspace !== undefined) {
        workspaceRecord = resolveWorkspaceRecord(startOptions.workspace)
        startOptions.workspace = workspaceRecord.path
      } else if (!isStubEngine(env.engine)) {
        throw workspaceError('缺少 workspace：创建 run 必须给出工作区绝对路径（画布「开始运行」不再回落到服务进程的当前目录）')
      }
      const nodeTotal = flow.nodes.filter(node => node.kind === NODE_KIND.STAGE).length
      const run = await createRun(root, {
        flowId: flow.id,
        flowName: flow.name,
        name: name || flow.name,
        nodeTotal,
        // 06 §13.8：run.json.engine 从建 run 那一刻就带上，列表 / 聚合都读得到。
        engine: env.engine && env.engine.engineName === 'stub' ? 'stub' : 'real',
      })
      if (workspaceRecord) {
        // E3-a：工作区落进 run.json.workspace（runstore 白名单键），走唯一写路径 writeRunMeta。
        await writeRunMeta(root, run.id, { workspace: workspaceRecord })
      }
      if (Object.keys(startOptions).length > 0) {
        // 同进程快速通道：内存表（start 时少一次读盘；落盘失败也不影响本次 start）。
        rememberStartOptions(env.startOptions, run.id, startOptions)
        // 持久化：startOptions 已进 runstore 白名单（只认 workspace / worktree），
        // 这里走 patchRunJson → writeRunMeta 校验并落盘；写失败不阻塞建 run。
        try {
          await patchRunJson(root, run.id, { startOptions })
        } catch (error) {
          if (env.ctx && env.ctx.logger && typeof env.ctx.logger.warn === 'function') {
            env.ctx.logger.warn(`flow-studio: 记录 run ${run.id} 的启动参数失败：${error.message}`)
          }
        }
      }
      const payloadRun = Object.keys(startOptions).length > 0 ? { ...run, startOptions } : { ...run }
      if (workspaceRecord) payloadRun.workspace = workspaceRecord
      sendJson(res, 200, { ok: true, run: payloadRun })
      return
    }
    sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
    return
  }

  const runId = parts[1]
  if (!checkRunId(runId)) {
    throw new RunError(400, 'runId', 'runId 不合法（只允许字母、数字、点、下划线、连字符，1–64 位）')
  }

  if (parts.length === 2) {
    if (req.method === 'GET') {
      // G7（前端契约）：`?light=1` 只读 run.json 元数据，不解析事件（不调 readRunDetail）；
      // 不带 light 的老接口行为完全不变。
      const light = url.searchParams.get('light')
      if (light === '1' || light === 'true') {
        const meta = await readRunMeta(root, runId)
        if (!meta) throw new RunError(404, 'runId', 'run 不存在')
        sendJson(res, 200, { ok: true, run: lightRunOf(meta) })
        return
      }
      const detail = await readRunDetail(root, runId)
      if (!detail) throw new RunError(404, 'runId', 'run 不存在')
      // 07 §4 / §7：详情带完整 workspace / worktree / sessionMode / supervision
      //（readRunDetail 的 run 已是完整元数据，runstore 白名单已覆盖这四个键）。
      // startOptions 也已进 runstore 白名单（workspace / worktree），这里直接读原文只为
      // 与「发起参数」的原始形状对齐（仅用于展示，权威绑定看 run.json.workspace/worktree）。
      const run = {
        ...detail.run,
        ...runBindingFields(detail.run),
        // B：详情放全量（complete + 至多 50 条缺口）；老 run 缺失按 complete=true。
        tokenCoverage: tokenCoverageOf(detail.run, { full: true }),
        startOptions: await readStartOptions(root, runId),
        // 0.11 · R2/S1：排队是内存派生状态，不写进 run.json；详情动态合并。
        ...(typeof env.engine.admissionOf === 'function' && env.engine.admissionOf(runId)
          ? { admission: env.engine.admissionOf(runId) }
          : {}),
      }
      // G6-b ①：详情带 worktreeStatus（exists / dirty / head）；拿不到就 {unknown:true, reason}。
      const worktreeStatus = await worktreeStatusOf(env, detail.run)
      sendJson(res, 200, {
        ok: true,
        run,
        nodes: detail.nodes,
        eventCount: detail.eventCount,
        worktreeStatus,
      })
      return
    }
    if (req.method === 'DELETE') {
      // 06 §13.3：持有执行租约（正在跑）的 run 不允许删除。
      const lease = await readLease(root, runId)
      if (lease) {
        throw new RunError(
          409,
          'runId',
          `该 run 正被 ${lease.pid}@${lease.host} 持有执行租约，运行中不能删除`,
        )
      }
      // G6-b ④：删除前读 run.json，worktree 指针（path / branch / workspaceId）必须留档，
      // 不能跟着 run 目录一起消失（否则 worktree 目录 / .git/worktrees 记录 / 分支永久失联）。
      // 只有 worktree.enabled === true 才需要留档 / 提示（off / 未创建没有可清理的东西）。
      const meta = await readRunMeta(root, runId).catch(() => null)
      const worktreeRecord = meta && meta.worktree && typeof meta.worktree === 'object'
        && meta.worktree.enabled === true
        ? worktreeRecordOf(meta)
        : null
      const existed = await deleteRun(root, runId)
      if (!existed) throw new RunError(404, 'runId', 'run 不存在')
      summaryCache.delete(runId)
      if (!worktreeRecord) {
        sendJson(res, 200, { ok: true })
        return
      }
      // run 目录已经删掉了，孤儿清单写失败不能把这次删除变成 500（客户端重试只会 404）。
      // 写失败时仍在响应里给出指针，并明确标 orphanPersisted:false 让调用方知道要手工记。
      let orphan = null
      let orphanError = null
      try {
        orphan = await recordOrphanWorktree(root, meta, worktreeRecord)
      } catch (error) {
        orphanError = errorMessage(error)
      }
      sendJson(res, 200, {
        ok: true,
        worktree: {
          path: worktreeRecord.path,
          branch: typeof worktreeRecord.branch === 'string' ? worktreeRecord.branch : null,
          workspaceId: orphan ? orphan.workspaceId : null,
          orphaned: orphan !== null,
          ...(orphan === null ? { orphanPersisted: false } : {}),
        },
        ...(orphanError === null ? {} : { warning: `孤儿清单写入失败：${orphanError}` }),
        hint: `该 run 的 worktree 需要单独清理（DELETE /runs/${runId}/worktree；`
          + 'run 已删除则用 POST /api/flow-studio/worktrees/prune）'
          + `：worktree 目录 ${worktreeRecord.path} 仍保留在磁盘上。`,
      })
      return
    }
    sendJson(res, 405, { ok: false, error: '只支持 GET / DELETE' })
    return
  }

  if (parts.length === 3) {
    const action = parts[2]

    // G6-b ②：DELETE /runs/<id>/worktree —— 单独删这个 run 的 worktree。
    if (action === 'worktree') {
      if (req.method !== 'DELETE') {
        sendJson(res, 405, { ok: false, error: '只支持 DELETE' })
        return
      }
      await deleteRunWorktreeRoute(res, env, url, root, runId)
      return
    }

    if (action === 'events') {
      if (req.method === 'GET') {
        const meta = await readRunMeta(root, runId)
        if (!meta) throw new RunError(404, 'runId', 'run 不存在')
        const nodeId = url.searchParams.get('nodeId')
        const result = await readEvents(root, runId, {
          nodeId: nodeId === null || nodeId === '' ? undefined : nodeId,
          attemptId: parseAttemptId(url.searchParams.get('attemptId')),
          kinds: parseKinds(url),
          since: url.searchParams.get('since') === null ? undefined : url.searchParams.get('since'),
          limit: parseLimit(url.searchParams.get('limit'), 200, 1000),
          order: url.searchParams.get('order') || 'asc',
        })
        if (!result) throw new RunError(404, 'runId', 'run 不存在')
        sendJson(res, 200, {
          ok: true,
          events: result.events,
          total: result.total,
          totalExact: result.totalExact !== false,
          truncated: result.truncated,
        })
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (body === undefined) throw new RunError(400, 'events', '缺少事件内容')
        // run 不存在仍然是 404（与 appendEvents 的读序一致），再判外部通道白名单。
        const meta = await readRunMeta(root, runId)
        if (!meta) throw new RunError(404, 'runId', 'run 不存在')
        // E3-b：外部写入通道只允许纯观测类事件；生命周期事件整批拒绝、一个字都不写，
        // 保证 run 状态机不会被 HTTP 调用方推动（例如追加 run/start 后永久 409）。
        assertExternalEvents(body)
        // R4/S3：生命周期白名单之后，强制盖 external/unverified 章再落盘。
        // 外部 review/verdict、test/report 等只能作为「未验证观察」，不能进入权威聚合。
        const stamped = stampExternalEvents(body)
        const appended = await appendEvents(root, runId, stamped)
        sendJson(res, 200, {
          ok: true,
          accepted: appended.events.length,
          firstSeq: appended.firstSeq,
          lastSeq: appended.lastSeq,
          events: appended.events,
          run: appended.run,
        })
        return
      }
      sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
      return
    }

    if (action === 'messages') {
      // 06 §16：流程收件箱（外部消息入口 + 列表）。
      if (req.method === 'GET') {
        const meta = await readRunMeta(root, runId)
        if (!meta) throw new RunError(404, 'runId', 'run 不存在')
        const limit = parseLimit(url.searchParams.get('limit'), 100, 1000)
        const listed = await readRunMessages(root, runId, { limit })
        if (!listed) throw new RunError(404, 'runId', 'run 不存在')
        sendJson(res, 200, {
          ok: true,
          messages: listed.messages,
          total: listed.total,
          truncated: listed.truncated,
          skipped: listed.skipped,
        })
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        const result = await deliverInboundMessage({
          runsRoot: root,
          flowsRoot: env.dir,
          engine: env.engine,
          ctx: env.ctx,
          log: (level, message) => {
            try {
              if (level === 'warn' && env.ctx && env.ctx.logger && typeof env.ctx.logger.warn === 'function') {
                env.ctx.logger.warn(message)
              }
            } catch {
              // 日志失败不影响投递。
            }
          },
        }, runId, body)
        sendJson(res, 200, result)
        return
      }
      sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
      return
    }

    if (action === 'inbox') {
      // 06 §16：运行中动态配置回复目标（flow_reply 的 run 级默认值）。
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const body = await readBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new RunError(400, 'body', '请求体必须是 JSON 对象')
      }
      const validated = validateReplyTarget(body.reply)
      if (!validated.ok) throw new RunError(400, 'reply', validated.error)
      const meta = await writeRunInbox(root, runId, validated.reply)
      sendJson(res, 200, { ok: true, inbox: meta.inbox })
      return
    }

    if (action === 'restart') {
      // v0.9.2 · 任务 3：失败 / 中止后重启 —— 新建 run、继承旧 run 的完成进度与节点会话。
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      if (!env.engine) throw new RunError(500, 'engine', '执行引擎未初始化')
      if (typeof env.engine.restart !== 'function') {
        throw new RunError(500, 'engine', '执行引擎不支持 restart（运行时未升级）')
      }
      const body = await readBody(req)
      let note
      if (body && typeof body === 'object' && !Array.isArray(body) && body.note !== undefined && body.note !== null) {
        if (typeof body.note !== 'string') throw new RunError(400, 'note', 'note 必须是字符串')
        const trimmed = body.note.trim()
        if (trimmed.length > 500) throw new RunError(400, 'note', 'note 超过 500 字符')
        if (trimmed !== '') note = trimmed
      }
      const result = await env.engine.restart(runId, note === undefined ? {} : { note })
      sendJson(res, 202, {
        ok: true,
        run: result.run,
        restart: result.restart,
        plan: result.plan,
        hint: `已新建续跑 run ${result.run && result.run.id ? result.run.id : ''}；旧 run ${runId} 的终态与事件不会被改写。`,
      })
      return
    }

    if (action === 'start' || action === 'stop') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      if (!env.engine) throw new RunError(500, 'engine', '执行引擎未初始化')
      if (action === 'start') {
        // 07 §4.1：body 可带 {workspace, worktree}；没带就沿用建 run 时记下的发起参数
        //（内存表优先，省一次读盘；run.json.startOptions 已由 runstore 白名单可靠落盘，
        // 进程重启后仍能读回）。G6-c：body 还可带 runTimeoutMs / nodeTimeoutMs（正整数毫秒）。
        const body = await readBody(req)
        const explicit = parseStartOptions(body)
        const limits = parseTimeoutOptions(body)
        const memo = env.startOptions instanceof Map ? env.startOptions.get(runId) : undefined
        if (env.startOptions instanceof Map) env.startOptions.delete(runId)
        let stored = memo && typeof memo === 'object' ? memo : {}
        if (Object.keys(stored).length === 0) {
          try {
            stored = (await readStartOptions(root, runId)) || {}
          } catch {
            stored = {}
          }
        }
        const meta = await readRunMeta(root, runId)
        if (!meta) throw new RunError(404, 'runId', 'run 不存在')
        const boundWorkspace = meta.workspace && typeof meta.workspace === 'object' ? meta.workspace : null
        // E3-a：工作区优先级 = 显式 body > 创建时参数 > run.json 已有绑定。
        // **不补默认值**：非 stub run 若三处都没有，直接 400，绝不回落 process.cwd()。
        const requestedWorkspace = explicit.workspace !== undefined
          ? explicit.workspace
          : (typeof stored.workspace === 'string' && stored.workspace !== ''
            ? stored.workspace
            : (boundWorkspace && typeof boundWorkspace.path === 'string' && boundWorkspace.path !== ''
              ? boundWorkspace.path
              : undefined))
        let workspaceRecord = null
        if (requestedWorkspace !== undefined) {
          workspaceRecord = resolveWorkspaceRecord(requestedWorkspace)
        } else if (!isStubRun(meta, env.engine)) {
          throw workspaceError(
            '缺少 workspace：启动 run 必须给出工作区绝对路径（请求体或创建 run 时传入），不会再回落到服务进程的当前目录',
          )
        }
        const startOptions = {}
        if (workspaceRecord) {
          // 工作区在创建时已经定下：启动时换一个 → 400（与 engine 的「不可中途更换」同口径，
          // 提前在路由层给出可读原因，也避免先把 run.json 覆盖掉再被引擎拦）。
          const boundRealpath = boundWorkspace && typeof boundWorkspace.realpath === 'string' && boundWorkspace.realpath !== ''
            ? boundWorkspace.realpath
            : null
          const boundPath = boundWorkspace && typeof boundWorkspace.path === 'string' && boundWorkspace.path !== ''
            ? boundWorkspace.path
            : null
          const sameBinding = boundRealpath !== null
            ? boundRealpath === workspaceRecord.realpath
            : (boundPath === null || boundPath === workspaceRecord.path)
          if (!sameBinding) {
            throw workspaceError(`run 已绑定工作区（${boundPath || boundRealpath}），不能在启动时更换`)
          }
          startOptions.workspace = workspaceRecord.path
          // E3-a：把工作区持久化进 run.json.workspace（runstore 白名单键，单一写路径）。
          if (!boundWorkspace || boundPath !== workspaceRecord.path) {
            await writeRunMeta(root, runId, { workspace: workspaceRecord })
          }
        }
        const worktree = explicit.worktree !== undefined ? explicit.worktree : stored.worktree
        if (typeof worktree === 'string' && WORKTREE_POLICIES.includes(worktree)) startOptions.worktree = worktree
        // G6-c：可选时限原样透传给 engine.start（引擎负责写 run.json.limits 并按它收超时）。
        if (limits.runTimeoutMs !== undefined) startOptions.runTimeoutMs = limits.runTimeoutMs
        if (limits.nodeTimeoutMs !== undefined) startOptions.nodeTimeoutMs = limits.nodeTimeoutMs
        // 07 §6：executor 的两条规则要在**开跑前**拦住（引擎执行时还会再拦一次）。
        // 存储侧允许保存非法流程（自动保存要能存中间态），但这样的流程不该跑起来。
        const flow = await readFlow(env.dir, meta.flowId)
        const blockers = executorBlockers(flow)
        if (blockers.length > 0) {
          throw new RunError(400, 'executor', `流程里有非法的 executor 配置：${blockers[0].message}`)
        }
        // 0.11 · R5：宿主检查默认关；配置非法 / 开关关闭在资源创建前拒绝。
        const checkBlockers = hostCheckBlockers(flow)
        if (checkBlockers.length > 0) {
          throw new RunError(400, 'check', checkBlockers[0].message, { code: checkBlockers[0].code })
        }
        // G6-a ②：custom executor 需要主机级开关；关着时启动一律 400（与保存同口径）。
        const customGate = customExecutorBlockers(flow)
        if (customGate.length > 0) {
          throw new RunError(400, 'executor', customGate[0].message, { code: 'CUSTOM_EXECUTOR_DISABLED' })
        }
        // 06 §10：返回 202；同一 runId 已在跑 → 409（由 runtime 抛 EngineError）。
        // 引擎自己也会校验工作区并 400，这里不拦截、不改写引擎的错误码/文案。
        const run = await env.engine.start(runId, startOptions)
        sendJson(res, 202, { ok: true, run })
        return
      }
      const run = await env.engine.stop(runId)
      sendJson(res, 200, { ok: true, run })
      return
    }

    if (action === 'supervision') {
      // 07 §7：入口之一是 HTTP（另一个是 flow_supervise 模型工具）；客户端只读展示。
      if (req.method === 'GET') {
        const meta = await readRunMeta(root, runId)
        if (!meta) throw new RunError(404, 'runId', 'run 不存在')
        const scheduler = env.engine && env.engine.supervision
        sendJson(res, 200, {
          ok: true,
          runId,
          supervision: runSupervisionOf(meta),
          scheduler: scheduler && typeof scheduler.status === 'function' ? scheduler.status(runId) : null,
        })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
        return
      }
      const body = await readBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new RunError(400, 'body', '请求体必须是 JSON 对象')
      }
      if (typeof body.enabled !== 'boolean') {
        throw new RunError(400, 'enabled', 'enabled 必须是布尔值')
      }
      let wakerSessionId
      if (body.wakerSessionId !== undefined && body.wakerSessionId !== null) {
        if (typeof body.wakerSessionId !== 'string' || body.wakerSessionId.trim() === '') {
          throw new RunError(400, 'wakerSessionId', 'wakerSessionId 必须是非空字符串（会话 id）')
        }
        wakerSessionId = body.wakerSessionId.trim()
      }
      const meta = await readRunMeta(root, runId)
      if (!meta) throw new RunError(404, 'runId', 'run 不存在')
      const scheduler = env.engine && env.engine.supervision
      if (!scheduler || typeof scheduler.register !== 'function') {
        throw new RunError(500, 'supervision', '内建 supervision 调度未初始化')
      }
      if (body.enabled && TERMINAL_RUN_STATUSES.has(meta.status)) {
        // 已收尾的 run 登记进去也永远不会被唤醒（planWake 的 terminal 分支），直接拒绝。
        throw new RunError(
          400,
          'enabled',
          `run 已结束（${meta.status}），不能开启 supervision；要定时自审请对运行中的 run 开启`,
        )
      }
      // 与 flow_start / flow_supervise 共用同一条实现（runtime.enableSupervision）：
      // 登记 + 落盘只有一份逻辑，避免两边漂移。注入的假引擎没有它时退回本地实现（测试用）。
      let result
      if (typeof env.engine.enableSupervision === 'function') {
        result = await env.engine.enableSupervision(runId, {
          enabled: body.enabled,
          ...(wakerSessionId === undefined ? {} : { wakerSessionId }),
        })
      } else {
        let saved
        if (body.enabled) {
          scheduler.register(runId, wakerSessionId === undefined ? {} : { wakerSessionId })
          saved = await saveSupervision(root, runId, {
            enabled: true,
            ...(wakerSessionId === undefined ? {} : { wakerSessionId }),
            reason: null,
            failures: 0,
          })
        } else {
          scheduler.unregister(runId)
          saved = await saveSupervision(root, runId, { enabled: false, reason: 'disabled-by-caller' })
        }
        result = {
          runId,
          enabled: body.enabled,
          supervision: saved,
          scheduler: typeof scheduler.status === 'function' ? scheduler.status(runId) : null,
        }
      }
      sendJson(res, 200, {
        ok: true,
        runId,
        enabled: body.enabled,
        supervision: result.supervision,
        scheduler: result.scheduler,
      })
      return
    }

    if (action === 'summary') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '只支持 GET' })
        return
      }
      const meta = await readRunMeta(root, runId)
      if (!meta) throw new RunError(404, 'runId', 'run 不存在')
      // 07 §4 / §7：summary 也要能读到 workspace / worktree / supervision（与列表 / 详情同口径）。
      const extrasPayload = { ...runWorkspaceFields(meta), ...runBindingFields(meta) }
      // 06 §13.7 增量缓存 + 0.11 R5（返工）宿主证据指纹：报告副本被删除 / 损坏后
      // 事件 seq 不会变，缓存必须失效，不能继续返回旧的权威结论。
      const all = await readAllEvents(root, runId)
      const events = all ? all.events : []
      const hostExecutions = await readHostExecutions(root, runId)
      const hostDigest = hostEvidenceDigest(runId, hostExecutions, events, join(root, runId))
      const cached = summaryCache.get(runId)
      if (cached && cached.lastSeq === meta.lastSeq
        && cached.eventCount === meta.eventCount && cached.engine === meta.engine
        && cached.hostDigest === hostDigest) {
        sendJson(res, 200, {
          ok: true,
          cached: true,
          summary: { ...cached.summary, computedAt: new Date().toISOString() },
          ...extrasPayload,
        })
        return
      }
      const summary = summarize(events, {
        engine: meta.engine === 'stub' ? 'stub' : undefined,
        lastSeq: meta.lastSeq,
        verifyEvidence: makeEvidenceVerifier(join(root, runId)),
        verifyHostExecution: makeHostExecutionVerifier(runId, hostExecutions, events, join(root, runId)),
      })
      summaryCache.set(runId, {
        lastSeq: meta.lastSeq,
        eventCount: meta.eventCount,
        engine: meta.engine,
        hostDigest,
        summary,
      })
      sendJson(res, 200, { ok: true, cached: false, summary, ...extrasPayload })
      return
    }

    if (action === 'export') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '只支持 GET' })
        return
      }
      const meta = await readRunMeta(root, runId)
      if (!meta) throw new RunError(404, 'runId', 'run 不存在')
      const all = await readAllEvents(root, runId)
      const events = all ? all.events : []
      const hostExecutions = await readHostExecutions(root, runId)
      const summary = summarize(events, {
        engine: meta.engine === 'stub' ? 'stub' : undefined,
        lastSeq: meta.lastSeq,
        verifyEvidence: makeEvidenceVerifier(join(root, runId)),
        verifyHostExecution: makeHostExecutionVerifier(runId, hostExecutions, events, join(root, runId)),
      })
      const markdown = renderRunMarkdown(meta, events, summary)
      const body = Buffer.from(markdown, 'utf8')
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${runId}.md"`,
        'cache-control': 'no-store',
        'content-length': body.length,
      })
      res.end(body)
      return
    }
  }

  sendJson(res, 404, { ok: false, error: '未知接口' })
}

/**
 * 读当前组合里的 skill 目录，供节点的「引用 skills」使用。
 * skills 服务是可选依赖：profile 没挂就返回空表，面板照常可用。
 */
async function listSkills(ctx) {
  const skills = ctx.get ? ctx.get('skills') : undefined
  if (!skills || typeof skills.list !== 'function') return []
  try {
    const entries = await skills.list()
    if (!Array.isArray(entries)) return []
    return entries
      .filter(entry => entry && typeof entry.name === 'string')
      .map(entry => ({
        name: entry.name,
        description: typeof entry.description === 'string' ? entry.description : '',
        whenToUse: typeof entry.whenToUse === 'string' ? entry.whenToUse : '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/**
 * 插件入口。
 * @param {any} ctx Cordis 上下文
 */
export function apply(ctx) {
  const dir = flowsDir()
  const runsRoot = runsDir()
  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (!logger) return
      const fn = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info
      if (typeof fn === 'function') fn.call(logger, message)
    } catch {
      // 日志失败不该影响引擎。
    }
  }

  // 06 §13.1 / G6-a：两档令牌（全权 + 只读）任一配了但不足 16 字符 → 启动即拒绝并告警。
  const authInfo = inspectAuth()
  for (const bad of authInfo.misconfigured) {
    log('warn', `flow-studio: ${bad.env} 只有 ${bad.length} 个字符，要求 ≥${TOKEN_MIN_LENGTH}；拒绝启动`)
    throw new Error(`${bad.env} 必须至少 ${TOKEN_MIN_LENGTH} 个字符（当前 ${bad.length}），flow-studio 拒绝启动`)
  }
  if (authInfo.full.valid && authInfo.read.valid && authInfo.full.token === authInfo.read.token) {
    log(
      'warn',
      `flow-studio: ${READ_AUTH_ENV} 与 ${AUTH_ENV} 相同，只读令牌实际拥有全权；请给只读用途换一个不同的令牌`,
    )
  }
  // G6-a ②：custom executor 是宿主 RCE 面，默认关；开启时明确告警（运维应知道后果）。
  if (customExecutorAllowed()) {
    log(
      'warn',
      `flow-studio: ${CUSTOM_EXECUTOR_ENV}=1 —— 持有全权令牌的调用方可以写任意 executorCommand`
        + '（等价宿主 RCE）；请确认这是有意的，并给调用方发只读 / 受限令牌',
    )
  }
  // G6-a ③：workspace 白名单（可选）。写错的条目忽略并告警，不把整份配置当「未配置」。
  const workspaceRoots = parseWorkspaceRoots()
  if (workspaceRoots.invalid.length > 0) {
    log(
      'warn',
      `flow-studio: ${WORKSPACE_ROOTS_ENV} 里这些条目不是绝对路径，已忽略：${workspaceRoots.invalid.join('、')}`,
    )
  }
  if (workspaceRoots.roots.length > 0) {
    log('info', `flow-studio: workspace 白名单已启用（${workspaceRoots.roots.length} 个根）`)
  }

  // 06 §13.8：stub 引擎必须同时开 TESTBED，否则忽略并告警。
  const stubInfo = resolveStubMode()
  if (stubInfo.requested && !stubInfo.testbed) {
    log('warn', 'flow-studio: 检测到 FLOW_STUDIO_STUB_ENGINE=1，但未设置 FLOW_STUDIO_TESTBED=1；已忽略桩引擎，按 real 运行')
  }

  // 07 §5：进程级运行时 = 一 run 一 Engine 实例（并发不设上限，同 runId 才 409）+ §7 内建
  // supervision 调度（`engine.supervision`，唯一一个 setInterval，已 .unref()）。
  // index/tools 仍把它当「单引擎」用：`engineName` / `resolveSessionOwner` / `runForSession` /
  // `sweepStaleRuns` 由 runtime 门面提供，`active` 已不再需要。
  const engine = createRuntime({
    ctx,
    runsRoot,
    flowsRoot: dir,
    // 显式传 stub 判定，避免引擎侧自己只看 FLOW_STUDIO_STUB_ENGINE 就启用桩。
    stub: stubInfo.stub,
    log,
    // 0.11 · R2/S1：生产启动入口统一走 runtime 准入（全局 + 每工作区配额 + 有限 FIFO）。
    // 上限来自 FLOW_STUDIO_MAX_CONCURRENT_RUNS / _PER_WORKSPACE / RUN_QUEUE_MAX /
    // RUN_QUEUE_TIMEOUT_MS；不传空对象以外的值，避免这里成为第二份配额定义。
    admissionLimits: {},
  })
  // 07 §4.1：建 run → start 之间的发起参数交接（见 rememberStartOptions 的说明）。
  const startOptions = new Map()
  // 插件卸载 / 测试收尾：停调度定时器、释放所有实例（不删 run.json / 会话）。
  // E3-c：卸载清理只依赖运行时的稳定门面 `dispose()`，不碰 Engine / 调度器内部结构。
  // dispose() 可能是同步的，也可能在「卸载 abort」实现里返回 Promise（等待活跃引擎收尾）；
  // 两种情况都把返回值交给 ctx.effect，让宿主能在卸载时 await。
  ctx.effect(() => () => {
    try {
      const result = engine.dispose()
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).catch(() => {
          // 释放失败不该影响卸载。
        })
      }
      return result
    } catch {
      // 释放失败不该影响卸载。
    }
  }, 'flow-studio: 运行时与 supervision 调度')
  // 06 §9 / §13.3 / §13.4：启动时先修 run.json 与 run.jsonl 的终态不一致，
  // 再清理崩溃残留的 running run（含过期租约），不自动续跑。
  repairRunStates(runsRoot)
    .then(repaired => {
      if (repaired.length > 0) log('warn', `flow-studio: 启动修复 ${repaired.length} 个非终态 run：${repaired.join(', ')}`)
    })
    .then(() => engine.sweepStaleRuns())
    .then(swept => {
      if (swept.length > 0) log('warn', `flow-studio: 清理 ${swept.length} 个残留 run：${swept.join(', ')}`)
    })
    .then(() => sweepExpiredLeases(runsRoot))
    .then(recovered => {
      if (recovered.length > 0) log('warn', `flow-studio: 清理过期租约并标记 failed：${recovered.join(', ')}`)
    })
    .catch(error => {
      log('warn', `flow-studio: 清理残留 run / 租约失败：${error.message}`)
    })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: createHandler({ dir, runsRoot, ctx, engine, startOptions }),
  }), 'flow-studio: /api/flow-studio')

  // 06 §15：模型工具（会话内启停 + 定时自审）。
  // tools 服务是**可选**依赖：旧 profile / 测试环境里拿不到就只跳过注册，
  // 面板与 /api 路由照常可用——不能因为缺少工具注册表让插件装不上。
  const toolsSvc = (typeof ctx.get === 'function' && ctx.get('tools')) || ctx.tools
  if (toolsSvc && typeof toolsSvc.register === 'function') {
    const tools = createFlowTools({ flowsRoot: dir, runsRoot, engine, ctx, log })
    ctx.effect(() => {
      const disposers = tools.map(tool => toolsSvc.register(tool))
      return () => disposers.reverse().forEach(dispose => dispose())
    }, 'flow-studio: 注册模型工具')
  } else {
    log('info', 'flow-studio: 未找到 tools 服务，跳过模型工具注册（面板与 /api 路由照常可用）')
  }
}
