/**
 * Codex CLI 适配器（0.13.1，A4）。
 *
 * 契约：`src/agent-adapter.js` 的冻结接口 + `docs/design/11-node-finish-tool.md`：
 *
 *   - `flow_finish_node` 由本插件自带的 MCP stdio server（`node-finish-mcp.js`）提供，
 *     `codex exec` 通过**本次进程的** `-c mcp_servers.*` argv 配置加载它——不拼 shell、
 *     不改用户全局 `~/.codex/config.toml`、也不改 `<workspace>/.codex/`；
 *   - 是否完结**只以 gate 收到 submit 为准**（通道信号），不解析 stdout 里的工具名，
 *     不写完成标记文件；
 *   - 节点提示词以 `element.node.prompt` / `element.node.roleCard` 为准（与 DSH 适配器的
 *     `nodePromptBody` 等价），并带上 `attempt` 与 `ctx.variables`；BPMN 的
 *     `element.description` 只作「补充信息」，不会替代任务本体（B2）；
 *   - 提醒机制：**默认 `emulated`**（`codex exec resume <session-id>` 进程级续跑）。
 *     只有调用方显式传 `settings.stopHook === 'native'` 时才注入原生 `Stop` hook
 *     （`decision:"block"` + `reason`）并标 `native`；该 native 结论是**手工隔离探测**
 *     得出的，**不是 probe 实测**，需人工 / 发布验证。`probe().hooksNative===false` 且
 *     `probe().resume===false` 时能力表标 `unsupported`（m5 / M7）；
 *   - 模型与沙箱显式 pin：`-m <model>`（`element.node.model` / `agentOptions.model`）、
 *     `exec` 用 `-s <sandbox>` 与 `-c approval_policy="<policy>"`（`codex exec` 没有
 *     `-a` flag，`approval_policy` 是同一配置项的等价写法）；`exec resume` 没有 `-s`，
 *     改用 `-c sandbox_mode="<sandbox>"`。默认 `workspace-write` / `never`，可被
 *     `settings.sandbox` / `settings.approvalPolicy` 覆盖。
 *     **未做 `--ignore-user-config` / 独立 `CODEX_HOME` 隔离**：用户
 *     `~/.codex/config.toml` 的其它项（hooks / mcp_servers / 其它设置）仍会作用到
 *     每个 codex 节点（M6，能力 evidence 里同样如实写）；
 *   - 凭据与私有 socket 放在 `$FLOW_STUDIO_TMP` 或 `os.tmpdir()/flow-studio` 下的
 *     `fs-codex-*`（0700），结束时清理；凭据只进 codex 子进程环境变量
 *     （`env_vars` 显式传给 MCP server），不进 argv、不进提示词、不写日志；
 *   - 子进程环境走**白名单**（`PATH` / `HOME` / `TMPDIR` / 代理 / provider key /
 *     `LANG` / `LC_*` / `CODEX_*` / `SHELL` + `settings.env` + 本 execution 的通道
 *     env），不继承宿主整个 `process.env`（M5）；
 *   - `handle.events` / `handle.lastMessage` / `handle.stdoutTail` / `stderrTail` 在
 *     **导出时**做脱敏：本 execution 的 token、socket 路径、runDir 路径替换成
 *     `[redacted]`。原始事件仍保留在适配器内存里（诊断需要），只是不再原样外泄（M4）；
 *   - `cancel` 杀**整个进程组**（codex + 它拉起的 MCP server 子进程），不留孤儿；
 *     Windows 用 `taskkill /T /F /PID`（没有 POSIX 进程组，M8）；取消 / MISSING 都会
 *     `finishGate.abort(...)`，迟到 submit 得到 `NODE_ALREADY_SETTLED`（M3）；
 *   - `error` / `exit` 监听在 spawn 之后、等 MCP hello 之前就挂上；握手期取消会立刻
 *     收口（`exited={ok:false,code:'NODE_FINISH_CANCELED'}`）、清理 socket / runDir；
 *     `dispose()` 用**有界** grace 等退出，绝不 await 一个 pending 的 `exited`（B1）。
 *
 * 实测证据（2026-11-11，codex-cli 0.167.0）：
 *   - 手工隔离探测：`codex exec --json` 里注入 `hooks.Stop` + `--dangerously-bypass-hook-trust`，
 *     Stop hook 返回 `{"decision":"block","reason":...}` 会真的产生第二个 agent turn
 *     （`item.completed.agent_message` 两条），第二把 Stop 的 stdin 带
 *     `stop_hook_active:true`。该结论**未经 probe 自动复测**，只作为 `stopHook:'native'`
 *     显式启用时的 evidence；
 *   - `codex mcp list --json -c mcp_servers.<name>.command=...` 能读到本适配器生成的
 *     MCP 配置（probe 用它验证 CLI 接受同一份配置形状，且顺带验证
 *     `sandbox_mode` / `approval_policy` 配置项被解析）。
 *
 * @module @feiyueve/dsh-flow-studio/agent-adapter-codex
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, promises as fsp, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AdapterError, ADAPTER_ERROR } from './agent-adapter.js'
import { createProcessGroupSupervisor, createResourceRegistry } from './agent-cli-lifecycle.js'
import { attachProcessStreams, createUtf8LineReader } from './agent-cli-stream.js'
import {
  FINISH_CHANNEL_ENV,
  FINISH_REMINDER_TEXT,
  createFinishChannel,
  defaultTmpRoot,
  verifyFinishBridge,
} from './node-finish-mcp.js'
import { redactText as redactSharedText } from './process-output.js'

/** 适配器 id（注册表 / 运行日志 / admission 都用它）。 */
export const CODEX_ADAPTER_ID = 'codex'

/** 默认最多提醒次数（11 §3.1：默认 3 次）。 */
export const CODEX_REMINDER_LIMIT = 3

/** 这个适配器声明的工具通道（文档与能力表共用一份说法）。 */
export const CODEX_FINISH_TOOL_EVIDENCE = 'mcp-stdio flow_finish_node via per-execution local IPC credential'

/**
 * Stop hook 的手工证据（**不是 probe 实测**；只在显式 `stopHook:'native'` 时引用）。
 * 背景要求 hooks 与 finishTool 一样是实测结果——这里如实标注需要人工 / 发布验证。
 */
export const CODEX_STOP_HOOK_EVIDENCE = 'codex-cli 0.167.0：Stop hook decision:block 在 codex exec --json 里'
  + '产生过第二个 agent turn（手工隔离探测 2026-11-11；**不是 probe 实测**，需人工/发布验证）'

/** 用户全局配置仍会生效（未做 `--ignore-user-config` / 独立 `CODEX_HOME` 隔离）。 */
export const CODEX_USER_CONFIG_EVIDENCE = '用户 ~/.codex/config.toml 的其它项（hooks / mcp_servers / 其它设置）'
  + '仍会作用到本适配器启动的 codex 进程；未用 --ignore-user-config / 独立 CODEX_HOME 隔离（M6，已知限制）'

/** `codex exec` 支持的沙箱模式（`--sandbox` / `-s`；resume 用配置键 `sandbox_mode`）。 */
export const CODEX_SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

/** `approval_policy` 允许值（codex 0.167 的枚举；`-c approval_policy="..."`）。 */
export const CODEX_APPROVAL_POLICIES = Object.freeze([
  'untrusted', 'on-failure', 'on-request', 'granular', 'never',
])

const SANDBOX_MODE_SET = new Set(CODEX_SANDBOX_MODES)
const APPROVAL_POLICY_SET = new Set(CODEX_APPROVAL_POLICIES)
const MODEL_PATTERN = /^[\x21-\x7e][\x20-\x7e]{0,127}$/

const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'node-finish-mcp.js')
const HOOK_SCRIPT_NAME = 'finish-stop-hook.mjs'

/**
 * M3 分帧 / 诊断上限（review-0142b）：
 *   - 协议单行上限按**原始字节**执行（8 MiB，与共享 reader 默认值一致）；600 KiB 的
 *     合法单行必须能完整解析。
 *   - `events` 是**诊断缓存**，保留 200 条并显式标记截断（`eventsTruncated`）。
 *   - 计量账本（`usageCalls`）**不受**这个上限约束（m2）：201 轮就是 201 条调用。
 *   - 协议错误 / 流诊断各自有界，只记位置、长度、类型；正文与凭据不落诊断。
 */
const EVENT_CACHE_LIMIT = 200
const PROTOCOL_ERROR_LIMIT = 20
const DIAGNOSTIC_LIMIT = 50
const STREAM_MAX_LINE_BYTES = 8 * 1024 * 1024
const MAX_TERMINAL_MESSAGE = 300
/**
 * F2：终态错误最终 UTF-8 字节上限（code / 详情 / message 都不超过它）。
 * Codex 的 `turn.failed.error.code` 不可信：实测能构造出 12 KB 的异常 message。
 */
const MAX_TERMINAL_ERROR_BYTES = 1_000
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000

/**
 * Stop hook 脚本：从 stdin 读 codex 的 hook 事件，经本地完成通道问「要不要提醒」，
 * 把通道的结论翻成 codex 的 Stop hook 输出。**永远 exit 0**：hook 自身出错不能把
 * agent 卡死；真正的提醒次数与「已完结」判定都在 adapter 进程里。
 */
const HOOK_SCRIPT_SOURCE = `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'

function writeAndExit(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n', () => process.exit(0))
}

let event = {}
try {
  event = JSON.parse(readFileSync(0, 'utf8') || '{}')
} catch {
  event = {}
}
const socketPath = process.env.FLOW_STUDIO_FINISH_SOCKET
const token = process.env.FLOW_STUDIO_FINISH_TOKEN
if (!socketPath || !token) writeAndExit({})

let done = false
const socket = connect(socketPath)
const timer = setTimeout(() => {
  try { socket.destroy() } catch {}
  writeAndExit({})
}, 5000)
timer.unref?.()

function finish(response) {
  if (done) return
  done = true
  clearTimeout(timer)
  try { socket.destroy() } catch {}
  if (response && response.ok === true && response.action === 'remind' && typeof response.text === 'string') {
    writeAndExit({ decision: 'block', reason: response.text })
  } else {
    writeAndExit({})
  }
}

let buffer = ''
socket.on('connect', () => {
  socket.write(JSON.stringify({
    v: 1,
    token,
    op: 'remind',
    args: {
      sessionId: typeof event.session_id === 'string' ? event.session_id : undefined,
      turnId: typeof event.turn_id === 'string' ? event.turn_id : undefined,
      stopHookActive: event.stop_hook_active === true,
    },
  }) + '\\n')
})
socket.on('data', chunk => {
  buffer += chunk
  const index = buffer.indexOf('\\n')
  if (index < 0) return
  try {
    finish(JSON.parse(buffer.slice(0, index)))
  } catch {
    finish(null)
  }
})
socket.on('error', () => finish(null))
socket.on('close', () => finish(null))
`

/** 带结构化错误码的适配器错误。 */
export class CodexAdapterError extends AdapterError {
  constructor(code, message, details) {
    super(code, message, details)
    this.name = 'CodexAdapterError'
  }
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function tomlString(value) {
  // JSON 字符串字面量同时是合法的 TOML basic string（转义规则一致）。
  return JSON.stringify(String(value))
}

function tomlStringArray(values) {
  return `[${values.map(value => tomlString(value)).join(',')}]`
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text))
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), raw: match[0] }
}

