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

await check('POST /runs 记录 workspace / worktree 发起参数（落 run.json.startOptions）', async () => {
  const flow = (await call(route, 'GET', '/api/flow-studio/flows')).json.flows[0]
  const created = await call(route, 'POST', '/api/flow-studio/runs', {
    flowId: flow.id,
    name: '带工作区的 run',
    workspace: '/repo/demo',
    worktree: 'on',
  })
  assert.equal(created.status, 200)
  assert.equal(created.json.run.startOptions.workspace, '/repo/demo')
  assert.equal(created.json.run.startOptions.worktree, 'on')
  const raw = JSON.parse(readFileSync(
    join(runstore.runsDir(home), created.json.run.id, 'run.json'),
    'utf8',
  ))
  assert.deepEqual(raw.startOptions, { workspace: '/repo/demo', worktree: 'on' })

  // 非法值一律 400。
  for (const body of [
    { flowId: flow.id, workspace: 'relative/path' },
    { flowId: flow.id, workspace: '' },
    { flowId: flow.id, worktree: 'sometimes' },
    { flowId: flow.id, worktree: 42 },
  ]) {
    const rejected = await call(route, 'POST', '/api/flow-studio/runs', body)
    assert.equal(rejected.status, 400, JSON.stringify(body))
    assert.equal(rejected.json.ok, false)
  }
})

await check('POST /runs/<id>/start 的 workspace / worktree 参数校验 → 400（不进入引擎）', async () => {
  const runsRoot = runstore.runsDir(home)
  const run = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 0 })
  for (const body of [{ workspace: 'rel/path' }, { workspace: 7 }, { worktree: 'always' }]) {
    const rejected = await call(route, 'POST', `/api/flow-studio/runs/${run.id}/start`, body)
    assert.equal(rejected.status, 400, JSON.stringify(body))
    assert.ok(typeof rejected.json.error === 'string' && rejected.json.error !== '')
  }
  // run 没被启动（仍然 pending）。
  assert.equal((await runstore.readRunMeta(runsRoot, run.id)).status, 'pending')
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

  // ① 显式 body：原样透传。
  const runA = (await call(injected, 'POST', '/api/flow-studio/runs', { flowId: flow.id, name: '显式参数' })).json.run
  const startedA = await call(injected, 'POST', `/api/flow-studio/runs/${runA.id}/start`, {
    workspace: '/repo/explicit', worktree: 'on',
  })
  assert.equal(startedA.status, 202, JSON.stringify(startedA.json))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].options, { workspace: '/repo/explicit', worktree: 'on' })

  // ② 创建时参数：中间隔一次会写 runstore 的调用（supervision enable），再 start 仍然带得上。
  const created = (await call(injected, 'POST', '/api/flow-studio/runs', {
    flowId: flow.id, name: '创建时参数', workspace: '/repo/from-create', worktree: 'off',
  })).json.run
  const enabled = await call(injected, 'POST', `/api/flow-studio/runs/${created.id}/supervision`, { enabled: true })
  assert.equal(enabled.status, 200, JSON.stringify(enabled.json))
  const startedB = await call(injected, 'POST', `/api/flow-studio/runs/${created.id}/start`)
  assert.equal(startedB.status, 202, JSON.stringify(startedB.json))
  assert.deepEqual(calls[1].options, { workspace: '/repo/from-create', worktree: 'off' })

  // ③ 显式 body 优先于创建时参数。
  const created2 = (await call(injected, 'POST', '/api/flow-studio/runs', {
    flowId: flow.id, name: '覆盖参数', workspace: '/repo/from-create', worktree: 'off',
  })).json.run
  await call(injected, 'POST', `/api/flow-studio/runs/${created2.id}/start`, { worktree: 'auto' })
  assert.deepEqual(calls[2].options, { workspace: '/repo/from-create', worktree: 'auto' })

  // ④ 什么都没带 → 不伪造参数（交给 engine 自己回落）。
  const created3 = (await call(injected, 'POST', '/api/flow-studio/runs', { flowId: flow.id, name: '无参数' })).json.run
  await call(injected, 'POST', `/api/flow-studio/runs/${created3.id}/start`)
  assert.deepEqual(calls[3].options, {})
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
  const run = (await call(injected, 'POST', '/api/flow-studio/runs', { flowId: bad.id, name: '非法配置' })).json.run
  const started = await call(injected, 'POST', `/api/flow-studio/runs/${run.id}/start`)
  assert.equal(started.status, 400)
  assert.match(started.json.error, /executor/)
  assert.equal(calls.length, 0, '非法 executor 必须在 engine.start 之前挡下')
  assert.equal((await runstore.readRunMeta(runsRoot, run.id)).status, 'pending')
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

rmSync(home, { recursive: true, force: true })
console.log(`\n${checks} 组通过`)
