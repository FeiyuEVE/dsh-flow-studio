/**
 * 实例域模型工具（0.13.8）：`flow_instance_worktrees`。
 *
 * E3 之后实例生命周期工具也会加进这个文件；本文件保持「只做参数校验 + 结果裁剪」，
 * 业务语义一律走 BpmnRuntime.handle —— 与 HTTP 路由同一份实现。这样：
 *   - prune 的预览 plan 与执行共享 runtime 的 `_prunePlans` 缓存，模型拿到的
 *     `planHash` 和 HTTP 调用方拿到的是同一份（不会出现「预览在工具里、执行在路由里」）；
 *   - ACTIVE / SUSPENDED 409、PLAN_STALE、workspaceId 校验等错误码不需要在这里
 *     复制第二套。
 *
 * @module @feiyueve/dsh-flow-studio/instance-tools
 */

import { normalizeShortVariables } from './node-finish.js'

/** 单个字符串字段的结果上限（2 KiB）。 */
const MAX_FIELD_BYTES = 2 * 1024
/** 数组最多保留的条目数（超出部分用一条说明代替，避免模型上下文被清单撑爆）。 */
const MAX_ARRAY_ITEMS = 200
const MAX_DEPTH = 8

const ACTIONS = ['inspect', 'remove', 'branch', 'list', 'prune']
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{12}$/
const HEAD_PATTERN = /^[0-9a-f]{40,64}$/i
const PLAN_HASH_PATTERN = /^[0-9a-f]{64}$/
/** 与 instance-message-store 同口径（这里只做本地早拒绝，真上限在 Host 侧）。 */
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ACTIVITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const EXECUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const MAX_MESSAGE_BYTES = 1024 * 1024

const TIMEOUT_WORKTREE_MS = 60_000
const TIMEOUT_MESSAGE_MS = 30_000
const TIMEOUT_READ_MS = 30_000
/** 启动 / 完成任务可能等在飞 agent，超时给足（与 run 的节点时限量级一致）。 */
const TIMEOUT_RUN_MS = 10 * 60_000

/** 新域状态集合（与 instance-store 的同名契约一致）。 */
const INSTANCE_STATUSES = ['ACTIVE', 'COMPLETED', 'SUSPENDED', 'CANCELED']
const TERMINAL_STATUSES = new Set(['COMPLETED', 'CANCELED'])
const INCLUDE_VALUES = ['tasks', 'artifacts', 'lastError']
const MAX_LIST_LIMIT = 200
const MAX_EVENT_LIMIT = 200
const DEFAULT_LIST_LIMIT = 50
const DEFAULT_EVENT_LIMIT = 50
/** 单条事件里「结构化正文」的内联上限；超过给 bodyRef，不把大文本塞进模型上下文。 */
const EVENT_PAYLOAD_BYTES = 1024
/** definition_get 返回 XML 的上限；超过截断并显式标记（不构造非法 XML 尾注）。 */
const MAX_DEFINITION_XML_BYTES = 64 * 1024
/** instance_get 走 GET /instances（纯读，不懒恢复），单次扫描上限与路由一致。 */
const INSTANCE_SCAN_LIMIT = 1000
const DEFINITION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

class ParamError extends Error {
  constructor(message, hint, code) {
    super(message)
    this.name = 'ParamError'
    this.hint = hint
    if (typeof code === 'string') this.code = code
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function argsOf(args) {
  if (!isObject(args)) throw new ParamError('工具参数必须是一个 JSON 对象', '按工具的参数 schema 传对象参数。')
  return args
}

function optionalString(args, key, { max = 200 } = {}) {
  const value = argsOf(args)[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ParamError(`参数 ${key} 必须是字符串`, `按 ${key} 的说明改正后重发。`)
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > max) throw new ParamError(`参数 ${key} 超过 ${max} 字符`, `把 ${key} 缩短到 ${max} 字符以内。`)
  return trimmed
}

function optionalBoolean(args, key) {
  const value = argsOf(args)[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new ParamError(`参数 ${key} 必须是布尔值`, `按 ${key} 的说明传 true / false。`)
  return value
}

function optionalEnum(args, key, allowed) {
  const value = argsOf(args)[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !allowed.includes(value.trim())) {
    throw new ParamError(
      `参数 ${key} 必须是 ${allowed.join(' / ')} 之一`,
      `按 ${key} 的说明改正后重发（只接受 ${allowed.join(' / ')}）。`,
    )
  }
  return value.trim()
}

function requireInstanceId(args, action) {
  const value = optionalString(args, 'instanceId', { max: 64 })
  if (value === undefined) {
    throw new ParamError(
      `action=「${action}」需要 instanceId`,
      '先用 action:"list" 找到实例 id；instanceId 由实例启动 / 列表接口返回。',
    )
  }
  if (!INSTANCE_ID_PATTERN.test(value)) {
    throw new ParamError(
      '参数 instanceId 不合法（只允许字母、数字、点、下划线、连字符，1–64 位，且以字母或数字开头）',
      '照实例列表里的 id 原样传。',
    )
  }
  return value
}

/**
 * 实例 id：agent 会话里的工具带 binding 时**不允许改参数跨实例投递**。
 *
 * @param {object} args
 * @param {{instanceId?: string}|null} binding
 * @param {string} action
 */
function resolveBoundInstanceId(args, binding, action) {
  const provided = optionalString(args, 'instanceId', { max: 64 })
  const bound = binding && typeof binding.instanceId === 'string' && binding.instanceId !== ''
    ? binding.instanceId
    : null
  if (bound !== null) {
    if (provided !== undefined && provided !== bound) {
      throw new ParamError(
        `本会话的工具绑定实例 ${bound}，不能通过改 instanceId 向 ${provided} 投递`,
        '去掉 instanceId（默认就是绑定实例），或改用面向该实例的宿主入口。',
      )
    }
    return bound
  }
  if (provided === undefined) {
    throw new ParamError(`action=「${action}」需要 instanceId`, '照实例列表里的 id 原样传。')
  }
  if (!INSTANCE_ID_PATTERN.test(provided)) {
    throw new ParamError('参数 instanceId 不合法', '照实例列表里的 id 原样传。')
  }
  return provided
}

/** 消息 / 回复目标校验（Host 侧还有一遍，这里只给出可行动的早错误）。 */
function requireMessageTarget(args) {
  const raw = args && args.target
  if (!isObject(raw)) {
    throw new ParamError(
      '参数 target 必须是对象：{activityId, executionId} 或 {activityId, delivery:"nextActivation"}',
      '精确目标带 executionId；未来节点用 delivery:"nextActivation"。',
    )
  }
  const activityId = typeof raw.activityId === 'string' ? raw.activityId.trim() : ''
  if (!ACTIVITY_ID_PATTERN.test(activityId)) {
    throw new ParamError('target.activityId 必须是 1–128 个安全字符', '照 BPMN 元素 id 原样传。')
  }
  if (raw.delivery === 'nextActivation') {
    if (raw.executionId !== undefined && raw.executionId !== null) {
      throw new ParamError('nextActivation 目标不能同时带 executionId', '两种目标互斥，只留一种。')
    }
    return { activityId, delivery: 'nextActivation' }
  }
  if (raw.delivery !== undefined) {
    throw new ParamError('target.delivery 只接受 "nextActivation"', '精确目标不要带 delivery。')
  }
  const executionId = typeof raw.executionId === 'string' ? raw.executionId.trim() : ''
  if (!EXECUTION_ID_PATTERN.test(executionId)) {
    throw new ParamError('精确目标需要 target.executionId（1–256 个安全字符）', '从实例待办 / 消息接口的 liveExecutions 拿 executionId。')
  }
  return { activityId, executionId }
}

function requireMessageId(args) {
  const value = optionalString(args, 'messageId', { max: 128 })
  if (value === undefined) throw new ParamError('缺少必填参数 messageId', '为这条外部消息生成一个稳定的 id，重试时复用。')
  if (!MESSAGE_ID_PATTERN.test(value)) {
    throw new ParamError('参数 messageId 必须是 1–128 个安全字符（字母/数字开头，可含点、下划线、冒号、连字符）', '换一个安全 id 后重发。')
  }
  return value
}

function requireMessageText(args) {
  const value = args && args.text
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ParamError('缺少必填参数 text', '消息正文不能为空；长正文由 Host 自动落盘并返回摘要。')
  }
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new ParamError(`消息正文 ${bytes} 字节超过 1 MiB 硬上限`, '把正文缩短到 1 MiB（UTF-8）以内。')
  }
  return value
}

function optionalReplyId(args) {
  const value = optionalString(args, 'replyId', { max: 128 })
  if (value !== undefined && !MESSAGE_ID_PATTERN.test(value)) {
    throw new ParamError('参数 replyId 必须是 1–128 个安全字符', '换一个安全 id 后重发。')
  }
  return value
}

function optionalReplyTargetId(args) {
  const value = optionalString(args, 'replyTargetId', { max: 64 })
  if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new ParamError('参数 replyTargetId 必须是宿主白名单里的 id（1–64 个安全字符）', '用消息接口 / 宿主配置给出的回复目标 id，不要传 URL。')
  }
  return value
}

function optionalDocument(args) {
  const value = args && args.document
  if (value === undefined || value === null) return undefined
  if (!isObject(value) || typeof value.path !== 'string' || value.path.trim() === '') {
    throw new ParamError('参数 document 必须是 { path, sha256? }', 'path 用实例工作区内的相对路径。')
  }
  return value
}

function requireDefinitionId(args) {
  const value = optionalString(args, 'definitionId', { max: 64 })
  if (value === undefined) {
    throw new ParamError('缺少必填参数 definitionId', '先调 flow_definition_list 找到定义 id；省略时不会猜「最近定义」。')
  }
  if (!DEFINITION_ID_PATTERN.test(value)) {
    throw new ParamError(
      '参数 definitionId 不合法（只允许字母、数字、点、下划线、连字符，1–64 位，且以字母或数字开头）',
      '照 flow_definition_list 里的 id 原样传。',
    )
  }
  return value
}

/** 正整数（整数或纯数字字符串），范围 [min, max]。 */
function optionalInteger(args, key, { min = 1, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  const value = argsOf(args)[key]
  if (value === undefined || value === null) return fallback
  let parsed = value
  if (typeof parsed === 'string' && /^\d+$/.test(parsed.trim())) parsed = Number(parsed.trim())
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ParamError(
      `参数 ${key} 必须是 ${min}–${max} 的整数`,
      `把 ${key} 改成范围内的整数后重发。`,
    )
  }
  return parsed
}

/** `version`：≥1 的整数或纯数字字符串（与 POST /instances 的 definitionVersion 同口径）。 */
function optionalVersion(args) {
  const value = argsOf(args).version
  if (value === undefined || value === null) return undefined
  let parsed = value
  if (typeof parsed === 'string' && /^\d+$/.test(parsed.trim())) parsed = Number(parsed.trim())
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ParamError('参数 version 必须是 ≥1 的整数', '省略 version 表示用最新版本；照定义列表里的版本号传。')
  }
  return parsed
}

function requireActivityId(args) {
  const raw = argsOf(args).activityId
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ParamError('缺少必填参数 activityId', '用实例待办里的 activityId（BPMN 元素 id）原样传。')
  }
  const value = raw.trim()
  if (Array.from(value).length > 128) {
    throw new ParamError('参数 activityId 超过 128 字符', 'activityId 是 BPMN 元素 id，不会这么长；检查是否传错。')
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ParamError('参数 activityId 不能包含控制字符', '照实例待办里的 activityId 原样传。')
  }
  return value
}

/** `include`：可选数组，只接受 tasks / artifacts / lastError，去重后返回 Set。 */
function optionalInclude(args) {
  const value = argsOf(args).include
  if (value === undefined || value === null) return new Set()
  if (!Array.isArray(value)) {
    throw new ParamError('参数 include 必须是数组', `可选值：${INCLUDE_VALUES.join(' / ')}；省略表示不展开。`)
  }
  const selected = new Set()
  for (const item of value) {
    if (typeof item !== 'string' || !INCLUDE_VALUES.includes(item.trim())) {
      throw new ParamError(
        `参数 include 只接受 ${INCLUDE_VALUES.join(' / ')}`,
        `按需选择；收到 ${JSON.stringify(item)}。`,
      )
    }
    selected.add(item.trim())
  }
  return selected
}

function optionalPayload(args) {
  const value = argsOf(args).payload
  if (value === undefined || value === null) return undefined
  if (!isObject(value)) {
    throw new ParamError('参数 payload 必须是 JSON 对象', '人工任务输出用 { key: 值 } 对象；路由只接受对象。')
  }
  return value
}

/** 当前会话 id（与旧域工具同口径：主看 agent.session.id，兜底 header.id）。 */
function sessionIdOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  if (!session) return null
  if (typeof session.id === 'string' && session.id !== '') return session.id
  const header = session.header
  if (header && typeof header.id === 'string' && header.id !== '') return header.id
  return null
}

