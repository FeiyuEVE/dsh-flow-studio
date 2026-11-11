#!/usr/bin/env node
/**
 * 客户端性能回归（0.13.3 步骤 5）：画布变更 / 保存 / 运行态标记。
 *
 * 不挂 DOM：直接 import 纯逻辑模块（bpmn-state / definition-state / page 的纯函数），
 * 断言的是可失败的硬条件：
 *  - 拖动过程中（连续 command 变更）**不序列化 XML**；
 *  - 命令完成后按去抖窗只落一次；
 *  - 一直不停手时 maxWait 强制落一次；
 *  - 两次保存乱序返回时，旧结果不能覆盖新结果；
 *  - 运行态 marker 只调 `setRuntimeState`，不产生修订号、不触发草稿保存；
 *  - 保存前等待属性面板里 contenteditable 的去抖提交。
 *
 * 运行：node test/client-perf.test.mjs
 */

import assert from 'node:assert/strict'

import {
  createEditRevision, createSaveQueue,
} from '../src/client/bpmn-state.js'
import { createDefinitionState } from '../src/client/definition-state.js'
import {
  commitPendingProperties, runtimeMarkersFromEvents, syncRuntimeMarkers,
} from '../src/client/page.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log('  ✓ ' + name)
}

function checkAsync(name, fn) {
  return fn().then(() => {
    checks += 1
    console.log('  ✓ ' + name)
  })
}

/** 假定时器：可推进时间、按到期顺序触发。 */
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

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 与 page.js 的草稿队列同形：保存 = 序列化 XML（计数）。 */
function makeCanvasPipeline({ serialize } = {}) {
  const timer = fakeTimer()
  const revisions = createEditRevision()
  const serialized = []
  const queue = createSaveQueue({
    debounceMs: 120,
    maxWaitMs: 400,
    // 同步保存：断言「序列化次数」不依赖微任务时序（真实的 saveXML 是异步的，
    // 但队列语义相同；异步与乱序路径在下面单独测）。
    save: snapshot => {
      const xml = serialize ? serialize(snapshot) : '<xml>' + snapshot.revision + '</xml>'
      serialized.push({ revision: snapshot.revision, xml })
      return { xml }
    },
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
  })
  return {
    timer,
    revisions,
    queue,
    serialized,
    change() {
      revisions.markChanged()
      queue.schedule({ revision: revisions.revision })
    },
  }
}

console.log('client perf (bpmn)')

check('拖动过程不序列化：连续 command 变更期间 saveXML 调用 0 次，停下后只落 1 次', () => {
  let serializeCalls = 0
  const pipeline = makeCanvasPipeline({
    serialize: () => {
      serializeCalls += 1
      return '<xml/>'
    },
  })
  // 10 次变更（拖动中的 elements.move 命令），总时长 200ms < maxWait 400ms，
  // 每次间隔 20ms < 去抖窗 120ms。
  for (let i = 0; i < 10; i += 1) {
    pipeline.change()
    pipeline.timer.advance(20)
  }
  assert.equal(serializeCalls, 0, '拖动过程中不能序列化整图')
  assert.equal(pipeline.queue.pending() !== null, true, '仍有一份待写快照')
  pipeline.timer.advance(120)
  assert.equal(serializeCalls, 1, '命令完成、去抖到期后只序列化一次')
  assert.equal(pipeline.serialized[0].revision, 10, '落盘的是最新修订号')
})

check('命令完成后去抖：两次命令之间超过去抖窗会各落一次，窗内只落最后一次', () => {
  const pipeline = makeCanvasPipeline()
  pipeline.change()
  pipeline.timer.advance(50)
  pipeline.change()
  pipeline.timer.advance(50)
  pipeline.change()
  assert.equal(pipeline.serialized.length, 0, '窗内不能提前落盘')
  pipeline.timer.advance(120)
  assert.equal(pipeline.serialized.length, 1, '三次命令在同一个去抖窗 → 一次落盘')
  assert.equal(pipeline.serialized[0].revision, 3)

  // 新命令另起一个窗 → 第二次落盘。
  pipeline.change()
  pipeline.timer.advance(120)
  assert.equal(pipeline.serialized.length, 2)
  assert.equal(pipeline.serialized[1].revision, 4)
})

check('一直不停手：maxWait 到点强制落一次，后续继续去抖', () => {
  const pipeline = makeCanvasPipeline()
  for (let i = 0; i < 30; i += 1) {
    pipeline.change()
    pipeline.timer.advance(20) // 600ms 连续输入，去抖窗一直被重置
  }
  assert.ok(pipeline.timer.now() >= 400)
  assert.equal(pipeline.serialized.length, 1, 'maxWait 强制落 1 次')
})

