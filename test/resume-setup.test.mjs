#!/usr/bin/env node
/**
 * 冷会话 resume 必须挂 preset 组合（0.12.1 P0 回归）。
 *
 * 线上事故（2026-11-09 13:53）：supervision 唤醒冷会话时 `agents.resume()` 没带
 * `setup`，会话被冷恢复后只剩宿主层插件工具（37 个），`bash` 报 unknown tool、
 * 随后 31 条 tool-removal。根因：DSH 只在 `agents.create()` / `agents.resume()`
 * 的 setup 回调里挂 agent preset 组合。
 *
 * 本文件全部走注入桩：不启动 dsh、不 import 任何 dsh 包；run 目录落在项目 `.tmp/`。
 * 覆盖三处冷路径（supervision 唤醒 / 节点自检闹钟 / 收件箱投递）都带 setup，且：
 *   - setup 里优先用日志最后一条 `agent-preset/selected`，其次 header；
 *   - 记录的 preset 挂载失败 → 降级宿主默认 + 一条 warn，resume 不失败；
 *   - 完全没有 preset 服务 → 一条 warn，resume 仍成功；
 *   - 活会话路径**不**调 resume（回归保护）。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-resume-'))

const { sessionPresetId, buildResumeSetup, resumeCold } = await import('../src/resume.js')
const { deliverToAgentSession } = await import('../src/inbox.js')
const { createRuntime } = await import('../src/runtime.js')
const runstore = await import('../src/runstore.js')
const flowStore = await import('../src/store.js')

const runsRoot = runstore.runsDir(home)
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

// ── 假宿主对象 ────────────────────────────────────────────────────────────

/** 记录 warn 的 logger（插件 logger 签名 `log(level, message)`）。 */
function makeLog() {
  const warns = []
  return {
    warns,
    log(level, message) {
      if (level === 'warn') warns.push(String(message))
    },
  }
}

/**
 * 假 agent：`session` 就是「被冷恢复出来的会话」——setup 回调里能读 header / 日志。
 * `snapshotEvents` 用来覆盖宿主新版日志面。
 */
function makeAgent({ sessionId = 'sess-fake', headerPreset, events, snapshotEvents } = {}) {
  const session = { id: sessionId, header: {} }
  if (headerPreset !== undefined) session.header.agentPreset = headerPreset
  if (events !== undefined) session.events = events
  if (snapshotEvents !== undefined) session.snapshotEvents = snapshotEvents
  const followed = []
  return {
    status: 'idle',
    session,
    followed,
    followup(payload) {
      followed.push(payload)
    },
  }
}

/**
 * 假 agents 服务：`get()` 默认拿不到（= 冷会话），`resume()` 记录入参并**像宿主一样**
 * 在会话恢复后调用 `options.setup(agentCtx, agent)`。
 */
function makeColdAgents(agent, { live = undefined } = {}) {
  const resumes = []
  return {
    resumes,
    get(sessionId) {
      if (live && sessionId === live.session.id) return live
      return undefined
    },
    async resume(options) {
      resumes.push(options)
      if (typeof options.setup === 'function') await options.setup({ label: 'fake-agent-ctx' }, agent)
      return { agent, resumed: true }
    },
  }
}

/** 假 agentPresets：resolve/mount 记录调用；`throwOn` 里的 id 让 resolve 抛错。 */
function makePresets({ throwOn = [], mounts = [] } = {}) {
  return {
    mounts,
    async resolve(id) {
      if (id !== undefined && throwOn.includes(id)) throw new Error(`preset「${id}」不存在`)
      return { id: id === undefined ? 'standard' : id }
    },
    async mount(_agentCtx, id) {
      mounts.push(id)
    },
  }
}

/** 假 sessionController：composeAgent 返回 `setup(agentCtx, agent)`（记录 preset id）。 */
function makeSessionController({ throwOn = [], mounts = [] } = {}) {
  return {
    mounts,
    async composeAgent(id) {
      if (id !== undefined && throwOn.includes(id)) throw new Error(`composeAgent「${id}」失败`)
      return {
        agentPreset: id === undefined ? 'standard' : id,
        async setup() {
          mounts.push(id === undefined ? 'standard' : id)
        },
      }
    },
  }
}

