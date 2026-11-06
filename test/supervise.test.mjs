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
 *
 * v0.8.1（E1-a / E1-b）追加：每条 entry 的独立超时（hang 不拖死整轮）、有界并发、
 * stop 后无 timer 残留（含子进程自然退出实证）、snapshot() 可观测字段、
 * inspectNodeStatus 区分「没回报」与「回报了但格式错」。
 *
 * v0.8.2（G7-a / G7-b）追加：同 wakerSessionId 的 run 合并成一次 wake（coalesced 可查）、
 * 每会话小时预算 + 最小间隔（限流保留 due、不降级）、NodeSupervisionScheduler.has() 与
 * recordRecovery()（重启恢复节点闹钟的幂等支撑 + snapshot().recovery 统计）。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  planWake,
  SupervisionScheduler,
  SUPERVISION_INTERVALS,
  SUPERVISION_WAKE_TIMEOUT_MS,
  SUPERVISION_MAX_CONCURRENCY,
  SUPERVISION_WAKER_HOURLY_LIMIT,
  SUPERVISION_WAKER_MIN_INTERVAL_MS,
  NODE_ALARM_DEFAULT_MS,
  NodeSupervisionScheduler,
  parseNodeStatus,
  inspectNodeStatus,
  NODE_REPORT_MISSING,
  NODE_REPORT_INVALID,
  NODE_REPORT_OK,
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
 * 假 setTimeout / clearTimeout：用于断言「stop 后没有 timer 残留」。
 * 每个 timer 记录 active；fire() 模拟到点（先置 inactive 再跑回调，贴近真实语义），
 * pending() 返回还活着的 timer。
 */
function fakeTimeouts() {
  const state = { timers: [], cleared: [], armed: [], nextId: 1, unrefs: 0 }
  return {
    state,
    setTimeout(fn, ms) {
      const timer = {
        id: state.nextId++,
        ms,
        active: true,
        unref() {
          state.unrefs += 1
        },
        fire() {
          if (!timer.active) return
          timer.active = false
          fn()
        },
      }
      state.armed.push(timer)
      state.timers.push(timer)
      return timer
    },
    clearTimeout(timer) {
      if (!timer || timer.active === false) return
      timer.active = false
      state.cleared.push(timer.id)
    },
    pending() {
      return state.timers.filter(timer => timer.active)
    },
  }
}

/**
 * 组装调度器：evaluate / wake 都记录调用；store / clock / timers 可替换。
 * v0.8.1 追加 wakeTimeoutMs / maxConcurrency / timeouts（假 setTimeout）注入。
 */
