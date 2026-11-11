/**
 * BPMN 运行时：把「定义域 / 实例域 / bpmn-runner / HTTP 路由」接成 0.13.0 的
 * 最小可用面（灰度开关默认关）。
 *
 * 边界（0.13.0）：
 *   - 只做 headless 引擎 + 定义/实例 API，不碰画布（bpmn.io 在后续阶段）；
 *   - 不重写 `definition-store` / `instance-store`，只调用它们的导出函数；
 *   - 服务处理器只接外部 CLI executor（codex / custom）；`dsh` 适配器与 http
 *     connector **明确失败**，不伪造成功（错误码见下）。
 *
 * 目录（计划 §2：模板域与运行实例域隔离，均与老 `flows/`、`runs/` 平级）：
 * ```
 * <flow-studio>/definitions/<definitionId>/<version>.bpmn
 * <flow-studio>/instances/<instanceId>/{instance.json,state.json,events/...}
 * ```
 * 传入的 `dir` 通常是老的 `flows/` 目录；本模块自动取它的父目录作为 flow-studio
 * 根。也接受显式 `definitionsRoot` / `instancesRoot` 覆盖（测试与嵌入方使用）。
 *
 * 事件桥（runner onEvent → 落盘）：
 *   - `process/start` / `activity/start` → 事件落盘 + 实例 running；
 *   - `activity/wait` → 事件落盘 + 实例 waiting + `pendingTasks` 落 instance.json；
 *   - `activity/end` → 事件落盘 + 刷新 `pendingTasks`；
 *   - `process/end` → 事件落盘 + `completeInstance('COMPLETED')`；
 *   - `error` → 事件落盘 + 实例 `lastError`（status 保持 ACTIVE，不判死）；
 *   - 条件求值失败 / handler 失败都走 runner 的 `error`，这里不额外编故事。
 *
 * 事件写入不吞错：runner 的 `_safeCall` 会吞掉 onEvent 抛错，所以本模块把每次
 * 追加挂在自己的串行链上，失败记进 `_eventFailures`，请求收口时以
 * `BPMN_EVENT_WRITE_FAILED` 显式返回（不会静默丢事件）。
 *
 * 懒恢复：
 *   - 请求碰到不在内存里的实例时，读 `state.json` + 实例目录里的 `definition.bpmn`，
 *     新建 runner 并 `recover(state)`；
 *   - state 缺失 / 不可恢复 / 定义损坏时**不假装成功**：GET 返回元数据 +
 *     `recovered:false` + 可读原因；写操作返回 409 / 500。
 *   - recover 会重放一次 `activity/wait`（runner 已知的坑 g），这里按 state 里的
 *     `pendingTasks[].executionId` 去重，事件流不会出现重复的 wait。
 *
 * @module @feiyueve/dsh-flow-studio/bpmn-runtime
 */

import { Buffer } from 'node:buffer'
import { basename, dirname, join, resolve } from 'node:path'

import {
  DefinitionError,
  definitionsDir,
  listDefinitions,
  readDefinition,
  readDefinitionVersion,
  saveDefinitionVersion,
} from './definition-store.js'
import {
  InstanceError,
  appendInstanceEvents,
  completeInstance,
  createInstance,
  instancesDir,
  listInstances,
  readInstance,
  readInstanceDefinition,
  readInstanceEvents,
  readInstanceState,
  updateInstance,
  writeInstanceState,
} from './instance-store.js'
import { parseBpmn } from './bpmn-parse.js'
import { BPMN_RUNNER_STATUS, BpmnRunnerError, createBpmnRunner } from './bpmn-runner.js'
import { BPMN_STATE_KIND, BPMN_STATE_VERSION, sha256Hex } from './bpmn-state.js'
import {
  AGENT_EXECUTE_ERROR, DEFAULT_ADAPTER_ID, admitAdapter, createAdapterProbeCache,
  resolveAdapterId, resolveAgentTimeoutMs, runAgentNode,
} from './agent-execute.js'
import { normalizeExecutor, runExternalExecutor } from './executor.js'
import { checkRunId } from './runlog.js'

/** 引擎版本（计划 §10.4 的 health 字段）。 */
export const BPMN_ENGINE_VERSION = '26.0.6'

/** 活跃实例 LRU 上限。 */
export const BPMN_MAX_ACTIVE_ENV = 'FLOW_STUDIO_BPMN_MAX_ACTIVE'
/** 单活动超时（毫秒）；不设 = 只受 run 时限 / signal 控制。 */
export const BPMN_ACTIVITY_TIMEOUT_ENV = 'FLOW_STUDIO_BPMN_ACTIVITY_TIMEOUT_MS'

/** 默认活跃实例上限（研究 §7：≈450KB/实例，100 常驻 ≈45MB）。 */
export const DEFAULT_MAX_ACTIVE_INSTANCES = 100

/** 实例域终态；终态不再恢复 runner。 */
/**
 * 实例终态（Camunda 8 口径）：只有 COMPLETED / CANCELED。
 * 引擎出错**不改 status**（保持 ACTIVE），事实写进 `lastError`。
 */
const TERMINAL_STATUSES = new Set(['COMPLETED', 'CANCELED'])

/**
 * 运行时错误：`status` 给 HTTP，`code` 是稳定业务码，`reason` 是中文可读原因。
 *
 * handler（executeAgent / executeHttp）抛的是更轻的 `handlerError`（只保证 `code`）；
 * runner 会把它包成 `BPMN_HANDLER_FAILED`，直接调用 handler 的测试可按原始 `code` 分流。
 * 实例失败时 runtime 会把 handler 的原始 code 写进 `instance.json.result.error.code`。
 */
export class BpmnRuntimeError extends Error {
  /**
   * @param {number} status HTTP 状态码（400/404/405/409/500/503）
   * @param {string} code 稳定错误码
   * @param {string} reason 中文可读原因
   * @param {object} [extra] 附加诊断字段
   */
  constructor(status, code, reason, extra = {}) {
    super(reason)
    this.name = 'BpmnRuntimeError'
    this.status = status
    this.code = code
    this.reason = reason
    Object.assign(this, extra)
  }

  toPayload() {
    const payload = { ok: false, code: this.code, error: this.reason }
    if (typeof this.hint === 'string' && this.hint !== '') payload.hint = this.hint
    if (Array.isArray(this.errors) && this.errors.length > 0) payload.errors = this.errors
    if (Array.isArray(this.warnings) && this.warnings.length > 0) payload.warnings = this.warnings
    return payload
  }
}

/** handler 用的轻量结构化错误：只保证 `code` / `message`。 */
function handlerError(code, message, details = {}) {
  const error = new Error(message)
  error.name = 'BpmnHandlerError'
  error.code = code
  Object.assign(error, details)
  return error
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 读取并校验正整数环境变量；非法 / 未设置返回 fallback（不把错配置当 0）。 */
function positiveEnvInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) return fallback
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** 取 flow-studio 根：传进来的是 `.../flows` 时取父目录，否则原样。 */
function baseDirOf(dir) {
  const absolute = resolve(typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : process.cwd())
  return basename(absolute) === 'flows' ? dirname(absolute) : absolute
}

function resolveRoots(options = {}) {
  const explicitDefinitions = typeof options.definitionsRoot === 'string' && options.definitionsRoot.trim() !== ''
    ? resolve(options.definitionsRoot.trim())
    : null
  const explicitInstances = typeof options.instancesRoot === 'string' && options.instancesRoot.trim() !== ''
    ? resolve(options.instancesRoot.trim())
    : null
  const base = baseDirOf(options.dir)
  return {
    base,
    definitionsRoot: explicitDefinitions ?? join(base, 'definitions'),
    instancesRoot: explicitInstances ?? join(base, 'instances'),
  }
}

/** 单条事件落盘预算：store 的硬上限是 8KB，这里留一点 JSON 信封余量。 */
const EVENT_BYTES_BUDGET = 7800

/** 事件分片 id：BPMN id 允许大小写/点/下划线，但 store 只收 1–64 个安全字符。 */
function shardIdOf(event) {
  const raw = typeof event.elementId === 'string' && event.elementId !== ''
    ? event.elementId
    : typeof event.flowId === 'string' && event.flowId !== ''
      ? event.flowId
      : 'process'
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
  return checkRunId(cleaned) ?? 'process'
}

/** 递归裁剪字符串，保证 event 不会因为大输出撑爆 store 的 8KB 单条上限。 */
function clipDeep(value, maxChars, depth = 0) {
  if (depth > 8) return '[depth-limit]'
  if (typeof value === 'string') {
    return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value
  }
  if (Array.isArray(value)) return value.slice(0, 200).map(item => clipDeep(item, maxChars, depth + 1))
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = clipDeep(item, maxChars, depth + 1)
    return out
  }
  return value
}

function safeJsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return null
  }
}

/**
 * 落盘前的事件整形：正常事件原样写；超过 8KB 时递归裁剪字符串并标 `truncated:true`。
 * `activity/end` 的 agent 输出可能很大，事件流是观测面，不能因为输出大就让整个实例失败。
 * 仍超限时退化成「只保留定位字段」的最小事件（至少能看出发生过什么）。
 */
function persistableEvent(event) {
  const size = safeJsonSize(event)
  if (size === null) return null
  if (size <= EVENT_BYTES_BUDGET) return event
  const clipped = clipDeep({ ...event, truncated: true }, 1500)
  const clippedSize = safeJsonSize(clipped)
  if (clippedSize !== null && clippedSize <= EVENT_BYTES_BUDGET) return clipped
  const minimal = {
    type: event.type,
    at: event.at,
    ...(event.elementId === undefined ? {} : { elementId: event.elementId }),
    ...(event.activityId === undefined ? {} : { activityId: event.activityId }),
    truncated: true,
  }
  return minimal
}

