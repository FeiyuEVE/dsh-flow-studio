/**
 * ACP v1 适配器（0.15.0 / P4）。
 *
 * 契约与同形适配器（`agent-adapter-claude.js`）一致：`agent-adapter.js` 的冻结接口 +
 * `docs/design/11-node-finish-tool.md`。本适配器把 ACP agent（首发 codex-acp 2.6.0）
 * 当作**子进程协议对端**：
 *
 *   ACP agent ── stdio NDJSON ──▶ `openAcpClient()`（P1：路由 / 超时 / 关闭）
 *        │                              │
 *        │ agent 自己拉起 MCP server     ├─ `session/update` → P3 事件投影
 *        └──▶ `node-finish-mcp.js` ──▶ 本地 socket ──▶ finish gate（唯一完结事实）
 *
 * 五条不变量：
 *   1. **完结只认 gate 受理**：`session/prompt` 的 `stopReason:"end_turn"` 只表示本轮
 *      结束；还在跑就提醒（默认 3 次），否则 `NODE_FINISH_MISSING`。已受理的成功结果
 *      不会被迟到的 cancel 改写。
 *   2. **probe 必须证明 agent 真的拉起 finish MCP**：`initialize` / `session/new` /
 *      `set_mode` 只是会话协商；还要本地 `verifyFinishBridge()` 往返、agent 侧
 *      `firstContact`（hello）与 `discovered`（tools/list）都成立，才宣称
 *      `finishTool:"native"`。握手不能代替 discovery。
 *   3. **模式必须真实可用**：默认 `mode:"workspace-write"` + `permissionPolicy:"deny"`；
 *      目标 mode 不在 `availableModes` 或 `session/set_mode` 失败 → `ACP_MODE_UNAVAILABLE`，
 *      绝不回退到更宽的模式，也不派 prompt。
 *   4. **取消有次序**：封 gate → 不发新 prompt → `session/cancel` 通知 → 之后到达的权限
 *      请求全部 cancelled → 有界收尾响应（默认 500ms，期间继续读 update / usage）→
 *      收账本 → 关连接 / 整组 TERM → KILL。P1 的权限回调是同步的（到达即应答），
 *      所以「未决权限」在协议上不存在；这里保证**每个请求恰好一次应答**，取消后到达的
 *      一律 cancelled。
 *   5. **用量走 P2 账本**：每个 prompt 一轮 `begin/end`；尾部 5s 没拿到响应就
 *      `sealUnknown`；`usage_update.used/size` 只进诊断，绝不当 token 或基线。
 *
 * 错误全集（对外字符串契约）：
 *   配置 `ACP_CONFIG_INVALID`；mode `ACP_MODE_UNAVAILABLE`；`-32000`
 *   `ACP_AUTH_REQUIRED`；`-32002` `ACP_SESSION_NOT_FOUND`；JSON-RPC 解析/参数/
 *   方法不存在/版本/未知 stopReason `ACP_PROTOCOL_ERROR`；其它 RPC（含 -32603）或
 *   `refusal` `ACP_PROVIDER_ERROR`；`max_tokens` / `max_turn_requests`
 *   `ACP_LIMIT_REACHED`；控制请求超时 `ACP_REQUEST_TIMEOUT`；EOF / 异常退出
 *   `ACP_PROCESS_EXITED`；`-32800` / `stopReason:"cancelled"` `NODE_FINISH_CANCELED`。
 *   复用 `ADAPTER_INVALID`、`ADAPTER_PROBE_INVALID`、`NODE_FINISH_TOOL_UNAVAILABLE`、
 *   `NODE_FINISH_CHANNEL_FAILED`、`NODE_FINISH_MISSING`、`NODE_FINISH_ABORTED`。
 *
 * 证据边界：本包只有 fake ACP agent（真实 MCP SDK 通道）与 18 帧真实报文重放；
 * **没有**在真实 codex-acp 2.6.0 上跑过模型调用，所以 `capabilities().evidence.realChannel`
 * 明确写「未验证」。18 帧只证明文本轮次 / usage / commands，不证明 MCP 完结。
 *
 * @module @feiyueve/dsh-flow-studio/agent-adapter-acp
 */

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, promises as fsp } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ADAPTER_ERROR, AdapterError } from './agent-adapter.js'
import {
  ACP_PROCESS_EXITED,
  ACP_PROTOCOL_ERROR,
  ACP_REQUEST_TIMEOUT,
  AcpClientError,
  openAcpClient,
} from './acp-client.js'
import { createAcpEventMapper } from './acp-events.js'
import {
  ACP_CONFIG_INVALID,
  ACP_MODE_UNAVAILABLE,
  DEFAULT_ACP_CONFIG,
  chooseAcpPermission,
  parseAcpConfig,
  selectAcpMode,
} from './acp-policy.js'
import { createAcpUsageLedger } from './acp-usage-ledger.js'
import { createProcessGroupSupervisor, createResourceRegistry } from './agent-cli-lifecycle.js'
import { createFinishGate } from './node-finish.js'
import {
  FINISH_REMINDER_TEXT,
  createFinishChannel,
  defaultTmpRoot,
  verifyFinishBridge,
} from './node-finish-mcp.js'
import { redactStructured, redactText as redactSharedText } from './process-output.js'

/** 适配器 id（注册表 / 运行日志 / admission / 事件 provider 都用它）。 */
export const ACP_ADAPTER_ID = 'acp'

/** probe 总预算（毫秒）：桥自检 + agent 会话 + MCP discovery 共享这一份。 */
export const ACP_PROBE_TOTAL_MS = 15_000

/** probe 成功结果缓存 TTL（毫秒）；到期后 `capabilities()` 立即降级。 */
export const ACP_PROBE_CACHE_TTL_MS = 10 * 60_000

/** 单个控制请求（initialize / new / set_mode / close / hello）上限。 */
export const ACP_CONTROL_TIMEOUT_MS = 10_000

/** 关闭连接的等待上限。 */
export const ACP_CLOSE_TIMEOUT_MS = 1_000

/** 取消后继续读尾响应 / 尾 update 的窗口。 */
export const ACP_CANCEL_RESPONSE_GRACE_MS = 500

/** gate 受理成功后继续等 prompt 响应（拿尾 usage）的窗口。 */
export const ACP_FINISH_TAIL_GRACE_MS = 5_000

/** TERM 之后等协作退出的时间，到期 SIGKILL（整组）。 */
export const ACP_TERM_KILL_TIMEOUT_MS = 3_000

/** 默认提醒次数（与 Claude / 11 §3.1 一致）。 */
export const ACP_REMINDER_LIMIT = 3

/** 其它 RPC 错误 / 明确 refusal。 */
export const ACP_PROVIDER_ERROR = 'ACP_PROVIDER_ERROR'

/** max_tokens / max_turn_requests：预算型停止，不重试不提醒。 */
export const ACP_LIMIT_REACHED = 'ACP_LIMIT_REACHED'

/** 需要先登录（`-32000`）。 */
export const ACP_AUTH_REQUIRED = 'ACP_AUTH_REQUIRED'

/** 会话不存在（`-32002`）。 */
export const ACP_SESSION_NOT_FOUND = 'ACP_SESSION_NOT_FOUND'

/** `deliverMessage()` 固定返回的「不支持」码。 */
export const ACP_MESSAGE_DELIVERY_UNSUPPORTED = 'ACP_MESSAGE_DELIVERY_UNSUPPORTED'

/** `capabilities().evidence.finishTool` 的固定证据说明。 */
export const ACP_FINISH_TOOL_EVIDENCE = 'agent 拉起 mcpServers 里的 flow_finish stdio server，'
  + '并在 probe 里完成 firstContact(hello) + tools/list discovery；'
  + '会话握手 / end_turn 都不算完结证据'

/** 真实通道尚未验收的固定说明。 */
export const ACP_UNVERIFIED_EVIDENCE = '本包只在 fake ACP agent（真实 MCP SDK 通道）上验收；'
  + '没有在真实 codex-acp 2.6.0 上跑模型调用，finish 的真实模型调用仍未验证'

const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'node-finish-mcp.js')
const MCP_SERVER_NAME = 'flow_finish'
const CLIENT_NAME = 'dsh-flow-acp'
const CLIENT_VERSION = '0.15.0'

/** 传入 ACP agent 的环境白名单（与 Claude 适配器同一套口径，再加显式 config.env）。 */
const CHILD_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'USER', 'LOGNAME', 'TERM',
  'LANG', 'LANGUAGE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'HOMEDRIVE', 'HOMEPATH', 'WINDIR',
])

const CHILD_ENV_PREFIXES = Object.freeze(['LC_', 'CLAUDE_', 'ANTHROPIC_', 'AWS_', 'GOOGLE_', 'VERTEX_'])

/** 11 §6 的完结契约（与 DSH / Codex / Claude 适配器同一份语义）。 */
const ACP_FINISH_PROMPT_CONTRACT = Object.freeze([
  '做完本节点的活、要往下流转时，必须调用工具 flow_finish_node：',
  '  variables  后续网关要用的短变量（只能是 boolean / number / 短字符串 / null，禁止大对象）',
  '  documents  你写下的文件的相对路径清单（正文在文件里，不要塞进 variables）',
  '  summary    一句话说明本节点做了什么',
  '不调用该工具就不算完结，流程不会往下走。',
])

/** 适配器类型化错误（`code` 见文件头的错误全集）。 */
export class AcpAdapterError extends AdapterError {
  constructor(code, message, details) {
    super(code, message, details)
    this.name = 'AcpAdapterError'
  }
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  }
  catch {
    return '{}'
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

/** 私有目录：不存在就建，存在也强制 0700（Unix）。 */
function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(dir, 0o700)
  return dir
}

/** POSIX sockaddr_un 的 sun_path 上限（含结尾 NUL 为 108）；留 1 字节余量。 */
const MAX_UNIX_SOCKET_PATH_BYTES = 107

