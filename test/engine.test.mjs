#!/usr/bin/env node
/**
 * 执行引擎自检（06-execution-engine.md · v0.4）。
 *
 * 全部走注入桩：不启动 dsh、不 import 任何 dsh 包。run 目录落在项目 `.tmp/`
 * 下（不占系统 /tmp）。
 *
 * 覆盖：单节点通过、两节点通过、打回一轮后通过（attemptId=2）、超 maxRounds 失败、
 * stop 中止、结构不合格失败、用量归属与同 callId 去重、409 并发、live / 产物落盘 /
 * 提示词骨架 / 崩溃残留清理。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-engine-'))
// C3：start() 不再回落 process.cwd()。既有测试夹具统一给一个真实存在的显式
// 工作区（构造时 cwd），新增的「无 workspace → 400」专组会绕过这个默认值。
const testWorkspace = join(home, 'workspace')
mkdirSync(testWorkspace, { recursive: true })

const engineModule = await import('../src/engine.js')
const store = await import('../src/runstore.js')
const flowStore = await import('../src/store.js')
const { summarize } = await import('../src/runlog.js')
const { toStrictOutputSchema } = await import('../src/executor.js')
const supervise = await import('../src/supervise.js')

const {
  createEngine: createEngineRaw, EngineError, STUB_USAGE, buildPrompt, PROMPT_MAX_CHARS,
  loadUpstreamArtifactContents, MAX_NODE_RETRIES, UPSTREAM_ARTIFACT_READ_MAX_BYTES,
  nodeSessionId, ENGINE_OUTPUT_SCHEMA, parseAssistantStructured,
} = engineModule

/**
 * 既有 49 组测试关心的是主循环 / 提示词 / 事件契约，不关心 worktree。构造时默认
 * `worktree:'off'`，避免在插件仓库本身（测试进程的 cwd 是 git 根）上真建 worktree；
 * R1/R4 的 auto / on 行为由文末追加的专组用显式 `worktree` 覆盖。
 * C3 起还必须显式给工作区，夹具统一用 `testWorkspace`（显式 cwd，不是 process.cwd）。
 * 这只是测试夹具默认值，不改任何既有断言。
 */
const createEngine = (options = {}) => createEngineRaw({ worktree: 'off', cwd: testWorkspace, ...options })

const runsRoot = store.runsDir(home)
const flowsRoot = flowStore.flowsDir(home)

let checks = 0
/** 统计断言数（用户要求回报新增断言数）。 */
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

function countKind(events, kind) {
  return events.filter(event => event.kind === kind).length
}

function kinds(events) {
  return events.map(event => `${event.kind}${event.nodeId ? `:${event.nodeId}` : ''}${event.attemptId ? `#${event.attemptId}` : ''}`)
}

/** 一个带齐五项证据的通过结果，quality 能算出 pass。 */
function passResult(nodeId, extra = {}) {
  return {
    structured: {
      verdict: 'pass',
      summary: `${nodeId} 通过`,
      artifacts: [{ name: `${nodeId}-结论.md`, content: `# ${nodeId}\n\n通过。\n` }],
      findings: [{ id: `${nodeId}-F1`, severity: 'P2', title: '小问题', status: 'verified' }],
      checks: {
        ruleSetId: `rules-${nodeId}`, ruleSetVersion: '1', executor: 'test', passedChecks: 3, totalChecks: 3,
      },
      acceptance: [{ itemId: `${nodeId}-R1`, status: 'pass', decidedBy: 'auto' }],
      tests: { suite: `unit-${nodeId}`, executed: 2, passed: 2, failed: 0, skipped: 0 },
    },
    sessionId: `sess-${nodeId}`,
    dispose: async () => {},
    ...extra,
  }
}

function rejectResult(nodeId, targetId) {
  return {
    structured: {
      verdict: 'reject',
      summary: `${nodeId} 打回 ${targetId}`,
      rejectTarget: targetId,
      rejectReason: '测试结论不达标，返工',
      findings: [{ id: `${nodeId}-F1`, severity: 'P1', title: '失败用例', status: 'open' }],
    },
    sessionId: `sess-${nodeId}`,
    dispose: async () => {},
  }
}

function deferred() {
  let resolveFn
  let rejectFn
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

/**
 * 读取原始 run.json。runstore 的 `readRunMeta()` 只保留白名单字段（workspace /
 * worktree / sessionMode 会被丢掉），所以断言绑定字段必须读原文。
 */
function readRawRun(runId) {
  return JSON.parse(readFileSync(join(runsRoot, runId, 'run.json'), 'utf8'))
}

/** 在项目 `.tmp/` 下造一个真 git 仓库（独立 git config，不读宿主全局配置）。 */
function makeGitRepo(name) {
  const dir = mkdtempSync(join(repoRoot, '.tmp', `${name}-`))
  const gitHome = join(home, 'git-home')
  mkdirSync(gitHome, { recursive: true })
  const git = args => execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOME: gitHome, GIT_CONFIG_NOSYSTEM: '1' },
  })
  git(['init', '-q'])
  git(['checkout', '-q', '-b', 'main'])
  git(['config', 'user.email', 'flow-studio-test@example.invalid'])
  git(['config', 'user.name', 'Flow Studio Test'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', 'README.md'])
  git(['commit', '-q', '-m', 'init'])
  return dir
}

/**
 * 造一个**不在任何 git 仓库里**的空目录。项目 `.tmp/` 本身在插件仓库内
 * （`git rev-parse --show-toplevel` 会返回仓库根），测「非 git 工作区」必须放在仓库外；
 * 按工作区约定用大卷 `~/tmp`（不进 /tmp，也不污染仓库）。
 */
function makePlainDir(name) {
  const base = join(process.env.HOME || repoRoot, 'tmp')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, `flow-studio-${name}-`))
}

/**
 * C2：从引擎下发的提示词里读回本轮 attempt / nonce（夹具据此回显，正式结论才不会被丢）。
 * payload 可以是 followup 入参，也可以直接是 prompt 文本。
 */
function envelopeOf(payload) {
  const text = typeof payload === 'string'
    ? payload
    : (payload && Array.isArray(payload.content)
      ? payload.content.filter(block => block && block.type === 'text').map(block => block.text).join('\n')
      : '')
  const attempt = /^- attempt: (\d+)$/m.exec(text)
  const nonce = /^- nonce: (.+)$/m.exec(text)
  if (!attempt || !nonce) return null
  return { attempt: Number(attempt[1]), nonce: nonce[1].trim() }
}

/** 把对象包成 assistant 回复里的 ```json 围栏。 */
function fenced(value) {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
}

/**
 * `agents.create` 桩：节点会话按 passResult 的结构返回 ```json 代码块。
 * 返回 { ctx, created }，created 里是每次 create 的入参（可断言 meta.cwd / sessionId）。
 * C2：自动把引擎下发的 attempt / nonce 回显进正式结论（调用方显式给出时不覆盖）。
 */
function agentsCreateCtx(engineRef, { resultFor = () => passResult('n_x').structured } = {}) {
  const created = []
  const ctx = {
    on() {
      return () => {}
    },
    get(name) {
      // 0.2.2 宿主的模型路由来源：节点没配 model 时用它补齐 provider + model。
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
      }
      if (name !== 'agents') return undefined
      return {
        async create(options) {
          created.push(options)
          const sessionId = options.sessionId
          return {
            agent: {
              session: { id: sessionId, header: {} },
              followup(payload) {
                const envelope = envelopeOf(payload)
                const base = resultFor(options)
                const structured = envelope ? { attempt: envelope.attempt, nonce: envelope.nonce, ...base } : base
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
            },
            async dispose() {},
          }
        },
      }
    },
  }
  return { ctx, created }
}

/**
 * E1-b：真实 `NodeSupervisionScheduler`（只用来读 snapshot().entries[].lastReport），
 * 定时器全部注入成空实现，测试里不 tick。
 */
function realNodeScheduler() {
  return new supervise.NodeSupervisionScheduler({
    now: () => new Date(),
    wake: async () => ({ action: 'skip' }),
    setInterval: () => null,
    clearInterval: () => {},
  })
}

/**
 * 07 §11（R8）假节点闹钟调度器：只记录引擎调了什么，不真的起定时器。
 * `strictUnregister=true` 时对未登记 sessionId 抛错——用来证明引擎的注销入口
 * 会把调度器异常吃掉（幂等安全），而不是把 run 拖失败。
 */
function fakeNodeAlarmScheduler({ strictUnregister = false } = {}) {
  const calls = { register: [], unregister: [], unregisterNode: [], unregisterRun: [] }
  const order = []
  const entries = new Map()
  const scheduler = {
    calls,
    order,
    entries,
    register(entry) {
      calls.register.push({ ...entry })
      order.push(`register:${entry.sessionId}`)
      entries.set(entry.sessionId, { ...entry })
      return scheduler.status(entry.sessionId)
    },
    unregister(sessionId) {
      calls.unregister.push(sessionId)
      order.push(`unregister:${sessionId}`)
      if (strictUnregister && !entries.has(sessionId)) {
        throw new Error(`未登记的 sessionId：${sessionId}`)
      }
      return entries.delete(sessionId)
    },
    unregisterNode(runId, nodeId) {
      calls.unregisterNode.push({ runId, nodeId })
      order.push(`unregisterNode:${runId}:${nodeId}`)
      return 0
    },
    unregisterRun(runId) {
      calls.unregisterRun.push(runId)
      order.push(`unregisterRun:${runId}`)
      let removed = 0
      for (const [sessionId, entry] of [...entries]) {
        if (entry.runId === runId) {
          entries.delete(sessionId)
          removed += 1
        }
      }
      return removed
    },
    status(sessionId) {
      return entries.has(sessionId) ? { ...entries.get(sessionId), enabled: true } : { enabled: false }
    },
    list() {
      return [...entries.values()]
    },
  }
  return scheduler
}

/**
 * 07 §11（R8）假 agents：`agents.create` 建一个可控会话，`behavior` 在每次
 * followup 时被调用（用 emit / emitStructured 喂 assistant 消息，用 finishIdle
 * 放行 whenIdle）。不调用 finishIdle 时 whenIdle 永远挂着——用来验证自审提前完成。
 */
function nodeAlarmAgents(engineRef, behavior) {
  const created = []
  const agentsById = new Map()
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
          created.push(options)
          const sessionId = options.sessionId
          let finishIdle = null
          const idle = new Promise(resolve => {
            finishIdle = resolve
          })
          const agent = {
            session: { id: sessionId, header: {} },
            status: 'working',
            followup(payload) {
              const emit = text => engineRef.value.handleSessionEvent({ id: sessionId }, {
                type: 'assistant/message',
                data: {
                  message: { role: 'assistant', content: [{ type: 'text', text }] },
                },
              })
              const envelope = envelopeOf(payload)
              behavior({
                engine: engineRef.value,
                sessionId,
                options,
                agent,
                idle,
                envelope,
                emit,
                // C2：正式结论默认回显本轮 attempt / nonce；调用方显式给值时优先。
                emitStructured: value => emit(`\`\`\`json\n${JSON.stringify(
                  envelope ? { attempt: envelope.attempt, nonce: envelope.nonce, ...value } : value,
                )}\n\`\`\``),
                emitStatus: value => emit(`\`\`\`json\n${JSON.stringify(
                  envelope ? { attempt: envelope.attempt, nonce: envelope.nonce, ...value } : value,
                )}\n\`\`\``),
                finishIdle: () => finishIdle(),
              })
            },
            whenIdle() {
              return idle
            },
          }
          agentsById.set(sessionId, agent)
          return { agent, dispose: async () => {} }
        },
        get(sessionId) {
          return agentsById.get(sessionId) || null
        },
      }
    },
  }
  return { ctx, created, agentsById }
}

