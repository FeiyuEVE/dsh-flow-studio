#!/usr/bin/env node
/**
 * run 目录读写自检：建 run、追加、分页、过滤、删除、路径穿越、超大行与超量批次。
 *
 * 产物落在项目 `.tmp/` 下，不占系统 /tmp；不启动 dsh。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-runstore-'))

const store = await import('../src/runstore.js')

const runsRoot = store.runsDir(home)
const NOW = new Date('2026-11-06T12:00:00.000Z')

let checks = 0
async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

/** 一条能通过 normalizeEvent 的事件；具体 kind 的 data 在这里补齐。 */
function event(kind, over = {}) {
  const data = {
    'run/start': { flowId: 'flow-a', flowName: '默认流程', nodeTotal: 3 },
    'run/end': { status: 'done' },
    'node/start': { title: '阶段', mode: 'single', skills: [] },
    'node/end': { status: 'passed', durationMs: 1 },
    'member/start': { name: '实现者' },
    'member/end': { status: 'passed', durationMs: 1 },
    'model/call': { provider: 'deepseek', model: 'deepseek-chat', callId: 'call-1', usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 } },
    'tool/call': { name: 'bash', ok: true },
    'skill/load': { skill: 'a', ok: true },
    'artifact/write': { path: 'artifacts/a.md', bytes: 10, kind: 'md' },
    'reject/trigger': { edgeId: 'e1', fromNodeId: 'n_test', toNodeId: 'n_dev', reason: '打回' },
    'review/finding': { id: 'd1', severity: 'P1', title: '问题', status: 'open' },
    'review/verdict': { verdict: 'approve', findingCount: 0 },
    'check/form': { ruleSetId: 'eslint', ruleSetVersion: '9', executor: 'eslint@9', state: 'pass' },
    'acceptance/verdict': { itemId: 'acc-1', status: 'pass', decidedBy: 'human', evidenceRef: 'artifacts/acc.md' },
    'test/report': { suite: 'unit', executed: 1, passed: 1, failed: 0, skipped: 0, reportRef: 'artifacts/t.md' },
  }[kind]
  return {
    v: 1,
    ts: '2026-11-06T10:00:00.000Z',
    kind,
    traceId: 'trace-1',
    memberId: null,
    nodeId: 'n_1',
    attemptId: 1,
    data: data === undefined ? {} : { ...data },
    ...over,
  }
}

function makeRun(over = {}) {
  return store.createRun(runsRoot, {
    name: '测试 run',
    flowId: 'flow-a',
    flowName: '默认流程',
    nodeTotal: 3,
    ...over,
  })
}

const created = []

