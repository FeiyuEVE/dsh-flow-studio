/**
 * BPMN runner 快照信封（v2）与**恢复来源校验**（0.13 红线：恢复入口封闭）。
 *
 * 背景（审查实测）：`bpmn-engine` 的 `recover()` 优先反序列化
 * `state.definitions[].source`（`node_modules/bpmn-engine/src/index.js:183`），
 * **不会**用调用方传进来的 XML。也就是说：只校验外层 `definitionId` 挡不住
 * 「安全 XML + 恶意裸快照」——快照里的并行网关、条件事件、脚本任务都会被直接执行。
 *
 * 因此恢复路径固定为：
 *   1. 校验信封（`v=2`、必填字段、身份 `definitionId/hash/version/processId`，
 *      并绑定目标 `instanceId` 与执行 XML 的 `sourceHash`）；
 *   2. 有界解析 `engine.definitions[].source`（恰好一份、有 source、大小受限），
 *      拒绝重复 id，布尔路由标记只接受 true/false/缺省；`flowTakes` 必须严格且完整；
 *   3. 用与执行完全相同的 moddle/serializer 从**可信 XML** 生成执行结构，
 *      与快照里的结构逐项比较（元素 id/type/配置、连线端点/条件/default/上限/顺序、start/end），
 *      并拒绝 `execution` / `broker` 引用可信结构之外的 id 的异构 state；
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

/**
 * 参与路由判定的布尔标记：快照里只允许真正的 `true` / `false` / 缺省。
 *
 * 引擎按**真值**解释这些字段（`"false"`、`1`、`{}`、`[]` 都是真）；
 * 一旦允许字符串 "false" 混进来，就能把「条件为假」改成「默认流必走」。
 * `isParallelGateway` / `isExclusiveGateway` 等也属于路由判定字段，必须严格比对。
 */
const ROUTING_BOOLEAN_FIELDS = Object.freeze([
  'isDefault',
  'isParallelGateway',
  'isExclusiveGateway',
  'isInclusiveGateway',
  'isEventBasedGateway',
  'isComplexGateway',
  'isForCompensation',
  'triggeredByEvent',
  'isInterrupting',
  'cancelActivity',
])

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

/**
 * 快照布尔字段严格归一化：只接受真正的 `true` / `false` / 缺省（undefined）。
 *
 * 不做真值转换——`"false"` / `1` / `{}` / `null` 一律拒绝。
 *
 * @param {object|null} container
 * @param {string} field
 * @param {string} label
 * @param {string|null} elementId
 */
function assertStrictBooleanField(container, field, label, elementId) {
  if (!isPlainObject(container) || container[field] === undefined) return
  const value = container[field]
  if (typeof value === 'boolean') return
  throw new BpmnStateError(
    'BPMN_STATE_INVALID',
    `${label} 的 ${field} 必须是布尔值 true / false（缺省 = 未设置），实际是 ${JSON.stringify(value)}（${typeof value}）；引擎按真值解释，非布尔值会改变路由`,
    { elementId: elementId ?? undefined }
  )
}

/**
 * 扫描快照执行结构里的布尔路由标记；任何非布尔值都在恢复前拒绝。
 *
 * @param {object} sourceContext `parseStateSource()` 的输出（`{elements}`）
 */
function assertSnapshotBooleanTypes(sourceContext) {
  const elements = isPlainObject(sourceContext?.elements) ? sourceContext.elements : {}
  const lists = [
    ['process', toArray(elements.processes)],
    ['节点', toArray(elements.activities)],
    ['连线', toArray(elements.sequenceFlows)],
  ]
  for (const [label, list] of lists) {
    for (const item of list) {
      const id = typeof item?.id === 'string' && item.id !== '' ? item.id : null
      for (const field of ROUTING_BOOLEAN_FIELDS) {
        assertStrictBooleanField(item, field, `${label} ${id ?? '(无 id)'}`, id)
        assertStrictBooleanField(item?.behaviour, field, `${label} ${id ?? '(无 id)'} 的 behaviour`, id)
      }
    }
  }
}

/**
 * 执行结构里的活动 / 连线 id 必须唯一（Map 按 id 去重会掩盖重复项）。
 *
 * @param {object} sourceContext
 * @param {string} code 快照用 BPMN_STATE_*，可信 XML 用 BPMN_DEFINITION_*
 */
