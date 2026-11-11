#!/usr/bin/env node
/**
 * 页面级接线与实例视图竞态回归（0.13.5 复审修复）。
 *
 * 用最小的 React 渲染探针渲染**真实组件树**：
 * - `createElement` 用真实 React，hooks 换成可观测的同步实现（不挂真实 DOM）；
 * - 页面里的子组件会被真正执行：`BpmnCanvas` 的 `useEffect` 会跑，chunk 的
 *   `mountEditor` / `onReady` 走真实接线，测试不再手工复制 `mountOptions`；
 * - 宿主元素的 `ref` 用桩对象赋值（画布壳只需要 `mountRef.current` 存在）；
 * - effect 顺序与 React 一致：子树先于父组件、同组件内按声明顺序；卸载时子先父后。
 *
 * 覆盖：
 *  1. BLOCKER：画布变更没有接到页面（dirty / 运行门禁 / 本地草稿）；
 *  2. MAJOR：统一的视图选择世代，迟到的实例响应不能覆盖后选的定览；
 *  3. MAJOR：切实例先清空事件与游标，事件请求失败不回退到上一个实例；
 *  4. MAJOR：读到终态停轮询前先追平 `detail.lastSeq`（打开实例 / 轮询两条路径）；
 *  5. MINOR：完成人工待办 404/409 刷新后仍保留服务端原因；
 *  6. M1：切换实例详情失败后回滚事件缓存归属，旧实例轮询继续生效；
 *  7. M2：终态补拉失败后仍按退避重试，最终补齐收尾事件；
 *  8. M3：Host 预留 lastSeq 不推进 `since`，未落盘事件不会永久跳过；
 *  9. M4：异步导入完成时按最新事件缓存重算 marker，旧 marker 不能覆盖终态；
 * 10. M4 交错：导入期间切走视图，迟到的导入结果不能写回 marker；
 * 11. m1：真实渲染 BpmnCanvas，验证 mountOptions 透传与卸载销毁。
 *
 * 运行：node test/client-page-wiring.test.mjs
 */

import assert from 'node:assert/strict'

import React from 'react'

import { BpmnCanvas } from '../src/client/canvas.js'
import { clearDraft, readDraft } from '../src/client/drafts.js'
import { DefinitionList } from '../src/client/flowlist.js'
import { InstanceEventDrawer } from '../src/client/logdrawer.js'
import { FlowStudioPage } from '../src/client/page.js'
import { bindReact } from '../src/client/runtime.js'
import { InstancePanel } from '../src/client/tasklist.js'

let checks = 0
let assertions = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    checks += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    // 一条失败不打断其余回归：逐个报告，最后统一以非零退出。
    failures.push({ name, error })
    console.log(`  ✗ ${name}`)
    console.log('    ' + String((error && error.message) || error))
  }
}

function eq(actual, expected, message) {
  assertions += 1
  assert.equal(actual, expected, message)
}

function deep(actual, expected, message) {
  assertions += 1
  assert.deepEqual(actual, expected, message)
}

