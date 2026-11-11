/**
 * BPMN runner 快照信封（v2）与**恢复来源校验**（0.13 红线：恢复入口封闭）。
 *
 * 背景（审查实测）：`bpmn-engine` 的 `recover()` 优先反序列化
 * `state.definitions[].source`（`node_modules/bpmn-engine/src/index.js:183`），
 * **不会**用调用方传进来的 XML。也就是说：只校验外层 `definitionId` 挡不住
 * 「安全 XML + 恶意裸快照」——快照里的并行网关、条件事件、脚本任务都会被直接执行。
 *
 * 因此恢复路径固定为：
 *   1. 校验信封（`v=2`、必填字段、身份 `definitionId/hash/version/processId`）；
 *   2. 有界解析 `engine.definitions[].source`（恰好一份、有 source、大小受限）；
 *   3. 用与执行完全相同的 moddle/serializer 从**可信 XML** 生成执行结构，
 *      与快照里的结构逐项比较（元素 id/type/配置、连线端点/条件/default/上限、start/end）；
 *   4. 交给 `engine.recover()`；
 *   5. 再核对恢复后的 `definition.context` 与 `environment.options.source`。
 *
 * 任一步不符都抛 {@link BpmnStateError}（runner 会转成 `BpmnRunnerError` 并清理实例）。
 * 本模块不做 state 迁移、不补 hash、不接受裸 `bpmn-engine` 快照。
 *
 * @module @feiyueve/dsh/dsh-flow-studio/bpmn-state
 */

import { createHash } from 'node:crypto'

import { Engine } from 'bpmn-engine'

import {
  canonicalBpmnType,
  collectSerializedExecutionViolations,
} from './bpmn-policy.js'

/** 快照信封版本：v1（无身份字段）与裸快照一律拒绝，不迁移。 */
export const BPMN_STATE_VERSION = 2
/** 只认自己写的信封。 */
export const BPMN_STATE_KIND = 'dsh-flow-studio/bpmn-runner-state'
/** 单个 `engine.definitions[].source` 的字节上限（正常 4–40KB；2MB 是异常闸门）。 */
export const MAX_STATE_SOURCE_BYTES = 2 * 1024 * 1024
/** 信封必填字段（缺一个就按「不认识的快照」拒绝）。 */
export const STATE_ENVELOPE_FIELDS = Object.freeze([
  'kind',
  'instanceId',
  'definitionId',
  'definitionHash',
  'version',
  'processId',
])

const HASH_PATTERN = /^[0-9a-f]{64}$/

