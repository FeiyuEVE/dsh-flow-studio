#!/usr/bin/env node
/**
 * 流程运行实例域存储自检：钉住定义 / 乐观锁 / 事件分片 seq 合并 / 半行追加 / 快照 / 权限 / 坏形状。
 *
 * 产物落在项目 `.tmp/` 下（每个用例一个新 home，结束清理），不占系统 / tmp；不启动 dsh。
 * 运行：node test/instance-store.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const defs = await import('../src/definition-store.js')
const store = await import('../src/instance-store.js')

const DIR_MODE = 0o700
const FILE_MODE = 0o600

let checks = 0
let assertions = 0

function eq(actual, expected, message) {
  assertions += 1
  assert.equal(actual, expected, message)
}

function deep(actual, expected, message) {
  assertions += 1
  assert.deepEqual(actual, expected, message)
}

function ok(value, message) {
  assertions += 1
  assert.ok(value, message)
}

async function rejects(fn, predicate, message) {
  assertions += 1
  await assert.rejects(fn, predicate, message)
}

/** 一个用例一个全新 home；定义域与实例域共用同一个 home。 */
async function check(name, fn) {
  const home = mkdtempSync(join(repoRoot, '.tmp', 'home-inst-'))
  try {
    await fn({ home })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

function bpmn(tag) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="${tag}">`
    + `<bpmn:process id="p-${tag}" isExecutable="true"/></bpmn:definitions>\n`
}

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')
const modeOf = path => statSync(path).mode & 0o777

/** 建一份定义并起一个实例，返回 { definition, instance, dir }。 */
async function seed(home, definitionId = 'flow-x') {
  const definition = await defs.saveDefinitionVersion(definitionId, bpmn('seed'), { name: '种子流程' }, { home })
  const instance = await store.createInstance({
    definitionId,
    definitionVersion: definition.version,
    variables: { a: 1 },
    home,
  })
  return {
    definition,
    instance,
    dir: join(store.instancesDir(home), instance.id),
  }
}

function activity(index) {
  return { kind: 'activity/start', activityId: 'task-a', label: `事件 ${index}`, ts: '2026-11-11T10:00:00.000Z' }
}

try {
  await check('创建实例：钉住定义版本/hash / 复制快照 / 默认状态与 variables 收敛', async ({ home }) => {
    const definition = await defs.saveDefinitionVersion('flow-x', bpmn('pin-v1'), { name: '钉住' }, { home })
    const instance = await store.createInstance({
      definitionId: 'flow-x',
      definitionVersion: 1,
      variables: { env: 'test' },
      home,
    })
    eq(instance.definitionId, 'flow-x', '记录 definitionId')
    eq(instance.definitionVersion, 1, '记录 definitionVersion')
    eq(instance.definitionHash, definition.hash, '钉住创建时的 definitionHash')
    eq(instance.status, 'ACTIVE', '新实例 ACTIVE')
    eq(instance.revision, 1, '新实例 revision=1')
    eq(instance.eventCount, 0, '新实例 eventCount=0')
    eq(instance.lastSeq, 0, '新实例 lastSeq=0')
    eq(instance.completedAt, null, '新实例 completedAt=null')
    eq(instance.variables.env, 'test', 'variables 随实例保存')
    ok(existsSync(join(store.instancesDir(home), instance.id, 'definition.bpmn')), '实例目录里有定义快照')
    eq(
      readFileSync(join(store.instancesDir(home), instance.id, 'definition.bpmn'), 'utf8'),
      bpmn('pin-v1'),
      '快照就是创建时的定义正文',
    )

    // 不带 definitionVersion → 钉最新版本
    await defs.saveDefinitionVersion('flow-x', bpmn('pin-v2'), {}, { home })
    const latest = await store.createInstance({ definitionId: 'flow-x', home })
    eq(latest.definitionVersion, 2, '省略 definitionVersion 时钉最新版本')
    eq(latest.definitionHash, sha256(bpmn('pin-v2')), '最新版本的 hash 正确')

    // 调用方带了过期 hash → 409，不建目录
    const before = (await store.listInstances({ home })).length
    await rejects(
      () => store.createInstance({ definitionId: 'flow-x', definitionVersion: 1, definitionHash: sha256('nope'), home }),
      error => error.status === 409 && error.code === 'DEFINITION_STALE',
      'definitionHash 过期时拒绝钉住',
    )
    eq((await store.listInstances({ home })).length, before, '被拒绝的创建不得留下实例目录')

    await rejects(
      () => store.createInstance({ definitionId: 'missing-def', home }),
      error => error.status === 404 && error.code === 'DEFINITION_NOT_FOUND',
      '定义不存在时 404',
    )
  })

  await check('乐观锁：expectedVersion 不匹配返回结构化 409，且不写盘', async ({ home }) => {
    const { instance } = await seed(home)
    const updated = await store.updateInstance(instance.id, {
      expectedVersion: 1,
      status: 'ACTIVE',
      variables: { b: 2 },
    }, { home })
    eq(updated.revision, 2, '成功更新后 revision +1')
    eq(updated.status, 'ACTIVE', 'status 被更新')
    deep(updated.variables, { a: 1, b: 2 }, 'variables 浅合并')

    await rejects(
      () => store.updateInstance(instance.id, { expectedVersion: 1, status: 'SUSPENDED' }, { home }),
      error => error.status === 409
        && error.code === 'INSTANCE_VERSION_CONFLICT'
        && error.expectedVersion === 1
        && error.actualVersion === 2,
      '旧 expectedVersion 必须 409 INSTANCE_VERSION_CONFLICT',
    )
    const afterConflict = await store.readInstance(instance.id, { home })
    eq(afterConflict.status, 'ACTIVE', '冲突时状态不被写')
    eq(afterConflict.revision, 2, '冲突时 revision 不变')

    await rejects(
      () => store.updateInstance(instance.id, { definitionHash: sha256('x') }, { home }),
      error => error.status === 400 && error.code === 'INSTANCE_PATCH_INVALID',
      '定义域字段是钉死的，patch 里出现必须 400',
    )
    await rejects(
      () => store.updateInstance('i-missing', { status: 'ACTIVE' }, { home }),
      error => error.status === 404 && error.code === 'INSTANCE_NOT_FOUND',
      '不存在的实例 404',
    )
  })

  await check('事件分片：按 seq 合并、seq 单调且跨 activity / attempt 不重复', async ({ home }) => {
    const { instance, dir } = await seed(home)
    const first = await store.appendInstanceEvents(instance.id, 'task-a', 1, [
      activity(1), activity(2),
    ], { home })
    deep([first.firstSeq, first.lastSeq], [1, 2], '第一批分配 seq 1..2')
    eq(first.events[0].seq, 1, '返回事件带 seq')
    eq(first.events[1].seq, 2, '返回事件带 seq')

    const second = await store.appendInstanceEvents(instance.id, 'task-b', 1, [activity(3)], { home })
    deep([second.firstSeq, second.lastSeq], [3, 3], '第二个分片接着全局 seq')

    const third = await store.appendInstanceEvents(instance.id, 'task-a', 2, [activity(4), activity(5)], { home })
    deep([third.firstSeq, third.lastSeq], [4, 5], '同一 activity 的第二次 attempt 继续递增')

    const events = await store.readInstanceEvents(instance.id, { home })
    eq(events.length, 5, '合并后共有 5 条事件')
    deep(events.map(event => event.seq), [1, 2, 3, 4, 5], '按 seq 升序合并')
    deep(events.map(event => event.label), [1, 2, 3, 4, 5].map(i => `事件 ${i}`), '合并结果保持 seq 因果序')
    eq(events.skipped, 0, '没有坏行')
    eq(events.shards, 3, '三个分片文件')
    ok(existsSync(join(dir, 'events', 'task-a', '1.jsonl')), 'events/<activityId>/<attempt>.jsonl 路径')
    ok(existsSync(join(dir, 'events', 'task-b', '1.jsonl')), '不同 activity 分文件')
    ok(existsSync(join(dir, 'events', 'task-a', '2.jsonl')), '不同 attempt 分文件')

    const current = await store.readInstance(instance.id, { home })
    eq(current.eventCount, 5, 'instance.json 维护 eventCount')
    eq(current.lastSeq, 5, 'instance.json 维护 lastSeq')
    eq(current.revision, 4, '三次追加各涨一次 revision（1+3）')
  })

  await check('半行（进程被杀）：追加前补换行，坏行被跳过且后续 seq 不断', async ({ home }) => {
    const { instance, dir } = await seed(home)
    await store.appendInstanceEvents(instance.id, 'task-a', 1, [activity(1), activity(2)], { home })
    const shard = join(dir, 'events', 'task-a', '1.jsonl')
    ok(readFileSync(shard, 'utf8').endsWith('\n'), '正常追加后文件以换行结尾')

    // 模拟写入中途被杀：尾部留半行（没有换行）
    appendFileSync(shard, '{"seq":99,"broken":', { encoding: 'utf8' })
    ok(!readFileSync(shard, 'utf8').endsWith('\n'), '半行确实没有换行结尾')

    const appended = await store.appendInstanceEvents(instance.id, 'task-a', 1, [activity(3)], { home })
    eq(appended.firstSeq, 3, 'seq 从 instance.json 的 lastSeq 续写，不受坏行影响')
    ok(readFileSync(shard, 'utf8').endsWith('\n'), '追加后文件重新以换行结尾')

    const events = await store.readInstanceEvents(instance.id, { home })
    eq(events.length, 3, '半行不产生事件')
    eq(events.skipped, 1, '坏行计入 skipped')
    deep(events.map(event => event.seq), [1, 2, 3], '有效事件 seq 仍严格递增')
    deep(events.map(event => event.label), ['事件 1', '事件 2', '事件 3'], '新事件没有粘进坏行')
  })

  await check('引擎快照：读写往返 / 覆盖 / 空快照 / 坏 JSON 报 CORRUPT', async ({ home }) => {
    const { instance, dir } = await seed(home)
    eq(await store.readInstanceState(instance.id, { home }), null, '没有快照时返回 null')

    const state = { engine: 'bpmn-engine', tokens: [1, 2], nested: { step: 3 } }
    const saved = await store.writeInstanceState(instance.id, state, { home })
    ok(saved.bytes > 0, 'writeInstanceState 返回字节数')
    ok(Number.isFinite(Date.parse(saved.savedAt)), 'writeInstanceState 返回 ISO savedAt')
    deep(await store.readInstanceState(instance.id, { home }), state, '快照读回与写入一致')
    ok(existsSync(join(dir, 'state.json')), '快照落在 state.json')

    await store.writeInstanceState(instance.id, { engine: 'bpmn-engine', tokens: [9] }, { home })
    deep(await store.readInstanceState(instance.id, { home }), { engine: 'bpmn-engine', tokens: [9] }, '快照可覆盖（缓存语义）')

    await store.writeInstanceState(instance.id, null, { home })
    deep(await store.readInstanceState(instance.id, { home }), {}, 'null 快照写成空对象')

    writeFileSync(join(dir, 'state.json'), '{ not json', { mode: FILE_MODE })
    await rejects(
      () => store.readInstanceState(instance.id, { home }),
      error => error.status === 500 && error.code === 'INSTANCE_STATE_CORRUPT',
      '坏 state.json 必须 500 INSTANCE_STATE_CORRUPT',
    )
  })

  await check('completeInstance：只能进终态、写 completedAt、同终态幂等、列表可按状态过滤', async ({ home }) => {
    const { instance } = await seed(home)
    const done = await store.completeInstance(instance.id, 'COMPLETED', { home })
    eq(done.status, 'COMPLETED', '状态变成 COMPLETED')
    eq(done.revision, 2, '收口后 revision +1')
    ok(Number.isFinite(Date.parse(done.completedAt)), '终态写 completedAt')

    const idempotent = await store.completeInstance(instance.id, 'COMPLETED', { home })
    eq(idempotent.revision, 2, '重复收口同一终态不涨 revision')

    await rejects(
      () => store.completeInstance(instance.id, 'ACTIVE', { home }),
      error => error.status === 400 && error.code === 'INSTANCE_STATUS_INVALID',
      '非终态不能走 completeInstance',
    )

    const all = await store.listInstances({ home })
    eq(all.length, 1, 'listInstances 列出实例')
    eq(all[0].status, 'COMPLETED', '列表里是终态')
    eq((await store.listInstances({ home, status: 'COMPLETED' })).length, 1, '按状态过滤命中')
    eq((await store.listInstances({ home, status: 'ACTIVE' })).length, 0, '按状态过滤排除')
    eq((await store.listInstances({ home, definitionId: 'flow-x' })).length, 1, '按定义过滤命中')
    eq((await store.listInstances({ home, definitionId: 'flow-other' })).length, 0, '按定义过滤排除')
    await rejects(
      () => store.listInstances({ home, status: 'bogus' }),
      error => error.status === 400 && error.code === 'INSTANCE_FILTER_INVALID',
      '未知状态过滤必须 400',
    )
  })

  await check('并发追加：seq 不重复且严格递增（同一实例一把跨进程锁）', async ({ home }) => {
    const { instance } = await seed(home)
    const jobs = []
    for (let index = 0; index < 8; index += 1) {
      jobs.push(store.appendInstanceEvents(instance.id, 'task-a', 1, [{ index }], { home }))
    }
    await Promise.all(jobs)

    const events = await store.readInstanceEvents(instance.id, { home })
    eq(events.length, 8, '并发追加一条不丢')
    deep(events.map(event => event.seq), [1, 2, 3, 4, 5, 6, 7, 8], '并发追加的 seq 不重复且严格递增')
    const current = await store.readInstance(instance.id, { home })
    eq(current.eventCount, 8, 'eventCount 与落盘事件数一致')
    eq(current.lastSeq, 8, 'lastSeq 与最大 seq 一致')
    eq(current.revision, 9, '每次追加各涨一次 revision（1+8）')
  })

  await check('权限：实例目录 0700，instance.json / 快照 / 事件分片 / state.json 0600', async ({ home }) => {
    const { instance, dir } = await seed(home)
    await store.appendInstanceEvents(instance.id, 'task-a', 1, [activity(1)], { home })
    await store.writeInstanceState(instance.id, { step: 1 }, { home })

    eq(modeOf(store.instancesDir(home)), DIR_MODE, 'instances 根目录 0700')
    eq(modeOf(dir), DIR_MODE, '实例目录 0700')
    eq(modeOf(join(dir, 'instance.json')), FILE_MODE, 'instance.json 0600')
    eq(modeOf(join(dir, 'definition.bpmn')), FILE_MODE, 'definition.bpmn 0600')
    eq(modeOf(join(dir, 'state.json')), FILE_MODE, 'state.json 0600')
    eq(modeOf(join(dir, 'events')), DIR_MODE, 'events 目录 0700')
    eq(modeOf(join(dir, 'events', 'task-a')), DIR_MODE, 'activity 目录 0700')
    eq(modeOf(join(dir, 'events', 'task-a', '1.jsonl')), FILE_MODE, '事件分片 0600')
    eq(existsSync(join(dir, '.lock')), false, '操作结束后不残留 .lock 文件')
  })

  await check('坏 JSON / 坏形状：读报 CORRUPT，更新被拒绝且原文件不被改', async ({ home }) => {
    const { instance, dir } = await seed(home)
    const garbage = '{"id": '
    writeFileSync(join(dir, 'instance.json'), garbage, { mode: FILE_MODE })

    await rejects(
      () => store.readInstance(instance.id, { home }),
      error => error.status === 500 && error.code === 'INSTANCE_CORRUPT',
      '坏 JSON 读侧必须 500 INSTANCE_CORRUPT',
    )
    await rejects(
      () => store.updateInstance(instance.id, { status: 'ACTIVE' }, { home }),
      error => error.status === 500 && error.code === 'INSTANCE_CORRUPT',
      '坏 instance.json 时更新必须拒绝',
    )
    eq(readFileSync(join(dir, 'instance.json'), 'utf8'), garbage, '被拒绝的更新不得改原文件字节')

    const badShape = JSON.stringify({ id: instance.id, definitionId: 'flow-x' })
    writeFileSync(join(dir, 'instance.json'), badShape, { mode: FILE_MODE })
    await rejects(
      () => store.updateInstance(instance.id, { status: 'ACTIVE' }, { home }),
      error => error.status === 500 && error.code === 'INSTANCE_CORRUPT',
      '缺字段的 instance.json 必须报 CORRUPT',
    )
    eq(readFileSync(join(dir, 'instance.json'), 'utf8'), badShape, '坏形状原文件不被覆盖')

    eq(await store.readInstance('missing-instance', { home }), null, '不存在实例 readInstance 返回 null')
    eq(await store.readInstanceEvents('missing-instance', { home }), null, '不存在实例 readInstanceEvents 返回 null')
    eq(await store.readInstance('../escape', { home }), null, '路径穿越型 id 返回 null')
    await rejects(
      () => store.updateInstance('../escape', { status: 'ACTIVE' }, { home }),
      error => error.status === 400 && error.code === 'INSTANCE_INVALID_ID',
      '路径穿越型 id 的写操作必须 400',
    )
  })
} finally {
  // 每个用例自己清理 home。
}


await check('终态不可逆：COMPLETED / CANCELED 不能被改回、改另一终态或补写（字节不变）', async ({ home }) => {
  for (const terminal of ['COMPLETED', 'CANCELED']) {
    const { instance, dir } = await seed(home, `flow-terminal-${terminal.toLowerCase()}`)
    const first = await store.completeInstance(instance.id, terminal, { home })
    eq(first.status, terminal)
    const before = readFileSync(join(dir, 'instance.json'), 'utf8')

    const rejectedPatches = [
      { status: 'ACTIVE' },
      { status: 'SUSPENDED' },
      { status: terminal === 'COMPLETED' ? 'CANCELED' : 'COMPLETED' },
      { variables: { late: 1 } },
      { result: { late: true } },
      { pendingTasks: [{ activityId: 'task-a' }] },
      { lastError: { code: 'LATE_ERROR', message: '晚到' } },
    ]
    for (const patch of rejectedPatches) {
      await rejects(
        () => store.updateInstance(instance.id, patch, { home }),
        error => error.status === 409 && error.code === 'INSTANCE_TERMINAL_IMMUTABLE',
        `${terminal} 之后 ${JSON.stringify(patch)} 必须 409 INSTANCE_TERMINAL_IMMUTABLE`,
      )
      eq(readFileSync(join(dir, 'instance.json'), 'utf8'), before, '被拒绝的晚到写入不得改文件字节')
    }

    // 另一终态：completeInstance 也要拒绝。
    await rejects(
      () => store.completeInstance(instance.id, terminal === 'COMPLETED' ? 'CANCELED' : 'COMPLETED', { home }),
      error => error.status === 409 && error.code === 'INSTANCE_TERMINAL_IMMUTABLE',
      '终态之间不能互相改写',
    )
    eq(readFileSync(join(dir, 'instance.json'), 'utf8'), before, '跨终态失败也不改文件')

    // 同终态重复提交幂等：revision 不涨、文件字节不变。
    const again = await store.completeInstance(instance.id, terminal, { home })
    eq(again.revision, first.revision, '同终态重复提交不涨 revision')
    eq(readFileSync(join(dir, 'instance.json'), 'utf8'), before, '同终态重复提交不改文件字节')
  }
})

await check('lastError：ACTIVE 时可写可读；最终 variables/result 与终态一次提交', async ({ home }) => {
  const { instance } = await seed(home, 'flow-lasterror')
  const withError = await store.updateInstance(instance.id, {
    lastError: { code: 'BPMN_FLOW_TAKE_LIMIT', message: '连线超限', nodeId: 'r01', activityId: 'exec-1' },
  }, { home })
  eq(withError.status, 'ACTIVE', '出错不改 status')
  eq(withError.lastError.code, 'BPMN_FLOW_TAKE_LIMIT')
  eq(withError.lastError.nodeId, 'r01')
  eq(withError.lastError.activityId, 'exec-1')

  const done = await store.completeInstance(instance.id, 'COMPLETED', {
    home,
    variables: { verdict: 'pass' },
    result: { summary: 'ok' },
  })
  eq(done.revision, withError.revision + 1, '终态与最终结果一次提交（只涨一次 revision）')
  deep(done.variables, { a: 1, verdict: 'pass' })
  deep(done.result, { summary: 'ok' })
  eq(done.lastError.code, 'BPMN_FLOW_TAKE_LIMIT', '历史 lastError 保留（它是发生过的事实）')

  // 非终态不能走 completeInstance。
  const another = await seed(home, 'flow-nonterminal')
  await rejects(
    () => store.completeInstance(another.instance.id, 'SUSPENDED', { home }),
    error => error.status === 400 && error.code === 'INSTANCE_STATUS_INVALID',
    'completeInstance 只接受 COMPLETED / CANCELED',
  )
})

await check('终态写保护：事件 / state.json 晚到写入被拒，revision 不涨、文件字节不变', async ({ home }) => {
  const { instance, dir } = await seed(home, 'flow-terminal-writes')
  // 先落一份 ACTIVE 快照，再进终态：证明终态后连快照覆盖都不允许。
  await store.writeInstanceState(instance.id, { step: 1 }, { home })
  const terminal = await store.completeInstance(instance.id, 'COMPLETED', { home })
  const instanceBefore = readFileSync(join(dir, 'instance.json'), 'utf8')
  const stateBefore = readFileSync(join(dir, 'state.json'), 'utf8')

  await rejects(
    () => store.appendInstanceEvents(instance.id, 'task-a', 1, [{ type: 'artifact/write', path: 'late.md' }], { home }),
    error => error.status === 409 && error.code === 'INSTANCE_TERMINAL_IMMUTABLE',
    '终态后不允许追加事件（含 artifact/write）',
  )
  eq(readFileSync(join(dir, 'instance.json'), 'utf8'), instanceBefore, '被拒绝的事件追加不得改 instance.json（revision 不涨）')
  eq(existsSync(join(dir, 'events', 'task-a', '1.jsonl')), false, '被拒绝的事件不得落分片文件')

  await rejects(
    () => store.writeInstanceState(instance.id, { evil: true }, { home }),
    error => error.status === 409 && error.code === 'INSTANCE_TERMINAL_IMMUTABLE',
    '终态后不允许覆盖 state.json',
  )
  eq(readFileSync(join(dir, 'state.json'), 'utf8'), stateBefore, '被拒绝的快照写入不得改 state.json 字节')
  eq((await store.readInstance(instance.id, { home })).revision, terminal.revision, '终态 revision 不涨')
})

await check('进入终态时强制清空 pendingTasks（显式非空也不行）', async ({ home }) => {
  const { instance } = await seed(home, 'flow-terminal-pending')
  const done = await store.updateInstance(instance.id, {
    status: 'COMPLETED',
    pendingTasks: [{ activityId: 'late-task' }],
    variables: { final: true },
  }, { home })
  eq(done.status, 'COMPLETED')
  deep(done.pendingTasks, [], '同一次更新进入终态时 pendingTasks 必须为空')
  deep(done.variables, { a: 1, final: true }, '终态与最终变量一次提交')
})

await check('artifacts[]：默认空、可更新、终态拒写；坏形状 400', async ({ home }) => {
  const { instance } = await seed(home, 'flow-artifacts')
  eq(Array.isArray(instance.artifacts), true, '新实例有 artifacts 字段')
  deep(instance.artifacts, [], '默认空数组')

  const updated = await store.updateInstance(instance.id, {
    artifacts: [{ path: 'n1/report.md', sha256: 'a'.repeat(64), bytes: 12, kind: 'report', nodeId: 'n1', attempt: 1 }],
  }, { home })
  eq(updated.artifacts.length, 1, 'artifacts 可更新')
  eq(updated.artifacts[0].path, 'n1/report.md')
  eq((await store.readInstance(instance.id, { home })).artifacts[0].sha256, 'a'.repeat(64), 'artifacts 落盘可读')

  await rejects(
    () => store.updateInstance(instance.id, { artifacts: 'not-array' }, { home }),
    error => error.status === 400 && error.code === 'INSTANCE_SHAPE_INVALID',
    'artifacts 必须是数组',
  )

  await store.completeInstance(instance.id, 'CANCELED', { home })
  await rejects(
    () => store.updateInstance(instance.id, { artifacts: [{ path: 'late.md' }] }, { home }),
    error => error.status === 409 && error.code === 'INSTANCE_TERMINAL_IMMUTABLE',
    '终态后 artifacts 也拒写',
  )
})

await check('挂起 / 恢复：状态与事件同一次写入；终态拒绝；非法 status 400', async ({ home }) => {
  const { instance, dir } = await seed(home, 'flow-suspend-status')
  const suspended = await store.appendInstanceEvents(instance.id, 'process', 1, [
    { type: 'instance/suspended', reason: '维护' },
  ], { home, status: 'SUSPENDED' })
  eq(suspended.instance.status, 'SUSPENDED', '状态与事件一起落盘')
  eq(suspended.lastSeq, instance.lastSeq + 1, 'seq 只涨一条')
  const reopened = await store.readInstance(instance.id, { home })
  eq(reopened.status, 'SUSPENDED')
  eq(reopened.lastSeq, instance.lastSeq + 1, '事件分配后 instance.json 的 lastSeq 同步')
  deep(reopened.pendingTasks, [], '存储层不清待办（由 runtime 决定保留）')

  const resumed = await store.appendInstanceEvents(instance.id, 'process', 1, [
    { type: 'instance/resumed', reason: '完成' },
  ], { home, status: 'ACTIVE' })
  eq(resumed.instance.status, 'ACTIVE')
  eq((await store.readInstance(instance.id, { home })).status, 'ACTIVE')

  await rejects(
    () => store.appendInstanceEvents(instance.id, 'process', 1, [{ type: 'x' }], { home, status: 'COMPLETED' }),
    error => error.status === 400 && error.code === 'INSTANCE_STATUS_INVALID',
    '终态不能走 append 的 status 选项',
  )
  await store.completeInstance(instance.id, 'CANCELED', { home })
  await rejects(
    () => store.appendInstanceEvents(instance.id, 'process', 1, [{ type: 'instance/suspended' }], { home, status: 'SUSPENDED' }),
    error => error.status === 409 && error.code === 'INSTANCE_TERMINAL_IMMUTABLE',
    '终态后不允许再接挂起事件',
  )
  eq(existsSync(join(dir, 'events', 'process', '1.jsonl')), true, '挂起 / 恢复事件分片存在')
})

console.log(`\n${checks} 组通过（${assertions} 条断言）`)
