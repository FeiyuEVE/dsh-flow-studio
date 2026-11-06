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

/**
 * 画布上节点的固定尺寸（px，逻辑坐标）。固定宽高让连线锚点与命中测试都能纯算。
 * 208×96 是 DESIGN.md §6 的裁决值；主从节点加 20px（116）放成员点行。
 */
export const NODE_W = 208
export const NODE_H = 96

/** 节点类型：开始 / 阶段 / 结束。 */
export const NODE_KIND = { START: 'start', STAGE: 'stage', END: 'end' }

/** 连线类型：正常流转 / 打回（回退到上游阶段）。 */
export const EDGE_KIND = { NEXT: 'next', REJECT: 'reject' }

/** 执行方式：单个 agent / 主管 agent 带若干子 agent。 */
export const EXEC_MODE = { SINGLE: 'single', TEAM: 'team' }

/** 节点执行器：dsh 内建 / codex CLI / 自定义命令（07 §6）。 */
export const EXECUTOR = { DSH: 'dsh', CODEX: 'codex', CUSTOM: 'custom' }

/** 单个流程允许的上限，防止误操作把面板拖死。 */
export const LIMITS = {
  nodes: 60,
  edges: 200,
  titleLen: 40,
  textLen: 4000,
  skillsPerNode: 12,
  teamMembers: 8,
  maxRounds: 9,
  /** 外部 executor 的命令模板长度（07 §6）。 */
  executorCommandLen: 2000,
  /** 未知字段兜底（extras）的上限：键数、单条字符串长度、序列化后的总字节数。 */
  extrasKeys: 16,
  extrasTextLen: 256,
  extrasBytes: 2048,
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
    executor: EXECUTOR.DSH,
    executorCommand: '',
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
 * 六个阶段默认走「主管 + 3 个子 agent」：主管只负责分派与收口，具体分工落在成员任务里。
 */
export function defaultFlow() {
  const now = new Date().toISOString()
  const y = 220
  const member = (name, role, task) => ({ name, role, task })
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
    executor: EXECUTOR.DSH,
    executorCommand: '',
    ...extra,
  })

  const nodes = [
    node('n_start', NODE_KIND.START, '任务输入', 40, {
      task: '接收用户任务原文，确认目标、约束与完成判据，产出任务卡（不含方案）。',
      outputs: '任务卡：一句话目标 / 范围 / 非目标 / 完成判据',
    }),
    node('n_req', NODE_KIND.STAGE, '需求分析', 300, {
      mode: EXEC_MODE.TEAM,
      role: '需求阶段主管（资深需求分析师）。负责拆活、分派与收口，不代替成员写需求条目。',
      task: '主持需求分析：把任务卡拆成三块分给成员，逐条核实验收标准是否可判定，汇总成需求清单与风险表；信息不足的条目列为待确认项并说明影响。',
      outputs: '需求清单 R1..Rn（含验收标准）+ 风险表',
      team: [
        member('业务拆解', '业务分析师。从用户视角理解任务，能识别原文里没写出来的场景。', '把任务原文拆成业务场景与用户故事，标注每个场景的触发条件、主要流程与异常流程；列出没说清的地方。'),
        member('验收条目', '验收设计者。只接受能判真假的验收标准。', '为每个用户故事写可判定的验收条目并编号，每条给出一条能证明它通过的检查方式；拒绝「体验良好」这类不可验收的措辞。'),
        member('风险与边界', '风险评审。专门找会让方案返工的前提。', '列出假设、非目标、外部依赖与边界条件，逐条写「不成立时会怎样」与建议的应对；标注需要用户确认的开放问题。'),
      ],
    }),
    node('n_plan', NODE_KIND.STAGE, '方案设计', 560, {
      mode: EXEC_MODE.TEAM,
      role: '方案阶段主管。负责把需求裁决成可实施的方案，不写实现细节。',
      task: '主持方案设计：给成员定清选型 / 契约 / 数据三条线，驳回没有理由的选型与无法验证的契约，收口成一份可实施、可回滚的方案。',
      outputs: '方案说明 + 接口契约 + 选型对比表',
      team: [
        member('架构与选型', '系统架构师。关注选型代价与失败路径。', '给出关键选型（框架 / 协议 / 部署形态）与理由，列出被否决的备选及否决原因；写清方案的失败路径与回滚策略。'),
        member('接口契约', '接口设计者。契约必须写到调用方不用猜。', '定义接口 / 事件 / 回调的输入输出、错误码与超时语义，给出至少一个正常与一个失败的调用示例；标出与现有接口不兼容的地方。'),
        member('数据与存储', '数据设计者。先想数据怎么坏，再想怎么存。', '设计数据模型与存储选型，说明索引、容量估算与一致性要求；给出迁移、备份与回滚步骤，标注不可逆操作。'),
      ],
    }),
    node('n_shape', NODE_KIND.STAGE, '结构设计', 820, {
      mode: EXEC_MODE.TEAM,
      role: '结构设计主管。负责把方案落成可落手的代码结构，判断方案是否可落地。',
      task: '主持结构设计：分派模块划分、依赖构建、目录命名三块，检查结构是否与方案一一对应、改动文件清单是否完整；方案无法落地时打回方案设计。',
      outputs: '结构设计说明 + 改动文件清单',
      team: [
        member('模块划分', '模块设计负责人。用职责边界说话，不用技术名词堆砌。', '划分模块与目录边界，写清每个模块的职责、对外接口与不做什么；标出跨模块调用与循环依赖风险。'),
        member('依赖与构建', '构建负责人。关心依赖方向与发布链路。', '梳理新增 / 变更依赖及版本约束，确认依赖方向不反转；给出构建、测试与发布链路的改动点与验证方式。'),
        member('目录与命名', '规范负责人。让改动落在正确的文件里。', '按现有约定给出目录、文件、类型与函数命名方案，产出一份逐文件的改动清单（新增 / 修改 / 删除），标出需要同步更新的文档与配置。'),
      ],
    }),
    node('n_dev', NODE_KIND.STAGE, '开发', 1080, {
      mode: EXEC_MODE.TEAM,
      role: '开发主管。负责拆实现任务、控改动面与核对自测，不替成员写全部代码。',
      task: '主持开发：按结构设计把后端 / 前端 / 自测拆给成员，盯住改动面与编码规范，汇总代码改动与自测结论；与结构设计不一致的地方在自测结论里单列。',
      outputs: '代码改动 + 自测结论',
      team: [
        member('后端实现', '后端工程师。按契约实现，不擅自扩大改动面。', '实现服务端逻辑与数据访问，严格对齐接口契约；补边界处理、错误返回与必要注释，列出与契约不一致或需要协商的地方。'),
        member('前端实现', '前端工程师。先保证状态与错误路径可见。', '实现界面与交互，覆盖加载、空态、错误与越权路径；对齐既有组件与样式约定，说明对后端契约的实际依赖。'),
        member('自测与用例', '开发自测负责人。先跑通再交付。', '为本次改动补充或更新测试，跑一遍关键路径并记录命令与结果；列出未覆盖的分支与需要测试阶段重点验证的地方。'),
      ],
    }),
    node('n_test', NODE_KIND.STAGE, '测试', 1340, {
      mode: EXEC_MODE.TEAM,
      role: '测试阶段主管。负责定测试策略、分派执行与判定是否放行。',
      task: '主持测试：把验收标准分配给用例设计 / 自动化执行 / 回归与缺陷三条线，核对失败用例的复现步骤，汇总测试结论；不达标时打回开发。',
      outputs: '测试结论 + 缺陷清单（编号 / 级别 / 复现）',
      team: [
        member('用例设计', '测试设计师。先想怎么让它挂。', '按验收标准设计正常、边界与异常用例，给出输入、预期结果与判定依据；标出优先级最高、最可能暴露问题的用例。'),
        member('自动化执行', '自动化测试工程师。结果要能复跑。', '把可自动化的用例落成脚本并执行，记录环境、命令、通过率与失败输出；对不能自动化的部分说明原因与人工步骤。'),
        member('回归与缺陷', '缺陷管理员。缺陷必须能被别人复现。', '跑回归用例确认既有功能未被破坏；把失败整理成缺陷清单（编号 / 级别 / 复现步骤 / 期望与实际），并判断哪些必须打回开发。'),
      ],
    }),
    node('n_review', NODE_KIND.STAGE, '代码审查', 1600, {
      mode: EXEC_MODE.TEAM,
      role: '代码审查主管。负责分派审查角度、裁定级别、汇总 finding，不做风格偏好之争。',
      task: '主持代码审查：分派规范 / 安全 / 可维护性三路审查，核对每条 finding 的位置与理由，汇总成可执行的 finding 清单；必须返工的按打回线退回开发。',
      outputs: 'finding 清单（位置 / 级别 / 理由 / 建议）',
      team: [
        member('规范与风格', '规范审查者。只报项目约定里写过的规则。', '对照项目规范检查命名、分层、错误处理与测试约定；每条 finding 给出文件位置、命中的规则与改法，纯个人偏好不报。'),
        member('安全与边界', '安全审查者。优先看输入、权限与失败路径。', '检查输入校验、鉴权授权、敏感信息与注入面，复核空值 / 越界 / 超时 / 并发边界；按 P0/P1/P2 标级别并给出验证方式。'),
        member('可维护性', '可维护性审查者。为下一个改这段代码的人说话。', '检查重复逻辑、耦合、命名可读性与注释缺失，评估改动的测试可维护性；指出可以在本次顺手收敛、但不该扩大改动面的地方。'),
      ],
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
 * 未知字段兜底容器（extras）的已知键。
 * 已知字段有显式校验与默认值；这里只收「白名单之外、但需要往返保存」的字段，
 * 让新增字段在引擎/客户端接入前至少不会被保存链静默丢掉。
 */
const NODE_KNOWN_FIELDS = new Set([
  'id', 'kind', 'title', 'x', 'y', 'mode', 'role', 'task',
  'skills', 'outputs', 'maxRounds', 'model', 'team', 'executor', 'executorCommand', 'extras',
])
const EDGE_KNOWN_FIELDS = new Set(['id', 'from', 'to', 'kind', 'label', 'extras'])
const MEMBER_KNOWN_FIELDS = new Set(['name', 'role', 'task', 'extras'])

const EXTRAS_KEY_MAX = 64
const EXTRAS_DEPTH = 3
const EXTRAS_ARRAY_MAX = 16
const EXTRAS_OBJECT_KEYS = 16

/** 用 defineProperty 写自有键，避免 `__proto__` 之类的键改写原型。 */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
}

/**
 * 把一个任意值收敛成「JSON 可序列化的原始值」。
 * 只接受字符串 / 数字 / 布尔 / null / 普通对象 / 数组；函数、undefined、NaN、
 * Infinity、BigInt、Symbol、类实例、循环引用、超深嵌套一律返回 undefined（丢弃）。
 * 复合值里只要有一个成员不合法，整个值丢弃——不做半截保留，避免读回时类型漂移。
 */
function jsonSafeValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value.length > LIMITS.extrasTextLen ? value.slice(0, LIMITS.extrasTextLen) : value
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'object') return undefined
  if (depth >= EXTRAS_DEPTH || seen.has(value)) return undefined
  if (Array.isArray(value)) {
    seen.add(value)
    try {
      const out = []
      for (const entry of value.slice(0, EXTRAS_ARRAY_MAX)) {
        const safe = jsonSafeValue(entry, depth + 1, seen)
        if (safe === undefined) return undefined
        out.push(safe)
      }
      return out
    } catch {
      return undefined
    } finally {
      seen.delete(value)
    }
  }

  let proto
  try {
    proto = Object.getPrototypeOf(value)
  } catch {
    return undefined
  }
  if (proto !== Object.prototype && proto !== null) return undefined

  seen.add(value)
  try {
    const out = {}
    let count = 0
    for (const key of Object.keys(value)) {
      if (count >= EXTRAS_OBJECT_KEYS) break
      if (typeof key !== 'string' || key.length === 0 || key.length > EXTRAS_KEY_MAX) continue
      const safe = jsonSafeValue(value[key], depth + 1, seen)
      if (safe === undefined) return undefined
      setOwn(out, key, safe)
      count += 1
    }
    return out
  } catch {
    return undefined
  } finally {
    seen.delete(value)
  }
}

