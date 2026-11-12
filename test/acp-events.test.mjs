#!/usr/bin/env node
/**
 * ACP 事件投影自检（0.15 ACP P3）。
 *
 * 覆盖方案 P3 的硬约束：
 *   - 文本整轮暂存、endTurn 整段脱敏后切 ≤2 KiB；秘密跨 chunk / 2 KiB 边界 / 轮末
 *     半截都不泄露；execution 64 KiB 超额整轮丢弃且只发一次 truncated；
 *   - 工具按 id 合并、content/locations 整体替换、null 省略、孤立 update 标 partial、
 *     每 turn 256 个 id 上限；rawInput/name 正文绝不进事件；
 *   - 17 KB commands 只留 count + 前 10 个名称；`_auth/status_update` / `_meta` 完全忽略；
 *   - 18 帧真实 transcript replay：不崩、只有允许的变体产生业务事件。
 *
 * 跑：`node test/acp-events.test.mjs`（不联网、不依赖 dsh）。
 */

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ACP_COMMAND_NAME_MAX_BYTES,
  ACP_EVENT_MAX_BYTES,
  ACP_LOG_ENTRY_MAX_BYTES,
  ACP_LOG_MAX_BYTES,
  ACP_LOG_MAX_ENTRIES,
  ACP_MAX_TOOL_IDS_PER_TURN,
  ACP_TEXT_EVENT_MAX_BYTES,
  createAcpEventMapper,
} from '../src/acp-events.js'

let checks = 0
let assertions = 0

const A = {
  equal(actual, expected, message) {
    assertions += 1
    assert.equal(actual, expected, message)
  },
  deepEqual(actual, expected, message) {
    assertions += 1
    assert.deepEqual(actual, expected, message)
  },
  ok(value, message) {
    assertions += 1
    assert.ok(value, message)
  },
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

function collector() {
  const events = []
  return { events, emit: event => events.push(event) }
}

function textBytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function eventsOf(events, type) {
  return events.filter(event => event.type === type)
}

function update(sessionId, patch) {
  return { sessionId, update: patch }
}

console.log('acp-events.js')

// ---------------------------------------------------------------------------
// 文本
// ---------------------------------------------------------------------------

await check('agent_message_chunk 整轮暂存：endTurn 才发 activity/output，身份字段齐全', () => {
  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  A.equal(mapper.bindSession('session-1'), true, 'bindSession 接受非空 id')
  mapper.beginTurn('inv-1')
  const r1 = mapper.apply(update('session-1', {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'msg-1',
    content: { type: 'text', text: 'hello ' },
  }))
  const r2 = mapper.apply(update('session-1', {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'msg-1',
    content: { type: 'text', text: 'world' },
  }))
  A.equal(r1.emitted, 0, 'chunk 到达时不发事件')
  A.equal(r2.emitted, 0, 'chunk 到达时不发事件')
  A.equal(sink.events.length, 0, 'endTurn 之前不 flush')
  const end = mapper.endTurn()
  A.equal(end.emitted, 1, '一轮文本合成一条事件')
  A.equal(sink.events.length, 1, '只发一条')
  const event = sink.events[0]
  A.equal(event.type, 'activity/output', '事件类型')
  A.equal(event.provider, 'acp', 'provider')
  A.equal(event.sessionId, 'session-1', 'sessionId')
  A.equal(event.invocationId, 'inv-1', 'invocationId')
  A.equal(event.messageId, 'msg-1', 'messageId')
  A.equal(event.text, 'hello world', 'chunk 按到达顺序拼接')
  A.equal(mapper.endTurn().emitted, 0, 'endTurn 幂等')
  A.equal(sink.events.length, 1, '重复 endTurn 不再发事件')
})

await check('2 KiB 切分：每条 ≤2048 字节、不切坏 UTF-8、拼接等于原文', () => {
  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  mapper.bindSession('s')
  mapper.beginTurn('i')
  const text = `${'a'.repeat(4095)}😀${'b'.repeat(5000)}`
  mapper.apply(update('s', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  }))
  A.equal(mapper.endTurn().emitted, Math.ceil(textBytes(text) / ACP_TEXT_EVENT_MAX_BYTES), '按 2 KiB 切片数')
  A.ok(sink.events.length >= 5, '长文本被切成多条')
  let joined = ''
  for (const event of sink.events) {
    A.equal(event.type, 'activity/output', '切片事件类型')
    A.ok(textBytes(event.text) <= ACP_TEXT_EVENT_MAX_BYTES, `单条文本 ≤2 KiB（实际 ${textBytes(event.text)}）`)
    A.ok(jsonBytes(event) <= ACP_EVENT_MAX_BYTES, `单条事件 ≤4 KiB（实际 ${jsonBytes(event)}）`)
    A.ok(Buffer.from(event.text, 'utf8').toString('utf8') === event.text, 'UTF-8 往返一致（没有半个字符）')
    A.ok(!event.text.includes('\uFFFD'), '没有替换字符')
    joined += event.text
  }
  A.equal(joined, text, '所有切片拼接后与原文一致')
})

