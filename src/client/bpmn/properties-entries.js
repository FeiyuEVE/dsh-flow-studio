/**
 * 官方属性面板里的业务字段组（`fs:` 扩展）。
 *
 * 全部组件都用 `@bpmn-io/properties-panel` 的 Preact（组件库自身内部也是同一个
 * Preact 副本），**不碰宿主 React**：混用两套 runtime 会触发 hooks 错误。
 *
 * 每条写入都经过 commandStack：
 *   - 首次创建 `extensionElements` / `fs:node` / `fs:team`… 与字段更新合成**一次**
 *     可撤销操作（`properties-panel.multi-command-executor`）；
 *   - 已有扩展只做 `element.updateModdleProperties`，保留 `extensionElements.values`
 *     里的其它扩展；
 *   - check 的非法 JSON 会写进 XML 原文（不静默清空），由 `validate` 在字段下方显示错误。
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn/properties-entries
 */

import {
  SelectEntry,
  TextAreaEntry,
  TextFieldEntry,
} from '@bpmn-io/properties-panel'
import { useService } from 'bpmn-js-properties-panel'

import { getBusinessObject, is } from 'bpmn-js/lib/util/ModelUtil.js'

import {
  applyCommands,
  ensureCheckCommands,
  ensureFsNodeCommands,
  ensureHttpCommands,
  ensureTeamCommands,
  getFsNode,
  getMaxRounds,
  listFromText,
  nodeKindOf,
  normalizeListText,
  setMaxRoundsCommands,
  updateCommand,
} from './modeling.js'

/** 新建/编辑扩展字段时使用的缺省 nodeType（人工节点不写 nodeType）。 */
function defaultNodeType(element) {
  if (is(element, 'bpmn:ServiceTask')) return nodeKindOf(element) || 'agent'
  return undefined
}

/** 从 fsNode 读字符串字段。 */
function readNodeField(element, field) {
  const fsNode = getFsNode(element)
  const value = fsNode && fsNode[field]
  return value === undefined || value === null ? '' : String(value)
}

/** 把字段值写回 fsNode；必要时创建 extensionElements / fs:node。 */
function writeNodeField(element, moddle, commandStack, field, value) {
  const normalized = value === undefined || value === null || value === '' ? undefined : value
  const current = getFsNode(element)
  const currentValue = current ? current[field] : undefined
  // 未变化不写命令：属性面板失焦时会用同一值再提交一次，空写会制造脏历史。
  if ((currentValue === undefined || currentValue === null ? undefined : String(currentValue))
    === (normalized === undefined ? undefined : String(normalized))) {
    return
  }
  const ensured = ensureFsNodeCommands(element, moddle, defaultNodeType(element))
  const commands = [...ensured.commands]
  commands.push(updateCommand(element, ensured.fsNode, { [field]: normalized }))
  applyCommands(commandStack, commands)
}

/* ── 节点标识 ─────────────────────────────────────────────────────── */

function NodeTextField(props) {
  const { element, id, label, field, description, placeholder } = props
  const commandStack = useService('commandStack')
  const moddle = useService('moddle')
  const translate = useService('translate')
  const debounce = useService('debounceInput')
  return TextFieldEntry({
    element,
    id,
    label: translate(label),
    description,
    placeholder,
    debounce,
    getValue: () => readNodeField(element, field),
    setValue: value => writeNodeField(element, moddle, commandStack, field, value),
  })
}

export function nodeTextField(id, label, field, description, placeholder) {
  return { id, label, component: NodeTextField, field, description, placeholder }
}

function NodeAdapterSelect(props) {
  const { element, id, label, description } = props
  const commandStack = useService('commandStack')
  const moddle = useService('moddle')
  const translate = useService('translate')
  return SelectEntry({
    element,
    id,
    label: translate(label),
    description,
    getValue: () => readNodeField(element, 'adapter'),
    setValue: value => writeNodeField(element, moddle, commandStack, 'adapter', value),
    getOptions: () => [
      { value: '', label: translate('（未指定，沿用默认）') },
      { value: 'dsh', label: 'DSH' },
      { value: 'codex', label: 'Codex' },
    ],
  })
}

export function nodeAdapterEntry(id = 'fs-node-adapter') {
  return { id, label: 'Adapter', component: NodeAdapterSelect }
}

