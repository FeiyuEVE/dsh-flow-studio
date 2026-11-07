#!/usr/bin/env node
/**
 * Host 半边自检：存储的增删改查 + /api/flow-studio 路由的真实 HTTP 语义。
 *
 * 不启动 dsh：自己伪造一个最小 ctx（只提供 webServer.register / effect / get），
 * 把 apply() 注册的路由取出来直接喂 req/res。这样插件装进 profile 之前就能
 * 把整条 Host 链路跑通。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

// 测试产物落在项目自己的 .tmp/ 下，不占系统 /tmp。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
process.env.DSH_HOME = mkdtempSync(join(repoRoot, '.tmp', 'home-'))
const home = process.env.DSH_HOME

const {
  apply, AUTH_ENV, READ_AUTH_ENV, CUSTOM_EXECUTOR_ENV, WORKSPACE_ROOTS_ENV, createHandler,
} = await import('../src/index.js')
const { MAX_TIMEOUT_MS } = await import('../src/tools.js')
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

await check('0.9.1 覆盖前留旧版本备份：.history/<id>.v<version>.json，最多 3 份', async () => {
  const dir = store.flowsDir(home)
  const id = store.newFlowId()
  const twoNodes = {
    name: '备份验证',
    nodes: [
      { id: 'a', kind: 'start', title: '开始', x: 0, y: 0, task: 't' },
      { id: 'b', kind: 'end', title: '完成', x: 300, y: 0, task: 't' },
    ],
    edges: [{ from: 'a', to: 'b', kind: 'next' }],
  }
  const v1 = await store.saveFlow(dir, id, twoNodes)
  assert.equal(v1.version, 1)
  // 真事故形态：下一条 PUT 是一张空图，整份替换把这 2 个节点覆盖掉。
  const v2 = await store.saveFlow(dir, id, { name: '备份验证', nodes: [], edges: [] })
  assert.equal(v2.version, 2)
  const kept = JSON.parse(readFileSync(join(dir, '.history', `${id}.v1.json`), 'utf8'))
  assert.equal(kept.version, 1)
  assert.equal(kept.nodes.length, 2, '覆盖前那一版必须原样留着，事故才能回滚：' + JSON.stringify(kept.nodes))

  for (let i = 0; i < 4; i += 1) {
    await store.saveFlow(dir, id, { name: '覆盖 ' + i, nodes: [], edges: [] })
  }
  const names = readdirSync(join(dir, '.history')).filter(name => name.startsWith(`${id}.v`))
  assert.equal(names.length, 3, '每份流程只留最近 3 份备份，不能无限增长：' + names.join(','))
  const listed = await store.listFlows(dir)
  assert.equal(listed.some(item => item.id.includes('history')), false, '.history 不能出现在流程列表里')
})

await check('0.9.1 同 version 重复备份不覆盖已有历史（撤销重建按 v1 复现）', async () => {
  const dir = store.flowsDir(home)
  const id = store.newFlowId()
  const twoNodes = {
    name: '事故前',
    nodes: [
      { id: 'a', kind: 'start', title: '开始', x: 0, y: 0, task: 't' },
      { id: 'b', kind: 'end', title: '完成', x: 300, y: 0, task: 't' },
    ],
    edges: [{ from: 'a', to: 'b', kind: 'next' }],
  }
  await store.saveFlow(dir, id, twoNodes) // v1
  await store.saveFlow(dir, id, { name: '覆盖 1', nodes: [], edges: [] }) // v2，旧 v1 进 .history
  const historyPath = join(dir, '.history', `${id}.v1.json`)
  const before = JSON.parse(readFileSync(historyPath, 'utf8'))
  assert.equal(before.version, 1)
  assert.equal(before.nodes.length, 2, '前提：v1 备份应当留着删除前的两个节点')

  // 撤销 = 服务器上这份文件没了，客户端按手里的图从 v1 重建（绕开 deleteFlow，历史目录还在）。
  rmSync(join(dir, `${id}.json`))
  const rebuilt = await store.saveFlow(dir, id, {
    name: '撤销重建',
    nodes: [{ id: 'a', kind: 'start', title: '开始', x: 0, y: 0, task: 't' }],
    edges: [],
  })
  assert.equal(rebuilt.version, 1)
  // 再覆盖一次：同 version=1 会再次触发 stash，绝不能把上面那份证据覆盖掉。
  await store.saveFlow(dir, id, { name: '撤销后再覆盖', nodes: [], edges: [] })
  const after = JSON.parse(readFileSync(historyPath, 'utf8'))
  assert.equal(after.name, '事故前', '同 version 的后来者不能覆盖已有备份')
  assert.equal(after.nodes.length, 2, '已有备份必须原样留着')
  assert.equal(after.version, 1)
})

await check('0.9.1 deleteFlow 归档历史备份：活动 .history 不留该 id，历史目录缺失也不抛错', async () => {
  const dir = store.flowsDir(home)
  const id = store.newFlowId()
  const twoNodes = {
    name: '删除前',
    nodes: [
      { id: 'a', kind: 'start', title: '开始', x: 0, y: 0, task: 't' },
      { id: 'b', kind: 'end', title: '完成', x: 300, y: 0, task: 't' },
    ],
    edges: [{ from: 'a', to: 'b', kind: 'next' }],
  }
  await store.saveFlow(dir, id, twoNodes) // v1
  await store.saveFlow(dir, id, { name: '覆盖后', nodes: [], edges: [] }) // v2，v1 进 .history
  const historyDir = join(dir, '.history')
  assert.equal(existsSync(join(historyDir, `${id}.v1.json`)), true, '前提：覆盖前应当有 v1 备份')

  assert.equal(await store.deleteFlow(dir, id), true)
  const stillActive = readdirSync(historyDir)
    .filter(name => name.startsWith(`${id}.v`) && name.endsWith('.json'))
  assert.deepEqual(stillActive, [], '删除后活动历史不能还留该 id 的备份：' + stillActive.join(','))
  const archivedDir = join(historyDir, 'deleted')
  const archived = readdirSync(archivedDir)
    .filter(name => name.startsWith(`${id}.v`) && name.endsWith('.json'))
  assert.equal(archived.length, 1, '删除前的备份应挪进 .history/deleted/ 归档：' + archived.join(','))
  const kept = JSON.parse(readFileSync(join(archivedDir, archived[0]), 'utf8'))
  assert.equal(kept.name, '删除前')
  assert.equal(kept.nodes.length, 2, '归档里必须是删除前那份证据')
  assert.equal(await store.deleteFlow(dir, id), false, '文件不存在仍返回 false')

  // 没有任何 .history 目录时删除照样成功，归档失败不能改变返回值 / 不能抛错。
  const bareDir = join(home, 'flow-studio', `flows-bare-${id}`)
  mkdirSync(bareDir, { recursive: true })
  writeFileSync(
    join(bareDir, 'flow-bare.json'),
    JSON.stringify({ id: 'flow-bare', name: '无历史', nodes: [], edges: [] }),
  )
  assert.equal(await store.deleteFlow(bareDir, 'flow-bare'), true)
  assert.equal(existsSync(join(bareDir, 'flow-bare.json')), false)
  assert.equal(existsSync(join(bareDir, '.history')), false, '删除不该凭空造出历史目录')
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

await check('0.9.1 PUT 缺 nodes/edges 键或不是数组 → 400，流程不被写成空图', async () => {
  const created = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('缺字段'))
  const id = created.json.flow.id
  const flowPath = join(store.flowsDir(home), `${id}.json`)
  // 真事故形态：把「流程列表摘要」{id,name,nodeCount,edgeCount,…} 当流程 PUT 回来。
  const list = await call(route, 'GET', '/api/flow-studio/flows')
  const summary = list.json.flows.find(item => item.id === id)
  assert.ok(summary && !('nodes' in summary), '前提：摘要本来就没有 nodes')
  const badBodies = [
    ['列表摘要', summary],
    ['nodes/edges 为 null', { name: 'null 图', nodes: null, edges: null }],
    ['nodes 不是数组', { name: '类型错', nodes: 'x', edges: [] }],
    ['只有 name', { name: '只有名字' }],
  ]
  for (const [label, body] of badBodies) {
    const rejected = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, body)
    assert.equal(rejected.status, 400, label + '：' + JSON.stringify(rejected.json))
    assert.equal(rejected.json.code, 'FLOW_BODY_INCOMPLETE', label)
    assert.match(rejected.json.error, /nodes/, label)
    assert.match(rejected.json.error, /数组/, label)
    const after = await call(route, 'GET', `/api/flow-studio/flows/${id}`)
    assert.equal(after.json.flow.nodes.length, 2, label + '：被拒绝的 PUT 一个字节都不能写盘')
    assert.equal(after.json.flow.version, 1, label + '：被拒绝的 PUT 不能推进版本号')
    const raw = JSON.parse(readFileSync(flowPath, 'utf8'))
    assert.equal(raw.version, 1, label + '：磁盘版本号必须不变')
    assert.equal(raw.nodes.length, 2, label + '：磁盘节点数必须不变')
  }

  // 反向：用户真的删光节点（nodes: [] 键在且是数组）仍然允许保存，宽松口径不变。
  const emptied = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, { name: '删光了', nodes: [], edges: [] })
  assert.equal(emptied.status, 200, '空图仍然要能保存')
  assert.equal(emptied.json.flow.nodes.length, 0)
  assert.equal(emptied.json.flow.version, 2, '整份替换仍然推进版本号')
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

await check('0.9.1 删除→撤销→再覆盖：删除前证据进 deleted/，重建流程从干净历史重新开始', async () => {
  const created = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('撤销链路'))
  const id = created.json.flow.id
  const dir = store.flowsDir(home)
  // 真事故形态：客户端把图清空后保存 → v2 是空图，v1（两个节点）进 .history。
  const emptied = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, {
    name: '撤销链路',
    nodes: [],
    edges: [],
  })
  assert.equal(emptied.json.flow.version, 2)
  // 删除：活动历史被归档。
  const deleted = await call(route, 'DELETE', `/api/flow-studio/flows/${id}`)
  assert.equal(deleted.status, 200)
  // 撤销：按删除前手里的内容写回；磁盘上没文件，Host 按整份替换的 upsert 语义从 v1 重建。
  const restored = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, {
    name: '撤销链路',
    nodes: [],
    edges: [],
  })
  assert.equal(restored.status, 200)
  assert.equal(restored.json.flow.version, 1, '撤销重建必须回到 v1')
  // 再保存一次：重建后的 v1 要有自己的备份，且不能与删除前的证据互相覆盖。
  await call(route, 'PUT', `/api/flow-studio/flows/${id}`, { name: '撤销后再覆盖', nodes: [], edges: [] })
  const historyDir = join(dir, '.history')
  const active = readdirSync(historyDir).filter(name => name.startsWith(`${id}.v`) && name.endsWith('.json'))
  assert.deepEqual(active, [`${id}.v1.json`], '重建后的 v1 备份应当在活动历史里：' + active.join(','))
  const archived = readdirSync(join(historyDir, 'deleted'))
    .filter(name => name.startsWith(`${id}.v`) && name.endsWith('.json'))
  assert.equal(archived.length, 1, '删除前那份证据应当在 deleted/ 归档里：' + archived.join(','))
  const evidence = JSON.parse(readFileSync(join(historyDir, 'deleted', archived[0]), 'utf8'))
  assert.equal(evidence.name, '撤销链路')
  assert.equal(evidence.nodes.length, 2, '归档的必须是删除前的两个节点')
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

await check('§13.1 两档令牌 < 16 字符 → 启动即拒绝并告警（全权 / 只读同口径）', async () => {
  for (const envName of [AUTH_ENV, READ_AUTH_ENV]) {
    const warnings = []
    const strictCtx = makeCtx()
    strictCtx.logger.warn = message => warnings.push(message)
    process.env[envName] = 'too-short'
    try {
      assert.throws(() => apply(strictCtx), /至少 16 个字符/)
      assert.ok(warnings.some(message => message.includes('拒绝启动')), envName)
      assert.ok(warnings.some(message => message.includes(envName)), `${envName} 的告警要点名变量`)
    } finally {
      delete process.env[envName]
    }
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

await check('G6-a/PUT 非法流程：custom executor 默认保存即 400；其它违规仍 200 + validation.errors', async () => {
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

  // ① custom（缺 executorCommand）：G6-a ② 主机开关默认关 → 保存直接 400，
  // 且磁盘一个字节都不动（不是「报告后照样存」）。
  const blocked = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, base)
  assert.equal(blocked.status, 400, JSON.stringify(blocked.json))
  assert.equal(blocked.json.ok, false)
  assert.equal(blocked.json.code, 'CUSTOM_EXECUTOR_DISABLED')
  assert.match(blocked.json.error, /FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR/)
  assert.match(blocked.json.error, /executor/)
  const untouched = (await call(route, 'GET', `/api/flow-studio/flows/${id}`)).json.flow
  assert.equal(untouched.version, version, '被拒绝的保存不能推进版本')
  assert.ok(!untouched.nodes.some(node => node.executor === 'custom'), '磁盘上不能留下 custom 节点')

  // ② 非 custom 的 executor 违规（codex + team）仍然 200 + validation 报告（自动保存语义不变）。
  const codexTeam = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, {
    ...base,
    version,
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

  // ③ 主机开关打开后：custom 缺 executorCommand 仍能保存（自动保存），validation 报告这条 error。
  process.env.FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR = '1'
  try {
    const allowed = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, {
      ...base,
      version: codexTeam.json.flow.version,
    })
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json))
    assert.equal(allowed.json.validation.ok, false)
    assert.ok(allowed.json.validation.errors.some(item => /executorCommand/.test(item.message)),
      JSON.stringify(allowed.json.validation.errors))
  } finally {
    delete process.env.FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR
  }

  // warnings 不影响保存：合法流程照常 200。
  const currentVersion = (await call(route, 'GET', `/api/flow-studio/flows/${id}`)).json.flow.version
  const ok = await call(route, 'PUT', `/api/flow-studio/flows/${id}`, validFlowBody('门禁', {
    version: currentVersion,
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

await check('启动 run 前拦非法 executor（保存被 custom 开关拦下）：400 且不调 engine.start', async () => {
  const runsRoot = runstore.runsDir(home)
  // 直接写盘（模拟旧版本留下的非法流程），绕过保存门禁，验证启动侧仍然拦得住。
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
  // 保存侧：custom executor 现在也被主机开关拦下（G6-a ②）→ 400。
  const saved = await call(route, 'PUT', `/api/flow-studio/flows/${bad.id}`, {
    ...bad, version: bad.version,
  })
  assert.equal(saved.status, 400, JSON.stringify(saved.json))
  assert.equal(saved.json.code, 'CUSTOM_EXECUTOR_DISABLED')
  assert.match(saved.json.error, /FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR/)

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

console.log('G6-a · 最小权限（只读令牌 / custom executor / workspace 白名单 / health）')

/** 造一个「已绑定工作区 +（可选）worktree 记录」的 run，G6-b / G7 共用。 */
async function seedWorktreeRun(label, { record = true } = {}) {
  const runsRoot = runstore.runsDir(home)
  const workspace = makeWorkspace(label)
  const run = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 1 })
  const worktreePath = join(repoRoot, '.tmp', `wt-${label}-${run.id}`)
  const worktree = record
    ? {
        enabled: true,
        reason: 'git-workspace',
        decidedBy: 'initiator',
        path: worktreePath,
        branch: `flow/${run.id}`,
        baseCommit: 'abc1234',
        // worktree 模块新增字段：root（删除时的严格前缀依据）与 warnings（用户要看的告警）。
        root: join(repoRoot, '.tmp', 'worktrees-root'),
        warnings: ['工作区有 2 项未提交修改，不会带入 worktree'],
        createdAt: new Date().toISOString(),
      }
    : undefined
  await runstore.writeRunMeta(runsRoot, run.id, {
    workspace: { id: '0123456789ab', path: workspace, realpath: workspace, isGit: true, gitRoot: workspace },
    ...(worktree ? { worktree } : {}),
  })
  return { runsRoot, run, workspace, worktree, worktreePath }
}

