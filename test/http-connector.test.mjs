#!/usr/bin/env node
/**
 * http-connector.js 自检：本机 node:http fixture，不访问外网。
 *
 * 覆盖：成功 + IO 映射 / 502→200 重试与幂等键 / 无幂等 POST 超时不重发 /
 * 响应超限 / 压缩超限 / 重定向拒绝 / 私网拒绝 / 成功结果复用 / 取消后迟到响应 /
 * 映射混用拒绝 / 输出预算 / authRef 不泄露 / DNS 固定地址。
 *
 * 运行：node test/http-connector.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { createConnectorStore } from '../src/connector-store.js'
import { executeHttpConnector } from '../src/http-connector.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

let checks = 0
let assertions = 0

const A = {
  equal(actual, expected, message) {
    assertions += 1
    assert.equal(actual, expected, message)
  },
  // deepEqual / ok 里再计一次断言，便于报告「组数 / 断言数」。
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
  const root = mkdtempSync(join(repoRoot, '.tmp', 'connector-'))
  try {
    await fn({ root })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

async function rejects(promise, code, message) {
  assertions += 1
  await assert.rejects(promise, (error) => {
    const codes = Array.isArray(code) ? code : [code]
    assert.ok(codes.includes(error.code), `${message}（实际 code=${error.code}，message=${error.message}）`)
    return true
  })
}

/** 启动一个记录请求的本机 fixture。 */
function startFixture(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(entry)
      try {
        handler(req, res, entry, requests.length)
      } catch (error) {
        res.destroy(error)
      }
    })
  })
  return new Promise(resolveServer => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolveServer({
        port,
        requests,
        close: () => new Promise(resolveClose => server.close(() => resolveClose())),
      })
    })
  })
}

function makeContext(overrides = {}) {
  const events = []
  return {
    instanceId: 'i-test',
    executionId: 'call_execution_1',
    attempt: 1,
    variables: {},
    events,
    emit: event => events.push(event),
    ...overrides,
  }
}

/** H5 起记录键使用稳定激活身份（elementId + ctx.attempt），不再是随机 executionId。 */
function invocationIdentity(attempt = 1) {
  return { instanceId: 'i-test', elementId: 'call', executionId: `call_attempt_${attempt}` }
}

function elementOf(httpConfig, ioMapping = { input: [], output: [] }) {
  return {
    id: 'call',
    kind: 'http',
    node: { http: httpConfig },
    ioMapping,
  }
}

function policyFor(port, extra = {}) {
  return {
    allowInsecureOrigins: [`127.0.0.1:${port}`],
    retryBackoffBaseMs: 1,
    retryBackoffMaxMs: 5,
    ...extra,
  }
}

function eventsOfType(events, type) {
  return events.filter(event => event.type === type)
}

await check('成功：POST + 输入/输出映射，事件成对，实例变量不被输入映射污染', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-1' })
    res.end(JSON.stringify({ ok: true, items: [1, 2] }))
  })
  try {
    const ctx = makeContext({ variables: { order_id: 'o-42' } })
    const store = createConnectorStore({ root: join(root, 'store') })
    const result = await executeHttpConnector(
      elementOf(
        {
          method: 'POST',
          url: `http://127.0.0.1:${fixture.port}/orders`,
          headers: { 'content-type': 'application/json' },
          body: '{"static":true}',
          timeoutMs: 3000,
        },
        {
          input: [{ source: '= { orderId: order_id }', target: 'body' }],
          output: [
            { source: '= response.status', target: 'http_status' },
            { source: '= response.body.ok', target: 'accepted' },
          ],
        },
      ),
      ctx,
      { policy: policyFor(fixture.port), store },
    )

    A.equal(result.status, 200)
    A.deepEqual(result.output, { http_status: 200, accepted: true }, '只返回显式映射的短标量')
    A.equal(result.headers['content-type'], 'application/json', '响应头走白名单')
    A.equal(result.headers['x-request-id'], 'req-1')
    A.equal(result.headers['set-cookie'], undefined, 'set-cookie 永不回传')

    A.equal(fixture.requests.length, 1)
    A.equal(fixture.requests[0].body, '{"orderId":"o-42"}', '输入映射在局部上下文求值并覆盖静态 body')

    A.equal(ctx.variables.order_id, 'o-42', '输入映射不修改实例变量')
    A.equal(ctx.variables.http_status, undefined, '连接器不直接写实例变量（由 runner 合并输出）')
    A.equal(ctx.variables.accepted, undefined)

    const attempts = eventsOfType(ctx.events, 'http/attempt')
    const results = eventsOfType(ctx.events, 'http/result')
    A.equal(attempts.length, 1)
    A.equal(attempts[0].attempt, 1)
    A.equal(attempts[0].origin, `http://127.0.0.1:${fixture.port}`)
    A.equal(attempts[0].path, '/orders', '事件里不含查询串（可能含敏感参数）')
    A.equal(results.length, 1)
    A.equal(results[0].status, 200)

    const record = await store.readInvocation(invocationIdentity())
    A.equal(record.state, 'succeeded', '成功结果在返回引擎前落盘')
    A.equal(record.attempts, 1)
  } finally {
    await fixture.close()
  }
})