/**
 * 节点类型：human = `bpmn:userTask`；agent/http = `bpmn:serviceTask` + `fs:node@nodeType`。
 * 改类型会走 `bpmnReplace`（真正的 BPMN 类型替换），不会留下「伪 agentTask」。
 */
function NodeTypeSelect(props) {
  const { element, id, label } = props
  const commandStack = useService('commandStack')
  const moddle = useService('moddle')
  const bpmnReplace = useService('bpmnReplace')
  const selection = useService('selection')
  const translate = useService('translate')

  const getValue = () => nodeKindOf(element) || ''
  const setValue = value => {
    const current = nodeKindOf(element)
    if (!value || value === current) return

    if (value === 'human') {
      if (!is(element, 'bpmn:ServiceTask')) return
      const newShape = bpmnReplace.replaceElement(element, { type: 'bpmn:UserTask' }, {})
      const fsNode = getFsNode(newShape)
      if (fsNode) {
        applyCommands(commandStack, [updateCommand(newShape, fsNode, { nodeType: undefined, http: undefined })])
      }
      selection.select(newShape)
      return
    }

    if (is(element, 'bpmn:UserTask')) {
      const newShape = bpmnReplace.replaceElement(element, { type: 'bpmn:ServiceTask' }, {})
      const ensured = ensureFsNodeCommands(newShape, moddle, value)
      applyCommands(commandStack, ensured.commands)
      selection.select(newShape)
      return
    }

    const ensured = ensureFsNodeCommands(element, moddle, value)
    applyCommands(commandStack, ensured.commands)
  }

  return SelectEntry({
    element,
    id,
    label: translate(label),
    getValue,
    setValue,
    getOptions: () => [
      { value: 'human', label: translate('人工（userTask）') },
      { value: 'agent', label: translate('Agent（serviceTask）') },
      { value: 'http', label: translate('HTTP（serviceTask，connector 未实现）') },
    ],
  })
}

export function nodeTypeEntry(id = 'fs-node-type') {
  return { id, label: '节点类型', component: NodeTypeSelect }
}

/* ── prompt / roleCard ────────────────────────────────────────────── */

function NodeTextArea(props) {
  const { element, id, label, field, description, placeholder, rows = 4 } = props
  const commandStack = useService('commandStack')
  const moddle = useService('moddle')
  const translate = useService('translate')
  const debounce = useService('debounceInput')
  return TextAreaEntry({
    element,
    id,
    label: translate(label),
    description,
    placeholder,
    rows,
    debounce,
    getValue: () => readNodeField(element, field),
    setValue: value => writeNodeField(element, moddle, commandStack, field, value),
  })
}

export function nodeTextAreaEntry(id, label, field, description, rows = 4) {
  return { id, label, component: NodeTextArea, field, description, rows }
}

/* ── skills / hooks（逗号分隔，解析器按 listValue 读） ────────────── */

function ListTextField(props) {
  const { element, id, label, field, description, placeholder } = props
  const commandStack = useService('commandStack')
  const moddle = useService('moddle')
  const translate = useService('translate')
  const debounce = useService('debounceInput')
  return TextFieldEntry({
    element,
    id,
    label: translate(label),
    description,
    placeholder,
    debounce,
    getValue: () => listFromText(readNodeField(element, field)).join(', '),
    setValue: value => writeNodeField(element, moddle, commandStack, field, normalizeListText(value) || undefined),
  })
}

export function listTextFieldEntry(id, label, field, description, placeholder) {
  return { id, label, component: ListTextField, field, description, placeholder }
}

/* ── check ────────────────────────────────────────────────────────── */

/** `fs:check` 正文的 JSON 校验：返回 null 表示合法，字符串表示错误。 */
export function validateCheckJson(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'check 必须是 JSON 对象（不能是数组/字符串/数字）'
    }
    return null
  } catch (error) {
    return `JSON 语法错误：${error && error.message ? error.message : String(error)}`
  }
}

