/**
 * 流程模型：节点 / 连线 / 默认模板 / 校验。
 *
 * Host 与 Client 共用同一份（Host 在写入前校验，Client 在编辑期实时校验），
 * 所以这里不能碰 node: 或 window:，只能是纯 JS。
 *
 * @module @feiyueve/dsh-flow-studio/model
 */

/** 存储格式版本。改动字段语义时递增，读侧据此拒绝过旧数据。 */
export const SCHEMA_VERSION = 1

/** 画布上节点的固定尺寸（px，逻辑坐标）。固定宽高让连线锚点与命中测试都能纯算。 */
export const NODE_W = 208
export const NODE_H = 88

/** 节点类型：开始 / 阶段 / 结束。 */
export const NODE_KIND = { START: 'start', STAGE: 'stage', END: 'end' }

/** 连线类型：正常流转 / 打回（回退到上游阶段）。 */
export const EDGE_KIND = { NEXT: 'next', REJECT: 'reject' }

/** 执行方式：单个 agent / 主管 agent 带若干子 agent。 */
export const EXEC_MODE = { SINGLE: 'single', TEAM: 'team' }

/** 单个流程允许的上限，防止误操作把面板拖死。 */
export const LIMITS = {
  nodes: 60,
  edges: 200,
  titleLen: 40,
  textLen: 4000,
  skillsPerNode: 12,
  teamMembers: 8,
  maxRounds: 9,
}

/** 生成短 id。Host / 浏览器都有 crypto.randomUUID，但短一点更好读。 */
export function makeId(prefix) {
  const raw = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
    : Math.random().toString(36).slice(2, 12)
  return `${prefix}_${raw}`
}

/** 空节点骨架。 */
export function blankNode(kind, x, y, title) {
  return {
    id: makeId('n'),
    kind,
    title: title || (kind === NODE_KIND.START ? '任务输入' : kind === NODE_KIND.END ? '完成' : '新阶段'),
    x: Math.round(x),
    y: Math.round(y),
    mode: EXEC_MODE.SINGLE,
    role: '',
    task: '',
    skills: [],
    outputs: '',
    maxRounds: 2,
    team: [],
    model: '',
  }
}

/** 空连线。 */
export function blankEdge(from, to, kind) {
  return {
    id: makeId('e'),
    from,
    to,
    kind: kind || EDGE_KIND.NEXT,
    label: kind === EDGE_KIND.REJECT ? '打回' : '',
  }
}

/** 空流程。 */
export function blankFlow(name) {
  const now = new Date().toISOString()
  return {
    schemaVersion: SCHEMA_VERSION,
    id: '',
    name: name || '未命名流程',
    description: '',
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
  }
}

/**
 * 出厂模板：一条标准研发流水线，含四处打回。
 * 用户新建流程时默认拿到的就是它，打开面板立刻看得懂这个插件在讲什么。
 */