await check('502→200：只成功一次，两次请求使用同一幂等键', async ({ root }) => {
  const fixture = await startFixture((req, res, entry, index) => {
    if (index === 1) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('bad gateway')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ accepted: true }))
  })
  try {
    const ctx = makeContext()
    const result = await executeHttpConnector(
      elementOf(
        {
          method: 'POST',
          url: `http://127.0.0.1:${fixture.port}/orders`,
          retries: 2,
          idempotencyMode: 'remote-key',
          idempotencyHeader: 'Idempotency-Key',
          timeoutMs: 3000,
        },
        {
          input: [{ source: '= { orderId: order_id }', target: 'body' }],
          output: [{ source: '= response.body.accepted', target: 'accepted' }],
        },
      ),
      makeContext({ ...ctx, variables: { order_id: 'o-7' } }),
      { policy: policyFor(fixture.port), store: createConnectorStore({ root: join(root, 'store') }) },
    )
    A.equal(result.status, 200)
    A.deepEqual(result.output, { accepted: true })
    A.equal(fixture.requests.length, 2, '502 后重试一次')
    const keys = fixture.requests.map(entry => entry.headers['idempotency-key'])
    A.equal(typeof keys[0], 'string')
    A.ok(keys[0].startsWith('fs-'))
    A.equal(keys[1], keys[0], '同一次 execution 的重试共享幂等键')
    A.equal(fixture.requests[0].body, '{"orderId":"o-7"}')
    A.equal(fixture.requests[1].body, '{"orderId":"o-7"}')
  } finally {
    await fixture.close()
  }
})

await check('无幂等键的 POST 超时：不自动重发，报 HTTP_TIMEOUT', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"late":true}')
    }, 800)
  })
  try {
    const store = createConnectorStore({ root: join(root, 'store') })
    await rejects(
      executeHttpConnector(
        elementOf({
          method: 'POST',
          url: `http://127.0.0.1:${fixture.port}/pay`,
          retries: 3,
          timeoutMs: 300,
        }),
        makeContext(),
        { policy: policyFor(fixture.port), store },
      ),
      'HTTP_TIMEOUT',
      '超时必须明确失败',
    )
    A.ok(fixture.requests.length <= 1, '有副作用且无幂等键 → 超时不重发（负载下可能连首个请求都没发出，但绝不能 >1）')
    const record = await store.readInvocation(invocationIdentity())
    A.equal(record.state, 'failed')
    A.equal(record.error.code, 'HTTP_TIMEOUT')
  } finally {
    await fixture.close()
  }
})

await check('响应超限：读取时按字节中止（默认 / 配置上限）', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('x'.repeat(8192))
  })
  try {
    await rejects(
      executeHttpConnector(
        elementOf({
          method: 'GET',
          url: `http://127.0.0.1:${fixture.port}/big`,
          maxResponseBytes: 1024,
          timeoutMs: 3000,
        }),
        makeContext(),
        { policy: policyFor(fixture.port), store: createConnectorStore({ root: join(root, 'store') }) },
      ),
      'HTTP_RESPONSE_TOO_LARGE',
      '超过 1 KiB 配置上限必须中止',
    )
    A.equal(fixture.requests.length, 1)
  } finally {
    await fixture.close()
  }
})

await check('压缩响应：按解压后体积限制（gzip 炸弹）', async ({ root }) => {
  const payload = gzipSync(Buffer.alloc(64 * 1024, 0x78))
  const fixture = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
    res.end(payload)
  })
  try {
    await rejects(
      executeHttpConnector(
        elementOf({
          method: 'GET',
          url: `http://127.0.0.1:${fixture.port}/zip`,
          maxResponseBytes: 1024,
          timeoutMs: 3000,
        }),
        makeContext(),
        { policy: policyFor(fixture.port), store: createConnectorStore({ root: join(root, 'store') }) },
      ),
      'HTTP_RESPONSE_TOO_LARGE',
      '解压后超过 1 KiB 必须中止',
    )
    A.equal(fixture.requests.length, 1)
  } finally {
    await fixture.close()
  }
})

