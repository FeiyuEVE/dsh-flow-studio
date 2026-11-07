#!/usr/bin/env node
/**
 * 运行日志纯函数自检：事件校验 / 归一化 / 有界 extra / 聚合口径 / quality 不给绿灯。
 *
 * 不需要浏览器；除「落盘后 readAllEvents 读回」一组用 `.tmp/` 造临时 run 目录外，其余
 * 都是纯函数、不碰 fs：直接 `node test/runlog.test.mjs`。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EVENT_KINDS, MACHINE_EVENT_KINDS, MAX_EVENT_BYTES, MAX_EXTRA_BYTES, checkRunId, collectArtifactIndex,
  computeAcceptance, computeAgentActivity, computeConflicts, computeFindings, computeProgress, computeQuality,
  computeRejects, computeSkillUsage, computeStaleFails, computeTests, computeTokens, isSafeRelPath,
  machineTransitionSummary, normalizeEvent, renderRunMarkdown, summarize, summarizeAcceptance,
} from '../src/runlog.js'
import * as engineModule from '../src/engine.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

/** 需要 await 的检查（落盘 / readAllEvents 往返）：顺序执行，不并发。 */
async function checkAsync(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

const NOW = new Date('2026-11-06T12:00:00.000Z')
const RUN = 'r-2026-abc'
const ctx = { runId: RUN, now: NOW }

function base(over = {}) {
  return {
    v: 1,
    ts: '2026-11-06T10:00:00+08:00',
    kind: 'node/start',
    runId: RUN,
    nodeId: 'n_req',
    attemptId: 1,
    traceId: 'trace-1',
    data: { title: '需求分析', mode: 'single', skills: ['skill-a'] },
    ...over,
  }
}

/** run 级事件（run/start、run/end）不能带节点字段。 */
function runBase(over = {}) {
  return {
    v: 1,
    ts: '2026-11-06T10:00:00.000Z',
    kind: 'run/start',
    runId: RUN,
    traceId: 'trace-run',
    data: { flowId: 'flow-a', flowName: '默认流程', nodeTotal: 3 },
    ...over,
  }
}

function ok(raw, context = ctx) {
  const result = normalizeEvent(raw, context)
  assert.equal(result.ok, true, `期望通过：${JSON.stringify(result)}`)
  return result.event
}

function bad(raw, field, context = ctx) {
  const result = normalizeEvent(raw, context)
  assert.equal(result.ok, false, `期望拒绝，实际通过：${JSON.stringify(result)}`)
  assert.equal(result.field, field, `错误字段应为 ${field}：${JSON.stringify(result)}`)
  return result
}

/** 聚合测试用的已落盘事件：seq 递增，字段不全也没关系（聚合器只读需要的字段）。 */
let seq = 0
function ev(kind, over = {}) {
  seq += 1
  return {
    v: 1,
    ts: `2026-11-06T10:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    kind,
    runId: 'r-agg',
    traceId: `trace-${seq}`,
    seq,
    memberId: null,
    ...over,
  }
}

console.log('runlog.js · 校验与归一化')

check('kind 白名单是契约里的 17 种（§8.2 新增 agent/message）', () => {
  assert.equal(EVENT_KINDS.length, 17)
  assert.ok(EVENT_KINDS.includes('run/start'))
  assert.ok(EVENT_KINDS.includes('check/form'))
  assert.ok(EVENT_KINDS.includes('acceptance/verdict'))
  assert.ok(EVENT_KINDS.includes('test/report'))
  assert.ok(EVENT_KINDS.includes('agent/message'))
})

/** agent/message 事件夹具（节点级事件）。 */
function agentMsg(over = {}, dataOver = {}) {
  return base({
    kind: 'agent/message',
    data: {
      role: 'assistant',
      text: '我先读一下 README，再改引擎。',
      truncated: false,
      ...dataOver,
    },
    ...over,
  })
}

check('agent/message 合法归一化：role/text/truncated 必填，provider/model 可选', () => {
  const event = ok(agentMsg({}, { provider: 'deepseek', model: 'deepseek-chat' }))
  assert.equal(event.kind, 'agent/message')
  assert.equal(event.memberId, null)
  assert.deepEqual(event.data, {
    role: 'assistant',
    text: '我先读一下 README，再改引擎。',
    truncated: false,
    provider: 'deepseek',
    model: 'deepseek-chat',
  })
  const minimal = ok(agentMsg())
  assert.equal(minimal.data.provider, undefined)
  assert.equal(minimal.data.model, undefined)
})

check('agent/message 非法：空文本 / 超 2000 字符 / role 不在白名单 / truncated 非布尔', () => {
  bad(agentMsg({}, { text: '' }), 'data.text')
  bad(agentMsg({}, { text: '   ' }), 'data.text')
  bad(agentMsg({}, { text: 'a'.repeat(2001) }), 'data.text')
  bad(agentMsg({}, { role: 'user' }), 'data.role')
  bad(agentMsg({}, { truncated: 'no' }), 'data.truncated')
})

check('agent/message 文本脱敏：Bearer / sk- / password / api_key 的值不落原文', () => {
  const secret = 'sk-live-abcdef1234567890'
  const raw = [
    'Authorization: Bearer sk-live-abcdef1234567890',
    'password=hunter2',
    'api_key: abc123secret',
  ].join('；')
  const redacted = engineModule.redactArguments(raw)
  const event = ok(agentMsg({}, { text: redacted }))
  assert.equal(event.data.text.includes(secret), false)
  assert.equal(event.data.text.includes('hunter2'), false)
  assert.equal(event.data.text.includes('abc123secret'), false)
  assert.ok(event.data.text.includes('[REDACTED]'))
})

check('合法 node/start 归一化：补齐 memberId=null、ts 转 UTC', () => {
  const event = ok(base())
  assert.equal(event.v, 1)
  assert.equal(event.kind, 'node/start')
  assert.equal(event.runId, RUN)
  assert.equal(event.nodeId, 'n_req')
  assert.equal(event.attemptId, 1)
  assert.equal(event.memberId, null)
  assert.equal(event.ts, '2026-11-06T02:00:00.000Z')
  assert.deepEqual(event.data.skills, ['skill-a'])
})

check('run/start 不需要 nodeId/attemptId；runId 缺失时用上下文补', () => {
  const event = ok({
    v: 1,
    kind: 'run/start',
    traceId: 'trace-run',
    data: { flowId: 'flow-a', flowName: '默认流程', nodeTotal: 6 },
  })
  assert.equal(event.nodeId, undefined)
  assert.equal(event.attemptId, undefined)
  assert.equal(event.runId, RUN)
})

check('ts 缺失/非法 → 服务端当前时间；合法非 Z 偏移归一成 Z', () => {
  const missing = base()
  delete missing.ts
  assert.equal(ok(missing).ts, NOW.toISOString())
  assert.equal(ok(base({ ts: 'not-a-date' })).ts, NOW.toISOString())
  assert.equal(ok(base({ ts: '2026-11-06T08:30:00+08:00' })).ts, '2026-11-06T00:30:00.000Z')
})

check('v / kind / traceId / nodeId / attemptId / runId 的必填与类型', () => {
  bad(base({ v: 2 }), 'v')
  const noV = base()
  delete noV.v
  bad(noV, 'v')
  bad(base({ kind: 'bogus/kind' }), 'kind')
  const noTrace = base()
  delete noTrace.traceId
  bad(noTrace, 'traceId')
  const noNode = base()
  delete noNode.nodeId
  bad(noNode, 'nodeId')
  bad(base({ attemptId: 0 }), 'attemptId')
  bad(base({ attemptId: 1.5 }), 'attemptId')
  bad(base({ attemptId: '1' }), 'attemptId')
  bad(base({ runId: 'r-other' }), 'runId')
  bad(base({ memberId: 'bad id' }), 'memberId')
})

check('run 级事件（run/start、run/end）带 nodeId / attemptId 一律 400（§8.1）', () => {
  bad(runBase({ nodeId: 'n_1' }), 'nodeId')
  bad(runBase({ kind: 'run/end', nodeId: 'n_1', data: { status: 'done' } }), 'nodeId')
  bad(runBase({ attemptId: 1 }), 'attemptId')
  bad(runBase({ kind: 'run/end', attemptId: 2, data: { status: 'done' } }), 'attemptId')
  // 其余 kind 缺 nodeId / attemptId 仍必须 400。
  bad(base({ nodeId: undefined }), 'nodeId')
  bad(base({ attemptId: undefined }), 'attemptId')
})

check('member 事件必须带 memberId；member/end.status 白名单（§8.1）', () => {
  bad(base({ kind: 'member/start', data: { name: '实现者' } }), 'memberId')
  const event = ok(base({ kind: 'member/start', memberId: 'm_dev', data: { name: '实现者', role: 'dev' } }))
  assert.equal(event.memberId, 'm_dev')
  bad(base({ kind: 'member/end', memberId: 'm_dev', data: { status: 'done', durationMs: 1 } }), 'data.status')
  bad(base({ kind: 'member/end', memberId: 'm_dev', data: { status: 'passed' } }), 'data.durationMs')
  for (const status of ['passed', 'failed', 'aborted']) {
    ok(base({ kind: 'member/end', memberId: 'm_dev', data: { status, durationMs: 1 } }))
  }
})

check('usage 四桶缺字段/负数一律报错（不补 0），reasoning ≤ output', () => {
  const call = usage => base({
    kind: 'model/call',
    data: { provider: 'deepseek', model: 'deepseek-chat', callId: 'call-1', usage },
  })
  bad(base({
    kind: 'model/call',
    data: { provider: 'p', model: 'm', usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 } },
  }), 'data.callId')
  bad(call({ input: 1, cacheRead: 2, cacheWrite: 3 }), 'data.usage.output')
  bad(call({ input: -1, cacheRead: 2, cacheWrite: 3, output: 4 }), 'data.usage.input')
  bad(call({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 5 }), 'data.usage.reasoning')
  const event = ok(call({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 4 }))
  assert.deepEqual(event.data.usage, { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 4 })
})

check('usage 的未知键被丢弃，callId 保留', () => {
  const event = ok(base({
    kind: 'model/call',
    data: {
      provider: 'p', model: 'm', callId: 'c-1',
      usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, total: 999, bogus: true },
    },
  }))
  assert.equal(event.data.callId, 'c-1')
  assert.equal(event.data.usage.total, undefined)
  assert.equal(event.data.usage.bogus, undefined)
})

check('extra 有界：键 ≤16、单串 ≤256、总字节 ≤2048，超限只丢弃不报错', () => {
  const many = {}
  for (let i = 0; i < 40; i += 1) many[`k${i}`] = `v${i}`
  const event = ok(base({ extra: many }))
  assert.equal(Object.keys(event.extra).length, 16)
  const exactly = {}
  for (let i = 0; i < 16; i += 1) exactly[`k${i}`] = `v${i}`
  assert.equal(Object.keys(ok(base({ extra: exactly })).extra).length, 16)

  const long = ok(base({ extra: { long: 'x'.repeat(300), keep: 'yes' } }))
  assert.equal(long.extra.long, undefined)
  assert.equal(long.extra.keep, 'yes')

  const fat = {}
  for (let i = 0; i < 40; i += 1) fat[`k${i}`] = 'y'.repeat(200)
  const bounded = ok(base({ extra: fat }))
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.extra), 'utf8') <= MAX_EXTRA_BYTES)
})

check('未识别的顶层字段折叠进 extra；客户端 seq 不被信任', () => {
  const event = ok(base({ customField: 'hello', seq: 999 }))
  assert.equal(event.extra.customField, 'hello')
  assert.equal(event.customField, undefined)
  assert.equal(event.seq, undefined)
})

check('artifact 路径必须是 run 目录内的相对路径', () => {
  const artifact = path => base({ kind: 'artifact/write', data: { path, bytes: 10, kind: 'md' } })
  bad(artifact('../escape.md'), 'data.path')
  bad(artifact('/etc/passwd'), 'data.path')
  bad(artifact('a/../../b.md'), 'data.path')
  ok(artifact('artifacts/需求.md'))
  assert.equal(isSafeRelPath('node/1/report.md'), true)
  assert.equal(isSafeRelPath('..'), false)
})

check('id 校验挡路径穿越：. / .. / 点开头 / 斜杠都拒绝', () => {
  assert.equal(checkRunId('r-abc'), 'r-abc')
  assert.equal(checkRunId('n_req.1'), 'n_req.1')
  for (const value of ['', '.', '..', '.hidden', '../x', 'a/b', 'a b', null, 42]) {
    assert.equal(checkRunId(value), null, `应拒绝 ${String(value)}`)
  }
})

check('ref 结构校验：url 可选，且可以单独存在（§8.1）', () => {
  bad(base({ ref: 'x' }), 'ref')
  bad(base({ ref: {} }), 'ref')
  bad(base({ ref: { url: 'x'.repeat(600) } }), 'ref.url')
  const event = ok(base({ ref: { sessionId: 's-1', logLine: 12, url: 'https://example.test/log#L3' } }))
  assert.deepEqual(event.ref, { sessionId: 's-1', logLine: 12, url: 'https://example.test/log#L3' })
  const urlOnly = ok(base({ ref: { url: 'artifacts/report.md' } }))
  assert.deepEqual(urlOnly.ref, { url: 'artifacts/report.md' })
})

check('逐 kind 必填字段与取值校验', () => {
  bad(base({ kind: 'node/end', data: { status: 'passed' } }), 'data.durationMs')
  bad(base({ kind: 'skill/load', data: { skill: 'a' } }), 'data.ok')
  bad(base({ kind: 'review/finding', data: { id: 'd1', severity: 'P9', title: 'x', status: 'open' } }), 'data.severity')
  bad(runBase({ kind: 'run/end', data: { status: 'ok' } }), 'data.status')
  bad(base({ kind: 'check/form', data: { ruleSetId: 'r', ruleSetVersion: '1', executor: 'e', state: 'ok' } }), 'data.state')
  bad(base({
    kind: 'check/form',
    data: { ruleSetId: 'r', ruleSetVersion: '1', executor: 'e', state: 'pass', passedChecks: 3, totalChecks: 2 },
  }), 'data.passedChecks')
})

check('acceptance/verdict：必填与取值白名单（§8.2）', () => {
  const good = data => base({ kind: 'acceptance/verdict', data })
  const event = ok(good({ itemId: 'acc-1', status: 'pass', decidedBy: 'human', evidenceRef: 'artifacts/a.md' }))
  assert.equal(event.data.itemId, 'acc-1')
  bad(good({ status: 'pass', decidedBy: 'human' }), 'data.itemId')
  bad(good({ itemId: 'a', status: 'passed', decidedBy: 'human' }), 'data.status')
  bad(good({ itemId: 'a', status: 'pass', decidedBy: 'machine' }), 'data.decidedBy')
  bad(good({ itemId: 'a', status: 'pass', decidedBy: 'auto', evidenceRef: 42 }), 'data.evidenceRef')
  for (const status of ['pass', 'fail', 'skip', 'na']) ok(good({ itemId: `i-${status}`, status, decidedBy: 'auto' }))
})

check('test/report：计数必填、failures 有界（§8.2）', () => {
  const good = data => base({ kind: 'test/report', data })
  const event = ok(good({ suite: 'unit', executed: 10, passed: 9, failed: 1, skipped: 0, reportRef: 'artifacts/t.json', failures: ['a.test.mjs'] }))
  assert.equal(event.data.executed, 10)
  bad(good({ executed: 1, passed: 1, failed: 0, skipped: 0 }), 'data.suite')
  bad(good({ suite: 'unit', passed: 1, failed: 0, skipped: 0 }), 'data.executed')
  bad(good({ suite: 'unit', executed: 1.5, passed: 1, failed: 0, skipped: 0 }), 'data.executed')
  bad(good({ suite: 'unit', executed: -1, passed: 0, failed: 0, skipped: 0 }), 'data.executed')
  bad(good({ suite: 'unit', executed: 1, passed: 1, failed: 0, skipped: 0, failures: Array.from({ length: 51 }, (_, i) => `t${i}`) }), 'data.failures')
  bad(good({ suite: 'unit', executed: 1, passed: 1, failed: 0, skipped: 0, failures: [42] }), 'data.failures')
})

check('artifact/write 支持可选 sha256，且路径规则不变（§8.1）', () => {
  const artifact = data => base({ kind: 'artifact/write', data })
  const sha = 'a'.repeat(64)
  const event = ok(artifact({ path: 'artifacts/a.md', bytes: 10, kind: 'md', sha256: sha }))
  assert.equal(event.data.sha256, sha)
  bad(artifact({ path: 'artifacts/a.md', bytes: 10, kind: 'md', sha256: 'not-a-hash' }), 'data.sha256')
  bad(artifact({ path: '../a.md', bytes: 10, kind: 'md' }), 'data.path')
  bad(artifact({ path: 'a\\b.md', bytes: 10, kind: 'md' }), 'data.path')
  bad(artifact({ path: 'a//b.md', bytes: 10, kind: 'md' }), 'data.path')
})

check('单条事件 > 8KB 拒绝', () => {
  const result = bad(base({
    data: { title: '需求', mode: 'single', skills: [], blob: 'x'.repeat(MAX_EVENT_BYTES + 100) },
  }), 'event')
  assert.match(result.reason, /8192/)
})

console.log('runlog.js · 聚合')

check('agent/message 聚合：按节点取最近 5 条、组内按时间升序', () => {
  const events = []
  for (let i = 1; i <= 7; i += 1) {
    events.push(ev('agent/message', {
      nodeId: 'n_a', attemptId: 1, memberId: i % 2 ? 'm_a1' : null,
      data: { role: 'assistant', text: `A${i}`, truncated: false },
    }))
  }
  for (let i = 1; i <= 2; i += 1) {
    events.push(ev('agent/message', {
      nodeId: 'n_b', attemptId: 1,
      data: { role: 'assistant', text: `B${i}`, truncated: i === 2 },
    }))
  }
  const activity = computeAgentActivity(events)
  assert.deepEqual(Object.keys(activity.nodes), ['n_a', 'n_b'])
  assert.deepEqual(activity.nodes.n_a.map(item => item.text), ['A3', 'A4', 'A5', 'A6', 'A7'])
  assert.equal(activity.nodes.n_a[0].memberId, 'm_a1')
  assert.equal(activity.nodes.n_a[1].memberId, null)
  assert.equal(activity.nodes.n_b.length, 2)
  assert.equal(typeof activity.nodes.n_a[0].at, 'string')
  // summarize 只加字段，旧口径原样保留。
  const summary = summarize(events)
  assert.deepEqual(summary.activity, activity)
  assert.ok('tokens' in summary && 'quality' in summary && 'progress' in summary)
})

check('agent/message 聚合：全局总量 ≤200 条（有界），保留全局最新', () => {
  const events = []
  for (let n = 0; n < 45; n += 1) {
    for (let i = 0; i < 5; i += 1) {
      events.push(ev('agent/message', {
        nodeId: `n_${n}`, attemptId: 1,
        data: { role: 'assistant', text: `${n}-${i}`, truncated: false },
      }))
    }
  }
  const activity = computeAgentActivity(events)
  const total = Object.values(activity.nodes).reduce((sum, list) => sum + list.length, 0)
  assert.equal(total, 200)
  assert.ok(activity.nodes.n_44, '最新节点必须在')
  assert.equal(activity.nodes.n_4, undefined, '最老节点应被裁掉')
})

check('tokens：四桶按 node/member 分组，reasoning 不进 total，callId 后到替换', () => {
  const calls = [
    ev('model/call', {
      nodeId: 'n_dev', attemptId: 1, memberId: 'm_dev', traceId: 't1',
      data: { provider: 'p', model: 'm', callId: 'c1', usage: { input: 10, cacheRead: 20, cacheWrite: 0, output: 5, reasoning: 2 } },
    }),
    ev('model/call', {
      nodeId: 'n_dev', attemptId: 1, memberId: 'm_dev', traceId: 't1',
      data: { provider: 'p', model: 'm', callId: 'c1', usage: { input: 100, cacheRead: 200, cacheWrite: 300, output: 50 } },
    }),
    ev('model/call', {
      nodeId: 'n_dev', attemptId: 1, memberId: 'm_test', traceId: 't2',
      data: { provider: 'p', model: 'm', callId: 'c2', usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 } },
    }),
  ]
  const tokens = computeTokens(calls)
  assert.equal(tokens.calls, 2)
  assert.equal(tokens.total.input, 101)
  assert.equal(tokens.total.cacheRead, 202)
  assert.equal(tokens.total.cacheWrite, 303)
  assert.equal(tokens.total.output, 54)
  assert.equal(tokens.total.total, 101 + 202 + 303 + 54)
  assert.equal(tokens.total.reasoning, 0, '被替换掉的 reasoning 不能残留')
  assert.equal(tokens.byNode.n_dev.total, 100 + 200 + 300 + 50 + 1 + 2 + 3 + 4)
  assert.equal(tokens.byMember.m_dev.total, 650)
  assert.equal(tokens.byMember.m_test.total, 10)
})

check('skillUsage：coverage 分母是声明唯一 skill 数，加载次数单列', () => {
  const events = [
    ev('node/start', { nodeId: 'n1', attemptId: 1, data: { title: 'a', mode: 'single', skills: ['a', 'b', 'c', 'a'] } }),
    ev('node/start', { nodeId: 'n2', attemptId: 1, data: { title: 'b', mode: 'single', skills: ['b', 'd'] } }),
    ev('skill/load', { nodeId: 'n1', attemptId: 1, data: { skill: 'a', ok: true } }),
    ev('skill/load', { nodeId: 'n1', attemptId: 1, data: { skill: 'a', ok: true } }),
    ev('skill/load', { nodeId: 'n1', attemptId: 1, data: { skill: 'b', ok: false } }),
    ev('skill/load', { nodeId: 'n1', attemptId: 1, data: { skill: 'e', ok: true } }),
  ]
  const usage = computeSkillUsage(events)
  assert.equal(usage.declaredCount, 4)
  assert.deepEqual(usage.declared, ['a', 'b', 'c', 'd'])
  assert.deepEqual(usage.loaded, ['a', 'e'])
  assert.equal(usage.coverage, 0.25)
  assert.deepEqual(usage.missing, ['b', 'c', 'd'])
  assert.deepEqual(usage.undeclared, ['e'])
  assert.equal(usage.loads.total, 4)
  assert.equal(usage.loads.ok, 3)
  assert.equal(usage.loads.failed, 1)
  assert.deepEqual(usage.bySkill.a, { ok: 2, failed: 0 })
  assert.deepEqual(usage.bySkill.b, { ok: 0, failed: 1 })
})

check('skillUsage：无声明时 coverage 为 null，不冒充 100%', () => {
  const usage = computeSkillUsage([])
  assert.equal(usage.coverage, null)
  assert.equal(usage.declaredCount, 0)
})

check('findings：按 severity 计数，未解决与已复验分开，同 id 取最后状态', () => {
  const events = [
    ev('review/finding', { nodeId: 'n1', attemptId: 1, data: { id: 'd1', severity: 'P0', title: '空指针', status: 'open' } }),
    ev('review/finding', { nodeId: 'n1', attemptId: 1, data: { id: 'd1', severity: 'P0', title: '空指针', status: 'accepted' } }),
    ev('review/finding', { nodeId: 'n1', attemptId: 1, data: { id: 'd2', severity: 'P1', title: '缺测试', status: 'verified' } }),
    ev('review/finding', { nodeId: 'n1', attemptId: 1, data: { id: 'd3', severity: 'P1', title: '命名', status: 'open' } }),
    ev('review/finding', { nodeId: 'n1', attemptId: 1, data: { id: 'd4', severity: 'P2', title: '格式', status: 'dismissed' } }),
  ]
  const findings = computeFindings(events)
  assert.equal(findings.total, 4)
  assert.equal(findings.reportedCount, 5)
  assert.deepEqual(findings.bySeverity, { P0: 1, P1: 2, P2: 1 })
  assert.equal(findings.unresolved, 2)
  assert.deepEqual(findings.unresolvedBySeverity, { P0: 1, P1: 1, P2: 0 })
  assert.equal(findings.verified, 1)
  assert.equal(findings.dismissed, 1)
  assert.equal(findings.byStatus.accepted, 1)
  // §8.3 采纳率 = (accepted + fixed + verified) / (total − dismissed − na)
  assert.equal(findings.acceptedCount, 2)
  assert.equal(findings.acceptedRateDenominator, 3)
  assert.equal(findings.acceptedRate, 2 / 3)
  assert.equal(findings.acceptedRateUnknown, false)
  assert.equal(computeFindings([]).acceptedRate, null)
  assert.equal(computeFindings([]).acceptedRateUnknown, true)
})

check('findings：同一 id 跨节点合并；total 是唯一数、reportedCount 是原始事件数', () => {
  const events = [
    ev('review/finding', { nodeId: 'n1', attemptId: 1, data: { id: 'dup', severity: 'P0', title: 'a', status: 'open' } }),
    ev('review/finding', { nodeId: 'n2', attemptId: 1, data: { id: 'dup', severity: 'P0', title: 'a', status: 'verified' } }),
    ev('review/finding', { nodeId: 'n2', attemptId: 1, data: { id: 'dup', severity: 'P0', title: 'a', status: 'fixed' } }),
  ]
  const findings = computeFindings(events)
  assert.equal(findings.total, 1)
  assert.equal(findings.reportedCount, 3)
  assert.equal(findings.byStatus.fixed, 1)
  // §8.3：unresolved = open + accepted + fixed（fixed 尚未复验，仍算未解决）。
  assert.equal(findings.unresolved, 1)
  assert.equal(findings.verified, 0)
})

check('rejects：按边与目标节点两个维度', () => {
  const events = [
    ev('reject/trigger', { nodeId: 'n_test', attemptId: 1, data: { edgeId: 'e1', fromNodeId: 'n_test', toNodeId: 'n_dev', reason: '失败' } }),
    ev('reject/trigger', { nodeId: 'n_test', attemptId: 2, data: { edgeId: 'e1', fromNodeId: 'n_test', toNodeId: 'n_dev', reason: '又失败' } }),
    ev('reject/trigger', { nodeId: 'n_review', attemptId: 1, data: { edgeId: 'e2', fromNodeId: 'n_review', toNodeId: 'n_dev', reason: '审查打回' } }),
  ]
  const rejects = computeRejects(events)
  assert.equal(rejects.total, 3)
  assert.deepEqual(rejects.byEdge, { e1: 2, e2: 1 })
  assert.deepEqual(rejects.byTarget, { n_dev: 3 })
})

check('progress：passed /（总阶段 − skipped），同节点取最后一次 node/end', () => {
  const events = [
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 4 } }),
    ev('node/end', { nodeId: 'n1', attemptId: 1, data: { status: 'rejected', durationMs: 1 } }),
    ev('node/end', { nodeId: 'n1', attemptId: 2, data: { status: 'passed', durationMs: 1 } }),
    ev('node/end', { nodeId: 'n2', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('node/end', { nodeId: 'n3', attemptId: 1, data: { status: 'skipped', durationMs: 1 } }),
    ev('node/end', { nodeId: 'n4', attemptId: 1, data: { status: 'failed', durationMs: 1 } }),
  ]
  const progress = computeProgress(events)
  assert.equal(progress.passed, 2)
  assert.equal(progress.skipped, 1)
  assert.equal(progress.failed, 1)
  assert.equal(progress.rejected, 0)
  assert.equal(progress.total, 4)
  assert.equal(progress.denominator, 3)
  assert.equal(progress.ratio, 2 / 3)
  assert.equal(progress.nodeDone, 2)
})

check('progress：没有 run/start 时退回观察到的节点；全 skipped 时 ratio=null', () => {
  const progress = computeProgress([
    ev('node/end', { nodeId: 'n1', attemptId: 1, data: { status: 'skipped', durationMs: 1 } }),
  ])
  assert.equal(progress.total, 1)
  assert.equal(progress.denominator, 0)
  assert.equal(progress.ratio, null)
})

check('progress：打回后 A/B 的 passed 失效，ratio 不再虚高（§8.3）', () => {
  const rejected = computeProgress([
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 2 } }),
    ev('node/end', { nodeId: 'n_a', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('node/end', { nodeId: 'n_b', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('reject/trigger', { nodeId: 'n_b', attemptId: 1, data: { edgeId: 'e1', fromNodeId: 'n_b', toNodeId: 'n_a', reason: '打回 A' } }),
  ])
  assert.equal(rejected.passed, 0)
  assert.equal(rejected.invalidated, 2)
  assert.deepEqual(rejected.invalidatedNodes, ['n_a', 'n_b'])
  assert.equal(rejected.denominator, 2)
  assert.equal(rejected.ratio, 0)
  assert.ok(rejected.ratio <= 1)
  assert.equal(rejected.nodeDone, 0)

  // 打回后新 attempt 重新通过，才重新计入分子。
  const reworked = computeProgress([
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 2 } }),
    ev('node/end', { nodeId: 'n_a', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('node/end', { nodeId: 'n_b', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('reject/trigger', { nodeId: 'n_b', attemptId: 1, data: { edgeId: 'e1', fromNodeId: 'n_b', toNodeId: 'n_a', reason: '打回 A' } }),
    ev('node/start', { nodeId: 'n_a', attemptId: 2, data: { title: 'A', mode: 'single', skills: [] } }),
    ev('node/end', { nodeId: 'n_a', attemptId: 2, data: { status: 'passed', durationMs: 1 } }),
    ev('node/end', { nodeId: 'n_b', attemptId: 2, data: { status: 'passed', durationMs: 1 } }),
  ])
  assert.equal(reworked.passed, 2)
  assert.equal(reworked.invalidated, 0)
  assert.equal(reworked.ratio, 1)
  assert.equal(reworked.nodeDone, 2)
})

check('progress：失效按「打回当时」的状态算——后来别的节点重跑不能把旧失效洗白', () => {
  const progress = computeProgress([
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 3 } }),
    ev('node/end', { nodeId: 'n_a', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('node/end', { nodeId: 'n_b', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('reject/trigger', { nodeId: 'n_b', attemptId: 1, data: { edgeId: 'e1', fromNodeId: 'n_b', toNodeId: 'n_a', reason: '打回 A' } }),
    ev('node/start', { nodeId: 'n_a', attemptId: 2, data: { title: 'A', mode: 'single', skills: [] } }),
    ev('node/end', { nodeId: 'n_a', attemptId: 2, data: { status: 'passed', durationMs: 1 } }),
    ev('node/end', { nodeId: 'n_c', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
  ])
  // A 重跑通过；B 没有被重跑，它的旧 passed 仍应失效（不能被 A 的新 passed 洗白）。
  assert.equal(progress.passed, 2)
  assert.equal(progress.invalidated, 1)
  assert.deepEqual(progress.invalidatedNodes, ['n_b'])
  assert.equal(progress.denominator, 3)
  assert.equal(progress.ratio, 2 / 3)
})

check('progress：旧 attempt 的 passed 不计；ratio 强制 ≤1', () => {
  const oldAttempt = computeProgress([
    ev('node/end', { nodeId: 'n_a', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('node/start', { nodeId: 'n_a', attemptId: 2, data: { title: 'A', mode: 'single', skills: [] } }),
  ])
  assert.equal(oldAttempt.passed, 0, '第 2 轮已开始但还没 node/end，不能拿第 1 轮的 passed 冒充')
  assert.equal(oldAttempt.nodeDone, 0)

  const capped = computeProgress([
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 1 } }),
    ev('node/end', { nodeId: 'n_a', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('node/end', { nodeId: 'n_b', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
  ])
  assert.equal(capped.ratio, 1, 'passed 多于 nodeTotal 时 ratio 也不能 >1')
})

/**
 * 五项必要证据齐全的 run；over 用来制造返工 / 半成品 / P0/P1/P2 遗留等分支。
 * p0Status / p2Status 为 null 表示不追加该严重级的 finding（保持 findingCount=1）。
 */
function fullEvidence(over = {}) {
  const {
    rework = 0,
    p0Status = null,
    p1Status = 'verified',
    p2Status = null,
    testFailed = 0,
    passedStages = 2,
    nodeTotal = 2,
    withTests = true,
    withChecks = true,
    withReview = true,
    checkState = 'pass',
  } = over
  const events = [ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal } })]
  if (rework > 0) {
    for (let round = 1; round <= rework; round += 1) {
      // 第 1 轮被 rejected 后打回，第 2 轮重新通过：返工轮次 = reject 数。
      for (let i = 0; i < rework; i += 1) {
        events.push(ev('node/start', { nodeId: 'n_0', attemptId: i + 1, data: { title: 'A', mode: 'single', skills: [] } }))
        events.push(ev('node/end', { nodeId: 'n_0', attemptId: i + 1, data: { status: 'rejected', durationMs: 1 } }))
        events.push(ev('reject/trigger', {
          nodeId: 'n_0', attemptId: i + 1,
          data: { edgeId: 'e1', fromNodeId: 'n_0', toNodeId: 'n_0', reason: '打回' },
        }))
      }
      events.push(ev('node/start', { nodeId: 'n_0', attemptId: rework + 1, data: { title: 'A', mode: 'single', skills: [] } }))
      events.push(ev('node/end', { nodeId: 'n_0', attemptId: rework + 1, data: { status: 'passed', durationMs: 1 } }))
      break
    }
  } else {
    events.push(ev('node/end', { nodeId: 'n_0', attemptId: 1, data: { status: 'passed', durationMs: 1 } }))
  }
  for (let i = 1; i < passedStages; i += 1) {
    events.push(ev('node/end', { nodeId: `n_${i}`, attemptId: 1, data: { status: 'passed', durationMs: 1 } }))
  }
  events.push(ev('acceptance/verdict', {
    nodeId: 'n_acc', attemptId: 1,
    data: { itemId: 'acc-1', status: 'pass', decidedBy: 'human', evidenceRef: 'artifacts/acc.md' },
  }))
  if (withTests) {
    events.push(ev('test/report', {
      nodeId: 'n_test', attemptId: 1,
      data: {
        suite: 'unit', executed: 10, passed: 10 - testFailed, failed: testFailed, skipped: 0,
        reportRef: 'artifacts/test.md',
      },
    }))
  }
  if (withChecks) {
    events.push(ev('check/form', {
      nodeId: 'n_check', attemptId: 1,
      data: {
        ruleSetId: 'eslint', ruleSetVersion: '9', executor: 'eslint@9',
        state: checkState, passedChecks: 5, totalChecks: 5,
        executedAt: '2026-11-06T10:00:00.000Z',
      },
    }))
  }
  if (withReview) {
    events.push(ev('review/finding', {
      nodeId: 'n_review', attemptId: 1,
      data: { id: 'f1', severity: 'P1', title: '问题', status: p1Status },
    }))
    let findingCount = 1
    if (p0Status !== null) {
      findingCount += 1
      events.push(ev('review/finding', {
        nodeId: 'n_review', attemptId: 1,
        data: { id: 'f0', severity: 'P0', title: '阻断', status: p0Status },
      }))
    }
    if (p2Status !== null) {
      findingCount += 1
      events.push(ev('review/finding', {
        nodeId: 'n_review', attemptId: 1,
        data: { id: 'f2', severity: 'P2', title: '格式', status: p2Status },
      }))
    }
    events.push(ev('review/verdict', {
      nodeId: 'n_review', attemptId: 1,
      data: { verdict: 'approve', findingCount },
    }))
  }
  return events
}

check('quality：五项证据齐全 + 进度 100% + P0=0（返工 0）→ pass「优：首轮通过」', () => {
  const quality = computeQuality(fullEvidence())
  assert.equal(quality.state, 'pass')
  assert.equal(quality.label, '优：首轮通过')
  assert.deepEqual(quality.missing, [])
  assert.deepEqual(quality.failed, [])
  assert.equal(quality.reworkRounds, 0)
  assert.equal(quality.p0Unresolved, 0)
  assert.equal(quality.evidence.acceptance.state, 'pass')
  assert.equal(quality.evidence.tests.state, 'pass')
  assert.equal(quality.evidence.checks.state, 'pass')
  assert.equal(quality.evidence.review.state, 'pass')
  assert.equal(quality.evidence.p0p1.state, 'pass')
})

check('quality：返工 1 轮 + P1=0 + 采纳率≥0.6 → pass「良：返工 1 轮后达标」', () => {
  const quality = computeQuality(fullEvidence({ rework: 1, p1Status: 'verified' }))
  assert.equal(quality.state, 'pass')
  assert.equal(quality.label, '良：返工 1 轮后达标')
  assert.equal(quality.reworkRounds, 1)
  assert.equal(quality.acceptedRate, 1)
  assert.notEqual(quality.label, '优：首轮通过')
})

check('quality：P1 未解决不给良（返工 1 轮也只能 warn）', () => {
  const quality = computeQuality(fullEvidence({ rework: 1, p1Status: 'open' }))
  assert.equal(quality.state, 'warn')
  assert.match(quality.label, /可：返工 1 轮/)
  assert.match(quality.label, /遗留 1 个 P1/)
  assert.equal(quality.p1Unresolved, 1)
  assert.notEqual(quality.state, 'pass')
})

check('quality：半成品（证据全过但 ratio<1）至少 warn，不许绿', () => {
  const quality = computeQuality(fullEvidence({ passedStages: 1, nodeTotal: 2 }))
  assert.equal(quality.state, 'warn')
  assert.match(quality.label, /进度未完成（1\/2）/)
  assert.deepEqual(quality.missing, [], '证据齐全时 missing 应为空')
})

check('quality：缺验收 / 测试证据 → unknown，missing 准确列出缺项', () => {
  const empty = computeQuality([])
  assert.equal(empty.state, 'unknown')
  assert.deepEqual([...empty.missing].sort(), ['acceptance', 'checks', 'p0p1', 'review', 'tests'])
  assert.match(empty.label, /证据不足/)

  const partial = computeQuality([
    ev('acceptance/verdict', {
      nodeId: 'n_acc', attemptId: 1,
      data: { itemId: 'acc-1', status: 'pass', decidedBy: 'human', evidenceRef: 'artifacts/acc.md' },
    }),
  ])
  assert.equal(partial.state, 'unknown')
  assert.equal(partial.evidence.acceptance.state, 'pass')
  assert.deepEqual([...partial.missing].sort(), ['checks', 'p0p1', 'review', 'tests'])
})

check('quality：任一证据 fail → fail（验收 fail / 测试 fail）', () => {
  const acceptanceFail = computeQuality([
    ...fullEvidence(),
    ev('acceptance/verdict', {
      nodeId: 'n_acc', attemptId: 1,
      data: { itemId: 'acc-1', status: 'fail', decidedBy: 'human', evidenceRef: 'artifacts/acc.md' },
    }),
  ])
  assert.equal(acceptanceFail.state, 'fail')
  assert.equal(acceptanceFail.evidence.acceptance.state, 'fail')
  assert.match(acceptanceFail.label, /验收条目/)

  const testsFail = computeQuality(fullEvidence({ testFailed: 1 }))
  assert.equal(testsFail.state, 'fail')
  assert.equal(testsFail.evidence.tests.state, 'fail')
})

check('quality：规范 state=pass 但计数 / 执行时间 / 报告链接不全 → checks unknown（§8.3）', () => {
  const strict = computeQuality([
    ev('acceptance/verdict', {
      nodeId: 'n_acc', attemptId: 1,
      data: { itemId: 'acc-1', status: 'pass', decidedBy: 'human', evidenceRef: 'artifacts/acc.md' },
    }),
    ev('test/report', {
      nodeId: 'n_test', attemptId: 1,
      data: { suite: 'unit', executed: 1, passed: 1, failed: 0, skipped: 0, reportRef: 'artifacts/test.md' },
    }),
    ev('check/form', {
      nodeId: 'n_check', attemptId: 1,
      data: { ruleSetId: 'eslint', ruleSetVersion: '9', executor: 'eslint@9', state: 'pass', passedChecks: 5, totalChecks: 5 },
    }),
    ev('review/verdict', { nodeId: 'n_review', attemptId: 1, data: { verdict: 'approve', findingCount: 0 } }),
  ])
  assert.equal(strict.evidence.checks.state, 'unknown')
  assert.ok(strict.missing.includes('checks'))
  assert.equal(strict.state, 'unknown')
})

check('quality：审查一致性取最后一次 verdict；旧 reject 不永久判死', () => {
  const rescued = computeQuality([
    ...fullEvidence({ rework: 0 }),
    ev('review/verdict', { nodeId: 'n_review', attemptId: 1, data: { verdict: 'reject', findingCount: 1 } }),
    ev('review/verdict', { nodeId: 'n_review', attemptId: 1, data: { verdict: 'approve', findingCount: 1 } }),
  ])
  assert.equal(rescued.evidence.review.state, 'pass')

  const lastReject = computeQuality([
    ...fullEvidence({ rework: 0 }),
    ev('review/verdict', { nodeId: 'n_review', attemptId: 1, data: { verdict: 'reject', findingCount: 1 } }),
  ])
  assert.equal(lastReject.evidence.review.state, 'fail')
  assert.equal(lastReject.state, 'fail')
})

check('quality：findingCount 与 finding 事件对不上 → review unknown（§8.3）', () => {
  const noFindings = computeQuality([
    ev('acceptance/verdict', {
      nodeId: 'n_acc', attemptId: 1,
      data: { itemId: 'acc-1', status: 'pass', decidedBy: 'human', evidenceRef: 'artifacts/acc.md' },
    }),
    ev('review/verdict', { nodeId: 'n_review', attemptId: 1, data: { verdict: 'approve', findingCount: 2 } }),
  ])
  assert.equal(noFindings.evidence.review.state, 'unknown')
  assert.match(noFindings.evidence.review.reason, /没有任何 review\/finding/)
  assert.ok(noFindings.missing.includes('review'))

  const tooMany = computeQuality([
    ev('review/verdict', { nodeId: 'n_review', attemptId: 1, data: { verdict: 'approve', findingCount: 0 } }),
    ev('review/finding', { nodeId: 'n_review', attemptId: 1, data: { id: 'f9', severity: 'P2', title: '多出', status: 'open' } }),
  ])
  assert.equal(tooMany.evidence.review.state, 'unknown')
  assert.match(tooMany.evidence.review.reason, /大于 findingCount/)
})

check('acceptance/test 只认当前 attempt；同一 id / suite 取 seq 最大者（§8.2）', () => {
  const acceptance = computeAcceptance([
    ev('acceptance/verdict', { nodeId: 'n_a', attemptId: 1, data: { itemId: 'i1', status: 'fail', decidedBy: 'human' } }),
    ev('acceptance/verdict', { nodeId: 'n_a', attemptId: 1, data: { itemId: 'i1', status: 'pass', decidedBy: 'human', evidenceRef: 'r' } }),
  ])
  assert.equal(acceptance.state, 'pass')
  assert.equal(acceptance.items, 1)

  const tests = computeTests([
    ev('test/report', { nodeId: 'n_t', attemptId: 1, data: { suite: 'unit', executed: 1, passed: 0, failed: 1, skipped: 0 } }),
    ev('test/report', { nodeId: 'n_t', attemptId: 1, data: { suite: 'unit', executed: 1, passed: 1, failed: 0, skipped: 0, reportRef: 'r' } }),
  ])
  assert.equal(tests.state, 'pass')
  assert.equal(tests.suites, 1)

  const oldAttempt = computeQuality([
    ev('node/start', { nodeId: 'n_a', attemptId: 2, data: { title: 'A', mode: 'single', skills: [] } }),
    ev('node/end', { nodeId: 'n_a', attemptId: 2, data: { status: 'passed', durationMs: 1 } }),
    ev('acceptance/verdict', { nodeId: 'n_a', attemptId: 1, data: { itemId: 'i1', status: 'pass', decidedBy: 'human', evidenceRef: 'r' } }),
  ])
  assert.equal(oldAttempt.evidence.acceptance.state, 'unknown', '旧 attempt 的验收结论不能进入当前结论')
  assert.ok(oldAttempt.missing.includes('acceptance'))
})

check('summary 带 computedAt / eventCount 与全部聚合键', () => {
  const events = [
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 2 } }),
    ev('model/call', {
      nodeId: 'n1', attemptId: 1,
      data: { provider: 'p', model: 'm', callId: 'c1', usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 } },
    }),
    ev('model/call', {
      nodeId: 'n1', attemptId: 1,
      data: { provider: 'p', model: 'm', usage: { input: 5, cacheRead: 0, cacheWrite: 0, output: 5 } },
    }),
  ]
  const summary = summarize(events, { now: NOW })
  assert.equal(summary.computedAt, NOW.toISOString())
  assert.equal(summary.eventCount, 3)
  for (const key of ['tokens', 'skillUsage', 'findings', 'rejects', 'progress', 'quality']) {
    assert.ok(Object.hasOwn(summary, key), `summary 缺 ${key}`)
  }
  assert.equal(summary.tokens.total.total, 20)
  assert.equal(summary.usage.unkeyedCalls, 1, '没有 callId 的历史用量要单列')
  assert.equal(summary.truncated, false)
  assert.equal(summarize(events, { now: NOW, truncated: true }).truncated, true)
})

check('export markdown 含 run 头、指标小节与质量结论', () => {
  const events = [
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 1 } }),
    ev('node/end', { nodeId: 'n1', attemptId: 1, data: { status: 'passed', durationMs: 12 } }),
  ]
  const summary = summarize(events, { now: NOW })
  const markdown = renderRunMarkdown({
    id: RUN, name: '联调 run', flowId: 'flow-a', flowName: '默认流程', status: 'done',
    startedAt: NOW.toISOString(), endedAt: NOW.toISOString(),
  }, events, summary)
  assert.ok(markdown.startsWith('# 运行日志'))
  assert.ok(markdown.includes(RUN))
  assert.ok(markdown.includes('## 阶段进度'))
  assert.ok(markdown.includes('## Token'))
  assert.ok(markdown.includes('## 质量结论'))
  assert.ok(markdown.includes('`unknown`'))
})

check('§13.7 summarize.acceptance：当前有效 attempt 的通过率（passed / total / rate）', () => {
  const events = fullEvidence()
  events.push(ev('acceptance/verdict', {
    nodeId: 'n_acc', attemptId: 1,
    data: { itemId: 'acc-2', status: 'fail', decidedBy: 'auto' },
  }))
  const acceptance = summarizeAcceptance(events)
  assert.deepEqual(acceptance, { passed: 1, total: 2, rate: 0.5 })
  const summary = summarize(events)
  assert.deepEqual(summary.acceptance, acceptance)
  // 旧 attempt 的验收条目不进当前通过率。
  const withOldAttempt = events.concat([
    ev('acceptance/verdict', {
      nodeId: 'n_acc', attemptId: 2,
      data: { itemId: 'acc-1', status: 'pass', decidedBy: 'auto', evidenceRef: 'artifacts/acc2.md' },
    }),
    ev('acceptance/verdict', {
      nodeId: 'n_acc', attemptId: 2,
      data: { itemId: 'acc-2', status: 'pass', decidedBy: 'auto', evidenceRef: 'artifacts/acc3.md' },
    }),
  ])
  assert.deepEqual(summarizeAcceptance(withOldAttempt), { passed: 2, total: 2, rate: 1 })
})

check('§13.7 model-claim 证据：artifact path+sha256 对不上 → unknown；对上 + 文件校验通过 → pass', () => {
  const sha = 'a'.repeat(64)
  // v1.3 证据独立性：产物由别的节点（n_peer）写出 → peer 级，才可能因「path+sha256 对上」而 pass。
  // 同一节点自写自引的自证闭环现在判 unknown（见下方 v1.3 自证测试）。
  const artifact = ev('artifact/write', {
    nodeId: 'n_peer', attemptId: 1,
    data: { path: 'evidence/acc.md', bytes: 3, kind: 'md', sha256: sha },
  })
  const claim = (ref, extra = { provenance: 'model-claim' }) => ev('acceptance/verdict', {
    nodeId: 'n_acc', attemptId: 1,
    extra,
    data: { itemId: 'acc-1', status: 'pass', decidedBy: 'auto', evidenceRef: ref },
  })
  const good = [artifact, claim('evidence/acc.md')]
  const index = collectArtifactIndex(good)
  assert.equal(index.get('evidence/acc.md'), sha)
  assert.equal(computeAcceptance(good, { artifacts: index }).state, 'pass', '纯函数层只校验 path+sha256（peer 级证据不是自证）')
  assert.equal(
    computeAcceptance(good, { artifacts: index, verifyEvidence: () => false }).state,
    'unknown',
    'Host 层文件不存在 / sha 不符时必须 unknown',
  )
  assert.equal(
    computeAcceptance(good, { artifacts: index, verifyEvidence: () => true }).state,
    'pass',
  )
  const forged = [artifact, claim('evidence/forged.md')]
  const forgedResult = computeAcceptance(forged, { artifacts: collectArtifactIndex(forged), verifyEvidence: () => true })
  assert.equal(forgedResult.state, 'unknown')
  assert.equal(forgedResult.unverified, 1)
  assert.match(forgedResult.reason, /证据对不上/)
  assert.match(forgedResult.unverifiedRefs[0], /artifact\/write/)
  // 没有 model-claim 标记的老事件保持原口径（只要求有 ref）。
  assert.equal(computeAcceptance([claim('any/path.md', {})]).state, 'pass')
  // 模型自述的 check/form 必须给可复核 reportRef，executedAt 不算证据。
  const checkEvent = ev('check/form', {
    nodeId: 'n_check', attemptId: 1,
    extra: { provenance: 'model-claim' },
    data: {
      ruleSetId: 'eslint', ruleSetVersion: '9', executor: 'eslint@9', state: 'pass',
      passedChecks: 3, totalChecks: 3, executedAt: '2026-11-06T10:00:00.000Z',
    },
  })
  const quality = computeQuality([artifact, claim('evidence/acc.md'), checkEvent], {
    artifacts: index,
    verifyEvidence: () => true,
  })
  assert.equal(quality.evidence.checks.state, 'unknown')
  assert.match(quality.evidence.checks.reason, /报告对不上|reportRef/)
})

check('§13.7 跨节点重复标识 → 对应指标 unknown，并返回 conflicts', () => {
  const events = [
    ev('acceptance/verdict', { nodeId: 'n_a', attemptId: 1, data: { itemId: 'R1', status: 'pass', decidedBy: 'auto', evidenceRef: 'a.md' } }),
    ev('acceptance/verdict', { nodeId: 'n_b', attemptId: 1, data: { itemId: 'R1', status: 'pass', decidedBy: 'auto', evidenceRef: 'b.md' } }),
    ev('test/report', { nodeId: 'n_a', attemptId: 1, data: { suite: 'unit', executed: 1, passed: 1, failed: 0, skipped: 0, reportRef: 'a.json' } }),
    ev('test/report', { nodeId: 'n_b', attemptId: 1, data: { suite: 'unit', executed: 1, passed: 1, failed: 0, skipped: 0, reportRef: 'b.json' } }),
  ]
  const conflicts = computeConflicts(events)
  assert.deepEqual(conflicts.acceptance, [{ id: 'R1', nodes: ['n_a', 'n_b'] }])
  assert.deepEqual(conflicts.tests, [{ id: 'unit', nodes: ['n_a', 'n_b'] }])
  const quality = computeQuality(events, { conflicts })
  assert.equal(quality.evidence.acceptance.state, 'unknown')
  assert.equal(quality.evidence.tests.state, 'unknown')
  assert.match(quality.evidence.acceptance.reason, /跨节点重复/)
  const summary = summarize(events)
  assert.equal(summary.conflicts.acceptance.length, 1)
  assert.equal(summary.conflicts.tests.length, 1)
})

check('§13.7 stub 引擎：quality 强制 unknown，label 前缀「桩」，summary.engine=stub', () => {
  const quality = computeQuality(fullEvidence(), { engine: 'stub' })
  assert.equal(quality.state, 'unknown')
  assert.ok(quality.label.startsWith('桩'), quality.label)
  assert.equal(quality.stub, true)
  const summary = summarize(fullEvidence(), { engine: 'stub' })
  assert.equal(summary.engine, 'stub')
  assert.equal(summary.quality.state, 'unknown')
  const fromEvent = summarize([
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 2, engine: 'stub' } }),
    ...fullEvidence().slice(1),
  ])
  assert.equal(fromEvent.engine, 'stub', 'run/start.data.engine=stub 也要被识别')
})

check('§8.1/§13.10 member/end.status=partial 合法：成员结论不可观测，不伪造 passed/failed', () => {
  const event = ok(base({
    kind: 'member/end',
    memberId: 'n_req:1',
    data: { status: 'partial', durationMs: 5 },
  }))
  assert.equal(event.data.status, 'partial')
  // 仍然拒绝白名单外的取值（引擎的 partial 探针就是靠这个判断宿主能力）。
  bad(base({ kind: 'member/end', memberId: 'n_req:1', data: { status: 'done', durationMs: 5 } }), 'data.status')
})

check('§8.3 summary.progress 带 nodes（B1）：每节点 attemptId/status/endSeq/invalidated', () => {
  const events = [
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 3 } }),
    ev('node/start', { nodeId: 'n_a', attemptId: 1, data: { title: 'A', mode: 'single', skills: [] } }),
    ev('node/end', { nodeId: 'n_a', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('node/start', { nodeId: 'n_b', attemptId: 1, data: { title: 'B', mode: 'single', skills: [] } }),
    ev('node/end', { nodeId: 'n_b', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
    ev('node/start', { nodeId: 'n_c', attemptId: 1, data: { title: 'C', mode: 'single', skills: [] } }),
    ev('reject/trigger', {
      nodeId: 'n_b', attemptId: 1,
      data: { edgeId: 'e1', fromNodeId: 'n_b', toNodeId: 'n_a', reason: '打回' },
    }),
  ]
  const progress = computeProgress(events)
  assert.ok(progress.nodes, 'computeProgress 必须返回 nodes')
  assert.deepEqual(progress.nodes.n_a, {
    attemptId: 1, status: 'passed', endSeq: events[2].seq, invalidated: true,
  })
  assert.deepEqual(progress.nodes.n_b, {
    attemptId: 1, status: 'passed', endSeq: events[4].seq, invalidated: true,
  })
  assert.equal(progress.nodes.n_c.status, 'pending', '没跑到的节点是 pending，不是 passed')
  assert.equal(progress.nodes.n_c.invalidated, false)
  assert.deepEqual(progress.invalidatedNodes, ['n_a', 'n_b'])
  assert.equal(progress.passed, 0)
  const summary = summarize(events)
  assert.equal(summary.progress.nodes.n_b.status, 'passed', 'summary.progress.nodes 也要有')
  assert.equal(summary.progress.nodes.n_c.attemptId, 1)
})

/** attempt 1 判 fail、attempt 2 是否复判可控的验收 / 测试证据。 */
function staleEvents(rejudge) {
  const list = [
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 1 } }),
    ev('node/start', { nodeId: 'n_req', attemptId: 1, data: { title: '需求', mode: 'single', skills: [] } }),
    ev('acceptance/verdict', {
      nodeId: 'n_req', attemptId: 1,
      data: { itemId: 'R1', status: 'fail', decidedBy: 'auto' },
    }),
    ev('test/report', {
      nodeId: 'n_req', attemptId: 1,
      data: { suite: 'unit', executed: 3, passed: 1, failed: 2, skipped: 0, reportRef: 'ev/unit.json' },
    }),
    ev('node/end', { nodeId: 'n_req', attemptId: 1, data: { status: 'rejected', durationMs: 1 } }),
    ev('reject/trigger', {
      nodeId: 'n_req', attemptId: 1,
      data: { edgeId: 'e1', fromNodeId: 'n_req', toNodeId: 'n_req', reason: '返工' },
    }),
    ev('node/start', { nodeId: 'n_req', attemptId: 2, data: { title: '需求', mode: 'single', skills: [] } }),
    // attempt 2 只交了个新的通过条目 R2；旧的两条 fail 再没出现过。
    ev('acceptance/verdict', {
      nodeId: 'n_req', attemptId: 2,
      data: { itemId: 'R2', status: 'pass', decidedBy: 'auto', evidenceRef: 'ev/r2.md' },
    }),
  ]
  if (rejudge) {
    list.push(
      ev('acceptance/verdict', {
        nodeId: 'n_req', attemptId: 2,
        data: { itemId: 'R1', status: 'pass', decidedBy: 'auto', evidenceRef: 'ev/r1.md' },
      }),
      ev('test/report', {
        nodeId: 'n_req', attemptId: 2,
        data: { suite: 'unit', executed: 3, passed: 3, failed: 0, skipped: 0, reportRef: 'ev/unit2.json' },
      }),
    )
  }
  list.push(ev('node/end', { nodeId: 'n_req', attemptId: 2, data: { status: 'passed', durationMs: 1 } }))
  return list
}

check('§8.4 B4 旧 fail 未复判 → unknown：不能被下一轮的「不再提」洗成绿灯', () => {
  const events = staleEvents(false)
  const stale = computeStaleFails(events)
  assert.deepEqual(stale.acceptance, ['R1'])
  assert.deepEqual(stale.tests, ['unit'])
  assert.deepEqual(stale.checks, [])

  // 只看当前 attempt 时 R1 与 unit 的 fail 根本不在窗口里，旧的聚合会给 pass。
  assert.equal(computeAcceptance(events).state, 'pass', '前提：单看当前 attempt 就是假绿')

  const quality = computeQuality(events)
  assert.equal(quality.evidence.acceptance.state, 'unknown')
  assert.deepEqual(quality.evidence.acceptance.staleFails, ['R1'])
  assert.match(quality.evidence.acceptance.reason, /复判/)
  assert.equal(quality.evidence.tests.state, 'unknown')
  assert.deepEqual(quality.evidence.tests.staleFails, ['unit'])
  assert.notEqual(quality.state, 'pass', '有未复判的旧失败时不许给绿灯')
  assert.ok(quality.missing.includes('acceptance'), quality.missing.join(','))
})

check('§8.4 B4 复判过就不算 stale：attempt 2 重判 R1/unit 通过后回到 pass', () => {
  const events = staleEvents(true)
  assert.deepEqual(computeStaleFails(events), { acceptance: [], tests: [], checks: [] })
  const quality = computeQuality(events)
  assert.equal(quality.evidence.acceptance.state, 'pass')
  assert.equal(quality.evidence.tests.state, 'pass')
  assert.equal(quality.evidence.acceptance.staleFails, undefined)
})

check('§8.4 B4 第二轮改报 skip / na 不算复判：旧 fail 仍是 unknown（BLOCKER-1 回归）', () => {
  for (const status of ['skip', 'na']) {
    const events = [
      ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 1 } }),
      ev('node/start', { nodeId: 'n_dev', attemptId: 1, data: { title: '开发', mode: 'single', skills: [] } }),
      ev('acceptance/verdict', {
        nodeId: 'n_dev', attemptId: 1,
        data: { itemId: 'R1', status: 'fail', decidedBy: 'auto' },
      }),
      ev('node/end', { nodeId: 'n_dev', attemptId: 1, data: { status: 'rejected', durationMs: 1 } }),
      ev('reject/trigger', {
        nodeId: 'n_dev', attemptId: 1,
        data: { edgeId: 'e1', fromNodeId: 'n_dev', toNodeId: 'n_dev', reason: '返工' },
      }),
      ev('node/start', { nodeId: 'n_dev', attemptId: 2, data: { title: '开发', mode: 'single', skills: [] } }),
      // 把上一轮 fail 的条目改说成「跳过」，再补一条新的通过条目 —— 不能因此变成绿灯。
      ev('acceptance/verdict', {
        nodeId: 'n_dev', attemptId: 2,
        data: { itemId: 'R1', status, decidedBy: 'auto' },
      }),
      ev('acceptance/verdict', {
        nodeId: 'n_dev', attemptId: 2,
        data: { itemId: 'R2', status: 'pass', decidedBy: 'auto', evidenceRef: 'ev/r2.md' },
      }),
      ev('node/end', { nodeId: 'n_dev', attemptId: 2, data: { status: 'passed', durationMs: 1 } }),
    ]
    assert.equal(computeAcceptance(events).state, 'pass', '前提：单看当前 attempt 会把 R1 记成不适用')
    assert.deepEqual(computeStaleFails(events).acceptance, ['R1'])
    const quality = computeQuality(events)
    assert.equal(quality.evidence.acceptance.state, 'unknown', `状态改成 ${status} 也不能洗白`)
    assert.match(quality.evidence.acceptance.reason, /复判/)
  }
})

check('§8.4 B4 本轮真 fail 不被 stale 降级成 unknown（MAJOR-3 回归）', () => {
  const events = [
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 1 } }),
    ev('node/start', { nodeId: 'n_dev', attemptId: 1, data: { title: '开发', mode: 'single', skills: [] } }),
    ev('acceptance/verdict', {
      nodeId: 'n_dev', attemptId: 1,
      data: { itemId: 'R1', status: 'fail', decidedBy: 'auto' },
    }),
    ev('reject/trigger', {
      nodeId: 'n_dev', attemptId: 1,
      data: { edgeId: 'e1', fromNodeId: 'n_dev', toNodeId: 'n_dev', reason: '返工' },
    }),
    ev('node/start', { nodeId: 'n_dev', attemptId: 2, data: { title: '开发', mode: 'single', skills: [] } }),
    // 本轮真的判了一条 fail（且旧 R1 没复判）：结论必须是 fail，不是 unknown。
    ev('acceptance/verdict', {
      nodeId: 'n_dev', attemptId: 2,
      data: { itemId: 'R3', status: 'fail', decidedBy: 'auto' },
    }),
    ev('node/end', { nodeId: 'n_dev', attemptId: 2, data: { status: 'failed', durationMs: 1 } }),
  ]
  const quality = computeQuality(events)
  assert.equal(quality.evidence.acceptance.state, 'fail')
  assert.equal(quality.state, 'fail')
  assert.deepEqual(quality.evidence.acceptance.staleFails, ['R1'], '未复判的旧 fail 仍要列出来')
})

// ---------------------------------------------------------------------------
// v1.3：P0/P1/P2 分级门禁、跨 attempt 账本（分母不缩水）、证据独立性
// ---------------------------------------------------------------------------

check('quality v1.3：首轮通过 + 遗留 1 个 P1 → warn「遗留 1 个 P1 未解决」', () => {
  const quality = computeQuality(fullEvidence({ rework: 0, p1Status: 'open' }))
  assert.equal(quality.state, 'warn')
  assert.equal(quality.label, '可：遗留 1 个 P1 未解决')
  assert.equal(quality.p1Unresolved, 1)
  assert.equal(quality.evidence.p0p1.state, 'warn')
  assert.equal(quality.evidence.acceptance.state, 'pass', '首轮证据本身仍是通过')
})

check('quality v1.3：首轮通过 + 遗留 1 个 P2 → warn（P2 也压住绿灯）', () => {
  const quality = computeQuality(fullEvidence({ rework: 0, p2Status: 'fixed' }))
  assert.equal(quality.state, 'warn')
  assert.equal(quality.label, '可：遗留 1 个 P2 未解决')
  assert.equal(quality.p2Unresolved, 1)
})

check('quality v1.3：未解决 P0 仍然 fail（P0 压过 P1/P2 的 warn）', () => {
  const quality = computeQuality(fullEvidence({
    rework: 0, p0Status: 'open', p1Status: 'open', p2Status: 'open',
  }))
  assert.equal(quality.state, 'fail')
  assert.equal(quality.evidence.p0p1.state, 'fail')
  assert.match(quality.label, /P0 缺陷/)
  assert.equal(quality.p0Unresolved, 1)
})

/** v1.3：attempt 1 报 10 个通过标识，attempt 2 只复判第 1 个 → 其余必须计入 stale。 */
function shrinkAttempt(metric) {
  const ids = Array.from({ length: 10 }, (_, i) => `X${String(i + 1).padStart(2, '0')}`)
  const emit = (attemptId, id) => {
    if (metric === 'acceptance') {
      return ev('acceptance/verdict', {
        nodeId: 'n_dev', attemptId,
        data: { itemId: id, status: 'pass', decidedBy: 'auto', evidenceRef: `ev/${id}.md` },
      })
    }
    if (metric === 'tests') {
      return ev('test/report', {
        nodeId: 'n_dev', attemptId,
        data: { suite: id, executed: 1, passed: 1, failed: 0, skipped: 0, reportRef: `ev/${id}.json` },
      })
    }
    return ev('check/form', {
      nodeId: 'n_dev', attemptId,
      data: {
        ruleSetId: id, ruleSetVersion: '1', executor: 'eslint',
        state: 'pass', passedChecks: 1, totalChecks: 1,
        executedAt: '2026-11-06T10:00:00.000Z',
      },
    })
  }
  return [
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 1 } }),
    ev('node/start', { nodeId: 'n_dev', attemptId: 1, data: { title: '开发', mode: 'single', skills: [] } }),
    ...ids.map(id => emit(1, id)),
    ev('node/end', { nodeId: 'n_dev', attemptId: 1, data: { status: 'rejected', durationMs: 1 } }),
    ev('reject/trigger', {
      nodeId: 'n_dev', attemptId: 1,
      data: { edgeId: 'e1', fromNodeId: 'n_dev', toNodeId: 'n_dev', reason: '返工' },
    }),
    ev('node/start', { nodeId: 'n_dev', attemptId: 2, data: { title: '开发', mode: 'single', skills: [] } }),
    emit(2, ids[0]),
    ev('node/end', { nodeId: 'n_dev', attemptId: 2, data: { status: 'passed', durationMs: 1 } }),
  ]
}

const SHRINK_IDS = ['X02', 'X03', 'X04', 'X05', 'X06', 'X07', 'X08', 'X09', 'X10']

check('v1.3 跨 attempt：验收条目 10 → 1 时分母不缩水，9 条未复判 → unknown', () => {
  const events = shrinkAttempt('acceptance')
  assert.equal(computeAcceptance(events).state, 'pass', '前提：单看当前 attempt 只有 1 条且通过')
  assert.deepEqual(computeStaleFails(events).acceptance, SHRINK_IDS)
  const quality = computeQuality(events)
  assert.equal(quality.evidence.acceptance.state, 'unknown')
  assert.match(quality.evidence.acceptance.reason, /9 条上一轮出现过、本轮没有复判为通过/)
  // 只在当前 attempt 首次出现的新标识不受影响。
  const withNew = [...events, ev('acceptance/verdict', {
    nodeId: 'n_dev', attemptId: 2,
    data: { itemId: 'NEW', status: 'pass', decidedBy: 'auto', evidenceRef: 'ev/NEW.md' },
  })]
  assert.equal(computeStaleFails(withNew).acceptance.length, 9)
})

check('v1.3 跨 attempt：测试套件 10 → 1 时 9 个未复判 → unknown', () => {
  const events = shrinkAttempt('tests')
  assert.equal(computeTests(events).state, 'pass', '前提：单看当前 attempt 只有 1 个套件且通过')
  assert.deepEqual(computeStaleFails(events).tests, SHRINK_IDS)
  const quality = computeQuality(events)
  assert.equal(quality.evidence.tests.state, 'unknown')
  assert.match(quality.evidence.tests.reason, /9 条上一轮出现过、本轮没有复判为通过/)
})

check('v1.3 跨 attempt：规则集 10 → 1 时 9 个未复判 → unknown', () => {
  const events = shrinkAttempt('checks')
  assert.deepEqual(computeStaleFails(events).checks, SHRINK_IDS)
  const quality = computeQuality(events)
  assert.equal(quality.evidence.checks.state, 'unknown')
  assert.deepEqual(quality.evidence.checks.staleFails, SHRINK_IDS)
  assert.match(quality.evidence.checks.reason, /9 条上一轮出现过、本轮没有复判为通过/)
})

const SELF_SHA = 'c'.repeat(64)
/** v1.3：产物事件；producer='host' 表示宿主生成 / 标记。 */
function artifactAt(path, nodeId, producer = null) {
  const event = ev('artifact/write', {
    nodeId, attemptId: 1,
    data: { path, bytes: 1, kind: 'md', sha256: SELF_SHA },
  })
  if (producer) event.extra = { producer }
  return event
}

check('v1.3 证据独立性：全自证 → 指标仍 pass、selfCertified=2、selfOnly=true', () => {
  const events = [
    artifactAt('ev/a.md', 'n_acc'),
    artifactAt('ev/b.md', 'n_acc'),
    ev('acceptance/verdict', {
      nodeId: 'n_acc', attemptId: 1,
      data: { itemId: 'A', status: 'pass', decidedBy: 'auto', evidenceRef: 'ev/a.md' },
    }),
    ev('acceptance/verdict', {
      nodeId: 'n_acc', attemptId: 1,
      data: { itemId: 'B', status: 'pass', decidedBy: 'auto', evidenceRef: 'ev/b.md' },
    }),
  ]
  const acceptance = computeAcceptance(events)
  assert.equal(acceptance.state, 'pass', '自证是「有证据但不独立」，不是缺证据')
  assert.equal(acceptance.passed, 2)
  assert.equal(acceptance.selfCertified, 2, '两条通过条目的产物都是本节点写的')
  assert.equal(acceptance.selfOnly, true, '通过条目全部自证 → selfOnly')
})

check('v1.3 证据独立性：混一条 peer + 一条 host → pass、selfCertified=1、selfOnly=false', () => {
  const events = [
    artifactAt('ev/a.md', 'n_acc'),
    artifactAt('ev/b.md', 'n_other'),
    artifactAt('ev/h.md', 'n_any', 'host'),
    ev('acceptance/verdict', {
      nodeId: 'n_acc', attemptId: 1,
      data: { itemId: 'A', status: 'pass', decidedBy: 'auto', evidenceRef: 'ev/a.md' },
    }),
    ev('acceptance/verdict', {
      nodeId: 'n_acc', attemptId: 1,
      data: { itemId: 'B', status: 'pass', decidedBy: 'auto', evidenceRef: 'ev/b.md' },
    }),
    ev('acceptance/verdict', {
      nodeId: 'n_acc', attemptId: 1,
      data: { itemId: 'H', status: 'pass', decidedBy: 'auto', evidenceRef: 'ev/h.md' },
    }),
  ]
  const acceptance = computeAcceptance(events)
  assert.equal(acceptance.state, 'pass')
  assert.equal(acceptance.passed, 3)
  assert.equal(acceptance.selfCertified, 1, 'peer / host 级证据不计入自证')
  assert.equal(acceptance.selfOnly, false, '有 peer/host 级交叉证据就不是闭环')
})

check('v1.3 证据独立性：测试 / 规则集也按产物归属计数 selfCertified / selfOnly', () => {
  const events = [
    artifactAt('ev/t.json', 'n_test'),
    artifactAt('ev/r.json', 'n_check'),
    ev('test/report', {
      nodeId: 'n_test', attemptId: 1,
      data: { suite: 'unit', executed: 1, passed: 1, failed: 0, skipped: 0, reportRef: 'ev/t.json' },
    }),
    ev('check/form', {
      nodeId: 'n_check', attemptId: 1,
      data: {
        ruleSetId: 'eslint', ruleSetVersion: '1', executor: 'eslint',
        state: 'pass', passedChecks: 1, totalChecks: 1, reportRef: 'ev/r.json',
      },
    }),
  ]
  const tests = computeTests(events)
  assert.equal(tests.state, 'pass')
  assert.equal(tests.selfCertified, 1)
  assert.equal(tests.selfOnly, true)
  const quality = computeQuality(events)
  assert.equal(quality.evidence.checks.state, 'pass')
  assert.equal(quality.evidence.checks.selfCertified, 1)
  assert.equal(quality.evidence.checks.selfOnly, true)
})

const CLAIM_NODE = { acceptance: 'n_acc', tests: 'n_test', checks: 'n_check' }

/** v1.3：按指标造「自证 / 独立」通过条目。mode = self | peer | host | mixed。 */
function ownershipEvents(metric, mode) {
  const claimNode = CLAIM_NODE[metric]
  const entries = mode === 'mixed'
    ? [{ writer: claimNode }, { writer: 'n_peer' }]
    : [{ writer: mode === 'self' ? claimNode : (mode === 'host' ? 'n_host' : 'n_peer'), host: mode === 'host' }]
  const events = []
  entries.forEach((entry, index) => {
    const id = `${metric}-${index}`
    const ref = `ev/${id}.json`
    events.push(artifactAt(ref, entry.writer, entry.host ? 'host' : null))
    if (metric === 'acceptance') {
      events.push(ev('acceptance/verdict', {
        nodeId: claimNode, attemptId: 1,
        data: { itemId: id, status: 'pass', decidedBy: 'auto', evidenceRef: ref },
      }))
    } else if (metric === 'tests') {
      events.push(ev('test/report', {
        nodeId: claimNode, attemptId: 1,
        data: { suite: id, executed: 1, passed: 1, failed: 0, skipped: 0, reportRef: ref },
      }))
    } else {
      events.push(ev('check/form', {
        nodeId: claimNode, attemptId: 1,
        data: {
          ruleSetId: id, ruleSetVersion: '1', executor: 'eslint',
          state: 'pass', passedChecks: 1, totalChecks: 1, reportRef: ref,
        },
      }))
    }
  })
  return events
}

/** v1.3：五项证据齐全，三项证据指标的证据归属由 spec 控制（默认 peer = 独立证据）。 */
function ownershipFixture(spec = {}, p1Status = 'verified') {
  const base = fullEvidence({ rework: 0, p1Status, withTests: false, withChecks: false })
    .filter(event => event.kind !== 'acceptance/verdict')
  const events = [...base]
  for (const metric of ['acceptance', 'tests', 'checks']) {
    events.push(...ownershipEvents(metric, spec[metric] || 'peer'))
  }
  return events
}

check('v1.3 结论层：三项指标全部自证 → warn（label 提到自证）', () => {
  const quality = computeQuality(ownershipFixture({ acceptance: 'self', tests: 'self', checks: 'self' }))
  assert.equal(quality.state, 'warn')
  assert.match(quality.label, /验收条目、测试、规范 全部为自证证据（3 条），缺独立复核/)
  assert.equal(quality.selfCertified, 3)
  for (const key of ['acceptance', 'tests', 'checks']) {
    assert.equal(quality.evidence[key].selfOnly, true, `${key} 应 selfOnly`)
  }
})

check('v1.3 结论层：acceptance 全自证 + tests 混 peer → 因 acceptance selfOnly 仍 warn', () => {
  const quality = computeQuality(ownershipFixture({ acceptance: 'self', tests: 'mixed', checks: 'mixed' }))
  assert.equal(quality.evidence.acceptance.selfOnly, true)
  assert.equal(quality.evidence.tests.selfOnly, false)
  assert.equal(quality.evidence.checks.selfOnly, false)
  assert.equal(quality.state, 'warn')
  assert.match(quality.label, /验收条目 全部为自证证据（1 条），缺独立复核/)
})

check('v1.3 结论层：三项指标各含至少一条 peer/host → 可以 pass，selfCertified 计数正确', () => {
  const quality = computeQuality(ownershipFixture({ acceptance: 'mixed', tests: 'mixed', checks: 'host' }))
  assert.equal(quality.evidence.acceptance.selfOnly, false)
  assert.equal(quality.evidence.tests.selfOnly, false)
  assert.equal(quality.evidence.checks.selfOnly, false)
  assert.equal(quality.selfCertified, 2, 'acceptance 1 条 + tests 1 条自证；checks 全是 host')
  assert.equal(quality.state, 'pass')
  assert.equal(quality.label, '优：首轮通过')
})

check('v1.3 结论层：全自证 warn 与 P1 遗留 warn 汇合，两个原因都写进 label', () => {
  const quality = computeQuality(ownershipFixture(
    { acceptance: 'self', tests: 'self', checks: 'self' },
    'open',
  ))
  assert.equal(quality.state, 'warn')
  assert.match(quality.label, /遗留 1 个 P1 未解决/)
  assert.match(quality.label, /全部为自证证据（3 条），缺独立复核/)
})

check('v0.8 节点闹钟：node/status 通过校验并归一化（可选字段收敛、成员/阻塞项有界）', () => {
  const event = ok(base({
    kind: 'node/status',
    data: {
      state: 'done',
      progress: 88,
      summary: '子 agent 都收工了',
      verdict: 'pass',
      source: 'self-check',
      members: [{ name: '实现', state: 'done', note: '' }],
      blockers: ['等待依赖'],
    },
  }))
  assert.equal(event.data.state, 'done')
  assert.equal(event.data.progress, 88)
  assert.equal(event.data.verdict, 'pass')
  assert.deepEqual(event.data.members, [{ name: '实现', state: 'done' }])
  assert.deepEqual(event.data.blockers, ['等待依赖'])
})

check('v0.8 节点闹钟：node/status 的坏输入逐条拒绝（枚举/越界/超量/缺字段）', () => {
  bad(base({ kind: 'node/status', data: { state: 'whatever', progress: 10 } }), 'data.state')
  bad(base({ kind: 'node/status', data: { state: 'working', progress: 101 } }), 'data.progress')
  bad(base({ kind: 'node/status', data: { state: 'working' } }), 'data.progress')
  bad(base({ kind: 'node/status', data: { state: 'done', progress: 1, verdict: 'maybe' } }), 'data.verdict')
  bad(base({
    kind: 'node/status',
    data: { state: 'working', progress: 1, members: Array.from({ length: 21 }, () => ({ name: 'x' })) },
  }), 'data.members')
})

console.log('runlog.js · 状态机转移观测（machine/transition，08 §7）')

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** machine/transition 事件夹具；顶层 nodeId + attemptId 沿用节点级事件口径。 */
function transition(over = {}, dataOver = {}) {
  return base({
    kind: 'machine/transition',
    nodeId: 'n_a',
    data: { from: 'n_a', to: 'n_b', event: 'PASS', ...dataOver },
    ...over,
  })
}

check('machine/transition 白名单：走独立扩展数组，v1.0 的 EVENT_KINDS 仍是 17 种且不可变', () => {
  assert.ok(Object.isFrozen(MACHINE_EVENT_KINDS), '扩展白名单同样不可变')
  assert.deepEqual([...MACHINE_EVENT_KINDS], ['machine/transition'])
  assert.equal(EVENT_KINDS.length, 17, 'machine/transition 不进 05 §2 冻结的 17 种基础事件')
  assert.equal(EVENT_KINDS.includes('machine/transition'), false)
  assert.equal(ok(transition()).kind, 'machine/transition')
})

check('machine/transition 最小合法：只有 to + event 通过（from / version / attempt 不补默认值）', () => {
  const event = ok(base({ kind: 'machine/transition', data: { to: 'n_b', event: 'PASS' } }))
  assert.deepEqual(event.data, { to: 'n_b', event: 'PASS' })
  // from / version 的空串与纯空白都视为「没写」，不整条拒绝、也不写回空串。
  for (const blank of ['', '   ']) {
    const minimal = ok(base({ kind: 'machine/transition', data: { from: blank, version: blank, to: 'n_b', event: 'PASS' } }))
    assert.equal(Object.hasOwn(minimal.data, 'from'), false)
    assert.equal(Object.hasOwn(minimal.data, 'version'), false)
  }
})

check('machine/transition 必填 / 有界：to、event 缺失或空串、from 超 64、version 超 200 → 拒绝', () => {
  bad(base({ kind: 'machine/transition', data: { event: 'PASS' } }), 'data.to')
  bad(base({ kind: 'machine/transition', data: { to: '', event: 'PASS' } }), 'data.to')
  bad(base({ kind: 'machine/transition', data: { to: '   ', event: 'PASS' } }), 'data.to')
  bad(base({ kind: 'machine/transition', data: { to: 'n'.repeat(65), event: 'PASS' } }), 'data.to')
  bad(base({ kind: 'machine/transition', data: { to: 'n_b' } }), 'data.event')
  bad(base({ kind: 'machine/transition', data: { to: 'n_b', event: '' } }), 'data.event')
  bad(base({ kind: 'machine/transition', data: { to: 'n_b', event: 'P'.repeat(65) } }), 'data.event')
  bad(transition({}, { from: 'a'.repeat(65) }), 'data.from')
  bad(transition({}, { version: 'v'.repeat(201) }), 'data.version')
  // 只放宽「空串」，不放宽类型：数字 / 对象照旧拒绝。
  bad(transition({}, { from: 7 }), 'data.from')
  bad(transition({}, { version: 7 }), 'data.version')
})

check('machine/transition attempt：0 / 1.5 / "2" / 负数 → 整条拒绝；1 与 2 通过', () => {
  bad(transition({}, { attempt: 0 }), 'data.attempt')
  bad(transition({}, { attempt: 1.5 }), 'data.attempt')
  bad(transition({}, { attempt: '2' }), 'data.attempt')
  bad(transition({}, { attempt: -1 }), 'data.attempt')
  bad(transition({}, { attempt: Number.POSITIVE_INFINITY }), 'data.attempt')
  assert.equal(ok(transition({}, { attempt: 1 })).data.attempt, 1)
  assert.equal(ok(transition({}, { attempt: 2 })).data.attempt, 2)
})

check('machine/transition 未知多余键：按 validateData 既有口径保留（不是 message/* 的严格白名单）', () => {
  const event = ok(transition({}, { note: '额外字段', nested: { a: 1 } }))
  assert.equal(event.data.note, '额外字段')
  assert.deepEqual(event.data.nested, { a: 1 })
  // 已知字段仍按契约归一化：空 from 被删掉，不会被「保留未知键」的口径带回来。
  const withBlank = ok(transition({}, { from: '', note: 'x' }))
  assert.equal(Object.hasOwn(withBlank.data, 'from'), false)
  assert.equal(withBlank.data.note, 'x')
})

check('machine/transition 是节点级事件：缺 nodeId / attemptId 一样拒绝（run 级写法不合法）', () => {
  bad({ ...base({ kind: 'machine/transition', data: { to: 'n_b', event: 'PASS' } }), nodeId: undefined }, 'nodeId')
  bad({ ...base({ kind: 'machine/transition', data: { to: 'n_b', event: 'PASS' } }), attemptId: undefined }, 'attemptId')
})

check('摘要行两态：无 attempt = `n_a → n_b · PASS`；有 attempt 追加 ` · attempt=2`', () => {
  assert.equal(machineTransitionSummary({ from: 'n_a', to: 'n_b', event: 'PASS' }), 'n_a → n_b · PASS')
  assert.equal(
    machineTransitionSummary({ from: 'n_a', to: 'n_b', event: 'PASS', attempt: 2 }),
    'n_a → n_b · PASS · attempt=2',
  )
  // 初始态没有 from：不编造起点；非整数 attempt 不展示。
  assert.equal(machineTransitionSummary({ to: 'n_a', event: 'CLOCK_TIMEOUT' }), '? → n_a · CLOCK_TIMEOUT')
  assert.equal(
    machineTransitionSummary({ from: 'n_a', to: '#done', event: 'PASS', attempt: 1.5 }),
    'n_a → #done · PASS',
  )
})

await checkAsync('machine/transition 全字段：通过校验，落盘后 readAllEvents 原样读回', async () => {
  const event = ok(transition({}, {
    from: 'n_a',
    to: 'n_b',
    event: 'REJECT',
    version: 'v1-0123456789abcdef',
    attempt: 2,
  }))
  assert.deepEqual(event.data, {
    from: 'n_a', to: 'n_b', event: 'REJECT', version: 'v1-0123456789abcdef', attempt: 2,
  })
  const store = await import('../src/runstore.js')
  mkdirSync(join(REPO_ROOT, '.tmp'), { recursive: true })
  const home = mkdtempSync(join(REPO_ROOT, '.tmp', 'runlog-machine-'))
  try {
    const runsRoot = store.runsDir(home)
    const meta = await store.createRun(runsRoot, { id: RUN, flowId: 'flow-machine', nodeTotal: 2 })
    await store.appendEvents(runsRoot, meta.id, [event], { now: NOW })
    const read = await store.readAllEvents(runsRoot, meta.id)
    assert.equal(read.events.length, 1)
    // seq 由 runstore 追加；其余字段（含 data 全字段）必须原样回来。
    assert.deepEqual(read.events[0], { ...event, seq: 1 })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

console.log(`\n${checks} 组通过`)
