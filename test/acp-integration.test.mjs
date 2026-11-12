#!/usr/bin/env node
/**
 * ACP 适配器的**引擎验收**（0.15.0 / P5）。
 *
 * 目标：证明 `adapter="acp"` 只在显式配置时走新路径，并且经真实
 * `createBpmnRuntime` 与真实 fake ACP agent（`session/new` 里的 MCP server 由官方
 * MCP SDK 客户端真正拉起，`flow_finish_node` 走真实 MCP 协议）时，实例语义与
 * 现有 adapter 一致：
 *
 *   1. 注册：`apply()` 后 `/health` 的 adapter 列表固定包含 `acp`，默认仍是 `dsh`；
 *      非法 `FLOW_STUDIO_ACP_CONFIG` 只让 ACP 节点不可用，不影响其它 adapter 注册；
 *   2. 成功：activity/end、variables、documents(instance.json artifacts)、网关路由；
 *   3. 失败：缺 CLI / 认证 / 不支持 mode / agent 没拉起 MCP → `TOOL_UNAVAILABLE`、
 *      实例 ACTIVE、agent 零 prompt；
 *   4. 完结缺失 / provider 错误 → lastError 保留具体码；
 *   5. 活动超时 → `BPMN_ACTIVITY_TIMEOUT`，无 process/end。
 *
 * 临时目录一律在 `<repo>/.tmp/acpi-*`；`tmpRoot` 前缀刻意短（finish.sock 受
 * sockaddr_un 107 字节上限约束）。运行：`node test/acp-integration.test.mjs`
 */

