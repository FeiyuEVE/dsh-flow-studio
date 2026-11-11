/**
 * Replace 菜单（“Change element”）约束。
 *
 * bpmn-js 默认的替换菜单提供脚本任务、调用活动、子流程、并行/包容网关、事件定义、
 * 多实例/循环表头等我们**不执行**的入口。这里包装官方 `ReplaceMenuProvider`：
 *   - entries 只保留白名单里的 actionName；
 *   - 表头（loop / multi-instance / collection / non-interrupting）全部清空。
 *
 * 保留的 actionName：
 *   replace-with-none-start / none-end / user-task / service-task /
 *   exclusive-gateway / default-flow / conditional-flow / sequence-flow
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn/replace
 */

import ReplaceMenuProvider from 'bpmn-js/lib/features/popup-menu/ReplaceMenuProvider.js'

/** 只保留白名单目标的替换项；actionName 是官方菜单的稳定键。 */
export const ALLOWED_REPLACE_ACTIONS = Object.freeze([
  'replace-with-none-start',
  'replace-with-none-end',
  'replace-with-user-task',
  'replace-with-service-task',
  'replace-with-exclusive-gateway',
  'replace-with-default-flow',
  'replace-with-conditional-flow',
  'replace-with-sequence-flow',
])

const ALLOWED = new Set(ALLOWED_REPLACE_ACTIONS)

export function FsReplaceMenuProvider(...args) {
  ReplaceMenuProvider.apply(this, args)
}

FsReplaceMenuProvider.$inject = ReplaceMenuProvider.$inject.slice()

FsReplaceMenuProvider.prototype = Object.create(ReplaceMenuProvider.prototype)
FsReplaceMenuProvider.prototype.constructor = FsReplaceMenuProvider

FsReplaceMenuProvider.prototype.getPopupMenuEntries = function getPopupMenuEntries(target) {
  const entries = ReplaceMenuProvider.prototype.getPopupMenuEntries.call(this, target) || {}
  const filtered = {}
  for (const [id, entry] of Object.entries(entries)) {
    if (ALLOWED.has(id)) filtered[id] = entry
  }
  return filtered
}

/** 多实例 / 循环 / collection / 非中断事件等表头入口一律不显示。 */
FsReplaceMenuProvider.prototype.getPopupMenuHeaderEntries = function getPopupMenuHeaderEntries() {
  return {}
}

export const FsReplaceModule = {
  __init__: ['replaceMenuProvider'],
  replaceMenuProvider: ['type', FsReplaceMenuProvider],
}
