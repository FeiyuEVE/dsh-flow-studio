/**
 * 阶段节点会话的模型工具：`flow_node_reject`（v0.9.2 前置 · 任务 2）。
 *
 * 语义：节点主管在一次 attempt **进行中**调用它，宣告本轮打回。它不自己写事件、
 * 不自己选边——只把 `{reason, findings, rejectTarget}` 登记到引擎的「本轮待生效
 * 打回」槽位；本轮 whenIdle 收口时，引擎把这个登记合并进既有的结构化结论
 * （`verdict='reject'`），之后**完全复用**既有通道：
 *   `node/end{status:'rejected'}` → `selectRejectTarget()` → `reject/trigger` →
 *   目标节点 attempt+1 重跑。没有第二套状态，也不新造事件 kind。
 *
 * 门控（由 engine.js 负责，本模块只提供纯判定）：
 *   - 只有**阶段节点**、且当前流程里存在 `from === node.id && kind === 'reject'`
 *     的出向边时才注册；
 *   - 没有出向 reject 边 → 不注册（会话的工具清单里根本不会出现）；
 *   - 开始 / 结束节点不注册；
 *   - 每次 attempt 开始前按**当前流程结构**重算、重挂（旧注册先 dispose）。
 *
 * 本文件不 import engine.js（避免循环依赖）：工具只依赖注入的 `onReject` 回调。
 *
 * @module @feiyueve/dsh-flow-studio/node-tools
 */

import { EDGE_KIND, NODE_KIND } from './model.js'

/** 工具名（对外契约；测试与文档都按这个名字断言）。 */
export const NODE_REJECT_TOOL_NAME = 'flow_node_reject'

/** 打回原因上限（与引擎落 reject/trigger.reason 的 2000 字符口径一致）。 */
export const NODE_REJECT_REASON_MAX = 2000

/** findings 单轮最多接收多少条。 */
export const NODE_REJECT_FINDINGS_MAX = 50

const FINDING_SEVERITIES = new Set(['P0', 'P1', 'P2'])
const FINDING_STATUSES = new Set(['open', 'accepted', 'fixed', 'verified', 'dismissed'])

/**
 * 当前流程里该节点是否有至少一条**出向 reject 边**。
 *
 * 这是工具注册的唯一结构性判据：`structurally` 没有回退目标时，给模型一个
 * 「打回」按钮只会让它点完得到一句「没有 reject 边」——不如根本不给。
 *
 * @param {object} flow
 * @param {string} nodeId
 * @returns {boolean}
 */
export function hasOutgoingRejectEdge(flow, nodeId) {
  if (!flow || typeof flow !== 'object' || !Array.isArray(flow.edges)) return false
  if (typeof nodeId !== 'string' || nodeId === '') return false
  return flow.edges.some(edge => Boolean(edge)
    && edge.from === nodeId
    && edge.kind === EDGE_KIND.REJECT)
}

/**
 * 该节点应当注册打回工具吗？阶段节点 + 有出向 reject 边，缺一不可。
 * @param {object} flow
 * @param {object} node
 * @returns {boolean}
 */
export function shouldRegisterNodeRejectTool(flow, node) {
  return Boolean(node) && node.kind === NODE_KIND.STAGE && hasOutgoingRejectEdge(flow, node.id)
}

/**
 * 该节点的 reject 边目标（按流程里的声明顺序，仅用于工具描述与 `rejectTarget` 校验）。
 * @param {object} flow
 * @param {string} nodeId
 * @returns {string[]}
 */
export function rejectTargetsOf(flow, nodeId) {
  if (!flow || typeof flow !== 'object' || !Array.isArray(flow.edges)) return []
  const out = []
  for (const edge of flow.edges) {
    if (!edge || edge.from !== nodeId || edge.kind !== EDGE_KIND.REJECT) continue
    if (typeof edge.to === 'string' && edge.to !== '' && !out.includes(edge.to)) out.push(edge.to)
  }
  return out
}

/** 可空字符串的输出 schema（模型面字段三态：字符串 / null）。 */
function nullableString(description) {
  return {
    oneOf: [
      { type: 'string', description },
      { type: 'null', description: '未指定（引擎按既有 reject 边规则选目标）' },
    ],
  }
}

