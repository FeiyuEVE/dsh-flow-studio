#!/usr/bin/env node
/**
 * BPMN 解析与校验自检：归一化模型、fs:/zeebe: 扩展、六条 0.13.0 硬校验、回退环放行。
 *
 * 直接 `node test/bpmn-parse.test.mjs`；不启动 dsh、不写盘。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { FS_NAMESPACE, parseBpmn } from '../src/bpmn-parse.js'

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
      message || `期望包含「${needle}」，实际：${haystack}`,
    )
  },
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

function xml(processBody, options = {}) {
  const processAttrs = options.processAttrs || 'id="proc" name="测试流程" isExecutable="true"'
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:fs="${FS_NAMESPACE}"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://feiyueve.dev/test">
  <bpmn:process ${processAttrs}>
${processBody}
  </bpmn:process>
</bpmn:definitions>`
}

function agentExtension(attrs = 'nodeType="agent"') {
  return `<bpmn:extensionElements><fs:node ${attrs} /></bpmn:extensionElements>`
}

/** 找错误 / 警告。 */
const hasCode = (list, code) => list.some(item => item && item.code === code)

const VALID_PROCESS = `
    <bpmn:startEvent id="start" name="开始" />
    <bpmn:serviceTask id="agent" name="实现">
      <bpmn:extensionElements>
        <fs:node nodeType="agent" provider="deepseek" adapter="dsh" skills="codegraph,web-proxy" hooks="pre,post">
          <fs:prompt>你是实现者</fs:prompt>
          <fs:roleCard>角色卡</fs:roleCard>
          <fs:note>节点备注</fs:note>
          <fs:team mode="fanout">
            <fs:member id="m1" role="接口实现" skills="java"><fs:prompt>写接口</fs:prompt></fs:member>
          </fs:team>
        </fs:node>
        <zeebe:ioMapping>
          <zeebe:input source="= topic" target="prompt" />
          <zeebe:output source="= result" target="out" />
        </zeebe:ioMapping>
        <fs:note>独立备注</fs:note>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:userTask id="human" name="评审" />
    <bpmn:serviceTask id="http" name="通知">
      <bpmn:extensionElements>
        <fs:node nodeType="http">
          <fs:http method="POST" url="https://example.com/hook" headers='{"X-A":"1"}' timeoutMs="5000" retries="2">
            <fs:body>{"ok":true}</fs:body>
            <fs:inputMapping>{"topic":"id"}</fs:inputMapping>
            <fs:outputMapping>{"status":"out"}</fs:outputMapping>
          </fs:http>
        </fs:node>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:exclusiveGateway id="gw" name="判断" default="f5" />
    <bpmn:endEvent id="end" name="结束" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent" />
    <bpmn:sequenceFlow id="f2" sourceRef="agent" targetRef="human" />
    <bpmn:sequenceFlow id="f3" sourceRef="human" targetRef="gw">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="feel">= score &gt; 0.8</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f4" sourceRef="gw" targetRef="http">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="feel">= ok</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f5" sourceRef="gw" targetRef="end" />
    <bpmn:sequenceFlow id="f6" sourceRef="http" targetRef="end" />
`

console.log('bpmn-parse.js')

