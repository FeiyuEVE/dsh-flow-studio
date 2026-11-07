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
import ReactDOM from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

/** 异步检查（共享数据源 / 删除序列这类必须 await 的用例）。 */
async function checkAsync(name, fn) {
  await fn()
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
const {
  FlowCanvas, canConnectNodes, createDragHandlers, edgeAriaLabel, edgeListText, guardStructureEdit,
  interactionState, isEdgeActive, lodText, nodeAriaLabel, snapToGridEnabled, stateShape, wheelPanDelta,
} = await import('../src/client/canvas.js')
const { SNAP_GRID, lodOf, rejectPathRects, snapPosition } = await import('../src/client/geometry.js')
const { Inspector } = await import('../src/client/inspector.js')
const { PreviewDialog, IssuesDialog } = await import('../src/client/dialogs.js')
const { FlowList, isGroupOpen, nextGroupToggles } = await import('../src/client/flowlist.js')
const {
  NODE_STATUS_EMPTY_TEXT, NODE_STATUS_SCROLL_AT, blockersText, deleteConfirmText,
  hasNodeStatus, nodeStatusEntries, nodeStatusOf, nodeTitleMap, sessionModeText,
  worktreeDetailText, worktreeReasonText,
} = await import('../src/client/flowlist.js')
const { FlowStudioPage, runControlState } = await import('../src/client/page.js')
const {
  RUN_LOCK_REASON, STOP_CONFIRM_DELAY_MS, activeRunViewOf, conflictTarget, createSaveQueue,
  deleteFlowRequest, firstErrorTarget, emptyGraphBlockReason, flowSavePayload, mergeSavedFlow,
  progressOf, restoreFlowRequest, runEndAnnouncement, runPreflight, saveBodyFor,
  saveStateAfterSuccess, startFailurePlan,
} = await import('../src/client/page.js')
const {
  EVENT_FETCH_LIMIT, FsLogDrawer, HIDDEN_POLL_MS, LIVE_POLL_MS, MAX_POLL_MS,
  WATCH_EVENT_KINDS, acceptanceOf, backoffDelay, conclusionOf, deriveNodeStates,
  drawerActionFor, eventCountText, eventKey, eventSummary, eventWindowNote, eventsSince,
  filterEvents, findingsLineOf, formatDuration, isStaleLoad, latestSeq, liveOf,
  mergeEventWindows, mergeRunDetail, needsEventFetch, nextDrawerOpen, nodeFindingsInfo, nodeProgressText, normalizeLive,
  normalizeProgress, normalizeRun, pageSlice, pickWatchRun, pollDelay, readUsage,
  runDurationMs, runIsActive, runIsPending, runIsRunning, runLiveLabel, runMetrics,
  sortEventsDesc, statusText, stubBadgeOf,
} = await import('../src/client/logdrawer.js')
const {
  FS_TOKEN_STORAGE_KEY, LIGHT_POLL_FALLBACK_NOTICE, RUNS_IDLE_POLL_MS, api, authorizationHeader,
  captureFsToken, createLightRunReader, createRunsSource, exportUrl, extractFsToken,
  readEventsPath, readRunPath, requestFailureText, runActionFailureText,
} = await import('../src/client/api.js')
const { CSS } = await import('../src/client/styles.js')

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

// F2（只增）：运行必须有显式工作区。SSR 直接渲染 src 组件即可验证，不依赖 lib 构建产物。
check('F2：工作区回填进顶栏；空工作区标 invalid 且运行按钮写明「未选择工作区」', () => {
  const withWorkspace = render(React.createElement(FlowStudioPage, {
    initialFlow: flow,
    initialSkills: [],
    initialWorkspace: '/repo/a',
  }))
  assert.ok(withWorkspace.includes('aria-label="工作区绝对路径"'), '顶栏缺少工作区输入（无障碍名）')
  assert.match(withWorkspace, /class="fs-workspace-input"[^>]*value="\/repo\/a"/, 'initialWorkspace 必须回填到输入框')
  assert.match(withWorkspace, /class="fs-workspace-input"[^>]*aria-invalid="false"/, '合法工作区不能标成 invalid')

  const withoutWorkspace = render(React.createElement(FlowStudioPage, { initialFlow: flow, initialSkills: [] }))
  assert.match(withoutWorkspace, /class="fs-workspace-input"[^>]*aria-invalid="true"/, '空工作区必须标成 invalid')
  assert.match(withoutWorkspace, /title="[^"]*未选择工作区[^"]*"/, '运行按钮 title 必须说明未选择工作区')
  // 原有 m7 原因（运行列表没回来）不能被新原因吞掉，两条都要写出来。
  assert.match(withoutWorkspace, /title="[^"]*正在读取运行记录[^"]*"/, '原有「运行列表未回」原因不能丢')
  assert.ok(withoutWorkspace.includes('placeholder="/path/to/workspace（绝对路径）"'), '空态要有可读占位')

  const blocked = runControlState({ id: 'r1', status: 'pending' }, { hasFlow: true, hasWorkspace: false })
  assert.equal(blocked.startDisabled, true, '没工作区时「运行」必须禁用')
  assert.ok(blocked.startTitle.includes('未选择工作区'))
  const ready = runControlState({ id: 'r1', status: 'pending' }, { hasFlow: true, hasWorkspace: true })
  assert.equal(ready.startDisabled, false, '有工作区时不能被新门禁误禁')
})

// ── 运行控制与实时状态（06 §10 / §11）────────────────────────────────────
check('节点状态从事件 + live 推导：运行中 / 已通过 / 失败 / 未开始', () => {
  const nodes = [
    { id: 'n_req', title: '需求分析' },
    { id: 'n_plan', title: '方案设计' },
    { id: 'n_dev', title: '开发' },
    { id: 'n_review', title: '代码审查' },
    { id: 'n_fresh', title: '未触及' },
  ]
  const events = [
    { kind: 'node/start', nodeId: 'n_req', attemptId: 1, seq: 1, data: {} },
    { kind: 'node/end', nodeId: 'n_req', attemptId: 1, seq: 2, data: { status: 'passed' } },
    { kind: 'node/start', nodeId: 'n_dev', attemptId: 1, seq: 3, data: {} },
    { kind: 'node/end', nodeId: 'n_dev', attemptId: 1, seq: 4, data: { status: 'failed' } },
    { kind: 'node/start', nodeId: 'n_review', attemptId: 1, seq: 5, data: {} },
  ]
  const states = deriveNodeStates({
    nodes,
    events,
    live: { currentNodeId: 'n_review', attempt: 1, round: 3 },
    runStatus: 'running',
  })
  assert.equal(states.n_req.state, 'passed')
  assert.equal(states.n_req.label, '已通过')
  assert.equal(states.n_req.glyph, '✓')
  assert.equal(states.n_dev.state, 'failed')
  assert.equal(states.n_dev.label, '失败')
  assert.equal(states.n_dev.glyph, '✕')
  assert.equal(states.n_review.state, 'running', 'live.currentNodeId 命中时应显示运行中')
  assert.equal(states.n_review.current, true)
  assert.equal(states.n_review.tone, 'business', '运行中必须走 business 环那一档')
  assert.equal(states.n_fresh.state, 'idle')
  assert.equal(states.n_fresh.label, '未开始')
  assert.equal(states.n_fresh.glyph, '○')

  // 没有 live 时回退：在跑 + 最近事件是 node/start → 运行中，attempt 取事件里的值。
  const noLive = deriveNodeStates({
    nodes: [{ id: 'n_dev' }],
    events: [{ kind: 'node/start', nodeId: 'n_dev', attemptId: 2, seq: 9, data: {} }],
    live: null,
    runStatus: 'running',
  })
  assert.equal(noLive.n_dev.state, 'running', '没有 live 时用「在跑 + 最近事件是 node/start」回退')
  assert.equal(noLive.n_dev.attempt, 2)
})

check('打回目标 ↺n 与旧通过失效：与 Host progress 同口径（04 §4.2 / 06 §11）', () => {
  const nodes = [{ id: 'n_req' }, { id: 'n_plan' }, { id: 'n_test' }]
  const events = [
    { kind: 'node/start', nodeId: 'n_req', attemptId: 1, seq: 1, data: {} },
    { kind: 'node/end', nodeId: 'n_req', attemptId: 1, seq: 2, data: { status: 'passed' } },
    { kind: 'node/start', nodeId: 'n_plan', attemptId: 1, seq: 3, data: {} },
    { kind: 'node/end', nodeId: 'n_plan', attemptId: 1, seq: 4, data: { status: 'passed' } },
    { kind: 'node/start', nodeId: 'n_test', attemptId: 1, seq: 5, data: {} },
    { kind: 'node/end', nodeId: 'n_test', attemptId: 1, seq: 6, data: { status: 'rejected' } },
    {
      kind: 'reject/trigger', nodeId: 'n_test', attemptId: 1, seq: 7,
      data: { fromNodeId: 'n_test', toNodeId: 'n_plan', reason: '缺验收证据' },
    },
  ]
  const states = deriveNodeStates({ nodes, events, live: null, runStatus: 'running' })
  assert.equal(states.n_plan.state, 'rejected', '被打回目标显示「被打回」而不是旧 ✓')
  assert.equal(states.n_plan.reworkCount, 0, '还没重跑时 ↺n 不能先记 1（04 §4.2 ② 数重跑次数）')
  assert.equal(states.n_plan.invalidated, true, '旧通过必须失效，不能和 Host progress 打架')
  assert.equal(states.n_req.state, 'passed', '更早的通过不在失效窗口内')
  assert.equal(states.n_test.state, 'rejected', '判定不通过的源节点自身显示被打回')
  assert.equal(states.n_test.reworkCount, 0, '源节点卡不显示打回数字（04 §4.2 ③）')

  // 目标真的重跑（attemptId=2）后才算一次返工；重跑通过后恢复 ✓。
  const rerun = deriveNodeStates({
    nodes,
    events: [
      ...events,
      { kind: 'node/start', nodeId: 'n_plan', attemptId: 2, seq: 8, data: {} },
      { kind: 'node/end', nodeId: 'n_plan', attemptId: 2, seq: 9, data: { status: 'passed' } },
    ],
    live: null,
    runStatus: 'running',
  })
  assert.equal(rerun.n_plan.state, 'passed', '重跑通过后应回到已通过')
  assert.equal(rerun.n_plan.reworkCount, 1, '目标重跑一次 → ↺1（记在 data.to 节点）')
})

check('B1：summary.progress 优先于事件窗口，截断不会把已通过节点显示成未开始', () => {
  const nodes = [{ id: 'n_req' }, { id: 'n_plan' }, { id: 'n_dev' }, { id: 'n_review' }]
  const progress = {
    passed: 2, total: 4, invalidatedNodes: ['n_plan'],
    nodes: {
      n_req: { attemptId: 1, status: 'passed' },
      n_plan: { attemptId: 1, status: 'passed', invalidated: true },
      n_dev: { attemptId: 2, status: 'failed' },
      n_review: { attemptId: 1, status: 'pending' },
    },
  }
  const states = deriveNodeStates({
    nodes,
    events: [], // 模拟事件窗口被截断 / 还没拉到：只有 progress 可用
    live: { currentNodeId: 'n_review', attempt: 1 },
    runStatus: 'running',
    progress,
  })
  assert.equal(states.n_req.state, 'passed', 'progress 里的 passed 不能退化成未开始')
  assert.equal(states.n_plan.state, 'rejected', 'invalidated 的旧通过不算数')
  assert.equal(states.n_plan.invalidated, true)
  assert.equal(states.n_dev.state, 'failed')
  assert.equal(states.n_dev.attempt, 2)
  assert.equal(states.n_review.state, 'running', 'live 当前节点优先')
  assert.equal(states.n_review.fromProgress, true)
  assert.equal(normalizeProgress(progress).entries.size, 4)
  assert.equal(normalizeProgress(progress).invalidated.has('n_plan'), true)

  // progress 与事件冲突时 progress 赢（与 Host nodeDone 同口径）。
  const conflict = deriveNodeStates({
    nodes: [{ id: 'n_req' }],
    events: [{ kind: 'node/start', nodeId: 'n_req', attemptId: 2, seq: 9 }],
    live: null,
    runStatus: 'running',
    progress: { nodes: { n_req: { status: 'passed', attemptId: 1 } } },
  })
  assert.equal(conflict.n_req.state, 'passed', 'progress 与事件冲突时以 Host progress 为准')

  // Map / 数组形态也兼容（Host 换序列化形状不会白屏）。
  const asMap = normalizeProgress({ nodes: new Map([['n_a', { status: 'passed' }]]) })
  assert.equal(asMap.entries.get('n_a').status, 'passed')
  const asArray = normalizeProgress({ nodes: [{ nodeId: 'n_b', status: 'failed' }], invalidatedNodes: ['n_c'] })
  assert.equal(asArray.entries.get('n_b').status, 'failed')
  assert.equal(asArray.invalidated.has('n_c'), true)

  // 详情接口可能只回 progress 计数、不带 nodes：不能把列表里更完整的 nodes 盖掉。
  const fromList = normalizeRun({ id: 'r1', progress: { nodes: { n_a: { status: 'passed' } } } })
  const merged = normalizeRun(mergeRunDetail(fromList, {
    id: 'r1', status: 'running', progress: { passed: 1, total: 1, ratio: 1 },
  }))
  assert.equal(merged.status, 'running', '详情更新状态')
  assert.equal(merged.progress.nodes.n_a.status, 'passed', '详情计数不能盖掉列表里的 progress.nodes')
  assert.equal(progressOf({ passed: 1 }, { nodes: { n_a: { status: 'passed' } } }, null).nodes.n_a.status,
    'passed', '优先选真正带 nodes 的 progress')

  // progress 旧快照不能把更新的 node/end 压回 pending；progress 缺的节点由事件补。
  const newerEvent = deriveNodeStates({
    nodes: [{ id: 'n_b' }],
    events: [{ kind: 'node/end', nodeId: 'n_b', attemptId: 1, seq: 7, data: { status: 'passed' } }],
    live: null,
    runStatus: 'running',
    progress: { nodes: { n_b: { attemptId: 1, status: 'pending', endSeq: 0 } } },
  })
  assert.equal(newerEvent.n_b.state, 'passed', '更新的 node/end 必须覆盖旧 progress')
  const gap = deriveNodeStates({
    nodes: [{ id: 'n_a' }, { id: 'n_b' }],
    events: [{ kind: 'node/end', nodeId: 'n_b', attemptId: 1, seq: 7, data: { status: 'passed' } }],
    live: null,
    runStatus: 'running',
    progress: { nodes: { n_a: { attemptId: 1, status: 'passed', endSeq: 2 } } },
  })
  assert.equal(gap.n_a.state, 'passed', 'progress 覆盖的节点照 progress')
  assert.equal(gap.n_b.state, 'passed', 'progress 缺的节点由事件补，不能变成未开始')
  // 旧 progress 里的 invalidated 不能把重跑通过的新结论压回「被打回」。
  const recovered = deriveNodeStates({
    nodes: [{ id: 'n_plan' }],
    events: [{ kind: 'node/end', nodeId: 'n_plan', attemptId: 2, seq: 9, data: { status: 'passed' } }],
    live: null,
    runStatus: 'running',
    progress: {
      nodes: { n_plan: { attemptId: 1, status: 'passed', endSeq: 2, invalidated: true } },
      invalidatedNodes: ['n_plan'],
    },
  })
  assert.equal(recovered.n_plan.state, 'passed', '重跑通过后旧失效必须让位')
  assert.equal(recovered.n_plan.invalidated, false)
})

check('m3：中止 run 的在飞节点显示「已中止（无结论）」，不是「未开始」', () => {
  const states = deriveNodeStates({
    nodes: [{ id: 'n_dev' }, { id: 'n_fresh' }],
    events: [{ kind: 'node/start', nodeId: 'n_dev', attemptId: 1, seq: 2 }],
    live: null,
    runStatus: 'aborted',
    progress: { nodes: { n_dev: { attemptId: 1, status: 'pending' } } },
  })
  assert.equal(states.n_dev.state, 'aborted')
  assert.equal(states.n_dev.label, '已中止（无结论）')
  assert.equal(states.n_dev.glyph, '⊘')
  assert.equal(states.n_fresh.state, 'idle', '完全没触及的节点才是未开始')
})

check('m8：源节点「已判打回」、↺n 只给被打回的目标节点', () => {
  const classes = {
    n_plan: { state: 'rejected', label: '被打回', glyph: '↺', tone: 'warn', reworkCount: 0, invalidated: false, rejectRole: 'target' },
    n_test: { state: 'rejected', label: '被打回', glyph: '↺', tone: 'warn', reworkCount: 2, invalidated: false, rejectRole: 'source' },
  }
  const states = deriveNodeStates({
    nodes: [{ id: 'n_plan' }, { id: 'n_test' }],
    events: [
      { kind: 'node/end', nodeId: 'n_plan', attemptId: 1, seq: 1, data: { status: 'passed' } },
      { kind: 'node/end', nodeId: 'n_test', attemptId: 1, seq: 2, data: { status: 'rejected' } },
      { kind: 'reject/trigger', nodeId: 'n_test', attemptId: 1, seq: 3, data: { fromNodeId: 'n_test', toNodeId: 'n_plan' } },
    ],
    live: null,
    runStatus: 'running',
  })
  assert.equal(states.n_test.rejectRole, 'source')
  assert.equal(states.n_test.reworkCount, 0, '源节点不显示 ↺n')
  assert.equal(states.n_plan.rejectRole, 'target')

  const html = render(React.createElement(FlowCanvas, {
    flow,
    selection: null,
    nodeStates: { ...classes, n_test: { ...classes.n_test }, n_plan: { ...classes.n_plan, reworkCount: 2 } },
    onSelect() {},
    onMoveNode() {},
    onAddEdge() {},
    onAddNodeAt() {},
  }))
  assert.ok(html.includes('↺ 已判打回'), '源节点角标必须写「已判打回」')
  assert.ok(html.includes('↺2 被打回'), '目标节点显示 ↺n 返工数')
})

check('M1：运行中锁结构 —— 画布 / 检查器都禁用并给出原因，不是静默失效', () => {
  const html = render(React.createElement(FlowCanvas, {
    flow,
    selection: { kind: 'node', id: 'n_req' },
    locked: true,
    lockReason: RUN_LOCK_REASON,
    onSelect() {},
    onMoveNode() {},
    onAddEdge() {},
    onAddNodeAt() {},
  }))
  assert.ok(html.includes('fs-canvas locked'), '画布要进入锁定态')
  assert.ok(html.includes(RUN_LOCK_REASON), '锁定原因必须可见')
  assert.ok(html.includes('aria-disabled="true"'), '节点要标 aria-disabled')
  assert.ok(html.includes('运行中已锁定结构'), '画布上的原因文案不能省')

  const panel = render(React.createElement(Inspector, {
    flow,
    selection: { kind: 'node', id: 'n_req' },
    skills: [],
    locked: true,
    lockReason: RUN_LOCK_REASON,
    onPatchNode() {},
    onPatchEdge() {},
    onDeleteNode() {},
    onDeleteEdge() {},
    onAddMember() {},
    onPatchMember() {},
    onRemoveMember() {},
  }))
  assert.ok(panel.includes('运行中已锁定'), '检查器头部要标锁定')
  assert.ok(panel.includes(RUN_LOCK_REASON), '检查器要写明原因')
  assert.ok(panel.includes('disabled'), '检查器表单必须是 disabled fieldset')
})

check('M3：far 档保留纯形状角标（✓ / ↺ / ✕ / 双环），不依赖颜色', () => {
  const states = {
    n_req: { state: 'running', label: '运行中', glyph: '◉', tone: 'business', reworkCount: 0, invalidated: false },
    n_plan: { state: 'passed', label: '已通过', glyph: '✓', tone: 'success', reworkCount: 0, invalidated: false },
    n_shape: { state: 'rejected', label: '被打回', glyph: '↺', tone: 'warn', reworkCount: 0, invalidated: false },
    n_dev: { state: 'failed', label: '失败', glyph: '✕', tone: 'error', reworkCount: 0, invalidated: false },
  }
  const html = render(React.createElement(FlowCanvas, {
    flow,
    selection: null,
    nodeStates: states,
    onSelect() {},
    onMoveNode() {},
    onAddEdge() {},
    onAddNodeAt() {},
  }))
  for (const glyph of ['◎', '✓', '↺', '✕']) {
    assert.ok(html.includes(glyph), '缺少纯形状角标「' + glyph + '」')
  }
  assert.ok(html.includes('fs-state-mark'), '缺少 far 档形状角标元素')
  assert.ok(CSS.includes('[data-lod="far"] .fs-node.has-state .fs-state-mark'),
    'far 档 CSS 必须让形状角标可见，不能只有颜色')
  assert.ok(CSS.includes('border:2px double'), '运行中用双环形状，不依赖颜色')
})

check('m9：成员圆点文字用 label-primary，不叠低对比前景', () => {
  const teamFlow = model.defaultFlow()
  teamFlow.id = 'flow-team'
  const stage = teamFlow.nodes.find(node => node.id === 'n_req')
  stage.mode = 'team'
  stage.team = [
    { name: '甲', role: '', task: '' },
    { name: '乙', role: '', task: '' },
    { name: '丙', role: '', task: '' },
  ]
  const html = render(React.createElement(FlowCanvas, {
    flow: teamFlow,
    selection: null,
    onSelect() {},
    onMoveNode() {},
    onAddEdge() {},
    onAddNodeAt() {},
  }))
  assert.ok(html.includes('fs-member lead'))
  assert.ok(html.includes('color:var(--dsw-alias-label-primary)'), '成员圆点文字必须是 label-primary')
  assert.ok(!/class="fs-member"[^>]*label-primary-foreground/.test(html),
    '成员圆点不再叠低对比前景')
})

check('SSR 回退：静态画布带 data-* / aria / 连线列表，不是空 div', () => {
  const states = {
    n_req: { state: 'passed', label: '已通过', glyph: '✓', tone: 'success', reworkCount: 0, invalidated: false },
  }
  const html = render(React.createElement(FlowCanvas, {
    flow,
    selection: { kind: 'node', id: 'n_req' },
    nodeStates: states,
    onSelect() {},
    onMoveNode() {},
    onAddEdge() {},
    onAddNodeAt() {},
    eventWindowNote: '基于最近 3 条',
  }))
  assert.ok(html.includes('data-canvas-mode="static"'), '没有标记静态回退')
  assert.ok(html.includes('data-node-id="n_req"'), '节点缺少稳定 data-node-id')
  assert.ok(html.includes('data-state="passed"'), '节点缺少 data-state')
  assert.ok(html.includes('data-selected="true"'), '选中态没写进 data-*')
  assert.ok(html.includes('role="region"'), '画布容器缺少可读 role')
  assert.ok(html.includes('流程画布：8 个节点，11 条连线'), '画布 aria 没有规模摘要')
  assert.ok(html.includes('完整视图'), '画布 aria / HUD 缺少 LOD 文案')
  assert.ok(html.includes('class="fs-sr-only fs-edge-list"'), '缺少可读连线列表')
  assert.ok(html.includes('需求分析 → 方案设计，正常流转'), '连线列表没有端点与类型')
  assert.ok(html.includes('data-edge-kind="reject"'), '连线列表没有打回类型')
  assert.ok(html.includes('基于最近 3 条'), '事件窗口提示没渲染')
  assert.ok(!html.includes('react-flow__'), 'SSR 不应输出依赖 DOM 度量的 React Flow 结构')

  const empty = render(React.createElement(FlowCanvas, {
    flow: { ...flow, nodes: [], edges: [] },
    selection: null,
    onSelect() {},
    onMoveNode() {},
    onAddEdge() {},
    onAddNodeAt() {},
  }))
  assert.ok(empty.includes('画布还是空的：双击空白处新增第一个节点'), '空态提示丢了')
})

check('LOD 三档：阈值、文案与 CSS 挂钩', () => {
  assert.equal(lodOf(0.449), 'far')
  assert.equal(lodOf(0.45), 'mid')
  assert.equal(lodOf(0.599), 'mid')
  assert.equal(lodOf(0.6), 'near')
  assert.equal(lodText('near'), '完整视图')
  assert.equal(lodText('mid'), '紧凑视图')
  assert.equal(lodText('far'), '精简视图')
  assert.ok(CSS.includes('[data-lod="mid"] .fs-node-summary'), '紧凑档没有降低细节')
  assert.ok(CSS.includes('[data-lod="far"] .fs-node.has-state .fs-state-mark'),
    '最简档必须只留形状角标')
  assert.ok(CSS.includes('prefers-reduced-motion'), '动画没有尊重减少动效偏好')
})

check('运行中锁结构：画布开关与回调层都被挡住（不是只灰 UI）', () => {
  const lockedState = interactionState(true)
  assert.equal(lockedState.nodesDraggable, false)
  assert.equal(lockedState.nodesConnectable, false)
  assert.equal(lockedState.edgesFocusable, false)
  assert.equal(lockedState.doubleClickAdds, false)
  const openState = interactionState(false)
  assert.equal(openState.nodesDraggable, true)
  assert.equal(openState.doubleClickAdds, true)

  let affected = 0
  const blocked = guardStructureEdit(true, () => { affected += 1 })
  blocked()
  assert.equal(affected, 0, '锁定态回调必须不落库')
  let received = null
  guardStructureEdit(false, (a, b) => { received = [a, b] })('from', 'to')
  assert.deepEqual(received, ['from', 'to'], '解锁态要原样转发参数')
  assert.equal(guardStructureEdit(false, () => { affected += 1 })(), undefined)
  assert.equal(affected, 1)
})

check('节点 / 边可读名、状态形状与活动边', () => {
  const req = flow.nodes.find(node => node.id === 'n_req')
  assert.equal(
    nodeAriaLabel({ ...req, mode: 'single', team: [] }, {
      state: 'passed', label: '已通过', attempt: 2, reworkCount: 0, invalidated: false,
    }),
    '节点 需求分析，单 agent，当前已通过，attempt 2',
  )
  assert.equal(
    nodeAriaLabel({ ...req, mode: 'team', team: [{ name: '甲' }, { name: '乙' }, { name: '丙' }] }, {
      state: 'rejected', label: '被打回', reworkCount: 2, invalidated: true,
    }),
    '节点 需求分析，主管 + 3 名成员，当前被打回，返工 2 次，旧通过已失效',
  )
  assert.equal(stateShape('running'), '◎')
  assert.equal(stateShape('passed'), '✓')
  assert.equal(stateShape('rejected'), '↺')
  assert.equal(stateShape('failed'), '✕')
  assert.equal(stateShape('skipped'), '⊘')
  assert.equal(stateShape('aborted'), '⊘')
  assert.equal(stateShape('idle'), '')

  const byId = new Map(flow.nodes.map(node => [node.id, node]))
  const reject = flow.edges.find(edge => edge.kind === 'reject')
  assert.ok(edgeAriaLabel(reject, byId, { [reject.to]: { reworkCount: 2 } }).includes('已打回 2 次'))
  assert.ok(edgeListText(reject, byId).includes('，打回'))
  assert.equal(isEdgeActive(reject, { [reject.from]: { current: true } }), true)
  assert.equal(isEdgeActive(reject, { [reject.from]: { current: false } }), false)
  assert.equal(isEdgeActive(reject, null), false)
})

check('拖线端点规则：结束节点没有出边、开始节点不接受入边、禁止自环', () => {
  assert.equal(canConnectNodes(flow, 'n_start', 'n_req'), true)
  assert.equal(canConnectNodes(flow, 'n_req', 'n_end'), true)
  assert.equal(canConnectNodes(flow, 'n_end', 'n_req'), false, '结束节点不能当源')
  assert.equal(canConnectNodes(flow, 'n_req', 'n_start'), false, '开始节点不能当目标')
  assert.equal(canConnectNodes(flow, 'n_req', 'n_req'), false, '禁止自环')
  assert.equal(canConnectNodes(flow, 'n_missing', 'n_req'), false)
  assert.equal(canConnectNodes({ nodes: [] }, 'a', 'b'), false)
})

check('打回线仍走 6 槽位航道：端点 = 节点底缘 + 槽位，标签在水平段 24%', () => {
  const view = { x: 0, y: 220, z: 1 }
  const fromRect = { x: 300, y: 0, w: 208, h: 96 }
  const toRect = { x: 560, y: 0, w: 208, h: 116 }
  const path = rejectPathRects(fromRect, toRect, 240, 24, -72)
  assert.equal(path.from.x, 300 + 104 + 24, '出端口应落在节点底缘 + 出槽位')
  assert.equal(path.from.y, 96, '出端口在源节点底缘')
  assert.equal(path.to.x, 560 + 104 - 72, '入槽位应落在节点底缘 + 入槽位')
  assert.equal(path.to.y, 116, '入端口在目标节点底缘（主从节点更高）')
  assert.equal(path.laneY, 240)
  assert.ok(path.d.includes('L 582 240'), '水平段应落在给定航道（目标端 - 折角半径）')
  assert.equal(path.label.y, 236)
  assert.equal(view.y, 220)
})

check('样式只用宿主主题变量：CSS 不含 hex，暗色走 body 选择器', () => {
  assert.ok(!/#[0-9a-f]{3,8}/i.test(CSS), 'styles.js 里出现了 hex 颜色')
  assert.ok(CSS.includes('body[data-ds-dark-theme]'), '暗色主题没有专门分支')
  assert.ok(CSS.includes('var(--dsw-alias-'), '颜色没有走宿主 token')
})

check('M5：轮询只拉 run + since 增量 + kind 过滤；失败退避 / 后台 15s', () => {
  assert.equal(pollDelay({ failures: 0 }), 2000)
  assert.equal(pollDelay({ failures: 1 }), 4000)
  assert.equal(pollDelay({ failures: 2 }), 8000)
  assert.equal(pollDelay({ failures: 3 }), 16000)
  assert.equal(pollDelay({ failures: 4 }), MAX_POLL_MS, '退避上限 30s')
  assert.equal(pollDelay({ failures: 9 }), 30000)
  assert.equal(backoffDelay(0), 2000)
  assert.equal(pollDelay({ failures: 0, hidden: true }), HIDDEN_POLL_MS, '后台标签页降到 15s')
  assert.equal(HIDDEN_POLL_MS, 15000)
  assert.equal(pollDelay({ failures: 0, base: 5000 }), 5000, '历史 run 展开态按 5s 档')

  const params = eventsSince(12)
  assert.equal(params.since, 12, '增量必须带 since=lastSeq')
  assert.deepEqual(params.kinds, WATCH_EVENT_KINDS.slice())
  assert.equal(eventsSince(null).since, undefined, '没有游标时走首次全量窗口')
  assert.equal(needsEventFetch(null, { lastEventSeq: 0 }), true, '首次必须拉事件')
  assert.equal(needsEventFetch(5, { lastEventSeq: 5 }), false, 'seq 没前进时只拉 GET /runs/<id>')
  assert.equal(needsEventFetch(5, { lastEventSeq: 6 }), true, '有新事件才拉增量')
  assert.equal(needsEventFetch(5, null), true, '没有 live 时保守拉一次')
  assert.ok(WATCH_EVENT_KINDS.includes('node/end') && WATCH_EVENT_KINDS.includes('reject/trigger'))
  assert.ok(!WATCH_EVENT_KINDS.includes('model/call') && !WATCH_EVENT_KINDS.includes('tool/call'),
    '增量只取状态推导需要的 kind，不搬全量事件')

  const merged = mergeEventWindows(
    [{ kind: 'node/start', nodeId: 'a', attemptId: 1, seq: 1 }],
    [{ kind: 'node/end', nodeId: 'a', attemptId: 1, seq: 2, data: { status: 'passed' } }],
    10,
  )
  assert.equal(merged.events.length, 2)
  assert.equal(merged.added, 1)
  assert.equal(latestSeq(merged.events), 2)
  const dedup = mergeEventWindows(
    [{ kind: 'node/end', nodeId: 'a', attemptId: 1, seq: 2, data: { status: 'failed' } }],
    [{ kind: 'node/end', nodeId: 'a', attemptId: 1, seq: 2, data: { status: 'passed' } }],
    10,
  )
  assert.equal(dedup.events.length, 1, '同一 eventKey 不重复计入')
  assert.equal(dedup.events[0].data.status, 'passed', '同键后到的事件覆盖旧值')
  assert.equal(eventWindowNote({ truncated: true, loadedCount: 1000 }), '基于最近 1000 条')
  assert.equal(eventWindowNote({ truncated: false, loadedCount: 10 }), '')
  assert.equal(EVENT_FETCH_LIMIT, 1000)
})

check('M2：顶栏 / 画布跟「当前流程最近活动 run」，与抽屉选中历史 run 解耦', () => {
  const activeRun = {
    id: 'run-live', flowId: 'flow-test', name: '正在跑', status: 'running', eventCount: 5,
    live: { currentNodeId: 'n_dev', attempt: 2, round: 3 },
  }
  const historical = { id: 'run-old', flowId: 'flow-test', name: '历史', status: 'done' }
  const snapshot = {
    run: historical,
    runs: [activeRun, historical],
    live: null,
    summary: null,
    events: [],
    detail: null,
    selectedRunId: 'run-old',
    activeRun,
    activeLive: { currentNodeId: 'n_dev', attempt: 2, round: 3 },
    activeSummary: { progress: { nodes: { n_req: { attemptId: 1, status: 'passed' } } } },
    activeEvents: [],
    activeEventsTruncated: false,
  }
  const activeView = activeRunViewOf(snapshot, flow)
  assert.equal(activeView.run.id, 'run-live', '活动 run 优先于抽屉选中的历史 run')
  assert.equal(activeView.run.status, 'running')
  const picked = pickWatchRun([historical, { id: 'run-live2', flowId: 'flow-test', status: 'running', eventCount: 3 }], 'flow-test')
  assert.equal(picked.id, 'run-live2', '列表里运行中的 run 优先于最近一条历史')
  assert.equal(activeRunViewOf(null, flow), null)

  const html = render(React.createElement(FlowStudioPage, {
    initialFlow: flow,
    initialSkills: [],
    initialRunView: snapshot,
    initialLogOpen: true,
  }))
  assert.ok(html.includes('当前节点 开发 · 第 3 轮 · attempt 2'), '顶栏必须显示活动 run 的当前节点')
  assert.match(html, /class="fs-btn primary run"[^>]*disabled/, '活动 run 在跑时开始按钮禁用')
  assert.ok(!/class="fs-btn danger run-stop"[^>]*disabled/.test(html),
    '停止按钮必须始终对准活动 run（历史 run 被选中也不能禁用）')
  assert.ok(html.includes('run-state-running'), '画布叠加层必须显示活动 run 的状态')
})

check('B2：校验不过不起引擎；本次新建的 run 启动失败要 DELETE 清掉', () => {
  const ok = runPreflight(model.defaultFlow())
  assert.equal(ok.ok, true)
  assert.equal(ok.target, null)
  const empty = model.defaultFlow()
  empty.nodes = []
  empty.edges = []
  const emptyResult = runPreflight(empty)
  assert.equal(emptyResult.ok, false, '空任务必须被门禁拦下')
  assert.ok(emptyResult.message.includes('已取消开始'))

  const broken = model.defaultFlow()
  broken.edges = broken.edges.filter(edge => edge.from !== 'n_start')
  const brokenResult = runPreflight(broken)
  assert.equal(brokenResult.ok, false, '断头路必须被门禁拦下')
  assert.ok(brokenResult.issues.errors.length > 0)
  assert.ok(brokenResult.target && brokenResult.target.kind === 'node', '第一条错误要能定位到节点')
  assert.equal(firstErrorTarget({ errors: [{ message: 'x' }] }), null)
  assert.deepEqual(firstErrorTarget({ errors: [{ message: 'x', edgeId: 'e1' }] }), { kind: 'edge', id: 'e1' })

  // v1.1 复核 MAJOR：画布编辑只把这些当 warning，但引擎会 400，客户端必须提前拦住。
  const cyclic = model.defaultFlow()
  cyclic.edges = cyclic.edges.filter(edge => !(edge.from === 'n_review' && edge.to === 'n_end'))
  cyclic.edges.push({ id: 'e_cyc', from: 'n_review', to: 'n_dev', kind: 'next', label: '' })
  const cyclicResult = runPreflight(cyclic)
  assert.equal(cyclicResult.ok, false, '走不到结束节点的循环必须被开跑门禁拦下')

  const forked = model.defaultFlow()
  forked.edges.push({ id: 'e_fork', from: 'n_req', to: 'n_end', kind: 'next', label: '' })
  const forkedResult = runPreflight(forked)
  assert.equal(forkedResult.ok, false, '多条正常流转出边必须被开跑门禁拦下')
  assert.ok(forkedResult.issues.errors.some(item => /恰好一条/.test(item.message)), JSON.stringify(forkedResult.issues.errors))

  const badReject = model.defaultFlow()
  badReject.edges.push({ id: 'e_bad', from: 'n_test', to: 'n_start', kind: 'reject', label: '' })
  const badRejectResult = runPreflight(badReject)
  assert.equal(badRejectResult.ok, false, '打回指向开始节点必须被拦下')

  // 只有 findNextCycle 才能抓到的一条：结束节点被改出一条 next 出边（成环），
  // 但所有阶段仍能到达结束节点 —— 不能靠「阶段到不了结束」兜过去。
  const endCycle = model.defaultFlow()
  endCycle.edges.push({ id: 'e_end_cycle', from: 'n_end', to: 'n_req', kind: 'next', label: '' })
  const endCycleResult = runPreflight(endCycle)
  assert.equal(endCycleResult.ok, false, '结束节点出边造成的环必须被拦下')
  assert.ok(endCycleResult.issues.errors.some(item => /成环/.test(item.message)),
    JSON.stringify(endCycleResult.issues.errors))

  const created = startFailurePlan('start', { status: 409, data: { error: '已有 run 正在运行' } }, { id: 'run-new' }, true)
  assert.equal(created.deleteRunId, 'run-new', '本次新建的 run 启动失败必须 DELETE')
  assert.ok(created.message.includes('已有 run 正在运行'))
  assert.equal(startFailurePlan('start', { status: 400 }, { id: 'run-old' }, false).deleteRunId, '',
    '复用的旧 pending run 启动失败不能删')
})

check('0.9.1 保存形状闸门：列表摘要 / 缺 nodes 的对象一律不发请求', () => {
  const flow = { ...model.defaultFlow(), id: 'flow-gate', version: 2 }

  const ok = flowSavePayload(flow)
  assert.equal(ok.ok, true, '完整流程必须放行')
  assert.ok(Array.isArray(ok.body.nodes) && ok.body.nodes.length > 0, '请求体要带 nodes')

  // 真事故：把「流程列表摘要」当流程保存 —— 摘要没有 nodes/edges，
  // PUT 是整份替换语义，发出去就把服务器上的流程写成空图。
  const summary = model.summarize(flow)
  assert.equal('nodes' in summary, false, '前提：摘要本来就没有 nodes')
  const rejected = flowSavePayload(summary)
  assert.equal(rejected.ok, false, '摘要必须被拦下，不许发请求')
  assert.ok(rejected.reason.includes('nodes'), '拦下时要说清缺什么，' + rejected.reason)

  // 用户真的删光节点仍然要能保存：空数组是合法的。
  assert.equal(flowSavePayload({ ...flow, nodes: [], edges: [] }).ok, true, '空图是合法状态')
  assert.equal(flowSavePayload(null).ok, false, 'null 不能当请求体')
  assert.equal(flowSavePayload({ id: 'flow-x', name: '只有名字' }).ok, false, '半成品对象必须拦下')
})

check('0.9.1 空图写入防线：服务器有节点 + 本次没删过节点 → 拒绝保存空图', () => {
  const filled = { ...model.defaultFlow(), id: 'flow-guard' }
  const emptied = { ...filled, nodes: [], edges: [] }

  // 真事故形态：打开时有 8 个节点，保存时却成了一张空图，而且用户什么都没删。
  const blocked = emptyGraphBlockReason(emptied, { nodes: 8, edited: false })
  assert.ok(blocked.includes('8 个节点'), '拦截原因要给出服务器上的节点数，' + blocked)
  assert.ok(blocked.includes('没有删过节点'), '拦截原因要说清是「没删过却变空」')

  // 反例一：用户真把节点删光了（结构编辑置位）→ 必须放行，不能把合法操作当事故。
  assert.equal(emptyGraphBlockReason(emptied, { nodes: 8, edited: true }), '', '用户删光节点后必须能保存')
  // 反例二：这份流程本来就是空的（新建的空模板）→ 放行。
  assert.equal(emptyGraphBlockReason(emptied, { nodes: 0, edited: false }), '', '本来就是空图时要能保存')
  // 反例三：图不空 → 与防线无关。
  assert.equal(emptyGraphBlockReason(model.defaultFlow(), { nodes: 8, edited: false }), '', '非空图不受影响')
  // 缺 guard（老调用方 / 首次保存）时不能误拦用户。
  assert.equal(emptyGraphBlockReason(emptied, null), '', '没有基线时按放行处理')
})

check('0.9.1 从服务器读回的 flow 统一走 applyServerFlow：空图防线基线只跟着服务器重算', () => {
  const source = readFileSync(join(repoRoot, 'src/client/page.js'), 'utf8')
  const slice = (startMarker, endMarker, who) => {
    const from = source.indexOf(startMarker)
    assert.ok(from >= 0, '源码里找不到 ' + who + ' 的起点：' + startMarker)
    const to = source.indexOf(endMarker, from + startMarker.length)
    assert.ok(to > from, '源码里找不到 ' + who + ' 的终点：' + endMarker)
    return source.slice(from, to)
  }
  // 这些路径都是「服务器读回来的 flow」：同 id 被别处清空后必须重算基线（改成 0），
  // 否则之后改流程名之类的非结构编辑会被 emptyGraphBlockReason 用旧基线误拦，
  // 而且文案里的「重新打开该流程即可恢复」并不成立（只有这里会重算）。
  const sites = {
    'boot effect': slice('const boot = async () => {', 'void boot()', 'boot effect'),
    openFlow: slice('const openFlow = useCallback(', '}, [applyServerFlow, flushBeforeLeave])', 'openFlow'),
    reloadServerFlow: slice('const reloadServerFlow = useCallback(', '}, [applyServerFlow, conflict])', 'reloadServerFlow'),
  }
  for (const [name, body] of Object.entries(sites)) {
    assert.ok(body.includes('applyServerFlow('), name + ' 没有走 applyServerFlow：同 id 重新载入后空图基线不会重算，'
      + '之后改流程名会被 emptyGraphBlockReason 误拦且「重新打开即可恢复」失效')
  }
  // 反向：草稿不是服务器的现状，恢复草稿不能重置基线（会放过真正的「图上东西丢了」）。
  const restore = slice('const restoreDraft = () => {', 'const discardDraft', 'restoreDraft')
  assert.ok(!restore.includes('applyServerFlow('), 'restoreDraft 必须用草稿 setFlow，不能重置服务器基线')
  // 纯函数语义对照：旧基线 8 + 空图 = 拦；服务器读回空图后基线 0 = 放行。
  const empty = { ...model.defaultFlow(), id: 'flow-guard', nodes: [], edges: [] }
  assert.ok(emptyGraphBlockReason(empty, { nodes: 8, edited: false }).includes('8 个节点'),
    '同 id 被整体换成空图、基线还是旧值时仍必须拦')
  assert.equal(emptyGraphBlockReason(empty, { nodes: 0, edited: false }), '',
    '从服务器读回空图后基线是 0，必须允许后续保存')
})

check('0.4.2 并发保存：请求体带 version、成功后回写新版本、force 才剥版本', () => {
  const flow = { ...model.defaultFlow(), id: 'flow-x', version: 3, updatedAt: '2026-11-06T10:00:00.000Z' }

  const body = saveBodyFor(flow)
  assert.equal(body.version, 3, '正常保存必须带当前版本，Host 才能检测冲突')
  assert.equal(body.id, 'flow-x')
  assert.notEqual(body, flow, '不能把内部对象直接当请求体传出去')

  const forced = saveBodyFor(flow, { force: true })
  assert.equal('version' in forced, false, '用户确认覆盖时才走无条件写入')

  // 关键回归：保存成功后不并版本 → 下一次保存永远 409。
  const saved = { ...flow, version: 4, updatedAt: '2026-11-06T11:00:00.000Z', name: '服务器上的名字' }
  const merged = mergeSavedFlow(flow, saved)
  assert.equal(merged.version, 4, '必须回写服务器给的新版本')
  assert.equal(merged.updatedAt, '2026-11-06T11:00:00.000Z')
  assert.equal(merged.name, flow.name, '只并版本/时间，不能覆盖保存期间用户新改的内容')

  // 换了一份流程（id 不同）时不能把版本并过去。
  const otherSaved = { ...saved, id: 'flow-y', version: 9 }
  assert.equal(mergeSavedFlow(flow, otherSaved).version, 3, 'id 不同时不许并版本')
  assert.equal(mergeSavedFlow(null, saved), null)
  assert.equal(mergeSavedFlow(flow, null), flow)
})

await checkAsync('0.9.1 保存队列：并发保存串行化，第二次带第一次回写的新版本（不再自发 409）', async () => {
  const calls = []
  let releaseFirst = () => {}
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const queue = createSaveQueue({
    save: async (snapshot, options) => {
      calls.push({ version: snapshot.version, name: snapshot.name, options })
      if (calls.length === 1) await firstGate
      return { flow: { id: snapshot.id, version: snapshot.version + 1, name: snapshot.name } }
    },
  })
  const stale = { id: 'flow-q', name: '第一次改', version: 1, nodes: [], edges: [] }
  const first = queue.save(stale)
  // 去抖窗内又改了：自动保存会拿**同一份旧 version** 再发一次，这就是假 409 的成因。
  const second = queue.save({ ...stale, name: '第二次改' })
  await Promise.resolve()
  assert.equal(calls.length, 1, '第一个 PUT 未完成前不允许发第二个，' + JSON.stringify(calls))
  assert.equal(queue.pending(), 2, '两个保存都要在队列里等着')
  releaseFirst()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].version, 1)
  assert.equal(calls[1].version, 2, '第二次必须带第一次响应回写的新版本，否则就是自发 409：' + JSON.stringify(calls))
  assert.equal(calls[1].name, '第二次改', '排队不能吞掉后一次的内容')
  assert.equal(firstResult.flow.version, 2)
  assert.equal(secondResult.flow.version, 3)
  assert.equal(queue.pending(), 0, '队列跑完必须清空，不能影响下一次保存')

  // 一次失败不能把整条链卡死：后续保存照常执行（真冲突仍然要能浮到界面上）。
  let attempts = 0
  const failing = createSaveQueue({
    save: async snapshot => {
      attempts += 1
      if (attempts === 1) throw new Error('409 Conflict')
      return { flow: { id: snapshot.id, version: 2 } }
    },
  })
  await assert.rejects(failing.save({ id: 'flow-r', version: 1 }), /409 Conflict/)
  const recovered = await failing.save({ id: 'flow-r', version: 1 })
  assert.equal(recovered.flow.version, 2, '前一次失败后，后续保存仍必须能发出')
  assert.equal(failing.pending(), 0)

  // 同源小 bug：保存期间又编辑过，成功后必须回到 dirty（自动保存的前置条件），
  // 停在 saving 会让 `saveState === 'dirty'` 永远不成立，自动保存永久停摆。
  assert.equal(saveStateAfterSuccess(3, 3), 'saved', '保存期间没再改：正常进入已保存')
  assert.equal(saveStateAfterSuccess(3, 4), 'dirty', '保存期间又改过：必须回到 dirty 让自动保存重新排上')
})

