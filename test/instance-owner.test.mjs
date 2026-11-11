#!/usr/bin/env node
/**
 * 实例执行所有权（`src/instance-owner.js`）自检。
 *
 * 覆盖：selfOwner 形状 / claim 原子写与 previous / read 缺失与坏 JSON /
 * release 只删自己的 / ownerState 的 alive / gone / unknown 三态（含真子进程）。
 *
 * 产物落在项目 `.tmp/` 下（每个用例一个新 home，结束清理），不占系统 /tmp。
 * 运行：node test/instance-owner.test.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const owner = await import('../src/instance-owner.js')

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

async function check(name, fn) {
  const home = mkdtempSync(join(repoRoot, '.tmp', 'home-owner-'))
  try {
    await fn({ home })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** 建一个实例目录（owner 模块不建目录，测试自己建）。 */
function seedInstanceDir(home, instanceId = 'i-owner-1') {
  const instancesRoot = join(home, 'instances')
  const dir = join(instancesRoot, instanceId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return { instancesRoot, dir }
}

/** 起一个长命子进程（用于真实 pid / starttime 判定），结束后 SIGKILL。 */
async function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(child, 'spawn')
  // 等 /proc 就绪（新进程刚开始时 stat 一定已有，但保险）。
  const deadline = Date.now() + 2000
  let startTime = null
  while (Date.now() < deadline) {
    startTime = await owner.linuxProcessStartTime(child.pid)
    if (startTime !== null) break
    await new Promise(resolveSleep => setTimeout(resolveSleep, 10))
  }
  return { child, startTime }
}

