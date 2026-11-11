/**
 * 运行日志：事件契约（校验 / 归一化）与聚合口径。
 *
 * 这里是纯函数层，不碰 fs —— 落盘在 `runstore.js`。契约见
 * `docs/design/05-run-log.md`：
 *   - 未知 kind 一律拒绝，不静默存（基础白名单 EVENT_KINDS + INBOX / NODE_STATUS /
 *     MACHINE 三个扩展白名单，校验器接受并集）；
 *   - 必填字段缺失就报错（`usage` 缺桶不补 0）；
 *   - `ts` 非法 / 缺失用服务端时间补齐，并归一成 UTC ISO-8601；
 *   - `extra` 有界（键 ≤16、单串 ≤256、总字节 ≤2048），超限丢弃不报错；
 *   - 聚合确定性计算；单项证据（验收 / 测试 / 规范）保留，0.13.12 起不再产出质量总评分。
 *
 * @module @feiyueve/dsh-flow-studio/runlog
 */

import { Buffer } from 'node:buffer'

/** §2 白名单：v1.0 的 17 种基础事件（不在表里的 kind 一律拒绝）。 */
export const EVENT_KINDS = Object.freeze([
  'run/start',
  'run/end',
  'node/start',
  'node/end',
  'member/start',
  'member/end',
  'model/call',
  'tool/call',
  'skill/load',
  'artifact/write',
  'reject/trigger',
  'review/finding',
  'review/verdict',
  'check/form',
  // 05 §8.2 v1.1 新增：事件契约保留；0.13.12 起不再据此计算质量总评分。
  'acceptance/verdict',
  'test/report',
  // 05 §8.2 v1.2 新增：让客户端看得见 agent 到底说了什么。
  'agent/message',
])

/**
 * 06 §16 扩展白名单：流程收件箱事件。
 *
 * 单独导出而不是直接追加进 `EVENT_KINDS`：`EVENT_KINDS` 是 05 §2 冻结的 v1.0 基础契约
 * （既有单测按 17 种断言长度），收件箱是 v1.6 的扩展事件。校验器接受的是两者的并集。
 */
export const INBOX_EVENT_KINDS = Object.freeze([
  'message/in',
  'message/out',
])

/**
 * v0.8 扩展白名单：节点自审上报的结构化状态（07 §11「节点闹钟」）。
 *
 * 与 `INBOX_EVENT_KINDS` 同理单独列出，不污染 05 §2 冻结的 17 种基础事件。
 * `data` 形状由 `src/supervise.js` 的 `parseNodeStatus` 决定（state / progress /
 * summary / members / blockers / verdict），这里只负责「允许写」。
 */
export const NODE_STATUS_EVENT_KINDS = Object.freeze([
  'node/status',
])

/**
 * 08 §7 扩展白名单：状态机转移观测（`machine/transition`）。
 *
 * 与 `INBOX_EVENT_KINDS` / `NODE_STATUS_EVENT_KINDS` 同理单独列出，不污染 05 §2 冻结的
 * 17 种基础事件（既有单测按长度 17 断言）。校验器接受的是所有扩展白名单的并集。
 *
 * **只作观测**：这条事件不参与 progress / 打回 / 重跑口径，写坏了也不该
 * 影响流程推进。`data` 契约见 `validateData` 的 `case 'machine/transition'`：
 * `from` 可选（≤64，空串 = 没写）、`to` / `event` 必填（≤64）、`version` 可选（≤200）、
 * `attempt` 可选（≥1 的整数，`0` / `1.5` / `'2'` 一律整条拒绝）。
 * 未知 data 键按本文件既有口径保留（前向兼容，体积由 8KB 单条上限兜住）。
 */
export const MACHINE_EVENT_KINDS = Object.freeze([
  'machine/transition',
])

/**
 * 0.10 §2.2 扩展白名单：节点会话「可用工具」快照（`node/tools`，R6）。
 *
 * 与 `INBOX_EVENT_KINDS` / `NODE_STATUS_EVENT_KINDS` / `MACHINE_EVENT_KINDS` 同理单独列出，
 * **不进** 05 §2 冻结的 17 种 `EVENT_KINDS`（既有单测按长度 17 断言）；校验器接受的是
 * 所有扩展白名单的并集。`data` 契约见 `validateData` 的 `case 'node/tools'`：
 * `tools`（字符串数组，去重、排序、≤64 项、每项 1–64 字符、只允许 `[A-Za-z0-9._:-]`）、
 * `toolsSource ∈ {session, unavailable}`、`count === tools.length`、`truncated` 可选布尔。
 * 这条事件回答「这个会话的注册表里有哪些工具」，**不是**「上一轮实际被准入的工具」。
 */
export const NODE_TOOLS_EVENT_KINDS = Object.freeze([
  'node/tools',
])

/** `node/tools.data.tools` 的条数上限。 */
export const NODE_TOOLS_MAX = 64

/** `node/tools.data.tools` 单个工具名的字符数上限。 */
export const NODE_TOOL_NAME_MAX = 64

/** `node/tools.data.tools` 单个工具名的字符集（宽松到能装下 `flow_node_reject`）。 */
export const NODE_TOOL_NAME_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/

/** 单条事件序列化后的上限（字节，不含行尾换行）。 */
export const MAX_EVENT_BYTES = 8 * 1024

/** 单批追加的事件条数上限。 */
export const MAX_BATCH_EVENTS = 200

/** 单个 run 的事件总数上限。 */
export const MAX_RUN_EVENTS = 200000

/** extra 的三个边界。 */
export const MAX_EXTRA_KEYS = 16
export const MAX_EXTRA_STRING = 256
export const MAX_EXTRA_BYTES = 2048

/** runId / nodeId / attemptId / memberId 的字符集（§1）。 */
export const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** 用量四桶（互斥，reasoning 是 output 的子集，不另计）。 */
export const USAGE_BUCKETS = Object.freeze(['input', 'cacheRead', 'cacheWrite', 'output'])

const KIND_SET = new Set([
  ...EVENT_KINDS, ...INBOX_EVENT_KINDS, ...NODE_STATUS_EVENT_KINDS, ...MACHINE_EVENT_KINDS,
  ...NODE_TOOLS_EVENT_KINDS,
])

/**
 * run 级事件写到 run.jsonl；其余都要求 nodeId + attemptId（§1 目录布局）。
 *
 * 06 §16：收件箱消息属于「run 级」事实——消息可能在任何节点启动前到达，
 * 也可能在节点之间流转，所以 message/in、message/out 只要求 runId，不要求
 * nodeId + attemptId；目标/来源节点放在 data.targetNodeId / data.nodeId 里。
 */
const RUN_LEVEL_KINDS = new Set(['run/start', 'run/end', 'message/in', 'message/out'])

const RUN_END_STATUS = new Set(['done', 'aborted', 'failed'])
const NODE_END_STATUS = new Set(['passed', 'rejected', 'failed', 'skipped'])
// 06 §13.10：team 节点的成员由 lead 派发，成员自己上报的结论我们观察不到，
// 引擎收尾只能写 `partial`（= 成员跑过但没有可信结论）。宁可不写，也不伪造 passed/failed。
const MEMBER_END_STATUS = new Set(['passed', 'failed', 'aborted', 'partial'])
const EXEC_MODE = new Set(['single', 'team'])
const ARTIFACT_KIND = new Set(['md', 'diff', 'json', 'log'])
const SEVERITY = new Set(['P0', 'P1', 'P2'])
const FINDING_STATUS = new Set(['open', 'accepted', 'fixed', 'verified', 'dismissed'])
const VERDICT = new Set(['approve', 'reject'])
const CHECK_STATE = new Set(['pass', 'fail', 'skipped', 'na'])
/** §8.2 acceptance/verdict 白名单。 */
const ACCEPTANCE_STATUS = new Set(['pass', 'fail', 'skip', 'na'])
const DECIDED_BY = new Set(['human', 'auto'])
/** 06 §13.8：引擎标记只认 real / stub。 */
export const ENGINE_NAMES = Object.freeze(['real', 'stub'])
const ENGINE_NAME_SET = new Set(ENGINE_NAMES)

/** §8.2：agent/message 的 role 白名单（目前只有 assistant）。 */
const MESSAGE_ROLE = new Set(['assistant'])

/** 07 §11：节点自审上报的状态枚举（与 src/supervise.js 的 parseNodeStatus 一致）。 */
const NODE_STATUS_STATE = new Set(['working', 'done', 'blocked', 'failed'])
const NODE_STATUS_MEMBER_STATE = new Set(['working', 'done', 'blocked'])
const NODE_STATUS_VERDICT = new Set(['pass', 'reject'])
const NODE_STATUS_SOURCE = new Set(['self-check'])
const NODE_STATUS_MAX_MEMBERS = 20
const NODE_STATUS_MAX_BLOCKERS = 20
const NODE_STATUS_MAX_SUMMARY = 2000
const NODE_STATUS_MAX_TEXT = 200
/** 0.10 §2.2：node/tools 的 toolsSource 白名单。 */
const NODE_TOOLS_SOURCE = new Set(['session', 'unavailable'])
/** §8.2：agent/message.data.text 的上限（字符，按 Unicode 码点）。 */
export const AGENT_MESSAGE_MAX_CHARS = 2000
/** §8.3：每个节点保留的最近 agent/message 条数 / 全局总量上限。 */
export const AGENT_ACTIVITY_PER_NODE = 5
export const AGENT_ACTIVITY_TOTAL = 200

/** 06 §16：message/in、message/out 的文本上限（码点；外部输入先截断再落盘）。 */
export const MESSAGE_TEXT_MAX_CHARS = 2000
/** 06 §16：消息来源标识（from）的上限。 */
export const MESSAGE_FROM_MAX_CHARS = 200
/**
 * 06 §16（0.11.1）：收件箱长正文落盘目录（run 目录内的固定子目录）。
 *
 * 正文超过内联阈值时全文写到 `inbox/<messageId>.md`；事件 / messages.jsonl 只放
 * 头部，靠 `bodyPath` + `bodyChars` 指回全文。目录 0700、文件 0600。
 */
export const MESSAGE_BODY_DIR = 'inbox'
/**
 * 06 §16（0.11.1）：长正文落盘的硬上限（字符，按码点）。
 *
 * 与 `src/inbox.js` 的 `MESSAGE_BODY_HARD_MAX_CHARS` 同源（那边是 import 本常量
 * 再导出的别名）：runlog 不能 import inbox（inbox → runlog 已存在，会成环）。
 * 超限由入口返回可读 400，绝不静默截断。
 */
export const MESSAGE_BODY_CHARS_MAX = 200000
/** 06 §16：消息级回复目标的 kind 白名单。 */
const MESSAGE_REPLY_KIND = new Set(['session', 'http', 'none'])
/** 06 §16：message/out.delivery 白名单。 */
export const MESSAGE_DELIVERY_KINDS = Object.freeze(['session', 'http', 'local'])
const MESSAGE_DELIVERY = new Set(MESSAGE_DELIVERY_KINDS)

/** 08 §7：machine/transition 的 from / to / event 长度上限（与节点 id 同口径）。 */
export const MACHINE_TRANSITION_MAX_CHARS = 64
/** 08 §7：状态机版本哈希的长度上限（与 `run.json.machine.version` 同口径）。 */
export const MACHINE_VERSION_MAX_CHARS = 200

/** 顶层保留字段；其余未识别字段折叠进有界的 `extra`。 */
const RESERVED_FIELDS = new Set([
  'v', 'ts', 'kind', 'runId', 'nodeId', 'attemptId', 'memberId',
  'traceId', 'data', 'ref', 'extra', 'seq',
])

const SEVERITY_ORDER = ['P0', 'P1', 'P2']

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(field, reason) {
  return { ok: false, field, reason }
}

/**
 * 校验一个 id（runId / nodeId / memberId）。除了契约给的字符集，还挡掉
 * `.`、`..` 与点开头（会撞 `.index` / `.tmp` 这类内部命名），防路径穿越。
 * @param {unknown} value
 * @returns {string | null} 合法时原样返回，否则 null
 */
export function checkRunId(value) {
  if (typeof value !== 'string') return null
  if (!ID_PATTERN.test(value)) return null
  if (value === '.' || value === '..') return null
  if (value.startsWith('.')) return null
  return value
}

/**
 * 成员 id。06 §4.2 规定 `memberId = <nodeId>:<序号>`，冒号不进 run/node 的
 * 路径字符集（`memberId` 只出现在事件里，不参与落盘路径），所以这里单独放宽一个
 * 字符，其余规则（长度、拒绝 `.` / 点开头）与 {@link checkRunId} 一致。
 * @param {unknown} value
 * @returns {string | null}
 */
export function checkMemberId(value) {
  if (typeof value !== 'string') return null
  if (value.length < 1 || value.length > 64) return null
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) return null
  if (value === '.' || value === '..') return null
  if (value.startsWith('.')) return null
  return value
}

/**
 * artifact 路径必须是 run 目录内的相对路径：拒绝绝对路径、`..` 段、反斜杠与空段。
 * @param {unknown} value
 */
