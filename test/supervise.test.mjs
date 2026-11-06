#!/usr/bin/env node
/**
 * 内建 supervision 调度自检（07-runtime-0.7 §7 / §8 / §11）。
 *
 * 全部走注入桩：假时钟、假审计、假唤醒、假读写、假定时器 —— 不启动 dsh、
 * 不 import 任何 dsh 包、不碰 fs、不起真定时器。
 *
 * 覆盖：planWake 的终态 / pending / healthy / 异常 / 未知 verdict / 坏日期 /
 * lastWokeAt 缺失；Scheduler 的 start/stop 幂等、到点只唤醒一次、未到点不唤醒、
 * 连续失败 3 次降级、单 run 抛错隔离、tick 重入保护、终态自动摘除、重启恢复、
 * status 字段；v0.8 节点闹钟的 parseNodeStatus 解析口径与 NodeSupervisionScheduler
 * 的登记 / 注销 / 到点 / skip / 失败停摆 / 重入 / 快照。
 */

import assert from 'node:assert/strict'

import {
  planWake,
  SupervisionScheduler,
  SUPERVISION_INTERVALS,
  NODE_ALARM_DEFAULT_MS,
  NodeSupervisionScheduler,
  parseNodeStatus,
} from '../src/supervise.js'

let checks = 0
/** 统计断言数（用户要求回报断言数）。 */
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
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

/** 所有时间都相对同一个基准点，结果与真实墙钟无关。 */
const BASE = Date.parse('2026-11-06T12:00:00.000Z')
const at = (seconds = 0) => new Date(BASE + seconds * 1000).toISOString()

const RUN_ID = 'r-supervise'

// ---------------------------------------------------------------------------
// 注入桩
// ---------------------------------------------------------------------------

function createClock(startMs = BASE) {
  const clock = {
    ms: startMs,
    now: () => clock.ms,
    advance(seconds) {
      clock.ms += seconds * 1000
    },
    iso(offsetSeconds = 0) {
      return new Date(clock.ms + offsetSeconds * 1000).toISOString()
    },
  }
  return clock
}

function createStore(initial = {}) {
  const states = new Map(Object.entries(initial).map(([runId, state]) => [runId, structuredClone(state)]))
  const saves = []
  const counts = { loads: 0, saves: 0 }
  return {
    states,
    saves,
    counts,
    async load(runId) {
      counts.loads += 1
      return states.has(runId) ? structuredClone(states.get(runId)) : null
    },
    async save(runId, state) {
      counts.saves += 1
      const copy = structuredClone(state)
      saves.push({ runId, state: copy })
      states.set(runId, copy)
    },
    get(runId) {
      return states.get(runId) ?? null
    },
  }
}

function fakeTimers() {
  const state = { intervals: [], cleared: [], nextId: 1 }
  return {
    state,
    setInterval(fn, ms) {
      const id = state.nextId++
      state.intervals.push({ id, fn, ms })
      return id
    },
    clearInterval(id) {
      state.cleared.push(id)
    },
  }
}

/**
 * 组装调度器：evaluate / wake 都记录调用；store / clock / timers 可替换。
 */
function createScheduler({ clock, store = createStore(), evaluate, wake, intervalMs = 1000 } = {}) {
  const timers = fakeTimers()
  const calls = { wake: [], evaluate: [], logs: [] }
  const scheduler = new SupervisionScheduler({
    now: clock.now,
    evaluate: async runId => {
      calls.evaluate.push(runId)
      if (typeof evaluate !== 'function') throw new Error('测试未提供 evaluate')
      return evaluate(runId, calls)
    },
    wake: async (runId, ctx) => {
      calls.wake.push({ runId, ctx })
      if (typeof wake !== 'function') return true
      return wake(runId, ctx, calls.wake.length)
    },
    load: store.load,
    save: store.save,
    log: (level, message) => calls.logs.push({ level, message }),
    intervalMs,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  })
  return { scheduler, calls, store, timers }
}