await check('重定向：3xx 直接拒绝，不跟随、不转发凭据', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    res.writeHead(302, { location: 'https://evil.example/steal' })
    res.end()
  })
  try {
    const stored = []
    await rejects(
      executeHttpConnector(
        elementOf({
          method: 'GET',
          url: `http://127.0.0.1:${fixture.port}/go`,
          authRef: 'orders',
          timeoutMs: 3000,
        }),
        makeContext(),
        {
          policy: policyFor(fixture.port),
          store: createConnectorStore({ root: join(root, 'store') }),
          env: { FLOW_STUDIO_HTTP_AUTH_ORDERS: 'redirect-secret' },
          emit: event => stored.push(event),
        },
      ),
      'HTTP_REDIRECT_FORBIDDEN',
      '重定向必须明确失败',
    )
    A.equal(fixture.requests.length, 1, '不跟随到第二跳')
  } finally {
    await fixture.close()
  }
})

await check('目标策略：明文 http / 私网地址默认拒绝，请求零发出', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    res.writeHead(200)
    res.end('should-not-happen')
  })
  try {
    const store = createConnectorStore({ root: join(root, 'store') })
    await rejects(
      executeHttpConnector(
        elementOf({ method: 'GET', url: `http://127.0.0.1:${fixture.port}/x`, timeoutMs: 1000 }),
        makeContext(),
        { policy: {}, store },
      ),
      'HTTP_INSECURE_FORBIDDEN',
      '默认只允许 HTTPS',
    )
    await rejects(
      executeHttpConnector(
        elementOf({ method: 'GET', url: `https://127.0.0.1:${fixture.port}/x`, timeoutMs: 1000 }),
        makeContext(),
        { policy: {}, store },
      ),
      'HTTP_DESTINATION_BLOCKED',
      '回环地址默认阻断',
    )
    A.equal(fixture.requests.length, 0, '目标校验在发送前完成，一个请求都不能发')
  } finally {
    await fixture.close()
  }
})

await check('DNS 固定：只解析一次，连接使用已验证地址', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    const calls = []
    const result = await executeHttpConnector(
      elementOf({
        method: 'GET',
        url: `http://fixture.test:${fixture.port}/pinned`,
        timeoutMs: 3000,
      }),
      makeContext(),
      {
        policy: {
          allowInsecureOrigins: [`fixture.test:${fixture.port}`],
          resolver: async hostname => {
            calls.push(hostname)
            return [{ address: '127.0.0.1', family: 4 }]
          },
          retryBackoffBaseMs: 1,
        },
        store: createConnectorStore({ root: join(root, 'store') }),
      },
    )
    A.equal(result.status, 200)
    A.deepEqual(calls, ['fixture.test'], '校验阶段只解析一次')
    A.equal(fixture.requests.length, 1)
    A.equal(fixture.requests[0].headers.host, `fixture.test:${fixture.port}`, 'Host 仍是配置里的主机名')
  } finally {
    await fixture.close()
  }
})

await check('成功结果复用：重启窗口内不再请求远端', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end('{"accepted":true}')
  })
  try {
    const storeRoot = join(root, 'store')
    const config = {
      method: 'POST',
      url: `http://127.0.0.1:${fixture.port}/orders`,
      idempotencyMode: 'remote-key',
      idempotencyHeader: 'Idempotency-Key',
      timeoutMs: 3000,
    }
    const io = { output: [{ source: '= response.body.accepted', target: 'accepted' }], input: [] }
    const first = await executeHttpConnector(elementOf(config, io), makeContext(), {
      policy: policyFor(fixture.port),
      store: createConnectorStore({ root: storeRoot }),
    })
    A.equal(first.output.accepted, true)
    A.equal(fixture.requests.length, 1)

    // 新 store 实例 = 重启后的进程；同一 execution 身份。
    const ctx2 = makeContext()
    const second = await executeHttpConnector(elementOf(config, io), ctx2, {
      policy: policyFor(fixture.port),
      store: createConnectorStore({ root: storeRoot }),
    })
    A.deepEqual(second.output, { accepted: true }, '复用已持久化结果')
    A.equal(fixture.requests.length, 1, '不再请求远端')
    const results = eventsOfType(ctx2.events, 'http/result')
    A.equal(results.length, 1)
    A.equal(results[0].reused, true)
    A.equal(eventsOfType(ctx2.events, 'http/attempt').length, 0, '复用不产生新的 attempt')
  } finally {
    await fixture.close()
  }
})

