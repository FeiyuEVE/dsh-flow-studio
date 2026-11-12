/**
 * ACP 无人值守配置与权限判定（0.15 ACP P3，纯逻辑）。
 *
 * 三条边界：
 *   1. **配置来源唯一**：宿主环境变量 `FLOW_STUDIO_ACP_CONFIG`，值是 JSON
 *      `{command,args,env,mode,permissionPolicy}`。不读实例字段、不做 shell 拼接、
 *      不自动 npx 下载。未知键 / 非法 JSON / 类型错误一律 `ACP_CONFIG_INVALID`。
 *      解析失败只返回结构化错误（不回显原始 JSON），工厂可以先保留错误，等 probe
 *      再拒绝，不影响插件加载。
 *   2. **模式必须真实可用**：`selectAcpMode` 只接受 `availableModes` 里存在的 id，
 *      找不到就是 `ACP_MODE_UNAVAILABLE`，绝不回退到更宽的模式。
 *   3. **权限只做最小授权**：`permissionPolicy:'deny'` 只选 `reject_once`，
 *      `:'allow'` 只选 `allow_once`；**永不**选 `allow_always` / `reject_always`，
 *      也**不读** `option.name` 推断授权。无匹配 / 已取消 / session 不匹配都回
 *      `{outcome:{outcome:'cancelled'}}`，回包 optionId 原样。
 *
 * @module @feiyueve/dsh/dsh-flow-studio/acp-policy
 */

import { redactText } from './process-output.js'

/** ACP 配置的唯一环境变量名。 */
export const ACP_CONFIG_ENV = 'FLOW_STUDIO_ACP_CONFIG'

/** 配置非法（JSON / 未知键 / 类型 / 值域）。 */
export const ACP_CONFIG_INVALID = 'ACP_CONFIG_INVALID'

/** 请求的 mode 不在 `availableModes` 里。 */
export const ACP_MODE_UNAVAILABLE = 'ACP_MODE_UNAVAILABLE'

/** 允许的权限策略；默认 deny。 */
export const ACP_PERMISSION_POLICIES = Object.freeze(['deny', 'allow'])

/** 默认配置（每次返回新副本，调用方可以安全改写）。 */
export const DEFAULT_ACP_CONFIG = Object.freeze({
  command: 'codex-acp',
  args: Object.freeze([]),
  env: Object.freeze({}),
  mode: 'workspace-write',
  permissionPolicy: 'deny',
})

const ALLOWED_CONFIG_KEYS = new Set(['command', 'args', 'env', 'mode', 'permissionPolicy'])
const FORBIDDEN_ENV_PREFIX = 'FLOW_STUDIO_FINISH_'
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_MODE_BYTES = 128

/** 判定普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 新默认配置副本。 */
function defaultConfig() {
  return {
    command: DEFAULT_ACP_CONFIG.command,
    args: [...DEFAULT_ACP_CONFIG.args],
    env: { ...DEFAULT_ACP_CONFIG.env },
    mode: DEFAULT_ACP_CONFIG.mode,
    permissionPolicy: DEFAULT_ACP_CONFIG.permissionPolicy,
  }
}

/** 统一的结构化错误（不回显原始配置内容）。 */
function failure(code, message, extra = {}) {
  return { ok: false, code, message, error: { code, message }, ...extra }
}

/** 配置值诊断里的短字符串：脱敏 + 限长，不把原始 JSON 带出去。 */
function safeLabel(value, limit = 64) {
  let text
  try {
    text = redactText(typeof value === 'string' ? value : String(value ?? ''))
  } catch {
    text = '[unavailable]'
  }
  return text.slice(0, limit)
}

