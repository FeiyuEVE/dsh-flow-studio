#!/usr/bin/env node
/**
 * 运行时注册表自检（07-runtime-0.7.md §5 / §8，R3：并发不设上限、按 run 一实例）。
 *
 * 全部走注入桩：不启动 dsh、不 import 任何 dsh 包。run 目录落在项目 `.tmp/`
 * 下（不占系统 /tmp）。
 *
 * 覆盖：同 runtime 并发两个 run（各一个 Engine 实例）、同 runId 二次 start → 409、
 * 一个 run 失败不影响另一个、nodeSessionId 稳定性 / 唯一性 / 字符集（含中文 id）、
 * 收尾后从注册表摘除、跨 run 共享 sessionIndex。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-runtime-'))

const runtimeModule = await import('../src/runtime.js')
const engineModule = await import('../src/engine.js')
const store = await import('../src/runstore.js')
const flowStore = await import('../src/store.js')
const superviseModule = await import('../src/supervise.js')

const { createRuntime, nodeSelfCheckPrompt } = runtimeModule
const { SupervisionScheduler } = superviseModule
const {
  Engine, EngineError, nodeSessionId, NODE_SESSION_ID_MAX,
} = engineModule

const runsRoot = store.runsDir(home)
const flowsRoot = flowStore.flowsDir(home)

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
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

function stage(id, title, x, extra = {}) {
  return {
    id,
    kind: 'stage',
    title,
    x,
    y: 200,
    mode: 'single',
    role: '',
    task: `${title} 的任务`,
    outputs: `${title} 的产物`,
    skills: [],
    maxRounds: 2,
    team: [],
    model: '',
    ...extra,
  }
}

function flowOf(id, nodes, edges) {
  return {
    schemaVersion: 1,
    id,
    name: `流程 ${id}`,
    description: '',
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    nodes,
    edges,
  }
}

function startNode() {
  return {
    id: 'n_start', kind: 'start', title: '任务输入', x: 0, y: 200,
    mode: 'single', role: '', task: '接任务', outputs: '', skills: [], maxRounds: 2, team: [], model: '',
  }
}

function endNode() {
  return {
    id: 'n_end', kind: 'end', title: '完成', x: 900, y: 200,
    mode: 'single', role: '', task: '', outputs: '', skills: [], maxRounds: 2, team: [], model: '',
  }
}

function next(id, from, to) {
  return { id, from, to, kind: 'next', label: '' }
}

function oneStageFlow(id, nodeId = 'n_a') {
  return flowOf(id, [startNode(), stage(nodeId, '实现', 300), endNode()], [
    next('e1', 'n_start', nodeId),
    next('e2', nodeId, 'n_end'),
  ])
}

async function saveFlow(flow) {
  return flowStore.saveFlow(flowsRoot, flow.id, flow)
}

async function makeRun(flowId, nodeTotal = 1) {
  return store.createRun(runsRoot, { flowId, flowName: `流程 ${flowId}`, nodeTotal })
}

function structuredPass(nodeId) {
  return {
    verdict: 'pass',
    summary: `${nodeId} 通过`,
    artifacts: [{ name: `${nodeId}-结论.md`, content: `# ${nodeId}\n` }],
    findings: [],
    checks: { ruleSetId: 'rules', ruleSetVersion: '1', executor: 'test', passedChecks: 1, totalChecks: 1 },
    acceptance: [{ itemId: 'R1', status: 'pass', decidedBy: 'auto' }],
    tests: { suite: 'unit', executed: 1, passed: 1, failed: 0, skipped: 0 },
  }
}

function passResult(nodeId, extra = {}) {
  return {
    structured: { ...structuredPass(nodeId), ...extra },
    sessionId: `sess-${nodeId}`,
    dispose: async () => {},
  }
}

function deferred() {
  let resolveFn
  let rejectFn
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolveFn = resolvePromise
    rejectFn = rejectPromise
  })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

/** 等到条件成立（run 的循环是异步推进的，start 返回时未必已经走到 activate）。 */
async function until(predicate, message = '等待条件超时', timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
  }
}