/** 反复让出微任务，直到条件成立（测试不依赖真定时器）。 */
async function waitFor(predicate, label) {
  for (let i = 0; i < 5000; i += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.fail(`等待超时：${label}`)
}

// ---------------------------------------------------------------------------
// 1. 常量
// ---------------------------------------------------------------------------

await check('SUPERVISION_INTERVALS：冻结且口径与 audit.nextCheckSeconds 一致', () => {
  A.deepEqual(SUPERVISION_INTERVALS, { healthy: 180, anomaly: 60, pending: 30 })
  A.ok(Object.isFrozen(SUPERVISION_INTERVALS))
})

// ---------------------------------------------------------------------------
// 2. planWake
// ---------------------------------------------------------------------------

await check('planWake：终态 verdict（done / failed / aborted）→ 不再唤醒', () => {
  for (const verdict of ['done', 'failed', 'aborted']) {
    const plan = planWake({
      run: { status: 'running', startedAt: at(-10) },
      now: BASE,
      verdict,
      lastWokeAt: at(-10),
    })
    A.equal(plan.shouldWake, false, `${verdict} 不该唤醒`)
    A.equal(plan.nextDueAt, null, `${verdict} 的 nextDueAt 应为 null`)
    A.equal(plan.reason, 'terminal', `${verdict} 的 reason 应为 terminal`)
  }
})

await check('planWake：verdict 正常但 run.status 已终态 → 同样收口', () => {
  const plan = planWake({
    run: { status: 'done', startedAt: at(-10) },
    now: BASE,
    verdict: 'healthy',
    lastWokeAt: at(-10),
  })
  A.equal(plan.shouldWake, false)
  A.equal(plan.nextDueAt, null)
  A.equal(plan.reason, 'terminal')
})

await check('planWake：pending → 30s，未到点 / 到点两种', () => {
  const waiting = planWake({ run: { status: 'pending', startedAt: at(-10) }, now: BASE, verdict: 'pending', lastWokeAt: at(-10) })
  A.equal(waiting.reason, 'pending')
  A.equal(waiting.nextDueAt, at(20))
  A.equal(waiting.shouldWake, false)

  const due = planWake({ run: { status: 'pending', startedAt: at(-40) }, now: BASE, verdict: 'pending', lastWokeAt: at(-40) })
  A.equal(due.nextDueAt, at(-10))
  A.equal(due.shouldWake, true)
})

await check('planWake：healthy → 180s，未到点 / 到点 / lastWokeAt 在未来', () => {
  const waiting = planWake({ run: { status: 'running', startedAt: at(-100) }, now: BASE, verdict: 'healthy', lastWokeAt: at(-100) })
  A.equal(waiting.reason, 'healthy')
  A.equal(waiting.nextDueAt, at(80))
  A.equal(waiting.shouldWake, false)

  const due = planWake({ run: { status: 'running', startedAt: at(-200) }, now: BASE, verdict: 'healthy', lastWokeAt: at(-200) })
  A.equal(due.nextDueAt, at(-20))
  A.equal(due.shouldWake, true)

  const future = planWake({ run: { status: 'running', startedAt: at(-200) }, now: BASE, verdict: 'healthy', lastWokeAt: at(100) })
  A.equal(future.nextDueAt, at(280))
  A.equal(future.shouldWake, false)
})

await check('planWake：已知异常（stalled / looping / deviating / no-progress）→ 60s + reason anomaly', () => {
  for (const verdict of ['stalled', 'looping', 'deviating', 'no-progress']) {
    const plan = planWake({
      run: { status: 'running', startedAt: at(-30) },
      now: BASE,
      verdict,
      lastWokeAt: at(-30),
    })
    A.equal(plan.reason, 'anomaly', `${verdict} 归入 anomaly`)
    A.equal(plan.nextDueAt, at(30), `${verdict} 间隔 60s`)
    A.equal(plan.shouldWake, false)
  }
  const due = planWake({ run: { status: 'running', startedAt: at(-61) }, now: BASE, verdict: 'looping', lastWokeAt: at(-61) })
  A.equal(due.nextDueAt, at(-1))
  A.equal(due.shouldWake, true)
})

await check('planWake：未知 verdict → 60s（异常侧保守）+ reason unknown-verdict', () => {
  const cases = ['mystery', '', 123, undefined]
  for (const verdict of cases) {
    const plan = planWake({
      run: { status: 'running', startedAt: at(0) },
      now: BASE,
      verdict,
      lastWokeAt: at(0),
    })
    A.equal(plan.reason, 'unknown-verdict', `verdict=${String(verdict)} 应为 unknown-verdict`)
    A.equal(plan.nextDueAt, at(60), `verdict=${String(verdict)} 间隔 60s`)
    A.equal(plan.shouldWake, false)
  }
})

await check('planWake：坏日期不抛错，一律按 now 处理', () => {
  // lastWokeAt 坏 → 按 now（不退回 startedAt）
  const badLast = planWake({
    run: { status: 'running', startedAt: at(-200) },
    now: BASE,
    verdict: 'healthy',
    lastWokeAt: 'not-a-date',
  })
  A.equal(badLast.reason, 'healthy')
  A.equal(badLast.nextDueAt, at(180))
  A.equal(badLast.shouldWake, false)

  // startedAt 坏 → 按 now
  const badStart = planWake({ run: { status: 'running', startedAt: 'garbage' }, now: BASE, verdict: 'healthy' })
  A.equal(badStart.nextDueAt, at(180))
  A.equal(badStart.shouldWake, false)

  // now 坏 → 不抛错，nextDueAt 仍是合法 ISO
  const badNow = planWake({ run: { status: 'running', startedAt: at(-10) }, now: 'garbage', verdict: 'stalled', lastWokeAt: at(-10) })
  A.equal(badNow.reason, 'anomaly')
  A.ok(Number.isFinite(Date.parse(badNow.nextDueAt)), '坏 now 也要产出合法 ISO')
})

await check('planWake：lastWokeAt 缺失时退 run.startedAt，两者都缺退 now', () => {
  const fromStart = planWake({ run: { status: 'running', startedAt: at(-100) }, now: BASE, verdict: 'healthy' })
  A.equal(fromStart.nextDueAt, at(80))
  A.equal(fromStart.shouldWake, false)

  const fromNow = planWake({ run: { status: 'running', startedAt: null }, now: BASE, verdict: 'healthy', lastWokeAt: null })
  A.equal(fromNow.nextDueAt, at(180))
  A.equal(fromNow.shouldWake, false)

  // 没有 run 摘要也不许抛；状态不明时保守不唤醒，但 nextDueAt 仍要算出来
  const noRun = planWake({ now: BASE, verdict: 'healthy', lastWokeAt: at(-200) })
  A.equal(noRun.reason, 'healthy')
  A.equal(noRun.nextDueAt, at(-20))
  A.equal(noRun.shouldWake, false)

  const unknownStatus = planWake({ run: { status: 'weird' }, now: BASE, verdict: 'healthy', lastWokeAt: at(-200) })
  A.equal(unknownStatus.nextDueAt, at(-20))
  A.equal(unknownStatus.shouldWake, false)
})

await check('planWake：nextDueAt 是 ISO 字符串；now 接受 Date', () => {
  const plan = planWake({ run: { status: 'running', startedAt: at(-100) }, now: new Date(BASE), verdict: 'healthy' })
  A.match(plan.nextDueAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  A.equal(plan.nextDueAt, at(80))
})

// ---------------------------------------------------------------------------
// 3. Scheduler · start / stop 幂等
// ---------------------------------------------------------------------------

await check('Scheduler：start 幂等（只起一个定时器），stop 幂等（只清一次）', async () => {
  const clock = createClock()
  const { scheduler, timers } = createScheduler({ clock, evaluate: async () => ({ verdict: 'healthy', run: { status: 'running' } }) })
  A.equal(timers.state.intervals.length, 0)
  A.equal(scheduler.start(), true)
  A.equal(timers.state.intervals.length, 1)
  A.equal(timers.state.intervals[0].ms, 1000)
  A.equal(scheduler.start(), false, '重复 start 不叠加')
  A.equal(timers.state.intervals.length, 1)
  A.equal(timers.state.cleared.length, 0)
  A.equal(scheduler.stop(), true)
  A.equal(timers.state.cleared.length, 1)
  A.equal(timers.state.cleared[0], timers.state.intervals[0].id)
  A.equal(scheduler.stop(), false, '重复 stop 不重复清')
  A.equal(timers.state.cleared.length, 1)
})

await check('Scheduler：intervalMs 缺省 15000', () => {
  const timers = fakeTimers()
  const scheduler = new SupervisionScheduler({
    now: () => BASE,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running' } }),
    wake: async () => true,
    load: async () => null,
    save: async () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  })
  A.equal(scheduler.start(), true)
  A.equal(timers.state.intervals[0].ms, 15000)
  scheduler.stop()
})

// ---------------------------------------------------------------------------
// 4. Scheduler · 到点唤醒一次且只一次 / 未到点不唤醒
// ---------------------------------------------------------------------------

await check('Scheduler：到点唤醒一次且只一次，唤醒后立刻推进 nextDueAt', async () => {
  const clock = createClock()
  const { scheduler, calls, store } = createScheduler({
    clock,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
  })
  scheduler.register(RUN_ID, { wakerSessionId: 'waker-1' })

  const first = await scheduler.tick()
  A.equal(first.woken, 1)
  A.equal(calls.wake.length, 1)
  A.equal(calls.wake[0].runId, RUN_ID)
  A.equal(calls.wake[0].ctx.wakerSessionId, 'waker-1')

  const saved = store.get(RUN_ID)
  A.equal(saved.enabled, true)
  A.equal(saved.wakes, 1)
  A.equal(saved.failures, 0)
  A.equal(saved.lastWokeAt, clock.iso())
  A.equal(saved.nextDueAt, clock.iso(180))

  // 同一时刻再 tick：同一个 nextDueAt 只唤醒一次
  await scheduler.tick()
  A.equal(calls.wake.length, 1)

  // 差 1 秒也不叫
  clock.advance(179)
  await scheduler.tick()
  A.equal(calls.wake.length, 1)

  // 到点叫第二次
  clock.advance(1)
  await scheduler.tick()
  A.equal(calls.wake.length, 2)
  A.equal(scheduler.status(RUN_ID).wakes, 2)
})

await check('Scheduler：未到点不唤醒，但会初始化并落盘 nextDueAt', async () => {
  const clock = createClock()
  const { scheduler, calls, store } = createScheduler({
    clock,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso() } }),
  })
  scheduler.register(RUN_ID)
  const stats = await scheduler.tick()
  A.equal(stats.woken, 0)
  A.equal(calls.wake.length, 0)

  const saved = store.get(RUN_ID)
  A.ok(saved, '无持久化状态时应初始化落盘')
  A.equal(saved.enabled, true)
  A.equal(saved.wakes, 0)
  A.equal(saved.failures, 0)
  A.equal(saved.nextDueAt, clock.iso(180))

  const status = scheduler.status(RUN_ID)
  A.equal(status.enabled, true)
  A.equal(status.nextDueAt, clock.iso(180))
  A.equal(status.lastReason, 'healthy')
})