export function isSafeRelPath(value) {
  if (typeof value !== 'string' || value === '' || value.length > 512) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (value.includes('\0') || value.includes('\\')) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * 06 §16（0.11.1）：消息全文指针 `bodyPath` 的严格形状。
 *
 * 比 `isSafeRelPath` 再收一层：必须恰好是 `inbox/<文件名>.md`（单层、无子目录）。
 * 收件箱正文是引擎自己写的固定布局，不猜、不放开任意 run 内路径——消息里的
 * `bodyPath` 来自外部请求 / 旧数据，宽一点就是一条读文件原语。
 *
 * @param {unknown} value
 */
export function isSafeInboxBodyPath(value) {
  if (!isSafeRelPath(value)) return false
  const prefix = `${MESSAGE_BODY_DIR}/`
  if (!value.startsWith(prefix)) return false
  const name = value.slice(prefix.length)
  if (name === '' || name.includes('/')) return false
  return name.endsWith('.md')
}

function checkTraceId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 128) return null
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  return trimmed
}

function normalizeTs(value, now) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return now.toISOString()
}

/**
 * extra 有界化：只保留标量、丢弃超长字符串与嵌套值，键数 / 总字节超限就停。
 * 从不抛错（§2 的「超限丢弃不报错」）。
 * @param {Record<string, unknown>} source
 */
function boundExtra(source) {
  const out = {}
  let kept = 0
  // 只看前 64 个键：extra 本身最多 16 个，扫过多只会放大恶意输入的成本。
  for (const [key, value] of Object.entries(source).slice(0, 64)) {
    if (kept >= MAX_EXTRA_KEYS) break
    if (typeof key !== 'string' || key === '') continue
    let scalar
    if (typeof value === 'string') {
      if (value.length > MAX_EXTRA_STRING) continue
      scalar = value
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue
      scalar = value
    } else if (typeof value === 'boolean' || value === null) {
      scalar = value
    } else {
      continue
    }
    const candidate = { ...out, [key]: scalar }
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_EXTRA_BYTES) continue
    out[key] = scalar
    kept += 1
  }
  return out
}

function normalizeRef(value) {
  if (!isPlainObject(value)) return fail('ref', 'ref 必须是 JSON 对象')
  const out = {}
  if (value.sessionId !== undefined && value.sessionId !== null) {
    if (typeof value.sessionId !== 'string' || value.sessionId.trim() === '' || value.sessionId.length > 128) {
      return fail('ref.sessionId', '必须是非空字符串（≤128 字符）')
    }
    out.sessionId = value.sessionId
  }
  if (value.logLine !== undefined && value.logLine !== null) {
    if (!Number.isInteger(value.logLine) || value.logLine < 0) {
      return fail('ref.logLine', '必须是非负整数')
    }
    out.logLine = value.logLine
  }
  // §8.1：可选；没有就只显示文字引用，不假装是可点击链接。
  if (value.url !== undefined && value.url !== null) {
    if (typeof value.url !== 'string' || value.url.trim() === '' || value.url.length > 512) {
      return fail('ref.url', '必须是非空字符串（≤512 字符）')
    }
    out.url = value.url
  }
  if (Object.keys(out).length === 0) return fail('ref', '至少要给 sessionId / logLine / url 之一')
  return { ok: true, value: out }
}

function normalizeUsage(value) {
  if (!isPlainObject(value)) return { ok: false, key: null, reason: 'usage 必须是 JSON 对象' }
  const usage = {}
  for (const key of USAGE_BUCKETS) {
    const bucket = value[key]
    if (bucket === undefined || bucket === null) {
      return { ok: false, key, reason: '缺少必填桶（不补 0）' }
    }
    if (!Number.isInteger(bucket) || bucket < 0 || bucket > Number.MAX_SAFE_INTEGER) {
      return { ok: false, key, reason: '必须是非负整数' }
    }
    usage[key] = bucket
  }
  if (value.reasoning !== undefined && value.reasoning !== null) {
    const reasoning = value.reasoning
    if (!Number.isInteger(reasoning) || reasoning < 0 || reasoning > Number.MAX_SAFE_INTEGER) {
      return { ok: false, key: 'reasoning', reason: '必须是非负整数' }
    }
    if (reasoning > usage.output) {
      return { ok: false, key: 'reasoning', reason: 'reasoning 是 output 的子集，不能大于 output' }
    }
    usage.reasoning = reasoning
  }
  return { ok: true, usage }
}

function strField(data, key, { required = true, max = 256 } = {}) {
  const value = data[key]
  if (value === undefined || value === null) {
    return required ? { ok: false, reason: '缺少必填字段' } : { ok: true, present: false }
  }
  if (typeof value !== 'string') return { ok: false, reason: '必须是字符串' }
  if (value.trim() === '') return { ok: false, reason: '不能为空字符串' }
  if (value.length > max) return { ok: false, reason: `超过 ${max} 字符` }
  return { ok: true, value, present: true }
}

/** 按 Unicode 码点截断（外部文本有界化的唯一口径）。 */
function clipCodePoints(value, max) {
  const chars = Array.from(String(value ?? ''))
  if (chars.length <= max) return chars.join('')
  if (max <= 1) return chars.slice(0, max).join('')
  return `${chars.slice(0, max - 1).join('')}…`
}

/** 06 §16：消息 id（不参与路径，但沿用 runId 的字符集与长度上限）。 */
function idField(value) {
  if (value === undefined || value === null) return { ok: false, reason: '缺少必填字段' }
  if (typeof value !== 'string') return { ok: false, reason: '必须是字符串' }
  if (value.trim() === '') return { ok: false, reason: '不能为空字符串' }
  if (value.length > 128) return { ok: false, reason: '超过 128 字符' }
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, reason: '不能包含控制字符' }
  return { ok: true, value }
}

/** 06 §16：消息正文必填、非空，超过上限就按码点截断（外部输入有界）。 */
function messageTextField(value) {
  if (value === undefined || value === null) return { ok: false, reason: '缺少必填字段' }
  if (typeof value !== 'string') return { ok: false, reason: '必须是字符串' }
  if (value.trim() === '') return { ok: false, reason: '不能为空字符串' }
  return { ok: true, value: clipCodePoints(value, MESSAGE_TEXT_MAX_CHARS) }
}

/** 06 §16（0.11.1）：可选 `bodyPath`（收件箱全文指针）。 */
function bodyPathField(value) {
  if (value === undefined || value === null) return { ok: true, present: false }
  if (!isSafeInboxBodyPath(value)) {
    return { ok: false, reason: `必须是 ${MESSAGE_BODY_DIR}/<文件名>.md 的安全相对路径（禁止绝对路径与 .. 段）` }
  }
  return { ok: true, value, present: true }
}

/** 06 §16（0.11.1）：可选 `bodyChars`（全文字数，正整数）。 */
function bodyCharsField(value) {
  if (value === undefined || value === null) return { ok: true, present: false }
  if (!Number.isInteger(value) || value < 1 || value > MESSAGE_BODY_CHARS_MAX) {
    return { ok: false, reason: `必须是 1..${MESSAGE_BODY_CHARS_MAX} 的整数` }
  }
  return { ok: true, value, present: true }
}

function strArrayField(data, key, { required = true, maxItems = 12, maxLen = 64 } = {}) {
  const value = data[key]
  if (value === undefined || value === null) {
    return required ? { ok: false, reason: '缺少必填字段' } : { ok: true, present: false }
  }
  if (!Array.isArray(value)) return { ok: false, reason: '必须是字符串数组' }
  if (value.length > maxItems) return { ok: false, reason: `最多 ${maxItems} 项` }
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') return { ok: false, reason: '每一项都必须是非空字符串' }
    if (item.length > maxLen) return { ok: false, reason: `单项不超过 ${maxLen} 字符` }
    out.push(item)
  }
  return { ok: true, value: out, present: true }
}

/**
 * 逐 kind 校验 data，并把已识别的字段归一化写回；未知 data 字段保留（前向兼容，
 * 事件总字节上限会兜住体积）。
 * @param {string} kind
 * @param {Record<string, unknown>} data
 */
