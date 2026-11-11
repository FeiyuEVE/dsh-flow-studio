#!/usr/bin/env node
/**
 * 运行日志纯函数自检：事件校验 / 归一化 / 有界 extra / 聚合口径（0.13.12 起不再有质量总评分）。
 *
 * 不需要浏览器；除「落盘后 readAllEvents 读回」一组用 `.tmp/` 造临时 run 目录外，其余
 * 都是纯函数、不碰 fs：直接 `node test/runlog.test.mjs`。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EVENT_KINDS, MACHINE_EVENT_KINDS, MAX_EVENT_BYTES, MAX_EXTRA_BYTES, NODE_TOOLS_EVENT_KINDS,
  NODE_TOOL_NAME_MAX, NODE_TOOL_NAME_PATTERN, NODE_TOOLS_MAX, checkRunId, collectArtifactIndex,
  computeAcceptance, computeAgentActivity, computeConflicts, computeFindings, computeProgress,
  computeRejects, computeSkillUsage, computeTests, computeTokens, isSafeRelPath,
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

check('engine.redactArguments 与宿主检查摘要：空格/引号分隔的凭据也不落原文（0.11 N3 接线）', () => {
  // 旧实现只认 `key:value|key=value`，`--token <值>` 这种空格形态会原样进 commandSummary。
  const flagSecrets = [
    'curl --token canary-space-9f http://127.0.0.1/report.json',
    'cli --api-key=canary-eq-77 --verbose',
    'curl -H "Authorization: Bearer canary-header-3" http://x',
    "run --password 'canary two words'",
  ]
  for (const raw of flagSecrets) {
    const redacted = engineModule.redactArguments(raw)
    for (const canary of ['canary-space-9f', 'canary-eq-77', 'canary-header-3', 'canary two words']) {
      assert.equal(redacted.includes(canary), false, `脱敏后不得含 ${canary}：${redacted}`)
    }
    assert.ok(redacted.includes('[REDACTED]'), `必须保留 [REDACTED] 标记：${redacted}`)
    // 非凭据部分必须原样保留，不能因为脱敏把命令改得不可读。
    assert.ok(redacted.includes('--token') || redacted.includes('--api-key')
      || redacted.includes('Authorization:') || redacted.includes('--password'), `参数名必须保留：${redacted}`)
  }
  // 参数名必须完整：`--token-file` 后面的正常文件名不能被吞掉。
  const notSecret = 'cat --token-file reports/unit.json'
  assert.equal(engineModule.redactArguments(notSecret), notSecret, '--token-file 不得被当成 --token')
  // summarizeHostCheckCommand 走同一条规则，并且仍然按 200 字符截断。
  const summary = engineModule.summarizeHostCheckCommand('run --token canary-sum-1 --out report.json')
  assert.equal(summary.includes('canary-sum-1'), false, `commandSummary 不得含原始 token：${summary}`)
  assert.ok(summary.length <= 203, `摘要仍需有界：${summary.length}`)
  // 截断口径：用不含可疑串的长命令，验证仍按 200 截断（`x` 连写会先被 ≥32 规则替换）。
  assert.equal(engineModule.summarizeHostCheckCommand('run --check '.repeat(50)).length, 200, '超长命令截断到 200')
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
  assert.ok('tokens' in summary && 'progress' in summary)
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

/**
 * 0.11 N1：三项证据都带宿主权威来源的「正常 run」夹具（coverage=1，可 pass）。
 * 与 fullEvidence()（全 legacy、无来源）刻意区分：legacy 不得再借旧口径点亮 pass。
 */
function hostEvidence(over = {}) {
  const events = fullEvidence(over)
  for (const kind of ['acceptance/verdict', 'test/report', 'check/form']) {
    const event = events.find(item => item.kind === kind)
    if (event) event.extra = { ...(event.extra || {}), producer: 'host', authority: 'host' }
  }
  return events
}

/** 宿主权威验证器：只在这些纯函数夹具里表示「已由 Host 登记核对」。 */
const HOST_VERIFY = { verifyHostExecution: () => true }

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
  for (const key of ['tokens', 'skillUsage', 'findings', 'rejects', 'progress']) {
    assert.ok(Object.hasOwn(summary, key), `summary 缺 ${key}`)
  }
  assert.equal(summary.tokens.total.total, 20)
  assert.equal(summary.usage.unkeyedCalls, 1, '没有 callId 的历史用量要单列')
  assert.equal(summary.truncated, false)
  assert.equal(summarize(events, { now: NOW, truncated: true }).truncated, true)
})

