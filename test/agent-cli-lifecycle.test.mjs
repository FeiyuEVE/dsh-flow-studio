#!/usr/bin/env node
/**
 * 共享 CLI 进程组生命周期 helper 自检（0.14.4 / U1）。
 *
 * 覆盖 review-0142b 的两个共享缺陷接缝：
 *  - M5：`graceMs=0` 只发 TERM 就返回，没有 SIGKILL 升级；
 *  - m1：组长先退就撤销升级计时器，忽略 TERM 的后代仍存活。
 *
 * 全部用例使用**真实子进程**：真的 spawn（detached:true）、真的忽略 TERM、
 * 真的 SIGKILL，并用 `process.kill(pid, 0)` 抛 ESRCH 证明进程消失。
 * 不以「函数被调用几次」自证；有界等待一律轮询，不裸 sleep 固定时长。
 *
 * 运行：node --test test/agent-cli-lifecycle.test.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import {
  createProcessGroupSupervisor,
  createResourceRegistry,
} from '../src/agent-cli-lifecycle.js'

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

/** 真的活着：ESRCH 才算消失；EPERM 视为仍存在（不能谎报）。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM'
  }
}

function spawnDetached(script) {
  return spawn('sh', ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 兜底清理：组长 + 同组后代一起 SIGKILL（用例失败时不留孤儿进程）。 */
function killGroup(pid) {
  if (!pid) return
  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch {
    // 组已经不存在，退回单进程
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已经退出
  }
}

test('M5：graceMs=0 仍执行 TERM→KILL，忽略 TERM 的真实子进程被 SIGKILL 收掉', async () => {
  const supervisor = createProcessGroupSupervisor({ graceMs: 0, killTimeoutMs: 120, pollMs: 10 })
  const child = spawnDetached('trap "" TERM; echo ready; sleep 30')
  let stdout = ''
  child.stdout.on('data', chunk => {
    stdout += String(chunk)
  })
  try {
    const handle = supervisor.track(child, { label: 'zero-grace' })
    assert.equal(handle.kind, 'group', 'detached:true 的子进程必须按进程组管理')
    await waitFor(() => stdout.includes('ready'))

    const startedAt = Date.now()
    const termination = supervisor.terminateGroup(handle, 'finish')
    const gone = await supervisor.waitGone(handle, 3000)
    const result = await termination
    const elapsed = Date.now() - startedAt

    assert.equal(gone.gone, true, 'waitGone 必须确认整组消失')
    assert.equal(result.gone, true)
    // 子进程忽略 TERM：只有真的发了 SIGKILL 才会以 SIGKILL 结束。
    await waitFor(() => child.signalCode !== null || child.exitCode !== null)
    assert.equal(child.signalCode, 'SIGKILL', '零宽限也必须升级到 SIGKILL')

    await waitFor(() => !isAlive(child.pid))
    assert.equal(isAlive(child.pid), false, 'process.kill(pid, 0) 必须抛 ESRCH')
    assert.ok(elapsed < 3000, `升级链必须有界，实际 ${elapsed}ms`)

    const snapshot = supervisor.snapshot()
    assert.equal(snapshot.groups.length, 0, '整组消失后登记必须清空')
    assert.equal(snapshot.timers, 0, '进程消失后不得留下计时器')
  } finally {
    killGroup(child.pid)
  }
})