import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { Readable } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ADAPTER_ERROR, createAdapterRegistry } from '../src/agent-adapter.js'
import { DEFAULT_ADAPTER_ID } from '../src/agent-execute.js'
import { createAcpAdapter } from '../src/agent-adapter-acp.js'
import { createBpmnRuntime } from '../src/bpmn-runtime.js'
import { apply } from '../src/index.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
// 前缀要短：ACP 的 probe / 运行目录会有 fs-acp-probe-XXXXXX/finish.sock。
const sandbox = mkdtempSync(join(repoRoot, '.tmp', 'acpi-'))
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
  try {
    await fn()
    checks += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${error && error.message ? error.message : error}`)
    throw error
  }
}

function sleep(ms) {
  return new Promise(resolveSleep => { setTimeout(resolveSleep, ms) })
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(20)
  }
  throw new Error(`等待超时：${label}`)
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

/** 一份 fake agent 配置 + 独立日志。 */
function scenario(patch = {}) {
  seq += 1
  const name = `case-${seq}`
  const logPath = join(sandbox, `${name}.log.ndjson`)
  const configPath = join(sandbox, `${name}.cfg.json`)
  writeFileSync(configPath, `${JSON.stringify({ sessionId: `session-${name}`, logPath, ...patch })}\n`)
  return { name, configPath, logPath }
}

function acpConfig(s, patch = {}) {
  return {
    command: process.execPath,
    args: [fakeAgent, '--config', s.configPath],
    env: {},
    mode: 'workspace-write',
    permissionPolicy: 'deny',
    ...patch,
  }
}

/** 与 `src/index.js` 的 factory 调用形状一致：只读 FLOW_STUDIO_ACP_CONFIG + tmpRoot。 */
function adapterFor(config, overrides = {}) {
  process.env.FLOW_STUDIO_ACP_CONFIG = JSON.stringify(config)
  return createAcpAdapter({
    tmpRoot: sandbox,
    probeTimeoutMs: 15_000,
    controlTimeoutMs: 8_000,
    helloTimeoutMs: 8_000,
    closeTimeoutMs: 800,
    cancelResponseGraceMs: 300,
    finishTailGraceMs: 1_000,
    killTimeoutMs: 300,
    ...overrides,
  })
}

function workspaceFor() {
  seq += 1
  const dir = join(sandbox, `ws-${seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function workflowXml({ processId, prompt = '判断并完结本节点。' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="defs-${processId}" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="${processId}" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="agent1" name="判定"><bpmn:extensionElements><fs:node nodeType="agent" adapter="acp" prompt="${prompt}" /></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:exclusiveGateway id="gw" default="f_fail"/>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="agent1" targetRef="gw"/>
    <bpmn:sequenceFlow id="f_pass" sourceRef="gw" targetRef="end"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="feel">= verdict = "pass"</bpmn:conditionExpression></bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_fail" sourceRef="gw" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
}

/** 起一个只装了 ACP adapter 的真实 runtime，并跑一个实例。 */
async function runAcpInstance({ config, adapterOverrides = {}, env = {}, xml, workspace, variables = {} }) {
  const adapter = adapterFor(config, adapterOverrides)
  const registry = createAdapterRegistry()
  registry.register(adapter)
  let runtime = null
  try {
    runtime = createBpmnRuntime({
      dir: join(sandbox, `fs-${++seq}`),
      env: { ...env },
      adapters: registry,
      workspaceRoot: workspace,
    })
    const saved = await runtime.handle({
      method: 'POST',
      parts: ['definitions'],
      body: { id: `flow-${seq}`, name: 'ACP P5', xml },
    })
    A.equal(saved.status, 201, `保存定义失败：${JSON.stringify(saved.body)}`)
    const created = await runtime.handle({
      method: 'POST',
      parts: ['instances'],
      body: { definitionId: saved.body.id, variables },
    })
    A.equal(created.status, 201, `创建实例失败：${JSON.stringify(created.body)}`)
    const detail = await runtime.handle({ method: 'GET', parts: ['instances', created.body.id] })
    A.equal(detail.status, 200, `读取实例失败：${JSON.stringify(detail.body)}`)
    const events = await runtime.handle({ method: 'GET', parts: ['instances', created.body.id, 'events'] })
    A.equal(events.status, 200)
    return { adapter, created: created.body, detail: detail.body, events: events.body.events, runtime }
  }
  finally {
    if (runtime !== null) await runtime.dispose()
  }
}

function instanceJson(runtime, id) {
  return JSON.parse(readFileSync(join(runtime.instancesRoot, id, 'instance.json'), 'utf8'))
}

function zeroPrompt(s) {
  return logEvents(s.logPath, 'prompt').length === 0
}

async function expectAdmissionFailure({ s, config, label }) {
  const workspace = workspaceFor()
  const result = await runAcpInstance({
    config,
    workspace,
    xml: workflowXml({ processId: `p-${seq}` }),
  })
  A.equal(result.detail.status, 'ACTIVE', `${label}：实例必须保持 ACTIVE（lastError 承载事实）`)
  A.equal(result.detail.lastError.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE, `${label}：lastError 必须是 TOOL_UNAVAILABLE`)
  A.equal(result.created.error?.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE, `${label}：创建响应 error.code 与 lastError 同口径`)
  A.ok(result.detail.lastError.message.length > 0, `${label}：lastError 必须可行动`)
  A.ok(!result.events.some(event => event.type === 'process/end'), `${label}：不得发 process/end`)
  A.ok(zeroPrompt(s), `${label}：admission 失败必须零 prompt（日志里不能出现 session/prompt）`)
  return result
}

try {
// ---------------------------------------------------------------------------
// 一、注册（真实 apply + /health）
// ---------------------------------------------------------------------------

function makeCtx() {
  const routes = []
  const warnings = []
  return {
    routes,
    warnings,
    logger: {
      warn(message) { warnings.push(String(message)) },
      info() {},
      error() {},
    },
    get(name) {
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'tools') return undefined
      return undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
  }
}

function call(handler, method, url, body) {
  return new Promise(resolveCall => {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = Readable.from(payload)
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
    req.socket = { remoteAddress: '127.0.0.1' }
    const res = {
      statusCode: 0,
      body: '',
      headersSent: false,
      writeHead(code) { this.statusCode = code; this.headersSent = true },
      end(chunk) {
        if (chunk !== undefined) this.body += chunk.toString()
        let json = {}
        try { json = JSON.parse(this.body) }
        catch { json = {} }
        resolveCall({ status: this.statusCode, json, body: this.body })
      },
    }
    handler(req, res)
  })
}

async function healthAdapters(configJson) {
  const previousHome = process.env.DSH_HOME
  const previousConfig = process.env.FLOW_STUDIO_ACP_CONFIG
  process.env.DSH_HOME = join(sandbox, 'home-apply')
  mkdirSync(process.env.DSH_HOME, { recursive: true })
  if (configJson === undefined) delete process.env.FLOW_STUDIO_ACP_CONFIG
  else process.env.FLOW_STUDIO_ACP_CONFIG = configJson
  try {
    const ctx = makeCtx()
    apply(ctx)
    A.equal(ctx.routes.length, 1, 'apply 必须注册一条 /api/flow-studio 前缀路由')
    A.equal(ctx.routes[0].path, '/api/flow-studio')
    const result = await call(ctx.routes[0].handler, 'GET', '/api/flow-studio/health')
    A.equal(result.status, 200, `health 必须 200：${result.body.slice(0, 200)}`)
    return result.json.adapters
  }
  finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousConfig === undefined) delete process.env.FLOW_STUDIO_ACP_CONFIG
    else process.env.FLOW_STUDIO_ACP_CONFIG = previousConfig
  }
}

await check('注册：apply 后 adapters 固定包含 acp，默认 dsh 与旧 adapter 不变', async () => {
  A.equal(DEFAULT_ADAPTER_ID, 'dsh', '默认 adapter 必须仍是 dsh')
  const s = scenario()
  const adapters = await healthAdapters(JSON.stringify(acpConfig(s)))
  A.deepEqual(adapters, ['acp', 'claude', 'codex', 'dsh'], '/health 的 adapter 列表必须是旧三个 + acp')
})

await check('注册：非法 FLOW_STUDIO_ACP_CONFIG 只让 ACP 不可用，不拖垮其它 adapter', async () => {
  const adapters = await healthAdapters('{not-json')
  A.deepEqual(adapters, ['acp', 'claude', 'codex', 'dsh'], '非法配置不能导致 acp 注销，也不能拖垮其它 adapter')
})

await check('注册：工厂只从 FLOW_STUDIO_ACP_CONFIG 读配置（非法配置启动即被拒绝）', async () => {
  const previous = process.env.FLOW_STUDIO_ACP_CONFIG
  process.env.FLOW_STUDIO_ACP_CONFIG = JSON.stringify({ command: process.execPath, args: [], unknownKey: true })
  try {
    const adapter = createAcpAdapter({ tmpRoot: sandbox })
    await A.rejects(adapter.probe(), error => error?.code === ADAPTER_ERROR.PROBE_INVALID)
    const caps = adapter.capabilities()
    A.equal(caps.finishTool, 'unsupported', '配置非法时能力必须诚实降级为 unsupported')
  }
  finally {
    if (previous === undefined) delete process.env.FLOW_STUDIO_ACP_CONFIG
    else process.env.FLOW_STUDIO_ACP_CONFIG = previous
  }
})

// ---------------------------------------------------------------------------
// 二、成功路径：真实 runtime + fake ACP agent + 真实 MCP finish
// ---------------------------------------------------------------------------

await check('集成·成功：activity/end、variables、documents、网关路由与现有 adapter 一致', async () => {
  const s = scenario({
    prompts: [{
      kind: 'finish',
      finishArgs: {
        variables: { verdict: 'pass', score: 87 },
        documents: [{ path: 'docs/verdict.md', kind: 'markdown', title: '结论' }],
        summary: '判定为 pass',
      },
    }],
  })
  const workspace = workspaceFor()
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  writeFileSync(join(workspace, 'docs', 'verdict.md'), '# 结论\npass\n')

  const result = await runAcpInstance({
    config: acpConfig(s),
    workspace,
    xml: workflowXml({ processId: 'p-success' }),
  })

  A.equal(result.detail.status, 'COMPLETED', `实例必须 COMPLETED：${JSON.stringify(result.detail.lastError || null)}`)
  A.deepEqual(result.detail.variables, { verdict: 'pass', score: 87 }, 'output 短变量必须合并进 instance.variables')
  A.deepEqual(result.detail.result, { verdict: 'pass', score: 87 }, 'result 取最后 agent 的 output')
  A.equal(result.detail.lastError, null, '成功时不能留 lastError')

  // documents → instance.json artifacts（正文只落在文件里，不进事件）。
  const raw = instanceJson(result.runtime, result.detail.id)
  A.equal(raw.artifacts.length, 1, 'documents 必须合并进 instance.json artifacts')
  A.equal(raw.artifacts[0].path, 'docs/verdict.md')
  A.equal(raw.artifacts[0].nodeId, 'agent1')
  A.equal(typeof raw.artifacts[0].sha256, 'string')

  const types = result.events.map(event => event.type)
  A.ok(types.includes('process/end'), '正常结束必须有 process/end')
  const ends = result.events.filter(event => event.type === 'activity/end' && event.elementId === 'agent1')
  A.equal(ends.length, 1, 'agent1 必须恰好一条 activity/end')
  A.deepEqual(ends[0].output, { verdict: 'pass', score: 87 }, 'activity/end 带 output')
  A.equal(ends[0].summary, '判定为 pass', 'activity/end 带 summary')
  A.equal(ends[0].artifacts?.[0]?.path, 'docs/verdict.md', 'activity/end 带 artifacts 引用')
  const taken = result.events.filter(event => event.type === 'flow/taken').map(event => event.flowId)
  A.ok(taken.includes('f_pass'), '网关必须按 verdict=pass 走 f_pass')
  A.ok(!taken.includes('f_fail'), '不能走默认 f_fail')

  // 真实 MCP 证据：agent 拉起 finish server、tools/list discovery、tools/call 成功。
  A.ok(logEvents(s.logPath, 'mcp-discovered').length > 0, 'fake agent 必须真的完成 MCP tools/list')
  const calls = logEvents(s.logPath, 'mcp-call')
  A.ok(calls.length > 0, 'finish 必须经真实 MCP tools/call')
  A.equal(calls.at(-1).isError, false, '真实 MCP call 必须成功')
  A.ok(logEvents(s.logPath, 'prompt').length >= 1, '正常路径必须真的发过 session/prompt')
})

// ---------------------------------------------------------------------------
// 三、admission 失败：TOOL_UNAVAILABLE + ACTIVE + 零 prompt
// ---------------------------------------------------------------------------

await check('集成·缺 CLI：TOOL_UNAVAILABLE、实例 ACTIVE、零 prompt', async () => {
  const s = scenario()
  const config = acpConfig(s, { command: join(sandbox, 'no-such-acp-cli'), args: [] })
  await expectAdmissionFailure({ s, config, label: '缺 CLI' })
})

await check('集成·认证失败（-32000）：TOOL_UNAVAILABLE、实例 ACTIVE、零 prompt', async () => {
  const s = scenario({ failNew: -32000 })
  const config = acpConfig(s)
  await expectAdmissionFailure({ s, config, label: '认证失败' })
})

await check('集成·不支持的 mode：TOOL_UNAVAILABLE、实例 ACTIVE、零 prompt', async () => {
  const s = scenario({
    modes: {
      currentModeId: 'read-only',
      availableModes: [{ id: 'read-only', name: 'Read-only' }],
    },
  })
  const config = acpConfig(s)
  await expectAdmissionFailure({ s, config, label: 'mode 不支持' })
})

await check('集成·agent 没拉起 MCP：TOOL_UNAVAILABLE、实例 ACTIVE、零 prompt', async () => {
  const s = scenario({ mcp: 'none' })
  const config = acpConfig(s)
  await expectAdmissionFailure({ s, config, label: 'MCP 未拉起' })
})

// ---------------------------------------------------------------------------
// 四、运行期失败：lastError 保留具体码
// ---------------------------------------------------------------------------

await check('集成·不调工具：NODE_FINISH_MISSING → ACTIVE + lastError，无 process/end', async () => {
  const s = scenario({ prompts: [{ kind: 'text' }, { kind: 'text' }, { kind: 'text' }, { kind: 'text' }] })
  const workspace = workspaceFor()
  const result = await runAcpInstance({
    config: acpConfig(s),
    workspace,
    xml: workflowXml({ processId: 'p-missing' }),
  })
  A.equal(result.detail.status, 'ACTIVE', '不调工具不是终态')
  A.equal(result.detail.lastError.code, 'NODE_FINISH_MISSING', 'lastError 必须保留 NODE_FINISH_MISSING')
  A.equal(result.created.error?.code, 'NODE_FINISH_MISSING', '创建响应 error.code 与 lastError 一致')
  A.ok(!result.events.some(event => event.type === 'process/end'), '不得发 process/end')
  A.equal(logEvents(s.logPath, 'prompt').length, 4, '1 次原始 prompt + 3 次提醒')
})

await check('集成·provider 错误：ACP_PROVIDER_ERROR → ACTIVE + 用量快照 + 无 process/end', async () => {
  // 先跑一轮拿到 usage 结算快照，再让下一轮 provider 错误：失败不能把已观测的账丢掉。
  const s = scenario({ prompts: [{ kind: 'text' }, { kind: 'provider-error' }] })
  const workspace = workspaceFor()
  const result = await runAcpInstance({
    config: acpConfig(s),
    workspace,
    xml: workflowXml({ processId: 'p-provider' }),
  })
  A.equal(result.detail.status, 'ACTIVE', 'provider 错误不是终态')
  A.equal(result.detail.lastError.code, 'ACP_PROVIDER_ERROR', 'lastError 必须保留 ACP_PROVIDER_ERROR')
  A.equal(result.created.error?.code, 'ACP_PROVIDER_ERROR', '创建响应 error.code 与 lastError 一致')
  A.ok(!result.events.some(event => event.type === 'process/end'), '不得发 process/end')
  A.ok(
    result.events.some(event => event.type === 'agent/usage-snapshot'),
    '第一轮已结算的用量快照必须在失败后仍落盘（不能因失败丢账）',
  )
  A.ok(
    result.events.some(event => event.type === 'agent/usage' && event.trust === 'unknown' && event.usage === undefined),
    '失败轮次必须落 unknown 用量（不造 0）',
  )
})

// ---------------------------------------------------------------------------
// 五、超时：BPMN_ACTIVITY_TIMEOUT
// ---------------------------------------------------------------------------

await check('集成·超时：BPMN_ACTIVITY_TIMEOUT、实例 ACTIVE、无 process/end', async () => {
  const s = scenario({ prompts: [{ kind: 'hang' }] })
  const workspace = workspaceFor()
  const result = await runAcpInstance({
    config: acpConfig(s),
    adapterOverrides: { cancelResponseGraceMs: 200, killTimeoutMs: 200, closeTimeoutMs: 500 },
    env: { FLOW_STUDIO_BPMN_ACTIVITY_TIMEOUT_MS: '3000' },
    workspace,
    xml: workflowXml({ processId: 'p-timeout' }),
  })
  A.equal(result.detail.status, 'ACTIVE', '活动超时后实例仍是 ACTIVE')
  A.equal(result.detail.lastError.code, 'BPMN_ACTIVITY_TIMEOUT', 'lastError 必须是活动预算超时')
  A.ok(!result.events.some(event => event.type === 'process/end'), '不得发 process/end')
  await waitFor(() => logEvents(s.logPath, 'prompt').length >= 1, '超时前必须真的派发过 prompt')
})

console.log(`✓ acp-integration：${checks} 组检查，${asserts} 条断言`)
}
finally {
  rmSync(sandbox, { recursive: true, force: true })
}
