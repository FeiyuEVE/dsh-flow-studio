#!/usr/bin/env node
/**
 * 准入控制自检（0.11 · R2/S1：全局并发可配置上限 + 排队）。
 *
 * 不启动 dsh、不 import engine / runtime / index；全部用注入的独立 controller
 * （只有「进程单例」那一组显式不注入），不写 run 目录、不创建 Engine / worktree。
 * 排队超时用短超时（几十毫秒）而不是长时间等待，整份文件 < 10s。
 *
 * 覆盖：默认 limits / env 合法与非法值（非法回默认且不回显原值）、全局 N+1 排队、
 * release 后启动、工作区隔离（工作区满立即 429）、严格 FIFO 队头阻塞、队满、
 * queueMax=0、排队超时、AbortSignal 取消、重复 runId 409、release 幂等、
 * 共享 controller 不同 limits 拒绝、不注入 controller 时的进程单例（含模块重载）。
 */

import assert from 'node:assert/strict'

const admissionModule = await import('../src/admission.js')
const { createAdmission, AdmissionError } = admissionModule

let checks = 0
let assertionCount = 0
const A = {
  equal(actual, expected, message) {
    assertionCount += 1
    assert.equal(actual, expected, message)
  },
  deepEqual(actual, expected, message) {
    assertionCount += 1
    assert.deepEqual(actual, expected, message)
  },
  ok(value, message) {
    assertionCount += 1
    assert.ok(value, message)
  },
  match(value, pattern, message) {
    assertionCount += 1
    assert.match(value, pattern, message)
  },
  notMatch(value, pattern, message) {
    assertionCount += 1
    assert.doesNotMatch(value, pattern, message)
  },
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

/** 新 controller：测试之间完全隔离。 */
function fresh(options = {}) {
  return createAdmission({ controller: {}, ...options })
}

/** 等一轮事件循环（排队授予是 microtask，跨 tick 的可观测性用宏任务更稳）。 */
function tick() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

async function waitFor(predicate, message = '等待条件超时（500ms）', timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await tick()
  }
}

/** 断言 Promise 被 reject，并返回错误对象。 */
async function rejectionOf(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('期望 Promise reject，但它 resolve 了')
}

const ENV_KEYS = [
  'FLOW_STUDIO_MAX_CONCURRENT_RUNS',
  'FLOW_STUDIO_MAX_CONCURRENT_RUNS_PER_WORKSPACE',
  'FLOW_STUDIO_RUN_QUEUE_MAX',
  'FLOW_STUDIO_RUN_QUEUE_TIMEOUT_MS',
]

