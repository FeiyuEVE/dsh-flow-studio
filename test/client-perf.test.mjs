#!/usr/bin/env node
/**
 * 客户端性能回归：拖拽提交、节点 memo / props 引用稳定、草稿去抖。
 *
 * 不挂 DOM：React Flow 需要真实 DOM 度量，所以这里直接用导出的纯逻辑
 * （createDragHandlers / createNodeDecorator / createDraftScheduler）证明行为，
 * 断言的是「拖动中 0 次提交、松手 1 次」「去抖窗内 5 次变更只写 1 次」这类可失败的条件。
 *
 * 运行：node test/client-perf.test.mjs
 */

import assert from 'node:assert/strict'

import React from 'react'

import { bindReact } from '../src/client/runtime.js'

// canvas.js 的 memo 包装在首次渲染时读 rt.React，必须先注入。
bindReact(React)

const {
  createDragHandlers, createNodeDecorator, flowComponentTypes,
  studioNextEdgeType, studioNodeType, studioRejectEdgeType,
} = await import('../src/client/canvas.js')
const {
  DRAFT_DEBOUNCE_MS, DRAFT_MAX_WAIT_MS, createDraftScheduler, createDraftStore,
} = await import('../src/client/drafts.js')
const model = await import('../src/model.js')

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log('  ✓ ' + name)
}

/** 假定时器：可推进时间、按到期顺序触发，用来断言写盘次数而不是等真实 600ms。 */
function fakeTimer() {
  let now = 0
  let seq = 0
  const queue = new Map()
  return {
    now: () => now,
    pending: () => queue.size,
    setTimeout(fn, ms) {
      const id = ++seq
      queue.set(id, { at: now + Math.max(0, Number(ms) || 0), fn })
      return id
    },
    clearTimeout(id) {
      queue.delete(id)
    },
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
  }
}

/** 假 storage：与 localStorage 同形，并数 setItem 次数。 */
function fakeStorage() {
  const data = new Map()
  let writes = 0
  return {
    get writes() { return writes },
    setItem(key, value) {
      data.set(String(key), String(value))
      writes += 1
    },
    getItem(key) {
      return data.has(String(key)) ? data.get(String(key)) : null
    },
    removeItem(key) {
      data.delete(String(key))
    },
  }
}

function makeDraftScheduler() {
  const timer = fakeTimer()
  const storage = fakeStorage()
  const store = createDraftStore(storage)
  const scheduler = createDraftScheduler({
    write: flow => store.write(flow),
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
  })
  return { timer, storage, store, scheduler }
}

/** 0.13.3：草稿是 XML 形状，不再携带整份 JSON flow。 */
function makeDraft(definitionId, text = '初始') {
  return {
    definitionId,
    baseVersion: 1,
    baseHash: 'hash-v1',
    xml: `<xml>${text}</xml>`,
  }
}

console.log('client perf')

// ── 缺陷 7：拖拽只在松手时提交一次 ──────────────────────────────────────
check('拖拽：拖动中 0 次提交，onNodeDragStop 恰好提交 1 次最终位置', () => {
  const commits = []
  const handlers = createDragHandlers({
    onMoveNode: (id, x, y) => commits.push({ id, x, y }),
  })
  for (const x of [120, 128, 141, 160]) {
    handlers.onNodeDrag({}, { id: 'n_req', position: { x, y: 220 } })
  }
  assert.equal(commits.length, 0, '拖动中不能把每帧位置提交进顶层 flow')
  handlers.onNodeDragStop({}, { id: 'n_req', position: { x: 199.6, y: 223.2 } })
  assert.equal(commits.length, 1, '松手必须且只能提交一次')
  assert.deepEqual(commits[0], { id: 'n_req', x: 200, y: 223 }, '提交的是取整后的最终位置')
})

check('拖拽：运行中锁定后松手也不提交；解锁后恢复提交', () => {
  let locked = true
  const commits = []
  const handlers = createDragHandlers({
    isLocked: () => locked,
    onMoveNode: (id, x, y) => commits.push([id, x, y]),
  })
  handlers.onNodeDrag({}, { id: 'n_dev', position: { x: 10, y: 20 } })
  handlers.onNodeDragStop({}, { id: 'n_dev', position: { x: 40, y: 80 } })
  assert.equal(commits.length, 0, '锁结构时拖拽落位不能写回 flow')
  locked = false
  handlers.onNodeDragStop({}, { id: 'n_dev', position: { x: 40, y: 80 } })
  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0], ['n_dev', 40, 80])
})

// ── 缺陷 7：节点 / 边 memo 与 props 引用稳定 ────────────────────────────
check('节点与两种边组件都是 React.memo 包装，组件表引用稳定', () => {
  const memoTag = Symbol.for('react.memo')
  assert.equal(studioNodeType().$$typeof, memoTag, 'StudioNode 必须 memo 包装')
  assert.equal(studioNextEdgeType().$$typeof, memoTag, 'next 边必须 memo 包装')
  assert.equal(studioRejectEdgeType().$$typeof, memoTag, 'reject 边必须 memo 包装')
  const types = flowComponentTypes()
  assert.equal(types.nodeTypes.studio, studioNodeType(), 'nodeTypes 必须复用同一个组件引用')
  assert.equal(types.edgeTypes.studioNext, studioNextEdgeType())
  assert.equal(types.edgeTypes.studioReject, studioRejectEdgeType())
  assert.equal(flowComponentTypes(), types, '每次 render 不能新建一份组件映射')
})