function createScheduler({
  clock,
  store = createStore(),
  evaluate,
  wake,
  intervalMs = 1000,
  wakeTimeoutMs,
  maxConcurrency,
  wakerHourlyLimit,
  wakerMinIntervalMs,
  timeouts,
} = {}) {
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
    ...(wakeTimeoutMs === undefined ? {} : { wakeTimeoutMs }),
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    ...(wakerHourlyLimit === undefined ? {} : { wakerHourlyLimit }),
    ...(wakerMinIntervalMs === undefined ? {} : { wakerMinIntervalMs }),
    ...(timeouts === undefined
      ? {}
      : { setTimeout: timeouts.setTimeout, clearTimeout: timeouts.clearTimeout }),
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
// 注意：多数用例断言的是「到点推进 / 幂等 / 失败停摆」这套机制，跟默认间隔无关，
// 所以夹具默认注入 120s 的短间隔（真实默认已是 600s，由单独一组用例守护）。
function createNodeScheduler({
  clock,
  wake,
  nodeAlarmMs = 120_000,
  intervalMs = 15000,
  maxFailures,
  wakeTimeoutMs,
  maxConcurrency,
  timeouts,
} = {}) {
  const timers = fakeNodeTimers()
  const calls = { wake: [], logs: [] }
  const scheduler = new NodeSupervisionScheduler({
    now: clock.now,
    wake: async (entry, ctx) => {
      calls.wake.push(entry)
      if (typeof wake !== 'function') return { action: 'inject' }
      return wake(entry, calls.wake.length, ctx)
    },
    log: (level, message) => calls.logs.push({ level, message }),
    intervalMs,
    nodeAlarmMs,
    maxFailures,
    ...(wakeTimeoutMs === undefined ? {} : { wakeTimeoutMs }),
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    ...(timeouts === undefined
      ? {}
      : { setTimeout: timeouts.setTimeout, clearTimeout: timeouts.clearTimeout }),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  })
  return { scheduler, calls, timers }
}

// ---------------------------------------------------------------------------
// 8.1 常量
// ---------------------------------------------------------------------------

await check('节点闹钟：NODE_ALARM_DEFAULT_MS = 600000（10 分钟，120s 太频繁），且是 register 缺省间隔', () => {
  A.equal(NODE_ALARM_DEFAULT_MS, 600000)
  A.ok(Number.isInteger(NODE_ALARM_DEFAULT_MS))

  const clock = createClock()
  // 不注入 nodeAlarmMs：验证「缺省就是 600s」这条契约（夹具本身注入 120s 是为了缩短计时）。
  const scheduler = new NodeSupervisionScheduler({
    now: clock.now,
    wake: async () => ({ action: 'inject' }),
    log: () => {},
  })
  const status = scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1 })
  A.equal(status.nextDueAt, at(600), 'register 时 nextDueAt = now + 600s')
  A.deepEqual(status, {
    sessionId: 's1',
    runId: 'r1',
    nodeId: 'n1',
    attempt: 1,
    enabled: true,
    nextDueAt: at(600),
    wakes: 0,
    failures: 0,
    lastReason: null,
  })
  A.equal(Object.keys(status).length, 9)
  A.equal(scheduler.nodeAlarmMs, NODE_ALARM_DEFAULT_MS, '不注入时用 600s 默认值')
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

// ===========================================================================
// 9. v0.8.1 · E1-a / E1-b：独立超时、有界并发、可观测快照、回报判定
// ===========================================================================

/** 永不 resolve 的唤醒桩：模拟「节点会话永不 idle」。 */
const hangForever = () => new Promise(() => {})

// ---------------------------------------------------------------------------
// 9.1 E1-a · run 级：一条 hang 不拖死整轮
// ---------------------------------------------------------------------------

await check('Scheduler(E1-a)：一条 hang + 三条正常 → tick 在超时上限内结束，正常三条照常唤醒，hang 记 timeout', async () => {
  const clock = createClock()
  const store = createStore()
  // 用假 setTimeout 手动触发超时，确定性更好；真实 setTimeout 被 unref 后，
  // 如果事件循环没有别的句柄，进程会在到点前直接退出（真实到点路径由 9.8 子进程覆盖）。
  const timeouts = fakeTimeouts()
  const { scheduler, calls } = createScheduler({
    clock,
    store,
    wakeTimeoutMs: 40,
    maxConcurrency: 4,
    timeouts,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
    wake: async runId => (runId === 'r-hang' ? hangForever() : true),
  })
  for (const runId of ['r-hang', 'r-ok-1', 'r-ok-2', 'r-ok-3']) scheduler.register(runId)

  const tickPromise = scheduler.tick()
  await waitFor(
    () => calls.wake.length === 4 && timeouts.pending().length === 1,
    '四条都进入 wake 且正常条目已结算',
  )
  A.equal(timeouts.pending().length, 1, '只有 hang 的那条还挂着超时 timer（正常条目已结算）')
  A.equal(timeouts.pending()[0].ms, 40, '超时用注入的 wakeTimeoutMs')
  const startedAt = Date.now()
  for (const timer of timeouts.pending()) timer.fire()
  const stats = await tickPromise
  const elapsed = Date.now() - startedAt

  A.equal(stats.skipped, false)
  A.equal(stats.runs, 4)
  A.equal(stats.woken, 3, '正常三条都要被处理')
  A.equal(stats.failed, 1, '超时计入 failed')
  A.ok(elapsed < 1000, `超时后 tick 必须立即收口（实测 ${elapsed}ms）`)
  A.deepEqual(
    calls.wake.map(item => item.runId).sort(),
    ['r-hang', 'r-ok-1', 'r-ok-2', 'r-ok-3'],
    'hang 的那条不能挡住其它条',
  )

  const snapshot = scheduler.snapshot()
  const hang = snapshot.entries.find(entry => entry.runId === 'r-hang')
  A.equal(hang.lastOutcome, 'timeout', 'hang 的那条记为 timeout')
  A.equal(hang.timeouts, 1)
  A.equal(hang.failures, 1)
  A.equal(hang.enabled, true, '单次超时不降级')
  A.equal(hang.nextDueAt, clock.iso(60), '超时按 anomaly 60s 推进 nextDueAt')
  A.match(hang.lastReason, /^wake-timeout: /)
  A.equal(typeof hang.lastDurationMs, 'number')

  for (const runId of ['r-ok-1', 'r-ok-2', 'r-ok-3']) {
    const entry = snapshot.entries.find(item => item.runId === runId)
    A.equal(entry.lastOutcome, 'woken', `${runId} 应照常唤醒`)
    A.equal(entry.wakes, 1)
    A.equal(entry.timeouts, 0)
  }

  A.equal(snapshot.tick.count, 1)
  A.equal(snapshot.tick.skipped, 0)
  A.equal(typeof snapshot.tick.lastDurationMs, 'number')
  A.ok(snapshot.tick.lastDurationMs >= 0)
  A.deepEqual(snapshot.tick.lastStats, stats, '整轮 tick 的统计要能查到')
  A.equal(snapshot.wakeTimeoutMs, 40)
  A.equal(snapshot.concurrency.limit, 4)
  A.equal(snapshot.concurrency.active, 0)
  A.equal(snapshot.ticking, false)
  A.ok(
    calls.logs.some(item => item.level === 'warn' && /唤醒超时/.test(item.message)),
    '超时要留 warn 日志',
  )
})

// ---------------------------------------------------------------------------
// 9.2 E1-a · 单条抛异常 / 卡住只影响自己
// ---------------------------------------------------------------------------

await check('Scheduler(E1-a)：单条抛异常 / 卡住都只影响自己，其它条照常处理', async () => {
  const clock = createClock()
  const timeouts = fakeTimeouts()
  const { scheduler, calls } = createScheduler({
    clock,
    wakeTimeoutMs: 40,
    timeouts,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
    wake: async runId => {
      if (runId === 'r-throw') throw new Error('boom-isolated')
      if (runId === 'r-hang') return hangForever()
      return true
    },
  })
  for (const runId of ['r-throw', 'r-hang', 'r-good-1', 'r-good-2']) scheduler.register(runId)

  const tickPromise = scheduler.tick()
  await waitFor(
    () => calls.wake.length === 4 && timeouts.pending().length === 1,
    '四条都进入 wake 且只有 hang 那条在等超时',
  )
  A.equal(timeouts.pending().length, 1, '只有 hang 的那条还在等超时')
  for (const timer of timeouts.pending()) timer.fire()
  const stats = await tickPromise

  A.equal(stats.runs, 4)
  A.equal(stats.failed, 2)
  A.equal(stats.woken, 2)

  const byId = runId => scheduler.snapshot().entries.find(entry => entry.runId === runId)
  A.equal(byId('r-throw').lastOutcome, 'failed')
  A.equal(byId('r-throw').lastError, 'boom-isolated')
  A.match(byId('r-throw').lastReason, /^wake-failed: boom-isolated$/)
  A.equal(byId('r-throw').failures, 1)
  A.equal(byId('r-throw').enabled, true)
  A.equal(byId('r-hang').lastOutcome, 'timeout')
  A.equal(byId('r-good-1').lastOutcome, 'woken')
  A.equal(byId('r-good-2').lastOutcome, 'woken')
  A.ok(
    scheduler.snapshot().entries.every(entry => typeof entry.lastDurationMs === 'number'),
    '每一条都要有耗时（可观测）',
  )
})

// ---------------------------------------------------------------------------
// 9.3 E1-a · 重入跳过 + stop 结算在飞
// ---------------------------------------------------------------------------

await check('Scheduler(E1-a)：上一轮未完成时新一轮被跳过，stop 会结算在飞 entry 并清 timer', async () => {
  const clock = createClock()
  const { scheduler, calls, timers } = createScheduler({
    clock,
    wakeTimeoutMs: 60_000,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
    wake: async () => hangForever(),
  })
  scheduler.start()
  scheduler.register(RUN_ID)

  const firstTick = scheduler.tick()
  await waitFor(() => calls.wake.length === 1, '第一轮进入 wake')
  A.equal(scheduler.snapshot().ticking, true)
  A.equal(scheduler.snapshot().concurrency.active, 1, '有 1 条在飞')

  const second = await scheduler.tick()
  A.equal(second.skipped, true)
  A.equal(scheduler.snapshot().tick.skipped, 1, '被跳过的轮次要记进快照')
  A.equal(calls.wake.length, 1, '重入不许并发跑两轮')

  A.equal(scheduler.stop(), true)
  const first = await firstTick
  A.equal(first.skipped, false)
  A.equal(first.failed, 0, 'stop 结算不算失败')
  A.equal(scheduler.snapshot().ticking, false)
  const entry = scheduler.snapshot().entries.find(item => item.runId === RUN_ID)
  A.equal(entry.lastOutcome, 'aborted')
  A.equal(scheduler.stop(), false, '重复 stop 幂等')
  A.equal(timers.state.cleared.length, 1, 'interval 只清一次')
})

// ---------------------------------------------------------------------------
// 9.4 E1-a · 节点级：一条 hang 不拖死整轮
// ---------------------------------------------------------------------------

await check('NodeScheduler(E1-a)：一条 hang + 三条正常 → tick 有界结束，正常三条照常自审，hang 记 timeout', async () => {
  const clock = createClock()
  const timeouts = fakeTimeouts()
  const { scheduler, calls } = createNodeScheduler({
    clock,
    nodeAlarmMs: 1000,
    wakeTimeoutMs: 40,
    maxConcurrency: 4,
    timeouts,
    wake: entry => (entry.sessionId === 's-hang' ? hangForever() : { action: 'followup', reason: 'idle' }),
  })
  for (const [runId, nodeId, sessionId] of [
    ['r-hang', 'n-hang', 's-hang'],
    ['r-1', 'n-1', 's-1'],
    ['r-2', 'n-2', 's-2'],
    ['r-3', 'n-3', 's-3'],
  ]) {
    scheduler.register({ runId, nodeId, sessionId, attempt: 1, intervalMs: 1000 })
  }

  clock.advance(1)
  const tickPromise = scheduler.tick()
  await waitFor(
    () => calls.wake.length === 4 && timeouts.pending().length === 1,
    '四条都进入 wake 且正常条目已结算',
  )
  A.equal(timeouts.pending().length, 1, '只有 hang 的那条还挂着超时 timer')
  const startedAt = Date.now()
  for (const timer of timeouts.pending()) timer.fire()
  const stats = await tickPromise
  const elapsed = Date.now() - startedAt

  A.equal(stats.entries, 4)
  A.equal(stats.woken, 3)
  A.equal(stats.failed, 1)
  A.ok(elapsed < 1000, `超时后 tick 必须立即收口（实测 ${elapsed}ms）`)

  const snapshot = scheduler.snapshot()
  const hang = snapshot.entries.find(entry => entry.sessionId === 's-hang')
  A.equal(hang.lastOutcome, 'timeout')
  A.equal(hang.timeouts, 1)
  A.equal(hang.failures, 1)
  A.equal(hang.enabled, true)
  A.equal(hang.nextDueAt, clock.iso(1), '超时按本条 intervalMs 推进 due（now=BASE+1s，+1s）')
  A.match(hang.lastReason, /^wake-timeout: /)
  for (const sessionId of ['s-1', 's-2', 's-3']) {
    const entry = snapshot.entries.find(item => item.sessionId === sessionId)
    A.equal(entry.lastOutcome, 'woken')
    A.equal(entry.wakes, 1)
    A.equal(entry.timeouts, 0)
  }
  A.equal(snapshot.kind, 'node')
  A.equal(snapshot.nodeAlarmMs, 1000)
  A.equal(snapshot.wakeTimeoutMs, 40)
  A.deepEqual(snapshot.tick.lastStats, stats)
  A.ok(calls.logs.some(item => item.level === 'warn' && /唤醒超时/.test(item.message)))
})

// ---------------------------------------------------------------------------
// 9.5 E1-a · 有界并发
// ---------------------------------------------------------------------------

await check('NodeScheduler(E1-a)：有界并发 maxConcurrency，单条慢不拖住其它条', async () => {
  const clock = createClock()
  let active = 0
  let maxActive = 0
  let finished = 0
  const { scheduler } = createNodeScheduler({
    clock,
    nodeAlarmMs: 1000,
    maxConcurrency: 3,
    wakeTimeoutMs: 5000,
    wake: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active -= 1
      finished += 1
      return { action: 'inject' }
    },
  })
  for (let index = 0; index < 6; index += 1) {
    scheduler.register({
      runId: `r-${index}`,
      nodeId: `n-${index}`,
      sessionId: `s-${index}`,
      attempt: 1,
      intervalMs: 1000,
    })
  }

  clock.advance(1)
  const stats = await scheduler.tick()
  A.equal(stats.entries, 6)
  A.equal(stats.woken, 6)
  A.equal(finished, 6)
  A.ok(maxActive <= 3, `并发不得超过上限 3（实测 ${maxActive}）`)
  A.ok(maxActive >= 2, `必须真的有并发，不是串行（实测 ${maxActive}）`)
  A.equal(scheduler.snapshot().concurrency.limit, 3)
  A.equal(scheduler.snapshot().concurrency.active, 0)
})