await check('取消：迟到响应不得推动流程，记录标成结果不明', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"late":true}')
    }, 200)
  })
  try {
    const store = createConnectorStore({ root: join(root, 'store') })
    const controller = new AbortController()
    const ctx = makeContext({ signal: controller.signal })
    const pending = executeHttpConnector(
      elementOf({
        method: 'POST',
        url: `http://127.0.0.1:${fixture.port}/slow`,
        retries: 2,
        idempotencyMode: 'remote-key',
        idempotencyHeader: 'Idempotency-Key',
        timeoutMs: 3000,
      }),
      ctx,
      { policy: policyFor(fixture.port), store },
    )
    // 等 fixture 真正收到请求再取消：这样断言的是「迟到响应不推动流程」，
    // 而不是「连接还没建立就 abort」。
    for (let index = 0; index < 200 && fixture.requests.length === 0; index += 1) {
      await new Promise(resolveWait => setTimeout(resolveWait, 5))
    }
    A.equal(fixture.requests.length, 1, '请求已经到达 fixture')
    controller.abort()
    await rejects(pending, 'HTTP_CANCELED', '取消必须显式失败')
    A.equal(fixture.requests.length, 1, '取消后不重试')
    const record = await store.readInvocation(invocationIdentity())
    A.equal(record.state, 'unknown', '已发送但结果不明 → unknown')
    A.equal(record.error.code, 'HTTP_OUTCOME_UNKNOWN')
    A.equal(eventsOfType(ctx.events, 'http/result').length, 0, '取消后不得产生成功结果事件')
    // 让 fixture 的迟到响应走完，确认没有未处理异常 / 二次写。
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
    A.equal(record.state, 'unknown')
  } finally {
    await fixture.close()
  }
})

await check('映射混用 / 旧映射：加载即拒绝，零请求', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    res.writeHead(200)
    res.end('x')
  })
  try {
    const store = createConnectorStore({ root: join(root, 'store') })
    const mixed = elementOf(
      { method: 'GET', url: `http://127.0.0.1:${fixture.port}/x`, inputMapping: '{"a":1}', timeoutMs: 1000 },
      { input: [{ source: '= 1', target: 'body' }], output: [] },
    )
    await rejects(
      executeHttpConnector(mixed, makeContext(), { policy: policyFor(fixture.port), store }),
      'HTTP_MAPPING_AMBIGUOUS',
      'zeebe:ioMapping 与 fs:http.inputMapping 混用必须拒绝',
    )
    const legacy = elementOf({
      method: 'GET',
      url: `http://127.0.0.1:${fixture.port}/x`,
      outputMapping: '{"status":"out"}',
      timeoutMs: 1000,
    })
    await rejects(
      executeHttpConnector(legacy, makeContext(), { policy: policyFor(fixture.port), store }),
      'HTTP_MAPPING_LEGACY_UNSUPPORTED',
      '旧映射必须明确说明已退役',
    )
    A.equal(fixture.requests.length, 0)
  } finally {
    await fixture.close()
  }
})

await check('输出预算：超长 / FEEL 错误不污染实例变量', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ text: 'x'.repeat(600), ok: true }))
  })
  try {
    const store = createConnectorStore({ root: join(root, 'store') })
    const variables = { untouched: true }
    const ctx = makeContext({ variables })
    await rejects(
      executeHttpConnector(
        elementOf(
          { method: 'GET', url: `http://127.0.0.1:${fixture.port}/long`, timeoutMs: 3000 },
          { input: [], output: [{ source: '= response.body.text', target: 'long' }] },
        ),
        ctx,
        { policy: policyFor(fixture.port), store },
      ),
      'HTTP_OUTPUT_INVALID',
      '超过 finish 变量预算必须拒绝',
    )
    A.deepEqual(variables, { untouched: true }, '实例变量不被输出映射污染')
    A.equal(ctx.variables.long, undefined)

    const ctx2 = makeContext()
    await rejects(
      executeHttpConnector(
        elementOf(
          { method: 'GET', url: `http://127.0.0.1:${fixture.port}/long`, timeoutMs: 3000 },
          { input: [], output: [{ source: '= response.body.text +', target: 'x' }] },
        ),
        ctx2,
        { policy: policyFor(fixture.port), store: createConnectorStore({ root: join(root, 'store2') }) },
      ),
      'HTTP_OUTPUT_MAPPING_FAILED',
      'FEEL 映射错误必须结构化失败',
    )
    A.equal(ctx2.variables.x, undefined)
  } finally {
    await fixture.close()
  }
})