try {
  // -------------------------------------------------------------------------
  console.log('runtime · 并发不设上限（R3）')

  await check('同一个 runtime 起两个不同 runId：两个 Engine 实例并发跑通', async () => {
    await saveFlow(oneStageFlow('flow-rt-two'))
    const runA = await makeRun('flow-rt-two')
    const runB = await makeRun('flow-rt-two')
    const gate = deferred()
    const entered = []
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      activate: async ({ node, runId }) => {
        entered.push(runId)
        await gate.promise
        return passResult(node.id)
      },
    })
    await Promise.all([runtime.start(runA.id), runtime.start(runB.id)])
    await until(() => entered.length === 2, '两个 run 没有同时进入执行')

    // 两个 run 同时在跑：注册表里两个不同实例。
    A.equal(runtime.list().length, 2)
    const engineA = runtime.get(runA.id)
    const engineB = runtime.get(runB.id)
    A.ok(engineA instanceof Engine)
    A.ok(engineB instanceof Engine)
    A.ok(engineA !== engineB, '两个 run 各一个 Engine 实例')
    A.equal(engineA.active && engineA.active.runId, runA.id)
    A.equal(engineB.active && engineB.active.runId, runB.id)
    A.deepEqual(entered.slice().sort(), [runA.id, runB.id].sort(), '两个 run 都真正进入执行')

    gate.resolve()
    const [metaA, metaB] = await Promise.all([runtime.wait(runA.id), runtime.wait(runB.id)])
    A.equal(metaA.status, 'done')
    A.equal(metaB.status, 'done')
    // 收尾后注册表清空（实例收尾回调，不轮询）。
    A.deepEqual(runtime.list(), [])
  })

  await check('同一个 runId 二次 start → 409，文案含「已在运行」；另一个 runId 不受影响', async () => {
    await saveFlow(oneStageFlow('flow-rt-dup'))
    const runA = await makeRun('flow-rt-dup')
    const runB = await makeRun('flow-rt-dup')
    const gate = deferred()
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => {
        await gate.promise
        return passResult(node.id)
      },
    })
    await runtime.start(runA.id)
    let caught = null
    try {
      await runtime.start(runA.id)
    } catch (error) {
      caught = error
    }
    A.ok(caught instanceof EngineError)
    A.equal(caught.status, 409)
    A.match(caught.message, /已在运行/)
    A.ok(caught.message.includes(runA.id), '409 文案带上 runId')
    // 不同 runId 不受「同 runId」限制。
    await runtime.start(runB.id)
    A.equal(runtime.list().length, 2)
    gate.resolve()
    A.equal((await runtime.wait(runA.id)).status, 'done')
    A.equal((await runtime.wait(runB.id)).status, 'done')
  })

  await check('一个 run 失败不影响另一个：failed 的实例摘除，另一个照常 done', async () => {
    await saveFlow(oneStageFlow('flow-rt-fail'))
    const runFail = await makeRun('flow-rt-fail')
    const runOk = await makeRun('flow-rt-fail')
    const gate = deferred()
    let failCalls = 0
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      nodeRetries: 0,
      activate: async ({ node, runId }) => {
        if (runId === runFail.id) {
          failCalls += 1
          throw new Error('子 agent 崩溃（失败用例）')
        }
        await gate.promise
        return passResult(node.id)
      },
    })
    await Promise.all([runtime.start(runFail.id), runtime.start(runOk.id)])
    const failed = await runtime.wait(runFail.id)
    A.equal(failed.status, 'failed')
    A.equal(failCalls, 1)
    A.equal(runtime.get(runFail.id), null, '失败实例已从注册表摘除')
    // 另一个 run 完全不受影响：仍在跑（gate 还没放），实例还在表里。
    const stillRunning = runtime.get(runOk.id)
    A.ok(stillRunning instanceof Engine)
    A.equal(stillRunning.active && stillRunning.active.runId, runOk.id)
    gate.resolve()
    A.equal((await runtime.wait(runOk.id)).status, 'done')
    A.deepEqual(runtime.list(), [])
  })

  await check('stop / wait / get 按 runId 路由；不在跑时 stop 409、wait 读 run.json', async () => {
    await saveFlow(oneStageFlow('flow-rt-route'))
    const run = await makeRun('flow-rt-route')
    const gate = deferred()
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      activate: async ({ node, signal }) => {
        await new Promise((resolvePromise, rejectPromise) => {
          gate.promise.then(resolvePromise)
          signal.addEventListener('abort', () => {
            const error = new Error('已中止')
            error.name = 'AbortError'
            rejectPromise(error)
          }, { once: true })
        })
        return passResult(node.id)
      },
    })
    await runtime.start(run.id)
    A.equal(runtime.get(run.id).active.runId, run.id)
    const stopped = await runtime.stop(run.id)
    A.equal(stopped.status, 'aborted')
    // 收尾后实例摘除：stop 再调 → 409；wait 仍能读到终态。
    let caught = null
    try {
      await runtime.stop(run.id)
    } catch (error) {
      caught = error
    }
    A.ok(caught instanceof EngineError)
    A.equal(caught.status, 409)
    A.equal((await runtime.wait(run.id)).status, 'aborted')
    gate.resolve()
  })

  // -------------------------------------------------------------------------
  console.log('runtime · nodeSessionId（07 §3.2）')

  await check('稳定：同一 (runId,nodeId) 的不同 attempt 返回同一个 id', () => {
    A.equal(nodeSessionId('r-abc-1234', 'n_a', 1), nodeSessionId('r-abc-1234', 'n_a', 2))
    A.equal(nodeSessionId('r-abc-1234', 'n_a', 1), nodeSessionId('r-abc-1234', 'n_a', 9))
    A.equal(nodeSessionId('r-abc-1234', '需求节点', 1), nodeSessionId('r-abc-1234', '需求节点', 3))
    // 不同 run / 不同节点必须不同。
    A.ok(nodeSessionId('r-abc-1234', 'n_a', 1) !== nodeSessionId('r-abc-9999', 'n_a', 1))
    A.ok(nodeSessionId('r-abc-1234', 'n_a', 1) !== nodeSessionId('r-abc-1234', 'n_b', 1))
  })

  await check('字符集：只含 [A-Za-z0-9._-]（中文 / 空格 / 斜杠 / emoji / 超长 id）', () => {
    const cases = [
      ['r-abc-1234', 'n_a'],
      ['r-abc-1234', '需求评审'],
      ['r-abc-1234', '需求 / 评审 v2'],
      ['r-abc-1234', 'a b'],
      ['r-abc-1234', 'a/b'],
      ['r-abc-1234', '../etc/passwd'],
      ['r-abc-1234', '😀节点😀'],
      ['r-abc-1234', '长'.repeat(300)],
      ['run.中文.1', '...'],
    ]
    for (const [runId, nodeId] of cases) {
      const id = nodeSessionId(runId, nodeId, 1)
      A.match(id, /^[A-Za-z0-9._-]+$/, `id 必须只含安全字符：${id}`)
      A.ok(id.length > 0)
      A.ok(id.length <= NODE_SESSION_ID_MAX, `id 长度 ${id.length} ≤ ${NODE_SESSION_ID_MAX}`)
      A.equal(id, nodeSessionId(runId, nodeId, 2), 'attempt 不进 id')
    }
  })

  await check('唯一：slug 化冲突 / 中文节点 / 截断都不会碰撞', () => {
    // 「a b」与「a/b」slug 化后相同 → 靠内容哈希区分。
    A.ok(nodeSessionId('r-x', 'a b') !== nodeSessionId('r-x', 'a/b'))
    // 纯中文节点：slug 为空 → 回退 + 哈希，不同中文节点不同 id。
    A.ok(nodeSessionId('r-x', '需求') !== nodeSessionId('r-x', '评审'))
    // 长 id 共享前缀：截断后仍靠哈希区分。
    const longA = `n_${'a'.repeat(200)}`
    const longB = `n_${'a'.repeat(199)}b`
    A.ok(nodeSessionId('r-x', longA) !== nodeSessionId('r-x', longB))
    // 全量枚举一段小集合：两两不重复。
    const ids = new Set([
      nodeSessionId('r-x', '需求'), nodeSessionId('r-x', '评审'),
      nodeSessionId('r-x', 'a b'), nodeSessionId('r-x', 'a/b'),
      nodeSessionId('r-x', 'a_b'), nodeSessionId('r-x', 'a.b'),
      nodeSessionId('r-y', '需求'), nodeSessionId('r-y', '评审'),
    ])
    A.equal(ids.size, 8)
  })

  // -------------------------------------------------------------------------
  console.log('runtime · 跨 run 共享 sessionIndex（07 §3.3）')

  await check('两个实例共享同一个 sessionIndex：A 的会话能在 B 的引擎里反查回 A', async () => {
    await saveFlow(oneStageFlow('flow-rt-index'))
    const runA = await makeRun('flow-rt-index')
    const runB = await makeRun('flow-rt-index')
    const gate = deferred()
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      activate: async ({ node, runId, attempt }) => {
        await gate.promise
        return {
          structured: structuredPass(node.id),
          sessionId: nodeSessionId(runId, node.id, attempt),
          dispose: async () => {},
        }
      },
    })
    await Promise.all([runtime.start(runA.id), runtime.start(runB.id)])
    const engineA = runtime.get(runA.id)
    const engineB = runtime.get(runB.id)
    A.ok(engineA instanceof Engine)
    A.ok(engineB instanceof Engine)
    // 同一个 Map（不是各自一份）。
    A.ok(engineA.sessionIndex === runtime.sessionIndex)
    A.ok(engineB.sessionIndex === runtime.sessionIndex)
    A.ok(engineA.sessionIndex === engineB.sessionIndex)

    gate.resolve()
    await Promise.all([runtime.wait(runA.id), runtime.wait(runB.id)])

    const sessionA = nodeSessionId(runA.id, 'n_a', 1)
    const sessionB = nodeSessionId(runB.id, 'n_a', 1)
    const ownerA = runtime.sessionIndex.get(sessionA)
    const ownerB = runtime.sessionIndex.get(sessionB)
    A.ok(Boolean(ownerA), 'run A 的节点会话已登记')
    A.ok(Boolean(ownerB), 'run B 的节点会话已登记')
    A.equal(ownerA.runId, runA.id)
    A.equal(ownerB.runId, runB.id)
    A.equal(ownerA.nodeId, 'n_a')
    A.equal(ownerA.firstAttempt, 1)
    A.equal(ownerA.lastAttempt, 1)
    A.equal(typeof ownerA.createdAt, 'string')

    // 用 B 引擎（已收尾）反查 A 的会话：共享索引让 A 的归属在 B 实例里也可见。
    const resolvedA = await engineB.resolveSessionOwner(sessionA)
    A.deepEqual({ runId: resolvedA.runId, nodeId: resolvedA.nodeId }, { runId: runA.id, nodeId: 'n_a' })
    // 反向也成立。
    const resolvedB = await engineA.resolveSessionOwner(sessionB)
    A.deepEqual({ runId: resolvedB.runId, nodeId: resolvedB.nodeId }, { runId: runB.id, nodeId: 'n_a' })
    A.ok(engineA.sessionIndex.size >= 2)
  })

  await check('跨 run 共享 sessionIndex：不同节点 / 不同 run 的条目都保留，互不覆盖', async () => {
    await saveFlow(oneStageFlow('flow-rt-index2', 'n_a'))
    const runA = await makeRun('flow-rt-index2')
    const runB = await makeRun('flow-rt-index2')
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      // 每个 run 的每个节点拿到独立 sessionId（模拟 agents.create 的稳定 id）。
      activate: async ({ node, runId, attempt }) => ({
        structured: structuredPass(node.id),
        sessionId: nodeSessionId(runId, node.id, attempt),
        dispose: async () => {},
      }),
    })
    await Promise.all([runtime.start(runA.id), runtime.start(runB.id)])
    await Promise.all([runtime.wait(runA.id), runtime.wait(runB.id)])

    const idA = nodeSessionId(runA.id, 'n_a', 1)
    const idB = nodeSessionId(runB.id, 'n_a', 1)
    A.ok(idA !== idB)
    const ownerA = runtime.sessionIndex.get(idA)
    const ownerB = runtime.sessionIndex.get(idB)
    A.ok(Boolean(ownerA) && Boolean(ownerB), '两个 run 的会话条目都在共享索引里')
    A.equal(ownerA.runId, runA.id)
    A.equal(ownerB.runId, runB.id)
    A.equal(ownerA.nodeId, 'n_a')
    A.equal(ownerB.nodeId, 'n_a')
    A.equal(ownerA.firstAttempt, 1)
    A.equal(ownerA.lastAttempt, 1)
  })

  // -------------------------------------------------------------------------
  console.log('runtime · 构造签名向后兼容')

  await check('createEngine / new Engine 的旧用法不受影响（新增字段全部可选）', () => {
    const viaFactory = engineModule.createEngine({ runsRoot, flowsRoot, stub: true })
    const viaClass = new Engine({ runsRoot, flowsRoot, stub: true })
    A.ok(viaFactory instanceof Engine)
    A.ok(viaClass instanceof Engine)
    A.equal(viaFactory.active, null)
    A.equal(viaClass.active, null)
    // 不注入 sessionIndex / startedBy 时用实例内 Map 兜底。
    A.ok(viaFactory.sessionIndex instanceof Map)
    A.ok(viaFactory.startedBy instanceof Map)
    A.ok(viaFactory.sessionIndex !== viaClass.sessionIndex)
    viaFactory.dispose()
    viaClass.dispose()
  })
  // -------------------------------------------------------------------------
  console.log('runtime · Engine 门面（v0.7）')

  await check('engineName 透传 stub / real（与 Engine 同一口径）', () => {
    const real = createRuntime({ runsRoot, flowsRoot, stub: false })
    const stubRuntime = createRuntime({ runsRoot, flowsRoot, stub: true })
    const auto = createRuntime({ runsRoot, flowsRoot })
    const engine = new Engine({ runsRoot, flowsRoot, stub: true })
    A.equal(real.engineName, 'real')
    A.equal(stubRuntime.engineName, 'stub')
    A.equal(stubRuntime.engineName, engine.engineName, '与 Engine 口径一致')
    A.equal(auto.engineName, process.env.FLOW_STUDIO_STUB_ENGINE === '1' ? 'stub' : 'real')
    // 门面不再提供 active（07 §5：并发不设上限，没有「单引擎」语义）。
    A.equal(Object.hasOwn(real, 'active'), false)
    A.equal(typeof real.sweepStaleRuns, 'function')
    real.dispose()
    stubRuntime.dispose()
    auto.dispose()
    engine.dispose()
  })

  await check('resolveSessionOwner / runForSession 读共享 sessionIndex', async () => {
    await saveFlow(oneStageFlow('flow-rt-facade'))
    const run = await makeRun('flow-rt-facade')
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      activate: async ({ node, runId, attempt }) => ({
        structured: structuredPass(node.id),
        sessionId: nodeSessionId(runId, node.id, attempt),
        dispose: async () => {},
      }),
    })
    await runtime.start(run.id)
    A.equal((await runtime.wait(run.id)).status, 'done')

    const sessionId = nodeSessionId(run.id, 'n_a', 1)
    const owner = await runtime.resolveSessionOwner(sessionId)
    A.ok(owner, '会话归属要能从共享 sessionIndex 读到')
    A.equal(owner.runId, run.id)
    A.equal(owner.nodeId, 'n_a')
    A.equal(owner.firstAttempt, 1)
    A.equal(runtime.runForSession(sessionId), run.id)
    // 查不到就是 null（不抛错）。
    A.equal(await runtime.resolveSessionOwner('sess-not-ours'), null)
    A.equal(runtime.runForSession('sess-not-ours'), null)
    runtime.dispose()
  })

  await check('sweepStaleRuns = sweep：崩溃残留（running 且超时无事件）被标 failed', async () => {
    await saveFlow(oneStageFlow('flow-rt-sweep'))
    const stale = await makeRun('flow-rt-sweep')
    await store.writeRunMeta(runsRoot, stale.id, {
      status: 'running',
      started: true,
      startedAt: '2020-01-01T00:00:00.000Z',
    })
    // staleMs=1：创建时间（createdAt）早于 cutoff → 判定为崩溃残留。
    const runtime = createRuntime({ runsRoot, flowsRoot, staleMs: 1 })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    const recovered = await runtime.sweepStaleRuns()
    A.ok(recovered.includes(stale.id), `sweepStaleRuns 应标出 ${stale.id}（实际 ${recovered.join(',')}）`)
    A.equal((await store.readRunMeta(runsRoot, stale.id)).status, 'failed')
    // 第二轮没有残留：与 sweep() 同一实现。
    A.deepEqual(await runtime.sweep(), [])
    runtime.dispose()
  })

  await check('start(runId, {parent, workspace, worktree}) 原样转发给 Engine.start', async () => {
    const seen = []
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      createEngine: () => ({
        async start(runId, options) {
          seen.push({ runId, options })
          return { id: runId, status: 'running' }
        },
        async stop() { return {} },
        async wait() { return {} },
        async sweepStaleRuns() { return [] },
        dispose() {},
      }),
    })
    const parent = { session: { id: 's-parent' } }
    await runtime.start('r-facade-1', { parent, workspace: '/repo/x', worktree: 'on' })
    A.equal(seen.length, 1)
    A.deepEqual(seen[0].options, { parent, workspace: '/repo/x', worktree: 'on' })
    runtime.dispose()
  })

  await check('supervision 接线：暴露唯一调度器、重启恢复登记、收尾落盘 terminal', async () => {
    await saveFlow(oneStageFlow('flow-rt-sup'))
    const run = await makeRun('flow-rt-sup')
    // 模拟「重启前已开启 supervision」的 run.json（supervision 已进 runstore 白名单）。
    await store.writeRunMeta(runsRoot, run.id, {
      supervision: { enabled: true, wakerSessionId: 'sess-waker', wakes: 3 },
    })
    // 对照组：pending 但没有 supervision 记录 → 不该被恢复登记（否则会连续唤醒失败刷噪音）。
    const noWaker = await makeRun('flow-rt-sup')
    // 另一个对照组：开启了但没有 wakerSessionId → 同样跳过。
    const noSession = await makeRun('flow-rt-sup')
    await store.writeRunMeta(runsRoot, noSession.id, { supervision: { enabled: true, wakes: 1 } })
    const noopInterval = () => ({ unref() {} })
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      setInterval: noopInterval,
      clearInterval: () => {},
      activate: async ({ node }) => passResult(node.id),
    })
    A.ok(runtime.supervision instanceof SupervisionScheduler, 'runtime.supervision 是唯一调度器实例')
    const registered = await runtime.supervisionReady
    A.ok(registered.includes(run.id), 'pending 且已开启 + 有 wakerSessionId 的 run 重启后自动登记')
    A.equal(runtime.supervision.status(run.id).enabled, true)
    A.equal(registered.includes(noWaker.id), false, '没有 supervision 记录的 run 不恢复登记')
    A.equal(registered.includes(noSession.id), false, '开了但没有 wakerSessionId 的 run 不恢复登记')
    A.equal(runtime.supervision.status(noWaker.id).lastReason, 'not-registered')
    // 跳过不等于禁用：不能偷偷写 enabled:false（用户之后可能手动开）。
    A.equal((await store.readRunMeta(runsRoot, noWaker.id)).supervision, undefined)
    A.equal((await store.readRunMeta(runsRoot, noSession.id)).supervision.enabled, true)

    await runtime.start(run.id)
    A.equal((await runtime.wait(run.id)).status, 'done')
    // 收尾：摘除登记 + run.json.supervision 落 enabled=false / reason=terminal（只合并这一个键）。
    await until(
      () => {
        const status = runtime.supervision.status(run.id)
        return status.enabled === false && status.lastReason === 'not-registered'
      },
      '收尾后调度器没有摘除登记',
    )
    // settleInstance 的 supervision 落盘是异步的（不阻塞引擎收尾）：轮询等它落地。
    let finalMeta = null
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const value = await store.readRunMeta(runsRoot, run.id)
      if (value && value.supervision && value.supervision.enabled === false) {
        finalMeta = value
        break
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
    }
    A.ok(finalMeta, '收尾后没有把 supervision.enabled=false 写进 run.json')
    A.equal(finalMeta.supervision.reason, 'terminal')
    // 只合并 supervision：run.json 的其它字段照旧。
    A.equal((await store.readRunMeta(runsRoot, run.id)).status, 'done')
    runtime.dispose()
    // dispose 后定时器停掉（幂等）。
    A.equal(runtime.supervision.stop(), false)
  })

  await check('enableSupervision(runId, {enabled, wakerSessionId})：单一开关实现（HTTP / flow_start / flow_supervise 共用）', async () => {
    await saveFlow(oneStageFlow('flow-rt-enable'))
    const run = await makeRun('flow-rt-enable')
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
      activate: async ({ node }) => passResult(node.id),
    })
    A.equal(typeof runtime.enableSupervision, 'function')

    // 开启：调度器登记 + run.json.supervision 落盘（wakerSessionId 一起）。
    const on = await runtime.enableSupervision(run.id, { enabled: true, wakerSessionId: 'sess-e' })
    A.equal(on.enabled, true)
    A.equal(on.scheduler.enabled, true)
    A.equal(on.supervision.enabled, true)
    A.equal(on.supervision.wakerSessionId, 'sess-e')
    const metaOn = await store.readRunMeta(runsRoot, run.id)
    A.equal(metaOn.supervision.enabled, true)
    A.equal(metaOn.supervision.wakerSessionId, 'sess-e')

    // 关闭：摘除登记 + 落盘 enabled=false。
    const off = await runtime.enableSupervision(run.id, { enabled: false })
    A.equal(off.enabled, false)
    A.equal(off.supervision.enabled, false)
    A.equal(off.supervision.reason, 'disabled-by-caller')
    A.equal(runtime.supervision.status(run.id).enabled, false)

    // run 不存在 → 404；已收尾还要开 → 400（不登记一个永远不会被唤醒的 run）。
    const missing = await runtime.enableSupervision('r-no-such-run', { enabled: true }).catch(error => error)
    A.equal(missing.status, 404)
    await store.writeRunMeta(runsRoot, run.id, { status: 'done', started: true, endedAt: new Date().toISOString() })
    const terminal = await runtime.enableSupervision(run.id, { enabled: true, wakerSessionId: 'sess-e' })
      .catch(error => error)
    A.equal(terminal.status, 400)
    A.match(terminal.message, /已结束/)
    A.equal(runtime.supervision.status(run.id).enabled, false, '被拒绝的开启不能留下登记')
    runtime.dispose()
  })

  // -------------------------------------------------------------------------
  console.log('runtime · v0.8 节点闹钟（07 §11）')

  await check('wake：会话 idle → agent.followup（payload 走 inbox.buildFollowupPayload）', async () => {
    const sent = []
    const fakeAgent = {
      status: 'idle',
      followup(payload) { sent.push(payload) },
    }
    const agents = { get: () => fakeAgent }
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      ctx: { get: () => agents },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    const result = await runtime.wake({ runId: 'r-node-1', nodeId: 'n_dev', attempt: 2, sessionId: 'sess-node' })
    A.deepEqual(result, { action: 'followup' })
    A.equal(sent.length, 1)
    // payload 必须是 inbox 的结构（不是随手拼的 {text}）。
    A.equal(sent[0].role, 'user')
    A.equal(sent[0].source.kind, 'flow-studio')
    A.equal(sent[0].source.room, 'r-node-1/n_dev')
    A.equal(Array.isArray(sent[0].content), true)
    const prompt = sent[0].content[0].text
    A.match(prompt, /r-node-1/)
    A.match(prompt, /n_dev/)
    A.match(prompt, /attempt=2/)
    runtime.dispose()
  })

  await check('wake：会话 busy → agent.inject（不新开回合，也不调用 followup）', async () => {
    const injected = []
    const followed = []
    const fakeAgent = {
      status: 'busy',
      inject(payload) { injected.push(payload) },
      followup(payload) { followed.push(payload) },
    }
    const agents = { get: () => fakeAgent }
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      ctx: { get: () => agents },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    const result = await runtime.wake({ runId: 'r-node-2', nodeId: 'n_dev', attempt: 1, sessionId: 'sess-node' })
    A.deepEqual(result, { action: 'inject' })
    A.equal(injected.length, 1)
    A.equal(followed.length, 0, 'busy 时不能起新回合')
    runtime.dispose()
  })

  await check('wake：agents 服务不可用 → skip（no-agents-service，不抛错）', async () => {
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      ctx: { get: () => undefined },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    const result = await runtime.wake({ runId: 'r-node-3', nodeId: 'n_dev', attempt: 1, sessionId: 'sess-node' })
    A.deepEqual(result, { action: 'skip', reason: 'no-agents-service' })
    runtime.dispose()
  })

  await check('nodeSelfCheckPrompt：含 runId / nodeId / attempt，要求 ```json 代码块与 verdict', () => {
    const prompt = nodeSelfCheckPrompt({ runId: 'r-node-4', nodeId: 'n_review', attempt: 3 })
    A.match(prompt, /r-node-4/)
    A.match(prompt, /n_review/)
    A.match(prompt, /attempt=3/)
    A.match(prompt, /```json/)
    A.match(prompt, /"state":"working\|done\|blocked\|failed"/)
    A.match(prompt, /verdict/)
    A.match(prompt, /不要谎报完成/)
    A.ok([...prompt].length <= 500, `提示词应简短（当前 ${[...prompt].length} 字）`)
  })

  await check('run 收尾 onSettled → nodeSupervision.unregisterRun(runId)', async () => {
    await saveFlow(oneStageFlow('flow-rt-node-settle'))
    const run = await makeRun('flow-rt-node-settle')
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
      activate: async ({ node }) => passResult(node.id),
    })
    const removed = []
    const original = runtime.nodeSupervision.unregisterRun.bind(runtime.nodeSupervision)
    runtime.nodeSupervision.unregisterRun = runId => {
      removed.push(runId)
      return original(runId)
    }
    await runtime.start(run.id)
    A.equal((await runtime.wait(run.id)).status, 'done')
    A.ok(removed.includes(run.id), `run 收尾必须调 unregisterRun（实际 ${removed.join(',')}）`)
    runtime.dispose()
    A.equal(runtime.nodeSupervision.stop(), false, 'dispose 后节点闹钟定时器已停')
  })

  await check('nodeSupervision 注入每个 Engine 实例（engineDeps.nodeSupervision）', () => {
    const seen = []
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      createEngine: options => {
        seen.push(options.nodeSupervision)
        return {
          async start() { return {} },
          async stop() { return {} },
          async wait() { return {} },
          async sweepStaleRuns() { return [] },
          dispose() {},
        }
      },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    void runtime.start('r-inject-check').catch(() => {})
    A.equal(seen.length, 1)
    A.equal(seen[0], runtime.nodeSupervision)
    runtime.dispose()
  })

} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nruntime §5 自检：${checks} 组通过（${assertionCount} 条断言）`)
