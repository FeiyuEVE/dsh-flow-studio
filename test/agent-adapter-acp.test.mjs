#!/usr/bin/env node
/**
 * `agent-adapter-acp.js` 自检（0.15.0 / P4）。
 *
 * 夹具纪律：ACP 侧 fake agent（`test/fixtures/fake-acp-agent.mjs`）在 `session/new`
 * 收到的 `mcpServers` 上用**官方 MCP SDK Client** 真正拉起 `node-finish-mcp.js`，
 * `tools/list` / `tools/call` 全走真实 MCP 协议；测试从不直接调用 channel / gate 自证。
 *
 * 覆盖（方案 §P4 第 105–108 行）：
 *   - probe：v1 + mode + 桥 + hello + discovery 全成立才 native；空 MCP / 只 hello /
 *     桥失败 → unsupported 且零 prompt；TTL / invalidate / 迟到结果不复活；
 *   - 完结：合法 finish；自然文本 / 假 tool_call → 第 4 轮 MISSING + 3 次提醒；
 *     非法文档后合法调用只受理一次；提醒预算 0 → 首轮 MISSING；提醒轮 provider 错误
 *     不再多提醒；
 *   - 取消：权限请求（deny / 取消后 cancelled）各回一次；尾 update/usage 在 500ms
 *     窗口内收账；stdin 不读也能有界收口；忽略 cancel/TERM 的后代有界 KILL；
 *     finish 与 cancel 竞态保留已受理 record；
 *   - 启动失败：缓存命中但 MCP 起不来 → TOOL_UNAVAILABLE 零 prompt；session/new 失败；
 *     mode 不在 availableModes / set_mode 拒绝 → ACP_MODE_UNAVAILABLE 零 prompt；
 *     预 abort 零派发；spawn 失败不泄漏；
 *   - 用量：prompt result usage → P2 账本（18666），尾部 usage 窗口 5s，取消也收尾。
 *
 * 运行：`node test/agent-adapter-acp.test.mjs`
 */

import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateAdapter, ADAPTER_ERROR } from '../src/agent-adapter.js'
import {
  ACP_ADAPTER_ID,
  ACP_AUTH_REQUIRED,
  ACP_LIMIT_REACHED,
  ACP_PROVIDER_ERROR,
  createAcpAdapter,
} from '../src/agent-adapter-acp.js'
import { runAgentNode } from '../src/agent-execute.js'
import { createFinishGate } from '../src/node-finish.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
// 前缀短：finish.sock 是 unix socket，路径总长必须留在 sockaddr_un 的 108 字节以内。
const sandbox = mkdtempSync(join(repoRoot, '.tmp', 'acp-'))
const fakeAgent = join(repoRoot, 'test', 'fixtures', 'fake-acp-agent.mjs')

let checks = 0
let asserts = 0
let seq = 0
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
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

function sleep(ms) {
  return new Promise(resolveSleep => { setTimeout(resolveSleep, ms) })
}

async function waitFor(predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(20)
  }
  throw new Error(`等待超时：${label}`)
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    sleep(ms).then(() => { throw new Error(`超时：${label}`) }),
  ])
}

function readLog(logPath) {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      try {
        return JSON.parse(line)
      }
      catch {
        return { event: 'unparsable' }
      }
    })
}

function logEvents(logPath, event) {
  return readLog(logPath).filter(entry => entry.event === event)
}

async function waitForLog(logPath, event, label, timeoutMs = 8_000) {
  return waitFor(() => logEvents(logPath, event).length > 0, label, timeoutMs)
}

/** 写一份 fake agent 配置；返回路径与独立事件日志。 */
function scenario(patch = {}) {
  seq += 1
  const name = `case-${seq}`
  const logPath = join(sandbox, `${name}.log.ndjson`)
  const configPath = join(sandbox, `${name}.cfg.json`)
  writeFileSync(configPath, `${JSON.stringify({
    sessionId: `session-${name}`,
    logPath,
    ...patch,
  })}\n`)
  return { name, configPath, logPath }
}

const FAKE_PROBE = Object.freeze({
  version: '2.6.0',
  helpDigest: 'fake-acp-help-digest',
  protocolVersion: 1,
  agentInfo: { name: '@agentclientprotocol/codex-acp', title: 'Codex', version: '2.6.0' },
  loadSession: true,
  closeSupported: true,
  bridge: { ok: true },
  agentMcp: { contacted: true, discovered: true },
  probedAt: '2026-01-01T00:00:00.000Z',
})

/**
 * 默认注入 probe 缓存（不重复起 probe agent）；`probeResult:null` 走真实 probe。
 * `command` 可覆盖成不存在的可执行（spawn 失败用例）。
 */
function makeAdapter(s, overrides = {}) {
  const {
    command, mode, permissionPolicy, probeResult, ...rest
  } = overrides
  return createAcpAdapter({
    config: {
      command: command || process.execPath,
      args: command ? [] : [fakeAgent, '--config', s.configPath],
      env: {},
      mode: mode || 'workspace-write',
      permissionPolicy: permissionPolicy || 'deny',
    },
    tmpRoot: sandbox,
    probeTimeoutMs: 15_000,
    controlTimeoutMs: 8_000,
    helloTimeoutMs: 8_000,
    closeTimeoutMs: 800,
    cancelResponseGraceMs: 500,
    finishTailGraceMs: 1_500,
    killTimeoutMs: 300,
    reminderLimit: 3,
    ...(probeResult === null ? {} : { probeResult: probeResult || FAKE_PROBE }),
    ...rest,
  })
}