/** 非空、无控制字符的字符串。 */
function isUsableString(value) {
  return typeof value === 'string' && value.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * 解析宿主环境变量里的 ACP 配置 JSON。
 *
 * - 省略 / `null` / 空串 → 默认配置；
 * - 未知键、非法 JSON、类型或值域错误 → `{ok:false, code:'ACP_CONFIG_INVALID'}`；
 * - 成功 → `{ok:true, config:{command,args,env,mode,permissionPolicy}}`。
 *
 * 失败结果只含结构化 message，绝不包含原始 JSON 文本。
 *
 * @param {unknown} [rawJson] 环境变量原始值；省略时读取 `process.env.FLOW_STUDIO_ACP_CONFIG`。
 * @returns {{ok:true, config:object}|{ok:false, code:string, message:string, error:object}}
 */
export function parseAcpConfig(rawJson) {
  const raw = rawJson === undefined ? process.env?.[ACP_CONFIG_ENV] : rawJson
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, config: defaultConfig() }
  }
  if (typeof raw !== 'string') {
    return failure(ACP_CONFIG_INVALID, `${ACP_CONFIG_ENV} 必须是 JSON 字符串`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return failure(ACP_CONFIG_INVALID, `${ACP_CONFIG_ENV} 不是合法 JSON`)
  }
  if (!isPlainObject(parsed)) {
    return failure(ACP_CONFIG_INVALID, `${ACP_CONFIG_ENV} 必须是 JSON 对象`)
  }
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      return failure(ACP_CONFIG_INVALID, `不支持的配置键：${safeLabel(key)}`)
    }
  }

  const config = defaultConfig()

  if (Object.prototype.hasOwnProperty.call(parsed, 'command')) {
    if (!isUsableString(parsed.command)) {
      return failure(ACP_CONFIG_INVALID, 'command 必须是非空字符串（可执行名或路径）')
    }
    config.command = parsed.command
  }

  if (Object.prototype.hasOwnProperty.call(parsed, 'args')) {
    if (!Array.isArray(parsed.args)) {
      return failure(ACP_CONFIG_INVALID, 'args 必须是字符串数组')
    }
    for (const [index, arg] of parsed.args.entries()) {
      if (typeof arg !== 'string' || /[\u0000]/.test(arg)) {
        return failure(ACP_CONFIG_INVALID, `args[${index}] 必须是字符串且不含 NUL`)
      }
    }
    config.args = [...parsed.args]
  }

  if (Object.prototype.hasOwnProperty.call(parsed, 'env')) {
    if (!isPlainObject(parsed.env)) {
      return failure(ACP_CONFIG_INVALID, 'env 必须是字符串值对象')
    }
    const env = {}
    for (const [name, value] of Object.entries(parsed.env)) {
      if (!ENV_NAME_PATTERN.test(name) || name === '__proto__' || name === 'constructor' || name === 'prototype') {
        return failure(ACP_CONFIG_INVALID, `env 变量名不合法：${safeLabel(name)}`)
      }
      if (name.toUpperCase().startsWith(FORBIDDEN_ENV_PREFIX)) {
        return failure(ACP_CONFIG_INVALID, `env 不允许覆盖内部变量：${safeLabel(name)}`)
      }
      if (typeof value !== 'string' || value.includes('\u0000')) {
        return failure(ACP_CONFIG_INVALID, `env.${safeLabel(name)} 必须是字符串且不含 NUL`)
      }
      env[name] = value
    }
    config.env = env
  }

  if (Object.prototype.hasOwnProperty.call(parsed, 'mode')) {
    if (!isUsableString(parsed.mode) || parsed.mode.length > MAX_MODE_BYTES) {
      return failure(ACP_CONFIG_INVALID, `mode 必须是非空字符串（≤${MAX_MODE_BYTES} 字符）`)
    }
    config.mode = parsed.mode
  }

  if (Object.prototype.hasOwnProperty.call(parsed, 'permissionPolicy')) {
    if (parsed.permissionPolicy !== 'deny' && parsed.permissionPolicy !== 'allow') {
      return failure(ACP_CONFIG_INVALID, "permissionPolicy 只接受 'deny' 或 'allow'")
    }
    config.permissionPolicy = parsed.permissionPolicy
  }

  return { ok: true, config }
}

/**
 * 从 ACP 会话可用模式里选出请求的 mode。
 *
 * @param {unknown} modes `session/new` 响应的 `modes`（含 `availableModes`），
 *   或直接传 `availableModes` 数组。
 * @param {unknown} requested 请求的 mode id（精确匹配）。
 * @returns {{ok:true, modeId:string, mode:object}|{ok:false, code:string, message:string, error:object, availableModeIds:string[]}}
 */
export function selectAcpMode(modes, requested) {
  let available = null
  if (Array.isArray(modes)) available = modes
  else if (isPlainObject(modes) && Array.isArray(modes.availableModes)) available = modes.availableModes
  if (available === null) {
    return failure(ACP_MODE_UNAVAILABLE, '会话没有声明 availableModes，无法选择 mode', { availableModeIds: [] })
  }
  const ids = []
  let matched = null
  for (const entry of available) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || entry.id === '') continue
    ids.push(safeLabel(entry.id, MAX_MODE_BYTES))
    if (matched === null && typeof requested === 'string' && entry.id === requested) matched = entry
  }
  if (matched === null) {
    const detail = ids.length === 0 ? '可用模式为空' : `可用模式：${ids.join('、')}`
    const message = typeof requested === 'string' && requested !== ''
      ? `请求的 mode ${safeLabel(requested, MAX_MODE_BYTES)} 不在 availableModes 里（${detail}）`
      : `没有请求任何 mode（${detail}）`
    return failure(ACP_MODE_UNAVAILABLE, message, { availableModeIds: ids })
  }
  const mode = { id: matched.id }
  if (typeof matched.name === 'string' && matched.name !== '') mode.name = safeLabel(matched.name, 64)
  return { ok: true, modeId: matched.id, mode }
}

/**
 * 为 `session/request_permission` 计算回包。
 *
 * 授权规则（方案 P3）：
 *   - `policy:'deny'` → 只选 `reject_once`；
 *   - `policy:'allow'` → 只选 `allow_once`；
 *   - 永不选 `allow_always` / `reject_always`，也不看 `option.name`；
 *   - 已取消、session 不匹配、无可选 option → `{outcome:{outcome:'cancelled'}}`。
 *
 * @param {unknown} params ACP 权限请求参数 `{sessionId, toolCall, options}`。
 * @param {{policy?: string, cancelled?: boolean, sessionId?: string}} [context]
 * @returns {{outcome:{outcome:'selected', optionId:string}|{outcome:'cancelled'}}}
 */
export function chooseAcpPermission(params, { policy, cancelled, sessionId } = {}) {
  const cancelledResult = { outcome: { outcome: 'cancelled' } }
  if (cancelled) return cancelledResult
  if (!isPlainObject(params)) return cancelledResult
  // session 必须能核对；调用方漏传或请求来自别的 session 一律取消。
  if (typeof sessionId !== 'string' || sessionId === '') return cancelledResult
  if (typeof params.sessionId !== 'string' || params.sessionId !== sessionId) return cancelledResult
  if (!Array.isArray(params.options)) return cancelledResult

  const wantedKind = policy === 'allow' ? 'allow_once' : 'reject_once'
  for (const option of params.options) {
    if (!isPlainObject(option)) continue
    if (option.kind !== wantedKind) continue
    if (typeof option.optionId !== 'string' || option.optionId === '') continue
    // optionId 原样回传：不 trim、不截断、不改写。
    return { outcome: { outcome: 'selected', optionId: option.optionId } }
  }
  return cancelledResult
}