check('export markdown 含 run 头与指标小节（不再含质量结论）', () => {
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
  assert.equal(markdown.includes('## 质量结论'), false, '0.13.12 起导出不再包含质量总评分')
  assert.equal(markdown.includes('`unknown`'), false)
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
  const summary = summarize(events)
  assert.equal(summary.conflicts.acceptance.length, 1)
  assert.equal(summary.conflicts.tests.length, 1)
})

check('§13.7 stub 引擎：summary.engine=stub；不再返回 quality', () => {
  const events = [
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 1 } }),
    ev('node/end', { nodeId: 'n1', attemptId: 1, data: { status: 'passed', durationMs: 1 } }),
  ]
  const summary = summarize(events, { engine: 'stub' })
  assert.equal(summary.engine, 'stub')
  assert.equal(Object.hasOwn(summary, 'quality'), false)
  const fromEvent = summarize([
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 2, engine: 'stub' } }),
    ...events.slice(1),
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
})

const CLAIM_NODE = { acceptance: 'n_acc', tests: 'n_test', checks: 'n_check' }

/** v1.3：按指标造「自证 / 独立」通过条目。mode = self | peer | host | mixed。 */
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

console.log('runlog.js · 节点可用工具快照（node/tools，0.10 R6）')

/** node/tools 事件夹具：节点级事件（nodeId + attemptId）。 */
function nodeTools(tools = ['bash', 'read', 'write'], over = {}, dataOver = {}) {
  return base({
    kind: 'node/tools',
    nodeId: 'n_a',
    attemptId: 1,
    data: { tools, toolsSource: 'session', count: tools.length, ...dataOver },
    ...over,
  })
}

check('node/tools 白名单：走独立扩展数组，EVENT_KINDS 仍是 17 种且不可变', () => {
  assert.ok(Object.isFrozen(NODE_TOOLS_EVENT_KINDS), '扩展白名单不可变')
  assert.deepEqual([...NODE_TOOLS_EVENT_KINDS], ['node/tools'])
  assert.equal(EVENT_KINDS.length, 17, 'node/tools 不进 05 §2 冻结的 17 种基础事件')
  assert.equal(EVENT_KINDS.includes('node/tools'), false)
  assert.equal(NODE_TOOLS_MAX, 64)
  assert.equal(NODE_TOOL_NAME_MAX, 64)
  assert.ok(NODE_TOOL_NAME_PATTERN.test('flow_node_reject'), '下划线必须被允许（打回工具名）')
  assert.ok(NODE_TOOL_NAME_PATTERN.test('a.b:c-d_e'), '点 / 冒号 / 连字符同样允许')
  assert.equal(NODE_TOOL_NAME_PATTERN.test('has space'), false)
  assert.equal(NODE_TOOL_NAME_PATTERN.test('x'.repeat(65)), false, '长度上限也在 pattern 里')
})

check('node/tools 合法：去重由采集端保证，校验器原样保留（含 truncated）', () => {
  const event = ok(nodeTools(['bash', 'flow_node_reject', 'read']))
  assert.equal(event.kind, 'node/tools')
  assert.deepEqual(event.data, {
    tools: ['bash', 'flow_node_reject', 'read'],
    toolsSource: 'session',
    count: 3,
  })
  const unavailable = ok(nodeTools([], {}, { toolsSource: 'unavailable' }))
  assert.deepEqual(unavailable.data, { tools: [], toolsSource: 'unavailable', count: 0 })
  const truncated = ok(nodeTools(['bash'], {}, { truncated: true }))
  assert.equal(truncated.data.truncated, true)
  // 没有 truncated 时不补默认值（与其它可选字段同口径）。
  assert.equal(Object.hasOwn(event.data, 'truncated'), false)
})

check('node/tools 坏输入逐条拒绝：未知 source / 非数组 / >64 / 名字非法 / count 不等 / 重复', () => {
  bad(nodeTools(['bash'], {}, { toolsSource: 'host' }), 'data.toolsSource')
  bad(nodeTools(['bash'], {}, { toolsSource: undefined }), 'data.toolsSource')
  bad(nodeTools('bash'), 'data.tools')
  bad(nodeTools(['bash'.repeat(1)].concat(Array.from({ length: 64 }, (_, index) => `tool-${index}`))), 'data.tools')
  bad(nodeTools(['']), 'data.tools')
  bad(nodeTools(['has space']), 'data.tools')
  bad(nodeTools(['x'.repeat(65)]), 'data.tools')
  bad(nodeTools(['bash'], {}, { count: 2 }), 'data.count')
  bad(nodeTools(['bash'], {}, { count: '1' }), 'data.count')
  bad(nodeTools(['bash'], {}, { count: undefined }), 'data.count')
  bad(nodeTools(['bash', 'bash']), 'data.tools')
  bad(nodeTools(['bash'], {}, { truncated: 'yes' }), 'data.truncated')
})

