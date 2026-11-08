#!/usr/bin/env node
/**
 * 流程收件箱「长正文落盘」自检（06 §16）。
 *
 * 背景：旧实现把外部正文按 4000 / 事件 2000 / 提示词 1200 三处静默截断，长消息
 * 的节点只看到头部且**不知道被截断**。现在的口径：
 *   - 正文 ≤ INBOX_SPILL_THRESHOLD_CHARS（1200）→ 全文进提示词，不落盘；
 *   - 正文 > 阈值 → 全文写 `runs/<runId>/inbox/<messageId>.md`，事件 / messages.jsonl
 *     只放头部 + `bodyPath` / `bodyChars`，提示词里给「必须读全文」的显式指针；
 *   - 正文 > MESSAGE_BODY_HARD_MAX_CHARS（200000）→ 400 可读错误，不静默截断；
 *   - 落盘失败 → 消息仍被接收，记 warn 并在返回体里标明「未落盘」。
 *
 * 全部走注入桩：不启动 dsh、不 import 任何 dsh 包；run / flow 模板落在项目 `.tmp/`
 * 下（不占系统 /tmp）。每个 check 独立捕获失败（红→绿证据能一次看全），末行汇总，
 * 有失败就 exit 1。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { writeFile as writeFileAsync } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-inbox-spill-'))
process.env.DSH_HOME = home

const store = await import('../src/store.js')
const runstore = await import('../src/runstore.js')
const runlog = await import('../src/runlog.js')
const { createEngine } = await import('../src/engine.js')
const inbox = await import('../src/inbox.js')

const flowsRoot = store.flowsDir(home)
const runsRoot = runstore.runsDir(home)
const FIXED_TS = '2026-11-06T00:00:00.000Z'

// ── 迷你断言 / 独立 check ───────────────────────────────────────────────────

let passed = 0
let failed = 0
const redLines = []

function eq(actual, expected, message) {
  assert.equal(actual, expected, message)
}
function ok(value, message) {
  assert.ok(value, message)
}

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    const reason = error && error.message ? error.message : String(error)
    redLines.push({ name, reason })
    console.log(`  ✗ ${name}\n      ${reason.split('\n')[0]}`)
  }
}

// ── 流程 / run 夹具（与 test/inbox.test.mjs 同口径）─────────────────────────

function nodeBase(id, kind, title, x) {
  return {
    id, kind, title, x, y: 200, mode: 'single', role: `${title}角色`, task: `${title}的任务`,
    outputs: '', skills: [], maxRounds: 2, team: [], model: '',
  }
}

function makeFlow(id, name, stages) {
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
  return {
    schemaVersion: 1, id, name, description: '', createdAt: FIXED_TS, updatedAt: FIXED_TS,
    nodes, edges,
  }
}

async function saveFlow(id, stages) {
  const flow = makeFlow(id, `流程 ${id}`, stages)
  await store.saveFlow(flowsRoot, id, flow)
  return flow
}

async function makeRun(flowId, nodeTotal) {
  return runstore.createRun(runsRoot, {
    flowId, flowName: `流程 ${flowId}`, name: '收件箱落盘测试 run', nodeTotal,
  })
}

const workspace = mkdtempSync(join(repoRoot, '.tmp', 'ws-inbox-spill-'))

function makeEngine(options = {}) {
  return createEngine({ cwd: workspace, ...options })
}

function passOf(nodeId) {
  return {
    structured: { verdict: 'pass', summary: `${nodeId} 通过`, findings: [] },
    sessionId: `sess-${nodeId}`,
    async dispose() {},
  }
}

function makeAgents() {
  return {
    get() {
      return undefined
    },
    roots() {
      return [{ id: 'agent-root' }]
    },
    async resume() {
      return { agent: null }
    },
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

/** 跑一次引擎并捕获入口节点的提示词。 */
async function promptOf(run, nodeId = 'n_a') {
  let captured = null
  const engine = makeEngine({
    runsRoot,
    flowsRoot,
    ctx: makeCtxWithAgents(makeAgents()),
    activate: async ({ prompt }) => {
      captured = prompt
      return passOf(nodeId)
    },
  })
  await engine.start(run.id)
  const final = await engine.wait(run.id)
  eq(final.status, 'done', '引擎应正常跑完')
  ok(captured !== null, '入口节点应被激活并拿到提示词')
  return captured
}