function CheckJsonField(props) {
  const { element, id, label, description } = props
  const commandStack = useService('commandStack')
  const moddle = useService('moddle')
  const translate = useService('translate')
  const debounce = useService('debounceInput')

  const getValue = () => {
    const fsNode = getFsNode(element)
    const check = fsNode && fsNode.check
    if (!check) return ''
    return typeof check.json === 'string' ? check.json : ''
  }

  const setValue = value => {
    const ensured = ensureFsNodeCommands(element, moddle, defaultNodeType(element))
    const commands = [...ensured.commands]
    const withCheck = ensureCheckCommands(element, moddle, ensured.fsNode)
    commands.push(...withCheck.commands)
    commands.push(updateCommand(element, withCheck.check, { json: value === undefined ? '' : String(value) }))
    applyCommands(commandStack, commands)
  }

  return TextAreaEntry({
    element,
    id,
    label: translate(label),
    description,
    rows: 6,
    monospace: true,
    debounce,
    validate: validateCheckJson,
    getValue,
    setValue,
  })
}

export function checkEntry(id = 'fs-check') {
  return {
    id,
    label: '检查（check JSON）',
    component: CheckJsonField,
    description: '必须是 JSON 对象；非法值会保留在 XML 里并在字段下报错，不会静默清空。',
  }
}

/* ── team（fs:Team + fs:Member[]） ────────────────────────────────── */

function teamOf(element) {
  const fsNode = getFsNode(element)
  return (fsNode && fsNode.team) || null
}

function memberList(team) {
  if (!team) return []
  return Array.isArray(team.member) ? team.member : (team.member ? [team.member] : [])
}

function MemberField(props) {
  const { element, id, label, field, description, rows } = props
  const member = props.member
  const commandStack = useService('commandStack')
  const translate = useService('translate')
  const debounce = useService('debounceInput')
  const value = member && member[field]
  const getValue = () => (value === undefined || value === null ? '' : String(value))
  const setValue = next => {
    const normalized = field === 'skills'
      ? (normalizeListText(next) || undefined)
      : (next === undefined || next === null || next === '' ? undefined : next)
    applyCommands(commandStack, [updateCommand(element, member, { [field]: normalized })])
  }
  if (rows) {
    return TextAreaEntry({
      element,
      id,
      label: translate(label),
      description,
      rows,
      debounce,
      getValue,
      setValue,
    })
  }
  return TextFieldEntry({
    element,
    id,
    label: translate(label),
    description,
    debounce,
    getValue,
    setValue,
  })
}

function memberEntries(member, index) {
  const prefix = `fs-team-member-${index}`
  return [
    { id: `${prefix}-id`, label: '成员 ID', component: MemberField, member, field: 'id' },
    { id: `${prefix}-role`, label: '角色', component: MemberField, member, field: 'role' },
    { id: `${prefix}-skills`, label: 'skills', component: MemberField, member, field: 'skills' },
    { id: `${prefix}-prompt`, label: '提示词', component: MemberField, member, field: 'prompt', rows: 3 },
  ]
}

/** team 列表组的 items / add 描述（供 ListGroup 使用）。 */
export function teamListGroupProps(element, moddle, commandStack, translate) {
  const team = teamOf(element)
  const members = memberList(team)
  const items = members.map((member, index) => ({
    id: `fs-team-member-${index}`,
    label: (member && member.id) || `${translate('成员')} ${index + 1}`,
    entries: memberEntries(member, index),
    autoFocusEntry: `fs-team-member-${index}-id`,
    remove: event => {
      event.stopPropagation()
      const remaining = members.filter((_, i) => i !== index)
      const commands = []
      if (remaining.length === 0) {
        commands.push(updateCommand(element, team, { member: [] }))
      } else {
        commands.push(updateCommand(element, team, { member: remaining }))
      }
      applyCommands(commandStack, commands)
    },
  }))

  const add = () => {
    const commands = []
    const ensured = ensureFsNodeCommands(element, moddle, defaultNodeType(element))
    commands.push(...ensured.commands)
    const ensuredTeam = ensureTeamCommands(element, moddle, ensured.fsNode)
    commands.push(...ensuredTeam.commands)
    const nextIndex = memberList(ensuredTeam.team).length + 1
    const member = moddle.create('fs:Member', { id: `member_${nextIndex}`, role: '' })
    member.$parent = ensuredTeam.team
    commands.push(updateCommand(element, ensuredTeam.team, {
      member: [...memberList(ensuredTeam.team), member],
    }))
    applyCommands(commandStack, commands)
  }

  return {
    items,
    add,
    mode: team ? (team.mode || '') : (members.length ? 'fanout' : 'none'),
  }
}

