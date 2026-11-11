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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClaudeAdapter, CLAUDE_ADAPTER_ID } from '../src/agent-adapter-claude.js'
import { normalizeUsage } from '../src/agent-telemetry.js'
import { createFinishGate } from '../src/node-finish.js'
import { ADAPTER_ERROR, assertFinishToolNative, validateAdapter } from '../src/agent-adapter.js'
import { admitAdapter, runAgentNode } from '../src/agent-execute.js'

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
const out = obj => process.stdout.write(JSON.stringify(obj) + '\\n')

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
  process.stdout.write([
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
    '  --allowedTools <tools...>         Tools that execute without prompting',
    '  --model <model>                   Model for the session',
    '',
  ].join('\\n'))
  process.exit(0)
}

/** 读 --flag value（argv 里第一次出现）。 */
function takeValue(name) {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null
}

const prompt = argv[0] === '-p' && argv.length > 1 ? argv[1] : argv[argv.length - 1]
const mcpConfigPath = takeValue('--mcp-config')
const settingsPath = takeValue('--settings')
const resumeId = takeValue('--resume') || takeValue('-r')
const sessionIdArg = takeValue('--session-id')
const model = takeValue('--model')
const permissionMode = takeValue('--permission-mode')
const permissionPrompts = takeValue('--permission-prompts')
const allowedTools = takeValue('--allowedTools')
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

out({ type: 'system', subtype: 'init', session_id: sessionId })

const skipMcp = mode === 'no-mcp' || mode === 'no-mcp-stubborn'
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

function assistantEvent(usage, text) {
  out({
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(16).slice(2),
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
    session_id: sessionId,
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
const usageCumulative = {
  input_tokens: 999, cache_creation_input_tokens: 999, cache_read_input_tokens: 999, output_tokens: 999,
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
  resultEvent(usageCumulative, '完成')
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
  resultEvent(usageCumulative, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'call') {
  assistantEvent(usageA, '我先调用 flow_finish_node。')
  await callTool()
  assistantEvent(usageB, '已完成。')
  resultEvent(usageCumulative, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'never') {
  assistantEvent(usageA, '我完成了，不需要调用工具。')
  resultEvent(usageCumulative, '完成')
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
  resultEvent(usageCumulative, '完成')
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
  resultEvent(usageCumulative, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'foreign-token') {
  const response = await foreignSubmit()
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'foreign.json'), JSON.stringify(response))
  assistantEvent(usageA, '跨 execution 凭据被拒。')
  resultEvent(usageCumulative, '完成')
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
  resultEvent(usageCumulative, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'hook-never') {
  for (let index = 0; index < 6; index += 1) {
    const hook = await runStopHook(index > 0)
    if (!hook.block) break
  }
  assistantEvent(usageA, '我完成了。')
  resultEvent(usageCumulative, '完成')
  await closeClient()
  process.exit(0)
}
if (mode === 'leak') {
  assistantEvent(usageA, 'token=' + token + ' socket=' + socketPath)
  await callTool('泄漏测试')
  resultEvent(usageCumulative, 'token=' + token + ' socket=' + socketPath)
  await closeClient()
  process.exit(0)
}
if (mode === 'usage-then-hang') {
  assistantEvent(usageA, '先花掉一次调用，然后卡住。')
  await hangForever()
}
if (mode === 'sleep') {
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
          A.equal(error?.code, ADAPTER_ERROR.PROBE_INVALID, '直接 start 保留真实 probe 错误码')
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

      // usage：两条 assistant 事件 = 两次调用 = 两个 callId；result 的累计值不双计。
      const calls = handle.usageCalls()
      A.equal(calls.length, 2, '一个调用一条 callId')
      A.equal(new Set(calls.map(call => call.callId)).size, 2, 'callId 唯一')
      A.equal(calls[0].provider, 'claude')
      A.equal(calls[0].source, 'assistant')
      A.deepEqual(calls[0].usage, {
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 20,
        output_tokens: 30,
        cache_write_input_tokens: 5,
      }, '保留 provider 原始字段，并补四桶别名')
      A.deepEqual(calls[1].usage, {
        input_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 11,
        output_tokens: 13,
        cache_write_input_tokens: 0,
      })
      A.ok(!calls.some(call => call.usage.input_tokens === 999), 'result.usage 累计值不能重复记账')
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
      A.ok(eventsText.includes('[redacted]'), 'events 确实执行了脱敏')
      A.equal(String(handle.lastMessage).includes(invocation.token), false, 'lastMessage 不能泄漏')
      A.match(String(handle.lastMessage), /\[redacted\]/)
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

    await check('真实 claude CLI（找不到 CLI 时明确 SKIP，不计入通过数）', async () => {
      const candidates = [
        process.env.CLAUDE_BIN,
        '/home/feiyueve/.local/bin/claude',
        '/usr/local/bin/claude',
        '/usr/bin/claude',
      ].filter(Boolean)
      const claudeBin = candidates.find(candidate => existsSync(candidate))
      if (!claudeBin) {
        console.log('    SKIP（无 claude）：本机找不到 claude CLI，真实 probe / 通道未验收')
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
