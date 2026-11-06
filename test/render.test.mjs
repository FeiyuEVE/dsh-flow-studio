#!/usr/bin/env node
/**
 * 渲染自检：用真实 React 18 把每个组件在服务端渲染一遍，抓运行期错误。
 *
 * 两段：
 *  A. 直接渲染 src/client/* 的组件（带真实流程数据），验证画布 / 检查器 / 弹层能出正确结构；
 *  B. 把构建产物 lib/client.js 放进一个只有 window/__ModuleLoader__ 的假环境里执行，
 *     验证注册 id、slot 注册成对、以及面板组件能被渲染 —— 这是「装进 profile 之后浏览器
 *     真正会拿到的那份字节」。
 *
 * 注意：这不等于浏览器验证。SSR 只跑首次渲染，不跑 useEffect，也不测交互。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

/** 渲染一个元素成 HTML 字符串。 */
function render(element) {
  return renderToStaticMarkup(element)
}

// ── A. 源码级组件渲染 ──────────────────────────────────────────────────────
// 组件通过 runtime 的 rt.React 取钩子，所以必须先注入。
const { bindReact } = await import('../src/client/runtime.js')
bindReact(React)

const model = await import('../src/model.js')
const { FlowCanvas, wheelPanDelta } = await import('../src/client/canvas.js')
const { Inspector } = await import('../src/client/inspector.js')
const { PreviewDialog, IssuesDialog } = await import('../src/client/dialogs.js')
const { FlowList } = await import('../src/client/flowlist.js')
const { FlowStudioPage } = await import('../src/client/page.js')
const {
  FsLogDrawer, conclusionOf, drawerActionFor, eventCountText, eventKey, eventSummary,
  filterEvents, findingsLineOf, isStaleLoad, nextDrawerOpen, nodeFindingsInfo,
  nodeProgressText, normalizeRun, pageSlice, readUsage, sortEventsDesc,
} = await import('../src/client/logdrawer.js')
const {
  FS_TOKEN_STORAGE_KEY, authorizationHeader, captureFsToken, exportUrl,
  extractFsToken, requestFailureText,
} = await import('../src/client/api.js')

const flow = model.defaultFlow()
flow.id = 'flow-test'
const { beginLink } = await import('../src/client/link.js')

console.log('components')

check('画布渲染出全部阶段节点与打回标签', () => {
  const html = render(React.createElement(FlowCanvas, {
    flow,
    selection: { kind: 'node', id: 'n_req' },
    onSelect() {},
    onMoveNode() {},
    onAddEdge() {},
    onAddNodeAt() {},
  }))
  for (const stage of ['任务输入', '需求分析', '方案设计', '结构设计', '开发', '测试', '代码审查', '完成']) {
    assert.ok(html.includes(stage), `画布上缺少「${stage}」`)
  }
  assert.ok(html.includes('打回'), '打回线的标签没画出来')
  assert.ok(html.includes('fs-node kind-stage selected'), '选中的节点没有高亮类')
  assert.ok(html.includes('<svg'), '连线层没有 SVG')
})

check('键盘连线待定：候选列出「到 <节点名>」并高亮当前目标', () => {
  const linkState = beginLink(flow.nodes, 'n_req')
  const html = render(React.createElement(FlowCanvas, {
    flow,
    selection: { kind: 'node', id: 'n_req' },
    linkState,
    onSelect() {},
    onMoveNode() {},
    onAddEdge() {},
    onAddNodeAt() {},
    onPickCandidate() {},
  }))
  assert.ok(html.includes('连线待定：从「需求分析」到'), '连线待定态没有可读的源节点名')
  assert.ok(html.includes('到 方案设计'), '候选没有显示「到 <节点名>」')
  assert.ok(html.includes('fs-link-option on'), '当前候选没有高亮')
  assert.ok(html.includes('fs-link-target'), '候选节点没有高亮类')
  assert.ok(html.includes('Tab 切换 · Enter 确认 · Esc 取消'), '缺少键盘操作提示')
})