function validateData(kind, data) {
  const out = { ...data }
  const err = (key, reason) => ({ ok: false, field: key ? `data.${key}` : 'data', reason })
  const putOptionalEnum = (key, allowed) => {
    const value = data[key]
    if (value === undefined || value === null) {
      delete out[key]
      return null
    }
    if (typeof value !== 'string' || !allowed.has(value)) {
      return err(key, `取值必须是 ${[...allowed].join(' / ')}`)
    }
    out[key] = value
    return null
  }

  const putStr = (key, max = 256, required = true) => {
    const result = strField(data, key, { required, max })
    if (!result.ok) return err(key, result.reason)
    if (result.present) out[key] = result.value
    else delete out[key]
    return null
  }
  /**
   * 可选字符串，但**空串 / 纯空白视为「没写」**（不整条拒绝）。
   * 用于纯观测字段（machine/transition 的 from / version）：引擎没值时写空串是很自然
   * 的事，不该因此丢一条观测事件；非空则按 putStr 的同一口径校验（类型 / 长度）。
   */
  const putOptionalText = (key, max = 256) => {
    const value = data[key]
    if (typeof value === 'string' && value.trim() === '') {
      delete out[key]
      return null
    }
    return putStr(key, max, false)
  }
  const putEnum = (key, allowed) => {
    const value = data[key]
    if (value === undefined || value === null) return err(key, '缺少必填字段')
    if (typeof value !== 'string' || !allowed.has(value)) {
      return err(key, `取值必须是 ${[...allowed].join(' / ')}`)
    }
    out[key] = value
    return null
  }
  const putInt = (key, { required = true, min = 0 } = {}) => {
    const value = data[key]
    if (value === undefined || value === null) {
      if (required) return err(key, '缺少必填字段')
      delete out[key]
      return null
    }
    if (!Number.isInteger(value) || value < min || value > Number.MAX_SAFE_INTEGER) {
      return err(key, `必须是 ≥${min} 的整数`)
    }
    out[key] = value
    return null
  }
  const putNum = (key, { required = true, min = 0 } = {}) => {
    const value = data[key]
    if (value === undefined || value === null) {
      if (required) return err(key, '缺少必填字段')
      delete out[key]
      return null
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
      return err(key, `必须是 ≥${min} 的有限数字`)
    }
    out[key] = value
    return null
  }
  const putBool = (key, { required = true } = {}) => {
    const value = data[key]
    if (value === undefined || value === null) {
      if (required) return err(key, '缺少必填字段')
      delete out[key]
      return null
    }
    if (typeof value !== 'boolean') return err(key, '必须是布尔值')
    out[key] = value
    return null
  }

  switch (kind) {
    case 'run/start': {
      let bad = putStr('flowId', 128) || putStr('flowName', 200) || putInt('nodeTotal', { min: 0 })
      if (bad) return bad
      // 06 §13.8：run/start.data.engine 让读事件的人也能看出是不是桩。
      bad = putOptionalEnum('engine', ENGINE_NAME_SET)
      if (bad) return bad
      break
    }
    case 'run/end': {
      let bad = putEnum('status', RUN_END_STATUS)
      if (bad) return bad
      bad = putStr('reason', 2000, false)
      if (bad) return bad
      break
    }
    case 'node/start': {
      let bad = putStr('title', 512) || putEnum('mode', EXEC_MODE)
      if (bad) return bad
      bad = putStr('model', 128, false)
      if (bad) return bad
      const skills = strArrayField(data, 'skills', { required: true, maxItems: 12, maxLen: 64 })
      if (!skills.ok) return err('skills', skills.reason)
      out.skills = skills.value
      break
    }
    case 'node/end': {
      let bad = putEnum('status', NODE_END_STATUS)
      if (bad) return bad
      bad = putNum('durationMs', { min: 0 })
      if (bad) return bad
      break
    }
    case 'member/start': {
      let bad = putStr('name', 200)
      if (bad) return bad
      bad = putStr('role', 64, false) || putStr('model', 128, false)
      if (bad) return bad
      break
    }
    case 'member/end': {
      // §8.1：status 白名单收窄（原来接受任意 ≤32 字符字符串）。
      let bad = putEnum('status', MEMBER_END_STATUS)
      if (bad) return bad
      bad = putNum('durationMs', { min: 0 })
      if (bad) return bad
      break
    }
    case 'model/call': {
      let bad = putStr('provider', 128) || putStr('model', 128)
      if (bad) return bad
      const usage = normalizeUsage(data.usage)
      if (!usage.ok) {
        return err(usage.key ? `usage.${usage.key}` : 'usage', usage.reason)
      }
      out.usage = usage.usage
      // §8.1：callId 必填（同一次调用的重试共用同一个 callId）。
      bad = putStr('callId', 128)
      if (bad) return bad
      bad = putStr('stopReason', 128, false)
      if (bad) return bad
      break
    }
    case 'agent/message': {
      // §8.2：assistant 消息摘录。text 必填非空且 ≤2000 码点（引擎截断后再落盘）。
      let bad = putEnum('role', MESSAGE_ROLE)
      if (bad) return bad
      bad = putStr('text', AGENT_MESSAGE_MAX_CHARS) || putBool('truncated')
      if (bad) return bad
      bad = putStr('provider', 128, false) || putStr('model', 128, false)
      if (bad) return bad
      break
    }
    case 'tool/call': {
      let bad = putStr('name', 200)
      if (bad) return bad
      bad = putStr('argumentsDigest', 512, false)
      if (bad) return bad
      bad = putBool('ok')
      if (bad) return bad
      bad = putNum('durationMs', { required: false, min: 0 })
      if (bad) return bad
      break
    }
    case 'skill/load': {
      let bad = putStr('skill', 128) || putBool('ok')
      if (bad) return bad
      break
    }
    case 'artifact/write': {
      const path = data.path
      if (path === undefined || path === null) return err('path', '缺少必填字段')
      if (!isSafeRelPath(path)) return err('path', '必须是 run 目录内的相对路径（禁止绝对路径与 .. 段）')
      out.path = path
      let bad = putInt('bytes', { min: 0 }) || putEnum('kind', ARTIFACT_KIND)
      if (bad) return bad
      // §8.1：sha256 可选但推荐；给了就校验成 64 位十六进制，没给由展示层标注「未校验」。
      if (data.sha256 !== undefined && data.sha256 !== null) {
        if (typeof data.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(data.sha256)) {
          return err('sha256', '必须是 64 位十六进制摘要')
        }
        out.sha256 = data.sha256.toLowerCase()
      }
      break
    }
    case 'reject/trigger': {
      let bad = putStr('edgeId', 128)
      if (bad) return bad
      for (const key of ['fromNodeId', 'toNodeId']) {
        const value = data[key]
        if (typeof value !== 'string' || !checkRunId(value)) {
          return err(key, '必须是合法的节点 id')
        }
        out[key] = value
      }
      bad = putStr('reason', 2000)
      if (bad) return bad
      break
    }
    case 'review/finding': {
      let bad = putStr('id', 128) || putEnum('severity', SEVERITY)
      if (bad) return bad
      bad = putStr('category', 64, false) || putStr('title', 512)
      if (bad) return bad
      bad = putEnum('status', FINDING_STATUS)
      if (bad) return bad
      break
    }
    case 'review/verdict': {
      let bad = putEnum('verdict', VERDICT) || putInt('findingCount', { min: 0 })
      if (bad) return bad
      break
    }
    case 'check/form': {
      let bad = putStr('ruleSetId', 128) || putStr('executor', 128)
      if (bad) return bad
      const version = data.ruleSetVersion
      if (version === undefined || version === null) return err('ruleSetVersion', '缺少必填字段')
      if (typeof version !== 'string' && typeof version !== 'number') {
        return err('ruleSetVersion', '必须是字符串或数字')
      }
      if (typeof version === 'number' && !Number.isFinite(version)) {
        return err('ruleSetVersion', '必须是有限数字')
      }
      const versionText = String(version)
      if (versionText.trim() === '' || versionText.length > 128) {
        return err('ruleSetVersion', '必须是非空字符串（≤128 字符）')
      }
      out.ruleSetVersion = versionText
      bad = putEnum('state', CHECK_STATE)
      if (bad) return bad
      bad = putInt('passedChecks', { required: false, min: 0 })
        || putInt('totalChecks', { required: false, min: 0 })
        || putStr('reportRef', 512, false)
        || putStr('executedAt', 64, false)
      if (bad) return bad
      if (out.passedChecks !== undefined && out.totalChecks !== undefined
        && out.passedChecks > out.totalChecks) {
        return err('passedChecks', '不能大于 totalChecks')
      }
      break
    }
    case 'acceptance/verdict': {
      // §8.2：itemId 在 run 内唯一（聚合按 itemId 取 seq 最大者）。
      let bad = putStr('itemId', 128) || putEnum('status', ACCEPTANCE_STATUS) || putEnum('decidedBy', DECIDED_BY)
      if (bad) return bad
      bad = putStr('evidenceRef', 512, false) || putStr('decidedAt', 64, false)
      if (bad) return bad
      break
    }
    case 'test/report': {
      let bad = putStr('suite', 128)
        || putInt('executed', { min: 0 })
        || putInt('passed', { min: 0 })
        || putInt('failed', { min: 0 })
        || putInt('skipped', { min: 0 })
      if (bad) return bad
      bad = putStr('reportRef', 512, false)
      if (bad) return bad
      const failures = strArrayField(data, 'failures', { required: false, maxItems: 50, maxLen: 200 })
      if (!failures.ok) return err('failures', failures.reason)
      if (failures.present) out.failures = failures.value
      break
    }
    case 'message/in': {
      // 06 §16：字段白名单严格收窄（未知字段丢弃）。
      const id = idField(data.id)
      if (!id.ok) return err('id', id.reason)
      const from = strField(data, 'from', { required: true, max: MESSAGE_FROM_MAX_CHARS })
      if (!from.ok) return err('from', from.reason)
      const text = messageTextField(data.text)
      if (!text.ok) return err('text', text.reason)
      const out2 = { id: id.value, from: from.value, text: text.value }
      if (data.targetNodeId !== undefined && data.targetNodeId !== null) {
        if (typeof data.targetNodeId !== 'string' || !checkRunId(data.targetNodeId)) {
          return err('targetNodeId', '必须是合法的节点 id')
        }
        out2.targetNodeId = data.targetNodeId
      }
      if (data.replyKind !== undefined && data.replyKind !== null) {
        if (typeof data.replyKind !== 'string' || !MESSAGE_REPLY_KIND.has(data.replyKind)) {
          return err('replyKind', `取值必须是 ${[...MESSAGE_REPLY_KIND].join(' / ')}`)
        }
        out2.replyKind = data.replyKind
      }
      // 0.11.1：长正文落盘后只放头部，全文字数与指针必须一起放行。
      const bodyPath = bodyPathField(data.bodyPath)
      if (!bodyPath.ok) return err('bodyPath', bodyPath.reason)
      if (bodyPath.present) out2.bodyPath = bodyPath.value
      const bodyChars = bodyCharsField(data.bodyChars)
      if (!bodyChars.ok) return err('bodyChars', bodyChars.reason)
      if (bodyChars.present) out2.bodyChars = bodyChars.value
      for (const key of Object.keys(out)) delete out[key]
      Object.assign(out, out2)
      break
    }
    case 'message/out': {
      const id = idField(data.id)
      if (!id.ok) return err('id', id.reason)
      const text = messageTextField(data.text)
      if (!text.ok) return err('text', text.reason)
      const out2 = { id: id.value, text: text.value }
      if (data.inReplyTo !== undefined && data.inReplyTo !== null) {
        if (typeof data.inReplyTo !== 'string' || data.inReplyTo.trim() === '' || data.inReplyTo.length > 128) {
          return err('inReplyTo', '必须是非空字符串（≤128 字符）')
        }
        out2.inReplyTo = data.inReplyTo
      }
      if (data.nodeId !== undefined && data.nodeId !== null) {
        if (typeof data.nodeId !== 'string' || !checkRunId(data.nodeId)) {
          return err('nodeId', '必须是合法的节点 id')
        }
        out2.nodeId = data.nodeId
      }
      const delivery = data.delivery
      if (delivery === undefined || delivery === null) return err('delivery', '缺少必填字段')
      if (typeof delivery !== 'string' || !MESSAGE_DELIVERY.has(delivery)) {
        return err('delivery', `取值必须是 ${[...MESSAGE_DELIVERY].join(' / ')}`)
      }
      out2.delivery = delivery
      // 0.11.1：回复同样允许带全文指针（当前由 inbox 只对入站落盘，但 schema 不再丢字段）。
      const bodyPath = bodyPathField(data.bodyPath)
      if (!bodyPath.ok) return err('bodyPath', bodyPath.reason)
      if (bodyPath.present) out2.bodyPath = bodyPath.value
      const bodyChars = bodyCharsField(data.bodyChars)
      if (!bodyChars.ok) return err('bodyChars', bodyChars.reason)
      if (bodyChars.present) out2.bodyChars = bodyChars.value
      for (const key of Object.keys(out)) delete out[key]
      Object.assign(out, out2)
      break
    }
    case 'node/status': {
      // 07 §11：节点闹钟采集到的结构化完成状态。state/progress 必填，其余可选但有界。
      let bad = putEnum('state', NODE_STATUS_STATE)
      if (bad) return bad
      bad = putInt('progress', { min: 0 })
      if (bad) return bad
      if (out.progress > 100) return err('progress', '必须在 0..100 之间')
      bad = putStr('summary', NODE_STATUS_MAX_SUMMARY, false)
      if (bad) return bad
      bad = putOptionalEnum('verdict', NODE_STATUS_VERDICT)
      if (bad) return bad
      bad = putOptionalEnum('source', NODE_STATUS_SOURCE)
      if (bad) return bad
      if (data.nodeId !== undefined && data.nodeId !== null) {
        if (typeof data.nodeId !== 'string' || !checkRunId(data.nodeId)) {
          return err('nodeId', '必须是合法的节点 id')
        }
        out.nodeId = data.nodeId
      }
      if (data.attempt !== undefined && data.attempt !== null) {
        if (!Number.isInteger(data.attempt) || data.attempt < 1) return err('attempt', '必须是 ≥1 的整数')
        out.attempt = data.attempt
      }
      if (data.members !== undefined && data.members !== null) {
        if (!Array.isArray(data.members)) return err('members', '必须是数组')
        if (data.members.length > NODE_STATUS_MAX_MEMBERS) {
          return err('members', `最多 ${NODE_STATUS_MAX_MEMBERS} 条`)
        }
        const members = []
        for (const member of data.members) {
          if (!member || typeof member !== 'object' || Array.isArray(member)) {
            return err('members', '每一条都必须是对象')
          }
          const name = typeof member.name === 'string' ? member.name.slice(0, NODE_STATUS_MAX_TEXT) : ''
          const note = typeof member.note === 'string' ? member.note.slice(0, NODE_STATUS_MAX_TEXT) : ''
          const state = NODE_STATUS_MEMBER_STATE.has(member.state) ? member.state : 'working'
          members.push({ name, state, ...(note !== '' ? { note } : {}) })
        }
        out.members = members
      }
      if (data.blockers !== undefined && data.blockers !== null) {
        if (!Array.isArray(data.blockers)) return err('blockers', '必须是数组')
        if (data.blockers.length > NODE_STATUS_MAX_BLOCKERS) {
          return err('blockers', `最多 ${NODE_STATUS_MAX_BLOCKERS} 条`)
        }
        const blockers = []
        for (const blocker of data.blockers) {
          if (typeof blocker !== 'string' || blocker.trim() === '') {
            return err('blockers', '每一项都必须是非空字符串')
          }
          blockers.push(blocker.slice(0, NODE_STATUS_MAX_TEXT))
        }
        out.blockers = blockers
      }
      break
    }
    case 'machine/transition': {
      // 08 §7：状态机转移的观测事件。节点级事件（顶层 nodeId + attemptId 仍由
      // normalizeEvent 要求），data 里的 from / to 是**机器状态名**（阶段节点 id 或
      // #running / #done / #failed / #aborted），所以只按有界字符串校验，不套 run id 字符集。
      // from 可选：起点是初始态（#running 的 initial）时没有「上一个节点」，空串按没写处理。
      let bad = putOptionalText('from', MACHINE_TRANSITION_MAX_CHARS)
      if (bad) return bad
      bad = putStr('to', MACHINE_TRANSITION_MAX_CHARS)
        || putStr('event', MACHINE_TRANSITION_MAX_CHARS)
      if (bad) return bad
      // 版本哈希：与 run.json.machine.version 同口径（≤200）；空串同样视为没写。
      bad = putOptionalText('version', MACHINE_VERSION_MAX_CHARS)
      if (bad) return bad
      // 与本文件其它 attempt 同口径：只认 ≥1 的整数，0 / 1.5 / '2' 一律整条拒绝
      // （观测事件也不做隐式字符串转数字，免得日志里出现两种类型）。
      bad = putInt('attempt', { required: false, min: 1 })
      if (bad) return bad
      // 未知 data 键按 validateData 顶部 `out = { ...data }` 的既有口径保留（前向兼容，
      // 单条 8KB 上限兜住体积）；message/in、message/out 的严格白名单是例外，不照抄。
      break
    }
    case 'node/tools': {
      // 0.10 §2.2（R6）：节点会话的可用工具快照。契约是「引擎采集端已经去重 + 排序」，
      // 但校验器仍按硬判据整条拒绝坏输入（重复 / 超量 / 非法字符），不做静默清洗。
      const tools = data.tools
      if (!Array.isArray(tools)) return err('tools', '必须是字符串数组')
      if (tools.length > NODE_TOOLS_MAX) return err('tools', `最多 ${NODE_TOOLS_MAX} 项`)
      const seen = new Set()
      for (const item of tools) {
        if (typeof item !== 'string' || item.trim() === '') {
          return err('tools', '每一项都必须是非空字符串')
        }
        if (item.length > NODE_TOOL_NAME_MAX) return err('tools', `单项不超过 ${NODE_TOOL_NAME_MAX} 字符`)
        if (!NODE_TOOL_NAME_PATTERN.test(item)) {
          return err('tools', '工具名只允许 [A-Za-z0-9._:-]')
        }
        if (seen.has(item)) return err('tools', `不允许重复的工具名：${item}`)
        seen.add(item)
      }
      out.tools = [...tools]
      let bad = putEnum('toolsSource', NODE_TOOLS_SOURCE)
      if (bad) return bad
      bad = putInt('count', { min: 0 })
      if (bad) return bad
      if (out.count !== tools.length) {
        return err('count', `必须等于 tools.length（${tools.length}）`)
      }
      bad = putBool('truncated', { required: false })
      if (bad) return bad
      break
    }
    default:
      // 白名单已挡过，这里只是防御式兜底。
      return err('', `未实现的 kind：${kind}`)
  }
  return { ok: true, data: out }
}

/**
 * 校验并归一化一条事件。
 *
 * @param {unknown} raw 客户端给的事件
 * @param {{ runId?: string, now?: Date }} [ctx] 上下文：URL 里的 runId 与服务端时间
 * @returns {{ ok: true, event: Record<string, unknown> } | { ok: false, field: string, reason: string }}
 */