await check('身份字段限长：超长 sessionId/invocationId 不把事件撑过 4 KiB', () => {
  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  const longSession = 'session-' + 's'.repeat(10_000)
  const longInvocation = 'inv-' + 'i'.repeat(10_000)
  mapper.bindSession(longSession)
  mapper.beginTurn(longInvocation)
  mapper.apply(update(longSession, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'ok' },
  }))
  mapper.endTurn()
  A.equal(sink.events.length, 1, '仍只有一条事件')
  const event = sink.events[0]
  A.ok(textBytes(event.sessionId) <= 128, 'sessionId 限长到 128 字节')
  A.ok(textBytes(event.invocationId) <= 128, 'invocationId 限长到 128 字节')
  A.ok(jsonBytes(event) <= ACP_EVENT_MAX_BYTES, '单条事件 ≤4 KiB')
  A.equal(event.text, 'ok', '正文不被身份字段挤掉')
})

await check('秘密跨 chunk：先整段脱敏再切分，事件里没有秘密或半截', () => {
  const sink = collector()
  const secret = 'TOPSECRET_MATERIAL_987654321'
  const mapper = createAcpEventMapper({ emit: sink.emit, secrets: [secret] })
  mapper.bindSession('s')
  mapper.beginTurn('i')
  // 秘密被拆成两个 chunk，逐 chunk 脱敏会留下两半。
  mapper.apply(update('s', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'lead TOPSECRET_' },
  }))
  mapper.apply(update('s', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'MATERIAL_987654321 tail' },
  }))
  mapper.endTurn()
  const payload = JSON.stringify(sink.events)
  A.ok(!payload.includes(secret), '完整秘密不出现')
  A.ok(!payload.includes('TOPSECRET_'), '秘密前半段不出现')
  A.ok(!payload.includes('MATERIAL_987654321'), '秘密后半段不出现')
  const joined = sink.events.map(event => event.text).join('')
  A.ok(!joined.includes('TOPSECRET_'), '拼接后秘密前半段不出现')
  A.ok(!joined.includes('MATERIAL_987654321'), '拼接后秘密后半段不出现')
  A.ok(joined.includes('[redacted]'), '显式秘密替换成 [redacted]')
})

