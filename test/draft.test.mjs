#!/usr/bin/env node
/**
 * 本地 XML 草稿自检（0.13.3）：键名、{definitionId, baseVersion, baseHash, xml,
 * savedAt} 形状、旧 JSON flow 草稿拒绝、去抖 / maxWait / flush、写盘失败保留待写、
 * 恢复与卸载。
 *
 * 不需要浏览器：直接 `node test/draft.test.mjs`。
 */

import assert from 'node:assert/strict'

import {
  DRAFT_DEBOUNCE_MS, DRAFT_MAX_WAIT_MS, clearDraft, createDraftScheduler, createDraftStore,
  detectStorage, draftDiffers, draftKey, normalizeDraft, readDraft, writeDraft,
} from '../src/client/drafts.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

/** 内存版 localStorage，行为与浏览器 Storage 的最小交集一致。 */
function fakeStorage() {
  const map = new Map()
  let writes = 0
  return {
    map,
    get writes() { return writes },
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); writes += 1 },
    removeItem: key => { map.delete(key) },
  }
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

function xmlFor(name) {
  return `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process id="p-${name}" name="${name}"/></bpmn:definitions>`
}

function makeDraft(id = 'def-draft') {
  return {
    definitionId: id,
    baseVersion: 2,
    baseHash: 'hash-v2',
    xml: xmlFor(id),
  }
}

/** 草稿调度器 + 假 timer + 假 storage + 真实草稿仓库。 */
function makeScheduler(options = {}) {
  const timer = fakeTimer()
  const storage = fakeStorage()
  const store = createDraftStore(storage)
  const scheduler = createDraftScheduler({
    write: draft => store.write(draft),
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    ...options,
  })
  return { timer, storage, store, scheduler }
}

console.log('drafts.js')

check('键名是新的 flow-studio:bpmn-draft:<definitionId>', () => {
  assert.equal(draftKey('abc'), 'flow-studio:bpmn-draft:abc')
  assert.notEqual(draftKey('abc'), 'flow-studio:draft:abc', '不能复用旧 JSON flow 草稿的键')
})

check('写入后能读回完整 XML 草稿形状与 baseVersion / baseHash', () => {
  const storage = fakeStorage()
  const store = createDraftStore(storage)
  const record = store.write(makeDraft(), { savedAt: '2026-11-11T10:00:00.000Z' })
  assert.deepEqual(record, {
    definitionId: 'def-draft',
    baseVersion: 2,
    baseHash: 'hash-v2',
    xml: xmlFor('def-draft'),
    savedAt: '2026-11-11T10:00:00.000Z',
  })
  assert.ok(storage.map.has(draftKey('def-draft')), '必须真的落到 storage 里')
  assert.equal('flow' in JSON.parse(storage.map.get(draftKey('def-draft'))), false, '不再写旧 flow 字段')

  const reopened = createDraftStore(storage)
  const reread = reopened.read('def-draft')
  assert.deepEqual(reread, record)
})

check('旧 JSON flow 草稿一律读成 null（不迁移、不猜测）', () => {
  const storage = fakeStorage()
  const oldFlow = { id: 'def-old', name: '旧流程', nodes: [], edges: [] }
  storage.map.set(draftKey('def-old'), JSON.stringify({
    flow: oldFlow,
    savedAt: '2026-01-01T00:00:00.000Z',
    baseSavedAt: '2026-01-01T00:00:00.000Z',
  }))
  // 旧键名也不读。
  storage.map.set('flow-studio:draft:def-old', JSON.stringify({ flow: oldFlow }))
  const store = createDraftStore(storage)
  assert.equal(store.read('def-old'), null)
  assert.equal(normalizeDraft({ flow: oldFlow }), null)
  assert.equal(normalizeDraft({ definitionId: 'x', xml: '' }), null, '空 XML 不算草稿')
})

check('localStorage 不可用时退化为内存草稿且不抛错', () => {
  const store = createDraftStore(null)
  assert.equal(store.read('def-memory'), null)
  const record = store.write(makeDraft('def-memory'))
  assert.equal(record.definitionId, 'def-memory')
  assert.equal(store.read('def-memory').xml, xmlFor('def-memory'))
  store.clear('def-memory')
  assert.equal(store.read('def-memory'), null)
})