function TeamModeSelect(props) {
  const { element, id, label } = props
  const team = teamOf(element)
  const commandStack = useService('commandStack')
  const moddle = useService('moddle')
  const translate = useService('translate')
  const getValue = () => {
    if (team) return team.mode || (memberList(team).length ? 'fanout' : 'none')
    return 'none'
  }
  const setValue = value => {
    const commands = []
    const ensured = ensureFsNodeCommands(element, moddle, defaultNodeType(element))
    commands.push(...ensured.commands)
    const ensuredTeam = ensureTeamCommands(element, moddle, ensured.fsNode)
    commands.push(...ensuredTeam.commands)
    commands.push(updateCommand(element, ensuredTeam.team, { mode: value }))
    applyCommands(commandStack, commands)
  }
  return SelectEntry({
    element,
    id,
    label: translate(label),
    getValue,
    setValue,
    getOptions: () => [
      { value: 'none', label: translate('none（不启用团队）') },
      { value: 'fanout', label: translate('fanout（并行子 agent）') },
    ],
  })
}

export function teamModeEntry(id = 'fs-team-mode') {
  return { id, label: '团队模式', component: TeamModeSelect }
}

/* ── output（fs:Output[]） ───────────────────────────────────────── */

/** 把一个 fs:Output 投影成文本框里的“声明”字符串。 */
export function outputToText(output) {
  if (!output) return ''
  if (typeof output.json === 'string' && output.json.trim() !== '') return output.json
  if (typeof output.text === 'string' && output.text.trim() !== '') return output.text
  const plain = {}
  if (output.name !== undefined) plain.name = output.name
  if (output.kind !== undefined) plain.kind = output.kind
  if (output.required !== undefined) plain.required = output.required
  return Object.keys(plain).length ? JSON.stringify(plain) : ''
}

/** 看起来像 JSON 的文本（失败时按“非法 JSON”报错，而不是当普通字符串吞掉）。 */
function looksLikeJson(text) {
  return /^[[{"]/.test(text.trim())
}

/** 输出声明的校验：空值/普通字符串合法；像 JSON 但解析失败则报错。 */
export function validateOutputText(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '' || !looksLikeJson(text)) return null
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed)
      if (keys.every(key => ['name', 'kind', 'required'].includes(key))) return null
    }
    return null
  } catch (error) {
    return `JSON 语法错误：${error && error.message ? error.message : String(error)}`
  }
}

/** 生成一条写回 fs:Output 的命令。 */
function outputCommand(element, output, text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const properties = {
    json: undefined,
    text: undefined,
    name: undefined,
    kind: undefined,
    required: undefined,
  }
  if (trimmed === '') {
    return updateCommand(element, output, properties)
  }
  if (!looksLikeJson(trimmed)) {
    properties.text = trimmed
    return updateCommand(element, output, properties)
  }
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed === 'string') {
      properties.text = parsed
      return updateCommand(element, output, properties)
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed)
      if (keys.every(key => ['name', 'kind', 'required'].includes(key))) {
        if (parsed.name !== undefined) properties.name = String(parsed.name)
        if (parsed.kind !== undefined) properties.kind = String(parsed.kind)
        if (parsed.required !== undefined) properties.required = Boolean(parsed.required)
        return updateCommand(element, output, properties)
      }
    }
    properties.json = trimmed
    return updateCommand(element, output, properties)
  } catch {
    // 非法 JSON 也原样留档（json 属性），字段校验会显示错误，不静默丢内容。
    properties.json = trimmed
    return updateCommand(element, output, properties)
  }
}

function OutputTextField(props) {
  const { element, id, label, output } = props
  const commandStack = useService('commandStack')
  const translate = useService('translate')
  const debounce = useService('debounceInput')
  return TextAreaEntry({
    element,
    id,
    label: translate(label),
    rows: 2,
    monospace: true,
    debounce,
    validate: validateOutputText,
    getValue: () => outputToText(output),
    setValue: value => applyCommands(commandStack, [outputCommand(element, output, value)]),
  })
}