await checkAsync('乱序响应：旧请求晚到返回 stale，不覆盖最新结果 / 不清新修订的 dirty', async () => {
  const first = deferred()
  const second = deferred()
  let calls = 0
  const timer = fakeTimer()
  const saved = []
  const queue = createSaveQueue({
    debounceMs: 0,
    maxWaitMs: 10,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    save: async () => {
      calls += 1
      return calls === 1 ? first.promise : second.promise
    },
    onSaved: (result, snapshot) => saved.push({ result, revision: snapshot.revision }),
  })
  queue.schedule({ revision: 1 })
  const one = queue.flush()
  queue.schedule({ revision: 2 })
  const two = queue.flush()
  assert.equal(calls, 2, '两次 flush 各发一个请求')

  // 新请求先返回：只有它算数。
  second.resolve({ version: 2 })
  const resultTwo = await two
  assert.equal(resultTwo.ok, true)
  assert.equal(resultTwo.stale, false)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].revision, 2, '最新请求的结果被采纳')

  // 旧请求晚到：stale=true，onSaved 不再触发，也不写 lastResult。
  first.resolve({ version: 1 })
  const resultOne = await one
  assert.equal(resultOne.ok, true)
  assert.equal(resultOne.stale, true, '旧请求必须标记 stale')
  assert.equal(saved.length, 1, '旧结果不能再触发 onSaved')
  assert.equal(queue.lastResult.version, 2, 'lastResult 保持最新结果')

  // 修订号：保存只清提交时那一版；提交后继续改仍然 dirty。
  const revisions = createEditRevision()
  revisions.markChanged()
  revisions.markChanged()
  const submitted = revisions.revision
  revisions.markChanged()
  revisions.markSaved(submitted)
  assert.equal(revisions.isDirty(), true, '保存后继续编辑仍 dirty')
  assert.equal(revisions.savedRevision, submitted, '只推进到提交时的修订号')
  revisions.markSaved(revisions.revision)
  assert.equal(revisions.isDirty(), false)

  // 定义状态：保存结果属于另一份定义时不钉版本、不动 dirty。
  const state = createDefinitionState({ id: 'flow-a', version: 1, name: 'A' })
  state.markDirty()
  const pinned = state.pinSaved({ id: 'flow-b', version: 9 })
  assert.equal(pinned.pinned, false, '另一份定义的保存结果不能钉到当前定义')
  assert.equal(state.version, 1)
  assert.equal(state.dirty, true)
})

check('运行态标记不触发保存：只调 setRuntimeState，不动修订号 / 草稿队列', () => {
  const markers = runtimeMarkersFromEvents([
    { type: 'activity/start', seq: 1, elementId: 'Human_1', activityId: 'act-1' },
    { type: 'activity/wait', seq: 2, elementId: 'Human_1', activityId: 'act-1' },
    { type: 'activity/end', seq: 3, elementId: 'Agent_1', activityId: 'act-2', status: 'completed' },
    { type: 'error', seq: 4, elementId: 'Agent_2', error: { code: 'X', message: 'boom' } },
    { type: 'custom/unknown', seq: 5, elementId: 'Human_1' },
    // 只有 activityId、没有 elementId：不能变成 marker。
    { type: 'activity/start', seq: 6, activityId: 'orphan-act' },
  ])
  assert.deepEqual(
    markers.slice().sort((left, right) => left.elementId.localeCompare(right.elementId)),
    [
      { elementId: 'Agent_1', state: 'completed' },
      { elementId: 'Agent_2', state: 'failed' },
      { elementId: 'Human_1', state: 'waiting' },
    ],
    'marker 只来自 elementId；activityId 不参与',
  )

  const calls = []
  const revisions = createEditRevision()
  revisions.markChanged()
  const before = revisions.revision
  const draftSchedules = []
  const fakeEditor = {
    setRuntimeState(list) { calls.push(list) },
  }
  const count = syncRuntimeMarkers(fakeEditor, markers)
  assert.equal(count, 3)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], markers)
  assert.equal(revisions.revision, before, 'marker 不递增编辑修订号')
  assert.equal(draftSchedules.length, 0, 'marker 不调度草稿保存')
  assert.equal(syncRuntimeMarkers(null, markers), 0, '画布未就绪时安全返回')
  assert.equal(syncRuntimeMarkers({}, markers), 0, '控制器缺 setRuntimeState 时安全返回')
})

await checkAsync('保存前等待属性输入：文本 blur 同步提交；contenteditable 等去抖窗', async () => {
  const delays = []
  const blurCalls = []
  const makeEditor = field => ({
    getContainer: () => ({
      querySelector: () => field,
    }),
  })
  const textField = { isContentEditable: false, blur: () => blurCalls.push('text') }
  const textResult = await commitPendingProperties(makeEditor(textField), {
    waitMs: 650,
    delay: async ms => { delays.push(ms) },
  })
  assert.equal(textResult.waited, false, '文本输入 blur 已同步提交，无需等待')
  assert.deepEqual(blurCalls, ['text'])
  assert.deepEqual(delays, [], '不能无谓等待 650ms')

  const richField = { isContentEditable: true, getAttribute: () => 'true', blur: () => blurCalls.push('rich') }
  const richResult = await commitPendingProperties(makeEditor(richField), {
    waitMs: 650,
    delay: async ms => { delays.push(ms) },
  })
  assert.equal(richResult.waited, true)
  assert.equal(richResult.waitedMs, 650)
  assert.deepEqual(delays, [650], 'contenteditable 必须等官方 600ms 去抖')
  assert.deepEqual(blurCalls, ['text', 'rich'])

  const noFocus = await commitPendingProperties(makeEditor(null), { delay: async () => {} })
  assert.equal(noFocus.waited, false)
  const noEditor = await commitPendingProperties(null, { delay: async () => {} })
  assert.equal(noEditor.waited, false, '没有画布时安全返回')
})

console.log(`\n${checks} 组通过`)
