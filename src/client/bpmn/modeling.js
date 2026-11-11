/**
 * fs: 扩展的浏览器端建模工具（chunk 内）。
 *
 * 与 `src/bpmn-moddle.js` 的服务端描述符共用一份契约；这里只做三件事：
 *   1. 读写 `extensionElements.values` 里的 `fs:Node` / `fs:Team` / `fs:Http` / `fs:Check`…
 *      并**保留其它扩展**（不整体替换 values 为只剩 fs 节点的数组）；
 *   2. 把创建/更新写进 commandStack（官方 `properties-panel.multi-command-executor`
 *      把多条命令合成一次可撤销操作）；
 *   3. 给 palette / 右键菜单 / 规则提供同一套合法节点类型白名单。
 *
 * 不在本文件里写 DOM，便于被测试直接 import 检查纯逻辑。
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn/modeling
 */

import { getBusinessObject, is } from 'bpmn-js/lib/util/ModelUtil.js'

/** `fs:Node` 的 moddle 类型名。 */
export const FS_NODE_TYPE = 'fs:Node'
/** 扩展命名空间里的其它类型名。 */
export const FS_TYPES = Object.freeze({
  NODE: 'fs:Node',
  TEAM: 'fs:Team',
  MEMBER: 'fs:Member',
  HTTP: 'fs:Http',
  CHECK: 'fs:Check',
  OUTPUT: 'fs:Output',
  MAX_ROUNDS: 'fs:MaxRounds',
  EXECUTOR: 'fs:Executor',
})

/**
 * 0.13 执行白名单在画布侧的镜像（服务端 `src/bpmn-policy.js` 仍是最终裁决）。
 * 只列**允许创建/替换**的类型：并行/包容网关、脚本任务、子流程、事件定义都不开放。
 */
export const ALLOWED_SHAPE_TYPES = Object.freeze([
  'bpmn:StartEvent',
  'bpmn:EndEvent',
  'bpmn:UserTask',
  'bpmn:ServiceTask',
  'bpmn:ExclusiveGateway',
])

/** 只读的 inert 元素：允许出现在图里，不参与执行。 */
export const INERT_SHAPE_TYPES = Object.freeze(['bpmn:TextAnnotation'])

/** `fs:node@nodeType` 的合法值（人工节点用 userTask，不写 nodeType）。 */
export const NODE_KINDS = Object.freeze(['human', 'agent', 'http'])

/** 当前元素是否是我们开放编辑的流程节点。 */
export function isFsNodeElement(element) {
  return is(element, 'bpmn:UserTask') || is(element, 'bpmn:ServiceTask')
}

/** 当前元素是否是可编辑的连线。 */
export function isSequenceFlow(element) {
  return is(element, 'bpmn:SequenceFlow')
}

/** 取 businessObject（对 djs 元素与 moddle 元素都成立）。 */
export function businessObjectOf(element) {
  return getBusinessObject(element)
}

/** `extensionElements.values`（不存在时返回 []）。 */
export function extensionValues(element) {
  const bo = businessObjectOf(element)
  const values = bo && bo.extensionElements && bo.extensionElements.values
  return Array.isArray(values) ? values : []
}

/** 取 `extensionElements` 里的第一个 `fs:Node`（没有则 null）。 */
export function getFsNode(element) {
  return extensionValues(element).find(value => value && value.$type === FS_TYPES.NODE) || null
}

/** 节点语义：userTask = human；serviceTask 读 fs:node@nodeType。 */
export function nodeKindOf(element) {
  if (is(element, 'bpmn:UserTask')) return 'human'
  if (is(element, 'bpmn:ServiceTask')) {
    const fsNode = getFsNode(element)
    const kind = fsNode && typeof fsNode.nodeType === 'string'
      ? fsNode.nodeType.trim().toLowerCase()
      : ''
    return kind === 'agent' || kind === 'http' ? kind : null
  }
  return null
}

/** 把逗号分隔的输入规范化成解析器认识的列表字符串。 */
export function normalizeListText(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean).join(',')
  }
  if (typeof value !== 'string') return ''
  return value.split(',').map(item => item.trim()).filter(Boolean).join(',')
}

/** 列表字符串 → 数组（与 `src/bpmn-parse.js` 的 listValue 同语义）。 */
export function listFromText(value) {
  if (typeof value !== 'string') return []
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
}

/** 一条 `element.updateModdleProperties` 命令。 */
export function updateCommand(element, moddleElement, properties) {
  return {
    cmd: 'element.updateModdleProperties',
    context: { element, moddleElement, properties },
  }
}

/**
 * 执行多条命令；由官方 properties-panel 的 MultiCommandHandler 合成**一次**撤销。
 * 空数组不执行（避免制造空的历史记录）。
 */
export function applyCommands(commandStack, commands) {
  const list = (commands || []).filter(Boolean)
  if (!list.length) return
  commandStack.execute('properties-panel.multi-command-executor', list)
}

/**
 * 确保 `extensionElements` 存在；返回命令与容器引用。
 * 注意：只把「新建容器」作为命令，已有容器不整体替换。
 */
export function buildExtensionCommands(element, moddle) {
  const bo = businessObjectOf(element)
  const commands = []
  let extensionElements = bo && bo.extensionElements
  if (!extensionElements) {
    extensionElements = moddle.create('bpmn:ExtensionElements', { values: [] })
    extensionElements.$parent = bo
    commands.push(updateCommand(element, bo, { extensionElements }))
  }
  return { commands, extensionElements, businessObject: bo }
}

