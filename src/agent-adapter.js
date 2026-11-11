/**
 * Agent 适配器**冻结接口**与注册表（0.13.1）。
 *
 * 契约来源：
 *   - `docs/design/11-node-finish-tool.md` §4 / §6：agent 节点必须通过原生工具
 *     `flow_finish_node` 完结；没有 native 工具能力的适配器**在 admission 阶段就拒绝**，
 *     禁止静默降级成「看输出文本猜结论」；
 *   - `docs/design/09-agent-adapter-hooks.md` B-1：`AgentAdapter` 形状与能力表。
 *
 * 本模块只做三件事：
 *   1. `AdapterError`：带 `{ code, message, details }` 的结构化错误；
 *   2. `validateAdapter` / `assertFinishToolNative`：形状与能力校验（注册时 + 启动前）；
 *   3. `createAdapterRegistry`：`register` / `get` / `list` / `probeAll`。
 *
 * 适配器形状（字段冻结，codex / claude 适配器同样实现这一份）：
 * ```
 * {
 *   id,
 *   probe(): Promise<{ version: string, helpDigest: string }>,
 *   capabilities(): { finishTool: 'native'|'unsupported',
 *                     hooks: { 'turn.stop': 'native'|'emulated'|'unsupported' }, ... },
 *   start({ element, ctx, finishGate, workspaceRoot, reminder }) → Promise<handle>,
 *   cancel(handle, reason),
 *   dispose(handle),
 * }
 * handle: { exited: Promise<{ ok, code?, reminders?, record?, message? }>,
 *           sessionId?, agentId?, pid? }
 * ```
 *
 * `capabilities().finishTool` 只允许 `native | unsupported`（11 §1.6：不允许
 * 「emulated 文本解析」这种中间态）。**未成功 `probe()` 前只能声明 `unsupported`**：
 * `native` 是实测结论，不是静态声明；`start()` 里必须确保已经 probe 过。
 * `hooks['turn.stop']` 允许三档——codex 没有原生 Stop hook 时可以声明
 * `emulated`（进程级续跑）。
 *
 * @module @feiyueve/dsh-flow-studio/agent-adapter
 */

/** 适配器层错误码（对外契约；测试与上层接线都按这些字符串分流）。 */
export const ADAPTER_ERROR = Object.freeze({
  /** 适配器形状 / 调用参数非法。 */
  INVALID: 'ADAPTER_INVALID',
  /** 同一 id 重复注册。 */
  DUPLICATE_ID: 'ADAPTER_DUPLICATE_ID',
  /** 能力表不合法（`finishTool` 不是 native|unsupported、hooks 档位非法…）。 */
  CAPABILITY_INVALID: 'ADAPTER_CAPABILITY_INVALID',
  /** `probe()` 返回形状不合法（不是 `{ version, helpDigest }`）。 */
  PROBE_INVALID: 'ADAPTER_PROBE_INVALID',
  /**
   * 适配器没有原生工具能力：**start 必须直接抛这个码**，不得退回解析文本
   * （11 §1.6）。宿主缺 `tools.register` 时也复用这个码。
   */
  NODE_FINISH_TOOL_UNAVAILABLE: 'NODE_FINISH_TOOL_UNAVAILABLE',
})

/** `capabilities().finishTool` 的合法取值（只有两档，没有 emulated）。 */
export const FINISH_TOOL_SUPPORT = Object.freeze({
  NATIVE: 'native',
  UNSUPPORTED: 'unsupported',
})

/** `capabilities().hooks[...]` 的合法取值。 */
export const HOOK_SUPPORT = Object.freeze({
  NATIVE: 'native',
  EMULATED: 'emulated',
  UNSUPPORTED: 'unsupported',
})

/**
 * `capabilities().messages` 的合法取值（0.13.10 实例域 inbox 的可选能力扩展）。
 *
 * - `native`：适配器实现了可选的 `deliverMessage(handle, message)`，宿主可以在 agent
 *   执行期间投递收件箱消息；
 * - `unsupported`：没有消息能力；宿主必须把消息标记为 `deliveryUnknown`，不能声称
 *   已投递。**旧适配器不写这个字段时按 `unsupported` 处理**，冻结接口不受影响。
 */
export const MESSAGE_SUPPORT = Object.freeze({
  NATIVE: 'native',
  UNSUPPORTED: 'unsupported',
})