// ---------------------------------------------------------------------------
// 9.6 E1-a · stop / dispose 后无 timer 残留
// ---------------------------------------------------------------------------

await check('调度器收尾(E1-a)：stop / dispose 后没有 setTimeout 残留（在飞 entry 被结算）', async () => {
  const clock = createClock()
  const runTimeouts = fakeTimeouts()
  const runScheduler = createScheduler({
    clock,
    wakeTimeoutMs: 60_000,
    timeouts: runTimeouts,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
    wake: async () => hangForever(),
  })
  runScheduler.scheduler.start()
  runScheduler.scheduler.register(RUN_ID)
  const runTick = runScheduler.scheduler.tick()
  await waitFor(() => runScheduler.calls.wake.length === 1, 'run 进入 wake')
  A.equal(runTimeouts.pending().length, 1, '在飞 entry 有 1 个超时 timer')
  A.ok(runTimeouts.state.unrefs >= 1, '超时 timer 要 unref（不拖住进程退出）')

  runScheduler.scheduler.stop()
  A.equal(runTimeouts.pending().length, 0, 'stop 后超时 timer 必须清零')
  await runTick
  A.equal(runScheduler.scheduler.snapshot().ticking, false)
  A.equal(runScheduler.scheduler.dispose(), false, 'dispose 幂等（已停止）')
  A.equal(runTimeouts.pending().length, 0)

  const nodeTimeouts = fakeTimeouts()
  const nodeScheduler = createNodeScheduler({
    clock,
    nodeAlarmMs: 1000,
    wakeTimeoutMs: 60_000,
    timeouts: nodeTimeouts,
    wake: async () => hangForever(),
  })
  nodeScheduler.scheduler.start()
  nodeScheduler.scheduler.register({ runId: 'r-a', nodeId: 'n-a', sessionId: 's-a', attempt: 1, intervalMs: 1000 })
  nodeScheduler.scheduler.register({ runId: 'r-b', nodeId: 'n-b', sessionId: 's-b', attempt: 1, intervalMs: 1000 })
  clock.advance(1)
  const nodeTick = nodeScheduler.scheduler.tick()
  await waitFor(() => nodeScheduler.calls.wake.length === 2, 'node 两条都进入 wake')
  A.equal(nodeTimeouts.pending().length, 2)
  A.ok(nodeTimeouts.state.unrefs >= 2)

  nodeScheduler.scheduler.stop()
  A.equal(nodeTimeouts.pending().length, 0, 'stop 后两条超时 timer 都要清零')
  await nodeTick
  A.equal(nodeScheduler.scheduler.snapshot().ticking, false)
  A.equal(nodeScheduler.scheduler.dispose(), false)
  A.equal(nodeTimeouts.pending().length, 0)
})

