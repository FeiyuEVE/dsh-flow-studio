#!/usr/bin/env node
/**
 * Host 鉴权 / 旧路由退役 / 工具注册自检（0.14.0）。
 *
 * 从已删除的 `test/host.test.mjs`、`test/tools.test.mjs` 迁入仍然有效的断言：
 *   - 鉴权是 handler 的第一件事：connection 失败 fail-closed 503、401/403 原样返回；
 *   - 插件令牌两档（全权 / 只读），只读令牌只允许 GET；过短令牌启动即拒绝；
 *   - 跨站 Origin 拒绝、同源放行；
 *   - 原始 URL 的路径防线（空段 / `..`）回 400，不落到存储层；
 *   - 旧 `/flows`、`/runs`、`/worktrees` 在**认证通过**后一律 404（无认证仍 401）；
 *   - 模型工具注册集合恰好 13 个实例域工具，旧运行域工具名一个都不出现；
 *   - `/health` 只报新域能力（bpmn / adapters / workspaceAllowlist），不再有 engine/stub/run 字段。
 *
 * 不启动 dsh：伪造最小 ctx，把 createHandler 直接喂 req/res。
 * 产物落在项目 `.tmp/`，结束清理。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-host-auth-'))
process.env.DSH_HOME = home
delete process.env.FLOW_STUDIO_TOKEN
delete process.env.FLOW_STUDIO_READ_TOKEN

const {
  apply, createHandler, AUTH_ENV, READ_AUTH_ENV, PLUGIN_VERSION,
} = await import('../src/index.js')
const { createInstanceTools } = await import('../src/instance-tools.js')

const API = '/api/flow-studio'

let checks = 0
let assertions = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    checks += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}`)
    console.log('    ' + String((error && error.message) || error))
  }
}

function eq(actual, expected, message) {
  assertions += 1
  assert.equal(actual, expected, message)
}

function ok(value, message) {
  assertions += 1
  assert.ok(value, message)
}

function deep(actual, expected, message) {
  assertions += 1
  assert.deepEqual(actual, expected, message)
}

/** 伪造的 Cordis 上下文：只实现 createHandler / apply 用到的那几个成员。 */
function makeCtx(options = {}) {
  const routes = []
  const registered = []
  const disposers = []
  const warnings = []
  const ctx = {
    routes,
    registered,
    warnings,
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return cleanup
    },
    logger: {
      warn(message) { warnings.push(String(message)) },
      info() {},
      error() {},
    },
    get(name) {
      if (name === 'connection') {
        if (Object.hasOwn(options, 'connection')) return options.connection
        return { requestRejection: () => undefined }
      }
      if (name === 'tools') return ctx.tools
      return undefined
    },
  }
  if (options.tools) {
    ctx.tools = {
      register(tool) {
        registered.push(tool.name)
        return () => {
          const index = registered.indexOf(tool.name)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    }
  }
  ctx.disposers = disposers
  return ctx
}

function makeEnv(extra = {}) {
  return {
    dir: join(home, 'flow-studio'),
    ctx: makeCtx(),
    ...extra,
  }
}

/** 发一个请求给路由，返回 { status, headers, body, json }。 */
function call(route, method, url, body, headers = {}) {
  return new Promise(resolveCall => {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = Readable.from(payload)
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', ...headers }
    req.socket = { remoteAddress: '127.0.0.1' }
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      headersSent: false,
      writeHead(code, extraHeaders) {
        this.statusCode = code
        this.headers = extraHeaders || {}
        this.headersSent = true
      },
      end(chunk) {
        if (chunk !== undefined) this.body += chunk.toString()
        let json = {}
        try {
          json = JSON.parse(this.body)
        } catch {
          json = {}
        }
        resolveCall({ status: this.statusCode, headers: this.headers, body: this.body, json })
      },
    }
    route(req, res)
  })
}

const FULL_TOKEN = 'fs-full-token-0123456789abcdef'
const READ_TOKEN = 'fs-read-token-0123456789abcdef'

await check('apply()：注册一条 /api/flow-studio 前缀路由，并注册恰好 13 个实例域工具', async () => {
  const ctx = makeCtx({ tools: true })
  apply(ctx)
  eq(ctx.routes.length, 1)
  eq(ctx.routes[0].kind, 'prefix')
  eq(ctx.routes[0].path, API)
  eq(ctx.registered.length, 13, '模型工具注册总数应为 13')
  deep(ctx.registered.slice().sort(), [
    'flow_definition_get',
    'flow_definition_list',
    'flow_instance_cancel',
    'flow_instance_complete_task',
    'flow_instance_events',
    'flow_instance_get',
    'flow_instance_list',
    'flow_instance_reply',
    'flow_instance_resume',
    'flow_instance_run',
    'flow_instance_send_message',
    'flow_instance_suspend',
    'flow_instance_worktrees',
  ], '注册集合必须恰好是新域 13 个工具')
  for (const legacy of [
    'flow_list', 'flow_compile', 'flow_decompile', 'flow_worktrees',
    'flow_start', 'flow_watch', 'flow_stop', 'flow_restart', 'flow_supervise',
    'flow_send_message', 'flow_reply', 'flow_node_reject',
  ]) {
    ok(!ctx.registered.includes(legacy), `旧工具 ${legacy} 不得再注册`)
  }
  // 卸载：最后注册的 effect 是工具注销，逆序撤销后一个不剩。
  const toolsCleanup = ctx.disposers[ctx.disposers.length - 1]
  toolsCleanup()
  eq(ctx.registered.length, 0, '卸载后工具应全部注销')
})

