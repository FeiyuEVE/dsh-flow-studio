/**
 * 状态机内核（08-state-machine.md §3 / §4 / §6）：flow → XState v5 machine。
 *
 * 定位：**只看流程结构，不做任何 I/O**。节点怎么执行、会话怎么建、事件怎么落盘
 * 都不在这里；这里只回答「给一串事件，流程该停在哪个状态」。
 *
 * 三个对外契约：
 *   - `machineVersion(flow)`：只含「影响转移」的版本哈希（§6）。改标题 / 坐标 /
 *     role / skills / model / task 不该让已有快照失效。
 *   - `compileFlowToMachine(flow)`：纯函数，返回 `{ machine, version, meta }`。
 *     machine 里的 guard / action **全是字符串名**（编译期零副作用），由引擎用
 *     `machine.provide(...)` 注入实现；本模块额外导出参考实现
 *     {@link flowMachineImplementations}，避免「语义」散落在引擎里。
 *   - `machineEventsFromRun(events)` / `replayMachine(...)`：runlog 事件流是唯一真相
 *     （§6）；快照只是缓存，版本不兼容时从事件流重放。
 *
 * 编译期校验口径与 `engine.js` 的 `validateFlowForRun`（06 §13.5）对齐：引擎判为
 * 可跑的 flow 这里必须能编译；不合法一律抛 `FLOW_MACHINE_INVALID`，**不在编译期
 * 偷偷修好**（多出边不取最左、断头路不补边、成环不截断）。
 *
 * @module @feiyueve/dsh-flow-studio/flowmachine
 */

import { createHash } from 'node:crypto'
import { and, assign, createActor, createMachine } from './xstate-vendor.js'
import { EDGE_KIND, NODE_KIND } from './model.js'
import { checkRunId } from './runlog.js'

/** 非法 flow 的错误码（引擎 / 工具层按它分流，不靠文案匹配）。 */
export const FLOW_MACHINE_INVALID = 'FLOW_MACHINE_INVALID'

/**
 * 节点 id 进得了状态机（会被拼进 `#target`），校验与 runId 同口径：
 * 用 runlog 的 `checkRunId`，连 `.`、`..`、点开头这些会撞内部命名 / 路径穿越的
 * 形式一起挡掉（只抄 ID_PATTERN 会漏掉这三类）。
 */

/** 这几个名字被机器的状态 id 占用，阶段节点不许重名。 */
const RESERVED_STATE_IDS = new Set(['flow', 'running', 'done', 'failed', 'aborted'])

/** 与 engine.js 一致：maxRounds 缺省 / 非法时按 2 次重跑处理。 */
const DEFAULT_MAX_ROUNDS = 2

/** context.inbox 只做观测，别让它把 run.json 的 24 KiB 预算撑爆。 */
const INBOX_LIMIT = 20

/** 合法的正式结论（SELF_CHECK 只认这三个值更新 lastVerdict）。 */
const VERDICTS = new Set(['pass', 'reject', 'fail'])

const NODE_EVENT = Object.freeze({ END: 'node/end' })
const RUN_EVENT = Object.freeze({ END: 'run/end' })
const RUN_END_ABORTED = 'aborted'

/**
 * 状态机事件表（§4）。引擎只发这些；PASS/REJECT/FAIL 由引擎按节点结论发，
 * 不直接暴露给节点会话。
 */
export const FLOW_EVENTS = Object.freeze({
  PASS: 'PASS',
  REJECT: 'REJECT',
  FAIL: 'FAIL',
  CLOCK_TIMEOUT: 'CLOCK_TIMEOUT',
  CANCEL: 'CANCEL',
  INBOX: 'INBOX',
  SELF_CHECK: 'SELF_CHECK',
})

/**
 * 非法 flow。带 `code` 方便上层 `error.code === 'FLOW_MACHINE_INVALID'`；
 * 同时是真正的 `Error`（有栈、有 name），比裸对象好排查。
 */
