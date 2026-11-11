#!/usr/bin/env node
/**
 * v1.1 指标与 Host 契约自检（05 §8）。
 *
 * 分两段：
 *   1. 打回失效 / progress 的纯函数探针（会打印实际判定结果）；不再测质量总评分；
 *   2. /api/flow-studio 的真实 HTTP 语义：坏 run 的 skipped、413 可读、500 不带内部路径、
 *      health 字段、可选 token 两档、nodeDone 同口径。
 *
 * 不启动 dsh：伪造最小 ctx，把 apply() 注册的 prefix 路由直接喂 req/res。
 * 产物落在项目 `.tmp/`，不占系统 /tmp。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
process.env.DSH_HOME = mkdtempSync(join(repoRoot, '.tmp', 'home-metrics-'))
delete process.env.FLOW_STUDIO_TOKEN
const home = process.env.DSH_HOME

const { apply, PLUGIN_VERSION, AUTH_ENV } = await import('../src/index.js')
const store = await import('../src/runstore.js')
const { computeProgress, summarize } = await import('../src/runlog.js')

let checks = 0
async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

// ---------------------------------------------------------------------------
// 1. progress 探针
// ---------------------------------------------------------------------------

let seq = 0
function ev(kind, over = {}) {
  seq += 1
  return {
    v: 1,
    ts: `2026-11-06T10:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    kind,
    runId: 'r-probe',
    traceId: `trace-${seq}`,
    seq,
    memberId: null,
    ...over,
  }
}

/** 五项证据齐全的 run；开关用来制造缺证据 / 半成品 / 返工 / P0-P1-P2 分支。 */
function fixture({ rework = 0, half = false, p1 = 'verified', p2 = null, p0 = null } = {}) {
  const events = [ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 2 } })]
  if (rework > 0) {
    events.push(ev('node/start', { nodeId: 'n_a', attemptId: 1, data: { title: 'A', mode: 'single', skills: [] } }))
    events.push(ev('node/end', { nodeId: 'n_a', attemptId: 1, data: { status: 'rejected', durationMs: 1 } }))
    events.push(ev('reject/trigger', {
      nodeId: 'n_a', attemptId: 1,
      data: { edgeId: 'e1', fromNodeId: 'n_a', toNodeId: 'n_a', reason: '打回' },
    }))
    events.push(ev('node/start', { nodeId: 'n_a', attemptId: 2, data: { title: 'A', mode: 'single', skills: [] } }))
    events.push(ev('node/end', { nodeId: 'n_a', attemptId: 2, data: { status: 'passed', durationMs: 1 } }))
  } else {
    events.push(ev('node/end', { nodeId: 'n_a', attemptId: 1, data: { status: 'passed', durationMs: 1 } }))
  }
  if (!half) {
    events.push(ev('node/end', { nodeId: 'n_b', attemptId: 1, data: { status: 'passed', durationMs: 1 } }))
  }
  events.push(ev('acceptance/verdict', {
    nodeId: 'n_acc', attemptId: 1,
    // 0.11 N1：pass 档要求权威覆盖 100%；这三条证据按「宿主已核对」的输入形状构造。
    extra: { producer: 'host', authority: 'host' },
    data: { itemId: 'acc-1', status: 'pass', decidedBy: 'human', evidenceRef: 'artifacts/acc.md' },
  }))
  events.push(ev('test/report', {
    nodeId: 'n_test', attemptId: 1,
    extra: { producer: 'host', authority: 'host' },
    data: { suite: 'unit', executed: 10, passed: 10, failed: 0, skipped: 0, reportRef: 'artifacts/test.md' },
  }))
  events.push(ev('check/form', {
    nodeId: 'n_check', attemptId: 1,
    extra: { producer: 'host', authority: 'host' },
    data: {
      ruleSetId: 'eslint', ruleSetVersion: '9', executor: 'eslint@9', state: 'pass',
      passedChecks: 5, totalChecks: 5, executedAt: '2026-11-06T10:00:00.000Z',
    },
  }))
  events.push(ev('review/finding', {
    nodeId: 'n_review', attemptId: 1,
    data: { id: 'f1', severity: 'P1', title: '问题', status: p1 },
  }))
  let findingCount = 1
  if (p0 !== null) {
    findingCount += 1
    events.push(ev('review/finding', {
      nodeId: 'n_review', attemptId: 1,
      data: { id: 'f0', severity: 'P0', title: '阻断', status: p0 },
    }))
  }
  if (p2 !== null) {
    findingCount += 1
    events.push(ev('review/finding', {
      nodeId: 'n_review', attemptId: 1,
      data: { id: 'f2', severity: 'P2', title: '格式', status: p2 },
    }))
  }
  events.push(ev('review/verdict', {
    nodeId: 'n_review', attemptId: 1,
    data: { verdict: 'approve', findingCount },
  }))
  return events
}