/** 统一的人类可读投影：成功与失败都返回一段文本。 */
function renderRejectResult(value) {
  if (!value || typeof value !== 'object') return [{ type: 'text', text: JSON.stringify(value) }]
  if (value.ok !== true) {
    return [{ type: 'text', text: `打回登记失败：${value.error || '未知原因'}` }]
  }
  const target = typeof value.rejectTarget === 'string' && value.rejectTarget !== ''
    ? `，目标 ${value.rejectTarget}`
    : '，目标由引擎按 reject 边规则选择'
  return [{
    type: 'text',
    text: `已登记打回（节点 ${value.nodeId} · attempt ${value.attempt}${target}）。`
      + '本轮结束即按既有 reject 通道回退并重跑目标节点。',
  }]
}

/**
 * 把模型给的 findings 收敛成引擎 `_writeStructured` 能接受的形状。
 *
 * 刻意宽松：模型可能给字符串（「登录页没做校验」），也可能给半结构化对象。
 * 字符串 → `{ severity:'P1', status:'open', title:<字符串> }`；
 * 对象缺 severity/status 时补默认值，非法枚举值一律收敛，避免因为一个 find 字段
 * 把整轮打回变成 StructuredOutputError（打回不该反过来让 run 失败）。
 *
 * @param {unknown} input
 * @param {string} nodeId
 * @returns {object[]}
 */
