#!/usr/bin/env node
/**
 * http-policy.js 自检：目标校验（校验即连接）、地址分类、CIDR 例外、authRef 与脱敏。
 *
 * 不联网：DNS 全部由测试注入的 resolver 提供；只验证纯函数与返回的 lookup。
 * 运行：node test/http-policy.test.mjs
 */

import assert from 'node:assert/strict'

import {
  addressInCidr,
  authRefEnvName,
  classifyAddress,
  HTTP_LIMITS,
  isSecretHeaderName,
  normalizeHttpPolicy,
  redactHttpConfig,
  resolveAuthRef,
  validateDestination,
  HttpPolicyError,
} from '../src/http-policy.js'

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

async function rejects(promise, code, message) {
  assertions += 1
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `${message}（实际 code=${error.code}，message=${error.message}）`)
    return true
  })
}

function policyThrows(fn, message) {
  assertions += 1
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'HTTP_POLICY_INVALID', `${message}（实际 code=${error.code}，message=${error.message}）`)
    return true
  })
}

const PUBLIC_V4 = '93.184.216.34'
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946'

function resolverWith(map) {
  const calls = []
  const resolve = async (hostname) => {
    calls.push(hostname)
    return map[hostname] ?? []
  }
  return { resolve, calls }
}

await check('normalizeHttpPolicy：默认值安全、上限有界', async () => {
  const policy = normalizeHttpPolicy({})
  A.deepEqual(policy.allowInsecureOrigins, [])
  A.deepEqual(policy.allowedHosts, [])
  A.deepEqual(policy.allowedCidrs, [])
  A.equal(policy.allowMetadata, false)
  A.equal(policy.allowRedirects, false)
  A.equal(policy.maxRequestBytes, HTTP_LIMITS.maxRequestBytes, '请求体默认 256 KiB')
  A.equal(policy.defaultResponseBytes, HTTP_LIMITS.defaultResponseBytes, '响应默认 1 MiB')
  A.equal(policy.hardResponseBytes, HTTP_LIMITS.hardResponseBytes, '响应硬上限 5 MiB')
  A.equal(policy.maxRetries, 3, '显式重试最多 3 次')
  const clamped = normalizeHttpPolicy({
    defaultResponseBytes: 99 * 1024 * 1024,
    hardResponseBytes: 99 * 1024 * 1024,
    maxRetries: 99,
    maxRequestBytes: 0,
  })
  A.equal(clamped.defaultResponseBytes, HTTP_LIMITS.hardResponseBytes, '响应上限被硬上限截断')
  A.equal(clamped.hardResponseBytes, HTTP_LIMITS.hardResponseBytes, '硬上限不可放大')
  A.equal(clamped.maxRetries, 3, '重试次数被硬上限截断')
  A.equal(clamped.maxRequestBytes, HTTP_LIMITS.maxRequestBytes, '非法请求体上限回落默认')
})

await check('HTTPS 公网地址：全部 DNS 结果校验，lookup 固定已验证地址', async () => {
  const { resolve, calls } = resolverWith({
    'api.example.com': [
      { address: PUBLIC_V4, family: 4 },
      { address: PUBLIC_V6, family: 6 },
    ],
  })
  const result = await validateDestination('https://api.example.com/orders?x=1', {}, { resolve })
  A.equal(result.ok, true)
  A.equal(result.protocol, 'https:')
  A.equal(result.hostname, 'api.example.com')
  A.equal(result.port, 443)
  A.equal(result.insecure, false)
  A.deepEqual(result.addresses.map(item => item.address), [PUBLIC_V4, PUBLIC_V6], '所有解析结果进入已验证清单')
  A.deepEqual(calls, ['api.example.com'], '只解析一次（校验阶段）')

  let pinned = null
  await new Promise((resolveLookup, rejectLookup) => {
    result.lookup('api.example.com', {}, (error, address, family) => {
      if (error) rejectLookup(error)
      else {
        pinned = { address, family }
        resolveLookup()
      }
    })
  })
  A.deepEqual(pinned, { address: PUBLIC_V4, family: 4 }, '连接使用已验证地址，而不是再次解析')
})