const probeRows = []
await check('打回后 ratio 下降（A/B passed 被打回 A）', () => {
  const before = computeProgress([
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 2 } }),
    ev('node/end', { nodeId: 'n_a', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('node/end', { nodeId: 'n_b', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
  ])
  const after = computeProgress([
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 2 } }),
    ev('node/end', { nodeId: 'n_a', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('node/end', { nodeId: 'n_b', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('reject/trigger', {
      nodeId: 'n_b', attemptId: 1,
      data: { edgeId: 'e1', fromNodeId: 'n_b', toNodeId: 'n_a', reason: '打回 A' },
    }),
  ])
  probeRows.push(['打回前', `${before.passed}/${before.denominator}`, `ratio=${before.ratio}`])
  probeRows.push(['打回后', `${after.passed}/${after.denominator}`, `ratio=${after.ratio} invalidated=${after.invalidated}`])
  assert.equal(before.ratio, 1)
  assert.equal(after.ratio, 0)
  assert.ok(after.ratio <= 1)
  assert.equal(after.invalidated, 2)
})

for (const [name, state, label] of probeRows) {
  console.log(`  · ${name}: state=${state} label=${label}`)
}

// ---------------------------------------------------------------------------
// 2. HTTP 探针
// ---------------------------------------------------------------------------

function makeCtx(services = {}) {
  const routes = []
  const ctx = {
    routes,
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
    logger: { warn() {}, error() {}, info() {} },
    get(name) {
      if (name === 'connection' && !Object.hasOwn(services, name)) {
        return { requestRejection: () => undefined }
      }
      return services[name]
    },
  }
  return ctx
}

/** 发一个请求给路由；body 可以是对象（JSON）或 Buffer（原样）。 */
function call(route, method, url, body, headers = {}) {
  return new Promise(resolvePromise => {
    const payload = body === undefined
      ? []
      : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')]
    const req = Readable.from(payload)
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', ...headers }
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      headersSent: false,
      writeHead(code, extra) {
        this.statusCode = code
        this.headers = extra || {}
        this.headersSent = true
        return this
      },
      end(chunk) {
        if (chunk) this.body += String(chunk)
        if (res.settled) return
        res.settled = true
        let json = null
        try {
          json = JSON.parse(this.body)
        } catch {
          json = null
        }
        resolvePromise({ status: this.statusCode, headers: this.headers, body: this.body, json })
      },
    }
    void route.handler(req, res)
  })
}

const ctx = makeCtx()
apply(ctx)
const route = ctx.routes[0]
const runsRoot = store.runsDir(home)

async function makeRun(nodeTotal = 2) {
  return store.createRun(runsRoot, { name: '探针 run', flowId: 'flow-a', flowName: '默认流程', nodeTotal })
}

function rawEvent(kind, runId, over = {}) {
  return {
    v: 1,
    ts: '2026-11-06T10:00:00.000Z',
    kind,
    runId,
    nodeId: 'n_a',
    attemptId: 1,
    traceId: 'trace-http',
    data: {},
    ...over,
  }
}

/**
 * E3-b：生命周期事件（run/start、run/end、node/start、node/end、member/*、
 * reject/trigger）只能由引擎 / 运行时内部推进，HTTP `/events` 是观测类白名单。
 * 测试播种改走内部路径 `store.appendEvents` —— 与路由最终调用的实现同一条
 * （同一套归一化 / 进度计数 / run.json 写盘），聚合口径与断言全部不变。
 * R4/S3 之后 HTTP `/events` 会强制盖 `external/unverified` 章，所以需要进入权威聚合的
 * 证据类事件（acceptance/verdict、artifact/write、review/*）也走内部通道；
 * HTTP 外部通道的能力仍由 E3-b 单独覆盖。
 */
async function seedEvents(runId, events) {
  return store.appendEvents(runsRoot, runId, events)
}

console.log('metrics · Host HTTP 探针')

await check('GET /health 带 auth / runsDir / version（§8.5 + §13.1）', async () => {
  const result = await call(route, 'GET', '/api/flow-studio/health')
  assert.equal(result.status, 200)
  assert.equal(result.json.auth, 'connection')
  assert.equal(result.json.runsDir, runsRoot)
  assert.equal(result.json.version, PLUGIN_VERSION)
})

await check('B：tokenCoverage 对外暴露——列表 / light 只给 { complete }，详情给全量', async () => {
  const meta = await makeRun(1)
  await store.writeRunMeta(runsRoot, meta.id, {
    tokenCoverage: {
      complete: false,
      missing: [{ nodeId: 'n_exec', attemptId: 1 }],
      buckets: { seen: ['input', 'output'], missing: ['cacheRead', 'cacheWrite'] },
    },
  })

  const list = await call(route, 'GET', '/api/flow-studio/runs?limit=100')
  const row = list.json.runs.find(item => item.id === meta.id)
  assert.deepEqual(row.tokenCoverage, { complete: false })
  assert.ok(!('missing' in row.tokenCoverage), '列表只放 { complete }，不带缺口明细')

  const light = await call(route, 'GET', `/api/flow-studio/runs/${meta.id}?light=1`)
  assert.deepEqual(light.json.run.tokenCoverage, { complete: false })

  const detail = await call(route, 'GET', `/api/flow-studio/runs/${meta.id}`)
  assert.deepEqual(detail.json.run.tokenCoverage, {
    complete: false,
    missing: [{ nodeId: 'n_exec', attemptId: 1 }],
    buckets: { seen: ['input', 'output'], missing: ['cacheRead', 'cacheWrite'] },
  })

  // 老 run 没有这个字段：按 { complete: true } 处理，不报错。
  const legacy = await makeRun(1)
  const legacyDetail = await call(route, 'GET', `/api/flow-studio/runs/${legacy.id}`)
  assert.deepEqual(legacyDetail.json.run.tokenCoverage, {
    complete: true,
    missing: [],
    buckets: { seen: [], missing: [] },
  })
  const legacyList = await call(route, 'GET', '/api/flow-studio/runs?limit=100')
  assert.deepEqual(
    legacyList.json.runs.find(item => item.id === legacy.id).tokenCoverage,
    { complete: true },
  )
})

await check('坏 run 目录下 GET /runs 仍 200，并带 skipped（§8.6）', async () => {
  const good = await makeRun()
  await seedEvents(good.id, [
    rawEvent('node/end', good.id, { data: { status: 'passed', durationMs: 1 } }),
  ])
  mkdirSync(join(runsRoot, 'r-bad-http', 'run.json'), { recursive: true })
  const result = await call(route, 'GET', '/api/flow-studio/runs?limit=100')
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.ok(result.json.runs.some(run => run.id === good.id))
  const bad = result.json.skipped.find(entry => entry.id === 'r-bad-http')
  assert.ok(bad, '坏 run 必须出现在 skipped')
  assert.ok(!JSON.stringify(result.json).includes(runsRoot), '响应不能带内部绝对路径')
  console.log(`  · GET /runs 200 · runs=${result.json.runs.length} skipped=${JSON.stringify(result.json.skipped)}`)
})

await check('2 MiB 请求体返回可读 413（不是 ECONNRESET）', async () => {
  const meta = await makeRun()
  const big = Buffer.alloc(2 * 1024 * 1024, 0x61)
  const result = await call(route, 'POST', `/api/flow-studio/runs/${meta.id}/events`, big)
  assert.equal(result.status, 413)
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /请求体过大/)
  assert.ok(!/ECONNRESET/i.test(result.body))
  console.log(`  · POST 2MiB → ${result.status} ${JSON.stringify(result.json)}`)
})

