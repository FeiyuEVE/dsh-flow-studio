#!/usr/bin/env node
/**
 * Host 半边自检：存储的增删改查 + /api/flow-studio 路由的真实 HTTP 语义。
 *
 * 不启动 dsh：自己伪造一个最小 ctx（只提供 webServer.register / effect / get），
 * 把 apply() 注册的路由取出来直接喂 req/res。这样插件装进 profile 之前就能
 * 把整条 Host 链路跑通。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

// 测试产物落在项目自己的 .tmp/ 下，不占系统 /tmp。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
process.env.DSH_HOME = mkdtempSync(join(repoRoot, '.tmp', 'home-'))
const home = process.env.DSH_HOME

const { apply, AUTH_ENV, createHandler } = await import('../src/index.js')
const store = await import('../src/store.js')
const runstore = await import('../src/runstore.js')
const { validateFlow } = await import('../src/model.js')

let checks = 0
function check(name, fn) {
  return Promise.resolve(fn()).then(() => {
    checks += 1
    console.log(`  ✓ ${name}`)
  })
}

/** 伪造的 Cordis 上下文：只实现本插件用到的那几个成员。 */
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
      // 默认给一个「通过」的 connection 服务；显式传 connection: undefined 可测 fail-closed。
      if (name === 'connection' && !Object.hasOwn(services, name)) {
        return { requestRejection: () => undefined }
      }
      return services[name]
    },
  }
  return ctx
}

/** 发一个请求给路由，返回 { status, json }。 */
function call(route, method, url, body, headers = {}) {
  return new Promise(resolve => {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = Readable.from(payload)
    const remoteAddress = headers['__remoteAddress'] || '127.0.0.1'
    const cleanHeaders = { ...headers }
    delete cleanHeaders.__remoteAddress
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', ...cleanHeaders }
    req.socket = { remoteAddress }
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
        let json = null
        try {
          json = JSON.parse(this.body)
        } catch {
          json = null
        }
        resolve({ status: this.statusCode, headers: this.headers, body: this.body, json })
      },
    }
    void route.handler(req, res)
  })
}

console.log('store.js')

await check('空目录种一份出厂模板', async () => {
  const flows = await store.listFlows(store.flowsDir(home))
  assert.equal(flows.length, 1, '第一次列表应当种子化一份模板')
  assert.ok(flows[0].nodeCount >= 6)
})

await check('保存后可读回，且整份替换生效', async () => {
  const dir = store.flowsDir(home)
  const id = store.newFlowId()
  const saved = await store.saveFlow(dir, id, { name: '测试流程', nodes: [], edges: [] })
  assert.equal(saved.id, id)
  const renamed = await store.saveFlow(dir, id, { ...saved, name: '改过名' })
  assert.equal(renamed.name, '改过名')
  assert.equal(renamed.createdAt, saved.createdAt, 'createdAt 不该被覆盖')
  const readBack = await store.readFlow(dir, id)
  assert.equal(readBack.name, '改过名')
})

await check('非法 id 一律拒绝', async () => {
  const dir = store.flowsDir(home)
  assert.equal(store.checkId('../etc/passwd'), null)
  assert.equal(store.checkId('Flow_x'), null)
  assert.equal(store.checkId(''), null)
  assert.equal(await store.readFlow(dir, '../x'), null)
  await assert.rejects(() => store.saveFlow(dir, '../x', {}), /不合法/)
})

await check('坏 JSON 文件跳过而不是整表失败', async () => {
  const dir = store.flowsDir(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'flow-broken.json'), '{ this is not json')
  const flows = await store.listFlows(dir)
  assert.ok(flows.length >= 1, '好的流程仍然要列出来')
  rmSync(join(dir, 'flow-broken.json'))
})

await check('删除返回是否存在', async () => {
  const dir = store.flowsDir(home)
  const id = store.newFlowId()
  await store.saveFlow(dir, id, { name: '待删', nodes: [], edges: [] })
  assert.equal(await store.deleteFlow(dir, id), true)
  assert.equal(await store.deleteFlow(dir, id), false)
})

console.log('store.js · 乐观锁')

await check('新建流程 version=1，读回与磁盘一致', async () => {
  const dir = store.flowsDir(home)
  const id = store.newFlowId()
  const saved = await store.saveFlow(dir, id, { name: '版本起点', nodes: [], edges: [] })
  assert.equal(saved.version, 1)
  const readBack = await store.readFlow(dir, id)
  assert.equal(readBack.version, 1)
  const raw = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
  assert.equal(raw.version, 1, 'version 必须真的落盘')
})

await check('带正确 version 保存 → version+1', async () => {
  const dir = store.flowsDir(home)
  const id = store.newFlowId()
  const v1 = await store.saveFlow(dir, id, { name: '第一版', nodes: [], edges: [] })
  const v2 = await store.saveFlow(dir, id, { ...v1, name: '第二版' })
  assert.equal(v2.version, 2)
  const readBack = await store.readFlow(dir, id)
  assert.equal(readBack.version, 2)
  assert.equal(readBack.name, '第二版')
})

await check('过期 version → FlowConflictError，且磁盘内容不被覆盖', async () => {
  const dir = store.flowsDir(home)
  const id = store.newFlowId()
  const v1 = await store.saveFlow(dir, id, { name: '旧内容', nodes: [], edges: [] })
  const v2 = await store.saveFlow(dir, id, { ...v1, name: '已提交的新内容' })
  assert.equal(v2.version, 2)
  const error = await store.saveFlow(dir, id, {
    ...v2,
    version: v1.version, // 拿着过期版本保存
    name: '过期覆盖尝试',
  }).catch(caught => caught)
  assert.ok(error instanceof store.FlowConflictError, '必须是可识别的冲突错误')
  assert.equal(error.code, 'FLOW_VERSION_CONFLICT')
  assert.equal(error.currentVersion, 2)
  assert.equal(typeof error.currentDigest, 'string')
  assert.equal(error.currentDigest.length, 16)
  assert.equal(error.currentUpdatedAt, v2.updatedAt)
  const raw = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
  assert.equal(raw.name, '已提交的新内容', '冲突路径不能先写后比')
  assert.equal(raw.version, 2)
})

