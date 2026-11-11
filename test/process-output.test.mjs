#!/usr/bin/env node
/**
 * 有界输出与脱敏自检（0.11 R3 / S2）。
 *
 * 只覆盖 `src/process-output.js` 的**纯单元**部分：字节/事件上限、恰好等于上限、
 * UTF-8 边界、`redactText` 规则与 `redactDeep` 嵌套/循环。
 *
 * 0.14.0 起旧执行链（executor）已删除，因此不再有「真子进程 + runExternalExecutor」
 * 的接线用例；限额 / 脱敏本身仍是宿主检查与适配器共用的能力，继续保留。
 *
 * 不依赖 dsh，也不联网。跑：`node test/process-output.test.mjs`
 */

import assert from 'node:assert/strict'

import {
  createBoundedOutput, redactDeep, redactText,
} from '../src/process-output.js'

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

// N9（复核2）：原先只认 Bearer，`Authorization: Basic <base64>` 会走到 key:value 规则
// 只把 scheme 抹掉，真正的 base64 凭据原样留下、还把外层字符串改坏。
await check('N9：Authorization 的 Basic / Token 方案与 Bearer 同口径脱敏，scheme 保留', () => {
  const cases = [
    ['Authorization: Basic dXNlcjpwYXNzLXNlY3JldA==', 'dXNlcjpwYXNzLXNlY3JldA==', 'Basic'],
    ['curl -H "Authorization: Basic dXNlcjpwYXNz" http://x', 'dXNlcjpwYXNz', 'Basic'],
    ['Authorization: Token canary-token-7f3a', 'canary-token-7f3a', 'Token'],
    ['Authorization: Bearer sk-live-abcdef1234567890', 'sk-live-abcdef1234567890', 'Bearer'],
  ]
  for (const [raw, secret, scheme] of cases) {
    const out = redactText(raw)
    A.ok(!out.includes(secret), `凭据必须抹掉（${scheme}）：${out}`)
    A.match(out, new RegExp(`${scheme} \\[REDACTED\\]`), `scheme 必须保留、值替换成 [REDACTED]：${out}`)
    // 不许把外层引号或字符串结构改坏（旧实现会产出 `Authorization: "[REDACTED]" <凭据>`）。
    A.ok(!out.includes('"[REDACTED]"'), `不得产出被改坏的引号形态：${out}`)
  }
  // 非凭据文本不受影响（不含认证方案词的普通句子）。
  A.equal(redactText('normal text without secrets'), 'normal text without secrets',
    '无凭据的普通句子不得被误改')
  // 已知误伤（记录在案，不修）：`<方案> <4+ 字符词>` 的松散形态会命中普通英文，
  // 如 'Basic usage' → 'Basic [REDACTED]'。这是「宁可错杀」的有意取舍——与
  // host-check.redactSensitiveText / engine.redactArguments 同口径，收窄会在三处
  // 产生分叉。方向安全（多抹），不影响证据可读性以外的东西。
  A.equal(redactText('Basic usage'), 'Basic [REDACTED]', '已知误伤：保持三处同口径，不为它收窄规则')
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