/** 恢复/定义校验类错误：`code` 是稳定契约，runner 转成 `BpmnRunnerError`。 */
export class BpmnStateError extends Error {
  constructor(code, message, details = {}) {
    super(typeof message === 'string' && message !== '' ? message : code)
    this.name = 'BpmnStateError'
    this.code = code
    Object.assign(this, details)
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function errorMessageOf(error) {
  if (typeof error === 'string' && error !== '') return error
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return '未知错误'
}

/** 对字符串/字节做 sha256（小写 hex）。runtime 与 runner 用同一实现。 */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 归一化 runner 的 `definitionIdentity`（run 的**存储域**身份，不是 XML processId）。
 *
 * - `id`：定义域 definitionId（`checkRunId` 形状由存储层负责，这里只要求非空）；
 * - `version`：定义版本（≥1 的整数）；
 * - `hash`：**可信 XML 原文**的 sha256（64 位小写 hex）。
 *
 * @param {unknown} raw
 * @returns {{ id: string, version: number, hash: string }}
 */
export function normalizeDefinitionIdentity(raw) {
  if (!isPlainObject(raw)) {
    throw new BpmnStateError('BPMN_OPTIONS_INVALID', 'options.definitionIdentity 必须是 { id, version, hash } 对象')
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') {
    throw new BpmnStateError('BPMN_OPTIONS_INVALID', 'options.definitionIdentity.id 必须是非空字符串（定义域 definitionId）')
  }
  if (!Number.isSafeInteger(raw.version) || raw.version < 1) {
    throw new BpmnStateError('BPMN_OPTIONS_INVALID', 'options.definitionIdentity.version 必须是 ≥1 的整数（定义版本）')
  }
  const hash = typeof raw.hash === 'string' ? raw.hash.trim().toLowerCase() : ''
  if (!HASH_PATTERN.test(hash)) {
    throw new BpmnStateError('BPMN_OPTIONS_INVALID', 'options.definitionIdentity.hash 必须是 64 位小写十六进制（XML 原文 sha256）')
  }
  return { id, version: raw.version, hash }
}

/**
 * 校验「调用方声明的 identity」与「runner 实际要执行的 XML」一致。
 *
 * 这是 start 与 recover 共同的第一道身份闸：hash 不匹配说明调用方拿的不是这份 XML，
 * 后面的结构比较也就没有意义。
 *
 * @param {{ id: string, version: number, hash: string }} identity
 * @param {{ sourceXml: string, definition: { id?: string } }} input
 * @returns {{ sourceHash: string, processId: string }}
 */
export function assertDefinitionIdentity(identity, { sourceXml, definition }) {
  const sourceHash = sha256Hex(sourceXml)
  if (sourceHash !== identity.hash) {
    throw new BpmnStateError(
      'BPMN_DEFINITION_IDENTITY_MISMATCH',
      `definitionIdentity.hash=${identity.hash} 与执行 XML 的 sha256=${sourceHash} 不一致：调用方声明的是另一份定义`,
      { expectedHash: identity.hash, actualHash: sourceHash }
    )
  }
  const processId = typeof definition?.id === 'string' ? definition.id : ''
  if (processId === '') {
    throw new BpmnStateError('BPMN_DEFINITION_INVALID', 'definition.id（XML process.id）必须是非空字符串')
  }
  return { sourceHash, processId }
}

/**
 * 有界解析一份 state `source`：`JSON.parse` 后语义必须是执行结构。
 *
 * @param {unknown} sourceJson
 * @param {string} label
 * @returns {object} 序列化后的执行上下文（`{ id, type, name, elements }`）
 */
function parseStateSource(sourceJson, label) {
  if (typeof sourceJson !== 'string' || sourceJson.trim() === '') {
    throw new BpmnStateError('BPMN_STATE_INVALID', `${label} 没有 source：快照里没有可恢复的执行结构`)
  }
  if (Buffer.byteLength(sourceJson, 'utf8') > MAX_STATE_SOURCE_BYTES) {
    throw new BpmnStateError(
      'BPMN_STATE_INVALID',
      `${label} 的 source 超过 ${MAX_STATE_SOURCE_BYTES} 字节上限，拒绝解析`
    )
  }
  let parsed
  try {
    parsed = JSON.parse(sourceJson)
  } catch (error) {
    throw new BpmnStateError('BPMN_STATE_INVALID', `${label} 的 source 不是合法 JSON：${errorMessageOf(error)}`)
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.elements)) {
    throw new BpmnStateError('BPMN_STATE_INVALID', `${label} 的 source 不是 bpmn-engine 的序列化执行上下文`)
  }
  return parsed
}

/**
 * 校验并解包 state 信封（v2）。
 *
 * @param {unknown} state
 * @param {{
 *   identity: { id: string, version: number, hash: string },
 *   definition: { id?: string },
 *   instanceId?: string,
 * }} input
 * @returns {{
 *   envelope: object,
 *   engineState: object,
 *   sourceContext: object,
 *   variables: object,
 *   attempts: unknown,
 *   flowTakes: unknown,
 * }}
 */
export function validateStateEnvelope(state, { identity, definition, instanceId }) {
  if (!isPlainObject(state)) {
    throw new BpmnStateError('BPMN_STATE_INVALID', 'recover(state) 需要一个 state 对象')
  }
  // 裸 bpmn-engine 快照 / v1 信封：没有我们的 v2 身份，一律拒绝（不补、不迁移）。
  if (state.v !== BPMN_STATE_VERSION || state.kind !== BPMN_STATE_KIND) {
    const label = state.v === undefined
      ? 'state 没有 v/kind 信封（裸 bpmn-engine 快照）'
      : `state 版本是 ${JSON.stringify(state.v)}，本执行器只认 v${BPMN_STATE_VERSION}`
    throw new BpmnStateError(
      'BPMN_STATE_VERSION_UNSUPPORTED',
      `${label}：拒绝恢复。0.13 不接受无身份快照，也不做历史 state 迁移`
    )
  }
  for (const field of STATE_ENVELOPE_FIELDS) {
    if (state[field] === undefined || state[field] === null) {
      throw new BpmnStateError(
        'BPMN_STATE_VERSION_UNSUPPORTED',
        `state 信封缺少必填字段 ${field}；不完整的 v2 信封按不支持处理`
      )
    }
  }
  if (typeof state.instanceId !== 'string' || state.instanceId === '') {
    throw new BpmnStateError('BPMN_STATE_INVALID', 'state.instanceId 必须是非空字符串')
  }
  if (typeof instanceId === 'string' && instanceId !== '' && state.instanceId !== instanceId) {
    throw new BpmnStateError(
      'BPMN_STATE_INVALID',
      `state 属于实例 ${state.instanceId}，当前 runner 是 ${instanceId}；拒绝跨实例恢复`
    )
  }
  if (typeof state.definitionId !== 'string' || state.definitionId !== identity.id) {
    throw new BpmnStateError(
      'BPMN_STATE_DEFINITION_MISMATCH',
      `state 属于 definition ${JSON.stringify(state.definitionId)}，当前执行器是 ${identity.id}；拒绝跨流程恢复`
    )
  }
  if (typeof state.version !== 'number' || state.version !== identity.version) {
    throw new BpmnStateError(
      'BPMN_STATE_DEFINITION_MISMATCH',
      `state 的定义版本是 ${JSON.stringify(state.version)}，当前执行器是 ${identity.version}；拒绝跨版本恢复`
    )
  }
  if (typeof state.definitionHash !== 'string' || state.definitionHash !== identity.hash) {
    throw new BpmnStateError(
      'BPMN_STATE_DEFINITION_MISMATCH',
      `state 的 definitionHash=${JSON.stringify(state.definitionHash)} 与当前定义的 ${identity.hash} 不一致；拒绝恢复`
    )
  }
  const processId = typeof definition?.id === 'string' ? definition.id : ''
  if (typeof state.processId !== 'string' || state.processId !== processId) {
    throw new BpmnStateError(
      'BPMN_STATE_DEFINITION_MISMATCH',
      `state 的 processId=${JSON.stringify(state.processId)} 与当前定义 process.id=${JSON.stringify(processId)} 不一致`
    )
  }

  const engineState = isPlainObject(state.engine) ? state.engine : null
  if (engineState === null) {
    throw new BpmnStateError('BPMN_STATE_INVALID', 'state.engine 必须是 bpmn-engine 的快照对象')
  }
  const definitions = engineState.definitions
  if (!Array.isArray(definitions) || definitions.length !== 1) {
    throw new BpmnStateError(
      'BPMN_STATE_INVALID',
      `state.engine.definitions 必须恰好一份，当前是 ${Array.isArray(definitions) ? definitions.length : '(缺失)'} 份`
    )
  }
  const source = definitions[0]?.source
  const sourceContext = parseStateSource(source, 'state.engine.definitions[0]')

  if (state.variables !== undefined && state.variables !== null && !isPlainObject(state.variables)) {
    throw new BpmnStateError('BPMN_STATE_INVALID', 'state.variables 必须是 JSON 对象')
  }

  return {
    envelope: state,
    engineState,
    sourceContext,
    variables: isPlainObject(state.variables) ? state.variables : {},
    attempts: state.attempts,
    flowTakes: state.flowTakes,
  }
}

// ---------------------------------------------------------------------------
// 执行结构：可信 XML → 规范化描述；快照 source → 规范化描述
// ---------------------------------------------------------------------------

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value)
    return text === undefined ? 'null' : text
  }
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  const parts = []
  for (const key of keys) {
    const text = stableStringify(value[key])
    if (text === undefined) continue
    parts.push(`${JSON.stringify(key)}:${text}`)
  }
  return `{${parts.join(',')}}`
}