function ok(value, message) {
  assertions += 1
  assert.ok(value, message)
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function event(seq, type, extra = {}) {
  return { seq, type, at: `2026-11-11T10:00:${String(seq).padStart(2, '0')}.000Z`, ...extra }
}

/*
 * ---------------------------------------------------------------------------
 * 最小 React 渲染探针
 *
 * 每个组件节点一份 hooks 数组（hooks 顺序与真实 React 一致）；组件按元素树递归
 * 渲染，宿主元素的 ref 赋桩对象，effect 子树先于父组件执行。异步链路由
 * settle() 反复「渲染 + 让出事件循环」推进。
 * ---------------------------------------------------------------------------
 */
let activeProbe = null
let currentProbeCtx = null
const treeContexts = new WeakMap()

const probeReact = {
  createElement: React.createElement,
  useState(initial) { return activeProbe.useState(initial) },
  useRef(initial) { return activeProbe.useRef(initial) },
  useMemo(factory, deps) { return activeProbe.useMemo(factory, deps) },
  useCallback(fn, deps) { return activeProbe.useCallback(fn, deps) },
  useEffect(fn, deps) { return activeProbe.useEffect(fn, deps) },
}

// 页面与画布壳在顶层只读 rt.React / rt.h，渲染前注入一次即可。
bindReact(probeReact)

function sameDeps(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return false
  if (previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

function createProbe(Component, props) {
  const ctx = {
    rendered: new WeakMap(),
    nodes: new Map(),
    seen: new Set(),
    current: null,
    dirty: false,
    mounted: true,
  }
  let rootTree = null
  let rootNode = null

  const makeNode = (path, type) => ({
    path,
    type,
    hooks: [],
    hookIndex: 0,
    pendingEffects: [],
    mounted: true,
    _children: [],
  })

  const hooksApi = node => ({
    useState(initial) {
      const index = node.hookIndex++
      if (!node.hooks[index]) {
        node.hooks[index] = {
          kind: 'state',
          value: typeof initial === 'function' ? initial() : initial,
        }
      }
      const hook = node.hooks[index]
      const setState = next => {
        if (!ctx.mounted || !node.mounted) return
        const value = typeof next === 'function' ? next(hook.value) : next
        if (Object.is(value, hook.value)) return
        hook.value = value
        ctx.dirty = true
      }
      return [hook.value, setState]
    },
    useRef(initial) {
      const index = node.hookIndex++
      if (!node.hooks[index]) node.hooks[index] = { kind: 'ref', current: initial }
      return node.hooks[index]
    },
    useMemo(factory, deps) {
      const index = node.hookIndex++
      const hook = node.hooks[index]
      if (hook && sameDeps(hook.deps, deps)) return hook.value
      node.hooks[index] = { kind: 'memo', value: factory(), deps: Array.isArray(deps) ? deps.slice() : null }
      return node.hooks[index].value
    },
    useCallback(fn, deps) {
      const index = node.hookIndex++
      const hook = node.hooks[index]
      if (hook && sameDeps(hook.deps, deps)) return hook.value
      node.hooks[index] = { kind: 'callback', value: fn, deps: Array.isArray(deps) ? deps.slice() : null }
      return fn
    },
    useEffect(fn, deps) {
      const index = node.hookIndex++
      node.pendingEffects.push({ index, fn, deps: Array.isArray(deps) ? deps.slice() : null })
    },
  })

  const assignRef = node => {
    // React 18 把 ref 放在元素上（不进 props）。
    const ref = node.ref !== undefined ? node.ref : (node.props && node.props.ref)
    if (!ref) return
    const target = { __probeRef: true }
    try {
      if (typeof ref === 'function') ref(target)
      else if (typeof ref === 'object' && ref.current === null) ref.current = target
    } catch {
      // ref 回调抛错在真实 React 里也会冒泡；测试里不阻断渲染。
    }
  }

  const renderOutput = (node, path) => {
    if (node === null || node === undefined || typeof node === 'boolean'
      || typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) {
      const out = node.map((child, index) => renderOutput(child, `${path}.${index}`))
      ctx.rendered.set(node, out)
      return out
    }
    if (typeof node !== 'object' || !node.type) return node
    if (typeof node.type === 'function') {
      const element = node
      let componentNode = ctx.nodes.get(path)
      if (!componentNode || componentNode.type !== element.type) {
        if (componentNode) runCleanups(componentNode)
        componentNode = makeNode(path, element.type)
        ctx.nodes.set(path, componentNode)
      }
      const target = componentNode
      ctx.seen.add(target)
      target.hookIndex = 0
      target.pendingEffects = []
      target._children = []
      const parent = ctx.current
      if (parent) parent._children.push(target)
      else rootNode = target
      ctx.current = target
      const api = hooksApi(target)
      const previousProbe = activeProbe
      activeProbe = api
      let output
      try {
        output = element.type(element.props || {})
      } finally {
        activeProbe = previousProbe
      }
      // 子组件输出用带后缀的路径，避免组件返回组件时与自身节点 key 冲突。
      const rendered = renderOutput(output, `${path}>`)
      ctx.current = parent
      ctx.rendered.set(element, rendered)
      return element
    }
    assignRef(node)
    if (node.props && node.props.children !== undefined) {
      const rendered = renderOutput(node.props.children, path)
      ctx.rendered.set(node, rendered)
    }
    return node
  }

  const commitEffects = node => {
    for (const child of node._children) commitEffects(child)
    for (const effect of node.pendingEffects) {
      const previous = node.hooks[effect.index]
      // deps 为 null 时每次渲染都跑（与 React 一致）。
      if (previous && effect.deps !== null && sameDeps(previous.deps, effect.deps)) continue
      if (previous && typeof previous.cleanup === 'function') previous.cleanup()
      const hook = previous || {}
      hook.deps = effect.deps
      node.hooks[effect.index] = hook
      const cleanup = effect.fn()
      hook.cleanup = typeof cleanup === 'function' ? cleanup : null
    }
  }

  function runCleanups(node) {
    for (const child of node._children) runCleanups(child)
    node.mounted = false
    for (const hook of node.hooks) {
      if (hook && typeof hook.cleanup === 'function') {
        try {
          hook.cleanup()
        } catch {
          // 卸载期清理失败不阻断其余清理
        }
        hook.cleanup = null
      }
    }
  }

  const renderPass = () => {
    ctx.seen = new Set()
    ctx.current = null
    rootNode = null
    const root = React.createElement(Component, props)
    const rendered = renderOutput(root, '/')
    for (const node of [...ctx.nodes.values()]) {
      if (!ctx.seen.has(node)) {
        runCleanups(node)
        ctx.nodes.delete(node.path)
      }
    }
    commitEffects(rootNode)
    return rendered
  }

  const handle = {
    mounted: true,
    get tree() {
      return rootTree
    },
    mount() {
      ctx.dirty = true
    },
    flush() {
      let guard = 0
      do {
        ctx.dirty = false
        rootTree = renderPass()
        treeContexts.set(rootTree, ctx)
        currentProbeCtx = ctx
      } while (ctx.dirty && (guard += 1) < 50)
    },
    unmount() {
      handle.mounted = false
      ctx.mounted = false
      if (rootNode) runCleanups(rootNode)
      ctx.nodes.clear()
    },
  }
  return handle
}

/** 反复推进：渲染待处理的 state 更新 + 让出事件循环，让异步请求链跑完。 */
async function settle(probe, rounds = 25) {
  for (let i = 0; i < rounds; i += 1) {
    if (probe.mounted) probe.flush()
    // 用 setImmediate 而不是 setTimeout：后者在探针里是假定时器。
    await new Promise(resolve => setImmediate(resolve))
  }
  if (probe.mounted) probe.flush()
}

// ── 元素树工具（递归进入子组件的渲染结果）────────────────────────────────

function ctxOf(tree) {
  return treeContexts.get(tree) || currentProbeCtx
}

function walkElements(node, visit, ctx = null) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    for (const child of node) walkElements(child, visit, ctx)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') return
  if (typeof node !== 'object') return
  visit(node)
  let children = node.props ? node.props.children : undefined
  if (ctx && ctx.rendered.has(node)) children = ctx.rendered.get(node)
  walkElements(children, visit, ctx)
}

function findElement(tree, predicate) {
  let found = null
  walkElements(tree, node => {
    if (found === null && predicate(node)) found = node
  }, ctxOf(tree))
  return found
}

function textOf(node, ctx = currentProbeCtx) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(child => textOf(child, ctx)).join('')
  if (!node) return ''
  if (ctx && ctx.rendered.has(node)) return textOf(ctx.rendered.get(node), ctx)
  if (node.props) return textOf(node.props.children, ctx)
  return ''
}

function actionButton(tree, action) {
  return findElement(tree, node => node.type === 'button'
    && node.props && node.props['data-action'] === action)
}

function dataView(probe) {
  const root = findElement(probe.tree, node => node.props && node.props['data-view'] !== undefined)
  return root === null ? '' : root.props['data-view']
}

function hasDirtyBadge(probe) {
  return findElement(probe.tree, node => node.props
    && node.props.className === 'fs-view-badge warn'
    && textOf(node) === '有未保存修改') !== null
}

function findCanvas(probe) {
  return findElement(probe.tree, node => node.type === BpmnCanvas)
}

function drawerOf(probe) {
  return findElement(probe.tree, node => node.type === InstanceEventDrawer)
}

/** 最近一次推给画布的 marker（数组副本）。 */
function lastMarkers(editor) {
  const list = editor.calls.markers
  return list.length === 0 ? [] : list[list.length - 1]
}

function markerState(editor, elementId) {
  const markers = lastMarkers(editor)
  const found = Array.isArray(markers) ? markers.find(item => item && item.elementId === elementId) : null
  return found ? found.state : ''
}

// ── 假定时器（轮询 / 草稿去抖）────────────────────────────────────────────

function installFakeTimers() {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let now = 0
  let seq = 0
  const queue = new Map()
  const timer = {
    now: () => now,
    pending: () => queue.size,
    setTimeout(fn, ms) {
      const id = ++seq
      queue.set(id, { at: now + Math.max(0, Number(ms) || 0), fn })
      return id
    },
    clearTimeout(id) { queue.delete(id) },
    advance(ms) {
      const target = now + Math.max(0, Number(ms) || 0)
      for (;;) {
        let dueId = 0
        let due = null
        for (const [id, item] of queue) {
          if (item.at > target) continue
          if (!due || item.at < due.at || (item.at === due.at && id < dueId)) {
            dueId = id
            due = item
          }
        }
        if (!due) break
        queue.delete(dueId)
        now = due.at
        due.fn()
      }
      now = target
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
  }
  globalThis.setTimeout = timer.setTimeout
  globalThis.clearTimeout = timer.clearTimeout
  return timer
}

async function withFakeTimers(fn) {
  const timer = installFakeTimers()
  try {
    await fn(timer)
  } finally {
    timer.restore()
  }
}

// ── 假编辑器 / 假 API client ──────────────────────────────────────────────

const XML_A = '<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="A"/>'
const XML_B = '<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="B"/>'

function createEditor(saveXml = '<xml>edited</xml>') {
  const calls = { importXML: [], viewer: [], markers: [], saveXML: 0, destroy: 0 }
  return {
    calls,
    ready: Promise.resolve({ ok: true }),
    getContainer: () => ({ querySelector: () => null }),
    getModeler: () => ({ get: () => null }),
    importXML: async value => { calls.importXML.push(value) },
    saveXML: async () => { calls.saveXML += 1; return saveXml },
    setViewerMode: async value => { calls.viewer.push(value) },
    setRuntimeState: list => { calls.markers.push(Array.isArray(list) ? list.slice() : []) },
    destroy: () => { calls.destroy += 1 },
  }
}

const definitionA = {
  id: 'flow-a',
  name: 'A 流程',
  version: 1,
  hash: 'hash-a',
  latestVersion: 1,
  versions: [{ version: 1, hash: 'hash-a' }],
  xml: XML_A,
}

const definitionB = {
  id: 'flow-b',
  name: 'B 流程',
  version: 2,
  hash: 'hash-b',
  latestVersion: 2,
  versions: [{ version: 2, hash: 'hash-b' }],
  xml: XML_B,
}

function makeClient(overrides = {}) {
  const calls = {
    readDefinition: [], saveDefinition: [], readInstance: [], readInstanceEvents: [],
    completeInstanceTask: [], listDefinitions: 0, listInstances: 0,
  }
  const client = {
    async listDefinitions() {
      calls.listDefinitions += 1
      return { definitions: [] }
    },
    async readDefinition(id, options) {
      calls.readDefinition.push({ id, options })
      return definitionA
    },
    async saveDefinition(body) {
      calls.saveDefinition.push(body)
      return { id: body.id, version: 1, hash: 'hash-a' }
    },
    async listInstances() {
      calls.listInstances += 1
      return { instances: [] }
    },
    async createInstance(body) {
      return { id: 'i-new', status: 'ACTIVE', body }
    },
    async readInstance(id) {
      calls.readInstance.push(id)
      return { id, status: 'ACTIVE', pendingTasks: [] }
    },
    async readInstanceDefinition(id) {
      return { id, xml: XML_A }
    },
    async readInstanceTasks(id) {
      return { id, tasks: [] }
    },
    async readInstanceEvents(id, query) {
      calls.readInstanceEvents.push({ id, query })
      return { id, events: [], lastSeq: 0 }
    },
    async completeInstanceTask(id, activityId, body) {
      calls.completeInstanceTask.push({ id, activityId, body })
      return { ok: true }
    },
    async stopInstance(id) {
      return { id, status: 'CANCELED' }
    },
  }
  return { client: { ...client, ...overrides }, calls }
}

/**
 * 挂载真实页面：`BpmnCanvas` 会被真正渲染，它的 effect 通过宿主 `require.async`
 * 拿到假 chunk，再调用 `chunk.mountEditor(container, mountOptions)` 与
 * `onReady(chunk, editor)` —— 与浏览器里的接线完全一致。
 */
async function mountPage({ client, props = {}, saveXml, editor: providedEditor } = {}) {
  const definitionId = props.initialDefinition && props.initialDefinition.id
  if (definitionId) clearDraft(definitionId)
  const editor = providedEditor || createEditor(saveXml)
  const captured = {}
  const chunk = {
    version: 'probe-1',
    mountEditor(container, options) {
      captured.container = container
      captured.options = options || {}
      return editor
    },
  }
  const hostRequire = {
    async async() {
      return chunk
    },
  }
  const probe = createProbe(FlowStudioPage, { apiClient: client, hostRequire, ...props })
  probe.mount()
  await settle(probe)
  const canvas = findCanvas(probe)
  ok(canvas !== null, '页面必须渲染 BpmnCanvas 壳')
  return { probe, editor, captured, chunk, canvas: canvas || null }
}

/** 模拟编辑器命令栈变更：chunk 在创建时捕获的 onChange。 */
function raiseChange(mounted, info = { dirty: true, mode: 'modeler' }) {
  const onChange = mounted.captured.options && mounted.captured.options.onChange
  eq(typeof onChange, 'function', 'BpmnCanvas 必须把页面的 onChange 作为 mountOptions 传给编辑器（否则 dirty 永远不生效）')
  onChange(info)
}

console.log('client-page-wiring')

// 1. BLOCKER：画布变更接线 -------------------------------------------------

await check('BLOCKER-1 画布变更接到页面：dirty 徽标 / 运行门禁 / 本地草稿', async () => {
  await withFakeTimers(async timer => {
    const saved = []
    const { client } = makeClient({
      readDefinition: async () => definitionA,
      saveDefinition: async body => {
        saved.push(body)
        return { id: body.id, version: 2, hash: 'hash-a2' }
      },
    })
    const mounted = await mountPage({
      client,
      props: {
        initialDefinition: definitionA,
        initialDefinitions: { definitions: [definitionA] },
      },
    })
    const { probe } = mounted

    eq(dataView(probe), 'definition')
    eq(hasDirtyBadge(probe), false, '刚打开已保存定义时不能有 dirty')
    eq(actionButton(probe.tree, 'run-definition').props.disabled, false, '无未保存修改时可以运行')

    // 画布编辑 → 页面必须标记 dirty、禁用运行、调度本地草稿。
    raiseChange(mounted)
    await settle(probe)

    eq(hasDirtyBadge(probe), true, '画布变更后必须出现「有未保存修改」徽标')
    const runButton = actionButton(probe.tree, 'run-definition')
    eq(runButton.props.disabled, true, '有未保存修改时运行按钮必须禁用')
    eq(runButton.props.title, '有未保存的修改：先保存版本，再运行。', '运行门禁要写清原因')
    eq(textOf(findElement(probe.tree, node => node.props && node.props['data-save-state'] !== undefined)),
      '有未保存修改', '顶栏保存状态要同步')

    // 草稿去抖：窗内不写，到点只写一次（写的是编辑器最新 XML）。
    eq(readDraft('flow-a'), null, '去抖窗未到不能提前落草稿')
    timer.advance(600)
    await settle(probe)
    const draft = readDraft('flow-a')
    ok(draft !== null, '画布变更必须调度本地草稿')
    eq(draft.xml, '<xml>edited</xml>', '草稿必须是编辑器序列化出的最新 XML')

    // 保存版本：payload 正确，并且只清「提交时那一版」的 dirty。
    const saveButton = actionButton(probe.tree, 'save-definition')
    eq(saveButton.props.disabled, false, '画布就绪后允许保存')
    const saving = saveButton.props.onClick()
    await settle(probe)
    await saving
    await settle(probe)
    eq(saved.length, 1, '保存必须发出一次 POST /definitions')
    deep(saved[0], { id: 'flow-a', name: 'A 流程', xml: '<xml>edited</xml>' })
    eq(hasDirtyBadge(probe), false, '保存成功且提交后没有再改：dirty 清空')
    eq(actionButton(probe.tree, 'run-definition').props.disabled, false)

    // 保存期间继续编辑：响应晚到只能清提交时那一版，dirty 必须保留。
    const pendingSave = deferred()
    const duringSave = []
    client.saveDefinition = async body => {
      duringSave.push(body)
      return pendingSave.promise
    }
    raiseChange(mounted)
    await settle(probe)
    const savingAgain = actionButton(probe.tree, 'save-definition').props.onClick()
    await settle(probe)
    eq(duringSave.length, 1, '第二次保存请求已发出')
    raiseChange(mounted) // 用户在保存响应回来前又改了图
    await settle(probe)
    pendingSave.resolve({ id: 'flow-a', version: 3, hash: 'hash-a3' })
    await savingAgain
    await settle(probe)
    eq(hasDirtyBadge(probe), true, '保存期间继续编辑：响应只能清提交时那一版，dirty 必须保留')
    eq(actionButton(probe.tree, 'run-definition').props.disabled, true, '仍有未保存修改：不能运行')
  })
})

// 2. 实例只读视图不产生 dirty / 草稿 --------------------------------------

await check('BLOCKER-1 实例只读视图：画布变更不触发 dirty / 草稿', async () => {
  await withFakeTimers(async timer => {
    const instance = {
      id: 'i-completed', status: 'COMPLETED', definitionId: 'flow-a',
      definitionVersion: 1, definitionHash: 'hash-a', lastSeq: 1, pendingTasks: [],
    }
    const mounted = await mountPage({
      client: makeClient().client,
      props: {
        initialDefinition: definitionA,
        initialInstance: instance,
        initialInstanceDefinition: { xml: XML_A },
        initialEvents: [event(1, 'process/start', { elementId: 'p' })],
        initialTasks: [],
      },
    })
    const { probe, editor } = mounted
    eq(dataView(probe), 'instance')

    raiseChange(mounted, { dirty: true, mode: 'viewer' })
    await settle(probe)
    eq(hasDirtyBadge(probe), false, '实例只读视图不能出现 dirty 徽标')
    eq(editor.calls.saveXML, 0, '实例视图不能序列化/写定义草稿')
    timer.advance(2500)
    await settle(probe)
    eq(editor.calls.saveXML, 0, '实例视图任何时刻都不调度草稿')
    eq(readDraft('flow-a'), null)
  })
})

// 3. 卸载时草稿 flush / 定时器清理 / 真实画布销毁 -------------------------

await check('BLOCKER-1 草稿去抖：卸载时 flush 落盘一次，并清掉定时器、销毁画布', async () => {
  await withFakeTimers(async timer => {
    const mounted = await mountPage({
      client: makeClient().client,
      props: {
        initialDefinition: definitionA,
        initialDefinitions: { definitions: [definitionA] },
      },
    })
    const { probe, editor } = mounted

    raiseChange(mounted)
    await settle(probe)
    eq(editor.calls.saveXML, 0, '去抖窗未到不序列化整图')
    eq(readDraft('flow-a'), null)

    probe.unmount()
    await settle(probe)
    eq(editor.calls.saveXML, 1, '卸载清理必须把最后一版草稿落盘一次')
    ok(readDraft('flow-a') !== null, '卸载后本地草稿应可读')
    eq(editor.calls.destroy, 1, 'BpmnCanvas 卸载必须销毁真实编辑器（不能是空函数）')

    timer.advance(2500)
    await settle(probe)
    eq(editor.calls.saveXML, 1, '卸载后去抖 / maxWait 定时器必须清掉，不能重复写')
  })
})

// 4. MAJOR：迟到的实例响应不能覆盖后选的定览 -----------------------------

await check('MAJOR-2 统一视图选择世代：迟到的实例响应不能覆盖后选的定览', async () => {
  await withFakeTimers(async () => {
    const instanceLate = {
      id: 'i-late', status: 'ACTIVE', definitionId: 'flow-a',
      definitionVersion: 1, definitionHash: 'hash-a', pendingTasks: [],
    }
    const definitionResponse = deferred()
    const instanceResponse = deferred()
    const { client } = makeClient({
      readDefinition: async id => (id === 'flow-b' ? definitionResponse.promise : definitionA),
      readInstance: async () => instanceResponse.promise,
      readInstanceDefinition: async () => ({ xml: XML_A }),
      readInstanceTasks: async () => ({ tasks: [] }),
      readInstanceEvents: async () => ({ events: [], lastSeq: 0 }),
    })
    const mounted = await mountPage({
      client,
      props: {
        initialDefinition: definitionA,
        initialDefinitions: { definitions: [definitionA, definitionB] },
        initialInstances: { instances: [instanceLate] },
      },
    })
    const { probe } = mounted

    // 先打开实例（响应挂起），再选择另一份定义 —— 列表在加载期间仍可点击。
    const panel = findElement(probe.tree, node => node.type === InstancePanel)
    panel.props.onSelectInstance('i-late')
    await settle(probe)
    const list = findElement(probe.tree, node => node.type === DefinitionList)
    const opening = list.props.onOpen('flow-b')
    await settle(probe)

    definitionResponse.resolve(definitionB)
    await opening
    await settle(probe)
    eq(dataView(probe), 'definition')
    eq(textOf(findElement(probe.tree, node => node.props
      && node.props.className === 'fs-view-title')), 'flow-b')

    // 迟到的实例响应：必须因为世代不匹配被丢弃。
    instanceResponse.resolve(instanceLate)
    await settle(probe)
    eq(dataView(probe), 'definition', '迟到的实例响应不能把页面切回实例视图')
    eq(findElement(probe.tree, node => node.type === InstancePanel).props.activeInstance, null,
      '迟到的实例响应不能写 activeInstance')
    eq(findCanvas(probe).props.title, '定义画布', '画布必须仍停在定义编辑视图')
  })
})

// 5. MAJOR：切实例先清空事件 / 游标，失败不回退旧实例 --------------------

await check('MAJOR-3 切到新实例先清空事件与游标：事件请求失败也不回退旧实例', async () => {
  await withFakeTimers(async timer => {
    const instanceA = { id: 'i-a', status: 'ACTIVE', lastSeq: 100, pendingTasks: [] }
    const instanceB = { id: 'i-b', status: 'ACTIVE', lastSeq: 5, pendingTasks: [] }
    const eventQueries = []
    const { client } = makeClient({
      readInstance: async () => instanceB,
      readInstanceDefinition: async () => ({ xml: XML_B }),
      readInstanceTasks: async () => ({ tasks: [] }),
      readInstanceEvents: async (id, query) => {
        eventQueries.push({ id, query })
        throw new Error('事件服务不可用')
      },
    })
    const mounted = await mountPage({
      client,
      props: {
        initialDefinition: definitionA,
        initialInstance: instanceA,
        initialInstanceDefinition: { xml: XML_A },
        initialEvents: [event(100, 'activity/start', { elementId: 'A-task', activityId: 'a1' })],
        initialTasks: [],
      },
    })
    const { probe } = mounted

    const panel = findElement(probe.tree, node => node.type === InstancePanel)
    panel.props.onSelectInstance('i-b')
    await settle(probe)

    const drawer = drawerOf(probe)
    eq(drawer.props.instanceId, 'i-b')
    eq(drawer.props.lastSeq, 0, '切实例后游标必须归零，不能沿用旧实例的 100')
    deep(drawer.props.events, [], '事件请求失败不能回退到上一个实例的事件（尤其不能显示 A-task）')
    ok(String(drawer.props.error || '').includes('事件服务不可用'), '必须显示事件读取失败原因')

    // 后续轮询必须以 since=0 重新拉，否则会永久漏掉 B 的历史事件。
    timer.advance(2000)
    await settle(probe)
    const polled = eventQueries.filter(item => item.id === 'i-b').pop()
    deep(polled.query, { since: 0 }, '新实例的下一次增量请求必须从 0 开始')
  })
})

// 6. MAJOR：终态前追平事件（打开实例路径）--------------------------------

await check('MAJOR-4 打开实例已终态：先追平 detail.lastSeq 再停轮询', async () => {
  await withFakeTimers(async timer => {
    const instanceA = { id: 'i-a', status: 'ACTIVE', lastSeq: 0, pendingTasks: [] }
    const queries = []
    let eventCalls = 0
    const { client } = makeClient({
      readInstance: async () => ({ id: 'i-term', status: 'COMPLETED', lastSeq: 4, pendingTasks: [] }),
      readInstanceDefinition: async () => ({ xml: XML_B }),
      readInstanceTasks: async () => ({ tasks: [] }),
      readInstanceEvents: async (id, query) => {
        queries.push(query)
        eventCalls += 1
        if (eventCalls === 1) {
          return {
            id,
            events: [
              event(1, 'activity/start', { elementId: 'T' }),
              event(2, 'activity/end', { elementId: 'T', status: 'completed' }),
            ],
            lastSeq: 2,
          }
        }
        return {
          id,
          events: [
            event(3, 'activity/start', { elementId: 'U' }),
            event(4, 'process/end', { elementId: 'p' }),
          ],
          lastSeq: 4,
        }
      },
    })
    const mounted = await mountPage({
      client,
      props: {
        initialDefinition: definitionA,
        initialInstance: instanceA,
        initialInstanceDefinition: { xml: XML_A },
        initialEvents: [],
        initialTasks: [],
      },
    })
    const { probe } = mounted
    const panel = findElement(probe.tree, node => node.type === InstancePanel)
    panel.props.onSelectInstance('i-term')
    await settle(probe)

    eq(eventCalls, 2, '详情已 COMPLETED 但事件只到 seq=2：必须补拉一次')
    eq(queries[0], undefined, '首次打开实例不带 since（全量窗口）')
    deep(queries[1], { since: 2 }, '补拉必须从已显示的最大 seq 继续')
    const drawer = drawerOf(probe)
    eq(drawer.props.lastSeq, 4, 'displayLastSeq 必须追平 detail.lastSeq')
    deep(drawer.props.events.map(item => item.seq), [1, 2, 3, 4], '最后的 activity/end、process/end 不能被丢掉')
    eq(timer.pending(), 0, '追平后实例已终态，不能再安排轮询')
  })
})

// 7. MAJOR：终态前追平事件（轮询路径）------------------------------------

await check('MAJOR-4 轮询读到终态：先追平 detail.lastSeq 再停轮询', async () => {
  await withFakeTimers(async timer => {
    const instance = { id: 'i-poll', status: 'ACTIVE', lastSeq: 0, pendingTasks: [] }
    const queries = []
    let eventCalls = 0
    const { client } = makeClient({
      readInstance: async () => ({ id: 'i-poll', status: 'COMPLETED', lastSeq: 4, pendingTasks: [] }),
      readInstanceEvents: async (id, query) => {
        queries.push(query)
        eventCalls += 1
        if (eventCalls === 1) {
          return {
            id,
            events: [
              event(1, 'activity/start', { elementId: 'T' }),
              event(2, 'activity/end', { elementId: 'T', status: 'completed' }),
            ],
            lastSeq: 2,
          }
        }
        return {
          id,
          events: [
            event(3, 'activity/start', { elementId: 'U' }),
            event(4, 'process/end', { elementId: 'p' }),
          ],
          lastSeq: 4,
        }
      },
    })
    const mounted = await mountPage({
      client,
      props: {
        initialDefinition: definitionA,
        initialInstance: instance,
        initialInstanceDefinition: { xml: XML_A },
        initialEvents: [],
        initialTasks: [],
      },
    })
    const { probe } = mounted

    timer.advance(2000)
    await settle(probe)
    eq(eventCalls, 2, '轮询读到 COMPLETED 后必须再补拉一次事件')
    deep(queries[0], { since: 0 })
    deep(queries[1], { since: 2 })
    const drawer = drawerOf(probe)
    eq(drawer.props.lastSeq, 4)
    deep(drawer.props.events.map(item => item.seq), [1, 2, 3, 4])
    eq(timer.pending(), 0, '追平后停轮询，不再安排下一次')
  })
})

// 8. MINOR：404 / 409 原因不被刷新覆盖 ------------------------------------

await check('MINOR-5 完成待办 409 刷新后保留服务端原因提示', async () => {
  await withFakeTimers(async () => {
    const instance = {
      id: 'i-1', status: 'ACTIVE', lastSeq: 1,
      pendingTasks: [{ activityId: 'human1', executionId: 'human1_exec_1', name: '人工处理' }],
    }
    const conflict = Object.assign(new Error('实例已结束'), {
      status: 409,
      data: { code: 'BPMN_INSTANCE_TERMINAL', error: '实例已结束' },
    })
    const { client } = makeClient({
      readInstance: async () => ({ ...instance, status: 'COMPLETED', pendingTasks: [] }),
      readInstanceDefinition: async () => ({ xml: XML_A }),
      readInstanceTasks: async () => ({ tasks: [] }),
      readInstanceEvents: async () => ({ events: [], lastSeq: 1 }),
      completeInstanceTask: async () => { throw conflict },
    })
    const mounted = await mountPage({
      client,
      props: {
        initialDefinition: definitionA,
        initialInstance: instance,
        initialInstanceDefinition: { xml: XML_A },
        initialTasks: instance.pendingTasks,
        initialEvents: [],
      },
    })
    const { probe } = mounted
    const panel = findElement(probe.tree, node => node.type === InstancePanel)
    panel.props.onCompleteTask(instance.pendingTasks[0], { payload: {}, decidedBy: 'alice' })
    await settle(probe)

    const notice = findElement(probe.tree, node => node.props && node.props['data-notice-kind'] !== undefined)
    ok(notice !== null, '刷新待办后 409 原因不能被立即清空')
    eq(notice.props['data-notice-kind'], 'error')
    ok(textOf(notice).includes('实例已结束'), '提示必须包含服务端原因「实例已结束」')
  })
})

// 9. M1：切换实例详情失败必须回滚事件缓存归属 -----------------------------

await check('M1 切换实例详情失败：回滚事件归属，旧实例轮询继续落地', async () => {
  await withFakeTimers(async timer => {
    const instanceA = { id: 'i-a', status: 'ACTIVE', lastSeq: 1, pendingTasks: [] }
    const pollQueries = []
    const detailCalls = []
    const { client } = makeClient({
      readInstance: async id => {
        detailCalls.push(id)
        if (id === 'i-b') throw new Error('实例详情服务不可用')
        return { id: 'i-a', status: 'ACTIVE', lastSeq: 2, pendingTasks: [] }
      },
      readInstanceDefinition: async id => ({ id, xml: id === 'i-b' ? XML_B : XML_A }),
      readInstanceTasks: async id => ({ id, tasks: [] }),
      readInstanceEvents: async (id, query) => {
        pollQueries.push({ id, query })
        if (id === 'i-b') return { id, events: [], lastSeq: 0 }
        return { id, events: [event(2, 'activity/end', { elementId: 'T', status: 'completed' })], lastSeq: 2 }
      },
    })
    const mounted = await mountPage({
      client,
      props: {
        initialDefinition: definitionA,
        initialInstance: instanceA,
        initialInstanceDefinition: { xml: XML_A },
        initialEvents: [event(1, 'activity/wait', { elementId: 'T', status: 'waiting' })],
        initialTasks: [],
      },
    })
    const { probe, editor } = mounted
    eq(markerState(editor, 'T'), 'waiting', '初始事件应把 T 标成 waiting')

    const panel = findElement(probe.tree, node => node.type === InstancePanel)
    panel.props.onSelectInstance('i-b')
    await settle(probe)

    // 详情失败：不能留下 activeInstance=i-a / eventsOwner=i-b。
    const failedDrawer = drawerOf(probe)
    eq(failedDrawer.props.instanceId, 'i-a', '切换失败后事件缓存归属必须回滚到原实例')
    eq(failedDrawer.props.lastSeq, 1, '切换失败后游标必须回滚到原实例已消费的位置')
    deep(failedDrawer.props.events.map(item => item.seq), [1], '切换失败后原实例事件不能被清空')
    eq(findElement(probe.tree, node => node.type === InstancePanel).props.activeInstance.id, 'i-a')
    eq(markerState(editor, 'T'), 'waiting', '切换失败后画布 marker 也要回滚到原实例')
    const notice = findElement(probe.tree, node => node.props && node.props['data-notice-kind'] !== undefined)
    ok(textOf(notice).includes('实例详情服务不可用'), '必须显示切换失败原因')

    // 后续旧实例轮询必须继续落地：请求 i-a?since=1，事件 2 被应用，详情也被刷新。
    timer.advance(2000)
    await settle(probe)
    const drawer = drawerOf(probe)
    deep(drawer.props.events.map(item => item.seq), [1, 2], '切换失败后旧实例的新事件必须继续应用')
    eq(drawer.props.lastSeq, 2, '旧实例游标必须随新事件推进')
    eq(markerState(editor, 'T'), 'completed', '新事件到达后画布 marker 必须更新')
    deep(pollQueries.filter(item => item.id === 'i-a').pop().query, { since: 1 },
      '旧实例轮询必须从已消费游标继续，而不是被永久丢弃')
    ok(detailCalls.filter(id => id === 'i-a').length >= 1, '旧实例轮询必须重新读取详情')
    eq(timer.pending(), 1, '旧实例轮询定时器必须继续存在')
  })
})

// 10. M2：终态补拉失败不能静默停止轮询 ------------------------------------

await check('M2 终态补拉失败：继续退避重试，最终补齐收尾事件', async () => {
  await withFakeTimers(async timer => {
    const instance = { id: 'i-term', status: 'ACTIVE', lastSeq: 0, pendingTasks: [] }
    const queries = []
    let eventCalls = 0
    const { client } = makeClient({
      readInstance: async id => ({ id, status: 'COMPLETED', lastSeq: 4, pendingTasks: [] }),
      readInstanceEvents: async (id, query) => {
        queries.push(query)
        eventCalls += 1
        if (eventCalls === 1) {
          return {
            id,
            events: [
              event(1, 'activity/start', { elementId: 'T' }),
              event(2, 'activity/end', { elementId: 'T', status: 'completed' }),
            ],
            lastSeq: 2,
          }
        }
        // 第一次补拉失败（暂时性）：调用方不能就此停止轮询。
        if (eventCalls === 2) throw new Error('事件服务暂时不可用')
        return {
          id,
          events: [
            event(3, 'activity/start', { elementId: 'U' }),
            event(4, 'process/end', { elementId: 'p' }),
          ],
          lastSeq: 4,
        }
      },
    })
    const mounted = await mountPage({
      client,
      props: {
        initialDefinition: definitionA,
        initialInstance: instance,
        initialInstanceDefinition: { xml: XML_A },
        initialEvents: [],
        initialTasks: [],
      },
    })
    const { probe } = mounted

    timer.advance(2000)
    await settle(probe)
    eq(eventCalls, 2, '第一次补拉必须已经发出并失败')
    const failedDrawer = drawerOf(probe)
    eq(failedDrawer.props.lastSeq, 2, '补拉失败时已消费游标停在 seq=2')
    deep(failedDrawer.props.events.map(item => item.seq), [1, 2])
    ok(drawerOf(probe).props.error !== '', '补拉失败必须显示错误，不能静默')
    ok(timer.pending() >= 1, '补拉失败后必须安排下一次重试（有界退避），不能停止轮询')

    // 继续推进 60 秒：重试成功，收尾事件补齐，之后才允许停止轮询。
    timer.advance(60000)
    await settle(probe)
    const drawer = drawerOf(probe)
    deep(drawer.props.events.map(item => item.seq), [1, 2, 3, 4], '重试成功后必须补齐 3、4 两条收尾事件')
    eq(drawer.props.lastSeq, 4, '追平后游标到 4')
    ok(eventCalls >= 3, '必须真的重试过事件补拉')
    eq(timer.pending(), 0, '只有追平成功后才允许停止轮询')
  })
})

// 10b. M2 竞态：打开时非终态，轮询转终态后补拉失败仍要重试 -----------------

await check('M2b 打开实例后转为终态：补拉失败仍继续重试（不被旧的“已追平”标记误导）', async () => {
  await withFakeTimers(async timer => {
    const instanceA = { id: 'i-a', status: 'ACTIVE', lastSeq: 0, pendingTasks: [] }
    const queries = []
    let detailCalls = 0
    let eventCalls = 0
    const { client } = makeClient({
      readInstance: async id => {
        if (id !== 'i-term') return instanceA
        detailCalls += 1
        // 第一次打开时还是 ACTIVE；之后的轮询才返回终态。
        return detailCalls === 1
          ? { id, status: 'ACTIVE', lastSeq: 2, pendingTasks: [] }
          : { id, status: 'COMPLETED', lastSeq: 4, pendingTasks: [] }
      },
      readInstanceDefinition: async () => ({ xml: XML_A }),
      readInstanceTasks: async () => ({ tasks: [] }),
      readInstanceEvents: async (id, query) => {
        queries.push(query)
        eventCalls += 1
        if (eventCalls === 1) {
          return {
            id,
            events: [
              event(1, 'activity/start', { elementId: 'T' }),
              event(2, 'activity/end', { elementId: 'T', status: 'completed' }),
            ],
            lastSeq: 2,
          }
        }
        if (eventCalls === 2) return { id, events: [], lastSeq: 2 }
        // 轮询转终态后的第一次补拉失败。
        if (eventCalls === 3) throw new Error('事件服务暂时不可用')
        return {
          id,
          events: [
            event(3, 'activity/start', { elementId: 'U' }),
            event(4, 'process/end', { elementId: 'p' }),
          ],
          lastSeq: 4,
        }
      },
    })
    const mounted = await mountPage({
      client,
      props: {
        initialDefinition: definitionA,
        initialInstance: instanceA,
        initialInstanceDefinition: { xml: XML_A },
        initialEvents: [],
        initialTasks: [],
      },
    })
    const { probe } = mounted
    const panel = findElement(probe.tree, node => node.type === InstancePanel)
    panel.props.onSelectInstance('i-term')
    await settle(probe)
    eq(detailCalls, 1, '打开实例时详情返回 ACTIVE')
    eq(drawerOf(probe).props.lastSeq, 2)

    // 轮询读到 COMPLETED；补拉失败后必须仍有下一次重试。
    timer.advance(2000)
    await settle(probe)
    eq(eventCalls, 3, '轮询与第一次补拉都已发出')
    ok(drawerOf(probe).props.error !== '', '补拉失败必须显示错误')
    ok(timer.pending() >= 1, '非终态转终态后补拉失败，轮询不能被旧的已追平标记停掉')

    timer.advance(60000)
    await settle(probe)
    const drawer = drawerOf(probe)
    deep(drawer.props.events.map(item => item.seq), [1, 2, 3, 4], '重试成功后补齐收尾事件')
    eq(drawer.props.lastSeq, 4)
    eq(timer.pending(), 0, '追平后才停止轮询')
  })
})

// 11. M3：Host 预留 lastSeq 不能当已消费游标 ------------------------------

await check('M3 Host 预留 lastSeq：since 只用已返回事件的最大 seq，不跳过未落盘事件', async () => {
  await withFakeTimers(async timer => {
    const allEvents = [
      event(1, 'activity/start', { elementId: 'T' }),
      event(2, 'activity/wait', { elementId: 'T', status: 'waiting' }),
      event(3, 'activity/end', { elementId: 'T', status: 'completed' }),
      event(4, 'process/end', { elementId: 'p' }),
    ]
    // Host 端先写 instance.lastSeq=4，再追加 3、4 两行事件（instance-store）。
    let readableMax = 2
    const queries = []
    const { client } = makeClient({
      readInstance: async id => ({ id, status: 'ACTIVE', lastSeq: 4, pendingTasks: [] }),
      readInstanceEvents: async (id, query) => {
        queries.push(query)
        const since = query && Number.isSafeInteger(query.since) ? query.since : 0
        return { id, events: allEvents.filter(item => item.seq > since && item.seq <= readableMax), lastSeq: 4 }
      },
    })
    const instance = { id: 'i-a', status: 'ACTIVE', lastSeq: 2, pendingTasks: [] }
    const mounted = await mountPage({
      client,
      props: {
        initialDefinition: definitionA,
        initialInstance: instance,
        initialInstanceDefinition: { xml: XML_A },
        initialEvents: [allEvents[0], allEvents[1]],
        initialTasks: [],
      },
    })
    const { probe, editor } = mounted
    eq(markerState(editor, 'T'), 'waiting', '初始事件应把 T 标成 waiting')

    // 第一次轮询：events 为空、只带预留 lastSeq=4。游标不能被推进到 4。
    timer.advance(2000)
    await settle(probe)
    deep(queries[0], { since: 2 })
    eq(drawerOf(probe).props.lastSeq, 2, '没有实际返回事件时，已消费游标不能跟随预留 lastSeq')
    deep(drawerOf(probe).props.events.map(item => item.seq), [1, 2], '不能凭预留 lastSeq 认为事件已经加载')

    // 3、4 落盘后：下一次请求仍必须从 2 开始，而不是 4。
    readableMax = 4
    timer.advance(2000)
    await settle(probe)
    deep(queries[1], { since: 2 }, '下一次 since 必须用实际已消费游标 2，不能用预留 lastSeq 4')
    deep(drawerOf(probe).props.events.map(item => item.seq), [1, 2, 3, 4], '未落盘事件不能被永久跳过')
    eq(markerState(editor, 'T'), 'completed', '补齐 activity/end 后 marker 必须变成 completed')
  })
})

// 12. M4：异步导入完成后不能写回旧 marker ---------------------------------

await check('M4 异步导入完成：按最新事件缓存重算 marker，旧 marker 不覆盖终态', async () => {
  await withFakeTimers(async timer => {
    const gate = deferred()
    const editor = createEditor()
    editor.importXML = async value => {
      editor.calls.importXML.push(value)
      if (value === XML_A) await gate.promise
    }
    const instance = { id: 'i-a', status: 'ACTIVE', lastSeq: 2, pendingTasks: [] }
    const { client } = makeClient({
      readInstance: async id => ({ id, status: 'COMPLETED', lastSeq: 4, pendingTasks: [] }),
      readInstanceEvents: async id => ({
        id,
        events: [
          event(3, 'activity/end', { elementId: 'T', status: 'completed' }),
          event(4, 'process/end', { elementId: 'p' }),
        ],
        lastSeq: 4,
      }),
    })
    const mounted = await mountPage({
      client,
      editor,
      props: {
        initialDefinition: definitionA,
        initialInstance: instance,
        initialInstanceDefinition: { xml: XML_A },
        initialEvents: [
          event(1, 'activity/start', { elementId: 'T' }),
          event(2, 'activity/wait', { elementId: 'T', status: 'waiting' }),
        ],
        initialTasks: [],
      },
    })
    const { probe } = mounted
    eq(editor.calls.importXML.length, 1, '首次画布导入必须已经发出（并挂起）')
    eq(markerState(editor, 'T'), '', '导入未完成前还没有写 marker')

    // 导入还没返回，轮询已经读到终态并结束。
    timer.advance(2000)
    await settle(probe)
    eq(drawerOf(probe).props.lastSeq, 4, '轮询必须已经追平终态事件')
    eq(markerState(editor, 'T'), 'completed', '事件到达后画布先显示 completed')
    eq(timer.pending(), 0, '终态已追平，轮询停止')

    // 导入这时才完成：不能拿调用时捕获的旧 view.markers 覆盖 completed。
    gate.resolve()
    await settle(probe)
    eq(dataView(probe), 'instance')
    eq(markerState(editor, 'T'), 'completed', '导入完成后必须按最新事件缓存重算 marker')
    deep(drawerOf(probe).props.events.map(item => item.seq), [1, 2, 3, 4])
  })
})

// 13. M4 交错：导入期间切走视图，迟到的导入结果不能写 marker --------------

await check('M4 交错：导入期间切到定义，迟到的导入结果不能写回 marker', async () => {
  await withFakeTimers(async () => {
    const gate = deferred()
    const editor = createEditor()
    editor.importXML = async value => {
      editor.calls.importXML.push(value)
      if (value === XML_A) await gate.promise
    }
    const { client } = makeClient({
      readDefinition: async id => (id === 'flow-b' ? definitionB : definitionA),
      readInstanceEvents: async id => ({ id, events: [], lastSeq: 0 }),
    })
    const instance = { id: 'i-a', status: 'ACTIVE', lastSeq: 0, pendingTasks: [] }
    const mounted = await mountPage({
      client,
      editor,
      props: {
        initialDefinition: definitionA,
        initialInstances: { instances: [instance] },
        initialInstance: instance,
        initialInstanceDefinition: { xml: XML_A },
        initialEvents: [],
        initialTasks: [],
      },
      // 初始导入挂起：不能等画布就绪。
    })
    const { probe } = mounted
    eq(editor.calls.importXML.length, 1, '初始实例导入挂起')

    const list = findElement(probe.tree, node => node.type === DefinitionList)
    await list.props.onOpen('flow-b')
    await settle(probe)
    eq(dataView(probe), 'definition', '已经切到定义视图')
    const markersBefore = lastMarkers(editor)
    deep(markersBefore, [], '定义视图必须清空运行态 marker')

    gate.resolve()
    await settle(probe)
    deep(lastMarkers(editor), [], '迟到的实例导入不能把旧 marker 写回定义视图')
    eq(dataView(probe), 'definition')
  })
})

// 14. M6 页面：恢复失败必须显示原因并降级画布 -----------------------------

await check('M6 页面：回滚重建失败显示原因并禁用保存，恢复后再次导入回到可用', async () => {
  await withFakeTimers(async () => {
    const editor = createEditor()
    let failing = true
    editor.importXML = async value => {
      editor.calls.importXML.push(value)
      // 初始定义正常导入；只有导入新 XML 时模拟「绘制失败 + 重建失败」。
      if (value === XML_B && failing) {
        const error = new Error('no plane to display')
        error.restoreError = new Error('rebuild constructor failed')
        throw error
      }
    }
    editor.getUnavailableReason = () => (failing ? 'rebuild constructor failed' : '')
    const mounted = await mountPage({
      client: makeClient().client,
      editor,
      props: {
        initialDefinition: definitionA,
        initialDefinitions: { definitions: [definitionA] },
      },
    })
    const { probe } = mounted
    eq(actionButton(probe.tree, 'save-definition').props.disabled, false, '初始画布可用')

    const list = findElement(probe.tree, node => node.type === DefinitionList)
    const file = { name: 'demo.bpmn', text: async () => XML_B }
    eq(await list.props.onImport(file), false, '恢复失败时导入必须返回失败')
    await settle(probe)
    const notice = findElement(probe.tree, node => node.props && node.props['data-notice-kind'] !== undefined)
    ok(textOf(notice).includes('rebuild constructor failed'), '页面必须显示恢复失败原因，不能只提示导入失败')
    ok(textOf(notice).includes('画布不可用'), '页面必须明确画布进入不可用态')
    eq(actionButton(probe.tree, 'save-definition').props.disabled, true, '画布不可用时必须禁用保存')

    // 故障解除后再次导入：编辑器已重建，页面必须回到可用态并允许保存。
    failing = false
    eq(await list.props.onImport(file), true, '恢复后再次导入必须成功')
    await settle(probe)
    const success = findElement(probe.tree, node => node.props && node.props['data-notice-kind'] !== undefined)
    eq(success.props['data-notice-kind'], 'success', '恢复后再次导入必须提示成功')
    eq(actionButton(probe.tree, 'save-definition').props.disabled, false, '恢复后保存按钮必须回到可用')
    eq(editor.getUnavailableReason(), '', '编辑器不再报告不可用')
  })
})

// 15. F1：连续选择失败必须回滚到最后一次成功提交的实例状态 -------------------

/**
 * F1 基线夹具：A 已成功提交（事件 seq=1）；B/C 的详情请求按调用顺序挂起。
 * 轮询 A 时返回 seq=2，用来验证回滚后 `since` 从 1 继续、而不是退回 0。
 */
async function mountContinuousSelectRace({ ids }) {
  const instanceA = { id: 'i-a', status: 'ACTIVE', lastSeq: 1, pendingTasks: [] }
  const pending = new Map()
  const pollQueries = []
  const detailCalls = []
  const { client } = makeClient({
    readInstance: async id => {
      detailCalls.push(id)
      if (ids.includes(id)) {
        return new Promise((resolve, reject) => {
          if (!pending.has(id)) pending.set(id, [])
          pending.get(id).push({ resolve, reject })
        })
      }
      return { id: 'i-a', status: 'ACTIVE', lastSeq: 2, pendingTasks: [] }
    },
    readInstanceDefinition: async id => ({ id, xml: id === 'i-a' ? XML_A : XML_B }),
    readInstanceTasks: async id => ({ id, tasks: [] }),
    readInstanceEvents: async (id, query) => {
      pollQueries.push({ id, query })
      if (id !== 'i-a') return { id, events: [], lastSeq: 0 }
      return { id, events: [event(2, 'activity/end', { elementId: 'T', status: 'completed' })], lastSeq: 2 }
    },
  })
  const mounted = await mountPage({
    client,
    props: {
      initialDefinition: definitionA,
      initialInstance: instanceA,
      initialInstanceDefinition: { xml: XML_A },
      initialEvents: [event(1, 'activity/wait', { elementId: 'T', status: 'waiting' })],
      initialTasks: [],
    },
  })
  return { ...mounted, instanceA, pending, pollQueries, detailCalls }
}

function pendingCall(pending, id, index = 0) {
  const list = pending.get(id) || []
  const item = list[index]
  ok(item && typeof item.reject === 'function', `${id} 的第 ${index + 1} 次详情请求必须已发出`)
  return item
}

function assertRolledBackToA(probe, editor, message) {
  const drawer = drawerOf(probe)
  eq(drawer.props.instanceId, 'i-a', `${message}：事件缓存归属必须回到 A`)
  eq(drawer.props.lastSeq, 1, `${message}：游标必须回到 A 最后成功提交的位置`)
  deep(drawer.props.events.map(item => item.seq), [1], `${message}：A 的事件不能被清空`)
  const panel = findElement(probe.tree, node => node.type === InstancePanel)
  eq(panel.props.activeInstance.id, 'i-a', `${message}：显示实例必须仍是 A`)
  eq(markerState(editor, 'T'), 'waiting', `${message}：画布 marker 必须回到 A 的状态`)
}

await check('F1 连续两次选择同一实例失败：回滚到最后成功提交的 A，轮询不退回 since=0', async () => {
  await withFakeTimers(async timer => {
    const mounted = await mountContinuousSelectRace({ ids: ['i-b'] })
    const { probe, editor, pending, pollQueries, detailCalls } = mounted
    const select = id => findElement(probe.tree, node => node.type === InstancePanel).props.onSelectInstance(id)

    // 第一次选 B：详情挂起（owner 已切到未提交的 B）。
    select('i-b')
    await settle(probe)
    // 第二次选 B：owner 已经是 B，不再触发 switched 备份；旧实现因此丢掉回滚基线。
    select('i-b')
    await settle(probe)
    eq((pending.get('i-b') || []).length, 2, '两次选择都必须各自发出详情请求')

    // 先拒绝旧世代的请求，再拒绝当前世代的请求：只有当前失败会触发回滚。
    pendingCall(pending, 'i-b', 0).reject(new Error('实例详情服务不可用'))
    await settle(probe)
    pendingCall(pending, 'i-b', 1).reject(new Error('实例详情服务不可用'))
    await settle(probe)

    assertRolledBackToA(probe, editor, '第二次选择失败后')
    const notice = findElement(probe.tree, node => node.props && node.props['data-notice-kind'] !== undefined)
    ok(textOf(notice).includes('实例详情服务不可用'), '必须显示切换失败原因')

    // 回滚后 A 的轮询必须恢复：请求 i-a?since=1（不是 0），事件 2 落地，详情被重新读取。
    timer.advance(2000)
    await settle(probe)
    const drawer = drawerOf(probe)
    deep(drawer.props.events.map(item => item.seq), [1, 2], '回滚后 A 的新事件必须继续应用')
    eq(drawer.props.lastSeq, 2, '回滚后 A 的游标必须随轮询推进')
    eq(markerState(editor, 'T'), 'completed', '回滚后 A 的新事件必须更新 marker')
    const queriesA = pollQueries.filter(item => item.id === 'i-a')
    ok(queriesA.length >= 1, '回滚后必须继续轮询 A')
    deep(queriesA[queriesA.length - 1].query, { since: 1 }, 'A 的轮询必须从最后成功提交的游标继续')
    ok(queriesA.every(item => item.query.since !== 0),
      '回滚后不能持续请求 since=0（否则 A 的事件会被永久丢弃）')
    ok(detailCalls.filter(id => id === 'i-a').length >= 1, '回滚后轮询必须重新读取 A 的详情')
    eq(timer.pending(), 1, '回滚后必须保留且只保留一个轮询定时器')
  })
})

await check('F1 连续选择不同实例失败（B 挂起后选 C）：回滚到 A，不让 B 成为基线', async () => {
  await withFakeTimers(async timer => {
    const mounted = await mountContinuousSelectRace({ ids: ['i-b', 'i-c'] })
    const { probe, editor, pending, pollQueries, detailCalls } = mounted
    const select = id => findElement(probe.tree, node => node.type === InstancePanel).props.onSelectInstance(id)

    // A → B（挂起）→ C（挂起）：旧实现会把「尚未成功打开的 B」当成回滚基线。
    select('i-b')
    await settle(probe)
    select('i-c')
    await settle(probe)
    eq((pending.get('i-b') || []).length, 1, '选择 B 必须发出详情请求')
    eq((pending.get('i-c') || []).length, 1, '选择 C 必须发出详情请求')

    // 当前世代（C）失败先回滚；随后 B 的迟到失败必须被世代检查丢掉。
    pendingCall(pending, 'i-c', 0).reject(new Error('实例 C 详情服务不可用'))
    await settle(probe)
    pendingCall(pending, 'i-b', 0).reject(new Error('实例 B 详情服务不可用'))
    await settle(probe)

    assertRolledBackToA(probe, editor, 'B→C 连续失败后')
    const notice = findElement(probe.tree, node => node.props && node.props['data-notice-kind'] !== undefined)
    ok(textOf(notice).includes('实例 C 详情服务不可用'), '必须显示当前选择（C）的失败原因')

    timer.advance(2000)
    await settle(probe)
    const drawer = drawerOf(probe)
    deep(drawer.props.events.map(item => item.seq), [1, 2], '回滚后 A 的新事件必须继续应用')
    eq(drawer.props.lastSeq, 2, '回滚后 A 的游标必须随轮询推进')
    eq(markerState(editor, 'T'), 'completed', '回滚后 A 的新事件必须更新 marker')
    const queriesA = pollQueries.filter(item => item.id === 'i-a')
    ok(queriesA.length >= 1, '回滚后必须继续轮询 A')
    deep(queriesA[queriesA.length - 1].query, { since: 1 }, 'A 的轮询必须从最后成功提交的游标继续')
    ok(queriesA.every(item => item.query.since !== 0), '回滚后不能持续请求 since=0')
    ok(detailCalls.filter(id => id === 'i-a').length >= 1, '回滚后轮询必须重新读取 A 的详情')
    eq(timer.pending(), 1, '回滚后必须保留且只保留一个轮询定时器')
  })
})

// 16. F3 页面：回滚失败后成功打开定义，必须统一恢复到 ready ------------------

await check('F3 页面：画布 error 后成功打开定义，保存按钮必须恢复可用', async () => {
  await withFakeTimers(async () => {
    const editor = createEditor()
    let failing = true
    editor.importXML = async value => {
      editor.calls.importXML.push(value)
      // 只让「导入新 XML」失败并让恢复重建也失败，页面进入待恢复的 error 态。
      if (value === XML_B && failing) {
        const error = new Error('draw failed')
        error.restoreError = new Error('rebuild failed')
        throw error
      }
    }
    editor.getUnavailableReason = () => (failing ? 'rebuild failed' : '')
    const mounted = await mountPage({
      client: makeClient().client,
      editor,
      props: {
        initialDefinition: definitionA,
        initialDefinitions: { definitions: [definitionA] },
      },
    })
    const { probe } = mounted
    eq(actionButton(probe.tree, 'save-definition').props.disabled, false, '初始画布可用')

    const list = findElement(probe.tree, node => node.type === DefinitionList)
    const file = { name: 'broken.bpmn', text: async () => XML_B }
    eq(await list.props.onImport(file), false, '恢复失败时导入必须返回失败')
    await settle(probe)
    eq(actionButton(probe.tree, 'save-definition').props.disabled, true, '回滚失败后保存必须被禁用')

    // 故障解除后打开已有定义成功：applyCanvasView 成功必须把 canvasStatus 统一恢复 ready。
    failing = false
    eq(await findElement(probe.tree, node => node.type === DefinitionList).props.onOpen('flow-a'), true,
      '故障解除后打开已有定义必须成功')
    await settle(probe)
    eq(editor.getUnavailableReason(), '', '编辑器不再报告不可用')
    eq(actionButton(probe.tree, 'save-definition').props.disabled, false,
      '成功的画布恢复入口必须把页面一起恢复 ready（保存按钮重新可用）')
  })
})

// 17. F2 页面：编辑器支持 applyView 时必须原子提交并传递视图世代 -------------

await check('F2 页面：优先用 editor.applyView({ viewer, xml, token }) 原子提交视图', async () => {
  await withFakeTimers(async () => {
    const editor = createEditor()
    const applied = []
    editor.applyView = async options => {
      applied.push({ ...options })
      return { ok: true, mode: options.viewer ? 'viewer' : 'modeler' }
    }
    const mounted = await mountPage({
      client: makeClient().client,
      editor,
      props: {
        initialDefinition: definitionA,
        initialDefinitions: { definitions: [definitionA] },
      },
    })
    const { probe } = mounted
    eq(applied.length, 1, '初始视图必须走一次原子提交')
    eq(applied[0].viewer, false, '定义视图必须提交 viewer=false')
    eq(applied[0].xml, XML_A, '原子提交必须带上定义 XML')
    eq(applied[0].token, 1, 'token 必须是首次视图世代')
    eq(editor.calls.importXML.length, 0, '走 applyView 时不能再额外调用裸 importXML')
    eq(editor.calls.viewer.length, 0, '走 applyView 时不能再额外调用裸 setViewerMode')

    const list = findElement(probe.tree, node => node.type === DefinitionList)
    await list.props.onOpen('flow-a')
    await settle(probe)
    eq(applied.length, 2, '打开定义必须再次原子提交')
    ok(applied[1].token > applied[0].token, '视图世代必须递增：过期导入才能被编辑器丢弃')
    eq(applied[1].xml, XML_A)
  })
})

// 18. m1：真实渲染画布壳的接线与卸载 --------------------------------------

await check('m1 真实渲染 BpmnCanvas：mountOptions 透传 / hostRequire 合并 / 卸载销毁', async () => {
  await withFakeTimers(async () => {
    const mounted = await mountPage({
      client: makeClient().client,
      props: {
        initialDefinition: definitionA,
        initialDefinitions: { definitions: [definitionA] },
      },
    })
    const { captured, editor, probe } = mounted
    eq(typeof captured.options.onChange, 'function',
      '真实 BpmnCanvas 必须把页面 mountOptions.onChange 透传给 chunk.mountEditor')
    ok(captured.options.hostRequire && typeof captured.options.hostRequire.async === 'function',
      'BpmnCanvas 必须把宿主 require 合并进 mountOptions')
    ok(captured.container !== undefined && captured.container !== null,
      'mountEditor 必须收到已挂载的容器（ref 已赋值）')
    eq(editor.calls.destroy, 0, '挂载期间不能销毁编辑器')

    probe.unmount()
    await settle(probe)
    eq(editor.calls.destroy, 1, '真实 BpmnCanvas 卸载必须调用编辑器 destroy')
  })
})

if (failures.length > 0) {
  console.log(`\n${checks} 组通过，${failures.length} 组失败（${assertions} 条断言）`)
  process.exitCode = 1
} else {
  console.log(`\n${checks} 组通过（${assertions} 条断言）`)
}
