#!/usr/bin/env node
/**
 * ACP v1 客户端连接层自检（0.15.0 / P1）。
 *
 * 覆盖 `src/acp-client.js` 的**连接层契约**，全部用进程内可编程假 agent
 * （Web Streams NDJSON 双向流）驱动，不 spawn 子进程、不联网、不依赖 dsh：
 *
 *  - 分帧：半行 / 跨 chunk 多字节 UTF-8 / 一个 chunk 多条 / EOF 无尾换行；
 *  - 路由：数字 id 与字符串 id 同字面不误匹配、同 id 反向权限请求不冲突、
 *    孤立/重复 response 只计数且**不把原始 id 交给 SDK**（无 console 旁路输出）；
 *  - 有界：17 KB / 600 KiB 合法行通过，超限行让全部 pending 失败并释放，
 *    请求超时关闭连接并 reject 全部 pending（不留悬挂 Promise）；
 *  - 通知：万条未知 / 坏 `session/update`、`_auth/status_update` 夹在响应前，
 *    连接仍活、诊断有界、console 无旁路输出、账户原文不进诊断；
 *  - 回调：`onUpdate` / `onPermission` / `onDiagnostic` 抛异常收敛成有界诊断；
 *  - 反向请求：未知方法回 -32601；权限回调拿得到原 requestId / signal。
 *
 * 关键纪律：断言**真实交付内容 / 真实错误码 / 真实计数**，不靠「函数被调用过」自证。
 *
 * 运行：`node test/acp-client.test.mjs`
 */

import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  AcpClientError,
  ACP_PROCESS_EXITED,
  ACP_PROTOCOL_ERROR,
  ACP_REQUEST_TIMEOUT,
  DEFAULT_MAX_MESSAGE_BYTES,
  openAcpClient,
} from '../src/acp-client.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const CANCELLED_PERMISSION = { outcome: { outcome: 'cancelled' } }

/** 轮询等待（有硬上限，失败时给出可读标签，绝不无限等）。 */
function waitFor(predicate, label, timeoutMs = 4000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value
      try {
        value = predicate()
      }
      catch (error) {
        reject(error)
        return
      }
      if (value) {
        resolve(value)
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`等待超时：${label}`))
        return
      }
      setTimeout(tick, 2)
    }
    tick()
  })
}

/**
 * 可编程假 agent 的两条单向流：
 *   inbound  —— agent 写、客户端读（ReadableStream，测试可逐 chunk 投喂 / 关闭）；
 *   outbound —— 客户端写、测试读（WritableStream，按 '\n' 切行并 JSON.parse）。
 */
function createHarness({ writeDelayMs = 0 } = {}) {
  let controller = null
  let inputClosed = false
  const inbound = new ReadableStream({
    start(value) {
      controller = value
    },
    cancel() {
      controller = null
    },
  })

  const received = []
  let pending = ''
  const outbound = new WritableStream({
    async write(chunk) {
      if (writeDelayMs > 0) await delay(writeDelayMs)
      pending += decoder.decode(chunk, { stream: true })
      let index = pending.indexOf('\n')
      while (index !== -1) {
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        if (line.trim().length > 0) {
          try {
            received.push(JSON.parse(line))
          }
          catch {
            received.push({ __unparsable: line })
          }
        }
        index = pending.indexOf('\n')
      }
    },
  })

  const push = bytes => {
    if (!controller || inputClosed) throw new Error('假 agent 的 inbound 已关闭')
    controller.enqueue(bytes)
  }

  return {
    inbound,
    outbound,
    received,
    /** 投递一条 JSON-RPC 消息（自动补 '\n'）。 */
    send(message) {
      push(encoder.encode(`${JSON.stringify(message)}\n`))
    },
    /** 原样投递文本（用于污染行 / 半行 / 无尾换行）。 */
    sendText(text) {
      push(encoder.encode(text))
    },
    /** 原样投递字节（用于在 UTF-8 多字节字符中间切开）。 */
    sendBytes(bytes) {
      push(bytes)
    },
    /** stdin EOF。 */
    end() {
      if (inputClosed) return
      inputClosed = true
      controller?.close()
    },
  }
}

