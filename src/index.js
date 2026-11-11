/**
 * Host 半边：BPMN 定义域与实例域的数据入口（0.14.0 起是**唯一**运行域）。
 *
 * 浏览器端（client bundle）通过同源 fetch 调用 `/api/flow-studio/*`；
 * 面板本身不做任何持久化，所有定义与实例都落在 `$DSH_HOME/flow-studio` 下。
 *
 * 路由是 `prefix` 注册的一条：webserver 对插件路由不做自动鉴权
 * （内置 `/api` 的 connection.admit 只挂在通用 `/api` 前缀上，最长前缀会把请求先接走），
 * 所以这里自己挡跨站请求：带了 Origin 且与 Host 不一致就 403。
 *
 * routes：
 *   GET  /api/flow-studio/health
 *   GET  /api/flow-studio/skills
 *   *    /api/flow-studio/definitions[/<id>]
 *   *    /api/flow-studio/instances[/<id>/...]
 *   *    /api/flow-studio/instance-worktrees
 *   *    /api/flow-studio/metrics
 *
 * 旧 `/flows`、`/runs`、`/worktrees` 与 `/worktrees/prune` 已在 0.14.0 删除；
 * 已认证请求访问它们返回 404（不做兼容跳转）。
 *
 * @module @feiyueve/dsh-flow-studio
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createAdapterRegistry } from './agent-adapter.js'
import { createClaudeAdapter } from './agent-adapter-claude.js'
import { createCodexAdapter } from './agent-adapter-codex.js'
import { createDshAdapter } from './agent-adapter-dsh.js'
import { createBpmnRuntime } from './bpmn-runtime.js'
import { createInstanceTools } from './instance-tools.js'
import { flowStudioDir } from './storage-contract.js'
import { WORKSPACE_ALLOWLIST_ENV, parseAllowlistConfig } from './workspace-policy.js'

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

/** 插件版本，用于 GET /health（§8.5）。 */
export const PLUGIN_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 单个请求体的硬上限：2 MiB（实例启动参数 / 定义 XML 都装得下）。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** 面板路由前缀。 */
const BASE = '/api/flow-studio'

/**
 * AgentAdapter 注册表（0.13.1 A3）：`dsh` 用宿主 agents 服务注册会话级工具；
 * `codex` / `claude` 用自带 MCP stdio server（CLI 没装 / 未登录时 probe 会失败，但
 * **不能**因此让插件加载失败——不可用只在节点 admission 阶段拒绝那个节点）。
 *
 * 用环境变量 / 外部注入覆盖时以 `env.bpmnAdapters` 为准（测试与嵌入方使用）。
 */
function buildAgentAdapters(ctx, log, adapterTmpRoot) {
  const registry = createAdapterRegistry()
  const factories = [
    ['dsh', () => createDshAdapter({ ctx, log })],
    ['codex', () => createCodexAdapter({
      // 适配器默认把每-execution 私有目录放插件包内的 `.tmp/`；装到只读 profile 时
      // 会失败。这里显式指向 flow-studio 数据根（instances/ 的兄弟目录，必然可写）。
      ...(typeof adapterTmpRoot === 'string' && adapterTmpRoot.trim() !== '' ? { tmpRoot: adapterTmpRoot } : {}),
    })],
    // 0.14.2 G：Claude Code 适配器。真实 CLI 通道未在本机验收（无 claude CLI）；
    // probe 不通过时该 adapter 在 admission 阶段被拒绝，不影响其它 adapter 与面板。
    ['claude', () => createClaudeAdapter({
      ...(typeof adapterTmpRoot === 'string' && adapterTmpRoot.trim() !== '' ? { tmpRoot: adapterTmpRoot } : {}),
    })],
  ]
  for (const [id, factory] of factories) {
    try {
      registry.register(factory())
    } catch (error) {
      // 单个适配器注册失败不能拖垮插件加载：其它 adapter / 面板 / /api 照常可用。
      log('warn', `flow-studio: agent adapter「${id}」注册失败（该 adapter 的节点会被拒绝）：${error?.message ?? error}`)
    }
  }
  return registry
}

/**
 * BPMN 运行时按 createHandler 的 env 懒建（同一 env 复用，不同测试 / profile 隔离）。
 * 创建后由 runtime 自己管 definitions/ 与 instances/。
 */
const bpmnRuntimes = new WeakMap()

