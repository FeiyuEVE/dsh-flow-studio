#!/usr/bin/env node
/**
 * 流程收件箱 + 节点会话复用自检（06-execution-engine.md · §16）。
 *
 * 全部走注入桩：不启动 dsh、不 import 任何 dsh 包。run / flow 模板落在项目 `.tmp/` 下
 * （不占系统 /tmp）。覆盖：
 *   事件归一化与有界截断、messages.jsonl / sessions.json 读写、目标节点三路解析、
 *   活会话注入 / 冷会话 resume / 启动输入 / 入队、提示词「外部消息」段的有界与下游可见、
 *   flow_reply（session / http / local / 找不到 run）、flow_send_message 省略 runId、
 *   HTTP 路由的 401 / 400 / 200 与 GET 列表、一个节点一个会话、dispose 收口、
 *   没有 agents 服务的降级、工具输出 lossless。
 */

import assert from 'node:assert/strict'
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-inbox-'))
process.env.DSH_HOME = home

const store = await import('../src/store.js')
const runstore = await import('../src/runstore.js')
const { createEngine, buildPrompt, parseAssistantStructured } = await import('../src/engine.js')
const { createFlowTools } = await import('../src/tools.js')
const { apply } = await import('../src/index.js')
const {
  buildPromptInboxSection, deliverInboundMessage, entryStageNodeId, resolveTargetNode,
  selectPromptMessages, validateInboundBody,
} = await import('../src/inbox.js')
const {
  INBOX_EVENT_KINDS, MESSAGE_TEXT_MAX_CHARS, normalizeEvent,
} = await import('../src/runlog.js')

const flowsRoot = store.flowsDir(home)
const runsRoot = runstore.runsDir(home)
const FIXED_TS = '2026-11-06T00:00:00.000Z'

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

const toolOutputs = []

// ── 流程模板 / run / 假服务 ────────────────────────────────────────────────

function nodeBase(id, kind, title, x) {
  return {
    id, kind, title, x, y: 200, mode: 'single', role: `${title}角色`, task: `${title}的任务`,
    outputs: '', skills: [], maxRounds: 2, team: [], model: '',
  }
}

function makeFlow(id, name, stages, rejects = []) {
  const nodes = [nodeBase('n_start', 'start', '任务输入', 0)]
  const edges = []
  let prev = 'n_start'
  stages.forEach((stage, index) => {
    nodes.push(nodeBase(stage.id, 'stage', stage.title, (index + 1) * 200))
    edges.push({ id: `e${index}`, from: prev, to: stage.id, kind: 'next', label: '' })
    prev = stage.id
  })
  nodes.push(nodeBase('n_end', 'end', '完成', (stages.length + 1) * 200))
  edges.push({ id: 'e_end', from: prev, to: 'n_end', kind: 'next', label: '' })
  for (const [index, [from, to]] of rejects.entries()) {
    edges.push({ id: `er${index}`, from, to, kind: 'reject', label: '打回' })
  }
  return {
    schemaVersion: 1, id, name, description: '', createdAt: FIXED_TS, updatedAt: FIXED_TS,
    nodes, edges,
  }
}

async function saveFlow(id, stages, rejects) {
  const flow = makeFlow(id, `流程 ${id}`, stages, rejects)
  await store.saveFlow(flowsRoot, id, flow)
  return flow
}

async function makeRun(flowId, nodeTotal, name = '收件箱测试 run') {
  return runstore.createRun(runsRoot, { flowId, flowName: `流程 ${flowId}`, name, nodeTotal })
}

function passOf(nodeId, extra = {}) {
  return {
    structured: { verdict: 'pass', summary: `${nodeId} 通过`, findings: [], ...extra },
    sessionId: `sess-${nodeId}`,
    async dispose() {},
  }
}

function rejectOf(nodeId, target) {
  return {
    structured: {
      verdict: 'reject', summary: `${nodeId} 打回`, rejectTarget: target, rejectReason: '请返工',
      findings: [],
    },
    sessionId: `sess-${nodeId}`,
    async dispose() {},
  }
}

/** 伪造 agents 服务：get 走内存表，resume 记录调用。 */
function makeAgents({ sessions = new Map(), onFollowup = () => {} } = {}) {
  const follows = []
  const resumes = []
  return {
    follows,
    resumes,
    sessions,
    get(sessionId) {
      return sessions.get(sessionId)
    },
    roots() {
      return [{ id: 'agent-root' }]
    },
    async resume(options) {
      resumes.push(options)
      const agent = sessions.get(options.resumeSessionId)
      return agent ? { agent, resumed: true } : { agent: null }
    },
    onFollowup,
  }
}

