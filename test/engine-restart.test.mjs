#!/usr/bin/env node
/**
 * v0.9.2 前置 · 任务 2 / 3 的引擎侧自检（不启动 dsh，纯注入假宿主）。
 *
 * 覆盖：
 *   - 阶段节点的 `flow_node_reject` 按「是否有出向 reject 边」门控注册；
 *   - 工具被调用后真的走既有 reject 分支（reject/trigger → 目标 attempt+1 重跑）；
 *   - 失败 run restart：新 run 继承节点会话、跳过已完成节点、按当前结构重挂工具；
 *   - 结构删边后 restart：旧会话不再拿到工具；
 *   - 旧 run 终态不被改写；restart 的 meta / 日志可诊断。
 *
 * 测试目录放在项目 `.tmp/` 下（不占系统 /tmp）。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-restart-'))
const testWorkspace = join(home, 'workspace')
mkdirSync(testWorkspace, { recursive: true })

const engineModule = await import('../src/engine.js')
const store = await import('../src/runstore.js')
const flowStore = await import('../src/store.js')
const runtimeModule = await import('../src/runtime.js')

const { createEngine: createEngineRaw, nodeSessionId } = engineModule
const createRuntime = runtimeModule.createRuntime

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

const createEngine = options => createEngineRaw({
  worktree: 'off', cwd: testWorkspace, nodeRetries: 0, ...options,
})

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

function startNode() {
  return { id: 'n_start', kind: 'start', title: '任务输入', x: 0, y: 200, mode: 'single', role: '', task: '接任务', outputs: '', skills: [], maxRounds: 2, team: [], model: '' }
}

function endNode() {
  return { id: 'n_end', kind: 'end', title: '完成', x: 900, y: 200, mode: 'single', role: '', task: '', outputs: '', skills: [], maxRounds: 2, team: [], model: '' }
}

function next(id, from, to) {
  return { id, from, to, kind: 'next', label: '' }
}

function reject(id, from, to) {
  return { id, from, to, kind: 'reject', label: '打回' }
}

function flowOf(id, nodes, edges) {
  return {
    schemaVersion: 1,
    id,
    name: `流程 ${id}`,
    description: '',
    createdAt: '2026-11-07T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z',
    nodes,
    edges,
  }
}

async function saveFlow(flow) {
  return flowStore.saveFlow(flowsRoot, flow.id, flow)
}

async function makeRun(flowId, nodeTotal) {
  return store.createRun(runsRoot, { flowId, flowName: `流程 ${flowId}`, nodeTotal })
}

async function eventsOf(runId) {
  const all = await store.readAllEvents(runsRoot, runId)
  return all ? all.events : []
}

function passStructured(nodeId) {
  return {
    verdict: 'pass',
    summary: `${nodeId} 通过`,
    artifacts: [{ name: `${nodeId}-结论.md`, content: `# ${nodeId}\n\n通过。\n` }],
    findings: [{ id: `${nodeId}-F1`, severity: 'P2', title: '小问题', status: 'verified' }],
    checks: { ruleSetId: `rules-${nodeId}`, ruleSetVersion: '1', executor: 'test', passedChecks: 1, totalChecks: 1 },
    acceptance: [{ itemId: `${nodeId}-R1`, status: 'pass', decidedBy: 'auto' }],
    tests: { suite: `unit-${nodeId}`, executed: 1, passed: 1, failed: 0, skipped: 0 },
  }
}

/** 从提示词里取 attempt / nonce（引擎的正式结论契约）。 */
function envelopeOf(payload) {
  const text = payload && Array.isArray(payload.content)
    ? payload.content.filter(block => block && block.type === 'text').map(block => block.text).join('\n')
    : ''
  const attempt = /^- attempt: (\d+)$/m.exec(text)
  const nonce = /^- nonce: (.+)$/m.exec(text)
  if (!attempt || !nonce) return null
  return { attempt: Number(attempt[1]), nonce: nonce[1].trim() }
}

/**
 * 0.2.2 假宿主：create 校验 provider+model 成对；会话可 get/resume；每个 agent 带
 * 一个按会话隔离的 tools 注册表（记录注册 / 注销，用于断言门控）。
 *
 * behaviorOf(nodeId, { sessionId, calls, attempt, registrations }) 返回：
 *   - { kind:'pass' } / undefined  → 回 pass JSON；
 *   - { kind:'fail' }              → 不回消息（引擎按结构不合格失败）；
 *   - { kind:'tool-reject' }       → 调 flow_node_reject 后回 pass JSON。
 */