check('0.9.1 冲突按 flowId 隔离：覆盖只对冲突发生时的快照生效，切流程后拒绝', () => {
  const snapshot = { id: 'flow-x', name: 'X 的本地版本', version: 1, nodes: [], edges: [] }
  const conflict = { flowId: 'flow-x', snapshot, currentVersion: 2, updatedAt: '2026-11-07T10:00:00.000Z' }

  const same = conflictTarget(conflict, { ...snapshot, version: 1 })
  assert.equal(same.ok, true)
  assert.equal(same.flow, snapshot, '覆盖必须用冲突发生时的快照，而不是当前 flow')

  // 真事故形态：X 撞 409 → 切到 Y → 横幅还在 → 点「用我的版本覆盖」不能打到 Y 上。
  const other = conflictTarget(conflict, { id: 'flow-y', name: 'Y', version: 2, nodes: [], edges: [] })
  assert.equal(other.ok, false, '切到别的流程后必须拒绝覆盖')
  assert.ok(other.reason.includes('另一份流程'), '拒绝原因要说清是另一份流程：' + other.reason)
  assert.equal(other.flow, null, '拒绝时不能给出任何可写目标')

  // 当前没有打开流程同样拒绝。
  assert.equal(conflictTarget(conflict, null).ok, false)
  // 没有 conflict / 没有快照都拒绝（不能悄悄退回「当前 flow」）。
  assert.equal(conflictTarget(null, { id: 'flow-x' }).ok, false)
  assert.equal(conflictTarget({ flowId: 'flow-x' }, { id: 'flow-x' }).ok, false)
  // flowId 与快照 id 不一致（损坏的冲突态）也拒绝。
  assert.equal(conflictTarget({ flowId: 'flow-y', snapshot }, { id: 'flow-x' }).ok, false)
})