await check('/health 只报新域能力（无 engine / stub / runsDir）', async () => {
  const env = makeEnv()
  const result = await call(createHandler(env), 'GET', `${API}/health`)
  eq(result.status, 200)
  eq(result.json.ok, true)
  eq(result.json.schemaVersion, 1)
  eq(result.json.auth, 'connection')
  eq(result.json.authMode, 'connection')
  eq(result.json.readOnly, false)
  eq(result.json.version, PLUGIN_VERSION)
  ok(result.json.bpmn && result.json.bpmn.enabled === true, 'health 必须带新域 runtime 计数')
  ok(Number.isInteger(result.json.bpmn.definitions), 'health 带 definitions 计数')
  ok(Number.isInteger(result.json.bpmn.instances), 'health 带 instances 计数')
  ok(Array.isArray(result.json.adapters), 'health 带 adapter 列表')
  ok(result.json.capabilities && result.json.capabilities.workspaceAllowlist, 'health 带 workspaceAllowlist 能力')
  for (const legacy of ['engine', 'runsDir', 'customExecutor']) {
    ok(!Object.hasOwn(result.json, legacy), `health 不得再报旧字段 ${legacy}`)
  }
  ok(result.json.dir.includes('flow-studio'), '回环 / 已认证请求可看到数据目录')
})

await check('新域路由仍可用：GET /definitions 200；未知接口 404', async () => {
  const env = makeEnv()
  const route = createHandler(env)
  const listed = await call(route, 'GET', `${API}/definitions`)
  eq(listed.status, 200)
  ok(Array.isArray(listed.json.definitions), '定义列表返回 definitions 数组')
  const unknown = await call(route, 'GET', `${API}/nope`)
  eq(unknown.status, 404)
})

await check('§13.1 拿不到 connection 服务 → fail-closed 503；401/403 原样返回；抛错 503', async () => {
  const withoutConnection = makeEnv({ ctx: makeCtx({ connection: undefined }) })
  const missing = await call(createHandler(withoutConnection), 'GET', `${API}/health`)
  eq(missing.status, 503)
  eq(missing.json.code, 'AUTH_SERVICE_UNAVAILABLE')
  ok(missing.json.error.includes('鉴权服务不可用'))

  for (const rejection of [401, 403]) {
    const gated = makeEnv({ ctx: makeCtx({ connection: { requestRejection: () => rejection } }) })
    const result = await call(createHandler(gated), 'GET', `${API}/definitions`)
    eq(result.status, rejection)
    eq(result.json.ok, false)
  }

  const throwing = makeEnv({ ctx: makeCtx({ connection: { requestRejection: () => { throw new Error('boom') } } }) })
  const failed = await call(createHandler(throwing), 'GET', `${API}/definitions`)
  eq(failed.status, 503)
})

await check('跨站 Origin 403；同源放行', async () => {
  const env = makeEnv()
  const route = createHandler(env)
  const cross = await call(route, 'GET', `${API}/health`, undefined, { origin: 'http://evil.example' })
  eq(cross.status, 403)
  const same = await call(route, 'GET', `${API}/health`, undefined, { origin: 'http://127.0.0.1:3080' })
  eq(same.status, 200)
})

await check('路径防线：空路径段 / .. 段回 400，不进存储层', async () => {
  const env = makeEnv()
  const route = createHandler(env)
  for (const url of [`${API}/instances//i-a`, `${API}/instances/%2e%2e/x`, `${API}/./definitions`]) {
    const result = await call(route, 'GET', url)
    eq(result.status, 400, url)
  }
})