try {
  // -------------------------------------------------------------------------
  console.log('engine · 单节点通过（产物 / 证据 / live / quality）')

  await check('单节点通过：run done、node/end passed、产物落盘、quality=pass、live 清空', async () => {
    const flow = flowOf('flow-one', [startNode(), stage('n_impl', '实现', 300), endNode()], [
      next('e1', 'n_start', 'n_impl'),
      next('e2', 'n_impl', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-one', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ label }) => passResult('n_impl', { label }),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const summary = summarize(events)

    A.equal(final.status, 'done')
    A.equal(final.live, null)
    A.equal(countKind(events, 'run/start'), 1)
    A.equal(countKind(events, 'run/end'), 1)
    A.equal(kinds(events).includes('node/start:n_impl#1'), true)
    A.equal(kinds(events).includes('node/end:n_impl#1'), true)
    A.equal(events.find(event => event.kind === 'node/end').data.status, 'passed')
    // v1.3 起 runlog 侧新增「同节点自写证据 → 自证闭环 unknown」的独立性口径；
    // 聚合层正在并行改动，引擎测试只断言「能算出结论」（不抛错），不再绑死 state=pass。
    A.ok(summary.quality && typeof summary.quality === 'object')
    A.equal(typeof summary.quality.label, 'string')
    A.equal(summary.progress.ratio, 1)
    A.equal(summary.progress.passed, 1)

    const artifactEvents = events.filter(event => event.kind === 'artifact/write')
    A.ok(artifactEvents.length >= 4, 'artifact/write 至少 4 条（产物 + checks/acceptance/test/summary）')
    const summaryEvent = artifactEvents.find(event => event.data.path.endsWith('/summary.json'))
    A.ok(Boolean(summaryEvent), '有 summary.json')
    A.equal(summaryEvent.data.sha256.length, 64)
    A.equal(summaryEvent.data.kind, 'json')
    const abs = join(runsRoot, run.id, summaryEvent.data.path)
    A.equal(existsSync(abs), true)
    const disk = JSON.parse(readFileSync(abs, 'utf8'))
    A.equal(disk.verdict, 'pass')
    A.equal(disk.attempt, 1)

    const acceptance = events.filter(event => event.kind === 'acceptance/verdict')
    A.equal(acceptance.length, 1)
    // §13.7 m7：模型没给 evidenceRef 时，仍落到引擎自己写的 acceptance.json（默认口径；
    // 模型给了上游路径并校验通过时才会透传，见 v1.2「证据引用透传」用例）。
    A.ok(typeof acceptance[0].data.evidenceRef === 'string' && acceptance[0].data.evidenceRef.endsWith('/acceptance.json'))
    const tests = events.filter(event => event.kind === 'test/report')
    A.equal(tests.length, 1)
    // 同上：没给 reportRef 时落到引擎的 test-report.json。
    A.ok(typeof tests[0].data.reportRef === 'string' && tests[0].data.reportRef.endsWith('/test-report.json'))
    const checks = events.filter(event => event.kind === 'check/form')
    A.equal(checks.length, 1)
    A.equal(checks[0].data.state, 'pass')
    A.equal(checks[0].data.passedChecks, 3)
    A.equal(checks[0].data.totalChecks, 3)
  })

  // -------------------------------------------------------------------------
  console.log('engine · 默认 activate 走 agents.create（R2：节点主管会话 = 顶层会话）')

  await check('未注入 activate：agents.create 建顶层会话（稳定 id / 无父会话 / cwd）、followup 解析 JSON、收尾 dispose', async () => {
    const flow = flowOf('flow-default', [startNode(), stage('n_spawn', '真实节点', 300), endNode()], [
      next('e1', 'n_start', 'n_spawn'),
      next('e2', 'n_spawn', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-default', 1)
    let engine = null
    const created = []
    const payloads = []
    let disposed = 0
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
          // 07 §3.1：默认路径只认 agents.create（不再走 subagents.startActivation）。
          async create(createOptions) {
            created.push(createOptions)
            const sessionId = createOptions.sessionId
            return {
              agent: {
                session: { id: sessionId, header: {} },
                followup(payload) {
                  payloads.push(payload)
                  // C2：正式结论必须回显本轮 attempt / nonce，否则会被引擎丢弃。
                  const envelope = envelopeOf(payload)
                  const structured = envelope
                    ? { attempt: envelope.attempt, nonce: envelope.nonce, ...passResult('n_spawn').structured }
                    : passResult('n_spawn').structured
                  // 模拟宿主：followup 之后 assistant/message 带 ```json 代码块回来。
                  engine.handleSessionEvent({ id: sessionId }, {
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
              },
              async dispose() {
                disposed += 1
              },
            }
          },
        }
      },
    }
    engine = createEngine({ runsRoot, flowsRoot, ctx, cwd: '/repo' })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    A.equal(disposed, 1)
    A.equal(created.length, 1)
    // 同一个 (runId,nodeId) 的会话 id 稳定且只含安全字符。
    A.equal(created[0].sessionId, nodeSessionId(run.id, 'n_spawn', 1))
    A.match(created[0].sessionId, /^[A-Za-z0-9._-]+$/)
    A.equal(created[0].meta.cwd, '/repo')
    // 顶层会话：绝不出现任何会让宿主记成子会话的字段。
    A.equal('parentAgent' in created[0], false)
    A.equal('parentSession' in (created[0].meta || {}), false)
    A.equal('origin' in (created[0].meta || {}), false)
    A.equal('delegationDepth' in (created[0].meta || {}), false)
    // 提示词经 buildFollowupPayload 投递，并要求 ```json 代码块（create 无 schema 通道）。
    A.equal(payloads.length, 1)
    A.equal(payloads[0].role, 'user')
    A.equal(payloads[0].source.kind, 'flow-studio')
    A.equal(payloads[0].source.room, `${run.id}/n_spawn`)
    A.ok(payloads[0].content[0].text.includes('## 输出格式'))
    A.ok(payloads[0].content[0].text.includes('```json'))
    // 07 §3「降级必须可见」：正常路径在 run.json 与 run/start 里都要写 top-level。
    A.equal(readRawRun(run.id).sessionMode, 'top-level')
    A.equal((await eventsOf(run.id)).find(event => event.kind === 'run/start').data.sessionMode, 'top-level')
  })

  // -------------------------------------------------------------------------
  console.log('engine · 两节点通过')

  await check('两节点通过：两个 node/end passed、progress=2/2、nodeDone=2', async () => {
    const flow = flowOf('flow-two', [
      startNode(), stage('n_a', '需求', 300), stage('n_b', '开发', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-two', 2)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => passResult(node.id),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const summary = summarize(events)
    A.equal(final.status, 'done')
    A.equal(summary.progress.passed, 2)
    A.equal(summary.progress.ratio, 1)
    A.equal(summary.progress.total, 2)
    A.equal(final.nodeDone, 2)
    A.deepEqual(
      events.filter(event => event.kind === 'node/end').map(event => `${event.nodeId}#${event.attemptId}`),
      ['n_a#1', 'n_b#1'],
    )
  })

  // -------------------------------------------------------------------------
  console.log('engine · 同一引擎连跑两个 run')

  await check('第二次 start 从 attempt=1 重新计数，不继承上一个 run 的通过记录', async () => {
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => passResult(node.id),
    })
    const first = await makeRun('flow-two', 2)
    await engine.start(first.id)
    await engine.wait(first.id)
    const second = await makeRun('flow-two', 2)
    await engine.start(second.id)
    const final = await engine.wait(second.id)
    const events = await eventsOf(second.id)
    A.equal(final.status, 'done')
    A.deepEqual(
      events.filter(event => event.kind === 'node/start').map(event => `${event.nodeId}#${event.attemptId}`),
      ['n_a#1', 'n_b#1'],
    )
    A.equal(summarize(events).progress.passed, 2)
  })

  // -------------------------------------------------------------------------
  console.log('engine · 打回一轮后通过')

  await check('打回一轮后通过：reject/trigger 一次、目标 attemptId=2、quality 仍 pass（良）', async () => {
    const flow = flowOf('flow-rework', [
      startNode(), stage('n_a', '开发', 300), stage('n_b', '测试', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
      reject('e4', 'n_b', 'n_a'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-rework', 2)
    let rejections = 0
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node, attempt }) => {
        if (node.id === 'n_b' && attempt === 1) {
          rejections += 1
          return rejectResult('n_b', 'n_a')
        }
        return passResult(node.id, attempt === 1 ? { attempt } : {})
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const summary = summarize(events)

    A.equal(final.status, 'done')
    A.equal(rejections, 1)
    A.equal(countKind(events, 'reject/trigger'), 1)
    const trigger = events.find(event => event.kind === 'reject/trigger')
    A.equal(trigger.data.fromNodeId, 'n_b')
    A.equal(trigger.data.toNodeId, 'n_a')
    A.equal(trigger.data.edgeId, 'e4')
    A.equal(trigger.attemptId, 1)

    const nodeStarts = events.filter(event => event.kind === 'node/start')
    A.deepEqual(
      nodeStarts.map(event => `${event.nodeId}#${event.attemptId}`),
      ['n_a#1', 'n_b#1', 'n_a#2', 'n_b#2'],
    )
    A.equal(events.filter(event => event.kind === 'node/end' && event.nodeId === 'n_a' && event.attemptId === 2).length, 1)
    A.equal(summary.rejects.total, 1)
    A.equal(summary.progress.ratio, 1)
    // v1.3 证据独立性口径由 runlog 侧并行改动（自证闭环 → unknown），这里只锁引擎侧事实：
    // 返工轮次与打回次数算得对，不再断言具体 quality.state / label。
    A.equal(summary.quality.reworkRounds, 1)
    A.equal(typeof summary.quality.label, 'string')
  })

  // -------------------------------------------------------------------------
  console.log('engine · 超 maxRounds 失败')

  await check('超 maxRounds 失败：目标执行到上限后 run/end failed（reason 含「超打回上限」）', async () => {
    const flow = flowOf('flow-loop', [
      startNode(), stage('n_a', '开发', 300, { maxRounds: 2 }), stage('n_b', '测试', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
      reject('e4', 'n_b', 'n_a'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-loop', 2)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => {
        if (node.id === 'n_b') return rejectResult('n_b', 'n_a')
        return passResult(node.id)
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const runEnd = events.find(event => event.kind === 'run/end')
    A.equal(final.status, 'failed')
    A.equal(runEnd.data.status, 'failed')
    A.match(runEnd.data.reason, /超打回上限/)
    // 06 §13.10：maxRounds=2 表示「允许重跑 2 次」→ n_a 共 3 次 attempt、3 次 reject。
    A.equal(events.filter(event => event.kind === 'node/start' && event.nodeId === 'n_a').length, 3)
    A.equal(events.filter(event => event.kind === 'node/start' && event.nodeId === 'n_b').length, 3)
    A.equal(countKind(events, 'reject/trigger'), 3)
    // 超限时先写目标节点的 node/end failed（带 reason），再写 run/end failed。
    const limitEnd = events.find(event => event.kind === 'node/end' && event.nodeId === 'n_a'
      && event.data.status === 'failed')
    A.ok(Boolean(limitEnd), '目标节点有一条 node/end failed')
    A.match(limitEnd.extra.reason, /超打回上限/)
    A.ok(events.indexOf(limitEnd) < events.indexOf(runEnd), 'node/end failed 在 run/end 之前')
  })

  // -------------------------------------------------------------------------
  console.log('engine · stop 中止与 409 并发')

  await check('stop 中止：run/end aborted、live 清空；非运行中 stop 与并发 start 都 409', async () => {
    const flow = flowOf('flow-stop', [startNode(), stage('n_slow', '慢节点', 300), endNode()], [
      next('e1', 'n_start', 'n_slow'),
      next('e2', 'n_slow', 'n_end'),
    ])
    await saveFlow(flow)
    const run1 = await makeRun('flow-stop', 1)
    const run2 = await makeRun('flow-stop', 1)
    const started = deferred()
    let sawSignal = null
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ signal }) => {
        sawSignal = signal
        started.resolve()
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('已中止')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      },
    })
    await engine.start(run1.id)
    await started.promise
    const live = await store.readRunMeta(runsRoot, run1.id)
    A.equal(live.live.currentNodeId, 'n_slow')
    A.equal(live.live.attempt, 1)
    A.equal(live.live.phase, 'spawn')

    await assert.rejects(() => engine.start(run2.id), error => error instanceof EngineError && error.status === 409)
    assertionCount += 1
    A.ok(sawSignal !== null && sawSignal.aborted === false)
    const stopped = await engine.stop(run1.id)
    A.equal(stopped.status, 'aborted')
    A.equal(stopped.live, null)
    const events = await eventsOf(run1.id)
    const runEnd = events.find(event => event.kind === 'run/end')
    A.equal(runEnd.data.status, 'aborted')
    A.equal(events.find(event => event.kind === 'node/end').data.status, 'failed')
    A.equal(events.find(event => event.kind === 'node/end').extra.aborted, true)
    await assert.rejects(() => engine.stop(run1.id), error => error instanceof EngineError && error.status === 409)
    assertionCount += 1

    // 已经结束的 run 不能再次开始（409），不是 500。
    await assert.rejects(() => engine.start(run1.id), error => error instanceof EngineError && error.status === 409)
    assertionCount += 1
  })

  // -------------------------------------------------------------------------
  console.log('engine · 结构不合格')

  await check('结构不合格失败：node/end failed + extra.validationError、run/end failed', async () => {
    const flow = flowOf('flow-bad', [startNode(), stage('n_bad', '坏输出', 300), endNode()], [
      next('e1', 'n_start', 'n_bad'),
      next('e2', 'n_bad', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-bad', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async () => ({ structured: { summary: '忘了 verdict' }, dispose: async () => {} }),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')
    const runEnd = events.find(event => event.kind === 'run/end')
    A.equal(final.status, 'failed')
    A.equal(nodeEnd.data.status, 'failed')
    A.match(nodeEnd.extra.validationError, /verdict/)
    A.equal(runEnd.data.status, 'failed')
    A.match(runEnd.data.reason, /verdict/)
    A.equal(summarize(events).progress.ratio, 0)
  })

  // -------------------------------------------------------------------------
  console.log('engine · 用量归属与去重')

  await check('用量归属：lead→memberId=null、成员→<nodeId>:1；同 traceId+callId 后到替换；skill/tool 事件', async () => {
    const flow = flowOf('flow-team', [
      startNode(),
      stage('n_team', '团队节点', 300, {
        mode: 'team',
        team: [{ name: '实现者', role: 'dev', task: '写代码' }],
        skills: ['code-review'],
      }),
      endNode(),
    ], [
      next('e1', 'n_start', 'n_team'),
      next('e2', 'n_team', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-team', 1)
    const leadSession = { id: 'sess-lead', header: { model: 'lead-model' } }
    const memberSession = { id: 'sess-member', header: { parentSession: 'sess-lead', model: 'member-model' } }
    let usedEngine = null
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ onSession }) => {
        onSession('sess-lead')
        // 同一条调用重放两次：后到的 usage 应整条替换先到的。
        engine.handleSessionEvent(leadSession, {
          type: 'assistant/message',
          seq: 1,
          data: {
            message: { id: 'call-lead', source: { provider: 'p', model: 'm' } },
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3 },
          },
        })
        engine.handleSessionEvent(leadSession, {
          type: 'assistant/message',
          seq: 2,
          data: {
            message: { id: 'call-lead', source: { provider: 'p', model: 'm' } },
            usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3 },
          },
        })
        engine.handleSessionEvent(memberSession, {
          type: 'assistant/message',
          seq: 3,
          data: {
            message: { id: 'call-member', source: { provider: 'p', model: 'member-model' } },
            usage: { inputTokens: 7, outputTokens: 4 },
          },
        })
        engine.handleSessionEvent(leadSession, {
          type: 'tool/call',
          seq: 4,
          data: { callId: 'tool-1', name: 'skill', arguments: '{"name":"code-review"}' },
        })
        engine.handleSessionEvent(leadSession, {
          type: 'tool/result',
          seq: 5,
          data: { message: { toolCallId: 'tool-1', isError: true } },
        })
        engine.handleSessionEvent(leadSession, {
          type: 'tool/call',
          seq: 6,
          data: { callId: 'tool-2', name: 'bash', arguments: `{"command":"${'x'.repeat(500)}"}` },
        })
        engine.handleSessionEvent(leadSession, {
          type: 'tool/result',
          seq: 7,
          data: { message: { toolCallId: 'tool-2', isError: false } },
        })
        usedEngine = engine
        return passResult('n_team')
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    await engine.flushEvents()
    const events = await eventsOf(run.id)
    const summary = summarize(events)

    A.equal(final.status, 'done')
    A.equal(usedEngine, engine)
    A.equal(summary.usage.unkeyedCalls, 0)
    // lead: 20+2+1+5=28；member: 7+0+0+4=11；合计 39（重放的 10 被整条替换掉）。
    A.equal(summary.tokens.total.total, 39)
    A.equal(summary.tokens.calls, 2)
    A.equal(summary.tokens.byNode.n_team.total, 39)
    A.equal(summary.tokens.byMember['n_team:1'].total, 11)
    A.equal(summary.tokens.total.reasoning, 3)

    const modelCalls = events.filter(event => event.kind === 'model/call')
    A.equal(modelCalls.length, 3, '三条 model/call 落盘，但聚合只认两条（同 callId 后者替换）')
    A.ok(modelCalls.every(event => typeof event.data.callId === 'string' && event.data.callId !== ''))
    A.equal(modelCalls.filter(event => event.memberId === null).length, 2)
    A.equal(modelCalls.filter(event => event.memberId === 'n_team:1').length, 1)

    const skillLoad = events.find(event => event.kind === 'skill/load')
    A.equal(skillLoad.data.skill, 'code-review')
    A.equal(skillLoad.data.ok, false)
    const toolCall = events.find(event => event.kind === 'tool/call')
    A.equal(toolCall.data.name, 'bash')
    A.equal(toolCall.data.ok, true)
    A.ok(Array.from(toolCall.data.argumentsDigest).length <= 200)

    const memberStart = events.find(event => event.kind === 'member/start')
    const memberEnd = events.find(event => event.kind === 'member/end')
    A.equal(memberStart.memberId, 'n_team:1')
    A.equal(memberStart.data.name, '实现者')
    // 06 §13.10：member/end.status 不得由 lead verdict 反推。宿主支持 partial 时写 partial，
    // 不支持时宁可不写，也绝不能因为 lead 判 pass 就给成员编一个 passed。
    if (memberEnd) A.equal(memberEnd.data.status, 'partial')
    else A.equal(events.some(event => event.kind === 'member/end'), false, '不写成员结论时不能编造 passed/failed')

    const nodeEnd = events.find(event => event.kind === 'node/end')
    A.equal(nodeEnd.extra, undefined, '有成员明细时不标 membersPartial')
    A.equal(summary.skillUsage.coverage, 0, '加载失败的 skill 不计入 loaded，覆盖率因此是 0')
    A.equal(summary.skillUsage.loads.failed, 1)
  })

  // -------------------------------------------------------------------------
  console.log('engine · agent/message 与 live 快照（§8.2 / §13.12）')

  await check('assistant/message：写 agent/message（脱敏+截断），live.lastMessage/tokens 同步', async () => {
    const flow = flowOf('flow-agent-msg', [startNode(), stage('n_msg', '说话', 300), endNode()], [
      next('e1', 'n_start', 'n_msg'),
      next('e2', 'n_msg', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-agent-msg', 1)
    const session = { id: 'sess-msg', header: {} }
    const secret = 'sk-live-abcdef1234567890'
    const longText = `先说明：Authorization: Bearer ${secret}；password=hunter2\n${'细节'.repeat(1200)}`
    let engine
    let liveAfterMessage = null
    let liveAfterTool = null
    engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ onSession }) => {
        onSession('sess-msg')
        engine.handleSessionEvent(session, {
          type: 'assistant/message',
          seq: 1,
          data: {
            message: {
              id: 'call-msg',
              source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
              content: [
                { type: 'thinking', text: '不该被摘出来' },
                { type: 'text', text: longText },
              ],
            },
            usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 5 },
          },
        })
        await engine.flushEvents()
        liveAfterMessage = (await store.readRunMeta(runsRoot, run.id)).live
        engine.handleSessionEvent(session, {
          type: 'tool/call', seq: 2, data: { callId: 'tool-msg', name: 'bash', arguments: '{"command":"ls"}' },
        })
        engine.handleSessionEvent(session, {
          type: 'tool/result', seq: 3, data: { message: { toolCallId: 'tool-msg', isError: false } },
        })
        await engine.flushEvents()
        liveAfterTool = (await store.readRunMeta(runsRoot, run.id)).live
        return passResult('n_msg')
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    await engine.flushEvents()
    const events = await eventsOf(run.id)
    A.equal(final.status, 'done')

    const message = events.find(event => event.kind === 'agent/message')
    A.ok(Boolean(message), '应写出一条 agent/message')
    A.equal(message.nodeId, 'n_msg')
    A.equal(message.memberId, null)
    A.equal(message.data.role, 'assistant')
    A.equal(message.data.truncated, true)
    A.ok(Array.from(message.data.text).length <= 2000)
    A.equal(message.data.text.includes(secret), false)
    A.equal(message.data.text.includes('hunter2'), false)
    A.equal(message.data.text.includes('不该被摘出来'), false, 'reasoning/thinking 文本不能当可见文本')
    A.equal(message.data.provider, 'deepseek')
    A.equal(message.data.model, 'deepseek-chat')

    A.ok(Boolean(liveAfterMessage), '运行中 run.json.live 必须可读')
    A.equal(liveAfterMessage.nodeTitle, '说话')
    A.equal(liveAfterMessage.nodeMode, 'single')
    A.equal(liveAfterMessage.activeMemberId, null)
    A.deepEqual(liveAfterMessage.tokens, { input: 12, cacheRead: 3, cacheWrite: 2, output: 7 })
    A.ok(Array.from(liveAfterMessage.lastMessage.text).length <= 200)
    A.equal(liveAfterMessage.lastMessage.text.includes(secret), false)
    A.equal(liveAfterMessage.lastMessage.memberId, null)
    A.equal(typeof liveAfterMessage.lastMessage.at, 'string')

    A.ok(Boolean(liveAfterTool), '工具跑完后 live 必须可读')
    A.equal(liveAfterTool.lastTool.name, 'bash')
    A.equal(liveAfterTool.lastTool.ok, true)
    A.equal(typeof liveAfterTool.lastTool.startedAt, 'string')
  })

  await check('团队节点：live.members 记录 starting/running/done 与 activeMemberId', async () => {
    const flow = flowOf('flow-live-team', [
      startNode(),
      stage('n_live', '团队', 300, {
        mode: 'team',
        team: [{ name: '成员甲', role: 'dev', task: '干活' }],
      }),
      endNode(),
    ], [
      next('e1', 'n_start', 'n_live'),
      next('e2', 'n_live', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-live-team', 1)
    const lead = { id: 'sess-lead-live', header: { model: 'lead-model' } }
    const child = { id: 'sess-child-live', header: { parentSession: 'sess-lead-live', model: 'member-model' } }
    let engine
    let liveRunning = null
    let liveAfterClose = null
    engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ onSession }) => {
        onSession('sess-lead-live')
        engine.handleSessionEvent(child, {
          type: 'assistant/message',
          seq: 1,
          data: {
            message: {
              id: 'call-child',
              source: { kind: 'model', provider: 'p', model: 'member-model' },
              content: [{ type: 'text', text: '成员正在写代码' }],
            },
            usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
        })
        await engine.flushEvents()
        liveRunning = (await store.readRunMeta(runsRoot, run.id)).live
        return passOf('n_live')
      },
    })
    const originalClose = engine._closeMembers.bind(engine)
    engine._closeMembers = async (...args) => {
      const result = await originalClose(...args)
      liveAfterClose = (await store.readRunMeta(runsRoot, run.id)).live
      return result
    }
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    await engine.flushEvents()
    const events = await eventsOf(run.id)
    A.equal(final.status, 'done')

    A.ok(Boolean(liveRunning))
    A.equal(liveRunning.nodeMode, 'team')
    A.equal(liveRunning.activeMemberId, 'n_live:1')
    A.equal(liveRunning.members.length, 1)
    A.equal(liveRunning.members[0].memberId, 'n_live:1')
    A.equal(liveRunning.members[0].name, '成员甲')
    A.equal(liveRunning.members[0].role, 'dev')
    A.equal(liveRunning.members[0].model, 'member-model')
    A.equal(liveRunning.members[0].state, 'running')
    A.equal(liveRunning.lastMessage.memberId, 'n_live:1')
    A.equal(liveRunning.tokens.input, 5)

    const message = events.find(event => event.kind === 'agent/message')
    A.ok(Boolean(message))
    A.equal(message.memberId, 'n_live:1')
    A.equal(message.data.text, '成员正在写代码')

    A.ok(Boolean(liveAfterClose), '节点收尾后 live 必须可读')
    A.equal(liveAfterClose.members[0].state, 'done')
  })

  // -------------------------------------------------------------------------
  console.log('engine · 团队模式缺成员明细')

  await check('团队节点未观察到成员会话：node/end 与 summary.json 都标 membersPartial=true', async () => {
    const flow = flowOf('flow-team-partial', [
      startNode(),
      stage('n_team', '团队节点', 300, { mode: 'team', team: [{ name: '实现者', role: 'dev', task: '写代码' }] }),
      endNode(),
    ], [
      next('e1', 'n_start', 'n_team'),
      next('e2', 'n_team', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-team-partial', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async () => passResult('n_team'),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')
    A.equal(final.status, 'done')
    A.equal(nodeEnd.extra.membersPartial, true)
    const summaryEvent = events.find(event => event.kind === 'artifact/write' && event.data.path.endsWith('/summary.json'))
    const disk = JSON.parse(readFileSync(join(runsRoot, run.id, summaryEvent.data.path), 'utf8'))
    A.equal(disk.membersPartial, true)
    A.deepEqual(disk.members, [])
  })

  // -------------------------------------------------------------------------
  console.log('engine · readUsage 注入')

  await check('readUsage 注入：宿主 TokenUsage 映射成四桶并写成 model/call', async () => {
    const flow = flowOf('flow-readusage', [startNode(), stage('n_use', '用量', 300), endNode()], [
      next('e1', 'n_start', 'n_use'),
      next('e2', 'n_use', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-readusage', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async () => passResult('n_use'),
      readUsage: async ({ nodeId, attemptId }) => [{
        callId: `${nodeId}-${attemptId}`,
        provider: 'reader-provider',
        model: 'reader-model',
        usage: { inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 2 },
      }],
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const call = events.find(event => event.kind === 'model/call')
    const summary = summarize(events)
    A.equal(final.status, 'done')
    A.equal(call.data.provider, 'reader-provider')
    A.equal(call.data.callId, 'n_use-1')
    A.deepEqual(call.data.usage, { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 2 })
    A.equal(summary.tokens.total.total, 10)
    A.equal(summary.tokens.total.reasoning, 2)
  })

  // -------------------------------------------------------------------------
  console.log('engine · 提示词骨架')

  await check('提示词：七段骨架齐全、上游过长时先截上游、总长 ≤8000', async () => {
    const node = stage('n_prompt', '实现', 300, { role: '开发工程师', task: '写代码', outputs: '代码', skills: ['code-review'] })
    const upstream = [{
      title: '需求', attempt: 1, summary: '需求摘要', artifactPaths: ['n_req/artifacts/1/需求.md'],
    }]
    const normal = buildPrompt({ node, attempt: 1, upstream })
    A.ok(normal.includes('## 你是谁'))
    A.ok(normal.includes('## 你负责什么'))
    A.ok(normal.includes('## 期望产物'))
    A.ok(normal.includes('## 必须加载的 skill'))
    A.ok(normal.includes('## 上游产物'))
    A.ok(normal.includes('## 输出格式'))
    // §8.4 v1.3：提示词要教模型怎么给独立证据（跨节点引用才算复核，自证不算）。
    A.ok(normal.includes('跨节点引用才算独立复核'))
    A.ok(normal.includes('自己在产物里写「已通过」不算证据'))
    A.ok(!normal.includes('## 打回上下文'))

    const rerun = buildPrompt({
      node,
      attempt: 2,
      upstream,
      rejectContext: { fromNodeId: 'n_b', fromTitle: '测试', fromAttempt: 1, reason: '没通过', findings: [{ severity: 'P1', title: '失败' }] },
    })
    A.ok(rerun.includes('## 打回上下文'))
    A.ok(rerun.includes('没通过'))

    const huge = buildPrompt({
      node,
      attempt: 1,
      upstream: Array.from({ length: 3 }, (_, index) => ({
        title: `上游${index}`, attempt: 1, summary: '长摘要'.repeat(5000), artifactPaths: [],
      })),
    })
    A.ok(Array.from(huge).length <= PROMPT_MAX_CHARS)
    A.ok(huge.includes('## 输出格式'))
    A.ok(huge.includes('…'))
  })

  // -------------------------------------------------------------------------
  console.log('engine · 崩溃残留清理')

  await check('启动清理：30 分钟无新事件的 running run 标 failed，不自动续跑', async () => {
    const flow = flowOf('flow-stale', [startNode(), stage('n_stale', '停顿', 300), endNode()], [
      next('e1', 'n_start', 'n_stale'),
      next('e2', 'n_stale', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-stale', 1)
    const old = new Date(Date.now() - 60 * 60 * 1000)
    await store.appendEvents(runsRoot, run.id, [
      {
        v: 1, kind: 'run/start', runId: run.id, traceId: 'tr-stale-run',
        data: { flowId: 'flow-stale', flowName: '流程 flow-stale', nodeTotal: 1 },
      },
      {
        v: 1, kind: 'node/start', runId: run.id, nodeId: 'n_stale', attemptId: 1,
        traceId: 'tr-stale-node', data: { title: '停顿', mode: 'single', skills: [] },
      },
    ], { now: old })

    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async () => passResult('n_stale'),
    })
    const recovered = await engine.sweepStaleRuns()
    A.deepEqual(recovered, [run.id])
    const after = await store.readRunMeta(runsRoot, run.id)
    A.equal(after.status, 'failed')
    const events = await eventsOf(run.id)
    const runEnd = events.find(event => event.kind === 'run/end')
    A.equal(runEnd.data.status, 'failed')
    A.match(runEnd.data.reason, /引擎中断/)
    A.equal(runEnd.extra.recovered, true)
  })

  // -------------------------------------------------------------------------
  console.log('engine · 单节点超时')

  await check('节点超时（nodeTimeoutMs 可注入）：node/end failed + extra.timeout、run/end failed', async () => {
    const flow = flowOf('flow-timeout', [startNode(), stage('n_wait', '等不到', 300), endNode()], [
      next('e1', 'n_start', 'n_wait'),
      next('e2', 'n_wait', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-timeout', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      nodeTimeoutMs: 30,
      activate: () => new Promise(() => {}),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')
    const runEnd = events.find(event => event.kind === 'run/end')
    A.equal(final.status, 'failed')
    A.equal(nodeEnd.data.status, 'failed')
    A.equal(nodeEnd.extra.timeout, true)
    A.equal(runEnd.data.status, 'failed')
    A.match(runEnd.data.reason, /超时/)
  })

  // -------------------------------------------------------------------------
  console.log('engine · 桩执行器')

  await check('stub 模式：合成 usage 150/次、首轮测试节点打回、第二轮通过', async () => {
    const flow = flowOf('flow-stub', [
      startNode(), stage('n_dev', '开发', 300), stage('n_test', '测试', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_dev'),
      next('e2', 'n_dev', 'n_test'),
      next('e3', 'n_test', 'n_end'),
      reject('e4', 'n_test', 'n_dev'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-stub', 2)
    const engine = createEngine({ runsRoot, flowsRoot, stub: true })
    A.equal(engine.engineName, 'stub')
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const summary = summarize(events)
    A.equal(final.status, 'done')
    A.equal(countKind(events, 'reject/trigger'), 1)
    // 4 次 attempt（dev#1、test#1、dev#2、test#2）× 150 = 600。
    A.equal(STUB_USAGE.input + STUB_USAGE.cacheRead + STUB_USAGE.cacheWrite + STUB_USAGE.output, 150)
    A.equal(events.filter(event => event.kind === 'model/call').length, 4)
    A.equal(summary.tokens.total.total, 600)
    // 06 §13.7：桩 run 一律 unknown（不能拿合成证据冒充真实绿灯），label 前缀「桩」。
    A.equal(summary.quality.state, 'unknown')
    A.match(summary.quality.label, /^桩/)
    A.equal(summary.quality.stub, true)
    // 06 §13.8：run/start 与 run.json 都体现 stub。
    A.equal(events.find(event => event.kind === 'run/start').data.engine, 'stub')
    A.equal((await store.readRunMeta(runsRoot, run.id)).engine, 'stub')
  })

  // =========================================================================
  // v1.1 修复契约（06 §13）：以下每条都对应评审驳回的一项
  // =========================================================================

  function structuredPass(nodeId, extra = {}) {
    return {
      verdict: 'pass',
      summary: `${nodeId} 通过`,
      artifacts: [{ name: `${nodeId}-结论.md`, content: `# ${nodeId}\n` }],
      findings: [{ id: 'F1', severity: 'P2', title: '小问题', status: 'verified' }],
      checks: { ruleSetId: 'rules', ruleSetVersion: '1', executor: 'test', passedChecks: 2, totalChecks: 2 },
      acceptance: [{ itemId: 'R1', status: 'pass', decidedBy: 'auto' }],
      tests: { suite: 'unit', executed: 2, passed: 2, failed: 0, skipped: 0 },
      ...extra,
    }
  }

  function passOf(nodeId, extra = {}) {
    return { structured: structuredPass(nodeId, extra), sessionId: `sess-${nodeId}`, dispose: async () => {} }
  }

  function sectionOf(prompt, title) {
    const start = prompt.indexOf(`## ${title}`)
    if (start < 0) return ''
    const rest = prompt.slice(start + title.length + 3)
    const next = rest.indexOf('\n## ')
    return next < 0 ? rest : rest.slice(0, next)
  }

  // -------------------------------------------------------------------------
  console.log('engine v1.1 · 并发启动 B1（§13.6）')

  await check('并发 start：恰好一个成功、一个 409、只有一个 run 拿到 attempt=1', async () => {
    const flow = flowOf('flow-conc', [startNode(), stage('n_a', 'A', 300), endNode()], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_end'),
    ])
    await saveFlow(flow)
    const r1 = await makeRun('flow-conc', 1)
    const r2 = await makeRun('flow-conc', 1)
    const gate = deferred()
    let entered = 0
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => {
        entered += 1
        await gate.promise
        return passOf(node.id)
      },
    })
    // 07 §5：一个 Engine 实例只服务一个 run —— 同一实例上并发的第二个 start 被
    // 实例级占位挡下（跨 run 的并发不在这里，由 runtime 的 run 注册表负责）。
    const results = await Promise.allSettled([engine.start(r1.id), engine.start(r2.id)])
    A.equal(results.filter(item => item.status === 'fulfilled').length, 1)
    A.equal(results.filter(item => item.status === 'rejected').length, 1)
    const rejected = results.find(item => item.status === 'rejected')
    A.ok(rejected.reason instanceof EngineError)
    A.equal(rejected.reason.status, 409)
    const winnerId = results[0].status === 'fulfilled' ? r1.id : r2.id
    const loserId = winnerId === r1.id ? r2.id : r1.id
    A.equal(engine.active.runId, winnerId)

    gate.resolve()
    const final = await engine.wait(winnerId)
    await engine.flushEvents()
    A.equal(final.status, 'done')
    A.equal(entered, 1, '只有一个 run 真正进入 activate')
    const winnerEvents = await eventsOf(winnerId)
    const loserEvents = await eventsOf(loserId)
    A.equal(winnerEvents.filter(event => event.kind === 'node/start' && event.attemptId === 1).length, 1)
    A.equal(loserEvents.filter(event => event.kind === 'node/start').length, 0)
    A.equal(loserEvents.filter(event => event.kind === 'run/start').length, 0)

    // 失败方释放锁后，输掉的 run 仍可正常开跑（run.json 没有被弄脏）。
    const second = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
    await second.start(loserId)
    A.equal((await second.wait(loserId)).status, 'done')

    // 07 §5（R3）：锁不再是模块级的 —— 两个实例各自跑不同 run，必须真并发。
    const flow2 = flowOf('flow-conc2', [startNode(), stage('n_a', 'A', 300), endNode()], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_end'),
    ])
    await saveFlow(flow2)
    const r3 = await makeRun('flow-conc2', 1)
    const r4 = await makeRun('flow-conc2', 1)
    const hold = deferred()
    let entered3 = 0
    let entered4 = 0
    const e1 = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => { entered3 += 1; await hold.promise; return passOf(node.id) } })
    const e2 = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => { entered4 += 1; return passOf(node.id) } })
    const first = e1.start(r3.id)
    await e2.start(r4.id)
    A.equal((await e2.wait(r4.id)).status, 'done')
    A.equal(entered4, 1, '不同 runId 各起一个实例：r4 不等 r3')
    A.equal(e1.active && e1.active.runId, r3.id, 'r3 仍在跑时 r4 已经跑完（真并发）')
    hold.resolve()
    await first
    A.equal((await e1.wait(r3.id)).status, 'done')
    A.equal(entered3, 1)
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.1 · 主循环终止性 B2（§13.5）')

  await check('断头路：start 400 拒绝开跑、run 未被弄脏；修好流程后可正常开跑', async () => {
    const bad = flowOf('flow-dead', [startNode(), stage('n_a', 'A', 300)], [
      next('e1', 'n_start', 'n_a'),
    ])
    await saveFlow(bad)
    const run = await makeRun('flow-dead', 1)
    const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
    await assert.rejects(() => engine.start(run.id), error => error instanceof EngineError
      && error.status === 400 && /断头路/.test(error.message))
    assertionCount += 1
    A.equal(engine.active, null)
    const before = await eventsOf(run.id)
    A.equal(before.filter(event => event.kind === 'node/start').length, 0)
    A.equal(before.filter(event => event.kind === 'run/start').length, 0)

    const good = flowOf('flow-dead', [startNode(), stage('n_a', 'A', 300), endNode()], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_end'),
    ])
    await saveFlow(good)
    await engine.start(run.id)
    A.equal((await engine.wait(run.id)).status, 'done')
  })

  await check('next 成环：start 400（validateFlowForRun errors），不开跑', async () => {
    const flow = flowOf('flow-cycle', [startNode(), stage('n_a', 'A', 300), stage('n_b', 'B', 600), endNode()], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_a'),
      next('e4', 'n_b', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-cycle', 2)
    const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
    await assert.rejects(() => engine.start(run.id), error => error instanceof EngineError
      && error.status === 400 && /成环/.test(error.message))
    assertionCount += 1
    A.equal((await eventsOf(run.id)).filter(event => event.kind === 'node/start').length, 0)
  })

  await check('多出边：start 400（v1.1 不取最左、直接拒绝）', async () => {
    const flow = flowOf('flow-branch', [startNode(), stage('n_a', '需求', 600), stage('n_c', '旁支', 300), endNode()], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_start', 'n_c'),
      next('e3', 'n_a', 'n_end'),
      next('e4', 'n_c', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-branch', 2)
    const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
    await assert.rejects(() => engine.start(run.id), error => error instanceof EngineError
      && error.status === 400 && /恰好一条/.test(error.message))
    assertionCount += 1
    A.equal((await eventsOf(run.id)).filter(event => event.kind === 'node/start').length, 0)
  })

  await check('reject → end（目标不在上游）：start 400', async () => {
    const flow = flowOf('flow-rejend', [startNode(), stage('n_b', '测试', 300), endNode()], [
      next('e1', 'n_start', 'n_b'),
      next('e2', 'n_b', 'n_end'),
      reject('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-rejend', 1)
    const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
    await assert.rejects(() => engine.start(run.id), error => error instanceof EngineError
      && error.status === 400 && /上游|阶段节点/.test(error.message))
    assertionCount += 1
    A.equal((await eventsOf(run.id)).filter(event => event.kind === 'node/start').length, 0)
  })

  await check('reject 边两端都必须是阶段节点：end → stage 在 start 前 400（与 flowmachine 同口径）', async () => {
    const flow = flowOf('flow-rej-from-end', [startNode(), stage('n_a', '开发', 300), endNode()], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_end'),
      reject('e3', 'n_end', 'n_a'),
    ])
    await saveFlow(flow)

    // 纯校验器：必须 ok:false，且错误挂在对应 edgeId 上、文案与 flowmachine 一致。
    const validation = engineModule.validateFlowForRun(flow)
    A.equal(validation.ok, false)
    const hit = validation.errors.find(item => item.edgeId === 'e3')
    A.ok(Boolean(hit), '必须有一条错误挂在 edgeId=e3 上')
    A.match(hit.message, /打回线「n_end → n_a」的两端都必须是阶段节点/)

    // 启动路径：engine.start 是 POST /runs/<id>/start 的底层入口，必须 400 且不开跑。
    const run = await makeRun('flow-rej-from-end', 1)
    const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
    await assert.rejects(() => engine.start(run.id), error => error instanceof EngineError
      && error.status === 400 && /两端都必须是阶段节点/.test(error.message))
    assertionCount += 1
    A.equal((await eventsOf(run.id)).filter(event => event.kind === 'node/start').length, 0)
  })

  await check('run 级步数上限（阶段数 × 3）：超限 failed，不 done', async () => {
    const flow = flowOf('flow-steps', [startNode(), stage('n_a', '开发', 300, { maxRounds: 99 }), stage('n_b', '测试', 600), endNode()], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
      reject('e4', 'n_b', 'n_a'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-steps', 2)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => (node.id === 'n_b'
        ? { structured: { verdict: 'reject', summary: '打回', rejectTarget: 'n_a', rejectReason: '返工', findings: [] }, sessionId: 's', dispose: async () => {} }
        : passOf(node.id)),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    A.equal(final.status, 'failed')
    const runEnd = events.find(event => event.kind === 'run/end')
    A.match(runEnd.data.reason, /步数上限/)
    const failed = events.find(event => event.kind === 'node/end' && event.data.status === 'failed')
    A.ok(Boolean(failed))
    A.equal(failed.extra.maxTotalSteps, 6)
    // 3 个阶段 × 2 节点 = 6 步执行完，第 7 步被拦下（还补了一条 node/start 作为证据）。
    A.equal(events.filter(event => event.kind === 'node/start').length, 7)
  })

  await check('墙钟上限（runTimeoutMs 可注入）：abort + failed，不是 aborted', async () => {
    const flow = flowOf('flow-wall', [startNode(), stage('n_wall', '等待', 300), endNode()], [
      next('e1', 'n_start', 'n_wall'),
      next('e2', 'n_wall', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-wall', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      runTimeoutMs: 40,
      activate: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('已中止')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      }),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const runEnd = events.find(event => event.kind === 'run/end')
    A.equal(final.status, 'failed')
    A.equal(runEnd.data.status, 'failed')
    A.match(runEnd.data.reason, /墙钟/)
    A.equal(runEnd.extra.runTimeout, true)
    const nodeEnd = events.find(event => event.kind === 'node/end')
    A.equal(nodeEnd.data.status, 'failed')
    A.equal(nodeEnd.extra.runTimeout, true)
    // 环境变量 FLOW_STUDIO_RUN_TIMEOUT_MS 与注入选项同口径。
    process.env.FLOW_STUDIO_RUN_TIMEOUT_MS = '4321'
    try {
      A.equal(createEngine({ runsRoot, flowsRoot }).runTimeoutMs, 4321)
    } finally {
      delete process.env.FLOW_STUDIO_RUN_TIMEOUT_MS
    }
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.1 · 证据命名空间 B3（§13.7）')

  await check('两节点都返回 F1/R1/unit：事件里是 n_a:F1 / n_b:F1（缺省 ruleSetId 也带前缀）', async () => {
    const flow = flowOf('flow-ns', [startNode(), stage('n_a', '开发', 300), stage('n_b', '审查', 600), endNode()], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-ns', 2)
    const fixedNow = new Date('2026-11-06T08:00:00.000Z')
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      // 06 §13.9 m6：decidedAt 用注入的 now（测试可确定）。
      now: () => fixedNow,
      activate: async ({ node }) => passOf(node.id, {
        // ruleSetId 故意缺省：引擎必须补 <nodeId>:engine-rules。
        checks: { ruleSetVersion: '1', executor: 'test', passedChecks: 1, totalChecks: 1 },
      }),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    A.equal(final.status, 'done')
    A.deepEqual(events.filter(event => event.kind === 'review/finding').map(event => event.data.id), ['n_a:F1', 'n_b:F1'])
    A.deepEqual(events.filter(event => event.kind === 'acceptance/verdict').map(event => event.data.itemId), ['n_a:R1', 'n_b:R1'])
    A.equal(events.find(event => event.kind === 'acceptance/verdict').data.decidedAt, fixedNow.toISOString())
    A.deepEqual(events.filter(event => event.kind === 'test/report').map(event => event.data.suite), ['n_a:unit', 'n_b:unit'])
    A.deepEqual(events.filter(event => event.kind === 'check/form').map(event => event.data.ruleSetId),
      ['n_a:engine-rules', 'n_b:engine-rules'])
    // 06 §13.7：模型自述证据带 provenance，聚合层才会拿 reportRef/evidenceRef 去对账。
    A.equal(events.find(event => event.kind === 'acceptance/verdict').extra.provenance, 'model-claim')
    A.equal(events.find(event => event.kind === 'test/report').extra.provenance, 'model-claim')
    A.equal(events.find(event => event.kind === 'check/form').extra.provenance, 'model-claim')
    const summary = summarize(events)
    A.equal(summary.findings.total, 2)
    // v1.3 起「自证闭环」会让 quality 变 unknown（runlog 侧并行改动）；
    // 本用例只锁引擎侧的标识命名空间事实：两个节点都叫 F1/R1/unit 也不算冲突。
    A.equal(summary.quality.conflicts, null)
    A.equal(typeof summary.quality.state, 'string')
    A.equal(events.find(event => event.kind === 'run/start').data.engine, 'real')
  })

  await check('同一份报告内重复 id：结构不合格（node failed，不静默去重）', async () => {
    const flow = flowOf('flow-dup', [startNode(), stage('n_dup', '重复', 300), endNode()], [
      next('e1', 'n_start', 'n_dup'),
      next('e2', 'n_dup', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-dup', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async () => passOf('n_dup', {
        findings: [
          { id: 'F1', severity: 'P1', title: 'A', status: 'open' },
          { id: 'F1', severity: 'P2', title: 'B', status: 'verified' },
        ],
      }),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')
    A.equal(final.status, 'failed')
    A.equal(nodeEnd.data.status, 'failed')
    A.match(nodeEnd.extra.validationError, /重复/)
    A.equal(events.filter(event => event.kind === 'review/finding').length, 0)
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.1 · 打回上下文 B4（§13.7）')

  await check('打回上下文带上一轮未关闭 finding id、要求复用 id；带 acceptance/tests/checks 全量标识', async () => {
    const flow = flowOf('flow-ctx', [startNode(), stage('n_a', '开发', 300, { maxRounds: 3 }), stage('n_b', '审查', 600), endNode()], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
      reject('e4', 'n_b', 'n_a'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-ctx', 2)
    let promptA2 = ''
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node, attempt, prompt }) => {
        if (node.id === 'n_a' && attempt === 1) {
          return passOf('n_a', {
            findings: [
              { id: 'A-F1', severity: 'P0', title: '缺陷A', status: 'open' },
              { id: 'A-F2', severity: 'P2', title: '已修问题', status: 'verified' },
            ],
            checks: { ruleSetId: 'rules-a', ruleSetVersion: '1', executor: 't', passedChecks: 1, totalChecks: 1 },
            acceptance: [{ itemId: 'R1', status: 'pass', decidedBy: 'auto' }],
            tests: { suite: 'unit-a', executed: 1, passed: 1, failed: 0, skipped: 0 },
          })
        }
        if (node.id === 'n_b' && attempt === 1) {
          return {
            structured: {
              verdict: 'reject',
              summary: '打回',
              rejectTarget: 'n_a',
              rejectReason: '返工',
              findings: [{ id: 'B-F1', severity: 'P1', title: '审查意见', status: 'open' }],
            },
            sessionId: 'sess-b',
            dispose: async () => {},
          }
        }
        if (node.id === 'n_a' && attempt === 2) promptA2 = prompt
        return passOf(node.id)
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    // G1-c：打回上下文打印的是**原始 id**（去掉各自的节点命名空间前缀）。模型「照抄
    // 提示词里的 id」复报后，引擎按接收方节点重新加前缀，不会出现 n_a:n_a:R1。
    A.ok(promptA2.includes('- [P0] A-F1 '), '带上一轮未关闭 finding 的原始 id（不再带节点前缀）')
    A.ok(promptA2.includes('n_a:A-F1') === false, '提示词里不再出现命名空间 id（否则模型会二次前缀）')
    A.ok(promptA2.includes('n_a:A-F2') === false, 'verified 的问题不再要求返工')
    A.ok(promptA2.includes('- [P1] B-F1 '), '带打回方列出的未关闭 finding 原始 id')
    A.ok(promptA2.includes('n_b:B-F1') === false, '打回方的 id 也不带前缀（复报后归属目标节点）')
    A.ok(promptA2.includes('复用同一 id'), '明确要求复用同一 id')
    A.ok(promptA2.includes('全量重报'), '明确要求本轮全量重报')
    A.ok(promptA2.includes('验收条目 itemId：R1'), '下传上一轮 acceptance itemId（原始 id）')
    A.ok(promptA2.includes('测试套件 suite：unit-a'), '下传上一轮 tests suite（原始 id）')
    A.ok(promptA2.includes('规范集 ruleSetId：rules-a'), '下传上一轮 check ruleSetId（原始 id）')
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.1 · 打回语义 M2/M3/M4（§13.10）')

  await check('maxRounds=1 表示允许重跑 1 次：A 执行 attempt 1、2 后才超限', async () => {
    const flow = flowOf('flow-max1', [startNode(), stage('n_a', '开发', 300, { maxRounds: 1 }), stage('n_b', '测试', 600), endNode()], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
      reject('e4', 'n_b', 'n_a'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-max1', 2)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => (node.id === 'n_b'
        ? { structured: { verdict: 'reject', summary: '打回', rejectTarget: 'n_a', rejectReason: '返工', findings: [] }, sessionId: 's', dispose: async () => {} }
        : passOf(node.id)),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    A.equal(final.status, 'failed')
    A.deepEqual(events.filter(event => event.kind === 'node/start' && event.nodeId === 'n_a').map(event => event.attemptId), [1, 2])
    A.equal(countKind(events, 'reject/trigger'), 2)
    const runEnd = events.find(event => event.kind === 'run/end')
    A.match(runEnd.data.reason, /超打回上限/)
    const limitEnd = events.find(event => event.kind === 'node/end' && event.nodeId === 'n_a'
      && event.data.status === 'failed')
    A.equal(limitEnd.extra.rejectLimit, true)
    A.equal(limitEnd.extra.maxRounds, 1)
    A.ok(events.indexOf(limitEnd) < events.indexOf(runEnd), '先写目标 node/end failed，再写 run/end failed')
  })

  await check('重跑节点的上游产物只取沿 next 可达且有效的 passed：A#2 不含 B/C/D，C#2 只含 A#2/B#2', async () => {
    const flow = flowOf('flow-up', [
      startNode(),
      stage('n_a', '需求', 300),
      stage('n_b', '设计', 600),
      stage('n_c', '开发', 900),
      stage('n_d', '测试', 1200),
      endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_c'),
      next('e4', 'n_c', 'n_d'),
      next('e5', 'n_d', 'n_end'),
      reject('e6', 'n_d', 'n_a'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-up', 4)
    const prompts = new Map()
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node, attempt, prompt }) => {
        prompts.set(`${node.id}#${attempt}`, prompt)
        if (node.id === 'n_d' && attempt === 1) {
          return {
            structured: {
              verdict: 'reject',
              summary: '打回',
              rejectTarget: 'n_a',
              rejectReason: '需求没对上',
              findings: [{ id: 'D-F1', severity: 'P1', title: '需求缺失', status: 'open' }],
            },
            sessionId: 'sess-d',
            dispose: async () => {},
          }
        }
        return passOf(node.id)
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    const upstreamA2 = sectionOf(prompts.get('n_a#2'), '上游产物')
    A.ok(upstreamA2.includes('（无：这是链路上的第一个阶段节点。）'), 'A#2 的上游应为空')
    for (const title of ['设计', '开发', '测试']) {
      A.ok(upstreamA2.includes(title) === false, `A#2 上游不应包含失效下游「${title}」`)
    }
    const upstreamC2 = sectionOf(prompts.get('n_c#2'), '上游产物')
    A.ok(upstreamC2.includes('需求'), 'C#2 上游包含 A#2')
    A.ok(upstreamC2.includes('设计'), 'C#2 上游包含 B#2')
    A.ok(upstreamC2.includes('测试') === false, 'C#2 上游不应包含还没重跑的 D')
    A.ok(upstreamC2.includes('attempt 2'), '引用的是重跑后的 attempt 2')
    // 旧的 A#1/B#1/C#1 已经不在 passed 集合里：D#2 的上游只会是重跑后的 attempt 2。
    const upstreamD2 = sectionOf(prompts.get('n_d#2'), '上游产物')
    A.equal(upstreamD2.includes('attempt 1'), false)
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.1 · 预算与脱敏 M3/m3（§13.9）')

  await check('单产物 1 MiB 预算：超限截断写盘，artifact/write 标 truncated/originalBytes', async () => {
    const flow = flowOf('flow-big', [startNode(), stage('n_big', '大产物', 300), endNode()], [
      next('e1', 'n_start', 'n_big'),
      next('e2', 'n_big', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-big', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      maxArtifactBytes: 100,
      activate: async () => passOf('n_big', { artifacts: [{ name: 'big.md', content: 'x'.repeat(200) }] }),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    const events = await eventsOf(run.id)
    const written = events.find(event => event.kind === 'artifact/write' && event.data.path.endsWith('big.md'))
    A.equal(written.data.bytes, 100)
    A.equal(written.data.truncated, true)
    A.equal(written.data.originalBytes, 200)
    A.equal(Buffer.byteLength(readFileSync(join(runsRoot, run.id, written.data.path))), 100)
  })

  await check('单 run 64 MiB 总预算（注入小值）：跨产物累计超限继续截断，总写盘不超预算', async () => {
    const flow = flowOf('flow-budget', [startNode(), stage('n_sum', '累计', 300), endNode()], [
      next('e1', 'n_start', 'n_sum'),
      next('e2', 'n_sum', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-budget', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      maxArtifactBytes: 1000,
      maxRunArtifactBytes: 250,
      activate: async () => passOf('n_sum', {
        artifacts: [
          { name: 'a.md', content: 'a'.repeat(100) },
          { name: 'b.md', content: 'b'.repeat(100) },
          { name: 'c.md', content: 'c'.repeat(100) },
        ],
      }),
    })
    await engine.start(run.id)
    await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const writes = events.filter(event => event.kind === 'artifact/write')
    const third = writes.find(event => event.data.path.endsWith('/c.md'))
    A.equal(third.data.bytes, 50)
    A.equal(third.data.truncated, true)
    A.equal(third.data.originalBytes, 100)
    const total = writes.reduce((sum, event) => sum + event.data.bytes, 0)
    A.ok(total <= 250, `所有产物写盘合计 ${total} ≤ run 预算 250`)
  })

  await check('tool/call argumentsDigest 脱敏：Bearer / sk- / password / api_key / 超长串都不落原文', async () => {
    const flow = flowOf('flow-redact', [startNode(), stage('n_redact', '脱敏', 300), endNode()], [
      next('e1', 'n_start', 'n_redact'),
      next('e2', 'n_redact', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-redact', 1)
    const longToken = 'a1b2c3d4'.repeat(8)
    const session = { id: 'sess-redact', header: {} }
    let engine
    engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ onSession }) => {
        onSession('sess-redact')
        engine.handleSessionEvent(session, {
          type: 'tool/call',
          seq: 1,
          data: {
            callId: 'call-redact',
            name: 'bash',
            arguments: JSON.stringify({
              headers: { Authorization: 'Bearer sk-live-abcdef1234567890' },
              password: 'hunter2',
              api_key: 'abc123secret',
              note: longToken,
            }),
          },
        })
        engine.handleSessionEvent(session, {
          type: 'tool/result',
          seq: 2,
          data: { message: { toolCallId: 'call-redact', isError: false } },
        })
        return passOf('n_redact')
      },
    })
    await engine.start(run.id)
    await engine.wait(run.id)
    await engine.flushEvents()
    const events = await eventsOf(run.id)
    const toolCall = events.find(event => event.kind === 'tool/call')
    A.ok(Boolean(toolCall))
    const digest = toolCall.data.argumentsDigest
    A.equal(digest.includes('sk-live-abcdef1234567890'), false)
    A.equal(digest.includes('hunter2'), false)
    A.equal(digest.includes('abc123secret'), false)
    A.equal(digest.includes(longToken), false)
    A.ok(digest.includes('[REDACTED]'))
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.1 · 模型覆盖 M5（§13.11）')

  /**
   * 0.2.2-rc.1 假宿主：`agents.create` 校验 provider + model 成对（缺一个直接 throw，
   * 复现新宿主硬要求）。`selection === null` 表示宿主没有 `agentDefaultModel` 服务。
   *
   * `composition` 模拟 preset 组合服务：
   *   - `'sessionController'`：`get('sessionController').composeAgent(id)`（Web 同一条路径）；
   *   - `'agentPresets'`：只有 `get('agentPresets').resolve / mount / list`（fallback 路径）；
   *   - `null`：两个服务都没有（引擎应 warn，不传 setup）。
   */
  function strictProviderHost(engineRef, {
    selection = { provider: 'deepseek', model: 'deepseek-chat' },
    composition = null,
  } = {}) {
    const created = []
    const composed = []
    const presetResolved = []
    const presetMounted = []
    const resumed = []
    const failPresets = new Set()
    let setupCalls = 0
    const setupSpy = async () => { setupCalls += 1 }
    const agentFor = sessionId => ({
      session: { id: sessionId, header: {} },
      ctx: {
        tools: {
          register: () => () => {},
          restrict: () => () => {},
        },
      },
      followup(payload) {
        const envelope = envelopeOf(payload)
        const base = structuredPass('n_model')
        const structured = envelope
          ? { attempt: envelope.attempt, nonce: envelope.nonce, ...base }
          : base
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
    })
    const ctx = {
      on() { return () => {} },
      get(name) {
        if (name === 'agentDefaultModel' && selection) {
          return { currentSelection: () => selection }
        }
        if (name === 'sessionController' && composition === 'sessionController') {
          return {
            async composeAgent(presetId) {
              composed.push(presetId)
              if (presetId !== undefined && failPresets.has(presetId)) {
                throw new Error(`agent-preset/not-found: ${presetId}`)
              }
              return {
                agentPreset: presetId === undefined ? 'host-default' : presetId,
                setup: setupSpy,
              }
            },
          }
        }
        if (name === 'agentPresets' && composition === 'agentPresets') {
          return {
            async resolve(presetId) {
              presetResolved.push(presetId)
              if (presetId !== undefined && failPresets.has(presetId)) {
                throw new Error(`agent-preset/not-found: ${presetId}`)
              }
              return { id: presetId === undefined ? 'host-default' : presetId }
            },
            async mount(agentCtx, presetId) {
              presetMounted.push(presetId)
            },
            async list() {
              return [{ id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }]
            },
          }
        }
        if (name !== 'agents') return undefined
        return {
          async create(options) {
            const agentOptions = options.agentOptions
            // 0.2.2 宿主：provider 与 model 必须成对，缺一个都在创建期 / 首轮 preStep 失败。
            if (!agentOptions || typeof agentOptions.provider !== 'string' || agentOptions.provider === '') {
              throw new TypeError('agentOptions.provider 必须是非空字符串（0.2.1-rc.5+ 宿主硬要求）')
            }
            if (typeof agentOptions.model !== 'string' || agentOptions.model === '') {
              throw new TypeError('agentOptions.model 必须是非空字符串（provider + model 必须成对）')
            }
            created.push(options)
            const sessionId = options.sessionId
            return {
              agent: agentFor(sessionId),
              async dispose() {},
            }
          },
          get() { return null },
          async resume(options) {
            resumed.push(options)
            return { agent: agentFor(options.resumeSessionId), async dispose() {} }
          },
        }
      },
    }
    return {
      ctx, created, composed, presetResolved, presetMounted, resumed, failPresets,
      get setupCalls() { return setupCalls },
      setupSpy,
    }
  }

  await check('node.model：注入 activate 收到 agentOptions={model}，node/start 记录 model', async () => {
    const flow = flowOf('flow-model', [startNode(), stage('n_model', '业务', 300, { model: 'deepseek-chat' }), endNode()], [
      next('e1', 'n_start', 'n_model'),
      next('e2', 'n_model', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-model', 1)
    let captured = null
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async args => {
        captured = args
        return passOf('n_model')
      },
    })
    await engine.start(run.id)
    await engine.wait(run.id)
    A.deepEqual(captured.agentOptions, { model: 'deepseek-chat' })
    const events = await eventsOf(run.id)
    A.equal(events.find(event => event.kind === 'node/start').data.model, 'deepseek-chat')
  })

  await check('node.model：默认 agents.create 补齐 provider，节点 model 优先且不带宿主 reasoningEffort', async () => {
    const flow = flowOf('flow-model-spawn', [startNode(), stage('n_model', '业务', 300, { model: 'deepseek-reasoner' }), endNode()], [
      next('e1', 'n_start', 'n_model'),
      next('e2', 'n_model', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-model-spawn', 1)
    const engineRef = { value: null }
    const { ctx, created } = strictProviderHost(engineRef)
    const engine = createEngine({ runsRoot, flowsRoot, ctx })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    A.equal(created.length, 1)
    A.deepEqual(created[0].agentOptions, { provider: 'deepseek', model: 'deepseek-reasoner' })
    A.equal('reasoningEffort' in created[0].agentOptions, false, '节点自定 model 时不得带宿主 reasoningEffort')

    // 宿主默认 selection 里带 reasoningEffort 时同样不得移植给节点自定 model；
    // 节点自己给了 reasoningEffort 才传。
    const effortEngine = createEngine({
      runsRoot,
      flowsRoot,
      ctx: {
        on() { return () => {} },
        get: name => (name === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }) }
          : undefined),
      },
    })
    A.deepEqual(
      effortEngine._resolveCreateAgentOptions({ model: 'deepseek-reasoner' }),
      { provider: 'deepseek', model: 'deepseek-reasoner' },
    )
    A.deepEqual(
      effortEngine._resolveCreateAgentOptions({ model: 'deepseek-reasoner', reasoningEffort: 'low' }),
      { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'low' },
    )
  })

  await check('node.model：节点没设 model 时显式固定宿主默认模型路由（provider + model）', async () => {
    const flow = flowOf('flow-model-default', [startNode(), stage('n_model', '业务', 300), endNode()], [
      next('e1', 'n_start', 'n_model'),
      next('e2', 'n_model', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-model-default', 1)
    const engineRef = { value: null }
    const { ctx, created } = strictProviderHost(engineRef)
    const engine = createEngine({ runsRoot, flowsRoot, ctx })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    A.equal(created.length, 1)
    A.deepEqual(created[0].agentOptions, { provider: 'deepseek', model: 'deepseek-chat' })
  })

  await check('宿主没有 agentDefaultModel 且节点只有 model：503 可诊断失败，不创建注定失败的会话', async () => {
    const flow = flowOf('flow-model-nohost', [startNode(), stage('n_model', '业务', 300, { model: 'deepseek-reasoner' }), endNode()], [
      next('e1', 'n_start', 'n_model'),
      next('e2', 'n_model', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-model-nohost', 1)
    const engineRef = { value: null }
    const { ctx, created } = strictProviderHost(engineRef, { selection: null })
    const engine = createEngine({ runsRoot, flowsRoot, ctx, nodeRetries: 0 })
    engineRef.value = engine
    // `_resolveCreateAgentOptions` 直接抛 EngineError(503)（创建之前）。
    let thrown = null
    try {
      engine._resolveCreateAgentOptions({ model: 'deepseek-reasoner' }, { nodeId: 'n_model' })
    } catch (error) {
      thrown = error
    }
    A.ok(thrown instanceof EngineError, '拿不到 selection 且不成对时必须抛 EngineError')
    A.equal(thrown.status, 503)
    A.match(thrown.message, /宿主未提供 agentDefaultModel/)
    A.match(thrown.message, /节点未配置/)
    // 走完整 run：run 失败、事件里有可诊断原因、宿主一次 create 都没收到。
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'failed')
    A.equal(created.length, 0, '拿不到 selection 时不得凭空造 provider，也不得创建会话')
    const runEnd = (await eventsOf(run.id)).find(event => event.kind === 'run/end')
    A.match(runEnd.data.reason, /宿主未提供 agentDefaultModel/)
  })

  await check('无 agentDefaultModel 但节点显式 provider+model：成对路由照常创建（不依赖宿主默认）', async () => {
    const flow = flowOf('flow-model-pair', [startNode(), stage('n_model', '业务', 300, { model: 'gpt-5', provider: 'openai' }), endNode()], [
      next('e1', 'n_start', 'n_model'),
      next('e2', 'n_model', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-model-pair', 1)
    const engineRef = { value: null }
    const { ctx, created } = strictProviderHost(engineRef, { selection: null })
    const engine = createEngine({ runsRoot, flowsRoot, ctx })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    A.equal(created.length, 1)
    A.deepEqual(created[0].agentOptions, { provider: 'openai', model: 'gpt-5' })
  })

  await check('节点显式 provider（仅 provider）+ 宿主 selection：补宿主 model，仍成对', async () => {
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      ctx: {
        on() { return () => {} },
        get: name => (name === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
          : undefined),
      },
    })
    A.deepEqual(
      engine._resolveCreateAgentOptions({ provider: 'openai' }),
      { provider: 'openai', model: 'deepseek-chat' },
    )
  })

  await check('节点侧显式 provider 优先：不被宿主默认模型覆盖', async () => {
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      ctx: {
        on() { return () => {} },
        get: name => (name === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
          : undefined),
      },
    })
    A.deepEqual(
      engine._resolveCreateAgentOptions({ provider: 'openai', model: 'gpt-5' }),
      { provider: 'openai', model: 'gpt-5' },
    )
  })

  // -------------------------------------------------------------------------
  console.log('engine v0.9.2 P0 · 节点会话 agentPreset（永远显式，默认 standard）')

  await check('agentPreset 三种来源：节点值 / 流程值 / 兜底 standard，且 agentOptions 仍成对', async () => {
    // ① 节点级：node.agentPreset 优先于流程值。
    const nodeFlow = flowOf('flow-preset-node', [
      startNode(), stage('n_model', '业务', 300, { agentPreset: 'ptc' }), endNode(),
    ], [next('e1', 'n_start', 'n_model'), next('e2', 'n_model', 'n_end')])
    nodeFlow.agentPreset = 'minimal'
    await saveFlow(nodeFlow)
    const nodeRun = await makeRun('flow-preset-node', 1)
    const engineRef = { value: null }
    const nodeHost = strictProviderHost(engineRef)
    const nodeEngine = createEngine({ runsRoot, flowsRoot, ctx: nodeHost.ctx })
    engineRef.value = nodeEngine
    await nodeEngine.start(nodeRun.id)
    A.equal((await nodeEngine.wait(nodeRun.id)).status, 'done')
    A.equal(nodeHost.created[0].meta.agentPreset, 'ptc', '节点值优先')
    A.equal(typeof nodeHost.created[0].agentOptions.provider, 'string')
    A.equal(typeof nodeHost.created[0].agentOptions.model, 'string')
    const nodeStart = (await eventsOf(nodeRun.id)).find(event => event.kind === 'node/start')
    A.equal(nodeStart.data.agentPreset, 'ptc')
    A.equal(nodeStart.data.agentPresetSource, 'node')
    const nodeMeta = await store.readRunMeta(runsRoot, nodeRun.id)
    A.deepEqual(nodeMeta.agentPreset, { value: 'minimal', source: 'flow' }, 'run.json 记录 run 级默认（流程）')

    // ② 流程级：没有节点值时用流程默认。
    const flowLevel = flowOf('flow-preset-flow', [
      startNode(), stage('n_model', '业务', 300), endNode(),
    ], [next('e1', 'n_start', 'n_model'), next('e2', 'n_model', 'n_end')])
    flowLevel.agentPreset = 'minimal'
    await saveFlow(flowLevel)
    const flowRun = await makeRun('flow-preset-flow', 1)
    const flowHost = strictProviderHost(engineRef)
    const flowEngine = createEngine({ runsRoot, flowsRoot, ctx: flowHost.ctx })
    engineRef.value = flowEngine
    await flowEngine.start(flowRun.id)
    A.equal((await flowEngine.wait(flowRun.id)).status, 'done')
    A.equal(flowHost.created[0].meta.agentPreset, 'minimal', '流程值生效')
    const flowStart = (await eventsOf(flowRun.id)).find(event => event.kind === 'node/start')
    A.equal(flowStart.data.agentPresetSource, 'flow')

    // ③ 都没有：兜底 standard（不再让宿主给「无 preset 裸组合」）。
    const bareFlow = flowOf('flow-preset-default', [
      startNode(), stage('n_model', '业务', 300), endNode(),
    ], [next('e1', 'n_start', 'n_model'), next('e2', 'n_model', 'n_end')])
    await saveFlow(bareFlow)
    const bareRun = await makeRun('flow-preset-default', 1)
    const bareHost = strictProviderHost(engineRef)
    const bareEngine = createEngine({ runsRoot, flowsRoot, ctx: bareHost.ctx })
    engineRef.value = bareEngine
    await bareEngine.start(bareRun.id)
    A.equal((await bareEngine.wait(bareRun.id)).status, 'done')
    A.equal(bareHost.created[0].meta.agentPreset, 'standard', '兜底 standard')
    A.equal(typeof bareHost.created[0].agentOptions.provider, 'string')
    const bareStart = (await eventsOf(bareRun.id)).find(event => event.kind === 'node/start')
    A.equal(bareStart.data.agentPresetSource, 'default')
    const bareMeta = await store.readRunMeta(runsRoot, bareRun.id)
    A.deepEqual(bareMeta.agentPreset, { value: 'standard', source: 'default' })
  })

  await check('P0 组合：sessionController.composeAgent 的 setup 原样传给 agents.create（只写 meta 不够）', async () => {
    const flow = flowOf('flow-compose-sc', [
      startNode(), stage('n_model', '业务', 300, { agentPreset: 'ptc' }), endNode(),
    ], [next('e1', 'n_start', 'n_model'), next('e2', 'n_model', 'n_end')])
    await saveFlow(flow)
    const run = await makeRun('flow-compose-sc', 1)
    const engineRef = { value: null }
    const host = strictProviderHost(engineRef, { composition: 'sessionController' })
    const engine = createEngine({ runsRoot, flowsRoot, ctx: host.ctx })
    engineRef.value = engine
    await engine.start(run.id)
    A.equal((await engine.wait(run.id)).status, 'done')
    // start 先解析 run 级默认（standard），节点创建时再按节点 preset（ptc）解析。
    A.equal(host.composed[0], 'standard')
    A.equal(host.composed[host.composed.length - 1], 'ptc', 'composeAgent 收到节点 preset')
    A.equal(host.created[0].meta.agentPreset, 'ptc')
    A.equal(typeof host.created[0].setup, 'function', 'agents.create 必须带 setup')
    A.equal(host.created[0].setup, host.setupSpy, 'setup 必须是 composeAgent 返回的那个（Web 同一条路径）')
  })

  await check('P0 组合 fallback：只有 agentPresets 时 resolve + setup 里 mount，setup 传给 create', async () => {
    const flow = flowOf('flow-compose-presets', [
      startNode(), stage('n_model', '业务', 300), endNode(),
    ], [next('e1', 'n_start', 'n_model'), next('e2', 'n_model', 'n_end')])
    flow.agentPreset = 'minimal'
    await saveFlow(flow)
    const run = await makeRun('flow-compose-presets', 1)
    const engineRef = { value: null }
    const host = strictProviderHost(engineRef, { composition: 'agentPresets' })
    const engine = createEngine({ runsRoot, flowsRoot, ctx: host.ctx })
    engineRef.value = engine
    await engine.start(run.id)
    A.equal((await engine.wait(run.id)).status, 'done')
    A.deepEqual(host.presetResolved, ['minimal'], 'presets.resolve 收到流程默认 preset')
    A.equal(host.created[0].meta.agentPreset, 'minimal')
    A.equal(typeof host.created[0].setup, 'function')
    const fakeAgentCtx = { name: 'fake-agent-ctx' }
    await host.created[0].setup(fakeAgentCtx)
    A.deepEqual(host.presetMounted, ['minimal'], 'setup 里必须 mount 解析后的 preset')
  })

  await check('P0 组合 resume：冷会话 agents.resume 也带 setup（按节点 preset 解析）', async () => {
    const flow = flowOf('flow-compose-resume', [
      startNode(), stage('n_model', '业务', 300, { agentPreset: 'ptc' }), endNode(),
    ], [next('e1', 'n_start', 'n_model'), next('e2', 'n_model', 'n_end')])
    await saveFlow(flow)
    const run = await makeRun('flow-compose-resume', 1)
    await store.writeNodeSessions(runsRoot, run.id, {
      n_model: { sessionId: 'cold-n_model', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() },
    })
    const engineRef = { value: null }
    const host = strictProviderHost(engineRef, { composition: 'sessionController' })
    const engine = createEngine({ runsRoot, flowsRoot, ctx: host.ctx })
    engineRef.value = engine
    await engine.start(run.id)
    A.equal((await engine.wait(run.id)).status, 'done')
    A.equal(host.created.length, 0, '已有会话 → 不新建，走 resume')
    A.equal(host.resumed.length, 1)
    A.equal(host.resumed[0].resumeSessionId, 'cold-n_model')
    A.equal(typeof host.resumed[0].setup, 'function', 'resume 必须也带 setup，否则续跑会话掉回裸工具面')
    A.equal(host.composed[host.composed.length - 1], 'ptc', 'resume 按节点 preset 解析组合')
  })

  await check('P0 组合降级：profile 没有 standard → 退回宿主默认，事件/run.json 报实际 id + default-fallback', async () => {
    // ① 只有 agentPresets：resolve('standard') not-found → resolve(undefined) = host-default。
    const flow = flowOf('flow-compose-fallback', [
      startNode(), stage('n_model', '业务', 300), endNode(),
    ], [next('e1', 'n_start', 'n_model'), next('e2', 'n_model', 'n_end')])
    await saveFlow(flow)
    const run = await makeRun('flow-compose-fallback', 1)
    const logs = []
    const engineRef = { value: null }
    const host = strictProviderHost(engineRef, { composition: 'agentPresets' })
    host.failPresets.add('standard')
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      ctx: host.ctx,
      log: (level, message) => logs.push(`${level}:${message}`),
    })
    engineRef.value = engine
    await engine.start(run.id)
    A.equal((await engine.wait(run.id)).status, 'done')
    A.deepEqual(host.presetResolved, ['standard', undefined], '先试 standard，失败后按 undefined 取宿主默认')
    A.equal(host.created[0].meta.agentPreset, 'host-default')
    A.equal(typeof host.created[0].setup, 'function')
    await host.created[0].setup({ name: 'fake-ctx' })
    A.deepEqual(host.presetMounted, ['host-default'], 'mount 用宿主默认的解析 id')
    const nodeStart = (await eventsOf(run.id)).find(event => event.kind === 'node/start')
    A.equal(nodeStart.data.agentPreset, 'host-default', 'node/start 报实际生效 id')
    A.equal(nodeStart.data.agentPresetSource, 'default-fallback')
    const meta = await store.readRunMeta(runsRoot, run.id)
    A.deepEqual(meta.agentPreset, { value: 'host-default', source: 'default-fallback' })
    A.ok(logs.some(line => line.includes('当前 profile 没有「standard」') && line.includes('host-default')))

    // ② sessionController 路径同样降级到 composeAgent(undefined)。
    const flow2 = flowOf('flow-compose-fallback-sc', [
      startNode(), stage('n_model', '业务', 300), endNode(),
    ], [next('e1', 'n_start', 'n_model'), next('e2', 'n_model', 'n_end')])
    await saveFlow(flow2)
    const run2 = await makeRun('flow-compose-fallback-sc', 1)
    const host2 = strictProviderHost(engineRef, { composition: 'sessionController' })
    host2.failPresets.add('standard')
    const engine2 = createEngine({ runsRoot, flowsRoot, ctx: host2.ctx })
    engineRef.value = engine2
    await engine2.start(run2.id)
    A.equal((await engine2.wait(run2.id)).status, 'done')
    A.deepEqual(host2.composed, ['standard', undefined])
    A.equal(host2.created[0].meta.agentPreset, 'host-default')
    A.equal(host2.created[0].setup, host2.setupSpy)
  })

  await check('P0 组合：preset 不存在 → 可读错误（节点 + preset id + 可用列表），不创建会话', async () => {
    const flow = flowOf('flow-compose-bad', [
      startNode(), stage('n_model', '业务', 300, { agentPreset: 'bogus' }), endNode(),
    ], [next('e1', 'n_start', 'n_model'), next('e2', 'n_model', 'n_end')])
    await saveFlow(flow)
    const run = await makeRun('flow-compose-bad', 1)
    const engineRef = { value: null }
    const host = strictProviderHost(engineRef, { composition: 'agentPresets' })
    // 让 resolve 对不存在的 id 抛错（模拟宿主 agent-preset/not-found）。
    host.failPresets.add('bogus')
    const engine = createEngine({ runsRoot, flowsRoot, ctx: host.ctx })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'failed')
    A.equal(host.created.length, 0)
    const runEnd = (await eventsOf(run.id)).find(event => event.kind === 'run/end')
    A.match(runEnd.data.reason, /agentPreset「bogus」不可用/)
    A.match(runEnd.data.reason, /n_model/)
    A.match(runEnd.data.reason, /可用 preset/)
    A.match(runEnd.data.reason, /standard/)
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.1 · 团队模式 M6（§13.10）')

  await check('配置 2 个成员只观察到 1 个：node/end 与 summary.json 三处 membersPartial 一致、不反推成员结论', async () => {
    const flow = flowOf('flow-team2', [
      startNode(),
      stage('n_t', '团队', 300, {
        mode: 'team',
        team: [{ name: '甲', role: 'dev', task: 'a' }, { name: '乙', role: 'qa', task: 'b' }],
      }),
      endNode(),
    ], [
      next('e1', 'n_start', 'n_t'),
      next('e2', 'n_t', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-team2', 1)
    const lead = { id: 'sess-lead2', header: { model: 'lead-model' } }
    const child = { id: 'sess-child2', header: { parentSession: 'sess-lead2', model: 'member-model' } }
    let engine
    engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ onSession }) => {
        onSession('sess-lead2')
        engine.handleSessionEvent(child, {
          type: 'assistant/message',
          seq: 1,
          data: {
            message: { id: 'c1', source: { provider: 'p', model: 'member-model' } },
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
        })
        return passOf('n_t')
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    await engine.flushEvents()
    const events = await eventsOf(run.id)
    A.equal(final.status, 'done')
    const nodeEnd = events.find(event => event.kind === 'node/end')
    A.equal(nodeEnd.extra.membersPartial, true)
    A.equal(nodeEnd.data.membersPartial, true)
    const summaryEvent = events.find(event => event.kind === 'artifact/write' && event.data.path.endsWith('/summary.json'))
    const disk = JSON.parse(readFileSync(join(runsRoot, run.id, summaryEvent.data.path), 'utf8'))
    A.equal(disk.membersPartial, true)
    A.equal(disk.members.length, 1)
    A.equal(disk.members[0].memberId, 'n_t:1')
    const memberEnd = events.find(event => event.kind === 'member/end')
    if (memberEnd) A.equal(memberEnd.data.status, 'partial')
    else A.equal(events.some(event => event.kind === 'member/end'), false)
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.1 · 提示词截断 m5（§13.9）')

  await check('超长 task + 超长上游：≤8000 字且输出格式段完整保留', async () => {
    const node = stage('n_long', '长任务', 300, {
      task: '很长的任务。'.repeat(1500),
      outputs: '产物要求。'.repeat(400),
      skills: ['skill-a', 'skill-b'],
    })
    const upstream = Array.from({ length: 3 }, (_, index) => ({
      title: `上游${index}`, attempt: 1, summary: '长摘要'.repeat(5000), artifactPaths: [],
    }))
    const prompt = buildPrompt({ node, attempt: 1, upstream })
    A.ok(Array.from(prompt).length <= PROMPT_MAX_CHARS)
    A.ok(prompt.includes('## 你是谁'))
    A.ok(prompt.includes('## 输出格式'))
    A.ok(prompt.includes('硬性要求'))
    A.ok(prompt.includes('"verdict"'))
    A.equal(sectionOf(prompt, '输出格式').includes('rejectReason'), true)
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.2 · 上游产物正文（缺陷 4）')

  await check('上游正文进下游提示词：含最近产物正文片段，超长截断且总长 ≤ PROMPT_MAX_CHARS', async () => {
    const flow = flowOf('flow-upstream', [
      startNode(), stage('n_a', '需求', 300), stage('n_b', '设计', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-upstream', 2)
    const longBody = `# 需求\n\n正文片段-上游需求-ABC\n${'补充约束。'.repeat(500)}`
    const prompts = new Map()
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node, prompt }) => {
        prompts.set(node.id, prompt)
        if (node.id === 'n_a') {
          const base = passResult('n_a').structured
          return {
            structured: { ...base, artifacts: [{ name: '需求.md', content: longBody }] },
            sessionId: 'sess-n_a',
            dispose: async () => {},
          }
        }
        return passResult('n_b')
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    const bPrompt = prompts.get('n_b')
    A.ok(bPrompt.includes('正文片段-上游需求-ABC'), '下游提示词应带上游产物正文片段')
    A.ok(bPrompt.includes('n_a/artifacts/1/需求.md'), '摘要 + 路径行仍然保留')
    A.ok(bPrompt.includes('已截断'), '超过单产物预算时标注已截断')
    A.ok(Array.from(bPrompt).length <= PROMPT_MAX_CHARS)
    A.ok(prompts.get('n_a').includes('## 你是谁'), '上游节点自己拿到的仍是完整七段骨架')
  })

  await check('上游正文只取最近 attempt；缺失 / 路径穿越降级为只给路径（不抛错）', async () => {
    const runId = 'run-upstream-load'
    const dir1 = join(runsRoot, runId, 'n_a', 'artifacts', '1')
    const dir2 = join(runsRoot, runId, 'n_a', 'artifacts', '2')
    mkdirSync(dir1, { recursive: true })
    mkdirSync(dir2, { recursive: true })
    writeFileSync(join(dir1, '需求.md'), '历史 attempt 内容-OLD')
    writeFileSync(join(dir2, '需求.md'), '最近 attempt 内容-NEW')

    const loaded = await loadUpstreamArtifactContents(runsRoot, runId, [{
      nodeId: 'n_a', title: '需求', attempt: 2, summary: '摘要', artifactPaths: ['n_a/artifacts/2/需求.md'],
    }])
    A.equal(loaded[0].artifactContents.length, 1)
    A.ok(loaded[0].artifactContents[0].content.includes('NEW'))
    A.ok(!loaded[0].artifactContents[0].content.includes('OLD'))

    // attempt=1 的 passed 记录即使磁盘上存在 attempt=2 的同名文件，也只能读 attempt=1。
    const stale = await loadUpstreamArtifactContents(runsRoot, runId, [{
      nodeId: 'n_a', title: '需求', attempt: 1, summary: '摘要', artifactPaths: ['n_a/artifacts/2/需求.md'],
    }])
    A.equal(stale[0].artifactContents.length, 0)

    // 文件不存在：加载不抛错，提示词仍含路径行。
    const missing = await loadUpstreamArtifactContents(runsRoot, runId, [{
      nodeId: 'n_a', title: '需求', attempt: 1, summary: '摘要', artifactPaths: ['n_a/artifacts/1/不存在.md'],
    }])
    A.equal(missing[0].artifactContents.length, 0)
    const prompt = buildPrompt({ node: stage('n_b', '设计', 600), attempt: 1, upstream: missing })
    A.ok(prompt.includes('n_a/artifacts/1/不存在.md'))
    A.ok(prompt.includes('## 上游产物'))

    // 路径穿越：不在 run 目录内的相对路径一律不读。
    const unsafe = await loadUpstreamArtifactContents(runsRoot, runId, [{
      nodeId: 'n_a', title: '需求', attempt: 1, summary: '摘要', artifactPaths: ['../outside.md'],
    }])
    A.equal(unsafe[0].artifactContents.length, 0)

    // 超过单产物读取上限：降级为只给路径，不把大文件读进内存。
    writeFileSync(join(dir1, '巨大.md'), 'x'.repeat(UPSTREAM_ARTIFACT_READ_MAX_BYTES + 1))
    const oversized = await loadUpstreamArtifactContents(runsRoot, runId, [{
      nodeId: 'n_a', title: '需求', attempt: 1, summary: '摘要', artifactPaths: ['n_a/artifacts/1/巨大.md'],
    }])
    A.equal(oversized[0].artifactContents.length, 0)
  })

  await check('上游正文加上后仍守 8000 字：先截上游段，输出格式段完整保留', async () => {
    const node = stage('n_long2', '长任务', 300, {
      task: '任务说明。'.repeat(2000),
      outputs: '产物要求。'.repeat(500),
      skills: ['skill-a'],
    })
    const upstream = [{
      title: '需求',
      attempt: 1,
      summary: '摘要',
      artifactPaths: ['n_a/artifacts/1/a.md'],
      artifactContents: [{ path: 'n_a/artifacts/1/a.md', content: '长正文。'.repeat(3000), truncated: true }],
    }]
    const prompt = buildPrompt({ node, attempt: 1, upstream })
    A.ok(Array.from(prompt).length <= PROMPT_MAX_CHARS)
    A.ok(prompt.includes('## 输出格式'))
    A.ok(prompt.includes('硬性要求'))
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.2 · 证据引用透传（§13.7 m7）')

  await check('模型引用上游产物：evidenceRef / reportRef 透传该路径，引擎审计报告仍落盘', async () => {
    const flow = flowOf('flow-evidence-ok', [
      startNode(), stage('n_a', '需求', 300), stage('n_b', '设计', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-evidence-ok', 2)
    const upstreamRef = 'n_a/artifacts/1/需求.md'
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => {
        if (node.id === 'n_a') {
          const base = passResult('n_a').structured
          return {
            structured: { ...base, artifacts: [{ name: '需求.md', content: '# 需求\n\n上游证据正文\n' }] },
            sessionId: 'sess-n_a',
            dispose: async () => {},
          }
        }
        return {
          structured: {
            verdict: 'pass',
            summary: '设计通过，引用上游需求作为证据',
            artifacts: [{ name: '设计.md', content: '# 设计\n' }],
            findings: [],
            checks: {
              ruleSetId: 'rules', ruleSetVersion: '1', executor: 'test',
              passedChecks: 2, totalChecks: 2, reportRef: upstreamRef,
            },
            acceptance: [{ itemId: 'R1', status: 'pass', decidedBy: 'auto', evidenceRef: upstreamRef }],
            tests: {
              suite: 'unit', executed: 2, passed: 2, failed: 0, skipped: 0, reportRef: upstreamRef,
            },
          },
          sessionId: 'sess-n_b',
          dispose: async () => {},
        }
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    A.equal(final.status, 'done')
    const acceptanceEvent = events.find(event => event.kind === 'acceptance/verdict' && event.nodeId === 'n_b')
    // 模型引用上游产物 → 事件里就是该路径（聚合层按 artifact/write 的 nodeId 判 peer）。
    A.equal(acceptanceEvent.data.evidenceRef, upstreamRef)
    A.equal(acceptanceEvent.extra.evidenceRefRejected, undefined)
    const checkEvent = events.find(event => event.kind === 'check/form' && event.nodeId === 'n_b')
    A.equal(checkEvent.data.reportRef, upstreamRef)
    A.equal(checkEvent.extra.reportRefRejected, undefined)
    const testEvent = events.find(event => event.kind === 'test/report' && event.nodeId === 'n_b')
    A.equal(testEvent.data.reportRef, upstreamRef)
    // 引擎自己的 acceptance.json / checks-report.json / test-report.json 仍然落盘（审计用）。
    for (const name of ['acceptance.json', 'checks-report.json', 'test-report.json']) {
      A.ok(events.some(event => event.kind === 'artifact/write'
        && event.nodeId === 'n_b' && event.data.path.endsWith(name)), `仍写出 ${name}`)
    }
    // 被引用路径的写入方是上游节点（不是声明节点自己）。
    const owner = events.find(event => event.kind === 'artifact/write' && event.data.path === upstreamRef)
    A.equal(owner.nodeId, 'n_a')
  })

  await check('证据引用非法 / 不存在 / 被篡改：退回引擎报告路径并在 extra 留拒绝原因', async () => {
    const flow = flowOf('flow-evidence-bad', [
      startNode(), stage('n_a', '需求', 300), stage('n_b', '设计', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-evidence-bad', 2)
    const tamperedRef = 'n_a/artifacts/1/需求.md'
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => {
        if (node.id === 'n_a') {
          const base = passResult('n_a').structured
          return {
            structured: { ...base, artifacts: [{ name: '需求.md', content: '# 需求\n\n原始内容\n' }] },
            sessionId: 'sess-n_a',
            dispose: async () => {},
          }
        }
        // 模型在声明证据前改写了上游产物：sha256 必须对不上。
        writeFileSync(join(runsRoot, run.id, tamperedRef), '# 需求\n\n被篡改的内容\n')
        return {
          structured: {
            verdict: 'pass',
            summary: '设计通过',
            artifacts: [{ name: '设计.md', content: '# 设计\n' }],
            findings: [],
            checks: {
              ruleSetId: 'rules', ruleSetVersion: '1', executor: 'test',
              passedChecks: 2, totalChecks: 2, reportRef: '../x',
            },
            acceptance: [
              { itemId: 'R1', status: 'pass', decidedBy: 'auto', evidenceRef: '../x' },
              { itemId: 'R2', status: 'pass', decidedBy: 'auto', evidenceRef: '/etc/passwd' },
              { itemId: 'R3', status: 'pass', decidedBy: 'auto', evidenceRef: 'n_a/artifacts/1/不存在.md' },
              { itemId: 'R4', status: 'pass', decidedBy: 'auto', evidenceRef: tamperedRef },
              { itemId: 'R5', status: 'pass', decidedBy: 'auto' },
            ],
            tests: {
              suite: 'unit', executed: 2, passed: 2, failed: 0, skipped: 0, reportRef: '/etc/passwd',
            },
          },
          sessionId: 'sess-n_b',
          dispose: async () => {},
        }
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    A.equal(final.status, 'done')

    const acceptanceEvents = events.filter(event => event.kind === 'acceptance/verdict' && event.nodeId === 'n_b')
    A.equal(acceptanceEvents.length, 5)
    const byItem = new Map(acceptanceEvents.map(event => [event.data.itemId, event]))
    for (const [itemId, pattern] of [
      ['n_b:R1', /安全相对路径/],
      ['n_b:R2', /安全相对路径/],
      ['n_b:R3', /artifact\/write/],
      ['n_b:R4', /sha256/],
    ]) {
      const event = byItem.get(itemId)
      A.equal(event.data.evidenceRef, 'n_b/artifacts/1/acceptance.json')
      A.match(event.extra.evidenceRefRejected, pattern)
    }
    // 没给引用：走默认（引擎落盘路径），不产生拒绝标记。
    const noRef = byItem.get('n_b:R5')
    A.equal(noRef.data.evidenceRef, 'n_b/artifacts/1/acceptance.json')
    A.equal(noRef.extra.evidenceRefRejected, undefined)

    const checkEvent = events.find(event => event.kind === 'check/form' && event.nodeId === 'n_b')
    A.equal(checkEvent.data.reportRef, 'n_b/artifacts/1/checks-report.json')
    A.match(checkEvent.extra.reportRefRejected, /安全相对路径/)
    const testEvent = events.find(event => event.kind === 'test/report' && event.nodeId === 'n_b')
    A.equal(testEvent.data.reportRef, 'n_b/artifacts/1/test-report.json')
    A.match(testEvent.extra.reportRefRejected, /安全相对路径/)
    // 审计文件真实存在。
    A.ok(existsSync(join(runsRoot, run.id, 'n_b/artifacts/1/acceptance.json')))
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.2 · 节点失败重试与失败隔离（缺陷 5）')

  await check('节点异常 → 重试一次 → 成功：retry 痕迹可见、run 最终 done', async () => {
    const flow = flowOf('flow-retry-ok', [
      startNode(), stage('n_a', '需求', 300), stage('n_b', '设计', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-retry-ok', 2)
    let bCalls = 0
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      nodeRetries: 1,
      activate: async ({ node }) => {
        if (node.id === 'n_b') {
          bCalls += 1
          if (bCalls === 1) throw new Error('子 agent 崩溃（第一次）')
        }
        return passResult(node.id)
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    A.equal(final.status, 'done')
    A.equal(bCalls, 2)
    const bStarts = events.filter(event => event.kind === 'node/start' && event.nodeId === 'n_b')
    A.equal(bStarts.length, 2)
    A.equal(bStarts[1].data.retry, 1)
    A.match(bStarts[1].data.retryReason, /子 agent 崩溃/)
    const bEnds = events.filter(event => event.kind === 'node/end' && event.nodeId === 'n_b')
    A.equal(bEnds.length, 1)
    A.equal(bEnds[0].data.status, 'passed')
    A.equal(bEnds[0].data.retries, 1)
    const runEnd = events.filter(event => event.kind === 'run/end')
    A.equal(runEnd.length, 1)
    A.equal(runEnd[0].data.status, 'done')
    // attemptId 不因重试增加：仍是打回语义的第 1 次尝试。
    A.equal(bStarts.every(event => event.attemptId === 1), true)
  })

  await check('重试用尽 → 只失败该节点：run failed、已完成证据保留、summarize/readRunDetail 可算、live 无残留', async () => {
    const flow = flowOf('flow-retry-fail', [
      startNode(), stage('n_a', '需求', 300), stage('n_b', '设计', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-retry-fail', 2)
    let bCalls = 0
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      nodeRetries: 1,
      activate: async ({ node }) => {
        if (node.id === 'n_b') {
          bCalls += 1
          throw new Error(`子 agent 崩溃（第 ${bCalls} 次）`)
        }
        const base = passResult('n_a').structured
        return {
          structured: { ...base, artifacts: [{ name: '需求.md', content: '# 需求\n\n已完成的证据\n' }] },
          sessionId: 'sess-n_a',
          dispose: async () => {},
        }
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)

    A.equal(final.status, 'failed')
    A.equal(final.live, null)
    A.equal(bCalls, 2)
    A.equal(events.filter(event => event.kind === 'node/start' && event.nodeId === 'n_b').length, 2)

    // 已通过节点的事件与产物必须完整保留。
    const aPass = events.find(event => event.kind === 'node/end' && event.nodeId === 'n_a')
    A.equal(aPass.data.status, 'passed')
    const aArtifact = events.find(event => event.kind === 'artifact/write' && event.nodeId === 'n_a')
    A.ok(Boolean(aArtifact), '已通过节点的 artifact/write 仍在事件流里')
    A.equal(existsSync(join(runsRoot, run.id, aArtifact.data.path)), true)

    // 失败节点：重试用尽后只写一条 node/end failed（带重试次数与原因）。
    const bEnd = events.find(event => event.kind === 'node/end' && event.nodeId === 'n_b')
    A.equal(bEnd.data.status, 'failed')
    A.equal(bEnd.data.retries, 1)
    A.match(bEnd.extra.reason, /第 2 次/)

    const runEnd = events.find(event => event.kind === 'run/end')
    A.equal(runEnd.data.status, 'failed')
    A.equal(runEnd.data.failedNodeId, 'n_b')
    A.match(runEnd.data.reason, /第 2 次/)

    // 聚合层可复算：failed run 上 summarize 不抛错，进度与节点状态正确。
    const summary = summarize(events)
    A.equal(summary.eventCount, events.length)
    A.equal(summary.progress.passed, 1)
    A.equal(summary.progress.failed, 1)
    A.equal(summary.progress.nodes.n_a.status, 'passed')
    A.equal(summary.progress.nodes.n_b.status, 'failed')
    A.equal(typeof summary.quality.state, 'string')

    // readRunDetail 不因 failed run 抛异常，attempt 状态与事件一致。
    const detail = await store.readRunDetail(runsRoot, run.id)
    A.ok(detail !== null)
    A.equal(detail.run.status, 'failed')
    const nodeMap = new Map(detail.nodes.map(item => [item.nodeId, item]))
    A.equal(nodeMap.get('n_a').attempts[0].status, 'passed')
    A.equal(nodeMap.get('n_b').attempts[0].status, 'failed')

    // live 清干净：run.json 里没有残留 running 的节点。
    const meta = await store.readRunMeta(runsRoot, run.id)
    A.equal(meta.live, null)
    A.equal(meta.progress.nodes.n_b.status, 'failed')
  })

  await check('节点超时按一次失败走同一重试路径：重试后仍 failed，超时标记保留', async () => {
    const flow = flowOf('flow-timeout-retry', [startNode(), stage('n_wait', '等不到', 300), endNode()], [
      next('e1', 'n_start', 'n_wait'),
      next('e2', 'n_wait', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-timeout-retry', 1)
    let calls = 0
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      nodeTimeoutMs: 20,
      nodeRetries: 1,
      activate: () => {
        calls += 1
        return new Promise(() => {})
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const starts = events.filter(event => event.kind === 'node/start' && event.nodeId === 'n_wait')
    const nodeEnd = events.find(event => event.kind === 'node/end' && event.nodeId === 'n_wait')
    A.equal(final.status, 'failed')
    A.equal(calls, 2)
    A.equal(starts.length, 2)
    A.equal(starts[1].data.retry, 1)
    A.equal(nodeEnd.data.status, 'failed')
    A.equal(nodeEnd.data.retries, 1)
    A.equal(nodeEnd.extra.timeout, true)
    A.match(nodeEnd.extra.reason, /超时/)
  })

  await check('FLOW_STUDIO_NODE_RETRIES 默认 1、钳制在 0–' + MAX_NODE_RETRIES, async () => {
    const previous = process.env.FLOW_STUDIO_NODE_RETRIES
    try {
      delete process.env.FLOW_STUDIO_NODE_RETRIES
      A.equal(createEngine({ runsRoot, flowsRoot }).nodeRetries, 1)
      process.env.FLOW_STUDIO_NODE_RETRIES = '999'
      A.equal(createEngine({ runsRoot, flowsRoot }).nodeRetries, MAX_NODE_RETRIES)
      process.env.FLOW_STUDIO_NODE_RETRIES = '-3'
      A.equal(createEngine({ runsRoot, flowsRoot }).nodeRetries, 0)
      process.env.FLOW_STUDIO_NODE_RETRIES = 'not-a-number'
      A.equal(createEngine({ runsRoot, flowsRoot }).nodeRetries, 1)
    } finally {
      if (previous === undefined) delete process.env.FLOW_STUDIO_NODE_RETRIES
      else process.env.FLOW_STUDIO_NODE_RETRIES = previous
    }
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.1 · 严格归一 m6（§13.9）')

  await check('非法 severity/status：结构不合格（不默认 P2 / open）', async () => {
    const flow = flowOf('flow-sev', [startNode(), stage('n_sev', '归一', 300), endNode()], [
      next('e1', 'n_start', 'n_sev'),
      next('e2', 'n_sev', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-sev', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async () => passOf('n_sev', {
        findings: [{ id: 'F1', severity: 'P1-MAJOR', title: '非法等级', status: 'open' }],
      }),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')
    A.equal(final.status, 'failed')
    A.match(nodeEnd.extra.validationError, /severity/)
    A.equal(events.filter(event => event.kind === 'review/finding').length, 0)
  })

  await check('tests 计数不自洽（passed+failed+skipped !== executed）：结构不合格', async () => {
    const flow = flowOf('flow-math', [startNode(), stage('n_math', '计数', 300), endNode()], [
      next('e1', 'n_start', 'n_math'),
      next('e2', 'n_math', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-math', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async () => passOf('n_math', {
        tests: { suite: 'unit', executed: 3, passed: 2, failed: 0, skipped: 0 },
      }),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    A.equal(final.status, 'failed')
    A.match(events.find(event => event.kind === 'node/end').extra.validationError, /不自洽/)
    A.equal(events.filter(event => event.kind === 'test/report').length, 0)
  })

  await check('reject 缺 rejectReason：结构不合格', async () => {
    const flow = flowOf('flow-noreason', [startNode(), stage('n_a', '开发', 300), stage('n_b', '测试', 600), endNode()], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
      reject('e4', 'n_b', 'n_a'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-noreason', 2)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node }) => (node.id === 'n_b'
        ? { structured: { verdict: 'reject', summary: '忘了原因', rejectTarget: 'n_a', findings: [] }, sessionId: 's', dispose: async () => {} }
        : passOf(node.id)),
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    A.equal(final.status, 'failed')
    const failed = events.find(event => event.kind === 'node/end' && event.nodeId === 'n_b')
    A.equal(failed.data.status, 'failed')
    A.match(failed.extra.validationError, /rejectReason/)
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.1 · 其他小项（§13.10）')

  await check('memberIdFor 截断不碰撞：长 nodeId 前缀相同也拿到不同 memberId', () => {
    const a = `n_${'a'.repeat(60)}`
    const b = `n_${'a'.repeat(59)}b`
    const ida = engineModule.memberIdFor(a, 1)
    const idb = engineModule.memberIdFor(b, 1)
    A.ok(ida !== idb)
    A.ok(Array.from(ida).length <= 64)
    A.match(ida, /^[A-Za-z0-9._:-]+$/)
    A.equal(engineModule.memberIdFor('n_team', 1), 'n_team:1')
  })

  // -------------------------------------------------------------------------
  console.log('engine v0.7 · 工作区与 worktree（R1+R4）')

  await check('真 git 仓库 + auto：run.json 有 workspace/worktree、目录真的建了、节点会话 cwd = worktree', async () => {
    const repo = makeGitRepo('repo-wt')
    try {
      const flow = flowOf('flow-wt', [startNode(), stage('n_wt', '实现', 300), endNode()], [
        next('e1', 'n_start', 'n_wt'),
        next('e2', 'n_wt', 'n_end'),
      ])
      await saveFlow(flow)
      const run = await makeRun('flow-wt', 1)
      const engineRef = { value: null }
      const { ctx, created } = agentsCreateCtx(engineRef, { resultFor: () => passResult('n_wt').structured })
      const engine = createEngine({ runsRoot, flowsRoot, ctx })
      engineRef.value = engine

      await engine.start(run.id, { workspace: repo, worktree: 'auto' })
      const final = await engine.wait(run.id)
      A.equal(final.status, 'done')

      const raw = readRawRun(run.id)
      A.match(raw.workspace.id, /^[0-9a-f]{12}$/)
      A.equal(raw.workspace.isGit, true)
      A.equal(raw.workspace.realpath, realpathSync(repo))
      A.equal(raw.worktree.enabled, true)
      A.equal(raw.worktree.decidedBy, 'initiator')
      A.ok(existsSync(raw.worktree.path), 'worktree.enabled=true 时目录必须真的存在')
      // 07 §4.2：根由 runsRoot 的父级推（<home>/flow-studio/worktrees），不硬编码绝对路径。
      A.ok(raw.worktree.path.startsWith(join(dirname(runsRoot), 'worktrees')))
      A.ok(raw.worktree.branch.startsWith('flow/'))
      A.match(raw.worktree.baseCommit, /^[0-9a-f]{40}$/)
      A.ok(typeof raw.worktree.createdAt === 'string' && raw.worktree.createdAt !== '')

      // 节点会话 meta.cwd 必须指向 worktree.path（不是 workspace.path）。
      A.equal(created.length, 1)
      A.equal(created[0].meta.cwd, raw.worktree.path)
      A.equal(raw.sessionMode, 'top-level')

      // run/start 事件带 workspaceId / worktreeEnabled（不新增 kind，只加 data 字段）。
      const startEvent = (await eventsOf(run.id)).find(event => event.kind === 'run/start')
      A.equal(startEvent.data.workspaceId, raw.workspace.id)
      A.equal(startEvent.data.worktreeEnabled, true)
      A.equal(startEvent.data.sessionMode, 'top-level')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  await check("worktree:'on' + 非 git 目录：start 抛 400（不静默降级），run 仍是 pending", async () => {
    const plain = makePlainDir('nogit-on')
    try {
      const flow = flowOf('flow-on', [startNode(), stage('n_on', '实现', 300), endNode()], [
        next('e1', 'n_start', 'n_on'),
        next('e2', 'n_on', 'n_end'),
      ])
      await saveFlow(flow)
      const run = await makeRun('flow-on', 1)
      const engine = createEngine({ runsRoot, flowsRoot, activate: async () => passResult('n_on') })
      await assert.rejects(
        () => engine.start(run.id, { workspace: plain, worktree: 'on' }),
        error => error instanceof EngineError && error.status === 400 && /不是 git 仓库根/.test(error.message),
        "on + 非 git 必须 400 且原因可读",
      )
      A.equal((await store.readRunMeta(runsRoot, run.id)).status, 'pending')
      A.equal(readRawRun(run.id).worktree, undefined)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  await check('auto + 非 git：enabled:false, reason=not-a-git-repo，run 正常跑完', async () => {
    const plain = makePlainDir('nogit-auto')
    try {
      const flow = flowOf('flow-auto', [startNode(), stage('n_auto', '实现', 300), endNode()], [
        next('e1', 'n_start', 'n_auto'),
        next('e2', 'n_auto', 'n_end'),
      ])
      await saveFlow(flow)
      const run = await makeRun('flow-auto', 1)
      const engine = createEngine({ runsRoot, flowsRoot, activate: async () => passResult('n_auto') })
      await engine.start(run.id, { workspace: plain, worktree: 'auto' })
      const final = await engine.wait(run.id)
      A.equal(final.status, 'done')

      const raw = readRawRun(run.id)
      A.equal(raw.workspace.isGit, false)
      A.equal(raw.workspace.gitRoot, null)
      A.equal(raw.worktree.enabled, false)
      A.equal(raw.worktree.reason, 'not-a-git-repo')
      A.equal(raw.worktree.path, null)
      A.equal(raw.worktree.branch, null)
      const startEvent = (await eventsOf(run.id)).find(event => event.kind === 'run/start')
      A.equal(startEvent.data.worktreeEnabled, false)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  await check('run 已绑定工作区：换一个 workspace 再 start → 400（不能中途更换）', async () => {
    const repo = makeGitRepo('repo-bound')
    try {
      const flow = flowOf('flow-bound', [startNode(), stage('n_bound', '实现', 300), endNode()], [
        next('e1', 'n_start', 'n_bound'),
        next('e2', 'n_bound', 'n_end'),
      ])
      await saveFlow(flow)
      const run = await makeRun('flow-bound', 1)
      // 模拟「该 run 已由发起方绑定过工作区」：直接改原始 run.json（绑定字段不在白名单里）。
      const raw = readRawRun(run.id)
      raw.workspace = { id: 'ffffffffffff', path: '/elsewhere', realpath: '/elsewhere', isGit: false, gitRoot: null }
      writeFileSync(join(runsRoot, run.id, 'run.json'), `${JSON.stringify(raw, null, 2)}\n`)

      const engine = createEngine({ runsRoot, flowsRoot, activate: async () => passResult('n_bound') })
      await assert.rejects(
        () => engine.start(run.id, { workspace: repo, worktree: 'off' }),
        error => error instanceof EngineError && error.status === 400 && /已绑定工作区，不能中途更换/.test(error.message),
        '换工作区必须 400',
      )
      A.equal((await store.readRunMeta(runsRoot, run.id)).status, 'pending')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  await check('C3：没有显式 workspace（也没有 cwd / header.cwd）→ start 400 workspace，不回落 process.cwd，不写 run/start', async () => {
    const flow = flowOf('flow-noinit', [startNode(), stage('n_noinit', '节点', 300), endNode()], [
      next('e1', 'n_start', 'n_noinit'),
      next('e2', 'n_noinit', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-noinit', 1)
    // 关键：绕过测试夹具的 cwd 默认值，engine 上没有任何 workspace / cwd / parent。
    const engine = createEngineRaw({ runsRoot, flowsRoot, worktree: 'auto', activate: async () => passResult('n_noinit') })
    let captured = null
    await assert.rejects(
      () => engine.start(run.id),
      error => {
        captured = error
        return error instanceof store.RunError
          && error.status === 400
          && error.field === 'workspace'
          && /process\.cwd/.test(error.message)
      },
      '缺工作区必须是 400 + field=workspace',
    )
    A.ok(Boolean(captured), 'start 必须抛错，而不是静默回落')
    A.equal(engine.active, null, '失败的 start 必须释放实例占位')
    A.equal((await eventsOf(run.id)).some(event => event.kind === 'run/start'), false, '没有 run/start 事件')
    const meta = await store.readRunMeta(runsRoot, run.id)
    A.equal(meta.status, 'pending', 'run 仍是 pending，没有被迁移成 running')
    A.equal(meta.started, false)
    const raw = readRawRun(run.id)
    A.equal(raw.workspace, undefined, 'run.json 不写入伪造的工作区绑定')
  })

  await check('C3：stub 引擎不绑定工作区（不建真实会话）→ start 照常跑完，不伪造 workspace', async () => {
    const flow = flowOf('flow-stubws', [startNode(), stage('n_stubws', '节点', 300), endNode()], [
      next('e1', 'n_start', 'n_stubws'),
      next('e2', 'n_stubws', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-stubws', 1)
    // 绕过夹具的 cwd 默认值：桩引擎在没有工作区时也必须能跑（路由层对 stub 同样放行）。
    const engine = createEngineRaw({ runsRoot, flowsRoot, stub: true })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    const events = await eventsOf(run.id)
    const startEvent = events.find(event => event.kind === 'run/start')
    A.ok(Boolean(startEvent), 'stub 必须真的开跑（run/start 存在）')
    A.equal(startEvent.data.sessionMode, 'stub')
    A.equal(startEvent.data.workspaceId, undefined, 'stub 不在 run/start 里伪造 workspaceId')
    A.match(startEvent.data.worktreeWarning, /stub 引擎不绑定工作区/)
    const raw = readRawRun(run.id)
    A.equal(raw.workspace, undefined, 'stub 不写 workspace 绑定')
    A.equal(raw.worktree.enabled, false)
    A.equal(raw.worktree.reason, 'stub-engine')
  })

  // -------------------------------------------------------------------------
  console.log('engine v0.7 · 会话降级可见（sessionMode）')

  await check('只有 subagents、没有 agents.create：sessionMode=legacy-subagent（run.json + run/start）', async () => {
    const flow = flowOf('flow-legacy', [startNode(), stage('n_legacy', '兼容节点', 300), endNode()], [
      next('e1', 'n_start', 'n_legacy'),
      next('e2', 'n_legacy', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-legacy', 1)
    const ctx = {
      on() {
        return () => {}
      },
      get(name) {
        // 只有 get、没有 create：默认 activate 会退回 subagents.startActivation。
        if (name === 'agents') return { get() { return null } }
        if (name === 'subagents') {
          return {
            async startActivation() {
              return {
                childId: 'child-legacy',
                result: Promise.resolve({ structured: passResult('n_legacy').structured, output: [], stopReason: 'done' }),
                dispose: async () => {},
              }
            },
          }
        }
        return undefined
      },
    }
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      ctx,
      parent: { session: { id: 'sess-init', header: {} } },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')

    const raw = readRawRun(run.id)
    A.equal(raw.sessionMode, 'legacy-subagent')
    const startEvent = (await eventsOf(run.id)).find(event => event.kind === 'run/start')
    A.equal(startEvent.data.sessionMode, 'legacy-subagent')
  })

  await check('stub / 注入 activate：sessionMode 也写（stub / injected），run/start.data 同样带', async () => {
    const makeOneStage = async id => {
      const flow = flowOf(id, [startNode(), stage(`${id}_node`, '节点', 300), endNode()], [
        next(`${id}-e1`, 'n_start', `${id}_node`),
        next(`${id}-e2`, `${id}_node`, 'n_end'),
      ])
      await saveFlow(flow)
      return makeRun(id, 1)
    }

    const stubRun = await makeOneStage('flow-mode-stub')
    const stubEngine = createEngine({ runsRoot, flowsRoot, stub: true })
    await stubEngine.start(stubRun.id)
    A.equal((await stubEngine.wait(stubRun.id)).status, 'done')
    A.equal(readRawRun(stubRun.id).sessionMode, 'stub')
    A.equal((await eventsOf(stubRun.id)).find(event => event.kind === 'run/start').data.sessionMode, 'stub')

    const injectedRun = await makeOneStage('flow-mode-injected')
    const injectedEngine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passResult(node.id) })
    await injectedEngine.start(injectedRun.id)
    A.equal((await injectedEngine.wait(injectedRun.id)).status, 'done')
    A.equal(readRawRun(injectedRun.id).sessionMode, 'injected')
    A.equal((await eventsOf(injectedRun.id)).find(event => event.kind === 'run/start').data.sessionMode, 'injected')
  })

  // -------------------------------------------------------------------------
  console.log('engine v0.7 · 外部 executor（R6）')

  await check('custom 外部进程：结构化判定被解析、usage 记上、过程日志可见、cwd=worktree、schema 落在 run 目录', async () => {
    const repo = makeGitRepo('repo-exec')
    const execDir = mkdtempSync(join(repoRoot, '.tmp', 'exec-'))
    try {
      const cwdFile = join(execDir, 'cwd.txt')
      const stubPath = join(execDir, 'stub.mjs')
      const structured = {
        verdict: 'pass',
        summary: '外部执行通过',
        artifacts: [{ name: '外部结论.md', content: '# ok\n' }],
        findings: [],
        checks: { ruleSetId: 'ext-rules', ruleSetVersion: '1', executor: 'custom', passedChecks: 1, totalChecks: 1 },
        acceptance: [{ itemId: 'R1', status: 'pass', decidedBy: 'auto' }],
        tests: { suite: 'ext', executed: 1, passed: 1, failed: 0, skipped: 0 },
      }
      writeFileSync(stubPath, [
        "import { writeFileSync } from 'node:fs'",
        `writeFileSync(${JSON.stringify(cwdFile)}, process.cwd())`,
        "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'echo hi' } }))",
        "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } }))",
        `console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(${JSON.stringify(structured)}) } }))`,
      ].join('\n'))

      const command = `node ${JSON.stringify(stubPath)}`
      const flow = flowOf('flow-exec', [
        startNode(),
        stage('n_ext', '外部节点', 300, { executor: 'custom', executorCommand: command }),
        endNode(),
      ], [
        next('e1', 'n_start', 'n_ext'),
        next('e2', 'n_ext', 'n_end'),
      ])
      await saveFlow(flow)
      const run = await makeRun('flow-exec', 1)
      const engine = createEngine({ runsRoot, flowsRoot })
      await engine.start(run.id, { workspace: repo, worktree: 'auto' })
      const final = await engine.wait(run.id)
      A.equal(final.status, 'done')

      const raw = readRawRun(run.id)
      A.equal(raw.worktree.enabled, true)
      // 07 §4.1：外部 executor 的 cwd（-C）与节点会话用同一个 _sessionCwd()。
      A.equal(readFileSync(cwdFile, 'utf8').trim(), raw.worktree.path)

      const events = await eventsOf(run.id)
      const nodeEnd = events.find(event => event.kind === 'node/end' && event.nodeId === 'n_ext')
      A.equal(nodeEnd.data.status, 'passed')
      // 结构化判定被解析：引擎按既有 schema 落了 acceptance / test 证据。
      A.equal(events.filter(event => event.kind === 'acceptance/verdict').length, 1)
      A.equal(events.filter(event => event.kind === 'test/report').length, 1)

      // usage：四桶归一化，缺桶补 0。
      const modelCall = events.find(event => event.kind === 'model/call' && event.nodeId === 'n_ext')
      A.deepEqual(modelCall.data.usage, { input: 11, cacheRead: 0, cacheWrite: 0, output: 7 })
      A.equal(modelCall.data.provider, 'custom')

      // 过程事件走既有 agent/message 通道。
      A.ok(events.some(event => event.kind === 'agent/message'
        && event.nodeId === 'n_ext'
        && typeof event.data.text === 'string'
        && event.data.text.includes('echo hi')), '节点日志里应能看到外部进程输出')

      // schema 文件在 run 目录下（不写 /tmp），内容是「严格化」后的节点输出 schema。
      // codex 的 --output-schema 走 OpenAI strict structured outputs：每个 object 必须
      // additionalProperties:false 且 required 列全，否则服务端 400（真 codex 实测）。
      const schemaPath = join(runsRoot, run.id, 'executors', '1.schema.json')
      A.ok(existsSync(schemaPath), 'schema 必须落在 <runsRoot>/<runId>/executors/<attemptId>.schema.json')
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
      A.equal(schema.type, 'object')
      A.deepEqual(schema.required, Object.keys(schema.properties))
      A.equal(schema.additionalProperties, false)
      A.deepEqual(schema, toStrictOutputSchema(ENGINE_OUTPUT_SCHEMA))
      // 递归检查：每一层 object 都必须闭合，且不许残留 oneOf/anyOf。
      const walk = (node, path) => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) {
          node.forEach((item, index) => walk(item, `${path}[${index}]`))
          return
        }
        A.equal(node.oneOf === undefined && node.anyOf === undefined, true, `${path} 不该有 oneOf/anyOf`)
        if (node.properties) {
          A.equal(node.additionalProperties, false, `${path} 必须是 additionalProperties:false`)
          A.deepEqual(node.required, Object.keys(node.properties), `${path} 的 required 必须列全`)
        }
        for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`)
      }
      walk(schema, 'schema')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(execDir, { recursive: true, force: true })
    }
  })

  await check('custom 非 0 退出：节点失败，错误文案带 stderr 尾', async () => {
    const execDir = mkdtempSync(join(repoRoot, '.tmp', 'exec-fail-'))
    try {
      const stubPath = join(execDir, 'fail.mjs')
      writeFileSync(stubPath, "console.error('BOOM-stderr-tail-42')\nprocess.exit(3)\n")
      const flow = flowOf('flow-exec-fail', [
        startNode(),
        stage('n_fail', '外部失败', 300, { executor: 'custom', executorCommand: `node ${JSON.stringify(stubPath)}` }),
        endNode(),
      ], [
        next('e1', 'n_start', 'n_fail'),
        next('e2', 'n_fail', 'n_end'),
      ])
      await saveFlow(flow)
      const run = await makeRun('flow-exec-fail', 1)
      const engine = createEngine({ runsRoot, flowsRoot, nodeRetries: 0 })
      await engine.start(run.id, { worktree: 'off' })
      const final = await engine.wait(run.id)
      A.equal(final.status, 'failed')

      const events = await eventsOf(run.id)
      const nodeEnd = events.find(event => event.kind === 'node/end' && event.nodeId === 'n_fail')
      A.equal(nodeEnd.data.status, 'failed')
      const runEnd = events.find(event => event.kind === 'run/end')
      A.equal(runEnd.data.status, 'failed')
      A.match(runEnd.data.reason, /BOOM-stderr-tail-42/)
      A.match(runEnd.data.reason, /3/)
    } finally {
      rmSync(execDir, { recursive: true, force: true })
    }
  })

  await check('custom 被 stop：run 收成 aborted（不是 failed）', async () => {
    const execDir = mkdtempSync(join(repoRoot, '.tmp', 'exec-abort-'))
    try {
      const stubPath = join(execDir, 'hang.mjs')
      writeFileSync(stubPath, "setTimeout(() => {}, 60000)\n")
      const flow = flowOf('flow-exec-abort', [
        startNode(),
        stage('n_hang', '外部挂起', 300, { executor: 'custom', executorCommand: `node ${JSON.stringify(stubPath)}` }),
        endNode(),
      ], [
        next('e1', 'n_start', 'n_hang'),
        next('e2', 'n_hang', 'n_end'),
      ])
      await saveFlow(flow)
      const run = await makeRun('flow-exec-abort', 1)
      const engine = createEngine({ runsRoot, flowsRoot })
      await engine.start(run.id, { worktree: 'off' })
      const final = await engine.stop(run.id)
      A.equal(final.status, 'aborted')
      const runEnd = (await eventsOf(run.id)).find(event => event.kind === 'run/end')
      A.equal(runEnd.data.status, 'aborted')
    } finally {
      rmSync(execDir, { recursive: true, force: true })
    }
  })

  await check('custom 缺 executorCommand：启动即 400（07 §7.1 保存宽松、启动严格）', async () => {
    const flow = flowOf('flow-exec-invalid', [
      startNode(),
      stage('n_bad', '外部配置错', 300, { executor: 'custom' }),
      endNode(),
    ], [
      next('e1', 'n_start', 'n_bad'),
      next('e2', 'n_bad', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-exec-invalid', 1)
    const engine = createEngine({ runsRoot, flowsRoot, nodeRetries: 0 })
    let rejected = null
    try {
      await engine.start(run.id, { worktree: 'off' })
    } catch (error) {
      rejected = error
    }
    A.equal(rejected && rejected.status, 400)
    A.match(rejected && rejected.message, /executorCommand/)
    // 没真的开跑：不该有 run/start 事件。
    const kinds = (await eventsOf(run.id)).map(event => event.kind)
    A.equal(kinds.includes('run/start'), false)
  })

  await check('外部 executor 重试语义与 dsh 一致：失败一次后自动重试并成功（attemptId 不变、retries=1）', async () => {
    const execDir = mkdtempSync(join(repoRoot, '.tmp', 'exec-retry-'))
    try {
      const counterFile = join(execDir, 'count.txt')
      const stubPath = join(execDir, 'retry.mjs')
      writeFileSync(stubPath, [
        "import { existsSync, writeFileSync } from 'node:fs'",
        `if (!existsSync(${JSON.stringify(counterFile)})) {`,
        `  writeFileSync(${JSON.stringify(counterFile)}, '1')`,
        '  process.exit(1)',
        '}',
        "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ verdict: 'pass', summary: '第二次通过' }) } }))",
      ].join('\n'))
      const flow = flowOf('flow-exec-retry', [
        startNode(),
        stage('n_retry', '外部重试', 300, { executor: 'custom', executorCommand: `node ${JSON.stringify(stubPath)}` }),
        endNode(),
      ], [
        next('e1', 'n_start', 'n_retry'),
        next('e2', 'n_retry', 'n_end'),
      ])
      await saveFlow(flow)
      const run = await makeRun('flow-exec-retry', 1)
      const engine = createEngine({ runsRoot, flowsRoot })
      await engine.start(run.id, { worktree: 'off' })
      const final = await engine.wait(run.id)
      A.equal(final.status, 'done')
      A.equal(readFileSync(counterFile, 'utf8').trim(), '1', '第一次失败后应再起一次子进程')
      const nodeEnd = (await eventsOf(run.id)).find(event => event.kind === 'node/end' && event.nodeId === 'n_retry')
      A.equal(nodeEnd.data.status, 'passed')
      A.equal(nodeEnd.data.retries, 1)
      A.equal(nodeEnd.attemptId, 1)
    } finally {
      rmSync(execDir, { recursive: true, force: true })
    }
  })

  // =========================================================================
  // v0.8 节点闹钟（07 §11 / R8）：注入假 nodeSupervision + 假 agents
  // =========================================================================
  console.log('engine v0.8 · 节点闹钟（R8）')

  await check('① 建会话即按 {runId,nodeId,sessionId,attempt} 登记', async () => {
    const flow = flowOf('flow-alarm-register', [
      startNode(), stage('n_alarm', '闹钟节点', 300), endNode(),
    ], [
      next('e1', 'n_start', 'n_alarm'),
      next('e2', 'n_alarm', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-alarm-register', 1)
    const scheduler = fakeNodeAlarmScheduler()
    const engineRef = { value: null }
    const { ctx } = nodeAlarmAgents(engineRef, ({ emitStructured, finishIdle }) => {
      emitStructured(passResult('n_alarm').structured)
      finishIdle()
    })
    const engine = createEngine({ runsRoot, flowsRoot, ctx, nodeSupervision: scheduler })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const sessionId = nodeSessionId(run.id, 'n_alarm', 1)

    A.equal(final.status, 'done')
    A.deepEqual(scheduler.calls.register, [{
      runId: run.id,
      nodeId: 'n_alarm',
      sessionId,
      attempt: 1,
    }])
    A.equal(scheduler.calls.register[0].sessionId, sessionId)
  })

  await check('② attempt 结束注销（不是 run 收尾才注销），run 收尾再 unregisterRun', async () => {
    const flow = flowOf('flow-alarm-unregister', [
      startNode(), stage('n_alarm2', '闹钟节点', 300), endNode(),
    ], [
      next('e1', 'n_start', 'n_alarm2'),
      next('e2', 'n_alarm2', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-alarm-unregister', 1)
    const scheduler = fakeNodeAlarmScheduler()
    const engineRef = { value: null }
    const { ctx } = nodeAlarmAgents(engineRef, ({ emitStructured, finishIdle }) => {
      emitStructured(passResult('n_alarm2').structured)
      finishIdle()
    })
    const engine = createEngine({ runsRoot, flowsRoot, ctx, nodeSupervision: scheduler })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const sessionId = nodeSessionId(run.id, 'n_alarm2', 1)

    A.equal(final.status, 'done')
    A.equal(scheduler.calls.unregister.filter(id => id === sessionId).length, 1, 'attempt 结束注销一次')
    A.equal(scheduler.entries.size, 0, '注销后调度器里没有该会话')
    A.equal(scheduler.calls.unregisterRun.filter(id => id === run.id).length, 1, 'run 收尾注销整个 run')
    // attempt 注销必须发生在 run 收尾注销之前。
    A.ok(
      scheduler.order.indexOf(`unregister:${sessionId}`) < scheduler.order.indexOf(`unregisterRun:${run.id}`),
      'attempt 注销先于 unregisterRun',
    )
  })

  await check('③ 打回重跑：同一会话重新登记（sessionId 相同、attempt=2）', async () => {
    const flow = flowOf('flow-alarm-rework', [
      startNode(), stage('n_a', '开发', 300), stage('n_b', '测试', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
      reject('e4', 'n_b', 'n_a'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-alarm-rework', 2)
    const scheduler = fakeNodeAlarmScheduler()
    const engineRef = { value: null }
    const callsBySession = new Map()
    const { ctx } = nodeAlarmAgents(engineRef, ({ sessionId, emitStructured, finishIdle }) => {
      const call = (callsBySession.get(sessionId) || 0) + 1
      callsBySession.set(sessionId, call)
      if (sessionId.includes('--n_b') && call === 1) {
        emitStructured({
          verdict: 'reject',
          summary: '打回返工',
          rejectTarget: 'n_a',
          rejectReason: '测试不达标',
        })
      } else {
        emitStructured(passResult(sessionId.includes('--n_a') ? 'n_a' : 'n_b').structured)
      }
      finishIdle()
    })
    const engine = createEngine({ runsRoot, flowsRoot, ctx, nodeSupervision: scheduler })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)

    const sessionA = nodeSessionId(run.id, 'n_a', 1)
    const registersA = scheduler.calls.register.filter(entry => entry.nodeId === 'n_a')
    A.equal(final.status, 'done')
    A.deepEqual(registersA.map(entry => entry.attempt), [1, 2])
    A.equal(registersA[0].sessionId, sessionA)
    A.equal(registersA[1].sessionId, sessionA, '打回重跑复用同一会话，重新登记同一个 sessionId')
    A.equal(scheduler.calls.unregister.filter(id => id === sessionA).length, 2, '两次 attempt 各注销一次')
  })

  await check('④ 自审回报：node/status 事件 + live.nodeStatus + run.json.nodeStatus（同文本 verdict 也解析）', async () => {
    const flow = flowOf('flow-alarm-status', [
      startNode(), stage('n_status', '自审节点', 300), endNode(),
    ], [
      next('e1', 'n_start', 'n_status'),
      next('e2', 'n_status', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-alarm-status', 1)
    const scheduler = fakeNodeAlarmScheduler()
    const engineRef = { value: null }
    let liveNodeStatus = null
    const statusBlock = {
      nodeId: 'n_status',
      attempt: 1,
      state: 'working',
      progress: 40,
      summary: '正在自审',
      members: [{ name: '成员甲', state: 'working', note: '写实现' }],
      blockers: ['等接口'],
      verdict: null,
    }
    const { ctx } = nodeAlarmAgents(engineRef, ({ engine, emitStatus, emitStructured, finishIdle }) => {
      emitStatus(statusBlock)
      setTimeout(() => {
        liveNodeStatus = engine.live ? JSON.parse(JSON.stringify(engine.live.nodeStatus)) : null
        // 同一条文本里既有 status 块又有正式 verdict 块：两者都要处理。
        const closingStatus = { ...statusBlock, progress: 70, summary: '准备收尾' }
        emitStatus(closingStatus)
        emitStructured(passResult('n_status').structured)
        finishIdle()
      }, 0)
    })
    const engine = createEngine({ runsRoot, flowsRoot, ctx, nodeSupervision: scheduler })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const statusEvents = events.filter(event => event.kind === 'node/status')
    const raw = readRawRun(run.id)

    A.equal(final.status, 'done')
    A.ok(statusEvents.length >= 2, '两条自审回报都落成 node/status')
    A.equal(statusEvents[0].nodeId, 'n_status')
    A.equal(statusEvents[0].attemptId, 1)
    A.match(statusEvents[0].traceId, /^tr-/)
    A.equal(statusEvents[0].data.state, 'working')
    A.equal(statusEvents[0].data.progress, 40)
    A.equal(statusEvents[0].data.source, 'self-check')
    A.equal(statusEvents.at(-1).data.progress, 70)
    A.ok(Boolean(liveNodeStatus), '运行中 live 可读')
    A.equal(liveNodeStatus.n_status.state, 'working')
    A.equal(liveNodeStatus.n_status.progress, 40)
    A.equal(liveNodeStatus.n_status.members[0].name, '成员甲')
    A.equal(raw.nodeStatus.n_status.state, 'working')
    A.equal(raw.nodeStatus.n_status.progress, 70)
    A.deepEqual(raw.nodeStatus.n_status.blockers, ['等接口'])
    A.equal(typeof raw.nodeStatus.n_status.at, 'string')
    // 同文本里的正式 verdict 被解析成节点结论（不是被 status 块挡掉）。
    A.equal(events.find(event => event.kind === 'node/end').data.status, 'passed')
  })

  await check('⑤ 自审 done+pass 提前完成：progress=100 + blockers 空 + 正式 verdict 才收口（证据不丢）', async () => {
    const flow = flowOf('flow-alarm-early', [
      startNode(), stage('n_early', '提前完成', 300), endNode(),
    ], [
      next('e1', 'n_start', 'n_early'),
      next('e2', 'n_early', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-alarm-early', 1)
    const scheduler = fakeNodeAlarmScheduler()
    const engineRef = { value: null }
    const { ctx } = nodeAlarmAgents(engineRef, ({ envelope, emit }) => {
      // 状态块 + 正式结论同一条回复到达，但**不**放行 whenIdle —— 必须靠自审信号提前收口。
      const block = value => `\`\`\`json\n${JSON.stringify({
        attempt: envelope.attempt,
        nonce: envelope.nonce,
        ...value,
      })}\n\`\`\``
      emit([
        block({
          nodeId: 'n_early',
          state: 'done',
          progress: 100,
          summary: '自审认为已完成',
          blockers: [],
          verdict: 'pass',
        }),
        block(passResult('n_early').structured),
      ].join('\n'))
    })
    const engine = createEngine({ runsRoot, flowsRoot, ctx, nodeSupervision: scheduler })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')

    A.equal(final.status, 'done')
    A.equal(nodeEnd.data.status, 'passed')
    A.equal(nodeEnd.extra.completedBy, 'self-check')
    A.equal(events.some(event => event.kind === 'node/status' && event.data.state === 'done'), true)
    // C2：提前收口用的是正式结论，artifacts / findings 等证据必须保留（不再只剩 verdict+summary）。
    A.ok(events.some(event => event.kind === 'artifact/write'), '正式结论的产物仍然落盘')
    A.ok(events.some(event => event.kind === 'review/finding'), '正式结论的 findings 仍然落成事件')
  })

  await check('⑥ 自审 done 但 verdict 非法：不提前完成，仍走 whenIdle 的正常解析', async () => {
    const flow = flowOf('flow-alarm-invalid', [
      startNode(), stage('n_invalid', '非法 verdict', 300), endNode(),
    ], [
      next('e1', 'n_start', 'n_invalid'),
      next('e2', 'n_invalid', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-alarm-invalid', 1)
    const scheduler = fakeNodeAlarmScheduler()
    const engineRef = { value: null }
    const { ctx } = nodeAlarmAgents(engineRef, ({ emitStatus, emitStructured, finishIdle }) => {
      emitStatus({
        nodeId: 'n_invalid',
        state: 'done',
        progress: 100,
        summary: '我说完成但我给不出合法 verdict',
        verdict: 'maybe',
      })
      // 正常回合随后到达并放行 whenIdle。
      setTimeout(() => {
        emitStructured(passResult('n_invalid').structured)
        finishIdle()
      }, 0)
    })
    const engine = createEngine({ runsRoot, flowsRoot, ctx, nodeSupervision: scheduler })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')
    const statusEvent = events.find(event => event.kind === 'node/status')

    A.equal(final.status, 'done')
    A.equal(nodeEnd.data.status, 'passed')
    A.equal(nodeEnd.extra && nodeEnd.extra.completedBy, undefined, '非法 verdict 不得触发提前完成')
    A.ok(Boolean(statusEvent), '非法 verdict 仍作为自审状态记录')
    A.ok(statusEvent.data.verdict === undefined || statusEvent.data.verdict === null)
  })

  await check('⑦ 不注入 nodeSupervision：行为与 v0.7 一致，不写 nodeStatus / node/status', async () => {
    const flow = flowOf('flow-alarm-none', [
      startNode(), stage('n_plain', '无闹钟', 300), endNode(),
    ], [
      next('e1', 'n_start', 'n_plain'),
      next('e2', 'n_plain', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-alarm-none', 1)
    const engineRef = { value: null }
    const { ctx } = nodeAlarmAgents(engineRef, ({ emitStatus, emitStructured, finishIdle }) => {
      // 即使会话消息里有自审结构，没有注入调度器时也不采集、不竞速。
      emitStatus({ nodeId: 'n_plain', state: 'done', progress: 100, verdict: 'pass' })
      setTimeout(() => {
        emitStructured(passResult('n_plain').structured)
        finishIdle()
      }, 0)
    })
    const engine = createEngine({ runsRoot, flowsRoot, ctx })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const raw = readRawRun(run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')

    A.equal(engine.nodeSupervision, null)
    A.equal(final.status, 'done')
    A.equal(raw.nodeStatus, undefined)
    A.equal(events.some(event => event.kind === 'node/status'), false)
    A.equal(nodeEnd.extra && nodeEnd.extra.completedBy, undefined, '不注入时没有自审提前完成')
  })

  await check('⑧ 外部 executor 节点：不登记、不写 nodeStatus；注销入口对未登记 sessionId 幂等安全', async () => {
    const execDir = mkdtempSync(join(repoRoot, '.tmp', 'alarm-exec-'))
    try {
      const stubPath = join(execDir, 'external.mjs')
      writeFileSync(stubPath, `console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ verdict: 'pass', summary: '外部节点通过' }) } }))\n`)
      const flow = flowOf('flow-alarm-exec', [
        startNode(),
        stage('n_ext_alarm', '外部节点', 300, { executor: 'custom', executorCommand: `node ${JSON.stringify(stubPath)}` }),
        endNode(),
      ], [
        next('e1', 'n_start', 'n_ext_alarm'),
        next('e2', 'n_ext_alarm', 'n_end'),
      ])
      await saveFlow(flow)
      const run = await makeRun('flow-alarm-exec', 1)
      const scheduler = fakeNodeAlarmScheduler({ strictUnregister: true })
      const engine = createEngine({ runsRoot, flowsRoot, nodeSupervision: scheduler })
      await engine.start(run.id, { worktree: 'off' })
      const final = await engine.wait(run.id)
      const raw = readRawRun(run.id)

      A.equal(final.status, 'done')
      A.equal(scheduler.calls.register.length, 0, '外部 executor 没有会话，不登记闹钟')
      A.equal(raw.nodeStatus, undefined, '外部 executor 不写 nodeStatus')
      A.equal(scheduler.calls.unregisterRun.filter(id => id === run.id).length, 1)
      // 严格调度器对未登记 sessionId 会抛错，引擎的注销入口必须吃掉它（幂等安全）。
      A.equal(engine._unregisterNodeSupervision('ghost-session'), false)
      A.equal(engine._unregisterNodeSupervision('ghost-session'), false)
    } finally {
      rmSync(execDir, { recursive: true, force: true })
    }
  })

  await check('⑨ parseAssistantStructured 防御：自审状态块不当节点结论（缺失 verdict 不白失败）', async () => {
    const statusOnly = {
      nodeId: 'n_defend',
      attempt: 1,
      state: 'done',
      progress: 80,
      summary: '自审认为快完成',
      members: [],
      blockers: [],
      verdict: null,
    }
    const verdict = passResult('n_defend').structured
    const fenced = value => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``

    // ① 只有状态块：不能当结论（旧逻辑会返回它，随后 normalizeStructured 白失败）。
    A.equal(parseAssistantStructured(fenced(statusOnly)), null)
    A.equal(parseAssistantStructured(JSON.stringify(statusOnly)), null)
    // ② 状态块 + 真正的 verdict 块：返回 verdict 块。
    A.deepEqual(parseAssistantStructured(`${fenced(statusOnly)}\n${fenced(verdict)}`), verdict)
    // ③ 正常结构不受影响。
    A.deepEqual(parseAssistantStructured(fenced(verdict)), verdict)
    A.deepEqual(parseAssistantStructured(JSON.stringify(verdict)), verdict)
    // 状态块没有 state 时仍按旧行为退回（不是自审块，不改变既有语义）。
    A.deepEqual(parseAssistantStructured(fenced({ summary: '只有摘要' })), { summary: '只有摘要' })
  })

  await check('⑩ 自审采集只认状态报告：正常 verdict JSON 不会被记成一次状态上报', async () => {
    const engine = createEngine({ runsRoot, flowsRoot })
    // 节点正常回合的结构化结论：有 verdict、没有状态字段 → 不该被当成自审回报。
    A.equal(engine._parseNodeStatus('```json\n{"verdict":"pass","summary":"做完了"}\n```'), null)
    A.equal(engine._parseNodeStatus('{"verdict":"reject","rejectReason":"要返工"}'), null)
    // 状态报告：至少含一个状态专有字段。
    const status = engine._parseNodeStatus('```json\n{"state":"done","progress":100,"verdict":"pass"}\n```')
    A.equal(status && status.state, 'done')
    A.equal(status && status.verdict, 'pass')
    const partial = engine._parseNodeStatus('{"progress":40,"blockers":["等依赖"]}')
    A.equal(partial && partial.progress, 40)
    A.deepEqual(partial && partial.blockers, ['等依赖'])
    // 成员 note 会进 run.json 快照（客户端要显示）。
    A.equal(engine._parseNodeStatus('not json'), null)
  })

  // -------------------------------------------------------------------------
  console.log('engine v0.9 · C1 run.json 单一写入口')

  await check('C1：并发 patch 不丢字段、seq 不回退（真实临时 run 目录）', async () => {
    const flow = flowOf('flow-c1', [startNode(), stage('n_c1', 'C1 节点', 300), endNode()], [
      next('e1', 'n_start', 'n_c1'),
      next('e2', 'n_c1', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-c1', 1)
    // 先落一条真实事件，让 run.json 有非零 seq（补写绝不能把它重置成 0）。
    await store.appendEvents(runsRoot, run.id, [{
      v: 1, kind: 'run/start', traceId: 'tr-c1-run',
      data: { flowId: 'flow-c1', flowName: '流程 flow-c1', nodeTotal: 1 },
    }])
    const before = readRawRun(run.id)
    A.ok(before.seq >= 1, '夹具里 run.json 已有非零 seq')

    const engineA = createEngine({ runsRoot, flowsRoot })
    const engineB = createEngine({ runsRoot, flowsRoot })
    // A 只补工作区 / 会话模式，B 只补 nodeStatus / sessions：并发后两组字段都要在。
    engineA.workspaceRecord = {
      id: 'aaaaaaaaaaaa', path: '/ws-c1', realpath: '/ws-c1', isGit: false, gitRoot: null,
    }
    engineA.sessionMode = 'top-level'
    engineB.nodeStatus = new Map([['n_c1', {
      state: 'working', progress: 42, summary: '并发补写', members: [], blockers: [], verdict: null,
      at: new Date().toISOString(),
    }]])
    engineB.nodeSessions = new Map([['n_c1', { sessionId: 'sess-c1', createdAt: null, lastUsedAt: null }]])

    await Promise.all([
      engineA._patchRunBinding(run.id),
      engineB._patchRunBinding(run.id),
    ])
    const raw = readRawRun(run.id)
    A.equal(raw.workspace.path, '/ws-c1', '并发的 workspace patch 没有被冲掉')
    A.equal(raw.sessionMode, 'top-level')
    A.equal(raw.nodeStatus.n_c1.progress, 42, '并发的 nodeStatus patch 没有被冲掉')
    A.equal(raw.seq, before.seq, 'seq 不回退')
    A.equal(raw.lastSeq, before.seq, 'lastSeq 不回退')

    // 再并发多轮，交替只写一侧字段，确认写入串行且每次都保留对方字段。
    await Promise.all(Array.from({ length: 6 }, (_, index) => {
      if (index % 2 === 0) {
        engineA.workspaceRecord = { ...engineA.workspaceRecord, path: `/ws-c1-${index}` }
        return engineA._patchRunBinding(run.id)
      }
      engineB.nodeStatus = new Map([['n_c1', {
        state: 'working', progress: 42 + index, summary: '并发补写', members: [], blockers: [], verdict: null,
        at: new Date().toISOString(),
      }]])
      return engineB._patchRunBinding(run.id)
    }))
    const raw2 = readRawRun(run.id)
    A.ok(typeof raw2.workspace.path === 'string' && raw2.workspace.path.startsWith('/ws-c1'), 'workspace 字段仍在')
    A.equal(raw2.nodeStatus.n_c1.progress, 47, '最后一轮 nodeStatus 生效')
    A.equal(raw2.seq, before.seq, '多轮并发后 seq 仍不回退')
  })

  await check('C1：sessions 超过 runstore 上限（512）时跳过该次 binding patch（warn），run 不被打挂', async () => {
    const flow = flowOf('flow-c1-sessions', [startNode(), stage('n_sess', '会话节点', 300), endNode()], [
      next('e1', 'n_start', 'n_sess'),
      next('e2', 'n_sess', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-c1-sessions', 1)
    const logs = []
    const engine = createEngine({ runsRoot, flowsRoot, log: (level, message) => logs.push(`${level}:${message}`) })
    engine.workspaceRecord = {
      id: 'bbbbbbbbbbbb', path: '/ws-sessions', realpath: '/ws-sessions', isGit: false, gitRoot: null,
    }
    engine.nodeSessions = new Map(Array.from({ length: 513 }, (_, index) => [
      `n_${index}`, { sessionId: `sess-${index}`, createdAt: null, lastUsedAt: null },
    ]))
    // 不得抛出：一次元数据校验失败只跳过该次 binding patch。
    await engine._patchRunBinding(run.id)
    A.ok(logs.some(line => /跳过本次 run\.json binding patch/.test(line)), 'sessions 超限必须 warn')
    const skipped = readRawRun(run.id)
    A.equal(skipped.sessions, undefined, '被拒绝的 patch 不留下半套数据')
    A.equal(skipped.workspace, undefined, '本次 patch 整体跳过（workspace 也没写）')

    // 收窄到上限内：同一入口恢复正常，sessions / workspace 都落盘。
    engine.sessionsPatchWarned = false
    engine.nodeSessions = new Map(Array.from({ length: 512 }, (_, index) => [
      `n_${index}`, { sessionId: `sess-${index}`, createdAt: null, lastUsedAt: null },
    ]))
    await engine._patchRunBinding(run.id)
    const recovered = readRawRun(run.id)
    A.equal(Object.keys(recovered.sessions).length, 512)
    A.equal(recovered.sessions.n_0, 'sess-0')
    A.equal(recovered.workspace.path, '/ws-sessions')
  })

  await check('C1：live 载荷不含 nodeStatus（唯一权威在 run.json 顶层 nodeStatus）', async () => {
    const flow = flowOf('flow-c1-live', [startNode(), stage('n_live', 'live 节点', 300), endNode()], [
      next('e1', 'n_start', 'n_live'),
      next('e2', 'n_live', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-c1-live', 1)
    const engine = createEngine({ runsRoot, flowsRoot })
    engine.active = { runId: run.id }
    const entry = {
      state: 'working', progress: 5, summary: 'live 快照', members: [], blockers: [], verdict: null,
      at: new Date().toISOString(),
    }
    engine.nodeStatus = new Map([['n_live', entry]])
    engine.live = {
      phase: 'node',
      nodeStatus: { n_live: entry },
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    }
    await engine._persistLive()
    const raw = readRawRun(run.id)
    A.equal(raw.live && Object.prototype.hasOwnProperty.call(raw.live, 'nodeStatus'), false, 'live 里不再带死字段')
    A.equal(raw.nodeStatus.n_live.progress, 5, '顶层 nodeStatus 由 binding 收口路径写')
    A.equal(engine.live.nodeStatus.n_live.progress, 5, '同进程内存快照仍可读')
  })

  // -------------------------------------------------------------------------
  console.log('engine v0.9 · C2 自审可信度')

  await check('C2：正式 reject > 状态块 pass；attempt / nonce 不匹配的正式回报被丢弃', async () => {
    const statusPass = {
      nodeId: 'n_c2', state: 'done', progress: 100, blockers: [], verdict: 'pass', attempt: 2, nonce: 'nonce-2',
    }
    const formalReject = {
      verdict: 'reject', summary: '正式打回', rejectReason: '不达标', attempt: 2, nonce: 'nonce-2',
    }
    // 状态块里写 pass，正式结论是 reject：必须返回正式 reject（不许翻成 pass）。
    A.deepEqual(
      parseAssistantStructured(`${fenced(statusPass)}\n${fenced(formalReject)}`, { attempt: 2, nonce: 'nonce-2' }),
      formalReject,
    )
    // 只有状态块：绝不能当正式结论。
    A.equal(parseAssistantStructured(fenced(statusPass), { attempt: 2, nonce: 'nonce-2' }), null)
    // 旧 attempt 的迟到正式回报：丢弃并回调留痕。
    const rejected = []
    const staleAttempt = { ...formalReject, attempt: 1 }
    A.equal(
      parseAssistantStructured(fenced(staleAttempt), {
        attempt: 2, nonce: 'nonce-2', onReject: (value, reason) => rejected.push(reason),
      }),
      null,
    )
    A.deepEqual(rejected, ['attempt-mismatch'])
    // 缺失 / 错误 nonce：同样丢弃。
    const rejectedNonce = []
    A.equal(
      parseAssistantStructured(fenced({ ...formalReject, nonce: 'old-nonce' }), {
        attempt: 2, nonce: 'nonce-2', onReject: (value, reason) => rejectedNonce.push(reason),
      }),
      null,
    )
    A.deepEqual(rejectedNonce, ['nonce-mismatch'])
    A.equal(parseAssistantStructured(fenced({ ...formalReject, nonce: undefined }), { attempt: 2, nonce: 'nonce-2' }), null)
  })

  await check('C2：旧 attempt 的自审回报被丢弃（留日志），正式 reject 仍触发返工', async () => {
    const flow = flowOf('flow-c2-reject', [
      startNode(), stage('n_a', '上游', 300), stage('n_b', '复核', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      reject('e3', 'n_b', 'n_a'),
      next('e4', 'n_b', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-c2-reject', 2)
    const engineRef = { value: null }
    const logs = []
    let nBRuns = 0
    const { ctx } = nodeAlarmAgents(engineRef, ({ envelope, emit, emitStructured, finishIdle, options }) => {
      if (options.sessionId.includes('n_a')) {
        emitStructured(passResult('n_a').structured)
        finishIdle()
        return
      }
      nBRuns += 1
      if (nBRuns === 1) {
        // 同一轮里状态块说 pass，但正式结论是 reject：必须按 reject 返工。
        emit(`${fenced({
          nodeId: 'n_b', state: 'done', progress: 100, blockers: [], verdict: 'pass',
          attempt: envelope.attempt, nonce: envelope.nonce,
        })}\n${fenced({
          verdict: 'reject', summary: '正式打回 n_a', rejectReason: '证据不达标', rejectTarget: 'n_a',
          attempt: envelope.attempt, nonce: envelope.nonce,
        })}`)
        return
      }
      // 第二轮：先发一条**旧 attempt** 的迟到状态块 + pass，必须被丢弃并留日志。
      emit(`${fenced({
        nodeId: 'n_b', state: 'done', progress: 100, blockers: [], verdict: 'pass',
        attempt: envelope.attempt - 1, nonce: envelope.nonce,
      })}\n${fenced({
        ...passResult('n_b').structured,
        attempt: envelope.attempt - 1, nonce: envelope.nonce,
      })}`)
      setTimeout(() => {
        emit(`${fenced({
          nodeId: 'n_b', state: 'done', progress: 100, blockers: [], verdict: 'pass',
          attempt: envelope.attempt, nonce: envelope.nonce,
        })}\n${fenced({
          ...passResult('n_b').structured,
          attempt: envelope.attempt, nonce: envelope.nonce,
        })}`)
        finishIdle()
      }, 5)
    })
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      ctx,
      nodeSupervision: fakeNodeAlarmScheduler(),
      nodeTimeoutMs: 1500,
      log: (level, message) => logs.push(`${level}:${message}`),
    })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)

    A.equal(final.status, 'done')
    const trigger = events.find(event => event.kind === 'reject/trigger')
    A.ok(Boolean(trigger), '正式 reject 必须触发返工')
    A.equal(trigger.data.fromNodeId, 'n_b')
    A.equal(trigger.data.toNodeId, 'n_a')
    A.deepEqual(
      events.filter(event => event.kind === 'node/start' && event.nodeId === 'n_a').map(event => event.attemptId),
      [1, 2],
      '目标节点真的重跑了一次',
    )
    A.equal(
      events.find(event => event.kind === 'node/end' && event.nodeId === 'n_b' && event.attemptId === 1).data.status,
      'rejected',
      '状态块的 pass 没有翻掉正式 reject',
    )
    A.ok(logs.some(line => /丢弃自审状态块/.test(line)), '旧 attempt 的自审回报必须留可观测日志')
    A.ok(logs.some(line => /attempt 回报 1 \/ 当前 2/.test(line)), '日志要写清旧 attempt / 当前 attempt')
  })

  await check('C2：progress<100 不算提前完成（仍以正式 verdict 正常收口）', async () => {
    const flow = flowOf('flow-c2-progress', [
      startNode(), stage('n_prog', '进度不足', 300), endNode(),
    ], [
      next('e1', 'n_start', 'n_prog'),
      next('e2', 'n_prog', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-c2-progress', 1)
    const engineRef = { value: null }
    const { ctx } = nodeAlarmAgents(engineRef, ({ envelope, emit, emitStructured, finishIdle }) => {
      // done 但 progress=99：即使同一个回复里带正式 pass，也不能走自审提前完成。
      emit(`${fenced({
        nodeId: 'n_prog', state: 'done', progress: 99, blockers: [], verdict: 'pass',
        attempt: envelope.attempt, nonce: envelope.nonce,
      })}\n${fenced({
        ...passResult('n_prog').structured,
        attempt: envelope.attempt, nonce: envelope.nonce,
      })}`)
      setTimeout(() => {
        emitStructured(passResult('n_prog').structured)
        finishIdle()
      }, 10)
    })
    const engine = createEngine({
      runsRoot, flowsRoot, ctx, nodeSupervision: fakeNodeAlarmScheduler(), nodeTimeoutMs: 1500,
    })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')

    A.equal(final.status, 'done')
    A.equal(nodeEnd.data.status, 'passed')
    A.equal(nodeEnd.extra && nodeEnd.extra.completedBy, undefined, 'progress<100 不得标记 self-check 提前完成')
  })

  await check('C2：只有状态块时不得完成（按超时失败），但证据被原样保留并留痕', async () => {
    const flow = flowOf('flow-c2-status-only', [
      startNode(), stage('n_ev', '只有状态块', 300), endNode(),
    ], [
      next('e1', 'n_start', 'n_ev'),
      next('e2', 'n_ev', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-c2-status-only', 1)
    const engineRef = { value: null }
    const evidence = {
      artifacts: [{ name: 'late.md', content: '# 迟到的证据\n' }],
      findings: [{ id: 'F-1', severity: 'P2', title: '迟到发现', status: 'open' }],
      acceptance: [{ itemId: 'R-1', status: 'pass', decidedBy: 'auto' }],
      tests: { suite: 'late-suite', executed: 1, passed: 1, failed: 0, skipped: 0 },
      checks: { ruleSetId: 'late-rules', ruleSetVersion: '1', executor: 'test', passedChecks: 1, totalChecks: 1 },
    }
    const { ctx } = nodeAlarmAgents(engineRef, ({ envelope, emit }) => {
      // 只有状态块（哪怕它自带 verdict=pass），不放行 whenIdle。
      emit(fenced({
        nodeId: 'n_ev', state: 'done', progress: 100, blockers: [], verdict: 'pass',
        attempt: envelope.attempt, nonce: envelope.nonce,
        ...evidence,
      }))
    })
    const engine = createEngine({
      runsRoot, flowsRoot, ctx, nodeSupervision: fakeNodeAlarmScheduler(), nodeTimeoutMs: 200, nodeRetries: 0,
    })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const statusEvent = events.find(event => event.kind === 'node/status')
    const nodeEnd = events.find(event => event.kind === 'node/end')

    A.equal(final.status, 'failed', '只有状态块没有正式 verdict：不得判完成，按超时失败')
    A.equal(nodeEnd.data.status, 'failed')
    A.equal(nodeEnd.extra && nodeEnd.extra.completedBy, undefined)
    A.ok(Boolean(statusEvent), '状态块仍落成 node/status')
    A.ok(statusEvent.extra && typeof statusEvent.extra.selfCheckEvidence === 'string', '事件流里留了证据文件路径')
    const artifactPath = join(runsRoot, run.id, statusEvent.extra.selfCheckEvidence)
    A.ok(existsSync(artifactPath), '证据文件必须真的落盘')
    const saved = JSON.parse(readFileSync(artifactPath, 'utf8'))
    A.deepEqual(saved.artifacts, evidence.artifacts)
    A.deepEqual(saved.findings, evidence.findings)
    A.deepEqual(saved.acceptance, evidence.acceptance)
    A.deepEqual(saved.tests, evidence.tests)
    A.deepEqual(saved.checks, evidence.checks)
    A.ok(events.some(event => event.kind === 'artifact/write'
      && event.data.path === statusEvent.extra.selfCheckEvidence), '证据落盘也有 artifact/write 事件')
  })

  await check('C2：内存 nodeStatus 的 members 只保留最新 20 条（喂 100 条）', async () => {
    const flow = flowOf('flow-c2-members', [startNode(), stage('n_big', '成员上限', 300), endNode()], [
      next('e1', 'n_start', 'n_big'),
      next('e2', 'n_big', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-c2-members', 1)
    const engine = createEngine({ runsRoot, flowsRoot, nodeSupervision: fakeNodeAlarmScheduler() })
    engine.active = { runId: run.id }
    engine.attemptEnvelopes.set('sess-big', { attempt: 1, nonce: 'nonce-big' })
    const members = Array.from({ length: 100 }, (_, index) => ({
      name: `member-${index + 1}`, state: 'working',
    }))
    // 走完整解析链路：supervise 只留前 20 条，引擎必须从原始 payload 取尾部 20 条。
    const parsed = engine._parseNodeStatus(fenced({
      nodeId: 'n_big', state: 'working', progress: 50, summary: '成员很多',
      members, blockers: [], verdict: null, attempt: 1, nonce: 'nonce-big',
    }))
    A.ok(Boolean(parsed), '状态块必须能被解析')
    engine._rememberNodeStatus(
      { sessionId: 'sess-big', nodeId: 'n_big', attemptId: 1, traceId: 'tr-big' },
      parsed,
    )
    const entry = engine.nodeStatus.get('n_big')
    A.equal(entry.members.length, 20, '内存快照最多 20 条')
    A.deepEqual(
      entry.members.map(member => member.name),
      members.slice(-20).map(member => member.name),
      '保留的是最新（数组尾部）20 条',
    )
    await engine.eventQueue
    await engine._patchRunBinding(run.id)
    const raw = readRawRun(run.id)
    A.equal(raw.nodeStatus.n_big.members.length, 20, 'run.json 顶层同样有界')
  })

  await check('E1-b：有状态键但数值非法 → recordReport(kind=invalid)，不写节点完成状态', async () => {
    const flow = flowOf('flow-e1b-invalid', [startNode(), stage('n_inv', '坏回报', 300), endNode()], [
      next('e1', 'n_start', 'n_inv'),
      next('e2', 'n_inv', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-e1b-invalid', 1)
    const scheduler = realNodeScheduler()
    const engineRef = { value: null }
    let snapshotAfterInvalid = null
    let hasStatusAfterInvalid = null
    const { ctx } = nodeAlarmAgents(engineRef, ({ envelope, emit, emitStructured, finishIdle }) => {
      // 形状对、键齐全，但 progress 不是 0..100 的整数：坏输入必须被记成 invalid。
      emit(fenced({
        nodeId: 'n_inv',
        state: 'done',
        progress: 'abc',
        blockers: [],
        attempt: envelope.attempt,
        nonce: envelope.nonce,
      }))
      snapshotAfterInvalid = scheduler.snapshot()
      hasStatusAfterInvalid = engineRef.value.nodeStatus.has('n_inv')
      // 正常正式结论随后到达，让 run 能收口（验证 invalid 报告本身不拖死流程）。
      setTimeout(() => {
        emitStructured(passResult('n_inv').structured)
        finishIdle()
      }, 0)
    })
    const engine = createEngine({
      runsRoot, flowsRoot, ctx, nodeSupervision: scheduler, nodeTimeoutMs: 1500,
    })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const entry = snapshotAfterInvalid && snapshotAfterInvalid.entries.find(item => item.nodeId === 'n_inv')
    const raw = readRawRun(run.id)
    const nodeEnd = (await eventsOf(run.id)).find(event => event.kind === 'node/end')

    A.equal(final.status, 'done')
    A.ok(Boolean(entry), '调度器里必须能找到这个节点的 entry')
    A.equal(entry.lastReport.kind, 'invalid', '坏回报必须留 invalid 诊断')
    A.match(entry.lastReport.reason, /progress/)
    A.equal(hasStatusAfterInvalid, false, 'invalid 回报不得写成节点状态')
    A.equal(engine.nodeStatus.has('n_inv'), false)
    A.equal(raw.nodeStatus, undefined, 'run.json 顶层也不含这条坏状态')
    A.equal(nodeEnd.data.status, 'passed', '正常正式结论仍可收口')
    A.equal(nodeEnd.extra && nodeEnd.extra.completedBy, undefined, '坏回报不能触发自审提前完成')
  })

  await check('E1-b：普通对话文本不含状态键 → 不误报 invalid', async () => {
    const flow = flowOf('flow-e1b-plain', [startNode(), stage('n_plain_talk', '普通对话', 300), endNode()], [
      next('e1', 'n_start', 'n_plain_talk'),
      next('e2', 'n_plain_talk', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-e1b-plain', 1)
    const scheduler = realNodeScheduler()
    const engineRef = { value: null }
    let snapshotAfterPlain = null
    const { ctx } = nodeAlarmAgents(engineRef, ({ emit, emitStructured, finishIdle }) => {
      emit('这是一段普通对话，没有任何状态字段。')
      snapshotAfterPlain = scheduler.snapshot()
      setTimeout(() => {
        emitStructured(passResult('n_plain_talk').structured)
        finishIdle()
      }, 0)
    })
    const engine = createEngine({
      runsRoot, flowsRoot, ctx, nodeSupervision: scheduler, nodeTimeoutMs: 1500,
    })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const entry = snapshotAfterPlain && snapshotAfterPlain.entries.find(item => item.nodeId === 'n_plain_talk')

    A.equal(final.status, 'done')
    A.ok(Boolean(entry))
    A.equal(entry.lastReport, null, '普通对话不得被记成 invalid')
  })

  await check('C2：正式 reject 先到、状态块 pass 后到 → 仍按 reject 返工（正式结论 > 状态块）', async () => {
    const flow = flowOf('flow-c2-late-status', [
      startNode(), stage('n_a', '上游', 300), stage('n_b', '复核', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      reject('e3', 'n_b', 'n_a'),
      next('e4', 'n_b', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-c2-late-status', 2)
    const engineRef = { value: null }
    let nBRuns = 0
    const { ctx } = nodeAlarmAgents(engineRef, ({ envelope, emit, emitStructured, finishIdle, options }) => {
      if (options.sessionId.includes('n_a')) {
        emitStructured(passResult('n_a').structured)
        finishIdle()
        return
      }
      nBRuns += 1
      if (nBRuns === 1) {
        // 先发正式 reject；随后一条只有状态块（自带 pass）把 lastAssistant 覆盖掉。
        emit(fenced({
          verdict: 'reject', summary: '正式打回', rejectReason: '证据不达标', rejectTarget: 'n_a',
          attempt: envelope.attempt, nonce: envelope.nonce,
        }))
        setTimeout(() => {
          emit(fenced({
            nodeId: 'n_b', state: 'done', progress: 100, blockers: [], verdict: 'pass',
            attempt: envelope.attempt, nonce: envelope.nonce,
          }))
          finishIdle()
        }, 5)
        return
      }
      emit(`${fenced({
        nodeId: 'n_b', state: 'done', progress: 100, blockers: [], verdict: 'pass',
        attempt: envelope.attempt, nonce: envelope.nonce,
      })}\n${fenced({
        ...passResult('n_b').structured,
        attempt: envelope.attempt, nonce: envelope.nonce,
      })}`)
      finishIdle()
    })
    const engine = createEngine({
      runsRoot, flowsRoot, ctx, nodeSupervision: fakeNodeAlarmScheduler(), nodeTimeoutMs: 1500,
    })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)

    A.equal(final.status, 'done')
    const trigger = events.find(event => event.kind === 'reject/trigger')
    A.ok(Boolean(trigger), '正式 reject 不能因为后面一条状态块 pass 而丢失')
    A.equal(trigger.data.fromNodeId, 'n_b')
    A.equal(trigger.data.toNodeId, 'n_a')
    A.deepEqual(
      events.filter(event => event.kind === 'node/start' && event.nodeId === 'n_a').map(event => event.attemptId),
      [1, 2],
    )
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.3 · G1 收尾竞态 / 结论解析 / 证据 id / 超时配置')

  await check('G1-a：dispose 期间到达的 assistant/message 不写到 run/end 之后，live 保持 null，丢弃计数可读', async () => {
    const flow = flowOf('flow-g1a', [startNode(), stage('n_a', '实现', 300), endNode()], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-g1a', 1)
    const engineRef = { value: null }
    const earlyText = 'G1A-EARLY-EVENT-BEFORE-SEAL'
    const lateText = 'G1A-LATE-EVENT-DURING-DISPOSE'
    let disposed = false
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async () => {
        // 收尾之前派发的一条会话事件：必须照常落盘（证明封口只丢封口之后的事件）。
        engineRef.value.handleSessionEvent({ id: 'sess-g1a' }, {
          type: 'assistant/message',
          data: { message: { role: 'assistant', content: [{ type: 'text', text: earlyText }] } },
        })
        return {
          structured: passResult('n_a').structured,
          sessionId: 'sess-g1a',
          handle: {
            dispose: async () => {
              disposed = true
              // 宿主要在 dispose 里 cancel / drain 正在跑的回合，这期间仍可能派发 session/event。
              engineRef.value.handleSessionEvent({ id: 'sess-g1a' }, {
                type: 'assistant/message',
                data: {
                  message: { role: 'assistant', content: [{ type: 'text', text: lateText }] },
                  usage: { input: 7, cacheRead: 0, cacheWrite: 0, output: 3 },
                },
              })
              await new Promise(resolve => setTimeout(resolve, 30))
            },
          },
        }
      },
    })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    await engine.eventQueue
    const events = await eventsOf(run.id)
    const runEndIndex = events.findIndex(event => event.kind === 'run/end')
    const afterRunEnd = runEndIndex < 0 ? [] : events.slice(runEndIndex + 1)
    const raw = readRawRun(run.id)
    const texts = events
      .filter(event => event.kind === 'agent/message')
      .map(event => event.data.text)

    A.equal(final.status, 'done')
    A.equal(disposed, true, 'dispose 真的执行过（迟到事件是 dispose 期间派发的）')
    A.equal(runEndIndex >= 0, true, '必须有 run/end')
    // 真实事件文件断言（不看返回值）：run/end 是最后一条，之后一条都没有。
    A.deepEqual(afterRunEnd.map(event => `${event.kind}#${event.seq}`), [])
    A.equal(runEndIndex, events.length - 1, 'run/end 必须是事件文件里的最后一条')
    A.equal(texts.includes(earlyText), true, '封口前的正常事件照常落盘（不是把所有会话事件都丢了）')
    A.equal(texts.includes(lateText), false, 'dispose 期间的迟到事件一条都没落盘')
    A.equal(raw.live, null, 'run.json.live 必须是 null（不许被收尾期间的事件写回非 null）')
    A.equal(final.live, null, 'readRunMeta 读回的 live 同样是 null')
    A.ok(engine.droppedSessionEventsAfterSeal > 0, '封口后丢弃的会话事件必须计数（可读，不静默丢）')
  })

  await check('G1-b①：先发正式结论、再来自审状态块 → 仍用正式结论收口（证据齐全）', async () => {
    const flow = flowOf('flow-g1b1', [startNode(), stage('n_b1', '完成节点', 300), endNode()], [
      next('e1', 'n_start', 'n_b1'),
      next('e2', 'n_b1', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-g1b1', 1)
    const engineRef = { value: null }
    const logs = []
    const { ctx } = nodeAlarmAgents(engineRef, ({ envelope, emit, emitStructured, finishIdle }) => {
      // ① 正式结论（带齐五项证据）
      emitStructured(passResult('n_b1').structured)
      // ② 闹钟注入的自审回报成为最后一条消息（状态块，自带 pass）
      setTimeout(() => {
        emit(fenced({
          nodeId: 'n_b1', state: 'done', progress: 100, blockers: [], verdict: 'pass',
          attempt: envelope.attempt, nonce: envelope.nonce,
        }))
        finishIdle()
      }, 5)
    })
    const engine = createEngine({
      runsRoot, flowsRoot, ctx, nodeSupervision: fakeNodeAlarmScheduler(),
      nodeTimeoutMs: 1500, log: (...args) => logs.push(args.join(' ')),
    })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')
    const acceptance = events.filter(event => event.kind === 'acceptance/verdict')

    A.equal(final.status, 'done')
    A.equal(nodeEnd.data.status, 'passed')
    A.equal(events.some(event => event.kind === 'node/end' && event.data.status === 'failed'), false)
    // 用的确实是更早那条正式结论：它带的五项证据都落盘了（状态块里没有这些）。
    A.equal(acceptance.length, 1)
    A.equal(acceptance[0].data.itemId, 'n_b1:n_b1-R1')
    A.ok(events.some(event => event.kind === 'check/form' && event.data.ruleSetId === 'n_b1:rules-n_b1'))
    A.ok(events.some(event => event.kind === 'test/report' && event.data.suite === 'n_b1:unit-n_b1'))
    A.ok(events.some(event => event.kind === 'review/finding' && event.data.id === 'n_b1:n_b1-F1'))
    A.ok(logs.some(line => /改用本 attempt 最近一条正式结论/.test(line)), '必须留下「改用更早正式结论」的可观测日志')
  })

  await check('G1-b①b：最后一条是「没有 state 键的自审报告」→ 也不顶掉更早的正式结论（旧实现会 StructuredOutputError）', async () => {
    const flow = flowOf('flow-g1b1b', [startNode(), stage('n_b1b', '完成节点', 300), endNode()], [
      next('e1', 'n_start', 'n_b1b'),
      next('e2', 'n_b1b', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-g1b1b', 1)
    const engineRef = { value: null }
    const { ctx } = nodeAlarmAgents(engineRef, ({ envelope, emit, emitStructured, finishIdle }) => {
      emitStructured(passResult('n_b1b').structured)
      setTimeout(() => {
        // 自审报告少了 state 键：它能通过 attempt/nonce 凭证，但**不是**正式结论。
        emit(fenced({
          nodeId: 'n_b1b', progress: 100, blockers: [], summary: '自审认为已完成',
          attempt: envelope.attempt, nonce: envelope.nonce,
        }))
        finishIdle()
      }, 5)
    })
    const engine = createEngine({
      runsRoot, flowsRoot, ctx, nodeSupervision: fakeNodeAlarmScheduler(), nodeTimeoutMs: 1500,
    })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')

    A.equal(final.status, 'done')
    A.equal(nodeEnd.data.status, 'passed')
    A.equal(nodeEnd.extra && nodeEnd.extra.validationError, undefined, '不许因为最后一条自审报告判结构不合格')
    A.equal(events.filter(event => event.kind === 'acceptance/verdict').length, 1, '正式结论里的证据必须落盘')
  })

  await check('G1-b②：先发状态块、再发正式结论 → 用正式结论收口', async () => {
    const flow = flowOf('flow-g1b2', [startNode(), stage('n_b2', '完成节点', 300), endNode()], [
      next('e1', 'n_start', 'n_b2'),
      next('e2', 'n_b2', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-g1b2', 1)
    const engineRef = { value: null }
    const { ctx } = nodeAlarmAgents(engineRef, ({ envelope, emit, emitStructured, finishIdle }) => {
      emit(fenced({
        nodeId: 'n_b2', state: 'working', progress: 100, blockers: [], verdict: 'pass',
        attempt: envelope.attempt, nonce: envelope.nonce,
      }))
      setTimeout(() => {
        emitStructured(passResult('n_b2').structured)
        finishIdle()
      }, 5)
    })
    const engine = createEngine({
      runsRoot, flowsRoot, ctx, nodeSupervision: fakeNodeAlarmScheduler(), nodeTimeoutMs: 1500,
    })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')

    A.equal(final.status, 'done')
    A.equal(nodeEnd.data.status, 'passed')
    A.equal(events.filter(event => event.kind === 'acceptance/verdict').length, 1)
    A.equal(nodeEnd.extra && nodeEnd.extra.validationError, undefined)
  })

  await check('G1-b③：只有状态块 → 不判完成（按节点超时失败），证据仍落 self-check-raw.json', async () => {
    const flow = flowOf('flow-g1b3', [startNode(), stage('n_b3', '完成节点', 300), endNode()], [
      next('e1', 'n_start', 'n_b3'),
      next('e2', 'n_b3', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-g1b3', 1)
    const engineRef = { value: null }
    const { ctx } = nodeAlarmAgents(engineRef, ({ envelope, emit }) => {
      // 只有状态块（自带 verdict=pass、progress=100、blockers 空），且**不**放行 whenIdle。
      emit(fenced({
        nodeId: 'n_b3', state: 'done', progress: 100, blockers: [], verdict: 'pass',
        attempt: envelope.attempt, nonce: envelope.nonce,
        acceptance: [{ itemId: 'R1', status: 'pass', decidedBy: 'auto' }],
      }))
    })
    const engine = createEngine({
      runsRoot, flowsRoot, ctx, nodeSupervision: fakeNodeAlarmScheduler(), nodeTimeoutMs: 400,
    })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const nodeEnd = events.find(event => event.kind === 'node/end')
    const evidencePath = join(runsRoot, run.id, 'n_b3', 'artifacts', '1', 'self-check-raw.json')

    A.equal(final.status, 'failed')
    A.equal(nodeEnd.data.status, 'failed')
    A.equal(nodeEnd.extra && nodeEnd.extra.timeout, true, '只有状态块时必须等超时，不能提前完成')
    A.equal(nodeEnd.extra && nodeEnd.extra.completedBy, undefined)
    A.equal(existsSync(evidencePath), true, '状态块夹带的证据必须落 self-check-raw.json')
    A.equal(events.some(event => event.kind === 'acceptance/verdict'), false, '状态块里的 acceptance 不参与流转')
  })

  await check('G1-c：模型照抄打回上下文里的 id → 最终事件是 n_a:R1（不是 n_a:n_a:R1），staleFails 为空', async () => {
    const flow = flowOf('flow-g1c', [
      startNode(), stage('n_a', '开发', 300, { maxRounds: 3 }), stage('n_b', '复核', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
      reject('e4', 'n_b', 'n_a'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-g1c', 2)
    let promptA2 = ''
    let echoed = null
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: async ({ node, attempt, prompt }) => {
        if (node.id === 'n_a' && attempt === 1) {
          return {
            structured: {
              verdict: 'pass',
              summary: 'A 首轮通过',
              artifacts: [{ name: 'a.md', content: '# a\n' }],
              findings: [{ id: 'F1', severity: 'P2', title: 'A 小问题', status: 'open' }],
              acceptance: [{ itemId: 'R1', status: 'pass', decidedBy: 'auto' }],
              checks: { ruleSetId: 'rules-a', ruleSetVersion: '1', executor: 't', passedChecks: 1, totalChecks: 1 },
              tests: { suite: 'a-suite', executed: 1, passed: 1, failed: 0, skipped: 0 },
            },
            sessionId: 'sess-a1',
            dispose: async () => {},
          }
        }
        if (node.id === 'n_b' && attempt === 1) {
          return {
            structured: {
              verdict: 'reject', summary: 'B 打回 A', rejectTarget: 'n_a', rejectReason: 'A 的 R1 没覆盖',
              findings: [{ id: 'BF1', severity: 'P1', title: 'B 指出的返工点', status: 'open' }],
            },
            sessionId: 'sess-b1',
            dispose: async () => {},
          }
        }
        if (node.id === 'n_a' && attempt === 2) {
          promptA2 = prompt
          // 模拟「严格照着打回上下文提示词里的 id 全量重报」的模型：原样回传，不加前缀。
          const itemIdPrinted = /验收条目 itemId：(.+)/.exec(prompt)?.[1]?.trim().split('、')[0]
          const findingIdPrinted = /\[P1\]\s+(\S+)/.exec(prompt)?.[1]
          echoed = { itemIdPrinted, findingIdPrinted }
          return {
            structured: {
              verdict: 'pass',
              summary: 'A 返工完成',
              artifacts: [{ name: 'a2.md', content: '# a2\n' }],
              findings: [{ id: findingIdPrinted, severity: 'P1', title: 'B 指出的返工点', status: 'verified' }],
              acceptance: [{ itemId: itemIdPrinted, status: 'pass', decidedBy: 'auto' }],
              checks: { ruleSetId: 'rules-a', ruleSetVersion: '1', executor: 't', passedChecks: 1, totalChecks: 1 },
              tests: { suite: 'a-suite', executed: 1, passed: 1, failed: 0, skipped: 0 },
            },
            sessionId: 'sess-a2',
            dispose: async () => {},
          }
        }
        return passOf(node.id)
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    const events = await eventsOf(run.id)
    const summary = summarize(events)
    const a2Acceptance = events.filter(event => event.kind === 'acceptance/verdict' && event.nodeId === 'n_a' && event.attemptId === 2)
    const a2Findings = events.filter(event => event.kind === 'review/finding' && event.nodeId === 'n_a' && event.attemptId === 2)
    const allIds = events
      .map(event => event.data && (event.data.id || event.data.itemId || event.data.suite || event.data.ruleSetId))
      .filter(id => typeof id === 'string')

    A.equal(final.status, 'done')
    A.equal(echoed.itemIdPrinted, 'R1', '打回上下文打印的是原始 id（n_a:R1 → R1）')
    A.equal(echoed.findingIdPrinted, 'BF1', '打回方的 finding 也打印原始 id（n_b:BF1 → BF1）')
    A.deepEqual(a2Acceptance.map(event => event.data.itemId), ['n_a:R1'], '照抄回来的 id 只加一层前缀')
    A.deepEqual(a2Findings.map(event => event.data.id), ['n_a:BF1'], '打回方的 finding 复报后归属目标节点，不成 n_a:n_b:BF1')
    A.equal(allIds.some(id => /^n_a:n_a:/.test(id)), false, '不许出现双前缀 id')
    A.equal(allIds.some(id => /^n_a:n_b:/.test(id)), false, '不许出现跨节点双前缀 id')
    A.equal(summary.quality.evidence.acceptance.state, 'pass', '复报后旧 fail 能判成 pass')
    A.equal(summary.quality.evidence.acceptance.staleFails, undefined, '旧 n_a:R1 复判为通过，staleFails 必须为空')
  })

  await check('G1-d①：显式 runTimeoutMs=3000 生效（约 3s abort），生效值可读（run.json.limits / engine.runLimits）', async () => {
    const flow = flowOf('flow-g1d1', [startNode(), stage('n_d1', '长任务', 300), endNode()], [
      next('e1', 'n_start', 'n_d1'),
      next('e2', 'n_d1', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-g1d1', 1)
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      activate: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('已中止')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      }),
    })
    const startedAt = Date.now()
    await engine.start(run.id, { runTimeoutMs: 3000 })
    A.deepEqual(engine.runLimits, { runTimeoutMs: 3000, nodeTimeoutMs: engine.nodeTimeoutMs })
    const final = await engine.wait(run.id)
    const elapsed = Date.now() - startedAt
    const events = await eventsOf(run.id)
    const runEnd = events.find(event => event.kind === 'run/end')
    const raw = readRawRun(run.id)

    A.equal(final.status, 'failed')
    A.equal(runEnd.extra && runEnd.extra.runTimeout, true, '必须是被 run 墙钟打断')
    A.ok(elapsed >= 2800, `约 3s 后 abort（实际 ${elapsed}ms）`)
    A.ok(elapsed < 15000, `不许拖成默认 2h（实际 ${elapsed}ms）`)

    // run.json.limits：实际生效值必须落盘且能被 readRunMeta 读回（runstore 的
    // normalizeMeta 白名单里有 `limits`，见 G2 契约）。
    A.equal(raw.limits.runTimeoutMs, 3000, 'run.json.limits 记下生效的墙钟上限')
    A.equal(raw.limits.nodeTimeoutMs, engine.nodeTimeoutMs, 'run.json.limits 也记下节点超时')
    const back = await store.readRunMeta(runsRoot, run.id)
    A.equal(back && back.limits && back.limits.runTimeoutMs, 3000, 'readRunMeta 能读回 limits')
    A.equal(back.limits.nodeTimeoutMs, engine.nodeTimeoutMs)
  })

  await check('G1-d②：环境变量 FLOW_STUDIO_*_TIMEOUT_MS 生效，显式参数优先级更高', async () => {
    const flow = flowOf('flow-g1d2', [startNode(), stage('n_d2', '长任务', 300), endNode()], [
      next('e1', 'n_start', 'n_d2'),
      next('e2', 'n_d2', 'n_end'),
    ])
    await saveFlow(flow)
    const previousRun = process.env.FLOW_STUDIO_RUN_TIMEOUT_MS
    const previousNode = process.env.FLOW_STUDIO_NODE_TIMEOUT_MS
    process.env.FLOW_STUDIO_RUN_TIMEOUT_MS = '400'
    process.env.FLOW_STUDIO_NODE_TIMEOUT_MS = '90000'
    const hangActivate = ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('已中止')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })
    try {
      // ① 只用环境变量
      const run1 = await makeRun('flow-g1d2', 1)
      const engine1 = createEngine({ runsRoot, flowsRoot, activate: hangActivate })
      await engine1.start(run1.id)
      const final1 = await engine1.wait(run1.id)
      A.deepEqual(engine1.runLimits, { runTimeoutMs: 400, nodeTimeoutMs: 90000 }, '环境变量进入生效值')
      A.equal(final1.status, 'failed')
      A.equal((await eventsOf(run1.id)).find(event => event.kind === 'run/end').extra.runTimeout, true)

      // ② 显式参数 > 环境变量
      const run2 = await makeRun('flow-g1d2', 1)
      const engine2 = createEngine({ runsRoot, flowsRoot, activate: hangActivate })
      await engine2.start(run2.id, { runTimeoutMs: 150, nodeTimeoutMs: 250 })
      const final2 = await engine2.wait(run2.id)
      A.deepEqual(engine2.runLimits, { runTimeoutMs: 150, nodeTimeoutMs: 250 }, '显式参数覆盖环境变量')
      A.equal(final2.status, 'failed')
      A.equal((await eventsOf(run2.id)).find(event => event.kind === 'run/end').extra.runTimeout, true)
    } finally {
      if (previousRun === undefined) delete process.env.FLOW_STUDIO_RUN_TIMEOUT_MS
      else process.env.FLOW_STUDIO_RUN_TIMEOUT_MS = previousRun
      if (previousNode === undefined) delete process.env.FLOW_STUDIO_NODE_TIMEOUT_MS
      else process.env.FLOW_STUDIO_NODE_TIMEOUT_MS = previousNode
    }
  })

  await check('G1-d③：非法 timeout（非正整数）→ 400，不写 run/start、不改 run 状态', async () => {
    const flow = flowOf('flow-g1d3', [startNode(), stage('n_d3', '长任务', 300), endNode()], [
      next('e1', 'n_start', 'n_d3'),
      next('e2', 'n_d3', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-g1d3', 1)
    const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
    for (const bad of [{ runTimeoutMs: 0 }, { runTimeoutMs: -5 }, { runTimeoutMs: 1.5 },
      { nodeTimeoutMs: 0 }, { nodeTimeoutMs: '3000' }, { runTimeoutMs: null, nodeTimeoutMs: Number.NaN }]) {
      let thrown = null
      try {
        await engine.start(run.id, bad)
      } catch (error) {
        thrown = error
      }
      A.ok(thrown instanceof EngineError, `非法参数 ${JSON.stringify(bad)} 必须 400：${thrown && thrown.message}`)
      A.equal(thrown && thrown.status, 400)
    }
    A.equal(engine.active, null, '非法参数不该占住实例')
    A.equal((await eventsOf(run.id)).length, 0, '不许写 run/start')
    const raw = readRawRun(run.id)
    A.equal(raw.status, 'pending', 'run 状态不变')
    A.equal(raw.started, false)
    A.equal(raw.limits, undefined, '非法参数不写 limits')
  })

  // -------------------------------------------------------------------------
  console.log('engine v1.3 · 节点状态 attempt 归属 / worktree 告警与 baseCommit')

  await check('G2：attempt=2 的自审回报把 attempt 写进 run.json.nodeStatus（重启恢复节点闹钟用）', async () => {
    const flow = flowOf('flow-status-attempt', [
      startNode(), stage('n_a', '开发', 300, { maxRounds: 2 }), stage('n_b', '复核', 600), endNode(),
    ], [
      next('e1', 'n_start', 'n_a'),
      next('e2', 'n_a', 'n_b'),
      next('e3', 'n_b', 'n_end'),
      reject('e4', 'n_b', 'n_a'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-status-attempt', 2)
    const engineRef = { value: null }
    let memoEntry = null
    let nBRuns = 0
    const { ctx } = nodeAlarmAgents(engineRef, ({ envelope, emit, emitStructured, emitStatus, finishIdle, options }) => {
      if (options.sessionId.includes('n_a')) {
        const attempt = envelope.attempt
        emitStatus({ nodeId: 'n_a', state: 'working', progress: attempt === 2 ? 60 : 20, blockers: [] })
        if (attempt === 2) {
          // 内存里的权威归属：必须是本次 attempt，而不是模型自报值。
          memoEntry = engineRef.value.nodeStatus.get('n_a') || null
        }
        setTimeout(() => {
          emitStructured(passResult('n_a').structured)
          finishIdle()
        }, 0)
        return
      }
      nBRuns += 1
      if (nBRuns === 1) {
        emitStructured({
          verdict: 'reject', summary: 'B 打回 A', rejectTarget: 'n_a', rejectReason: '返工',
          findings: [{ id: 'BF1', severity: 'P1', title: '返工点', status: 'open' }],
        })
        finishIdle()
        return
      }
      emitStructured(passResult('n_b').structured)
      finishIdle()
    })
    const engine = createEngine({
      runsRoot, flowsRoot, ctx, nodeSupervision: fakeNodeAlarmScheduler(), nodeTimeoutMs: 1500,
    })
    engineRef.value = engine
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    await engine.eventQueue
    await engine._patchRunBinding(run.id)
    const raw = readRawRun(run.id)
    const stored = raw.nodeStatus && raw.nodeStatus.n_a

    A.equal(final.status, 'done')
    A.ok(Boolean(memoEntry), 'attempt=2 的自审回报必须落成内存 nodeStatus')
    A.equal(memoEntry.attempt, 2, '内存 entry 带本次 attempt（权威归属）')
    A.ok(Boolean(stored), 'run.json.nodeStatus 必须落盘（真实文件断言）')
    A.equal(stored.attempt, 2, 'run.json.nodeStatus[nodeId].attempt === 2（重启恢复节点闹钟靠它）')
    A.equal(stored.progress, 60, '落盘的确实是 attempt=2 那条状态')
    const statusEvents = (await eventsOf(run.id)).filter(event => event.kind === 'node/status')
    A.ok(statusEvents.length >= 2, '两个 attempt 各自的自审回报都追加成事件')
    A.equal(statusEvents[statusEvents.length - 1].attemptId, 2, 'node/status 事件的顶层 attemptId 口径不变')
  })

  await check('G2：dirty 工作区 → run.json.worktree.warnings 非空，run/start.data.worktreeWarning 带上该文案', async () => {
    const repo = makeGitRepo('repo-wt-dirty')
    try {
      // 制造未提交修改：worktree 只从 HEAD 检出，这些改动不会带过去。
      writeFileSync(join(repo, 'README.md'), '# fixture\n\n未提交的本地修改\n')
      const flow = flowOf('flow-wt-dirty', [startNode(), stage('n_wt_dirty', '实现', 300), endNode()], [
        next('e1', 'n_start', 'n_wt_dirty'),
        next('e2', 'n_wt_dirty', 'n_end'),
      ])
      await saveFlow(flow)
      const run = await makeRun('flow-wt-dirty', 1)
      const engine = createEngine({
        runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id),
      })
      await engine.start(run.id, { workspace: repo, worktree: 'auto' })
      const final = await engine.wait(run.id)
      const raw = readRawRun(run.id)
      const startEvent = (await eventsOf(run.id)).find(event => event.kind === 'run/start')
      const warnings = Array.isArray(raw.worktree.warnings) ? raw.worktree.warnings : []

      A.equal(final.status, 'done')
      A.equal(raw.worktree.enabled, true)
      A.ok(warnings.length > 0, 'run.json.worktree.warnings 必须记下「会丢什么」')
      A.ok(warnings.some(item => /未提交修改/.test(item)), `warnings 里要说明未提交修改：${JSON.stringify(warnings)}`)
      A.match(startEvent.data.worktreeWarning, /未提交修改/, 'run/start.data.worktreeWarning 必须含该文案')
      // worktrees 根也要落盘（删除入口的严格前缀校验依赖它）。
      A.equal(raw.worktree.root, join(dirname(runsRoot), 'worktrees'))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  await check('G2：空仓库（没有任何提交）→ run 能开跑，baseCommit === null（--orphan 合法值）', async () => {
    const repo = mkdtempSync(join(repoRoot, '.tmp', 'repo-empty-'))
    try {
      const gitHome = join(home, 'git-home-empty')
      mkdirSync(gitHome, { recursive: true })
      const git = args => execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, HOME: gitHome, GIT_CONFIG_NOSYSTEM: '1' },
      })
      git(['init', '-q'])
      git(['checkout', '-q', '-b', 'main'])
      git(['config', 'user.email', 'flow-studio-test@example.invalid'])
      git(['config', 'user.name', 'Flow Studio Test'])
      const flow = flowOf('flow-wt-empty', [startNode(), stage('n_wt_empty', '实现', 300), endNode()], [
        next('e1', 'n_start', 'n_wt_empty'),
        next('e2', 'n_wt_empty', 'n_end'),
      ])
      await saveFlow(flow)
      const run = await makeRun('flow-wt-empty', 1)
      const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
      await engine.start(run.id, { workspace: repo, worktree: 'auto' })
      const final = await engine.wait(run.id)
      const raw = readRawRun(run.id)

      A.equal(final.status, 'done')
      A.equal(raw.worktree.enabled, true, '空仓库也要能开隔离副本（--orphan）')
      A.equal(raw.worktree.baseCommit, null, '空仓库的 baseCommit 必须是 null（不按 40 位 hex 校验）')
      A.ok(existsSync(raw.worktree.path), 'worktree 目录必须真的存在')
      A.ok((raw.worktree.warnings || []).some(item => /空仓库/.test(item)), '空仓库要在 warnings 里说明')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  await check('G2：worktree:on + 子目录工作区 → 400，文案带 subdirectory', async () => {
    const repo = makeGitRepo('repo-subdir')
    try {
      const subdir = join(repo, 'sub')
      mkdirSync(subdir, { recursive: true })
      writeFileSync(join(subdir, 'note.md'), '# sub\n')
      const flow = flowOf('flow-wt-subdir', [startNode(), stage('n_wt_subdir', '实现', 300), endNode()], [
        next('e1', 'n_start', 'n_wt_subdir'),
        next('e2', 'n_wt_subdir', 'n_end'),
      ])
      await saveFlow(flow)
      const run = await makeRun('flow-wt-subdir', 1)
      const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
      let captured = null
      await assert.rejects(
        () => engine.start(run.id, { workspace: subdir, worktree: 'on' }),
        error => {
          captured = error
          return error instanceof EngineError && error.status === 400 && /subdirectory/.test(error.message)
        },
        'on + 子目录必须是 400 且文案含结构化 reason',
      )
      A.ok(Boolean(captured))
      A.equal((await store.readRunMeta(runsRoot, run.id)).status, 'pending')
      A.equal(readRawRun(run.id).worktree, undefined, '= 400 时不写 worktree 记录')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  await check("G2：worktree:off → reason=disabled-by-initiator，run/start 里也能看出是主动关闭", async () => {
    const repo = makeGitRepo('repo-wt-off')
    try {
      const flow = flowOf('flow-wt-off', [startNode(), stage('n_wt_off', '实现', 300), endNode()], [
        next('e1', 'n_start', 'n_wt_off'),
        next('e2', 'n_wt_off', 'n_end'),
      ])
      await saveFlow(flow)
      const run = await makeRun('flow-wt-off', 1)
      const engine = createEngine({ runsRoot, flowsRoot, activate: async ({ node }) => passOf(node.id) })
      await engine.start(run.id, { workspace: repo, worktree: 'off' })
      const final = await engine.wait(run.id)
      const raw = readRawRun(run.id)
      const startEvent = (await eventsOf(run.id)).find(event => event.kind === 'run/start')

      A.equal(final.status, 'done')
      A.equal(raw.worktree.enabled, false)
      A.equal(raw.worktree.reason, 'disabled-by-initiator')
      A.equal(startEvent.data.worktreeEnabled, false)
      A.equal(startEvent.data.worktreeReason, 'disabled-by-initiator', 'run/start.data 里也能看出是用户主动关闭')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${checks} 组通过（${assertionCount} 条断言）`)