function fakeHost(engineRef, behaviorOf) {
  const created = []
  const resumed = []
  const resumeOptions = []
  const live = new Map()
  const sessions = new Set()
  const calls = []
  /** sessionId → Map<toolName, {definition, dispose}>（模拟宿主工具注册表） */
  const registries = new Map()
  const nodeIdsCache = []

  function nodeOfSession(sessionId) {
    for (const nodeId of nodeIdsCache) {
      if (sessionId.endsWith(`--${nodeId}`)) return nodeId
    }
    return null
  }

  function registryOf(sessionId) {
    if (!registries.has(sessionId)) registries.set(sessionId, new Map())
    return registries.get(sessionId)
  }

  function agentFor(sessionId) {
    const registry = registryOf(sessionId)
    const tools = {
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
      restrict() {
        return () => {}
      },
    }
    return {
      session: { id: sessionId, header: {} },
      ctx: { tools },
      followup(payload) {
        const nodeId = nodeOfSession(sessionId)
        const envelope = envelopeOf(payload)
        // v0.9.2：新建会话先收到一条预热轮（无 attempt/nonce 契约）。真实宿主回一句 ok
        // 就结束这一轮，不参与正式结论；否则测试会把预热轮当成节点结论。
        if (!envelope) return
        const registrations = [...registry.keys()]
        const call = { sessionId, nodeId, registrations, envelope }
        calls.push(call)
        const behavior = behaviorOf(nodeId, call) || { kind: 'pass' }
        if (behavior.kind === 'fail') return
        if (behavior.kind === 'reject') {
          // 0.10 R9：模型直接给结构化 verdict=reject（不经过打回工具）。
          const structured = {
            attempt: envelope.attempt,
            nonce: envelope.nonce,
            verdict: 'reject',
            summary: `${nodeId} 判定打回`,
            rejectReason: behavior.reason || '验收不通过，打回返工',
            ...(behavior.rejectTarget === undefined ? {} : { rejectTarget: behavior.rejectTarget }),
            findings: [{ id: `${nodeId}-F1`, severity: 'P1', title: '验收不通过', status: 'open' }],
          }
          engineRef.value.handleSessionEvent({ id: sessionId }, {
            type: 'assistant/message',
            data: {
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(structured)}\n\`\`\`` }],
              },
            },
          })
          return
        }
        if (behavior.kind === 'tool-reject') {
          const tool = registry.get('flow_node_reject')
          if (!tool) {
            // 让测试明确看到「该有的工具没挂」。
            calls.push({ sessionId, nodeId, error: 'flow_node_reject 未注册' })
            return
          }
          // execute 是 async，但 body 在第一个 await 前同步登记 pending reject。
          tool.execute({ reason: behavior.reason || '验收不通过，打回返工', findings: ['缺少验收证据'] })
        }
        const structured = envelope
          ? { attempt: envelope.attempt, nonce: envelope.nonce, ...passStructured(nodeId) }
          : passStructured(nodeId)
        engineRef.value.handleSessionEvent({ id: sessionId }, {
          type: 'assistant/message',
          data: {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(structured)}\n\`\`\`` }],
            },
          },
        })
      },
      async whenIdle() {},
    }
  }

  const ctx = {
    on() {
      return () => {}
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
      }
      if (name !== 'agents') return undefined
      return {
        async create(options) {
          const route = options.agentOptions
          if (!route || typeof route.provider !== 'string' || route.provider === ''
            || typeof route.model !== 'string' || route.model === '') {
            throw new TypeError('agentOptions.provider + agentOptions.model 必须成对')
          }
          created.push(options)
          const sessionId = options.sessionId
          sessions.add(sessionId)
          live.set(sessionId, agentFor(sessionId))
          return {
            agent: live.get(sessionId),
            async dispose() {
              live.delete(sessionId)
            },
          }
        },
        get(sessionId) {
          return live.get(sessionId) || null
        },
        async resume(options) {
          const sessionId = options.resumeSessionId
          if (!sessions.has(sessionId)) {
            throw new Error(`会话 ${sessionId} 不存在，无法 resume`)
          }
          resumed.push(sessionId)
          // 0.10 R1：记录完整 resume 入参，断言 agentOptions 是成对路由。
          resumeOptions.push(options)
          live.set(sessionId, agentFor(sessionId))
          return {
            agent: live.get(sessionId),
            async dispose() {
              live.delete(sessionId)
            },
          }
        },
      }
    },
  }
  return {
    ctx,
    created,
    resumed,
    resumeOptions,
    calls,
    registrationsOf: sessionId => [...registryOf(sessionId).keys()],
    /** 模拟宿主重启后仍能 resume 的历史会话（session 持久化在宿主侧，不在 run 目录里）。 */
    adoptSessions(table) {
      for (const entry of Object.values(table || {})) {
        if (entry && typeof entry.sessionId === 'string') sessions.add(entry.sessionId)
      }
    },
    rememberNodes(nodes) {
      for (const node of nodes) {
        if (node && typeof node.id === 'string' && !nodeIdsCache.includes(node.id)) nodeIdsCache.push(node.id)
      }
    },
  }
}