check('打回线超过 6 条：画 +N 汇总角标并提示已并入最外航道', () => {
  const crowded = model.defaultFlow()
  crowded.id = 'flow-crowded'
  const extra = [
    ['n_review', 'n_req'], ['n_test', 'n_req'], ['n_shape', 'n_req'],
    ['n_plan', 'n_start'], ['n_review', 'n_start'],
  ]
  extra.forEach(([from, to], index) => {
    crowded.edges.push({ id: 'e_extra_' + index, from, to, kind: 'reject', label: '溢出打回' })
  })
  const html = render(React.createElement(FlowCanvas, {
    flow: crowded,
    selection: null,
    onSelect() {},
    onMoveNode() {},
    onAddEdge() {},
    onAddNodeAt() {},
  }))
  assert.ok(html.includes('+3'), '第 7 条起应当在航道末端汇总 +N')
  assert.ok(html.includes('并入最外航道'), '缺少确定性降级提示')
  assert.ok(!html.includes('结构设计被打回'), '并入最外航道的边应当收起标签')
})

check('Shift+滚轮走横移；Ctrl/Cmd 与裸滚轮仍走缩放', () => {
  // 判定顺序：Shift 且不带 Ctrl/Cmd 才是横移；pinch 带 ctrlKey，必须仍走缩放。
  assert.equal(wheelPanDelta({ shiftKey: true, deltaY: 120, deltaX: 0 }), 120, 'Shift+滚轮应返回横移增量')
  assert.equal(wheelPanDelta({ shiftKey: true, deltaY: 0, deltaX: -40 }), -40, '触控板横向手势应映射到横移')
  assert.equal(wheelPanDelta({ shiftKey: true, ctrlKey: true, deltaY: 120 }), null, 'pinch 带 ctrlKey 时仍走缩放')
  assert.equal(wheelPanDelta({ shiftKey: true, metaKey: true, deltaY: 120 }), null, 'Cmd+Shift 仍走缩放')
  assert.equal(wheelPanDelta({ shiftKey: false, deltaY: 120 }), null, '裸滚轮保持缩放')
})

check('检查器（节点）渲染出执行方式与 skills 选择器', () => {
  const html = render(React.createElement(Inspector, {
    flow,
    selection: { kind: 'node', id: 'n_req' },
    skills: [{ name: 'java-service', description: 'Java 服务开发规范', whenToUse: '' }],
    onPatchNode() {},
    onPatchEdge() {},
    onDeleteNode() {},
    onDeleteEdge() {},
    onAddMember() {},
    onPatchMember() {},
    onRemoveMember() {},
  }))
  assert.ok(html.includes('角色定位'))
  assert.ok(html.includes('单个 agent'))
  assert.ok(html.includes('主管 + 子 agent'))
  assert.ok(html.includes('java-service'), '技能列表没渲染出来')
  assert.ok(html.includes('资深需求分析师'), '角色内容没回填')
  assert.ok(html.includes('连接到…'), '单指针连线入口没渲染')
  assert.ok(html.includes('到 方案设计'), '连线目标没有可读名字')
  assert.ok(html.includes('位置'), '可点按移动入口没渲染')
  assert.ok(html.includes('X 300 · Y 220'), '当前坐标没显示')
  assert.ok(html.includes('按住 Shift 步长 20px'), '微调步长提示没渲染')
  assert.ok(html.includes('>上<') && html.includes('>下<') && html.includes('>左<') && html.includes('>右<'), '四个方向按钮不齐')
})

check('检查器（打回连线）渲染出打回说明输入', () => {
  const reject = flow.edges.find(edge => edge.kind === 'reject')
  const html = render(React.createElement(Inspector, {
    flow,
    selection: { kind: 'edge', id: reject.id },
    skills: [],
    onPatchNode() {},
    onPatchEdge() {},
    onDeleteNode() {},
    onDeleteEdge() {},
    onAddMember() {},
    onPatchMember() {},
    onRemoveMember() {},
  }))
  assert.ok(html.includes('正常流转'))
  assert.ok(html.includes('打回说明'))
  assert.ok(html.includes(reject.label), '打回说明没回填原值')
})

check('没有选中时检查器给出操作提示', () => {
  const html = render(React.createElement(Inspector, {
    flow,
    selection: null,
    skills: [],
    onPatchNode() {},
    onPatchEdge() {},
    onDeleteNode() {},
    onDeleteEdge() {},
    onAddMember() {},
    onPatchMember() {},
    onRemoveMember() {},
  }))
  assert.ok(html.includes('双击空白处新增节点'))
})