/** 最小假引擎：createHandler 只要有 start / stop 就能跑路由（不做真执行）。 */
function fakeRuntimeEngine(calls) {
  const startCalls = calls || { start: [] }
  return {
    engineName: 'real',
    async start(runId, options) { startCalls.start.push({ runId, options }); return { id: runId, status: 'running' } },
    async stop() { return {} },
    supervision: { register() { return {} }, unregister() { return true }, status() { return {} } },
  }
}

await check('G6-a 只读令牌：GET 放行；POST / PUT / DELETE 一律 403（可读原因）', async () => {
  const fullToken = 'fs-full-token-0123456789abcdef'
  const readToken = 'fs-read-token-0123456789abcdef'
  // 阶段一：只配只读令牌 —— 没有全权令牌也绝不能退回「同源放行」。
  process.env[READ_AUTH_ENV] = readToken
  try {
    const readHeaders = { authorization: `Bearer ${readToken}` }
    const missing = await call(route, 'GET', '/api/flow-studio/flows')
    assert.equal(missing.status, 401, '配了只读令牌就必须带令牌')
    const listed = await call(route, 'GET', '/api/flow-studio/flows', undefined, readHeaders)
    assert.equal(listed.status, 200)
    const health = await call(route, 'GET', '/api/flow-studio/health', undefined, readHeaders)
    assert.equal(health.status, 200)
    assert.equal(health.json.auth, 'token')
    assert.equal(health.json.authMode, 'read')
    assert.equal(health.json.readOnly, true)
    assert.equal(health.json.capabilities.mode, 'read')
    assert.equal(health.json.capabilities.write, false)
    assert.equal(health.json.customExecutor, false)

    const readCreate = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('只读令牌不该建出来'), readHeaders)
    assert.equal(readCreate.status, 403)
    assert.equal(readCreate.json.ok, false)
    assert.equal(readCreate.json.code, 'READ_ONLY_TOKEN')
    assert.match(readCreate.json.error, /只读令牌/)
    assert.match(readCreate.json.error, /POST/)
    // 没令牌的写请求同样是 401（不是 200）。
    const anonymousWrite = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('匿名写'))
    assert.equal(anonymousWrite.status, 401)
  } finally {
    delete process.env[READ_AUTH_ENV]
  }

  // 阶段二：全权 + 只读同时配置 —— 写请求的口径由「出示了哪个令牌」决定。
  process.env[AUTH_ENV] = fullToken
  process.env[READ_AUTH_ENV] = readToken
  try {
    const readHeaders = { authorization: `Bearer ${readToken}` }
    const fullHeaders = { authorization: `Bearer ${fullToken}` }
    const fullHealth = await call(route, 'GET', '/api/flow-studio/health', undefined, fullHeaders)
    assert.equal(fullHealth.json.authMode, 'full')
    assert.equal(fullHealth.json.readOnly, false)

    const before = (await call(route, 'GET', '/api/flow-studio/flows?limit=100', undefined, fullHeaders)).json.flows.length
    for (const [method, url, payload] of [
      ['POST', '/api/flow-studio/flows', validFlowBody('只读令牌不该建出来')],
      ['PUT', '/api/flow-studio/flows/flow-readonly-probe', validFlowBody('只读令牌不该改')],
      ['DELETE', '/api/flow-studio/flows/flow-readonly-probe', undefined],
      ['POST', '/api/flow-studio/runs', { flowId: 'flow-a', workspace: makeWorkspace('readonly') }],
      ['POST', '/api/flow-studio/worktrees/prune', {}],
    ]) {
      const rejected = await call(route, method, url, payload, readHeaders)
      assert.equal(rejected.status, 403, `${method} ${url}`)
      assert.equal(rejected.json.code, 'READ_ONLY_TOKEN')
      assert.match(rejected.json.error, /只读令牌/)
      // 写请求没有产生任何副作用（列表条数不变）。
      const now = (await call(route, 'GET', '/api/flow-studio/flows?limit=100', undefined, fullHeaders)).json.flows.length
      assert.equal(now, before, `${method} ${url} 不能写成功`)
    }

    // 全权令牌照旧放行写请求。
    const created = await call(route, 'POST', '/api/flow-studio/flows', validFlowBody('全权令牌写'), fullHeaders)
    assert.equal(created.status, 200)
    const after = (await call(route, 'GET', '/api/flow-studio/flows?limit=100', undefined, fullHeaders)).json.flows.length
    assert.equal(after, before + 1)
    // 只读令牌的 GET 仍然 200。
    const readList = await call(route, 'GET', '/api/flow-studio/flows', undefined, readHeaders)
    assert.equal(readList.status, 200)
  } finally {
    delete process.env[AUTH_ENV]
    delete process.env[READ_AUTH_ENV]
  }
})

