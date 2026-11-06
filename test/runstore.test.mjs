#!/usr/bin/env node
/**
 * run 目录读写自检：建 run、追加、分页、过滤、删除、路径穿越、超大行与超量批次。
 *
 * 产物落在项目 `.tmp/` 下，不占系统 /tmp；不启动 dsh。
 */

import assert from 'node:assert/strict'
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  writeFileSync,
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

  await check('createRun：id 形状、元数据、目录 0700 / 文件 0600', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    assert.match(meta.id, /^r-[a-z0-9]+-[a-z0-9]{4}$/)
    assert.equal(meta.status, 'running')
    assert.equal(meta.nodeTotal, 3)
    assert.equal(meta.eventCount, 0)
    assert.equal(meta.seq, 0)
    const dir = join(runsRoot, meta.id)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, 'run.json')).mode & 0o777, 0o600)
    const disk = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
    assert.equal(disk.id, meta.id)
    assert.equal(disk.name, '测试 run')
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
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${checks} 组通过`)