check('流转预览列出阶段与打回', () => {
  const html = render(React.createElement(PreviewDialog, { flow, onClose() {} }))
  assert.ok(html.includes('流转预览'))
  assert.ok(html.includes('需求分析'))
  assert.ok(html.includes('打回上限默认 2 轮'))
})

check('校验弹层把错误与提醒分开渲染', () => {
  const broken = model.defaultFlow()
  broken.nodes = broken.nodes.filter(node => node.kind !== 'start')
  const html = render(React.createElement(IssuesDialog, {
    validation: model.validateFlow(broken),
    onSelect() {},
    onClose() {},
  }))
  assert.ok(html.includes('个错误'))
  assert.ok(html.includes('开始'))
})

check('流程列表渲染条目与删除入口', () => {
  const html = render(React.createElement(FlowList, {
    flows: [{ id: 'flow-test', name: '标准研发流水线', description: '', nodeCount: 8, edgeCount: 11, rejectCount: 4, updatedAt: new Date().toISOString() }],
    activeId: 'flow-test',
    busy: false,
    onOpen() {},
    onCreate() {},
    onDelete() {},
  }))
  assert.ok(html.includes('标准研发流水线'))
  assert.ok(html.includes('4 打回'))
  assert.ok(html.includes('删除'))
})

check('页面带流程时装配出画布 / 检查器 / 底栏', () => {
  const html = render(React.createElement(FlowStudioPage, {
    initialFlow: flow,
    initialSkills: [{ name: 'java-service', description: 'Java 服务开发规范', whenToUse: '' }],
  }))
  assert.ok(html.includes('标准研发流水线'), '标题没回填')
  assert.ok(html.includes('需求分析'), '画布没渲染节点')
  assert.ok(html.includes('双击空白处新增节点'), '检查器没进入空选中态')
  assert.ok(html.includes('条打回'), '底栏没统计打回')
  assert.ok(html.includes('结构完整'), '底栏没显示校验结论')
  assert.ok(html.includes('已加载'), '保存状态没显示')
  assert.ok(html.includes('aria-live="polite"'), '状态栏缺少 aria-live 播报区')
  assert.ok(html.includes('role="status"'), '状态栏缺少 status 角色')
})

check('页面骨架在没有流程时给出加载态', () => {
  const html = render(React.createElement(FlowStudioPage))
  assert.ok(html.includes('fs-root'))
  assert.ok(html.includes('正在加载'))
  assert.ok(html.includes('.fs-node'), '样式没有随组件一起渲染')
})

// 运行日志抽屉：数据都走 initial* 注入，SSR 不跑 useEffect，正好验纯渲染状态机。
const logRun = {
  id: 'run-20261106-1',
  name: '标准研发流水线 · 第一次',
  flowId: 'flow-test',
  flowName: '标准研发流水线',
  status: 'done',
  startedAt: '2026-11-06T10:00:00+08:00',
  endedAt: '2026-11-06T10:12:00+08:00',
  nodeDone: 5,
  nodeTotal: 6,
  tokenTotal: 50000,
}
const logUsage = { input: 8000, cacheRead: 40000, cacheWrite: 0, output: 2000, reasoning: 300 }
const logSummary = {
  tokens: {
    // 与 Host `summarize()` 同形：total 是一个四桶对象，byNode 按节点分桶。
    total: logUsage,
    byNode: { n_req: { input: 1000, cacheRead: 2000, cacheWrite: 0, output: 500, reasoning: 100, total: 3500, calls: 1 } },
  },
  findings: { total: 2, unresolved: 1, bySeverity: { P0: 1, P1: 1 }, byStatus: { open: 1, verified: 1 } },
  quality: { state: 'pass', label: '良：返工 1 轮后达标' },
  computedAt: '2026-11-06T10:12:00+08:00',
  eventCount: 4,
}
const logEvents = [
  {
    v: 1, ts: '2026-11-06T10:00:01+08:00', kind: 'run/start', runId: logRun.id,
    attemptId: 1, seq: 1, traceId: 't0', data: { flowId: 'flow-test', flowName: '标准研发流水线', nodeTotal: 6 },
  },
  {
    v: 1, ts: '2026-11-06T10:00:05+08:00', kind: 'node/start', runId: logRun.id,
    nodeId: 'n_req', attemptId: 1, seq: 2, traceId: 't1', data: { title: '需求分析', mode: 'single' },
  },
  {
    v: 1, ts: '2026-11-06T10:02:00+08:00', kind: 'review/finding', runId: logRun.id,
    nodeId: 'n_req', attemptId: 1, seq: 3, traceId: 't2',
    ref: { sessionId: 'sess-abc', logLine: 42 },
    data: { id: 'f1', severity: 'P0', title: '缺少验收证据', status: 'open' },
  },
  {
    v: 1, ts: '2026-11-06T10:03:00+08:00', kind: 'review/finding', runId: logRun.id,
    nodeId: 'n_req', attemptId: 1, seq: 4, traceId: 't3',
    data: { id: 'f2', severity: 'P1', title: '命名不一致', status: 'verified' },
  },
]

