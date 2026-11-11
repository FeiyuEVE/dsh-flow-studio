/**
 * 初始 BPMN 模板（0.13.3）。
 *
 * 三个可直接导入 Modeler 的模板，全部带 **BPMN DI**（`bpmndi:BPMNDiagram` 与
 * `dc:Bounds` / `di:waypoint`），打开即有可读布局，不是只有语义元素的空图。
 *
 * 硬约束（与 src/bpmn-policy.js / src/bpmn-parse.js 对齐）：
 * - 恰好一个 startEvent、至少一个 endEvent；
 * - 除 endEvent 外每个节点都有出边，所有节点从 start 可达；
 * - 人工 = `bpmn:userTask`；agent = `bpmn:serviceTask` + `fs:node nodeType="agent"`；
 * - 排他网关条件必须是 FEEL（`language="feel"` 且 `=` 前缀），默认流不带条件；
 * - 不出现 parallel / inclusive 网关、scriptTask、子流程等 0.13 不支持的结构。
 *
 * @module @feiyueve/dsh-flow-studio/client/templates
 */

const DEFINITIONS_ATTRS = `xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`

function wrap(definitionId, processId, processName, processBody, shapes, edges) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${DEFINITIONS_ATTRS}
  id="${definitionId}"
  targetNamespace="http://feiyueve.dev/flow-studio/templates"
  exporter="dsh-flow-studio"
  exporterVersion="0.13.3">
  <bpmn:process id="${processId}" name="${processName}" isExecutable="true">
${processBody}
  </bpmn:process>

  <bpmndi:BPMNDiagram id="${definitionId}_diagram">
    <bpmndi:BPMNPlane id="${definitionId}_plane" bpmnElement="${processId}">
