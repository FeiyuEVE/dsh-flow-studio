/**
 * 旧流程 JSON（`flows/<id>.json`）→ BPMN 2.0 XML 转换器。
 *
 * 迁移口径（0.13 计划 §0.2 / 交付说明）：
 * - `kind='start'` → `bpmn:startEvent`；`kind='end'` → `bpmn:endEvent`；
 * - 其余节点 → `bpmn:serviceTask` + `fs:node nodeType="agent"`；
 * - `next` 边 → 普通 `bpmn:sequenceFlow`。分支节点**不插 exclusiveGateway**，直接
 *   用条件流；老语义「默认走第一条 next」→ 给第一条设 BPMN `default` 属性，
 *   其余**不自动编条件**，只写 warning 提醒人工补；
 * - 旧模板的 `reject` 边 → 反向 `bpmn:sequenceFlow` + 普通 FEEL 条件：
 *   单条 `= verdict = "reject"`；同一节点多条时写成互斥条件，默认目标按老引擎
 *   `leftmost`（目标列最靠前的 x/y/id）选择，其余目标靠输出里的 `rejectTarget`
 *   选中。引擎没有「打回」概念，这只是旧模板输出契约的忠实迁移；
 *   连线上的 `<fs:maxRounds>` 只表示「这条连线最多被走 N 次（通用上限）」；
 * - 生成 `bpmndi:BPMNDiagram` / `BPMNPlane` / `BPMNShape` / `BPMNEdge`，用分层网格
 *   坐标，保证 bpmn.io 打开就有图、节点不重叠。
 *
 * 输出 XML 必须能被 `src/bpmn-parse.js` 的 `parseBpmn()` 重新解析通过（round-trip）。
 *
 * @module @feiyueve/dsh-flow-studio/bpmn-convert
 */

import { EDGE_KIND, NODE_KIND, normalizeFlow } from './model.js'

const BPMN_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL'
const BPMNDI_NS = 'http://www.omg.org/spec/BPMN/20100524/DI'
const DC_NS = 'http://www.omg.org/spec/DD/20100524/DC'
const DI_NS = 'http://www.omg.org/spec/DD/20100524/DI'
const FS_NS = 'http://feiyueve.dev/schema/bpmn/fs/1.0'
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance'
const TARGET_NS = 'http://feiyueve.dev/flow-studio/bpmn'

/** 布局网格（像素）。与画布无关，只是让 DI 有可读的坐标。 */
const CELL_W = 160
const CELL_H = 80
const GAP_X = 120
const GAP_Y = 80
const MARGIN_X = 80
const MARGIN_Y = 80
const EVENT_SIZE = 36
const DETOUR_GAP = 50

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

function stripInvalidXmlChars(value) {
  // XML 1.0 不允许的 C0 控制字符（保留 tab / LF / CR）；emoji 等代理对不受影响。
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

function escapeAttribute(value) {
  return stripInvalidXmlChars(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[char]))
}