await check('E3-b 外部 /events 通道：生命周期 kind → 400 且状态不变，观测 kind → 200', async () => {
  const meta = await makeRun(1)
  const base = `/api/flow-studio/runs/${meta.id}/events`

  // 生命周期（run/start）走 HTTP：必须 400，且不能把 pending 推成 running（否则永久 409）。
  const rejected = await call(route, 'POST', base, [
    rawEvent('run/start', meta.id, {
      nodeId: undefined, attemptId: undefined,
      data: { flowId: 'flow-a', flowName: '默认流程', nodeTotal: 1 },
    }),
  ])
  assert.equal(rejected.status, 400)
  assert.match(rejected.json.error, /生命周期/)
  assert.equal((await store.readRunMeta(runsRoot, meta.id)).status, 'pending', '被拒的 run/start 不能改状态机')

  // 观测类（agent/message）走 HTTP：外部通道不能被一刀切死。
  const accepted = await call(route, 'POST', base, [
    rawEvent('agent/message', meta.id, {
      data: { role: 'assistant', text: '外部通道的观测消息', truncated: false },
    }),
  ])
  assert.equal(accepted.status, 200)
  assert.equal(accepted.json.accepted, 1)
  console.log(`  · lifecycle → ${rejected.status}（仍 pending）· agent/message → ${accepted.status}`)
})