/** 打开一个客户端，并收集诊断 / update / 权限回调；测试结束自动 close。 */
async function openClient(harness, overrides = {}, t) {
  const diagnostics = []
  const updates = []
  const permissions = []
  const client = await openAcpClient({
    input: harness.inbound,
    output: harness.outbound,
    onUpdate: overrides.onUpdate ?? (params => { updates.push(params) }),
    onPermission: overrides.onPermission ?? (context => {
      permissions.push(context)
      return { outcome: { outcome: 'selected', optionId: 'allow_once' } }
    }),
    onDiagnostic: overrides.onDiagnostic ?? (summary => { diagnostics.push(summary) }),
    ...(overrides.clientOptions ?? {}),
  })
  t?.after(() => client.close('测试清理'))
  return { client, diagnostics, updates, permissions }
}

/** 拦截 console 全通道，返回收集数组（测试内不得有任何旁路输出）。 */
function captureConsole(t) {
  const calls = []
  const originals = new Map()
  for (const key of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    originals.set(key, console[key])
    console[key] = (...args) => { calls.push({ key, args }) }
  }
  t.after(() => {
    for (const [key, original] of originals) console[key] = original
  })
  return calls
}

/** 找到客户端写出的第一条满足条件的消息。 */
function findOut(harness, predicate, label, timeoutMs) {
  return waitFor(() => harness.received.find(predicate), label, timeoutMs)
}

// ---------------------------------------------------------------------------
// 1. 生命周期：close 幂等 / pending 全部失败 / 关闭后拒绝新请求
// ---------------------------------------------------------------------------

test('close() 幂等：reject 全部 pending、pendingCount 归零、同一 closed promise', async t => {
  const harness = createHarness()
  const { client } = await openClient(harness, {}, t)

  assert.equal(typeof client.request, 'function')
  assert.equal(typeof client.notify, 'function')
  assert.equal(typeof client.close, 'function')
  assert.ok(client.closed instanceof Promise)

  const first = client.request('session/prompt', { sessionId: 's1', prompt: [] })
  const second = client.request('session/prompt', { sessionId: 's1', prompt: [] })
  await waitFor(() => harness.received.length >= 2, '两条出向请求')

  const closing = client.close('测试关闭')
  const [firstError, secondError] = await Promise.all([
    first.then(() => null, error => error),
    second.then(() => null, error => error),
  ])
  assert.equal(firstError?.code, ACP_PROTOCOL_ERROR)
  assert.equal(secondError?.code, ACP_PROTOCOL_ERROR)
  assert.equal(firstError.details.reason, 'client-closed')
  assert.ok(Buffer.byteLength(firstError.message, 'utf8') <= 1000)

  assert.equal(client.pendingCount, 0)
  await client.closed
  assert.ok(client.signal.aborted)

  // 幂等：第二次 close 返回同一个 promise，且不抛、不改原因。
  assert.equal(client.close('再来一次'), closing)
  await closing
  assert.equal(client.pendingCount, 0)
})

test('close 可以携带 ACP_PROCESS_EXITED：pending 继承该错误码（P4 接进程退出）', async t => {
  const harness = createHarness()
  const { client } = await openClient(harness, {}, t)

  const pending = client.request('initialize', {})
  await waitFor(() => harness.received.length >= 1, 'initialize 请求')
  client.close(new AcpClientError(ACP_PROCESS_EXITED, 'agent 进程已退出', { reason: 'process-exited' }))

  const error = await pending.then(() => null, value => value)
  assert.equal(error.code, ACP_PROCESS_EXITED)
})

test('关闭后 notify / request 立刻以类型化错误拒绝，不再写出任何帧', async t => {
  const harness = createHarness()
  const { client } = await openClient(harness, {}, t)
  await client.close('bye')
  await client.closed

  const writesBefore = harness.received.length
  await assert.rejects(
    client.notify('session/cancel', { sessionId: 's1' }),
    error => error.code === ACP_PROTOCOL_ERROR,
  )
  await assert.rejects(
    client.request('initialize', {}),
    error => error.code === ACP_PROTOCOL_ERROR,
  )
  assert.equal(harness.received.length, writesBefore)
  assert.equal(client.pendingCount, 0)
})