check('node/tools digest：事件表里给出中文摘要，不是空行', () => {
  const events = [
    ev('run/start', { data: { flowId: 'f', flowName: 'F', nodeTotal: 1 } }),
    ev('node/tools', { nodeId: 'n_a', attemptId: 1, data: { tools: ['bash', 'read'], toolsSource: 'session', count: 2 } }),
  ]
  const summary = summarize(events, { now: NOW })
  const markdown = renderRunMarkdown({
    id: RUN, name: '工具清单 run', flowId: 'f', flowName: 'F', status: 'running',
    startedAt: NOW.toISOString(),
  }, events, summary)
  assert.ok(markdown.includes('可用工具 2 个'), 'node/tools 在时间线里要有摘要')
})

check('node/tools 8KB 边界：64×64 名字仍可通过；再塞未知大字段整条拒绝', () => {
  const names = Array.from({ length: NODE_TOOLS_MAX }, (_, index) => (
    `t${String(index).padStart(2, '0')}${'x'.repeat(61)}`
  ))
  for (const name of names) assert.equal(name.length, 64)
  const full = ok(nodeTools(names))
  assert.equal(full.data.count, 64)
  const bytes = Buffer.byteLength(JSON.stringify(full), 'utf8')
  assert.ok(bytes < MAX_EVENT_BYTES, `64 项 × 64 字符必须仍在 8KB 内（实际 ${bytes}）`)
  // 未知 data 键按既有口径保留，体积由单条 8KB 上限兜住 → 超限整条拒绝。
  bad(nodeTools(['bash'], {}, { blob: 'x'.repeat(MAX_EVENT_BYTES) }), 'event')
})

console.log('runlog.js · 0.11 R4：外部来源隔离（权威索引之前分区）')

// 追加段单独 import，避免改动文件头既有的 import 列表 / 断言。
import { EXTERNAL_OBSERVATION_LIMIT, classifyEvidenceAuthority, collectArtifactOwners, isExternalEvent } from '../src/runlog.js'

/** 外部来源事件夹具：只通过 extra.source / producer 标记，不靠 data 自报。 */
function externalEv(kind, over = {}) {
  return ev(kind, {
    ...over,
    extra: { source: 'external', producer: 'external', authority: 'unverified', ...(over.extra || {}) },
  })
}

check('R4 来源判定：只认 extra.source / producer，不猜 host，也不认 data.external 自报标记', () => {
  assert.equal(isExternalEvent({ kind: 'x', extra: { source: 'external' } }), true)
  assert.equal(isExternalEvent({ kind: 'x', extra: { producer: 'external' } }), true)
  assert.equal(isExternalEvent({ kind: 'x', extra: { source: 'host', producer: 'host' } }), false)
  assert.equal(isExternalEvent({ kind: 'x', data: { external: true } }), false, 'data.external 只是来客自报，不能授信')
  assert.equal(isExternalEvent({ kind: 'x' }), false, '无 source 的旧事件是 legacy，不猜 host')
  assert.equal(classifyEvidenceAuthority({ extra: { source: 'external' } }), 'external')
  // 0.11 R6（返工）：没有验证器的纯函数不得把 producer=host 当权威。
  assert.equal(classifyEvidenceAuthority({ extra: { producer: 'host' } }), 'model-claim')
  assert.equal(classifyEvidenceAuthority({ extra: { producer: 'host' } }, { verifyHostExecution: () => true }), 'host')
  assert.equal(classifyEvidenceAuthority({ extra: { authority: 'host' } }), 'model-claim')
  assert.equal(classifyEvidenceAuthority({ extra: { authority: 'host' } }, { verifyHostExecution: () => true }), 'host')
  assert.equal(classifyEvidenceAuthority({ extra: { provenance: 'model-claim' } }), 'model-claim')
  assert.equal(classifyEvidenceAuthority({ extra: { provenance: 'engine' } }), 'engine')
  assert.equal(classifyEvidenceAuthority({ extra: { provenance: 'stub-synthetic' } }), 'engine')
  assert.equal(classifyEvidenceAuthority({}), 'legacy')
  assert.equal(classifyEvidenceAuthority({ extra: { note: 'x' } }), 'legacy')
})

console.log(`\n${checks} 组通过`)
