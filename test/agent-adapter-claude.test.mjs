#!/usr/bin/env node
/**
 * `agent-adapter-claude.js` 自检：假 `claude` CLI 驱动真实 MCP 完成通道 + 进程组清理。
 *
 * 覆盖（对应 0.14 §G 的验收点）：
 *   1. 正常：握手 → 调用 `flow_finish_node` → `exited.ok===true` + record + gate settle；
 *   2. 只输出「完成」/ exit 0 未调工具 → 三次提醒耗尽 → `NODE_FINISH_MISSING`，迟到 submit 被拒；
 *   3. 重复提交 → 第二次 `NODE_ALREADY_FINISHED`；跨 execution 凭据 → 通道拒绝；
 *      取消后迟到提交 → `NODE_ALREADY_SETTLED`；
 *   4. `capabilities()` 在 probe 前 `finishTool:"unsupported"`、probe 后 native；
 *      CLI 缺失 / 版本过低 / 参数面不足时 probe 明确不可用（不伪造成功）；
 *   5. usage：每条 assistant 事件一条 callId；result 累计值不双计；取消 / 超时仍保留已观测 usage；
 *   6. 取消 / 超时释放进程树（claude + MCP server）与临时 MCP 配置目录（断言目录消失、无残留进程）；
 *   7. 凭据不进 argv / 提示词 / events / lastMessage / stdout（MCP 配置 0600 是受控注入）；
 *   8. Native Stop hook 与 emulated resume 共用同一个提醒预算（不会各提醒三次）。
 *
 * 假 `claude` 是本文件写出的可执行 Node 脚本：它读取本适配器生成的 `--mcp-config`，
 * 用官方 MCP SDK client 启动 `src/node-finish-mcp.js` 并调用工具——整条通道是真的。
 * `--version` / `--help` / `--mcp-config` / `--resume` / `--settings` 的参数面按本机
 * 官方文档形状模拟；**这不是真实 Claude CLI 的验收**（本机没有 claude）。
 *
 * 运行：node test/agent-adapter-claude.test.mjs
 */

import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createClaudeAdapter, CLAUDE_ADAPTER_ID, CLAUDE_ARGV_TOO_LARGE_CODE, CLAUDE_PROVIDER_ERROR_CODE,
} from '../src/agent-adapter-claude.js'
import {
  normalizeUsage, readAdapterUsageCalls, readAdapterUsageSnapshots, usageEventForCall, usageSnapshotEventFor,
} from '../src/agent-telemetry.js'
import { computeInstanceMetrics } from '../src/instance-metrics.js'
import { createFinishGate } from '../src/node-finish.js'
import { ADAPTER_ERROR, assertFinishToolNative, validateAdapter } from '../src/agent-adapter.js'
import { admitAdapter, runAgentNode } from '../src/agent-execute.js'
import { discoverClaudeCli } from '../scripts/claude-cli-discovery.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
// 前缀刻意短：finish.sock 是 unix socket，路径总长（含中文 / 深 worktree）必须留在
// sockaddr_un 的 108 字节以内；长前缀会让 listen 直接 EINVAL。
const sandbox = mkdtempSync(join(repoRoot, '.tmp', 'cl-'))

