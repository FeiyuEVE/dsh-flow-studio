/**
 * BPMN **执行白名单**（0.13 红线：条件与恢复入口封闭）。
 *
 * 引擎能加载的 BPMN 结构远多于我们能安全执行的子集：
 *   - 条件事件（`conditionalEventDefinition`）与标准循环会**绕过**我们的 `scripts.getScript`
 *     接管点，直接调用 bpmn-engine 内置的 `resolveExpression`（研究实测：`= 1 > 2` 的
 *     条件 startEvent 会直接跑完流程）；
 *   - 脚本任务（`scriptTask`）默认走 `node:vm`，实测可逃逸到 `process`；
 *   - 并行 / 包容 / 复杂 / 事件网关有上游 #204（并行汇聚 + 成环提前通过）。
 *
 * 本模块是**唯一**的白名单定义处，被两条入口复用：
 *   1. `parseBpmn()`：在 moddle 原始结构上检查（**归一化之前**，不能等未知元素被丢掉）；
 *   2. `bpmn-state.js`：在恢复快照反序列化出的**执行结构**上再查一遍（运行期兜底）。
 *
 * 只返回结构化违规项（`{code, message, elementId?}`），不抛错、不依赖 runner 的错误类，
 * 这样解析器 / 状态校验 / 单测可以各自决定怎么上报。
 *
 * @module @feiyueve/dsh/dsh-flow-studio/bpmn-policy
 */

/** 允许执行的 flow node 类型（白名单，不是黑名单）。 */
export const ALLOWED_ACTIVITY_TYPES = Object.freeze([
  'bpmn:StartEvent',
  'bpmn:EndEvent',
  'bpmn:ServiceTask',
  'bpmn:UserTask',
  'bpmn:ExclusiveGateway',
])

const ALLOWED_ACTIVITY_SET = new Set(ALLOWED_ACTIVITY_TYPES)

/** 统一 BPMN 类型的写法（`bpmn:ServiceTask` / `serviceTask` → `bpmn:serviceTask`）。 */
export function canonicalBpmnType(rawType) {
  const type = bpmnTypeOf(rawType)
  if (type === null) return null
  const index = type.indexOf(':')
  if (index < 0) return type
  return `${type.slice(0, index + 1)}${type.charAt(index + 1).toLowerCase()}${type.slice(index + 2)}`
}

/**
 * 无执行作用的元素：允许出现在 XML 里（DI / 注释 / 数据对象 / 泳道），
 * 引擎不会因为它们跑逻辑，也不影响「谁被执行」。
 */
const INERT_ELEMENT_TYPES = new Set([
  'bpmn:TextAnnotation',
  'bpmn:Association',
  'bpmn:Group',
  'bpmn:Category',
  'bpmn:CategoryValue',
  'bpmn:DataObject',
  'bpmn:DataObjectReference',
  'bpmn:DataStore',
  'bpmn:DataStoreReference',
  'bpmn:Lane',
  'bpmn:LaneSet',
])

