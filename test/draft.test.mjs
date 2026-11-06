#!/usr/bin/env node
/**
 * 本地草稿自检：键名、写入/读回、内容指纹、坏数据与不可用 localStorage 的退化。
 *
 * 不需要浏览器：直接 `node test/draft.test.mjs`。
 */

import assert from 'node:assert/strict'

import { defaultFlow } from '../src/model.js'
import {
  clearDraft, contentSignature, createDraftStore, detectStorage, draftDiffers, draftKey, readDraft, writeDraft,
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
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
  }
}

const flow = defaultFlow()
flow.id = 'flow-draft-test'
flow.updatedAt = '2026-11-01T08:00:00.000Z'

console.log('drafts.js')

check('键名是 flow-studio:draft:<flowId>', () => {
  assert.equal(draftKey('abc'), 'flow-studio:draft:abc')
})

check('写入后能读回 flow / savedAt / baseSavedAt', () => {
  const storage = fakeStorage()
  const store = createDraftStore(storage)
  const record = store.write(flow, { savedAt: '2026-11-02T09:10:11.000Z' })
  assert.equal(record.savedAt, '2026-11-02T09:10:11.000Z')
  assert.equal(record.baseSavedAt, flow.updatedAt)
  assert.ok(storage.map.has(draftKey(flow.id)), '必须真的落到 storage 里')

  const reopened = createDraftStore(storage)
  const reread = reopened.read(flow.id)
  assert.equal(reread.flow.name, flow.name)
  assert.equal(reread.flow.nodes.length, flow.nodes.length)
  assert.equal(reread.savedAt, record.savedAt)
  assert.equal(reread.baseSavedAt, flow.updatedAt)
})

check('localStorage 不可用时退化为内存草稿且不抛错', () => {
  const store = createDraftStore(null)
  assert.equal(store.read(flow.id), null)
  const record = store.write(flow)
  assert.ok(record && record.flow.id === flow.id)
  assert.equal(store.read(flow.id).flow.name, flow.name)
  store.clear(flow.id)
  assert.equal(store.read(flow.id), null)
})

check('storage 抛异常（隐私模式/配额满）时仍然保住内存副本', () => {
  const throwing = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('quota') },
    removeItem() { throw new Error('denied') },
  }
  const store = createDraftStore(throwing)
  store.write(flow, { savedAt: '2026-11-03T00:00:00.000Z' })
  const record = store.read(flow.id)
  assert.ok(record, '写不进 storage 也不能丢内存副本')
  assert.equal(record.flow.name, flow.name)
  store.clear(flow.id)
  assert.equal(store.read(flow.id), null)
})

check('坏 JSON 的草稿读成 null，不影响打开流程', () => {
  const storage = fakeStorage()
  storage.map.set(draftKey(flow.id), '{ this is not json')
  const store = createDraftStore(storage)
  assert.equal(store.read(flow.id), null)
})

check('内容指纹忽略时间戳，只比内容', () => {
  const clone = JSON.parse(JSON.stringify(flow))
  clone.updatedAt = '2027-01-01T00:00:00.000Z'
  clone.createdAt = '2025-01-01T00:00:00.000Z'
  assert.equal(contentSignature(clone), contentSignature(flow))

  clone.name = '改过名'
  assert.notEqual(contentSignature(clone), contentSignature(flow))
  clone.name = flow.name
  clone.nodes[1].task = '改过任务'
  assert.notEqual(contentSignature(clone), contentSignature(flow))
})

check('只有内容不同才提示恢复：时间戳差异不算', () => {
  const record = { flow, savedAt: '2026-11-02T00:00:00.000Z', baseSavedAt: flow.updatedAt }
  const server = JSON.parse(JSON.stringify(flow))
  server.updatedAt = '2026-11-05T00:00:00.000Z'
  assert.equal(draftDiffers(server, record), false)

  server.nodes[1].task = '服务器上已经改过的内容'
  assert.equal(draftDiffers(server, record), true)
  assert.equal(draftDiffers(server, null), false)
})

check('clearDraft 同时清掉 storage 与默认仓库', () => {
  const storage = fakeStorage()
  const store = createDraftStore(storage)
  store.write(flow)
  assert.ok(storage.map.has(draftKey(flow.id)))
  store.clear(flow.id)
  assert.equal(storage.map.has(draftKey(flow.id)), false)
  assert.equal(store.read(flow.id), null)
})

check('默认导出在 Node（没有 localStorage）下也能写入/读回', () => {
  assert.equal(detectStorage(), null)
  const probe = { ...flow, id: 'flow-node-fallback' }
  writeDraft(probe, { savedAt: '2026-11-04T00:00:00.000Z' })
  const record = readDraft(probe.id)
  assert.ok(record && record.flow.id === probe.id)
  clearDraft(probe.id)
  assert.equal(readDraft(probe.id), null)
})

console.log(`\n${checks} 组通过`)