await check('500 只回通用文案 + traceId，不带 /home/... 路径（§8.5）', async () => {
  const badHome = mkdtempSync(join(repoRoot, '.tmp', 'home-500-'))
  mkdirSync(join(badHome, 'flow-studio'), { recursive: true })
  writeFileSync(join(badHome, 'flow-studio', 'runs'), 'this is a file, not a directory\n')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = badHome
  const badCtx = makeCtx()
  apply(badCtx)
  try {
    const result = await call(badCtx.routes[0], 'GET', '/api/flow-studio/runs')
    assert.equal(result.status, 500)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error, '内部错误')
    assert.match(result.json.traceId, /^tr-[0-9a-f-]{36}$/)
    assert.ok(!result.body.includes('/home/'), `500 响应不能带绝对路径：${result.body}`)
    assert.ok(!result.body.includes(badHome))
    assert.ok(!result.body.includes(repoRoot))
    console.log(`  · GET /runs（runs 路径是文件）→ ${result.status} ${JSON.stringify(result.json)}`)
  } finally {
    process.env.DSH_HOME = previous
    rmSync(badHome, { recursive: true, force: true })
  }
})

await check('GET /runs 与 GET /runs/<id> 的 nodeTotal / nodeDone 同口径同值（§8.6）', async () => {
  const meta = await makeRun(2)
  await seedEvents(meta.id, [
    rawEvent('run/start', meta.id, { nodeId: undefined, attemptId: undefined, data: { flowId: 'flow-a', flowName: '默认流程', nodeTotal: 2 } }),
    rawEvent('node/end', meta.id, { nodeId: 'n_a', data: { status: 'passed', durationMs: 1 } }),
    rawEvent('node/end', meta.id, { nodeId: 'n_b', data: { status: 'passed', durationMs: 1 } }),
  ])
  const list = await call(route, 'GET', '/api/flow-studio/runs?limit=100')
  const detail = await call(route, 'GET', `/api/flow-studio/runs/${meta.id}`)
  const item = list.json.runs.find(run => run.id === meta.id)
  assert.equal(item.nodeDone, detail.json.run.nodeDone)
  assert.equal(item.nodeTotal, detail.json.run.nodeTotal)
  assert.equal(item.nodeDone, 2)
  assert.equal(item.nodeTotal, 2)
  console.log(`  · list nodeDone=${item.nodeDone}/${item.nodeTotal} · detail nodeDone=${detail.json.run.nodeDone}/${detail.json.run.nodeTotal}`)
})