await check('authRef：从宿主解析鉴权头，密钥不出现在事件 / 错误里', async ({ root }) => {
  const secret = 'bearer-value-must-not-leak'
  const fixture = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    const store = createConnectorStore({ root: join(root, 'store') })
    const ctx = makeContext()
    const result = await executeHttpConnector(
      elementOf({
        method: 'GET',
        url: `http://127.0.0.1:${fixture.port}/auth`,
        authRef: 'orders-api',
        timeoutMs: 3000,
      }),
      ctx,
      {
        policy: policyFor(fixture.port),
        store,
        env: { FLOW_STUDIO_HTTP_AUTH_ORDERS_API: secret },
      },
    )
    A.equal(result.status, 200)
    A.equal(fixture.requests[0].headers.authorization, `Bearer ${secret}`)
    const serializedEvents = JSON.stringify(ctx.events)
    A.ok(!serializedEvents.includes(secret), '事件里不得出现鉴权值')

    const ctxMissing = makeContext()
    await rejects(
      executeHttpConnector(
        elementOf({
          method: 'GET',
          url: `http://127.0.0.1:${fixture.port}/auth`,
          authRef: 'missing-ref',
          timeoutMs: 3000,
        }),
        ctxMissing,
        { policy: policyFor(fixture.port), store: createConnectorStore({ root: join(root, 'store2') }), env: {} },
      ),
      'HTTP_AUTH_REF_UNRESOLVED',
      '缺失宿主凭据必须明确报错',
    )
    A.ok(!JSON.stringify(ctxMissing.events).includes(secret))
    A.equal(fixture.requests.length, 1, '缺凭据不发出请求')
  } finally {
    await fixture.close()
  }
})

await check('重试耗尽：502 最终失败，活动不产出成功结果', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.end('unavailable')
  })
  try {
    const store = createConnectorStore({ root: join(root, 'store') })
    await rejects(
      executeHttpConnector(
        elementOf({
          method: 'GET',
          url: `http://127.0.0.1:${fixture.port}/down`,
          retries: 1,
          timeoutMs: 3000,
        }),
        makeContext(),
        { policy: policyFor(fixture.port), store },
      ),
      'HTTP_STATUS_NOT_ACCEPTABLE',
      '重试耗尽必须明确失败',
    )
    A.equal(fixture.requests.length, 2, '1 次重试 = 2 个请求')
    const record = await store.readInvocation(invocationIdentity())
    A.equal(record.state, 'failed')
    A.equal(record.attempts, 2)
  } finally {
    await fixture.close()
  }
})

await check('请求 / 响应伪造边界：请求体上限、短 Content-Length 不被当成成功', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
    res.end('short')
  })
  try {
    const store = createConnectorStore({ root: join(root, 'store') })
    await rejects(
      executeHttpConnector(
        elementOf({
          method: 'POST',
          url: `http://127.0.0.1:${fixture.port}/upload`,
          body: 'x'.repeat(300 * 1024),
          timeoutMs: 3000,
        }),
        makeContext(),
        { policy: policyFor(fixture.port), store },
      ),
      'HTTP_REQUEST_TOO_LARGE',
      '请求体超过 256 KiB 必须拒绝',
    )
    A.equal(fixture.requests.length, 0)

    await rejects(
      executeHttpConnector(
        elementOf({ method: 'GET', url: `http://127.0.0.1:${fixture.port}/fake`, timeoutMs: 3000 }),
        makeContext(),
        { policy: policyFor(fixture.port), store: createConnectorStore({ root: join(root, 'store2') }) },
      ),
      ['HTTP_CONTENT_LENGTH_MISMATCH', 'HTTP_RESPONSE_ABORTED', 'HTTP_RESPONSE_READ_FAILED'],
      '声明的 content-length 与实际字节不符时必须失败',
    )
    A.equal(fixture.requests.length, 1)
  } finally {
    await fixture.close()
  }
})

await check('networkPolicyId + authResolver：宿主策略按节点引用，凭据可注入', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    const result = await executeHttpConnector(
      elementOf({
        method: 'GET',
        url: `http://127.0.0.1:${fixture.port}/scoped`,
        authRef: 'orders',
        networkPolicyId: 'testbed',
        timeoutMs: 3000,
      }),
      makeContext(),
      {
        // 全局策略拒绝明文/私网；节点引用 testbed 策略后精确放行。
        policy: {},
        policies: {
          testbed: { allowInsecureOrigins: [`127.0.0.1:${fixture.port}`], retryBackoffBaseMs: 1 },
        },
        authResolver: async authRef => {
          A.equal(authRef, 'orders')
          return { 'X-Api-Key': 'injected-key' }
        },
        store: createConnectorStore({ root: join(root, 'store') }),
      },
    )
    A.equal(result.status, 200)
    A.equal(fixture.requests[0].headers['x-api-key'], 'injected-key', '宿主注入的鉴权头生效')
  } finally {
    await fixture.close()
  }
})

