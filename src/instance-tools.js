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

const TIMEOUT_WORKTREE_MS = 60_000

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
  if (status === 404) return `${action}失败：实例或工作区记录不存在，先 action:"list" 或 action:"inspect" 确认 id。`
  if (status === 409) return '冲突（409）：实例状态或工作区已变化；先 action:"inspect" / action:"list" 读回最新状态再决定。'
  if (status === 400) return '参数或请求不合法：按 error 原文改正后重发。'
  if (status >= 500) return 'Host 侧资源操作失败：git / 目录权限可能有问题；重试一次，持续失败就报告原因。'
  return '按 error 原文处理。'
}

/**
 * 创建实例域模型工具（当前只有一个）。E3 会在同一文件里追加实例生命周期工具。
 *
 * @param {{runtime?: {handle: Function}, getRuntime?: () => {handle: Function}}} deps
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

  function runtimeOrError() {
    const runtime = getRuntime()
    if (!isObject(runtime) || typeof runtime.handle !== 'function') {
      return { runtime: null, error: 'BPMN 运行时不可用：宿主没有启用实例域' }
    }
    return { runtime, error: '' }
  }

  return [{
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
          worktrees: { type: 'array', description: 'action=list：工作树条目', items: anyJson('单个工作树条目') },
          orphans: { type: 'array', description: 'action=list：孤儿条目', items: anyJson('孤儿工作树') },
          corrupt: { type: 'array', description: 'action=list：损坏的所有权记录', items: anyJson('损坏记录') },
          scannedAt: nullable({ type: 'string' }, '列表扫描时间（ISO 8601）'),
          dryRun: { type: 'boolean', description: 'action=prune：本次是否为预览' },
          planHash: nullable({ type: 'string' }, 'action=prune：预览 / 执行对应的 planHash'),
          plan: anyJson('action=prune 预览：{ v, createdAt, entries, planHash }'),
          removable: { type: 'integer', description: 'action=prune 预览：计划删除的条目数' },
          reported: { type: 'integer', description: 'action=prune 预览：只报告 / 保留的条目数' },
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
          const orphans = Array.isArray(value.orphans) ? value.orphans.length : 0
          const lines = list.slice(0, 50).map(item => (
            `- ${item.instanceId || '?'}${item.orphan === true ? '（孤儿）' : ''}：${item.path || '(无 path)'}`
              + `${item.instanceStatus ? ' · ' + item.instanceStatus : ''}`
          ))
          const tail = list.length > 50 ? `\n…还有 ${list.length - 50} 个` : ''
          return [{ type: 'text', text: `共 ${list.length} 个实例工作树，其中孤儿 ${orphans} 个：\n${lines.join('\n')}${tail}` }]
        }
        if (value.dryRun === true) {
          return [{
            type: 'text',
            text: `prune 预览：将删除 ${value.removable ?? 0} 个、仅报告 / 保留 ${value.reported ?? 0} 个；`
              + `planHash=${value.planHash || '?'}。确认后带同一 planHash 且 dryRun:false 再调一次。`,
          }]
        }
        const removed = Array.isArray(value.removed) ? value.removed.length : 0
        const skipped = Array.isArray(value.skipped) ? value.skipped.length : 0
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
        // 默认预览；带 planHash 且未显式 dryRun:true 时视为执行。
        const effectiveDryRun = dryRun === undefined ? planHash === undefined : dryRun
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
      return trimDeep({ action, status, ...responseBody })
    },
  }]
}