function assertUniqueStructureIds(sourceContext, code) {
  const elements = isPlainObject(sourceContext?.elements) ? sourceContext.elements : sourceContext
  const seen = new Map()
  const lists = [
    ['process', toArray(elements?.processes)],
    ['节点', toArray(elements?.activities)],
    ['连线', toArray(elements?.sequenceFlows)],
  ]
  for (const [label, list] of lists) {
    for (const item of list) {
      const id = typeof item?.id === 'string' && item.id !== '' ? item.id : null
      if (id === null) continue
      if (seen.has(id)) {
        throw new BpmnStateError(code, `执行结构里 id 重复：${id}（已作为${seen.get(id)}出现，又出现为${label}）；拒绝恢复/执行`, { elementId: id })
      }
      seen.set(id, label)
    }
  }
}

/**
 * 校验快照里的计数表（`[[key, count], …]`）。
 *
 * 形状错误必须拒绝而不是静默丢弃：删掉 `flowTakes` 会让「已耗尽的连线」复活。
 *
 * @param {unknown} raw
 * @param {string} label
 * @param {{ required: boolean }} options
 * @returns {Array<[string, number]>|undefined}
 */
function normalizeCountPairs(raw, label, { required }) {
  if (raw === undefined || raw === null) {
    if (!required) return undefined
    throw new BpmnStateError(
      'BPMN_STATE_INVALID',
      `${label} 缺失：v2 快照必须带连线通过次数 / 节点进入次数，否则上限会被清零`
    )
  }
  if (!Array.isArray(raw)) {
    throw new BpmnStateError('BPMN_STATE_INVALID', `${label} 必须是 [[key, 非负整数], …] 数组，实际是 ${typeof raw}`)
  }
  const seen = new Set()
  const pairs = []
  for (const [index, entry] of raw.entries()) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new BpmnStateError('BPMN_STATE_INVALID', `${label}[${index}] 必须是 [key, count] 二元组`)
    }
    const [key, value] = entry
    if (typeof key !== 'string' || key === '') {
      throw new BpmnStateError('BPMN_STATE_INVALID', `${label}[${index}] 的 key 必须是非空字符串`)
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BpmnStateError('BPMN_STATE_INVALID', `${label}[${index}]（${key}）的计数必须是非负整数，实际是 ${JSON.stringify(value)}`)
    }
    if (seen.has(key)) {
      throw new BpmnStateError('BPMN_STATE_INVALID', `${label} 里 ${key} 重复出现（同一计数不能有两个值）`)
    }
    seen.add(key)
    pairs.push([key, value])
  }
  return pairs
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
  // `SerializableContext.serialize()` 把 elements 摊平在顶层（`{id,type,name,activities,…}`）；
  // 内存里的 SerializableContext 则是 `{elements:{…}}`。两种都接受，统一成后者。
  const elements = isPlainObject(parsed?.elements)
    ? parsed.elements
    : parsed
  if (!isPlainObject(parsed) || !Array.isArray(elements.activities) || !Array.isArray(elements.sequenceFlows)) {
    throw new BpmnStateError('BPMN_STATE_INVALID', `${label} 的 source 不是 bpmn-engine 的序列化执行上下文`)
  }
  return isPlainObject(parsed.elements) ? parsed : { ...parsed, elements: parsed }
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
  // 快照必须绑定到**目标实例**：异实例的 state 即使结构与身份都对，也不能拿来恢复。
  if (typeof instanceId === 'string' && instanceId !== '' && state.instanceId !== instanceId) {
    throw new BpmnStateError(
      'BPMN_STATE_INSTANCE_MISMATCH',
      `state 属于实例 ${JSON.stringify(state.instanceId)}，当前执行器是 ${JSON.stringify(instanceId)}；拒绝跨实例恢复`,
      { expectedInstanceId: instanceId, actualInstanceId: state.instanceId }
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
  // `sourceHash` 是**执行 XML 原文**的 SHA-256（handler 源与 definitionHash 同源，
  // 但语义上单独绑定「实际执行来源」）。缺失 / 伪造都拒绝，不能只信 definitionHash。
  if (typeof state.sourceHash !== 'string' || !HASH_PATTERN.test(state.sourceHash)) {
    throw new BpmnStateError(
      'BPMN_STATE_SOURCE_HASH_MISMATCH',
      `state.sourceHash 必须是 64 位小写十六进制（执行来源的 sha256），实际是 ${JSON.stringify(state.sourceHash)}；拒绝恢复`
    )
  }
  if (state.sourceHash !== identity.hash) {
    throw new BpmnStateError(
      'BPMN_STATE_SOURCE_HASH_MISMATCH',
      `state.sourceHash=${state.sourceHash} 与当前执行 XML 的 sha256=${identity.hash} 不一致；拒绝恢复`
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
  // 重复 id 会让「按 id 对照」掩盖第二条连线；必须在结构比较之前拒绝。
  assertUniqueStructureIds(sourceContext, 'BPMN_STATE_INVALID')
  // 布尔字段严格归一化（isDefault="false" / 1 / {} 一律拒绝，不允许真值转换）。
  assertSnapshotBooleanTypes(sourceContext)

  if (state.variables !== undefined && state.variables !== null && !isPlainObject(state.variables)) {
    throw new BpmnStateError('BPMN_STATE_INVALID', 'state.variables 必须是 JSON 对象')
  }

  // 计数表：flowTakes 必须存在且严格；attempts 可选但形状必须对。
  const flowTakes = normalizeCountPairs(state.flowTakes, 'state.flowTakes', { required: true })
  const attempts = normalizeCountPairs(state.attempts, 'state.attempts', { required: false })

  return {
    envelope: state,
    engineState,
    sourceContext,
    variables: isPlainObject(state.variables) ? state.variables : {},
    attempts,
    flowTakes,
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

/** 取一份执行结构条目上的路由布尔标记（只记录确实出现的字段，便于逐项比较）。 */
function routingFlagsOf(item) {
  const flags = {}
  for (const field of ROUTING_BOOLEAN_FIELDS) {
    const top = item?.[field]
    const inside = item?.behaviour?.[field]
    if (top !== undefined) flags[`top.${field}`] = top
    else if (inside !== undefined) flags[`behaviour.${field}`] = inside
  }
  return flags
}

/**
 * 把一份序列化执行上下文压成**可比较的结构描述**。
 *
 * 保留完整 `behaviour`（节点扩展配置 / 条件 / 默认流标记都在里面）——只比图的拓扑不够，
 * 换条件、换扩展配置同样必须拒绝。`flows` **不排序**：条件边的先后就是派发顺序，
 * 重排两条真条件边可以换执行目标，所以顺序也必须参与比较。
 *
 * @param {{ elements?: object } | null} sourceContext
 * @returns {object}
 */
export function describeExecutionStructure(sourceContext) {
  const elements = isPlainObject(sourceContext?.elements)
    ? sourceContext.elements
    : (isPlainObject(sourceContext) ? sourceContext : {})
  const definition = isPlainObject(elements.definition) ? elements.definition : {}
  const processes = toArray(elements.processes)
    .map(process => ({
      id: typeof process?.id === 'string' ? process.id : null,
      type: typeof process?.type === 'string' ? process.type : null,
      name: typeof process?.name === 'string' ? process.name : null,
      parentId: parentIdOf(process),
      flags: routingFlagsOf(process),
      behaviour: process?.behaviour ?? null,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const activities = toArray(elements.activities)
    .map(activity => ({
      id: typeof activity?.id === 'string' ? activity.id : null,
      type: typeof activity?.type === 'string' ? activity.type : null,
      name: typeof activity?.name === 'string' ? activity.name : null,
      parentId: parentIdOf(activity),
      flags: routingFlagsOf(activity),
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
      // 不在这里做真值转换：快照路径已经严格校验过布尔类型；这里保留原值参与比较。
      isDefault: flow?.isDefault ?? false,
      flags: routingFlagsOf(flow),
      condition: readConditionOf(flow?.behaviour),
      maxTakes: readSerializedMaxTakes(flow?.behaviour),
      behaviour: flow?.behaviour ?? null,
    }))

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
    // 顺序即出边派发顺序，必须原样保留（不排序）。
    flows,
    flowIds: flows.map(flow => flow.id),
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
  // 顺序比较：条件边的先后就是派发顺序，重排即可把执行目标从 A 换成 B。
  const expectedOrder = (expected?.flows ?? []).map(flow => flow.id)
  const actualOrder = (actual?.flows ?? []).map(flow => flow.id)
  if (stableStringify(expectedOrder) !== stableStringify(actualOrder)) {
    diffs.push(`连线定义顺序不一致（期望 ${JSON.stringify(expectedOrder)}，实际 ${JSON.stringify(actualOrder)}）`)
  }
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

/** 引擎内部 executionId / flow take id 形如 `<元素 id>_<十六进制>`。 */
const DERIVED_ID_SUFFIX = /^[A-Za-z0-9._-]{2,}$/

/**
 * 从引擎快照里读取**每条连线**的通过次数（`execution...flows[].counters.take`）。
 *
 * 这是比 `sequenceId` 更完整的真相：bpmn-engine 会给每条连线条目记 `take` 计数
 * （未走过的边是 0）。恢复时用它逐条核对 `flowTakes`，删一条 / 改成 0 都拒绝。
 *
 * @param {object} engineState
 * @returns {Map<string, number>}
 */
export function collectEngineFlowTakes(engineState) {
  const counts = new Map()
  const visited = new WeakSet()
  const visit = (value) => {
    if (value === null || typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value.id === 'string' && value.id !== ''
      && isPlainObject(value.counters) && Number.isSafeInteger(value.counters.take)) {
      counts.set(value.id, Math.max(counts.get(value.id) ?? 0, value.counters.take))
    }
    for (const item of Object.values(value)) visit(item)
  }
  visit(engineState?.definitions?.[0]?.execution)
  visit(engineState?.definitions?.[0]?.broker)
  visit(engineState?.broker)
  return counts
}

/**
 * 从引擎快照里收集「已经走过的连线 id」。
 *
 * 快照里的 broker 消息带 `isSequenceFlow: true` 的 flow 内容，或 `sequenceId: "<flowId>_take_<hex>"`。
 * 这些连线必须在 `flowTakes` 里有计数——否则删掉一条计数就能让已耗尽的边复活。
 *
 * @param {object} engineState
 * @returns {Set<string>}
 */
export function collectTakenFlowIds(engineState) {
  const ids = new Set()
  const visited = new WeakSet()
  const visit = (value) => {
    if (value === null || typeof value !== 'object') return
    if (visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value.isSequenceFlow === true && typeof value.id === 'string' && value.id !== '') {
      ids.add(value.id)
    }
    if (typeof value.sequenceId === 'string' && value.sequenceId !== '') {
      const match = /^(.+)_take_[0-9a-f]+$/i.exec(value.sequenceId)
      if (match) ids.add(match[1])
    }
    for (const item of Object.values(value)) visit(item)
  }
  visit(engineState?.definitions?.[0]?.execution)
  visit(engineState?.definitions?.[0]?.broker)
  visit(engineState?.broker)
  return ids
}

/**
 * 校验快照里的 `engine.definitions[0].execution` / `broker` 只引用可信结构里的 id。
 *
 * 攻击面：`source` 与可信结构完全一致，但 `execution` / `broker` 被换成另一份引擎的状态。
 * 这样所有「比较 source」的校验都会通过，`resume()` 却不产生任何事件（挂死 / 僵尸实例）。
 * 这里在 `recover()` 之前把异构 state 直接拒掉，不创建活动、不派发 handler。
 *
 * @param {object} engineState 快照里的 `state.engine`
 * @param {object} structure `describeExecutionStructure()` 的输出
 */
export function assertEngineStateBoundToStructure(engineState, structure) {
  const known = new Set()
  const add = (value) => {
    if (typeof value === 'string' && value !== '') known.add(value)
  }
  add(structure?.definition?.id)
  for (const process of structure?.processes ?? []) add(process.id)
  for (const element of structure?.elements ?? []) add(element.id)
  for (const flow of structure?.flows ?? []) add(flow.id)

  const allowed = (id) => {
    if (known.has(id)) return true
    for (const base of known) {
      if (id.startsWith(`${base}_`) && DERIVED_ID_SUFFIX.test(id.slice(base.length + 1))) return true
    }
    return false
  }

  const checkedKeys = new Set(['id', 'sourceId', 'targetId', 'elementId', 'activityId', 'flowId', 'executionId'])
  const visited = new WeakSet()
  const violations = []
  const visit = (value, path) => {
    if (value === null || typeof value !== 'object') return
    if (visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    for (const [key, item] of Object.entries(value)) {
      const childPath = path === '' ? key : `${path}.${key}`
      if (checkedKeys.has(key) && typeof item === 'string' && item !== '' && !allowed(item)) {
        violations.push(`${childPath}=${JSON.stringify(item)}`)
      }
      visit(item, childPath)
    }
  }
  visit(engineState?.definitions?.[0]?.execution, 'definitions[0].execution')
  visit(engineState?.definitions?.[0]?.broker, 'definitions[0].broker')
  visit(engineState?.broker, 'broker')

  if (violations.length > 0) {
    const preview = violations.slice(0, 5).join('、')
    throw new BpmnStateError(
      'BPMN_STATE_INVALID',
      `快照的 execution/broker 引用了可信结构之外的 id（${preview}${violations.length > 5 ? ` 等 ${violations.length} 处` : ''}）：state 来自另一份引擎，拒绝恢复`,
      { elementId: violations[0] }
    )
  }
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
  assertUniqueStructureIds(sourceContext, 'BPMN_DEFINITION_INVALID')
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