await check('并发保存同一 base version：恰好一个成功、一个冲突', async () => {
  const dir = store.flowsDir(home)
  const id = store.newFlowId()
  const base = await store.saveFlow(dir, id, { name: 'base', nodes: [], edges: [] })
  const results = await Promise.allSettled([
    store.saveFlow(dir, id, { ...base, name: '并发 A' }),
    store.saveFlow(dir, id, { ...base, name: '并发 B' }),
  ])
  const fulfilled = results.filter(item => item.status === 'fulfilled')
  const rejected = results.filter(item => item.status === 'rejected')
  assert.equal(fulfilled.length, 1, '只允许一个赢家')
  assert.equal(rejected.length, 1, '输家必须收到冲突')
  assert.equal(rejected[0].reason.code, 'FLOW_VERSION_CONFLICT')
  const readBack = await store.readFlow(dir, id)
  assert.equal(readBack.version, base.version + 1, '版本只能前进一版')
  assert.ok(['并发 A', '并发 B'].includes(readBack.name))
})

await check('不带 version 的旧调用仍能保存，version 继续递增', async () => {
  const dir = store.flowsDir(home)
  const id = store.newFlowId()
  const v1 = await store.saveFlow(dir, id, { name: '旧调用一', nodes: [], edges: [] })
  // 故意不带 version：兼容旧调用方 / 脚本的无条件写入语义。
  const v2 = await store.saveFlow(dir, id, { name: '旧调用二', nodes: [], edges: [] })
  assert.equal(v2.version, v1.version + 1)
  assert.equal((await store.readFlow(dir, id)).name, '旧调用二')
})

await check('老文件没有 version → 按 v1 读，保存后变 v2', async () => {
  const dir = store.flowsDir(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'flow-legacy.json'), JSON.stringify({
    id: 'flow-legacy',
    name: '老流程',
    nodes: [],
    edges: [],
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  }))
  const readBack = await store.readFlow(dir, 'flow-legacy')
  assert.equal(readBack.version, 1, '缺 version 的老文件不该被判坏')
  const saved = await store.saveFlow(dir, 'flow-legacy', { ...readBack, name: '老流程改名' })
  assert.equal(saved.version, 2)
})

console.log('routes')

const ctx = makeCtx()
apply(ctx)
const route = ctx.routes[0]

/**
 * E3-a：工作区必须是真实存在的目录；测试统一建在项目 `.tmp/` 下（不占系统 /tmp），
 * 结尾集中清理。
 */
const workspaceDirs = []
function makeWorkspace(label) {
  const dir = mkdtempSync(join(repoRoot, '.tmp', `ws-${label}-`))
  workspaceDirs.push(dir)
  return dir
}

/**
 * 合法的最小流程（开始 → 完成）：v0.7 起 POST /flows 也过保存门禁，
 * 「先建一个壳、再 PUT 真内容」的旧造数方式会拿到 400，所以统一用这份合法流程造数。
 */
function validFlowBody(name, extra = {}) {
  return {
    name,
    nodes: [
      { id: 'a', kind: 'start', title: '开始', x: 0, y: 0, task: 't' },
      { id: 'b', kind: 'end', title: '完成', x: 300, y: 0, task: 't' },
    ],
    edges: [{ from: 'a', to: 'b', kind: 'next' }],
    ...extra,
  }
}

await check('注册了 /api/flow-studio 前缀路由', async () => {
  assert.equal(ctx.routes.length, 1)
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/api/flow-studio')
})

await check('GET /flows 返回列表', async () => {
  const result = await call(route, 'GET', '/api/flow-studio/flows')
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.ok(Array.isArray(result.json.flows))
  assert.ok(result.json.flows.length >= 1)
})

await check('POST /flows 建流程并回传校验结果（空流程也 200，validation 只报告不拦保存）', async () => {
  // 0.7 产品拍板：画布自动保存，中间态必然非法；保存一律 200 + validation，严格口径留给启动 run。
  const empty = await call(route, 'POST', '/api/flow-studio/flows', { name: '空流程', nodes: [], edges: [] })
  assert.equal(empty.status, 200)
  assert.equal(empty.json.ok, true)
  assert.ok(empty.json.flow.id, '空流程也要真的建出来（画布自动保存）')
  assert.equal(empty.json.validation.ok, false, '空流程应当校验不过（只是不拦保存）')
  assert.ok(Array.isArray(empty.json.validation.errors) && empty.json.validation.errors.length > 0)

  const result = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('路由新建'))
  assert.equal(result.status, 200)
  assert.ok(result.json.flow.id)
  assert.equal(result.json.flow.name, '路由新建')
  assert.equal(result.json.validation.ok, true, JSON.stringify(result.json.validation.errors))
})

await check('POST /flows 形状垃圾（非对象）→ 400（唯一保留的保存类 400）', async () => {
  for (const body of ['not-an-object', 42, [1, 2, 3]]) {
    const rejected = await call(route, 'POST', '/api/flow-studio/flows', body)
    assert.equal(rejected.status, 400, JSON.stringify(body))
    assert.match(rejected.json.error, /JSON 对象/)
  }
  // 合法对象但内容全空 / 字段类型怪 → 仍然 200（由 normalizeFlow 兜底）。
  const weird = await call(route, 'POST', '/api/flow-studio/flows', { name: 7, nodes: 'nope' })
  assert.equal(weird.status, 200)
  assert.equal(weird.json.ok, true)
})

await check('PUT 后 GET 拿到同一份内容', async () => {
  const created = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('往返'))
  const id = created.json.flow.id
  const body = {
    name: '往返',
    nodes: [
      { id: 'a', kind: 'start', title: '开始', x: 0, y: 0, task: 't' },
      { id: 'b', kind: 'end', title: '完成', x: 300, y: 0, task: 't' },
    ],
    edges: [{ from: 'a', to: 'b', kind: 'next' }],
  }
  const put = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, body)
  assert.equal(put.status, 200)
  assert.equal(put.json.validation.ok, true, JSON.stringify(put.json.validation.errors))
  const got = await call(route, 'GET', `/api/flow-studio/flows/${id}`)
  assert.equal(got.json.flow.nodes.length, 2)
  assert.equal(got.json.flow.edges.length, 1)
  assert.equal(validateFlow(got.json.flow).ok, true)
})

await check('POST 新建不校验版本，body.version 不生效，一律从 v1 开始', async () => {
  const created = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('新建不要预条件', {
    version: 99,
  }))
  assert.equal(created.status, 200)
  assert.equal(created.json.flow.version, 1)
})