// ---------------------------------------------------------------------------
// 9.7 E1-a · 连续超时累计到阈值就停摆
// ---------------------------------------------------------------------------

await check('NodeScheduler(E1-a)：连续超时累计到阈值 → 停摆（enabled=false），timeouts 可查', async () => {
  const clock = createClock()
  const timeouts = fakeTimeouts()
  const { scheduler, calls } = createNodeScheduler({
    clock,
    maxFailures: 2,
    nodeAlarmMs: 1000,
    wakeTimeoutMs: 20,
    timeouts,
    wake: async () => hangForever(),
  })
  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1, intervalMs: 1000 })
  clock.advance(1)

  let tickPromise = scheduler.tick()
  await waitFor(() => calls.wake.length === 1, '第一轮进入 wake')
  for (const timer of timeouts.pending()) timer.fire()
  let stats = await tickPromise
  A.equal(stats.failed, 1)
  A.equal(scheduler.status('s1').enabled, true)

  clock.advance(60)
  tickPromise = scheduler.tick()
  await waitFor(() => calls.wake.length === 2, '第二轮进入 wake')
  for (const timer of timeouts.pending()) timer.fire()
  stats = await tickPromise
  A.equal(stats.failed, 1)
  const status = scheduler.status('s1')
  A.equal(status.enabled, false)
  A.equal(status.failures, 2)
  A.match(status.lastReason, /^wake-timeout: /)
  A.equal(scheduler.snapshot().entries[0].timeouts, 2, '超时要单独计数')
  A.equal(scheduler.list().length, 1, '停摆后仍留在 list 里')
})

