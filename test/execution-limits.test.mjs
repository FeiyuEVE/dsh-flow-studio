#!/usr/bin/env node
/**
 * agent 执行槽位自检（0.13.7 C）：全局 / 每工作区上限、队列容量、排队超时、
 * AbortSignal 取消退队、release 排空队列；取消不泄漏槽位。
 *
 * 运行：node test/execution-limits.test.mjs
 */

import assert from 'node:assert/strict'
const {
  EXECUTION_LIMIT_ERROR, createExecutionLimits,
} = await import('../src/execution-limits.js')

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

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

const tick = () => new Promise(resolveTick => setTimeout(resolveTick, 10))

try {
  await check('全局上限：占满后禁止排队返回 QUEUE_FULL；release 后可以重新获取', async () => {
    const limits = createExecutionLimits({ global: 1, perWorkspace: 1, queueMax: 0 })
    const a = await limits.acquire({ workspaceId: 'ws-a' })
    eq(limits.active, 1, 'active=1')
    await rejectsCode(
      () => limits.acquire({ workspaceId: 'ws-b' }),
      EXECUTION_LIMIT_ERROR.QUEUE_FULL,
      '全局满且 queueMax=0',
    )
    eq(a.release(), true, '首次 release true')
    eq(a.release(), false, '重复 release 幂等 false')
    eq(limits.active, 0, 'release 后 active=0')
    const b = await limits.acquire({ workspaceId: 'ws-b' })
    eq(b.workspaceId, 'ws-b', '释放后新的工作区可以获取')
    b.release()
  })

  await check('每工作区上限：同工作区占满时即使全局有空也 QUEUE_FULL', async () => {
    const limits = createExecutionLimits({ global: 3, perWorkspace: 1, queueMax: 0 })
    const a = await limits.acquire({ workspaceId: 'ws-a' })
    await rejectsCode(
      () => limits.acquire({ workspaceId: 'ws-a' }),
      EXECUTION_LIMIT_ERROR.QUEUE_FULL,
      '同工作区第二个被拒',
    )
    const b = await limits.acquire({ workspaceId: 'ws-b' })
    eq(limits.active, 2, '两个不同工作区各占一个')
    deep(limits.snapshot().workspaces, { 'ws-a': 1, 'ws-b': 1 }, 'snapshot 工作区计数')
    a.release()
    b.release()
    deep(limits.snapshot().workspaces, {}, '全部释放后工作区计数清空')
  })

  await check('排队超时：超时拒绝且不泄漏槽位；释放后队列为空', async () => {
    const limits = createExecutionLimits({ global: 1, perWorkspace: 1, queueMax: 2, queueTimeoutMs: 60 })
    const held = await limits.acquire({ workspaceId: 'ws-a' })
    const queued = limits.acquire({ workspaceId: 'ws-a' })
    eq(limits.queued, 1, '进入队列')
    await rejectsCode(() => queued, EXECUTION_LIMIT_ERROR.QUEUE_TIMEOUT, '排队超时')
    eq(limits.queued, 0, '超时后退队')
    eq(limits.active, 1, 'active 仍是 1（没有泄漏或误释放）')
    held.release()
    eq(limits.active, 0, '持有者释放后归零')
  })

  await check('取消退队：AbortSignal abort 时排队者 CANCELLED，不占槽', async () => {
    const limits = createExecutionLimits({ global: 1, perWorkspace: 1, queueMax: 2, queueTimeoutMs: 5000 })
    const held = await limits.acquire({ workspaceId: 'ws-a' })
    const controller = new AbortController()
    const queued = limits.acquire({ workspaceId: 'ws-a', signal: controller.signal })
    eq(limits.queued, 1, '排队中')
    controller.abort()
    await rejectsCode(() => queued, EXECUTION_LIMIT_ERROR.CANCELLED, 'abort 取消排队')
    eq(limits.queued, 0, '取消后队列为空')
    eq(limits.active, 1, '只占着 held 一个槽')
    held.release()
    eq(limits.active, 0, '释放后归零')
    await rejectsCode(
      () => limits.acquire({ workspaceId: 'ws-a', signal: controller.signal }),
      EXECUTION_LIMIT_ERROR.CANCELLED,
      '已 abort 的 signal 在入队前就拒绝',
    )
  })

  await check('release 排空队列：FIFO 且不会超过上限', async () => {
    const limits = createExecutionLimits({ global: 1, perWorkspace: 1, queueMax: 3, queueTimeoutMs: 5000 })
    const held = await limits.acquire({ workspaceId: 'ws-a' })
    const order = []
    const one = limits.acquire({ workspaceId: 'ws-a' }).then(ticket => { order.push('one'); return ticket })
    const two = limits.acquire({ workspaceId: 'ws-a' }).then(ticket => { order.push('two'); return ticket })
    eq(limits.queued, 2, '两个排队')
    held.release()
    await tick()
    eq(limits.active, 1, '释放后只放行一个')
    const first = await one
    eq(first.workspaceId, 'ws-a', '第一个排队者拿到槽')
    deep(order, ['one'], 'FIFO：先排队的先拿到')
    first.release()
    await tick()
    const second = await two
    deep(order, ['one', 'two'], '第二个随后拿到')
    second.release()
    eq(limits.active, 0, '全部释放')
  })

  await check('实际并发峰值不超过配置（20 个并发申请，上限 3）', async () => {
    const limits = createExecutionLimits({ global: 3, perWorkspace: 3, queueMax: 40, queueTimeoutMs: 5000 })
    let peak = 0
    const tasks = Array.from({ length: 20 }, async (_, index) => {
      const ticket = await limits.acquire({ workspaceId: `ws-${index % 2}` })
      peak = Math.max(peak, limits.active)
      await tick()
      ticket.release()
    })
    await Promise.all(tasks)
    eq(peak, 3, '峰值正好是全局上限')
    eq(limits.active, 0, '全部结束归零')
    eq(limits.queued, 0, '队列排空')
  })

  await check('配置校验：非法值给 EXECUTION_LIMIT_INVALID，environment 旋钮生效', async () => {
    assertions += 1
    assert.throws(() => createExecutionLimits({ global: 0 }), error => error.code === EXECUTION_LIMIT_ERROR.INVALID)
    assertions += 1
    assert.throws(() => createExecutionLimits({ perWorkspace: 'x' }), error => error.code === EXECUTION_LIMIT_ERROR.INVALID)
    const limits = createExecutionLimits({
      env: {
        FLOW_STUDIO_AGENT_GLOBAL: '2',
        FLOW_STUDIO_AGENT_PER_WORKSPACE: '1',
        FLOW_STUDIO_AGENT_QUEUE_MAX: '0',
      },
    })
    eq(limits.global, 2, 'env 全局上限')
    eq(limits.perWorkspace, 1, 'env 每工作区上限')
    eq(limits.queueMax, 0, 'env 队列容量')
  })

  await check('snapshot 形状：queued 带位置和排队时间，不含内部 Promise', async () => {
    const limits = createExecutionLimits({ global: 1, perWorkspace: 1, queueMax: 1, queueTimeoutMs: 5000 })
    const held = await limits.acquire({ workspaceId: 'ws-a' })
    const queued = limits.acquire({ workspaceId: 'ws-a' })
    const snapshot = limits.snapshot()
    eq(snapshot.global, 1, 'snapshot 带配置')
    eq(snapshot.queued.length, 1, 'snapshot 列出排队')
    eq(snapshot.queued[0].position, 1, '排队位置')
    ok(typeof snapshot.queued[0].queuedAt === 'string', '排队时间')
    ok(!('resolve' in snapshot.queued[0]), '不泄漏内部 resolve')
    held.release()
    const ticket = await queued
    ticket.release()
  })

  console.log('execution-limits.test.mjs')
  console.log(`${checks} 组通过（${assertions} 条断言）`)
} catch (error) {
  console.error('✗ 执行槽位自检失败')
  console.error(error)
  process.exit(1)
}