function parentIdOf(value) {
  const parent = value?.parent
  if (!parent) return null
  if (typeof parent.id === 'string') return parent.id
  return null
}

function readConditionOf(behaviour) {
  const condition = behaviour?.conditionExpression
  if (!condition) return null
  const body = typeof condition.body === 'string' ? condition.body : null
  if (body === null) return null
  const language = typeof condition.language === 'string' ? condition.language : null
  return { expression: body, language }
}

/** 序列化执行上下文里的 `fs:maxRounds`（默认 moddle 会保留成 `{$type:'fs:maxRounds',$body}`）。 */
export function readSerializedMaxTakes(behaviour) {
  const values = behaviour?.extensionElements?.values
  if (!Array.isArray(values)) return null
  for (const value of values) {
    const type = typeof value?.$type === 'string' ? value.$type.toLowerCase() : ''
    const name = typeof value?.name === 'string' ? value.name.toLowerCase() : ''
    if (type !== 'fs:maxrounds' && name !== 'maxrounds') continue
    const raw = value.$body ?? value.value
    const number = typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN
    if (Number.isSafeInteger(number) && number >= 1) return number
  }
  return null
}

/**
 * 把一份序列化执行上下文压成**可比较的结构描述**。
 *
 * 保留完整 `behaviour`（节点扩展配置 / 条件 / 默认流标记都在里面）——只比图的拓扑不够，
 * 换条件、换扩展配置同样必须拒绝。
 *
 * @param {{ elements?: object } | null} sourceContext
 * @returns {object}
 */
