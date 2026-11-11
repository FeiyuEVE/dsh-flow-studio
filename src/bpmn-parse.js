/**
 * BPMN 2.0 XML 解析与 0.13.0 发布前校验。
 *
 * 正本仍是 BPMN XML（模板域）；本模块把它投影成跨模块统一的归一化模型。
 * 形状契约见 docs/plan/0.13-bpmn引擎与适配器.md 与交付说明；本文件在契约之外
 * **只加两个可加性字段**（不改变契约字段的语义）：
 *
 * - `element.ioMapping`：`zeebe:ioMapping` 读出来的 `{ input, output }`（无则 null）；
 * - `element.extensions` / `flow.extensions`：`fs:` 扩展子元素的原样投影（无则 []），
 *   用于 `fs:note`、回退边上的 `fs:maxRounds` 等。
 *
 * 依赖（都已 vendor，直接 import）：
 * - `bpmn-moddle@10.3.1`：官方 BPMN XML 解析器；
 * - `zeebe-bpmn-moddle@2.0.0`：`zeebe:taskDefinition` / `zeebe:ioMapping` 描述符；
 * - `./bpmn-expr.js`：条件表达式的语言白名单与可疑内容检查。
 *
 * 注意：`bpmn-moddle` 的 `fromXML()` 是异步 API（返回 Promise），所以 `parseBpmn()`
 * 也是 async；它在内部把一切异常收敛成 `{ ok:false, errors }`，**不会 reject**。
 * 这是相对交付契约唯一无法避免的形态偏差（依赖没有同步入口）。
 *
 * @module @feiyueve/dsh-flow-studio/bpmn-parse
 */

import { createHash } from 'node:crypto'

import { BpmnModdle } from './bpmn-moddle-vendor.js'
import zeebeModdlePackage from './zeebe-moddle-vendor.js'

import { assertFeelSafe, isFeelLanguage } from './bpmn-expr.js'
import { collectRawExecutionViolations } from './bpmn-policy.js'

/** 我们自己的扩展命名空间：`fs:`（Flow Studio）。 */
export const FS_NAMESPACE = 'http://feiyueve.dev/schema/bpmn/fs/1.0'
/** 官方 BPMN 2.0 MODEL 命名空间。 */
export const BPMN_NAMESPACE = 'http://www.omg.org/spec/BPMN/20100524/MODEL'
/** 官方 BPMN 2.0 DI 命名空间（转换器生成图时用）。 */
export const BPMNDI_NAMESPACE = 'http://www.omg.org/spec/BPMN/20100524/DI'
/** Camunda Zeebe 扩展命名空间。 */
export const ZEEBE_NAMESPACE = 'http://camunda.org/schema/zeebe/1.0'

/**
 * `fs:` 的 moddle 描述符。
 *
 * 写法按实测（docs/plan/0.13-研究-bpmn-engine.md §6）：
 * - `superClass: ['Element']`——用 `extends: ['bpmn:BaseElement']` 实测解析不到
 *   `extensionElements` 里的子元素；
 * - `xml.tagAlias: 'lowerCase'`——`fs:Node` → `<fs:node>`、`fs:MaxRounds` → `<fs:maxRounds>`。
 *
 * 字段说明：
 * - `<fs:node nodeType="agent|http" provider="…" adapter="…" skills="a,b" hooks="x,y">`
 * - 子元素：`<fs:prompt>` / `<fs:roleCard>` / `<fs:note>` / `<fs:team>` / `<fs:http>`；
 * - `<fs:team mode="fanout|none"><fs:member id="…" role="…" skills="…"><fs:prompt>…</fs:prompt></fs:member></fs:team>`
 * - `<fs:maxRounds>2</fs:maxRounds>`：挂在回退 `sequenceFlow` 的 `extensionElements` 上，
 *   记录旧模型里目标节点的打回上限。
 */
