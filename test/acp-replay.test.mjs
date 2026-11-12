#!/usr/bin/env node
/**
 * ACP 真实报文重放自检（0.15.0 / P4）。
 *
 * fixture `test/fixtures/acp-codex-2.6.0.ndjson` 是 codex-acp 2.6.0 的 18 帧实录脱敏副本
 * （邮箱 / 账户 / 路径 / sessionId 已替换，命令描述保留，**顺序不变**）。它只证明：
 *   - 文本轮次：`agent_message_chunk` → 「收到」；
 *   - 用量：prompt result 的 unstable usage → 18666（P2 账本直接记 invocation）；
 *   - 有界摘要：19 KB 的 `available_commands_update` 只留数量 + 前 10 个名称；
 *   - `_auth/status_update` 与 `_meta` 的账户信息永不落日志。
 *
 * 它**不证明** MCP 完结：session/new 的 `mcpServers` 是空数组，全程没有
 * `flow_finish_node`；因此重放不能把 `capabilities().finishTool` 变成 native。
 *
 * 跑：`node test/acp-replay.test.mjs`
 */

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAcpAdapter } from '../src/agent-adapter-acp.js'
import { createAcpEventMapper } from '../src/acp-events.js'
import { createAcpUsageLedger } from '../src/acp-usage-ledger.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = join(repoRoot, 'test', 'fixtures', 'acp-codex-2.6.0.ndjson')
const fixture = readFileSync(fixturePath, 'utf8')
const lines = fixture.split('\n').filter(line => line.trim() !== '')

