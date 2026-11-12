#!/usr/bin/env node
/**
 * 实例执行所有权（`src/instance-owner.js`）自检。
 *
 * 覆盖：selfOwner 形状 / claim 原子写与 previous / 读缺失与坏 JSON / release 只删自己的 /
 * ownerState 的 alive / gone / unknown 三态（含真子进程）/ **claim 的跨进程互斥**
 * （0.14.6 复审 NEW-1：两个真子进程同时 claim 只能有一个成功）/ 活 owner 拒绝夺取 /
 * gone 接管 / unknown 与坏 JSON 的 fail-closed。
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
    eq(second.owner.runtimeId, 'runtime-b', '同一进程的另一个 runtime 在临界区内接管（跨进程才拒绝）')
    eq(second.takeover, false, '同 pid 接管不算 gone 接管')
    eq(claimed.takeover, false, '首次登记不是接管')

    eq(await owner.readInstanceOwner('i-missing', { instancesRoot }), null, '不存在实例读 owner 返回 null')
    eq(owner.ownerFilePath(dir), join(dir, 'owner.json'))
  })

  await check('坏 JSON / 坏形状：read 报 unknown；claim fail-closed（不拿坏文件当「没有 owner」）', async ({ home }) => {
    const { instancesRoot, dir } = seedInstanceDir(home, 'i-corrupt')
    writeFileSync(owner.ownerFilePath(dir), '{"pid": ', 'utf8')
    const read = await owner.readInstanceOwner('i-corrupt', { instancesRoot })
    eq(read.state, 'unknown', '坏 JSON 必须是 unknown（保守，不许抢）')
    eq(read.owner, null)
    ok(!existsSync(join(dir, 'owner.json.tmp')), '读不写文件')

    // 0.14.6：坏文件背后可能有一个还活着的执行者，claim 不能静默覆盖（复审 NEW-1 / 未知事实）。
    await rejects(
      () => owner.claimInstanceOwner('i-corrupt', {
        instancesRoot,
        owner: owner.selfOwner('runtime-c'),
      }),
      error => error.status === 409 && error.code === 'INSTANCE_OWNER_UNKNOWN',
      '坏 owner.json 必须 fail-closed',
    )
    eq(readFileSync(owner.ownerFilePath(dir), 'utf8'), '{"pid": ', '坏文件保持原样')
    // 人工核对 / 删除后可重新登记。
    rmSync(owner.ownerFilePath(dir), { force: true })
    const claimed = await owner.claimInstanceOwner('i-corrupt', {
      instancesRoot,
      owner: owner.selfOwner('runtime-c'),
    })
    eq(claimed.previous, null, '人工清理后按首次登记处理')
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

  await check('claim：活的别的进程持有 → 409 INSTANCE_OWNED_ELSEWHERE，且不改写 owner.json', async ({ home }) => {
    const { instancesRoot, dir } = seedInstanceDir(home, 'i-live')
    const { child, startTime } = await liveChild()
    try {
      const path = owner.ownerFilePath(dir)
      const foreign = {
        pid: child.pid,
        host: owner.HOST_NAME,
        bootId: 'child-boot',
        startTime,
        runtimeId: 'runtime-child',
        since: '2026-01-01T00:00:00.000Z',
      }
      writeFileSync(path, `${JSON.stringify(foreign, null, 2)}\n`, 'utf8')
      const before = readFileSync(path, 'utf8')
      await rejects(
        () => owner.claimInstanceOwner('i-live', { instancesRoot, owner: owner.selfOwner('runtime-mine') }),
        error => error.status === 409
          && error.code === 'INSTANCE_OWNED_ELSEWHERE'
          && error.owner?.pid === child.pid
          && error.state === 'alive',
        '活 owner 必须拒绝夺取（不是「再读一次再写」）',
      )
      eq(readFileSync(path, 'utf8'), before, '被拒的 claim 不能改写 owner.json')
      eq((await owner.readInstanceOwner('i-live', { instancesRoot })).owner.runtimeId, 'runtime-child')
    } finally {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  })

  await check('claim：确认 gone 的 owner 可以接管（takeover / previous / 新记录）', async ({ home }) => {
    const { instancesRoot, dir } = seedInstanceDir(home, 'i-takeover')
    const deadPid = 999_999_999
    eq(owner.processIsAlive(deadPid), false, '前置条件：该 pid 不存在')
    writeFileSync(owner.ownerFilePath(dir), `${JSON.stringify({
      pid: deadPid,
      host: owner.HOST_NAME,
      bootId: 'dead-boot',
      startTime: '1',
      runtimeId: 'runtime-dead',
      since: '2026-01-01T00:00:00.000Z',
    }, null, 2)}\n`, 'utf8')
    const claimed = await owner.claimInstanceOwner('i-takeover', {
      instancesRoot,
      owner: owner.selfOwner('runtime-new'),
    })
    eq(claimed.takeover, true, 'gone 是唯一允许接管的判定')
    eq(claimed.state, 'gone')
    eq(claimed.previous.runtimeId, 'runtime-dead', '接管要留下 previous 诊断')
    const read = await owner.readInstanceOwner('i-takeover', { instancesRoot })
    eq(read.state, 'alive')
    eq(read.owner.runtimeId, 'runtime-new')
  })

  await check('claim：未知事实（跨主机 / 坏 JSON）fail-closed，坏文件原样保留；人工清理后可登记', async ({ home }) => {
    const { instancesRoot, dir } = seedInstanceDir(home, 'i-unknown')
    const path = owner.ownerFilePath(dir)
    writeFileSync(path, `${JSON.stringify({
      pid: process.pid,
      host: 'another-host',
      bootId: owner.PROCESS_BOOT_ID,
      startTime: null,
      runtimeId: 'runtime-other-host',
    })}\n`, 'utf8')
    await rejects(
      () => owner.claimInstanceOwner('i-unknown', { instancesRoot, owner: owner.selfOwner('runtime-mine') }),
      error => error.status === 409 && error.code === 'INSTANCE_OWNER_UNKNOWN' && error.state === 'unknown',
      '跨主机（无法确认对方是否活着）必须拒绝夺取',
    )
    rmSync(path, { force: true })
    const claimed = await owner.claimInstanceOwner('i-unknown', { instancesRoot, owner: owner.selfOwner('runtime-mine') })
    eq(claimed.previous, null, '人工删除后按首次登记处理')
    eq((await owner.readInstanceOwner('i-unknown', { instancesRoot })).owner.runtimeId, 'runtime-mine')
  })

  await check('claim 跨进程互斥：三个真子进程同时要所有权，只有一个成功；owner 只属于赢家', async ({ home }) => {
    const { instancesRoot, dir } = seedInstanceDir(home, 'i-race')
    const moduleUrl = new URL('../src/instance-owner.js', import.meta.url).href
    const startAt = Date.now() + 1200
    const script = `
      const owner = await import(${JSON.stringify(moduleUrl)})
      const startedAt = Date.now()
      while (Date.now() < ${startAt}) { /* busy-wait：让三个子进程尽量同时进入 claim */ }
      const record = owner.selfOwner('runtime-' + process.pid)
      try {
        const claimed = await owner.claimInstanceOwner('i-race', {
          instancesRoot: ${JSON.stringify(instancesRoot)},
          owner: record,
        })
        // 赢家必须活着把所有权「拿住」：否则后来者看到 pid 已退出 = gone，接管是正确行为，
        // 测不到互斥本身。所有 claim 都在 startAt 之后 100ms 内发生，1.5s 足够覆盖。
        await new Promise(resolveHold => setTimeout(resolveHold, 1500))
        process.stdout.write(JSON.stringify({ ok: true, pid: process.pid, runtimeId: claimed.owner.runtimeId, waitedMs: Date.now() - startedAt }) + '\\n')
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, pid: process.pid, code: error?.code, status: error?.status, ownerPid: error?.owner?.pid ?? null }) + '\\n')
      }
    `
    const children = [0, 1, 2].map(() => spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
    const collect = child => new Promise((resolveCollect, rejectCollect) => {
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.once('error', rejectCollect)
      child.once('exit', code => {
        if (code !== 0) {
          rejectCollect(new Error(`claim 子进程退出 ${code}：${stderr}`))
          return
        }
        try {
          resolveCollect(JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1)))
        } catch (error) {
          rejectCollect(new Error(`claim 子进程输出不可解析：${stdout} / ${stderr} / ${error?.message}`))
        }
      })
    })
    const outcomes = await Promise.all(children.map(collect))
    const winners = outcomes.filter(item => item.ok === true)
    const losers = outcomes.filter(item => item.ok !== true)
    eq(winners.length, 1, `三个并发 claim 只能有一个赢家：${JSON.stringify(outcomes)}`)
    eq(losers.length, 2)
    for (const loser of losers) {
      eq(loser.code, 'INSTANCE_OWNED_ELSEWHERE', `输家必须明确是「别人持有」：${JSON.stringify(loser)}`)
      eq(loser.status, 409)
      eq(loser.ownerPid, winners[0].pid, '输家返回的 owner 必须指向赢家进程')
    }
    // 赢家判定后已退出，所以读侧状态是 gone；关键是文件内容仍属于赢家（输家没有写盘）。
    const recorded = JSON.parse(readFileSync(owner.ownerFilePath(dir), 'utf8'))
    eq(recorded.pid, winners[0].pid, 'owner.json 属于赢家')
    eq(recorded.runtimeId, winners[0].runtimeId)
    const read = await owner.readInstanceOwner('i-race', { instancesRoot })
    eq(read.state, 'gone', '赢家退出后是可验证的 gone（允许下一次接管）')
    eq(read.owner.runtimeId, winners[0].runtimeId)
    eq(owner.ownerFilePath(dir), join(dir, 'owner.json'))
    const lockPath = owner.ownerLockFilePath(instancesRoot, 'i-race')
    ok(typeof lockPath === 'string' && existsSync(lockPath), '所有权锁文件常驻（flock 锚点，不删除）')
    ok(!lockPath.startsWith(`${dir}/`), '锁文件放在实例目录之外（release 不复活已删实例目录）')
  })

  await check('claim：同一 runtime 重复 claim 幂等（保留 since），不同 runtime 同进程可接管', async ({ home }) => {
    const { instancesRoot } = seedInstanceDir(home, 'i-reentrant')
    const mine = owner.selfOwner('runtime-a')
    const first = await owner.claimInstanceOwner('i-reentrant', { instancesRoot, owner: mine })
    const again = await owner.claimInstanceOwner('i-reentrant', { instancesRoot, owner: owner.selfOwner('runtime-a') })
    eq(again.owner.since, first.owner.since, '同一 runtime 重复 claim 不制造时间漂移')
    eq(again.takeover, false)
    const other = await owner.claimInstanceOwner('i-reentrant', { instancesRoot, owner: owner.selfOwner('runtime-b') })
    eq(other.previous.runtimeId, 'runtime-a', '同进程另一个 runtime 的接管留下 previous')
    eq(other.owner.runtimeId, 'runtime-b')
  })

  await check('release：实例目录被删后既不复活目录、也不报错（锁在 .locks/）', async ({ home }) => {
    const { instancesRoot, dir } = seedInstanceDir(home, 'i-gone')
    await owner.claimInstanceOwner('i-gone', { instancesRoot, owner: owner.selfOwner('runtime-a') })
    rmSync(dir, { recursive: true, force: true })
    eq(await owner.releaseInstanceOwner('i-gone', { instancesRoot, runtimeId: 'runtime-a' }), false)
    eq(existsSync(dir), false, 'release 不能把已删除的实例目录建回来')
    eq(await owner.readInstanceOwner('i-gone', { instancesRoot }), null)
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