export const FS_MODDLE_PACKAGE = {
  name: 'fs',
  prefix: 'fs',
  uri: FS_NAMESPACE,
  xml: { tagAlias: 'lowerCase' },
  associations: [],
  types: [
    {
      name: 'Node',
      superClass: ['Element'],
      properties: [
        { name: 'nodeType', type: 'String', isAttr: true },
        { name: 'provider', type: 'String', isAttr: true },
        { name: 'adapter', type: 'String', isAttr: true },
        { name: 'skills', type: 'String', isAttr: true },
        { name: 'hooks', type: 'String', isAttr: true },
        { name: 'prompt', type: 'String' },
        { name: 'roleCard', type: 'String' },
        { name: 'note', type: 'String' },
        { name: 'model', type: 'String', isAttr: true },
        { name: 'agentPreset', type: 'String', isAttr: true },
        { name: 'team', type: 'Team' },
        { name: 'http', type: 'Http' },
        { name: 'executor', type: 'Executor' },
        { name: 'output', type: 'Output', isMany: true },
        { name: 'check', type: 'Check' },
        { name: 'legacy', type: 'Legacy' },
      ],
    },
    {
      name: 'Team',
      superClass: ['Element'],
      properties: [
        { name: 'mode', type: 'String', isAttr: true },
        { name: 'member', type: 'Member', isMany: true },
      ],
    },
    {
      name: 'Member',
      superClass: ['Element'],
      properties: [
        { name: 'id', type: 'String', isAttr: true },
        { name: 'role', type: 'String', isAttr: true },
        { name: 'skills', type: 'String', isAttr: true },
        { name: 'prompt', type: 'String' },
      ],
    },
    {
      name: 'Http',
      superClass: ['Element'],
      properties: [
        { name: 'method', type: 'String', isAttr: true },
        { name: 'url', type: 'String', isAttr: true },
        { name: 'headers', type: 'String', isAttr: true },
        { name: 'timeoutMs', type: 'Integer', isAttr: true },
        { name: 'retries', type: 'Integer', isAttr: true },
        { name: 'body', type: 'String' },
        { name: 'inputMapping', type: 'String' },
        { name: 'outputMapping', type: 'String' },
      ],
    },
    {
      name: 'Executor',
      superClass: ['Element'],
      properties: [
        { name: 'kind', type: 'String', isAttr: true },
        { name: 'command', type: 'String', isAttr: true },
        { name: 'cwd', type: 'String', isAttr: true },
        { name: 'env', type: 'String', isAttr: true },
        { name: 'timeoutMs', type: 'Integer', isAttr: true },
        { name: 'schemaPath', type: 'String', isAttr: true },
      ],
    },
    {
      name: 'Output',
      superClass: ['Element'],
      properties: [
        { name: 'name', type: 'String', isAttr: true },
        { name: 'kind', type: 'String', isAttr: true },
        { name: 'required', type: 'Boolean', isAttr: true },
        // 不是标准的 {name,kind,required} 形状时，用 JSON 原样留档。
        { name: 'json', type: 'String', isAttr: true },
        { name: 'text', type: 'String', isBody: true },
      ],
    },
    {
      name: 'Check',
      superClass: ['Element'],
      properties: [{ name: 'json', type: 'String', isBody: true }],
    },
    {
      name: 'Legacy',
      superClass: ['Element'],
      properties: [{ name: 'json', type: 'String', isBody: true }],
    },
    {
      name: 'Note',
      superClass: ['Element'],
      properties: [{ name: 'text', type: 'String', isBody: true }],
    },
    {
      name: 'MaxRounds',
      superClass: ['Element'],
      properties: [{ name: 'value', type: 'Integer', isBody: true }],
    },
  ],
}

/** 创建一个同时认识 `fs:` 与 `zeebe:` 的 moddle 实例。 */
export function createBpmnModdle() {
  return new BpmnModdle({ fs: FS_MODDLE_PACKAGE, zeebe: zeebeModdlePackage })
}

/** 参与归一化模型的 flow node 类型（其余 flowElement 如注解/关联直接忽略）。 */
const FLOW_NODE_TYPES = new Set([
  'bpmn:StartEvent',
  'bpmn:EndEvent',
  'bpmn:ServiceTask',
  'bpmn:UserTask',
  'bpmn:Task',
  'bpmn:ManualTask',
  'bpmn:ScriptTask',
  'bpmn:BusinessRuleTask',
  'bpmn:SendTask',
  'bpmn:ReceiveTask',
  'bpmn:ExclusiveGateway',
  'bpmn:ParallelGateway',
  'bpmn:InclusiveGateway',
  'bpmn:ComplexGateway',
  'bpmn:EventBasedGateway',
  'bpmn:IntermediateCatchEvent',
  'bpmn:IntermediateThrowEvent',
  'bpmn:BoundaryEvent',
  'bpmn:SubProcess',
  'bpmn:CallActivity',
])

/** 网关类型（kind 统一是 gateway）。 */
const GATEWAY_TYPES = new Set([
  'bpmn:ExclusiveGateway',
  'bpmn:ParallelGateway',
  'bpmn:InclusiveGateway',
  'bpmn:ComplexGateway',
  'bpmn:EventBasedGateway',
])