await check('所有 DNS 结果中有私网地址 → 整次拒绝（防 DNS 重绑定）', async () => {
  const { resolve } = resolverWith({
    'rebind.example.com': [
      { address: PUBLIC_V4, family: 4 },
      { address: '10.0.0.7', family: 4 },
    ],
  })
  await rejects(
    validateDestination('https://rebind.example.com/', {}, { resolve }),
    'HTTP_DESTINATION_BLOCKED',
    '任意一条 DNS 结果落在私网就必须拒绝',
  )
})

await check('http 默认拒绝；allowInsecureOrigins 精确放行测试台', async () => {
  const { resolve } = resolverWith({ 'fixture.test': [{ address: '127.0.0.1', family: 4 }] })
  await rejects(
    validateDestination('http://fixture.test:18080/hook', {}, { resolve }),
    'HTTP_INSECURE_FORBIDDEN',
    '默认只允许 HTTPS',
  )
  const allowed = await validateDestination(
    'http://fixture.test:18080/hook',
    { allowInsecureOrigins: ['fixture.test:18080'] },
    { resolve },
  )
  A.equal(allowed.ok, true)
  A.equal(allowed.insecure, true)
  A.equal(allowed.origin, 'http://fixture.test:18080')
  // 只放行精确 host:port，换端口仍然拒绝。
  await rejects(
    validateDestination('http://fixture.test:18081/hook', { allowInsecureOrigins: ['fixture.test:18080'] }, { resolve }),
    'HTTP_INSECURE_FORBIDDEN',
    '端口必须精确匹配',
  )
})

await check('userinfo / 非 http(s) / metadata 主机名：明确拒绝', async () => {
  await rejects(
    validateDestination('https://user:pass@example.com/', {}, { resolve: async () => [{ address: PUBLIC_V4, family: 4 }] }),
    'HTTP_URL_USERINFO_FORBIDDEN',
    'URL userinfo 必须拒绝',
  )
  await rejects(
    validateDestination('ftp://example.com/', {}),
    'HTTP_PROTOCOL_FORBIDDEN',
    '非 http(s) 协议必须拒绝',
  )
  await rejects(
    validateDestination('https://metadata.google.internal/', {}),
    'HTTP_DESTINATION_METADATA',
    'metadata 主机名即使能解析也不许访问',
  )
})

await check('私网 / 回环 / link-local / metadata / IPv6 私网：默认阻断', async () => {
  const cases = [
    ['127.0.0.1', 'HTTP_DESTINATION_BLOCKED'],
    ['10.1.2.3', 'HTTP_DESTINATION_BLOCKED'],
    ['172.16.0.9', 'HTTP_DESTINATION_BLOCKED'],
    ['192.168.1.10', 'HTTP_DESTINATION_BLOCKED'],
    ['169.254.169.254', 'HTTP_DESTINATION_METADATA'],
    ['100.100.100.200', 'HTTP_DESTINATION_METADATA'],
    ['::1', 'HTTP_DESTINATION_BLOCKED'],
    ['fd00::1', 'HTTP_DESTINATION_BLOCKED'],
    ['fe80::1', 'HTTP_DESTINATION_BLOCKED'],
    ['::ffff:10.0.0.1', 'HTTP_DESTINATION_BLOCKED'],
  ]
  for (const [address, code] of cases) {
    if (address.includes(':')) {
      await rejects(
        validateDestination(`https://[${address}]/`),
        code,
        `${address} 默认必须阻断`,
      )
    } else {
      await rejects(
        validateDestination(`https://${address}/`),
        code,
        `${address} 默认必须阻断`,
      )
    }
  }
  const policy = normalizeHttpPolicy({})
  A.equal(policy.allowMetadata, false)
})

