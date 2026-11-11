/**
 * 画布规则：把 0.13 执行白名单再挡在命令层一次。
 *
 * palette / 右键菜单已经只提供合法入口，但拖拽、粘贴、外部 drop、插件调用同样走
 * `shape.create` / `shape.replace`。本模块对这些命令返回 false，避免 GUI 制造出
 * 服务端一定会拒绝的结构（并行网关、脚本任务、子流程、多实例…）。
 *
 * 服务端 `src/bpmn-policy.js` 仍是最终裁决；这里只是把错误提前到用户操作时。
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn/rules
 */

import RuleProvider from 'diagram-js/lib/features/rules/RuleProvider.js'

import { ALLOWED_SHAPE_TYPES, INERT_SHAPE_TYPES } from './modeling.js'

const ALLOWED = new Set([...ALLOWED_SHAPE_TYPES, ...INERT_SHAPE_TYPES])

/** 从 create / replace 的 context 里取目标类型。 */
function targetType(context) {
  if (!context) return null
  if (context.shape && context.shape.businessObject) return context.shape.businessObject.$type
  if (context.newShape && context.newShape.businessObject) return context.newShape.businessObject.$type
  if (context.newData && typeof context.newData.type === 'string') return context.newData.type
  return null
}

/**
 * 只允许白名单里的图元被创建 / 替换。
 * 返回 undefined 表示「不表态」，让 bpmn-js 自带规则继续判断连接/父级是否合法。
 */
export function FsRules(eventBus) {
  RuleProvider.call(this, eventBus)
}

FsRules.$inject = ['eventBus']

FsRules.prototype = Object.create(RuleProvider.prototype)
FsRules.prototype.constructor = FsRules

FsRules.prototype.init = function init() {
  this.addRule(['shape.create', 'shape.replace'], 2000, function check(context) {
    const type = targetType(context)
    if (!type) return undefined
    return ALLOWED.has(type) ? undefined : false
  })

  // 不允许把图元挂到子流程里（本版不执行子流程，画布上也不制造这种结构）。
  this.addRule('shape.create', 2000, function checkParent(context) {
    const parent = context && context.parent
    if (!parent || !parent.businessObject) return undefined
    const type = parent.businessObject.$type
    if (type === 'bpmn:SubProcess' || type === 'bpmn:AdHocSubProcess' || type === 'bpmn:Transaction') {
      return false
    }
    return undefined
  })
}

export const FsRulesModule = {
  __init__: ['fsRules'],
  fsRules: ['type', FsRules],
}