await check('PUT 带过期 version → 409，错误体字段齐全，磁盘不覆盖', async () => {
  const created = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('冲突流程'))
  const id = created.json.flow.id
  const first = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, validFlowBody('冲突流程', { version: 1 }))
  assert.equal(first.status, 200)
  assert.equal(first.json.flow.version, 2, '成功保存要回传新 version')
  const conflict = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, validFlowBody('过期覆盖', { version: 1 }))
  assert.equal(conflict.status, 409)
  assert.equal(conflict.json.ok, false)
  assert.equal(conflict.json.error, '流程已被其他人改过，请刷新后重试')
  assert.equal(conflict.json.code, 'FLOW_VERSION_CONFLICT')
  assert.equal(conflict.json.currentVersion, 2)
  assert.ok(typeof conflict.json.updatedAt === 'string' && !Number.isNaN(Date.parse(conflict.json.updatedAt)))
  const got = await call(route, 'GET', `/api/flow-studio/flows/${id}`)
  assert.equal(got.json.flow.name, '冲突流程', '409 之后磁盘必须还是旧内容')
  assert.equal(got.json.flow.version, 2)
})

await check('PUT 支持 If-Match 版本预条件（可选兼容），过期同样 409', async () => {
  const created = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('预条件'))
  const id = created.json.flow.id
  const ok = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, validFlowBody('预条件'), {
    'if-match': '"1"',
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.flow.version, 2)
  const stale = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, validFlowBody('预条件'), {
    'if-match': '"1"',
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.json.code, 'FLOW_VERSION_CONFLICT')
  assert.equal(stale.json.currentVersion, 2)
})

await check('PUT 的 version 不是正整数 → 400（不静默退化成无条件写）', async () => {
  const created = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('坏版本'))
  const id = created.json.flow.id
  const result = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, validFlowBody('坏版本', { version: '3' }))
  assert.equal(result.status, 400)
  assert.equal(result.json.code, 'FLOW_VERSION_INVALID')
})

await check('DELETE 后 GET 回归 404', async () => {
  const created = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('删它'))
  const id = created.json.flow.id
  const del = await call(route, 'DELETE', `/api/flow-studio/flows/${id}`)
  assert.equal(del.status, 200)
  const got = await call(route, 'GET', `/api/flow-studio/flows/${id}`)
  assert.equal(got.status, 404)
})

await check('没有 skills 服务时 /skills 返回空表', async () => {
  const result = await call(route, 'GET', '/api/flow-studio/skills')
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.skills, [])
})

await check('有 skills 服务时按名字排序输出', async () => {
  const withSkills = makeCtx({
    skills: {
      list: async () => [
        { name: 'zeta', description: 'z' },
        { name: 'alpha', description: 'a', whenToUse: 'x' },
        { notASkill: true },
      ],
    },
  })
  apply(withSkills)
  const result = await call(withSkills.routes[0], 'GET', '/api/flow-studio/skills')
  assert.deepEqual(result.json.skills.map(item => item.name), ['alpha', 'zeta'])
})

await check('跨站 Origin 被拒绝', async () => {
  const result = await call(route, 'GET', '/api/flow-studio/flows', undefined, { origin: 'http://evil.example' })
  assert.equal(result.status, 403)
})

await check('§13.1 拿不到 connection 服务 → fail-closed 503（可读原因）', async () => {
  const withoutConnection = makeCtx({ connection: undefined })
  apply(withoutConnection)
  const result = await call(withoutConnection.routes[0], 'GET', '/api/flow-studio/health')
  assert.equal(result.status, 503)
  assert.equal(result.json.code, 'AUTH_SERVICE_UNAVAILABLE')
  assert.match(result.json.error, /鉴权服务不可用/)
  assert.ok(!result.body.includes(home), '503 不能泄露内部路径')
})

await check('§13.1 connection 返回 401/403 时原样返回，不再只靠 Origin', async () => {
  for (const rejection of [401, 403]) {
    const gated = makeCtx({ connection: { requestRejection: () => rejection } })
    apply(gated)
    const result = await call(gated.routes[0], 'GET', '/api/flow-studio/flows')
    assert.equal(result.status, rejection)
    assert.equal(result.json.ok, false)
  }
  // requestRejection 抛错同样 fail-closed。
  const throwing = makeCtx({ connection: { requestRejection: () => { throw new Error('boom') } } })
  apply(throwing)
  const result = await call(throwing.routes[0], 'GET', '/api/flow-studio/flows')
  assert.equal(result.status, 503)
})

await check('§13.1 FLOW_STUDIO_TOKEN < 16 字符 → 启动即拒绝并告警', async () => {
  const warnings = []
  const strictCtx = makeCtx()
  strictCtx.logger.warn = message => warnings.push(message)
  process.env[AUTH_ENV] = 'too-short'
  try {
    assert.throws(() => apply(strictCtx), /至少 16 个字符/)
    assert.ok(warnings.some(message => message.includes('拒绝启动')))
  } finally {
    delete process.env[AUTH_ENV]
  }
})

await check('§13.7 flow 目录 0700、flow 文件 0600（与 run 日志同口径）', async () => {
  const dir = store.flowsDir(home)
  const id = store.newFlowId()
  await store.saveFlow(dir, id, { name: '权限检查', nodes: [], edges: [] })
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(join(dir, `${id}.json`)).mode & 0o777, 0o600)
})

await check('§13.3 DELETE /runs/<id> 在持有租约时 409', async () => {
  const runsRoot = runstore.runsDir(home)
  const run = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 0 })
  await runstore.claimLease(runsRoot, run.id, { pid: 4242, host: 'probe-host', ttlMs: 60_000 })
  const blocked = await call(route, 'DELETE', `/api/flow-studio/runs/${run.id}`)
  assert.equal(blocked.status, 409)
  assert.match(blocked.json.error, /租约/)
  await runstore.releaseLease(runsRoot, run.id, { pid: 4242, host: 'probe-host' })
  const deleted = await call(route, 'DELETE', `/api/flow-studio/runs/${run.id}`)
  assert.equal(deleted.status, 200)
})

console.log('v0.7 · 保存门禁 / 工作区 / supervision')