/** 假宿主 ctx：按名字给服务，未注册的返回 undefined。 */
function makeCtx(services = {}) {
  return {
    get(name) {
      return services[name]
    },
  }
}

// ── 流程 / run 桩（只给 supervision tick 用） ─────────────────────────────

function flowOf(id) {
  return {
    schemaVersion: 1,
    id,
    name: `流程 ${id}`,
    description: '',
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    nodes: [
      {
        id: 'n_start', kind: 'start', title: '任务输入', x: 0, y: 200,
        mode: 'single', role: '', task: '接任务', outputs: '', skills: [], maxRounds: 2, team: [], model: '',
      },
      {
        id: 'n_a', kind: 'stage', title: '实现', x: 300, y: 200,
        mode: 'single', role: '实现者', task: '实现', outputs: '', skills: [], maxRounds: 2, team: [], model: '',
      },
      {
        id: 'n_end', kind: 'end', title: '完成', x: 900, y: 200,
        mode: 'single', role: '', task: '', outputs: '', skills: [], maxRounds: 2, team: [], model: '',
      },
    ],
    edges: [
      { id: 'e1', from: 'n_start', to: 'n_a', kind: 'next', label: '' },
      { id: 'e2', from: 'n_a', to: 'n_end', kind: 'next', label: '' },
    ],
  }
}

// ── 用例 ─────────────────────────────────────────────────────────────────