await check('合法 XML：fs:node / zeebe:ioMapping / 三种节点 kind / 条件与默认流', async () => {
  const source = xml(VALID_PROCESS)
  const result = await parseBpmn(source)
  A.equal(result.ok, true, `合法 XML 必须通过：${JSON.stringify(result.errors)}`)
  A.deepEqual(result.errors, [])

  const { definition } = result
  A.equal(definition.id, 'proc')
  A.equal(definition.name, '测试流程')
  A.equal(definition.startId, 'start')
  A.deepEqual(definition.endIds, ['end'])
  A.equal(definition.elements.length, 6)
  A.equal(definition.flows.length, 6)
  A.deepEqual(
    definition.elements.map(element => element.type),
    ['startEvent', 'serviceTask', 'userTask', 'serviceTask', 'exclusiveGateway', 'endEvent'],
  )
  A.deepEqual(
    definition.elements.map(element => element.kind),
    ['start', 'agent', 'human', 'http', 'gateway', 'end'],
  )

  const byId = new Map(definition.elements.map(element => [element.id, element]))
  const agent = byId.get('agent')
  A.equal(agent.node.kind, 'agent')
  A.equal(agent.node.provider, 'deepseek')
  A.equal(agent.node.adapter, 'dsh')
  A.deepEqual(agent.node.skills, ['codegraph', 'web-proxy'])
  A.deepEqual(agent.node.hooks, ['pre', 'post'])
  A.equal(agent.node.prompt, '你是实现者')
  A.equal(agent.node.roleCard, '角色卡')
  A.equal(agent.node.team.mode, 'fanout')
  A.equal(agent.node.team.members.length, 1)
  A.equal(agent.node.team.members[0].id, 'm1')
  A.equal(agent.node.team.members[0].role, '接口实现')
  A.deepEqual(agent.node.team.members[0].skills, ['java'])
  A.equal(agent.node.http, null)

  // zeebe:ioMapping：可加性字段 element.ioMapping（契约里没有，见交付说明）。
  A.deepEqual(agent.ioMapping, {
    input: [{ source: '= topic', target: 'prompt' }],
    output: [{ source: '= result', target: 'out' }],
  })

  // fs:note 两种位置都读得到：fs:node 里的与 extensionElements 下独立的。
  A.equal(agent.extensions.length, 2)
  A.equal(agent.extensions[0].type, 'fs:Note')
  A.equal(agent.extensions[0].name, 'note')
  A.equal(agent.extensions[0].value, '节点备注')
  A.equal(agent.extensions[1].value, '独立备注')

  A.equal(byId.get('human').kind, 'human')
  A.equal(byId.get('human').node.kind, 'human')
  A.equal(byId.get('human').node.provider, null)

  const httpNode = byId.get('http')
  A.equal(httpNode.kind, 'http')
  A.equal(httpNode.node.kind, 'http')
  A.equal(httpNode.node.http.method, 'POST')
  A.equal(httpNode.node.http.url, 'https://example.com/hook')
  A.deepEqual(httpNode.node.http.headers, { 'X-A': '1' })
  A.equal(httpNode.node.http.timeoutMs, 5000)
  A.equal(httpNode.node.http.retries, 2)
  A.equal(httpNode.node.http.body, '{"ok":true}')
  A.equal(httpNode.node.http.inputMapping, '{"topic":"id"}')
  A.equal(httpNode.node.http.outputMapping, '{"status":"out"}')

  A.equal(byId.get('gw').kind, 'gateway')
  A.equal(byId.get('gw').node, null)
  A.equal(byId.get('start').node, null)

  const flowById = new Map(definition.flows.map(flow => [flow.id, flow]))
  A.deepEqual(flowById.get('f3').condition, { expression: '= score > 0.8', language: 'feel' })
  A.equal(flowById.get('f5').isDefault, true)
  A.equal(flowById.get('f4').isDefault, false)
  A.equal(flowById.get('f1').condition, null)
  A.deepEqual(flowById.get('f1').extensions, [])

  A.deepEqual(result.warnings, [], `合法 XML 不该有 warning：${JSON.stringify(result.warnings)}`)
  A.deepEqual(definition.warnings, result.warnings)

  // 模板域不可变校验用：对 XML 原文做 sha256 小写 hex。
  const expectedHash = createHash('sha256').update(source, 'utf8').digest('hex')
  A.equal(definition.hash, expectedHash)
  A.ok(/^[0-9a-f]{64}$/.test(definition.hash), 'definition.hash 必须是 64 位小写 hex')
})