export function defaultFlow() {
  const now = new Date().toISOString()
  const y = 220
  const node = (id, kind, title, x, extra) => ({
    id,
    kind,
    title,
    x,
    y,
    mode: EXEC_MODE.SINGLE,
    role: '',
    task: '',
    skills: [],
    outputs: '',
    maxRounds: 2,
    team: [],
    model: '',
    ...extra,
  })

  const nodes = [
    node('n_start', NODE_KIND.START, '任务输入', 40, {
      task: '接收用户任务原文，确认目标、约束与完成判据，产出任务卡（不含方案）。',
      outputs: '任务卡：一句话目标 / 范围 / 非目标 / 完成判据',
    }),
    node('n_req', NODE_KIND.STAGE, '需求分析', 300, {
      role: '资深需求分析师。擅长把模糊诉求拆成可验收的条目，主动追问缺失的边界条件。',
      task: '把任务卡拆成可验收的需求条目，逐条编号，每条写清验收标准；列出假设、风险与非目标。',
      outputs: '需求清单 R1..Rn（含验收标准）+ 风险表',
    }),
    node('n_plan', NODE_KIND.STAGE, '方案设计', 560, {
      role: '系统架构师。关注选型代价与失败路径，不写实现细节。',
      task: '基于需求产出技术方案：关键选型与理由、模块划分、接口契约、失败与回滚策略；标注被否决的备选方案。',
      outputs: '方案说明 + 接口契约 + 选型对比表',
    }),
    node('n_shape', NODE_KIND.STAGE, '结构设计', 820, {
      role: '模块设计负责人。把方案翻译成可落手的代码结构。',
      task: '把方案落到代码结构：目录与模块、类/函数职责、数据结构、关键时序；指出方案里无法落地的部分。',
      outputs: '结构设计说明 + 改动文件清单',
    }),
    node('n_dev', NODE_KIND.STAGE, '开发', 1080, {
      role: '开发工程师。写能跑的代码，遵守项目规范，不擅自扩大改动面。',
      task: '按结构设计实现代码，遵守编码规范；补必要的边界处理与注释；同步更新受影响的测试。',
      outputs: '代码改动 + 自测结论',
    }),
    node('n_test', NODE_KIND.STAGE, '测试', 1340, {
      role: '测试工程师。先想怎么让它挂，再想怎么证明它对。',
      task: '按验收标准编写并执行测试，覆盖边界与异常路径；输出失败用例与缺陷清单（含复现步骤）。',
      outputs: '测试结论 + 缺陷清单（编号 / 级别 / 复现）',
    }),
    node('n_review', NODE_KIND.STAGE, '代码审查', 1600, {
      role: '代码审查者。只报能指出位置和理由的问题，不做风格偏好之争。',
      task: '审查改动：正确性、边界、安全、可维护性、规范符合度；每条 finding 给出文件位置、级别、建议改法。',
      outputs: 'finding 清单（位置 / 级别 / 理由 / 建议）',
    }),
    node('n_end', NODE_KIND.END, '完成', 1860, {
      task: '汇总产物、结论与遗留问题，给出可交付的最终答复。',
      outputs: '交付说明',
    }),
  ]

  const next = (from, to, label) => ({ id: makeId('e'), from, to, kind: EDGE_KIND.NEXT, label: label || '' })
  const reject = (from, to, label) => ({ id: makeId('e'), from, to, kind: EDGE_KIND.REJECT, label })

  const edges = [
    next('n_start', 'n_req'),
    next('n_req', 'n_plan'),
    next('n_plan', 'n_shape'),
    next('n_shape', 'n_dev'),
    next('n_dev', 'n_test'),
    next('n_test', 'n_review'),
    next('n_review', 'n_end'),
    reject('n_plan', 'n_req', '方案被打回'),
    reject('n_shape', 'n_plan', '结构设计被打回'),
    reject('n_test', 'n_dev', '测试打回'),
    reject('n_review', 'n_dev', '审查打回'),
  ]

  return {
    schemaVersion: SCHEMA_VERSION,
    id: '',
    name: '标准研发流水线',
    description: '需求分析 → 方案设计 → 结构设计 → 开发 → 测试 → 代码审查，方案/结构/测试/审查四处可打回。',
    createdAt: now,
    updatedAt: now,
    nodes,
    edges,
  }
}