await check('summary 声明 eventCount / truncated，并带 findings.byNode（§8.6 + 补充）', async () => {
  const meta = await makeRun(1)
  // 生命周期走内部路径；评审类观测事件仍走 HTTP，事件总数 / 顺序不变。
  await seedEvents(meta.id, [
    rawEvent('node/end', meta.id, { nodeId: 'n_a', data: { status: 'passed', durationMs: 1 } }),
  ])
  await seedEvents(meta.id, [
    rawEvent('review/finding', meta.id, { nodeId: 'n_a', data: { id: 'f1', severity: 'P1', title: '问题', status: 'open' } }),
    rawEvent('review/verdict', meta.id, { nodeId: 'n_a', data: { verdict: 'approve', findingCount: 1 } }),
  ])
  const result = await call(route, 'GET', `/api/flow-studio/runs/${meta.id}/summary`)
  assert.equal(result.status, 200)
  assert.equal(result.json.summary.eventCount, 3)
  assert.equal(result.json.summary.truncated, false)
  const byNode = result.json.summary.findings.byNode
  assert.deepEqual(byNode.n_a, {
    total: 1,
    unresolved: 1,
    verified: 0,
    dismissed: 0,
    byStatus: { open: 1, accepted: 0, fixed: 0, verified: 0, dismissed: 0 },
    bySeverity: { P0: 0, P1: 1, P2: 0 },
  })
  console.log(`  · summary.findings.byNode = ${JSON.stringify(byNode)}`)
})

await check('GET /export 接受 ?token（浏览器 <a download>），错 token 401；未配置时参数被忽略', async () => {
  const meta = await makeRun(1)
  await seedEvents(meta.id, [
    rawEvent('node/end', meta.id, { nodeId: 'n_a', data: { status: 'passed', durationMs: 1 } }),
  ])

  // 未设置 FLOW_STUDIO_TOKEN：?token= 只是普通查询参数，行为不变。
  const ignored = await call(route, 'GET', `/api/flow-studio/runs/${meta.id}/export?token=whatever`)
  assert.equal(ignored.status, 200)
  assert.match(ignored.headers['content-type'], /text\/markdown/)
  assert.ok(ignored.body.startsWith('# 运行日志'))
  console.log(`  · export（未配置 token，?token 被忽略）→ ${ignored.status} ${ignored.headers['content-type']}`)

  const token = 'fs-export-token-0123456789abcdef'
  process.env[AUTH_ENV] = token
  try {
    const wrong = await call(route, 'GET', `/api/flow-studio/runs/${meta.id}/export?token=wrong-token`)
    assert.equal(wrong.status, 401)
    const ok = await call(route, 'GET', `/api/flow-studio/runs/${meta.id}/export?token=${encodeURIComponent(token)}`)
    assert.equal(ok.status, 200)
    assert.ok(ok.body.startsWith('# 运行日志'))
    console.log(`  · export（token 档，错 token）→ ${wrong.status}；正确 ?token → ${ok.status} ${ok.headers['content-type']}`)
  } finally {
    delete process.env[AUTH_ENV]
  }
})