let checks = 0
const assertCount = { value: 0 }
function ok(value, message) {
  assertCount.value += 1
  assert.ok(value, message)
}
function equal(actual, expected, message) {
  assertCount.value += 1
  assert.equal(actual, expected, message)
}
function deepEqual(actual, expected, message) {
  assertCount.value += 1
  assert.deepEqual(actual, expected, message)
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

console.log('acp-replay.js')

// ---------------------------------------------------------------------------
// 1. fixture 形状（18 帧 / 顺序 / commands ≥17 KB）
// ---------------------------------------------------------------------------
equal(lines.length, 18, 'fixture 必须保持 18 帧')
const frames = lines.map((line, index) => {
  const direction = line.slice(0, 2)
  ok(direction === '->' || direction === '<-', `第 ${index + 1} 帧方向合法`)
  return { direction, body: JSON.parse(line.slice(3)) }
})
equal(frames.filter(frame => frame.direction === '->').length, 5, '5 条 client 请求')
equal(frames.filter(frame => frame.direction === '<-').length, 13, '13 条 server 消息')
equal(frames[0].body.method, 'initialize', '首帧顺序：initialize')

const newFrame = frames.find(frame => frame.body.id === 2 && frame.body.result)
deepEqual(newFrame.body.result.modes.availableModes.map(mode => mode.id), [
  'read-only', 'workspace-write', 'agent', 'agent-full-access',
], 'session/new 的 availableModes 原样保留')
deepEqual(newFrame.body.params ?? {}, {}, 'session/new 是响应，无 params')
const newRequest = frames.find(frame => frame.direction === '->' && frame.body.id === 2)
deepEqual(newRequest.body.params.mcpServers, [], '实录没有 MCP server：不能证明 finish')

const commandsFrame = frames.find(frame =>
  frame.body?.params?.update?.sessionUpdate === 'available_commands_update')
ok(commandsFrame !== undefined, '有 available_commands_update 帧')
ok(jsonBytes(commandsFrame.body) >= 17 * 1024,
  `commands 帧 ≥17 KB（实际 ${jsonBytes(commandsFrame.body)}）`)

const promptResult = frames.find(frame => frame.body.id === 4 && frame.body.result)
ok(promptResult !== undefined, '有 prompt result 帧')
const promptRequest = frames.find(frame => frame.direction === '->' && frame.body.id === 4)
equal(promptRequest.body.params.prompt[0].text, '请只回复两个字：收到')

// 重放本身不能当 MCP 完结证据：没有工具名、mcpServers 为空。
equal(fixture.includes('flow_finish_node'), false, '18 帧里没有 flow_finish_node')
equal(fixture.includes('mcpServers":[{"'), false, '18 帧里没有非空 mcpServers')

// ---------------------------------------------------------------------------
// 2. 重放：P3 事件投影 + P2 用量账本
// ---------------------------------------------------------------------------
const sessionId = newFrame.body.result.sessionId
equal(typeof sessionId, 'string')
const agentInfo = frames.find(frame => frame.body.id === 1 && frame.body.result).body.result.agentInfo
deepEqual(agentInfo, {
  name: '@agentclientprotocol/codex-acp',
  title: 'Codex',
  version: '2.6.0',
}, 'replay 的 agentInfo 是已验收 profile')

const events = []
const mapper = createAcpEventMapper({ emit: event => events.push(event) })
mapper.bindSession(sessionId)
const invocationId = 'replay-exec:invoke-1'
mapper.beginTurn(invocationId)

const ledger = createAcpUsageLedger({
  executionId: 'replay-exec',
  sessionId,
  agentInfo,
})
ledger.begin(invocationId)

let ignoredAuth = 0
let promptResultSeen = false
for (const frame of frames) {
  if (frame.direction !== '<-') continue
  const body = frame.body
  if (body.method === '_auth/status_update') {
    const result = mapper.apply({ method: body.method, params: body.params })
    equal(result.ignored, 'auth_status_update', '_auth/status_update 完全忽略')
    ignoredAuth += 1
    continue
  }
  if (body.method === 'session/update') {
    mapper.apply({ method: body.method, params: body.params })
    continue
  }
  if (body.id === 4 && body.result) {
    promptResultSeen = true
    ledger.end(invocationId, body.result)
  }
}
mapper.endTurn()
equal(ignoredAuth, 1, '恰好一帧 _auth/status_update')
equal(promptResultSeen, true, 'prompt result 被重放')

// ---------------------------------------------------------------------------
// 3. 文本 / 用量
// ---------------------------------------------------------------------------
equal(events.length, 1, '只有 agent_message_chunk 产生业务事件')
equal(events[0].type, 'activity/output')
equal(events[0].text, '收到', '真实回复文本')
equal(events[0].sessionId, sessionId)
equal(events[0].invocationId, invocationId)

const snapshots = ledger.usageSnapshots()
equal(snapshots.length, 1, '一个 prompt 一条结算快照')
const snapshot = snapshots[0]
equal(snapshot.provider, 'acp')
equal(snapshot.scope, 'invocation')
equal(snapshot.invocationId, invocationId)
equal(snapshot.sessionScopeId, sessionId)
equal(snapshot.usage.total, 18666, '18666 来自 prompt result 的四桶')
equal(snapshot.usage.input, 6501)
equal(snapshot.usage.cacheRead, 12160)
equal(snapshot.usage.cacheWrite, 0)
equal(snapshot.usage.output, 5)
deepEqual(snapshot.observedBuckets, ['input', 'cacheRead', 'cacheWrite', 'output'])

// usage_update.used/size 只进诊断，不是 token、不是快照。
const diagAfter = mapper.diagnostics()
const usageLog = diagAfter.logs.find(entry => entry.kind === 'usage_update')
ok(usageLog !== undefined, 'usage_update 只进有界诊断')
equal(usageLog.used, 18666)
equal(usageLog.size, 258400)
equal('usage' in usageLog, false, '诊断里没有把 used/size 变成 token')
equal(snapshot.usage.total === usageLog.size, false, 'size 不是 token 总量')

// ---------------------------------------------------------------------------
// 4. commands 摘要 / 账户与 _meta 不落盘
// ---------------------------------------------------------------------------
const commandsLog = diagAfter.logs.find(entry => entry.kind === 'available_commands_update')
ok(commandsLog !== undefined, 'commands 进入有界摘要')
equal(commandsLog.count, 56, 'commands 总数')
equal(commandsLog.names.length, 10, '只留前 10 个名称')
equal(commandsLog.truncated, true)

const payload = JSON.stringify({ events, diagnostics: diagAfter, snapshots })
equal(payload.includes('Turn plan mode on.'), false, 'commands 描述不落盘')
equal(payload.includes('Show the status of the MCP servers'), false, 'commands 描述不落盘（第二条）')
equal(payload.includes('user@example.invalid'), false, '账户 email 不落盘')
equal(payload.includes('Replay Account'), false, '账户 label 不落盘')
equal(payload.includes('threadStatus'), false, '_meta.threadStatus 不落盘')
equal(payload.includes('activeFlags'), false, '_meta.activeFlags 不落盘')
equal(payload.includes('请只回复两个字'), false, 'session title 不落盘')

// ---------------------------------------------------------------------------
// 5. 重放 ≠ MCP 完结证据：适配器仍必须 probe
// ---------------------------------------------------------------------------
const adapter = createAcpAdapter({
  config: {
    command: process.execPath,
    args: [],
    env: {},
    mode: 'workspace-write',
    permissionPolicy: 'deny',
  },
  tmpRoot: join(repoRoot, '.tmp'),
})
equal(adapter.capabilities().finishTool, 'unsupported',
  '18 帧重放不能把 finishTool 变成 native；native 只由 probe 的 MCP discovery 决定')
equal(adapter.capabilities().evidence.realChannel.includes('未验证'), true)

checks += 1
console.log(`\nacp-replay.js：${checks} 组 / ${assertCount.value} 条断言全部通过`)
