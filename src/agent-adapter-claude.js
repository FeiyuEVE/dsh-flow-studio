/**
 * Claude Code CLI 适配器（0.14.2，G）。
 *
 * 契约：`src/agent-adapter.js` 的冻结接口 + `docs/design/11-node-finish-tool.md`：
 *
 *   - `flow_finish_node` 由本插件自带的 MCP stdio server（`node-finish-mcp.js`）提供，
 *     `claude` 通过**本次进程的** `--mcp-config <file>` + `--strict-mcp-config` 加载它
 *     （只加载这一份配置，不读用户 / 项目的其它 MCP server）；MCP 配置文件写在
 *     每 execution 的私有目录（0700）里、权限 0600，里面的通道凭据只对该次 execution
 *     有效，销毁时整个目录一起删除；
 *   - 是否完结**只以 gate 收到 submit 为准**：退出码、`result` 文本、自然语言「我完成了」
 *     都不能完成节点；未调用工具就停下 → `NODE_FINISH_MISSING`；
 *   - 节点提示词以 `element.node.prompt` / `element.node.roleCard` 为准（与 DSH / Codex
 *     适配器的 `nodePromptBody` 等价），带 `attempt` 与 `ctx.variables`；BPMN
 *     `element.description` 只作补充；
 *   - 提醒机制：**默认 `emulated`**（`claude -p --resume <session-id>` 进程级续跑）。
 *     显式 `settings.stopHook === 'native'` 才写 `--settings` 注入原生 `Stop` hook
 *     （`{"decision":"block","reason":...}`），此时也**只由完成通道计数**（hook 与
 *     外层续跑读的是同一个 `remind` 计数器），不会出现「hook 提醒三次 + 外层再提醒三次」；
 *   - 非交互调用：`claude -p <prompt> --output-format stream-json --verbose`
 *     （官方要求 print + stream-json 配 `--verbose`）。`stream-json` 只用于运行事件、
 *     session id 与 usage；完结判定不看它；
 *   - usage：**协议语义交给 `claude-usage-ledger.js`**（0.14.5 M1 / M2）。适配器只做最小
 *     接线：`assistant` 事件 → `ledger.recordAssistant(event)`（同一 `message.id` 是同一个
 *     模型响应，重复上报替换而不是相加）；`result` 事件 → `ledger.recordResult(event, {
 *     invocationId, resumed })` 产出一份**结算快照**（resume 后范围不可证明时 scope=unknown，
 *     不猜 sum / max）。`handle.usageCalls()` / `handle.usageSnapshots()` 直接暴露账本的
 *     两份事实，适配器不再自己维护递增 callId、也不再把累计值拼进调用列表；
 *   - stdout 分帧（0.14.5 M3）：每个子进程（初始 / 每次 resume / probe）独立
 *     `createUtf8LineReader` + `attachProcessStreams`：UTF-8 跨块安全、EOF flush、超长行
 *     整行丢弃并诊断、协议缓冲与展示 tail 分离；退出结算**等 stdout 排空**（有界，
 *     超时标 `outputIncomplete`）；
 *   - 进程组（0.14.5 M5 / m1）：统一走 `createProcessGroupSupervisor`——完成宽限到期后
 *     TERM → 等 `killTimeoutMs` → KILL → 确认整组消失；`postFinishGraceMs=0` 只跳过宽限
 *     等待，不跳过升级；组长先退但后代忽略 TERM 时继续升级；
 *   - 退出分类（0.14.5 M6）：① gate 已受理 → 完成；② 取消 → 取消；③ 无受理记录时，
 *     握手前失败 → `NODE_FINISH_TOOL_UNAVAILABLE`（带原原因），握手后 CLI 明确终态错误
 *     → 稳定错误码 `CLAUDE_PROVIDER_ERROR`（脱敏 code / subtype / message，**不消耗提醒
 *     预算**；含只有 assistant 消息带 `error`、无 result、退出码 0 的情形，如
 *     `authentication_failed`）；④ 只有正常停下、通道可用、无终态错误才提醒 / 续跑；
 *     ⑤ 预算耗尽才是 `NODE_FINISH_MISSING`；
 *   - 沙箱 / 权限：Claude Code 没有 codex `-s` 那种 OS 沙箱；本适配器默认
 *     `--permission-mode acceptEdits`（允许写文件 / 只读命令，其它 shell 命令会被拒绝），
 *     可用 `settings.permissionMode` 显式改成 `auto` / `dontAsk` / `bypassPermissions` 等。
 *     **不默认 bypassPermissions**：那等于把节点配置变成宿主任意命令执行；
 *   - 取消 / 超时：杀**整个进程组**（claude + 它拉起的 MCP server 子进程），Windows 用
 *     `taskkill /T /F`；取消时先 `finishGate.abort(...)`，之后迟到 submit 得到
 *     `NODE_ALREADY_SETTLED`；`dispose()` 有界等待并按进程组确认物理退出，如实返回
 *     `handle.cleanup` / `handle.cleanupFinal`（照 codex adapter 的语义）；
 *   - 凭据：通道 token 只在 claude 子进程环境与 0600 的 MCP 配置文件的 `env` 里出现；
 *     不进 argv、不进提示词、不进事件 / 日志；`handle` 导出的 events / stdoutTail /
 *     stderrTail / lastMessage 都做脱敏（token、socket、runDir 替换成 `[redacted]`）。
 *
 * ## 本机验收状态（必须如实告知，不要当成已验证能力）
 *
 * 开发 / 交付本文件的环境**没有安装 claude CLI**（`which claude` 为空）。因此：
 *
 *   - `probe()` 里能验证的是：CLI 存在 + `--version` / `--help` 的**参数面**、
 *     MCP 配置文件形状、以及 `verifyFinishBridge()` 的真实 MCP stdio 往返（我们自己
 *     server 的那一侧）；
 *   - **没有验证**的是：真实 claude CLI 是否接受这份 `--mcp-config` 并在启动时拉起
 *     MCP server、`-p` / `stream-json` 的真实事件流、`--resume` 续跑、Stop hook 的实际
 *     生效。这些由 `scripts/claude-smoke.mjs` 在有 CLI 的机器上跑；本机缺 CLI 时脚本
 *     明确 skip（退出码 0 + `skipped:true`），**不代表通过**；
 *   - 单元测试（`test/agent-adapter-claude.test.mjs`）用假 `claude` CLI 覆盖协议与失败
 *     语义（真 MCP 通道、真进程组、真 gate），不冒充真实 CLI 验收；
 *   - 因此真实环境里 `capabilities().finishTool` 仍然**只由 probe 决定**：
 *     CLI 缺失 / 参数面不足 / 桥自检失败 → `unsupported`，adapter 在 admission 阶段
 *     被拒绝，不会「静默降级」成解析文本。
 *
 * 官方参考：<https://code.claude.com/docs/en/headless>、
 * <https://code.claude.com/docs/en/hooks>、<https://code.claude.com/docs/en/cli-reference>。
 *
 * ## 证据层次（文档 / capabilities evidence 必须区分，0.14.5 N1）
 *
 *   1. **参数探测**：`claude --version` / `claude --help` 的版本与参数面；
 *   2. **桥自检**：`verifyFinishBridge()` 用官方 MCP SDK 跑一次我们**自己**的 stdio
 *      server（initialize / tools.list / tools.call），证明桥这一侧可用；
 *   3. **真实 CLI 握手 + finish**：真实 `claude -p` 是否拉起本插件的 MCP server、模型是否
 *      真的调用 `flow_finish_node`。**本机没有 claude CLI，第 3 层未验证**，只有
 *      `scripts/claude-smoke.mjs` 在有 CLI 的机器上能给出结论。
 *
 * @module @feiyueve/dsh-flow-studio/agent-adapter-claude
 */

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, promises as fsp, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AdapterError, ADAPTER_ERROR } from './agent-adapter.js'
import { createProcessGroupSupervisor, createResourceRegistry } from './agent-cli-lifecycle.js'
import { attachProcessStreams, createUtf8LineReader, DEFAULT_MAX_LINE_BYTES } from './agent-cli-stream.js'
import { createClaudeUsageLedger } from './claude-usage-ledger.js'
import { redactText as redactSharedText } from './process-output.js'
import {
  FINISH_CHANNEL_ENV,
  FINISH_REMINDER_TEXT,
  createFinishChannel,
  defaultTmpRoot,
  verifyFinishBridge,
} from './node-finish-mcp.js'

/** 适配器 id（注册表 / 运行日志 / admission 都用它）。 */
export const CLAUDE_ADAPTER_ID = 'claude'

/** 默认最多提醒次数（11 §3.1：默认 3 次）。 */
export const CLAUDE_REMINDER_LIMIT = 3

/** 这个适配器声明的工具通道（文档与能力表共用一份说法）。 */
export const CLAUDE_FINISH_TOOL_EVIDENCE = 'mcp-stdio flow_finish_node via --mcp-config + --strict-mcp-config'
  + '（每 execution 一次性凭据，0600 私有配置）'

/** 原生 Stop hook 的证据：只有官方文档形状，**没有真实 CLI 验收**。 */
export const CLAUDE_STOP_HOOK_EVIDENCE = 'Claude Code Stop hook 的 {"decision":"block","reason":...} 是官方文档契约'
  + '（code.claude.com/docs/en/hooks）；本机没有 claude CLI，**未经真实 CLI 验收**，'
  + '只在显式 stopHook:"native" 时启用，需人工 / 发布验证'

/** 真实通道未验收的固定说明（写进 capabilities evidence 与报告）。 */
export const CLAUDE_UNVERIFIED_EVIDENCE = '本机没有安装 claude CLI（which claude 为空）：'
  + '真实 CLI 的 -p / stream-json / --mcp-config / --resume / Stop hook 通道**未验收**；'
  + '单测用假 CLI 覆盖协议，真实通道看 scripts/claude-smoke.mjs'

/** 用户 / 项目侧配置仍可能生效（没有做 `--setting-sources` 隔离）。 */
export const CLAUDE_USER_CONFIG_EVIDENCE = '用户的 ~/.claude/settings.json、CLAUDE.md、skills、'
  + '以及用户/项目 hooks 仍可能作用到本适配器启动的 claude 进程（只隔离了 MCP：'
  + '--strict-mcp-config + --mcp-config）；native Stop hook 与用户 Stop hook 可能同时存在'

/** `--mcp-config` 用到的 MCP server 名（决定工具全名 `mcp__flow_finish__flow_finish_node`）。 */
export const CLAUDE_MCP_SERVER_NAME = 'flow_finish'

/** 完结工具在 Claude 里的全名（`--allowedTools` 规则也用这个）。 */
export const CLAUDE_FINISH_MCP_TOOL_NAME = `mcp__${CLAUDE_MCP_SERVER_NAME}__flow_finish_node`

/** `--permission-mode` 的合法取值（官方 CLI reference；`manual` 是 `default` 的别名）。 */
export const CLAUDE_PERMISSION_MODES = Object.freeze([
  'default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions', 'manual',
])

const PERMISSION_MODE_SET = new Set(CLAUDE_PERMISSION_MODES)
const MODEL_PATTERN = /^[\x21-\x7e][\x20-\x7e]{0,127}$/

/**
 * 稳定的 provider 错误码：**握手之后** CLI 自己给出的终态错误（认证失败 / result
 * `is_error` / 非零退出码）。它不是「没有调用 finish」，所以不消耗提醒预算。
 */
export const CLAUDE_PROVIDER_ERROR_CODE = 'CLAUDE_PROVIDER_ERROR'

/**
 * A3：命令行过长（Linux `E2BIG`；Windows `ERROR_FILENAME_EXCED_RANGE` / errno 206，
 * Windows 未实测）。它是**启动前**的输入规模问题，不是「CLI 没有工具通道」，
 * 所以给独立错误码与可操作 hint。
 */
export const CLAUDE_ARGV_TOO_LARGE_CODE = 'CLAUDE_ARGV_TOO_LARGE'

/**
 * stream-json 单行上限（原始字节）：**共享默认值 32 MiB**。
 *
 * 不能在本适配器里另写 8 MiB：resume / 大会话的单条 result（含完整结果正文）会
 * 超过 8 MiB，整行丢弃后 result 消失，provider 错误被误判成 `NODE_FINISH_MISSING`。
 * 9 MiB 级合法事件必须通过；probe 的 `--help` 也走同一个上限。
 */
