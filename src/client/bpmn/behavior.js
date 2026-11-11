/**
 * 创建/替换的兜底行为：任何 serviceTask 落地时都必须带合法的 `fs:node`。
 *
 * palette 与右键菜单已经预置扩展；但拖拽、粘贴、替换、脚本调用仍可能绕开它们。
 * 这里监听 `commandStack.shape.create.postExecuted` 与 `...shape.replace.postExecuted`，
 * 在**同一条命令**的收尾阶段把扩展补进 businessObject（仍在 commandStack 的原子执行
 * 区内）：撤销时整个 shape 被移除，扩展随之消失，不会留下第二次撤销步骤。
 *
 * 直接写 businessObject 是刻意的：这里没有「另一次可撤销编辑」，扩展的生命周期与
 * 图元创建绑定；真正的字段编辑一律走 `modeling.js` 里的命令。
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn/behavior
 */

import { FS_NODE_TYPE } from './modeling.js'

/** 给 businessObject 直接补一个 fs:node（保留已有 extensionElements / 其它扩展）。 */
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
  if (existing) {
    if ((kind === 'agent' || kind === 'http') && existing.nodeType !== kind) {
      existing.nodeType = kind
    }
    return existing
  }
  const fsNode = moddle.create(FS_NODE_TYPE, { nodeType: kind === 'http' ? 'http' : 'agent' })
  fsNode.$parent = extensionElements
  extensionElements.values = [...values, fsNode]
  return fsNode
}

/**
 * 事件监听器：创建/替换出来的 serviceTask 若没有 fs:node，立即补上 agent 缺省。
 */
export function FsCreateBehavior(eventBus, moddle) {
  const ensure = event => {
    const shape = event && (event.shape || (event.context && (event.context.shape || event.context.newShape)))
    if (!shape || !shape.businessObject) return
    if (shape.businessObject.$type !== 'bpmn:ServiceTask') return
    const values = shape.businessObject.extensionElements
      && Array.isArray(shape.businessObject.extensionElements.values)
      ? shape.businessObject.extensionElements.values
      : []
    if (values.some(value => value && value.$type === FS_NODE_TYPE)) return
    attachFsNode(shape.businessObject, moddle, 'agent')
  }

  eventBus.on('commandStack.shape.create.postExecuted', 500, ensure)
  eventBus.on('commandStack.shape.replace.postExecuted', 500, ensure)
}

FsCreateBehavior.$inject = ['eventBus', 'moddle']

export const FsCreateBehaviorModule = {
  __init__: ['fsCreateBehavior'],
  fsCreateBehavior: ['type', FsCreateBehavior],
}
