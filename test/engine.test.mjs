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

const engineModule = await import('../src/engine.js')
const store = await import('../src/runstore.js')
const flowStore = await import('../src/store.js')
const { summarize } = await import('../src/runlog.js')
const { toStrictOutputSchema } = await import('../src/executor.js')

const {
  createEngine: createEngineRaw, EngineError, STUB_USAGE, buildPrompt, PROMPT_MAX_CHARS,
  loadUpstreamArtifactContents, MAX_NODE_RETRIES, UPSTREAM_ARTIFACT_READ_MAX_BYTES,
  nodeSessionId, ENGINE_OUTPUT_SCHEMA,
} = engineModule

/**
 * 既有 49 组测试关心的是主循环 / 提示词 / 事件契约，不关心 worktree。构造时默认
 * `worktree:'off'`，避免在插件仓库本身（测试进程的 cwd 是 git 根）上真建 worktree；
 * R1/R4 的 auto / on 行为由文末追加的专组用显式 `worktree` 覆盖。
 * 这只是测试夹具默认值，不改任何既有断言。
 */
const createEngine = (options = {}) => createEngineRaw({ worktree: 'off', ...options })

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
 * `agents.create` 桩：节点会话按 passResult 的结构返回 ```json 代码块。
 * 返回 { ctx, created }，created 里是每次 create 的入参（可断言 meta.cwd / sessionId）。
 */
function agentsCreateCtx(engineRef, { resultFor = () => passResult('n_x').structured } = {}) {
  const created = []
  const ctx = {
    on() {
      return () => {}
    },
    get(name) {
      if (name !== 'agents') return undefined
      return {
        async create(options) {
          created.push(options)
          const sessionId = options.sessionId
          return {
            agent: {
              session: { id: sessionId, header: {} },
              followup() {
                const structured = resultFor(options)
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
                  // 模拟宿主：followup 之后 assistant/message 带 ```json 代码块回来。
                  engine.handleSessionEvent({ id: sessionId }, {
                    type: 'assistant/message',
                    data: {
                      message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(passResult('n_spawn').structured)}\n\`\`\`` }],
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
    A.ok(promptA2.includes('n_a:A-F1'), '带上一轮未关闭 finding 的命名空间 id')
    A.ok(promptA2.includes('n_a:A-F2') === false, 'verified 的问题不再要求返工')
    A.ok(promptA2.includes('n_b:B-F1'), '带打回方列出的未关闭 finding id')
    A.ok(promptA2.includes('复用同一 id'), '明确要求复用同一 id')
    A.ok(promptA2.includes('全量重报'), '明确要求本轮全量重报')
    A.ok(promptA2.includes('n_a:R1'), '下传上一轮 acceptance itemId')
    A.ok(promptA2.includes('n_a:unit-a'), '下传上一轮 tests suite')
    A.ok(promptA2.includes('n_a:rules-a'), '下传上一轮 check ruleSetId')
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

  await check('node.model：默认 agents.create 把 model 放进 agentOptions', async () => {
    const flow = flowOf('flow-model-spawn', [startNode(), stage('n_model', '业务', 300, { model: 'deepseek-reasoner' }), endNode()], [
      next('e1', 'n_start', 'n_model'),
      next('e2', 'n_model', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-model-spawn', 1)
    let engine = null
    let captured = null
    const ctx = {
      on() { return () => {} },
      get(name) {
        if (name !== 'agents') return undefined
        return {
          async create(createOptions) {
            captured = createOptions
            const sessionId = createOptions.sessionId
            return {
              agent: {
                session: { id: sessionId, header: {} },
                followup() {
                  engine.handleSessionEvent({ id: sessionId }, {
                    type: 'assistant/message',
                    data: {
                      message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: JSON.stringify(structuredPass('n_model')) }],
                      },
                    },
                  })
                },
                async whenIdle() {},
              },
              dispose: async () => {},
            }
          },
        }
      },
    }
    engine = createEngine({ runsRoot, flowsRoot, ctx })
    await engine.start(run.id)
    await engine.wait(run.id)
    A.deepEqual(captured.agentOptions, { model: 'deepseek-reasoner' })
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

  await check('auto + 只能回落 process.cwd()：不擅自建 worktree（auto-without-initiator），降级原因进 run 日志', async () => {
    const flow = flowOf('flow-noinit', [startNode(), stage('n_noinit', '节点', 300), endNode()], [
      next('e1', 'n_start', 'n_noinit'),
      next('e2', 'n_noinit', 'n_end'),
    ])
    await saveFlow(flow)
    const run = await makeRun('flow-noinit', 1)
    // 构造时把默认策略设成 auto；start 不给 workspace / cwd / parent → 只能回落 process.cwd()。
    const engine = createEngine({ runsRoot, flowsRoot, worktree: 'auto', activate: async () => passResult('n_noinit') })
    await engine.start(run.id)
    A.equal((await engine.wait(run.id)).status, 'done')

    const raw = readRawRun(run.id)
    A.equal(raw.worktree.enabled, false)
    A.equal(raw.worktree.reason, 'auto-without-initiator')
    A.equal(raw.worktree.path, null)
    const startEvent = (await eventsOf(run.id)).find(event => event.kind === 'run/start')
    A.equal(startEvent.data.worktreeEnabled, false)
    A.match(startEvent.data.worktreeWarning, /process\.cwd/)
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

} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${checks} 组通过（${assertionCount} 条断言）`)