export function normalizeRejectFindings(input, nodeId = 'node') {
  if (!Array.isArray(input)) return []
  const out = []
  for (let index = 0; index < input.length && out.length < NODE_REJECT_FINDINGS_MAX; index += 1) {
    const raw = input[index]
    const fallbackId = `${nodeId}-reject-${index + 1}`
    if (typeof raw === 'string') {
      const title = raw.trim()
      if (title === '') continue
      out.push({
        id: fallbackId,
        severity: 'P1',
        title: title.slice(0, 512),
        status: 'open',
      })
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const title = typeof raw.title === 'string' && raw.title.trim() !== ''
      ? raw.title.trim().slice(0, 512)
      : (typeof raw.reason === 'string' && raw.reason.trim() !== ''
        ? raw.reason.trim().slice(0, 512)
        : '必填打回问题')
    const finding = {
      id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim().slice(0, 128) : fallbackId,
      severity: FINDING_SEVERITIES.has(raw.severity) ? raw.severity : 'P1',
      title,
      status: FINDING_STATUSES.has(raw.status) ? raw.status : 'open',
    }
    if (typeof raw.category === 'string' && raw.category.trim() !== '') {
      finding.category = raw.category.trim().slice(0, 64)
    }
    out.push(finding)
  }
  return out
}

/**
 * 创建一个 `flow_node_reject` 工具定义（每 attempt / 每会话一份，闭包绑定 attempt）。
 *
 * @param {{
 *   nodeId: string, runId: string, attempt: number, sessionId?: string,
 *   rejectTargets?: string[],
 *   onReject: (payload: {reason: string, findings?: object[], rejectTarget?: string}) =>
 *     {ok: true, rejectTarget?: string} | {ok: false, error: string, hint?: string}
 * }} options
 * @returns {object} DSH ToolDefinition（含 output.schema / render / execute）
 */
export function createNodeRejectTool({
  nodeId, runId, attempt, sessionId, rejectTargets, onReject,
}) {
  const targets = Array.isArray(rejectTargets) ? rejectTargets.filter(item => typeof item === 'string' && item !== '') : []
  const targetHint = targets.length > 0
    ? `可选目标：${targets.join(' / ')}（省略则由引擎按 reject 边规则选）`
    : '省略 rejectTarget（引擎按 reject 边规则选目标）'
  return {
    name: NODE_REJECT_TOOL_NAME,
    description:
      '宣告本节点**本次 attempt 打回**，等价于结构化结论 verdict=reject：'
      + '引擎会按流程里既有的 reject 边选择回退目标（可用 rejectTarget 指定）、写 reject/trigger，'
      + '并让目标节点 attempt+1 重跑。调用后请结束本轮；引擎在本轮 whenIdle 收口时采纳这个登记，'
      + '不需要（也不应该）再编一份 JSON 结论。'
      + `当前节点 ${nodeId} · attempt ${attempt}。`
      + `参数：reason 必填（≤${NODE_REJECT_REASON_MAX} 字）；findings 可选（问题列表）；`
      + `rejectTarget 可选（${targetHint}）。`,
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: `打回原因（必填，≤${NODE_REJECT_REASON_MAX} 字符；会原样写进 reject/trigger.reason）`,
        },
        findings: {
          type: 'array',
          description: `可选：需要返工的问题列表（最多 ${NODE_REJECT_FINDINGS_MAX} 条；字符串或 {severity,title,status} 对象均可）`,
          items: {
            oneOf: [
              { type: 'string' },
              { type: 'object' },
            ],
          },
        },
        rejectTarget: {
          type: 'string',
          description: `可选：指定回退到哪个上游节点（${targetHint}）`,
        },
      },
      required: ['reason'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: '成功为 true；失败为 false（看 error / hint / retryable）' },
          accepted: { type: 'boolean', description: '引擎是否已登记本次打回' },
          nodeId: { type: 'string', description: '节点 id' },
          attempt: { type: 'integer', description: '本次 attempt 编号' },
          runId: { type: 'string', description: 'run id' },
          reason: { type: 'string', description: '已登记的打回原因' },
          rejectTarget: nullableString('已登记的回退目标；null = 交给引擎按 reject 边选择'),
          error: { type: 'string', description: '失败原因（可读中文）' },
          hint: { type: 'string', description: '下一步该做什么' },
          retryable: { type: 'boolean', description: '是否值得重试（参数错误恒为 false）' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: renderRejectResult,
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args : null
      if (!input) {
        return {
          ok: false,
          error: '工具参数必须是一个 JSON 对象',
          hint: '按参数 schema 传 { reason, findings?, rejectTarget? }。',
          retryable: false,
        }
      }
      const rawReason = input.reason
      if (typeof rawReason !== 'string' || rawReason.trim() === '') {
        return {
          ok: false,
          error: '参数 reason 必填，且必须是非空字符串',
          hint: `写清为什么要打回（≤${NODE_REJECT_REASON_MAX} 字）。`,
          retryable: false,
        }
      }
      const reason = rawReason.trim().slice(0, NODE_REJECT_REASON_MAX)
      let rejectTarget
      if (input.rejectTarget !== undefined && input.rejectTarget !== null) {
        if (typeof input.rejectTarget !== 'string') {
          return {
            ok: false,
            error: '参数 rejectTarget 必须是字符串',
            hint: '省略 rejectTarget，或传一个上游节点 id。',
            retryable: false,
          }
        }
        const trimmed = input.rejectTarget.trim()
        if (trimmed !== '') {
          if (!targets.includes(trimmed)) {
            return {
              ok: false,
              error: `rejectTarget「${trimmed}」不是本节点的 reject 边目标`,
              hint: `可用的目标：${targets.join(' / ') || '（无）'}；或省略让引擎自己选。`,
              retryable: false,
            }
          }
          rejectTarget = trimmed
        }
      }
      if (input.findings !== undefined && input.findings !== null && !Array.isArray(input.findings)) {
        return {
          ok: false,
          error: '参数 findings 必须是数组',
          hint: '省略 findings，或传字符串 / 对象数组。',
          retryable: false,
        }
      }
      const findings = normalizeRejectFindings(input.findings, nodeId)
      let result
      try {
        result = onReject({ reason, findings, rejectTarget })
      } catch (error) {
        return {
          ok: false,
          error: `登记打回失败：${error && error.message ? error.message : String(error)}`,
          hint: '这是引擎侧异常；不要反复重试，直接结束本轮并把原因写进正常文本。',
          retryable: false,
        }
      }
      if (!result || result.ok !== true) {
        return {
          ok: false,
          error: result && typeof result.error === 'string' ? result.error : '引擎拒绝了这次打回登记',
          hint: result && typeof result.hint === 'string' ? result.hint : '确认当前 attempt 仍在执行后重试。',
          retryable: false,
        }
      }
      return {
        ok: true,
        accepted: true,
        runId,
        nodeId,
        attempt,
        sessionId: typeof sessionId === 'string' ? sessionId : '',
        reason,
        rejectTarget: rejectTarget ?? null,
        hint: '已登记：结束本轮即可，引擎会按 reject 边回退并让目标节点 attempt+1 重跑。',
      }
    },
  }
}