// ---------------------------------------------------------------------------
console.log('任务 2 · flow_node_reject 按流程结构门控')

await check('有出向 reject 边的阶段节点注册工具；无边的阶段节点不注册；开始/结束节点无会话', async () => {
  const flow = flowOf('flow-gate', [
    startNode(), stage('n_a', 'A', 300), stage('n_b', 'B', 600), stage('n_c', 'C', 900), endNode(),
  ], [
    next('e1', 'n_start', 'n_a'),
    next('e2', 'n_a', 'n_b'),
    next('e3', 'n_b', 'n_c'),
    next('e4', 'n_c', 'n_end'),
    reject('r1', 'n_c', 'n_a'),
  ])
  await saveFlow(flow)
  const run = await makeRun('flow-gate', 3)
  const engineRef = { value: null }
  const host = fakeHost(engineRef, () => ({ kind: 'pass' }))
  host.rememberNodes(flow.nodes)
  const engine = createEngine({ runsRoot, flowsRoot, ctx: host.ctx })
  engineRef.value = engine
  await engine.start(run.id)
  const final = await engine.wait(run.id)
  A.equal(final.status, 'done')
  const byNode = new Map()
  for (const call of host.calls) {
    if (!call.nodeId) continue
    if (!byNode.has(call.nodeId)) byNode.set(call.nodeId, [])
    byNode.get(call.nodeId).push(call)
  }
  A.deepEqual(byNode.get('n_a')[0].registrations, [], 'A 没有出向 reject 边 → 不该挂工具')
  A.deepEqual(byNode.get('n_b')[0].registrations, [], 'B 没有出向 reject 边 → 不该挂工具')
  A.ok(byNode.get('n_c')[0].registrations.includes('flow_node_reject'), 'C 有出向 reject 边 → 必须挂工具')
  A.equal(host.created.length, 3, '开始 / 结束节点不建会话')
})

await check('工具被调用后引擎真的走 reject 分支（reject/trigger + 目标 attempt+1 重跑）', async () => {
  const flow = flowOf('flow-tool-reject', [
    startNode(), stage('n_a', 'A', 300), stage('n_b', 'B', 600), stage('n_c', 'C', 900), endNode(),
  ], [
    next('e1', 'n_start', 'n_a'),
    next('e2', 'n_a', 'n_b'),
    next('e3', 'n_b', 'n_c'),
    next('e4', 'n_c', 'n_end'),
    reject('r1', 'n_c', 'n_a'),
  ])
  await saveFlow(flow)
  const run = await makeRun('flow-tool-reject', 3)
  const engineRef = { value: null }
  let cCalls = 0
  const host = fakeHost(engineRef, nodeId => {
    if (nodeId !== 'n_c') return { kind: 'pass' }
    cCalls += 1
    return cCalls === 1 ? { kind: 'tool-reject' } : { kind: 'pass' }
  })
  host.rememberNodes(flow.nodes)
  const engine = createEngine({ runsRoot, flowsRoot, ctx: host.ctx })
  engineRef.value = engine
  await engine.start(run.id)
  const final = await engine.wait(run.id)
  A.equal(final.status, 'done')
  const events = await eventsOf(run.id)
  const rejected = events.find(event => event.kind === 'node/end'
    && event.nodeId === 'n_c' && event.attemptId === 1)
  A.equal(rejected.data.status, 'rejected')
  const trigger = events.find(event => event.kind === 'reject/trigger')
  A.ok(Boolean(trigger), '必须写 reject/trigger（复用既有回退通道）')
  A.equal(trigger.nodeId, 'n_c')
  A.equal(trigger.data.toNodeId, 'n_a')
  A.match(trigger.data.reason, /验收不通过/)
  // 打回后 A / B / C 各再跑一次（attempt=2）。
  const startsA = events.filter(event => event.kind === 'node/start' && event.nodeId === 'n_a')
  A.equal(startsA.length, 2)
  A.equal(startsA[1].attemptId, 2)
  const startsC = events.filter(event => event.kind === 'node/start' && event.nodeId === 'n_c')
  A.equal(startsC.length, 2)
  A.equal(startsC[1].attemptId, 2)
  // 第二轮的 C 会话仍然挂着工具（attempt=2 重挂）。
  const cCallsLogged = host.calls.filter(call => call.nodeId === 'n_c' && call.registrations)
  A.ok(cCallsLogged[1].registrations.includes('flow_node_reject'))
})