await check('PUT 非法流程 → 200 + validation.errors（executor 两条新规则只报告不拦保存）', async () => {
  const created = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('门禁'))
  const id = created.json.flow.id
  const version = created.json.flow.version
  const base = {
    name: '门禁',
    version,
    nodes: [
      { id: 'a', kind: 'start', title: '开始', x: 0, y: 0, task: 't' },
      { id: 'b', kind: 'stage', title: '外部执行', x: 200, y: 0, task: 't', executor: 'custom' },
      { id: 'c', kind: 'end', title: '完成', x: 400, y: 0, task: 't' },
    ],
    edges: [
      { from: 'a', to: 'b', kind: 'next' },
      { from: 'b', to: 'c', kind: 'next' },
    ],
  }

  // ① custom 缺 executorCommand：保存成功，校验报告里带这条 error。
  const missingCommand = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, base)
  assert.equal(missingCommand.status, 200, JSON.stringify(missingCommand.json))
  assert.equal(missingCommand.json.ok, true)
  assert.equal(missingCommand.json.validation.ok, false)
  const executorError = missingCommand.json.validation.errors
    .find(item => /executorCommand/.test(item.message))
  assert.ok(executorError, JSON.stringify(missingCommand.json.validation.errors))
  assert.equal(missingCommand.json.flow.version, version + 1, '保存成功就要推进版本（不是拒绝）')

  // ② executor=codex + mode=team：同样 200，validation 里带「必须是单个 agent」。
  const codexTeam = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, {
    ...base,
    version: missingCommand.json.flow.version,
    nodes: base.nodes.map(node => (node.id === 'b'
      ? { ...node, executor: 'codex', executorCommand: '', mode: 'team' }
      : node)),
  })
  assert.equal(codexTeam.status, 200, JSON.stringify(codexTeam.json))
  assert.equal(codexTeam.json.validation.ok, false)
  assert.ok(codexTeam.json.validation.errors.some(item => /单个 agent|team/.test(item.message)),
    JSON.stringify(codexTeam.json.validation.errors))

  // 内容确实落盘了（自动保存语义）。
  const got = await call(route, 'GET', `/api/flow-studio/flows/${id}`)
  assert.equal(got.status, 200)
  assert.equal(got.json.flow.nodes.find(node => node.id === 'b').executor, 'codex')

  // warnings 不影响保存：合法流程照常 200。
  const ok = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, validFlowBody('门禁', {
    version: codexTeam.json.flow.version,
  }))
  assert.equal(ok.status, 200)
  assert.equal(ok.json.validation.errors.length, 0)
})

await check('E3-a POST /runs：workspace 必填且必须是存在的目录（落 run.json.workspace + startOptions）', async () => {
  const flow = (await call(route, 'GET', '/api/flow-studio/flows')).json.flows[0]
  const workspace = makeWorkspace('create')
  const created = await call(route, 'POST', '/api/flow-studio/runs', {
    flowId: flow.id,
    name: '带工作区的 run',
    workspace,
    worktree: 'on',
  })
  assert.equal(created.status, 200, JSON.stringify(created.json))
  assert.equal(created.json.run.startOptions.workspace, workspace)
  assert.equal(created.json.run.startOptions.worktree, 'on')
  assert.equal(created.json.run.workspace.path, workspace, '响应里也要能看到工作区绑定')
  const raw = JSON.parse(readFileSync(
    join(runstore.runsDir(home), created.json.run.id, 'run.json'),
    'utf8',
  ))
  assert.deepEqual(raw.startOptions, { workspace, worktree: 'on' })
  // E3-a：workspace 必须直接落进 run.json.workspace（runstore 白名单键），
  // 而不是只藏在 startOptions 这个 raw 兜底字段里。
  assert.equal(raw.workspace.path, workspace)
  assert.ok(typeof raw.workspace.realpath === 'string' && raw.workspace.realpath !== '')
  assert.match(raw.workspace.id, /^[0-9a-f]{12}$/)

  // 缺 workspace → 400 + code/field=workspace，且不建 run（画布不能留下幽灵 pending run）。
  const before = (await call(route, 'GET', '/api/flow-studio/runs?limit=100')).json.runs.length
  const missing = await call(route, 'POST', '/api/flow-studio/runs', { flowId: flow.id, name: '没工作区' })
  assert.equal(missing.status, 400)
  assert.equal(missing.json.ok, false)
  assert.equal(missing.json.code, 'workspace')
  assert.equal(missing.json.field, 'workspace')
  assert.match(missing.json.error, /workspace/)
  const after = (await call(route, 'GET', '/api/flow-studio/runs?limit=100')).json.runs.length
  assert.equal(after, before, '被拒绝的创建不能留下 run')

  // 非法值一律 400：相对路径 / 空串 / 不存在 / 是文件 / worktree 非法。
  const isFile = join(workspace, 'a-file.txt')
  writeFileSync(isFile, 'x')
  for (const body of [
    { flowId: flow.id, workspace: 'relative/path' },
    { flowId: flow.id, workspace: '' },
    { flowId: flow.id, workspace: join(workspace, 'no-such-dir') },
    { flowId: flow.id, workspace: isFile },
    { flowId: flow.id, worktree: 'sometimes' },
    { flowId: flow.id, worktree: 42 },
  ]) {
    const rejected = await call(route, 'POST', '/api/flow-studio/runs', body)
    assert.equal(rejected.status, 400, JSON.stringify(body))
    assert.equal(rejected.json.ok, false)
    assert.ok(typeof rejected.json.error === 'string' && rejected.json.error !== '')
  }
})

await check('E3-a POST /runs/<id>/start：缺 workspace / 不存在 / 是文件 → 400，run 状态不变', async () => {
  const runsRoot = runstore.runsDir(home)
  // 直接造一个「没有工作区绑定、也没有 startOptions」的 run（模拟旧调用 / 绕过创建校验）。
  const run = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 0 })
  const workspace = makeWorkspace('start-bad')
  const isFile = join(workspace, 'a-file.txt')
  writeFileSync(isFile, 'x')

  const cases = [
    [undefined, /缺少 workspace/],
    [{}, /缺少 workspace/],
    [{ workspace: '' }, /非空字符串/],
    [{ workspace: 'rel/path' }, /绝对路径/],
    [{ workspace: 7 }, /非空字符串/],
    [{ workspace: join(workspace, 'no-such-dir') }, /不存在/],
    [{ workspace: isFile }, /目录/],
    [{ worktree: 'always' }, /worktree/],
  ]
  for (const [body, pattern] of cases) {
    const rejected = await call(route, 'POST', `/api/flow-studio/runs/${run.id}/start`, body)
    assert.equal(rejected.status, 400, JSON.stringify(body))
    assert.match(rejected.json.error, pattern)
  }
  // 缺 workspace 的错误码/字段明确（调用方按 workspace 分流）。
  const missing = await call(route, 'POST', `/api/flow-studio/runs/${run.id}/start`)
  assert.equal(missing.status, 400)
  assert.equal(missing.json.code, 'workspace')
  assert.equal(missing.json.field, 'workspace')

  // run 没被启动：仍然 pending、没有 started 痕迹、没有 workspace 绑定。
  const meta = await runstore.readRunMeta(runsRoot, run.id)
  assert.equal(meta.status, 'pending')
  assert.equal(meta.started, false)
  assert.equal(meta.workspace, undefined)
})