await check('G6-a custom executor 默认被拒（保存 400 / 启动 400），主机开关打开后才放行', async () => {
  const runsRoot = runstore.runsDir(home)
  const customFlowBody = {
    name: 'custom 流程',
    nodes: [
      { id: 'a', kind: 'start', title: '开始', x: 0, y: 0, task: 't' },
      {
        id: 'b', kind: 'stage', title: '自定义执行', x: 200, y: 0, task: '做',
        mode: 'single', executor: 'custom', executorCommand: 'echo hi',
      },
      { id: 'c', kind: 'end', title: '完成', x: 400, y: 0, task: 't' },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', kind: 'next' },
      { id: 'e2', from: 'b', to: 'c', kind: 'next' },
    ],
  }

  // ① 保存：默认被拒（不能只在前端拦；HTTP 调用方可以绕过画布直接 POST）。
  const blockedSave = await call(route, 'POST', '/api/flow-studio/flows', customFlowBody)
  assert.equal(blockedSave.status, 400, JSON.stringify(blockedSave.json))
  assert.equal(blockedSave.json.ok, false)
  assert.equal(blockedSave.json.code, 'CUSTOM_EXECUTOR_DISABLED')
  assert.match(blockedSave.json.error, /FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR/)
  assert.match(blockedSave.json.error, /宿主 RCE/)
  const unpersisted = (await call(route, 'GET', '/api/flow-studio/flows?limit=100')).json.flows
  assert.ok(!unpersisted.some(item => item.name === 'custom 流程'), '被拒绝的保存不能落盘')

  // ② 直接写盘（模拟旧数据），启动同样被拒，且不调 engine.start。
  const saved = await store.saveFlow(store.flowsDir(home), 'flow-custom-gate', customFlowBody)
  const calls = { start: [] }
  const injected = {
    handler: createHandler({
      dir: store.flowsDir(home), runsRoot, ctx, startOptions: new Map(), engine: fakeRuntimeEngine(calls),
    }),
  }
  const run = (await call(injected, 'POST', '/api/flow-studio/runs', {
    flowId: saved.id, name: 'custom 启动', workspace: makeWorkspace('custom-gate'),
  })).json.run
  const blockedStart = await call(injected, 'POST', `/api/flow-studio/runs/${run.id}/start`)
  assert.equal(blockedStart.status, 400, JSON.stringify(blockedStart.json))
  assert.equal(blockedStart.json.code, 'CUSTOM_EXECUTOR_DISABLED')
  assert.match(blockedStart.json.error, /FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR/)
  assert.equal(calls.start.length, 0, '被开关拦下的流程绝不能进 engine.start')
  assert.equal((await runstore.readRunMeta(runsRoot, run.id)).status, 'pending')

  // ③ 主机开关打开：保存 200、启动 202，/health 如实报 customExecutor=true。
  process.env[CUSTOM_EXECUTOR_ENV] = '1'
  try {
    const health = await call(route, 'GET', '/api/flow-studio/health')
    assert.equal(health.json.customExecutor, true)
    assert.equal(health.json.capabilities.customExecutor, true)
    const allowedSave = await call(route, 'POST', '/api/flow-studio/flows', customFlowBody)
    assert.equal(allowedSave.status, 200, JSON.stringify(allowedSave.json))
    const allowedStart = await call(injected, 'POST', `/api/flow-studio/runs/${run.id}/start`)
    assert.equal(allowedStart.status, 202, JSON.stringify(allowedStart.json))
    assert.equal(calls.start.length, 1)
  } finally {
    delete process.env[CUSTOM_EXECUTOR_ENV]
  }
})