// ---------------------------------------------------------------------------
console.log('任务 3 · 失败后 restart：新 run / 原会话续跑 / 按新结构重挂工具')

async function failedAtB({ flowId, withRejectEdge }) {
  const edges = [
    next('e1', 'n_start', 'n_a'),
    next('e2', 'n_a', 'n_b'),
    next('e3', 'n_b', 'n_c'),
    next('e4', 'n_c', 'n_end'),
    ...(withRejectEdge ? [reject('r1', 'n_b', 'n_a')] : []),
  ]
  const flow = flowOf(flowId, [
    startNode(), stage('n_a', 'A', 300), stage('n_b', 'B', 600), stage('n_c', 'C', 900), endNode(),
  ], edges)
  await saveFlow(flow)
  const run = await makeRun(flowId, 3)
  const engineRef = { value: null }
  const host = fakeHost(engineRef, nodeId => (nodeId === 'n_b' ? { kind: 'fail' } : { kind: 'pass' }))
  host.rememberNodes(flow.nodes)
  const runtime = createRuntime({
    ctx: host.ctx,
    runsRoot,
    flowsRoot,
    worktree: 'off',
    cwd: testWorkspace,
    nodeRetries: 0,
    logger: () => {},
  })
  engineRef.value = { handleSessionEvent: (...args) => runtime.get(run.id).handleSessionEvent(...args) }
  await runtime.start(run.id, { workspace: testWorkspace })
  const failed = await runtime.wait(run.id)
  A.equal(failed.status, 'failed')
  // 会话已落 sessions.json（A / B 至少各一条；B 的会话在失败前创建）。
  const sessions = await store.readNodeSessions(runsRoot, run.id)
  A.ok(typeof sessions.n_a?.sessionId === 'string')
  A.ok(typeof sessions.n_b?.sessionId === 'string')
  return { flow, run, failed, sessions, host, runtime }
}