test('请求超时关闭连接并 reject 全部 pending（不留下悬挂 Promise）', async t => {
  const harness = createHarness()
  const { client } = await openClient(harness, { clientOptions: { requestTimeoutMs: 5000 } }, t)

  const timedOut = client.request('session/prompt', { sessionId: 's1' }, { timeoutMs: 60 })
  const collateral = client.request('session/prompt', { sessionId: 's1' })
  await waitFor(() => harness.received.length >= 2, '两条出向请求')

  const [timeoutError, collateralError] = await Promise.all([
    timedOut.then(() => null, error => error),
    collateral.then(() => null, error => error),
  ])
  assert.equal(timeoutError?.code, ACP_REQUEST_TIMEOUT)
  assert.match(timeoutError.message, /超时/u)
  assert.equal(timeoutError.details.timeoutMs, 60)
  assert.equal(collateralError?.code, ACP_REQUEST_TIMEOUT)
  assert.equal(client.pendingCount, 0)
  await client.closed
})

// ---------------------------------------------------------------------------
// 2. 分帧：半行 / 多字节 UTF-8 / 多行 / EOF 无尾换行 / 超长行 / 污染行
// ---------------------------------------------------------------------------

test('半行 + UTF-8 多字节边界切开：响应恰好交付一次', async t => {
  const harness = createHarness()
  const { client } = await openClient(harness, {}, t)

  const request = client.request('initialize', { protocolVersion: 1 })
  const outbound = await findOut(harness, message => message.method === 'initialize', 'initialize 出向请求')

  const payload = `${JSON.stringify({
    jsonrpc: '2.0',
    id: outbound.id,
    result: { agentInfo: { name: '假·agent', version: '1.0.0' }, echo: '中文内容'.repeat(8) },
  })}\n`
  const bytes = encoder.encode(payload)
  // 在「中」的第一个多字节字节之后切开，确保跨 chunk 落在 UTF-8 字符内部。
  const cut = bytes.indexOf(0xe4) + 1
  assert.ok(cut > 0, '测试载荷里应能找到多字节字符')

  harness.sendBytes(bytes.subarray(0, cut))
  await delay(5)
  harness.sendBytes(bytes.subarray(cut, cut + 7))
  await delay(5)
  harness.sendBytes(bytes.subarray(cut + 7))

  const result = await request
  assert.equal(result.agentInfo.name, '假·agent')
  assert.equal(result.echo, '中文内容'.repeat(8))

  // 同一响应重放一次：只会计成重复，不会再交付给任何请求。
  harness.sendText(payload)
  await waitFor(() => client.stats.duplicateResponses === 1, '重复 response 计数')
  assert.equal(client.stats.strayResponses, 0)

  // 连接仍可用。
  const again = client.request('session/new', { cwd: '/tmp', mcpServers: [] })
  const second = await findOut(harness, message => message.method === 'session/new', 'session/new 出向请求')
  harness.send({ jsonrpc: '2.0', id: second.id, result: { sessionId: 's-2' } })
  assert.equal((await again).sessionId, 's-2')
})

test('一个 chunk 里多条响应各交付一次；EOF 无尾换行的响应仍交付', async t => {
  const harness = createHarness()
  const { client } = await openClient(harness, {}, t)

  const first = client.request('m/one', {})
  const second = client.request('m/two', {})
  const [one, two] = [
    await findOut(harness, message => message.method === 'm/one', 'm/one 出向请求'),
    await findOut(harness, message => message.method === 'm/two', 'm/two 出向请求'),
  ]

  harness.sendText(
    `${JSON.stringify({ jsonrpc: '2.0', id: one.id, result: { value: 1 } })}\n`
    + `${JSON.stringify({ jsonrpc: '2.0', id: two.id, result: { value: 2 } })}\n`,
  )
  assert.deepEqual(await first, { value: 1 })
  assert.deepEqual(await second, { value: 2 })

  const third = client.request('m/three', {})
  const tail = await findOut(harness, message => message.method === 'm/three', 'm/three 出向请求')
  // 最后一条响应**没有**换行，靠 EOF flush 交付。
  harness.sendText(JSON.stringify({ jsonrpc: '2.0', id: tail.id, result: { value: 3 } }))
  harness.end()
  assert.deepEqual(await third, { value: 3 })
  assert.equal(client.pendingCount, 0)
})