check('m6/m7：运行收口播报、错误 role=alert、首次列表未回前禁用运行', () => {
  assert.ok(runEndAnnouncement('running', { id: 'r', name: '流程 A', status: 'done' }, { quality: { state: 'pass', label: '优：首轮通过' } })
    .startsWith('运行已结束：流程 A'))
  assert.ok(runEndAnnouncement('running', { id: 'r', name: '流程 A', status: 'failed' }, null).startsWith('运行失败：'))
  assert.ok(runEndAnnouncement('running', { id: 'r', name: '流程 A', status: 'aborted' }, null).startsWith('运行已中止：'))
  assert.equal(runEndAnnouncement('done', { id: 'r', status: 'done' }, null), '', '不是 running → 收口的迁移不播报')
  assert.equal(runEndAnnouncement('running', { id: 'r', status: 'running' }, null), '')

  const withError = render(React.createElement(FlowStudioPage, {
    initialFlow: flow,
    initialSkills: [],
    initialError: '保存失败：磁盘只读',
  }))
  assert.ok(withError.includes('role="alert"'), 'm6：.fs-error 必须有 role=alert')
  assert.ok(withError.includes('保存失败：磁盘只读'))

  const notReady = render(React.createElement(FlowStudioPage, { initialFlow: flow, initialSkills: [] }))
  assert.match(notReady, /class="fs-btn primary run"[^>]*disabled/, 'm7：运行记录没回来前运行按钮禁用')
  assert.ok(notReady.includes('正在读取运行记录'), 'm7：禁用原因写进 title')
})