await check('秘密跨 2 KiB 边界 + 轮末半截：都不会漏出', () => {
  const sink = collector()
  // 纯小写+数字：逐 chunk redactText 的「连续可疑串」规则不会误伤两半，
  // 因此只有「先拼接整段再脱敏」才能拦住它。
  const secret = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const mapper = createAcpEventMapper({ emit: sink.emit, secrets: [secret] })
  mapper.bindSession('s')
  mapper.beginTurn('i')
  // 让秘密正好跨在 2048 字节边界，并且分两个 chunk 送入：
  // 逐 chunk 脱敏时两半都不到 redactText 的「≥32 连续可疑串」门槛。
  mapper.apply(update('s', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `${'a'.repeat(2040)}${secret.slice(0, 8)}` },
  }))
  mapper.apply(update('s', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `${secret.slice(8)} tail` },
  }))
  mapper.endTurn()
  const payload = JSON.stringify(sink.events)
  const joined = sink.events.map(event => event.text).join('')
  A.ok(!payload.includes(secret), '完整秘密不出现')
  A.ok(!payload.includes('abcdefghij'), '秘密前缀不出现')
  // 关键：事件边界会把 JSON 串切成两段，所以还要看「拼接后的文本」。
  A.ok(!joined.includes(secret), '拼接所有事件后完整秘密也不出现')
  A.ok(!joined.includes('abcdefghij'), '拼接后秘密前缀也不出现')
  A.ok(!joined.includes('uvwxyz0123456789'), '拼接后秘密后半段也不出现')
  for (const event of sink.events) {
    A.ok(textBytes(event.text) <= ACP_TEXT_EVENT_MAX_BYTES, '仍按 2 KiB 切分')
  }

  // 轮末只有秘密的半截（完整秘密永远不会出现）。
  const sink2 = collector()
  const mapper2 = createAcpEventMapper({ emit: sink2.emit, secrets: ['FULL_SECRET_VALUE_9000'] })
  mapper2.bindSession('s')
  mapper2.beginTurn('i')
  mapper2.apply(update('s', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'prefix FULL_SECRET_VAL' },
  }))
  mapper2.endTurn()
  const payload2 = JSON.stringify(sink2.events)
  A.ok(!payload2.includes('FULL_SECRET_VAL'), '轮末半截前缀不出现')
  A.ok(sink2.events[0].text.endsWith('[redacted]'), '半截前缀被替换成 [redacted]')
})

await check('execution 64 KiB 预算：超额整轮丢弃，只发一次 truncated 标记', () => {
  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  mapper.bindSession('s')
  mapper.beginTurn('i1')
  mapper.apply(update('s', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'a'.repeat(10 * 1024) },
  }))
  mapper.endTurn()
  const firstTurnEvents = sink.events.length
  A.ok(firstTurnEvents > 0, '预算内的第一轮正常输出')

  mapper.beginTurn('i2')
  mapper.apply(update('s', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Z'.repeat(60 * 1024) },
  }))
  const second = mapper.endTurn()
  A.equal(second.truncated, true, '超额轮标记 truncated')
  A.equal(second.emitted, 1, '只发一条标记')
  const markers = sink.events.filter(event => event.truncated === true)
  A.equal(markers.length, 1, '整个 execution 只有一条 truncated 标记')
  A.equal(markers[0].type, 'activity/output', '标记也是允许的文本事件')
  A.ok(markers[0].text.includes('truncated'), '标记文本可识别')

  mapper.beginTurn('i3')
  mapper.apply(update('s', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'b'.repeat(1024) },
  }))
  const third = mapper.endTurn()
  A.equal(third.emitted, 0, '预算耗尽后的下一轮整轮丢弃')
  A.equal(sink.events.filter(event => event.truncated === true).length, 1, '不再发第二条标记')

  const diag = mapper.diagnostics()
  A.equal(diag.output.truncated, true, '诊断标记 truncated')
  A.equal(diag.output.droppedTurns, 1, '只记一次整轮丢弃')
  A.ok(diag.output.acceptedBytes <= 64 * 1024, '接受的原始文本不超过 64 KiB')
  for (const event of sink.events) {
    A.ok(!event.text || !event.text.includes('ZZZZ'), '超额轮文本没有漏出')
  }
})

// ---------------------------------------------------------------------------
// 工具调用
// ---------------------------------------------------------------------------

