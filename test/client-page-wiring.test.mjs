#!/usr/bin/env node
/**
 * 页面级接线与实例视图竞态回归（0.13.3 审查修复）。
 *
 * 用最小的 React hooks 探针渲染**真实** `FlowStudioPage`：
 * - `createElement` 用真实 React，只把 `useState / useRef / useMemo / useCallback /
 *   useEffect` 换成可观测的同步实现（不挂 DOM、不引入 jsdom）；
 * - 画布走 `BpmnCanvas` 的真实 props：从 `props.mountOptions.onChange` 触发变更，
 *   等价于真实 chunk 在 `commandStack.changed` 时回调页面；
 * - `onReady(chunk, editor)` 用假编辑器，模拟 chunk 加载完成后的接线。
 *
 * 覆盖：
 *  1. BLOCKER：画布变更没有接到页面（dirty / 运行门禁 / 本地草稿）；
 *  2. MAJOR：统一的视图选择世代，迟到的实例响应不能覆盖后选的定览；
 *  3. MAJOR：切实例先清空事件与游标，事件请求失败不回退到上一个实例；
 *  4. MAJOR：读到终态停轮询前先追平 `detail.lastSeq`（打开实例 / 轮询两条路径）；
 *  5. MINOR：完成人工待办 404/409 刷新后仍保留服务端原因。
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
 * 最小 React hooks 探针
 *
 * 每个探针一份 hooks 数组；hooks 顺序与真实 React 一致（页面无条件调用 hooks）。
 * effect 在 render 提交后同步执行，deps 用 Object.is 逐项比较；卸载时按声明顺序
 * 执行 cleanup。异步链路由 settle() 反复「渲染 + 让出事件循环」推进。
 * ---------------------------------------------------------------------------
 */
let activeProbe = null

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
  const hooks = []
  let hookIndex = 0
  let pendingEffects = []

  const probe = {
    tree: null,
    pending: true,
    mounted: true,
    useState(initial) {
      const index = hookIndex++
      if (!hooks[index]) {
        const value = typeof initial === 'function' ? initial() : initial
        hooks[index] = { kind: 'state', value }
      }
      const hook = hooks[index]
      const setState = next => {
        if (!probe.mounted) return
        const value = typeof next === 'function' ? next(hook.value) : next
        if (Object.is(value, hook.value)) return
        hook.value = value
        probe.pending = true
      }
      return [hook.value, setState]
    },
    useRef(initial) {
      const index = hookIndex++
      if (!hooks[index]) hooks[index] = { kind: 'ref', current: initial }
      return hooks[index]
    },
    useMemo(factory, deps) {
      const index = hookIndex++
      const hook = hooks[index]
      if (hook && sameDeps(hook.deps, deps)) return hook.value
      hooks[index] = { kind: 'memo', value: factory(), deps: Array.isArray(deps) ? deps.slice() : null }
      return hooks[index].value
    },
    useCallback(fn, deps) {
      const index = hookIndex++
      const hook = hooks[index]
      if (hook && sameDeps(hook.deps, deps)) return hook.value
      hooks[index] = { kind: 'callback', value: fn, deps: Array.isArray(deps) ? deps.slice() : null }
      return fn
    },
    useEffect(fn, deps) {
      const index = hookIndex++
      pendingEffects.push({ index, fn, deps: Array.isArray(deps) ? deps.slice() : null })
    },
  }

  const commitEffects = () => {
    const effects = pendingEffects
    pendingEffects = []
    for (const effect of effects) {
      const previous = hooks[effect.index]
      // deps 为 undefined 时每次渲染都跑；[] 只跑一次。
      if (previous && effect.deps !== null && sameDeps(previous.deps, effect.deps)) continue
      if (previous && typeof previous.cleanup === 'function') previous.cleanup()
      const hook = previous || {}
      hook.deps = effect.deps
      hooks[effect.index] = hook
      const cleanup = effect.fn()
      hook.cleanup = typeof cleanup === 'function' ? cleanup : null
    }
  }

  const render = () => {
    hookIndex = 0
    pendingEffects = []
    activeProbe = probe
    try {
      probe.tree = Component(props)
    } finally {
      activeProbe = null
    }
    probe.pending = false
    commitEffects()
  }

  probe.mount = () => { probe.pending = true }
  probe.flush = () => {
    let guard = 0
    while (probe.pending && guard < 50) {
      guard += 1
      render()
    }
  }
  probe.unmount = () => {
    probe.mounted = false
    for (const hook of hooks) {
      if (hook && typeof hook.cleanup === 'function') {
        hook.cleanup()
        hook.cleanup = null
      }
    }
  }
  return probe
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

// ── 元素树工具（不渲染子组件，只读页面交出去的 props）────────────────────

function walkElements(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    for (const child of node) walkElements(child, visit)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') return
  if (typeof node !== 'object') return
  visit(node)
  if (node.props) walkElements(node.props.children, visit)
}

function findElement(tree, predicate) {
  let found = null
  walkElements(tree, node => {
    if (found === null && predicate(node)) found = node
  })
  return found
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && node.props) return textOf(node.props.children)
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
  const calls = { importXML: [], viewer: [], markers: [], saveXML: 0 }
  return {
    calls,
    ready: Promise.resolve({ ok: true }),
    getContainer: () => ({ querySelector: () => null }),
    getModeler: () => ({ get: () => null }),
    importXML: async value => { calls.importXML.push(value) },
    saveXML: async () => { calls.saveXML += 1; return saveXml },
    setViewerMode: async value => { calls.viewer.push(value) },
    setRuntimeState: list => { calls.markers.push(list) },
    destroy: () => {},
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
 * 挂载真实页面，并按 BpmnCanvas 的真实协议把画布「接起来」：
 * chunk.mountEditor(container, mountOptions) 捕获页面传下来的 onChange，
 * 再调用 onReady(chunk, editor) 把编辑器交给页面。
 */
async function mountPage({ client, props = {}, saveXml }) {
  const definitionId = props.initialDefinition && props.initialDefinition.id
  if (definitionId) clearDraft(definitionId)
  const probe = createProbe(FlowStudioPage, { apiClient: client, ...props })
  probe.mount()
  await settle(probe)
  const canvas = findCanvas(probe)
  ok(canvas !== null, '页面必须渲染 BpmnCanvas 壳')

  const editor = createEditor(saveXml)
  const captured = {}
  const chunk = {
    version: 'probe-1',
    mountEditor(container, options) {
      captured.options = options || {}
      return editor
    },
  }
  // BpmnCanvas 会追加 hostRequire；这里模拟同样的合并顺序。
  const mounted = chunk.mountEditor({}, { ...(canvas.props.mountOptions || {}) })
  await canvas.props.onReady(chunk, mounted)
  await settle(probe)
  return { probe, editor, captured, chunk }
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

// 3. 卸载时草稿 flush / 定时器清理 ----------------------------------------

await check('BLOCKER-1 草稿去抖：卸载时 flush 落盘一次，并清掉定时器', async () => {
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

    const drawer = findElement(probe.tree, node => node.type === InstanceEventDrawer)
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
    const drawer = findElement(probe.tree, node => node.type === InstanceEventDrawer)
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
    const drawer = findElement(probe.tree, node => node.type === InstanceEventDrawer)
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

if (failures.length > 0) {
  console.log(`\n${checks} 组通过，${failures.length} 组失败（${assertions} 条断言）`)
  process.exitCode = 1
} else {
  console.log(`\n${checks} 组通过（${assertions} 条断言）`)
}