const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))

await check('H3：响应回显凭据 → 输出映射明确拒绝，记录 / 事件 / 错误都不含凭据值', async ({ root }) => {
  const secret = 'SYNTHETIC_SECRET'
  const fixture = await startFixture((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': `Bearer ${secret}`,
      location: `https://echo.example/?token=${secret}`,
    })
    res.end(JSON.stringify({ leaked: `Bearer ${secret}` }))
  })
  try {
    const store = createConnectorStore({ root: join(root, 'store') })
    const ctx = makeContext()
    let thrown = null
    try {
      await executeHttpConnector(
        elementOf(
          { method: 'GET', url: `http://127.0.0.1:${fixture.port}/echo`, authRef: 'echo', timeoutMs: 3000 },
          { input: [], output: [{ source: '= response.body.leaked', target: 'leaked' }] },
        ),
        ctx,
        {
          policy: policyFor(fixture.port),
          store,
          env: { FLOW_STUDIO_HTTP_AUTH_ECHO: secret },
        },
      )
    } catch (error) {
      thrown = error
    }
    A.ok(thrown !== null, '回显凭据必须失败')
    A.equal(thrown.code, 'HTTP_RESPONSE_SECRET_LEAK')
    A.ok(!JSON.stringify({ code: thrown.code, message: thrown.message, details: thrown.details }).includes(secret), '错误对象不含凭据值')
    A.equal(fixture.requests.length, 1)
    A.equal(fixture.requests[0].headers.authorization, `Bearer ${secret}`, '请求头本身仍带凭据')
    A.ok(!JSON.stringify(ctx.events).includes(secret), '事件流不含凭据值')
    A.deepEqual(ctx.variables, {}, '实例变量不被写入（output 在返回前已被拒绝）')
    const record = await store.readInvocation(invocationIdentity())
    A.equal(record.state, 'failed')
    A.equal(record.error.code, 'HTTP_RESPONSE_SECRET_LEAK')
    const recordText = JSON.stringify(record)
    A.ok(!recordText.includes(secret), '调用记录不含凭据值')
  } finally {
    await fixture.close()
  }
})

await check('H3：允许列表响应头 / location 错误详情脱敏，落盘记录不含凭据值', async ({ root }) => {
  const secret = 'SYNTHETIC_SECRET'
  const fixture = await startFixture((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': `Bearer ${secret}`,
    })
    res.end('{"ok":true}')
  })
  try {
    const store = createConnectorStore({ root: join(root, 'store') })
    const result = await executeHttpConnector(
      elementOf({ method: 'GET', url: `http://127.0.0.1:${fixture.port}/ok`, authRef: 'echo', timeoutMs: 3000 }),
      makeContext(),
      { policy: policyFor(fixture.port), store, env: { FLOW_STUDIO_HTTP_AUTH_ECHO: secret } },
    )
    A.equal(result.status, 200)
    A.equal(result.headers['x-request-id'], '[redacted]', '白名单头名称不等于值安全：回显值必须脱敏')
    A.ok(!JSON.stringify(result).includes(secret), '返回结果不含凭据值')
    const record = await store.readInvocation(invocationIdentity())
    A.equal(record.state, 'succeeded')
    A.ok(!JSON.stringify(record).includes(secret), '落盘记录不含凭据值')
  } finally {
    await fixture.close()
  }

  const redirect = await startFixture((req, res) => {
    res.writeHead(302, { location: `https://evil.example/?token=${secret}` })
    res.end()
  })
  try {
    const store = createConnectorStore({ root: join(root, 'store-redirect') })
    let thrown = null
    try {
      await executeHttpConnector(
        elementOf({ method: 'GET', url: `http://127.0.0.1:${redirect.port}/go`, authRef: 'echo', timeoutMs: 3000 }),
        makeContext(),
        { policy: policyFor(redirect.port), store, env: { FLOW_STUDIO_HTTP_AUTH_ECHO: secret } },
      )
    } catch (error) {
      thrown = error
    }
    A.ok(thrown !== null)
    A.equal(thrown.code, 'HTTP_REDIRECT_FORBIDDEN')
    A.ok(!JSON.stringify({ message: thrown.message, details: thrown.details }).includes(secret), '重定向错误详情不得回显凭据值')
    const record = await store.readInvocation(invocationIdentity())
    A.ok(!JSON.stringify(record).includes(secret), '失败记录不含凭据值')
  } finally {
    await redirect.close()
  }
})