await check('Scheduler：pending 30s / 未知 verdict 60s 落到 nextDueAt', async () => {
  const clock = createClock()
  const pending = createScheduler({
    clock,
    evaluate: async () => ({ verdict: 'pending', run: { status: 'pending', startedAt: clock.iso(-10) } }),
  })
  pending.scheduler.register(RUN_ID)
  await pending.scheduler.tick()
  A.equal(pending.calls.wake.length, 0)
  A.equal(pending.scheduler.status(RUN_ID).nextDueAt, clock.iso(20))
  A.equal(pending.scheduler.status(RUN_ID).lastReason, 'pending')

  const unknown = createScheduler({
    clock,
    evaluate: async () => ({ verdict: 'mystery', run: { status: 'running', startedAt: clock.iso(-10) } }),
  })
  unknown.scheduler.register(RUN_ID)
  await unknown.scheduler.tick()
  A.equal(unknown.calls.wake.length, 0)
  A.equal(unknown.scheduler.status(RUN_ID).nextDueAt, clock.iso(50))
  A.equal(unknown.scheduler.status(RUN_ID).lastReason, 'unknown-verdict')
})

// ---------------------------------------------------------------------------
// 5. Scheduler · 失败累计与降级
// ---------------------------------------------------------------------------

await check('Scheduler：连续 3 次唤醒抛错 → 降级（enabled=false + reason）+ 此后再不尝试', async () => {
  const clock = createClock()
  const store = createStore()
  const { scheduler, calls } = createScheduler({
    clock,
    store,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
    wake: async () => {
      throw new Error('boom')
    },
  })
  scheduler.register(RUN_ID)

  await scheduler.tick()
  A.equal(calls.wake.length, 1)
  A.equal(scheduler.status(RUN_ID).failures, 1)
  A.equal(store.get(RUN_ID).failures, 1)
  A.equal(store.get(RUN_ID).enabled, true)
  A.equal(store.get(RUN_ID).nextDueAt, clock.iso(180), '失败也要推进 nextDueAt')

  clock.advance(180)
  await scheduler.tick()
  A.equal(calls.wake.length, 2)
  A.equal(store.get(RUN_ID).failures, 2)
  A.equal(store.get(RUN_ID).enabled, true)

  clock.advance(180)
  await scheduler.tick()
  A.equal(calls.wake.length, 3)
  const degraded = store.get(RUN_ID)
  A.equal(degraded.enabled, false)
  A.equal(degraded.failures, 3)
  A.match(degraded.reason, /^wake-failed: boom$/)
  A.equal(scheduler.status(RUN_ID).enabled, false)
  A.equal(scheduler.status(RUN_ID).lastReason, 'not-registered', '降级后必须摘除登记')
  A.ok(calls.logs.some(item => item.level === 'warn' && /降级/.test(item.message)), '降级要留 warn 日志')

  // 此后再 tick 也不再尝试
  clock.advance(180)
  const after = await scheduler.tick()
  A.equal(calls.wake.length, 3)
  A.equal(after.runs, 0)
})

await check('Scheduler：wake 返回 false 也算失败，原因写进降级记录', async () => {
  const clock = createClock()
  const store = createStore()
  const { scheduler } = createScheduler({
    clock,
    store,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
    wake: async () => false,
  })
  scheduler.register(RUN_ID)
  for (let i = 0; i < 3; i += 1) {
    await scheduler.tick()
    clock.advance(180)
  }
  const state = store.get(RUN_ID)
  A.equal(state.enabled, false)
  A.match(state.reason, /^wake-failed: wake 返回 false$/)
})

await check('Scheduler：成功一次会把连续失败计数清零', async () => {
  const clock = createClock()
  const store = createStore()
  let succeed = false
  const { scheduler } = createScheduler({
    clock,
    store,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
    wake: async () => {
      if (!succeed) throw new Error('temporary')
      return true
    },
  })
  scheduler.register(RUN_ID)
  await scheduler.tick()
  A.equal(scheduler.status(RUN_ID).failures, 1)

  succeed = true
  clock.advance(180)
  await scheduler.tick()
  A.equal(store.get(RUN_ID).failures, 0)
  A.equal(store.get(RUN_ID).wakes, 1)
  A.equal(store.get(RUN_ID).enabled, true)
  A.equal(scheduler.status(RUN_ID).lastReason, 'healthy')
})

// ---------------------------------------------------------------------------
// 6. Scheduler · 错误隔离 / 重入 / 终态
// ---------------------------------------------------------------------------

await check('Scheduler：一个 run 的 evaluate 抛错不影响其它 run', async () => {
  const clock = createClock()
  const store = createStore()
  const { scheduler, calls } = createScheduler({
    clock,
    store,
    evaluate: async runId => {
      if (runId === 'r-bad') throw new Error('audit exploded')
      return { verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }
    },
  })
  scheduler.register('r-bad')
  scheduler.register('r-good')

  const stats = await scheduler.tick()
  A.equal(stats.runs, 2)
  A.equal(stats.woken, 1)
  A.equal(stats.failed, 1)
  A.deepEqual(calls.wake.map(item => item.runId), ['r-good'])
  A.ok(calls.logs.some(item => item.level === 'warn' && /r-bad/.test(item.message)), '坏 run 要留 warn 日志')
  A.equal(scheduler.status('r-good').wakes, 1)
  A.equal(scheduler.status('r-bad').wakes, 0)
  A.equal(store.get('r-good').wakes, 1)
})

