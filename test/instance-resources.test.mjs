#!/usr/bin/env node
/**
 * 实例资源记录自检（0.13.7 C）：registry 原子读写 / 锁 / 损坏检测 / 独立资源事件 /
 * 工作区冻结快照。不启动 agent、不碰旧运行域。
 *
 * 运行：node test/instance-resources.test.mjs
 */

import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const defs = await import('../src/definition-store.js')
const store = await import('../src/instance-store.js')
const resources = await import('../src/instance-resources.js')

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

async function rejectsCode(fn, code, message) {
  assertions += 1
  await assert.rejects(fn, error => {
    assert.equal(error && error.code, code, `${message}（实际 ${error && error.code}）`)
    return true
  }, message)
}

const sleep = ms => new Promise(resolveSleep => { setTimeout(resolveSleep, ms) })

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(10)
  }
  return false
}

async function check(name, fn) {
  const home = mkdtempSync(join(repoRoot, '.tmp', 'resources-'))
  try {
    await fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

function recordFixture(overrides = {}) {
  return {
    v: 1,
    instanceId: 'i-demo',
    workspaceId: '0123456789ab',
    repositoryRoot: '/allowed/project',
    effectiveRoot: '/managed/worktrees/0123456789ab/i-demo',
    branch: 'flow-instance/i-demo',
    baseCommit: 'a'.repeat(40),
    cleanupPolicy: 'retain',
    resourceState: 'ready',
    createdAt: '2026-11-12T00:00:00.000Z',
    ...overrides,
  }
}

async function seedInstance(home, id = 'flow-res', instanceId = 'i-demo') {
  await defs.saveDefinitionVersion(id, '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d"/>', {}, {
    definitionsRoot: defs.definitionsDir(home),
  })
  return await store.createInstance({ definitionId: id, definitionsRoot: defs.definitionsDir(home), instancesRoot: store.instancesDir(home) })
}

try {
  await check('registry：原子写 / 读回 / 0600 / 删除幂等', async home => {
    const registryRoot = resources.registryRootFor(join(home, 'flow-studio'))
    const written = await resources.writeResourceRecord({ registryRoot, record: recordFixture() })
    eq(written.instanceId, 'i-demo', '写回记录 instanceId')
    eq(written.baseCommit, 'a'.repeat(40), 'baseCommit 归一为小写')
    const path = join(registryRoot, '0123456789ab', 'i-demo.json')
    ok(existsSync(path), '记录文件存在')
    eq(statSync(path).mode & 0o777, 0o600, '记录文件 0600')
    const read = await resources.readResourceRecord({ registryRoot, workspaceId: '0123456789ab', instanceId: 'i-demo' })
    deep(read, written, '读回与写回一致')
    eq(await resources.removeResourceRecord({ registryRoot, workspaceId: '0123456789ab', instanceId: 'i-demo' }), true, '首次删除 true')
    eq(await resources.removeResourceRecord({ registryRoot, workspaceId: '0123456789ab', instanceId: 'i-demo' }), false, '重复删除 false')
    eq(await resources.readResourceRecord({ registryRoot, workspaceId: '0123456789ab', instanceId: 'i-demo' }), null, '删除后读 null')
    const leftovers = []
    const scanDir = join(registryRoot, '0123456789ab')
    for (const name of existsSync(scanDir) ? await import('node:fs').then(fs => fs.readdirSync(scanDir)) : []) {
      if (name.includes('.tmp')) leftovers.push(name)
    }
    deep(leftovers, [], '没有临时文件残留')
  })

  await check('registry 损坏：读 / 扫描都显式报 RECORD_CORRUPT，不静默跳过', async home => {
    const registryRoot = resources.registryRootFor(join(home, 'flow-studio'))
    const path = join(registryRoot, '0123456789ab', 'i-demo.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{not json')
    await rejectsCode(
      () => resources.readResourceRecord({ registryRoot, workspaceId: '0123456789ab', instanceId: 'i-demo' }),
      resources.RESOURCE_ERROR.RECORD_CORRUPT,
      '坏 JSON 读失败',
    )
    const scanned = await resources.scanResourceRecords({ registryRoot })
    deep(scanned.records, [], '没有成功记录')
    eq(scanned.corrupt.length, 1, '损坏记录单列')
    eq(scanned.corrupt[0].instanceId, 'i-demo', '损坏条目带 instanceId')
  })

  await check('锁：临界区串行 / 被占用时等待超时返回 RESOURCE_LOCK_TIMEOUT', async home => {
    const lock = join(home, 'test.lock')
    writeFileSync(lock, 'held')
    await rejectsCode(
      () => resources.withResourceLock(lock, async () => 'never', { waitMs: 60, ttlMs: 60_000 }),
      resources.RESOURCE_ERROR.LOCK_TIMEOUT,
      '锁被占用时超时',
    )
    rmSync(lock)
    const value = await resources.withResourceLock(lock, async () => 'done', { waitMs: 500 })
    eq(value, 'done', '正常拿到锁执行')
    ok(!existsSync(lock), '执行结束后锁被释放')
  })

  await check('W7 锁：活持有者不被 TTL 抢占；旧持有者 release 不删继任锁', async home => {
    const lock = join(home, 'owned.lock')
    let releaseHolder = null
    const holder = resources.withResourceLock(lock, async () => {
      await new Promise(resolveHold => { releaseHolder = resolveHold })
      return 'A'
    }, { ttlMs: 60, waitMs: 1000 })
    ok(await waitUntil(() => existsSync(lock)), '持有者已建锁文件')
    // 超过 TTL 后仍不能被第二个持有者抢占（pid 还活着）。
    await sleep(120)
    await rejectsCode(
      () => resources.withResourceLock(lock, async () => 'B', { ttlMs: 60, waitMs: 80 }),
      resources.RESOURCE_ERROR.LOCK_TIMEOUT,
      '活持有者不被 TTL 抢占',
    )
    ok(existsSync(lock), 'A 的锁文件仍在')

    // 模拟继任者：A 还没 release 时锁文件被 B 接管（同 inode 覆盖 + 新 owner token）。
    writeFileSync(lock, `${JSON.stringify({
      v: resources.RESOURCE_LOCK_VERSION,
      owner: 'successor-token',
      pid: process.pid,
      at: new Date().toISOString(),
    })}\n`)
    releaseHolder()
    eq(await holder, 'A', '旧持有者任务正常结束')
    ok(existsSync(lock), '旧持有者 release 没有删掉继任锁')
    eq(JSON.parse(readFileSync(lock, 'utf8')).owner, 'successor-token', '继任锁内容未被改')
    rmSync(lock)

    // 明确 stale 判定：pid 不存在 → 可以被接管。
    writeFileSync(lock, `${JSON.stringify({
      v: resources.RESOURCE_LOCK_VERSION,
      owner: 'dead-token',
      pid: 999999,
      at: new Date(Date.now() - 60_000).toISOString(),
    })}\n`)
    eq(
      await resources.withResourceLock(lock, async () => 'C', { ttlMs: 60_000, waitMs: 1000 }),
      'C',
      'pid 不存在的 stale 锁可被接管',
    )
    ok(!existsSync(lock), '接管者释放后锁文件消失')
  })

  await check('资源事件：独立 resourceSeq / since 过滤 / 终态实例仍可写（执行事件仍封口）', async home => {
    const instance = await seedInstance(home)
    const instancesRoot = store.instancesDir(home)
    const first = await resources.appendResourceEvent({
      instancesRoot,
      instanceId: instance.id,
      event: { type: resources.RESOURCE_EVENT.WORKTREE_READY, branch: 'flow-instance/x' },
    })
    const second = await resources.appendResourceEvent({
      instancesRoot,
      instanceId: instance.id,
      event: { type: resources.RESOURCE_EVENT.WORKTREE_REMOVE, branch: 'flow-instance/x' },
    })
    eq(first.seq, 1, 'resourceSeq 从 1 开始')
    eq(second.seq, 2, 'resourceSeq 独立递增')
    const read = await resources.readResourceEvents({ instancesRoot, instanceId: instance.id })
    eq(read.resourceSeq, 2, 'resourceSeq 与事件一致')
    deep(read.events.map(event => event.seq), [1, 2], '事件按 seq 排序')
    eq(read.events[0].event, undefined, '事件平铺，不包 event 信封')
    eq(read.events[0].type, resources.RESOURCE_EVENT.WORKTREE_READY, '事件 type 保留')
    const since = await resources.readResourceEvents({ instancesRoot, instanceId: instance.id, since: 1 })
    deep(since.events.map(event => event.seq), [2], 'since 是独占下界')
    eq((await resources.readResourceEvents({ instancesRoot, instanceId: instance.id, since: 99 })).events.length, 0, 'since 超尾返回空')

    await store.completeInstance(instance.id, 'CANCELED', { instancesRoot })
    const third = await resources.appendResourceEvent({
      instancesRoot,
      instanceId: instance.id,
      event: { type: resources.RESOURCE_EVENT.BRANCH_REMOVE, branch: 'flow-instance/x', removed: true },
    })
    eq(third.seq, 3, '终态后仍可追加资源事件')
    assertions += 1
    await assert.rejects(
      () => store.appendInstanceEvents(instance.id, 'task', 1, [{ type: 'artifact/write' }], { instancesRoot }),
      '执行事件仍然被终态封口',
    )
    const eventsPath = resources.resourceEventsPath(instancesRoot, instance.id)
    ok(eventsPath.endsWith(join('resources', 'events.jsonl')), '资源事件落在 resources/events.jsonl')
    eq(basename(dirname(eventsPath)), 'resources', '资源事件在自己的 resources 目录')
    ok(!eventsPath.startsWith(join(instancesRoot, instance.id, 'events')), '资源事件不写执行事件目录')
  })

  await check('工作区快照：原子写 / 读回 / 版本与 instanceId 校验 / 坏 JSON 报 SNAPSHOT_CORRUPT', async home => {
    const instancesRoot = store.instancesDir(home)
    const instance = await seedInstance(home)
    const snapshot = {
      workspaceId: '0123456789ab',
      mode: 'worktree',
      effectiveRoot: '/managed/worktrees/0123456789ab/i-demo',
      worktree: recordFixture({ instanceId: instance.id }),
    }
    const written = await resources.writeWorkspaceSnapshot({ instancesRoot, instanceId: instance.id, snapshot })
    eq(written.v, 1, '快照 v=1')
    eq(written.instanceId, instance.id, '快照钉住 instanceId')
    const read = await resources.readWorkspaceSnapshot({ instancesRoot, instanceId: instance.id })
    eq(read.effectiveRoot, snapshot.effectiveRoot, '读回 effectiveRoot')
    eq(await resources.readWorkspaceSnapshot({ instancesRoot, instanceId: 'i-other' }), null, '缺失返回 null')

    const path = resources.workspaceSnapshotPath(instancesRoot, instance.id)
    writeFileSync(path, '{bad')
    await rejectsCode(
      () => resources.readWorkspaceSnapshot({ instancesRoot, instanceId: instance.id }),
      resources.RESOURCE_ERROR.SNAPSHOT_CORRUPT,
      '坏 JSON 报快照损坏',
    )
  })

  await check('工作区目录辅助：workspaceDirFor 拒绝非法 / 越界 workspaceId', async home => {
    const base = join(home, 'flow-studio')
    eq(resources.workspaceDirFor(base, '0123456789ab'), join(base, '0123456789ab'), '合法 workspaceId 返回根下目录')
    assertions += 1
    assert.throws(() => resources.workspaceDirFor(base, '../etc'), error => error.code === resources.RESOURCE_ERROR.INVALID_ID)
  })

  console.log('instance-resources.test.mjs')
  console.log(`${checks} 组通过（${assertions} 条断言）`)
} catch (error) {
  console.error('✗ 实例资源自检失败')
  console.error(error)
  process.exit(1)
}