/**
 * 收集未知字段。先读回上一次 normalize 存下的 extras（保证往返不丢），再补本次新出现的键。
 * 超限只丢弃，不截断已知字段，也不抛错。
 */
function collectExtras(source, known) {
  const extras = {}
  if (!source || typeof source !== 'object' || Array.isArray(source)) return extras
  let keys = 0
  let bytes = 2 // '{}'

  const add = (key, value) => {
    if (typeof key !== 'string' || key.length === 0 || key.length > EXTRAS_KEY_MAX) return true
    const safe = jsonSafeValue(value)
    if (safe === undefined) return true
    let text
    try {
      text = JSON.stringify(safe)
    } catch {
      return true
    }
    if (typeof text !== 'string') return true
    // 保守估算：key 引号 + 冒号 + value + 逗号。
    const size = JSON.stringify(key).length + text.length + 4
    if (Object.prototype.hasOwnProperty.call(extras, key)) {
      // 往返读回同一个键：只更新，不重复占键数 / 字节额度。
      setOwn(extras, key, safe)
      return true
    }
    if (keys >= LIMITS.extrasKeys) return false
    if (bytes + size > LIMITS.extrasBytes) return false
    setOwn(extras, key, safe)
    keys += 1
    bytes += size
    return true
  }

  let previous
  try {
    previous = source.extras
  } catch {
    previous = undefined
  }
  if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
    try {
      for (const key of Object.keys(previous)) {
        if (known.has(key)) continue
        if (!add(key, previous[key])) return extras
      }
    } catch {
      // 损坏的旧 extras 直接忽略。
    }
  }

  let sourceKeys
  try {
    sourceKeys = Object.keys(source)
  } catch {
    return extras
  }
  for (const key of sourceKeys) {
    if (known.has(key)) continue
    let value
    try {
      value = source[key]
    } catch {
      continue
    }
    if (!add(key, value)) break
  }
  return extras
}

