/**
 * 右键/悬浮菜单（context pad）：只留白名单动作。
 *
 * 默认 bpmn-js context pad 会提供「Append task（bpmn:Task）」「Append intermediate
 * event」等我们不执行的入口；这里覆盖 `contextPadProvider` 服务，按 id 过滤基础条目，
 * 再补上人工 / agent / HTTP 三种追加动作（serviceTask 预置合法 fs:node）。
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn/context-pad
 */

import ContextPadProvider from 'bpmn-js/lib/features/context-pad/ContextPadProvider.js'
import { is } from 'bpmn-js/lib/util/ModelUtil.js'

import { createFsServiceTask } from './modeling.js'

/** 基础 provider 里允许保留的条目（其余一律隐藏）。 */
const ALLOWED_BASE_ENTRIES = new Set([
  'append.end-event',
  'append.gateway',
  'append.text-annotation',
  'connect',
  'delete',
  'edit',
  'replace',
])

/** 除 endEvent 外，所有 FlowNode 都允许追加人工/agent/HTTP 与网关。 */
function canAppend(businessObject) {
  if (!is(businessObject, 'bpmn:FlowNode')) return false
  if (is(businessObject, 'bpmn:EndEvent')) return false
  if (is(businessObject, 'bpmn:StartEvent') || is(businessObject, 'bpmn:Gateway')) return true
  return is(businessObject, 'bpmn:Task') || is(businessObject, 'bpmn:Event')
}

export function FsContextPadProvider(...args) {
  ContextPadProvider.apply(this, args)
  // 基础 provider 没保存这两个服务；追加 serviceTask 时要用它们预置 fs:node。
  const extra = ContextPadProvider.$inject.length
  this._bpmnFactory = args[extra]
  this._moddle = args[extra + 1]
}

FsContextPadProvider.$inject = [...ContextPadProvider.$inject, 'bpmnFactory', 'moddle']

FsContextPadProvider.prototype = Object.create(ContextPadProvider.prototype)
FsContextPadProvider.prototype.constructor = FsContextPadProvider

/**
 * 构造一个追加动作；`kind` 为 agent/http 时使用预置 fs:node 的 serviceTask。
 */
FsContextPadProvider.prototype._fsAppendAction = function _fsAppendAction(type, options, kind, className, title) {
  const elementFactory = this._elementFactory
  const create = this._create
  const autoPlace = this._autoPlace
  const appendPreview = this._appendPreview
  const translate = this._translate
  const moddle = this._moddle || null

  const makeShape = () => {
    if (kind === 'agent' || kind === 'http') {
      const bpmnFactory = this._bpmnFactory
      return elementFactory.createShape({
        type: 'bpmn:ServiceTask',
        businessObject: createFsServiceTask(bpmnFactory, moddle, kind),
      })
    }
    return elementFactory.createShape({ type, ...(options || {}) })
  }

  const appendStart = (event, element) => {
    create.start(event, makeShape(), { source: element })
  }

  const append = autoPlace
    ? (_, element) => autoPlace.append(element, makeShape())
    : appendStart

  const preview = autoPlace && appendPreview
    ? (_, element) => {
      appendPreview.create(element, type, options)
      return () => appendPreview.cleanUp()
    }
    : null

  return {
    group: 'model',
    className,
    title: translate(title),
    action: {
      dragstart: appendStart,
      click: append,
      ...(preview ? { hover: preview } : {}),
    },
  }
}

FsContextPadProvider.prototype.getContextPadEntries = function getContextPadEntries(element) {
  const entries = ContextPadProvider.prototype.getContextPadEntries.call(this, element)
  const businessObject = element && element.businessObject
  const allowed = {}

  // (1) 过滤基础条目：不保留 append.task / append.intermediate-event 等非白名单入口。
  for (const [id, entry] of Object.entries(entries || {})) {
    if (ALLOWED_BASE_ENTRIES.has(id)) allowed[id] = entry
  }

  // (2) 追加三种合法节点（人工 / agent / HTTP）。
  if (businessObject && canAppend(businessObject)) {
    allowed['append.user-task'] = this._fsAppendAction(
      'bpmn:UserTask', null, 'human', 'bpmn-icon-user-task', '追加人工节点',
    )
    allowed['append.agent-task'] = this._fsAppendAction(
      'bpmn:ServiceTask', null, 'agent', 'bpmn-icon-service-task', '追加 agent 节点',
    )
    allowed['append.http-task'] = this._fsAppendAction(
      'bpmn:ServiceTask', null, 'http', 'bpmn-icon-service-task', '追加 HTTP 节点',
    )
  }

  return allowed
}

export const FsContextPadModule = {
  __init__: ['contextPadProvider'],
  contextPadProvider: ['type', FsContextPadProvider],
}