/**
 * `capabilities().usage` 的合法取值（0.13.10 运行指标的可选能力扩展）。
 *
 * - `native`：适配器能观测到模型调用级 usage，并通过可选的 `handle.usageCalls`
 *   暴露 `{ provider, callId, usage, source }[]`；宿主据此记录 `agent/usage`；
 * - `unknown`：没有 usage 观测，运行指标必须把 token 标成未知，绝不给 0。
 *
 * **旧适配器不写这个字段时按 `unknown` 处理**，冻结接口不变。
 */
export const USAGE_SUPPORT = Object.freeze({
  NATIVE: 'native',
  UNKNOWN: 'unknown',
})

/**
 * `probeAll()` 里**单个适配器**的探测上限（毫秒）。探测会起子进程 / 走 MCP 握手，
 * 任何一个挂住都不能让注册表整体挂住；超时按 `ok:false` 记录（m9）。
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000

/** 冻结接口里适配器**必须**具备的方法名。 */
const ADAPTER_METHODS = Object.freeze(['probe', 'capabilities', 'start', 'cancel', 'dispose'])

const FINISH_TOOL_LEVELS = new Set(Object.values(FINISH_TOOL_SUPPORT))
const HOOK_LEVELS = new Set(Object.values(HOOK_SUPPORT))
const MESSAGE_LEVELS = new Set(Object.values(MESSAGE_SUPPORT))
const USAGE_LEVELS = new Set(Object.values(USAGE_SUPPORT))

/**
 * 带结构化错误码的适配器错误。
 *
 * 用法与 `node-finish.js` 的 `NodeFinishError` 一致：`new AdapterError(code, message, details)`。
 */
export class AdapterError extends Error {
  /**
   * @param {string} code 见 `ADAPTER_ERROR`（也允许适配器自定义，如 `DSH_AGENTS_UNAVAILABLE`）
   * @param {string} message 中文可行动原因
   * @param {object} [details] 结构化定位（adapterId / field / reason / cause…）
   */
  constructor(code, message, details) {
    super(typeof message === 'string' && message !== '' ? message : String(code))
    this.name = 'AdapterError'
    this.code = typeof code === 'string' && code !== '' ? code : ADAPTER_ERROR.INVALID
    this.details = details !== undefined && details !== null && typeof details === 'object'
      ? details
      : undefined
  }
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

function fail(code, message, details) {
  return new AdapterError(code, message, details)
}

/** 把任意 thrown 值收敛成可读一行（错误信息里不打印对象全文）。 */
function errorText(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * 校验适配器形状与能力表。注册时调用，失败抛 `AdapterError`。
 *
 * 校验点（冻结接口）：
 *   1. `id` 非空字符串；
 *   2. `probe` / `capabilities` / `start` / `cancel` / `dispose` 都是函数；
 *   3. `capabilities()` 返回对象，`finishTool ∈ {native, unsupported}`，
 *      `hooks['turn.stop'] ∈ {native, emulated, unsupported}`。
 *
 * @param {unknown} adapter
 * @returns {object} 原样返回合法适配器（便于链式使用）
 * @throws {AdapterError}
 */
export function validateAdapter(adapter) {
  if (typeof adapter !== 'object' || adapter === null) {
    throw fail(ADAPTER_ERROR.INVALID, '适配器必须是对象', { field: 'adapter' })
  }
  if (!nonEmptyString(adapter.id)) {
    throw fail(ADAPTER_ERROR.INVALID, '适配器缺少非空字符串 id', { field: 'id', reason: 'missing-id' })
  }
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw fail(
        ADAPTER_ERROR.INVALID,
        `适配器 ${adapter.id} 缺少方法 ${method}()`,
        { adapterId: adapter.id, field: method, reason: 'missing-method' },
      )
    }
  }
  let caps
  try {
    caps = adapter.capabilities()
  } catch (error) {
    throw fail(
      ADAPTER_ERROR.CAPABILITY_INVALID,
      `适配器 ${adapter.id} 的 capabilities() 抛错：${errorText(error)}`,
      { adapterId: adapter.id, field: 'capabilities', reason: 'threw' },
    )
  }
  if (!isPlainObject(caps)) {
    throw fail(
      ADAPTER_ERROR.CAPABILITY_INVALID,
      `适配器 ${adapter.id} 的 capabilities() 必须返回对象`,
      { adapterId: adapter.id, field: 'capabilities', reason: 'not-object' },
    )
  }
  if (!FINISH_TOOL_LEVELS.has(caps.finishTool)) {
    throw fail(
      ADAPTER_ERROR.CAPABILITY_INVALID,
      `适配器 ${adapter.id} 的 capabilities().finishTool 必须是 native 或 unsupported`
        + `（收到 ${JSON.stringify(caps.finishTool)}；11 §1.6 不允许文本解析型降级）`,
      { adapterId: adapter.id, field: 'finishTool', value: caps.finishTool },
    )
  }
  if (!isPlainObject(caps.hooks)) {
    throw fail(
      ADAPTER_ERROR.CAPABILITY_INVALID,
      `适配器 ${adapter.id} 的 capabilities().hooks 必须是对象`,
      { adapterId: adapter.id, field: 'hooks', reason: 'not-object' },
    )
  }
  for (const event of ['turn.stop']) {
    if (!HOOK_LEVELS.has(caps.hooks[event])) {
      throw fail(
        ADAPTER_ERROR.CAPABILITY_INVALID,
        `适配器 ${adapter.id} 的 capabilities().hooks['${event}'] 必须是 native / emulated / unsupported`
          + `（收到 ${JSON.stringify(caps.hooks[event])}）`,
        { adapterId: adapter.id, field: `hooks['${event}']`, value: caps.hooks[event] },
      )
    }
  }
  // 0.13.10 可选扩展：缺省 = unsupported（不破坏旧适配器）；声明 native 必须有
  // deliverMessage()，否则「声称能投递但宿主调不到」比不可用更危险。
  if (caps.messages !== undefined && !MESSAGE_LEVELS.has(caps.messages)) {
    throw fail(
      ADAPTER_ERROR.CAPABILITY_INVALID,
      `适配器 ${adapter.id} 的 capabilities().messages 必须是 native 或 unsupported`
        + `（收到 ${JSON.stringify(caps.messages)}）`,
      { adapterId: adapter.id, field: 'messages', value: caps.messages },
    )
  }
  if (caps.messages === MESSAGE_SUPPORT.NATIVE && typeof adapter.deliverMessage !== 'function') {
    throw fail(
      ADAPTER_ERROR.CAPABILITY_INVALID,
      `适配器 ${adapter.id} 声明了 capabilities().messages=native，但没有 deliverMessage(handle, message)`,
      { adapterId: adapter.id, field: 'deliverMessage', reason: 'missing-method' },
    )
  }
  // 0.13.10 可选扩展：缺省 = unknown（不破坏旧适配器）；声明 native 时宿主会读
  // `handle.usageCalls`，适配器没实现就只会得到「未知」，不会伪造 token。
  if (caps.usage !== undefined && !USAGE_LEVELS.has(caps.usage)) {
    throw fail(
      ADAPTER_ERROR.CAPABILITY_INVALID,
      `适配器 ${adapter.id} 的 capabilities().usage 必须是 native 或 unknown`
        + `（收到 ${JSON.stringify(caps.usage)}）`,
      { adapterId: adapter.id, field: 'usage', value: caps.usage },
    )
  }
  return adapter
}