/** output 列表组的 items / add 描述。 */
export function outputListGroupProps(element, moddle, commandStack, translate) {
  const fsNode = getFsNode(element)
  const outputs = fsNode && Array.isArray(fsNode.output) ? fsNode.output : []
  const items = outputs.map((output, index) => ({
    id: `fs-output-${index}`,
    label: outputToText(output) || `${translate('输出')} ${index + 1}`,
    entries: [{
      id: `fs-output-${index}-value`,
      label: '声明',
      component: OutputTextField,
      output,
    }],
    autoFocusEntry: `fs-output-${index}-value`,
    remove: event => {
      event.stopPropagation()
      applyCommands(commandStack, [
        updateCommand(element, fsNode, { output: outputs.filter((_, i) => i !== index) }),
      ])
    },
  }))

  const add = () => {
    const commands = []
    const ensured = ensureFsNodeCommands(element, moddle, defaultNodeType(element))
    commands.push(...ensured.commands)
    const output = moddle.create('fs:Output', { text: '' })
    output.$parent = ensured.fsNode
    commands.push(updateCommand(element, ensured.fsNode, {
      output: [...(Array.isArray(ensured.fsNode.output) ? ensured.fsNode.output : []), output],
    }))
    applyCommands(commandStack, commands)
  }

  return { items, add }
}

/* ── HTTP 配置（fs:Http；connector 尚未实现） ────────────────────── */

const HTTP_NOTE = '0.13 的 HTTP connector 尚未接通：此处只保存配置，运行到该节点会因缺少 handler 失败。'

function httpOf(element) {
  const fsNode = getFsNode(element)
  return (fsNode && fsNode.http) || null
}

function HttpField(props) {
  const { element, id, label, field, description, placeholder, rows } = props
  const commandStack = useService('commandStack')
  const moddle = useService('moddle')
  const translate = useService('translate')
  const debounce = useService('debounceInput')
  const http = httpOf(element)
  const raw = http && http[field]
  const getValue = () => (raw === undefined || raw === null ? '' : String(raw))

  const setValue = value => {
    const live = httpOf(element)
    const liveValue = live ? live[field] : undefined
    const candidate = value === undefined || value === null || value === '' ? undefined : String(value)
    if ((liveValue === undefined || liveValue === null ? undefined : String(liveValue)) === candidate) {
      return
    }
    const commands = []
    // 不要硬写 nodeType='http'：节点类型切回 agent 后，HTTP 字段的延迟提交
    // 若强制写 http 会把 nodeType 改回去。沿用元素当前语义即可。
    const ensured = ensureFsNodeCommands(element, moddle, defaultNodeType(element))
    commands.push(...ensured.commands)
    const ensuredHttp = ensureHttpCommands(element, moddle, ensured.fsNode)
    commands.push(...ensuredHttp.commands)
    let normalized = value === undefined || value === null || value === ''
      ? undefined
      : value
    // 描述符里 timeoutMs/retries 是 Integer，属性面板输入是字符串：这里收窄成数字。
    if (normalized !== undefined && (field === 'timeoutMs' || field === 'retries')) {
      normalized = /^-?\d+$/.test(String(normalized).trim())
        ? Number(String(normalized).trim())
        : undefined
    }
    commands.push(updateCommand(element, ensuredHttp.http, { [field]: normalized }))
    applyCommands(commandStack, commands)
  }

  if (rows) {
    return TextAreaEntry({
      element, id, label: translate(label), description, placeholder, rows, debounce,
      monospace: field === 'headers',
      validate: field === 'headers' ? validateHeadersJson : undefined,
      getValue,
      setValue,
    })
  }
  return TextFieldEntry({
    element, id, label: translate(label), description, placeholder, debounce,
    getValue,
    setValue,
  })
}

/** `fs:http@headers` 必须是 JSON 对象（解析器同样按对象读）。 */
export function validateHeadersJson(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return null
    return 'headers 必须是 JSON 对象'
  } catch (error) {
    return `JSON 语法错误：${error && error.message ? error.message : String(error)}`
  }
}

export function httpEntries() {
  return [
    { id: 'fs-http-method', label: '方法', component: HttpMethodField },
    {
      id: 'fs-http-url',
      label: 'URL',
      component: HttpField,
      field: 'url',
      placeholder: 'https://example.com/hook',
      description: HTTP_NOTE,
    },
    {
      id: 'fs-http-headers',
      label: 'Headers（JSON 对象）',
      component: HttpField,
      field: 'headers',
      rows: 3,
      placeholder: '{"content-type":"application/json"}',
    },
    { id: 'fs-http-body', label: 'Body', component: HttpField, field: 'body', rows: 3 },
    { id: 'fs-http-timeout', label: '超时（毫秒）', component: HttpField, field: 'timeoutMs' },
    { id: 'fs-http-retries', label: '重试次数', component: HttpField, field: 'retries' },
    { id: 'fs-http-input', label: '输入映射', component: HttpField, field: 'inputMapping', rows: 2 },
    { id: 'fs-http-output', label: '输出映射', component: HttpField, field: 'outputMapping', rows: 2 },
  ]
}