/** `fs:Node` 上已映射进契约 `node` 的字段；其余记为扩展。 */
const KNOWN_FS_NODE_PROPERTIES = new Set([
  'nodeType', 'provider', 'adapter', 'skills', 'hooks', 'prompt', 'roleCard', 'team', 'http',
  'model', 'agentPreset', 'executor', 'output', 'check', 'legacy',
])

/** `$attrs` 里出现这些 fs: 属性时按数字收窄。 */
const NUMERIC_EXTENSION_ATTRIBUTES = new Set(['maxRounds', 'timeoutMs', 'retries'])

/** 统一的短 id / 名字取值。 */
function stringOrNull(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function integerOrNull(value) {
  if (Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

/** `bpmn:ServiceTask` → `serviceTask`（契约要求首字母小写）。 */
function localTypeName(type) {
  const text = typeof type === 'string' ? type : ''
  const local = text.startsWith('bpmn:') ? text.slice('bpmn:'.length) : text
  return local ? local.charAt(0).toLowerCase() + local.slice(1) : local
}

/** fs:MaxRounds → maxRounds。 */
function localExtensionName(type) {
  const text = typeof type === 'string' ? type : ''
  const local = text.includes(':') ? text.slice(text.indexOf(':') + 1) : text
  return local ? local.charAt(0).toLowerCase() + local.slice(1) : ''
}

/** 从 moddle 引用（元素对象 / id 字符串 / 缺失）取 id。 */
function referenceId(value) {
  if (!value) return null
  if (typeof value === 'string') return value || null
  if (typeof value.id === 'string' && value.id !== '') return value.id
  return null
}

function extensionValues(element) {
  const values = element?.extensionElements?.values
  return Array.isArray(values) ? values : []
}

/** 逗号分隔的属性值 → 去重后的字符串数组。 */
function listValue(value) {
  if (Array.isArray(value)) {
    return [...new Set(value
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean))]
  }
  if (typeof value !== 'string') return []
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
}

function toArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** 把一个 moddle 扩展值投影成普通 JSON（fs:Note → 文本、fs:MaxRounds → 数字）。 */
function plainExtensionValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(plainExtensionValue)
  if (typeof value.text === 'string') return value.text
  if (typeof value.value === 'string' || typeof value.value === 'number' || typeof value.value === 'boolean') {
    return value.value
  }
  const out = {}
  for (const key of Object.keys(value)) {
    if (key.startsWith('$')) continue
    out[key] = plainExtensionValue(value[key])
  }
  return out
}

/** 收集 `fs:` 扩展子元素（fs:node 之外的 Note / MaxRounds，以及 node 上的额外子元素）。 */
function collectExtensions(element) {
  const extensions = []
  for (const value of extensionValues(element)) {
    const type = typeof value?.$type === 'string' ? value.$type : ''
    if (type === 'fs:Node') {
      for (const key of Object.keys(value)) {
        if (key.startsWith('$') || KNOWN_FS_NODE_PROPERTIES.has(key)) continue
        if (value[key] === undefined || value[key] === null) continue
        extensions.push({
          type: key === 'note' ? 'fs:Note' : `fs:Node.${key}`,
          name: key,
          value: plainExtensionValue(value[key]),
        })
      }
      // 属性写法（如 <fs:node note="...">）会落在 $attrs 里。
      for (const key of Object.keys(value.$attrs || {})) {
        if (KNOWN_FS_NODE_PROPERTIES.has(key)) continue
        extensions.push({
          type: key === 'note' ? 'fs:Note' : `fs:Node.${key}`,
          name: key,
          value: value.$attrs[key],
        })
      }
      // fs:legacy 是「0.13 无对应概念的旧字段」的无损留档，解析时还原成对象。
      if (value.legacy) {
        let parsed = value.legacy.json
        if (typeof parsed === 'string') {
          try {
            parsed = JSON.parse(parsed)
          } catch {
            // 保持原文；调用方仍能从 extensions 里看到字符串。
          }
        }
        extensions.push({ type: 'fs:Legacy', name: 'legacy', value: parsed })
      }
      continue
    }
    if (type.startsWith('fs:')) {
      if (type === 'fs:Legacy') {
        let parsed = value.json
        if (typeof parsed === 'string') {
          try {
            parsed = JSON.parse(parsed)
          } catch {
            // 保持原文。
          }
        }
        extensions.push({ type, name: 'legacy', value: parsed })
        continue
      }
      extensions.push({
        type,
        name: localExtensionName(type),
        value: plainExtensionValue(value),
      })
    }
  }

  // 也接受属性写法（例如有人在 sequenceFlow 上直接写 fs:maxRounds="2"）；
  // moddle 会把未知属性留在 $attrs 里并发一条 warning。
  const attributes = element?.$attrs
  if (attributes && typeof attributes === 'object') {
    for (const key of Object.keys(attributes)) {
      if (!key.startsWith('fs:')) continue
      const local = key.slice('fs:'.length)
      if (local === '') continue
      const type = `fs:${local.charAt(0).toUpperCase()}${local.slice(1)}`
      const raw = attributes[key]
      const narrowed = NUMERIC_EXTENSION_ATTRIBUTES.has(local)
        && typeof raw === 'string'
        && /^-?\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : raw
      extensions.push({ type, name: local, value: narrowed })
    }
  }
  return extensions
}

/** `zeebe:ioMapping` → `{ input: [{ source, target }], output: [...] }`；无则 null。 */
function readIoMapping(element) {
  const ioMapping = extensionValues(element).find(value => value?.$type === 'zeebe:IoMapping')
  if (!ioMapping) return null
  const parameters = value => toArray(value).map(item => ({
    source: stringOrNull(item?.source),
    target: stringOrNull(item?.target),
  }))
  return {
    input: parameters(ioMapping.inputParameters),
    output: parameters(ioMapping.outputParameters),
  }
}

function buildTeam(fsNode) {
  const team = fsNode?.team
  if (!team) return null
  const members = toArray(team.member).map((member, index) => ({
    id: stringOrNull(member?.id) || `member_${index + 1}`,
    role: stringOrNull(member?.role),
    prompt: stringOrNull(member?.prompt),
    skills: listValue(member?.skills),
  }))
  const rawMode = stringOrNull(team.mode)?.toLowerCase()
  let mode
  if (rawMode === 'none') mode = 'none'
  else if (rawMode === 'fanout') mode = 'fanout'
  else mode = members.length > 0 ? 'fanout' : 'none'
  return { mode, members }
}

function buildHttp(fsNode, elementId, warnings) {
  const http = fsNode?.http
  if (!http) {
    warnings.push({
      code: 'HTTP_CONFIG_MISSING',
      elementId,
      message: 'serviceTask 声明了 nodeType="http"，但没有 fs:http 配置。',
    })
    return null
  }
  let headers = {}
  const rawHeaders = http.headers
  if (typeof rawHeaders === 'string' && rawHeaders.trim() !== '') {
    try {
      const parsed = JSON.parse(rawHeaders)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        headers = parsed
      } else {
        warnings.push({
          code: 'HTTP_HEADERS_INVALID',
          elementId,
          message: 'fs:http@headers 必须是 JSON 对象，已按空对象处理。',
        })
      }
    } catch {
      warnings.push({
        code: 'HTTP_HEADERS_INVALID',
        elementId,
        message: 'fs:http@headers 不是合法 JSON，已按空对象处理。',
      })
    }
  } else if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
    headers = { ...rawHeaders }
  }
  return {
    method: stringOrNull(http.method),
    url: stringOrNull(http.url),
    headers,
    timeoutMs: integerOrNull(http.timeoutMs),
    retries: integerOrNull(http.retries),
    body: stringOrNull(http.body),
    inputMapping: stringOrNull(http.inputMapping),
    outputMapping: stringOrNull(http.outputMapping),
  }
}

