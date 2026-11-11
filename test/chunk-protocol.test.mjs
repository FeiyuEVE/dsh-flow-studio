#!/usr/bin/env node
/**
 * 宿主 chunk 协议冒烟（0.13.3 步骤 2）。
 *
 * 断言的是「装进 profile 之后浏览器真正拿到的那份字节」：
 * 1. `lib/client.js` 是主包注册形状（只有 factory，无 chunk 字段）；
 * 2. `lib/client.bpmn.js` 注册为 `chunk: 'client.bpmn.js'`，factory 返回其 exports；
 * 3. 主包 factory 能在**没有 document 的裸 Node** 里执行并返回插件对象；
 * 4. chunk 的 mountEditor / destroy 能在最小假 DOM 上完成挂载与清理；
 * 5. SSR 渲染画布壳不会触发 `require.async`，输出稳定结构。
 *
 * 运行：node test/chunk-protocol.test.mjs（需要先 npm run build）
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { bindHostRequire, bindReact, rt } from '../src/client/runtime.js'
import { BPMN_CHUNK, BPMN_CHUNK_FILE, BpmnCanvas, canvasStatusText } from '../src/client/canvas.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)

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

function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

/** 在只有 window.__ModuleLoader__ 的上下文里求值产物，返回它注册的定义。 */
function evaluateRegistration(file) {
  const source = readFileSync(join(repoRoot, 'lib', file), 'utf8')
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition } } },
    console,
  }
  vm.runInNewContext(source, sandbox, { filename: `lib/${file}` })
  A.ok(captured, `${file} 调用了 window.__ModuleLoader__.load`)
  return captured
}

console.log('chunk protocol')

const mainSource = readFileSync(join(repoRoot, 'lib/client.js'), 'utf8')
const chunkSource = readFileSync(join(repoRoot, 'lib/client.bpmn.js'), 'utf8')

check('主包注册形状：id + factory，不带 chunk 字段', () => {
  A.equal(evaluateRegistration('client.js').id, '@feiyueve/dsh-flow-studio')
  A.match(mainSource, /factory:\s*\(require\)/, '主包注册带 factory(require)')
  A.ok(!mainSource.includes("chunk: 'client.bpmn.js'"), '主包不能带 chunk 字段')
})

check('chunk 注册形状：chunk: client.bpmn.js + factory', () => {
  const definition = evaluateRegistration('client.bpmn.js')
  A.equal(definition.id, '@feiyueve/dsh-flow-studio')
  A.equal(definition.chunk, 'client.bpmn.js')
  A.match(chunkSource, /chunk:\s*'client\.bpmn\.js'/, 'chunk 字段是固定文件名')
  A.match(chunkSource, /factory:\s*\(require\)/, 'chunk 注册带 factory(require)')
})

check('主包 factory 在无 document / 无 window 组件的裸 Node 里可执行', () => {
  const definition = evaluateRegistration('client.js')
  A.equal(typeof definition.factory, 'function')
  // sandbox 里没有 document；factory 的 require 只交给插件表，不碰 DOM。
  const plugin = definition.factory(nodeRequire)
  A.equal(plugin.name, 'flow-studio')
  A.equal(typeof plugin.apply, 'function')
  A.equal(Array.from(plugin.inject).join(','), 'slots')
})

