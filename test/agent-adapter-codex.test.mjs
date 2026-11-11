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
import { createCodexAdapter, CODEX_ADAPTER_ID } from '../src/agent-adapter-codex.js'
import { ADAPTER_ERROR, assertFinishToolNative, validateAdapter } from '../src/agent-adapter.js'
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
import { spawnSync } from 'node:child_process'
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

const skipMcp = mode === 'no-mcp'
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
  out({ type: 'item.completed', item: { id: 'item_msg', type: 'agent_message', text: 'token=' + token + ' socket=' + socketPath } })
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
      A.ok(eventsText.includes('[redacted]'), 'events 里应看到脱敏占位符（说明脱敏真的执行了）')
      A.equal(String(handle.lastMessage).includes(invocation.token), false, 'lastMessage 里不能出现凭据')
      A.match(String(handle.lastMessage), /\[redacted\]/)
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
          A.equal(error?.code, ADAPTER_ERROR.PROBE_INVALID, '直接 start 也保留真实 probe 错误码')
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