/** 读取 `<fs:executor>`；env 用 JSON 属性，解析失败时保留 warning。 */
function buildExecutor(fsNode, elementId, warnings) {
  const executor = fsNode?.executor
  if (!executor) return null

  let env = null
  const rawEnv = executor.env
  if (typeof rawEnv === 'string' && rawEnv.trim() !== '') {
    try {
      const parsed = JSON.parse(rawEnv)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        env = parsed
      } else {
        warnings.push({
          code: 'EXECUTOR_ENV_INVALID',
          elementId,
          message: 'fs:executor@env 必须是 JSON 对象，已按 null 处理。',
        })
      }
    } catch {
      warnings.push({
        code: 'EXECUTOR_ENV_INVALID',
        elementId,
        message: 'fs:executor@env 不是合法 JSON，已按 null 处理。',
      })
    }
  } else if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
    env = { ...rawEnv }
  }

  const kind = stringOrNull(executor.kind) || 'dsh'
  if (kind !== 'dsh' && kind !== 'codex' && kind !== 'custom') {
    warnings.push({
      code: 'EXECUTOR_KIND_INVALID',
      elementId,
      message: `fs:executor@kind 不是 dsh/codex/custom：${JSON.stringify(kind)}（原样保留）。`,
    })
  }

  return {
    kind,
    command: stringOrNull(executor.command),
    cwd: stringOrNull(executor.cwd),
    env,
    timeoutMs: integerOrNull(executor.timeoutMs),
    schemaPath: stringOrNull(executor.schemaPath),
  }
}

