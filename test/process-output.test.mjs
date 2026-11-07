#!/usr/bin/env node
/**
 * 有界输出与脱敏自检（0.11 R3 / S2）。
 *
 * 三段：
 *   1. `src/process-output.js` 纯单元：字节/事件上限、恰好等于上限、UTF-8 边界、
 *      `redactText` 四条规则（含与 engine 的规则 4 兼容差异）、`redactDeep` 嵌套/循环；
 *   2. 真 `node` 子进程：无限输出配小上限 → OUTPUT_LIMIT + 2s 内退出；正常小输出完整；
 *   3. 真 `node` 子进程：stderr / stdout 打 canary → events / tail / text 只见
 *      `[REDACTED]`，`JSON.stringify(result)` 不含 canary 原文。
 *
 * 不依赖 dsh，也不联网。跑：`node test/process-output.test.mjs`
 */

import assert from 'node:assert/strict'
import { spawn as realSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

import {
  createBoundedOutput, redactDeep, redactText,
} from '../src/process-output.js'
import { runExternalExecutor } from '../src/executor.js'

let checks = 0
let assertions = 0

const A = {
  equal(actual, expected, message) {
    assertions += 1
    assert.equal(actual, expected, message)
  },
  notEqual(actual, expected, message) {
    assertions += 1
    assert.notEqual(actual, expected, message)
  },
  deepEqual(actual, expected, message) {
    assertions += 1
    assert.deepEqual(actual, expected, message)
  },
  ok(value, message) {
    assertions += 1
    assert.ok(value, message)
  },
  match(value, pattern, message) {
    assertions += 1
    assert.match(value, pattern, message)
  },
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

/** POSIX 单引号引用（只用于把 argv 拼进 custom 的 `sh -c` 模板）。 */
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** 用真 node 子进程跑一段 `-e` 脚本；返回可直接交给 runExternalExecutor 的 custom 命令。 */
function nodeCommand(source) {
  return `${shq(process.execPath)} -e ${shq(source)}`
}

/** 给「不应挂起」的用例兜底：超时即失败，避免测试进程被挂死。 */
async function within(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}：超过 ${ms}ms 仍未结束`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 等真实子进程退出（被 SIGTERM/SIGKILL 收掉后 close/exit 会到）。 */
function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (!child) {
      resolve(false)
      return
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, ms)
    function onExit() {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

/** 兜底清理：测试失败 / 超时也不把无限输出子进程（含孙进程）留给宿主。 */
function killLeftover(child) {
  if (!child) return
  try {
    // runExternalExecutor 在 POSIX 上 detached：按进程组杀，连同 node 孙进程一起收掉。
    if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    // 组已经不存在 / 不是组长：继续尝试直接子进程。
  }
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  } catch {
    // 已经退出就忽略。
  }
}

/** 假子进程：EventEmitter 形状，用来精确控制 data / close / kill 的时序。 */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.write = () => true
  child.stdin.end = () => {}
  child.pid = 990001
  child.killSignals = []
  child.kill = (signal) => {
    child.killSignals.push(signal || 'SIGTERM')
    return true
  }
  return child
}

console.log('process-output.js')

// ---------------------------------------------------------------------------
// 纯单元：redactText / redactDeep
// ---------------------------------------------------------------------------

await check('redactText：Bearer / sk- / key=value / 超长混合串四类都脱敏', () => {
  const bearer = redactText('Authorization: Bearer abcdef1234567890')
  A.ok(!bearer.includes('abcdef1234567890'), 'Bearer 的 token 值必须抹掉')
  A.match(bearer, /Bearer \[REDACTED\]/, 'Bearer 必须替换成 [REDACTED]')

  const sk = redactText('api key = sk-live-abcdefgh12345678')
  A.ok(!sk.includes('abcdefgh12345678'), 'sk- key 的值必须抹掉')
  A.match(sk, /sk-\[REDACTED\]/, 'sk- 前缀保留、值替换成 [REDACTED]')

  const kv = redactText('token=supersecret password=hunter2 api_key=abc123secret')
  for (const secret of ['supersecret', 'hunter2', 'abc123secret']) {
    A.ok(!kv.includes(secret), `key=value 里的值必须抹掉：${secret}`)
  }
  A.match(kv, /\[REDACTED\]/, 'key=value 必须出现 [REDACTED]')

  // 大小写 + 数字混合的 40 字符裸串：≥32 且跨多类字符 → 规则 4 必须命中。
  const mixed = 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5z'
  A.equal(redactText(`前缀 ${mixed} 后缀`), '前缀 [REDACTED] 后缀', '混合类 40 字符 canary 必须整体脱敏')
  // 纯小写长串按兼容约定保留（既有 stderr 尾部夹具依赖这一点）。
  const filler = `${'x'.repeat(1500)}${'y'.repeat(1000)}`
  A.equal(redactText(filler), filler, '纯同类填充串（x…x / y…y）必须原样保留，保持旧夹具兼容')
  // 绝对 / 相对路径都不是凭据：custom 答案里的长路径不能把中间抹成 [REDACTED]。
  const path = '/testbed/workspace/dsh-flow-studio/.tmp/executor-inject-abc123/pwned'
  A.equal(redactText(path), path, '≥32 字符的绝对路径必须原样保留')
  const relative = 'src/client/very-long-file-name-abcdefghijklmnop.ts'
  A.equal(redactText(relative), relative, '≥32 字符的相对路径必须原样保留')
})

await check('redactDeep：嵌套对象 / 数组 / 非字符串原样 / 循环引用安全', () => {
  const secret = 'Bearer abcdef1234567890'
  const input = {
    text: secret,
    nested: { deeper: { value: secret } },
    list: [secret, { token: 'sk-live-abcdefgh12345678' }],
    count: 7,
    flag: true,
    nothing: null,
  }
  const out = redactDeep(input)
  A.notEqual(out, input, '必须返回新对象，不原地改调用方数据')
  A.equal(out.count, 7, '数字必须原样保留')
  A.equal(out.flag, true, '布尔必须原样保留')
  A.equal(out.nothing, null, 'null 必须原样保留')
  A.ok(!JSON.stringify(out).includes('abcdef1234567890'), '嵌套字符串里的 Bearer token 必须脱敏')
  A.ok(!JSON.stringify(out).includes('abcdefgh12345678'), '数组里的 sk- key 必须脱敏')
  A.match(out.nested.deeper.value, /\[REDACTED\]/, '深层对象必须递归脱敏')
  A.match(out.list[0], /\[REDACTED\]/, '数组元素必须递归脱敏')

  const circular = { text: secret }
  circular.self = circular
  circular.list = [circular]
  let safe
  A.ok((() => {
    safe = redactDeep(circular)
    return true
  })(), '循环引用不得抛错 / 死循环')
  A.equal(safe.self, '[TRUNCATED]', '循环引用必须替换成有界占位符')
  A.ok(!JSON.stringify(safe).includes('abcdef1234567890'), '循环对象里的秘密也必须脱敏')
})

await check('redactDeep：键数 / 深度有界，不会把宽对象或深层对象原样透出', () => {
  const wide = {}
  for (let index = 0; index < 100; index += 1) wide[`k${index}`] = index
  const wideOut = redactDeep(wide)
  A.ok(Object.keys(wideOut).length <= 64, '对象键数必须 ≤64')
  A.equal(Object.keys(wideOut).length, 64, '宽对象应保留前 64 个键')

  let deep = { value: 'Bearer abcdef1234567890' }
  for (let index = 0; index < 12; index += 1) deep = { next: deep }
  const deepOut = redactDeep(deep)
  A.ok(!JSON.stringify(deepOut).includes('abcdef1234567890'), '深层秘密不得因深度截断而原样透出')
  A.ok(JSON.stringify(deepOut).length < 500, '深度截断后的对象必须保持有界')
})

// ---------------------------------------------------------------------------
// 纯单元：createBoundedOutput 字节 / 事件 / UTF-8 边界
// ---------------------------------------------------------------------------

await check('createBoundedOutput：恰好等于字节上限不截断，超 1 字节才截断且 receivedBytes 不回退', () => {
  const out = createBoundedOutput({ maxBytes: 8, maxEvents: 2 })
  A.equal(out.addRaw('12345678'), true, '恰好等于上限应被接受')
  A.equal(out.limit, null, '恰好等于上限时 limit 必须为 null')
  A.equal(out.truncated, false, '恰好等于上限不算截断')
  A.equal(out.text(), '12345678', '恰好等于上限时文本必须完整')
  A.equal(out.receivedBytes, 8, 'receivedBytes 应等于已接收字节')
  A.equal(out.retainedBytes, 8, 'retainedBytes 应等于保留字节')

  A.equal(out.addRaw('9'), false, '超过 1 字节必须返回 false')
  A.equal(out.limit, 'bytes', '超过字节上限后 limit=bytes')
  A.equal(out.truncated, true, '超过字节上限后 truncated=true')
  A.equal(out.text(), '12345678', '越界 chunk 只接受剩余额度（此处为 0）')
  A.equal(out.receivedBytes, 9, 'receivedBytes 必须计入越界 chunk 的原始字节')
  A.equal(out.retainedBytes, 8, 'retainedBytes 不得超过 maxBytes')

  A.equal(out.addRaw('10'), false, '越界后继续写仍然 false')
  A.equal(out.receivedBytes, 11, 'receivedBytes 必须单调递增，不因保留淘汰回退')
  A.equal(out.retainedBytes, 8, '继续写入不得扩大保留字节')
})

await check('createBoundedOutput：越界 chunk 只保留剩余前缀，Buffer 与 string 口径一致', () => {
  const fromString = createBoundedOutput({ maxBytes: 4 })
  A.equal(fromString.addRaw('abcdef'), false, '6 字节配 4 字节上限必须越界')
  A.equal(fromString.text(), 'abcd', 'string chunk 只保留前 4 字节')
  A.equal(fromString.receivedBytes, 6, 'receivedBytes 按原始字节计')
  A.equal(fromString.retainedBytes, 4, 'retainedBytes=4')

  const fromBuffer = createBoundedOutput({ maxBytes: 4 })
  A.equal(fromBuffer.addRaw(Buffer.from('abcdef', 'utf8')), false, 'Buffer chunk 同样越界')
  A.equal(fromBuffer.text(), 'abcd', 'Buffer chunk 只保留前 4 字节')
  A.equal(fromBuffer.receivedBytes, 6, 'Buffer 的 receivedBytes 按 Buffer.length 计')
})

await check('createBoundedOutput：事件数恰好等于上限合法，多一条才 limit=events', () => {
  const out = createBoundedOutput({ maxBytes: 1024, maxEvents: 2 })
  A.equal(out.pushEvent({ n: 1 }), true, '第 1 条事件应接受')
  A.equal(out.pushEvent({ n: 2 }), true, '第 2 条事件应接受')
  A.equal(out.eventCount, 2, 'eventCount=2')
  A.equal(out.limit, null, '恰好等于事件上限时 limit 必须为 null')
  A.equal(out.truncated, false, '恰好等于事件上限不算截断')

  A.equal(out.pushEvent({ n: 3 }), false, '第 3 条事件必须拒绝')
  A.equal(out.limit, 'events', '事件越界后 limit=events')
  A.equal(out.truncated, true, '事件越界后 truncated=true')
  A.equal(out.eventCount, 2, '越界事件不得入队')
  A.deepEqual(out.eventList(), [{ n: 1 }, { n: 2 }], '事件列表只能包含额度内的事件')
})

await check('createBoundedOutput：UTF-8 多字节恰好到边界不产生半个字符', () => {
  const exact = createBoundedOutput({ maxBytes: 6 })
  A.equal(exact.addRaw('中中'), true, '两个 3 字节汉字恰好 6 字节，应接受')
  A.equal(exact.limit, null, '恰好等于上限时不应截断')
  A.equal(exact.text(), '中中', '恰好到边界时文本完整')
  A.equal(exact.retainedBytes, 6, 'retainedBytes 必须是 6')

  const split = createBoundedOutput({ maxBytes: 3 })
  const bytes = Buffer.from('中', 'utf8')
  A.equal(split.addRaw(bytes.subarray(0, 2)), true, '半个汉字还在额度内，不越界')
  A.equal(split.text(), '', '半个多字节字符不得解码成替换字符')
  A.equal(split.addRaw(bytes.subarray(2)), true, '补齐最后一个字节后恰好 3 字节')
  A.equal(split.text(), '中', '补齐后必须得到完整汉字')
  A.equal(split.truncated, false, '恰好等于上限仍不算截断')

  const cut = createBoundedOutput({ maxBytes: 5 })
  A.equal(cut.addRaw(Buffer.from('ééé', 'utf8')), false, '6 字节配 5 字节上限必须越界')
  A.ok(!cut.text().includes('\uFFFD'), '不得出现替换字符（半个多字节字符）')
  A.equal(cut.text(), 'éé', '只保留完整的两个 é（4 字节）')
  A.equal(cut.retainedBytes, 4, 'retainedBytes 只计完整字符的字节')
  A.ok(cut.retainedBytes <= 5, 'retainedBytes 不得超过 maxBytes')
})

await check('createBoundedOutput：tail 按字节从尾部取，起点落在半个字符上会向后对齐', () => {
  const out = createBoundedOutput({ maxBytes: 100, maxTail: 4 })
  out.addRaw('中中中')
  const tail = out.tail(4)
  A.equal(tail, '中', 'tail 必须从完整字符边界开始，不得返回半个汉字')
  A.ok(!tail.includes('\uFFFD'), 'tail 不得出现替换字符')
  A.equal(out.tail(), '中', 'tail 默认使用 maxTail（4 字节）')
  A.equal(out.tail(100), '中', 'tail 请求超过 maxTail 时仍受 maxTail 约束')
})

// ---------------------------------------------------------------------------
// 假子进程：上限来源 / 唯一收口 / 迟到事件
// ---------------------------------------------------------------------------

await check('上限来源：options 优先于 env，env 非法 / 0 回默认而不是 parseInt 截断', async () => {
  const saved = {
    bytes: process.env.FLOW_STUDIO_EXECUTOR_MAX_OUTPUT_BYTES,
    events: process.env.FLOW_STUDIO_EXECUTOR_MAX_EVENTS,
  }
  const savedEmitWarning = process.emitWarning
  // 非法 env 会按设计 emitWarning；这里静音，避免测试输出被 warning 淹没。
  process.emitWarning = () => {}
  try {
    const run = async (child, options) => within(runExternalExecutor({
      spec: { kind: 'custom', command: 'true' },
      prompt: '上限来源用例',
      spawn: () => child,
      ...options,
    }), 3000, '上限来源')

    // env 生效：4 字节上限，5 字节输出越界。
    process.env.FLOW_STUDIO_EXECUTOR_MAX_OUTPUT_BYTES = '4'
    delete process.env.FLOW_STUDIO_EXECUTOR_MAX_EVENTS
    let child = fakeChild()
    let promise = run(child)
    child.stdout.emit('data', '12345')
    let result = await promise
    A.equal(result.ok, false, 'env 的 4 字节上限必须生效')
    A.equal(result.reason, 'OUTPUT_LIMIT', 'env 上限越界必须 OUTPUT_LIMIT')

    // options 优先：env 仍是 4，但 options 给 8，5 字节输出应成功。
    child = fakeChild()
    promise = run(child, { maxOutputBytes: 8 })
    child.stdout.emit('data', '12345')
    child.emit('close', 0, null)
    result = await promise
    A.equal(result.ok, true, 'options.maxOutputBytes 必须优先于 env')
    A.equal(result.text, '12345', 'options 上限内的 5 字节输出必须完整')

    // env 非法（"2x"）：必须回默认 8MiB，不能 parseInt 成 2。
    process.env.FLOW_STUDIO_EXECUTOR_MAX_OUTPUT_BYTES = '2x'
    child = fakeChild()
    promise = run(child)
    child.stdout.emit('data', '12345')
    child.emit('close', 0, null)
    result = await promise
    A.equal(result.ok, true, '非法 env 必须回默认，不得用 parseInt("2x")=2 误杀')

    // env 为 0：同样非法，回默认。
    process.env.FLOW_STUDIO_EXECUTOR_MAX_OUTPUT_BYTES = '0'
    child = fakeChild()
    promise = run(child)
    child.stdout.emit('data', '12345')
    child.emit('close', 0, null)
    result = await promise
    A.equal(result.ok, true, 'env=0 必须回默认，不得把上限设成 0')

    // events env：1 条上限，第二条事件越界。
    delete process.env.FLOW_STUDIO_EXECUTOR_MAX_OUTPUT_BYTES
    process.env.FLOW_STUDIO_EXECUTOR_MAX_EVENTS = '1'
    const line = text => `${JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text } })}\n`
    child = fakeChild()
    promise = run(child)
    child.stdout.emit('data', `${line('a')}${line('b')}`)
    result = await promise
    A.equal(result.ok, false, 'env 的 1 条事件上限必须生效')
    A.equal(result.reason, 'OUTPUT_LIMIT', '事件上限越界必须 OUTPUT_LIMIT')
    A.equal(result.eventCount, 1, '越界事件不得入队')

    // options 优先：env 仍是 1，options 给 2，两条事件应成功。
    child = fakeChild()
    promise = run(child, { maxEvents: 2 })
    child.stdout.emit('data', `${line('a')}${line('b')}`)
    child.emit('close', 0, null)
    result = await promise
    A.equal(result.ok, true, 'options.maxEvents 必须优先于 env')
    A.equal(result.events.length, 2, '恰好等于事件上限仍应成功')
  } finally {
    if (saved.bytes === undefined) delete process.env.FLOW_STUDIO_EXECUTOR_MAX_OUTPUT_BYTES
    else process.env.FLOW_STUDIO_EXECUTOR_MAX_OUTPUT_BYTES = saved.bytes
    if (saved.events === undefined) delete process.env.FLOW_STUDIO_EXECUTOR_MAX_EVENTS
    else process.env.FLOW_STUDIO_EXECUTOR_MAX_EVENTS = saved.events
    process.emitWarning = savedEmitWarning
  }
})

await check('假子进程：kill 同步 emit close 时仍只收成 OUTPUT_LIMIT，迟到 close 不再改判', async () => {
  const child = fakeChild()
  child.kill = (signal) => {
    child.killSignals.push(signal || 'SIGTERM')
    // 模拟某些桩 spawn：kill 的同一 tick 里 emit close(0)，试图把失败改判成功。
    child.emit('close', 0, null)
    return true
  }
  const seen = []
  const promise = within(runExternalExecutor({
    spec: { kind: 'custom', command: 'true' },
    prompt: '同步 close 用例',
    spawn: () => child,
    maxOutputBytes: 8,
    onEvent: event => seen.push(event),
  }), 3000, '同步 close')
  child.stdout.emit('data', 'x'.repeat(9))
  const result = await promise

  A.equal(result.ok, false, '同步 close(0) 不得把 OUTPUT_LIMIT 改判成功')
  A.equal(result.reason, 'OUTPUT_LIMIT', 'reason 必须保持 OUTPUT_LIMIT')
  A.equal(result.code, 'OUTPUT_LIMIT', 'code 必须保持 OUTPUT_LIMIT')
  A.equal(result.exitCode, null, 'OUTPUT_LIMIT 的 exitCode 必须是 null')
  A.equal(child.killSignals[0], 'SIGTERM', '越界必须向子进程发 SIGTERM')
  const snapshot = JSON.stringify(result)
  const seenBefore = seen.length
  // 迟到 close / 迟到数据都不得再 emit、不得改判（result 已 resolve，对象也不应变化）。
  child.emit('close', 0, null)
  child.stdout.emit('data', 'y'.repeat(1024))
  A.equal(JSON.stringify(result), snapshot, '迟到事件不得改写已收口的结果')
  A.equal(seen.length, seenBefore, '迟到事件不得再触发 onEvent')
})

await check('假子进程：只打 stderr 的超量输出同样 OUTPUT_LIMIT，且 retainedBytes ≤ maxBytes', async () => {
  const child = fakeChild()
  const promise = within(runExternalExecutor({
    spec: { kind: 'custom', command: 'true' },
    prompt: 'stderr-only 用例',
    spawn: () => child,
    maxOutputBytes: 1024,
  }), 3000, 'stderr-only')
  child.stderr.emit('data', 's'.repeat(4096))
  const result = await promise

  A.equal(result.ok, false, 'stderr-only 超量也必须失败')
  A.equal(result.reason, 'OUTPUT_LIMIT', 'stderr 越界也必须收成 OUTPUT_LIMIT')
  A.ok(result.receivedBytes > 1024, 'receivedBytes 必须计入 stderr 原始字节')
  A.ok(result.retainedBytes <= 1024, 'stderr-only 的 retainedBytes 也不得超过 maxBytes')
  A.ok(result.tail.length <= 2000, 'tail 仍受 2000 字符上限约束')
})

// ---------------------------------------------------------------------------
// 真子进程：OUTPUT_LIMIT + 正常小输出
// ---------------------------------------------------------------------------

await check('真 node 子进程：无限输出配 256KiB 上限 → OUTPUT_LIMIT，2s 内退出且 text/events 有界', async () => {
  const source = [
    "const fs = require('node:fs')",
    "const chunk = 'x'.repeat(65536)",
    'for (;;) fs.writeSync(1, chunk)',
  ].join('\n')
  let child = null
  const spawn = (command, args, options) => {
    child = realSpawn(command, args, options)
    return child
  }
  const started = Date.now()
  let result
  try {
    result = await within(runExternalExecutor({
      spec: { kind: 'custom', command: nodeCommand(source) },
      prompt: '无限输出用例',
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxOutputBytes: 262144,
      spawn,
    }), 8000, '无限输出')
  } finally {
    if (!result) killLeftover(child)
  }
  const elapsed = Date.now() - started

  A.equal(result.ok, false, '无限输出不得被判成功')
  A.equal(result.reason, 'OUTPUT_LIMIT', 'reason 必须是 OUTPUT_LIMIT')
  A.equal(result.code, 'OUTPUT_LIMIT', 'code 必须与 reason 同值')
  A.equal(result.truncated, true, 'OUTPUT_LIMIT 必须带 truncated=true')
  A.ok(result.receivedBytes > 262144, 'receivedBytes 必须超过配置上限（累计计数不回退）')
  A.ok(result.retainedBytes <= 262144, 'retainedBytes 不得超过 maxBytes')
  A.ok(Buffer.byteLength(result.text, 'utf8') <= 262144, 'text 不得超过 maxBytes')
  A.ok(result.events.length <= 5000, '事件数必须受默认上限约束')
  A.ok(result.eventCount <= 5000, 'eventCount 必须受默认上限约束')
  A.ok(elapsed < 2000, `必须在 2s 内收口（实际 ${elapsed}ms）`)
  const exited = await waitExit(child, 2000)
  if (!exited) killLeftover(child)
  A.ok(exited, '越界后子进程必须在 2s 内退出')
  A.ok(['group', 'process'].includes(result.killScope), '必须记录终止范围')
  console.log(`    · ${elapsed}ms 收口，received=${result.receivedBytes}B retained=${result.retainedBytes}B events=${result.eventCount}`)
})

await check('真 node 子进程：正常小输出不受影响（exit 0、text 完整）', async () => {
  const result = await within(runExternalExecutor({
    spec: { kind: 'custom', command: nodeCommand("process.stdout.write('小输出完整\\n')") },
    prompt: '小输出用例',
    cwd: process.cwd(),
    maxOutputBytes: 262144,
  }), 5000, '小输出')
  A.equal(result.ok, true, '小输出必须成功')
  A.equal(result.exitCode, 0, '小输出 exitCode=0')
  A.equal(result.text, '小输出完整', '小输出 text 必须完整，不得被截断或改写')
  A.equal(result.truncated, undefined, '小输出不得带 truncated')
})

// ---------------------------------------------------------------------------
// 真子进程：stderr / stdout canary 脱敏
// ---------------------------------------------------------------------------

const CANARIES = [
  'abcdef1234567890', // Bearer 值
  'abcdefgh12345678', // sk- 值
  'supersecret', // token= 值
  'stdoutcanary1234567890', // stdout Bearer 值
]

function assertNoCanary(result, label) {
  const serialized = JSON.stringify(result)
  for (const canary of CANARIES) {
    A.ok(!serialized.includes(canary), `${label}：JSON.stringify(result) 不得含 canary 原文 ${canary}`)
  }
  A.match(serialized, /\[REDACTED\]/, `${label}：结果里必须出现 [REDACTED]`)
}

await check('真 node 子进程：stderr canary 在 events / text 里只见 [REDACTED]', async () => {
  const source = [
    `process.stderr.write('Bearer abcdef1234567890\\n')`,
    `process.stderr.write('sk-live-abcdefgh12345678\\n')`,
    `process.stderr.write('token=supersecret\\n')`,
    `process.stdout.write('stdout Bearer stdoutcanary1234567890\\n')`,
  ].join('\n')
  const result = await within(runExternalExecutor({
    spec: { kind: 'custom', command: nodeCommand(source) },
    prompt: 'canary 用例',
    cwd: process.cwd(),
  }), 5000, 'stderr canary')

  A.equal(result.ok, true, '带 canary 的小输出仍应成功')
  const stderrEvent = result.events.find(event => event.kind === 'stderr')
  A.ok(stderrEvent && typeof stderrEvent.text === 'string', '必须有 stderr 事件')
  A.match(stderrEvent.text, /\[REDACTED\]/, 'stderr 事件必须出现 [REDACTED]')
  for (const canary of CANARIES) {
    A.ok(!stderrEvent.text.includes(canary), `stderr 事件不得含 canary 原文 ${canary}`)
  }
  A.match(result.text, /\[REDACTED\]/, 'result.text 必须出现 [REDACTED]')
  A.ok(!result.text.includes('stdoutcanary1234567890'), 'stdout 的 Bearer 值不得出现在 result.text')
  assertNoCanary(result, '成功路径')
})

await check('真 node 子进程：非 0 退出时 result.tail / events 只见 [REDACTED]', async () => {
  const source = [
    `process.stderr.write('Bearer abcdef1234567890\\n')`,
    `process.stderr.write('sk-live-abcdefgh12345678\\n')`,
    `process.stderr.write('token=supersecret\\n')`,
    'process.exit(3)',
  ].join('\n')
  const result = await within(runExternalExecutor({
    spec: { kind: 'custom', command: nodeCommand(source) },
    prompt: 'canary 失败用例',
    cwd: process.cwd(),
  }), 5000, 'canary 失败')

  A.equal(result.ok, false, 'exit 3 必须失败')
  A.equal(result.reason, 'exit', '非 0 退出 reason=exit')
  A.equal(result.exitCode, 3, 'exitCode=3')
  A.ok(typeof result.tail === 'string' && result.tail !== '', '失败结果必须带 tail')
  A.match(result.tail, /\[REDACTED\]/, 'tail 必须出现 [REDACTED]')
  for (const canary of CANARIES.slice(0, 3)) {
    A.ok(!result.tail.includes(canary), `tail 不得含 canary 原文 ${canary}`)
  }
  const stderrEvent = result.events.find(event => event.kind === 'stderr')
  A.ok(stderrEvent && !stderrEvent.text.includes('supersecret'), '失败路径的 stderr 事件也不得含 canary')
  assertNoCanary(result, '失败路径')
})

console.log(`\n${checks} 组通过`)
