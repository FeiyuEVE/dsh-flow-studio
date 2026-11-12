#!/usr/bin/env node
/**
 * `agent-adapter-codex.js` 自检：假 codex 驱动真实 MCP 完成通道 + 原生 Stop hook / resume 提醒。
 *
 * 覆盖（含独立审查 B1 / B2 / M2–M8 / m1 / m6 / m9 / m7 的回归点）：
 *   - 工具调用：假 codex 调 MCP 工具后退出 → `exited.ok===true`、提醒 0 次；
 *   - B2：`element.node.prompt` / `roleCard` / `attempt` / `ctx.variables` 必须出现在提示词里，
 *     `element.description` 只能作补充；
 *   - M3：cancel / `NODE_FINISH_MISSING` 之后闸门必须已 abort，迟到 submit 得 `NODE_ALREADY_SETTLED`；
 *   - M4：假 codex 把 token / socket 写进 `command_execution` 与 `agent_message` →
 *     `handle.events` / `lastMessage` / `stdoutTail` 里搜不到；
 *   - M5：宿主注入 `HOST_SECRET_SENTINEL` 后 codex 子进程 env 里没有它，但 settings.env / 通道 env 在；
 *   - M6：`-m` / `-s` / `approval_policy` 显式 pin，可被 settings.sandbox / settings.approvalPolicy 覆盖；
 *   - M7：hooks 默认 emulated，显式 `stopHook:'native'` 才 native；resume/hook 都没有 → unsupported；
 *   - M2/m9：坏 CLI 的 probe 抛 `ADAPTER_PROBE_INVALID`，spawn ENOENT 快速失败、probe 有总超时；
 *   - B1：握手期 cancel 立刻收口并清理 runDir；dispose 有界、不挂；
 *   - m1：最小 gate 抛 `ADAPTER_INVALID` 而不是裸 TypeError，且不泄漏 runDir；
 *   - m9：预 abort 的 `ctx.signal` 零派发；
 *   - m7：admission 走真实 probe → capabilities；真实 CLI 用例找不到 codex 时明确 SKIP 且不计入通过数。
 *
 * 不联网、不调用真实模型：假 codex 是本文件写出的可执行 Node 脚本，自己用官方 MCP SDK
 * client 启动 `src/node-finish-mcp.js` 并调用工具——整条通道是真的。
 *
 * 运行：node test/agent-adapter-codex.test.mjs
 */

import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFinishGate } from '../src/node-finish.js'
import {
  CODEX_ADAPTER_ID, CODEX_ARGV_TOO_LARGE, CODEX_ARGV_TOO_LARGE_HINT, createCodexAdapter,
} from '../src/agent-adapter-codex.js'
import { ADAPTER_ERROR, assertFinishToolNative, validateAdapter } from '../src/agent-adapter.js'
import { readAdapterUsageCalls } from '../src/agent-telemetry.js'
import { admitAdapter } from '../src/agent-execute.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// m7：单独跑这个文件时 `.tmp` 可能还不存在（`npm test` 里靠前面的测试创建，不可依赖）。
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
// 前缀刻意短：codex 的 finish.sock 是 unix socket，路径总长（含中文 / 深 worktree）
// 必须留在 sockaddr_un 的 108 字节以内；长前缀会让 spawn 前的 listen 直接 EINVAL。
const sandbox = mkdtempSync(join(repoRoot, '.tmp', 'cx-'))

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