let checks = 0
let asserts = 0
let skips = 0
const A = new Proxy(assert, {
  get(target, property) {
    const value = target[property]
    if (typeof value !== 'function') return value
    return (...args) => {
      asserts += 1
      return value.apply(target, args)
    }
  },
})
async function check(name, fn) {
  const result = await fn()
  if (result && result.skipped === true) {
    skips += 1
    console.log(`  ↷ SKIP ${name}`)
    return
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

const stateDir = join(sandbox, 'state')
mkdirSync(stateDir, { recursive: true })

/** 假 claude：模拟 `--version` / `--help` / `-p --output-format stream-json` / `--resume` / `--settings`。 */
const FAKE_CLAUDE_SOURCE = `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_CLAUDE_MODE || 'never'
const stateDir = process.env.FAKE_CLAUDE_STATE_DIR || '.'
const fallbackSessionId = process.env.FAKE_CLAUDE_SESSION_ID || '22222222-2222-4222-8222-222222222222'
const out = obj => {
  // m3 夹具：SKIP_INIT 模式下所有事件都不带 session_id（模拟 CLI 完全不告诉你 id）。
  let payload = obj
  if (process.env.FAKE_CLAUDE_SKIP_INIT === '1' && payload && typeof payload === 'object') {
    payload = { ...payload }
    delete payload.session_id
  }
  process.stdout.write(JSON.stringify(payload) + '\\n')
}

if (process.env.FAKE_CLAUDE_HANG === '1') {
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (process.env.FAKE_CLAUDE_SLOW === '1') await new Promise(resolve => setTimeout(resolve, 400))

if (argv[0] === '--version') {
  if (process.env.FAKE_CLAUDE_FAIL_VERSION === '1') {
    process.stderr.write('fake claude: broken build\\n')
    process.exit(1)
  }
  process.stdout.write('2.1.309 (Claude Code)\\n')
  process.exit(0)
}
if (argv[0] === '--help') {
  if (process.env.FAKE_CLAUDE_OLD === '1') {
    // 缺 --mcp-config / --resume：probe 必须拒绝宣称可用。
    process.stdout.write('Usage: claude [options] [prompt]\\n  -p, --print\\n  --output-format <format>\\n  --verbose\\n')
    process.exit(0)
  }
  const dropFlags = String(process.env.FAKE_CLAUDE_DROP_FLAG || '')
    .split(',').map(item => item.trim()).filter(Boolean)
  const allowedToolsLine = process.env.FAKE_CLAUDE_HELP_ALIAS === '1'
    ? '  --allowed-tools <tools...>        Tools that execute without prompting'
    : '  --allowedTools <tools...>         Tools that execute without prompting'
  // MAJOR-1：probe 走的是 runOnce 里的 reader，不是主协议 reader——用一条 9 MiB 的
  // --help 行（必需参数只存在于这一行）证明那一路的上限同样必须是 32 MiB。
  const hugeAllowedToolsLine = process.env.FAKE_CLAUDE_HELP_HUGE === '1'
    ? '  --allowedTools <tools...>         ' + 'x'.repeat(9 * 1024 * 1024)
    : null
  const helpLines = [
    'Usage: claude [options] [prompt]',
    '',
    '  -p, --print                       Print response and exit',
    '  --output-format <format>          text | json | stream-json',
    '  --verbose                         Verbose output',
    '  --mcp-config <configs...>         Load MCP servers from JSON files or strings',
    '  --strict-mcp-config               Only use MCP servers from --mcp-config',
    '  --settings <file-or-json>         Path to a settings JSON file',
    '  --resume, -r <id>                 Resume a session',
    '  --session-id <uuid>               Use a specific session ID',
    '  --permission-mode <mode>          default | acceptEdits | plan | auto | dontAsk | bypassPermissions',
    '  --permission-prompts <mode>       host | none',
    hugeAllowedToolsLine || allowedToolsLine,
    '  --disallowedTools <tools...>      Tools to disallow',
    '  --model <model>                   Model for the session',
    '',
  ].filter(line => !dropFlags.some(flag => line.includes(flag)))
  // 超长 help 行必须等 stdout 真正排空再退出，否则 9 MiB 行会被裁成半截（假 CLI 自身缺陷）。
  await new Promise(resolveWrite => process.stdout.write(helpLines.join('\\n'), resolveWrite))
  process.exit(0)
}

/** 读 --flag value（argv 里第一次出现）。 */
function takeValue(name) {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null
}

// m3：模拟「CLI 从不报 session_id」的版本（配合 FAKE_CLAUDE_DROP_FLAG=--session-id）。
const emitSession = process.env.FAKE_CLAUDE_OMIT_SESSION !== '1'
const prompt = argv[0] === '-p' && argv.length > 1 ? argv[1] : argv[argv.length - 1]
const mcpConfigPath = takeValue('--mcp-config')
const settingsPath = takeValue('--settings')
const resumeId = takeValue('--resume') || takeValue('-r')
const sessionIdArg = takeValue('--session-id')
const model = takeValue('--model')
const permissionMode = takeValue('--permission-mode')
const permissionPrompts = takeValue('--permission-prompts')
const allowedTools = takeValue('--allowedTools') || takeValue('--allowed-tools')
const isResume = typeof resumeId === 'string' && resumeId !== ''
const sessionId = isResume ? resumeId : (sessionIdArg || fallbackSessionId)

let mcpConfig = null
let mcpConfigMode = null
if (mcpConfigPath) {
  mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'))
  mcpConfigMode = statSync(mcpConfigPath).mode & 0o777
}
let settings = null
let hookCommand = null
if (settingsPath) {
  settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  const group = settings && settings.hooks && Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop[0] : null
  const handler = group && Array.isArray(group.hooks) ? group.hooks[0] : null
  hookCommand = handler && typeof handler.command === 'string' ? handler.command : null
}

const token = process.env.FLOW_STUDIO_FINISH_TOKEN || ''
const socketPath = process.env.FLOW_STUDIO_FINISH_SOCKET || ''
const joined = argv.join(' ')
mkdirSync(join(stateDir, 'invocations'), { recursive: true })
writeFileSync(join(stateDir, 'invocations', process.pid + '.json'), JSON.stringify({
  pid: process.pid,
  isResume,
  prompt,
  argv,
  mcpConfigPath,
  mcpConfig,
  mcpConfigMode,
  settingsPath,
  hasStopHook: hookCommand !== null,
  resumeId,
  sessionIdArg,
  model,
  permissionMode,
  permissionPrompts,
  allowedTools,
  tokenInArgv: token !== '' && joined.includes(token),
  tokenInPrompt: token !== '' && String(prompt).includes(token),
  tokenInMcpConfig: token !== '' && JSON.stringify(mcpConfig || {}).includes(token),
  envNames: Object.keys(process.env).sort(),
  hostSentinel: process.env.HOST_SECRET_SENTINEL === undefined ? null : process.env.HOST_SECRET_SENTINEL,
  token,
}))

// m3: init may be missing on some CLI versions; --session-id was passed explicitly, so resume can still work.
if (process.env.FAKE_CLAUDE_SKIP_INIT !== '1') out({ type: 'system', subtype: 'init', session_id: sessionId })

const skipMcp = mode === 'no-mcp' || mode === 'no-mcp-stubborn' || mode === 'early-error'
  || mode === 'usage-then-no-mcp'
let transport = null
let client = null
if (!skipMcp && mcpConfig) {
  const server = mcpConfig.mcpServers.flow_finish
  const env = { PATH: process.env.PATH, HOME: process.env.HOME }
  for (const [name, value] of Object.entries(server.env || {})) env[name] = value
  transport = new StdioClientTransport({ command: server.command, args: server.args, env, stderr: 'pipe' })
  client = new Client({ name: 'fake-claude', version: '2.1.309' })
  await client.connect(transport)
  if (transport.stderr) transport.stderr.on('data', () => {})
  if (transport.pid) writeFileSync(join(stateDir, 'mcp.pid'), String(transport.pid))
}

function assistantEvent(usage, text, id) {
  out({
    type: 'assistant',
    ...(emitSession ? { session_id: sessionId } : {}),
    parent_tool_use_id: null,
    message: {
      id: id || ('msg_' + Date.now() + '_' + Math.random().toString(16).slice(2)),
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [ { type: 'text', text } ],
      usage,
    },
  })
}

function resultEvent(usage, text) {
  out({
    type: 'result',
    subtype: 'success',
    ...(emitSession ? { session_id: sessionId } : {}),
    is_error: false,
    num_turns: 1,
    result: text,
    total_cost_usd: 0.01,
    usage,
    permission_denials: [],
  })
}

const usageA = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 30 }
const usageB = { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 11, output_tokens: 13 }
// 真实夹具：result.usage 是**最终结算值**（不是 999 哨兵）。0.14.5 M2 起它就是
// agent/usage-snapshot（scope=invocation），不能再用「999 被忽略」掩盖契约。
const usageResultFinal = {
  input_tokens: 17, cache_creation_input_tokens: 5, cache_read_input_tokens: 31, output_tokens: 43,
}

async function callTool(summary) {
  return client.callTool({
    name: 'flow_finish_node',
    arguments: { variables: { verdict: 'pass', score: 87 }, documents: [], summary: summary || 'fake claude finished' },
  })
}

function toolErrorCode(result) {
  try {
    const text = result && result.content && result.content[0] ? result.content[0].text : '{}'
    return JSON.parse(text)?.error?.code ?? null
  } catch {
    return null
  }
}

async function runStopHook(active) {
  if (!hookCommand) return { block: false, reason: null }
  const result = spawnSync('bash', ['-c', hookCommand], {
    input: JSON.stringify({
      session_id: sessionId,
      hook_event_name: 'Stop',
      stop_hook_active: active === true,
      last_assistant_message: 'done',
      cwd: process.cwd(),
    }),
    encoding: 'utf8',
    env: { ...process.env },
  })
  let parsed = {}
  try {
    parsed = JSON.parse((result.stdout || '').trim() || '{}')
  } catch {
    parsed = {}
  }
  mkdirSync(join(stateDir, 'hooks'), { recursive: true })
  writeFileSync(join(stateDir, 'hooks', process.pid + '-' + Date.now() + '.json'), JSON.stringify({
    stdout: parsed,
    exit: result.status,
    hookCommand,
    raw: result.stdout,
    err: result.stderr,
  }))
  return { block: parsed.decision === 'block', reason: parsed.reason || null }
}

/** 用**另一个 execution 的假凭据**直接打本 execution 的通道（跨 execution 复用）。 */
function foreignSubmit() {
  return new Promise(resolvePromise => {
    const socket = connect(socketPath)
    let buffer = ''
    socket.on('connect', () => {
      socket.write(JSON.stringify({
        v: 1,
        token: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        op: 'submit',
        args: { variables: {}, documents: [], summary: 'foreign execution' },
      }) + '\\n')
    })
    socket.on('data', chunk => {
      buffer += chunk
      const index = buffer.indexOf('\\n')
      if (index < 0) return
      try {
        resolvePromise(JSON.parse(buffer.slice(0, index)))
      } catch {
        resolvePromise(null)
      }
      socket.destroy()
    })
    socket.on('error', () => resolvePromise(null))
  })
}

async function closeClient() {
  if (!client) return
  try {
    await client.close()
  } catch {
    // ignore
  }
}

function hangForever() {
  if (process.env.FAKE_CLAUDE_STUBBORN === '1') process.on('SIGTERM', () => {})
  writeFileSync(join(stateDir, 'claude.pid'), String(process.pid))
  if (transport && transport.pid) writeFileSync(join(stateDir, 'mcp.pid'), String(transport.pid))
  setInterval(() => {}, 1000)
  return new Promise(() => {})
}


if (mode === 'doc') {
  // worktree 内写文档，再按工作区相对路径引用；gate 负责校验 / 计算 sha256 / 登记产物。
  mkdirSync(join(process.cwd(), 'notes'), { recursive: true })
  writeFileSync(join(process.cwd(), 'notes', 'plan.md'), '# 方案\\n\\n节点写的正文\\n')
  assistantEvent(usageA, '写好了方案文档。')
  await client.callTool({
    name: 'flow_finish_node',
    arguments: {
      variables: { hasDoc: true },
      documents: [{ path: 'notes/plan.md', kind: 'markdown', title: '方案', summary: '节点产出的方案' }],
      summary: '写了方案文档',
    },
  })
  assistantEvent(usageB, '已调用工具。')
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'doc-escape') {
  // 越界路径必须被 gate 拒绝（与现有 adapters 同一份校验）。
  const result = await client.callTool({
    name: 'flow_finish_node',
    arguments: {
      variables: {},
      documents: [{ path: '../escape.md', kind: 'markdown' }],
      summary: '越界文档',
    },
  })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'doc-escape.json'), JSON.stringify({
    isError: result.isError === true,
    code: toolErrorCode(result),
  }))
  assistantEvent(usageA, '越界引用被拒。')
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'call') {
  assistantEvent(usageA, '我先调用 flow_finish_node。')
  await callTool()
  assistantEvent(usageB, '已完成。')
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'never') {
  assistantEvent(usageA, '我完成了，不需要调用工具。')
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'call-on-resume') {
  if (isResume) {
    await callTool('resume 后完成')
    assistantEvent(usageB, '已补调工具。')
  } else {
    assistantEvent(usageA, '我完成了。')
  }
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'dup') {
  assistantEvent(usageA, '调用工具。')
  const first = await callTool('第一次')
  const second = await callTool('第二次')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'dup.json'), JSON.stringify({
    firstError: first.isError === true,
    secondError: second.isError === true,
    secondCode: toolErrorCode(second),
  }))
  assistantEvent(usageB, '已完成。')
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'foreign-token') {
  const response = await foreignSubmit()
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'foreign.json'), JSON.stringify(response))
  assistantEvent(usageA, '跨 execution 凭据被拒。')
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'hook-once') {
  const hook = await runStopHook(false)
  if (hook.block) {
    assistantEvent(usageA, '收到提醒，现在调用工具。')
    await callTool('hook 提醒后完成')
    await runStopHook(true)
  }
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'hook-never') {
  for (let index = 0; index < 6; index += 1) {
    const hook = await runStopHook(index > 0)
    if (!hook.block) break
  }
  assistantEvent(usageA, '我完成了。')
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'leak') {
  assistantEvent(usageA, 'token=' + token + ' socket=' + socketPath + ' password="abc; hunter2"')
  await callTool('泄漏测试')
  resultEvent(usageResultFinal, 'token=' + token + ' socket=' + socketPath)
  await closeClient()
  process.exit(0)
}
if (mode === 'usage-then-hang') {
  assistantEvent(usageA, '先花掉一次调用，然后卡住。')
  await hangForever()
}
if (mode === 'sleep') {
  // 初始进程挂住（等测试 kill）；resume 立刻退出——旧实现「SIGKILL → 提醒续跑」时
  // 不会把一个永远不退出的 resume 进程留在用例里（那会让失败的基线套件挂住）。
  if (isResume) {
    await closeClient()
    process.exit(0)
  }
  await hangForever()
}
if (mode === 'no-mcp') {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'started'), String(process.pid))
  await hangForever()
}
if (mode === 'no-mcp-stubborn') {
  process.env.FAKE_CLAUDE_STUBBORN = '1'
  process.on('SIGTERM', () => {})
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'stubborn.pid'), String(process.pid))
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (mode === 'dup-id') {
  // M1：同一 message.id 的两次上报是同一个模型响应（并行工具块），不能计两次调用。
  assistantEvent(
    { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 20, output_tokens: 1 },
    '同一 message（并行工具块）', 'msg_shared',
  )
  assistantEvent(
    { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 9 },
    '同一 message 的第二次上报', 'msg_shared',
  )
  assistantEvent(usageB, '另一个 message', 'msg_other')
  await callTool('dup-id')
  resultEvent({ input_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 31, output_tokens: 43 }, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'placeholder') {
  // M2：assistant 的 output 只是占位值，最终值在 result 里。
  const zero = { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  assistantEvent({ input_tokens: 10, output_tokens: 1, ...zero }, '先占位', 'msg_ph')
  await callTool('placeholder')
  resultEvent({ input_tokens: 10, output_tokens: 30, ...zero }, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'result-only') {
  // M2：没有任何 assistant usage，只有 result；resume 后的 result 范围不可证明。
  const zero = { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  resultEvent(isResume
    ? { input_tokens: 30, output_tokens: 3, ...zero }
    : { input_tokens: 10, output_tokens: 1, ...zero }, '完成')
  if (isResume) await callTool('result-only')
  await closeClient()
  process.exit(0)
}
if (mode === 'unicode') {
  // M3：中文字符被切成两个 chunk（按字节切在字符中间）。
  const payload = Buffer.from(JSON.stringify({
    type: 'assistant',
    session_id: sessionId,
    message: {
      id: 'msg_unicode',
      usage: usageA,
      content: [ { type: 'text', text: '中文 🚀 结束' } ],
    },
  }) + '\\n')
  const cut = payload.indexOf(Buffer.from('中')) + 1
  process.stdout.write(payload.subarray(0, cut))
  await new Promise(resolve => setTimeout(resolve, 60))
  process.stdout.write(payload.subarray(cut))
  await callTool('unicode')
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'unterminated') {
  // M3：合法 JSON 没有尾换行 → EOF flush 必须交付。
  process.stdout.write(JSON.stringify({
    type: 'assistant',
    session_id: sessionId,
    message: { id: 'msg_eof', usage: usageA, content: [ { type: 'text', text: '没有尾换行' } ] },
  }))
  await callTool('unterminated')
  await closeClient()
  process.exit(0)
}
if (mode === 'long') {
  // M3：600 KiB 合法单行，按 32 KiB 分块写。
  const line = JSON.stringify({
    type: 'assistant',
    session_id: sessionId,
    message: { id: 'msg_long', usage: usageA, content: [ { type: 'text', text: 'x'.repeat(600 * 1024) } ] },
  }) + '\\n'
  for (let index = 0; index < line.length; index += 32768) {
    process.stdout.write(line.slice(index, index + 32768))
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  await callTool('long')
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'format') {
  // M3：BOM + CRLF + 非 JSON 行 + 空行，后面的合法行不能丢。
  process.stdout.write('\\uFEFF\\r\\nnot json\\r\\n\\r\\n')
  assistantEvent(usageA, 'BOM 之后的有效行', 'msg_fmt')
  await callTool('format')
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'resume-half') {
  // M3：初始进程留下半行就退出；resume 进程绝不能把它的半行拼成合法 JSON。
  if (!isResume) {
    process.stdout.write('{"type":"assistant","session_id":"' + sessionId + '","message":{"id":"joined","usage":{"input_tokens":10,')
    await closeClient()
    process.exit(0)
  }
  process.stdout.write('"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":4}}}\\n')
  assistantEvent(usageB, 'resume 自己的事件', 'msg_resume')
  await callTool('resume-half')
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'late-output') {
  // M3：父进程先退出，后代继承 stdout 并在之后写出合法事件；结算必须等排空。
  const lateLine = JSON.stringify({
    type: 'assistant',
    session_id: sessionId,
    message: { id: 'msg_late', usage: usageA, content: [ { type: 'text', text: 'late output' } ] },
  }) + '\\n'
  spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write(' + JSON.stringify(lateLine) + '), 150)'], {
    stdio: ['ignore', 'inherit', 'ignore'],
  })
  await callTool('late-output')
  await closeClient()
  process.exit(0)
}
if (mode === 'zero-grace') {
  // M5：完成后忽略 SIGTERM；适配器必须升级到 SIGKILL 才能有界结算。
  process.on('SIGTERM', () => {})
  await callTool('zero-grace')
  await hangForever()
}
if (mode === 'cancel-tree') {
  // m1：组长会响应 TERM 退出；后代忽略 TERM，只有升级到 KILL 才能收掉。
  const descendant = spawn(process.execPath, [
    '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
  ], { stdio: 'ignore' })
  writeFileSync(join(stateDir, 'descendant.pid'), String(descendant.pid))
  writeFileSync(join(stateDir, 'ready'), 'yes')
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (mode === 'auth-fail-exit0') {
  // A2：握手成功后只有 assistant 消息带 error，**没有 result 事件**，退出码 0。
  out({
    type: 'assistant',
    session_id: sessionId,
    error: 'authentication_failed',
    message: {
      id: 'msg_auth_exit0',
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
      content: [ { type: 'text', text: 'invalid API credential' } ],
    },
  })
  await closeClient()
  process.exit(0)
}
if (mode === 'result-no-subtype') {
  // MAJOR-3：CLI 确实发出了 result（is_error:false）但**缺 subtype**。旧分类用
  // 「没有字符串 subtype」近似「没有 result」，于是把 assistant 错误误判成 provider 错误。
  // 正确语义：有 result 就不是 assistant-only 失败 → 走正常停下路径。
  out({
    type: 'assistant',
    session_id: sessionId,
    error: 'authentication_failed',
    message: {
      id: 'msg_result_no_subtype',
      usage: usageA,
      content: [ { type: 'text', text: '认证失败但随后仍然给出了 result' } ],
    },
  })
  out({
    type: 'result',
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: 'result 没有 subtype',
  })
  await closeClient()
  process.exit(0)
}
if (mode === 'big-result') {
  // MAJOR-1：约 9 MiB 的**合法**终态事件（result 本身很大，不是 protocol error）。
  // 8 MiB 行界会整行丢弃 → 没有 result → 误判 NODE_FINISH_MISSING。
  assistantEvent(usageA, '大 result 之前的正常消息。')
  const hugeLine = JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    session_id: sessionId,
    is_error: true,
    num_turns: 1,
    errors: ['authentication_failed'],
    result: '9MiB terminal event '.repeat(480 * 1024),
  }) + '\\n'
  await new Promise(resolveWrite => process.stdout.write(hugeLine, resolveWrite))
  await closeClient()
  process.exit(0)
}
if (mode === 'stale-assistant-error') {
  // A2 残余：初始轮有一次瞬时 assistant 错误但 result 成功；续跑轮干净退出（无事件）。
  // assistant 错误属于单次 invocation，不能跨 resume 复用。
  if (isResume) {
    await closeClient()
    process.exit(0)
  }
  out({
    type: 'assistant',
    session_id: sessionId,
    error: 'rate_limit_error',
    message: {
      id: 'msg_transient',
      usage: usageA,
      content: [ { type: 'text', text: '一次瞬时错误' } ],
    },
  })
  resultEvent(usageResultFinal, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'error') {
  // M6：握手成功后 CLI 自己报终态错误（认证失败 + result error + 退出码 1）。
  out({
    type: 'assistant',
    session_id: sessionId,
    error: 'authentication_failed',
    message: { id: 'msg_err', content: [ { type: 'text', text: 'invalid API credential' } ] },
  })
  out({
    type: 'result',
    subtype: 'error_during_execution',
    session_id: sessionId,
    is_error: true,
    errors: ['authentication_failed'],
    result: 'API Error: 401 invalid credential',
  })
  await closeClient()
  process.exit(1)
}
if (mode === 'usage-then-no-mcp') {
  // M2 残余：已经观测到 assistant / result 用量，但 MCP 握手前就卡住（随后超时失败）。
  assistantEvent(usageA, '先花掉一次调用，然后不拉起 MCP。')
  resultEvent(usageResultFinal, '完成')
  await hangForever()
}
if (mode === 'secret-error') {
  // F2：凭据分别藏在 errors[0]（→ code）、subtype、result（→ message）里；message 超长。
  const fakeBearer = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'
  out({
    type: 'assistant',
    ...(emitSession ? { session_id: sessionId } : {}),
    message: { id: 'msg_secret', content: [ { type: 'text', text: '认证失败' } ] },
  })
  out({
    type: 'result',
    subtype: 'Bearer ' + token + ' ' + 'z'.repeat(40),
    ...(emitSession ? { session_id: sessionId } : {}),
    is_error: true,
    errors: ['api_key=' + fakeBearer + ' token=' + token],
    result: ('Authorization: ' + fakeBearer + ' sk-' + 'Q'.repeat(64) + ' token=' + token + ' ').repeat(150),
  })
  process.exit(1)
}
if (mode === 'early-error') {
  // M6：握手之前就退出（没有拉起 MCP）——start 必须报 TOOL_UNAVAILABLE，而不是 ABORTED。
  out({
    type: 'assistant',
    session_id: sessionId,
    error: 'authentication_failed',
    message: { id: 'msg_err', content: [ { type: 'text', text: 'invalid API credential' } ] },
  })
  out({
    type: 'result',
    subtype: 'error_during_execution',
    session_id: sessionId,
    is_error: true,
    errors: ['authentication_failed'],
    result: 'API Error: 401 invalid credential',
  })
  process.exit(1)
}
await closeClient()
process.exit(0)
`

const fakeBin = join(sandbox, 'fake-claude.mjs')
writeFileSync(fakeBin, FAKE_CLAUDE_SOURCE, { mode: 0o755 })
chmodSync(fakeBin, 0o755)

const FAKE_FLAGS = Object.freeze({
  print: true,
  outputFormat: true,
  mcpConfig: true,
  strictMcpConfig: true,
  settings: true,
  resume: true,
  sessionId: true,
  permissionMode: true,
  permissionPrompts: true,
  allowedTools: true,
  disallowedTools: true,
  model: true,
  verbose: true,
})

const FAKE_PROBE = Object.freeze({
  version: '2.1.309',
  helpDigest: 'fake-help-digest',
  flags: FAKE_FLAGS,
  printMode: true,
  outputFormat: true,
  mcpConfig: true,
  mcpConfigFlag: true,
  strictMcpConfig: true,
  settingsFlag: true,
  resume: true,
  sessionIdFlag: true,
  permissionModeFlag: true,
  stopHookFlag: true,
  bridge: { ok: true, skipped: true },
})

function makeAdapter(overrides = {}) {
  const { env, ...rest } = overrides
  return createClaudeAdapter({
    claudeBin: fakeBin,
    tmpRoot: sandbox,
    reminderLimit: 3,
    postFinishGraceMs: 1_500,
    helloTimeoutMs: 10_000,
    killTimeoutMs: 1_200,
    selfTest: false,
    probeResult: FAKE_PROBE,
    ...rest,
    env: { FAKE_CLAUDE_STATE_DIR: stateDir, ...(env || {}) },
  })
}

function freshWorkspace(name) {
  const dir = join(sandbox, `ws-${name}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeGate(workspace) {
  return createFinishGate({
    executionId: `exec-${Math.random().toString(16).slice(2)}`,
    nodeId: 'agent-1',
    attempt: 1,
    workspaceRoot: workspace,
  })
}

function invocations() {
  const dir = join(stateDir, 'invocations')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')))
    .sort((a, b) => a.pid - b.pid)
}

function resetState() {
  rmSync(stateDir, { recursive: true, force: true })
  mkdirSync(stateDir, { recursive: true })
}

/** 适配器私有临时目录（`fs-claude-*` / `fs-bridge-*`），用来断言清理彻底。 */
function leftoverDirs() {
  return readdirSync(sandbox).filter(name => name.startsWith('fs-')).sort()
}

async function waitForFile(path, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  return false
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code !== 'ESRCH'
  }
}

async function waitForDead(pid, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  return !pidAlive(pid)
}

function sleep(ms) {
  return new Promise(resolveSleep => { setTimeout(resolveSleep, ms) })
}

/** 常用 element：node.prompt / roleCard 是任务本体，description 只是补充。 */
function elementWithPrompt(overrides = {}) {
  const { node, ...rest } = overrides
  return {
    id: 'agent-1',
    name: '工具节点',
    description: 'BPMN 元素描述：仅供人读，不是任务本体',
    ...rest,
    node: {
      prompt: '为本需求写一份实施方案（这是节点真正的任务提示词）',
      roleCard: '你是方案设计专员。',
      ...(node || {}),
    },
  }
}

/** 按 fake mode 跑一次完整活动（resetState 后启动，默认等到 exited）。 */
async function runClaudeMode(mode, options = {}) {
  resetState()
  const workspace = freshWorkspace(`mode-${mode}-${Math.random().toString(16).slice(2, 8)}`)
  const adapter = makeAdapter({
    env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: mode },
    ...(options.overrides || {}),
  })
  const gate = makeGate(workspace)
  const handle = await adapter.start({
    element: options.element || { id: 'agent-1', name: `${mode} 节点` },
    ctx: {},
    finishGate: gate,
    workspaceRoot: workspace,
    reminder: { onFire: () => {} },
  })
  const exited = options.awaitExit === false ? null : await handle.exited
  return { adapter, workspace, gate, handle, exited }
}

/**
 * handle 的调用 / 快照事实 → 真实归约链（agent-execute 就是这么落盘的），
 * 用来断言「适配器接线 + 指标口径」一起正确。
 */
function metricsForHandle(handle, invocationId = 'inv-adapter') {
  const at = '2026-11-12T00:00:00.000Z'
  const events = []
  let seq = 0
  for (const call of readAdapterUsageCalls(handle, 'claude')) {
    events.push({
      seq: ++seq, at, ...usageEventForCall({ ...call, invocationId: call.invocationId ?? invocationId }),
    })
  }
  for (const snapshot of readAdapterUsageSnapshots(handle, 'claude')) {
    events.push({
      seq: ++seq, at, ...usageSnapshotEventFor({ ...snapshot, invocationId: snapshot.invocationId ?? invocationId }),
    })
  }
  return computeInstanceMetrics({
    instance: {
      id: 'i-claude-adapter',
      definitionId: 'flow-claude',
      definitionVersion: 1,
      definitionHash: 'a'.repeat(64),
      status: 'ACTIVE',
      variables: {},
      result: null,
      artifacts: [],
      lastError: null,
      lastAgentOutput: null,
      pendingTasks: [],
      revision: 1,
      eventCount: events.length,
      lastSeq: events.length,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      definitionSnapshot: 'definition.bpmn',
    },
    events,
    asOf: at,
  })
}

async function main() {
  console.log('agent-adapter-claude：假 claude + 真 MCP 通道 + 真进程组')
  try {
    await check('接口形状；probe 前 unsupported，probe 后 native；hooks 默认 emulated、messages unsupported', async () => {
      const adapter = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        env: { FAKE_CLAUDE_STATE_DIR: stateDir },
      })
      A.equal(adapter.id, CLAUDE_ADAPTER_ID)
      A.doesNotThrow(() => validateAdapter(adapter))
      A.equal(adapter.capabilities().finishTool, 'unsupported', 'probe 之前不能宣称 native')
      A.equal(adapter.capabilities().hooks['turn.stop'], 'emulated', '默认只能声明 emulated')
      A.equal(adapter.capabilities().messages, 'unsupported', '没有轮次中投递就如实 unsupported')

      const probe = await adapter.probe()
      A.equal(probe.version, '2.1.309', '版本来自真实 --version')
      A.equal(typeof probe.helpDigest, 'string')
      A.ok(probe.helpDigest.length > 0)
      A.equal(probe.printMode, true)
      A.equal(probe.outputFormat, true)
      A.equal(probe.mcpConfig, true)
      A.equal(probe.resume, true)
      A.equal(probe.sessionIdFlag, true)
      A.equal(probe.bridge.skipped, true)
      A.match(probe.realChannelEvidence, /未验收/, 'probe 结果如实带「真实通道未验收」说明')

      const caps = adapter.capabilities()
      A.equal(caps.finishTool, 'native', 'probe 成功后才 native')
      A.equal(caps.usage, 'native')
      A.equal(caps.hooks['turn.stop'], 'emulated')
      A.match(caps.evidence['turn.stop'], /emulated/)
      A.match(caps.evidence.realChannel, /未验收/)
      A.match(caps.evidence.userConfig, /settings\.json/)

      const nativeAdapter = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        stopHook: 'native',
        probeResult: FAKE_PROBE,
      })
      A.equal(nativeAdapter.capabilities().hooks['turn.stop'], 'native', '显式 stopHook:native 才标 native')
      A.match(nativeAdapter.capabilities().evidence['turn.stop'], /未经真实 CLI 验收/, 'native 必须如实标注未验收')

      const noResume = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        probeResult: { ...FAKE_PROBE, resume: false },
      })
      A.equal(noResume.capabilities().hooks['turn.stop'], 'unsupported', '没有 resume → 提醒机制 unsupported')

      // probe 缓存 TTL + 显式 invalidate。
      const ttlAdapter = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        probeCacheTtlMs: 60,
        probeResult: FAKE_PROBE,
      })
      A.equal(ttlAdapter.capabilities().finishTool, 'native')
      await sleep(120)
      A.equal(ttlAdapter.capabilities().finishTool, 'unsupported', 'TTL 过期后不能继续拿旧缓存宣称 native')
      ttlAdapter.invalidateProbe()
      const refreshed = await ttlAdapter.probe()
      A.equal(refreshed.version, '2.1.309')
      A.equal(ttlAdapter.capabilities().finishTool, 'native')
    })

    await check('probe 失败语义：CLI 缺失 / 版本坏 / 参数面不足 / 总超时；probe 失败时 start 零派发', async () => {
      const missing = createClaudeAdapter({
        claudeBin: join(sandbox, 'no-such-claude'),
        tmpRoot: sandbox,
        selfTest: false,
      })
      const started = Date.now()
      await A.rejects(missing.probe(), error => {
        A.equal(error?.name, 'ClaudeAdapterError')
        A.equal(error?.code, ADAPTER_ERROR.PROBE_INVALID)
        A.equal(error?.details?.reason, 'cli-unavailable')
        return true
      })
      A.ok(Date.now() - started < 5_000, 'spawn ENOENT 必须快速失败')
      A.equal(missing.capabilities().finishTool, 'unsupported')

      const badVersion = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_FAIL_VERSION: '1' },
      })
      await A.rejects(badVersion.probe(), error => {
        A.equal(error?.code, ADAPTER_ERROR.PROBE_INVALID)
        A.equal(error?.details?.reason, 'cli-unavailable')
        return true
      })

      const oldCli = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_OLD: '1' },
      })
      await A.rejects(oldCli.probe(), error => {
        A.equal(error?.code, ADAPTER_ERROR.PROBE_INVALID)
        A.equal(error?.details?.reason, 'cli-flags-missing')
        return true
      })
      A.equal(oldCli.capabilities().finishTool, 'unsupported', '参数面不足不能宣称 native')

      const slow = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_SLOW: '1' },
        probeTimeoutMs: 1_000,
      })
      await A.rejects(slow.probe(), error => {
        A.equal(error?.code, ADAPTER_ERROR.PROBE_INVALID)
        A.equal(error?.details?.reason, 'probe-timeout')
        return true
      })

      resetState()
      const workspace = freshWorkspace('probe-failed')
      await A.rejects(
        missing.start({
          element: { id: 'agent-1', name: '不可用节点' },
          ctx: {},
          finishGate: makeGate(workspace),
          workspaceRoot: workspace,
        }),
        error => {
          // m5：start 统一 NODE_FINISH_TOOL_UNAVAILABLE，原 probe 错误码放 details.cause。
          A.equal(error?.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE, 'start 统一不可用错误码')
          A.equal(error?.details?.cause, ADAPTER_ERROR.PROBE_INVALID, '原 probe 错误码保留在 cause')
          A.equal(error?.details?.causeReason, 'cli-unavailable')
          return true
        },
      )
      A.equal(invocations().length, 0, '真实 probe 失败 → start 零派发')
    })

    await check('正常：握手 → 调用 flow_finish_node → exited 带 record，gate 结算', async () => {
      resetState()
      const workspace = freshWorkspace('call')
      const adapter = makeAdapter({ env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'call' } })
      A.equal(adapter.capabilities().finishTool, 'native')
      const gate = makeGate(workspace)
      const fires = []
      const handle = await adapter.start({
        element: elementWithPrompt({ node: { model: 'claude-sonnet-4-5' } }),
        ctx: { attempt: 2, variables: { stage: 'design' } },
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: info => fires.push(info) },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.equal(exited.code, 'OK')
      A.equal(exited.reminders, 0)
      A.match(exited.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        '--session-id 显式指定 UUID（adapter 生成）')
      A.deepEqual(fires, [])
      A.equal(gate.settled(), true)
      A.deepEqual(exited.record.output, { verdict: 'pass', score: 87 })
      A.equal(exited.record.summary, 'fake claude finished')
      A.equal(handle.record.summary, 'fake claude finished')

      const [invocation] = invocations()
      A.equal(invocation.isResume, false)
      A.equal(invocation.hasStopHook, false, '默认 emulated 不注入 Stop hook')
      A.match(invocation.prompt, /为本需求写一份实施方案/, 'node.prompt 进提示词')
      A.match(invocation.prompt, /你是方案设计专员/, 'roleCard 进提示词')
      A.match(invocation.prompt, /attempt=2/)
      A.match(invocation.prompt, /"stage":"design"/)
      A.match(invocation.prompt, /BPMN 元素描述/)
      A.match(invocation.prompt, /flow_finish_node/)
      A.equal(invocation.model, 'claude-sonnet-4-5', 'element.node.model 用 --model 传给 claude')
      A.equal(invocation.permissionMode, 'acceptEdits', '默认 acceptEdits（不默认 bypassPermissions）')
      A.equal(invocation.permissionPrompts, 'none', 'probe 确认支持时传 --permission-prompts none')
      A.equal(invocation.allowedTools, 'mcp__flow_finish__flow_finish_node')
      A.ok(invocation.argv.includes('--strict-mcp-config'), '只加载本次 MCP 配置')
      A.ok(invocation.argv.includes('--output-format') && invocation.argv.includes('stream-json'))
      A.ok(invocation.argv.includes('--verbose'), 'print + stream-json 必须带 --verbose')
      A.equal(invocation.tokenInArgv, false, '凭据不进 argv')
      A.equal(invocation.tokenInPrompt, false, '凭据不进提示词')
      A.equal(invocation.tokenInMcpConfig, true, '凭据只进 0600 的 MCP 配置（受控注入）')
      A.equal(invocation.mcpConfigMode, 0o600, 'MCP 配置文件必须是 0600')
      A.equal(invocation.mcpConfig.mcpServers.flow_finish.type, 'stdio')
      A.equal(invocation.mcpConfig.mcpServers.flow_finish.command, process.execPath)
      A.ok(invocation.mcpConfig.mcpServers.flow_finish.args[0].endsWith('node-finish-mcp.js'))

      // usage：两条**不同 message.id** 的 assistant 事件 = 两次调用 = 两个 callId。
      const calls = handle.usageCalls()
      A.equal(calls.length, 2, '一个模型调用一条 callId')
      A.equal(new Set(calls.map(call => call.callId)).size, 2, 'callId 唯一')
      A.equal(calls[0].provider, 'claude')
      A.equal(calls[0].source, 'assistant')
      A.match(calls[0].callId, /^claude-message-v1:[0-9a-f]{64}$/, 'callId 是稳定 message 身份（账本契约）')
      A.deepEqual(calls[0].usage, {
        input: 10, cacheRead: 20, cacheWrite: 5, output: 30, total: 65, canonical: 1,
      }, 'Anthropic 四桶互斥：cache_creation 必须进 cacheWrite，不能丢')
      A.deepEqual(calls[1].usage, {
        input: 7, cacheRead: 11, cacheWrite: 0, output: 13, total: 31, canonical: 1,
      })
      A.equal(calls[0].provisional, true, 'assistant output 是未结算的占位观测')
      // result.usage 是**范围级结算快照**：不增加调用数、不进 usageCalls。
      const snapshots = handle.usageSnapshots()
      A.equal(snapshots.length, 1, '一次 result 一条结算快照')
      A.equal(snapshots[0].provider, 'claude')
      A.equal(snapshots[0].scope, 'invocation', '初始全新 session（显式 --session-id、非 resume）按文档契约采用 result')
      A.deepEqual(snapshots[0].usage, {
        input: 17, cacheRead: 31, cacheWrite: 5, output: 43, total: 96, canonical: 1,
      })
      A.equal(snapshots[0].provenance.realCliVerified, false, '快照如实标注真实 CLI 未验证')
      A.ok(!calls.some(call => call.usage && call.usage.output === 43), 'result 不能变成第三次调用')
      // 交给 agent-telemetry 后必须四桶互斥且不漏计缓存写入。
      const normalized = normalizeUsage(calls[0].usage, { provider: 'claude' })
      A.equal(normalized.trust, 'known')
      A.deepEqual(
        { input: normalized.usage.input, cacheRead: normalized.usage.cacheRead,
          cacheWrite: normalized.usage.cacheWrite, output: normalized.usage.output, total: normalized.usage.total },
        { input: 10, cacheRead: 20, cacheWrite: 5, output: 30, total: 65 },
        'Anthropic 四桶互斥：cache_creation 必须进 cacheWrite，不能丢',
      )

      await adapter.dispose(handle)
      A.equal(handle.cleanup.disposed, true, 'dispose 后进程组已确认消失')
      A.equal((await handle.cleanupFinal).disposed, true)
      A.deepEqual(leftoverDirs(), [], '临时 MCP 配置目录必须被清理')
      A.equal(existsSync(invocation.mcpConfigPath), false, 'MCP 配置文件已删除')
    })


    await check('A1 非交互禁用提问工具：probe 确认 --disallowedTools 时 argv 带 AskUserQuestion；不支持时不传且能力如实标注', async () => {
      resetState()
      const workspace = freshWorkspace('disallowed-tools')
      const adapter = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        reminderLimit: 0,
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'never' },
      })
      const probe = await adapter.probe()
      A.equal(probe.disallowedTools, true, 'fake --help 里确认 --disallowedTools')
      A.equal(adapter.capabilities().finishTool, 'native', '可选参数不影响工具通道')
      A.match(adapter.capabilities().evidence.nonInteractive, /--disallowedTools AskUserQuestion/,
        'capabilities evidence 必须写明提问工具被禁用')
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '禁用提问节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const [supported] = invocations()
      const flagIndex = supported.argv.indexOf('--disallowedTools')
      A.ok(flagIndex >= 0, 'argv 必须带 --disallowedTools')
      A.equal(supported.argv[flagIndex + 1], 'AskUserQuestion', '值必须是 AskUserQuestion')
      await handle.exited
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])

      // CLI 不认识该参数：probe 仍可用（不是必需参数），argv 不传，evidence 如实标未支持。
      resetState()
      const workspace2 = freshWorkspace('no-disallowed-tools')
      const adapter2 = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        reminderLimit: 0,
        env: {
          FAKE_CLAUDE_STATE_DIR: stateDir,
          FAKE_CLAUDE_MODE: 'never',
          FAKE_CLAUDE_DROP_FLAG: '--disallowedTools',
        },
      })
      const probe2 = await adapter2.probe()
      A.equal(probe2.disallowedTools, false, '--help 没有该参数时 probe 结果如实为 false')
      A.equal(adapter2.capabilities().finishTool, 'native', '可选参数缺失不影响 finishTool')
      A.match(adapter2.capabilities().evidence.nonInteractive, /未确认 --disallowedTools/,
        '不支持时 capabilities 必须如实降级标注')
      const gate2 = makeGate(workspace2)
      const handle2 = await adapter2.start({
        element: { id: 'agent-1', name: '旧 CLI 节点' },
        ctx: {},
        finishGate: gate2,
        workspaceRoot: workspace2,
        reminder: { onFire: () => {} },
      })
      const [unsupported] = invocations()
      A.ok(!unsupported.argv.includes('--disallowedTools'), 'CLI 不支持时绝不能传该参数')
      await handle2.exited
      await adapter2.dispose(handle2)
      A.deepEqual(leftoverDirs(), [])
    })


    await check('worktree 文档：documents 相对路径被 gate 校验并登记 artifacts；越界路径被拒', async () => {
      resetState()
      const workspace = freshWorkspace('doc')
      const adapter = makeAdapter({ env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'doc' } })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '写文档节点', node: { prompt: '写一份方案文档' } },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.equal(exited.record.artifacts.length, 1, 'documents 引用被登记成 artifact')
      A.equal(exited.record.artifacts[0].path, 'notes/plan.md')
      A.match(exited.record.artifacts[0].sha256, /^[0-9a-f]{64}$/)
      A.ok(exited.record.artifacts[0].bytes > 0)
      A.equal(exited.record.artifacts[0].summary, '节点产出的方案')
      A.equal(existsSync(join(workspace, 'notes', 'plan.md')), true, '文档真的写在节点工作区里')
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])

      // 越界路径：gate 与现有 adapters 用同一份校验，必须拒绝；节点最终 MISSING。
      resetState()
      const workspace2 = freshWorkspace('doc-escape')
      const adapter2 = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'doc-escape' },
        reminderLimit: 0,
      })
      const gate2 = makeGate(workspace2)
      const handle2 = await adapter2.start({
        element: { id: 'agent-1', name: '越界文档节点' },
        ctx: {},
        finishGate: gate2,
        workspaceRoot: workspace2,
        reminder: { onFire: () => {} },
      })
      const exited2 = await handle2.exited
      A.equal(exited2.ok, false, '越界 documents 不能完结节点')
      A.equal(exited2.code, 'NODE_FINISH_MISSING')
      const escape = JSON.parse(readFileSync(join(stateDir, 'doc-escape.json'), 'utf8'))
      A.equal(escape.isError, true)
      A.equal(escape.code, 'NODE_DOCUMENT_INVALID', '越界路径按 gate 的文档校验拒绝')
      await adapter2.dispose(handle2)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('只输出「完成」+ exit 0 未调工具 → 三次提醒耗尽 → NODE_FINISH_MISSING；迟到 submit 被拒', async () => {
      resetState()
      const workspace = freshWorkspace('never')
      const adapter = makeAdapter({ env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'never' } })
      const gate = makeGate(workspace)
      const fires = []
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '不调工具节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: info => fires.push(info.count) },
      })
      const exited = await handle.exited
      A.equal(exited.ok, false, JSON.stringify(exited))
      A.equal(exited.code, 'NODE_FINISH_MISSING')
      A.equal(exited.reminders, 3, '默认三次提醒')
      A.deepEqual(fires, [1, 2, 3], '提醒恰好三次（单一层）')
      A.equal(gate.settled(), true, 'MISSING 之后闸门必须已 abort')
      await A.rejects(gate.result, error => {
        A.equal(error?.code, 'NODE_FINISH_ABORTED')
        return true
      })
      await A.rejects(
        gate.submit({ variables: {}, documents: [], summary: 'late' }),
        error => {
          A.equal(error?.code, 'NODE_ALREADY_SETTLED', '迟到 submit 必须被拒绝')
          return true
        },
      )
      const all = invocations()
      A.equal(all.length, 4, '初始 1 次 + 三次 resume')
      A.ok(all.slice(1).every(invocation => invocation.isResume === true), '后续都是 --resume')
      A.ok(all.slice(1).every(invocation => invocation.resumeId === exited.sessionId),
        'resume 用同一 session id')
      A.ok(all.slice(1).every(invocation => invocation.hasStopHook === false), 'resume 路径不注入 Stop hook')
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('A2 只有 assistant authentication_failed + exit 0（无 result）→ CLAUDE_PROVIDER_ERROR、0 提醒；干净停下仍是 MISSING', async () => {
      const { adapter, handle, gate, exited } = await runClaudeMode('auth-fail-exit0')
      A.equal(exited.ok, false)
      A.equal(exited.code, CLAUDE_PROVIDER_ERROR_CODE,
        'assistant 报认证失败是 provider 错误，不是「agent 停下没调工具」')
      A.equal(exited.reminders, 0, 'provider 错误不消耗提醒预算')
      A.equal(exited.error?.code, 'cli-assistant-error')
      A.equal(exited.error?.subtype, 'authentication_failed', 'reason 必须保留 authentication_failed')
      A.match(exited.message, /authentication_failed/)
      A.equal(invocations().length, 1, '不提醒 / 不续跑')
      A.equal(gate.settled(), true)
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])

      // 对照：没有任何错误的「停下但没调工具」仍然 MISSING + 提醒预算（不许合并两个分支）。
      resetState()
      const workspace = freshWorkspace('clean-stop')
      const adapter2 = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'never' },
        reminderLimit: 1,
      })
      const gate2 = makeGate(workspace)
      const fires = []
      const handle2 = await adapter2.start({
        element: { id: 'agent-1', name: '干净停下节点' },
        ctx: {},
        finishGate: gate2,
        workspaceRoot: workspace,
        reminder: { onFire: info => fires.push(info.count) },
      })
      const exited2 = await handle2.exited
      A.equal(exited2.code, 'NODE_FINISH_MISSING', '干净停下必须仍是 MISSING')
      A.equal(exited2.reminders, 1, '干净停下仍消耗提醒预算')
      A.deepEqual(fires, [1])
      await adapter2.dispose(handle2)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('A2 残余：assistant 瞬时错误不能跨 invocation 复用（续跑干净退出仍是 MISSING）', async () => {
      const { adapter, handle, exited } = await runClaudeMode('stale-assistant-error', {
        overrides: { reminderLimit: 1 },
      })
      A.equal(exited.code, 'NODE_FINISH_MISSING',
        '初始轮 result 成功、续跑轮无错误 → MISSING（不能复用上一轮的 assistant 错误）')
      A.equal(exited.reminders, 1, '干净停下仍消耗这一轮提醒预算')
      A.equal(invocations().length, 2, '初始 + 一次 resume')
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('MAJOR-1：9 MiB 合法终态 result 事件必须通过（适配器实际行界 32 MiB，不是 8 MiB）', async () => {
      const { adapter, handle, exited } = await runClaudeMode('big-result', {
        overrides: { reminderLimit: 0 },
      })
      A.equal(handle.diagnostics.droppedLines, 0,
        '9 MiB 合法行不能被整行丢弃（基线：droppedLines=1）')
      A.equal(handle.diagnostics.outputIncomplete, false)
      A.equal(exited.code, CLAUDE_PROVIDER_ERROR_CODE,
        'result 被读到 → provider 错误；基线被丢弃 → NODE_FINISH_MISSING')
      A.equal(exited.error?.code, 'authentication_failed')
      A.equal(exited.error?.subtype, 'error_during_execution')
      A.equal(exited.reminders, 0, 'provider 错误不消耗提醒预算')
      A.equal(invocations().length, 1, '不提醒 / 不续跑')
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('MAJOR-3：result 存在即不是 assistant-only 失败（无 subtype 也不能误判 provider 错误）', async () => {
      const { adapter, handle, exited } = await runClaudeMode('result-no-subtype', {
        overrides: { reminderLimit: 0 },
      })
      A.equal(exited.ok, false)
      A.equal(exited.code, 'NODE_FINISH_MISSING',
        '有 result（无 subtype）→ 正常停下路径；旧实现按「无字符串 subtype = 无 result」误判 CLAUDE_PROVIDER_ERROR')
      A.notEqual(exited.code, CLAUDE_PROVIDER_ERROR_CODE)
      A.equal(exited.reminders, 0)
      A.equal(exited.error, undefined, 'assistant 错误 + 真实 result 不能当成终态 provider 错误')
      A.equal(invocations().length, 1, '预算 0 → 不续跑')
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('MAJOR-1：probe 的 --help reader 同样按 32 MiB 收行（9 MiB 单行里的必需参数不能丢）', async () => {
      resetState()
      const adapter = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_HELP_HUGE: '1' },
      })
      const probe = await adapter.probe()
      A.equal(probe.flags.allowedTools, '--allowedTools',
        '9 MiB help 行里的 --allowedTools 必须被读到；基线：整行丢弃 → PROBE_INVALID(cli-flags-missing)')
      A.equal(probe.flags.print, true)
    })

    await check('Native Stop hook：提醒一次后调用工具 → 成功；hook 用尽 → MISSING 且只有一个进程', async () => {
      resetState()
      const workspace = freshWorkspace('hook-once')
      const adapter = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'hook-once' },
        stopHook: 'native',
      })
      A.equal(adapter.capabilities().hooks['turn.stop'], 'native')
      const gate = makeGate(workspace)
      const fires = []
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '提醒节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: info => fires.push(info) },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.equal(exited.reminders, 1, '恰好一次提醒')
      A.equal(fires.length, 1)
      A.equal(fires[0].maxFires, 3)
      A.equal(gate.settled(), true)
      const hookRuns = readdirSync(join(stateDir, 'hooks'))
        .map(name => JSON.parse(readFileSync(join(stateDir, 'hooks', name), 'utf8')))
      A.ok(hookRuns.some(run => run.stdout && run.stdout.decision === 'block'), 'Stop hook 返回 block')
      const reminder = hookRuns.find(run => run.stdout && run.stdout.decision === 'block')
      A.match(reminder.stdout.reason, /flow_finish_node/)
      A.match(reminder.stdout.reason, /必须调用工具/)
      A.equal(invocations().length, 1, 'native hook 路径不重启进程')
      await adapter.dispose(handle)

      // hook 一直不调工具：通道的 maxReminders=3 耗尽后不再 block，最终 MISSING。
      resetState()
      const workspace2 = freshWorkspace('hook-never')
      const adapter2 = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'hook-never' },
        stopHook: 'native',
      })
      const gate2 = makeGate(workspace2)
      const fires2 = []
      const handle2 = await adapter2.start({
        element: { id: 'agent-1', name: '不调工具节点' },
        ctx: {},
        finishGate: gate2,
        workspaceRoot: workspace2,
        reminder: { onFire: info => fires2.push(info.count) },
      })
      const exited2 = await handle2.exited
      A.equal(exited2.ok, false)
      A.equal(exited2.code, 'NODE_FINISH_MISSING')
      A.equal(exited2.reminders, 3, 'hook 与 resume 共用同一个三次预算')
      A.deepEqual(fires2, [1, 2, 3])
      A.equal(invocations().length, 1, '预算耗尽后不再起 resume')
      await adapter2.dispose(handle2)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('emulated：resume 提醒一次后成功；resume 也 pin 模型 / 权限 / MCP', async () => {
      resetState()
      const workspace = freshWorkspace('resume')
      const adapter = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'call-on-resume' },
      })
      A.equal(adapter.capabilities().hooks['turn.stop'], 'emulated')
      const gate = makeGate(workspace)
      const fires = []
      const handle = await adapter.start({
        element: { id: 'agent-1', name: 'resume 节点', node: { model: 'claude-sonnet-4-5' } },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: info => fires.push(info.count) },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.equal(exited.reminders, 1)
      A.deepEqual(fires, [1])
      const all = invocations()
      A.equal(all.length, 2, '第一次退出 + 一次 resume')
      A.equal(all[1].isResume, true)
      A.equal(all[1].resumeId, exited.sessionId, 'resume 用同一 session id')
      A.equal(all[1].model, 'claude-sonnet-4-5')
      A.equal(all[1].permissionMode, 'acceptEdits')
      A.equal(all[1].hasStopHook, false)
      A.match(all[1].prompt, /flow_finish_node/)
      A.equal(all[1].mcpConfigPath, all[0].mcpConfigPath, '续跑复用同一份 MCP 配置')
      // 两次进程的 assistant usage 都要保留，callId 不重复。
      const calls = handle.usageCalls()
      A.equal(calls.length, 2)
      A.equal(new Set(calls.map(call => call.callId)).size, 2)
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('m3：已传 --session-id 但 CLI 没发 init/session_id 时，resume 仍用该 UUID 续跑', async () => {
      resetState()
      const workspace = freshWorkspace('no-init-resume')
      const adapter = makeAdapter({
        env: {
          FAKE_CLAUDE_STATE_DIR: stateDir,
          FAKE_CLAUDE_MODE: 'call-on-resume',
          // 模拟 CLI 不输出 init：没有 session_id 事件，只有我们显式传的 --session-id。
          FAKE_CLAUDE_SKIP_INIT: '1',
        },
      })
      const gate = makeGate(workspace)
      const fires = []
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '无 init 续跑节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: info => fires.push(info.count) },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.equal(exited.reminders, 1, '缺 init 也要真的提醒一次')
      A.deepEqual(fires, [1])
      const all = invocations()
      A.equal(all.length, 2, '第一次退出 + 一次 resume')
      A.equal(all[1].isResume, true, 'resume 必须真的带 --resume')
      const hint = all[0].sessionIdArg
      A.equal(typeof hint, 'string', '初始进程必须显式传过 --session-id')
      A.equal(all[1].resumeId, hint, 'resume 用初始进程传入的同一个 UUID')
      A.equal(exited.sessionId, hint, '对外 sessionId 回落到显式 hint（不是编造的新值）')
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('重复提交 → 第二次 NODE_ALREADY_FINISHED，gate 只结算一次', async () => {
      resetState()
      const workspace = freshWorkspace('dup')
      const adapter = makeAdapter({ env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'dup' } })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '重复提交节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.equal(exited.record.summary, '第一次', '只认第一次提交')
      A.equal(await waitForFile(join(stateDir, 'dup.json')), true)
      const dup = JSON.parse(readFileSync(join(stateDir, 'dup.json'), 'utf8'))
      A.equal(dup.firstError, false)
      A.equal(dup.secondError, true, '第二次提交必须报错')
      A.equal(dup.secondCode, 'NODE_ALREADY_FINISHED')
      A.equal(gate.settled(), true)
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('跨 execution 凭据 → 通道拒绝；gate 不结算，节点按通道失败收口', async () => {
      resetState()
      const workspace = freshWorkspace('foreign')
      const adapter = makeAdapter({ env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'foreign-token' } })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '跨 execution 节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(await waitForFile(join(stateDir, 'foreign.json')), true)
      const response = JSON.parse(readFileSync(join(stateDir, 'foreign.json'), 'utf8'))
      A.equal(response?.ok, false, '外来凭据不能提交')
      A.equal(response?.error?.code, 'NODE_FINISH_CHANNEL_FAILED')
      A.equal(gate.settled(), true, '通道被拒后闸门必须 abort')
      await A.rejects(gate.result, error => {
        A.equal(error?.code, 'NODE_FINISH_ABORTED')
        return true
      })
      A.equal(exited.ok, false)
      A.equal(exited.code, 'NODE_FINISH_CHANNEL_FAILED')
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('取消：杀 claude + MCP 进程树、清理临时配置；取消后迟到提交被拒；已观测 usage 保留', async () => {
      resetState()
      const workspace = freshWorkspace('cancel')
      const adapter = makeAdapter({ env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'usage-then-hang' } })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '长任务节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const claudePid = handle.pid
      A.equal(typeof claudePid, 'number')
      A.equal(await waitForFile(join(stateDir, 'mcp.pid')), true, '假 claude 已拉起 MCP server')
      const mcpPid = Number(readFileSync(join(stateDir, 'mcp.pid'), 'utf8'))
      A.equal(Number.isSafeInteger(mcpPid) && mcpPid > 0, true)
      A.equal(pidAlive(claudePid), true)
      A.equal(pidAlive(mcpPid), true)
      // 假 CLI 写出 usage 行与适配器解析之间隔着一拍：满量程串行跑套件时，这里
      // 直接断言会偶发「解析还没轮到」。有界轮询到事件真的被观测到，断言不变。
      for (let waited = 0; waited < 2000 && handle.usageCalls().length === 0; waited += 10) {
        await new Promise(resolveWait => setTimeout(resolveWait, 10))
      }
      A.equal(handle.usageCalls().length, 1, '取消前已观测到一次 usage')

      await adapter.cancel(handle, 'test-cancel')
      const exited = await handle.exited
      A.equal(exited.ok, false)
      A.equal(exited.code, 'NODE_FINISH_CANCELED')
      A.equal(gate.settled(), true, '取消必须 abort 闸门')
      await A.rejects(gate.result, error => {
        A.equal(error?.code, 'NODE_FINISH_ABORTED')
        return true
      })
      await A.rejects(
        gate.submit({ variables: {}, documents: [], summary: 'late' }),
        error => {
          A.equal(error?.code, 'NODE_ALREADY_SETTLED', '取消后迟到提交必须被拒绝')
          return true
        },
      )
      A.equal(handle.usageCalls().length, 1, '取消后仍保留已观测 usage')
      A.equal(await waitForDead(claudePid), true, `claude ${claudePid} 应已退出`)
      A.equal(await waitForDead(mcpPid), true, `MCP server ${mcpPid} 应已退出`)
      const [invocation] = invocations()
      A.equal(existsSync(invocation.mcpConfigPath), true, 'dispose 前临时 MCP 配置仍在（生命周期归 adapter）')
      await adapter.dispose(handle)
      A.equal(existsSync(invocation.mcpConfigPath), false, 'dispose 后临时 MCP 配置被清掉')
      A.equal(existsSync(dirname(invocation.mcpConfigPath)), false, '临时配置目录整体消失')
      A.deepEqual(leftoverDirs(), [])
    })

    await check('超时（runAgentNode）：失败码 + agent/usage 事件 + 进程树/临时目录清理', async () => {
      resetState()
      const workspace = freshWorkspace('timeout')
      const adapter = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'usage-then-hang' },
      })
      let failure = null
      try {
        await runAgentNode({
          element: { id: 'agent-1', name: '超时节点' },
          ctx: {},
          adapter,
          workspaceRoot: workspace,
          timeoutMs: 1_500,
          cancelGraceMs: 4_000,
          log: () => {},
        })
      } catch (error) {
        failure = error
      }
      A.ok(failure, '超时必须失败')
      A.equal(failure.code, 'BPMN_ACTIVITY_TIMEOUT')
      const usageEvents = Array.isArray(failure.events)
        ? failure.events.filter(event => event && event.type === 'agent/usage')
        : []
      A.equal(usageEvents.length, 1, '超时仍要把已观测 usage 落到事件账本')
      A.equal(usageEvents[0].provider, 'claude')
      A.equal(usageEvents[0].usage.output, 30)
      const [invocation] = invocations()
      A.ok(invocation, '假 claude 已启动')
      A.equal(await waitForDead(invocation.pid), true, '超时后 claude 进程已退出')
      A.equal(existsSync(invocation.mcpConfigPath), false, '超时后临时 MCP 配置目录已清理')
      A.deepEqual(leftoverDirs(), [])
    })

    await check('凭据 / socket 不进 handle.events / lastMessage / stdout / stderr', async () => {
      resetState()
      const workspace = freshWorkspace('leak')
      const adapter = makeAdapter({ env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'leak' } })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '泄漏节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      const [invocation] = invocations()
      A.ok(typeof invocation.token === 'string' && invocation.token.length > 0)
      const eventsText = JSON.stringify(handle.events)
      A.equal(eventsText.includes(invocation.token), false, 'events 里不能出现凭据')
      A.equal(eventsText.includes('fs-claude-'), false, 'events 里不能出现 runDir 路径')
      A.match(eventsText, /\[redacted\]/i, 'events 确实执行了脱敏')
      A.ok(eventsText.includes('password='), 'events 应包含 agent_message 正文（否则下一条断言是空的）')
      A.equal(eventsText.includes('hunter2'), false, 'events 里的赋值型秘密必须走共享文本规则抹掉')
      A.equal(String(handle.lastMessage).includes(invocation.token), false, 'lastMessage 不能泄漏')
      A.match(String(handle.lastMessage), /\[redacted\]/i)
      A.equal(String(handle.stdoutTail).includes(invocation.token), false)
      A.equal(String(handle.stderrTail).includes(invocation.token), false)
      await adapter.dispose(handle)
    })

    await check('pre-abort 零派发；坏 gate 抛 ADAPTER_INVALID 且不建临时目录', async () => {
      resetState()
      const workspace = freshWorkspace('abort-gate')
      const adapter = makeAdapter({ env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'call' } })
      const controller = new AbortController()
      controller.abort()
      const before = leftoverDirs()
      await A.rejects(
        adapter.start({
          element: { id: 'agent-1', name: '预取消节点' },
          ctx: { signal: controller.signal },
          finishGate: makeGate(workspace),
          workspaceRoot: workspace,
        }),
        error => {
          A.equal(error?.code, 'NODE_FINISH_CANCELED')
          A.equal(error?.details?.reason, 'pre-aborted')
          return true
        },
      )
      A.equal(invocations().length, 0, '预 abort 不能 spawn claude')
      A.deepEqual(leftoverDirs(), before)

      const minimalGate = { submit: async () => ({}), settled: () => false }
      await A.rejects(
        adapter.start({
          element: { id: 'agent-1', name: '坏 gate 节点' },
          ctx: {},
          finishGate: minimalGate,
          workspaceRoot: workspace,
        }),
        error => {
          A.equal(error?.name, 'ClaudeAdapterError')
          A.equal(error?.code, ADAPTER_ERROR.INVALID)
          A.equal(error?.details?.reason, 'missing-gate')
          A.deepEqual([...error.details.missing].sort(), ['abort', 'result'])
          return true
        },
      )
      A.deepEqual(leftoverDirs(), before, '校验失败不能泄漏 runDir')
      A.equal(invocations().length, 0)
    })

    await check('MCP 握手失败（CLI 没拉起 server）→ NODE_FINISH_TOOL_UNAVAILABLE 且物理清理完成', async () => {
      resetState()
      const workspace = freshWorkspace('no-mcp')
      const adapter = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'no-mcp-stubborn' },
        helloTimeoutMs: 400,
        killTimeoutMs: 150,
      })
      const gate = makeGate(workspace)
      let failure = null
      try {
        await adapter.start({
          element: { id: 'agent-1', name: '握手失败节点' },
          ctx: {},
          finishGate: gate,
          workspaceRoot: workspace,
          reminder: { onFire: () => {} },
        })
      } catch (error) {
        failure = error
      }
      A.ok(failure, 'start 必须失败')
      A.equal(failure.code, 'NODE_FINISH_TOOL_UNAVAILABLE')
      A.equal(failure.details.reason, 'mcp-handshake-timeout')
      A.equal(await waitForFile(join(stateDir, 'stubborn.pid')), true)
      const pid = Number(readFileSync(join(stateDir, 'stubborn.pid'), 'utf8'))
      A.equal(pidAlive(pid), false, 'start 抛错时忽略 SIGTERM 的进程也必须已物理退出')
      A.ok(failure.cleanup && typeof failure.cleanup === 'object')
      A.equal(failure.cleanup.disposed, true)
      A.equal((await failure.cleanupFinal).disposed, true)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('admission 走真实 probe → capabilities；失败时零派发', async () => {
      resetState()
      const adapter = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        env: { FAKE_CLAUDE_STATE_DIR: stateDir },
      })
      const probe = await adapter.probe()
      A.equal(probe.version, '2.1.309')
      A.equal(adapter.capabilities().finishTool, 'native')
      A.doesNotThrow(() => assertFinishToolNative(adapter))
      const admitted = await admitAdapter(adapter, { nodeId: 'agent-1' })
      A.equal(admitted.version, '2.1.309')

      const broken = createClaudeAdapter({
        claudeBin: join(sandbox, 'no-such-claude'),
        tmpRoot: sandbox,
        selfTest: false,
      })
      await A.rejects(broken.probe(), error => {
        A.equal(error?.code, ADAPTER_ERROR.PROBE_INVALID)
        return true
      })
      A.equal(broken.capabilities().finishTool, 'unsupported')
      A.throws(
        () => assertFinishToolNative(broken),
        error => {
          A.equal(error?.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE)
          return true
        },
      )
      await A.rejects(
        admitAdapter(broken, { nodeId: 'agent-1' }),
        error => {
          A.equal(error?.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE)
          return true
        },
      )
      A.equal(invocations().length, 0, 'probe 失败 → 零派发')
    })

    await check('M3 解码与分帧：UTF-8 跨块 / EOF 无尾换行 / 600 KiB 单行 / BOM+CRLF+坏行 都不丢事件', async () => {
      // (a) UTF-8 多字节字符跨 chunk：基线解码成 U+FFFD。
      {
        const { adapter, handle, exited } = await runClaudeMode('unicode')
        A.equal(exited.ok, true, JSON.stringify(exited))
        const assistantEvents = handle.events.filter(event => event.type === 'assistant')
        A.equal(assistantEvents.length, 1, '跨块的合法事件必须完整交付')
        A.equal(assistantEvents[0].message.content[0].text, '中文 🚀 结束', '基线：跨块解码出 U+FFFD 乱码')
        A.equal(JSON.stringify(handle.events).includes('\uFFFD'), false, '不得出现替换字符')
        A.equal(handle.usageCalls().length, 1)
        await adapter.dispose(handle)
        A.deepEqual(leftoverDirs(), [])
      }
      // (b) 合法 JSON 没有尾换行：EOF flush。
      {
        const { adapter, handle, exited } = await runClaudeMode('unterminated')
        A.equal(exited.ok, true, JSON.stringify(exited))
        A.equal(handle.usageCalls().length, 1, '没有尾换行的合法 JSON 不能丢（基线：0）')
        A.equal(handle.diagnostics.protocolErrors, 0)
        await adapter.dispose(handle)
      }
      // (c) 600 KiB 合法单行（按 32 KiB 分块写）：基线被裁成半截 JSON。
      {
        const { adapter, handle, exited } = await runClaudeMode('long')
        A.equal(exited.ok, true, JSON.stringify(exited))
        A.equal(handle.usageCalls().length, 1, '600 KiB 合法单行必须原样解析（基线：0）')
        A.equal(handle.diagnostics.droppedLines, 0)
        A.equal(handle.diagnostics.outputIncomplete, false)
        await adapter.dispose(handle)
      }
      // (d) BOM / CRLF / 非 JSON 行 / 空行。
      {
        const { adapter, handle, exited } = await runClaudeMode('format')
        A.equal(exited.ok, true, JSON.stringify(exited))
        A.equal(handle.usageCalls().length, 1, '坏行之后的有效行继续处理')
        A.equal(handle.diagnostics.protocolErrors, 1, '非 JSON 行必须可诊断（不是静默 continue）')
        await adapter.dispose(handle)
      }
    })

    await check('M3 每个进程独立半行缓冲：初始进程的残行不能拼到 resume 上', async () => {
      const { adapter, handle, exited } = await runClaudeMode('resume-half', {
        overrides: { reminderLimit: 1 },
      })
      A.equal(exited.ok, true, JSON.stringify(exited))
      const calls = handle.usageCalls()
      A.equal(calls.length, 1, '只有 resume 自己的 message 是一条调用（基线：初始残行被拼成第 2 条）')
      A.equal(calls[0].usage.output, 13, 'resume 事件的用量（被拼出来的那条是 output=4）')
      A.ok(handle.diagnostics.protocolErrors >= 1, '两侧残行都必须记协议错误')
      A.equal(invocations().length, 2)
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('M3 结算等 stdout 排空：父进程退出后后代写出的合法事件仍计入', async () => {
      const { adapter, handle, exited } = await runClaudeMode('late-output')
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.equal(handle.usageCalls().length, 1, '结算前必须等 stdout 排空（基线：exit 即结算 → 0）')
      A.equal(handle.diagnostics.outputDrained, true)
      A.equal(handle.diagnostics.outputIncomplete, false)
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('A3 命令行过长（E2BIG）→ 独立 CLAUDE_ARGV_TOO_LARGE + 可操作 hint + cleanup；ENOENT 仍走原错误码', async () => {
      resetState()
      const workspace = freshWorkspace('e2big')
      const adapter = makeAdapter({ env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'call' } })
      const before = leftoverDirs()
      const gate = makeGate(workspace)
      let failure = null
      try {
        await adapter.start({
          // 约 200 KB 单参数：Linux MAX_ARG_STRLEN=128 KiB → spawn 同步 E2BIG。
          element: { id: 'agent-1', name: '超长提示词节点', node: { prompt: 'x'.repeat(200_000) } },
          ctx: {},
          finishGate: gate,
          workspaceRoot: workspace,
        })
      } catch (error) {
        failure = error
      }
      A.ok(failure, '参数超限必须失败而不是只留下资源')
      A.equal(failure.code, CLAUDE_ARGV_TOO_LARGE_CODE,
        '命令行过长必须有独立错误码（基线：NODE_FINISH_TOOL_UNAVAILABLE）')
      A.equal(failure.details.reason, 'argv-too-large')
      A.equal(failure.details.cause, 'E2BIG')
      A.match(failure.message, /命令行超长/, 'message 要点明命令行超长')
      A.match(failure.message, /提示词|变量/, 'message 要指出大块输入')
      A.match(failure.details.hint, /documents/, 'hint 要给出可操作出路：改用文档')
      A.match(failure.details.hint, /缩短/, 'hint 要给出可操作出路：缩短输入')
      A.ok(!failure.message.includes('没有建立 flow_finish_node 通道'),
        '不能和「CLI 没有工具通道」混淆')
      A.deepEqual(leftoverDirs(), before, '启动失败不能残留 runDir / socket')
      A.ok(failure.cleanup && typeof failure.cleanup === 'object')
      A.equal(failure.cleanup.disposed, true, 'cleanup 必须如实报告已释放')
      A.equal(failure.cleanup.pendingResources, undefined, '资源登记表（runDir / channel / listener）无残留')
      A.equal((await failure.cleanupFinal).disposed, true)
      A.equal(gate.settled(), true, '启动失败必须 abort gate')
      A.equal(invocations().length, 0, '同步 spawn 失败 → 零派发')

      // 非回归：普通 spawn 失败（ENOENT）仍走 TOOL_UNAVAILABLE + spawn-failed，不套用 ARGV_TOO_LARGE。
      resetState()
      const workspace2 = freshWorkspace('spawn-enoent')
      const missingBin = join(sandbox, 'no-such-claude-for-spawn')
      const adapter2 = makeAdapter({
        claudeBin: missingBin,
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'call' },
      })
      const gate2 = makeGate(workspace2)
      let failure2 = null
      try {
        await adapter2.start({
          element: { id: 'agent-1', name: 'ENOENT 节点' },
          ctx: {},
          finishGate: gate2,
          workspaceRoot: workspace2,
        })
      } catch (error) {
        failure2 = error
      }
      A.ok(failure2, '不存在的可执行文件必须失败')
      A.equal(failure2.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
        '普通 spawn 失败保持 TOOL_UNAVAILABLE（不回归）')
      A.equal(failure2.details.reason, 'spawn-failed')
      A.equal(failure2.details.cause, 'ENOENT')
      A.equal(failure2.cleanup.disposed, true)
      A.deepEqual(leftoverDirs(), [], 'ENOENT 同样不能残留资源')
      A.equal(gate2.settled(), true)
      A.equal(invocations().length, 0)
    })

    await check('M5 零宽限：grace=0 只跳过等待，TERM→KILL 仍执行并完成结算', async () => {
      resetState()
      const workspace = freshWorkspace('zero-grace')
      const adapter = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'zero-grace' },
        postFinishGraceMs: 0,
        killTimeoutMs: 50,
      })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '零宽限节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const pid = handle.pid
      await gate.result
      const settled = await Promise.race([handle.exited.then(() => true), sleep(3_000).then(() => false)])
      A.equal(settled, true, '零宽限 + 忽略 TERM 的进程也必须被 KILL 后有界结算（基线：永不完成）')
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.equal(await waitForDead(pid), true, '整组已被 SIGKILL 收掉')
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('m1 并发 cancel：组长先退、忽略 TERM 的后代也必须被升级清理', async () => {
      resetState()
      const workspace = freshWorkspace('cancel-tree')
      const adapter = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'cancel-tree' },
        killTimeoutMs: 200,
      })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '进程树节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      A.equal(await waitForFile(join(stateDir, 'descendant.pid')), true, '后代进程已拉起')
      const leaderPid = handle.pid
      const descendantPid = Number(readFileSync(join(stateDir, 'descendant.pid'), 'utf8'))
      A.equal(pidAlive(leaderPid), true)
      A.equal(pidAlive(descendantPid), true)
      await Promise.all([adapter.cancel(handle, 'first'), adapter.cancel(handle, 'second')])
      A.equal(await waitForDead(leaderPid), true, '组长已退出')
      A.equal(await waitForDead(descendantPid), true, '忽略 TERM 的后代必须被 KILL（基线：仍存活）')
      A.equal(handle.cleanup.disposed, true, '整组确认消失后才报告 disposed')
      const exited = await handle.exited
      A.equal(exited.code, 'NODE_FINISH_CANCELED')
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('M6 握手后 CLI 终态错误：稳定 provider 码、0 提醒、原因透传 runner', async () => {
      const { adapter, handle, exited } = await runClaudeMode('error')
      A.equal(exited.ok, false)
      A.equal(exited.code, CLAUDE_PROVIDER_ERROR_CODE, '握手后终态错误必须是稳定 provider 错误码（基线：NODE_FINISH_MISSING）')
      A.equal(exited.reminders, 0, '终态错误不消耗提醒预算（基线：提醒 3 次）')
      A.match(exited.message, /authentication_failed/, '真实原因不能丢')
      A.match(exited.message, /error_during_execution/)
      A.match(String(handle.lastMessage), /401 invalid credential/)
      A.equal(invocations().length, 1, '终态错误之后不再起 resume 进程')
      A.deepEqual(
        { protocolErrors: handle.diagnostics.protocolErrors, outputIncomplete: handle.diagnostics.outputIncomplete },
        { protocolErrors: 0, outputIncomplete: false },
      )
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])

      // 经 runner：错误码与原因透传，reminders=0，实例状态不新增 failed（runtime 写 lastError）。
      resetState()
      const runnerWorkspace = freshWorkspace('provider-error-runner')
      const runnerAdapter = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'error' },
      })
      let failure = null
      try {
        await runAgentNode({
          element: { id: 'agent-1', name: '认证失败节点' },
          ctx: {},
          adapter: runnerAdapter,
          workspaceRoot: runnerWorkspace,
          log: () => {},
        })
      } catch (error) {
        failure = error
      }
      A.ok(failure, 'runner 必须失败')
      A.equal(failure.code, CLAUDE_PROVIDER_ERROR_CODE, '错误码透传到 agent-execute')
      A.match(failure.message, /authentication_failed/, 'runner 侧仍能看到脱敏后的真实原因')
      A.equal(failure.reminders, 0, '不得消耗提醒预算')
      A.equal(invocations().length, 1, 'runner 也不再续跑')
    })

    await check('M6 握手前退出（提醒预算 0）：TOOL_UNAVAILABLE 带原原因，不是 ABORTED', async () => {
      resetState()
      const workspace = freshWorkspace('early-error')
      const adapter = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'early-error' },
        reminderLimit: 0,
        helloTimeoutMs: 5_000,
      })
      const gate = makeGate(workspace)
      let failure = null
      try {
        await adapter.start({
          element: { id: 'agent-1', name: '握手前退出节点' },
          ctx: {},
          finishGate: gate,
          workspaceRoot: workspace,
          reminder: { onFire: () => {} },
        })
      } catch (error) {
        failure = error
      }
      A.ok(failure, 'start 必须失败')
      A.equal(failure.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
        '握手前失败 → TOOL_UNAVAILABLE（基线：旧代码先 abort gate，最终报 NODE_FINISH_ABORTED）')
      A.equal(failure.details.reason, 'exited-before-handshake')
      A.equal(failure.details.cause, 'EXIT_1')
      A.equal(failure.details.cliError?.code, 'authentication_failed', '原原因（脱敏后）必须保留')
      A.match(failure.message, /握手前退出/)
      A.equal(failure.cleanup.disposed, true)
      A.equal((await failure.cleanupFinal).disposed, true)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('M6 残余 a：CLI 被 SIGKILL → CLAUDE_PROVIDER_ERROR、0 提醒（不再 MISSING）', async () => {
      resetState()
      const workspace = freshWorkspace('sigkill')
      const adapter = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'sleep' },
      })
      const gate = makeGate(workspace)
      const fires = []
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '被 KILL 的节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: info => fires.push(info.count) },
      })
      A.equal(typeof handle.pid, 'number', '假 claude 已启动（MCP 已握手）')
      process.kill(handle.pid, 'SIGKILL')
      const exited = await handle.exited
      A.equal(exited.ok, false)
      A.equal(exited.code, CLAUDE_PROVIDER_ERROR_CODE,
        '信号终止是终态执行错误，不是「没调用 finish」（基线：提醒 1 次后 NODE_FINISH_MISSING）')
      A.equal(exited.reminders, 0, '死掉的 CLI 不该被提醒 / 续跑')
      A.deepEqual(fires, [], '不触发任何提醒')
      A.equal(exited.error?.code, 'cli-signaled', '原因如实标注信号退出')
      A.match(String(exited.error?.message), /SIGKILL/)
      A.equal(gate.settled(), true, '终态错误必须 abort 闸门')
      A.equal(invocations().length, 1, '信号退出后不再起 resume 进程')
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('M6 残余 b：闸门已受理后的迟到 cancel 不能覆盖成功结果', async () => {
      resetState()
      const workspace = freshWorkspace('late-cancel')
      const adapter = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'zero-grace' },
        // 宽限期拉长：cancel 一定发生在进程自然结束之前，业务结果已经被受理。
        postFinishGraceMs: 60_000,
        killTimeoutMs: 300,
      })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '迟到取消节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const record = await gate.result
      A.equal(record?.summary, 'zero-grace', '闸门已受理成功')
      // 迟到的 cancel：只负责清理进程，不得把业务结果改写成 CANCELED。
      await adapter.cancel(handle, 'late-cancel')
      const exited = await handle.exited
      A.equal(exited.ok, true, '已受理的成功结果优先于迟到 cancel（基线：NODE_FINISH_CANCELED）')
      A.equal(exited.code, 'OK')
      A.equal(exited.record?.summary, record.summary)
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('m3 残余：probe 不支持 --session-id 时不返回没传给 CLI 的 UUID', async () => {
      resetState()
      const workspace = freshWorkspace('no-session-id')
      // 不用注入的 probeResult：必须走**真实 probe** 才能反映 --help 里没有 --session-id。
      const adapter = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        reminderLimit: 1,
        env: {
          FAKE_CLAUDE_STATE_DIR: stateDir,
          FAKE_CLAUDE_MODE: 'never',
          // probe 的 --help 里没有 --session-id，且 CLI 自己也从不报 session_id。
          FAKE_CLAUDE_DROP_FLAG: '--session-id',
          FAKE_CLAUDE_SKIP_INIT: '1',
          FAKE_CLAUDE_OMIT_SESSION: '1',
        },
      })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '无 session-id 节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      const [invocation] = invocations()
      A.equal(invocation.sessionIdArg, null, '初始进程没有传 --session-id')
      A.equal(handle.sessionId, undefined,
        'handle.sessionId 不能返回一个从未传给 CLI 的随机 UUID（基线：返回 UUID）')
      A.equal(exited.sessionId, undefined, 'exited.sessionId 同理')
      A.equal(exited.reminders, 0, '没有确实可续跑的 session id 时不假装续跑')
      A.equal(exited.code, 'NODE_FINISH_MISSING')
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('F2 终态错误脱敏与长度：code/subtype/message 分别藏秘密，全部抹掉且 ≤1000 字节', async () => {
      const { adapter, handle, exited } = await runClaudeMode('secret-error')
      A.equal(exited.code, CLAUDE_PROVIDER_ERROR_CODE)
      const [invocation] = invocations()
      const secretToken = invocation.token
      const fakeBearerSecret = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'
      const skSecret = `sk-${'Q'.repeat(64)}`
      A.ok(secretToken.length > 0)
      const json = JSON.stringify(exited)
      A.equal(json.includes(secretToken), false,
        '本执行凭据藏在 errors[0] / subtype / result 任一处都必须脱敏（基线：code/subtype 泄漏）')
      A.equal(json.includes(fakeBearerSecret), false, 'Bearer 秘密必须被共享脱敏规则抹掉')
      A.equal(json.includes(skSecret), false, 'sk- 开头的 API key 必须被抹掉')
      A.ok(Buffer.byteLength(String(exited.message), 'utf8') <= 1_000, '终态错误 message ≤1000 字节')
      A.ok(Buffer.byteLength(String(exited.error?.code ?? ''), 'utf8') <= 1_000, 'code 有界')
      A.ok(Buffer.byteLength(String(exited.error?.subtype ?? ''), 'utf8') <= 1_000, 'subtype 有界')
      const diagnostic = handle.diagnostics.terminalError
      A.equal(JSON.stringify(diagnostic).includes(secretToken), false, 'diagnostics.terminalError 同样脱敏')
      A.ok(Buffer.byteLength(String(diagnostic?.message ?? ''), 'utf8') <= 1_000)
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('M2 残余：start 握手前失败也把已观测 usage 挂到失败载体（executor 可读）', async () => {
      resetState()
      const workspace = freshWorkspace('usage-before-handshake')
      const adapter = makeAdapter({
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'usage-then-no-mcp' },
        helloTimeoutMs: 400,
      })
      const gate = makeGate(workspace)
      let failure = null
      try {
        await adapter.start({
          element: { id: 'agent-1', name: '握手前失败但已用量的节点' },
          ctx: {},
          finishGate: gate,
          workspaceRoot: workspace,
        })
      } catch (error) {
        failure = error
      }
      A.ok(failure, 'start 必须失败')
      A.equal(failure.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE)
      A.equal(failure.details.reason, 'mcp-handshake-timeout')
      A.ok(Array.isArray(failure.usageCalls), '失败载体必须带 usageCalls（基线：丢失）')
      A.equal(failure.usageCalls.length, 1)
      A.equal(failure.usageCalls[0].usage.output, 30)
      A.ok(Array.isArray(failure.usageSnapshots), '失败载体必须带 usageSnapshots（基线：丢失）')
      A.equal(failure.usageSnapshots.length, 1)
      // executor 收尾用的就是这两个读取器（与 handle 同一份契约）。
      A.equal(readAdapterUsageCalls(failure, 'claude').length, 1,
        'executor 用同一读取器能从失败载体拿到已观测调用')
      A.equal(readAdapterUsageSnapshots(failure, 'claude').length, 1)
      A.equal(failure.cleanup.disposed, true, '带上用量不影响启动失败清理')
      A.deepEqual(leftoverDirs(), [])
    })

    await check('m4 参数要求表：逐个删必需 flag → probe 拒绝、start 零派发；argv 用探测到的别名', async () => {
      for (const flag of ['--verbose', '--strict-mcp-config', '--permission-mode', '--allowedTools', '--mcp-config', '--resume']) {
        const adapter = createClaudeAdapter({
          claudeBin: fakeBin,
          tmpRoot: sandbox,
          selfTest: false,
          env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_DROP_FLAG: flag },
        })
        await A.rejects(adapter.probe(), error => {
          A.equal(error?.code, ADAPTER_ERROR.PROBE_INVALID, `${flag} 缺失 → probe 拒绝`)
          A.equal(error?.details?.reason, 'cli-flags-missing')
          A.ok(Array.isArray(error?.details?.missing) && error.details.missing.length >= 1)
          return true
        })
        A.equal(adapter.capabilities().finishTool, 'unsupported', `${flag} 缺失不能声明 native`)
      }

      // start：注入的 probeResult 缺 flag → TOOL_UNAVAILABLE 且零派发、零资源。
      resetState()
      const workspace = freshWorkspace('flags-missing')
      const before = leftoverDirs()
      const missing = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        probeResult: { ...FAKE_PROBE, flags: { ...FAKE_FLAGS, verbose: false } },
      })
      A.equal(missing.capabilities().finishTool, 'unsupported', '缺 --verbose 不再声明 native')
      A.match(missing.capabilities().evidence.parameters, /--verbose/, '参数证据必须指出缺了什么')
      let failure = null
      try {
        await missing.start({
          element: { id: 'agent-1' },
          ctx: {},
          finishGate: makeGate(workspace),
          workspaceRoot: workspace,
        })
      } catch (error) {
        failure = error
      }
      A.equal(failure?.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE)
      A.equal(failure?.details?.reason, 'cli-flags-missing')
      A.deepEqual(failure?.details?.missing, ['verbose'])
      A.equal(invocations().length, 0, '缺参数 → 零派发')
      A.deepEqual(leftoverDirs(), before, '零派发不建 runDir')

      // 别名：help 只给 --allowed-tools 时 argv 必须用该别名，其余必需参数照常拼上。
      resetState()
      const aliasWorkspace = freshWorkspace('flags-alias')
      const aliasAdapter = createClaudeAdapter({
        claudeBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        env: { FAKE_CLAUDE_STATE_DIR: stateDir, FAKE_CLAUDE_MODE: 'call', FAKE_CLAUDE_HELP_ALIAS: '1' },
      })
      const aliasProbe = await aliasAdapter.probe()
      A.equal(aliasProbe.allowedToolsFlag, '--allowed-tools', 'probe 记录实际识别到的别名')
      const aliasGate = makeGate(aliasWorkspace)
      const aliasHandle = await aliasAdapter.start({
        element: elementWithPrompt({ id: 'agent-1' }),
        ctx: {},
        finishGate: aliasGate,
        workspaceRoot: aliasWorkspace,
      })
      const aliasExited = await aliasHandle.exited
      A.equal(aliasExited.ok, true, JSON.stringify(aliasExited))
      const [aliasInvocation] = invocations()
      A.ok(aliasInvocation.argv.includes('--allowed-tools'), 'argv 使用探测到的别名（基线：拼 --allowedTools）')
      A.equal(aliasInvocation.allowedTools, 'mcp__flow_finish__flow_finish_node')
      A.ok(aliasInvocation.argv.includes('--verbose'))
      A.ok(aliasInvocation.argv.includes('--strict-mcp-config'))
      A.ok(aliasInvocation.argv.includes('--permission-mode'))
      await aliasAdapter.dispose(aliasHandle)
    })

    await check('M1/M2 接线：同 message.id 去重；result 是结算快照；指标链 assistant(10/1)+result(10/30)=40', async () => {
      const { adapter, handle, exited } = await runClaudeMode('placeholder')
      A.equal(exited.ok, true, JSON.stringify(exited))
      const calls = handle.usageCalls()
      A.equal(calls.length, 1, '一条 message 一条调用')
      A.equal(calls[0].usage.output, 1, 'assistant output 是未结算的占位观测')
      const snapshots = handle.usageSnapshots()
      A.equal(snapshots.length, 1, 'result 是结算快照，不是第二次调用')
      A.equal(snapshots[0].scope, 'invocation')
      A.equal(snapshots[0].usage.output, 30)
      const metrics = metricsForHandle(handle)
      A.equal(metrics.agent.modelCalls, 1, 'result 不增加模型调用数')
      A.deepEqual(
        {
          input: metrics.agent.observedTokens.input,
          cacheRead: metrics.agent.observedTokens.cacheRead,
          cacheWrite: metrics.agent.observedTokens.cacheWrite,
          output: metrics.agent.observedTokens.output,
          total: metrics.agent.observedTokens.total,
        },
        { input: 10, cacheRead: 0, cacheWrite: 0, output: 30, total: 40 },
        '结算快照覆盖占位 output（基线：沿用 1，总量 11）',
      )
      A.deepEqual(metrics.agent.usageCoverage, { known: 1, partial: 0, unknown: 0 })
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('M1 接线：同一 message.id 的并行工具块在适配器侧也只计一次', async () => {
      const { adapter, handle, exited } = await runClaudeMode('dup-id')
      A.equal(exited.ok, true, JSON.stringify(exited))
      const calls = handle.usageCalls()
      A.equal(calls.length, 2, '两个 message.id = 两次模型响应（基线：3 条，同 ID 被重复计数）')
      const shared = calls.find(call => call.usage.output === 9)
      A.ok(shared, '同一 message 的第二次上报覆盖第一次（output 1 → 9，不是相加）')
      A.equal(shared.usage.cacheWrite, 5, '第二次上报的桶替换旧值')
      await adapter.dispose(handle)
    })

    await check('M2 result-only 两轮：invocation 与 unknown 两种快照作用域（不猜 sum/max）', async () => {
      const { adapter, handle, exited } = await runClaudeMode('result-only', {
        overrides: { reminderLimit: 1 },
      })
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.deepEqual(handle.usageCalls(), [], '没有 assistant usage 就没有调用记录')
      const snapshots = handle.usageSnapshots()
      A.equal(snapshots.length, 2, '两轮 result 各一份快照')
      A.deepEqual(snapshots.map(snapshot => snapshot.scope).sort(), ['invocation', 'unknown'],
        '初始 invocation 可结算；resume 后范围不可证明 → unknown（resumed 必须如实传）')
      const metrics = metricsForHandle(handle)
      A.equal(metrics.agent.modelCalls, null, '没有调用身份就不伪造确定调用数（不是 0）')
      A.equal(metrics.agent.snapshots.unknown, 1)
      A.equal(metrics.agent.observedTokens.total, null, 'unknown 范围不能给出确定总量')
      A.equal(metrics.agent.observedTokens.partial, true)
      await adapter.dispose(handle)
    })

    await check('m6 CLI 发现：CLAUDE_BIN 优先、PATH 搜索并校验可执行；smoke 不把 PATH-only 当 skipped', async () => {
      const binDir = join(sandbox, 'bin-path')
      mkdirSync(binDir, { recursive: true })
      const pathClaude = join(binDir, 'claude')
      writeFileSync(pathClaude, '#!/bin/sh\necho "fake claude: broken build" 1>&2\nexit 1\n', { mode: 0o755 })
      chmodSync(pathClaude, 0o755)
      A.equal(discoverClaudeCli({ env: { PATH: binDir } }).found, true)
      const viaPath = discoverClaudeCli({ env: { PATH: binDir } })
      A.equal(viaPath.bin, pathClaude, 'PATH 里的可执行 claude 必须被发现（基线：只查固定路径）')
      A.equal(viaPath.source, 'PATH')
      const viaExplicit = discoverClaudeCli({ env: { CLAUDE_BIN: pathClaude, PATH: '' } })
      A.equal(viaExplicit.found, true, 'CLAUDE_BIN 优先')
      A.equal(viaExplicit.source, 'CLAUDE_BIN')

      const brokenExplicit = discoverClaudeCli({
        env: { CLAUDE_BIN: join(sandbox, 'no-such-claude'), PATH: binDir },
      })
      A.equal(brokenExplicit.found, true, '显式路径坏掉时继续搜 PATH')
      A.equal(brokenExplicit.attempts[0].ok, false)
      A.equal(brokenExplicit.attempts[0].reason, 'not-found')

      const nonExecDir = join(sandbox, 'bin-nonexec')
      mkdirSync(nonExecDir, { recursive: true })
      const nonExec = join(nonExecDir, 'claude')
      writeFileSync(nonExec, 'not executable\n', { mode: 0o644 })
      chmodSync(nonExec, 0o644)
      const viaNonExec = discoverClaudeCli({ env: { PATH: nonExecDir } })
      A.equal(viaNonExec.found, false, '不可执行文件不能当 CLI')
      A.ok(viaNonExec.attempts.some(attempt => attempt.reason === 'not-executable'))

      const dirDir = join(sandbox, 'bin-dirclaude')
      mkdirSync(join(dirDir, 'claude'), { recursive: true })
      const viaDir = discoverClaudeCli({ env: { PATH: dirDir } })
      A.equal(viaDir.found, false, '同名目录不能当 CLI')
      A.ok(viaDir.attempts.some(attempt => attempt.reason === 'not-a-regular-file'))

      // smoke：PATH-only 的 fake claude 必须「已尝试、失败」（skipped:false），不能 skipped。
      const smoke = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'claude-smoke.mjs')], {
        cwd: repoRoot,
        env: { PATH: binDir, HOME: process.env.HOME || '', TMPDIR: sandbox },
        encoding: 'utf8',
        timeout: 90_000,
      })
      const payload = JSON.parse((smoke.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}')
      A.equal(payload.skipped, false, 'PATH 里有可执行 claude 就必须「已尝试」，不能 skipped（基线：skipped:true）')
      A.equal(payload.ok, false)
      A.equal(smoke.status, 1, '真实通道失败必须退出 1')
    })

    await check('N1 文档：README 三适配器、design/11 Claude 行、三层证据与「真实 CLI 未验证」', async () => {
      const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
      A.match(readme, /`dsh` \/ `codex` \/ `claude`/, 'README 适配器名单必须含 Claude（基线：两种）')
      const design11 = readFileSync(join(repoRoot, 'docs', 'design', '11-node-finish-tool.md'), 'utf8')
      A.match(design11, /\| `claude` \|/, 'design/11 适配器表必须有 Claude 行（基线：缺）')
      A.match(design11, /真实 Claude CLI 未验证/)
      const design12 = readFileSync(join(repoRoot, 'docs', 'design', '12-instance-metrics.md'), 'utf8')
      A.match(design12, /claude-usage-ledger/, 'design/12 必须说明 Claude 用量账本与快照口径')
      const releases = readFileSync(join(repoRoot, 'docs', 'history', 'releases.md'), 'utf8')
      A.match(releases, /参数探测/, 'releases 必须区分三层证据：参数探测')
      A.match(releases, /桥自检/)
      A.match(releases, /真实 CLI/)
    })

    await check('真实 claude CLI（找不到 CLI 时明确 SKIP，不计入通过数）', async () => {
      // m6：发现规则与 smoke 共用（CLAUDE_BIN 优先 → PATH 搜索并校验可执行）。
      const discovered = discoverClaudeCli()
      const claudeBin = discovered.found ? discovered.bin : null
      if (!claudeBin) {
        console.log(`    SKIP（无 claude）：CLAUDE_BIN / PATH 都没找到可执行 claude，`
          + `真实 probe / 通道未验收（尝试记录 ${discovered.attempts.length} 条）`)
        return { skipped: true }
      }
      const adapter = createClaudeAdapter({ claudeBin, tmpRoot: sandbox, selfTest: true })
      const probe = await adapter.probe()
      A.match(probe.version, /^\d+\.\d+\.\d+$/)
      A.equal(probe.printMode, true)
      A.equal(probe.mcpConfig, true)
      A.equal(probe.bridge.ok, true, '真实 MCP initialize/list/call 自检通过')
      A.equal(adapter.capabilities().finishTool, 'native')
      A.deepEqual(leftoverDirs(), [], 'probe 自检的临时目录必须清理')
    })
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
  console.log(`\n${checks} 组 / ${asserts} 条断言全部通过${skips > 0 ? `（${skips} 组 SKIP）` : ''}`)
}

main().then(() => process.exit(0), error => {
  console.error(error)
  process.exit(1)
})