check('storage 抛异常（隐私模式/配额满）时仍然保住内存副本', () => {
  const throwing = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('quota') },
    removeItem() { throw new Error('denied') },
  }
  const store = createDraftStore(throwing)
  store.write(makeDraft('def-throw'), { savedAt: '2026-11-11T00:00:00.000Z' })
  const record = store.read('def-throw')
  assert.ok(record, '写不进 storage 也不能丢内存副本')
  assert.equal(record.baseHash, 'hash-v2')
  store.clear('def-throw')
  assert.equal(store.read('def-throw'), null)
})

check('坏 JSON 的草稿读成 null，不影响打开定义', () => {
  const storage = fakeStorage()
  storage.map.set(draftKey('def-bad'), '{ this is not json')
  const store = createDraftStore(storage)
  assert.equal(store.read('def-bad'), null)
})

check('draftDiffers：XML 内容相同不打扰，baseHash 用于只有服务器 hash 的场景', () => {
  const record = { ...makeDraft('def-diff'), baseHash: 'hash-v2' }
  assert.equal(draftDiffers(record, xmlFor('def-diff')), false, '内容相同 → 不提示')
  assert.equal(draftDiffers(record, { hash: 'hash-v2' }), false, 'baseHash 相同 → 不提示')
  assert.equal(draftDiffers(record, { hash: 'hash-v3' }), true, '服务器已有新版本 → 提示')
  assert.equal(draftDiffers(record, { xml: xmlFor('def-diff') + '\n' }), false, '换行差异不算改动')
  assert.equal(draftDiffers(record, { xml: xmlFor('def-diff').replace('name="def-diff"', 'name="改过"') }), true)
  assert.equal(draftDiffers(null, xmlFor('def-diff')), false)
  assert.equal(draftDiffers({ flow: {} }, xmlFor('def-diff')), false, '旧 flow 草稿不参与比较')
})

check('clearDraft 同时清掉 storage 与默认仓库', () => {
  const storage = fakeStorage()
  const store = createDraftStore(storage)
  store.write(makeDraft('def-clear'))
  assert.ok(storage.map.has(draftKey('def-clear')))
  store.clear('def-clear')
  assert.equal(storage.map.has(draftKey('def-clear')), false)
  assert.equal(store.read('def-clear'), null)
})

check('默认导出在 Node（没有 localStorage）下也能写入/读回', () => {
  assert.equal(detectStorage(), null)
  const probe = makeDraft('def-node')
  writeDraft(probe, { savedAt: '2026-11-11T01:00:00.000Z' })
  const record = readDraft('def-node')
  assert.ok(record && record.definitionId === 'def-node')
  assert.equal(record.baseVersion, 2)
  clearDraft('def-node')
  assert.equal(readDraft('def-node'), null)
})

check('去抖：连续 5 次编辑只写最后一次（自动保存只落本地草稿）', () => {
  const { timer, storage, store, scheduler } = makeScheduler()
  const draft = makeDraft('def-debounce')
  for (let i = 0; i < 5; i += 1) {
    draft.xml = xmlFor('def-debounce').replace('name="def-debounce"', `name="第 ${i} 个字"`)
    assert.equal(scheduler.schedule(draft), true)
    timer.advance(100)
  }
  assert.equal(storage.writes, 0, '去抖窗内不能写盘')
  timer.advance(DRAFT_DEBOUNCE_MS)
  assert.equal(storage.writes, 1, '5 次变更只应写最后一次')
  assert.ok(store.read('def-debounce').xml.includes('第 4 个字'), '落盘的是最后一次快照')
  assert.equal(timer.pending(), 0, '写完后不能留下定时器')
})