check('chunk factory 返回 exports；真实 mountEditor 在非 DOM 环境给出可读错误', () => {
  const definition = evaluateRegistration('client.bpmn.js')
  A.equal(typeof definition.factory, 'function')
  const chunk = definition.factory(nodeRequire)
  A.equal(typeof chunk.version, 'string')
  A.ok(chunk.version.length > 0, 'chunk 有 version')
  A.equal(typeof chunk.mountEditor, 'function')
  A.equal(typeof chunk.BPMN_EDITOR_CSS, 'string', 'chunk 自带官方样式 + 主题桥接')
  A.ok(chunk.BPMN_EDITOR_CSS.includes('--bio-surface'), '主题桥接含 --bio-* 映射')
  A.ok(chunk.BPMN_EDITOR_CSS.includes('data:font/woff2;base64,'), '字体已内联为 woff2 data URI')
  A.ok(!/url\(\s*['"]?(?:\.\.?\/|https?:)/.test(chunk.BPMN_EDITOR_CSS), '样式里没有外部 url()')

  // 步骤 3 起 mountEditor 会创建真实 Modeler：非 DOM 容器必须同步抛可读错误，
  // 而不是静默挂一个占位节点。真实浏览器挂载由 test/client-bpmn.browser.test.mjs 覆盖。
  let thrown = null
  try {
    chunk.mountEditor(null, {})
  } catch (error) {
    thrown = error
  }
  A.ok(thrown && typeof thrown.message === 'string', 'mountEditor(null) 抛错')
  A.equal(thrown.name, 'TypeError', '错误类型是 TypeError（跨 vm realm 只比名字）')
  A.match(thrown.message, /DOM 容器/, '错误信息说明需要 DOM 容器')
})

check('画布壳使用相对 chunk 名，且顶层不 import bpmn-js / 不读 document', () => {
  A.equal(BPMN_CHUNK, './client.bpmn.js', 'require.async 用相对 chunk 名')
  A.equal(BPMN_CHUNK_FILE, 'client.bpmn.js')
  const source = readFileSync(join(repoRoot, 'src/client/canvas.js'), 'utf8')
  A.ok(!/from\s+'bpmn-js/.test(source), 'canvas.js 顶层不 import bpmn-js')
  A.ok(!/from\s+'diagram-js/.test(source), 'canvas.js 顶层不 import diagram-js')
  A.ok(!/\bdocument\./.test(source), 'canvas.js 顶层不读 document.*')
  A.ok(!/\bwindow\./.test(source), 'canvas.js 顶层不读 window.*')
  A.ok(source.includes('hostRequire.async(BPMN_CHUNK)'), '异步加载发生在壳内、用 BPMN_CHUNK')
})

check('SSR 渲染画布壳：输出稳定结构，且 require.async 调用次数为 0', () => {
  bindReact(React)
  let asyncCalls = 0
  const fakeHostRequire = {
    async(name) {
      asyncCalls += 1
      return { version: 'should-not-load' }
    },
  }
  bindHostRequire(fakeHostRequire)
  A.equal(rt.require, fakeHostRequire, '宿主 require 句柄已注入运行时')

  const html = renderToStaticMarkup(React.createElement(BpmnCanvas, {
    title: '编辑流程',
    hostRequire: fakeHostRequire,
  }))
  A.equal(asyncCalls, 0, 'SSR 不执行 useEffect，因此不触发 require.async')
  A.ok(html.includes('data-bpmn-canvas="shell"'), '有壳标记')
  A.ok(html.includes('data-state="loading"'), 'SSR 初始状态是加载中')
  A.ok(html.includes('data-chunk="client.bpmn.js"'), '壳声明目标 chunk')
  A.ok(html.includes('role="region"'), '有可读 region')
  A.ok(html.includes('aria-busy="true"'), '加载中标 aria-busy')
  A.ok(html.includes('编辑流程'), '标题渲染出来')
  A.ok(html.includes('BPMN 画布加载中'), '状态文案渲染出来')
  A.ok(html.includes('正在加载 BPMN 画布资源'), '加载提示渲染出来')
  A.ok(html.includes('data-bpmn-mount'), '有挂载点')
  A.ok(!html.includes('fs-bpmn-canvas-error'), 'SSR 不应输出错误块')
  A.equal(canvasStatusText('ready'), 'BPMN 画布已加载')
  A.equal(canvasStatusText('error'), 'BPMN 画布加载失败')
  bindHostRequire(null)
})

console.log(`\nchunk 协议冒烟：${checks} 组通过（${assertionCount} 条断言）`)