/** 有专用错误码的禁止类型（其余白名单外的执行元素统一 BPMN_EXECUTION_UNSUPPORTED）。 */
const TYPE_CODES = Object.freeze({
  'bpmn:ParallelGateway': {
    code: 'PARALLEL_GATEWAY_FORBIDDEN',
    reason: '0.13 禁止 parallelGateway（上游 #204：并行汇聚 + 成环会提前通过）',
  },
  'bpmn:InclusiveGateway': {
    code: 'INCLUSIVE_GATEWAY_FORBIDDEN',
    reason: '0.13 禁止 inclusiveGateway（与并行汇聚同源的提前通过风险）',
  },
  'bpmn:ComplexGateway': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行 complexGateway（复杂汇聚语义不在白名单内）',
  },
  'bpmn:EventBasedGateway': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行 eventBasedGateway（事件竞争需要事件定义，全部不支持）',
  },
  'bpmn:ScriptTask': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行 scriptTask（bpmn-engine 的 javascript 走 node:vm，实测可逃逸到 process）',
  },
  'bpmn:SubProcess': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行 subProcess（子流程/事件子流程不在白名单内）',
  },
  'bpmn:AdHocSubProcess': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行 adHocSubProcess（Ad-hoc 完成条件会走内置表达式）',
  },
  'bpmn:Transaction': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行 transaction（事务子流程不在白名单内）',
  },
  'bpmn:CallActivity': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行 callActivity（calledElement 解析不到会变成 wait-state）',
  },
  'bpmn:IntermediateCatchEvent': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行中间捕获事件（事件定义全部不支持）',
  },
  'bpmn:IntermediateThrowEvent': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行中间抛出事件（事件定义全部不支持）',
  },
  'bpmn:BoundaryEvent': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行 boundaryEvent（定时器/错误边界事件不在白名单内）',
  },
  'bpmn:Task': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行裸 task（没有 handler 绑定，也没有人工完成语义）',
  },
  'bpmn:ManualTask': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行 manualTask（人工任务只用 userTask）',
  },
  'bpmn:SendTask': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行 sendTask（消息实现不在白名单内）',
  },
  'bpmn:ReceiveTask': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行 receiveTask（消息实现不在白名单内）',
  },
  'bpmn:BusinessRuleTask': {
    code: 'BPMN_EXECUTION_UNSUPPORTED',
    reason: '0.13 不执行 businessRuleTask（DMN/实现不在白名单内）',
  },
})

