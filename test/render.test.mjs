#!/usr/bin/env node
/**
 * 渲染自检（0.13.3 步骤 5）：真实 React 18 服务端渲染 + 构建产物 factory。
 *
 * 两段：
 *  A. 源码级：BPMN 画布壳、定义列表、定义版本、实例状态、人工待办、lastError、事件抽屉；
 *  B. 构建产物 lib/client.js：注册 id、slot 注册成对、面板组件能渲染、SSR 不加载 chunk。
 *
 * 不再断言旧 React Flow 节点卡 / 航道 / inspector —— 页面已切到 definitions/instances。
 * SSR 不跑 useEffect，因此「不请求 / 不建 Modeler」正是这里要证明的。
 *
 * 运行：node test/render.test.mjs（需先 npm run build，读 lib/client.js）
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import React from 'react'
import ReactDOM from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'

import { bindHostRequire, bindReact, rt } from '../src/client/runtime.js'

bindReact(React)

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

async function checkAsync(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

function render(element) {
  return renderToStaticMarkup(element)
}

/** 页面会把整份 CSS 渲染进 <style>；结构断言只看 body 标记。 */
function markupOf(html) {
  return html.replace(/<style[\s\S]*?<\/style>/g, '')
}

// ── 模块 ────────────────────────────────────────────────────────────────
const { BpmnCanvas, BPMN_CHUNK, canvasStatusText } = await import('../src/client/canvas.js')
const { CSS } = await import('../src/client/styles.js')
const {
  DefinitionList, DEFINITION_LIST_EMPTY_TEXT, definitionsFromPayload, versionSummary,
} = await import('../src/client/flowlist.js')
const {
  FlowStudioPage, PAGE_TITLE, newDefinitionId, runBlockReason, runtimeMarkersFromEvents,
  saveStateText,
} = await import('../src/client/page.js')
const {
  InstancePanel, PENDING_TASKS_EMPTY_TEXT, TaskList, errorTextOf, instanceErrorOf,
  instanceStatusText, normalizeTasks, parseTaskPayload, pendingTaskCount, taskKey, taskSubmitBody,
} = await import('../src/client/tasklist.js')
const {
  InstanceEventDrawer, eventRows, focusBpmnElement, mergeInstanceEvents,
} = await import('../src/client/logdrawer.js')
const { createPlugin } = await import('../src/client/plugin.js')

// ── fixtures ───────────────────────────────────────────────────────────
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="flow-demo" name="演示流程">
    <bpmn:startEvent id="Start_1" />
    <bpmn:userTask id="Human_1" name="人工处理" />
    <bpmn:endEvent id="End_1" />
  </bpmn:process>