check('顶栏运行控制态：运行 / 运行中 / 停止 / 独立确认停止 / busy 禁用（06 §11 + M6/m7）', () => {
  const idle = runControlState({ id: 'r1', status: 'pending' }, { hasFlow: true })
  assert.equal(idle.running, false)
  assert.equal(idle.startLabel, '运行')
  assert.equal(idle.startDisabled, false)
  assert.equal(idle.stopDisabled, true)
  assert.equal(idle.stopLabel, '停止')

  const running = runControlState({ id: 'r1', status: 'running' }, { hasFlow: true })
  assert.equal(running.running, true)
  assert.equal(running.startLabel, '运行中')
  assert.equal(running.startDisabled, true, '运行中开始按钮必须禁用')
  assert.equal(running.stopDisabled, false)
  assert.equal(running.stopLabel, '停止')
  assert.equal(running.confirming, false)

  // M6：第一击只 arm；主按钮锁死，独立确认按钮出现且默认不可点（400ms 后才可用）。
  const confirming = runControlState({ id: 'r1', status: 'running' }, { hasFlow: true, armed: true })
  assert.equal(confirming.confirming, true)
  assert.equal(confirming.stopDisabled, true, '确认态下同一按钮必须锁死，防双击击穿')
  assert.equal(confirming.confirmLabel, '确认停止')
  assert.equal(confirming.confirmDisabled, true, '确认按钮在 400ms 前必须不可点')
  assert.equal(STOP_CONFIRM_DELAY_MS, 400, '确认按钮延迟不得低于 400ms')
  const ready = runControlState({ id: 'r1', status: 'running' }, { hasFlow: true, armed: true, confirmReady: true })
  assert.equal(ready.confirmDisabled, false, '400ms 后独立确认按钮应可用')
  assert.ok(ready.confirmTitle.includes('确认停止'))

  const busy = runControlState({ id: 'r1', status: 'running' }, { hasFlow: true, busy: true })
  assert.equal(busy.startDisabled, true)
  assert.equal(busy.stopDisabled, true, '请求在飞时不允许连点')
  assert.equal(busy.stopLabel, '停止中…')

  // m7：首次运行列表没回来前禁用「运行」并写 title。
  const notReady = runControlState(null, { hasFlow: true, listReady: false })
  assert.equal(notReady.startDisabled, true, '运行记录未就绪时必须禁用运行')
  assert.ok(notReady.startTitle.includes('正在读取运行记录'), '禁用原因要写进 title')

  const noFlow = runControlState(null, { hasFlow: false })
  assert.equal(noFlow.running, false)
  assert.equal(noFlow.startDisabled, true)
  assert.equal(noFlow.stopDisabled, true)

  // 有些 Host 建 run 时就写 status=running（还没有 live / 事件）；
  // 这种空壳 run 不能点亮「运行中」，也不该开放「停止」（stop 只会 409）。
  const shell = { id: 'r2', status: 'running', eventCount: 0, nodeDone: 0 }
  assert.equal(runIsPending(shell), true)
  assert.equal(runIsPending({ id: 'r2b', status: 'running', started: false }), true,
    'Host 持久化的 started=false 就是 pending')
  assert.equal(runIsPending({ id: 'r2c', status: 'running', started: true, eventCount: 0 }), false,
    'started=true 之后即使事件还没落盘也不算空壳')
  assert.equal(runIsActive(shell), false)
  assert.equal(conclusionOf(shell, null).text, '待运行', '空壳 run 的结论 pill 不能写「运行中」')
  const shellControl = runControlState(shell, { hasFlow: true })
  assert.equal(shellControl.running, false)
  assert.equal(shellControl.startDisabled, false)
  assert.equal(shellControl.stopDisabled, true)
  assert.equal(runIsActive({ id: 'r3', status: 'running', eventCount: 4 }), true)
})