export class FlowMachineInvalidError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FlowMachineInvalidError'
    this.code = FLOW_MACHINE_INVALID
  }
}

function invalid(message) {
  throw new FlowMachineInvalidError(message)
}

/** 与地区设置无关的字符串比较（localeCompare 在极端环境下会随 locale 变）。 */
function compareText(a, b) {
  const left = a === undefined || a === null ? '' : String(a)
  const right = b === undefined || b === null ? '' : String(b)
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function numberOrMax(value) {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

/**
 * 「最靠左」：与 engine.js 的 `leftmost` 完全同口径（x → y → id），
 * 保证「未指定 rejectTarget」时状态机与旧主循环选的是同一个目标。
 */
function compareLeftmost(a, b) {
  const ax = numberOrMax(a && a.x)
  const bx = numberOrMax(b && b.x)
  if (ax !== bx) return ax - bx
  const ay = numberOrMax(a && a.y)
  const by = numberOrMax(b && b.y)
  if (ay !== by) return ay - by
  return compareText(a && a.id, b && b.id)
}

/** maxRounds 归一化：只认 ≥1 的整数，其余（缺省 / 0 / 1.5 / '2'）按默认 2。 */
function normalizeMaxRounds(node) {
  const raw = node && node.maxRounds
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_MAX_ROUNDS
}

/** §6 里节点的第三列：`maxRounds ?? ''`。 */
function maxRoundsToken(node) {
  const raw = node ? node.maxRounds : undefined
  return raw === undefined || raw === null ? '' : String(raw)
}

/**
 * §6 版本哈希：只含「影响转移」的东西。
 *
 *   engineVersion | 每个节点 [id, kind, maxRounds ?? ''] | 每条边 [from, to, kind]
 *
 * **顺序无关**：节点按 id 排序、边按 (from,to,kind) 排序后再 join。同一份图换个
 * JSON 书写顺序（数组重排）必须得到同一个 version；标题、坐标、role、skills、
 * model、task 一律不进哈希 —— 改这些不该让快照失效。
 *
 * @param {object} flow
 * @param {{ engineVersion?: string|number }} [options]
 * @returns {string} 16 位小写 hex
 */
export function machineVersion(flow, { engineVersion = '1' } = {}) {
  const nodes = Array.isArray(flow && flow.nodes) ? flow.nodes : []
  const edges = Array.isArray(flow && flow.edges) ? flow.edges : []

  const nodeLines = [...nodes]
    .sort((a, b) => compareText(a && a.id, b && b.id))
    .map(node => [node && node.id, node && node.kind, maxRoundsToken(node)].join(','))
    .join('|')

  const edgeLines = [...edges]
    .sort((a, b) => compareText(a && a.from, b && b.from)
      || compareText(a && a.to, b && b.to)
      || compareText(a && a.kind, b && b.kind))
    .map(edge => [edge && edge.from, edge && edge.to, edge && edge.kind].join(','))
    .join('|')

  const canonical = ['v1', String(engineVersion), nodeLines, edgeLines].join('|')
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// 编译：校验 + 规划（纯数据），再交给 createMachine
// ---------------------------------------------------------------------------

/**
 * 沿 next 边能否从 from 走到 to（打回「上游」判定、可达性判定共用）。
 * 与 engine.js 的 `canReachViaNext` 同口径。
 */
function canReachViaNext(byId, nextEdges, from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return false
  if (!byId.has(from) || !byId.has(to)) return false
  if (from === to) return true
  const seen = new Set([from])
  const queue = [from]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const edge of nextEdges) {
      if (edge.from !== current || seen.has(edge.to)) continue
      if (!byId.has(edge.to)) continue
      if (edge.to === to) return true
      seen.add(edge.to)
      queue.push(edge.to)
    }
  }
  return false
}

/** next 边成环检测（不含 reject 边）；返回环上的节点 id 序列，无环返回 null。 */
function findNextCycle(nextEdges) {
  const color = new Map()
  const trail = []
  const visit = nodeId => {
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
  for (const edge of nextEdges) {
    if (color.get(edge.from) === 'black') continue
    const found = visit(edge.from)
    if (found) return found
  }
  return null
}

/**
 * 校验并规划 flow。返回值全是可序列化数据；任何一步不满足就抛
 * `FLOW_MACHINE_INVALID`（不修，不猜）。
 */
function planFlow(flow) {
  if (!flow || typeof flow !== 'object') invalid('flow 必须是对象')
  const nodes = flow.nodes
  const edges = flow.edges
  if (!Array.isArray(nodes) || nodes.length === 0) invalid('flow.nodes 必须是非空数组')
  if (!Array.isArray(edges)) invalid('flow.edges 必须是数组')

  const byId = new Map()
  for (const node of nodes) {
    if (!node || typeof node !== 'object') invalid('flow.nodes 里有非对象节点')
    const id = node.id
    if (checkRunId(id) === null) {
      invalid(`节点 id 不合法：「${String(id)}」（只允许字母、数字、点、下划线、连字符，1–64 位，且不能以点开头）`)
    }
    if (byId.has(id)) invalid(`节点 id 重复：「${id}」`)
    if (node.kind !== NODE_KIND.START && node.kind !== NODE_KIND.STAGE && node.kind !== NODE_KIND.END) {
      invalid(`节点「${id}」的类型「${String(node.kind)}」不合法：只允许 start / stage / end`)
    }
    byId.set(id, node)
  }

  const starts = nodes.filter(node => node.kind === NODE_KIND.START)
  const stages = nodes.filter(node => node.kind === NODE_KIND.STAGE)
  const ends = nodes.filter(node => node.kind === NODE_KIND.END)
  if (starts.length !== 1) invalid(`必须恰好有一个「开始」节点（当前 ${starts.length} 个）`)
  if (stages.length === 0) invalid('流程没有阶段节点，无法编译状态机')
  if (ends.length === 0) invalid('流程没有「结束」节点，状态机没有可达的终态')
  for (const node of stages) {
    if (RESERVED_STATE_IDS.has(node.id)) {
      invalid(`阶段节点 id「${node.id}」与机器的保留状态名冲突（${[...RESERVED_STATE_IDS].join(' / ')}）`)
    }
  }

  for (const edge of edges) {
    if (!edge || typeof edge !== 'object') invalid('flow.edges 里有非对象连线')
    if (edge.kind !== EDGE_KIND.NEXT && edge.kind !== EDGE_KIND.REJECT) {
      invalid(`连线「${String(edge.id)}」的类型「${String(edge.kind)}」不合法：只允许 next / reject`)
    }
    if (!byId.has(edge.from)) invalid(`连线「${String(edge.id)}」的起点 ${String(edge.from)} 不存在`)
    if (!byId.has(edge.to)) invalid(`连线「${String(edge.id)}」的终点 ${String(edge.to)} 不存在`)
  }

  const nextEdges = edges.filter(edge => edge.kind === EDGE_KIND.NEXT)
  const rejectEdges = edges.filter(edge => edge.kind === EDGE_KIND.REJECT)

  // 1) 非 end 节点恰好一条 next 出边（多出边直接判非法，不取最左）。
  const nextOut = new Map()
  for (const node of nodes) {
    if (node.kind === NODE_KIND.END) continue
    const outs = nextEdges.filter(edge => edge.from === node.id)
    if (outs.length !== 1) {
      invalid(outs.length === 0
        ? `「${node.id}」没有 next 出边：是一条断头路`
        : `「${node.id}」有 ${outs.length} 条 next 出边：状态机要求恰好一条`)
    }
    nextOut.set(node.id, outs[0].to)
  }

  // 2) next 边成环 → 非法（打回只走 reject 边，next 图必须是 DAG）。
  const cycle = findNextCycle(nextEdges)
  if (cycle) invalid(`next 边成环：${cycle.join(' → ')}`)

  // 3) 所有节点都要能从 start 沿 next 走到（孤立节点 = 断头路）。
  const start = starts[0]
  for (const node of nodes) {
    if (node.id === start.id) continue
    if (!canReachViaNext(byId, nextEdges, start.id, node.id)) {
      invalid(`「${node.id}」从开始节点沿 next 走不到，是孤立的断头路`)
    }
  }

  // 4) 每个阶段都要能沿 next 走到某个结束节点。
  for (const node of stages) {
    const reachesEnd = ends.some(end => canReachViaNext(byId, nextEdges, node.id, end.id))
    if (!reachesEnd) invalid(`阶段「${node.id}」沿 next 到不了任何结束节点`)
  }

  // 5) reject 边：两端必须是阶段，且目标必须在上游（否则不构成回退）。
  const rejectTargets = new Map()
  for (const edge of rejectEdges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (from.kind !== NODE_KIND.STAGE || to.kind !== NODE_KIND.STAGE) {
      invalid(`打回线「${edge.from} → ${edge.to}」的两端都必须是阶段节点`)
    }
    if (!canReachViaNext(byId, nextEdges, edge.to, edge.from)) {
      invalid(`打回线「${edge.from} → ${edge.to}」的目标不在上游，不构成回退`)
    }
    const list = rejectTargets.get(edge.from) || []
    if (!list.includes(edge.to)) list.push(edge.to)
    rejectTargets.set(edge.from, list)
  }

  // 打回候选按「最靠左」排序：数组第 0 条就是未指定 rejectTarget 时的兜底目标。
  const rejectEdgesByNode = {}
  for (const [nodeId, ids] of rejectTargets) {
    const sorted = [...ids].sort((a, b) => compareLeftmost(byId.get(a), byId.get(b)))
    rejectEdgesByNode[nodeId] = sorted.map(id => id)
  }

  const maxRounds = {}
  for (const node of stages) maxRounds[node.id] = normalizeMaxRounds(node)

  const entryNodeId = nextOut.get(start.id)
  const entryIsEnd = byId.get(entryNodeId).kind === NODE_KIND.END

  return {
    byId,
    stages,
    ends,
    nextOut,
    rejectEdges: rejectEdgesByNode,
    maxRounds,
    entryNodeId,
    entryIsEnd,
    // 排序后的阶段 id：让 meta / 机器描述与 flow 数组书写顺序无关（可复现）。
    stageIds: stages.map(node => node.id).sort(compareText),
  }
}

/** 机器状态名：阶段用 `#<节点 id>`，结束节点统一收敛到 `#done`。 */
function targetOf(byId, nodeId) {
  const node = byId.get(nodeId)
  return node && node.kind === NODE_KIND.END ? '#done' : `#${nodeId}`
}

/** context 初值（§3.3：只放可序列化数据；每次编译新建一个对象）。 */
function initialContext() {
  return {
    attempts: {},
    lastVerdict: null,
    rejectTarget: null,
    currentNodeId: null,
    finishedBy: null,
    reason: null,
    inbox: [],
  }
}

/**
 * 单个阶段状态的 `on`（§3.2 + §4）。
 *
 * REJECT 的候选顺序 = 优先级：
 *   1. 「显式 rejectTarget 命中」且「未超重跑上限」→ 对应上游目标；
 *   2. 超上限 → `#failed`（recordMaxRounds）；
 *   3. 兜底 → 最靠左的上游目标（未指定 rejectTarget 时）。
 */
function buildStageState(plan, node) {
  const nextTarget = targetOf(plan.byId, plan.nextOut.get(node.id))
  const targets = plan.rejectEdges[node.id] || []

  let rejectTransitions
  if (targets.length === 0) {
    // 没有任何打回出边：按 §3.2 严格口径收成失败，不猜「回到上一个节点」。
    rejectTransitions = [{ target: '#failed', actions: ['recordRejectWithoutTarget'] }]
  } else {
    rejectTransitions = [
      ...targets.map(target => ({
        guard: and([`rejectTo:${target}`, `withinMaxRounds:${target}`]),
        target: `#${target}`,
        actions: ['recordReject'],
      })),
      { guard: 'maxRoundsExceeded', target: '#failed', actions: ['recordMaxRounds'] },
      { target: `#${targets[0]}`, actions: ['recordReject'] },
    ]
  }

  return {
    id: node.id,
    on: {
      PASS: [{ target: nextTarget, actions: ['recordPass'] }],
      REJECT: rejectTransitions,
      FAIL: [{ target: '#failed', actions: ['recordFail'] }],
      INBOX: { actions: ['queueInbox'] },
      SELF_CHECK: { actions: ['recordSelfCheck'] },
    },
  }
}

/** 顶层机器描述（纯数据，createMachine 只是把它变成 StateNode 图）。 */
function buildMachineConfig(plan) {
  const stageStates = {}
  for (const node of plan.stages) stageStates[node.id] = buildStageState(plan, node)

  return {
    id: 'flow',
    // 开始节点不是状态：直接进它的 next 目标；若目标就是结束节点，机器一开始就是终态。
    initial: plan.entryIsEnd ? 'done' : 'running',
    context: initialContext(),
    states: {
      running: {
        // entryIsEnd 时 running 永远进不去，这里的 initial 只为让结构合法。
        initial: plan.entryIsEnd ? plan.stageIds[0] : plan.entryNodeId,
        states: stageStates,
        // §5.3：不用 XState 的 after。超时/取消由引擎闹钟发事件进来。
        on: {
          CLOCK_TIMEOUT: { target: '#failed', actions: ['recordTimeout'] },
          CANCEL: { target: '#aborted', actions: ['recordCancel'] },
        },
      },
      done: { id: 'done', type: 'final', output: { victory: true }, entry: ['recordDone'] },
      failed: { id: 'failed', type: 'final' },
      aborted: { id: 'aborted', type: 'final' },
    },
  }
}

function normalizeRunTimeout(runTimeoutMs) {
  return Number.isFinite(runTimeoutMs) && runTimeoutMs > 0 ? Math.floor(runTimeoutMs) : null
}

/**
 * 编译：flow → XState v5 machine（**纯函数，不做 I/O**）。
 *
 * @param {object} flow
 * @param {{ engineVersion?: string|number, runTimeoutMs?: number }} [options]
 * @returns {{
 *   machine: import('./xstate-vendor.js').StateMachine,
 *   version: string,
 *   meta: {
 *     entryNodeId: string,
 *     stageIds: string[],
 *     rejectEdges: Record<string, string[]>,
 *     maxRounds: Record<string, number>,
 *     runTimeoutMs: number|null,
 *   },
 * }}
 */
export function compileFlowToMachine(flow, { engineVersion = '1', runTimeoutMs } = {}) {
  const plan = planFlow(flow)
  const version = machineVersion(flow, { engineVersion })
  const machine = createMachine(buildMachineConfig(plan))
  return {
    machine,
    version,
    meta: {
      entryNodeId: plan.entryNodeId,
      stageIds: [...plan.stageIds],
      // 只列有打回出边的节点；数组已按「最靠左」排序，第 0 条是兜底目标。
      rejectEdges: plan.rejectEdges,
      maxRounds: { ...plan.maxRounds },
      // 仅记录（超时仍由引擎发 CLOCK_TIMEOUT）；null = 不设墙钟。
      runTimeoutMs: normalizeRunTimeout(runTimeoutMs),
    },
  }
}

// ---------------------------------------------------------------------------
// guard / action 参考实现（引擎用 machine.provide 注入；本模块是语义唯一来源）
// ---------------------------------------------------------------------------

function attemptsOf(context, nodeId) {
  const attempts = context && context.attempts
  if (!attempts || typeof attempts !== 'object') return 0
  const used = attempts[nodeId]
  return Number.isInteger(used) && used >= 0 ? used : 0
}

function stringField(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 生成机器需要的全部 guard / action 实现。
 *
 * 为什么放在这里而不是引擎里：`compileFlowToMachine` 是纯函数、机器里只有字符串名，
 * 但「attempts 怎么记、兜底目标是谁、finishedBy 谁写」是状态机语义，不是执行细节。
 * 集中在这里，引擎只负责把 `machine.provide(flowMachineImplementations(meta))` 接上，
 * 再额外挂自己的观测（`machine/transition` 事件等）。
 *
 * 注入的 guard 名：`rejectTo:<目标 id>`、`withinMaxRounds:<目标 id>`、`maxRoundsExceeded`
 * 注入的 action 名：recordPass / recordReject / recordDone / recordFail / recordMaxRounds /
 *   recordRejectWithoutTarget / recordTimeout / recordCancel / queueInbox / recordSelfCheck
 *
 * @param {object} meta `compileFlowToMachine(...).meta`
 * @returns {{ guards: Record<string, Function>, actions: Record<string, unknown> }}
 */
export function flowMachineImplementations(meta) {
  if (!meta || typeof meta !== 'object') {
    throw new TypeError('flowMachineImplementations(meta) 需要 compileFlowToMachine 返回的 meta')
  }
  const rejectEdges = meta.rejectEdges && typeof meta.rejectEdges === 'object' ? meta.rejectEdges : {}
  const maxRounds = meta.maxRounds && typeof meta.maxRounds === 'object' ? meta.maxRounds : {}

  const targetsOf = nodeId => (Array.isArray(rejectEdges[nodeId]) ? rejectEdges[nodeId] : [])
  const limitOf = nodeId => {
    const limit = maxRounds[nodeId]
    return Number.isInteger(limit) && limit >= 1 ? limit : DEFAULT_MAX_ROUNDS
  }
  /** 与机器里 REJECT 候选顺序同口径：显式命中优先，否则最靠左（数组第 0 条）。 */
  const pickTarget = (nodeId, explicit) => {
    const list = targetsOf(nodeId)
    if (list.length === 0) return null
    const wanted = stringField(explicit)
    if (wanted !== null && list.includes(wanted)) return wanted
    return list[0]
  }
  const nodeIdOf = ({ event }) => stringField(event && event.nodeId)

  const guards = {}
  for (const nodeId of Object.keys(rejectEdges)) {
    for (const target of targetsOf(nodeId)) {
      guards[`rejectTo:${target}`] = ({ event }) => Boolean(event)
        && event.type === FLOW_EVENTS.REJECT
        && event.rejectTarget === target
      guards[`withinMaxRounds:${target}`] = ({ context }) =>
        attemptsOf(context, target) < limitOf(target)
    }
  }
  guards.maxRoundsExceeded = ({ context, event }) => {
    const target = pickTarget(event && event.nodeId, event && event.rejectTarget)
    return target !== null && attemptsOf(context, target) >= limitOf(target)
  }

  const actions = {
    // 通过（含进入结束节点）：清掉上一轮的打回痕迹。
    recordPass: assign({
      lastVerdict: () => 'pass',
      rejectTarget: () => null,
      reason: () => null,
      currentNodeId: nodeIdOf,
    }),
    // 打回：attempts 记在**目标**上（与旧主循环「打回目标 attempt+1」一致）。
    recordReject: assign({
      lastVerdict: () => 'reject',
      rejectTarget: ({ event }) => stringField(event && event.rejectTarget),
      reason: ({ event }) => stringField(event && event.reason),
      currentNodeId: nodeIdOf,
      attempts: ({ context, event }) => {
        const base = context && context.attempts && typeof context.attempts === 'object'
          ? context.attempts
          : {}
        const target = pickTarget(event && event.nodeId, event && event.rejectTarget)
        if (target === null) return { ...base }
        return { ...base, [target]: attemptsOf(context, target) + 1 }
      },
    }),
    // 进入 #done：正常收口。
    recordDone: assign({ finishedBy: () => 'pass' }),
    recordFail: assign({
      finishedBy: () => 'fail',
      lastVerdict: () => 'fail',
      rejectTarget: () => null,
      reason: ({ event }) => stringField(event && event.reason),
    }),
    recordMaxRounds: assign({
      finishedBy: () => 'max-rounds',
      lastVerdict: () => 'reject',
      rejectTarget: ({ event }) => {
        const target = pickTarget(event && event.nodeId, event && event.rejectTarget)
        return target === null ? stringField(event && event.rejectTarget) : target
      },
      reason: ({ event }) => {
        const given = stringField(event && event.reason)
        if (given !== null) return given
        const target = pickTarget(event && event.nodeId, event && event.rejectTarget)
        return target === null
          ? '超打回上限'
          : `超打回上限：目标「${target}」已重跑 ${limitOf(target)} 次`
      },
    }),
    recordRejectWithoutTarget: assign({
      finishedBy: () => 'fail',
      lastVerdict: () => 'reject',
      rejectTarget: () => null,
      reason: ({ event }) => stringField(event && event.reason)
        || `节点「${String(event && event.nodeId)}」判定打回，但没有配置任何 reject 边`,
    }),
    recordTimeout: assign({
      finishedBy: () => 'timeout',
      reason: ({ event }) => {
        const given = stringField(event && event.reason)
        if (given !== null) return given
        return event && event.kind === 'node' ? '节点墙钟到点' : 'run 墙钟到点'
      },
    }),
    recordCancel: assign({
      finishedBy: () => 'aborted',
      reason: ({ event }) => stringField(event && event.reason),
    }),
    // 外部消息不改变状态（§4）：只进观测队列，给下一轮提示词用。
    queueInbox: assign({
      inbox: ({ context, event }) => {
        const list = Array.isArray(context && context.inbox) ? context.inbox : []
        const entry = {
          messageId: stringField(event && event.messageId),
          text: typeof (event && event.text) === 'string' ? event.text : '',
        }
        return [...list, entry].slice(-INBOX_LIMIT)
      },
    }),
    // 自审只更新观测字段（§4）；正式结论仍由引擎发 PASS/REJECT/FAIL。
    recordSelfCheck: assign({
      lastVerdict: ({ context, event }) => {
        const verdict = event && event.verdict
        if (VERDICTS.has(verdict)) return verdict
        return context && context.lastVerdict !== undefined ? context.lastVerdict : null
      },
    }),
  }

  return { guards, actions }
}

// ---------------------------------------------------------------------------
// 事件映射与重放（§4 / §6）
// ---------------------------------------------------------------------------

function attemptFrom(event) {
  if (Number.isInteger(event && event.attemptId) && event.attemptId >= 1) return event.attemptId
  const nested = event && event.data && event.data.attempt
  if (Number.isInteger(nested) && nested >= 1) return nested
  return 1
}

/**
 * `node/end` 里的 rejectTarget 可能在四个位置（runlog 顶层、data 顶层、两层嵌套）。
 * 优先级：data.rejectTarget → event.rejectTarget → data.extra.rejectTarget →
 * event.extra.rejectTarget（顶层优先，嵌套兜底）。
 */
function pickRejectTargetFromRunlog(event) {
  const data = event && event.data
  const extraOfData = data && data.extra
  const extraOfEvent = event && event.extra
  const candidates = [
    data && data.rejectTarget,
    event && event.rejectTarget,
    extraOfData && extraOfData.rejectTarget,
    extraOfEvent && extraOfEvent.rejectTarget,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return null
}

/** 失败原因同理：data.reason → event.reason → data.extra.reason → event.extra.reason。 */
function pickReasonFromRunlog(event) {
  const data = event && event.data
  const extraOfData = data && data.extra
  const extraOfEvent = event && event.extra
  const candidates = [
    data && data.reason,
    event && event.reason,
    extraOfData && extraOfData.reason,
    extraOfEvent && extraOfEvent.reason,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return null
}

/**
 * runlog 事件数组 → 状态机事件数组（**与现有事件流的唯一接缝**）。
 *
 *   run/start                          → 无（初始态就是它）
 *   node/end + data.status='passed'    → {type:'PASS', nodeId, attempt}
 *   node/end + data.status='rejected'  → {type:'REJECT', nodeId, attempt, rejectTarget?}
 *   node/end + data.status='failed'    → {type:'FAIL', nodeId, attempt, reason}
 *   run/end  + data.status='aborted'   → {type:'CANCEL'}
 *   其它 kind / status                  → 忽略
 *
 * @param {Array<object>} events
 * @returns {Array<{type: string}>}
 */
export function machineEventsFromRun(events) {
  const list = Array.isArray(events) ? events : []
  const out = []
  for (const event of list) {
    if (!event || typeof event !== 'object') continue

    if (event.kind === NODE_EVENT.END) {
      const status = event.data && event.data.status
      const nodeId = stringField(event.nodeId)
      if (nodeId === null) continue
      const attempt = attemptFrom(event)
      if (status === 'passed') {
        out.push({ type: FLOW_EVENTS.PASS, nodeId, attempt })
      } else if (status === 'rejected') {
        const rejectTarget = pickRejectTargetFromRunlog(event)
        out.push({
          type: FLOW_EVENTS.REJECT,
          nodeId,
          attempt,
          ...(rejectTarget === null ? {} : { rejectTarget }),
        })
      } else if (status === 'failed') {
        out.push({ type: FLOW_EVENTS.FAIL, nodeId, attempt, reason: pickReasonFromRunlog(event) })
      }
      continue
    }

    if (event.kind === RUN_EVENT.END && event.data && event.data.status === RUN_END_ABORTED) {
      out.push({ type: FLOW_EVENTS.CANCEL })
    }
  }
  return out
}

/** 把「机器事件」或「runlog 事件」统一成机器事件；认不出返回 null。 */
function toMachineEvent(raw) {
  if (typeof raw === 'string' && raw !== '') return { type: raw }
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.type === 'string' && raw.type !== '') return raw
  if (typeof raw.kind === 'string' && raw.kind !== '') {
    const mapped = machineEventsFromRun([raw])
    return mapped.length > 0 ? mapped[0] : null
  }
  return null
}

/**
 * 从初态开始重放事件（§6 恢复算法第 2 条）。
 *
 * 注意：machine 必须已经 `.provide(...)` 过实现（guard / action 都是字符串名），
 * 否则第一条转移就会因「guard 未实现」抛错——这是刻意的，别让重放悄悄换语义。
 *
 * @param {object} machine 已注入实现的 machine
 * @param {Array<object|string>} events 状态机事件，或 runlog 事件（自动映射）
 * @param {{ input?: unknown }} [options] 透传给 createActor
 * @returns {{ actor: object, finalValue: unknown, replayed: number }}
 */
export function replayMachine(machine, events, { input } = {}) {
  const actor = createActor(machine, input === undefined ? {} : { input })
  actor.start()
  const list = Array.isArray(events) ? events : []
  let replayed = 0
  for (const raw of list) {
    const event = toMachineEvent(raw)
    if (event === null) continue
    actor.send(event)
    replayed += 1
  }
  return { actor, finalValue: actor.getSnapshot().value, replayed }
}
