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
const { FlowCanvas } = await import('../src/client/canvas.js')
const { Inspector } = await import('../src/client/inspector.js')
const { PreviewDialog, IssuesDialog } = await import('../src/client/dialogs.js')
const { FlowList } = await import('../src/client/flowlist.js')
const { FlowStudioPage } = await import('../src/client/page.js')

const flow = model.defaultFlow()
flow.id = 'flow-test'

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
  assert.ok(html.includes('已同步'), '保存状态没显示')
})

check('页面骨架在没有流程时给出加载态', () => {
  const html = render(React.createElement(FlowStudioPage))
  assert.ok(html.includes('fs-root'))
  assert.ok(html.includes('正在加载'))
  assert.ok(html.includes('.fs-node'), '样式没有随组件一起渲染')
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