check('顶栏停止：没打开流程但 runForFlow 在跑时也能停（流程被删后不能失去停止入口）', () => {
  // 流程被删光 / 首次进入且一条都没有：flow 为 null，但库里那条 run 还在跑。
  const orphan = { id: 'run-orphan', flowId: 'flow-deleted', status: 'running', started: true, eventCount: 2 }
  assert.equal(runIsActive(orphan), true, '前提：这是一条真正在跑的 run')
  const control = runControlState(orphan, { hasFlow: false })
  assert.equal(control.running, true)
  assert.equal(control.stopDisabled, false, '只要 runForFlow 在跑就必须允许停止（抽屉里没有第二个入口）')
  assert.equal(control.startDisabled, true, '没有流程时不允许开始')

  // 其余禁用条件不变。
  assert.equal(runControlState(null, { hasFlow: false }).stopDisabled, true, '没有 run 时不能停')
  assert.equal(runControlState({ id: 'r', status: 'done' }, { hasFlow: false }).stopDisabled, true)
  assert.equal(runControlState(orphan, { hasFlow: false, busy: true }).stopDisabled, true, '请求在飞时不能连点')
  assert.equal(runControlState(orphan, { hasFlow: false, armed: true }).stopDisabled, true, '确认态主按钮锁死')
  assert.equal(runControlState(orphan, { hasFlow: true }).stopDisabled, false, '有流程时行为不变')

  // SSR 也验一次：顶栏的停止按钮真的是可点的，而不是只有纯函数算对了。
  const html = render(React.createElement(FlowStudioPage, {
    initialSkills: [],
    initialRunView: {
      run: { id: 'run-orphan', flowId: 'flow-deleted', name: '已删掉的流程 · 实时', status: 'running', started: true, eventCount: 2 },
      runs: [{ id: 'run-orphan', flowId: 'flow-deleted', name: '已删掉的流程 · 实时', status: 'running' }],
      live: { currentNodeId: 'n_dev', attempt: 1, round: 1, phase: 'model' },
      events: [{ kind: 'node/start', nodeId: 'n_dev', attemptId: 1, seq: 1, data: {} }],
      summary: null,
      detail: null,
    },
  }))
  assert.ok(!/class="fs-btn danger run-stop"[^>]*disabled/.test(html),
    'SSR：没有打开流程时停止按钮也必须可用，否则那条 run 在 UI 上停不掉')
})

check('运行文案：当前节点 · 第 N 轮 · attempt M；live 缺失从事件回退', () => {
  assert.equal(LIVE_POLL_MS, 2000, '运行中必须按 06 §10 每 2s 轮询')
  assert.equal(
    runLiveLabel(
      { id: 'r', status: 'running' },
      { currentNodeId: 'n_dev', attempt: 2, round: 3, phase: 'model' },
      { nodes: flow.nodes },
    ),
    '当前节点 开发 · 第 3 轮 · attempt 2',
  )
  assert.equal(
    runLiveLabel({ id: 'r', status: 'done' }, { currentNodeId: 'n_dev', attempt: 2, round: 3 }, { nodes: flow.nodes }),
    '',
    '不在跑的时候不显示实时文案',
  )
  assert.equal(
    runLiveLabel(
      { id: 'r', status: 'running' },
      null,
      { nodes: flow.nodes, events: [{ kind: 'node/start', nodeId: 'n_test', attemptId: 2, seq: 1 }] },
    ),
    '当前节点 测试 · 第 1 轮 · attempt 2',
    '没有 live 时从最近 node/start 回退，round 用 node/start 条数',
  )
  assert.equal(
    runLiveLabel(
      { id: 'r', status: 'running' },
      { currentNodeId: null, attempt: 0, round: 0, phase: 'idle' },
      { nodes: flow.nodes },
    ),
    '运行中 · 等待首个节点',
    'start 202 后首个节点还没落盘时不能写「第 0 轮」',
  )
  // m4：等待首个节点要带 since 与 lastSeq，用户能区分「刚启动」与「卡死」。
  assert.equal(
    runLiveLabel(
      { id: 'r', status: 'running' },
      { currentNodeId: null, attempt: 0, round: 0, phase: 'idle', since: '2026-11-06T08:00:00Z', lastEventSeq: 3 },
      { nodes: flow.nodes },
    ),
    '运行中 · 等待首个节点（since 2026-11-06T08:00:00Z · lastSeq 3）',
    '等待首个节点必须带上 since 与 lastSeq',
  )
  assert.equal(runIsRunning({ status: 'RUNNING' }), true, '状态大小写不敏感')
  assert.equal(normalizeLive({}), null, '空 live 不伪造 currentNodeId')
  assert.equal(
    liveOf({ id: 'run-a' }, { run: { id: 'run-b', live: { currentNodeId: 'x' } } }),
    null,
    '详情与选中 run 不一致时不能借用它的 live',
  )
  assert.equal(
    liveOf({ id: 'run-a' }, { run: { id: 'run-a', live: { currentNodeId: 'n_dev', attempt: 1 } } }).currentNodeId,
    'n_dev',
  )
})

check('画布节点运行态：business 环 + 形状/文字角标（不是只靠颜色）', () => {
  const states = {
    n_req: { state: 'running', label: '运行中', glyph: '◉', tone: 'business', reworkCount: 0, invalidated: false, current: true },
    n_plan: { state: 'passed', label: '已通过', glyph: '✓', tone: 'success', reworkCount: 1, invalidated: false },
    n_shape: { state: 'rejected', label: '被打回', glyph: '↺', tone: 'warn', reworkCount: 2, invalidated: true },
    n_dev: { state: 'failed', label: '失败', glyph: '✕', tone: 'error', reworkCount: 0, invalidated: false },
    n_test: { state: 'idle', label: '未开始', glyph: '○', tone: 'idle', reworkCount: 0, invalidated: false },
  }
  const html = render(React.createElement(FlowCanvas, {
    flow,
    selection: null,
    nodeStates: states,
    onSelect() {},
    onMoveNode() {},
    onAddEdge() {},
    onAddNodeAt() {},
  }))
  assert.ok(html.includes('run-state-running'), '运行中没有 business 环对应的类')
  assert.ok(html.includes('run-state-passed') && html.includes('run-state-rejected'))
  assert.ok(html.includes('run-state-failed') && html.includes('run-state-idle'))
  for (const needle of ['◉ 运行中', '✓ 已通过', '↺2 被打回', '✕ 失败', '○ 未开始']) {
    assert.ok(html.includes(needle), '节点卡缺少形状 + 文字角标「' + needle + '」')
  }
  assert.ok(html.includes('该节点返工 1 次（目标返工数）'), '独立 ↺n 角标缺少可读 tooltip')
  assert.ok(html.includes('该节点因收到打回重跑了 2 次'), '被打回角标的 tooltip 没写清返工次数')
  assert.ok(html.includes('aria-label="节点 需求分析，主管 + 3 名成员，当前运行中"'),
    '运行态与主从模式没进 aria-label')
})

check('页面运行中：顶栏实时节点 + 开始禁用/停止可用 + 抽屉自动展开', () => {
  const live = { currentNodeId: 'n_dev', attempt: 2, round: 3, phase: 'model' }
  const runningEvents = [
    { kind: 'node/start', nodeId: 'n_req', attemptId: 1, seq: 1, data: {} },
    { kind: 'node/end', nodeId: 'n_req', attemptId: 1, seq: 2, data: { status: 'passed' } },
    { kind: 'node/start', nodeId: 'n_dev', attemptId: 2, seq: 3, data: {} },
  ]
  const runningView = {
    run: {
      id: 'run-live', flowId: 'flow-test', flowName: '标准研发流水线',
      name: '标准研发流水线 · 实时', status: 'running', nodeDone: 1, nodeTotal: 6, tokenTotal: 1200, live,
    },
    runs: [{
      id: 'run-live', flowId: 'flow-test', name: '标准研发流水线 · 实时',
      status: 'running', nodeDone: 1, nodeTotal: 6, tokenTotal: 1200,
    }],
    live,
    events: runningEvents,
    summary: null,
    detail: null,
    selectedRunId: 'run-live',
  }
  const html = render(React.createElement(FlowStudioPage, {
    initialFlow: flow,
    initialSkills: [],
    initialRunView: runningView,
    initialLogOpen: true,
  }))
  assert.ok(html.includes('当前节点 开发 · 第 3 轮 · attempt 2'), '顶栏没有当前节点 / 轮次 / attempt')
  assert.match(html, /class="fs-btn primary run"[^>]*disabled/, '运行中开始按钮必须禁用')
  assert.ok(!/class="fs-btn danger run-stop"[^>]*disabled/.test(html), '运行中停止按钮必须可用')
  assert.ok(html.includes('运行中'), '节点卡没有运行中角标')
  assert.ok(html.includes('已通过'), '已通过节点没有状态角标')
  assert.ok(html.includes('class="fs-log open"'), '开始运行后抽屉应自动展开')
  assert.ok(html.includes('标准研发流水线 · 实时'), '抽屉没有切到该 run')
})

// 运行中锁结构（M1）：草稿是另一份图（节点数可能完全不同），恢复它会换掉运行中的图。
// 这里验 UI 层：锁定态下草稿横幅的「恢复」按钮必须 disabled（SSR 不跑 effect，
// 所以用 initialDraftNotice 预置横幅）。
check('运行中锁结构：草稿横幅的「恢复」按钮 disabled，未运行时可用', () => {
  const runningView = {
    run: {
      id: 'run-lock', flowId: 'flow-test', name: '锁定中的运行', status: 'running',
      started: true, eventCount: 3, nodeDone: 0, nodeTotal: 6,
    },
    runs: [{ id: 'run-lock', flowId: 'flow-test', name: '锁定中的运行', status: 'running' }],
    live: { currentNodeId: 'n_dev', attempt: 1, round: 1, phase: 'model' },
    events: [{ kind: 'node/start', nodeId: 'n_dev', attemptId: 1, seq: 1, data: {} }],
    summary: null,
    detail: null,
  }
  const draftRecord = {
    savedAt: '2026-11-07T10:00:00+08:00',
    flow: { ...flow, nodes: [flow.nodes[0]], edges: [] },
  }
  const buttonTagAt = html => {
    const restoreAt = html.indexOf('>恢复<')
    assert.ok(restoreAt > 0, '草稿横幅没渲染出「恢复」按钮')
    const start = html.lastIndexOf('<button', restoreAt)
    assert.ok(start > 0, '「恢复」不在 button 里')
    return html.slice(start, restoreAt)
  }

  const lockedHtml = render(React.createElement(FlowStudioPage, {
    initialFlow: flow,
    initialSkills: [],
    initialRunView: runningView,
    initialDraftNotice: { flowId: 'flow-test', record: draftRecord },
  }))
  const lockedTag = buttonTagAt(lockedHtml)
  assert.ok(lockedTag.includes('disabled'), '运行中必须禁用「恢复」按钮（否则草稿会换掉运行中的图）：' + lockedTag)
  assert.ok(lockedTag.includes('运行中已锁定结构'), '禁用原因要写进 title：' + lockedTag)

  const idleHtml = render(React.createElement(FlowStudioPage, {
    initialFlow: flow,
    initialSkills: [],
    initialDraftNotice: { flowId: 'flow-test', record: draftRecord },
  }))
  const idleTag = buttonTagAt(idleHtml)
  assert.ok(!idleTag.includes('disabled'), '没在运行时「恢复」必须可用：' + idleTag)
  assert.ok(idleTag.includes('本地草稿'), '可用状态的 title 要说明恢复的含义：' + idleTag)
})

// 回归（0.9.1 实证缺陷）：库里还有 run、但当前没有打开任何流程（流程被删光 /
// 首次进入且一条都没有）时，`activeRunViewOf` 会把空 flowId 当通配匹配到任意 run，
// 随后 `{ nodes: flow.nodes }` 在 flow 为 null 时抛
// `Cannot read properties of null (reading 'nodes')`，整个面板被判成崩溃、画布空白。
check('没有打开流程但库里有 run：顶栏退回 nodeId，不因 flow 为 null 崩（回归 0.9.1）', () => {
  const live = { currentNodeId: 'n_dev', attempt: 2, round: 3, phase: 'model' }
  const orphanView = {
    run: {
      id: 'run-orphan', flowId: 'flow-deleted', flowName: '已删掉的流程',
      name: '已删掉的流程 · 实时', status: 'running', nodeDone: 1, nodeTotal: 6, tokenTotal: 1200, live,
    },
    runs: [{
      id: 'run-orphan', flowId: 'flow-deleted', name: '已删掉的流程 · 实时',
      status: 'running', nodeDone: 1, nodeTotal: 6, tokenTotal: 1200,
    }],
    live,
    events: [{ kind: 'node/start', nodeId: 'n_dev', attemptId: 2, seq: 1, data: {} }],
    summary: null,
    detail: null,
  }
  const html = render(React.createElement(FlowStudioPage, { initialSkills: [], initialRunView: orphanView }))
  assert.ok(html.includes('当前节点 n_dev'), '拿不到节点标题时要退回显示 nodeId，不能崩也不能写「—」')
  assert.ok(html.includes('第 3 轮'), '没有流程时轮次仍要照常显示')
  assert.ok(html.includes('class="fs-empty-card"'), '没有流程时画布要给「还没有流程模板」空态，而不是白屏')
})