await check('restart：新 run 继承旧会话、跳过已完成节点、旧 run 终态不改、restart 记录可读', async () => {
  const old = await failedAtB({ flowId: 'flow-restart-ok', withRejectEdge: false })
  // 结构变化：加一条 B→A 的 reject 边，重启时 B 会话应补挂工具。
  const changed = {
    ...old.flow,
    edges: [...old.flow.edges, reject('r1', 'n_b', 'n_a')],
  }
  await saveFlow(changed)
  // 重启后：B 恢复并通过（同一个 session），C 通过。
  const engineRef = { value: null }
  const host = fakeHost(engineRef, () => ({ kind: 'pass' }))
  host.rememberNodes(changed.nodes)
  // 宿主重启后仍持有旧会话的持久化；新 runtime 的假宿主通过 resume 重新打开它们。
  host.adoptSessions(old.sessions)
  // 把旧 runtime 的实例换成新的假宿主：restart 走同一个 runtime，但 runtime 的 ctx 已绑定旧 host，
  // 所以这里直接构造新 runtime（共享 runsRoot / flowsRoot），旧 run 仍是 failed。
  const runtime = createRuntime({
    ctx: host.ctx,
    runsRoot,
    flowsRoot,
    worktree: 'off',
    cwd: testWorkspace,
    nodeRetries: 0,
    logger: () => {},
  })
  engineRef.value = { handleSessionEvent: (session, event) => {
    // 新 run 的实例可能还没建好：按最近活跃实例转发。
    const engine = runtime.list().map(id => runtime.get(id)).find(Boolean)
    if (engine) engine.handleSessionEvent(session, event)
  } }
  const oldMetaBefore = await store.readRunMeta(runsRoot, old.run.id)
  const oldEventCountBefore = (await eventsOf(old.run.id)).length
  A.equal(runtime.restart.length > 0, true)
  const result = await runtime.restart(old.run.id, { note: 'B 节点验收失败后补上打回边再续跑' })
  const final = await runtime.wait(result.run.id)
  A.equal(final.status, 'done')
  // 1) 新 run 的节点会话 id 与旧 run 相同（A 跳过、B/C 复用）。
  const newSessions = await store.readNodeSessions(runsRoot, result.run.id)
  A.equal(newSessions.n_a.sessionId, old.sessions.n_a.sessionId)
  A.equal(newSessions.n_b.sessionId, old.sessions.n_b.sessionId)
  // C 在旧 run 里没跑到（B 失败），新 run 才建会话 —— 这是新增节点，不是继承。
  A.ok(typeof newSessions.n_c?.sessionId === 'string')
  // 2) 已完成节点 A 不重跑；B 是续跑起点（同一 session，走 resume）。
  const newEvents = await eventsOf(result.run.id)
  A.equal(newEvents.some(event => event.kind === 'node/start' && event.nodeId === 'n_a'), false)
  A.equal(newEvents.some(event => event.kind === 'node/start' && event.nodeId === 'n_b'), true)
  A.ok(host.resumed.includes(old.sessions.n_b.sessionId), 'B 的冷会话必须靠 agents.resume 续跑')
  // 2b) 0.10 R1：创建时实际传的成对路由落进 sessions.json；restart 继承它；resume 收到同一对。
  A.deepEqual(old.sessions.n_b.agentOptions, { provider: 'test-provider', model: 'test-model' },
    '创建时实际传的路由对必须落进 sessions.json')
  A.deepEqual(newSessions.n_b.agentOptions, { provider: 'test-provider', model: 'test-model' },
    '新 run 继承旧 run 的 sessions.json route')
  const bResume = host.resumeOptions.find(options => options.resumeSessionId === old.sessions.n_b.sessionId)
  A.ok(bResume, 'B 必须走 resume')
  A.deepEqual(bResume.agentOptions, { provider: 'test-provider', model: 'test-model' })
  // 3) 工具按新结构补挂：B 现在有出向 reject 边。
  const bCalls = host.calls.filter(call => call.nodeId === 'n_b' && Array.isArray(call.registrations))
  A.ok(bCalls.length > 0)
  A.ok(bCalls[0].registrations.includes('flow_node_reject'), '结构加边后 restart，B 必须补挂打回工具')
  // 4) restart 记录 / 旧 run 终态。
  const newMeta = await store.readRunMeta(runsRoot, result.run.id)
  A.equal(newMeta.restart.fromRunId, old.run.id)
  A.equal(newMeta.restart.attempt, 1)
  A.equal(newMeta.restart.startNodeId, 'n_b')
  A.deepEqual(newMeta.restart.skippedNodeIds, ['n_a'])
  A.match(newMeta.restart.oldReason, /n_b|结构/)
  A.equal(newMeta.restart.note, 'B 节点验收失败后补上打回边再续跑')
  const startEvent = newEvents.find(event => event.kind === 'run/start')
  A.equal(startEvent.data.restart.fromRunId, old.run.id)
  A.equal(startEvent.data.restart.startNodeId, 'n_b')
  const oldMetaAfter = await store.readRunMeta(runsRoot, old.run.id)
  A.equal(oldMetaAfter.status, 'failed')
  A.equal(oldMetaAfter.endedAt, oldMetaBefore.endedAt)
  A.equal((await eventsOf(old.run.id)).length, oldEventCountBefore)
})

await check('restart：结构删边后旧会话不再拿到打回工具（disposer 生效）', async () => {
  const old = await failedAtB({ flowId: 'flow-restart-noedge', withRejectEdge: true })
  // 删掉 B→A 的 reject 边：重启后 B 仍会续跑，但工具必须撤掉。
  const changed = {
    ...old.flow,
    edges: old.flow.edges.filter(edge => !(edge.from === 'n_b' && edge.kind === 'reject')),
  }
  await saveFlow(changed)
  const engineRef = { value: null }
  const host = fakeHost(engineRef, () => ({ kind: 'pass' }))
  host.rememberNodes(changed.nodes)
  host.adoptSessions(old.sessions)
  const runtime = createRuntime({
    ctx: host.ctx,
    runsRoot,
    flowsRoot,
    worktree: 'off',
    cwd: testWorkspace,
    nodeRetries: 0,
    logger: () => {},
  })
  engineRef.value = { handleSessionEvent: (session, event) => {
    const engine = runtime.list().map(id => runtime.get(id)).find(Boolean)
    if (engine) engine.handleSessionEvent(session, event)
  } }
  const result = await runtime.restart(old.run.id)
  const final = await runtime.wait(result.run.id)
  A.equal(final.status, 'done')
  A.equal(result.plan.startNodeId, 'n_b')
  const bCalls = host.calls.filter(call => call.nodeId === 'n_b' && Array.isArray(call.registrations))
  A.ok(bCalls.length > 0)
  A.deepEqual(bCalls[0].registrations, [], '结构删边后 B 不该再挂 flow_node_reject')
  A.ok(host.resumed.includes(old.sessions.n_b.sessionId))
})