test('17 KB 与 600 KiB 合法单行都能通过（默认上限 32 MiB）', async t => {
  assert.equal(DEFAULT_MAX_MESSAGE_BYTES, 32 * 1024 * 1024)
  const harness = createHarness()
  const { client } = await openClient(harness, {}, t)

  const small = client.request('m/small', {})
  const smallOut = await findOut(harness, message => message.method === 'm/small', 'm/small 出向请求')
  const smallText = 'x'.repeat(17 * 1024)
  harness.send({ jsonrpc: '2.0', id: smallOut.id, result: { text: smallText } })
  assert.equal((await small).text.length, 17 * 1024)

  const big = client.request('m/big', {})
  const bigOut = await findOut(harness, message => message.method === 'm/big', 'm/big 出向请求')
  const bigText = 'y'.repeat(600 * 1024)
  harness.send({ jsonrpc: '2.0', id: bigOut.id, result: { text: bigText } })
  assert.equal((await big).text.length, 600 * 1024)
})

test('超限行：全部 pending 以协议错误失败并释放（可注入小上限）', async t => {
  const harness = createHarness()
  const { client } = await openClient(harness, { clientOptions: { maxMessageBytes: 2048 } }, t)

  const first = client.request('m/one', {})
  const second = client.request('m/two', {})
  await waitFor(() => harness.received.length >= 2, '两条出向请求')

  harness.sendText(`${JSON.stringify({ jsonrpc: '2.0', id: 0, result: { text: 'z'.repeat(4096) } })}\n`)

  const [firstError, secondError] = await Promise.all([
    first.then(() => null, error => error),
    second.then(() => null, error => error),
  ])
  assert.equal(firstError?.code, ACP_PROTOCOL_ERROR)
  assert.equal(firstError.details.reason, 'message-too-large')
  assert.equal(firstError.details.maxMessageBytes, 2048)
  assert.equal(secondError?.code, ACP_PROTOCOL_ERROR)
  assert.equal(client.pendingCount, 0)
  await client.closed
})

test('非 JSON 污染行之后合法响应仍成功（SDK 单条 -32700 后继续）', async t => {
  const harness = createHarness()
  const consoleCalls = captureConsole(t)
  const { client } = await openClient(harness, {}, t)

  const request = client.request('initialize', {})
  const outbound = await findOut(harness, message => message.method === 'initialize', 'initialize 出向请求')

  harness.sendText('这一行不是 JSON\n')
  const parseError = await findOut(harness, message => message.error?.code === -32700, '解析错误应答')
  assert.equal(parseError.id, null)

  harness.send({ jsonrpc: '2.0', id: outbound.id, result: { ok: true } })
  assert.deepEqual(await request, { ok: true })
  assert.equal(consoleCalls.length, 0)

  // 连接仍可用。
  const next = client.request('session/new', { cwd: '/tmp', mcpServers: [] })
  const nextOut = await findOut(harness, message => message.method === 'session/new', 'session/new 出向请求')
  harness.send({ jsonrpc: '2.0', id: nextOut.id, result: { sessionId: 's-1' } })
  assert.equal((await next).sessionId, 's-1')
})

// ---------------------------------------------------------------------------
// 3. 路由：id 类型 / 反向请求 / 孤立与重复响应（含 secret）
// ---------------------------------------------------------------------------