await check('POST /runs/<id>/supervision：400 / 404 / enable / disable 落盘', async () => {
  const runsRoot = runstore.runsDir(home)
  const run = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 0 })

  // 404：run 不存在。
  const missing = await call(route, 'POST', '/api/flow-studio/runs/r-no-such-run/supervision', { enabled: true })
  assert.equal(missing.status, 404)

  // 400：enabled 必须有且是布尔；wakerSessionId 必须是字符串。
  for (const body of [{}, { enabled: 'yes' }, { enabled: 1 }]) {
    const rejected = await call(route, 'POST', `/api/flow-studio/runs/${run.id}/supervision`, body)
    assert.equal(rejected.status, 400, JSON.stringify(body))
  }
  const badWaker = await call(route, 'POST', `/api/flow-studio/runs/${run.id}/supervision`, {
    enabled: true, wakerSessionId: 42,
  })
  assert.equal(badWaker.status, 400)

  // enable：登记调度 + 落盘 run.json.supervision。
  const enabled = await call(route, 'POST', `/api/flow-studio/runs/${run.id}/supervision`, {
    enabled: true, wakerSessionId: 'session-waker-1',
  })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.json.ok, true)
  assert.equal(enabled.json.enabled, true)
  assert.equal(enabled.json.supervision.enabled, true)
  assert.equal(enabled.json.supervision.wakerSessionId, 'session-waker-1')
  assert.equal(enabled.json.scheduler.enabled, true)
  const rawEnabled = JSON.parse(readFileSync(join(runsRoot, run.id, 'run.json'), 'utf8'))
  assert.equal(rawEnabled.supervision.enabled, true)
  assert.equal(rawEnabled.supervision.wakerSessionId, 'session-waker-1')

  // GET 也能读到（客户端只读展示用）。
  const readBack = await call(route, 'GET', `/api/flow-studio/runs/${run.id}/supervision`)
  assert.equal(readBack.status, 200)
  assert.equal(readBack.json.supervision.enabled, true)
  assert.equal(readBack.json.scheduler.enabled, true)

  // disable：摘除登记 + 落盘 enabled=false。
  const disabled = await call(route, 'POST', `/api/flow-studio/runs/${run.id}/supervision`, { enabled: false })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.json.enabled, false)
  assert.equal(disabled.json.supervision.enabled, false)
  assert.equal(disabled.json.supervision.reason, 'disabled-by-caller')
  assert.equal(disabled.json.scheduler.enabled, false)
  const rawDisabled = JSON.parse(readFileSync(join(runsRoot, run.id, 'run.json'), 'utf8'))
  assert.equal(rawDisabled.supervision.enabled, false)
})

await check('GET /runs 行带 workspaceId / workspacePath / worktreeEnabled（桩 run.json，缺字段不抛错）', async () => {
  const runsRoot = runstore.runsDir(home)
  const withWs = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 1 })
  // v0.7：workspace / worktree / sessionMode / supervision 已进 runstore.normalizeMeta 白名单，
  // 这里用真实写路径（writeRunMeta）造桩，顺带验证四个键不会被整份重写丢掉。
  await runstore.writeRunMeta(runsRoot, withWs.id, {
    workspace: { id: 'ws-abc1234567', path: '/repo/demo', realpath: '/repo/demo', isGit: true, gitRoot: '/repo/demo' },
    worktree: {
      enabled: true,
      reason: 'git-workspace',
      decidedBy: 'initiator',
      path: '/wt/r-1',
      branch: 'flow/r-1',
      baseCommit: 'abc1234',
      createdAt: '2026-11-06T00:00:00.000Z',
    },
    sessionMode: 'top-level',
    supervision: { enabled: true, wakerSessionId: 'session-waker-1', wakes: 2 },
  })
  const without = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 1 })

  const listed = await call(route, 'GET', '/api/flow-studio/runs?limit=100')
  assert.equal(listed.status, 200)
  const row = listed.json.runs.find(item => item.id === withWs.id)
  assert.ok(row, '新 run 必须出现在列表里')
  assert.equal(row.workspaceId, 'ws-abc1234567')
  assert.equal(row.workspacePath, '/repo/demo')
  assert.equal(row.worktreeEnabled, true)
  assert.equal(row.supervision.enabled, true)
  // v0.7 字段契约：行与详情都带 workspace / worktree / sessionMode / supervision 四个字段。
  assert.equal(row.workspace.id, 'ws-abc1234567')
  assert.equal(row.worktree.branch, 'flow/r-1')
  assert.equal(row.sessionMode, 'top-level')

  // 没有 workspace 字段的老 run：null / false，不抛错。
  const bare = listed.json.runs.find(item => item.id === without.id)
  assert.ok(bare)
  assert.equal(bare.workspaceId, null)
  assert.equal(bare.workspacePath, null)
  assert.equal(bare.worktreeEnabled, false)
  assert.equal(bare.supervision, null)
  assert.equal(bare.workspace, null)
  assert.equal(bare.worktree, null)
  assert.equal(bare.sessionMode, null)

  // ?workspaceId= 内存过滤。
  const filtered = await call(route, 'GET', '/api/flow-studio/runs?limit=100&workspaceId=ws-abc1234567')
  assert.equal(filtered.status, 200)
  assert.deepEqual(filtered.json.runs.map(item => item.id), [withWs.id])

  // 详情带完整 workspace / worktree 对象 + supervision。
  const detail = await call(route, 'GET', `/api/flow-studio/runs/${withWs.id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.json.run.workspace.id, 'ws-abc1234567')
  assert.equal(detail.json.run.worktree.path, '/wt/r-1')
  assert.equal(detail.json.run.worktree.enabled, true)
  assert.equal(detail.json.run.supervision.enabled, true)
  assert.equal(detail.json.run.sessionMode, 'top-level')
  assert.equal(detail.json.run.workspace.gitRoot, '/repo/demo')

  // summary 也带 supervision（两个端点都要能读到）。
  const summary = await call(route, 'GET', `/api/flow-studio/runs/${withWs.id}/summary`)
  assert.equal(summary.status, 200)
  assert.equal(summary.json.supervision.enabled, true)
  assert.equal(summary.json.workspaceId, 'ws-abc1234567')
  assert.equal(summary.json.worktreeEnabled, true)
  assert.equal(summary.json.sessionMode, 'top-level')
})

await check('v0.8 · GET /runs 行 / 详情 / summary 都带 nodeStatus（桩 run.json，缺省 {}）', async () => {
  const runsRoot = runstore.runsDir(home)
  const withStatus = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 2 })
  // v0.8 §11.4：nodeStatus 已在 runstore.normalizeMeta 白名单里，走真实写路径造桩。
  await runstore.writeRunMeta(runsRoot, withStatus.id, {
    nodeStatus: {
      n_dev: {
        state: 'blocked',
        progress: 40,
        summary: '等接口联调',
        verdict: null,
        members: [{ name: 'dev-1', state: 'working' }],
        blockers: ['等接口'],
        at: '2026-11-06T00:00:00.000Z',
      },
      n_test: { state: 'done', progress: 100, summary: '测试通过', verdict: 'pass', at: '2026-11-06T00:05:00.000Z' },
    },
  })
  const bare = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 1 })

  const listed = await call(route, 'GET', '/api/flow-studio/runs?limit=100')
  assert.equal(listed.status, 200)
  const row = listed.json.runs.find(item => item.id === withStatus.id)
  assert.ok(row, '新 run 必须出现在列表里')
  assert.equal(row.nodeStatus.n_dev.state, 'blocked')
  assert.equal(row.nodeStatus.n_dev.progress, 40)
  assert.equal(row.nodeStatus.n_dev.summary, '等接口联调')
  assert.deepEqual(row.nodeStatus.n_dev.members, [{ name: 'dev-1', state: 'working' }])
  assert.deepEqual(row.nodeStatus.n_dev.blockers, ['等接口'])
  assert.equal(row.nodeStatus.n_test.verdict, 'pass')
  // 没有 nodeStatus 的老 run：缺省 {}（不是 null / undefined）。
  const bareRow = listed.json.runs.find(item => item.id === bare.id)
  assert.ok(bareRow)
  assert.deepEqual(bareRow.nodeStatus, {})

  const detail = await call(route, 'GET', `/api/flow-studio/runs/${withStatus.id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.json.run.nodeStatus.n_dev.state, 'blocked')
  assert.equal(detail.json.run.nodeStatus.n_dev.progress, 40)
  assert.equal(detail.json.run.nodeStatus.n_test.state, 'done')

  const summary = await call(route, 'GET', `/api/flow-studio/runs/${withStatus.id}/summary`)
  assert.equal(summary.status, 200)
  assert.equal(summary.json.nodeStatus.n_dev.state, 'blocked')
  assert.equal(summary.json.nodeStatus.n_dev.at, '2026-11-06T00:00:00.000Z')
})

