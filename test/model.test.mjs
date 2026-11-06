#!/usr/bin/env node
/**
 * 模型层自检：出厂模板合法、坏数据被收敛、四类结构错误能被抓出来。
 * 不需要安装插件，直接 `node test/model.test.mjs`。
 */

import assert from 'node:assert/strict'

import {
  EDGE_KIND, EXEC_MODE, NODE_KIND, defaultFlow, describeFlow, normalizeFlow, summarize, validateFlow,
} from '../src/model.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

console.log('model.js')

check('出厂模板通过校验，且包含六阶段与四处打回', () => {
  const flow = defaultFlow()
  const report = validateFlow(flow)
  assert.deepEqual(report.errors, [], `出厂模板不该有错误：${JSON.stringify(report.errors)}`)
  const titles = flow.nodes.map(node => node.title)
  for (const stage of ['需求分析', '方案设计', '结构设计', '开发', '测试', '代码审查']) {
    assert.ok(titles.includes(stage), `缺少阶段「${stage}」`)
  }
  const rejects = flow.edges.filter(edge => edge.kind === EDGE_KIND.REJECT)
  assert.equal(rejects.length, 4, '应当有 4 条打回线')
  assert.equal(flow.nodes.filter(node => node.kind === NODE_KIND.START).length, 1)
  assert.equal(flow.nodes.filter(node => node.kind === NODE_KIND.END).length, 1)
})

check('describeFlow 把打回写进流转说明', () => {
  const text = describeFlow(defaultFlow())
  assert.match(text, /需求分析/)
  assert.match(text, /代码审查/)
  assert.match(text, /打回/)
})

check('normalizeFlow 丢弃悬空连线与自环', () => {
  const raw = {
    name: '坏数据',
    nodes: [
      { id: 'a', kind: 'start', title: '开始', x: 0, y: 0 },
      { id: 'b', kind: 'stage', title: '阶段', x: 10, y: 10 },
    ],
    edges: [
      { from: 'a', to: 'b', kind: 'next' },
      { from: 'b', to: 'ghost', kind: 'next' },
      { from: 'b', to: 'b', kind: 'next' },
      { from: 'a', to: 'b', kind: 'next' },
    ],
  }
  const flow = normalizeFlow(raw, '兜底名')
  assert.equal(flow.edges.length, 1, '只该留下一条合法且不重复的连线')
  assert.equal(flow.name, '坏数据')
})

check('normalizeFlow 对垃圾输入不抛错', () => {
  const flow = normalizeFlow(null, '兜底')
  assert.equal(flow.nodes.length, 0)
  assert.equal(flow.name, '兜底')
  assert.equal(validateFlow(flow).ok, false)
})

check('校验抓出「没有开始节点」', () => {
  const flow = defaultFlow()
  flow.nodes = flow.nodes.filter(node => node.kind !== NODE_KIND.START)
  flow.edges = flow.edges.filter(edge => edge.from !== 'n_start')
  const report = validateFlow(flow)
  assert.ok(report.errors.some(item => item.message.includes('开始')), JSON.stringify(report.errors))
})

check('校验抓出「从开始走不到的孤立节点」', () => {
  const flow = defaultFlow()
  flow.nodes.push({ ...flow.nodes[1], id: 'n_orphan', title: '孤岛', x: 0, y: 900 })
  const report = validateFlow(flow)
  assert.ok(report.errors.some(item => item.message.includes('孤岛')), JSON.stringify(report.errors))
})

check('校验抓出「打回目标不在上游」', () => {
  const flow = defaultFlow()
  // 把「审查打回」从 代码审查→开发 改成 开发→代码审查：方向反了。
  const edge = flow.edges.find(item => item.kind === EDGE_KIND.REJECT && item.from === 'n_review')
  edge.to = 'n_end'
  const report = validateFlow(flow)
  assert.ok(report.errors.some(item => item.message.includes('上游')), JSON.stringify(report.errors))
})

check('校验抓出「阶段节点没有内容」', () => {
  const flow = defaultFlow()
  flow.nodes.find(node => node.id === 'n_dev').task = '   '
  const report = validateFlow(flow)
  assert.ok(report.errors.some(item => item.message.includes('开发')), JSON.stringify(report.errors))
})

check('主从节点没配子 agent 只给提醒不给错误', () => {
  const flow = defaultFlow()
  const dev = flow.nodes.find(node => node.id === 'n_dev')
  dev.mode = EXEC_MODE.TEAM
  dev.team = []
  const report = validateFlow(flow)
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors))
  assert.ok(report.warnings.some(item => item.message.includes('子 agent')), JSON.stringify(report.warnings))
})

check('summarize 只吐摘要字段', () => {
  const summary = summarize({ ...defaultFlow(), id: 'flow-x' })
  assert.equal(summary.id, 'flow-x')
  assert.equal(summary.rejectCount, 4)
  assert.ok(!('nodes' in summary))
})

console.log(`\n${checks} 组通过`)