await check('Scheduler：load 抛错不崩 tick（沿用内存状态继续唤醒）', async () => {
  const clock = createClock()
  const store = createStore()
  store.load = async () => {
    throw new Error('disk gone')
  }
  const { scheduler, calls } = createScheduler({
    clock,
    store,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
  })
  scheduler.register(RUN_ID)
  const stats = await scheduler.tick()
  A.equal(stats.woken, 1)
  A.equal(calls.wake.length, 1)
  A.ok(calls.logs.some(item => item.level === 'warn' && /读取 supervision 失败/.test(item.message)))
  A.ok(store.get(RUN_ID), '读失败后仍应写入新状态')
})

await check('Scheduler：save 抛错不崩 tick，内存推进保证不会重复唤醒', async () => {
  const clock = createClock()
  const store = createStore()
  store.save = async () => {
    throw new Error('read-only')
  }
  const { scheduler, calls } = createScheduler({
    clock,
    store,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
  })
  scheduler.register(RUN_ID)
  const first = await scheduler.tick()
  A.equal(first.woken, 1)
  A.equal(calls.wake.length, 1)
  A.ok(calls.logs.some(item => item.level === 'warn' && /写入 supervision 失败/.test(item.message)))

  // 落盘失败但内存 nextDueAt 已推进 → 同一时刻不会二次唤醒
  await scheduler.tick()
  A.equal(calls.wake.length, 1)
  A.equal(scheduler.status(RUN_ID).wakes, 1)
})

await check('Scheduler：tick 重入保护（并发第二次直接 skipped）', async () => {
  const clock = createClock()
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  let wakeFinished = false
  const { scheduler, calls } = createScheduler({
    clock,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
    wake: async () => {
      await gate
      wakeFinished = true
      return true
    },
  })
  scheduler.register(RUN_ID)

  const firstTick = scheduler.tick()
  await waitFor(() => calls.wake.length === 1, '第一次 tick 进入 wake')
  const second = await scheduler.tick()
  A.equal(second.skipped, true)
  A.equal(second.runs, 0)
  A.equal(calls.wake.length, 1, '重入不许并发跑两轮')

  release()
  const first = await firstTick
  A.equal(first.skipped, false)
  A.equal(first.woken, 1)
  A.ok(wakeFinished)
})

await check('Scheduler：终态自动摘除登记，落盘 enabled=false / reason=terminal', async () => {
  const clock = createClock()
  const store = createStore()
  const { scheduler, calls } = createScheduler({
    clock,
    store,
    evaluate: async () => ({ verdict: 'done', run: { status: 'done', startedAt: clock.iso(-200) } }),
  })
  scheduler.register(RUN_ID)
  const stats = await scheduler.tick()
  A.equal(stats.woken, 0)
  A.equal(calls.wake.length, 0)
  A.equal(calls.evaluate.length, 1)

  const saved = store.get(RUN_ID)
  A.equal(saved.enabled, false)
  A.equal(saved.reason, 'terminal')
  A.equal(saved.nextDueAt, null)
  A.equal(scheduler.status(RUN_ID).enabled, false)
  A.equal(scheduler.status(RUN_ID).lastReason, 'not-registered')
  A.ok(calls.logs.some(item => item.level === 'info' && /terminal/.test(item.message)))

  // 摘除后不再 evaluate
  clock.advance(3600)
  const after = await scheduler.tick()
  A.equal(after.runs, 0)
  A.equal(calls.evaluate.length, 1)
})

// ---------------------------------------------------------------------------
// 7. Scheduler · register / unregister / status / 恢复
// ---------------------------------------------------------------------------

await check('Scheduler：status 字段契约（未登记 / 已登记）', () => {
  const clock = createClock()
  const { scheduler } = createScheduler({ clock, evaluate: async () => ({ verdict: 'healthy', run: { status: 'running' } }) })

  const missing = scheduler.status('nobody')
  A.deepEqual(missing, { enabled: false, nextDueAt: null, wakes: 0, failures: 0, lastReason: 'not-registered' })
  A.equal(Object.keys(missing).length, 5)

  const registered = scheduler.register(RUN_ID, { wakerSessionId: 'w' })
  A.deepEqual(registered, { enabled: true, nextDueAt: null, wakes: 0, failures: 0, lastReason: null })
  A.deepEqual(scheduler.status(RUN_ID), registered)

  A.equal(scheduler.unregister(RUN_ID), true)
  A.equal(scheduler.unregister(RUN_ID), false)
  A.equal(scheduler.status(RUN_ID).enabled, false)
})

await check('Scheduler：重启从持久化状态恢复计数与 nextDueAt，并沿用 wakerSessionId', async () => {
  const clock = createClock()
  const store = createStore({
    [RUN_ID]: {
      enabled: true,
      wakerSessionId: 'waker-restored',
      lastWokeAt: at(-100),
      nextDueAt: at(80),
      wakes: 2,
      failures: 1,
      reason: 'healthy',
    },
  })
  const { scheduler, calls } = createScheduler({
    clock,
    store,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: at(-200) } }),
  })
  scheduler.register(RUN_ID)

  await scheduler.tick()
  A.equal(calls.wake.length, 0, '恢复的 nextDueAt 还没到，不该唤醒')
  const status = scheduler.status(RUN_ID)
  A.equal(status.wakes, 2)
  A.equal(status.failures, 1)
  A.equal(status.nextDueAt, at(80))
  A.equal(status.lastReason, 'healthy')

  clock.advance(80)
  await scheduler.tick()
  A.equal(calls.wake.length, 1)
  A.equal(calls.wake[0].ctx.wakerSessionId, 'waker-restored')
  A.equal(store.get(RUN_ID).wakes, 3)
  A.equal(store.get(RUN_ID).failures, 0)
})

await check('Scheduler：register 是显式启用，可覆盖落盘的 wake-failed 禁用结论', async () => {
  const clock = createClock()
  const store = createStore({
    [RUN_ID]: {
      enabled: false,
      wakerSessionId: 'waker-old',
      lastWokeAt: at(-200),
      nextDueAt: at(-20),
      wakes: 5,
      failures: 3,
      reason: 'wake-failed: boom',
    },
  })
  const { scheduler, calls } = createScheduler({
    clock,
    store,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: at(-200) } }),
  })
  scheduler.register(RUN_ID)
  await scheduler.tick()

  A.equal(calls.wake.length, 1)
  const saved = store.get(RUN_ID)
  A.equal(saved.enabled, true)
  A.equal(saved.wakes, 1, '重新启用后计数清零重来')
  A.equal(saved.failures, 0)
  A.equal(saved.nextDueAt, clock.iso(180))
})

await check('Scheduler：没有登记任何 run 时 tick 安全返回 0', async () => {
  const clock = createClock()
  const { scheduler, calls } = createScheduler({ clock, evaluate: async () => ({ verdict: 'healthy', run: { status: 'running' } }) })
  const stats = await scheduler.tick()
  A.deepEqual(stats, { skipped: false, runs: 0, woken: 0, failed: 0 })
  A.equal(calls.evaluate.length, 0)
})