/** 有未知字段时才挂 extras；没有就不改变既有节点/边的形状。 */
function withExtras(target, source, known) {
  const extras = collectExtras(source, known)
  if (Object.keys(extras).length > 0) target.extras = extras
  return target
}

/**
 * 把外部来的任意 JSON 收敛成合法流程。已知字段走白名单校验；白名单外的
 * 节点/边/成员字段收进有界的 extras（往返保存不丢，超限丢弃），仍不抛错——
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
        ? item.team.slice(0, LIMITS.teamMembers).map(member => withExtras({
          name: clip(String(member && member.name || ''), 60),
          role: clip(String(member && member.role || ''), LIMITS.textLen),
          task: clip(String(member && member.task || ''), LIMITS.textLen),
        }, member, MEMBER_KNOWN_FIELDS))
        : []
      const node = {
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
        executor: Object.values(EXECUTOR).includes(item.executor) ? item.executor : EXECUTOR.DSH,
        executorCommand: clip(String(item.executorCommand || ''), LIMITS.executorCommandLen),
        team,
      }
      nodes.push(withExtras(node, item, NODE_KNOWN_FIELDS))
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
      const edge = {
        id: clip(String(item.id || ''), 64) || makeId('e'),
        from,
        to,
        kind,
        label: clip(String(item.label || ''), 60),
      }
      edges.push(withExtras(edge, item, EDGE_KNOWN_FIELDS))
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
    // 07 §6：custom 必须有命令模板；外部 executor 只允许 single（team 要观察成员会话）。
    const executor = node.executor || EXECUTOR.DSH
    if (executor === EXECUTOR.CUSTOM && !String(node.executorCommand || '').trim()) {
      errors.push({
        message: `「${node.title}」选择了自定义 executor，但没填 executorCommand：外部命令不知道该跑什么。`,
        nodeId: node.id,
      })
    }
    if (executor !== EXECUTOR.DSH && node.mode !== EXEC_MODE.SINGLE) {
      errors.push({
        message: `「${node.title}」使用外部 executor（${executor}）时，执行方式必须是「单个 agent」：team 模式需要引擎观察成员会话，外部进程做不到。`,
        nodeId: node.id,
      })
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
 * 找一条 next 边构成的环（与 Host `engine.findNextCycle` 同一算法：只看 next 边、
 * 目标节点必须存在，DFS 三色标记）。返回环上的节点 id 序列（首尾相同），没有环返回 null。
 * 结束节点如果被手动改出一条 next 出边，也会构成环——这条判据不能只靠「阶段到不了结束」兜。
 */
