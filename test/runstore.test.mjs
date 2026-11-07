#!/usr/bin/env node
/**
 * run 目录读写自检：建 run、追加、分页、过滤、删除、路径穿越、超大行与超量批次。
 *
 * 产物落在项目 `.tmp/` 下，不占系统 /tmp；不启动 dsh。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { writeFile as writeFileAsync } from 'node:fs/promises'
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

/** 跑一个一次性 Node 子进程，收集 exit code / stdout / stderr（跨进程锁与租约竞态用）。 */
function runNodeScript(scriptPath, args) {
  return new Promise((resolveChild, rejectChild) => {
    const proc = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', chunk => { stdout += chunk })
    proc.stderr.on('data', chunk => { stderr += chunk })
    proc.on('error', rejectChild)
    proc.on('close', code => resolveChild({ code, stdout, stderr }))
  })
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

    // root 绕过文件权限位，`chmod 000` 在容器里仍然读得出来——这一档在 root 下不可能成立。
    // 不静默放过：明确打印「跳过该子项」，其余两档（目录 / 坏 JSON）照常断言。
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
    const { runs, skipped } = await store.listRuns(runsRoot, { limit: 100 })
    assert.ok(runs.some(run => run.id === good.id), '好 run 仍然要列出来')
    const expectedIds = asRoot ? [asDir, badJson] : [asDir, badJson, denied]
    for (const id of expectedIds) {
      const entry = skipped.find(item => item.id === id)
      assert.ok(entry, `${id} 应出现在 skipped`)
      assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0)
      assert.ok(!entry.reason.includes(runsRoot), 'skipped 原因不能带内部绝对路径')
    }
    assert.match(skipped.find(item => item.id === asDir).reason, /目录/)
    assert.match(skipped.find(item => item.id === badJson).reason, /JSON/)
    if (asRoot) {
      console.log('  · 以 root 运行：跳过「run.json 权限拒绝」子项（root 绕过权限位，该档无法构造）')
      assert.ok(!skipped.some(item => item.id === denied), 'root 下该 run 读得出来，不应出现在 skipped')
    } else {
      assert.match(skipped.find(item => item.id === denied).reason, /权限/)
    }
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
    // N2 起 renew / release 必须带 claim 的同一份 ownerId；pid@host 不再单独构成身份证明。
    const ownerId = 'owner-13-3'
    const lease = await store.claimLease(runsRoot, meta.id, { pid: 111, host: 'h1', ownerId, ttlMs: 60_000, now })
    assert.equal(lease.pid, 111)
    assert.equal(lease.host, 'h1')
    assert.equal(lease.ownerId, ownerId)
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
      pid: 111, host: 'h1', ownerId, ttlMs: 120_000, now: new Date(now.getTime() + 30_000),
    })
    assert.equal(renewed.ttlMs, 120_000)
    assert.equal(renewed.heartbeatAt, new Date(now.getTime() + 30_000).toISOString())

    await assert.rejects(
      () => store.releaseLease(runsRoot, meta.id, { pid: 222, host: 'h2' }),
      error => error.status === 409,
    )
    assert.equal(await store.releaseLease(runsRoot, meta.id, { pid: 111, host: 'h1', ownerId }), true)
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
    let failure = null
    try {
      await store.appendEvents(runsRoot, meta.id, [event('node/start', { runId: meta.id, nodeId: 'n_a' })], { now: NOW })
    } catch (error) {
      failure = error
    }
    assert.ok(failure, '写盘失败必须抛出')
    assert.equal(failure.status, 500)
    assert.equal(failure.field, 'storage')
    // G2-c：run.json 确实写得进去 → 文案才可以宣称「已标记 failed」。
    assert.match(failure.reason, /run 已被原子标记为 failed/)
    assert.match(failure.reason, /\.error 侧车文件/)
    const after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.status, 'failed', '文案与真实状态必须一致')
    assert.ok(existsSync(join(runsRoot, meta.id, '.error')))
    const detail = await store.readRunDetail(runsRoot, meta.id)
    assert.ok(detail.run.storageError)
    assert.equal(detail.run.storageError.code, 'EEXIST')
    assert.ok(!detail.run.storageError.error.includes(runsRoot), 'storageError 不暴露 runs 绝对路径')
    // G2-c：失败路径不能留下 0600 的 *.tmp-*（同一块盘满盘时会被放大）。
    const tmpLeft = readdirSync(join(runsRoot, meta.id)).filter(name => /\.tmp-\d+-\d+$/.test(name))
    assert.deepEqual(tmpLeft, [], `失败后不能残留临时文件：${tmpLeft.join(',')}`)
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

  console.log('runstore.js · D1 坏 run.json 不重建 / D2 nodeStatus 字节预算 / D3 patch 白名单')

  await check('D1 坏 run.json：拒绝覆盖、原文件不动、另存 run.json.corrupt-* 备份', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    await store.appendEvents(runsRoot, meta.id, [
      event('run/start', { runId: meta.id, nodeId: undefined, attemptId: undefined }),
      event('node/start', { runId: meta.id, nodeId: 'n_1', attemptId: 1 }),
    ], { now: NOW })

    const metaPath = join(runsRoot, meta.id, 'run.json')
    const broken = '{ broken json: "no closing brace"'
    writeFileSync(metaPath, broken)
    const before = statSync(metaPath)

    await assert.rejects(
      () => store.writeRunMeta(runsRoot, meta.id, { status: 'done' }),
      error => error.status === 500
        && error.code === 'EMETACORRUPT'
        && /run\.json\.corrupt-/.test(error.reason)
        && /拒绝用默认值覆盖/.test(error.reason),
    )
    // 关键断言：原文件一个字节都没动（旧实现会把它重建成默认 meta）。
    assert.equal(readFileSync(metaPath, 'utf8'), broken)
    assert.equal(statSync(metaPath).mtimeMs, before.mtimeMs, 'run.json 不应被重写')

    // 备份：内容与原文件一致、0600、同一份损坏内容只备份一次。
    const backupNames = () => readdirSync(join(runsRoot, meta.id))
      .filter(name => name.startsWith('run.json.corrupt-'))
    assert.equal(backupNames().length, 1, `应恰好有一份备份：${backupNames().join(',')}`)
    const backupPath = join(runsRoot, meta.id, backupNames()[0])
    assert.equal(readFileSync(backupPath, 'utf8'), broken)
    assert.equal(statSync(backupPath).mode & 0o777, 0o600)
    await assert.rejects(() => store.writeRunMeta(runsRoot, meta.id, { name: '再试一次' }))
    assert.equal(backupNames().length, 1, '重复失败不应堆出多份相同备份')

    // 坏 meta 不会被当成「不存在」：读取仍 null、追加拒绝且不分配 seq。
    assert.equal(await store.readRunMeta(runsRoot, meta.id), null)
    await assert.rejects(
      () => store.appendEvents(runsRoot, meta.id, event('node/start', { runId: meta.id }), { now: NOW }),
      error => error.status === 500 && error.code === 'EBADJSON',
    )
    // 事件文件没被改动：seq 仍是 1、2，不会因为坏 meta 出现重复序号。
    const runLines = readFileSync(join(runsRoot, meta.id, 'run.jsonl'), 'utf8').trim().split('\n')
    assert.deepEqual(runLines.map(line => JSON.parse(line).seq), [1])
    const nodeLines = readFileSync(join(runsRoot, meta.id, 'n_1', '1.jsonl'), 'utf8').trim().split('\n')
    assert.deepEqual(nodeLines.map(line => JSON.parse(line).seq), [2])
    // 列表侧：进 skipped，原因可读且不带内部绝对路径。
    const listed = await store.listRuns(runsRoot, { limit: 100 })
    const skipped = listed.skipped.find(item => item.id === meta.id)
    assert.ok(skipped, '坏 meta 的 run 应进 skipped')
    assert.match(skipped.reason, /JSON/)
    assert.ok(!skipped.reason.includes(runsRoot))
    assert.equal(readFileSync(metaPath, 'utf8'), broken)
    console.log(`  · 备份 ${backupNames()[0]}（${Buffer.byteLength(broken)} 字节），原文件未改动；追加被拒且 seq 未回退`)
  })

  await check('D1 超限 run.json 同样拒绝覆盖；只有文件真不存在才按新建写', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const metaPath = join(runsRoot, meta.id, 'run.json')
    const huge = `{"pad":"${'x'.repeat(1024 * 1024 + 16)}"}`
    writeFileSync(metaPath, huge)

    await assert.rejects(
      () => store.writeRunMeta(runsRoot, meta.id, { status: 'done' }),
      error => error.status === 500 && error.code === 'EMETACORRUPT' && /1MiB/.test(error.reason),
    )
    assert.equal(readFileSync(metaPath, 'utf8'), huge, '超限原文件也必须保持原样')
    const names = readdirSync(join(runsRoot, meta.id)).filter(name => name.startsWith('run.json.corrupt-'))
    assert.equal(names.length, 1)
    assert.equal(statSync(join(runsRoot, meta.id, names[0])).size, Buffer.byteLength(huge))
    const listed = await store.listRuns(runsRoot, { limit: 100 })
    assert.match(listed.skipped.find(item => item.id === meta.id).reason, /1MiB/)

    // 唯一的「新建」路径：run 目录在、run.json 真不存在（ENOENT）。
    const orphanId = 'r-orphan-dir'
    mkdirSync(join(runsRoot, orphanId), { recursive: true })
    created.push(orphanId)
    const fresh = await store.writeRunMeta(runsRoot, orphanId, { name: '从空目录恢复' })
    assert.equal(fresh.status, 'running')
    assert.equal(fresh.name, '从空目录恢复')
    assert.equal(fresh.createdAt, fresh.updatedAt)
    assert.ok(existsSync(join(runsRoot, orphanId, 'run.json')))
    console.log('  · 超限文件拒绝覆盖并备份；ENOENT 才允许按新建写入')
  })

  await check('D1 并发 appendEvents + writeRunMeta：seq 单调、不重复、不回退', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const jobs = []
    for (let i = 0; i < 20; i += 1) {
      jobs.push(store.appendEvents(runsRoot, meta.id, event('node/start', {
        runId: meta.id, nodeId: `n_${i}`, attemptId: 1,
      }), { now: NOW }))
      if (i % 5 === 0) jobs.push(store.writeRunMeta(runsRoot, meta.id, { name: `patch-${i}` }))
    }
    const results = await Promise.all(jobs)
    const seqs = results
      .filter(result => result && Array.isArray(result.events))
      .map(result => result.events[0].seq)
      .sort((a, b) => a - b)
    assert.equal(seqs.length, 20)
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, index) => index + 1))

    const after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.seq, 20)
    assert.equal(after.lastSeq, 20)
    assert.equal(after.eventCount, 20)

    // 落盘事件文件里的 seq 也必须是一份不重不漏。
    const nodeDirs = readdirSync(join(runsRoot, meta.id)).filter(name => /^n_\d+$/.test(name))
    assert.equal(nodeDirs.length, 20)
    const diskSeqs = []
    for (const name of nodeDirs) {
      const lines = readFileSync(join(runsRoot, meta.id, name, '1.jsonl'), 'utf8').trim().split('\n')
      for (const line of lines) diskSeqs.push(JSON.parse(line).seq)
    }
    diskSeqs.sort((a, b) => a - b)
    assert.deepEqual(diskSeqs, Array.from({ length: 20 }, (_, index) => index + 1))

    // 后续 patch 也不能把 seq 回退（writeRunMeta 以现有 meta 为底合并）。
    const patched = await store.writeRunMeta(runsRoot, meta.id, { status: 'done' })
    assert.equal(patched.seq, 20)
    assert.equal((await store.readRunMeta(runsRoot, meta.id)).seq, 20)
    console.log(`  · 20 并发追加 seq=${seqs[0]}..${seqs[seqs.length - 1]}，patch 后仍为 ${patched.seq}`)
  })

  const nodeStatusFixture = (count, options = {}) => {
    const { membersPerNode = 20, nameChars = 200, noteChars = 200, summaryChars = 0, blockers = 0 } = options
    const out = {}
    for (let n = 0; n < count; n += 1) {
      const nodeId = `n_${String(n).padStart(3, '0')}`
      out[nodeId] = {
        state: 'working',
        progress: 10,
        at: new Date(Date.UTC(2026, 10, 6, 0, 0, 0) + n * 60_000).toISOString(),
        ...(summaryChars > 0 ? { summary: 'S'.repeat(summaryChars) } : {}),
        members: Array.from({ length: membersPerNode }, (_, m) => ({
          name: `n${n}m${m}`.padEnd(nameChars, 'x'),
          state: 'working',
          ...(noteChars > 0 ? { note: 'y'.repeat(noteChars) } : {}),
          at: new Date(Date.UTC(2026, 0, 1) + (n * membersPerNode + m) * 60_000).toISOString(),
        })),
        ...(blockers > 0 ? { blockers: Array.from({ length: blockers }, (_, b) => `B${n}-${b}`.padEnd(200, 'z')) } : {}),
      }
    }
    return out
  }

  await check('D2 nodeStatus 预算：200 节点 × 满配成员 → 落盘 < 256KiB 且最近节点仍在', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const nodeStatus = nodeStatusFixture(200, { membersPerNode: 20, nameChars: 200, noteChars: 200, summaryChars: 2000, blockers: 20 })
    const beforeBytes = Buffer.byteLength(JSON.stringify(nodeStatus), 'utf8')
    assert.ok(beforeBytes > 1024 * 1024, `夹具应远超 1MiB（实际 ${beforeBytes}）`)

    const written = await store.writeRunMeta(runsRoot, meta.id, { nodeStatus })
    assert.equal(written.nodeStatusTruncated, true, '裁剪必须可观测')
    assert.ok(written.nodeStatusBudget, '返回值应带裁剪诊断')
    assert.ok(written.nodeStatusBudget.evictedNodes > 0, '满配夹具应触发节点淘汰')

    const metaPath = join(runsRoot, meta.id, 'run.json')
    const size = statSync(metaPath).size
    const disk = JSON.parse(readFileSync(metaPath, 'utf8'))
    const nodeBytes = Buffer.byteLength(JSON.stringify(disk.nodeStatus), 'utf8')
    assert.equal(disk.nodeStatusTruncated, true, 'nodeStatusTruncated 必须落盘')
    assert.ok(nodeBytes <= store.MAX_NODE_STATUS_BYTES,
      `落盘 nodeStatus ${nodeBytes} 字节应 ≤ 预算 ${store.MAX_NODE_STATUS_BYTES}`)
    assert.ok(size < 512 * 1024, `run.json ${size} 字节应显著低于 1MiB`)
    // 最近更新的节点必须保留、最旧的被淘汰（不是整块清空）。
    assert.ok(disk.nodeStatus.n_199, '最近节点必须保留')
    assert.equal(disk.nodeStatus.n_000, undefined, '最旧节点应被淘汰')
    assert.ok(Object.keys(disk.nodeStatus).length > 0)
    // 读回也带标志（不静默）。
    assert.equal((await store.readRunMeta(runsRoot, meta.id)).nodeStatusTruncated, true)
    console.log(`  · nodeStatus ${beforeBytes} → ${nodeBytes} 字节；run.json ${size} 字节；保留 ${Object.keys(disk.nodeStatus).length}/200 节点`)
  })

  await check('D2 裁剪顺序：先摘 members[].note，够用就不动节点与成员', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    // 32 节点 × 20 成员 × 200 字备注：带备注超预算，摘掉备注后回到预算内。
    const nodeStatus = nodeStatusFixture(32, { membersPerNode: 20, nameChars: 200, noteChars: 200 })
    const withNotes = Buffer.byteLength(JSON.stringify(nodeStatus), 'utf8')
    assert.ok(withNotes > store.MAX_NODE_STATUS_BYTES, `带备注应超预算（实际 ${withNotes}）`)

    const written = await store.writeRunMeta(runsRoot, meta.id, { nodeStatus })
    assert.equal(written.nodeStatusTruncated, true)
    assert.equal(written.nodeStatusBudget.removedNotes, 32 * 20)
    assert.equal(written.nodeStatusBudget.evictedMembers, 0, '摘 note 就够，不该淘汰成员')
    assert.equal(written.nodeStatusBudget.evictedNodes, 0, '也不该淘汰节点')

    const disk = JSON.parse(readFileSync(join(runsRoot, meta.id, 'run.json'), 'utf8'))
    assert.equal(Object.keys(disk.nodeStatus).length, 32)
    for (const entry of Object.values(disk.nodeStatus)) {
      assert.equal(entry.members.length, 20)
      assert.ok(entry.members.every(member => member.note === undefined), 'note 应被摘掉')
    }
    assert.ok(Buffer.byteLength(JSON.stringify(disk.nodeStatus), 'utf8') <= store.MAX_NODE_STATUS_BYTES)
    console.log(`  · ${withNotes} 字节 → ${Buffer.byteLength(JSON.stringify(disk.nodeStatus), 'utf8')} 字节（摘掉 640 条备注）`)
  })

  await check('D2 成员淘汰按最后更新时间：旧的先走，最新成员保留', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    // 60 节点 × 20 成员，备注已没有可摘 → 只能按时间淘汰成员。
    const nodeStatus = nodeStatusFixture(60, { membersPerNode: 20, nameChars: 200, noteChars: 0 })
    const beforeBytes = Buffer.byteLength(JSON.stringify(nodeStatus), 'utf8')
    assert.ok(beforeBytes > store.MAX_NODE_STATUS_BYTES, `夹具应超预算（实际 ${beforeBytes}）`)

    const written = await store.writeRunMeta(runsRoot, meta.id, { nodeStatus })
    assert.equal(written.nodeStatusTruncated, true)
    assert.ok(written.nodeStatusBudget.evictedMembers > 0, '应淘汰成员')
    assert.equal(written.nodeStatusBudget.evictedNodes, 0, '只淘汰成员就够，不该整块丢节点')

    const disk = JSON.parse(readFileSync(join(runsRoot, meta.id, 'run.json'), 'utf8'))
    assert.equal(Object.keys(disk.nodeStatus).length, 60, '节点不该被淘汰')
    const total = Object.values(disk.nodeStatus).reduce((sum, entry) => sum + entry.members.length, 0)
    assert.ok(total < 60 * 20)
    // 最新成员（n_59 的 m19）保留；最旧节点（n_0）的成员最先被淘汰。
    assert.ok(disk.nodeStatus.n_059.members.some(member => member.name.startsWith('n59m19')), '最新成员必须保留')
    assert.ok(disk.nodeStatus.n_000.members.every(member => !member.name.startsWith('n0m')),
      '最旧节点的成员应被淘汰')
    assert.ok(Buffer.byteLength(JSON.stringify(disk.nodeStatus), 'utf8') <= store.MAX_NODE_STATUS_BYTES)
    console.log(`  · 成员 ${beforeBytes} 字节 → 保留 ${total}/1200，淘汰 ${written.nodeStatusBudget.evictedMembers}`)
  })

  await check('D3 patch 白名单：sessions / nodeStatusTruncated 落盘，未知键可见 droppedKeys', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const written = await store.writeRunMeta(runsRoot, meta.id, {
      status: 'done',
      workspace: { id: 'ws-1', path: '/path/to/ws', isGit: true },
      worktree: { enabled: false, reason: 'not-a-repo' },
      sessionMode: 'injected',
      supervision: { enabled: true, wakes: 2, failures: 0 },
      nodeStatusTruncated: true,
      sessions: { n_1: 'session-a', n_2: 'session-b' },
      mysterious: 'should-be-dropped',
      anotherOne: 42,
    })
    assert.equal(written.id, meta.id)
    assert.equal(written.name, meta.name)
    assert.deepEqual(written.sessions, { n_1: 'session-a', n_2: 'session-b' })
    assert.deepEqual([...written.droppedKeys].sort(), ['anotherOne', 'mysterious'])
    // droppedKeys 是可读但不可枚举的诊断属性，不改变返回结构与落盘形状。
    assert.equal(Object.prototype.propertyIsEnumerable.call(written, 'droppedKeys'), false)
    assert.ok(!JSON.stringify(written).includes('droppedKeys'))

    const metaPath = join(runsRoot, meta.id, 'run.json')
    const disk = JSON.parse(readFileSync(metaPath, 'utf8'))
    assert.equal(disk.status, 'done')
    assert.deepEqual(disk.sessions, { n_1: 'session-a', n_2: 'session-b' })
    assert.equal(disk.nodeStatusTruncated, true)
    assert.equal(disk.workspace.id, 'ws-1')
    assert.equal(disk.worktree.enabled, false)
    assert.equal(disk.sessionMode, 'injected')
    assert.equal(disk.supervision.wakes, 2)
    assert.ok(!('mysterious' in disk))
    assert.ok(!('droppedKeys' in disk))

    const reread = await store.readRunMeta(runsRoot, meta.id)
    assert.deepEqual(reread.sessions, written.sessions)
    assert.equal(reread.nodeStatusTruncated, true)

    // sessions 是整表覆盖语义；null 表示清空（保留键、值为 null）。
    await store.writeRunMeta(runsRoot, meta.id, { sessions: { n_3: 'session-c' } })
    assert.deepEqual((await store.readRunMeta(runsRoot, meta.id)).sessions, { n_3: 'session-c' })
    await store.writeRunMeta(runsRoot, meta.id, { sessions: null })
    assert.equal((await store.readRunMeta(runsRoot, meta.id)).sessions, null)
    // nodeStatusTruncated 传 false 表示清除标志。
    await store.writeRunMeta(runsRoot, meta.id, { nodeStatusTruncated: false })
    assert.ok(!('nodeStatusTruncated' in (await store.readRunMeta(runsRoot, meta.id))))

    // 严格校验：类型不对 / 超上限 → 400，且不落盘（不是静默丢）。
    const bytesBefore = readFileSync(metaPath, 'utf8')
    const tooManySessions = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [`n_${index}`, `session-${index}`]),
    )
    const cases = [
      [{ sessions: { n_1: 123 } }, /sessions/],
      [{ sessions: tooManySessions }, /最多 512/],
      [{ sessions: 'nope' }, /sessions/],
      [{ sessionMode: 'weird' }, /sessionMode/],
      [{ status: 'weird' }, /status/],
      [{ nodeStatusTruncated: 'yes' }, /布尔/],
      [{ nodeStatus: 'nope' }, /nodeStatus/],
      [{ supervision: 'nope' }, /supervision/],
      [{ workspace: 'nope' }, /workspace/],
    ]
    for (const [patch, pattern] of cases) {
      await assert.rejects(
        () => store.writeRunMeta(runsRoot, meta.id, patch),
        error => error.status === 400 && pattern.test(error.reason),
        `应拒绝：${JSON.stringify(patch).slice(0, 60)}`,
      )
    }
    assert.equal(readFileSync(metaPath, 'utf8'), bytesBefore, '被拒的 patch 不能写盘')
    console.log('  · sessions / nodeStatusTruncated 落盘；未声明键进 droppedKeys；9 类非法 patch 全部 400 且未落盘')
  })

  await check('D3 startOptions：落盘 / 多余内层键可见 / 类型错 400 / 未传不凭空出现', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const metaPath = join(runsRoot, meta.id, 'run.json')
    // 未传过 → run.json 里不该出现 startOptions（不能凭空造一个空对象）。
    assert.ok(!('startOptions' in JSON.parse(readFileSync(metaPath, 'utf8'))))

    const options = { workspace: '/repo/demo', worktree: 'on' }
    const written = await store.writeRunMeta(runsRoot, meta.id, { startOptions: options })
    assert.deepEqual(written.startOptions, options)
    assert.equal(written.droppedKeys, undefined)
    assert.deepEqual(JSON.parse(readFileSync(metaPath, 'utf8')).startOptions, options)
    assert.deepEqual((await store.readRunMeta(runsRoot, meta.id)).startOptions, options)

    // 多余的内层键被丢弃，但必须可见（不静默）。
    const extra = await store.writeRunMeta(runsRoot, meta.id, {
      startOptions: { workspace: '/repo/demo', worktree: 'off', engine: 'stub', sessionId: 's-1' },
    })
    assert.deepEqual([...extra.droppedKeys].sort(), ['startOptions.engine', 'startOptions.sessionId'])
    assert.deepEqual(extra.startOptions, { workspace: '/repo/demo', worktree: 'off' })
    assert.deepEqual(JSON.parse(readFileSync(metaPath, 'utf8')).startOptions,
      { workspace: '/repo/demo', worktree: 'off' })

    // 显式空对象保留为空对象（与「未传 = 不出现」区分开）。
    await store.writeRunMeta(runsRoot, meta.id, { startOptions: {} })
    assert.deepEqual(JSON.parse(readFileSync(metaPath, 'utf8')).startOptions, {})

    // 不参与 nodeStatus 的字节预算：同一次 patch 里大 nodeStatus 被裁剪，startOptions 原样保留。
    const bigStatus = nodeStatusFixture(200, {
      membersPerNode: 20, nameChars: 200, noteChars: 200, summaryChars: 2000, blockers: 20,
    })
    await store.writeRunMeta(runsRoot, meta.id, { startOptions: options, nodeStatus: bigStatus })
    const afterBig = JSON.parse(readFileSync(metaPath, 'utf8'))
    assert.deepEqual(afterBig.startOptions, options, 'nodeStatus 裁剪不得影响 startOptions')
    assert.equal(afterBig.nodeStatusTruncated, true)

    // D1：run.json 损坏时 startOptions 也不可能被「重建」（拒绝覆盖 + 原文件不动）。
    const broken = '{ broken startOptions test'
    writeFileSync(metaPath, broken)
    await assert.rejects(
      () => store.writeRunMeta(runsRoot, meta.id, { startOptions: options }),
      error => error.status === 500 && error.code === 'EMETACORRUPT',
    )
    assert.equal(readFileSync(metaPath, 'utf8'), broken, '坏 run.json 必须保持原样')

    // 类型错一律 400，且不落盘。
    const clean = await makeRun()
    created.push(clean.id)
    const cleanPath = join(runsRoot, clean.id, 'run.json')
    const before = readFileSync(cleanPath, 'utf8')
    const badCases = [
      [{ startOptions: 'nope' }, /startOptions/],
      [{ startOptions: 123 }, /startOptions/],
      [{ startOptions: [] }, /startOptions/],
      [{ startOptions: { workspace: 123 } }, /workspace/],
      [{ startOptions: { workspace: '' } }, /workspace/],
      [{ startOptions: { workspace: '   ' } }, /workspace/],
      [{ startOptions: { worktree: 1 } }, /worktree/],
    ]
    for (const [patch, pattern] of badCases) {
      await assert.rejects(
        () => store.writeRunMeta(runsRoot, clean.id, patch),
        error => error.status === 400 && /startOptions/.test(error.field || '') && pattern.test(error.reason),
        `应拒绝：${JSON.stringify(patch)}`,
      )
    }
    assert.equal(readFileSync(cleanPath, 'utf8'), before, '被拒的 startOptions 不能写盘')
    // null 表示清除。
    await store.writeRunMeta(runsRoot, clean.id, { startOptions: { workspace: '/a', worktree: 'auto' } })
    assert.deepEqual((await store.readRunMeta(runsRoot, clean.id)).startOptions,
      { workspace: '/a', worktree: 'auto' })
    await store.writeRunMeta(runsRoot, clean.id, { startOptions: null })
    assert.equal((await store.readRunMeta(runsRoot, clean.id)).startOptions, null)
    console.log('  · startOptions 落盘/读回 deepEqual；内层多余键进 droppedKeys；7 类类型错 400 且未落盘')
  })

  console.log('runstore.js · G2 额外契约 limits')

  await check('limits 白名单：正整数键落盘/读回；类型错 400；未传不凭空出现', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const metaPath = join(runsRoot, meta.id, 'run.json')
    // 未传过 → run.json 里不该出现 limits（不能凭空造一个空对象）。
    assert.ok(!('limits' in JSON.parse(readFileSync(metaPath, 'utf8'))))

    const written = await store.writeRunMeta(runsRoot, meta.id, {
      limits: { runTimeoutMs: 600_000, nodeTimeoutMs: 120_000 },
      bogus: 1,
    })
    assert.deepEqual(written.limits, { runTimeoutMs: 600_000, nodeTimeoutMs: 120_000 })
    assert.deepEqual(written.droppedKeys, ['bogus'])
    assert.deepEqual(JSON.parse(readFileSync(metaPath, 'utf8')).limits,
      { runTimeoutMs: 600_000, nodeTimeoutMs: 120_000 })
    assert.deepEqual((await store.readRunMeta(runsRoot, meta.id)).limits,
      { runTimeoutMs: 600_000, nodeTimeoutMs: 120_000 })

    // 只给一个键 → 另一个不出现；内层多余键丢弃但可见（不静默）。
    await store.writeRunMeta(runsRoot, meta.id, { limits: { nodeTimeoutMs: 5_000 } })
    assert.deepEqual(JSON.parse(readFileSync(metaPath, 'utf8')).limits, { nodeTimeoutMs: 5_000 })
    const extra = await store.writeRunMeta(runsRoot, meta.id, {
      limits: { runTimeoutMs: 1, nodeTimeoutMs: 2, unknown: 3 },
    })
    assert.deepEqual(extra.droppedKeys, ['limits.unknown'])
    assert.deepEqual(extra.limits, { runTimeoutMs: 1, nodeTimeoutMs: 2 })

    // 类型错一律 400，且不落盘。
    const before = readFileSync(metaPath, 'utf8')
    const badCases = [
      [{ limits: 'nope' }, /limits/],
      [{ limits: 5 }, /limits/],
      [{ limits: [] }, /limits/],
      [{ limits: { runTimeoutMs: 0 } }, /runTimeoutMs/],
      [{ limits: { nodeTimeoutMs: -1 } }, /nodeTimeoutMs/],
      [{ limits: { runTimeoutMs: 1.5 } }, /runTimeoutMs/],
      [{ limits: { nodeTimeoutMs: '600' } }, /nodeTimeoutMs/],
      [{ limits: { runTimeoutMs: null } }, /runTimeoutMs/],
    ]
    for (const [patch, pattern] of badCases) {
      await assert.rejects(
        () => store.writeRunMeta(runsRoot, meta.id, patch),
        error => error.status === 400 && error.field === 'limits' && pattern.test(error.reason),
        `应拒绝：${JSON.stringify(patch)}`,
      )
    }
    assert.equal(readFileSync(metaPath, 'utf8'), before, '被拒的 limits 不能写盘')

    // null 表示清除（键保留、值为 null，与 sessions / startOptions 同口径）。
    await store.writeRunMeta(runsRoot, meta.id, { limits: null })
    assert.equal((await store.readRunMeta(runsRoot, meta.id)).limits, null)
    console.log('  · limits 落盘/读回 deepEqual；内层多余键进 droppedKeys；8 类类型错 400 且未落盘')
  })

  console.log('runstore.js · G2-a 先分配后写事件 / 半行 / 空洞 / 启动修复')

  await check('G2-a 事件已写、meta 未写：repairRunCounters 修正后 seq 不重复、增量读取不漏', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const metaPath = join(runsRoot, meta.id, 'run.json')
    await store.appendEvents(runsRoot, meta.id, [
      event('node/start', { runId: meta.id, nodeId: 'n_1', attemptId: 1 }),
      event('node/end', { runId: meta.id, nodeId: 'n_1', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ], { now: NOW })
    // 人为制造审计里的崩溃形态：事件 seq=2 已在磁盘，run.json 还停在 seq=1。
    const stale = JSON.parse(readFileSync(metaPath, 'utf8'))
    stale.seq = 1
    stale.lastSeq = 1
    stale.eventCount = 1
    writeFileSync(metaPath, `${JSON.stringify(stale, null, 2)}\n`)

    const repaired = await store.repairRunCounters(runsRoot, meta.id)
    assert.equal(repaired.repaired, true)
    assert.equal(repaired.seq, 2)
    assert.equal(repaired.eventCount, 2)
    const afterRepair = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(afterRepair.seq, 2)
    assert.equal(afterRepair.eventCount, 2)

    // 恢复后续写：必须是 seq=3，不能复用 2（旧实现的 bug）。
    const next = await store.appendEvents(runsRoot, meta.id,
      event('node/start', { runId: meta.id, nodeId: 'n_1', attemptId: 2 }), { now: NOW })
    assert.equal(next.events[0].seq, 3)
    const all = await store.readAllEvents(runsRoot, meta.id)
    assert.deepEqual(all.events.map(item => item.seq), [1, 2, 3], 'seq 不得重复')
    const incremental = await store.readEvents(runsRoot, meta.id, { since: 1, limit: 100 })
    assert.deepEqual(incremental.events.map(item => item.seq), [2, 3], '增量读取不能漏掉 seq=2')
    const tail = await store.readEvents(runsRoot, meta.id, { since: 2, order: 'desc', limit: 10 })
    assert.deepEqual(tail.events.map(item => item.seq), [3], '尾部倒读也要看到最新一条')
    console.log(`  · repair: seq ${stale.seq}→${repaired.seq}, eventCount ${stale.eventCount}→${repaired.eventCount}；续写 seq=${next.events[0].seq}`)
  })

  await check('G2-a sweep 恢复：旧 meta.seq 续写 run/end 不再产生重复 seq', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const metaPath = join(runsRoot, meta.id, 'run.json')
    await store.startRun(runsRoot, meta.id, { now: NOW })
    await store.appendEvents(runsRoot, meta.id, [
      event('node/start', { runId: meta.id, nodeId: 'n_1', attemptId: 1 }),
      event('node/end', { runId: meta.id, nodeId: 'n_1', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ], { now: NOW })
    const stale = JSON.parse(readFileSync(metaPath, 'utf8'))
    stale.seq = 1
    stale.lastSeq = 1
    stale.eventCount = 1
    writeFileSync(metaPath, `${JSON.stringify(stale, null, 2)}\n`)
    // 一个 90s 前心跳的过期租约（模拟引擎崩溃）。
    writeFileSync(join(runsRoot, meta.id, 'lock.json'), JSON.stringify({
      pid: 999_999,
      host: 'dead-host',
      ttlMs: 90_000,
      acquiredAt: '2026-11-06T08:00:00.000Z',
      heartbeatAt: '2026-11-06T08:00:00.000Z',
    }, null, 2), { mode: 0o600 })

    const swept = await store.sweepExpiredLeases(runsRoot, { now: new Date('2026-11-06T12:00:00.000Z') })
    assert.ok(swept.includes(meta.id))
    const all = await store.readAllEvents(runsRoot, meta.id)
    const seqs = all.events.map(item => item.seq)
    assert.deepEqual(seqs, [1, 2, 3], `恢复续写不得重复 seq（实际 ${seqs.join(',')}）`)
    assert.equal(new Set(seqs).size, seqs.length)
    const runEnd = all.events.find(item => item.kind === 'run/end')
    assert.equal(runEnd.seq, 3)
    const after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.status, 'failed')
    assert.equal(after.seq, 3)
    assert.equal(after.eventCount, 3)
    console.log(`  · sweep 续写 seq=${seqs.join(',')}（无重复），run/end@${runEnd.seq}`)
  })

  await check('G2-a 文件末尾半行：新事件另起一行、坏行只 skip 一条', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    await store.appendEvents(runsRoot, meta.id,
      event('node/start', { runId: meta.id, nodeId: 'n_1', attemptId: 1 }), { now: NOW })
    const nodeFile = join(runsRoot, meta.id, 'n_1', '1.jsonl')
    // 模拟「seq=2 已经分配进 run.json，但事件只写了半行」：先抬 meta.seq，再留半行。
    const reserved = JSON.parse(readFileSync(join(runsRoot, meta.id, 'run.json'), 'utf8'))
    reserved.seq = 2
    reserved.lastSeq = 2
    writeFileSync(join(runsRoot, meta.id, 'run.json'), `${JSON.stringify(reserved, null, 2)}\n`)
    // 崩溃 / 写满留下的半行：最后一个字节不是换行。
    appendFileSync(nodeFile, '{"v":1,"seq":2,"kind":"node/end"')
    const beforeBytes = readFileSync(nodeFile)
    assert.notEqual(beforeBytes[beforeBytes.length - 1], 0x0a)

    const appended = await store.appendEvents(runsRoot, meta.id,
      event('node/start', { runId: meta.id, nodeId: 'n_1', attemptId: 1 }), { now: NOW })
    assert.equal(appended.events[0].seq, 3)
    const bytes = readFileSync(nodeFile)
    assert.equal(bytes[bytes.length - 1], 0x0a, '追加后文件必须以换行结尾')
    const text = readFileSync(nodeFile, 'utf8')
    // 三个 `{"v":1` 各自一行：半行没有被新事件粘进去（否则只会有两处 JSON 起点）。
    assert.equal(text.split('{"v":1').length - 1, 3, '半行与新事件不能粘连')
    const lines = text.trim().split('\n')
    assert.equal(lines.length, 3)
    assert.ok(lines[1].startsWith('{"v":1,"seq":2'), '坏半行应保持原样独立成行')
    assert.equal(JSON.parse(lines[2]).seq, 3)

    const page = await store.readEvents(runsRoot, meta.id, { limit: 10 })
    assert.deepEqual(page.events.map(item => item.seq), [1, 3])
    assert.equal(page.skipped, 1, '只有那条坏半行被 skip')
    const desc = await store.readEvents(runsRoot, meta.id, { order: 'desc', limit: 2 })
    assert.equal(desc.events[0].seq, 3, '尾部倒读仍能看到新事件')
    console.log(`  · 半行 → 新事件 seq=${appended.events[0].seq}；readAll seqs=[1,3]，skipped=1`)
  })

  await check('G2-a 空洞（跳过 seq=2 写 3）：读取侧容忍、repair 把 seq 抬到 max(seq)', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    await store.appendEvents(runsRoot, meta.id, [
      event('node/start', { runId: meta.id, nodeId: 'n_1', attemptId: 1 }),
      event('node/end', { runId: meta.id, nodeId: 'n_1', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ], { now: NOW })
    const nodeFile = join(runsRoot, meta.id, 'n_1', '1.jsonl')
    const events = readFileSync(nodeFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(events.map(item => item.seq), [1, 2])
    // 把第 2 条改写成 seq=3：磁盘出现 [1,3] 的空洞，而 meta 里 seq 还是 2。
    events[1].seq = 3
    writeFileSync(nodeFile, events.map(item => `${JSON.stringify(item)}\n`).join(''))

    const page = await store.readEvents(runsRoot, meta.id, { limit: 10 })
    assert.deepEqual(page.events.map(item => item.seq), [1, 3], '空洞不能让读取报错')
    assert.equal(page.total, 2)
    assert.equal(page.skipped, 0)
    const all = await store.readAllEvents(runsRoot, meta.id)
    assert.deepEqual(all.events.map(item => item.seq), [1, 3])
    const desc = await store.readEvents(runsRoot, meta.id, { order: 'desc', limit: 10 })
    assert.deepEqual(desc.events.map(item => item.seq), [3, 1])

    const repaired = await store.repairRunCounters(runsRoot, meta.id)
    assert.equal(repaired.seq, 3, 'meta.seq 要抬到磁盘 max(seq)')
    assert.equal(repaired.eventCount, 2)
    const next = await store.appendEvents(runsRoot, meta.id,
      event('node/start', { runId: meta.id, nodeId: 'n_1', attemptId: 2 }), { now: NOW })
    assert.equal(next.events[0].seq, 4)
    console.log('  · 磁盘 seq=[1,3] 读取正常；repair seq=3；续写 seq=4（空洞保留、不重复）')
  })

  console.log('runstore.js · G2-b 跨进程 meta.lock')

  await check('G2-b 跨进程：2 个真实子进程各写 40 条 → 磁盘 80 / eventCount 80 / 重复 0', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    // 这条必须真跨进程：同进程的 Promise.all 会被 withLock 兜住，测不到跨进程丢写。
    const childCode = `
const [root, id, nodeId, count] = process.argv.slice(1)
const store = await import(${JSON.stringify(new URL('../src/runstore.js', import.meta.url).href)})
const total = Number(count)
for (let i = 0; i < total; i += 1) {
  await store.appendEvents(root, id, {
    v: 1,
    ts: new Date().toISOString(),
    kind: 'tool/call',
    traceId: 'tr-' + nodeId,
    memberId: null,
    nodeId,
    attemptId: 1,
    data: { name: 'bash', ok: true },
  })
}
process.stdout.write('OK:' + total)
`
    const runChild = nodeId => new Promise((resolveChild, rejectChild) => {
      const proc = spawn(
        process.execPath,
        ['--input-type=module', '-e', childCode, runsRoot, meta.id, nodeId, '40'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let out = ''
      let err = ''
      proc.stdout.on('data', chunk => { out += chunk })
      proc.stderr.on('data', chunk => { err += chunk })
      proc.on('error', rejectChild)
      proc.on('close', code => {
        resolveChild(out.trim() || `EXIT:${code}:${err.slice(0, 400)}`)
      })
    })
    const results = await Promise.all([runChild('n_a'), runChild('n_b')])
    assert.deepEqual(results, ['OK:40', 'OK:40'])

    const diskSeqs = []
    for (const nodeId of ['n_a', 'n_b']) {
      const file = join(runsRoot, meta.id, nodeId, '1.jsonl')
      for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
        diskSeqs.push(JSON.parse(line).seq)
      }
    }
    const metaNow = await store.readRunMeta(runsRoot, meta.id)
    const duplicates = diskSeqs.length - new Set(diskSeqs).size
    console.log(`  · 磁盘 ${diskSeqs.length} 条 / eventCount ${metaNow.eventCount} / 重复 seq ${duplicates}`)
    assert.equal(diskSeqs.length, 80)
    assert.equal(metaNow.eventCount, 80, 'eventCount 必须与磁盘条数一致')
    assert.equal(metaNow.seq, 80)
    assert.equal(duplicates, 0, `跨进程写入出现重复 seq：${[...diskSeqs].sort((a, b) => a - b).join(',')}`)
    assert.equal(Math.min(...diskSeqs), 1)
    assert.equal(Math.max(...diskSeqs), 80)
    // 无空洞：跨进程锁内完成分配，seq 就是 1..80 的不重不漏一份。
    assert.deepEqual([...diskSeqs].sort((a, b) => a - b), Array.from({ length: 80 }, (_, index) => index + 1))
  })

  console.log('runstore.js · G2-c 满盘失败路径与临时文件')

  await check('G2-c 满盘（ENOSPC 注入）：文案与实际状态一致、.error 保留、无 *.tmp-* 残留', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const dir = join(runsRoot, meta.id)
    const enospc = () => {
      const error = new Error('ENOSPC: no space left on device, write')
      error.code = 'ENOSPC'
      return error
    }
    // 变体 A：run.json 写不进去，但 .error 侧车还能写 → 文案必须说「状态未知」并保留 .error。
    store.__setWriteFileHook(async (path, data, options) => {
      if (String(path).startsWith(dir) && String(path).includes('run.json.tmp-')) throw enospc()
      return writeFileAsync(path, data, options)
    })
    let failureA = null
    try {
      await store.appendEvents(runsRoot, meta.id, event('node/start', { runId: meta.id }), { now: NOW })
    } catch (error) {
      failureA = error
    } finally {
      store.__setWriteFileHook(null)
    }
    assert.ok(failureA)
    assert.equal(failureA.status, 500)
    assert.equal(failureA.field, 'storage')
    assert.match(failureA.reason, /run\.json 也写不进去/)
    assert.match(failureA.reason, /run 状态未知/)
    assert.ok(!/已标记为 failed/.test(failureA.reason), 'run.json 没写成时不能谎报已标记 failed')
    const afterA = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(afterA.status, 'pending', '文案说状态未知时 run.json 必须还是原状态')
    assert.equal(afterA.seq, 0)
    assert.equal(afterA.eventCount, 0)
    assert.ok(existsSync(join(dir, '.error')), '.error 写成功了就必须保留')
    assert.equal(JSON.parse(readFileSync(join(dir, '.error'), 'utf8')).code, 'ENOSPC')
    const tmpA = readdirSync(dir).filter(name => /\.tmp-\d+-\d+$/.test(name))
    assert.deepEqual(tmpA, [], `失败后不能残留 *.tmp-*：${tmpA.join(',')}`)
    console.log(`  · 变体 A 文案=${failureA.reason} / 实际 status=${afterA.status}`)

    // 变体 B：连 .error 都写不进去（同一块满盘）→ 文案必须同时承认两者都失败。
    const metaB = await makeRun()
    created.push(metaB.id)
    const dirB = join(runsRoot, metaB.id)
    store.__setWriteFileHook(async (path, data, options) => {
      if (String(path).startsWith(dirB) && String(path).includes('.tmp-')) throw enospc()
      return writeFileAsync(path, data, options)
    })
    let failureB = null
    try {
      await store.appendEvents(runsRoot, metaB.id, event('node/start', { runId: metaB.id }), { now: NOW })
    } catch (error) {
      failureB = error
    } finally {
      store.__setWriteFileHook(null)
    }
    assert.ok(failureB)
    assert.match(failureB.reason, /run\.json 与 \.error 都写不进去/)
    assert.match(failureB.reason, /run 状态未知/)
    const afterB = await store.readRunMeta(runsRoot, metaB.id)
    assert.equal(afterB.status, 'pending')
    assert.equal(afterB.seq, 0)
    assert.ok(!existsSync(join(dirB, '.error')), '.error 没写成时不能凭空出现')
    const tmpB = readdirSync(dirB).filter(name => /\.tmp-\d+-\d+$/.test(name))
    assert.deepEqual(tmpB, [], `失败后不能残留 *.tmp-*：${tmpB.join(',')}`)
    console.log(`  · 变体 B 文案=${failureB.reason} / 实际 status=${afterB.status}`)
  })

  await check('G2-c 启动清理：只删「久到不可能是正在写」的 *.tmp-*，正常文件不动', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const dir = join(runsRoot, meta.id)
    mkdirSync(join(dir, 'n_1'), { recursive: true })
    const stale = [
      join(dir, 'run.json.tmp-1234-0'),
      join(dir, 'lock.json.tmp-1234-1'),
      join(dir, 'n_1', '1.jsonl.tmp-1234-2'),
    ]
    for (const path of stale) writeFileSync(path, 'partial')
    // 关键回归：**刚写出来的临时文件不能被删**。插件挂载时的启动恢复是
    // fire-and-forget，会与另一个引擎的原子写并发；无条件全删会让那条 rename
    // 拿到 ENOENT，`appendEvents` 的 catch 于是把一个跑完的 run 标成 failed
    //（事件流里是 run/end done）——这正是本仓 `npm test` 偶发红的原因。
    const fresh = await store.cleanupTempFiles(runsRoot, meta.id)
    assert.deepEqual(fresh, [], `刚写的临时文件不该被删：${fresh.join(',')}`)
    for (const path of stale) assert.ok(existsSync(path), `${path} 生命周期只有毫秒级，刚写完不算遗留`)

    // 按 mtime 变老（10 分钟前）→ 默认阈值（60s）就会认定是崩溃残留。
    const old = new Date(Date.now() - 10 * 60 * 1000)
    for (const path of stale) utimesSync(path, old, old)
    const removed = await store.cleanupTempFiles(runsRoot, meta.id)
    assert.equal(removed.length, 3, `应清掉 3 个遗留临时文件：${removed.join(',')}`)
    for (const path of stale) assert.ok(!existsSync(path), `${path} 应被清掉`)
    assert.ok(existsSync(join(dir, 'run.json')), '正常文件不能被误删')

    // 不带 runId 的整目录清理同样带年龄闸门；显式 minAgeMs: 0 才无条件清。
    const allTmp = join(dir, '.usage.json.tmp-99-0')
    writeFileSync(allTmp, 'x')
    const keptByDefault = await store.cleanupTempFiles(runsRoot)
    assert.deepEqual(keptByDefault, [], '整目录清理也必须放过刚写的临时文件')
    assert.ok(existsSync(allTmp))
    const allRemoved = await store.cleanupTempFiles(runsRoot, undefined, { minAgeMs: 0 })
    assert.ok(allRemoved.some(name => name.includes('.usage.json.tmp-')), 'minAgeMs:0 应命中最新的临时文件')
    assert.ok(!existsSync(allTmp))
    console.log(`  · 默认放过 ${stale.length} 个新文件、清掉同名的老文件；minAgeMs:0 才无条件清`)
  })

  await check('G2-c 原子写在临时文件被外部删掉时重试一次（不再把跑完的 run 标成 failed）', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const dir = join(runsRoot, meta.id)
    const runJson = join(dir, 'run.json')
    const before = readFileSync(runJson, 'utf8')
    // 模拟「启动清理 / 杀毒 / watcher 在 write 与 rename 之间删掉临时文件」：
    // 钩子照常落盘，然后立刻把临时文件删掉，让随后的 rename 拿到 ENOENT。
    let deleted = 0
    store.__setWriteFileHook(async (path, data, options) => {
      await writeFileAsync(path, data, options)
      // 只删第一次：外层是「一次性的外部清理」，重试用的是新文件名，不该再被删。
      if (path.includes('.tmp-') && deleted === 0) {
        rmSync(path, { force: true })
        deleted += 1
      }
    })
    try {
      // 第一次尝试被删 → 第二次成功；最终 run.json 必须被更新，且不残留临时文件。
      const written = await store.writeRunMeta(runsRoot, meta.id, { name: '重试后写入' })
      assert.equal(written.name, '重试后写入')
      assert.equal(deleted, 1, `第一次尝试应被删掉一次，实际 ${deleted}`)
      const text = readFileSync(runJson, 'utf8')
      assert.notEqual(text, before, 'run.json 必须被更新')
      assert.equal(JSON.parse(text).name, '重试后写入')
      const residue = readdirSync(dir).filter(name => /\.tmp-\d+-\d+$/.test(name))
      assert.deepEqual(residue, [], `失败尝试不能留下临时文件：${residue.join(',')}`)
    } finally {
      store.__setWriteFileHook(null)
    }
    // 钩子撤掉后普通写入照常工作。
    const after = await store.writeRunMeta(runsRoot, meta.id, { name: '钩子已撤' })
    assert.equal(after.name, '钩子已撤')
    console.log(`  · 第一次 attempt 被删 ${deleted} 次 → 重试成功；钩子撤销后写入正常`)
  })

  console.log('runstore.js · G2-d 租约自愈')

  await check('G2-d 过期租约：持有者 renew 就地 re-claim（不删文件），非持有者 409 且不删', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const t0 = new Date('2026-11-06T12:00:00.000Z')
    await store.startRun(runsRoot, meta.id, { now: t0 })
    // N2 起 renew 必须带 claim 的同一份 ownerId。
    const ownerId = 'owner-g2d'
    await store.claimLease(runsRoot, meta.id, { pid: 111, host: 'h1', ownerId, ttlMs: 1_000, now: t0 })
    const later = new Date(t0.getTime() + 5_000)
    const lockPath = join(runsRoot, meta.id, 'lock.json')

    // 非持有者续租过期租约：409，且租约文件必须还在（旧实现「先删再抛」）。
    await assert.rejects(
      () => store.renewLease(runsRoot, meta.id, { pid: 222, host: 'h2', now: later }),
      error => error.status === 409,
    )
    assert.ok(existsSync(lockPath), '非持有者续租失败不能删掉租约文件')

    // 持有者自己：就地 re-claim（心跳刷新、acquiredAt 保留、文件始终在）。
    const renewed = await store.renewLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId, ttlMs: 60_000, now: later,
    })
    assert.equal(renewed.pid, 111)
    assert.equal(renewed.heartbeatAt, later.toISOString())
    assert.equal(renewed.acquiredAt, t0.toISOString(), 're-claim 保留 acquiredAt')
    assert.ok(existsSync(lockPath))
    const read = await store.readLease(runsRoot, meta.id, { now: later })
    assert.ok(read, 're-claim 后租约必须立刻可读（run 不会卡 running）')
    assert.equal(read.heartbeatAt, later.toISOString())

    // 租约未过期 → sweep 不能把这个 run 当崩溃残留。
    const notSwept = await store.sweepExpiredLeases(runsRoot, { now: new Date(later.getTime() + 1_000) })
    assert.ok(!notSwept.includes(meta.id))
    assert.equal((await store.readRunMeta(runsRoot, meta.id)).status, 'running')
    console.log(`  · 过期租约 re-claim：heartbeat ${t0.toISOString()} → ${renewed.heartbeatAt}；sweep 未误收`)
  })

  await check('G2-d 0 字节 lock.json：可被接管（不再是五次后 409）', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    await store.startRun(runsRoot, meta.id, { now: NOW })
    const lockPath = join(runsRoot, meta.id, 'lock.json')
    // 进程在 open('wx') 与写内容之间被杀：0 字节 lock.json（旧实现解析失败 = 永远无法接管）。
    writeFileSync(lockPath, '')
    const claimed = await store.claimLease(runsRoot, meta.id, {
      pid: 444, host: 'h4', now: new Date('2026-11-06T12:00:00.000Z'),
    })
    assert.equal(claimed.pid, 444)
    const disk = JSON.parse(readFileSync(lockPath, 'utf8'))
    assert.equal(disk.pid, 444, '接管后 lock.json 必须是完整可解析内容')
    assert.equal((await store.readLease(runsRoot, meta.id,
      { now: new Date('2026-11-06T12:00:00.000Z') })).pid, 444)
    console.log(`  · 0 字节 lock.json → 接管成功 pid=${disk.pid}，内容可解析`)
  })

  await check('G2-d started=true 无租约 / 租约坏掉：sweep 都按崩溃残留收口 failed', async () => {
    // ① started=true 但根本没有 lock.json（旧实现 `if (!lease) continue` 永不收口）。
    const missing = await makeRun()
    created.push(missing.id)
    await store.startRun(runsRoot, missing.id, { now: NOW })
    assert.ok(!existsSync(join(runsRoot, missing.id, 'lock.json')))
    const swept = await store.sweepExpiredLeases(runsRoot, { now: NOW })
    assert.ok(swept.includes(missing.id), 'started=true 且无租约的 running run 必须被收口')
    const afterMissing = await store.readRunMeta(runsRoot, missing.id)
    assert.equal(afterMissing.status, 'failed')
    const allMissing = await store.readAllEvents(runsRoot, missing.id)
    const runEndMissing = allMissing.events.find(item => item.kind === 'run/end')
    assert.ok(runEndMissing)
    assert.match(runEndMissing.data.reason, /引擎中断/)
    assert.match(runEndMissing.data.reason, /租约文件缺失/)

    // ② lock.json 不可解析（半写 JSON）→ 也收口，并把坏文件清掉。
    const corrupt = await makeRun()
    created.push(corrupt.id)
    await store.startRun(runsRoot, corrupt.id, { now: NOW })
    const corruptLock = join(runsRoot, corrupt.id, 'lock.json')
    writeFileSync(corruptLock, '{"pid":')
    const sweptCorrupt = await store.sweepExpiredLeases(runsRoot, { now: NOW })
    assert.ok(sweptCorrupt.includes(corrupt.id))
    assert.equal((await store.readRunMeta(runsRoot, corrupt.id)).status, 'failed')
    assert.ok(!existsSync(corruptLock), '不可解析的租约文件应被清掉')
    const allCorrupt = await store.readAllEvents(runsRoot, corrupt.id)
    const runEndCorrupt = allCorrupt.events.find(item => item.kind === 'run/end')
    assert.match(runEndCorrupt.data.reason, /不可解析/)

    // ③ started=false 的 running 壳子不在收口范围（保持只收 started 的旧口径）。
    const shell = await makeRun()
    created.push(shell.id)
    await store.writeRunMeta(runsRoot, shell.id, { status: 'running' })
    const sweptShell = await store.sweepExpiredLeases(runsRoot, { now: NOW })
    assert.ok(!sweptShell.includes(shell.id))
    assert.equal((await store.readRunMeta(runsRoot, shell.id)).status, 'running')
    console.log('  · 无租约 / 坏租约的 started run 均收口 failed；started=false 的壳子未被误收')
  })

  await check('nodeStatus 白名单 attempt：非负整数保留，坏值只丢该键、节点其它字段照常', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const nodeStatus = {
      n_good: { state: 'working', progress: 40, summary: '进行中', attempt: 3, at: '2026-11-06T10:00:00.000Z' },
      n_zero: { state: 'done', progress: 100, attempt: 0 },
      n_str: { state: 'done', progress: 100, attempt: 'x' },
      n_neg: { state: 'working', progress: 10, attempt: -2 },
      n_frac: { state: 'working', progress: 20, attempt: 1.5 },
      n_null: { state: 'blocked', progress: 0, attempt: null },
      n_bool: { state: 'working', progress: 5, attempt: true },
      n_none: { state: 'working', progress: 0 },
    }
    const written = await store.writeRunMeta(runsRoot, meta.id, { nodeStatus })
    assert.equal(written.nodeStatus.n_good.attempt, 3, 'writeRunMeta 返回值应保留 attempt')
    assert.equal(written.nodeStatus.n_zero.attempt, 0)

    const disk = JSON.parse(readFileSync(join(runsRoot, meta.id, 'run.json'), 'utf8'))
    assert.equal(disk.nodeStatus.n_good.attempt, 3)
    assert.equal(disk.nodeStatus.n_good.summary, '进行中', '其它字段必须保留')
    assert.equal(disk.nodeStatus.n_zero.attempt, 0, 'attempt=0 是合法的非负整数')
    for (const [nodeId, expected] of [
      ['n_str', { state: 'done', progress: 100 }],
      ['n_neg', { state: 'working', progress: 10 }],
      ['n_frac', { state: 'working', progress: 20 }],
      ['n_null', { state: 'blocked', progress: 0 }],
      ['n_bool', { state: 'working', progress: 5 }],
    ]) {
      assert.ok(!('attempt' in disk.nodeStatus[nodeId]), `${nodeId}.attempt 应被丢弃：${JSON.stringify(disk.nodeStatus[nodeId])}`)
      // 只丢 attempt 一个键，节点本身与其它字段照常保留。
      assert.equal(disk.nodeStatus[nodeId].state, expected.state)
      assert.equal(disk.nodeStatus[nodeId].progress, expected.progress)
    }
    assert.ok(!('attempt' in disk.nodeStatus.n_none))

    // 读回（readMetaUnlocked 再归一化一次）结果一致。
    const reread = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(reread.nodeStatus.n_good.attempt, 3)
    assert.equal(reread.nodeStatus.n_zero.attempt, 0)
    assert.ok(!('attempt' in reread.nodeStatus.n_str))
    assert.equal(reread.nodeStatus.n_str.state, 'done', '坏 attempt 不能连节点一起丢')
    assert.equal(reread.nodeStatus.n_neg.progress, 10)
    console.log('  · attempt=3 / 0 保留；\'x\' / -2 / 1.5 / null / true 只丢该键，节点与其它字段保留')
  })

  await check('worktree 嵌套白名单：root(绝对路径) / warnings(字符串数组) 透传，坏值只丢该键', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const metaPath = join(runsRoot, meta.id, 'run.json')
    const good = {
      enabled: true,
      reason: 'ok',
      decidedBy: 'auto',
      path: '/repo/demo/.wt/run-1',
      branch: 'flow/run-1',
      baseCommit: 'abc123',
      root: '/repo/demo/.wt/run-1',
      warnings: ['工作区有未提交修改，已按快照执行', '敏感文件 .env 不会复制'],
    }
    const written = await store.writeRunMeta(runsRoot, meta.id, { worktree: good })
    assert.deepEqual(written.worktree, good)
    assert.deepEqual(JSON.parse(readFileSync(metaPath, 'utf8')).worktree, good)
    assert.deepEqual((await store.readRunMeta(runsRoot, meta.id)).worktree, good, '读回必须原样保留')

    // 坏值只丢该键：root 非字符串 / 相对路径、warnings 非数组 → 两个键都不出现，其它字段照常。
    const bad = await store.writeRunMeta(runsRoot, meta.id, {
      worktree: {
        root: 123,
        warnings: 'oops',
        enabled: true,
        reason: 'dirty',
        path: '/repo/demo',
        branch: 'feat',
      },
    })
    assert.ok(!('root' in bad.worktree), 'root 非字符串必须丢弃')
    assert.ok(!('warnings' in bad.worktree), 'warnings 非数组必须忽略')
    assert.deepEqual(bad.worktree, {
      enabled: true, reason: 'dirty', path: '/repo/demo', branch: 'feat',
    })
    const diskBad = JSON.parse(readFileSync(metaPath, 'utf8')).worktree
    assert.deepEqual(diskBad, { enabled: true, reason: 'dirty', path: '/repo/demo', branch: 'feat' })
    assert.deepEqual((await store.readRunMeta(runsRoot, meta.id)).worktree, diskBad)

    // root 必须是绝对路径：相对路径丢弃；字符串数组以外的 warning 项被过滤、每条截到 500、最多 20 条。
    const noisy = Array.from({ length: 25 }, (_, index) => `w${index}`)
    noisy[1] = 42
    noisy[2] = ''
    noisy[3] = '   '
    noisy[4] = 'x'.repeat(600)
    const mixed = await store.writeRunMeta(runsRoot, meta.id, {
      worktree: { enabled: true, root: 'relative/path', warnings: noisy },
    })
    assert.ok(!('root' in mixed.worktree), '相对路径的 root 必须丢弃')
    assert.equal(mixed.worktree.warnings.length, 20, 'warnings 最多 20 条')
    assert.deepEqual(mixed.worktree.warnings.slice(0, 3), ['w0', 'x'.repeat(500), 'w5'])
    assert.ok(mixed.worktree.warnings.every(item => item.length <= 500 && item.trim() !== ''))

    // 两者都可缺省：不写就不出现。
    const plain = await store.writeRunMeta(runsRoot, meta.id, { worktree: { enabled: false } })
    assert.ok(!('root' in plain.worktree))
    assert.ok(!('warnings' in plain.worktree))
    console.log('  · root/warnings 透传；root=123 / 相对路径 → 丢键；warnings 非数组 → 忽略、非法项过滤、每条≤500、最多 20')
  })

  console.log('runstore.js · D4 machine 状态机快照（24 KiB 独立预算）')

  await check('D4 machine：正常写入 / 落盘 / 读回 deepEqual（含 savedAt）', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const metaPath = join(runsRoot, meta.id, 'run.json')
    const machine = {
      version: 'xstate-5.19.0',
      snapshot: {
        status: 'active',
        value: { flow: 'run', node: 'n_1' },
        context: { attempt: 2, nodeIds: ['n_1', 'n_2'], retry: { count: 1, lastError: null } },
        children: {},
        historyValue: {},
      },
      savedAt: '2026-11-07T02:15:00.000Z',
    }
    const written = await store.writeRunMeta(runsRoot, meta.id, { machine })
    assert.deepEqual(written.machine, machine, 'writeRunMeta 返回值应原样带 machine')
    assert.ok(!('machineTruncated' in written), '没裁剪就不该出现裁剪标志')
    assert.equal(written.droppedKeys, undefined, '没有未知键时不该有 droppedKeys')

    const disk = JSON.parse(readFileSync(metaPath, 'utf8'))
    assert.deepEqual(disk.machine, machine, '落盘必须原样保留（含 savedAt）')
    assert.ok(!('machineTruncated' in disk), '未裁剪时 machineTruncated 不该凭空出现')
    const reread = await store.readRunMeta(runsRoot, meta.id)
    assert.deepEqual(reread.machine, machine, '读回必须 deepEqual')
    assert.ok(!('machineTruncated' in reread))
    // savedAt 长度上限 64：正常 ISO 带偏移量也能原样保留（不改写成 Z）。
    const offset = await store.writeRunMeta(runsRoot, meta.id, {
      machine: { version: 'xstate-5.19.0', savedAt: '2026-11-07T10:15:00+08:00' },
    })
    assert.equal(offset.machine.savedAt, '2026-11-07T10:15:00+08:00')
    assert.deepEqual((await store.readRunMeta(runsRoot, meta.id)).machine.savedAt, '2026-11-07T10:15:00+08:00')

    // 整条替换语义：再写一次就换掉，不是深合并（旧 snapshot 不会残留）。
    const replaced = { version: 'xstate-5.20.0', snapshot: { status: 'done' }, savedAt: '2026-11-07T03:00:00.000Z' }
    const second = await store.writeRunMeta(runsRoot, meta.id, { machine: replaced })
    assert.deepEqual(second.machine, replaced)
    assert.deepEqual(JSON.parse(readFileSync(metaPath, 'utf8')).machine, replaced)
    assert.deepEqual((await store.readRunMeta(runsRoot, meta.id)).machine, replaced)
    console.log(`  · machine（snapshot ${Buffer.byteLength(JSON.stringify(machine.snapshot), 'utf8')} 字节）写入 / 读回 deepEqual；整条替换生效`)
  })

  await check('D4 snapshot 超 24 KiB：只裁快照（version / savedAt 保留）、machineTruncated 落盘且读回可见', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const metaPath = join(runsRoot, meta.id, 'run.json')
    // 同 patch 里放一份正常 nodeStatus：machine 被裁不得牵连另一条通道。
    const nodeStatus = { n_1: { state: 'working', progress: 50, summary: '跑着' } }
    const snapshot = {
      status: 'active',
      value: 'node',
      context: { log: Array.from({ length: 40 }, (_, index) => `L${index}-${'x'.repeat(1024)}`) },
    }
    const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
    assert.ok(snapshotBytes > store.MAX_MACHINE_SNAPSHOT_BYTES, `夹具应超 24 KiB（实际 ${snapshotBytes}）`)

    const written = await store.writeRunMeta(runsRoot, meta.id, {
      nodeStatus,
      machine: { version: 'xstate-5.19.0', snapshot, savedAt: '2026-11-07T04:00:00.000Z' },
    })
    assert.deepEqual(written.machine, { version: 'xstate-5.19.0', savedAt: '2026-11-07T04:00:00.000Z' },
      '超预算只丢 snapshot，version 与 savedAt 必须保留')
    assert.equal(written.machineTruncated, true, '裁剪必须可观测（不静默）')
    assert.equal(written.machine.snapshot, undefined)
    assert.equal(written.nodeStatus.n_1.state, 'working', 'nodeStatus 不得受 machine 裁剪影响')
    assert.equal(written.nodeStatus.n_1.progress, 50)
    assert.ok(!('nodeStatusTruncated' in written), 'machine 裁剪不得置 nodeStatusTruncated')

    const disk = JSON.parse(readFileSync(metaPath, 'utf8'))
    assert.deepEqual(disk.machine, { version: 'xstate-5.19.0', savedAt: '2026-11-07T04:00:00.000Z' })
    assert.equal(disk.machineTruncated, true, 'machineTruncated 必须落盘')
    assert.ok(!('snapshot' in disk.machine), '超预算的 snapshot 不能落盘')
    assert.equal(disk.nodeStatus.n_1.state, 'working')
    assert.ok(!('nodeStatusTruncated' in disk))

    const reread = await store.readRunMeta(runsRoot, meta.id)
    assert.deepEqual(reread.machine, disk.machine, '读回仍是「version 在、snapshot 不在」')
    assert.equal(reread.machineTruncated, true, '读回必须仍能看到裁剪标志')
    console.log(`  · snapshot ${snapshotBytes} 字节 → 裁掉；version/savedAt 保留；machineTruncated=true 落盘；nodeStatus 原样`)
  })

  await check('D4 写路径严格：machine 非对象 / version 空或超 200 / snapshot 非对象 → 400 且未落盘', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const metaPath = join(runsRoot, meta.id, 'run.json')
    await store.writeRunMeta(runsRoot, meta.id, { machine: { version: 'v-good', snapshot: { status: 'idle' } } })
    const before = readFileSync(metaPath, 'utf8')
    const cases = [
      [{ machine: 'nope' }, 'machine', /machine/],
      [{ machine: 42 }, 'machine', /machine/],
      [{ machine: [] }, 'machine', /machine/],
      [{ machine: {} }, 'machine', /version/],
      [{ machine: { version: '' } }, 'machine', /version/],
      [{ machine: { version: '   ' } }, 'machine', /version/],
      [{ machine: { version: 7 } }, 'machine', /version/],
      [{ machine: { version: 'v'.repeat(201) } }, 'machine', /200/],
      [{ machine: { version: 'v', snapshot: [] } }, 'machine', /snapshot/],
      [{ machine: { version: 'v', snapshot: 'nope' } }, 'machine', /snapshot/],
      [{ machine: { version: 'v', snapshot: null } }, 'machine', /snapshot/],
      [{ machineTruncated: 'yes' }, 'machineTruncated', /布尔/],
      [{ machineTruncated: 1 }, 'machineTruncated', /布尔/],
    ]
    for (const [patch, field, pattern] of cases) {
      await assert.rejects(
        () => store.writeRunMeta(runsRoot, meta.id, patch),
        error => error.status === 400 && error.field === field && pattern.test(error.reason),
        `应拒绝：${JSON.stringify(patch).slice(0, 80)}`,
      )
    }
    assert.equal(readFileSync(metaPath, 'utf8'), before, '被拒的 patch 一个字节都不能落盘')
    // 被拒之后旧 machine 原样还在（400 不破坏已有快照）。
    assert.deepEqual((await store.readRunMeta(runsRoot, meta.id)).machine,
      { version: 'v-good', snapshot: { status: 'idle' } })
    console.log(`  · ${cases.length} 类非法 machine patch 全部 400（field=machine / machineTruncated）且未落盘`)
  })

  await check('D4 与 nodeStatus 独立：同一 patch 里约 260 KiB nodeStatus 被裁、machine 完整保留', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    // 30 节点 × 20 成员 × 200 字姓名 + 200 字备注 ≈ 280 KiB：规范化后刚好压着 256 KiB 预算并略微超出，
    // 触发 D2 的裁剪（先摘 note），同时检验 machine 完全不受影响。
    const nodeStatus = nodeStatusFixture(30, { membersPerNode: 20, nameChars: 200, noteChars: 200 })
    const nodeBytes = Buffer.byteLength(JSON.stringify(nodeStatus), 'utf8')
    assert.ok(nodeBytes > store.MAX_NODE_STATUS_BYTES, `夹具应超 256 KiB（实际 ${nodeBytes}）`)
    assert.ok(nodeBytes < store.MAX_NODE_STATUS_BYTES * 1.2, `夹具应「接近」预算（实际 ${nodeBytes}）`)
    const machine = {
      version: 'xstate-5.19.0',
      snapshot: { status: 'active', value: 'n_0', context: { attempt: 1 } },
      savedAt: '2026-11-07T05:00:00.000Z',
    }

    const written = await store.writeRunMeta(runsRoot, meta.id, { nodeStatus, machine })
    assert.equal(written.nodeStatusTruncated, true, 'nodeStatus 超预算必须裁剪')
    assert.deepEqual(written.machine, machine, 'nodeStatus 裁剪不得动 machine')
    assert.ok(!('machineTruncated' in written), 'nodeStatus 裁剪不得置 machineTruncated')

    const disk = JSON.parse(readFileSync(join(runsRoot, meta.id, 'run.json'), 'utf8'))
    assert.deepEqual(disk.machine, machine, 'machine 必须原样落盘（两条通道各量各的字节）')
    assert.ok(!('machineTruncated' in disk))
    assert.equal(disk.nodeStatusTruncated, true)
    const statusBytes = Buffer.byteLength(JSON.stringify(disk.nodeStatus), 'utf8')
    assert.ok(statusBytes <= store.MAX_NODE_STATUS_BYTES,
      `落盘 nodeStatus ${statusBytes} 字节应 ≤ 预算 ${store.MAX_NODE_STATUS_BYTES}`)
    assert.ok(Object.keys(disk.nodeStatus).length > 0, '裁剪不是整块清空')
    const reread = await store.readRunMeta(runsRoot, meta.id)
    assert.deepEqual(reread.machine, machine)
    assert.ok(!('machineTruncated' in reread))
    console.log(`  · nodeStatus ${nodeBytes} → ${statusBytes} 字节（已裁）；machine ${Buffer.byteLength(JSON.stringify(disk.machine), 'utf8')} 字节原样`)
  })

  await check('D4 未传 machine → run.json 无该键；machine:null 清除（含 machineTruncated）', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const metaPath = join(runsRoot, meta.id, 'run.json')
    // 未传过 → run.json 里不该出现 machine / machineTruncated（不凭空造键）。
    let disk = JSON.parse(readFileSync(metaPath, 'utf8'))
    assert.ok(!('machine' in disk), '未传就不该出现 machine')
    assert.ok(!('machineTruncated' in disk), '未传就不该出现 machineTruncated')

    // 写一条被裁剪的 machine（带 machineTruncated:true），再由 machine:null 一次清干净。
    await store.writeRunMeta(runsRoot, meta.id, {
      machine: { version: 'v1', snapshot: { pad: 'p'.repeat(40 * 1024) } },
    })
    disk = JSON.parse(readFileSync(metaPath, 'utf8'))
    assert.deepEqual(disk.machine, { version: 'v1' })
    assert.equal(disk.machineTruncated, true)

    const cleared = await store.writeRunMeta(runsRoot, meta.id, { machine: null })
    assert.ok(!('machine' in cleared), 'machine:null 必须清除整条快照')
    assert.ok(!('machineTruncated' in cleared), 'machine:null 必须连裁剪标志一起清除')
    disk = JSON.parse(readFileSync(metaPath, 'utf8'))
    assert.ok(!('machine' in disk), '清除后 run.json 里不该再有 machine')
    assert.ok(!('machineTruncated' in disk), '清除后 run.json 里不该再有 machineTruncated')
    assert.ok(!('machine' in (await store.readRunMeta(runsRoot, meta.id))))

    // machineTruncated 显式 false / null 都能清除标志（machine 本体保留）。
    await store.writeRunMeta(runsRoot, meta.id, {
      machine: { version: 'v2', snapshot: { pad: 'p'.repeat(40 * 1024) } },
    })
    assert.equal((await store.readRunMeta(runsRoot, meta.id)).machineTruncated, true)
    await store.writeRunMeta(runsRoot, meta.id, { machineTruncated: false })
    const afterFalse = await store.readRunMeta(runsRoot, meta.id)
    assert.ok(!('machineTruncated' in afterFalse))
    assert.deepEqual(afterFalse.machine, { version: 'v2' })

    // 再置回 true，然后用 null 清除（null 不算类型错，与 false 同义）。
    await store.writeRunMeta(runsRoot, meta.id, { machineTruncated: true })
    assert.equal((await store.readRunMeta(runsRoot, meta.id)).machineTruncated, true)
    await store.writeRunMeta(runsRoot, meta.id, { machineTruncated: null })
    const afterNull = await store.readRunMeta(runsRoot, meta.id)
    assert.ok(!('machineTruncated' in afterNull), 'machineTruncated:null 必须清除标志')
    assert.deepEqual(afterNull.machine, { version: 'v2' })
    console.log('  · 未传不出现；machine:null 连裁剪标志一起清除；machineTruncated:false / null 都能清除')
  })

  await check('D4 未知内层键进 droppedKeys（machine.xxx）；读路径对坏 machine 宽松', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const metaPath = join(runsRoot, meta.id, 'run.json')
    const written = await store.writeRunMeta(runsRoot, meta.id, {
      machine: {
        version: 'v1',
        snapshot: { status: 'idle' },
        savedAt: '2026-11-07T06:00:00.000Z',
        status: 'should-be-dropped',
        checksum: 'abc',
        nested: { a: 1 },
      },
    })
    assert.deepEqual([...written.droppedKeys].sort(), ['machine.checksum', 'machine.nested', 'machine.status'])
    assert.deepEqual(written.machine,
      { version: 'v1', snapshot: { status: 'idle' }, savedAt: '2026-11-07T06:00:00.000Z' })
    const disk = JSON.parse(readFileSync(metaPath, 'utf8'))
    assert.deepEqual(disk.machine, written.machine, '未知内层键不落盘')
    // droppedKeys 仍是不进 JSON 的不可枚举诊断属性。
    assert.equal(Object.prototype.propertyIsEnumerable.call(written, 'droppedKeys'), false)
    assert.ok(!JSON.stringify(written).includes('droppedKeys'))
    assert.ok(!('droppedKeys' in disk))

    // 读路径宽松：手改坏的 machine 只丢 machine（或其中坏键），绝不报错、不影响其它字段。
    // ① version 坏（非字符串 / 超 200 字符 / 空）→ 整条 machine 丢弃。
    for (const badVersion of [42, 'v'.repeat(201), '', null]) {
      const raw = JSON.parse(readFileSync(metaPath, 'utf8'))
      raw.machine = { version: badVersion, snapshot: { a: 1 } }
      raw.machineTruncated = true
      raw.name = '手工改过的 run'
      writeFileSync(metaPath, `${JSON.stringify(raw, null, 2)}\n`)
      const reread = await store.readRunMeta(runsRoot, meta.id)
      assert.ok(reread, `version=${String(badVersion)}：run 必须仍然可读`)
      assert.equal(reread.name, '手工改过的 run', '其它字段不受影响')
      assert.ok(!('machine' in reread), `version=${String(badVersion)}：坏版本号应整条丢弃`)
      assert.ok(!('machineTruncated' in reread), '没有 machine 时裁剪标志也没有意义')
    }

    // ② snapshot 坏 / 超限 → 丢 snapshot、保 version，并标裁剪（可见，不静默）。
    for (const [label, badSnapshot] of [
      ['字符串', 'nope'],
      ['数组', [{ a: 1 }]],
      ['null', null],
      ['超 24 KiB', { pad: 'q'.repeat(40 * 1024) }],
    ]) {
      const raw = JSON.parse(readFileSync(metaPath, 'utf8'))
      raw.machine = { version: 'v9', snapshot: badSnapshot, savedAt: '2026-11-07T06:00:00.000Z' }
      delete raw.machineTruncated
      writeFileSync(metaPath, `${JSON.stringify(raw, null, 2)}\n`)
      const reread = await store.readRunMeta(runsRoot, meta.id)
      assert.deepEqual(reread.machine,
        { version: 'v9', savedAt: '2026-11-07T06:00:00.000Z' }, `snapshot=${label}：只丢快照`)
      assert.equal(reread.machineTruncated, true, `snapshot=${label}：裁剪必须可见`)
    }

    // ③ savedAt 坏（非 ISO / 超 64 字符）→ 只丢该键；未知内层键读侧也丢弃。
    for (const badSavedAt of ['not-a-date', 'x'.repeat(65), 123]) {
      const raw = JSON.parse(readFileSync(metaPath, 'utf8'))
      raw.machine = {
        version: 'v9', snapshot: { a: 1 }, savedAt: badSavedAt, status: 'x', checksum: 'y',
      }
      delete raw.machineTruncated
      writeFileSync(metaPath, `${JSON.stringify(raw, null, 2)}\n`)
      const reread = await store.readRunMeta(runsRoot, meta.id)
      assert.deepEqual(reread.machine, { version: 'v9', snapshot: { a: 1 } },
        `savedAt=${String(badSavedAt).slice(0, 12)}：只丢该键，未知内层键也丢弃`)
      assert.ok(!('machineTruncated' in reread), 'savedAt 坏不算快照裁剪')
    }
    console.log('  · 未知内层键 → droppedKeys 的 machine.xxx；读路径 4 类坏 version / 4 类坏 snapshot / 3 类坏 savedAt 全部宽松收敛')
  })

  await check('readEvents 扩展 kind：machine/transition（节点级）/ node/status 不再 400 且能正常过滤', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    // machine/transition 是**节点级**事件（必须带 nodeId + attemptId）；event() 默认补齐。
    const appended = await store.appendEvents(runsRoot, meta.id, [
      event('node/start', { runId: meta.id }),
      event('machine/transition', {
        runId: meta.id,
        data: { from: 'idle', to: 'running', event: 'START', version: 'v-abc123' },
      }),
      event('machine/transition', {
        runId: meta.id,
        nodeId: 'n_2',
        data: { from: 'n_1', to: 'n_2', event: 'NODE_DONE', version: 'v-abc123' },
      }),
      event('node/status', { runId: meta.id, data: { state: 'working', progress: 10 } }),
    ], { now: NOW })
    assert.equal(appended.events.length, 4)

    // 以前这里的 kinds 白名单是手抄的，扩展 kind 会被当未知类型 400。
    const machine = await store.readEvents(runsRoot, meta.id, { kinds: ['machine/transition'], limit: 10 })
    assert.equal(machine.total, 2, 'machine/transition 过滤应可用且只命中该类事件')
    assert.ok(machine.events.every(item => item.kind === 'machine/transition'))
    assert.deepEqual(machine.events.map(item => item.data.event), ['START', 'NODE_DONE'])
    // 节点级事实：nodeId + attemptId 都在事件上（不是 run 级事件）。
    assert.equal(machine.events[0].nodeId, 'n_1')
    assert.equal(machine.events[0].attemptId, 1)
    assert.equal(machine.events[1].nodeId, 'n_2')

    // node/status 是同源的另一个扩展 kind：此前同样漏在白名单外。
    const status = await store.readEvents(runsRoot, meta.id, { kinds: ['node/status'], limit: 10 })
    assert.equal(status.total, 1)
    assert.equal(status.events[0].data.state, 'working')

    // 两个扩展 kind 一起过滤。
    const both = await store.readEvents(runsRoot, meta.id, {
      kinds: ['machine/transition', 'node/status'], limit: 10,
    })
    assert.equal(both.total, 3)
    assert.deepEqual(both.events.map(item => item.seq), [2, 3, 4])

    // 0.10 R6：node/tools 同样在「runlog 认得」的扩展白名单里，?kinds= 过滤不能 400。
    await store.appendEvents(runsRoot, meta.id, [
      event('node/tools', {
        runId: meta.id,
        data: { tools: ['bash', 'read'], toolsSource: 'session', count: 2 },
      }),
    ], { now: NOW })
    const tools = await store.readEvents(runsRoot, meta.id, { kinds: ['node/tools'], limit: 10 })
    assert.equal(tools.total, 1)
    assert.deepEqual(tools.events[0].data.tools, ['bash', 'read'])
    assert.equal(tools.events[0].data.count, 2)

    // 白名单只放宽到「runlog 认得的 kind」，未知类型仍然 400。
    await assert.rejects(
      () => store.readEvents(runsRoot, meta.id, { kinds: ['machine/nope'], limit: 10 }),
      error => error.status === 400 && error.field === 'kind',
    )
    console.log(`  · machine/transition ${machine.total} 条、node/status ${status.total} 条、二者合并 ${both.total} 条；未知 kind 仍 400`)
  })

  // -------------------------------------------------------------------------
  console.log('runstore.js · 会话条目的 agentOptions（0.10 R1 / S2）')

  await check('normalizeSessionAgentOptions：成对才通过；半对 / 坏形状 / 超长整条 null', () => {
    assert.deepEqual(
      store.normalizeSessionAgentOptions({ provider: 'openai', model: 'gpt-5' }),
      { provider: 'openai', model: 'gpt-5' },
    )
    assert.deepEqual(
      store.normalizeSessionAgentOptions({ provider: 'openai', model: 'gpt-5', reasoningEffort: 'low' }),
      { provider: 'openai', model: 'gpt-5', reasoningEffort: 'low' },
    )
    // 空串 effort 视为没写（不整条作废）。
    assert.deepEqual(
      store.normalizeSessionAgentOptions({ provider: 'openai', model: 'gpt-5', reasoningEffort: '' }),
      { provider: 'openai', model: 'gpt-5' },
    )
    for (const bad of [
      null, undefined, 'openai', 42, [], {},
      { provider: 'openai' },
      { model: 'gpt-5' },
      { provider: '', model: 'gpt-5' },
      { provider: 'openai', model: '' },
      { provider: '   ', model: 'gpt-5' },
      { provider: 1, model: 'gpt-5' },
      { provider: 'openai', model: 5 },
      { provider: 'x'.repeat(65), model: 'gpt-5' },
      { provider: 'openai', model: 'x'.repeat(129) },
      { provider: 'openai', model: 'gpt-5', reasoningEffort: 3 },
      { provider: 'openai', model: 'gpt-5', reasoningEffort: 'x'.repeat(65) },
    ]) {
      assert.equal(store.normalizeSessionAgentOptions(bad), null, JSON.stringify(bad))
    }
  })

  await check('agentOptions 往返：writeNodeSessions 落盘、readNodeSessions 原样读回；无字段的旧条目不多出键', async () => {
    const meta = await makeRun()
    await store.writeNodeSessions(runsRoot, meta.id, {
      n_pair: {
        sessionId: 'sess-pair',
        createdAt: '2026-11-06T00:00:00.000Z',
        lastUsedAt: '2026-11-06T00:01:00.000Z',
        agentOptions: { provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' },
      },
      n_old: {
        sessionId: 'sess-old',
        createdAt: '2026-11-06T00:00:00.000Z',
        lastUsedAt: '2026-11-06T00:01:00.000Z',
      },
    })
    const read = await store.readNodeSessions(runsRoot, meta.id)
    assert.deepEqual(read.n_pair.agentOptions, {
      provider: 'openai', model: 'gpt-5', reasoningEffort: 'high',
    })
    assert.equal(Object.hasOwn(read.n_old, 'agentOptions'), false, '旧条目不会凭空多出 agentOptions')
    // 第二次整写（模拟引擎 persist）不能把字段抹掉。
    await store.writeNodeSessions(runsRoot, meta.id, read)
    assert.deepEqual(
      (await store.readNodeSessions(runsRoot, meta.id)).n_pair.agentOptions,
      { provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' },
    )
  })

  await check('agentOptions 坏形状：整条丢字段但保留 sessionId / 时间戳，不抛错', async () => {
    const meta = await makeRun()
    const path = join(runsRoot, meta.id, 'sessions.json')
    writeFileSync(path, JSON.stringify({
      n_half: {
        sessionId: 'sess-half',
        createdAt: '2026-11-06T00:00:00.000Z',
        lastUsedAt: '2026-11-06T00:01:00.000Z',
        agentOptions: { provider: 'openai' },
      },
      n_number: {
        sessionId: 'sess-number',
        createdAt: '2026-11-06T00:00:00.000Z',
        lastUsedAt: '2026-11-06T00:01:00.000Z',
        agentOptions: 42,
      },
      n_array: {
        sessionId: 'sess-array',
        createdAt: '2026-11-06T00:00:00.000Z',
        lastUsedAt: '2026-11-06T00:01:00.000Z',
        agentOptions: ['openai', 'gpt-5'],
      },
      n_long: {
        sessionId: 'sess-long',
        createdAt: '2026-11-06T00:00:00.000Z',
        lastUsedAt: '2026-11-06T00:01:00.000Z',
        agentOptions: { provider: 'x'.repeat(65), model: 'gpt-5' },
      },
    }))
    const read = await store.readNodeSessions(runsRoot, meta.id)
    for (const [nodeId, sessionId] of [
      ['n_half', 'sess-half'], ['n_number', 'sess-number'], ['n_array', 'sess-array'], ['n_long', 'sess-long'],
    ]) {
      assert.equal(read[nodeId].sessionId, sessionId, `${nodeId} 必须保留 sessionId`)
      assert.equal(Object.hasOwn(read[nodeId], 'agentOptions'), false, `${nodeId} 的坏 agentOptions 要整条丢弃`)
      assert.equal(read[nodeId].createdAt, '2026-11-06T00:00:00.000Z')
    }
  })

  await check('upsertNodeSession：同 session 保留旧 route、显式合法值覆盖、新 session 不继承', async () => {
    const meta = await makeRun()
    await store.upsertNodeSession(runsRoot, meta.id, 'n_a', 'sess-1', {
      now: new Date('2026-11-06T00:00:00.000Z'),
      agentOptions: { provider: 'openai', model: 'gpt-5' },
    })
    // 同 sessionId、不传 agentOptions → 保留旧 route。
    await store.upsertNodeSession(runsRoot, meta.id, 'n_a', 'sess-1', {
      now: new Date('2026-11-06T00:10:00.000Z'),
    })
    let read = await store.readNodeSessions(runsRoot, meta.id)
    assert.deepEqual(read.n_a.agentOptions, { provider: 'openai', model: 'gpt-5' })
    // 同 sessionId、传坏形状 → 仍然保留旧 route（坏值不能把已有路由抹成空）。
    await store.upsertNodeSession(runsRoot, meta.id, 'n_a', 'sess-1', {
      now: new Date('2026-11-06T00:20:00.000Z'),
      agentOptions: { provider: 'only-half' },
    })
    read = await store.readNodeSessions(runsRoot, meta.id)
    assert.deepEqual(read.n_a.agentOptions, { provider: 'openai', model: 'gpt-5' })
    // 同 sessionId、传新的合法值 → 覆盖。
    await store.upsertNodeSession(runsRoot, meta.id, 'n_a', 'sess-1', {
      now: new Date('2026-11-06T00:30:00.000Z'),
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    read = await store.readNodeSessions(runsRoot, meta.id)
    assert.deepEqual(read.n_a.agentOptions, { provider: 'deepseek', model: 'deepseek-chat' })
    // 新 sessionId → 不凭空继承旧节点的 route。
    await store.upsertNodeSession(runsRoot, meta.id, 'n_a', 'sess-2', {
      now: new Date('2026-11-06T00:40:00.000Z'),
    })
    read = await store.readNodeSessions(runsRoot, meta.id)
    assert.equal(read.n_a.sessionId, 'sess-2')
    assert.equal(Object.hasOwn(read.n_a, 'agentOptions'), false, '新会话不得继承旧 route')
  })

  await check('旧文件没有 agentOptions：读回不带该键，upsert 其它节点也不会给它补一个', async () => {
    const meta = await makeRun()
    const path = join(runsRoot, meta.id, 'sessions.json')
    writeFileSync(path, JSON.stringify({
      n_old: {
        sessionId: 'sess-old',
        createdAt: '2026-11-06T00:00:00.000Z',
        lastUsedAt: '2026-11-06T00:01:00.000Z',
      },
    }))
    assert.equal(Object.hasOwn((await store.readNodeSessions(runsRoot, meta.id)).n_old, 'agentOptions'), false)
    await store.upsertNodeSession(runsRoot, meta.id, 'n_other', 'sess-other')
    const read = await store.readNodeSessions(runsRoot, meta.id)
    assert.equal(Object.hasOwn(read.n_old, 'agentOptions'), false)
    assert.equal(Object.hasOwn(read.n_other, 'agentOptions'), false)
  })
  // 0.11 R1：失权收口必须按持久 epoch/owner 条件写
  await check('R1（0.11）：finalizeEpoch 按持久 epoch/owner 条件写，接管后旧实例只记 instance 事实', async () => {
    const meta = await makeRun()
    await store.startRun(runsRoot, meta.id, { now: NOW })
    const now = new Date()
    // 第一个 owner：租约一创建就过期（ttl=1ms 且心跳在过去），随即可被接管。
    const first = await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ttlMs: 1, now: new Date(now.getTime() - 5000),
    })
    assert.equal(first.epoch, 1, '每次 claim 的持久 epoch 从 1 开始')
    const second = await store.claimLease(runsRoot, meta.id, { pid: 222, host: 'h2', ttlMs: 60_000, now })
    assert.equal(second.epoch, 2, '接管者拿到下一个 epoch')

    // 持久 fence：旧 owner/epoch 的业务写必须被存储层拒绝（一条都不落盘）。
    const before = (await store.readAllEvents(runsRoot, meta.id)).events.length
    await assert.rejects(
      () => store.appendEvents(runsRoot, meta.id, [{
        v: 1, kind: 'node/start', nodeId: 'n_stale', attemptId: 1, traceId: 'tr-stale',
        data: { title: 'stale', mode: 'single', skills: [] },
      }], { ownerId: first.ownerId, leaseEpoch: 1 }),
      error => error && error.status === 409 && error.code === 'LEASE_FENCED',
    )
    assert.equal((await store.readAllEvents(runsRoot, meta.id)).events.length, before,
      'fenced 写被拒绝后事件数不变')
    const accepted = await store.appendEvents(runsRoot, meta.id, [{
      v: 1, kind: 'node/start', nodeId: 'n_new', attemptId: 1, traceId: 'tr-new',
      data: { title: 'new', mode: 'single', skills: [] },
    }], { ownerId: second.ownerId, leaseEpoch: 2 })
    assert.equal(accepted.events.length, 1, '现任 owner/epoch 的写允许')

    const stale = await store.finalizeEpoch(runsRoot, meta.id, {
      expectedEpoch: 1, ownerId: first.ownerId, idempotencyKey: 'loss:1', now,
    })
    assert.equal(stale.terminalScope, 'instance', '旧 epoch 只能记 instance 范围事实')
    let after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.status, 'running', '接管者仍在跑时，旧实例不得把 run 改成 failed')
    assert.equal(after.execution.epoch, 2, '接管者的 execution 不被旧实例覆盖')
    assert.equal(after.execution.ownerId, second.ownerId)

    const again = await store.finalizeEpoch(runsRoot, meta.id, {
      expectedEpoch: 1, ownerId: first.ownerId, idempotencyKey: 'loss:1', now,
    })
    assert.equal(again.idempotent, true, '同一失权 epoch 的重复收口必须幂等')

    const current = await store.finalizeEpoch(runsRoot, meta.id, {
      expectedEpoch: 2, ownerId: second.ownerId, idempotencyKey: 'loss:2', now,
    })
    assert.equal(current.terminalScope, 'run', '现任 owner 收口才是 run 范围 failed')
    after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.status, 'failed')
    assert.equal(after.execution.state, 'settled')
  })

  // 0.11 R1（本轮）：claimLease 的 execution 更新与 appendEvents fence 共用跨进程 meta.lock
  await check('R1（本轮）：claim 更新 execution 与 append fence 共用跨进程 meta.lock（可控交错）', async () => {
    const meta = await makeRun()
    await store.startRun(runsRoot, meta.id, { now: NOW })
    const first = await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ttlMs: 1, now: new Date(Date.now() - 5000),
    })
    assert.equal(first.epoch, 1)

    // 父进程先持 meta.lock（appendEvents 的 guard 在锁内挂起）。
    let enteredResolve
    let releaseResolve
    const entered = new Promise(resolve => { enteredResolve = resolve })
    const release = new Promise(resolve => { releaseResolve = resolve })
    const appendPromise = store.appendEvents(runsRoot, meta.id, [{
      v: 1, kind: 'node/start', nodeId: 'n_hold', attemptId: 1, traceId: 'tr-hold',
      data: { title: 'hold', mode: 'single', skills: [] },
    }], {
      guard: async () => {
        enteredResolve()
        await release
      },
    })
    await entered

    const childScript = join(home, 'claim-child.mjs')
    writeFileSync(childScript, [
      `import * as store from ${JSON.stringify(new URL('../src/runstore.js', import.meta.url).href)}`,
      'try {',
      '  const lease = await store.claimLease(process.argv[2], process.argv[3], {',
      '    pid: 222, host: "h2", ttlMs: 60000, now: new Date(),',
      '  })',
      '  console.log("claimed", lease.epoch)',
      '} catch (error) {',
      '  console.error("claim-failed", error && error.code, error && error.message)',
      '  process.exit(2)',
      '}',
    ].join('\n'))
    const child = spawn(process.execPath, [childScript, runsRoot, meta.id], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childOut = ''
    let childErr = ''
    child.stdout.on('data', chunk => { childOut += chunk })
    child.stderr.on('data', chunk => { childErr += chunk })
    const childExit = new Promise(resolve => child.once('exit', resolve))

    // 子进程跨进程 claim 必须停在 meta.lock 上：期间 execution 仍是旧 epoch。
    await new Promise(resolve => setTimeout(resolve, 400))
    const during = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(during.execution.epoch, 1,
      `另一进程的 claim 必须被 meta.lock 挡住（child stderr: ${childErr.slice(0, 200)}）`)
    // 新租约在 epoch 更新完成之前不得对外可见（原子可见性）。
    const leaseDuring = JSON.parse(readFileSync(join(runsRoot, meta.id, 'lock.json'), 'utf8'))
    assert.equal(leaseDuring.ownerId, first.ownerId,
      'epoch 未更新前 lock.json 仍是旧 owner（新租约不可见）')

    releaseResolve()
    await appendPromise
    const code = await childExit
    assert.equal(code, 0, `子进程 claim 失败：${childErr.slice(0, 300)}`)
    assert.match(childOut, /claimed 2/, '锁释放后子进程拿到 epoch 2')
    const after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.execution.epoch, 2)
    // 新 epoch 生效后，旧 owner 的在飞写即使此刻才提交也必须被 fence 拒绝。
    await assert.rejects(
      () => store.appendEvents(runsRoot, meta.id, [{
        v: 1, kind: 'node/start', nodeId: 'n_inflight', attemptId: 1, traceId: 'tr-inflight',
        data: { title: 'inflight', mode: 'single', skills: [] },
      }], { ownerId: first.ownerId, leaseEpoch: 1 }),
      error => error && error.status === 409 && error.code === 'LEASE_FENCED',
    )
    assert.equal((await store.readAllEvents(runsRoot, meta.id)).events.some(event => event.nodeId === 'n_inflight'), false)
  })

  // 0.11 R1（本轮·三进程）：租约接管竞态的原子性。
  // 拓扑刻意做成「3 个真子进程」：三个进程先同时抢初始租约（只有一个赢家 = 旧 owner），
  // 两个输家在过期后同时抢接管（只有一个赢家 = 新 owner），旧 owner 在接管后先续租拿 409、
  // 再尝试提交已在飞的业务写。断言：
  //   ① 任一时点只有一个 owner 能提交业务写（每个 epoch 只有它的 owner 的写落盘）；
  //   ② 旧 owner 在 409 之后的迟到写即使带着原 fence 也落不了盘（整批 0 条）；
  //   ③ 落盘事件 seq 连续无重复（两个 owner 的写没有互相覆盖 / 抢同一个 seq）。
  // 这里断言的是持久化结果（readAllEvents / execution），不信任子进程自己报的 ok。
  await check('R1（本轮·三进程）：旧 owner + 两个接管者竞态——409 后的迟到写被 fence，单写者', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    await store.startRun(runsRoot, meta.id, { now: new Date() })
    const startAt = Date.now() + 1500
    const takeoverAt = startAt + 1500
    const childScript = join(home, 'lease-race-child.mjs')
    const runstoreHref = new URL('../src/runstore.js', import.meta.url).href
    writeFileSync(childScript, `
const [root, id, role, startAtRaw, takeoverAtRaw] = process.argv.slice(2)
const store = await import(${JSON.stringify(runstoreHref)})
const sleep = ms => new Promise(done => setTimeout(done, ms))
const waitUntil = async at => { const wait = Number(at) - Date.now(); if (wait > 0) await sleep(wait) }
const ownerId = \`race-\${role}\`
const pid = process.pid
const host = \`host-\${role}\`
const emit = value => process.stdout.write(\`\${JSON.stringify(value)}\\n\`)
const writeBusiness = async (nodeId, fence) => {
  try {
    const result = await store.appendEvents(root, id, [{
      v: 1,
      kind: 'node/start',
      nodeId,
      attemptId: 1,
      traceId: \`tr-\${ownerId}-\${nodeId}\`,
      extra: { writer: ownerId, writerEpoch: fence.leaseEpoch },
      data: { title: nodeId, mode: 'single', skills: [] },
    }], fence)
    emit({ role, step: \`write:\${nodeId}\`, ok: true, seq: result.lastSeq })
    return true
  } catch (error) {
    emit({ role, step: \`write:\${nodeId}\`, ok: false, status: error && error.status, code: error && error.code })
    return false
  }
}
await waitUntil(startAtRaw)
let first = null
try {
  first = await store.claimLease(root, id, { pid, host, ownerId, ttlMs: 400 })
  emit({ role, step: 'claim1', ok: true, epoch: first.epoch })
} catch (error) {
  emit({ role, step: 'claim1', ok: false, status: error && error.status })
}
if (first) {
  // 旧 owner 在租约还有效时先写一条：这是合法业务写，必须保留。
  await writeBusiness('n_old_pre', { ownerId, leaseEpoch: first.epoch })
  await waitUntil(Number(takeoverAtRaw) + 500)
  try {
    await store.renewLease(root, id, { pid, host, ownerId })
    emit({ role, step: 'renew', ok: true })
  } catch (error) {
    emit({ role, step: 'renew', ok: false, status: error && error.status })
  }
  await waitUntil(Number(takeoverAtRaw) + 1000)
  // 已确知失权（409）之后才提交的迟到写：必须被持久 fence 拒绝。
  await writeBusiness('n_old_late', { ownerId, leaseEpoch: first.epoch })
} else {
  await waitUntil(takeoverAtRaw)
  let second = null
  try {
    second = await store.claimLease(root, id, { pid, host, ownerId, ttlMs: 60000 })
    emit({ role, step: 'claim2', ok: true, epoch: second.epoch })
  } catch (error) {
    emit({ role, step: 'claim2', ok: false, status: error && error.status })
  }
  await waitUntil(Number(takeoverAtRaw) + 1000)
  if (second) {
    await writeBusiness('n_winner', { ownerId, leaseEpoch: second.epoch })
  } else {
    // 输掉接管的进程拿不到 ownerId 凭证：即使读到当前 epoch，也不能写。
    const current = await store.readRunMeta(root, id)
    const epoch = current && current.execution && Number.isInteger(current.execution.epoch)
      ? current.execution.epoch
      : 0
    await writeBusiness('n_loser', { ownerId, leaseEpoch: epoch })
  }
}
`)

    const runChild = role => new Promise((resolveChild, rejectChild) => {
      const proc = spawn(
        process.execPath,
        [childScript, runsRoot, meta.id, role, String(startAt), String(takeoverAt)],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', chunk => { stdout += chunk })
      proc.stderr.on('data', chunk => { stderr += chunk })
      proc.on('error', rejectChild)
      proc.on('close', code => {
        const reports = stdout.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
          try {
            return JSON.parse(line)
          } catch {
            return { parseError: line }
          }
        })
        resolveChild({ role, code, reports, stderr })
      })
    })

    const roles = ['alpha', 'beta', 'gamma']
    const results = await Promise.all(roles.map(runChild))
    const reports = results.flatMap(item => item.reports)
    const stepOf = (role, step) => reports.find(item => item.role === role && item.step === step)
    const claim1 = reports.filter(item => item.step === 'claim1')
    const claim1Wins = claim1.filter(item => item.ok === true)
    assert.equal(results.every(item => item.code === 0), true,
      `三个子进程都必须正常退出：${results.map(item => `${item.role}=${item.code} ${item.stderr.slice(0, 200)}`).join(' | ')}`)
    assert.equal(claim1.length, 3, '三个进程都必须真的参与初始租约竞争')
    assert.equal(claim1Wins.length, 1, `初始租约只能有一个赢家：${JSON.stringify(claim1)}`)
    assert.equal(claim1.filter(item => item.ok === false && item.status === 409).length, 2,
      `另外两个进程必须拿到 409：${JSON.stringify(claim1)}`)

    const oldRole = claim1Wins[0].role
    const losers = roles.filter(role => role !== oldRole)
    const claim2 = reports.filter(item => item.step === 'claim2')
    const claim2Wins = claim2.filter(item => item.ok === true)
    assert.equal(claim2.length, 2, '两个初始输家都必须参与接管竞争')
    assert.equal(claim2Wins.length, 1, `接管只能有一个赢家：${JSON.stringify(claim2)}`)
    assert.equal(claim2.filter(item => item.ok === false && item.status === 409).length, 1,
      `另一个接管者必须拿到 409：${JSON.stringify(claim2)}`)

    const renew = stepOf(oldRole, 'renew')
    assert.equal(renew && renew.ok, false, `旧 owner 续租必须被拒：${JSON.stringify(renew)}`)
    assert.equal(renew && renew.status, 409, '旧 owner 续租必须是 409')

    // 先断言持久化事实（旧实现下这里会先红）：迟到写 / 失败者写不得出现在事件流里。
    const persisted = (await store.readAllEvents(runsRoot, meta.id)).events
    const late = persisted.filter(event => event.nodeId === 'n_old_late')
    const loserWrite = persisted.filter(event => event.nodeId === 'n_loser')
    assert.equal(late.length, 0, `旧 owner 在 409 之后的迟到写不得落盘（实际 ${late.length} 条）`)
    assert.equal(loserWrite.length, 0, `没有 ownerId 凭证的进程不得提交业务写（实际 ${loserWrite.length} 条）`)

    const winnerRole = claim2Wins[0].role
    const winnerId = `race-${winnerRole}`
    const pre = persisted.filter(event => event.nodeId === 'n_old_pre')
    const won = persisted.filter(event => event.nodeId === 'n_winner')
    assert.equal(pre.length, 1, '旧 owner 失权前的合法写必须保留')
    assert.equal(won.length, 1, '接管者的业务写必须落盘（且只有一条）')
    assert.ok(pre[0].seq < won[0].seq, '旧 owner 的合法写必须在接管者写之前')

    assert.equal(stepOf(oldRole, 'write:n_old_pre').ok, true)
    assert.equal(stepOf(oldRole, 'write:n_old_late').ok, false, '旧 owner 迟到写必须被拒')
    assert.equal(stepOf(oldRole, 'write:n_old_late').code, 'LEASE_FENCED', '旧 owner 迟到写必须带 LEASE_FENCED')
    assert.equal(stepOf(winnerRole, 'write:n_winner').ok, true, '接管者写必须成功')
    const loserRole = losers.find(role => role !== winnerRole)
    assert.equal(stepOf(loserRole, 'write:n_loser').ok, false, '落败接管者不得提交业务写')
    assert.equal(stepOf(loserRole, 'write:n_loser').code, 'LEASE_FENCED', '落败接管者必须带 LEASE_FENCED')

    // 单写者 / 世代：run.json.execution 只能指向最终 owner；每个 epoch 只出现一个 writer。
    const after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.execution.epoch, 2, '一次接管后 epoch 必须恰好推进到 2')
    assert.equal(after.execution.ownerId, winnerId, 'run.json.execution.ownerId 必须是最终 owner')
    assert.equal(pre[0].extra.writer, `race-${oldRole}`, '旧 owner 的写必须带自己的 writer 标记')
    assert.equal(String(pre[0].extra.writerEpoch), '1', '旧 owner 的写必须属于 epoch 1')
    assert.equal(won[0].extra.writer, winnerId, '接管者的写必须带自己的 writer 标记')
    assert.equal(String(won[0].extra.writerEpoch), '2', '接管者的写必须属于 epoch 2')
    const seqs = persisted.map(event => event.seq).sort((a, b) => a - b)
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, index) => index + 1),
      '事件 seq 必须连续、无重复（两个 owner 的写没有抢同一个 seq）')
    console.log(`  · old=${oldRole} winner=${winnerRole} loser=${loserRole} events=${persisted.length}`)
  })

  // ───────────────────────────────────────────────────────────────────────
  // 0.11 独立审查报告 F1（P0）/ F6（P1）：租约并发安全
  // ───────────────────────────────────────────────────────────────────────

  // F1-①：同 pid@host、不同 ownerId。旧实现的 renew 只把 {pid,host} 交给核对，
  // 于是「新 owner 已接管」后旧 owner 仍能续租成功（同进程不同 owner 也能）。
  await check('F1（审查 P0）：同 pid@host 不同 ownerId —— 旧 owner 续租/释放必须 409，新租约不被覆盖', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const t0 = new Date('2026-11-06T12:00:00.000Z')
    await store.startRun(runsRoot, meta.id, { now: t0 })
    const old = await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-old', ttlMs: 1, now: t0,
    })
    assert.equal(old.epoch, 1)
    // 旧租约过期后，同一个 pid@host 被新 owner 接管（ABA 身份碰撞）。
    const fresh = await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-new', ttlMs: 60_000, now: new Date(t0.getTime() + 10_000),
    })
    assert.equal(fresh.epoch, 2)
    const lockPath = join(runsRoot, meta.id, 'lock.json')
    const before = JSON.parse(readFileSync(lockPath, 'utf8'))
    assert.equal(before.ownerId, 'owner-new')

    await assert.rejects(
      () => store.renewLease(runsRoot, meta.id, {
        pid: 111, host: 'h1', ownerId: 'owner-old', now: new Date(t0.getTime() + 20_000),
      }),
      error => error && error.status === 409,
      '旧 owner（ownerId 不符）不得续租新 owner 的租约',
    )
    const afterRenew = JSON.parse(readFileSync(lockPath, 'utf8'))
    assert.equal(afterRenew.ownerId, 'owner-new', '失败续租不得覆盖新 owner 的 ownerId')
    assert.equal(afterRenew.heartbeatAt, before.heartbeatAt, '失败续租不得刷新心跳')

    await assert.rejects(
      () => store.releaseLease(runsRoot, meta.id, { pid: 111, host: 'h1', ownerId: 'owner-old' }),
      error => error && error.status === 409,
      '旧 owner（ownerId 不符）不得释放新 owner 的租约',
    )
    assert.ok(existsSync(lockPath), '失败释放不得删掉新 owner 的租约')

    // 旧实例的业务写：一条都不能落盘。
    const beforeEvents = (await store.readAllEvents(runsRoot, meta.id)).events.length
    await assert.rejects(
      () => store.appendEvents(runsRoot, meta.id, [{
        v: 1, kind: 'node/start', nodeId: 'n_old_aba', attemptId: 1, traceId: 'tr-old-aba',
        data: { title: 'old', mode: 'single', skills: [] },
      }], { ownerId: old.ownerId, leaseEpoch: old.epoch }),
      error => error && error.status === 409 && error.code === 'LEASE_FENCED',
    )
    assert.equal((await store.readAllEvents(runsRoot, meta.id)).events.length, beforeEvents,
      '旧实例的业务写必须 0 条落盘')

    const renewed = await store.renewLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-new', now: new Date(t0.getTime() + 30_000),
    })
    assert.equal(renewed.ownerId, 'owner-new', '现任 owner 仍能续租')
  })

  // F1-②：claim 先写 run.json.execution、再发布 lock.json；这两步之间崩溃时，
  // lock.json 还是旧 owner。旧实现 renew/release 只看 lock.json，旧 owner 能续租/删掉它。
  await check('F1（审查 P0）：execution.ownerId 已推进而 lock.json 仍是旧 owner（claim 半途崩溃）→ 续租/释放 409', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const t0 = new Date('2026-11-06T12:00:00.000Z')
    await store.startRun(runsRoot, meta.id, { now: t0 })
    await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-old', ttlMs: 60_000, now: t0,
    })
    // 模拟 claim 写完 run.json.execution 后、发布新 lock.json 前进程崩溃。
    const metaPath = join(runsRoot, meta.id, 'run.json')
    const disk = JSON.parse(readFileSync(metaPath, 'utf8'))
    disk.execution = { epoch: 2, ownerId: 'owner-new', state: 'active' }
    writeFileSync(metaPath, `${JSON.stringify(disk, null, 2)}\n`)
    const lockPath = join(runsRoot, meta.id, 'lock.json')
    const lockBefore = readFileSync(lockPath, 'utf8')

    await assert.rejects(
      () => store.renewLease(runsRoot, meta.id, {
        pid: 111, host: 'h1', ownerId: 'owner-old', now: new Date(t0.getTime() + 1000),
      }),
      error => error && error.status === 409,
      '租约身份与持久 execution 不一致时，旧 owner 不得续租',
    )
    // 不带 ownerId 的旧调用方同样不能续租：租约与 execution 自相矛盾。
    await assert.rejects(
      () => store.renewLease(runsRoot, meta.id, { pid: 111, host: 'h1', now: new Date(t0.getTime() + 2000) }),
      error => error && error.status === 409,
    )
    await assert.rejects(
      () => store.releaseLease(runsRoot, meta.id, { pid: 111, host: 'h1', ownerId: 'owner-old' }),
      error => error && error.status === 409,
      '旧 owner 不得释放已被新 epoch 取代的租约',
    )
    assert.equal(readFileSync(lockPath, 'utf8'), lockBefore, '失败续租/释放不得改写租约文件')
    const after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.execution.epoch, 2)
    assert.equal(after.execution.ownerId, 'owner-new')
  })

  // F1-③：renew/release 必须与 claim 共用跨进程 meta.lock。父进程用 appendEvents 的 guard
  // 占住 meta.lock，子进程的续租/释放必须停在锁外；旧实现不持这把锁，会当场改/删租约。
  await check('F1（审查 P0）：续租/释放与 claim 共用跨进程 meta.lock（持锁期间旧 owner 不能改/删租约）', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const t0 = new Date('2026-11-06T12:00:00.000Z')
    await store.startRun(runsRoot, meta.id, { now: t0 })
    const owner = 'owner-lock'
    await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: owner, ttlMs: 60_000, now: t0,
    })
    const lockPath = join(runsRoot, meta.id, 'lock.json')
    const heartbeatBefore = JSON.parse(readFileSync(lockPath, 'utf8')).heartbeatAt

    const childScript = join(home, 'lease-renew-release-child.mjs')
    writeFileSync(childScript, [
      `const store = await import(${JSON.stringify(new URL('../src/runstore.js', import.meta.url).href)})`,
      'const [root, id, ownerId] = process.argv.slice(2)',
      "const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')",
      'try {',
      "  const renewed = await store.renewLease(root, id, { pid: 111, host: 'h1', ownerId, now: new Date() })",
      "  emit({ step: 'renew', ok: true, heartbeatAt: renewed.heartbeatAt })",
      '} catch (error) {',
      "  emit({ step: 'renew', ok: false, status: error && error.status })",
      '}',
      'try {',
      "  const released = await store.releaseLease(root, id, { pid: 111, host: 'h1', ownerId })",
      "  emit({ step: 'release', ok: released })",
      '} catch (error) {',
      "  emit({ step: 'release', ok: false, status: error && error.status })",
      '}',
    ].join('\n'))

    // 父进程占住跨进程 meta.lock。
    let enteredResolve
    let releaseResolve
    const entered = new Promise(resolve => { enteredResolve = resolve })
    const release = new Promise(resolve => { releaseResolve = resolve })
    const hold = store.appendEvents(runsRoot, meta.id, [{
      v: 1, kind: 'node/start', nodeId: 'n_hold_meta', attemptId: 1, traceId: 'tr-hold-meta',
      data: { title: 'hold', mode: 'single', skills: [] },
    }], {
      guard: async () => {
        enteredResolve()
        await release
      },
    })
    await entered

    const child = spawn(process.execPath, [childScript, runsRoot, meta.id, owner], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childOut = ''
    let childErr = ''
    child.stdout.on('data', chunk => { childOut += chunk })
    child.stderr.on('data', chunk => { childErr += chunk })
    const childExit = new Promise(resolve => child.once('exit', resolve))
    try {
      await new Promise(resolve => setTimeout(resolve, 500))
      assert.equal(childOut, '',
        `续租/释放必须等 meta.lock（旧实现会在持锁期间改租约）：${childErr.slice(0, 200)}`)
      const during = JSON.parse(readFileSync(lockPath, 'utf8'))
      assert.equal(during.heartbeatAt, heartbeatBefore, '持锁期间心跳不得被续租刷新')
      assert.ok(existsSync(lockPath), '持锁期间任一方都不得删租约')
    } finally {
      releaseResolve()
    }
    await hold
    const code = await childExit
    assert.equal(code, 0, `子进程失败：${childErr.slice(0, 300)}`)
    const reports = childOut.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.equal(reports.find(item => item.step === 'renew').ok, true, '锁释放后续租成功')
    assert.equal(reports.find(item => item.step === 'release').ok, true, '锁释放后释放成功')
    assert.ok(!existsSync(lockPath), '释放后租约文件必须删除')
  })

  // F1-④：真子进程 claim 接管后，旧 owner 的续租必须 409；旧业务写 0 条；锁与 epoch 归新 owner。
  await check('F1（审查 P0·子进程）：claim 接管后旧 owner 续租 409，新锁/epoch 归新 owner，旧业务写 0 条', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const t0 = new Date('2026-11-06T12:00:00.000Z')
    await store.startRun(runsRoot, meta.id, { now: t0 })
    const old = await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-old', ttlMs: 1, now: t0,
    })
    assert.equal(old.epoch, 1)

    // 子进程用**同一个 pid@host**、不同 ownerId 接管：旧实现的 renew 只看 pid@host。
    const childScript = join(home, 'lease-claim-f1-child.mjs')
    writeFileSync(childScript, [
      `const store = await import(${JSON.stringify(new URL('../src/runstore.js', import.meta.url).href)})`,
      'const [root, id] = process.argv.slice(2)',
      'try {',
      "  const lease = await store.claimLease(root, id, { pid: 111, host: 'h1', ownerId: 'owner-new', ttlMs: 60000, now: new Date() })",
      "  process.stdout.write(JSON.stringify({ ok: true, epoch: lease.epoch, ownerId: lease.ownerId }) + '\\n')",
      '} catch (error) {',
      "  process.stdout.write(JSON.stringify({ ok: false, status: error && error.status }) + '\\n')",
      '  process.exit(2)',
      '}',
    ].join('\n'))
    const claimed = await runNodeScript(childScript, [runsRoot, meta.id])
    assert.equal(claimed.code, 0, `子进程 claim 失败：${claimed.stderr.slice(0, 300)}`)
    const claimReport = JSON.parse(claimed.stdout.trim())
    assert.equal(claimReport.ok, true)
    assert.equal(claimReport.epoch, 2, '子进程接管必须拿到 epoch 2')

    await assert.rejects(
      () => store.renewLease(runsRoot, meta.id, {
        pid: 111, host: 'h1', ownerId: 'owner-old', now: new Date(),
      }),
      error => error && error.status === 409,
      '旧 owner 续租必须 409',
    )
    const after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.execution.epoch, 2, '新 epoch 不得被旧 owner 覆盖')
    assert.equal(after.execution.ownerId, 'owner-new', 'execution.ownerId 必须是新 owner')
    const lock = JSON.parse(readFileSync(join(runsRoot, meta.id, 'lock.json'), 'utf8'))
    assert.equal(lock.epoch, 2, 'lock.json.epoch 必须是新 epoch')
    assert.equal(lock.ownerId, 'owner-new', 'lock.json.ownerId 必须是新 owner')

    await assert.rejects(
      () => store.appendEvents(runsRoot, meta.id, [{
        v: 1, kind: 'node/start', nodeId: 'n_old_cross', attemptId: 1, traceId: 'tr-old-cross',
        data: { title: 'old', mode: 'single', skills: [] },
      }], { ownerId: old.ownerId, leaseEpoch: old.epoch }),
      error => error && error.status === 409 && error.code === 'LEASE_FENCED',
    )
    const events = (await store.readAllEvents(runsRoot, meta.id)).events
    assert.equal(events.some(item => item.nodeId === 'n_old_cross'), false, '旧业务写必须 0 条落盘')
  })

  // N2（独立复核·阻断）：leaseHeldBy 的兼容回退只剩「run.json 里还没有 execution」这一种
  // 合法场景。一旦持久世代存在，缺少 ownerId 的调用方（旧插件 / 裸调 releaseLease）就
  // 无法证明自己是这一代——同进程内新旧 owner 共享 pid@host，pid@host 比对等于放行。
  await check('N2（复核阻断）：接管后不带 ownerId 的 renew 必须 409，且不得刷新新 owner 心跳', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const t0 = new Date('2026-11-06T12:00:00.000Z')
    await store.startRun(runsRoot, meta.id, { now: t0 })
    await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-old', ttlMs: 1, now: t0,
    })
    // 旧租约过期后，同一个 pid@host 被新 owner 接管（同进程 ABA：pid/host 完全一样）。
    const fresh = await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-new', ttlMs: 60_000,
      now: new Date(t0.getTime() + 10_000),
    })
    assert.equal(fresh.epoch, 2)
    const lockPath = join(runsRoot, meta.id, 'lock.json')
    const locked = readFileSync(lockPath, 'utf8')
    const before = JSON.parse(locked)

    await assert.rejects(
      () => store.renewLease(runsRoot, meta.id, {
        pid: 111, host: 'h1', now: new Date(t0.getTime() + 20_000),
      }),
      error => error && error.status === 409,
      '不带 ownerId 的续租不能写已被接管的租约',
    )
    const after = JSON.parse(readFileSync(lockPath, 'utf8'))
    assert.equal(after.heartbeatAt, before.heartbeatAt, '失败续租不得刷新新 owner 的心跳')
    assert.equal(after.ownerId, 'owner-new', '失败续租不得改写 ownerId')
    assert.equal(after.epoch, 2, '失败续租不得改写 epoch')
    assert.equal(readFileSync(lockPath, 'utf8'), locked, '失败续租不得改写 lock.json 一个字节')

    // 现任 owner 带 ownerId 仍能续租：关掉的只是「无法证明世代」的调用方。
    const renewed = await store.renewLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-new', now: new Date(t0.getTime() + 30_000),
    })
    assert.equal(renewed.ownerId, 'owner-new')
  })

  await check('N2（复核阻断）：接管后不带 ownerId 的 release 必须 409，且新租约仍在', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const t0 = new Date('2026-11-06T12:00:00.000Z')
    await store.startRun(runsRoot, meta.id, { now: t0 })
    await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-old', ttlMs: 1, now: t0,
    })
    const fresh = await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-new', ttlMs: 60_000,
      now: new Date(t0.getTime() + 10_000),
    })
    assert.equal(fresh.epoch, 2)
    const lockPath = join(runsRoot, meta.id, 'lock.json')
    const locked = readFileSync(lockPath, 'utf8')
    const before = JSON.parse(locked)

    await assert.rejects(
      () => store.releaseLease(runsRoot, meta.id, { pid: 111, host: 'h1' }),
      error => error && error.status === 409,
      '不带 ownerId 的释放不能删已被接管的租约',
    )
    assert.ok(existsSync(lockPath), '失败释放不得删掉新 owner 的租约')
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).heartbeatAt, before.heartbeatAt)
    assert.equal(readFileSync(lockPath, 'utf8'), locked, '失败释放不得改写 lock.json 一个字节')

    // 现任 owner 带 ownerId 仍能释放。
    assert.equal(await store.releaseLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-new',
    }), true, '现任 owner 带 ownerId 必须能释放')
    assert.ok(!existsSync(lockPath), '带正确 ownerId 的释放必须删掉租约')
  })

  // N2（兼容边界）：只有「run.json 还没有 execution 字段」的旧 run 才允许 pid@host 回退。
  // 这是 0.10 旧二进制留下的形态（claim 不写 execution，lock.json 也没有 ownerId/epoch）。
  await check('N2（兼容）：run.json 无 execution 的旧 run 仍允许 pid@host 的 renew/release', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const t0 = new Date('2026-11-06T12:00:00.000Z')
    await store.startRun(runsRoot, meta.id, { now: t0 })
    await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-legacy', ttlMs: 60_000, now: t0,
    })
    // 抹回 0.10 形态：run.json 无 execution，lock.json 无 ownerId / epoch。
    const metaPath = join(runsRoot, meta.id, 'run.json')
    const disk = JSON.parse(readFileSync(metaPath, 'utf8'))
    delete disk.execution
    writeFileSync(metaPath, `${JSON.stringify(disk, null, 2)}\n`)
    const lockPath = join(runsRoot, meta.id, 'lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    delete lock.ownerId
    delete lock.epoch
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

    const renewed = await store.renewLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', now: new Date(t0.getTime() + 1000),
    })
    assert.equal(renewed.pid, 111, '旧调用方的续租仍生效')
    assert.equal(Date.parse(renewed.heartbeatAt), t0.getTime() + 1000, '旧调用方的续租必须刷新心跳')
    assert.equal(await store.releaseLease(runsRoot, meta.id, { pid: 111, host: 'h1' }), true,
      '旧调用方的释放仍生效')
    assert.ok(!existsSync(lockPath), '旧 run 的租约必须能被释放')
  })

  // F6-①：同一个 loss key 的两个 finalize 并发。旧实现在锁外查幂等键与终态，两个都能
  // 走到 append；guard 只比 epoch/owner、不查 execution.state，于是各写一条 run/end。
  await check('F6（审查 P1）：并发相同 loss key 的 finalize 只落一条 run/end（幂等判定在锁内）', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const t0 = new Date('2026-11-06T12:00:00.000Z')
    await store.startRun(runsRoot, meta.id, { now: t0 })
    const lease = await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-f6', ttlMs: 60_000, now: t0,
    })

    // 占住 meta.lock：让两个 finalize 都完成「锁外读」后停在写入前（旧实现的双写窗口）。
    let enteredResolve
    let releaseResolve
    const entered = new Promise(resolve => { enteredResolve = resolve })
    const release = new Promise(resolve => { releaseResolve = resolve })
    const hold = store.appendEvents(runsRoot, meta.id, [{
      v: 1, kind: 'node/start', nodeId: 'n_f6_hold', attemptId: 1, traceId: 'tr-f6-hold',
      data: { title: 'hold', mode: 'single', skills: [] },
    }], {
      guard: async () => {
        enteredResolve()
        await release
      },
    })
    await entered

    const options = {
      expectedEpoch: lease.epoch,
      ownerId: lease.ownerId,
      idempotencyKey: 'loss:1',
      now: new Date(),
    }
    const first = store.finalizeEpoch(runsRoot, meta.id, options)
    const second = store.finalizeEpoch(runsRoot, meta.id, options)
    await new Promise(resolve => setTimeout(resolve, 500))
    releaseResolve()
    await hold
    const settled = await Promise.all([first, second])

    const all = await store.readAllEvents(runsRoot, meta.id)
    const ends = all.events.filter(item => item.kind === 'run/end'
      && item.extra && item.extra.idempotencyKey === 'loss:1')
    assert.equal(ends.length, 1, `同一 loss key 只能有一条 end（实际 ${ends.length} 条）`)
    assert.equal(settled.filter(item => item.appended === true).length, 1, '只有一次真正追加')
    assert.equal(settled.filter(item => item.idempotent === true).length, 1, '另一次必须幂等返回')
    assert.equal(settled.find(item => item.appended === true).terminalScope, 'run')
    const after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.status, 'failed')
    assert.equal(after.execution.state, 'settled')
    assert.equal(after.execution.epoch, lease.epoch)
  })

  // F6-②：接管后旧 epoch 的 finalize 只能记 instance 事实；并发的两个 finalize 也不得双写，
  // 更不得改动新 owner 的 status / execution。
  await check('F6（审查 P1）：接管后并发失权收口只写一条 instance 事实，且不改新 owner 状态', async () => {
    const meta = await makeRun()
    created.push(meta.id)
    const t0 = new Date('2026-11-06T12:00:00.000Z')
    await store.startRun(runsRoot, meta.id, { now: t0 })
    const old = await store.claimLease(runsRoot, meta.id, {
      pid: 111, host: 'h1', ownerId: 'owner-old', ttlMs: 1, now: t0,
    })
    const fresh = await store.claimLease(runsRoot, meta.id, {
      pid: 222, host: 'h2', ownerId: 'owner-new', ttlMs: 60_000, now: new Date(t0.getTime() + 10_000),
    })
    assert.equal(fresh.epoch, 2)

    let enteredResolve
    let releaseResolve
    const entered = new Promise(resolve => { enteredResolve = resolve })
    const release = new Promise(resolve => { releaseResolve = resolve })
    const hold = store.appendEvents(runsRoot, meta.id, [{
      v: 1, kind: 'node/start', nodeId: 'n_f6_hold2', attemptId: 1, traceId: 'tr-f6-hold2',
      data: { title: 'hold', mode: 'single', skills: [] },
    }], {
      guard: async () => {
        enteredResolve()
        await release
      },
    })
    await entered

    const options = {
      expectedEpoch: old.epoch,
      ownerId: old.ownerId,
      idempotencyKey: 'loss:1',
      now: new Date(),
    }
    const first = store.finalizeEpoch(runsRoot, meta.id, options)
    const second = store.finalizeEpoch(runsRoot, meta.id, options)
    await new Promise(resolve => setTimeout(resolve, 500))
    releaseResolve()
    await hold
    const settled = await Promise.all([first, second])

    const all = await store.readAllEvents(runsRoot, meta.id)
    const ends = all.events.filter(item => item.kind === 'run/end'
      && item.extra && item.extra.idempotencyKey === 'loss:1')
    assert.equal(ends.length, 1, `旧 epoch 的 loss key 只能有一条 end（实际 ${ends.length} 条）`)
    assert.equal(ends[0].extra.terminalScope, 'instance', '旧 epoch 只能记 instance 范围事实')
    assert.equal(settled.filter(item => item.appended === true).length, 1)
    assert.equal(settled.filter(item => item.idempotent === true).length, 1)

    const after = await store.readRunMeta(runsRoot, meta.id)
    assert.equal(after.status, 'running', '不得改动新 owner 的 status')
    assert.equal(after.execution.epoch, fresh.epoch, '不得改动新 owner 的 epoch')
    assert.equal(after.execution.ownerId, 'owner-new', '不得改动新 owner 的 ownerId')
    assert.equal(after.execution.state, 'active', '不得改动新 owner 的 execution.state')

    // 新 owner 仍能写业务事件（旧实例的收口没有把它 fence 掉）。
    const accepted = await store.appendEvents(runsRoot, meta.id, [{
      v: 1, kind: 'node/start', nodeId: 'n_new_owner', attemptId: 1, traceId: 'tr-new-owner',
      data: { title: 'new', mode: 'single', skills: [] },
    }], { ownerId: fresh.ownerId, leaseEpoch: fresh.epoch })
    assert.equal(accepted.events.length, 1, '新 owner 的业务写必须仍被接受')
  })

  // 0.11 R5（本轮）：index / runtime 共用的验证器必须重读报告副本字节
  await check('R5（本轮）：共享验证器重读报告副本 sha256，副本篡改 / 删除后撤销权威', async () => {
    const meta = await makeRun()
    await store.startRun(runsRoot, meta.id, { now: NOW })
    const rel = 'n_reg/artifacts/1/report.json'
    const abs = join(runsRoot, meta.id, rel)
    mkdirSync(dirname(abs), { recursive: true })
    const body = '{"suite":"unit","passed":1}'
    writeFileSync(abs, body)
    const sha = createHash('sha256').update(body).digest('hex')
    await store.appendEvents(runsRoot, meta.id, [
      {
        v: 1, kind: 'artifact/write', nodeId: 'n_reg', attemptId: 1, traceId: 'tr-v',
        extra: { producer: 'host', authority: 'host', verificationId: 'hc-v1', verificationKind: 'report-copy' },
        data: { path: rel, bytes: Buffer.byteLength(body), kind: 'json', sha256: sha },
      },
      {
        v: 1, kind: 'check/form', nodeId: 'n_reg', attemptId: 1, traceId: 'tr-v',
        extra: { producer: 'host', authority: 'host', verificationId: 'hc-v1' },
        data: {
          ruleSetId: 'host:n_reg', ruleSetVersion: '0.11', executor: 'host', state: 'pass',
          passedChecks: 1, totalChecks: 1, executedAt: new Date().toISOString(),
        },
      },
    ])
    const receipt = store.createHostExecutionReceipt('hc-v1')
    await store.recordHostExecution(runsRoot, meta.id, {
      executionId: 'hc-v1',
      runId: meta.id,
      nodeId: 'n_reg',
      attempt: 1,
      checkId: 'host:n_reg',
      commandDigest: 'b'.repeat(64),
      expectedExitCode: 0,
      exitCode: 0,
      state: 'pass',
      reasonCode: null,
      reportPath: 'reports/unit.json',
      reportSha256: sha,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }, { receipt })

    const all = await store.readAllEvents(runsRoot, meta.id)
    const execs = await store.readHostExecutions(runsRoot, meta.id)
    const verify = store.buildHostExecutionVerifier(execs, all.events, meta.id, join(runsRoot, meta.id))
    const checkEvent = all.events.find(event => event.kind === 'check/form')
    assert.equal(verify(checkEvent), true, '报告副本字节与登记 sha256 一致时授信')
    // 关键防伪断言：文件仍在、长度不变，只替换内容（passed 1 → 0）。
    // 若有人把验证器里的 digest 比较删掉，这条会由 false 变 true → 必红。
    const tampered = body.replace('"passed":1', '"passed":0')
    assert.notEqual(tampered, body, '篡改样本必须与原报告等长且内容不同')
    assert.equal(tampered.length, body.length, '篡改样本必须与原报告等长')
    writeFileSync(abs, tampered)
    assert.equal(verify(checkEvent), false, '报告副本内容被篡改（同长度）后不得继续授信')
    rmSync(abs, { force: true })
    assert.equal(verify(checkEvent), false, '报告副本删除后不得继续授信')
  })

} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${checks} 组通过`)
