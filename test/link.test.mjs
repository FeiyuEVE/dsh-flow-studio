#!/usr/bin/env node
/**
 * 键盘连线状态机自检：C 进入、Tab/Shift+Tab 换候选、Enter 确认、Esc 取消的数据形状，
 * 以及「目标在下游建 next、在上游建 reject」的方向规则。
 */

import assert from 'node:assert/strict'

import { EDGE_KIND, defaultFlow } from '../src/model.js'
import {
  activeCandidate, beginLink, confirmLink, describeLink, edgeKindBetween, linkCandidates, moveLink,
} from '../src/client/link.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

const flow = defaultFlow()

console.log('link.js')

check('候选排除源节点，顺序等于 flow.nodes 顺序', () => {
  const candidates = linkCandidates(flow.nodes, 'n_req')
  assert.equal(candidates.length, flow.nodes.length - 1)
  assert.equal(candidates[0], 'n_start')
  assert.ok(!candidates.includes('n_req'))
  assert.equal(beginLink(flow.nodes, 'n_req').candidates[1], 'n_plan')
})

check('没有其他节点时 beginLink 返回 null', () => {
  assert.equal(beginLink([flow.nodes[0]], 'n_start'), null)
  assert.equal(beginLink(flow.nodes, ''), null)
})

check('Tab 前进、Shift+Tab 后退，两端循环', () => {
  let state = beginLink(flow.nodes, 'n_start')
  assert.equal(activeCandidate(state), 'n_req')
  state = moveLink(state, 1)
  assert.equal(activeCandidate(state), 'n_plan')
  state = moveLink(state, -1)
  assert.equal(activeCandidate(state), 'n_req')
  state = moveLink(state, -1)
  assert.equal(activeCandidate(state), 'n_end', '从第一个候选往回应当循环到最后一个')
  state = moveLink(state, 1)
  assert.equal(activeCandidate(state), 'n_req')
})

check('Enter 确认返回边端点，Esc 由页面把状态清空', () => {
  const state = beginLink(flow.nodes, 'n_dev')
  const pair = confirmLink(state)
  assert.equal(pair.fromId, 'n_dev')
  assert.equal(pair.toId, state.candidates[0])
  const moved = moveLink(state, 2)
  assert.equal(confirmLink(moved).toId, moved.candidates[2])
  assert.equal(confirmLink(null), null)
})

check('方向规则：下游 next、上游 reject', () => {
  assert.equal(edgeKindBetween(flow, 'n_dev', 'n_test'), EDGE_KIND.NEXT)
  assert.equal(edgeKindBetween(flow, 'n_test', 'n_req'), EDGE_KIND.REJECT)
  assert.equal(edgeKindBetween(flow, 'n_start', 'n_review'), EDGE_KIND.NEXT)
})

check('播报是「从 <源> 到 <目标>」的可读名字', () => {
  const state = beginLink(flow.nodes, 'n_start')
  const text = describeLink(flow, state)
  assert.match(text, /连线待定/)
  assert.match(text, /任务输入/)
  assert.match(text, /需求分析/)
  assert.equal(describeLink(flow, null), '')
})

console.log(`\n${checks} 组通过`)