await check('tool_call 合并：整体替换 content/locations、null 省略、重复 completed 只发一次 end', () => {
  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  mapper.bindSession('s')
  mapper.beginTurn('i')
  mapper.apply(update('s', {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Read file',
    name: 'raw-name-canary',
    kind: 'read',
    status: 'in_progress',
    content: [{ type: 'content' }, { type: 'content' }],
    locations: [{ path: '/workspace/a' }],
    rawInput: { path: '/workspace/RAW_INPUT_CANARY' },
    rawOutput: 'RAW_OUTPUT_CANARY',
  }))
  let starts = eventsOf(sink.events, 'tool/start')
  A.equal(starts.length, 1, 'tool_call 发一次 start')
  A.equal(starts[0].toolCallId, 't1', 'toolCallId')
  A.equal(starts[0].title, 'Read file', 'title')
  A.equal(starts[0].toolKind, 'read', 'toolKind')
  A.equal(starts[0].status, 'in_progress', 'status')
  A.equal(starts[0].contentCount, 2, 'contentCount 初始值')
  A.equal(starts[0].locationCount, 1, 'locationCount 初始值')
  const raw = JSON.stringify(sink.events)
  A.ok(!raw.includes('RAW_INPUT_CANARY'), 'rawInput 正文不进事件')
  A.ok(!raw.includes('RAW_OUTPUT_CANARY'), 'rawOutput 正文不进事件')
  A.ok(!raw.includes('raw-name-canary'), 'name 正文不进事件')
  A.ok(!raw.includes('rawInput'), '事件没有 rawInput 字段')

  // content/locations 整体替换（不是累加）。
  mapper.apply(update('s', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 't1',
    content: [{ type: 'content' }, { type: 'content' }, { type: 'content' }],
    locations: [{ path: '/workspace/a' }, { path: '/workspace/b' }],
  }))
  let updates = eventsOf(sink.events, 'tool/update')
  A.equal(updates.length, 1, 'update 发一条 tool/update')
  A.equal(updates[0].contentCount, 3, 'content 整体替换为 3')
  A.equal(updates[0].locationCount, 2, 'locations 整体替换为 2')

  // null / undefined 视作省略，不把计数值清掉。
  mapper.apply(update('s', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 't1',
    content: null,
    locations: null,
    title: null,
    status: null,
  }))
  updates = eventsOf(sink.events, 'tool/update')
  A.equal(updates.length, 2, 'null 字段仍产生一条无变化 update')
  A.equal(updates[1].contentCount, 3, 'content:null 不改变计数')
  A.equal(updates[1].locationCount, 2, 'locations:null 不改变计数')
  A.equal(updates[1].title, 'Read file', 'title:null 不改变标题')

  // completed → update + end；重复 completed 不再发 end。
  mapper.apply(update('s', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 't1',
    status: 'completed',
  }))
  A.equal(eventsOf(sink.events, 'tool/end').length, 1, '终态只发一次 end')
  A.equal(eventsOf(sink.events, 'tool/end')[0].status, 'completed', 'end 带终态')
  mapper.apply(update('s', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 't1',
    status: 'completed',
  }))
  A.equal(eventsOf(sink.events, 'tool/end').length, 1, '重复 completed 不重复 end')
  A.equal(eventsOf(sink.events, 'tool/start').length, 1, 'start 按 id 最多一次')

  // 空数组是合法的整体替换（计数归零），不是省略。
  mapper.apply(update('s', {
    sessionUpdate: 'tool_call',
    toolCallId: 't2',
    title: 'Shell',
    kind: 'execute',
    status: 'pending',
    content: [{ type: 'content' }],
    locations: [{ path: '/workspace/x' }],
  }))
  mapper.apply(update('s', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 't2',
    content: [],
    locations: [],
  }))
  const t2Update = sink.events.filter(event => event.type === 'tool/update' && event.toolCallId === 't2').at(-1)
  A.equal(t2Update.contentCount, 0, 'content:[] 整体替换为 0')
  A.equal(t2Update.locationCount, 0, 'locations:[] 整体替换为 0')
  A.equal(mapper.diagnostics().tools.overflow, 0, '没有溢出')
})