await check('restart 的失败原因可诊断：非终态 / 已成功 / 结构不合法都给中文 4xx', async () => {
  const flow = flowOf('flow-restart-errors', [
    startNode(), stage('n_a', 'A', 300), stage('n_b', 'B', 600), endNode(),
  ], [
    next('e1', 'n_start', 'n_a'),
    next('e2', 'n_a', 'n_b'),
    next('e3', 'n_b', 'n_end'),
  ])
  await saveFlow(flow)
  const pending = await makeRun('flow-restart-errors', 2)
  const engineRef = { value: null }
  const host = fakeHost(engineRef, () => ({ kind: 'pass' }))
  host.rememberNodes(flow.nodes)
  const runtime = createRuntime({ ctx: host.ctx, runsRoot, flowsRoot, worktree: 'off', cwd: testWorkspace, nodeRetries: 0, logger: () => {} })
  engineRef.value = { handleSessionEvent: () => {} }
  let pendingError = null
  try {
    await runtime.restart(pending.id)
  } catch (error) {
    pendingError = error
  }
  A.ok(pendingError, 'pending run 不能重启')
  A.equal(pendingError.status, 400)
  A.match(pendingError.message, /还没结束/)

  // 已成功 run：另起一个能跑完的 run。
  const doneRun = await makeRun('flow-restart-errors', 2)
  const engine = runtime.get(doneRun.id) ? null : createEngine({ runsRoot, flowsRoot, ctx: host.ctx })
  engineRef.value = engine
  await engine.start(doneRun.id, { workspace: testWorkspace })
  const doneFinal = await engine.wait(doneRun.id)
  A.equal(doneFinal.status, 'done')
  let doneError = null
  try {
    await runtime.restart(doneRun.id)
  } catch (error) {
    doneError = error
  }
  A.ok(doneError, 'done run 不能重启')
  A.equal(doneError.status, 400)
  A.match(doneError.message, /不需要重启/)
})

// ---------------------------------------------------------------------------
console.log('任务 2 · R9 旁路：无出向 reject 边但模型仍判 reject')

await check('无 reject 边 → 保留失败（不降级 pass）+ 可行动文案 + node/end.extra.rejectBypass', async () => {
  const flow = flowOf('flow-bypass', [
    startNode(), stage('n_a', 'A', 300), stage('n_b', 'B', 600), endNode(),
  ], [
    next('e1', 'n_start', 'n_a'),
    next('e2', 'n_a', 'n_b'),
    next('e3', 'n_b', 'n_end'),
    // 故意没有从 n_b 出发的 reject 边。
  ])
  await saveFlow(flow)
  const run = await makeRun('flow-bypass', 2)
  const engineRef = { value: null }
  const host = fakeHost(engineRef, nodeId => (nodeId === 'n_b' ? { kind: 'reject' } : { kind: 'pass' }))
  host.rememberNodes(flow.nodes)
  const engine = createEngine({ runsRoot, flowsRoot, ctx: host.ctx, nodeRetries: 0 })
  engineRef.value = engine
  await engine.start(run.id)
  const final = await engine.wait(run.id)
  A.equal(final.status, 'failed', '旁路必须保留失败（不降级为 pass）')

  const events = await eventsOf(run.id)
  const runEnd = events.find(event => event.kind === 'run/end')
  A.equal(runEnd.data.status, 'failed')
  A.match(runEnd.data.reason, /没有任何 reject 边|没有配置任何 reject 边/)
  A.match(runEnd.data.reason, /补一条从该节点出发的打回边/, '必须给可行动的指引')
  A.match(runEnd.data.reason, /修复后重启/)
  A.match(runEnd.data.reason, /或把结论改为 pass/)

  const rejectedEnd = events.find(event => (
    event.kind === 'node/end' && event.nodeId === 'n_b' && event.data.status === 'rejected'
  ))
  A.ok(rejectedEnd, 'n_b 必须留下 node/end rejected')
  A.equal(rejectedEnd.extra.rejectBypass, 'no-edge')
  // 不降级：没有把 n_b 写成 passed，也没有 reject/trigger。
  A.equal(
    events.some(event => event.kind === 'node/end' && event.nodeId === 'n_b' && event.data.status === 'passed'),
    false,
  )
  A.equal(events.some(event => event.kind === 'reject/trigger'), false)
  // 旁路只影响被判定打回的节点：A 仍 passed。
  A.equal(
    events.some(event => event.kind === 'node/end' && event.nodeId === 'n_a' && event.data.status === 'passed'),
    true,
  )
})