/** 掐掉超长文本，避免一份流程把接口撑爆。 */
function clip(value, max) {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

/**
 * 把外部来的任意 JSON 收敛成合法流程。不认识的东西一律丢掉，不抛错——
 * 读旧版本留下的文件时宁可降级也不要打不开面板。
 * @param {unknown} raw
 * @param {string} fallbackName
 */
export function normalizeFlow(raw, fallbackName) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const now = new Date().toISOString()
  const nodes = []
  const seen = new Set()

  if (Array.isArray(src.nodes)) {
    for (const item of src.nodes.slice(0, LIMITS.nodes)) {
      if (!item || typeof item !== 'object') continue
      const id = clip(String(item.id || ''), 64) || makeId('n')
      if (seen.has(id)) continue
      seen.add(id)
      const kind = Object.values(NODE_KIND).includes(item.kind) ? item.kind : NODE_KIND.STAGE
      const mode = Object.values(EXEC_MODE).includes(item.mode) ? item.mode : EXEC_MODE.SINGLE
      const team = Array.isArray(item.team)
        ? item.team.slice(0, LIMITS.teamMembers).map(member => ({
          name: clip(String(member && member.name || ''), 60),
          role: clip(String(member && member.role || ''), LIMITS.textLen),
          task: clip(String(member && member.task || ''), LIMITS.textLen),
        }))
        : []
      nodes.push({
        id,
        kind,
        title: clip(String(item.title || ''), LIMITS.titleLen) || '未命名节点',
        x: Number.isFinite(item.x) ? Math.round(item.x) : 80,
        y: Number.isFinite(item.y) ? Math.round(item.y) : 80,
        mode,
        role: clip(String(item.role || ''), LIMITS.textLen),
        task: clip(String(item.task || ''), LIMITS.textLen),
        skills: Array.isArray(item.skills)
          ? [...new Set(item.skills.filter(s => typeof s === 'string' && s.length > 0 && s.length <= 64))]
            .slice(0, LIMITS.skillsPerNode)
          : [],
        outputs: clip(String(item.outputs || ''), LIMITS.textLen),
        maxRounds: Number.isFinite(item.maxRounds)
          ? Math.min(LIMITS.maxRounds, Math.max(1, Math.round(item.maxRounds)))
          : 2,
        model: clip(String(item.model || ''), 120),
        team,
      })
    }
  }

  const ids = new Set(nodes.map(n => n.id))
  const edges = []
  const edgeKeys = new Set()
  if (Array.isArray(src.edges)) {
    for (const item of src.edges.slice(0, LIMITS.edges)) {
      if (!item || typeof item !== 'object') continue
      const from = String(item.from || '')
      const to = String(item.to || '')
      if (!ids.has(from) || !ids.has(to) || from === to) continue
      const kind = Object.values(EDGE_KIND).includes(item.kind) ? item.kind : EDGE_KIND.NEXT
      const key = `${from}->${to}:${kind}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      edges.push({
        id: clip(String(item.id || ''), 64) || makeId('e'),
        from,
        to,
        kind,
        label: clip(String(item.label || ''), 60),
      })
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    id: String(src.id || ''),
    name: clip(String(src.name || ''), LIMITS.titleLen) || fallbackName || '未命名流程',
    description: clip(String(src.description || ''), 400),
    createdAt: typeof src.createdAt === 'string' ? src.createdAt : now,
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : now,
    nodes,
    edges,
  }
}

/** 邻接表：只在流转边（next）上走，用来判「谁在上游」。 */
function nextAdjacency(flow) {
  const out = new Map(flow.nodes.map(n => [n.id, []]))
  const inc = new Map(flow.nodes.map(n => [n.id, []]))
  for (const edge of flow.edges) {
    if (edge.kind !== EDGE_KIND.NEXT) continue
    if (!out.has(edge.from) || !inc.has(edge.to)) continue
    out.get(edge.from).push(edge.to)
    inc.get(edge.to).push(edge.from)
  }
  return { out, inc }
}

/** 从若干起点沿给定邻接表做可达集。 */
function reach(startIds, adjacency) {
  const seen = new Set()
  const queue = [...startIds]
  while (queue.length > 0) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    for (const nextId of adjacency.get(id) || []) if (!seen.has(nextId)) queue.push(nextId)
  }
  return seen
}

/**
 * 校验流程。error 表示这份流程跑不起来（结构错），warning 表示能存但作者大概率还想改。
 * @returns {{ ok: boolean, errors: Array<{message: string, nodeId?: string, edgeId?: string}>, warnings: Array<{message: string, nodeId?: string, edgeId?: string}> }}
 */
export function validateFlow(flow) {
  const errors = []
  const warnings = []
  const nodes = flow.nodes || []
  const edges = flow.edges || []
  const byId = new Map(nodes.map(n => [n.id, n]))

  if (nodes.length === 0) {
    errors.push({ message: '画布是空的：至少需要一个「开始」节点和一个阶段节点。' })
    return { ok: false, errors, warnings }
  }

  const starts = nodes.filter(n => n.kind === NODE_KIND.START)
  const ends = nodes.filter(n => n.kind === NODE_KIND.END)
  if (starts.length !== 1) {
    errors.push({ message: `必须恰好有一个「开始」节点，当前有 ${starts.length} 个。`, nodeId: starts[0] && starts[0].id })
  }
  if (ends.length === 0) {
    errors.push({ message: '缺少「结束」节点：任务没有终点，流转会停在半空。' })
  }

  const { out, inc } = nextAdjacency(flow)
  const reachable = starts.length > 0 ? reach(starts.map(n => n.id), out) : new Set()
  for (const node of nodes) {
    if (starts.length > 0 && !reachable.has(node.id)) {
      errors.push({ message: `「${node.title}」从开始节点走不到，是一条断头路。`, nodeId: node.id })
    }
    const outs = edges.filter(e => e.from === node.id)
    if (node.kind !== NODE_KIND.END && outs.length === 0) {
      errors.push({ message: `「${node.title}」没有出去的路：既不是结束节点，也没有任何连线。`, nodeId: node.id })
    }
    if (node.kind === NODE_KIND.START && outs.length > 1) {
      warnings.push({ message: `「${node.title}」有多条出边，任务会被分叉成多份。`, nodeId: node.id })
    }
    if (node.kind === NODE_KIND.END && outs.length > 0) {
      warnings.push({ message: `「${node.title}」是结束节点，出边不会被执行。`, nodeId: node.id })
    }
    if (node.kind === NODE_KIND.STAGE) {
      if (!node.role.trim()) warnings.push({ message: `「${node.title}」还没写角色定位，执行时它只能靠任务描述猜自己是谁。`, nodeId: node.id })
      if (!node.task.trim()) errors.push({ message: `「${node.title}」还没写负责的事，这个节点没有可执行内容。`, nodeId: node.id })
      if (node.mode === EXEC_MODE.TEAM && node.team.length === 0) {
        warnings.push({ message: `「${node.title}」选了「主管 + 子 agent」，但还没配任何子 agent。`, nodeId: node.id })
      }
    }
  }

  // 结束节点必须可达：从每个节点出发看能不能走到某个 end。
  const endsBack = ends.length > 0 ? reach(ends.map(n => n.id), inc) : new Set()
  for (const node of nodes) {
    if (ends.length > 0 && !endsBack.has(node.id)) {
      warnings.push({ message: `「${node.title}」走不到任何结束节点，可能是一个收不了口的循环。`, nodeId: node.id })
    }
  }

  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      errors.push({ message: '有一条连线指向了已删除的节点。', edgeId: edge.id })
      continue
    }
    if (edge.kind === EDGE_KIND.REJECT) {
      const upstream = reach([edge.to], out)
      if (!upstream.has(edge.from)) {
        errors.push({
          message: `打回线「${byId.get(edge.from).title} → ${byId.get(edge.to).title}」的目标不在上游，不构成回退。`,
          edgeId: edge.id,
        })
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * 把流程渲染成一段可读的流转说明，给人核对「我画的到底是什么意思」。
 * 只做静态展开，不做条件求值。
 */
export function describeFlow(flow) {
  const byId = new Map(flow.nodes.map(n => [n.id, n]))
  const lines = []
  const starts = flow.nodes.filter(n => n.kind === NODE_KIND.START)
  const head = starts.length === 1 ? starts[0] : flow.nodes[0]
  if (!head) return '（空流程）'

  const seen = new Set()
  const queue = [head.id]
  while (queue.length > 0) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (!node) continue
    const outs = flow.edges.filter(e => e.from === id)
    const nexts = outs.filter(e => e.kind === EDGE_KIND.NEXT)
    const rejects = outs.filter(e => e.kind === EDGE_KIND.REJECT)
    const label = node.kind === NODE_KIND.START ? '开始' : node.kind === NODE_KIND.END ? '结束' : node.title
    const audience = node.mode === EXEC_MODE.TEAM ? `主管 + ${node.team.length} 个子 agent` : '单个 agent'
    const detail = node.kind === NODE_KIND.STAGE ? `（${audience}${node.skills.length > 0 ? `，skills: ${node.skills.join(', ')}` : ''}）` : ''
    lines.push(`${'  '.repeat(Math.min(seen.size - 1, 3))}→ ${label}${detail}`)
    for (const edge of rejects) {
      const target = byId.get(edge.to)
      lines.push(`${'  '.repeat(Math.min(seen.size, 3))}  ↺ ${edge.label || '打回'} → ${target ? target.title : '?'}（最多 ${node.maxRounds} 轮）`)
    }
    for (const edge of nexts) queue.push(edge.to)
  }
  return lines.join('\n')
}

/** 摘要：给流程列表用，不传整份数据。 */
export function summarize(flow) {
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    nodeCount: flow.nodes.length,
    edgeCount: flow.edges.length,
    rejectCount: flow.edges.filter(e => e.kind === EDGE_KIND.REJECT).length,
    updatedAt: flow.updatedAt,
  }
}