await check('可选 token 两档：未设置同源放行；设置后缺/错 token 401、Bearer 放行、?token 只留 export（§8.5 + §13.1）', async () => {
  const noToken = await call(route, 'GET', '/api/flow-studio/health')
  assert.equal(noToken.status, 200, '未设置 token 时保持同源校验')
  assert.equal(noToken.json.auth, 'connection')

  const token = 'fs-probe-token-0123456789abcdef'
  process.env[AUTH_ENV] = token
  try {
    const missing = await call(route, 'GET', '/api/flow-studio/health')
    assert.equal(missing.status, 401)
    const wrong = await call(route, 'GET', '/api/flow-studio/health', undefined, { authorization: 'Bearer nope-nope-nope-nope' })
    assert.equal(wrong.status, 401)
    const bearer = await call(route, 'GET', '/api/flow-studio/health', undefined, { authorization: `Bearer ${token}` })
    assert.equal(bearer.status, 200)
    assert.equal(bearer.json.auth, 'token')
    // 06 §13.1：?token= 不再适用于普通接口，只有 export 保留。
    const query = await call(route, 'GET', `/api/flow-studio/runs?token=${encodeURIComponent(token)}`)
    assert.equal(query.status, 401)
    const crossOrigin = await call(route, 'GET', '/api/flow-studio/health', undefined, {
      authorization: `Bearer ${token}`,
      origin: 'http://evil.example',
    })
    assert.equal(crossOrigin.status, 403, 'token 档位下仍保留同源校验')
    console.log('  · token 档位：缺 token 401 / 错 token 401 / Bearer 200 / 普通接口 ?token 401 / 跨站 403')
  } finally {
    delete process.env[AUTH_ENV]
  }

  // 设置了 token 但太短：启动即拒绝（不再悄悄退回 origin-only）。
  process.env[AUTH_ENV] = 'short'
  try {
    assert.throws(() => apply(makeCtx()), /至少 16 个字符/)
  } finally {
    delete process.env[AUTH_ENV]
  }
})

await check('summary 在纯函数层也能独立复算（acceptance / progress 与 HTTP 同一口径；不含质量总评分）', () => {
  const events = fixture({ rework: 1 })
  const summary = summarize(events)
  assert.equal(Object.hasOwn(summary, 'quality'), false, '0.13.12 起 summary 不再返回 quality')
  assert.ok(summary.acceptance && typeof summary.acceptance === 'object')
  assert.equal(summary.progress.ratio, 1)
  assert.equal(summary.progress.nodeDone, 2)
})

// ---------------------------------------------------------------------------
// 3. v1.1 修复契约探针：acceptance 摘要 / 证据防伪 / 桩标记 / 冲突 / 增量缓存
// ---------------------------------------------------------------------------

await check('§13.7 summarize 的 acceptance {passed,total,rate} 与 40px 主摘要同口径', async () => {
  const meta = await makeRun(2)
  await seedEvents(meta.id, [
    rawEvent('acceptance/verdict', meta.id, {
      nodeId: 'n_a', data: { itemId: 'n_a:R1', status: 'pass', decidedBy: 'auto', evidenceRef: 'artifacts/acc.md' },
    }),
    rawEvent('acceptance/verdict', meta.id, {
      nodeId: 'n_a', data: { itemId: 'n_a:R2', status: 'fail', decidedBy: 'auto' },
    }),
    rawEvent('acceptance/verdict', meta.id, {
      nodeId: 'n_b', data: { itemId: 'n_b:R1', status: 'pass', decidedBy: 'human', evidenceRef: 'artifacts/acc2.md' },
    }),
  ])
  const result = await call(route, 'GET', `/api/flow-studio/runs/${meta.id}/summary`)
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.summary.acceptance, { passed: 2, total: 3, rate: 2 / 3 })
  console.log(`  · summary.acceptance = ${JSON.stringify(result.json.summary.acceptance)}`)
})

