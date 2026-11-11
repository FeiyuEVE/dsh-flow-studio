#!/usr/bin/env node
/**
 * 共享 moddle 契约与 XML 往返自检。
 *
 * 验证三件事：
 * 1. `src/bpmn-moddle.js` 是纯常量/描述符（不依赖 Node、DOM 或解析器），
 *    浏览器 chunk 与服务端解析器可以共用同一份形状；
 * 2. `test/fixtures/bpmn/editor-roundtrip.bpmn` 覆盖人工 / agent / HTTP / 排他网关 /
 *    FEEL 条件 / 回退连线 / DI / team / check / output / 中文与 XML 特殊字符；
 * 3. 解析 → 序列化 → 再解析后，业务字段、ID、连线、DI、中文与特殊字符无损。
 *
 * 运行：node test/bpmn-moddle.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BPMN_NAMESPACE,
  BPMNDI_NAMESPACE,
  createFsModdlePackage,
  FS_MODDLE_PACKAGE,
  FS_NAMESPACE,
  ZEEBE_NAMESPACE,
} from '../src/bpmn-moddle.js'
import { createBpmnModdle, parseBpmn } from '../src/bpmn-parse.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = join(repoRoot, 'test/fixtures/bpmn/editor-roundtrip.bpmn')

let checks = 0
let assertionCount = 0
const A = {
  equal(actual, expected, message) {
    assertionCount += 1
    assert.equal(actual, expected, message)
  },
  deepEqual(actual, expected, message) {
    assertionCount += 1
    assert.deepEqual(actual, expected, message)
  },
  ok(value, message) {
    assertionCount += 1
    assert.ok(value, message)
  },
  match(value, pattern, message) {
    assertionCount += 1
    assert.match(value, pattern, message)
  },
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

/** 找 process / 指定 id 的 flowElement。 */
function processOf(rootElement) {
  return rootElement.rootElements.find(element => element.$type === 'bpmn:Process')
}

function elementOf(proc, id) {
  return proc.flowElements.find(element => element.id === id)
}

/** `extensionElements.values` 里找某类型。 */
function extensionOf(element, type) {
  return (element.extensionElements?.values ?? []).find(value => value.$type === type)
}


/** 把 DI 投影成可比较的纯数据：形状 / 边的定位与引用。 */
function projectDiagram(rootElement) {
  const diagram = rootElement.diagrams[0]
  return {
    id: diagram.id,
    planeId: diagram.plane.id,
    processRef: diagram.plane.bpmnElement?.id ?? null,
    elements: diagram.plane.planeElement.map(item => ({
      id: item.id,
      type: item.$type,
      bpmnElement: item.bpmnElement?.id ?? null,
      bounds: item.bounds
        ? { x: item.bounds.x, y: item.bounds.y, width: item.bounds.width, height: item.bounds.height }
        : null,
      waypoints: (item.waypoint ?? []).map(point => ({ x: point.x, y: point.y })),
      isMarkerVisible: item.isMarkerVisible ?? null,
    })),
  }
}

/** 解析 fixture，返回 rootElement 与 projection。 */
async function parseFixture(moddle, xml) {
  const result = await moddle.fromXML(xml)
  A.deepEqual(result.warnings, [], '解析 fixture 不应产生 moddle 警告')
  return result.rootElement
}

const fixtureXml = readFileSync(fixturePath, 'utf8')
const moddle = createBpmnModdle()

console.log('bpmn-moddle.js')

