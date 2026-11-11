/**
 * 创建/替换的兜底行为：任何 serviceTask 落地时都必须带合法的 `fs:node`。
 *
 * palette 与右键菜单已经预置扩展；但拖拽、粘贴、替换、脚本调用仍可能绕开它们。
 * 这里监听 `commandStack.shape.create.postExecuted` 与 `...shape.replace.postExecuted`，
 * 在**同一条命令**的收尾阶段把扩展补进 businessObject（仍在 commandStack 的原子执行
 * 区内）：撤销时整个 shape 被移除/换回，扩展随之消失，不会留下第二次撤销步骤。
 *
 * 直接写 businessObject 是刻意的：这里没有「另一次可撤销编辑」，扩展的生命周期与
 * 图元创建绑定；真正的字段编辑一律走 `modeling.js` 里的命令。
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn/behavior
 */

import { FS_NODE_TYPE } from './modeling.js'

/** 规范 nodeType：只接受 agent/http，其余返回 undefined。 */
function normalizedKind(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return text === 'agent' || text === 'http' ? text : undefined
}

/** 人工节点不得保留 serviceTask 的 nodeType/http（替换时在同一条命令里清掉）。 */
function clearServiceNodeKind(businessObject) {
  const values = businessObject && businessObject.extensionElements
    && Array.isArray(businessObject.extensionElements.values)
    ? businessObject.extensionElements.values
    : []
  const fsNode = values.find(value => value && value.$type === FS_NODE_TYPE)
  if (!fsNode) return null
  fsNode.nodeType = undefined
  fsNode.http = undefined
  return fsNode
}

/**
 * 给 businessObject 补/修一个合法 `fs:node`（保留已有 extensionElements / 其它扩展）。
 *
 * - `kind=agent|http`：写成目标类型；
 * - `kind` 缺省：已有 nodeType 合法就保留，非法/缺失则回落到 agent。
 */
export function attachFsNode(businessObject, moddle, kind) {
  if (!businessObject || businessObject.$type !== 'bpmn:ServiceTask') return null
  let extensionElements = businessObject.extensionElements
  if (!extensionElements) {
    extensionElements = moddle.create('bpmn:ExtensionElements', { values: [] })
    extensionElements.$parent = businessObject
    businessObject.extensionElements = extensionElements
  }
  const values = Array.isArray(extensionElements.values) ? extensionElements.values : []
  const existing = values.find(value => value && value.$type === FS_NODE_TYPE)
  const expected = normalizedKind(kind)
  if (existing) {
    const current = normalizedKind(existing.nodeType)
    if (expected) {
      if (current !== expected) existing.nodeType = expected
    } else if (!current) {
      // 官方替换会复制扩展但不校验内容：只有扩展、没有 nodeType 的 serviceTask
      // 服务端会拒绝保存，这里回落到 agent。
      existing.nodeType = 'agent'
    } else if (existing.nodeType !== current) {
      existing.nodeType = current
    }
    return existing
  }
  const fsNode = moddle.create(FS_NODE_TYPE, { nodeType: expected || 'agent' })
  fsNode.$parent = extensionElements
  extensionElements.values = [...values, fsNode]
  return fsNode
}

/**
 * 事件监听器：创建/替换出来的 serviceTask 立刻拥有合法扩展；人工节点清掉
 * 不属于它的 serviceTask 字段。替换事件从 `hints.fsNodeType` 读取属性面板的目标类型。
 */
export function FsCreateBehavior(eventBus, moddle) {
  const ensure = event => {
    const context = event && event.context
    const shape = (context && (context.newShape || context.shape)) || (event && event.shape)
    const businessObject = shape && shape.businessObject
    if (!businessObject) return
    if (businessObject.$type === 'bpmn:UserTask') {
      clearServiceNodeKind(businessObject)
      return
    }
    if (businessObject.$type !== 'bpmn:ServiceTask') return
    const hintedKind = context && context.hints && context.hints.fsNodeType
    attachFsNode(businessObject, moddle, hintedKind)
  }

  eventBus.on('commandStack.shape.create.postExecuted', 500, ensure)
  eventBus.on('commandStack.shape.replace.postExecuted', 500, ensure)
}

FsCreateBehavior.$inject = ['eventBus', 'moddle']

export const FsCreateBehaviorModule = {
  __init__: ['fsCreateBehavior'],
  fsCreateBehavior: ['type', FsCreateBehavior],
}