/** 私有目录里的 finish.sock 是否超过 Unix socket 路径上限（Windows 用命名管道，不适用）。 */
function socketPathTooLong(dir) {
  if (process.platform === 'win32') return false
  return Buffer.byteLength(join(dir, 'finish.sock'), 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES
}

/** 有界等待用的定时器（不 unref：兜底计时必须可靠触发）。 */
function sleep(ms) {
  return new Promise(resolveSleep => { setTimeout(resolveSleep, ms) })
}

/** 给任意 Promise 加一个**不 reject** 的有界等待；超时返回 `undefined`。 */
function bounded(promise, ms) {
  return new Promise(resolveBounded => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolveBounded(undefined)
    }, Math.max(0, ms))
    Promise.resolve(promise).then(
      value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveBounded(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveBounded(undefined)
      },
    )
  })
}

/** 脱敏 + 单行 + 限长（错误正文出口）。 */
function boundedText(raw, limit = 500) {
  return redactSharedText(raw === undefined || raw === null ? '' : String(raw))
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit)
}

/** 白名单 + 显式 env（`config.env`）；不继承宿主其它内部变量。 */
function buildChildEnv(extraEnvs) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    if (CHILD_ENV_KEYS.includes(key) || CHILD_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
      env[key] = value
    }
  }
  for (const extra of extraEnvs) {
    if (!isPlainObject(extra)) continue
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === 'string') env[key] = value
    }
  }
  return env
}

/**
 * `session/new` 的 MCP server 描述（方案 P4 固定形状）。
 *
 * 不带 `type`（stdio 是默认类型）；`env` 用 `[{name,value}]`（schema required）；
 * 凭据只在这里出现，不进 argv / 提示词 / 日志。
 */
function buildFinishMcpServer({ serverPath, env }) {
  return {
    name: MCP_SERVER_NAME,
    command: process.execPath,
    args: [serverPath],
    env: Object.entries(env).map(([name, value]) => ({ name, value })),
  }
}

/**
 * 构造节点提示词（与 Claude 适配器同形）：任务本体来自 node.prompt / node.roleCard，
 * description 只作补充；注入 attempt、variables、workspace 与强制完结契约。
 */
function buildAcpNodePrompt({ element, ctx, workspaceRoot }) {
  const node = isPlainObject(element && element.node) ? element.node : {}
  const name = nonEmptyString(element && element.name) ? element.name.trim()
    : (nonEmptyString(element && element.id) ? element.id.trim() : '当前节点')
  const body = [node.prompt, node.roleCard].filter(nonEmptyString).map(item => item.trim())
  const description = nonEmptyString(element && element.description) ? element.description.trim() : ''
  const attempt = Number.isSafeInteger(ctx && ctx.attempt) && ctx.attempt >= 1 ? ctx.attempt : 1
  const variables = isPlainObject(ctx && ctx.variables) ? ctx.variables : {}
  const serialized = safeJson(variables)
  const lines = []
  lines.push(body.length > 0 ? body.join('\n\n') : `你是流程节点「${name}」的执行 agent。`)
  if (description !== '') lines.push(`BPMN 元素描述（补充信息，不是任务本体）：\n${description}`)
  lines.push(`执行上下文：attempt=${attempt}`)
  if (serialized !== '{}' && serialized.length <= 4_000) lines.push(`当前变量：\n${serialized}`)
  lines.push(ACP_FINISH_PROMPT_CONTRACT.join('\n'))
  lines.push(`工作区（documents.path 的相对基准）：${workspaceRoot}`)
  return lines.join('\n\n')
}

/** 协议错误（版本 / 外壳 / 未知 stopReason）。 */
function protocolError(message, reason) {
  return new AcpAdapterError(ACP_PROTOCOL_ERROR, message, {
    adapterId: ACP_ADAPTER_ID,
    reason,
  })
}

/** probe 层错误：统一 `ADAPTER_PROBE_INVALID`，真实分类放 `details.reason`。 */
function probeInvalid(reason, message, details) {
  return new AcpAdapterError(
    ADAPTER_ERROR.PROBE_INVALID,
    boundedText(message, 800),
    { adapterId: ACP_ADAPTER_ID, field: 'probe', reason, ...(details || {}) },
  )
}

/** 从 P1 错误对象里取 JSON-RPC 原 code（P1 放在 details.rpcCode）。 */
function rpcCodeOf(error) {
  const code = error && error.details ? error.details.rpcCode : undefined
  return typeof code === 'number' ? code : null
}

/**
 * 把 P1 的连接错误映射成 §P4 的错误全集。
 *
 * @param {unknown} error
 * @param {{processExited?: boolean}} [context]
 * @returns {string}
 */
function mapAcpErrorCode(error, { processExited = false } = {}) {
  const rpc = rpcCodeOf(error)
  if (rpc !== null) {
    if (rpc === -32000) return ACP_AUTH_REQUIRED
    if (rpc === -32002) return ACP_SESSION_NOT_FOUND
    if (rpc === -32800) return 'NODE_FINISH_CANCELED'
    if (rpc === -32700 || rpc === -32600 || rpc === -32601 || rpc === -32602) return ACP_PROTOCOL_ERROR
    return ACP_PROVIDER_ERROR
  }
  if (error && error.code === ACP_REQUEST_TIMEOUT) return ACP_REQUEST_TIMEOUT
  if (error && error.code === ACP_PROCESS_EXITED) return ACP_PROCESS_EXITED
  if (error && error.code === ACP_PROTOCOL_ERROR) {
    return processExited ? ACP_PROCESS_EXITED : ACP_PROTOCOL_ERROR
  }
  return ACP_PROVIDER_ERROR
}

/** 错误正文（不含原始 JSON / 配置值）。 */
function errorText(error) {
  if (error instanceof Error) return boundedText(error.message || error.name, 700)
  return boundedText(error, 700)
}

/** 校验 initialize 响应（v1 / agentInfo 必需）。 */
function readInitializeResult(result) {
  if (!isPlainObject(result) || result.protocolVersion !== 1) {
    throw protocolError(
      `ACP agent 没有协商出 v1（protocolVersion=${boundedText(result && result.protocolVersion, 32) || 'missing'}）`,
      'protocol-version',
    )
  }
  const info = isPlainObject(result.agentInfo) ? result.agentInfo : null
  if (info === null || !nonEmptyString(info.name) || !nonEmptyString(info.version)) {
    throw protocolError('ACP initialize 响应缺少可识别的 agentInfo.name/version', 'agent-info')
  }
  const capabilities = isPlainObject(result.agentCapabilities) ? result.agentCapabilities : {}
  const sessionCapabilities = isPlainObject(capabilities.sessionCapabilities)
    ? capabilities.sessionCapabilities
    : null
  return {
    agentInfo: {
      name: info.name.trim(),
      ...(nonEmptyString(info.title) ? { title: info.title.trim() } : {}),
      version: info.version.trim(),
    },
    loadSession: capabilities.loadSession === true,
    closeSupported: sessionCapabilities !== null && Object.hasOwn(sessionCapabilities, 'close'),
  }
}

/** 校验 session/new 响应（sessionId 必需）。 */
function readSessionResult(result) {
  if (!isPlainObject(result) || !nonEmptyString(result.sessionId)) {
    throw protocolError('ACP session/new 响应缺少 sessionId', 'session-id')
  }
  return { sessionId: result.sessionId, modes: result.modes }
}

/**
 * 创建一个 ACP v1 适配器。
 *
 * 工厂**无进程 / 文件副作用**：配置解析失败也只保留错误，等 `probe()` / `start()` 再拒绝。
 *
 * @param {object} [options]
 * @param {string} [options.rawConfig] `FLOW_STUDIO_ACP_CONFIG` 原始值（省略时读环境变量）
 * @param {object} [options.configResult] 已解析结果 `{ok:true,config}|{ok:false,...}`（P5 接线）
 * @param {object} [options.config] 已解析成功的配置（测试 / 上层缓存）
 * @param {string} [options.tmpRoot] 私有临时根（默认 `$FLOW_STUDIO_TMP` 或 `os.tmpdir()/flow-studio`）
 * @param {number} [options.probeTimeoutMs] probe 总预算（默认 15s）
 * @param {number} [options.probeCacheTtlMs] probe 缓存 TTL（默认 10 分钟；0=不过期）
 * @param {number} [options.controlTimeoutMs] 单个控制请求上限（默认 10s）
 * @param {number} [options.helloTimeoutMs] 等 agent 拉起 finish MCP 的上限（默认 10s）
 * @param {number} [options.closeTimeoutMs] 关闭连接 / 通道的上限（默认 1s）
 * @param {number} [options.cancelResponseGraceMs] 取消后等尾响应的窗口（默认 500ms）
 * @param {number} [options.finishTailGraceMs] gate 受理后等尾 usage 的窗口（默认 5s）
 * @param {number} [options.killTimeoutMs] TERM → KILL 的间隔（默认 3s）
 * @param {number} [options.reminderLimit] 最多提醒次数（默认 3）
 * @param {string} [options.serverPath] `node-finish-mcp.js` 路径（测试注入坏路径可模拟桥失败）
 * @param {Function} [options.verifyBridge] 自定义桥自检（测试依赖注入）
 * @param {Function} [options.killImpl] 进程组信号实现注入（测试依赖注入）
 * @param {object} [options.probeResult] 注入 probe 结果（测试 / 上层缓存；不伪造 MCP 证据）
 */