/** 读取重复的 `<fs:output>`：字符串与 {name,kind,required} 都保持原形状。 */
function buildOutputs(fsNode, elementId, warnings) {
  const outputs = []
  for (const item of toArray(fsNode?.output)) {
    if (!item) continue

    const jsonText = typeof item.json === 'string' ? item.json.trim() : ''
    if (jsonText !== '') {
      try {
        outputs.push(JSON.parse(jsonText))
        continue
      } catch {
        warnings.push({
          code: 'OUTPUT_JSON_INVALID',
          elementId,
          message: 'fs:output@json 不是合法 JSON，已回退到属性/文本。',
        })
      }
    }

    const object = {}
    let hasAttributes = false
    if (typeof item.name === 'string') {
      object.name = item.name
      hasAttributes = true
    }
    if (typeof item.kind === 'string') {
      object.kind = item.kind
      hasAttributes = true
    }
    if (typeof item.required === 'boolean') {
      object.required = item.required
      hasAttributes = true
    }
    if (hasAttributes) {
      outputs.push(object)
      continue
    }

    if (typeof item.text === 'string' && item.text.trim() !== '') {
      outputs.push(item.text)
    }
  }
  return outputs
}

/** 读取 `<fs:check>`：JSON 原样搬运，不做语义改写。 */
function buildCheck(fsNode, elementId, warnings) {
  const check = fsNode?.check
  if (!check) return null
  const text = typeof check.json === 'string' ? check.json : (typeof check.text === 'string' ? check.text : '')
  if (text.trim() === '') return null
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    warnings.push({
      code: 'CHECK_NOT_OBJECT',
      elementId,
      message: 'fs:check 的 JSON 不是对象，已按 null 处理。',
    })
    return null
  } catch {
    warnings.push({
      code: 'CHECK_JSON_INVALID',
      elementId,
      message: 'fs:check 不是合法 JSON，已按 null 处理。',
    })
    return null
  }
}

/** 契约里的 node 结构（agent / human / http 共用）。 */
function buildNode(kind, fsNode, elementId, warnings) {
  return {
    kind,
    provider: stringOrNull(fsNode?.provider),
    adapter: stringOrNull(fsNode?.adapter),
    skills: listValue(fsNode?.skills),
    hooks: listValue(fsNode?.hooks),
    prompt: stringOrNull(fsNode?.prompt),
    roleCard: stringOrNull(fsNode?.roleCard),
    team: buildTeam(fsNode),
    http: kind === 'http' ? buildHttp(fsNode, elementId, warnings) : null,
    model: stringOrNull(fsNode?.model),
    agentPreset: stringOrNull(fsNode?.agentPreset),
    executor: buildExecutor(fsNode, elementId, warnings),
    outputs: buildOutputs(fsNode, elementId, warnings),
    check: buildCheck(fsNode, elementId, warnings),
  }
}

function kindOf(type) {
  if (type === 'bpmn:StartEvent') return 'start'
  if (type === 'bpmn:EndEvent') return 'end'
  if (type === 'bpmn:UserTask') return 'human'
  if (GATEWAY_TYPES.has(type)) return 'gateway'
  return 'unknown'
}

/**
 * 读取并校验一条 sequenceFlow 的条件表达式。
 *
 * 策略（0.13.0 硬约束）：
 * - 有 language 且不是 FEEL → 错误（javascript 不是沙箱）；
 * - 没有 language、也没有 `=` 前缀 → 错误（bpmn-engine 会把它当属性路径，恒真/恒假）；
 * - 没有 language 但有 `=` 前缀 → 按 FEEL 接受（Camunda 8 风格）；
 * - 再交给 `assertFeelSafe` 做可疑内容检查。
 *
 * **运行时前提**：条件求值必须由 `src/bpmn-expr.js` 的 `evaluateFeel()` 负责，
 * **不能交给 bpmn-engine 内置表达式引擎**——它会把 `= x` 当属性路径解析，导致
 * 条件静默恒真/恒假（研究实测，0.13 红线）。
 *
 * @returns {null | { expression: string, language: 'feel' }}
 */