/**
 * 读取适配器的 usage 观测档位；缺省 / 非法一律 `unknown`（不可观测不是零）。
 *
 * @param {object|null} adapter
 * @returns {'native'|'unknown'}
 */
export function adapterUsageCapability(adapter) {
  try {
    const caps = adapter && typeof adapter.capabilities === 'function' ? adapter.capabilities() : null
    return caps && caps.usage === USAGE_SUPPORT.NATIVE ? USAGE_SUPPORT.NATIVE : USAGE_SUPPORT.UNKNOWN
  } catch {
    return USAGE_SUPPORT.UNKNOWN
  }
}

/**
 * 断言适配器具备**原生** `flow_finish_node` 工具能力。
 *
 * 没有 native 能力的适配器，`start` 必须直接抛 `NODE_FINISH_TOOL_UNAVAILABLE`
 * （11 §1.6），不得退回「读输出文本猜结论」。
 *
 * @param {object} adapter
 * @param {object} [details] 附到错误上的定位信息（nodeId / phase …）
 * @returns {true}
 * @throws {AdapterError}
 */
export function assertFinishToolNative(adapter, details) {
  const adapterId = adapter && typeof adapter === 'object' ? adapter.id : undefined
  let caps
  try {
    caps = adapter && typeof adapter.capabilities === 'function' ? adapter.capabilities() : undefined
  } catch (error) {
    throw fail(
      ADAPTER_ERROR.CAPABILITY_INVALID,
      `适配器 ${adapterId ?? '(unknown)'} 的 capabilities() 抛错：${errorText(error)}`,
      { ...(details || {}), adapterId, field: 'capabilities', reason: 'threw' },
    )
  }
  if (!caps || caps.finishTool !== FINISH_TOOL_SUPPORT.NATIVE) {
    throw fail(
      ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
      `适配器 ${adapterId ?? '(unknown)'} 没有原生工具能力（capabilities().finishTool=`
        + `${JSON.stringify(caps && caps.finishTool)}）：不能提供 flow_finish_node，`
        + '按 11 §1.6 拒绝启动，不退回解析文本',
      {
        ...(details || {}),
        adapterId,
        finishTool: caps ? caps.finishTool : undefined,
        reason: 'finish-tool-not-native',
      },
    )
  }
  return true
}

