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
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { deliverInboundMessage, validateReplyTarget } from './inbox.js'
import { normalizeExecutor } from './executor.js'
import { NODE_KIND, validateFlow } from './model.js'
import { checkRunId, isSafeRelPath, renderRunMarkdown, summarize } from './runlog.js'
import { createRuntime, patchRunJson, readStartOptions, saveSupervision } from './runtime.js'
import { createFlowTools } from './tools.js'
import {
  RunError, appendEvents, createRun, deleteRun, listRuns, readAllEvents, readEvents,
  readLease, readRunDetail, readRunMessages, readRunMeta, repairRunStates, runsDir,
  sweepExpiredLeases, writeRunInbox,
} from './runstore.js'
import {
  FlowConflictError, checkId, deleteFlow, flowsDir, listFlows, newFlowId, readFlow, saveFlow,
} from './store.js'

/** 硬依赖：没有 webServer 就没有面板的数据通道。 */
export const inject = ['webServer']

export const name = 'flow-studio'

/** 可选加固（§8.5）：设置该环境变量后所有 /api/flow-studio/* 都要求 token。 */
export const AUTH_ENV = 'FLOW_STUDIO_TOKEN'

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

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
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

/** §13.1：配置了 token 就返回 {present, valid, token}；没配置视为未启用。 */
function inspectToken(env = process.env) {
  const raw = env[AUTH_ENV]
  if (typeof raw !== 'string') return { present: false, valid: false, token: null }
  const token = raw.trim()
  if (token === '') return { present: false, valid: false, token: null }
  return { present: true, valid: token.length >= TOKEN_MIN_LENGTH, token }
}

/** 兼容导出：返回当前生效的 token；未配置或配置过短（fail-closed）返回 null。 */
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

/** 返回 true 表示放行。token 档位只认 Authorization: Bearer（export 另允许 ?token=）。 */
function authorize(req, url, options = {}) {
  const inspected = inspectToken()
  if (!inspected.present) return true
  // 配置了但不足 16 字符：不悄悄退回同源，直接拒绝（启动时也会拒绝注册）。
  if (!inspected.valid) return false
  return tokenMatches(inspected.token, requestToken(req, url, options))
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
 * 为什么还要内存这一份：`run.json.startOptions` 在 runstore 白名单之外，创建之后只要
 * 有人写 runstore（开 supervision、投消息、engine.start 的 startRun 迁移……）就会被
 * normalizeMeta 顺手丢掉。RAW 落盘仍然写（满足「创建时保存发起参数」这条契约，也覆盖
 * 「进程重启后还能读」的场景），但**同进程的主路径是这张表**，不受其它写入影响。
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
      throw new RunError(400, 'workspace', 'workspace 必须是非空字符串（工作区路径）')
    }
    const workspace = body.workspace.trim()
    if (!isAbsolute(workspace)) throw new RunError(400, 'workspace', 'workspace 必须是绝对路径')
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
 * 07 §6 的两条 executor 规则（custom 必须填 `executorCommand`；外部 executor 只能 single）
 * 目前**不在** `engine.validateFlowForRun()` 里——那是独立的结构校验器，executor 只在
 * 节点执行时由 `normalizeExecutor` 拦住（节点会失败）。为了「开跑前」就报 400，Host 侧的
 * start 路径在这里按同一份规则预检一次（engine 执行时再拦属于双保险）。
 *
 * @returns {Array<{ nodeId: string, message: string }>}
 */
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