function escapeText(value) {
  return stripInvalidXmlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 取第一个非空字符串。 */
function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 字符串 / 数组 → 去重后的逗号分隔属性值。 */
function listValue(value) {
  if (Array.isArray(value)) {
    return [...new Set(value
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean))].join(',')
  }
  if (typeof value === 'string') return value.trim()
  return ''
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function integerOrNull(value) {
  if (Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

/** 老节点已知字段（与 src/model.js 的 normalizeFlow 白名单同口径）。 */
const LEGACY_NODE_KEYS = new Set([
  'id', 'kind', 'title', 'x', 'y', 'mode', 'role', 'task',
  'skills', 'outputs', 'maxRounds', 'model', 'agentPreset', 'team',
  'executor', 'executorCommand', 'check', 'extras',
])

/** 老 outputs 可能是字符串（当前 model）或数组（早期/手写）；统一成列表。 */
function normalizeOutputs(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (isPlainObject(value)) return [value]
  return []
}

function safeJson(value) {
  try {
    const json = JSON.stringify(value)
    return typeof json === 'string' ? json : null
  } catch {
    return null
  }
}

/**
 * XML ID（NCName）清洗：合法就原样保留，不合法替换成安全字符并保证文档内唯一。
 * 返回清洗后的 id；发生改写时记一条 warning，迁移后能追。
 */
function makeXmlId(raw, fallbackPrefix, used, addWarning, detail = {}) {
  const original = typeof raw === 'string' ? raw.trim() : ''
  let id = original
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id)) {
    const body = original.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[^A-Za-z_]+/, '')
    id = `${fallbackPrefix}_${body || 'id'}`
    if (!/^[A-Za-z_]/.test(id)) id = `${fallbackPrefix}_${id}`
    addWarning({
      code: 'ID_SANITIZED',
      message: `id「${original}」不是合法 XML ID，已改为「${id}」。`,
      ...detail,
    })
  }
  let candidate = id
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${id}_${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

/* -------------------------------------------------------------------------- */
/* 结构检查                                                                    */
/* -------------------------------------------------------------------------- */

function fail(errors, warnings) {
  return { ok: false, xml: '', warnings, errors }
}

function checkLegacyStructure(flow, rawEdges, warnings, errors) {
  const nodes = flow.nodes
  const edges = flow.edges
  const byId = new Map(nodes.map(node => [node.id, node]))

  if (nodes.length === 0) {
    errors.push({ code: 'LEGACY_EMPTY', message: '旧流程没有节点，无法迁移。' })
    return
  }

  if (Array.isArray(rawEdges) && rawEdges.length > edges.length) {
    warnings.push({
      code: 'EDGES_DROPPED',
      message: `旧流程声明了 ${rawEdges.length} 条连线，归一化后剩 ${edges.length} 条；端点缺失/自环/重复的连线已丢弃。`,
    })
  }

  const starts = nodes.filter(node => node.kind === NODE_KIND.START)
  const ends = nodes.filter(node => node.kind === NODE_KIND.END)
  if (starts.length !== 1) {
    errors.push({
      code: 'LEGACY_START_INVALID',
      message: `旧流程必须恰好有一个 start 节点，当前有 ${starts.length} 个。`,
    })
  }
  if (ends.length === 0) {
    errors.push({ code: 'LEGACY_END_MISSING', message: '旧流程至少要有一个 end 节点。' })
  }

  // 从 start 沿 next 边 BFS：不可达节点迁移过去也会被 parseBpmn 判成 UNREACHABLE_NODE。
  if (starts.length === 1) {
    const nextOut = new Map(nodes.map(node => [node.id, []]))
    for (const edge of edges) {
      if (edge.kind !== EDGE_KIND.NEXT) continue
      if (!nextOut.has(edge.from) || !byId.has(edge.to)) continue
      nextOut.get(edge.from).push(edge.to)
    }
    const reachable = new Set()
    const queue = [starts[0].id]
    let cursor = 0
    while (cursor < queue.length) {
      const id = queue[cursor]
      cursor += 1
      if (reachable.has(id)) continue
      reachable.add(id)
      for (const next of nextOut.get(id) || []) {
        if (!reachable.has(next)) queue.push(next)
      }
    }
    for (const node of nodes) {
      if (reachable.has(node.id)) continue
      errors.push({
        code: 'LEGACY_UNREACHABLE',
        nodeId: node.id,
        message: `节点「${node.title || node.id}」从 start 沿 next 边不可达，无法生成合法的 BPMN。`,
      })
    }
  }

  // parseBpmn 要求除 endEvent 外每个节点都有出边；迁移前先检查，避免生成打不开的 XML。
  const outgoing = new Map(nodes.map(node => [node.id, 0]))
  for (const edge of edges) {
    if (outgoing.has(edge.from)) outgoing.set(edge.from, outgoing.get(edge.from) + 1)
  }
  for (const node of nodes) {
    if (node.kind === NODE_KIND.END) continue
    if ((outgoing.get(node.id) || 0) === 0) {
      errors.push({
        code: 'LEGACY_NODE_WITHOUT_OUTGOING',
        nodeId: node.id,
        message: `节点「${node.title || node.id}」没有出边；BPMN 里除 endEvent 外每个节点都必须有出边。`,
      })
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 布局与 DI                                                                   */
/* -------------------------------------------------------------------------- */

/** 按 next 边从 start 做 BFS 分层；不可达节点兜底放到最后一层（结构检查已拦）。 */
function computeLayers(nodes, edges, startId) {
  const nextOut = new Map(nodes.map(node => [node.id, []]))
  for (const edge of edges) {
    if (edge.kind !== EDGE_KIND.NEXT) continue
    if (!nextOut.has(edge.from)) continue
    nextOut.get(edge.from).push(edge.to)
  }

  const layers = new Map()
  if (startId) {
    const queue = [startId]
    let cursor = 0
    layers.set(startId, 0)
    while (cursor < queue.length) {
      const id = queue[cursor]
      cursor += 1
      const layer = layers.get(id)
      for (const next of nextOut.get(id) || []) {
        if (layers.has(next)) continue
        layers.set(next, layer + 1)
        queue.push(next)
      }
    }
  }

  let maxLayer = 0
  for (const layer of layers.values()) if (layer > maxLayer) maxLayer = layer
  for (const node of nodes) {
    if (!layers.has(node.id)) layers.set(node.id, maxLayer + 1)
  }
  return layers
}

/** 每个节点在网格里的形状（含中心点，连线锚点用）。 */
function layoutNodes(nodes, layers) {
  const byLayer = new Map()
  for (const node of nodes) {
    const layer = layers.get(node.id) ?? 0
    if (!byLayer.has(layer)) byLayer.set(layer, [])
    byLayer.get(layer).push(node)
  }

  const positions = new Map()
  const orderedLayers = [...byLayer.keys()].sort((a, b) => a - b)
  for (const layer of orderedLayers) {
    const list = byLayer.get(layer)
    list.forEach((node, row) => {
      const isEvent = node.kind === NODE_KIND.START || node.kind === NODE_KIND.END
      const width = isEvent ? EVENT_SIZE : CELL_W
      const height = isEvent ? EVENT_SIZE : CELL_H
      const cellX = MARGIN_X + layer * (CELL_W + GAP_X)
      const cellY = MARGIN_Y + row * (CELL_H + GAP_Y)
      const x = cellX + (CELL_W - width) / 2
      const y = cellY + (CELL_H - height) / 2
      positions.set(node.id, {
        x,
        y,
        width,
        height,
        cx: x + width / 2,
        cy: y + height / 2,
      })
    })
  }
  return positions
}

/** 连线折点：正向直连；同一列上下直接连；同层/回退走节点下方绕行，避免穿过节点。 */
function edgeWaypoints(from, to) {
  if (!from || !to) return []
  if (to.cx > from.cx + 1) {
    return [
      { x: from.x + from.width, y: from.cy },
      { x: to.x, y: to.cy },
    ]
  }
  // 同一列：目标在下方就直接从底边连到顶边，避免生成「先绕下去再折回来」的怪线。
  if (Math.abs(to.cx - from.cx) <= 1) {
    if (to.y >= from.y + from.height) {
      return [
        { x: from.cx, y: from.y + from.height },
        { x: to.cx, y: to.y },
      ]
    }
    if (to.y + to.height <= from.y) {
      return [
        { x: from.cx, y: from.y },
        { x: to.cx, y: to.y + to.height },
      ]
    }
  }
  const routeY = Math.max(from.y + from.height, to.y + to.height) + DETOUR_GAP
  return [
    { x: from.cx, y: from.y + from.height },
    { x: from.cx, y: routeY },
    { x: to.cx, y: routeY },
    { x: to.cx, y: to.y + to.height },
  ]
}

function round(value) {
  return Math.round(value)
}

/* -------------------------------------------------------------------------- */
/* 旧模板回退条件                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 与 `src/engine.js` 的 `leftmost()` 完全一致：
 * 目标列最靠前 = x 最小；同列按 y、再按 id（localeCompare），保证确定性。
 */
function compareNodePosition(a, b) {
  const ax = Number.isFinite(a.x) ? a.x : Number.MAX_SAFE_INTEGER
  const bx = Number.isFinite(b.x) ? b.x : Number.MAX_SAFE_INTEGER
  if (ax !== bx) return ax - bx
  const ay = Number.isFinite(a.y) ? a.y : Number.MAX_SAFE_INTEGER
  const by = Number.isFinite(b.y) ? b.y : Number.MAX_SAFE_INTEGER
  if (ay !== by) return ay - by
  return String(a.id).localeCompare(String(b.id))
}

function leftmostNode(nodes) {
  return [...nodes].sort(compareNodePosition)[0] || null
}

/**
 * 旧模板的 `reject` 边只是「带条件的普通连线」，引擎不认打回概念。
 * 条件忠实迁移旧输出契约：节点结构化输出 `verdict === 'reject'` 才走回退；
 * 同一节点多条回退边时，老引擎按 `leftmost` 选默认目标，其余靠 `rejectTarget`
 * 选中，因此必须写成互斥条件（BPMN 对同活动多条为真的出向流会全部 take）。
 *
 * 返回值按边对象索引（不按 id，避免旧数据里重复 id 互相覆盖）。
 */
function buildRejectPlans(nodes, edges, nodeIds) {
  const plans = new Map()
  const nodeById = new Map(nodes.map(node => [node.id, node]))

  for (const node of nodes) {
    const rejectEdges = edges.filter(edge => edge.from === node.id && edge.kind === EDGE_KIND.REJECT)
    if (rejectEdges.length === 0) continue

    const candidates = rejectEdges.map(edge => nodeById.get(edge.to)).filter(Boolean)
    const leftmost = leftmostNode(candidates)

    for (const edge of rejectEdges) {
      const target = nodeById.get(edge.to)
      const targetId = nodeIds.get(edge.to) || edge.to
      let expression
      if (rejectEdges.length === 1) {
        expression = '= verdict = "reject"'
      } else if (leftmost && target && leftmost.id === target.id) {
        // 老引擎缺省选最左目标；rejectTarget 为空时落在这里。
        expression = `= verdict = "reject" and (rejectTarget = null or rejectTarget = "${targetId}")`
      } else {
        expression = `= verdict = "reject" and rejectTarget = "${targetId}"`
      }
      plans.set(edge, {
        expression,
        total: rejectEdges.length,
        targetId,
        targetTitle: target?.title || edge.to,
        leftmostTargetId: leftmost ? (nodeIds.get(leftmost.id) || leftmost.id) : null,
        leftmostTitle: leftmost?.title || leftmost?.id || null,
      })
    }
  }

  return plans
}

/* -------------------------------------------------------------------------- */
/* XML 片段                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 读老节点的 executor 配置。cwd / env / timeoutMs / schemaPath 老 model 没有
 * 顶层字段，通常在 extras 里；同时兼容直接放在 raw node 上的写法。
 */
function readExecutorConfig(node, rawNode) {
  const extras = isPlainObject(node.extras) ? node.extras : {}
  const raw = isPlainObject(rawNode) ? rawNode : {}
  const pick = (...values) => {
    for (const value of values) {
      if (typeof value === 'string' && value !== '') return value
    }
    return ''
  }

  const envValue = extras.env ?? extras.executorEnv ?? raw.env ?? raw.executorEnv
  let env = null
  if (isPlainObject(envValue)) {
    env = envValue
  } else if (typeof envValue === 'string' && envValue.trim() !== '') {
    try {
      const parsed = JSON.parse(envValue)
      if (isPlainObject(parsed)) env = parsed
    } catch {
      // 原文仍会随 legacy.extras 留档；executor.env 只收对象。
    }
  }

  return {
    kind: pick(raw.executor, node.executor, 'dsh'),
    command: pick(raw.executorCommand, node.executorCommand),
    cwd: pick(extras.cwd, extras.executorCwd, raw.cwd, raw.executorCwd),
    env,
    timeoutMs: integerOrNull(extras.timeoutMs ?? extras.executorTimeoutMs ?? raw.timeoutMs ?? raw.executorTimeoutMs),
    schemaPath: pick(extras.schemaPath, extras.executorSchemaPath, raw.schemaPath, raw.executorSchemaPath),
  }
}

function executorXml(config, warnings, nodeId) {
  if (!config) return null
  const attributes = [`kind="${escapeAttribute(config.kind || 'dsh')}"`]
  if (config.command !== '') attributes.push(`command="${escapeAttribute(config.command)}"`)
  if (config.cwd !== '') attributes.push(`cwd="${escapeAttribute(config.cwd)}"`)
  if (config.env !== null) {
    const json = safeJson(config.env)
    if (json === null) {
      warnings.push({
        code: 'EXECUTOR_ENV_SERIALIZE_FAILED',
        nodeId,
        message: `节点「${nodeId}」的 executor.env 无法序列化，已跳过（原文仍在 fs:legacy 里）。`,
      })
    } else {
      attributes.push(`env="${escapeAttribute(json)}"`)
    }
  }
  if (config.timeoutMs !== null) attributes.push(`timeoutMs="${config.timeoutMs}"`)
  if (config.schemaPath !== '') attributes.push(`schemaPath="${escapeAttribute(config.schemaPath)}"`)
  return `        <fs:executor ${attributes.join(' ')} />`
}

/** 一个 output：字符串用文本；标准对象用属性；其余用 json 属性原样留档。 */
function outputXml(value, warnings, nodeId) {
  if (typeof value === 'string') {
    return `        <fs:output>${escapeText(value)}</fs:output>`
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    const standardKeys = keys.length > 0 && keys.every(key => ['name', 'kind', 'required'].includes(key))
    const standardTypes = standardKeys && keys.every(key => (
      key === 'required' ? typeof value[key] === 'boolean' : typeof value[key] === 'string'
    ))
    if (standardKeys && standardTypes) {
      const attributes = []
      if ('name' in value) attributes.push(`name="${escapeAttribute(value.name)}"`)
      if ('kind' in value) attributes.push(`kind="${escapeAttribute(value.kind)}"`)
      if ('required' in value) attributes.push(`required="${value.required ? 'true' : 'false'}"`)
      return `        <fs:output ${attributes.join(' ')} />`
    }
  }
  const json = safeJson(value)
  if (json === null) {
    warnings.push({
      code: 'OUTPUT_SERIALIZE_FAILED',
      nodeId,
      message: `节点「${nodeId}」有一个 output 无法序列化，已跳过。`,
    })
    return null
  }
  return `        <fs:output json="${escapeAttribute(json)}" />`
}

function checkXml(value, warnings, nodeId) {
  if (value === undefined || value === null) return null
  const json = safeJson(value)
  if (json === null) {
    warnings.push({
      code: 'CHECK_SERIALIZE_FAILED',
      nodeId,
      message: `节点「${nodeId}」的 check 无法序列化，已跳过（原文仍在 fs:legacy 里）。`,
    })
    return null
  }
  return `        <fs:check>${escapeText(json)}</fs:check>`
}

/** 0.13 没有对应概念的旧字段：x/y/mode/maxRounds + extras + 未知顶层字段。 */
function buildLegacy(node, rawNode, isEvent) {
  const legacy = {}
  const raw = isPlainObject(rawNode) ? rawNode : {}

  for (const key of Object.keys(raw)) {
    if (!LEGACY_NODE_KEYS.has(key)) legacy[key] = raw[key]
  }
  if (isPlainObject(node.extras) && Object.keys(node.extras).length > 0) {
    legacy.extras = node.extras
  }

  legacy.x = node.x
  legacy.y = node.y
  legacy.mode = node.mode
  legacy.maxRounds = node.maxRounds
  // team 的映射只覆盖 name/role/task/skills；原始 team 数组仍留档，避免成员 extras 丢失。
  if (raw.team !== undefined) legacy.team = raw.team
  // 老 outputs 若本来是字符串（当前 model.js 的形状），节点里会变成 [string]；
  // 原字符串也留档，调用方要精确恢复时不必猜。
  if (!isEvent && raw.outputs !== undefined && !Array.isArray(raw.outputs)) {
    legacy.outputs = raw.outputs
  }

  if (isEvent) {
    // start/end 没有 fs:node，把旧节点的全部配置类字段原样留档。
    legacy.task = node.task
    legacy.role = node.role
    legacy.skills = node.skills
    legacy.outputs = raw.outputs !== undefined ? raw.outputs : node.outputs
    legacy.model = raw.model !== undefined ? raw.model : node.model
    legacy.agentPreset = raw.agentPreset !== undefined ? raw.agentPreset : node.agentPreset
    legacy.executor = raw.executor !== undefined ? raw.executor : node.executor
    legacy.executorCommand = raw.executorCommand !== undefined ? raw.executorCommand : node.executorCommand
    legacy.check = raw.check !== undefined ? raw.check : node.check
  }

  return legacy
}

function legacyArchivedKeys(node, rawNode, isEvent) {
  const keys = []
  const raw = isPlainObject(rawNode) ? rawNode : {}
  for (const key of Object.keys(raw)) {
    if (!LEGACY_NODE_KEYS.has(key)) keys.push(key)
  }
  if (isPlainObject(node.extras) && Object.keys(node.extras).length > 0) keys.push('extras')
  if (isEvent) {
    for (const key of ['task', 'role', 'skills', 'outputs', 'model', 'agentPreset', 'executor', 'executorCommand', 'check']) {
      if (key === 'executor') {
        const kind = raw.executor !== undefined ? raw.executor : node.executor
        const command = raw.executorCommand !== undefined ? raw.executorCommand : node.executorCommand
        if (kind !== 'dsh' || (typeof command === 'string' && command !== '')) keys.push(key)
        continue
      }
      if (legacyHasValue(raw, node, key)) keys.push(key)
    }
  }
  return [...new Set(keys)]
}

function legacyHasValue(raw, node, key) {
  const value = raw[key] !== undefined ? raw[key] : node[key]
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value !== ''
  if (Array.isArray(value)) return value.length > 0
  if (isPlainObject(value)) return Object.keys(value).length > 0
  return true
}

function legacyXml(node, rawNode, isEvent, warnings) {
  const legacy = buildLegacy(node, rawNode, isEvent)
  const json = safeJson(legacy)
  if (json === null) {
    warnings.push({
      code: 'LEGACY_SERIALIZE_FAILED',
      nodeId: node.id,
      message: `节点「${node.title || node.id}」的 fs:legacy 无法序列化（可能是循环引用）。`,
    })
    return null
  }
  const archived = legacyArchivedKeys(node, rawNode, isEvent)
  if (archived.length > 0) {
    warnings.push({
      code: 'LEGACY_FIELDS_ARCHIVED',
      nodeId: node.id,
      message: `节点「${node.title || node.id}」的字段 ${archived.join(', ')} 在 0.13 没有直接对应位置，已原样写入 fs:legacy 留档（未丢失）。`,
    })
  }
  return `        <fs:legacy>${escapeText(json)}</fs:legacy>`
}

/** 旧节点 → `<fs:node>`。 */
function fsNodeXml(node, rawNode, warnings) {
  const extras = isPlainObject(node.extras) ? node.extras : {}
  const adapter = pickString(extras.adapter, node.executor, 'dsh')
  const provider = pickString(extras.provider)
  const skills = listValue(node.skills)
  const hooks = listValue(extras.hooks)
  const prompt = pickString(node.task)
  const roleCard = pickString(node.role)
  const raw = isPlainObject(rawNode) ? rawNode : {}
  const model = pickString(raw.model, node.model)
  const agentPreset = pickString(raw.agentPreset, node.agentPreset)

  const attributes = ['nodeType="agent"']
  if (provider !== '') attributes.push(`provider="${escapeAttribute(provider)}"`)
  if (adapter !== '') attributes.push(`adapter="${escapeAttribute(adapter)}"`)
  if (skills !== '') attributes.push(`skills="${escapeAttribute(skills)}"`)
  if (hooks !== '') attributes.push(`hooks="${escapeAttribute(hooks)}"`)
  if (model !== '') attributes.push(`model="${escapeAttribute(model)}"`)
  if (agentPreset !== '') attributes.push(`agentPreset="${escapeAttribute(agentPreset)}"`)

  const children = []
  if (prompt !== '') children.push(`        <fs:prompt>${escapeText(prompt)}</fs:prompt>`)
  if (roleCard !== '') children.push(`        <fs:roleCard>${escapeText(roleCard)}</fs:roleCard>`)

  const executorLine = executorXml(readExecutorConfig(node, raw), warnings, node.id)
  if (executorLine) children.push(executorLine)

  const outputs = normalizeOutputs(raw.outputs !== undefined ? raw.outputs : node.outputs)
  for (const output of outputs) {
    const line = outputXml(output, warnings, node.id)
    if (line) children.push(line)
  }

  const check = raw.check !== undefined ? raw.check : node.check
  const checkLine = checkXml(check, warnings, node.id)
  if (checkLine) children.push(checkLine)

  const legacyLine = legacyXml(node, raw, false, warnings)
  if (legacyLine) children.push(legacyLine)

  const members = Array.isArray(node.team) ? node.team : []
  if (members.length > 0) {
    if (node.mode !== 'team') {
      warnings.push({
        code: 'TEAM_MODE_INCONSISTENT',
        nodeId: node.id,
        message: `节点「${node.title || node.id}」配了 ${members.length} 个成员但 mode=${JSON.stringify(node.mode)}；迁移后按 fanout 处理。`,
      })
    }
    const usedMemberIds = new Set()
    const memberLines = []
    members.forEach((member, index) => {
      const rawName = pickString(member?.name)
      let memberId = rawName || `member_${index + 1}`
      // fs:member@id 只是字符串属性，保留旧成员名最利于人工核对；重名时加后缀。
      let unique = memberId
      let suffix = 2
      while (usedMemberIds.has(unique)) {
        unique = `${memberId}_${suffix}`
        suffix += 1
      }
      usedMemberIds.add(unique)
      memberId = unique

      const memberAttrs = [`id="${escapeAttribute(memberId)}"`]
      const memberRole = pickString(member?.role)
      const memberSkills = listValue(member?.extras?.skills)
      if (memberRole !== '') memberAttrs.push(`role="${escapeAttribute(memberRole)}"`)
      if (memberSkills !== '') memberAttrs.push(`skills="${escapeAttribute(memberSkills)}"`)
      const memberPrompt = pickString(member?.task)

      if (memberPrompt === '') {
        memberLines.push(`          <fs:member ${memberAttrs.join(' ')} />`)
      } else {
        memberLines.push(`          <fs:member ${memberAttrs.join(' ')}>`)
        memberLines.push(`            <fs:prompt>${escapeText(memberPrompt)}</fs:prompt>`)
        memberLines.push('          </fs:member>')
      }
    })
    children.push('        <fs:team mode="fanout">')
    children.push(...memberLines)
    children.push('        </fs:team>')
  }

  if (children.length === 0) {
    return `        <fs:node ${attributes.join(' ')} />`
  }
  return [
    `        <fs:node ${attributes.join(' ')}>`,
    ...children,
    '        </fs:node>',
  ].join('\n')
}

/** 旧节点 → 一个 BPMN 元素（startEvent / endEvent / serviceTask）。 */
function nodeXml(node, bpmnId, defaultFlowId, rawNode, warnings) {
  const name = node.title ? ` name="${escapeAttribute(node.title)}"` : ''
  if (node.kind === NODE_KIND.START || node.kind === NODE_KIND.END) {
    // start/end 没有 fs:node；旧节点的 task/outputs/model/... 全部进 fs:legacy，避免丢失。
    const tag = node.kind === NODE_KIND.START ? 'bpmn:startEvent' : 'bpmn:endEvent'
    const legacyLine = legacyXml(node, rawNode, true, warnings)
    if (!legacyLine) return `    <${tag} id="${bpmnId}"${name} />`
    return [
      `    <${tag} id="${bpmnId}"${name}>`,
      '      <bpmn:extensionElements>',
      legacyLine,
      '      </bpmn:extensionElements>',
      `    </${tag}>`,
    ].join('\n')
  }
  const defaultAttribute = defaultFlowId ? ` default="${defaultFlowId}"` : ''
  return [
    `    <bpmn:serviceTask id="${bpmnId}"${name}${defaultAttribute}>`,
    '      <bpmn:extensionElements>',
    fsNodeXml(node, rawNode, warnings),
    '      </bpmn:extensionElements>',
    '    </bpmn:serviceTask>',
  ].join('\n')
}

/** 旧边 → sequenceFlow；旧模板的 reject 边带普通 FEEL 条件与 fs:maxRounds。 */
function flowXml(edge, bpmnId, fromId, toId, targetNode, rejectPlan) {
  const name = edge.label ? ` name="${escapeAttribute(edge.label)}"` : ''
  if (edge.kind !== EDGE_KIND.REJECT) {
    return `    <bpmn:sequenceFlow id="${bpmnId}"${name} sourceRef="${fromId}" targetRef="${toId}" />`
  }
  const maxRounds = Number.isInteger(targetNode?.maxRounds) && targetNode.maxRounds >= 1
    ? targetNode.maxRounds
    : 2
  const expression = rejectPlan?.expression || '= verdict = "reject"'
  return [
    `    <bpmn:sequenceFlow id="${bpmnId}"${name} sourceRef="${fromId}" targetRef="${toId}">`,
    '      <bpmn:extensionElements>',
    `        <fs:maxRounds>${maxRounds}</fs:maxRounds>`,
    '      </bpmn:extensionElements>',
    `      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="feel">${escapeText(expression)}</bpmn:conditionExpression>`,
    '    </bpmn:sequenceFlow>',
  ].join('\n')
}

function diagramXml(processId, nodes, edges, positions, nodeIds, edgeIds) {
  const lines = []
  lines.push('  <bpmndi:BPMNDiagram id="BPMNDiagram_1">')
  lines.push(`    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${processId}">`)

  for (const node of nodes) {
    const bpmnId = nodeIds.get(node.id)
    const position = positions.get(node.id)
    lines.push(`      <bpmndi:BPMNShape id="BPMNShape_${bpmnId}" bpmnElement="${bpmnId}">`)
    lines.push(`        <omgdc:Bounds x="${round(position.x)}" y="${round(position.y)}" width="${round(position.width)}" height="${round(position.height)}" />`)
    lines.push('      </bpmndi:BPMNShape>')
  }

  for (const edge of edges) {
    const bpmnId = edgeIds.get(edge)
    const waypoints = edgeWaypoints(positions.get(edge.from), positions.get(edge.to))
    lines.push(`      <bpmndi:BPMNEdge id="BPMNEdge_${bpmnId}" bpmnElement="${bpmnId}">`)
    for (const point of waypoints) {
      lines.push(`        <omgdi:waypoint x="${round(point.x)}" y="${round(point.y)}" />`)
    }
    lines.push('      </bpmndi:BPMNEdge>')
  }

  lines.push('    </bpmndi:BPMNPlane>')
  lines.push('  </bpmndi:BPMNDiagram>')
  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* 转换器                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 把老 `flows/<id>.json` 转成 BPMN 2.0 XML。
 *
 * @param {unknown} flowJson 老流程 JSON（会先过 `normalizeFlow` 收敛字段）
 * @returns {{ ok: boolean, xml: string, warnings: Array<object>, errors: Array<object> }}
 */
export function convertLegacyFlow(flowJson) {
  const warnings = []
  const errors = []

  try {
    if (!flowJson || typeof flowJson !== 'object' || Array.isArray(flowJson)) {
      errors.push({ code: 'LEGACY_INVALID', message: '旧流程必须是 JSON 对象。' })
      return fail(errors, warnings)
    }

    const flow = normalizeFlow(flowJson, '迁移流程')
    const rawEdges = Array.isArray(flowJson.edges) ? flowJson.edges : null
    checkLegacyStructure(flow, rawEdges, warnings, errors)
    if (errors.length > 0) return fail(errors, warnings)

    const nodes = flow.nodes
    const edges = flow.edges
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const starts = nodes.filter(node => node.kind === NODE_KIND.START)

    // 原始输入按 id 索引：normalizeFlow 会把 outputs 剪成字符串、给 check 补默认值，
    // 迁移要保留「老 flow 的实际形状」，所以这些字段优先读 raw 节点。
    const rawNodesById = new Map()
    if (Array.isArray(flowJson.nodes)) {
      for (const item of flowJson.nodes) {
        if (item && typeof item === 'object' && typeof item.id === 'string') {
          rawNodesById.set(item.id, item)
        }
      }
    }

    // XML ID 必须文档内唯一：节点、边、process 共用一个 used 集合。
    const usedIds = new Set()
    const nodeIds = new Map()
    for (const node of nodes) {
      nodeIds.set(node.id, makeXmlId(node.id, 'node', usedIds, warning => warnings.push({
        ...warning,
        nodeId: node.id,
      }), { nodeId: node.id }))
    }
    const edgeIds = new Map()
    for (const edge of edges) {
      edgeIds.set(edge, makeXmlId(edge.id, 'flow', usedIds, warning => warnings.push({
        ...warning,
        edgeId: edge.id,
      }), { edgeId: edge.id }))
    }

    const processRawId = flow.id ? `Process_${flow.id}` : 'Process_1'
    const processId = makeXmlId(processRawId, 'Process', usedIds, warning => warnings.push(warning))

    // 分支节点（出度 > 1）：第一条 next 设为 BPMN 默认流；next 多于一条时提醒人工补条件。
    // 出度把 reject 也算进来（与旧模型「多条出边里第一条 next 兜底」一致）；
    // 但只有 next 本身多于一条才算真正需要补条件的「分支」。
    const defaultFlowByNode = new Map()
    for (const node of nodes) {
      const outgoingEdges = edges.filter(edge => edge.from === node.id)
      if (outgoingEdges.length <= 1) continue
      const nextEdges = outgoingEdges.filter(edge => edge.kind === EDGE_KIND.NEXT)
      if (nextEdges.length === 0) continue
      const first = nextEdges[0]
      if (node.kind === NODE_KIND.START) {
        warnings.push({
          code: 'BRANCH_NO_DEFAULT_SUPPORTED',
          nodeId: node.id,
          message: `start 节点「${node.title || node.id}」有多条出边，但 bpmn:startEvent 不支持 default 属性；未设置默认流，需人工补条件。`,
        })
      } else {
        defaultFlowByNode.set(node.id, edgeIds.get(first))
      }
      if (nextEdges.length > 1) {
        warnings.push({
          code: 'BRANCH_CONDITION_MANUAL',
          nodeId: node.id,
          message: `「${node.title || node.id}」有 ${nextEdges.length} 条 next 分支：第一条已设为默认流；该分支原先靠顺序，迁移后需人工补条件（其余分支未自动编 FEEL 条件）。`,
        })
      }
    }

    // 旧模板 reject 边：按旧输出契约生成普通 FEEL 条件，不写引擎级「打回」语义。
    // 同一节点多条时按老引擎 leftmost 规则写成互斥条件。
    const rejectPlans = buildRejectPlans(nodes, edges, nodeIds)
    for (const edge of edges) {
      if (edge.kind !== EDGE_KIND.REJECT) continue
      const plan = rejectPlans.get(edge)
      const source = nodeById.get(edge.from)
      const target = nodeById.get(edge.to)
      const maxRounds = Number.isInteger(target?.maxRounds) && target.maxRounds >= 1 ? target.maxRounds : 2
      const sourceTitle = source?.title || edge.from
      const targetTitle = target?.title || edge.to
      const multi = plan && plan.total > 1
        ? `旧模板里该节点有多条回退连线（${plan.total} 条）：默认走最左目标「${plan.leftmostTitle}」，其余目标靠输出里的 rejectTarget 选中；所有条件已写成互斥。`
        : ''
      warnings.push({
        code: 'REJECT_CONDITION_MANUAL',
        edgeId: edge.id,
        message: `回退边「${sourceTitle}」→「${targetTitle}」已生成为普通条件连线，条件 ${plan?.expression || '= verdict = "reject"'}（来自旧模板依赖的结构化输出字段 verdict，旧契约要求 pass|reject）；这是模板层的条件，需人工确认字段名与目标。${multi}该连线记录 fs:maxRounds=${maxRounds}（这条连线最多被走 ${maxRounds} 次，通用上限）。`,
      })
    }

    const layers = computeLayers(nodes, edges, starts[0]?.id)
    const positions = layoutNodes(nodes, layers)

    const nodeLines = nodes.map(node => nodeXml(
      node,
      nodeIds.get(node.id),
      defaultFlowByNode.get(node.id),
      rawNodesById.get(node.id),
      warnings,
    ))
    const flowLines = edges.map(edge => flowXml(
      edge,
      edgeIds.get(edge),
      nodeIds.get(edge.from),
      nodeIds.get(edge.to),
      nodeById.get(edge.to),
      rejectPlans.get(edge),
    ))

    const diagram = diagramXml(processId, nodes, edges, positions, nodeIds, edgeIds)

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" xmlns:bpmndi="${BPMNDI_NS}" xmlns:omgdc="${DC_NS}" xmlns:omgdi="${DI_NS}" xmlns:fs="${FS_NS}" xmlns:xsi="${XSI_NS}" id="Definitions_${processId}" targetNamespace="${TARGET_NS}">`,
      `  <bpmn:process id="${processId}" name="${escapeAttribute(flow.name)}" isExecutable="true">`,
      ...nodeLines,
      ...flowLines,
      '  </bpmn:process>',
      diagram,
      '</bpmn:definitions>',
      '',
    ].join('\n')

    return { ok: true, xml, warnings, errors }
  } catch (error) {
    errors.push({
      code: 'CONVERT_ERROR',
      message: `旧流程转换失败：${error?.message || String(error)}`,
    })
    return fail(errors, warnings)
  }
}