await check('孤立 tool_call_update 标 partial、不伪造 start；后续真实 tool_call 再补 start', () => {
  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  mapper.bindSession('s')
  mapper.beginTurn('i')
  mapper.apply(update('s', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'orphan',
    status: 'in_progress',
    content: [{ type: 'content' }],
  }))
  A.equal(eventsOf(sink.events, 'tool/start').length, 0, '孤立 update 不伪造 start')
  const orphanUpdate = eventsOf(sink.events, 'tool/update')[0]
  A.equal(orphanUpdate.toolCallId, 'orphan', '孤立 update 保留 id')
  A.equal(orphanUpdate.partial, true, '孤立 update 标 partial')

  mapper.apply(update('s', {
    sessionUpdate: 'tool_call',
    toolCallId: 'orphan',
    title: 'Late start',
    kind: 'other',
    status: 'pending',
  }))
  A.equal(eventsOf(sink.events, 'tool/start').length, 1, '真实 tool_call 补一次 start')
  A.equal(eventsOf(sink.events, 'tool/start')[0].toolCallId, 'orphan', 'start 属于同一个 id')
})

await check('每 turn 最多 256 个 toolCallId：溢出只记计数', () => {
  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  mapper.bindSession('s')
  mapper.beginTurn('i')
  for (let index = 0; index < ACP_MAX_TOOL_IDS_PER_TURN + 4; index += 1) {
    mapper.apply(update('s', {
      sessionUpdate: 'tool_call',
      toolCallId: `tool-${index}`,
      title: `Tool ${index}`,
      kind: 'other',
      status: 'pending',
    }))
  }
  A.equal(sink.events.length, ACP_MAX_TOOL_IDS_PER_TURN, '只跟踪并发出 256 个 start')
  const diag = mapper.diagnostics()
  A.equal(diag.tools.ids, ACP_MAX_TOOL_IDS_PER_TURN, '内部只保留 256 个 id')
  A.equal(diag.tools.overflow, 4, '溢出 4 个只记计数')
})

// ---------------------------------------------------------------------------
// 摘要 / 日志边界
// ---------------------------------------------------------------------------

await check('17 KB commands 只留 count + 前 10 个名称（≤64B），描述不落盘', () => {
  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  mapper.bindSession('s')
  mapper.beginTurn('i')
  const commands = Array.from({ length: 120 }, (_, index) => ({
    name: `command-${index}-${'x'.repeat(80)}`,
    description: `DESCRIPTION_CANARY_${index} ${'d'.repeat(120)}`,
    input: { hint: `HINT_CANARY_${index}` },
  }))
  const frame = update('s', { sessionUpdate: 'available_commands_update', availableCommands: commands })
  A.ok(jsonBytes(frame) >= 17 * 1024, `commands 帧 ≥17 KB（实际 ${jsonBytes(frame)}）`)
  const result = mapper.apply(frame)
  A.equal(result.emitted, 0, 'commands 是摘要，不是业务事件')
  const diag = mapper.diagnostics()
  const entry = diag.logs.find(log => log.kind === 'available_commands_update')
  A.ok(entry !== undefined, '诊断里有 commands 摘要')
  A.equal(entry.count, 120, '保留总数')
  A.equal(entry.names.length, 10, '只保留前 10 个名称')
  for (const name of entry.names) {
    A.ok(textBytes(name) <= ACP_COMMAND_NAME_MAX_BYTES, `名称 ≤64B（实际 ${textBytes(name)}）`)
  }
  A.equal(entry.truncated, true, '截断标记')
  const payload = JSON.stringify(diag)
  A.ok(!payload.includes('DESCRIPTION_CANARY'), '描述不落盘')
  A.ok(!payload.includes('HINT_CANARY'), 'input.hint 不落盘')
  A.ok(!payload.includes('ddd'), '长描述正文不落盘')
  A.ok(jsonBytes(entry) <= ACP_LOG_ENTRY_MAX_BYTES, '单条日志 ≤1 KiB')
})

