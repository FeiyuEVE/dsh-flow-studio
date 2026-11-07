#!/usr/bin/env node
/**
 * 运行日志抽屉（详情可放大 + agent 实时活动）自检。
 *
 * 与 render.test.mjs 同风格：自造 fixture + React 18 服务端渲染，只断言
 * 「静态渲染能证明的东西」。SSR 不跑 useEffect，所以 Esc / 焦点这类交互
 * 用抽屉导出的纯函数（drawerEscapeAction / lowerDrawerZoom）验证代码路径。
 *
 * 跑法：node test/logdrawer.test.mjs
 */

import assert from 'node:assert/strict'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

function render(element) {
  return renderToStaticMarkup(element)
}

async function checkAsync(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

const { bindReact, rt } = await import('../src/client/runtime.js')
bindReact(React)

const {
  AGENT_ACTIVITY_LIMIT, DRAWER_ZOOM_LEVELS, FsLogDrawer,
  LogTextOverlay, PRESET_SOURCE_TEXT, RESTARTABLE_STATUSES,
  activityMessagesOf, canRestartInPlace, drawerEscapeAction, drawerZoomInfo, eventKey,
  eventLongTextOf, lowerDrawerZoom, nodeActivityOf, nodeArtifactsOf, nodeToolsAvailableOf,
  nodeToolsOf, nodeUsageOf, normalizeRun, normalizeDrawerZoom, presetInfoOf, raiseDrawerZoom,
  sessionTargetOf, EVENT_KINDS, WATCH_EVENT_KINDS, eventSummary,
} = await import('../src/client/logdrawer.js')
const { CSS } = await import('../src/client/styles.js')
const { restartFailureText, runActionFailureText } = await import('../src/client/api.js')

// ── fixture：与 Host summarize() / readRunDetail() 同形 ─────────────────────
const LONG_TEXT = '这是一个很长的 agent 消息，用来验证「展开全文」入口与弹层。'
  + '面板本身只给一段可滚动的摘录，完整文本必须能在弹层里读到、复制。'
  + '第三段用来确保长度超过 LONG_TEXT_MIN_CHARS，不是一句话就能搪塞过去。'

const live = { currentNodeId: 'n_dev', attempt: 2, round: 3, phase: 'model' }

const runningRun = {
  id: 'run-20261106-dev',
  name: '标准研发流水线 · 开发中',
  flowId: 'flow-test',
  flowName: '标准研发流水线',
  status: 'running',
  startedAt: '2026-11-06T10:00:00+08:00',
  nodeDone: 2,
  nodeTotal: 6,
  tokenTotal: 3500,
  live,
}

const summary = {
  // Host summarize() 的 agent 活动窗口：每节点最近 ≤5 条（05 §8.3）。
  activity: {
    nodes: {
      n_dev: [
        { text: '先读一下入口文件，确认路由注册。', at: '2026-11-06T10:02:10+08:00', memberId: null },
        { text: LONG_TEXT, at: '2026-11-06T10:02:20+08:00', memberId: 'n_dev:0' },
      ],
    },
  },
  tokens: {
    total: { input: 1000, cacheRead: 2000, cacheWrite: 0, output: 500, reasoning: 100 },
    byNode: {
      n_dev: { input: 1000, cacheRead: 2000, cacheWrite: 0, output: 500, reasoning: 100, total: 3500, calls: 1 },
    },
  },
  // B1：详情接口必须带每节点状态；面板的 attempt / 状态走这份。
  progress: { nodes: { n_dev: { attemptId: 2, status: 'pending', endSeq: 0 } }, invalidatedNodes: [] },
  quality: { state: 'fail', p0Unresolved: 1 },
}

const detail = {
  run: runningRun,
  nodes: [{
    nodeId: 'n_dev',
    eventCount: 7,
    attempts: [
      { attemptId: 1, eventCount: 3, status: 'passed' },
      { attemptId: 2, eventCount: 4, status: null },
    ],
  }],
  eventCount: 7,
}

const events = [
  {
    kind: 'run/start', attemptId: 1, seq: 1, ts: '2026-11-06T10:00:01+08:00',
    data: { flowId: 'flow-test', flowName: '标准研发流水线', nodeTotal: 6 },
  },
  {
    kind: 'node/start', nodeId: 'n_dev', attemptId: 2, seq: 2, ts: '2026-11-06T10:01:00+08:00',
    data: { title: '开发', mode: 'team' },
  },
  {
    kind: 'member/start', nodeId: 'n_dev', memberId: 'n_dev:0', attemptId: 2, seq: 3,
    ts: '2026-11-06T10:01:05+08:00',
    data: { name: '小码', role: '后端' },
  },
  {
    kind: 'agent/message', nodeId: 'n_dev', memberId: 'n_dev:0', attemptId: 2, seq: 4,
    ts: '2026-11-06T10:02:20+08:00',
    data: { role: 'assistant', text: LONG_TEXT, truncated: false },
  },
  {
    kind: 'tool/call', nodeId: 'n_dev', memberId: 'n_dev:0', attemptId: 2, seq: 5,
    ts: '2026-11-06T10:02:30+08:00',
    data: { name: 'read_file', argumentsDigest: 'path=src/a.js', ok: true, durationMs: 42 },
  },
  {
    kind: 'model/call', nodeId: 'n_dev', memberId: 'n_dev:0', attemptId: 2, seq: 6,
    ts: '2026-11-06T10:02:40+08:00',
    data: {
      provider: 'deepseek', model: 'chat', callId: 'c1',
      usage: { input: 1000, cacheRead: 2000, cacheWrite: 0, output: 500 },
    },
  },
  {
    kind: 'artifact/write', nodeId: 'n_dev', memberId: 'n_dev:0', attemptId: 2, seq: 7,
    ts: '2026-11-06T10:02:50+08:00',
    data: { path: 'artifacts/report.md', bytes: 1200, kind: 'md' },
  },
  {
    kind: 'member/end', nodeId: 'n_dev', memberId: 'n_dev:0', attemptId: 2, seq: 8,
    ts: '2026-11-06T10:03:00+08:00',
    data: { status: 'done', durationMs: 55000 },
  },
]

const baseDrawerProps = {
  open: true,
  onToggle() {},
  initialRuns: [runningRun],
  initialRunId: runningRun.id,
  initialSummary: summary,
  initialDetail: detail,
  initialEvents: events,
}

console.log('logdrawer')

// ── 1. 三档高度：放大 / 全屏按钮与容器 class ───────────────────────────────
check('A1 三档高度：默认档有放大 / 全屏 / 还原，全屏档容器带 zoom-full 类', () => {
  assert.deepEqual([...DRAWER_ZOOM_LEVELS], ['normal', 'tall', 'full'])
  assert.equal(normalizeDrawerZoom('bogus'), 'normal', '未知档位应退回默认高度')
  assert.equal(raiseDrawerZoom('normal'), 'tall')
  assert.equal(raiseDrawerZoom('tall'), 'full')
  assert.equal(raiseDrawerZoom('full'), 'full', '已全屏时不再放大')

  const normal = render(React.createElement(FsLogDrawer, { ...baseDrawerProps }))
  assert.ok(normal.includes('class="fs-log open"'), '默认档容器 class 不应被污染')
  assert.ok(normal.includes('data-zoom="normal"'), '缺少当前档位 data 标记')
  assert.ok(normal.includes('>放大<'), '缺少「放大」按钮')
  assert.ok(normal.includes('>全屏<'), '缺少「全屏」按钮')
  assert.ok(normal.includes('>还原<'), '缺少「还原」按钮')
  assert.ok(normal.includes('aria-label="放大运行日志'), '放大按钮没有 aria-label')
  assert.ok(normal.includes('aria-label="全屏运行日志'), '全屏按钮没有 aria-label')

  const tall = render(React.createElement(FsLogDrawer, { ...baseDrawerProps, initialZoom: 'tall' }))
  assert.ok(tall.includes('class="fs-log open zoom-tall"'), '拉高档没有 zoom-tall 类')
  assert.ok(tall.includes('data-zoom="tall"'))
  assert.ok(/class="fs-log-action fs-log-zoom-raise"[^>]*aria-expanded="true"/.test(tall),
    '拉高后「放大」的 aria-expanded 应为 true')

  const full = render(React.createElement(FsLogDrawer, { ...baseDrawerProps, initialZoom: 'full' }))
  assert.ok(full.includes('class="fs-log open zoom-full"'), '全屏档没有 zoom-full 类')
  assert.ok(full.includes('data-zoom="full"'))
  assert.ok(/class="fs-log-action fs-log-zoom-full"[^>]*aria-expanded="true"/.test(full),
    '全屏后「全屏」的 aria-expanded 应为 true')
  assert.ok(/class="fs-log-action fs-log-zoom-full"[^>]*disabled/.test(full),
    '已全屏时全屏按钮应禁用，避免重复进入')
  assert.ok(!/class="fs-log-action fs-log-zoom-full"[^>]*disabled/.test(tall),
    '拉高档全屏按钮应可用')
  assert.equal(drawerZoomInfo('full').canLower, true, '全屏档必须可以还原')
})

// ── 2. Esc 逐档还原（纯函数 = 组件实际走的代码路径）────────────────────────
check('A1 Esc 退出全屏：全屏 → 拉高 → 默认；弹层打开时优先关弹层', () => {
  assert.equal(lowerDrawerZoom('full'), 'tall')
  assert.equal(lowerDrawerZoom('tall'), 'normal')
  assert.equal(lowerDrawerZoom('normal'), 'normal', '默认档不能再还原')
  assert.equal(drawerEscapeAction({ zoom: 'full' }), 'restore-zoom')
  assert.equal(drawerEscapeAction({ zoom: 'tall' }), 'restore-zoom')
  assert.equal(drawerEscapeAction({ zoom: 'normal' }), 'none', '默认档把 Esc 让给画布')
  assert.equal(drawerEscapeAction({ zoom: 'full', overlayOpen: true }), 'close-overlay',
    '弹层打开时 Esc 先关弹层，不是直接退全屏')

  const full = render(React.createElement(FsLogDrawer, { ...baseDrawerProps, initialZoom: 'full' }))
  assert.ok(full.includes('data-zoom-escape="restore-zoom"'), '全屏容器没标记 Esc 会还原')
  assert.ok(full.includes('aria-keyshortcuts="Escape"'), '还原按钮没声明 Esc 快捷键')
  const normal = render(React.createElement(FsLogDrawer, { ...baseDrawerProps }))
  assert.ok(normal.includes('data-zoom-escape="none"'), '默认档不应抢 Esc')
})

// ── 3. 节点运行详情：agent 消息 / 工具 / 产物 / token 四类字段 ─────────────
check('B4 节点运行详情渲染 agent 消息 / 工具 / 产物 / tokens（消费 summary.activity 等）', () => {
  const html = render(React.createElement(FsLogDrawer, {
    ...baseDrawerProps,
    initialSelectedNodeId: 'n_dev',
  }))
  for (const needle of [
    '节点运行详情', '开发', '主管 + 成员', '运行中',
    '先读一下入口文件，确认路由注册。',
    '10:02:20',
    '小码',
    'read_file', 'path=src/a.js', '成功',
    'artifacts/report.md', '1.2KB',
    '四段合计 3.5k tok',
    'attempt：2',
    '正在运行',
    '最近在做什么', '最近工具调用', 'token 用量', '成员活动', '已写产物',
  ]) {
    assert.ok(html.includes(needle), '节点详情缺少「' + needle + '」')
  }

  // 数据模型层：确认字段真的来自 summary.activity / progress.nodes / detail.nodes。
  const activity = nodeActivityOf({
    summary,
    detail,
    events,
    nodeId: 'n_dev',
    live,
    progress: summary.progress,
    runStatus: 'running',
  })
  assert.equal(activity.messages.length, 2, '应从 summary.activity 取到 2 条 agent 消息')
  assert.equal(activity.activityFromSummary, true, '有 summary.activity 时标记来源')
  assert.equal(activity.messages[1].memberLabel, '小码', '成员名应从 member/start 回填')
  assert.equal(activity.state, 'running', 'live.currentNodeId 命中的节点应为运行中')
  assert.equal(activity.attempt, 2, 'attempt 应取 progress.nodes / live 的口径')
  assert.equal(activity.tools[0].name, 'read_file')
  assert.equal(activity.tools[0].okText, '成功')
  assert.equal(activity.artifacts[0].path, 'artifacts/report.md')
  assert.equal(activity.artifacts[0].bytesText, '1.2KB')
  assert.equal(activity.tokens.total, 3500, 'tokens 应走 summary.tokens.byNode')
  assert.equal(activity.tokenSource, 'summary')
  assert.ok(activity.tokenText.includes('3.5k'))
  assert.equal(activity.modeText, '主管 + 成员')
})

check('B5 运行中：summary 还没收口时从事件流回退 agent 消息，并带「正在运行」', () => {
  const noSummary = render(React.createElement(FsLogDrawer, {
    ...baseDrawerProps,
    initialSummary: null,
    initialSelectedNodeId: 'n_dev',
  }))
  assert.ok(noSummary.includes(LONG_TEXT), '运行中应从 agent/message 事件回退出最近文本')
  assert.ok(noSummary.includes('正在运行'), '运行中缺少轻量指示')
  assert.ok(noSummary.includes('（事件流）'), '回退来源应标注为事件流')

  const fromEvents = nodeActivityOf({
    summary: null,
    detail,
    events,
    nodeId: 'n_dev',
    live,
    progress: summary.progress,
    runStatus: 'running',
  })
  assert.equal(fromEvents.activityFromSummary, false)
  assert.equal(fromEvents.messages.length > 0, true)
  assert.equal(fromEvents.running, true)
  assert.equal(fromEvents.tokenSource, 'events', '没有 summary 时 token 应回退 model/call')
  assert.equal(fromEvents.tokens.total, 3500)

  const messages = activityMessagesOf(null, events, 'n_dev')
  assert.equal(messages.length <= AGENT_ACTIVITY_LIMIT, true, '回退也不能超过每节点上限')
  assert.equal(nodeUsageOf(events, 'n_dev').input, 1000)
  assert.equal(nodeToolsOf(events, 'n_dev')[0].argsText, 'path=src/a.js')
  assert.equal(nodeArtifactsOf(events, 'n_dev')[0].bytes, 1200)

  // 轮询把新事件送进来后，重算（= 下一次渲染）必须能看到新活动，证明面板随轮询刷新。
  const polled = {
    kind: 'agent/message', nodeId: 'n_dev', memberId: 'n_dev:0', attemptId: 2, seq: 9,
    ts: '2026-11-06T10:03:10+08:00',
    data: { role: 'assistant', text: '刚补完路由注册，开始跑单测。' },
  }
  const nextActivity = nodeActivityOf({
    summary: null,
    detail,
    events: [...events, polled],
    nodeId: 'n_dev',
    live,
    progress: summary.progress,
    runStatus: 'running',
  })
  assert.equal(nextActivity.messages.length, fromEvents.messages.length + 1,
    '轮询新增的 agent/message 没有进面板数据')
  assert.equal(nextActivity.lastMessage.text, '刚补完路由注册，开始跑单测。',
    '面板的「最近在做什么」没有跟着刷新')
})

// ── 4. 字段缺失降级 ────────────────────────────────────────────────────────
check('B7 字段缺失全部降级为可读占位，不抛错', () => {
  const bare = nodeActivityOf({ nodeId: 'n_x' })
  assert.equal(bare.title, 'n_x')
  assert.equal(bare.messages.length, 0)
  assert.equal(bare.tools.length, 0)
  assert.equal(bare.artifacts.length, 0)
  assert.equal(bare.tokens, null)
  assert.equal(bare.attempt, null)
  assert.equal(bare.failureReason, '')
  assert.equal(nodeActivityOf().nodeId, '')

  const html = render(React.createElement(FsLogDrawer, {
    open: true,
    onToggle() {},
    initialRuns: [{ id: 'run-empty', name: '空数据 run', status: 'done' }],
    initialRunId: 'run-empty',
    initialSelectedNodeId: 'n_x',
  }))
  for (const needle of [
    '节点运行详情', 'n_x', '角色未记录', '执行方式未记录',
    '还没有 agent 消息', '还没有工具调用记录', '还没有产物写入记录',
    'token：未记录', 'attempt：—',
  ]) {
    assert.ok(html.includes(needle), '缺失字段缺少占位「' + needle + '」')
  }
  assert.ok(!html.includes('NaN'), '缺字段不能渲染出 NaN')
})

// ── 5. 长文本：展开全文入口 + 弹层包含完整文本 ─────────────────────────────
check('A2 长文本有「展开全文」入口，弹层渲染完整文本且可复制 / Esc 关闭', () => {
  assert.equal(eventLongTextOf({ kind: 'agent/message', data: { text: LONG_TEXT } }), LONG_TEXT)
  assert.equal(eventLongTextOf({ kind: 'agent/message', data: { text: '短句' } }), '',
    '短文本不该多一个弹层入口')

  const panel = render(React.createElement(FsLogDrawer, {
    ...baseDrawerProps,
    initialSelectedNodeId: 'n_dev',
  }))
  assert.ok(panel.includes('展开全文'), '节点详情的长消息缺少展开全文入口')
  assert.ok(panel.includes(LONG_TEXT), '面板本身也应渲染完整文本（靠 CSS 折行 / 限高，不是截断字符串）')

  const overlay = render(React.createElement(LogTextOverlay, {
    title: 'agent 消息 · 开发',
    text: LONG_TEXT,
    onClose() {},
  }))
  assert.ok(overlay.includes(LONG_TEXT), '弹层没有包含完整文本')
  assert.ok(overlay.includes('role="dialog"'), '弹层缺少 dialog 语义')
  assert.ok(overlay.includes('aria-modal="true"'), '弹层缺少 aria-modal')
  assert.ok(overlay.includes('复制全文'), '弹层缺少复制入口')
  assert.ok(overlay.includes('aria-label="关闭完整文本（Esc）"'), '弹层关闭按钮没有可访问名')
  assert.ok(overlay.includes('fs-log-overlay-text'), '弹层正文没有独立可滚动容器')

  // 事件详情里的长文本同样有入口（用真实事件键选中该条）。
  const messageEvent = {
    kind: 'agent/message', nodeId: 'n_dev', seq: 4,
    ts: '2026-11-06T10:02:20+08:00',
    data: { role: 'assistant', text: LONG_TEXT },
  }
  const detailHtml = render(React.createElement(FsLogDrawer, {
    open: true,
    onToggle() {},
    initialRuns: [runningRun],
    initialRunId: runningRun.id,
    initialEvents: [messageEvent],
    initialSelectedEventKey: eventKey(messageEvent),
  }))
  assert.ok(detailHtml.includes('展开全文'), '事件详情的长文本缺少展开全文入口')
})

// ── 6. 区域独立展开 / 窄屏 / CSS 约束 ─────────────────────────────────────
check('A2/A3 指标 / 事件流 / 详情三个区域各有 aria-expanded 开关；窄屏退化单列', () => {
  const html = render(React.createElement(FsLogDrawer, { ...baseDrawerProps }))
  assert.ok(html.includes('aria-label="收起运行指标"'), '指标区缺少独立收起开关')
  assert.ok(html.includes('aria-label="收起事件流"'), '事件流缺少独立收起开关')
  assert.ok(html.includes('aria-label="收起事件详情"'), '详情区缺少独立收起开关')
  assert.ok((html.match(/fs-log-region-toggle/g) || []).length >= 3, '三个区域开关不齐')
  assert.ok(html.includes('class="fs-log-events-body"'), '事件列表没有独立滚动容器')

  assert.ok(CSS.includes('@media (max-width:720px)'), '缺少 720px 窄屏断点')
  assert.ok(/@media \(max-width:720px\)\{[\s\S]*grid-template-columns:minmax\(0,1fr\)/.test(CSS),
    '窄屏没有退化为单列')
  assert.ok(CSS.includes('.fs-log-events-body{'), '事件列表自身滚动缺少布局')
  assert.ok(CSS.includes('.fs-log.zoom-tall{height:70vh'), '拉高档高度未落到 CSS')
  assert.ok(CSS.includes('.fs-log.zoom-full{position:fixed'), '全屏档没有遮住画布的 fixed 容器')
  assert.ok(/prefers-reduced-motion/.test(CSS), '缺少减少动效兜底')
})

check('C 新 CSS 只用 --dsw-* token：无 hex、正文 ≥12px', () => {
  assert.ok(!/#[0-9a-f]{3,8}/i.test(CSS), 'styles.js 里出现了 hex 颜色')
  const start = CSS.indexOf('.fs-log.zoom-tall')
  assert.ok(start > 0, '找不到新增的抽屉样式块')
  const added = CSS.slice(start)
  assert.ok(!/#[0-9a-f]{3,8}/i.test(added), '新增样式里出现了 hex 颜色')
  assert.ok(!/font-size:(?:[0-9]|1[01])px/.test(added), '新增样式出现 12px 以下正文')
  for (const selector of [
    '.fs-log-node-panel', '.fs-log-msg-text', '.fs-log-tool-args',
    '.fs-log-member-last', '.fs-log-overlay-text', '.fs-log-live-dot',
  ]) {
    assert.ok(CSS.includes(selector), '缺少新类 ' + selector)
  }
  assert.ok(CSS.includes('body[data-ds-dark-theme]'), '暗色主题没有专门分支')
  assert.ok(CSS.includes('var(--dsw-alias-'), '新增颜色没走宿主 token')
})

check('v0.8 事件表：node/status 与 v1.1/v1.6 的 kind 都在列，且有可读摘要（不再显示「未识别」）', () => {
  for (const kind of ['node/status', 'acceptance/verdict', 'test/report', 'message/in', 'message/out']) {
    assert.ok(EVENT_KINDS.includes(kind), `${kind} 应在 EVENT_KINDS 里`)
  }
  const line = eventSummary({
    kind: 'node/status',
    data: { state: 'blocked', progress: 40, verdict: null, blockers: ['等依赖'], summary: '卡在依赖上' },
  })
  assert.match(line, /blocked/)
  assert.match(line, /40%/)
  assert.match(line, /阻塞 1 条/)
  assert.doesNotMatch(line, /未识别/)
  const testLine = eventSummary({ kind: 'test/report', data: { suite: 'unit', executed: 10, passed: 9, failed: 1 } })
  assert.match(testLine, /9\/10/)
  assert.match(testLine, /1 失败/)
})

check('v0.9 状态机转移：machine/transition 在 kind 表与增量窗口里，摘要可读', () => {
  assert.ok(EVENT_KINDS.includes('machine/transition'), 'machine/transition 应在 EVENT_KINDS 里')
  assert.ok(WATCH_EVENT_KINDS.includes('machine/transition'), '运行中增量也要拉转移事件')
  const withFrom = eventSummary({ kind: 'machine/transition', data: { from: 'n_a', to: 'n_b', event: 'PASS', attempt: 2 } })
  assert.match(withFrom, /n_a → n_b/)
  assert.match(withFrom, /PASS/)
  assert.match(withFrom, /attempt=2/)
  const resolved = eventSummary({ kind: 'machine/transition', data: { to: '#done', event: 'PASS' } })
  assert.match(resolved, /#done/)
  assert.doesNotMatch(resolved, /attempt=/)
  assert.doesNotMatch(resolved, /未识别/)
})

// ── 0.10：数据归一化 / 派生纯函数（R4 / R5 / R6 / R8）──────────────────────
console.log('0.10 客户端改进')

check('0.10 R4/R5 normalizeRun 四字段：合法 / 数组 / 数字 / 空串；缺失一律 null（不补 {}）', () => {
  const valid = normalizeRun({
    id: 'run-1',
    sessions: { n_a: 's-1', n_b: '', n_c: 42, n_d: null },
    agentPreset: { value: 'standard', source: 'default' },
    supervision: { enabled: false, wakerSessionId: 's-wake', extra: 1 },
    restart: {
      fromRunId: 'run-0', attempt: 2, startNodeId: 'n_b',
      skippedNodeIds: ['n_a', 3], note: '补打回边',
    },
  })
  assert.deepEqual(valid.sessions, { n_a: 's-1' }, 'sessions 只收 {string → 非空 string}')
  assert.deepEqual(valid.agentPreset, { value: 'standard', source: 'default' })
  assert.deepEqual(valid.supervision, { wakerSessionId: 's-wake' }, 'supervision 只保留 wakerSessionId')
  // 审查 F12：runstore 的绑定字符串上限是 2048，客户端不能截到 128（会复制错会话 id）。
  const longWake = 's-' + 'x'.repeat(300)
  assert.equal(normalizeRun({ supervision: { wakerSessionId: longWake } }).supervision.wakerSessionId, longWake)
  assert.deepEqual(valid.restart, {
    fromRunId: 'run-0', attempt: 2, startNodeId: 'n_b',
    skippedNodeIds: ['n_a'], note: '补打回边',
  })

  // 数组 / 数字 / 字符串 / 布尔：整字段判非法 → null。
  for (const bad of [[], ['s-1'], 42, 'x', true]) {
    const run = normalizeRun({
      sessions: bad, agentPreset: bad, supervision: bad, restart: bad,
    })
    assert.equal(run.sessions, null, 'sessions 坏形状（' + JSON.stringify(bad) + '）应为 null')
    assert.equal(run.agentPreset, null, 'agentPreset 坏形状应为 null')
    assert.equal(run.supervision, null, 'supervision 坏形状应为 null')
    assert.equal(run.restart, null, 'restart 坏形状应为 null')
  }

  // 空串：value 空 → agentPreset null；wakerSessionId 空 → supervision null；
  // fromRunId 非法 → restart null；sessions 里空值的条目被跳过（对象本身仍是 {}）。
  const empty = normalizeRun({
    sessions: { n_a: '' },
    agentPreset: { value: '   ', source: 'default' },
    supervision: { wakerSessionId: '' },
    restart: { fromRunId: '' },
  })
  assert.deepEqual(empty.sessions, {}, '空会话 id 应被跳过')
  assert.equal(empty.agentPreset, null, 'agentPreset.value 空 → null')
  assert.equal(empty.supervision, null, 'wakerSessionId 空 → null')
  assert.equal(empty.restart, null, 'fromRunId 空 → null')

  // 缺失一律 null，且不补 {}（结构设计 §2.2）。
  const missing = normalizeRun({ id: 'run-2' })
  assert.equal(missing.sessions, null, '缺失 sessions 必须是 null，不是 {}')
  assert.equal(missing.agentPreset, null)
  assert.equal(missing.supervision, null)
  assert.equal(missing.restart, null)
  assert.equal(normalizeRun().sessions, null)
})

check('0.10 R4 sessionTargetOf 优先级：run.sessions → 该节点最近事件 ref.sessionId → none', () => {
  const events = [
    { kind: 'node/start', nodeId: 'n_dev', seq: 1, ref: { sessionId: 's-old', logLine: 3 } },
    { kind: 'node/start', nodeId: 'n_dev', seq: 5, ref: { sessionId: 's-new' } },
    { kind: 'node/start', nodeId: 'n_other', seq: 9, ref: { sessionId: 's-other' } },
  ]
  assert.deepEqual(sessionTargetOf({ sessions: { n_dev: 's-run' } }, 'n_dev', events),
    { sessionId: 's-run', source: 'run.sessions' }, 'run.sessions 优先于事件 ref')
  assert.deepEqual(sessionTargetOf({ sessions: { n_dev: '' } }, 'n_dev', events),
    { sessionId: 's-new', source: 'event.ref' }, '应取该节点最近一条事件（seq 最大）')
  assert.deepEqual(sessionTargetOf({}, 'n_none', events),
    { sessionId: '', source: 'none' })
  assert.deepEqual(sessionTargetOf(null, 'n_dev', null),
    { sessionId: '', source: 'none' })
})

check('0.10 R5 presetInfoOf：六来源文案 / 未知原样 / 节点优先 run / 缺失 —', () => {
  const expected = {
    node: '节点配置', start: '本次启动', engine: '引擎配置',
    flow: '流程默认', default: '兜底 standard', 'default-fallback': '降级宿主默认',
  }
  assert.deepEqual(PRESET_SOURCE_TEXT, expected, 'PRESET_SOURCE_TEXT 的六来源文案必须一致')
  for (const [source, sourceText] of Object.entries(expected)) {
    const info = presetInfoOf([], { agentPreset: { value: 'preset-' + source, source } }, 'n_x')
    assert.equal(info.value, 'preset-' + source)
    assert.equal(info.source, source)
    assert.equal(info.sourceText, sourceText)
  }

  // 节点最近一条 node/start 优先于 run.agentPreset。
  const events = [
    { kind: 'node/start', nodeId: 'n_dev', seq: 1, data: { agentPreset: 'flow-value', agentPresetSource: 'flow' } },
    { kind: 'node/start', nodeId: 'n_dev', seq: 3, data: { agentPreset: 'node-value', agentPresetSource: 'node' } },
    { kind: 'node/start', nodeId: 'n_dev', seq: 4, data: {} },
  ]
  assert.deepEqual(presetInfoOf(events, { agentPreset: { value: 'run-value', source: 'default' } }, 'n_dev'),
    { value: 'node-value', source: 'node', sourceText: '节点配置' })

  // run 级兜底。
  assert.deepEqual(presetInfoOf([], { agentPreset: { value: 'run-value', source: 'engine' } }, 'n_dev'),
    { value: 'run-value', source: 'engine', sourceText: '引擎配置' })

  // 未知来源原样显示；缺失 → value 空 + sourceText '—'。
  assert.deepEqual(presetInfoOf([], { agentPreset: { value: 'x', source: 'custom' } }, 'n_dev'),
    { value: 'x', source: 'custom', sourceText: 'custom' })
  assert.deepEqual(presetInfoOf([], null, 'n_dev'),
    { value: '', source: '', sourceText: '—' })
})

check('0.10 R6 nodeToolsAvailableOf：只认 node/tools，绝不回退 tool/call；三种 toolsSource 分开', () => {
  // 只有 tool/call 历史：不能冒充「可用工具」。
  assert.deepEqual(
    nodeToolsAvailableOf([{ kind: 'tool/call', nodeId: 'n_dev', seq: 1, data: { name: 'bash' } }], 'n_dev'),
    { present: false, tools: [], toolsSource: 'none', count: 0, truncated: false },
  )

  const session = nodeToolsAvailableOf([{
    kind: 'node/tools', nodeId: 'n_dev', seq: 2,
    data: { tools: ['bash', 'read_file'], toolsSource: 'session', count: 2 },
  }], 'n_dev')
  assert.deepEqual(session, {
    present: true, tools: ['bash', 'read_file'], toolsSource: 'session', count: 2, truncated: false,
  })

  const unavailable = nodeToolsAvailableOf([{
    kind: 'node/tools', nodeId: 'n_dev', seq: 2,
    data: { tools: [], toolsSource: 'unavailable', count: 0 },
  }], 'n_dev')
  assert.equal(unavailable.present, true)
  assert.equal(unavailable.toolsSource, 'unavailable', 'unavailable 必须与 none 分开')

  // 兼容 data.count（老事件可能只给 count）。
  const compat = nodeToolsAvailableOf([{
    kind: 'node/tools', nodeId: 'n_dev', seq: 2,
    data: { tools: ['a'], toolsSource: 'session', count: 7, truncated: true },
  }], 'n_dev')
  assert.equal(compat.count, 7)
  assert.equal(compat.truncated, true)

  // 多条取最近一条；别的节点忽略。
  const latest = nodeToolsAvailableOf([
    { kind: 'node/tools', nodeId: 'n_dev', seq: 1, data: { tools: ['old'], toolsSource: 'session', count: 1 } },
    { kind: 'node/tools', nodeId: 'n_dev', seq: 4, data: { tools: ['new'], toolsSource: 'session', count: 1 } },
    { kind: 'node/tools', nodeId: 'n_other', seq: 9, data: { tools: ['x'], toolsSource: 'session', count: 1 } },
  ], 'n_dev')
  assert.deepEqual(latest.tools, ['new'])
})

check('0.10 R8 canRestartInPlace：仅 failed/aborted，且 flowId 必须等于当前流程', () => {
  assert.deepEqual(RESTARTABLE_STATUSES, ['failed', 'aborted'])
  assert.equal(canRestartInPlace({ status: 'failed', flowId: 'flow-test' }, 'flow-test').ok, true)
  assert.equal(canRestartInPlace({ status: 'aborted', flowId: 'flow-test' }, 'flow-test').ok, true)
  for (const status of ['running', 'done', 'pending', 'unknown']) {
    const info = canRestartInPlace({ status, flowId: 'flow-test' }, 'flow-test')
    assert.equal(info.ok, false, status + ' 不能原地重启')
    assert.ok(info.reason.length > 0, status + ' 需要可读原因')
  }
  const cross = canRestartInPlace({ status: 'failed', flowId: 'flow-other' }, 'flow-test')
  assert.equal(cross.ok, false, '跨流程必须 disabled')
  assert.match(cross.reason, /先打开该 run 所属流程再重启/)
  assert.equal(canRestartInPlace({ status: 'failed', flowId: '' }, 'flow-test').ok, false)
  assert.equal(canRestartInPlace(null, 'flow-test').ok, false)
})

check('0.10 R8 restartFailureText 四类 + runActionFailureText 的 restart 分支', () => {
  assert.equal(restartFailureText(400, { error: '起点不在 next 路径上' }),
    '重启失败：起点不在 next 路径上', '400 应原样带 Host 原因')
  assert.equal(restartFailureText(404, {}), '重启失败：run 或流程已不存在，刷新后重试')
  // 400 且 Host 没给 error / message（空 detail）时给兜底文案，不能渲染成 undefined。
  assert.equal(restartFailureText(400, {}), '重启失败：请求不合法，刷新后重试')
  // 审查 F5：page.js 把 api 的通用 message 传进来时，400 空 detail 仍用可行动兜底。
  assert.equal(restartFailureText(400, {}, '请求失败（HTTP 400）'), '重启失败：请求不合法，刷新后重试')
  assert.equal(restartFailureText(400, { error: '' }, '请求失败（HTTP 400）'), '重启失败：请求不合法，刷新后重试')
  assert.equal(restartFailureText(400, {}, ''), '重启失败：请求不合法，刷新后重试')
  assert.equal(restartFailureText(400, { error: '   ' }), '重启失败：请求不合法，刷新后重试')
  assert.equal(restartFailureText(500, {}), '重启失败：执行引擎未启用或版本不匹配')
  assert.equal(restartFailureText(503, {}), '重启失败：宿主 agents 不可用，无法在原会话续跑')
  assert.equal(restartFailureText(undefined, undefined, '连不上 Host：boom'),
    '重启失败：连不上 Host：boom', '网络错误用 message')
  assert.equal(runActionFailureText('restart', 404, {}), '重启失败：run 或流程已不存在，刷新后重试')
  assert.equal(runActionFailureText('restart', 400, { error: 'note 超长' }), '重启失败：note 超长')
  assert.match(runActionFailureText('stop', 409, {}), /^停止失败：/, 'stop 文案不能被 restart 分支吞掉')
})

// ── 0.10：抽屉 SSR（R4 会话入口 / R5 preset / R6 工具块 / R8 世系与重启）─────
const failedRun = {
  id: 'run-failed',
  name: '标准研发流水线 · 失败',
  flowId: 'flow-test',
  flowName: '标准研发流水线',
  status: 'failed',
  sessions: { n_dev: 's-dev' },
  agentPreset: { value: 'standard', source: 'default' },
  supervision: { wakerSessionId: 's-wake' },
  restart: { fromRunId: 'run-old', attempt: 2, startNodeId: 'n_dev' },
}
const failedEvents = [
  {
    kind: 'node/start', nodeId: 'n_dev', attemptId: 1, seq: 1,
    ts: '2026-11-06T10:00:00+08:00',
    data: { title: '开发', mode: 'single', agentPreset: 'standard', agentPresetSource: 'node' },
  },
  {
    kind: 'node/tools', nodeId: 'n_dev', attemptId: 1, seq: 2,
    ts: '2026-11-06T10:00:01+08:00',
    data: { tools: ['bash', 'read_file'], toolsSource: 'session', count: 2 },
  },
  {
    kind: 'tool/call', nodeId: 'n_dev', attemptId: 1, seq: 3,
    ts: '2026-11-06T10:00:02+08:00',
    data: { name: 'read_file', ok: true, argumentsDigest: 'path=src/a.js' },
  },
]
const failedDrawerProps = {
  open: true,
  onToggle() {},
  flowId: 'flow-test',
  initialRuns: [failedRun],
  initialRunId: failedRun.id,
  initialEvents: failedEvents,
  initialSelectedNodeId: 'n_dev',
}

check('0.10 R4/R5/R6/R8 抽屉节点详情：会话入口 / preset / 可用工具块 / 世系 / 重启按钮', () => {
  const html = render(React.createElement(FsLogDrawer, {
    ...failedDrawerProps,
    openSession: () => true,
    onRestartRun: async () => ({ ok: true, run: { id: 'run-new' } }),
  }))
  assert.ok(html.includes('aria-label="打开节点会话 s-dev"'), '缺少节点会话入口（aria-label 带 id）')
  // 0.10 R4 修正：run 级「打开发起会话」入口（supervision.wakerSessionId）。
  assert.ok(html.includes('aria-label="打开发起会话 s-wake"'), '缺少 run 级发起会话入口')
  assert.ok(html.includes('发起会话 s-wake'), 'run 级入口应显示会话 id')
  assert.ok(html.includes('打开节点会话'), '缺少「打开节点会话」按钮')
  assert.ok(html.includes('preset：standard（来源：节点配置）'), 'facts 行缺少 preset 与来源')
  assert.ok(html.includes('preset standard（兜底 standard）'), 'run 列表行应显示 run 级 preset 与来源')
  assert.ok(html.includes('节点会话可用工具（2 个）'), '缺少可用工具块标题')
  assert.ok(html.includes('class="fs-log-available-tools"'), '工具清单应使用 details 容器')
  assert.ok(html.includes('class="fs-log-tools-summary"'), '缺少 summary')
  for (const chip of ['bash', 'read_file']) {
    assert.ok(html.includes('class="fs-log-tool-chip"') && html.includes(chip), '缺少工具 chip ' + chip)
  }
  // 不能把「最近工具调用」的类名复用给可用工具块。
  assert.ok(html.includes('最近工具调用'), '「最近工具调用」块应保持独立')
  assert.ok(html.indexOf('节点会话可用工具') > html.indexOf('最近工具调用'), '可用工具块应在最近工具调用之后')
  assert.ok(html.includes('class="fs-log-lineage"'), '缺少续跑世系行')
  assert.ok(html.includes('续跑自 run-old · 第 2 次 · 起点 n_dev'), '世系文案不对')
  assert.ok(html.includes('修复后重启'), 'failed run 缺少重启按钮')
  assert.ok(!/class="fs-log-action fs-log-restart"[^>]*disabled/.test(html), '同流程 failed 时重启按钮应可用')

  // 事件 ref 行：有 ref.sessionId 时同样给入口（refLabel 仍是纯文本）。
  const refEvent = {
    kind: 'review/finding', nodeId: 'n_dev', seq: 9, ts: '2026-11-06T10:04:00+08:00',
    ref: { sessionId: 's-ref', logLine: 7 },
    data: { id: 'f1', severity: 'P0', title: '缺少证据', status: 'open' },
  }
  const refHtml = render(React.createElement(FsLogDrawer, {
    open: true,
    onToggle() {},
    initialRuns: [failedRun],
    initialRunId: failedRun.id,
    initialEvents: [refEvent],
    initialSelectedEventKey: eventKey(refEvent),
    openSession: () => true,
  }))
  assert.ok(refHtml.includes('aria-label="打开节点会话 s-ref"'), '事件 ref 行也要有会话入口')
  assert.ok(refHtml.includes('会话 s-ref') && refHtml.includes('第 7 行'), 'ref 文本不能被按钮吞掉')

  // 跨流程：按钮仍渲染但 disabled + title。
  const cross = render(React.createElement(FsLogDrawer, {
    ...failedDrawerProps,
    flowId: 'flow-other',
    onRestartRun: async () => ({ ok: true, run: { id: 'run-new' } }),
  }))
  assert.match(cross, /class="fs-log-action fs-log-restart"[^>]*disabled/,
    '跨流程时重启按钮必须 disabled')
  assert.ok(cross.includes('title="先打开该 run 所属流程再重启"'), '跨流程 title 应说明原因')

  // 没有 restart 的 run 不渲染世系；running/done 不渲染重启按钮。
  const running = render(React.createElement(FsLogDrawer, { ...baseDrawerProps }))
  assert.ok(!running.includes('class="fs-log-lineage"'), '无 restart 不渲染世系')
  assert.ok(!running.includes('修复后重启'), '运行中的 run 不渲染重启按钮')
})

check('0.10 R4 会话按钮：调用恰好 1 次、参数 === id、不 await；无 openSession 降级复制；无 id disabled', () => {
  const calls = []
  const openSession = target => { calls.push(target) }
  const originalH = rt.h
  const buttons = []
  rt.h = (type, props, ...children) => {
    if (type === 'button' && props && typeof props['aria-label'] === 'string') {
      buttons.push({ props })
    }
    return originalH(type, props, ...children)
  }
  try {
    render(React.createElement(FsLogDrawer, {
      ...failedDrawerProps,
      openSession,
      onRestartRun: async () => ({ ok: true, run: { id: 'run-new' } }),
    }))
  } finally {
    rt.h = originalH
  }
  const target = buttons.find(item => item.props['aria-label'] === '打开节点会话 s-dev')
  assert.ok(target, '没有捕获到节点会话按钮')
  const returned = target.props.onClick()
  assert.deepEqual(calls, ['s-dev'], 'openSession 只能调用一次、参数必须是 sessionId')
  assert.ok(!(returned && typeof returned.then === 'function'), '按钮不能 await openSession')

  // 无 openSession → 复制会话 id（不显示打开按钮）。
  const copyHtml = render(React.createElement(FsLogDrawer, {
    ...failedDrawerProps,
    onRestartRun: async () => ({ ok: true, run: { id: 'run-new' } }),
  }))
  assert.ok(copyHtml.includes('复制会话 id'), '无 openSession 时应降级为复制')
  assert.ok(!copyHtml.includes('aria-label="打开节点会话 s-dev"'), '无 openSession 时不能显示打开入口')

  // 无 id → disabled + title（runningRun 没有 sessions，现有事件也没有 ref）。
  const noId = render(React.createElement(FsLogDrawer, { ...baseDrawerProps, initialSelectedNodeId: 'n_dev' }))
  assert.ok(noId.includes('class="fs-log-mini fs-log-session"'), '无 id 也应保留会话入口位')
  assert.ok(noId.includes('title="该节点还没有节点会话'), '无 id 应 disabled + title 说明原因')
  assert.ok(/class="fs-log-mini fs-log-session"[^>]*disabled/.test(noId), '无 id 时按钮必须 disabled')
})

check('0.10 R6/R4 工具块边界：无 node/tools 显示「未记录」；unavailable 显示「宿主未提供工具枚举」', () => {
  const noTools = render(React.createElement(FsLogDrawer, {
    ...failedDrawerProps,
    initialEvents: failedEvents.filter(event => event.kind !== 'node/tools'),
    openSession: () => true,
  }))
  assert.ok(noTools.includes('节点会话可用工具（0 个）'), '无事件时标题仍要显示数量 0')
  assert.ok(noTools.includes('未记录'), '无 node/tools 时显示「未记录」')

  const unavailable = render(React.createElement(FsLogDrawer, {
    ...failedDrawerProps,
    initialEvents: [
      failedEvents[0],
      {
        kind: 'node/tools', nodeId: 'n_dev', attemptId: 1, seq: 2,
        ts: '2026-11-06T10:00:01+08:00',
        data: { tools: [], toolsSource: 'unavailable', count: 0 },
      },
    ],
    openSession: () => true,
  }))
  assert.ok(unavailable.includes('宿主未提供工具枚举'), 'unavailable 文案不对')
  assert.ok(!unavailable.includes('class="fs-log-tools-empty">未记录'), 'unavailable 不能显示成「未记录」')
})

check('0.10 R6 EVENT_KINDS / WATCH_EVENT_KINDS 含 node/tools，摘要与 glyph 可读', () => {
  assert.ok(EVENT_KINDS.includes('node/tools'), 'EVENT_KINDS 缺少 node/tools')
  assert.ok(WATCH_EVENT_KINDS.includes('node/tools'), '运行中增量窗口也要拉 node/tools')
  const line = eventSummary({
    kind: 'node/tools',
    data: { tools: ['bash', 'read_file'], toolsSource: 'session', count: 2 },
  })
  assert.match(line, /可用工具 2 个/)
  assert.doesNotMatch(line, /未识别/)
  const unavailable = eventSummary({ kind: 'node/tools', data: { tools: [], toolsSource: 'unavailable', count: 0 } })
  assert.match(unavailable, /可用工具 0 个/)
  assert.match(unavailable, /宿主未提供工具枚举/)
  const truncated = eventSummary({ kind: 'node/tools', data: { tools: ['a'], toolsSource: 'session', count: 1, truncated: true } })
  assert.match(truncated, /已截断/)
})

// ── 0.10 R4/R5/R6 修正：运行期跳转降级 / 外部执行器可见文案 ─────────────────
await checkAsync('R4 运行期 openSession 返回 false 时降级复制会话 id（不静默）', async () => {
  const copied = []
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async value => { copied.push(value) } } },
    configurable: true,
    writable: true,
  })
  try {
    const html = render(React.createElement(FsLogDrawer, {
      ...failedDrawerProps,
      openSession: () => false,
      onRestartRun: async () => ({ ok: true, run: { id: 'run-new' } }),
    }))
    assert.ok(html.includes('aria-label="打开节点会话 s-dev"'))
    // 捕获按钮的 onClick 并执行（SSR 不跑点击，这里直接走组件回调）。
    const originalH = rt.h
    const buttons = []
    rt.h = (type, props, ...children) => {
      if (type === 'button' && props && typeof props['aria-label'] === 'string') buttons.push(props)
      return originalH(type, props, ...children)
    }
    try {
      render(React.createElement(FsLogDrawer, {
        ...failedDrawerProps,
        openSession: () => false,
        onRestartRun: async () => ({ ok: true, run: { id: 'run-new' } }),
      }))
    } finally {
      rt.h = originalH
    }
    const target = buttons.find(props => props['aria-label'] === '打开节点会话 s-dev')
    assert.ok(target, '没有捕获到节点会话按钮')
    await target.onClick()
    assert.deepEqual(copied, ['s-dev'], '跳转失败必须把 sessionId 复制到剪贴板')
  } finally {
    if (previousNavigator === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', previousNavigator)
  }
})

check('R5 外部执行器：可见文案说明没有节点会话（不只写 title）', () => {
  const externalEvents = [
    {
      kind: 'node/start', nodeId: 'n_ext', attemptId: 1, seq: 1,
      ts: '2026-11-06T10:00:00+08:00',
      data: { title: '外部节点', mode: 'single', executor: 'codex' },
    },
  ]
  const html = render(React.createElement(FsLogDrawer, {
    open: true,
    onToggle() {},
    flowId: 'flow-test',
    initialRuns: [failedRun],
    initialRunId: failedRun.id,
    initialEvents: externalEvents,
    initialSelectedNodeId: 'n_ext',
  }))
  assert.ok(html.includes('外部执行器（codex）没有节点会话，未记录工具清单'),
    '外部执行器必须在正文可见文案里说明没有节点会话')
  assert.ok(!html.includes('宿主未提供工具枚举'),
    '外部执行器没有节点会话不等于宿主未提供工具枚举')
})

console.log(`\n${checks} 组通过`)