const CLAUDE_MAX_LINE_BYTES = DEFAULT_MAX_LINE_BYTES
/** 展示用 stdout tail 上限。 */
const CLAUDE_STDOUT_TAIL_BYTES = 64 * 1024
/** 展示用 stderr tail 上限。 */
const CLAUDE_STDERR_TAIL_BYTES = 8 * 1024
/** 子进程退出后等 stdout 排空的上限（有界；超时标 outputIncomplete）。 */
const CLAUDE_DRAIN_TIMEOUT_MS = 5_000
/** 保留的流诊断条数（诊断缓存可以裁，计量账本不能）。 */
const MAX_STREAM_DIAGNOSTICS = 50
/** 保留的协议事件条数（与旧行为一致）。 */
const MAX_PROTOCOL_EVENTS = 200
/** 错误文本脱敏后的字符上限。 */
const MAX_ERROR_TEXT = 200
/**
 * F2：**终态错误**的最终 UTF-8 字节上限（code / subtype / message 各自不超过它）。
 * provider 错误文本不可信（Codex 侧实测能到 12 KB），既有共享脱敏也不能保证有界。
 */
const MAX_TERMINAL_ERROR_BYTES = 1_000

/**
 * **唯一的 CLI 参数要求表**（0.14.5 m4）：probe 拒绝、start 零派发、capabilities
 * evidence 三处共用这一份。缺失的必需参数不允许「静默省略却仍声称严格隔离」。
 */
const CLAUDE_REQUIRED_FLAGS = Object.freeze([
  { key: 'print', argv: '--print', need: '非交互 -p' },
  { key: 'outputFormat', argv: '--output-format', need: 'stream-json 运行事件' },
  { key: 'verbose', argv: '--verbose', need: 'print + stream-json 官方要求 --verbose' },
  { key: 'mcpConfig', argv: '--mcp-config', need: '加载本次 MCP 配置' },
  { key: 'strictMcpConfig', argv: '--strict-mcp-config', need: '只加载本次 MCP 配置（严格隔离声明的前提）' },
  { key: 'permissionMode', argv: '--permission-mode', need: '显式权限档位' },
  { key: 'allowedTools', argv: '--allowedTools', need: '预授权完结工具' },
  { key: 'resume', argv: '--resume', need: 'emulated 提醒续跑' },
])

/** 原生 Stop hook 额外要求的参数（只在 `stopHook:"native"` 时进入要求表）。 */
const CLAUDE_NATIVE_HOOK_FLAG = Object.freeze({ key: 'settings', argv: '--settings', need: '注入原生 Stop hook' })

/** 按提醒机制返回本次启动真正需要 CLI 认识的参数表。 */
function requiredFlagEntries(stopHook) {
  return stopHook === 'native'
    ? [...CLAUDE_REQUIRED_FLAGS, CLAUDE_NATIVE_HOOK_FLAG]
    : [...CLAUDE_REQUIRED_FLAGS]
}

/** `--help` 里是否确认了某个参数（allowedTools 可能是别名字符串）。 */
function flagPresent(flags, key) {
  const value = flags && typeof flags === 'object' ? flags[key] : undefined
  if (key === 'allowedTools') return value === true || typeof value === 'string'
  return value === true
}

/**
 * 归一化 probe 结果里的参数面。
 *
 * 真 probe 一定同时给 `flags` 与顶层布尔；但注入的 `probeResult`（测试 / 上层缓存）
 * 可能只有顶层字段（0.14.2 形状）。这里把两者合并成同一份「实际确认到的参数」，
 * 参数要求表仍然只查这一份——缺失就是缺失，不猜。
 */
function probeFlagsOf(probeValue) {
  const raw = isPlainObject(probeValue && probeValue.flags) ? probeValue.flags : {}
  const probe = isPlainObject(probeValue) ? probeValue : {}
  const pick = (key, legacy) => {
    if (key === 'allowedTools') {
      if (typeof raw.allowedTools === 'string' && raw.allowedTools !== '') return raw.allowedTools
      if (raw.allowedTools === true) return '--allowedTools'
      return false
    }
    if (raw[key] === true) return true
    return legacy === true
  }
  return {
    print: pick('print', probe.printMode),
    outputFormat: pick('outputFormat', probe.outputFormat),
    mcpConfig: pick('mcpConfig', probe.mcpConfig),
    strictMcpConfig: pick('strictMcpConfig', probe.strictMcpConfig),
    settings: pick('settings', probe.settingsFlag),
    resume: pick('resume', probe.resume),
    sessionId: pick('sessionId', probe.sessionIdFlag),
    permissionMode: pick('permissionMode', probe.permissionModeFlag),
    permissionPrompts: pick('permissionPrompts'),
    allowedTools: pick('allowedTools'),
    // A1：可选参数（不在要求表里）。CLI 不认识时只是不传，不拒绝启动。
    disallowedTools: pick('disallowedTools', probe.disallowedTools),
    model: pick('model'),
    verbose: pick('verbose'),
  }
}

/** 缺失的必需参数 key 列表。 */
function missingRequiredFlags(flags, entries) {
  return entries.filter(entry => !flagPresent(flags, entry.key)).map(entry => entry.key)
}

/**
 * F2：按 UTF-8 字节截断，并显式标记截断（绝不静默丢弃）。
 *
 * 用码点迭代而不是 `slice()`：后者按 UTF-16 单元切，可能把代理对切成半个字符；
 * 这里保证输出仍然是合法 UTF-8 且总字节数不超过 `limit`。
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

/** 按 UTF-8 字节取尾部（起点落在续字节上时向后对齐），用于展示 tail。 */
function truncateTailUtf8Bytes(text, limit) {
  const buffer = Buffer.from(typeof text === 'string' ? text : String(text ?? ''), 'utf8')
  if (buffer.length <= limit) return buffer.toString('utf8')
  let start = buffer.length - limit
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1
  return buffer.subarray(start).toString('utf8')
}

/** 实际要拼进 argv 的 `--allowedTools` 别名（probe 确认了哪个就用哪个）。 */
function resolveAllowedToolsFlag(flags) {
  const value = flags && typeof flags === 'object' ? flags.allowedTools : undefined
  return value === '--allowed-tools' ? '--allowed-tools' : '--allowedTools'
}

/**
 * A3：这个 spawn 失败是不是「命令行太长」？
 *
 * - Linux / POSIX：`E2BIG`（单个 argv 元素超过 MAX_ARG_STRLEN=128 KiB，或总长超 ARG_MAX）；
 * - Windows：`ERROR_FILENAME_EXCED_RANGE`（Win32 错误号 206，CreateProcess 命令行超限），
 *   Node 侧以 `code` / `errno` 的形式之一出现。**Windows 路径未实测**，只按错误号形状
 *   归类；未命中时仍走原来的 `NODE_FINISH_TOOL_UNAVAILABLE`，不会误吞普通启动失败。
 */
function isArgvTooLargeError(error) {
  if (!error || typeof error !== 'object') return false
  return error.code === 'E2BIG'
    || error.code === 'ERROR_FILENAME_EXCED_RANGE'
    || error.errno === 206
}

/**
 * A3：命令行过长的独立错误（与「CLI 没有工具通道」区分）。
 *
 * 清理由 start 的统一失败路径负责；这里只把「是什么问题、怎么办」说清楚。
 */
function argvTooLargeError({ error, args }) {
  const cause = error && error.code
    ? String(error.code)
    : (error && error.errno !== undefined ? `ERRNO_${error.errno}` : 'ARGV_TOO_LARGE')
  const argvList = Array.isArray(args) ? args : []
  const promptBytes = argvList[0] === '-p' && typeof argvList[1] === 'string'
    ? Buffer.byteLength(argvList[1], 'utf8')
    : 0
  const argvBytes = argvList.reduce((sum, arg) => sum + Buffer.byteLength(String(arg), 'utf8') + 1, 0)
  const hint = '把大段正文写进工作区文件，用 flow_finish_node 的 documents 引用；'
    + '或缩短 element.node.prompt / ctx.variables 后重试'
  return new ClaudeAdapterError(
    CLAUDE_ARGV_TOO_LARGE_CODE,
    `Claude 启动命令行超长（${cause}）：提示词或变量过大（prompt ${promptBytes} 字节，`
      + `argv 合计 ${argvBytes} 字节），进程未能启动。${hint}。`
      + '这是输入规模问题，不是「CLI 没有工具通道」。',
    {
      adapterId: CLAUDE_ADAPTER_ID,
      field: 'spawn',
      reason: 'argv-too-large',
      cause,
      hint,
      promptBytes,
      argvBytes,
    },
  )
}

/** 解析出的最低主版本：1.x 的 `--mcp-config` / `-p` 行为与本适配器假设不同。 */
const CLAUDE_MIN_MAJOR = 2

const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'node-finish-mcp.js')
const MCP_CONFIG_NAME = 'mcp-config.json'
const SETTINGS_NAME = 'settings.json'
const HOOK_SCRIPT_NAME = 'finish-stop-hook.mjs'

/**
 * Stop hook 脚本（原生提醒路径）：从 stdin 读 Claude 的 hook 事件，经本地完成通道问
 * 「还要不要提醒」。提醒次数与完结判定都在 adapter 进程里，hook 只转发结论。
 * **永远 exit 0**：hook 自身出错不能把 agent 卡死；没有提醒就不输出决策。
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
export class ClaudeAdapterError extends AdapterError {
  constructor(code, message, details) {
    super(code, message, details)
    this.name = 'ClaudeAdapterError'
  }
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text))
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), raw: match[0] }
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(dir, 0o700)
  return dir
}

/** 有界等待用的定时器：**不 unref**——兜底计时必须能可靠触发。 */
function sleep(ms) {
  return new Promise(resolveSleep => {
    setTimeout(resolveSleep, ms)
  })
}