/** 需要「引擎在 followup 后能读到结构化输出」时用的假 agent。 */
function makeReplyAgent(sessionId, structured, sink) {
  return {
    session: { id: sessionId },
    followup(payload) {
      sink.follows.push({ sessionId, payload })
      // 模拟宿主 session/event：assistant 消息里带 JSON。
      sink.engine.handleSessionEvent({ id: sessionId }, {
        type: 'assistant/message',
        data: { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(structured) }] } },
      })
    },
    async whenIdle() {},
  }
}

function makeCtxWithAgents(agents) {
  return {
    get(name) {
      if (name === 'agents') return agents
      return undefined
    },
    on() {
      return () => {}
    },
  }
}

// ── 测试主体 ──────────────────────────────────────────────────────────────

try {
  console.log('inbox.js · §16 事件 / 存储 / 路由')

  // 1. 事件归一化与有界截断 ────────────────────────────────────────────────
  await check('message/in、message/out：白名单归一化、未知字段丢弃、正文截断到 2000', () => {
    A.ok(INBOX_EVENT_KINDS.includes('message/in'))
    A.ok(INBOX_EVENT_KINDS.includes('message/out'))
    const inbound = normalizeEvent({
      v: 1,
      kind: 'message/in',
      runId: 'r-inbox',
      traceId: 'tr-1',
      data: {
        id: 'm-1', from: 'owner', text: 'x'.repeat(MESSAGE_TEXT_MAX_CHARS + 50),
        targetNodeId: 'n_a', replyKind: 'http', bogus: 'should-drop',
      },
    }, { runId: 'r-inbox' })
    A.equal(inbound.ok, true)
    A.equal(Array.from(inbound.event.data.text).length, MESSAGE_TEXT_MAX_CHARS)
    A.equal(inbound.event.data.bogus, undefined)
    A.equal(inbound.event.nodeId, undefined, 'message/* 是 run 级事件，不带 top-level nodeId')

    const outbound = normalizeEvent({
      v: 1,
      kind: 'message/out',
      runId: 'r-inbox',
      traceId: 'tr-1',
      data: { id: 'o-1', inReplyTo: 'm-1', text: 'pong', nodeId: 'n_a', delivery: 'session', extraField: 1 },
    }, { runId: 'r-inbox' })
    A.equal(outbound.ok, true)
    A.equal(outbound.event.data.delivery, 'session')
    A.equal(outbound.event.data.extraField, undefined)

    const badDelivery = normalizeEvent({
      v: 1, kind: 'message/out', runId: 'r-inbox', traceId: 'tr-1',
      data: { id: 'o-2', text: 'x', delivery: 'email' },
    }, { runId: 'r-inbox' })
    A.equal(badDelivery.ok, false)
    A.match(badDelivery.reason, /session \/ http \/ local/)
  })

  // 2. messages.jsonl 追加 / 合并 / 顺序 / 分页 ──────────────────────────────
  await check('messages.jsonl：完整记录 + 状态补丁按 id 合并，按 ts 升序，limit 取最近 N 条', async () => {
    const flow = await saveFlow('flow-store', [{ id: 'n_a', title: '需求' }])
    const run = await makeRun(flow.id, 1)
    await runstore.appendRunMessages(runsRoot, run.id, [
      { id: 'm-1', direction: 'in', from: 'u1', text: '第一', ts: '2026-11-06T00:00:01.000Z', status: 'pending' },
      { id: 'm-2', direction: 'in', from: 'u2', text: '第二', ts: '2026-11-06T00:00:02.000Z', status: 'pending' },
      { id: 'o-1', direction: 'out', from: '节点', text: '回复', ts: '2026-11-06T00:00:03.000Z', delivery: 'local' },
    ])
    await runstore.updateRunMessageStatus(runsRoot, run.id, 'm-1', 'delivered', {
      deliveredAt: '2026-11-06T00:00:04.000Z', deliveredByNodeId: 'n_a',
    })
    const listed = await runstore.readRunMessages(runsRoot, run.id, { limit: 10 })
    A.equal(listed.total, 3)
    A.deepEqual(listed.messages.map(item => item.id), ['m-1', 'm-2', 'o-1'])
    A.equal(listed.messages[0].status, 'delivered')
    A.equal(listed.messages[0].deliveredByNodeId, 'n_a')
    const limited = await runstore.readRunMessages(runsRoot, run.id, { limit: 2 })
    A.deepEqual(limited.messages.map(item => item.id), ['m-2', 'o-1'])
    A.equal(limited.truncated, true)

    // 坏行不影响读取。
    writeFileSync(join(runsRoot, run.id, 'messages.jsonl'), `not-json\n${readFileSync(join(runsRoot, run.id, 'messages.jsonl'), 'utf8')}`)
    const messy = await runstore.readRunMessages(runsRoot, run.id, { limit: 10 })
    A.equal(messy.messages.length, 3)
    A.ok(messy.skipped >= 1)
  })

  // 3. 目标节点三路解析 ────────────────────────────────────────────────────
  await check('目标节点解析：显式 nodeId / 运行中当前节点 / pending 入口节点；非阶段节点拒绝', async () => {
    const flow = makeFlow('flow-target', '目标解析', [
      { id: 'n_a', title: '需求' }, { id: 'n_b', title: '开发' },
    ])
    A.equal(entryStageNodeId(flow), 'n_a')
    const explicit = resolveTargetNode({ flow, meta: { status: 'running' }, explicitNodeId: 'n_b' })
    A.equal(explicit.ok, true)
    A.equal(explicit.via, 'explicit')
    A.equal(explicit.nodeId, 'n_b')
    const current = resolveTargetNode({
      flow, meta: { status: 'running', live: { currentNodeId: 'n_b' } },
    })
    A.equal(current.via, 'current')
    A.equal(current.nodeId, 'n_b')
    const entry = resolveTargetNode({ flow, meta: { status: 'pending', started: false } })
    A.equal(entry.via, 'entry')
    A.equal(entry.nodeId, 'n_a')
    const bad = resolveTargetNode({ flow, meta: {}, explicitNodeId: 'n_start' })
    A.equal(bad.ok, false)
    A.match(bad.error, /不是阶段节点/)
    A.equal(validateInboundBody({ from: 'u', text: 'x', nodeId: 'n_start' }).ok, true)
  })

  // 4. 活会话注入 ──────────────────────────────────────────────────────────
  await check('活会话：agents.get 命中 → followup 立即注入，mode=injected', async () => {
    const flow = await saveFlow('flow-live', [{ id: 'n_a', title: '需求' }])
    const run = await makeRun(flow.id, 1)
    await runstore.upsertNodeSession(runsRoot, run.id, 'n_a', 'sess-live')
    const delivered = []
    const agents = makeAgents({
      sessions: new Map([['sess-live', {
        session: { id: 'sess-live' },
        followup(payload) { delivered.push(payload) },
        async whenIdle() {},
      }]]),
    })
    const result = await deliverInboundMessage({
      runsRoot, flowsRoot, engine: null, ctx: makeCtxWithAgents(agents),
    }, run.id, { from: 'owner', text: '追加一条需求', nodeId: 'n_a' })
    A.equal(result.mode, 'injected')
    A.equal(result.sessionId, 'sess-live')
    A.equal(delivered.length, 1)
    A.ok(delivered[0].content[0].text.includes('追加一条需求'))
    A.equal(delivered[0].role, 'user')
    const listed = await runstore.readRunMessages(runsRoot, run.id)
    A.equal(listed.messages[0].status, 'injected')
    const events = await runstore.readAllEvents(runsRoot, run.id)
    A.ok(events.events.some(event => event.kind === 'message/in' && event.data.id === result.messageId))
  })

  // 5. 冷会话 resume 注入 ──────────────────────────────────────────────────
  await check('冷会话：agents.get 拿不到 → resume({resumeSessionId}) 后 followup，mode=resumed', async () => {
    const flow = await saveFlow('flow-cold', [{ id: 'n_a', title: '需求' }])
    const run = await makeRun(flow.id, 1)
    await runstore.upsertNodeSession(runsRoot, run.id, 'n_a', 'sess-cold')
    const follows = []
    const agents = makeAgents({
      sessions: new Map([['sess-cold', {
        session: { id: 'sess-cold' },
        followup(payload) { follows.push(payload) },
        async whenIdle() {},
      }]]),
    })
    // get 拿不到（模拟会话已冷），但 resume 能恢复。
    agents.get = () => undefined
    const result = await deliverInboundMessage({
      runsRoot, flowsRoot, engine: null, ctx: makeCtxWithAgents(agents),
    }, run.id, { from: 'owner', text: '冷会话也要收到', nodeId: 'n_a' })
    A.equal(result.mode, 'resumed')
    A.equal(agents.resumes.length, 1)
    A.equal(agents.resumes[0].resumeSessionId, 'sess-cold')
    A.equal(follows.length, 1)
    A.ok(follows[0].content[0].text.includes('冷会话也要收到'))
    const listed = await runstore.readRunMessages(runsRoot, run.id)
    A.equal(listed.messages[0].status, 'resumed')
  })

  // 6. 未开始 → 启动输入 ───────────────────────────────────────────────────
  await check('pending run + 无会话：消息写进 run.json.input，engine.start 的入口提示词包含正文', async () => {
    const flow = await saveFlow('flow-start-input', [{ id: 'n_a', title: '需求' }])
    const run = await makeRun(flow.id, 1)
    const hit = await deliverInboundMessage({
      runsRoot, flowsRoot, engine: null,
    }, run.id, { from: 'owner', text: '启动前就发来的需求', nodeId: 'n_a' })
    A.equal(hit.mode, 'started')
    const meta = await runstore.readRunMeta(runsRoot, run.id)
    A.equal(meta.input.messages.length, 1)
    A.ok(meta.input.messages[0].text.includes('启动前就发来的需求'))

    let captured = null
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      ctx: makeCtxWithAgents(makeAgents()),
      activate: async ({ prompt }) => { captured = prompt; return passOf('n_a') },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    A.ok(captured.includes('## 外部消息'))
    A.ok(captured.includes('启动前就发来的需求'))
  })

  // 7. 运行中未到 → 入队 → 推进时并入并标 delivered ────────────────────────
  await check('运行中但目标节点未到：先 queued，引擎推进到该节点时并入提示词并标 delivered', async () => {
    const flow = await saveFlow('flow-queued', [
      { id: 'n_a', title: '需求' }, { id: 'n_b', title: '开发' },
    ])
    const run = await makeRun(flow.id, 2)
    let enterA
    const enteredA = new Promise(done => { enterA = done })
    let releaseA
    const gate = new Promise(done => { releaseA = done })
    const prompts = {}
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      ctx: makeCtxWithAgents(makeAgents()),
      activate: async ({ node, prompt }) => {
        prompts[node.id] = prompt
        if (node.id === 'n_a') {
          enterA()
          await gate
        }
        return passOf(node.id)
      },
    })
    await engine.start(run.id)
    await enteredA
    const queued = await deliverInboundMessage({
      runsRoot, flowsRoot, engine, ctx: makeCtxWithAgents(makeAgents()),
    }, run.id, { from: 'owner', text: '开发阶段请兼容旧接口', nodeId: 'n_b' })
    A.equal(queued.mode, 'queued')
    const before = await runstore.readRunMessages(runsRoot, run.id)
    A.equal(before.messages.find(item => item.id === queued.messageId).status, 'pending')
    releaseA()
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    A.ok(prompts.n_b.includes('开发阶段请兼容旧接口'))
    A.ok(prompts.n_b.includes('## 外部消息'))
    const after = await runstore.readRunMessages(runsRoot, run.id)
    A.equal(after.messages.find(item => item.id === queued.messageId).status, 'delivered')
  })

  // 8. 提示词「外部消息」段：下游可见 + 有界 ────────────────────────────────
  await check('外部消息段：入口消息在后续节点可见；最多 5 条、单条 ≤1200 字', async () => {
    const flow = await saveFlow('flow-downstream', [
      { id: 'n_a', title: '需求' }, { id: 'n_b', title: '开发' },
    ])
    const run = await makeRun(flow.id, 2)
    await runstore.appendRunMessages(runsRoot, run.id, [{
      id: 'm-seed', direction: 'in', from: 'owner', text: '这条入口消息要一直往下流',
      targetNodeId: 'n_a', status: 'pending',
    }])
    const prompts = {}
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      ctx: makeCtxWithAgents(makeAgents()),
      activate: async ({ node, prompt }) => {
        prompts[node.id] = prompt
        return passOf(node.id)
      },
    })
    await engine.start(run.id)
    await engine.wait(run.id)
    A.ok(prompts.n_a.includes('这条入口消息要一直往下流'))
    A.ok(prompts.n_b.includes('这条入口消息要一直往下流'), '入口消息必须继续出现在下游节点')
    A.match(prompts.n_b, /来自流程收件箱/)

    const fresh = Array.from({ length: 7 }, (_, index) => ({
      from: `u${index}`, ts: `2026-11-06T00:00:0${index}.000Z`, text: '甲'.repeat(2000),
    }))
    const prior = Array.from({ length: 7 }, (_, index) => ({
      from: `p${index}`, ts: `2026-11-06T00:01:0${index}.000Z`, text: '乙'.repeat(2000),
    }))
    const section = buildPromptInboxSection({ fresh, prior })
    A.equal(section.split('\n').filter(line => line.startsWith('- [')).length, 10)
    A.ok(section.includes('甲'.repeat(1199)))
    A.ok(!section.includes('甲'.repeat(1200)))
    const selected = selectPromptMessages(
      Array.from({ length: 9 }, (_, index) => ({
        id: `m${index}`, direction: 'in', status: 'pending', targetNodeId: 'n_x', text: 'x',
      })),
      'n_x',
    )
    A.equal(selected.fresh.length, 5)
  })

  // 9. flow_reply：session / http / local / 找不到 run ─────────────────────
  await check('flow_reply：session 投递带来源标记、http 用假 fetch、未配置只记事件、找不到 run 失败', async () => {
    const flow = await saveFlow('flow-reply', [{ id: 'n_a', title: '需求分析' }])
    const run = await makeRun(flow.id, 1)
    await runstore.upsertNodeSession(runsRoot, run.id, 'n_a', 'sess-node')
    await runstore.appendRunMessages(runsRoot, run.id, [
      {
        id: 'm-session', direction: 'in', from: 'owner', text: '请回我', targetNodeId: 'n_a',
        status: 'injected', reply: { kind: 'session', sessionId: 'sess-owner' },
      },
      {
        id: 'm-http', direction: 'in', from: 'owner', text: '走 HTTP', targetNodeId: 'n_a',
        status: 'injected', reply: { kind: 'http', url: 'https://example.test/hook', tokenEnv: 'INBOX_TEST_TOKEN' },
      },
    ])
    const sessionAgent = {
      session: { id: 'sess-owner' },
      followup(payload) { this.payload = payload },
      async whenIdle() {},
    }
    const agents = makeAgents({ sessions: new Map([['sess-owner', sessionAgent]]) })
    const engine = {
      async start() {},
      async stop() {},
      async resolveSessionOwner(sessionId) {
        return sessionId === 'sess-node' ? { runId: run.id, nodeId: 'n_a' } : null
      },
      runForSession() { return run.id },
    }
    const tools = createFlowTools({
      flowsRoot, runsRoot, engine, ctx: makeCtxWithAgents(agents),
    })
    A.equal(tools.length, 6)
    const reply = tools.find(tool => tool.name === 'flow_reply')
    const send = tools.find(tool => tool.name === 'flow_send_message')
    A.ok(reply && send)

    const exec = { agent: { session: { id: 'sess-node' } }, signal: undefined }
    const sessionResult = await reply.execute({ text: '收到，马上处理', inReplyTo: 'm-session' }, exec)
    toolOutputs.push(sessionResult)
    A.equal(sessionResult.ok, true)
    A.equal(sessionResult.delivery, 'session')
    A.ok(sessionAgent.payload.content[0].text.includes('[flow:流程 flow-reply · 需求分析]'))
    A.ok(sessionAgent.payload.content[0].text.includes('收到，马上处理'))

    const originalFetch = globalThis.fetch
    const originalToken = process.env.INBOX_TEST_TOKEN
    process.env.INBOX_TEST_TOKEN = 'hook-secret-token'
    const httpCalls = []
    globalThis.fetch = async (url, init) => {
      httpCalls.push({ url, init })
      return { ok: true, status: 200, text: async () => 'ok' }
    }
    try {
      const httpResult = await reply.execute({ text: 'HTTP 回调', inReplyTo: 'm-http' }, exec)
      toolOutputs.push(httpResult)
      A.equal(httpResult.ok, true)
      A.equal(httpResult.delivery, 'http')
      A.equal(httpCalls.length, 1)
      A.equal(httpCalls[0].url, 'https://example.test/hook')
      A.equal(httpCalls[0].init.headers.authorization, 'Bearer hook-secret-token')
      const body = JSON.parse(httpCalls[0].init.body)
      A.equal(body.runId, run.id)
      A.equal(body.nodeId, 'n_a')
      A.ok(body.text.includes('[flow:'))
    } finally {
      globalThis.fetch = originalFetch
      if (originalToken === undefined) delete process.env.INBOX_TEST_TOKEN
      else process.env.INBOX_TEST_TOKEN = originalToken
    }

    const localResult = await reply.execute({ text: '没有外部通道也得记' }, exec)
    toolOutputs.push(localResult)
    A.equal(localResult.ok, true)
    A.equal(localResult.delivery, 'local')
    A.match(localResult.hint, /没有外部回复通道/)

    const events = await runstore.readAllEvents(runsRoot, run.id)
    const outEvents = events.events.filter(event => event.kind === 'message/out')
    A.ok(outEvents.length >= 3)
    A.ok(outEvents.every(event => ['session', 'http', 'local'].includes(event.data.delivery)))

    // run 级 inbox.reply（没有 inReplyTo 时回落到这里）。
    await runstore.writeRunInbox(runsRoot, run.id, { kind: 'session', sessionId: 'sess-owner' })
    const runLevel = await reply.execute({ text: 'run 级回复' }, exec)
    toolOutputs.push(runLevel)
    A.equal(runLevel.ok, true)
    A.equal(runLevel.delivery, 'session')

    const unknown = await reply.execute({ text: 'x' }, { agent: { session: { id: 'sess-stranger' } } })
    A.equal(unknown.ok, false)
    A.match(unknown.hint, /这个会话不属于任何流程 run/)
  })

  // 10. flow_send_message 省略 runId ──────────────────────────────────────
  await check('flow_send_message：省略 runId 时取当前会话启动的最新 run，并走与 HTTP 相同的投递逻辑', async () => {
    const flow = await saveFlow('flow-tool-send', [{ id: 'n_a', title: '需求' }])
    const run = await makeRun(flow.id, 1)
    const agents = makeAgents()
    const engine = {
      async start() {},
      async stop() {},
      runForSession(sessionId) { return sessionId === 'session-owner' ? run.id : null },
      sessionIdForNode() { return null },
      async resolveSessionOwner() { return null },
    }
    const tools = createFlowTools({ flowsRoot, runsRoot, engine, ctx: makeCtxWithAgents(agents) })
    const send = tools.find(tool => tool.name === 'flow_send_message')
    const result = await send.execute(
      { text: '从工具发进流程的消息' },
      { agent: { session: { id: 'session-owner' } } },
    )
    toolOutputs.push(result)
    A.equal(result.ok, true)
    A.equal(result.runId, run.id)
    A.equal(result.mode, 'started')
    const meta = await runstore.readRunMeta(runsRoot, run.id)
    A.ok(meta.input.messages.some(item => item.text.includes('从工具发进流程的消息')))
  })

  // 11. HTTP 路由：401 / 400 / 200 + GET 列表 ─────────────────────────────
  await check('HTTP：无凭据 401、缺 from/text 400、非阶段节点 400、正常 200、GET 列表、POST inbox', async () => {
    const flow = await saveFlow('flow-http', [{ id: 'n_a', title: '需求' }])
    const run = await makeRun(flow.id, 1)
    process.env.FLOW_STUDIO_TOKEN = 'inbox-test-token-0123456789'
    const routes = []
    const ctx = {
      webServer: { register(route) { routes.push(route); return () => {} } },
      effect(fn) { return fn() },
      logger: { warn() {}, error() {}, info() {} },
      get(name) {
        if (name === 'connection') return { requestRejection: () => undefined }
        return undefined
      },
    }
    try {
      apply(ctx)
      const route = routes[0]
      const call = (method, url, body, headers = {}) => new Promise(resolveCall => {
        const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
        const req = Readable.from(payload)
        req.method = method
        req.url = url
        req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', ...headers }
        req.socket = { remoteAddress: '127.0.0.1' }
        const res = {
          statusCode: 0, body: '', headersSent: false,
          writeHead(code) { this.statusCode = code; this.headersSent = true; return this },
          end(chunk) {
            if (chunk) this.body += String(chunk)
            let json = null
            try { json = JSON.parse(this.body) } catch { json = null }
            resolveCall({ status: this.statusCode, json, body: this.body })
          },
        }
        void route.handler(req, res)
      })
      const auth = { authorization: 'Bearer inbox-test-token-0123456789' }
      const base = `/api/flow-studio/runs/${run.id}`

      const noAuth = await call('GET', '/api/flow-studio/runs')
      A.equal(noAuth.status, 401)
      const missingFrom = await call('POST', `${base}/messages`, { text: 'x' }, auth)
      A.equal(missingFrom.status, 400)
      const missingText = await call('POST', `${base}/messages`, { from: 'owner' }, auth)
      A.equal(missingText.status, 400)
      const notStage = await call('POST', `${base}/messages`, { from: 'owner', text: 'x', nodeId: 'n_start' }, auth)
      A.equal(notStage.status, 400)
      const success = await call('POST', `${base}/messages`, { from: 'owner', text: 'HTTP 正常投递' }, auth)
      A.equal(success.status, 200)
      A.equal(success.json.mode, 'started')
      const list = await call('GET', `${base}/messages?limit=10`, undefined, auth)
      A.equal(list.status, 200)
      A.ok(Array.isArray(list.json.messages) && list.json.messages.length >= 1)

      const inbox = await call('POST', `${base}/inbox`, {
        reply: { kind: 'http', url: 'https://example.test/cb', tokenEnv: 'CB_TOKEN' },
      }, auth)
      A.equal(inbox.status, 200)
      A.equal(inbox.json.inbox.reply.kind, 'http')
      const meta = await runstore.readRunMeta(runsRoot, run.id)
      A.equal(meta.inbox.reply.tokenEnv, 'CB_TOKEN')
      const badInbox = await call('POST', `${base}/inbox`, {
        reply: { kind: 'http', url: 'ftp://example.test/cb' },
      }, auth)
      A.equal(badInbox.status, 400)
    } finally {
      delete process.env.FLOW_STUDIO_TOKEN
    }
  })

  // 12. 一个节点一个会话 ──────────────────────────────────────────────────
  await check('一个节点一个会话：打回重跑时 startActivation 只按节点各调一次，二次激活走 followup', async () => {
    const flow = await saveFlow('flow-one-session', [
      { id: 'n_a', title: '需求' }, { id: 'n_b', title: '评审' },
    ], [['n_b', 'n_a']])
    const run = await makeRun(flow.id, 2)
    const activations = []
    const disposed = []
    let engine = null
    const follows = []
    const agents = makeAgents()
    agents.sessions.set('sess-n_a', makeReplyAgent('sess-n_a', { verdict: 'pass', summary: '返工后通过' }, {
      follows,
      get engine() { return engine },
    }))
    agents.sessions.set('sess-n_b', makeReplyAgent('sess-n_b', { verdict: 'pass', summary: '评审通过' }, {
      follows,
      get engine() { return engine },
    }))
    const ctx = {
      get(name) {
        if (name === 'agents') return agents
        if (name === 'subagents') {
          return {
            async startActivation(spec) {
              const label = spec.label
              activations.push(label)
              const isB = label.includes('/n_b#')
              return {
                childId: isB ? 'sess-n_b' : 'sess-n_a',
                result: Promise.resolve({
                  structured: isB
                    ? { verdict: 'reject', summary: '先打回', rejectTarget: 'n_a', rejectReason: '返工', findings: [] }
                    : { verdict: 'pass', summary: '首轮通过', findings: [] },
                  output: [],
                  stopReason: 'completed',
                }),
                async dispose() { disposed.push(label) },
              }
            },
          }
        }
        return undefined
      },
      on() { return () => {} },
    }
    engine = createEngine({ runsRoot, flowsRoot, ctx })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    A.equal(activations.length, 2, '两个节点各只应启动一次会话')
    A.equal(follows.length, 2, '打回后的 n_a 与之后的 n_b 都走 followup')
    A.equal(agents.resumes.length, 0, '活会话不应 resume')
    A.equal(disposed.length, 2, 'run 结束统一 dispose 两个会话')
    const sessions = await runstore.readNodeSessions(runsRoot, run.id)
    A.equal(sessions.n_a.sessionId, 'sess-n_a')
    A.equal(sessions.n_b.sessionId, 'sess-n_b')
    const events = await runstore.readAllEvents(runsRoot, run.id)
    const nodeStarts = events.events.filter(event => event.kind === 'node/start')
    A.ok(nodeStarts.some(event => event.nodeId === 'n_a' && event.attemptId === 2))
  })

  // 13. sessions.json 原子写与坏文件容错 ─────────────────────────────────
  await check('sessions.json：原子写 / 0600 / upsert 保留 createdAt / 坏文件不抛错', async () => {
    const flow = await saveFlow('flow-sessions', [{ id: 'n_a', title: '需求' }])
    const run = await makeRun(flow.id, 1)
    await runstore.upsertNodeSession(runsRoot, run.id, 'n_a', 'sess-1', {
      now: new Date('2026-11-06T00:00:00.000Z'),
    })
    const path = join(runsRoot, run.id, 'sessions.json')
    A.equal(statSync(path).mode & 0o777, 0o600)
    const first = JSON.parse(readFileSync(path, 'utf8'))
    A.equal(first.n_a.sessionId, 'sess-1')
    await runstore.upsertNodeSession(runsRoot, run.id, 'n_a', 'sess-1', {
      now: new Date('2026-11-06T00:10:00.000Z'),
    })
    const second = await runstore.readNodeSessions(runsRoot, run.id)
    A.equal(second.n_a.createdAt, first.n_a.createdAt)
    A.equal(second.n_a.lastUsedAt, '2026-11-06T00:10:00.000Z')

    writeFileSync(path, '{ 坏掉的 JSON')
    const fallback = await runstore.readNodeSessions(runsRoot, run.id)
    A.deepEqual(fallback, {})
    writeFileSync(path, JSON.stringify({ n_a: { sessionId: 42 }, '../evil': { sessionId: 'x' } }))
    A.deepEqual(await runstore.readNodeSessions(runsRoot, run.id), {})
  })

  // 14. run 结束 dispose 所有会话 ─────────────────────────────────────────
  await check('run 结束 dispose 所有会话（两个节点 → 两次 dispose）', async () => {
    const flow = await saveFlow('flow-dispose', [
      { id: 'n_a', title: '需求' }, { id: 'n_b', title: '开发' },
    ])
    const run = await makeRun(flow.id, 2)
    let disposed = 0
    const ctx = {
      get(name) {
        if (name === 'agents') return { roots: () => [{ id: 'agent-root' }] }
        if (name === 'subagents') {
          return {
            async startActivation(spec) {
              return {
                childId: `sess-${spec.label}`,
                result: Promise.resolve({
                  structured: { verdict: 'pass', summary: 'ok', findings: [] },
                  output: [],
                  stopReason: 'completed',
                }),
                async dispose() { disposed += 1 },
              }
            },
          }
        }
        return undefined
      },
      on() { return () => {} },
    }
    const engine = createEngine({ runsRoot, flowsRoot, ctx })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    A.equal(disposed, 2)

    // stop 也走同一条收口：n_a 的会话句柄在 run 中止时被 dispose。
    const stopRun = await makeRun(flow.id, 2, 'stop 收口测试')
    let signalSecond
    const secondStarted = new Promise(done => { signalSecond = done })
    let stoppedDisposed = 0
    const stopCtx = {
      get(name) {
        if (name === 'agents') return { roots: () => [{ id: 'agent-root' }] }
        if (name === 'subagents') {
          return {
            async startActivation(spec) {
              const second = spec.label.includes('/n_b#')
              if (second) signalSecond()
              return {
                childId: `sess-stop-${spec.label}`,
                // n_b 的结果永不落地，等待 stop 中断。
                result: second ? new Promise(() => {}) : Promise.resolve({
                  structured: { verdict: 'pass', summary: 'ok', findings: [] },
                  output: [],
                  stopReason: 'completed',
                }),
                async dispose() { stoppedDisposed += 1 },
              }
            },
          }
        }
        return undefined
      },
      on() { return () => {} },
    }
    const stopEngine = createEngine({ runsRoot, flowsRoot, ctx: stopCtx })
    await stopEngine.start(stopRun.id)
    await secondStarted
    const stopped = await stopEngine.stop(stopRun.id)
    A.equal(stopped.status, 'aborted')
    A.ok(stoppedDisposed >= 1, 'stop 后已登记的会话句柄必须被 dispose')
  })

  // 15. 没有 agents 服务时退化 ────────────────────────────────────────────
  await check('没有 ctx.agents：退化为每次新会话，仍能跑完，并记一条 warn 日志', async () => {
    const flow = await saveFlow('flow-degrade', [
      { id: 'n_a', title: '需求' }, { id: 'n_b', title: '评审' },
    ], [['n_b', 'n_a']])
    const run = await makeRun(flow.id, 2)
    const logs = []
    let activations = 0
    const engine = createEngine({
      runsRoot,
      flowsRoot,
      ctx: { get() { return undefined }, on() { return () => {} } },
      log: (level, message) => { logs.push({ level, message }) },
      activate: async ({ node, attempt }) => {
        activations += 1
        if (node.id === 'n_b' && attempt === 1) {
          return {
            structured: {
              verdict: 'reject', summary: '打回', rejectTarget: 'n_a', rejectReason: '返工', findings: [],
            },
            sessionId: `sess-${node.id}-${attempt}`,
            async dispose() {},
          }
        }
        return {
          structured: { verdict: 'pass', summary: 'ok', findings: [] },
          sessionId: `sess-${node.id}-${attempt}`,
          async dispose() {},
        }
      },
    })
    await engine.start(run.id)
    const final = await engine.wait(run.id)
    A.equal(final.status, 'done')
    A.ok(activations >= 3, 'n_a 被打回重跑时应再起一次新会话')
    A.ok(logs.some(item => item.level === 'warn' && item.message.includes('缺少 ctx.agents')))
  })

  // 16. 提示词长度仍守 8000 字 ────────────────────────────────────────────
  await check('加入外部消息段后提示词仍 ≤8000 字，且「输出格式」段完整保留', () => {
    const node = nodeBase('n_long', 'stage', '长任务', 100)
    node.task = '任'.repeat(6000)
    const inboxText = Array.from({ length: 5 }, () => buildPromptInboxSection({
      fresh: [{ from: 'owner', ts: FIXED_TS, text: '信'.repeat(2000) }],
    })).join('\n')
    const prompt = buildPrompt({ node, attempt: 1, inboxText })
    A.ok(Array.from(prompt).length <= 8000)
    A.ok(prompt.includes('## 输出格式'))
  })

  // 17. 复用会话的结构化输出解析 ──────────────────────────────────────────
  await check('复用会话解析：纯 JSON / 代码块 / 夹带解释都能取结构化输出；非 JSON 返回 null', () => {
    A.deepEqual(parseAssistantStructured('{"verdict":"pass","summary":"ok"}'), { verdict: 'pass', summary: 'ok' })
    A.deepEqual(
      parseAssistantStructured('说明\n```json\n{"verdict":"reject","rejectReason":"返工"}\n```\n结束'),
      { verdict: 'reject', rejectReason: '返工' },
    )
    A.deepEqual(
      parseAssistantStructured('先说明一下：{"verdict":"pass"} 以上'),
      { verdict: 'pass' },
    )
    A.equal(parseAssistantStructured('没有 JSON'), null)
    A.equal(parseAssistantStructured(''), null)
  })

  // 18. 工具输出 lossless ─────────────────────────────────────────────────
  await check('工具输出 lossless：JSON 往返后完全相等（无 undefined / NaN / Date）', () => {
    A.ok(toolOutputs.length >= 4)
    for (const value of toolOutputs) {
      const roundTrip = JSON.parse(JSON.stringify(value))
      assert.deepEqual(roundTrip, value)
      assertionCount += 1
    }
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`inbox §16 自检：${checks} 组通过（${assertionCount} 条断言）`)