await check('契约扩展 5 字段：model / agentPreset / executor / outputs / check 读回', async () => {
  const source = xml(`
    <bpmn:startEvent id="start" />
    <bpmn:serviceTask id="task">
      <bpmn:extensionElements>
        <fs:node nodeType="agent" model="deepseek/deepseek-chat" agentPreset="specialist">
          <fs:executor kind="codex" command="codex --dangerously-bypass" cwd="/work"
            env='{"A":"B"}' timeoutMs="5000" schemaPath="/schema.json" />
          <fs:output>交付说明</fs:output>
          <fs:output name="变更清单" kind="md" required="true" />
          <fs:check>{"command":"npm test","expectExitCode":0,"timeoutMs":120000}</fs:check>
        </fs:node>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="task" />
    <bpmn:sequenceFlow id="f2" sourceRef="task" targetRef="end" />
  `)
  const result = await parseBpmn(source)
  A.equal(result.ok, true, `扩展字段 XML 必须通过：${JSON.stringify(result.errors)}`)
  const node = result.definition.elements.find(element => element.id === 'task').node
  A.equal(node.model, 'deepseek/deepseek-chat')
  A.equal(node.agentPreset, 'specialist')
  A.deepEqual(node.executor, {
    kind: 'codex',
    command: 'codex --dangerously-bypass',
    cwd: '/work',
    env: { A: 'B' },
    timeoutMs: 5000,
    schemaPath: '/schema.json',
  })
  A.deepEqual(node.outputs, ['交付说明', { name: '变更清单', kind: 'md', required: true }])
  A.deepEqual(node.check, { command: 'npm test', expectExitCode: 0, timeoutMs: 120000 })
})

await check('回退环：放行（ok:true），warnings 里提示「存在回退环」', async () => {
  const process = `
    <bpmn:startEvent id="start" />
    <bpmn:serviceTask id="dev">
      ${agentExtension()}
    </bpmn:serviceTask>
    <bpmn:serviceTask id="review">
      ${agentExtension()}
    </bpmn:serviceTask>
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="dev" />
    <bpmn:sequenceFlow id="f2" sourceRef="dev" targetRef="review" />
    <bpmn:sequenceFlow id="f3" sourceRef="review" targetRef="end" />
    <bpmn:sequenceFlow id="f4" sourceRef="review" targetRef="dev">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="feel">= true</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  `
  const result = await parseBpmn(xml(process))
  A.equal(result.ok, true, `回退环不该报错：${JSON.stringify(result.errors)}`)
  A.equal(hasCode(result.warnings, 'RETURN_LOOP'), true, '必须提示存在回退环')
  const loop = result.warnings.find(item => item.code === 'RETURN_LOOP')
  A.includes(loop.message, '回退环')
})

await check('反例 1/6：parallelGateway 禁止', async () => {
  const process = `
    <bpmn:startEvent id="start" />
    <bpmn:parallelGateway id="fork" />
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="fork" />
    <bpmn:sequenceFlow id="f2" sourceRef="fork" targetRef="end" />
  `
  const result = await parseBpmn(xml(process))
  A.equal(result.ok, false)
  A.equal(hasCode(result.errors, 'PARALLEL_GATEWAY_FORBIDDEN'), true)
})

await check('反例 2/6：language="javascript" 条件禁止', async () => {
  const process = `
    <bpmn:startEvent id="start" />
    <bpmn:serviceTask id="task">
      ${agentExtension()}
    </bpmn:serviceTask>
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="task" />
    <bpmn:sequenceFlow id="f2" sourceRef="task" targetRef="end">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="javascript">= process.exit(1)</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  `
  const result = await parseBpmn(xml(process))
  A.equal(result.ok, false)
  A.equal(hasCode(result.errors, 'CONDITION_LANGUAGE_NOT_FEEL'), true)
  const error = result.errors.find(item => item.code === 'CONDITION_LANGUAGE_NOT_FEEL')
  A.includes(error.message, 'javascript')
})