/** 按 UTF-8 字节取前缀（不追加说明，用于 XML 这类必须保持原样的正文）。 */
function headText(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = text.slice(0, maxBytes)
  while (out !== '' && Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1)
  return out
}

/** 解析 `workspace` / `worktree` 参数，收敛成路由要的形状。 */
function parseWorkspaceArgs(args) {
  const rawWorkspace = argsOf(args).workspace
  const rawWorktree = argsOf(args).worktree
  let workspace
  if (rawWorkspace !== undefined && rawWorkspace !== null) {
    if (typeof rawWorkspace !== 'string' || rawWorkspace.trim() === '') {
      throw new ParamError('参数 workspace 必须是绝对路径字符串', '传宿主 allowlist 内的一个绝对路径；不建工作区就省略。')
    }
    const path = rawWorkspace.trim()
    if (!path.startsWith('/') || path.length > 4096) {
      throw new ParamError('参数 workspace 必须是以 / 开头的绝对路径（≤4096 字符）', '相对路径有歧义，工具不接受；省略 workspace 表示不建 worktree。')
    }
    workspace = { path }
  }
  let worktree
  if (rawWorktree !== undefined && rawWorktree !== null) {
    if (typeof rawWorktree === 'string') {
      const mode = rawWorktree.trim()
      if (!['auto', 'on', 'off'].includes(mode)) {
        throw new ParamError('参数 worktree 只接受 auto / on / off', '直接用 worktree:"auto"；更细的 cleanup / baseRef 用对象形式。')
      }
      worktree = { mode }
    } else if (isObject(rawWorktree)) {
      worktree = {}
      if (rawWorktree.mode !== undefined && rawWorktree.mode !== null) {
        if (!['auto', 'on', 'off'].includes(rawWorktree.mode)) {
          throw new ParamError('worktree.mode 只接受 auto / on / off', '按 worktree 的说明改正。')
        }
        worktree.mode = rawWorktree.mode
      }
      if (rawWorktree.cleanup !== undefined && rawWorktree.cleanup !== null) {
        if (!['retain', 'on-terminal-clean'].includes(rawWorktree.cleanup)) {
          throw new ParamError('worktree.cleanup 只接受 retain / on-terminal-clean', '默认 retain；需要终态自动清理时用 on-terminal-clean。')
        }
        worktree.cleanup = rawWorktree.cleanup
      }
      if (rawWorktree.baseRef !== undefined && rawWorktree.baseRef !== null) {
        if (typeof rawWorktree.baseRef !== 'string' || rawWorktree.baseRef.trim() === ''
          || rawWorktree.baseRef.length > 200 || rawWorktree.baseRef.startsWith('-')
          || /\s/.test(rawWorktree.baseRef)) {
          throw new ParamError('worktree.baseRef 必须是无空白、不以 - 开头的短字符串（≤200）', '默认 HEAD；需要一个分支 / commit 时传原文。')
        }
        worktree.baseRef = rawWorktree.baseRef
      }
    } else {
      throw new ParamError('参数 worktree 必须是 auto / on / off 或 {mode, cleanup, baseRef}', '按 C 的启动契约传。')
    }
  }
  if (worktree !== undefined && workspace === undefined) {
    throw new ParamError('worktree 需要同时给 workspace', 'worktree 只能描述「用哪个工作区建树」；不传 workspace 就省略 worktree。')
  }
  return { workspace, worktree }
}

/** workspace / worktree 的能力探测：缺能力时明确拒绝，绝不静默丢掉参数。 */
function workspaceSupport(runtime, needsWorktree) {
  if (typeof runtime.workspaceCapabilities !== 'function') {
    return { ok: false, missing: needsWorktree ? 'workspace/worktree' : 'workspace' }
  }
  let caps
  try {
    caps = runtime.workspaceCapabilities()
  } catch {
    return { ok: false, missing: needsWorktree ? 'workspace/worktree' : 'workspace' }
  }
  if (!isObject(caps) || caps.workspace !== true) {
    return { ok: false, missing: 'workspace' }
  }
  if (needsWorktree && caps.worktree !== true) {
    return { ok: false, missing: 'workspace/worktree' }
  }
  return { ok: true }
}

// ── 读类工具的结果投影（短字段；长正文给 bodyRef，不返回大文本） ────────────

function versionOfDefinition(version) {
  if (!isObject(version)) return null
  return {
    version: Number.isSafeInteger(version.version) ? version.version : null,
    hash: version.hash ?? null,
    createdAt: version.createdAt ?? null,
    bytes: Number.isSafeInteger(version.bytes) ? version.bytes : null,
  }
}

function projectDefinitionSummary(definition) {
  if (!isObject(definition)) return null
  return {
    id: definition.id,
    name: definition.name ?? '',
    description: definition.description ?? '',
    tags: Array.isArray(definition.tags) ? definition.tags : [],
    createdAt: definition.createdAt ?? null,
    updatedAt: definition.updatedAt ?? null,
    versionCount: Number.isSafeInteger(definition.versionCount) ? definition.versionCount : null,
    latestVersion: Number.isSafeInteger(definition.latestVersion) ? definition.latestVersion : null,
    latestHash: definition.latestHash ?? null,
  }
}

function projectInstanceSummary(instance) {
  if (!isObject(instance)) return null
  return {
    instanceId: instance.id,
    definitionId: instance.definitionId,
    definitionVersion: instance.definitionVersion,
    status: instance.status,
    startedBy: instance.startedBy ?? null,
    active: instance.active === true,
    createdAt: instance.createdAt ?? null,
    updatedAt: instance.updatedAt ?? null,
    completedAt: instance.completedAt ?? null,
    lastSeq: Number.isSafeInteger(instance.lastSeq) ? instance.lastSeq : null,
    eventCount: Number.isSafeInteger(instance.eventCount) ? instance.eventCount : null,
    revision: Number.isSafeInteger(instance.revision) ? instance.revision : null,
    pendingTaskCount: Array.isArray(instance.pendingTasks) ? instance.pendingTasks.length : 0,
    lastErrorCode: isObject(instance.lastError) ? (instance.lastError.code ?? null) : null,
  }
}

function projectEventPayload(value, instanceId, seq) {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    return { bodyRef: `/instances/${instanceId}/events?since=${Math.max(0, seq - 1)}`, truncated: true }
  }
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes <= EVENT_PAYLOAD_BYTES) return trimDeep(value)
  return {
    bodyRef: `/instances/${instanceId}/events?since=${Math.max(0, seq - 1)}`,
    bytes,
    truncated: true,
    note: '正文超过 1 KiB 不在工具结果里返回；按 bodyRef 读原始事件',
  }
}

