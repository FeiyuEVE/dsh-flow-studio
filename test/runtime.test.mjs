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
 *   C2 节点自审凭证：提示词回显 attempt+nonce、无 Engine/凭证时不发、真实 Engine 端到端接受/丢弃；
 *   G7-a 按发起会话合并唤醒（10 run → 1 条 followup / 预算限流不丢 due）、
 *   G7-b 重启恢复节点闹钟（2 条恢复 / 缺 sessionId 跳过 / 终态不恢复 / 幂等）。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
const { auditWorkflow } = await import('../src/audit.js')
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
      let lastWasWarmup = false
      const idleGate = new Promise(resolve => { releaseIdle = resolve })
      let engine = null
      const ctx = {
        on() { return () => {} },
        get(name) {
          if (name === 'agentDefaultModel') {
            return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
          }
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
                  // v0.9.2：预热轮（无 attempt/nonce 契约）不算主提示词，且不让它卡住 idle。
                  if (text.includes('引擎预热')) {
                    lastWasWarmup = true
                    return
                  }
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
                // 预热轮那一轮已经"结束"，正式任务这一轮才被 idleGate 挂住（本用例要用它
                // 把节点维持在运行中，好让 runtime.wake 拿到 attempt/nonce 凭证）。
                async whenIdle() {
                  if (lastWasWarmup) {
                    lastWasWarmup = false
                    return
                  }
                  await idleGate
                },
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

  // -------------------------------------------------------------------------
  console.log('runtime · v0.8.2 G7-a：按发起会话合并唤醒')

  await check('G7-a：10 个 run 同一个发起会话 → 只发 1 条 followup，正文列出 10 个 runId，另 9 个合并而非丢弃', async () => {
    await saveFlow(oneStageFlow('flow-rt-g7a'))
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
      // 固定 verdict，免得依赖真实审计对「没有事件」的判断。
      auditWorkflow: () => ({ verdict: 'healthy', nextCheckSeconds: 180 }),
    })
    const runIds = []
    for (let index = 0; index < 10; index += 1) {
      const run = await makeRun('flow-rt-g7a')
      await store.writeRunMeta(runsRoot, run.id, {
        status: 'running',
        started: true,
        // 很早开始：healthy 的 nextDueAt（startedAt + 180s）已经过点。
        startedAt: '2020-01-01T00:00:00.000Z',
      })
      await runtime.enableSupervision(run.id, { enabled: true, wakerSessionId: 'sess-g7a-shared' })
      runIds.push(run.id)
    }
    A.equal(runtime.supervision.snapshot().entries.length, 10)

    const stats = await runtime.supervision.tick()
    A.equal(sent.length, 1, '10 个 run 同 waker 只能发 1 条 followup')
    A.equal(stats.runs, 10)
    A.equal(stats.woken, 10, '10 个 run 都算被唤醒（合并而不是丢弃）')
    A.equal(stats.failed, 0)

    // 正文必须把 10 个 runId 都列出来，且是一条有界长度的提示词（不是一万字）。
    const text = sent[0].content[0].text
    for (const runId of runIds) {
      A.ok(text.includes(runId), `合并提示词要列出 ${runId}`)
    }
    A.ok(text.length < 4000, `合并提示词必须有界（实际 ${text.length} 字）`)
    A.match(text, /不需要你再手动挂 proactive_set 闹钟/)
    A.match(text, /flow_watch/)
    A.equal(sent[0].source.room, runIds[0], 'payload 的 room 用主 runId（本组第一个）')
    // 单 run 的正文与旧版逐字一致（向后兼容）；超过上限只给摘要，别发一条上万字。
    A.equal(
      runtimeModule.supervisionWakePromptBatch([runIds[0]]),
      runtimeModule.supervisionWakePrompt(runIds[0]),
      '单 run 的合并提示词必须与旧版逐字相同',
    )
    const many = Array.from({ length: 25 }, (_, index) => `r-many-${index}`)
    const manyText = runtimeModule.supervisionWakePromptBatch(many)
    A.ok(manyText.includes('r-many-19'), '前 20 个逐个列出')
    A.ok(!manyText.includes('r-many-20'), '超过上限的只给摘要')
    A.match(manyText, /另有 5 个同批到期的 run/)
    A.ok(manyText.length < 4000, `超大批次提示词必须有界（实际 ${manyText.length} 字）`)

    // 可观测：1 次唤醒 + 9 个被合并；每条 run 的落盘计数都真的 +1（不是丢弃）。
    const snapshot = runtime.supervision.snapshot()
    A.equal(snapshot.wokenThisHour, 1, '预算口径按「真的发出去的提醒次数」计')
    A.equal(snapshot.coalesced, 9, '9 个 run 被合并')
    A.equal(snapshot.throttled, 0)
    A.equal(snapshot.waker.sessions.length, 1)
    A.equal(snapshot.waker.sessions[0].sessionId, 'sess-g7a-shared')
    A.equal(snapshot.waker.sessions[0].coalesced, 9)
    for (const runId of runIds) {
      A.equal(runtime.supervision.status(runId).wakes, 1, `${runId} 不能被丢`)
      const meta = await store.readRunMeta(runsRoot, runId)
      A.equal(meta.supervision.wakes, 1, `${runId} 的 supervision.wakes 已落盘`)
      A.ok(typeof meta.supervision.nextDueAt === 'string', `${runId} 的 nextDueAt 已推进`)
    }
    runtime.dispose()
  })

  await check('G7-a：同一会话最小唤醒间隔内到点的 run 被限流 —— 不发第二条、保留 due、计数可见', async () => {
    await saveFlow(oneStageFlow('flow-rt-g7a-throttle'))
    const sent = []
    const fakeAgent = { status: 'idle', followup(payload) { sent.push(payload) } }
    const agents = { get: () => fakeAgent }
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      ctx: { get: () => agents },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
      wakerMinIntervalMs: 120_000,
      auditWorkflow: () => ({ verdict: 'healthy', nextCheckSeconds: 180 }),
    })
    const makeDue = async () => {
      const run = await makeRun('flow-rt-g7a-throttle')
      await store.writeRunMeta(runsRoot, run.id, {
        status: 'running',
        started: true,
        startedAt: '2020-01-01T00:00:00.000Z',
      })
      await runtime.enableSupervision(run.id, { enabled: true, wakerSessionId: 'sess-g7a-throttle' })
      return run.id
    }

    // 第一个 run 先唤醒一次，消耗掉该会话本轮预算（lastWokeAt = now）。
    const first = await makeDue()
    await runtime.supervision.tick()
    A.equal(sent.length, 1)
    A.equal(runtime.supervision.status(first).wakes, 1)

    // 立刻再登记一个同会话、且已过点的 run：最小间隔内 → 限流（不丢）。
    const second = await makeDue()
    await runtime.supervision.tick()
    A.equal(sent.length, 1, '最小间隔内不得再发第二条 followup')
    A.equal(runtime.supervision.status(second).wakes, 0, '被限流的 run 没被唤醒（但也没被丢掉）')
    A.equal(runtime.supervision.status(second).enabled, true, '限流不是失败，不能降级')
    A.equal(runtime.supervision.status(second).failures, 0)
    A.match(runtime.supervision.status(second).lastReason, /^throttled: /)

    const snapshot = runtime.supervision.snapshot()
    A.ok(snapshot.throttled >= 1, '限流要记进可观测计数')
    const throttledEntry = snapshot.entries.find(entry => entry.runId === second)
    A.equal(throttledEntry.lastOutcome, 'throttled')
    A.equal(throttledEntry.throttled, 1)
    const meta = await store.readRunMeta(runsRoot, second)
    A.equal(meta.supervision.wakes, 0)
    A.ok(
      typeof meta.supervision.nextDueAt === 'string'
        && Date.parse(meta.supervision.nextDueAt) <= Date.now(),
      '被限流的 run 必须保留 due（nextDueAt ≤ now，下一轮再来）',
    )
    runtime.dispose()
  })

  // -------------------------------------------------------------------------
  console.log('runtime · v0.8.2 G7-b：重启恢复节点自审闹钟')

  /**
   * 造一个「running + 本进程有 Engine 实例」的 run，写入 nodeStatus / sessions.json，
   * 再显式跑一次节点闹钟恢复。activate 挂住让 run 一直 running。
   */
  async function stagedRunningRun(flowId, { nodeStatus, sessions } = {}) {
    await saveFlow(oneStageFlow(flowId))
    const run = await makeRun(flowId)
    const gate = deferred()
    const logs = []
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      log: (level, message) => logs.push(`${level}:${message}`),
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
      activate: async ({ node }) => {
        await gate.promise
        return passResult(node.id)
      },
    })
    // 先让初始化扫描跑完（此时还没有本进程实例，不会误扫），再 start。
    await runtime.nodeAlarmsReady
    await runtime.start(run.id)
    A.equal((await store.readRunMeta(runsRoot, run.id)).status, 'running')
    if (nodeStatus !== undefined) await store.writeRunMeta(runsRoot, run.id, { nodeStatus })
    if (sessions !== undefined) await store.writeNodeSessions(runsRoot, run.id, sessions)
    const close = async () => {
      gate.resolve()
      await runtime.wait(run.id).catch(() => {})
      await runtime.dispose()
    }
    return { runtime, run, logs, close }
  }

  const iso = secondsAgo => new Date(Date.now() - secondsAgo * 1000).toISOString()

  await check('G7-b：重启恢复 2 条非终态节点闹钟（nextDueAt > now）；终态节点不恢复', async () => {
    const { runtime, run, logs, close } = await stagedRunningRun('flow-rt-g7b-basic', {
      nodeStatus: {
        n_a: { state: 'working', progress: 10, at: iso(60) },
        n_b: { state: 'blocked', progress: 20, at: iso(30) },
        n_done: { state: 'done', progress: 100, at: iso(10) },
        n_failed: { state: 'failed', progress: 100, at: iso(5) },
      },
      sessions: {
        n_a: { sessionId: 'sess-g7b-a', createdAt: iso(600), lastUsedAt: iso(60) },
        n_b: { sessionId: 'sess-g7b-b', createdAt: iso(600), lastUsedAt: iso(30) },
        n_done: { sessionId: 'sess-g7b-done', createdAt: iso(600), lastUsedAt: iso(10) },
        n_failed: { sessionId: 'sess-g7b-failed', createdAt: iso(600), lastUsedAt: iso(5) },
      },
    })

    const before = Date.now()
    const summary = await runtime.recoverNodeAlarms()
    A.equal(summary.runsScanned, 1)
    A.equal(summary.runsRecovered, 1)
    A.equal(summary.restored, 2, '只恢复两个非终态节点')
    A.equal(summary.skippedTerminal, 2, 'done / failed 是终态，不恢复')
    A.equal(summary.missingSession, 0)
    A.equal(summary.missingAttempt, 2, 'nodeStatus 没有 attempt → 按 1 处理并计数')

    const listed = runtime.nodeSupervision.list()
    A.equal(listed.length, 2, '调度器里正好两条')
    A.deepEqual(listed.map(entry => entry.nodeId).sort(), ['n_a', 'n_b'])
    A.deepEqual(listed.map(entry => entry.sessionId).sort(), ['sess-g7b-a', 'sess-g7b-b'])
    for (const entry of listed) {
      A.equal(entry.runId, run.id)
      A.equal(entry.attempt, 1, '缺 attempt 时按 1 处理')
      A.ok(Date.parse(entry.nextDueAt) > before, `${entry.nodeId} 的 nextDueAt 必须 > now（重启瞬间不唤醒）`)
      // 默认恢复间隔 = NODE_ALARM_DEFAULT_MS（600s）。
      A.ok(Date.parse(entry.nextDueAt) - before >= 590_000, '恢复后首轮按 600s 重排')
    }
    // 缺 attempt 要留 warn。
    A.ok(logs.some(line => line.startsWith('warn:') && /没有 attempt/.test(line)), '缺 attempt 要记 warn')

    // 可观测：恢复统计进 snapshot().recovery。
    const recovery = runtime.nodeSupervision.snapshot().recovery
    A.equal(recovery.restored, 2)
    A.equal(recovery.skippedTerminal, 2)
    A.equal(recovery.missingAttempt, 2)
    A.deepEqual(runtime.nodeRecovery, recovery)
    await close()
  })

  await check('G7-b：缺 sessionId 的节点被跳过并计数；重复恢复幂等（不重复登记、不重排 due）', async () => {
    const { runtime, logs, close } = await stagedRunningRun('flow-rt-g7b-missing', {
      nodeStatus: {
        n_has: { state: 'working', at: iso(10) },
        n_missing: { state: 'working', at: iso(10) },
        n_done: { state: 'done', at: iso(5) },
      },
      sessions: {
        n_has: { sessionId: 'sess-g7b-has', createdAt: iso(600), lastUsedAt: iso(10) },
        n_done: { sessionId: 'sess-g7b-done', createdAt: iso(600), lastUsedAt: iso(5) },
      },
    })

    const first = await runtime.recoverNodeAlarms()
    A.equal(first.restored, 1)
    A.equal(first.missingSession, 1, '缺 sessionId 的节点跳过并计数')
    A.equal(first.skippedTerminal, 1)
    A.equal(runtime.nodeSupervision.list().length, 1, '不造一个叫不醒的条目')
    A.equal(runtime.nodeSupervision.list()[0].sessionId, 'sess-g7b-has')
    A.ok(logs.some(line => line.startsWith('warn:') && /没有 sessionId/.test(line)), '缺 sessionId 要留 warn')
    const before = runtime.nodeSupervision.list()[0].nextDueAt

    // 重复调用：已登记的不再 register（不会把 nextDueAt 往后推）、不产生重复条目。
    const second = await runtime.recoverNodeAlarms()
    A.equal(second.restored, 0)
    A.equal(second.alreadyRegistered, 1)
    A.equal(second.missingSession, 1)
    A.equal(runtime.nodeSupervision.list().length, 1, '幂等：不重复登记')
    A.equal(runtime.nodeSupervision.list()[0].nextDueAt, before, '幂等：已排好的 due 不被重排')
    await close()
  })

  await check('G7-b：本进程没有 Engine 实例的 running run 不恢复（不叫醒别的进程的会话）', async () => {
    await saveFlow(oneStageFlow('flow-rt-g7b-no-engine'))
    const run = await makeRun('flow-rt-g7b-no-engine')
    await store.writeRunMeta(runsRoot, run.id, {
      status: 'running',
      started: true,
      startedAt: '2020-01-01T00:00:00.000Z',
      nodeStatus: { n_a: { state: 'working', at: iso(10) } },
    })
    await store.writeNodeSessions(runsRoot, run.id, {
      n_a: { sessionId: 'sess-g7b-orphan', createdAt: iso(600), lastUsedAt: iso(10) },
    })
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    await runtime.nodeAlarmsReady
    const summary = await runtime.recoverNodeAlarms()
    A.equal(summary.runsScanned, 0)
    A.equal(summary.restored, 0)
    A.equal(runtime.nodeSupervision.list().length, 0, '没有 Engine 实例的 run 不登记任何节点闹钟')
    runtime.dispose()
  })

  // -------------------------------------------------------------------------
  console.log('runtime · 准入控制（0.11 · R2/S1）')

  // 独立的 runsRoot / flowsRoot：不污染上面既有组的共享目录。
  const admissionRunsRoot = join(home, 'runs-admission')
  const admissionFlowsRoot = join(home, 'flows-admission')
  const admissionModule = await import('../src/admission.js')
  const { createAdmission: createAdmissionController, AdmissionError } = admissionModule

  async function makeAdmissionRun(flowId) {
    return store.createRun(admissionRunsRoot, {
      flowId,
      flowName: `流程 ${flowId}`,
      nodeTotal: 1,
    })
  }

  await check('准入集成：第 N+1 个 run 排队（不建 Engine、不写 run/start），槽位释放后自动启动', async () => {
    const flowId = 'flow-adm-queue'
    await flowStore.saveFlow(admissionFlowsRoot, flowId, oneStageFlow(flowId))
    const runA = await makeAdmissionRun(flowId)
    const runB = await makeAdmissionRun(flowId)
    const gate = deferred()
    const entered = []
    const admission = createAdmissionController({
      controller: {},
      limits: { global: 1, perWorkspace: 1 },
      queueMax: 4,
      queueTimeoutMs: 3000,
    })
    const runtime = createRuntimeRaw({
      runsRoot: admissionRunsRoot,
      flowsRoot: admissionFlowsRoot,
      cwd: repoRoot,
      worktree: 'off',
      admission,
      activate: async ({ node, runId }) => {
        entered.push(runId)
        await gate.promise
        return passResult(node.id)
      },
    })
    try {
      const startA = runtime.start(runA.id, { workspace: repoRoot })
        .then(meta => ({ ok: true, meta }), error => ({ ok: false, error }))
      await until(() => entered.includes(runA.id), 'runA 没有进入执行')
      // 不同工作区 key：A 占住唯一槽位，B 才能进入队列（工作区满会立即 429）。
      const startB = runtime.start(runB.id, { workspace: join(repoRoot, 'src') })
        .then(meta => ({ ok: true, meta }), error => ({ ok: false, error }))
      await until(() => admission.admissionOf(runB.id)?.state === 'queued', 'runB 没有进入排队')

      // 排队期间：没有 Engine、run.json 仍是 pending、没有 run/start 事件。
      A.equal(runtime.get(runB.id), null, '排队期间不创建 Engine')
      A.equal(runtime.admissionOf(runB.id).state, 'queued')
      A.equal(runtime.admissionOf(runB.id).position, 1)
      A.equal(runtime.admissionSnapshot().active, 1)
      A.deepEqual(runtime.admissionSnapshot().queued.map(item => item.runId), [runB.id])
      A.equal(runtime.admissionLimits.global, 1)
      A.equal(runtime.admissionLimits.perWorkspace, 1)
      const metaB = await store.readRunMeta(admissionRunsRoot, runB.id)
      A.equal(metaB.status, 'pending')
      A.equal(metaB.started, false)
      A.deepEqual(
        (await store.readAllEvents(admissionRunsRoot, runB.id)).events,
        [],
        '排队期间不写 run/start',
      )

      // runA 收尾释放槽位 → runB 自动获得槽位并启动。
      gate.resolve()
      A.equal((await runtime.wait(runA.id)).status, 'done')
      await until(() => entered.includes(runB.id), 'runB 没有在槽位释放后启动')
      A.ok(runtime.get(runB.id) instanceof Engine, '拿到槽位后才创建 Engine')
      await until(() => runtime.admissionOf(runB.id)?.state === 'running', 'runB 没有进入 running')
      A.equal((await runtime.wait(runB.id)).status, 'done')
      A.equal(runtime.admissionSnapshot().active, 0, '两个 run 收尾后槽位全部归还')
      A.deepEqual(runtime.admissionSnapshot().queued, [])
      A.equal((await startA).ok, true, 'runA start 成功')
      A.equal((await startB).ok, true, 'runB 拿到槽位后 start 成功')
    } finally {
      gate.resolve()
      await runtime.dispose()
    }
  })

  await check('准入集成：stop 排队中的 run → 409（reason=stop）并取消排队，不碰运行中的 run', async () => {
    const flowId = 'flow-adm-stop'
    await flowStore.saveFlow(admissionFlowsRoot, flowId, oneStageFlow(flowId))
    const runA = await makeAdmissionRun(flowId)
    const runB = await makeAdmissionRun(flowId)
    const gate = deferred()
    const entered = []
    const admission = createAdmissionController({
      controller: {},
      limits: { global: 1, perWorkspace: 1 },
      queueMax: 4,
      queueTimeoutMs: 5000,
    })
    const runtime = createRuntimeRaw({
      runsRoot: admissionRunsRoot,
      flowsRoot: admissionFlowsRoot,
      cwd: repoRoot,
      worktree: 'off',
      admission,
      activate: async ({ node, runId }) => {
        entered.push(runId)
        await gate.promise
        return passResult(node.id)
      },
    })
    try {
      const startA = runtime.start(runA.id, { workspace: repoRoot })
        .then(meta => ({ ok: true, meta }), error => ({ ok: false, error }))
      // 等到 A 真正进入执行（markRunning 早于 run/start 落盘，不能用它当同步点）。
      await until(() => entered.includes(runA.id), 'runA 没有进入执行')
      const startB = runtime.start(runB.id, { workspace: join(repoRoot, 'src') })
        .then(() => null, error => error)
      await until(() => admission.admissionOf(runB.id)?.state === 'queued', 'runB 没有进入排队')

      let stopError = null
      try {
        await runtime.stop(runB.id)
      } catch (error) {
        stopError = error
      }
      A.ok(stopError instanceof EngineError)
      A.equal(stopError.status, 409)
      A.equal(stopError.reason, 'stop')
      A.equal(stopError.code, 'RUN_CONCURRENCY_LIMIT')
      A.match(stopError.message, /排队/)
      A.equal(runtime.admissionOf(runB.id), null, '排队票已原子摘除')
      A.deepEqual(runtime.admissionSnapshot().queued, [])
      const metaB = await store.readRunMeta(admissionRunsRoot, runB.id)
      A.equal(metaB.status, 'pending', '排队中的 run 没被写 run/start')
      A.equal(metaB.started, false)

      // 排队中的 start promise 被取消（不是悬挂的 Promise）。
      const cancelled = await startB
      A.ok(cancelled instanceof AdmissionError)
      A.equal(cancelled.status, 429)
      A.equal(cancelled.reason, 'cancelled')
      A.equal(cancelled.cancelReason, 'stop')

      // 运行中的 run 不受影响：照常收尾。
      gate.resolve()
      A.equal((await runtime.wait(runA.id)).status, 'done')
      A.equal((await startA).ok, true)
      A.equal(runtime.admissionSnapshot().active, 0)
    } finally {
      gate.resolve()
      await runtime.dispose()
    }
  })

  await check('准入集成：重复 runId 409 / 限流 429 的 payload 字段完整', async () => {
    const flowId = 'flow-adm-payload'
    await flowStore.saveFlow(admissionFlowsRoot, flowId, oneStageFlow(flowId))
    const runA = await makeAdmissionRun(flowId)
    const runC = await makeAdmissionRun(flowId)
    const runD = await makeAdmissionRun(flowId)
    const gate = deferred()
    const wsC = join(home, 'ws-adm-c')
    const wsD = join(home, 'ws-adm-d')
    const entered = []
    const admission = createAdmissionController({
      controller: {},
      limits: { global: 1, perWorkspace: 1 },
      queueMax: 1,
      queueTimeoutMs: 5000,
    })
    const runtime = createRuntimeRaw({
      runsRoot: admissionRunsRoot,
      flowsRoot: admissionFlowsRoot,
      cwd: repoRoot,
      worktree: 'off',
      admission,
      activate: async ({ node, runId }) => {
        entered.push(runId)
        await gate.promise
        return passResult(node.id)
      },
    })
    try {
      const startA = runtime.start(runA.id)
        .then(meta => ({ ok: true, meta }), error => ({ ok: false, error }))
      await until(() => entered.includes(runA.id), 'runA 没有进入执行')
      // 不同工作区 key：A 占住唯一全局槽位，C 进队；D 撞队满。
      const startC = runtime.start(runC.id, { workspace: wsC }).then(() => null, error => error)
      await until(() => admission.admissionOf(runC.id)?.state === 'queued', 'runC 没有进入排队')

      // 409 payload：排队中的 runId 不能被再次 start（RUN_ALREADY_ACTIVE）。
      let duplicateQueued = null
      try {
        await runtime.start(runC.id, { workspace: wsC })
      } catch (error) {
        duplicateQueued = error
      }
      A.ok(duplicateQueued instanceof AdmissionError)
      A.equal(duplicateQueued.status, 409)
      A.equal(duplicateQueued.code, 'RUN_ALREADY_ACTIVE')
      A.equal(duplicateQueued.runId, runC.id)
      A.equal(duplicateQueued.state, 'queued')
      A.match(duplicateQueued.message, /已在运行/)

      // 409 payload：运行中的 runId 重复 start 仍走 runtime 既有 409（文案含「已在运行」）。
      let duplicateRunning = null
      try {
        await runtime.start(runA.id)
      } catch (error) {
        duplicateRunning = error
      }
      A.ok(duplicateRunning instanceof EngineError)
      A.equal(duplicateRunning.status, 409)
      A.match(duplicateRunning.message, /已在运行/)
      A.ok(duplicateRunning.message.includes(runA.id))

      // 429 payload：队满（D 用第三个工作区 key，避开 workspace-full 先命中）。
      let limitError = null
      try {
        await runtime.start(runD.id, { workspace: wsD })
      } catch (error) {
        limitError = error
      }
      A.ok(limitError instanceof AdmissionError)
      A.equal(limitError.status, 429)
      A.equal(limitError.code, 'RUN_CONCURRENCY_LIMIT')
      A.equal(limitError.scope, 'global')
      A.equal(limitError.reason, 'queue-full')
      A.equal(limitError.active, 1)
      A.equal(limitError.max, 1)
      A.deepEqual(limitError.limits, { global: 1, perWorkspace: 1 })
      A.equal(limitError.retryAfterMs, 30_000)
      A.match(limitError.message, /排队已满/)
      A.equal(runtime.get(runD.id), null, '被限流的 run 不创建 Engine')
      const metaD = await store.readRunMeta(admissionRunsRoot, runD.id)
      A.equal(metaD.started, false)

      // 清理排队中的 C，再让 A 正常收尾。
      let stopC = null
      try {
        await runtime.stop(runC.id)
      } catch (error) {
        stopC = error
      }
      A.ok(stopC instanceof EngineError)
      A.equal(stopC.status, 409)
      A.equal(stopC.reason, 'stop')
      A.equal((await startC).reason, 'cancelled')
      gate.resolve()
      A.equal((await runtime.wait(runA.id)).status, 'done')
      A.equal((await startA).ok, true)
      A.equal(runtime.admissionSnapshot().active, 0)
    } finally {
      gate.resolve()
      await runtime.dispose()
    }
  })

  // 0.11 R2：restart 在准入处被 429 时保留可重试 childRunId，释放后复用同一 child
  await check('准入集成：restart 429 保留可重试 childRunId，释放后复用同一 child 启动', async () => {
    const flowId = 'flow-adm-restart'
    await flowStore.saveFlow(admissionFlowsRoot, flowId, oneStageFlow(flowId))
    const gate = deferred()
    const entered = []
    const admission = createAdmissionController({
      controller: {},
      limits: { global: 1, perWorkspace: 1 },
      queueMax: 0,
      queueTimeoutMs: 1000,
    })
    const runtime = createRuntimeRaw({
      runsRoot: admissionRunsRoot,
      flowsRoot: admissionFlowsRoot,
      cwd: repoRoot,
      worktree: 'off',
      admission,
      activate: async ({ node, runId }) => {
        entered.push(runId)
        await gate.promise
        return passResult(node.id)
      },
    })
    try {
      // 占满唯一槽位。
      const occupant = await makeAdmissionRun(flowId)
      const startOccupant = runtime.start(occupant.id, { workspace: repoRoot })
      await until(() => entered.includes(occupant.id), '占位 run 没有进入执行')

      // 造一个已失败的旧 run（带 workspace 绑定 + 一条失败节点事件，便于推导续跑起点）。
      const oldRun = await makeAdmissionRun(flowId)
      await store.appendEvents(admissionRunsRoot, oldRun.id, [
        {
          v: 1, kind: 'run/start', traceId: 'tr-old', data: { flowId, flowName: flowId, nodeTotal: 1 },
        },
        {
          v: 1, kind: 'node/start', nodeId: 'n_a', attemptId: 1, traceId: 'tr-old-node',
          data: { title: '实现', mode: 'single', skills: [] },
        },
        {
          v: 1, kind: 'node/end', nodeId: 'n_a', attemptId: 1, traceId: 'tr-old-node',
          data: { status: 'failed', durationMs: 1 },
        },
      ])
      await store.writeRunMeta(admissionRunsRoot, oldRun.id, {
        status: 'failed',
        started: true,
        endedAt: new Date().toISOString(),
        workspace: { path: repoRoot },
      })

      let firstError = null
      try {
        await runtime.restart(oldRun.id)
      } catch (error) {
        firstError = error
      }
      A.ok(firstError, '槽位被占时 restart 必须失败')
      A.equal(firstError.status, 429)
      A.ok(typeof firstError.childRunId === 'string' && firstError.childRunId !== '',
        '429 必须带可重试的 childRunId')
      const childId = firstError.childRunId
      const childMeta = await store.readRunMeta(admissionRunsRoot, childId)
      A.equal(childMeta.status, 'pending')
      A.equal(childMeta.started, false, '未写出 run/start 的 child 仍是未开始')
      A.ok(childMeta.restart && childMeta.restart.startRejected, '必须记 startRejected 供重试')

      // 释放槽位后重试：同一个 child 被复用并真正启动。
      gate.resolve()
      A.equal((await startOccupant).status, 'running')
      A.equal((await runtime.wait(occupant.id)).status, 'done')
      const retried = await runtime.restart(oldRun.id)
      A.equal(retried.run.id, childId, '重试必须复用同一个 childRunId')
      A.equal((await runtime.wait(childId)).status, 'done')
    } finally {
      gate.resolve()
      await runtime.dispose().catch(() => {})
    }
  })

  // -------------------------------------------------------------------------
  console.log('runtime · 0.11 F2/F5/F7：世代收口 / 配额键与同步占位 / dispose 还槽')
  // -------------------------------------------------------------------------

  await check('F5：每工作区配额键走 realpath——软链别名不能绕过额度', async () => {
    const flowId = 'flow-f5-symlink'
    await flowStore.saveFlow(admissionFlowsRoot, flowId, oneStageFlow(flowId))
    const runA = await makeAdmissionRun(flowId)
    const runB = await makeAdmissionRun(flowId)
    const runC = await makeAdmissionRun(flowId)
    const realWs = join(home, 'ws-f5-real')
    const aliasWs = join(home, 'ws-f5-alias')
    const otherWs = join(home, 'ws-f5-other')
    mkdirSync(realWs, { recursive: true })
    mkdirSync(otherWs, { recursive: true })
    rmSync(aliasWs, { recursive: true, force: true })
    symlinkSync(realWs, aliasWs)
    const gate = deferred()
    const admission = createAdmissionController({
      controller: {},
      limits: { global: 4, perWorkspace: 1 },
      queueMax: 0,
    })
    const runtime = createRuntimeRaw({
      runsRoot: admissionRunsRoot,
      flowsRoot: admissionFlowsRoot,
      cwd: repoRoot,
      worktree: 'off',
      admission,
      activate: async ({ node }) => {
        await gate.promise
        return passResult(node.id)
      },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    try {
      const startA = runtime.start(runA.id, { workspace: realWs })
        .then(() => true, () => false)
      await until(() => runtime.get(runA.id) !== null, 'runA 没有拿到槽位')

      // 同一目录的软链别名：旧实现用 raw 路径当键，两个 key 各占 1 份 → B 能启动。
      const aliasError = await runtime.start(runB.id, { workspace: aliasWs }).then(() => null, error => error)
      A.ok(aliasError, '软链别名必须被每工作区额度挡住（不能被当成另一个工作区）')
      A.equal(aliasError.status, 429)
      A.equal(aliasError.code, 'RUN_CONCURRENCY_LIMIT')
      A.equal(aliasError.scope, 'workspace')
      A.equal(aliasError.reason, 'workspace-full')
      A.equal(aliasError.workspaceKey, realpathSync(realWs), '配额键必须是 realpath')
      A.equal(runtime.get(runB.id), null)

      // 真的另一个工作区不受影响：额度按 realpath 分桶，不是被一刀切。
      const otherOk = await runtime.start(runC.id, { workspace: otherWs }).then(() => true, () => false)
      A.equal(otherOk, true, '另一个真实工作区仍应能启动')

      gate.resolve()
      A.equal(await startA, true, 'runA 正常收尾')
    } finally {
      gate.resolve()
      await runtime.dispose()
    }
  })

  await check('F5：读快照前同步占 runId——并发重复 start 只能有一个成功', async () => {
    const flowId = 'flow-f5-duplicate-start'
    await flowStore.saveFlow(admissionFlowsRoot, flowId, oneStageFlow(flowId))
    const run = await makeAdmissionRun(flowId)
    const snapshot = await flowStore.readFlow(admissionFlowsRoot, flowId)
    const admission = createAdmissionController({
      controller: {},
      limits: { global: 2, perWorkspace: 2 },
      queueMax: 2,
    })
    let engines = 0
    const runtime = createRuntimeRaw({
      runsRoot: admissionRunsRoot,
      flowsRoot: admissionFlowsRoot,
      cwd: repoRoot,
      worktree: 'off',
      admission,
      createEngine: options => {
        const index = ++engines
        return {
          index,
          async start(id) {
            // 模拟「第一个 start 在第二个读快照的 await 结束前就收尾」：
            // 旧实现没有同步占位，第二个会在此之后重新拿到空槽位再建一个 Engine。
            options.onSettled(id)
            return { id, status: 'done' }
          },
          dispose() {},
          async wait() { return { status: 'done' } },
          async sweepStaleRuns() { return [] },
        }
      },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    try {
      // 第一个带 flowSnapshot（同步路径），第二个必须自己去读快照（走 await）。
      const results = await Promise.allSettled([
        runtime.start(run.id, { workspace: repoRoot, flowSnapshot: snapshot }),
        runtime.start(run.id, { workspace: repoRoot }),
      ])
      A.equal(results[0].status, 'fulfilled', '第一个 start 成功')
      A.equal(results[1].status, 'rejected', '并发重复 start 必须在预检处 409（不许同时通过预检）')
      A.equal(results[1].reason.status, 409)
      A.match(results[1].reason.message, /已在运行/)
      A.equal(engines, 1, '同一个 runId 只能创建一个 Engine（旧实现会建两个）')
    } finally {
      await runtime.dispose()
    }
  })

  await check('F5：流程快照读失败必须显式报错，不能退化为出队时最新流程', async () => {
    const admission = createAdmissionController({
      controller: {},
      limits: { global: 2, perWorkspace: 2 },
      queueMax: 2,
    })
    let engines = 0
    const createEngine = () => {
      engines += 1
      return {
        async start(id) { return { id, status: 'running' } },
        dispose() {},
        async wait() { return { status: 'done' } },
        async sweepStaleRuns() { return [] },
      }
    }
    const runtime = createRuntimeRaw({
      runsRoot: admissionRunsRoot,
      flowsRoot: admissionFlowsRoot,
      cwd: repoRoot,
      worktree: 'off',
      admission,
      createEngine,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    try {
      // ① run.json 指向一个不存在的流程：readFlow 返回 null（旧实现静默跳过快照）。
      const missing = await makeAdmissionRun('flow-f5-snapshot-missing')
      const missingError = await runtime.start(missing.id, { workspace: join(home, 'ws-f5-snap-missing') })
        .then(() => null, error => error)
      A.ok(missingError instanceof EngineError, '流程不存在必须显式报错')
      A.equal(missingError.status, 404)
      A.match(missingError.message, /快照/)
      A.equal(runtime.get(missing.id), null)
      A.equal(engines, 0, '快照失败不创建 Engine')

      // ② 流程文件坏 JSON：readFlow 抛错（旧实现 catch 后继续）。
      const corruptId = 'flow-f5-snapshot-corrupt'
      await flowStore.saveFlow(admissionFlowsRoot, corruptId, oneStageFlow(corruptId))
      writeFileSync(join(admissionFlowsRoot, `${corruptId}.json`), '{not-json')
      const corrupt = await makeAdmissionRun(corruptId)
      const corruptError = await runtime.start(corrupt.id, { workspace: join(home, 'ws-f5-snap-corrupt') })
        .then(() => null, error => error)
      A.ok(corruptError instanceof EngineError, '流程文件损坏必须显式报错')
      A.equal(corruptError.status, 500)
      A.match(corruptError.message, /快照/)
      A.equal(runtime.get(corrupt.id), null)
      A.equal(engines, 0, '读快照抛错也不创建 Engine')
    } finally {
      await runtime.dispose()
    }
  })

  await check('F2：旧实例失权后 settle 不能关掉接管者的 supervision', async () => {
    const flowId = 'flow-f2-takeover'
    await flowStore.saveFlow(admissionFlowsRoot, flowId, oneStageFlow(flowId))
    const run = await makeAdmissionRun(flowId)
    const logs = []
    const sent = []
    const fakeAgent = { status: 'idle', followup(payload) { sent.push(payload) } }
    let oldLease = null
    let settleOld = null
    const runtime = createRuntimeRaw({
      runsRoot: admissionRunsRoot,
      flowsRoot: admissionFlowsRoot,
      cwd: repoRoot,
      worktree: 'off',
      ctx: { get: () => ({ get: () => fakeAgent }) },
      logger: (level, message) => logs.push(`${level}:${message}`),
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
      createEngine: options => {
        const engine = {
          active: null,
          async start(id) {
            // 真正的 Engine 在 start 里 claimLease（epoch+1 / 随机 ownerId）。
            const lease = await store.claimLease(admissionRunsRoot, id)
            oldLease = lease
            engine.active = { lease }
            return { id, status: 'running' }
          },
          wait() { return new Promise(() => {}) },
          dispose() {},
        }
        settleOld = () => options.onSettled(run.id)
        return engine
      },
    })
    try {
      await runtime.start(run.id, { workspace: repoRoot })
      A.ok(oldLease && Number.isInteger(oldLease.epoch), '旧实例必须 claim 到带 epoch 的租约（世代来源）')
      A.ok(typeof oldLease.ownerId === 'string' && oldLease.ownerId !== '')

      // 接管者：旧 owner 释放后新 claim → 新 epoch + 新 ownerId。
      await store.releaseLease(admissionRunsRoot, run.id, { ownerId: oldLease.ownerId })
      const newLease = await store.claimLease(admissionRunsRoot, run.id)
      A.ok(newLease.epoch > oldLease.epoch, `新 owner 必须拿到更高 epoch（${oldLease.epoch} → ${newLease.epoch}）`)
      A.ok(newLease.ownerId !== oldLease.ownerId, '新 owner 必须是不同 ownerId')

      // 新 owner 开启 supervision（接管者刚启用的监督不能被旧实例关掉）。
      const enabled = await runtime.enableSupervision(run.id, {
        enabled: true,
        wakerSessionId: 'sess-f2-new-owner',
      })
      A.equal(enabled.enabled, true)
      A.equal(runtime.supervision.status(run.id).enabled, true)

      // 旧实例失权收口后仍通知 runtime（Engine 的行为不变），这里模拟这次迟到 settle。
      settleOld()
      // 直接断言：清理至少不能同步摘掉接管者的调度登记（旧实现这里立刻变 false）。
      A.equal(runtime.supervision.status(run.id).enabled, true,
        '旧实例 settle 不能同步摘掉接管者的调度登记')
      await until(
        () => logs.some(line => line.includes('跳过 supervision')),
        '旧实例没有按世代跳过 supervision 清理',
        1500,
      )
      A.equal(runtime.supervision.status(run.id).enabled, true, '接管者的调度登记必须保留')
      const meta = await store.readRunMeta(admissionRunsRoot, run.id)
      A.equal(meta.supervision.enabled, true, '接管者的 enabled=true 不能被旧实例覆盖成 false')
      A.equal(meta.supervision.wakerSessionId, 'sess-f2-new-owner', '接管者的唤醒目标必须保留')

      // 唤醒保留：把 run.startedAt 挪到过去，下一轮 tick 必须真的唤醒接管者会话。
      await store.writeRunMeta(admissionRunsRoot, run.id, { startedAt: '2020-01-01T00:00:00.000Z' })
      const tick = await runtime.supervision.tick()
      A.equal(tick.woken, 1, '接管者的 supervision 仍能唤醒')
      A.equal(sent.length, 1, '接管者会话应收到一条 followup')
      A.match(sent[0].content[0].text, new RegExp(run.id))
    } finally {
      await runtime.dispose()
    }
  })

  await check('F7：dispose 超时不能提前还槽——未终止 Engine 仍占全局限额', async () => {
    const flowId = 'flow-f7-dispose-slot'
    await flowStore.saveFlow(admissionFlowsRoot, flowId, oneStageFlow(flowId))
    const admission = createAdmissionController({
      controller: {},
      limits: { global: 1, perWorkspace: 1 },
      queueMax: 0,
    })
    const never = () => ({
      async start(id) { return { id, status: 'running' } },
      // 不响应 abort：永远不会 settle。外部进程也还没退出。
      abort() { return new Promise(() => {}) },
      wait() { return new Promise(() => {}) },
      dispose() {},
      async sweepStaleRuns() { return [] },
    })
    const baseOptions = {
      runsRoot: admissionRunsRoot,
      flowsRoot: admissionFlowsRoot,
      cwd: repoRoot,
      worktree: 'off',
      admission,
      createEngine: never,
      disposeTimeoutMs: 30,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    }
    const runtime = createRuntimeRaw(baseOptions)
    const runA = await makeAdmissionRun(flowId)
    await runtime.start(runA.id, { workspace: join(home, 'ws-f7-a') })
    A.equal(admission.snapshot().active, 1)

    const disposed = await runtime.dispose()
    A.equal(disposed.timedOut, true, '不响应 abort 的 Engine 必须触发有界超时')
    A.equal(admission.snapshot().active, 1, 'Engine 尚未终止，槽位不能被提前归还')

    // 另一个 runtime 用同一份共享账本：第 N+1 个 run 必须仍被限住。
    const runtime2 = createRuntimeRaw(baseOptions)
    try {
      const runB = await makeAdmissionRun(flowId)
      const limitError = await runtime2.start(runB.id, { workspace: join(home, 'ws-f7-b') })
        .then(() => null, error => error)
      A.ok(limitError, '第 N+1 个 run 不能被启动（旧实现 dispose 超时后提前还槽会放行）')
      A.equal(limitError.status, 429)
      A.equal(limitError.code, 'RUN_CONCURRENCY_LIMIT')
      A.equal(limitError.reason, 'queue-full')
      A.equal(runtime2.get(runB.id), null)
      A.equal(admission.snapshot().active, 1)
    } finally {
      await runtime2.dispose()
    }
  })

  await check('F7：Engine 真实终止后才归还槽位（迟到终止释放）', async () => {
    const flowId = 'flow-f7-late-release'
    await flowStore.saveFlow(admissionFlowsRoot, flowId, oneStageFlow(flowId))
    const admission = createAdmissionController({
      controller: {},
      limits: { global: 1, perWorkspace: 1 },
      queueMax: 0,
    })
    const gate = deferred()
    const slow = () => ({
      async start(id) { return { id, status: 'running' } },
      // abort 有响应，但比 disposeTimeoutMs 慢：dispose 先超时，Engine 稍后才真正退出。
      abort() { return gate.promise },
      wait() { return gate.promise },
      dispose() {},
      async sweepStaleRuns() { return [] },
    })
    const options = {
      runsRoot: admissionRunsRoot,
      flowsRoot: admissionFlowsRoot,
      cwd: repoRoot,
      worktree: 'off',
      admission,
      createEngine: slow,
      disposeTimeoutMs: 20,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    }
    const runtime = createRuntimeRaw(options)
    const runA = await makeAdmissionRun(flowId)
    await runtime.start(runA.id, { workspace: join(home, 'ws-f7-late-a') })
    const disposed = await runtime.dispose()
    A.equal(disposed.timedOut, true)
    A.equal(admission.snapshot().active, 1, 'dispose 超时后仍占着槽位')

    gate.resolve()
    await until(() => admission.snapshot().active === 0, 'Engine 真实终止后槽位没有归还', 1500)

    // 槽位归还后，第 N+1 个 run 可以启动。
    const runtime2 = createRuntimeRaw({ ...options, createEngine: () => ({
      async start(id) { return { id, status: 'done' } },
      async wait() { return { status: 'done' } },
      dispose() {},
      async sweepStaleRuns() { return [] },
    }) })
    try {
      const runB = await makeAdmissionRun(flowId)
      const started = await runtime2.start(runB.id, { workspace: join(home, 'ws-f7-late-b') })
        .then(() => true, () => false)
      A.equal(started, true, '真实终止后新 run 必须能拿到槽位')
    } finally {
      await runtime2.dispose()
    }
  })


} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nruntime §5 自检：${checks} 组通过（${assertionCount} 条断言）`)