// ---------------------------------------------------------------------------
// 9.8 E1-a · 进程能自然退出（子进程实证）
// ---------------------------------------------------------------------------

await check('调度器收尾(E1-a)：跑完调度器后不 process.exit()，子进程能自然退出（无 timer 残留）', async () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const moduleUrl = new URL('../src/supervise.js', import.meta.url).href
  const script = `
import { SupervisionScheduler, NodeSupervisionScheduler } from ${JSON.stringify(moduleUrl)}
// 兜底告警：unref 的 watchdog 只在「还有别的句柄吊着事件循环」时才有机会触发。
const watchdog = setTimeout(() => console.log('LEAK-TIMER'), 1500)
watchdog.unref()
const now = () => Date.now()
const iso = ms => new Date(ms).toISOString()
const hang = () => new Promise(() => {})
// 超时 timer 是 unref 的（不拖住进程退出）；测试期间临时用 ref 计时器占住事件循环，
// 让 unref 的超时有机会真的到点，跑完立刻清掉。
const keepAlive = () => {
  const timer = setTimeout(() => {}, 1000)
  return () => clearTimeout(timer)
}
const run = new SupervisionScheduler({
  now,
  wakeTimeoutMs: 30,
  wake: hang,
  evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: iso(Date.now() - 300000) } }),
  load: async () => null,
  save: async () => {},
})
run.start()
run.register('r-exit', { wakerSessionId: 'w-exit' })
const releaseRun = keepAlive()
const runStats = await run.tick()
releaseRun()
run.stop()

const node = new NodeSupervisionScheduler({ now, wakeTimeoutMs: 30, wake: hang, nodeAlarmMs: 1 })
node.start()
node.register({ runId: 'r-exit', nodeId: 'n-exit', sessionId: 's-exit', attempt: 1, intervalMs: 1 })
await new Promise(resolve => setTimeout(resolve, 5))
const releaseNode = keepAlive()
const nodeStats = await node.tick()
releaseNode()
node.stop()

const ok = runStats.failed === 1
  && nodeStats.failed === 1
  && run.snapshot().entries[0].lastOutcome === 'timeout'
  && node.snapshot().entries[0].lastOutcome === 'timeout'
console.log(ok ? 'OK' : 'BAD-RESULT', JSON.stringify({ runStats, nodeStats }))
`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const result = await new Promise(resolve => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('exit', (code, signal) => {
      clearTimeout(killTimer)
      resolve({ code, signal })
    })
  })

  A.equal(result.signal, null, `子进程必须自然退出（被 ${result.signal} 杀掉说明有句柄残留）：${stderr}`)
  A.equal(result.code, 0, `子进程应正常退出：${stderr}`)
  A.match(stdout, /OK/, `调度器应在超时后正常收口：${stdout}`)
  A.ok(!/LEAK-TIMER/.test(stdout), `不允许有 timer 残留吊住进程：${stdout}`)
})

// ---------------------------------------------------------------------------
// 9.9 E1-b · parseNodeStatus 的判定区分
// ---------------------------------------------------------------------------

await check('inspectNodeStatus(E1-b)：区分 missing（没回报）与 invalid（回报了但格式错）', () => {
  const valid = inspectNodeStatus('{"state":"working"}')
  A.equal(valid.kind, NODE_REPORT_OK)
  A.equal(valid.parsed.state, 'working')
  A.equal(valid.reason, null)

  // 「没回报」：非字符串 / 空白 / 纯文字里没有 JSON
  for (const text of ['', '   ', '这轮没有结构化回报', null, undefined, 42, [], ['{}']]) {
    const result = inspectNodeStatus(text)
    A.equal(result.kind, NODE_REPORT_MISSING, `应判为没回报：${JSON.stringify(text)}`)
    A.equal(result.parsed, null)
  }

  // 「回报了但结构不合法」：有 JSON 痕迹但解析失败 / 顶层不是对象
  for (const text of [
    '{"a":1',
    '{"state": 这里不是 JSON}',
    '```json\n{bad}\n```',
    '```json\n[1,2,3]\n```',
    '```js\nconst a = 1\n```',
  ]) {
    const result = inspectNodeStatus(text)
    A.equal(result.kind, NODE_REPORT_INVALID, `应判为格式错：${JSON.stringify(text)}`)
    A.equal(result.parsed, null)
    A.ok(result.reason !== null)
  }

  // parseNodeStatus 的既有契约不变：坏输入仍是 null
  A.equal(parseNodeStatus('{"a":1'), null)
  A.equal(parseNodeStatus('这轮没有结构化回报'), null)
})