try {
  await check('selfOwner：pid/host/bootId/startTime/runtimeId，runtimeId 缺省与显式覆盖', async () => {
    const first = owner.selfOwner()
    eq(first.pid, process.pid)
    eq(first.host, owner.HOST_NAME)
    eq(first.bootId, owner.PROCESS_BOOT_ID)
    ok(typeof first.runtimeId === 'string' && UUID_V4.test(first.runtimeId), 'runtimeId 是 uuid4')
    ok(process.platform !== 'linux' || typeof first.startTime === 'string', 'Linux 上 startTime 可读')
    eq(first.runtimeId, owner.selfOwner().runtimeId, '未显式给 runtimeId 时用模块级默认值')

    const explicit = owner.selfOwner('runtime-explicit')
    eq(explicit.runtimeId, 'runtime-explicit', '显式 runtimeId 生效')
    eq(explicit.pid, process.pid)
  })

  await check('claim / read：原子写 owner.json（0600）、返回 previous、缺失返回 null', async ({ home }) => {
    const { instancesRoot, dir } = seedInstanceDir(home, 'i-claim')
    const mine = owner.selfOwner('runtime-a')
    const claimed = await owner.claimInstanceOwner('i-claim', { instancesRoot, owner: mine })
    eq(claimed.previous, null, '首次 claim 没有 previous')
    eq(claimed.owner.runtimeId, 'runtime-a')
    eq(mine.runtimeId, 'runtime-a')
    ok(typeof claimed.owner.since === 'string' && claimed.owner.since !== '', 'claim 自动补 since')
    const path = owner.ownerFilePath(dir)
    eq(statSync(path).mode & 0o777, 0o600, 'owner.json 0600')

    const read = await owner.readInstanceOwner('i-claim', { instancesRoot })
    eq(read.state, 'alive', '自己写的 owner 是 alive')
    eq(read.owner.runtimeId, 'runtime-a')
    eq(read.owner.pid, process.pid)

    const second = await owner.claimInstanceOwner('i-claim', { instancesRoot, owner: owner.selfOwner('runtime-b') })
    eq(second.previous.runtimeId, 'runtime-a', 'claim 返回上一个 owner')
    eq(second.owner.runtimeId, 'runtime-b', '后写覆盖')

    eq(await owner.readInstanceOwner('i-missing', { instancesRoot }), null, '不存在实例读 owner 返回 null')
    eq(owner.ownerFilePath(dir), join(dir, 'owner.json'))
  })

  await check('坏 JSON / 坏形状：read 报 unknown，不当成 gone；claim 可覆盖且 previous 为 null', async ({ home }) => {
    const { instancesRoot, dir } = seedInstanceDir(home, 'i-corrupt')
    writeFileSync(owner.ownerFilePath(dir), '{"pid": ', 'utf8')
    const read = await owner.readInstanceOwner('i-corrupt', { instancesRoot })
    eq(read.state, 'unknown', '坏 JSON 必须是 unknown（保守，不许抢）')
    eq(read.owner, null)
    ok(!existsSync(join(dir, 'owner.json.tmp')), '读不写文件')

    const claimed = await owner.claimInstanceOwner('i-corrupt', {
      instancesRoot,
      owner: owner.selfOwner('runtime-c'),
    })
    eq(claimed.previous, null, '坏 JSON 不能当 previous 返回')
    eq((await owner.readInstanceOwner('i-corrupt', { instancesRoot })).state, 'alive')
  })

  await check('release：只删自己写的 runtimeId；别人的记录原样保留', async ({ home }) => {
    const { instancesRoot, dir } = seedInstanceDir(home, 'i-release')
    await owner.claimInstanceOwner('i-release', { instancesRoot, owner: owner.selfOwner('runtime-a') })
    const path = owner.ownerFilePath(dir)
    const before = readFileSync(path, 'utf8')

    eq(await owner.releaseInstanceOwner('i-release', { instancesRoot, runtimeId: 'runtime-b' }), false, 'runtimeId 不匹配不删')
    eq(readFileSync(path, 'utf8'), before, '文件字节不变')
    eq(await owner.releaseInstanceOwner('i-release', { instancesRoot, runtimeId: 'runtime-a' }), true, '自己的记录可删')
    eq(existsSync(path), false, '删除后文件不存在')
    eq(await owner.releaseInstanceOwner('i-release', { instancesRoot, runtimeId: 'runtime-a' }), false, '重复释放返回 false')
  })

  await check('claim：实例目录不存在 → 404，不替它建目录', async ({ home }) => {
    const instancesRoot = join(home, 'instances')
    mkdirSync(instancesRoot, { recursive: true })
    await rejects(
      () => owner.claimInstanceOwner('i-nope', { instancesRoot, owner: owner.selfOwner('runtime-a') }),
      error => error.status === 404 && error.code === 'INSTANCE_NOT_FOUND',
      '缺实例目录必须 404',
    )
    eq(existsSync(join(instancesRoot, 'i-nope')), false, '不能靠 claim 复活实例目录')
    await rejects(
      () => owner.claimInstanceOwner('../escape', { instancesRoot, owner: owner.selfOwner('runtime-a') }),
      error => error.status === 404,
      '路径穿越 id 拒绝',
    )
    eq(await owner.readInstanceOwner('i-nope', { instancesRoot }), null)
  })

  await check('ownerState：存活子进程 alive、退出后 gone、startTime 不符 gone、跨主机 unknown', async () => {
    const { child, startTime } = await liveChild()
    try {
      ok(startTime !== null, '读到子进程 starttime')
      const base = {
        pid: child.pid,
        host: owner.HOST_NAME,
        bootId: 'child-boot',
        startTime,
        runtimeId: 'runtime-child',
      }
      eq(await owner.ownerState(base), 'alive', 'pid 存活 + starttime 一致 = alive')
      eq(await owner.ownerState({ ...base, startTime: '0' }), 'gone', 'starttime 不一致（pid 复用）= gone')
      eq(await owner.ownerState({ ...base, host: 'another-host' }), 'unknown', '跨主机 = unknown')
      eq(await owner.ownerState({ ...base, pid: null }), 'unknown', '坏 pid = unknown')
      eq(await owner.ownerState(null), 'unknown', 'null = unknown')

      // 本进程：bootId 相同 alive、bootId 不同 gone。
      eq(await owner.ownerState(owner.selfOwner('runtime-x')), 'alive', '本进程 + 当前 boot = alive')
      eq(
        await owner.ownerState({ ...owner.selfOwner('runtime-x'), bootId: 'stale-boot' }),
        'gone',
        '同 pid 但 bootId 不同 = gone（pid 被复用）',
      )
    } finally {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
    eq(await owner.ownerState({
      pid: child.pid,
      host: owner.HOST_NAME,
      bootId: 'child-boot',
      startTime,
      runtimeId: 'runtime-child',
    }), 'gone', '进程退出后 gone')
  })
} finally {
  // 每个用例自己清理 home。
}

console.log(`\n${checks} 组通过（${assertions} 条断言）`)