await check('反例 3/6：裸表达式（无 language、无 = 前缀）禁止', async () => {
  const process = `
    <bpmn:startEvent id="start" />
    <bpmn:serviceTask id="task">
      ${agentExtension()}
    </bpmn:serviceTask>
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="task" />
    <bpmn:sequenceFlow id="f2" sourceRef="task" targetRef="end">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">amount &gt; 1</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  `
  const result = await parseBpmn(xml(process))
  A.equal(result.ok, false)
  A.equal(hasCode(result.errors, 'CONDITION_BARE_EXPRESSION'), true)
})

await check('反例 4/6：不可达节点禁止', async () => {
  const process = `
    <bpmn:startEvent id="start" />
    <bpmn:serviceTask id="orphan">
      ${agentExtension()}
    </bpmn:serviceTask>
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="end" />
    <bpmn:sequenceFlow id="f2" sourceRef="orphan" targetRef="end" />
  `
  const result = await parseBpmn(xml(process))
  A.equal(result.ok, false)
  A.equal(hasCode(result.errors, 'UNREACHABLE_NODE'), true)
  const error = result.errors.find(item => item.code === 'UNREACHABLE_NODE')
  A.equal(error.elementId, 'orphan')
})

await check('反例 5/6：serviceTask 缺 fs:node 禁止', async () => {
  const process = `
    <bpmn:startEvent id="start" />
    <bpmn:serviceTask id="task" />
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="task" />
    <bpmn:sequenceFlow id="f2" sourceRef="task" targetRef="end" />
  `
  const result = await parseBpmn(xml(process))
  A.equal(result.ok, false)
  A.equal(hasCode(result.errors, 'SERVICE_TASK_WITHOUT_FS_NODE'), true)
  const task = result.definition.elements.find(element => element.id === 'task')
  A.equal(task.kind, 'unknown')
  A.equal(task.node, null)

  const badType = await parseBpmn(xml(`
    <bpmn:startEvent id="start" />
    <bpmn:serviceTask id="task">
      <bpmn:extensionElements>
        <fs:node nodeType="script" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="task" />
    <bpmn:sequenceFlow id="f2" sourceRef="task" targetRef="end" />
  `))
  A.equal(badType.ok, false)
  A.equal(hasCode(badType.errors, 'SERVICE_TASK_NODE_TYPE_INVALID'), true)
})

await check('反例 6/6：flow 指向不存在的节点禁止', async () => {
  const process = `
    <bpmn:startEvent id="start" />
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="end" />
    <bpmn:sequenceFlow id="bad" sourceRef="start" targetRef="ghost" />
  `
  const result = await parseBpmn(xml(process))
  A.equal(result.ok, false)
  A.equal(hasCode(result.errors, 'FLOW_UNKNOWN_REFERENCE'), true)
  const bad = result.definition.flows.find(flow => flow.id === 'bad')
  A.equal(bad.to, null)
})

await check('附加：inclusiveGateway / multiInstanceLoopCharacteristics 也禁止', async () => {
  const inclusive = await parseBpmn(xml(`
    <bpmn:startEvent id="start" />
    <bpmn:inclusiveGateway id="inc" />
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="inc" />
    <bpmn:sequenceFlow id="f2" sourceRef="inc" targetRef="end" />
  `))
  A.equal(inclusive.ok, false)
  A.equal(hasCode(inclusive.errors, 'INCLUSIVE_GATEWAY_FORBIDDEN'), true)

  const multi = await parseBpmn(xml(`
    <bpmn:startEvent id="start" />
    <bpmn:serviceTask id="task">
      <bpmn:extensionElements>
        <fs:node nodeType="agent" />
      </bpmn:extensionElements>
      <bpmn:multiInstanceLoopCharacteristics isSequential="false" />
    </bpmn:serviceTask>
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="task" />
    <bpmn:sequenceFlow id="f2" sourceRef="task" targetRef="end" />
  `))
  A.equal(multi.ok, false)
  A.equal(hasCode(multi.errors, 'MULTI_INSTANCE_FORBIDDEN'), true)
})