export function normalizeEvent(raw, ctx = {}) {
  if (!isPlainObject(raw)) return fail('event', '事件必须是 JSON 对象')
  if (raw.v !== 1) return fail('v', 'v 必须为 1（当前事件格式版本）')
  const kind = raw.kind
  if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
    return fail('kind', `未知事件类型：${String(kind)}（白名单见 EVENT_KINDS）`)
  }

  // runId：事件里给了就必须与 URL 一致；没给就用 URL 的（服务端上下文补全）。
  if (raw.runId !== undefined && raw.runId !== null
    && typeof ctx.runId === 'string' && ctx.runId !== '' && raw.runId !== ctx.runId) {
    return fail('runId', `与请求路径中的 runId（${ctx.runId}）不一致`)
  }
  const runId = checkRunId(raw.runId === undefined || raw.runId === null ? ctx.runId : raw.runId)
  if (!runId) {
    return fail('runId', '非法 runId（只允许字母、数字、点、下划线、连字符，1–64 位，且不能以点开头）')
  }

  const nodeLevel = !RUN_LEVEL_KINDS.has(kind)
  // §8.1：run 级事件（只有 run/start、run/end）带 nodeId/attemptId 要 400，
  // 否则会污染节点索引；其余 kind 必须同时带 nodeId + attemptId。
  if (!nodeLevel) {
    if (raw.nodeId !== undefined && raw.nodeId !== null) {
      return fail('nodeId', 'run 级事件（run/start、run/end）不能带 nodeId')
    }
    if (raw.attemptId !== undefined && raw.attemptId !== null) {
      return fail('attemptId', 'run 级事件（run/start、run/end）不能带 attemptId')
    }
  }
  let nodeId = null
  if (raw.nodeId !== undefined && raw.nodeId !== null) {
    nodeId = checkRunId(raw.nodeId)
    if (!nodeId) return fail('nodeId', '非法 nodeId（只允许字母、数字、点、下划线、连字符，1–64 位）')
  }
  if (nodeLevel && nodeId === null) return fail('nodeId', '节点事件必须带 nodeId')

  let attemptId = null
  if (raw.attemptId !== undefined && raw.attemptId !== null) {
    if (!Number.isInteger(raw.attemptId) || raw.attemptId < 1 || raw.attemptId > Number.MAX_SAFE_INTEGER) {
      return fail('attemptId', '必须是从 1 开始的正整数')
    }
    attemptId = raw.attemptId
  }
  if (nodeLevel && attemptId === null) return fail('attemptId', '节点事件必须带正整数 attemptId')

  let memberId = raw.memberId === undefined ? null : raw.memberId
  if (memberId !== null) {
    memberId = checkMemberId(memberId)
    if (!memberId) return fail('memberId', '非法 memberId（只允许字母、数字、点、下划线、连字符，1–64 位）')
  }
  if ((kind === 'member/start' || kind === 'member/end') && memberId === null) {
    return fail('memberId', 'member 事件必须带 memberId')
  }

  const traceId = checkTraceId(raw.traceId)
  if (!traceId) return fail('traceId', '必须是非空字符串（≤128 字符，不含控制字符）')

  if (raw.data !== undefined && !isPlainObject(raw.data)) return fail('data', 'data 必须是 JSON 对象')
  const checked = validateData(kind, raw.data === undefined ? {} : raw.data)
  if (!checked.ok) return checked

  const now = ctx.now instanceof Date && !Number.isNaN(ctx.now.getTime()) ? ctx.now : new Date()
  const ts = normalizeTs(raw.ts, now)

  let ref
  if (raw.ref !== undefined && raw.ref !== null) {
    const checkedRef = normalizeRef(raw.ref)
    if (!checkedRef.ok) return checkedRef
    ref = checkedRef.value
  }

  const extraSource = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!RESERVED_FIELDS.has(key)) extraSource[key] = value
  }
  if (raw.extra !== undefined) {
    if (!isPlainObject(raw.extra)) return fail('extra', 'extra 必须是 JSON 对象')
    Object.assign(extraSource, raw.extra)
  }
  const extra = boundExtra(extraSource)

  const event = {
    v: 1,
    ts,
    kind,
    runId,
    ...(nodeId ? { nodeId } : {}),
    ...(attemptId !== null ? { attemptId } : {}),
    memberId,
    traceId,
    data: checked.data,
  }
  if (ref) event.ref = ref
  if (Object.keys(extra).length > 0) event.extra = extra

  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) {
    return fail('event', `单条事件超过 ${MAX_EVENT_BYTES} 字节（事件行上限 8KB）`)
  }
  return { ok: true, event }
}

// ---------------------------------------------------------------------------
// 聚合（§4）：全部纯函数，输入是已落盘 / 已排序的事件数组。
// ---------------------------------------------------------------------------

function emptyBucket() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, calls: 0 }
}

function addUsage(bucket, usage) {
  const input = Number.isFinite(usage.input) ? usage.input : 0
  const cacheRead = Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0
  const cacheWrite = Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0
  const output = Number.isFinite(usage.output) ? usage.output : 0
  bucket.input += input
  bucket.cacheRead += cacheRead
  bucket.cacheWrite += cacheWrite
  bucket.output += output
  bucket.reasoning += Number.isFinite(usage.reasoning) ? usage.reasoning : 0
  bucket.total += input + cacheRead + cacheWrite + output
  bucket.calls += 1
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))))
}

/**
 * token 四桶：按 nodeId / memberId 分组，`reasoning` 单列且不进 total；
 * 同一 `traceId + data.callId` 的用量按「后到整条替换」处理（§3）。
 */
export function computeTokens(events = []) {
  const keyed = new Map()
  const unkeyed = []
  for (const event of events) {
    if (!event || event.kind !== 'model/call') continue
    const usage = event.data && event.data.usage
    if (!isPlainObject(usage)) continue
    const callId = event.data.callId
    const record = { event, usage }
    if (typeof callId === 'string' && callId !== '') {
      keyed.set(`${event.traceId}\u0000${callId}`, record)
    } else {
      unkeyed.push(record)
    }
  }
  const effective = [...keyed.values(), ...unkeyed]
    .sort((a, b) => (a.event.seq ?? 0) - (b.event.seq ?? 0))

  const total = emptyBucket()
  const nodeMap = new Map()
  const memberMap = new Map()
  for (const { event, usage } of effective) {
    addUsage(total, usage)
    const nodeKey = event.nodeId || '(run)'
    if (!nodeMap.has(nodeKey)) nodeMap.set(nodeKey, emptyBucket())
    addUsage(nodeMap.get(nodeKey), usage)
    if (event.memberId) {
      if (!memberMap.has(event.memberId)) memberMap.set(event.memberId, emptyBucket())
      addUsage(memberMap.get(event.memberId), usage)
    }
  }
  return {
    total,
    byNode: sortedObject(nodeMap),
    byMember: sortedObject(memberMap),
    calls: effective.length,
    // §8.1：没有 callId 的用量事件（历史数据）按逐条累加处理，单列供核对。
    unkeyedCalls: unkeyed.length,
  }
}

/**
 * skill 覆盖：声明集 = `node/start.data.skills` 的唯一名；加载集 = 成功
 * `skill/load` 的唯一名。coverage = |声明 ∩ 已加载| / |声明|（声明为 0 时 null，
 * 不拿 100% 冒充）。加载次数成功 / 失败单列。
 */
export function computeSkillUsage(events = []) {
  const declared = new Set()
  const loadedOk = new Set()
  const loadedFailed = new Set()
  const bySkill = new Map()
  let loadTotal = 0

  for (const event of events) {
    if (!event) continue
    if (event.kind === 'node/start' && event.data && Array.isArray(event.data.skills)) {
      for (const skill of event.data.skills) {
        if (typeof skill === 'string' && skill.trim() !== '') declared.add(skill)
      }
    }
    if (event.kind === 'skill/load' && event.data && typeof event.data.skill === 'string') {
      const skill = event.data.skill
      if (skill.trim() === '') continue
      loadTotal += 1
      if (event.data.ok === true) loadedOk.add(skill)
      else loadedFailed.add(skill)
      if (!bySkill.has(skill)) bySkill.set(skill, { ok: 0, failed: 0 })
      const counts = bySkill.get(skill)
      if (event.data.ok === true) counts.ok += 1
      else counts.failed += 1
    }
  }

  const loaded = [...loadedOk]
  const intersection = [...declared].filter(skill => loadedOk.has(skill))
  const declaredList = [...declared]
  return {
    declared: declaredList.sort((a, b) => a.localeCompare(b)),
    declaredCount: declared.size,
    loaded: loaded.sort((a, b) => a.localeCompare(b)),
    loadedCount: loadedOk.size,
    missing: declaredList.filter(skill => !loadedOk.has(skill)).sort((a, b) => a.localeCompare(b)),
    undeclared: [...new Set([...loadedOk, ...loadedFailed])]
      .filter(skill => !declared.has(skill))
      .sort((a, b) => a.localeCompare(b)),
    coverage: declared.size === 0 ? null : intersection.length / declared.size,
    loads: {
      total: loadTotal,
      ok: [...loadedOk].reduce((sum, skill) => sum + bySkill.get(skill).ok, 0),
      failed: [...loadedFailed].reduce((sum, skill) => sum + bySkill.get(skill).failed, 0),
    },
    bySkill: sortedObject(bySkill),
  }
}

/**
 * 审查发现：run 内按 `id` 全局唯一，取 seq 最大的一次状态；未解决 = open + accepted + fixed，
 * verified 与 dismissed 单列（采纳 ≠ 修复 ≠ 复验，§4 / 04 §3.10.4）。
 * 另给 `byNode`（§8 补充）：每条唯一 finding 归到它**最新状态事件**所在的 nodeId。
 */
export function computeFindings(events = []) {
  const latest = new Map()
  let reportedCount = 0
  for (const event of sortEvents(internalEvents(events))) {
    if (!event || event.kind !== 'review/finding' || !event.data) continue
    const id = event.data.id
    if (typeof id !== 'string' || id === '') continue
    reportedCount += 1
    const previous = latest.get(id)
    if (previous && seqOf(event) < seqOf(previous.event)) continue
    latest.set(id, {
      id,
      severity: event.data.severity,
      status: event.data.status,
      title: event.data.title,
      nodeId: typeof event.nodeId === 'string' ? event.nodeId : null,
      event,
    })
  }

  const byStatus = { open: 0, accepted: 0, fixed: 0, verified: 0, dismissed: 0 }
  const bySeverity = { P0: 0, P1: 0, P2: 0 }
  const unresolvedBySeverity = { P0: 0, P1: 0, P2: 0 }
  const verifiedBySeverity = { P0: 0, P1: 0, P2: 0 }
  const dismissedBySeverity = { P0: 0, P1: 0, P2: 0 }
  const byNodeMap = new Map()

  for (const finding of latest.values()) {
    const severity = SEVERITY.has(finding.severity) ? finding.severity : 'P2'
    bySeverity[severity] += 1
    if (Object.hasOwn(byStatus, finding.status)) byStatus[finding.status] += 1
    if (['open', 'accepted', 'fixed'].includes(finding.status)) {
      unresolvedBySeverity[severity] += 1
    } else if (finding.status === 'verified') {
      verifiedBySeverity[severity] += 1
    } else if (finding.status === 'dismissed') {
      dismissedBySeverity[severity] += 1
    }

    // §8 补充：按节点拆分（同 id 已在上面去重，run 内只出现一次）。
    if (finding.nodeId === null) continue
    if (!byNodeMap.has(finding.nodeId)) {
      byNodeMap.set(finding.nodeId, {
        total: 0,
        unresolved: 0,
        verified: 0,
        dismissed: 0,
        byStatus: { open: 0, accepted: 0, fixed: 0, verified: 0, dismissed: 0 },
        bySeverity: { P0: 0, P1: 0, P2: 0 },
      })
    }
    const node = byNodeMap.get(finding.nodeId)
    node.total += 1
    node.bySeverity[severity] += 1
    if (Object.hasOwn(node.byStatus, finding.status)) node.byStatus[finding.status] += 1
    if (['open', 'accepted', 'fixed'].includes(finding.status)) node.unresolved += 1
    else if (finding.status === 'verified') node.verified += 1
    else if (finding.status === 'dismissed') node.dismissed += 1
  }

  const unresolved = unresolvedBySeverity.P0 + unresolvedBySeverity.P1 + unresolvedBySeverity.P2
  const verified = verifiedBySeverity.P0 + verifiedBySeverity.P1 + verifiedBySeverity.P2
  const dismissed = dismissedBySeverity.P0 + dismissedBySeverity.P1 + dismissedBySeverity.P2
  // §8.3：采纳率 = (accepted + fixed + verified) / (total − dismissed − na)；分母 0 → unknown。
  // 当前 finding 状态白名单里没有 na，保留变量以便未来扩展时口径不变。
  const notApplicable = 0
  const acceptedRateDenominator = latest.size - dismissed - notApplicable
  const acceptedCount = byStatus.accepted + byStatus.fixed + byStatus.verified
  const acceptedRate = acceptedRateDenominator <= 0 ? null : acceptedCount / acceptedRateDenominator
  return {
    total: latest.size,
    reportedCount,
    bySeverity,
    byStatus,
    byNode: sortedObject(byNodeMap),
    unresolved,
    unresolvedBySeverity,
    verified,
    verifiedBySeverity,
    dismissed,
    dismissedBySeverity,
    acceptedCount,
    acceptedRateDenominator,
    acceptedRate,
    acceptedRateUnknown: acceptedRate === null,
  }
}

