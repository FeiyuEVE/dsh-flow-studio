#!/usr/bin/env node
/**
 * 旧流程 JSON → BPMN XML 转换器自检：节点/边映射、分支默认流、打回边、DI 布局、round-trip。
 *
 * 直接 `node test/bpmn-convert.test.mjs`；不启动 dsh、不写盘。
 */

import assert from 'node:assert/strict'

import { convertLegacyFlow } from '../src/bpmn-convert.js'
import { evaluateFeel } from '../src/bpmn-expr.js'
import { parseBpmn } from '../src/bpmn-parse.js'
import { defaultFlow } from '../src/model.js'

let checks = 0
let assertions = 0

const A = {
  equal(actual, expected, message) {
    assertions += 1
    assert.equal(actual, expected, message)
  },
  deepEqual(actual, expected, message) {
    assertions += 1
    assert.deepEqual(actual, expected, message)
  },
  ok(value, message) {
    assertions += 1
    assert.ok(value, message)
  },
  includes(haystack, needle, message) {
    assertions += 1
    assert.ok(
      typeof haystack === 'string' && haystack.includes(needle),
      message || `期望包含「${needle}」`,
    )
  },
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

const countOf = (text, needle) => text.split(needle).length - 1
const hasCode = (list, code) => list.some(item => item && item.code === code)

/** 3 节点 + 1 条打回边：最小迁移样本。 */
function legacyThreeNodes() {
  return {
    schemaVersion: 1,
    id: 'flow-min',
    name: '最小流程',
    description: 'start → work → end，work 可打回 start',
    nodes: [
      { id: 'n_start', kind: 'start', title: '任务输入', x: 40, y: 220 },
      {
        id: 'n_work',
        kind: 'stage',
        title: '开发',
        role: '实现者',
        task: '写代码',
        skills: ['java'],
        maxRounds: 2,
      },
      { id: 'n_end', kind: 'end', title: '完成', x: 600, y: 220 },
    ],
    edges: [
      { id: 'e1', from: 'n_start', to: 'n_work', kind: 'next', label: '' },
      { id: 'e2', from: 'n_work', to: 'n_end', kind: 'next', label: '' },
      { id: 'e3', from: 'n_work', to: 'n_start', kind: 'reject', label: '打回重来' },
    ],
  }
}

/** 带分支、team、provider/adapter 的迁移样本。 */
function legacyBranching() {
  return {
    schemaVersion: 1,
    id: 'flow-demo',
    name: '迁移演示',
    nodes: [
      { id: 'n_start', kind: 'start', title: '任务输入' },
      {
        id: 'n_dev',
        kind: 'stage',
        title: '开发',
        mode: 'team',
        role: '实现者',
        task: '写代码',
        skills: ['java', 'sql'],
        outputs: '代码',
        maxRounds: 2,
        provider: 'deepseek',
        executor: 'codex',
        team: [
          { name: '接口实现', role: '写接口', task: '实现 REST' },
          { name: '接口实现', role: '写库', task: '实现存储' },
        ],
      },
      { id: 'n_review', kind: 'stage', title: '审查', role: '审查者', task: '审代码', maxRounds: 3 },
      { id: 'n_end', kind: 'end', title: '完成' },
    ],
    edges: [
      { id: 'e1', from: 'n_start', to: 'n_dev', kind: 'next' },
      { id: 'e2', from: 'n_dev', to: 'n_review', kind: 'next' },
      { id: 'e3', from: 'n_dev', to: 'n_end', kind: 'next' },
      { id: 'e4', from: 'n_review', to: 'n_end', kind: 'next' },
      { id: 'e5', from: 'n_review', to: 'n_dev', kind: 'reject', label: '审查打回' },
    ],
  }
}

/** 带 model/agentPreset/executor/outputs/check/extras 的迁移样本。 */
function legacyWithFields() {
  return {
    schemaVersion: 1,
    id: 'flow-fields',
    name: '字段迁移',
    nodes: [
      { id: 'n_start', kind: 'start', title: '开始', x: 40, y: 220, task: '收任务', outputs: '任务卡' },
      {
        id: 'n_dev',
        kind: 'stage',
        title: '开发',
        x: 300,
        y: 220,
        mode: 'team',
        role: '实现者',
        task: '写代码',
        skills: ['java'],
        outputs: ['交付说明', { name: '变更清单', kind: 'md', required: true }],
        team: [
          { name: '实现者A', role: '编码', task: '实现功能', extras: { skillSet: ['x'], note: 'member-extra' } },
        ],
        maxRounds: 2,
        model: 'deepseek/deepseek-chat',
        agentPreset: 'specialist',
        executor: 'codex',
        executorCommand: 'codex --dangerously-bypass',
        check: { command: 'npm test', expectExitCode: 0, timeoutMs: 120000, reportPath: 'reports/test.txt' },
        extras: { foo: 'bar', cwd: '/work', env: { A: 'B' }, timeoutMs: 5000, schemaPath: '/schema.json' },
        unknownTop: 'keep-me',
      },
      { id: 'n_end', kind: 'end', title: '完成', x: 600, y: 220, outputs: '交付说明' },
    ],
    edges: [
      { id: 'e1', from: 'n_start', to: 'n_dev', kind: 'next' },
      { id: 'e2', from: 'n_dev', to: 'n_end', kind: 'next' },
      { id: 'e3', from: 'n_dev', to: 'n_start', kind: 'reject', label: '打回' },
    ],
  }
}

function legacyMultiReject() {
  return {
    schemaVersion: 1,
    id: 'flow-multi-reject',
    name: '多目标回退',
    nodes: [
      { id: 'n_start', kind: 'start', title: '开始', x: 40, y: 220 },
      { id: 'n_dev', kind: 'stage', title: '开发', x: 300, y: 220, role: '实现者', task: '写代码' },
      { id: 'n_test', kind: 'stage', title: '测试', x: 600, y: 220, role: '测试者', task: '跑测试' },
      { id: 'n_review', kind: 'stage', title: '审查', x: 900, y: 220, role: '审查者', task: '审代码' },
      { id: 'n_end', kind: 'end', title: '完成', x: 1200, y: 220 },
    ],
    edges: [
      { id: 'e1', from: 'n_start', to: 'n_dev', kind: 'next' },
      { id: 'e2', from: 'n_dev', to: 'n_test', kind: 'next' },
      { id: 'e3', from: 'n_test', to: 'n_review', kind: 'next' },
      { id: 'e4', from: 'n_review', to: 'n_dev', kind: 'reject', label: '回退到开发' },
      { id: 'e5', from: 'n_review', to: 'n_test', kind: 'reject', label: '回退到测试' },
      { id: 'e6', from: 'n_review', to: 'n_end', kind: 'next' },
    ],
  }
}

console.log('bpmn-convert.js')

await check('3 节点 + 1 打回边 → XML → parseBpmn round-trip 通过，节点/边数一致', async () => {
  const result = convertLegacyFlow(legacyThreeNodes())
  A.equal(result.ok, true, `转换必须成功：${JSON.stringify(result.errors)}`)
  A.deepEqual(result.errors, [])

  const { xml } = result
  A.includes(xml, '<bpmn:startEvent id="n_start"')
  A.includes(xml, '<bpmn:endEvent id="n_end"')
  A.includes(xml, '<bpmn:serviceTask id="n_work"')
  A.includes(xml, '<fs:node nodeType="agent"')
  A.includes(xml, 'language="feel">= verdict = "reject"</bpmn:conditionExpression>')
  A.equal(xml.includes('= true'), false, '不得再生成 = true 条件')
  A.includes(xml, '<fs:maxRounds>2</fs:maxRounds>')

  const parsed = await parseBpmn(xml)
  A.equal(parsed.ok, true, `转换结果必须能被 parseBpmn 重新解析：${JSON.stringify(parsed.errors)}`)
  A.equal(parsed.definition.elements.length, 3)
  A.equal(parsed.definition.flows.length, 3)

  const reject = parsed.definition.flows.find(flow => flow.from === 'n_work' && flow.to === 'n_start')
  A.ok(reject, '打回边必须还在')
  A.deepEqual(reject.condition, { expression: '= verdict = "reject"', language: 'feel' })
  A.equal(reject.extensions.length, 1)
  A.equal(reject.extensions[0].type, 'fs:MaxRounds')
  A.equal(reject.extensions[0].value, 2)

  A.equal(parsed.warnings.some(warning => warning.code === 'RETURN_LOOP'), true, '往返后应识别出回退环')
  A.equal(hasCode(result.warnings, 'REJECT_CONDITION_MANUAL'), true)
  const rejectWarning = result.warnings.find(warning => warning.code === 'REJECT_CONDITION_MANUAL')
  A.includes(rejectWarning.message, '= verdict = "reject"')
  A.includes(rejectWarning.message, 'pass|reject')
  A.includes(rejectWarning.message, '需人工确认字段名与目标')
  A.includes(rejectWarning.message, '这条连线最多被走 2 次')
  A.equal(rejectWarning.message.includes('= true'), false)
})

await check('多目标回退：按 leftmost 生成互斥 FEEL 条件，两条不同且都含 verdict', async () => {
  const result = convertLegacyFlow(legacyMultiReject())
  A.equal(result.ok, true, `转换必须成功：${JSON.stringify(result.errors)}`)
  A.equal(result.xml.includes('= true'), false, '不得再生成 = true 条件')

  const parsed = await parseBpmn(result.xml)
  A.equal(parsed.ok, true, `多目标 round-trip 必须通过：${JSON.stringify(parsed.errors)}`)
  const flowById = new Map(parsed.definition.flows.map(flow => [flow.id, flow]))
  const left = flowById.get('e4') // n_review -> n_dev（x 最小）
  const right = flowById.get('e5') // n_review -> n_test
  const leftExpression = '= verdict = "reject" and (rejectTarget = null or rejectTarget = "n_dev")'
  const rightExpression = '= verdict = "reject" and rejectTarget = "n_test"'

  A.deepEqual(left.condition, { expression: leftExpression, language: 'feel' })
  A.deepEqual(right.condition, { expression: rightExpression, language: 'feel' })
  A.equal(left.condition.expression === right.condition.expression, false, '两条回退条件必须不相等')
  A.includes(left.condition.expression, 'verdict')
  A.includes(right.condition.expression, 'verdict')
  A.equal(left.extensions[0].type, 'fs:MaxRounds')
  A.equal(left.extensions[0].value, 2)
  A.equal(right.extensions[0].value, 2)

  // 互斥性：同一上下文里最多只有一条为真（BPMN 会对多条为真的出向流全部 take）。
  const contexts = [
    [{ verdict: 'reject' }, [true, false]],
    [{ verdict: 'reject', rejectTarget: 'n_dev' }, [true, false]],
    [{ verdict: 'reject', rejectTarget: 'n_test' }, [false, true]],
    [{ verdict: 'pass' }, [false, false]],
    [{}, [false, false]],
    [{ verdict: null }, [false, false]],
  ]
  for (const [context, expected] of contexts) {
    const leftValue = evaluateFeel(left.condition.expression, context)
    const rightValue = evaluateFeel(right.condition.expression, context)
    A.equal(leftValue.ok, true)
    A.equal(rightValue.ok, true)
    A.deepEqual([leftValue.value, rightValue.value], expected, `上下文 ${JSON.stringify(context)} 的互斥结果`)
  }

  const rejectWarning = result.warnings.find(warning => warning.code === 'REJECT_CONDITION_MANUAL')
  A.includes(rejectWarning.message, '多条回退连线')
  A.includes(rejectWarning.message, '默认走最左目标')
  A.includes(rejectWarning.message, 'rejectTarget')
  A.includes(rejectWarning.message, '互斥')
  A.includes(rejectWarning.message, '这条连线最多被走 2 次')
})

await check('多目标回退条件使用转换后的 XML id（不是旧 id）', async () => {
  const flow = {
    id: 'flow-sanitize',
    name: 'id 清洗',
    nodes: [
      { id: 's', kind: 'start', title: '开始', x: 40, y: 220 },
      { id: 'n a', kind: 'stage', title: '目标A', x: 300, y: 220, role: 'a', task: 'a' },
      { id: 'n b', kind: 'stage', title: '目标B', x: 600, y: 220, role: 'b', task: 'b' },
      { id: 'r', kind: 'stage', title: '回退源', x: 900, y: 220, role: 'r', task: 'r' },
      { id: 'e', kind: 'end', title: '完成', x: 1200, y: 220 },
    ],
    edges: [
      { id: 'e1', from: 's', to: 'n a', kind: 'next' },
      { id: 'e2', from: 'n a', to: 'n b', kind: 'next' },
      { id: 'e3', from: 'n b', to: 'r', kind: 'next' },
      { id: 'e4', from: 'r', to: 'n a', kind: 'reject' },
      { id: 'e5', from: 'r', to: 'n b', kind: 'reject' },
      { id: 'e6', from: 'r', to: 'e', kind: 'next' },
    ],
  }
  const result = convertLegacyFlow(flow)
  A.equal(result.ok, true, `转换必须成功：${JSON.stringify(result.errors)}`)
  const parsed = await parseBpmn(result.xml)
  A.equal(parsed.ok, true, `id 清洗后仍必须 round-trip：${JSON.stringify(parsed.errors)}`)
  const flowById = new Map(parsed.definition.flows.map(edge => [edge.id, edge]))
  A.deepEqual(flowById.get('e4').condition, {
    expression: '= verdict = "reject" and (rejectTarget = null or rejectTarget = "node_n_a")',
    language: 'feel',
  })
  A.deepEqual(flowById.get('e5').condition, {
    expression: '= verdict = "reject" and rejectTarget = "node_n_b"',
    language: 'feel',
  })
  A.equal(result.xml.includes('rejectTarget = "n a"'), false, '不得使用旧 id')
  A.equal(result.xml.includes('rejectTarget = "n b"'), false, '不得使用旧 id')
})

await check('分支节点：第一条 next 设为 BPMN default，其余只写 warning 不编条件', async () => {
  const result = convertLegacyFlow(legacyBranching())
  A.equal(result.ok, true, `转换必须成功：${JSON.stringify(result.errors)}`)
  A.includes(result.xml, 'default="e2"', 'n_dev 的第一条 next（e2）必须是默认流')

  const branchWarning = result.warnings.find(warning => warning.code === 'BRANCH_CONDITION_MANUAL')
  A.ok(branchWarning, '必须提示分支需要人工补条件')
  A.includes(branchWarning.message, '该分支原先靠顺序')
  A.includes(branchWarning.message, '迁移后需人工补条件')

  const parsed = await parseBpmn(result.xml)
  A.equal(parsed.ok, true, `分支流程也必须 round-trip：${JSON.stringify(parsed.errors)}`)
  A.equal(parsed.definition.elements.length, 4)
  A.equal(parsed.definition.flows.length, 5)

  const flowById = new Map(parsed.definition.flows.map(flow => [flow.id, flow]))
  A.equal(flowById.get('e2').isDefault, true)
  A.equal(flowById.get('e3').isDefault, false)
  A.equal(flowById.get('e3').condition, null, '非默认分支不自动编条件')
  A.equal(flowById.get('e4').condition, null)

  const reject = flowById.get('e5')
  A.deepEqual(reject.condition, { expression: '= verdict = "reject"', language: 'feel' })
  A.equal(reject.extensions[0].value, 2, 'fs:maxRounds 取目标节点 n_dev 的旧上限 2')
  A.equal(hasCode(result.warnings, 'REJECT_CONDITION_MANUAL'), true)
  const rejectWarning = result.warnings.find(warning => warning.code === 'REJECT_CONDITION_MANUAL')
  A.includes(rejectWarning.message, '这是模板层的条件')
  A.includes(rejectWarning.message, '需人工确认字段名与目标')
  A.equal(result.xml.includes('= true'), false)
})

await check('节点配置迁移：provider / adapter / skills / prompt / team', async () => {
  const result = convertLegacyFlow(legacyBranching())
  A.equal(result.ok, true)
  const parsed = await parseBpmn(result.xml)
  A.equal(parsed.ok, true)

  const dev = parsed.definition.elements.find(element => element.id === 'n_dev')
  A.equal(dev.kind, 'agent')
  A.equal(dev.node.provider, 'deepseek')
  A.equal(dev.node.adapter, 'codex')
  A.deepEqual(dev.node.skills, ['java', 'sql'])
  A.deepEqual(dev.node.hooks, [])
  A.equal(dev.node.prompt, '写代码')
  A.equal(dev.node.roleCard, '实现者')
  A.equal(dev.node.team.mode, 'fanout')
  A.equal(dev.node.team.members.length, 2)
  A.equal(dev.node.team.members[0].id, '接口实现')
  A.equal(dev.node.team.members[0].role, '写接口')
  A.equal(dev.node.team.members[0].prompt, '实现 REST')
  A.equal(dev.node.team.members[1].id, '接口实现_2', '重名成员 id 自动加后缀')
})

await check('DI 布局：每个节点有 BPMNShape、每条边有 BPMNEdge，坐标是有限数字', async () => {
  const flow = legacyBranching()
  const result = convertLegacyFlow(flow)
  A.equal(result.ok, true)
  A.equal(countOf(result.xml, '<bpmndi:BPMNShape '), flow.nodes.length)
  A.equal(countOf(result.xml, '<bpmndi:BPMNEdge '), flow.edges.length)
  A.includes(result.xml, '<bpmndi:BPMNDiagram ')
  A.includes(result.xml, '<bpmndi:BPMNPlane ')

  for (const node of flow.nodes) {
    A.includes(result.xml, `bpmnElement="${node.id}"`, `节点 ${node.id} 必须有 DI`)
  }
  for (const edge of flow.edges) {
    A.includes(result.xml, `bpmnElement="${edge.id}"`, `连线 ${edge.id} 必须有 DI`)
  }

  const shapes = [...result.xml.matchAll(/<bpmndi:BPMNShape id="[^"]+" bpmnElement="([^"]+)">\s*<omgdc:Bounds x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g)]
  A.equal(shapes.length, flow.nodes.length)
  const rects = []
  for (const match of shapes) {
    const [, id, x, y, width, height] = match
    for (const value of [x, y, width, height]) {
      A.ok(Number.isFinite(Number(value)), `Bounds 坐标必须是数字：${value}`)
    }
    rects.push({ id, x: Number(x), y: Number(y), width: Number(width), height: Number(height) })
  }
  // 简单网格布局不允许节点形状重叠。
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i]
      const b = rects[j]
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width
        && a.y < b.y + b.height && b.y < a.y + a.height
      A.equal(overlap, false, `节点形状重叠：${a.id} 与 ${b.id}`)
    }
  }

  const edgeBlocks = [...result.xml.matchAll(/<bpmndi:BPMNEdge[\s\S]*?<\/bpmndi:BPMNEdge>/g)]
  A.equal(edgeBlocks.length, flow.edges.length)
  for (const block of edgeBlocks) {
    A.ok(countOf(block[0], '<omgdi:waypoint ') >= 2, '每条 BPMNEdge 至少要有两个折点')
  }
})