await check('附加：0 个 / 多个 startEvent 都报错', async () => {
  const noStart = await parseBpmn(xml(`
    <bpmn:endEvent id="end" />
  `))
  A.equal(noStart.ok, false)
  A.equal(hasCode(noStart.errors, 'NO_START_EVENT'), true)

  const manyStarts = await parseBpmn(xml(`
    <bpmn:startEvent id="s1" />
    <bpmn:startEvent id="s2" />
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="f1" sourceRef="s1" targetRef="end" />
    <bpmn:sequenceFlow id="f2" sourceRef="s2" targetRef="end" />
  `))
  A.equal(manyStarts.ok, false)
  A.equal(hasCode(manyStarts.errors, 'MULTIPLE_START_EVENTS'), true)
  A.equal(manyStarts.definition.startId, null)
})

await check('附加：serviceTask 缺出边 / 空 XML / 非 XML 都收敛成 ok:false', async () => {
  const noOutgoing = await parseBpmn(xml(`
    <bpmn:startEvent id="start" />
    <bpmn:serviceTask id="task">
      ${agentExtension()}
    </bpmn:serviceTask>
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="task" />
  `))
  A.equal(noOutgoing.ok, false)
  A.equal(hasCode(noOutgoing.errors, 'NODE_WITHOUT_OUTGOING'), true)

  const empty = await parseBpmn('')
  A.equal(empty.ok, false)
  A.equal(hasCode(empty.errors, 'BPMN_XML_EMPTY'), true)

  let garbage
  await assert.doesNotReject(async () => {
    garbage = await parseBpmn('这不是 XML')
  }, 'parseBpmn 不能 reject')
  A.equal(garbage.ok, false)
  A.equal(garbage.definition, null)
  A.equal(hasCode(garbage.errors, 'BPMN_PARSE_ERROR'), true)
})


// ---------------------------------------------------------------------------
// A1 · 执行白名单：归一化之前就拒绝（条件/循环/白名单外结构）
// ---------------------------------------------------------------------------

/** 一条最小的 start → serviceTask → end，body 可替换。 */
function execXml(parts) {
  return xml(`
    ${parts.elements}
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="mid" />
    <bpmn:sequenceFlow id="f2" sourceRef="mid" targetRef="end" />
  `)
}