await check('日志上限：每连接 ≤50 条、合计 ≤16 KiB，满了只计数', () => {
  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  mapper.bindSession('s')
  mapper.beginTurn('i')
  for (let index = 0; index < 200; index += 1) {
    mapper.apply(update('s', {
      sessionUpdate: 'config_option_update',
      configOptions: Array.from({ length: 5 }, (_, item) => ({ id: `opt-${item}` })),
    }))
  }
  const diag = mapper.diagnostics()
  A.ok(diag.logs.length <= ACP_LOG_MAX_ENTRIES, '日志条数上限')
  A.ok(diag.logBytes <= ACP_LOG_MAX_BYTES, '日志总字节上限')
  A.ok(diag.droppedLogs > 0, '超出后只记 dropped 计数')
  for (const entry of diag.logs) {
    A.ok(jsonBytes(entry) <= ACP_LOG_ENTRY_MAX_BYTES, '每条日志 ≤1 KiB')
  }
})

await check('_auth/status_update 与 _meta 完全忽略：账户/元数据哨兵不出现', () => {
  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  mapper.bindSession('s')
  mapper.beginTurn('i')
  mapper.apply({
    method: '_auth/status_update',
    params: { authStatus: { kind: 'account', label: 'ACCOUNT_LABEL_CANARY', account: { email: 'ACCOUNT_EMAIL_CANARY@example.invalid' } } },
  })
  mapper.apply(update('s', {
    sessionUpdate: 'session_info_update',
    title: 'SESSION_TITLE_CANARY',
    _meta: { secret: 'META_CANARY_123', image: 'META_IMAGE_CANARY' },
    updatedAt: '2026-01-01T00:00:00Z',
  }))
  mapper.apply(update('s', {
    sessionUpdate: 'agent_message_chunk',
    _meta: { secret: 'CHUNK_META_CANARY' },
    content: { type: 'text', text: 'ok' },
  }))
  mapper.endTurn()
  const payload = JSON.stringify({ events: sink.events, diag: mapper.diagnostics() })
  A.ok(!payload.includes('ACCOUNT_LABEL_CANARY'), '账户 label 不出现')
  A.ok(!payload.includes('ACCOUNT_EMAIL_CANARY'), '账户 email 不出现')
  A.ok(!payload.includes('META_CANARY'), 'session_info._meta 不出现')
  A.ok(!payload.includes('META_IMAGE_CANARY'), 'session_info._meta.image 不出现')
  A.ok(!payload.includes('CHUNK_META_CANARY'), 'chunk._meta 不出现')
  A.ok(!payload.includes('SESSION_TITLE_CANARY'), 'session_info.title 不进日志')
  const diag = mapper.diagnostics()
  A.equal(diag.counters.authStatusUpdates, 1, '只计数 _auth/status_update')
  A.ok(diag.logs.some(log => log.kind === 'session_info_update'), 'session_info 只留 kind')
})

// ---------------------------------------------------------------------------
// 错误输入 / 权限 / dispose
// ---------------------------------------------------------------------------

await check('错 session / 未知变体 / 坏输入：无业务事件、不抛错、诊断有界', () => {
  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  mapper.bindSession('session-1')
  mapper.beginTurn('i')
  A.equal(mapper.apply(update('session-2', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'WRONG_SESSION_CANARY' },
  })).emitted, 0, '错 session 不投影')
  A.equal(sink.events.length, 0, '错 session 零事件')
  A.equal(mapper.diagnostics().counters.sessionMismatch, 1, '错 session 只计数')

  mapper.apply(update('session-1', {
    sessionUpdate: 'mystery_update',
    raw: 'UNKNOWN_RAW_CANARY_'.repeat(100),
  }))
  A.equal(sink.events.length, 0, '未知变体不产生业务事件')
  const diag = mapper.diagnostics()
  A.equal(diag.counters.unknownUpdates, 1, '未知变体计数')
  A.ok(diag.logs.some(log => log.kind === 'unknown_update'), '未知变体只留 kind/计数')
  A.ok(!JSON.stringify(diag).includes('UNKNOWN_RAW_CANARY'), '未知变体原始内容不落盘')

  // 坏输入不抛错、不杀连接。
  for (const bad of [null, [], 'x', { sessionId: 'session-1' }, { sessionId: 'session-1', update: {} }]) {
    const result = mapper.apply(bad)
    A.equal(result.ok, true, '坏输入返回结构化结果而不是抛错')
    A.equal(result.emitted, 0, '坏输入不产生业务事件')
  }
  A.equal(sink.events.length, 0, '整个过程零业务事件')
})