function versionAtLeast(version, major, minor, patch = 0) {
  if (!version) return false
  if (version.major !== major) return version.major > major
  if (version.minor !== minor) return version.minor > minor
  return version.patch >= patch
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(dir, 0o700)
  return dir
}

/** 有界等待用的定时器：**不 unref**——兜底计时必须能可靠触发（B1）。 */
function sleep(ms) {
  return new Promise(resolveSleep => {
    setTimeout(resolveSleep, ms)
  })
}

function quoteShellArg(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`
}

/**
 * 传给 codex 子进程的环境白名单（M5）。
 *
 * 只放 codex / 模型 provider 真正需要的东西：可执行查找、HOME / 临时目录、代理、
 * provider key、locale、`CODEX_*`、shell。宿主进程里的其它变量（各类内部令牌、
 * 事故哨兵等）**不继承**——codex 的 shell_snapshot 会把环境暴露给模型执行的命令。
 */
const CHILD_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'USER', 'LOGNAME', 'TERM',
  'LANG', 'LANGUAGE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  // Windows 必需的最小系统变量（HOME/PATH 之外 codex 与 node 启动要用）。
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'HOMEDRIVE', 'HOMEPATH', 'WINDIR',
])
const CHILD_ENV_PREFIXES = Object.freeze(['LC_', 'CODEX_'])

/** 白名单 + 显式传入的额外 env（`settings.env` / `channel.env`）。 */
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

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

function nonEmptyTrimmedString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

function nonNegativeIntOr(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/**
 * F2：按 UTF-8 字节截断并显式标记（不按 UTF-16 单元切，避免半个代理对）。
 */
function truncateUtf8Bytes(text, limit) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (Buffer.byteLength(value, 'utf8') <= limit) return value
  const marker = '…[truncated]'
  const budget = Math.max(0, limit - Buffer.byteLength(marker, 'utf8'))
  let output = ''
  let used = 0
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > budget) break
    output += char
    used += size
  }
  return `${output}${marker}`
}

/**
 * 把「节点模型」解析成一个可传给 `-m` 的字符串（M6）。
 *
 * 取值优先级与 DSH 适配器的 `resolveAgentOptions` 对齐：
 * `options.model` / `settings.agentOptions` → `ctx.agentOptions` → `node.agentOptions`
 * → `node.model`。字符串直接用；对象取 `.model`。
 *
 * @returns {string|null}
 */
function resolveNodeModel(settings, ctx, element) {
  const node = isPlainObject(element && element.node) ? element.node : {}
  const candidates = [
    settings.model,
    settings.agentOptions,
    ctx && ctx.agentOptions,
    node.agentOptions,
    node.model,
  ]
  for (const candidate of candidates) {
    const raw = typeof candidate === 'string' ? candidate : (isPlainObject(candidate) ? candidate.model : undefined)
    const model = nonEmptyTrimmedString(raw)
    if (model === '') continue
    if (!MODEL_PATTERN.test(model)) {
      throw new CodexAdapterError(
        ADAPTER_ERROR.INVALID,
        `节点模型标识非法（只允许 1–128 个可见 ASCII 字符）：${JSON.stringify(model.slice(0, 40))}`,
        { adapterId: CODEX_ADAPTER_ID, field: 'model', reason: 'invalid-model' },
      )
    }
    return model
  }
  return null
}

/** 校验枚举选项；只在调用方显式提供时校验（默认值永远是合法的）。 */
function normalizeChoice(value, allowed, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new CodexAdapterError(
      ADAPTER_ERROR.INVALID,
      `Codex 适配器选项 ${field} 非法：${JSON.stringify(value)}（允许：${[...allowed].join(' / ')}）`,
      { adapterId: CODEX_ADAPTER_ID, field, reason: 'invalid-value' },
    )
  }
  return value
}

/**
 * 跑一次 codex 子命令（probe 用），带超时；失败收敛成结果对象，不抛异常。
 * 子进程环境同样走白名单（M5），并叠加 `options.env`（测试 / 特殊接线）。
 *
 * M3：stdout 解析改用共享的 `createUtf8LineReader` + `attachProcessStreams`——
 *   - UTF-8 多字节字符跨 chunk 不再变成 U+FFFD（旧实现 `stdout += chunk`）；
 *   - `exit` 后先等 stdout 排空（有界）再结算，合法 JSON 缺尾换行也能读到；
 *   - 单行上限按原始字节执行，不是按展示 tail 裁剪。
 */
function runOnce(command, args, options = {}) {
  return new Promise(resolvePromise => {
    let settled = false
    let timer = null
    let child
    let streams = null
    const stdoutLines = []
    let stdoutBytes = 0
    const drainTimeoutMs = nonNegativeIntOr(options.drainTimeoutMs, 2_000)
    const stdout = () => stdoutLines.join('\n')
    const stderrText = () => (streams ? streams.stderrTail() : '')
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    try {
      child = spawn(command, args, {
        env: buildChildEnv([isPlainObject(options.env) ? options.env : {}]),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ ok: false, code: error && error.code ? String(error.code) : 'SPAWN_FAILED', stdout: '', stderr: '' })
      return
    }
    const stdoutReader = createUtf8LineReader({
      onLine: line => {
        if (stdoutBytes >= 2 * 1024 * 1024) return
        stdoutBytes += Buffer.byteLength(line, 'utf8') + 1
        stdoutLines.push(line)
      },
    })
    streams = attachProcessStreams(child, {
      stdoutReader,
      stdoutTailBytes: 8 * 1024,
      stderrTailBytes: 256 * 1024,
      drainTimeoutMs,
    })
    const limit = options.timeoutMs || 20_000
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      finish({ ok: false, code: 'TIMEOUT', stdout: stdout(), stderr: stderrText() })
    }, limit)
    timer.unref?.()
    child.on('error', error => {
      finish({
        ok: false,
        code: error && error.code ? String(error.code) : 'SPAWN_FAILED',
        stdout: stdout(),
        stderr: stderrText(),
      })
    })
    child.on('exit', (code, signal) => {
      // M3：先等协议 reader 排空（有界），再按退出码结算。
      streams.drained.then(result => {
        finish({
          ok: code === 0,
          code: code === null ? 'SIGNAL' : String(code),
          signal,
          stdout: stdout(),
          stderr: stderrText(),
          outputDrained: Boolean(result && result.drained === true),
        })
      }, () => {
        finish({ ok: false, code: 'DRAIN_FAILED', stdout: stdout(), stderr: stderrText() })
      })
    })
  })
}

/** 11 §6 的完结契约（与 DSH 适配器同一份语义）。 */
const CODEX_FINISH_PROMPT_CONTRACT = Object.freeze([
  '做完本节点的活、要往下流转时，必须调用工具 flow_finish_node：',
  '  variables  后续网关要用的短变量（只能是 boolean / number / 短字符串 / null，禁止大对象）',
  '  documents  你写下的文件的相对路径清单（正文在文件里，不要塞进 variables）',
  '  summary    一句话说明本节点做了什么',
  '不调用该工具就不算完结，流程不会往下走。',
])

/**
 * 构造给 codex 的节点提示词（B2）。
 *
 * 任务本体来自 `element.node.prompt` / `element.node.roleCard`（与 DSH 适配器的
 * `nodePromptBody` 等价）；`element.description` 是 BPMN 元素的描述，**只能作补充**，
 * 不能替代任务。同时注入 `ctx.attempt` 与短变量 `ctx.variables`。
 *
 * @param {{ element: object, ctx?: object, workspaceRoot: string }} input
 * @returns {string}
 */
function buildCodexNodePrompt({ element, ctx, workspaceRoot }) {
  const node = isPlainObject(element && element.node) ? element.node : {}
  const name = nonEmptyTrimmedString(element && element.name)
    || nonEmptyTrimmedString(element && element.id)
    || '当前节点'
  const body = [node.prompt, node.roleCard]
    .map(nonEmptyTrimmedString)
    .filter(value => value !== '')
  const description = nonEmptyTrimmedString(element && element.description)
  const attempt = Number.isSafeInteger(ctx && ctx.attempt) && ctx.attempt >= 1 ? ctx.attempt : 1
  const variables = isPlainObject(ctx && ctx.variables) ? ctx.variables : {}
  const serialized = safeJson(variables)
  const lines = []
  if (body.length > 0) {
    lines.push(body.join('\n\n'))
  } else {
    lines.push(`你是流程节点「${name}」的执行 agent。`)
  }
  if (description !== '') {
    lines.push(`BPMN 元素描述（补充信息，不是任务本体）：\n${description}`)
  }
  lines.push(`执行上下文：attempt=${attempt}`)
  if (serialized !== '{}' && serialized.length <= 4_000) {
    lines.push(`当前变量：\n${serialized}`)
  }
  lines.push(CODEX_FINISH_PROMPT_CONTRACT.join('\n'))
  lines.push(`工作区（documents.path 的相对基准）：${workspaceRoot}`)
  return lines.join('\n\n')
}

/** 生成 `codex exec` / `codex exec resume` 共用的 MCP + hook 配置参数。 */
function buildExecutionConfigs({ serverPath, hookScriptPath, approvalPolicy }) {
  const configs = []
  const add = value => configs.push('-c', value)
  // M6：`codex exec` 没有 `-a/--ask-for-approval` flag；`approval_policy` 是同一配置项
  // 的等价写法（非法枚举会被 CLI 直接拒绝，probe 用 mcp list 顺带验证）。
  add(`approval_policy=${tomlString(approvalPolicy)}`)
  add(`mcp_servers.flow_finish.command=${tomlString(process.execPath)}`)
  add(`mcp_servers.flow_finish.args=${tomlStringArray([serverPath])}`)
  add(`mcp_servers.flow_finish.env_vars=${tomlStringArray([
    FINISH_CHANNEL_ENV.token,
    FINISH_CHANNEL_ENV.socket,
  ])}`)
  add('mcp_servers.flow_finish.startup_timeout_sec=20')
  add('mcp_servers.flow_finish.tool_timeout_sec=600')
  // codex 默认把自定义 MCP 工具当「需要审批」；非交互 exec 的 approval policy 是 never，
  // 不显式改成 approve 的话工具调用会被拒绝（实测：MCP tool call requires approval）。
  add('mcp_servers.flow_finish.default_tools_approval_mode="approve"')
  add('mcp_servers.flow_finish.enabled_tools=["flow_finish_node"]')
  if (hookScriptPath) {
    const command = `${quoteShellArg(process.execPath)} ${quoteShellArg(hookScriptPath)}`
    add(`hooks.Stop=[{hooks=[{type="command",command=${tomlString(command)},timeout=30}]}]`)
    add('features.hooks=true')
  }
  return configs
}

function buildExecArgs({
  workspaceRoot, prompt, serverPath, hookScriptPath, sandbox, approvalPolicy, model,
}) {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C', workspaceRoot,
    ...(model ? ['-m', model] : []),
    // M6：显式 pin 沙箱，不依赖用户全局 config.toml。
    '-s', sandbox,
    ...buildExecutionConfigs({ serverPath, hookScriptPath, approvalPolicy }),
    ...(hookScriptPath ? ['--dangerously-bypass-hook-trust'] : []),
    prompt,
  ]
}

function buildResumeArgs({
  sessionId, prompt, serverPath, hookScriptPath, sandbox, approvalPolicy, model,
}) {
  return [
    'exec',
    'resume',
    sessionId,
    '--json',
    '--skip-git-repo-check',
    ...(model ? ['-m', model] : []),
    // `codex exec resume` 没有 `--sandbox`；用同一配置键 pin（非法值会被 CLI 拒绝）。
    '-c', `sandbox_mode=${tomlString(sandbox)}`,
    ...buildExecutionConfigs({ serverPath, hookScriptPath, approvalPolicy }),
    ...(hookScriptPath ? ['--dangerously-bypass-hook-trust'] : []),
    prompt,
  ]
}

/**
 * 创建一个 Codex 适配器。
 *
 * @param {object} [options]
 * @param {string} [options.codexBin] codex 可执行（默认 `codex`，走 PATH）
 * @param {string} [options.tmpRoot] 私有临时根（默认 `$FLOW_STUDIO_TMP` 或 `os.tmpdir()/flow-studio`，0700）
 * @param {number} [options.reminderLimit] 最多提醒次数（默认 3）
 * @param {number} [options.postFinishGraceMs] 工具完成后等进程自然退出的宽限（默认 5000）
 * @param {number} [options.killTimeoutMs] SIGTERM → SIGKILL 的间隔（默认 3000）
 * @param {number} [options.drainTimeoutMs] 子进程退出后等 stdout 排空的上限（默认 5000；
 *   超时标记 `outputIncomplete` 并记诊断，绝不无限等待）
 * @param {number} [options.helloTimeoutMs] 等 MCP server 起来的超时（默认 20000）
 * @param {number} [options.probeTimeoutMs] probe 的总超时（默认 60000；每条子命令共用这个上限）
 * @param {number} [options.probeCacheTtlMs] probe 缓存 TTL（默认 600000；0 = 不过期）
 * @param {'auto'|'native'|'emulated'} [options.stopHook] 提醒机制（默认 `auto` = emulated；
 *   只有显式传 `native` 才注入原生 Stop hook 并标 native）
 * @param {string} [options.sandbox] `codex exec -s` 沙箱模式（默认 workspace-write）
 * @param {string} [options.approvalPolicy] `approval_policy` 配置值（默认 never）
 * @param {string} [options.model] 默认模型（可被 element.node.model / agentOptions.model 覆盖）
 * @param {object} [options.agentOptions] 默认模型路由（取 `.model`）
 * @param {NodeJS.ProcessEnv} [options.env] 额外注入 codex 子进程的环境变量（测试 / 特殊接线）
 * @param {object} [options.probeResult] 注入 probe 结果（测试 / 上层缓存用）
 * @param {boolean} [options.selfTest] probe 是否跑一次真实 MCP 往返（默认 true）
 */
export function createCodexAdapter(options = {}) {
  const settings = {
    codexBin: typeof options.codexBin === 'string' && options.codexBin !== '' ? options.codexBin : 'codex',
    // m6：默认**不能**落在插件安装目录（pnpm store / 只读安装会 mkdir 失败）。
    tmpRoot: typeof options.tmpRoot === 'string' && options.tmpRoot !== ''
      ? resolve(options.tmpRoot)
      : defaultTmpRoot(),
    reminderLimit: Number.isSafeInteger(options.reminderLimit) && options.reminderLimit >= 0
      ? options.reminderLimit
      : CODEX_REMINDER_LIMIT,
    postFinishGraceMs: Number.isSafeInteger(options.postFinishGraceMs) && options.postFinishGraceMs >= 0
      ? options.postFinishGraceMs
      : 5_000,
    killTimeoutMs: Number.isSafeInteger(options.killTimeoutMs) && options.killTimeoutMs >= 0
      ? options.killTimeoutMs
      : 3_000,
    drainTimeoutMs: nonNegativeIntOr(options.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS),
    helloTimeoutMs: Number.isSafeInteger(options.helloTimeoutMs) && options.helloTimeoutMs >= 0
      ? options.helloTimeoutMs
      : 20_000,
    probeTimeoutMs: Number.isSafeInteger(options.probeTimeoutMs) && options.probeTimeoutMs >= 1_000
      ? options.probeTimeoutMs
      : 60_000,
    probeCacheTtlMs: Number.isSafeInteger(options.probeCacheTtlMs) && options.probeCacheTtlMs >= 0
      ? options.probeCacheTtlMs
      : 10 * 60_000,
    stopHook: options.stopHook === 'native' || options.stopHook === 'emulated' ? options.stopHook : 'auto',
    sandbox: normalizeChoice(options.sandbox, SANDBOX_MODE_SET, 'workspace-write', 'sandbox'),
    approvalPolicy: normalizeChoice(options.approvalPolicy, APPROVAL_POLICY_SET, 'never', 'approvalPolicy'),
    model: typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : undefined,
    agentOptions: isPlainObject(options.agentOptions) ? options.agentOptions : undefined,
    // 测试 / 故障注入：替换真实进程回收实现。生产不传，走共享的进程组 supervisor。
    killImpl: typeof options.killImpl === 'function' ? options.killImpl : null,
    env: isPlainObject(options.env) ? options.env : {},
    selfTest: options.selfTest !== false,
  }

  /** @type {{ value: object, at: number }|null} */
  let probeCache = isPlainObject(options.probeResult)
    ? { value: { ...options.probeResult }, at: Date.now() }
    : null
  let probePromise = null

  /** 读 probe 缓存（过 TTL 当没有；m9）。 */
  function readProbeCache() {
    if (!probeCache) return null
    const ttl = settings.probeCacheTtlMs
    if (ttl > 0 && Date.now() - probeCache.at >= ttl) {
      probeCache = null
      return null
    }
    return probeCache.value
  }

  const probeInvalid = (reason, message, details) => new CodexAdapterError(
    ADAPTER_ERROR.PROBE_INVALID,
    message,
    { adapterId: CODEX_ADAPTER_ID, field: 'probe', reason, ...(details || {}) },
  )

  /** 真正跑一遍 CLI 探测；任何一项不可用都抛 `ADAPTER_PROBE_INVALID`（M2）。 */
  async function probeOnce() {
    const commandTimeoutMs = settings.probeTimeoutMs
    const run = (args, extra) => runOnce(settings.codexBin, args, {
      env: settings.env,
      timeoutMs: commandTimeoutMs,
      ...(extra || {}),
    })

    const versionResult = await run(['--version'])
    if (!versionResult.ok) {
      throw probeInvalid(
        'cli-unavailable',
        `codex --version 失败（${versionResult.code}）：CLI 不可用，适配器不能提供 flow_finish_node`,
        { cause: versionResult.code },
      )
    }
    const version = parseVersion(versionResult.stdout || versionResult.stderr)
    if (!version) {
      throw probeInvalid(
        'version-unparsable',
        `codex --version 的输出无法解析出版本号：${JSON.stringify((versionResult.stdout || '').slice(0, 120))}`,
      )
    }

    const execHelp = await run(['exec', '--help'])
    if (!execHelp.ok) {
      throw probeInvalid(
        'exec-help-failed',
        `codex exec --help 失败（${execHelp.code}）：无法确认 JSONL / 沙箱 / 模型参数，适配器拒绝宣称可用`,
        { cause: execHelp.code },
      )
    }
    const resumeHelp = await run(['exec', 'resume', '--help'])
    const features = await run(['features', 'list'])
    const helpText = `${execHelp.stdout}\n${resumeHelp.ok ? resumeHelp.stdout : ''}`

    const execJson = /--json\b/.test(execHelp.stdout)
    const modelFlag = /--model\b/.test(execHelp.stdout)
    const sandboxFlag = /--sandbox\b/.test(execHelp.stdout)
    if (!execJson || !modelFlag || !sandboxFlag) {
      throw probeInvalid(
        'cli-flags-missing',
        'codex exec --help 缺少必需参数（--json / --model / --sandbox）：无法按 M6 显式 pin 模型与沙箱',
        { execJson, modelFlag, sandboxFlag },
      )
    }
    const resume = resumeHelp.ok && /SESSION_ID/.test(resumeHelp.stdout)
    const hookTrust = /--dangerously-bypass-hook-trust/.test(helpText)
    const hooksFeatureDisabled = /(^|\n)\s*hooks\s+.*\bfalse\b/.test(features.stdout)
    // 推断值只作诊断 / 证据；capabilities 默认仍标 emulated，native 需显式 opt-in（M7）。
    const hooksNative = versionAtLeast(version, 0, 167, 0) && hookTrust && !hooksFeatureDisabled

    // 用真实 CLI 解析一遍本适配器生成的 MCP + 沙箱 / 审批配置（不启动 server，不调模型）。
    const listResult = await run([
      'mcp', 'list', '--json',
      '-c', `sandbox_mode=${tomlString(settings.sandbox)}`,
      '-c', `approval_policy=${tomlString(settings.approvalPolicy)}`,
      '-c', `mcp_servers.flow_finish.command=${tomlString(process.execPath)}`,
      '-c', `mcp_servers.flow_finish.args=${tomlStringArray([SERVER_PATH])}`,
      '-c', `mcp_servers.flow_finish.env_vars=${tomlStringArray([
        FINISH_CHANNEL_ENV.token,
        FINISH_CHANNEL_ENV.socket,
      ])}`,
    ])
    if (!listResult.ok) {
      throw probeInvalid(
        'mcp-config-rejected',
        `codex 不接受本适配器生成的 MCP / 沙箱配置（mcp list 退出 ${listResult.code}），适配器不可用`,
        { cause: listResult.code },
      )
    }
    let parsed
    try {
      parsed = JSON.parse(listResult.stdout)
    } catch {
      throw probeInvalid('mcp-config-unparsable', 'codex mcp list --json 的输出不是合法 JSON：无法确认 MCP 配置可用')
    }
    const list = Array.isArray(parsed) ? parsed : []
    const mcpConfig = list.some(entry => entry && entry.name === 'flow_finish'
      && entry.transport && entry.transport.type === 'stdio'
      && entry.transport.command === process.execPath)
    if (!mcpConfig) {
      throw probeInvalid(
        'mcp-config-not-listed',
        'codex mcp list 里没有本适配器生成的 flow_finish stdio server：完成工具不会被加载',
      )
    }

    let bridge
    if (settings.selfTest) {
      bridge = await verifyFinishBridge({
        tmpRoot: settings.tmpRoot,
        timeoutMs: Math.max(1_000, Math.min(settings.probeTimeoutMs, 30_000)),
      })
      if (!bridge || bridge.ok !== true) {
        throw probeInvalid(
          'bridge-failed',
          `完成桥自检失败（${bridge && bridge.reason ? bridge.reason : 'unknown'}${
            bridge && bridge.step ? ` / ${bridge.step}` : ''}）：MCP stdio 往返不可用`,
          { bridge },
        )
      }
    } else {
      bridge = { ok: true, skipped: true }
    }

    return {
      version: version.raw,
      helpDigest: sha256(helpText).slice(0, 40),
      execJson,
      resume,
      hookTrust,
      hooksNative,
      stopHookEvidence: hooksNative ? CODEX_STOP_HOOK_EVIDENCE : 'Stop hook continuation not verified for this CLI',
      mcpConfig,
      sandboxFlag,
      modelFlag,
      sandbox: settings.sandbox,
      approvalPolicy: settings.approvalPolicy,
      bridge,
      finishToolEvidence: CODEX_FINISH_TOOL_EVIDENCE,
      probedAt: new Date().toISOString(),
    }
  }

  /**
   * 可用性探测。
   *
   * 语义是「适配器到底能不能用」：CLI 不在 / help 取不到 / MCP 配置解析不出来 /
   * 桥自检失败都**抛** `ADAPTER_PROBE_INVALID`，不伪造 `0.0.0` 之类的成功结果（M2）。
   * 带总超时（m9）；结果缓存 `probeCacheTtlMs`（默认 10 分钟，m9）。
   */
  async function probe() {
    const cached = readProbeCache()
    if (cached) return { ...cached }
    if (probePromise) return probePromise
    let abandoned = false
    let timerId = null
    const running = probeOnce()
    // 总超时之后后台 probe 的 rejection 不能让进程崩。
    running.catch(() => {})
    probePromise = (async () => {
      const timeout = new Promise((_, rejectProbe) => {
        timerId = setTimeout(() => {
          abandoned = true
          rejectProbe(probeInvalid(
            'probe-timeout',
            `codex probe 超过 ${settings.probeTimeoutMs}ms 未完成：按不可用处理，不派发节点`,
          ))
        }, settings.probeTimeoutMs)
        timerId.unref?.()
      })
      try {
        const value = await Promise.race([running, timeout])
        if (!abandoned) probeCache = { value, at: Date.now() }
        return { ...value }
      } finally {
        clearTimeout(timerId)
        timerId = null
      }
    })().finally(() => {
      probePromise = null
    })
    return probePromise
  }

  /** 清掉 probe 缓存（显式 invalidate；TTL 之外的第二条口子）。 */
  function invalidateProbe() {
    probeCache = null
  }

  /**
   * 能力表：`finishTool` 只在**最近一次成功 probe** 之后才宣称 `native`（M1/M2）。
   * hooks 默认 `emulated`；native 只有调用方显式 `stopHook:'native'` 才声明（M7）。
   */
  function capabilities() {
    const probeValue = readProbeCache()
    const cliOk = Boolean(probeValue && probeValue.execJson === true && probeValue.mcpConfig === true)
    const bridgeOk = Boolean(probeValue && !(probeValue.bridge && probeValue.bridge.ok === false))
    const finishTool = cliOk && bridgeOk ? 'native' : 'unsupported'
    const hookLevel = resolveHookLevel(probeValue)
    return {
      finishTool,
      hooks: { 'turn.stop': hookLevel },
      // 0.13.10：codex 的 exec 通道没有稳定的「轮次中投递」能力，本轮明确不支持；
      // 宿主会把消息记成 failed + deliveryUnknown，不假装成功（CLI 投递下一轮补）。
      messages: 'unsupported',
      // 0.13.10 运行指标：`turn.completed.usage` 是原始 provider usage（input 含缓存），
      // 由 agent-telemetry 统一拆桶；每轮一个 callId。
      usage: 'native',
      evidence: {
        finishTool: CODEX_FINISH_TOOL_EVIDENCE,
        'turn.stop': hooksContinueEvidence(probeValue, hookLevel),
        userConfig: CODEX_USER_CONFIG_EVIDENCE,
        messages: ['codex exec 目前没有可去重的轮次中投递通道：capabilities().messages=unsupported'],
        usage: ['`codex exec --json` 的 turn.completed.usage（input_tokens 含缓存子集）'],
        sandbox: `exec: -s ${settings.sandbox} + -c approval_policy=${JSON.stringify(settings.approvalPolicy)}；`
          + `resume: -c sandbox_mode=${JSON.stringify(settings.sandbox)}（${CODEX_USER_CONFIG_EVIDENCE}）`,
      },
    }
  }

  /**
   * 提醒机制档位：
   *   - 显式 `native` → native（手工证据，需人工/发布验证）；
   *   - 显式 `emulated` → emulated；
   *   - 默认 `auto` → emulated；`resume` 不可用（native 又没显式启用）时如实标 unsupported。
   */
  function resolveHookLevel(probeValue) {
    if (settings.stopHook === 'native') return 'native'
    if (settings.stopHook === 'emulated') return 'emulated'
    if (!probeValue) return 'emulated'
    const hooksNative = probeValue.hooksNative === true
    const resume = probeValue.resume === true
    if (!hooksNative && !resume) return 'unsupported'
    if (!resume) return 'unsupported'
    return 'emulated'
  }

  function hooksContinueEvidence(probeValue, level) {
    if (level === 'native') {
      return (probeValue && probeValue.stopHookEvidence) || CODEX_STOP_HOOK_EVIDENCE
    }
    if (level === 'emulated') {
      const resume = probeValue ? String(probeValue.resume === true) : 'unprobed'
      return `codex exec resume <session-id> 进程级续跑（emulated；probe().resume=${resume}）`
    }
    return 'CLI 既不能确认 Stop hook，也不支持 codex exec resume：没有提醒机制（按 unsupported 如实声明，不假装能提醒）'
  }

  async function start(request) {
    const { element, ctx, finishGate, reminder } = request || {}
    const workspaceRoot = typeof request?.workspaceRoot === 'string' && request.workspaceRoot !== ''
      ? request.workspaceRoot
      : (isPlainObject(request?.workspace) && typeof request.workspace.effectiveRoot === 'string'
        ? request.workspace.effectiveRoot
        : '')
    const runnerCtx = isPlainObject(ctx) ? ctx : {}

    // m9：预 abort 不派发（在 probe / 建目录之前）。
    if (runnerCtx.signal && runnerCtx.signal.aborted === true) {
      throw new CodexAdapterError(
        'NODE_FINISH_CANCELED',
        'Codex 适配器在启动前已被取消（ctx.signal 已 abort），节点零派发',
        { adapterId: CODEX_ADAPTER_ID, reason: 'pre-aborted', nodeId: element && element.id },
      )
    }

    // m1：先校验闸门的三个方法 + result Promise，再建 channel / runDir；最小 gate 不能抛裸 TypeError。
    const missingGate = []
    if (!finishGate || typeof finishGate !== 'object') {
      missingGate.push('finishGate')
    } else {
      for (const method of ['submit', 'settled', 'abort']) {
        if (typeof finishGate[method] !== 'function') missingGate.push(method)
      }
      if (!finishGate.result || typeof finishGate.result.then !== 'function') missingGate.push('result')
    }
    if (missingGate.length > 0) {
      throw new CodexAdapterError(
        ADAPTER_ERROR.INVALID,
        'Codex 适配器 start 需要 node-finish 的 finishGate（submit / settled / abort 方法 + result Promise）',
        {
          adapterId: CODEX_ADAPTER_ID,
          field: 'finishGate',
          reason: 'missing-gate',
          missing: missingGate,
        },
      )
    }
    if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
      throw new CodexAdapterError(
        ADAPTER_ERROR.INVALID,
        'Codex 适配器 start 需要 workspaceRoot',
        { adapterId: CODEX_ADAPTER_ID, field: 'workspaceRoot', reason: 'missing' },
      )
    }
    const workspace = resolve(workspaceRoot)
    if (!existsSync(workspace)) {
      throw new CodexAdapterError(
        ADAPTER_ERROR.INVALID,
        `Codex 适配器的工作区不存在：${workspace}`,
        { adapterId: CODEX_ADAPTER_ID, field: 'workspaceRoot', reason: 'not-found' },
      )
    }

    // probe 之后才决定能不能启动：不可用 CLI 不 spawn，绝不等满 hello 超时。
    // m5（review-0142b）：直接 `start()` 的不可用错误码统一成 `NODE_FINISH_TOOL_UNAVAILABLE`
    // （冻结接口 `docs/design/11-node-finish-tool.md` §1.6）；`probe()` 自己的
    // `ADAPTER_PROBE_INVALID` 原样保留，并作为 `cause` 挂在启动错误上，原因不丢。
    let probeValue
    try {
      probeValue = await probe()
    } catch (error) {
      if (error && error.code === ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE) throw error
      throw new CodexAdapterError(
        ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
        `Codex 适配器不可用（probe 未通过：${
          error && typeof error.message === 'string' ? error.message : String(error)
        }）：按 11 §1.6 拒绝启动，节点零派发`,
        {
          adapterId: CODEX_ADAPTER_ID,
          reason: 'probe-failed',
          nodeId: element && element.id,
          cause: error,
          causeCode: error && typeof error.code === 'string' ? error.code : undefined,
        },
      )
    }
    const caps = capabilities()
    if (caps.finishTool !== 'native') {
      throw new CodexAdapterError(
        ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
        'Codex 适配器当前不能提供原生 flow_finish_node（probe 未通过）：按 11 §1.6 拒绝启动',
        {
          adapterId: CODEX_ADAPTER_ID,
          reason: probeValue ? 'finish-tool-not-native' : 'probe-failed',
          nodeId: element && element.id,
        },
      )
    }
    const hookLevel = caps.hooks['turn.stop']
    const useHook = hookLevel === 'native'
    const resumeSupported = probeValue.resume === true
    const model = resolveNodeModel(settings, runnerCtx, element)
    const prompt = buildCodexNodePrompt({ element, ctx: runnerCtx, workspaceRoot: workspace })

    ensurePrivateDir(settings.tmpRoot)
    const runDir = ensurePrivateDir(await fsp.mkdtemp(join(settings.tmpRoot, 'fs-codex-')))
    // M4：runDir 一创建就进入**资源所有权边界**。之后任何一步（写 hook / 建通道 /
    // 构造参数 / 同步 spawn / 握手）失败都由 `cleanupAfterStartFailure` 统一收口。
    const resources = createResourceRegistry()
    resources.add('run-dir', () => fsp.rm(runDir, { recursive: true, force: true }))

    let hookScriptPath = null
    let channel = null
    let state = null
    let fireReminder = () => {}
    let startFailureOutcome = null
    /**
     * 清理函数可能在任何一步抛出后的 catch 里被调用，因此只用**可空引用**访问后面
     * 才初始化的组件（避免 TDZ）；每个组件初始化后立刻登记到这里。
     */
    const runtime = {
      supervisor: null,
      terminateAllGroups: null,
      waitGroupsGone: null,
      removeSignalListener: null,
      watchFinalCleanup: null,
      cleanupSnapshot: null,
    }

    // 最终清理 Promise 必须从失败清理路径起就可用（原先定义在 1400 行之后）。
    let finalCleanupSettled = false
    let resolveFinalCleanup = null
    const cleanupFinal = new Promise(resolveFinal => { resolveFinalCleanup = resolveFinal })
    const settleFinalCleanup = value => {
      if (finalCleanupSettled) return
      finalCleanupSettled = true
      resolveFinalCleanup(value)
    }

    /**
     * M4（Codex 侧残余）：启动失败清理，与 Claude 同口径：
     *   abort gate → 整组 TERM→KILL 并确认 → 释放已登记资源（channel / listener / runDir）
     *   → 启动最终清理盯守，并把 `cleanup` / `cleanupFinal` 挂到错误对象上。
     * 幂等：握手分支已经清理过时直接复用同一份结果。
     */
    const cleanupAfterStartFailure = async () => {
      if (startFailureOutcome) return startFailureOutcome
      try {
        if (typeof finishGate.abort === 'function' && !finishGate.settled()) finishGate.abort('start-failed')
      } catch {
        // gate abort 失败不改变清理结果。
      }
      let gone = true
      if (runtime.terminateAllGroups) {
        let results = []
        try {
          results = await runtime.terminateAllGroups('start-failure')
        } catch {
          results = []
        }
        gone = results.length > 0
          ? results.every(result => Boolean(result && result.gone === true))
          : true
        if (!gone && runtime.supervisor) {
          await runtime.supervisor.disposeAll().catch(() => {})
          if (runtime.waitGroupsGone) gone = await runtime.waitGroupsGone(1_000)
        }
      }
      if (runtime.removeSignalListener) runtime.removeSignalListener()
      await resources.disposeAll()
      if (runtime.watchFinalCleanup) runtime.watchFinalCleanup()
      startFailureOutcome = {
        cleanup: runtime.cleanupSnapshot ? runtime.cleanupSnapshot() : { disposed: gone },
        cleanupFinal,
        gone,
      }
      return startFailureOutcome
    }

    /** 把物理清理信号挂到 start 失败错误上（runtime / 探针按此判断是否已清理）。 */
    const attachCleanup = (error, outcome) => {
      if (error && typeof error === 'object' && outcome) {
        error.cleanup = outcome.cleanup
        error.cleanupFinal = outcome.cleanupFinal
      }
      return error
    }

    /**
     * M2 残余（跨单元约定）：`start()` 在返回 handle 之前失败时，把已观测到的用量
     * 挂到**失败载体**上（`error.usageCalls` / `error.usageSnapshots`）。executor 的
     * `readAdapterUsageCalls` 支持数组或函数；一条都没观测到就不挂（不制造空账本）。
     */
    const attachUsage = error => {
      if (error && typeof error === 'object' && state && Array.isArray(state.usageCalls)) {
        const calls = state.usageCalls.map(call => ({
          ...call,
          usage: call.usage === null ? null : { ...call.usage },
        }))
        if (calls.length > 0) error.usageCalls = calls
      }
      return error
    }

    try {
      state = {
        canceled: false,
        cancelReason: null,
        channelFailed: false,
        gateSettled: false,
        reminders: 0,
        sessionId: undefined,
        record: undefined,
        lastMessage: undefined,
        usage: undefined,
        // 0.13.10 运行指标：每轮 `turn.completed` 一条调用记录（m2：**不按诊断上限裁剪**）。
        usageCalls: [],
        usageCallSeq: 0,
        exitCode: undefined,
        signal: undefined,
        spawnError: null,
        stdoutTail: '',
        stderrTail: '',
        events: [],
        // M3 诊断（小、有界、导出时脱敏）：协议错误 / 丢弃行 / 排空状态。
        eventsTruncated: false,
        protocolErrors: [],
        protocolErrorCount: 0,
        droppedLines: 0,
        diagnostics: [],
        diagnosticsTruncated: false,
        outputDrained: null,
        outputIncomplete: false,
        // M6：CLI 终态错误（turn.failed / error / 非零退出）不退化成本地「没有调用工具」。
        terminalError: null,
      }
      if (useHook) {
        hookScriptPath = join(runDir, HOOK_SCRIPT_NAME)
        writeFileSync(hookScriptPath, HOOK_SCRIPT_SOURCE, { mode: 0o600 })
        if (process.platform !== 'win32') chmodSync(hookScriptPath, 0o600)
      }
      channel = await createFinishChannel({
        gate: finishGate,
        dir: runDir,
        maxReminders: settings.reminderLimit,
        onReminder: info => {
          state.reminders = Math.max(state.reminders, info.count)
          fireReminder(info)
        },
        onReject: () => {
          state.channelFailed = true
        },
      })
      resources.add('finish-channel', () => channel.close())
    } catch (error) {
      const cleanupOutcome = await cleanupAfterStartFailure()
      throw attachCleanup(attachUsage(error), cleanupOutcome)
    }

    /** 提醒回调只通知一次，异常不影响流程。 */
    const emitReminder = info => {
      try {
        if (reminder && typeof reminder.onFire === 'function') {
          reminder.onFire({
            count: info.count,
            maxFires: info.maxFires !== undefined ? info.maxFires : settings.reminderLimit,
            ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          })
        } else if (typeof reminder === 'function') {
          reminder({
            count: info.count,
            maxFires: info.maxFires !== undefined ? info.maxFires : settings.reminderLimit,
            ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          })
        }
      } catch {
        // 回调异常不能改变节点完结判定。
      }
    }
    fireReminder = emitReminder

    // gitGate / reminder 之外，ctx.signal 用来在活动超时时收掉进程组（runner 的取消路径）。
    let handleRef = null
    let pendingAbort = false
    let signalListener = null
    if (runnerCtx.signal && typeof runnerCtx.signal.addEventListener === 'function') {
      signalListener = () => {
        if (handleRef) cancelHandle(handleRef, 'ctx.signal').catch(() => {})
        else pendingAbort = true
      }
      runnerCtx.signal.addEventListener('abort', signalListener, { once: true })
      // 注册监听之前就已经 abort 的竞态：标记下来，句柄一建好就取消。
      if (runnerCtx.signal.aborted === true) pendingAbort = true
    }
    const removeSignalListener = () => {
      if (signalListener && runnerCtx.signal && typeof runnerCtx.signal.removeEventListener === 'function') {
        try {
          runnerCtx.signal.removeEventListener('abort', signalListener)
        } catch {
          // ignore
        }
      }
      signalListener = null
    }
    resources.add('signal-listener', () => removeSignalListener())
    runtime.removeSignalListener = removeSignalListener

    let child = null
    let resumeChild = null
    let exitedResolve
    let exitedDone = false
    // 物理退出确认由共享 supervisor 记账（见 trackGroup）：逻辑结局（exited）可以在杀进程
    // 未生效时自行收口，但不能把物理清理也当成完成（review-0139 F3 / review-0140 N2）。
    let disposeDone = false
    let cancelPromise = null
    let cancelSignalResolve
    let spawnFailureResolve
    let earlyExitResolve

    const cancelSignal = new Promise(resolveCancel => { cancelSignalResolve = resolveCancel })
    const spawnFailure = new Promise(resolveSpawn => { spawnFailureResolve = resolveSpawn })
    const earlyExit = new Promise(resolveExit => { earlyExitResolve = resolveExit })
    const exited = new Promise(resolveExited => {
      exitedResolve = resolveExited
    })

    /**
     * M5 / m1：进程组生命周期统一交给共享 supervisor（`agent-cli-lifecycle.js`）。
     *
     * - supervisor 的 `graceMs` 固定 0：完成后的宽限期由本适配器按 `postFinishGraceMs`
     *   单独等待，之后交给 supervisor 做 **TERM → 等 `killTimeoutMs` → SIGKILL** 的完整
     *   升级。旧实现在 `postFinishGraceMs=0` 时只发 TERM 就 return，忽略 TERM 的子进程
     *   会一直活着、`exited` 永远不完成（review-0142b M5）。
     * - 只有**整组消失**（`kill(-pgid, 0)` 得 ESRCH）才撤销升级；组长先退出不会清掉
     *   KILL 计时器，组内后代忽略 TERM 时继续升级（review-0142b m1）。
     */
    const supervisor = createProcessGroupSupervisor({
      graceMs: 0,
      killTimeoutMs: settings.killTimeoutMs,
      ...(settings.killImpl
        ? {
          killImpl: (signal, target) => settings.killImpl(
            signal,
            target && target.child ? target.child : target,
          ),
        }
        : {}),
    })
    runtime.supervisor = supervisor

    const resolveExited = value => {
      if (exitedDone) return
      exitedDone = true
      // m1：这里**不**撤销任何进程组升级。清理计时器归 supervisor，
      // 只有整组消失（kill(-pgid, 0) → ESRCH）才会被它清掉。
      removeSignalListener()
      exitedResolve({
        sessionId: state.sessionId,
        reminders: state.reminders,
        ...value,
      })
    }

    /**
     * 导出前脱敏（M4）：本 execution 的凭据、socket 路径与 runDir 都替换成占位符。
     * `state.events` 里仍保留原始事件（诊断需要），只有 `handle` 暴露的副本被脱敏。
     * 深度超过 8 层的子树一律替换成 `[redacted:depth]`——**绝不返回原对象**（#9）。
     */
    const redactText = text => {
      let output = typeof text === 'string' ? text : String(text)
      const secrets = [channel.credential, channel.socketPath, runDir]
      for (const secret of secrets) {
        if (typeof secret === 'string' && secret !== '') output = output.split(secret).join('[redacted]')
      }
      return output
    }
    const redactValue = (value, depth = 0) => {
      if (typeof value === 'string') return redactText(value)
      const tooDeep = depth > 8
      if (Array.isArray(value)) {
        // 超深子树**必须**替换成占位符：直接返回原值会让深层凭据绕过脱敏（#9）。
        return tooDeep ? '[redacted:depth]' : value.map(item => redactValue(item, depth + 1))
      }
      if (isPlainObject(value)) {
        if (tooDeep) return '[redacted:depth]'
        const output = {}
        for (const [key, item] of Object.entries(value)) output[key] = redactValue(item, depth + 1)
        return output
      }
      return value
    }

    /**
     * F2：终态错误（code / message / details）的唯一脱敏出口。
     *
     * 顺序：共享脱敏（Bearer / Basic / sk- / token=… / 长串）→ 本 execution 的精确
     * 秘密替换（通道凭据 / socket / runDir）→ UTF-8 字节截断并标记。旧的
     * `redactText` 只做本执行秘密替换，`failure.code` 更是完全没清洗。
     */
    const boundTerminalText = (value, limit = MAX_TERMINAL_ERROR_BYTES) => {
      let text = redactSharedText(value === undefined || value === null ? '' : String(value))
      for (const secret of [channel.credential, channel.socketPath, runDir]) {
        if (typeof secret === 'string' && secret !== '') text = text.split(secret).join('[redacted]')
      }
      return truncateUtf8Bytes(text, limit)
    }

    /** 取消 / 失败时收掉闸门：未 settle 才 abort；重复 abort 幂等。 */
    const abortGate = reason => {
      try {
        if (typeof finishGate.abort !== 'function' || finishGate.settled()) return false
        return finishGate.abort(reason) !== false
      } catch {
        return false
      }
    }

    /**
     * M6 残余 b：闸门 settled 只有两种状态——**受理**（result resolve）或**被 abort**。
     * 已受理的成功结果优先于迟到的 cancel：cancel 只影响进程清理，不改业务结局。
     */
    const resolveFromGate = async () => {
      try {
        const record = await finishGate.result
        state.record = record
        resolveExited({ ok: true, code: 'OK', record })
      } catch (error) {
        if (state.canceled) {
          resolveExited({
            ok: false,
            code: 'NODE_FINISH_CANCELED',
            message: `Codex 活动被取消${state.cancelReason ? `：${state.cancelReason}` : ''}`,
          })
          return
        }
        resolveExited({
          ok: false,
          code: error && typeof error.code === 'string' ? error.code : 'NODE_FINISH_ABORTED',
          message: error && typeof error.message === 'string' ? error.message : '节点完成等待被中止',
        })
      }
    }

    /**
     * agent 停下但没调工具：MISSING。先 abort 闸门（M3），保证之后的迟到 submit
     * 得到 `NODE_ALREADY_SETTLED`，而不是把已经失败的节点又 settle 成一份 record。
     */
    const finishWithoutTool = () => {
      if (state.channelFailed) {
        abortGate('channel-failed')
        resolveExited({
          ok: false,
          code: 'NODE_FINISH_CHANNEL_FAILED',
          message: '完成通道不可用（凭据 / IPC 失败），节点没有完结',
        })
        return
      }
      abortGate('finish-tool-missing')
      resolveExited({
        ok: false,
        code: 'NODE_FINISH_MISSING',
        message: 'agent 停下但没有调用 flow_finish_node，节点没有完结',
        reminders: state.reminders,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      })
    }

    /**
     * 完成后的进程组收尾（review-0142b M5）。
     *
     * - `postFinishGraceMs=0` 只跳过**宽限等待**，仍然执行完整的 TERM → KILL 升级
     *   （旧实现在这里直接 return，忽略 TERM 的子进程会一直活着、`exited` 永不完成）；
     * - 宽限计时器不再被 `resolveExited` 撤销（m1）：终止责任只属于 supervisor，
     *   组长先退、组内后代忽略 TERM 时继续升级到 SIGKILL。
     */
    const scheduleGraceKill = () => {
      if (state.gateSettled || disposeDone) return
      state.gateSettled = true
      const run = () => {
        terminateAllGroups('post-finish').catch(() => {})
      }
      if (!(settings.postFinishGraceMs > 0)) {
        run()
        return
      }
      const timer = setTimeout(run, settings.postFinishGraceMs)
      timer.unref?.()
    }

    // 工具一提交成功（或闸门被 abort）就准备收尾：先让 codex 把工具结果带回给模型，
    // 再在宽限期后收进程组（grace=0 时立刻 TERM→KILL）。
    finishGate.result.then(() => scheduleGraceKill(), () => scheduleGraceKill())

    /** M3：小诊断只记位置 / 长度 / 类型；正文与凭据不会进这里。 */
    const recordDiagnostic = entry => {
      if (state.diagnostics.length >= DIAGNOSTIC_LIMIT) {
        state.diagnosticsTruncated = true
        return
      }
      state.diagnostics.push({ ...entry })
    }
    const recordProtocolError = entry => {
      state.protocolErrorCount += 1
      if (state.protocolErrors.length >= PROTOCOL_ERROR_LIMIT) {
        state.diagnosticsTruncated = true
        return
      }
      state.protocolErrors.push({ ...entry })
    }

    /**
     * 单行协议事件 → state。**分帧与 UTF-8 解码由共享 reader 负责**（M3）：
     * 这里只做 JSON 解析和业务归并，不再拼接 Buffer / 不再裁剪半行。
     *
     * @param {{kind:string, terminalError:object|null}} invocation 该子进程的独立记录
     */
    const handleProtocolLine = (invocation, line, meta) => {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        recordProtocolError({ kind: 'json-invalid', lineNo: meta && meta.lineNo, bytes: meta && meta.bytes })
        return
      }
      if (!isPlainObject(event)) {
        recordProtocolError({ kind: 'not-object', lineNo: meta && meta.lineNo, bytes: meta && meta.bytes })
        return
      }
      // 诊断事件缓存有界并**显式标记截断**；计量账本不受这个上限约束（m2）。
      if (state.events.length < EVENT_CACHE_LIMIT) state.events.push(event)
      else state.eventsTruncated = true
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        state.sessionId = event.thread_id
        invocation.sessionId = event.thread_id
      } else if (event.type === 'turn.completed' && isPlainObject(event.usage)) {
        state.usage = event.usage
        // 一轮就是一次模型调用；thread_id 稳定时 callId 可复现，否则用进程内序号。
        state.usageCallSeq += 1
        state.usageCalls.push({
          provider: CODEX_ADAPTER_ID,
          callId: `${state.sessionId || 'codex'}:turn-${state.usageCallSeq}`,
          usage: { ...event.usage },
          source: 'turn.completed',
        })
      } else if (event.type === 'turn.failed') {
        // M6：CLI 终态错误必须保留，不能被吞成「agent 没调工具」。
        const failure = isPlainObject(event.error) ? event.error : {}
        invocation.terminalError = {
          kind: 'turn.failed',
          code: nonEmptyTrimmedString(failure.code) || 'turn_failed',
          message: nonEmptyTrimmedString(failure.message) || 'codex turn.failed',
        }
      } else if (event.type === 'error') {
        invocation.terminalError = {
          kind: 'error',
          code: nonEmptyTrimmedString(event.code) || 'error',
          message: nonEmptyTrimmedString(event.message) || 'codex error',
        }
      } else if (event.type === 'item.completed' && isPlainObject(event.item)) {
        // 只收展示用消息；`item` 级别的错误可能是 agent 能恢复的工具错误，
        // 不在这里判终态（终态由 turn.failed / 异常退出决定）。
        if (event.item.type === 'agent_message' && typeof event.item.text === 'string') {
          state.lastMessage = event.item.text.slice(0, 2_000)
        }
      }
    }

    /**
     * 把一个子进程接到共享流 helper（M3）。
     *
     * 每个初始 / resume 子进程都有**自己**的 decoder、半行缓冲、行号与 `drained`：
     * 上一进程没有尾换行的半行绝不会拼进下一进程的协议流。
     * 展示 tail 与协议缓冲在 helper 内部分离，`stdoutTail` 上限不再破坏 JSON 解析。
     */
    const attachInvocation = (spawned, kind) => {
      const invocation = {
        kind,
        exitCode: undefined,
        signal: undefined,
        sessionId: undefined,
        terminalError: null,
        outputDrained: null,
      }
      const reader = createUtf8LineReader({
        maxLineBytes: STREAM_MAX_LINE_BYTES,
        onLine: (line, meta) => handleProtocolLine(invocation, line, meta),
        onDiagnostic: diag => {
          if (diag && diag.kind === 'line-too-long') state.droppedLines += 1
          recordProtocolError(diag)
        },
      })
      const streams = attachProcessStreams(spawned, {
        stdoutReader: reader,
        stdoutTailBytes: 64 * 1024,
        stderrTailBytes: 8 * 1024,
        drainTimeoutMs: settings.drainTimeoutMs,
      })
      invocation.streams = streams
      invocationOf.set(spawned, invocation)
      // 展示 tail 由 helper 的独立 decoder 维护（有界、UTF-8 安全）；这里只镜像到句柄字段。
      spawned.stdout?.on('data', () => {
        state.stdoutTail = streams.stdoutTail()
      })
      spawned.stderr?.on('data', () => {
        state.stderrTail = streams.stderrTail()
      })
      spawned.on('error', error => {
        state.spawnError = error
      })
      return invocation
    }

    /**
     * M3：结算前等该子进程的 stdout 排空（**有界**）。
     * 超时只标记 `outputIncomplete` 并留一条小诊断，绝不无限等待（后代可能继承 stdout）。
     */
    const drainInvocation = async invocation => {
      if (!invocation || !invocation.streams) return
      const result = await invocation.streams.drained.catch(() => null)
      invocation.outputDrained = Boolean(result && result.drained === true)
      state.outputDrained = invocation.outputDrained
      if (!invocation.outputDrained) state.outputIncomplete = true
      try {
        for (const entry of invocation.streams.diagnostics()) {
          if (entry && entry.source === 'attach') {
            recordDiagnostic({ ...entry, invocation: invocation.kind })
          }
        }
      } catch {
        // 诊断读取失败不影响结算。
      }
    }

    /**
     * review-0141 M1：每个 spawn（初始 exec / 每次 resume / start 失败路径）都登记一份
     * **进程组清理责任**，而不是只登记「组长进程」。
     *
     * 组长退出不等于进程组清空：codex 会拉起 MCP server，MCP / 工具后代可能比组长活得久。
     * 责任记录由共享 supervisor 保存：只有 `kill(-pgid, 0)` 确认整组消失才移除；
     * `cleanup.disposed` 只在整个集合为空时成立。
     */
    const invocationOf = new Map()
    /** child → { kind, pid, handle, gone }；handle=null 表示 spawn 失败（没有 pid）。 */
    const groups = new Map()

    /** 仍在世的进程组记录（含组长已退出、后代仍活着的组）。 */
    const pendingGroups = () => {
      const snapshot = supervisor.snapshot()
      const aliveIds = new Set(snapshot.groups.filter(entry => entry.alive).map(entry => entry.id))
      const pending = []
      for (const record of groups.values()) {
        if (record.handle) {
          if (aliveIds.has(record.handle.id)) pending.push(record)
        } else if (!record.gone) {
          pending.push(record)
        }
      }
      return pending
    }
    const cleanupSnapshot = () => {
      const pending = pendingGroups()
      if (pending.length === 0) return { disposed: true }
      return {
        disposed: false,
        pending: pending.map(record => record.kind),
        processes: pending.map(record => ({ kind: record.kind, pid: record.pid })),
        reason: `仍有 ${pending.length} 个 codex 进程组未确认退出（${pending.map(record => record.kind).join(' / ')}）`,
      }
    }
    runtime.cleanupSnapshot = cleanupSnapshot

    /**
     * 独立的**最终清理 Promise**：只有所有被跟踪进程组确认消失才 resolve disposed:true。
     *
     * 旧的 runtime 侧只读一次 `handle.cleanup` 快照：dispose 返回 false 后，即使进程组
     * 之后才退出也不会释放槽位（review-0141 M1 ③）。这个 Promise 由 dispose / start
     * 失败路径启动、有界盯住进程组消失，让 runtime 可以等它 settle 再释放。
     */
    const FINAL_CLEANUP_WATCH_MS = Math.min(60_000, Math.max(5_000, settings.killTimeoutMs * 2 + 2_000))
    // 只用于「兜底盯守」：定时器 unref，进程可以随时退出，不会被它拖住。
    const sleepUnref = ms => new Promise(resolveSleep => {
      const timer = setTimeout(resolveSleep, ms)
      timer.unref?.()
    })
    const watchFinalCleanup = () => {
      ;(async () => {
        const deadline = Date.now() + FINAL_CLEANUP_WATCH_MS
        for (;;) {
          const snapshot = cleanupSnapshot()
          if (snapshot.disposed === true) {
            settleFinalCleanup(snapshot)
            return
          }
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            settleFinalCleanup({
              ...snapshot,
              timedOut: true,
              reason: `${snapshot.reason}；最终清理等待 ${FINAL_CLEANUP_WATCH_MS}ms 超时`,
            })
            return
          }
          await sleepUnref(Math.min(remaining, 100))
        }
      })().catch(error => {
        settleFinalCleanup({
          disposed: false,
          reason: `最终清理盯守失败：${error && error.message ? error.message : error}`,
        })
      })
    }
    runtime.watchFinalCleanup = watchFinalCleanup

    const trackGroup = (spawned, kind) => {
      if (!Number.isSafeInteger(spawned.pid) || spawned.pid <= 0) {
        // spawn 失败（ENOENT 等）：没有 pid，也就没有进程组；error 之后视为已消失。
        const record = { kind, pid: null, handle: null, gone: false }
        spawned.once('error', () => { record.gone = true })
        spawned.once('exit', () => { record.gone = true })
        groups.set(spawned, record)
        return record
      }
      const handle = supervisor.track(spawned, { label: kind })
      const record = { kind, pid: spawned.pid, handle, gone: false }
      groups.set(spawned, record)
      if (state.gateSettled && !state.canceled) {
        // 闸门 settle 之后才 spawn 的进程（极窄竞态）同样要收掉。
        supervisor.terminateGroup(handle, 'post-finish').catch(() => {})
      }
      return record
    }

    /** 对所有被跟踪进程组发起完整的 TERM → KILL 升级（supervisor 内部保证）。 */
    const terminateAllGroups = reason => {
      const jobs = []
      for (const record of groups.values()) {
        if (record.handle) jobs.push(supervisor.terminateGroup(record.handle, reason))
      }
      return Promise.all(jobs)
    }
    runtime.terminateAllGroups = terminateAllGroups

    /** 有界等待所有被跟踪进程组（含组长已退出、后代仍活着的组）消失。 */
    const waitTrackedGroupsGone = async timeoutMs => {
      const deadline = Date.now() + Math.max(0, timeoutMs)
      for (;;) {
        if (pendingGroups().length === 0) return true
        const remaining = deadline - Date.now()
        if (remaining <= 0) return false
        await sleep(Math.min(remaining, 50))
      }
    }
    runtime.waitGroupsGone = waitTrackedGroupsGone

    const spawnCodex = (args, kind) => {
      const env = buildChildEnv([settings.env, channel.env])
      const spawned = spawn(settings.codexBin, args, {
        cwd: workspace,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      trackGroup(spawned, kind)
      attachInvocation(spawned, kind)
      return spawned
    }

    // 每个 resume 进程一个独立 Promise；abort 时统一收掉。
    const waitExit = target => new Promise(resolveWait => {
      target.once('exit', (code, signal) => resolveWait({ code, signal }))
      target.once('error', () => resolveWait({ code: null, signal: null }))
    })

    /**
     * M6：把一个 invocation 的退出信息分类成「CLI 终态错误」。
     *
     * 顺序约束（review-0142b / plan-0145）：
     *   ① 已受理的 gate → 成功（调用方先检查）；
     *   ② 取消 → 取消（调用方先检查）；
     *   ③ 无受理记录时：`turn.failed` / `error` 事件 / 非零退出 / 被信号终止都是**终态错误**，
     *      保留脱敏后的原因，不退化成 `NODE_FINISH_MISSING`，也不消耗提醒预算；
     *   ④ 只有「正常停下（exit 0）、通道可用、无终态错误」才允许提醒 / 续跑；
     *   ⑤ 正常停下但预算耗尽才是 `NODE_FINISH_MISSING`。
     *
     * @returns {{code:string, message:string, details:object}|null}
     */
    const terminalFailureOf = invocation => {
      if (!invocation) return null
      if (invocation.terminalError) {
        const failure = invocation.terminalError
        // `turn.failed` 是明确终态；其它 error 事件可能是 agent 能恢复的中间错误，
        // 只有进程同时异常退出才按终态处理（plan-0145 M6：不能一见 error 就收口）。
        const recovered = failure.kind !== 'turn.failed' && invocation.exitCode === 0
        if (!recovered) {
          // F2：`failure.code` 以前未脱敏、无长度限制地插进 message / errorDetails；
          // 现在 code 与 message 都走同一个有界脱敏出口。
          const cliCode = boundTerminalText(failure.code, 200) || 'unknown'
          const reason = boundTerminalText(failure.message, MAX_TERMINAL_MESSAGE)
            .replace(/\s+/g, ' ')
          return {
            code: failure.kind === 'turn.failed' ? 'CODEX_CLI_TURN_FAILED' : 'CODEX_CLI_ERROR',
            message: boundTerminalText(`Codex 报告终态错误（${cliCode}）：${reason}`),
            details: { kind: failure.kind, cliCode },
          }
        }
      }
      if (!Number.isSafeInteger(invocation.exitCode) && invocation.exitCode !== null) return null
      if (Number.isSafeInteger(invocation.exitCode) && invocation.exitCode !== 0) {
        return {
          code: 'CODEX_CLI_EXIT_NONZERO',
          message: `Codex 进程以非零码退出（exit=${invocation.exitCode}），没有受理 flow_finish_node`,
          details: { kind: 'exit', cliCode: String(invocation.exitCode) },
        }
      }
      if (invocation.exitCode === null && invocation.signal) {
        return {
          code: 'CODEX_CLI_SIGNALED',
          message: `Codex 进程被信号终止（${invocation.signal}），没有受理 flow_finish_node`,
          details: { kind: 'signal', cliCode: String(invocation.signal) },
        }
      }
      return null
    }

    /** 终态错误 → 有界、脱敏的失败结局（abort 闸门，不写成功 record）。 */
    const failWithTerminalError = terminal => {
      state.terminalError = terminal
      abortGate('cli-terminal-error')
      resolveExited({
        ok: false,
        code: terminal.code,
        message: terminal.message,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        ...(terminal.details ? { errorDetails: terminal.details } : {}),
      })
    }

    const finishAfterNaturalExit = async (invocation = null) => {
      // M6 残余 b：先看闸门是否已受理，再看取消——已受理的成功不能被迟到 cancel 覆盖。
      if (finishGate.settled()) {
        await resolveFromGate()
        return
      }
      if (state.canceled) {
        abortGate('canceled')
        resolveExited({
          ok: false,
          code: 'NODE_FINISH_CANCELED',
          message: `Codex 活动被取消${state.cancelReason ? `：${state.cancelReason}` : ''}`,
        })
        return
      }
      if (state.spawnError && !(child && child.pid)) {
        abortGate('spawn-failed')
        resolveExited({
          ok: false,
          code: 'NODE_FINISH_CHANNEL_FAILED',
          message: `Codex 进程启动失败（${state.spawnError.code || 'unknown'}）`,
        })
        return
      }
      // M6 ③：无受理记录时先分流出明确终态错误，绝不退化成 MISSING。
      const terminal = terminalFailureOf(invocation)
      if (terminal) {
        failWithTerminalError(terminal)
        return
      }
      const remaining = settings.reminderLimit - state.reminders
      // 没有 resume 能力就没有提醒机制：直接 MISSING（capabilities 已如实标 unsupported）。
      if (!resumeSupported || remaining <= 0 || !state.sessionId) {
        finishWithoutTool()
        return
      }
      // 原生 hook 没触发（例如 hooks 被用户配置关掉）或本来就走 emulated：进程级续跑提醒。
      let lastExit = null
      while (state.reminders < settings.reminderLimit && !state.canceled) {
        state.reminders += 1
        emitReminder({ count: state.reminders, maxFires: settings.reminderLimit })
        resumeChild = spawnCodex(buildResumeArgs({
          sessionId: state.sessionId,
          prompt: FINISH_REMINDER_TEXT,
          serverPath: SERVER_PATH,
          // resume 是 emulated 兜底：不再注入 Stop hook，提醒次数由本循环唯一计数。
          hookScriptPath: null,
          sandbox: settings.sandbox,
          approvalPolicy: settings.approvalPolicy,
          model,
        }), 'resume')
        const resumeInvocation = invocationOf.get(resumeChild) || null
        lastExit = await waitExit(resumeChild)
        if (resumeInvocation) {
          resumeInvocation.exitCode = lastExit.code
          resumeInvocation.signal = lastExit.signal
        }
        // M3：续跑进程的 stdout 也必须排空（有界）后再判定，不能按 exit 抢跑。
        await drainInvocation(resumeInvocation)
        resumeChild = null
        // M6 残余 b：续跑期间闸门已受理成功，迟到的 cancel 不能覆盖它。
        if (finishGate.settled()) {
          await resolveFromGate()
          return
        }
        if (state.canceled) {
          abortGate('canceled')
          resolveExited({
            ok: false,
            code: 'NODE_FINISH_CANCELED',
            message: `Codex 活动被取消${state.cancelReason ? `：${state.cancelReason}` : ''}`,
          })
          return
        }
        // M6：续跑进程报终态错误时停止提醒，保留真实原因。
        const resumeTerminal = terminalFailureOf(resumeInvocation)
        if (resumeTerminal) {
          failWithTerminalError(resumeTerminal)
          return
        }
      }
      void lastExit
      finishWithoutTool()
    }

    // M4（Codex 侧残余）：**参数构造 + 同步 spawn** 也在保护内。E2BIG 这类同步异常
    // 以前直接冒泡，runDir / MCP server / 完成通道 listener 全部留在原地。
    // 现在与 Claude 同口径：abort gate → 整组 TERM/KILL → 关 channel → 删 runDir，
    // 并把 cleanup / cleanupFinal 挂到错误上。
    try {
      child = spawnCodex(buildExecArgs({
        workspaceRoot: workspace,
        prompt,
        serverPath: SERVER_PATH,
        hookScriptPath,
        sandbox: settings.sandbox,
        approvalPolicy: settings.approvalPolicy,
        model,
      }), 'initial')
    } catch (error) {
      const cleanupOutcome = await cleanupAfterStartFailure()
      throw attachCleanup(attachUsage(new CodexAdapterError(
        ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
        `Codex 进程无法启动（${error && error.code ? error.code : 'SPAWN_FAILED'}）：`
          + '参数或环境不可用，节点零派发',
        {
          adapterId: CODEX_ADAPTER_ID,
          field: 'spawn',
          reason: 'spawn-failed',
          cause: error && error.code ? String(error.code) : 'SPAWN_FAILED',
        },
      )), cleanupOutcome)
    }

    const mainPid = child.pid

    // B1：error / exit 必须在等 hello 之前挂上——否则握手期取消/启动失败会丢事件，
    // cancel 与 dispose 都会挂在一个永远不会 resolve 的 exited 上。
    child.on('error', error => {
      state.spawnError = error
      // 没有 pid 时不会再触发 exit：立刻收口并让 hello 竞速快速失败（M2）。
      // 退出确认由 trackGroup 的 error 分支落账（没有 pid 才视为已退出）。
      if (!mainPid) {
        resolveExited({
          ok: false,
          code: 'NODE_FINISH_CHANNEL_FAILED',
          message: `Codex 进程启动失败（${error && error.code ? error.code : 'unknown'}）`,
        })
        spawnFailureResolve?.({ code: error && error.code ? String(error.code) : 'SPAWN_FAILED' })
      }
    })
    child.on('exit', (code, signal) => {
      state.exitCode = code
      state.signal = signal
      const invocation = invocationOf.get(child) || null
      if (invocation) {
        invocation.exitCode = code
        invocation.signal = signal
      }
      // N2：这里只确认**初始进程**退出；组责任由 trackGroup 保留到整组确认消失。
      // 续跑进程由各自 spawn 时的记录独立确认，绝不复用这个事件。
      if (!channel.contacted && !state.canceled) earlyExitResolve?.({ code, signal })
      // M3：结算前先等 stdout 排空（有界）；合法 JSON 缺尾换行 / 分块写入都能收到。
      ;(async () => {
        await drainInvocation(invocation)
        await finishAfterNaturalExit(invocation)
      })().catch(error => {
        resolveExited({
          ok: false,
          code: error && typeof error.code === 'string' ? error.code : 'NODE_FINISH_CHANNEL_FAILED',
          message: error && error.message ? error.message : 'Codex 收尾失败',
        })
      })
    })

    const handle = {
      get pid() {
        return child && child.pid ? child.pid : undefined
      },
      get sessionId() {
        return state.sessionId
      },
      get reminders() {
        return state.reminders
      },
      get record() {
        return state.record
      },
      get lastMessage() {
        return state.lastMessage === undefined ? undefined : redactText(state.lastMessage)
      },
      get usage() {
        return state.usage
      },
      /**
       * 本次执行观测到的全部模型轮次 usage（每轮独立 callId）。
       * agent-execute 在任何结局收尾时读它：超时 / 取消 / 未 finish 已花的 token
       * 不能因为没走到 activity/end 就丢失。
       */
      usageCalls() {
        return state.usageCalls.map(call => ({
          ...call,
          usage: { ...call.usage },
        }))
      },
      /**
       * 诊断用：每次返回**脱敏后的深拷贝**（本 execution 的 token / socket / runDir
       * 都替换成 `[redacted]`，M4）；完结判定不看这些。
       */
      get events() {
        return redactValue(state.events)
      },
      /** 诊断用（脱敏后的 stdout 尾部）。 */
      get stdoutTail() {
        return redactText(state.stdoutTail)
      },
      get stderrTail() {
        return redactText(state.stderrTail)
      },
      /**
       * M3 诊断（小、有界、导出时脱敏）：
       *   - `protocolErrors`：畸形 JSON / 超长行等协议错误，只含位置、长度、类型；
       *   - `droppedLines`：被整行丢弃的协议行数；
       *   - `diagnostics`：流层诊断（例如排空超时）；
       *   - `outputDrained` / `outputIncomplete`：结算前 stdout 是否已排空。
       * 诊断缓存有界并标记截断，但计量账本（`usageCalls`）不受这个上限影响。
       */
      get protocolErrors() {
        return redactValue(state.protocolErrors)
      },
      get droppedLines() {
        return state.droppedLines
      },
      get diagnostics() {
        return redactValue(state.diagnostics)
      },
      get diagnosticsTruncated() {
        return state.diagnosticsTruncated === true
      },
      get eventsTruncated() {
        return state.eventsTruncated === true
      },
      get outputDrained() {
        return state.outputDrained
      },
      get outputIncomplete() {
        return state.outputIncomplete === true
      },
      /** M6：最后一次观测到的 CLI 终态错误（脱敏后的 code / message）。 */
      get terminalError() {
        return state.terminalError
          ? {
            code: boundTerminalText(state.terminalError.code, 200),
            message: boundTerminalText(state.terminalError.message),
            ...(state.terminalError.details ? { details: redactValue(state.terminalError.details) } : {}),
          }
          : null
      },
      exited,
      /**
       * 逻辑结局 vs 物理清理：`exited` 可以在「杀进程未生效」时有界收口，但
       * `cleanup.disposed===false` 明确告诉 runtime 进程退出尚未确认，不能释放槽位
       * 或清理工作目录（review-0139 F3 / review-0140 N2）。
       *
       * 只有**所有**被跟踪的 codex 子进程（初始 exec + 每次 resume）都收到 exit
       * 才报告 true；未确认时给出原因和仍存活的进程种类。
       */
      get cleanup() {
        return cleanupSnapshot()
      },
      /**
       * review-0141 M1 ③：独立的最终清理 Promise。只有所有被跟踪进程组确认消失
       * 才 resolve `{disposed:true}`；有界超时会 resolve `{disposed:false,timedOut:true}`。
       * runtime 等它 settle 后才释放槽位，不再只读一次快照。
       */
      cleanupFinal,
      cancel: reason => cancelHandle(handle, reason),
      dispose: () => disposeHandle(handle),
    }

    handleRef = handle
    if (pendingAbort) {
      cancelHandle(handle, 'ctx.signal').catch(() => {})
    }

    // 等 MCP server 第一次连上通道：说明 codex 真的把它拉起来了（probe 已验证工具可调用）。
    // 等不到就把进程组收掉，按「工具通道不可用」失败（不允许静默降级）。握手期取消、
    // spawn 失败、进程提前退出都参与竞速，不再死等满 helloTimeoutMs（B1 / M2 / m9）。
    if (settings.helloTimeoutMs > 0) {
      const outcome = await Promise.race([
        channel.firstContact.then(() => 'contacted').catch(() => 'contact-failed'),
        new Promise(resolveWait => {
          const timer = setTimeout(() => resolveWait('timeout'), settings.helloTimeoutMs)
          timer.unref?.()
        }),
        cancelSignal.then(() => 'canceled'),
        spawnFailure.then(() => 'spawn-failed'),
        earlyExit.then(() => 'exited'),
      ])
      const contacted = outcome === 'contacted'
      if (!contacted) {
        if (state.canceled) {
          abortGate('canceled')
          const cleanupOutcome = await cleanupAfterStartFailure()
          throw attachCleanup(attachUsage(new CodexAdapterError(
            'NODE_FINISH_CANCELED',
            'Codex 活动在 MCP 握手期间被取消（finish.sock 与 runDir 已清理）',
            { adapterId: CODEX_ADAPTER_ID, reason: 'canceled-during-handshake' },
          )), cleanupOutcome)
        }
        if (!finishGate.settled()) {
          abortGate('mcp-handshake-failed')
          if (!exitedDone) {
            resolveExited({
              ok: false,
              code: 'NODE_FINISH_CHANNEL_FAILED',
              message: outcome === 'spawn-failed'
                ? `Codex 进程启动失败（${state.spawnError && state.spawnError.code ? state.spawnError.code : 'unknown'}）`
                : 'Codex 没有启动本插件的 MCP 完成通道（tool 不可见），按 11 §1.6 失败',
            })
          }
          const cleanupOutcome = await cleanupAfterStartFailure()
          throw attachCleanup(attachUsage(new CodexAdapterError(
            ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
            outcome === 'spawn-failed'
              ? `Codex 进程无法启动（${state.spawnError && state.spawnError.code ? state.spawnError.code : 'unknown'}）`
              : 'Codex 客户端没有完成 MCP 完成通道握手（flow_finish_node 不可见）',
            {
              adapterId: CODEX_ADAPTER_ID,
              reason: outcome === 'spawn-failed'
                ? 'spawn-failed'
                : (outcome === 'exited' ? 'exited-before-handshake' : 'mcp-handshake-timeout'),
              ...(outcome === 'spawn-failed' && state.spawnError && state.spawnError.code
                ? { cause: state.spawnError.code }
                : {}),
            },
          )), cleanupOutcome)
        }
      }
    }

    /**
     * 取消（幂等，第一次生效）：
     *   - abort 闸门（未 settled）→ 之后的迟到 submit 得到 `NODE_ALREADY_SETTLED`（M3）；
     *   - 进程组清理交给 supervisor：**整组** TERM → KILL 升级，组长先退、后代忽略 TERM
     *     时继续升级（m1）；升级计时器不在这里撤销，只有整组消失才清；
     *   - 有界等待 `exited`，等不到也自己 resolve `NODE_FINISH_CANCELED`（B1：绝不返回
     *     一个 pending 的 `exited`）。
     */
    function cancelHandle(target, reason) {
      if (!target || typeof target !== 'object') {
        return Promise.reject(new CodexAdapterError(
          ADAPTER_ERROR.INVALID,
          'cancel 需要 start() 返回的 handle',
          { adapterId: CODEX_ADAPTER_ID, field: 'handle', reason: 'missing' },
        ))
      }
      if (cancelPromise) return cancelPromise
      if (exitedDone) return Promise.resolve(exited)
      cancelPromise = (async () => {
        if (!state.canceled) {
          state.canceled = true
          state.cancelReason = typeof reason === 'string' && reason !== '' ? reason : 'canceled'
          abortGate(state.cancelReason)
          cancelSignalResolve?.()
          // 每个 spawn 都登记过进程组：取消时把所有组一起收掉（含组长已退出的 resume 组）。
          terminateAllGroups(`canceled: ${state.cancelReason}`).catch(() => {})
        }
        // 有界等待：supervisor 自己会在 killTimeoutMs 后升级到 SIGKILL。
        await Promise.race([exited, sleep(settings.killTimeoutMs + 1_000)])
        if (!exitedDone) {
          // 兜底强制清理（幂等）：仍在登记表里的组立即 SIGKILL 并做有界确认。
          await supervisor.disposeAll().catch(() => {})
          await Promise.race([exited, sleep(1_000)])
        }
        if (!exitedDone) {
          resolveExited({
            ok: false,
            code: 'NODE_FINISH_CANCELED',
            message: `Codex 活动被取消${state.cancelReason ? `：${state.cancelReason}` : ''}（进程退出未确认，按取消收口）`,
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
      // 有界兜底：绝不 await 一个 pending 的 exited（B1）。
      if (!exitedDone) {
        await Promise.race([exited, sleep(settings.killTimeoutMs + 1_000)])
      }
      if (!exitedDone) {
        resolveExited({
          ok: false,
          code: 'NODE_FINISH_CANCELED',
          message: 'Codex 句柄释放时仍未确认进程退出，按取消收口',
        })
      }
      // 兜底：即使 codex 已经退出，也清掉所有被跟踪进程组里残留的 MCP / 工具后代。
      // `disposeAll` 立即 SIGKILL 并做**有界确认**；未确认的组如实保留 pending。
      await supervisor.disposeAll().catch(() => {})
      // M1：有界等待**所有进程组**消失（组长已退出、后代仍活着的组也算未清理）。
      // 这里绝不把「发出了 SIGKILL」当成「进程已退出」——killImpl 可能没生效，
      // resume 进程也可能忽略信号并继续存活。
      await waitTrackedGroupsGone(settings.killTimeoutMs)
      removeSignalListener()
      // 已登记资源（finish-channel / signal-listener / run-dir）统一释放；registry 幂等，
      // 启动失败路径可能已经释放过一部分。
      await resources.disposeAll()
      // 独立最终清理 Promise：dispose 返回后组才退出，也要让 runtime 能看到 disposed:true。
      watchFinalCleanup()
    }

    return handle
  }

  const adapter = {
    id: CODEX_ADAPTER_ID,
    probe,
    capabilities,
    invalidateProbe,
    start,
    /**
     * 0.13.10 可选消息能力的显式占位：本轮不支持轮次中投递。
     *
     * 不抛异常（宿主按 `{ok:false, unsupported:true, deliveryUnknown:true}` 记录），
     * 也绝不返回 ok:true —— CLI 侧安全投递留到下一轮实现。
     */
    async deliverMessage() {
      return {
        ok: false,
        unsupported: true,
        deliveryUnknown: true,
        code: 'CODEX_MESSAGE_DELIVERY_UNSUPPORTED',
        error: 'codex 适配器本轮没有收件箱投递能力：按 deliveryUnknown 记录，不假装成功',
      }
    },
    cancel: (handle, reason) => (handle && typeof handle.cancel === 'function'
      ? handle.cancel(reason)
      : Promise.reject(new CodexAdapterError(
        ADAPTER_ERROR.INVALID,
        'cancel 需要 start() 返回的 handle',
        { adapterId: CODEX_ADAPTER_ID, field: 'handle', reason: 'missing' },
      ))),
    dispose: handle => (handle && typeof handle.dispose === 'function'
      ? handle.dispose()
      : Promise.resolve()),
  }
  return adapter
}

export default createCodexAdapter