/** 打回：按边与目标节点两个维度各出一份计数。 */
export function computeRejects(events = []) {
  const byEdge = new Map()
  const byTarget = new Map()
  let total = 0
  for (const event of internalEvents(events)) {
    if (!event || event.kind !== 'reject/trigger' || !event.data) continue
    total += 1
    const edgeId = typeof event.data.edgeId === 'string' ? event.data.edgeId : '(unknown)'
    const toNodeId = typeof event.data.toNodeId === 'string' ? event.data.toNodeId : '(unknown)'
    byEdge.set(edgeId, (byEdge.get(edgeId) || 0) + 1)
    byTarget.set(toNodeId, (byTarget.get(toNodeId) || 0) + 1)
  }
  return {
    total,
    byEdge: Object.fromEntries([...byEdge.entries()].sort(([a], [b]) => a.localeCompare(b))),
    byTarget: Object.fromEntries([...byTarget.entries()].sort(([a], [b]) => a.localeCompare(b))),
  }
}

function seqOf(event) {
  return Number.isInteger(event && event.seq) ? event.seq : 0
}

/** 事件按 seq 升序（缺失 seq 的退回 ts，再退回原顺序）。 */
function sortEvents(events) {
  return [...events].sort((a, b) => {
    const sa = seqOf(a)
    const sb = seqOf(b)
    if (sa !== sb) return sa - sb
    const ta = typeof a?.ts === 'string' ? Date.parse(a.ts) : Number.NaN
    const tb = typeof b?.ts === 'string' ? Date.parse(b.ts) : Number.NaN
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
    return 0
  })
}

/**
 * 每个节点当前的 attemptId（该节点见过的最大的 attemptId）。
 * §8.2 / §8.3：旧 attempt 的结论不进入当前聚合。
 */
export function currentAttempts(events = []) {
  const map = new Map()
  for (const event of internalEvents(events)) {
    if (!event || typeof event.nodeId !== 'string' || !Number.isInteger(event.attemptId)) continue
    const current = map.get(event.nodeId)
    if (current === undefined || event.attemptId > current) map.set(event.nodeId, event.attemptId)
  }
  return map
}

/** 节点事件是否属于该节点的当前 attempt；run 级事件恒为 true。 */
function isCurrentAttempt(event, attempts) {
  if (!event || typeof event.nodeId !== 'string') return true
  if (!Number.isInteger(event.attemptId)) return false
  const current = attempts.get(event.nodeId)
  return current === undefined || event.attemptId === current
}

/** 过滤出当前 attempt 的事件（用于单项证据，不用于 findings 的全局生命周期）。 */
function currentAttemptEvents(events) {
  const internal = internalEvents(events)
  const attempts = currentAttempts(internal)
  return internal.filter(event => isCurrentAttempt(event, attempts))
}

/**
 * 阶段进度（§8.3）。
 *
 * - 每个阶段只认**当前 attempt**（该节点最大的 attemptId）的 `node/end`；
 * - 打回时从 `toNodeId` 到 `fromNodeId` 路径上的 passed 失效：日志里没有边拓扑，
 *   用可复算的时间窗近似——目标节点最近一次 passed 的 seq 到打回 seq 之间
 *   passed 的节点（含两端）判为路径内；端点无论如何都失效；
 * - 失效的 passed 单列 `invalidated`，不进分子；分母仍是「总阶段 − skipped」；
 * - `ratio` 强制 ≤ 1，旧 attempt 的结论不计。
 */
export function computeProgress(events = []) {
  const sorted = sortEvents(internalEvents(events))
  let nodeTotal = null
  // 按 seq 重放：状态只看「当时」的当前 attempt，和 runstore 的增量计数器同一套规则。
  const nodes = new Map()
  for (const event of sorted) {
    if (!event || !event.data) continue
    if (event.kind === 'run/start') {
      if (Number.isInteger(event.data.nodeTotal) && event.data.nodeTotal >= 0) {
        nodeTotal = event.data.nodeTotal
      }
      continue
    }
    if (event.kind === 'node/start' && typeof event.nodeId === 'string'
      && Number.isInteger(event.attemptId)) {
      const existing = nodes.get(event.nodeId)
      if (!existing || event.attemptId >= existing.attemptId) {
        nodes.set(event.nodeId, {
          attemptId: event.attemptId,
          status: 'pending',
          endSeq: 0,
          invalidated: false,
        })
      }
      continue
    }
    if (event.kind === 'node/end' && typeof event.nodeId === 'string'
      && Number.isInteger(event.attemptId) && typeof event.data.status === 'string') {
      const existing = nodes.get(event.nodeId)
      if (!existing || event.attemptId >= existing.attemptId) {
        nodes.set(event.nodeId, {
          attemptId: event.attemptId,
          status: event.data.status,
          endSeq: seqOf(event),
          invalidated: false,
        })
      }
      continue
    }
    if (event.kind === 'reject/trigger') {
      const fromNodeId = event.data.fromNodeId
      const toNodeId = event.data.toNodeId
      const rejectSeq = seqOf(event)
      if (typeof fromNodeId !== 'string' || typeof toNodeId !== 'string') continue
      const target = nodes.get(toNodeId)
      const windowStart = target && target.status === 'passed' && target.endSeq > 0
        && target.endSeq < rejectSeq ? target.endSeq : null
      for (const [nodeId, entry] of nodes) {
        if (entry.status !== 'passed' || entry.invalidated) continue
        if (entry.endSeq <= 0 || entry.endSeq >= rejectSeq) continue
        const onPath = nodeId === fromNodeId || nodeId === toNodeId
          || (windowStart !== null && entry.endSeq >= windowStart)
        if (onPath) entry.invalidated = true
      }
    }
  }

  return aggregateProgress(nodes, nodeTotal)
}

/**
 * 从「每节点状态」算进度汇总（§8.3）。
 *
 * 事件回放（{@link computeProgress}）和 run.json 的增量计数器（runstore 的
 * `meta.progress.nodes`）必须同口径，所以聚合只写一份，两边都调它。
 *
 * @param {Map<string, {attemptId:number,status:string,endSeq:number,invalidated:boolean}>} nodes
 * @param {number|null} nodeTotal
 */
function aggregateProgress(nodes, nodeTotal) {
  let passed = 0
  let skipped = 0
  let failed = 0
  let rejected = 0
  let observed = 0
  const invalidatedNodes = []
  for (const [nodeId, entry] of nodes) {
    if (entry.status === 'pending') continue
    observed += 1
    if (entry.status === 'passed') {
      if (entry.invalidated) invalidatedNodes.push(nodeId)
      else passed += 1
    } else if (entry.status === 'skipped') skipped += 1
    else if (entry.status === 'failed') failed += 1
    else if (entry.status === 'rejected') rejected += 1
  }
  const total = nodeTotal === null ? observed : nodeTotal
  const denominator = Math.max(0, total - skipped)
  const ratio = denominator === 0 ? null : Math.min(1, passed / denominator)
  return {
    passed,
    skipped,
    failed,
    rejected,
    invalidated: invalidatedNodes.length,
    invalidatedNodes: invalidatedNodes.sort((a, b) => a.localeCompare(b)),
    // B1：长跑 / 事件窗口被截断时，客户端只剩这份每节点状态可用（计数对象不够）。
    // 客户端 normalizeProgress 认 `{attemptId,status,endSeq,invalidated}` 这四字段。
    nodes: Object.fromEntries(
      [...nodes.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([nodeId, entry]) => [nodeId, {
          attemptId: entry.attemptId,
          status: entry.status,
          endSeq: entry.endSeq,
          invalidated: entry.invalidated,
        }]),
    ),
    total,
    observed,
    denominator,
    ratio,
    nodeDone: passed,
  }
}

/**
 * 从 run.json 里的每节点状态算进度（列表接口用；与 {@link computeProgress} 同口径）。
 * @param {object} nodeStates meta.progress.nodes
 * @param {number|null} [nodeTotal]
 */
export function progressFromNodeStates(nodeStates, nodeTotal = null) {
  const map = new Map()
  for (const [nodeId, entry] of Object.entries(nodeStates || {})) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.status !== 'string') continue
    map.set(nodeId, {
      attemptId: Number.isInteger(entry.attemptId) ? entry.attemptId : 0,
      status: entry.status,
      endSeq: Number.isInteger(entry.endSeq) ? entry.endSeq : 0,
      invalidated: entry.invalidated === true,
    })
  }
  return aggregateProgress(map, Number.isInteger(nodeTotal) ? nodeTotal : null)
}

/**
 * 0.11 R1：这条 run/end 是否只是「旧执行实例失权」的事实。
 * instance 范围不参与生命周期投影（run 仍是接管者的 run），只在时间线/审计里可见。
 * @param {object} event
 */
export function isInstanceScopedEnd(event) {
  return Boolean(event && event.kind === 'run/end'
    && event.extra && event.extra.terminalScope === 'instance')
}

/** 外部观察附录的有界上限（§6：外部统计可以增加，但必须有界）。 */
export const EXTERNAL_OBSERVATION_LIMIT = 50

/**
 * R4（0.11 §6）：这条事件是否来自外部来源。
 *
 * **只认 `extra.source === 'external'` / `extra.producer === 'external'`**：
 *   - 不猜 host：旧事件没有 source 就是 legacy（来源未知），不能因为「没标记」就当成宿主；
 *   - 不认 `data.external: true` 之类的自报标记：来客在 data 里写什么都只是未验证观察，
 *     不能据此授信，也不能据此把内部事件降级。
 *
 * @param {object} event 已落盘 / 未落盘的事件
 * @returns {boolean}
 */
export function isExternalEvent(event) {
  const extra = event && typeof event.extra === 'object' && event.extra !== null ? event.extra : null
  if (!extra) return false
  return extra.source === 'external' || extra.producer === 'external'
}

/**
 * 在任何权威索引之前分区（§6）：外部事件只进观察，不进证据 / 冲突 / attempt / stale / findings。
 * 所有聚合函数都在入口调用它，因此对已分区的事件再调用一次也安全（幂等）。
 *
 * @param {object[]} events
 * @returns {object[]}
 */
function internalEvents(events = []) {
  if (!Array.isArray(events)) return []
  return events.filter(event => !isExternalEvent(event))
}

/** 06 §13.7 / 05 §8.2：引擎写下的 artifact/write（path + sha256）索引。 */
export function collectArtifactIndex(events = []) {
  const map = new Map()
  for (const event of sortEvents(internalEvents(events))) {
    if (!event || event.kind !== 'artifact/write' || !event.data) continue
    const path = event.data.path
    const sha256 = event.data.sha256
    if (typeof path !== 'string' || !isSafeRelPath(path)) continue
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) continue
    map.set(path, sha256.toLowerCase())
  }
  return map
}

/**
 * §8.4 v1.3：产物归属索引（path → 谁写的）。证据独立性分级只认三件事：
 *   - `extra.producer === 'host'` → `host`（宿主生成 / 标记的产物）；
 *   - `artifact/write.nodeId` 与声明者相同 → `self`（自证）；
 *   - `artifact/write.nodeId` 与声明者不同 → `peer`（独立复核）。
 * 同一 path 多次写入时以 seq 最大者为准（与 {@link collectArtifactIndex} 同口径）。
 *
 * @param {object[]} events
 * @returns {Map<string, { nodeId: string | null, attemptId: number | null, producer: string | null }>}
 */
export function collectArtifactOwners(events = []) {
  const map = new Map()
  for (const event of sortEvents(internalEvents(events))) {
    if (!event || event.kind !== 'artifact/write' || !event.data) continue
    const path = event.data.path
    if (typeof path !== 'string' || !isSafeRelPath(path)) continue
    map.set(path, {
      nodeId: typeof event.nodeId === 'string' ? event.nodeId : null,
      attemptId: Number.isInteger(event.attemptId) ? event.attemptId : null,
      producer: event.extra && typeof event.extra.producer === 'string' ? event.extra.producer : null,
    })
  }
  return map
}

/**
 * §8.4 v1.3：一条通过条目的证据独立性级别。
 * 找不到产物归属时返回 null（可信写入方直接给的 ref，沿用 §8.5 的信任边界），
 * 不把「查不到」硬判成 self —— 只有能证明是同一节点写的才算自证。
 *
 * @param {object} event 声明者事件（acceptance/verdict、test/report、check/form）
 * @param {string | undefined} ref 证据引用
 * @param {Map<string, {nodeId: string|null, producer: string|null}>} owners
 * @returns {'self' | 'peer' | 'host' | null}
 */
function classifyEvidenceLevel(event, ref, owners) {
  if (!(owners instanceof Map) || typeof ref !== 'string' || ref.trim() === '') return null
  const owner = owners.get(ref)
  if (!owner) return null
  if (owner.producer === 'host') return 'host'
  if (typeof owner.nodeId !== 'string' || owner.nodeId === '') return null
  return typeof event?.nodeId === 'string' && owner.nodeId === event.nodeId ? 'self' : 'peer'
}

/** 模型自述证据：事件 extra.provenance === 'model-claim'（06 §13.7）。 */
function isModelClaim(event) {
  return Boolean(event && event.extra && event.extra.provenance === 'model-claim')
}