await check('权限事件：requestId/toolCallId/decision/optionId，且不带 tool 正文', () => {
  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  mapper.bindSession('s1')
  mapper.beginTurn('i')
  mapper.apply({
    requestId: 'req-1',
    params: {
      sessionId: 's1',
      toolCall: { toolCallId: 'tool-1', rawInput: { secret: 'PERMISSION_RAW_CANARY' }, title: 'Run' },
      options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }],
    },
    decision: 'allow',
    optionId: 'a',
  })
  const permissions = eventsOf(sink.events, 'agent/permission')
  A.equal(permissions.length, 1, '发一条 agent/permission')
  A.equal(permissions[0].requestId, 'req-1', 'requestId')
  A.equal(permissions[0].toolCallId, 'tool-1', 'toolCallId')
  A.equal(permissions[0].decision, 'allow', 'decision')
  A.equal(permissions[0].optionId, 'a', 'optionId 原样')
  A.ok(!JSON.stringify(permissions[0]).includes('PERMISSION_RAW_CANARY'), '不带 toolCall 正文')

  mapper.apply({
    requestId: 'req-2',
    params: { sessionId: 'other', toolCall: {}, options: [] },
    decision: 'deny',
  })
  A.equal(eventsOf(sink.events, 'agent/permission').length, 1, '错 session 的权限请求不投影')

  // JSON-RPC 外壳把请求 id 放在顶层 id 时也能投影。
  mapper.apply({
    method: 'session/request_permission',
    id: 7,
    params: { sessionId: 's1', toolCall: { toolCallId: 'tool-7' }, options: [] },
    decision: 'deny',
    optionId: 'reject-7',
  })
  const idFallback = eventsOf(sink.events, 'agent/permission').at(-1)
  A.equal(idFallback.requestId, '7', '顶层 id 回退为 requestId')
  A.equal(idFallback.decision, 'deny', '保留决策')

  mapper.apply({
    requestId: 'req-3',
    sessionId: 's1',
    decision: 'cancelled',
    options: [],
  })
  const cancelledEvent = eventsOf(sink.events, 'agent/permission').at(-1)
  A.equal(cancelledEvent.decision, 'cancelled', '取消决策')
  A.equal(cancelledEvent.optionId, undefined, '取消不带 optionId')
})

await check('dispose 丢弃未提交缓存且后续 apply 不再投影', () => {
  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  mapper.bindSession('s')
  mapper.beginTurn('i')
  mapper.apply(update('s', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'DISCARD_ME_CANARY' },
  }))
  mapper.dispose()
  A.equal(mapper.endTurn().emitted, 0, 'dispose 后 endTurn 不 flush')
  A.equal(sink.events.length, 0, '没有任何事件')
  const result = mapper.apply(update('s', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'after dispose' },
  }))
  A.equal(result.ok, false, 'dispose 后 apply 返回失败')
  A.equal(result.ignored, 'disposed', '失败原因')
  const diag = mapper.diagnostics()
  A.equal(diag.disposed, true, '诊断标记 disposed')
  A.equal(diag.logs.length, 0, '缓存已丢弃')
})

// ---------------------------------------------------------------------------
// 18 帧真实 transcript replay（sanitize 过账号 / 路径 / sessionId，保持帧序）
// ---------------------------------------------------------------------------