try {
  // 1. supervision 冷唤醒：resume 必须带 setup，setup 里按 header 挂 preset。
  await check('supervision 冷唤醒：agents.resume 入参带 setup，setup 按 header preset 调 mount', async () => {
    const flow = flowOf('flow-resume-wake')
    await flowStore.saveFlow(flowsRoot, flow.id, flow)
    const run = await runstore.createRun(runsRoot, { flowId: flow.id, flowName: flow.name, nodeTotal: 1 })
    await runstore.writeRunMeta(runsRoot, run.id, {
      status: 'running',
      started: true,
      // 很早开始：healthy 的 nextDueAt 已经过点，tick 会真的唤醒。
      startedAt: '2020-01-01T00:00:00.000Z',
    })

    const agent = makeAgent({ sessionId: 'sess-cold-wake', headerPreset: 'ptc' })
    const agents = makeColdAgents(agent)
    const { log } = makeLog()
    const presets = makePresets()
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      cwd: repoRoot,
      worktree: 'off',
      ctx: makeCtx({ agents, agentPresets: presets }),
      log,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
      auditWorkflow: () => ({ verdict: 'healthy', nextCheckSeconds: 180 }),
    })
    try {
      await runtime.enableSupervision(run.id, { enabled: true, wakerSessionId: 'sess-cold-wake' })
      const stats = await runtime.supervision.tick()
      A.equal(stats.woken, 1, '到点的 run 必须被唤醒')
      A.equal(agents.resumes.length, 1, '冷会话只能 resume 一次')
      A.equal(agents.resumes[0].resumeSessionId, 'sess-cold-wake')
      A.equal(typeof agents.resumes[0].setup, 'function', '冷 resume 必须带 setup（P0 本体）')
      // setup 由假宿主在 resume 时调用，这里挂到的是 header 里的 preset。
      A.deepEqual(presets.mounts, ['ptc'], 'setup 必须挂会话 header 里的 preset')
      A.equal(agent.followed.length, 1, '唤醒正文照旧 followup')
    } finally {
      await runtime.dispose()
    }
  })

  // 2. 日志里的 agent-preset/selected 优先于 header。
  await check('setup：最后一条 agent-preset/selected 优先于 header（events 与 snapshotEvents 两种日志面）', async () => {
    const events = [
      { type: 'turn/start' },
      { type: 'agent-preset/selected', data: { agentPreset: 'old-preset' } },
      { type: 'turn/end' },
      { type: 'agent-preset/selected', data: { agentPreset: 'new-preset' } },
    ]
    const agent = makeAgent({ sessionId: 'sess-event', headerPreset: 'header-preset', events })
    A.equal(sessionPresetId(agent), 'new-preset', '取最后一条 selected 事件')

    const { log } = makeLog()
    const presets = makePresets()
    const setup = buildResumeSetup(makeCtx({ agentPresets: presets }), log)
    A.equal(typeof setup, 'function')
    await setup({}, agent)
    A.deepEqual(presets.mounts, ['new-preset'])

    // 宿主新版日志面：没有 .events，只有 snapshotEvents()。
    const snapshotAgent = makeAgent({
      sessionId: 'sess-snapshot',
      headerPreset: 'header-preset',
      snapshotEvents: () => [{ type: 'agent-preset/selected', data: { agentPreset: 'snapshot-preset' } }],
    })
    A.equal(sessionPresetId(snapshotAgent), 'snapshot-preset')

    // 没有 select 事件 → 退回 header。
    const headerOnly = makeAgent({ sessionId: 'sess-header', headerPreset: 'header-only', events: [] })
    A.equal(sessionPresetId(headerOnly), 'header-only')
    // 两者都没有 → undefined（= 宿主默认）。
    A.equal(sessionPresetId(makeAgent({ sessionId: 'sess-none', events: [] })), undefined)
  })

  // 3. 记录的 preset 已不存在：降级宿主默认 + 一条 warn，resume 仍然成功。
  await check('setup：记录的 preset 挂载失败 → 降级宿主默认 + 一条 warn，resume 不失败', async () => {
    const agent = makeAgent({ sessionId: 'sess-gone', headerPreset: 'gone-preset' })
    const agents = makeColdAgents(agent)
    const { warns, log } = makeLog()
    const presets = makePresets({ throwOn: ['gone-preset'] })
    const resumed = await resumeCold(makeCtx({ agentPresets: presets }), agents, 'sess-gone', { log })
    A.ok(resumed && resumed.agent === agent, '降级后 resume 必须成功')
    A.equal(agents.resumes.length, 1)
    A.equal(typeof agents.resumes[0].setup, 'function')
    A.deepEqual(presets.mounts, ['standard'], '失败后改挂宿主默认 preset')
    A.equal(warns.length, 1, '降级只打一条 warn')
    A.match(warns[0], /sess-gone/, 'warn 要带 sessionId')
    A.match(warns[0], /gone-preset/, 'warn 要带实际 preset id')
  })

  // 4. 完全没有 preset 服务：resume 仍成功，留一条 warn。
  await check('setup：没有 sessionController / agentPresets → resume 仍成功且有一条 warn', async () => {
    const agent = makeAgent({ sessionId: 'sess-nosvc', headerPreset: 'ptc' })
    const agents = makeColdAgents(agent)
    const { warns, log } = makeLog()
    const resumed = await resumeCold(makeCtx({}), agents, 'sess-nosvc', { log })
    A.ok(resumed && resumed.agent === agent, '没有 preset 服务也不能让 resume 失败')
    A.equal(agents.resumes.length, 1)
    A.equal(warns.length, 1)
    A.match(warns[0], /sessionController/)
    A.match(warns[0], /sess-nosvc/)
  })

  // 5. 收件箱投递冷路径：setup + agentOptions 同时在。
  await check('deliverToAgentSession 冷路径：resume 带 setup（并保留 agentOptions）', async () => {
    const agent = makeAgent({ sessionId: 'sess-inbox-cold', headerPreset: 'ptc' })
    const agents = makeColdAgents(agent)
    const { log } = makeLog()
    const presets = makePresets()
    const result = await deliverToAgentSession(agents, 'sess-inbox-cold', '外部消息正文', {
      runId: 'r-inbox',
      nodeId: 'n_a',
      from: 'human',
      agentOptions: { provider: 'p', model: 'm' },
      ctx: makeCtx({ agentPresets: presets }),
      log,
    })
    A.deepEqual(result, { mode: 'resumed', sessionId: 'sess-inbox-cold' })
    A.equal(agents.resumes.length, 1)
    A.deepEqual(agents.resumes[0].agentOptions, { provider: 'p', model: 'm' }, 'agentOptions 不能被 setup 改掉')
    A.equal(typeof agents.resumes[0].setup, 'function', '收件箱冷路径也必须带 setup')
    A.deepEqual(presets.mounts, ['ptc'])
    A.equal(agent.followed.length, 1, '正文照旧 followup')
  })

  // 6. 活会话不 resume（回归保护）。
  await check('活会话路径：agents.get 命中时绝不调 resume', async () => {
    const live = makeAgent({ sessionId: 'sess-live', headerPreset: 'ptc' })
    const agents = makeColdAgents(live, { live })
    const { log } = makeLog()
    const result = await deliverToAgentSession(agents, 'sess-live', '正文', {
      runId: 'r-live',
      nodeId: 'n_a',
      from: 'human',
      ctx: makeCtx({ agentPresets: makePresets() }),
      log,
    })
    A.deepEqual(result, { mode: 'injected', sessionId: 'sess-live' })
    A.equal(agents.resumes.length, 0, '活会话不能 resume')
    A.equal(live.followed.length, 1)
  })

  // 7. 节点自检闹钟冷路径（runtime.wake）同样带 setup。
  await check('节点自检闹钟冷路径：agents.resume 带 setup，按会话 preset 挂组合', async () => {
    const agent = makeAgent({ sessionId: 'sess-node-cold', headerPreset: 'ptc' })
    const agents = makeColdAgents(agent)
    const { log } = makeLog()
    const presets = makePresets()
    const runtime = createRuntime({
      runsRoot,
      flowsRoot,
      cwd: repoRoot,
      worktree: 'off',
      ctx: makeCtx({ agents, agentPresets: presets }),
      log,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })
    try {
      runtime.runs.set('r-node-cold', {
        attemptEnvelopeFor: () => ({ attempt: 2, nodeId: 'n_dev', nonce: 'NONCE-cold' }),
        dispose() {},
      })
      const result = await runtime.wake({
        runId: 'r-node-cold', nodeId: 'n_dev', attempt: 2, sessionId: 'sess-node-cold',
      })
      A.deepEqual(result, { action: 'followup' })
      A.equal(agents.resumes.length, 1)
      A.equal(typeof agents.resumes[0].setup, 'function', '节点闹钟冷 resume 也必须带 setup')
      A.deepEqual(presets.mounts, ['ptc'])
    } finally {
      await runtime.dispose()
    }
  })

  // 8. 参考实现也有：sessionController 路径可用（Web 同一条），失败也降级。
  await check('setup：sessionController.composeAgent 路径可用；它失败时降级到宿主默认', async () => {
    const okAgent = makeAgent({ sessionId: 'sess-sc', headerPreset: 'ptc' })
    const okController = makeSessionController()
    const { log } = makeLog()
    const setup = buildResumeSetup(makeCtx({ sessionController: okController }), log)
    await setup({}, okAgent)
    A.deepEqual(okController.mounts, ['ptc'])

    const badAgent = makeAgent({ sessionId: 'sess-sc-bad', headerPreset: 'gone' })
    const badController = makeSessionController({ throwOn: ['gone'] })
    const badLog = makeLog()
    const failed = await resumeCold(
      makeCtx({ sessionController: badController }),
      makeColdAgents(badAgent),
      'sess-sc-bad',
      { log: badLog.log },
    )
    A.ok(failed && failed.agent === badAgent, 'composeAgent 抛错也必须让 resume 成功')
    A.deepEqual(badController.mounts, ['standard'], '降级到宿主默认组合')
    A.equal(badLog.warns.length, 1)
    A.match(badLog.warns[0], /sess-sc-bad/)
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nresume-setup 自检：${checks} 组通过（${assertionCount} 条断言）`)