await check('host:port / CIDR 例外：只放行显式配置的内网目标', async () => {
  const { resolve } = resolverWith({ 'internal.example': [{ address: '10.20.30.40', family: 4 }] })
  await rejects(
    validateDestination('https://internal.example:8443/', {}, { resolve }),
    'HTTP_DESTINATION_BLOCKED',
    '未配置例外时内网地址必须拒绝',
  )
  const byHost = await validateDestination(
    'https://internal.example:8443/',
    { allowedHosts: ['internal.example:8443'] },
    { resolve },
  )
  A.equal(byHost.ok, true, 'host:port 例外可放行内网 https')
  await rejects(
    validateDestination('https://internal.example:9443/', { allowedHosts: ['internal.example:8443'] }, { resolve }),
    'HTTP_DESTINATION_BLOCKED',
    '例外端口精确匹配',
  )

  const byCidr = await validateDestination(
    'https://internal.example/',
    { allowedCidrs: ['10.0.0.0/8'] },
    { resolve },
  )
  A.equal(byCidr.ok, true, 'CIDR 例外可放行内网 https')
  await rejects(
    validateDestination('https://internal.example/', { allowedCidrs: ['192.168.0.0/16'] }, { resolve }),
    'HTTP_DESTINATION_BLOCKED',
    '不在 CIDR 内的地址仍然拒绝',
  )
})

await check('addressInCidr / classifyAddress：IPv4 与 IPv6 边界', async () => {
  A.equal(addressInCidr('10.1.2.3', '10.0.0.0/8'), true)
  A.equal(addressInCidr('11.1.2.3', '10.0.0.0/8'), false)
  A.equal(addressInCidr('192.168.1.1', '192.168.0.0/16'), true)
  A.equal(addressInCidr('192.169.1.1', '192.168.0.0/16'), false)
  A.equal(addressInCidr('2001:db8::1', '2001:db8::/32'), true)
  A.equal(addressInCidr('2001:db9::1', '2001:db8::/32'), false)
  A.equal(addressInCidr('::1', '::1/128'), true)
  A.equal(addressInCidr('::2', '::1/128'), false)
  A.deepEqual(classifyAddress('8.8.8.8'), { family: 4, kind: 'public' })
  A.deepEqual(classifyAddress('127.0.0.1'), { family: 4, kind: 'loopback' })
  A.deepEqual(classifyAddress('169.254.169.254'), { family: 4, kind: 'metadata' })
  A.deepEqual(classifyAddress('::1'), { family: 6, kind: 'loopback' })
  A.deepEqual(classifyAddress('fd12::1'), { family: 6, kind: 'private' })
  A.deepEqual(classifyAddress('::ffff:7f00:1'), { family: 6, kind: 'loopback' }, 'IPv4-mapped 回环')
  A.deepEqual(classifyAddress('64:ff9b::a00:1'), { family: 6, kind: 'private' }, 'NAT64 内嵌私网')
  A.equal(classifyAddress('not-an-ip'), null)
})