await check('supervision enable 对已收尾 run → 400（不登记一个永远不会被唤醒的 run）', async () => {
  const runsRoot = runstore.runsDir(home)
  const run = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 1 })
  await runstore.writeRunMeta(runsRoot, run.id, { status: 'done', started: true, endedAt: new Date().toISOString() })
  const rejected = await call(route, 'POST', `/api/flow-studio/runs/${run.id}/supervision`, {
    enabled: true, wakerSessionId: 'session-waker-1',
  })
  assert.equal(rejected.status, 400)
  assert.match(rejected.json.error, /已结束/)
  const raw = JSON.parse(readFileSync(join(runsRoot, run.id, 'run.json'), 'utf8'))
  assert.equal(raw.supervision, undefined, '被拒绝的开启不能留下 supervision 字段')
  // 关闭是幂等的应急动作：对已收尾 run 关掉仍然 200。
  const off = await call(route, 'POST', `/api/flow-studio/runs/${run.id}/supervision`, { enabled: false })
  assert.equal(off.status, 200)
  assert.equal(off.json.supervision.enabled, false)
})

await check('POST /runs/<id>/start 把 {workspace, worktree} 透传给 engine.start（含创建时参数）', async () => {
  // 用 createHandler + 假引擎直接看 engine.start 收到的 options；真引擎要起 agents，
  // 「参数透传」不该只能靠集成测试覆盖。
  const runsRoot = runstore.runsDir(home)
  const calls = []
  const fakeEngine = {
    engineName: 'real',
    async start(runId, options) {
      calls.push({ runId, options })
      return { id: runId, status: 'running' }
    },
    async stop() { return {} },
    supervision: {
      register() { return { enabled: true } },
      unregister() { return true },
      status() { return { enabled: true, nextDueAt: null, wakes: 0, failures: 0, lastReason: null } },
    },
  }
  const injected = { handler: createHandler({
    dir: store.flowsDir(home), runsRoot, ctx, engine: fakeEngine, startOptions: new Map(),
  }) }
  const flow = (await call(route, 'GET', '/api/flow-studio/flows')).json.flows[0]
  const wsExplicit = makeWorkspace('explicit')
  const wsCreate = makeWorkspace('from-create')
  const wsNormal = makeWorkspace('normal')

  // ① 显式 body：原样透传（run 用 runstore 直造，模拟「创建时没绑定工作区」的旧调用）。
  const runA = await runstore.createRun(runsRoot, { flowId: flow.id, flowName: flow.name, nodeTotal: 1 })
  const startedA = await call(injected, 'POST', `/api/flow-studio/runs/${runA.id}/start`, {
    workspace: wsExplicit, worktree: 'on',
  })
  assert.equal(startedA.status, 202, JSON.stringify(startedA.json))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].options, { workspace: wsExplicit, worktree: 'on' })
  // E3-a：启动时拿到的工作区要持久化进 run.json.workspace。
  const rawA = JSON.parse(readFileSync(join(runsRoot, runA.id, 'run.json'), 'utf8'))
  assert.equal(rawA.workspace.path, wsExplicit)
  assert.match(rawA.workspace.id, /^[0-9a-f]{12}$/)

  // ② 创建时参数：中间隔一次会写 runstore 的调用（supervision enable），再 start 仍然带得上。
  const created = (await call(injected, 'POST', '/api/flow-studio/runs', {
    flowId: flow.id, name: '创建时参数', workspace: wsCreate, worktree: 'off',
  })).json.run
  const enabled = await call(injected, 'POST', `/api/flow-studio/runs/${created.id}/supervision`, { enabled: true })
  assert.equal(enabled.status, 200, JSON.stringify(enabled.json))
  const startedB = await call(injected, 'POST', `/api/flow-studio/runs/${created.id}/start`)
  assert.equal(startedB.status, 202, JSON.stringify(startedB.json))
  assert.deepEqual(calls[1].options, { workspace: wsCreate, worktree: 'off' })

  // ③ 显式 body 优先于创建时参数（这里只覆盖 worktree，workspace 仍是创建时那个）。
  const created2 = (await call(injected, 'POST', '/api/flow-studio/runs', {
    flowId: flow.id, name: '覆盖参数', workspace: wsCreate, worktree: 'off',
  })).json.run
  await call(injected, 'POST', `/api/flow-studio/runs/${created2.id}/start`, { worktree: 'auto' })
  assert.deepEqual(calls[2].options, { workspace: wsCreate, worktree: 'auto' })

  // ④ 什么都没带 → 400（不再伪造空参数交给 engine 回落 process.cwd()）。
  const created3 = (await call(injected, 'POST', `/api/flow-studio/runs`, { flowId: flow.id, name: '缺工作区' }))
  assert.equal(created3.status, 400, JSON.stringify(created3.json))
  assert.equal(created3.json.code, 'workspace')
  assert.equal(calls.length, 3, '缺 workspace 的创建不该进引擎')

  const bare = await runstore.createRun(runsRoot, { flowId: flow.id, flowName: flow.name, nodeTotal: 1 })
  const rejected = await call(injected, 'POST', `/api/flow-studio/runs/${bare.id}/start`)
  assert.equal(rejected.status, 400)
  assert.equal(rejected.json.code, 'workspace')
  assert.equal(calls.length, 3, '缺 workspace 的启动不该进引擎')
  assert.equal((await runstore.readRunMeta(runsRoot, bare.id)).status, 'pending')

  // ⑤ 正常路径：200/202 + run.json 里能看到 workspace。
  const normal = await runstore.createRun(runsRoot, { flowId: flow.id, flowName: flow.name, nodeTotal: 1 })
  const startedNormal = await call(injected, 'POST', `/api/flow-studio/runs/${normal.id}/start`, {
    workspace: wsNormal,
  })
  assert.equal(startedNormal.status, 202, JSON.stringify(startedNormal.json))
  assert.deepEqual(calls[3].options, { workspace: wsNormal })
  const rawNormal = JSON.parse(readFileSync(join(runsRoot, normal.id, 'run.json'), 'utf8'))
  assert.equal(rawNormal.workspace.path, wsNormal)
  assert.ok(typeof rawNormal.workspace.realpath === 'string' && rawNormal.workspace.realpath !== '')

  // ⑥ 创建时已绑定工作区 → 启动时换一个必须 400（run 一旦定下工作区不可更换）。
  const bound = (await call(injected, 'POST', '/api/flow-studio/runs', {
    flowId: flow.id, name: '绑定后更换', workspace: wsCreate,
  })).json.run
  const changed = await call(injected, 'POST', `/api/flow-studio/runs/${bound.id}/start`, {
    workspace: wsNormal,
  })
  assert.equal(changed.status, 400, JSON.stringify(changed.json))
  assert.equal(changed.json.code, 'workspace')
  assert.match(changed.json.error, /绑定/)
  assert.equal(calls.length, 4, '换工作区的启动不该进引擎')

  // ⑦ stub 例外：桩引擎不要求 workspace（不补默认值，原样透传 {}）。
  const stubCalls = []
  const stubEngine = {
    engineName: 'stub',
    async start(runId, options) { stubCalls.push({ runId, options }); return { id: runId, status: 'running' } },
    async stop() { return {} },
    supervision: { register() { return {} }, unregister() { return true }, status() { return {} } },
  }
  const stubHandler = { handler: createHandler({
    dir: store.flowsDir(home), runsRoot, ctx, engine: stubEngine, startOptions: new Map(),
  }) }
  const stubRun = (await call(stubHandler, 'POST', '/api/flow-studio/runs', { flowId: flow.id, name: '桩 run' })).json.run
  assert.ok(stubRun && stubRun.id, 'stub 下建 run 不要求 workspace')
  const stubStarted = await call(stubHandler, 'POST', `/api/flow-studio/runs/${stubRun.id}/start`)
  assert.equal(stubStarted.status, 202, JSON.stringify(stubStarted.json))
  assert.deepEqual(stubCalls[0].options, {}, 'stub 不补默认 workspace')
})