await check('R9 旁路在 legacy 主循环同样生效（逃生门路径不能漏补丁）', async () => {
  const flow = flowOf('flow-bypass-legacy', [
    startNode(), stage('n_a', 'A', 300), stage('n_b', 'B', 600), endNode(),
  ], [
    next('e1', 'n_start', 'n_a'),
    next('e2', 'n_a', 'n_b'),
    next('e3', 'n_b', 'n_end'),
  ])
  await saveFlow(flow)
  const run = await makeRun('flow-bypass-legacy', 2)
  const engineRef = { value: null }
  const host = fakeHost(engineRef, nodeId => (nodeId === 'n_b' ? { kind: 'reject' } : { kind: 'pass' }))
  host.rememberNodes(flow.nodes)
  const engine = createEngine({ runsRoot, flowsRoot, ctx: host.ctx, nodeRetries: 0 })
  engineRef.value = engine
  const previous = process.env.FLOW_STUDIO_FLOW_MACHINE
  process.env.FLOW_STUDIO_FLOW_MACHINE = '0'
  try {
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'failed', 'legacy 路径也必须保留失败（不降级 pass）')
    const events = await eventsOf(run.id)
    const runEnd = events.find(event => event.kind === 'run/end')
    A.match(runEnd.data.reason, /补一条从该节点出发的打回边/)
    A.match(runEnd.data.reason, /修复后重启/)
    const rejectedEnd = events.find(event => (
      event.kind === 'node/end' && event.nodeId === 'n_b' && event.data.status === 'rejected'
    ))
    A.ok(rejectedEnd, 'legacy 路径也要写 node/end rejected')
    A.equal(rejectedEnd.extra.rejectBypass, 'no-edge',
      '删掉 legacy 路径的 rejectBypass 必须变红')
    A.equal(events.some(event => event.kind === 'reject/trigger'), false)
  } finally {
    if (previous === undefined) delete process.env.FLOW_STUDIO_FLOW_MACHINE
    else process.env.FLOW_STUDIO_FLOW_MACHINE = previous
  }
})

await check('A9.4 收尾：run 结束后 nodeTools 注册表清空，宿主 disposer 全部调用', async () => {
  const flow = flowOf('flow-dispose-all', [
    startNode(), stage('n_a', 'A', 300), stage('n_c', 'C', 900), endNode(),
  ], [
    next('e1', 'n_start', 'n_a'),
    next('e2', 'n_a', 'n_c'),
    next('e3', 'n_c', 'n_end'),
    reject('r1', 'n_c', 'n_a'),
  ])
  await saveFlow(flow)
  const run = await makeRun('flow-dispose-all', 2)
  const engineRef = { value: null }
  const host = fakeHost(engineRef, () => ({ kind: 'pass' }))
  host.rememberNodes(flow.nodes)
  const engine = createEngine({ runsRoot, flowsRoot, ctx: host.ctx })
  engineRef.value = engine
  await engine.start(run.id)
  A.equal((await engine.wait(run.id)).status, 'done')
  A.equal(engine.nodeTools.size, 0, 'run 收尾后引擎侧注册表必须为空')
  for (const sessionId of new Set(host.calls.map(call => call.sessionId))) {
    A.deepEqual(host.registrationsOf(sessionId), [],
      'run 收尾后宿主注册表必须为空（disposer 已调用）：' + sessionId)
  }
})