await check('H1：本地 NAT64 / site-local / 其他特殊用途前缀默认不是公网', async () => {
  A.deepEqual(classifyAddress('64:ff9b:1::a00:1'), { family: 6, kind: 'nat64-local' }, 'RFC 8215 本地转换前缀')
  A.deepEqual(classifyAddress('fec0::1'), { family: 6, kind: 'site-local' }, 'fec0::/10 站点本地')
  A.deepEqual(classifyAddress('::7f00:1'), { family: 6, kind: 'loopback' }, 'IPv4-compatible 回环不得当公网')
  A.deepEqual(classifyAddress('2001:2::1'), { family: 6, kind: 'benchmark' })
  A.deepEqual(classifyAddress('3fff::1'), { family: 6, kind: 'documentation' })
  A.deepEqual(classifyAddress('5f00::1'), { family: 6, kind: 'reserved' })
  A.deepEqual(classifyAddress('64:ff9b::5db8:d822'), { family: 6, kind: 'public' }, 'well-known NAT64 内嵌公网地址仍可用')

  for (const address of ['64:ff9b:1::a00:1', 'fec0::1', '2001:2::1', '3fff::1', '5f00::1']) {
    await rejects(
      validateDestination(`https://[${address}]/`),
      'HTTP_DESTINATION_BLOCKED',
      `${address} 默认必须阻断`,
    )
  }
  // 显式启用本地 NAT64 后，内嵌 IPv4 仍必须本身是公网；私网 / 回环不能借转换前缀绕过。
  await rejects(
    validateDestination('https://[64:ff9b:1::5db8:d822]/'),
    'HTTP_DESTINATION_BLOCKED',
    '未配置 nat64Prefixes 时本地转换前缀整体阻断',
  )
  await rejects(
    validateDestination('https://[64:ff9b:1::a00:1]/', { nat64Prefixes: ['64:ff9b:1::/48'] }),
    'HTTP_DESTINATION_BLOCKED',
    '显式启用后内嵌私网 IPv4 仍阻断',
  )
  const allowed = await validateDestination(
    'https://[64:ff9b:1::5db8:d822]/',
    { nat64Prefixes: ['64:ff9b:1::/48'] },
  )
  A.equal(allowed.ok, true, '显式启用且内嵌公网 IPv4 才允许')
  A.equal(allowed.addresses[0].address, '64:ff9b:1::5db8:d822')
  policyThrows(() => normalizeHttpPolicy({ nat64Prefixes: ['2002::/16'] }), 'nat64Prefixes 只接受 64:ff9b:1::/48 子前缀')
  policyThrows(() => normalizeHttpPolicy({ nat64Prefixes: ['64:ff9b:1::/24'] }), 'nat64Prefixes 前缀长度必须 32–96')
})

await check('H2：非法 / 通配符 / 空前缀策略配置加载即报错，不静默扩权', async () => {
  policyThrows(() => normalizeHttpPolicy({ allowInsecureOrigins: ['*'] }), 'allowInsecureOrigins 不接受通配符')
  policyThrows(() => normalizeHttpPolicy({ allowInsecureOrigins: ['127.0.0.1'] }), 'allowInsecureOrigins 必须显式端口')
  policyThrows(() => normalizeHttpPolicy({ allowedHosts: ['*:443'] }), 'allowedHosts 不接受通配符主机')
  policyThrows(() => normalizeHttpPolicy({ allowedHosts: ['internal.example:0'] }), '端口必须 1–65535')
  policyThrows(() => normalizeHttpPolicy({ allowedCidrs: ['10.0.0.0/'] }), 'CIDR 前缀不能为空')
  policyThrows(() => normalizeHttpPolicy({ allowedCidrs: ['10.0.0.0/33'] }), 'IPv4 前缀长度上限 32')
  policyThrows(() => normalizeHttpPolicy({ allowedCidrs: ['not-an-ip/8'] }), 'CIDR 网络地址必须合法')
  policyThrows(() => normalizeHttpPolicy({ allowedCidrs: ['10.0.0.0/8*'] }), 'CIDR 不接受通配符')
  policyThrows(
    () => normalizeHttpPolicy({ authOrigins: { api: ['https://api.example.com/path'] } }),
    'authOrigins 只能写 origin，不能带路径',
  )

  // 两个实测反例：修复前 `*` 与 `10.0.0.0/` 都能放行任意目标；现在整次校验直接失败。
  await rejects(
    validateDestination('http://127.0.0.1:9999/x', { allowInsecureOrigins: ['*'] }),
    'HTTP_POLICY_INVALID',
    '通配符不能把回环明文目标放行',
  )
  await rejects(
    validateDestination('https://192.168.1.2/', { allowedCidrs: ['10.0.0.0/'] }),
    'HTTP_POLICY_INVALID',
    '空前缀 CIDR 不能变成 /0 放行一切',
  )

  const normalized = normalizeHttpPolicy({
    allowInsecureOrigins: ['127.0.0.1:18080'],
    allowedHosts: ['[::1]:8443'],
    allowedCidrs: ['10.0.0.0/8'],
    authOrigins: { api: ['https://api.example.com'] },
  })
  A.deepEqual(normalized.allowInsecureOrigins, ['127.0.0.1:18080'], '合法配置保持精确 host:port')
  A.deepEqual(normalized.allowedHosts, ['[::1]:8443'], 'IPv6 例外保留方括号')
  A.deepEqual(normalized.authOrigins.api, ['https://api.example.com:443'], 'authOrigins 归一化成显式端口')
})