// ---------------------------------------------------------------------------
// 9.10 E1-b · recordReport 落进快照
// ---------------------------------------------------------------------------

await check('NodeScheduler(E1-b)：recordReport 把回报判定落进快照，invalid 会 warn', () => {
  const clock = createClock()
  const { scheduler, calls } = createNodeScheduler({ clock })
  A.equal(scheduler.recordReport('nobody', { kind: NODE_REPORT_OK }), false, '未登记不新建 entry')

  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1 })
  A.equal(scheduler.recordReport('s1', inspectNodeStatus('这轮没有结构化回报')), true)
  let entry = scheduler.snapshot().entries[0]
  A.equal(entry.lastReport.kind, NODE_REPORT_MISSING)
  A.equal(typeof entry.lastReport.at, 'string')

  A.equal(scheduler.recordReport('s1', inspectNodeStatus('{"a":1')), true)
  entry = scheduler.snapshot().entries[0]
  A.equal(entry.lastReport.kind, NODE_REPORT_INVALID)
  A.ok(
    calls.logs.some(item => item.level === 'warn' && /结构不合法/.test(item.message)),
    '格式错要能被上报（warn）',
  )

  // status()/list() 的 9 字段契约不变，lastReport 只出现在 snapshot 里
  A.equal(Object.keys(scheduler.status('s1')).length, 9)
  A.equal(Object.keys(scheduler.list()[0]).length, 9)
  A.equal(scheduler.status('s1').lastReport, undefined)
})

// ===========================================================================
// 9.12 v0.8.2 · G7-a：按发起会话（wakerSessionId）合并唤醒 + 每会话预算
// ===========================================================================

await check('Scheduler(G7-a)：10 个 run 同 wakerSessionId → 一轮 tick 只发 1 次 wake，另 9 个合并而非丢弃', async () => {
  const clock = createClock()
  const store = createStore()
  const { scheduler, calls } = createScheduler({
    clock,
    store,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
  })
  const runIds = Array.from({ length: 10 }, (_, index) => `r-merge-${index}`)
  for (const runId of runIds) scheduler.register(runId, { wakerSessionId: 'w-shared' })

  const stats = await scheduler.tick()
  // 关键证据：11 个 run（含注册里额外的？不，正好 10 个）只发一次 wake。
  A.equal(calls.wake.length, 1, '10 个 run 同 waker 只发 1 次唤醒')
  A.equal(calls.wake[0].ctx.wakerSessionId, 'w-shared')
  A.deepEqual(calls.wake[0].ctx.runIds.slice().sort(), runIds.slice().sort(), '一次唤醒带上全部 runId')
  A.equal(stats.runs, 10)
  A.equal(stats.woken, 10, '10 个 run 全部算被唤醒（不是丢弃）')
  A.equal(stats.failed, 0)

  // 每条都真的推进了（若被丢弃，wakes 会停在 0、nextDueAt 不会动）。
  for (const runId of runIds) {
    A.equal(scheduler.status(runId).wakes, 1, `${runId} 不能被丢`)
    A.equal(scheduler.status(runId).nextDueAt, clock.iso(180))
    A.equal(store.get(runId).wakes, 1)
    A.equal(store.get(runId).nextDueAt, clock.iso(180))
  }

  const snapshot = scheduler.snapshot()
  A.equal(snapshot.coalesced, 9, '9 个 run 被合并进同一次唤醒')
  A.equal(snapshot.throttled, 0)
  // wokenThisHour 数的是「真的发出去的唤醒次数」（预算口径）：10 个 run 合并后是 1。
  A.equal(snapshot.wokenThisHour, 1)
  A.equal(snapshot.waker.hourlyLimit, SUPERVISION_WAKER_HOURLY_LIMIT)
  A.equal(snapshot.waker.minIntervalMs, SUPERVISION_WAKER_MIN_INTERVAL_MS)
  A.equal(snapshot.waker.sessions.length, 1)
  A.equal(snapshot.waker.sessions[0].sessionId, 'w-shared')
  A.equal(snapshot.waker.sessions[0].coalesced, 9)
  A.equal(snapshot.waker.sessions[0].wokenThisHour, 1, '预算口径：合并后只算 1 次唤醒')
  A.equal(typeof snapshot.waker.sessions[0].lastWokeAt, 'string')
  A.equal(
    snapshot.entries.reduce((sum, entry) => sum + entry.coalesced, 0),
    9,
    '每条 entry 的 coalesced 合计等于被合并数',
  )

  // 同一 due 不会因为合并把后续 tick 变成重复唤醒。
  await scheduler.tick()
  A.equal(calls.wake.length, 1, '同一 nextDueAt 只唤醒一次')
})

