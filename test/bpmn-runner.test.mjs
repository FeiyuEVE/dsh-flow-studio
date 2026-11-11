#!/usr/bin/env node
/**
 * bpmn-runner.js 自检：引擎适配层的六条主用例 + 加载期校验。
 *
 * 覆盖（对应任务书 1–6，另加条件求值归属与加载期校验）：
 *   1. XML 夹具跑通「startEvent → serviceTask(agent) → userTask → exclusiveGateway →
 *      条件回退 / 另一条到 endEvent」：事件顺序、flow/taken、activity/wait、
 *      signalTask 续跑、process/end，以及 FEEL `= approved = false` 在 approved=true
 *      时**不得**走回退边（防「恒真」回归）。
 *   2. 跨实例恢复：A 停到 activity/wait → getState() → JSON 序列化 → 全新实例 B
 *      recover(state) → signalTask → 跑到结束；断言 B 没有复用 A 的对象（B 的事件流从
 *      重放的 activity/wait 开始、没有 process/start，A 被留在了原地）。
 *   3. FEEL `= false` 必走默认边；`= approved = false` 的假分支也真的会走回退边；
 *      `evaluateCondition` 注入点生效（上层 bpmn-expr 的落点）。
 *   4. agent handler 抛错 → runner 转 blocked + onError + error 事件（实例只写 lastError）。
 *   5. activityWaitMs 超时 → runner blocked（永不 resolve 的 handler；同时 userTask 等待超时）。
 *   6. LRU：max=1 启两个实例，第一个被淘汰；**未落 state** 时淘汰必须报错（不静默丢）。
 *
 * 另外四组（0.13 的红线锚 + 迁移必须）：
 *   - 快照只在 activity/wait 与 activity/end 之后触发（`shouldSnapshot` 看到的类型集合）；
 *   - 条件求值归本模块（`bpmn-expr.evaluateFeel`）：`= 1 > 2` 不通行、`= 1 + 1 = 2` 通行、
 *     非法表达式 → error + runner blocked、`${...}` 引擎内置语法一律拒绝；
 *   - 加载期校验：缺 handler / 未知 kind / javascript 条件 / parallelGateway / 默认流条件；
 *   - 连线通过次数上限（`fs:maxRounds` → `maxTakes`）+ 通用循环护栏（`BPMN_LOOP_LIMIT`）：
 *     `= true` 的成环连线必须有上限，否则流程会无限重跑；flow 的 `extensions` 原样保留。
 *
 * 全部走假 handler：不调真模型、不读 `~/.dsh`、不写任何文件、不装 dsh 宿主。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { activeInstanceCount, bpmnXmlFromDefinition, createBpmnRunner } from '../src/bpmn-runner.js'
import { parseBpmn } from '../src/bpmn-parse.js'

let checks = 0
let asserts = 0

/** 每条断言都计数（`A.rejects` 这类返回 Promise 的也照常工作）。 */
const A = new Proxy(assert, {
  get(target, property) {
    const value = target[property]
    if (typeof value !== 'function') return value
    return (...args) => {
      asserts += 1
      return value.apply(target, args)
    }
  },
})

/** 每个用例里创建的实例都登记下来，用例结束统一 stop（同时把它们从活跃表摘掉）。 */
const openRunners = []

function track(runner) {
  openRunners.push(runner)
  return runner
}

/**
 * runner 现在必须带 `definitionIdentity`（state v2 信封的必填身份）。
 * 测试里按「实际执行 XML」重算 sha256——与 runtime 的做法一致：不信调用方自报。
 */
function identityOf(options) {
  const sourceXml = options.xml ?? bpmnXmlFromDefinition(options.definition)
  return {
    id: options.definition?.id ?? 'unknown-definition',
    version: 1,
    hash: createHash('sha256').update(sourceXml, 'utf8').digest('hex'),
  }
}

/** 测试用 runner 工厂：默认自动补 identity，其余选项原样透传。 */
function createRunner(options) {
  return createBpmnRunner({
    ...options,
    definitionIdentity: options.definitionIdentity ?? identityOf(options),
  })
}