test('数字 id 与字符串 id 同字面不误匹配；孤立响应只计数且无 console 输出', async t => {
  const harness = createHarness()
  const consoleCalls = captureConsole(t)
  const { client } = await openClient(harness, {}, t)

  const request = client.request('initialize', {})
  const outbound = await findOut(harness, message => message.method === 'initialize', 'initialize 出向请求')

  harness.send({ jsonrpc: '2.0', id: String(outbound.id), result: { wrong: true } })
  await waitFor(() => client.stats.strayResponses === 1, '孤立 response 计数')

  harness.send({ jsonrpc: '2.0', id: outbound.id, result: { ok: true } })
  assert.deepEqual(await request, { ok: true })
  assert.equal(consoleCalls.length, 0)
})

test('同 id 的反向权限请求与我们的响应互不冲突，回调拿到原 requestId / signal', async t => {
  const harness = createHarness()
  const consoleCalls = captureConsole(t)
  const { client, permissions } = await openClient(harness, {}, t)

  const prompt = client.request('session/prompt', { sessionId: 's1', prompt: [{ type: 'text', text: '你好' }] })
  const outbound = await findOut(harness, message => message.method === 'session/prompt', 'prompt 出向请求')

  // 反向请求复用同一个 id 字面：两个方向的 id 空间独立，不得串台。
  harness.send({
    jsonrpc: '2.0',
    id: outbound.id,
    method: 'session/request_permission',
    params: {
      sessionId: 's1',
      toolCall: { toolCallId: 'tool-1', title: '写文件', kind: 'edit', status: 'pending' },
      options: [
        { optionId: 'allow_once', name: '允许一次', kind: 'allow_once' },
        { optionId: 'reject_once', name: '拒绝本次', kind: 'reject_once' },
      ],
    },
  })

  const permissionReply = await findOut(
    harness,
    message => message.id === outbound.id && message.result?.outcome !== undefined,
    '权限应答',
  )
  assert.deepEqual(permissionReply.result, { outcome: { outcome: 'selected', optionId: 'allow_once' } })
  assert.equal(permissions.length, 1)
  assert.equal(permissions[0].requestId, outbound.id)
  assert.equal(permissions[0].params.toolCall.toolCallId, 'tool-1')
  assert.ok(permissions[0].signal instanceof AbortSignal)

  // 权限应答恰好一条。
  assert.equal(
    harness.received.filter(message => message.id === outbound.id && message.result?.outcome !== undefined).length,
    1,
  )

  // 我们自己的请求仍由真正的响应结算。
  harness.send({ jsonrpc: '2.0', id: outbound.id, result: { stopReason: 'end_turn' } })
  assert.deepEqual(await prompt, { stopReason: 'end_turn' })
  assert.equal(consoleCalls.length, 0)
})

test('未知反向 request 回 -32601，连接继续可用', async t => {
  const harness = createHarness()
  const consoleCalls = captureConsole(t)
  const { client } = await openClient(harness, {}, t)

  harness.send({
    jsonrpc: '2.0',
    id: 'fs-1',
    method: 'fs/read_text_file',
    params: { sessionId: 's1', path: '/tmp/x' },
  })
  const reply = await findOut(harness, message => message.id === 'fs-1' && message.error, '-32601 应答')
  assert.equal(reply.error.code, -32601)
  assert.equal(consoleCalls.length, 0)

  const request = client.request('initialize', {})
  const outbound = await findOut(harness, message => message.method === 'initialize', 'initialize 出向请求')
  harness.send({ jsonrpc: '2.0', id: outbound.id, result: { ok: true } })
  assert.deepEqual(await request, { ok: true })
})

test('带 secret 的孤立 / 重复 response：日志与诊断里都没有原文', async t => {
  const harness = createHarness()
  const consoleCalls = captureConsole(t)
  const { client, diagnostics } = await openClient(harness, {}, t)
  const secret = 'sk-live-SECRET-RESPONSE-9876543210'

  harness.send({ jsonrpc: '2.0', id: secret, result: { data: 'leak?' } })
  harness.send({ jsonrpc: '2.0', id: secret, result: { data: 'leak again?' } })
  await waitFor(() => client.stats.strayResponses + client.stats.duplicateResponses >= 2, '孤立 / 重复计数')

  assert.equal(client.stats.strayResponses, 1)
  assert.equal(client.stats.duplicateResponses, 1)
  assert.equal(JSON.stringify(diagnostics).includes(secret), false)
  assert.equal(consoleCalls.length, 0)

  // 连接仍可用。
  const request = client.request('initialize', {})
  const outbound = await findOut(harness, message => message.method === 'initialize', 'initialize 出向请求')
  harness.send({ jsonrpc: '2.0', id: outbound.id, result: { ok: true } })
  assert.deepEqual(await request, { ok: true })
})