/** `bpmn:` 前缀补齐（parse 的归一化 type 与 moddle `$type` 都吃）。 */
export function bpmnTypeOf(rawType) {
  if (typeof rawType !== 'string' || rawType.trim() === '') return null
  const text = rawType.trim()
  return text.includes(':') ? text : `bpmn:${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

/**
 * 单个活动类型是否可执行；不可执行时返回违规项（有专用错误码的用专用码）。
 *
 * @param {string} rawType `bpmn:ServiceTask` / `serviceTask` / 空
 * @param {string} elementId
 * @returns {null | {code: string, message: string, elementId?: string}}
 */
export function violationForActivityType(rawType, elementId) {
  const type = bpmnTypeOf(rawType)
  if (type !== null && ALLOWED_ACTIVITY_SET.has(type)) return null
  const mapped = type === null ? null : TYPE_CODES[type]
  const id = typeof elementId === 'string' && elementId !== '' ? elementId : '?'
  if (mapped) return violation(mapped.code, `${mapped.reason}：${id}（${type ?? '(无类型)'}）。`, { elementId })
  return violation(
    'BPMN_EXECUTION_UNSUPPORTED',
    `0.13 执行白名单只允许 startEvent / endEvent / serviceTask / userTask / exclusiveGateway，当前出现 ${type ?? '(无类型)'}：${id}。`,
    { elementId }
  )
}

/** 违规项构造（保持字段顺序稳定，便于测试与日志）。 */
function violation(code, message, extra = {}) {
  const item = { code, message }
  if (typeof extra.elementId === 'string' && extra.elementId !== '') item.elementId = extra.elementId
  return item
}

/** 事件定义：条件事件单独报 `BPMN_CONDITIONAL_EVENT_FORBIDDEN`，其余一律 unsupported。 */
function eventDefinitionViolations(element, elementId) {
  const definitions = Array.isArray(element?.eventDefinitions) ? element.eventDefinitions : []
  if (definitions.length === 0) return []
  const hasConditional = definitions.some(item => item?.$type === 'bpmn:ConditionalEventDefinition')
  if (hasConditional) {
    return [violation(
      'BPMN_CONDITIONAL_EVENT_FORBIDDEN',
      `0.13 禁止带条件的 start/end/中间事件：${elementId ?? '?'} 的 conditionalEventDefinition 会绕过 FEEL 接管点，直接调用内置表达式求值。`,
      { elementId }
    )]
  }
  return [violation(
    'BPMN_EXECUTION_UNSUPPORTED',
    `0.13 禁止事件定义：${elementId ?? '?'} 带了 ${definitions.map(item => item?.$type ?? '?').join('、')}；所有事件定义（timer/message/signal/error/…）都不在执行白名单内。`,
    { elementId }
  )]
}

/** 循环特征：标准循环 / 多实例分别有专用错误码。 */
function loopViolations(element, elementId) {
  const loop = element?.loopCharacteristics
  if (!loop) return []
  const type = typeof loop?.$type === 'string' ? loop.$type : ''
  if (type === 'bpmn:StandardLoopCharacteristics') {
    return [violation(
      'BPMN_STANDARD_LOOP_FORBIDDEN',
      `0.13 禁止 standardLoopCharacteristics：${elementId ?? '?'} 的循环条件会走内置 resolveExpression（不经过 scripts.getScript），条件可能被忽略或恒真。`,
      { elementId }
    )]
  }
  if (type === 'bpmn:MultiInstanceLoopCharacteristics') {
    return [violation(
      'MULTI_INSTANCE_FORBIDDEN',
      `0.13 禁止 multiInstanceLoopCharacteristics（团队走节点内 fan-out，不用 BPMN 多实例）：${elementId ?? '?'}。`,
      { elementId }
    )]
  }
  return [violation(
    'BPMN_EXECUTION_UNSUPPORTED',
    `0.13 不接受未知循环特征 ${type || '(无 $type)'}：${elementId ?? '?'}。`,
    { elementId }
  )]
}

/** 实现/脚本类属性：一律拒绝（它们都可能绕过我们的 FEEL 接管点）。 */
function implementationViolations(element, elementId) {
  const items = []
  const implementation = eventlessString(element?.implementation)
  if (implementation !== null) {
    items.push(violation(
      'BPMN_EXECUTION_UNSUPPORTED',
      `0.13 禁止 implementation=${JSON.stringify(implementation)}：${elementId ?? '?'} 的 service 实现会经 resolveExpression 解析。`,
      { elementId }
    ))
  }
  const scriptFormat = eventlessString(element?.scriptFormat)
  if (scriptFormat !== null) {
    items.push(violation(
      'BPMN_EXECUTION_UNSUPPORTED',
      `0.13 禁止 scriptFormat=${JSON.stringify(scriptFormat)}：${elementId ?? '?'} 会加载脚本实现，不是沙箱。`,
      { elementId }
    ))
  }
  return items
}

function eventlessString(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 在 moddle 原始结构上收集违规项（parseBpmn 在**归一化之前**调用）。
 *
 * @param {object|null} process `bpmn:Process` 原始 moddle 元素
 * @returns {Array<{code: string, message: string, elementId?: string}>}
 */
export function collectRawExecutionViolations(process) {
  const violations = []
  if (!process || process.$type !== 'bpmn:Process') {
    violations.push(violation('BPMN_NO_PROCESS', 'bpmn:definitions 里没有 bpmn:process。'))
    return violations
  }
  if (process.triggeredByEvent === true) {
    violations.push(violation(
      'BPMN_EXECUTION_UNSUPPORTED',
      `0.13 不执行事件子流程（process ${process.id ?? '?'} 带 triggeredByEvent）。`
    ))
  }

  const flowElements = Array.isArray(process.flowElements) ? process.flowElements : []
  for (const element of flowElements) {
    const type = typeof element?.$type === 'string' ? element.$type : ''
    const elementId = typeof element?.id === 'string' && element.id !== '' ? element.id : null

    if (type === 'bpmn:SequenceFlow') {
      // 条件语言/安全由 readCondition 负责；这里只查 flow 上不该出现的执行属性。
      violations.push(...implementationViolations(element, elementId))
      continue
    }
    if (type === '' || INERT_ELEMENT_TYPES.has(type)) continue

    violations.push(...eventDefinitionViolations(element, elementId))
    violations.push(...loopViolations(element, elementId))
    violations.push(...implementationViolations(element, elementId))

    if (ALLOWED_ACTIVITY_SET.has(type)) continue
    const mapped = TYPE_CODES[type]
    if (mapped) {
      violations.push(violation(
        mapped.code,
        `${mapped.reason}：${elementId ?? '?'}（${type}）。`,
        { elementId }
      ))
    } else {
      violations.push(violation(
        'BPMN_EXECUTION_UNSUPPORTED',
        `0.13 执行白名单只允许 startEvent / endEvent / serviceTask / userTask / exclusiveGateway / sequenceFlow，当前出现 ${type}：${elementId ?? '?'}。`,
        { elementId }
      ))
    }
  }
  return violations
}

/**
 * 在**序列化后的执行上下文**（`SerializableContext.elements`）上收集违规项。
 *
 * 这是恢复路径的兜底：快照里的 `source` 反序列化后就是这份结构，即使外层信封被伪造，
 * 也要先过白名单再交给 `engine.recover()`。
 *
 * @param {{ elements?: object } | null} serializedContext
 * @returns {Array<{code: string, message: string, elementId?: string}>}
 */
export function collectSerializedExecutionViolations(serializedContext) {
  const violations = []
  const elements = serializedContext && typeof serializedContext === 'object'
    ? serializedContext.elements
    : null
  if (!elements || typeof elements !== 'object') {
    return [violation('BPMN_STATE_INVALID', '快照里没有可读取的执行结构（elements）。')]
  }

  const processes = Array.isArray(elements.processes) ? elements.processes : []
  if (processes.length !== 1) {
    violations.push(violation(
      'BPMN_EXECUTION_UNSUPPORTED',
      `0.13 只允许单 process，快照里执行结构有 ${processes.length} 个 process。`
    ))
  }
  for (const process of processes) {
    if (process?.behaviour?.triggeredByEvent === true) {
      violations.push(violation(
        'BPMN_EXECUTION_UNSUPPORTED',
        `0.13 不执行事件子流程（process ${process.id ?? '?'} 带 triggeredByEvent）。`,
        { elementId: process.id }
      ))
    }
  }

  const activities = Array.isArray(elements.activities) ? elements.activities : []
  for (const activity of activities) {
    const type = typeof activity?.type === 'string' ? activity.type : ''
    const elementId = typeof activity?.id === 'string' && activity.id !== '' ? activity.id : null
    const behaviour = activity?.behaviour && typeof activity.behaviour === 'object' ? activity.behaviour : {}

    violations.push(...eventDefinitionViolations(behaviour, elementId))
    violations.push(...loopViolations(behaviour, elementId))
    violations.push(...implementationViolations(behaviour, elementId))

    if (ALLOWED_ACTIVITY_SET.has(type)) continue
    const mapped = TYPE_CODES[type]
    if (mapped) {
      violations.push(violation(mapped.code, `${mapped.reason}：${elementId ?? '?'}（${type}）。`, { elementId }))
    } else {
      violations.push(violation(
        'BPMN_EXECUTION_UNSUPPORTED',
        `0.13 执行白名单只允许 startEvent / endEvent / serviceTask / userTask / exclusiveGateway，快照里出现 ${type || '(未知类型)'}：${elementId ?? '?'}。`,
        { elementId }
      ))
    }
  }
  return violations
}

/**
 * 拒绝型 `expressions.resolveExpression`（运行期兜底，**不是**条件求值入口）。
 *
 * bpmn-engine 的 `ConditionalEventDefinition` / `LoopCharacteristics` / `ServiceImplementation`
 * 会直接调用 `environment.resolveExpression()`，绕过 `scripts.getScript`。白名单已经把它们
 * 拒在门外；这一层保证「即使将来漏了某个入口」，内置表达式引擎也不会被使用。
 *
 * 返回的对象形状与 `bpmn-elements/src/Expressions.js` 一致；`isExpression` / `hasExpression`
 * 一律返回 false（我们从不承认任何内置表达式语法）。
 *
 * @returns {{ resolveExpression: (expression: unknown) => never, isExpression: () => false, hasExpression: () => false }}
 */
export function createRejectingExpressions() {
  return {
    resolveExpression(expression) {
      const preview = typeof expression === 'string' ? expression.slice(0, 120) : String(expression)
      const error = new Error(
        `内置表达式求值被拒绝（BPMN_BUILTIN_EXPRESSION_FORBIDDEN）：${preview}。0.13 的条件只允许经 bpmn-expr.evaluateFeel 求值。`
      )
      error.name = 'BpmnBuiltinExpressionForbiddenError'
      error.code = 'BPMN_BUILTIN_EXPRESSION_FORBIDDEN'
      throw error
    },
    isExpression() {
      return false
    },
    hasExpression() {
      return false
    },
  }
}