/**
 * R6（0.11 §8）：一条证据事件的权威级别。
 *
 * - `external`：`extra.source` / `extra.producer` 为 external（外部观察，永不授信）；
 * - `host`：`extra.producer === 'host'` 或 `extra.authority === 'host'`（宿主执行 / 登记产物）；
 * - `model-claim`：`extra.provenance === 'model-claim'`（模型自述，需独立产物对账）；
 * - `engine`：`extra.provenance` 为 engine / stub-synthetic（引擎自产，非模型声明）；
 * - `legacy`：没有可识别来源的旧事件（来源未知，不猜测为 host）。
 *
 * 注意：`authority` 只是验证结果的投影，不是调用方可声明的权限；本函数只分类，
 * 不因为字符串写了 'host' 就跳过子产物 / 报告核验（核验仍在各指标内做）。
 *
 * 0.11 R5（F4）：`extra.producer='host'` 只是声明；传入 `options.verifyHostExecution`
 * 时必须是宿主登记过的真实执行（凭证 + executionId + 节点/attempt 对齐），否则按
 * claimed 处理。不传验证器时保持旧的纯函数信任（离线复算 / 既有基线）。
 *
 * @param {object} event
 * @param {{ verifyHostExecution?: (event: object) => boolean }} [options]
 * @returns {'host' | 'engine' | 'model-claim' | 'external' | 'legacy'}
 */
export function classifyEvidenceAuthority(event, options = {}) {
  const extra = event && typeof event.extra === 'object' && event.extra !== null ? event.extra : null
  if (!extra) return 'legacy'
  if (extra.source === 'external' || extra.producer === 'external') return 'external'
  if (extra.producer === 'host' || extra.authority === 'host') {
    // 0.11 R6（返工）：纯函数没有文件/登记验证能力时不允许把 producer=host 当权威；
    // 必须由调用方注入 verifyHostExecution 且明确通过，否则按 claimed 处理。
    if (typeof options.verifyHostExecution !== 'function') return 'model-claim'
    try {
      return options.verifyHostExecution(event) === true ? 'host' : 'model-claim'
    } catch {
      return 'model-claim'
    }
  }
  if (extra.provenance === 'model-claim') return 'model-claim'
  if (extra.provenance === 'engine' || extra.provenance === 'stub-synthetic') return 'engine'
  return 'legacy'
}

/**
 * R6（0.11 §8）：引擎用自己刚生成的 summary/report 充当 reportRef 的兜底。
 * 这种「自报报告」没有独立产物可复核，不得算权威通过。
 * @param {object} event
 * @returns {boolean}
 */
function isGeneratedReportClaim(event) {
  return Boolean(event && event.extra && event.extra.generatedReport === true)
}

/**
 * 指标层的权威计数（§8）：分母是「应验条目数」，缺分母时 coverageRatio 为 null。
 * @param {{ claimedPassed: number, authoritativePassed: number, legacyPassed?: number, denominator: number|null }} values
 */
function authorityFields({ claimedPassed, authoritativePassed, legacyPassed = 0, denominator, independentPassed = 0 }) {
  const total = Number.isInteger(denominator) && denominator > 0 ? denominator : null
  return {
    claimedPassed,
    authoritativePassed,
    // 0.11 F4：旧事件来源未知（legacy），保留「声明通过」计数但绝不计入权威。
    legacyPassed,
    // v1.3：通过条目里带 peer / host 级独立证据的条数（§8.3 的产物归属分级）。
    // 与 authoritativePassed（host 权威）不同：peer 也算独立复核，只是没有宿主登记。
    independentPassed,
    authoritativeTotal: total,
    coverageRatio: total === null ? null : authoritativePassed / total,
  }
}

/**
 * 校验一条 `model-claim` 证据引用：
 *   - 必须是 run 目录内的相对路径；
 *   - 必须能对上某条 `artifact/write` 的 path + sha256（纯函数层可查）；
 *   - 传入 `verifyEvidence` 时再查文件真实存在且内容 sha256 与事件一致（Host 层做）。
 * 没有 `verifyEvidence` 时只做前两项（纯函数测试 / 离线复算没有 fs）。
 */
function verifyClaimRef(event, ref, artifacts, verifyEvidence) {
  if (typeof ref !== 'string' || ref.trim() === '') {
    return { ok: false, reason: '缺少证据引用' }
  }
  if (!isSafeRelPath(ref)) {
    return { ok: false, reason: `证据引用不是 run 目录内的相对路径：${ref.slice(0, 120)}` }
  }
  if (!(artifacts instanceof Map) || !artifacts.has(ref)) {
    return { ok: false, reason: `证据引用 ${ref} 没有对应的 artifact/write（path+sha256）` }
  }
  if (typeof verifyEvidence === 'function' && !verifyEvidence(ref, artifacts.get(ref))) {
    return { ok: false, reason: `证据文件 ${ref} 不存在，或内容 sha256 与 artifact/write 不符` }
  }
  return { ok: true }
}

/**
 * 06 §13.7 双保险：`findings.id` / `acceptance.itemId` / `tests.suite` / `check.ruleSetId`
 * 在同一 run 内跨节点重复 → 该指标的计数不可信。返回每个指标的冲突清单。
 */
export function computeConflicts(events = []) {
  const groups = {
    findings: ['review/finding', 'id'],
    acceptance: ['acceptance/verdict', 'itemId'],
    tests: ['test/report', 'suite'],
    checks: ['check/form', 'ruleSetId'],
  }
  const conflicts = { findings: [], acceptance: [], tests: [], checks: [] }
  for (const [metric, [kind, field]] of Object.entries(groups)) {
    const nodesById = new Map()
    for (const event of internalEvents(events)) {
      if (!event || event.kind !== kind || !event.data) continue
      const id = event.data[field]
      if (typeof id !== 'string' || id === '' || typeof event.nodeId !== 'string') continue
      if (!nodesById.has(id)) nodesById.set(id, new Set())
      nodesById.get(id).add(event.nodeId)
    }
    for (const [id, nodeSet] of nodesById) {
      if (nodeSet.size > 1) conflicts[metric].push({ id, nodes: [...nodeSet].sort((a, b) => a.localeCompare(b)) })
    }
    conflicts[metric].sort((a, b) => a.id.localeCompare(b.id))
  }
  return conflicts
}

export function hasConflicts(conflicts) {
  return Object.values(conflicts || {}).some(list => Array.isArray(list) && list.length > 0)
}

function conflictReason(metric, list) {
  const ids = list.slice(0, 3).map(item => item.id).join('、')
  return `${metric} 标识跨节点重复（${ids}${list.length > 3 ? ' 等' : ''}），计数不可信`
}

const CONFLICT_LABELS = {
  findings: '审查发现 id',
  acceptance: '验收条目 itemId',
  tests: '测试套件 suite',
  checks: '规则集 ruleSetId',
}

/**
 * 40px 主摘要用：当前有效 attempt 的验收条目通过率（06 §13.7 / 04 §3.9）。
 * `passed` 只数当前 attempt 里最新判定为 pass 的条目；`total` 是条目数；分母 0 → rate null。
 */
export function summarizeAcceptance(events = []) {
  const latest = new Map()
  for (const event of sortEvents(currentAttemptEvents(internalEvents(events)))) {
    if (!event || event.kind !== 'acceptance/verdict' || !event.data) continue
    const itemId = event.data.itemId
    if (typeof itemId !== 'string' || itemId === '') continue
    latest.set(itemId, event.data)
  }
  let passed = 0
  for (const data of latest.values()) {
    if (data.status === 'pass') passed += 1
  }
  const total = latest.size
  return { passed, total, rate: total === 0 ? null : passed / total }
}

/**
 * 验收条目证据（§8.2 / §8.4）：同一 itemId 以 seq 最大者为准；只认当前 attempt。
 * 缺证据或证据链接 → unknown；任一条 fail → fail；全部 skip/na → unknown。
 *
 * v1.3 证据独立性：`selfCertified` 记「引用本节点自写产物」的通过条目数，
 * `selfOnly` = 有通过条目且全部为自证。指标层不因此降级（自证仍是证据，不是
 * 缺证据）；单项证据只暴露自证 / 独立计数，不汇总成质量总评分。
 */
export function computeAcceptance(events = [], options = {}) {
  const internal = internalEvents(events)
  const scoped = currentAttemptEvents(internal)
  const artifacts = options.artifacts instanceof Map ? options.artifacts : collectArtifactIndex(scoped)
  const owners = options.artifactOwners instanceof Map
    ? options.artifactOwners
    : collectArtifactOwners(internal)
  const latest = new Map()
  for (const event of sortEvents(scoped)) {
    if (!event || event.kind !== 'acceptance/verdict' || !event.data) continue
    const { itemId } = event.data
    if (typeof itemId !== 'string' || itemId === '') continue
    latest.set(itemId, { data: event.data, event })
  }
  if (latest.size === 0) {
    return {
      state: 'unknown',
      reason: '没有 acceptance/verdict 记录',
      items: 0,
      ...authorityFields({ claimedPassed: 0, authoritativePassed: 0, denominator: null }),
    }
  }

  let passed = 0
  let failed = 0
  let notApplicable = 0
  let missingLink = 0
  let unverified = 0
  let selfCertified = 0
  let independentPassed = 0
  let claimedPassed = 0
  let authoritativePassed = 0
  let legacyPassed = 0
  let generatedReport = 0
  const unverifiedRefs = []
  const selfCertifiedRefs = []
  const generatedReportRefs = []
  // v1.3（§8.3）：按被引用产物的归属计数——self 进 selfCertified，peer/host 进
  // independentPassed。0.13.12 起不再有总评分门禁；这里只如实暴露自证 / 独立计数。
  const countLevel = (level, itemId, authority) => {
    // §8.3：产物归属优先——能对上本节点自写的产物就是 self（即使事件声明 producer=host）；
    // 能对上别的节点 / 宿主标记的产物是独立复核。产物索引里查不到、但事件本身是宿主
    // 权威执行（authority=host）时，也按独立复核计（宿主不是模型，不需要自证）。
    if (level === 'self') {
      selfCertified += 1
      selfCertifiedRefs.push(itemId)
    } else if (level === 'peer' || level === 'host' || authority === 'host') {
      independentPassed += 1
    }
  }
  const countPass = (data, event) => {
    passed += 1
    const source = classifyEvidenceAuthority(event, options)
    if (source === 'host') authoritativePassed += 1
    else if (source === 'legacy') legacyPassed += 1
    else claimedPassed += 1
    countLevel(classifyEvidenceLevel(event, data.evidenceRef, owners), data.itemId, source)
  }
  const authority = () => authorityFields({
    claimedPassed,
    authoritativePassed,
    legacyPassed,
    independentPassed,
    denominator: latest.size,
  })
  for (const { data, event } of latest.values()) {
    if (data.status === 'fail') {
      failed += 1
      continue
    }
    if (data.status !== 'pass') {
      notApplicable += 1
      continue
    }
    if (isModelClaim(event)) {
      // R6 §8：引擎自写报告（generatedReport）不是独立复核，只能算自报。
      // v1.3：它仍是「有证据但可能不独立」——能对上本节点产物就算自证（由聚合层
      // 层按 selfOnly 降 warn）；完全对不上产物归属时仍按缺证据 unknown。
      if (isGeneratedReportClaim(event)) {
        const level = classifyEvidenceLevel(event, data.evidenceRef, owners)
        if (level === null) {
          // 没有可归属产物：不计通过（缺证据），但「模型自报」这个事实要如实计数。
          claimedPassed += 1
          generatedReport += 1
          generatedReportRefs.push(data.itemId)
          continue
        }
        claimedPassed += 1
        passed += 1
        generatedReport += 1
        generatedReportRefs.push(data.itemId)
        countLevel(level, data.itemId, 'model-claim')
        continue
      }
      const claim = verifyClaimRef(event, data.evidenceRef, artifacts, options.verifyEvidence)
      if (!claim.ok) {
        unverified += 1
        unverifiedRefs.push(`${data.itemId}: ${claim.reason}`)
        continue
      }
      countPass(data, event)
      continue
    }
    if (typeof data.evidenceRef !== 'string' || data.evidenceRef.trim() === '') {
      missingLink += 1
      continue
    }
    countPass(data, event)
  }
  const selfOnly = passed > 0 && selfCertified === passed
  if (failed > 0) {
    return {
      state: 'fail',
      reason: `${failed} 个验收条目未通过`,
      items: latest.size,
      passed,
      failed,
      notApplicable,
      selfCertified,
      selfOnly,
      ...authority(),
    }
  }
  if (generatedReport > 0 && passed === 0) {
    return {
      state: 'unknown',
      reason: `${generatedReport} 个通过的验收条目只有自报报告（引擎自动生成），且找不到可归属的产物，缺独立证据`,
      items: latest.size,
      passed,
      failed,
      notApplicable,
      generatedReport,
      generatedReportRefs,
      selfCertified,
      selfOnly,
      ...authority(),
    }
  }
  if (unverified > 0) {
    return {
      state: 'unknown',
      reason: `${unverified} 个模型自述验收条目的证据对不上（路径 / 文件 / sha256）`,
      items: latest.size,
      passed,
      failed,
      notApplicable,
      unverified,
      unverifiedRefs,
      selfCertified,
      selfOnly,
      ...authority(),
    }
  }
  if (missingLink > 0) {
    return {
      state: 'unknown',
      reason: `${missingLink} 个通过的验收条目缺证据链接`,
      items: latest.size,
      passed,
      failed,
      notApplicable,
      selfCertified,
      selfOnly,
      ...authority(),
    }
  }
  if (passed === 0) {
    return {
      state: 'unknown',
      reason: '验收条目全部被跳过 / 不适用',
      items: latest.size,
      passed,
      failed,
      notApplicable,
      ...authority(),
    }
  }
  // v1.3：自证不再把指标打成 unknown（unknown = 缺证据 / 自相矛盾）；
  // 这里只如实暴露自报 / 独立条数，不据此给总评级。
  return {
    state: 'pass',
    reason: `${selfCertified} 条自报 + ${independentPassed} 条独立（peer/host）`,
    items: latest.size,
    passed,
    failed,
    notApplicable,
    ...(generatedReport > 0 ? { generatedReport, generatedReportRefs } : {}),
    selfCertified,
    independentPassed,
    selfOnly,
    selfCertifiedRefs,
    ...authority(),
  }
}