export function createAcpAdapter(options = {}) {
  const initialConfig =
    isPlainObject(options.configResult)
      ? options.configResult
      : (isPlainObject(options.config)
        ? { ok: true, config: { ...DEFAULT_ACP_CONFIG, ...options.config } }
        : parseAcpConfig(options.rawConfig))
  const configValid = initialConfig.ok === true && isPlainObject(initialConfig.config)
  const config = configValid
    ? {
      command: initialConfig.config.command,
      args: Array.isArray(initialConfig.config.args) ? [...initialConfig.config.args] : [],
      env: isPlainObject(initialConfig.config.env) ? { ...initialConfig.config.env } : {},
      mode: initialConfig.config.mode,
      permissionPolicy: initialConfig.config.permissionPolicy,
    }
    : { ...DEFAULT_ACP_CONFIG, args: [], env: {} }
  const configError = configValid
    ? null
    : {
      code: isPlainObject(initialConfig) && typeof initialConfig.code === 'string'
        ? initialConfig.code
        : ACP_CONFIG_INVALID,
      message: isPlainObject(initialConfig) && typeof initialConfig.message === 'string'
        ? initialConfig.message
        : 'ACP 配置非法',
    }

  const settings = {
    tmpRoot: nonEmptyString(options.tmpRoot) ? resolve(options.tmpRoot) : defaultTmpRoot(),
    probeTimeoutMs: Number.isSafeInteger(options.probeTimeoutMs) && options.probeTimeoutMs >= 1
      ? options.probeTimeoutMs
      : ACP_PROBE_TOTAL_MS,
    probeCacheTtlMs: Number.isSafeInteger(options.probeCacheTtlMs) && options.probeCacheTtlMs >= 0
      ? options.probeCacheTtlMs
      : ACP_PROBE_CACHE_TTL_MS,
    controlTimeoutMs: Number.isSafeInteger(options.controlTimeoutMs) && options.controlTimeoutMs >= 1
      ? options.controlTimeoutMs
      : ACP_CONTROL_TIMEOUT_MS,
    helloTimeoutMs: Number.isSafeInteger(options.helloTimeoutMs) && options.helloTimeoutMs >= 0
      ? options.helloTimeoutMs
      : ACP_CONTROL_TIMEOUT_MS,
    closeTimeoutMs: Number.isSafeInteger(options.closeTimeoutMs) && options.closeTimeoutMs >= 0
      ? options.closeTimeoutMs
      : ACP_CLOSE_TIMEOUT_MS,
    cancelResponseGraceMs: Number.isSafeInteger(options.cancelResponseGraceMs) && options.cancelResponseGraceMs >= 0
      ? options.cancelResponseGraceMs
      : ACP_CANCEL_RESPONSE_GRACE_MS,
    finishTailGraceMs: Number.isSafeInteger(options.finishTailGraceMs) && options.finishTailGraceMs >= 0
      ? options.finishTailGraceMs
      : ACP_FINISH_TAIL_GRACE_MS,
    killTimeoutMs: Number.isSafeInteger(options.killTimeoutMs) && options.killTimeoutMs >= 0
      ? options.killTimeoutMs
      : ACP_TERM_KILL_TIMEOUT_MS,
    reminderLimit: Number.isSafeInteger(options.reminderLimit) && options.reminderLimit >= 0
      ? options.reminderLimit
      : ACP_REMINDER_LIMIT,
    serverPath: nonEmptyString(options.serverPath) ? resolve(options.serverPath) : SERVER_PATH,
    verifyBridge: typeof options.verifyBridge === 'function' ? options.verifyBridge : null,
    killImpl: typeof options.killImpl === 'function' ? options.killImpl : null,
  }

  /** @type {{value:object, at:number}|null} */
  let probeCache = isPlainObject(options.probeResult)
    ? { value: { ...options.probeResult }, at: Date.now() }
    : null
  let probePromise = null
  /** 迟到结果防复活：invalidate 递增 generation，旧 probe 成功也不写缓存。 */
  let probeGeneration = 0

  /** 读 probe 缓存（过 TTL 当没有，能力立即降级）。 */
  function readProbeCache() {
    if (!probeCache) return null
    if (settings.probeCacheTtlMs > 0 && Date.now() - probeCache.at >= settings.probeCacheTtlMs) {
      probeCache = null
      return null
    }
    return probeCache.value
  }

  /** 显式让缓存失效；进行中的 probe 结果不会再写回。 */
  function invalidateProbe() {
    probeGeneration += 1
    probeCache = null
  }

  function capabilities() {
    const value = readProbeCache()
    const protocolOk = Boolean(value && value.protocolVersion === 1)
    const bridgeOk = Boolean(value && isPlainObject(value.bridge) && value.bridge.ok === true)
    const contacted = Boolean(value && isPlainObject(value.agentMcp) && value.agentMcp.contacted === true)
    const discovered = Boolean(value && isPlainObject(value.agentMcp) && value.agentMcp.discovered === true)
    const native = protocolOk && bridgeOk && contacted && discovered
    return {
      finishTool: native ? 'native' : 'unsupported',
      hooks: { 'turn.stop': 'emulated' },
      messages: 'unsupported',
      usage: 'unknown',
      resume: 'unsupported',
      cancel: 'native',
      evidence: {
        finishTool: native
          ? ACP_FINISH_TOOL_EVIDENCE
          : 'finishTool=unsupported：没有同时满足① v1 会话协商 ② 本地桥自检 '
            + '③ agent 侧 firstContact(hello) ④ tools/list discovery；握手本身不算完结证据',
        usage: [
          'prompt 响应里的 unstable usage（codex-acp 2.6.0 已按本轮差分并扣除缓存）→ P2 账本',
          'usage_update.used/size 只进诊断，不当 token、不做基线',
          'profile 未验证 / 缺字段 / 回退 → unknown，不造 0',
        ],
        permissionPolicy: `mode=${config.mode}；permissionPolicy=${config.permissionPolicy}`
          + '（deny 只选 reject_once，allow 只选 allow_once；永不选 always）',
        protocol: [
          'ACP v1（initialize.protocolVersion=1）',
          'session/new（cwd 绝对路径 + finish mcpServers）→ session/set_mode',
          'agent 自己拉起 flow_finish MCP server；client 不代理 MCP 流量',
        ],
        evidenceLayers: [
          '① ACP 会话 / 模式协商：initialize + session/new + session/set_mode',
          '② 本地桥自检：verifyFinishBridge（initialize / tools.list / tools.call）',
          '③ agent 拉起 finish MCP 并 tools/list discovery（firstContact + discovered）',
          '④ 模型真实调用 finish：需要真实 codex-acp 冒烟，本包未验证',
        ],
        realChannel: ACP_UNVERIFIED_EVIDENCE,
      },
    }
  }

  // -------------------------------------------------------------------------
  // probe
  // -------------------------------------------------------------------------

  /** 在 agent 侧等 hello + discovery 都成立（probe / start 共用）。 */
  async function waitForFinishDiscovery({ channel, timeoutMs, isCanceled, didExit }) {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    for (;;) {
      if (channel.discovered === true) return 'discovered'
      if (isCanceled()) return 'canceled'
      if (didExit()) return channel.contacted === true ? 'contacted-only' : 'exited'
      if (Date.now() >= deadline) return channel.contacted === true ? 'contacted-only' : 'timeout'
      await sleep(20)
    }
  }

  /**
   * 真正跑一遍 probe：桥自检 → 独立临时 gate/channel → agent initialize → session/new →
   * set_mode → hello + discovery → close。全程不发 prompt。
   */
  async function probeOnce(generation) {
    const startedAt = Date.now()
    const deadline = startedAt + settings.probeTimeoutMs
    const remainingMs = () => Math.max(0, deadline - Date.now())
    const stepTimeout = () => {
      const left = remainingMs()
      if (left <= 0) return 0
      return Math.max(1, Math.min(settings.controlTimeoutMs, left))
    }

    if (configError !== null) {
      throw probeInvalid(
        configError.code === ACP_CONFIG_INVALID ? ACP_CONFIG_INVALID : 'config-invalid',
        `ACP 配置不可用（${configError.code}）：${configError.message}`,
        { cause: configError.code },
      )
    }
    if (settings.helloTimeoutMs <= 0) {
      throw probeInvalid('hello-disabled', 'helloTimeoutMs=0：无法证明 agent 拉起 finish MCP，拒绝宣称 native')
    }

    // ① 本地桥自检（我们自己的 MCP stdio server 往返）。
    const bridgeTimeout = Math.max(1_000, Math.min(settings.controlTimeoutMs, remainingMs()))
    let bridge
    try {
      bridge = settings.verifyBridge
        ? await bounded(settings.verifyBridge({ tmpRoot: settings.tmpRoot, timeoutMs: bridgeTimeout }), bridgeTimeout)
        : await bounded(verifyFinishBridge({
          tmpRoot: settings.tmpRoot,
          timeoutMs: bridgeTimeout,
          ...(settings.serverPath === SERVER_PATH ? {} : { serverPath: settings.serverPath }),
        }), bridgeTimeout)
    }
    catch (error) {
      throw probeInvalid('bridge-failed', `完成桥自检失败：${errorText(error)}`, { cause: 'bridge-error' })
    }
    if (!bridge || bridge.ok !== true) {
      throw probeInvalid(
        'bridge-failed',
        `完成桥自检失败（${bridge && bridge.reason ? boundedText(bridge.reason, 64) : 'unknown'}）：`
          + 'MCP stdio 往返不可用',
        { ...(bridge && bridge.reason ? { bridgeReason: boundedText(bridge.reason, 64) } : {}) },
      )
    }
    if (remainingMs() <= 0) {
      throw probeInvalid('probe-timeout', `ACP probe 超过 ${settings.probeTimeoutMs}ms 预算（桥自检后）`)
    }

    ensurePrivateDir(settings.tmpRoot)
    let probeDir = ''
    let channel = null
    let client = null
    let child = null
    let group = null
    let supervisor = null
    let resources = null
    const exitState = { exited: false, code: undefined, signal: undefined, error: undefined }

    try {
      probeDir = ensurePrivateDir(await fsp.mkdtemp(join(settings.tmpRoot, 'fs-acp-probe-')))
      resources = createResourceRegistry()
      supervisor = createProcessGroupSupervisor({
        graceMs: 0,
        killTimeoutMs: settings.killTimeoutMs,
        ...(settings.killImpl ? { killImpl: settings.killImpl } : {}),
      })
      const gate = createFinishGate({
        executionId: 'acp-probe',
        nodeId: 'probe',
        attempt: 1,
        workspaceRoot: probeDir,
      })
      if (socketPathTooLong(probeDir)) {
        throw probeInvalid(
          'socket-path-too-long',
          `probe 私有目录的 finish.sock 路径超过 Unix socket 上限（${MAX_UNIX_SOCKET_PATH_BYTES} 字节）：`
            + '不退化到 /tmp，按 finish 工具不可用处理',
        )
      }
      channel = await createFinishChannel({ gate, dir: probeDir, maxReminders: 0 })

      const mcpServer = buildFinishMcpServer({ serverPath: settings.serverPath, env: channel.env })
      try {
        child = spawn(config.command, config.args, {
          cwd: probeDir,
          env: buildChildEnv([config.env]),
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      }
      catch (error) {
        throw probeInvalid('spawn-failed', `ACP agent 无法启动（${errorText(error)}）`, {
          cause: error && error.code ? String(error.code) : 'SPAWN_FAILED',
        })
      }
      child.once('exit', (code, signal) => {
        exitState.exited = true
        exitState.code = code
        exitState.signal = signal
        try {
          client?.close(new AcpClientError(
            ACP_PROCESS_EXITED,
            `ACP agent 进程退出（code=${code === null ? 'none' : code} signal=${signal || 'none'}）`,
            { reason: 'process-exited', exitCode: code, signal },
          ))
        }
        catch {
          // ignore
        }
      })
      child.once('error', error => {
        exitState.exited = true
        exitState.error = error
      })
      if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        group = supervisor.track(child, { label: `probe:${child.pid}` })
      }

      client = await openAcpClient({
        input: child.stdout,
        output: child.stdin,
        requestTimeoutMs: 0,
        onUpdate: () => {},
        onPermission: ({ params }) => chooseAcpPermission(params, {
          policy: config.permissionPolicy,
          cancelled: false,
          sessionId: '',
        }),
        onDiagnostic: () => {},
      })

      const initializeTimeout = stepTimeout()
      if (initializeTimeout <= 0) throw probeInvalid('probe-timeout', 'ACP probe 预算已用尽（initialize 前）')
      const init = await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: CLIENT_NAME, title: 'DSH ACP Adapter', version: CLIENT_VERSION },
      }, { timeoutMs: initializeTimeout })
      const meta = readInitializeResult(init)

      const newTimeout = stepTimeout()
      if (newTimeout <= 0) throw probeInvalid('probe-timeout', 'ACP probe 预算已用尽（session/new 前）')
      const created = await client.request('session/new', {
        cwd: probeDir,
        mcpServers: [mcpServer],
      }, { timeoutMs: newTimeout })
      const session = readSessionResult(created)
      const selected = selectAcpMode(session.modes, config.mode)
      if (!selected.ok) {
        throw probeInvalid('mode-unavailable', selected.message, {
          code: ACP_MODE_UNAVAILABLE,
          availableModeIds: selected.availableModeIds ?? [],
        })
      }
      const modeTimeout = stepTimeout()
      if (modeTimeout <= 0) throw probeInvalid('probe-timeout', 'ACP probe 预算已用尽（session/set_mode 前）')
      try {
        await client.request('session/set_mode', {
          sessionId: session.sessionId,
          modeId: selected.modeId,
        }, { timeoutMs: modeTimeout })
      }
      catch (error) {
        throw probeInvalid('mode-unavailable', `session/set_mode 失败：${errorText(error)}`, {
          code: ACP_MODE_UNAVAILABLE,
          cause: mapAcpErrorCode(error, { processExited: exitState.exited }),
          rpcCode: rpcCodeOf(error),
        })
      }

      const discoveryTimeout = Math.max(0, Math.min(settings.helloTimeoutMs, remainingMs()))
      const discovery = await waitForFinishDiscovery({
        channel,
        timeoutMs: discoveryTimeout,
        isCanceled: () => false,
        didExit: () => exitState.exited,
      })
      if (discovery !== 'discovered') {
        throw probeInvalid(
          discovery === 'contacted-only' ? 'agent-mcp-not-discovered' : 'agent-mcp-not-contacted',
          discovery === 'contacted-only'
            ? 'agent 拉起了 finish MCP（收到 hello）但没有 tools/list discovery：'
              + '不能证明模型能看到 flow_finish_node'
            : (discovery === 'exited'
              ? 'ACP agent 在拉起 finish MCP 之前退出（stdio EOF）'
              : `${settings.helloTimeoutMs}ms 内 agent 没有拉起 finish MCP（零 discovery）`),
          {
            contacted: channel.contacted === true,
            discovered: channel.discovered === true,
            ...(Number.isSafeInteger(exitState.code) ? { exitCode: exitState.code } : {}),
            ...(exitState.signal ? { signal: exitState.signal } : {}),
          },
        )
      }

      if (meta.closeSupported) {
        try {
          await client.request('session/close', { sessionId: session.sessionId }, {
            timeoutMs: Math.max(1, Math.min(settings.closeTimeoutMs, remainingMs() || settings.closeTimeoutMs)),
          })
        }
        catch (error) {
          // -32002 = 已经不存在，视为关闭成功；其它 close 失败只是清理诊断，不影响能力结论。
          if (rpcCodeOf(error) !== -32002) {
            // 不抛：close 是清理动作，探测结论已由 discovery 证明。
          }
        }
      }

      return {
        version: meta.agentInfo.version,
        helpDigest: sha256(safeJson({
          protocolVersion: 1,
          agentInfo: meta.agentInfo,
          loadSession: meta.loadSession,
          closeSupported: meta.closeSupported,
          modes: Array.isArray(session.modes?.availableModes)
            ? session.modes.availableModes.map(item => (isPlainObject(item) ? item.id : null)).filter(Boolean).slice(0, 32)
            : [],
          server: settings.serverPath === SERVER_PATH ? 'bundled' : 'injected',
        })).slice(0, 40),
        protocolVersion: 1,
        agentInfo: meta.agentInfo,
        loadSession: meta.loadSession,
        closeSupported: meta.closeSupported,
        bridge: { ok: true },
        agentMcp: { contacted: true, discovered: true },
        probedAt: new Date().toISOString(),
      }
    }
    catch (error) {
      if (error instanceof AcpAdapterError && error.code === ADAPTER_ERROR.PROBE_INVALID) throw error
      throw probeInvalid(
        exitState.exited ? 'agent-exited' : 'handshake-failed',
        `ACP probe 失败：${errorText(error)}`,
        {
          cause: mapAcpErrorCode(error, { processExited: exitState.exited }),
          ...(Number.isSafeInteger(exitState.code) ? { exitCode: exitState.code } : {}),
          ...(exitState.signal ? { signal: exitState.signal } : {}),
        },
      )
    }
    finally {
      // 这里没有缓存写入动作：probe() 外层按 generation 决定是否写缓存
      // （见 probe() 的 generation 校验）。失败 / 被 invalidate 的迟到结果只回给
      // 调用方，绝不回写缓存；成功但已 invalidate 的结果同样只回调用方。
      try {
        client?.close(new AcpClientError(ACP_PROCESS_EXITED, 'ACP probe 收尾', { reason: 'probe-cleanup' }))
      }
      catch {
        // ignore
      }
      await bounded(client ? client.closed : Promise.resolve(), settings.closeTimeoutMs)
      for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
        try {
          stream?.destroy?.()
        }
        catch {
          // ignore
        }
      }
      if (group) {
        try {
          await bounded(supervisor.terminateGroup(group, 'probe-cleanup'), settings.killTimeoutMs * 2 + 1_000)
        }
        catch {
          // ignore
        }
      }
      await bounded(supervisor ? supervisor.disposeAll() : Promise.resolve(), settings.killTimeoutMs * 2 + 1_000)
      await bounded(channel ? channel.close() : Promise.resolve(), settings.closeTimeoutMs)
      try {
        await resources?.disposeAll()
      }
      catch {
        // ignore
      }
      if (probeDir !== '') {
        try {
          await fsp.rm(probeDir, { recursive: true, force: true })
        }
        catch {
          // ignore
        }
      }
    }
  }

  /**
   * 可用性探测：合并 in-flight；只缓存成功结果；TTL / invalidate / 超时迟到结果不复活。
   *
   * 失败一律 `ADAPTER_PROBE_INVALID`（`details.reason` 是本包分类），不伪造成功。
   */
  async function probe() {
    const cached = readProbeCache()
    if (cached) return { ...cached }
    if (probePromise) return probePromise
    const generation = probeGeneration
    let abandoned = false
    let timer = null
    const running = probeOnce(generation)
    running.catch(() => {})
    probePromise = (async () => {
      const timeout = new Promise((_, rejectProbe) => {
        timer = setTimeout(() => {
          abandoned = true
          rejectProbe(probeInvalid(
            'probe-timeout',
            `ACP probe 超过 ${settings.probeTimeoutMs}ms 未完成：按不可用处理，不派发节点`,
          ))
        }, settings.probeTimeoutMs)
        timer.unref?.()
      })
      try {
        const value = await Promise.race([running, timeout])
        if (!abandoned && generation === probeGeneration) {
          probeCache = { value: { ...value }, at: Date.now() }
        }
        return { ...value }
      }
      finally {
        clearTimeout(timer)
        timer = null
      }
    })().finally(() => {
      probePromise = null
    })
    return probePromise
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  /** start 抛错时的统一包装：probe 不可用 → TOOL_UNAVAILABLE（保留原因 / 用量载体）。 */
  function asStartFailure(error) {
    if (!(error instanceof AcpAdapterError)) return error
    if (error.code === ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE) return error
    if (error.code === 'NODE_FINISH_CANCELED') return error
    if (error.code !== ADAPTER_ERROR.PROBE_INVALID) return error
    const reason = error.details && typeof error.details.reason === 'string'
      ? error.details.reason
      : 'probe-failed'
    const wrapped = new AcpAdapterError(
      ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
      `ACP 适配器不可用（probe: ${reason}）：${error.message}`,
      {
        adapterId: ACP_ADAPTER_ID,
        field: 'probe',
        reason,
        cause: error.code,
        causeReason: reason,
      },
    )
    if (error.cleanup) wrapped.cleanup = error.cleanup
    if (error.cleanupFinal) wrapped.cleanupFinal = error.cleanupFinal
    if (Array.isArray(error.usageCalls)) wrapped.usageCalls = error.usageCalls
    if (Array.isArray(error.usageSnapshots)) wrapped.usageSnapshots = error.usageSnapshots
    return wrapped
  }

  async function start(request) {
    try {
      return await startAttempt(request)
    }
    catch (error) {
      throw asStartFailure(error)
    }
  }

  async function startAttempt(request) {
    const { element, ctx, finishGate, reminder } = request || {}
    const runnerCtx = isPlainObject(ctx) ? ctx : {}
    const workspaceRoot = nonEmptyString(request?.workspaceRoot)
      ? request.workspaceRoot
      : (isPlainObject(request?.workspace) && nonEmptyString(request.workspace.effectiveRoot)
        ? request.workspace.effectiveRoot
        : '')

    // 预 abort 零派发（在 probe / 建目录之前）。
    if (runnerCtx.signal && runnerCtx.signal.aborted === true) {
      throw new AcpAdapterError(
        'NODE_FINISH_CANCELED',
        'ACP 适配器在启动前已被取消（ctx.signal 已 abort），节点零派发',
        { adapterId: ACP_ADAPTER_ID, reason: 'pre-aborted', nodeId: element && element.id },
      )
    }

    // 闸门形状先校验，再建 channel / runDir。
    const missingGate = []
    if (!finishGate || typeof finishGate !== 'object') {
      missingGate.push('finishGate')
    }
    else {
      for (const method of ['submit', 'settled', 'abort']) {
        if (typeof finishGate[method] !== 'function') missingGate.push(method)
      }
      if (!finishGate.result || typeof finishGate.result.then !== 'function') missingGate.push('result')
    }
    if (missingGate.length > 0) {
      throw new AcpAdapterError(
        ADAPTER_ERROR.INVALID,
        'ACP 适配器 start 需要 node-finish 的 finishGate（submit / settled / abort 方法 + result Promise）',
        { adapterId: ACP_ADAPTER_ID, field: 'finishGate', reason: 'missing-gate', missing: missingGate },
      )
    }
    if (!nonEmptyString(workspaceRoot)) {
      throw new AcpAdapterError(
        ADAPTER_ERROR.INVALID,
        'ACP 适配器 start 需要 workspaceRoot',
        { adapterId: ACP_ADAPTER_ID, field: 'workspaceRoot', reason: 'missing' },
      )
    }
    const workspace = resolve(workspaceRoot)
    if (!existsSync(workspace)) {
      throw new AcpAdapterError(
        ADAPTER_ERROR.INVALID,
        `ACP 适配器的工作区不存在：${workspace}`,
        { adapterId: ACP_ADAPTER_ID, field: 'workspaceRoot', reason: 'not-found' },
      )
    }
    // 配置非法是输入错误：明确拒绝，不包装成「工具不可用」。
    if (configError !== null) {
      throw new AcpAdapterError(
        ACP_CONFIG_INVALID,
        `ACP 配置非法：${configError.message}`,
        {
          adapterId: ACP_ADAPTER_ID,
          field: 'config',
          reason: 'config-invalid',
          source: configError.code,
        },
      )
    }

    // probe 必须先通过；能力不是 native 就零派发。
    const probeValue = await probe()
    if (capabilities().finishTool !== 'native') {
      throw new AcpAdapterError(
        ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
        'ACP 适配器当前不能证明原生 flow_finish_node（probe 未同时通过握手 / 桥 / discovery）：'
          + '按 11 §1.6 拒绝启动，不退回解析文本',
        {
          adapterId: ACP_ADAPTER_ID,
          reason: probeValue ? 'finish-tool-not-native' : 'probe-failed',
          cause: ADAPTER_ERROR.PROBE_INVALID,
          nodeId: element && element.id,
        },
      )
    }

    const attempt = Number.isSafeInteger(runnerCtx.attempt) && runnerCtx.attempt >= 1
      ? runnerCtx.attempt
      : 1
    const nodeId = nonEmptyString(element && element.id) ? element.id.trim() : '(agent)'
    const executionId = nonEmptyString(runnerCtx.executionId)
      ? runnerCtx.executionId
      : `${nonEmptyString(runnerCtx.instanceId) ? runnerCtx.instanceId : 'instance'}:${nodeId}:${attempt}`

    ensurePrivateDir(settings.tmpRoot)
    const resources = createResourceRegistry()
    const supervisor = createProcessGroupSupervisor({
      graceMs: 0,
      killTimeoutMs: settings.killTimeoutMs,
      ...(settings.killImpl ? { killImpl: settings.killImpl } : {}),
    })

    let runDir = ''
    let channel = null
    let client = null
    let child = null
    let group = null
    let mapper = null
    let ledger = null
    let initialProc = null
    let handle = null
    let signalListener = null
    let cancelPromise = null
    let cleanupPromise = null
    let exitedDone = false
    let outcomeClaimed = false
    let resolveExited = null
    let resolveFinalCleanup = null
    let finalCleanupSettled = false
    let finalCleanupTimer = null
    let pendingAbort = false
    let disposeDone = false
    /** 节点提示词（try 块里构造，runTurns 在后台使用）。 */
    let modelPrompt = ''

    const exited = new Promise(resolvePromise => { resolveExited = resolvePromise })
    const cleanupFinal = new Promise(resolvePromise => { resolveFinalCleanup = resolvePromise })

    const finalCleanupWatchMs = Math.min(60_000, Math.max(5_000, settings.killTimeoutMs * 2 + 2_000))

    const state = {
      canceled: false,
      cancelReason: null,
      resolving: false,
      stopping: false,
      processExited: false,
      exitCode: undefined,
      exitSignal: undefined,
      spawnError: null,
      sessionId: undefined,
      agentInfo: null,
      modeId: null,
      handshakeOk: false,
      reminders: 0,
      record: undefined,
      gateAccepted: false,
      turn: null,
      channelFailed: false,
    }

    // gate 受理（resolve）是唯一成功信号；abort 不置位。cancel 的优先级判断靠它。
    finishGate.result.then(
      () => { state.gateAccepted = true },
      () => {},
    )

    const canEmit = typeof runnerCtx.emit === 'function'
    const emit = canEmit ? event => { try { runnerCtx.emit(event) } catch { /* 观测面不能失败 */ } } : null

    const redactSecrets = () => [
      channel?.credential,
      channel?.socketPath,
      runDir,
      ...Object.values(config.env).filter(value => typeof value === 'string' && value.length >= 4),
    ].filter(value => typeof value === 'string' && value !== '')

    /**
     * 脱敏后的深拷贝（诊断出口；绝不返回原始对象）。
     *
     * 与 codex / claude 适配器共用 `redactStructured`：结构化深拷贝 + 敏感键名下的值
     * 整体替换 + 共享文本规则；0.15.1 的本地实现只对字符串脱敏、不看键名（B1），
     * `handle.diagnostics` 里任何结构化凭据字段都会原样导出，已删除。
     */
    const redactValue = value => redactStructured(value, { secrets: redactSecrets() })

    const cleanupSnapshot = () => {
      const groupSnapshot = supervisor.snapshot()
      const pendingGroups = groupSnapshot.groups.filter(entry => entry.alive || entry.pending)
      const resourceSnapshot = resources.snapshot()
      const release = {
        released: resourceSnapshot.pending.length === 0,
        pending: resourceSnapshot.pending.map(entry => entry.kind),
      }
      if (pendingGroups.length === 0) return { disposed: true, resources: release }
      return {
        disposed: false,
        pending: pendingGroups.map(entry => entry.label || `process:${entry.pid}`),
        processes: pendingGroups.map(entry => ({ kind: entry.label, pid: entry.pid, alive: entry.alive })),
        resources: release,
        reason: `仍有 ${pendingGroups.length} 个 acp 进程组未确认退出`,
      }
    }

    const releaseSnapshot = () => {
      const groups = cleanupSnapshot()
      const resourceSnapshot = resources.snapshot()
      const pendingResources = resourceSnapshot.pending
      if (groups.disposed === true && pendingResources.length === 0) return { disposed: true }
      return {
        ...groups,
        disposed: false,
        pendingResources: pendingResources.map(entry => entry.kind),
        reason: `${groups.disposed === true ? '进程组已消失' : groups.reason}；${pendingResources.length} 项资源未释放`,
      }
    }

    const settleFinalCleanup = value => {
      if (finalCleanupSettled) return
      finalCleanupSettled = true
      resolveFinalCleanup(value)
    }

    const watchFinalCleanup = () => {
      if (finalCleanupTimer !== null) return
      const tick = async () => {
        const deadline = Date.now() + finalCleanupWatchMs
        for (;;) {
          const snapshot = releaseSnapshot()
          if (snapshot.disposed === true) {
            settleFinalCleanup(snapshot)
            return
          }
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            settleFinalCleanup({
              ...snapshot,
              timedOut: true,
              reason: `${snapshot.reason}；最终清理等待 ${finalCleanupWatchMs}ms 超时`,
            })
            return
          }
          await sleep(Math.min(remaining, 100))
        }
      }
      finalCleanupTimer = true
      void tick().catch(error => {
        settleFinalCleanup({
          disposed: false,
          reason: `最终清理盯守失败：${errorText(error)}`,
        })
      })
    }

    /** gate 是否已 seal（已受理成功或已 abort）；查询失败按「未定」处理。 */
    const gateSettled = () => {
      try {
        return finishGate.settled() === true
      }
      catch {
        return false
      }
    }

    const abortGate = reason => {
      try {
        if (typeof finishGate.abort !== 'function' || finishGate.settled()) return false
        return finishGate.abort(reason) !== false
      }
      catch {
        return false
      }
    }

    const emitReminder = info => {
      try {
        if (reminder && typeof reminder.onFire === 'function') {
          reminder.onFire({
            count: info.count,
            maxFires: info.maxFires !== undefined ? info.maxFires : settings.reminderLimit,
            ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          })
        }
        else if (typeof reminder === 'function') {
          reminder({
            count: info.count,
            maxFires: info.maxFires !== undefined ? info.maxFires : settings.reminderLimit,
            ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          })
        }
      }
      catch {
        // 回调异常不能改变完结判定。
      }
    }

    const notifyTurnWaiters = () => {
      const turn = state.turn
      if (!turn) return
      const waiters = turn.waiters.splice(0)
      for (const wake of waiters) {
        try {
          wake()
        }
        catch {
          // ignore
        }
      }
    }

    /** 取消 / 清理时把未结算的 turn 收成 unknown（账本首终结有效）。 */
    const finalizeTurnUnknown = reason => {
      const turn = state.turn
      if (!turn || turn.ended) return
      turn.ended = true
      if (turn.response) ledger?.end(turn.invocationId, turn.response)
      else ledger?.sealUnknown(turn.invocationId, 'usage-unavailable')
      try {
        mapper?.endTurn()
      }
      catch {
        // ignore
      }
      notifyTurnWaiters()
    }

    /** gate 受理成功后：等尾响应（有界），收账本，清理，resolve 成功。 */
    const finishSuccess = async () => {
      if (outcomeClaimed || exitedDone) return
      outcomeClaimed = true
      state.resolving = true
      state.gateAccepted = true
      try {
        let record = null
        try {
          record = await finishGate.result
        }
        catch (error) {
          await cleanupResources('finish-result-missing')
          resolveOutcome({
            ok: false,
            code: error && typeof error.code === 'string' ? error.code : 'NODE_FINISH_ABORTED',
            message: errorText(error),
            sessionId: state.sessionId,
            reminders: state.reminders,
          })
          return
        }
        state.record = record
        await cleanupResources('finished')
        resolveOutcome({
          ok: true,
          code: 'OK',
          record,
          sessionId: state.sessionId,
          reminders: state.reminders,
        })
      }
      finally {
        state.resolving = false
      }
    }

    /** 失败结局：先收账本 / 清理，再 resolve（运行失败不 reject）。 */
    const finishFailure = async outcome => {
      if (outcomeClaimed || exitedDone) return
      outcomeClaimed = true
      state.resolving = true
      try {
        finalizeTurnUnknown('failure')
        await cleanupResources(`outcome:${outcome.code}`)
        resolveOutcome({
          ...outcome,
          sessionId: state.sessionId,
          reminders: state.reminders,
        })
      }
      finally {
        state.resolving = false
      }
    }

    const resolveOutcome = outcome => {
      if (exitedDone) return
      exitedDone = true
      if (signalListener && runnerCtx.signal && typeof runnerCtx.signal.removeEventListener === 'function') {
        try {
          runnerCtx.signal.removeEventListener('abort', signalListener)
        }
        catch {
          // ignore
        }
        signalListener = null
      }
      resolveExited(outcome)
    }

    /** 资源收尾（幂等）：关连接 → 停流 → 整组 TERM/KILL → 关通道 → 释放资源。 */
    function cleanupResources(reason) {
      if (cleanupPromise) return cleanupPromise
      cleanupPromise = (async () => {
        state.stopping = true
        abortGate(reason)
        finalizeTurnUnknown(reason)
        if (client) {
          try {
            client.close(new AcpClientError(
              ACP_PROCESS_EXITED,
              `ACP 适配器收尾（${boundedText(reason, 80)}）`,
              { reason: 'cleanup' },
            ))
          }
          catch {
            // ignore
          }
          await bounded(client.closed, settings.closeTimeoutMs)
        }
        for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
          try {
            stream?.destroy?.()
          }
          catch {
            // ignore
          }
        }
        if (group) {
          try {
            await bounded(
              supervisor.terminateGroup(group, reason),
              settings.killTimeoutMs * 2 + 1_000,
            )
          }
          catch {
            // ignore
          }
        }
        await bounded(supervisor.disposeAll(), settings.killTimeoutMs * 2 + 1_000)
        await bounded(channel ? channel.close() : Promise.resolve(), settings.closeTimeoutMs)
        try {
          mapper?.dispose()
        }
        catch {
          // ignore
        }
        try {
          await resources.disposeAll()
        }
        catch {
          // 清理失败由 cleanup / cleanupFinal 如实报告。
        }
        // runDir 可能在资源登记之前就创建（例如建通道 / 开连接失败）：显式兜底删除。
        if (runDir !== '') {
          try {
            await fsp.rm(runDir, { recursive: true, force: true })
          }
          catch {
            // 删除失败由 cleanupFinal / 残留目录观测暴露。
          }
        }
        watchFinalCleanup()
        return cleanupSnapshot()
      })()
      return cleanupPromise
    }

    /** 取消（幂等）：封 gate → 不发新 prompt → session/cancel → 有界收尾 → 清理。 */
    function cancelHandle(target, reason) {
      if (!target || typeof target !== 'object') {
        return Promise.reject(new AcpAdapterError(
          ADAPTER_ERROR.INVALID,
          'cancel 需要 start() 返回的 handle',
          { adapterId: ACP_ADAPTER_ID, field: 'handle', reason: 'missing' },
        ))
      }
      if (cancelPromise) return cancelPromise
      if (exitedDone) return Promise.resolve(exited)
      const cancelReason = nonEmptyString(reason) ? reason.trim() : 'canceled'
      state.canceled = true
      state.cancelReason = cancelReason
      abortGate(cancelReason)
      cancelPromise = (async () => {
        // 停新 prompt：state.canceled 已经让 turn 循环在下一轮退出；当前 prompt 继续收尾。
        if (client && state.sessionId) {
          try {
            // 通知写端可能因对端不读而阻塞：有界等待，绝不把取消挂死。
            await bounded(client.notify('session/cancel', { sessionId: state.sessionId }), 100)
          }
          catch {
            // 连接已断：直接进入清理。
          }
        }
        // 有界等尾响应：期间仍在读 update / 尾 usage。
        if (state.turn && !state.turn.ended) {
          await new Promise(resolveTail => {
            const turn = state.turn
            const timer = setTimeout(resolveTail, settings.cancelResponseGraceMs)
            turn.waiters.push(() => {
              clearTimeout(timer)
              resolveTail()
            })
          })
        }
        finalizeTurnUnknown('canceled')
        // 已受理的成功结果优先于迟到的 cancel（等一个微任务让 gate 的 then 落位）。
        await Promise.resolve()
        const accepted = state.gateAccepted
        if (accepted) {
          await finishSuccess()
        }
        else {
          await finishFailure({
            ok: false,
            code: 'NODE_FINISH_CANCELED',
            message: `ACP 活动被取消（${boundedText(cancelReason, 120)}）`,
          })
        }
        if (!exitedDone) {
          await cleanupResources('cancel-fallback')
          // 另一个结局（provider 错误 / 已受理成功）可能正在同一清理 Promise 上收尾：
          // 先给它一个短窗口，避免迟到 cancel 抢走分类。
          await Promise.race([exited, sleep(1_000)])
        }
        if (!exitedDone) {
          resolveOutcome({
            ok: false,
            code: 'NODE_FINISH_CANCELED',
            message: `ACP 活动被取消（${boundedText(cancelReason, 120)}）`,
            sessionId: state.sessionId,
            reminders: state.reminders,
          })
        }
        return exited
      })().finally(() => {
        cancelPromise = null
      })
      return cancelPromise
    }

    async function disposeHandle(target) {
      if (disposeDone) return
      disposeDone = true
      if (!exitedDone) {
        await cancelHandle(target, 'dispose').catch(() => {})
      }
      if (!exitedDone) {
        await Promise.race([exited, sleep(settings.killTimeoutMs + 1_000)])
      }
      if (!exitedDone) {
        // 不谎报成功：取消结局 + cleanup 如实反映未确认的整组退出。
        await cleanupResources('dispose-forced')
        resolveOutcome({
          ok: false,
          code: 'NODE_FINISH_CANCELED',
          message: 'ACP 句柄释放时仍未确认进程组退出，按取消收口',
          sessionId: state.sessionId,
          reminders: state.reminders,
        })
      }
      await cleanupResources('dispose')
      watchFinalCleanup()
    }

    try {
      runDir = ensurePrivateDir(await fsp.mkdtemp(join(settings.tmpRoot, 'fs-acp-')))
      if (socketPathTooLong(runDir)) {
        throw new AcpAdapterError(
          ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
          `ACP 私有目录的 finish.sock 路径超过 Unix socket 上限（${MAX_UNIX_SOCKET_PATH_BYTES} 字节）：`
            + '不退化到 /tmp，节点零派发',
          { adapterId: ACP_ADAPTER_ID, field: 'runDir', reason: 'socket-path-too-long' },
        )
      }
      channel = await createFinishChannel({
        gate: finishGate,
        dir: runDir,
        maxReminders: settings.reminderLimit,
        onReminder: info => {
          state.reminders = Math.max(state.reminders, Number.isSafeInteger(info.count) ? info.count : 0)
          emitReminder(info)
        },
        onReject: () => {
          state.channelFailed = true
        },
      })
      mapper = createAcpEventMapper({
        ...(emit ? { emit } : {}),
        redact: redactSharedText,
        secrets: [channel.credential, channel.socketPath, runDir,
          ...Object.values(config.env).filter(value => typeof value === 'string' && value.length >= 4)],
      })

      initialProc = {
        child: null,
        group: null,
        kind: 'initial',
      }
      try {
        child = spawn(config.command, config.args, {
          cwd: workspace,
          env: buildChildEnv([config.env]),
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      }
      catch (error) {
        throw new AcpAdapterError(
          ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
          `ACP agent 进程无法启动（${errorText(error)}）：节点零派发`,
          {
            adapterId: ACP_ADAPTER_ID,
            field: 'spawn',
            reason: 'spawn-failed',
            cause: error && error.code ? String(error.code) : 'SPAWN_FAILED',
          },
        )
      }
      initialProc.child = child
      if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        group = supervisor.track(child, { label: `initial:${child.pid}` })
        initialProc.group = group
      }

      child.once('exit', (code, signal) => {
        state.processExited = true
        state.exitCode = code
        state.exitSignal = signal
        try {
          client?.close(new AcpClientError(
            ACP_PROCESS_EXITED,
            `ACP agent 进程退出（code=${code === null ? 'none' : code} signal=${signal || 'none'}）`,
            { reason: 'process-exited', exitCode: code, signal },
          ))
        }
        catch {
          // ignore
        }
      })
      child.once('error', error => {
        if (state.processExited) return
        state.processExited = true
        state.spawnError = error
        try {
          client?.close(new AcpClientError(
            ACP_PROCESS_EXITED,
            `ACP agent 进程启动失败（${errorText(error)}）`,
            { reason: 'spawn-failed', cause: error && error.code ? String(error.code) : 'SPAWN_FAILED' },
          ))
        }
        catch {
          // ignore
        }
      })

      client = await openAcpClient({
        input: child.stdout,
        output: child.stdin,
        requestTimeoutMs: 0,
        onUpdate: params => {
          try {
            mapper.apply({ method: 'session/update', params })
          }
          catch {
            // 投影层自己收敛异常；这里只是兜底。
          }
        },
        onPermission: ({ params, requestId }) => {
          // 结局已定（gate 已受理或已 abort）或已进入关停流程后，任何权限请求一律
          // cancelled：不按策略授权，不产生 allow/deny 决策事件。显式 cancel 之外，
          // finishTailGrace 尾窗内到达的请求也必须走这条路径。
          const outcomeDecided = state.canceled || state.stopping || state.gateAccepted || gateSettled()
          const decision = chooseAcpPermission(params, {
            policy: config.permissionPolicy,
            cancelled: outcomeDecided,
            sessionId: state.sessionId ?? '',
          })
          const selected = decision.outcome.outcome === 'selected'
          const optionId = selected ? decision.outcome.optionId : undefined
          const mappedDecision = selected
            ? (config.permissionPolicy === 'allow' ? 'allow' : 'deny')
            : 'cancelled'
          try {
            mapper.applyPermission({
              params,
              requestId,
              decision: mappedDecision,
              ...(optionId === undefined ? {} : { optionId }),
            })
          }
          catch {
            // 权限事件失败不能拒绝真实应答。
          }
          return decision
        },
        onDiagnostic: () => {},
      })

      // 资源登记：连接 → 通道 → 事件投影 → stdio → runDir（顺序 = 释放顺序）。
      resources.add('acp-client', () => client.close(new AcpClientError(
        ACP_PROCESS_EXITED,
        'ACP 适配器已释放',
        { reason: 'disposed' },
      )))
      resources.add('finish-channel', () => channel.close())
      resources.add('event-mapper', () => {
        try {
          mapper.endTurn()
        }
        catch {
          // ignore
        }
        mapper.dispose()
      })
      resources.add('process-stdio', () => {
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try {
            stream?.destroy?.()
          }
          catch {
            // ignore
          }
        }
      })
      resources.add('run-dir', () => fsp.rm(runDir, { recursive: true, force: true }))

      modelPrompt = buildAcpNodePrompt({ element, ctx: runnerCtx, workspaceRoot: workspace })

      handle = {
        get pid() {
          return child && Number.isSafeInteger(child.pid) ? child.pid : undefined
        },
        get sessionId() {
          return state.sessionId
        },
        get reminders() {
          return state.reminders
        },
        get usage() {
          return undefined
        },
        usageCalls() {
          return ledger ? ledger.usageCalls() : []
        },
        usageSnapshots() {
          return ledger ? ledger.usageSnapshots() : []
        },
        get diagnostics() {
          return redactValue({
            probe: readProbeCache(),
            protocolVersion: 1,
            mode: config.mode,
            permissionPolicy: config.permissionPolicy,
            sessionId: state.sessionId,
            agentInfo: state.agentInfo,
            canceled: state.canceled,
            cancelReason: state.cancelReason,
            reminders: state.reminders,
            handshakeOk: state.handshakeOk,
            process: {
              pid: child && child.pid,
              exited: state.processExited,
              exitCode: state.exitCode,
              signal: state.exitSignal,
              spawnError: state.spawnError && state.spawnError.code ? String(state.spawnError.code) : null,
            },
            channel: {
              contacted: channel.contacted,
              discovered: channel.discovered,
              reminders: channel.reminders,
              mismatch: channel.mismatch,
            },
            client: client.stats,
            events: mapper.diagnostics(),
            ledger: ledger ? { diagnostics: ledger.diagnostics() } : null,
          })
        },
        exited,
        get cleanup() {
          return cleanupSnapshot()
        },
        cleanupFinal,
        cancel: reason => cancelHandle(handle, reason),
        dispose: () => disposeHandle(handle),
      }

      // ctx.signal：活动超时 / 取消统一走 cancelHandle；句柄还没返回时先挂起。
      if (runnerCtx.signal && typeof runnerCtx.signal.addEventListener === 'function') {
        signalListener = () => {
          if (handle) cancelHandle(handle, 'ctx.signal').catch(() => {})
          else pendingAbort = true
        }
        runnerCtx.signal.addEventListener('abort', signalListener, { once: true })
        if (runnerCtx.signal.aborted === true) pendingAbort = true
      }

      // 后台执行 initialize → new → mode → MCP hello+discovery → prompt。
      // 取得真实 child 后立刻返回 handle，不等模型。
      void runConversation().catch(error => {
        // runConversation 自己收敛；这里只兜底，避免 unhandled rejection。
        if (!exitedDone) {
          void finishFailure({
            ok: false,
            code: mapAcpErrorCode(error, { processExited: state.processExited }),
            message: `ACP 适配器后台执行失败：${errorText(error)}`,
          })
        }
      })

      if (pendingAbort) cancelHandle(handle, 'ctx.signal').catch(() => {})

      return handle
    }
    catch (error) {
      // 启动失败（spawn / 建通道 / 连接）：统一清理并挂载体。
      let snapshot = null
      try {
        snapshot = await cleanupResources('start-failed')
      }
      catch {
        snapshot = null
      }
      if (error && typeof error === 'object') {
        if (snapshot) error.cleanup = snapshot
        error.cleanupFinal = cleanupFinal
        if (ledger) {
          try {
            const calls = ledger.usageCalls()
            const snapshots = ledger.usageSnapshots()
            if (calls.length > 0) error.usageCalls = calls
            if (snapshots.length > 0) error.usageSnapshots = snapshots
          }
          catch {
            // ignore
          }
        }
      }
      throw error
    }

    // ---------------------------------------------------------------------
    // 后台会话
    // ---------------------------------------------------------------------

    async function requestControl(method, params) {
      const timeoutMs = Math.max(1, settings.controlTimeoutMs)
      return client.request(method, params, { timeoutMs })
    }

    async function runConversationSteps() {
      const initialize = await requestControl('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: CLIENT_NAME, title: 'DSH ACP Adapter', version: CLIENT_VERSION },
      })
      const meta = readInitializeResult(initialize)
      state.agentInfo = meta.agentInfo
      if (state.canceled) return

      const created = await requestControl('session/new', {
        cwd: workspace,
        mcpServers: [buildFinishMcpServer({ serverPath: settings.serverPath, env: channel.env })],
      })
      const session = readSessionResult(created)
      state.sessionId = session.sessionId
      mapper.bindSession(session.sessionId)
      ledger = createAcpUsageLedger({
        executionId,
        sessionId: session.sessionId,
        agentInfo: meta.agentInfo,
      })

      const selected = selectAcpMode(session.modes, config.mode)
      if (!selected.ok) {
        throw new AcpAdapterError(ACP_MODE_UNAVAILABLE, selected.message, {
          adapterId: ACP_ADAPTER_ID,
          reason: 'mode-unavailable',
          availableModeIds: selected.availableModeIds ?? [],
        })
      }
      state.modeId = selected.modeId
      try {
        await requestControl('session/set_mode', {
          sessionId: session.sessionId,
          modeId: selected.modeId,
        })
      }
      catch (error) {
        throw new AcpAdapterError(ACP_MODE_UNAVAILABLE, `session/set_mode 失败：${errorText(error)}`, {
          adapterId: ACP_ADAPTER_ID,
          reason: 'set-mode-failed',
          cause: mapAcpErrorCode(error, { processExited: state.processExited }),
          rpcCode: rpcCodeOf(error),
        })
      }
      if (state.canceled) return

      const discovery = await waitForFinishDiscovery({
        channel,
        timeoutMs: settings.helloTimeoutMs,
        isCanceled: () => state.canceled,
        didExit: () => state.processExited,
      })
      if (state.canceled) return
      if (discovery !== 'discovered') {
        throw new AcpAdapterError(
          ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
          discovery === 'contacted-only'
            ? 'ACP agent 拉起了 finish MCP（hello）但没有 tools/list discovery：flow_finish_node 没有被证明可见'
            : (discovery === 'exited'
              ? 'ACP agent 在拉起 finish MCP 之前退出：flow_finish_node 通道不存在'
              : `${settings.helloTimeoutMs}ms 内 ACP agent 没有拉起 finish MCP：节点零派发`),
          {
            adapterId: ACP_ADAPTER_ID,
            reason: discovery === 'contacted-only' ? 'agent-mcp-not-discovered' : 'agent-mcp-not-contacted',
            contacted: channel.contacted,
            discovered: channel.discovered,
          },
        )
      }
      state.handshakeOk = true

      await runTurns()
    }

    async function runConversation() {
      try {
        await runConversationSteps()
      }
      catch (error) {
        if (state.canceled || outcomeClaimed || exitedDone) return
        let code = error instanceof AcpAdapterError ? error.code : mapAcpErrorCode(error, { processExited: state.processExited })
        let message = `ACP 会话启动失败：${errorText(error)}`
        let cause = null
        if (!state.handshakeOk && code !== ACP_MODE_UNAVAILABLE && code !== ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE) {
          // §P4：工具握手前失败 → TOOL_UNAVAILABLE（保留原分类作为 cause）。
          cause = code
          code = ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE
          message = `ACP agent 没有建立 flow_finish_node 通道（${cause}）：${errorText(error)}`
        }
        abortGate('startup-failed')
        await finishFailure({
          ok: false,
          code,
          message,
          ...(cause === null ? {} : { error: { code: cause } }),
        })
      }
    }

    async function runTurns() {
      let promptText = modelPrompt
      for (;;) {
        if (state.canceled) {
          // cancel() 负责最终 resolve；turn 循环只退出。
          return
        }
        if (state.processExited && !state.gateAccepted) {
          throw new AcpAdapterError(
            ACP_PROCESS_EXITED,
            `ACP agent 进程已退出（code=${state.exitCode === undefined ? 'none' : state.exitCode}），节点没有完结`,
            {
              adapterId: ACP_ADAPTER_ID,
              reason: 'process-exited',
              ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
              ...(state.exitSignal ? { signal: state.exitSignal } : {}),
            },
          )
        }
        if (finishGate.settled()) {
          if (state.gateAccepted) {
            await finishSuccess()
          }
          else {
            await resolveFromGate()
          }
          return
        }

        const invocationId = state.reminders === 0
          ? `${executionId}:invoke-1`
          : `${executionId}:invoke-r${state.reminders}`
        state.turn = {
          invocationId,
          ended: false,
          response: null,
          waiters: [],
        }
        try {
          mapper.beginTurn(invocationId)
        }
        catch {
          // 投影器异常不能中断协议。
        }
        ledger?.begin(invocationId)

        // gate 受理信号（成功才 resolve；abort 走 resolveFromGate）。
        const gateAcceptedPromise = new Promise(resolveAccepted => {
          const onAccepted = () => resolveAccepted({ kind: 'gate' })
          finishGate.result.then(onAccepted, () => {})
          if (state.gateAccepted) onAccepted()
        })

        let promptPromise
        try {
          promptPromise = client.request('session/prompt', {
            sessionId: state.sessionId,
            prompt: [{ type: 'text', text: promptText }],
          }, { timeoutMs: 0 })
        }
        catch (error) {
          promptPromise = Promise.reject(error)
        }
        const settledPrompt = promptPromise.then(
          response => {
            const turn = state.turn
            if (turn) {
              turn.response = isPlainObject(response) ? response : null
              notifyTurnWaiters()
            }
            return { kind: 'response', response }
          },
          error => {
            notifyTurnWaiters()
            return { kind: 'error', error }
          },
        )

        const first = await Promise.race([settledPrompt, gateAcceptedPromise])
        if (first.kind === 'gate') {
          // 已受理：继续收尾响应最多 finishTailGraceMs，拿尾 usage；拿不到按 unknown。
          const tail = await Promise.race([
            settledPrompt,
            sleep(settings.finishTailGraceMs).then(() => ({ kind: 'tail' })),
          ])
          const turn = state.turn
          if (turn && !turn.ended) {
            turn.ended = true
            if (tail.kind === 'response' && isPlainObject(tail.response)) {
              ledger?.end(turn.invocationId, tail.response)
            }
            else {
              ledger?.sealUnknown(turn.invocationId, 'usage-unavailable')
            }
            try {
              mapper.endTurn()
            }
            catch {
              // ignore
            }
            notifyTurnWaiters()
          }
          await finishSuccess()
          return
        }

        if (first.kind === 'error') {
          const error = first.error
          if (state.canceled) {
            finalizeTurnUnknown('canceled')
            return
          }
          if (state.gateAccepted) {
            finalizeTurnUnknown('gate-accepted')
            await finishSuccess()
            return
          }
          if (!state.turn || !state.turn.ended) {
            ledger?.sealUnknown(invocationId, 'usage-unavailable')
            try {
              mapper.endTurn()
            }
            catch {
              // ignore
            }
            if (state.turn) state.turn.ended = true
            notifyTurnWaiters()
          }
          const code = mapAcpErrorCode(error, { processExited: state.processExited })
          abortGate(code)
          await finishFailure({
            ok: false,
            code,
            message: `ACP prompt 失败（${code}）：${errorText(error)}`,
            error: {
              code,
              ...(rpcCodeOf(error) === null ? {} : { rpcCode: rpcCodeOf(error) }),
            },
          })
          return
        }

        const response = isPlainObject(first.response) ? first.response : {}
        const turn = state.turn
        turn.response = response
        const stopReason = response.stopReason
        const stopped = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']

        if (state.canceled) {
          turn.ended = true
          ledger?.end(invocationId, response)
          try {
            mapper.endTurn()
          }
          catch {
            // ignore
          }
          notifyTurnWaiters()
          return
        }
        if (state.gateAccepted || finishGate.settled()) {
          turn.ended = true
          ledger?.end(invocationId, response)
          try {
            mapper.endTurn()
          }
          catch {
            // ignore
          }
          notifyTurnWaiters()
          await finishSuccess()
          return
        }

        if (typeof stopReason !== 'string' || !stopped.includes(stopReason)) {
          turn.ended = true
          ledger?.end(invocationId, response)
          try {
            mapper.endTurn()
          }
          catch {
            // ignore
          }
          notifyTurnWaiters()
          abortGate('unknown-stop-reason')
          await finishFailure({
            ok: false,
            code: ACP_PROTOCOL_ERROR,
            message: `ACP prompt 返回未知 stopReason=${boundedText(stopReason, 64) || 'missing'}`,
          })
          return
        }

        if (stopReason === 'cancelled') {
          turn.ended = true
          ledger?.end(invocationId, response)
          try {
            mapper.endTurn()
          }
          catch {
            // ignore
          }
          notifyTurnWaiters()
          abortGate('stop-cancelled')
          await finishFailure({
            ok: false,
            code: 'NODE_FINISH_CANCELED',
            message: 'ACP prompt 返回 stopReason="cancelled"',
          })
          return
        }

        if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
          turn.ended = true
          ledger?.end(invocationId, response)
          try {
            mapper.endTurn()
          }
          catch {
            // ignore
          }
          notifyTurnWaiters()
          abortGate(stopReason)
          await finishFailure({
            ok: false,
            code: ACP_LIMIT_REACHED,
            message: `ACP agent 以 ${stopReason} 停止：本轮预算耗尽，节点没有完结`,
          })
          return
        }

        if (stopReason === 'refusal') {
          turn.ended = true
          ledger?.end(invocationId, response)
          try {
            mapper.endTurn()
          }
          catch {
            // ignore
          }
          notifyTurnWaiters()
          abortGate('refusal')
          await finishFailure({
            ok: false,
            code: ACP_PROVIDER_ERROR,
            message: 'ACP agent 明确拒绝（stopReason="refusal"）：节点没有完结',
          })
          return
        }

        // end_turn 且 gate 未受理：本轮收账，然后由完成通道的 remind 唯一计数。
        turn.ended = true
        ledger?.end(invocationId, response)
        try {
          mapper.endTurn()
        }
        catch {
          // ignore
        }
        notifyTurnWaiters()

        if (state.channelFailed) {
          abortGate('channel-failed')
          await finishFailure({
            ok: false,
            code: 'NODE_FINISH_CHANNEL_FAILED',
            message: '完成通道不可用（凭据 / IPC 失败），节点没有完结',
          })
          return
        }

        let reminded
        try {
          reminded = await channel.invoke('remind', { sessionId: state.sessionId })
        }
        catch (error) {
          abortGate('channel-remind-failed')
          await finishFailure({
            ok: false,
            code: 'NODE_FINISH_CHANNEL_FAILED',
            message: `完成通道提醒失败：${errorText(error)}`,
          })
          return
        }
        if (!reminded || reminded.ok !== true) {
          abortGate('channel-remind-failed')
          await finishFailure({
            ok: false,
            code: 'NODE_FINISH_CHANNEL_FAILED',
            message: '完成通道提醒失败：节点没有完结',
          })
          return
        }
        if (reminded.action === 'none') {
          if (state.gateAccepted) await finishSuccess()
          else await resolveFromGate()
          return
        }
        if (reminded.action === 'exhausted') {
          abortGate('finish-tool-missing')
          await finishFailure({
            ok: false,
            code: 'NODE_FINISH_MISSING',
            message: 'agent 停下但没有调用 flow_finish_node，节点没有完结（提醒预算已耗尽）',
          })
          return
        }
        if (reminded.action !== 'remind') {
          abortGate('channel-remind-failed')
          await finishFailure({
            ok: false,
            code: 'NODE_FINISH_CHANNEL_FAILED',
            message: '完成通道返回了未知的提醒动作，节点没有完结',
          })
          return
        }
        state.reminders = Number.isSafeInteger(reminded.count)
          ? Math.max(state.reminders, reminded.count)
          : state.reminders
        promptText = nonEmptyString(reminded.text) ? reminded.text : FINISH_REMINDER_TEXT
      }
    }

    /** gate 已被 abort / settle 但没有成功记录：按真实原因收口。 */
    async function resolveFromGate() {
      try {
        const record = await finishGate.result
        state.record = record
        state.gateAccepted = true
        await finishSuccess()
      }
      catch (error) {
        if (state.canceled) {
          await finishFailure({
            ok: false,
            code: 'NODE_FINISH_CANCELED',
            message: `ACP 活动被取消（${boundedText(state.cancelReason || '', 120)}）`,
          })
          return
        }
        await finishFailure({
          ok: false,
          code: error && typeof error.code === 'string' ? error.code : 'NODE_FINISH_ABORTED',
          message: errorText(error),
        })
      }
    }
  }

  // gate.result 一受理就标记（resolveFromGate / cancel 的优先级判断共用）。
  // 这里没有 finishGate 引用：start 内部注册（见 startAttempt 的 finishGate.result.then）。
  // 该函数在 startAttempt 内被替换为带闭包的实现。

  return {
    id: ACP_ADAPTER_ID,
    probe,
    capabilities,
    invalidateProbe,
    start,
    /**
     * 0.13.10 可选消息能力：ACP 首发没有轮次中投递，固定 unsupported。
     */
    async deliverMessage() {
      return {
        ok: false,
        unsupported: true,
        deliveryUnknown: true,
        code: ACP_MESSAGE_DELIVERY_UNSUPPORTED,
        error: 'ACP 首发不支持轮次中投递',
      }
    },
    cancel: (handle, reason) => (handle && typeof handle.cancel === 'function'
      ? handle.cancel(reason)
      : Promise.reject(new AcpAdapterError(
        ADAPTER_ERROR.INVALID,
        'cancel 需要 start() 返回的 handle',
        { adapterId: ACP_ADAPTER_ID, field: 'handle', reason: 'missing' },
      ))),
    dispose: handle => (handle && typeof handle.dispose === 'function'
      ? handle.dispose()
      : Promise.resolve()),
  }
}

export default createAcpAdapter