await check('Scheduler(G7-a)：小时预算可注入；被限流的 run 保留 due、计数可见、不算失败不降级', async () => {
  const clock = createClock()
  const store = createStore()
  const { scheduler, calls } = createScheduler({
    clock,
    store,
    wakerHourlyLimit: 2,
    wakerMinIntervalMs: 0,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
  })
  scheduler.register('r-budget', { wakerSessionId: 'w-budget' })
  await scheduler.tick()
  A.equal(calls.wake.length, 1)
  clock.advance(180)
  await scheduler.tick()
  A.equal(calls.wake.length, 2)

  // 第 3 次到点：预算已满 → 限流；run 不许丢（due 保留在 ≤ now）。
  clock.advance(180)
  await scheduler.tick()
  A.equal(calls.wake.length, 2, '预算满后不得再发唤醒')
  const throttled = scheduler.status('r-budget')
  A.equal(throttled.wakes, 2)
  A.equal(throttled.enabled, true, '限流不是失败，不能降级')
  A.equal(throttled.failures, 0)
  const entry = scheduler.snapshot().entries[0]
  A.equal(entry.lastOutcome, 'throttled')
  A.match(entry.lastReason, /^throttled: /)
  A.match(entry.lastReason, /hourly-limit/)
  A.equal(entry.throttled, 1)
  A.equal(scheduler.snapshot().throttled, 1)
  A.ok(Date.parse(entry.nextDueAt) <= clock.ms, '被限流后 nextDueAt 仍 ≤ now（下一轮还会再来）')

  // 推荐继续 tick（不推进时钟）：预算仍然满，但 run 依旧不丢。
  await scheduler.tick()
  A.equal(calls.wake.length, 2)
  A.equal(scheduler.status('r-budget').wakes, 2)
  A.equal(scheduler.snapshot().throttled, 2, '每轮都会记一次限流')

  // 窗口滚过一小时 → 预算恢复，同一个 run 被补上。
  clock.advance(3600)
  await scheduler.tick()
  A.equal(calls.wake.length, 3, '窗口滚过后恢复唤醒')
  A.equal(scheduler.status('r-budget').wakes, 3)
  A.equal(scheduler.status('r-budget').failures, 0)
  A.equal(store.get('r-budget').wakes, 3)
})

await check('Scheduler(G7-a)：最小唤醒间隔（默认 120s）生效，间隔到了才能再唤醒', async () => {
  const clock = createClock()
  const { scheduler, calls } = createScheduler({
    clock,
    evaluate: async () => ({ verdict: 'stalled', run: { status: 'running', startedAt: clock.iso(-200) } }),
  })
  scheduler.register('r-gap', { wakerSessionId: 'w-gap' })
  await scheduler.tick()
  A.equal(calls.wake.length, 1)

  clock.advance(60) // anomaly 间隔 60s → 已到点，但距上次唤醒只有 60s < 120s
  await scheduler.tick()
  A.equal(calls.wake.length, 1, '最小间隔内不得再叫')
  A.equal(scheduler.snapshot().entries[0].lastOutcome, 'throttled')
  A.match(scheduler.snapshot().entries[0].lastReason, /min-interval\(\d+ms\)/)

  clock.advance(60) // 距上次唤醒 120s，满足最小间隔
  await scheduler.tick()
  A.equal(calls.wake.length, 2)
  A.equal(scheduler.status('r-gap').wakes, 2)

  A.equal(SUPERVISION_WAKER_MIN_INTERVAL_MS, 120_000)
  A.equal(SUPERVISION_WAKER_HOURLY_LIMIT, 30)
  A.equal(scheduler.wakerMinIntervalMs, 120_000)
  A.equal(scheduler.wakerHourlyLimit, 30)
})

await check('Scheduler(G7-a)：整组被限流时每个 run 都保留 due（不丢），窗口滚过后整组补一次合并唤醒', async () => {
  const clock = createClock()
  const { scheduler, calls } = createScheduler({
    clock,
    wakerHourlyLimit: 1,
    wakerMinIntervalMs: 0,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
  })
  const runIds = ['r-grp-1', 'r-grp-2', 'r-grp-3']
  for (const runId of runIds) scheduler.register(runId, { wakerSessionId: 'w-grp' })

  await scheduler.tick()
  A.equal(calls.wake.length, 1, '整组只发 1 次')
  A.deepEqual(calls.wake[0].ctx.runIds.slice().sort(), runIds.slice().sort())
  A.equal(scheduler.snapshot().coalesced, 2)

  // 下一轮到点：预算（1 次/小时）已满 → 整组限流，但三个 run 都还在。
  clock.advance(180)
  await scheduler.tick()
  A.equal(calls.wake.length, 1, '预算满时整组都不发')
  for (const runId of runIds) {
    A.equal(scheduler.status(runId).wakes, 1, `${runId} 保留在调度里（wakes 不变、不降级）`)
    A.equal(scheduler.status(runId).enabled, true)
  }
  A.equal(scheduler.snapshot().throttled, 3, '整组 3 条各记一次限流')
  A.equal(
    scheduler.snapshot().entries.filter(entry => entry.lastOutcome === 'throttled').length,
    3,
  )

  // 窗口滚过一小时 → 整组再合并成一次唤醒。
  clock.advance(3600)
  await scheduler.tick()
  A.equal(calls.wake.length, 2, '窗口滚过后整组补一次唤醒')
  A.deepEqual(calls.wake[1].ctx.runIds.slice().sort(), runIds.slice().sort())
  for (const runId of runIds) A.equal(scheduler.status(runId).wakes, 2)
  A.equal(scheduler.snapshot().coalesced, 4, '合并计数累计（2 + 2）')
  A.equal(scheduler.snapshot().wokenThisHour, 1, '窗口内只剩本轮这 1 次唤醒（3 个 run 合并）')
})