function normalizeProbeResult(adapterId, probe) {
  if (!isPlainObject(probe)) {
    throw fail(
      ADAPTER_ERROR.PROBE_INVALID,
      `适配器 ${adapterId} 的 probe() 必须返回 { version, helpDigest }`,
      { adapterId, field: 'probe', reason: 'not-object' },
    )
  }
  if (typeof probe.version !== 'string' || probe.version === '') {
    throw fail(
      ADAPTER_ERROR.PROBE_INVALID,
      `适配器 ${adapterId} 的 probe().version 必须是非空字符串`,
      { adapterId, field: 'version', reason: 'not-string' },
    )
  }
  if (typeof probe.helpDigest !== 'string' || probe.helpDigest === '') {
    throw fail(
      ADAPTER_ERROR.PROBE_INVALID,
      `适配器 ${adapterId} 的 probe().helpDigest 必须是非空字符串`,
      { adapterId, field: 'helpDigest', reason: 'not-string' },
    )
  }
  return { version: probe.version, helpDigest: probe.helpDigest }
}

/**
 * 适配器注册表。
 *
 * `probeAll()` 逐个跑 `probe()`：单个适配器失败**不**影响其它适配器，
 * 结果里按注册顺序给出 `{ id, ok, version?, helpDigest?, error? }`。
 * 每个适配器有独立的探测上限（默认 {@link DEFAULT_PROBE_TIMEOUT_MS}），
 * 超时与抛错一样记 `ok:false`——注册表不会因为一个适配器挂住而整体挂住。
 *
 * @param {{ probeTimeoutMs?: number }} [options]
 * @returns {{
 *   register: (adapter: object) => () => void,
 *   get: (id: string) => object | undefined,
 *   list: () => object[],
 *   probeAll: () => Promise<Array<object>>,
 * }}
 */
export function createAdapterRegistry(options = {}) {
  /** @type {Map<string, object>} */
  const adapters = new Map()
  const probeTimeoutMs = Number.isSafeInteger(options.probeTimeoutMs) && options.probeTimeoutMs > 0
    ? options.probeTimeoutMs
    : DEFAULT_PROBE_TIMEOUT_MS

  function register(adapter) {
    validateAdapter(adapter)
    if (adapters.has(adapter.id)) {
      throw fail(
        ADAPTER_ERROR.DUPLICATE_ID,
        `适配器 id「${adapter.id}」已经注册过（同一 id 只能有一个实现）`,
        { adapterId: adapter.id, reason: 'duplicate-id' },
      )
    }
    adapters.set(adapter.id, adapter)
    // 返回单次生效的注销器：只有「当前这个实例」在册时才移除，避免把后注册的同 id 顶掉。
    return () => {
      if (adapters.get(adapter.id) === adapter) adapters.delete(adapter.id)
    }
  }

  function get(id) {
    if (typeof id !== 'string' || id === '') return undefined
    return adapters.get(id)
  }

  function list() {
    return [...adapters.values()]
  }

  async function probeAll() {
    const results = []
    for (const adapter of adapters.values()) {
      let timer = null
      try {
        const probe = await Promise.race([
          Promise.resolve().then(() => adapter.probe()),
          new Promise((resolvePromise, rejectPromise) => {
            timer = setTimeout(() => {
              rejectPromise(fail(
                ADAPTER_ERROR.PROBE_INVALID,
                `适配器 ${adapter.id} 的 probe() 超过 ${probeTimeoutMs}ms 未返回（按不可用处理）`,
                { adapterId: adapter.id, field: 'probe', reason: 'timeout', timeoutMs: probeTimeoutMs },
              ))
            }, probeTimeoutMs)
          }),
        ])
        const normalized = normalizeProbeResult(adapter.id, probe)
        results.push({ id: adapter.id, ok: true, version: normalized.version, helpDigest: normalized.helpDigest })
      } catch (error) {
        results.push({
          id: adapter.id,
          ok: false,
          error: {
            code: error && typeof error.code === 'string' ? error.code : ADAPTER_ERROR.PROBE_INVALID,
            message: errorText(error),
          },
        })
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }
    return results
  }

  return { register, get, list, probeAll }
}