function quoteShellArg(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`
}

/**
 * 传给 claude 子进程的环境白名单。
 *
 * 只放 CLI / 模型认证 / 可执行查找真正需要的东西：宿主进程里的其它内部令牌不继承
 * （Claude 能执行 shell，环境变量会暴露给模型执行的命令）。`CLAUDE_*` 与
 * `ANTHROPIC_*` 前缀保留：真实安装常用它们指定配置目录 / provider / 认证。
 */
const CHILD_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'USER', 'LOGNAME', 'TERM',
  'LANG', 'LANGUAGE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  // Windows 必需的最小系统变量。
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'HOMEDRIVE', 'HOMEPATH', 'WINDIR',
])
const CHILD_ENV_PREFIXES = Object.freeze(['LC_', 'CLAUDE_', 'ANTHROPIC_', 'AWS_', 'GOOGLE_', 'VERTEX_'])

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

/**
 * 把「节点模型」解析成一个可传给 `--model` 的字符串。
 *
 * 优先级与 DSH / Codex 适配器对齐：`options.model` / `settings.agentOptions` →
 * `ctx.agentOptions` → `node.agentOptions` → `node.model`。
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
      throw new ClaudeAdapterError(
        ADAPTER_ERROR.INVALID,
        `节点模型标识非法（只允许 1–128 个可见 ASCII 字符）：${JSON.stringify(model.slice(0, 40))}`,
        { adapterId: CLAUDE_ADAPTER_ID, field: 'model', reason: 'invalid-model' },
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
    throw new ClaudeAdapterError(
      ADAPTER_ERROR.INVALID,
      `Claude 适配器选项 ${field} 非法：${JSON.stringify(value)}（允许：${[...allowed].join(' / ')}）`,
      { adapterId: CLAUDE_ADAPTER_ID, field, reason: 'invalid-value' },
    )
  }
  return value
}

/**
 * 跑一次 claude 子命令（probe 用），带超时；失败收敛成结果对象，不抛异常。
 * 子进程环境同样走白名单，并叠加 `options.env`（测试 / 特殊接线）。
 *
 * 0.14.5 M3：probe 的 stdout/stderr 也走共享分帧 helper——UTF-8 跨块安全、EOF flush、
 * 超长行不裁剪成半截；只有 `drained`（有界）之后才结算。
 */
function runOnce(command, args, options = {}) {
  return new Promise(resolvePromise => {
    const lines = []
    let settled = false
    let timer = null
    let child = null
    let streams = null
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        streams?.dispose()
      } catch {
        // 忽略
      }
      resolvePromise(result)
    }
    const reader = createUtf8LineReader({
      maxLineBytes: CLAUDE_MAX_LINE_BYTES,
      // 只保留需要解析的行（--version / --help 不会超过 4000 行）。
      onLine: line => {
        if (lines.length < 4_000) lines.push(line)
      },
    })
    try {
      child = spawn(command, args, {
        env: buildChildEnv([isPlainObject(options.env) ? options.env : {}]),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ ok: false, code: error && error.code ? String(error.code) : 'SPAWN_FAILED', stdout: '', stderr: '' })
      return
    }
    streams = attachProcessStreams(child, {
      stdoutReader: reader,
      stdoutTailBytes: CLAUDE_STDOUT_TAIL_BYTES,
      stderrTailBytes: CLAUDE_STDERR_TAIL_BYTES,
      drainTimeoutMs: CLAUDE_DRAIN_TIMEOUT_MS,
    })
    const limit = options.timeoutMs || 20_000
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      finish({ ok: false, code: 'TIMEOUT', stdout: lines.join('\n'), stderr: streams.stderrTail() })
    }, limit)
    timer.unref?.()
    child.on('error', error => {
      finish({
        ok: false,
        code: error && error.code ? String(error.code) : 'SPAWN_FAILED',
        stdout: lines.join('\n'),
        stderr: streams.stderrTail(),
      })
    })
    child.on('exit', (code, signal) => {
      // 结算前先等 stdout 排空（有界）：最后一个事件可能晚于 exit 到达。
      Promise.resolve(streams.drained).then(() => {
        finish({
          ok: code === 0,
          code: code === null ? 'SIGNAL' : String(code),
          signal,
          stdout: lines.join('\n'),
          stderr: streams.stderrTail(),
        })
      })
    })
  })
}

/** 11 §6 的完结契约（与 DSH / Codex 适配器同一份语义）。 */
const CLAUDE_FINISH_PROMPT_CONTRACT = Object.freeze([
  '做完本节点的活、要往下流转时，必须调用工具 flow_finish_node：',
  '  variables  后续网关要用的短变量（只能是 boolean / number / 短字符串 / null，禁止大对象）',
  '  documents  你写下的文件的相对路径清单（正文在文件里，不要塞进 variables）',
  '  summary    一句话说明本节点做了什么',
  '不调用该工具就不算完结，流程不会往下走。',
])

/**
 * 构造给 claude 的节点提示词（B2）。
 *
 * 任务本体来自 `element.node.prompt` / `element.node.roleCard`；`element.description`
 * 只作补充，不能替代任务。同时注入 `ctx.attempt` 与短变量 `ctx.variables`。
 *
 * @param {{ element: object, ctx?: object, workspaceRoot: string }} input
 * @returns {string}
 */
function buildClaudeNodePrompt({ element, ctx, workspaceRoot }) {
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
  lines.push(CLAUDE_FINISH_PROMPT_CONTRACT.join('\n'))
  lines.push(`工作区（documents.path 的相对基准）：${workspaceRoot}`)
  return lines.join('\n\n')
}

/**
 * 生成 `--mcp-config` 文件内容：只加载这一个 stdio server，通道凭据放在 `env` 里
 * （文件本身 0600、目录 0700，销毁时整个目录删除）。
 *
 * @param {{ serverPath: string, env: Record<string,string> }} input
 * @returns {object}
 */
function buildMcpConfig({ serverPath, env }) {
  return {
    mcpServers: {
      [CLAUDE_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args: [serverPath],
        env: { ...env },
      },
    },
  }
}

/**
 * 校验 MCP 配置形状（probe 用；纯函数，不写盘、不触碰真实凭据）。
 *
 * @param {unknown} config
 * @param {string} serverPath
 * @returns {boolean}
 */
function validateMcpConfigShape(config, serverPath) {
  const servers = isPlainObject(config) && isPlainObject(config.mcpServers) ? config.mcpServers : null
  const server = servers && isPlainObject(servers[CLAUDE_MCP_SERVER_NAME]) ? servers[CLAUDE_MCP_SERVER_NAME] : null
  if (!server) return false
  return server.type === 'stdio'
    && typeof server.command === 'string' && server.command !== ''
    && Array.isArray(server.args) && server.args.includes(serverPath)
    && isPlainObject(server.env)
    && typeof server.env[FINISH_CHANNEL_ENV.socket] === 'string'
    && server.env[FINISH_CHANNEL_ENV.socket] !== ''
    && typeof server.env[FINISH_CHANNEL_ENV.token] === 'string'
    && server.env[FINISH_CHANNEL_ENV.token] !== ''
}

/**
 * 原生 Stop hook 的 `--settings` 文件（值覆盖同名设置键；hooks 会与其它设置层合并，
 * 所以用户的 Stop hook 仍可能执行——已在 capabilities.evidence 里如实声明）。
 *
 * @param {{ hookScriptPath: string }} input
 * @returns {object}
 */
function buildStopHookSettings({ hookScriptPath }) {
  const command = `${quoteShellArg(process.execPath)} ${quoteShellArg(hookScriptPath)}`
  return {
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command, timeout: 30 }] },
      ],
    },
  }
}

/**
 * 拼一次 `claude -p` 的 argv。
 *
 * prompt 紧跟 `-p`（官方示例形状）；`--output-format stream-json` 必须配 `--verbose`。
 *
 * 0.14.5 m4：必需参数**一律拼上**——`start()` 会先用同一份参数要求表核对 probe 结果，
 * 缺失的参数在那里就拒绝启动，不会走到这里「静默省略却仍声明严格隔离」。`--allowedTools`
 * 使用 probe 实际确认的别名（老版本只认 `--allowed-tools`）。
 *
 * @param {object} input
 * @returns {string[]}
 */
function buildClaudeArgs({
  prompt, mcpConfigPath, settingsPath, permissionMode, model, resumeSessionId, sessionId, flags,
}) {
  const args = ['-p', prompt]
  args.push('--output-format', 'stream-json')
  args.push('--verbose')
  args.push('--mcp-config', mcpConfigPath)
  args.push('--strict-mcp-config')
  args.push('--permission-mode', permissionMode)
  if (settingsPath) args.push('--settings', settingsPath)
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId)
  } else if (sessionId && flags && flags.sessionId === true) {
    args.push('--session-id', sessionId)
  }
  if (model) args.push('--model', model)
  args.push(resolveAllowedToolsFlag(flags), CLAUDE_FINISH_MCP_TOOL_NAME)
  // A1：非交互运行里没人回答 AskUserQuestion——支持该参数的 CLI 直接禁用提问工具。
  // CLI 不支持（probe 未确认）时不传，绝不假装禁用（capabilities.evidence 会如实标注）。
  if (flags && flags.disallowedTools === true) args.push('--disallowedTools', 'AskUserQuestion')
  // 无人可答权限询问：不让 -p 卡在一个不会有人回答的提示上。旧版本不认识就别加。
  if (flags && flags.permissionPrompts === true) args.push('--permission-prompts', 'none')
  return args
}

/**
 * 创建一个 Claude Code 适配器。
 *
 * @param {object} [options]
 * @param {string} [options.claudeBin] claude 可执行（默认 `claude`，走 PATH）
 * @param {string} [options.tmpRoot] 私有临时根（默认 `$FLOW_STUDIO_TMP` 或 `os.tmpdir()/flow-studio`，0700）
 * @param {number} [options.reminderLimit] 最多提醒次数（默认 3）
 * @param {number} [options.postFinishGraceMs] 工具完成后等进程自然退出的宽限（默认 5000）
 * @param {number} [options.killTimeoutMs] SIGTERM → SIGKILL 的间隔（默认 3000）
 * @param {number} [options.helloTimeoutMs] 等 MCP server 连上通道的超时（默认 30000）
 * @param {number} [options.probeTimeoutMs] probe 的总超时（默认 60000）
 * @param {number} [options.probeCacheTtlMs] probe 缓存 TTL（默认 600000；0 = 不过期）
 * @param {'auto'|'native'|'emulated'} [options.stopHook] 提醒机制（默认 `auto` = emulated；
 *   只有显式传 `native` 才注入原生 Stop hook 并标 native）
 * @param {string} [options.permissionMode] `--permission-mode`（默认 `acceptEdits`）
 * @param {string} [options.model] 默认模型（可被 element.node.model / agentOptions.model 覆盖）
 * @param {object} [options.agentOptions] 默认模型路由（取 `.model`）
 * @param {NodeJS.ProcessEnv} [options.env] 额外注入 claude 子进程的环境变量（测试 / 特殊接线）
 * @param {object} [options.probeResult] 注入 probe 结果（测试 / 上层缓存用）
 * @param {boolean} [options.selfTest] probe 是否跑一次真实 MCP 往返（默认 true）
 */
export function createClaudeAdapter(options = {}) {
  const settings = {
    claudeBin: typeof options.claudeBin === 'string' && options.claudeBin !== '' ? options.claudeBin : 'claude',
    // 默认**不能**落在插件安装目录（pnpm store / 只读安装会 mkdir 失败）。
    tmpRoot: typeof options.tmpRoot === 'string' && options.tmpRoot !== ''
      ? resolve(options.tmpRoot)
      : defaultTmpRoot(),
    reminderLimit: Number.isSafeInteger(options.reminderLimit) && options.reminderLimit >= 0
      ? options.reminderLimit
      : CLAUDE_REMINDER_LIMIT,
    postFinishGraceMs: Number.isSafeInteger(options.postFinishGraceMs) && options.postFinishGraceMs >= 0
      ? options.postFinishGraceMs
      : 5_000,
    killTimeoutMs: Number.isSafeInteger(options.killTimeoutMs) && options.killTimeoutMs >= 0
      ? options.killTimeoutMs
      : 3_000,
    helloTimeoutMs: Number.isSafeInteger(options.helloTimeoutMs) && options.helloTimeoutMs >= 0
      ? options.helloTimeoutMs
      : 30_000,
    probeTimeoutMs: Number.isSafeInteger(options.probeTimeoutMs) && options.probeTimeoutMs >= 1_000
      ? options.probeTimeoutMs
      : 60_000,
    probeCacheTtlMs: Number.isSafeInteger(options.probeCacheTtlMs) && options.probeCacheTtlMs >= 0
      ? options.probeCacheTtlMs
      : 10 * 60_000,
    stopHook: options.stopHook === 'native' || options.stopHook === 'emulated' ? options.stopHook : 'auto',
    permissionMode: normalizeChoice(options.permissionMode, PERMISSION_MODE_SET, 'acceptEdits', 'permissionMode'),
    model: typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : undefined,
    agentOptions: isPlainObject(options.agentOptions) ? options.agentOptions : undefined,
    // 测试 / 故障注入：替换真实进程组回收实现（透传给共享 supervisor）。
    killImpl: typeof options.killImpl === 'function' ? options.killImpl : null,
    env: isPlainObject(options.env) ? options.env : {},
    selfTest: options.selfTest !== false,
  }

  /** @type {{ value: object, at: number }|null} */
  let probeCache = isPlainObject(options.probeResult)
    ? { value: { ...options.probeResult }, at: Date.now() }
    : null
  let probePromise = null

  /** 读 probe 缓存（过 TTL 当没有）。 */
  function readProbeCache() {
    if (!probeCache) return null
    const ttl = settings.probeCacheTtlMs
    if (ttl > 0 && Date.now() - probeCache.at >= ttl) {
      probeCache = null
      return null
    }
    return probeCache.value
  }

  const probeInvalid = (reason, message, details) => new ClaudeAdapterError(
    ADAPTER_ERROR.PROBE_INVALID,
    message,
    { adapterId: CLAUDE_ADAPTER_ID, field: 'probe', reason, ...(details || {}) },
  )

  /** 从 `claude --help` 里读参数面（只作为证据，不代替真实运行）。 */
  function parseHelpFlags(helpText) {
    const text = typeof helpText === 'string' ? helpText : ''
    return {
      print: /(^|\s)(--print|-p)(\b|,|\s)/.test(text),
      outputFormat: /--output-format\b/.test(text),
      mcpConfig: /--mcp-config\b/.test(text),
      strictMcpConfig: /--strict-mcp-config\b/.test(text),
      settings: /--settings\b/.test(text),
      resume: /--resume\b/.test(text),
      sessionId: /--session-id\b/.test(text),
      permissionMode: /--permission-mode\b/.test(text),
      permissionPrompts: /--permission-prompts\b/.test(text),
      // m4：记录实际识别到的别名，argv 用同一个（老版本只有 --allowed-tools）。
      allowedTools: /--allowedTools\b/.test(text)
        ? '--allowedTools'
        : (/--allowed-tools\b/.test(text) ? '--allowed-tools' : false),
      // A1：可选。CLI 不支持时 argv 不传，capabilities evidence 如实标未支持。
      disallowedTools: /--disallowedTools\b/.test(text),
      model: /--model\b/.test(text),
      verbose: /--verbose\b/.test(text),
    }
  }

  /** 真正跑一遍 CLI 探测；任何一项不可用都抛 `ADAPTER_PROBE_INVALID`。 */
  async function probeOnce() {
    const commandTimeoutMs = settings.probeTimeoutMs
    const run = (args, extra) => runOnce(settings.claudeBin, args, {
      env: settings.env,
      timeoutMs: commandTimeoutMs,
      ...(extra || {}),
    })

    const versionResult = await run(['--version'])
    if (!versionResult.ok) {
      throw probeInvalid(
        'cli-unavailable',
        `claude --version 失败（${versionResult.code}）：CLI 不可用，适配器不能提供 flow_finish_node`,
        { cause: versionResult.code },
      )
    }
    const version = parseVersion(versionResult.stdout || versionResult.stderr)
    if (!version) {
      throw probeInvalid(
        'version-unparsable',
        `claude --version 的输出无法解析出版本号：${JSON.stringify((versionResult.stdout || '').slice(0, 120))}`,
      )
    }
    if (version.major < CLAUDE_MIN_MAJOR) {
      throw probeInvalid(
        'version-unsupported',
        `claude ${version.raw} 低于本适配器要求的 ${CLAUDE_MIN_MAJOR}.x：`
          + '早期版本没有可用的 --mcp-config / stream-json 组合，适配器拒绝宣称可用',
        { version: version.raw, minMajor: CLAUDE_MIN_MAJOR },
      )
    }

    const help = await run(['--help'])
    if (!help.ok) {
      throw probeInvalid(
        'help-failed',
        `claude --help 失败（${help.code}）：无法确认非交互 / MCP / 续跑参数，适配器拒绝宣称可用`,
        { cause: help.code },
      )
    }
    const flags = parseHelpFlags(help.stdout || help.stderr)
    // m4：唯一参数要求表；缺失任何必需参数都拒绝宣称可用，start 也不会静默省略。
    const requiredFlags = requiredFlagEntries(settings.stopHook)
    const missing = missingRequiredFlags(flags, requiredFlags)
    if (missing.length > 0) {
      throw probeInvalid(
        'cli-flags-missing',
        `claude --help 缺少本适配器必需的参数（${missing.join(' / ')}）：`
          + '无法按 11 §1.6 提供原生 flow_finish_node，也不能声称严格隔离 / 预授权',
        { missing, required: requiredFlags.map(entry => entry.key) },
      )
    }

    // MCP 配置形状自检：用占位值构建 + 校验（不写盘、不含真实凭据）。
    const probeConfig = buildMcpConfig({
      serverPath: SERVER_PATH,
      env: { [FINISH_CHANNEL_ENV.socket]: '__probe__', [FINISH_CHANNEL_ENV.token]: '__probe__' },
    })
    const mcpConfig = validateMcpConfigShape(probeConfig, SERVER_PATH)
    if (!mcpConfig) {
      throw probeInvalid(
        'mcp-config-shape-invalid',
        '适配器生成的 --mcp-config 形状不合法（内部错误）：不能保证 flow_finish_node 被加载',
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
      helpDigest: sha256(`${help.stdout}\n${help.stderr}`).slice(0, 40),
      flags,
      // 0.14.5 m4：把要求表与「实际确认到的参数」一起带出去，start / capabilities 共用。
      requiredFlags: requiredFlags.map(entry => entry.key),
      missingFlags: [],
      allowedToolsFlag: resolveAllowedToolsFlag(flags),
      // A1：可选参数探测结果，start 决定要不要拼 --disallowedTools。
      disallowedTools: flags.disallowedTools === true,
      printMode: flags.print,
      outputFormat: flags.outputFormat,
      mcpConfig,
      mcpConfigFlag: flags.mcpConfig,
      strictMcpConfig: flags.strictMcpConfig,
      settingsFlag: flags.settings,
      resume: flags.resume,
      sessionIdFlag: flags.sessionId,
      permissionModeFlag: flags.permissionMode,
      stopHookFlag: flags.settings,
      bridge,
      finishToolEvidence: CLAUDE_FINISH_TOOL_EVIDENCE,
      stopHookEvidence: CLAUDE_STOP_HOOK_EVIDENCE,
      realChannelEvidence: CLAUDE_UNVERIFIED_EVIDENCE,
      probedAt: new Date().toISOString(),
    }
  }

  /**
   * 可用性探测。
   *
   * 语义是「适配器到底能不能用」：CLI 不在 / 版本过低 / 参数面不足 / MCP 配置形状
   * 不合法 / 桥自检失败都**抛** `ADAPTER_PROBE_INVALID`，不伪造成功结果。
   * 带总超时与缓存。
   */
  async function probe() {
    const cached = readProbeCache()
    if (cached) return { ...cached }
    if (probePromise) return probePromise
    let abandoned = false
    let timerId = null
    const running = probeOnce()
    running.catch(() => {})
    probePromise = (async () => {
      const timeout = new Promise((_, rejectProbe) => {
        timerId = setTimeout(() => {
          abandoned = true
          rejectProbe(probeInvalid(
            'probe-timeout',
            `claude probe 超过 ${settings.probeTimeoutMs}ms 未完成：按不可用处理，不派发节点`,
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

  /** 清掉 probe 缓存（显式 invalidate）。 */
  function invalidateProbe() {
    probeCache = null
  }

  /**
   * 能力表：`finishTool` 只在**最近一次成功 probe** 之后才宣称 `native`。
   *
   * hooks 默认 `emulated`（`--resume` 续跑）；native 只有调用方显式
   * `stopHook:'native'` 才声明，且 evidence 明确标注「未经真实 CLI 验收」。
   */
  function capabilities() {
    const probeValue = readProbeCache()
    const flags = probeFlagsOf(probeValue)
    // m4：参数面按**实际探测结果**判定；缺任何一个必需参数（verbose / strict MCP /
    // permission-mode / allowedTools …）都不再宣称 native 与严格隔离。
    const missingFlags = missingRequiredFlags(flags, requiredFlagEntries(settings.stopHook))
    const cliOk = Boolean(probeValue
      && probeValue.printMode === true
      && probeValue.outputFormat === true
      && probeValue.mcpConfig === true
      && missingFlags.length === 0)
    const bridgeOk = Boolean(probeValue && !(probeValue.bridge && probeValue.bridge.ok === false))
    const finishTool = cliOk && bridgeOk ? 'native' : 'unsupported'
    const hookLevel = resolveHookLevel(probeValue)
    return {
      finishTool,
      hooks: { 'turn.stop': hookLevel },
      // Claude Code CLI 非交互通道没有稳定的「轮次中投递」：明确 unsupported，
      // 宿主把消息记成 failed + deliveryUnknown，不假装成功。
      messages: 'unsupported',
      // 每条 assistant 事件的 usage 都是可观测的 provider usage（四桶互斥，含缓存桶）。
      usage: 'native',
      evidence: {
        finishTool: CLAUDE_FINISH_TOOL_EVIDENCE,
        'turn.stop': hooksContinueEvidence(probeValue, hookLevel),
        messages: ['claude -p 没有可去重的轮次中投递通道：capabilities().messages=unsupported'],
        parameters: parametersEvidence(flags, missingFlags),
        // A1：提问工具在非交互运行里没有人能回答。只有 probe 确认 CLI 认识
        // --disallowedTools 才真的禁用；否则如实标「未禁用」，不假装支持。
        nonInteractive: flags.disallowedTools === true
          ? '--disallowedTools AskUserQuestion：probe 已从 claude --help 确认该参数，'
            + '非交互运行不会等待提问工具的回答'
          : 'probe 未确认 --disallowedTools：CLI 不支持时**不传**该参数，'
            + '提问工具在非交互运行中未被禁用（不谎称已禁用）',
        usage: ['assistant 事件 message.usage（input / cache_creation / cache_read / output 互斥）→'
          + ' claude-usage-ledger 按稳定 message.id 去重（一处调用一条记录）',
        'result.usage 是**范围级结算快照**（agent/usage-snapshot，scope=invocation / '
          + 'session-cumulative / unknown）；不当作新增调用，也不把累计值相加'],
        permissionMode: `--permission-mode ${settings.permissionMode}`
          + '（Claude Code 没有 codex -s 的 OS 沙箱；默认不 bypassPermissions）',
        userConfig: CLAUDE_USER_CONFIG_EVIDENCE,
        evidenceLayers: ['① 参数探测：claude --version / --help',
          '② 桥自检：verifyFinishBridge（我们自己的 MCP stdio server 往返）',
          '③ 真实 CLI 握手 + finish：本机未验证，见 scripts/claude-smoke.mjs'],
        realChannel: CLAUDE_UNVERIFIED_EVIDENCE,
      },
    }
  }

  /** m4：把「参数探测」这一层的结论如实写出来（缺参数时降级，不假装严格隔离）。 */
  function parametersEvidence(flags, missingFlags) {
    const entries = requiredFlagEntries(settings.stopHook)
    const missing = Array.isArray(missingFlags) ? missingFlags : missingRequiredFlags(flags, entries)
    if (missing.length > 0) {
      const labels = missing.map(key => {
        const entry = entries.find(item => item.key === key)
        return entry ? entry.argv : key
      })
      return `参数探测：claude --help 未确认 ${labels.join(' / ')}；`
        + '适配器不声称严格隔离 / 预授权，start 零派发'
    }
    const confirmed = entries.map(entry =>
      (entry.key === 'allowedTools' ? resolveAllowedToolsFlag(flags) : entry.argv))
    return `参数探测：probe 从 claude --help 确认 ${confirmed.join(' / ')}；`
      + 'argv 与要求表同源，没有静默省略'
  }

  /**
   * 提醒机制档位：
   *   - 显式 `native` → native（文档契约，未经真实 CLI 验收）；
   *   - 显式 `emulated` → emulated；
   *   - 默认 `auto` → emulated；probe 确认 `--resume` 不可用时如实标 unsupported。
   */
  function resolveHookLevel(probeValue) {
    if (settings.stopHook === 'native') return 'native'
    if (settings.stopHook === 'emulated') return 'emulated'
    if (!probeValue) return 'emulated'
    return probeValue.resume === true ? 'emulated' : 'unsupported'
  }

  function hooksContinueEvidence(probeValue, level) {
    if (level === 'native') {
      return (probeValue && probeValue.stopHookEvidence) || CLAUDE_STOP_HOOK_EVIDENCE
    }
    if (level === 'emulated') {
      const resume = probeValue ? String(probeValue.resume === true) : 'unprobed'
      return `claude -p --resume <session-id> 进程级续跑（emulated；probe().resume=${resume}）`
    }
    return 'CLI 既不能确认 Stop hook，也不支持 --resume：没有提醒机制'
      + '（按 unsupported 如实声明，不假装能提醒）'
  }

  /**
   * 启动一次 Claude 活动（0.14.5 M3 / M4 / M5 / M6 / m1 / m4 / m5）。
   *
   * 结构：
   *   1. 入口校验（预 abort、gate 形状、工作区）——零资源，不建目录；
   *   2. probe + **唯一参数要求表**（m4/m5）：不可用统一抛 TOOL_UNAVAILABLE；
   *   3. 从创建 runDir 起登记资源（`createResourceRegistry`），参数构造 / spawn
   *      （含同步异常）/ 握手全部在 protect 范围内（M4）；
   *   4. 启动成功后返回 handle，退出结算交给 `runSettlement`（等排空，M3/M6）。
   *
   * 任何启动失败都走 `cleanupAfterStartFailure`：abort gate、杀掉已登记的进程组
   * （TERM → KILL 整组确认）、关闭 channel、删除 runDir，并把 `cleanup` /
   * `cleanupFinal` 挂到错误对象上。
   */
  async function start(request) {
    try {
      return await startAttempt(request)
    } catch (error) {
      throw asStartFailure(error)
    }
  }

  /**
   * m5：`start()` 的可用性错误统一成 `NODE_FINISH_TOOL_UNAVAILABLE`（原 code 放
   * `details.cause`）；参数非法（ADAPTER_INVALID）、预取消（NODE_FINISH_CANCELED）
   * 保持原分类。probe 自己保留 `ADAPTER_PROBE_INVALID`。
   */
  function asStartFailure(error) {
    if (!(error instanceof ClaudeAdapterError)) return error
    if (error.code === ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE) return error
    if (error.code === 'NODE_FINISH_CANCELED') return error
    if (error.code !== ADAPTER_ERROR.PROBE_INVALID) return error
    const reason = error.details && typeof error.details.reason === 'string'
      ? error.details.reason
      : 'probe-failed'
    const wrapped = new ClaudeAdapterError(
      ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
      `Claude 适配器不可用（probe: ${reason}）：${error.message}`,
      {
        adapterId: CLAUDE_ADAPTER_ID,
        field: 'probe',
        reason,
        cause: error.code,
        causeReason: reason,
        ...(error.details && Array.isArray(error.details.missing)
          ? { missing: [...error.details.missing] }
          : {}),
      },
    )
    if (error.cleanup) wrapped.cleanup = error.cleanup
    if (error.cleanupFinal) wrapped.cleanupFinal = error.cleanupFinal
    // M2 残余：包装成 TOOL_UNAVAILABLE 时也要带上失败载体上的用量视图。
    if (Array.isArray(error.usageCalls)) wrapped.usageCalls = error.usageCalls
    if (Array.isArray(error.usageSnapshots)) wrapped.usageSnapshots = error.usageSnapshots
    return wrapped
  }

  async function startAttempt(request) {
    const { element, ctx, finishGate, reminder } = request || {}
    const workspaceRoot = typeof request?.workspaceRoot === 'string' && request.workspaceRoot !== ''
      ? request.workspaceRoot
      : (isPlainObject(request?.workspace) && typeof request.workspace.effectiveRoot === 'string'
        ? request.workspace.effectiveRoot
        : '')
    const runnerCtx = isPlainObject(ctx) ? ctx : {}

    // 预 abort 不派发（在 probe / 建目录之前）。
    if (runnerCtx.signal && runnerCtx.signal.aborted === true) {
      throw new ClaudeAdapterError(
        'NODE_FINISH_CANCELED',
        'Claude 适配器在启动前已被取消（ctx.signal 已 abort），节点零派发',
        { adapterId: CLAUDE_ADAPTER_ID, reason: 'pre-aborted', nodeId: element && element.id },
      )
    }

    // 先校验闸门的三个方法 + result Promise，再建 channel / runDir。
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
      throw new ClaudeAdapterError(
        ADAPTER_ERROR.INVALID,
        'Claude 适配器 start 需要 node-finish 的 finishGate（submit / settled / abort 方法 + result Promise）',
        {
          adapterId: CLAUDE_ADAPTER_ID,
          field: 'finishGate',
          reason: 'missing-gate',
          missing: missingGate,
        },
      )
    }
    if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
      throw new ClaudeAdapterError(
        ADAPTER_ERROR.INVALID,
        'Claude 适配器 start 需要 workspaceRoot',
        { adapterId: CLAUDE_ADAPTER_ID, field: 'workspaceRoot', reason: 'missing' },
      )
    }
    const workspace = resolve(workspaceRoot)
    if (!existsSync(workspace)) {
      throw new ClaudeAdapterError(
        ADAPTER_ERROR.INVALID,
        `Claude 适配器的工作区不存在：${workspace}`,
        { adapterId: CLAUDE_ADAPTER_ID, field: 'workspaceRoot', reason: 'not-found' },
      )
    }

    // probe 之后才决定能不能启动：probe 自己抛 PROBE_INVALID，start 包装成 TOOL_UNAVAILABLE。
    const probeValue = await probe()
    const probeFlags = probeFlagsOf(probeValue)
    const requiredFlags = requiredFlagEntries(settings.stopHook)
    const missingFlags = missingRequiredFlags(probeFlags, requiredFlags)
    if (missingFlags.length > 0) {
      // m4：缺必需参数时就**不派发**——不静默省略 --verbose / --strict-mcp-config /
      // --permission-mode / --allowedTools，也不声称严格隔离。
      throw new ClaudeAdapterError(
        ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
        `claude --help 没有确认本适配器必需的参数（${missingFlags.join(' / ')}）：`
          + '不静默省略，拒绝启动（零派发）',
        {
          adapterId: CLAUDE_ADAPTER_ID,
          field: 'probe',
          reason: 'cli-flags-missing',
          cause: ADAPTER_ERROR.PROBE_INVALID,
          missing: missingFlags,
        },
      )
    }
    const caps = capabilities()
    if (caps.finishTool !== 'native') {
      throw new ClaudeAdapterError(
        ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
        'Claude 适配器当前不能提供原生 flow_finish_node（probe 未通过）：按 11 §1.6 拒绝启动',
        {
          adapterId: CLAUDE_ADAPTER_ID,
          reason: probeValue ? 'finish-tool-not-native' : 'probe-failed',
          cause: ADAPTER_ERROR.PROBE_INVALID,
          nodeId: element && element.id,
        },
      )
    }
    const hookLevel = caps.hooks['turn.stop']
    const useHook = hookLevel === 'native'
    if (useHook && probeValue.settingsFlag !== true) {
      // 显式要 native hook 却连 --settings 都没有：不静默降级成 emulated（那会变成
      // 「声称 native 却没有 hook」），直接拒绝这次启动。
      throw new ClaudeAdapterError(
        ADAPTER_ERROR.INVALID,
        'Claude 适配器被要求使用原生 Stop hook（stopHook:"native"），'
          + '但 probe 没有在 claude --help 里确认 --settings：拒绝启动，避免静默降级',
        { adapterId: CLAUDE_ADAPTER_ID, field: 'stopHook', reason: 'settings-flag-missing' },
      )
    }
    const flags = probeFlags
    const resumeSupported = probeValue.resume === true

    /**
     * 与 `agent-execute` 对齐的调用身份（usageSnapshots / usageCalls 用）。
     *
     * executor 的 `invocationId` 是 `${executionId}:invoke-1`（提醒续跑是
     * `${executionId}:invoke-r<count>`）；`executionId` 优先取 `ctx.executionId`，
     * 缺失时按 `instance:<nodeId>:<attempt>` 兜底。适配器用同一个 id，指标层才能把
     * 调用 / 结算快照与 `agent/invocation` 事件归到同一范围（否则覆盖率被误判 unknown）。
     */
    const attempt = Number.isSafeInteger(runnerCtx.attempt) && runnerCtx.attempt >= 1
      ? runnerCtx.attempt
      : 1
    const nodeId = nonEmptyTrimmedString(element && element.id) || '(agent)'
    const executionId = nonEmptyTrimmedString(runnerCtx.executionId)
      || `${nonEmptyTrimmedString(runnerCtx.instanceId) || 'instance'}:${nodeId}:${attempt}`

    // ---- 资源所有权从 runDir 开始（M4）：失败一律 cleanup ----
    ensurePrivateDir(settings.tmpRoot)
    const resources = createResourceRegistry()
    const supervisor = createProcessGroupSupervisor({
      // 完成宽限由下面的 graceTimer 实现：取消必须立刻 TERM，不能被完成宽限拖住。
      // graceMs=0 仍然执行完整的 TERM → KILL 升级（M5）。
      graceMs: 0,
      killTimeoutMs: settings.killTimeoutMs,
      ...(settings.killImpl ? { killImpl: settings.killImpl } : {}),
    })

    let runDir = ''
    let channel = null
    let state = null
    let handle = null
    let ledger = null
    // M2 残余：用量视图导出函数（定义在 protect 内，失败 catch 也要能调用）。
    let exportUsageCalls = null
    let exportUsageSnapshots = null
    let signalListener = null
    let handleRef = null
    let pendingAbort = false
    let startFailureCleanup = null
    let exitedResolve = null
    let exitedDone = false
    let graceTimer = null
    let disposeDone = false
    let cancelPromise = null
    let cancelSignalResolve = null
    let spawnFailureResolve = null
    let earlyExitResolve = null

    const spawnedProcesses = []
    /** callId → invocationId（适配器侧按进程登记，用于与快照 / agent/invocation 对齐）。 */
    const callInvocationIds = new Map()
    const cancelSignal = new Promise(resolveCancel => { cancelSignalResolve = resolveCancel })
    const spawnFailure = new Promise(resolveSpawn => { spawnFailureResolve = resolveSpawn })
    const earlyExit = new Promise(resolveExit => { earlyExitResolve = resolveExit })
    const exited = new Promise(resolveExitedPromise => { exitedResolve = resolveExitedPromise })

    const sleepUnref = ms => new Promise(resolveSleep => {
      const timer = setTimeout(resolveSleep, ms)
      timer.unref?.()
    })

    const finalCleanupWatchMs = Math.min(60_000, Math.max(5_000, settings.killTimeoutMs * 2 + 2_000))
    let finalCleanupSettled = false
    let resolveFinalCleanup = null
    const cleanupFinal = new Promise(resolveFinal => { resolveFinalCleanup = resolveFinal })
    const settleFinalCleanup = value => {
      if (finalCleanupSettled) return
      finalCleanupSettled = true
      resolveFinalCleanup(value)
    }

    /**
     * 进程组清理快照：`handle.cleanup` 的语义与 0.14.2 一致——**只回答进程组**是否
     * 确认消失（channel / runDir / listener 归句柄生命周期，dispose 时才释放）。
     * 完整释放口径见 `releaseSnapshot()`（`cleanupFinal` 用）。
     */
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
        reason: `仍有 ${pendingGroups.length} 个 claude 进程组未确认退出`,
      }
    }

    /** 完整释放快照：进程组 + 资源登记表都清空才算 disposed（cleanupFinal / 启动失败）。 */
    const releaseSnapshot = () => {
      const groups = cleanupSnapshot()
      const resourceSnapshot = resources.snapshot()
      const pendingResources = resourceSnapshot.pending
      if (groups.disposed === true && pendingResources.length === 0) return { disposed: true }
      return {
        ...groups,
        disposed: false,
        pendingResources: pendingResources.map(entry => entry.kind),
        reason: `${groups.disposed === true ? '进程组已消失' : groups.reason}`
          + `；${pendingResources.length} 项资源未释放`,
      }
    }

    const watchFinalCleanup = () => {
      ;(async () => {
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
          await sleepUnref(Math.min(remaining, 100))
        }
      })().catch(error => {
        settleFinalCleanup({
          disposed: false,
          reason: `最终清理盯守失败：${error && error.message ? error.message : error}`,
        })
      })
    }

    /** 启动失败时的闸门收口（不依赖 try 块里后定义的闭包，避免 TDZ）。 */
    const abortGateForFailure = reason => {
      try {
        if (typeof finishGate.abort !== 'function' || finishGate.settled()) return false
        return finishGate.abort(reason) !== false
      } catch {
        return false
      }
    }

    /**
     * 启动失败清理（M4）：从 runDir 创建那一刻起就可用——abort gate、整组确认退出、
     * 关 channel、删 runDir，并把结果挂到错误对象的 `cleanup` / `cleanupFinal` 上。
     */
    const cleanupAfterStartFailure = async () => {
      if (state) state.startFailed = true
      abortGateForFailure('start-failed')
      await terminateAllGroups('start-failed')
      await supervisor.disposeAll().catch(() => {})
      for (const proc of spawnedProcesses) {
        try {
          proc.streams.dispose()
        } catch {
          // ignore
        }
      }
      await resources.disposeAll()
      const snapshot = releaseSnapshot()
      watchFinalCleanup()
      return snapshot
    }

    /** 收掉全部被跟踪进程组：宽限（外部控制）→ TERM → KILL → 整组确认。 */
    const terminateAllGroups = async reason => {
      const results = []
      for (const proc of spawnedProcesses) {
        if (!proc.group) continue
        try {
          results.push(await supervisor.terminateGroup(proc.group, reason))
        } catch {
          results.push({ gone: false })
        }
      }
      return results
    }

    try {
      runDir = ensurePrivateDir(await fsp.mkdtemp(join(settings.tmpRoot, 'fs-claude-')))
      resources.add('run-dir', () => fsp.rm(runDir, { recursive: true, force: true }))
      // 从这里开始任何失败都走统一清理（含参数构造 / 同步 spawn / 握手）。
      startFailureCleanup = cleanupAfterStartFailure

      const mcpConfigPath = join(runDir, MCP_CONFIG_NAME)

      // 提醒回调只通知一次，异常不影响流程。
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

      state = {
        canceled: false,
        cancelReason: null,
        channelFailed: false,
        gateSettled: false,
        reminders: 0,
        sessionId: undefined,
        sessionIdHint: undefined,
        record: undefined,
        lastMessage: undefined,
        usage: undefined,
        resultSubtype: undefined,
        resultIsError: false,
        numTurns: undefined,
        totalCostUsd: undefined,
        mcpServers: undefined,
        mcpServerErrors: undefined,
        assistantError: undefined,
        exitCode: undefined,
        signal: undefined,
        spawnError: null,
        spawnArgv: null,
        events: [],
        // 0.14.5 M3 / M6 诊断（小、有界；与用量账本分开）
        protocolErrors: 0,
        droppedLines: 0,
        streamDiagnostics: [],
        outputDrained: true,
        outputIncomplete: false,
        handshakeRequired: settings.helloTimeoutMs > 0,
        handshakeOk: settings.helloTimeoutMs > 0 ? false : null,
        startFailed: false,
        terminalError: null,
        invocation: {
          kind: null,
          invocationId: null,
          resumed: false,
          exitCode: undefined,
          signal: undefined,
          // A2：**显式**记录本次 invocation 是否收到过 result 事件。分类不能拿
          // 「没有字符串 subtype」近似「没有 result」——CLI 会发 `{type:"result",
          // is_error:false}` 而不带 subtype。
          resultSeen: false,
          resultSubtype: undefined,
          resultIsError: false,
        },
      }

      channel = await createFinishChannel({
        gate: finishGate,
        dir: runDir,
        maxReminders: settings.reminderLimit,
        onReminder: info => {
          state.reminders = Math.max(state.reminders, info.count)
          emitReminder(info)
        },
        onReject: () => {
          state.channelFailed = true
        },
      })
      resources.add('finish-channel', () => channel.close())

      // MCP 配置：凭据只在这个 0600 文件与 claude 子进程 env 里出现，不进 argv / 提示词。
      const mcpConfig = buildMcpConfig({ serverPath: SERVER_PATH, env: channel.env })
      writeFileSync(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, { mode: 0o600 })
      if (process.platform !== 'win32') chmodSync(mcpConfigPath, 0o600)
      let hookScriptPath = null
      let settingsPath = null
      if (useHook) {
        hookScriptPath = join(runDir, HOOK_SCRIPT_NAME)
        writeFileSync(hookScriptPath, HOOK_SCRIPT_SOURCE, { mode: 0o600 })
        if (process.platform !== 'win32') chmodSync(hookScriptPath, 0o600)
        settingsPath = join(runDir, SETTINGS_NAME)
        writeFileSync(settingsPath, `${JSON.stringify(buildStopHookSettings({ hookScriptPath }), null, 2)}\n`, {
          mode: 0o600,
        })
        if (process.platform !== 'win32') chmodSync(settingsPath, 0o600)
      }

      /**
       * 导出前脱敏：本 execution 的凭据、socket 路径与 runDir 都替换成占位符。
       * 深度超过 8 层的子树一律替换成占位符——**绝不返回原对象**。
       */
      const redactText = text => {
        // 0.15.1：先走共享文本规则（JSON 转义 / 引号 / 键值 / 超长串），再做本 execution
        // 的精确秘密替换。handle.events / lastMessage 也走这里，和终态结果面同一套规则。
        // ≤1 MiB 的文本关掉「≥64 KiB 连续串预抹」：那是为超大输入避开 V8 爆栈的兜底，
        // 但会把 600 KiB 的合法 x…x 长串整段替换；规则 5 仍按跨类字符判敏感。
        const value = typeof text === 'string' ? text : String(text)
        let output = redactSharedText(value, { capOversize: value.length > 1024 * 1024 })
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
      const boundText = (value, limit = MAX_ERROR_TEXT) =>
        redactText(value === undefined || value === null ? '' : String(value)).slice(0, limit)
      /**
       * F2：终态错误（code / subtype / message）的唯一脱敏出口。
       *
       * 顺序：共享脱敏（Bearer / Basic / sk- / token=… / 长串）→ 本 execution 的精确
       * 秘密替换（通道凭据 / socket / runDir）→ UTF-8 字节截断并标记。既有 `redactText`
       * 只做第三步之前的一半工作，不能单独用于 provider 错误文本。
       */
      const boundTerminalText = (value, limit = MAX_TERMINAL_ERROR_BYTES) => {
        let text = redactSharedText(value === undefined || value === null ? '' : String(value))
        for (const secret of [channel.credential, channel.socketPath, runDir]) {
          if (typeof secret === 'string' && secret !== '') text = text.split(secret).join('[redacted]')
        }
        return truncateUtf8Bytes(text, limit)
      }
      /**
       * 展示 tail：先合并各进程的（已按上限+余量保留的）原始窗口 → **整段脱敏** →
       * 再按字节取尾。顺序不能反（0.15.1）：先 `slice(-limit)` 会把键名切掉，值就裸奔。
       */
      const streamsTail = (picker, limit) => truncateTailUtf8Bytes(
        redactText(spawnedProcesses.map(proc => (proc.streams ? picker(proc.streams) : '')).join('')),
        limit,
      )

      /** 小、有界的流诊断（与计量账本分开；计量绝不按诊断上限裁剪）。 */
      const recordStreamDiagnostic = (diagnostic, source) => {
        const entry = {
          kind: typeof diagnostic?.kind === 'string' ? diagnostic.kind.slice(0, 64) : 'stream',
          ...(source ? { source: String(source).slice(0, 32) } : {}),
          ...(Number.isSafeInteger(diagnostic?.lineNo) ? { lineNo: diagnostic.lineNo } : {}),
          ...(Number.isSafeInteger(diagnostic?.bytes) ? { bytes: diagnostic.bytes } : {}),
          ...(typeof diagnostic?.message === 'string'
            ? { message: redactText(diagnostic.message).slice(0, 160) }
            : {}),
        }
        if (entry.kind === 'line-too-long') state.droppedLines += 1
        if (entry.kind === 'drain-timeout' || entry.kind === 'stdout-closed-early') {
          state.outputIncomplete = true
        }
        if (state.streamDiagnostics.length >= MAX_STREAM_DIAGNOSTICS) return
        state.streamDiagnostics.push(entry)
      }

      ledger = createClaudeUsageLedger({ provider: CLAUDE_ADAPTER_ID })

      /**
       * M2 残余（跨单元约定）：适配器观测到的用量视图。
       *
       * 同一个导出同时供 `handle.usageCalls()` / `handle.usageSnapshots()` 与**启动失败
       * 载体**使用：`start()` 在返回 handle 之前失败时，executor 只能从错误对象上拿到
       * 已观测用量（`error.usageCalls` / `error.usageSnapshots`），不能因为没拿到句柄就丢账。
       */
      exportUsageCalls = () => ledger.usageCalls().map(call => ({
        provider: CLAUDE_ADAPTER_ID,
        ...call,
        ...(call.invocationId
          ? {}
          : (callInvocationIds.has(call.callId)
            ? { invocationId: callInvocationIds.get(call.callId) }
            : {})),
        usage: call.usage === null ? null : { ...call.usage },
        observedBuckets: [...call.observedBuckets],
      }))
      exportUsageSnapshots = () => ledger.snapshots().map(snapshot => ({
        provider: CLAUDE_ADAPTER_ID,
        ...snapshot,
        usage: snapshot.usage === null ? null : { ...snapshot.usage },
        observedBuckets: [...snapshot.observedBuckets],
        provenance: { ...snapshot.provenance },
      }))

      /** 从 current invocation 的 result 事件抽取**脱敏、有界**的终态错误（M6）。 */
      const recordTerminalError = event => {
        const firstError = Array.isArray(event.errors) && typeof event.errors[0] === 'string'
          ? event.errors[0]
          : null
        const code = boundTerminalText(
          firstError
            || state.assistantError
            || 'cli-result-error',
          200,
        )
        const rawMessage = typeof event.result === 'string' && event.result.trim() !== ''
          ? event.result
          : (Array.isArray(event.errors) ? event.errors.join('; ') : '')
        // F2：`subtype` 以前直接 `slice(0, 64)`，既不脱敏也不按字节限制——凭据可以
        // 藏在 subtype 里绕过本执行 token 替换。三处出口统一走 boundTerminalText。
        state.terminalError = {
          code,
          subtype: typeof event.subtype === 'string' ? boundTerminalText(event.subtype, 200) : undefined,
          message: boundTerminalText(rawMessage),
        }
        state.invocation.resultIsError = true
      }

      /** 从 assistant 消息里取文本（content 是 block 数组或字符串）。 */
      const assistantText = message => {
        if (!isPlainObject(message)) return ''
        if (typeof message === 'string') return message
        const content = message.content
        if (typeof content === 'string') return content
        if (!Array.isArray(content)) return ''
        return content
          .filter(block => isPlainObject(block) && block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text)
          .join('\n')
      }

      /** 一条已完成的协议行（EOF flush / 换行都由 reader 交付）。 */
      const handleProtocolLine = line => {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          state.protocolErrors += 1
          recordStreamDiagnostic({ kind: 'invalid-json', bytes: Buffer.byteLength(line, 'utf8') }, 'protocol')
          return
        }
        if (!isPlainObject(event)) {
          state.protocolErrors += 1
          recordStreamDiagnostic({ kind: 'non-object-json' }, 'protocol')
          return
        }
        if (state.events.length < MAX_PROTOCOL_EVENTS) state.events.push(event)
        if (typeof event.session_id === 'string' && event.session_id !== '') {
          state.sessionId = event.session_id
        }
        if (event.type === 'system' && event.subtype === 'init') {
          if (Array.isArray(event.mcp_servers)) {
            state.mcpServers = event.mcp_servers
              .filter(entry => isPlainObject(entry) && typeof entry.name === 'string')
              .map(entry => ({ name: entry.name, status: typeof entry.status === 'string' ? entry.status : undefined }))
              .slice(0, 32)
          }
          if (Array.isArray(event.mcp_server_errors)) {
            state.mcpServerErrors = event.mcp_server_errors
              .filter(entry => isPlainObject(entry) && typeof entry.name === 'string')
              .map(entry => ({
                name: entry.name,
                message: typeof entry.message === 'string' ? entry.message.slice(0, 200) : undefined,
              }))
              .slice(0, 32)
          }
        } else if (event.type === 'assistant') {
          // M1：调用身份 / 去重由账本负责（同一 message.id 是同一个模型响应）。
          const recorded = ledger.recordAssistant(event)
          if (recorded && typeof recorded.callId === 'string' && state.invocation.invocationId) {
            if (!callInvocationIds.has(recorded.callId)) {
              callInvocationIds.set(recorded.callId, state.invocation.invocationId)
            }
          }
          if (isPlainObject(event.message)) {
            if (isPlainObject(event.message.usage)) {
              const usage = { ...event.message.usage }
              if (typeof usage.cache_write_input_tokens !== 'number'
                && typeof usage.cache_creation_input_tokens === 'number') {
                usage.cache_write_input_tokens = usage.cache_creation_input_tokens
              }
              state.usage = usage
            }
            const textValue = assistantText(event.message)
            if (textValue !== '') state.lastMessage = textValue.slice(0, 2_000)
          }
          if (typeof event.error === 'string' && event.error !== '') {
            state.assistantError = boundText(event.error, 160)
          }
        } else if (event.type === 'result') {
          // A2：result 的存在性是**独立事实**，与 subtype 是否字符串无关。
          state.invocation.resultSeen = true
          state.resultSubtype = typeof event.subtype === 'string' ? event.subtype : undefined
          state.resultIsError = event.is_error === true
          state.invocation.resultSubtype = state.resultSubtype
          state.invocation.resultIsError = state.resultIsError
          if (Number.isSafeInteger(event.num_turns)) state.numTurns = event.num_turns
          if (typeof event.total_cost_usd === 'number') state.totalCostUsd = event.total_cost_usd
          if (typeof event.result === 'string' && event.result.trim() !== '') {
            state.lastMessage = event.result.slice(0, 2_000)
          }
          // M2：result 是**范围级结算快照**，不增加模型调用数；resumed 必须如实传
          // （传错会让会话累计值被当成 invocation 相加）。
          ledger.recordResult(event, {
            ...(state.invocation.invocationId ? { invocationId: state.invocation.invocationId } : {}),
            resumed: state.invocation.resumed === true,
          })
          if (state.resultIsError === true
            || (typeof event.subtype === 'string' && event.subtype !== 'success')) {
            recordTerminalError(event)
          }
        }
      }

      /**
       * spawn 一个 claude 进程（初始 / 每次 resume）并登记：
       *   - 独立 `createUtf8LineReader` + `attachProcessStreams`（M3）；
       *   - 进程组 supervisor（M5 / m1）；
       *   - 资源登记表里的 stream dispose。
       * 同步 spawn 异常：命令行过长（E2BIG / Windows 206）→ `CLAUDE_ARGV_TOO_LARGE`；
       * 其它启动失败仍转成 TOOL_UNAVAILABLE。两者都由外层 protect 清理（M4）。
       */
      const spawnClaude = (args, kind, invocationId) => {
        state.spawnArgv = args
        // A2：assistant 错误属于**本次 invocation**，不能跨 resume 复用——否则一次
        // 瞬时错误 + 后续干净退出会被误判成 provider 错误，把 MISSING 分支吞掉。
        state.assistantError = undefined
        const proc = {
          kind,
          invocationId,
          resumed: kind === 'resume',
          child: null,
          group: null,
          streams: null,
          exit: null,
        }
        state.invocation = {
          kind,
          invocationId,
          resumed: proc.resumed,
          exitCode: undefined,
          signal: undefined,
          // A2：按 invocation 重置（不能跨 resume 复用）。
          resultSeen: false,
          resultSubtype: undefined,
          resultIsError: false,
        }
        const reader = createUtf8LineReader({
          maxLineBytes: CLAUDE_MAX_LINE_BYTES,
          onLine: line => handleProtocolLine(line),
          onDiagnostic: diagnostic => recordStreamDiagnostic(diagnostic, kind),
        })
        let child
        try {
          child = spawn(settings.claudeBin, args, {
            cwd: workspace,
            env: buildChildEnv([settings.env, channel.env]),
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (error) {
          // A3：命令行过长是输入规模问题，给独立错误码 + 可操作 hint；普通 spawn
          // 失败（ENOENT / EACCES …）保持原有 TOOL_UNAVAILABLE，不混为一谈。
          if (isArgvTooLargeError(error)) throw argvTooLargeError({ error, args })
          throw new ClaudeAdapterError(
            ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
            `Claude 进程无法启动（${error && error.code ? error.code : 'SPAWN_FAILED'}）：`
              + '参数或环境不可用，节点零派发',
            {
              adapterId: CLAUDE_ADAPTER_ID,
              field: 'spawn',
              reason: 'spawn-failed',
              cause: error && error.code ? String(error.code) : 'SPAWN_FAILED',
            },
          )
        }
        proc.child = child
        proc.streams = attachProcessStreams(child, {
          stdoutReader: reader,
          stdoutTailBytes: CLAUDE_STDOUT_TAIL_BYTES,
          stderrTailBytes: CLAUDE_STDERR_TAIL_BYTES,
          drainTimeoutMs: CLAUDE_DRAIN_TIMEOUT_MS,
        })
        resources.add(`process-${kind}`, () => proc.streams.dispose())
        if (Number.isSafeInteger(child.pid) && child.pid > 0) {
          proc.group = supervisor.track(child, { label: `${kind}:${child.pid}` })
        }
        proc.exit = new Promise(resolveExit => {
          let settled = false
          const settleExit = (code, signal, error) => {
            if (settled) return
            settled = true
            state.exitCode = code
            state.signal = signal
            state.invocation.exitCode = code
            state.invocation.signal = signal
            resolveExit({ code, signal, error })
          }
          child.once('exit', (code, signal) => settleExit(code, signal, null))
          child.once('error', error => {
            state.spawnError = error
            if (!Number.isSafeInteger(child.pid)) settleExit(null, null, error)
          })
        })
        child.once('error', error => {
          state.spawnError = error
          spawnFailureResolve?.({
            code: error && error.code ? String(error.code) : 'SPAWN_FAILED',
          })
        })
        child.once('exit', (code, signal) => {
          if (!channel.contacted && !state.canceled) earlyExitResolve?.({ code, signal })
        })
        spawnedProcesses.push(proc)
        return proc
      }

      /**
       * 等一个进程结束并**排空 stdout**（M3）。排空是有界的：超时/提前关闭记诊断并标
       * `outputIncomplete`。排空之后再收掉整组——后代可能继承 stdout，必须先让协议
       * 数据读完再清理。
       */
      const awaitProcessEnd = async proc => {
        const info = await proc.exit
        if (info.error) state.spawnError = info.error
        let drain = { drained: false, timedOut: false }
        try {
          drain = await proc.streams.drained
        } catch {
          drain = { drained: false, timedOut: false }
        }
        if (drain.timedOut === true) {
          state.outputIncomplete = true
          recordStreamDiagnostic({ kind: 'drain-timeout', process: proc.kind }, 'stream')
        } else if (drain.drained !== true && !state.canceled && !disposeDone) {
          state.outputIncomplete = true
          recordStreamDiagnostic({ kind: 'stdout-not-drained', process: proc.kind }, 'stream')
        }
        state.outputDrained = state.outputDrained && drain.drained === true
        if (proc.group) {
          try {
            await supervisor.terminateGroup(proc.group, 'process-exit')
          } catch {
            // 清理失败由 cleanup / cleanupFinal 如实报告，不改业务结局。
          }
        }
        return { ...info, drained: drain.drained === true, outputTimedOut: drain.timedOut === true }
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

      /** 终态错误：握手之后 CLI 自己给出的错误（result is_error / 非 success / 非零退出码）。 */
      const terminalErrorFor = invocation => {
        if (!invocation) return null
        let terminal = null
        if (invocation.resultIsError === true) {
          terminal = state.terminalError || {
            code: 'cli-result-error',
            subtype: invocation.resultSubtype,
            message: '',
          }
        } else if (typeof invocation.resultSubtype === 'string' && invocation.resultSubtype !== 'success') {
          terminal = {
            code: (state.terminalError && state.terminalError.code) || 'cli-result-error',
            subtype: invocation.resultSubtype,
            message: (state.terminalError && state.terminalError.message) || '',
          }
        } else if (invocation.exitCode === 0
          && invocation.resultIsError !== true
          && invocation.resultSeen !== true
          && typeof state.assistantError === 'string' && state.assistantError !== '') {
          // A2：只有 assistant 消息带 error（如 authentication_failed）、**本次 invocation
          // 没有收到任何 result 事件**、退出码 0。这是 provider 侧的执行错误，不是「agent
          // 正常停下但没调工具」：不能落 MISSING、也不能提醒一个认证已经失败的 CLI。
          // 判断必须用显式 `resultSeen`：CLI 会发 `{type:"result",is_error:false}` 而没有
          // subtype，拿「没有字符串 subtype」近似「没有 result」会把这种情况误判成 provider
          // 错误（有 result 就不是 assistant-only 失败）。
          terminal = {
            code: 'cli-assistant-error',
            subtype: state.assistantError,
            message: `assistant 消息报告 ${state.assistantError}（没有 result 事件）`,
          }
        } else if (Number.isSafeInteger(invocation.exitCode) && invocation.exitCode !== 0) {
          terminal = {
            code: 'cli-exit-nonzero',
            subtype: invocation.resultSubtype,
            message: `claude 以退出码 ${invocation.exitCode} 结束`,
          }
        } else if (typeof invocation.signal === 'string' && invocation.signal !== '') {
          // M6 残余 a：被信号终止（SIGKILL / OOM / 外部 kill）不是「正常停下」，
          // 提醒 / resume 对已经死掉的 CLI 毫无意义。与认证失败同一分类：终态 provider 错误。
          terminal = {
            code: 'cli-signaled',
            subtype: invocation.resultSubtype,
            message: `claude 被信号 ${invocation.signal} 终止（不是正常停下）`,
          }
        }
        if (terminal === null) return null
        // F2：`resultSubtype` 来自 CLI 协议原文，可能夹带秘密；三个出口统一在这里有界脱敏。
        return {
          code: boundTerminalText(terminal.code, 200) || 'cli-result-error',
          ...(terminal.subtype === undefined
            ? {}
            : { subtype: boundTerminalText(terminal.subtype, 200) }),
          message: boundTerminalText(terminal.message || ''),
        }
      }

      const providerErrorMessage = terminal => {
        const label = `code=${terminal.code}${terminal.subtype ? `, subtype=${terminal.subtype}` : ''}`
        // F2：整条 message 也走**共享脱敏 + 字节上限**（不是只做本执行 token 替换）。
        return boundTerminalText(
          `Claude CLI 给出终态错误（${label}）${terminal.message ? `：${terminal.message}` : ''}；`
            + '节点没有完结——这是执行错误，不是「没调用 finish」，不消耗提醒预算',
        )
      }

      /**
       * m3：对外 / 续跑可用的 session id。
       *
       * - `state.sessionId`：CLI 自己在事件里报的 id，可信；
       * - `state.sessionIdHint`：本次显式拼进 `--session-id` 的 UUID，**只有** probe 支持
       *   该参数时才会传给 CLI；probe 不支持时这里必须返回 undefined，否则就是伪造。
       */
      const sessionIdForOutput = () => state.sessionId
        || (flags.sessionId === true && typeof state.sessionIdHint === 'string' && state.sessionIdHint !== ''
          ? state.sessionIdHint
          : undefined)

      const resolveExited = value => {
        if (exitedDone) return
        exitedDone = true
        if (graceTimer) {
          clearTimeout(graceTimer)
          graceTimer = null
        }
        if (signalListener && runnerCtx.signal
          && typeof runnerCtx.signal.removeEventListener === 'function') {
          try {
            runnerCtx.signal.removeEventListener('abort', signalListener)
          } catch {
            // ignore
          }
        }
        exitedResolve({
          // init 事件可能晚于 exit 被解析：显式 --session-id 生成的值同样是稳定 key。
          // m3：只有**真的传给 CLI**（probe 支持 --session-id）或 CLI 自己报过的 id
          // 才能对外；否则按「未知」处理，不伪造一个从未被 CLI 用过的 UUID。
          sessionId: sessionIdForOutput(),
          reminders: state.reminders,
          ...value,
        })
      }

      /**
       * M6 残余 b：闸门 settled 只有两种状态——**受理**（result resolve）或**被 abort**。
       * 已受理的成功结果优先于迟到的 cancel：cancel 只影响进程清理，不改业务结局。
       * 只有闸门确实被 abort 时才允许按取消分类（否则保留 abort 的真实原因）。
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
              message: `Claude 活动被取消${state.cancelReason ? `：${state.cancelReason}` : ''}`,
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
       * agent 停下但没调工具：MISSING。先 abort 闸门，保证之后的迟到 submit
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

      /** 完成宽限：到期后整组 TERM → KILL（M5：grace=0 只跳过等待，不跳过升级）。 */
      const scheduleGraceKill = () => {
        if (state.gateSettled || exitedDone) return
        state.gateSettled = true
        const fire = () => {
          graceTimer = null
          terminateAllGroups('post-finish').catch(() => {})
        }
        if (settings.postFinishGraceMs === 0) {
          fire()
          return
        }
        graceTimer = setTimeout(fire, settings.postFinishGraceMs)
        graceTimer.unref?.()
      }

      // 工具一提交成功（或闸门被 abort）就准备收尾：先让 claude 把工具结果带回给模型，
      // 再在宽限期后收进程组。
      finishGate.result.then(() => scheduleGraceKill(), () => scheduleGraceKill())

      /**
       * M6 退出分类（顺序固定）：
       *   ① gate 已受理 → 完成；② 取消 → 取消；
       *   ③ 无受理记录：握手前失败 → TOOL_UNAVAILABLE（带原原因）；
       *      握手后明确终态错误 → CLAUDE_PROVIDER_ERROR（不消耗提醒预算）；
       *   ④ 只有正常停下、通道可用、无终态错误才提醒 / 续跑；
       *   ⑤ 提醒预算耗尽才是 NODE_FINISH_MISSING。
       */
      const finishAfterNaturalExit = async () => {
        // M6 残余 b：**先看闸门是否已受理**，再看取消。已受理的成功结果不能被迟到的
        // cancel 覆盖成 NODE_FINISH_CANCELED（cancel 照常负责进程清理）。
        if (finishGate.settled()) {
          await resolveFromGate()
          return
        }
        if (state.canceled) {
          abortGate('canceled')
          resolveExited({
            ok: false,
            code: 'NODE_FINISH_CANCELED',
            message: `Claude 活动被取消${state.cancelReason ? `：${state.cancelReason}` : ''}`,
          })
          return
        }
        if (state.startFailed) return
        if (state.handshakeRequired && state.handshakeOk !== true) {
          abortGate('cli-unavailable-before-handshake')
          const rawCause = state.terminalError || (state.assistantError
            ? { code: state.assistantError, message: '' }
            : null)
          const cause = rawCause === null ? null : {
            code: boundTerminalText(rawCause.code, 200),
            ...(rawCause.subtype === undefined ? {} : { subtype: boundTerminalText(rawCause.subtype, 200) }),
            ...(rawCause.message === undefined || rawCause.message === ''
              ? {}
              : { message: boundTerminalText(rawCause.message) }),
          }
          resolveExited({
            ok: false,
            code: ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
            message: boundText(
              `Claude CLI 在 MCP 握手前就不可用（exit=${state.invocation.exitCode === undefined
                ? 'none'
                : state.invocation.exitCode}${cause ? `, cli=${cause.code}` : ''}）：`
                + 'flow_finish_node 没有被加载，节点零完结',
              500,
            ),
            ...(cause ? { error: { ...cause } } : {}),
            reminders: state.reminders,
          })
          return
        }
        const terminal = terminalErrorFor(state.invocation)
        if (terminal) {
          // 握手后明确终态错误：稳定 provider 错误码，**不再提醒 / 续跑**。
          abortGate('cli-terminal-error')
          resolveExited({
            ok: false,
            code: CLAUDE_PROVIDER_ERROR_CODE,
            message: providerErrorMessage(terminal),
            error: {
              code: terminal.code,
              ...(terminal.subtype ? { subtype: terminal.subtype } : {}),
              ...(terminal.message ? { message: terminal.message } : {}),
            },
            reminders: state.reminders,
          })
          return
        }
        if (state.channelFailed) {
          finishWithoutTool()
          return
        }
        const remaining = settings.reminderLimit - state.reminders
        // m3：`--session-id` 是本次显式传的 UUID，即使 stream-json 没给 init / session_id
        // 事件，它也是可续跑的稳定 key（CLI 侧确实用这个 id 起过会话）。
        const resumeSessionId = state.sessionId
          || (flags.sessionId === true ? state.sessionIdHint : undefined)
        // 没有 resume 能力就没有提醒机制：直接 MISSING（capabilities 已如实标 unsupported）。
        if (!resumeSupported || remaining <= 0 || !resumeSessionId) {
          finishWithoutTool()
          return
        }
        // native hook 没触发（例如 hooks 被用户配置关掉）或本来就走 emulated：进程级续跑。
        // 提醒次数与 native hook 共用通道的同一个计数器：不会各提醒三次。
        while (state.reminders < settings.reminderLimit && !state.canceled) {
          state.reminders += 1
          emitReminder({ count: state.reminders, maxFires: settings.reminderLimit })
          const resumeProc = spawnClaude(buildClaudeArgs({
            prompt: FINISH_REMINDER_TEXT,
            mcpConfigPath,
            // resume 是 emulated 兜底：不再注入 Stop hook，提醒次数由本循环唯一计数。
            settingsPath: null,
            permissionMode: settings.permissionMode,
            model,
            resumeSessionId,
            flags,
          }), 'resume', `${executionId}:invoke-r${state.reminders}`)
          await awaitProcessEnd(resumeProc)
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
              message: `Claude 活动被取消${state.cancelReason ? `：${state.cancelReason}` : ''}`,
            })
            return
          }
          const resumeTerminal = terminalErrorFor(state.invocation)
          if (resumeTerminal) {
            abortGate('cli-terminal-error')
            resolveExited({
              ok: false,
              code: CLAUDE_PROVIDER_ERROR_CODE,
              message: providerErrorMessage(resumeTerminal),
              error: {
                code: resumeTerminal.code,
                ...(resumeTerminal.subtype ? { subtype: resumeTerminal.subtype } : {}),
                ...(resumeTerminal.message ? { message: resumeTerminal.message } : {}),
              },
              reminders: state.reminders,
            })
            return
          }
        }
        finishWithoutTool()
      }

      /** 退出结算只从 `start()` 成功之后启动：握手失败由启动路径抛错收口。 */
      const runSettlement = proc => {
        ;(async () => {
          await awaitProcessEnd(proc)
          await finishAfterNaturalExit()
        })().catch(error => {
          resolveExited({
            ok: false,
            code: error && typeof error.code === 'string' ? error.code : 'NODE_FINISH_CHANNEL_FAILED',
            message: boundText(error && error.message ? error.message : 'Claude 收尾失败', 500),
          })
        })
      }

      /** 取消（幂等）：整组 TERM → KILL，只有整组消失才撤销升级（m1）。 */
      function cancelHandle(target, reason) {
        if (!target || typeof target !== 'object') {
          return Promise.reject(new ClaudeAdapterError(
            ADAPTER_ERROR.INVALID,
            'cancel 需要 start() 返回的 handle',
            { adapterId: CLAUDE_ADAPTER_ID, field: 'handle', reason: 'missing' },
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
            // 取消不排空 stdout：先让 stream 收口（避免等 5s 排空期限），再整组升级。
            for (const proc of spawnedProcesses) {
              try {
                proc.streams.dispose()
              } catch {
                // ignore
              }
            }
            await terminateAllGroups(state.cancelReason)
          }
          await Promise.race([exited, sleep(settings.killTimeoutMs + 1_000)])
          if (!exitedDone) {
            await supervisor.disposeAll().catch(() => {})
            await Promise.race([exited, sleep(1_000)])
          }
          if (!exitedDone) {
            resolveExited({
              ok: false,
              code: 'NODE_FINISH_CANCELED',
              message: `Claude 活动被取消${state.cancelReason ? `：${state.cancelReason}` : ''}`
                + '（进程退出未确认，按取消收口）',
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
          resolveExited({
            ok: false,
            code: 'NODE_FINISH_CANCELED',
            message: 'Claude 句柄释放时仍未确认进程退出，按取消收口',
          })
        }
        await supervisor.disposeAll().catch(() => {})
        for (const proc of spawnedProcesses) {
          try {
            proc.streams.dispose()
          } catch {
            // ignore
          }
        }
        // 临时 MCP 配置 / hook 设置 / socket 都在 runDir 里，整目录销毁；channel 一并关闭。
        await resources.disposeAll()
        if (handleRef) handleRef = null
        watchFinalCleanup()
      }

      // ---- 参数构造（模型 / 提示词）也在 protect 范围内（M4） ----
      const model = resolveNodeModel(settings, runnerCtx, element)
      const prompt = buildClaudeNodePrompt({ element, ctx: runnerCtx, workspaceRoot: workspace })

      // ctx.signal 用来在活动超时时收掉进程组（runner 的取消路径）。
      if (runnerCtx.signal && typeof runnerCtx.signal.addEventListener === 'function') {
        signalListener = () => {
          if (handleRef) cancelHandle(handleRef, 'ctx.signal').catch(() => {})
          else pendingAbort = true
        }
        runnerCtx.signal.addEventListener('abort', signalListener, { once: true })
        if (runnerCtx.signal.aborted === true) pendingAbort = true
      }
      resources.add('signal-listener', () => {
        if (signalListener && runnerCtx.signal
          && typeof runnerCtx.signal.removeEventListener === 'function') {
          try {
            runnerCtx.signal.removeEventListener('abort', signalListener)
          } catch {
            // ignore
          }
        }
        signalListener = null
      })

      // 初始 session id：probe 确认 CLI 支持 --session-id 时显式指定 UUID，
      // 这样即使 stream-json 没来得及给出 session_id，续跑也有稳定的 key。
      // m3：probe 不支持该参数时不生成 UUID——否则会对外暴露一个从未传给 CLI 的 id。
      const sessionId = flags.sessionId === true ? randomUUID() : undefined
      state.sessionIdHint = sessionId
      const initialProc = spawnClaude(buildClaudeArgs({
        prompt,
        mcpConfigPath,
        settingsPath,
        permissionMode: settings.permissionMode,
        model,
        sessionId,
        flags,
      }), 'initial', `${executionId}:invoke-1`)

      // 等 MCP server 第一次连上通道：说明 claude 真的把它拉起来了（probe 只验证了自己
      // 这一侧）。等不到就按「工具通道不可用」失败（不允许静默降级）。
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
        if (outcome === 'contacted' || channel.contacted === true) {
          state.handshakeOk = true
        } else {
          if (state.canceled) {
            throw new ClaudeAdapterError(
              'NODE_FINISH_CANCELED',
              'Claude 活动在 MCP 握手期间被取消（finish.sock 与 runDir 已清理）',
              { adapterId: CLAUDE_ADAPTER_ID, reason: 'canceled-during-handshake' },
            )
          }
          // 握手前就失败（CS：exit 分支之前先 abort gate 会导致后续误判——这里在
          // gate 尚未 settle 时统一抛 TOOL_UNAVAILABLE，gate 已 settle 则交给退出结算）。
          if (!finishGate.settled()) {
            // A3：异步 spawn 失败也要认出命令行过长（与同步抛错的分类保持一致）。
            if (outcome === 'spawn-failed' && isArgvTooLargeError(state.spawnError)) {
              throw argvTooLargeError({ error: state.spawnError, args: state.spawnArgv })
            }
            const cause = state.terminalError
              || (state.assistantError ? { code: state.assistantError, message: '' } : null)
            const reason = outcome === 'spawn-failed'
              ? 'spawn-failed'
              : (outcome === 'exited' ? 'exited-before-handshake' : 'mcp-handshake-timeout')
            const exitCode = state.invocation.exitCode
            const detail = outcome === 'spawn-failed'
              ? `进程启动失败（${state.spawnError && state.spawnError.code ? state.spawnError.code : 'unknown'}）`
              : outcome === 'exited'
                ? `CLI 在握手前退出（exit=${exitCode === undefined ? 'none' : exitCode}${
                  cause ? `, cli=${cause.code}` : ''}）`
                : `${settings.helloTimeoutMs}ms 内没有拉起 MCP 完成通道`
            throw new ClaudeAdapterError(
              ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
              `Claude CLI 没有建立 flow_finish_node 通道：${detail}`,
              {
                adapterId: CLAUDE_ADAPTER_ID,
                reason,
                cause: outcome === 'spawn-failed'
                  ? (state.spawnError && state.spawnError.code ? String(state.spawnError.code) : 'SPAWN_FAILED')
                  : (exitCode === undefined ? 'NO_EXIT_CODE' : `EXIT_${exitCode}`),
                ...(exitCode === undefined ? {} : { exitCode }),
                ...(cause ? { cliError: { code: cause.code, subtype: cause.subtype, message: cause.message } } : {}),
                ...(outcome === 'timeout' ? { timeoutMs: settings.helloTimeoutMs } : {}),
              },
            )
          }
        }
      }

      handle = {
        get pid() {
          return initialProc.child && initialProc.child.pid ? initialProc.child.pid : undefined
        },
        get sessionId() {
          // m3：只返回真的传给 CLI / CLI 自己报过的 id。
          return sessionIdForOutput()
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
         * 本次执行观测到的全部模型调用（M1/M2 由账本去重与定型）：
         * 同一 message.id 是同一个调用，重复上报是替换；**不是**每条 assistant 事件一条。
         * agent-execute 在任何结局收尾时读它。
         */
        usageCalls() {
          return exportUsageCalls()
        },
        /** 范围级结算快照（result.usage）：不增加调用数，交给 agent/usage-snapshot。 */
        usageSnapshots() {
          return exportUsageSnapshots()
        },
        /** 诊断用：每次返回**脱敏后的深拷贝**；完结判定不看这些。 */
        get events() {
          return redactValue(state.events)
        },
        get stdoutTail() {
          return streamsTail(stream => stream.stdoutTail(), CLAUDE_STDOUT_TAIL_BYTES)
        },
        get stderrTail() {
          return streamsTail(stream => stream.stderrTail(), CLAUDE_STDERR_TAIL_BYTES)
        },
        get diagnostics() {
          return redactValue({
            resultSubtype: state.resultSubtype,
            resultIsError: state.resultIsError,
            numTurns: state.numTurns,
            totalCostUsd: state.totalCostUsd,
            mcpServers: state.mcpServers,
            mcpServerErrors: state.mcpServerErrors,
            exitCode: state.exitCode,
            signal: state.signal,
            permissionMode: settings.permissionMode,
            handshakeOk: state.handshakeOk,
            terminalError: state.terminalError ? { ...state.terminalError } : null,
            protocolErrors: state.protocolErrors,
            droppedLines: state.droppedLines,
            outputDrained: state.outputDrained,
            outputIncomplete: state.outputIncomplete,
            usageLedger: ledger.stats(),
            stream: state.streamDiagnostics.slice(-10),
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

      handleRef = handle
      if (pendingAbort) {
        cancelHandle(handle, 'ctx.signal').catch(() => {})
      }
      // 只有启动成功之后才进入退出结算（握手失败由上面抛错收口）。
      runSettlement(initialProc)
      return handle
    } catch (error) {
      // M4：参数构造 / spawn（含同步异常）/ 握手的任何失败都在这里统一清理。
      if (typeof startFailureCleanup === 'function') {
        const snapshot = await startFailureCleanup()
        if (error && typeof error === 'object') {
          error.cleanup = snapshot
          error.cleanupFinal = cleanupFinal
        }
      }
      // M2 残余：没有返回 handle 时，已观测用量只能经失败载体交给 executor；
      // 一条都没有就不挂（不留空的假账本）。
      if (error && typeof error === 'object'
        && typeof exportUsageCalls === 'function' && typeof exportUsageSnapshots === 'function') {
        try {
          const calls = exportUsageCalls()
          const snapshots = exportUsageSnapshots()
          if (calls.length > 0) error.usageCalls = calls
          if (snapshots.length > 0) error.usageSnapshots = snapshots
        } catch {
          // 读取账本失败不改变启动失败的结局（诊断信息本来就不保证）。
        }
      }
      throw error
    }
  }

  const adapter = {
    id: CLAUDE_ADAPTER_ID,
    probe,
    capabilities,
    invalidateProbe,
    start,
    /**
     * 0.13.10 可选消息能力的显式占位：本轮不支持轮次中投递。
     *
     * 不抛异常（宿主按 `{ok:false, unsupported:true, deliveryUnknown:true}` 记录），
     * 也绝不返回 ok:true。
     */
    async deliverMessage() {
      return {
        ok: false,
        unsupported: true,
        deliveryUnknown: true,
        code: 'CLAUDE_MESSAGE_DELIVERY_UNSUPPORTED',
        error: 'claude 适配器本轮没有收件箱投递能力：按 deliveryUnknown 记录，不假装成功',
      }
    },
    cancel: (handle, reason) => (handle && typeof handle.cancel === 'function'
      ? handle.cancel(reason)
      : Promise.reject(new ClaudeAdapterError(
        ADAPTER_ERROR.INVALID,
        'cancel 需要 start() 返回的 handle',
        { adapterId: CLAUDE_ADAPTER_ID, field: 'handle', reason: 'missing' },
      ))),
    dispose: handle => (handle && typeof handle.dispose === 'function'
      ? handle.dispose()
      : Promise.resolve()),
  }
  return adapter
}

export default createClaudeAdapter