function bpmnRuntimeFor(env) {
  let runtime = bpmnRuntimes.get(env)
  if (runtime === undefined) {
    runtime = createBpmnRuntime({
      ctx: env.ctx,
      dir: env.dir,
      env: process.env,
      // A3：agent 节点只走 AgentAdapter + flow_finish_node；没有注册表时明确失败。
      ...(env.bpmnAdapters && typeof env.bpmnAdapters.get === 'function' ? { adapters: env.bpmnAdapters } : {}),
      ...(typeof env.bpmnWorkspaceRoot === 'string' && env.bpmnWorkspaceRoot.trim() !== ''
        ? { workspaceRoot: env.bpmnWorkspaceRoot }
        : {}),
      // HTTP connector 的目标策略：宿主可注入精确的 http 测试台 / 内网 host:port 例外。
      ...(env.bpmnHttpPolicy && typeof env.bpmnHttpPolicy === 'object' ? { httpPolicy: env.bpmnHttpPolicy } : {}),
      ...(env.bpmnHttpPolicies && typeof env.bpmnHttpPolicies === 'object' ? { httpPolicies: env.bpmnHttpPolicies } : {}),
      ...(typeof env.bpmnHttpAuthResolver === 'function' ? { httpAuthResolver: env.bpmnHttpAuthResolver } : {}),
      // 0.13.10：实例收件箱回复目标只认宿主维护的 ID（嵌入方 / 测试台注入）。
      ...(env.bpmnInboxReplyTargets && typeof env.bpmnInboxReplyTargets === 'object'
        ? { inboxReplyTargets: env.bpmnInboxReplyTargets }
        : {}),
      ...(typeof env.bpmnInboxSessionDeliver === 'function' ? { inboxSessionDeliver: env.bpmnInboxSessionDeliver } : {}),
      ...(typeof env.bpmnInboxHttpRequest === 'function' ? { inboxHttpRequest: env.bpmnInboxHttpRequest } : {}),
    })
    bpmnRuntimes.set(env, runtime)
  }
  return runtime
}

/** `/health` 里的 adapter 能力：只报注册表里真实存在的 id。 */
function adapterIdsOf(env) {
  const registry = env && env.bpmnAdapters
  if (!registry || typeof registry.list !== 'function') return []
  try {
    return registry.list()
      .map(adapter => (adapter && typeof adapter.id === 'string' ? adapter.id : ''))
      .filter(id => id !== '')
      .sort()
  } catch {
    return []
  }
}

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

