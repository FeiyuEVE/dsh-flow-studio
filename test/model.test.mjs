#!/usr/bin/env node
/**
 * 模型层自检：出厂模板合法、坏数据被收敛、四类结构错误能被抓出来。
 * 不需要安装插件，直接 `node test/model.test.mjs`。
 */

import assert from 'node:assert/strict'

import {
  EDGE_KIND, EXEC_MODE, LIMITS, NODE_KIND, defaultFlow, describeFlow, normalizeFlow, summarize, validateFlow,
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

check('未知字段进 extras：节点 / 边 / 团队成员往返保存都不丢', () => {
  const raw = {
    name: '带扩展字段的流程',
    nodes: [
      { id: 'a', kind: 'start', title: '开始', x: 0, y: 0, priority: 'high' },
      {
        id: 'b',
        kind: 'stage',
        title: '阶段',
        x: 10,
        y: 10,
        task: '做事',
        mode: 'team',
        estimateMinutes: 12,
        condition: { field: 'env', op: 'eq', value: 'prod' },
        team: [{ name: '主管', role: '负责', task: '拆活', model: 'deepseek-chat' }],
      },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'next', condition: { when: 'ok' }, weight: 0.5 }],
  }
  const flow = normalizeFlow(raw, '兜底')
  const start = flow.nodes.find(node => node.id === 'a')
  const stage = flow.nodes.find(node => node.id === 'b')
  const edge = flow.edges[0]
  assert.equal(start.extras.priority, 'high')
  assert.deepEqual(stage.extras.condition, { field: 'env', op: 'eq', value: 'prod' })
  assert.equal(stage.extras.estimateMinutes, 12)
  assert.equal(stage.team[0].extras.model, 'deepseek-chat')
  assert.deepEqual(edge.extras.condition, { when: 'ok' })
  assert.equal(edge.extras.weight, 0.5)

  // 再跑一次 normalize（保存 → 读回 → 再保存）仍然不丢，且不重复嵌套。
  const round = normalizeFlow(flow, '兜底')
  assert.deepEqual(round.nodes.find(node => node.id === 'a').extras, start.extras)
  assert.deepEqual(round.nodes.find(node => node.id === 'b').extras, stage.extras)
  assert.deepEqual(round.nodes.find(node => node.id === 'b').team[0].extras, stage.team[0].extras)
  assert.deepEqual(round.edges[0].extras, edge.extras)
  // 已知字段语义不变。
  assert.equal(stage.title, '阶段')
  assert.equal(stage.x, 10)
  assert.deepEqual(stage.skills, [])
})

check('extras 有界：键数 / 字符串 / 总字节超限只丢弃，不膨胀也不抛错', () => {
  const many = { id: 'many', kind: 'stage', title: '多键', x: 0, y: 0, task: 't' }
  for (let i = 0; i < 100; i += 1) many[`k${i}`] = i
  const longText = { id: 'long', kind: 'stage', title: '长文本', x: 0, y: 0, task: 't', huge: 'x'.repeat(10000) }
  const bigValues = { id: 'big', kind: 'stage', title: '大值', x: 0, y: 0, task: 't' }
  for (let i = 0; i < 20; i += 1) bigValues[`big${i}`] = 'y'.repeat(200)

  const flow = normalizeFlow({ nodes: [many, longText, bigValues], edges: [] })
  const manyExtras = flow.nodes.find(node => node.id === 'many').extras
  const longExtras = flow.nodes.find(node => node.id === 'long').extras
  const bigExtras = flow.nodes.find(node => node.id === 'big').extras
  assert.ok(Object.keys(manyExtras).length <= LIMITS.extrasKeys)
  assert.ok(JSON.stringify(manyExtras).length <= LIMITS.extrasBytes)
  assert.equal(longExtras.huge.length, LIMITS.extrasTextLen, '超长字符串按上限截断')
  assert.ok(JSON.stringify(bigExtras).length <= LIMITS.extrasBytes)
  assert.ok(Object.keys(bigExtras).length < 20, '字节上限会先于键数上限生效')

  const round = normalizeFlow(flow, '兜底')
  assert.deepEqual(round.nodes.find(node => node.id === 'many').extras, manyExtras)
  assert.deepEqual(round.nodes.find(node => node.id === 'long').extras, longExtras)
  assert.deepEqual(round.nodes.find(node => node.id === 'big').extras, bigExtras)
})

check('extras 坏输入：函数 / undefined / NaN / BigInt / 循环引用 / 坏旧 extras 都不抛错', () => {
  const circular = { name: '环' }
  circular.self = circular
  const raw = {
    nodes: [{
      id: 'a',
      kind: 'stage',
      title: '坏值',
      x: 0,
      y: 0,
      task: 't',
      fn: () => {},
      nothing: undefined,
      nan: Number.NaN,
      infinity: Number.POSITIVE_INFINITY,
      bigint: 10n,
      symbol: Symbol('s'),
      circular,
      nestedBad: { ok: 1, fn: () => {} },
      good: 'ok',
    }],
    edges: [],
  }
  let flow
  assert.doesNotThrow(() => { flow = normalizeFlow(raw, '兜底') })
  const extras = flow.nodes[0].extras
  assert.equal(extras.good, 'ok')
  for (const key of ['fn', 'nothing', 'nan', 'infinity', 'bigint', 'symbol', 'circular', 'nestedBad']) {
    assert.ok(!(key in extras), `不该保留不可序列化的 ${key}`)
  }
  assert.doesNotThrow(() => normalizeFlow({ nodes: [{ id: 'b', extras: circular }], edges: [] }))
  assert.doesNotThrow(() => normalizeFlow({ nodes: [{ id: 'c', extras: 'not-an-object' }], edges: [] }))

  // JSON 里的自有 __proto__ 键不能改写原型。
  const protoRaw = JSON.parse('{"nodes":[{"id":"p","kind":"stage","title":"p","x":0,"y":0,"task":"t","__proto__":{"polluted":true}}],"edges":[]}')
  const protoFlow = normalizeFlow(protoRaw, '兜底')
  assert.equal({}.polluted, undefined)
  assert.equal(Object.getPrototypeOf(protoFlow.nodes[0].extras), Object.prototype)
  assert.deepEqual(protoFlow.nodes[0].extras.__proto__, { polluted: true })

  // 取值即抛错的 getter 也不能把 normalizeFlow 带崩。
  const thrower = { id: 'd', kind: 'stage', title: 'd', x: 0, y: 0, task: 't' }
  Object.defineProperty(thrower, 'boom', { enumerable: true, get() { throw new Error('boom') } })
  let thrownFlow
  assert.doesNotThrow(() => { thrownFlow = normalizeFlow({ nodes: [thrower], edges: [] }, '兜底') })
  assert.ok(!thrownFlow.nodes[0].extras, '唯一未知字段取值抛错时应整体丢弃')
})

check('没有未知字段时不挂 extras，既有形状不变', () => {
  const flow = defaultFlow()
  const round = normalizeFlow(flow, '兜底')
  assert.ok(round.nodes.every(node => !('extras' in node)))
  assert.ok(round.edges.every(edge => !('extras' in edge)))
  assert.deepEqual(round.nodes.map(node => node.id), flow.nodes.map(node => node.id))
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