// ===========================================================================
// 8. v0.8 节点闹钟（07-runtime-0.7 §11 / R8）
// ===========================================================================

const FENCE = '```'

/** 用 JSON.stringify 造回报文本，避免手写转义。 */
const nodeReport = payload => JSON.stringify(payload)

/** 只用假定时器；返回的 timer 带 unref() 以便断言 unref 被调用。 */
function fakeNodeTimers() {
  const state = { intervals: [], cleared: [], unrefs: 0, nextId: 1 }
  return {
    state,
    setInterval(fn, ms) {
      const timer = {
        id: state.nextId,
        fn,
        ms,
        unref() {
          state.unrefs += 1
        },
      }
      state.nextId += 1
      state.intervals.push(timer)
      return timer
    },
    clearInterval(timer) {
      state.cleared.push(timer.id)
    },
  }
}

/** 组装节点闹钟：wake / 定时器 / 日志全部是桩，缺省 wake 返回 inject。 */
function createNodeScheduler({ clock, wake, nodeAlarmMs, intervalMs = 15000, maxFailures } = {}) {
  const timers = fakeNodeTimers()
  const calls = { wake: [], logs: [] }
  const scheduler = new NodeSupervisionScheduler({
    now: clock.now,
    wake: async entry => {
      calls.wake.push(entry)
      if (typeof wake !== 'function') return { action: 'inject' }
      return wake(entry, calls.wake.length)
    },
    log: (level, message) => calls.logs.push({ level, message }),
    intervalMs,
    nodeAlarmMs,
    maxFailures,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  })
  return { scheduler, calls, timers }
}

// ---------------------------------------------------------------------------
// 8.1 常量
// ---------------------------------------------------------------------------

await check('节点闹钟：NODE_ALARM_DEFAULT_MS = 120000，且是 register 缺省间隔', () => {
  A.equal(NODE_ALARM_DEFAULT_MS, 120000)
  A.ok(Number.isInteger(NODE_ALARM_DEFAULT_MS))

  const clock = createClock()
  const { scheduler } = createNodeScheduler({ clock })
  const status = scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1 })
  A.equal(status.nextDueAt, at(120), 'register 时 nextDueAt = now + 120s')
  A.deepEqual(status, {
    sessionId: 's1',
    runId: 'r1',
    nodeId: 'n1',
    attempt: 1,
    enabled: true,
    nextDueAt: at(120),
    wakes: 0,
    failures: 0,
    lastReason: null,
  })
  A.equal(Object.keys(status).length, 9)
  A.equal(scheduler.nodeAlarmMs, NODE_ALARM_DEFAULT_MS)
  A.equal(scheduler.maxFailures, 3)
})

// ---------------------------------------------------------------------------
// 8.2 parseNodeStatus
// ---------------------------------------------------------------------------

await check('parseNodeStatus：```json 围栏 + 全字段', () => {
  const text = [
    '先说明当前进展。',
    `${FENCE}json`,
    nodeReport({
      nodeId: 'n_dev',
      attempt: 2,
      state: 'done',
      progress: 100,
      summary: '接口与测试都写完了',
      members: [
        { name: 'agent-a', state: 'done', note: '实现' },
        { name: 'agent-b' },
      ],
      blockers: [],
      verdict: 'pass',
    }),
    FENCE,
    '以上。',
  ].join('\n')
  const parsed = parseNodeStatus(text)
  A.equal(parsed.state, 'done')
  A.equal(parsed.progress, 100)
  A.equal(parsed.summary, '接口与测试都写完了')
  A.equal(parsed.nodeId, 'n_dev')
  A.equal(parsed.attempt, 2)
  A.equal(parsed.verdict, 'pass')
  A.equal(parsed.members.length, 2)
  A.deepEqual(parsed.members[0], { name: 'agent-a', state: 'done', note: '实现' })
  A.deepEqual(parsed.members[1], { name: 'agent-b', state: 'working', note: '' })
  A.deepEqual(parsed.blockers, [])
  A.deepEqual(Object.keys(parsed), ['state', 'progress', 'summary', 'members', 'blockers', 'verdict', 'nodeId', 'attempt'])
})

await check('parseNodeStatus：裸 JSON（首个 { 到末个 }），前后夹说明文字', () => {
  const parsed = parseNodeStatus('汇报：{ "nodeId": "n_test", "state": "blocked", "blockers": ["等 CI"] } 完毕')
  A.equal(parsed.state, 'blocked')
  A.equal(parsed.nodeId, 'n_test')
  A.equal(parsed.progress, 0)
  A.equal(parsed.summary, '')
  A.deepEqual(parsed.members, [])
  A.deepEqual(parsed.blockers, ['等 CI'])
  A.equal(parsed.verdict, null)
  A.equal(parsed.attempt, null)
})

await check('parseNodeStatus：缺字段全部走默认值', () => {
  const parsed = parseNodeStatus('{}')
  A.equal(parsed.state, 'working')
  A.equal(parsed.progress, 0)
  A.equal(parsed.summary, '')
  A.deepEqual(parsed.members, [])
  A.deepEqual(parsed.blockers, [])
  A.equal(parsed.verdict, null)
  A.equal(parsed.nodeId, null)
  A.equal(parsed.attempt, null)
})

await check('parseNodeStatus：坏输入一律返回 null，绝不抛错', () => {
  for (const input of ['', '   ', '这里没有任何 JSON', '{"a":1', `${FENCE}json\n{bad json}\n${FENCE}`, null, undefined, 42, [], ['{}']]) {
    A.equal(parseNodeStatus(input), null, `坏输入应返回 null：${JSON.stringify(input)}`)
  }
})

await check('parseNodeStatus：progress 越界夹紧 / 非数→0 / 小数取整', () => {
  const cases = [
    [150, 100],
    [-20, 0],
    [50.6, 51],
    [0, 0],
    [100, 100],
    ['50', 0],
    [null, 0],
    [true, 0],
  ]
  for (const [value, expected] of cases) {
    A.equal(parseNodeStatus(nodeReport({ progress: value })).progress, expected, `progress=${JSON.stringify(value)}`)
  }
})

await check('parseNodeStatus：state / verdict 只认枚举，其它回落', () => {
  A.equal(parseNodeStatus(nodeReport({ state: 'paused' })).state, 'working')
  A.equal(parseNodeStatus(nodeReport({ state: 5 })).state, 'working')
  A.equal(parseNodeStatus(nodeReport({ state: 'DONE' })).state, 'working', '枚举大小写严格（只认小写契约值）')
  A.equal(parseNodeStatus(nodeReport({ state: ' done ' })).state, 'done', '只做首尾去空白')
  A.equal(parseNodeStatus(nodeReport({ verdict: 'PASS' })).verdict, null)
  A.equal(parseNodeStatus(nodeReport({ verdict: ' maybe ' })).verdict, null)
  A.equal(parseNodeStatus(nodeReport({ verdict: true })).verdict, null)
  A.equal(parseNodeStatus(nodeReport({ verdict: 'pass' })).verdict, 'pass')
  A.equal(parseNodeStatus(nodeReport({ verdict: ' reject ' })).verdict, 'reject')
})