await check('启动 run 前拦非法 executor（保存能存，但开不了跑）：400 且不调 engine.start', async () => {
  const runsRoot = runstore.runsDir(home)
  const bad = await store.saveFlow(store.flowsDir(home), 'flow-bad-executor', {
    name: '非法 executor',
    nodes: [
      { id: 'a', kind: 'start', title: '开始', x: 0, y: 0, task: 't' },
      { id: 'b', kind: 'stage', title: '外部执行', x: 200, y: 0, task: '做', mode: 'single', executor: 'custom' },
      { id: 'c', kind: 'end', title: '完成', x: 400, y: 0, task: '' },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', kind: 'next' },
      { id: 'e2', from: 'b', to: 'c', kind: 'next' },
    ],
  })
  // 保存侧只报告（validateFlow 有 executor 规则），不拦。
  const saved = await call(route, 'PUT', `/api/flow-studio/flows/${bad.id}`, {
    ...bad, version: bad.version,
  })
  assert.equal(saved.status, 200)

  const calls = []
  const injected = { handler: createHandler({
    dir: store.flowsDir(home),
    runsRoot,
    ctx,
    startOptions: new Map(),
    engine: {
      engineName: 'real',
      async start(runId, options) { calls.push({ runId, options }); return { id: runId, status: 'running' } },
      async stop() { return {} },
      supervision: { register() { return {} }, unregister() { return true }, status() { return {} } },
    },
  }) }
  const run = (await call(injected, 'POST', '/api/flow-studio/runs', {
    flowId: bad.id, name: '非法配置', workspace: makeWorkspace('bad-executor'),
  })).json.run
  const started = await call(injected, 'POST', `/api/flow-studio/runs/${run.id}/start`)
  assert.equal(started.status, 400)
  assert.match(started.json.error, /executor/)
  assert.equal(calls.length, 0, '非法 executor 必须在 engine.start 之前挡下')
  assert.equal((await runstore.readRunMeta(runsRoot, run.id)).status, 'pending')
})

console.log('E3-b · 外部 events 通道只收观测类事件')