check('节点 props 引用稳定：未变化的节点复用同一个 React Flow 节点对象', () => {
  const state = {
    nodeStates: null,
    selection: { kind: 'node', id: 'n_req' },
    locked: false,
    linkState: null,
  }
  const decorate = createNodeDecorator({
    readState: () => state,
    actions: { select() {}, openInspector() {}, deleteNode() {}, addDownstream() {} },
  })
  const flow = model.defaultFlow()
  const req = flow.nodes.find(node => node.id === 'n_req')
  const dev = flow.nodes.find(node => node.id === 'n_dev')
  const plan = flow.nodes.find(node => node.id === 'n_plan')

  const firstReq = decorate(req)
  assert.equal(firstReq.selected, true)
  const first = decorate(plan)
  assert.equal(decorate(plan), first, '输入没变时必须复用同一个对象，memo 才不会被新 data 击穿')

  state.selection = { kind: 'node', id: 'n_dev' }
  assert.equal(decorate(plan), first, '选中别的节点不应重建本节点的 data')
  assert.notEqual(decorate(req), firstReq, '被取消选中的节点必须重建')
  assert.equal(decorate(req).selected, false)

  const renamed = decorate({ ...req, title: '需求分析（改名）' })
  assert.notEqual(renamed, first, '节点内容变了必须重建')
  assert.equal(renamed.data.node.title, '需求分析（改名）')

  state.nodeStates = { [plan.id]: { state: 'running', label: '运行中' } }
  assert.notEqual(decorate(plan), first, '运行状态变了必须重建')

  decorate.prune(new Set([req.id]))
  assert.equal(decorate(dev).id, dev.id)
})

// ── 缺陷 8：草稿写盘去抖 / maxWait / flush ──────────────────────────────
check('草稿去抖：一个去抖窗内连续 5 次变更只写 1 次 localStorage', () => {
  const { timer, storage, store, scheduler } = makeDraftScheduler()
  const draft = makeDraft('def-debounce')

  for (let i = 0; i < 5; i += 1) {
    draft.xml = `<xml>第 ${i} 个字</xml>`
    assert.equal(scheduler.schedule(draft), true)
    timer.advance(100)
  }
  assert.equal(storage.writes, 0, '去抖窗内不能写盘')
  timer.advance(DRAFT_DEBOUNCE_MS)
  assert.equal(storage.writes, 1, '5 次变更只应写最后一次')
  assert.equal(store.read('def-debounce').xml, '<xml>第 4 个字</xml>')
  assert.equal(timer.pending(), 0, '写完后不能留下定时器')
})

check('草稿去抖：一直不停手也会在 maxWait 内强制落一次盘', () => {
  const { timer, storage, scheduler } = makeDraftScheduler()
  const draft = makeDraft('def-maxwait')

  // 每 100ms 敲一下、持续 3s：去抖窗永远被重置，只有 maxWait（2s）能落盘。
  for (let i = 0; i < 30; i += 1) {
    draft.xml = `<xml>连续输入 ${i}</xml>`
    scheduler.schedule(draft)
    timer.advance(100)
  }
  assert.ok(timer.now() >= DRAFT_MAX_WAIT_MS)
  assert.equal(storage.writes, 1, '3s 连续输入应恰好被 maxWait 强制写 1 次')
})

check('页面隐藏 / 卸载：flush 立即写最后一次，不等去抖，且旧定时器不再写', () => {
  const { timer, storage, store, scheduler } = makeDraftScheduler()
  const draft = makeDraft('def-flush')

  draft.xml = '<xml>第一个字</xml>'
  scheduler.schedule(draft)
  timer.advance(200)
  draft.xml = '<xml>最后一个字</xml>'
  scheduler.schedule(draft)
  assert.equal(storage.writes, 0)

  // 相当于 visibilitychange → hidden / 组件卸载。
  const record = scheduler.flush()
  assert.equal(storage.writes, 1, '隐藏时必须立即 flush')
  assert.equal(record.xml, '<xml>最后一个字</xml>')
  assert.equal(store.read('def-flush').xml, '<xml>最后一个字</xml>')
  assert.equal(timer.pending(), 0, 'flush 后不得留下定时器')

  timer.advance(10000)
  assert.equal(storage.writes, 1, 'flush 后旧定时器不得二次写盘')
})

check('草稿调度：保存成功可 cancel，待写内容不会再落盘', () => {
  const { timer, storage, scheduler } = makeDraftScheduler()
  const draft = makeDraft('def-cancel', '待写')
  scheduler.schedule(draft)
  assert.equal(scheduler.cancel('def-cancel'), true)
  timer.advance(5000)
  assert.equal(storage.writes, 0, 'cancel 后不能再写盘')
  assert.equal(scheduler.pending(), null)
})

console.log(`\n${checks} 组通过`)