await check('Scheduler(G7-a)：不同 wakerSessionId / 没有 waker 的 run 各自唤醒，不误合并', async () => {
  const clock = createClock()
  const { scheduler, calls } = createScheduler({
    clock,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
  })
  scheduler.register('r-w1', { wakerSessionId: 'w-1' })
  scheduler.register('r-w2', { wakerSessionId: 'w-2' })
  scheduler.register('r-no-waker-1')
  scheduler.register('r-no-waker-2')

  const stats = await scheduler.tick()
  A.equal(calls.wake.length, 4, '不同会话 / 无 waker 不能合并')
  A.equal(stats.woken, 4)
  A.equal(scheduler.snapshot().coalesced, 0)
  A.deepEqual(calls.wake.map(call => call.runId).sort(), ['r-no-waker-1', 'r-no-waker-2', 'r-w1', 'r-w2'])
})

await check('NodeScheduler(G7-b)：has() 识别已登记（含停摆），recordRecovery 累加进 snapshot.recovery 且不动 status/list', async () => {
  const clock = createClock()
  const { scheduler } = createNodeScheduler({ clock })
  A.equal(scheduler.has('s1'), false)
  A.equal(scheduler.has(''), false)
  A.equal(scheduler.has(null), false)
  A.equal(scheduler.snapshot().recovery.restored, 0, '默认恢复统计为 0')

  scheduler.register({ runId: 'r1', nodeId: 'n1', sessionId: 's1', attempt: 1 })
  A.equal(scheduler.has('s1'), true)

  const first = scheduler.recordRecovery({
    runsScanned: 2,
    runsRecovered: 1,
    restored: 3,
    skipped: 2,
    skippedTerminal: 1,
    missingSession: 1,
    missingAttempt: 2,
    alreadyRegistered: 0,
  })
  A.equal(first.scans, 1)
  A.equal(first.restored, 3)
  A.equal(first.missingSession, 1)
  A.equal(typeof first.at, 'string')

  // 幂等语义：第二次恢复 0 条，累计值不变（只增加 scans）。
  const second = scheduler.recordRecovery({ restored: 0, skipped: 0 })
  A.equal(second.restored, 3)
  A.equal(second.scans, 2)
  A.equal(second.missingAttempt, 2)

  const snapshot = scheduler.snapshot()
  A.equal(snapshot.recovery.restored, 3)
  A.deepEqual(Object.keys(snapshot.recovery), [
    'at', 'scans', 'runsScanned', 'runsRecovered', 'restored', 'skipped',
    'skippedTerminal', 'missingSession', 'missingAttempt', 'alreadyRegistered',
  ])
  // status / list 的 9 字段契约不变，recovery 只出现在 snapshot 里。
  A.equal(Object.keys(scheduler.status('s1')).length, 9)
  A.equal(Object.keys(scheduler.list()[0]).length, 9)
  A.equal(scheduler.status('s1').recovery, undefined)
})

// ---------------------------------------------------------------------------
// 9.11 E1-a · snapshot 契约（只读、字段齐全、不改 status）
// ---------------------------------------------------------------------------

await check('Scheduler(E1-a)：snapshot 只读、字段齐全，status() 契约不变（5 字段）', async () => {
  const clock = createClock()
  const { scheduler } = createScheduler({
    clock,
    evaluate: async () => ({ verdict: 'healthy', run: { status: 'running', startedAt: clock.iso(-200) } }),
  })

  A.equal(typeof SUPERVISION_WAKE_TIMEOUT_MS, 'number')
  A.equal(SUPERVISION_WAKE_TIMEOUT_MS, 60_000)
  A.equal(SUPERVISION_MAX_CONCURRENCY, 4)

  A.deepEqual(scheduler.snapshot(), {
    kind: 'run',
    ticking: false,
    started: false,
    intervalMs: 1000,
    maxConcurrency: 4,
    wakeTimeoutMs: 60_000,
    // G7-a 新增（只增不改）：按发起会话合并唤醒 / 预算的可观测字段。
    wokenThisHour: 0,
    throttled: 0,
    coalesced: 0,
    waker: { hourlyLimit: 30, minIntervalMs: 120_000, sessions: [] },
    concurrency: { limit: 4, active: 0 },
    tick: {
      count: 0,
      skipped: 0,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastDurationMs: null,
      lastStats: null,
    },
    entries: [],
  })

  scheduler.register(RUN_ID)
  await scheduler.tick()
  const snapshot = scheduler.snapshot()
  A.equal(snapshot.entries.length, 1)
  A.deepEqual(Object.keys(snapshot.entries[0]), [
    'runId',
    'enabled',
    'nextDueAt',
    'wakes',
    'failures',
    'lastReason',
    'lastOutcome',
    'lastDurationMs',
    'lastFinishedAt',
    'timeouts',
    'lastError',
    'throttled',
    'coalesced',
  ])
  A.deepEqual(
    Object.keys(scheduler.status(RUN_ID)),
    ['enabled', 'nextDueAt', 'wakes', 'failures', 'lastReason'],
    'status() 仍然只有 5 个字段',
  )

  // 快照是每次现算的新对象：改它不影响内部状态
  snapshot.entries[0].wakes = 99
  snapshot.concurrency.active = 99
  A.equal(scheduler.snapshot().entries[0].wakes, 1)
  A.equal(scheduler.snapshot().concurrency.active, 0)
})

console.log(`\nsupervise 自检：${checks} 组通过（${assertionCount} 条断言）`)