function readCondition(flow, errors) {
  const condition = flow.conditionExpression
  if (!condition) return null
  const body = typeof condition.body === 'string' ? condition.body.trim() : ''
  const rawLanguage = typeof condition.language === 'string' ? condition.language.trim() : ''

  if (body === '') {
    errors.push({
      code: 'CONDITION_EMPTY',
      flowId: flow.id || null,
      message: 'conditionExpression 是空的：要么删掉它，要么写成带 `=` 前缀的 FEEL 表达式。',
    })
    return null
  }

  if (rawLanguage !== '') {
    if (!isFeelLanguage(rawLanguage)) {
      errors.push({
        code: 'CONDITION_LANGUAGE_NOT_FEEL',
        flowId: flow.id || null,
        message: `条件表达式只允许 FEEL，当前 language=${JSON.stringify(rawLanguage)}；javascript 会走 node:vm，不是沙箱。`,
        detail: { language: rawLanguage, expression: body },
      })
      return null
    }
  } else if (!body.startsWith('=')) {
    errors.push({
      code: 'CONDITION_BARE_EXPRESSION',
      flowId: flow.id || null,
      message: '裸条件表达式被拒绝：既没有 language="feel"，也没有 `=` 前缀；bpmn-engine 会把它当属性路径（恒真/恒假）。',
      detail: { expression: body },
    })
    return null
  }

  const safe = assertFeelSafe({ expression: body, language: 'feel' })
  if (!safe.ok) {
    errors.push({
      code: 'CONDITION_UNSAFE',
      flowId: flow.id || null,
      message: `条件表达式未通过安全策略：${safe.error.message}`,
      detail: safe.error,
    })
    return null
  }

  return { expression: body, language: 'feel' }
}

/** 从若干起点 BFS。 */
function reachableFrom(startIds, adjacency) {
  const seen = new Set()
  const queue = [...startIds]
  let cursor = 0
  while (cursor < queue.length) {
    const id = queue[cursor]
    cursor += 1
    if (seen.has(id)) continue
    seen.add(id)
    for (const next of adjacency.get(id) || []) {
      if (!seen.has(next)) queue.push(next)
    }
  }
  return seen
}

/** 迭代 DFS 找任一有向环；返回环上的一条边 `[from, to]` 或 null。 */
function findCycle(nodeIds, adjacency) {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map()
  for (const id of nodeIds) color.set(id, WHITE)

  for (const root of nodeIds) {
    if (color.get(root) !== WHITE) continue
    const stack = [{ id: root, index: 0 }]
    color.set(root, GRAY)
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      const outgoing = adjacency.get(top.id) || []
      if (top.index >= outgoing.length) {
        color.set(top.id, BLACK)
        stack.pop()
        continue
      }
      const next = outgoing[top.index]
      top.index += 1
      if (!color.has(next)) continue
      const nextColor = color.get(next)
      if (nextColor === GRAY) return [top.id, next]
      if (nextColor === WHITE) {
        color.set(next, GRAY)
        stack.push({ id: next, index: 0 })
      }
    }
  }
  return null
}

/**
 * 解析并校验一份 BPMN 2.0 XML。
 *
 * @param {string} xml
 * @param {{ moddle?: BpmnModdle }} [options] `moddle` 可复用已创建的实例（性能）；
 *   不传则每次新建。
 * @returns {Promise<{ ok: boolean, definition: ({ hash: string } & object) | null, errors: Array<object>, warnings: Array<object> }>}
 */