await check('H3：authRef 可绑定允许的目标 origin', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    const store = createConnectorStore({ root: join(root, 'store') })
    const element = elementOf({
      method: 'GET',
      url: `http://127.0.0.1:${fixture.port}/bound`,
      authRef: 'echo',
      timeoutMs: 3000,
    })
    await rejects(
      executeHttpConnector(element, makeContext(), {
        policy: policyFor(fixture.port, { authOrigins: { echo: ['https://api.example.com:443'] } }),
        store,
        env: { FLOW_STUDIO_HTTP_AUTH_ECHO: 'bound-secret' },
      }),
      'HTTP_AUTH_ORIGIN_FORBIDDEN',
      '凭据绑定到其他 origin 时必须拒绝',
    )
    A.equal(fixture.requests.length, 0, '绑定失败零请求')

    const allowed = await executeHttpConnector(element, makeContext(), {
      policy: policyFor(fixture.port, { authOrigins: { echo: [`http://127.0.0.1:${fixture.port}`] } }),
      store: createConnectorStore({ root: join(root, 'store-ok') }),
      env: { FLOW_STUDIO_HTTP_AUTH_ECHO: 'bound-secret' },
    })
    A.equal(allowed.status, 200)
    A.equal(fixture.requests.length, 1)
  } finally {
    await fixture.close()
  }
})

await check('H4：DNS / auth resolver / 调用记录等待参与统一 deadline，过期零发送', async ({ root }) => {
  const hostPolicy = extra => ({ allowInsecureOrigins: [`fixture.test:${fixture.port}`], retryBackoffBaseMs: 1, ...extra })
  const fixture = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    // 1) 慢 DNS：修复前 deadline 在 DNS 之后才建立，会超时后仍成功发送。
    const startedDns = Date.now()
    await rejects(
      executeHttpConnector(
        elementOf({ method: 'GET', url: `http://fixture.test:${fixture.port}/dns`, timeoutMs: 50 }),
        makeContext(),
        {
          policy: hostPolicy( {
            resolver: async () => { await sleep(200); return [{ address: '127.0.0.1', family: 4 }] },
          }),
          store: createConnectorStore({ root: join(root, 'store-dns') }),
        },
      ),
      'HTTP_TIMEOUT',
      '慢 DNS 必须被整体 deadline 截断',
    )
    A.ok(Date.now() - startedDns < 160, `慢 DNS 必须按 50ms deadline 结束（实测 ${Date.now() - startedDns}ms）`)
    A.equal(fixture.requests.length, 0, 'DNS 超时后零发送')

    // 2) 慢 auth resolver。
    const startedAuth = Date.now()
    await rejects(
      executeHttpConnector(
        elementOf({ method: 'GET', url: `http://fixture.test:${fixture.port}/auth`, authRef: 'slow', timeoutMs: 50 }),
        makeContext(),
        {
          policy: hostPolicy( { resolver: async () => [{ address: '127.0.0.1', family: 4 }] }),
          store: createConnectorStore({ root: join(root, 'store-auth') }),
          authResolver: async () => { await sleep(200); return { Authorization: 'Bearer slow' } },
        },
      ),
      'HTTP_TIMEOUT',
      '慢 auth resolver 必须被整体 deadline 截断',
    )
    A.ok(Date.now() - startedAuth < 160, `慢 auth resolver 必须按 50ms deadline 结束（实测 ${Date.now() - startedAuth}ms）`)
    A.equal(fixture.requests.length, 0, '凭据解析超时后零发送')

    // 3) DNS 挂起期间 abort：调用必须结束，不能一直挂着。
    const controller = new AbortController()
    const startedAbort = Date.now()
    const pending = executeHttpConnector(
      elementOf({ method: 'GET', url: `http://fixture.test:${fixture.port}/hang`, timeoutMs: 3000 }),
      makeContext({ signal: controller.signal }),
      { policy: hostPolicy( { resolver: () => new Promise(() => {}) }), store: createConnectorStore({ root: join(root, 'store-abort') }) },
    )
    setTimeout(() => controller.abort(), 30)
    await rejects(pending, 'HTTP_CANCELED', 'DNS 挂起期间 abort 必须让调用结束')
    A.ok(Date.now() - startedAbort < 160, `abort 后调用必须尽快结束（实测 ${Date.now() - startedAbort}ms）`)
    A.equal(fixture.requests.length, 0, 'abort 后零发送')

    // 4) 慢 recordAttempt：修复前记录写完还会用剩余 1ms 去发送；现在零发送。
    const real = createConnectorStore({ root: join(root, 'store-attempt') })
    const slowStore = {
      ...real,
      recordAttempt: async (...args) => { await sleep(300); return real.recordAttempt(...args) },
    }
    const startedStore = Date.now()
    await rejects(
      executeHttpConnector(
        elementOf({ method: 'GET', url: `http://fixture.test:${fixture.port}/store`, timeoutMs: 100 }),
        makeContext(),
        { policy: hostPolicy( { resolver: async () => [{ address: '127.0.0.1', family: 4 }] }), store: slowStore },
      ),
      'HTTP_TIMEOUT',
      '慢 recordAttempt 必须被整体 deadline 截断',
    )
    A.ok(Date.now() - startedStore < 250, `慢 recordAttempt 必须按 100ms deadline 结束（实测 ${Date.now() - startedStore}ms）`)
    A.equal(fixture.requests.length, 0, 'recordAttempt 超时后零发送')
  } finally {
    await fixture.close()
  }
})