test('m1：组长先退、后代忽略 TERM，仍升级 KILL 并确认整组消失', async () => {
  const supervisor = createProcessGroupSupervisor({ graceMs: 0, killTimeoutMs: 150, pollMs: 10 })
  // 组内后台子 shell 先装好 TERM 忽略再 sleep；组长打印它的 pid 后立刻退出。
  const child = spawnDetached('(trap "" TERM; echo descendant-ready >&2; sleep 30) & echo descendant=$! >&2; exit 0')
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })
  let descendantPid = null
  try {
    const handle = supervisor.track(child, { label: 'leader-exit' })
    assert.equal(handle.kind, 'group')

    descendantPid = await waitFor(() => {
      const match = /descendant=(\d+)/.exec(stderr)
      return match ? Number(match[1]) : null
    })
    await waitFor(() => stderr.includes('descendant-ready'), 3000, 10)

    // 组长已经没了，但同组后代忽略 TERM 还活着 —— 这正是 m1 的漏杀场景。
    await waitFor(() => child.exitCode !== null || child.signalCode !== null)
    assert.equal(child.exitCode, 0)
    assert.equal(isAlive(descendantPid), true, '组长退出后后代应仍然存活')

    const termination = supervisor.terminateGroup(handle, 'cancel')
    const gone = await supervisor.waitGone(handle, 3000)
    await termination

    assert.equal(gone.gone, true, '只有整组消失才算清理完成')
    await waitFor(() => !isAlive(descendantPid), 2000)
    assert.equal(isAlive(descendantPid), false, '忽略 TERM 的后代必须被 SIGKILL 收掉')
    assert.equal(supervisor.snapshot().groups.length, 0)
  } finally {
    killGroup(child.pid)
    if (descendantPid) killGroup(descendantPid)
  }
})

test('killImpl 注入不生效：waitGone 有界返回 gone:false，snapshot 保留 pending 不谎报', async () => {
  const supervisor = createProcessGroupSupervisor({
    graceMs: 0,
    killTimeoutMs: 100,
    pollMs: 10,
    killImpl: () => {},
  })
  const child = spawnDetached('trap "" TERM; echo ready; sleep 30')
  let stdout = ''
  child.stdout.on('data', chunk => {
    stdout += String(chunk)
  })
  try {
    const handle = supervisor.track(child, { label: 'stuck' })
    await waitFor(() => stdout.includes('ready'))

    const result = await supervisor.terminateGroup(handle, 'noop-kill')
    assert.equal(result.gone, false, '注入的 killImpl 不生效时不得谎报已清理')

    const gone = await supervisor.waitGone(handle, 250)
    assert.deepEqual(gone, { gone: false })
    assert.equal(isAlive(child.pid), true, '进程真的还在')

    const snapshot = supervisor.snapshot()
    assert.equal(snapshot.pending, 1)
    assert.equal(snapshot.groups.length, 1)
    assert.equal(snapshot.groups[0].pending, true, 'snapshot 里该组必须仍是 pending')

    // 用真实 SIGKILL 清理，并证明 waitGone 随后如实转为 gone:true。
    process.kill(-child.pid, 'SIGKILL')
    const after = await supervisor.waitGone(handle, 2000)
    assert.equal(after.gone, true)
    assert.equal(supervisor.snapshot().groups.length, 0)
  } finally {
    killGroup(child.pid)
  }
})

test('terminateGroup 幂等：并发重复调用返回同一结论且只升级一次信号', async () => {
  const sent = []
  const supervisor = createProcessGroupSupervisor({
    graceMs: 0,
    killTimeoutMs: 100,
    pollMs: 10,
    killImpl: (signal, target) => {
      sent.push(signal)
      // 注入实现仍然真的杀进程组，保证用例验证的是真实消失。
      process.kill(target.group, signal)
    },
  })
  const child = spawnDetached('trap "" TERM; echo ready; sleep 30')
  let stdout = ''
  child.stdout.on('data', chunk => {
    stdout += String(chunk)
  })
  try {
    const handle = supervisor.track(child, { label: 'idempotent' })
    await waitFor(() => stdout.includes('ready'))

    const first = supervisor.terminateGroup(handle, 'cancel-1')
    const second = supervisor.terminateGroup(handle, 'cancel-2')
    const [resultA, resultB] = await Promise.all([first, second])

    assert.equal(resultA.gone, true)
    assert.equal(resultB.gone, true)
    assert.equal(sent.filter(signal => signal === 'SIGTERM').length, 1, '重复 cancel 不得重复发 TERM')
    assert.equal(sent.filter(signal => signal === 'SIGKILL').length, 1, '重复 cancel 不得重复发 KILL')

    await waitFor(() => !isAlive(child.pid))
    assert.equal(isAlive(child.pid), false)
  } finally {
    killGroup(child.pid)
  }
})

