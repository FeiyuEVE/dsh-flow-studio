/**
 * 画布 palette：只暴露 0.13 执行白名单里的节点。
 *
 * 默认 bpmn-js palette 会给出并行/包容网关、脚本任务、子流程、数据对象等我们**不执行**
 * 的元素；这里用同名服务 `paletteProvider` 覆盖（additionalModules 后加载，didi 的
 * providers 表以后者为准），从源头上不开放这些入口。
 *
 * agent / HTTP 都是 `bpmn:serviceTask`，差异在 `fs:node@nodeType`。palette 创建时
 * 直接带上预置的业务对象，避免出现「先建出裸 serviceTask、再补扩展」的中间态。
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn/palette
 */

import { createFsServiceTask } from './modeling.js'

/** 创建普通 BPMN 图元（走 elementFactory + create 拖拽）。 */
function createAction(elementFactory, create, type, options) {
  return function createListener(event) {
    const shape = elementFactory.createShape({ type, ...(options || {}) })
    create.start(event, shape)
  }
}

/** 创建带 `fs:node` 的 serviceTask（agent / http）。 */
function createFsAction(bpmnFactory, moddle, elementFactory, create, kind) {
  return function createListener(event) {
    const businessObject = createFsServiceTask(bpmnFactory, moddle, kind)
    const shape = elementFactory.createShape({ type: 'bpmn:ServiceTask', businessObject })
    create.start(event, shape)
  }
}

/**
 * @param {object} palette
 * @param {object} create
 * @param {object} elementFactory
 * @param {object} bpmnFactory
 * @param {object} moddle
 * @param {object} handTool
 * @param {object} lassoTool
 * @param {object} globalConnect
 * @param {Function} translate
 */
export function FsPaletteProvider(
  palette, create, elementFactory, bpmnFactory, moddle,
  handTool, lassoTool, globalConnect, translate,
) {
  palette.registerProvider(this)
  this._palette = palette
  this._create = create
  this._elementFactory = elementFactory
  this._bpmnFactory = bpmnFactory
  this._moddle = moddle
  this._handTool = handTool
  this._lassoTool = lassoTool
  this._globalConnect = globalConnect
  this._translate = translate
}

FsPaletteProvider.$inject = [
  'palette',
  'create',
  'elementFactory',
  'bpmnFactory',
  'moddle',
  'handTool',
  'lassoTool',
  'globalConnect',
  'translate',
]

FsPaletteProvider.prototype.getPaletteEntries = function getPaletteEntries() {
  const create = this._create
  const elementFactory = this._elementFactory
  const translate = this._translate
  const event = type => createAction(elementFactory, create, type)
  const toolAction = (group, className, title, action) => ({
    group,
    className,
    title: translate(title),
    action,
  })

  return {
    'hand-tool': toolAction('tools', 'bpmn-icon-hand-tool', 'Activate hand tool', {
      click: event => this._handTool.activateHand(event),
    }),
    'lasso-tool': toolAction('tools', 'bpmn-icon-lasso-tool', 'Activate lasso tool', {
      click: event => this._lassoTool.activateSelection(event),
    }),
    'global-connect-tool': toolAction('tools', 'bpmn-icon-connection-multi', 'Connect using sequence flow', {
      click: event => this._globalConnect.start(event),
    }),
    'create.start-event': {
      group: 'event',
      className: 'bpmn-icon-start-event-none',
      title: translate('创建开始事件'),
      action: { dragstart: event('bpmn:StartEvent'), click: event('bpmn:StartEvent') },
    },
    'create.end-event': {
      group: 'event',
      className: 'bpmn-icon-end-event-none',
      title: translate('创建结束事件'),
      action: { dragstart: event('bpmn:EndEvent'), click: event('bpmn:EndEvent') },
    },
    'create.user-task': {
      group: 'activity',
      className: 'bpmn-icon-user-task',
      title: translate('创建人工节点（userTask）'),
      action: {
        dragstart: event('bpmn:UserTask'),
        click: event('bpmn:UserTask'),
      },
    },
    'create.agent-task': {
      group: 'activity',
      className: 'bpmn-icon-service-task',
      title: translate('创建 agent 节点（serviceTask + fs:node）'),
      action: {
        dragstart: createFsAction(
          this._bpmnFactory, this._moddle, this._elementFactory, this._create, 'agent',
        ),
        click: createFsAction(
          this._bpmnFactory, this._moddle, this._elementFactory, this._create, 'agent',
        ),
      },
    },
    'create.http-task': {
      group: 'activity',
      className: 'bpmn-icon-service-task',
      title: translate('创建 HTTP 节点（connector 尚未实现）'),
      action: {
        dragstart: createFsAction(
          this._bpmnFactory, this._moddle, this._elementFactory, this._create, 'http',
        ),
        click: createFsAction(
          this._bpmnFactory, this._moddle, this._elementFactory, this._create, 'http',
        ),
      },
    },
    'create.exclusive-gateway': {
      group: 'gateway',
      className: 'bpmn-icon-gateway-xor',
      title: translate('创建排他网关'),
      action: {
        dragstart: event('bpmn:ExclusiveGateway'),
        click: event('bpmn:ExclusiveGateway'),
      },
    },
    'create.text-annotation': {
      group: 'artifact',
      className: 'bpmn-icon-text-annotation',
      title: translate('创建文本注释'),
      action: {
        dragstart: event('bpmn:TextAnnotation'),
        click: event('bpmn:TextAnnotation'),
      },
    },
  }
}

/** additionalModules 里覆盖默认 paletteProvider。 */
export const FsPaletteModule = {
  __init__: ['paletteProvider'],
  paletteProvider: ['type', FsPaletteProvider],
}
