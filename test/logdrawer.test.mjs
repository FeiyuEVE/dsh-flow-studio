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

const { bindReact } = await import('../src/client/runtime.js')
bindReact(React)

const {
  AGENT_ACTIVITY_LIMIT, DRAWER_ZOOM_LEVELS, FsLogDrawer, LogTextOverlay,
  activityMessagesOf, drawerEscapeAction, drawerZoomInfo, eventKey, eventLongTextOf,
  lowerDrawerZoom, nodeActivityOf, nodeArtifactsOf, nodeToolsOf, nodeUsageOf,
  normalizeDrawerZoom, raiseDrawerZoom,
} = await import('../src/client/logdrawer.js')
const { CSS } = await import('../src/client/styles.js')

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

console.log(`\n${checks} 组通过`)
