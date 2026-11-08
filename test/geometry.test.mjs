#!/usr/bin/env node
/**
 * 几何自检：全览世界的唯一来源、8 列宽 2028、6 个航道槽位与第 7 条降级。
 *
 * 不需要浏览器：直接 `node test/geometry.test.mjs`。
 */

import assert from 'node:assert/strict'

import { EDGE_KIND, NODE_H, NODE_W, defaultFlow } from '../src/model.js'
import {
  COL_STEP, EIGHT_COL_WORLD_W, FIT_MIN, IN_SLOTS, MAX_LANES, OUT_SLOTS, PAD,
  assignRejectLanes, fitView, nodeHeight, worldBounds,
} from '../src/client/geometry.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

function makeNode(id, x, y = 220) {
  return { id, kind: 'stage', title: id, x, y, mode: 'single', team: [], skills: [] }
}

function reject(id, from, to) {
  return { id, from, to, kind: EDGE_KIND.REJECT, label: id }
}

console.log('geometry.js')

check('节点尺寸是 232×108，主从节点 128', () => {
  assert.equal(NODE_W, 232)
  assert.equal(NODE_H, 108)
  assert.equal(nodeHeight(makeNode('a', 0)), 108)
  assert.equal(nodeHeight({ ...makeNode('a', 0), mode: 'team', team: [{ name: 'x' }] }), 128)
  assert.equal(COL_STEP, 284)
})

check('worldBounds 是唯一世界边界来源：8 列主干宽 2220', () => {
  const bounds = worldBounds(defaultFlow().nodes)
  assert.equal(bounds.w, 2220, '开始到结束的真实包围盒应为 2220')
  assert.equal(EIGHT_COL_WORLD_W, 2220, '导出的 8 列常量也必须等于 2220')
  assert.equal(bounds.minX, 40)
  assert.equal(bounds.maxX, 2260)
  // 出厂模板的阶段节点是 team 模式（主管 + 3 名成员），卡高 128；start/end 仍是 108。
  assert.equal(bounds.h, 128)
})

check('fitView 用屏幕 px 边距与 15% 地板，不再有第二套数学', () => {
  const nodes = defaultFlow().nodes
  const bounds = worldBounds(nodes)
  const fit = fitView(nodes, 1396, 824)
  assert.equal(PAD, 48)
  assert.equal(FIT_MIN, 0.15)
  assert.equal(fit.bounds.w, bounds.w, 'fitView 必须复用 worldBounds')
  const expected = Math.min((1396 - 2 * PAD) / bounds.w, (824 - 2 * PAD) / bounds.h)
  assert.ok(Math.abs(fit.z - expected) < 1e-9, `z 应为 ${expected}，实际 ${fit.z}`)
  assert.equal(fit.clamped, false)
  assert.equal(fit.hiddenColumns, 0)
})

check('30 节点串行链：15.35% 装得下，600px 视口触发 15% 地板并报隐藏列', () => {
  const chain = Array.from({ length: 30 }, (_, index) => makeNode('n' + index, index * COL_STEP))
  assert.equal(worldBounds(chain).w, 29 * COL_STEP + NODE_W)
  const wide = fitView(chain, 1396, 824)
  assert.equal(wide.clamped, false)
  assert.ok(Math.abs(wide.z - 1300 / (29 * COL_STEP + NODE_W)) < 1e-9, `实际 ${wide.z}`)
  assert.equal(wide.hiddenColumns, 0)

  const narrow = fitView(chain, 600, 824)
  assert.equal(narrow.z, FIT_MIN)
  assert.equal(narrow.clamped, true)
  assert.ok(narrow.hiddenColumns > 0, '低于地板时必须给出「还有 N 列在视野外」')
  assert.equal(narrow.hiddenColumns, 17)
})

check('航道槽位 6 个，入槽位与出槽位镜像', () => {
  assert.equal(MAX_LANES, 6)
  assert.deepEqual(OUT_SLOTS, [8, 24, 40, 56, 72, 88])
  assert.deepEqual(IN_SLOTS, [-88, -72, -56, -40, -24, -8])
})

check('第 7 条起并入最外航道：双线 0/1px，不静默丢弃', () => {
  const flow = defaultFlow()
  flow.edges.push(
    reject('e_overflow_1', 'n_review', 'n_req'),
    reject('e_overflow_2', 'n_test', 'n_req'),
    reject('e_overflow_3', 'n_shape', 'n_req'),
    reject('e_overflow_4', 'n_plan', 'n_start'),
    reject('e_overflow_5', 'n_review', 'n_start'),
  )
  const result = assignRejectLanes(flow.nodes, flow.edges)
  assert.equal(result.laneCount, 6)
  assert.equal(result.overflowCount, 3)
  assert.equal(result.overflow.size, 3)
  assert.equal(result.lanes.size, 9, '9 条打回线都必须有航道，不能丢')

  const drawn = [...result.lanes.entries()].filter(([id]) => !result.overflow.has(id))
  assert.equal(new Set(drawn.map(([, lane]) => lane.laneY)).size, 6, '前 6 条各占一条航道')

  for (const id of result.overflow) {
    const lane = result.lanes.get(id)
    assert.equal(lane.overflow, true)
    assert.equal(lane.laneIndex, MAX_LANES)
    assert.ok(lane.laneY === result.outerLaneY || lane.laneY === result.outerLaneY + 1,
      '第 7 条起只允许落在最外航道或 +1px 的双线上')
  }
  const overflowLanes = [...result.overflow].map(id => result.lanes.get(id).laneY).sort((a, b) => a - b)
  assert.deepEqual(overflowLanes, [result.outerLaneY, result.outerLaneY, result.outerLaneY + 1])
})

check('同列并列按 flow.nodes 顺序 tie-break，且不依赖输入边顺序', () => {
  const a = makeNode('a', 0)
  const b = makeNode('b', 0)
  const t1 = makeNode('t1', 500)
  const t2 = makeNode('t2', 500)
  const edges = [reject('e_a', 'a', 't1'), reject('e_b', 'b', 't2')]

  const forward = assignRejectLanes([a, b, t1, t2], edges)
  assert.ok(forward.lanes.get('e_a').laneY > forward.lanes.get('e_b').laneY,
    'nodes 顺序靠前的源拿更深航道')

  const reversedNodes = assignRejectLanes([b, a, t1, t2], edges)
  assert.ok(reversedNodes.lanes.get('e_b').laneY > reversedNodes.lanes.get('e_a').laneY,
    '换 nodes 顺序后 tie-break 也跟着确定地换')

  const shuffledEdges = assignRejectLanes([a, b, t1, t2], [edges[1], edges[0]])
  assert.equal(shuffledEdges.lanes.get('e_a').laneY, forward.lanes.get('e_a').laneY)
  assert.equal(shuffledEdges.lanes.get('e_b').laneY, forward.lanes.get('e_b').laneY)
})

console.log(`\n${checks} 组通过`)