check('maxWait：一直不停手也会在 2s 内强制落一次盘', () => {
  const { timer, storage, scheduler } = makeScheduler()
  const draft = makeDraft('def-maxwait')
  for (let i = 0; i < 30; i += 1) {
    draft.xml = xmlFor('def-maxwait').replace('name="def-maxwait"', `name="连续输入 ${i}"`)
    scheduler.schedule(draft)
    timer.advance(100)
  }
  assert.ok(timer.now() >= DRAFT_MAX_WAIT_MS)
  assert.equal(storage.writes, 1, '3s 连续输入应恰好被 maxWait 强制写 1 次')
})

check('卸载 / 页面隐藏：flush 立即写最后一次，旧定时器不再二次写', () => {
  const { timer, storage, store, scheduler } = makeScheduler()
  const draft = makeDraft('def-flush')
  draft.xml = xmlFor('def-flush').replace('name="def-flush"', 'name="第一个字"')
  scheduler.schedule(draft)
  timer.advance(200)
  draft.xml = xmlFor('def-flush').replace('name="def-flush"', 'name="最后一个字"')
  scheduler.schedule(draft)
  assert.equal(storage.writes, 0)

  const record = scheduler.flush()
  assert.equal(storage.writes, 1, '隐藏时必须立即 flush')
  assert.ok(record.xml.includes('最后一个字'))
  assert.ok(store.read('def-flush').xml.includes('最后一个字'))
  assert.equal(timer.pending(), 0, 'flush 后不得留下定时器')

  timer.advance(10000)
  assert.equal(storage.writes, 1, 'flush 后旧定时器不得二次写盘')
})

check('草稿调度：cancel 后待写内容不会再落盘', () => {
  const { timer, storage, scheduler } = makeScheduler()
  scheduler.schedule(makeDraft('def-cancel'))
  assert.equal(scheduler.cancel('def-cancel'), true)
  timer.advance(5000)
  assert.equal(storage.writes, 0, 'cancel 后不能再写盘')
  assert.equal(scheduler.pending(), null)
})

check('写盘失败保留待写内容，下一次 flush 重试成功', () => {
  const timer = fakeTimer()
  const storage = fakeStorage()
  const store = createDraftStore(storage)
  let fail = true
  const scheduler = createDraftScheduler({
    write: draft => {
      if (fail) throw new Error('quota exceeded')
      return store.write(draft)
    },
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
  })
  scheduler.schedule(makeDraft('def-fail'))
  timer.advance(DRAFT_DEBOUNCE_MS)
  assert.equal(storage.writes, 0)
  assert.ok(scheduler.pending() !== null, '失败后不能丢用户输入')
  assert.ok(scheduler.lastError instanceof Error)

  fail = false
  const record = scheduler.flush()
  assert.ok(record && record.definitionId === 'def-fail')
  assert.equal(storage.writes, 1)
  assert.equal(scheduler.pending(), null)
  assert.equal(scheduler.lastError, null)
})

check('恢复：重开页面后能从新 store 读回未保存草稿', () => {
  const storage = fakeStorage()
  const first = createDraftStore(storage)
  first.write({
    definitionId: 'def-restore',
    baseVersion: 7,
    baseHash: 'hash-v7',
    xml: xmlFor('def-restore'),
  }, { savedAt: '2026-11-11T02:00:00.000Z' })

  const second = createDraftStore(storage)
  const record = second.read('def-restore')
  assert.ok(record)
  assert.equal(record.baseVersion, 7)
  assert.equal(record.baseHash, 'hash-v7')
  assert.equal(record.savedAt, '2026-11-11T02:00:00.000Z')
  assert.equal(draftDiffers(record, { hash: 'hash-v8' }), true, '服务器已有新版本时提示恢复')
})

check('切到另一份定义时先把上一份写掉，不串稿', () => {
  const { timer, storage, store, scheduler } = makeScheduler()
  scheduler.schedule(makeDraft('def-a'))
  timer.advance(100)
  scheduler.schedule(makeDraft('def-b'))
  assert.equal(storage.writes, 1, '切换定义必须先 flush 上一份')
  assert.ok(store.read('def-a'))
  timer.advance(DRAFT_DEBOUNCE_MS)
  assert.ok(store.read('def-b'))
})

console.log(`\n${checks} 组通过`)