/** 07 §4 / §7：一个 run 的四个绑定字段（列表行 / 详情 / summary 同一口径）。 */
function runBindingFields(meta) {
  return {
    workspace: meta && meta.workspace ? meta.workspace : null,
    worktree: meta && meta.worktree ? meta.worktree : null,
    sessionMode: meta && typeof meta.sessionMode === 'string' ? meta.sessionMode : null,
    supervision: runSupervisionOf(meta),
  }
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
      sendJson(res, error.status, error.toPayload())
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
  const authed = authorize(req, url, { allowQueryToken: isExportRoute })
  if (!authed) {
    sendJson(res, 401, { ok: false, error: '未授权：需要 Authorization: Bearer <token>' })
    return
  }

  // GET /api/flow-studio/health
  if (parts.length === 1 && parts[0] === 'health') {
    // 06 §13.1：目录只在「已通过鉴权」或「回环请求」时返回，避免把宿主路径泄露给 LAN。
    const exposePaths = authed || isLoopbackRequest(req)
    sendJson(res, 200, {
      ok: true,
      ...(exposePaths ? { dir: env.dir, runsDir: env.runsRoot } : {}),
      // §8.5：运维一眼看出当前鉴权档位。
      auth: inspectToken().valid ? 'token' : 'connection',
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

  // /api/flow-studio/runs[/<runId>[/events|summary|export]]
  if (parts[0] === 'runs') {
    await handleRuns(req, res, env, url, parts)
    return
  }

  // /api/flow-studio/flows[/<id>]
  if (parts[0] === 'flows') {
    const id = parts[1]

    if (parts.length === 1) {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, flows: await listFlows(env.dir) })
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        // 只有形状垃圾才 400；validation.errors 不拦保存（空流程/半成品都能存，见 rejectMalformedFlowBody）。
        if (rejectMalformedFlowBody(res, body)) return
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
        rows.push({ ...row, ...fields, ...runBindingFields(meta) })
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
      const nodeTotal = flow.nodes.filter(node => node.kind === NODE_KIND.STAGE).length
      const run = await createRun(root, {
        flowId: flow.id,
        flowName: flow.name,
        name: name || flow.name,
        nodeTotal,
        // 06 §13.8：run.json.engine 从建 run 那一刻就带上，列表 / 聚合都读得到。
        engine: env.engine && env.engine.engineName === 'stub' ? 'stub' : 'real',
      })
      if (Object.keys(startOptions).length > 0) {
        // 同进程主路径：内存表（不受后续 runstore 写入影响）。
        rememberStartOptions(env.startOptions, run.id, startOptions)
        // 持久化兜底：startOptions 不在 runstore 白名单里，只能 raw 合并（写失败不阻塞建 run）。
        try {
          await patchRunJson(root, run.id, { startOptions })
        } catch (error) {
          if (env.ctx && env.ctx.logger && typeof env.ctx.logger.warn === 'function') {
            env.ctx.logger.warn(`flow-studio: 记录 run ${run.id} 的启动参数失败：${error.message}`)
          }
        }
      }
      sendJson(res, 200, {
        ok: true,
        run: Object.keys(startOptions).length > 0 ? { ...run, startOptions } : run,
      })
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
      const detail = await readRunDetail(root, runId)
      if (!detail) throw new RunError(404, 'runId', 'run 不存在')
      // 07 §4 / §7：详情带完整 workspace / worktree / sessionMode / supervision
      //（readRunDetail 的 run 已是完整元数据，runstore 白名单已覆盖这四个键）。
      // startOptions 不在白名单里，只能读原文（仅用于展示发起参数）。
      const run = {
        ...detail.run,
        ...runBindingFields(detail.run),
        startOptions: await readStartOptions(root, runId),
      }
      sendJson(res, 200, { ok: true, run, nodes: detail.nodes, eventCount: detail.eventCount })
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
      const existed = await deleteRun(root, runId)
      if (!existed) throw new RunError(404, 'runId', 'run 不存在')
      summaryCache.delete(runId)
      sendJson(res, 200, { ok: true })
      return
    }
    sendJson(res, 405, { ok: false, error: '只支持 GET / DELETE' })
    return
  }

  if (parts.length === 3) {
    const action = parts[2]

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
        const appended = await appendEvents(root, runId, body)
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

    if (action === 'start' || action === 'stop') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      if (!env.engine) throw new RunError(500, 'engine', '执行引擎未初始化')
      if (action === 'start') {
        // 07 §4.1：body 可带 {workspace, worktree}；没带就沿用建 run 时记下的发起参数
        //（内存表优先——它不受创建之后任何一次 runstore 写入影响；raw 落盘只作重启兜底）。
        const explicit = parseStartOptions(await readBody(req))
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
        const startOptions = {}
        const workspace = explicit.workspace !== undefined ? explicit.workspace : stored.workspace
        const worktree = explicit.worktree !== undefined ? explicit.worktree : stored.worktree
        if (typeof workspace === 'string' && workspace !== '') startOptions.workspace = workspace
        if (typeof worktree === 'string' && WORKTREE_POLICIES.includes(worktree)) startOptions.worktree = worktree
        // 07 §6：executor 的两条规则要在**开跑前**拦住（引擎执行时还会再拦一次）。
        // 存储侧允许保存非法流程（自动保存要能存中间态），但这样的流程不该跑起来。
        const meta = await readRunMeta(root, runId)
        if (meta) {
          const flow = await readFlow(env.dir, meta.flowId)
          const blockers = executorBlockers(flow)
          if (blockers.length > 0) {
            throw new RunError(400, 'executor', `流程里有非法的 executor 配置：${blockers[0].message}`)
          }
        }
        // 06 §10：返回 202；同一 runId 已在跑 → 409（由 runtime 抛 EngineError）。
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
      // 06 §13.7 增量缓存：lastSeq / eventCount / engine 都没变就复用上一次聚合结果。
      const cached = summaryCache.get(runId)
      if (cached && cached.lastSeq === meta.lastSeq
        && cached.eventCount === meta.eventCount && cached.engine === meta.engine) {
        sendJson(res, 200, {
          ok: true,
          cached: true,
          summary: { ...cached.summary, computedAt: new Date().toISOString() },
          ...extrasPayload,
        })
        return
      }
      const all = await readAllEvents(root, runId)
      const events = all ? all.events : []
      const summary = summarize(events, {
        engine: meta.engine === 'stub' ? 'stub' : undefined,
        lastSeq: meta.lastSeq,
        verifyEvidence: makeEvidenceVerifier(join(root, runId)),
      })
      summaryCache.set(runId, {
        lastSeq: meta.lastSeq,
        eventCount: meta.eventCount,
        engine: meta.engine,
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
      const summary = summarize(events, {
        engine: meta.engine === 'stub' ? 'stub' : undefined,
        lastSeq: meta.lastSeq,
        verifyEvidence: makeEvidenceVerifier(join(root, runId)),
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

  // 06 §13.1：TOKEN 配了但不足 16 字符 → 启动即拒绝并告警（不悄悄退回低档位）。
  const tokenInfo = inspectToken()
  if (tokenInfo.present && !tokenInfo.valid) {
    log('warn', `flow-studio: ${AUTH_ENV} 只有 ${tokenInfo.token.length} 个字符，要求 ≥${TOKEN_MIN_LENGTH}；拒绝启动`)
    throw new Error(`${AUTH_ENV} 必须至少 ${TOKEN_MIN_LENGTH} 个字符（当前 ${tokenInfo.token.length}），flow-studio 拒绝启动`)
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
  })
  // 07 §4.1：建 run → start 之间的发起参数交接（见 rememberStartOptions 的说明）。
  const startOptions = new Map()
  // 插件卸载 / 测试收尾：停调度定时器、释放所有实例（不删 run.json / 会话）。
  ctx.effect(() => () => {
    try {
      engine.dispose()
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