await check('G6-a workspace 白名单：配置后越界创建 / 启动 → 400；根内放行；不配置维持现状', async () => {
  const flow = (await call(route, 'GET', '/api/flow-studio/flows?limit=1')).json.flows[0]
  const allowed = makeWorkspace('allow-root')
  const outside = makeWorkspace('outside-root')
  const nested = join(allowed, 'nested')
  mkdirSync(nested, { recursive: true })

  process.env[WORKSPACE_ROOTS_ENV] = `${allowed}:${join(repoRoot, '.tmp', 'no-such-root')}`
  try {
    const rejected = await call(route, 'POST', '/api/flow-studio/runs', { flowId: flow.id, workspace: outside })
    assert.equal(rejected.status, 400, JSON.stringify(rejected.json))
    assert.equal(rejected.json.code, 'workspace')
    assert.equal(rejected.json.field, 'workspace')
    assert.match(rejected.json.error, /允许的根目录/)

    // 根自己 / 根内子目录都放行。
    for (const workspacePath of [allowed, nested]) {
      const ok = await call(route, 'POST', '/api/flow-studio/runs', { flowId: flow.id, workspace: workspacePath })
      assert.equal(ok.status, 200, `${workspacePath}: ${JSON.stringify(ok.json)}`)
    }

    // 启动路径同样拦：造一个未绑定工作区的 run，再拿越界 workspace 启动。
    const run = await runstore.createRun(runstore.runsDir(home), {
      flowId: 'flow-a', flowName: 'A', nodeTotal: 0,
    })
    const startRejected = await call(route, 'POST', `/api/flow-studio/runs/${run.id}/start`, { workspace: outside })
    assert.equal(startRejected.status, 400, JSON.stringify(startRejected.json))
    assert.equal(startRejected.json.code, 'workspace')
    assert.match(startRejected.json.error, /允许的根目录/)

    // /health 只报「配置了几个根」，不把绝对路径泄露给 LAN。
    const health = await call(route, 'GET', '/api/flow-studio/health')
    assert.deepEqual(health.json.capabilities.workspaceAllowlist, { configured: true, count: 2 })
    assert.ok(!health.body.includes(allowed), 'health 不能泄露白名单绝对路径')
  } finally {
    delete process.env[WORKSPACE_ROOTS_ENV]
  }

  // 不配置 = 维持现状（越界 workspace 照常 200，不打断现有部署）。
  const after = await call(route, 'POST', '/api/flow-studio/runs', { flowId: flow.id, workspace: outside })
  assert.equal(after.status, 200, JSON.stringify(after.json))
})

await check('G6-a /health 反映能力：authMode / readOnly / customExecutor / workspaceAllowlist / 默认时限', async () => {
  const plain = await call(route, 'GET', '/api/flow-studio/health')
  assert.equal(plain.status, 200)
  assert.equal(plain.json.auth, 'connection', '未配置 token 时旧字段保持 connection')
  assert.equal(plain.json.authMode, 'connection')
  assert.equal(plain.json.readOnly, false)
  assert.equal(plain.json.customExecutor, false)
  assert.equal(plain.json.capabilities.write, true)
  assert.deepEqual(plain.json.capabilities.workspaceAllowlist, { configured: false, count: 0 })
  assert.equal(plain.json.limits.defaultRunTimeoutMs, 2 * 60 * 60 * 1000)
  assert.equal(plain.json.limits.defaultNodeTimeoutMs, 20 * 60 * 1000)

  process.env[CUSTOM_EXECUTOR_ENV] = '1'
  process.env[WORKSPACE_ROOTS_ENV] = repoRoot
  try {
    const on = await call(route, 'GET', '/api/flow-studio/health')
    assert.equal(on.json.customExecutor, true)
    assert.deepEqual(on.json.capabilities.workspaceAllowlist, { configured: true, count: 1 })
  } finally {
    delete process.env[CUSTOM_EXECUTOR_ENV]
    delete process.env[WORKSPACE_ROOTS_ENV]
  }
})

console.log('G6-b · worktree 生命周期入口')

await check('G6-b GET /runs/<id> 带 worktreeStatus（inspectWorktree 桩；失败 → unknown）', async () => {
  const { runsRoot, run, workspace, worktree } = await seedWorktreeRun('wt-status')
  const inspected = []
  const stub = {
    async inspectWorktree(input) {
      inspected.push(input)
      return { exists: true, dirty: true, head: 'deadbeef' }
    },
  }
  const injected = {
    handler: createHandler({
      dir: store.flowsDir(home), runsRoot, ctx, startOptions: new Map(),
      engine: fakeRuntimeEngine(), worktree: stub,
    }),
  }
  const detail = await call(injected, 'GET', `/api/flow-studio/runs/${run.id}`)
  assert.equal(detail.status, 200)
  assert.deepEqual(detail.json.worktreeStatus, {
    enabled: true, exists: true, dirty: true, head: 'deadbeef',
  })
  assert.equal(inspected.length, 1)
  assert.equal(inspected[0].record.path, worktree.path)
  assert.equal(inspected[0].workspace.realpath, workspace)
  // GET /runs/<id> 的 run.worktree 要带上模块新增的 root / warnings（前端展示原因与告警）。
  assert.equal(detail.json.run.worktree.root, join(repoRoot, '.tmp', 'worktrees-root'))
  assert.deepEqual(detail.json.run.worktree.warnings, ['工作区有 2 项未提交修改，不会带入 worktree'])

  // inspectWorktree 抛错 / 返回非法 → {unknown:true, reason}，不假装「目录不存在」。
  const broken = {
    handler: createHandler({
      dir: store.flowsDir(home), runsRoot, ctx, startOptions: new Map(),
      engine: fakeRuntimeEngine(),
      worktree: { async inspectWorktree() { throw new Error('git 不可用') } },
    }),
  }
  const failed = await call(broken, 'GET', `/api/flow-studio/runs/${run.id}`)
  assert.equal(failed.status, 200)
  assert.equal(failed.json.worktreeStatus.unknown, true)
  assert.match(failed.json.worktreeStatus.reason, /git 不可用/)

  // 没有 worktree 记录的 run：unknown + 可读 reason（真实模块路径）。
  const { run: bare } = await seedWorktreeRun('wt-bare', { record: false })
  const bareDetail = await call(route, 'GET', `/api/flow-studio/runs/${bare.id}`)
  assert.equal(bareDetail.status, 200)
  assert.equal(bareDetail.json.worktreeStatus.unknown, true)
  assert.equal(bareDetail.json.worktreeStatus.reason, 'no-worktree-record')
})

await check('G6-b DELETE /runs/<id>/worktree：调 removeWorktree 返回 {ok, removed, reason}；404 / 租约 409 / 无记录给可读原因', async () => {
  const { runsRoot, run, worktree } = await seedWorktreeRun('wt-delete')
  const calls = []
  const stub = {
    async removeWorktree(input) {
      calls.push(input)
      return { removed: true, reason: 'removed', path: input.record.path }
    },
  }
  const injected = {
    handler: createHandler({
      dir: store.flowsDir(home), runsRoot, ctx, startOptions: new Map(),
      engine: fakeRuntimeEngine(), worktree: stub,
    }),
  }
  const removed = await call(injected, 'DELETE', `/api/flow-studio/runs/${run.id}/worktree`)
  assert.equal(removed.status, 200, JSON.stringify(removed.json))
  assert.equal(removed.json.ok, true)
  assert.equal(removed.json.removed, true)
  assert.equal(removed.json.reason, 'removed')
  assert.equal(removed.json.branch, worktree.branch)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].record.path, worktree.path)
  assert.equal(calls[0].root, join(dirname(runsRoot), 'worktrees'), '显式传 worktrees 根做前缀校验')
  assert.equal(calls[0].force, true, '路由语义是「明确删除」→ 必须 force:true（脏 / 被 lock 也删）')
  assert.equal(calls[0].workspace.id, '0123456789ab', '传 run.json.workspace')

  // run 不存在 → 404。
  const missing = await call(injected, 'DELETE', '/api/flow-studio/runs/r-does-not-exist/worktree')
  assert.equal(missing.status, 404)
  assert.match(missing.json.error, /run 不存在/)

  // 没有 worktree 记录 → 200 + removed:false + 可读原因（不是静默成功）。
  const { run: bare } = await seedWorktreeRun('wt-delete-bare', { record: false })
  const noRecord = await call(injected, 'DELETE', `/api/flow-studio/runs/${bare.id}/worktree`)
  assert.equal(noRecord.status, 200)
  assert.equal(noRecord.json.ok, true)
  assert.equal(noRecord.json.removed, false)
  assert.equal(noRecord.json.reason, 'no-worktree')
  assert.match(noRecord.json.error, /没有可删除的 worktree 记录/)

  // 持租约（正在跑）→ 409 + 可读原因，不调 removeWorktree。
  const { run: leased } = await seedWorktreeRun('wt-delete-lease')
  await runstore.claimLease(runsRoot, leased.id, { pid: 4242, host: 'probe-host', ttlMs: 60_000 })
  try {
    const blocked = await call(injected, 'DELETE', `/api/flow-studio/runs/${leased.id}/worktree`)
    assert.equal(blocked.status, 409)
    assert.match(blocked.json.error, /租约/)
    assert.equal(calls.length, 1, '运行中的 run 不能删 worktree')
  } finally {
    await runstore.releaseLease(runsRoot, leased.id, { pid: 4242, host: 'probe-host' })
  }

  // 模块没有 removeWorktree 导出 → 501（不假装删过）。
  const unsupported = {
    handler: createHandler({
      dir: store.flowsDir(home), runsRoot, ctx, startOptions: new Map(),
      engine: fakeRuntimeEngine(), worktree: {},
    }),
  }
  const notImplemented = await call(unsupported, 'DELETE', `/api/flow-studio/runs/${run.id}/worktree`)
  assert.equal(notImplemented.status, 501)
  assert.match(notImplemented.json.error, /removeWorktree/)
})