check('409 是业务态不是故障：已有 run 在跑 / 不在跑都给可读提示（06 §10）', () => {
  const startConflict = runActionFailureText('start', 409, { error: '已有 run 正在运行' })
  assert.ok(startConflict.includes('已有 run 正在运行'), '409 start 必须说清「已有 run 在运行」')
  assert.ok(startConflict.includes('先停止它'), '409 start 要给出下一步')
  const stopConflict = runActionFailureText('stop', 409, { error: 'run 不在运行中' })
  assert.ok(stopConflict.includes('不在运行中'), '409 stop 必须说清「已经不在跑」')
  const alreadyStarted = runActionFailureText('start', 409, { error: 'run 已开始过，v0.4 不支持断点续跑' })
  assert.ok(!alreadyStarted.includes('先停止它'), '「已开始过」的 409 不能误导用户去停止别的 run')
  assert.ok(alreadyStarted.includes('请新建一个 run'), '「已开始过」的 409 要给出正确下一步')
  assert.ok(runActionFailureText('start', 405, {}).includes('Host 还没有提供'), 'Host 未实现时要说清而不是甩 HTTP 码')
  assert.ok(runActionFailureText('start', 404, {}).includes('run 不存在'))
  assert.equal(runActionFailureText('stop', 401, {}), '需要访问令牌：用 ?fs_token=… 打开一次')
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
  findings: { total: 2, unresolved: 1, bySeverity: { P0: 1, P1: 1 }, byStatus: { open: 1, verified: 1 }, unresolvedBySeverity: { P0: 0, P1: 1, P2: 1 } },
  // Host 会补的验收口径（M4）；缺失时 UI 必须显示「验收 —」。
  acceptance: { passed: 7, total: 9, rate: 7 / 9 },
  progress: { passed: 5, total: 6, ratio: 5 / 6, invalidatedNodes: [], nodes: { n_req: { attemptId: 1, status: 'passed' } } },
  skillUsage: { declaredCount: 3, loadedCount: 2, coverage: 2 / 3, loads: { total: 4, ok: 4, failed: 0 } },
  quality: {
    state: 'pass', label: '良：返工 1 轮后达标',
    reworkRounds: 1, acceptedRate: 0.78, p0Unresolved: 0, p1Unresolved: 1,
  },
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

check('抽屉运行中：live.currentNodeId 对应事件行高亮，状态点走 business（06 §11）', () => {
  const liveRun = {
    ...logRun,
    status: 'running',
    endedAt: '',
    live: { currentNodeId: 'n_req', attempt: 1, round: 2, phase: 'model' },
  }
  const html = render(React.createElement(FsLogDrawer, {
    open: true,
    onToggle() {},
    initialRuns: [liveRun],
    initialRunId: liveRun.id,
    initialEvents: logEvents,
  }))
  assert.ok(html.includes('fs-log-event current'), '当前节点的事件行没有高亮类')
  assert.ok(html.includes('data-current-node="true"'), '当前节点事件行缺少 data 标记')
  assert.ok(html.includes('当前节点 · 需求分析 开始'), '高亮行没有「当前节点」可读前缀')
  assert.ok(html.includes('fs-log-current-badge') && html.includes('>当前<'),
    'm10：当前节点事件行必须有「当前」文字徽标，不能只靠颜色竖条')
  assert.ok(html.includes('fs-log-dot business'), '运行中状态点应为 business 档')
})

check('抽屉收起态（M4）：状态点 · 验收通过率主值 · 结论 pill；token 明细不回流 40px', () => {
  const html = render(React.createElement(FsLogDrawer, {
    open: false,
    onToggle() {},
    initialRuns: [logRun],
    initialRunId: logRun.id,
    initialSummary: logSummary,
  }))
  assert.ok(html.includes('标准研发流水线 · 第一次'), '收起条没显示 run 名')
  assert.ok(html.includes('fs-log-dot success'), '状态点与结论 pill 同源（quality=pass → success）')
  assert.ok(html.includes('验收 7/9 · 78%'), '40px 主值必须是验收条目通过率')
  assert.ok(html.includes('良：返工 1 轮后达标'), '结论 pill 没显示 summary.quality.label')
  assert.ok(!html.includes('四段合计'), '四段 token 明细必须下沉到展开态，不能回流 40px 条')
  assert.ok(!html.includes('入 8k · 缓存读 40k'), '收起条不再显示 token 四段明细')
  assert.ok(html.includes('aria-expanded="false"'), '收起态缺少 aria-expanded')
  assert.ok(!html.includes('事件详情'), '收起态不该渲染三栏明细')

  // 缺失 acceptance 字段：主值必须如实写「验收 —」，不许编数。
  const missing = render(React.createElement(FsLogDrawer, {
    open: false,
    onToggle() {},
    initialRuns: [logRun],
    initialRunId: logRun.id,
    initialSummary: { quality: { state: 'pass', label: '优：首轮通过' } },
  }))
  assert.ok(missing.includes('验收 —'), 'acceptance 缺失时必须显示「验收 —」')
  assert.ok(!missing.includes('验收 0/0'), '缺失不能落成 0/0')
  assert.equal(acceptanceOf(null).text, '验收 —')
  assert.equal(acceptanceOf({ acceptance: { passed: 0, total: 0 } }).text, '验收 —')
  assert.equal(acceptanceOf({ acceptance: { passed: 7, total: 9, rate: 0.777 } }).text, '验收 7/9 · 78%')
})

check('抽屉展开态（M4）：验收 / 总耗时 / P0 / 采纳率 / skill 覆盖率 / 返工轮次 + token 四段', () => {
  const html = render(React.createElement(FsLogDrawer, {
    open: true,
    onToggle() {},
    initialRuns: [logRun],
    initialRunId: logRun.id,
    initialSummary: logSummary,
    initialDetail: { run: logRun, nodes: [{ nodeId: 'n_req', eventCount: 3, attempts: [{ attemptId: 1, eventCount: 3 }] }], eventCount: 4 },
    initialEvents: logEvents,
  }))
  for (const needle of [
    '验收通过率', '总耗时', '总 token', 'P0 未解决', '审查采纳率', 'skill 覆盖率', '返工轮次',
    '12:00', '78%', '2/3', '1 轮',
  ]) {
    assert.ok(html.includes(needle), '展开态缺少指标「' + needle + '」')
  }
  assert.ok(html.includes('入 8k · 缓存读 40k · 缓存写 0 · 出 2k'), 'token 四段明细应出现在展开态')
  assert.equal(formatDuration(42300), '42.3s')
  assert.equal(formatDuration(720000), '12:00')
  assert.equal(formatDuration(null), '')
  assert.equal(runDurationMs(logRun), 720000)
  assert.equal(runDurationMs({ id: 'x' }), null)
  const metrics = runMetrics(logRun, logSummary)
  assert.equal(metrics.durationText, '12:00')
  assert.equal(metrics.p0, '0')
  assert.equal(metrics.acceptedRateText, '78%')
  assert.equal(metrics.skillText, '2/3')
  assert.equal(metrics.reworkText, '1 轮')
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

check('done + 无 summary：结论 pill 与状态点同源中性，不冒充绿色（审核 M8 + m2）', () => {
  const html = render(React.createElement(FsLogDrawer, {
    open: false,
    onToggle() {},
    initialRuns: [logRun],
    initialRunId: logRun.id,
  }))
  assert.ok(html.includes('fs-log-pill neutral'), '没有 quality 证据时 pill 必须是中性档')
  assert.ok(html.includes('fs-log-dot neutral'), '状态点必须与 pill 同源（中性），不能按 run 状态单独上色')
  assert.ok(html.includes('完成 · 质量未检测'), '中性 pill 要写清「质量未检测」')
  assert.ok(html.includes('验收 —'), '没有 acceptance 证据时主值显示「验收 —」')
  assert.ok(!html.includes('fs-log-pill success'), '没有 summary 时绝不能出现绿 pill')
  assert.equal(conclusionOf(logRun, null).tone, 'neutral')
  assert.equal(conclusionOf(logRun, { quality: { state: 'pass' } }).tone, 'success')
})

check('06 §13.8 桩数据 badge：summary.engine=stub 时抽屉必须标「桩数据，不是真实证据」', () => {
  const stubSummary = {
    ...logSummary,
    engine: 'stub',
    quality: { state: 'unknown', label: '桩：良：返工 1 轮后达标', stub: true },
  }
  assert.equal(stubBadgeOf(stubSummary), '桩数据，不是真实证据')
  assert.equal(stubBadgeOf({ ...stubSummary, engine: 'real', quality: { state: 'pass' } }), '')
  assert.equal(stubBadgeOf(null), '')
  const html = render(React.createElement(FsLogDrawer, {
    open: false,
    onToggle() {},
    initialRuns: [logRun],
    initialRunId: logRun.id,
    initialSummary: stubSummary,
  }))
  assert.ok(html.includes('桩数据，不是真实证据'), '桩 run 的 40px 收起条必须带 badge')
  assert.ok(html.includes('fs-log-pill stub'), 'badge 要有自己的样式档（不是用 warning pill 冒充）')
})

check('§8.1/§13.10 partial 成员结论显示为「无结论」，不是通过也不是失败', () => {
  assert.equal(statusText('partial'), '无结论')
  const summaryText = eventSummary({
    kind: 'member/end',
    memberId: 'n_dev:1',
    data: { status: 'partial', durationMs: 1200 },
  })
  assert.ok(summaryText.includes('无结论'), summaryText)
  assert.ok(!/失败|通过/.test(summaryText), summaryText)
})

check('结论 pill 按 04 §3.9.3 映射：warn 是「可」不是「需返工」；fail 走黄（m1/m6）', () => {
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
  assert.equal(fail.tone, 'warn', 'm1：quality=fail 用 warn 黄，红只留给运行失败')
  assert.ok(fail.text.includes('需返工'))
  const unknown = conclusionOf(logRun, { quality: { state: 'unknown', label: '证据不足：测试未检测' } })
  assert.equal(unknown.tone, 'warn', 'Host 明确判 unknown 时按 04 走黄（证据不足），不是绿')
  const failed = conclusionOf({ ...logRun, status: 'failed' }, { quality: { state: 'pass' } })
  assert.equal(failed.tone, 'error', '运行失败优先于质量结论，并且是唯一红档')
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

check('M5：事件请求把 kinds 展开成重复 kind、并带 since 游标', () => {
  const url = readEventsPath('run-1', {
    since: 5, kinds: ['node/start', 'node/end'], limit: 500, order: 'asc',
  })
  assert.ok(url.startsWith('/runs/run-1/events?'), '事件路径不对：' + url)
  assert.equal((url.match(/[?&]kind=/g) || []).length, 2, 'kinds 必须按重复 key 发送')
  assert.ok(url.includes('kind=node%2Fstart') && url.includes('kind=node%2Fend'))
  assert.ok(url.includes('since=5'), '增量必须带 since=lastSeq')
  assert.ok(url.includes('order=asc') && url.includes('limit=500'))
  assert.ok(!url.includes('kind=node%2Fstart%2Cnode%2Fend'), '不能把 kinds 拼成逗号单值')
  assert.equal(readEventsPath('r', {}), '/runs/r/events?limit=200&order=desc')
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

// ── G5：轮询成本 / 删除安全 / 降级状态 / 共享数据源 / Alt 绕过吸附 ────────
console.log('G5（client）')

check('G5-a：light=1 路径与完整详情路径分开；抽屉打开用完整详情', () => {
  assert.equal(readRunPath('run-1', { light: true }), '/runs/run-1?light=1', '2s 轮询必须带 light=1')
  assert.equal(readRunPath('run-1'), '/runs/run-1', '默认仍是完整详情接口')
  assert.equal(readRunPath('run-1', { light: false }), '/runs/run-1', '打开抽屉时显式走完整详情')
  assert.equal(readRunPath('run/a', { light: true }), '/runs/run%2Fa?light=1', 'runId 仍需编码')
})

await checkAsync('G5-a：light=1 撞 400/404 只降级一次并提示一次；网络错误不误降级', async () => {
  for (const status of [400, 404]) {
    let lightCalls = 0
    let fullCalls = 0
    const warnings = []
    const reader = createLightRunReader({
      readRun: async (id, options) => {
        if (options && options.light) {
          lightCalls += 1
          const error = new Error('light unsupported')
          error.status = status
          throw error
        }
        fullCalls += 1
        return { run: { id } }
      },
      warn: message => warnings.push(message),
    })
    const first = await reader.read('run-1')
    const second = await reader.read('run-1')
    assert.equal(first.light, false, '降级那一次用的是完整接口')
    assert.equal(second.light, false)
    assert.equal(first.data.run.id, 'run-1')
    assert.equal(lightCalls, 1, `HTTP ${status} 之后不能再每轮重试 light=1`)
    assert.equal(fullCalls, 2, '降级后的每一轮都直接走完整接口')
    assert.equal(warnings.length, 1, '只警告一次，不能静默也不能刷屏')
    assert.equal(warnings[0], LIGHT_POLL_FALLBACK_NOTICE)
    assert.equal(reader.lightSupported, false)
    assert.equal(reader.warned, true)
  }

  // 网络错误 / 5xx 不是能力问题：照常抛给轮询退避，不永久降级。
  let calls = 0
  const flaky = createLightRunReader({
    readRun: async () => {
      calls += 1
      throw new Error('offline')
    },
  })
  await assert.rejects(() => flaky.read('run-1'), /offline/)
  assert.equal(flaky.lightSupported, true, '网络错误不能误判为 Host 不支持 light=1')
  assert.equal(calls, 1)

  // 真实请求 URL：抽屉里的完整详情不带 light，只有后台轮询带 light=1。
  const urls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async url => {
    urls.push(String(url))
    return { ok: true, status: 200, json: async () => ({ ok: true, run: { id: 'run-1' } }) }
  }
  try {
    await api.readRun('run-1', { light: false })
    await api.readRun('run-1', { light: true })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(urls[0], '/api/flow-studio/runs/run-1', '打开抽屉必须走完整详情（无 light）')
  assert.equal(urls[1], '/api/flow-studio/runs/run-1?light=1', '轮询请求必须带 light=1')
})

check('G5-b：删除有二次确认文案（流程名 / 撤销 / 草稿清理时机）', () => {
  const text = deleteConfirmText('标准研发流水线')
  assert.ok(text.includes('标准研发流水线'), '确认文案必须带流程名')
  assert.ok(text.includes('撤销'), '确认文案必须说明删除后可撤销')
  assert.ok(text.includes('服务器删除成功'), '确认文案必须说明草稿何时清理')
  assert.ok(deleteConfirmText('').includes('未命名流程'), '空名要有可读兜底')

  const html = renderFlowList({
    flows: [{
      id: 'flow-test', name: '标准研发流水线', description: '',
      nodeCount: 8, edgeCount: 11, rejectCount: 4, updatedAt: '',
    }],
    activeId: 'flow-test',
    initialDeleteId: 'flow-test',
  })
  assert.ok(html.includes('确认删除「标准研发流水线」？'), '第一次点删除必须进入确认态，不能直接删')
  assert.ok(html.includes('确认删除'), '确认态缺少「确认删除」按钮')
  assert.ok(html.includes('取消'), '确认态缺少「取消」按钮')

  const undo = renderFlowList({ flows: [], undoDelete: { id: 'flow-x', name: '被删流程' } })
  assert.ok(undo.includes('已删除「被删流程」'), '删除成功后缺少撤销入口')
  assert.ok(undo.includes('撤销'), '撤销入口缺少可读按钮')
})

await checkAsync('G5-b：删除失败草稿仍在、快照可撤销；删除成功才清草稿', async () => {
  const snapshot = { ...model.defaultFlow(), id: 'flow-del' }
  const draftsStore = new Map()
  const drafts = {
    write: flow => draftsStore.set(flow.id, flow),
    clear: id => draftsStore.delete(id),
  }

  const failing = {
    readFlow: async () => ({ flow: snapshot }),
    deleteFlow: async () => { throw new Error('磁盘只读') },
  }
  const failed = await deleteFlowRequest({ api: failing, id: 'flow-del', drafts })
  assert.equal(failed.ok, false)
  assert.equal(failed.stage, 'delete')
  assert.ok(failed.backup, '删除失败必须保留内存快照，供重试 / 撤销')
  assert.equal(failed.backup.id, 'flow-del')
  assert.equal(draftsStore.has('flow-del'), true, '删除失败时草稿必须仍在')
  assert.ok(failed.error.message.includes('磁盘只读'))

  const succeeding = {
    readFlow: async () => ({ flow: snapshot }),
    deleteFlow: async () => ({ ok: true }),
  }
  const done = await deleteFlowRequest({ api: succeeding, id: 'flow-del', drafts })
  assert.equal(done.ok, true)
  assert.equal(draftsStore.has('flow-del'), false, '只有服务器删除成功后才清草稿')
  assert.equal(done.backup.id, 'flow-del', '成功后仍保留快照供撤销')

  // 拿不到快照就不删：没有备份的删除等于单点毁灭。
  let deleted = 0
  const noBackup = {
    readFlow: async () => { throw new Error('读取失败') },
    deleteFlow: async () => { deleted += 1 },
  }
  const blocked = await deleteFlowRequest({ api: noBackup, id: 'flow-del', drafts })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.stage, 'snapshot')
  assert.equal(deleted, 0, '拿不到完整快照时绝不能发 DELETE')

  // 撤销：把内存快照按原 id 写回服务器（PUT /flows/<id> 是 upsert，id 不变）。
  let saved = null
  const restored = await restoreFlowRequest({
    api: {
      saveFlow: async (id, body) => {
        saved = { id, body }
        return { flow: { ...snapshot } }
      },
    },
    backup: done.backup,
  })
  assert.equal(restored.ok, true)
  assert.equal(saved.id, 'flow-del')
  assert.equal(saved.body.id, 'flow-del')
  assert.equal(restored.flow.id, 'flow-del')
})

check('G5-c：运行详情展示 sessionMode / worktree.reason（未知值显示原始值）', () => {
  const known = renderFlowList({
    runs: [{
      id: 'run-mode', name: '模式已知', status: 'done',
      sessionMode: 'top-level',
      worktree: { enabled: false, reason: 'not-a-git-repo' },
    }],
    selectedRunId: 'run-mode',
  })
  assert.ok(known.includes('会话模式 · 顶层会话'), '已知 sessionMode 必须翻译成中文')
  assert.ok(known.includes('worktree · 未启用（原因：工作区不是 git 仓库）'),
    '未启用时必须显示可读的 worktree.reason')

  const unknown = renderFlowList({
    runs: [{
      id: 'run-unknown', name: '未知模式', status: 'done',
      sessionMode: 'future-mode',
      worktree: { enabled: false, reason: 'future-reason' },
    }],
    selectedRunId: 'run-unknown',
  })
  assert.ok(unknown.includes('future-mode'), '未知 sessionMode 必须显示原始值，不能空白')
  assert.ok(unknown.includes('future-reason'), '未知 worktree.reason 必须显示原始值')

  const enabled = renderFlowList({
    runs: [{
      id: 'run-wt', name: 'worktree 运行', status: 'done',
      sessionMode: 'injected',
      worktree: { enabled: true, branch: 'flow/run-wt', path: '/repo/.worktrees/run-wt' },
    }],
    selectedRunId: 'run-wt',
  })
  assert.ok(enabled.includes('注入式会话'), 'injected 必须有中文文案')
  assert.ok(enabled.includes('分支 flow/run-wt'), 'worktree.enabled=true 时必须显示分支')
  assert.ok(enabled.includes('/repo/.worktrees/run-wt'), 'worktree.enabled=true 时必须显示路径')

  assert.equal(sessionModeText(''), '未标注（旧 run）')
  assert.equal(sessionModeText('stub'), '桩引擎')
  assert.equal(sessionModeText('???'), '未知（???）')
  assert.equal(worktreeReasonText('disabled-by-initiator'), '发起方关闭了 worktree')
  assert.equal(worktreeReasonText('create-failed: boom'), '创建 worktree 失败：boom')
  assert.equal(worktreeReasonText(''), '原因未标注')
  assert.equal(worktreeReasonText('??'), '未知原因（??）')
  assert.equal(worktreeDetailText({ enabled: true, branch: '', path: '' }), '已启用')
})

check('G5-e：Alt 绕过吸附（几何纯函数 + 拖拽落位），松开后恢复 4px 吸附', () => {
  assert.equal(SNAP_GRID, 4, '逻辑吸附步长必须是 4px')
  assert.deepEqual(snapPosition({ x: 201.3, y: 223.2 }), { x: 200, y: 224 }, '默认吸附 4px 网格')
  assert.deepEqual(snapPosition({ x: 201.3, y: 223.2 }, { bypassSnap: true }), { x: 201, y: 223 },
    'Alt 按下时自由落位，只取整到 1px')
  assert.deepEqual(snapPosition({ x: 'x', y: null }), { x: 0, y: 0 }, '坏坐标降级成 0，不污染流程')
  assert.equal(snapToGridEnabled(true), false, 'Alt 按下时 React Flow 的 snapToGrid 必须关闭')
  assert.equal(snapToGridEnabled(false), true, '松开后恢复 snapToGrid')

  const commits = []
  const bypassEvents = []
  const handlers = createDragHandlers({
    snap: snapPosition,
    onBypassChange: bypass => bypassEvents.push(bypass),
    onMoveNode: (id, x, y) => commits.push([id, x, y]),
  })
  handlers.onNodeDrag({ altKey: false }, { id: 'n_dev', position: { x: 201.3, y: 223.2 } })
  handlers.onNodeDragStop({ altKey: true }, { id: 'n_dev', position: { x: 201.3, y: 223.2 } })
  handlers.onNodeDragStop({ altKey: false }, { id: 'n_dev', position: { x: 201.3, y: 223.2 } })
  assert.deepEqual(commits[0], ['n_dev', 201, 223], 'Alt 按下松手不能被吸回 4px 网格')
  assert.deepEqual(commits[1], ['n_dev', 200, 224], '松开 Alt 后必须恢复吸附')
  assert.deepEqual(bypassEvents, [false, true, false], 'Alt 状态要能同步给 snapToGrid')
})

/** G5-d 用：只收集定时器、不真正等待的假时钟。 */
function fakePollTimers() {
  const queue = []
  let seq = 0
  return {
    setTimeout(fn, ms) {
      const id = ++seq
      queue.push({ id, fn, ms })
      return id
    },
    clearTimeout(id) {
      const at = queue.findIndex(item => item.id === id)
      if (at >= 0) queue.splice(at, 1)
    },
    delays() {
      return queue.map(item => item.ms)
    },
  }
}

await checkAsync('G5-d：左栏与抽屉共用一份 runs 数据源，只发一次请求；空闲 15s / 前台立即刷新', async () => {
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalls += 1
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, runs: [{ id: 'run-1' }] }),
    }
  }
  const timers = fakePollTimers()
  const source = createRunsSource({
    read: () => api.listRuns(20),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: () => 1000,
  })
  try {
    // 两个消费方（左栏 / 抽屉）各自刷新：并发刷新必须合并成一次 fetch。
    const left = []
    const drawer = []
    source.subscribe(snapshot => left.push(snapshot))
    source.subscribe(snapshot => drawer.push(snapshot))
    await Promise.all([source.refresh({ force: true }), source.refresh({ force: true })])
    assert.equal(fetchCalls, 1, '共享数据源必须只发一次请求')
    assert.equal(left.length, 1, '左栏应从共享数据源拿到一次结果')
    assert.equal(drawer.length, 1, '抽屉应从共享数据源拿到一次结果')
    assert.equal(left[0], drawer[0], '两处必须是同一份快照对象（同一个 tick）')
    assert.equal(left[0].tick, 1)

    // 非 force 的第二次请求命中 1s 新鲜度保护，不会再打一次网络。
    await source.refresh()
    assert.equal(fetchCalls, 1, '同一 tick 内两处再问一次不应重复发请求')

    source.start()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fetchCalls, 2, 'start 必须立即刷新一次')
    assert.deepEqual(timers.delays(), [RUNS_IDLE_POLL_MS], '空闲时按 15s 轮询，不是完全停掉')
    assert.equal(RUNS_IDLE_POLL_MS, 15000)
    assert.equal(source.idleMs, 15000)

    source.foreground()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fetchCalls, 3, '切回前台 / 重新打开面板必须立即刷新一次')
  } finally {
    source.stop()
    globalThis.fetch = originalFetch
  }
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
    // React Flow 只从 react-dom 取 createPortal；宿主模块表同样提供它。
    if (name === 'react-dom') return ReactDOM
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

// ── v0.7：外部执行器 / 工作区分组 / supervision 只读展示 ──────────────────
console.log('runtime 0.7（client）')

function renderInspector(flowValue, nodeId) {
  return render(React.createElement(Inspector, {
    flow: flowValue,
    selection: { kind: 'node', id: nodeId },
    skills: [],
    onPatchNode() {},
    onPatchEdge() {},
    onDeleteNode() {},
    onDeleteEdge() {},
    onAddMember() {},
    onPatchMember() {},
    onRemoveMember() {},
    onConnect() {},
    onNudge() {},
  }))
}

function renderFlowList(props) {
  return render(React.createElement(FlowList, {
    flows: [],
    activeId: '',
    busy: false,
    onToggle() {},
    onOpen() {},
    onCreate() {},
    onDelete() {},
    ...props,
  }))
}

check('v0.7 §6：节点检查器渲染执行器下拉（dsh 默认 / codex / custom）', () => {
  const html = renderInspector(flow, 'n_req')
  assert.ok(html.includes('执行器'), '检查器缺少执行器字段')
  assert.ok(html.includes('<option value="dsh" selected="">dsh（默认）</option>'), '默认值必须是 dsh')
  assert.ok(html.includes('<option value="codex">codex</option>'), '缺少 codex 选项')
  assert.ok(html.includes('<option value="custom">custom</option>'), '缺少 custom 选项')
  assert.ok(!html.includes('外部执行器'), '默认 dsh 不应显示外部执行器标识')
  assert.ok(!html.includes('执行命令'), '默认 dsh 不应显示自定义命令输入')
})

check('v0.7 §6：非 dsh + team 给出红字提示并禁用 team 选项（与 Host 400 同口径）', () => {
  const external = model.defaultFlow()
  external.id = 'flow-external'
  const node = external.nodes.find(item => item.id === 'n_req')
  node.executor = 'codex'
  node.mode = model.EXEC_MODE.TEAM
  const html = renderInspector(external, 'n_req')
  assert.ok(html.includes('外部执行器'), '面板顶部要能一眼看出这个节点是外部 agent 跑的')
  assert.ok(html.includes('外部执行器只支持「单个 agent」模式'), '缺少与服务端一致的红字提示')
  const team = html.match(/<button[^>]*>主管 \+ 子 agent<\/button>/)
  assert.ok(team && /disabled/.test(team[0]), 'team 选项必须禁用')
  const single = html.match(/<button[^>]*>单个 agent<\/button>/)
  assert.ok(single && !/disabled/.test(single[0]), '单个 agent 选项必须仍可选')
})

check('v0.7 §6：custom 执行器显示必填命令输入（≤2000 字符）', () => {
  const custom = model.defaultFlow()
  custom.id = 'flow-custom'
  custom.nodes.find(item => item.id === 'n_req').executor = 'custom'
  const html = renderInspector(custom, 'n_req')
  assert.ok(html.includes('执行命令'), 'custom 必须显示执行命令输入')
  assert.match(html, /maxLength="2000"/i, '执行命令上限必须是 2000 字符')
  assert.ok(html.includes('必须填执行命令'), '空命令必须有必填提示')
})

check('v0.7 §4.3/§7：旧 run 缺 workspace/supervision 时退化为「未标注工作区」+「未开启」', () => {
  const legacy = [
    { id: 'run-legacy-1', name: '旧运行一', status: 'done' },
    { id: 'run-legacy-2', name: '旧运行二', status: 'failed' },
  ]
  const html = renderFlowList({ runs: legacy, selectedRunId: 'run-legacy-1' })
  assert.ok(html.includes('运行记录 · 2'), '运行记录区没有列出旧 run')
  assert.ok(html.includes('未标注工作区'), '缺 workspacePath 必须退化成一个默认分组')
  assert.match(html, /class="fs-rail-count">2</, '组头必须显示该组运行数')
  assert.ok(html.includes('旧运行一') && html.includes('旧运行二'), '旧 run 行必须照常渲染')
  assert.ok(html.includes('监督'), '详情头部缺少 supervision 区')
  assert.ok(html.includes('未开启'), 'supervision 缺失时必须显示「未开启」')

  // 降级关闭时 reason 不能丢（07 §7：连续唤醒失败 → enabled:false + reason）。
  const degraded = renderFlowList({
    runs: [{
      id: 'run-off', name: '降级运行', status: 'done',
      supervision: { enabled: false, wakes: 0, failures: 3, reason: 'wake-failed: 会话不可用' },
    }],
    selectedRunId: 'run-off',
  })
  assert.ok(degraded.includes('未开启'))
  assert.ok(degraded.includes('关闭原因：wake-failed: 会话不可用'), '关闭原因必须显示')
})

check('v0.7 §4.3/§7：按 workspacePath 分组、组头路径尾巴 + 计数、第一组默认展开', () => {
  const runs = [
    {
      id: 'run-a1', name: '仓库 A 运行一', status: 'running', workspacePath: '/home/me/repo-a',
      worktreeEnabled: true, worktree: { enabled: true, branch: 'flow/run-a1' },
      supervision: { enabled: true, nextDueAt: '2026-11-06T23:59:00+08:00', wakes: 3, failures: 1, reason: '' },
    },
    { id: 'run-a2', name: '仓库 A 运行二', status: 'done', workspacePath: '/home/me/repo-a' },
    { id: 'run-b1', name: '仓库 B 运行一', status: 'done', workspacePath: '/srv/repo-b' },
  ]
  const html = renderFlowList({ runs, selectedRunId: 'run-a1', activeRunId: 'run-a1' })
  assert.ok(html.includes('me/repo-a'), '组头必须显示路径尾巴')
  assert.ok(html.includes('repo-b'), '第二个工作区分组没有渲染')
  assert.deepEqual(
    html.match(/class="fs-rail-count">\d+</g),
    ['class="fs-rail-count">2<', 'class="fs-rail-count">1<'],
    '组头计数必须等于该组运行数',
  )
  assert.ok(html.includes('仓库 A 运行一') && html.includes('仓库 A 运行二'), '第一组必须默认展开')
  assert.ok(!html.includes('仓库 B 运行一'), '其余分组默认收起')
  assert.ok(html.includes('⎇ worktree'), 'worktreeEnabled 的 run 行必须显示 worktree 标记')
  assert.ok(/title="[^"]*flow\/run-a1[^"]*"/.test(html), '标题提示里必须写分支名')
  assert.ok(html.includes('已开启'), 'supervision 开启状态没有显示')
  assert.ok(html.includes('下次唤醒'), '缺少下次唤醒时间')
  assert.ok(html.includes('已唤醒 3 次'), '缺少已唤醒次数')
  assert.ok(html.includes('失败 1 次'), '缺少失败次数')

  // 展开态：第一组默认展开；点它之后必须能收起（不能因为「默认展开」而永远开着）。
  assert.equal(isGroupOpen(new Map(), 'me/repo-a', 0), true, '第一组必须默认展开')
  assert.equal(isGroupOpen(new Map(), 'repo-b', 1), false, '其余分组默认收起')
  const collapsed = nextGroupToggles(new Map(), 'me/repo-a', true)
  assert.equal(isGroupOpen(collapsed, 'me/repo-a', 0), false, '第一组点一下必须能收起')
  const expanded = nextGroupToggles(collapsed, 'repo-b', false)
  assert.equal(isGroupOpen(expanded, 'repo-b', 1), true, '其余分组点一下必须能展开')
})

check('v0.7 §4.3：页面把 initialRunView.runs 接进运行记录（旧数据不白屏）', () => {
  const html = render(React.createElement(FlowStudioPage, {
    initialFlow: flow,
    initialSkills: [],
    initialRunView: {
      runs: [{ id: 'run-old', name: '旧运行', status: 'done' }],
      selectedRunId: 'run-old',
      run: { id: 'run-old', name: '旧运行', status: 'done' },
      loaded: true,
    },
  }))
  assert.ok(html.includes('运行记录 · 1'), '页面没装配运行记录区')
  assert.ok(html.includes('未标注工作区'), '旧数据没有退化成一个默认工作区分组')
  assert.ok(html.includes('未开启'), '旧数据下 supervision 必须显示「未开启」')
})

// ── v0.8 §11.4：节点自审状态（只读） ─────────────────────────────────────
console.log('runtime 0.8（client · 节点自审状态）')

check('v0.8 §11.4：节点行渲染标题 / 状态徽标 / 进度条 / verdict 徽标', () => {
  const runs = [{
    id: 'run-ns', name: '节点自审运行', status: 'running',
    nodeStatus: {
      n_req: {
        state: 'working', progress: 40, summary: '正在改 x.ts', verdict: null,
        members: [], blockers: [], at: '2026-11-06T15:00:00.000Z',
      },
      n_plan: { state: 'done', progress: 100, verdict: 'pass' },
      n_test: { state: 'failed', progress: 60, verdict: 'reject' },
    },
  }]
  const html = renderFlowList({
    runs,
    selectedRunId: 'run-ns',
    nodes: [{ id: 'n_req', title: '需求分析' }, { nodeId: 'n_plan', title: '方案设计' }],
  })
  assert.ok(html.includes('节点状态'), '详情头部缺少「节点状态」区')
  assert.ok(html.includes('3 个节点'), '区块头缺少节点计数')
  assert.ok(html.includes('需求分析'), '拿得到 nodes 标题时必须显示标题（id 键）')
  assert.ok(html.includes('方案设计'), 'nodes 用 nodeId 键时也要能取到标题')
  assert.ok(html.includes('n_test'), '拿不到标题时必须退回 nodeId')
  assert.ok(html.includes('fs-node-state working'), 'working 状态徽标没有对应 class')
  assert.ok(html.includes('fs-node-state done'), 'done 状态徽标没有对应 class')
  assert.ok(html.includes('fs-node-state failed'), 'failed 状态徽标没有对应 class')
  assert.ok(html.includes('进行中') && html.includes('完成') && html.includes('失败'), '状态徽标缺少可读文字')
  assert.ok(html.includes('fs-run-node-verdict pass'), 'verdict=pass 必须显示 pass 徽标')
  assert.ok(html.includes('fs-run-node-verdict reject'), 'verdict=reject 必须显示 reject 徽标')
  assert.match(html, /class="fs-run-node-bar-fill" style="width:40%"/, '进度条宽度必须是 progress%')
  assert.match(html, /aria-valuenow="40"/, '进度条缺少 aria 读数')
  assert.ok(!html.includes(NODE_STATUS_EMPTY_TEXT), '有 nodeStatus 时不应显示降级文案')
  // 拿到的 detail 节点表本身也要能被归一化（数组 / 映射两种形状都不抛错）。
  assert.equal(nodeTitleMap([{ id: 'n_a', title: '甲' }]).get('n_a'), '甲')
  assert.equal(nodeTitleMap({ n_b: { title: '乙' } }).get('n_b'), '乙')
  assert.equal(nodeTitleMap('坏数据').size, 0)
})

check('v0.8 §11.4：blocked + blockers 显示「阻塞：」，最多 3 条并用「等 N 条」收尾', () => {
  const runs = [{
    id: 'run-blocked', name: '阻塞运行', status: 'running',
    nodeStatus: {
      n_dev: {
        state: 'blocked', progress: 20,
        blockers: ['等待依赖', '缺环境', '等审批', '等测试', '等人'],
      },
    },
  }]
  const html = renderFlowList({ runs, selectedRunId: 'run-blocked' })
  assert.ok(html.includes('fs-node-state blocked'), 'blocked 状态徽标没有对应 class')
  assert.ok(html.includes('阻塞：'), 'blocked 节点缺少「阻塞：」行')
  assert.ok(
    html.includes('阻塞：等待依赖、缺环境、等审批 等 5 条'),
    '阻塞行必须只列前 3 条，并用「等 N 条」收尾',
  )
  assert.equal(blockersText(['a', 'b', 'c', 'd']), '阻塞：a、b、c 等 4 条')
  assert.equal(blockersText(['只有一个']), '阻塞：只有一个')
  assert.equal(blockersText([]), '')
  assert.equal(blockersText('坏数据'), '', '坏类型按没有阻塞处理，不抛错')
  // 只在 title 里保留全量（一行橙字放不下）。
  assert.ok(/title="阻塞：[^"]*等人/.test(html), 'title 提示里应保留全部阻塞')
})

check('v0.8 §11.4：members 渲染「名字 · 状态」，有 note 时跟一行（靠 CSS 单行截断）', () => {
  const runs = [{
    id: 'run-members', name: '成员运行', status: 'running',
    nodeStatus: {
      n_dev: {
        state: 'working', progress: 10,
        members: [
          { name: '实现', state: 'working', note: '正在改 x.ts' },
          { name: '测试', state: 'done' },
        ],
      },
    },
  }]
  const html = renderFlowList({ runs, selectedRunId: 'run-members' })
  assert.ok(html.includes('fs-run-node-members'), '缺少成员小列表容器')
  assert.ok(html.includes('>实现<'), '成员名字没有渲染')
  assert.ok(html.includes('fs-run-node-member-state working'), '成员状态徽标没有对应 class')
  assert.ok(html.includes('>进行中<'), '成员状态必须显示可读文字')
  assert.ok(html.includes('正在改 x.ts'), '成员 note 必须渲染')
  assert.ok(html.includes('>测试<') && html.includes('>完成<'), '没有 note 的成员也要渲染')
  assert.match(CSS, /\.fs-run-node-member\{[^}]*white-space:nowrap/,
    '成员行必须单行截断（CSS 限制，不是截字符串）')
  assert.match(CSS, /\.fs-run-node-member\{[^}]*text-overflow:ellipsis/, '成员行缺少省略号')
})

check('v0.8 §11.4：nodeStatus 缺失 / 空 / 坏类型整块降级「暂无自审上报」，不抛错', () => {
  const cases = [
    undefined, null, {}, [], 'working', 42, { n1: 'working' }, { n1: 42 }, { n1: null },
  ]
  for (const nodeStatus of cases) {
    const html = renderFlowList({
      runs: [{ id: 'run-old', name: '老运行', status: 'done', nodeStatus }],
      selectedRunId: 'run-old',
    })
    assert.ok(html.includes(NODE_STATUS_EMPTY_TEXT),
      `坏 nodeStatus（${JSON.stringify(nodeStatus)}）必须退化到「${NODE_STATUS_EMPTY_TEXT}」`)
    assert.ok(html.includes('老运行'), '降级时运行记录本身必须照常渲染')
    assert.ok(html.includes('监督'), '降级时 supervision 区不能一起丢')
    assert.ok(!html.includes('fs-run-node-head'), '降级时不应渲染任何节点行')
    assert.equal(hasNodeStatus({ nodeStatus }), false, '坏 nodeStatus 不能算「有节点状态」')
  }
  assert.equal(nodeStatusOf(null), null, '坏条目归一化必须返回 null 而不是抛错')
  assert.deepEqual(nodeStatusEntries({}), [])
  const broken = nodeStatusEntries({
    nodeStatus: {
      n_ok: { state: 'done', progress: 99 },
      n_bad: 'done',
      '': { state: 'done' },
    },
  })
  assert.equal(broken.length, 1, '只有对象条目算有效上报')
  assert.equal(broken[0].nodeId, 'n_ok')
  // 进度 / 状态字段收敛：越界夹取、坏值按 0、未知状态按 working。
  assert.equal(nodeStatusOf({ state: 'weird', progress: 140 }).progress, 100)
  assert.equal(nodeStatusOf({ state: 'done', progress: -5 }).progress, 0)
  assert.equal(nodeStatusOf({ state: 'done', progress: '55' }).progress, 55)
  assert.equal(nodeStatusOf({ state: 'done', progress: 'abc' }).progress, 0)
  assert.equal(nodeStatusOf({ state: 'weird' }).state, 'working')
  assert.equal(nodeStatusOf({ state: 'done', verdict: 'maybe' }).verdict, '')
})

check('v0.8 §11.4：节点多于 6 个时区块内部滚动，整块只读不加按钮', () => {
  const many = {}
  for (let index = 1; index <= 7; index += 1) {
    many['n_' + index] = { state: 'working', progress: index * 10 }
  }
  const html = renderFlowList({
    runs: [{ id: 'run-many', name: '多节点运行', status: 'running', nodeStatus: many }],
    selectedRunId: 'run-many',
  })
  assert.equal(NODE_STATUS_SCROLL_AT, 6)
  assert.ok(html.includes('fs-run-nodes-body scroll'), '7 个节点必须挂内部滚动类')
  assert.ok(html.includes('7 个节点'))
  assert.match(CSS, /\.fs-run-nodes-body\.scroll\{[^}]*max-height:/, '内部滚动缺少 max-height')
  assert.match(CSS, /\.fs-run-nodes-body\.scroll\{[^}]*overflow-y:auto/, '内部滚动缺少 overflow-y')
  const start = html.indexOf('class="fs-run-nodes"')
  const end = html.indexOf('class="fs-rail-group"')
  assert.ok(start > 0 && end > start, '详情头部 / 分组布局标记缺失')
  const block = html.slice(start, end)
  assert.ok(!block.includes('<button'), '节点状态区是只读的，不能出现按钮')
  assert.ok(!block.includes('<input'), '节点状态区是只读的，不能出现输入框')

  const few = renderFlowList({
    runs: [{
      id: 'run-few', name: '少节点运行', status: 'running',
      nodeStatus: { n_1: { state: 'done', progress: 100 } },
    }],
    selectedRunId: 'run-few',
  })
  assert.ok(!few.includes('fs-run-nodes-body scroll'), '≤6 个节点不应出现内部滚动')
})

console.log(`\n${checks} 组通过`)