await check('parseNodeStatus：summary 截断 2000 / blockers 截断 200 且上限 20 条', () => {
  const long = parseNodeStatus(nodeReport({
    summary: '字'.repeat(2500),
    blockers: Array.from({ length: 25 }, (_, index) => `b${index}`),
  }))
  A.equal(long.summary.length, 2000)
  A.equal(long.blockers.length, 20)
  A.equal(long.blockers[0], 'b0')

  A.equal(parseNodeStatus(nodeReport({ blockers: ['x'.repeat(300)] })).blockers[0].length, 200)

  const mixed = parseNodeStatus(nodeReport({ blockers: ['ok', '', 7, null, '  trim  '] }))
  A.deepEqual(mixed.blockers, ['ok', 'trim'], '非字符串 / 空串丢弃，字符串去空白')

  A.deepEqual(parseNodeStatus(nodeReport({ blockers: 'not-array' })).blockers, [])
  A.equal(parseNodeStatus(nodeReport({ summary: 123 })).summary, '')
})

await check('parseNodeStatus：members 上限 20 条、形状收敛、非对象丢弃', () => {
  const many = parseNodeStatus(nodeReport({ members: Array.from({ length: 25 }, (_, index) => ({ name: `m${index}` })) }))
  A.equal(many.members.length, 20)
  A.deepEqual(many.members[0], { name: 'm0', state: 'working', note: '' })

  const mixed = parseNodeStatus(nodeReport({
    members: ['x', null, { name: 123, state: 'failed', note: 42 }, { name: ' ok ', state: 'paused', note: ' hi ' }],
  }))
  A.equal(mixed.members.length, 2)
  A.deepEqual(mixed.members[0], { name: '', state: 'failed', note: '' })
  A.deepEqual(mixed.members[1], { name: 'ok', state: 'working', note: 'hi' })

  A.deepEqual(parseNodeStatus(nodeReport({ members: {} })).members, [])
})

await check('parseNodeStatus：nodeId / attempt 合法才保留', () => {
  const ok = parseNodeStatus(nodeReport({ nodeId: ' n1 ', attempt: 0 }))
  A.equal(ok.nodeId, 'n1')
  A.equal(ok.attempt, 0)

  const blank = parseNodeStatus(nodeReport({ nodeId: '   ', attempt: -1 }))
  A.equal(blank.nodeId, null)
  A.equal(blank.attempt, null)

  const wrongType = parseNodeStatus(nodeReport({ nodeId: 7, attempt: 1.5 }))
  A.equal(wrongType.nodeId, null)
  A.equal(wrongType.attempt, null)

  A.equal(parseNodeStatus(nodeReport({ attempt: '2' })).attempt, null)
})

await check('parseNodeStatus：围栏坏掉可回落到裸 JSON；非 json 围栏忽略；数组不算命中', () => {
  const fallback = parseNodeStatus(`{"state":"done","nodeId":"n_fb"}\n${FENCE}json\n{ 这也不是 JSON }\n${FENCE}`)
  A.equal(fallback.state, 'done')
  A.equal(fallback.nodeId, 'n_fb')

  A.equal(parseNodeStatus(`${FENCE}json\n{oops}\n${FENCE}`), null, '围栏坏且无裸 JSON → null')
  A.equal(parseNodeStatus(`${FENCE}js\nconst a = 1\n${FENCE}\n{"state":"failed"}`).state, 'failed')
  A.equal(parseNodeStatus(`${FENCE}json\n[1,2,3]\n${FENCE}`), null, '围栏里是数组 → 不是对象 → null')
  A.equal(parseNodeStatus(`${FENCE}JSON\n{"state":"blocked"}\n${FENCE}`).state, 'blocked', '围栏语言大小写不敏感')
})

// ---------------------------------------------------------------------------
// 8.3 NodeSupervisionScheduler · 到点 / 间隔
// ---------------------------------------------------------------------------

await check('NodeScheduler：到点才唤醒，且同一 due 只唤醒一次', async () => {
  const clock = createClock()
  const { scheduler, calls } = createNodeScheduler({ clock })
  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1 })

  let stats = await scheduler.tick()
  A.equal(stats.entries, 1)
  A.equal(stats.woken, 0)
  A.equal(calls.wake.length, 0)

  clock.advance(119)
  stats = await scheduler.tick()
  A.equal(stats.woken, 0, '未到点（差 1s）不该唤醒')

  clock.advance(1)
  stats = await scheduler.tick()
  A.equal(stats.woken, 1)
  A.equal(calls.wake.length, 1)
  A.equal(calls.wake[0].sessionId, 's1')
  A.equal(calls.wake[0].runId, 'r1')
  A.equal(calls.wake[0].nodeId, 'n1')
  A.equal(calls.wake[0].attempt, 1)
  A.equal(scheduler.status('s1').wakes, 1)
  A.equal(scheduler.status('s1').nextDueAt, at(240), '唤醒后推进一个 nodeAlarmMs')

  await scheduler.tick()
  A.equal(calls.wake.length, 1, '同一 due 不会重复唤醒')
  A.equal(scheduler.status('s1').wakes, 1)
})

await check('NodeScheduler：wake 收到只读快照，改它不影响内部状态', async () => {
  const clock = createClock()
  const { scheduler } = createNodeScheduler({
    clock,
    wake: entry => {
      entry.wakes = 99
      entry.enabled = false
      entry.failures = 7
      return { action: 'inject' }
    },
  })
  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1, intervalMs: 60000 })
  clock.advance(60)
  await scheduler.tick()
  const status = scheduler.status('s1')
  A.equal(status.wakes, 1)
  A.equal(status.enabled, true)
  A.equal(status.failures, 0)
})

await check('NodeScheduler：nodeAlarmMs 可注入，单条 register 的 intervalMs 覆盖它', async () => {
  const clock = createClock()
  const { scheduler, calls } = createNodeScheduler({ clock, nodeAlarmMs: 5000 })
  scheduler.register({ runId: 'r', nodeId: 'n1', sessionId: 's-default', attempt: 1 })
  scheduler.register({ runId: 'r', nodeId: 'n2', sessionId: 's-custom', attempt: 1, intervalMs: 30000 })
  A.equal(scheduler.status('s-default').nextDueAt, at(5))
  A.equal(scheduler.status('s-custom').nextDueAt, at(30))

  clock.advance(5)
  let stats = await scheduler.tick()
  A.equal(stats.woken, 1)
  A.equal(calls.wake[0].sessionId, 's-default')
  A.equal(scheduler.status('s-default').nextDueAt, at(10))
  A.equal(scheduler.status('s-custom').nextDueAt, at(30), '自定义间隔的还没到点')

  clock.advance(25)
  stats = await scheduler.tick()
  A.equal(stats.woken, 2)
  A.deepEqual(calls.wake.map(entry => entry.sessionId), ['s-default', 's-default', 's-custom'])

  const fallback = scheduler.register({ runId: 'r', nodeId: 'n3', sessionId: 's-bad', attempt: 1, intervalMs: 0 })
  A.equal(fallback.nextDueAt, clock.iso(5), '非法 intervalMs 回落到 nodeAlarmMs')
})