check('抽屉收起态：run 名 · 状态点 · 四段 token 合计 · 结论 pill', () => {
  const html = render(React.createElement(FsLogDrawer, {
    open: false,
    onToggle() {},
    initialRuns: [logRun],
    initialRunId: logRun.id,
    initialSummary: logSummary,
  }))
  assert.ok(html.includes('标准研发流水线 · 第一次'), '收起条没显示 run 名')
  assert.ok(html.includes('fs-log-dot success'), '状态点没有按 run 状态着色')
  assert.ok(html.includes('四段合计 50k tok'), '没有把四段 token 合计成一行')
  assert.ok(html.includes('入 8k · 缓存读 40k · 缓存写 0 · 出 2k'), '没有显示四段明细')
  assert.ok(html.includes('良：返工 1 轮后达标'), '结论 pill 没显示 summary.quality.label')
  assert.ok(html.includes('aria-expanded="false"'), '收起态缺少 aria-expanded')
  assert.ok(!html.includes('事件详情'), '收起态不该渲染三栏明细')
})

check('抽屉无 run：显示「还没有运行记录」与「刷新」', () => {
  const html = render(React.createElement(FsLogDrawer, {
    open: false,
    onToggle() {},
    initialRuns: [],
  }))
  assert.ok(html.includes('还没有运行记录'), '无 run 时缺少空态文案')
  assert.ok(html.includes('刷新'), '无 run 时缺少刷新入口')
})

check('抽屉错误态：给出可读失败文案与重试', () => {
  const html = render(React.createElement(FsLogDrawer, {
    open: true,
    onToggle() {},
    initialRuns: [],
    initialError: '运行日志读取失败：连不上 Host',
  }))
  assert.ok(html.includes('运行日志读取失败：连不上 Host'), '错误文案没显示')
  assert.ok(html.includes('重试'), '错误态缺少重试入口')
})

check('抽屉展开态：三栏渲染 run 列表 / 事件行 / 事件详情', () => {
  const html = render(React.createElement(FsLogDrawer, {
    open: true,
    onToggle() {},
    initialRuns: [logRun],
    initialRunId: logRun.id,
    initialSummary: logSummary,
    // 与 Host readRunDetail 同形：只有 nodeId / attempts，标题要从 node/start 事件补。
    initialDetail: { run: logRun, nodes: [{ nodeId: 'n_req', eventCount: 3, attempts: [{ attemptId: 1, eventCount: 3 }] }], eventCount: 4 },
    initialEvents: logEvents,
    initialSelectedEventKey: eventKey(logEvents[2]),
    onJumpToNode() {},
  }))
  for (const needle of [
    '运行记录 · 最近 20', '事件流', '事件详情', 'node/start', 'review/finding',
    '缺少验收证据', '导出 md', '复制 runId', '刷新', '跳回画布',
  ]) {
    assert.ok(html.includes(needle), '展开态缺少「' + needle + '」')
  }
  assert.ok(html.includes('&quot;severity&quot;: &quot;P0&quot;'), '详情没有渲染原始 JSON')
  assert.ok(html.includes('sess-abc') && html.includes('第 42 行'), 'ref 提示没渲染')
  assert.ok(html.includes('3.5k'), '该节点 token 合计没渲染')
  assert.ok(html.includes('共 2 条 · 未解决 1') && html.includes('P0 1'), 'findings 计数没渲染')
  assert.ok(html.includes('已复验 1'), 'verified 的 finding 没进已复验计数')
  assert.ok(html.includes('role="listbox"') && html.includes('aria-activedescendant'), '事件流缺少 listbox 键盘语义')
  assert.ok(html.includes('第 1/1 页 · 200 条/页'), '缺少 200 条/页的分页信息')
})