function HttpMethodField(props) {
  const { element, id, label } = props
  const commandStack = useService('commandStack')
  const moddle = useService('moddle')
  const translate = useService('translate')
  const http = httpOf(element)
  const getValue = () => (http && http.method ? String(http.method) : '')
  const setValue = value => {
    const live = httpOf(element)
    const liveValue = live ? live[field] : undefined
    const candidate = value === undefined || value === null || value === '' ? undefined : String(value)
    if ((liveValue === undefined || liveValue === null ? undefined : String(liveValue)) === candidate) {
      return
    }
    const commands = []
    // 不要硬写 nodeType='http'：节点类型切回 agent 后，HTTP 字段的延迟提交
    // 若强制写 http 会把 nodeType 改回去。沿用元素当前语义即可。
    const ensured = ensureFsNodeCommands(element, moddle, defaultNodeType(element))
    commands.push(...ensured.commands)
    const ensuredHttp = ensureHttpCommands(element, moddle, ensured.fsNode)
    commands.push(...ensuredHttp.commands)
    commands.push(updateCommand(element, ensuredHttp.http, { method: value || undefined }))
    applyCommands(commandStack, commands)
  }
  return SelectEntry({
    element,
    id,
    label: translate(label),
    description: HTTP_NOTE,
    getValue,
    setValue,
    getOptions: () => [
      { value: '', label: translate('（未指定）') },
      { value: 'GET', label: 'GET' },
      { value: 'POST', label: 'POST' },
      { value: 'PUT', label: 'PUT' },
      { value: 'PATCH', label: 'PATCH' },
      { value: 'DELETE', label: 'DELETE' },
    ],
  })
}

/* ── 连线：conditionExpression + fs:MaxRounds ────────────────────── */

function ConditionExpressionField(props) {
  const { element, id, label, description } = props
  const commandStack = useService('commandStack')
  const moddle = useService('moddle')
  const translate = useService('translate')
  const debounce = useService('debounceInput')
  const businessObject = getBusinessObject(element)
  const existing = businessObject.conditionExpression

  const getValue = () => {
    const condition = getBusinessObject(element).conditionExpression
    return condition && typeof condition.body === 'string' ? condition.body : ''
  }

  const setValue = value => {
    const bo = getBusinessObject(element)
    const condition = bo.conditionExpression
    const text = typeof value === 'string' ? value : ''
    if (text.trim() === '') {
      if (condition) applyCommands(commandStack, [updateCommand(element, bo, { conditionExpression: undefined })])
      return
    }
    if (condition) {
      applyCommands(commandStack, [updateCommand(element, condition, { body: text, language: 'feel' })])
      return
    }
    const expression = moddle.create('bpmn:FormalExpression', { body: text, language: 'feel' })
    expression.$parent = bo
    applyCommands(commandStack, [updateCommand(element, bo, { conditionExpression: expression })])
  }

  return TextAreaEntry({
    element,
    id,
    label: translate(label),
    description,
    rows: 3,
    monospace: true,
    debounce,
    getValue,
    setValue,
  })
}

export function conditionEntry(id = 'fs-flow-condition') {
  return {
    id,
    label: '条件（FEEL）',
    component: ConditionExpressionField,
    description: '写成 FEEL 表达式即可（可带 `=` 前缀）；空值会移除 conditionExpression。',
  }
}

function MaxRoundsField(props) {
  const { element, id, label, description } = props
  const commandStack = useService('commandStack')
  const moddle = useService('moddle')
  const translate = useService('translate')
  const debounce = useService('debounceInput')
  return TextFieldEntry({
    element,
    id,
    label: translate(label),
    description,
    debounce,
    getValue: () => getMaxRounds(element),
    setValue: value => applyCommands(commandStack, setMaxRoundsCommands(element, moddle, value)),
  })
}

export function maxRoundsEntry(id = 'fs-flow-max-rounds') {
  return {
    id,
    label: '打回次数上限（fs:maxRounds）',
    component: MaxRoundsField,
    description: '写在连线的 extensionElements 上；非数字会原样保留并显示解析告警。',
  }
}