try {
  console.log('runstore.js · 建 run 与落盘')

  await check('createRun：pending 未开始、id 形状、元数据、目录 0700 / 文件 0600', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    assert.match(meta.id, /^r-[a-z0-9]+-[a-z0-9]{4}$/)
    // 06 §13.2：建出来必须是 pending，started=false；真正开跑走 startRun()。
    assert.equal(meta.status, 'pending')
    assert.equal(meta.started, false)
    assert.equal(meta.engine, 'real')
    assert.equal(meta.nodeTotal, 3)
    assert.equal(meta.eventCount, 0)
    assert.equal(meta.seq, 0)
    const dir = join(runsRoot, meta.id)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, 'run.json')).mode & 0o777, 0o600)
    const disk = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
    assert.equal(disk.id, meta.id)
    assert.equal(disk.name, '测试 run')
    assert.equal(disk.status, 'pending')
  })

  await check('连续新建的 runId 不重复', async () => {
    const first = await makeRun()
    const second = await makeRun()
    created.push(first.id, second.id)
    assert.notEqual(first.id, second.id)
  })

  await check('appendEvents：run 级写 run.jsonl，节点级写 <nodeId>/<attemptId>.jsonl', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const appended = await store.appendEvents(runsRoot, meta.id, [
      event('run/start', { runId: meta.id, nodeId: undefined, attemptId: undefined }),
      event('node/start', { runId: meta.id, nodeId: 'n_req' }),
      event('node/end', { runId: meta.id, nodeId: 'n_req', data: { status: 'passed', durationMs: 9 } }),
    ], { now: NOW })

    assert.equal(appended.events.length, 3)
    assert.deepEqual(appended.events.map(item => item.seq), [1, 2, 3])
    assert.equal(appended.firstSeq, 1)
    assert.equal(appended.lastSeq, 3)

    const dir = join(runsRoot, meta.id)
    assert.equal(readFileSync(join(dir, 'run.jsonl'), 'utf8').trim().split('\n').length, 1)
    const nodeFile = join(dir, 'n_req', '1.jsonl')
    assert.ok(existsSync(nodeFile))
    assert.equal(readFileSync(nodeFile, 'utf8').trim().split('\n').length, 2)
    assert.equal(statSync(nodeFile).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, 'n_req')).mode & 0o777, 0o700)

    const reread = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(reread.eventCount, 3)
    assert.equal(reread.seq, 3)
  })

  await check('appendEvents：单条事件对象也能追加，ts 以服务端落盘为准', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const appended = await store.appendEvents(runsRoot, meta.id, event('node/start', {
      runId: meta.id, ts: 'not-a-date',
    }), { now: NOW })
    assert.equal(appended.events[0].ts, NOW.toISOString())
    const page = await store.readEvents(runsRoot, meta.id, { limit: 10 })
    assert.equal(page.events[0].ts, NOW.toISOString())
  })

  console.log('runstore.js · 读取 / 分页 / 过滤')

  await check('readEvents：limit / total / truncated / order=desc', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const batch = []
    for (let i = 1; i <= 5; i += 1) {
      batch.push(event('node/start', {
        runId: meta.id,
        nodeId: `n_${i}`,
        ts: `2026-11-06T10:00:0${i}.000Z`,
        data: { title: `阶段${i}`, mode: 'single', skills: [] },
      }))
    }
    await store.appendEvents(runsRoot, meta.id, batch, { now: NOW })

    const firstPage = await store.readEvents(runsRoot, meta.id, { limit: 2 })
    assert.equal(firstPage.total, 5)
    assert.equal(firstPage.events.length, 2)
    assert.equal(firstPage.truncated, true)
    assert.deepEqual(firstPage.events.map(item => item.seq), [1, 2])

    const desc = await store.readEvents(runsRoot, meta.id, { limit: 2, order: 'desc' })
    assert.deepEqual(desc.events.map(item => item.seq), [5, 4])

    const all = await store.readEvents(runsRoot, meta.id, { limit: 1000 })
    assert.equal(all.truncated, false)
    assert.equal(all.events.length, 5)
  })

  await check('readEvents：nodeId / attemptId / kind / since(seq) / since(ts) 过滤', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const batch = []
    for (let i = 1; i <= 5; i += 1) {
      batch.push(event('node/start', {
        runId: meta.id,
        nodeId: `n_${i}`,
        attemptId: i,
        ts: `2026-11-06T10:00:0${i}.000Z`,
      }))
    }
    await store.appendEvents(runsRoot, meta.id, batch, { now: NOW })

    const byNode = await store.readEvents(runsRoot, meta.id, { nodeId: 'n_2', limit: 10 })
    assert.equal(byNode.total, 1)
    assert.equal(byNode.events[0].nodeId, 'n_2')

    const byAttempt = await store.readEvents(runsRoot, meta.id, { attemptId: 3, limit: 10 })
    assert.equal(byAttempt.total, 1)
    assert.equal(byAttempt.events[0].attemptId, 3)

    const byKind = await store.readEvents(runsRoot, meta.id, { kinds: ['node/start'], limit: 10 })
    assert.equal(byKind.total, 5)

    const bySeq = await store.readEvents(runsRoot, meta.id, { since: 3, limit: 10 })
    assert.deepEqual(bySeq.events.map(item => item.seq), [4, 5])

    const byTs = await store.readEvents(runsRoot, meta.id, { since: '2026-11-06T10:00:03.000Z', limit: 10 })
    assert.deepEqual(byTs.events.map(item => item.seq), [4, 5])

    await assert.rejects(
      () => store.readEvents(runsRoot, meta.id, { since: 'not-a-time', limit: 10 }),
      error => error.status === 400 && error.field === 'since',
    )
    await assert.rejects(
      () => store.readEvents(runsRoot, meta.id, { order: 'sideways', limit: 10 }),
      error => error.status === 400 && error.field === 'order',
    )
  })

  await check('readRunMeta / writeRunMeta：原子写、字段合并、id 以路径为准', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const written = await store.writeRunMeta(runsRoot, meta.id, { id: 'evil-id', name: '改过名', status: 'done' })
    assert.equal(written.id, meta.id)
    assert.equal(written.name, '改过名')
    assert.equal(written.createdAt, meta.createdAt)
    const reread = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(reread.status, 'done')
    assert.equal(reread.name, '改过名')

    await assert.rejects(
      () => store.writeRunMeta(runsRoot, '../x', {}),
      error => error.status === 400,
    )
    await assert.rejects(
      () => store.writeRunMeta(runsRoot, 'r-does-not-exist', {}),
      error => error.status === 404,
    )
  })

  await check('listRuns：按 startedAt 倒序、limit 生效、tokenTotal 从事件重算', async () => {
    const older = await makeRun()
    const newer = await makeRun()
    created.push(older.id, newer.id)
    await store.writeRunMeta(runsRoot, older.id, { startedAt: '2026-11-01T00:00:00.000Z' })
    await store.writeRunMeta(runsRoot, newer.id, { startedAt: '2026-11-05T00:00:00.000Z' })
    await store.appendEvents(runsRoot, newer.id, event('model/call', { runId: newer.id }), { now: NOW })

    const { runs: list, skipped } = await store.listRuns(runsRoot, { limit: 100 })
    assert.deepEqual(skipped, [])
    const olderIndex = list.findIndex(item => item.id === older.id)
    const newerIndex = list.findIndex(item => item.id === newer.id)
    assert.ok(olderIndex >= 0 && newerIndex >= 0)
    assert.ok(newerIndex < olderIndex, 'startedAt 新的应排在前面')
    const newerItem = list[newerIndex]
    assert.equal(newerItem.tokenTotal, 10)
    assert.equal(newerItem.nodeDone, 0)
    assert.ok(Object.hasOwn(newerItem, 'flowId'))
    assert.ok(Object.hasOwn(newerItem, 'nodeTotal'))

    const one = await store.listRuns(runsRoot, { limit: 1 })
    assert.equal(one.runs.length, 1)
  })

  await check('readRunDetail：节点 / attempt 索引含事件数与首末时间', async () => {
    const meta = await makeRun({ nodeTotal: 1 })
    created.push(meta.id)
    await store.appendEvents(runsRoot, meta.id, [
      event('node/start', { runId: meta.id, nodeId: 'n_req', attemptId: 1, ts: '2026-11-06T10:00:01.000Z' }),
      event('node/end', { runId: meta.id, nodeId: 'n_req', attemptId: 1, ts: '2026-11-06T10:00:02.000Z' }),
      event('node/start', { runId: meta.id, nodeId: 'n_req', attemptId: 2, ts: '2026-11-06T10:00:03.000Z' }),
    ], { now: NOW })
    const detail = await store.readRunDetail(runsRoot, meta.id)
    assert.equal(detail.eventCount, 3)
    assert.equal(detail.nodes.length, 1)
    assert.equal(detail.nodes[0].nodeId, 'n_req')
    assert.equal(detail.nodes[0].events ?? detail.nodes[0].eventCount, 3)
    assert.equal(detail.nodes[0].attempts.length, 2)
    const attempt1 = detail.nodes[0].attempts[0]
    assert.equal(attempt1.attemptId, 1)
    assert.equal(attempt1.eventCount, 2)
    assert.equal(attempt1.firstTs, '2026-11-06T10:00:01.000Z')
    assert.equal(attempt1.lastTs, '2026-11-06T10:00:02.000Z')
    assert.equal(attempt1.status, 'passed')
    // §8.3：第 2 轮已开始但还没有 node/end，第 1 轮的 passed 不再算作当前有效结论。
    assert.equal(detail.run.nodeDone, 0)
    // B1：详情接口必须带每节点状态，不能只回计数（否则客户端长跑时只能退回事件窗口）。
    assert.ok(detail.run.progress.nodes, 'readRunDetail 必须下发 progress.nodes')
    assert.equal(detail.run.progress.nodes.n_req.attemptId, 2)
    assert.equal(detail.run.progress.nodes.n_req.status, 'pending')
    assert.equal(detail.run.progress.nodes.n_req.invalidated, false)
    assert.deepEqual(detail.run.progress.invalidatedNodes, [])
    // 该 run 没有 run/start（nodeTotal 未知）且当前 attempt 还是 pending，分母 0 → ratio=null
    assert.equal(detail.run.progress.ratio, null)
  })

  console.log('runstore.js · 边界与拒绝')

  await check('路径穿越：../、绝对路径、空串、点开头一律拒绝', async () => {
    for (const id of ['../evil', '..', '.', '/etc/passwd', '', '.hidden']) {
      await assert.rejects(
        () => makeRun({ id }),
        error => error.status === 400,
        `createRun 应拒绝 ${id}`,
      )
    }
    assert.equal(await store.readRunMeta(runsRoot, '../x'), null)
    assert.equal(await store.readEvents(runsRoot, '../x'), null)
    assert.equal(await store.readRunDetail(runsRoot, '../x'), null)
    assert.equal(await store.deleteRun(runsRoot, '..'), false)
    await assert.rejects(
      () => store.appendEvents(runsRoot, '../x', event('node/start')),
      error => error.status === 400,
    )
    await assert.rejects(
      () => store.writeRunMeta(runsRoot, '..', {}),
      error => error.status === 400,
    )
  })

  await check('单条事件超过 8KB → 400 且不落盘', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const huge = event('node/start', {
      runId: meta.id,
      data: { title: '需求', mode: 'single', skills: [], blob: 'x'.repeat(9000) },
    })
    await assert.rejects(
      () => store.appendEvents(runsRoot, meta.id, [huge], { now: NOW }),
      error => error.status === 400 && /8192|8KB/.test(error.reason),
    )
    const page = await store.readEvents(runsRoot, meta.id, { limit: 10 })
    assert.equal(page.total, 0)
  })

  await check('单批 > 200 条 → 400；空批 → 400', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const many = []
    for (let i = 0; i < 201; i += 1) many.push(event('node/start', { runId: meta.id }))
    await assert.rejects(
      () => store.appendEvents(runsRoot, meta.id, many, { now: NOW }),
      error => error.status === 400 && /200/.test(error.reason),
    )
    await assert.rejects(
      () => store.appendEvents(runsRoot, meta.id, [], { now: NOW }),
      error => error.status === 400,
    )
  })

  await check('单 run 事件总数上限 200000 → 400 并给原因', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    await store.writeRunMeta(runsRoot, meta.id, { eventCount: 199999, seq: 199999 })
    await assert.rejects(
      () => store.appendEvents(runsRoot, meta.id, [
        event('node/start', { runId: meta.id }),
        event('node/start', { runId: meta.id }),
      ], { now: NOW }),
      error => error.status === 400 && /200000/.test(error.reason),
    )
  })

  await check('整批校验：一条非法则整批不写', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    await assert.rejects(
      () => store.appendEvents(runsRoot, meta.id, [
        event('node/start', { runId: meta.id }),
        event('bogus/kind', { runId: meta.id }),
      ], { now: NOW }),
      error => error.status === 400 && error.index === 1 && /kind/.test(error.field),
    )
    const page = await store.readEvents(runsRoot, meta.id, { limit: 10 })
    assert.equal(page.total, 0)
  })

  await check('坏行跳过、坏 meta 的 run 不出现在列表里', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    await store.appendEvents(runsRoot, meta.id, event('node/start', { runId: meta.id }), { now: NOW })
    appendFileSync(join(runsRoot, meta.id, 'n_1', '1.jsonl'), '{ not json\n')
    const page = await store.readEvents(runsRoot, meta.id, { limit: 10 })
    assert.equal(page.total, 1)
    assert.equal(page.skipped, 1)

    const brokenId = 'r-broken-meta'
    mkdirSync(join(runsRoot, brokenId), { recursive: true })
    writeFileSync(join(runsRoot, brokenId, 'run.json'), '{ not json')
    const listed = await store.listRuns(runsRoot, { limit: 100 })
    assert.ok(!listed.runs.some(item => item.id === brokenId))
    assert.ok(listed.skipped.some(item => item.id === brokenId))
  })

  await check('不存在的 run：读返回 null，追加 404，删除 false', async () => {
    const missing = 'r-does-not-exist'
    assert.equal(await store.readRunMeta(runsRoot, missing), null)
    assert.equal(await store.readEvents(runsRoot, missing, { limit: 10 }), null)
    assert.equal(await store.readRunDetail(runsRoot, missing), null)
    await assert.rejects(
      () => store.appendEvents(runsRoot, missing, event('node/start')),
      error => error.status === 404,
    )
    assert.equal(await store.deleteRun(runsRoot, missing), false)
  })

  await check('deleteRun：删除整个目录，第二次返回 false', async () => {
    const meta = await makeRun()
    await store.appendEvents(runsRoot, meta.id, event('node/start', { runId: meta.id }), { now: NOW })
    assert.equal(await store.deleteRun(runsRoot, meta.id), true)
    assert.equal(existsSync(join(runsRoot, meta.id)), false)
    assert.equal(await store.deleteRun(runsRoot, meta.id), false)
  })

  console.log('runstore.js · §8.6 计数器与坏 run 鲁棒性')

  await check('seq 由服务端单调分配，客户端 seq 一律忽略（§8.1）', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const first = await store.appendEvents(runsRoot, meta.id, [
      event('node/start', { runId: meta.id, nodeId: 'n_1', attemptId: 1, seq: 999 }),
      event('node/end', { runId: meta.id, nodeId: 'n_1', attemptId: 1, seq: 42 }),
    ], { now: NOW })
    assert.deepEqual(first.events.map(item => item.seq), [1, 2])
    assert.equal(first.events[0].extra, undefined, '客户端 seq 不进 extra，也不落盘')
    const second = await store.appendEvents(runsRoot, meta.id, event('node/start', { runId: meta.id, nodeId: 'n_2' }), { now: NOW })
    assert.equal(second.events[0].seq, 3)
    const metaNow = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(metaNow.lastSeq, 3)
    assert.equal(metaNow.seq, 3)
  })

  await check('run.json 计数器：eventCount / tokenTotal / nodeDone / lastSeq 追加时更新（§8.6）', async () => {
    const meta = await makeRun({ nodeTotal: 5 })
    created.push(meta.id)
    await store.appendEvents(runsRoot, meta.id, [
      event('run/start', { runId: meta.id, nodeId: undefined, attemptId: undefined, data: { flowId: 'flow-a', flowName: '默认流程', nodeTotal: 5 } }),
      event('node/start', { runId: meta.id, nodeId: 'n_1', attemptId: 1 }),
      event('node/end', { runId: meta.id, nodeId: 'n_1', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
      event('node/end', { runId: meta.id, nodeId: 'n_2', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
      event('model/call', { runId: meta.id, nodeId: 'n_1', attemptId: 1 }),
      event('run/end', { runId: meta.id, nodeId: undefined, attemptId: undefined, data: { status: 'done' } }),
    ], { now: NOW })

    const metaNow = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(metaNow.eventCount, 6)
    assert.equal(metaNow.lastSeq, 6)
    assert.equal(metaNow.tokenTotal, 10)
    assert.equal(metaNow.nodeDone, 2)
    assert.equal(metaNow.nodeTotal, 5)
    assert.equal(metaNow.status, 'done')
    assert.ok(metaNow.endedAt)

    const { runs } = await store.listRuns(runsRoot, { limit: 100 })
    const item = runs.find(run => run.id === meta.id)
    assert.equal(item.nodeDone, 2)
    assert.equal(item.nodeTotal, 5)
    assert.equal(item.tokenTotal, 10)
    assert.equal(item.eventCount, 6)

    const detail = await store.readRunDetail(runsRoot, meta.id)
    assert.equal(detail.run.nodeDone, item.nodeDone, 'GET /runs 与 GET /runs/<id> 的 nodeDone 必须同值')
    assert.equal(detail.run.nodeTotal, item.nodeTotal, 'nodeTotal 必须同口径同值')
    assert.equal(detail.run.tokenTotal, item.tokenTotal)
  })

  await check('tokenTotal 计数器遵守 callId 替换语义（跨批次）', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    await store.appendEvents(runsRoot, meta.id, event('model/call', {
      runId: meta.id, traceId: 'trace-x',
      data: { provider: 'p', model: 'm', callId: 'c1', usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 } },
    }), { now: NOW })
    assert.equal((await store.readRunMeta(runsRoot, meta.id)).tokenTotal, 10)
    await store.appendEvents(runsRoot, meta.id, event('model/call', {
      runId: meta.id, traceId: 'trace-x',
      data: { provider: 'p', model: 'm', callId: 'c1', usage: { input: 100, cacheRead: 200, cacheWrite: 300, output: 400 } },
    }), { now: NOW })
    assert.equal((await store.readRunMeta(runsRoot, meta.id)).tokenTotal, 1000, '同一 traceId+callId 后到整条替换')
    const { runs } = await store.listRuns(runsRoot, { limit: 100 })
    assert.equal(runs.find(run => run.id === meta.id).tokenTotal, 1000)
  })

  await check('GET /runs 只读 run.json：删掉节点事件文件后计数器仍然有效', async () => {
    const meta = await makeRun({ nodeTotal: 2 })
    created.push(meta.id)
    await store.appendEvents(runsRoot, meta.id, [
      event('node/end', { runId: meta.id, nodeId: 'n_1', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
      event('model/call', { runId: meta.id, nodeId: 'n_1', attemptId: 1 }),
    ], { now: NOW })
    rmSync(join(runsRoot, meta.id, 'n_1'), { recursive: true, force: true })
    const { runs, skipped } = await store.listRuns(runsRoot, { limit: 100 })
    assert.ok(!skipped.some(entry => entry.id === meta.id))
    const item = runs.find(run => run.id === meta.id)
    assert.equal(item.nodeDone, 1, '节点事件文件没了也不该让列表退回 0（说明没有读事件）')
    assert.equal(item.tokenTotal, 10)
  })

  await check('坏 run（run.json 是目录 / 坏 JSON / 权限拒绝）只进 skipped，不 500（§8.6）', async () => {
    const good = await makeRun()
    created.push(good.id)

    const asDir = 'r-bad-isdir'
    mkdirSync(join(runsRoot, asDir, 'run.json'), { recursive: true })
    created.push(asDir)

    const badJson = 'r-bad-json'
    mkdirSync(join(runsRoot, badJson), { recursive: true })
    writeFileSync(join(runsRoot, badJson, 'run.json'), '{ not json')

    const denied = 'r-bad-perm'
    mkdirSync(join(runsRoot, denied), { recursive: true })
    writeFileSync(join(runsRoot, denied, 'run.json'), '{}')
    chmodSync(join(runsRoot, denied, 'run.json'), 0o000)

    const { runs, skipped } = await store.listRuns(runsRoot, { limit: 100 })
    assert.ok(runs.some(run => run.id === good.id), '好 run 仍然要列出来')
    for (const id of [asDir, badJson, denied]) {
      const entry = skipped.find(item => item.id === id)
      assert.ok(entry, `${id} 应出现在 skipped`)
      assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0)
      assert.ok(!entry.reason.includes(runsRoot), 'skipped 原因不能带内部绝对路径')
    }
    assert.match(skipped.find(item => item.id === asDir).reason, /目录/)
    assert.match(skipped.find(item => item.id === badJson).reason, /JSON/)
    chmodSync(join(runsRoot, denied, 'run.json'), 0o600)
  })

  await check('打回失效同步进 run.json 计数器（与 computeProgress 同口径）', async () => {
    const meta = await makeRun({ nodeTotal: 2 })
    created.push(meta.id)
    await store.appendEvents(runsRoot, meta.id, [
      event('run/start', { runId: meta.id, nodeId: undefined, attemptId: undefined, data: { flowId: 'flow-a', flowName: '默认流程', nodeTotal: 2 } }),
      event('node/end', { runId: meta.id, nodeId: 'n_a', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
      event('node/end', { runId: meta.id, nodeId: 'n_b', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
      event('reject/trigger', { runId: meta.id, nodeId: 'n_b', attemptId: 1, data: { edgeId: 'e1', fromNodeId: 'n_b', toNodeId: 'n_a', reason: '打回 A' } }),
    ], { now: NOW })
    let metaNow = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(metaNow.nodeDone, 0, 'A/B 都被打回，计数器不能还是 2')
    assert.equal(metaNow.progress.nodes.n_a.invalidated, true)
    assert.equal(metaNow.progress.nodes.n_b.invalidated, true)

    await store.appendEvents(runsRoot, meta.id, [
      event('node/start', { runId: meta.id, nodeId: 'n_a', attemptId: 2 }),
      event('node/end', { runId: meta.id, nodeId: 'n_a', attemptId: 2, data: { status: 'passed', durationMs: 1 } }),
      event('node/end', { runId: meta.id, nodeId: 'n_b', attemptId: 2, data: { status: 'passed', durationMs: 1 } }),
    ], { now: NOW })
    metaNow = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(metaNow.nodeDone, 2, '新 attempt 重新通过后要重新计入')
    assert.equal(metaNow.progress.nodes.n_a.invalidated, false)

    const detail = await store.readRunDetail(runsRoot, meta.id)
    assert.equal(detail.run.nodeDone, 2)
    assert.equal(detail.run.progress.passed, 2)
    assert.equal(detail.run.progress.invalidated, 0)
  })

  await check('多次打回后 run.json 计数器与 summarize 的 progress 仍同值', async () => {
    const meta = await makeRun({ nodeTotal: 3 })
    created.push(meta.id)
    await store.appendEvents(runsRoot, meta.id, [
      event('run/start', { runId: meta.id, nodeId: undefined, attemptId: undefined, data: { flowId: 'flow-a', flowName: '默认流程', nodeTotal: 3 } }),
      event('node/end', { runId: meta.id, nodeId: 'n_a', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
      event('node/end', { runId: meta.id, nodeId: 'n_b', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
      event('reject/trigger', { runId: meta.id, nodeId: 'n_b', attemptId: 1, data: { edgeId: 'e1', fromNodeId: 'n_b', toNodeId: 'n_a', reason: '打回 A' } }),
      event('node/start', { runId: meta.id, nodeId: 'n_a', attemptId: 2 }),
      event('node/end', { runId: meta.id, nodeId: 'n_a', attemptId: 2, data: { status: 'passed', durationMs: 1 } }),
      event('node/end', { runId: meta.id, nodeId: 'n_c', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ], { now: NOW })
    const metaNow = await store.readRunMeta(runsRoot, meta.id)
    const detail = await store.readRunDetail(runsRoot, meta.id)
    const page = await store.readEvents(runsRoot, meta.id, { limit: 100 })
    const summary = (await import('../src/runlog.js')).summarize(page.events)
    assert.equal(metaNow.nodeDone, 2)
    assert.equal(detail.run.progress.passed, 2)
    assert.equal(detail.run.progress.invalidated, 1)
    assert.equal(summary.progress.passed, 2)
    assert.equal(summary.progress.invalidated, 1)
    assert.deepEqual(summary.progress.invalidatedNodes, ['n_b'])
    assert.equal(summary.progress.nodeDone, metaNow.nodeDone)
  })

  await check('§8.2 新 kind 能落盘并进 summary', async () => {
    const meta = await makeRun({ nodeTotal: 1 })
    created.push(meta.id)
    const appended = await store.appendEvents(runsRoot, meta.id, [
      event('node/end', { runId: meta.id, nodeId: 'n_a', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
      event('acceptance/verdict', { runId: meta.id, nodeId: 'n_a', attemptId: 1 }),
      event('test/report', { runId: meta.id, nodeId: 'n_a', attemptId: 1 }),
    ], { now: NOW })
    assert.equal(appended.events.length, 3)
    const summary = (await import('../src/runlog.js')).summarize(
      (await store.readEvents(runsRoot, meta.id, { limit: 100 })).events,
    )
    assert.equal(summary.quality.evidence.acceptance.state, 'pass')
    assert.equal(summary.quality.evidence.tests.state, 'pass')
  })

  await check('整批校验：run 级事件带 nodeId 也整批拒绝（§8.1）', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    await assert.rejects(
      () => store.appendEvents(runsRoot, meta.id, [
        event('node/start', { runId: meta.id, nodeId: 'n_1', attemptId: 1 }),
        event('run/end', { runId: meta.id, nodeId: 'n_1', attemptId: 1, data: { status: 'done' } }),
      ], { now: NOW }),
      error => error.status === 400 && error.index === 1 && /nodeId/.test(error.field),
    )
    assert.equal((await store.readEvents(runsRoot, meta.id, { limit: 10 })).total, 0)
  })

  await check('runs 目录不存在时列表返回空且不抛错', async () => {
    const { runs, skipped } = await store.listRuns(join(home, 'flow-studio', 'never-created'), { limit: 10 })
    assert.deepEqual(runs, [])
    assert.deepEqual(skipped, [])
  })
  console.log('runstore.js · §13.2 / §13.3 生命周期、租约与启动修复')

  await check('§13.2 startRun：pending → running，started 标志落盘；二次 startRun 409', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const started = await store.startRun(runsRoot, meta.id, { now: NOW })
    assert.equal(started.status, 'running')
    assert.equal(started.started, true)
    assert.equal(started.startedAt, NOW.toISOString())
    const disk = JSON.parse(readFileSync(join(runsRoot, meta.id, 'run.json'), 'utf8'))
    assert.equal(disk.status, 'running')
    assert.equal(disk.started, true)
    await assert.rejects(
      () => store.startRun(runsRoot, meta.id),
      error => error.status === 409,
    )
    // 「开始过」判据是 started，不是 eventCount。
    await store.writeRunMeta(runsRoot, meta.id, { eventCount: 0 })
    await assert.rejects(() => store.startRun(runsRoot, meta.id), error => error.status === 409)
  })

  await check('§13.2 并发两次 startRun 只有一个成功', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const results = await Promise.allSettled([
      store.startRun(runsRoot, meta.id),
      store.startRun(runsRoot, meta.id),
    ])
    const fulfilled = results.filter(item => item.status === 'fulfilled')
    const rejected = results.filter(item => item.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason.status, 409)
    console.log(`  · 并发 startRun: ${results.map(item => item.status).join(' / ')}`)
  })

  await check('§13.3 租约：第二实例 claim 409、续租/释放校验持有者', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const now = new Date('2026-11-06T12:00:00.000Z')
    const lease = await store.claimLease(runsRoot, meta.id, { pid: 111, host: 'h1', ttlMs: 60_000, now })
    assert.equal(lease.pid, 111)
    assert.equal(lease.host, 'h1')
    assert.equal((await store.readLease(runsRoot, meta.id, { now })).pid, 111)
    assert.equal(statSync(join(runsRoot, meta.id, 'lock.json')).mode & 0o777, 0o600)

    await assert.rejects(
      () => store.claimLease(runsRoot, meta.id, { pid: 222, host: 'h2', ttlMs: 60_000, now }),
      error => error.status === 409 && /租约/.test(error.reason),
    )
    await assert.rejects(
      () => store.renewLease(runsRoot, meta.id, { pid: 222, host: 'h2', now }),
      error => error.status === 409,
    )
    const renewed = await store.renewLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ttlMs: 120_000, now: new Date(now.getTime() + 30_000),
    })
    assert.equal(renewed.ttlMs, 120_000)
    assert.equal(renewed.heartbeatAt, new Date(now.getTime() + 30_000).toISOString())

    await assert.rejects(
      () => store.releaseLease(runsRoot, meta.id, { pid: 222, host: 'h2' }),
      error => error.status === 409,
    )
    assert.equal(await store.releaseLease(runsRoot, meta.id, { pid: 111, host: 'h1' }), true)
    assert.equal(await store.readLease(runsRoot, meta.id, { now }), null)
  })

  await check('§13.3 租约过期后可被抢；sweep 只处理 running 并把过期租约 run 标 failed（含「引擎中断」）', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const t0 = new Date('2026-11-06T12:00:00.000Z')
    await store.startRun(runsRoot, meta.id, { now: t0 })
    await store.claimLease(runsRoot, meta.id, { pid: 111, host: 'h1', ttlMs: 1000, now: t0 })
    // 未过期时读得到；过期后读不到并被清掉。
    assert.ok(await store.readLease(runsRoot, meta.id, { now: new Date(t0.getTime() + 500) }))
    assert.equal(await store.readLease(runsRoot, meta.id, { now: new Date(t0.getTime() + 2000) }), null)
    const stolen = await store.claimLease(runsRoot, meta.id, {
      pid: 333, host: 'h3', ttlMs: 1000, now: new Date(t0.getTime() + 2000),
    })
    assert.equal(stolen.pid, 333)

    const swept = await store.sweepExpiredLeases(runsRoot, { now: new Date(t0.getTime() + 60_000) })
    assert.ok(swept.includes(meta.id))
    const after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.status, 'failed')
    assert.equal(await store.readLease(runsRoot, meta.id, { now: new Date(t0.getTime() + 60_000) }), null)
    const all = await store.readAllEvents(runsRoot, meta.id)
    const runEnd = all.events.find(item => item.kind === 'run/end')
    assert.equal(runEnd.data.status, 'failed')
    assert.match(runEnd.data.reason, /引擎中断/)

    // pending 的 run 即使有租约也不会被 sweep（只扫 running）。
    const pending = await makeRun()
    created.push(pending.id)
    const t1 = new Date('2026-11-06T12:00:00.000Z')
    await store.claimLease(runsRoot, pending.id, { pid: 1, host: 'h', ttlMs: 1000, now: t1 })
    const sweptPending = await store.sweepExpiredLeases(runsRoot, { now: new Date(t1.getTime() + 60_000) })
    assert.ok(!sweptPending.includes(pending.id))
    assert.equal((await store.readRunMeta(runsRoot, pending.id)).status, 'pending')
  })

  await check('§13.4 启动修复：run.jsonl 有 run/end 但 run.json 非终态 → 修正为终态', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    await store.startRun(runsRoot, meta.id)
    await store.appendEvents(runsRoot, meta.id, [
      event('run/start', { runId: meta.id, nodeId: undefined, attemptId: undefined }),
      event('run/end', { runId: meta.id, nodeId: undefined, attemptId: undefined }),
    ], { now: NOW })
    // 人为制造不一致：run.json 退回 running。
    await store.writeRunMeta(runsRoot, meta.id, { status: 'running', endedAt: null })
    assert.equal((await store.readRunMeta(runsRoot, meta.id)).status, 'running')
    const repaired = await store.repairRunStates(runsRoot)
    assert.ok(repaired.includes(meta.id))
    const after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.status, 'done')
    assert.ok(after.endedAt)
    console.log(`  · repaired=${repaired.length} run → ${after.status}`)
  })

  await check('§13.4 事件额度：普通事件上限 = 总上限 − 64，run/end 仍能落终态', async () => {
    const meta = await makeRun({ nodeTotal: 0 })
    created.push(meta.id)
    await store.writeRunMeta(runsRoot, meta.id, { eventCount: 199936, lastSeq: 199936, seq: 199936 })
    await assert.rejects(
      () => store.appendEvents(runsRoot, meta.id, [event('node/start', { runId: meta.id })], { now: NOW }),
      error => error.status === 400 && /200000|保留额度/.test(error.reason),
    )
    const terminal = await store.appendEvents(runsRoot, meta.id, [
      event('run/end', { runId: meta.id, nodeId: undefined, attemptId: undefined, data: { status: 'failed' } }),
    ], { now: NOW })
    assert.equal(terminal.events[0].seq, 199937)
    assert.equal((await store.readRunMeta(runsRoot, meta.id)).status, 'failed')
    console.log('  · 普通事件 400（保留 64 条）；run/end 200 落终态')
  })

  await check('§13.4 写盘失败 → run.json 原子 failed + .error 侧车，GET detail 带 storageError', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    // 用一个普通文件占住 n_a 目录路径，让节点事件写盘必然失败。
    writeFileSync(join(runsRoot, meta.id, 'n_a'), 'not a dir')
    await assert.rejects(
      () => store.appendEvents(runsRoot, meta.id, [event('node/start', { runId: meta.id, nodeId: 'n_a' })], { now: NOW }),
      error => error.status === 500 && error.field === 'storage',
    )
    const after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.status, 'failed')
    assert.ok(existsSync(join(runsRoot, meta.id, '.error')))
    const detail = await store.readRunDetail(runsRoot, meta.id)
    assert.ok(detail.run.storageError)
    assert.equal(detail.run.storageError.code, 'EEXIST')
    assert.ok(!detail.run.storageError.error.includes(runsRoot), 'storageError 不暴露 runs 绝对路径')
    console.log(`  · storageError=${JSON.stringify(detail.run.storageError)}`)
  })

  console.log('runstore.js · §13.7 尾部倒读')

  await check('§13.7 desc 读 1000 条走尾部倒读：scannedEvents < total，不全量解析', async () => {
    const meta = await makeRun({ nodeTotal: 1 })
    created.push(meta.id)
    const started = Date.now()
    for (let batch = 0; batch < 10; batch += 1) {
      const events = []
      for (let index = 0; index < 200; index += 1) {
        events.push(event('tool/call', {
          runId: meta.id,
          nodeId: 'n_a',
          attemptId: 1,
          data: { name: 'bash', ok: true, argumentsDigest: 'x'.repeat(200) },
        }))
      }
      await store.appendEvents(runsRoot, meta.id, events, { now: NOW })
    }
    const descStart = process.hrtime.bigint()
    const desc = await store.readEvents(runsRoot, meta.id, { order: 'desc', limit: 1000 })
    const descMs = Number(process.hrtime.bigint() - descStart) / 1e6
    const ascStart = process.hrtime.bigint()
    const asc = await store.readEvents(runsRoot, meta.id, { limit: 1000 })
    const ascMs = Number(process.hrtime.bigint() - ascStart) / 1e6

    assert.equal(desc.events.length, 1000)
    assert.equal(desc.total, 2000)
    assert.equal(desc.truncated, true)
    assert.equal(desc.tail, true)
    assert.equal(desc.scannedEvents, 1000, 'desc 只解析 limit 条，不读全部 2000 条')
    assert.equal(asc.scannedEvents, 2000, 'asc 仍是全量读（对照组）')
    assert.deepEqual(desc.events.slice(0, 3).map(item => item.seq), [2000, 1999, 1998])
    console.log(`  · desc limit=1000: scannedEvents=${desc.scannedEvents}/2000, ${descMs.toFixed(1)}ms`)
    console.log(`  · asc  limit=1000: scannedEvents=${asc.scannedEvents}/2000, ${ascMs.toFixed(1)}ms`)
    console.log(`  · 造数耗时 ${Date.now() - started}ms（2000 条 tool/call）`)
  })

  await check('§13.8 listRuns / run.json 带 engine 与 started', async () => {
    const meta = await store.createRun(runsRoot, {
      flowId: 'flow-a', flowName: '默认流程', nodeTotal: 0, engine: 'stub',
    })
    created.push(meta.id)
    assert.equal(meta.engine, 'stub')
    const { runs } = await store.listRuns(runsRoot, { limit: 100 })
    const item = runs.find(run => run.id === meta.id)
    assert.equal(item.engine, 'stub')
    assert.equal(item.started, false)
    assert.equal(item.status, 'pending')
  })

  await check('§13.3 / §13.2 run/start 兼容：老引擎不调 startRun 时也能把 pending 切成 running', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    await store.appendEvents(runsRoot, meta.id, [
      event('run/start', {
        runId: meta.id, nodeId: undefined, attemptId: undefined,
        data: { flowId: 'flow-a', flowName: '默认流程', nodeTotal: 3, engine: 'stub' },
      }),
    ], { now: NOW })
    const after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.status, 'running')
    assert.equal(after.started, true)
    assert.equal(after.engine, 'stub')
  })
  await check('§13.2 跨进程互斥：6 个进程同时 claimLease / startRun，只有一个赢（BLOCKER-2 回归）', async () => {
    // 同进程的 withLock 挡不住多进程，所以这条必须真的起子进程去抢。
    const childCode = `
const [root, id, at, action] = process.argv.slice(1)
const store = await import(${JSON.stringify(new URL('../src/runstore.js', import.meta.url).href)})
const wait = Number(at) - Date.now()
if (wait > 0) await new Promise(done => setTimeout(done, wait))
try {
  if (action === 'start') await store.startRun(root, id, { now: new Date() })
  else await store.claimLease(root, id, { now: new Date(), host: 'child' })
  process.stdout.write('WON')
} catch (error) {
  process.stdout.write('LOST:' + (error && error.status))
}
`
    const race = (count, id, action) => new Promise((resolveRace, rejectRace) => {
      const at = String(Date.now() + 700)
      const results = []
      let done = 0
      for (let i = 0; i < count; i += 1) {
        const proc = spawn(
          process.execPath,
          ['--input-type=module', '-e', childCode, runsRoot, id, at, action],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        let out = ''
        let err = ''
        proc.stdout.on('data', chunk => { out += chunk })
        proc.stderr.on('data', chunk => { err += chunk })
        proc.on('error', rejectRace)
        proc.on('close', code => {
          results.push(out.trim() || `EXIT:${code}:${err.slice(0, 200)}`)
          done += 1
          if (done === count) resolveRace(results)
        })
      }
    })

    const leased = await makeRun()
    created.push(leased.id)
    const leaseResults = await race(6, leased.id, 'claim')
    assert.equal(leaseResults.filter(item => item === 'WON').length, 1,
      `6 个进程抢租约只能有一个赢：${leaseResults.join(' | ')}`)
    assert.equal(leaseResults.filter(item => item === 'LOST:409').length, 5, leaseResults.join(' | '))

    const started = await makeRun()
    created.push(started.id)
    const startResults = await race(6, started.id, 'start')
    assert.equal(startResults.filter(item => item === 'WON').length, 1,
      `6 个进程同时 startRun 只能有一个赢：${startResults.join(' | ')}`)
    assert.equal(startResults.filter(item => item === 'LOST:409').length, 5, startResults.join(' | '))
    const after = await store.readRunMeta(runsRoot, started.id)
    assert.equal(after.status, 'running')
  })
  await check('§13.6 过期租约 / 陈旧锁的接管也是单赢家（BLOCKER-2 复审回归）', async () => {
    // 复审抓到的问题：租约过期时「读 → 搬走 → 创建」不是 CAS，8 进程接管可能出现 2–4 个赢家。
    // 现在改成「接管选举」：先写意图文件、等一个窗口、按全序取最小，只有赢家删旧锁建新锁。
    const childCode = `
const [root, id, at, action] = process.argv.slice(1)
const store = await import(${JSON.stringify(new URL('../src/runstore.js', import.meta.url).href)})
const wait = Number(at) - Date.now()
if (wait > 0) await new Promise(done => setTimeout(done, wait))
try {
  if (action === 'start') await store.startRun(root, id, { now: new Date() })
  else await store.claimLease(root, id, { now: new Date(), host: 'child' })
  process.stdout.write('WON')
} catch (error) {
  process.stdout.write('LOST:' + (error && error.status))
}
`
    const race = (count, id, action) => new Promise((resolveRace, rejectRace) => {
      const at = String(Date.now() + 800)
      const results = []
      let done = 0
      for (let i = 0; i < count; i += 1) {
        const proc = spawn(
          process.execPath,
          ['--input-type=module', '-e', childCode, runsRoot, id, at, action],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        let out = ''
        let err = ''
        proc.stdout.on('data', chunk => { out += chunk })
        proc.stderr.on('data', chunk => { err += chunk })
        proc.on('error', rejectRace)
        proc.on('close', code => {
          results.push(out.trim() || `EXIT:${code}:${err.slice(0, 200)}`)
          done += 1
          if (done === count) resolveRace(results)
        })
      }
    })

    const leaseCounts = []
    for (let round = 0; round < 5; round += 1) {
      const meta = await makeRun()
      created.push(meta.id)
      // 一个 90s 前心跳的过期租约（模拟上一个引擎崩了）。
      writeFileSync(join(runsRoot, meta.id, 'lock.json'), JSON.stringify({
        pid: 999999,
        host: 'dead-host',
        ttlMs: 90000,
        acquiredAt: '2026-11-06T08:00:00.000Z',
        heartbeatAt: '2026-11-06T08:00:00.000Z',
      }, null, 2), { mode: 0o600 })
      const results = await race(8, meta.id, 'claim')
      leaseCounts.push(results.filter(item => item === 'WON').length)
    }
    assert.deepEqual(leaseCounts, [1, 1, 1, 1, 1],
      `过期租约接管必须每轮只有一个赢家：${leaseCounts.join(',')}`)

    const startCounts = []
    for (let round = 0; round < 3; round += 1) {
      const meta = await makeRun()
      created.push(meta.id)
      const lockPath = join(runsRoot, meta.id, 'start.lock')
      writeFileSync(lockPath, '999999-dead\n', { mode: 0o600 })
      const old = new Date(Date.now() - 60000)
      utimesSync(lockPath, old, old)
      const results = await race(8, meta.id, 'start')
      startCounts.push(results.filter(item => item === 'WON').length)
    }
    assert.deepEqual(startCounts, [1, 1, 1],
      `崩溃残留的 start.lock 接管必须每轮只有一个赢家：${startCounts.join(',')}`)
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${checks} 组通过`)