await check('18 帧真实 transcript replay：不崩、只有允许的变体产生业务事件', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const fixture = readFileSync(join(here, 'fixtures', 'acp-events-replay.ndjson'), 'utf8')
  const lines = fixture.split('\n').filter(line => line.trim() !== '')
  A.equal(lines.length, 18, 'fixture 保持 18 帧')
  const frames = lines.map(line => ({ direction: line.slice(0, 2), body: JSON.parse(line.slice(3)) }))
  const commandsFrame = frames.find(frame => frame.body?.params?.update?.sessionUpdate === 'available_commands_update')
  A.ok(commandsFrame !== undefined, '有 available_commands_update 帧')
  A.ok(jsonBytes(commandsFrame.body) >= 17 * 1024, `commands 帧 ≥17 KB（实际 ${jsonBytes(commandsFrame.body)}）`)

  const sink = collector()
  const mapper = createAcpEventMapper({ emit: sink.emit })
  const sessionId = frames.find(frame => frame.body?.result?.sessionId !== undefined).body.result.sessionId
  mapper.bindSession(sessionId)
  mapper.beginTurn('inv-replay')
  let authIgnored = 0
  for (const frame of frames) {
    if (frame.direction !== '<-') continue
    const method = frame.body?.method
    if (method === '_auth/status_update') {
      const result = mapper.apply({ method, params: frame.body.params })
      A.equal(result.ignored, 'auth_status_update', '_auth/status_update 完全忽略')
      authIgnored += 1
      continue
    }
    if (method === 'session/update') {
      mapper.apply({ method, params: frame.body.params })
    }
  }
  mapper.endTurn()
  A.equal(authIgnored, 1, 'replay 里有一帧 _auth/status_update')

  const types = new Set(sink.events.map(event => event.type))
  A.deepEqual([...types], ['activity/output'], '只有 agent_message_chunk 产生业务事件')
  A.equal(sink.events.length, 1, '整段 replay 只有一条文本事件')
  A.equal(sink.events[0].text, '收到', '真实回复文本')
  A.equal(sink.events[0].sessionId, sessionId, '事件绑定真实 sessionId')
  A.equal(sink.events[0].invocationId, 'inv-replay', '事件绑定 invocationId')

  const diag = mapper.diagnostics()
  const commands = diag.logs.find(log => log.kind === 'available_commands_update')
  A.ok(commands !== undefined, 'commands 进入有界摘要')
  A.equal(commands.count, 56, 'commands 总数')
  A.equal(commands.names.length, 10, '只留前 10 个名称')
  A.equal(commands.truncated, true, 'commands 摘要标 truncated')

  const payload = JSON.stringify({ events: sink.events, diag })
  // 17 KB 里的命令描述 / input hint 不进事件或诊断。
  A.ok(!payload.includes('Turn plan mode on.'), 'commands 描述不落盘')
  A.ok(!payload.includes('Show the status of the MCP servers'), 'commands 描述不落盘（第二条）')
  // _auth/status_update 的账户数据与 _meta 不落盘。
  A.ok(!payload.includes('user@example.invalid'), '账户 email 不落盘')
  A.ok(!payload.includes('Replay Account'), '账户 label 不落盘')
  A.ok(!payload.includes('threadStatus'), '_meta.threadStatus 不落盘')
  A.ok(!payload.includes('activeFlags'), '_meta.activeFlags 不落盘')
  // session_info_update 的 title 也不进摘要。
  A.ok(!payload.includes('请只回复两个字'), 'session_info.title 不落盘')
  // 诊断自身有界。
  A.ok(diag.logs.length <= ACP_LOG_MAX_ENTRIES, '诊断日志条数有界')
  A.ok(diag.logBytes <= ACP_LOG_MAX_BYTES, '诊断日志字节有界')
})

console.log(`\nacp-events.js：${checks} 项检查 / ${assertions} 条断言全部通过`)