function findNextCycle(flow, byId) {
  const nextEdges = (flow.edges || []).filter(edge => edge.kind === EDGE_KIND.NEXT && byId.has(edge.to))
  const color = new Map()
  const trail = []
  const visit = (nodeId) => {
    const state = color.get(nodeId)
    if (state === 'gray') {
      const start = trail.indexOf(nodeId)
      return [...trail.slice(start >= 0 ? start : 0), nodeId]
    }
    if (state === 'black') return null
    color.set(nodeId, 'gray')
    trail.push(nodeId)
    for (const edge of nextEdges) {
      if (edge.from !== nodeId) continue
      const found = visit(edge.to)
      if (found) return found
    }
    trail.pop()
    color.set(nodeId, 'black')
    return null
  }
  for (const node of byId.values()) {
    if (color.get(node.id) === 'black') continue
    const found = visit(node.id)
    if (found) return found
  }
  return null
}

/**
 * 开跑前的硬门禁（B2）：与 Host `validateFlowForRun` 同一口径。
 *
 * `validateFlow` 的 error/warning 分级是给**画布编辑**用的（成环只算 warning——作者可能
 * 正画到一半），但引擎开跑前会把这些一律 400 拒掉。客户端必须在**发请求之前**用同一套
 * 判据拦住，否则点「运行」才在服务端失败，等于没有运行前校验。
 *
 * @returns {Array<{message: string, nodeId?: string, edgeId?: string}>} 空 = 可以开跑
 */