await check('G6-b DELETE /runs/<id>/worktree：目录已被手工删过（not-found）时补一刀清分支', async () => {
  // 审计点名的「只增不减」最后一条尾巴：目录没了、flow/<runId> 分支还在。
  // 路由在 removeWorktree 返回 not-found 时会再调 removeRunBranch，且分支清理失败不影响删除结论。
  const { runsRoot, run, worktree } = await seedWorktreeRun('wt-delete-gone')
  const branchCalls = []
  const stub = {
    async removeWorktree() {
      return { removed: false, reason: 'not-found' }
    },
    async removeRunBranch(input) {
      branchCalls.push(input)
      return { removed: true, branch: input.branch, warning: null }
    },
  }
  const injected = {
    handler: createHandler({
      dir: store.flowsDir(home), runsRoot, ctx, startOptions: new Map(),
      engine: fakeRuntimeEngine(), worktree: stub,
    }),
  }
  const response = await call(injected, 'DELETE', `/api/flow-studio/runs/${run.id}/worktree`)
  assert.equal(response.status, 200, JSON.stringify(response.json))
  assert.equal(response.json.removed, false)
  assert.equal(response.json.reason, 'not-found')
  assert.equal(response.json.branchRemoved, true, '目录已不在时必须补删分支')
  assert.equal(branchCalls.length, 1)
  assert.equal(branchCalls[0].branch, worktree.branch)
  assert.equal(branchCalls[0].workspace.id, '0123456789ab', '传 run.json.workspace（{path} 形状也可）')

  // 分支删不掉（非 flow/ 前缀 / 主仓库已删）→ 只给 warning，不让接口失败。
  const warningStub = {
    async removeWorktree() {
      return { removed: false, reason: 'not-found' }
    },
    async removeRunBranch(input) {
      return { removed: false, branch: input.branch, warning: '分支 flow/x 不存在，未删除' }
    },
  }
  const withWarning = {
    handler: createHandler({
      dir: store.flowsDir(home), runsRoot: join(home, 'runs-wt-warning'), ctx, startOptions: new Map(),
      engine: fakeRuntimeEngine(), worktree: warningStub,
    }),
  }
  const runsRoot2 = join(home, 'runs-wt-warning')
  const seeded = await runstore.createRun(runsRoot2, { flowId: 'flow-w', flowName: 'W', nodeTotal: 1 })
  await runstore.writeRunMeta(runsRoot2, seeded.id, {
    workspace: { id: '0123456789ab', path: '/repo', realpath: '/repo', isGit: true, gitRoot: '/repo' },
    worktree: { enabled: true, reason: 'git-workspace', decidedBy: 'initiator', path: '/wt/w', branch: 'flow/w', root: join(home, 'worktrees') },
  })
  const warned = await call(withWarning, 'DELETE', `/api/flow-studio/runs/${seeded.id}/worktree`)
  assert.equal(warned.status, 200)
  assert.equal(warned.json.removed, false)
  assert.equal(warned.json.branchRemoved, false)
  assert.match(String(warned.json.branchWarning || ''), /不存在/)
})

await check('G6-b GET /worktrees 与 POST /worktrees/prune（listWorktrees / pruneWorktrees 桩）', async () => {
  const runsRoot = runstore.runsDir(home)
  const existing = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 1 })
  const listCalls = []
  const pruneCalls = []
  const stub = {
    async listWorktrees(input) {
      listCalls.push(input)
      return [
        {
          path: `/wt/${existing.id}`, workspaceId: '0123456789ab', runId: existing.id,
          exists: true, dirty: false, head: 'aaa111', registered: true,
        },
        {
          path: '/wt/r-orphan-probe', workspaceId: '0123456789ab', runId: 'r-orphan-probe',
          exists: false, dirty: null, head: null, registered: false,
        },
      ]
    },
    async pruneWorktrees(input) {
      pruneCalls.push(input)
      return {
        removed: [{ path: '/wt/r-orphan-probe', workspaceId: '0123456789ab', runId: 'r-orphan-probe' }],
        skipped: [{ path: '/wt/r-keep', reason: 'remove-failed' }],
      }
    },
  }
  const injected = {
    handler: createHandler({
      dir: store.flowsDir(home), runsRoot, ctx, startOptions: new Map(),
      engine: fakeRuntimeEngine(), worktree: stub,
    }),
  }

  const listed = await call(injected, 'GET', '/api/flow-studio/worktrees')
  assert.equal(listed.status, 200, JSON.stringify(listed.json))
  assert.equal(listed.json.ok, true)
  assert.equal(listed.json.available, true)
  assert.equal(listed.json.worktrees.length, 2)
  assert.equal(listed.json.worktrees.find(row => row.runId === existing.id).orphan, false)
  assert.equal(listed.json.worktrees.find(row => row.runId === 'r-orphan-probe').orphan, true)
  assert.deepEqual(listed.json.orphans.map(row => row.runId), ['r-orphan-probe'])
  assert.equal(listCalls.length, 1)
  assert.equal(listCalls[0].root, join(dirname(runsRoot), 'worktrees'))

  const pruned = await call(injected, 'POST', '/api/flow-studio/worktrees/prune', {
    keepRunIds: ['r-manual-keep'],
  })
  assert.equal(pruned.status, 200, JSON.stringify(pruned.json))
  assert.equal(pruned.json.ok, true)
  assert.deepEqual(pruned.json.removed.map(item => item.path), ['/wt/r-orphan-probe'])
  assert.equal(pruned.json.skipped.length, 1)
  assert.equal(pruneCalls.length, 1)
  assert.equal(pruneCalls[0].root, join(dirname(runsRoot), 'worktrees'))
  assert.ok(pruneCalls[0].keepRunIds.includes(existing.id), '现有 run 必须自动保留')
  assert.ok(pruneCalls[0].keepRunIds.includes('r-manual-keep'), '额外 keepRunIds 要透传')
  assert.equal(pruned.json.keepRunIds, pruneCalls[0].keepRunIds.length)

  // 非法 keepRunIds → 400（可读），不调 pruneWorktrees。
  const bad = await call(injected, 'POST', '/api/flow-studio/worktrees/prune', { keepRunIds: ['../etc/passwd'] })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.field, 'keepRunIds')
  assert.equal(pruneCalls.length, 1)
})

