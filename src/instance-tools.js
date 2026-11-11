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

class ParamError extends Error {
  constructor(message, hint) {
    super(message)
    this.name = 'ParamError'
    this.hint = hint
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
    return '实例是 ACTIVE / SUSPENDED：先停止实例（flow_stop 只针对旧运行域，实例用 DELETE /instances/<id>/stop 或面板停止）；force 不能越过这条限制。'
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
    return 'Host 无法把正文安全物化到工作区（路径含符号链接 / 不是普通文件 / 写入失败）：消息已标 failed 且不投递；检查工作区 .flow-studio-inbox 下是否被软链或非普通文件占用，修复后再用新 messageId 发送。'
  }
  if (code === 'MESSAGE_REPLY_DISPATCH_IN_FLIGHT') {
    return '该回复正在另一个进程投递中：不要并发重复外发；等一会用同一 replyId 重试，已 delivered 后重试是幂等的。'
  }
  if (code === 'MESSAGE_INSTANCE_TERMINAL') {
    return '实例已 COMPLETED / CANCELED：不再受理新入站消息；已受理的回复仍可尝试投递（CANCELED 除外）。'
  }
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

  /** 发一个 JSON 请求给实例域路由；统一把 Host 错误翻成工具结果。 */
  async function callRoute(runtime, { method = 'POST', parts, url, body, action }) {
    let result
    try {
      result = await runtime.handle({ method, parts, url, body })
    } catch (error) {
      return failure(
        `调用实例消息接口失败：${error && error.message ? error.message : String(error)}`,
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
    return trimDeep({ action, status, ...responseBody })
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

  return [worktreeTool, sendMessageTool, replyTool]
}