await check('authRef：缺失 / 非法明确报错，值时不出现在错误里', async () => {
  A.equal(authRefEnvName('orders-api'), 'FLOW_STUDIO_HTTP_AUTH_ORDERS_API')
  await rejects(
    resolveAuthRef('orders-api', { env: {} }),
    'HTTP_AUTH_REF_UNRESOLVED',
    '缺少宿主凭据必须明确失败',
  )
  const bearer = await resolveAuthRef('orders-api', { env: { FLOW_STUDIO_HTTP_AUTH_ORDERS_API: 'super-secret-token' } })
  A.deepEqual(bearer, { authorization: 'Bearer super-secret-token' })

  const basic = await resolveAuthRef('basic-ref', {
    env: {
      FLOW_STUDIO_HTTP_AUTH_BASIC_REF: JSON.stringify({ type: 'basic', username: 'u', password: 'p' }),
    },
  })
  A.deepEqual(basic, { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` })

  const header = await resolveAuthRef('header-ref', {
    env: {
      FLOW_STUDIO_HTTP_AUTH_HEADER_REF: JSON.stringify({ type: 'header', name: 'X-Api-Key', value: 'k-123' }),
    },
  })
  A.deepEqual(header, { 'x-api-key': 'k-123' })

  const injected = await resolveAuthRef('remote', { resolve: async () => ({ 'X-Token': 'abc' }) })
  A.deepEqual(injected, { 'x-token': 'abc' })

  // 非法 JSON：错误里不能包含原始值。
  const secret = 'top-secret-value-that-must-not-leak'
  try {
    await resolveAuthRef('broken', { env: { FLOW_STUDIO_HTTP_AUTH_BROKEN: `{${secret}` } })
    assertions += 1
    assert.fail('非法 JSON 必须抛错')
  } catch (error) {
    assertions += 1
    const text = `${error.code} ${error.message} ${JSON.stringify(error.details)}`
    A.ok(!text.includes(secret), '错误文本 / details 不得包含凭据值')
    A.equal(error.code, 'HTTP_AUTH_REF_INVALID')
  }
})

await check('redactHttpConfig / isSecretHeaderName：鉴权头显示为 [redacted]', async () => {
  A.equal(isSecretHeaderName('Authorization'), true)
  A.equal(isSecretHeaderName('cookie'), true)
  A.equal(isSecretHeaderName('x-api-key'), true)
  A.equal(isSecretHeaderName('content-type'), false)
  const redacted = redactHttpConfig({
    method: 'POST',
    url: 'https://example.com/hook?token=abc&x=1',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer secret',
      cookie: 'sid=secret',
    },
    authRef: 'orders-api',
  })
  A.equal(redacted.headers['content-type'], 'application/json')
  A.equal(redacted.headers.authorization, '[redacted]')
  A.equal(redacted.headers.cookie, '[redacted]')
  A.ok(!JSON.stringify(redacted).includes('Bearer secret'), '脱敏后的 JSON 不含密钥值')
  A.match(redacted.url, /token=%5Bredacted%5D|token=\[redacted\]/, 'URL 里的 token 查询参数被替换')
  A.equal(redacted.authRef, 'orders-api', 'authRef 只是引用名，可以保留')
})

await check('错误对象只带稳定 code，不抛原生异常', async () => {
  try {
    await validateDestination('', {})
    assertions += 1
    assert.fail('空 URL 必须抛错')
  } catch (error) {
    assertions += 1
    A.ok(error instanceof HttpPolicyError)
    A.equal(error.code, 'HTTP_URL_INVALID')
  }
})

console.log(`\nhttp-policy: ${checks} 组 / ${assertions} 条断言通过`)
