#!/usr/bin/env node
/**
 * 运行时注册表自检（07-runtime-0.7.md §5 / §8，R3：并发不设上限、按 run 一实例）。
 *
 * 全部走注入桩：不启动 dsh、不 import 任何 dsh 包。run 目录落在项目 `.tmp/`
 * 下（不占系统 /tmp）。
 *
 * 覆盖：同 runtime 并发两个 run（各一个 Engine 实例）、同 runId 二次 start → 409、
 * 一个 run 失败不影响另一个、nodeSessionId 稳定性 / 唯一性 / 字符集（含中文 id）、
 * 收尾后从注册表摘除、跨 run 共享 sessionIndex；以及
 *   E2-a 重启收口（running 无实例 → failed / 幂等 / 不误杀其它进程租约）、
 *   E2-b dispose abort 在飞 Engine + 有界等待 + 定时器清理、
 *   E2-c session/event 归属过滤 + 字节/条数双上限缓冲、
 *   E2-d patchRunJson 走 runstore.writeRunMeta 单一写路径（并发不丢字段 / seq 不回退）；
 *   C2 节点自审凭证：提示词回显 attempt+nonce、无 Engine/凭证时不发、真实 Engine 端到端接受/丢弃。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
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

const { createRuntime: createRuntimeRaw, nodeSelfCheckPrompt } = runtimeModule
const { SupervisionScheduler } = superviseModule
const {
  Engine, EngineError, nodeSessionId, NODE_SESSION_ID_MAX,
} = engineModule

const runsRoot = store.runsDir(home)
const flowsRoot = flowStore.flowsDir(home)

/**
 * 引擎 C3 起 `start()` 必须显式给出工作区（不再回落 process.cwd）；这里统一注入仓库根，
 * 并把 worktree 关掉（不在插件仓库本身真建 worktree）。既有断言不变。
 */
const createRuntime = (options = {}) => createRuntimeRaw({
  runsRoot,
  flowsRoot,
  cwd: repoRoot,
  worktree: 'off',
  ...options,
})

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

