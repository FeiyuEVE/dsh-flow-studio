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
  createBoundedOutput, isSensitiveKeyName, redactDeep, redactStructured, redactText,
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

/** 正例断言：秘密消失、可识别前缀保留、二次脱敏幂等。 */
function expectRedacted(raw, { secrets = [], markers = [] } = {}, label = '') {
  const out = redactText(raw)
  for (const secret of secrets) A.ok(!out.includes(secret), `${label}：秘密必须抹掉（实际 ${out}）`)
  for (const marker of markers) A.ok(out.includes(marker), `${label}：应保留可识别前缀 ${marker}（实际 ${out}）`)
  A.equal(redactText(out), out, `${label}：二次脱敏必须幂等`)
  return out
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

// MAJOR-2（0.14.8）：旧实现用 `value.includes('[REDACTED]')` 判断「这个值已经脱敏」，
// 于是**部分脱敏**（标记前后还有其它字符）的值被整值放行。最直接的泄漏形态是
// `password="ghp_<36位>;hunter2"`：规则 0 先产出 `ghp_[REDACTED]`，key=value 规则
// 看到值里含标记就原样返回，引号内 `;hunter2` 留在输出里。
// 正确判据是「值（去掉外层引号后）**整体**就是脱敏产物」，否则一律按敏感值处理。
await check('redactText：部分脱敏不整值放行，标记后的残余秘密必须抹掉（MAJOR-2）', () => {
  const cases = [
    // 复审给出的最小复现。
    [`password="ghp_${'A'.repeat(36)};hunter2"`, 'password="[REDACTED]"', 'hunter2'],
    // 已经是「部分脱敏」的文本（不依赖规则 0 的产物）也必须整值抹掉。
    ['password=ghp_[REDACTED]hunter2', 'password="[REDACTED]"', 'hunter2'],
    // 其它前缀在同一路径上：glpat / sk- / 引号形态。
    [`token='glpat-${'aB3dE5fG7hI9jK1lM3nO'};hunter2'`, 'token="[REDACTED]"', 'hunter2'],
    [`api_key="sk-${'aB3dE5fG7hI9jK1lM3nO5pQ7'};hunter2"`, 'api_key="[REDACTED]"', 'hunter2'],
    // 规则 1（Bearer）：引号内的部分脱敏同样不能整值放行。
    [`Authorization: Bearer "ghp_${'A'.repeat(36)};hunter2"`, 'Authorization: Bearer [REDACTED]', 'hunter2'],
  ]
  for (const [raw, expected, secret] of cases) {
    const out = redactText(raw)
    A.ok(!out.includes(secret), `标记后的残余秘密必须抹掉（实际 ${out}）`)
    A.equal(out, expected, `部分脱敏必须整值替换：${out}`)
    A.equal(redactText(out), out, `整值替换后必须保持幂等（实际 ${out}）`)
  }
})

// 「完整已脱敏」必须原样放行：否则二次脱敏会把规则 0 保留的可识别前缀二次抹掉。
await check('redactText：完整已脱敏形态原样放行，连接串不受新判据影响', () => {
  const preserved = [
    'password="[REDACTED]"',
    "token='glpat-[REDACTED]'",
    'api_key=sk-[REDACTED]',
    'AWS_SECRET_ACCESS_KEY="[REDACTED]"',
    'Authorization: Bearer ghp_[REDACTED]',
    'Authorization: Bearer "github_pat_[REDACTED]"',
    'x-api-key: AIza[REDACTED]',
  ]
  for (const raw of preserved) {
    A.equal(redactText(raw), raw, `完整已脱敏形态不得被二次处理：${raw}`)
  }
  // 连接串走独立规则（`scheme://[REDACTED]@host`），不属于 key=value 的值，保持原样。
  const conn = 'postgres://user:hunter2@db.internal:5432/app'
  const out = redactText(conn)
  A.equal(out, 'postgres://[REDACTED]@db.internal:5432/app', '连接串只抹 user:pass')
  A.equal(redactText(out), out, '连接串脱敏后必须幂等')
})

await check('redactText：AWS Access Key / secret access key 脱敏并保留前缀', () => {
  const access = expectRedacted('credential AKIAIOSFODNN7EXAMPLE used', {
    secrets: ['IOSFODNN7EXAMPLE'],
    markers: ['AKIA[REDACTED]'],
  }, 'AWS access key')
  A.equal(access, 'credential AKIA[REDACTED] used')

  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  A.equal(secret.length, 40, '夹具必须是真实的 40 字符形态')
  const out = expectRedacted(`AWS_SECRET_ACCESS_KEY=${secret}`, {
    secrets: [secret],
    markers: ['AWS_SECRET_ACCESS_KEY="[REDACTED]"'],
  }, 'AWS secret key')
  A.equal(out, 'AWS_SECRET_ACCESS_KEY="[REDACTED]"')

  // 反例：短值 / 不同前缀 / 多出字符都不该命中原规则。
  A.equal(redactText('AKIA1234'), 'AKIA1234')
  A.equal(redactText('BKIAIOSFODNN7EXAMPLE'), 'BKIAIOSFODNN7EXAMPLE')
  // 0.15.2：键名本身就是敏感名（ACCESS_KEY 命中新的键名词表），不再按值的长度放行；
  // 原断言「短占位值不会被抹」与复审 M1 的要求冲突，已改成安全方向。
  A.equal(redactText('AWS_SECRET_ACCESS_KEY=too-short'), 'AWS_SECRET_ACCESS_KEY="[REDACTED]"')
  A.equal(redactText('aws_region=too-short'), 'aws_region=too-short', '非敏感键名不得误伤')
  A.equal(redactText('keyboard=too-short'), 'keyboard=too-short', '豁免词不得误伤（M1 豁免）')
})

await check('redactText：PEM 私钥块整体脱敏，公钥块不误伤', () => {
  // body 故意短于通用规则 5 的 32 字符下限：只有 PEM 规则能整块抹掉它，
  // 这样「撤掉 PEM 规则」的变异才会真的变红（否则会被通用规则兜底掩盖）。
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'short-key-material-42',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n')
  const out = expectRedacted(pem, {
    secrets: ['short-key-material-42'],
    markers: ['-----BEGIN RSA PRIVATE KEY-----', '[REDACTED]', '-----END RSA PRIVATE KEY-----'],
  }, 'PEM 私钥')
  A.equal(out, [
    '-----BEGIN RSA PRIVATE KEY-----',
    '[REDACTED]',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n'), '私钥块体必须整体替换，头尾保留')
  A.ok(!out.includes('short-key-material-42'))

  // 反例：公钥不是私钥凭据；短 body 也不会被规则 4 顺手抹掉。
  const pub = ['-----BEGIN PUBLIC KEY-----', 'MIIBIjANBgkq', '-----END PUBLIC KEY-----'].join('\n')
  A.equal(redactText(pub), pub, '公钥块不得被当成私钥脱敏')
})

await check('redactText：GitHub 经典 / fine-grained 令牌脱敏并保留前缀', () => {
  const classic = `ghp_${'Ab3'.repeat(12)}`
  expectRedacted(`token ${classic} end`, {
    secrets: [classic.slice(4)],
    markers: ['ghp_[REDACTED]'],
  }, 'ghp_')
  const pat = `github_pat_${'a'.repeat(22)}_${'B3'.repeat(30)}`
  expectRedacted(`token ${pat} end`, {
    secrets: ['B3B3B3'],
    markers: ['github_pat_[REDACTED]'],
  }, 'github_pat_')
  A.equal(redactText('ghp_short123'), 'ghp_short123')
  A.equal(redactText('github_pat_short'), 'github_pat_short')
})

await check('redactText：Slack xox* / xapp- 令牌脱敏并保留前缀', () => {
  const bot = `xoxb-${'123456789012-'.repeat(2)}abcdefghijklmnop`
  expectRedacted(bot, { secrets: ['abcdefghijklmnop'], markers: ['xoxb-[REDACTED]'] }, 'xoxb')
  const app = `xapp-1-${'A1234567890-'.repeat(2)}1234567890123`
  expectRedacted(app, { secrets: ['1234567890123'], markers: ['xapp-[REDACTED]'] }, 'xapp')
  A.equal(redactText('xoxb-short'), 'xoxb-short')
  A.equal(redactText('xapp-tiny'), 'xapp-tiny')
})

await check('redactText：GitLab / Google / Stripe 令牌脱敏并保留前缀', () => {
  const glpat = `glpat-${'aB3dE5fG7hI9jK1lM3nO'}`
  expectRedacted(glpat, {
    secrets: ['aB3dE5fG7hI9jK1lM3nO'],
    markers: ['glpat-[REDACTED]'],
  }, 'glpat')
  A.equal(redactText('glpat-short'), 'glpat-short')

  const google = `AIza${'A'.repeat(35)}`
  expectRedacted(google, { secrets: ['A'.repeat(35)], markers: ['AIza[REDACTED]'] }, 'Google API key')
  A.equal(redactText('AIza'), 'AIza')
  A.equal(redactText('AIzaSyShortValue'), 'AIzaSyShortValue')

  for (const prefix of ['sk_live_', 'rk_live_']) {
    const payload = 'aB3dE5fG7hI9jK1lM3nO5pQ7'
    expectRedacted(`${prefix}${payload}`, {
      secrets: [payload],
      markers: [`${prefix}[REDACTED]`],
    }, prefix)
  }
  A.equal(redactText('sk_live_short'), 'sk_live_short')
  const testKey = `sk_test_${'a'.repeat(12)}`
  A.equal(redactText(testKey), testKey, 'sk_test_ 不是本规则目标，短值也不得被通用规则误伤')
})

await check('redactText：JWT 三段式整体脱敏并保留 eyJ 前缀', () => {
  const jwt = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ].join('.')
  expectRedacted(`Authorization: ${jwt}`, {
    secrets: [jwt.split('.')[2]],
    markers: ['eyJ[REDACTED]'],
  }, 'JWT')
  A.equal(redactText('eyJhbGci.eyJzdWIi'), 'eyJhbGci.eyJzdWIi', '两段不是 JWT，不得误伤')
  A.equal(redactText('eyJust-a-word'), 'eyJust-a-word')
})

await check('redactText：数据库 / 消息连接串的 user:pass 脱敏，保留 scheme 与 host', () => {
  for (const scheme of ['postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'amqp']) {
    const raw = `${scheme}://app:s3cretP4ss@db.internal:5432/app`
    const out = expectRedacted(raw, {
      secrets: ['s3cretP4ss'],
      markers: [`${scheme}://[REDACTED]@db.internal`],
    }, scheme)
    A.equal(out, `${scheme}://[REDACTED]@db.internal:5432/app`)
  }
  A.equal(redactText('redis://cache.internal:6379/0'), 'redis://cache.internal:6379/0',
    '没有密码的连接串不得被抹')
  A.equal(redactText('mysql://user@host/db'), 'mysql://user@host/db', '没有密码的连接串不得被抹')
  A.equal(redactText('https://user:pass@host/path'), 'https://user:pass@host/path',
    '不在名单内的 scheme 不误伤')
})

await check('redactText：新增规则与既有规则组合、整体幂等', () => {
  const ghp = `ghp_${'Ab3'.repeat(12)}`
  const glpat = `glpat-${'aB3dE5fG7hI9jK1lM3nO'}`
  const out = redactText(`Authorization: Bearer ${ghp} token=${glpat} password=hunter2`)
  A.ok(!out.includes(ghp.slice(4)), '组合场景不得泄露 GitHub 令牌')
  A.ok(!out.includes('aB3dE5fG7hI9jK1lM3nO'), '组合场景不得泄露 GitLab 令牌')
  A.ok(!out.includes('hunter2'), '既有 key=value 规则不得失效')
  A.match(out, /Bearer ghp_\[REDACTED\]/, 'Bearer 规则不得吞掉新规则保留的前缀')
  A.match(out, /token=glpat-\[REDACTED\]/, 'key=value 规则不得二次抹掉已脱敏前缀')
  A.equal(redactText(out), out, '组合规则必须整体幂等')
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

await check('redactText：超大输入分段脱敏，不因正则爆栈（0.14.8）', () => {
  // 动机：V8 对「单次超长匹配」会抛 RangeError；0.14.7 把单行上限提到 32 MiB 后，
  // 一段约 9 MiB、没有任何空白的事件正文会在脱敏阶段把适配器打崩。分段后必须不再崩。
  const plain = redactText('x'.repeat(6 * 1024 * 1024))
  A.equal(plain, '[REDACTED]', '整段无空白超长串整体抹掉')
  const token = redactText('ghp_' + 'A'.repeat(6 * 1024 * 1024))
  A.equal(token, '[REDACTED]', '超长令牌整段抹掉、不残留载荷')

  const big = ('padding word '.repeat(200_000)) + 'ghp_' + 'A'.repeat(36) + ' tail'
  const out = redactText(big)
  A.ok(!out.includes('A'.repeat(36)), '大文本里的 GitHub 令牌仍被抹掉')
  A.ok(out.startsWith('padding word '), '普通大文本保持原样')
  A.ok(out.endsWith(' tail'), '尾部普通文本保持原样')
  A.equal(redactText(out), out, '大文本整体幂等')
})

await check('redactText：分段边界不能把引号内的敏感值切开（0.14.8 复审回归）', () => {
  // 复审实测泄漏：262090 个 'A' 之后紧跟 `password="ghp_…; hunter2"`。旧分段按空白切，
  // 引号内的空白被当成边界，后半段 `hunter2"` 逃过 key=value 规则。
  const raw = 'A'.repeat(262_090) + '1 password="ghp_' + 'A'.repeat(36) + '; hunter2"'
  const out = redactText(raw)
  A.ok(!out.includes('hunter2'), '引号内的残余秘密不能被分段漏掉')
  A.ok(out.endsWith('password="[REDACTED]"'), '整值必须被抹掉')

  // 同样的值放在多行文本里、跨过 256 KiB 边界附近，也不能被拆开。
  const filler = 'line padding\n'.repeat(20_000)
  const withQuoted = `${filler}password="ghp_${'A'.repeat(36)}; hunter2"\n`
  const red = redactText(withQuoted)
  A.ok(!red.includes('hunter2'), '多行文本里的引号值同样不得泄漏')

  // 引号不闭合的脏输入：不能崩，也不能把秘密原样留下（0.14.9 复审实测残留 `; hunter2`）。
  const unbalanced = 'A'.repeat(262_090) + '1 password="ghp_' + 'A'.repeat(36) + '; hunter2'
  const odd = redactText(unbalanced)
  A.ok(!odd.includes('A'.repeat(36)), '引号未闭合时令牌本身仍要被抹掉')
  A.ok(!odd.includes('hunter2'), '引号未闭合时残余秘密也不能留下')

  // 等号后带空格（0.14.9 复审实测：分段器只在引号紧邻 `=` 时认引号，于是又被切开）。
  const spaced = 'A'.repeat(262_089) + '1 password= "ghp_' + 'A'.repeat(36) + '; hunter2"'
  const spacedOut = redactText(spaced)
  A.ok(!spacedOut.includes('hunter2'), '等号后带空格的赋值同样要整值抹掉')
  A.ok(spacedOut.endsWith('password= "[REDACTED]"'), '保留等号后的空格与引号形态')

  // 值跨过分段边界、且没被引号包住（0.14.9 旧探针：`password= hunter2` 跨边界泄漏）。
  const loose = 'A'.repeat(262_089) + '1 password= hunter2'
  const looseOut = redactText(loose)
  A.ok(!looseOut.includes('hunter2'), '跨边界的裸值也必须被抹掉')
})

await check('redactText：敏感值扫描器覆盖多行 / 转义 / 引号嵌套 / 标志位（0.14.10 复审 6 变体）', () => {
  const P = 'A'.repeat(262_089) + '1 '
  const G = 'ghp_' + 'A'.repeat(36)
  const variants = [
    `${P}password="${G};\nhunter2"`, // 闭合但值内含换行
    `${P}password="${G}; it's hunter2`, // 未闭合双引号，内含单引号
    `${P}token='${G}; say "hunter2`, // 未闭合单引号，内含双引号
    `${P}password="${G}; say \\"; hunter2"`, // 值内含转义引号
    `${P}password="${G};\nhunter2`, // 未闭合且跨行
    `${P}password="${G};\thunter2"`, // 值内含 TAB
  ]
  for (const raw of variants) {
    const out = redactText(raw)
    A.ok(!out.includes('hunter2'), `不得泄漏（实际尾部 ${JSON.stringify(out.slice(-40))}）`)
  }
  // 标志位（--token / --api-key）同样走扫描器：引号内跨行 / 转义 / 未闭合都不能漏。
  for (const raw of [
    `${P}--token "${G};\nhunter2"`,
    `${P}--token='${G}; say "hunter2`,
    `${P}--api-key "${G}; say \\"; hunter2"`,
  ]) {
    A.ok(!redactText(raw).includes('hunter2'), '标志位的引号值同样不得泄漏')
  }
  // 正常闭合的单引号值仍整值替换（保持既有输出形态）。
  A.equal(redactText("token='secret-value-42'"), 'token="[REDACTED]"')
})

// ---------------------------------------------------------------------------
// 0.15.1：转义感知 / 先脱敏再截断 / 13 种新写法
// ---------------------------------------------------------------------------

await check('redactText：JSON / shell 转义、三引号、词内拼接、全角、箭头、YAML、裸方案、SQL、续行（0.15.1）', () => {
  const G = `ghp_${'A'.repeat(36)}`
  // 序列化后的文本：引号变成 `\"`，值里的换行变成 `\n`。按旧实现会在这里截断。
  const jsonEscaped = JSON.stringify({ msg: `password="${G}; hunter2"` })
  A.equal(
    redactText(jsonEscaped),
    '{"msg":"password=\\"[REDACTED]\\""}',
    `JSON 序列化后的赋值必须整值抹掉（实际 ${redactText(jsonEscaped)}）`,
  )
  A.equal(
    redactText(JSON.stringify({ msg: 'password="x; hunter2"' })),
    '{"msg":"password=\\"[REDACTED]\\""}',
    '没有规则 0 前缀时也必须抹掉 JSON 转义值',
  )

  // [原始文本, 期望输出]——每条都同时检查「秘密消失」与「二次脱敏幂等」。
  const cases = [
    ['password="""hunter2"""', 'password="[REDACTED]"'],
    ["password='''hunter2'''", 'password="[REDACTED]"'],
    ['password="abc"hunter2', 'password="[REDACTED]"'],
    ['password=""hunter2', 'password="[REDACTED]"'],
    ['password：hunter2', 'password："[REDACTED]"'],
    ['password＝hunter2', 'password＝"[REDACTED]"'],
    ['--token：hunter2', '--token：[REDACTED]'],
    ['password => "hunter2"', 'password => "[REDACTED]"'],
    ['password -> hunter2', 'password -> "[REDACTED]"'],
    ['password: |\n  hunter2', 'password: "[REDACTED]"'],
    // 下一行键名用 `next_field`：0.15.2 起 `key` 本身是敏感词，`next_key` 会被按键名
    // 脱敏，无法再用它验证「块标量之后的下一行没被吞」。
    ['password: >-\n\thunter2\nnext_field: ok', 'password: "[REDACTED]"\nnext_field: ok'],
    ['Authorization: ApiKey hunter2', 'Authorization: ApiKey [REDACTED]'],
    ['Authorization: SSWS hunter2', 'Authorization: SSWS [REDACTED]'],
    ['password="hunter2[REDACTED]"', 'password="[REDACTED]"'],
    ["password='it''s hunter2'", 'password="[REDACTED]"'],
    ['password= \\\n  hunter2', 'password= "[REDACTED]"'],
    ['password=\\"hunter2', 'password=\\"[REDACTED]\\"'],
  ]
  for (const [raw, expected] of cases) {
    const out = redactText(raw)
    A.equal(out, expected, `写法必须整值脱敏：${JSON.stringify(raw)} → ${JSON.stringify(out)}`)
    A.ok(!out.includes('hunter2'), `不得泄漏 hunter2：${JSON.stringify(out)}`)
    A.equal(redactText(out), out, `脱敏后必须幂等：${JSON.stringify(out)}`)
  }

  // 对照：`hunter2` 是另一个 query 参数，不是 token 的值 → 必须保留（不过度脱敏）。
  A.equal(redactText('?token=secret&hunter2'), '?token="[REDACTED]"&hunter2',
    '另一个 query 参数不属于敏感值，不得被吞')
})

await check('redactDeep：敏感键名按键脱敏，JSON 序列化后的事件文本同样脱敏（0.15.1）', () => {
  const input = {
    token: 'opaque-value',
    apiKey: 'a1b2c3',
    nested: { password: 'hunter2' },
    message: 'normal text',
    count: 3,
    already: 'ghp_[REDACTED]',
    serialized: JSON.stringify({ msg: 'password="x; hunter2"' }),
  }
  const out = redactDeep(input)
  A.equal(out.token, '[REDACTED]', 'token 键的未知值必须整体脱敏')
  A.equal(out.apiKey, '[REDACTED]', 'apiKey 键的未知值必须整体脱敏')
  A.equal(out.nested.password, '[REDACTED]', '嵌套对象的敏感键同样按键脱敏')
  A.equal(out.message, 'normal text', '普通键值不得被误改')
  A.equal(out.count, 3, '普通数字保持原样')
  A.equal(out.already, 'ghp_[REDACTED]', '已知的完整脱敏形态原样保留')
  A.equal(out.serialized, '{"msg":"password=\\"[REDACTED]\\""}', '序列化事件文本不得泄漏')
  A.ok(!JSON.stringify(out).includes('hunter2'), '整个事件副本里不得出现 hunter2')
  A.equal(JSON.stringify(redactDeep(out)), JSON.stringify(out), '整体二次脱敏必须幂等')
})

// ---------------------------------------------------------------------------
// 0.15.2：B1 结构化键名 / B3 双重 JSON / M1 M3 键名集合 / M2 YAML 修饰符 /
//          M5 PEM 有界 / m1 方括号 / JSON 键值对 / HTML 实体 / 方案词 / 转义键名
// ---------------------------------------------------------------------------

await check('0.15.2 M1/M3：isSensitiveKeyName 覆盖复审列出的全部键名', () => {
  const sensitive = [
    'password', 'passwd', 'pwd', 'pass_word', 'passphrase', 'secret', 'secret_key',
    'access_key', 'private_key', 'apiKey', 'API-KEY', 'api_key', 'credential',
    'credentials', 'auth', 'authorization', 'token', 'token2', 'passwordHash',
    'sessionKey', 'ssh_key', 'cookie', '身份证密码', '密码', '密钥', '令牌', '口令',
    // m1：全角 / 零宽 / Unicode 转义 / HTML 数字实体的键名
    'ｐａｓｓｗｏｒｄ', 'pass\u200Bword', '\\u0070assword', '&#112;assword',
  ]
  for (const name of sensitive) {
    assert.equal(isSensitiveKeyName(name), true, `键名必须判敏感：${JSON.stringify(name)}`)
  }
  // 误伤豁免：`keyboard` / `keyspace` / `monkey` 这类含 key 的常见词不能当凭据。
  const innocent = [
    'message', 'count', 'value', 'name', 'type', 'author', 'credit',
    'keyboard', 'keyspace', 'monkey', 'donkey', 'turkey', 'hockey', 'whiskey',
    'hotkey', 'keynote', 'keyword', 'keyframe', 'keypress', 'publicKey', 'pub_key',
    'tokenizer', 'tokenize', 'secretary', 'passwordless', '',
  ]
  for (const name of innocent) {
    assert.equal(isSensitiveKeyName(name), false, `非凭据键名不得误伤：${JSON.stringify(name)}`)
  }
  // 豁免是逐词生效：复合键里剩下的敏感词仍然命中。
  assert.equal(isSensitiveKeyName('monkeyToken'), true, 'monkey 豁免不能给 Token 开后门')
  assert.equal(isSensitiveKeyName('keyboard_secret'), true, 'keyboard 豁免不能给 secret 开后门')
})

await check('0.15.2 回归：token 计数 / 上限键名不脱敏，token 凭据仍脱敏', () => {
  // 14 个复审列出的计数 / 上限键名（camel / snake / kebab 都覆盖）。
  const countKeys = [
    'inputTokens', 'outputTokens', 'cachedTokens', 'cacheReadTokens', 'cacheWriteTokens',
    'reasoningTokens', 'thoughtTokens', 'totalTokens', 'tokenCount', 'token_count',
    'maxTokens', 'max_tokens', 'tokensUsed', 'tokenLimit', 'limit_tokens',
    'input_tokens', 'output-tokens', 'max-tokens', 'tokens-used', 'token-limit',
  ]
  for (const key of countKeys) {
    assert.equal(isSensitiveKeyName(key), false, `计数/上限键名不得判敏感：${key}`)
  }
  // 事件里的 usage 数值必须原样保留（整值替换会把可观测性数据抹掉）。
  const usage = {
    inputTokens: 6501,
    outputTokens: 5,
    cachedTokens: 120,
    cacheReadTokens: 30,
    cacheWriteTokens: 7,
    reasoningTokens: 12,
    thoughtTokens: 3,
    totalTokens: 6506,
    tokenCount: 6506,
    maxTokens: 4096,
    tokensUsed: 6506,
    tokenLimit: 8192,
  }
  const out = redactStructured({ usage, note: 'keep-me' })
  A.deepEqual(out.usage, usage, 'usage 计数必须原样保留')
  A.equal(out.usage.inputTokens, 6501, 'inputTokens 数值不变')
  A.equal(out.usage.outputTokens, 5, 'outputTokens 数值不变')
  A.equal(out.note, 'keep-me')
  // 文本赋值形态同样不误伤计数。
  A.equal(redactText('usage inputTokens=6501 outputTokens=5'), 'usage inputTokens=6501 outputTokens=5')
  A.equal(redactText('max_tokens: 4096'), 'max_tokens: 4096')
  // 真正的 token 凭据仍必须敏感：access / refresh / id / api / 裸 token / token2。
  const credentialKeys = ['accessToken', 'refresh_token', 'token', 'token2', 'api_token', 'idToken']
  for (const key of credentialKeys) {
    assert.equal(isSensitiveKeyName(key), true, `token 凭据键名必须敏感：${key}`)
    assert.equal(redactStructured({ [key]: 'hunter2' })[key], '[REDACTED]', `${key} 的值必须整值脱敏`)
    assert.equal(redactText(`${key}=hunter2`).includes('hunter2'), false, `${key}= 文本形态必须脱敏`)
  }
  // 计数与凭据混在同一层：只抹凭据。
  const mixed = redactStructured({
    usage: { inputTokens: 6501, outputTokens: 5 },
    auth: { accessToken: 'hunter2' },
  })
  A.deepEqual(mixed.usage, { inputTokens: 6501, outputTokens: 5 })
  A.equal(mixed.auth, '[REDACTED]')
})

await check('0.15.2 B1：redactStructured 敏感键值整体替换，非字符串叶子原样', () => {
  const input = {
    item: {
      structured: {
        env: {
          password: 'hunter2',
          auth: 'hunter2',
          token2: 'hunter2',
          nested: { api_key: 'hunter2' },
        },
      },
    },
    message: 'normal text',
    count: 3,
    flag: true,
    nothing: null,
  }
  const out = redactStructured(input)
  assert.notEqual(out, input, '必须返回新对象，不原地改调用方数据')
  assert.notEqual(out.item, input.item, '嵌套对象也必须深拷贝')
  const env = out.item.structured.env
  assert.equal(env.password, '[REDACTED]')
  assert.equal(env.auth, '[REDACTED]')
  assert.equal(env.token2, '[REDACTED]')
  assert.equal(env.nested.api_key, '[REDACTED]')
  assert.equal(out.message, 'normal text', '普通键值不得误改')
  assert.equal(out.count, 3)
  assert.equal(out.flag, true)
  assert.equal(out.nothing, null)
  assert.equal(JSON.stringify(out).includes('hunter2'), false, '整个结构化副本不得出现 hunter2')
  // 敏感键下的对象也整体替换，不保留值形态（不与值形状协商）。
  assert.equal(redactStructured({ auth: { nested: 'hunter2' } }).auth, '[REDACTED]')
  assert.equal(redactStructured({ password: ['hunter2'] }).password, '[REDACTED]')
  // 非字符串叶子：Map / Set / Buffer / Date 原样返回（不遍历、不拷贝）。
  const map = new Map([['password', 'hunter2']])
  const set = new Set(['hunter2'])
  const buffer = Buffer.from('hunter2')
  const date = new Date(0)
  const leaves = redactStructured({ map, set, buffer, date })
  assert.equal(leaves.map, map, 'Map 是非字符串叶子，原样返回')
  assert.equal(leaves.set, set, 'Set 是非字符串叶子，原样返回')
  assert.equal(leaves.buffer, buffer, 'Buffer 是非字符串叶子，原样返回')
  assert.equal(leaves.date, date, 'Date 是非字符串叶子，原样返回')
  // 深度：达到 maxDepth 的子树用占位符，绝不返回原对象。
  let deep = { password: 'hunter2' }
  for (let index = 0; index < 12; index += 1) deep = { next: deep }
  const deepOut = redactStructured(deep)
  assert.equal(JSON.stringify(deepOut).includes('hunter2'), false)
  assert.equal(JSON.stringify(deepOut).includes('[redacted:depth]'), true)
  assert.equal(JSON.stringify(redactStructured(deepOut)), JSON.stringify(deepOut), '二次脱敏幂等')
  // secrets：本 execution 的精确秘密（与三个适配器同一入口）。
  assert.equal(
    redactStructured({ text: 'runDir=/tmp/abc/secret' }, { secrets: ['/tmp/abc/secret'] }).text,
    'runDir=[redacted]',
  )
  // capOversize='auto'：≤1 MiB 的合法长串不被预抹（600 KiB x…x 保持长度）。
  const long = 'x'.repeat(600 * 1024)
  assert.equal(redactStructured({ text: long }).text.length, 600 * 1024, '≤1 MiB 长串不得被预抹')
})

await check('0.15.2 M3：redactDeep 的键名判据覆盖 credential / auth / pwd / passphrase / token2 / passwordHash / 中文键', () => {
  const out = redactDeep({
    credential: 'hunter2',
    auth: 'hunter2',
    pwd: 'hunter2',
    passphrase: 'hunter2',
    token2: 'hunter2',
    passwordHash: 'hunter2',
    '密码': 'hunter2',
    normal: 'hunter2-not-sensitive-key',
  })
  for (const key of ['credential', 'auth', 'pwd', 'passphrase', 'token2', 'passwordHash']) {
    assert.equal(out[key], '[REDACTED]', `${key} 键必须整体脱敏`)
  }
  assert.equal(out['密码'], '[REDACTED]', '中文键名必须脱敏')
  // 值形态不像凭据的普通文本也不得因为键名放行（键名声明了它就是凭据）。
  assert.equal(JSON.stringify(out).includes('hunter2-not-sensitive-key'), true, '普通键不受影响')
})

await check('0.15.2 B3：双重 JSON 序列化与 \\\\" 转义反斜杠奇偶', () => {
  // B3-1：JSON.stringify(JSON.stringify(...)) → 键序列化成 \"password\"。
  const doubleJson = JSON.stringify(JSON.stringify({ password: 'hunter2' }))
  const outDouble = redactText(doubleJson)
  assert.equal(outDouble.includes('hunter2'), false, `双重 JSON 不得泄漏：${outDouble}`)
  assert.equal(redactText(outDouble), outDouble, '双重 JSON 脱敏必须幂等')
  // B3-2：值里同时有转义反斜杠 + 转义引号（\\\\"），旧实现把收尾引号提前。
  const tripleEscaped = JSON.stringify({ msg: 'password="say \\"hunter2\\""' })
  const outTriple = redactText(tripleEscaped)
  assert.equal(outTriple.includes('hunter2'), false, `\\\\" 不得提前收尾：${outTriple}`)
  assert.equal(redactText(outTriple), outTriple, '转义反斜杠脱敏必须幂等')
})

await check('0.15.2 M1：文本赋值的键名集合与结构化共用（secret_key / access_key / private_key / pwd / pass_word / passphrase / credential / auth / token2 / passwordHash）', () => {
  const cases = [
    'secret_key=hunter2',
    'access_key=hunter2',
    'private_key=hunter2',
    'pwd=hunter2',
    'pass_word=hunter2',
    'passphrase=hunter2',
    'credential=hunter2',
    'auth=hunter2',
    'token2=hunter2',
    'passwordHash=hunter2',
    '密码：hunter2',
    'secret_key = "hunter2"',
  ]
  for (const raw of cases) {
    const out = redactText(raw)
    assert.equal(out.includes('hunter2'), false, `M1 键名必须脱敏：${raw} → ${out}`)
    assert.equal(redactText(out), out, `M1 脱敏必须幂等：${raw}`)
  }
  // 非敏感键名不得误伤（避免把普通日志整段吃掉）。
  for (const raw of ['aws_region=us-east-1', 'keyboard=hhkb', 'author=alice', 'credit=10']) {
    assert.equal(redactText(raw), raw, `非敏感键名不得误伤：${raw}`)
  }
})

await check('0.15.2 M2：YAML anchor / tag / 注释后换行值都取真实值', () => {
  const cases = [
    ['password: &pw hunter2', 'password: "[REDACTED]"'],
    ['password: !!str hunter2', 'password: "[REDACTED]"'],
    ['password: !custom hunter2', 'password: "[REDACTED]"'],
    ['password: &pw "hunter2"', 'password: "[REDACTED]"'],
    ['password: # note\n  hunter2', 'password: "[REDACTED]"'],
    ['password: # note\n  hunter2\nnext_field: ok', 'password: "[REDACTED]"\nnext_field: ok'],
  ]
  for (const [raw, expected] of cases) {
    const out = redactText(raw)
    assert.equal(out, expected, `M2 YAML 修饰符必须脱敏：${JSON.stringify(raw)} → ${JSON.stringify(out)}`)
    assert.equal(out.includes('hunter2'), false)
    assert.equal(redactText(out), out, 'M2 脱敏必须幂等')
  }
})

await check('0.15.2 m1：方括号索引 / JSON 键值对数组 / HTML 实体 / 非 known 方案词', () => {
  const cases = [
    ['config["password"]=hunter2', 'config["password"]="[REDACTED]"'],
    ["config['pass_word']=hunter2", "config['pass_word']=\"[REDACTED]\""],
    ['["password","hunter2"]', '["password","[REDACTED]"]'],
    ['["password", "hunter2"]', '["password", "[REDACTED]"]'],
    ['[\\"password\\",\\"hunter2\\"]', '[\\"password\\",\\"[REDACTED]\\"]'],
    ['password=&#34;hunter2&#34;', 'password="[REDACTED]"'],
    ['password=&quot;hunter2&quot;', 'password="[REDACTED]"'],
    ['token=ApiKey hunter2', 'token=ApiKey [REDACTED]'],
    ['token=SSWS hunter2', 'token=SSWS [REDACTED]'],
    ['password=&#39;hunter2&#39;', 'password="[REDACTED]"'],
  ]
  for (const [raw, expected] of cases) {
    const out = redactText(raw)
    assert.equal(out, expected, `m1 写法必须脱敏：${JSON.stringify(raw)} → ${JSON.stringify(out)}`)
    assert.equal(redactText(out), out, 'm1 脱敏必须幂等')
  }
  // 非敏感键名的 JSON 对 / 方括号索引不得误伤。
  assert.equal(redactText('["name","alice"]'), '["name","alice"]')
  assert.equal(redactText('config["cursor"]=42'), 'config["cursor"]=42')
})

await check('0.15.2 M5：PEM 无 END 的重复 BEGIN 线性有界（7 KiB / 105 KiB / 1 MiB）', () => {
  const unit = '-----BEGIN PRIVATE KEY-----'
  const build = kib => unit.repeat(Math.max(1, Math.ceil(kib * 1024 / unit.length)))
  const measure = (kib) => {
    const raw = build(kib)
    const startedAt = performance.now()
    const out = redactText(raw)
    return { kib, inputBytes: raw.length, ms: performance.now() - startedAt, out }
  }
  const small = measure(7)
  const medium = measure(105)
  const large = measure(1024)
  for (const result of [small, medium, large]) {
    assert.equal(result.out, '[REDACTED]', `${result.kib} KiB 残留 BEGIN 必须整段替换`)
  }
  // 旧实现是平方增长：105 KiB 约 100 ms，1 MiB 约 10 s。现在窗口固定 8 KiB。
  assert.ok(medium.ms < 100, `105 KiB 必须在 100 ms 内（实际 ${medium.ms.toFixed(2)} ms）`)
  assert.ok(large.ms < 250, `1 MiB 必须在 250 ms 内（实际 ${large.ms.toFixed(2)} ms）`)
  assert.ok(
    large.ms < Math.max(100, medium.ms * 30),
    `不得平方增长：105 KiB ${medium.ms.toFixed(2)} ms → 1 MiB ${large.ms.toFixed(2)} ms`,
  )
  // 完整块仍然保留可识别的 BEGIN/END 头（幂等）。
  const complete = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'short-key-material-42',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n')
  const completeOut = redactText(complete)
  assert.equal(completeOut, '-----BEGIN RSA PRIVATE KEY-----\n[REDACTED]\n-----END RSA PRIVATE KEY-----')
  assert.equal(redactText(completeOut), completeOut, '完整 PEM 脱敏必须幂等')
})
