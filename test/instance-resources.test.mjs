#!/usr/bin/env node
/**
 * 实例资源记录自检（0.13.7 C）：registry 原子读写 / 锁 / 损坏检测 / 独立资源事件 /
 * 工作区冻结快照。不启动 agent、不碰旧运行域。
 *
 * 运行：node test/instance-resources.test.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const defs = await import('../src/definition-store.js')
const store = await import('../src/instance-store.js')
const resources = await import('../src/instance-resources.js')

let checks = 0
let assertions = 0
let skips = 0

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

async function waitForStdout(child, needle, timeoutMs = 5_000) {
  let buffer = ''
  return await new Promise(resolveWait => {
    const timer = setTimeout(() => resolveWait(false), timeoutMs)
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      if (buffer.includes(needle)) {
        clearTimeout(timer)
        resolveWait(true)
      }
    })
    child.once('exit', () => {
      clearTimeout(timer)
      resolveWait(buffer.includes(needle))
    })
  })
}

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

  await check('锁：flock 串行 / 被占用时超时 / 锁文件常驻且无 guard 文件', async home => {
    const lock = join(home, 'test.lock')
    let releaseHolder = null
    const holderGate = new Promise(resolveGate => { releaseHolder = resolveGate })
    const holder = resources.withResourceLock(lock, async () => {
      await holderGate
      return 'A'
    }, { waitMs: 2_000 })
    ok(await waitUntil(() => existsSync(lock)), '持有者已建锁文件')
    await rejectsCode(
      () => resources.withResourceLock(lock, async () => 'never', { waitMs: 80 }),
      resources.RESOURCE_ERROR.LOCK_TIMEOUT,
      '锁被占用时超时',
    )
    ok(existsSync(lock), '等待超时不会删除持有者的锁文件')
    deep(
      readdirSync(home).filter(name => name.includes('.steal') || name.includes('.stale-')),
      [],
      '没有 guard / parking 文件（flock 协议没有 stale 恢复）',
    )
    releaseHolder()
    eq(await holder, 'A', '持有者正常结束')
    ok(existsSync(lock), '释放后锁文件常驻（删除会造成两 inode 两把锁的 ABA）')
    eq(await resources.withResourceLock(lock, async () => 'done', { waitMs: 1_000 }), 'done', '常驻锁文件可再次获取')
    ok(!existsSync(`${lock}.steal`), '从不创建 .steal guard')
  })

  await check('N3 stale 无 ABA：旧 owner/pid 内容不参与抢占判定，活持有者不被过期内容影响', async home => {
    const lock = join(home, 'stale.lock')
    // 旧格式 / 旧持有者留下的内容：pid 已不存在、owner 是旧的。flock 协议只把文件
    // 当 inode 锚点，内容不参与互斥判定，所以它不应该阻塞任何获取。
    writeFileSync(lock, `${JSON.stringify({
      v: resources.RESOURCE_LOCK_VERSION,
      owner: 'dead-token',
      pid: 999_999,
      at: new Date(Date.now() - 60_000).toISOString(),
    })}\n`)
    const startedAt = Date.now()
    eq(
      await resources.withResourceLock(lock, async () => 'stale-ok', { waitMs: 2_000 }),
      'stale-ok',
      '陈旧内容不会让新持有者等待 TTL / pid 判定',
    )
    ok(Date.now() - startedAt < 1_500, '没有 stale 恢复窗口，获取是即时的')
    ok(existsSync(lock), '锁文件保留')

    // 活持有者期间，再写一个「pid 不存在」的内容也不会让别人抢进来：互斥在内核层。
    let releaseHolder = null
    const holderGate = new Promise(resolveGate => { releaseHolder = resolveGate })
    const holder = resources.withResourceLock(lock, async () => {
      await holderGate
    }, { waitMs: 2_000 })
    ok(await waitUntil(() => existsSync(lock)), '持有者已获取')
    writeFileSync(lock, `${JSON.stringify({ v: 1, owner: 'fake-dead', pid: 999_999 })}\n`)
    await rejectsCode(
      () => resources.withResourceLock(lock, async () => 'intruder', { waitMs: 100 }),
      resources.RESOURCE_ERROR.LOCK_TIMEOUT,
      '内容看起来 stale 也不能绕过内核锁',
    )
    releaseHolder()
    await holder
  })

  await check('N3 崩溃恢复：持锁进程被 SIGKILL 后由内核释放，无需 stale 恢复', async home => {
    const lock = join(home, 'crash.lock')
    const helper = join(home, 'holder.mjs')
    writeFileSync(helper, `
import { withResourceLock } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'src', 'instance-resources.js')).href)}
const lock = process.argv[2]
await withResourceLock(lock, async () => {
  process.stdout.write('held\\n')
  await new Promise(() => {})
}, { waitMs: 5000 })
`)
    const child = spawn(process.execPath, [helper, lock], { stdio: ['ignore', 'pipe', 'inherit'] })
    try {
      eq(await waitForStdout(child, 'held'), true, '子进程已持有锁')
      child.kill('SIGKILL')
      await new Promise(resolveExit => child.once('exit', resolveExit))
      const startedAt = Date.now()
      eq(
        await resources.withResourceLock(lock, async () => 'after-crash', { waitMs: 2_000 }),
        'after-crash',
        '崩溃后没有 stale 恢复流程，内核已释放锁',
      )
      ok(Date.now() - startedAt < 1_500, '恢复不需要等 TTL / guard 清理')
      ok(!existsSync(`${lock}.steal`), '崩溃恢复也不会遗留 .steal guard')
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await new Promise(resolveExit => child.once('exit', resolveExit))
      }
    }
  })

  await check('N3 两个进程并发：任一时刻只有一个临界区（flock 跨进程互斥）', async home => {
    const lock = join(home, 'concurrent.lock')
    // 先跑一次让后端定案（Linux 上是 flock；Windows / 无 flock 平台明确 SKIP）。
    await resources.withResourceLock(lock, async () => {}, { waitMs: 2_000 })
    if (resources.resourceLockBackend() !== 'flock') {
      skips += 1
      console.log('    ↷ SKIP 当前平台没有 util-linux flock，只有进程内队列')
      return
    }
    const log = join(home, 'events.jsonl')
    const helper = join(home, 'contender.mjs')
    writeFileSync(helper, `
import { appendFileSync } from 'node:fs'
import { withResourceLock } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'src', 'instance-resources.js')).href)}
const [lockPath, logPath, holdMs, label] = process.argv.slice(2)
await withResourceLock(lockPath, async () => {
  appendFileSync(logPath, JSON.stringify({ phase: 'enter', label, at: Date.now() }) + '\\n')
  await new Promise(resolve => setTimeout(resolve, Number(holdMs)))
  appendFileSync(logPath, JSON.stringify({ phase: 'exit', label, at: Date.now() }) + '\\n')
}, { waitMs: 10000 })
`)
    const run = label => new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [helper, lock, log, '150', label], { stdio: ['ignore', 'inherit', 'inherit'] })
      child.once('error', rejectRun)
      child.once('exit', code => (code === 0 ? resolveRun() : rejectRun(new Error(`${label} exit ${code}`))))
    })
    await Promise.all([run('A'), run('B')])
    const events = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    eq(events.length, 4, '两个竞争者各进入 / 退出一次')
    let active = 0
    let maxActive = 0
    for (const event of events) {
      if (event.phase === 'enter') {
        active += 1
        maxActive = Math.max(maxActive, active)
      } else {
        active -= 1
      }
    }
    eq(maxActive, 1, '两个进程的临界区不得重叠')
    eq(active, 0, '最终没有残留的临界区')
    deep(
      readdirSync(home).filter(name => name.includes('.steal') || name.includes('.stale-')),
      [],
      '并发抢占不会生成 guard / parking（没有迟到的 unlink / rename）',
    )
    ok(existsSync(lock), '锁文件常驻，供下一次获取复用')
  })

  await check('N3 正常释放不误删继任锁：释放后继任者进入，后续竞争者仍排队', async home => {
    const lock = join(home, 'successor.lock')
    let releaseA = null
    const gateA = new Promise(resolveGate => { releaseA = resolveGate })
    const a = resources.withResourceLock(lock, async () => {
      await gateA
      return 'A'
    }, { waitMs: 2_000 })
    ok(await waitUntil(() => existsSync(lock)), 'A 持有锁文件')

    let bEntered = null
    const bEnteredSignal = new Promise(resolveEntered => { bEntered = resolveEntered })
    let releaseB = null
    const gateB = new Promise(resolveGate => { releaseB = resolveGate })
    const b = resources.withResourceLock(lock, async () => {
      bEntered()
      await gateB
      return 'B'
    }, { waitMs: 2_000 })
    // B 在 A 释放前不能进入。
    await sleep(80)
    await rejectsCode(
      () => resources.withResourceLock(lock, async () => 'C', { waitMs: 80 }),
      resources.RESOURCE_ERROR.LOCK_TIMEOUT,
      'C 也必须排队',
    )
    releaseA()
    await bEnteredSignal
    ok(existsSync(lock), 'B 持有的锁文件没有被 A 的释放删除')
    await rejectsCode(
      () => resources.withResourceLock(lock, async () => 'D', { waitMs: 80 }),
      resources.RESOURCE_ERROR.LOCK_TIMEOUT,
      'B 持有期间 D 不能进入',
    )
    releaseB()
    deep(await Promise.all([a, b]), ['A', 'B'], 'A / B 都正常完成')
    ok(!existsSync(`${lock}.steal`), '正常释放不创建 / 残留 guard')
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
  console.log(`${checks} 组通过（${assertions} 条断言）${skips > 0 ? `，${skips} 组 SKIP` : ''}`)
} catch (error) {
  console.error('✗ 实例资源自检失败')
  console.error(error)
  process.exit(1)
}