async function check(name, fn) {
  try {
    await fn()
  } finally {
    for (const runner of openRunners.splice(0)) {
      try {
        await runner.stop()
      } catch {
        // 用例自己已经处理过失败：清理阶段的错误不该掩盖真正的断言结果。
      }
    }
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

// ---------------------------------------------------------------------------
// 夹具：一份最小 BPMN XML + 与它对应的 definition（跨模块契约形状）
// ---------------------------------------------------------------------------

/**
 * `startEvent → serviceTask(agent) → userTask → exclusiveGateway`
 *   - `f_back`：条件 `= approved = false` → 回到 serviceTask（成环重跑）
 *   - `f_ok`：默认流 → endEvent
 *
 * 用 XML 作为执行正本（`xml` 入参优先）；definition 只负责「活动 id → 语义 → handler」。
 */
const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  id="Definitions_fixture" targetNamespace="http://dsh.local/bpmn">
  <bpmn:process id="Fixture_1" name="评审闭环" isExecutable="true">
    <bpmn:startEvent id="n_start" name="开始">
      <bpmn:outgoing>f_start_agent</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="n_agent" name="写代码">
      <bpmn:incoming>f_start_agent</bpmn:incoming>
      <bpmn:incoming>f_back</bpmn:incoming>
      <bpmn:outgoing>f_agent_human</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:userTask id="n_human" name="人审">
      <bpmn:incoming>f_agent_human</bpmn:incoming>
      <bpmn:outgoing>f_human_gw</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:exclusiveGateway id="n_gw" name="过不过" default="f_ok">
      <bpmn:incoming>f_human_gw</bpmn:incoming>
      <bpmn:outgoing>f_back</bpmn:outgoing>
      <bpmn:outgoing>f_ok</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:endEvent id="n_end" name="完成">
      <bpmn:incoming>f_ok</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="f_start_agent" sourceRef="n_start" targetRef="n_agent" />
    <bpmn:sequenceFlow id="f_agent_human" sourceRef="n_agent" targetRef="n_human" />
    <bpmn:sequenceFlow id="f_human_gw" sourceRef="n_human" targetRef="n_gw" />
    <bpmn:sequenceFlow id="f_back" sourceRef="n_gw" targetRef="n_agent">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="feel">= approved = false</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_ok" sourceRef="n_gw" targetRef="n_end" />
  </bpmn:process>
</bpmn:definitions>
`

/** 与 XML 对应的 definition（跨模块契约形状，`kind` + `node` 由解析器给）。 */
function makeDefinition(overrides = {}) {
  const definition = {
    id: 'def-review',
    name: '评审闭环',
    startId: 'n_start',
    endIds: ['n_end'],
    elements: [
      { id: 'n_start', type: 'bpmn:StartEvent', name: '开始', kind: 'start', node: null },
      { id: 'n_agent', type: 'bpmn:ServiceTask', name: '写代码', kind: 'agent', node: { kind: 'agent', provider: 'fake', adapter: 'fake' } },
      { id: 'n_human', type: 'bpmn:UserTask', name: '人审', kind: 'human', node: { kind: 'human', prompt: '看看这段代码' } },
      { id: 'n_gw', type: 'bpmn:ExclusiveGateway', name: '过不过', kind: 'gateway', node: null },
      { id: 'n_end', type: 'bpmn:EndEvent', name: '完成', kind: 'end', node: null },
    ],
    flows: [
      { id: 'f_start_agent', from: 'n_start', to: 'n_agent', condition: null, isDefault: false },
      { id: 'f_agent_human', from: 'n_agent', to: 'n_human', condition: null, isDefault: false },
      { id: 'f_human_gw', from: 'n_human', to: 'n_gw', condition: null, isDefault: false },
      {
        id: 'f_back',
        from: 'n_gw',
        to: 'n_agent',
        condition: { expression: '= approved = false', language: 'feel' },
        isDefault: false,
      },
      { id: 'f_ok', from: 'n_gw', to: 'n_end', condition: null, isDefault: true },
    ],
  }
  return { ...definition, ...overrides }
}

/** 把夹具里回退边的条件换成给定表达式（definition 侧同步改；null = 该边无条件）。 */
function fixtureWithBackCondition(expression, definitionId) {
  const definition = makeDefinition({ id: definitionId })
  definition.flows = definition.flows.map((flow) => (
    flow.id === 'f_back'
      ? { ...flow, condition: expression === null ? null : { expression, language: 'feel' } }
      : flow
  ))
  const xml = expression === null
    ? FIXTURE_XML
    : FIXTURE_XML.replace('= approved = false', expression)
  return { definition, xml }
}

/**
 * 成环夹具（无人工节点，`start()` 一口气跑到尽头或护栏）：
 * `n_start → n_exec(agent) → n_check(gateway) → r01 回退到 n_exec / e01 默认到 n_end`。
 *
 * `extensions` 的形状与真解析器一致：`[{ type: 'fs:MaxRounds', name: 'maxRounds', value: N }]`。
 */
function makeLoopDefinition({
  definitionId = 'def-loop',
  maxRounds = null,
  condition = '= true',
  extensions = null,
} = {}) {
  const flowExtensions = extensions === null
    ? (maxRounds === null ? [] : [{ type: 'fs:MaxRounds', name: 'maxRounds', value: maxRounds }])
    : extensions
  return {
    id: definitionId,
    name: '成环流程',
    startId: 'n_start',
    endIds: ['n_end'],
    elements: [
      { id: 'n_start', kind: 'start', name: '开始' },
      { id: 'n_exec', kind: 'agent', name: '执行' },
      { id: 'n_check', kind: 'gateway', name: '检查' },
      { id: 'n_end', kind: 'end', name: '完成' },
    ],
    flows: [
      { id: 'e_start', from: 'n_start', to: 'n_exec' },
      { id: 'e_check', from: 'n_exec', to: 'n_check' },
      {
        id: 'r01',
        name: '没按计划执行',
        from: 'n_check',
        to: 'n_exec',
        condition: { expression: condition, language: 'feel' },
        extensions: flowExtensions,
      },
      { id: 'e01', from: 'n_check', to: 'n_end', isDefault: true },
    ],
  }
}

/**
 * 多入口夹具：目标节点 `t` 有两条入向连线——
 *   - `e_in`：正常前进边（条件 `= phase = "in"`，先让 t 从这条边跑几次）；
 *   - `e_back`：环回边（条件 `= phase = "back"` + `fs:maxRounds=2`）。
 * 用来钉死「连线次数上限必须按这条连线自己的通过次数算」：旧实现拿「目标节点进入次数 - 1」
 * 当连线次数，t 经 e_in 进过 4 次后再走 e_back 会在第 1 次就误报上限。
 *
 * 流程：s → g1 →(e_in)→ t → g1 …（3 轮）→ g1 默认 → g2 →(e_back)→ t → g2 …
 */
function makeMultiInboundDefinition(definitionId) {
  return {
    id: definitionId,
    name: '多入口次数上限',
    startId: 's',
    endIds: ['e'],
    elements: [
      { id: 's', kind: 'start', name: '开始' },
      { id: 't', kind: 'agent', name: '目标' },
      { id: 'g1', kind: 'gateway', name: '入口选择' },
      { id: 'g2', kind: 'gateway', name: '回边选择' },
      { id: 'e', kind: 'end', name: '完成' },
    ],
    flows: [
      { id: 'e_start', from: 's', to: 'g1' },
      { id: 'e_in', from: 'g1', to: 't', condition: { expression: '= phase = "in"', language: 'feel' } },
      { id: 'e_t_g1', from: 't', to: 'g1' },
      { id: 'e_g1_g2', from: 'g1', to: 'g2', isDefault: true },
      {
        id: 'e_back',
        from: 'g2',
        to: 't',
        condition: { expression: '= phase = "back"', language: 'feel' },
        extensions: [{ type: 'fs:MaxRounds', name: 'maxRounds', value: 2 }],
      },
      { id: 'e_out', from: 'g2', to: 'e', isDefault: true },
    ],
  }
}

/** 一份事件记录器 + 固定的假 handler。 */
function makeRecorder() {
  const events = []
  const tasks = { wait: [], done: [] }
  const errors = []
  const handlerCalls = []
  return {
    events,
    tasks,
    errors,
    handlerCalls,
    services(agentImpl) {
      return {
        async executeAgent(element, ctx) {
          handlerCalls.push({ elementId: element.id, attempt: ctx.attempt, executionId: ctx.executionId })
          if (typeof agentImpl === 'function') return agentImpl(element, ctx)
          return { output: { draft: 'v1' }, usage: { input: 11, output: 7 } }
        },
        onEvent(event) {
          events.push(event)
        },
        onTaskWait(task) {
          tasks.wait.push(task)
        },
        onTaskDone(taskResult) {
          tasks.done.push(taskResult)
        },
        onError(error) {
          errors.push(error)
        },
      }
    },
    types() {
      return events.map((event) => event.type)
    },
    flowIds() {
      return events.filter((event) => event.type === 'flow/taken').map((event) => event.flowId)
    },
    flowEvents() {
      return events.filter((event) => event.type === 'flow/taken')
    },
    eventTypesAt() {
      return events.map((event) => `${event.type}${event.elementId ? `:${event.elementId}` : ''}`)
    },
  }
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

try {
  console.log('bpmn-runner.js · 引擎适配')

  // -------------------------------------------------------------------------
  // 1. XML 夹具跑通闭环
  // -------------------------------------------------------------------------
  await check('XML 夹具：跑到 userTask 等待、flow/taken 跟着网关、signalTask 续到 process/end', async () => {
    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeDefinition(),
      xml: FIXTURE_XML,
      variables: { approved: null },
      services: recorder.services(),
    }))

    A.equal(runner.status(), 'idle', '未启动时是 idle')

    const started = await runner.start()
    A.equal(started.state, 'waiting', '停在 userTask 的等待点')
    A.equal(runner.status(), 'waiting')
    A.equal(runner.pendingTasks().length, 1)
    const waited = runner.pendingTasks()[0]
    A.deepEqual(
      { activityId: waited.activityId, elementId: waited.elementId, name: waited.name },
      { activityId: 'n_human', elementId: 'n_human', name: '人审' }
    )
    A.match(waited.since, ISO_RE, 'since 必须是 ISO 时间')
    A.match(waited.executionId, /^n_human_[0-9a-f]+$/, 'executionId 是引擎给的活动执行 id')

    // 事件顺序：启动 → agent 活动（带 output/usage）→ flow → 人工等待。
    A.deepEqual(recorder.types().slice(0, 4), ['process/start', 'activity/start', 'activity/end', 'flow/taken'])
    const agentEnd = recorder.events.find((event) => event.type === 'activity/end' && event.elementId === 'n_agent')
    A.deepEqual(agentEnd.output, { draft: 'v1' }, 'activity/end 必须带 handler 的 output')
    A.deepEqual(agentEnd.usage, { input: 11, output: 7 }, 'activity/end 必须带 handler 的 usage')
    A.equal(typeof agentEnd.durationMs, 'number', 'activity/end 带 durationMs')
    A.ok(ISO_RE.test(agentEnd.at), 'activity/end 带 ISO 的 at')

    const waitEvents = recorder.events.filter((event) => event.type === 'activity/wait')
    A.equal(waitEvents.length, 1, 'activity/wait 只发一次')
    A.equal(waitEvents[0].elementId, 'n_human', 'activity/wait 在 userTask 上')

    // 停在 userTask 时只走了两条连线（userTask 还没完成，f_human_gw 还不该走）。
    A.deepEqual(recorder.flowIds(), ['f_start_agent', 'f_agent_human'], 'signal 前只走了两条无条件连线')

    A.equal(recorder.tasks.wait.length, 1, 'onTaskWait 被调用一次')
    A.equal(recorder.tasks.wait[0].activityId, 'n_human')

    // 关键：`= approved = false` + approved=true → 不得走回退边（恒真回归点）。
    A.equal(recorder.flowIds().includes('f_back'), false, 'approved=true 时不能走回退边（防「恒真」）')

    const signaled = await runner.signalTask({ activityId: 'n_human', payload: { approved: true } })
    A.equal(signaled, undefined, 'signalTask 的返回值是 void')
    A.equal(runner.status(), 'done')
    A.equal(runner.pendingTasks().length, 0, '完成后没有待办')

    A.deepEqual(recorder.types().slice(-1), ['process/end'], '最后一条事件是 process/end')
    const finalFlows = recorder.flowIds()
    A.deepEqual(finalFlows.slice(-2), ['f_human_gw', 'f_ok'], '信号后走 gateway → 默认边 f_ok')
    A.deepEqual(finalFlows, ['f_start_agent', 'f_agent_human', 'f_human_gw', 'f_ok'], '整轮的连线顺序')
    A.equal(finalFlows.includes('f_back'), false, '整轮都没走回退边')

    // 「flow/taken 出现在每次网关选路后」：网关 activity/end 的下一条事件就是 flow/taken。
    const gatewayEndIndex = recorder.events.findIndex((event) => event.type === 'activity/end' && event.elementId === 'n_gw')
    A.ok(gatewayEndIndex >= 0, '有网关的 activity/end')
    A.equal(recorder.events[gatewayEndIndex + 1].type, 'flow/taken', '网关结束后的下一条事件是 flow/taken')
    A.equal(recorder.events[gatewayEndIndex + 1].flowId, 'f_ok')

    const okFlow = recorder.flowEvents().find((event) => event.flowId === 'f_ok')
    A.equal(okFlow.from, 'n_gw', 'flow/taken 带 from')
    A.equal(okFlow.to, 'n_end', 'flow/taken 带 to')
    A.equal(okFlow.condition, null, '默认流没有条件（condition 为 null）')

    A.equal(recorder.tasks.done.length, 1, 'onTaskDone 被调用一次')
    A.deepEqual(recorder.tasks.done[0].output, { approved: true }, 'onTaskDone 带完成载荷')
    A.equal(recorder.errors.length, 0, '全程没有 error')

    const state = await runner.getState()
    A.equal(state.status, 'done')
    A.equal(state.definitionId, 'def-review')
    A.equal(typeof state.engineVersion, 'string', '快照里记引擎版本（跨版本恢复要判）')
    A.equal(Array.isArray(state.engine.definitions), true, '快照里有 bpmn-engine 的 definitions')
    // 变量账本 = 初始变量 + 活动输出（对象按 key 扁平合并；agent 的 draft 与人工载荷都在）。
    A.deepEqual(state.variables, { approved: true, draft: 'v1' }, '变量账本里有活动输出与人工载荷')
  })

  // -------------------------------------------------------------------------
  // 2. 跨实例恢复
  // -------------------------------------------------------------------------
  await check('恢复：A 落 state → 全新实例 B recover → signalTask 跑到结束（没有复用旧对象）', async () => {
    const recorderA = makeRecorder()
    const a = track(createRunner({
      definition: makeDefinition({ id: 'def-recover-a' }),
      // 故意不给 xml：定义-only 也必须能跑（走 definition 反向生成的 XML）
      services: recorderA.services(() => ({ output: { draft: 'A' } })),
    }))
    A.equal(a.status(), 'idle')
    A.equal((await a.start()).state, 'waiting')
    const stateA = await a.getState()
    // 序列化再解析：证明快照是可跨进程搬运的 JSON（不是对象引用）。
    const serialized = JSON.stringify(stateA)
    A.ok(serialized.length > 4000, `快照应该带着引擎状态（实测 ${serialized.length} 字节）`)
    const restored = JSON.parse(serialized)
    A.equal(restored.status, 'waiting', '快照里记着 waiting')
    A.equal(restored.pendingTasks.length, 1, '快照里带着待办列表')
    const executionA = stateA.pendingTasks[0].executionId
    const aTypesBefore = recorderA.types().length

    // 新 runner 对象（新的 Engine、新的 services 闭包），但必须复用同一个实例 id：
    // 快照属于实例，跨实例恢复要拒绝（MAJOR-1）。
    // 活跃实例表按 instanceId 唯一：先把 A 停掉再建 B。
    await a.stop()
    const recorderB = makeRecorder()
    const b = track(createRunner({
      definition: makeDefinition({ id: 'def-recover-a' }),
      instanceId: a.instanceId,
      services: recorderB.services(() => ({ output: { draft: 'B' } })),
    }))
    A.equal(b.instanceId, a.instanceId, '恢复用同一实例 id（新 runner 对象）')
    await b.recover(restored)

    // 拒绝型 expressions 解析器必须扛过 Environment.clone / recover。
    A.equal(
      b._engine.environment.expressions.resolveExpression,
      b._rejectExpressions.resolveExpression,
      '引擎环境仍是拒绝型表达式解析器'
    )
    const recoveredDefinitions = b._engine.execution.definitions
    A.equal(recoveredDefinitions.length, 1)
    A.equal(
      recoveredDefinitions[0].environment.expressions.resolveExpression,
      b._rejectExpressions.resolveExpression,
      '定义环境（clone 出来的）仍是拒绝型表达式解析器'
    )

    A.equal(b.status(), 'waiting', '恢复后停在同一个等待点')
    A.equal(b.pendingTasks().length, 1)
    A.equal(b.pendingTasks()[0].executionId, executionA, '同一条活动执行（executionId 由 state 带过来）')
    A.deepEqual(recorderB.types().slice(0, 2), ['activity/wait'], 'B 的事件流从重放的 activity/wait 开始')
    A.equal(recorderB.types().includes('process/start'), false, '恢复不是从头重跑（没有 process/start）')
    A.equal(recorderB.types().includes('flow/taken'), false, '恢复时没有重放已走过的连线')
    A.equal(recorderA.types().length, aTypesBefore, 'A 的事件流没有因为 B 的恢复而增加')

    // 恢复后先给一次 false（approved=false → 条件回退边 → 再跑 agent → 再次等人）。
    await b.signalTask({ activityId: 'n_human', payload: { approved: false } })
    A.equal(b.status(), 'waiting', '回退边后又停在 userTask')
    // 进入次数随快照恢复：A 里 agent 跑过 1 次，B 接着跑就是第 2 次（不是重新从 1 计）。
    A.equal(recorderB.handlerCalls.length >= 1, true)
    A.equal(recorderB.handlerCalls[0].attempt, 2, '恢复后 ctx.attempt 沿用 state 里的进入次数')
    A.equal(recorderB.flowIds().includes('f_back'), true, '恢复后条件求值仍然生效（走了回退边）')
    A.equal(recorderB.tasks.wait.length >= 1, true)

    // 再给一次 true → 默认边 → endEvent。
    await b.signalTask({ activityId: 'n_human', payload: { approved: true } })
    A.equal(b.status(), 'done')
    A.deepEqual(recorderB.types().slice(-1), ['process/end'])
    A.equal(b.pendingTasks().length, 0)

    // A 已停止：B 的推进没有落到 A 身上（事件流全程没变）。
    A.equal(a.status(), 'idle', 'A 已停止；B 的推进没有落到 A 身上')
    A.equal(recorderA.types().length, aTypesBefore, 'A 的事件流全程没变')

    // 从同一份 state 恢复第二次也必须成功（state 是只读的起点，不是一次性令牌）。
    // 先把 B 的 done 快照取出来，再停掉 B（活跃表按 instanceId 唯一），同一 id 建 C。
    const doneState = await b.getState()
    A.equal(doneState.status, 'done')
    await b.stop()
    const recorderC = makeRecorder()
    const c = track(createRunner({
      definition: makeDefinition({ id: 'def-recover-a' }),
      instanceId: a.instanceId,
      services: recorderC.services(() => ({ output: { draft: 'C' } })),
    }))
    await c.recover(JSON.parse(serialized))
    A.equal(c.pendingTasks()[0].executionId, executionA, '同一份 state 可以再次恢复')

    // 恢复的运行中不允许 recover（结构化错误，不静默重建）。
    await A.rejects(() => c.recover(stateA), { code: 'BPMN_RECOVER_RUNNING' })
    // 已经启动过的实例不允许再 start。
    await A.rejects(() => c.start(), { code: 'BPMN_ALREADY_STARTED' })
    await c.stop()

    // stop() 之后的 state（引擎 stopped）是可以恢复的：这是「手动挂起 → 恢复」的落点。
    const stopperRecorder = makeRecorder()
    const stopper = track(createRunner({
      definition: makeDefinition({ id: 'def-recover-a' }),
      services: stopperRecorder.services(),
    }))
    await stopper.start()
    await stopper.stop()
    const stoppedState = await stopper.getState()
    A.equal(stoppedState.engine.state, 'stopped', 'stop 之后引擎状态是 stopped')
    const reviver = track(createRunner({
      definition: makeDefinition({ id: 'def-recover-a' }),
      instanceId: stopper.instanceId,
      services: makeRecorder().services(),
    }))
    await reviver.recover(stoppedState)
    A.equal(reviver.status(), 'waiting', 'stopped 的 state 恢复后回到等待点')
    A.equal(reviver.pendingTasks()[0].elementId, 'n_human')
    await reviver.stop()

    // 已经结束（done）的 state 没有可推进的点：必须结构化拒绝，而不是挂住调用方。
    const late = track(createRunner({
      definition: makeDefinition({ id: 'def-recover-a' }),
      instanceId: a.instanceId,
      services: makeRecorder().services(),
    }))
    await A.rejects(() => late.recover(doneState), { code: 'BPMN_STATE_NOT_RESUMABLE' })
    A.equal(late.status(), 'idle', '拒绝恢复后实例仍是 idle，没有半截状态')

    // 真正的「在跑」（handler 在飞、engine.execution.isRunning）也不许 recover。
    let handlerAborted = false
    const slow = track(createRunner({
      definition: makeDefinition({ id: 'def-recover-running' }),
      services: {
        executeAgent(element, ctx) {
          ctx.signal.addEventListener('abort', () => {
            handlerAborted = true
          })
          return new Promise((resolve) => setTimeout(() => resolve({ output: {} }), 300))
        },
        onEvent() {},
      },
    }))
    const pendingStart = slow.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    A.equal(slow.status(), 'running', 'handler 在飞时状态是 running')
    await A.rejects(() => slow.recover(stateA), { code: 'BPMN_RECOVER_RUNNING' })
    // stop 要 abort 在飞 handler，并让还没 settle 的 start() 收尾（不挂死调用方）。
    await slow.stop()
    A.equal(handlerAborted, true, 'stop() abort 了在飞 handler（坑 9）')
    A.equal(slow.status(), 'idle', 'stop() 后状态回到 idle')
    A.deepEqual(await pendingStart, { state: 'idle' }, 'stop() 释放了在等的 start()')
  })

  // -------------------------------------------------------------------------
  // 3b. 快照触发点
  // -------------------------------------------------------------------------
  await check('快照只在 activity/wait 与 activity/end 之后触发（不在每条事件上 getState）', async () => {
    const seen = []
    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-snapshot' }),
      shouldSnapshot(event) {
        seen.push(event.type)
        return true
      },
      services: recorder.services(),
    }))
    await runner.start()
    await runner.signalTask({ activityId: 'n_human', payload: { approved: true } })
    A.equal(runner.status(), 'done')

    A.deepEqual([...new Set(seen)].sort(), ['activity/end', 'activity/wait'], 'shouldSnapshot 只看到 wait/end 两类')
    A.equal(seen.every((type) => type === 'activity/end' || type === 'activity/wait'), true)
    A.equal(seen.includes('flow/taken'), false, 'flow/taken 不触发快照')
    A.equal(seen.includes('process/start'), false, 'process/start 不触发快照')

    // 去抖为 false 时一次都不取（显式 getState 仍然可用）。
    const quietRecorder = makeRecorder()
    const quiet = track(createRunner({
      definition: makeDefinition({ id: 'def-snapshot-quiet' }),
      shouldSnapshot: () => false,
      services: quietRecorder.services(),
    }))
    await quiet.start()
    A.equal(quiet.status(), 'waiting')
    const explicit = await quiet.getState()
    A.equal(explicit.status, 'waiting', '去抖不影响显式 getState()')
  })

  // -------------------------------------------------------------------------
  // 3. FEEL 条件：`= false` 走默认边 + 注入点
  // -------------------------------------------------------------------------
  await check('FEEL 条件：`= false` 走默认边、假分支真的走回退边、evaluateCondition 注入生效', async () => {
    /** 造一份把回退边条件换掉的 definition（其余同夹具），跑一轮 approved=true。 */
    function definitionWithBackCondition(expression) {
      const definition = makeDefinition({ id: 'def-feel' })
      definition.flows = definition.flows.map((flow) => (
        flow.id === 'f_back' ? { ...flow, condition: { expression, language: 'feel' } } : flow
      ))
      return definition
    }

    // (a) 字面 `= false`：永远不该走回退边（恒真实现会走）。
    {
      const recorder = makeRecorder()
      const runner = track(createRunner({
        definition: definitionWithBackCondition('= false'),
        services: recorder.services(),
      }))
      await runner.start()
      await runner.signalTask({ activityId: 'n_human', payload: { approved: true } })
      A.equal(runner.status(), 'done')
      A.equal(recorder.flowIds().includes('f_back'), false, '`= false` 必须走默认边（防恒真）')
      A.equal(recorder.flowIds().includes('f_ok'), true, '`= false` 时走默认边 f_ok')
      const back = recorder.flowEvents().find((event) => event.flowId === 'f_back')
      A.equal(back, undefined, '回退边一次都没被走')
    }

    // (b) `= approved = false`：approved=false 时真的走回退边（false 分支不是「恒真」也不是「恒假」）。
    {
      const recorder = makeRecorder()
      const runner = track(createRunner({
        definition: definitionWithBackCondition('= approved = false'),
        services: recorder.services(),
      }))
      await runner.start()
      await runner.signalTask({ activityId: 'n_human', payload: { approved: false } })
      const firstPass = recorder.flowEvents().find((event) => event.flowId === 'f_back')
      A.ok(firstPass, 'approved=false → 走回退边')
      A.deepEqual(
        firstPass.condition,
        { expression: '= approved = false', value: true },
        'flow/taken 的 condition 是 { expression, value }'
      )
      A.equal(firstPass.from, 'n_gw')
      A.equal(firstPass.to, 'n_agent')
      await runner.signalTask({ activityId: 'n_human', payload: { approved: true } })
      A.equal(runner.status(), 'done')
      A.equal(recorder.flowEvents().filter((event) => event.flowId === 'f_back').length, 1, '回退边只走了那一次')
    }

    // (c) 自定义求值器入口已删除：传 evaluateCondition 即 BPMN_OPTIONS_INVALID
    //     （条件只允许经 bpmn-expr.evaluateFeel 求值，防止上层把条件交回别的实现）。
    {
      const recorder = makeRecorder()
      A.throws(
        () => createBpmnRunner({
          definition: definitionWithBackCondition('= approved = false'),
          definitionIdentity: identityOf({ definition: definitionWithBackCondition('= approved = false') }),
          evaluateCondition: () => false,
          services: recorder.services(),
        }),
        { code: 'BPMN_OPTIONS_INVALID' }
      )
      A.equal(recorder.handlerCalls.length, 0, '拒绝选项时 handler 一次都不执行')
    }
  })

  await check('XML 裸 `= false`（没有 language 属性）也必须走默认边', async () => {
    // 研究 §5 的原始坑：引擎把无 language 的条件当字符串路径解析 → 恒真。
    // 本执行器把「没有 language 的 SequenceFlow 条件」也当 FEEL 求值，所以 false 必须不成立。
    const xml = FIXTURE_XML.replace(
      ' language="feel">= approved = false</bpmn:conditionExpression>',
      '>= false</bpmn:conditionExpression>'
    )
    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-nolang' }),
      xml,
      services: recorder.services(),
    }))
    A.equal((await runner.start()).state, 'waiting')
    await runner.signalTask({ activityId: 'n_human', payload: { approved: false } })
    A.equal(runner.status(), 'done')
    A.equal(recorder.flowIds().includes('f_back'), false, '裸 `= false` 走默认边（不恒真）')
    A.equal(recorder.flowIds().includes('f_ok'), true)
  })

  await check('条件求值归本模块：`= 1 > 2` 不通行、`= 1 + 1 = 2` 通行、非法表达式转 blocked、`${...}` 被拒', async () => {
    // (a) 运算 + 假结果：`= 1 > 2` 必须不通行。若条件被交给引擎的内置表达式引擎，
    //     它会把这个字符串当非空 → 恒真（这就是本条测试要钉死的回归）。
    {
      const recorder = makeRecorder()
      const { definition, xml } = fixtureWithBackCondition('= 1 > 2', 'def-cond-gt')
      const runner = track(createRunner({ definition, xml, services: recorder.services() }))
      await runner.start()
      await runner.signalTask({ activityId: 'n_human', payload: { approved: false } })
      A.equal(runner.status(), 'done')
      A.equal(recorder.flowIds().includes('f_back'), false, '`= 1 > 2` 不通行（内置表达式引擎会当恒真）')
      A.equal(recorder.flowIds().includes('f_ok'), true, '不通行 → 走默认流')
    }

    // (b) 真运算：`= 1 + 1 = 2` 必须通行（证明确实是 FEEL 求值，不是路径解析）。
    {
      const recorder = makeRecorder()
      const { definition, xml } = fixtureWithBackCondition('= 1 + 1 = 2', 'def-cond-arith')
      const runner = track(createRunner({ definition, xml, services: recorder.services() }))
      await runner.start()
      await runner.signalTask({ activityId: 'n_human', payload: { approved: true } })
      A.equal(runner.status(), 'waiting', '回退边成环：又停在 userTask')
      const back = recorder.flowEvents().find((event) => event.flowId === 'f_back')
      A.ok(back, '`= 1 + 1 = 2` 通行（走回退边）')
      A.deepEqual(back.condition, { expression: '= 1 + 1 = 2', value: true }, 'flow/taken 带 { expression, value }')
    }

    // (c) 非法表达式（`= approved =` 少一个操作数）：必须 error + runner blocked，
    //     **不能**静默当 false 走去默认流。definition 侧不带条件（条件只在 XML 里），
    //     所以不会被加载期校验提前拦下 —— 走的正是运行期 ok:false 分支。
    {
      const recorder = makeRecorder()
      const definition = makeDefinition({ id: 'def-cond-invalid' })
      definition.flows = definition.flows.map((flow) => (flow.id === 'f_back' ? { ...flow, condition: null } : flow))
      const xml = FIXTURE_XML.replace('= approved = false', '= approved =')
      const runner = track(createRunner({ definition, xml, services: recorder.services() }))
      A.equal((await runner.start()).state, 'waiting')
      await A.rejects(
        () => runner.signalTask({ activityId: 'n_human', payload: { approved: false } }),
        (error) => {
          A.equal(error.code, 'BPMN_CONDITION_INVALID')
          A.match(error.message, /FEEL_EVALUATION_ERROR|条件求值失败/)
          return true
        }
      )
      A.equal(runner.status(), 'blocked', '非法条件必须让实例失败')
      A.equal(recorder.errors.length, 1)
      A.equal(recorder.errors[0].code, 'BPMN_CONDITION_INVALID')
      A.equal(recorder.types().includes('process/end'), false, '没有静默走完流程')
      const errorEvent = recorder.events.find((event) => event.type === 'error')
      A.equal(errorEvent.error.code, 'BPMN_CONDITION_INVALID')
    }

    // (d) 引擎内置表达式语法 `${...}` 一律拒绝：绝不把条件交回引擎的表达式引擎。
    {
      const recorder = makeRecorder()
      const definition = makeDefinition({ id: 'def-cond-engine-expr' })
      definition.flows = definition.flows.map((flow) => (flow.id === 'f_back' ? { ...flow, condition: null } : flow))
      const xml = FIXTURE_XML.replace('= approved = false', '${environment.services.__cond_f_back}')
      const runner = track(createRunner({ definition, xml, services: recorder.services() }))
      A.equal((await runner.start()).state, 'waiting')
      await A.rejects(
        () => runner.signalTask({ activityId: 'n_human', payload: { approved: false } }),
        { code: 'BPMN_CONDITION_LANGUAGE_UNSUPPORTED' }
      )
      A.equal(runner.status(), 'blocked')
      A.match(recorder.errors[0].message, /内置表达式/)
    }
  })

  await check('连线次数上限：`= true` + fs:maxRounds=3 → 目标跑 4 次后 BPMN_FLOW_TAKE_LIMIT 失败', async () => {
    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeLoopDefinition({ definitionId: 'def-take-limit-3', maxRounds: 3 }),
      services: recorder.services((element, ctx) => ({ output: { attempt: ctx.attempt } })),
    }))

    await A.rejects(() => runner.start(), (error) => {
      A.equal(error.code, 'BPMN_FLOW_TAKE_LIMIT')
      A.equal(error.maxTakes, 3, '错误体带 maxTakes（fs:maxRounds 的值）')
      A.equal(error.takes, 3, '错误体带已走过的次数')
      A.equal(error.flowId, 'r01', 'flowId 是越界的那条连线')
      A.equal(error.elementId, 'r01', 'elementId 指向连线本身')
      A.match(error.message, /连线 r01 已被走过 3 次，第 4 次超过 fs:maxRounds=3 的连线次数上限/)
      A.equal(/打回|驳回/.test(error.message), false, '通用引擎的文案不带业务概念')
      return true
    })

    A.equal(runner.status(), 'blocked')
    // maxRounds = 允许的重跑次数 → 目标一共执行 maxRounds + 1 = 4 次。
    A.equal(recorder.handlerCalls.length, 4, 'handler 调用次数正好 4')
    A.deepEqual(recorder.handlerCalls.map((call) => call.attempt), [1, 2, 3, 4], 'ctx.attempt 逐次递增')
    A.equal(recorder.flowIds().filter((id) => id === 'r01').length, 3, '这条连线实际走了 3 次（第 4 次被拒）')
    A.equal(recorder.types().includes('process/end'), false, '失败后不出现 process/end')

    const errorEvents = recorder.events.filter((event) => event.type === 'error')
    A.equal(errorEvents.length, 1)
    A.equal(errorEvents[0].error.code, 'BPMN_FLOW_TAKE_LIMIT')
    A.equal(errorEvents[0].error.maxTakes, 3)
    A.equal(errorEvents[0].error.takes, 3)
    A.equal(errorEvents[0].error.flowId, 'r01')
    A.equal(recorder.errors.length, 1, 'onError 只被调用一次')
    A.equal(recorder.errors[0].code, 'BPMN_FLOW_TAKE_LIMIT')

    // 计数随快照走：恢复后不会把已用掉的次数「清零」重来。
    const state = await runner.getState()
    A.deepEqual(state.attempts.find(([key]) => key === 'n_exec'), ['n_exec', 4], 'state 里带 n_exec 的进入次数')
    A.deepEqual(state.flowTakes.find(([key]) => key === 'r01'), ['r01', 3], 'state 里带这条连线的 take 次数')
  })

  await check('连线次数上限：fs:maxRounds=1 → 目标跑 2 次（上限是「连线被走次数」，不是节点总次数）', async () => {
    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeLoopDefinition({ definitionId: 'def-take-limit-1', maxRounds: 1 }),
      services: recorder.services((element, ctx) => ({ output: { attempt: ctx.attempt } })),
    }))

    await A.rejects(() => runner.start(), (error) => {
      A.equal(error.code, 'BPMN_FLOW_TAKE_LIMIT')
      A.equal(error.maxTakes, 1)
      A.equal(error.takes, 1)
      A.equal(error.flowId, 'r01', 'flowId 指向越界的那条连线')
      A.equal(error.elementId, 'r01', 'elementId 指向连线本身')
      A.match(error.message, /连线 r01 已被走过 1 次，第 2 次超过 fs:maxRounds=1/)
      return true
    })
    A.equal(runner.status(), 'blocked')
    A.equal(recorder.handlerCalls.length, 2, 'maxRounds=1 → 目标执行 2 次')
    A.equal(recorder.flowIds().filter((id) => id === 'r01').length, 1)
    A.equal(recorder.types().includes('process/end'), false)
  })

  await check('循环护栏：没有 fs:maxRounds 的 `= true` 死环被 BPMN_LOOP_LIMIT 拦下', async () => {
    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeLoopDefinition({ definitionId: 'def-loop-guard', maxRounds: null }),
      // 故意把护栏设小，别真跑 1000 次。
      loopGuardMax: 5,
      services: recorder.services((element, ctx) => ({ output: { attempt: ctx.attempt } })),
    }))

    await A.rejects(() => runner.start(), (error) => {
      A.equal(error.code, 'BPMN_LOOP_LIMIT')
      A.equal(typeof error.flowId, 'string', '错误体带违规连线的 flowId')
      A.ok(error.flowId.length > 0)
      A.equal(error.takes, 5, '已成功走过 5 次')
      A.equal(error.attemptedTake, 6, '第 6 次 take 被拦在发布之前（上限 5）')
      A.equal(error.loopGuardMax, 5)
      A.match(error.message, /循环护栏（上限 5）/)
      return true
    })
    A.equal(runner.status(), 'blocked')
    A.ok(recorder.handlerCalls.length <= 6, `死环必须被拦住（handler 只跑了 ${recorder.handlerCalls.length} 次）`)
    A.equal(recorder.types().includes('process/end'), false)
    const state = await runner.getState()
    A.deepEqual(state.flowTakes.find(([key]) => key === 'r01'), ['r01', 5], '回退边正好走了 5 次（护栏上限）')

    // loopGuardMax=0 关闭护栏：这里只验证选项被接受、不会因为护栏误杀（用一轮就结束的流程）。
    const okRecorder = makeRecorder()
    const okRunner = track(createRunner({
      definition: makeLoopDefinition({ definitionId: 'def-loop-guard-off', maxRounds: 2, condition: '= attempt < 2' }),
      loopGuardMax: 0,
      services: okRecorder.services((element, ctx) => ({ output: { attempt: ctx.attempt } })),
    }))
    A.equal((await okRunner.start()).state, 'done', 'loopGuardMax=0 不误杀正常流程')
  })

  await check('连线次数上限不误伤：fs:maxRounds=2 只走 1 次 → 正常 done', async () => {
    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeLoopDefinition({
        definitionId: 'def-take-limit-once',
        maxRounds: 2,
        condition: '= attempt < 2',
      }),
      services: recorder.services((element, ctx) => ({ output: { attempt: ctx.attempt } })),
    }))

    A.equal((await runner.start()).state, 'done')
    A.equal(runner.status(), 'done')
    A.equal(recorder.handlerCalls.length, 2, '连线走 1 次 → 目标执行 2 次')
    A.equal(recorder.flowIds().filter((id) => id === 'r01').length, 1, '这条连线只走一次')
    A.equal(recorder.flowIds().includes('e01'), true, '第 2 轮条件不成立 → 走默认边到 end')
    A.deepEqual(recorder.types().slice(-1), ['process/end'])
    A.equal(recorder.errors.length, 0)
  })

  await check('flow.extensions 原样保留，maxTakes 只认 ≥1 的显式整数', async () => {
    const recorder = makeRecorder()
    const definition = makeLoopDefinition({ definitionId: 'def-ext', maxRounds: 2 })
    const extensions = [
      { type: 'fs:MaxRounds', name: 'maxRounds', value: 2 },
      { type: 'fs:Note', name: 'note', value: '只走一次' },
    ]
    definition.flows = definition.flows.map((flow) => (
      flow.id === 'r01' ? { ...flow, extensions } : flow
    ))
    const runner = track(createRunner({ definition, services: recorder.services() }))
    const flow = runner.definition.flows.find((entry) => entry.id === 'r01')
    A.deepEqual(flow.extensions, extensions, 'extensions 原样保留（下一层还要拿 fs 信息）')
    A.equal(flow.maxTakes, 2, '从 extensions 派生出 maxTakes')
    // 非回退边没有扩展：空数组 + 不做上限判断。
    const plain = runner.definition.flows.find((entry) => entry.id === 'e01')
    A.deepEqual(plain.extensions, [])
    A.equal(plain.maxTakes, null)

    // 非法值（0 / 非数字 / 小数）→ 视为未设上限，**不**补默认 2。
    for (const bad of [0, -1, 2.5, 'x', null]) {
      const badDefinition = makeLoopDefinition({
        definitionId: `def-ext-bad-${String(bad)}`,
        extensions: [{ type: 'fs:MaxRounds', name: 'maxRounds', value: bad }],
      })
      const badRunner = track(createRunner({ definition: badDefinition, services: makeRecorder().services() }))
      A.equal(
        badRunner.definition.flows.find((entry) => entry.id === 'r01').maxTakes,
        null,
        `fs:maxRounds=${JSON.stringify(bad)} 应按未设上限处理`
      )
    }
    // 字符串数字也认（属性写法 `<fs:maxRounds="3">` 会以字符串进来）。
    const stringDefinition = makeLoopDefinition({
      definitionId: 'def-ext-string',
      extensions: [{ type: 'fs:MaxRounds', name: 'maxRounds', value: '3' }],
    })
    const stringRunner = track(createRunner({ definition: stringDefinition, services: makeRecorder().services() }))
    A.equal(stringRunner.definition.flows.find((entry) => entry.id === 'r01').maxTakes, 3)
  })

  await check('连线次数上限跨恢复延续：恢复不会把已用掉的次数清零', async () => {
    const recorderA = makeRecorder()
    // A / B 必须用同一份「带 fs:maxRounds」的 definition（B 是新实例，不共享对象）。
    const makeLimitedDefinition = () => {
      const definition = makeDefinition({ id: 'def-take-limit-recover' })
      definition.flows = definition.flows.map((flow) => (
        flow.id === 'f_back'
          ? { ...flow, extensions: [{ type: 'fs:MaxRounds', name: 'maxRounds', value: 1 }] }
          : flow
      ))
      return definition
    }

    const a = track(createRunner({ definition: makeLimitedDefinition(), services: recorderA.services() }))
    A.equal((await a.start()).state, 'waiting')
    // 第 1 次走这条连线：允许（已走 0 次 < 上限 1），agent 第 2 次执行后再等人。
    await a.signalTask({ activityId: 'n_human', payload: { approved: false } })
    A.equal(a.status(), 'waiting')
    A.equal(recorderA.handlerCalls.map((call) => call.attempt).join(','), '1,2', '连线走一次后 agent 跑了 2 次')

    const state = JSON.parse(JSON.stringify(await a.getState()))
    A.deepEqual(state.attempts.find(([key]) => key === 'n_agent'), ['n_agent', 2], '快照里带着 agent 的进入次数')
    A.deepEqual(state.flowTakes.find(([key]) => key === 'f_back'), ['f_back', 1], '快照里带着回退边的 take 次数')

    // 新 runner 恢复（同一 instanceId）：再走一次就必须超限（若计数丢了，这里会误判成第 1 次而放行）。
    await a.stop()
    const recorderB = makeRecorder()
    const b = track(createRunner({ definition: makeLimitedDefinition(), instanceId: a.instanceId, services: recorderB.services() }))
    await b.recover(state)
    A.equal(b.pendingTasks()[0].elementId, 'n_human')
    await A.rejects(() => b.signalTask({ activityId: 'n_human', payload: { approved: false } }), (error) => {
      A.equal(error.code, 'BPMN_FLOW_TAKE_LIMIT')
      A.equal(error.maxTakes, 1)
      A.equal(error.takes, 1)
      A.equal(error.flowId, 'f_back', 'flowId 指向越界的那条连线')
      A.equal(error.elementId, 'f_back', 'elementId 指向连线本身')
      A.match(error.message, /已被走过 1 次，第 2 次超过 fs:maxRounds=1/)
      return true
    })
    A.equal(recorderB.handlerCalls.length, 0, '超限判定在重跑之前 → 恢复后的实例没有再调 handler')
    A.equal(b.status(), 'blocked')
  })

  await check('连线次数上限按「这条连线自己」计数：目标多入口不误判', async () => {
    const flowIdOf = 'e_back'

    // (a) e_back 只走 1 次 → 不报错。
    //     此时 t 已经由正常前进边 e_in 进入过 4 次；旧实现（takes = 目标进入次数 - 1 = 3）
    //     会在 e_back 的**第 1 次**判定就误报 BPMN_FLOW_TAKE_LIMIT。
    {
      const recorder = makeRecorder()
      const runner = track(createRunner({
        definition: makeMultiInboundDefinition('def-multi-inbound-once'),
        variables: { phase: 'in' },
        services: recorder.services((element, ctx) => ({
          output: { phase: ctx.attempt <= 3 ? 'in' : ctx.attempt === 4 ? 'back' : 'out' },
        })),
      }))
      A.equal((await runner.start()).state, 'done')
      A.equal(runner.status(), 'done')
      A.equal(recorder.errors.length, 0, 'e_back 只走 1 次时不得报上限（旧实现会误报）')
      A.equal(recorder.flowIds().filter((id) => id === flowIdOf).length, 1, 'e_back 只走了 1 次')
      // t 经 e_in 进过 4 次才走 e_back；若按「目标进入次数」算，这里早已越界。
      A.equal(recorder.handlerCalls.length, 5)
      A.deepEqual(recorder.handlerCalls.map((call) => call.attempt), [1, 2, 3, 4, 5])
      const state = await runner.getState()
      A.deepEqual(state.flowTakes.find(([key]) => key === flowIdOf), [flowIdOf, 1], '快照里 e_back 的 take 次数是 1')
      A.deepEqual(state.attempts.find(([key]) => key === 't'), ['t', 5], '目标 t 进入次数是 5（与连线次数无关）')
    }

    // (b) e_back 走满 2 次（上限），第 3 次判定时失败：takes=2 / maxTakes=2。
    {
      const recorder = makeRecorder()
      const runner = track(createRunner({
        definition: makeMultiInboundDefinition('def-multi-inbound-limit'),
        variables: { phase: 'in' },
        services: recorder.services((element, ctx) => ({
          output: { phase: ctx.attempt <= 3 ? 'in' : 'back' },
        })),
      }))
      await A.rejects(() => runner.start(), (error) => {
        A.equal(error.code, 'BPMN_FLOW_TAKE_LIMIT')
        A.equal(error.flowId, flowIdOf)
        A.equal(error.maxTakes, 2)
        A.equal(error.takes, 2, 'takes 是这条连线自己的通过次数，不是目标进入次数')
        A.match(error.message, /连线 e_back 已被走过 2 次，第 3 次超过 fs:maxRounds=2 的连线次数上限/)
        return true
      })
      A.equal(runner.status(), 'blocked')
      A.equal(recorder.flowIds().filter((id) => id === flowIdOf).length, 2, 'e_back 走满 2 次后才失败')
      const backIndexes = []
      recorder.events.forEach((event, index) => {
        if (event.type === 'flow/taken' && event.flowId === flowIdOf) backIndexes.push(index)
      })
      const errorIndex = recorder.events.findIndex((event) => event.type === 'error')
      A.equal(backIndexes.length, 2)
      A.ok(errorIndex > backIndexes[1], '上限判定发生在 e_back 第 2 次通过之后，不是之前')
      A.equal(recorder.handlerCalls.length, 6, '目标进入次数 6，但上限只按连线通过次数判')
      const state = await runner.getState()
      A.deepEqual(state.flowTakes.find(([key]) => key === flowIdOf), [flowIdOf, 2])
    }
  })

  // -------------------------------------------------------------------------
  // 4. handler 抛错 → runner blocked（实例 status 保持 ACTIVE，只写 lastError）
  // -------------------------------------------------------------------------
  await check('handler 抛错：runner 转 blocked + onError + error 事件（实例不判死）', async () => {
    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-boom' }),
      services: recorder.services(async () => {
        throw new Error('agent exploded')
      }),
    }))

    await A.rejects(() => runner.start(), (error) => {
      A.equal(error.code, 'BPMN_HANDLER_FAILED')
      A.equal(error.elementId, 'n_agent')
      A.match(error.message, /agent exploded/)
      return true
    })
    A.equal(runner.status(), 'blocked')
    A.equal(recorder.errors.length, 1, 'onError 只被调用一次')
    A.equal(recorder.errors[0].code, 'BPMN_HANDLER_FAILED')
    const errorEvents = recorder.events.filter((event) => event.type === 'error')
    A.equal(errorEvents.length, 1, 'error 事件只发一次（activity.error / process.error 不重复发）')
    A.equal(errorEvents[0].error.code, 'BPMN_HANDLER_FAILED')
    A.equal(errorEvents[0].error.message.includes('agent exploded'), true, 'error 事件带原始错误文案')
    A.equal(errorEvents[0].elementId, 'n_agent')
    A.equal(runner.pendingTasks().length, 0, '失败后不留待办')
    A.deepEqual(recorder.types().slice(-1), ['error'], '最后一条事件是 error')

    const state = await runner.getState()
    A.equal(state.status, 'blocked')
    A.equal(state.engine.state, 'error', '引擎也进了 error')

    await A.rejects(() => runner.signalTask({ activityId: 'n_human', payload: {} }), { code: 'BPMN_INSTANCE_BLOCKED' })
  })

  // -------------------------------------------------------------------------
  // 5. 活动超时 → runner blocked
  // -------------------------------------------------------------------------
  await check('activityWaitMs：handler 永不 resolve → 超时转 blocked（并 abort ctx.signal）', async () => {
    const errors = []
    let aborted = false
    const startedAt = Date.now()
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-timeout' }),
      limits: { activityWaitMs: 50 },
      services: {
        executeAgent(element, ctx) {
          A.equal(element.id, 'n_agent')
          A.equal(ctx.timeoutMs, 50, 'ctx 里能看到本次活动时限')
          A.equal(ctx.signal.aborted, false)
          ctx.signal.addEventListener('abort', () => {
            aborted = true
          })
          return new Promise(() => {})
        },
        onEvent() {},
        onError(error) {
          errors.push(error)
        },
      },
    }))

    await A.rejects(() => runner.start(), { code: 'BPMN_ACTIVITY_TIMEOUT' })
    const elapsed = Date.now() - startedAt
    A.ok(elapsed >= 50, `超时不能早于 50ms（实测 ${elapsed}ms）`)
    A.ok(elapsed < 3000, `超时不能拖太久（实测 ${elapsed}ms）`)
    A.equal(runner.status(), 'blocked')
    A.equal(aborted, true, '超时必须 abort 在飞 handler 的 ctx.signal（坑 9）')
    A.equal(errors.length, 1)
    A.equal(errors[0].code, 'BPMN_ACTIVITY_TIMEOUT')
  })

  await check('activityWaitMs：超时后晚到的 handler 成功不得回写（保留 BPMN_ACTIVITY_TIMEOUT）', async () => {
    const events = []
    let release = null
    let abortObserved = false
    let capturedCtx = null
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-timeout-late' }),
      // 嵌套对象：浅拷贝基线测不到「共享引用被改」，这里必须深拷贝后再比。
      variables: { obj: { x: 'before' } },
      limits: { activityWaitMs: 40 },
      services: {
        executeAgent(element, ctx) {
          capturedCtx = ctx
          ctx.signal.addEventListener('abort', () => { abortObserved = true }, { once: true })
          return new Promise((resolve) => {
            release = () => resolve({ output: { late: 'yes' } })
          })
        },
        onEvent(event) { events.push(event) },
      },
    }))
    await A.rejects(() => runner.start(), { code: 'BPMN_ACTIVITY_TIMEOUT' })
    A.equal(abortObserved, true)
    const eventsAtFail = events.length
    const variablesAtFail = JSON.parse(JSON.stringify(runner.variables))
    // 超时后 handler 仍持有 ctx：改嵌套对象也不能影响 runner 账本。
    capturedCtx.variables.obj.x = 'late'
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    A.equal(events.length, eventsAtFail, '超时之后不得再发事件')
    A.deepEqual(runner.variables, variablesAtFail, '晚到成功 / 晚到写入都不得改到变量账本')
    A.equal(
      events.filter(event => event.type === 'activity/end' && event.elementId === 'n_agent').length,
      0,
      '晚到成功不得产生 agent 的 activity/end'
    )
    A.equal(runner.status(), 'blocked')
    A.equal(runner.failure().code, 'BPMN_ACTIVITY_TIMEOUT', '保留原来的超时错误，不被晚到成功覆盖')
  })

  await check('activityWaitMs：userTask 一直没人完成任务 → 超时转 blocked', async () => {
    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-timeout-human' }),
      limits: { activityWaitMs: 60 },
      services: recorder.services(),
    }))
    A.equal((await runner.start()).state, 'waiting')
    A.equal(runner.pendingTasks().length, 1)
    await new Promise((resolve) => setTimeout(resolve, 200))
    A.equal(runner.status(), 'blocked', '没人完成任务 → 活动超时')
    A.equal(recorder.errors.length, 1)
    A.equal(recorder.errors[0].code, 'BPMN_ACTIVITY_TIMEOUT')
    A.equal(runner.pendingTasks().length, 0, '失败后待办清空')
    const errorEvent = recorder.events.find((event) => event.type === 'error')
    A.equal(errorEvent.elementId, 'n_human')
  })

  await check('runTimeoutMs：整轮跑不完 → runner blocked', async () => {
    const errors = []
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-timeout-run' }),
      limits: { runTimeoutMs: 60 },
      services: {
        async executeAgent() {
          return { output: {} }
        },
        onEvent() {},
        onError(error) {
          errors.push(error)
        },
      },
    }))
    A.equal((await runner.start()).state, 'waiting')
    await new Promise((resolve) => setTimeout(resolve, 200))
    A.equal(runner.status(), 'blocked')
    A.equal(errors.length, 1)
    A.equal(errors[0].code, 'BPMN_RUN_TIMEOUT')
  })

  // -------------------------------------------------------------------------
  // 6. LRU 活跃实例
  // -------------------------------------------------------------------------
  await check('LRU max=1：已落 state 的实例可淘汰；未落 state 的淘汰必须报错', async () => {
    // 前置：前面用例的实例都已 stop 并从活跃表摘除（check() 的 finally 保证）。
    A.equal(activeInstanceCount(), 0, '用例之间不残留活跃实例')

    // (a) 正向：A 停在等待点（默认 shouldSnapshot 已在 activity/wait 落过 state）。
    const aRecorder = makeRecorder()
    const a = track(createRunner({
      definition: makeDefinition({ id: 'def-lru-a' }),
      maxActiveInstances: 1,
      services: aRecorder.services(),
    }))
    await a.start()
    A.equal(a.status(), 'waiting')
    A.equal(activeInstanceCount(), 1)

    const bRecorder = makeRecorder()
    const b = track(createRunner({
      definition: makeDefinition({ id: 'def-lru-b' }),
      maxActiveInstances: 1,
      services: bRecorder.services(),
    }))
    A.equal(activeInstanceCount(), 1, '上限 1：插入 B 后 A 被淘汰')
    A.equal(a.status(), 'idle', '被淘汰的实例不再声称在跑')

    // 淘汰前落过的 state 还在（这就是「淘汰前必须落盘」的兑现方式）。
    const persisted = await a.getState()
    A.equal(persisted.status, 'waiting', 'getState() 还能拿到淘汰前的快照')
    A.equal(persisted.engine !== null, true, '快照里带着引擎状态')
    await A.rejects(() => a.signalTask({ activityId: 'n_human', payload: {} }), { code: 'BPMN_INSTANCE_EVICTED' })
    await A.rejects(() => a.start(), { code: 'BPMN_INSTANCE_EVICTED' })

    // (b) 负向：C 的 shouldSnapshot 一直 false → 淘汰时必须报错，并且不动集合。
    const cRecorder = makeRecorder()
    const c = track(createRunner({
      definition: makeDefinition({ id: 'def-lru-c' }),
      maxActiveInstances: 1,
      shouldSnapshot: () => false,
      services: cRecorder.services(),
    }))
    await c.start()
    A.equal(c.status(), 'waiting')
    A.equal(activeInstanceCount(), 1, '插入 C 时淘汰了 B')

    let evictionError = null
    try {
      createRunner({
        definition: makeDefinition({ id: 'def-lru-d' }),
        maxActiveInstances: 1,
        services: makeRecorder().services(),
      })
    } catch (error) {
      evictionError = error
    }
    A.ok(evictionError, '未落 state 的实例不能静默淘汰')
    A.equal(evictionError.code, 'BPMN_LRU_EVICT_UNSNAPSHOTTED')
    A.match(evictionError.message, /还没有落过 state|还没落过 state|没落过 state/)
    A.equal(activeInstanceCount(), 1, '淘汰失败时集合保持不变（没有偷偷丢实例）')
    A.equal(c.status(), 'waiting', 'C 不受影响，还能继续')

    // C 显式落一次 state 之后，淘汰就合法了（证明约定是「先落盘再淘汰」）。
    const cState = await c.getState()
    A.equal(cState.status, 'waiting')
    const dRecorder = makeRecorder()
    const d = track(createRunner({
      definition: makeDefinition({ id: 'def-lru-d' }),
      maxActiveInstances: 1,
      services: dRecorder.services(),
    }))
    A.equal(d.status(), 'idle')
    A.equal(c.status(), 'idle', '落过 state 后 C 被正常淘汰')
    A.equal(activeInstanceCount(), 1)
  })

  // -------------------------------------------------------------------------
  // 7. 加载期校验（红线）
  // -------------------------------------------------------------------------
  await check('加载期校验：缺 handler / 未知 kind / javascript 条件 / parallelGateway / 默认流条件', async () => {
    // 缺 handler：agent 节点必须配 executeAgent（否则引擎会跑到那里才 fatal）。
    A.throws(
      () => createRunner({ definition: makeDefinition({ id: 'def-no-handler' }), services: {} }),
      { code: 'BPMN_HANDLER_MISSING' }
    )

    // 未知 kind：加载期拒绝，不猜语义。
    const unknown = makeDefinition({ id: 'def-unknown-kind' })
    unknown.elements = unknown.elements.map((element) => (
      element.id === 'n_human' ? { ...element, kind: 'script' } : element
    ))
    A.throws(
      () => createRunner({ definition: unknown, services: makeRecorder().services() }),
      { code: 'BPMN_UNKNOWN_NODE_KIND' }
    )

    // 条件语言：只许 FEEL（javascript 走 node:vm，可逃逸到 process）。
    const jsCondition = makeDefinition({ id: 'def-js' })
    jsCondition.flows = jsCondition.flows.map((flow) => (
      flow.id === 'f_back' ? { ...flow, condition: { expression: 'approved === false', language: 'javascript' } } : flow
    ))
    A.throws(
      () => createRunner({ definition: jsCondition, services: makeRecorder().services() }),
      { code: 'BPMN_CONDITION_LANGUAGE_UNSUPPORTED' }
    )

    // XML 红线：并行网关（研究 #204：并行汇聚 + 成环会提前通过）。
    const parallelXml = FIXTURE_XML.replace(
      '<bpmn:exclusiveGateway id="n_gw"',
      '<bpmn:parallelGateway id="n_gw_p"'
    )
    A.throws(
      () => createRunner({
        definition: makeDefinition({ id: 'def-parallel' }),
        xml: parallelXml,
        services: makeRecorder().services(),
      }),
      { code: 'BPMN_GATEWAY_UNSUPPORTED' }
    )

    // definition 与 xml 不是同一版：节点 id 对不上要报错（否则派发不到 handler）。
    A.throws(
      () => createRunner({
        definition: makeDefinition({ id: 'def-mismatch', startId: 'n_start' }),
        xml: FIXTURE_XML.replace(/id="n_agent"/g, 'id="n_agent_renamed"'),
        services: makeRecorder().services(),
      }),
      { code: 'BPMN_XML_ELEMENT_MISSING' }
    )

    // definition-only 的反向生成：同一份 definition → 生成的 XML 稳定且能被引擎吃下。
    const generatedFirst = bpmnXmlFromDefinition(makeDefinition())
    const generatedSecond = bpmnXmlFromDefinition(makeDefinition())
    A.equal(generatedFirst, generatedSecond, '同一份 definition 生成的 XML 逐字节稳定')
    A.match(generatedFirst, /<bpmn:exclusiveGateway id="n_gw"[^>]*default="f_ok"/)
    A.match(generatedFirst, /language="feel">= approved = false</)
    A.equal(generatedFirst.includes('parallelGateway'), false)

    // 默认流带条件：按 BPMN 语义忽略 + 记 warning，不阻断（模板作者的常见笔误）。
    const defaultWithCondition = makeDefinition({ id: 'def-default-condition' })
    defaultWithCondition.flows = defaultWithCondition.flows.map((flow) => (
      flow.id === 'f_ok' ? { ...flow, condition: { expression: '= true', language: 'feel' } } : flow
    ))
    const warned = track(createRunner({
      definition: defaultWithCondition,
      services: makeRecorder().services(),
    }))
    const warnedState = await warned.getState()
    A.equal(warnedState.warnings.length, 1, '默认流带条件要留下 warning')
    A.match(warnedState.warnings[0], /默认流/)
  })

  // -------------------------------------------------------------------------
  // A1 · 条件 / 恢复入口封闭（BLOCKER）
  // -------------------------------------------------------------------------

  await check('A1：拒绝型内置表达式解析器（直接调用）', async () => {
    const { createRejectingExpressions } = await import('../src/bpmn-policy.js')
    const expressions = createRejectingExpressions()
    A.throws(() => expressions.resolveExpression('${approved}'), { code: 'BPMN_BUILTIN_EXPRESSION_FORBIDDEN' })
    A.equal(expressions.isExpression('${a}'), false, '不承认任何内置表达式语法')
    A.equal(expressions.hasExpression('${a}'), false, '不承认任何内置表达式语法')
  })

  await check('A1：条件 startEvent 在 runner 入口被拒（handler=0）', async () => {
    const recorder = makeRecorder()
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="D-cond" targetNamespace="http://x">
  <bpmn:process id="proc-cond" isExecutable="true">
    <bpmn:startEvent id="s">
      <bpmn:conditionalEventDefinition id="ced"><bpmn:condition xsi:type="bpmn:tFormalExpression" language="feel">= 1 &gt; 2</bpmn:condition></bpmn:conditionalEventDefinition>
    </bpmn:startEvent>
    <bpmn:serviceTask id="a" />
    <bpmn:userTask id="h" />
    <bpmn:endEvent id="e" />
    <bpmn:sequenceFlow id="f0" sourceRef="s" targetRef="a" />
    <bpmn:sequenceFlow id="f1" sourceRef="a" targetRef="h" />
    <bpmn:sequenceFlow id="f2" sourceRef="h" targetRef="e" />
  </bpmn:process>
</bpmn:definitions>`
    const definition = {
      id: 'proc-cond', startId: 's', endIds: ['e'],
      elements: [
        { id: 's', type: 'bpmn:StartEvent', kind: 'start' },
        // 真 serviceTask：让 handler=0 能证明「拒绝发生在任何派发之前」。
        { id: 'a', type: 'bpmn:ServiceTask', kind: 'agent' },
        { id: 'h', type: 'bpmn:UserTask', kind: 'human' },
        { id: 'e', type: 'bpmn:EndEvent', kind: 'end' },
      ],
      flows: [
        { id: 'f0', from: 's', to: 'a' },
        { id: 'f1', from: 'a', to: 'h' },
        { id: 'f2', from: 'h', to: 'e' },
      ],
    }
    const runner = track(createRunner({ definition, xml, services: recorder.services() }))
    await A.rejects(() => runner.start(), { code: 'BPMN_CONDITIONAL_EVENT_FORBIDDEN' })
    A.equal(recorder.handlerCalls.length, 0, '拒绝发生在任何 handler 之前')
    A.equal(runner.status(), 'idle', '未启动成功，保持 idle')
  })

  await check('A1：standardLoop 在 runner 入口被拒（handler=0）', async () => {
    const recorder = makeRecorder()
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D-loop" targetNamespace="http://x">
  <bpmn:process id="proc-loop" isExecutable="true">
    <bpmn:startEvent id="s" />
    <bpmn:serviceTask id="a">
      <bpmn:standardLoopCharacteristics testBefore="false" />
    </bpmn:serviceTask>
    <bpmn:endEvent id="e" />
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="a" />
    <bpmn:sequenceFlow id="f2" sourceRef="a" targetRef="e" />
  </bpmn:process>
</bpmn:definitions>`
    const definition = {
      id: 'proc-loop', startId: 's', endIds: ['e'],
      elements: [
        { id: 's', type: 'bpmn:StartEvent', kind: 'start' },
        { id: 'a', type: 'bpmn:ServiceTask', kind: 'agent', node: { kind: 'agent' } },
        { id: 'e', type: 'bpmn:EndEvent', kind: 'end' },
      ],
      flows: [
        { id: 'f1', from: 's', to: 'a' },
        { id: 'f2', from: 'a', to: 'e' },
      ],
    }
    const runner = track(createRunner({ definition, xml, services: recorder.services() }))
    await A.rejects(() => runner.start(), { code: 'BPMN_STANDARD_LOOP_FORBIDDEN' })
    A.equal(recorder.handlerCalls.length, 0)
  })

  await check('A1：definition-only 入口按原始 type 拒绝禁止网关（不先归一成 gateway）', async () => {
    const definition = {
      id: 'def-raw-parallel', startId: 's', endIds: ['e'],
      elements: [
        { id: 's', type: 'bpmn:StartEvent', kind: 'start' },
        { id: 'g', type: 'bpmn:ParallelGateway', kind: 'gateway' },
        { id: 'e', type: 'bpmn:EndEvent', kind: 'end' },
      ],
      flows: [
        { id: 'f1', from: 's', to: 'g' },
        { id: 'f2', from: 'g', to: 'e' },
      ],
    }
    A.throws(
      () => createRunner({ definition, services: makeRecorder().services() }),
      { code: 'PARALLEL_GATEWAY_FORBIDDEN' }
    )
  })

  // -------------------------------------------------------------------------
  // A1 · 恢复：裸快照 / 身份 / 结构（含条件、default）都要拒绝
  // -------------------------------------------------------------------------

  /** 造一个停在 userTask 的合法 state（agent 已跑过一次）。 */
  async function makeWaitingState(definitionId = 'def-recover-v2') {
    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeDefinition({ id: definitionId }),
      services: recorder.services(),
    }))
    A.equal((await runner.start()).state, 'waiting')
    return { state: JSON.parse(JSON.stringify(await runner.getState())), recorder }
  }

  await check('A1：裸快照（含 parallelGateway）→ BPMN_STATE_VERSION_UNSUPPORTED，handler=0', async () => {
    const { state } = await makeWaitingState('def-recover-bare')
    const bare = JSON.parse(JSON.stringify(state.engine))
    const source = JSON.parse(bare.definitions[0].source)
    const processId = source.processes[0].id
    source.activities.push({
      id: 'pg',
      type: 'bpmn:ParallelGateway',
      parent: { id: processId, type: 'bpmn:Process' },
      behaviour: { $type: 'bpmn:ParallelGateway', id: 'pg' },
    })
    bare.definitions[0].source = JSON.stringify(source)

    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-recover-bare' }),
      instanceId: state.instanceId,
      services: recorder.services(),
    }))
    await A.rejects(() => runner.recover(bare), { code: 'BPMN_STATE_VERSION_UNSUPPORTED' })
    A.equal(recorder.handlerCalls.length, 0, '裸快照不得派发 handler')
    A.equal(runner.status(), 'idle')
  })

  await check('A1：补齐合法 v2 身份但结构不同 → BPMN_STATE_DEFINITION_MISMATCH（handler=0）', async () => {
    const { state } = await makeWaitingState('def-recover-identity')
    const tampered = JSON.parse(JSON.stringify(state))
    const source = JSON.parse(tampered.engine.definitions[0].source)
    const processId = source.processes[0].id
    source.activities.push({
      id: 'pg',
      type: 'bpmn:ParallelGateway',
      parent: { id: processId, type: 'bpmn:Process' },
      behaviour: { $type: 'bpmn:ParallelGateway', id: 'pg' },
    })
    tampered.engine.definitions[0].source = JSON.stringify(source)

    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-recover-identity' }),
      instanceId: tampered.instanceId,
      services: recorder.services(),
    }))
    await A.rejects(() => runner.recover(tampered), { code: 'BPMN_STATE_DEFINITION_MISMATCH' })
    A.equal(recorder.handlerCalls.length, 0)
  })

  await check('A1：只篡改条件 / 只篡改 default 的快照同样拒绝（来源逐项对照）', async () => {
    const { state } = await makeWaitingState('def-recover-tamper')

    // (a) 改条件表达式
    const conditionTampered = JSON.parse(JSON.stringify(state))
    const conditionSource = JSON.parse(conditionTampered.engine.definitions[0].source)
    const flow = conditionSource.sequenceFlows.find(item => item.id === 'f_back')
    flow.behaviour.conditionExpression = {
      $type: 'bpmn:FormalExpression',
      language: 'feel',
      body: '= true',
    }
    conditionTampered.engine.definitions[0].source = JSON.stringify(conditionSource)
    {
      const recorder = makeRecorder()
      const runner = track(createRunner({
        definition: makeDefinition({ id: 'def-recover-tamper' }),
        instanceId: conditionTampered.instanceId,
        services: recorder.services(),
      }))
      await A.rejects(() => runner.recover(conditionTampered), { code: 'BPMN_STATE_DEFINITION_MISMATCH' })
      A.equal(recorder.handlerCalls.length, 0)
    }

    // (b) 改默认流标记（f_back 变成默认边）
    const defaultTampered = JSON.parse(JSON.stringify(state))
    const defaultSource = JSON.parse(defaultTampered.engine.definitions[0].source)
    defaultSource.sequenceFlows.find(item => item.id === 'f_back').isDefault = true
    defaultTampered.engine.definitions[0].source = JSON.stringify(defaultSource)
    {
      const recorder = makeRecorder()
      const runner = track(createRunner({
        definition: makeDefinition({ id: 'def-recover-tamper' }),
        instanceId: defaultTampered.instanceId,
        services: recorder.services(),
      }))
      await A.rejects(() => runner.recover(defaultTampered), { code: 'BPMN_STATE_DEFINITION_MISMATCH' })
      A.equal(recorder.handlerCalls.length, 0)
    }

    // (c) 删 definitionHash / 换 version 也必须失败
    {
      const noHash = JSON.parse(JSON.stringify(state))
      delete noHash.definitionHash
      const runner = track(createRunner({
        definition: makeDefinition({ id: 'def-recover-tamper' }),
        instanceId: noHash.instanceId,
        services: makeRecorder().services(),
      }))
      await A.rejects(() => runner.recover(noHash), { code: 'BPMN_STATE_VERSION_UNSUPPORTED' })
    }
    {
      const wrongVersion = JSON.parse(JSON.stringify(state))
      wrongVersion.version = 99
      const runner = track(createRunner({
        definition: makeDefinition({ id: 'def-recover-tamper' }),
        instanceId: wrongVersion.instanceId,
        services: makeRecorder().services(),
      }))
      await A.rejects(() => runner.recover(wrongVersion), { code: 'BPMN_STATE_DEFINITION_MISMATCH' })
    }
  })

  // -------------------------------------------------------------------------
  // A2 · 连线超限：默认边 / 无条件边 / 条件边都在**发布 take 之前**拦住
  // -------------------------------------------------------------------------

  /** `s → g → t(agent) → g`，进入 t 的那条边带 fs:maxRounds=1（三种边的形状可切换）。 */
  function makeEntryLimitDefinition({ definitionId, mode }) {
    const entryFlow = mode === 'default'
      ? { id: 'f_entry', from: 'g', to: 't', isDefault: true }
      : mode === 'conditional'
        ? { id: 'f_entry', from: 'g', to: 't', condition: { expression: '= true', language: 'feel' } }
        : { id: 'f_entry', from: 'g', to: 't' }
    entryFlow.extensions = [{ type: 'fs:MaxRounds', name: 'maxRounds', value: 1 }]
    const exitFlow = mode === 'conditional'
      ? { id: 'f_exit', from: 'g', to: 'e', isDefault: true }
      : { id: 'f_exit', from: 'g', to: 'e', condition: { expression: '= false', language: 'feel' } }
    if (mode === 'default' || mode === 'unconditional') {
      // 默认流 / 无条件边：另一条条件永远为 false，保证每次都走 f_entry。
    }
    return {
      id: definitionId, startId: 's', endIds: ['e'],
      elements: [
        { id: 's', kind: 'start', name: '开始' },
        { id: 'g', kind: 'gateway', name: '入口' },
        { id: 't', kind: 'agent', name: '目标' },
        { id: 'e', kind: 'end', name: '结束' },
      ],
      flows: [
        { id: 'f_start', from: 's', to: 'g' },
        entryFlow,
        { id: 'f_loop', from: 't', to: 'g' },
        exitFlow,
      ],
    }
  }

  for (const mode of ['default', 'unconditional', 'conditional']) {
    await check(`A2：${mode} 边 fs:maxRounds=1 → 第 2 次 take 前拦住（handler 恰好 1 次）`, async () => {
      const recorder = makeRecorder()
      const runner = track(createRunner({
        definition: makeEntryLimitDefinition({ definitionId: `def-entry-${mode}`, mode }),
        services: recorder.services(),
      }))
      await A.rejects(() => runner.start(), (error) => {
        A.equal(error.code, 'BPMN_FLOW_TAKE_LIMIT')
        A.equal(error.flowId, 'f_entry')
        A.equal(error.maxTakes, 1)
        A.equal(error.takes, 1, '已成功走过 1 次')
        A.equal(error.attemptedTake, 2, '被拦的是第 2 次')
        return true
      })
      A.equal(recorder.handlerCalls.length, 1, 'handler 恰好 1 次：超限边不得驱动目标')
      A.equal(runner._flowTakes.get('f_entry'), 1, 'flowTakes 只记成功走过的边')
      A.equal(runner.status(), 'blocked')
      const types = recorder.types()
      const errorIndex = types.indexOf('error')
      A.ok(errorIndex >= 0, 'error 事件必须存在')
      A.equal(types.slice(errorIndex + 1).includes('activity/start'), false, 'error 之后不得再有 activity/start')
      A.equal(types.includes('process/end'), false, '超限不是正常完成')
      const errorEvent = recorder.events.find(event => event.type === 'error')
      A.equal(errorEvent.error.attemptedTake, 2, 'error 事件带 attemptedTake')
      A.equal(recorder.errors.length, 1)
      A.equal(recorder.errors[0].code, 'BPMN_FLOW_TAKE_LIMIT')
    })
  }

  // -------------------------------------------------------------------------
  // A2 · handler 挂起时并发 stop：先 abort，晚到结果不生效
  // -------------------------------------------------------------------------

  await check('A2：handler 挂起时 stop → 先收到 abort；之后派发/回写都不生效', async () => {
    const events = []
    let aborted = false
    let release = null
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-stop-inflight' }),
      services: {
        executeAgent(element, ctx) {
          ctx.signal.addEventListener('abort', () => { aborted = true }, { once: true })
          return new Promise((resolve) => {
            release = () => resolve({ output: { late: true } })
          })
        },
        onEvent(event) { events.push(event) },
      },
    }))

    const started = runner.start()
    // 等 handler 真正在飞
    for (let index = 0; index < 100 && release === null; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    A.ok(release !== null, 'handler 在飞')
    await runner.stop()
    A.equal(aborted, true, 'stop 先发 abort 信号')
    A.equal(runner.status(), 'idle')
    const eventsAtStop = events.length
    const agentEndAtStop = events.filter(event => event.type === 'activity/end' && event.elementId === 'n_agent').length
    // 晚到成功：不得回写变量 / 发 activity/end / 推进引擎
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    A.equal(events.length, eventsAtStop, 'stop 之后不得再发任何事件')
    A.equal(
      events.filter(event => event.type === 'activity/end' && event.elementId === 'n_agent').length,
      agentEndAtStop,
      '晚到 handler 不得产生 agent 的 activity/end'
    )
    A.deepEqual(runner.variables, {}, '晚到输出不得写进变量账本')
    A.equal(runner.pendingTasks().length, 0)
    await started.catch(() => {})
  })

  // -------------------------------------------------------------------------
  // BLOCKER-1 · 快照布尔字段严格归一化 + 出边顺序 + 节点路由标记
  // -------------------------------------------------------------------------

  /** 两条条件出边（都为 true）：谁在前面谁先执行，用来证明顺序参与比较。 */
  function twoConditionalFixture() {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="D-order" targetNamespace="http://x">
  <bpmn:process id="P-order" isExecutable="true">
    <bpmn:startEvent id="s"/>
    <bpmn:userTask id="h"/>
    <bpmn:exclusiveGateway id="g"/>
    <bpmn:serviceTask id="a"/>
    <bpmn:serviceTask id="b"/>
    <bpmn:endEvent id="e"/>
    <bpmn:sequenceFlow id="f_sh" sourceRef="s" targetRef="h"/>
    <bpmn:sequenceFlow id="f_hg" sourceRef="h" targetRef="g"/>
    <bpmn:sequenceFlow id="f_ga" sourceRef="g" targetRef="a">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="feel">= true</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_gb" sourceRef="g" targetRef="b">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="feel">= true</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_ae" sourceRef="a" targetRef="e"/>
    <bpmn:sequenceFlow id="f_be" sourceRef="b" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`
    const definition = {
      id: 'P-order', startId: 's', endIds: ['e'],
      elements: [
        { id: 's', type: 'bpmn:StartEvent', kind: 'start' },
        { id: 'h', type: 'bpmn:UserTask', kind: 'human' },
        { id: 'g', type: 'bpmn:ExclusiveGateway', kind: 'gateway' },
        { id: 'a', type: 'bpmn:ServiceTask', kind: 'agent' },
        { id: 'b', type: 'bpmn:ServiceTask', kind: 'agent' },
        { id: 'e', type: 'bpmn:EndEvent', kind: 'end' },
      ],
      flows: [
        { id: 'f_sh', from: 's', to: 'h' },
        { id: 'f_hg', from: 'h', to: 'g' },
        { id: 'f_ga', from: 'g', to: 'a', condition: { expression: '= true', language: 'feel' } },
        { id: 'f_gb', from: 'g', to: 'b', condition: { expression: '= true', language: 'feel' } },
        { id: 'f_ae', from: 'a', to: 'e' },
        { id: 'f_be', from: 'b', to: 'e' },
      ],
    }
    return { xml, definition, definitionId: 'def-order' }
  }

  /** 起一个停在 userTask 的 runner，取快照后 stop（活跃表按 instanceId 唯一，必须释放）。 */
  async function waitingStateOf(options) {
    const runner = track(createRunner(options))
    const started = await runner.start()
    A.equal(started.state, 'waiting', '夹具必须停在 userTask')
    const state = JSON.parse(JSON.stringify(await runner.getState()))
    const instanceId = runner.instanceId
    await runner.stop()
    return { state, instanceId }
  }

  await check('B1：快照布尔字段只接受 true/false/缺省（isDefault 非布尔一律拒绝，handler=0）', async () => {
    const { state } = await makeWaitingState('def-bool-strict')
    for (const value of ['false', 1, {}, [], null]) {
      const tampered = JSON.parse(JSON.stringify(state))
      const source = JSON.parse(tampered.engine.definitions[0].source)
      source.sequenceFlows.find(flow => flow.id === 'f_back').isDefault = value
      tampered.engine.definitions[0].source = JSON.stringify(source)
      const recorder = makeRecorder()
      const runner = track(createRunner({
        definition: makeDefinition({ id: 'def-bool-strict' }),
        instanceId: state.instanceId,
        services: recorder.services(),
      }))
      await A.rejects(() => runner.recover(tampered), { code: 'BPMN_STATE_INVALID' })
      A.equal(recorder.handlerCalls.length, 0, `isDefault=${JSON.stringify(value)} 必须在恢复前拒绝且零派发`)
      A.equal(runner.status(), 'idle')
    }

    // 节点行为标记：字符串 "false" 同样拒绝；真正的 true 不拒绝类型，但必须与可信结构比较后拒绝。
    {
      const tampered = JSON.parse(JSON.stringify(state))
      const source = JSON.parse(tampered.engine.definitions[0].source)
      source.activities.find(activity => activity.id === 'n_gw').isParallelGateway = 'false'
      tampered.engine.definitions[0].source = JSON.stringify(source)
      const runner = track(createRunner({
        definition: makeDefinition({ id: 'def-bool-strict' }),
        instanceId: state.instanceId,
        services: makeRecorder().services(),
      }))
      await A.rejects(() => runner.recover(tampered), { code: 'BPMN_STATE_INVALID' })
    }
    {
      const tampered = JSON.parse(JSON.stringify(state))
      const source = JSON.parse(tampered.engine.definitions[0].source)
      source.activities.find(activity => activity.id === 'n_gw').isParallelGateway = true
      tampered.engine.definitions[0].source = JSON.stringify(source)
      const recorder = makeRecorder()
      const runner = track(createRunner({
        definition: makeDefinition({ id: 'def-bool-strict' }),
        instanceId: state.instanceId,
        services: recorder.services(),
      }))
      await A.rejects(() => runner.recover(tampered), { code: 'BPMN_STATE_DEFINITION_MISMATCH' })
      A.equal(recorder.handlerCalls.length, 0, '节点路由标记必须参与结构比较')
    }
  })

  await check('B1：交换两条条件边顺序 → 恢复前拒绝（handler=0）', async () => {
    const fixture = twoConditionalFixture()
    const { state, instanceId } = await waitingStateOf({
      definition: fixture.definition,
      xml: fixture.xml,
      services: makeRecorder().services(),
    })
    const tampered = JSON.parse(JSON.stringify(state))
    const source = JSON.parse(tampered.engine.definitions[0].source)
    const flows = source.sequenceFlows
    const indexA = flows.findIndex(flow => flow.id === 'f_ga')
    const indexB = flows.findIndex(flow => flow.id === 'f_gb')
    ;[flows[indexA], flows[indexB]] = [flows[indexB], flows[indexA]]
    tampered.engine.definitions[0].source = JSON.stringify(source)

    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: fixture.definition,
      xml: fixture.xml,
      instanceId,
      services: recorder.services(),
    }))
    await A.rejects(() => runner.recover(tampered), { code: 'BPMN_STATE_DEFINITION_MISMATCH' })
    A.equal(recorder.handlerCalls.length, 0, '顺序被改动时必须在恢复前拒绝，不能派发到错误分支')
  })

  // -------------------------------------------------------------------------
  // BLOCKER-2 · 补偿属性（isForCompensation / compensateEventDefinition）解析期拒绝
  // -------------------------------------------------------------------------

  await check('BLOCKER-2：补偿属性解析期拒绝，真实 serviceTask 在审批前零派发', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="D-comp" targetNamespace="http://x">
  <bpmn:process id="P-comp" isExecutable="true">
    <bpmn:startEvent id="s"/>
    <bpmn:userTask id="h"/>
    <bpmn:serviceTask id="b" isForCompensation="true">
      <bpmn:extensionElements>
        <fs:node nodeType="agent" adapter="custom"><fs:executor kind="custom" command="echo b"/></fs:node>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="e"/>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="h"/>
    <bpmn:sequenceFlow id="f2" sourceRef="h" targetRef="b"/>
    <bpmn:sequenceFlow id="f3" sourceRef="b" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`
    const parsed = await parseBpmn(xml)
    A.equal(parsed.ok, false, '带 isForCompensation 的流程必须解析失败')
    A.equal(
      parsed.errors.some(error => error.code === 'BPMN_EXECUTION_UNSUPPORTED' && /isForCompensation/.test(error.message)),
      true,
      '错误必须明确指出 isForCompensation'
    )

    const definition = {
      id: 'P-comp', startId: 's', endIds: ['e'],
      elements: [
        { id: 's', type: 'bpmn:StartEvent', kind: 'start' },
        { id: 'h', type: 'bpmn:UserTask', kind: 'human' },
        { id: 'b', type: 'bpmn:ServiceTask', kind: 'agent' },
        { id: 'e', type: 'bpmn:EndEvent', kind: 'end' },
      ],
      flows: [
        { id: 'f1', from: 's', to: 'h' },
        { id: 'f2', from: 'h', to: 'b' },
        { id: 'f3', from: 'b', to: 'e' },
      ],
    }
    const recorder = makeRecorder()
    const runner = track(createRunner({ definition, xml, services: recorder.services() }))
    await A.rejects(() => runner.start(), { code: 'BPMN_EXECUTION_UNSUPPORTED' })
    A.equal(recorder.handlerCalls.length, 0, '审批前零派发：下游 serviceTask 的 handler 一次都不能跑')

    // 补偿事件定义（boundary 上）同样拒绝；错误原因里要能看出补偿。
    const compensateEventXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D-comp-event" targetNamespace="http://x">
  <bpmn:process id="P-comp-event" isExecutable="true">
    <bpmn:startEvent id="s"/>
    <bpmn:userTask id="h"/>
    <bpmn:boundaryEvent id="be" attachedToRef="h">
      <bpmn:compensateEventDefinition id="ced" activityRef="h"/>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="e"/>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="h"/>
    <bpmn:sequenceFlow id="f2" sourceRef="h" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`
    const parsedEvent = await parseBpmn(compensateEventXml)
    A.equal(parsedEvent.ok, false, 'compensateEventDefinition 必须解析失败')
    A.equal(
      parsedEvent.errors.some(error => /compensate|补偿/i.test(error.message)),
      true,
      '错误原因必须能看出是补偿事件'
    )
  })

  // -------------------------------------------------------------------------
  // BLOCKER-3 · 异步准备期间 stop：取消代次必须阻止创建引擎 / 派发 / 状态复活
  // -------------------------------------------------------------------------

  await check('BLOCKER-3：start 在异步校验中遇 stop → 零派发、状态不复活', async () => {
    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-stop-during-start' }),
      services: recorder.services(),
    }))
    let release
    const gate = new Promise((resolveGate) => { release = resolveGate })
    const original = runner._prepareTrustedStructure.bind(runner)
    runner._prepareTrustedStructure = async (phase) => {
      await gate
      return original(phase)
    }

    const started = runner.start().catch(error => error)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await runner.stop()
    release()
    const outcome = await started

    A.equal(outcome?.code, 'BPMN_STOPPED', '已取消的启动必须抛 BPMN_STOPPED')
    A.equal(recorder.handlerCalls.length, 0, 'stop 之后不得再派发 handler')
    A.equal(runner.status(), 'idle', '状态不得复活成 waiting/running')
    A.equal(runner._engine, null)
    A.equal(runner.pendingTasks().length, 0)
  })

  await check('BLOCKER-3：recover 在异步校验中遇 stop → 不创建引擎、状态不复活', async () => {
    const { state } = await makeWaitingState('def-stop-during-recover')
    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-stop-during-recover' }),
      instanceId: state.instanceId,
      services: recorder.services(),
    }))
    let release
    const gate = new Promise((resolveGate) => { release = resolveGate })
    const original = runner._prepareTrustedStructure.bind(runner)
    runner._prepareTrustedStructure = async (phase) => {
      await gate
      return original(phase)
    }

    const recovered = runner.recover(state).catch(error => error)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await runner.stop()
    release()
    const outcome = await recovered

    A.equal(outcome?.code, 'BPMN_STOPPED', '已取消的恢复必须抛 BPMN_STOPPED')
    A.equal(runner.status(), 'idle', '状态不得复活成 waiting/running')
    A.equal(runner._engine, null, 'stop 之后不得创建引擎')
    A.equal(runner.pendingTasks().length, 0, '不得恢复出待办（执行位置不复活）')
    A.equal(recorder.handlerCalls.length, 0)
  })

  // -------------------------------------------------------------------------
  // MAJOR-1 · 信封绑定实例 / sourceHash / flowTakes 严格
  // -------------------------------------------------------------------------

  await check('MAJOR-1：instanceId 必须绑定目标实例；sourceHash 必须与 XML 一致', async () => {
    const { state } = await makeWaitingState('def-envelope-bind')

    // 异实例：即使结构、定义身份都对，也必须拒绝。
    {
      const tampered = JSON.parse(JSON.stringify(state))
      tampered.instanceId = 'i-another-instance'
      const recorder = makeRecorder()
      const runner = track(createRunner({
        definition: makeDefinition({ id: 'def-envelope-bind' }),
        services: recorder.services(),
      }))
      await A.rejects(() => runner.recover(tampered), { code: 'BPMN_STATE_INSTANCE_MISMATCH' })
      A.equal(recorder.handlerCalls.length, 0)
    }

    // sourceHash：缺失 / 伪造都拒绝。
    for (const mutate of [
      (tampered) => { delete tampered.sourceHash },
      (tampered) => { tampered.sourceHash = 'f'.repeat(64) },
      (tampered) => { tampered.sourceHash = 'not-a-hash' },
    ]) {
      const tampered = JSON.parse(JSON.stringify(state))
      mutate(tampered)
      const recorder = makeRecorder()
      const runner = track(createRunner({
        definition: makeDefinition({ id: 'def-envelope-bind' }),
        instanceId: state.instanceId,
        services: recorder.services(),
      }))
      await A.rejects(() => runner.recover(tampered), { code: 'BPMN_STATE_SOURCE_HASH_MISMATCH' })
      A.equal(recorder.handlerCalls.length, 0)
    }
  })

  await check('MAJOR-1：flowTakes 缺失/错类型/负数/删单条都拒绝，已耗尽边不复活', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="D-takes" targetNamespace="http://x">
  <bpmn:process id="P-takes" isExecutable="true">
    <bpmn:startEvent id="s"/>
    <bpmn:exclusiveGateway id="g" default="f_exit"/>
    <bpmn:serviceTask id="t"/>
    <bpmn:userTask id="h"/>
    <bpmn:endEvent id="e"/>
    <bpmn:sequenceFlow id="f_start" sourceRef="s" targetRef="g"/>
    <bpmn:sequenceFlow id="f_entry" sourceRef="g" targetRef="t">
      <bpmn:extensionElements><fs:maxRounds>1</fs:maxRounds></bpmn:extensionElements>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_th" sourceRef="t" targetRef="h"/>
    <bpmn:sequenceFlow id="f_hg" sourceRef="h" targetRef="g"/>
    <bpmn:sequenceFlow id="f_exit" sourceRef="g" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`
    const definition = {
      id: 'P-takes', startId: 's', endIds: ['e'],
      elements: [
        { id: 's', type: 'bpmn:StartEvent', kind: 'start' },
        { id: 'g', type: 'bpmn:ExclusiveGateway', kind: 'gateway' },
        { id: 't', type: 'bpmn:ServiceTask', kind: 'agent' },
        { id: 'h', type: 'bpmn:UserTask', kind: 'human' },
        { id: 'e', type: 'bpmn:EndEvent', kind: 'end' },
      ],
      flows: [
        { id: 'f_start', from: 's', to: 'g' },
        { id: 'f_entry', from: 'g', to: 't', extensions: [{ type: 'fs:MaxRounds', name: 'maxRounds', value: 1 }] },
        { id: 'f_th', from: 't', to: 'h' },
        { id: 'f_hg', from: 'h', to: 'g' },
        { id: 'f_exit', from: 'g', to: 'e', isDefault: true },
      ],
    }
    const { state } = await waitingStateOf({ definition, xml, services: makeRecorder().services() })
    A.deepEqual(state.flowTakes.find(([key]) => key === 'f_entry'), ['f_entry', 1], '夹具里 f_entry 已耗尽')

    for (const [label, mutate] of [
      ['删除整张 flowTakes', (tampered) => { delete tampered.flowTakes }],
      ['flowTakes 改成字符串', (tampered) => { tampered.flowTakes = 'f_entry:1' }],
      ['flowTakes 计数为负数', (tampered) => { tampered.flowTakes = [['f_entry', -1]] }],
      ['删掉已走过的那条计数', (tampered) => { tampered.flowTakes = tampered.flowTakes.filter(([key]) => key !== 'f_entry') }],
    ]) {
      const tampered = JSON.parse(JSON.stringify(state))
      mutate(tampered)
      const recorder = makeRecorder()
      const runner = track(createRunner({ definition, xml, instanceId: state.instanceId, services: recorder.services() }))
      await A.rejects(() => runner.recover(tampered), { code: 'BPMN_STATE_INVALID' })
      A.equal(recorder.handlerCalls.length, 0, `${label}：拒绝发生在任何 handler 之前`)
    }
  })

  // -------------------------------------------------------------------------
  // MAJOR-3 · handler 变量深拷贝（晚到写入不得改到 runner）
  // -------------------------------------------------------------------------

  await check('MAJOR-3：ctx.variables 是深拷贝，超时后改嵌套对象也影响不到 runner', async () => {
    let captured = null
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-deep-vars' }),
      variables: { obj: { x: 'before' }, list: [{ y: 1 }] },
      limits: { activityWaitMs: 40 },
      services: {
        executeAgent(element, ctx) {
          captured = ctx
          return new Promise(() => {})
        },
        onEvent() {},
      },
    }))
    await A.rejects(() => runner.start(), { code: 'BPMN_ACTIVITY_TIMEOUT' })
    A.ok(captured, 'handler 拿到 ctx')
    A.deepEqual(captured.variables, { obj: { x: 'before' }, list: [{ y: 1 }] })

    // 超时后 handler 仍可能改自己手里的嵌套对象：不得影响 runner 账本，也不得抛未捕获异常。
    captured.variables.obj.x = 'late'
    captured.variables.list.push({ y: 2 })
    A.deepEqual(runner.variables, { obj: { x: 'before' }, list: [{ y: 1 }] }, '嵌套对象必须深拷贝')
    A.equal(runner.status(), 'blocked')
  })

  // -------------------------------------------------------------------------
  // F1 · 异构 execution/broker：恢复前快速拒绝（不挂 298s）
  // -------------------------------------------------------------------------

  await check('F1：source 相同但 execution/broker 来自另一份引擎 → 2s 内拒绝且零派发', async () => {
    const foreignXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D-foreign" targetNamespace="http://x">
  <bpmn:process id="P-foreign" isExecutable="true">
    <bpmn:startEvent id="fs"/><bpmn:userTask id="fh"/><bpmn:endEvent id="fe"/>
    <bpmn:sequenceFlow id="ff1" sourceRef="fs" targetRef="fh"/>
    <bpmn:sequenceFlow id="ff2" sourceRef="fh" targetRef="fe"/>
  </bpmn:process>
</bpmn:definitions>`
    const foreignDefinition = {
      id: 'P-foreign', startId: 'fs', endIds: ['fe'],
      elements: [
        { id: 'fs', type: 'bpmn:StartEvent', kind: 'start' },
        { id: 'fh', type: 'bpmn:UserTask', kind: 'human' },
        { id: 'fe', type: 'bpmn:EndEvent', kind: 'end' },
      ],
      flows: [
        { id: 'ff1', from: 'fs', to: 'fh' },
        { id: 'ff2', from: 'fh', to: 'fe' },
      ],
    }
    const foreignRunner = track(createRunner({ definition: foreignDefinition, xml: foreignXml, services: makeRecorder().services() }))
    A.equal((await foreignRunner.start()).state, 'waiting')
    const foreignState = JSON.parse(JSON.stringify(await foreignRunner.getState()))
    await foreignRunner.stop()

    const { state } = await makeWaitingState('def-foreign-guard')
    state.engine.definitions[0].execution = foreignState.engine.definitions[0].execution
    state.engine.definitions[0].broker = foreignState.engine.definitions[0].broker

    const recorder = makeRecorder()
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-foreign-guard' }),
      instanceId: state.instanceId,
      services: recorder.services(),
    }))
    const startedAt = Date.now()
    await A.rejects(() => runner.recover(state), { code: 'BPMN_STATE_INVALID' })
    const elapsed = Date.now() - startedAt
    A.ok(elapsed < 2000, `异构 state 必须快速拒绝（实测 ${elapsed}ms，不能靠 298s settle 兜底）`)
    A.equal(recorder.handlerCalls.length, 0)
    A.equal(runner.status(), 'idle', '拒绝后不得留下半截执行状态')
  })

  await check('F1：recover settle 有界超时（BPMN_RECOVER_TIMEOUT，不无限等）', async () => {
    const { state } = await makeWaitingState('def-recover-timeout')
    const runner = track(createRunner({
      definition: makeDefinition({ id: 'def-recover-timeout' }),
      instanceId: state.instanceId,
      limits: { recoverSettleTimeoutMs: 40 },
      services: makeRecorder().services(),
    }))
    // 模拟「resume 后不产生事件、也永远不会静默」的坏引擎：settle 判定永远不完成。
    runner._shouldFinishSettle = () => false
    runner._checkQuiescent = async () => {}
    await A.rejects(() => runner.recover(state), { code: 'BPMN_RECOVER_TIMEOUT' })
    A.equal(runner.status(), 'blocked', '超时按失败收口，不把僵尸实例当恢复成功')
  })

  // -------------------------------------------------------------------------
  // F5 / F6 · 重复 id 与顶层 maxTakes 契约
  // -------------------------------------------------------------------------

  await check('F5：重复的 activity / sequenceFlow id → 稳定 BPMN_STATE_INVALID', async () => {
    const { state } = await makeWaitingState('def-duplicate-id')
    for (const target of ['activities', 'sequenceFlows']) {
      const tampered = JSON.parse(JSON.stringify(state))
      const source = JSON.parse(tampered.engine.definitions[0].source)
      source[target].push(JSON.parse(JSON.stringify(source[target][0])))
      tampered.engine.definitions[0].source = JSON.stringify(source)
      const recorder = makeRecorder()
      const runner = track(createRunner({
        definition: makeDefinition({ id: 'def-duplicate-id' }),
        instanceId: state.instanceId,
        services: recorder.services(),
      }))
      await A.rejects(() => runner.recover(tampered), { code: 'BPMN_STATE_INVALID' })
      A.equal(recorder.handlerCalls.length, 0)
    }
  })

  await check('F6：definition-only 顶层 maxTakes 生效（不再被静默丢弃）', async () => {
    const definition = {
      id: 'def-top-max', startId: 's', endIds: ['e'],
      elements: [
        { id: 's', kind: 'start' }, { id: 't', kind: 'agent' },
        { id: 'g', kind: 'gateway' }, { id: 'e', kind: 'end' },
      ],
      flows: [
        { id: 'f1', from: 's', to: 't' },
        { id: 'f2', from: 't', to: 'g' },
        { id: 'r1', from: 'g', to: 't', condition: { expression: '= true', language: 'feel' }, maxTakes: 1 },
        { id: 'f3', from: 'g', to: 'e', isDefault: true },
      ],
    }
    const recorder = makeRecorder()
    const runner = track(createRunner({ definition, loopGuardMax: 5, services: recorder.services() }))
    await A.rejects(() => runner.start(), (error) => {
      A.equal(error.code, 'BPMN_FLOW_TAKE_LIMIT', '顶层 maxTakes=1 必须在第 2 次 take 前生效，而不是等 loopGuard')
      A.equal(error.flowId, 'r1')
      return true
    })
    A.equal(recorder.handlerCalls.length, 2, 'handler 只跑 2 次（首次 + 唯一一次回边）')

    // 顶层与扩展冲突必须显式报错，不静默择一。
    const conflicting = JSON.parse(JSON.stringify(definition))
    conflicting.flows = conflicting.flows.map((flow) => (
      flow.id === 'r1'
        ? { ...flow, extensions: [{ type: 'fs:MaxRounds', name: 'maxRounds', value: 2 }] }
        : flow
    ))
    A.throws(
      () => createRunner({ definition: conflicting, services: makeRecorder().services() }),
      { code: 'BPMN_DEFINITION_INVALID' }
    )
  })

} finally {
  for (const runner of openRunners.splice(0)) {
    try {
      await runner.stop()
    } catch {
      // 清理阶段忽略。
    }
  }
}

console.log(`\n${checks} 组通过（${asserts} 条断言）`)