function errorText(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/** 把 store / runner 的错误收敛成 HTTP 结果；无法识别的一律 500。 */
function errorResult(error) {
  if (error instanceof BpmnRuntimeError) {
    return { status: error.status, body: error.toPayload() }
  }
  if (error instanceof DefinitionError || error instanceof InstanceError) {
    const body = { ok: false, code: error.code, error: error.reason ?? error.message }
    if (typeof error.hint === 'string' && error.hint !== '') body.hint = error.hint
    return { status: Number.isInteger(error.status) ? error.status : 500, body }
  }
  if (error instanceof BpmnRunnerError) {
    return { status: runnerErrorStatus(error.code), body: { ok: false, code: error.code, error: error.message } }
  }
  return {
    status: 500,
    body: { ok: false, code: 'BPMN_INTERNAL_ERROR', error: errorText(error) },
  }
}

/** runner 错误码 → HTTP 语义（400 入参 / 404 不存在 / 409 冲突 / 503 引擎不可用）。 */
function runnerErrorStatus(code) {
  if (code === 'BPMN_TASK_NOT_FOUND') return 404
  if (code === 'BPMN_INSTANCE_BLOCKED' || code === 'BPMN_STATE_NOT_RESUMABLE'
    || code === 'BPMN_STATE_DEFINITION_MISMATCH' || code === 'BPMN_STATE_VERSION_UNSUPPORTED'
    || code === 'BPMN_STATE_RECOVER_FAILED' || code === 'BPMN_STATE_INVALID'
    || code === 'BPMN_RECOVER_RUNNING') return 409
  if (code === 'BPMN_OPTIONS_INVALID') return 400
  if (code === 'BPMN_HANDLER_MISSING' || code === 'BPMN_HANDLER_FAILED'
    || code === 'BPMN_INSTANCE_ID_CONFLICT' || code === 'BPMN_LRU_EVICT_UNSNAPSHOTTED') return 503
  return 500
}

/**
 * 创建 BPMN 运行时（工厂）。
 *
 * @param {{
 *   ctx?: any,
 *   dir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   definitionsRoot?: string,
 *   instancesRoot?: string,
 *   maxActiveInstances?: number,
 *   executorRunner?: Function,
 *   executorNormalizer?: Function,
 *   adapters?: object,       // AgentAdapter 注册表（createAdapterRegistry()）；缺省时 dsh 明确失败
 *   workspaceRoot?: string,  // agent 节点的文档相对基准（默认 process.cwd()）
 * }} [options]
 * @returns {BpmnRuntime}
 */
export function createBpmnRuntime(options = {}) {
  if (!isPlainObject(options)) {
    throw new BpmnRuntimeError(400, 'BPMN_OPTIONS_INVALID', 'createBpmnRuntime(options) 需要一个对象')
  }
  const roots = resolveRoots(options)
  const env = isPlainObject(options.env) ? options.env : process.env
  return new BpmnRuntime({
    ctx: options.ctx ?? null,
    ...roots,
    env,
    maxActiveInstances: options.maxActiveInstances,
    executorRunner: options.executorRunner,
    executorNormalizer: options.executorNormalizer,
    adapters: options.adapters,
    workspaceRoot: options.workspaceRoot,
  })
}

class BpmnRuntime {
  constructor(options) {
    this.ctx = options.ctx
    this.base = options.base
    this.definitionsRoot = options.definitionsRoot
    this.instancesRoot = options.instancesRoot
    this.env = options.env
    this.maxActiveInstances = options.maxActiveInstances
    this.executorRunner = typeof options.executorRunner === 'function' ? options.executorRunner : runExternalExecutor
    this.executorNormalizer = typeof options.executorNormalizer === 'function' ? options.executorNormalizer : normalizeExecutor
    /** AgentAdapter 注册表（dsh / codex）；缺省时 dsh 节点按旧接线明确失败。 */
    this.adapters = options.adapters && typeof options.adapters.get === 'function' ? options.adapters : null
    /** agent 节点 documents 的相对基准。 */
    this.workspaceRoot = typeof options.workspaceRoot === 'string' && options.workspaceRoot.trim() !== ''
      ? resolve(options.workspaceRoot.trim())
      : process.cwd()
    /** 每个 runtime 的 probe 缓存：同一 adapter id 只 probe 一次（成功/失败都缓存）。 */
    this._probeAdapter = createAdapterProbeCache()

    /** @type {Map<string, any>} instanceId → runner（懒恢复后常驻） */
    this._runners = new Map()
    /** @type {Map<string, Promise<void>>} 同一实例的写操作串行链 */
    this._locks = new Map()
    /** @type {Map<string, Promise<void>>} 同一实例的事件追加串行链 */
    this._eventChains = new Map()
    /** @type {Map<string, Error[]>} 事件追加失败（请求收口时显式报出） */
    this._eventFailures = new Map()
    /** @type {Map<string, Map<string, number>>} instanceId → elementId → attempt */
    this._attempts = new Map()
    /** @type {Map<string, Set<string>>} recover 时抑制重放的 activity/wait */
    this._suppressWait = new Map()
    /** @type {Map<string, {code: string, message: string}>} runner 失败的结构化原因 */
    this._runnerErrors = new Map()
    /** @type {Set<string>} 停止闩：置位后该实例的迟到事件与懒恢复一律不再推进 */
    this._stopping = new Set()
    /** @type {Map<string, object>} instanceId → 最后一个成功 agent 节点的 output（process/end 用） */
    this._lastAgentOutputs = new Map()
    /** @type {Map<string, string>} `instanceId\\0executionId` → agent 节点 summary（activity/end 用） */
    this._agentSummaries = new Map()
    /** @type {Map<string, number>} instanceId → agent handler 失败时的提醒次数（lastError.reminders） */
    this._agentReminders = new Map()
    this._disposed = false
  }

  /** 数据根（便于测试 / 运维核对）。 */
  get roots() {
    return { definitionsRoot: this.definitionsRoot, instancesRoot: this.instancesRoot }
  }

  /** 活跃实例数（只算真正在跑的：running / waiting；终态与已淘汰的不算）。 */
  get activeCount() {
    let count = 0
    for (const runner of this._runners.values()) {
      if (!runner || typeof runner.status !== 'function') continue
      const status = runner.status()
      if (status === 'running' || status === 'waiting') count += 1
    }
    return count
  }

  /** `GET /health` 用：计数每次现算，不缓存。 */
  async health() {
    let definitions = 0
    let instances = 0
    let error = null
    try {
      definitions = (await listDefinitions({ definitionsRoot: this.definitionsRoot })).length
    } catch (caught) {
      error = errorText(caught)
    }
    try {
      instances = (await listInstances({ instancesRoot: this.instancesRoot, limit: 1000 })).length
    } catch (caught) {
      error = error ? `${error}; ${errorText(caught)}` : errorText(caught)
    }
    return {
      enabled: true,
      engine: BPMN_ENGINE_VERSION,
      definitions,
      instances,
      active: this.activeCount,
      ...(error === null ? {} : { error }),
    }
  }

  /**
   * 处理一条 definitions / instances 路由。**不抛错**：所有失败都收敛成
   * `{status, body}`，由 index 的 `route()` 负责 sendJson（鉴权已在 index 完成）。
   *
   * @param {{method?: string, parts?: string[], url?: URL|string, body?: object}} request
   * @returns {Promise<{status: number, body: object}>}
   */
  async handle(request = {}) {
    try {
      if (this._disposed) {
        return { status: 503, body: { ok: false, code: 'BPMN_RUNTIME_DISPOSED', error: 'BPMN 运行时已释放' } }
      }
      const method = String(request.method ?? 'GET').toUpperCase()
      const parts = Array.isArray(request.parts) ? request.parts.map(String) : []
      const url = request.url instanceof URL
        ? request.url
        : new URL(typeof request.url === 'string' && request.url !== '' ? request.url : '/', 'http://localhost')
      const body = request.body
      if (parts[0] === 'definitions') return await this._handleDefinitions(method, parts, url, body)
      if (parts[0] === 'instances') return await this._handleInstances(method, parts, url, body)
      return { status: 404, body: { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口' } }
    } catch (error) {
      return errorResult(error)
    }
  }

  /** 释放内存中的 runner（进程退出 / 测试；不删磁盘数据、不把实例标成终态）。 */
  async dispose() {
    this._disposed = true
    for (const runner of this._runners.values()) {
      try {
        await runner.stop()
      } catch {
        // 释放路径不抛：磁盘上的 state 仍可被新进程恢复。
      }
    }
    this._runners.clear()
    this._locks.clear()
    this._eventChains.clear()
    this._eventFailures.clear()
    this._attempts.clear()
    this._suppressWait.clear()
    this._stopping.clear()
    this._runnerErrors.clear()
    this._lastAgentOutputs.clear()
    this._agentSummaries.clear()
    this._agentReminders.clear()
  }

  // -------------------------------------------------------------------------
  // definitions
  // -------------------------------------------------------------------------

  async _handleDefinitions(method, parts, url, body) {
    if (parts.length === 1) {
      if (method === 'GET') return await this._listDefinitions()
      if (method === 'POST') return await this._saveDefinition(body)
      return methodNotAllowed('GET / POST')
    }
    if (parts.length === 2) {
      if (method === 'GET') return await this._readDefinition(parts[1], url)
      return methodNotAllowed('GET')
    }
    return { status: 404, body: { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口' } }
  }

  async _listDefinitions() {
    const summaries = await listDefinitions({ definitionsRoot: this.definitionsRoot })
    const definitions = []
    for (const summary of summaries) {
      let meta = null
      try {
        meta = await readDefinition(summary.id, { definitionsRoot: this.definitionsRoot })
      } catch {
        // 坏 meta 不该让整张列表 500（store 的 list 也是这个口径）。
      }
      definitions.push({
        id: summary.id,
        name: summary.name,
        description: summary.description,
        tags: summary.tags,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        versionCount: summary.versionCount,
        latestVersion: summary.latestVersion,
        latestHash: meta?.latestHash ?? null,
        versions: meta ? meta.versions.map(versionOf) : [],
      })
    }
    return { status: 200, body: { ok: true, definitions } }
  }

  async _saveDefinition(body) {
    if (!isPlainObject(body)) {
      return {
        status: 400,
        body: { ok: false, code: 'BPMN_BODY_INVALID', error: '请求体必须是 JSON 对象：{ id?, name, xml }' },
      }
    }
    const xml = body.xml
    if (typeof xml !== 'string' || xml.trim() === '') {
      return {
        status: 400,
        body: { ok: false, code: 'BPMN_XML_REQUIRED', error: 'xml 必须是非空 BPMN 2.0 XML 字符串' },
      }
    }

    // 先解析校验：ok:false 直接 400，不落盘（坏的模板不允许进定义域）。
    const parsed = await parseBpmn(xml)
    if (!parsed.ok) {
      return {
        status: 400,
        body: {
          ok: false,
          code: 'BPMN_XML_INVALID',
          error: 'BPMN XML 未通过校验',
          errors: parsed.errors,
          warnings: parsed.warnings,
        },
      }
    }

    const id = this._definitionIdFrom(body, parsed.definition)
    if (id === null) {
      return {
        status: 400,
        body: {
          ok: false,
          code: 'BPMN_DEFINITION_ID_INVALID',
          error: 'id 只能由字母 / 数字 / 点 / 下划线 / 连字符组成，不以点开头，且不超过 64 字符',
          hint: '不传 id 时会从 process id 或 name 推导一个合法 id',
        },
      }
    }
    const name = typeof body.name === 'string' && body.name.trim() !== ''
      ? body.name.trim()
      : (parsed.definition.name ?? id)
    const saved = await saveDefinitionVersion(
      id,
      xml,
      { name },
      { definitionsRoot: this.definitionsRoot },
    )
    return {
      status: saved.created ? 201 : 200,
      body: {
        ok: true,
        id: saved.id,
        version: saved.version,
        hash: saved.hash,
        created: saved.created,
        warnings: parsed.warnings,
      },
    }
  }

  /** 显式 id 优先；缺省从 process id / name 推一个 store 能接受的 slug。 */
  _definitionIdFrom(body, definition) {
    if (body.id !== undefined && body.id !== null) {
      if (typeof body.id !== 'string') return null
      return checkRunId(body.id.trim())
    }
    for (const source of [definition?.id, body.name]) {
      if (typeof source !== 'string' || source.trim() === '') continue
      const slug = source
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
      if (checkRunId(slug)) return slug
    }
    return checkRunId(`def-${Date.now().toString(36)}`)
  }

  async _readDefinition(id, url) {
    const definitionId = checkRunId(id)
    if (!definitionId) {
      return { status: 400, body: { ok: false, code: 'BPMN_DEFINITION_ID_INVALID', error: 'definitionId 非法' } }
    }
    const meta = await readDefinition(definitionId, { definitionsRoot: this.definitionsRoot })
    if (meta === null) {
      return { status: 404, body: { ok: false, code: 'DEFINITION_NOT_FOUND', error: `定义 ${definitionId} 不存在` } }
    }
    const rawVersion = url.searchParams.get('version')
    let wanted = meta.latestVersion
    if (rawVersion !== null && rawVersion !== '') {
      if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
        return { status: 400, body: { ok: false, code: 'BPMN_VERSION_INVALID', error: 'version 必须是 ≥1 的整数' } }
      }
      wanted = Number(rawVersion)
    }
    const body = {
      ok: true,
      id: meta.id,
      name: meta.name,
      description: meta.description,
      tags: meta.tags,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      latestVersion: meta.latestVersion,
      latestHash: meta.latestHash,
      versions: meta.versions.map(versionOf),
      version: null,
      hash: null,
      bytes: null,
      xml: null,
    }
    if (wanted === null) return { status: 200, body }
    const version = await readDefinitionVersion(definitionId, wanted, { definitionsRoot: this.definitionsRoot })
    if (version === null) {
      return {
        status: 404,
        body: { ok: false, code: 'DEFINITION_VERSION_NOT_FOUND', error: `定义 ${definitionId} 的 v${wanted} 不存在` },
      }
    }
    body.version = version.version
    body.hash = version.hash
    body.bytes = version.bytes
    body.xml = version.xml
    return { status: 200, body }
  }

  // -------------------------------------------------------------------------
  // instances — 路由
  // -------------------------------------------------------------------------

  async _handleInstances(method, parts, url, body) {
    if (parts.length === 1) {
      if (method === 'GET') return await this._listInstances(url)
      if (method === 'POST') return await this._createInstance(body)
      return methodNotAllowed('GET / POST')
    }
    const id = checkRunId(parts[1])
    if (parts.length === 2) {
      if (method !== 'GET') return methodNotAllowed('GET')
      if (!id) return invalidInstanceId()
      return await this._readInstance(id)
    }
    if (parts.length === 3) {
      if (!id) return invalidInstanceId()
      if (parts[2] === 'events') {
        if (method !== 'GET') return methodNotAllowed('GET')
        return await this._readEvents(id, url)
      }
      if (parts[2] === 'definition') {
        // 实例画布永远读冻结快照，不回查定义域（定义新增版本 / 被删都不影响）。
        if (method !== 'GET') return methodNotAllowed('GET')
        return await this._readInstanceDefinitionSnapshot(id)
      }
      if (parts[2] === 'tasks') {
        if (method !== 'GET') return methodNotAllowed('GET')
        return await this._readTasks(id)
      }
      if (parts[2] === 'stop') {
        if (method !== 'POST') return methodNotAllowed('POST')
        return await this._stopInstance(id)
      }
      return { status: 404, body: { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口' } }
    }
    if (parts.length === 5 && parts[2] === 'tasks' && parts[4] === 'complete') {
      if (method !== 'POST') return methodNotAllowed('POST')
      if (!id) return invalidInstanceId()
      return await this._completeTask(id, parts[3], body)
    }
    return { status: 404, body: { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口' } }
  }

  async _listInstances(url) {
    const definitionId = url.searchParams.get('definitionId')
    const status = url.searchParams.get('status')
    const limitRaw = url.searchParams.get('limit')
    const filter = { instancesRoot: this.instancesRoot }
    if (definitionId !== null && definitionId !== '') filter.definitionId = definitionId
    if (status !== null && status !== '') filter.status = status
    if (limitRaw !== null && limitRaw !== '') {
      if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) {
        return { status: 400, body: { ok: false, code: 'BPMN_LIMIT_INVALID', error: 'limit 必须是正整数' } }
      }
      filter.limit = Math.min(Number(limitRaw), 1000)
    }
    const instances = await listInstances(filter)
    return {
      status: 200,
      body: {
        ok: true,
        instances: instances.map(instance => ({
          ...instance,
          active: this._runners.has(instance.id),
        })),
        skipped: Array.isArray(instances.skipped) ? instances.skipped : [],
      },
    }
  }

  async _createInstance(body) {
    if (!isPlainObject(body)) {
      return {
        status: 400,
        body: { ok: false, code: 'BPMN_BODY_INVALID', error: '请求体必须是 JSON 对象：{ definitionId, definitionVersion?, variables? }' },
      }
    }
    const definitionId = checkRunId(body.definitionId)
    if (!definitionId) {
      return { status: 400, body: { ok: false, code: 'INSTANCE_INVALID_ID', error: 'definitionId 非法' } }
    }
    if (body.variables !== undefined && body.variables !== null && !isPlainObject(body.variables)) {
      return { status: 400, body: { ok: false, code: 'BPMN_VARIABLES_INVALID', error: 'variables 必须是 JSON 对象' } }
    }
    let definitionVersion
    if (body.definitionVersion !== undefined && body.definitionVersion !== null) {
      const version = typeof body.definitionVersion === 'string' && /^\d+$/.test(body.definitionVersion)
        ? Number(body.definitionVersion)
        : body.definitionVersion
      if (!Number.isSafeInteger(version) || version < 1) {
        return { status: 400, body: { ok: false, code: 'BPMN_VERSION_INVALID', error: 'definitionVersion 必须是 ≥1 的整数' } }
      }
      definitionVersion = version
    }

    const instance = await createInstance({
      definitionId,
      ...(definitionVersion === undefined ? {} : { definitionVersion }),
      variables: body.variables ?? {},
      definitionsRoot: this.definitionsRoot,
      instancesRoot: this.instancesRoot,
    })

    try {
      const started = await this._withInstance(instance.id, () => this._startInstance(instance.id))
      return {
        status: 201,
        body: {
          ok: true,
          id: started.instance.id,
          status: started.instance.status,
          pendingTasks: started.instance.pendingTasks,
          lastSeq: started.instance.lastSeq,
          definitionId: started.instance.definitionId,
          definitionVersion: started.instance.definitionVersion,
          definitionHash: started.instance.definitionHash,
          recovered: false,
          ...(started.error === null ? {} : { error: { code: started.error.code, message: started.error.message } }),
        },
      }
    } catch (error) {
      // 实例已经建出来了：把可定位的信息带回给调用方，而不是只给一句 500。
      const result = errorResult(error)
      return {
        status: result.status,
        body: { ...result.body, id: instance.id, definitionId: instance.definitionId },
      }
    }
  }

  /**
   * 读实例定义快照。抽成方法是为了让测试能暂停「异步准备」这一段，
   * 复现 stop 与启动/恢复的竞态（review-0131 #1）；生产路径就是 store 的直读。
   *
   * @param {string} instanceId
   * @returns {Promise<object|null>}
   */
  async _readDefinitionSnapshot(instanceId) {
    return await readInstanceDefinition(instanceId, { instancesRoot: this.instancesRoot })
  }

  /**
   * 启动 / 恢复共用的同步复查：异步准备（读快照 / 解析 XML）期间 stop 可能已经
   * 置了停止闩并把实例收成 CANCELED。此时**不能再创建/登记 runner**——否则 stop
   * 已经返回 CANCELED 之后仍会派发新的 agent（review-0131 #1）。
   *
   * 只做同步判位；命中后由调用方异步读一次实例状态再返回。
   *
   * @param {string} instanceId
   * @returns {{code: string, message: string, reason: string}|null}
   */
  _latchBlockForPrepare(instanceId) {
    if (this._disposed) {
      return {
        code: 'BPMN_RUNTIME_DISPOSED',
        reason: 'BPMN 运行时已释放，未创建执行器、未派发节点',
        message: `实例 ${instanceId} 的启动/恢复准备期间 runtime 已被 dispose：不创建执行器、不派发节点`,
      }
    }
    if (this._stopping.has(instanceId)) {
      return {
        code: 'BPMN_INSTANCE_STOPPING',
        reason: '实例在启动/恢复准备期间被停止（stop 已置停止闩），未创建执行器、未派发节点',
        message: `实例 ${instanceId} 在启动/恢复准备期间被停止（stop 已置停止闩）：不创建执行器、不派发节点`,
      }
    }
    return null
  }

  /** 建实例后启动；失败不抛 handler 错，收成 `{instance, error}`（status 仍 ACTIVE + lastError）。 */
  async _startInstance(instanceId) {
    const instance = await readInstance(instanceId, { instancesRoot: this.instancesRoot })
    if (instance === null) {
      throw new BpmnRuntimeError(404, 'INSTANCE_NOT_FOUND', `实例 ${instanceId} 不存在`)
    }
    if (instance.status !== 'ACTIVE') {
      throw new BpmnRuntimeError(409, 'INSTANCE_NOT_ACTIVE', `实例 ${instanceId} 当前状态是 ${instance.status}，不能重新启动`)
    }
    const snapshot = await this._readDefinitionSnapshot(instanceId)
    // stop 可能在快照读取期间就返回了；不等解析完就先挡一次（终态实例上任何解析错误都没意义）。
    const stoppedAfterRead = this._latchBlockForPrepare(instanceId)
    if (stoppedAfterRead !== null) {
      const current = await readInstance(instanceId, { instancesRoot: this.instancesRoot }) ?? instance
      return { instance: current, error: { code: stoppedAfterRead.code, message: stoppedAfterRead.message } }
    }
    if (snapshot === null) {
      throw new BpmnRuntimeError(500, 'INSTANCE_SNAPSHOT_MISSING', `实例 ${instanceId} 的定义快照缺失`)
    }
    const parsed = await parseBpmn(snapshot.xml)
    // 解析也是异步的：这里到 runner 创建之间**没有 await**，复查必须同步完成。
    const stoppedAfterParse = this._latchBlockForPrepare(instanceId)
    if (stoppedAfterParse !== null) {
      const current = await readInstance(instanceId, { instancesRoot: this.instancesRoot }) ?? instance
      return { instance: current, error: { code: stoppedAfterParse.code, message: stoppedAfterParse.message } }
    }
    if (!parsed.ok) {
      // 定义快照不可执行：实例 status 不动（ACTIVE），只留 lastError。
      await this._markInstanceError(instanceId, {
        code: 'BPMN_DEFINITION_INVALID',
        message: '实例定义快照未通过 BPMN 校验，无法启动',
        nodeId: parsed.errors?.[0]?.elementId ?? null,
      })
      throw new BpmnRuntimeError(400, 'BPMN_DEFINITION_INVALID', '实例定义快照未通过 BPMN 校验，无法启动', {
        errors: parsed.errors,
      })
    }

    const runner = this._newRunner(parsed.definition, snapshot.xml, instanceId, instance.variables, {
      definitionId: instance.definitionId,
      definitionVersion: instance.definitionVersion,
    })
    this._runners.set(instanceId, runner)
    let startError = null
    try {
      await runner.start()
    } catch (error) {
      startError = error
    }
    await this._afterSettle(instanceId, runner)
    const after = await readInstance(instanceId, { instancesRoot: this.instancesRoot })
    if (after === null) {
      throw new BpmnRuntimeError(500, 'INSTANCE_VANISHED', `实例 ${instanceId} 在启动过程中消失`)
    }
    // handler 失败 / 条件错误 / 启动前校验失败：实例 status 保持 ACTIVE，
    // 只把事实写进 lastError（要不要重试由人/业务决定）。
    if (startError !== null) {
      if (!TERMINAL_STATUSES.has(after.status)) {
        await this._markInstanceError(instanceId, this._lastErrorFor(instanceId, startError))
      }
      const current = await readInstance(instanceId, { instancesRoot: this.instancesRoot }) ?? after
      return {
        instance: current,
        error: {
          // handler 失败时 runner 用包装码 BPMN_HANDLER_FAILED，真正的业务码在 cause 里：
          // 创建响应必须和落盘的 instance.lastError.code 同一口径（否则调用方看到两个码）。
          code: (typeof startError?.cause?.code === 'string' && startError.cause.code !== '')
            ? startError.cause.code
            : (startError.code ?? 'BPMN_ENGINE_ERROR'),
          message: startError.message,
        },
      }
    }
    return { instance: after, error: null }
  }

  async _readInstance(id) {
    return await this._withInstance(id, async () => {
      const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
      if (instance === null) return instanceNotFound(id)
      const ensured = await this._ensureRunner(instance)
      const current = await readInstance(id, { instancesRoot: this.instancesRoot }) ?? instance
      const pendingTasks = ensured.runner !== null
        ? ensured.runner.pendingTasks()
        : (current.pendingTasks ?? [])
      return {
        status: 200,
        body: {
          ok: true,
          id: current.id,
          definitionId: current.definitionId,
          definitionVersion: current.definitionVersion,
          definitionHash: current.definitionHash,
          status: current.status,
          variables: current.variables,
          result: current.result,
          lastError: current.lastError ?? null,
          pendingTasks,
          lastSeq: current.lastSeq,
          eventCount: current.eventCount,
          revision: current.revision,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
          completedAt: current.completedAt,
          runnerStatus: ensured.runner === null ? null : ensured.runner.status(),
          recovered: ensured.recovered,
          ...(ensured.reason ? { recovery: { reason: ensured.reason, code: ensured.code ?? null } } : {}),
        },
      }
    })
  }

  async _readEvents(id, url) {
    const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
    if (instance === null) return instanceNotFound(id)
    const events = await readInstanceEvents(id, { instancesRoot: this.instancesRoot })
    const sinceRaw = url.searchParams.get('since')
    let filtered = events ?? []
    if (sinceRaw !== null && sinceRaw !== '') {
      if (!/^\d+$/.test(sinceRaw)) {
        return { status: 400, body: { ok: false, code: 'BPMN_SEQ_INVALID', error: 'since 必须是非负整数' } }
      }
      const since = Number(sinceRaw)
      filtered = filtered.filter(event => Number.isSafeInteger(event.seq) && event.seq > since)
    }
    return {
      status: 200,
      body: {
        ok: true,
        id,
        events: filtered,
        lastSeq: instance.lastSeq,
        skipped: events?.skipped ?? 0,
        shards: events?.shards ?? 0,
      },
    }
  }

  /**
   * `GET /instances/<id>/definition`：返回实例启动时冻结的定义快照。
   *
   * 只调用 `readInstanceDefinition()`（实例目录里的 `definition.bpmn`）——它已经
   * 核对过快照与 `instance.json.definitionHash` 一致，所以这里不读定义域，也不会
   * 因为定义新增版本 / 定义域文件缺失而改变结果。快照缺失 / 损坏沿用 store 的
   * 500 `INSTANCE_SNAPSHOT_MISSING` / `INSTANCE_SNAPSHOT_CORRUPT`；实例不存在返回
   * 404 `INSTANCE_NOT_FOUND`。若 store 以后为快照读取引入 409，`handle()` 的
   * `errorResult()` 会原样带出该既有业务码，不在这里另造新码。
   *
   * 这是只读请求：不创建 runner、不触发懒恢复、不改实例状态。
   *
   * @param {string} id 已通过 `checkRunId` 校验的 instanceId
   * @returns {Promise<{status: number, body: object}>}
   */
  async _readInstanceDefinitionSnapshot(id) {
    const snapshot = await this._readDefinitionSnapshot(id)
    if (snapshot === null) return instanceNotFound(id)
    return {
      status: 200,
      body: {
        ok: true,
        id: snapshot.instanceId,
        definitionId: snapshot.definitionId,
        definitionVersion: snapshot.definitionVersion,
        definitionHash: snapshot.definitionHash,
        xml: snapshot.xml,
      },
    }
  }

  async _readTasks(id) {
    return await this._withInstance(id, async () => {
      const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
      if (instance === null) return instanceNotFound(id)
      const ensured = await this._ensureRunner(instance)
      const current = await readInstance(id, { instancesRoot: this.instancesRoot }) ?? instance
      return {
        status: 200,
        body: {
          ok: true,
          id,
          status: current.status,
          tasks: ensured.runner !== null ? ensured.runner.pendingTasks() : (current.pendingTasks ?? []),
          recovered: ensured.recovered,
          ...(ensured.reason ? { recovery: { reason: ensured.reason, code: ensured.code ?? null } } : {}),
        },
      }
    })
  }

  async _completeTask(id, activityId, body) {
    const requested = activityIdLabel(activityId)
    if (requested === null) {
      return {
        status: 400,
        body: { ok: false, code: 'BPMN_ACTIVITY_ID_INVALID', error: 'activityId 必须是非空字符串（≤128）' },
      }
    }
    if (body !== undefined && body !== null && !isPlainObject(body)) {
      return { status: 400, body: { ok: false, code: 'BPMN_BODY_INVALID', error: '请求体必须是 JSON 对象：{ payload?, decidedBy? }' } }
    }
    const payload = body?.payload
    if (payload !== undefined && payload !== null && !isPlainObject(payload)) {
      return { status: 400, body: { ok: false, code: 'BPMN_PAYLOAD_INVALID', error: 'payload 必须是 JSON 对象' } }
    }
    const decidedBy = typeof body?.decidedBy === 'string' && body.decidedBy.trim() !== ''
      ? body.decidedBy.trim()
      : null
    const executionId = typeof body?.executionId === 'string' && body.executionId !== '' ? body.executionId : null

    return await this._withInstance(id, async () => {
      const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
      if (instance === null) return instanceNotFound(id)
      if (this._stopping.has(id)) {
        return {
          status: 409,
          body: { ok: false, code: 'BPMN_INSTANCE_STOPPING', error: `实例 ${id} 正在停止，不能再完成任务` },
        }
      }
      if (TERMINAL_STATUSES.has(instance.status)) {
        return {
          status: 409,
          body: {
            ok: false,
            code: 'BPMN_INSTANCE_TERMINAL',
            error: `实例 ${id} 已结束（${instance.status}），不能再完成人工任务`,
          },
        }
      }
      const ensured = await this._ensureRunner(instance)
      if (ensured.runner === null) {
        return {
          status: 409,
          body: {
            ok: false,
            code: 'BPMN_INSTANCE_NOT_RECOVERABLE',
            error: `实例 ${id} 当前无法恢复：${ensured.reason ?? '未知原因'}`,
            ...(ensured.code ? { recoveryCode: ensured.code } : {}),
          },
        }
      }
      const runner = ensured.runner
      // runner 内部 blocked = 这个实例的执行已经停下（error 事件已发、lastError 已写）：
      // 实例 status 仍是 ACTIVE，但不能再完成人工任务。
      if (runner.status() === BPMN_RUNNER_STATUS.BLOCKED) {
        return {
          status: 409,
          body: { ok: false, code: 'BPMN_INSTANCE_BLOCKED', error: `实例 ${id} 的执行已停下（lastError），不能再完成任务` },
        }
      }
      if (runner.status() !== 'waiting') {
        return {
          status: 409,
          body: {
            ok: false,
            code: 'BPMN_INSTANCE_NOT_WAITING',
            error: `实例 ${id} 当前 runner 状态是 ${runner.status()}，没有等待中的人工任务`,
          },
        }
      }
      const tasks = runner.pendingTasks()
      const task = tasks.find(item => item.activityId === requested
        && (executionId === null || item.executionId === executionId))
      if (!task) {
        return {
          status: 404,
          body: {
            ok: false,
            code: 'BPMN_TASK_NOT_FOUND',
            error: `实例 ${id} 没有在等待的任务 ${requested}`,
            tasks,
          },
        }
      }

      // decidedBy 是审计字段：并入任务载荷（同一份会进 variables），不另造事件。
      const effectivePayload = { ...(isPlainObject(payload) ? payload : {}) }
      if (decidedBy !== null && effectivePayload.decidedBy === undefined) {
        effectivePayload.decidedBy = decidedBy
      }
      let signalError = null
      try {
        await runner.signalTask({ activityId: task.activityId, executionId: task.executionId, payload: effectivePayload })
      } catch (error) {
        signalError = error
      }
      try {
        await this._afterSettle(id, runner)
      } catch (error) {
        // stop 抢先一步把实例收成 aborted：终态不可逆，把事实返回给调用方。
        if (error?.code === 'INSTANCE_TERMINAL_IMMUTABLE') {
          const current = await readInstance(id, { instancesRoot: this.instancesRoot })
          return {
            status: 409,
            body: { ok: false, code: 'INSTANCE_TERMINAL_IMMUTABLE', error: `实例 ${id} 已被其它请求收成终态 ${current?.status ?? ''}` },
          }
        }
        throw error
      }
      const after = await readInstance(id, { instancesRoot: this.instancesRoot })
      // 返回前复查停止闩：stop 可能在 complete 等 handler 期间抢先收口，
      // 不能把「盘上已 CANCELED、决定被丢弃」报成 200 + ACTIVE（假阳性成功最危险）。
      // 注意：自己跑到 COMPLETED 是正常成功（runner.status()==='done'），不算被抢收。
      if (this._stopping.has(id)) {
        return {
          status: 409,
          body: {
            ok: false,
            code: 'INSTANCE_TERMINAL_IMMUTABLE',
            error: `实例 ${id} 正在停止（stop 已置停止闩），本次任务完成未被采纳（以 stop 收口的终态为准）`,
          },
        }
      }
      if (signalError !== null) {
        const result = errorResult(signalError)
        return { status: result.status, body: { ...result.body, id, tasks: runner.pendingTasks() } }
      }
      return {
        status: 200,
        body: {
          ok: true,
          id,
          status: after?.status ?? 'unknown',
          pendingTasks: after?.pendingTasks ?? runner.pendingTasks(),
          lastSeq: after?.lastSeq ?? 0,
          activityId: task.activityId,
          executionId: task.executionId,
          decidedBy,
          recovered: ensured.recovered,
        },
      }
    })
  }

  /**
   * 中止实例：**先在实例 HTTP 串行队列之外**置停止闩并发取消信号，再落盘 CANCELED。
   *
   * 慢 complete 可能长时间持有 `_withInstance` 锁（等 handler / 等流程静默），
   * stop 不能排在它后面——否则「点了停止却要等五分钟」。所以：
   *   1. 锁外读实例、置 `_stopping` 闩、`runner.stop()`（abort 在飞 handler）；
   *   2. 直接 `completeInstance('CANCELED')`（store 自己的文件锁只覆盖毫秒级写入）；
   *   3. 闩保留到 runtime dispose；期间 runner 的迟到事件一律丢弃。
   */
  async _stopInstance(id) {
    const instance = await readInstance(id, { instancesRoot: this.instancesRoot })
    if (instance === null) return instanceNotFound(id)
    if (TERMINAL_STATUSES.has(instance.status)) {
      return {
        status: 200,
        body: { ok: true, id, status: instance.status, alreadyTerminal: true, pendingTasks: [] },
      }
    }

    // 停止闩：任何新事件 / 懒恢复 / complete 都不能再把实例写回 running。
    this._stopping.add(id)
    const runner = this._runners.get(id) ?? null
    if (runner !== null) {
      try {
        // runner.stop() 同步置停止态 + abort 在飞活动，这里不必等它把引擎收尾。
        await runner.stop()
      } catch {
        // runner.stop 幂等；失败不改变「实例已中止」这个事实。
      }
      this._runners.delete(id)
    }

    let after
    try {
      after = await completeInstance(id, 'CANCELED', { instancesRoot: this.instancesRoot })
    } catch (error) {
      // 另一个请求（慢 complete）先以 done 收口：先成立者保持不变。
      if (error?.code === 'INSTANCE_TERMINAL_IMMUTABLE') {
        const current = await readInstance(id, { instancesRoot: this.instancesRoot })
        if (current !== null) {
          return {
            status: 200,
            body: { ok: true, id, status: current.status, alreadyTerminal: true, pendingTasks: [] },
          }
        }
      }
      throw error
    }
    return {
      status: 200,
      body: {
        ok: true,
        id,
        status: after.status,
        alreadyTerminal: false,
        pendingTasks: after.pendingTasks,
        lastSeq: after.lastSeq,
      },
    }
  }

  /**
   * 记录执行错误：**只写 `lastError`，不改 status**（仍是 ACTIVE）。
   *
   * 这是用户口径的落点：条件求值错 / 超时 / handler 失败 / 恢复失败都只是「发生过一次
   * 错误」，要不要重试、终止还是继续由业务或人决定，引擎不替它判死。
   */
  async _markInstanceError(instanceId, lastError) {
    const instance = await readInstance(instanceId, { instancesRoot: this.instancesRoot })
    if (instance === null) return null
    if (TERMINAL_STATUSES.has(instance.status)) return instance
    try {
      // 执行已停止：待办表清空（否则 UI 会以为人还能接着完成那个节点）。
      return await updateInstance(instanceId, { lastError, pendingTasks: [] }, { instancesRoot: this.instancesRoot })
    } catch (error) {
      if (error?.code === 'INSTANCE_TERMINAL_IMMUTABLE') return null
      throw error
    }
  }

  /** 从 runner 的执行错误生成 `lastError`（保留 handler 自己的 code，例如 adapter 不可用）。 */
  _lastErrorFor(instanceId, error) {
    const recorded = this._runnerErrors.get(instanceId) ?? null
    const code = recorded?.code
      ?? (typeof error?.cause?.code === 'string' && error.cause.code !== '' ? error.cause.code : null)
      ?? (typeof error?.code === 'string' && error.code !== '' ? error.code : null)
      ?? 'BPMN_ENGINE_ERROR'
    const message = recorded?.message ?? errorText(error)
    const lastError = { code, message }
    const reminders = this._agentReminders.get(instanceId)
    if (Number.isSafeInteger(reminders) && reminders >= 0) lastError.reminders = reminders
    if (typeof error?.elementId === 'string' && error.elementId !== '') lastError.nodeId = error.elementId
    if (typeof error?.activityId === 'string' && error.activityId !== '') lastError.activityId = error.activityId
    return lastError
  }

  // -------------------------------------------------------------------------
  // runner 生命周期 / 懒恢复
  // -------------------------------------------------------------------------

  /** 同实例写操作串行（complete / stop / 懒恢复都在同一把锁里）。 */
  async _withInstance(id, task) {
    const previous = this._locks.get(id) ?? Promise.resolve()
    let release
    const gate = new Promise(resolveGate => { release = resolveGate })
    const tail = previous.then(() => gate)
    this._locks.set(id, tail)
    await previous.catch(() => {})
    try {
      return await task()
    } finally {
      release()
      if (this._locks.get(id) === tail) this._locks.delete(id)
    }
  }

  /**
   * 从**实例固定的定义版本 + XML 快照**取 identity：hash 在这里重算（sha256 原文），
   * 不信任任何请求自报值；`readInstanceDefinition` 已核对过快照与 instance.json 的
   * definitionHash 一致，这里只用快照字节本身作为唯一真相。
   *
   * @param {object} definition
   * @param {string} xml
   * @param {string} instanceId
   * @param {object} variables
   * @param {{ definitionId: string, definitionVersion: number }} fixed 实例钉住的定义身份
   */
  _newRunner(definition, xml, instanceId, variables, fixed) {
    const maxActive = positiveEnvInt(this.env[BPMN_MAX_ACTIVE_ENV], this.maxActiveInstances ?? DEFAULT_MAX_ACTIVE_INSTANCES)
    const hash = sha256Hex(xml)
    try {
      return createBpmnRunner({
        definition,
        xml,
        instanceId,
        definitionIdentity: {
          id: fixed.definitionId,
          version: fixed.definitionVersion,
          hash,
        },
        variables: isPlainObject(variables) ? { ...variables } : {},
        services: this._servicesFor(instanceId),
        limits: this._limits(),
        // 快照点由本模块在每次收口后显式 getState()（只取一次），runner 的自动
        // 快照关掉；`getState()` 仍会写 runner 的 `_lastState`，LRU 淘汰检查照常可用。
        shouldSnapshot: () => false,
        maxActiveInstances: maxActive,
      })
    } catch (error) {
      if (error?.code === 'BPMN_INSTANCE_ID_CONFLICT') {
        throw new BpmnRuntimeError(
          503,
          'BPMN_INSTANCE_ACTIVE_ELSEWHERE',
          `同一进程内已有实例 ${instanceId} 的 runner 在活跃表中；先 dispose 旧 runtime 再恢复`,
        )
      }
      throw error
    }
  }

  _servicesFor(instanceId) {
    return {
      executeAgent: (element, ctx) => this._executeAgentFor(instanceId, element, ctx),
      executeHttp: (element, ctx) => executeHttp(element, ctx),
      onEvent: event => this._onRunnerEvent(instanceId, event),
      onTaskWait: () => {},
      onTaskDone: () => {},
      onError: error => this._recordRunnerError(instanceId, error),
    }
  }

  /**
   * agent 节点 handler 的 runtime 侧包装：接适配器注册表 + probe 缓存，并记住
   * 最后一个成功 agent 节点的 output / 本次 activity 的 summary（11 §5）。
   *
   * 注意：`executeAgent` 导出函数本身保持无实例状态的纯行为（测试可单独调用）；
   * 与实例相关的收口（变量合并由 runner 做、产物与 result 由本类做）在这里。
   */
  async _executeAgentFor(instanceId, element, ctx) {
    let result
    try {
      result = await executeAgent(element, ctx, {
        adapters: this.adapters,
        probeAdapter: this._probeAdapter,
        workspaceRoot: this.workspaceRoot,
        instanceId,
        // 旧外部 CLI 逃生门（adapter=custom / 无注册表时的 codex）仍用注入的桩/真实现。
        runExecutor: this.executorRunner,
        normalizeExecutor: this.executorNormalizer,
      })
    } catch (error) {
      // 失败落点（如 NODE_FINISH_MISSING）也必须让提醒事件进实例事件流：
      // handler 抛错时 runner 不会处理它的 events[]，这里补一次透传。
      if (error && Array.isArray(error.events)) {
        for (const event of error.events) {
          if (!isPlainObject(event) || typeof event.type !== 'string' || event.type === '') continue
          this._onRunnerEvent(instanceId, {
            ...event,
            elementId: typeof element?.id === 'string' ? element.id : undefined,
            activityId: typeof ctx?.executionId === 'string' ? ctx.executionId : undefined,
          })
        }
      }
      if (error && Number.isSafeInteger(error.reminders) && error.reminders >= 0) {
        this._agentReminders.set(instanceId, error.reminders)
      }
      throw error
    }
    // 成功执行后清掉上一次失败留下的提醒计数（lastError 随后也会被清/覆盖）。
    this._agentReminders.delete(instanceId)
    if (result && isPlainObject(result.output)) {
      // 11 §5：result 取「最后一个成功 agent 节点的 output」；来源 nodeId 一起记住，
      // 并在收口时随 instance.json 持久化（review-0131 #4）。
      this._lastAgentOutputs.set(instanceId, {
        nodeId: typeof element?.id === 'string' && element.id !== '' ? element.id : null,
        output: { ...result.output },
      })
    }
    if (result && typeof result.summary === 'string'
      && ctx && typeof ctx.executionId === 'string' && ctx.executionId !== '') {
      this._agentSummaries.set(`${instanceId}\0${ctx.executionId}`, result.summary)
    }
    return result
  }

  /** 取走本次 activity 的 summary（只消费一次，避免 map 泄漏）。 */
  _takeAgentSummary(instanceId, activityId) {
    if (typeof activityId !== 'string' || activityId === '') return undefined
    const key = `${instanceId}\0${activityId}`
    if (!this._agentSummaries.has(key)) return undefined
    const summary = this._agentSummaries.get(key)
    this._agentSummaries.delete(key)
    return summary
  }

  _limits() {
    const limits = {}
    const activityWaitMs = positiveEnvInt(this.env[BPMN_ACTIVITY_TIMEOUT_ENV], null)
    if (activityWaitMs !== null) limits.activityWaitMs = activityWaitMs
    return limits
  }

  /**
   * 取 runner：内存里有就用；没有且实例非终态时按 state + 定义快照懒恢复。
   * @returns {Promise<{runner: any|null, recovered: boolean, reason?: string, code?: string|null}>}
   */
  async _ensureRunner(instance) {
    // 终态最先判：已结束的实例不需要恢复，也不该被停止闩影响成「恢复失败」。
    if (TERMINAL_STATUSES.has(instance.status)) {
      return {
        runner: null,
        recovered: false,
        reason: `实例已是终态 ${instance.status}，没有可推进的点`,
        code: null,
      }
    }
    // 停止闩：stop 已经接管这个实例，谁都不许再懒恢复 / 推进。
    if (this._stopping.has(instance.id)) {
      return {
        runner: null,
        recovered: false,
        reason: '实例正在停止（stop 已置停止闩）',
        code: 'BPMN_STATE_STOPPING',
      }
    }
    // 恢复「最后一个成功 agent 输出 + 来源节点」（review-0131 #4）：它随 instance.json
    // 的小字段 `lastAgentOutput` 持久化，内存 Map 只是它的一份读缓存；进程重启 /
    // dispose 之后必须能从快照重建，否则流程跑完时 result 会丢。
    if (!this._lastAgentOutputs.has(instance.id)
      && isPlainObject(instance.lastAgentOutput)
      && isPlainObject(instance.lastAgentOutput.output)) {
      this._lastAgentOutputs.set(instance.id, {
        nodeId: typeof instance.lastAgentOutput.nodeId === 'string' && instance.lastAgentOutput.nodeId !== ''
          ? instance.lastAgentOutput.nodeId
          : null,
        output: { ...instance.lastAgentOutput.output },
      })
    }
    const cached = this._runners.get(instance.id)
    if (cached !== undefined && cached.status() !== 'idle') {
      return { runner: cached, recovered: false }
    }
    if (cached !== undefined) this._runners.delete(instance.id)

    let state
    try {
      state = await readInstanceState(instance.id, { instancesRoot: this.instancesRoot })
    } catch (error) {
      throw new BpmnRuntimeError(500, 'BPMN_STATE_READ_FAILED', `读取实例 ${instance.id} 的 state.json 失败：${errorText(error)}`, {
        instanceId: instance.id,
      })
    }
    if (state === null || state === undefined) {
      return {
        runner: null,
        recovered: false,
        reason: '没有可恢复的引擎快照（state.json 不存在或为空）',
        code: 'BPMN_STATE_MISSING',
      }
    }
    // 失败停机后快照被写成「不可恢复」墓碑：保留 ACTIVE + lastError 是事实，但绝不允许
    // 重启 / 淘汰后自动恢复旧执行位置（否则 complete 可以重放失败前的工作）。
    if (isPlainObject(state.unrecoverable)) {
      const code = typeof state.unrecoverable.code === 'string' && state.unrecoverable.code !== ''
        ? state.unrecoverable.code
        : 'BPMN_STATE_UNRECOVERABLE'
      return {
        runner: null,
        recovered: false,
        reason: `实例因执行失败已停机（${code}），快照被标记为不可恢复：${typeof state.unrecoverable.message === 'string' ? state.unrecoverable.message : '需要人工处理后重新创建实例'}`,
        code,
      }
    }

    const snapshot = await this._readDefinitionSnapshot(instance.id)
    if (snapshot === null) {
      throw new BpmnRuntimeError(500, 'INSTANCE_SNAPSHOT_MISSING', `实例 ${instance.id} 的定义快照缺失`, {
        instanceId: instance.id,
      })
    }
    const parsed = await parseBpmn(snapshot.xml)
    // 恢复准备也是异步的：stop 在读取/解析期间同样可能已经返回 CANCELED。
    // 这里到 runner 创建之间没有 await，复查必须同步完成（review-0131 #1）。
    const stoppedWhilePreparing = this._latchBlockForPrepare(instance.id)
    if (stoppedWhilePreparing !== null) {
      return {
        runner: null,
        recovered: false,
        reason: stoppedWhilePreparing.reason,
        code: stoppedWhilePreparing.code,
      }
    }
    if (!parsed.ok) {
      throw new BpmnRuntimeError(500, 'BPMN_DEFINITION_INVALID', `实例 ${instance.id} 的定义快照未通过 BPMN 校验`, {
        errors: parsed.errors,
      })
    }

    const runner = this._newRunner(parsed.definition, snapshot.xml, instance.id, instance.variables, {
      definitionId: snapshot.definitionId,
      definitionVersion: snapshot.definitionVersion,
    })
    this._runners.set(instance.id, runner)
    // recover 会重放一次 activity/wait（runner 坑 g）：按 state 里已知的 executionId 去重。
    const pending = Array.isArray(state?.pendingTasks) ? state.pendingTasks : []
    this._suppressWait.set(instance.id, new Set(
      pending.map(task => (typeof task?.executionId === 'string' ? task.executionId : null)).filter(Boolean),
    ))
    try {
      await runner.recover(state)
    } catch (error) {
      this._suppressWait.delete(instance.id)
      this._runners.delete(instance.id)
      try {
        await runner.stop()
      } catch {
        // 恢复失败时 stop 只是清活跃表；失败不影响「不可恢复」结论。
      }
      const code = typeof error?.code === 'string' ? error.code : 'BPMN_STATE_RECOVER_FAILED'
      const reason = `state 不可恢复：${errorText(error)}`
      // 快照/定义无法反序列化或结构不一致 = 引擎不可恢复：实例卡住（blocked），
      // 不是 failed。missing 快照也按卡住处理（等人补数据 / 将来 retry）。
      if (code !== 'BPMN_STATE_STOPPING' && !this._stopping.has(instance.id)) {
        await this._markInstanceError(instance.id, {
          code,
          message: reason,
          ...(typeof error?.elementId === 'string' ? { nodeId: error.elementId } : {}),
        })
      }
      return {
        runner: null,
        recovered: false,
        reason,
        code,
      }
    } finally {
      this._suppressWait.delete(instance.id)
    }

    if (this._stopping.has(instance.id)) {
      // recover 进行中 stop 进来了：恢复出来的 runner 立刻停掉，不参与后续推进。
      try {
        await runner.stop()
      } catch {
        // 同上。
      }
      this._runners.delete(instance.id)
      return { runner: null, recovered: false, reason: '实例在恢复过程中被停止', code: 'BPMN_STATE_STOPPING' }
    }

    await this._afterSettle(instance.id, runner)
    return { runner, recovered: true }
  }

  /** 每次操作收口：事件落盘 → 快照落盘 → 实例状态同步；任何失败都显式抛出。 */
  async _afterSettle(instanceId, runner) {
    const failures = await this._flushEvents(instanceId)
    if (failures.length > 0) {
      throw new BpmnRuntimeError(
        500,
        'BPMN_EVENT_WRITE_FAILED',
        `实例 ${instanceId} 的事件写入失败（${failures.length} 条）`,
        { instanceId, eventErrors: failures.map(item => ({ code: item.code ?? 'BPMN_EVENT_WRITE_FAILED', message: errorText(item) })) },
      )
    }
    try {
      await this._persistState(instanceId, runner)
    } catch (error) {
      if (error instanceof BpmnRuntimeError) throw error
      throw new BpmnRuntimeError(500, 'BPMN_STATE_WRITE_FAILED', `实例 ${instanceId} 的 state.json 写入失败：${errorText(error)}`, {
        instanceId,
      })
    }
    await this._syncInstanceStatus(instanceId, runner)
  }

  /** 只在等待 / 运行中落盘（done / blocked 不需要恢复）——每次收口只取一次快照。 */
  async _persistState(instanceId, runner) {
    const status = runner.status()
    if (status !== 'waiting' && status !== 'running') return
    const state = await runner.getState()
    try {
      await writeInstanceState(instanceId, state, { instancesRoot: this.instancesRoot })
    } catch (error) {
      // stop 已经先一步把实例收成终态：晚到的快照不许覆盖，按「stop 赢」静默跳过。
      if (error?.code === 'INSTANCE_TERMINAL_IMMUTABLE') return
      throw error
    }
  }

  /**
   * 失败停机：把持久化快照写成**不可恢复墓碑**（保留实例 ACTIVE + lastError）。
   *
   * 旧快照（waiting/running）若留着，重启 / 淘汰后 `_ensureRunner` 会自动恢复它，
   * 后续 complete 就能重放失败前的工作——「保留 ACTIVE」不等于「应该自动重试」。
   * 墓碑里写清 code/message/at；恢复路径遇到它必须给出明确错误码且零派发。
   */
  async _persistUnrecoverableState(instanceId, lastError) {
    try {
      await writeInstanceState(instanceId, {
        v: BPMN_STATE_VERSION,
        kind: BPMN_STATE_KIND,
        instanceId,
        status: BPMN_RUNNER_STATUS.BLOCKED,
        unrecoverable: {
          code: lastError?.code ?? 'BPMN_STATE_UNRECOVERABLE',
          message: lastError?.message ?? '',
          at: new Date().toISOString(),
        },
        engine: null,
      }, { instancesRoot: this.instancesRoot })
    } catch (error) {
      if (error?.code === 'INSTANCE_TERMINAL_IMMUTABLE') return
      throw error
    }
  }

  /**
   * 用 runner 的真实状态校正实例元数据（事件链已写过一次，这里幂等兜底）。
   *
   * 终态（done / aborted）先检查：已经结束的实例绝不再写任何字段。
   * runner 侧 `blocked` → **只写 `lastError`，实例 status 保持 ACTIVE**（不判死）。
   * 最终 variables / result 与 status 在同一次 updateInstance / completeInstance 提交。
   */
  async _syncInstanceStatus(instanceId, runner) {
    const instance = await readInstance(instanceId, { instancesRoot: this.instancesRoot })
    if (instance === null) return
    if (TERMINAL_STATUSES.has(instance.status)) return
    // stop 闩生效期间不要再写状态（stop 自己会把实例收成 aborted）。
    if (this._stopping.has(instanceId)) return

    const status = runner.status()
    const variables = isPlainObject(runner.variables) && Object.keys(runner.variables).length > 0
      ? runner.variables
      : undefined
    // 最后一个成功 agent 输出（+来源节点）随快照持久化：恢复后 result 不能靠内存 Map。
    const lastAgent = this._lastAgentOutputs.get(instanceId)
    const lastAgentPatch = isPlainObject(lastAgent) && isPlainObject(lastAgent.output)
      ? {
        lastAgentOutput: {
          nodeId: typeof lastAgent.nodeId === 'string' && lastAgent.nodeId !== '' ? lastAgent.nodeId : null,
          output: { ...lastAgent.output },
        },
      }
      : null

    if (status === 'done') {
      // 11 §5：process/end 时 instance.result 取最后一个成功 agent 节点的 output
      // （endEvent 不产生输出）。output 在 gate 里已归一化为短变量对象。
      const result = lastAgentPatch === null ? undefined : { ...lastAgentPatch.lastAgentOutput.output }
      await completeInstance(instanceId, 'COMPLETED', {
        instancesRoot: this.instancesRoot,
        ...(variables === undefined ? {} : { variables }),
        ...(result === undefined ? {} : { result }),
      })
      this._lastAgentOutputs.delete(instanceId)
      return
    }
    if (status === BPMN_RUNNER_STATUS.BLOCKED) {
      const lastError = this._lastErrorFor(instanceId, runner.failure())
      const marked = await this._markInstanceError(instanceId, lastError)
      // stop 抢先把实例收成终态时不写墓碑（终态实例本来就不会被恢复）。
      if (marked !== null && !TERMINAL_STATUSES.has(marked.status)) {
        await this._persistUnrecoverableState(instanceId, lastError)
      }
      return
    }
    if (status === 'waiting') {
      await updateInstance(instanceId, {
        status: 'ACTIVE',
        pendingTasks: runner.pendingTasks(),
        ...(variables === undefined ? {} : { variables }),
        ...(lastAgentPatch === null ? {} : lastAgentPatch),
      }, { instancesRoot: this.instancesRoot })
      return
    }
    if (status === 'running') {
      await updateInstance(instanceId, {
        status: 'ACTIVE',
        ...(variables === undefined ? {} : { variables }),
        ...(lastAgentPatch === null ? {} : lastAgentPatch),
      }, { instancesRoot: this.instancesRoot })
    }
  }

  // -------------------------------------------------------------------------
  // 事件桥
  // -------------------------------------------------------------------------

  _recordRunnerError(instanceId, error) {
    const innerCode = typeof error?.cause?.code === 'string' && error.cause.code !== ''
      ? error.cause.code
      : (typeof error?.code === 'string' && error.code !== '' ? error.code : 'BPMN_ENGINE_ERROR')
    const innerMessage = typeof error?.cause?.message === 'string' && error.cause.message !== ''
      ? error.cause.message
      : errorText(error)
    this._runnerErrors.set(instanceId, { code: innerCode, message: innerMessage })
  }

  _onRunnerEvent(instanceId, event) {
    if (!isPlainObject(event) || typeof event.type !== 'string' || event.type === '') return
    // stop 闩之后的迟到事件（abort 前已在飞的调用）一律不落盘：不能给 aborted 实例补事件。
    if (this._stopping.has(instanceId)) return
    const runner = this._runners.get(instanceId) ?? null

    // recover 重放的 wait：同一 executionId 已经落过盘，不再写第二条。
    if (event.type === 'activity/wait') {
      const suppress = this._suppressWait.get(instanceId)
      if (suppress !== undefined) {
        const executionId = typeof event.activityId === 'string' ? event.activityId : null
        if (executionId !== null && suppress.has(executionId)) {
          suppress.delete(executionId)
          return
        }
      }
    }

    const activityId = shardIdOf(event)
    const attempt = this._nextAttempt(instanceId, event)
    // 11 §5：activity/end 除了 runner 已带的 output/artifacts，还要带本次 agent 的 summary。
    // summary 只存在 runtime 的短期表里（runner 的 handler 结果契约不额外扩字段）。
    let persistedSource = event
    if (event.type === 'activity/end') {
      const summary = this._takeAgentSummary(instanceId, event.activityId)
      if (summary !== undefined) persistedSource = { ...event, summary }
    }
    const persisted = persistableEvent(persistedSource)
    this._enqueueEvent(instanceId, async () => {
      // 事件是入队执行的：轮到这里时 stop 可能已经置闩 / 实例可能已终态，
      // 必须复查，不能把停止前排队的事件晚写到终态实例上。
      if (this._stopping.has(instanceId)) return
      try {
        if (persisted === null) {
          throw new BpmnRuntimeError(500, 'BPMN_EVENT_UNSERIALIZABLE', `实例 ${instanceId} 的事件 ${event.type} 不能被序列化为 JSON`)
        }
        await appendInstanceEvents(instanceId, activityId, attempt, persisted, { instancesRoot: this.instancesRoot })
        if (event.type === 'process/start' || event.type === 'activity/start') {
          await updateInstance(instanceId, { status: 'ACTIVE' }, { instancesRoot: this.instancesRoot })
        } else if (event.type === 'activity/wait') {
          await updateInstance(instanceId, {
            status: 'ACTIVE',
            pendingTasks: runner === null ? [] : runner.pendingTasks(),
          }, { instancesRoot: this.instancesRoot })
        } else if (event.type === 'activity/end') {
          // 11 §3 / §5：产物索引由运行时维护，按 path+sha256 去重（重复活动执行不重复追加）。
          if (Array.isArray(event.artifacts)) {
            await this._mergeArtifacts(instanceId, event.artifacts)
          }
          await updateInstance(instanceId, {
            status: 'ACTIVE',
            pendingTasks: runner === null ? [] : runner.pendingTasks(),
          }, { instancesRoot: this.instancesRoot })
        } else if (event.type === 'error') {
          // 出错**不改 status**：实例继续 ACTIVE，只把事实留成 lastError（连同 error 事件）。
          const reminders = this._agentReminders.get(instanceId)
          const lastError = {
            code: typeof event.error?.code === 'string' ? event.error.code : 'BPMN_ENGINE_ERROR',
            message: typeof event.error?.message === 'string' ? event.error.message : '',
            ...(Number.isSafeInteger(reminders) && reminders >= 0 ? { reminders } : {}),
            ...(typeof event.elementId === 'string' ? { nodeId: event.elementId } : {}),
            ...(typeof event.activityId === 'string' ? { activityId: event.activityId } : {}),
          }
          // 失败即停机：待办一并清空（异步失败时可能没有 _syncInstanceStatus 收口）。
          await updateInstance(instanceId, { lastError, pendingTasks: [] }, { instancesRoot: this.instancesRoot })
          // 失败事实一旦落盘，旧快照立刻变成不可恢复：不能等下一个请求/收口才处理
          // （runTimeout 等异步失败可能没有在等的请求）。
          await this._persistUnrecoverableState(instanceId, lastError)
        }
        // 终态 / blocked 一律由 `_syncInstanceStatus` 在收口时一次提交：
        // 事件链只负责落盘，不抢先把 status 写死（否则最终 variables 会被终态保护挡住）。
      } catch (error) {
        // 另一个请求先收成终态：晚到事件丢弃，不升级成事件写入失败。
        if (error?.code === 'INSTANCE_TERMINAL_IMMUTABLE') return
        throw error
      }
    })
  }

  /**
   * 把 `flow_finish_node` 登记的产物引用合并进 `instance.json.artifacts[]`。
   *
   * 去重键固定 `path + sha256`：同一活动重试、同一文件被多个节点引用都不会重复追加；
   * 内容变了（hash 不同）则是新产物。终态实例不再写（由 store 的终态保护兜底）。
   */
  async _mergeArtifacts(instanceId, artifacts) {
    if (!Array.isArray(artifacts) || artifacts.length === 0) return
    const instance = await readInstance(instanceId, { instancesRoot: this.instancesRoot })
    if (instance === null || TERMINAL_STATUSES.has(instance.status)) return
    const current = Array.isArray(instance.artifacts) ? instance.artifacts : []
    const seen = new Set(current.map(item => `${item?.path ?? ''}\0${item?.sha256 ?? ''}`))
    const added = []
    for (const item of artifacts) {
      if (!isPlainObject(item)) continue
      if (typeof item.path !== 'string' || item.path === '') continue
      if (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(item.sha256)) continue
      const sha256 = item.sha256.toLowerCase()
      const key = `${item.path}\0${sha256}`
      if (seen.has(key)) continue
      seen.add(key)
      added.push({
        path: item.path,
        sha256,
        bytes: Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? item.bytes : 0,
        kind: typeof item.kind === 'string' ? item.kind : '',
        title: typeof item.title === 'string' ? item.title : '',
        ...(typeof item.nodeId === 'string' && item.nodeId !== '' ? { nodeId: item.nodeId } : {}),
        ...(Number.isSafeInteger(item.attempt) && item.attempt >= 1 ? { attempt: item.attempt } : {}),
        ...(typeof item.at === 'string' && item.at !== '' ? { at: item.at } : {}),
      })
    }
    if (added.length === 0) return
    await updateInstance(instanceId, { artifacts: [...current, ...added] }, { instancesRoot: this.instancesRoot })
  }

  _nextAttempt(instanceId, event) {
    let attempts = this._attempts.get(instanceId)
    if (attempts === undefined) {
      attempts = new Map()
      this._attempts.set(instanceId, attempts)
    }
    if (event.type === 'activity/start' && typeof event.elementId === 'string') {
      const next = (attempts.get(event.elementId) ?? 0) + 1
      attempts.set(event.elementId, next)
      return next
    }
    if (typeof event.elementId === 'string' && attempts.has(event.elementId)) {
      return attempts.get(event.elementId)
    }
    if (event.type === 'flow/taken' && typeof event.from === 'string' && attempts.has(event.from)) {
      return attempts.get(event.from)
    }
    return 1
  }

  _enqueueEvent(instanceId, task) {
    const previous = this._eventChains.get(instanceId) ?? Promise.resolve()
    const next = previous
      .then(task)
      .catch(error => {
        const list = this._eventFailures.get(instanceId) ?? []
        list.push(error)
        this._eventFailures.set(instanceId, list)
      })
    this._eventChains.set(instanceId, next)
  }

  async _flushEvents(instanceId) {
    // 等「当前的尾巴」；若期间又有事件入队，继续等新尾巴（迟到的 process/end 也收口）。
    for (;;) {
      const chain = this._eventChains.get(instanceId)
      if (chain === undefined) break
      await chain.catch(() => {})
      if (this._eventChains.get(instanceId) === chain) break
    }
    const failures = this._eventFailures.get(instanceId) ?? []
    this._eventFailures.delete(instanceId)
    return failures
  }
}

function methodNotAllowed(supported) {
  return {
    status: 405,
    body: { ok: false, code: 'BPMN_METHOD_NOT_ALLOWED', error: `只支持 ${supported}` },
  }
}

/** URL 里的 activityId：先解码，再按「非空、有界字符串」校验（不套 run id 路径规则）。 */
function activityIdLabel(raw) {
  let decoded = String(raw ?? '')
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // 非法百分号编码：保留原文，交给长度校验。
  }
  return decoded.trim() !== '' && decoded.length <= 128 ? decoded : null
}

function invalidInstanceId() {
  return {
    status: 400,
    body: {
      ok: false,
      code: 'BPMN_INSTANCE_ID_INVALID',
      error: 'instanceId 只能由字母 / 数字 / 点 / 下划线 / 连字符组成，不以点开头，且不超过 64 字符',
    },
  }
}

function instanceNotFound(id) {
  return {
    status: 404,
    body: { ok: false, code: 'INSTANCE_NOT_FOUND', error: `实例 ${id} 不存在` },
  }
}

function versionOf(entry) {
  return {
    version: entry.version,
    hash: entry.hash,
    createdAt: entry.createdAt,
    bytes: entry.bytes,
  }
}

// ---------------------------------------------------------------------------
// 服务处理器（0.13.0 范围：外部 CLI executor 薄接；其余明确失败）
// ---------------------------------------------------------------------------

/**
 * 读出 handler 该用的 attempt / variables（runner 的 ctx 是快照拷贝）。
 */
function handlerContext(ctx) {
  const attempt = ctx && Number.isSafeInteger(ctx.attempt) && ctx.attempt >= 1 ? ctx.attempt : 1
  const variables = ctx && isPlainObject(ctx.variables) ? ctx.variables : {}
  return { attempt, variables }
}

function throwIfAborted(ctx) {
  if (ctx?.signal?.aborted) {
    throw handlerError('BPMN_ABORTED', '活动已被取消（ctx.signal 已 abort）', {
      reason: 'aborted',
    })
  }
}

/** 外部 executor 的 prompt：节点提示词 + attempt / variables（下游能看见上下文）。 */
function buildExecutorPrompt(element, ctx) {
  const node = isPlainObject(element?.node) ? element.node : {}
  const base = [node.prompt, node.roleCard]
    .filter(value => typeof value === 'string' && value.trim() !== '')
    .join('\n\n')
    || (typeof element?.name === 'string' && element.name !== '' ? element.name : null)
    || (typeof element?.id === 'string' ? element.id : '执行节点')
  const { attempt, variables } = handlerContext(ctx)
  const lines = [base, `执行上下文：attempt=${attempt}`]
  if (Object.keys(variables).length > 0) {
    lines.push(`变量：\n${JSON.stringify(variables)}`)
  }
  return lines.join('\n\n')
}

/**
 * agent 节点处理器（签名固定 `(element, ctx)`）。
 *
 * 0.13.1 A3 起：`dsh` / `codex` 等注册过的 adapter 走 **AgentAdapter + flow_finish_node
 * 完结门**（`agent-execute.js`）：
 *
 * 1. `fs:node@adapter` 决定 adapter id（缺失默认 `dsh`；旧 `fs:executor@kind` 兜底）；
 * 2. admission：`adapter.probe()`（每个 runtime 只 probe 一次）→ `assertFinishToolNative`；
 *    非 native / probe 失败 → 节点**零派发**，`NODE_FINISH_TOOL_UNAVAILABLE`；
 * 3. `createFinishGate` + `adapter.start` → 等 `handle.exited`（不轮询 stdout）；
 * 4. 成功只认闸门受理的 record：返回 `{ output, artifacts, summary, usage, events }`；
 * 5. 失败码原样冒泡（`NODE_FINISH_MISSING` / `NODE_VARIABLES_INVALID` / …），
 *    由 runtime 写 lastError、实例保持 ACTIVE。
 *
 * 兼容：`adapter=custom`（以及没有注册表时的 `codex`）仍走旧的 `runExternalExecutor`
 * 外部 CLI 路径——这是逃生门，不破坏 0.13.0 的既有接线。没有注册表时的 `dsh`
 * 明确报 `BPMN_AGENT_ADAPTER_UNAVAILABLE`（旧行为，不伪造成功）。
 *
 * 第三个参数是本模块内部注入点（测试用桩 executor / adapter 注册表）；公开契约仍是两个参数。
 *
 * @param {object} element
 * @param {{attempt?: number, variables?: object, signal?: AbortSignal, timeoutMs?: number|null,
 *   executionId?: string}} ctx
 * @param {{runExecutor?: Function, normalizeExecutor?: Function, adapters?: object,
 *   probeAdapter?: Function, workspaceRoot?: string, instanceId?: string}} [options]
 * @returns {Promise<{output?: unknown, usage?: object, artifacts?: object[], summary?: string,
 *   events?: object[]}>}
 */
export async function executeAgent(element, ctx, options = {}) {
  throwIfAborted(ctx)
  const declared = resolveAdapterId(element)
  const adapterId = declared ?? DEFAULT_ADAPTER_ID
  const adapters = options.adapters && typeof options.adapters.get === 'function' ? options.adapters : null

  // 逃生门：custom 永远走外部 CLI executor（既有测试与运维用法）。
  if (adapterId === 'custom') {
    return await executeAgentViaExecutor(element, ctx, options, 'custom')
  }

  if (adapters === null) {
    // 旧接线（没有注册表）：codex 保留外部 CLI 路径；dsh / 未知 adapter 明确失败。
    if (adapterId === 'codex') {
      return await executeAgentViaExecutor(element, ctx, options, 'codex')
    }
    if (adapterId === 'dsh') {
      throw handlerError(
        AGENT_EXECUTE_ERROR.ADAPTER_UNAVAILABLE,
        '0.13.1 起 dsh 走 AgentAdapter + flow_finish_node，但当前 runtime 没有适配器注册表'
          + '（createAdapterRegistry + createDshAdapter）；只支持外部 CLI executor（adapter=codex/custom）',
        { adapter: adapterId, elementId: element?.id ?? null },
      )
    }
    throw handlerError(
      AGENT_EXECUTE_ERROR.ADAPTER_UNSUPPORTED,
      `不支持的 agent adapter「${adapterId}」：没有适配器注册表时只支持 codex / custom`,
      { adapter: adapterId, elementId: element?.id ?? null },
    )
  }

  const adapter = adapters.get(adapterId)
  if (!adapter) {
    const available = typeof adapters.list === 'function'
      ? adapters.list().map(item => item && item.id).filter(Boolean)
      : []
    throw handlerError(
      AGENT_EXECUTE_ERROR.ADAPTER_UNSUPPORTED,
      `不支持的 agent adapter「${adapterId}」：没有注册这个 id`
        + (available.length > 0 ? `（已注册：${available.join(' / ')}）` : '（注册表为空）'),
      { adapter: adapterId, elementId: element?.id ?? null },
    )
  }

  // admission：probe + 原生 finishTool 断言。失败时零派发（不调用 adapter.start）。
  //
  // review-0131 #3：有效时限与旧 executor 路径同优先级（ctx > node.executor.timeoutMs），
  // 且是**整个活动**的 deadline——probe 花掉的时间从预算里扣，剩余部分交给 runAgentNode
  // 约束 start / 执行 / 取消阶段；没有全局活动超时时，节点自己的 executor.timeoutMs 生效。
  const effectiveTimeoutMs = resolveAgentTimeoutMs(element, ctx)
  const admissionStartedAt = Date.now()
  await admitAdapter(adapter, {
    probeAdapter: options.probeAdapter,
    nodeId: element?.id,
    timeoutMs: effectiveTimeoutMs,
  })
  const remainingTimeoutMs = effectiveTimeoutMs > 0
    ? effectiveTimeoutMs - (Date.now() - admissionStartedAt)
    : 0
  if (effectiveTimeoutMs > 0 && remainingTimeoutMs <= 0) {
    throw handlerError(
      AGENT_EXECUTE_ERROR.ACTIVITY_TIMEOUT,
      `活动 ${element?.id ?? '(agent)'} 的 ${effectiveTimeoutMs}ms 时限在 admission 阶段已用尽（未派发节点）`,
      { elementId: element?.id ?? null, adapter: adapterId, timeoutMs: effectiveTimeoutMs, phase: 'admission' },
    )
  }

  return await runAgentNode({
    element,
    ctx,
    adapter,
    workspaceRoot: options.workspaceRoot,
    instanceId: options.instanceId,
    // 配置口径的总时限（透传给适配器 ctx.timeoutMs）与扣掉 probe 后剩余的执行预算。
    effectiveTimeoutMs,
    ...(remainingTimeoutMs > 0 ? { timeoutMs: remainingTimeoutMs } : {}),
    log: typeof options.log === 'function' ? options.log : undefined,
  })
}

/**
 * 旧路径：外部 CLI executor（`adapter=custom` / 无注册表时的 `codex`）。
 * 行为与 0.13.0 保持一致（便于回退与既有测试）。
 *
 * @param {object} element
 * @param {object} ctx
 * @param {{runExecutor?: Function, normalizeExecutor?: Function}} [options]
 * @param {'custom'|'codex'} adapterId
 */
async function executeAgentViaExecutor(element, ctx, options, adapterId) {
  const node = isPlainObject(element?.node) ? element.node : {}
  const normalize = typeof options.normalizeExecutor === 'function' ? options.normalizeExecutor : normalizeExecutor
  let spec
  try {
    spec = normalize({
      executor: adapterId,
      executorCommand: node.executor?.command,
      model: node.model,
      mode: node.team?.mode,
    })
  } catch (error) {
    throw handlerError(
      typeof error?.code === 'string' ? error.code : 'BPMN_EXECUTOR_INVALID',
      errorText(error),
      { elementId: element?.id ?? null, cause: error },
    )
  }

  const runExecutor = typeof options.runExecutor === 'function' ? options.runExecutor : runExternalExecutor
  const timeoutMs = Number.isSafeInteger(ctx?.timeoutMs) && ctx.timeoutMs > 0
    ? ctx.timeoutMs
    : (Number.isSafeInteger(node.executor?.timeoutMs) && node.executor.timeoutMs > 0 ? node.executor.timeoutMs : 0)
  const result = await runExecutor({
    spec,
    prompt: buildExecutorPrompt(element, ctx),
    cwd: typeof node.executor?.cwd === 'string' && node.executor.cwd.trim() !== ''
      ? node.executor.cwd.trim()
      : process.cwd(),
    timeoutMs,
    signal: ctx?.signal,
  })

  throwIfAborted(ctx)
  if (!result || result.ok !== true) {
    const reason = result?.reason
    const code = typeof result?.code === 'string' && result.code !== ''
      ? result.code
      : reason === 'aborted'
        ? 'BPMN_ABORTED'
        : reason === 'timeout'
          ? 'BPMN_EXECUTOR_TIMEOUT'
          : reason === 'OUTPUT_LIMIT'
            ? 'BPMN_EXECUTOR_OUTPUT_LIMIT'
            : 'BPMN_EXECUTOR_FAILED'
    const tail = typeof result?.tail === 'string' && result.tail !== '' ? `；stderr 尾部：${result.tail}` : ''
    throw handlerError(
      code,
      `外部 executor 执行失败（${reason ?? 'unknown'}）${result?.exitCode != null ? `，退出码 ${result.exitCode}` : ''}${tail}`,
      { elementId: element?.id ?? null, reason: reason ?? null, exitCode: result?.exitCode ?? null },
    )
  }

  const rawEvents = Array.isArray(result.events) ? result.events : []
  const events = rawEvents
    .filter(event => isPlainObject(event) && typeof event.text === 'string' && event.text.trim() !== '')
    .slice(0, 200)
    .map(event => ({
      type: 'agent/log',
      kind: event.kind ?? 'log',
      text: event.text.length > 2000 ? `${event.text.slice(0, 2000)}…` : event.text,
    }))
  return {
    output: result.structured ?? result.text,
    ...(result.usage && isPlainObject(result.usage) ? { usage: result.usage } : {}),
    ...(events.length > 0 ? { events } : {}),
  }
}

/**
 * http connector 处理器（签名固定 `(element, ctx)`）。
 *
 * 0.13.0 **不实现真实 HTTP**（0.13.4 才做 fetch + 超时/重试/变量映射/鉴权头脱敏），
 * 抛 `BPMN_HTTP_NOT_IMPLEMENTED` 的结构化错误，避免半成品 fetch 被误认为可用。
 *
 * @param {object} element
 * @param {{signal?: AbortSignal}} ctx
 * @returns {Promise<never>}
 */
export async function executeHttp(element, ctx) {
  throwIfAborted(ctx)
  throw handlerError(
    'BPMN_HTTP_NOT_IMPLEMENTED',
    'http connector 在 0.13.4 提供（fetch + 超时/重试/变量映射/鉴权头脱敏）；0.13.0 不执行任何真实 HTTP',
    { elementId: element?.id ?? null },
  )
}

/** 导出目录 helper，便于运维/测试核对根位置（与 store 同口径）。 */
export { definitionsDir, instancesDir }