export function runBlockers(flow) {
  const issues = []
  const nodes = Array.isArray(flow && flow.nodes) ? flow.nodes : []
  const edges = Array.isArray(flow && flow.edges) ? flow.edges : []
  const byId = new Map(nodes.map(n => [n.id, n]))
  const starts = nodes.filter(n => n.kind === NODE_KIND.START)
  const ends = nodes.filter(n => n.kind === NODE_KIND.END)
  const stages = nodes.filter(n => n.kind === NODE_KIND.STAGE)

  if (starts.length !== 1) {
    issues.push({
      message: `必须恰好有一个「开始」节点（当前 ${starts.length} 个），否则引擎不知道从哪跑。`,
      nodeId: starts[0] && starts[0].id,
    })
  }
  if (ends.length === 0) issues.push({ message: '至少需要一个「结束」节点，否则流程收不了口。' })
  if (stages.length === 0) issues.push({ message: '流程没有阶段节点，没有可执行的内容。' })

  // 节点 id 会进 run 目录与事件，非法字符开跑前就要挡住。
  for (const node of nodes) {
    const id = node && node.id
    const ok = typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id)
      && id !== '.' && id !== '..' && !id.startsWith('.')
    if (!ok) {
      issues.push({
        message: `节点 id 不合法：「${id}」（只允许字母、数字、点、下划线、连字符，1–64 位，不能点开头）。`,
        nodeId: id,
      })
    }
  }

  const { out } = nextAdjacency(flow)
  if (starts.length === 1) {
    const reachable = reach([starts[0].id], out)
    for (const node of nodes) {
      if (node.id === starts[0].id) continue
      if (!reachable.has(node.id)) {
        issues.push({ message: `「${node.title}」从开始节点沿正常流转走不到，是孤立的断头路。`, nodeId: node.id })
      }
    }
  }

  for (const node of nodes) {
    if (node.kind === NODE_KIND.END) continue
    const outs = edges.filter(e => e.from === node.id && e.kind === EDGE_KIND.NEXT)
    if (outs.length !== 1) {
      issues.push({
        message: outs.length === 0
          ? `「${node.title}」没有正常流转的出边：是一条断头路。`
          : `「${node.title}」有 ${outs.length} 条正常流转出边：引擎要求恰好一条。`,
        nodeId: node.id,
      })
    }
    for (const edge of outs) {
      if (!byId.has(edge.to)) {
        issues.push({ message: `正常流转的连线指向了不存在的节点 ${edge.to}。`, edgeId: edge.id })
      }
    }
  }

  for (const edge of edges) {
    if (edge.kind !== EDGE_KIND.REJECT) continue
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      issues.push({ message: '打回线指向了不存在的节点。', edgeId: edge.id })
      continue
    }
    const target = byId.get(edge.to)
    if (target.kind !== NODE_KIND.STAGE) {
      issues.push({
        message: `打回线「${byId.get(edge.from).title} → ${target.title}」的目标不是阶段节点：开始 / 结束节点不执行，回退到那里会让流程卡死。`,
        edgeId: edge.id,
      })
      continue
    }
    if (!reach([edge.to], out).has(edge.from)) {
      issues.push({
        message: `打回线「${byId.get(edge.from).title} → ${target.title}」的目标不在上游，不构成回退。`,
        edgeId: edge.id,
      })
    }
  }

  if (ends.length > 0) {
    for (const node of stages) {
      const reachesEnd = ends.some(end => reach([node.id], out).has(end.id))
      if (!reachesEnd) {
        issues.push({
          message: `阶段「${node.title}」沿正常流转到不了任何结束节点，会是一个收不了口的循环。`,
          nodeId: node.id,
        })
      }
    }
  }

  // next 成环（含「结束节点被改出一条 next 出边」这种）：只靠「阶段到不了结束」兜不住，
  // 引擎另有 findNextCycle 判据，这里必须同口径。
  const cycle = findNextCycle(flow, byId)
  if (cycle) {
    const path = cycle.map(id => (byId.get(id) && byId.get(id).title) || id).join(' → ')
    issues.push({ message: `next 边成环：${path}（引擎会拒绝执行）`, nodeId: cycle[0] })
  }

  return issues
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