check('done + 无 summary：结论 pill 为中性，不冒充绿色（审核 M8）', () => {
  const html = render(React.createElement(FsLogDrawer, {
    open: false,
    onToggle() {},
    initialRuns: [logRun],
    initialRunId: logRun.id,
  }))
  assert.ok(html.includes('fs-log-pill neutral'), '没有 quality 证据时 pill 必须是中性档')
  assert.ok(html.includes('完成 · 质量未检测'), '中性 pill 要写清「质量未检测」')
  assert.ok(!html.includes('fs-log-pill success'), '没有 summary 时绝不能出现绿 pill')
  assert.equal(conclusionOf(logRun, null).tone, 'neutral')
  assert.equal(conclusionOf(logRun, { quality: { state: 'pass' } }).tone, 'success')
})

check('结论 pill 按 04 §3.9.3 映射：warn 是「可」不是「需返工」（审核 m6）', () => {
  const pass = conclusionOf(logRun, { quality: { state: 'pass', label: '优：首轮通过' } })
  assert.equal(pass.tone, 'success')
  assert.equal(pass.text, '优：首轮通过')
  const warn = conclusionOf(logRun, { quality: { state: 'warn', label: '可：返工 2 轮后达标' } })
  assert.equal(warn.tone, 'warn')
  assert.ok(warn.text.startsWith('可：'), 'warn 档文案应以「可」开头')
  assert.ok(!warn.text.includes('需返工'), 'warn 不是「需返工」，那是 fail / 未通过')
  const warnNoLabel = conclusionOf(logRun, { quality: { state: 'warn' } })
  assert.ok(!warnNoLabel.text.includes('需返工'), '缺 label 的 warn 也不能写成需返工')
  const fail = conclusionOf(logRun, { quality: { state: 'fail', label: '需返工：测试未通过' } })
  assert.equal(fail.tone, 'error', 'fail 必须是红档')
  assert.ok(fail.text.includes('需返工'))
  const unknown = conclusionOf(logRun, { quality: { state: 'unknown', label: '证据不足：测试未检测' } })
  assert.equal(unknown.tone, 'warn', 'Host 明确判 unknown 时按 04 走黄（证据不足），不是绿')
  const failed = conclusionOf({ ...logRun, status: 'failed' }, { quality: { state: 'pass' } })
  assert.equal(failed.tone, 'error', '运行失败优先于质量结论')
  assert.equal(failed.text, '失败')
})

check('findings 按 seq 升序取最后状态：先 open 后 verified 算已复验（审核 M4）', () => {
  const events = sortEventsDesc([
    {
      kind: 'review/finding', nodeId: 'n_req', seq: 7, ts: '2026-11-06T10:02:00+08:00',
      data: { id: 'f1', severity: 'P1', title: '命名不一致', status: 'open' },
    },
    {
      kind: 'review/finding', nodeId: 'n_req', seq: 8, ts: '2026-11-06T10:03:00+08:00',
      data: { id: 'f1', severity: 'P1', title: '命名不一致', status: 'verified' },
    },
  ])
  // 事件流是倒序（verified 在前、open 在后）；旧实现「同 id 取最后一次」会被 open 覆盖。
  const info = nodeFindingsInfo(null, 'n_req', events)
  assert.equal(info.total, 1, '同一 finding id 只算一条')
  assert.equal(info.open, 0, 'seq 更大的 verified 必须覆盖更早的 open')
  assert.equal(info.verified, 1, 'verified 应单列为已复验')
  assert.equal(info.bySeverity.P1, 1)
  const line = findingsLineOf(info, { truncated: false, loadedCount: events.length })
  assert.ok(line.includes('共 1 条 · 未解决 0'), '未解决数应按最新状态算 0')
  assert.ok(line.includes('已复验 1'), '详情要显示已复验数')
})