await check('E3-b POST /runs/<id>/events 拒绝全部生命周期 kind（400，且 run 状态/事件数不变）', async () => {
  const runsRoot = runstore.runsDir(home)
  const run = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 1 })

  // 引擎/运行时才能推进的 kind：逐个断言 400。data 故意给「合法形状」，
  // 证明拒绝发生在事件校验之前（是通道白名单，不是某条 data 字段写错）。
  const lifecycle = [
    { kind: 'run/start', data: { flowId: 'flow-a', flowName: 'A', nodeTotal: 1 } },
    { kind: 'run/end', data: { status: 'failed', reason: '外部想直接收尾' } },
    { kind: 'node/start', nodeId: 'n_a', attemptId: 1, data: { title: 'x', mode: 'single', skills: [] } },
    { kind: 'node/end', nodeId: 'n_a', attemptId: 1, data: { status: 'failed', durationMs: 1 } },
    { kind: 'member/start', nodeId: 'n_a', attemptId: 1, memberId: 'm1', data: { name: '成员' } },
    { kind: 'member/end', nodeId: 'n_a', attemptId: 1, memberId: 'm1', data: { status: 'failed', durationMs: 1 } },
    {
      kind: 'reject/trigger',
      nodeId: 'n_a',
      attemptId: 1,
      data: { edgeId: 'e1', fromNodeId: 'n_a', toNodeId: 'n_b', reason: '外部想打回' },
    },
  ]
  for (const event of lifecycle) {
    const rejected = await call(route, 'POST', `/api/flow-studio/runs/${run.id}/events`, {
      v: 1, traceId: 'trace-lifecycle', ...event,
    })
    assert.equal(rejected.status, 400, event.kind)
    assert.equal(rejected.json.ok, false)
    assert.match(rejected.json.error, /生命周期|观测类/)
  }

  // 状态机完全没动：仍 pending、没 started、没有事件落盘。
  const meta = await runstore.readRunMeta(runsRoot, run.id)
  assert.equal(meta.status, 'pending')
  assert.equal(meta.started, false)
  assert.equal(meta.eventCount, 0)
  const events = await call(route, 'GET', `/api/flow-studio/runs/${run.id}/events`)
  assert.equal(events.status, 200)
  assert.equal(events.json.events.length, 0)

  // 不存在的 run 仍然 404（资源存在性优先于通道白名单），不会被误报成 400。
  const missingRun = await call(route, 'POST', '/api/flow-studio/runs/r-no-such-run/events', {
    v: 1, kind: 'agent/message', nodeId: 'n_a', attemptId: 1, traceId: 'trace-missing',
    data: { role: 'assistant', text: 'x', truncated: false },
  })
  assert.equal(missingRun.status, 404)
})

await check('E3-b POST /runs/<id>/events 接受观测类事件；混合批次整批拒绝且不推状态', async () => {
  const runsRoot = runstore.runsDir(home)
  const run = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 1 })
  const base = `/api/flow-studio/runs/${run.id}/events`

  // 消息 / 上报类：200，且只追加事实。
  const agentMessage = await call(route, 'POST', base, {
    v: 1, kind: 'agent/message', nodeId: 'n_a', attemptId: 1, traceId: 'trace-obs-1',
    data: { role: 'assistant', text: '节点汇报：已读到接口定义', truncated: false },
  })
  assert.equal(agentMessage.status, 200, JSON.stringify(agentMessage.json))
  assert.equal(agentMessage.json.accepted, 1)

  const nodeStatus = await call(route, 'POST', base, {
    v: 1, kind: 'node/status', nodeId: 'n_a', attemptId: 1, traceId: 'trace-obs-2',
    data: { state: 'working', progress: 50, summary: '正在联调' },
  })
  assert.equal(nodeStatus.status, 200, JSON.stringify(nodeStatus.json))

  const messageIn = await call(route, 'POST', base, {
    v: 1, kind: 'message/in', traceId: 'trace-obs-3',
    data: { id: 'm-external-1', from: 'probe', text: '外部观测消息' },
  })
  assert.equal(messageIn.status, 200, JSON.stringify(messageIn.json))

  const afterObservations = await runstore.readRunMeta(runsRoot, run.id)
  assert.equal(afterObservations.status, 'pending', '观测类事件不能推动状态机')
  assert.equal(afterObservations.started, false)
  assert.equal(afterObservations.eventCount, 3)

  // 混合批次：观测 + 生命周期 → 整批 400，一条都不写（错误里指出下标）。
  const mixed = await call(route, 'POST', base, [
    {
      v: 1, kind: 'agent/message', nodeId: 'n_a', attemptId: 1, traceId: 'trace-mixed-1',
      data: { role: 'assistant', text: '这条本来合法', truncated: false },
    },
    { v: 1, kind: 'run/start', traceId: 'trace-mixed-2', data: { flowId: 'flow-a', flowName: 'A', nodeTotal: 1 } },
  ])
  assert.equal(mixed.status, 400)
  assert.equal(mixed.json.field, 'events[1].kind', '错误要指出是批次里的第 2 条')
  assert.equal(mixed.json.index, 1)
  assert.match(mixed.json.error, /生命周期/)
  const afterMixed = await runstore.readRunMeta(runsRoot, run.id)
  assert.equal(afterMixed.status, 'pending')
  assert.equal(afterMixed.eventCount, 3, '整批拒绝时合法的那条也不能落盘')

  // 被拒的 run/start 没有把 run 推成 running：它仍然可以被正常启动（不会「已 running 且永久 409」）。
  const ws = makeWorkspace('events-start')
  const calls = []
  const injected = { handler: createHandler({
    dir: store.flowsDir(home), runsRoot, ctx, startOptions: new Map(),
    engine: {
      engineName: 'real',
      async start(runId, options) { calls.push({ runId, options }); return { id: runId, status: 'running' } },
      async stop() { return {} },
      supervision: { register() { return {} }, unregister() { return true }, status() { return {} } },
    },
  }) }
  const started = await call(injected, 'POST', `/api/flow-studio/runs/${run.id}/start`, { workspace: ws })
  assert.equal(started.status, 202, JSON.stringify(started.json))
  assert.equal(calls.length, 1)
})

await check('未知接口 404，未知方法 405', async () => {
  const unknown = await call(route, 'GET', '/api/flow-studio/nope')
  assert.equal(unknown.status, 404)
  const wrongMethod = await call(route, 'PATCH', '/api/flow-studio/flows')
  assert.equal(wrongMethod.status, 405)
})

await check('写入的文件真的落在 DSH_HOME 下', async () => {
  const created = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('落盘检查'))
  const id = created.json.flow.id
  const path = join(store.flowsDir(home), `${id}.json`)
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(raw.name, '落盘检查')
  assert.equal(raw.id, id)
  assert.ok(raw.updatedAt)
})

await check('health 报出目录与 schema 版本（已通过 connection 鉴权）', async () => {
  const result = await call(route, 'GET', '/api/flow-studio/health')
  assert.equal(result.status, 200)
  assert.equal(result.json.schemaVersion, 1)
  assert.equal(result.json.auth, 'connection')
  assert.ok(result.json.dir.includes('flow-studio'))
  assert.ok(result.json.runsDir.includes('runs'))
})

for (const dir of workspaceDirs) rmSync(dir, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
console.log(`\n${checks} 组通过`)