await check('XML 转义：标题里的 & < > " 不破坏文档', async () => {
  const flow = legacyThreeNodes()
  flow.name = 'A & B <流程>'
  flow.nodes[1].title = '开发 "核心" & <实现>'
  const result = convertLegacyFlow(flow)
  A.equal(result.ok, true)
  A.includes(result.xml, '&amp;')
  A.includes(result.xml, '&lt;')

  const parsed = await parseBpmn(result.xml)
  A.equal(parsed.ok, true, `转义后必须仍能解析：${JSON.stringify(parsed.errors)}`)
  A.equal(parsed.definition.name, 'A & B <流程>')
  A.equal(parsed.definition.elements.find(element => element.id === 'n_work').name, '开发 "核心" & <实现>')
})

await check('出厂模板（8 节点 / 11 边 / 4 条打回）round-trip 仍为 8 / 11', async () => {
  const flow = defaultFlow()
  const result = convertLegacyFlow(flow)
  A.equal(result.ok, true, `出厂模板必须能迁移：${JSON.stringify(result.errors)}`)
  A.equal(result.warnings.filter(warning => warning.code === 'REJECT_CONDITION_MANUAL').length, 4)

  const parsed = await parseBpmn(result.xml)
  A.equal(parsed.ok, true, `出厂模板 round-trip 必须通过：${JSON.stringify(parsed.errors)}`)
  A.equal(parsed.definition.elements.length, flow.nodes.length)
  A.equal(parsed.definition.flows.length, flow.edges.length)

  const rejectFlows = parsed.definition.flows.filter(flowEdge => flowEdge.condition?.expression === '= verdict = "reject"')
  A.equal(rejectFlows.length, 4, '四处旧模板回退边都必须写成 = verdict = "reject" 的条件边')
  A.equal(result.xml.includes('= true'), false)
  for (const reject of rejectFlows) {
    A.equal(reject.extensions[0]?.type, 'fs:MaxRounds')
    A.equal(reject.extensions[0]?.value, 2)
  }
  A.equal(parsed.warnings.some(warning => warning.code === 'RETURN_LOOP'), true)
})