/**
 * 测试证据（§8.2 / §8.4）：同一 suite 以 seq 最大者为准；只认当前 attempt。
 * 有失败 → fail；计数缺失 / 只跑 0 条 / 缺报告链接 → unknown。
 * v1.3：`selfCertified` 记引用本节点自写报告的通过套件数，`selfOnly` = 通过套件全部自证；
 * 指标不降级；0.13.12 起不再由总评分层二次降级。
 */
export function computeTests(events = [], options = {}) {
  const internal = internalEvents(events)
  const scoped = currentAttemptEvents(internal)
  const artifacts = options.artifacts instanceof Map ? options.artifacts : collectArtifactIndex(scoped)
  const owners = options.artifactOwners instanceof Map
    ? options.artifactOwners
    : collectArtifactOwners(internal)
  const latest = new Map()
  for (const event of sortEvents(scoped)) {
    if (!event || event.kind !== 'test/report' || !event.data) continue
    const { suite } = event.data
    if (typeof suite !== 'string' || suite === '') continue
    latest.set(suite, { data: event.data, event })
  }
  if (latest.size === 0) {
    return {
      state: 'unknown',
      reason: '没有 test/report 记录',
      suites: 0,
      ...authorityFields({ claimedPassed: 0, authoritativePassed: 0, denominator: null }),
    }
  }

  let passedSuites = 0
  let failedSuites = 0
  let missingCounts = 0
  let missingLink = 0
  let unverified = 0
  let selfCertified = 0
  let independentPassed = 0
  let claimedPassed = 0
  let authoritativePassed = 0
  let legacyPassed = 0
  let generatedReport = 0
  const unverifiedRefs = []
  const selfCertifiedRefs = []
  const generatedReportRefs = []
  const suites = []
  // v1.3（§8.3）：self → selfCertified；peer/host → independentPassed（独立复核）。
  const countLevel = (level, suite, authority) => {
    if (level === 'self') {
      selfCertified += 1
      selfCertifiedRefs.push(suite)
    } else if (level === 'peer' || level === 'host' || authority === 'host') independentPassed += 1
  }
  const countPass = (suite, data, event) => {
    passedSuites += 1
    const source = classifyEvidenceAuthority(event, options)
    if (source === 'host') authoritativePassed += 1
    else if (source === 'legacy') legacyPassed += 1
    else claimedPassed += 1
    countLevel(classifyEvidenceLevel(event, data.reportRef, owners), suite, source)
    suites.push({ suite, status: 'pass', executed: data.executed, passed: data.passed, failed: data.failed })
  }
  const authority = () => authorityFields({
    claimedPassed,
    authoritativePassed,
    legacyPassed,
    independentPassed,
    denominator: latest.size,
  })
  for (const [suite, { data, event }] of latest) {
    const counts = ['executed', 'passed', 'failed', 'skipped']
    if (!counts.every(key => Number.isInteger(data[key]))) {
      missingCounts += 1
      continue
    }
    if (data.executed === 0) {
      missingCounts += 1
      continue
    }
    if (data.failed > 0) {
      failedSuites += 1
      suites.push({ suite, status: 'fail', executed: data.executed, passed: data.passed, failed: data.failed })
      continue
    }
    if (data.passed + data.failed === 0) {
      // 全部 skipped：没有真正执行，按未检测处理。
      missingCounts += 1
      continue
    }
    if (data.passed < data.executed) {
      // 通过率 < 100%（含 skipped）：不通过。
      failedSuites += 1
      suites.push({ suite, status: 'fail', executed: data.executed, passed: data.passed, failed: data.failed })
      continue
    }
    if (isModelClaim(event)) {
      // R6 §8：引擎自写报告（generatedReport）不是独立复核。v1.3：能对上产物归属
      // 就按自证 / 独立计数；完全无归属 → unknown。
      if (isGeneratedReportClaim(event)) {
        const level = classifyEvidenceLevel(event, data.reportRef, owners)
        if (level === null) {
          claimedPassed += 1
          generatedReport += 1
          generatedReportRefs.push(suite)
          continue
        }
        claimedPassed += 1
        passedSuites += 1
        generatedReport += 1
        generatedReportRefs.push(suite)
        countLevel(level, suite, 'model-claim')
        suites.push({ suite, status: 'pass', executed: data.executed, passed: data.passed, failed: data.failed })
        continue
      }
      const claim = verifyClaimRef(event, data.reportRef, artifacts, options.verifyEvidence)
      if (!claim.ok) {
        unverified += 1
        unverifiedRefs.push(`${suite}: ${claim.reason}`)
        continue
      }
      countPass(suite, data, event)
      continue
    }
    if (typeof data.reportRef !== 'string' || data.reportRef.trim() === '') {
      missingLink += 1
      continue
    }
    countPass(suite, data, event)
  }
  const selfOnly = passedSuites > 0 && selfCertified === passedSuites
  if (failedSuites > 0) {
    return { state: 'fail', reason: `${failedSuites} 个测试套件未通过`, suites: latest.size, passedSuites, failedSuites, details: suites, selfCertified, selfOnly, ...authority() }
  }
  if (generatedReport > 0 && passedSuites === 0) {
    return {
      state: 'unknown',
      reason: `${generatedReport} 个通过的测试套件只有自报报告（引擎自动生成），且找不到可归属的产物，缺独立证据`,
      suites: latest.size,
      passedSuites,
      failedSuites,
      generatedReport,
      generatedReportRefs,
      details: suites,
      selfCertified,
      selfOnly,
      ...authority(),
    }
  }
  if (missingCounts > 0) {
    return { state: 'unknown', reason: `${missingCounts} 个测试套件计数缺失或执行 0 条`, suites: latest.size, passedSuites, failedSuites, details: suites, selfCertified, selfOnly, ...authority() }
  }
  if (unverified > 0) {
    return {
      state: 'unknown',
      reason: `${unverified} 个模型自述测试报告的证据对不上（路径 / 文件 / sha256）`,
      suites: latest.size,
      passedSuites,
      failedSuites,
      unverified,
      unverifiedRefs,
      details: suites,
      selfCertified,
      selfOnly,
      ...authority(),
    }
  }
  if (missingLink > 0) {
    return { state: 'unknown', reason: `${missingLink} 个测试套件缺报告链接`, suites: latest.size, passedSuites, failedSuites, details: suites, selfCertified, selfOnly, ...authority() }
  }
  if (passedSuites === 0) {
    return {
      state: 'unknown',
      reason: '没有可用的测试执行记录',
      suites: latest.size,
      passedSuites,
      failedSuites,
      details: suites,
      ...authority(),
    }
  }
  // v1.3：自证仍算通过，指标层不降级。
  return {
    state: 'pass',
    reason: `${selfCertified} 条自报 + ${independentPassed} 条独立（peer/host）`,
    suites: latest.size,
    passedSuites,
    failedSuites,
    ...(generatedReport > 0 ? { generatedReport, generatedReportRefs } : {}),
    details: suites,
    selfCertified,
    independentPassed,
    selfOnly,
    selfCertifiedRefs,
    ...authority(),
  }
}

/**
 * agent 活动摘要（§8.3）：按 nodeId 聚合最近若干条 `agent/message` 的可见文本，
 * 供客户端在「运行详情」里展示「这个节点最近在说什么」。
 *
 * 有界：每节点最多 `perNode`（默认 5）条，全局最多 `total`（默认 200）条；
 * 总量超限时保留全局最新的事件（同一节点的组内仍按时间升序输出）。
 *
 * @param {object[]} events 按 seq 升序的已落盘事件
 * @param {{ perNode?: number, total?: number }} [options]
 * @returns {{ nodes: Record<string, { text: string, at: string | null, memberId: string | null }[]> }}
 */
export function computeAgentActivity(events = [], options = {}) {
  const perNode = Number.isInteger(options.perNode) && options.perNode > 0
    ? options.perNode
    : AGENT_ACTIVITY_PER_NODE
  const total = Number.isInteger(options.total) && options.total > 0
    ? options.total
    : AGENT_ACTIVITY_TOTAL
  const byNode = new Map()
  let order = 0
  for (const event of events) {
    if (!event || event.kind !== 'agent/message') continue
    const data = isPlainObject(event.data) ? event.data : null
    if (!data || typeof data.text !== 'string' || data.text === '') continue
    const nodeId = typeof event.nodeId === 'string' && event.nodeId !== '' ? event.nodeId : '(run)'
    if (!byNode.has(nodeId)) byNode.set(nodeId, [])
    const list = byNode.get(nodeId)
    order += 1
    list.push({
      order,
      text: data.text,
      at: typeof event.ts === 'string' && event.ts !== '' ? event.ts : null,
      memberId: typeof event.memberId === 'string' && event.memberId !== '' ? event.memberId : null,
    })
    // 每节点只保留最近 perNode 条。
    if (list.length > perNode) list.shift()
  }
  // 全局总量有界：先取全局最新的 total 条，再按节点分组。
  const flat = []
  for (const [nodeId, list] of byNode.entries()) {
    for (const item of list) flat.push({ nodeId, item })
  }
  const kept = flat.sort((a, b) => b.item.order - a.item.order).slice(0, total)
  const grouped = new Map()
  for (const { nodeId, item } of kept) {
    if (!grouped.has(nodeId)) grouped.set(nodeId, [])
    grouped.get(nodeId).push(item)
  }
  const nodes = {}
  for (const nodeId of [...grouped.keys()].sort((a, b) => a.localeCompare(b))) {
    nodes[nodeId] = grouped.get(nodeId)
      .sort((a, b) => a.order - b.order)
      .map(item => ({ text: item.text, at: item.at, memberId: item.memberId }))
  }
  return { nodes }
}

/**
 * 汇总（§4）：所有聚合 + computedAt / eventCount。
 * @param {object[]} events 按 seq 升序的已落盘事件
 * @param {{ now?: Date }} [options]
 */
export function summarize(events = [], options = {}) {
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
    ? options.now
    : new Date()
  const tokens = computeTokens(events)
  // 06 §13.8：引擎标记优先取显式参数（run.json.engine），其次取 run/start.data.engine。
  // R4（§6）：外部事件不能伪造 run/start.data.engine，因此只在内部事件里探测。
  let engine = 'real'
  if (options.engine === 'stub' || options.engine === 'real') {
    engine = options.engine
  } else {
    for (const event of internalEvents(events)) {
      if (event && event.kind === 'run/start' && event.data
        && (event.data.engine === 'stub' || event.data.engine === 'real')) {
        engine = event.data.engine
        break
      }
    }
  }
  const conflicts = computeConflicts(events)
  const findings = computeFindings(events)
  if (conflicts.findings.length > 0) {
    findings.state = 'unknown'
    findings.reason = conflictReason(CONFLICT_LABELS.findings, conflicts.findings)
    findings.conflicts = conflicts.findings
  }
  // R4（§6）：外部观察只做展示，有界（最近 EXTERNAL_OBSERVATION_LIMIT 条），不进权威聚合。
  const externalSources = sortEvents(events.filter(isExternalEvent))
  const externalObservations = externalSources.slice(-EXTERNAL_OBSERVATION_LIMIT).map(event => {
    const digest = eventDigest(event)
    const fallback = isPlainObject(event.data) ? JSON.stringify(event.data) : ''
    return {
      kind: typeof event.kind === 'string' ? event.kind : '',
      seq: Number.isInteger(event.seq) ? event.seq : null,
      summary: (digest !== '' ? digest : fallback).slice(0, 300),
    }
  })
  let lastSeq = Number.isInteger(options.lastSeq) && options.lastSeq >= 0 ? options.lastSeq : 0
  for (const event of events) {
    if (Number.isInteger(event && event.seq) && event.seq > lastSeq) lastSeq = event.seq
  }
  return {
    computedAt: now.toISOString(),
    eventCount: events.length,
    // §8.6：summary 允许全量，但必须声明 eventCount 与 truncated。
    truncated: options.truncated === true,
    lastSeq,
    engine,
    // R4（§6）：外部来源统计；不影响权威 headline / 通过率 / run.status。
    externalCount: externalSources.length,
    externalObservations,
    // 06 §13.7：40px 主摘要直接取这三项（单项证据，不再汇总成质量总评分）。
    acceptance: summarizeAcceptance(events),
    conflicts,
    usage: { unkeyedCalls: tokens.unkeyedCalls },
    tokens,
    skillUsage: computeSkillUsage(events),
    findings,
    rejects: computeRejects(events),
    progress: computeProgress(events),
    // §8.3：agent 最近发言（有界：每节点 ≤5、全局 ≤200 条）。
    activity: computeAgentActivity(events),
  }
}

// ---------------------------------------------------------------------------
// Markdown 导出（纯渲染，供 GET /runs/<runId>/export 用）
// ---------------------------------------------------------------------------

/** 导出里事件时间线的上限：200k 条事件不该生成几十 MB 的 md。 */
export const EXPORT_TIMELINE_LIMIT = 2000