await check('NodeScheduler：skip 推进 nextDueAt、不计 wakes，并清掉失败 streak', async () => {
  const clock = createClock()
  const plan = ['throw', 'skip', 'skip']
  const { scheduler, calls } = createNodeScheduler({
    clock,
    wake: () => {
      const next = plan.shift()
      if (next === 'throw') throw new Error('busy')
      return { action: next, reason: 'busy' }
    },
  })
  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1, intervalMs: 60000 })

  clock.advance(60)
  let stats = await scheduler.tick()
  A.equal(stats.failed, 1)
  A.equal(scheduler.status('s1').failures, 1)

  clock.advance(60)
  stats = await scheduler.tick()
  A.equal(stats.skippedWakes, 1)
  A.equal(stats.woken, 0)
  const status = scheduler.status('s1')
  A.equal(status.wakes, 0, 'skip 不算真的发出去，wakes 不 +1')
  A.equal(status.failures, 0, 'skip 算成功，连续失败 streak 清零')
  A.equal(status.enabled, true)
  A.equal(status.nextDueAt, at(180), 'skip 同样推进 nextDueAt')
  A.equal(status.lastReason, 'skip: busy')

  clock.advance(60)
  stats = await scheduler.tick()
  A.equal(stats.skippedWakes, 1)
  A.equal(calls.wake.length, 3)
  A.equal(scheduler.status('s1').wakes, 0)
})

// ---------------------------------------------------------------------------
// 8.4 NodeSupervisionScheduler · 失败停摆
// ---------------------------------------------------------------------------

await check('NodeScheduler：连续 3 次唤醒失败 → 停摆（enabled=false），此后不再尝试但仍在 list 里', async () => {
  const clock = createClock()
  let attempts = 0
  const { scheduler, calls } = createNodeScheduler({
    clock,
    wake: () => {
      attempts += 1
      throw new Error(`boom-${attempts}`)
    },
  })
  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1, intervalMs: 60000 })

  for (let index = 0; index < 3; index += 1) {
    clock.advance(60)
    await scheduler.tick()
  }
  A.equal(calls.wake.length, 3)
  const status = scheduler.status('s1')
  A.equal(status.failures, 3)
  A.equal(status.enabled, false)
  A.equal(status.wakes, 0)
  A.equal(status.lastReason, 'wake-failed: boom-3')
  A.equal(status.nextDueAt, at(240), '失败也推进 nextDueAt，避免刷屏')

  clock.advance(600)
  const stats = await scheduler.tick()
  A.equal(stats.entries, 1)
  A.equal(stats.failed, 0)
  A.equal(calls.wake.length, 3, '停摆后再也不 wake')
  A.equal(scheduler.list().length, 1, '停摆的 entry 仍留在 list 里可查')
  A.equal(scheduler.list()[0].enabled, false)
  A.ok(calls.logs.some(item => item.level === 'warn' && /停摆/.test(item.message)))
})

await check('NodeScheduler：wake 返回非法结果也算失败；maxFailures 可注入', async () => {
  const clock = createClock()
  const results = [{ action: undefined }, { action: 'nope' }, null]
  const { scheduler, calls } = createNodeScheduler({
    clock,
    maxFailures: 2,
    wake: () => results.shift(),
  })
  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1, intervalMs: 60000 })

  clock.advance(60)
  let stats = await scheduler.tick()
  A.equal(stats.failed, 1)
  A.match(scheduler.status('s1').lastReason, /^wake-failed: wake 返回非法结果/)
  A.equal(scheduler.status('s1').enabled, true)

  clock.advance(60)
  stats = await scheduler.tick()
  A.equal(stats.failed, 1)
  A.equal(scheduler.status('s1').failures, 2)
  A.equal(scheduler.status('s1').enabled, false)
  A.equal(calls.wake.length, 2)
})

// ---------------------------------------------------------------------------
// 8.5 NodeSupervisionScheduler · 刷新 / 注销
// ---------------------------------------------------------------------------

await check('NodeScheduler：同一 sessionId 重复 register 只刷新不叠加（重排 due / 换 attempt / 清失败 streak）', async () => {
  const clock = createClock()
  let mode = 'ok'
  const { scheduler, calls } = createNodeScheduler({
    clock,
    wake: () => {
      if (mode === 'boom') throw new Error('boom')
      return { action: 'inject' }
    },
  })
  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1, intervalMs: 60000 })

  clock.advance(60)
  await scheduler.tick()
  A.equal(calls.wake.length, 1)
  A.equal(scheduler.status('s1').wakes, 1)

  mode = 'boom'
  clock.advance(60)
  await scheduler.tick()
  A.equal(scheduler.status('s1').failures, 1)

  const refreshed = scheduler.register({ runId: 'r1', nodeId: 'n2', sessionId: 's1', attempt: 2, intervalMs: 30000 })
  A.equal(scheduler.list().length, 1, '同一 sessionId 不叠加第二条')
  A.equal(refreshed.attempt, 2)
  A.equal(refreshed.nodeId, 'n2')
  A.equal(refreshed.wakes, 1, '累计 wakes 保留')
  A.equal(refreshed.failures, 0, '刷新清连续失败 streak')
  A.equal(refreshed.enabled, true)
  A.equal(refreshed.nextDueAt, clock.iso(30), '刷新重排 nextDueAt')
  A.equal(refreshed.lastReason, null)
})

await check('NodeScheduler：unregister / unregisterNode / unregisterRun 各自的口径', async () => {
  const clock = createClock()
  const { scheduler, calls } = createNodeScheduler({ clock })
  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1, intervalMs: 60000 })
  scheduler.register({ runId: 'r1', nodeId: 'n2', sessionId: 's2', attempt: 1, intervalMs: 60000 })
  scheduler.register({ runId: 'r2', nodeId: 'n1', sessionId: 's3', attempt: 1, intervalMs: 60000 })

  A.equal(scheduler.unregister('s1'), true)
  A.equal(scheduler.unregister('s1'), false, '重复注销返回 false')
  A.equal(scheduler.unregister(''), false)

  A.equal(scheduler.unregisterNode('r1', 'n2'), 1)
  A.equal(scheduler.unregisterNode('r1', 'n2'), 0)
  A.deepEqual(scheduler.list().map(entry => entry.sessionId), ['s3'])

  A.equal(scheduler.unregisterRun('r2'), 1)
  A.deepEqual(scheduler.list(), [])

  const stats = await scheduler.tick()
  A.deepEqual(stats, { skipped: false, entries: 0, woken: 0, skippedWakes: 0, failed: 0 })
  A.equal(calls.wake.length, 0)
})