function snapshotEnv() {
  const saved = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  return saved
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

try {
  // -------------------------------------------------------------------------
  console.log('admission · limits / env 解析')

  await check('默认 limits：global=4 / perWorkspace=2 / queueMax=8 / queueTimeoutMs=15000，无 warnings', async () => {
    const saved = snapshotEnv()
    try {
      for (const key of ENV_KEYS) delete process.env[key]
      const admission = createAdmission({ controller: {} })
      A.deepEqual(admission.limits, { global: 4, perWorkspace: 2, warnings: [] })
      A.equal(admission.queueMax, 8)
      A.equal(admission.queueTimeoutMs, 15_000)
    } finally {
      restoreEnv(saved)
    }
  })

  await check('env 合法值生效：perWorkspace 超过 global 时取 min(value, global)', async () => {
    const saved = snapshotEnv()
    try {
      process.env.FLOW_STUDIO_MAX_CONCURRENT_RUNS = '2'
      process.env.FLOW_STUDIO_MAX_CONCURRENT_RUNS_PER_WORKSPACE = '9'
      process.env.FLOW_STUDIO_RUN_QUEUE_MAX = '0'
      process.env.FLOW_STUDIO_RUN_QUEUE_TIMEOUT_MS = '600000'
      const admission = createAdmission({ controller: {} })
      A.equal(admission.limits.global, 2)
      A.equal(admission.limits.perWorkspace, 2, 'perWorkspace 被限制成不大于 global')
      A.deepEqual(admission.limits.warnings, [])
      A.equal(admission.queueMax, 0)
      A.equal(admission.queueTimeoutMs, 600_000)
    } finally {
      restoreEnv(saved)
    }
  })

  await check('env 非法值：全部回默认，写 limits.warnings 且不回显原值', async () => {
    const saved = snapshotEnv()
    try {
      process.env.FLOW_STUDIO_MAX_CONCURRENT_RUNS = 'abc'
      process.env.FLOW_STUDIO_MAX_CONCURRENT_RUNS_PER_WORKSPACE = '12.5'
      process.env.FLOW_STUDIO_RUN_QUEUE_MAX = '-1'
      process.env.FLOW_STUDIO_RUN_QUEUE_TIMEOUT_MS = '999999'
      const admission = createAdmission({ controller: {} })
      A.equal(admission.limits.global, 4)
      A.equal(admission.limits.perWorkspace, 2)
      A.equal(admission.queueMax, 8)
      A.equal(admission.queueTimeoutMs, 15_000)
      A.equal(admission.limits.warnings.length, 4, '四个非法值各留一条 warning')
      const text = admission.limits.warnings.join('\n')
      for (const key of ENV_KEYS) A.ok(text.includes(key), `warning 指向 ${key}`)
      // 不回显原值（避免把误粘贴的敏感串带进日志 / 接口）。
      for (const raw of ['abc', '12.5', '-1', '999999']) A.notMatch(text, new RegExp(raw.replace('.', '\\.')))
    } finally {
      restoreEnv(saved)
    }
  })

  // -------------------------------------------------------------------------
  console.log('admission · 全局上限 / 排队 / 释放')

  await check('全局 N 个直接授予；全局满后第 N+1 个排队（不占槽位、不计 active）', async () => {
    const admission = fresh({ limits: { global: 2, perWorkspace: 2 }, queueMax: 4, queueTimeoutMs: 1000 })
    const releaseA = await admission.acquire({ runId: 'r-adm-a', workspaceKey: 'ws-a' })
    const releaseB = await admission.acquire({ runId: 'r-adm-b', workspaceKey: 'ws-b' })
    A.equal(admission.admissionOf('r-adm-a').state, 'reserved')
    A.equal(admission.admissionOf('r-adm-b').state, 'reserved')
    A.deepEqual(admission.snapshot(), {
      active: 2,
      global: 2,
      workspaces: { 'ws-a': 1, 'ws-b': 1 },
      queued: [],
    })

    let resolved = false
    const pendingC = admission.acquire({ runId: 'r-adm-c', workspaceKey: 'ws-c' }).then(release => {
      resolved = true
      return release
    })
    await tick()
    A.equal(resolved, false, '全局满时第 N+1 个必须排队而不是直接授予')
    const queued = admission.admissionOf('r-adm-c')
    A.equal(queued.state, 'queued')
    A.equal(queued.position, 1)
    A.equal(queued.timeoutMs, 1000)
    A.match(queued.queuedAt, /^\d{4}-\d{2}-\d{2}T/)
    A.equal(admission.snapshot().active, 2, '排队不占槽位')
    A.equal(admission.snapshot().queued.length, 1)

    // 释放一个 → 队头拿槽位。
    releaseA()
    const releaseC = await pendingC
    A.equal(admission.admissionOf('r-adm-c').state, 'reserved')
    A.equal(admission.snapshot().active, 2)
    A.deepEqual(admission.snapshot().workspaces, { 'ws-b': 1, 'ws-c': 1 })

    releaseB()
    releaseC()
    A.equal(admission.snapshot().active, 0)
  })

  await check('release 幂等：释放两次只回收一次，不会把工作区 / active 记成负数', async () => {
    const admission = fresh({ limits: { global: 1, perWorkspace: 1 }, queueMax: 2 })
    const release = await admission.acquire({ runId: 'r-idem', workspaceKey: 'ws' })
    A.equal(admission.snapshot().active, 1)
    release()
    release()
    admission.release('r-idem')
    A.equal(admission.snapshot().active, 0)
    A.deepEqual(admission.snapshot().workspaces, {})
    // 再拿一次同一个工作区仍然成功（说明没有被多扣成负数）。
    const again = await admission.acquire({ runId: 'r-idem-2', workspaceKey: 'ws' })
    A.equal(admission.snapshot().active, 1)
    A.equal(admission.snapshot().workspaces.ws, 1)
    A.equal(admission.cancel('not-there'), false)
    again()
  })

  // -------------------------------------------------------------------------
  console.log('admission · 工作区隔离 / 严格 FIFO')

  await check('工作区满立即 429 workspace-full（不排队）；其它工作区照常授予', async () => {
    const admission = fresh({ limits: { global: 3, perWorkspace: 2 }, queueMax: 4 })
    const releaseA1 = await admission.acquire({ runId: 'r-ws-a1', workspaceKey: 'ws-a' })
    const releaseA2 = await admission.acquire({ runId: 'r-ws-a2', workspaceKey: 'ws-a' })
    const error = await rejectionOf(admission.acquire({ runId: 'r-ws-a3', workspaceKey: 'ws-a' }))
    A.ok(error instanceof AdmissionError)
    A.equal(error.status, 429)
    A.equal(error.code, 'RUN_CONCURRENCY_LIMIT')
    A.equal(error.scope, 'workspace')
    A.equal(error.reason, 'workspace-full')
    A.equal(error.active, 2)
    A.equal(error.max, 2)
    A.deepEqual(error.limits, { global: 3, perWorkspace: 2 })
    A.equal(error.retryAfterMs, 30_000)
    A.match(error.message, /工作区/)
    A.equal(admission.snapshot().queued.length, 0, '工作区满不排队')

    // 另一个工作区不受影响。
    const releaseB = await admission.acquire({ runId: 'r-ws-b', workspaceKey: 'ws-b' })
    A.equal(admission.admissionOf('r-ws-b').state, 'reserved')
    A.deepEqual(admission.snapshot().workspaces, { 'ws-a': 2, 'ws-b': 1 })
    releaseA1()
    releaseA2()
    releaseB()
  })

  await check('严格 FIFO：队头被工作区上限挡住时，后面可跑的条目不得越过队头', async () => {
    const admission = fresh({ limits: { global: 3, perWorkspace: 2 }, queueMax: 8, queueTimeoutMs: 1000 })
    const releaseA1 = await admission.acquire({ runId: 'r-fifo-a1', workspaceKey: 'wa' })
    const releaseA2 = await admission.acquire({ runId: 'r-fifo-a2', workspaceKey: 'wb' })
    const releaseA3 = await admission.acquire({ runId: 'r-fifo-a3', workspaceKey: 'wd' })
    // 全局 3 已满，以下三条按 b → c → d 的顺序排队。
    const pendingB = admission.acquire({ runId: 'r-fifo-b', workspaceKey: 'wa' })
    const pendingC = admission.acquire({ runId: 'r-fifo-c', workspaceKey: 'wa' })
    const pendingD = admission.acquire({ runId: 'r-fifo-d', workspaceKey: 'wb' })
    await tick()
    A.equal(admission.admissionOf('r-fifo-b').position, 1)
    A.equal(admission.admissionOf('r-fifo-c').position, 2)
    A.equal(admission.admissionOf('r-fifo-d').position, 3)

    // 释放 wd 的 a3：队头 b（wa）此时只有 a1 占着，可跑 → 授予 b。
    releaseA3()
    const releaseB = await pendingB
    A.equal(admission.admissionOf('r-fifo-b').state, 'reserved')
    A.equal(admission.admissionOf('r-fifo-c').position, 1)
    A.equal(admission.admissionOf('r-fifo-d').position, 2)

    // 再释放 wb 的 a2：wa 已被 a1+b 占满 → 队头 c 等待；d 的 wb 有空位且全局也有空位，
    // 但**严格 FIFO 不允许越过 c**，d 必须继续排队。
    releaseA2()
    await tick()
    A.equal(admission.snapshot().active, 2)
    A.equal(admission.admissionOf('r-fifo-c').state, 'queued', '队头仍被工作区上限挡住')
    A.equal(admission.admissionOf('r-fifo-d').state, 'queued', '后面的条目不得越过队头')
    A.deepEqual(admission.snapshot().queued.map(item => item.runId), ['r-fifo-c', 'r-fifo-d'])

    // 释放 wa 的 a1 → c 可跑；c 拿到槽位后 d 才能继续。
    releaseA1()
    const releaseC = await pendingC
    const releaseD = await pendingD
    A.equal(admission.admissionOf('r-fifo-c').state, 'reserved')
    A.equal(admission.admissionOf('r-fifo-d').state, 'reserved')
    releaseB()
    releaseC()
    releaseD()
    A.equal(admission.snapshot().active, 0)
  })

  // -------------------------------------------------------------------------
  console.log('admission · 队满 / 超时 / 取消')

  await check('队列满 429 queue-full；queueMax=0 时禁止排队', async () => {
    const limited = fresh({ limits: { global: 1, perWorkspace: 1 }, queueMax: 1, queueTimeoutMs: 1000 })
    const releaseA = await limited.acquire({ runId: 'r-qf-a', workspaceKey: 'ws-a' })
    const pendingB = limited.acquire({ runId: 'r-qf-b', workspaceKey: 'ws-b' })
    const error = await rejectionOf(limited.acquire({ runId: 'r-qf-c', workspaceKey: 'ws-c' }))
    A.equal(error.status, 429)
    A.equal(error.code, 'RUN_CONCURRENCY_LIMIT')
    A.equal(error.scope, 'global')
    A.equal(error.reason, 'queue-full')
    A.equal(error.active, 1)
    A.equal(error.max, 1)
    A.deepEqual(error.limits, { global: 1, perWorkspace: 1 })
    A.equal(error.retryAfterMs, 30_000)
    A.match(error.message, /排队已满/)
    A.equal(limited.snapshot().queued.length, 1, '只保留已在队里的那一个')
    releaseA()
    const releaseB = await pendingB
    releaseB()

    const noQueue = fresh({ limits: { global: 1, perWorkspace: 1 }, queueMax: 0 })
    const releaseC = await noQueue.acquire({ runId: 'r-nq-a', workspaceKey: 'ws-a' })
    const noQueueError = await rejectionOf(noQueue.acquire({ runId: 'r-nq-b', workspaceKey: 'ws-b' }))
    A.equal(noQueueError.reason, 'queue-full')
    A.equal(noQueueError.status, 429)
    A.equal(noQueue.snapshot().queued.length, 0, 'queueMax=0 不产生排队条目')
    A.match(noQueueError.message, /禁止排队/)
    releaseC()
  })

  await check('排队超时 → 429 queue-timeout，并原子摘票（不占槽位、不留队列尾巴）', async () => {
    const admission = fresh({ limits: { global: 1, perWorkspace: 1 }, queueMax: 2, queueTimeoutMs: 40 })
    const releaseA = await admission.acquire({ runId: 'r-to-a', workspaceKey: 'ws-a' })
    const started = Date.now()
    const error = await rejectionOf(admission.acquire({ runId: 'r-to-b', workspaceKey: 'ws-b' }))
    const elapsed = Date.now() - started
    A.equal(error.status, 429)
    A.equal(error.code, 'RUN_CONCURRENCY_LIMIT')
    A.equal(error.scope, 'global')
    A.equal(error.reason, 'queue-timeout')
    A.equal(error.active, 1)
    A.equal(error.max, 1)
    A.match(error.message, /排队等待超过/)
    A.ok(elapsed >= 30 && elapsed < 3000, `在 queueTimeoutMs 附近超时（实际 ${elapsed}ms）`)
    A.equal(admission.admissionOf('r-to-b'), null, '超时后条目已摘除')
    A.equal(admission.snapshot().queued.length, 0)
    A.equal(admission.snapshot().active, 1, '超时不占槽位')
    // 释放后同工作区可以立刻再拿（超时没有留下幽灵条目）。
    releaseA()
    const releaseC = await admission.acquire({ runId: 'r-to-c', workspaceKey: 'ws-a' })
    A.equal(admission.snapshot().active, 1)
    releaseC()
  })

  await check('AbortSignal 取消排队 → 429 cancelled，并原子摘票；已 abort 的 signal 直接拒绝', async () => {
    const admission = fresh({ limits: { global: 1, perWorkspace: 1 }, queueMax: 2, queueTimeoutMs: 5000 })
    const releaseA = await admission.acquire({ runId: 'r-abort-a', workspaceKey: 'ws-a' })
    const controller = new AbortController()
    const pending = admission.acquire({ runId: 'r-abort-b', workspaceKey: 'ws-b', signal: controller.signal })
    await tick()
    A.equal(admission.admissionOf('r-abort-b').state, 'queued')
    controller.abort()
    const error = await rejectionOf(pending)
    A.equal(error.status, 429)
    A.equal(error.code, 'RUN_CONCURRENCY_LIMIT')
    A.equal(error.reason, 'cancelled')
    A.equal(error.cancelReason, 'signal')
    A.match(error.message, /取消/)
    A.equal(admission.admissionOf('r-abort-b'), null)
    A.equal(admission.snapshot().queued.length, 0)
    releaseA()

    const pre = new AbortController()
    pre.abort()
    const preError = await rejectionOf(admission.acquire({ runId: 'r-abort-c', workspaceKey: 'ws-c', signal: pre.signal }))
    A.equal(preError.reason, 'cancelled')
    A.equal(admission.snapshot().active, 0)
    A.equal(admission.snapshot().queued.length, 0)
  })

  // -------------------------------------------------------------------------
  console.log('admission · 重复 runId / 状态机')

  await check('同一 runId 在 queued / reserved / running 都 409 RUN_ALREADY_ACTIVE', async () => {
    const admission = fresh({ limits: { global: 1, perWorkspace: 1 }, queueMax: 2, queueTimeoutMs: 1000 })
    const releaseA = await admission.acquire({ runId: 'r-dup-a', workspaceKey: 'ws-a' })
    A.equal(admission.admissionOf('r-dup-a').state, 'reserved')

    const reservedDup = await rejectionOf(admission.acquire({ runId: 'r-dup-a', workspaceKey: 'ws-a' }))
    A.ok(reservedDup instanceof AdmissionError)
    A.equal(reservedDup.status, 409)
    A.equal(reservedDup.code, 'RUN_ALREADY_ACTIVE')
    A.match(reservedDup.message, /已在运行/)

    const pendingB = admission.acquire({ runId: 'r-dup-b', workspaceKey: 'ws-b' })
    await tick()
    A.equal(admission.admissionOf('r-dup-b').state, 'queued')
    const queuedDup = await rejectionOf(admission.acquire({ runId: 'r-dup-b', workspaceKey: 'ws-b' }))
    A.equal(queuedDup.status, 409)
    A.equal(queuedDup.code, 'RUN_ALREADY_ACTIVE')
    A.equal(queuedDup.state, 'queued')

    A.equal(admission.markRunning('r-dup-a'), true)
    A.equal(admission.admissionOf('r-dup-a').state, 'running')
    A.equal(admission.markRunning('r-dup-b'), false, 'queued 不能直接标记 running')
    const runningDup = await rejectionOf(admission.acquire({ runId: 'r-dup-a', workspaceKey: 'ws-a' }))
    A.equal(runningDup.status, 409)
    A.equal(runningDup.code, 'RUN_ALREADY_ACTIVE')
    A.equal(runningDup.state, 'running')

    A.equal(admission.cancel('r-dup-b', 'stop'), true)
    const cancelled = await rejectionOf(pendingB)
    A.equal(cancelled.reason, 'cancelled')
    A.equal(cancelled.cancelReason, 'stop')
    releaseA()
    A.equal(admission.admissionOf('r-dup-a'), null)
  })

  // -------------------------------------------------------------------------
  console.log('admission · 共享 controller / 进程单例')

  await check('共享 controller：相同 limits 复用同一账本；不同 limits 抛可读错误', async () => {
    const controller = {}
    const first = createAdmission({ controller, limits: { global: 2, perWorkspace: 1 }, queueMax: 2 })
    const second = createAdmission({ controller, limits: { global: 2, perWorkspace: 1 }, queueMax: 2 })
    A.equal(first.controller, controller)
    A.equal(second.controller, controller)
    const release = await first.acquire({ runId: 'r-shared-a', workspaceKey: 'ws-a' })
    A.equal(second.admissionOf('r-shared-a').state, 'reserved', '两个 facade 看到同一份账本')
    A.equal(second.snapshot().active, 1)
    second.release('r-shared-a')
    A.equal(first.snapshot().active, 0)
    release()

    const error = await (async () => {
      try {
        createAdmission({ controller, limits: { global: 2, perWorkspace: 2 }, queueMax: 2 })
      } catch (caught) {
        return caught
      }
      return null
    })()
    A.ok(error instanceof Error)
    A.match(error.message, /限制不同/)

    const queueError = await (async () => {
      try {
        createAdmission({ controller, limits: { global: 2, perWorkspace: 1 }, queueMax: 3 })
      } catch (caught) {
        return caught
      }
      return null
    })()
    A.ok(queueError instanceof Error)
    A.match(queueError.message, /限制不同/)
  })

  await check('不注入 controller：进程共享单例（模块重载仍是同一账本；不同 limits 拒绝）', async () => {
    // 本组必须最后跑：它会创建进程级单例，并固定住默认 limits。
    const admission = createAdmission()
    const second = createAdmission()
    A.ok(admission.controller === second.controller, '同一进程内复用同一个 controller')

    const release = await admission.acquire({ runId: 'r-singleton-a', workspaceKey: 'ws-a' })
    A.equal(second.admissionOf('r-singleton-a').state, 'reserved')
    A.equal(second.snapshot().active, 1)

    // 用 query string 强制造出第二个模块实例，模拟热重载 / 重复 import。
    const reloaded = await import(`../src/admission.js?reload=${Date.now()}`)
    const third = reloaded.createAdmission()
    A.equal(third.snapshot().active, 1, '模块重载后仍读同一份全局账本')
    A.equal(third.admissionOf('r-singleton-a').state, 'reserved')
    const releaseThird = await third.acquire({ runId: 'r-singleton-b', workspaceKey: 'ws-b' })
    A.equal(admission.admissionOf('r-singleton-b').state, 'reserved', '旧 facade 也看得到新 facade 的占用')

    let error = null
    try {
      createAdmission({ limits: { global: 9, perWorkspace: 9 } })
    } catch (caught) {
      error = caught
    }
    A.ok(error instanceof Error)
    A.match(error.message, /限制不同/)

    second.release('r-singleton-a')
    third.release('r-singleton-b')
    release()
    releaseThird()
    A.equal(admission.snapshot().active, 0)
  })
} catch (error) {
  console.error('\n✗ admission 自检失败：')
  console.error(error)
  process.exitCode = 1
}

console.log(`\nadmission 自检：${checks} 组通过（${assertionCount} 条断言）`)