await check('§13.8 stub run：run.json.engine / 列表 / summary / health 全部体现（不再带 quality）', async () => {
  const stubRun = await store.createRun(runsRoot, {
    flowId: 'flow-a', flowName: '默认流程', nodeTotal: 1, engine: 'stub',
  })
  await seedEvents(stubRun.id, [
    rawEvent('run/start', stubRun.id, {
      nodeId: undefined, attemptId: undefined,
      data: { flowId: 'flow-a', flowName: '默认流程', nodeTotal: 1, engine: 'stub' },
    }),
  ])
  assert.equal((await store.readRunMeta(runsRoot, stubRun.id)).engine, 'stub')
  const list = await call(route, 'GET', '/api/flow-studio/runs?limit=100')
  assert.equal(list.json.runs.find(run => run.id === stubRun.id).engine, 'stub')
  const summary = await call(route, 'GET', `/api/flow-studio/runs/${stubRun.id}/summary`)
  assert.equal(summary.json.summary.engine, 'stub')
  assert.equal(Object.hasOwn(summary.json.summary, 'quality'), false)

  // FLOW_STUDIO_STUB_ENGINE=1 单独设置不生效；必须同时 TESTBED=1。
  process.env.FLOW_STUDIO_STUB_ENGINE = '1'
  delete process.env.FLOW_STUDIO_TESTBED
  try {
    const igw = makeCtx()
    apply(igw)
    const ignored = await call(igw.routes[0], 'GET', '/api/flow-studio/health')
    assert.equal(ignored.json.engine, 'real', '缺 TESTBED 时桩引擎必须被忽略')
  } finally {
    delete process.env.FLOW_STUDIO_STUB_ENGINE
  }
  process.env.FLOW_STUDIO_STUB_ENGINE = '1'
  process.env.FLOW_STUDIO_TESTBED = '1'
  try {
    const gw = makeCtx()
    apply(gw)
    const enabled = await call(gw.routes[0], 'GET', '/api/flow-studio/health')
    assert.equal(enabled.json.engine, 'stub')
  } finally {
    delete process.env.FLOW_STUDIO_STUB_ENGINE
    delete process.env.FLOW_STUDIO_TESTBED
  }
})

await check('§13.7 跨节点重复 itemId → acceptance unknown 且返回 conflicts', async () => {
  const meta = await makeRun(2)
  await seedEvents(meta.id, [
    rawEvent('acceptance/verdict', meta.id, {
      nodeId: 'n_a', data: { itemId: 'R1', status: 'pass', decidedBy: 'auto', evidenceRef: 'a.md' },
    }),
    rawEvent('acceptance/verdict', meta.id, {
      nodeId: 'n_b', data: { itemId: 'R1', status: 'pass', decidedBy: 'auto', evidenceRef: 'b.md' },
    }),
  ])
  const result = await call(route, 'GET', `/api/flow-studio/runs/${meta.id}/summary`)
  assert.equal(result.json.summary.conflicts.acceptance.length, 1)
  assert.deepEqual(result.json.summary.conflicts.acceptance[0].nodes, ['n_a', 'n_b'])
  console.log(`  · conflicts=${JSON.stringify(result.json.summary.conflicts)}`)
})

await check('§13.7 /summary 按 lastSeq 增量缓存：未变命中、追加后失效', async () => {
  const meta = await makeRun(1)
  const first = await call(route, 'GET', `/api/flow-studio/runs/${meta.id}/summary`)
  assert.equal(first.json.cached, false)
  const second = await call(route, 'GET', `/api/flow-studio/runs/${meta.id}/summary`)
  assert.equal(second.json.cached, true)
  await seedEvents(meta.id, [
    rawEvent('node/end', meta.id, { data: { status: 'passed', durationMs: 1 } }),
  ])
  const third = await call(route, 'GET', `/api/flow-studio/runs/${meta.id}/summary`)
  assert.equal(third.json.cached, false)
  assert.equal(third.json.summary.eventCount, 1)
  console.log('  · summary cache: miss → hit → miss（lastSeq 变化后重建）')
})

rmSync(home, { recursive: true, force: true })
console.log(`\n${checks} 组通过`)