check('截断与过滤口径：分母与「基于最近 N 条（截断）」（审核 m4）', () => {
  assert.equal(
    eventCountText({ filteredCount: 3, loadedCount: 12, total: 40, truncated: true, filterActive: false }),
    '3 / 40 条 · 基于最近 12 条（截断）',
    '截断时必须写明基于最近 N 条',
  )
  assert.equal(
    eventCountText({ filteredCount: 1, loadedCount: 12, total: 40, truncated: false, filterActive: true }),
    '筛出 1 / 1 条',
    '过滤生效时分母用过滤后的长度，不拿全 run 的 total',
  )
  assert.equal(
    eventCountText({ filteredCount: 4, loadedCount: 4, total: 4, truncated: false, filterActive: false }),
    '4 / 4 条',
  )
  const line = findingsLineOf(
    { total: 2, open: 1, verified: 0, bySeverity: { P0: 1, P1: 1, P2: 0 } },
    { truncated: true, loadedCount: 1000 },
  )
  assert.ok(line.includes('基于最近 1000 条（截断）'), 'findings 计数基于截断事件时必须标注')
  const summaryLine = findingsLineOf(
    { total: 2, open: 1, verified: 0, bySeverity: { P0: 1, P1: 1, P2: 0 }, fromSummary: true },
    { truncated: true, loadedCount: 1000 },
  )
  assert.ok(!summaryLine.includes('截断'), 'summary 是全量口径，不能误标成截断计数')
  const html = render(React.createElement(FsLogDrawer, {
    open: true,
    onToggle() {},
    initialRuns: [logRun],
    initialRunId: logRun.id,
    initialSummary: logSummary,
    initialDetail: { run: logRun, nodes: [{ nodeId: 'n_req', eventCount: 4, attempts: [{ attemptId: 1, eventCount: 4 }] }], eventCount: 40 },
    initialEvents: { events: logEvents, total: 40, truncated: true },
    initialSelectedEventKey: eventKey(logEvents[2]),
  }))
  assert.ok(html.includes('基于最近 4 条（截断）'), '渲染层没有透出截断标注')
})

check('切 run 请求代次：旧响应与已切换 run 的响应都判为过期（审核 m5）', () => {
  assert.equal(isStaleLoad({ requestId: 2, latestRequestId: 2, runId: 'a', selectedRunId: 'a' }), false)
  assert.equal(isStaleLoad({ requestId: 1, latestRequestId: 2, runId: 'a', selectedRunId: 'a' }), true,
    '同一 run 的旧请求不能覆盖新请求')
  assert.equal(isStaleLoad({ requestId: 2, latestRequestId: 2, runId: 'a', selectedRunId: 'b' }), true,
    '选中 run 已变化时必须丢弃旧响应')
})