/** 假 codex：模拟 `--version` / `features` / `mcp list` / `exec` / `exec resume`。 */
const FAKE_CODEX_SOURCE = `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_CODEX_MODE || 'never'
const stateDir = process.env.FAKE_CODEX_STATE_DIR || '.'
const threadId = '11111111-1111-4111-8111-111111111111'
const out = obj => process.stdout.write(JSON.stringify(obj) + '\\n')

// 让 probe 全部挂住（测 probe 总超时）。
if (process.env.FAKE_CODEX_HANG === '1') {
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
// 让每条 probe 子命令都慢 400ms（测 probe 总超时；单条不会超时）。
if (process.env.FAKE_CODEX_SLOW === '1') await new Promise(resolve => setTimeout(resolve, 400))

if (argv[0] === '--version') {
  if (process.env.FAKE_CODEX_FAIL_VERSION === '1') {
    process.stderr.write('fake codex: broken build\\n')
    process.exit(1)
  }
  process.stdout.write('codex-cli 0.167.0\\n')
  process.exit(0)
}
if (argv[0] === 'features') {
  process.stdout.write('hooks                             stable             true\\n')
  process.exit(0)
}
if (argv[0] === 'exec' && argv[1] === '--help') {
  process.stdout.write('Usage: codex exec [OPTIONS] [PROMPT]\\n  --json\\n  -c, --config <key=value>\\n  -C, --cd <DIR>\\n  -m, --model <MODEL>\\n  -s, --sandbox <SANDBOX_MODE>\\n  --dangerously-bypass-hook-trust\\n')
  process.exit(0)
}
if (argv[0] === 'exec' && argv[1] === 'resume' && argv[2] === '--help') {
  process.stdout.write('Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\\n  --json\\n  --last\\n  -m, --model <MODEL>\\n')
  process.exit(0)
}
if (argv[0] === 'mcp' && argv[1] === 'list') {
  if (process.env.FAKE_CODEX_BAD_MCP === '1') {
    process.stdout.write('this is not json\\n')
    process.exit(0)
  }
  process.stdout.write(JSON.stringify([{
    name: 'flow_finish',
    enabled: true,
    transport: { type: 'stdio', command: process.execPath, args: [], env: null, env_vars: [] },
  }]) + '\\n')
  process.exit(0)
}

const isResume = argv[1] === 'resume'
const configs = []
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '-c') {
    configs.push(argv[index + 1])
    index += 1
  }
}
const prompt = argv[argv.length - 1]
let mcpCommand = null
let mcpArgs = []
let envVars = []
let hookCommand = null
let model = null
let sandbox = null
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '-m' || argv[index] === '--model') model = argv[index + 1]
  else if (argv[index] === '-s' || argv[index] === '--sandbox') sandbox = argv[index + 1]
}
let approvalPolicy = null
for (const config of configs) {
  if (config && config.startsWith('mcp_servers.flow_finish.command=')) mcpCommand = JSON.parse(config.slice('mcp_servers.flow_finish.command='.length))
  else if (config && config.startsWith('mcp_servers.flow_finish.args=')) mcpArgs = JSON.parse(config.slice('mcp_servers.flow_finish.args='.length))
  else if (config && config.startsWith('mcp_servers.flow_finish.env_vars=')) envVars = JSON.parse(config.slice('mcp_servers.flow_finish.env_vars='.length))
  else if (config && config.startsWith('approval_policy=')) approvalPolicy = JSON.parse(config.slice('approval_policy='.length))
  else if (config && config.startsWith('sandbox_mode=') && sandbox === null) sandbox = JSON.parse(config.slice('sandbox_mode='.length))
  else if (config && config.startsWith('hooks.Stop=')) {
    const match = /command=("(?:\\\\.|[^"\\\\])*")/.exec(config)
    if (match) hookCommand = JSON.parse(match[1])
  }
}

const token = process.env.FLOW_STUDIO_FINISH_TOKEN || ''
const socketPath = process.env.FLOW_STUDIO_FINISH_SOCKET || ''
const joined = argv.join(' ')
mkdirSync(join(stateDir, 'invocations'), { recursive: true })
writeFileSync(join(stateDir, 'invocations', process.pid + '.json'), JSON.stringify({
  pid: process.pid,
  isResume,
  prompt,
  configs,
  argv,
  model,
  sandbox,
  approvalPolicy,
  hasHookConfig: configs.some(config => String(config).startsWith('hooks.Stop=')),
  tokenInArgv: token !== '' && joined.includes(token),
  tokenInPrompt: token !== '' && String(prompt).includes(token),
  envNames: Object.keys(process.env).sort(),
  hostSentinel: process.env.HOST_SECRET_SENTINEL === undefined ? null : process.env.HOST_SECRET_SENTINEL,
  token,
}))

out({ type: 'thread.started', thread_id: threadId })

const skipMcp = mode === 'no-mcp' || mode === 'no-mcp-stubborn' || mode === 'usage-then-no-mcp'
let transport = null
let client = null
if (!skipMcp) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME }
  for (const name of envVars) if (process.env[name] !== undefined) env[name] = process.env[name]
  transport = new StdioClientTransport({
    command: mcpCommand || process.execPath,
    args: mcpArgs,
    env,
    stderr: 'pipe',
  })
  client = new Client({ name: 'fake-codex', version: '0.167.0' })
  await client.connect(transport)
  if (transport.stderr) transport.stderr.on('data', () => {})
}

if (mode === 'leak') {
  // M4：把本 execution 的 token 与 socket 路径写进会被 adapter 收进 events 的事件里。
  out({
    type: 'item.completed',
    item: {
      id: 'item_cmd',
      type: 'command_execution',
      command: 'env',
      aggregated_output: 'FLOW_STUDIO_FINISH_TOKEN=' + token,
      exit_code: 0,
    },
  })
  out({ type: 'item.completed', item: { id: 'item_msg', type: 'agent_message', text: 'token=' + token + ' socket=' + socketPath + ' password="abc; hunter2"' } })
}

if (mode === 'leak-deep') {
  // #9：把测试凭据放进 12 层嵌套对象，验证超深子树也被替换成占位符（不返回原对象）。
  let nested = { credential: token }
  for (let level = 0; level < 12; level += 1) nested = { ['level_' + level]: nested }
  out({
    type: 'item.completed',
    item: {
      id: 'item_deep',
      type: 'command_execution',
      command: 'env',
      aggregated_output: 'deep',
      deep: nested,
    },
  })
}

if (mode === 'redaction-scan') {
  // 0.15.2 B1/B3/M1/M2/m1：结构化键名 + 文本写法都必须出现在 handle.events 导出面上。
  out({
    type: 'item.completed',
    item: {
      id: 'item_env',
      type: 'command_execution',
      command: 'env',
      aggregated_output: 'structured',
      structured: {
        env: {
          password: 'hunter2',
          auth: 'hunter2',
          token2: 'hunter2',
          nested: { api_key: 'hunter2' },
        },
      },
    },
  })
  const text = [
    'B3a=' + JSON.stringify(JSON.stringify({ password: 'hunter2' })),
    'B3b=' + JSON.stringify({ msg: 'password="say \\\\"hunter2\\\\""' }),
    'M1a=secret_key=hunter2',
    'M1b=access_key=hunter2',
    'M1c=private_key=hunter2',
    'M1d=pwd=hunter2',
    'M1e=pass_word=hunter2',
    'M1f=passphrase=hunter2',
    'M2a=password: &pw hunter2',
    'M2b=password: !!str hunter2',
    'M2c=password: # note\\n  hunter2',
    'm1a=config["password"]=hunter2',
    'm1b=["password","hunter2"]',
    'm1c=password=&#34;hunter2&#34;',
    'm1d=token=ApiKey hunter2',
    'm1e=token=SSWS hunter2',
  ].join(' | ')
  out({ type: 'item.completed', item: { id: 'item_text', type: 'agent_message', text } })
  await callTool()
  await closeClient()
  process.exit(0)
}

async function callTool() {
  const result = await client.callTool({
    name: 'flow_finish_node',
    arguments: {
      variables: { verdict: 'pass', score: 87 },
      documents: [],
      summary: 'fake codex finished',
    },
  })
  out({
    type: 'item.completed',
    item: {
      id: 'item_tool',
      type: 'mcp_tool_call',
      server: 'flow_finish',
      tool: 'flow_finish_node',
      status: result.isError ? 'failed' : 'completed',
    },
  })
  return result
}

async function stopHook(stopHookActive) {
  if (!hookCommand) return { block: false, reason: null }
  const result = spawnSync('bash', ['-c', hookCommand], {
    input: JSON.stringify({
      session_id: threadId,
      turn_id: 'turn-1',
      cwd: process.cwd(),
      hook_event_name: 'Stop',
      stop_hook_active: stopHookActive === true,
      last_assistant_message: 'done',
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
  writeFileSync(join(stateDir, 'hooks', process.pid + '-' + Date.now() + '.json'), JSON.stringify({ stdout: parsed, exit: result.status, hookCommand, raw: result.stdout, err: result.stderr }))
  return { block: parsed.decision === 'block', reason: parsed.reason || null }
}

async function closeClient() {
  if (!client) return
  try {
    await client.close()
  } catch {
    // ignore
  }
}

if (mode === 'call') {
  await callTool()
  await closeClient()
  process.exit(0)
}
if (mode === 'call-on-resume') {
  if (isResume) await callTool()
  await closeClient()
  process.exit(0)
}
if (mode === 'never') {
  await closeClient()
  process.exit(0)
}
if (mode === 'hook-once') {
  const hook = await stopHook(false)
  if (hook.block) {
    out({ type: 'item.completed', item: { id: 'item_cont', type: 'agent_message', text: '已收到提醒，现在调用工具。' } })
    await callTool()
    await stopHook(true)
  }
  await closeClient()
  process.exit(0)
}
if (mode === 'hook-never') {
  for (let index = 0; index < 6; index += 1) {
    const hook = await stopHook(index > 0)
    if (!hook.block) break
  }
  await closeClient()
  process.exit(0)
}
if (mode === 'leak') {
  // 第一次 exec 先不调工具（让 adapter 走 resume），resume 再调工具收尾。
  if (isResume) await callTool()
  await closeClient()
  process.exit(0)
}
if (mode === 'call-on-resume-hang') {
  // #5：resume 提交成功后**不退出**（且忽略 SIGTERM），宽限期清理必须打到这个活跃进程，
  // 而不是早已退出的初始进程。
  if (isResume) {
    process.on('SIGTERM', () => {
      writeFileSync(join(stateDir, 'resume-sigterm'), String(process.pid))
    })
    writeFileSync(join(stateDir, 'resume.pid'), String(process.pid))
    await callTool()
    writeFileSync(join(stateDir, 'resume-submitted'), String(process.pid))
    setInterval(() => {}, 1000)
    await new Promise(() => {})
  }
  await closeClient()
  process.exit(0)
}
if (mode === 'leak-deep') {
  await callTool()
  await closeClient()
  process.exit(0)
}
if (mode === 'no-mcp') {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'started'), String(process.pid))
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (mode === 'descendant') {
  // review-0141 M1：resume 正常提交后退出，但留下一个同进程组的后代（模拟 MCP / 工具后代）。
  if (isResume) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    child.unref()
    writeFileSync(join(stateDir, 'descendant.pid'), String(child.pid))
    await callTool()
  }
  await closeClient()
  process.exit(0)
}
if (mode === 'no-mcp-stubborn') {
  // review-0141 M1：握手期进程忽略 SIGTERM，只有 SIGKILL 能收掉。
  process.on('SIGTERM', () => {})
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'stubborn.pid'), String(process.pid))
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (mode === 'stubborn') {
  // 忽略 SIGTERM，只有 SIGKILL 能收掉：证明 cancel / dispose 的等待是**有界**的。
  process.on('SIGTERM', () => {})
  mkdirSync(stateDir, { recursive: true })
  if (transport && transport.pid) writeFileSync(join(stateDir, 'mcp.pid'), String(transport.pid))
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (mode === 'sleep') {
  mkdirSync(stateDir, { recursive: true })
  if (transport && transport.pid) writeFileSync(join(stateDir, 'mcp.pid'), String(transport.pid))
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
// ---- review-0142b M3 / m2 / M5 / m1 / M6 的夹具（合成 stream-json + 真实子进程） ----

if (mode === 'utf8') {
  // M3：把一条合法 JSON 行**切在多字节字符中间**写出，旧实现按 Buffer 转字符串会出 U+FFFD。
  const payload = Buffer.from(JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_utf8', type: 'agent_message', text: '中文消息🙂 完成' },
  }) + '\\n', 'utf8')
  const cut = payload.indexOf(Buffer.from('中', 'utf8')) + 1
  process.stdout.write(payload.subarray(0, cut))
  await new Promise(resolve => setTimeout(resolve, 40))
  process.stdout.write(payload.subarray(cut))
  await callTool()
  await closeClient()
  process.exit(0)
}
if (mode === 'eof-no-newline') {
  // M3：合法 JSON 没有尾换行，只有 EOF flush 才读得到。
  const payload = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 11, output_tokens: 7, cached_input_tokens: 3 },
  })
  await new Promise(resolve => process.stdout.write(payload, resolve))
  await closeClient()
  process.exit(0)
}
if (mode === 'huge-line') {
  // M3：600 KiB 合法单行 + 一条畸形行；协议缓冲不能被展示 tail 裁剪。
  process.stdout.write('not json at all\\n')
  const big = 'x'.repeat(600 * 1024)
  const payload = Buffer.from(JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_big', type: 'command_execution', aggregated_output: big },
  }) + '\\n', 'utf8')
  for (let offset = 0; offset < payload.length; offset += 32 * 1024) {
    const chunk = payload.subarray(offset, offset + 32 * 1024)
    await new Promise(resolve => process.stdout.write(chunk, resolve))
  }
  out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
  await callTool()
  await closeClient()
  process.exit(0)
}
if (mode === 'huge-turn-failed') {
  // MAJOR-1：约 9 MiB 的**合法**终态事件（turn.failed.message 很大，不是畸形行）。
  // 8 MiB 行界会整行丢弃 → 没有 turn.failed → 误判 NODE_FINISH_MISSING。
  mkdirSync(stateDir, { recursive: true })
  await closeClient()
  const line = JSON.stringify({
    type: 'turn.failed',
    // 用带空白的正文（≈9.8 MiB）：合法事件，且不会撞上 redactText 规则 5 的
    // 「单个超长连续串」已知 V8 栈溢出（那是 process-output.js 的独立问题）。
    error: { code: 'invalid_api_key', message: '9MiB terminal event '.repeat(480 * 1024) },
  }) + '\\n'
  await new Promise(resolveWrite => process.stdout.write(line, resolveWrite))
  process.exit(0)
}
if (mode === 'partial-line') {
  // M3：上一进程没有尾换行的半行不得拼进 resume 的协议流。
  if (isResume) {
    out({ type: 'turn.completed', usage: { input_tokens: 21, output_tokens: 9 } })
    await callTool()
  } else {
    await new Promise(resolve => process.stdout.write('{"type":"turn.completed","usa', resolve))
  }
  await closeClient()
  process.exit(0)
}
if (mode === 'turn-failed') {
  // M6：握手成功后 CLI 报终态错误（消息里带本 execution 的凭据，验证脱敏）。
  mkdirSync(stateDir, { recursive: true })
  await closeClient()
  out({
    type: 'turn.failed',
    error: {
      code: 'invalid_api_key',
      message: "Incorrect API key provided: '" + (token || 'sk-test') + "'",
    },
  })
  process.exit(1)
}
if (mode === 'exit-nonzero') {
  // M6：非零退出 + 没有受理记录是明确的 CLi 终态错误，不能退化成 MISSING。
  mkdirSync(stateDir, { recursive: true })
  await closeClient()
  process.stdout.write('codex exec failed: sandbox setup error\\n')
  process.exit(3)
}
if (mode === 'many-turns') {
  // m2：201 次模型调用；旧实现把计量账本按诊断缓存上限裁到 200。
  for (let turn = 1; turn <= 201; turn += 1) {
    out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } })
  }
  await closeClient()
  process.exit(0)
}
if (mode === 'call-then-hang') {
  // M5：工具已受理，但进程忽略 SIGTERM 并继续运行；零宽限也必须升级 SIGKILL。
  // 注意：宽限为 0 时 TERM（连带 MCP server）可能在工具响应回来前就到，工具调用本身
  // 可能 reject——那不影响「闸门已受理」这个事实，夹具必须继续挂住，不能退出。
  mkdirSync(stateDir, { recursive: true })
  process.on('SIGTERM', () => {
    writeFileSync(join(stateDir, 'grace-sigterm'), String(process.pid))
  })
  try {
    await callTool()
  } catch {
    // 进程组已被 TERM：响应可能来不及回到工具调用方
  }
  writeFileSync(join(stateDir, 'grace-submitted'), String(process.pid))
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (mode === 'leader-exit-descendant') {
  // m1：组长配合 TERM 退出，同组后代忽略 TERM；升级计时器不得被"组长已退"撤销。
  mkdirSync(stateDir, { recursive: true })
  const descendant = spawn('sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], { stdio: 'ignore' })
  descendant.unref()
  writeFileSync(join(stateDir, 'descendant.pid'), String(descendant.pid))
  process.on('SIGTERM', () => { process.exit(0) })
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (mode === 'drain-stall') {
  // M3：后代继承 stdout 并忽略 TERM，组长退出后 stdout 不会 end → 排空必须有界超时。
  mkdirSync(stateDir, { recursive: true })
  const holder = spawn('sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], {
    stdio: ['ignore', 'inherit', 'ignore'],
  })
  holder.unref()
  writeFileSync(join(stateDir, 'stdout-holder.pid'), String(holder.pid))
  writeFileSync(join(stateDir, 'drain-started'), String(process.pid))
  process.exit(0)
}
if (mode === 'usage-then-no-mcp') {
  // M2 残余：已经观测到一轮用量，但不拉起 MCP → 握手超时失败，用量必须随失败载体上交。
  out({ type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 4 } })
  mkdirSync(stateDir, { recursive: true })
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (mode === 'terminal-error-huge') {
  // F2：CLI 错误码与消息都不可信且可以很长（实测能构造 12 KB 级异常 message）。
  mkdirSync(stateDir, { recursive: true })
  await closeClient()
  const fakeBearer = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'
  const codeChunk = 'sk-' + 'Q'.repeat(64) + ' token=' + (token || 'sk-test') + ' '
  out({
    type: 'turn.failed',
    error: {
      code: codeChunk.repeat(120),
      message: (fakeBearer + ' ').repeat(20) + 'y'.repeat(12_000),
    },
  })
  process.exit(1)
}
if (mode === 'sleep') {
  mkdirSync(stateDir, { recursive: true })
  if (transport && transport.pid) writeFileSync(join(stateDir, 'mcp.pid'), String(transport.pid))
  setInterval(() => {}, 1000)
  await new Promise(() => {})
} else {
  await closeClient()
  process.exit(0)
}
`