export function describeExecutionStructure(sourceContext) {
  const elements = isPlainObject(sourceContext?.elements) ? sourceContext.elements : {}
  const definition = isPlainObject(elements.definition) ? elements.definition : {}
  const processes = toArray(elements.processes)
    .map(process => ({
      id: typeof process?.id === 'string' ? process.id : null,
      type: typeof process?.type === 'string' ? process.type : null,
      name: typeof process?.name === 'string' ? process.name : null,
      parentId: parentIdOf(process),
      behaviour: process?.behaviour ?? null,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const activities = toArray(elements.activities)
    .map(activity => ({
      id: typeof activity?.id === 'string' ? activity.id : null,
      type: typeof activity?.type === 'string' ? activity.type : null,
      name: typeof activity?.name === 'string' ? activity.name : null,
      parentId: parentIdOf(activity),
      behaviour: activity?.behaviour ?? null,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const flows = toArray(elements.sequenceFlows)
    .map(flow => ({
      id: typeof flow?.id === 'string' ? flow.id : null,
      type: typeof flow?.type === 'string' ? flow.type : null,
      name: typeof flow?.name === 'string' ? flow.name : null,
      parentId: parentIdOf(flow),
      from: typeof flow?.sourceId === 'string' ? flow.sourceId : null,
      to: typeof flow?.targetId === 'string' ? flow.targetId : null,
      isDefault: flow?.isDefault === true,
      condition: readConditionOf(flow?.behaviour),
      maxTakes: readSerializedMaxTakes(flow?.behaviour),
      behaviour: flow?.behaviour ?? null,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))

  return {
    definition: {
      id: typeof definition.id === 'string' ? definition.id : null,
      type: typeof definition.type === 'string' ? definition.type : null,
      name: typeof definition.name === 'string' ? definition.name : null,
      targetNamespace: typeof definition.targetNamespace === 'string' ? definition.targetNamespace : null,
    },
    processIds: processes.map(process => process.id),
    startIds: activities.filter(activity => activity.type === 'bpmn:StartEvent').map(activity => activity.id).sort(),
    endIds: activities.filter(activity => activity.type === 'bpmn:EndEvent').map(activity => activity.id).sort(),
    processes,
    elements: activities,
    flows,
  }
}

function summarizeIds(list, max = 8) {
  const ids = list.map(item => item?.id ?? '(无 id)')
  return ids.length <= max ? ids.join('、') : `${ids.slice(0, max).join('、')}…（共 ${ids.length} 项）`
}

function compareById(expectedList, actualList, label, diffs) {
  const expected = new Map(expectedList.map(item => [String(item.id), item]))
  const actual = new Map(actualList.map(item => [String(item.id), item]))
  const missing = expectedList.filter(item => !actual.has(String(item.id)))
  const extra = actualList.filter(item => !expected.has(String(item.id)))
  if (missing.length > 0) diffs.push(`${label}缺少：${summarizeIds(missing)}`)
  if (extra.length > 0) diffs.push(`${label}多出：${summarizeIds(extra)}`)
  for (const item of expectedList) {
    const other = actual.get(String(item.id))
    if (!other) continue
    if (stableStringify(item) !== stableStringify(other)) {
      diffs.push(`${label} ${item.id} 的执行配置不一致（类型/条件/扩展/上限）`)
    }
  }
}

/**
 * 比较两份结构描述，返回可读差异（最多 8 条）。
 *
 * @param {object} expected
 * @param {object} actual
 * @returns {string[]}
 */
export function diffExecutionStructures(expected, actual) {
  const diffs = []
  if (stableStringify(expected?.definition) !== stableStringify(actual?.definition)) {
    diffs.push('bpmn:definitions 元数据不一致')
  }
  if (stableStringify(expected?.processIds) !== stableStringify(actual?.processIds)) {
    diffs.push(`process 集合不一致（期望 ${JSON.stringify(expected?.processIds)}，实际 ${JSON.stringify(actual?.processIds)}）`)
  }
  compareById(expected?.processes ?? [], actual?.processes ?? [], 'process', diffs)
  compareById(expected?.elements ?? [], actual?.elements ?? [], '节点', diffs)
  compareById(expected?.flows ?? [], actual?.flows ?? [], '连线', diffs)
  if (stableStringify(expected?.startIds) !== stableStringify(actual?.startIds)) {
    diffs.push(`startEvent 集合不一致（期望 ${JSON.stringify(expected?.startIds)}，实际 ${JSON.stringify(actual?.startIds)}）`)
  }
  if (stableStringify(expected?.endIds) !== stableStringify(actual?.endIds)) {
    diffs.push(`endEvent 集合不一致（期望 ${JSON.stringify(expected?.endIds)}，实际 ${JSON.stringify(actual?.endIds)}）`)
  }
  return diffs.slice(0, 8)
}

/** 两份结构必须完全一致，否则 `BPMN_STATE_DEFINITION_MISMATCH`。 */
export function assertStructuresMatch(expected, actual, label) {
  const diffs = diffExecutionStructures(expected, actual)
  if (diffs.length === 0) return
  throw new BpmnStateError(
    'BPMN_STATE_DEFINITION_MISMATCH',
    `${label}：快照里的执行结构与可信定义不一致（${diffs.join('；')}）`,
    { differences: diffs }
  )
}

/**
 * 用**与执行相同版本/选项**的 moddle + serializer 从可信 XML 生成结构描述。
 *
 * 用真 `Engine` 而不是自己解析，是为了保证「比较用的结构」与「恢复后的执行结构」
 * 来自同一条序列化管线（元素类型、扩展、条件形状完全同源）。
 *
 * @param {string} xml
 * @returns {Promise<object>}
 */
export async function readTrustedExecutionStructure(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new BpmnStateError('BPMN_DEFINITION_INVALID', '可信 XML 必须是非空字符串')
  }
  let definitions
  try {
    const engine = new Engine({ name: 'flow-studio/structure-probe', source: xml })
    definitions = await engine.getDefinitions()
  } catch (error) {
    throw new BpmnStateError(
      'BPMN_DEFINITION_INVALID',
      `可信 XML 无法加载成执行结构：${errorMessageOf(error)}`,
      { cause: error }
    )
  }
  if (!Array.isArray(definitions) || definitions.length !== 1) {
    throw new BpmnStateError(
      'BPMN_EXECUTION_UNSUPPORTED',
      `可信 XML 必须恰好加载出一份定义，实际 ${Array.isArray(definitions) ? definitions.length : '(缺失)'} 份`
    )
  }
  const sourceContext = definitions[0]?.context?.definitionContext
  if (!sourceContext) {
    throw new BpmnStateError('BPMN_DEFINITION_INVALID', '可信 XML 加载后没有执行上下文')
  }
  const violations = collectSerializedExecutionViolations(sourceContext)
  if (violations.length > 0) {
    const first = violations[0]
    throw new BpmnStateError(first.code, first.message, { elementId: first.elementId })
  }
  return describeExecutionStructure(sourceContext)
}

const KIND_BY_SERIALIZED_TYPE = Object.freeze({
  'bpmn:startEvent': 'start',
  'bpmn:endEvent': 'end',
  'bpmn:userTask': 'human',
  'bpmn:serviceTask': 'service',
  'bpmn:exclusiveGateway': 'gateway',
})

function kindOfSerializedType(type) {
  const normalized = canonicalBpmnType(type)
  return normalized === null ? 'unknown' : (KIND_BY_SERIALIZED_TYPE[normalized] ?? 'unknown')
}

function kindMatches(definitionKind, serializedType) {
  const kind = kindOfSerializedType(serializedType)
  if (definitionKind === 'agent' || definitionKind === 'http') return kind === 'service'
  return kind === definitionKind
}

/**
 * `definition`（调用方给的活动 id → handler 映射）必须与可信执行结构对得上。
 *
 * 这里**不比较** name / prompt 等非执行字段；比较的是「谁会被执行、从哪到哪、
 * 默认流与连线次数上限」——错一位就会把 handler 派发到错误的活动上。
 *
 * @param {object} definition `normalizeDefinition()` 的输出
 * @param {object} structure `describeExecutionStructure()` 的输出
 * @param {'start'|'recover'} phase
 */
export function assertDefinitionMatchesStructure(definition, structure, phase = 'start') {
  const elementById = new Map((structure.elements ?? []).map(item => [item.id, item]))
  for (const element of definition.elements) {
    const actual = elementById.get(element.id)
    if (!actual) {
      throw new BpmnStateError(
        'BPMN_XML_ELEMENT_MISSING',
        `definition 里的节点 ${element.id}（${element.kind}）在${phase === 'recover' ? '快照' : ' xml'} 里找不到：definition 与执行来源不是同一版`,
        { elementId: element.id }
      )
    }
    const expectedType = canonicalBpmnType(element.type)
    if (expectedType !== canonicalBpmnType(actual.type)) {
      throw new BpmnStateError(
        'BPMN_DEFINITION_INVALID',
        `节点 ${element.id} 的 definition.type=${JSON.stringify(element.type)} 与执行来源的 ${JSON.stringify(actual.type)} 不一致`,
        { elementId: element.id }
      )
    }
    if (!kindMatches(element.kind, actual.type)) {
      throw new BpmnStateError(
        'BPMN_DEFINITION_INVALID',
        `节点 ${element.id} 的 definition.kind=${element.kind} 与执行来源的元素类型 ${actual.type} 不一致`,
        { elementId: element.id }
      )
    }
  }

  const flowById = new Map((structure.flows ?? []).map(item => [item.id, item]))
  for (const flow of definition.flows) {
    const actual = flowById.get(flow.id)
    if (!actual) {
      throw new BpmnStateError(
        'BPMN_XML_ELEMENT_MISSING',
        `definition 里的连线 ${flow.id} 在执行来源里找不到：definition 与执行来源不是同一版`,
        { elementId: flow.id }
      )
    }
    if (actual.from !== flow.from || actual.to !== flow.to) {
      throw new BpmnStateError(
        'BPMN_DEFINITION_INVALID',
        `连线 ${flow.id} 的 definition 端点 ${flow.from}→${flow.to} 与执行来源的 ${actual.from}→${actual.to} 不一致`,
        { elementId: flow.id }
      )
    }
    if (actual.isDefault !== (flow.isDefault === true)) {
      throw new BpmnStateError(
        'BPMN_DEFINITION_INVALID',
        `连线 ${flow.id} 的默认流标记与执行来源不一致（definition=${flow.isDefault === true}，来源=${actual.isDefault}）`,
        { elementId: flow.id }
      )
    }
    if ((actual.maxTakes ?? null) !== (flow.maxTakes ?? null)) {
      throw new BpmnStateError(
        'BPMN_DEFINITION_INVALID',
        `连线 ${flow.id} 的 fs:maxRounds 与执行来源不一致（definition=${JSON.stringify(flow.maxTakes ?? null)}，来源=${JSON.stringify(actual.maxTakes ?? null)}）`,
        { elementId: flow.id }
      )
    }
  }

  const startId = structure.startIds?.[0] ?? null
  if (definition.startId !== startId) {
    throw new BpmnStateError(
      'BPMN_DEFINITION_INVALID',
      `definition.startId=${JSON.stringify(definition.startId)} 与执行来源的 startEvent=${JSON.stringify(startId)} 不一致`
    )
  }
  const endIds = new Set(structure.endIds ?? [])
  for (const endId of definition.endIds) {
    if (!endIds.has(endId)) {
      throw new BpmnStateError(
        'BPMN_DEFINITION_INVALID',
        `definition.endIds 里的 ${endId} 不是执行来源里的 endEvent`,
        { elementId: endId }
      )
    }
  }
}

/**
 * 恢复后核对引擎里**实际**加载出来的上下文（而不是再次相信传入的 XML）。
 *
 * @param {object} engine 已经 `recover()` 过的 bpmn-engine Engine
 * @param {object} expected `readTrustedExecutionStructure()` 的输出
 */
export function assertRecoveredEngineStructure(engine, expected) {
  const definitions = engine?.execution?.definitions
  if (!Array.isArray(definitions) || definitions.length !== 1) {
    throw new BpmnStateError(
      'BPMN_STATE_INVALID',
      `恢复后的引擎没有恰好一份定义（当前 ${Array.isArray(definitions) ? definitions.length : '(缺失)'} 份）`
    )
  }
  const sourceOption = definitions[0]?.environment?.options?.source
  if (!sourceOption) {
    throw new BpmnStateError('BPMN_STATE_INVALID', '恢复后的定义环境没有 source（无法核对实际执行来源）')
  }
  let sourceContext
  try {
    sourceContext = typeof sourceOption.serialize === 'function' ? JSON.parse(sourceOption.serialize()) : sourceOption
  } catch (error) {
    throw new BpmnStateError('BPMN_STATE_INVALID', `恢复后的执行来源无法序列化：${errorMessageOf(error)}`)
  }
  const violations = collectSerializedExecutionViolations(sourceContext)
  if (violations.length > 0) {
    const first = violations[0]
    throw new BpmnStateError(first.code, `恢复后的执行结构包含不支持的元素：${first.message}`, { elementId: first.elementId })
  }
  assertStructuresMatch(expected, describeExecutionStructure(sourceContext), '恢复后的执行来源')
  const contextStructure = definitions[0]?.context?.definitionContext
  if (contextStructure) {
    assertStructuresMatch(expected, describeExecutionStructure(contextStructure), '恢复后的 definition.context')
  }
}