await check('m2：请求头 / 响应头显式预算，1 MiB 请求头到不了 transport', async ({ root }) => {
  const fixture = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    const store = createConnectorStore({ root: join(root, 'store') })
    const elementWithHeaders = headers => elementOf({
      method: 'GET',
      url: `http://127.0.0.1:${fixture.port}/headers`,
      headers,
      timeoutMs: 3000,
    })
    await rejects(
      executeHttpConnector(elementWithHeaders({ 'x-big': 'a'.repeat(1024 * 1024) }), makeContext(), { policy: policyFor(fixture.port), store }),
      'HTTP_HEADER_TOO_LARGE',
      '单个 1 MiB header 必须拒绝',
    )
    A.equal(fixture.requests.length, 0, '超限 header 零请求')

    const many = {}
    for (let index = 0; index < 65; index += 1) many[`x-h-${index}`] = 'v'
    await rejects(
      executeHttpConnector(elementWithHeaders(many), makeContext(), { policy: policyFor(fixture.port), store }),
      'HTTP_HEADER_COUNT_EXCEEDED',
      'header 数量上限 64',
    )
    A.equal(fixture.requests.length, 0)

    const total = {}
    for (let index = 0; index < 5; index += 1) total[`x-t-${index}`] = 'a'.repeat(7 * 1024)
    await rejects(
      executeHttpConnector(elementWithHeaders(total), makeContext(), { policy: policyFor(fixture.port), store }),
      'HTTP_REQUEST_HEADERS_TOO_LARGE',
      'header 总量上限 32 KiB',
    )
    A.equal(fixture.requests.length, 0)
  } finally {
    await fixture.close()
  }

  // 响应头数量 / 总量兜底（Node 解析器默认 16 KiB 之内，专门触发我们自己的上限）。
  const countFixture = await startFixture((req, res) => {
    const headers = { 'content-type': 'application/json' }
    for (let index = 0; index < 70; index += 1) headers[`x-r-${index}`] = 'v'
    res.writeHead(200, headers)
    res.end('{"ok":true}')
  })
  try {
    await rejects(
      executeHttpConnector(
        elementOf({ method: 'GET', url: `http://127.0.0.1:${countFixture.port}/many-headers`, timeoutMs: 3000 }),
        makeContext(),
        { policy: policyFor(countFixture.port), store: createConnectorStore({ root: join(root, 'store-r1') }) },
      ),
      'HTTP_RESPONSE_HEADERS_TOO_LARGE',
      '响应头数量上限 64',
    )
    A.equal(countFixture.requests.length, 1)
  } finally {
    await countFixture.close()
  }

  const bytesFixture = await startFixture((req, res) => {
    const headers = { 'content-type': 'application/json' }
    for (let index = 0; index < 30; index += 1) headers[`x-b-${index}`] = 'a'.repeat(400)
    res.writeHead(200, headers)
    res.end('{"ok":true}')
  })
  try {
    await rejects(
      executeHttpConnector(
        elementOf({ method: 'GET', url: `http://127.0.0.1:${bytesFixture.port}/big-headers`, timeoutMs: 3000 }),
        makeContext(),
        { policy: policyFor(bytesFixture.port), store: createConnectorStore({ root: join(root, 'store-r2') }) },
      ),
      'HTTP_RESPONSE_HEADERS_TOO_LARGE',
      '响应头总量上限 8 KiB',
    )
  } finally {
    await bytesFixture.close()
  }
})


console.log(`\nhttp-connector: ${checks} 组 / ${assertions} 条断言通过`)