await check('5 字段迁移：model / agentPreset / executor / outputs / check 原值回来，未知字段进 fs:legacy', async () => {
  const flow = legacyWithFields()
  const result = convertLegacyFlow(flow)
  A.equal(result.ok, true, `转换必须成功：${JSON.stringify(result.errors)}`)
  A.includes(result.xml, '<fs:executor ')
  A.includes(result.xml, '<fs:output>')
  A.includes(result.xml, '<fs:output name="变更清单"')
  A.includes(result.xml, '<fs:check>')
  A.includes(result.xml, '<fs:legacy>')

  const archiveWarning = result.warnings.find(warning => warning.code === 'LEGACY_FIELDS_ARCHIVED' && warning.nodeId === 'n_dev')
  A.ok(archiveWarning, '有 0.13 无对应概念的字段时必须写 warning')
  A.includes(archiveWarning.message, 'unknownTop')
  A.includes(archiveWarning.message, 'extras')

  const parsed = await parseBpmn(result.xml)
  A.equal(parsed.ok, true, `字段迁移也必须 round-trip：${JSON.stringify(parsed.errors)}`)
  const dev = parsed.definition.elements.find(element => element.id === 'n_dev')
  A.equal(dev.node.model, 'deepseek/deepseek-chat')
  A.equal(dev.node.agentPreset, 'specialist')
  A.deepEqual(dev.node.executor, {
    kind: 'codex',
    command: 'codex --dangerously-bypass',
    cwd: '/work',
    env: { A: 'B' },
    timeoutMs: 5000,
    schemaPath: '/schema.json',
  })
  A.deepEqual(dev.node.outputs, ['交付说明', { name: '变更清单', kind: 'md', required: true }])
  A.deepEqual(dev.node.check, {
    command: 'npm test',
    expectExitCode: 0,
    timeoutMs: 120000,
    reportPath: 'reports/test.txt',
  })

  // 「完全没有未知字段丢失」：extras 与未知顶层字段都进 fs:legacy，解析后可读回。
  const legacy = dev.extensions.find(extension => extension.type === 'fs:Legacy')
  A.ok(legacy, '节点必须带 fs:Legacy 留档')
  A.equal(legacy.value.unknownTop, 'keep-me')
  A.deepEqual(legacy.value.extras, {
    foo: 'bar',
    cwd: '/work',
    env: { A: 'B' },
    timeoutMs: 5000,
    schemaPath: '/schema.json',
    unknownTop: 'keep-me',
  })
  A.equal(legacy.value.mode, 'team')
  A.equal(legacy.value.maxRounds, 2)
  // team 只映射了 name/role/task/skills；成员 extras 仍在 fs:legacy.team 里。
  A.equal(legacy.value.team[0].extras.note, 'member-extra')
  A.deepEqual(legacy.value.team[0].extras.skillSet, ['x'])

  // start/end 没有 fs:node：旧 task/outputs 也要原样留在 fs:legacy。
  const start = parsed.definition.elements.find(element => element.id === 'n_start')
  const startLegacy = start.extensions.find(extension => extension.type === 'fs:Legacy')
  A.ok(startLegacy)
  A.equal(startLegacy.value.task, '收任务')
  A.equal(startLegacy.value.outputs, '任务卡')
})