export async function parseBpmn(xml, options = {}) {
  const errors = []
  const warnings = []

  try {
    if (typeof xml !== 'string' || xml.trim() === '') {
      errors.push({ code: 'BPMN_XML_EMPTY', message: 'BPMN XML 必须是非空字符串。' })
      return { ok: false, definition: null, errors, warnings }
    }

    const moddle = options && typeof options.moddle === 'object' && options.moddle
      ? options.moddle
      : createBpmnModdle()

    let parsed
    try {
      parsed = await moddle.fromXML(xml)
    } catch (error) {
      for (const warning of toArray(error?.warnings)) {
        warnings.push({
          code: 'MODDLE_WARNING',
          message: typeof warning?.message === 'string' ? warning.message : String(warning),
        })
      }
      errors.push({
        code: 'BPMN_PARSE_ERROR',
        message: `BPMN XML 解析失败：${error?.message || String(error)}`,
      })
      return { ok: false, definition: null, errors, warnings }
    }

    for (const warning of toArray(parsed?.warnings)) {
      warnings.push({
        code: 'MODDLE_WARNING',
        message: typeof warning?.message === 'string' ? warning.message : String(warning),
      })
    }

    const definitions = parsed?.rootElement
    if (!definitions) {
      errors.push({ code: 'BPMN_NO_DEFINITIONS', message: 'XML 根元素不是 bpmn:definitions。' })
      return { ok: false, definition: null, errors, warnings }
    }

    const processes = toArray(definitions.rootElements)
      .filter(element => element?.$type === 'bpmn:Process')
    if (processes.length === 0) {
      errors.push({ code: 'BPMN_NO_PROCESS', message: 'bpmn:definitions 里没有 bpmn:process。' })
      return { ok: false, definition: null, errors, warnings }
    }
    if (processes.length > 1) {
      errors.push({
        code: 'BPMN_MULTIPLE_PROCESSES',
        message: `一个定义里只支持一个 bpmn:process，当前有 ${processes.length} 个；只解析第一个。`,
      })
    }
    const process = processes[0]

    // 执行白名单必须查**原始 moddle 结构**：下面的归一化会丢掉不认识/不支持的
    // 元素（scriptTask、子流程、事件定义…），等归一化之后再查就晚了。
    for (const violation of collectRawExecutionViolations(process)) {
      errors.push(violation)
    }

    const definition = {
      id: typeof process.id === 'string' ? process.id : '',
      name: stringOrNull(process.name),
      // 模板域据此做不可变校验：对 XML 原文（含空白/命名空间）做 sha256，小写 hex。
      hash: createHash('sha256').update(xml, 'utf8').digest('hex'),
      startId: null,
      endIds: [],
      elements: [],
      flows: [],
      warnings,
    }
    if (definition.id === '') {
      warnings.push({ code: 'PROCESS_WITHOUT_ID', message: 'bpmn:process 没有 id；归一化模型的 definition.id 为空字符串。' })
    }

    const flowElements = toArray(process.flowElements)
    let autoElementCounter = 0

    for (const flowElement of flowElements) {
      const type = typeof flowElement?.$type === 'string' ? flowElement.$type : ''
      if (type === 'bpmn:SequenceFlow' || !FLOW_NODE_TYPES.has(type)) continue

      let id = typeof flowElement.id === 'string' && flowElement.id !== '' ? flowElement.id : ''
      if (id === '') {
        autoElementCounter += 1
        id = `__auto_element_${autoElementCounter}`
        warnings.push({
          code: 'ELEMENT_WITHOUT_ID',
          elementId: id,
          message: `BPMN 节点缺少 id，已临时命名为 ${id}（flow 无法引用它）。`,
        })
      }

      const element = {
        id,
        type: localTypeName(type),
        name: stringOrNull(flowElement.name),
        kind: kindOf(type),
        node: null,
        ioMapping: readIoMapping(flowElement),
        extensions: collectExtensions(flowElement),
      }

      const fsNode = extensionValues(flowElement).find(value => value?.$type === 'fs:Node')

      if (type === 'bpmn:ServiceTask') {
        if (!fsNode) {
          errors.push({
            code: 'SERVICE_TASK_WITHOUT_FS_NODE',
            elementId: id,
            message: `serviceTask ${id} 必须有 fs:node 扩展（nodeType 只能是 agent 或 http）。`,
          })
        } else {
          const nodeType = stringOrNull(fsNode.nodeType)?.toLowerCase()
          if (nodeType !== 'agent' && nodeType !== 'http') {
            errors.push({
              code: 'SERVICE_TASK_NODE_TYPE_INVALID',
              elementId: id,
              message: `serviceTask ${id} 的 fs:node@nodeType 必须是 agent 或 http，当前是 ${JSON.stringify(fsNode.nodeType ?? null)}。`,
            })
          } else {
            element.kind = nodeType
            element.node = buildNode(nodeType, fsNode, id, warnings)
          }
        }
      } else if (type === 'bpmn:UserTask') {
        // 人工节点可以没有 fs:node：默认就是 kind='human'。
        element.kind = 'human'
        element.node = buildNode('human', fsNode || {}, id, warnings)
      }

      definition.elements.push(element)
    }

    const elementIds = new Set(definition.elements.map(element => element.id))
    const flowMap = new Map()
    let autoFlowCounter = 0

    for (const flowElement of flowElements) {
      if (flowElement?.$type !== 'bpmn:SequenceFlow') continue
      let flowId = typeof flowElement.id === 'string' && flowElement.id !== '' ? flowElement.id : ''
      if (flowId === '') {
        autoFlowCounter += 1
        flowId = `__auto_flow_${autoFlowCounter}`
        warnings.push({
          code: 'FLOW_WITHOUT_ID',
          flowId,
          message: 'sequenceFlow 缺少 id，已临时命名。',
        })
      }

      const from = referenceId(flowElement.sourceRef)
      const to = referenceId(flowElement.targetRef)
      if (from === null || to === null) {
        errors.push({
          code: 'FLOW_UNKNOWN_REFERENCE',
          flowId,
          message: `sequenceFlow ${flowId} 的 sourceRef/targetRef 不完整（from=${JSON.stringify(from)}，to=${JSON.stringify(to)}）。`,
          detail: { from, to },
        })
      } else if (!elementIds.has(from) || !elementIds.has(to)) {
        errors.push({
          code: 'FLOW_UNKNOWN_REFERENCE',
          flowId,
          message: `sequenceFlow ${flowId} 指向不存在的节点（from=${from}，to=${to}）。`,
          detail: { from, to },
        })
      }

      const flow = {
        id: flowId,
        from,
        to,
        condition: readCondition(flowElement, errors),
        isDefault: false,
        extensions: collectExtensions(flowElement),
      }
      definition.flows.push(flow)
      flowMap.set(flowId, flow)
    }

    // BPMN 的 default 是「源节点上的一个属性引用」，不是 flow 上的布尔位。
    const defaultFlowIds = new Set()
    for (const flowElement of flowElements) {
      if (!FLOW_NODE_TYPES.has(flowElement?.$type)) continue
      const defaultId = referenceId(flowElement.default)
      if (defaultId && flowMap.has(defaultId)) defaultFlowIds.add(defaultId)
    }
    for (const flow of definition.flows) {
      if (!defaultFlowIds.has(flow.id)) continue
      flow.isDefault = true
      if (flow.condition) {
        warnings.push({
          code: 'DEFAULT_FLOW_WITH_CONDITION',
          flowId: flow.id,
          message: `默认流 ${flow.id} 同时带了条件；BPMN 会忽略默认流上的条件，建议删掉条件。`,
        })
      }
    }

    // 1. 恰好一个 startEvent、至少一个 endEvent。
    const starts = definition.elements.filter(element => element.type === 'startEvent')
    const ends = definition.elements.filter(element => element.type === 'endEvent')
    if (starts.length === 0) {
      errors.push({ code: 'NO_START_EVENT', message: '流程必须恰好有一个 startEvent，当前没有。' })
    } else if (starts.length > 1) {
      errors.push({
        code: 'MULTIPLE_START_EVENTS',
        message: `流程必须恰好有一个 startEvent，当前有 ${starts.length} 个。`,
        detail: { startIds: starts.map(element => element.id) },
      })
    } else {
      definition.startId = starts[0].id
    }
    definition.endIds = ends.map(element => element.id)
    if (ends.length === 0) {
      errors.push({ code: 'NO_END_EVENT', message: '流程至少要有一个 endEvent。' })
    }

    // 4. 可达性 + 出边。
    const adjacency = new Map([...elementIds].map(id => [id, []]))
    for (const flow of definition.flows) {
      if (elementIds.has(flow.from) && elementIds.has(flow.to)) {
        adjacency.get(flow.from).push(flow.to)
      }
    }

    // startEvent 不唯一时「从 start 可达」没有定义，只报 start 本身的错误，避免刷屏。
    if (starts.length === 1) {
      const reachable = reachableFrom([starts[0].id], adjacency)
      for (const element of definition.elements) {
        if (element.type === 'startEvent') continue
        if (!reachable.has(element.id)) {
          errors.push({
            code: 'UNREACHABLE_NODE',
            elementId: element.id,
            message: `节点 ${element.id}（${element.name || element.type}）从 startEvent 不可达。`,
          })
        }
      }
    }

    const outgoingCount = new Map([...elementIds].map(id => [id, 0]))
    for (const flow of definition.flows) {
      if (outgoingCount.has(flow.from)) outgoingCount.set(flow.from, outgoingCount.get(flow.from) + 1)
    }
    for (const element of definition.elements) {
      if (element.type === 'endEvent') continue
      if ((outgoingCount.get(element.id) || 0) === 0) {
        errors.push({
          code: 'NODE_WITHOUT_OUTGOING',
          elementId: element.id,
          message: `节点 ${element.id}（${element.name || element.type}）没有出边；除 endEvent 外每个节点都必须有出边。`,
        })
      }
    }

    // 允许成环（回退边），但要在 warnings 里提示。
    const cycle = findCycle([...elementIds], adjacency)
    if (cycle) {
      warnings.push({
        code: 'RETURN_LOOP',
        elementId: cycle[0],
        message: `存在回退环（${cycle[0]} → ${cycle[1]}）；0.13 允许回退边，但引擎需按环处理重跑与上限。`,
        detail: { from: cycle[0], to: cycle[1] },
      })
    }


    return { ok: errors.length === 0, definition, errors, warnings }
  } catch (error) {
    errors.push({
      code: 'BPMN_PARSE_ERROR',
      message: `BPMN 解析未预期的失败：${error?.message || String(error)}`,
    })
    return { ok: false, definition: null, errors, warnings }
  }
}