// ---------------------------------------------------------------------------
// 4. 通知：万条未知 / 坏 update、账户通知夹在响应前
// ---------------------------------------------------------------------------

test('万条未知 / 坏 update：连接活着、诊断有界、console 无旁路输出', async t => {
  const harness = createHarness()
  const consoleCalls = captureConsole(t)
  const { client, diagnostics, updates } = await openClient(harness, {}, t)

  const prompt = client.request('session/prompt', { sessionId: 's1', prompt: [] })
  const outbound = await findOut(harness, message => message.method === 'session/prompt', 'prompt 出向请求')

  const total = 5000
  for (let index = 0; index < total; index += 1) {
    harness.send({ jsonrpc: '2.0', method: '_unknown/notice', params: { index } })
    harness.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: index % 2 === 0
        ? { sessionId: 's1', update: { sessionUpdate: 42 } }
        : { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } },
    })
  }
  // 夹一条合法 update，证明拦截层没有把整条通道关掉。
  harness.send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '合法' } } },
  })
  harness.send({ jsonrpc: '2.0', id: outbound.id, result: { stopReason: 'end_turn' } })

  assert.deepEqual(await prompt, { stopReason: 'end_turn' })
  assert.equal(client.stats.notificationsDropped, total)
  assert.equal(client.stats.updatesRejected, total)
  assert.equal(client.stats.updatesDelivered, 1)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].update.sessionUpdate, 'agent_message_chunk')
  assert.ok(diagnostics.length > 0)
  assert.ok(diagnostics.length <= 50)
  assert.ok(client.stats.diagnosticsSuppressed > 0)
  assert.equal(consoleCalls.length, 0)
})

test('_auth/status_update 夹在 prompt result 前：连接活着、诊断有界且无账户原文', async t => {
  const harness = createHarness()
  const consoleCalls = captureConsole(t)
  const { client, diagnostics } = await openClient(harness, {}, t)

  const prompt = client.request('session/prompt', { sessionId: 's1', prompt: [] })
  const outbound = await findOut(harness, message => message.method === 'session/prompt', 'prompt 出向请求')

  const secret = 'sk-live-SECRET-ACCOUNT-1234567890'
  harness.send({ jsonrpc: '2.0', method: '_auth/status_update', params: { account: secret, balance: 42 } })
  harness.send({ jsonrpc: '2.0', id: outbound.id, result: { stopReason: 'end_turn' } })

  assert.deepEqual(await prompt, { stopReason: 'end_turn' })
  assert.equal(JSON.stringify(diagnostics).includes(secret), false)
  assert.ok(diagnostics.length > 0)
  assert.ok(diagnostics.length <= 50)
  assert.equal(consoleCalls.length, 0)
})

test('回调抛异常收敛为有界诊断：连接不炸、权限请求回 cancelled', async t => {
  const harness = createHarness()
  const collected = []
  const { client } = await openClient(harness, {
    onUpdate: () => { throw new Error('update boom') },
    onPermission: () => { throw new Error('permission boom') },
    onDiagnostic: (summary) => {
      collected.push(summary)
      throw new Error('diagnostic boom')
    },
  }, t)

  const prompt = client.request('session/prompt', { sessionId: 's1', prompt: [] })
  const outbound = await findOut(harness, message => message.method === 'session/prompt', 'prompt 出向请求')

  harness.send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
  })
  harness.send({
    jsonrpc: '2.0',
    id: outbound.id + 100,
    method: 'session/request_permission',
    params: {
      sessionId: 's1',
      toolCall: { toolCallId: 'tool-9', title: '危险操作' },
      options: [{ optionId: 'allow_once', name: '允许一次', kind: 'allow_once' }],
    },
  })

  const reply = await findOut(
    harness,
    message => message.id === outbound.id + 100 && message.result,
    'cancelled 权限应答',
  )
  assert.deepEqual(reply.result, CANCELLED_PERMISSION)

  harness.send({ jsonrpc: '2.0', id: outbound.id, result: { stopReason: 'end_turn' } })
  assert.deepEqual(await prompt, { stopReason: 'end_turn' })
  assert.ok(collected.length > 0)
  assert.ok(collected.length <= 50)
  assert.ok(client.stats.callbackFailures >= 2)
  assert.equal(client.pendingCount, 0)
})