await check('restart 服务端互斥：同一旧 run 的第二个重启被 400（审查 F11）', async () => {
  const old = await failedAtB({ flowId: 'flow-restart-mutex', withRejectEdge: false })
  const engineRef = { value: null }
  const host = fakeHost(engineRef, () => ({ kind: 'pass' }))
  host.rememberNodes(old.flow.nodes)
  host.adoptSessions(old.sessions)
  const runtime = createRuntime({
    ctx: host.ctx,
    runsRoot,
    flowsRoot,
    worktree: 'off',
    cwd: testWorkspace,
    nodeRetries: 0,
    logger: () => {},
  })
  engineRef.value = { handleSessionEvent: (session, event) => {
    const engine = runtime.list().map(id => runtime.get(id)).find(Boolean)
    if (engine) engine.handleSessionEvent(session, event)
  } }
  // 第一次重启成功；第二次（顺序）必须因「已有续跑 run」被拒，不能复制第二份会话。
  const first = await runtime.restart(old.run.id)
  await runtime.wait(first.run.id)
  let second = null
  try {
    await runtime.restart(old.run.id)
  } catch (error) {
    second = error
  }
  A.ok(second, '第二次 restart 必须失败，不能并排复制会话')
  A.equal(second.status, 400, '应给可读 400（不是 500）')
  A.match(second.message, /已经有续跑 run/)
  // 并发也只有一个成功（进程内互斥 + 子 run 检查双保险）。
  const before = (await store.listRuns(runsRoot, { limit: 100 })).runs
    .filter(item => item.id !== old.run.id).length
  const results = await Promise.allSettled([
    runtime.restart(old.run.id),
    runtime.restart(old.run.id),
  ])
  A.equal(results.filter(item => item.status === 'fulfilled').length, 0,
    '已有续跑 run 时并发请求全部被拒')
  const after = (await store.listRuns(runsRoot, { limit: 100 })).runs
    .filter(item => item.id !== old.run.id).length
  A.equal(after, before, '被拒的重启不能新增 run')
})

// ---------------------------------------------------------------------------
// A（0.12.3）：停止来源归因 —— runtime.dispose（宿主卸载 / 服务重启）必须写「引擎中断」
// ---------------------------------------------------------------------------
await check('A：runtime.dispose() 杀掉在飞 run → run/end.reason=引擎中断（不是「已停止」）', async () => {
  const flow = flowOf('flow-dispose-source', [
    startNode(), stage('n_hang', '长任务', 300), endNode(),
  ], [
    next('e1', 'n_start', 'n_hang'),
    next('e2', 'n_hang', 'n_end'),
  ])
  await saveFlow(flow)
  const run = await makeRun('flow-dispose-source', 1)
  let resolveStarted
  const started = new Promise(resolve => { resolveStarted = resolve })
  const runtimeRef = { value: null }
  const ctx = {
    on() {
      return () => {}
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
      }
      if (name !== 'agents') return undefined
      return {
        async create(options) {
          const sessionId = options.sessionId
          let resolveIdle = null
          const armIdle = () => {
            const promise = new Promise(resolve => { resolveIdle = resolve })
            return promise
          }
          let idle = armIdle()
          const agent = {
            session: { id: sessionId, header: {} },
            followup(payload) {
              // 真实宿主的 whenIdle() 每轮一个新 promise：先武装本轮，再按阶段决定是否放行。
              idle = armIdle()
              const envelope = envelopeOf(payload)
              if (!envelope) {
                // 预热轮：回一句 ok 并结束本轮。
                const engine = runtimeRef.value && runtimeRef.value.get(run.id)
                if (engine) {
                  engine.handleSessionEvent({ id: sessionId }, {
                    type: 'assistant/message',
                    data: {
                      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
                    },
                  })
                }
                if (resolveIdle) resolveIdle()
                return
              }
              // 正式轮：挂住不返回，等 runtime.dispose() 从外部打断。
              resolveStarted()
            },
            whenIdle() {
              return idle
            },
          }
          return { agent, dispose: async () => {} }
        },
        get() {
          return null
        },
      }
    },
  }
  const runtime = createRuntime({
    ctx,
    runsRoot,
    flowsRoot,
    worktree: 'off',
    cwd: testWorkspace,
    nodeRetries: 0,
    logger: () => {},
  })
  runtimeRef.value = runtime
  await runtime.start(run.id)
  await started

  const disposed = await runtime.dispose()
  const events = await eventsOf(run.id)
  const runEnd = events.find(event => event.kind === 'run/end')
  const nodeEnd = events.find(event => event.kind === 'node/end')

  A.equal(disposed.aborted, 1, '必须中止一个在飞 Engine')
  A.ok(Boolean(runEnd), '必须写 run/end')
  A.equal(runEnd.data.status, 'aborted')
  A.equal(runEnd.data.reason, '引擎中断（宿主卸载 / 服务重启）',
    '宿主卸载 / 服务重启不能用「已停止」冒充用户停止')
  A.equal(nodeEnd.extra.reason, '引擎中断（宿主卸载 / 服务重启）', '节点 extra.reason 同步')
})

console.log(`\n${checks} 组通过（${assertionCount} 条断言）`)