await check('NodeScheduler：tick 中 unregister 不崩、不复活，注销的 entry 不再被碰', async () => {
  const clock = createClock()
  const { scheduler, calls } = createNodeScheduler({
    clock,
    wake: entry => {
      if (entry.sessionId === 's1') scheduler.unregister('s2')
      if (entry.sessionId === 's3') scheduler.unregister('s3')
      return { action: 'inject' }
    },
  })
  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1, intervalMs: 60000 })
  scheduler.register({ runId: 'r1', nodeId: 'n2', sessionId: 's2', attempt: 1, intervalMs: 60000 })
  scheduler.register({ runId: 'r1', nodeId: 'n3', sessionId: 's3', attempt: 1, intervalMs: 60000 })

  clock.advance(60)
  const stats = await scheduler.tick()
  A.equal(stats.entries, 3)
  A.equal(stats.woken, 2)
  A.equal(calls.wake.map(entry => entry.sessionId).join(','), 's1,s3', '本轮被注销的 s2 不再被唤醒')
  A.deepEqual(scheduler.list().map(entry => entry.sessionId), ['s1'])
  A.equal(scheduler.status('s2').lastReason, 'not-registered')
  A.equal(scheduler.status('s3').lastReason, 'not-registered')
  A.equal(scheduler.status('s1').wakes, 1)

  clock.advance(60)
  await scheduler.tick()
  A.equal(calls.wake.map(entry => entry.sessionId).join(','), 's1,s3,s1', '注销后的 entry 不会在后续 tick 复活')
  A.deepEqual(scheduler.list().map(entry => entry.sessionId), ['s1'])
})

// ---------------------------------------------------------------------------
// 8.6 NodeSupervisionScheduler · 重入 / 隔离 / 顺序 / start-stop
// ---------------------------------------------------------------------------

await check('NodeScheduler：tick 重入保护（并发第二次直接 skipped）', async () => {
  const clock = createClock()
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const { scheduler, calls } = createNodeScheduler({
    clock,
    wake: async () => {
      await gate
      return { action: 'inject' }
    },
  })
  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1, intervalMs: 60000 })
  clock.advance(60)

  const first = scheduler.tick()
  const second = await scheduler.tick()
  A.deepEqual(second, { skipped: true, entries: 0, woken: 0, skippedWakes: 0, failed: 0 })
  release()
  const stats = await first
  A.equal(stats.skipped, false)
  A.equal(stats.woken, 1)
  A.equal(calls.wake.length, 1)
  A.equal(scheduler.status('s1').wakes, 1)
})

await check('NodeScheduler：单个 entry 的 wake 抛错不影响其它 entry', async () => {
  const clock = createClock()
  const { scheduler, calls } = createNodeScheduler({
    clock,
    wake: entry => {
      if (entry.sessionId === 's1') throw new Error('boom')
      return { action: 'followup', reason: 'idle' }
    },
  })
  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1, intervalMs: 60000 })
  scheduler.register({ runId: 'r1', nodeId: 'n2', sessionId: 's2', attempt: 1, intervalMs: 60000 })

  clock.advance(60)
  const stats = await scheduler.tick()
  A.equal(stats.entries, 2)
  A.equal(stats.failed, 1)
  A.equal(stats.woken, 1)

  const failed = scheduler.status('s1')
  A.equal(failed.failures, 1)
  A.equal(failed.enabled, true)
  A.equal(failed.lastReason, 'wake-failed: boom')
  A.equal(failed.nextDueAt, at(120))

  const ok = scheduler.status('s2')
  A.equal(ok.wakes, 1)
  A.equal(ok.failures, 0)
  A.equal(ok.lastReason, 'idle')
  A.equal(ok.nextDueAt, at(120))
  A.equal(calls.wake.length, 2)
})

await check('NodeScheduler：多个到点 entry 依次 await，不并发唤醒', async () => {
  const clock = createClock()
  const order = []
  const { scheduler } = createNodeScheduler({
    clock,
    wake: async entry => {
      order.push(`start:${entry.sessionId}`)
      await Promise.resolve()
      order.push(`end:${entry.sessionId}`)
      return { action: 'inject' }
    },
  })
  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1, intervalMs: 60000 })
  scheduler.register({ runId: 'r1', nodeId: 'n2', sessionId: 's2', attempt: 1, intervalMs: 60000 })
  clock.advance(60)
  await scheduler.tick()
  A.deepEqual(order, ['start:s1', 'end:s1', 'start:s2', 'end:s2'])
  A.equal(scheduler.status('s1').wakes, 1)
  A.equal(scheduler.status('s2').wakes, 1)
})

await check('NodeScheduler：status / list 是只读快照，字段齐 9 个', () => {
  const clock = createClock()
  const { scheduler } = createNodeScheduler({ clock })
  const missing = scheduler.status('nobody')
  A.deepEqual(missing, {
    sessionId: 'nobody',
    runId: null,
    nodeId: null,
    attempt: null,
    enabled: false,
    nextDueAt: null,
    wakes: 0,
    failures: 0,
    lastReason: 'not-registered',
  })
  A.equal(Object.keys(missing).length, 9)
  A.deepEqual(scheduler.list(), [])

  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1, intervalMs: 60000 })
  const snapshot = scheduler.status('s1')
  snapshot.wakes = 42
  snapshot.enabled = false
  A.equal(scheduler.status('s1').wakes, 0, '改快照不影响内部计数')
  A.equal(scheduler.status('s1').enabled, true)

  const listed = scheduler.list()
  A.equal(listed.length, 1)
  A.equal(Object.keys(listed[0]).length, 9)
  listed[0].failures = 9
  A.equal(scheduler.status('s1').failures, 0)
})

await check('NodeScheduler：start 幂等 / stop 幂等 / interval 用 intervalMs / unref 已被调用', async () => {
  const clock = createClock()
  const { scheduler, calls, timers } = createNodeScheduler({ clock, intervalMs: 2500 })
  A.equal(timers.state.intervals.length, 0)
  A.equal(scheduler.start(), true)
  A.equal(scheduler.start(), false)
  A.equal(timers.state.intervals.length, 1)
  A.equal(timers.state.intervals[0].ms, 2500)
  A.equal(timers.state.unrefs, 1, '定时器要 unref，别拖住进程退出')
  A.equal(scheduler.stop(), true)
  A.equal(scheduler.stop(), false)
  A.deepEqual(timers.state.cleared, [1])
  A.equal(scheduler.start(), true)
  A.equal(timers.state.intervals.length, 2)

  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1, intervalMs: 60000 })
  clock.advance(60)
  const timer = timers.state.intervals[1]
  A.equal(timer.fn(), undefined)
  await waitFor(() => scheduler.status('s1').wakes === 1, '定时器回调驱动 tick')
  A.equal(calls.wake.length, 1)
  A.equal(scheduler.stop(), true)
})

console.log(`\nsupervise 自检：${checks} 组通过（${assertionCount} 条断言）`)