const fakeBin = join(sandbox, 'fake-codex.mjs')
writeFileSync(fakeBin, FAKE_CODEX_SOURCE, { mode: 0o755 })
chmodSync(fakeBin, 0o755)

const FAKE_PROBE = Object.freeze({
  version: '0.167.0',
  helpDigest: 'fake-help-digest',
  execJson: true,
  resume: true,
  hookTrust: true,
  hooksNative: true,
  stopHookEvidence: 'fake 0.167 hook evidence（不是 probe 实测）',
  mcpConfig: true,
  sandboxFlag: true,
  modelFlag: true,
  bridge: { ok: true, skipped: true },
})

function makeAdapter(overrides = {}) {
  const { env, ...rest } = overrides
  return createCodexAdapter({
    codexBin: fakeBin,
    tmpRoot: sandbox,
    reminderLimit: 3,
    postFinishGraceMs: 2_000,
    helloTimeoutMs: 10_000,
    killTimeoutMs: 1_500,
    selfTest: false,
    probeResult: FAKE_PROBE,
    ...rest,
    env: { FAKE_CODEX_STATE_DIR: stateDir, ...(env || {}) },
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

/** 适配器私有临时目录（`fs-codex-*` / `fs-bridge-*`），用来断言清理彻底。 */
function leftoverDirs() {
  return readdirSync(sandbox).filter(name => name.startsWith('fs-')).sort()
}

/** 轮询等待文件出现（假 codex 写 pid 的时间可能有几毫秒抖动）。 */
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

async function waitUntil(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  return false
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

/** 常用 element：node.prompt / roleCard 是任务本体（B2），description 只是补充。 */
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
  console.log('agent-adapter-codex：假 codex + 真 MCP 通道')
  try {
    await check('接口形状 + probe 前 unsupported；probe 成功后才 native；hooks 默认 emulated', async () => {
      const adapter = createCodexAdapter({
        codexBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        env: { FAKE_CODEX_STATE_DIR: stateDir },
      })
      A.equal(adapter.id, CODEX_ADAPTER_ID)
      A.doesNotThrow(() => validateAdapter(adapter))
      A.equal(adapter.capabilities().finishTool, 'unsupported', 'M1/M2：probe 之前不能宣称 native')
      A.equal(adapter.capabilities().hooks['turn.stop'], 'emulated', 'M7：默认只能声明 emulated')
      const probe = await adapter.probe()
      A.equal(probe.version, '0.167.0', 'M2：版本来自真实 --version，不是伪造的 0.0.0')
      A.equal(typeof probe.helpDigest, 'string')
      A.ok(probe.helpDigest.length > 0)
      A.equal(probe.execJson, true)
      A.equal(probe.resume, true)
      A.equal(probe.hooksNative, true)
      A.equal(probe.hookTrust, true)
      A.equal(probe.mcpConfig, true)
      A.equal(probe.sandboxFlag, true)
      A.equal(probe.modelFlag, true)
      A.equal(probe.bridge.skipped, true)
      const caps = adapter.capabilities()
      A.equal(caps.finishTool, 'native', 'probe 成功后才 native')
      A.equal(caps.usage, 'native', '0.13.10：turn.completed.usage 可观测')
      A.equal(caps.hooks['turn.stop'], 'emulated', 'M7：probe 说 hooksNative 也仍默认 emulated')
      A.match(caps.evidence['turn.stop'], /emulated/)
      A.match(caps.evidence.userConfig, /config\.toml/, 'M6：evidence 如实写用户全局配置仍生效')

      const nativeAdapter = createCodexAdapter({
        codexBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        stopHook: 'native',
        probeResult: FAKE_PROBE,
      })
      A.equal(nativeAdapter.capabilities().hooks['turn.stop'], 'native', '显式 stopHook:native 才标 native')
      A.match(nativeAdapter.capabilities().evidence['turn.stop'], /不是 probe 实测|需人工/, 'M7：标注需人工验证')

      const noReminder = createCodexAdapter({
        codexBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        probeResult: { ...FAKE_PROBE, hooksNative: false, resume: false },
      })
      A.equal(noReminder.capabilities().hooks['turn.stop'], 'unsupported', 'm5：hook 与 resume 都没有 → unsupported')

      // m9：probe 缓存 TTL + 显式 invalidate。
      const ttlAdapter = createCodexAdapter({
        codexBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        probeCacheTtlMs: 60,
        probeResult: FAKE_PROBE,
      })
      A.equal(ttlAdapter.capabilities().finishTool, 'native')
      await sleep(120)
      A.equal(ttlAdapter.capabilities().finishTool, 'unsupported', 'TTL 过期后不能继续拿旧缓存宣称 native')
      const refreshed = await ttlAdapter.probe()
      A.equal(refreshed.version, '0.167.0')
      A.equal(ttlAdapter.capabilities().finishTool, 'native', '过期后重新 probe 恢复可用')
      ttlAdapter.invalidateProbe()
      A.equal(ttlAdapter.capabilities().finishTool, 'unsupported', '显式 invalidate 立即失效')
    })

    await check('M2/m9：坏 CLI 的 probe 抛 ADAPTER_PROBE_INVALID，ENOENT 快速失败、总超时生效', async () => {
      const missing = createCodexAdapter({
        codexBin: join(sandbox, 'no-such-codex'),
        tmpRoot: sandbox,
        selfTest: false,
      })
      let started = Date.now()
      await A.rejects(missing.probe(), error => {
        A.equal(error?.name, 'CodexAdapterError')
        A.equal(error?.code, ADAPTER_ERROR.PROBE_INVALID)
        A.equal(error?.details?.reason, 'cli-unavailable')
        return true
      })
      A.ok(Date.now() - started < 5_000, 'spawn ENOENT 必须快速失败（不是等满 20s）')
      A.equal(missing.capabilities().finishTool, 'unsupported', 'probe 失败后不能宣称 native')

      const badVersion = createCodexAdapter({
        codexBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        env: { FAKE_CODEX_FAIL_VERSION: '1' },
      })
      await A.rejects(badVersion.probe(), error => {
        A.equal(error?.code, ADAPTER_ERROR.PROBE_INVALID)
        A.equal(error?.details?.reason, 'cli-unavailable')
        return true
      })

      const badMcp = createCodexAdapter({
        codexBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        env: { FAKE_CODEX_BAD_MCP: '1' },
      })
      await A.rejects(badMcp.probe(), error => {
        A.equal(error?.code, ADAPTER_ERROR.PROBE_INVALID)
        A.equal(error?.details?.reason, 'mcp-config-unparsable')
        return true
      })

      const slow = createCodexAdapter({
        codexBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        env: { FAKE_CODEX_SLOW: '1' },
        probeTimeoutMs: 1_000,
      })
      started = Date.now()
      await A.rejects(slow.probe(), error => {
        A.equal(error?.code, ADAPTER_ERROR.PROBE_INVALID)
        A.equal(error?.details?.reason, 'probe-timeout')
        return true
      })
      A.ok(Date.now() - started < 5_000, 'probe 必须有总超时')

      // M2：start 阶段 spawn ENOENT 也必须快速失败（放进 hello 竞速，不等满 helloTimeoutMs）。
      resetState()
      const brokenStart = makeAdapter({
        codexBin: join(sandbox, 'no-such-codex'),
        env: {},
        helloTimeoutMs: 10_000,
      })
      const before = leftoverDirs()
      started = Date.now()
      await A.rejects(
        brokenStart.start({
          element: { id: 'agent-1', name: 'ENOENT 节点' },
          ctx: {},
          finishGate: makeGate(freshWorkspace('spawn-enoent')),
          workspaceRoot: freshWorkspace('spawn-enoent'),
        }),
        error => {
          A.equal(error?.name, 'CodexAdapterError')
          A.equal(error?.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE)
          A.equal(error?.details?.reason, 'spawn-failed')
          A.equal(error?.details?.cause, 'ENOENT')
          return true
        },
      )
      A.ok(Date.now() - started < 5_000, 'spawn ENOENT 不能等满 helloTimeoutMs')
      A.deepEqual(leftoverDirs(), before, 'spawn 失败也要清掉 runDir')
      A.equal(invocations().length, 0)
    })

    await check('B2/M5/M6：node.prompt 进提示词；env 白名单；-m / -s / approval_policy 显式 pin', async () => {
      resetState()
      const sentinel = `HOST-SECRET-${Math.random().toString(16).slice(2)}`
      process.env.HOST_SECRET_SENTINEL = sentinel
      try {
        const workspace = freshWorkspace('prompt-env-model')
        const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'call' } })
        const gate = makeGate(workspace)
        const fires = []
        const element = elementWithPrompt({ node: { model: 'gpt-6-astra' } })
        const handle = await adapter.start({
          element,
          ctx: { attempt: 2, variables: { stage: 'design' } },
          finishGate: gate,
          workspaceRoot: workspace,
          reminder: { onFire: info => fires.push(info) },
        })
        const exited = await handle.exited
        A.equal(exited.ok, true, JSON.stringify(exited))
        A.equal(exited.code, 'OK')
        A.equal(exited.reminders, 0)
        A.equal(exited.sessionId, '11111111-1111-4111-8111-111111111111')
        A.deepEqual(fires, [])
        A.equal(gate.settled(), true)
        A.deepEqual(exited.record.output, { verdict: 'pass', score: 87 })
        A.equal(exited.record.summary, 'fake codex finished')

        const [invocation] = invocations()
        A.equal(invocation.isResume, false)
        A.equal(invocation.hasHookConfig, false, 'M7：默认 emulated 不注入 Stop hook');
        A.match(invocation.prompt, /为本需求写一份实施方案/, 'B2：node.prompt 必须出现在提示词里')
        A.match(invocation.prompt, /你是方案设计专员/, 'B2：roleCard 必须出现在提示词里')
        A.match(invocation.prompt, /attempt=2/, 'B2：attempt 进提示词')
        A.match(invocation.prompt, /"stage":"design"/, 'B2：ctx.variables 进提示词')
        A.match(invocation.prompt, /BPMN 元素描述/, 'description 作为补充仍可见')
        A.match(invocation.prompt, /flow_finish_node/)
        A.equal(invocation.model, 'gpt-6-astra', 'M6：element.node.model 用 -m 传给 codex')
        A.ok(invocation.argv.includes('-m') && invocation.argv.includes('gpt-6-astra'), 'M6：argv 里真的有 -m')
        A.equal(invocation.sandbox, 'workspace-write', 'M6：显式 pin 沙箱')
        A.ok(invocation.argv.includes('-s') && invocation.argv.includes('workspace-write'), 'M6：exec 用 -s pin')
        A.equal(invocation.approvalPolicy, 'never', 'M6：approval_policy 显式 pin')
        A.ok(invocation.configs.some(config => config === 'approval_policy="never"'), 'M6：配置里有 approval_policy')
        A.equal(invocation.tokenInArgv, false, '凭据不进 argv')
        A.equal(invocation.tokenInPrompt, false, '凭据不进提示词')
        // M5：白名单 env —— 宿主 secret 不继承，settings.env / 通道 env 必须在。
        A.equal(invocation.envNames.includes('HOST_SECRET_SENTINEL'), false, 'M5：宿主 secret 不得进入 codex 子进程')
        A.equal(invocation.hostSentinel, null)
        A.equal(invocation.envNames.includes('FAKE_CODEX_MODE'), true, 'M5：settings.env 仍然透传')
        A.equal(invocation.envNames.includes('FLOW_STUDIO_FINISH_TOKEN'), true, 'M5：本 execution 的通道 env 必须在')
        A.equal(invocation.envNames.includes('PATH'), true)
        A.equal(invocation.envNames.includes('HOME'), true)
        await adapter.dispose(handle)
      } finally {
        delete process.env.HOST_SECRET_SENTINEL
      }
    })

    await check('M6：settings.sandbox / settings.approvalPolicy 覆盖默认 pin', async () => {
      resetState()
      const workspace = freshWorkspace('settings-sandbox')
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'call' },
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
      })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: elementWithPrompt(),
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      await handle.exited
      const [invocation] = invocations()
      A.equal(invocation.sandbox, 'read-only')
      A.equal(invocation.approvalPolicy, 'on-request')
      A.ok(invocation.configs.some(config => config === 'approval_policy="on-request"'))
      await adapter.dispose(handle)
    })

    await check('原生 Stop hook：提醒一次 → 第二次调用工具 → 成功，onFire count=1', async () => {
      resetState()
      const workspace = freshWorkspace('hook-once')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'hook-once' }, stopHook: 'native' })
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
      A.equal(exited.reminders, 1)
      A.equal(gate.settled(), true)
      A.equal(fires.length, 1, '恰好一次提醒')
      A.equal(fires[0].count, 1)
      A.equal(fires[0].maxFires, 3)
      A.equal(fires[0].sessionId, '11111111-1111-4111-8111-111111111111')

      const all = invocations()
      A.equal(all.length, 1, '原生 hook 路径不重启进程（不是 resume）')
      A.equal(all[0].isResume, false)
      A.equal(all[0].hasHookConfig, true, '显式 native 才注入 Stop hook')
      const hookDir = join(stateDir, 'hooks')
      const hookRuns = readdirSync(hookDir).map(name => JSON.parse(readFileSync(join(hookDir, name), 'utf8')))
      A.ok(hookRuns.some(run => run.stdout && run.stdout.decision === 'block'), 'hook 返回 block')
      const reminder = hookRuns.find(run => run.stdout && run.stdout.decision === 'block')
      A.match(reminder.stdout.reason, /flow_finish_node/)
      A.match(reminder.stdout.reason, /必须调用工具/)
      await adapter.dispose(handle)
    })

    await check('M3：提醒用尽 → NODE_FINISH_MISSING；闸门已 abort，迟到 submit 得 NODE_ALREADY_SETTLED', async () => {
      resetState()
      const workspace = freshWorkspace('hook-never')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'hook-never' }, stopHook: 'native' })
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
      A.equal(exited.ok, false)
      A.equal(exited.code, 'NODE_FINISH_MISSING')
      A.equal(exited.reminders, 3)
      A.equal(gate.settled(), true, 'M3：MISSING 之后闸门必须已 abort')
      await A.rejects(gate.result, error => {
        A.equal(error?.code, 'NODE_FINISH_ABORTED')
        return true
      }, 'M3：gate.result 必须 reject')
      await A.rejects(
        gate.submit({ variables: {}, documents: [], summary: 'late' }),
        error => {
          A.equal(error?.code, 'NODE_ALREADY_SETTLED', 'M3：迟到 submit 必须被拒绝')
          return true
        },
      )
      A.deepEqual(fires, [1, 2, 3])
      A.equal(invocations().length, 1, 'native hook 用尽也不需要 resume')
      await adapter.dispose(handle)
    })

    await check('emulated 兜底：resume 提醒一次后成功；resume 也 pin 沙箱/审批/模型', async () => {
      resetState()
      const workspace = freshWorkspace('resume')
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'call-on-resume' },
        probeResult: { ...FAKE_PROBE, hooksNative: false },
      })
      A.equal(adapter.capabilities().hooks['turn.stop'], 'emulated')
      const gate = makeGate(workspace)
      const fires = []
      const handle = await adapter.start({
        element: { id: 'agent-1', name: 'resume 节点', node: { model: 'gpt-6-astra' } },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: info => fires.push(info.count) },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.equal(exited.reminders, 1)
      A.deepEqual(fires, [1])
      A.equal(gate.settled(), true)
      const all = invocations()
      A.equal(all.length, 2, '第一次退出 + 一次 resume')
      A.equal(all[0].isResume, false)
      A.equal(all[1].isResume, true)
      A.equal(all[1].hasHookConfig, false, 'resume 路径不注入 Stop hook')
      A.match(all[1].prompt, /flow_finish_node/)
      A.match(all[1].argv.join(' '), /exec resume 11111111-1111-4111-8111-111111111111/, 'resume 用 thread id')
      A.equal(all[1].model, 'gpt-6-astra', 'M6：resume 也带 -m')
      A.equal(all[1].sandbox, 'workspace-write', 'M6：resume 用 sandbox_mode 配置 pin')
      A.equal(all[1].approvalPolicy, 'never')
      A.ok(all[1].configs.some(config => config === 'sandbox_mode="workspace-write"'))
      await adapter.dispose(handle)
    })

    await check('#5：resume 提交后不退出 → 宽限清理发给活跃 resume 进程，exited 有界 resolve', async () => {
      resetState()
      const workspace = freshWorkspace('resume-grace')
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'call-on-resume-hang' },
        probeResult: { ...FAKE_PROBE, hooksNative: false },
        postFinishGraceMs: 800,
        killTimeoutMs: 800,
      })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '提醒续跑不退出节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const initialPid = handle.pid
      A.equal(await waitForFile(join(stateDir, 'resume-submitted')), true, 'resume 已提交工具并保持运行')
      const resumePid = Number(readFileSync(join(stateDir, 'resume.pid'), 'utf8'))
      A.equal(Number.isSafeInteger(resumePid) && resumePid > 0, true, '拿到 resume 进程 pid')
      A.equal(pidAlive(resumePid), true, '#5：resume 提交成功后仍在运行')
      A.equal(pidAlive(initialPid), false, '#5：初始进程已退出，清理必须换目标')
      A.equal(gate.settled(), true, '工具已提交，闸门已 settle')

      const started = Date.now()
      const exited = await Promise.race([handle.exited, sleep(8_000).then(() => null)])
      A.ok(exited, '#5：宽限清理收掉 resume 后 exited 必须在有限时间内 resolve')
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.equal(exited.code, 'OK', '工具已提交，收尾应是 OK（不是取消 / MISSING）')
      A.ok(Date.now() - started < 6_000, '#5：exited 有界，不挂住 handler')
      A.equal(await waitForDead(resumePid), true, '#5：活跃 resume 进程收到 TERM/SIGKILL 并退出')
      A.equal(existsSync(join(stateDir, 'resume-sigterm')), true, '#5：TERM 先发给活跃 resume 进程组')

      const all = invocations()
      A.equal(all.length, 2, '初始 exec + 一次 resume')
      A.equal(all[1].isResume, true)
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [], 'dispose 后 runDir 必须被清理')
    })

    await check('cancel：杀整个进程组；M3 闸门 abort；无残留 runDir', async () => {
      resetState()
      const workspace = freshWorkspace('cancel')
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'sleep' },
        postFinishGraceMs: 60_000,
      })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '长任务节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const codexPid = handle.pid
      A.equal(typeof codexPid, 'number')
      A.equal(await waitForFile(join(stateDir, 'mcp.pid')), true, '假 codex 已拉起 MCP server')
      const mcpPid = Number(readFileSync(join(stateDir, 'mcp.pid'), 'utf8'))
      A.equal(Number.isSafeInteger(mcpPid) && mcpPid > 0, true)
      A.equal(pidAlive(codexPid), true, 'cancel 前 codex 活着')
      A.equal(pidAlive(mcpPid), true, 'cancel 前 MCP server 活着')

      A.equal(adapter.capabilities().finishTool, 'native')
      await adapter.cancel(handle, 'test-cancel')
      const exited = await handle.exited
      A.equal(exited.ok, false)
      A.equal(exited.code, 'NODE_FINISH_CANCELED')
      A.equal(gate.settled(), true, 'M3：取消必须 abort 闸门')
      await A.rejects(gate.result, error => {
        A.equal(error?.code, 'NODE_FINISH_ABORTED')
        return true
      })
      await A.rejects(
        gate.submit({ variables: {}, documents: [], summary: 'late' }),
        error => {
          A.equal(error?.code, 'NODE_ALREADY_SETTLED')
          return true
        },
      )
      A.equal(await waitForDead(codexPid), true, `codex ${codexPid} 应已退出（ESRCH）`)
      A.equal(await waitForDead(mcpPid), true, `MCP server ${mcpPid} 应已退出（ESRCH）`)
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [], 'dispose 后 runDir 必须被清理')
    })

    await check('B1：握手期 cancel 立刻收口（不等满 hello 超时），并清理 finish.sock / runDir', async () => {
      resetState()
      const workspace = freshWorkspace('hello-cancel')
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'no-mcp' },
        helloTimeoutMs: 8_000,
        killTimeoutMs: 300,
      })
      const gate = makeGate(workspace)
      const controller = new AbortController()
      const started = Date.now()
      const startPromise = adapter.start({
        element: { id: 'agent-1', name: '握手取消节点' },
        ctx: { signal: controller.signal },
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      setTimeout(() => controller.abort(), 200)
      await A.rejects(startPromise, error => {
        A.equal(error?.name, 'CodexAdapterError')
        A.equal(error?.code, 'NODE_FINISH_CANCELED')
        A.equal(error?.details?.reason, 'canceled-during-handshake')
        return true
      })
      A.ok(Date.now() - started < 6_000, 'cancel 不能被 helloTimeoutMs 拖住')
      A.equal(gate.settled(), true, 'M3：握手期 cancel 也要 abort 闸门')
      await A.rejects(gate.result, error => {
        A.equal(error?.code, 'NODE_FINISH_ABORTED')
        return true
      })
      A.deepEqual(leftoverDirs(), [], 'finish.sock 与 runDir 必须被清理')
    })

    await check('B1：dispose 即使 codex 忽略 SIGTERM 也有界（不 await pending exited）', async () => {
      resetState()
      const workspace = freshWorkspace('stubborn')
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'stubborn' },
        killTimeoutMs: 200,
        postFinishGraceMs: 60_000,
      })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '顽固节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const codexPid = handle.pid
      A.equal(await waitForFile(join(stateDir, 'mcp.pid')), true)
      const mcpPid = Number(readFileSync(join(stateDir, 'mcp.pid'), 'utf8'))
      const started = Date.now()
      // 不先 cancel，直接 dispose（runner finally 的真实调用顺序）。
      await adapter.dispose(handle)
      A.ok(Date.now() - started < 8_000, 'dispose 必须有界（不能挂）')
      const exited = await Promise.race([handle.exited, sleep(1_500).then(() => null)])
      A.ok(exited && exited.code === 'NODE_FINISH_CANCELED', 'dispose 应按取消收口 exited')
      A.equal(await waitForDead(codexPid), true, 'codex 应被 SIGKILL 收掉')
      A.equal(await waitForDead(mcpPid), true, 'MCP server 子进程也应被收掉')
      A.deepEqual(leftoverDirs(), [])
    })

    await check('F3 杀进程未生效：exited 有界收口，但 cleanup.disposed=false（物理退出未确认）', async () => {
      resetState()
      const workspace = freshWorkspace('kill-not-effective')
      // 注入「杀进程未生效」：SIGTERM / SIGKILL 都打不出去，模拟宿主无法确认退出。
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'sleep' },
        postFinishGraceMs: 60_000,
        killTimeoutMs: 50,
        killImpl: () => {},
      })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '杀不掉的节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const codexPid = handle.pid
      A.equal(pidAlive(codexPid), true, '进程仍在')
      await adapter.cancel(handle, 'test-cancel')
      const exited = await handle.exited
      A.equal(exited.ok, false)
      A.equal(exited.code, 'NODE_FINISH_CANCELED', '逻辑结局仍有界收口')
      A.equal(handle.cleanup.disposed, false, '未确认物理退出：cleanup.disposed=false')
      await adapter.dispose(handle)
      A.equal(handle.cleanup.disposed, false, 'dispose 返回后仍不得报告已清理')

      // 测试收尾：手动打真实 SIGKILL，避免留下后台进程；exit 事件会补上物理确认。
      try {
        process.kill(-codexPid, 'SIGKILL')
      } catch {
        try { process.kill(codexPid, 'SIGKILL') } catch { /* 已退出 */ }
      }
      A.equal(await waitForDead(codexPid), true, '测试收尾：真实进程已退出')
      A.equal(await waitUntil(() => handle.cleanup.disposed === true, 2_000), true,
        '真的收到 exit 事件后才更新为 disposed=true')
    })

    await check('N2 续跑进程存活：初始进程退出不构成整个执行的退出证明', async () => {
      resetState()
      const workspace = freshWorkspace('resume-cleanup')
      // killImpl 注入「回收未生效」：SIGTERM / SIGKILL 都打不出去，resume 会一直活着。
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'call-on-resume-hang' },
        postFinishGraceMs: 60_000,
        killTimeoutMs: 100,
        killImpl: () => {},
      })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '续跑存活的节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      A.equal(await waitForFile(join(stateDir, 'resume.pid')), true, 'resume 子进程已启动')
      const resumePid = Number(readFileSync(join(stateDir, 'resume.pid'), 'utf8'))
      A.equal(pidAlive(resumePid), true, 'resume 正在运行')
      // 初始 exec 已自然退出（fixture 输出 thread.started 后退出）。错误实现会在
      // 这里把 cleanup.disposed 报成 true；正确实现必须看住仍存活的 resume。
      A.equal(handle.cleanup.disposed, false, 'resume 存活时 disposed 必须为 false')
      A.match(String(handle.cleanup.reason || ''), /resume/, 'cleanup 给出未退出原因')
      A.deepEqual(handle.cleanup.pending, ['resume'], 'pending 明确列出 resume')

      const startedAt = Date.now()
      await adapter.dispose(handle)
      A.ok(Date.now() - startedAt < 8_000, 'dispose 仍有界（不挂）')
      A.equal(handle.cleanup.disposed, false, 'kill 未生效时 dispose 后仍不得声称已清理')
      A.equal(pidAlive(resumePid), true, '注入的 kill 未生效：resume 仍活着')
      const exited = await Promise.race([handle.exited, sleep(1_500).then(() => null)])
      A.ok(exited && exited.code === 'NODE_FINISH_CANCELED', '逻辑结局仍有界收口')

      // 测试收尾：真实 SIGKILL 进程组，exit 事件补上物理确认。
      try {
        process.kill(-resumePid, 'SIGKILL')
      } catch {
        try { process.kill(resumePid, 'SIGKILL') } catch { /* 已退出 */ }
      }
      A.equal(await waitForDead(resumePid), true, '测试收尾：resume 已退出')
      A.equal(await waitUntil(() => handle.cleanup.disposed === true, 2_000), true,
        '所有被跟踪进程退出后才更新 disposed=true')
    })

    await check('M1 resume 自然退出不丢进程组：后代必须回收，disposed 不能在有活后代时为 true', async () => {
      resetState()
      const workspace = freshWorkspace('resume-descendant')
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'descendant' },
        reminderLimit: 1,
        postFinishGraceMs: 60_000,
      })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '后代残留节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.equal(await waitForFile(join(stateDir, 'descendant.pid')), true, 'resume 已拉起后代')
      const descendantPid = Number(readFileSync(join(stateDir, 'descendant.pid'), 'utf8'))
      A.equal(handle.cleanup.disposed, false, '后代仍存活时 cleanup.disposed 必须如实为 false')
      A.deepEqual(handle.cleanup.pending, ['resume'], 'pending 列出 resume 进程组')
      await adapter.dispose(handle)
      const final = await handle.cleanupFinal
      A.equal(final.disposed, true, '最终清理 Promise 报告 disposed=true')
      A.equal(handle.cleanup.disposed, true, '整组确认消失后才 disposed=true')
      A.equal(await waitForDead(descendantPid), true, 'resume 组的后代（MCP / 工具）被回收')
    })

    await check('M1 握手失败也完成物理清理：忽略 SIGTERM 时 start 不返回活进程', async () => {
      resetState()
      const workspace = freshWorkspace('handshake-stubborn')
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'no-mcp-stubborn' },
        helloTimeoutMs: 300,
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
      A.equal(failure.code, 'NODE_FINISH_TOOL_UNAVAILABLE', '失败码保持 NODE_FINISH_TOOL_UNAVAILABLE')
      A.equal(await waitForFile(join(stateDir, 'stubborn.pid')), true, '假 codex 已启动并忽略 SIGTERM')
      const pid = Number(readFileSync(join(stateDir, 'stubborn.pid'), 'utf8'))
      A.equal(pidAlive(pid), false, 'start 抛错时进程必须已物理退出（不能只等逻辑 exited）')
      A.ok(failure.cleanup && typeof failure.cleanup === 'object', 'start 失败错误带物理清理信号')
      A.equal(failure.cleanup.disposed, true, '物理清理完成：cleanup.disposed=true')
      A.ok(failure.cleanupFinal && typeof failure.cleanupFinal.then === 'function', '带独立的最终清理 Promise')
      A.equal((await failure.cleanupFinal).disposed, true, '最终清理 Promise 同样报告完成')
    })

    await check('M3：UTF-8 多字节字符跨 chunk 不乱码（旧实现按 Buffer 转字符串会出 U+FFFD）', async () => {
      resetState()
      const workspace = freshWorkspace('utf8')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'utf8' } })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: 'UTF-8 节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.equal(handle.lastMessage, '中文消息🙂 完成', 'M3：切在多字节字符中间的 chunk 必须完整解码')
      A.deepEqual(handle.protocolErrors, [], '合法 JSON 行不该产生协议错误')
      await adapter.dispose(handle)
    })

    await check('M3：合法 JSON 缺尾换行 → EOF flush 后 usage / session 仍可结算', async () => {
      resetState()
      const workspace = freshWorkspace('eof-flush')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'eof-no-newline' }, reminderLimit: 0 })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: 'EOF 节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(exited.code, 'NODE_FINISH_MISSING', '正常停下、预算 0 才是 MISSING')
      A.deepEqual(
        handle.usage,
        { input_tokens: 11, output_tokens: 7, cached_input_tokens: 3 },
        'M3：没有尾换行的 turn.completed 必须经 EOF flush 读到（旧实现整条丢失）',
      )
      A.equal(handle.usageCalls().length, 1)
      A.equal(handle.outputIncomplete, false)
      await adapter.dispose(handle)
    })

    await check('M3：600 KiB 合法单行完整解析；畸形行只留可诊断协议错误', async () => {
      resetState()
      const workspace = freshWorkspace('huge-line')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'huge-line' } })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '超大行节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      const big = handle.events.find(event => event.item && event.item.id === 'item_big')
      A.ok(big, 'M3：600 KiB 合法单行必须完整解析（旧实现被 256 KiB 缓冲裁剪后整条静默丢失）')
      A.equal(big.item.aggregated_output.length, 600 * 1024, '分块写入的超长行不能截断')
      A.ok(
        handle.protocolErrors.some(entry => entry.kind === 'json-invalid'),
        'M3：畸形行必须留下可诊断的协议错误（旧实现直接 continue，无任何痕迹）',
      )
      A.equal(handle.droppedLines, 0, '合法超长行不算被丢弃')
      A.equal(handle.outputIncomplete, false)
      await adapter.dispose(handle)
    })

    await check('MAJOR-1：9 MiB 合法 turn.failed 事件必须通过（适配器实际行界 32 MiB，不是 8 MiB）', async () => {
      resetState()
      const workspace = freshWorkspace('huge-turn-failed')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'huge-turn-failed' }, reminderLimit: 0 })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '超大终态事件节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(handle.droppedLines, 0, '9 MiB 合法行不能被整行丢弃（基线：droppedLines=1）')
      A.equal(handle.outputIncomplete, false)
      A.equal(exited.code, 'CODEX_CLI_TURN_FAILED',
        'turn.failed 被读到 → 终态错误；基线被丢弃 → NODE_FINISH_MISSING')
      A.match(exited.message, /invalid_api_key/, 'CLI 错误码必须保留')
      A.equal(invocations().length, 1, '不提醒 / 不续跑')
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('M3：初始进程的半行不得拼进 resume 的协议流（每进程独立 reader）', async () => {
      resetState()
      const workspace = freshWorkspace('partial-line')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'partial-line' } })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '半行节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      A.equal(handle.usageCalls().length, 1, 'M3：resume 的 turn.completed 必须由它自己的 reader 解析')
      A.equal(handle.usageCalls()[0].usage.input_tokens, 21)
      A.ok(
        handle.protocolErrors.some(entry => entry.kind === 'json-invalid'),
        'M3：上一进程的残行在 EOF flush 后留下诊断，而不是悄悄拼进下一行',
      )
      await adapter.dispose(handle)
    })

    await check('M3：stdout 被后代持有 → 排空有界超时（outputIncomplete + 诊断），结算不挂', async () => {
      resetState()
      const workspace = freshWorkspace('drain-stall')
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'drain-stall' },
        reminderLimit: 0,
        drainTimeoutMs: 150,
      })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '排空超时节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const startedAt = Date.now()
      const exited = await Promise.race([handle.exited, sleep(5_000).then(() => null)])
      A.ok(exited, 'M3：stdout 不排空也必须有界收口（不能无限等）')
      A.ok(Date.now() - startedAt < 4_000)
      A.equal(exited.code, 'NODE_FINISH_MISSING')
      A.equal(handle.outputIncomplete, true, 'M3：排空超时必须标记 outputIncomplete')
      A.ok(
        handle.diagnostics.some(entry => entry.kind === 'drain-timeout'),
        'M3：排空超时要留下小诊断',
      )
      const holderPid = Number(readFileSync(join(stateDir, 'stdout-holder.pid'), 'utf8'))
      await adapter.dispose(handle)
      A.equal(await waitForDead(holderPid, 4_000), true, '进程组清理回收持有 stdout 的后代')
    })

    await check('M5：postFinishGraceMs=0 仍执行 TERM→KILL（旧实现只发 TERM 就 return）', async () => {
      resetState()
      const workspace = freshWorkspace('zero-grace')
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'call-then-hang' },
        postFinishGraceMs: 0,
        killTimeoutMs: 60,
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
      try {
        A.equal(
          await waitForFile(join(stateDir, 'grace-sigterm')),
          true,
          '工具受理后必须发出 SIGTERM（进程会记录它并继续活着）',
        )
        A.equal(gate.settled(), true)
        const exited = await Promise.race([handle.exited, sleep(3_000).then(() => null)])
        A.ok(exited, 'M5：零宽限也必须在有界时间内结算 exited（旧实现永远挂住）')
        A.equal(exited.ok, true, JSON.stringify(exited))
        A.equal(exited.code, 'OK')
        A.equal(await waitForFile(join(stateDir, 'grace-sigterm'), 2_000), true, '零宽限仍先发 SIGTERM')
        A.equal(await waitForDead(pid, 3_000), true, 'M5：忽略 TERM 的子进程必须被升级 SIGKILL 收掉')
      } finally {
        try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ }
        try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
      }
      await adapter.dispose(handle)
    })

    await check('m1：组长先退、后代忽略 TERM → 升级计时器不撤销，整组被 SIGKILL 收掉', async () => {
      resetState()
      const workspace = freshWorkspace('leader-descendant')
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'leader-exit-descendant' },
        postFinishGraceMs: 60_000,
        killTimeoutMs: 400,
      })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '组长先退节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const leaderPid = handle.pid
      A.equal(await waitForFile(join(stateDir, 'descendant.pid')), true, '后代已拉起')
      const descendantPid = Number(readFileSync(join(stateDir, 'descendant.pid'), 'utf8'))
      try {
        A.equal(pidAlive(leaderPid), true)
        A.equal(pidAlive(descendantPid), true)
        await adapter.cancel(handle, 'test-cancel')
        const exited = await handle.exited
        A.equal(exited.code, 'NODE_FINISH_CANCELED')
        A.equal(await waitForDead(leaderPid, 3_000), true, '组长配合 TERM 退出')
        A.equal(
          await waitForDead(descendantPid, 4_000),
          true,
          'm1：组长先退不得撤销升级，忽略 TERM 的后代仍必须被 SIGKILL 收掉',
        )
        A.equal(
          await waitUntil(() => handle.cleanup.disposed === true, 3_000),
          true,
          'm1：只有整组消失后才 disposed=true',
        )
      } finally {
        try { process.kill(-leaderPid, 'SIGKILL') } catch { /* 已退出 */ }
        try { process.kill(descendantPid, 'SIGKILL') } catch { /* 已退出 */ }
      }
      await adapter.dispose(handle)
    })

    await check('m2：201 次模型调用全部保留（计量账本不按诊断缓存 200 裁剪）', async () => {
      resetState()
      const workspace = freshWorkspace('usage-ledger')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'many-turns' }, reminderLimit: 0 })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '多轮节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(exited.code, 'NODE_FINISH_MISSING')
      const calls = handle.usageCalls()
      A.equal(calls.length, 201, 'm2：计量账本不能被诊断缓存上限裁到 200')
      A.equal(
        calls.reduce((sum, call) => sum + call.usage.input_tokens + call.usage.output_tokens, 0),
        402,
        'm2：完整 token 总量（201 × 2）',
      )
      A.equal(handle.events.length, 200, '诊断缓存仍然有界')
      A.equal(handle.eventsTruncated, true, 'm2：诊断缓存截断必须显式标记，不能静默丢')
      await adapter.dispose(handle)
    })

    await check('M6：握手后 turn.failed 不退化成 NODE_FINISH_MISSING，不消耗提醒，原因脱敏保留', async () => {
      resetState()
      const workspace = freshWorkspace('turn-failed')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'turn-failed' } })
      const gate = makeGate(workspace)
      const fires = []
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '终态错误节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: info => fires.push(info) },
      })
      const exited = await handle.exited
      A.equal(exited.ok, false)
      A.equal(exited.code, 'CODEX_CLI_TURN_FAILED', 'M6：CLI 终态错误使用稳定 provider 错误码')
      A.match(String(exited.message), /invalid_api_key|Incorrect API key/, 'M6：真实原因必须保留')
      const [invocation] = invocations()
      A.ok(invocation.token.length > 0)
      A.equal(String(exited.message).includes(invocation.token), false, 'M6：原因里的凭据必须脱敏')
      A.equal(exited.reminders, 0, 'M6：终态错误不消耗提醒预算')
      A.deepEqual(fires, [], 'M6：终态错误不再提醒')
      A.equal(invocations().length, 1, 'M6：不因终态错误再 spawn resume')
      A.equal(gate.settled(), true, 'M6：未受理的 gate 被 abort，迟到 submit 得 NODE_ALREADY_SETTLED')
      await A.rejects(gate.submit({ variables: {}, documents: [], summary: 'late' }), error => {
        A.equal(error?.code, 'NODE_ALREADY_SETTLED')
        return true
      })
      A.equal(String(handle.terminalError?.code || ''), 'CODEX_CLI_TURN_FAILED')
      await adapter.dispose(handle)
    })

    await check('M6：非零退出且无受理记录 → CODEX_CLI_EXIT_NONZERO（不是 MISSING、不再提醒）', async () => {
      resetState()
      const workspace = freshWorkspace('exit-nonzero')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'exit-nonzero' } })
      const gate = makeGate(workspace)
      const fires = []
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '非零退出节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: info => fires.push(info) },
      })
      const exited = await handle.exited
      A.equal(exited.ok, false)
      A.equal(exited.code, 'CODEX_CLI_EXIT_NONZERO', 'M6：非零退出保留稳定错误码')
      A.match(String(exited.message), /exit=3/)
      A.equal(exited.reminders, 0, 'M6：异常退出不消耗提醒预算')
      A.deepEqual(fires, [])
      A.equal(invocations().length, 1, 'M6：异常退出不再 spawn resume')
      await adapter.dispose(handle)
    })

    await check('C1：同步 spawn E2BIG → 命名错误 CODEX_ARGV_TOO_LARGE + 可操作 hint + cleanup 不残留', async () => {
      resetState()
      const workspace = freshWorkspace('e2big')
      const adapter = makeAdapter()
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
      // C1：E2BIG 不是「工具通道不可用」，必须有自己的命名错误码（基线：通用 TOOL_UNAVAILABLE）。
      A.equal(failure.code, CODEX_ARGV_TOO_LARGE)
      A.equal(failure.name, 'CodexAdapterError')
      A.equal(failure.details.reason, 'argv-too-large')
      A.equal(failure.details.cause, 'E2BIG', '同步 spawn 的 E2BIG 必须保留为 cause')
      A.equal(typeof failure.details.hint, 'string')
      A.equal(failure.details.hint, CODEX_ARGV_TOO_LARGE_HINT, 'hint 与导出的常量同一份说法')
      A.match(failure.details.hint, /提示词|环境变量/, 'hint 必须点名过大的来源')
      A.match(failure.details.hint, /文档|文件/, 'hint 必须给出可操作出口（改用文件 / 文档）')
      A.match(failure.details.hint, /Windows/, 'hint / 注释要交代 Windows 同义错误（未实测需写明）')
      A.match(failure.details.hint, /未.*实测|未实测/, 'Windows 分支未实测必须如实标注')
      A.equal(failure.message.includes('CODEX_ARGV_TOO_LARGE') || failure.message.includes('参数超过系统上限'), true,
        'message 要能直接看出是参数超限，不是通道不可用')
      A.deepEqual(leftoverDirs(), before, '启动失败不能残留 runDir（基线：目录留在 tmpRoot）')
      A.ok(failure.cleanup && typeof failure.cleanup === 'object', '失败错误带物理清理信号')
      A.equal(failure.cleanup.disposed, true, 'cleanup 必须如实报告已释放（基线：无 cleanup）')
      A.equal((await failure.cleanupFinal).disposed, true)
      A.equal(gate.settled(), true, '启动失败必须 abort gate（基线：gate 未中止）')
      A.equal(invocations().length, 0, '同步 spawn 失败 → 零派发')
    })

    await check('C1 不回归：普通 spawn 失败（ENOENT）仍是 NODE_FINISH_TOOL_UNAVAILABLE', async () => {
      resetState()
      const workspace = freshWorkspace('spawn-enoent-c1')
      const adapter = makeAdapter({
        codexBin: join(sandbox, 'no-such-codex-c1'),
        env: {},
        helloTimeoutMs: 10_000,
      })
      const gate = makeGate(workspace)
      const started = Date.now()
      let failure = null
      try {
        await adapter.start({
          element: { id: 'agent-1', name: 'ENOENT 节点' },
          ctx: {},
          finishGate: gate,
          workspaceRoot: workspace,
        })
      } catch (error) {
        failure = error
      }
      A.ok(failure, 'ENOENT 必须失败')
      // 只有参数超限才用新码：CLI 缺失 / 环境问题仍走「工具通道不可用」。
      A.equal(failure.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE)
      A.notEqual(failure.code, 'CODEX_ARGV_TOO_LARGE')
      A.equal(failure.details.reason, 'spawn-failed')
      A.equal(failure.details.cause, 'ENOENT')
      A.ok(Date.now() - started < 5_000, 'ENOENT 不能等满 helloTimeoutMs')
      A.equal(invocations().length, 0, 'spawn 失败零派发')
    })

    await check('M6 残余 b：闸门已受理后的迟到 cancel 不能覆盖成功结果', async () => {
      resetState()
      const workspace = freshWorkspace('late-cancel')
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'call-then-hang' },
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
      A.equal(record?.summary, 'fake codex finished', '闸门已受理成功')
      // 迟到的 cancel：只负责清理进程，不得把业务结果改写成 CANCELED。
      await adapter.cancel(handle, 'late-cancel')
      const exited = await handle.exited
      A.equal(exited.ok, true, '已受理的成功结果优先于迟到 cancel（基线：NODE_FINISH_CANCELED）')
      A.equal(exited.code, 'OK')
      A.equal(exited.record?.summary, record.summary)
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('F2 终态错误脱敏与长度：错误码 + 消息分别藏秘密，全部抹掉且 message ≤1000 字节', async () => {
      resetState()
      const workspace = freshWorkspace('terminal-huge')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'terminal-error-huge' }, reminderLimit: 1 })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '超长错误节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(exited.ok, false)
      A.equal(exited.code, 'CODEX_CLI_TURN_FAILED')
      const [invocation] = invocations()
      const secretToken = invocation.token
      const fakeBearerSecret = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'
      const skSecret = `sk-${'Q'.repeat(64)}`
      A.ok(secretToken.length > 0)
      const json = JSON.stringify(exited)
      A.equal(json.includes(secretToken), false,
        'CLI 的 code / message 里的本执行凭据都必须脱敏（基线：code 原样进 message 与 errorDetails）')
      A.equal(json.includes(fakeBearerSecret), false, 'Bearer 秘密必须被共享脱敏规则抹掉')
      A.equal(json.includes(skSecret), false, 'sk- 开头的 API key 必须被抹掉')
      A.ok(Buffer.byteLength(String(exited.message), 'utf8') <= 1_000,
        '终态错误 message ≤1000 字节（基线：code + 12000 字符 message 共 12113 字节）')
      A.ok(Buffer.byteLength(String(exited.errorDetails?.cliCode ?? ''), 'utf8') <= 1_000, 'errorDetails.cliCode 有界')
      const diagnostic = handle.terminalError
      A.equal(JSON.stringify(diagnostic).includes(secretToken), false, 'handle.terminalError 同样脱敏')
      A.ok(Buffer.byteLength(String(diagnostic?.message ?? ''), 'utf8') <= 1_000)
      await adapter.dispose(handle)
      A.deepEqual(leftoverDirs(), [])
    })

    await check('M2 残余：start 握手前失败也把已观测 usage 挂到失败载体（executor 可读）', async () => {
      resetState()
      const workspace = freshWorkspace('usage-before-handshake')
      const adapter = makeAdapter({
        env: { FAKE_CODEX_MODE: 'usage-then-no-mcp' },
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
      A.equal(failure.usageCalls[0].usage.output_tokens, 4)
      // executor 收尾用的就是这个读取器（与 handle 同一份契约）。
      A.equal(readAdapterUsageCalls(failure, 'codex').length, 1,
        'executor 用同一读取器能从失败载体拿到已观测调用')
      A.equal(failure.cleanup.disposed, true, '带上用量不影响启动失败清理')
      A.deepEqual(leftoverDirs(), [])
    })

    await check('M4：凭据 / socket 路径不进 handle.events / lastMessage / stdoutTail', async () => {
      resetState()
      const workspace = freshWorkspace('leak')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'leak' }, reminderLimit: 1 })
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
      A.ok(typeof invocation.token === 'string' && invocation.token.length > 0, '假 codex 确实拿到了本 execution 的凭据')
      const eventsText = JSON.stringify(handle.events)
      A.equal(eventsText.includes(invocation.token), false, 'events 里不能出现凭据')
      A.equal(eventsText.includes('fs-codex-'), false, 'events 里不能出现 runDir / socket 路径')
      A.match(eventsText, /\[redacted\]/i, 'events 里应看到脱敏占位符（说明脱敏真的执行了）')
      A.ok(eventsText.includes('password='), 'events 应包含 agent_message 正文（否则下一条断言是空的）')
      A.equal(eventsText.includes('hunter2'), false, 'events 里的赋值型秘密必须走共享文本规则抹掉')
      A.equal(String(handle.lastMessage).includes(invocation.token), false, 'lastMessage 里不能出现凭据')
      A.match(String(handle.lastMessage), /\[redacted\]/i)
      A.equal(String(handle.stdoutTail).includes(invocation.token), false, 'stdoutTail 里不能出现凭据')
      A.equal(String(handle.stderrTail).includes(invocation.token), false, 'stderrTail 里不能出现凭据')
      await adapter.dispose(handle)
    })

    await check('#9：12 层嵌套对象里的凭据不进 handle.events（超深子树替换成截断占位符）', async () => {
      resetState()
      const workspace = freshWorkspace('leak-deep')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'leak-deep' } })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '深层泄漏节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      const [invocation] = invocations()
      A.ok(typeof invocation.token === 'string' && invocation.token.length > 0, '假 codex 确实拿到了本 execution 的凭据')
      const eventsText = JSON.stringify(handle.events)
      A.equal(eventsText.includes(invocation.token), false, '#9：12 层嵌套里的凭据不能出现在 handle.events')
      A.ok(eventsText.includes('level_11'), '深层事件确实被收进 events（不是整条丢了）')
      A.ok(eventsText.includes('[redacted:depth]'), '#9：超深子树必须替换成截断占位符')
      await adapter.dispose(handle)
    })

    await check('0.15.2 B1/B3/M1/M2/m1：handle.events 结构化凭据与文本写法全部脱敏', async () => {
      resetState()
      const workspace = freshWorkspace('redaction-scan')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'redaction-scan' }, reminderLimit: 0 })
      const gate = makeGate(workspace)
      const handle = await adapter.start({
        element: { id: 'agent-1', name: '脱敏扫描节点' },
        ctx: {},
        finishGate: gate,
        workspaceRoot: workspace,
        reminder: { onFire: () => {} },
      })
      const exited = await handle.exited
      A.equal(exited.ok, true, JSON.stringify(exited))
      const eventsText = JSON.stringify(handle.events)
      const leakAt = eventsText.indexOf('hunter2')
      A.equal(leakAt, -1, `handle.events 不得泄漏 hunter2：${leakAt < 0 ? '' : eventsText.slice(Math.max(0, leakAt - 120), leakAt + 40)}`)
      // B1：结构化键名整值替换（旧本地 redactValue 只对字符串脱敏，这里会原样导出）。
      const structuredEvent = handle.events.find(event => event.item && event.item.id === 'item_env')
      A.ok(structuredEvent, '结构化事件必须进 handle.events')
      A.equal(structuredEvent.item.structured.env.password, '[REDACTED]')
      A.equal(structuredEvent.item.structured.env.auth, '[REDACTED]')
      A.equal(structuredEvent.item.structured.env.token2, '[REDACTED]')
      A.equal(structuredEvent.item.structured.env.nested.api_key, '[REDACTED]')
      A.equal(structuredEvent.item.aggregated_output, 'structured', '普通字段不得误改')
      // B3 / M1 / M2 / m1：文本写法在同一导出面上也必须抹掉。
      for (const marker of ['B3a', 'B3b', 'M1a', 'M2c', 'm1b', 'm1d']) {
        A.ok(eventsText.includes(marker), `夹具确实带上了 ${marker}（证明不是整条丢失）`)
      }
      A.ok(eventsText.includes('[REDACTED]'), '导出面必须出现脱敏标记')
      // lastMessage 与 events 同一套规则。
      A.equal(String(handle.lastMessage).includes('hunter2'), false, 'lastMessage 不得泄漏')
      await adapter.dispose(handle)
    })

    await check('m1：最小 gate 抛 ADAPTER_INVALID（不是裸 TypeError），且不泄漏 runDir', async () => {
      resetState()
      const workspace = freshWorkspace('bad-gate')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'call' } })
      const before = leftoverDirs()
      const minimalGate = { submit: async () => ({}), settled: () => false }
      await A.rejects(
        adapter.start({
          element: { id: 'agent-1', name: '坏 gate 节点' },
          ctx: {},
          finishGate: minimalGate,
          workspaceRoot: workspace,
        }),
        error => {
          A.equal(error?.name, 'CodexAdapterError')
          A.equal(error?.code, ADAPTER_ERROR.INVALID)
          A.equal(error?.details?.reason, 'missing-gate')
          A.deepEqual([...error.details.missing].sort(), ['abort', 'result'])
          return true
        },
      )
      A.deepEqual(leftoverDirs(), before, 'm1：校验失败不能建/泄漏 runDir')
      A.equal(invocations().length, 0, 'm1：校验失败不能派发 codex')
    })

    await check('m9：预 abort 的 ctx.signal → 零派发 NODE_FINISH_CANCELED', async () => {
      resetState()
      const workspace = freshWorkspace('pre-aborted')
      const adapter = makeAdapter({ env: { FAKE_CODEX_MODE: 'call' } })
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
      A.equal(invocations().length, 0, 'm9：预 abort 不能 spawn codex')
      A.deepEqual(leftoverDirs(), before)
    })

    await check('M2/m7：admission 走真实 probe → capabilities；失败时零派发', async () => {
      resetState()
      const workspace = freshWorkspace('admission')
      const adapter = createCodexAdapter({
        codexBin: fakeBin,
        tmpRoot: sandbox,
        selfTest: false,
        env: { FAKE_CODEX_STATE_DIR: stateDir },
      })
      const probe = await adapter.probe()
      A.equal(probe.version, '0.167.0')
      A.equal(adapter.capabilities().finishTool, 'native')
      A.doesNotThrow(() => assertFinishToolNative(adapter))
      const admitted = await admitAdapter(adapter, { nodeId: 'agent-1' })
      A.equal(admitted.version, '0.167.0', 'admission 走真实 probe 并返回版本')

      const broken = createCodexAdapter({
        codexBin: join(sandbox, 'no-such-codex'),
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
          A.equal(error?.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE, 'admission 把 probe 失败收敛成不可用')
          return true
        },
      )
      await A.rejects(
        broken.start({
          element: { id: 'agent-1', name: '不可用节点' },
          ctx: {},
          finishGate: makeGate(workspace),
          workspaceRoot: workspace,
        }),
        error => {
          // m5（review-0142b）：旧断言要求 start 透出 `ADAPTER_PROBE_INVALID` 是**错的**——
          // 冻结接口（design/11 §1.6）要求启动期不可用统一成 `NODE_FINISH_TOOL_UNAVAILABLE`，
          // probe 自己的错误码原样放进 cause，真实原因不丢。
          A.equal(
            error?.code,
            ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
            'm5：直接 start 统一为 NODE_FINISH_TOOL_UNAVAILABLE',
          )
          A.equal(error?.details?.reason, 'probe-failed')
          A.equal(error?.details?.cause?.code, ADAPTER_ERROR.PROBE_INVALID, 'm5：probe 原错误码放在 cause 里')
          return true
        },
      )
      A.equal(invocations().length, 0, '真实 probe 失败 → start 零派发')
    })

    await check('真实 codex 0.167 probe（不调模型；找不到 CLI 时明确 SKIP 且不计入通过数）', async () => {
      const candidates = [
        process.env.CODEX_BIN,
        '/home/feiyueve/.local/bin/codex',
        '/usr/local/bin/codex',
      ].filter(Boolean)
      const codexBin = candidates.find(candidate => existsSync(candidate))
      if (!codexBin) {
        console.log('    SKIP（无 codex）：本机找不到 codex CLI，真实 probe 未运行')
        return { skipped: true }
      }
      const adapter = createCodexAdapter({
        codexBin,
        tmpRoot: sandbox,
        selfTest: true,
      })
      const probe = await adapter.probe()
      A.match(probe.version, /^\d+\.\d+\.\d+$/)
      A.equal(probe.execJson, true)
      A.equal(probe.resume, true)
      A.equal(probe.mcpConfig, true, '真实 CLI 接受适配器生成的 MCP + sandbox/approval 配置')
      A.equal(probe.sandboxFlag, true)
      A.equal(probe.modelFlag, true)
      A.equal(probe.bridge.ok, true, '真实 MCP initialize/list/call 自检通过')
      A.equal(adapter.capabilities().finishTool, 'native')
      A.equal(adapter.capabilities().hooks['turn.stop'], 'emulated', 'M7：真实 probe 也只能默认 emulated')
      const nativeCaps = createCodexAdapter({
        codexBin,
        tmpRoot: sandbox,
        selfTest: false,
        stopHook: 'native',
        probeResult: probe,
      }).capabilities()
      A.equal(nativeCaps.hooks['turn.stop'], 'native')
      A.match(nativeCaps.evidence['turn.stop'], /不是 probe 实测|需人工/)
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
