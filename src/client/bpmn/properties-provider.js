/**
 * `FsPropertiesProvider`：在官方属性面板里追加业务字段组。
 *
 * 注册优先级 500（低于官方 BpmnPropertiesProvider 的默认 1000），所以我们是**最后**
 * 拿到 groups 的：先过滤官方组，再追加自己的组。这样：
 *   - 官方组里本版不执行的入口（多实例、补偿、错误、消息、信号、升级、定时器组）
 *     不会出现在面板上；
 *   - 业务字段组排在官方 General/Documentation 之后，用户先看到名称/ID。
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn/properties-provider
 */

import { Group, ListGroup } from '@bpmn-io/properties-panel'

import {
  checkEntry,
  conditionEntry,
  httpEntries,
  listTextFieldEntry,
  maxRoundsEntry,
  nodeAdapterEntry,
  nodeTextAreaEntry,
  nodeTextField,
  nodeTypeEntry,
  outputListGroupProps,
  teamListGroupProps,
  teamModeEntry,
} from './properties-entries.js'

import { isFsNodeElement, isSequenceFlow, nodeKindOf } from './modeling.js'

/**
 * 官方 provider 里对 0.13 执行子集无意义的组。
 * 只保留 General / Documentation —— 其余（多实例、补偿、消息、错误、信号、升级、
 * 定时器、Ad-hoc）都不属于可执行白名单。
 */
const ALLOWED_STANDARD_GROUPS = new Set(['general', 'documentation'])

function nodeGroups(element, injector) {
  const translate = injector.get('translate')
  const groups = []

  groups.push({
    id: 'fs-node',
    label: translate('业务节点'),
    component: Group,
    entries: [
      nodeTypeEntry('fs-node-type'),
      nodeTextField(
        'fs-node-provider',
        'Provider',
        'provider',
        '模型供应商 id（仅 agent 节点用于模型路由）。',
        'deepseek',
      ),
      nodeAdapterEntry('fs-node-adapter'),
      nodeTextField(
        'fs-node-model',
        'Model',
        'model',
        '模型 id（provider + model 成对才生效）。',
        'deepseek-chat',
      ),
      nodeTextField(
        'fs-node-agent-preset',
        'Agent preset',
        'agentPreset',
        '程序化会话使用的 preset 名称；留空表示宿主默认。',
        'default',
      ),
    ],
  })

  groups.push({
    id: 'fs-prompt',
    label: translate('提示词'),
    component: Group,
    entries: [
      nodeTextAreaEntry(
        'fs-node-prompt',
        'Prompt',
        'prompt',
        '节点任务提示词。',
        5,
      ),
      nodeTextAreaEntry(
        'fs-node-role-card',
        'Role card',
        'roleCard',
        '角色定位（system 风格的人设/职责说明）。',
        4,
      ),
    ],
  })

  groups.push({
    id: 'fs-advanced',
    label: translate('技能与 hooks'),
    component: Group,
    entries: [
      listTextFieldEntry(
        'fs-node-skills',
        'Skills',
        'skills',
        '逗号分隔；解析器按列表读取。',
        'research, code-review',
      ),
      listTextFieldEntry(
        'fs-node-hooks',
        'Hooks',
        'hooks',
        '逗号分隔；具体 hook 事件由 adapter 能力表决定。',
        'turn.stop',
      ),
    ],
  })

  const commandStack = injector.get('commandStack')
  const moddle = injector.get('moddle')

  const teamProps = teamListGroupProps(element, moddle, commandStack, translate)
  groups.push({
    id: 'fs-team',
    label: translate('团队'),
    component: Group,
    entries: [teamModeEntry('fs-team-mode')],
  })
  groups.push({
    id: 'fs-team-members',
    label: translate('团队成员'),
    component: ListGroup,
    items: teamProps.items,
    add: teamProps.add,
  })

  groups.push({
    id: 'fs-check',
    label: translate('检查'),
    component: Group,
    entries: [checkEntry('fs-check')],
  })

  const outputProps = outputListGroupProps(element, moddle, commandStack, translate)
  groups.push({
    id: 'fs-outputs',
    label: translate('输出声明'),
    component: ListGroup,
    items: outputProps.items,
    add: outputProps.add,
  })

  if (nodeKindOf(element) === 'http') {
    groups.push({
      id: 'fs-http',
      label: translate('HTTP 配置'),
      component: Group,
      entries: httpEntries(),
    })
  }

  return groups
}

function flowGroups(element, injector) {
  const translate = injector.get('translate')
  return [{
    id: 'fs-flow',
    label: translate('连线'),
    component: Group,
    entries: [
      conditionEntry('fs-flow-condition'),
      maxRoundsEntry('fs-flow-max-rounds'),
    ],
  }]
}

/** 根据选中元素生成业务组（只对白名单内的节点/连线返回内容）。 */
export function buildFsGroups(element, injector) {
  if (!element) return []
  if (isFsNodeElement(element)) return nodeGroups(element, injector)
  if (isSequenceFlow(element)) return flowGroups(element, injector)
  return []
}

/**
 * @param {object} propertiesPanel 官方 propertiesPanel 服务
 * @param {object} injector
 */
export function FsPropertiesProvider(propertiesPanel, injector) {
  propertiesPanel.registerProvider(500, this)
  this._injector = injector
}

FsPropertiesProvider.$inject = ['propertiesPanel', 'injector']

FsPropertiesProvider.prototype.getGroups = function getGroups(element) {
  const injector = this._injector
  return groups => {
    const filtered = (groups || []).filter(group => group && ALLOWED_STANDARD_GROUPS.has(group.id))
    return filtered.concat(buildFsGroups(element, injector))
  }
}

export const FsPropertiesProviderModule = {
  __init__: ['fsPropertiesProvider'],
  fsPropertiesProvider: ['type', FsPropertiesProvider],
}