/** 往 extensionElements.values 里追加一个扩展（保留已有值）。 */
export function appendExtensionCommand(element, extensionElements, value) {
  const values = Array.isArray(extensionElements.values) ? extensionElements.values : []
  value.$parent = extensionElements
  return updateCommand(element, extensionElements, { values: [...values, value] })
}

/**
 * 确保 `fs:Node` 存在，并且（给了 kind 时）nodeType 与目标一致。
 *
 * @returns {{commands: object[], fsNode: object, created: boolean}}
 */
export function ensureFsNodeCommands(element, moddle, kind, initialProperties = {}) {
  const commands = []
  let fsNode = getFsNode(element)
  let created = false
  if (!fsNode) {
    const properties = { ...initialProperties }
    if (kind === 'agent' || kind === 'http') properties.nodeType = kind
    fsNode = moddle.create(FS_TYPES.NODE, properties)
    const extension = buildExtensionCommands(element, moddle)
    commands.push(...extension.commands)
    commands.push(appendExtensionCommand(element, extension.extensionElements, fsNode))
    created = true
  } else if ((kind === 'agent' || kind === 'http') && fsNode.nodeType !== kind) {
    commands.push(updateCommand(element, fsNode, { nodeType: kind }))
  }
  return { commands, fsNode, created }
}

/** 确保 `fs:Team` 存在（挂到 fsNode.team）；返回命令与 team 引用。 */
export function ensureTeamCommands(element, moddle, fsNode) {
  if (fsNode.team) return { commands: [], team: fsNode.team }
  const team = moddle.create(FS_TYPES.TEAM, { mode: 'none', member: [] })
  team.$parent = fsNode
  return {
    commands: [updateCommand(element, fsNode, { team })],
    team,
  }
}

/** 确保 `fs:Http` 存在（挂到 fsNode.http）；返回命令与 http 引用。 */
export function ensureHttpCommands(element, moddle, fsNode) {
  if (fsNode.http) return { commands: [], http: fsNode.http }
  const http = moddle.create(FS_TYPES.HTTP, {})
  http.$parent = fsNode
  return {
    commands: [updateCommand(element, fsNode, { http })],
    http,
  }
}

/** 确保 `fs:Check` 存在（挂到 fsNode.check）；返回命令与 check 引用。 */
export function ensureCheckCommands(element, moddle, fsNode) {
  if (fsNode.check) return { commands: [], check: fsNode.check }
  const check = moddle.create(FS_TYPES.CHECK, { json: '' })
  check.$parent = fsNode
  return {
    commands: [updateCommand(element, fsNode, { check })],
    check,
  }
}

/**
 * 用 palette / 右键菜单创建 serviceTask 时预置业务对象：
 * id、`bpmn:ExtensionElements` 与合法的 `fs:node nodeType` 一次就位，
 * 不会出现「先建出没有 fs:node 的 serviceTask」的中间态。
 */
export function createFsServiceTask(bpmnFactory, moddle, kind) {
  if (kind !== 'agent' && kind !== 'http') {
    throw new Error(`createFsServiceTask: 非法 nodeType ${String(kind)}`)
  }
  const businessObject = bpmnFactory.create('bpmn:ServiceTask')
  const extensionElements = bpmnFactory.create('bpmn:ExtensionElements', { values: [] })
  const fsNode = moddle.create(FS_TYPES.NODE, { nodeType: kind })
  fsNode.$parent = extensionElements
  extensionElements.values = [fsNode]
  extensionElements.$parent = businessObject
  businessObject.extensionElements = extensionElements
  return businessObject
}

/** 删除 `fs:Node` 上的某个子扩展（例如把 serviceTask 改回人工时清掉 http）。 */
export function removeFsNodeChildCommand(element, fsNode, key) {
  return updateCommand(element, fsNode, { [key]: undefined })
}

/** 连线上的 `fs:MaxRounds`（值在 value 子节点/正文里）。 */
export function getMaxRounds(element) {
  const value = extensionValues(element).find(item => item && item.$type === FS_TYPES.MAX_ROUNDS)
  if (!value) return ''
  if (value.value !== undefined && value.value !== null) return String(value.value)
  return ''
}

/** 写回连线上的 `fs:MaxRounds`；空值移除该扩展（保留其它扩展）。 */
export function setMaxRoundsCommands(element, moddle, rawValue) {
  const bo = businessObjectOf(element)
  const commands = []
  let extensionElements = bo.extensionElements
  const values = extensionElements && Array.isArray(extensionElements.values)
    ? extensionElements.values
    : []
  const text = String(rawValue ?? '').trim()
  const parsed = /^-?\d+$/.test(text) ? Number(text) : null

  if (text === '') {
    if (extensionElements) {
      commands.push(updateCommand(
        element,
        extensionElements,
        { values: values.filter(item => !item || item.$type !== FS_TYPES.MAX_ROUNDS) },
      ))
    }
    return commands
  }

  const existing = values.find(item => item && item.$type === FS_TYPES.MAX_ROUNDS)
  if (existing) {
    commands.push(updateCommand(element, existing, { value: parsed === null ? text : parsed }))
    return commands
  }

  if (!extensionElements) {
    extensionElements = moddle.create('bpmn:ExtensionElements', { values: [] })
    extensionElements.$parent = bo
    commands.push(updateCommand(element, bo, { extensionElements }))
  }
  const node = moddle.create(FS_TYPES.MAX_ROUNDS, { value: parsed === null ? text : parsed })
  node.$parent = extensionElements
  const current = Array.isArray(extensionElements.values) ? extensionElements.values : []
  commands.push(updateCommand(element, extensionElements, { values: [...current, node] }))
  return commands
}