</bpmn:definitions>`

const definition = {
  id: 'flow-demo',
  name: '演示流程',
  description: '用于 SSR 的定义',
  version: 2,
  hash: 'a'.repeat(64),
  latestVersion: 3,
  latestHash: 'b'.repeat(64),
  createdAt: '2026-11-11T10:00:00+08:00',
  updatedAt: '2026-11-11T10:00:00+08:00',
  versions: [
    { version: 1, hash: 'c'.repeat(64), createdAt: '2026-11-10T10:00:00+08:00', bytes: 100 },
    { version: 2, hash: 'a'.repeat(64), createdAt: '2026-11-11T10:00:00+08:00', bytes: 120 },
    { version: 3, hash: 'b'.repeat(64), createdAt: '2026-11-11T11:00:00+08:00', bytes: 140 },
  ],
  xml: XML,
}

const instance = {
  id: 'i-demo',
  status: 'ACTIVE',
  definitionId: 'flow-demo',
  definitionVersion: 2,
  definitionHash: 'a'.repeat(64),
  variables: { amount: 7 },
  lastSeq: 4,
  pendingTasks: [{
    activityId: 'Human_1',
    elementId: 'Human_1',
    name: '人工处理',
    since: '2026-11-11T10:00:03+08:00',
    executionId: 'Human_1_exec_1',
  }],
  lastError: { code: 'BPMN_HANDLER_FAILED', message: 'adapter 不可用' },
}

const events = [
  { type: 'process/start', seq: 1, at: '2026-11-11T10:00:01+08:00', elementId: 'flow-demo' },
  { type: 'activity/start', seq: 2, at: '2026-11-11T10:00:02+08:00', elementId: 'Human_1', activityId: 'act-1' },
  { type: 'activity/wait', seq: 3, at: '2026-11-11T10:00:03+08:00', elementId: 'Human_1', activityId: 'act-1' },
  { type: 'custom/unknown', seq: 4, at: '2026-11-11T10:00:04+08:00', elementId: 'Human_1' },
]

console.log('components')

// ── A1：画布壳 ─────────────────────────────────────────────────────────
check('BPMN 画布壳：SSR 输出稳定结构、加载提示与重试入口的语义', () => {
  const html = render(React.createElement(BpmnCanvas, { title: '定义画布' }))
  assert.ok(html.includes('data-bpmn-canvas="shell"'), '缺少画布壳标记')
  assert.equal(BPMN_CHUNK, './client.bpmn.js', 'chunk 名必须是宿主要求的相对路径')
  assert.ok(html.includes('data-state="loading"'), 'SSR 初始态是 loading')
  assert.ok(html.includes('data-chunk="client.bpmn.js"'), '壳上标明固定 chunk 文件')
  assert.ok(html.includes('BPMN 画布加载中…'), '缺少加载提示')
  assert.ok(html.includes('定义画布'), '标题没渲染')
  assert.ok(html.includes('data-bpmn-mount'), '缺少挂载点')
  assert.equal(canvasStatusText('ready'), 'BPMN 画布已加载')
  assert.equal(canvasStatusText('error'), 'BPMN 画布加载失败')
  assert.ok(!html.includes('bjs-container'), 'SSR 不能创建 Modeler DOM')
})

check('SSR 不调用 require.async：画布壳只在 effect 里懒加载 chunk', () => {
  const calls = []
  bindHostRequire({
    async(name) {
      calls.push(name)
      return { version: 'x', mountEditor() {} }
    },
  })
  const html = render(React.createElement(FlowStudioPage, {
    initialDefinition: definition,
    initialDefinitions: definitionsFromPayload({ definitions: [definition] }),
  }))
  assert.equal(calls.length, 0, 'SSR 渲染期间不能请求 chunk')
  assert.ok(html.includes('data-bpmn-canvas="shell"'), '页面里应有画布壳')
  bindHostRequire(null)
})

// ── A2：定义列表 / 版本 ────────────────────────────────────────────────
check('定义列表：名称 / id / 版本摘要 / 选中态 / 空态', () => {
  const rows = definitionsFromPayload({
    ok: true,
    definitions: [
      { id: 'flow-a', name: '流程 A', latestVersion: 3, versionCount: 3, versions: [] },
      { id: 'flow-b', latestVersion: 1, versionCount: 1 },
      { id: '', name: '坏行' },
      { id: 'flow-a', name: '重复 id' },
    ],
  })
  assert.equal(rows.length, 2, '重复 id / 缺 id 的行被丢掉')
  assert.equal(rows[0].name, '流程 A')
  assert.equal(versionSummary(rows[0]), 'v3 · 3 个版本')
  assert.equal(versionSummary(rows[1]), 'v1 · 1 个版本')
  assert.equal(versionSummary({ latestVersion: null }), '未保存版本')

  const html = render(React.createElement(DefinitionList, {
    definitions: rows,
    activeId: 'flow-a',
    templates: [{ id: 'manual', name: '最小人工流程' }],
  }))
  assert.ok(html.includes('data-definition-id="flow-a"'))
  assert.ok(html.includes('data-active="true"'))
  assert.ok(html.includes('data-active="false"'))
  assert.ok(html.includes('v3 · 3 个版本'))
  assert.ok(html.includes('新建') && html.includes('导入') && html.includes('模板'))
  assert.ok(html.includes('最小人工流程'), '模板选项没渲染')
  assert.ok(html.includes('data-action="import-definition"'), '导入入口缺少稳定标记')

  const empty = render(React.createElement(DefinitionList, { definitions: [] }))
  assert.ok(empty.includes(DEFINITION_LIST_EMPTY_TEXT), '空态要给出下一步')
})

// ── A3：页面（定义视图）───────────────────────────────────────────────
check('页面（定义）：画布壳、当前版本 / hash / 最新版本提示、保存状态', () => {
  const html = render(React.createElement(FlowStudioPage, {
    initialDefinition: definition,
    initialDefinitions: definitionsFromPayload({ definitions: [definition] }),
  }))
  assert.ok(html.includes(PAGE_TITLE))
  assert.ok(html.includes('data-view="definition"'))
  assert.ok(html.includes('data-bpmn-canvas="shell"'))
  assert.match(html, /data-definition-version="2"/, '当前钉住版本必须是 2')
  assert.ok(html.includes('当前 v2'))
  assert.ok(html.includes('hash aaaaaaaaaaaa'), 'hash 前缀要可见')
  assert.ok(html.includes('服务器已有 v3'), '有更新版本时要提示，但不自动切换')
  assert.ok(html.includes('已保存 v2'), '保存状态回显当前版本')
  assert.ok(html.includes('data-definition-version-select'), '多版本定义应能选择版本（?version=N）')
  assert.match(html, /<option value="1">v1<\/option>/, '版本下拉缺 v1')
  assert.ok(html.includes('v3（最新）'), '最新版本要标出来')
  assert.ok(html.includes('data-action="save-definition"'))
  assert.ok(html.includes('data-action="run-definition"'))
  assert.ok(html.includes('data-action="new-definition"'))
  // 新建 / 导入 / 模板三入口都在页面顶栏。
  assert.ok(html.includes('data-action="import-definition"'))
  assert.ok(html.includes('data-action="template-definition"'))
})

check('页面（定义）：有未保存修改时明确提示，运行按钮写清原因', () => {
  const html = render(React.createElement(FlowStudioPage, {
    initialDefinition: definition,
    initialDirty: true,
  }))
  assert.ok(html.includes('有未保存修改'), '缺少未保存提示')
  assert.match(html, /class="fs-btn sm fs-run-definition"[^>]*title="有未保存的修改：先保存版本，再运行。"/,
    '运行按钮 title 必须说明先保存')
  assert.equal(runBlockReason({ definitionId: 'a', version: 1, dirty: true }), '有未保存的修改：先保存版本，再运行。')
  assert.equal(runBlockReason({ definitionId: 'a', version: null, dirty: false }), '没有已保存的版本，先保存版本再运行。')
  assert.equal(runBlockReason({ definitionId: '', version: 1, dirty: false }), '还没有保存过定义，先保存一个版本再运行。')
  assert.equal(runBlockReason({ definitionId: 'a', version: 1, dirty: false }), '')
  assert.equal(saveStateText('saving', {}), '保存中…')
  assert.equal(saveStateText('error', {}), '保存失败')
  assert.equal(saveStateText('saved', { version: 4 }), '已保存 v4')
  assert.match(newDefinitionId(1, 0.5), /^flow-[a-z0-9]+-[a-z0-9]+$/)
  assert.ok(newDefinitionId(1, 0.5).length <= 64)
})

// ── A4：页面（实例视图）──────────────────────────────────────────────
check('页面（实例）：只读画布、实例状态、定义版本、待办、lastError', () => {
  const html = render(React.createElement(FlowStudioPage, {
    initialDefinition: definition,
    initialInstance: instance,
    initialInstanceDefinition: { xml: XML },
    initialTasks: instance.pendingTasks,
    initialEvents: events,
    initialDrawerOpen: true,
  }))
  assert.ok(html.includes('data-view="instance"'))
  assert.ok(html.includes('实例画布（只读）'), '实例视图标题必须标明只读')
  assert.ok(html.includes('只读'))
  assert.match(html, /data-instance-status="ACTIVE"/)
  assert.ok(html.includes('活跃'), 'ACTIVE 的中文状态')
  assert.ok(html.includes('实例快照 v2'), '实例钉住的定义版本')
  assert.ok(html.includes('data-task-activity-id="Human_1"'), '待办行缺少 activityId')
  assert.ok(html.includes('人工处理'))
  assert.ok(html.includes('executionId：Human_1_exec_1'), '待办要带当前 executionId')
  assert.ok(html.includes('BPMN_HANDLER_FAILED：adapter 不可用'), 'lastError 必须展示')
  assert.ok(html.includes('data-instance-error="true"'))
  assert.ok(html.includes('aria-label="人工任务 payload（JSON）"'), '缺少 payload 输入')
  assert.ok(html.includes('aria-label="完成人（decidedBy）"'), '缺少 decidedBy 输入')
  assert.ok(html.includes('data-event-seq="3"'), '事件抽屉有实例事件')
  assert.ok(html.includes('data-element-id="Human_1"'), '事件行带 elementId')
  assert.ok(html.includes('未知事件（custom/unknown）'), '未知事件降级显示')
})

check('实例状态：只使用 ACTIVE / COMPLETED / SUSPENDED / CANCELED，未知状态不冒充', () => {
  assert.equal(instanceStatusText('ACTIVE'), '活跃')
  assert.equal(instanceStatusText('active'), '活跃')
  assert.equal(instanceStatusText('COMPLETED'), '已完成')
  assert.equal(instanceStatusText('SUSPENDED'), '已挂起')
  assert.equal(instanceStatusText('CANCELED'), '已取消')
  assert.equal(instanceStatusText('waiting'), '未知状态（waiting）', 'waiting 不是实例状态')
  assert.equal(instanceStatusText('failed'), '未知状态（failed）', 'failed 不是实例状态')
  assert.equal(instanceStatusText(undefined), '未知状态（空）')

  // 「等待人工」只用 pendingTasks 表达，不是 status。
  const completed = render(React.createElement(InstancePanel, {
    instances: [{ ...instance, status: 'COMPLETED', pendingTasks: [] }],
    activeInstance: { ...instance, status: 'COMPLETED', pendingTasks: [], lastError: null },
    tasks: [],
  }))
  assert.ok(completed.includes('已完成'))
  assert.ok(completed.includes(PENDING_TASKS_EMPTY_TEXT))
  assert.ok(!completed.includes('等待人工 1'), '已完成实例不应再显示等待人工')

  const waiting = render(React.createElement(InstancePanel, {
    instances: [instance],
    activeInstance: instance,
    tasks: instance.pendingTasks,
  }))
  assert.ok(waiting.includes('等待人工 1'), '待办通过 pendingTasks 展示')
})

check('人工待办：payload / decidedBy / executionId；提交中禁用；JSON 非法不提交', () => {
  assert.deepEqual(parseTaskPayload(''), { ok: true, value: {} })
  assert.deepEqual(parseTaskPayload('{"approved":true}'), { ok: true, value: { approved: true } })
  assert.equal(parseTaskPayload('{oops').ok, false)
  assert.equal(parseTaskPayload('[1,2]').ok, false, 'payload 必须是对象')
  assert.equal(parseTaskPayload('42').ok, false)

  const task = instance.pendingTasks[0]
  assert.deepEqual(taskSubmitBody(task, { payload: { approved: true }, decidedBy: ' alice ' }), {
    payload: { approved: true }, decidedBy: 'alice', executionId: 'Human_1_exec_1',
  })
  assert.deepEqual(taskSubmitBody(task, { payload: {} }), {
    payload: {}, executionId: 'Human_1_exec_1',
  }, '空 decidedBy 不能提交空字符串')
  assert.equal(taskKey(task), 'Human_1::Human_1_exec_1')

  const submitting = render(React.createElement(TaskList, {
    tasks: instance.pendingTasks,
    submittingKeys: [taskKey(task)],
  }))
  assert.ok(submitting.includes('提交中…'), '提交中按钮文案')
  assert.match(submitting, /class="fs-btn sm primary fs-task-submit"[^>]*disabled=""/,
    '提交期间必须禁用重复操作')

  const ready = render(React.createElement(TaskList, { tasks: instance.pendingTasks }))
  assert.ok(ready.includes('完成任务'))
  assert.ok(!ready.includes('提交中…'))

  assert.equal(normalizeTasks({ tasks: [{ activityId: 'a' }, { name: '缺 id' }, null] }).length, 1, '坏任务行被丢掉')
  assert.equal(pendingTaskCount(instance), 1)
  assert.equal(pendingTaskCount({}), 0)
})

check('错误展示：lastError / result.error / 字符串都能读；没有错误时不渲染红色块', () => {
  assert.equal(errorTextOf({ code: 'X', message: 'boom' }), 'X：boom')
  assert.equal(errorTextOf('直接文本'), '直接文本')
  assert.equal(errorTextOf(null), '')
  assert.equal(instanceErrorOf({ lastError: { code: 'A', message: 'a' } }), 'A：a')
  assert.equal(instanceErrorOf({ result: { error: { message: 'b' } } }), 'b')
  assert.equal(instanceErrorOf({ lastError: null }), '')

  const html = render(React.createElement(InstancePanel, {
    instances: [instance],
    activeInstance: { ...instance, lastError: null },
    tasks: instance.pendingTasks,
  }))
  assert.ok(!html.includes('执行错误'), '没有 lastError 时不能显示错误块')
})

check('事件模型：seq 合并 + elementId 定位（activityId 不是图元 id）', () => {
  const merged = mergeInstanceEvents([], events)
  assert.deepEqual(merged.events.map(event => event.seq), [1, 2, 3, 4])
  assert.equal(merged.unknown, 1)
  const markerMap = Object.fromEntries(runtimeMarkersFromEvents(events).map(item => [item.elementId, item.state]))
  assert.deepEqual(markerMap, { 'flow-demo': 'active', Human_1: 'waiting' })
  assert.equal(eventRows(events).length, 4)
  assert.equal(eventRows(events)[3].unknown, true)

  const scrolled = []
  const fakeEditor = {
    getModeler: () => ({
      get: name => (name === 'elementRegistry'
        ? { get: id => (id === 'Human_1' ? { id } : null) }
        : { scrollToElement: element => scrolled.push(element.id) }),
    }),
  }
  assert.equal(focusBpmnElement(fakeEditor, 'Human_1'), true)
  assert.equal(focusBpmnElement(fakeEditor, 'act-1'), false, 'activityId 不能定位')
  assert.deepEqual(scrolled, ['Human_1'])
})

check('页面不再渲染旧 flows/runs UI', () => {
  const html = markupOf(render(React.createElement(FlowStudioPage, {
    initialDefinition: definition,
    initialInstance: instance,
    initialInstanceDefinition: { xml: XML },
    initialTasks: instance.pendingTasks,
  })))
  for (const legacy of [
    'react-flow__', 'fs-node ', 'fs-canvas', '检查器', '运行记录', '流程模板',
    '开始运行', '重启', 'inbox', '指标', '打回上限',
  ]) {
    assert.ok(!html.includes(legacy), `页面仍渲染旧 UI 片段：${legacy}`)
  }
})

check('样式：页面新选择器存在、颜色走宿主 token、暗色有专门分支', () => {
  for (const selector of [
    '.fs-bpmn-page', '.fs-bpmn-top', '.fs-def-list', '.fs-def-row',
    '.fs-bpmn-center', '.fs-bpmn-viewhead', '.fs-instance-panel', '.fs-instance-detail',
    '.fs-task-list', '.fs-task-payload', '.fs-event-drawer', '.fs-event-row',
  ]) {
    assert.ok(CSS.includes(selector), 'styles.js 缺少 ' + selector)
  }
  assert.ok(!/#[0-9a-f]{3,8}/i.test(CSS), 'styles.js 不能出现裸 hex')
  assert.ok(CSS.includes('body[data-ds-dark-theme]'), '暗色主题缺少专门分支')
  assert.ok(CSS.includes('var(--dsw-alias-'), '颜色必须走宿主 token')
  assert.ok(CSS.includes('prefers-reduced-motion'), '动画必须尊重减少动效偏好')
  // SSR 页面要把样式一起带出来（面板卸载即随之移除）。
  const html = render(React.createElement(FlowStudioPage, { initialDefinition: definition }))
  assert.ok(html.includes('.fs-bpmn-page'), '样式没有随页面渲染')
})

// ── B. 构建产物 ─────────────────────────────────────────────────────────
console.log('lib/client.js')

check('打包产物在假浏览器环境里加载并注册成对的两个 slot', () => {
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
    if (name === 'react-dom') return ReactDOM
    throw new Error(`未知的浏览器模块依赖：${name}`)
  })
  assert.equal(plugin.name, 'flow-studio')
  assert.deepEqual(plugin.inject, ['slots'])

  const registrations = []
  plugin.apply({
    slots: {
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
  assert.equal(icon.id, main.key, '侧栏 id 必须等于 main 的 key')
  assert.equal(typeof main.component, 'function', 'main 槽组件不是函数')
  assert.equal(typeof icon.component, 'function', '侧栏图标不是函数')

  const html = render(React.createElement(main.component))
  const body = markupOf(html)
  assert.ok(html.includes('fs-root'), '面板组件渲染不出根节点')
  assert.ok(html.includes('data-bpmn-canvas="shell"'), '打包产物里的页面必须接上画布壳')
  assert.ok(!body.includes('react-flow__'), '面板不再渲染 React Flow 结构')
  assert.ok(!body.includes('检查器'), '面板不再渲染旧检查器')

  const iconHtml = render(React.createElement(icon.component, { size: 18, active: true }))
  assert.ok(iconHtml.includes('<svg'), '侧栏图标不是 SVG')
})

check('plugin 源码级：apply 内懒取 uiWorkspace.openSession，返回 boolean、不 await', () => {
  const plugin = createPlugin(() => React)
  assert.deepEqual(plugin.inject, ['slots'], 'inject 数组仍应只有 slots')
  let getCalls = 0
  const registrations = []
  const slots = {
    register(options, component) {
      return { ...options, component }
    },
    inject(ownerKey, callback) {
      registrations.push({ ownerKey, ...callback() })
      return () => {}
    },
  }
  const ctx = {
    slots,
    get() {
      getCalls += 1
      throw new Error('apply 期间不应读取 ctx.get')
    },
  }
  plugin.apply(ctx)
  assert.equal(getCalls, 0, 'apply() 期间不能调用 ctx.get')
  const main = registrations.find(item => item.name === 'main')
  assert.ok(main, '没有注册 main 槽')
  assert.equal(typeof main.inject, 'function', 'main slot 缺少 inject')
  const injected = main.inject()
  assert.equal(typeof injected.openSession, 'function', 'inject 应返回 openSession')
  assert.equal(injected.openSession('sess-1'), false, '服务缺失时 openSession 应返回 false')

  const calls = []
  const workspace = { openSession(target) { calls.push(target) } }
  plugin.apply({ slots, get: name => (name === 'uiWorkspace' ? workspace : undefined) })
  const main2 = registrations.filter(item => item.name === 'main').pop()
  assert.equal(main2.inject().openSession('sess-9'), true)
  assert.deepEqual(calls, ['sess-9'], 'openSession 必须原样转交节点会话 id')
  plugin.apply({ slots, get: () => ({ openSession() { throw new Error('navigation failed') } }) })
  const main3 = registrations.filter(item => item.name === 'main').pop()
  assert.equal(main3.inject().openSession('sess-x'), false)
})

console.log(`\n${checks} 组通过`)