await check('G6-b DELETE /runs/<id> 保留 worktree 指针进孤儿清单，并在响应提示单独清理', async () => {
  const { runsRoot, run, worktree, worktreePath } = await seedWorktreeRun('wt-orphan')
  const deleted = await call(route, 'DELETE', `/api/flow-studio/runs/${run.id}`)
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json))
  assert.equal(deleted.json.ok, true)
  assert.equal(deleted.json.worktree.path, worktreePath)
  assert.equal(deleted.json.worktree.branch, worktree.branch)
  assert.equal(deleted.json.worktree.workspaceId, '0123456789ab')
  assert.equal(deleted.json.worktree.orphaned, true)
  assert.match(deleted.json.hint, /单独清理/)
  assert.match(deleted.json.hint, /worktrees\/prune/)
  assert.ok(!existsSync(join(runsRoot, run.id)), 'run 目录照常删除')

  // 孤儿指针可查询（即使 listWorktrees 还没落地，recorded 也必须在）。
  const listed = await call(route, 'GET', '/api/flow-studio/worktrees')
  assert.equal(listed.status, 200)
  assert.equal(typeof listed.json.available, 'boolean')
  if (listed.json.available === false) {
    assert.match(listed.json.reason, /listWorktrees|尚未落地/)
  }
  const recorded = listed.json.recorded.find(item => item.runId === run.id)
  assert.ok(recorded, 'worktree 指针不能跟着 run 目录一起消失')
  assert.equal(recorded.path, worktreePath)
  assert.equal(recorded.branch, worktree.branch)
  assert.equal(recorded.workspaceId, '0123456789ab')

  // 真实模块已导出 pruneWorktrees：prune 路由能跑通；这个孤儿目录本来就不存在，
  // 清理后 recorded 指针同步移除（不再需要人工清理）。
  const pruned = await call(route, 'POST', '/api/flow-studio/worktrees/prune', {})
  assert.equal(pruned.status, 200, JSON.stringify(pruned.json))
  assert.ok(Array.isArray(pruned.json.removed))
  assert.ok(Array.isArray(pruned.json.skipped))
  assert.deepEqual(pruned.json.recorded.map(item => item.runId), [])

  // 没有 worktree 的 run：不写孤儿、不提示。
  const { run: bare } = await seedWorktreeRun('wt-orphan-bare', { record: false })
  const plain = await call(route, 'DELETE', `/api/flow-studio/runs/${bare.id}`)
  assert.equal(plain.status, 200)
  assert.equal(plain.json.worktree, undefined)
  assert.equal(plain.json.hint, undefined)
})

console.log('G6-c · runTimeoutMs / nodeTimeoutMs 透传')

await check('G6-c POST /runs/<id>/start 接受 runTimeoutMs / nodeTimeoutMs 并透传；非法值 400', async () => {
  const runsRoot = runstore.runsDir(home)
  // 用一份「开始 → 阶段 → 完成」的合法流程（默认 dsh executor；不能借用上面刚建的 custom 流程）。
  const flow = await store.saveFlow(store.flowsDir(home), 'flow-timeout-probe', {
    name: '超时透传',
    nodes: [
      { id: 'a', kind: 'start', title: '开始', x: 0, y: 0, task: 't' },
      { id: 'b', kind: 'stage', title: '阶段', x: 200, y: 0, task: '做', mode: 'single' },
      { id: 'c', kind: 'end', title: '完成', x: 400, y: 0, task: '' },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', kind: 'next' },
      { id: 'e2', from: 'b', to: 'c', kind: 'next' },
    ],
  })
  const calls = { start: [] }
  const injected = {
    handler: createHandler({
      dir: store.flowsDir(home), runsRoot, ctx, startOptions: new Map(),
      engine: fakeRuntimeEngine(calls),
    }),
  }
  const workspace = makeWorkspace('timeouts')
  const run = await runstore.createRun(runsRoot, { flowId: flow.id, flowName: flow.name, nodeTotal: 1 })
  const started = await call(injected, 'POST', `/api/flow-studio/runs/${run.id}/start`, {
    workspace,
    runTimeoutMs: 6 * 60 * 60 * 1000,
    nodeTimeoutMs: 30 * 60 * 1000,
  })
  assert.equal(started.status, 202, JSON.stringify(started.json))
  assert.equal(calls.start.length, 1)
  assert.deepEqual(calls.start[0].options, {
    workspace,
    runTimeoutMs: 6 * 60 * 60 * 1000,
    nodeTimeoutMs: 30 * 60 * 1000,
  })

  // 非法值：一律 400（可读原因），不调 engine.start，run 保持 pending。
  const rejectedRun = await runstore.createRun(runsRoot, { flowId: flow.id, flowName: flow.name, nodeTotal: 1 })
  const cases = [
    ['runTimeoutMs', 0],
    ['runTimeoutMs', -5],
    ['runTimeoutMs', 1.5],
    ['runTimeoutMs', '60000'],
    ['runTimeoutMs', MAX_TIMEOUT_MS + 1],
    ['nodeTimeoutMs', true],
  ]
  for (const [field, value] of cases) {
    const rejected = await call(injected, 'POST', `/api/flow-studio/runs/${rejectedRun.id}/start`, {
      workspace, [field]: value,
    })
    assert.equal(rejected.status, 400, `${field}=${String(value)}`)
    assert.equal(rejected.json.ok, false)
    assert.equal(rejected.json.field, field)
    assert.match(rejected.json.error, /正整数|上限/)
    assert.equal(calls.start.length, 1, `${field}=${String(value)} 不能进 engine.start`)
    assert.equal((await runstore.readRunMeta(runsRoot, rejectedRun.id)).status, 'pending')
  }
})

console.log('G7 · GET /runs/<id>?light=1（只读 run.json，不解析事件）')

await check('G7 light=1 不读事件文件：run.jsonl 不可读时仍 200，完整接口 500；字段集与老接口不变', async () => {
  const runsRoot = runstore.runsDir(home)
  const { run, worktreePath } = await seedWorktreeRun('light')
  const runDir = join(runsRoot, run.id)
  // 先造一条真实事件（run.jsonl），再把 run.jsonl 换成目录：
  // 任何事件读取都会 EISDIR 抛错 —— 这正是「light 有没有偷偷读事件」的探针。
  writeFileSync(join(runDir, 'run.jsonl'), `${JSON.stringify({
    v: 1,
    ts: '2026-11-06T00:00:00.000Z',
    kind: 'message/in',
    traceId: 'probe',
    data: { text: 'hi' },
  })}\n`)
  await runstore.writeRunMeta(runsRoot, run.id, {
    status: 'running',
    started: true,
    startedAt: '2026-11-06T00:00:00.000Z',
    eventCount: 1,
    live: {
      currentNodeId: 'n_a',
      nodeTitle: '阶段 A',
      nodeMode: 'single',
      attempt: 1,
      round: 1,
      since: '2026-11-06T00:00:00.000Z',
      lastEventSeq: 1,
      phase: 'model',
    },
    nodeStatus: {
      n_a: { state: 'working', progress: 30, summary: '正在做', verdict: null, at: '2026-11-06T00:00:00.000Z' },
    },
    sessionMode: 'top-level',
    supervision: { enabled: true, wakerSessionId: 'session-light', wakes: 1 },
  })
  rmSync(join(runDir, 'run.jsonl'), { force: true })
  mkdirSync(join(runDir, 'run.jsonl'))

  const light = await call(route, 'GET', `/api/flow-studio/runs/${run.id}?light=1`)
  assert.equal(light.status, 200, JSON.stringify(light.json))
  assert.equal(light.json.ok, true)
  const lightRun = light.json.run
  const requiredFields = [
    'id', 'flowId', 'flowName', 'name', 'status', 'started', 'startedAt', 'endedAt',
    'nodeDone', 'nodeTotal', 'tokenTotal', 'engine', 'live', 'nodeStatus', 'workspace',
    'worktree', 'sessionMode', 'supervision',
  ]
  for (const field of requiredFields) {
    assert.ok(Object.hasOwn(lightRun, field), `light run 缺少字段 ${field}`)
  }
  // 不返回 nodes / events，也不返回完整接口的 nodes / eventCount 顶层字段。
  assert.equal(Object.hasOwn(lightRun, 'nodes'), false)
  assert.equal(Object.hasOwn(lightRun, 'events'), false)
  assert.equal(Object.hasOwn(light.json, 'nodes'), false)
  // live 原样来自 run.json。
  assert.equal(lightRun.live.currentNodeId, 'n_a')
  assert.equal(lightRun.live.phase, 'model')
  // nodeStatus / workspace / worktree 都在。
  assert.equal(lightRun.nodeStatus.n_a.state, 'working')
  assert.equal(lightRun.workspace.realpath, lightRun.workspace.path)
  assert.deepEqual(lightRun.worktree, {
    enabled: true,
    reason: 'git-workspace',
    path: worktreePath,
    branch: `flow/${run.id}`,
    // worktree 模块新增字段：前端要展示「为什么需要单独清理 / 有哪些告警」。
    root: join(repoRoot, '.tmp', 'worktrees-root'),
    baseCommit: 'abc1234',
    warnings: ['工作区有 2 项未提交修改，不会带入 worktree'],
  })
  assert.equal(lightRun.sessionMode, 'top-level')
  assert.equal(lightRun.supervision.enabled, true)
  // eventCount 来自 run.json 计数器（不解析事件）。
  assert.equal(lightRun.eventCount, 1)

  // 空仓库：worktree.baseCommit 可能是 null —— light 必须容忍（不做 40 位 hex 校验）。
  const { run: emptyRepoRun, worktree: emptyRepoWorktree } = await seedWorktreeRun('light-empty-repo')
  await runstore.writeRunMeta(runsRoot, emptyRepoRun.id, {
    worktree: { ...emptyRepoWorktree, baseCommit: null },
  })
  const emptyLight = await call(route, 'GET', `/api/flow-studio/runs/${emptyRepoRun.id}?light=1`)
  assert.equal(emptyLight.status, 200)
  assert.equal(emptyLight.json.run.worktree.baseCommit, null)

  // 完整接口要读事件 → run.jsonl 是目录 → 500（证明 light 确实绕开了事件读取）。
  const full = await call(route, 'GET', `/api/flow-studio/runs/${run.id}`)
  assert.equal(full.status, 500)

  // 恢复后老接口行为不变（nodes 照旧返回）。
  rmSync(join(runDir, 'run.jsonl'), { recursive: true, force: true })
  writeFileSync(join(runDir, 'run.jsonl'), `${JSON.stringify({
    v: 1,
    ts: '2026-11-06T00:00:00.000Z',
    kind: 'message/in',
    traceId: 'probe',
    data: { text: 'hi' },
  })}\n`)
  const fullOk = await call(route, 'GET', `/api/flow-studio/runs/${run.id}`)
  assert.equal(fullOk.status, 200)
  assert.ok(Array.isArray(fullOk.json.nodes), '老接口仍然返回 nodes')

  // 不存在的 run → 404（light 同样）。
  const missing = await call(route, 'GET', '/api/flow-studio/runs/r-nope-404?light=1')
  assert.equal(missing.status, 404)
})