await check('两档令牌：缺 / 错 401；只读令牌 GET 放行、写请求 403；全权令牌写放行', async () => {
  const env = makeEnv()
  const route = createHandler(env)
  process.env[AUTH_ENV] = FULL_TOKEN
  process.env[READ_AUTH_ENV] = READ_TOKEN
  try {
    const anonymous = await call(route, 'GET', `${API}/health`)
    eq(anonymous.status, 401, '配了令牌就必须带令牌')
    const wrong = await call(route, 'GET', `${API}/health`, undefined, { authorization: 'Bearer nope-nope-nope-nope' })
    eq(wrong.status, 401)

    const readHeaders = { authorization: `Bearer ${READ_TOKEN}` }
    const fullHeaders = { authorization: `Bearer ${FULL_TOKEN}` }

    const readHealth = await call(route, 'GET', `${API}/health`, undefined, readHeaders)
    eq(readHealth.status, 200)
    eq(readHealth.json.auth, 'token')
    eq(readHealth.json.authMode, 'read')
    eq(readHealth.json.readOnly, true)
    eq(readHealth.json.capabilities.write, false)

    for (const [method, url] of [
      ['POST', `${API}/definitions`],
      ['POST', `${API}/instances`],
      ['DELETE', `${API}/instances/i-probe`],
      ['POST', `${API}/instance-worktrees`],
    ]) {
      const rejected = await call(route, method, url, method === 'GET' ? undefined : {}, readHeaders)
      eq(rejected.status, 403, `${method} ${url}`)
      eq(rejected.json.code, 'READ_ONLY_TOKEN')
      ok(rejected.json.error.includes('只读令牌'), '403 要给可读原因')
    }

    const fullHealth = await call(route, 'GET', `${API}/health`, undefined, fullHeaders)
    eq(fullHealth.status, 200)
    eq(fullHealth.json.authMode, 'full')
    eq(fullHealth.json.readOnly, false)

    // 全权令牌能穿过只读闸门（这里只验证没有被 401/403 拦下；具体业务校验由定义域负责）。
    const fullWrite = await call(route, 'POST', `${API}/definitions`, {}, fullHeaders)
    ok(fullWrite.status !== 401 && fullWrite.status !== 403, `全权令牌不应被鉴权层拒绝（实际 ${fullWrite.status}）`)
  } finally {
    delete process.env[AUTH_ENV]
    delete process.env[READ_AUTH_ENV]
  }
})

await check('过短令牌：apply() 启动即拒绝并告警（全权 / 只读同口径）', async () => {
  for (const envName of [AUTH_ENV, READ_AUTH_ENV]) {
    const ctx = makeCtx()
    process.env[envName] = 'too-short'
    try {
      assert.throws(() => apply(ctx), /至少 16 个字符/)
      assertions += 1
      ok(ctx.warnings.some(message => message.includes('拒绝启动')), envName)
      ok(ctx.warnings.some(message => message.includes(envName)), `${envName} 的告警要点名变量`)
    } finally {
      delete process.env[envName]
    }
  }
})

await check('旧路由退役：认证通过后 /flows、/runs、/worktrees 一律 404（不做兼容跳转）', async () => {
  const env = makeEnv()
  const route = createHandler(env)
  process.env[AUTH_ENV] = FULL_TOKEN
  const headers = { authorization: `Bearer ${FULL_TOKEN}` }
  try {
    const requests = [
      ['GET', `${API}/flows`],
      ['POST', `${API}/flows`, {}],
      ['PUT', `${API}/flows/flow-a`, {}],
      ['DELETE', `${API}/flows/flow-a`],
      ['POST', `${API}/flows/import-dir`, { dir: '/tmp/x' }],
      ['POST', `${API}/flows/flow-a/export-dir`, { dir: '/tmp/x' }],
      ['GET', `${API}/runs`],
      ['POST', `${API}/runs`, {}],
      ['GET', `${API}/runs/r-a`],
      ['DELETE', `${API}/runs/r-a`],
      ['GET', `${API}/runs/r-a/events`],
      ['POST', `${API}/runs/r-a/events`, {}],
      ['GET', `${API}/runs/r-a/messages`],
      ['POST', `${API}/runs/r-a/inbox`, {}],
      ['GET', `${API}/runs/r-a/summary`],
      ['GET', `${API}/runs/r-a/export`],
      ['POST', `${API}/runs/r-a/start`],
      ['POST', `${API}/runs/r-a/stop`],
      ['POST', `${API}/runs/r-a/restart`],
      ['GET', `${API}/runs/r-a/supervision`],
      ['DELETE', `${API}/runs/r-a/worktree`],
      ['GET', `${API}/worktrees`],
      ['POST', `${API}/worktrees/prune`, {}],
    ]
    for (const [method, url, body] of requests) {
      const result = await call(route, method, url, body, headers)
      eq(result.status, 404, `${method} ${url} 应 404`)
      eq(result.json.ok, false)
      eq(result.json.error, '未知接口')
    }
    // 无认证仍是 401（旧路由的 404 只在通过认证后成立，不能拿 401 冒充 404）。
    const anonymous = await call(route, 'GET', `${API}/flows`)
    eq(anonymous.status, 401)
  } finally {
    delete process.env[AUTH_ENV]
  }
})

await check('模型工具工厂：createInstanceTools 是 13 个（不依赖 apply）', async () => {
  const tools = createInstanceTools({ getRuntime: () => ({ handle: async () => ({ status: 200, body: { ok: true } }) }) })
  eq(tools.length, 13)
  eq(new Set(tools.map(tool => tool.name)).size, 13, '工具名不得重复')
})

rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} 组失败：`)
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error && failure.error.stack ? failure.error.stack : failure.error}`)
  process.exit(1)
}
console.log(`\nhost-auth.test.mjs：${checks} 组通过（${assertions} 条断言）`)