${shapes}
${edges}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`
}

const MANUAL_XML = wrap(
  'Definitions_Tpl_Manual',
  'tpl-manual',
  '最小人工流程',
  `    <bpmn:startEvent id="Start_Manual" name="开始">
      <bpmn:outgoing>Flow_Manual_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:userTask id="Human_Manual" name="人工处理">
      <bpmn:incoming>Flow_Manual_1</bpmn:incoming>
      <bpmn:outgoing>Flow_Manual_2</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:endEvent id="End_Manual" name="结束">
      <bpmn:incoming>Flow_Manual_2</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_Manual_1" sourceRef="Start_Manual" targetRef="Human_Manual" />
    <bpmn:sequenceFlow id="Flow_Manual_2" sourceRef="Human_Manual" targetRef="End_Manual" />`,
  `      <bpmndi:BPMNShape id="Start_Manual_di" bpmnElement="Start_Manual">
        <dc:Bounds x="179" y="219" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Human_Manual_di" bpmnElement="Human_Manual">
        <dc:Bounds x="280" y="197" width="120" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="End_Manual_di" bpmnElement="End_Manual">
        <dc:Bounds x="452" y="219" width="36" height="36" />
      </bpmndi:BPMNShape>`,
  `      <bpmndi:BPMNEdge id="Flow_Manual_1_di" bpmnElement="Flow_Manual_1">
        <di:waypoint x="215" y="237" />
        <di:waypoint x="280" y="237" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_Manual_2_di" bpmnElement="Flow_Manual_2">
        <di:waypoint x="400" y="237" />
        <di:waypoint x="452" y="237" />
      </bpmndi:BPMNEdge>`,
)

const AGENT_HUMAN_XML = wrap(
  'Definitions_Tpl_Agent_Human',
  'tpl-agent-human',
  'Agent 执行 + 人工确认',
  `    <bpmn:startEvent id="Start_Agent" name="开始">
      <bpmn:outgoing>Flow_Agent_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="Agent_Work" name="Agent 执行">
      <bpmn:incoming>Flow_Agent_1</bpmn:incoming>
      <bpmn:outgoing>Flow_Agent_2</bpmn:outgoing>
      <bpmn:extensionElements>
        <fs:node nodeType="agent" adapter="dsh">
          <fs:prompt>你是实现者：完成当前任务，输出改动与验证结果。</fs:prompt>
        </fs:node>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:userTask id="Human_Confirm" name="人工确认">
      <bpmn:incoming>Flow_Agent_2</bpmn:incoming>
      <bpmn:outgoing>Flow_Agent_3</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:endEvent id="End_Agent" name="结束">
      <bpmn:incoming>Flow_Agent_3</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_Agent_1" sourceRef="Start_Agent" targetRef="Agent_Work" />
    <bpmn:sequenceFlow id="Flow_Agent_2" sourceRef="Agent_Work" targetRef="Human_Confirm" />
    <bpmn:sequenceFlow id="Flow_Agent_3" sourceRef="Human_Confirm" targetRef="End_Agent" />`,
  `      <bpmndi:BPMNShape id="Start_Agent_di" bpmnElement="Start_Agent">
        <dc:Bounds x="179" y="219" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Agent_Work_di" bpmnElement="Agent_Work">
        <dc:Bounds x="280" y="197" width="120" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Human_Confirm_di" bpmnElement="Human_Confirm">
        <dc:Bounds x="452" y="197" width="120" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="End_Agent_di" bpmnElement="End_Agent">
        <dc:Bounds x="624" y="219" width="36" height="36" />
      </bpmndi:BPMNShape>`,
  `      <bpmndi:BPMNEdge id="Flow_Agent_1_di" bpmnElement="Flow_Agent_1">
        <di:waypoint x="215" y="237" />
        <di:waypoint x="280" y="237" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_Agent_2_di" bpmnElement="Flow_Agent_2">
        <di:waypoint x="400" y="237" />
        <di:waypoint x="452" y="237" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_Agent_3_di" bpmnElement="Flow_Agent_3">
        <di:waypoint x="572" y="237" />
        <di:waypoint x="624" y="237" />
      </bpmndi:BPMNEdge>`,
)

const GATEWAY_XML = wrap(
  'Definitions_Tpl_Exclusive_Gateway',
  'tpl-exclusive-gateway',
  '人工审批 + 排他网关',
  `    <bpmn:startEvent id="Start_Gateway" name="开始">
      <bpmn:outgoing>Flow_Gateway_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:userTask id="Human_Review" name="人工审批">
      <bpmn:incoming>Flow_Gateway_1</bpmn:incoming>
      <bpmn:incoming>Flow_Gateway_Reject</bpmn:incoming>
      <bpmn:outgoing>Flow_Gateway_2</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:exclusiveGateway id="Gateway_Approve" name="是否通过？" default="Flow_Gateway_Reject">
      <bpmn:incoming>Flow_Gateway_2</bpmn:incoming>
      <bpmn:outgoing>Flow_Gateway_Approve</bpmn:outgoing>
      <bpmn:outgoing>Flow_Gateway_Reject</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:endEvent id="End_Gateway" name="结束">
      <bpmn:incoming>Flow_Gateway_Approve</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_Gateway_1" sourceRef="Start_Gateway" targetRef="Human_Review" />
    <bpmn:sequenceFlow id="Flow_Gateway_2" sourceRef="Human_Review" targetRef="Gateway_Approve" />
    <bpmn:sequenceFlow id="Flow_Gateway_Approve" name="通过" sourceRef="Gateway_Approve" targetRef="End_Gateway">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="feel">= approved</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="Flow_Gateway_Reject" name="打回" sourceRef="Gateway_Approve" targetRef="Human_Review">
      <bpmn:extensionElements>
        <fs:maxRounds>3</fs:maxRounds>
      </bpmn:extensionElements>
    </bpmn:sequenceFlow>`,
  `      <bpmndi:BPMNShape id="Start_Gateway_di" bpmnElement="Start_Gateway">
        <dc:Bounds x="179" y="219" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Human_Review_di" bpmnElement="Human_Review">
        <dc:Bounds x="280" y="197" width="120" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Gateway_Approve_di" bpmnElement="Gateway_Approve" isMarkerVisible="true">
        <dc:Bounds x="455" y="212" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="End_Gateway_di" bpmnElement="End_Gateway">
        <dc:Bounds x="574" y="219" width="36" height="36" />
      </bpmndi:BPMNShape>`,
  `      <bpmndi:BPMNEdge id="Flow_Gateway_1_di" bpmnElement="Flow_Gateway_1">
        <di:waypoint x="215" y="237" />
        <di:waypoint x="280" y="237" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_Gateway_2_di" bpmnElement="Flow_Gateway_2">
        <di:waypoint x="400" y="237" />
        <di:waypoint x="455" y="237" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_Gateway_Approve_di" bpmnElement="Flow_Gateway_Approve">
        <di:waypoint x="505" y="237" />
        <di:waypoint x="574" y="237" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_Gateway_Reject_di" bpmnElement="Flow_Gateway_Reject">
        <di:waypoint x="480" y="212" />
        <di:waypoint x="480" y="160" />
        <di:waypoint x="340" y="160" />
        <di:waypoint x="340" y="197" />
      </bpmndi:BPMNEdge>`,
)

/** 模板目录：`id` 稳定（UI 选项 / 测试用），`xml` 是完整 BPMN 2.0 + DI。 */
export const BPMN_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'manual',
    name: '最小人工流程',
    description: '开始 → 人工处理 → 结束，适合验证画布与实例待办。',
    processId: 'tpl-manual',
    xml: MANUAL_XML,
  }),
  Object.freeze({
    id: 'agent-human',
    name: 'Agent 执行 + 人工确认',
    description: 'Agent 先执行，再停在人工确认；演示 serviceTask + userTask。',
    processId: 'tpl-agent-human',
    xml: AGENT_HUMAN_XML,
  }),
  Object.freeze({
    id: 'exclusive-gateway',
    name: '人工审批 + 排他网关',
    description: '人工审批后按 approved 分支：通过结束，打回回到人工（最多 3 轮）。',
    processId: 'tpl-exclusive-gateway',
    xml: GATEWAY_XML,
  }),
])

/** 模板元数据（不含 XML），给下拉菜单用。 */
export function listTemplates() {
  return BPMN_TEMPLATES.map(template => ({
    id: template.id,
    name: template.name,
    description: template.description,
    processId: template.processId,
  }))
}

/** 按 id 取模板；不存在返回 null。 */
export function getTemplate(id) {
  if (typeof id !== 'string' || id === '') return null
  return BPMN_TEMPLATES.find(template => template.id === id) || null
}

/** 按 id 取 XML 正本；不存在返回 null。 */
export function templateXml(id) {
  const template = getTemplate(id)
  return template === null ? null : template.xml
}