check('数值 0 与未记录分开；skill/load 缺 ok 不写已加载（审核 m8）', () => {
  const zero = readUsage({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
  assert.equal(zero.recorded, true, '四桶全 0 是「记录过且为 0」，不是未记录')
  assert.equal(zero.total, 0)
  assert.deepEqual(zero.missing, [], '显式给的 0 不算缺桶')
  const absent = readUsage({})
  assert.equal(absent.recorded, false)
  assert.deepEqual(absent.missing, ['input', 'cacheRead', 'cacheWrite', 'output'])
  assert.equal(eventSummary({ kind: 'skill/load', data: { skill: 'java-service' } }), 'java-service 加载状态未知',
    '缺 ok 不能默认「已加载」')
  assert.equal(eventSummary({ kind: 'skill/load', data: { skill: 'java-service', ok: true } }), 'java-service 已加载')
  assert.equal(eventSummary({ kind: 'skill/load', data: { skill: 'java-service', ok: false } }), 'java-service 加载失败')
  const modelCall = eventSummary({
    kind: 'model/call',
    data: { provider: 'p', model: 'm', usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } },
  })
  assert.ok(modelCall.includes('token 0'), '记录过的 0 要显示 0')
  assert.ok(!modelCall.includes('未记录'), '0 不能显示成未记录')
})

check('可选鉴权：fs_token 存一次、Authorization 头与 401 文案（05 §8.5）', () => {
  const writes = []
  const storage = {
    setItem(key, value) { writes.push([key, value]) },
    getItem() { return null },
  }
  assert.equal(extractFsToken('?fs_token=abc%20123'), 'abc 123')
  assert.equal(extractFsToken('?foo=1'), '')
  assert.equal(extractFsToken(''), '')
  assert.equal(captureFsToken('?fs_token=tok-1', storage), 'tok-1')
  assert.deepEqual(writes, [[FS_TOKEN_STORAGE_KEY, 'tok-1']], '令牌应存进 sessionStorage 一次')
  assert.deepEqual(authorizationHeader('tok-1'), { Authorization: 'Bearer tok-1' })
  assert.deepEqual(authorizationHeader(''), {}, '没有令牌时不加 Authorization 头')
  assert.equal(requestFailureText(401, {}), '需要访问令牌：用 ?fs_token=… 打开一次')
  assert.equal(requestFailureText(500, { error: '内部错误' }), '内部错误')
})

check('nodeDone/nodeTotal 只取 Host 值，缺失显示「—」（05 §8.3）', () => {
  const full = normalizeRun({ id: 'r1', nodeDone: 5, nodeTotal: 6 })
  assert.equal(full.nodeDone, 5)
  assert.equal(nodeProgressText(full), '5/6')
  const missing = normalizeRun({ id: 'r2' })
  assert.equal(missing.nodeDone, null, '缺失的 nodeDone 不能落成 0')
  assert.equal(missing.nodeTotal, null, '缺失的 nodeTotal 不能落成 0')
  assert.equal(nodeProgressText(missing), '—')
  assert.equal(nodeProgressText(normalizeRun({ id: 'r3', nodeDone: 2 })), '2/—')
  const html = render(React.createElement(FsLogDrawer, {
    open: true,
    onToggle() {},
    initialRuns: [{ id: 'run-noprog', name: '无进度', status: 'done' }],
    initialRunId: 'run-noprog',
    initialEvents: [{ kind: 'node/end', nodeId: 'n_req', attemptId: 1, seq: 1, data: { status: 'passed' } }],
  }))
  assert.ok(html.includes('完成 · —'), 'Host 没给进度时应显示「—」，不能用事件自行推出 1/1')
  assert.ok(!html.includes('完成 · 1/1'), '客户端不许用事件自行推出进度')
})

check('未识别事件与缺失字段不抛错，降级成可读占位', () => {
  const html = render(React.createElement(FsLogDrawer, {
    open: true,
    onToggle() {},
    initialRuns: [{ id: 'run-bad' }],
    initialRunId: 'run-bad',
    initialEvents: [{ kind: 'future/unknown' }, {}],
  }))
  assert.ok(html.includes('run-bad'), '缺 name 的 run 没显示 id 兜底')
  assert.ok(html.includes('未识别事件类型'), '未知 kind 没有降级文案')
  assert.ok(html.includes('token 未记录'), '缺 usage 时没有如实写未记录')
})

check('运行日志数据归一化：缺桶、空事件、缺字段都不抛错', () => {
  assert.equal(readUsage({ input: 1200 }).total, 1200)
  assert.equal(readUsage({ output: 900, reasoning: 300 }).total, 900, 'reasoning 是 output 子集，不能重复加总')
  assert.equal(readUsage(null).recorded, false)
  assert.equal(readUsage({ cacheRead: 5, cacheWrite: 6, input: 7, output: 8 }).total, 26)
  assert.equal(filterEvents([{ kind: 'a' }, { kind: 'b', nodeId: 'n' }], { nodeId: 'n' }).length, 1)
  assert.equal(filterEvents(undefined, {}).length, 0)
  const paged = pageSlice(Array.from({ length: 401 }, (_, index) => ({ kind: 'x', seq: index })), 3, 200)
  assert.equal(paged.pageCount, 3, '401 条应分成 3 页')
  assert.equal(paged.items.length, 1, '第 3 页应只剩 1 条')
  assert.equal(eventSummary({ kind: 'future/x' }), '未识别事件类型（future/x）')
  assert.equal(exportUrl('run-1'), '/api/flow-studio/runs/run-1/export')
  const unordered = [{ ts: '2026-11-06T10:00:01+08:00', seq: 1 }, { ts: '2026-11-06T10:00:03+08:00', seq: 3 }]
  assert.deepEqual(sortEventsDesc(unordered).map(event => event.seq), [3, 1], '事件流必须时间倒序')
})

check('Ctrl/Cmd+J 开关抽屉；C / Delete / 方向键不归抽屉抢', () => {
  assert.equal(drawerActionFor({ key: 'j', ctrlKey: true }), 'toggle')
  assert.equal(drawerActionFor({ key: 'J', metaKey: true }), 'toggle')
  assert.equal(drawerActionFor({ key: 'j' }), null, '裸 J 不应开合抽屉')
  assert.equal(drawerActionFor({ key: 'j', ctrlKey: true, shiftKey: true }), null, 'Ctrl+Shift+J 留给浏览器')
  assert.equal(drawerActionFor({ key: 'j', ctrlKey: true, repeat: true }), null, '长按重复事件不应反复开合')
  assert.equal(drawerActionFor({ key: 'j', ctrlKey: true, altKey: true }), null)
  assert.equal(nextDrawerOpen(false), true)
  assert.equal(nextDrawerOpen(true), false)
  assert.equal(drawerActionFor({ key: 'c' }), null, 'C 是画布连线键，不能被抽屉吞掉')
  assert.equal(drawerActionFor({ key: 'Delete' }), null, 'Delete 是画布删除键，不能被抽屉吞掉')
  assert.equal(drawerActionFor({ key: 'ArrowDown' }), null, '方向键归事件流自身处理')
})

check('页面底部装配运行日志抽屉，且位于主体之后、底栏之前', () => {
  const html = render(React.createElement(FlowStudioPage, { initialFlow: flow, initialSkills: [] }))
  assert.ok(html.includes('class="fs-log"'), '页面没挂运行日志抽屉')
  assert.ok(html.includes('aria-expanded="false"'), '抽屉默认应当是收起的')
  const drawerAt = html.indexOf('class="fs-log"')
  const footerAt = html.indexOf('class="fs-status"')
  assert.ok(drawerAt > 0 && footerAt > drawerAt, '抽屉应在主体之后、底栏之前，不能遮挡检查器')
})

// ── B. 构建产物 ────────────────────────────────────────────────────────────
console.log('lib/client.js')

check('打包产物在假浏览器环境里能加载并注册成对的两个 slot', () => {
  const code = readFileSync(join(repoRoot, 'lib/client.js'), 'utf8')
  let entry = null
  const sandboxWindow = {
    __ModuleLoader__: {
      load(value) {
        entry = value
      },
    },
  }
  const previous = globalThis.window
  globalThis.window = sandboxWindow
  try {
    vm.runInThisContext(code, { filename: 'lib/client.js' })
  } finally {
    globalThis.window = previous
  }

  assert.ok(entry, '__ModuleLoader__.load 没被调用')
  assert.equal(entry.id, '@feiyueve/dsh-flow-studio', '注册 id 必须等于包名')

  const plugin = entry.factory(name => {
    if (name === 'react') return React
    throw new Error(`未知的浏览器模块依赖：${name}`)
  })
  assert.equal(plugin.name, 'flow-studio')
  assert.deepEqual(plugin.inject, ['slots'])

  const registrations = []
  plugin.apply({
    slots: {
      // 与宿主同形：register(options, Component) 返回 disposer，inject(ownerKey, cb) 在
      // 拥有者折叠时清理、回来时重装。
      register(options, component) {
        return { ...options, component }
      },
      inject(ownerKey, callback) {
        registrations.push({ ownerKey, ...callback() })
        return () => {}
      },
    },
  })

  assert.equal(registrations.length, 2, '应当注册 main 与 sidebar.panellist 两处')
  const main = registrations.find(item => item.name === 'main')
  const icon = registrations.find(item => item.name === 'sidebar.panellist')
  assert.ok(main, '没有注册 main 槽')
  assert.ok(icon, '没有注册 sidebar.panellist 槽')
  assert.equal(icon.id, main.key, '侧栏 id 必须等于 main 的 key，否则点击会抛错')
  assert.equal(typeof main.component, 'function', 'main 槽的组件不是函数')
  assert.equal(typeof icon.component, 'function', '侧栏图标不是函数')

  const html = render(React.createElement(main.component))
  assert.ok(html.includes('fs-root'), '面板组件渲染不出根节点')

  const iconHtml = render(React.createElement(icon.component, { size: 18, active: true }))
  assert.ok(iconHtml.includes('<svg'), '侧栏图标不是 SVG')
})

console.log(`\n${checks} 组通过`)