function mdCell(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .slice(0, 300)
}

function usageText(usage) {
  if (!isPlainObject(usage)) return ''
  const base = `in ${usage.input} / cacheRead ${usage.cacheRead} / cacheWrite ${usage.cacheWrite} / out ${usage.output}`
  return usage.reasoning === undefined ? base : `${base}（reasoning ${usage.reasoning} 含在 out 内）`
}

/**
 * 状态机转移的一行摘要（日志抽屉的事件行 / 导出时间线共用同一口径）：
 * `n_a → n_b · PASS`；有 `attempt` 时追加 ` · attempt=2`。
 *
 * 缺 `from`（初始态出发）时写 `?` —— 不编造起点；`to` / `event` 缺失时同样写 `?`
 * （校验器已经拦过，这里只是展示层的防御）。没有 attempt 就**不**补 `attempt=1`。
 *
 * @param {Record<string, unknown>} data `machine/transition` 的 data
 * @returns {string}
 */
export function machineTransitionSummary(data) {
  const info = isPlainObject(data) ? data : {}
  const pick = value => (typeof value === 'string' && value.trim() !== '' ? value : '?')
  const parts = [`${pick(info.from)} → ${pick(info.to)}`]
  if (typeof info.event === 'string' && info.event.trim() !== '') parts.push(info.event)
  if (Number.isInteger(info.attempt) && info.attempt >= 1) parts.push(`attempt=${info.attempt}`)
  return parts.join(' · ')
}

function eventDigest(event) {
  const data = event && event.data ? event.data : {}
  switch (event && event.kind) {
    case 'run/start':
      return `flow ${data.flowId || ''} ${data.flowName || ''} · 阶段 ${data.nodeTotal}`
    case 'run/end':
      return `${event.extra && event.extra.terminalScope === 'instance' ? '旧执行实例失权 · ' : ''}status=${data.status}${data.reason ? ` · ${data.reason}` : ''}`
    case 'node/start':
      return `${data.title || ''} · ${data.mode}${Array.isArray(data.skills) && data.skills.length > 0 ? ` · skills: ${data.skills.join(', ')}` : ''}`
    case 'node/end':
      return `status=${data.status} · ${data.durationMs}ms`
    case 'machine/transition':
      return machineTransitionSummary(data)
    case 'node/tools':
      // 0.10 §2.2（R6）：事件表里至少让人看出「这个会话的注册表里有几个工具」。
      return `可用工具 ${data.count} 个`
        + (data.toolsSource === 'unavailable' ? ' · 宿主未提供工具枚举' : '')
        + (data.truncated ? ' · 已截断' : '')
    case 'member/start':
      return `${data.name || ''}${data.role ? `（${data.role}）` : ''}`
    case 'member/end':
      return `status=${data.status} · ${data.durationMs}ms`
    case 'model/call':
      return `${data.provider || ''}/${data.model || ''} · ${usageText(data.usage)}`
    case 'agent/message':
      return `${data.role || ''} · ${String(data.text || '')}${data.truncated ? ' …' : ''}`
    case 'tool/call':
      return `${data.name || ''} · ok=${data.ok}${data.durationMs === undefined ? '' : ` · ${data.durationMs}ms`}`
    case 'skill/load':
      return `${data.skill || ''} · ok=${data.ok}`
    case 'artifact/write':
      return `${data.path || ''} · ${data.bytes} bytes · ${data.kind}`
        + (typeof data.sha256 === 'string' && data.sha256 !== '' ? ` · sha256 ${data.sha256.slice(0, 12)}…` : ' · 未校验')
    case 'reject/trigger':
      return `${data.edgeId || ''} · ${data.fromNodeId} → ${data.toNodeId} · ${data.reason || ''}`
    case 'review/finding':
      return `${data.severity || ''} ${data.id || ''} · ${data.status} · ${data.title || ''}`
    case 'review/verdict':
      return `${data.verdict} · findings=${data.findingCount}`
    case 'check/form':
      return `${data.ruleSetId || ''}@${data.ruleSetVersion || ''} · ${data.state}`
    case 'acceptance/verdict':
      return `${data.itemId || ''} · ${data.status} · ${data.decidedBy}`
    case 'test/report':
      return `${data.suite || ''} · ${data.passed}/${data.executed} passed`
        + (data.failed > 0 ? ` · ${data.failed} failed` : '')
    default:
      return ''
  }
}

function indexNodes(events) {
  const map = new Map()
  for (const event of events) {
    if (!event || typeof event.nodeId !== 'string') continue
    if (!map.has(event.nodeId)) {
      map.set(event.nodeId, { nodeId: event.nodeId, attempts: new Set(), events: 0, firstTs: event.ts, lastTs: event.ts, status: null })
    }
    const entry = map.get(event.nodeId)
    entry.events += 1
    if (Number.isInteger(event.attemptId)) entry.attempts.add(event.attemptId)
    if (typeof event.ts === 'string') {
      if (!entry.firstTs) entry.firstTs = event.ts
      entry.lastTs = event.ts
    }
    if (event.kind === 'node/end' && event.data && typeof event.data.status === 'string') {
      entry.status = event.data.status
    }
  }
  return [...map.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId))
}

/**
 * 渲染 markdown：run 头 + 进度 / token / skill / 审查 / 打回 + 节点索引 + 时间线。
 * @param {Record<string, any>} meta run 元数据
 * @param {object[]} events
 * @param {ReturnType<typeof summarize>} [summary]
 */
export function renderRunMarkdown(meta = {}, events = [], summary = null) {
  const s = summary || summarize(events)
  const run = meta || {}
  const lines = []

  lines.push(`# 运行日志：${mdCell(run.name || run.id || '未命名 run')}`)
  lines.push('')
  lines.push(`- runId: \`${run.id || ''}\``)
  lines.push(`- 流程: ${mdCell(run.flowName || '')}（\`${run.flowId || ''}\`）`)
  lines.push(`- 状态: \`${run.status || 'unknown'}\``)
  lines.push(`- 引擎: \`${s.engine || 'real'}\`${s.engine === 'stub' ? '（桩数据，不是真实证据）' : ''}`)
  lines.push(`- 开始: ${run.startedAt || '—'}`)
  lines.push(`- 结束: ${run.endedAt || '—'}`)
  lines.push(`- 事件数: ${s.eventCount}（聚合于 ${s.computedAt}）`)
  lines.push('')

  const progress = s.progress
  const ratio = progress.ratio === null ? '未检测' : `${(progress.ratio * 100).toFixed(1)}%`
  lines.push('## 阶段进度')
  lines.push('')
  lines.push(`passed ${progress.passed} / ${progress.denominator}（总阶段 ${progress.total}，skipped ${progress.skipped} 不计入分母）· ${ratio}${progress.invalidated > 0 ? ` · 返工失效 ${progress.invalidated}（${progress.invalidatedNodes.join(', ')}）` : ''}`)
  lines.push('')

  const acceptance = s.acceptance || { passed: 0, total: 0, rate: null }
  lines.push('## 验收条目')
  lines.push('')
  lines.push(`通过 ${acceptance.passed} / ${acceptance.total}${acceptance.rate === null ? '（通过率未检测：没有验收条目）' : ` · 通过率 ${(acceptance.rate * 100).toFixed(1)}%`}`)
  lines.push('')

  const tokens = s.tokens.total
  lines.push('## Token（四段互斥）')
  lines.push('')
  lines.push(`input ${tokens.input} · cacheRead ${tokens.cacheRead} · cacheWrite ${tokens.cacheWrite} · output ${tokens.output} · **合计 ${tokens.total}**（reasoning ${tokens.reasoning} 含在 output 内，不另计）`)
  lines.push('')
  lines.push('| 维度 | 键 | input | cacheRead | cacheWrite | output | 合计 | 调用数 |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const [key, bucket] of Object.entries(s.tokens.byNode)) {
    lines.push(`| node | ${mdCell(key)} | ${bucket.input} | ${bucket.cacheRead} | ${bucket.cacheWrite} | ${bucket.output} | ${bucket.total} | ${bucket.calls} |`)
  }
  for (const [key, bucket] of Object.entries(s.tokens.byMember)) {
    lines.push(`| member | ${mdCell(key)} | ${bucket.input} | ${bucket.cacheRead} | ${bucket.cacheWrite} | ${bucket.output} | ${bucket.total} | ${bucket.calls} |`)
  }
  lines.push('')

  const skill = s.skillUsage
  lines.push('## Skill 覆盖')
  lines.push('')
  lines.push(`声明 ${skill.declaredCount} 个唯一 skill，成功加载 ${skill.loadedCount} 个，coverage ${skill.coverage === null ? '未检测（无声明）' : `${(skill.coverage * 100).toFixed(1)}%`}`)
  lines.push('')
  lines.push(`- 加载次数: ${skill.loads.total}（成功 ${skill.loads.ok} / 失败 ${skill.loads.failed}，次数与覆盖率分开）`)
  lines.push(`- 未加载: ${skill.missing.length > 0 ? skill.missing.join(', ') : '—'}`)
  lines.push(`- 未声明但加载: ${skill.undeclared.length > 0 ? skill.undeclared.join(', ') : '—'}`)
  lines.push('')

  const findings = s.findings
  lines.push('## 审查发现')
  lines.push('')
  lines.push(`唯一发现 ${findings.total} 条（原始事件 ${findings.reportedCount} 条）· P0 ${findings.bySeverity.P0} / P1 ${findings.bySeverity.P1} / P2 ${findings.bySeverity.P2}`)
  lines.push('')
  lines.push(`未解决 ${findings.unresolved}（P0 ${findings.unresolvedBySeverity.P0} / P1 ${findings.unresolvedBySeverity.P1} / P2 ${findings.unresolvedBySeverity.P2}）· 已复验 ${findings.verified} · 已关闭 ${findings.dismissed} · 采纳率 ${findings.acceptedRate === null ? '未检测（分母为 0）' : `${(findings.acceptedRate * 100).toFixed(1)}%`}`)
  lines.push('')

  const rejects = s.rejects
  lines.push('## 打回')
  lines.push('')
  lines.push(`共 ${rejects.total} 次`)
  lines.push('')
  lines.push('| 维度 | 键 | 次数 |')
  lines.push('| --- | --- | ---: |')
  for (const [key, count] of Object.entries(rejects.byEdge)) lines.push(`| 边 | ${mdCell(key)} | ${count} |`)
  for (const [key, count] of Object.entries(rejects.byTarget)) lines.push(`| 目标节点 | ${mdCell(key)} | ${count} |`)
  lines.push('')

  // R4（§6）：外部观察附录。外部事件仍展示，但明确标注「外部未验证」，
  // 且它们不在上面的权威通过计数里（summarize 已在权威索引之前分区）。
  const externalCount = Number.isInteger(s.externalCount)
    ? s.externalCount
    : events.filter(isExternalEvent).length
  if (externalCount > 0) {
    const observations = Array.isArray(s.externalObservations)
      ? s.externalObservations
      : sortEvents(events.filter(isExternalEvent)).slice(-EXTERNAL_OBSERVATION_LIMIT).map(event => ({
        kind: event.kind,
        seq: Number.isInteger(event.seq) ? event.seq : null,
        summary: eventDigest(event),
      }))
    lines.push('## 外部观察（外部未验证）')
    lines.push('')
    lines.push(`- 共 ${externalCount} 条外部观察；来源未验证，不计入权威通过数 / 质量总评分（已删除） / run.status。`)
    lines.push('')
    lines.push('| seq | kind | 摘要 |')
    lines.push('| ---: | --- | --- |')
    for (const item of observations) {
      lines.push(`| ${item.seq ?? '—'} | \`${item.kind || ''}\` | ${mdCell(item.summary || '')} · 外部未验证 |`)
    }
    lines.push('')
  }

  const nodes = indexNodes(events)
  lines.push('## 节点索引')
  lines.push('')
  lines.push('| 节点 | attempt | 事件数 | 首事件 | 末事件 | 末次 node/end |')
  lines.push('| --- | --- | ---: | --- | --- | --- |')
  for (const node of nodes) {
    lines.push(`| ${mdCell(node.nodeId)} | ${[...node.attempts].sort((a, b) => a - b).join(', ') || '—'} | ${node.events} | ${node.firstTs || '—'} | ${node.lastTs || '—'} | ${node.status || '—'} |`)
  }
  lines.push('')

  const timeline = events.length > EXPORT_TIMELINE_LIMIT
    ? events.slice(-EXPORT_TIMELINE_LIMIT)
    : events
  lines.push(`## 事件时间线${events.length > EXPORT_TIMELINE_LIMIT ? `（最近 ${EXPORT_TIMELINE_LIMIT} / 共 ${events.length} 条）` : ''}`)
  lines.push('')
  lines.push('| seq | ts | kind | 节点 | attempt | member | 摘要 |')
  lines.push('| ---: | --- | --- | --- | ---: | --- | --- |')
  for (const event of timeline) {
    // R4（§6）：时间线仍展示外部事件，但必须标「外部未验证」，避免被读成权威通过。
    const digest = eventDigest(event) + (isExternalEvent(event) ? ' · 外部未验证' : '')
    lines.push(`| ${event.seq ?? '—'} | ${event.ts || '—'} | \`${event.kind}\` | ${mdCell(event.nodeId || '—')} | ${event.attemptId ?? '—'} | ${mdCell(event.memberId || '—')} | ${mdCell(digest)} |`)
  }
  lines.push('')

  return `${lines.join('\n')}\n`
}