try {
  // 1. 长消息（5000 字）全量可达 ──────────────────────────────────────────
  await check('长消息 5000 字：全文落盘逐字一致、事件只放头部、提示词带显式指针', async () => {
    const flow = await saveFlow('flow-spill', [{ id: 'n_a', title: '设计' }])
    const run = await makeRun(flow.id, 1)
    const original = '设计'.repeat(2500)
    eq(Array.from(original).length, 5000)

    const result = await inbox.deliverInboundMessage({ runsRoot, flowsRoot }, run.id, {
      from: 'owner', text: original, nodeId: 'n_a',
    })
    eq(result.mode, 'started')
    ok(result.bodyPath, '返回体应带 bodyPath（全文落盘）')
    eq(result.bodyPath, `inbox/${result.messageId}.md`)
    eq(result.bodyChars, 5000)

    const abs = join(runsRoot, run.id, result.bodyPath)
    ok(existsSync(abs), `全文文件应存在：${abs}`)
    eq(readFileSync(abs, 'utf8'), original, '落盘正文必须逐字等于原文')

    const threshold = Number.isInteger(inbox.INBOX_SPILL_THRESHOLD_CHARS)
      ? inbox.INBOX_SPILL_THRESHOLD_CHARS
      : 1200
    const listed = await runstore.readRunMessages(runsRoot, run.id, { limit: 10 })
    const record = listed.messages.find(item => item.id === result.messageId)
    ok(record, 'messages.jsonl 里应有这条消息')
    eq(record.bodyPath, result.bodyPath, 'messages.jsonl 必须保留 bodyPath')
    eq(record.bodyChars, 5000, 'messages.jsonl 必须保留全文字数')
    eq(Array.from(record.text).length, threshold, 'messages.jsonl 的 text 只放头部')
    ok(original.startsWith(record.text.slice(0, -1)), '头部必须是原文前缀')

    const all = await runstore.readAllEvents(runsRoot, run.id)
    const event = all.events.find(item => item.kind === 'message/in' && item.data.id === result.messageId)
    ok(event, '应有 message/in 事件')
    eq(event.data.bodyPath, result.bodyPath, 'message/in 必须带 bodyPath')
    eq(event.data.bodyChars, 5000, 'message/in 必须带 bodyChars')
    ok(Array.from(event.data.text).length <= 2000, 'message/in.text 仍守 2000 字上限')
    ok(Buffer.byteLength(JSON.stringify(event), 'utf8') < 8192, '事件序列化后仍须 < 8KB')

    const prompt = await promptOf(run)
    ok(prompt.includes(result.bodyPath), '提示词必须包含 bodyPath')
    ok(prompt.includes('必须先用 read 工具读完'), '提示词必须明确要求读全文')
    ok(prompt.includes('正文共 5000 字'), '提示词必须给出全文字数')
  })

  // 2. 短消息不变 ─────────────────────────────────────────────────────────
  await check('短消息 1200 字：不落盘、text 全文进提示词、无 bodyPath', async () => {
    const flow = await saveFlow('flow-short', [{ id: 'n_a', title: '需求' }])
    const run = await makeRun(flow.id, 1)
    const text = '短'.repeat(1200)

    const result = await inbox.deliverInboundMessage({ runsRoot, flowsRoot }, run.id, {
      from: 'owner', text, nodeId: 'n_a',
    })
    eq(result.mode, 'started')
    eq(result.bodyPath, undefined, '短消息不该落盘')
    ok(!existsSync(join(runsRoot, run.id, 'inbox')), '短消息不该创建 inbox 目录')

    const meta = await runstore.readRunMeta(runsRoot, run.id)
    eq(meta.input.messages[0].text, text, 'run.json.input.messages 应保留全文')
    eq(meta.input.messages[0].bodyPath, undefined)

    const prompt = await promptOf(run)
    ok(prompt.includes(text), '提示词应包含完整 1200 字正文')
    ok(!prompt.includes('必须先用 read 工具读完'), '短消息不该出现读全文指针')
    ok(!prompt.includes('正文共'), '短消息不该出现全文字数提示')
  })

  // 3. 硬上限 ─────────────────────────────────────────────────────────────
  await check('超过硬上限 200001 字：返回可读 400 错误且不创建 inbox 文件', async () => {
    const flow = await saveFlow('flow-hard-max', [{ id: 'n_a', title: '需求' }])
    const run = await makeRun(flow.id, 1)
    const text = 'x'.repeat(200001)

    let error = null
    try {
      await inbox.deliverInboundMessage({ runsRoot, flowsRoot }, run.id, {
        from: 'owner', text, nodeId: 'n_a',
      })
    } catch (caught) {
      error = caught
    }
    ok(error, '超硬上限应抛错，不能静默接受')
    eq(error.status, 400, '应为 400 可读错误')
    ok(String(error.message).includes('200000'), `错误信息必须含上限数字（实际：${error.message}）`)
    ok(String(error.message).includes('超过上限'), '错误信息必须说明「超过上限」')
    ok(!existsSync(join(runsRoot, run.id, 'inbox')), '超限消息不应创建 inbox 目录或文件')
  })

  // 4. 落盘失败降级 ───────────────────────────────────────────────────────
  await check('落盘失败：消息仍被接收、记 warn、返回体标明未落盘', async () => {
    const flow = await saveFlow('flow-spill-fail', [{ id: 'n_a', title: '需求' }])
    const run = await makeRun(flow.id, 1)
    const original = '失'.repeat(5000)
    const logs = []

    runstore.__setWriteFileHook((path, data, options) => {
      if (String(path).includes(`${sep}inbox${sep}`)) {
        throw Object.assign(new Error('模拟 ENOSPC：inbox 不可写'), { code: 'ENOSPC' })
      }
      return writeFileAsync(path, data, options)
    })
    let result
    try {
      result = await inbox.deliverInboundMessage({
        runsRoot, flowsRoot, log: (level, message) => logs.push({ level, message }),
      }, run.id, { from: 'owner', text: original, nodeId: 'n_a' })
    } finally {
      runstore.__setWriteFileHook(null)
    }

    eq(result.mode, 'started')
    eq(result.bodyPath, undefined, '落盘失败时返回体不能谎报 bodyPath')
    ok(result.bodySpillError && result.bodySpillError.includes('未落盘'),
      '返回体必须标明「未落盘」')
    ok(logs.some(item => item.level === 'warn' && item.message.includes('未落盘')),
      '必须记一条 warn 日志')

    const listed = await runstore.readRunMessages(runsRoot, run.id, { limit: 10 })
    const record = listed.messages.find(item => item.id === result.messageId)
    ok(record, '落盘失败也不能把消息吞掉')
    ok(Array.from(record.text).length > 0, '降级后 text 仍有可读头部')
    ok(Array.from(record.text).length <= 2000, '降级后的头部仍守事件 2000 字上限')

    const meta = await runstore.readRunMeta(runsRoot, run.id)
    ok(meta.input.messages.some(item => item.id === result.messageId),
      'run.json.input.messages 也应保留这条消息')
  })

  // 5. 兼容旧数据 ─────────────────────────────────────────────────────────
  await check('兼容：没有 bodyPath 的旧消息走老路径不报错', async () => {
    const flow = await saveFlow('flow-legacy', [{ id: 'n_a', title: '需求' }])
    const run = await makeRun(flow.id, 1)
    await runstore.appendRunMessages(runsRoot, run.id, [{
      id: 'm-legacy', direction: 'in', from: 'old', text: '旧'.repeat(1500),
      targetNodeId: 'n_a', status: 'pending', ts: FIXED_TS,
    }])

    const listed = await runstore.readRunMessages(runsRoot, run.id, { limit: 10 })
    const record = listed.messages.find(item => item.id === 'm-legacy')
    ok(record, '旧消息应能读回')
    eq(record.bodyPath, undefined)

    const section = inbox.buildPromptInboxSection({ fresh: [record] })
    ok(section.includes('旧'.repeat(100)), '旧消息正文仍进提示词')
    ok(!section.includes('全文在'), '没有 bodyPath 时不该出现全文指针')
    ok(!section.includes('必须先用 read 工具读完'), '没有 bodyPath 时不该要求读全文')

    const prompt = await promptOf(run)
    ok(prompt.includes('旧'.repeat(100)), '引擎提示词也要能看到旧消息')
  })

  // 6. 活会话注入也带指针 ─────────────────────────────────────────────────
  await check('活会话注入：长消息 followup 文本也带全文指针，文件逐字一致', async () => {
    const flow = await saveFlow('flow-live-spill', [{ id: 'n_a', title: '需求' }])
    const run = await makeRun(flow.id, 1)
    await runstore.upsertNodeSession(runsRoot, run.id, 'n_a', 'sess-live-spill')
    const follows = []
    const agents = {
      get(sessionId) {
        if (sessionId !== 'sess-live-spill') return undefined
        return {
          session: { id: sessionId },
          followup(payload) { follows.push(payload) },
          async whenIdle() {},
        }
      },
      async resume() {
        return { agent: null }
      },
    }
    const original = '会'.repeat(5000)
    const result = await inbox.deliverInboundMessage({
      runsRoot, flowsRoot, ctx: makeCtxWithAgents(agents),
    }, run.id, { from: 'owner', text: original, nodeId: 'n_a' })
    eq(result.mode, 'injected')
    eq(follows.length, 1)
    const injected = follows[0].content[0].text
    ok(injected.includes(result.bodyPath), '注入文本必须带 bodyPath')
    ok(injected.includes('必须先用 read 工具读完'), '注入文本必须要求读全文')
    ok(injected.includes('正文共 5000 字'), '注入文本必须给出全文字数')
    eq(readFileSync(join(runsRoot, run.id, result.bodyPath), 'utf8'), original,
      '注入路径的落盘文件也必须逐字一致')
  })

  // 7. 事件 / messages.jsonl 白名单 ─────────────────────────────────────────
  await check('事件白名单放行 bodyPath/bodyChars；非安全路径与越界字数拒绝', () => {
    eq(inbox.MESSAGE_BODY_HARD_MAX_CHARS, runlog.MESSAGE_BODY_CHARS_MAX,
      '两个模块的硬上限必须同值（防漂移）')

    const good = runlog.normalizeEvent({
      v: 1, kind: 'message/in', runId: 'r-body', traceId: 'tr-body',
      data: {
        id: 'm-1', from: 'owner', text: '头部',
        bodyPath: 'inbox/m-1.md', bodyChars: 5000, bogus: 'drop',
      },
    }, { runId: 'r-body' })
    eq(good.ok, true)
    eq(good.event.data.bodyPath, 'inbox/m-1.md')
    eq(good.event.data.bodyChars, 5000)
    eq(good.event.data.bogus, undefined)

    const badPath = runlog.normalizeEvent({
      v: 1, kind: 'message/in', runId: 'r-body', traceId: 'tr-body',
      data: { id: 'm-2', from: 'owner', text: 'x', bodyPath: '../etc/passwd' },
    }, { runId: 'r-body' })
    eq(badPath.ok, false, '穿越路径必须拒绝')
    ok(/inbox\/<文件名>\.md/.test(badPath.reason), `错误信息应说明合法形状（实际：${badPath.reason}）`)

    const badChars = runlog.normalizeEvent({
      v: 1, kind: 'message/in', runId: 'r-body', traceId: 'tr-body',
      data: { id: 'm-3', from: 'owner', text: 'x', bodyPath: 'inbox/m-3.md', bodyChars: 200001 },
    }, { runId: 'r-body' })
    eq(badChars.ok, false, '越界 bodyChars 必须拒绝')
    ok(/200000/.test(badChars.reason), `错误信息应含硬上限（实际：${badChars.reason}）`)
  })
} finally {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\ninbox 长正文落盘自检失败：${failed} 组红 / ${passed} 组绿`)
  for (const line of redLines) console.error(`  - ${line.name}：${line.reason}`)
  process.exitCode = 1
} else {
  console.log(`\ninbox 长正文落盘自检：${passed} 组通过`)
}