/** E2-c：一条会被 Engine 缓冲 / 映射的 session/event（assistant/message）。 */
function assistantEvent(seq, text = `event-${seq}`) {
  return {
    type: 'assistant/message',
    seq,
    data: {
      message: {
        id: `call-${seq}`,
        source: { provider: 'p', model: 'm' },
        content: [{ type: 'text', text }],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  }
}

/** E2-c：写一份 sessions.json（引擎 start 时载入为「已知但尚未绑定」的节点会话）。 */
async function seedNodeSession(runId, nodeId, sessionId) {
  const at = '2026-11-01T00:00:00.000Z'
  await store.writeNodeSessions(runsRoot, runId, {
    [nodeId]: { sessionId, createdAt: at, lastUsedAt: at },
  })
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
    // E2-a 起 createRuntime 会先做一次「重启收口」扫描。先等它跑完，再制造本轮才出现的
    // 崩溃残留——这样断言的是 sweep 自己的 stale 判定，而不是初始化扫描顺手收口。
    const runtime = createRuntime({ runsRoot, flowsRoot, staleMs: 1 })
    await runtime.supervisionReady
    const stale = await makeRun('flow-rt-sweep')
    await store.writeRunMeta(runsRoot, stale.id, {
      status: 'running',
      started: true,
      startedAt: '2020-01-01T00:00:00.000Z',
    })
    // staleMs=1：创建时间（createdAt）早于 cutoff → 判定为崩溃残留。
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
    // C2：wakeNode 要从本 run 的 Engine 取本轮 attempt/nonce 凭证，否则不发。
    runtime.runs.set('r-node-1', {
      attemptEnvelopeFor: () => ({ attempt: 2, nodeId: 'n_dev', nonce: 'NONCE-node-1-abc' }),
      dispose() {},
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
    // C2：提示词必须带真实 nonce，并在 JSON 示例里给出字段名。
    A.ok(prompt.includes('nonce=NONCE-node-1-abc'), '提示词要含真实 nonce 值')
    A.ok(prompt.includes('"nonce":"NONCE-node-1-abc"'), 'JSON 示例要给出 nonce 字段名')
    A.match(prompt, /原样回显 attempt/)
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
    runtime.runs.set('r-node-2', {
      attemptEnvelopeFor: () => ({ attempt: 1, nodeId: 'n_dev', nonce: 'NONCE-node-2-abc' }),
      dispose() {},
    })
    const result = await runtime.wake({ runId: 'r-node-2', nodeId: 'n_dev', attempt: 1, sessionId: 'sess-node' })
    A.deepEqual(result, { action: 'inject' })
    A.equal(injected.length, 1)
    A.equal(followed.length, 0, 'busy 时不能起新回合')
    const prompt = injected[0].content[0].text
    A.ok(prompt.includes('nonce=NONCE-node-2-abc'), 'inject 也要带真实 nonce')
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

  await check('nodeSelfCheckPrompt：含 runId / nodeId / attempt / nonce，要求 ```json 代码块与 verdict', () => {
    const prompt = nodeSelfCheckPrompt({
      runId: 'r-node-4', nodeId: 'n_review', attempt: 3, nonce: 'NONCE-prompt-9',
    })
    A.match(prompt, /r-node-4/)
    A.match(prompt, /n_review/)
    A.match(prompt, /attempt=3/)
    A.match(prompt, /nonce=NONCE-prompt-9/)
    A.ok(prompt.includes('"nonce":"NONCE-prompt-9"'), 'JSON 示例必须带 nonce 字段名')
    A.match(prompt, /原样回显 attempt/)
    A.match(prompt, /nonce/)
    A.match(prompt, /```json/)
    A.match(prompt, /"state":"working\|done\|blocked\|failed"/)
    A.match(prompt, /verdict/)
    A.match(prompt, /不要谎报完成/)
    A.ok([...prompt].length <= 500, `提示词应简短（当前 ${[...prompt].length} 字）`)
  })

  await check('wake（C2）：无 Engine / 无 attempt 凭证 → 不发 followup，snapshot 可见 skip 原因', async () => {
    const sent = []
    const fakeAgent = {
      status: 'idle',
      followup(payload) { sent.push(payload) },
    }
    const agents = { get: () => fakeAgent }
    let clock = new Date('2026-11-07T00:00:00.000Z')
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      ctx: { get: () => agents },
      now: () => clock,
      nodeAlarmMs: 1000,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })

    // ① 本进程没有该 run 的 Engine 实例 → 拿不到凭证，不发。
    const noEngine = await runtime.wake({
      runId: 'r-no-engine', nodeId: 'n_dev', attempt: 1, sessionId: 'sess-no-engine',
    })
    A.deepEqual(noEngine, { action: 'skip', reason: 'no-engine-instance' })
    A.equal(sent.length, 0, '没有 Engine 时不得发 followup')

    // ② Engine 在，但当前没有 attempt/nonce 凭证（两次 attempt 之间 / 引擎未实现）→ 不发。
    runtime.runs.set('r-no-envelope', {
      attemptEnvelopeFor: () => null,
      dispose() {},
    })
    const noEnvelope = await runtime.wake({
      runId: 'r-no-envelope', nodeId: 'n_dev', attempt: 1, sessionId: 'sess-no-envelope',
    })
    A.deepEqual(noEnvelope, { action: 'skip', reason: 'no-attempt-envelope' })
    A.equal(sent.length, 0, '没有 attempt 凭证时不得发 followup')

    // ③ 可观测：调度器 snapshot 里能看到 skip 及原因（lastOutcome/lastReason）。
    runtime.nodeSupervision.register({
      runId: 'r-no-envelope', nodeId: 'n_dev', sessionId: 'sess-no-envelope', attempt: 1,
    })
    clock = new Date(clock.getTime() + 5000)
    await runtime.nodeSupervision.tick()
    const entry = runtime.nodeSupervision.snapshot().entries
      .find(item => item.sessionId === 'sess-no-envelope')
    A.ok(entry, 'snapshot 应包含该节点闹钟条目')
    A.equal(entry.lastOutcome, 'skip')
    A.match(entry.lastReason, /no-attempt-envelope/)
    A.equal(sent.length, 0, 'tick 后仍不得发 followup')
    runtime.dispose()
  })

  await check('wake（C2 端到端）：真实 Engine 只接受回显 attempt+nonce 的自审状态块', async () => {
    // 用真实的 Engine + agents.create 桩：Engine 在 _promptNodeSession 里下发 attempt/nonce，
    // runtime.wake 再通过 attemptEnvelopeFor 取同一份凭证构造自审提问词。
    async function runOnce(flowId, echoNonce) {
      await saveFlow(oneStageFlow(flowId))
      const run = await makeRun(flowId)
      const logs = []
      const selfCheckPrompts = []
      const agentsById = new Map()
      let mainPrompt = ''
      let releaseIdle = null
      const idleGate = new Promise(resolve => { releaseIdle = resolve })
      let engine = null
      const ctx = {
        on() { return () => {} },
        get(name) {
          if (name !== 'agents') return undefined
          return {
            create(createOptions) {
              const sessionId = createOptions.sessionId
              const agent = {
                session: { id: sessionId, header: {} },
                status: 'busy',
                followup(payload) {
                  const text = payload && payload.content && payload.content[0]
                    ? payload.content[0].text
                    : ''
                  if (typeof text !== 'string') return
                  if (!text.includes('【节点自审闹钟】')) {
                    mainPrompt = text
                    return
                  }
                  selfCheckPrompts.push(text)
                  // 模拟节点回报：按 echoNonce 决定是否回显凭证。
                  const envelope = engine ? engine.attemptEnvelopeFor(sessionId) : null
                  const block = {
                    nodeId: 'n_a',
                    attempt: envelope ? envelope.attempt : 1,
                    state: 'working',
                    progress: 50,
                    summary: '自审半成品',
                    members: [],
                    blockers: [],
                    verdict: null,
                  }
                  if (echoNonce && envelope) block.nonce = envelope.nonce
                  engine.handleSessionEvent({ id: sessionId }, {
                    type: 'assistant/message',
                    data: {
                      message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: JSON.stringify(block) }],
                      },
                    },
                  })
                },
                async whenIdle() { await idleGate },
              }
              agentsById.set(sessionId, agent)
              return { agent, dispose: async () => {} }
            },
            get(sessionId) { return agentsById.get(sessionId) || null },
          }
        },
      }
      const runtime = createRuntime({
        runsRoot,
        flowsRoot,
        ctx,
        log: (level, message) => logs.push(`${level}:${message}`),
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
        disposeTimeoutMs: 300,
      })
      await runtime.start(run.id)
      await until(() => mainPrompt !== '', '节点主提示词没有发出')
      engine = runtime.get(run.id)
      A.ok(engine instanceof Engine)
      const sessionId = [...agentsById.keys()][0]
      const envelope = engine.attemptEnvelopeFor(sessionId)
      A.ok(envelope, 'Engine 应已登记本轮 attempt/nonce 凭证')
      A.equal(typeof envelope.nonce, 'string')
      A.ok(envelope.nonce.length > 0)

      const wakeResult = await runtime.wake({
        runId: run.id, nodeId: 'n_a', attempt: envelope.attempt, sessionId,
      })
      A.deepEqual(wakeResult, { action: 'followup' })
      A.equal(selfCheckPrompts.length, 1)
      const prompt = selfCheckPrompts[0]
      A.ok(prompt.includes(`nonce=${envelope.nonce}`), '自审提示词必须含引擎下发的真实 nonce')
      A.ok(prompt.includes(`"nonce":"${envelope.nonce}"`), 'JSON 示例必须给出 nonce 字段名')
      A.ok(prompt.includes(`attempt=${envelope.attempt}`), '提示词必须含本轮 attempt')
      A.match(prompt, /原样回显 attempt/)

      const status = engine.nodeStatus.get('n_a')
      await engine.flushEvents()
      const events = (await store.readAllEvents(runsRoot, run.id)).events
      const statusEvents = events.filter(event => event.kind === 'node/status')
      if (echoNonce) {
        A.ok(status, '回显 attempt+nonce 的状态块应被引擎接受（nodeStatus 更新）')
        A.equal(status.state, 'working')
        A.equal(status.progress, 50)
        A.equal(statusEvents.length, 1, '接受后必须落一条 node/status 事件')
        A.equal(statusEvents[0].nodeId, 'n_a')
        A.equal(logs.some(line => line.includes('丢弃自审状态块')), false, '不应出现丢弃日志')
      } else {
        A.equal(status, undefined, '不回显 nonce 的状态块必须被引擎丢弃')
        A.equal(statusEvents.length, 0, '被丢弃的回报不得落 node/status 事件')
        A.ok(logs.some(line => /丢弃自审状态块/.test(line) && /nonce 缺失/.test(line)),
          '丢弃原因必须可见（nonce 缺失）')
      }
      await runtime.stop(run.id).catch(() => {})
      if (releaseIdle) releaseIdle()
      await runtime.dispose()
    }
    await runOnce('flow-rt-c2-ok', true)
    await runOnce('flow-rt-c2-bad', false)
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

  // -------------------------------------------------------------------------
  console.log('runtime · E2-a 重启收口（running 无实例）')

  await check('E2-a：只收口「running 无实例」，有实例 / 已 completed 不动；重复执行幂等', async () => {
    await saveFlow(oneStageFlow('flow-rt-orphan'))
    const gate = deferred()
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => {
        await gate.promise
        return passResult(node.id)
      },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    // 先让初始化扫描跑完：下面断言的是显式收口，不和「初始化扫描」共用一个用例。
    await runtime.supervisionReady

    // ① running，但本进程没有实例（也没有租约）→ 应被收口。
    const orphan = await makeRun('flow-rt-orphan')
    await store.writeRunMeta(runsRoot, orphan.id, {
      status: 'running',
      started: true,
      startedAt: '2026-11-01T00:00:00.000Z',
    })
    // ② 已 completed → 任何情况下都不动。
    const completed = await makeRun('flow-rt-orphan')
    await store.writeRunMeta(runsRoot, completed.id, {
      status: 'done',
      started: true,
      endedAt: '2026-11-01T01:00:00.000Z',
    })
    // ③ running 且有实例（gate 挂住）→ 不许误杀。
    const live = await makeRun('flow-rt-orphan')
    await runtime.start(live.id)
    A.equal((await store.readRunMeta(runsRoot, live.id)).status, 'running')

    const reclaimed = await runtime.reclaimOrphans()
    A.deepEqual(reclaimed, [orphan.id], `只应收口孤儿（实际 ${reclaimed.join(',')}）`)

    const orphanMeta = await store.readRunMeta(runsRoot, orphan.id)
    A.equal(orphanMeta.status, 'failed')
    A.equal(orphanMeta.supervision.enabled, false)
    A.equal(orphanMeta.supervision.reason, 'restarted')
    A.equal(orphanMeta.supervision.nextDueAt, null, '收口必须清掉唤醒时间')
    A.equal(orphanMeta.supervision.lastWokeAt, null)
    A.ok(typeof orphanMeta.endedAt === 'string' && Number.isFinite(Date.parse(orphanMeta.endedAt)),
      '收口要带可解析时间戳')
    A.equal(await store.readLease(runsRoot, orphan.id), null, '收口必须清租约')
    A.equal(runtime.supervision.status(orphan.id).enabled, false, '不能给已收口的 run 挂唤醒')

    const endEvent = (await store.readAllEvents(runsRoot, orphan.id)).events
      .find(event => event.kind === 'run/end')
    A.ok(Boolean(endEvent), '收口要留一条 run/end 事件')
    A.equal(endEvent.data.status, 'failed')
    A.match(endEvent.data.reason, /restarted|重启/)
    A.ok(Number.isFinite(Date.parse(endEvent.ts)), 'run/end 事件要有可解析的时间戳')

    // 另外两个不动。
    A.equal((await store.readRunMeta(runsRoot, completed.id)).status, 'done')
    A.equal((await store.readRunMeta(runsRoot, completed.id)).endedAt, '2026-11-01T01:00:00.000Z')
    A.equal((await store.readRunMeta(runsRoot, live.id)).status, 'running')
    A.ok(runtime.get(live.id), '有实例的 run 不能被摘掉')

    // 幂等：重复收口不覆盖已经 failed 的 run。
    const before = await store.readRunMeta(runsRoot, orphan.id)
    A.deepEqual(await runtime.reclaimOrphans(), [])
    const after = await store.readRunMeta(runsRoot, orphan.id)
    A.equal(after.status, 'failed')
    A.equal(after.endedAt, before.endedAt)
    A.equal(after.updatedAt, before.updatedAt)

    // 新 runtime 的「初始化扫描」同样幂等：不改已 failed 的 run，也不误杀仍在本进程跑的 live。
    const runtime2 = createRuntime({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => passResult(node.id),
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    await runtime2.supervisionReady
    A.deepEqual(await runtime2.reclaimOrphans(), [])
    A.equal((await store.readRunMeta(runsRoot, orphan.id)).status, 'failed')
    A.equal((await store.readRunMeta(runsRoot, live.id)).status, 'running')
    runtime2.dispose()

    gate.resolve()
    A.equal((await runtime.wait(live.id)).status, 'done')
    runtime.dispose()
  })

  await check('E2-a：未过期的跨进程租约不误杀；本进程残留租约可收口', async () => {
    await saveFlow(oneStageFlow('flow-rt-lease'))
    const run = await makeRun('flow-rt-lease')
    await store.writeRunMeta(runsRoot, run.id, { status: 'running', started: true })
    // 另一个进程（异主机）持有未过期租约：无法探活，保守跳过。
    await store.claimLease(runsRoot, run.id, { pid: 43210, host: 'another-host', ttlMs: 60_000 })
    // 即使它「开过 supervision」，没有本进程实例的 running run 也不恢复唤醒。
    await store.writeRunMeta(runsRoot, run.id, {
      supervision: { enabled: true, wakerSessionId: 'sess-w' },
    })
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    await runtime.supervisionReady
    A.equal((await store.readRunMeta(runsRoot, run.id)).status, 'running')
    A.equal(runtime.supervision.status(run.id).enabled, false,
      'running 但没有活跃实例的 run 不得恢复调度登记')
    A.equal(runtime.supervision.status(run.id).lastReason, 'not-registered')
    A.deepEqual(await runtime.reclaimOrphans(), [])
    A.ok(await store.readLease(runsRoot, run.id), '别的进程的租约不能被清掉')

    // 同机、另一个**活着**的 pid（父进程）：process.kill(pid, 0) 能探活 → 同样不许收。
    await store.releaseLease(runsRoot, run.id, { force: true })
    await store.claimLease(runsRoot, run.id, { pid: process.ppid, host: hostname(), ttlMs: 60_000 })
    A.deepEqual(await runtime.reclaimOrphans(), [])
    A.equal((await store.readRunMeta(runsRoot, run.id)).status, 'running')

    // 本进程持有租约、但本进程没有实例：属于重启残留，可以收口。
    await store.releaseLease(runsRoot, run.id, { force: true })
    await store.claimLease(runsRoot, run.id)
    A.deepEqual(await runtime.reclaimOrphans(), [run.id])
    A.equal((await store.readRunMeta(runsRoot, run.id)).status, 'failed')
    A.equal(await store.readLease(runsRoot, run.id), null)
    runtime.dispose()
  })

  // -------------------------------------------------------------------------
  console.log('runtime · E2-b 卸载 abort 在飞 run')

  await check('E2-b：dispose abort 所有活跃 Engine、按有界超时放弃等待、定时器全部清理', async () => {
    const aborted = []
    const disposed = []
    const timers = new Set()
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      createEngine: () => ({
        async start(runId) { return { id: runId, status: 'running' } },
        // 永不结束的引擎桩：abort 返回一个永不 settle 的 promise，dispose 必须按超时返回。
        abort(runId) {
          aborted.push(runId)
          return new Promise(() => {})
        },
        dispose() { disposed.push(1) },
        async sweepStaleRuns() { return [] },
      }),
      disposeTimeoutMs: 40,
      setInterval: (fn, ms) => {
        const timer = { fn, ms, unref() {} }
        timers.add(timer)
        return timer
      },
      clearInterval: timer => { timers.delete(timer) },
    })
    await runtime.start('r-dispose-1')
    A.equal(runtime.list().length, 1)
    A.ok(timers.size >= 2, `supervision / 节点闹钟两个定时器都应存在（实际 ${timers.size}）`)

    const startedAt = Date.now()
    const pending = runtime.dispose()
    // abort 是 dispose 的同步段：调用返回时就已经发起。
    A.deepEqual(aborted, ['r-dispose-1'], 'dispose 必须对活跃 Engine 调 abort')
    A.deepEqual(runtime.list(), [], 'dispose 同步清空注册表')
    await pending
    const elapsed = Date.now() - startedAt
    A.ok(elapsed >= 30, `应等满有界超时（实际 ${elapsed}ms）`)
    A.ok(elapsed < 2000, `有界等待不能拖死卸载（实际 ${elapsed}ms）`)
    A.equal(disposed.length, 1, 'Engine.dispose 仍要调用（摘事件订阅）')
    A.equal(timers.size, 0, '所有注入定时器都必须清理')
    A.equal(runtime.supervision.stop(), false, 'dispose 后 supervision 定时器已停')
    A.equal(runtime.nodeSupervision.stop(), false, 'dispose 后节点闹钟已停')

    // 幂等：再 dispose 一次不抛错、不重复 abort。
    await runtime.dispose()
    A.equal(aborted.length, 1)
  })

  await check('E2-b：真实引擎在飞节点被 abort → run 收成 aborted，不悬挂', async () => {
    await saveFlow(oneStageFlow('flow-rt-dispose-real'))
    const run = await makeRun('flow-rt-dispose-real')
    let entered = false
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      disposeTimeoutMs: 1000,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
      activate: async ({ node, signal }) => {
        entered = true
        await new Promise((resolvePromise, rejectPromise) => {
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
    await until(() => entered, '节点没有进入执行')
    A.equal((await store.readRunMeta(runsRoot, run.id)).status, 'running')
    await runtime.dispose()
    A.equal((await store.readRunMeta(runsRoot, run.id)).status, 'aborted',
      'dispose abort 后 run 必须收成终态')
    A.deepEqual(runtime.list(), [])
    A.equal(runtime.supervision.stop(), false)
    A.equal(runtime.nodeSupervision.stop(), false)
  })

  // -------------------------------------------------------------------------
  console.log('runtime · E2-c session/event 归属过滤与双上限缓冲')

  await check('E2-c：每个 Engine 只缓冲本 run 的节点会话事件，别人的事件直接丢弃', async () => {
    await saveFlow(oneStageFlow('flow-rt-scope'))
    const runA = await makeRun('flow-rt-scope')
    const runB = await makeRun('flow-rt-scope')
    // 预置 sessions.json：会话对本 run 已知（sessions.json / sessionIndex），但尚未绑定。
    await seedNodeSession(runA.id, 'n_old', 'sess-owned-a-1')
    await seedNodeSession(runB.id, 'n_old', 'sess-owned-b-1')
    const gate = deferred()
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => {
        await gate.promise
        return passResult(node.id)
      },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    await Promise.all([runtime.start(runA.id), runtime.start(runB.id)])
    const engineA = runtime.get(runA.id)
    const engineB = runtime.get(runB.id)
    A.ok(engineA instanceof Engine)
    A.ok(engineB instanceof Engine)

    engineA.handleSessionEvent({ id: 'sess-owned-a-1' }, assistantEvent(1))
    engineA.handleSessionEvent({ id: 'sess-owned-b-1' }, assistantEvent(2))
    engineA.handleSessionEvent({ id: 'sess-stranger' }, assistantEvent(3))
    engineB.handleSessionEvent({ id: 'sess-owned-b-1' }, assistantEvent(4))
    engineB.handleSessionEvent({ id: 'sess-owned-a-1' }, assistantEvent(5))

    // A 只留住自己的那 1 条；B / 陌生会话的事件一个都不缓冲。
    A.equal(engineA.pendingSessionEvents.length, 1)
    A.equal(engineA.pendingSessionEvents[0].session.id, 'sess-owned-a-1')
    A.equal(engineA.sessionEventStats.owned, 1)
    A.equal(engineA.sessionEventStats.foreign, 2, '别人的会话事件应被直接丢弃')
    // B 同理（只收到 A 的一条外来事件 + 自己一条）。
    A.equal(engineB.pendingSessionEvents.length, 1)
    A.equal(engineB.pendingSessionEvents[0].session.id, 'sess-owned-b-1')
    A.equal(engineB.sessionEventStats.owned, 1)
    A.equal(engineB.sessionEventStats.foreign, 1)
    A.ok(engineA.sessionEventStats.bytes > 0, '缓冲按字节记账')

    // waker 会话：supervision.wakerSessionId 指向的会话也属于本 run（saveSupervision
    // 会同步刷新进程内 waker 缓存，所以同步的 handleSessionEvent 能立刻认出来）。
    const ownedBefore = engineA.sessionEventStats.owned
    const pendingBefore = engineA.pendingSessionEvents.length
    await runtime.enableSupervision(runA.id, { enabled: true, wakerSessionId: 'sess-waker-a' })
    engineA.handleSessionEvent({ id: 'sess-waker-a' }, assistantEvent(6))
    A.equal(engineA.sessionEventStats.wakerSessionId, 'sess-waker-a')
    A.equal(engineA.sessionEventStats.owned, ownedBefore + 1, 'waker 会话事件必须放行')
    A.equal(engineA.pendingSessionEvents.length, pendingBefore + 1)
    A.deepEqual(
      engineA.pendingSessionEvents.map(item => item.session.id).sort(),
      ['sess-owned-a-1', 'sess-waker-a'],
    )

    gate.resolve()
    await Promise.all([runtime.wait(runA.id), runtime.wait(runB.id)])
    runtime.dispose()
  })

  await check('E2-c：缓冲条数上限按最旧丢弃，超限标记可见', async () => {
    await saveFlow(oneStageFlow('flow-rt-cap-count'))
    const run = await makeRun('flow-rt-cap-count')
    await seedNodeSession(run.id, 'n_old', 'sess-cap-count')
    const gate = deferred()
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      sessionEventLimit: 3,
      sessionEventByteLimit: 1024 * 1024,
      activate: async ({ node }) => {
        await gate.promise
        return passResult(node.id)
      },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    await runtime.start(run.id)
    const engine = runtime.get(run.id)
    for (let seq = 1; seq <= 8; seq += 1) {
      engine.handleSessionEvent({ id: 'sess-cap-count' }, assistantEvent(seq))
    }
    A.equal(engine.pendingSessionEvents.length, 3, '条数上限生效')
    A.deepEqual(engine.pendingSessionEvents.map(item => item.event.seq), [6, 7, 8], '超限丢最旧、保留最新')
    A.equal(engine.sessionEventStats.overflowed, true)
    A.equal(engine.sessionEventOverflow, true, '可观测标记可见')
    A.ok(engine.sessionEventStats.dropped >= 5)
    gate.resolve()
    await runtime.wait(run.id)
    runtime.dispose()
  })

  await check('E2-c：缓冲字节上限按最旧丢弃，字节标记不超预算', async () => {
    await saveFlow(oneStageFlow('flow-rt-cap-bytes'))
    const run = await makeRun('flow-rt-cap-bytes')
    await seedNodeSession(run.id, 'n_old', 'sess-cap-bytes')
    const gate = deferred()
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      sessionEventLimit: 1000,
      sessionEventByteLimit: 1000,
      activate: async ({ node }) => {
        await gate.promise
        return passResult(node.id)
      },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    await runtime.start(run.id)
    const engine = runtime.get(run.id)
    for (let seq = 1; seq <= 8; seq += 1) {
      engine.handleSessionEvent({ id: 'sess-cap-bytes' }, assistantEvent(seq, 'y'.repeat(200)))
    }
    A.ok(engine.pendingSessionEvents.length >= 1)
    A.ok(engine.pendingSessionEvents.length < 8, '字节超限必须裁剪')
    A.ok(engine.sessionEventStats.bytes <= 1000, `字节预算（实际 ${engine.sessionEventStats.bytes}）`)
    A.ok(engine.pendingSessionBytes <= 1000)
    A.equal(engine.pendingSessionEvents.at(-1).event.seq, 8, '保留最新一条')
    A.ok(engine.pendingSessionEvents[0].event.seq > 1, '最旧的先被丢弃')
    A.equal(engine.sessionEventOverflow, true)
    A.ok(engine.sessionEventStats.dropped > 0)
    gate.resolve()
    await runtime.wait(run.id)
    runtime.dispose()
  })

  // -------------------------------------------------------------------------
  console.log('runtime · E2-d patchRunJson 走 runstore 单一写路径')

  await check('E2-d：并发 patch 不同字段全部保留、seq 不回退；与 writeRunMeta 同锁域', async () => {
    await saveFlow(oneStageFlow('flow-rt-patch'))
    const run = await makeRun('flow-rt-patch')
    await store.writeRunMeta(runsRoot, run.id, { seq: 7 })
    A.equal(await runtimeModule.readStartOptions(runsRoot, run.id), null, '缺省 startOptions 返回 null')
    const patches = [
      { status: 'running' },
      { engine: 'stub' },
      { started: true },
      { nodeTotal: 3 },
      { supervision: { enabled: true, wakerSessionId: 'sess-w' } },
      { workspace: { id: 'w1', path: '/repo/w' } },
      { nodeStatusTruncated: true },
      { sessions: { n_a: 'sess-a' } },
      { startOptions: { workspace: '/repo/demo', worktree: 'on' } },
    ]
    const results = await Promise.all(patches.map(patch => runtimeModule.patchRunJson(runsRoot, run.id, patch)))
    A.equal(results.length, patches.length)
    A.ok(results.every(meta => meta && meta.id === run.id))
    A.ok(results.every(meta => !('droppedKeys' in meta)), '白名单字段不能被静默丢弃')

    const meta = await store.readRunMeta(runsRoot, run.id)
    A.equal(meta.status, 'running')
    A.equal(meta.engine, 'stub')
    A.equal(meta.started, true)
    A.equal(meta.nodeTotal, 3)
    A.equal(meta.supervision.enabled, true)
    A.equal(meta.supervision.wakerSessionId, 'sess-w')
    A.equal(meta.workspace.id, 'w1')
    A.equal(meta.nodeStatusTruncated, true)
    A.equal(meta.sessions.n_a, 'sess-a')
    A.deepEqual(meta.startOptions, { workspace: '/repo/demo', worktree: 'on' })
    // readStartOptions 也走 runstore（不再是裸读原文），返回值形状保持 { workspace?, worktree? } | null。
    A.deepEqual(await runtimeModule.readStartOptions(runsRoot, run.id),
      { workspace: '/repo/demo', worktree: 'on' })
    A.equal(await runtimeModule.readStartOptions(runsRoot, 'r-no-such-run'), null)
    A.ok(meta.seq >= 7, `seq 不回退（实际 ${meta.seq}）`)
    A.equal(meta.lastSeq, meta.seq)

    // 与 runstore.writeRunMeta 交叉并发：两条调用落在同一把锁上，字段不会互相覆盖。
    const [patched, written] = await Promise.all([
      runtimeModule.patchRunJson(runsRoot, run.id, { tokenTotal: 42 }),
      store.writeRunMeta(runsRoot, run.id, { tokenTotalApprox: true }),
    ])
    A.equal(patched.tokenTotal, 42)
    A.equal(written.tokenTotalApprox, true)
    const finalMeta = await store.readRunMeta(runsRoot, run.id)
    A.equal(finalMeta.tokenTotal, 42)
    A.equal(finalMeta.tokenTotalApprox, true)

    // 返回值兼容旧契约：run 不存在 / runId 非法 → null（不抛错）。
    A.equal(await runtimeModule.patchRunJson(runsRoot, 'r-no-such-run', { status: 'done' }), null)
    A.equal(await runtimeModule.patchRunJson(runsRoot, 'bad/id', { status: 'done' }), null)
  })

} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nruntime §5 自检：${checks} 组通过（${assertionCount} 条断言）`)