// ---------------------------------------------------------------------------
// 5. 坏外壳 / EOF / 长错误正文 / Node 流适配
// ---------------------------------------------------------------------------

test('坏 JSON-RPC 外壳（版本不对）关闭连接并 reject pending', async t => {
  const harness = createHarness()
  const { client } = await openClient(harness, {}, t)

  const request = client.request('initialize', {})
  await waitFor(() => harness.received.length >= 1, 'initialize 出向请求')
  harness.send({ jsonrpc: '1.0', id: 0, result: { ok: true } })

  const error = await request.then(() => null, value => value)
  assert.equal(error?.code, ACP_PROTOCOL_ERROR)
  assert.equal(error.details.reason, 'invalid-shell')
  await client.closed
  assert.equal(client.pendingCount, 0)
})

test('坏 JSON-RPC 外壳（既无 method 也无 id）关闭连接', async t => {
  const harness = createHarness()
  const { client } = await openClient(harness, {}, t)

  const request = client.request('initialize', {})
  await waitFor(() => harness.received.length >= 1, 'initialize 出向请求')
  harness.send({ jsonrpc: '2.0', result: {} })

  const error = await request.then(() => null, value => value)
  assert.equal(error?.code, ACP_PROTOCOL_ERROR)
  assert.equal(error.details.reason, 'invalid-shell')
  await client.closed
})

test('EOF 且永不响应：pending 有界 reject 且归零', async t => {
  const harness = createHarness()
  const { client } = await openClient(harness, {}, t)

  const request = client.request('initialize', {})
  await waitFor(() => harness.received.length >= 1, 'initialize 出向请求')
  harness.end()

  const error = await request.then(() => null, value => value)
  assert.equal(error?.code, ACP_PROTOCOL_ERROR)
  assert.equal(error.details.reason, 'stream-eof')
  await client.closed
  assert.equal(client.pendingCount, 0)
})

test('远端 rpc 错误：脱敏后 rpcCode 进 details，正文不超过 1000 UTF-8 字节', async t => {
  const harness = createHarness()
  const { client } = await openClient(harness, {}, t)

  const request = client.request('session/new', {})
  const outbound = await findOut(harness, message => message.method === 'session/new', 'session/new 出向请求')
  harness.send({
    jsonrpc: '2.0',
    id: outbound.id,
    error: { code: -32000, message: '认证失败 '.repeat(500), data: { hint: 'x'.repeat(2000) } },
  })

  const error = await request.then(() => null, value => value)
  assert.equal(error?.code, ACP_PROTOCOL_ERROR)
  assert.equal(error.details.rpcCode, -32000)
  assert.ok(Buffer.byteLength(error.message, 'utf8') <= 1000)
  assert.equal(JSON.stringify(error.details).includes('hint'), false)
})

test('接受 Node Readable / Writable（P4 直接传子进程 stdio）', async t => {
  const chunks = []
  const input = new Readable({ read() {} })
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString('utf8'))
      callback()
    },
  })
  const client = await openAcpClient({ input, output })
  t.after(() => client.close('测试清理'))

  const request = client.request('initialize', {})
  await waitFor(() => chunks.join('').includes('"initialize"'), 'Node Writable 收到请求')
  input.push(`${JSON.stringify({ jsonrpc: '2.0', id: 0, result: { ok: true } })}\n`)
  assert.deepEqual(await request, { ok: true })

  input.push(null)
  await client.closed
  assert.equal(client.pendingCount, 0)
})