console.log('G7 · GET /runs/<id> 详情字段（sessions / agentPreset / restart）与 light 字段集')

await check('详情带 sessions / agentPreset / restart；light=1 明确不含这三个字段', async () => {
  const runsRoot = runstore.runsDir(home)
  const run = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 2 })
  const oldRun = await runstore.createRun(runsRoot, { flowId: 'flow-a', flowName: 'A', nodeTotal: 2 })
  await runstore.writeRunMeta(runsRoot, run.id, {
    sessions: { n_a: 's-1', n_b: 's-2' },
    agentPreset: { value: 'standard', source: 'default' },
    restart: {
      fromRunId: oldRun.id,
      attempt: 1,
      startNodeId: 'n_b',
      skippedNodeIds: ['n_a'],
      inheritedNodeIds: ['n_a', 'n_b'],
    },
  })

  // 客户端详情（非 light）必须原样透传 run.json 的白名单字段。
  const detail = await call(route, 'GET', `/api/flow-studio/runs/${run.id}`)
  assert.equal(detail.status, 200, JSON.stringify(detail.json))
  assert.deepEqual(detail.json.run.sessions, { n_a: 's-1', n_b: 's-2' })
  assert.deepEqual(detail.json.run.agentPreset, { value: 'standard', source: 'default' })
  assert.equal(detail.json.run.restart.fromRunId, oldRun.id)
  assert.equal(detail.json.run.restart.startNodeId, 'n_b')
  assert.deepEqual(detail.json.run.restart.skippedNodeIds, ['n_a'])
  assert.deepEqual(detail.json.run.restart.inheritedNodeIds, ['n_a', 'n_b'])

  // light=1 是固定字段集：不返回 sessions / agentPreset / restart（客户端走非 light 取详情）。
  const light = await call(route, 'GET', `/api/flow-studio/runs/${run.id}?light=1`)
  assert.equal(light.status, 200)
  for (const field of ['sessions', 'agentPreset', 'restart']) {
    assert.equal(Object.hasOwn(light.json.run, field), false, `light 不得返回 ${field}`)
  }
  assert.equal(light.json.run.nodeTotal, 2, 'light 仍返回固定字段集里的计数')
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

// ---------------------------------------------------------------------------
// 0.11 · R2/S1：并发配额 429 映射（HTTP payload / Retry-After / 详情 admission）
// ---------------------------------------------------------------------------
await check('R2：启动被配额拒绝 → 429 结构化 payload + Retry-After，run 仍 pending，详情带 admission', async () => {
  const runsRoot = runstore.runsDir(home)
  const flows = (await call(route, 'GET', '/api/flow-studio/flows')).json.flows
  const flow = flows[0]
  const run = await runstore.createRun(runsRoot, { flowId: flow.id, flowName: flow.name, nodeTotal: 1 })
  const error = new Error('并发配额已满（global-full）：活动 4 / 上限 4')
  Object.assign(error, {
    status: 429,
    code: 'RUN_CONCURRENCY_LIMIT',
    scope: 'global',
    reason: 'global-full',
    active: 4,
    max: 4,
    retryAfterMs: 30000,
    limits: { global: 4, perWorkspace: 2 },
  })
  const fakeEngine = {
    engineName: 'real',
    async start() { throw error },
    async stop() { return {} },
    admissionOf(id) {
      return id === run.id
        ? { state: 'queued', queuedAt: '2026-11-07T00:00:00.000Z', position: 1, timeoutMs: 15000 }
        : null
    },
    supervision: {
      register() { return { enabled: true } },
      unregister() { return true },
      status() { return { enabled: true, nextDueAt: null, wakes: 0, failures: 0, lastReason: null } },
    },
  }
  const handler = { handler: createHandler({
    dir: store.flowsDir(home), runsRoot, ctx, engine: fakeEngine, startOptions: new Map(),
  }) }
  const started = await call(handler, 'POST', `/api/flow-studio/runs/${run.id}/start`, {
    workspace: makeWorkspace('quota'),
  })
  assert.equal(started.status, 429, JSON.stringify(started.json))
  assert.equal(started.json.code, 'RUN_CONCURRENCY_LIMIT')
  assert.equal(started.json.scope, 'global')
  assert.equal(started.json.reason, 'global-full')
  assert.equal(started.json.active, 4)
  assert.equal(started.json.max, 4)
  assert.equal(started.json.retryAfterMs, 30000)
  assert.deepEqual(started.json.limits, { global: 4, perWorkspace: 2 })
  assert.equal(started.headers['retry-after'], '30', '必须带 Retry-After')
  assert.equal((await runstore.readRunMeta(runsRoot, run.id)).status, 'pending', '排队/拒绝不能把 run 写成 running')
  const detail = await call(handler, 'GET', `/api/flow-studio/runs/${run.id}`)
  assert.deepEqual(detail.json.run.admission, {
    state: 'queued', queuedAt: '2026-11-07T00:00:00.000Z', position: 1, timeoutMs: 15000,
  }, '详情动态合并 admission，run.json 仍 pending')
})