function workspaceFor(name) {
  const dir = join(sandbox, `ws-${name}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeGate(workspace, name) {
  return createFinishGate({
    executionId: `exec-${name}`,
    nodeId: 'agent-1',
    attempt: 1,
    workspaceRoot: workspace,
  })
}

const ELEMENT = Object.freeze({
  id: 'agent-1',
  name: '测试节点',
  node: { prompt: '请完成测试任务。' },
})

async function startDirect(adapter, options = {}) {
  const workspace = options.workspace || workspaceFor(`direct-${seq}-${Math.random().toString(16).slice(2)}`)
  const gate = makeGate(workspace, `${seq}-${Math.random().toString(16).slice(2)}`)
  const events = []
  const reminderFires = []
  const ctx = {
    executionId: gate.executionId ?? `exec-${Date.now()}`,
    attempt: 1,
    ...(options.ctx || {}),
    emit: event => events.push(event),
  }
  const handle = await adapter.start({
    element: options.element || ELEMENT,
    ctx,
    finishGate: gate,
    workspaceRoot: workspace,
    reminder: options.reminder || { onFire: info => reminderFires.push(info) },
  })
  return { handle, gate, events, reminderFires, workspace }
}

async function disposeHandle(handle) {
  if (!handle) return
  await withTimeout(handle.dispose(), 10_000, 'dispose')
}

/** 适配器私有临时目录（`fs-acp-*` / `fs-bridge-*`）。 */
function leftoverDirs() {
  return readdirSync(sandbox, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('fs-'))
    .map(entry => entry.name)
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return error && error.code !== 'ESRCH'
  }
}

async function waitForDead(pid, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await sleep(25)
  }
  return !pidAlive(pid)
}

async function expectReject(promise, label) {
  try {
    await promise
  }
  catch (error) {
    return error
  }
  throw new Error(`预期失败但成功了：${label}`)
}

async function main() {
  console.log('agent-adapter-acp.js')

  await check('冻结接口 / probe 前 finishTool=unsupported / deliverMessage 固定 unsupported', async () => {
    const s = scenario()
    const adapter = makeAdapter(s, { probeResult: null })
    validateAdapter(adapter)
    A.equal(adapter.id, 'acp')
    const caps = adapter.capabilities()
    A.equal(caps.finishTool, 'unsupported', 'probe 之前只能声明 unsupported')
    A.deepEqual(caps.hooks, { 'turn.stop': 'emulated' })
    A.equal(caps.messages, 'unsupported')
    A.equal(caps.usage, 'unknown')
    A.equal(caps.resume, 'unsupported')
    A.equal(caps.cancel, 'native')
    A.equal(typeof caps.evidence.finishTool, 'string')
    A.equal(Array.isArray(caps.evidence.evidenceLayers), true)
    const delivered = await adapter.deliverMessage()
    A.deepEqual(delivered, {
      ok: false,
      unsupported: true,
      deliveryUnknown: true,
      code: 'ACP_MESSAGE_DELIVERY_UNSUPPORTED',
      error: 'ACP 首发不支持轮次中投递',
    })
  })

  await check('非法配置：probe 拒绝、start 抛 ACP_CONFIG_INVALID、不派生进程', async () => {
    const adapter = createAcpAdapter({ rawConfig: '{"unknownKey":true}', tmpRoot: sandbox })
    const caps = adapter.capabilities()
    A.equal(caps.finishTool, 'unsupported')
    const error = await expectReject(adapter.probe(), 'probe with invalid config')
    A.equal(error.code, ADAPTER_ERROR.PROBE_INVALID)
    A.equal(error.details.reason, 'ACP_CONFIG_INVALID')
    const ws = workspaceFor('bad-config')
    const startError = await expectReject(adapter.start({
      element: ELEMENT,
      ctx: { executionId: 'exec-bad-config', attempt: 1 },
      finishGate: makeGate(ws, 'bad-config'),
      workspaceRoot: ws,
    }), 'start with invalid config')
    A.equal(startError.code, 'ACP_CONFIG_INVALID')
    A.equal(leftoverDirs().length, 0, '非法配置零资源')
  })

  await check('probe 成功：v1 + mode + 桥 + hello + discovery，native 且零 prompt', async () => {
    const s = scenario()
    const adapter = makeAdapter(s, { probeResult: null })
    const probe = await adapter.probe()
    A.equal(probe.version, '2.6.0')
    A.equal(probe.protocolVersion, 1)
    A.equal(probe.agentInfo.name, '@agentclientprotocol/codex-acp')
    A.equal(probe.bridge.ok, true)
    A.deepEqual(probe.agentMcp, { contacted: true, discovered: true })
    A.equal(adapter.capabilities().finishTool, 'native')
    A.equal(adapter.capabilities().evidence.realChannel.includes('未验证'), true)

    const requests = logEvents(s.logPath, 'request').map(entry => entry.method)
    A.ok(requests.includes('initialize'))
    A.ok(requests.includes('session/new'))
    A.ok(requests.includes('session/set_mode'))
    A.ok(requests.includes('session/close'))
    A.equal(requests.includes('session/prompt'), false, 'probe 绝不发 prompt')
    A.equal(logEvents(s.logPath, 'prompt').length, 0, 'fake agent 上没有 prompt')
    A.equal(logEvents(s.logPath, 'session/load').length, 0)
    const discovered = logEvents(s.logPath, 'mcp-discovered')
    A.equal(discovered.length, 1, 'agent 侧 tools/list 只发生一次')
    A.deepEqual(discovered[0].tools, ['flow_finish_node'])
    const connect = logEvents(s.logPath, 'mcp-connected')
    A.equal(connect.length, 1)
    if (Number.isSafeInteger(connect[0].pid)) {
      A.equal(await waitForDead(connect[0].pid, 8_000), true, 'probe 结束后 finish MCP server 必须已死')
    }
    A.deepEqual(leftoverDirs(), [], 'probe 的临时目录必须清理')
  })

  await check('probe 空 MCP → unsupported 且零 prompt', async () => {
    const s = scenario({ mcp: 'none' })
    const adapter = makeAdapter(s, { probeResult: null, helloTimeoutMs: 500 })
    const error = await expectReject(adapter.probe(), 'probe without MCP')
    A.equal(error.code, ADAPTER_ERROR.PROBE_INVALID)
    A.equal(error.details.reason, 'agent-mcp-not-contacted')
    A.equal(error.details.contacted, false)
    A.equal(adapter.capabilities().finishTool, 'unsupported')
    A.equal(logEvents(s.logPath, 'prompt').length, 0, '零 prompt')
    A.deepEqual(leftoverDirs(), [])
  })

  await check('probe 只 hello 无 discovery → unsupported 且零 prompt', async () => {
    const s = scenario({ mcp: 'hello' })
    const adapter = makeAdapter(s, { probeResult: null, helloTimeoutMs: 500 })
    const error = await expectReject(adapter.probe(), 'probe without discovery')
    A.equal(error.code, ADAPTER_ERROR.PROBE_INVALID)
    A.equal(error.details.reason, 'agent-mcp-not-discovered')
    A.equal(error.details.contacted, true)
    A.equal(error.details.discovered, false)
    A.equal(adapter.capabilities().finishTool, 'unsupported')
    A.equal(logEvents(s.logPath, 'prompt').length, 0)
    A.equal(logEvents(s.logPath, 'mcp-discovered').length, 0)
  })

  await check('probe 桥失败 → unsupported 且零 prompt', async () => {
    const s = scenario()
    const adapter = makeAdapter(s, {
      probeResult: null,
      serverPath: join(sandbox, 'missing-finish-mcp.js'),
      probeTimeoutMs: 4_000,
    })
    const error = await expectReject(adapter.probe(), 'probe with broken bridge')
    A.equal(error.code, ADAPTER_ERROR.PROBE_INVALID)
    A.equal(error.details.reason, 'bridge-failed')
    A.equal(adapter.capabilities().finishTool, 'unsupported')
    A.equal(logEvents(s.logPath, 'prompt').length, 0)
    A.equal(existsSync(s.logPath), false, '桥先失败时根本不该起 agent')
  })

  await check('probe 的 session/close 返回 -32002 视为成功', async () => {
    const s = scenario({ close: 'error-32002' })
    const adapter = makeAdapter(s, { probeResult: null })
    const probe = await adapter.probe()
    A.equal(probe.closeSupported, true)
    A.equal(probe.agentMcp.discovered, true)
    A.equal(adapter.capabilities().finishTool, 'native')
    A.equal(logEvents(s.logPath, 'request').filter(entry => entry.method === 'session/close').length, 1)
  })

  await check('probe TTL 到期能力立即降级', async () => {
    const s = scenario()
    const adapter = makeAdapter(s, { probeResult: null, probeCacheTtlMs: 40 })
    await adapter.probe()
    A.equal(adapter.capabilities().finishTool, 'native')
    await sleep(80)
    A.equal(adapter.capabilities().finishTool, 'unsupported', 'TTL 到期后立即降级')
  })

  await check('invalidate 让进行中 probe 的迟到结果不写缓存', async () => {
    const s = scenario({ startupDelayMs: 300 })
    const adapter = makeAdapter(s, { probeResult: null, probeTimeoutMs: 5_000 })
    const pending = adapter.probe()
    await sleep(80)
    adapter.invalidateProbe()
    const value = await withTimeout(pending, 5_000, 'in-flight probe')
    A.equal(value.protocolVersion, 1, '调用方仍拿到那次 probe 的结果')
    A.equal(adapter.capabilities().finishTool, 'unsupported', '旧 generation 不写缓存')
  })

  await check('probe 超时后的迟到成功不复活', async () => {
    const s = scenario({ startupDelayMs: 400 })
    const adapter = makeAdapter(s, { probeResult: null, probeTimeoutMs: 120 })
    const error = await expectReject(adapter.probe(), 'probe timeout')
    A.equal(error.code, ADAPTER_ERROR.PROBE_INVALID)
    A.equal(error.details.reason, 'probe-timeout')
    await sleep(450)
    A.equal(adapter.capabilities().finishTool, 'unsupported', '迟到结果不得复活缓存')
    A.deepEqual(leftoverDirs(), [], '超时 probe 也要清理')
  })

  await check('runAgentNode 成功：record / usage 18666 / 默认 workspace-write + deny', async () => {
    const s = scenario({
      prompts: [{ kind: 'finish', text: '处理完成' }],
    })
    const adapter = makeAdapter(s)
    const workspace = workspaceFor('success')
    const result = await withTimeout(runAgentNode({
      element: ELEMENT,
      ctx: { executionId: 'exec-success', attempt: 1 },
      adapter,
      workspaceRoot: workspace,
    }), 20_000, 'runAgentNode success')
    A.deepEqual(result.output, { done: true })
    A.deepEqual(result.artifacts, [])
    A.equal(result.summary, 'fake acp agent 完成节点')
    const usage = (result.events || []).filter(event => event.type === 'agent/usage-snapshot')
    A.equal(usage.length, 1, '每个 prompt 一条结算快照')
    A.equal(usage[0].usage.total, 18666)
    A.deepEqual(usage[0].observedBuckets, ['input', 'cacheRead', 'cacheWrite', 'output'])
    A.equal(usage[0].scope, 'invocation')
    const invocations = (result.events || []).filter(event => event.type === 'agent/invocation')
    A.equal(invocations.length, 1, '一次启动一条 agent/invocation')
    const setMode = logEvents(s.logPath, 'request').filter(entry => entry.method === 'session/set_mode')
    A.equal(setMode.length >= 1, true)
    const newEntry = logEvents(s.logPath, 'session-new')[0]
    A.ok(newEntry.mcpCount >= 1, 'session/new 带真实 finish mcpServers')
    A.equal(logEvents(s.logPath, 'mcp-call')[0].isError, false)
    A.deepEqual(leftoverDirs(), [], '成功后临时目录清理')
  })

  await check('自然文本 / 假 tool_call → 第 4 轮 MISSING + 3 次提醒 + 不用 session/load', async () => {
    const s = scenario({
      prompts: [
        { kind: 'text', text: '收到' },
        { kind: 'text', text: '已经完成了' },
        { kind: 'toolcall-fake', toolCallUpdate: { toolCallId: 'fake-tool' } },
        { kind: 'text', text: '真的完成了' },
      ],
    })
    const adapter = makeAdapter(s)
    const { handle, gate, reminderFires } = await startDirect(adapter)
    const outcome = await withTimeout(handle.exited, 20_000, 'natural text outcome')
    A.equal(outcome.ok, false)
    A.equal(outcome.code, 'NODE_FINISH_MISSING')
    A.equal(outcome.reminders, 3)
    A.equal(reminderFires.length, 3, '恰好 3 次提醒')
    A.deepEqual(reminderFires.map(info => info.count), [1, 2, 3])
    A.equal(gate.settled(), true, 'MISSING 前先 abort gate')
    A.equal(logEvents(s.logPath, 'prompt').length, 4, '初始 + 3 次提醒')
    const prompts = logEvents(s.logPath, 'prompt')
    A.equal(prompts[1].text.startsWith('【必须调用工具】'), true, '第 2 轮是提醒文本')
    A.equal(prompts[3].text.startsWith('【必须调用工具】'), true, '第 4 轮仍是提醒文本')
    A.equal(logEvents(s.logPath, 'request').filter(entry => entry.method === 'session/load').length, 0,
      '提醒必须同 session prompt，不需要 session/load')
    A.equal(handle.usageSnapshots().length, 4, '4 个 prompt 各一条快照')
    await disposeHandle(handle)
    A.equal(handle.cleanup.disposed, true)
    A.deepEqual(leftoverDirs(), [])
  })

  await check('非法文档后合法调用 finish：同一 gate 只受理一次', async () => {
    const s = scenario({
      prompts: [{ kind: 'finish-invalid-then-valid' }],
    })
    const adapter = makeAdapter(s)
    const { handle, gate } = await startDirect(adapter)
    const outcome = await withTimeout(handle.exited, 20_000, 'invalid-then-valid outcome')
    A.equal(outcome.ok, true)
    A.deepEqual(outcome.record.output, { done: true })
    const calls = logEvents(s.logPath, 'mcp-call')
    A.equal(calls.length, 2, '先非法后合法共两次工具调用')
    A.equal(calls[0].isError, true, '第一次被 gate 拒绝')
    A.equal(calls[1].isError, false, '第二次受理')
    A.equal(gate.settled(), true)
    const record = await gate.result
    A.deepEqual(record.output, { done: true })
    A.equal(logEvents(s.logPath, 'prompt').length, 1, '合法受理后不再提醒')
    await disposeHandle(handle)
  })

  await check('reminderLimit=0 → 首轮 end_turn 直接 MISSING（0 次提醒）', async () => {
    const s = scenario({ prompts: [{ kind: 'text', text: '收到' }] })
    const adapter = makeAdapter(s, { reminderLimit: 0 })
    const { handle, reminderFires } = await startDirect(adapter)
    const outcome = await withTimeout(handle.exited, 20_000, 'zero reminders outcome')
    A.equal(outcome.ok, false)
    A.equal(outcome.code, 'NODE_FINISH_MISSING')
    A.equal(outcome.reminders, 0)
    A.equal(reminderFires.length, 0)
    A.equal(logEvents(s.logPath, 'prompt').length, 1)
    await disposeHandle(handle)
  })

  await check('提醒轮 provider 错误：不再多提醒，provider code 冒泡', async () => {
    const s = scenario({
      prompts: [{ kind: 'text', text: '收到' }, { kind: 'provider-error', code: -32603 }],
    })
    const adapter = makeAdapter(s)
    const { handle, reminderFires } = await startDirect(adapter)
    const outcome = await withTimeout(handle.exited, 20_000, 'provider on reminder')
    A.equal(outcome.ok, false)
    A.equal(outcome.code, ACP_PROVIDER_ERROR)
    A.equal(outcome.reminders, 1)
    A.equal(reminderFires.length, 1, 'provider 错误后不得再提醒')
    A.equal(logEvents(s.logPath, 'prompt').length, 2)
    A.equal(handle.usageSnapshots().length, 1, '第一轮 end_turn 的 usage 被结算')
    const calls = handle.usageCalls()
    A.equal(calls.length, 1, '失败的提醒轮留下 unknown 调用记录（不丢）')
    A.equal(calls[0].synthetic, true)
    A.equal(calls[0].usage, null)
    await disposeHandle(handle)
  })

  await check('stopReason 分类：unknown → protocol / max_tokens → limit / refusal → provider', async () => {
    const cases = [
      ['stop-unknown', 'ACP_PROTOCOL_ERROR'],
      ['max-tokens', ACP_LIMIT_REACHED],
      ['refusal', ACP_PROVIDER_ERROR],
    ]
    for (const [kind, expected] of cases) {
      const s = scenario({ prompts: [{ kind }] })
      const adapter = makeAdapter(s)
      const { handle } = await startDirect(adapter)
      const outcome = await withTimeout(handle.exited, 20_000, `stop ${kind}`)
      A.equal(outcome.ok, false, kind)
      A.equal(outcome.code, expected, kind)
      A.equal(logEvents(s.logPath, 'prompt').length, 1, `${kind} 不重试`)
      await disposeHandle(handle)
    }
  })

  await check('JSON-RPC 错误分类：-32000 → AUTH / -32002 → SESSION_NOT_FOUND / -32800 → CANCELED', async () => {
    const cases = [
      [-32000, ACP_AUTH_REQUIRED],
      [-32002, 'ACP_SESSION_NOT_FOUND'],
      [-32800, 'NODE_FINISH_CANCELED'],
    ]
    for (const [rpcCode, expected] of cases) {
      const s = scenario({ prompts: [{ kind: 'provider-error', code: rpcCode }] })
      const adapter = makeAdapter(s)
      const { handle } = await startDirect(adapter)
      const outcome = await withTimeout(handle.exited, 20_000, `rpc ${rpcCode}`)
      A.equal(outcome.ok, false, String(rpcCode))
      A.equal(outcome.code, expected, String(rpcCode))
      A.equal(logEvents(s.logPath, 'prompt').length, 1, `${rpcCode} 不重试`)
      await disposeHandle(handle)
    }
  })

  await check('初始 provider 错误：0 次提醒、unknown 账本仍保留', async () => {
    const s = scenario({ prompts: [{ kind: 'provider-error', code: -32603 }] })
    const adapter = makeAdapter(s)
    const { handle, reminderFires } = await startDirect(adapter)
    const outcome = await withTimeout(handle.exited, 20_000, 'initial provider error')
    A.equal(outcome.code, ACP_PROVIDER_ERROR)
    A.equal(outcome.reminders, 0)
    A.equal(reminderFires.length, 0)
    A.equal(logEvents(s.logPath, 'prompt').length, 1)
    const calls = handle.usageCalls()
    A.equal(calls.length, 1)
    A.equal(calls[0].synthetic, true)
    await disposeHandle(handle)
  })

  await check('权限 + cancel：deny 一次、取消后请求 cancelled、尾 usage 收账', async () => {
    const s = scenario({
      prompts: [{ kind: 'permission', waitForCancel: true, afterCancelPermission: true, cancelReplyDelayMs: 100 }],
    })
    const adapter = makeAdapter(s)
    const { handle, events } = await startDirect(adapter)
    await waitForLog(s.logPath, 'permission-response', '第一次权限应答')
    const responses = logEvents(s.logPath, 'permission-response')
    A.equal(responses[0].outcome, 'selected')
    A.equal(responses[0].optionId, 'reject-once', 'deny 只选 reject_once，不选 always')
    const cancelPromise = handle.cancel('permission-cancel')
    const outcome = await withTimeout(handle.exited, 20_000, 'permission cancel outcome')
    A.equal(outcome.code, 'NODE_FINISH_CANCELED')
    await withTimeout(cancelPromise, 10_000, 'cancel promise')
    const after = logEvents(s.logPath, 'permission-response')
    A.equal(after.length, 2, '取消后到达的权限请求也恰好应答一次')
    A.equal(after[1].outcome, 'cancelled')
    A.equal(new Set(after.map(item => item.requestId)).size, 2)
    const permissionEvents = events.filter(event => event.type === 'agent/permission')
    A.deepEqual(permissionEvents.map(event => event.decision), ['deny', 'cancelled'])
    A.equal(handle.usageSnapshots().length, 1, '取消窗口内的尾 usage 被收下')
    A.equal(handle.usageSnapshots()[0].scope, 'invocation')
    await disposeHandle(handle)
    A.equal(handle.cleanup.disposed, true)
  })

  await check('同一权限请求 id 重复到达：只一次有效决策，重复回 cancelled（1 条事件）', async () => {
    const s = scenario({ prompts: [{ kind: 'permission-duplicate', requestId: 4242 }] })
    const adapter = makeAdapter(s)
    const { handle, events } = await startDirect(adapter)
    const outcome = await withTimeout(handle.exited, 20_000, 'duplicate permission outcome')
    A.equal(outcome.ok, true)
    const duplicate = logEvents(s.logPath, 'permission-duplicate-response')[0]
    A.equal(duplicate.requestId, 4242)
    A.deepEqual(duplicate.outcomes.map(item => item.outcome), ['selected', 'cancelled'],
      '首条按策略决策，重复 id 固定 cancelled')
    A.equal(duplicate.outcomes[0].optionId, 'reject-once')
    A.equal(duplicate.outcomes[1].optionId, null)
    const permissionEvents = events.filter(event => event.type === 'agent/permission')
    A.equal(permissionEvents.length, 1, '重复 id 不产生第二条 agent/permission 事件')
    A.equal(permissionEvents[0].decision, 'deny')
    A.equal(handle.diagnostics.client.permissionRequests, 2, '两条请求都到达客户端层')
    A.equal(handle.diagnostics.client.permissionDuplicates, 1)
    await disposeHandle(handle)
    A.equal(handle.cleanup.disposed, true)
  })

  await check('gate 已受理后尾窗内的权限请求一律 cancelled（不按策略授权）', async () => {
    for (const policy of ['allow', 'deny']) {
      const s = scenario({ prompts: [{ kind: 'permission-after-finish', permissionDelayMs: 50 }] })
      const adapter = makeAdapter(s, { permissionPolicy: policy })
      const { handle, gate, events } = await startDirect(adapter)
      const outcome = await withTimeout(handle.exited, 20_000, `${policy} after-finish outcome`)
      A.equal(outcome.ok, true, 'gate 已受理：节点仍成功')
      A.equal(gate.settled(), true, '权限请求发生在 gate 已 seal 之后')
      const finishResult = logEvents(s.logPath, 'finish-tool-result')[0]
      A.equal(finishResult.isError, false, 'finish 工具已成功（结局已定）')
      const permission = logEvents(s.logPath, 'permission-after-finish-response')[0]
      A.equal(permission.outcome, 'cancelled', `${policy}：结局已定后一律 cancelled`)
      A.equal(permission.optionId, null)
      const permissionEvents = events.filter(event => event.type === 'agent/permission')
      A.equal(permissionEvents.length, 1)
      A.equal(permissionEvents[0].decision, 'cancelled', '事件 decision 也是 cancelled')
      await disposeHandle(handle)
      A.equal(handle.cleanup.disposed, true)
    }
  })

  await check('cancel 后继续读 500ms 尾响应：usage snapshot 不丢', async () => {
    const s = scenario({
      prompts: [{
        kind: 'cancel-tail',
        cancelReplyDelayMs: 120,
        tailText: '尾部文本',
        tailUsage: {
          totalTokens: 42, inputTokens: 20, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 22, thoughtTokens: 0,
        },
      }],
    })
    const adapter = makeAdapter(s)
    const { handle, events } = await startDirect(adapter)
    await waitForLog(s.logPath, 'prompt', 'prompt 开始')
    const startedAt = Date.now()
    const cancelPromise = handle.cancel('tail-cancel')
    const outcome = await withTimeout(handle.exited, 20_000, 'tail cancel outcome')
    A.equal(outcome.code, 'NODE_FINISH_CANCELED')
    A.equal(Date.now() - startedAt < 4_000, true, '取消有界')
    await withTimeout(cancelPromise, 10_000, 'cancel promise')
    const snapshots = handle.usageSnapshots()
    A.equal(snapshots.length, 1)
    A.equal(snapshots[0].usage.total, 42, '尾响应 usage 被结算（不是 unknown）')
    A.equal(snapshots[0].usage.input, 20)
    A.equal(events.some(event => event.type === 'activity/output' && event.text === '尾部文本'), true,
      '尾 update 也被投影')
    await disposeHandle(handle)
  })

  await check('stdin 不读 + 忽略 cancel：仍能在有界时间内收账（synthetic unknown）', async () => {
    const s = scenario({
      prompts: [{ kind: 'cancel-ignore' }],
      pauseStdinOnPrompt: true,
      ignoreCancel: true,
    })
    const adapter = makeAdapter(s)
    const { handle } = await startDirect(adapter)
    await waitForLog(s.logPath, 'stdin-paused', 'fake agent 暂停 stdin')
    const startedAt = Date.now()
    const cancelPromise = handle.cancel('stdin-blocked')
    const outcome = await withTimeout(handle.exited, 20_000, 'stdin blocked outcome')
    A.equal(outcome.code, 'NODE_FINISH_CANCELED')
    A.equal(Date.now() - startedAt < 4_000, true, '500ms 尾窗 + 有界清理，不等待永不响应的 prompt')
    await withTimeout(cancelPromise, 10_000, 'cancel promise')
    const calls = handle.usageCalls()
    A.equal(calls.length, 1)
    A.equal(calls[0].synthetic, true)
    A.equal(calls[0].usage, null)
    A.equal(calls[0].reason, 'usage-unavailable')
    await disposeHandle(handle)
  })

  await check('杀进程不生效 + 忽略 TERM：cleanup.disposed=false / pending 含 pid / cleanupFinal 超时', async () => {
    const s = scenario({
      prompts: [{ kind: 'cancel-ignore' }],
      ignoreCancel: true,
      ignoreTerm: true,
    })
    // killImpl 空操作：SIGTERM / SIGKILL 都打不出去；ignoreTerm / ignoreCancel 让
    // 假 agent 继续活着。清理快照必须如实报告「物理退出未确认」，不能恒 disposed:true。
    const adapter = makeAdapter(s, { killTimeoutMs: 50, killImpl: () => {} })
    const { handle } = await startDirect(adapter)
    const pid = handle.pid
    A.equal(Number.isSafeInteger(pid), true, '拿到初始进程 pid')
    await waitForLog(s.logPath, 'prompt', 'prompt 开始')
    const cancelPromise = handle.cancel('kill-not-effective')
    const outcome = await withTimeout(handle.exited, 20_000, 'kill-not-effective outcome')
    A.equal(outcome.code, 'NODE_FINISH_CANCELED', '逻辑结局仍有界收口')
    await withTimeout(cancelPromise, 10_000, 'cancel promise')
    A.equal(pidAlive(pid), true, '注入的 killImpl 未真的杀进程')
    const snapshot = handle.cleanup
    A.equal(snapshot.disposed, false, '未确认物理退出：cleanup.disposed=false')
    A.ok(Array.isArray(snapshot.pending) && snapshot.pending.includes(`initial:${pid}`),
      `pending 必须包含该 pid（实际：${JSON.stringify(snapshot.pending)}）`)
    const final = await withTimeout(handle.cleanupFinal, 15_000, 'cleanupFinal')
    A.equal(final.disposed, false, 'cleanupFinal 不得谎报已清理')
    A.equal(final.timedOut, true, 'cleanupFinal 超时如实报告')
    A.ok(String(final.reason).includes('超时'), 'reason 写明超时')

    // 测试收尾：真实 SIGKILL，避免留下后台进程。
    try {
      process.kill(-pid, 'SIGKILL')
    }
    catch {
      try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
    }
    A.equal(await waitForDead(pid), true, '测试收尾：真实进程已退出')
    await disposeHandle(handle)
  })

  await check('忽略 TERM 的后代：整组升级 SIGKILL，cleanup 如实', async () => {
    const stubbornPidFile = join(sandbox, `stubborn-${seq + 1}.pid`)
    const s = scenario({
      prompts: [{ kind: 'cancel-ignore' }],
      pauseStdinOnPrompt: true,
      ignoreCancel: true,
      ignoreTerm: true,
      spawnStubbornChild: true,
      stubbornPidFile,
    })
    const adapter = makeAdapter(s, { killTimeoutMs: 250 })
    const { handle } = await startDirect(adapter)
    await waitFor(() => existsSync(stubbornPidFile), 'stubborn pid file')
    const stubbornPid = Number(readFileSync(stubbornPidFile, 'utf8'))
    A.equal(pidAlive(stubbornPid), true)
    const startedAt = Date.now()
    const cancelPromise = handle.cancel('stubborn-tree')
    const outcome = await withTimeout(handle.exited, 20_000, 'stubborn outcome')
    A.equal(outcome.code, 'NODE_FINISH_CANCELED')
    A.equal(Date.now() - startedAt < 10_000, true, 'TERM → KILL 有界')
    await withTimeout(cancelPromise, 10_000, 'cancel promise')
    A.equal(await waitForDead(stubbornPid, 8_000), true, '忽略 TERM 的后代必须被 SIGKILL')
    await disposeHandle(handle)
    A.equal(handle.cleanup.disposed, true)
    A.equal((await withTimeout(handle.cleanupFinal, 15_000, 'cleanupFinal')).disposed, true)
  })

  await check('finish 与 cancel 竞态：已受理 record 保留，不被迟到 cancel 改写', async () => {
    const s = scenario({
      prompts: [{
        kind: 'finish',
        resultDelayMs: 400,
        usage: {
          totalTokens: 123, inputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 23, thoughtTokens: 0,
        },
      }],
    })
    const adapter = makeAdapter(s)
    const { handle, gate } = await startDirect(adapter)
    await waitFor(() => gate.settled(), 'gate accepted')
    const cancelPromise = handle.cancel('late-cancel')
    const outcome = await withTimeout(handle.exited, 20_000, 'finish race outcome')
    A.equal(outcome.ok, true, '已受理成功优先于迟到 cancel')
    A.equal(outcome.code, 'OK')
    A.deepEqual(outcome.record.output, { done: true })
    await withTimeout(cancelPromise, 10_000, 'cancel promise')
    A.equal(handle.usageSnapshots()[0].usage.total, 123, '尾 usage 仍被收下')
    await disposeHandle(handle)
  })

  await check('缓存命中但 MCP 起不来 → TOOL_UNAVAILABLE 零 prompt、无泄漏', async () => {
    const s = scenario({ mcp: 'none' })
    const adapter = makeAdapter(s, { helloTimeoutMs: 500 })
    const { handle } = await startDirect(adapter)
    const outcome = await withTimeout(handle.exited, 20_000, 'no mcp outcome')
    A.equal(outcome.ok, false)
    A.equal(outcome.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE)
    A.equal(logEvents(s.logPath, 'prompt').length, 0, 'MCP 握手失败零 prompt')
    await disposeHandle(handle)
    A.deepEqual(leftoverDirs(), [], '启动失败不泄漏 runDir / channel')
  })

  await check('session/new RPC 失败 → 握手前 TOOL_UNAVAILABLE（保留 cause）+ 无泄漏', async () => {
    const s = scenario({ failNew: -32603 })
    const adapter = makeAdapter(s)
    const { handle } = await startDirect(adapter)
    const outcome = await withTimeout(handle.exited, 20_000, 'session/new failure')
    A.equal(outcome.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE)
    A.equal(outcome.message.includes('ACP_PROVIDER_ERROR'), true)
    A.equal(logEvents(s.logPath, 'prompt').length, 0)
    await disposeHandle(handle)
    A.deepEqual(leftoverDirs(), [])
  })

  await check('mode 不在 availableModes：probe 拒绝 + start ACP_MODE_UNAVAILABLE 零 prompt', async () => {
    const modes = { currentModeId: 'read-only', availableModes: [{ id: 'read-only', name: 'Read-only' }] }
    const s = scenario({ modes })
    const probing = makeAdapter(s, { probeResult: null })
    const probeError = await expectReject(probing.probe(), 'probe mode unavailable')
    A.equal(probeError.details.reason, 'mode-unavailable')
    A.equal(probing.capabilities().finishTool, 'unsupported')

    const adapter = makeAdapter(s)
    const { handle } = await startDirect(adapter)
    const outcome = await withTimeout(handle.exited, 20_000, 'mode unavailable start')
    A.equal(outcome.code, 'ACP_MODE_UNAVAILABLE')
    A.equal(logEvents(s.logPath, 'prompt').length, 0, '不回退更宽模式，也不派 prompt')
    await disposeHandle(handle)
  })

  await check('session/set_mode 拒绝 → ACP_MODE_UNAVAILABLE 零 prompt', async () => {
    const s = scenario({ setMode: 'error' })
    const adapter = makeAdapter(s)
    const { handle } = await startDirect(adapter)
    const outcome = await withTimeout(handle.exited, 20_000, 'set_mode rejected')
    A.equal(outcome.code, 'ACP_MODE_UNAVAILABLE')
    A.equal(logEvents(s.logPath, 'prompt').length, 0)
    await disposeHandle(handle)
  })

  await check('ctx.signal 预 abort → start 抛 NODE_FINISH_CANCELED，零派发', async () => {
    const s = scenario()
    const adapter = makeAdapter(s)
    const workspace = workspaceFor('pre-aborted')
    const controller = new AbortController()
    controller.abort()
    const error = await expectReject(adapter.start({
      element: ELEMENT,
      ctx: { executionId: 'exec-pre-abort', attempt: 1, signal: controller.signal },
      finishGate: makeGate(workspace, 'pre-aborted'),
      workspaceRoot: workspace,
    }), 'pre-aborted start')
    A.equal(error.code, 'NODE_FINISH_CANCELED')
    A.equal(existsSync(s.logPath), false, '预 abort 零派发（fake agent 都没起）')
    A.deepEqual(leftoverDirs(), [])
  })

  await check('启动阶段 ctx.signal abort：取消有界、零 prompt、无泄漏', async () => {
    const s = scenario({ startupDelayMs: 600, prompts: [{ kind: 'text' }] })
    const adapter = makeAdapter(s)
    const controller = new AbortController()
    const { handle } = await startDirect(adapter, { ctx: { signal: controller.signal } })
    controller.abort()
    const outcome = await withTimeout(handle.exited, 20_000, 'startup aborted outcome')
    A.equal(outcome.ok, false)
    A.equal(outcome.code, 'NODE_FINISH_CANCELED')
    A.equal(logEvents(s.logPath, 'prompt').length, 0, '初始化阶段取消不派 prompt')
    await disposeHandle(handle)
    A.deepEqual(leftoverDirs(), [], '取消启动后临时目录必须清理')
  })

  await check('spawn 失败（可执行不存在）→ exited TOOL_UNAVAILABLE，不留目录', async () => {
    const s = scenario()
    const adapter = makeAdapter(s, { command: join(sandbox, 'missing-acp-agent-binary') })
    const { handle } = await startDirect(adapter)
    const outcome = await withTimeout(handle.exited, 20_000, 'spawn failure')
    A.equal(outcome.ok, false)
    A.equal(outcome.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE)
    await disposeHandle(handle)
    A.deepEqual(leftoverDirs(), [])
  })

  await check('0.15.2 B1：diagnostics.probe 的结构化敏感键整体脱敏（与 codex/claude 共用 redactStructured）', async () => {
    const s = scenario({ prompts: [{ kind: 'finish' }] })
    const adapter = makeAdapter(s, {
      probeResult: {
        ...FAKE_PROBE,
        env: {
          password: 'hunter2',
          auth: 'hunter2',
          token2: 'hunter2',
          nested: { api_key: 'hunter2' },
        },
        // 敏感键名下的对象也整体替换，不保留值形态。
        credentials: { password: 'hunter2' },
        note: 'keep-me',
      },
    })
    const { handle } = await startDirect(adapter)
    const outcome = await withTimeout(handle.exited, 20_000, 'redaction outcome')
    A.equal(outcome.ok, true, JSON.stringify(outcome))
    const diagnostics = handle.diagnostics
    A.equal(diagnostics.probe.env.password, '[REDACTED]')
    A.equal(diagnostics.probe.env.auth, '[REDACTED]')
    A.equal(diagnostics.probe.env.token2, '[REDACTED]')
    A.equal(diagnostics.probe.env.nested.api_key, '[REDACTED]')
    A.equal(diagnostics.probe.credentials, '[REDACTED]', '敏感键下的对象整体替换（不保留值形态）')
    A.equal(diagnostics.probe.note, 'keep-me', '普通字段不得误改')
    A.equal(JSON.stringify(diagnostics).includes('hunter2'), false, 'diagnostics 不得泄漏 hunter2')
    await disposeHandle(handle)
  })

  await check('成功收尾：cleanup.disposed / cleanupFinal / MCP server 进程全部确认', async () => {
    const s = scenario({ prompts: [{ kind: 'finish' }] })
    const adapter = makeAdapter(s)
    const { handle } = await startDirect(adapter)
    const outcome = await withTimeout(handle.exited, 20_000, 'success outcome')
    A.equal(outcome.ok, true)
    await disposeHandle(handle)
    A.equal(handle.cleanup.disposed, true)
    const final = await withTimeout(handle.cleanupFinal, 15_000, 'cleanupFinal')
    A.equal(final.disposed, true)
    const connect = logEvents(s.logPath, 'mcp-connected')[0]
    if (connect && Number.isSafeInteger(connect.pid)) {
      A.equal(await waitForDead(connect.pid, 8_000), true)
    }
    A.deepEqual(leftoverDirs(), [])
  })
}

main().then(() => {
  rmSync(sandbox, { recursive: true, force: true })
  console.log(`\n${checks} 组 / ${asserts} 条断言全部通过`)
  process.exit(0)
}, error => {
  rmSync(sandbox, { recursive: true, force: true })
  console.error(error)
  process.exit(1)
})