function requestToken(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
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
 * token 档位只认 Authorization: Bearer。
 */
function authorizeRequest(req) {
  const inspected = inspectAuth()
  if (!inspected.present) return { ok: true, mode: 'connection', readOnly: false }
  // 配置了但不足 16 字符：不悄悄退回同源，直接拒绝（启动时也会拒绝注册）。
  if (inspected.misconfigured.length > 0) return { ok: false, mode: 'none', readOnly: false }
  const provided = requestToken(req)
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

/**
 * 原始 URL 的路径段防线。WHATWG URL 会把 `..` / `%2e%2e` 规范化掉，
 * 规范化之后再看就分不清「用户想穿越」还是「本来就没有这个接口」，
 * 所以先在原始 req.url 上挡一道，统一回 400。
 */
function assertSafeRawPath(req) {
  const rawPath = (req.url || '').split('?')[0]
  if (rawPath.includes('//')) {
    const error = new Error('路径不合法（出现空路径段）')
    error.status = 400
    throw error
  }
  for (const piece of rawPath.split('/')) {
    let decoded
    try {
      decoded = decodeURIComponent(piece)
    } catch {
      const error = new Error('路径编码不合法')
      error.status = 400
      throw error
    }
    if (decoded === '.' || decoded === '..') {
      const error = new Error('路径不合法（禁止 . / .. 段）')
      error.status = 400
      throw error
    }
  }
}

/**
 * 路由分发。所有错误都在这里收口，不让异常逃出请求处理器。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ dir: string, ctx: any }} env
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
    if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
      sendJson(res, error.status, { ok: false, error: error.message })
      return
    }
    sendInternalError(res, env, error)
  }
}

/**
 * 把插件路由绑成一个 HTTP 处理器（`env` 里带 dir / ctx / 可选的 adapter 注册表）。
 *
 * 单独导出是为了让测试能用最小 env 直接喂 req/res，不必启动 dsh。
 *
 * @param {{ dir: string, ctx: any }} env
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
  // 06 §13.1：token 档位只认 Authorization: Bearer。
  const authz = authorizeRequest(req)
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
    const runtime = bpmnRuntimeFor(env)
    // 06 §13.1：目录只在「已通过鉴权」或「回环请求」时返回，避免把宿主路径泄露给 LAN。
    const exposePaths = authz.ok || isLoopbackRequest(req)
    const authState = inspectAuth()
    const bpmnHealth = await runtime.health()
    const allowlist = Array.isArray(runtime.workspaceAllowlist) ? runtime.workspaceAllowlist : null
    sendJson(res, 200, {
      ok: true,
      ...(exposePaths ? { dir: env.dir } : {}),
      // §8.5：运维一眼看出当前鉴权档位（字段保持字符串，便于兼容旧客户端）。
      auth: authState.present ? 'token' : 'connection',
      // G6-a ④：让调用方知道自己的令牌能干什么（per-request）。
      authMode: authz.mode,
      readOnly: authz.readOnly,
      capabilities: {
        mode: authz.mode,
        readOnly: authz.readOnly,
        write: !authz.readOnly,
        workspaceAllowlist: {
          configured: allowlist !== null,
          count: allowlist === null ? 0 : allowlist.length,
        },
      },
      version: PLUGIN_VERSION,
      schemaVersion: 1,
      // 0.14.0：实例域是唯一运行域；能力计数由 runtime 现算。
      bpmn: bpmnHealth,
      adapters: adapterIdsOf(env),
      skills: Boolean(env.ctx && env.ctx.get && env.ctx.get('skills')),
    })
    return
  }

  // 0.13：BPMN 定义域 / 实例域（唯一运行域）。
  // 鉴权 / 只读令牌 / 同源校验已在 route() 开头统一完成，这里只做分发。
  if (parts[0] === 'definitions' || parts[0] === 'instances' || parts[0] === 'instance-worktrees' || parts[0] === 'metrics') {
    const runtime = bpmnRuntimeFor(env)
    const body = req.method === 'GET' ? undefined : await readBody(req)
    const result = await runtime.handle({
      method: req.method,
      parts,
      url,
      body,
    })
    sendJson(res, result.status, result.body)
    return
  }

  // GET /api/flow-studio/skills — 供节点「引用 skills」下拉使用
  if (parts.length === 1 && parts[0] === 'skills') {
    const skills = await listSkills(env.ctx)
    sendJson(res, 200, { ok: true, skills })
    return
  }

  // 旧 /flows、/runs、/worktrees 已退役：已认证请求一律 404，不做兼容跳转。
  sendJson(res, 404, { ok: false, error: '未知接口' })
}

/**
 * 读当前组合里的 skill 目录，供节点的「引用 skills」使用。
 * skills 服务是可选依赖：profile 没挂就返回空表，面板照常可用。
 */
async function listSkills(ctx) {
  const skills = ctx && ctx.get ? ctx.get('skills') : undefined
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
  const dir = flowStudioDir()
  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (!logger) return
      const fn = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info
      if (typeof fn === 'function') fn.call(logger, message)
    } catch {
      // 日志失败不该影响运行时。
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
  // G6-a ③：workspace 白名单（可选）。写错的条目忽略并告警，不把整份配置当「未配置」。
  try {
    const workspaceRoots = parseAllowlistConfig(process.env[WORKSPACE_ALLOWLIST_ENV])
    if (workspaceRoots.invalid.length > 0) {
      log(
        'warn',
        `flow-studio: ${WORKSPACE_ALLOWLIST_ENV} 里这些条目不是绝对路径，已忽略：${workspaceRoots.invalid.join('、')}`,
      )
    }
    if (workspaceRoots.roots.length > 0) {
      log('info', `flow-studio: workspace 白名单已启用（${workspaceRoots.roots.length} 个根）`)
    }
  } catch (error) {
    log('warn', `flow-studio: ${WORKSPACE_ALLOWLIST_ENV} 配置非法：${error?.message ?? error}`)
  }

  // 0.14.0：HTTP 路由与模型工具共用同一个 env —— `bpmnRuntimeFor` 按 env 缓存 runtime，
  // 这样 flow_instance_worktrees 的 prune 预览与 HTTP 执行共享同一份 planHash 缓存。
  const bpmnEnv = {
    dir,
    ctx,
    // 0.13.1 A3 / 0.14.2 G：agent 节点由 AgentAdapter 执行（dsh / codex / claude）；
    // 某个 CLI 不可用不影响插件加载。
    bpmnAdapters: buildAgentAdapters(ctx, log, join(dir, '.tmp')),
  }
  // 插件卸载 / 测试收尾：释放实例运行时（不删 definitions / instances 数据）。
  ctx.effect(() => () => {
    const runtime = bpmnRuntimes.get(bpmnEnv)
    if (runtime === undefined) return undefined
    try {
      const result = runtime.dispose()
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).catch(() => {
          // 释放失败不该影响卸载。
        })
      }
      return result
    } catch {
      // 释放失败不该影响卸载。
    }
    return undefined
  }, 'flow-studio: 实例运行时')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: createHandler(bpmnEnv),
  }), 'flow-studio: /api/flow-studio')

  // 06 §15：模型工具（实例生命周期 + 人工任务完成）。
  // tools 服务是**可选**依赖：旧 profile / 测试环境里拿不到就只跳过注册，
  // 面板与 /api 路由照常可用——不能因为缺少工具注册表让插件装不上。
  const toolsSvc = (typeof ctx.get === 'function' && ctx.get('tools')) || ctx.tools
  if (toolsSvc && typeof toolsSvc.register === 'function') {
    // 0.14.0：只剩实例域工具；0.14.3 加 suspend / resume 后共 13 个，旧运行域工具已随旧引擎删除。
    const instanceTools = createInstanceTools({ getRuntime: () => bpmnRuntimeFor(bpmnEnv) })
    ctx.effect(() => {
      const disposers = instanceTools.map(tool => toolsSvc.register(tool))
      return () => disposers.reverse().forEach(dispose => dispose())
    }, 'flow-studio: 注册模型工具')
  } else {
    log('info', 'flow-studio: 未找到 tools 服务，跳过模型工具注册（面板与 /api 路由照常可用）')
  }
}