const blockedCases = [
  {
    name: '条件 startEvent（= 1 > 2）',
    code: 'BPMN_CONDITIONAL_EVENT_FORBIDDEN',
    elements: `
      <bpmn:startEvent id="start">
        <bpmn:conditionalEventDefinition id="ced">
          <bpmn:condition xsi:type="bpmn:tFormalExpression" language="feel">= 1 &gt; 2</bpmn:condition>
        </bpmn:conditionalEventDefinition>
      </bpmn:startEvent>
      <bpmn:userTask id="mid" />
      <bpmn:endEvent id="end" />`,
  },
  {
    name: '条件 endEvent',
    code: 'BPMN_CONDITIONAL_EVENT_FORBIDDEN',
    elements: `
      <bpmn:startEvent id="start" />
      <bpmn:userTask id="mid" />
      <bpmn:endEvent id="end">
        <bpmn:conditionalEventDefinition id="ced"><bpmn:condition xsi:type="bpmn:tFormalExpression" language="feel">= true</bpmn:condition></bpmn:conditionalEventDefinition>
      </bpmn:endEvent>`,
  },
  {
    name: 'timer startEvent（其它事件定义）',
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    elements: `
      <bpmn:startEvent id="start"><bpmn:timerEventDefinition id="ted"><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT1S</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:startEvent>
      <bpmn:userTask id="mid" />
      <bpmn:endEvent id="end" />`,
  },
  {
    name: 'standardLoopCharacteristics',
    code: 'BPMN_STANDARD_LOOP_FORBIDDEN',
    elements: `
      <bpmn:startEvent id="start" />
      <bpmn:serviceTask id="mid">
        <bpmn:extensionElements><fs:node nodeType="agent" /></bpmn:extensionElements>
        <bpmn:standardLoopCharacteristics testBefore="false" />
      </bpmn:serviceTask>
      <bpmn:endEvent id="end" />`,
  },
  {
    name: 'scriptTask（node:vm 不是沙箱）',
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    elements: `
      <bpmn:startEvent id="start" />
      <bpmn:scriptTask id="mid" scriptFormat="javascript">process.exit(1)</bpmn:scriptTask>
      <bpmn:endEvent id="end" />`,
  },
  {
    name: 'subProcess',
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    elements: `
      <bpmn:startEvent id="start" />
      <bpmn:subProcess id="mid"><bpmn:startEvent id="s2" /><bpmn:endEvent id="e2" /><bpmn:sequenceFlow id="f9" sourceRef="s2" targetRef="e2" /></bpmn:subProcess>
      <bpmn:endEvent id="end" />`,
  },
  {
    name: 'callActivity',
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    elements: `
      <bpmn:startEvent id="start" />
      <bpmn:callActivity id="mid" calledElement="Other" />
      <bpmn:endEvent id="end" />`,
  },
  {
    name: 'eventBasedGateway',
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    elements: `
      <bpmn:startEvent id="start" />
      <bpmn:eventBasedGateway id="mid" />
      <bpmn:endEvent id="end" />`,
  },
  {
    name: 'serviceTask implementation（内置 resolveExpression）',
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    elements: `
      <bpmn:startEvent id="start" />
      <bpmn:serviceTask id="mid" implementation="##WebService">
        <bpmn:extensionElements><fs:node nodeType="agent" /></bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:endEvent id="end" />`,
  },
  {
    name: 'boundaryEvent',
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    elements: `
      <bpmn:startEvent id="start" />
      <bpmn:userTask id="mid" />
      <bpmn:boundaryEvent id="b" attachedToRef="mid" />
      <bpmn:endEvent id="end" />`,
  },
]

for (const item of blockedCases) {
  await check(`执行白名单：${item.name} → ${item.code}`, async () => {
    const result = await parseBpmn(execXml({ elements: item.elements }))
    A.equal(result.ok, false, `${item.name} 必须被拒绝`)
    A.equal(hasCode(result.errors, item.code), true, `${item.name} 必须报 ${item.code}；实际 ${JSON.stringify(result.errors.map(e => e.code))}`)
    // 解析器不能把不支持的执行元素归一成可执行节点（否则 handler 会被派发）。
    if (item.code === 'BPMN_CONDITIONAL_EVENT_FORBIDDEN' || item.code === 'BPMN_EXECUTION_UNSUPPORTED') {
      A.equal(result.errors.every(error => error.code !== 'BPMN_PARSE_ERROR'), true, '必须是结构化拒绝，不是解析失败')
    }
  })
}

await check('执行白名单：条件 startEvent 的 `= 1 > 2` 不会被当成可执行条件（handler 侧另有 runner 测试）', async () => {
  const result = await parseBpmn(execXml({
    elements: `
      <bpmn:startEvent id="start">
        <bpmn:conditionalEventDefinition id="ced">
          <bpmn:condition xsi:type="bpmn:tFormalExpression">= 1 &gt; 2</bpmn:condition>
        </bpmn:conditionalEventDefinition>
      </bpmn:startEvent>
      <bpmn:userTask id="mid" />
      <bpmn:endEvent id="end" />`,
  }))
  A.equal(result.ok, false)
  A.equal(hasCode(result.errors, 'BPMN_CONDITIONAL_EVENT_FORBIDDEN'), true, '无 language 的条件事件同样拒绝')
})

console.log(`\n${checks} 组通过（${assertions} 条断言）`)