await check('共享文件是纯常量/描述符：不 import Node、DOM、解析器，也不碰 document', async () => {
  const source = readFileSync(join(repoRoot, 'src/bpmn-moddle.js'), 'utf8')
  A.ok(!/from\s+'node:/.test(source), '不 import node: 内置模块')
  A.ok(!/from\s+'\.\/bpmn-moddle-vendor\.js'/.test(source), '不 import 解析器')
  A.ok(!/\bdocument\b/.test(source), '不碰 document')
  A.ok(!/\bwindow\b/.test(source), '不碰 window')
  A.ok(!/\brequire\s*\(/.test(source), '不调用 require()')
})

await check('描述符保持实测契约：superClass / tagAlias / 命名空间 / 字段形状', async () => {
  A.equal(FS_MODDLE_PACKAGE.name, 'fs')
  A.equal(FS_MODDLE_PACKAGE.prefix, 'fs')
  A.equal(FS_MODDLE_PACKAGE.uri, FS_NAMESPACE)
  A.equal(FS_MODDLE_PACKAGE.xml.tagAlias, 'lowerCase')
  A.equal(FS_NAMESPACE, 'http://feiyueve.dev/schema/bpmn/fs/1.0')
  A.equal(BPMN_NAMESPACE, 'http://www.omg.org/spec/BPMN/20100524/MODEL')
  A.equal(BPMNDI_NAMESPACE, 'http://www.omg.org/spec/BPMN/20100524/DI')
  A.equal(ZEEBE_NAMESPACE, 'http://camunda.org/schema/zeebe/1.0')

  const byName = new Map(FS_MODDLE_PACKAGE.types.map(type => [type.name, type]))
  for (const name of ['Node', 'Team', 'Member', 'Http', 'Executor', 'Output', 'Check', 'Legacy', 'Note', 'MaxRounds']) {
    A.ok(byName.has(name), `描述符含 ${name}`)
    A.deepEqual(byName.get(name).superClass, ['Element'], `${name} 用 superClass: ['Element']`)
  }
  const nodeProps = new Map(byName.get('Node').properties.map(property => [property.name, property]))
  A.equal(nodeProps.get('nodeType').isAttr, true)
  A.equal(nodeProps.get('provider').isAttr, true)
  A.equal(nodeProps.get('team').type, 'Team')
  A.equal(nodeProps.get('http').type, 'Http')
  A.equal(nodeProps.get('executor').type, 'Executor')
  A.equal(nodeProps.get('output').type, 'Output')
  A.equal(nodeProps.get('output').isMany, true)
  A.equal(nodeProps.get('check').type, 'Check')
  A.equal(byName.get('Team').properties.find(property => property.name === 'member').isMany, true)
})

await check('共享描述符不会被 moddle 就地改脏：每次实例化拿一份新副本', async () => {
  const fresh = createFsModdlePackage()
  A.ok(fresh !== FS_MODDLE_PACKAGE, 'createFsModdlePackage 返回新对象')
  A.equal(fresh.types[0].properties[0].name, 'nodeType', '副本是未加前缀的原始字段名')
  // 测试模块顶部已经构造过 moddle 实例；共享常量仍应保持原始字段名。
  A.equal(FS_MODDLE_PACKAGE.types[0].properties[0].name, 'nodeType', '构造 moddle 后共享常量未被改脏')
  const another = createFsModdlePackage()
  another.types[0].properties[0].name = 'changed'
  A.equal(FS_MODDLE_PACKAGE.types[0].properties[0].name, 'nodeType', '修改副本不影响共享常量')
})

await check('fixture 覆盖人工 / agent / HTTP / 网关 / FEEL / 回退 / DI / 中文与特殊字符', async () => {
  A.ok(fixtureXml.includes('bpmn:userTask'), '含人工 userTask')
  A.ok(fixtureXml.includes('fs:node nodeType="agent"'), '含 agent 节点')
  A.ok(fixtureXml.includes('fs:node nodeType="http"'), '含 HTTP 节点')
  A.ok(fixtureXml.includes('bpmn:exclusiveGateway'), '含排他网关')
  A.ok(fixtureXml.includes('language="feel"'), '含 FEEL 条件')
  A.ok(fixtureXml.includes('fs:maxRounds'), '含回退连线次数上限')
  A.ok(fixtureXml.includes('bpmndi:BPMNDiagram'), '含 DI')
  A.ok(fixtureXml.includes('fs:team') && fixtureXml.includes('fs:check') && fixtureXml.includes('fs:output'),
    '含 team / check / output')
  A.ok(fixtureXml.includes('中文'), '含中文')
  A.ok(fixtureXml.includes('&amp;') && fixtureXml.includes('&lt;'), '含 XML 特殊字符转义')
})

await check('首次解析：业务字段、扩展、条件与 DI 全部读出', async () => {
  const rootElement = await parseFixture(moddle, fixtureXml)
  A.equal(rootElement.id, 'Definitions_editor_roundtrip')
  A.equal(rootElement.targetNamespace, 'http://feiyueve.dev/test/editor-roundtrip')

  const proc = processOf(rootElement)
  A.equal(proc.id, 'Process_editor_roundtrip')
  A.equal(proc.name, '编辑往返 & 特殊字符“测试”')
  A.equal(proc.isExecutable, true)

  const human = elementOf(proc, 'Task_Human_Review')
  A.equal(human.$type, 'bpmn:UserTask')
  A.equal(human.name, '人工评审（含 & 与 <tag>）')

  const agent = elementOf(proc, 'Task_Agent_Impl')
  A.equal(agent.$type, 'bpmn:ServiceTask')
  A.equal(agent.name, 'Agent 实现：中文 & \'quotes\' "双引号"')
  const node = extensionOf(agent, 'fs:Node')
  A.ok(node, 'agent 有 fs:Node 扩展')
  A.equal(node.nodeType, 'agent')
  A.equal(node.provider, 'deepseek')
  A.equal(node.adapter, 'dsh')
  A.equal(node.model, 'deepseek-chat')
  A.equal(node.agentPreset, 'implementer')
  A.equal(node.skills, 'codegraph,web-proxy')
  A.equal(node.hooks, 'pre,post')
  A.equal(node.prompt, '你是实现者：处理 A & B，不能吞掉 <xml>。')
  A.equal(node.roleCard, '角色卡：中文标点，emoji ✅，引号“x”。')
  A.equal(node.note, '节点备注 & 保留')
  A.equal(node.team.mode, 'fanout')
  A.deepEqual(node.team.member.map(member => [member.id, member.role, member.skills, member.prompt]), [
    ['Member_1', '接口实现 & 校验', 'java,sql', '写接口，保留 <body>'],
    ['Member_2', '测试', 'node', '写测试'],
  ])
  A.equal(node.check.json, '{"kind":"contains","value":"通过 & 完成 <done>"}')
  A.deepEqual(node.output.map(output => [output.name, output.kind, output.required, output.text]), [
    ['result', 'json', true, '{"summary":"中文 & special <ok>"}'],
  ])
  A.equal(node.executor.kind, 'command')
  A.equal(node.executor.command, 'echo hi')
  A.equal(node.executor.cwd, '/path/to/project')
  A.equal(node.executor.timeoutMs, 60000)

  const http = elementOf(proc, 'Task_Http_Notify')
  const httpNode = extensionOf(http, 'fs:Node')
  A.equal(httpNode.nodeType, 'http')
  A.equal(httpNode.http.method, 'POST')
  A.equal(httpNode.http.url, 'https://example.com/hook?x=1&y=2')
  A.equal(httpNode.http.headers, '{"X-A":"1"}')
  A.equal(httpNode.http.timeoutMs, 5000)
  A.equal(httpNode.http.retries, 2)
  A.equal(httpNode.http.body, '{"ok":true,"text":"中文 & <tag>"}')
  A.equal(httpNode.http.inputMapping, '{"topic":"id"}')
  A.equal(httpNode.http.outputMapping, '{"status":"out"}')

  const gateway = elementOf(proc, 'Gateway_Approve')
  A.equal(gateway.$type, 'bpmn:ExclusiveGateway')
  A.equal(gateway.default?.id, 'Flow_reject')

  const approve = elementOf(proc, 'Flow_4')
  A.equal(approve.conditionExpression.language, 'feel')
  A.equal(approve.conditionExpression.body, '= approved && score > 0.8')
  A.equal(approve.sourceRef.id, 'Gateway_Approve')
  A.equal(approve.targetRef.id, 'Task_Http_Notify')

  const reject = elementOf(proc, 'Flow_reject')
  A.equal(reject.name, '打回')
  const maxRounds = extensionOf(reject, 'fs:MaxRounds')
  A.ok(maxRounds, '回退连线带 fs:MaxRounds')
  A.equal(maxRounds.value, 2)

  const diagram = projectDiagram(rootElement)
  A.equal(diagram.processRef, 'Process_editor_roundtrip')
  A.equal(diagram.elements.filter(item => item.type === 'bpmndi:BPMNShape').length, 6)
  A.equal(diagram.elements.filter(item => item.type === 'bpmndi:BPMNEdge').length, 6)
  const agentShape = diagram.elements.find(item => item.id === 'Task_Agent_Impl_di')
  A.deepEqual(agentShape.bounds, { x: 280, y: 197, width: 120, height: 80 })
  const rejectEdge = diagram.elements.find(item => item.id === 'Flow_reject_di')
  A.equal(rejectEdge.waypoints.length, 4)
  A.deepEqual(rejectEdge.waypoints[1], { x: 652, y: 320 })
})

await check('序列化：输出仍是带中文 / 转义 / DI 坐标的合法 BPMN XML', async () => {
  const rootElement = await parseFixture(moddle, fixtureXml)
  const { xml } = await moddle.toXML(rootElement, { format: true })
  A.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), '有 XML 声明')
  A.ok(xml.includes('<bpmn:process id="Process_editor_roundtrip"'), '保留 process id')
  A.ok(xml.includes('编辑往返'), '中文没有丢')
  A.ok(xml.includes('&amp;'), '文本里的 & 被正确转义')
  A.ok(xml.includes('&lt;xml&gt;'), '文本里的 <xml> 被正确转义')
  A.ok(xml.includes('<fs:node nodeType="agent"'), 'fs:node 小写标签保留')
  A.ok(xml.includes('<fs:maxRounds>2</fs:maxRounds>'), 'fs:maxRounds 保留')
  A.ok(xml.includes('<di:waypoint x="652" y="320" />'), 'DI 坐标保留')
  A.ok(xml.includes('<bpmn:conditionExpression'), '条件表达式保留')
})