await check('非法旧流程：非对象 / 没有 start / 没有 end / 不可达 → ok:false', async () => {
  const nonObject = convertLegacyFlow(null)
  A.equal(nonObject.ok, false)
  A.equal(nonObject.xml, '')
  A.equal(hasCode(nonObject.errors, 'LEGACY_INVALID'), true)

  const noStart = legacyThreeNodes()
  noStart.nodes = noStart.nodes.filter(node => node.kind !== 'start')
  const noStartResult = convertLegacyFlow(noStart)
  A.equal(noStartResult.ok, false)
  A.equal(hasCode(noStartResult.errors, 'LEGACY_START_INVALID'), true)

  const noEnd = legacyThreeNodes()
  noEnd.nodes = noEnd.nodes.filter(node => node.kind !== 'end')
  const noEndResult = convertLegacyFlow(noEnd)
  A.equal(noEndResult.ok, false)
  A.equal(hasCode(noEndResult.errors, 'LEGACY_END_MISSING'), true)

  const unreachable = legacyThreeNodes()
  unreachable.nodes.push({ id: 'n_orphan', kind: 'stage', title: '孤儿', role: '', task: 'x' })
  unreachable.edges.push({ id: 'e4', from: 'n_orphan', to: 'n_end', kind: 'next' })
  const unreachableResult = convertLegacyFlow(unreachable)
  A.equal(unreachableResult.ok, false)
  A.equal(hasCode(unreachableResult.errors, 'LEGACY_UNREACHABLE'), true)
})

await check('丢弃坏连线时给 warning，且仍能生成可解析的 XML', async () => {
  const flow = legacyThreeNodes()
  flow.edges.push({ id: 'e_bad', from: 'n_work', to: 'ghost', kind: 'next' })
  const result = convertLegacyFlow(flow)
  A.equal(result.ok, true, `坏连线应被丢弃而不是阻断迁移：${JSON.stringify(result.errors)}`)
  A.equal(hasCode(result.warnings, 'EDGES_DROPPED'), true)
  const parsed = await parseBpmn(result.xml)
  A.equal(parsed.ok, true)
  A.equal(parsed.definition.flows.length, 3)
})

console.log(`\n${checks} 组通过（${assertions} 条断言）`)