test('disposeAll 立即强制清理进行中的宽限等待，并清掉所有计时器', async () => {
  const supervisor = createProcessGroupSupervisor({ graceMs: 5000, killTimeoutMs: 150, pollMs: 10 })
  const child = spawnDetached('trap "" TERM; echo ready; sleep 30')
  let stdout = ''
  child.stdout.on('data', chunk => {
    stdout += String(chunk)
  })
  try {
    const handle = supervisor.track(child, { label: 'dispose-while-grace' })
    await waitFor(() => stdout.includes('ready'))

    const startedAt = Date.now()
    const inFlight = supervisor.terminateGroup(handle, 'finish')
    await new Promise(resolve => setTimeout(resolve, 30))

    const disposed = await supervisor.disposeAll()
    const elapsed = Date.now() - startedAt
    assert.equal(disposed.pending.length, 0, 'disposeAll 应把进程组收干净')
    assert.ok(elapsed < 2000, `disposeAll 不得等满 graceMs=5000，实际 ${elapsed}ms`)
    assert.equal(supervisor.snapshot().timers, 0, 'disposeAll 后不得留下计时器')

    const result = await inFlight
    assert.equal(result.gone, true, '进行中的 terminateGroup 应如实报告整组已消失')
    await waitFor(() => !isAlive(child.pid))
    assert.equal(isAlive(child.pid), false)
  } finally {
    killGroup(child.pid)
  }
})

test('track 非 detached 子进程时退回单进程清理，绝不误杀父进程组', async () => {
  const supervisor = createProcessGroupSupervisor({ graceMs: 0, killTimeoutMs: 100, pollMs: 10 })
  // stdio 仍 detach 启动：用 detached:false 明确验证分组判定。
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const handle = supervisor.track(child, { label: 'plain-child' })
    assert.equal(handle.kind, 'process')
    assert.equal(handle.pgid, null, '不能把父进程组当成可杀目标')
    const termination = supervisor.terminateGroup(handle, 'plain')
    const gone = await supervisor.waitGone(handle, 3000)
    await termination
    assert.equal(gone.gone, true)
    await waitFor(() => !isAlive(child.pid))
    assert.equal(isAlive(child.pid), false)
  } finally {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已经退出
    }
  }
})

test('resourceRegistry：失败项保留 pending，其余仍清理，成功项不重复执行', async () => {
  const registry = createResourceRegistry()
  const calls = []
  registry.add('channel', () => {
    calls.push('channel')
  })
  registry.add('flaky', () => {
    calls.push('flaky')
    throw new Error('boom: /home/secret/path token=abc123')
  })
  registry.add('dir', async () => {
    calls.push('dir')
  })

  const first = await registry.disposeAll()
  assert.deepEqual(calls, ['channel', 'flaky', 'dir'], '一项失败不得中断其余清理')
  assert.equal(first.pending.length, 1)
  assert.equal(first.pending[0].kind, 'flaky')
  assert.match(first.pending[0].error, /boom/)
  assert.ok(!first.pending[0].error.includes('abc123'), '错误摘要必须脱敏（凭据值不能透出）')
  assert.ok(first.pending[0].error.length <= 256)

  const snapshot = registry.snapshot()
  assert.equal(snapshot.pending.length, 1)
  assert.equal(snapshot.disposed, 2)

  const second = await registry.disposeAll()
  assert.equal(calls.filter(kind => kind === 'channel').length, 1, '已成功的项不得重复执行')
  assert.equal(calls.filter(kind => kind === 'dir').length, 1, '已成功的项不得重复执行')
  assert.equal(calls.filter(kind => kind === 'flaky').length, 2, 'pending 项应允许重试')
  assert.equal(second.pending.length, 1, '仍失败则继续保留在 pending')
})

test('resourceRegistry：重试成功的项从 pending 移除', async () => {
  const registry = createResourceRegistry()
  let attempts = 0
  registry.add('recoverable', () => {
    attempts += 1
    if (attempts === 1) throw new Error('first attempt failed')
  })

  const first = await registry.disposeAll()
  assert.equal(first.pending.length, 1)
  const second = await registry.disposeAll()
  assert.equal(second.pending.length, 0)
  assert.equal(registry.snapshot().pending.length, 0)
  assert.equal(attempts, 2)
})