// ---------------------------------------------------------------------------
// 0.11 · R4/S3：外部 POST /events 强制盖 external/unverified，不能伪造质量结论
// ---------------------------------------------------------------------------
await check('R4/S3：外部假 pass 被标 external/unverified，质量 headline 不变', async () => {
  const runsRoot = runstore.runsDir(home)
  const flows = (await call(route, 'GET', '/api/flow-studio/flows')).json.flows
  const flow = flows[0]
  const run = await runstore.createRun(runsRoot, { flowId: flow.id, flowName: flow.name, nodeTotal: 1 })
  // 内部证据走 runstore（宿主路径），不经外部通道。
  await runstore.appendEvents(runsRoot, run.id, [{
    v: 1,
    kind: 'test/report',
    nodeId: 'n_internal',
    attemptId: 1,
    traceId: 'tr-internal',
    data: { suite: 'unit', executed: 1, passed: 1, failed: 0, skipped: 0 },
  }])
  const before = (await call(route, 'GET', `/api/flow-studio/runs/${run.id}/summary`)).json.summary
  const posted = await call(route, 'POST', `/api/flow-studio/runs/${run.id}/events`, [
    {
      v: 1,
      runId: run.id,
      kind: 'test/report',
      nodeId: 'n_evil',
      attemptId: 1,
      traceId: 'tr-evil-1',
      // 来客自带授信元数据：必须被剥离 / 覆盖。
      extra: { producer: 'host', authority: 'host', source: 'internal', terminalScope: 'run' },
      data: { suite: 'unit', executed: 1, passed: 1, failed: 0, skipped: 0 },
    },
    { v: 1, runId: run.id, kind: 'review/verdict', nodeId: 'n_evil', attemptId: 1, traceId: 'tr-evil-2', data: { verdict: 'approve', findingCount: 0 } },
    {
      v: 1,
      runId: run.id,
      kind: 'check/form',
      nodeId: 'n_evil',
      attemptId: 1,
      traceId: 'tr-evil-3',
      data: { ruleSetId: 'host:n_evil', ruleSetVersion: '0.11', executor: 'host', state: 'pass', passedChecks: 1, totalChecks: 1, executedAt: '2026-11-07T00:00:00.000Z' },
    },
  ])
  assert.equal(posted.status, 200, JSON.stringify(posted.json))
  for (const event of posted.json.events) {
    assert.equal(event.extra.source, 'external', `${event.kind} 必须强制 source=external`)
    assert.equal(event.extra.producer, 'external', `${event.kind} 必须强制 producer=external`)
    assert.equal(event.extra.authority, 'unverified')
    assert.equal(event.extra.terminalScope, undefined, '受保护的 terminalScope 必须被剥离')
  }
  const after = (await call(route, 'GET', `/api/flow-studio/runs/${run.id}/summary`)).json.summary
  assert.equal(after.quality.state, before.quality.state, '外部假 pass 不得改变质量 headline')
  assert.equal(after.quality.evidence.tests.state, before.quality.evidence.tests.state, '外部同 suite 不得覆盖内部证据')
  assert.equal(after.quality.evidence.checks.state, before.quality.evidence.checks.state, '外部假 host check 不得进入权威检查')
  assert.ok(after.externalCount >= 3, '外部观察仍保留并有计数')
  const exported = await call(route, 'GET', `/api/flow-studio/runs/${run.id}/export`)
  assert.equal(exported.status, 200)
  assert.match(exported.body, /外部观察|外部未验证/, '导出必须保留外部观察附录并标明未验证')
})

// ---------------------------------------------------------------------------
// 0.11 R5（返工）：宿主报告完整性按持久化副本核验；summary 缓存随报告失效
// ---------------------------------------------------------------------------
await check('R5：summary 只认已登记且报告副本 sha256 匹配的 host 证据；副本删除后缓存失效', async () => {
  const runsRoot = runstore.runsDir(home)
  const flows = (await call(route, 'GET', '/api/flow-studio/flows')).json.flows
  const flow = flows[0]
  const run = await runstore.createRun(runsRoot, { flowId: flow.id, flowName: flow.name, nodeTotal: 1 })
  await runstore.startRun(runsRoot, run.id)
  const copyRel = 'n_reg/artifacts/1/host-check-report.json'
  const copyAbs = join(runsRoot, run.id, copyRel)
  mkdirSync(dirname(copyAbs), { recursive: true })
  const reportBody = '{"suite":"unit","passed":1}'
  writeFileSync(copyAbs, reportBody)
  const reportSha = createHash('sha256').update(reportBody).digest('hex')
  await runstore.appendEvents(runsRoot, run.id, [
    {
      v: 1, kind: 'artifact/write', nodeId: 'n_reg', attemptId: 1, traceId: 'tr-reg',
      extra: { producer: 'host', authority: 'host', verificationId: 'hc-reg-1', verificationKind: 'report-copy' },
      data: { path: copyRel, bytes: Buffer.byteLength(reportBody), kind: 'json', sha256: reportSha },
    },
    {
      v: 1, kind: 'check/form', nodeId: 'n_reg', attemptId: 1, traceId: 'tr-reg',
      extra: { producer: 'host', authority: 'host', verificationId: 'hc-reg-1' },
      data: {
        ruleSetId: 'host:n_reg', ruleSetVersion: '0.11', executor: 'host', state: 'pass',
        passedChecks: 1, totalChecks: 1, executedAt: new Date().toISOString(),
      },
    },
  ])
  // 持凭证登记一条真实宿主执行（普通事件 / HTTP 无法构造这个 receipt）。
  const receipt = runstore.createHostExecutionReceipt('hc-reg-1')
  await runstore.recordHostExecution(runsRoot, run.id, {
    executionId: 'hc-reg-1',
    runId: run.id,
    nodeId: 'n_reg',
    attempt: 1,
    checkId: 'host:n_reg',
    commandDigest: 'a'.repeat(64),
    expectedExitCode: 0,
    exitCode: 0,
    state: 'pass',
    reasonCode: null,
    reportPath: 'reports/unit.json',
    reportSha256: reportSha,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  }, { receipt })

  const first = await call(route, 'GET', `/api/flow-studio/runs/${run.id}/summary`)
  assert.equal(first.status, 200)
  assert.equal(first.json.summary.quality.evidence.checks.state, 'pass')
  assert.equal(first.json.summary.quality.evidence.checks.authoritativePassed, 1)
  assert.equal(first.json.cached, false)

  const cached = await call(route, 'GET', `/api/flow-studio/runs/${run.id}/summary`)
  assert.equal(cached.json.cached, true, '报告未变时缓存可命中')
  assert.equal(cached.json.summary.quality.evidence.checks.authoritativePassed, 1)

  // 跨读端一致性：export 必须与 summary 用同一验证器，不能把同一权威通过误降 unknown。
  const exportBefore = await call(route, 'GET', `/api/flow-studio/runs/${run.id}/export`)
  assert.equal(exportBefore.status, 200)
  assert.match(exportBefore.body, /\| 规范 \| pass \|/, 'export 必须保留已登记的宿主权威通过')

  // 报告内容篡改（长度相同）也必须撤销权威并让缓存失效；取消哈希比较时这条必红。
  writeFileSync(copyAbs, '{"suite":"unit","passed":0}')
  const afterTamper = await call(route, 'GET', `/api/flow-studio/runs/${run.id}/summary`)
  assert.equal(afterTamper.json.cached, false, '报告内容篡改后缓存必须失效')
  assert.equal(afterTamper.json.summary.quality.evidence.checks.authoritativePassed, 0,
    '报告内容与登记 sha256 不符时不得授信')
  assert.notEqual(afterTamper.json.summary.quality.evidence.checks.state, 'pass')
  const exportTamper = await call(route, 'GET', `/api/flow-studio/runs/${run.id}/export`)
  assert.equal(exportTamper.status, 200)
  assert.match(exportTamper.body, /\| 规范 \| unknown \|/, '报告篡改后 export 也必须降 unknown')

  // 恢复原始报告：验证器与缓存都应回到权威通过。
  writeFileSync(copyAbs, reportBody)
  const restored = await call(route, 'GET', `/api/flow-studio/runs/${run.id}/summary`)
  assert.equal(restored.json.summary.quality.evidence.checks.authoritativePassed, 1,
    '恢复原始报告后重新授信')

  rmSync(copyAbs, { force: true })
  const afterDelete = await call(route, 'GET', `/api/flow-studio/runs/${run.id}/summary`)
  assert.equal(afterDelete.json.cached, false, '报告副本删除后缓存必须失效')
  assert.equal(afterDelete.json.summary.quality.evidence.checks.authoritativePassed, 0,
    '报告副本缺失时不得继续给权威通过')
  assert.notEqual(afterDelete.json.summary.quality.evidence.checks.state, 'pass')
  const exportAfter = await call(route, 'GET', `/api/flow-studio/runs/${run.id}/export`)
  assert.equal(exportAfter.status, 200)
  assert.match(exportAfter.body, /\| 规范 \| unknown \|/, '报告副本删除后 export 也必须降 unknown')
})

for (const dir of workspaceDirs) rmSync(dir, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
console.log(`\n${checks} 组通过`)