await check('往返：再解析后业务字段 / ID / 连线 / DI / 中文与特殊字符无损', async () => {
  const first = await parseFixture(moddle, fixtureXml)
  const firstProc = processOf(first)
  const { xml } = await moddle.toXML(first, { format: true })
  const second = await parseFixture(moddle, xml)
  const secondProc = processOf(second)

  A.equal(second.id, first.id)
  A.equal(second.targetNamespace, first.targetNamespace)
  A.equal(secondProc.id, firstProc.id)
  A.equal(secondProc.name, firstProc.name)
  A.equal(secondProc.isExecutable, firstProc.isExecutable)

  const projectFlowElements = proc => proc.flowElements.map(element => ({
    type: element.$type,
    id: element.id,
    name: element.name ?? null,
    source: element.sourceRef?.id ?? null,
    target: element.targetRef?.id ?? null,
    default: element.default?.id ?? null,
    condition: element.conditionExpression
      ? { language: element.conditionExpression.language, body: element.conditionExpression.body }
      : null,
  }))
  A.deepEqual(projectFlowElements(secondProc), projectFlowElements(firstProc), 'flowElements 的类型/ID/名称/连线/条件一致')

  const firstNode = extensionOf(elementOf(firstProc, 'Task_Agent_Impl'), 'fs:Node')
  const secondNode = extensionOf(elementOf(secondProc, 'Task_Agent_Impl'), 'fs:Node')
  for (const key of ['nodeType', 'provider', 'adapter', 'model', 'agentPreset', 'skills', 'hooks', 'prompt', 'roleCard', 'note']) {
    A.equal(secondNode[key], firstNode[key], `agent fs:Node.${key} 不变`)
  }
  A.deepEqual(
    secondNode.team.member.map(member => [member.id, member.role, member.skills, member.prompt]),
    firstNode.team.member.map(member => [member.id, member.role, member.skills, member.prompt]),
    'team 成员字段不变',
  )
  A.equal(secondNode.check.json, firstNode.check.json)
  A.deepEqual(
    secondNode.output.map(output => [output.name, output.kind, output.required, output.text]),
    firstNode.output.map(output => [output.name, output.kind, output.required, output.text]),
    'output 声明不变',
  )
  A.equal(secondNode.executor.timeoutMs, firstNode.executor.timeoutMs)

  const firstHttp = extensionOf(elementOf(firstProc, 'Task_Http_Notify'), 'fs:Node').http
  const secondHttp = extensionOf(elementOf(secondProc, 'Task_Http_Notify'), 'fs:Node').http
  for (const key of ['method', 'url', 'headers', 'timeoutMs', 'retries', 'body', 'inputMapping', 'outputMapping']) {
    A.equal(secondHttp[key], firstHttp[key], `http.${key} 不变`)
  }

  const firstMax = extensionOf(elementOf(firstProc, 'Flow_reject'), 'fs:MaxRounds')
  const secondMax = extensionOf(elementOf(secondProc, 'Flow_reject'), 'fs:MaxRounds')
  A.equal(secondMax.value, firstMax.value)

  A.deepEqual(projectDiagram(second), projectDiagram(first), 'DI 图元 / 坐标 / 引用完全一致')

  // 服务端解析器与浏览器共用同一份描述符：同一份 XML 归一化后节点语义一致。
  const parsed = await parseBpmn(xml)
  A.equal(parsed.ok, true, `服务端 parseBpmn 接受往返后的 XML：${JSON.stringify(parsed.errors)}`)
  A.deepEqual(
    parsed.definition.elements.map(element => [element.id, element.kind]),
    [
      ['StartEvent_1', 'start'],
      ['Task_Agent_Impl', 'agent'],
      ['Task_Human_Review', 'human'],
      ['Gateway_Approve', 'gateway'],
      ['Task_Http_Notify', 'http'],
      ['EndEvent_1', 'end'],
    ],
  )
})

console.log(`\n共享 moddle 契约：${checks} 组通过（${assertionCount} 条断言）`)