/** 事件投影：定位字段 + 短错误；output / condition / artifacts 等正文超限只给 bodyRef。 */
function projectEvent(event, instanceId) {
  if (!isObject(event)) return null
  const seq = Number.isSafeInteger(event.seq) ? event.seq : 0
  const out = {}
  const scalars = ['seq', 'type', 'at', 'elementId', 'activityId', 'flowId', 'from', 'to',
    'attempt', 'durationMs', 'status', 'truncated']
  for (const key of scalars) {
    const value = event[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string') out[key] = value.length > 256 ? clipText(value, 256) : value
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  if (isObject(event.error)) {
    out.error = {
      code: typeof event.error.code === 'string' ? clipText(event.error.code, 128) : null,
      message: typeof event.error.message === 'string' ? clipText(event.error.message, 512) : '',
      ...(typeof event.error.elementId === 'string' ? { elementId: event.error.elementId } : {}),
      ...(typeof event.error.activityId === 'string' ? { activityId: event.error.activityId } : {}),
    }
  }
  const handled = new Set([...scalars, 'error'])
  for (const [key, value] of Object.entries(event)) {
    if (handled.has(key)) continue
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      const bytes = Buffer.byteLength(value, 'utf8')
      if (bytes > EVENT_PAYLOAD_BYTES) {
        out[key] = {
          bodyRef: `/instances/${instanceId}/events?since=${Math.max(0, seq - 1)}`,
          bytes,
          truncated: true,
          note: '正文超过 1 KiB 不在工具结果里返回；按 bodyRef 读原始事件',
        }
      } else {
        out[key] = value.length > 256 ? clipText(value, 256) : value
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    } else {
      out[key] = projectEventPayload(value, instanceId, seq)
    }
  }
  return out
}

/** 长事件列表只保留最后 N 条？不：按 seq 升序取前 limit 条，并给 nextSince / hasMore。 */
function sliceEvents(events, limit) {
  const list = Array.isArray(events) ? events.filter(isObject) : []
  return { items: list.slice(0, limit), hasMore: list.length > limit }
}


// ── 结果裁剪：长字符串截到 2 KiB（按 UTF-8 字节），数组 / 深度有界 ──────────

function clipText(text, maxBytes = MAX_FIELD_BYTES) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  // 先按字符粗切（字符数 ≥ 字节数上限时一定能截到），再按字节收敛，保证多字节字符不被切坏。
  let out = text.slice(0, maxBytes)
  while (out !== '' && Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1)
  return `${out}…（已截断，原文 ${Buffer.byteLength(text, 'utf8')} 字节）`
}

function trimDeep(value, depth = 0) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return clipText(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (depth >= MAX_DEPTH) return '[depth-limit]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map(item => trimDeep(item, depth + 1))
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[还有 ${value.length - MAX_ARRAY_ITEMS} 项已省略]`)
    return items
  }
  if (isObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = trimDeep(item, depth + 1)
    return out
  }
  return null
}

// ── 工具结果外壳 ─────────────────────────────────────────────────────────

function nullable(node, description) {
  const branch = description === undefined ? node : { ...node, description }
  return { oneOf: [branch, { type: 'null', description: '未知或不适用' }] }
}

function anyJson(description) {
  return {
    description,
    oneOf: [
      { type: 'object' }, { type: 'array' }, { type: 'string' },
      { type: 'number' }, { type: 'integer' }, { type: 'boolean' }, { type: 'null' },
    ],
  }
}

function failure(error, hint, retryable = false, extra = {}) {
  return trimDeep({ ok: false, error, hint, retryable, ...extra })
}

function renderJson(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function failureHint(status, body, action) {
  const code = typeof body?.code === 'string' ? body.code : ''
  if (code === 'INSTANCE_WORKTREE_PLAN_STALE') {
    return '预览已失效：重新调 action:"prune"（不带 planHash）拿新的 planHash，再执行；不要重发旧 planHash。'
  }
  if (code === 'INSTANCE_WORKTREE_INSTANCE_ACTIVE') {
    return '实例是 ACTIVE / SUSPENDED：先停止实例（`POST /instances/<id>/stop`，模型侧用 `flow_instance_cancel`，面板也可停止）；force 不能越过这条限制。'
  }
  if (code === 'INSTANCE_WORKTREE_PLAN_INVALID') {
    return '执行 prune 必须带预览返回的 planHash；先不带 planHash 调一次（dryRun 默认 true）。'
  }
  if (code === 'MESSAGE_ID_CONFLICT') {
    return '同一 messageId 已有不同内容：换一个 messageId，或保持内容不变重发以拿回原结果。'
  }
  if (code === 'MESSAGE_TARGET_EXPIRED') {
    return '目标 execution 已结束：不要投到同名节点的下一轮；要发给未来激活请用 {activityId, delivery:"nextActivation"}。'
  }
  if (code === 'MESSAGE_BODY_TOO_LARGE') {
    return '正文超过 1 MiB 硬上限：缩短正文（Host 已拒绝且没有写半文件）。'
  }
  if (code === 'MESSAGE_REPLY_TARGET_UNKNOWN' || code === 'MESSAGE_REPLY_TARGET_REQUIRED') {
    return '回复目标只能来自宿主白名单：从消息的 replyTargetId 里取，模型不能临时提供 URL / session。'
  }
  if (code === 'MESSAGE_DELIVERY_UNSUPPORTED') {
    return '适配器没有原生消息投递能力：消息已如实记为 failed + deliveryUnknown，不要假装已读。'
  }
  if (code === 'MESSAGE_BODY_UNSAFE') {
    return 'Host 无法把正文安全物化到工作区（路径含符号链接 / 不是普通文件 / 父目录在写入期间被替换 / 写入失败）：消息已标 failed 且不投递；检查工作区 .flow-studio-inbox 下是否被软链或非普通文件占用，修复后再用新 messageId 发送。'
  }
  if (code === 'MESSAGE_DELIVERY_STATE_WRITE_FAILED') {
    return '副作用可能已经发生（适配器已接收，但成功状态写不回 journal）：按「可能已投递」处理，不要自动重发；先让收件人确认是否收到，确需重发请换新 messageId 并说明可能重复。'
  }
  if (code === 'MESSAGE_REPLY_DISPATCH_IN_FLIGHT') {
    return '该回复正在另一个进程投递中（或无法确认旧领取者是否还存活）：不要并发重复外发；Host 不会按时间猜、不会自动接管，稍后用同一 replyId 重试，确认无人持有投递权后再处理。'
  }
  if (code === 'MESSAGE_INSTANCE_TERMINAL') {
    return '实例已 COMPLETED / CANCELED：不再受理新入站消息；已受理的回复仍可尝试投递（CANCELED 除外）。'
  }
  if (code === 'DEFINITION_NOT_FOUND' || code === 'DEFINITION_VERSION_NOT_FOUND') {
    return '定义 / 版本不存在：先调 flow_definition_list 看可用 id 与 latestVersion；不要猜 id。'
  }
  if (code === 'INSTANCE_NOT_FOUND') {
    return '实例不存在：先调 flow_instance_list 找到 instanceId；实例 id 不能跨存储根猜。'
  }
  if (code === 'BPMN_TASK_NOT_FOUND') {
    return '该活动没有在等待的人工任务：先用 flow_instance_get include:["tasks"] 读当前待办，activityId 必须与待办一致。'
  }
  if (code === 'TASK_ALREADY_COMPLETED') {
    return '同一人工任务只能完成一次；重复提交被拒绝且没有产生新事件。需要继续流程请读实例当前待办。'
  }
  if (code === 'BPMN_INSTANCE_TERMINAL' || code === 'INSTANCE_ALREADY_TERMINAL') {
    return '实例已是终态（COMPLETED / CANCELED）：终态不可逆，不能再取消 / 完成任务；查询仍可读。'
  }
  if (code === 'BPMN_INSTANCE_NOT_WAITING' || code === 'BPMN_INSTANCE_BLOCKED' || code === 'BPMN_INSTANCE_STOPPING') {
    return '实例当前不处于「等待人工任务」：读 flow_instance_get 看 status / pendingTasks / lastError 后再决定，不要重试同一次提交。'
  }
  if (code === 'INSTANCE_SUSPEND_BUSY') {
    return '实例还有未结束的活动（agent / HTTP）：挂起只能在无在飞活动时进行；等活动结束（HTTP 未结算先按 connector 记录处置）后再挂起，不要并发硬试。'
  }
  if (code === 'INSTANCE_ALREADY_SUSPENDED') {
    return '实例已经是 SUSPENDED：不要重复挂起（没有产生新事件）；要恢复推进请用 flow_instance_resume。'
  }
  if (code === 'INSTANCE_NOT_SUSPENDED') {
    return '实例当前不是 SUSPENDED：只有挂起中的实例才能恢复；先 flow_instance_suspend（或读 flow_instance_get 确认状态）。'
  }
  if (code === 'INSTANCE_SUSPENDED') {
    return '实例已挂起（SUSPENDED）：挂起期间不能完成人工任务、也不自动推进；先 flow_instance_resume，再完成 / 发消息。'
  }
  if (code === 'BPMN_REASON_INVALID') {
    return 'reason 只接受不含控制字符的短字符串（≤200 字符）；省略表示不写原因。'
  }
  if (code === 'INSTANCE_TERMINAL_IMMUTABLE') {
    return '实例已被其它请求收成终态，本次写入未被采纳；以读回的状态为准。'
  }
  if (code === 'NODE_VARIABLES_INVALID' || code === 'BPMN_VARIABLES_INVALID') {
    return 'variables 只接受 boolean / number / null / 短字符串：键 ≤32、单串 ≤512 字符、序列化 ≤8 KiB；嵌套对象与数组请改为标量或放到文档。'
  }
  if (code === 'BPMN_STARTED_BY_INVALID') {
    return 'startedBy 只能是不含控制字符的短会话 id（≤200 字符）；工具会从调用方上下文自动填，不要手工伪造。'
  }
  if (code === 'WORKSPACE_NOT_ALLOWED') {
    return 'workspace 不在宿主 FLOW_STUDIO_WORKSPACE_ROOTS 白名单内：换 allowlist 内的绝对路径，或省略 workspace。'
  }
  if (code === 'WORKSPACE_MISSING' || code === 'WORKSPACE_INVALID') {
    return 'workspace 路径不存在 / 不是目录：用宿主机上真实存在的绝对路径；不建工作区就省略。'
  }
  if (code === 'WORKSPACE_NOT_GIT' || code === 'INSTANCE_WORKTREE_NOT_GIT') {
    return 'worktree.mode:"on" 需要 Git 仓库根；非 Git 目录用 mode:"auto"（回退原目录）或省略 worktree。'
  }
  if (code === 'WORKSPACE_GIT_UNAVAILABLE' || code === 'INSTANCE_WORKTREE_GIT_UNAVAILABLE') {
    return '宿主 Git 不可用：这是宿主环境问题，不是参数问题；去掉 worktree 选项重试或让运维确认 git 可用。'
  }
  if (code === 'CURSOR_INVALID' || code === 'INSTANCE_CURSOR_INVALID') {
    return 'cursor 只接受上一页返回的 nextCursor（一个实例 id）；结果集变化后重新从第一页开始。'
  }
  if (code === 'BPMN_VERSION_INVALID' || code === 'BPMN_LIMIT_INVALID' || code === 'INSTANCE_FILTER_INVALID') {
    return '查询 / 启动参数不合法：version ≥1、limit 是正整数、status 只用 ACTIVE / COMPLETED / SUSPENDED / CANCELED。'
  }
  if (code === 'BPMN_HANDLER_MISSING' || code === 'BPMN_HANDLER_FAILED') {
    return '实例启动时 handler / adapter 不可用：实例已建成但停在 ACTIVE + lastError；读 flow_instance_get include:["lastError"] 看原因。'
  }
  if (status === 405) return '方法不匹配：工具已按只读 / 写接口分流；这通常意味着 runtime 版本与工具不匹配，报告宿主版本。'
  if (status === 404) return `${action}失败：实例或消息记录不存在，先读取实例详情 / 消息列表确认 id。`
  if (status === 409) return '冲突（409）：实例状态或幂等键已变化；读回最新状态再决定。'
  if (status === 410) return '目标已过期（410）：按 error 原文改用 nextActivation 或当前 live execution。'
  if (status === 413) return '正文 / 附件超过上限（413）：缩短后重发。'
  if (status === 403) return '回复目标不在宿主白名单（403）：不要尝试任意 URL / session。'
  if (status === 400) return '参数或请求不合法：按 error 原文改正后重发。'
  if (status >= 500) return 'Host 侧投递 / 存储失败：重试一次，持续失败就报告原因。'
  return '按 error 原文处理。'
}

/**
 * 创建实例域模型工具：worktree（0.13.8）+ 收件箱（0.13.10）。
 *
 * `binding` 由运行时在 agent 节点会话里注入：`{instanceId, executionId?, activityId?}`。
 * 绑定后 `instanceId` 参数只能省略或与绑定值相同，改参数跨实例投递会被本地拒绝。
 *
 * @param {{runtime?: {handle: Function}, getRuntime?: () => {handle: Function},
 *   binding?: {instanceId?: string, executionId?: string, activityId?: string}|null}} deps
 * @returns {object[]} 可直接交给 `tools.register` 的工具定义数组
 */
export function createInstanceTools(deps = {}) {
  const direct = deps && isObject(deps.runtime) && typeof deps.runtime.handle === 'function'
    ? deps.runtime
    : null
  const getRuntime = typeof deps?.getRuntime === 'function'
    ? deps.getRuntime
    : (direct === null ? null : () => direct)
  if (getRuntime === null) {
    throw new TypeError('createInstanceTools 需要 { runtime } 或 { getRuntime }（BpmnRuntime.handle）')
  }
  const binding = isObject(deps?.binding) ? { ...deps.binding } : null

  function runtimeOrError() {
    const runtime = getRuntime()
    if (!isObject(runtime) || typeof runtime.handle !== 'function') {
      return { runtime: null, error: 'BPMN 运行时不可用：宿主没有启用实例域' }
    }
    return { runtime, error: '' }
  }

  /**
   * 发一个 JSON 请求给实例域路由，返回 `{status, body}` 或 `{error}`。
   * 不裁剪、不翻译错误：读类工具要自己投影字段。
   */
  async function rawRequest(runtime, { method = 'POST', parts, url, body }) {
    let result
    try {
      result = await runtime.handle({ method, parts, url, body })
    } catch (error) {
      return { error, status: 0, body: null }
    }
    const status = result && Number.isInteger(result.status) ? result.status : 0
    const responseBody = isObject(result && result.body) ? result.body : null
    return { error: null, status, body: responseBody }
  }

  /** 错误体里是否带着**实例状态**字符串（ACTIVE / COMPLETED / SUSPENDED / CANCELED）。 */
  function instanceStatusOf(body) {
    const status = isObject(body) ? body.status : undefined
    return typeof status === 'string' && INSTANCE_STATUSES.includes(status) ? status : undefined
  }

  /**
   * rawRequest 的失败分流；成功返回 null。
   *
   * `options.statusField === 'httpStatus'` 是**只给生命周期工具**的显式字段映射：
   * HTTP 语义状态写进 `httpStatus:number`，`status` 只在错误体确实带实例状态字符串时
   * 才输出（0.14.4 MINOR-4）。其它 11 个工具保持旧契约（`status` = HTTP 状态），
   * 不因为本地修一个 schema 违例而改掉它们的错误形状。
   */
  function routeFailure(raw, action, options = {}) {
    const statusField = options?.statusField === 'httpStatus' ? 'httpStatus' : 'status'
    const withHttpStatus = status => (statusField === 'httpStatus' ? { httpStatus: status } : { status })
    const withInstanceStatus = body => {
      if (statusField !== 'httpStatus') return {}
      const status = instanceStatusOf(body)
      return status === undefined ? {} : { status }
    }
    if (raw.error) {
      return failure(
        `调用实例域接口失败：${raw.error && raw.error.message ? raw.error.message : String(raw.error)}`,
        '这是 Host 侧运行时错误；稍后重试，持续失败就报告。',
        true,
        { action },
      )
    }
    if (raw.body === null) {
      return failure('Host 返回了不可读的响应', '检查 BPMN 运行时是否正常；稍后重试。', true, {
        action,
        ...withHttpStatus(raw.status),
      })
    }
    if (raw.status < 200 || raw.status >= 300 || raw.body.ok !== true) {
      return failure(
        typeof raw.body.error === 'string' && raw.body.error !== '' ? raw.body.error : `Host 返回 HTTP ${raw.status}`,
        failureHint(raw.status, raw.body, action),
        raw.status >= 500,
        {
          action,
          ...withHttpStatus(raw.status),
          ...(typeof raw.body.code === 'string' ? { code: raw.body.code } : {}),
          ...withInstanceStatus(raw.body),
        },
      )
    }
    return null
  }

  /** 发一个 JSON 请求给实例域路由；统一把 Host 错误翻成工具结果。 */
  async function callRoute(runtime, { method = 'POST', parts, url, body, action }) {
    const raw = await rawRequest(runtime, { method, parts, url, body })
    const bad = routeFailure(raw, action)
    if (bad !== null) return bad
    return trimDeep({ action, status: raw.status, ...raw.body })
  }

  const worktreeTool = {
    name: 'flow_instance_worktrees',
    description:
      '查看 / 清理实例域的一棵 git worktree（0.13.8；实例创建时由 workspace.worktree 触发，运行中不能切换）。'
      + 'action=inspect：检查某个实例的工作区（路径 / Git 登记 / branch / HEAD / dirty / 可清理性）；'
      + 'remove：删除工作树（危险；可带 force / removeBranch / expectedHead，ACTIVE / SUSPENDED 一律 409）；'
      + 'branch：只删记录确属本实例的分支，不动目录；'
      + 'list：列出所有实例工作树（含 orphan 标记），可带 workspaceId；'
      + 'prune：默认 dryRun:true，只生成预览与 planHash；确认后带同一 planHash 再调一次（dryRun:false）才执行删除。'
      + '预览之后状态变化会让旧 planHash 失效（409 PLAN_STALE），此时重新预览，不要重发旧 hash。'
      + '无所有权证据的目录只报告不删；force 不能越过 ACTIVE / SUSPENDED。'
      + 'inspect / remove / branch 需要 instanceId；list 可带 workspaceId；prune 也支持 workspaceId 限定。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'inspect = 检查单个实例工作区；remove = 删除工作树；branch = 只删分支；list = 列出全部；prune = 预览 / 执行全局清理',
        },
        instanceId: {
          type: 'string',
          description: '实例 id（inspect / remove / branch 必填；字母/数字开头，只含字母、数字、点、下划线、连字符，≤64 位）',
        },
        workspaceId: {
          type: 'string',
          description: '工作区 id（list / prune 可选；12 位小写十六进制，用于只看某个主仓库下的树）',
        },
        force: {
          type: 'boolean',
          description: 'action=remove：true 时删除脏树（不能越过 ACTIVE / SUSPENDED，也不能越过 expectedHead 校验）',
        },
        removeBranch: {
          type: 'boolean',
          description: 'action=remove：删除目录后是否同时删除本实例分支（结果单独返回，不以目录删除冒充分支成功）',
        },
        dryRun: {
          type: 'boolean',
          description: 'action=prune：默认 true。false 时必须带预览返回的 planHash；不带 planHash 时只能预览',
        },
        planHash: {
          type: 'string',
          description: 'action=prune：预览返回的 64 位小写十六进制 planHash；带它且 dryRun:false 才会真正删除',
        },
        expectedHead: {
          type: 'string',
          description: 'action=remove：期望的工作树 HEAD（40–64 位十六进制）；与当前 HEAD 不一致时拒绝删除',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: '成功为 true；失败为 false（看 error / hint / retryable / code）' },
          action: { type: 'string', description: '本次动作：inspect / remove / branch / list / prune' },
          status: { type: 'integer', description: 'Host 路由返回的 HTTP 语义状态' },
          code: { type: 'string', description: '失败时的稳定业务码（如 INSTANCE_WORKTREE_PLAN_STALE）' },
          error: { type: 'string', description: '失败原因（Host 原文，可读中文）' },
          hint: { type: 'string', description: '下一步该做什么' },
          retryable: { type: 'boolean', description: '是否值得重试；参数错误 / 404 / 409 / PLAN_STALE 为 false' },
          id: { type: 'string', description: '实例 id（inspect / remove / branch）' },
          configured: { type: 'boolean', description: '实例是否登记了工作区' },
          mode: nullable({ type: 'string' }, '工作区模式：worktree / off'),
          instanceStatus: nullable({ type: 'string' }, '实例状态（ACTIVE / COMPLETED / SUSPENDED / CANCELED）'),
          workspaceId: nullable({ type: 'string' }, '工作区 id'),
          effectiveRoot: nullable({ type: 'string' }, '实例实际使用的工作目录'),
          cleanupPolicy: nullable({ type: 'string' }, 'cleanup 策略：retain / on-terminal-clean'),
          worktree: anyJson('inspect 的确定性检查结果（state / path / branch / head / dirty / reasons …）'),
          cleanable: { type: 'boolean', description: '当前是否满足可清理条件（终态 + inspect cleanable）' },
          removed: {
            description: 'remove：工作树是否真的删除（boolean）；prune 执行：已删除条目数组',
            oneOf: [
              { type: 'boolean' },
              { type: 'array', items: anyJson('prune 已删除条目') },
            ],
          },
          reason: nullable({ type: 'string' }, '删除结果原因（not-found / dirty / not-registered …）'),
          path: nullable({ type: 'string' }, '工作树路径'),
          branch: nullable({ type: 'string' }, '实例分支'),
          branchRemoval: anyJson('分支删除结果（removed / branch / reason / warning）'),
          worktrees: { type: 'array', description: 'action=list：工作树条目（超过 200 条时截断，真实数量看 worktreeCount）', items: anyJson('单个工作树条目') },
          orphans: { type: 'array', description: 'action=list：孤儿条目（超过 200 条时截断，真实数量看 orphanCount）', items: anyJson('孤儿工作树') },
          worktreeCount: { type: 'integer', description: 'action=list：裁剪前的真实工作树数量' },
          orphanCount: { type: 'integer', description: 'action=list：裁剪前的真实孤儿数量' },
          truncated: { type: 'boolean', description: 'action=list / prune：数组是否因超过 200 条被裁剪（计数仍用裁剪前总数）' },
          corrupt: { type: 'array', description: 'action=list：损坏的所有权记录', items: anyJson('损坏记录') },
          scannedAt: nullable({ type: 'string' }, '列表扫描时间（ISO 8601）'),
          dryRun: { type: 'boolean', description: 'action=prune：本次是否为预览' },
          planHash: nullable({ type: 'string' }, 'action=prune：预览 / 执行对应的 planHash'),
          plan: anyJson('action=prune 预览：{ v, createdAt, entries, planHash }'),
          removable: { type: 'integer', description: 'action=prune 预览：计划删除的条目数' },
          reported: { type: 'integer', description: 'action=prune 预览：只报告 / 保留的条目数' },
          removedCount: { type: 'integer', description: 'action=prune 执行：裁剪前的真实删除数' },
          skippedCount: { type: 'integer', description: 'action=prune 执行：裁剪前的真实跳过数' },
          skipped: { type: 'array', description: 'action=prune 执行：跳过的条目（含原因）', items: anyJson('跳过条目') },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(value) {
        if (!isObject(value) || value.ok !== true) return renderJson(value)
        if (value.action === 'inspect') {
          if (value.configured !== true) return [{ type: 'text', text: `实例 ${value.id || '?'} 没有配置工作区。` }]
          const worktree = isObject(value.worktree) ? value.worktree : null
          if (worktree === null) {
            return [{ type: 'text', text: `实例 ${value.id || '?'} 使用原目录（${value.effectiveRoot || '?'}），没有独立 worktree。` }]
          }
          return [{
            type: 'text',
            text: `实例 ${value.id} 工作树：${worktree.state}（${worktree.path}，分支 ${worktree.branch || '?'}，`
              + `HEAD ${String(worktree.head || '').slice(0, 12) || '?'}，dirty=${worktree.dirty}，`
              + `可清理=${value.cleanable === true}）。`,
          }]
        }
        if (value.action === 'remove') {
          const branch = isObject(value.branchRemoval)
            ? `；分支${value.branchRemoval.removed === true ? '已删除' : '未删除（' + (value.branchRemoval.reason || '?') + '）'}`
            : ''
          return [{ type: 'text', text: `删除工作树${value.removed === true ? '成功' : '未成功（' + (value.reason || '?') + '）'}${branch}。` }]
        }
        if (value.action === 'branch') {
          const removal = isObject(value.branchRemoval) ? value.branchRemoval : {}
          return [{
            type: 'text',
            text: `分支 ${removal.branch || '?'}${removal.removed === true ? ' 已删除。' : ` 未删除（${removal.reason || '?'}）${removal.warning ? '：' + removal.warning : ''}。`}`,
          }]
        }
        if (value.action === 'list') {
          const list = Array.isArray(value.worktrees) ? value.worktrees : []
          // 计数必须用裁剪前的真实数量：trimDeep 会在 200 项后追加一条省略说明，
          // 直接拿裁剪后数组长度会把「201」当成真实数量（复审 MINOR）。
          const total = Number.isSafeInteger(value.worktreeCount) ? value.worktreeCount : list.length
          const orphanCount = Number.isSafeInteger(value.orphanCount)
            ? value.orphanCount
            : (Array.isArray(value.orphans) ? value.orphans.length : 0)
          const lines = list.slice(0, 50).map(item => (
            `- ${item.instanceId || '?'}${item.orphan === true ? '（孤儿）' : ''}：${item.path || '(无 path)'}`
              + `${item.instanceStatus ? ' · ' + item.instanceStatus : ''}`
          ))
          const tail = total > 50 ? `\n…还有 ${total - 50} 个` : ''
          return [{
            type: 'text',
            text: `共 ${total} 个实例工作树，其中孤儿 ${orphanCount} 个`
              + `${value.truncated === true ? '（清单已截断）' : ''}：\n${lines.join('\n')}${tail}`,
          }]
        }
        if (value.dryRun === true) {
          return [{
            type: 'text',
            text: `prune 预览：将删除 ${value.removable ?? 0} 个、仅报告 / 保留 ${value.reported ?? 0} 个；`
              + `planHash=${value.planHash || '?'}。确认后带同一 planHash 且 dryRun:false 再调一次。`,
          }]
        }
        const removed = Number.isInteger(value.removedCount)
          ? value.removedCount
          : (Array.isArray(value.removed) ? value.removed.length : 0)
        const skipped = Number.isInteger(value.skippedCount)
          ? value.skippedCount
          : (Array.isArray(value.skipped) ? value.skipped.length : 0)
        return [{ type: 'text', text: `prune 执行完成：删除 ${removed} 个、跳过 ${skipped} 个。` }]
      },
    },
    timeoutMs: TIMEOUT_WORKTREE_MS,
    // 既有读也有写（remove / prune），串行执行。
    async execute(args) {
      let action
      let instanceId
      let workspaceId
      let force
      let removeBranch
      let dryRun
      let planHash
      let expectedHead
      try {
        action = optionalEnum(args, 'action', ACTIONS)
        if (action === undefined) {
          throw new ParamError('缺少必填参数 action', `传 ${ACTIONS.join(' / ')} 之一。`)
        }
        if (action === 'inspect' || action === 'remove' || action === 'branch') {
          instanceId = requireInstanceId(args, action)
        } else {
          instanceId = optionalString(args, 'instanceId', { max: 64 })
          if (instanceId !== undefined && !INSTANCE_ID_PATTERN.test(instanceId)) {
            throw new ParamError('参数 instanceId 不合法', '照实例列表里的 id 原样传，或省略它。')
          }
        }
        workspaceId = optionalString(args, 'workspaceId', { max: 12 })
        if (workspaceId !== undefined && !WORKSPACE_ID_PATTERN.test(workspaceId)) {
          throw new ParamError('参数 workspaceId 必须是 12 位小写十六进制', 'workspaceId 由 list 的条目返回，照原样传。')
        }
        force = optionalBoolean(args, 'force')
        removeBranch = optionalBoolean(args, 'removeBranch')
        dryRun = optionalBoolean(args, 'dryRun')
        planHash = optionalString(args, 'planHash', { max: 64 })
        if (planHash !== undefined && !PLAN_HASH_PATTERN.test(planHash)) {
          throw new ParamError('参数 planHash 必须是 64 位小写十六进制', '用上一次 action:"prune" 预览返回的 planHash 原样传。')
        }
        expectedHead = optionalString(args, 'expectedHead', { max: 64 })
        if (expectedHead !== undefined && !HEAD_PATTERN.test(expectedHead)) {
          throw new ParamError('参数 expectedHead 必须是 40–64 位十六进制', '用 action:"inspect" 返回的 worktree.head。')
        }
        if (action === 'prune' && dryRun === false && planHash === undefined) {
          throw new ParamError(
            '执行 prune 必须带预览返回的 planHash',
            '先调 action:"prune"（dryRun 默认 true）拿 planHash；确认后带同一 planHash 且 dryRun:false。',
          )
        }
      } catch (error) {
        if (error instanceof ParamError) return failure(error.message, error.hint)
        return failure('读取参数失败：' + (error && error.message ? error.message : String(error)), '按参数说明改正后重发。')
      }

      const { runtime, error: runtimeError } = runtimeOrError()
      if (runtime === null) return failure(runtimeError, '确认宿主启用了实例域（BPMN 运行时）后重试。')

      let method
      let parts
      let body
      const url = new URL('http://localhost/')
      if (action === 'inspect') {
        method = 'GET'
        parts = ['instances', instanceId, 'worktree']
      } else if (action === 'remove') {
        method = 'DELETE'
        parts = ['instances', instanceId, 'worktree']
        body = { force: force === true, removeBranch: removeBranch === true }
        if (expectedHead !== undefined) body.expectedHead = expectedHead
      } else if (action === 'branch') {
        method = 'DELETE'
        parts = ['instances', instanceId, 'worktree', 'branch']
      } else if (action === 'list') {
        method = 'GET'
        parts = ['instance-worktrees']
        if (workspaceId !== undefined) url.searchParams.set('workspaceId', workspaceId)
      } else {
        method = 'POST'
        parts = ['instance-worktrees', 'prune']
        // 复审 F8：planHash 只证明「这是哪一份计划」，不能代替执行意图。
        // 省略 dryRun 一律按默认 true 预览；只有显式 dryRun:false 才执行删除。
        const effectiveDryRun = dryRun !== false
        body = { dryRun: effectiveDryRun }
        if (planHash !== undefined) body.planHash = planHash
        if (workspaceId !== undefined) body.workspaceId = workspaceId
      }

      let result
      try {
        result = await runtime.handle({ method, parts, url, body })
      } catch (error) {
        return failure(
          `调用实例工作区接口失败：${error && error.message ? error.message : String(error)}`,
          '这是 Host 侧运行时错误；稍后重试，持续失败就报告。',
          true,
          { action },
        )
      }
      const status = result && Number.isInteger(result.status) ? result.status : 0
      const responseBody = isObject(result && result.body) ? result.body : null
      if (responseBody === null) {
        return failure('Host 返回了不可读的响应', '检查 BPMN 运行时是否正常；稍后重试。', true, { action, status })
      }
      if (status < 200 || status >= 300 || responseBody.ok !== true) {
        return failure(
          typeof responseBody.error === 'string' && responseBody.error !== '' ? responseBody.error : `Host 返回 HTTP ${status}`,
          failureHint(status, responseBody, action),
          status >= 500,
          {
            action,
            status,
            ...(typeof responseBody.code === 'string' ? { code: responseBody.code } : {}),
          },
        )
      }
      // 先在**裁剪前**记下真实数量：trimDeep 会把数组截到 200 项 + 一条省略提示，
      // 用裁剪后的 length 报数会多算一条（复审 MINOR）。
      const payload = { action, status, ...responseBody }
      if (action === 'list') {
        payload.worktreeCount = Array.isArray(responseBody.worktrees) ? responseBody.worktrees.length : 0
        payload.orphanCount = Array.isArray(responseBody.orphans) ? responseBody.orphans.length : 0
        payload.truncated = payload.worktreeCount > MAX_ARRAY_ITEMS || payload.orphanCount > MAX_ARRAY_ITEMS
      }
      if (action === 'prune' && responseBody.dryRun === false) {
        payload.removedCount = Array.isArray(responseBody.removed) ? responseBody.removed.length : 0
        payload.skippedCount = Array.isArray(responseBody.skipped) ? responseBody.skipped.length : 0
        payload.truncated = payload.removedCount > MAX_ARRAY_ITEMS || payload.skippedCount > MAX_ARRAY_ITEMS
      }
      return trimDeep(payload)
    },
  }

  const sendMessageTool = {
    name: 'flow_instance_send_message',
    description:
      '向实例域投递一条外部消息（0.13.10）。两种互斥目标：'
      + '精确目标 {activityId, executionId} 只投给当前这一次执行；'
      + '未来节点 {activityId, delivery:"nextActivation"} 只绑定后续第一次激活，不广播到循环的每一轮。'
      + '同一实例下 messageId 相同且内容相同返回原结果，内容不同 409。'
      + '执行已结束返回 MESSAGE_TARGET_EXPIRED；实例 SUSPENDED 可受理排队但不唤起 agent，'
      + 'COMPLETED / CANCELED 拒绝新消息。正文超过 4 KiB 自动落盘（只回摘要 + 正文引用），'
      + '超过 1 MiB 返回 413。消息不会代替 flow_finish_node 或人工任务完成。',
    parameters: {
      type: 'object',
      properties: {
        instanceId: {
          type: 'string',
          description: '实例 id；agent 会话里的工具已绑定本实例时可省略（不能改成别的实例）',
        },
        messageId: {
          type: 'string',
          description: '外部消息的稳定幂等键（1–128 个安全字符，重试复用同一个）',
        },
        target: {
          type: 'object',
          description: '精确目标 {activityId, executionId}，或未来节点 {activityId, delivery:"nextActivation"}',
          properties: {
            activityId: { type: 'string', description: 'BPMN 元素 id' },
            executionId: { type: 'string', description: '精确目标：当前活动的 executionId' },
            delivery: { type: 'string', enum: ['nextActivation'], description: '未来节点：只绑定后续第一次激活' },
          },
          required: ['activityId'],
        },
        text: { type: 'string', description: '消息正文（非空，UTF-8 ≤ 1 MiB）' },
        replyTargetId: {
          type: 'string',
          description: '可选：宿主白名单里的回复目标 id（不是 URL / session 本身）',
        },
      },
      required: ['messageId', 'target', 'text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: '成功为 true；失败为 false（看 error / hint / retryable / code）' },
          action: { type: 'string' },
          status: { type: 'integer', description: 'Host 路由返回的 HTTP 语义状态' },
          code: { type: 'string', description: '失败时的稳定业务码' },
          error: { type: 'string' },
          hint: { type: 'string' },
          retryable: { type: 'boolean' },
          id: { type: 'string', description: '实例 id' },
          duplicate: { type: 'boolean', description: '是否命中同 messageId + 同内容的幂等结果' },
          message: anyJson('受理后的消息投影（含 status / preview / body 引用 / delivery）'),
          delivery: anyJson('本次投递结果（confirmed / failed / remaining / deferred）'),
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(value) {
        if (!isObject(value) || value.ok !== true) return renderJson(value)
        const message = isObject(value.message) ? value.message : {}
        const status = typeof message.status === 'string' ? message.status : 'queued'
        const delivery = isObject(value.delivery) ? value.delivery : null
        const confirmed = delivery && Array.isArray(delivery.confirmed) ? delivery.confirmed.length : 0
        const failed = delivery && Array.isArray(delivery.failed) ? delivery.failed.length : 0
        return [{
          type: 'text',
          text: `消息 ${message.messageId || '?'} ${value.duplicate === true ? '已存在（幂等返回）' : '已受理'}，`
            + `状态 ${status}${confirmed > 0 ? `，本次确认投递 ${confirmed} 条` : ''}`
            + `${failed > 0 ? `，失败 ${failed} 条` : ''}`
            + `${delivery && delivery.deferred === true ? '，实例挂起：已排队不唤起 agent' : ''}。`
            + '消息不会代替节点完结或人工任务完成。',
        }]
      },
    },
    timeoutMs: TIMEOUT_MESSAGE_MS,
    async execute(args) {
      let instanceId
      let messageId
      let target
      let text
      let replyTargetId
      try {
        instanceId = resolveBoundInstanceId(args, binding, 'send_message')
        messageId = requireMessageId(args)
        target = requireMessageTarget(args)
        text = requireMessageText(args)
        replyTargetId = optionalReplyTargetId(args)
      } catch (error) {
        if (error instanceof ParamError) return failure(error.message, error.hint)
        return failure('读取参数失败：' + (error && error.message ? error.message : String(error)), '按参数说明改正后重发。')
      }
      const { runtime, error: runtimeError } = runtimeOrError()
      if (runtime === null) return failure(runtimeError, '确认宿主启用了实例域（BPMN 运行时）后重试。')
      return await callRoute(runtime, {
        action: 'send_message',
        parts: ['instances', instanceId, 'messages'],
        url: new URL('http://localhost/'),
        body: {
          messageId,
          target,
          text,
          ...(replyTargetId === undefined ? {} : { replyTargetId }),
        },
      })
    },
  }

  const replyTool = {
    name: 'flow_instance_reply',
    description:
      '对一条已受理的实例消息发送受控回复（0.13.10）。回复目标来自宿主白名单（消息的 '
      + 'replyTargetId），模型不能临时提供 URL / session；回复先写 outbox，再用稳定 replyId 投递，'
      + '重试不会生成新的 replyId。给人工任务的消息只是讨论 / 附件，不写完成变量、不完成节点。',
    parameters: {
      type: 'object',
      properties: {
        instanceId: {
          type: 'string',
          description: '实例 id；agent 会话里的工具已绑定本实例时可省略（不能改成别的实例）',
        },
        messageId: { type: 'string', description: '要回复的消息 id' },
        replyId: {
          type: 'string',
          description: '可选：稳定幂等键；重试复用同一个（省略时按内容确定性生成）',
        },
        text: { type: 'string', description: '回复正文（与 document 至少给一项）' },
        document: {
          type: 'object',
          description: '可选附件：{ path, sha256? }，path 必须是实例工作区内的相对路径',
          properties: {
            path: { type: 'string' },
            sha256: { type: 'string' },
          },
          required: ['path'],
        },
      },
      required: ['messageId'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          status: { type: 'integer' },
          code: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
          retryable: { type: 'boolean' },
          id: { type: 'string' },
          duplicate: { type: 'boolean' },
          reply: anyJson('outbox 记录（status / delivery / attempts / lastError）'),
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(value) {
        if (!isObject(value) || value.ok !== true) return renderJson(value)
        const reply = isObject(value.reply) ? value.reply : {}
        const status = typeof reply.status === 'string' ? reply.status : 'queued'
        const unknown = isObject(reply.delivery) && reply.delivery.deliveryUnknown === true
        return [{
          type: 'text',
          text: `回复 ${reply.replyId || '?'} 状态 ${status}${unknown ? '（deliveryUnknown：不能确认对端已收到）' : ''}`
            + `${value.duplicate === true ? '，重复请求已幂等返回' : ''}。`,
        }]
      },
    },
    timeoutMs: TIMEOUT_MESSAGE_MS,
    async execute(args) {
      let instanceId
      let messageId
      let replyId
      let text
      let document
      try {
        instanceId = resolveBoundInstanceId(args, binding, 'reply')
        messageId = requireMessageId(args)
        replyId = optionalReplyId(args)
        text = args && args.text
        if (text !== undefined && typeof text !== 'string') {
          throw new ParamError('参数 text 必须是字符串', '文字回复用 text；附件用 document。')
        }
        document = optionalDocument(args)
        if ((text === undefined || text.trim() === '') && document === undefined) {
          throw new ParamError('回复需要 text 或 document 至少一项', '补上正文或工作区内附件路径。')
        }
      } catch (error) {
        if (error instanceof ParamError) return failure(error.message, error.hint)
        return failure('读取参数失败：' + (error && error.message ? error.message : String(error)), '按参数说明改正后重发。')
      }
      const { runtime, error: runtimeError } = runtimeOrError()
      if (runtime === null) return failure(runtimeError, '确认宿主启用了实例域（BPMN 运行时）后重试。')
      return await callRoute(runtime, {
        action: 'reply',
        parts: ['instances', instanceId, 'messages', messageId, 'replies'],
        url: new URL('http://localhost/'),
        body: {
          ...(replyId === undefined ? {} : { replyId }),
          ...(text === undefined ? {} : { text }),
          ...(document === undefined ? {} : { document }),
        },
      })
    },
  }

  const definitionListTool = {
    name: 'flow_definition_list',
    description:
      '列出实例域可见的 BPMN 定义（只读 GET /definitions，纯磁盘读取，不启动实例、不建 runner）。'
      + 'keyword 按 id / name / description / tags 不区分大小写模糊过滤；limit 默认 50、封顶 200。'
      + '返回短摘要，不含 XML 正文；要看某一版 XML 用 flow_definition_get。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '可选：按 id / name / description / tags 模糊过滤（不区分大小写，≤200 字符）' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, description: `最多返回多少条（默认 ${DEFAULT_LIST_LIMIT}，封顶 ${MAX_LIST_LIMIT}）` },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          httpStatus: { type: 'integer', description: 'Host 路由返回的 HTTP 语义状态' },
          code: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
          retryable: { type: 'boolean' },
          keyword: nullable({ type: 'string' }),
          definitions: { type: 'array', items: anyJson('定义摘要（id / name / tags / latestVersion / latestHash …）') },
          count: { type: 'integer' },
          total: { type: 'integer', description: '过滤后、裁剪前的总数' },
          hasMore: { type: 'boolean' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(value) {
        if (!isObject(value) || value.ok !== true) return renderJson(value)
        const list = Array.isArray(value.definitions) ? value.definitions : []
        const lines = list.map(item => `- ${item.id}（${item.name || '未命名'}）v${item.latestVersion ?? '?'}${item.tags?.length ? ' · ' + item.tags.join(',') : ''}`)
        const tail = value.hasMore === true ? `\n…还有 ${Math.max(0, (value.total ?? 0) - list.length)} 个` : ''
        return [{
          type: 'text',
          text: `共 ${value.total ?? list.length} 个定义${value.keyword ? `（keyword=${value.keyword}）` : ''}：\n${lines.join('\n') || '（空）'}${tail}`,
        }]
      },
    },
    timeoutMs: TIMEOUT_READ_MS,
    async execute(args) {
      let keyword
      let limit
      try {
        keyword = optionalString(args, 'keyword', { max: 200 })
        limit = optionalInteger(args, 'limit', { max: MAX_LIST_LIMIT, fallback: DEFAULT_LIST_LIMIT })
      } catch (error) {
        if (error instanceof ParamError) return failure(error.message, error.hint)
        return failure('读取参数失败：' + (error && error.message ? error.message : String(error)), '按参数说明改正后重发。')
      }
      const { runtime, error: runtimeError } = runtimeOrError()
      if (runtime === null) return failure(runtimeError, '确认宿主启用了实例域（BPMN 运行时）后重试。')
      const raw = await rawRequest(runtime, {
        method: 'GET', parts: ['definitions'], url: new URL('http://localhost/'),
      })
      const bad = routeFailure(raw, 'definition_list')
      if (bad !== null) return bad
      const all = Array.isArray(raw.body.definitions) ? raw.body.definitions.filter(isObject) : []
      const needle = keyword === undefined ? null : keyword.toLowerCase()
      const filtered = needle === null
        ? all
        : all.filter(item => [item.id, item.name, item.description, ...(Array.isArray(item.tags) ? item.tags : [])]
          .some(text => typeof text === 'string' && text.toLowerCase().includes(needle)))
      const definitions = filtered.slice(0, limit).map(projectDefinitionSummary).filter(item => item !== null)
      return trimDeep({
        ok: true,
        action: 'definition_list',
        httpStatus: raw.status,
        keyword: keyword ?? null,
        definitions,
        count: definitions.length,
        total: filtered.length,
        hasMore: filtered.length > limit,
      })
    },
  }

  const definitionGetTool = {
    name: 'flow_definition_get',
    description:
      '读取一份 BPMN 定义（只读 GET /definitions/<id>[?version=]，纯磁盘读取，不启动实例）。'
      + 'version 省略取 latestVersion。返回元数据 + 该版本 XML（超过 64 KiB 截断并标记 xmlTruncated，'
      + 'xmlBytes 给真实字节数）；版本不存在时用 flow_definition_list 看可用版本。',
    parameters: {
      type: 'object',
      properties: {
        definitionId: { type: 'string', description: '定义 id（字母/数字开头，只含字母、数字、点、下划线、连字符，≤64 位）' },
        version: { type: 'integer', minimum: 1, description: '可选：指定版本号（≥1）；省略取最新版本' },
      },
      required: ['definitionId'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          httpStatus: { type: 'integer' },
          code: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
          retryable: { type: 'boolean' },
          definitionId: { type: 'string' },
          definitionVersion: nullable({ type: 'integer' }),
          name: nullable({ type: 'string' }),
          description: nullable({ type: 'string' }),
          tags: { type: 'array', items: { type: 'string' } },
          latestVersion: nullable({ type: 'integer' }),
          latestHash: nullable({ type: 'string' }),
          hash: nullable({ type: 'string' }),
          bytes: nullable({ type: 'integer' }),
          xmlBytes: nullable({ type: 'integer' }),
          xmlTruncated: { type: 'boolean' },
          versions: { type: 'array', items: anyJson('版本摘要') },
          xml: nullable({ type: 'string' }),
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(value) {
        if (!isObject(value) || value.ok !== true) return renderJson(value)
        return [{
          type: 'text',
          text: `定义 ${value.definitionId}${value.name ? `（${value.name}）` : ''} `
            + `v${value.definitionVersion ?? '?'} / latest v${value.latestVersion ?? '?'}，`
            + `${value.xmlBytes ?? value.bytes ?? '?'} 字节${value.xmlTruncated === true ? '（XML 已按 64 KiB 截断）' : ''}。`,
        }]
      },
    },
    timeoutMs: TIMEOUT_READ_MS,
    async execute(args) {
      let definitionId
      let version
      try {
        definitionId = requireDefinitionId(args)
        version = optionalVersion(args)
      } catch (error) {
        if (error instanceof ParamError) return failure(error.message, error.hint)
        return failure('读取参数失败：' + (error && error.message ? error.message : String(error)), '按参数说明改正后重发。')
      }
      const { runtime, error: runtimeError } = runtimeOrError()
      if (runtime === null) return failure(runtimeError, '确认宿主启用了实例域（BPMN 运行时）后重试。')
      const url = new URL('http://localhost/')
      if (version !== undefined) url.searchParams.set('version', String(version))
      const raw = await rawRequest(runtime, { method: 'GET', parts: ['definitions', definitionId], url })
      const bad = routeFailure(raw, 'definition_get')
      if (bad !== null) return bad
      const body = raw.body
      const xml = typeof body.xml === 'string' ? body.xml : null
      const payload = {
        ok: true,
        action: 'definition_get',
        httpStatus: raw.status,
        definitionId: body.id ?? definitionId,
        definitionVersion: Number.isSafeInteger(body.version) ? body.version : null,
        name: body.name ?? null,
        description: body.description ?? null,
        tags: Array.isArray(body.tags) ? body.tags : [],
        latestVersion: Number.isSafeInteger(body.latestVersion) ? body.latestVersion : null,
        latestHash: body.latestHash ?? null,
        hash: body.hash ?? null,
        bytes: Number.isSafeInteger(body.bytes) ? body.bytes : null,
        versions: (Array.isArray(body.versions) ? body.versions : []).map(versionOfDefinition).filter(item => item !== null),
        xml: null,
        xmlBytes: xml === null ? null : Buffer.byteLength(xml, 'utf8'),
        xmlTruncated: false,
      }
      const trimmed = trimDeep(payload)
      if (xml !== null) {
        trimmed.xml = headText(xml, MAX_DEFINITION_XML_BYTES)
        trimmed.xmlTruncated = trimmed.xmlBytes > MAX_DEFINITION_XML_BYTES
      }
      return trimmed
    },
  }

  const runTool = {
    name: 'flow_instance_run',
    description:
      '启动一个流程实例（POST /instances）并推到第一个等待点或终态。'
      + 'variables 只接受 finish 同口径的短标量（≤32 键、单串 ≤512 字符、序列化 ≤8 KiB）；嵌套对象 / 数组直接拒绝。'
      + 'workspace 是宿主 allowlist 内的绝对路径；worktree 复用 C 的启动契约（auto / on / off，或 {mode, cleanup, baseRef}）。'
      + '当前 runtime 没有 workspace 能力时明确拒绝（WORKSPACE_POLICY_MISSING），不会静默忽略参数。'
      + 'startedBy 绑定本次调用的会话，不推断「最近实例」。',
    parameters: {
      type: 'object',
      properties: {
        definitionId: { type: 'string', description: '定义 id（必填）' },
        version: { type: 'integer', minimum: 1, description: '可选：定义版本号；省略取最新版本' },
        variables: {
          type: 'object',
          description: '启动变量：只接受 boolean / number / null / 短字符串（≤32 键，单串 ≤512 字符，总量 ≤8 KiB）',
        },
        workspace: {
          type: 'string',
          description: '可选：工作区绝对路径（宿主 allowlist 校验）；省略表示不建实例工作区',
        },
        worktree: {
          description: '可选：worktree 模式（auto / on / off）或 {mode, cleanup, baseRef}；给 worktree 必须同时给 workspace',
          oneOf: [
            { type: 'string', enum: ['auto', 'on', 'off'] },
            {
              type: 'object',
              properties: {
                mode: { type: 'string', enum: ['auto', 'on', 'off'] },
                cleanup: { type: 'string', enum: ['retain', 'on-terminal-clean'] },
                baseRef: { type: 'string' },
              },
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['definitionId'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          httpStatus: { type: 'integer' },
          code: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
          retryable: { type: 'boolean' },
          instanceId: { type: 'string' },
          definitionId: { type: 'string' },
          definitionVersion: nullable({ type: 'integer' }),
          status: { type: 'string', description: '实例状态（ACTIVE / COMPLETED / SUSPENDED / CANCELED）' },
          startedBy: nullable({ type: 'string' }, '启动本次实例的调用方会话 id（无会话上下文时为 null）'),
          pendingTasks: { type: 'array', items: anyJson('人工任务') },
          lastSeq: nullable({ type: 'integer' }),
          workspace: anyJson('工作区投影（仅请求带 workspace 时出现）'),
          startError: anyJson('启动阶段 handler 失败：实例已建成并保持 ACTIVE，原因在这里'),
          recovered: { type: 'boolean' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(value) {
        if (!isObject(value) || value.ok !== true) return renderJson(value)
        const started = value.startedBy === null || value.startedBy === undefined ? '无会话上下文' : value.startedBy
        return [{
          type: 'text',
          text: `实例 ${value.instanceId} 已启动：status=${value.status}，`
            + `定义 ${value.definitionId}@v${value.definitionVersion ?? '?'}，调用方 ${started}`
            + `${value.pendingTasks?.length ? `，等待 ${value.pendingTasks.length} 个人工任务` : ''}`
            + `${value.startError ? `；启动阶段失败：${value.startError.code || value.startError.message || '见 startError'}` : ''}。`,
        }]
      },
    },
    timeoutMs: TIMEOUT_RUN_MS,
    async execute(args, exec) {
      let definitionId
      let version
      let variables
      let workspaceOption
      try {
        definitionId = requireDefinitionId(args)
        version = optionalVersion(args)
        const rawVariables = argsOf(args).variables
        if (rawVariables === undefined || rawVariables === null) {
          variables = {}
        } else {
          try {
            variables = normalizeShortVariables(rawVariables)
          } catch (error) {
            throw new ParamError(
              error && error.message ? error.message : 'variables 不合法',
              'variables 只接受 boolean / number / null / 短字符串：键 ≤32、单串 ≤512 字符、序列化 ≤8 KiB。',
              'NODE_VARIABLES_INVALID',
            )
          }
        }
        workspaceOption = parseWorkspaceArgs(args)
      } catch (error) {
        if (error instanceof ParamError) {
          return failure(error.message, error.hint, false, {
            ...(typeof error.code === 'string' ? { code: error.code } : {}),
          })
        }
        return failure('读取参数失败：' + (error && error.message ? error.message : String(error)), '按参数说明改正后重发。')
      }
      const { runtime, error: runtimeError } = runtimeOrError()
      if (runtime === null) return failure(runtimeError, '确认宿主启用了实例域（BPMN 运行时）后重试。')
      const needsWorktree = workspaceOption.worktree !== undefined
      if (workspaceOption.workspace !== undefined) {
        const support = workspaceSupport(runtime, needsWorktree)
        if (support.ok !== true) {
          return failure(
            `当前运行时没有 ${support.missing} 能力：拒绝执行，而不是静默忽略 workspace / worktree`,
            '去掉 workspace / worktree 让节点使用宿主默认工作区，或升级 / 配置宿主的 workspace 策略后重试。',
            false,
            { action: 'run', code: 'WORKSPACE_POLICY_MISSING' },
          )
        }
      }
      const startedBy = sessionIdOf(exec)
      const raw = await rawRequest(runtime, {
        method: 'POST',
        parts: ['instances'],
        url: new URL('http://localhost/'),
        body: {
          definitionId,
          ...(version === undefined ? {} : { definitionVersion: version }),
          variables,
          ...(startedBy === null ? {} : { startedBy }),
          ...(workspaceOption.workspace === undefined
            ? {}
            : {
              workspace: {
                path: workspaceOption.workspace.path,
                ...(workspaceOption.worktree === undefined ? {} : { worktree: workspaceOption.worktree }),
              },
            }),
        },
      })
      const bad = routeFailure(raw, 'run')
      if (bad !== null) return bad
      const body = raw.body
      return trimDeep({
        ok: true,
        action: 'run',
        httpStatus: raw.status,
        instanceId: body.id,
        definitionId: body.definitionId,
        definitionVersion: Number.isSafeInteger(body.definitionVersion) ? body.definitionVersion : null,
        status: body.status,
        startedBy: body.startedBy ?? startedBy ?? null,
        pendingTasks: Array.isArray(body.pendingTasks) ? body.pendingTasks : [],
        lastSeq: Number.isSafeInteger(body.lastSeq) ? body.lastSeq : null,
        ...(body.workspace === undefined ? {} : { workspace: body.workspace }),
        ...(isObject(body.error) ? { startError: body.error } : {}),
        recovered: body.recovered === true,
      })
    },
  }

  const instanceListTool = {
    name: 'flow_instance_list',
    description:
      '列出流程实例（只读 GET /instances，纯磁盘读取，不恢复 / 不推进任何实例）。'
      + '可按 definitionId / status 过滤；limit 默认 50、封顶 200；cursor 用上一页返回的 nextCursor，'
      + '只在该结果集内有效（结果集变化后从第一页重新开始）。',
    parameters: {
      type: 'object',
      properties: {
        definitionId: { type: 'string', description: '可选：按定义 id 精确过滤' },
        status: { type: 'string', enum: INSTANCE_STATUSES, description: '可选：按实例状态精确过滤' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, description: `每页条数（默认 ${DEFAULT_LIST_LIMIT}，封顶 ${MAX_LIST_LIMIT}）` },
        cursor: { type: 'string', description: '上一页返回的 nextCursor（一个实例 id）；省略表示第一页' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          httpStatus: { type: 'integer' },
          code: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
          retryable: { type: 'boolean' },
          instances: { type: 'array', items: anyJson('实例摘要') },
          count: { type: 'integer' },
          hasMore: { type: 'boolean' },
          nextCursor: nullable({ type: 'string' }, '下一页游标；没有更多时为 null'),
          cursor: nullable({ type: 'string' }),
          skipped: { type: 'array', items: { type: 'string' }, description: '扫描时读不出、被跳过的实例 id' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(value) {
        if (!isObject(value) || value.ok !== true) return renderJson(value)
        const list = Array.isArray(value.instances) ? value.instances : []
        const lines = list.map(item => `- ${item.instanceId} · ${item.status} · ${item.definitionId}@v${item.definitionVersion ?? '?'}${item.pendingTaskCount > 0 ? ` · 待办 ${item.pendingTaskCount}` : ''}`)
        return [{
          type: 'text',
          text: `共返回 ${value.count ?? list.length} 个实例${value.hasMore === true ? `（还有更多；nextCursor=${value.nextCursor}）` : ''}：\n${lines.join('\n') || '（空）'}`,
        }]
      },
    },
    timeoutMs: TIMEOUT_READ_MS,
    async execute(args) {
      let definitionId
      let status
      let limit
      let cursor
      try {
        definitionId = optionalString(args, 'definitionId', { max: 64 })
        if (definitionId !== undefined && !DEFINITION_ID_PATTERN.test(definitionId)) {
          throw new ParamError('参数 definitionId 不合法', '照 flow_definition_list 里的 id 原样传。')
        }
        status = optionalEnum(args, 'status', INSTANCE_STATUSES)
        limit = optionalInteger(args, 'limit', { max: MAX_LIST_LIMIT, fallback: DEFAULT_LIST_LIMIT })
        cursor = optionalString(args, 'cursor', { max: 64 })
        if (cursor !== undefined && !INSTANCE_ID_PATTERN.test(cursor)) {
          throw new ParamError('参数 cursor 必须是上一页返回的 nextCursor（实例 id）', '省略 cursor 从第一页开始。')
        }
      } catch (error) {
        if (error instanceof ParamError) return failure(error.message, error.hint)
        return failure('读取参数失败：' + (error && error.message ? error.message : String(error)), '按参数说明改正后重发。')
      }
      const { runtime, error: runtimeError } = runtimeOrError()
      if (runtime === null) return failure(runtimeError, '确认宿主启用了实例域（BPMN 运行时）后重试。')
      const url = new URL('http://localhost/')
      if (definitionId !== undefined) url.searchParams.set('definitionId', definitionId)
      if (status !== undefined) url.searchParams.set('status', status)
      // 有 cursor 时要能在同一结果集里定位它；无 cursor 时多取一条用于判断 hasMore。
      url.searchParams.set('limit', String(cursor === undefined ? Math.min(limit + 1, INSTANCE_SCAN_LIMIT) : INSTANCE_SCAN_LIMIT))
      const raw = await rawRequest(runtime, { method: 'GET', parts: ['instances'], url })
      const bad = routeFailure(raw, 'instance_list')
      if (bad !== null) return bad
      const all = Array.isArray(raw.body.instances) ? raw.body.instances.filter(isObject) : []
      let start = 0
      if (cursor !== undefined) {
        const index = all.findIndex(item => item.id === cursor)
        if (index < 0) {
          return failure(
            `cursor ${cursor} 不在当前结果集里（结果可能已变化，或已超过单次扫描上限 ${INSTANCE_SCAN_LIMIT}）`,
            '省略 cursor 从第一页重新列出；cursor 只对上一页返回的 nextCursor 有效。',
            false,
            { action: 'instance_list', code: 'CURSOR_INVALID', status: 409 },
          )
        }
        start = index + 1
      }
      const page = all.slice(start, start + limit + 1)
      const hasMore = page.length > limit
      const instances = page.slice(0, limit).map(projectInstanceSummary).filter(item => item !== null)
      return trimDeep({
        ok: true,
        action: 'instance_list',
        httpStatus: raw.status,
        instances,
        count: instances.length,
        hasMore,
        nextCursor: hasMore ? instances[instances.length - 1].instanceId : null,
        cursor: cursor ?? null,
        skipped: Array.isArray(raw.body.skipped) ? raw.body.skipped : [],
      })
    },
  }

  const instanceGetTool = {
    name: 'flow_instance_get',
    description:
      '读取一个实例的当前事实（只读 GET /instances，纯磁盘读取：不懒恢复、不创建 runner、不推进实例）。'
      + 'include 可选 ["tasks","artifacts","lastError"] 展开对应区块；基础结果总带状态 / 变量 / 计数与待办数。'
      + '单次扫描上限 1000 个实例（与路由一致），超出时用 flow_instance_list 的 cursor 分段确认。',
    parameters: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: '实例 id；agent 会话里的工具已绑定本实例时可省略（不能改成别的实例）' },
        include: {
          type: 'array',
          items: { type: 'string', enum: INCLUDE_VALUES },
          description: '可选展开：tasks（人工待办）/ artifacts（产物引用）/ lastError（最近错误）',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          httpStatus: { type: 'integer' },
          code: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
          retryable: { type: 'boolean' },
          instanceId: { type: 'string' },
          definitionId: { type: 'string' },
          definitionVersion: nullable({ type: 'integer' }),
          definitionHash: nullable({ type: 'string' }),
          status: { type: 'string' },
          startedBy: nullable({ type: 'string' }),
          variables: anyJson('实例变量（字符串按 2 KiB 裁剪）'),
          tasks: { type: 'array', items: anyJson('人工待办'), description: '仅 include 含 tasks 时出现' },
          artifacts: { type: 'array', items: anyJson('产物引用'), description: '仅 include 含 artifacts 时出现' },
          lastError: anyJson('最近错误；仅 include 含 lastError 时出现'),
          pendingTaskCount: { type: 'integer' },
          lastErrorCode: nullable({ type: 'string' }),
          lastSeq: nullable({ type: 'integer' }),
          eventCount: nullable({ type: 'integer' }),
          revision: nullable({ type: 'integer' }),
          active: { type: 'boolean', description: '当前进程是否登记了该实例的 runner（只读快照）' },
          createdAt: nullable({ type: 'string' }),
          updatedAt: nullable({ type: 'string' }),
          completedAt: nullable({ type: 'string' }),
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(value) {
        if (!isObject(value) || value.ok !== true) return renderJson(value)
        const tasks = Array.isArray(value.tasks) ? value.tasks.length : value.pendingTaskCount
        return [{
          type: 'text',
          text: `实例 ${value.instanceId}：status=${value.status}，定义 ${value.definitionId}@v${value.definitionVersion ?? '?'}，`
            + `待办 ${tasks ?? 0} 个${value.lastErrorCode ? `，最近错误 ${value.lastErrorCode}` : ''}。`,
        }]
      },
    },
    timeoutMs: TIMEOUT_READ_MS,
    async execute(args) {
      let instanceId
      let include
      try {
        instanceId = resolveBoundInstanceId(args, binding, 'get')
        include = optionalInclude(args)
      } catch (error) {
        if (error instanceof ParamError) return failure(error.message, error.hint)
        return failure('读取参数失败：' + (error && error.message ? error.message : String(error)), '按参数说明改正后重发。')
      }
      const { runtime, error: runtimeError } = runtimeOrError()
      if (runtime === null) return failure(runtimeError, '确认宿主启用了实例域（BPMN 运行时）后重试。')
      const url = new URL(`http://localhost/?limit=${INSTANCE_SCAN_LIMIT}`)
      const raw = await rawRequest(runtime, { method: 'GET', parts: ['instances'], url })
      const bad = routeFailure(raw, 'instance_get')
      if (bad !== null) return bad
      const all = Array.isArray(raw.body.instances) ? raw.body.instances.filter(isObject) : []
      const instance = all.find(item => item.id === instanceId)
      if (instance === undefined) {
        return failure(
          `实例 ${instanceId} 不存在（或不在单次扫描的 ${INSTANCE_SCAN_LIMIT} 个实例内）`,
          '先调 flow_instance_list 确认 instanceId；工具不会因为「猜测」去懒恢复任何实例。',
          false,
          { action: 'instance_get', code: 'INSTANCE_NOT_FOUND', status: 404 },
        )
      }
      const payload = {
        ok: true,
        action: 'instance_get',
        httpStatus: raw.status,
        instanceId: instance.id,
        definitionId: instance.definitionId,
        definitionVersion: instance.definitionVersion,
        definitionHash: instance.definitionHash ?? null,
        status: instance.status,
        startedBy: instance.startedBy ?? null,
        variables: isObject(instance.variables) ? instance.variables : {},
        pendingTaskCount: Array.isArray(instance.pendingTasks) ? instance.pendingTasks.length : 0,
        lastErrorCode: isObject(instance.lastError) ? (instance.lastError.code ?? null) : null,
        lastSeq: Number.isSafeInteger(instance.lastSeq) ? instance.lastSeq : null,
        eventCount: Number.isSafeInteger(instance.eventCount) ? instance.eventCount : null,
        revision: Number.isSafeInteger(instance.revision) ? instance.revision : null,
        active: instance.active === true,
        createdAt: instance.createdAt ?? null,
        updatedAt: instance.updatedAt ?? null,
        completedAt: instance.completedAt ?? null,
      }
      if (include.has('tasks')) payload.tasks = Array.isArray(instance.pendingTasks) ? instance.pendingTasks : []
      if (include.has('artifacts')) payload.artifacts = Array.isArray(instance.artifacts) ? instance.artifacts : []
      if (include.has('lastError')) payload.lastError = isObject(instance.lastError) ? instance.lastError : null
      return trimDeep(payload)
    },
  }

  const instanceEventsTool = {
    name: 'flow_instance_events',
    description:
      '读取实例执行事件（只读 GET /instances/<id>/events?since=，不懒恢复、不创建 runner）。'
      + 'since 只返回 seq > since 的事件；limit 默认 50、封顶 200。只返回短字段；'
      + '单条事件里的长正文（output / condition / artifacts 等超过 1 KiB）替换成 bodyRef 与字节数，不塞大文本。',
    parameters: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: '实例 id；agent 会话里的工具已绑定本实例时可省略（不能改成别的实例）' },
        since: { type: 'integer', minimum: 0, description: '可选：只返回 seq > since 的事件（默认 0 = 从最早开始）' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_EVENT_LIMIT, description: `最多返回多少条（默认 ${DEFAULT_EVENT_LIMIT}，封顶 ${MAX_EVENT_LIMIT}）` },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          httpStatus: { type: 'integer' },
          code: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
          retryable: { type: 'boolean' },
          instanceId: { type: 'string' },
          events: { type: 'array', items: anyJson('短事件（seq / type / elementId / status；长正文给 bodyRef）') },
          count: { type: 'integer' },
          hasMore: { type: 'boolean' },
          nextSince: nullable({ type: 'integer' }, '下一页起点：最后一条事件的 seq；没有事件时等于请求的 since'),
          lastSeq: nullable({ type: 'integer' }, '实例当前最大 seq'),
          since: { type: 'integer' },
          skipped: { type: 'integer' },
          shards: { type: 'integer' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(value) {
        if (!isObject(value) || value.ok !== true) return renderJson(value)
        const list = Array.isArray(value.events) ? value.events : []
        const lines = list.map(item => `- #${item.seq} ${item.type}${item.elementId ? ` · ${item.elementId}` : ''}${item.status ? ` · ${item.status}` : ''}`)
        return [{
          type: 'text',
          text: `事件 ${value.count ?? list.length} 条（lastSeq=${value.lastSeq ?? '?'}${value.hasMore === true ? `；还有更多，nextSince=${value.nextSince}` : ''}）：\n${lines.join('\n') || '（空）'}`,
        }]
      },
    },
    timeoutMs: TIMEOUT_READ_MS,
    async execute(args) {
      let instanceId
      let since
      let limit
      try {
        instanceId = resolveBoundInstanceId(args, binding, 'events')
        since = optionalInteger(args, 'since', { min: 0, fallback: 0 })
        limit = optionalInteger(args, 'limit', { max: MAX_EVENT_LIMIT, fallback: DEFAULT_EVENT_LIMIT })
      } catch (error) {
        if (error instanceof ParamError) return failure(error.message, error.hint)
        return failure('读取参数失败：' + (error && error.message ? error.message : String(error)), '按参数说明改正后重发。')
      }
      const { runtime, error: runtimeError } = runtimeOrError()
      if (runtime === null) return failure(runtimeError, '确认宿主启用了实例域（BPMN 运行时）后重试。')
      const url = new URL('http://localhost/')
      if (since > 0) url.searchParams.set('since', String(since))
      const raw = await rawRequest(runtime, { method: 'GET', parts: ['instances', instanceId, 'events'], url })
      const bad = routeFailure(raw, 'instance_events')
      if (bad !== null) return bad
      const sliced = sliceEvents(raw.body.events, limit)
      const events = sliced.items.map(event => projectEvent(event, instanceId)).filter(item => item !== null)
      const lastSeq = Number.isSafeInteger(raw.body.lastSeq) ? raw.body.lastSeq : since
      const nextSince = events.length > 0 ? events[events.length - 1].seq : since
      return {
        ok: true,
        action: 'instance_events',
        httpStatus: raw.status,
        instanceId,
        events,
        count: events.length,
        hasMore: sliced.hasMore,
        nextSince: Number.isSafeInteger(nextSince) ? nextSince : since,
        lastSeq,
        since,
        skipped: Number.isSafeInteger(raw.body.skipped) ? raw.body.skipped : 0,
        shards: Number.isSafeInteger(raw.body.shards) ? raw.body.shards : 0,
      }
    },
  }

  const instanceCancelTool = {
    name: 'flow_instance_cancel',
    description:
      '取消一个非终态实例（POST /instances/<id>/stop）。终态实例（COMPLETED / CANCELED）不重复收口、'
      + '不产生新事件，工具返回 INSTANCE_ALREADY_TERMINAL。stop 不追加 process/end 等伪造事件。'
      + 'reason 只作为本次调用的说明随结果回显；路由的 stop 不接受业务原因、不落盘。',
    parameters: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: '实例 id；agent 会话里的工具已绑定本实例时可省略（不能改成别的实例）' },
        reason: { type: 'string', description: '可选：本次取消的说明（≤500 字符，随结果回显）' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          httpStatus: { type: 'integer' },
          code: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
          retryable: { type: 'boolean' },
          instanceId: { type: 'string' },
          status: { type: 'string', description: '取消后的实例状态（CANCELED）' },
          alreadyTerminal: { type: 'boolean' },
          pendingTasks: { type: 'array', items: anyJson('待办（取消后应为空）') },
          lastSeq: nullable({ type: 'integer' }),
          reason: nullable({ type: 'string' }),
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(value) {
        if (!isObject(value) || value.ok !== true) return renderJson(value)
        return [{ type: 'text', text: `实例 ${value.instanceId} 已取消：status=${value.status}。` }]
      },
    },
    timeoutMs: TIMEOUT_READ_MS,
    async execute(args) {
      let instanceId
      let reason
      try {
        instanceId = resolveBoundInstanceId(args, binding, 'cancel')
        reason = optionalString(args, 'reason', { max: 500 })
      } catch (error) {
        if (error instanceof ParamError) return failure(error.message, error.hint)
        return failure('读取参数失败：' + (error && error.message ? error.message : String(error)), '按参数说明改正后重发。')
      }
      const { runtime, error: runtimeError } = runtimeOrError()
      if (runtime === null) return failure(runtimeError, '确认宿主启用了实例域（BPMN 运行时）后重试。')
      const raw = await rawRequest(runtime, {
        method: 'POST', parts: ['instances', instanceId, 'stop'], url: new URL('http://localhost/'),
      })
      const bad = routeFailure(raw, 'cancel')
      if (bad !== null) return bad
      if (raw.body.alreadyTerminal === true) {
        return failure(
          `实例 ${instanceId} 已经是终态 ${raw.body.status}：取消被拒绝（没有产生新事件）`,
          '终态不可逆；查询 / 读事件仍可用，需要新工作请启动新实例。',
          false,
          {
            action: 'cancel',
            code: 'INSTANCE_ALREADY_TERMINAL',
            status: 409,
            instanceId,
            instanceStatus: raw.body.status ?? null,
          },
        )
      }
      return trimDeep({
        ok: true,
        action: 'cancel',
        httpStatus: raw.status,
        instanceId,
        status: raw.body.status,
        alreadyTerminal: false,
        pendingTasks: Array.isArray(raw.body.pendingTasks) ? raw.body.pendingTasks : [],
        lastSeq: Number.isSafeInteger(raw.body.lastSeq) ? raw.body.lastSeq : null,
        reason: reason ?? null,
      })
    },
  }

  /**
   * 失败（404 TASK_NOT_FOUND / 409 终态或非等待）时判断该活动是否已经完成过：
   * 事件里该 elementId 的最后一条若是 activity/end，则这是重复提交，不是「任务不存在」。
   * 只读事件文件，不碰 runner。
   */
  async function hasCompletedActivity(runtime, instanceId, activityId) {
    const raw = await rawRequest(runtime, {
      method: 'GET',
      parts: ['instances', instanceId, 'events'],
      url: new URL('http://localhost/'),
    })
    if (raw.error || raw.body === null || raw.body.ok !== true) return false
    const events = Array.isArray(raw.body.events) ? raw.body.events : []
    let last = null
    for (const event of events) {
      if (!isObject(event)) continue
      if (event.elementId === activityId || event.activityId === activityId) last = event
    }
    return last !== null && last.type === 'activity/end'
  }

  const completeTaskTool = {
    name: 'flow_instance_complete_task',
    description:
      '完成一个等待中的人工任务（POST /instances/<id>/tasks/<activityId>/complete，与 GUI 同一份实现与校验）。'
      + 'payload 是人工任务输出对象，并入实例 variables。重复完成 → TASK_ALREADY_COMPLETED（不产生新事件）；'
      + 'activityId 必须与当前待办一致（先用 flow_instance_get include:["tasks"] 读）。'
      + '实例已终态 / 不在等待时明确失败，不会伪造一次完成。',
    parameters: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: '实例 id；agent 会话里的工具已绑定本实例时可省略（不能改成别的实例）' },
        activityId: { type: 'string', description: '人工任务的活动 id（BPMN 元素 id，非空 ≤128 字符）' },
        payload: { type: 'object', description: '可选：人工任务输出（JSON 对象），并入实例 variables' },
      },
      required: ['activityId'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          httpStatus: { type: 'integer' },
          code: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
          retryable: { type: 'boolean' },
          instanceId: { type: 'string' },
          activityId: { type: 'string' },
          executionId: nullable({ type: 'string' }),
          status: { type: 'string', description: '本次完成并推进后的实例状态' },
          pendingTasks: { type: 'array', items: anyJson('剩余人工待办') },
          lastSeq: nullable({ type: 'integer' }),
          decidedBy: nullable({ type: 'string' }),
          recovered: { type: 'boolean' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(value) {
        if (!isObject(value) || value.ok !== true) return renderJson(value)
        return [{
          type: 'text',
          text: `人工任务 ${value.activityId} 已完成：实例 ${value.instanceId} status=${value.status}`
            + `${value.pendingTasks?.length ? `，还有 ${value.pendingTasks.length} 个待办` : ''}。`,
        }]
      },
    },
    timeoutMs: TIMEOUT_RUN_MS,
    async execute(args) {
      let instanceId
      let activityId
      let payload
      try {
        instanceId = resolveBoundInstanceId(args, binding, 'complete_task')
        activityId = requireActivityId(args)
        payload = optionalPayload(args)
      } catch (error) {
        if (error instanceof ParamError) return failure(error.message, error.hint)
        return failure('读取参数失败：' + (error && error.message ? error.message : String(error)), '按参数说明改正后重发。')
      }
      const { runtime, error: runtimeError } = runtimeOrError()
      if (runtime === null) return failure(runtimeError, '确认宿主启用了实例域（BPMN 运行时）后重试。')
      const raw = await rawRequest(runtime, {
        method: 'POST',
        parts: ['instances', instanceId, 'tasks', activityId, 'complete'],
        url: new URL('http://localhost/'),
        body: payload === undefined ? {} : { payload },
      })
      const duplicateCode = raw.body !== null && typeof raw.body.code === 'string' ? raw.body.code : ''
      if ((raw.status === 404 && duplicateCode === 'BPMN_TASK_NOT_FOUND')
        || (raw.status === 409 && ['BPMN_INSTANCE_TERMINAL', 'BPMN_INSTANCE_NOT_WAITING', 'BPMN_INSTANCE_STOPPING'].includes(duplicateCode))) {
        const already = await hasCompletedActivity(runtime, instanceId, activityId)
        if (already) {
          return failure(
            `人工任务 ${activityId} 已经完成过：重复提交被拒绝（没有产生新事件）`,
            '同一人工任务只能完成一次；读 flow_instance_get include:["tasks"] 看当前待办后再继续。',
            false,
            { action: 'complete_task', code: 'TASK_ALREADY_COMPLETED', status: 409, instanceId, activityId },
          )
        }
      }
      const bad = routeFailure(raw, 'complete_task')
      if (bad !== null) return bad
      const body = raw.body
      return trimDeep({
        ok: true,
        action: 'complete_task',
        httpStatus: raw.status,
        instanceId,
        activityId: body.activityId ?? activityId,
        executionId: body.executionId ?? null,
        status: body.status,
        pendingTasks: Array.isArray(body.pendingTasks) ? body.pendingTasks : [],
        lastSeq: Number.isSafeInteger(body.lastSeq) ? body.lastSeq : null,
        decidedBy: body.decidedBy ?? null,
        recovered: body.recovered === true,
      })
    },
  }

  /**
   * 挂起 / 恢复共用实现（0.14.3）：只做参数校验 + 调 `POST /instances/<id>/suspend|resume`
   * + 错误映射，业务语义（无在飞活动才能挂起、恢复不主动跑）全部在 runtime。
   */
  function lifecycleTool(spec) {
    // 生命周期工具的错误契约（0.14.4 MINOR-4）：HTTP 语义状态只进 `httpStatus:number`，
    // `status` 只在确有实例状态字符串时输出——与成功返回的 `status` 语义一致。
    const failureOptions = { statusField: 'httpStatus' }
    return {
      name: spec.name,
      description: spec.description,
      parameters: {
        type: 'object',
        properties: {
          instanceId: { type: 'string', description: '实例 id；agent 会话里的工具已绑定本实例时可省略（不能改成别的实例）' },
          reason: { type: 'string', description: '可选：本次操作的说明（≤200 字符，写进 instance/suspended|resumed 事件）' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            action: { type: 'string' },
            httpStatus: { type: 'integer' },
            code: { type: 'string' },
            error: { type: 'string' },
            hint: { type: 'string' },
            retryable: { type: 'boolean' },
            instanceId: { type: 'string' },
            status: { type: 'string', description: spec.statusDescription },
            reason: nullable({ type: 'string' }),
            lastSeq: nullable({ type: 'integer' }),
            activities: { type: 'array', items: anyJson('未结束的活动（仅 INSTANCE_SUSPEND_BUSY）') },
            [spec.timeKey]: nullable({ type: 'string' }),
          },
          required: ['ok'],
          additionalProperties: true,
        },
        render(value) {
          if (!isObject(value) || value.ok !== true) return renderJson(value)
          return [{
            type: 'text',
            text: `实例 ${value.instanceId} ${spec.doneText}：status=${value.status}${value.reason ? `，原因「${value.reason}」` : ''}。`,
          }]
        },
      },
      timeoutMs: TIMEOUT_READ_MS,
      async execute(args) {
        let instanceId
        let reason
        try {
          instanceId = resolveBoundInstanceId(args, binding, spec.action)
          reason = optionalString(args, 'reason', { max: 200 })
        } catch (error) {
          if (error instanceof ParamError) return failure(error.message, error.hint)
          return failure('读取参数失败：' + (error && error.message ? error.message : String(error)), '按参数说明改正后重发。')
        }
        const { runtime, error: runtimeError } = runtimeOrError()
        if (runtime === null) return failure(runtimeError, '确认宿主启用了实例域（BPMN 运行时）后重试。')
        const raw = await rawRequest(runtime, {
          method: 'POST',
          parts: ['instances', instanceId, spec.routeSegment],
          url: new URL('http://localhost/'),
          body: reason === undefined ? {} : { reason },
        })
        if (raw.body !== null && raw.body.code === 'INSTANCE_SUSPEND_BUSY') {
          return failure(
            typeof raw.body.error === 'string' && raw.body.error !== '' ? raw.body.error : '实例还有未结束的活动，不能挂起',
            failureHint(raw.status, raw.body, spec.action),
            false,
            {
              action: spec.action,
              httpStatus: raw.status,
              code: 'INSTANCE_SUSPEND_BUSY',
              instanceId,
              activities: Array.isArray(raw.body.activities) ? raw.body.activities : [],
              ...(instanceStatusOf(raw.body) === undefined ? {} : { status: instanceStatusOf(raw.body) }),
            },
          )
        }
        const bad = routeFailure(raw, spec.action, failureOptions)
        if (bad !== null) return bad
        return trimDeep({
          ok: true,
          action: spec.action,
          httpStatus: raw.status,
          instanceId,
          status: raw.body.status,
          reason: raw.body.reason ?? reason ?? null,
          lastSeq: Number.isSafeInteger(raw.body.lastSeq) ? raw.body.lastSeq : null,
          [spec.timeKey]: raw.body[spec.timeKey] ?? null,
        })
      },
    }
  }

  const suspendTool = lifecycleTool({
    name: 'flow_instance_suspend',
    action: 'suspend',
    routeSegment: 'suspend',
    timeKey: 'suspendedAt',
    doneText: '已挂起',
    statusDescription: '挂起后的实例状态（SUSPENDED）',
    description:
      '挂起一个没有在飞活动的实例（POST /instances/<id>/suspend，quiesce 式软挂起）。'
      + '只允许 ACTIVE 且没有正在执行的 agent / HTTP 活动；否则 409 INSTANCE_SUSPEND_BUSY 并返回 activities[]。'
      + '挂起后不杀 runner、不推进、不派发；complete 返回 409 INSTANCE_SUSPENDED，入站消息受理但排队，'
      + 'GET 不会因为读而懒恢复。重复挂起 → INSTANCE_ALREADY_SUSPENDED；终态 → BPMN_INSTANCE_TERMINAL。'
      + 'reason 写进 instance/suspended 事件（≤200 字符）。',
  })

  const resumeTool = lifecycleTool({
    name: 'flow_instance_resume',
    action: 'resume',
    routeSegment: 'resume',
    timeKey: 'resumedAt',
    doneText: '已恢复',
    statusDescription: '恢复后的实例状态（ACTIVE）',
    description:
      '恢复一个 SUSPENDED 实例（POST /instances/<id>/resume）：状态回 ACTIVE + 写 instance/resumed 事件，'
      + '**不主动跑**；下一次 complete / 消息投递沿用既有懒恢复。'
      + '只有 SUSPENDED 能恢复，否则 409 INSTANCE_NOT_SUSPENDED；终态 → BPMN_INSTANCE_TERMINAL。'
      + 'reason 写进 instance/resumed 事件（≤200 字符）。',
  })

  return [
    worktreeTool,
    sendMessageTool,
    replyTool,
    definitionListTool,
    definitionGetTool,
    runTool,
    instanceListTool,
    instanceGetTool,
    instanceEventsTool,
    instanceCancelTool,
    completeTaskTool,
    suspendTool,
    resumeTool,
  ]
}
