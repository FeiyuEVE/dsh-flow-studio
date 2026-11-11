/**
 * 节点检查配置（`node.check`）的边界与归一化：**中性模块**，不依赖旧流程模型。
 *
 * 这些是**保存时**就归一化 / 校验的硬边界；运行期报告大小等边界在
 * `host-check.js`（默认 1MiB）。旧 `model.js` 已随 0.14.0 退役，这里只保留
 * 宿主检查能力仍然需要的配置契约。
 *
 * @module @feiyueve/dsh-flow-studio/node-check
 */

/** 诊断值收敛时的深度 / 键数上限（只用于把非法输入变成可读诊断）。 */
const DIAG_DEPTH = 3
const DIAG_KEYS = 16

/**
 * 把一个任意值收敛成「JSON 可序列化的原始值」：函数、undefined、NaN、BigInt、
 * Symbol、类实例、循环引用、超深嵌套一律返回 undefined（丢弃）。
 */
function jsonSafeValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'object') return undefined
  if (depth >= DIAG_DEPTH || seen.has(value)) return undefined
  if (Array.isArray(value)) {
    seen.add(value)
    try {
      const out = []
      for (const entry of value.slice(0, DIAG_KEYS)) {
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
      if (count >= DIAG_KEYS) break
      if (typeof key !== 'string' || key.length === 0 || key.length > 64) continue
      const safe = jsonSafeValue(value[key], depth + 1, seen)
      if (safe === undefined) return undefined
      Object.defineProperty(out, key, { value: safe, enumerable: true, configurable: true, writable: true })
      count += 1
    }
    return out
  } catch {
    return undefined
  } finally {
    seen.delete(value)
  }
}

export const CHECK_LIMITS = Object.freeze({
  /** command 的最大字符数（按 UTF-16 码元）。 */
  commandLen: 2000,
  /** expectExitCode 的取值范围：POSIX 退出码 0–255。 */
  exitMin: 0,
  exitMax: 255,
  /** timeoutMs 的默认值与取值范围（毫秒）。 */
  timeoutDefault: 600000,
  timeoutMin: 1000,
  timeoutMax: 1800000,
  /** reportPath 的最大字符数。 */
  reportPathLen: 512,
})

/** 人类可读的类型名：中文错误消息里用来指出「当前是什么」。 */
function describeType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  if (typeof value === 'object') return '对象'
  const labels = {
    string: '字符串',
    number: '数字',
    boolean: '布尔值',
    bigint: 'BigInt',
    symbol: 'Symbol',
    function: '函数',
    undefined: '未定义',
  }
  return labels[typeof value] || typeof value
}

/** 读字段时容忍抛错的 getter：坏数据只能被诊断，不能把 normalize 带崩。 */
function readFieldSafe(source, key) {
  try {
    return source[key]
  } catch {
    return undefined
  }
}

/**
 * 把任意值收敛成 JSON 安全的诊断值；无法序列化的类型退成 `false`
 * （保持「非法」状态，避免被默认值洗成合法配置）。
 */
function diagnosticValue(value) {
  const safe = jsonSafeValue(value)
  return safe === undefined ? false : safe
}

/** 非对象 check 的统一诊断消息。 */
function checkShapeMessage(value) {
  return `检查配置（check）必须是对象，形如 {"command":"npm test"}；当前是${describeType(value)}。`
}

/**
 * 归一化节点检查命令（R5 / 0.11 §7.1）。
 *
 * 契约：
 *   - `undefined` / `null` → `null`（= 未配置，节点上不挂 check 字段）；
 *   - 合法配置 → `{ command, expectExitCode, timeoutMs, reportPath? }`，缺省值补齐；
 *   - **非法配置不会被丢成「未配置」**：字段值原样保留（非 JSON 安全类型保留成
 *     `false` 这类明显非法值），并让 `validateNodeCheck` 能指出具体字段。这样保存
 *     半成品不会被静默当成「没有检查」，启动前校验也拦得住。
 *   - command 超长时**不截短**：截短后再拿去做检查等于执行了另一条命令。
 *
 * 旧版本的 `extras.check` 不会被升级成这里的可执行配置（见 normalizeFlow）。
 *
 * @param {unknown} raw
 * @returns {{command:string, expectExitCode:unknown, timeoutMs:unknown, reportPath?:unknown, shapeError?:string}|null}
 */
export function normalizeNodeCheck(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      command: '',
      expectExitCode: CHECK_LIMITS.exitMin,
      timeoutMs: CHECK_LIMITS.timeoutDefault,
      shapeError: checkShapeMessage(raw),
    }
  }
  let proto
  try {
    proto = Object.getPrototypeOf(raw)
  } catch {
    proto = undefined
  }
  if (proto !== Object.prototype && proto !== null) {
    return {
      command: '',
      expectExitCode: CHECK_LIMITS.exitMin,
      timeoutMs: CHECK_LIMITS.timeoutDefault,
      shapeError: checkShapeMessage(raw),
    }
  }

  const rawCommand = readFieldSafe(raw, 'command')
  const command = typeof rawCommand === 'string'
    ? rawCommand
    : rawCommand === undefined || rawCommand === null ? '' : diagnosticValue(rawCommand)

  const rawExit = readFieldSafe(raw, 'expectExitCode')
  const expectExitCode = rawExit === undefined || rawExit === null
    ? CHECK_LIMITS.exitMin
    : diagnosticValue(rawExit)

  const rawTimeout = readFieldSafe(raw, 'timeoutMs')
  const timeoutMs = rawTimeout === undefined || rawTimeout === null
    ? CHECK_LIMITS.timeoutDefault
    : diagnosticValue(rawTimeout)

  const check = { command, expectExitCode, timeoutMs }
  const rawReportPath = readFieldSafe(raw, 'reportPath')
  if (rawReportPath !== undefined && rawReportPath !== null && rawReportPath !== '') {
    check.reportPath = typeof rawReportPath === 'string'
      ? rawReportPath
      : diagnosticValue(rawReportPath)
  }
  return check
}

/**
 * 校验报告路径：只接受工作区内的安全相对普通文件路径。
 * @returns {string|null} null = 合法；否则是中文原因。
 */
function describeUnsafeReportPath(value) {
  if (value.length > CHECK_LIMITS.reportPathLen) {
    return `报告路径（reportPath）不能超过 ${CHECK_LIMITS.reportPathLen} 字符（当前 ${value.length}）。`
  }
  if (value.includes('\u0000')) {
    return '报告路径（reportPath）不能包含 NUL 字符。'
  }
  if (/[\u0001-\u001f\u007f]/.test(value)) {
    return '报告路径（reportPath）不能包含控制字符。'
  }
  if (value.trim() === '') {
    return '报告路径（reportPath）不能为空：要么不填，要么给一个相对文件路径（如 reports/unit.json）。'
  }
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    return `报告路径（reportPath）不能是 UNC 路径（「${value}」）：只接受工作区内的相对路径。`
  }
  if (/^[A-Za-z]:/.test(value)) {
    return `报告路径（reportPath）不能是 Windows 盘符路径（「${value}」）：只接受工作区内的相对路径。`
  }
  if (value.includes('\\')) {
    return '报告路径（reportPath）不能用反斜杠分隔：请写成 reports/unit.json 这样的相对路径。'
  }
  if (value.startsWith('/')) {
    return `报告路径（reportPath）不能是绝对路径（「${value}」）：只接受工作区内的相对路径。`
  }
  const parts = value.split('/')
  for (const part of parts) {
    if (part === '') {
      return `报告路径（reportPath）不能出现空路径段（「${value}」）：不要用 a//b 或结尾的 /。`
    }
    if (part === '.' || part === '..') {
      return `报告路径（reportPath）不能包含「${part}」路径段（「${value}」）：禁止穿越出工作区。`
    }
  }
  return null
}

/**
 * 校验归一化后的检查配置。
 *
 * 保存前 / 启动前都调用它：返回 `{ok:true}`，或 `{ok:false, field, message}`。
 * `field` 精确到 `check` 的子字段（`command` / `expectExitCode` / `timeoutMs` /
 * `reportPath`），宿主可据此拼出 `nodes[i].check.<field>` 定位与可行动中文原因。
 *
 * @param {unknown} check
 * @returns {{ok:true}|{ok:false, field:string, message:string}}
 */
export function validateNodeCheck(check) {
  if (check === undefined || check === null) {
    return { ok: false, field: 'check', message: '没有检查配置（check）：要么不配置检查，要么至少给一个 command。' }
  }
  if (typeof check !== 'object' || Array.isArray(check)) {
    return { ok: false, field: 'check', message: checkShapeMessage(check) }
  }
  if (typeof check.shapeError === 'string' && check.shapeError !== '') {
    return { ok: false, field: 'check', message: check.shapeError }
  }

  // 调用方可能传原始的、未归一化的对象（例如 HTTP 请求体）；统一补齐缺省值。
  const normalized = normalizeNodeCheck(check)
  if (!normalized || typeof normalized !== 'object') {
    return { ok: false, field: 'check', message: checkShapeMessage(check) }
  }

  if (typeof normalized.command !== 'string') {
    return {
      ok: false,
      field: 'command',
      message: `检查命令（command）必须是字符串，当前是${describeType(normalized.command)}：示例 "npm test"。`,
    }
  }
  if (normalized.command.trim() === '') {
    return { ok: false, field: 'command', message: '检查命令（command）不能为空：请填写要执行的命令，例如 "npm test"。' }
  }
  if (normalized.command.length > CHECK_LIMITS.commandLen) {
    return {
      ok: false,
      field: 'command',
      message: `检查命令（command）不能超过 ${CHECK_LIMITS.commandLen} 字符（当前 ${normalized.command.length}）：请把长逻辑放进脚本文件，命令里只调用脚本。`,
    }
  }
  if (normalized.command.includes('\u0000')) {
    return { ok: false, field: 'command', message: '检查命令（command）不能包含 NUL 字符。' }
  }

  if (!Number.isInteger(normalized.expectExitCode)
    || normalized.expectExitCode < CHECK_LIMITS.exitMin
    || normalized.expectExitCode > CHECK_LIMITS.exitMax) {
    return {
      ok: false,
      field: 'expectExitCode',
      message: `期望退出码（expectExitCode）必须是 ${CHECK_LIMITS.exitMin}–${CHECK_LIMITS.exitMax} 的整数，当前是${describeType(normalized.expectExitCode)}值 ${String(normalized.expectExitCode)}。`,
    }
  }

  if (!Number.isInteger(normalized.timeoutMs)
    || normalized.timeoutMs < CHECK_LIMITS.timeoutMin
    || normalized.timeoutMs > CHECK_LIMITS.timeoutMax) {
    return {
      ok: false,
      field: 'timeoutMs',
      message: `检查超时（timeoutMs）必须是 ${CHECK_LIMITS.timeoutMin}–${CHECK_LIMITS.timeoutMax} 的整数毫秒，当前是${describeType(normalized.timeoutMs)}值 ${String(normalized.timeoutMs)}。`,
    }
  }

  if (normalized.reportPath !== undefined) {
    if (typeof normalized.reportPath !== 'string') {
      return {
        ok: false,
        field: 'reportPath',
        message: `报告路径（reportPath）必须是字符串，当前是${describeType(normalized.reportPath)}：示例 "reports/unit.json"。`,
      }
    }
    const pathError = describeUnsafeReportPath(normalized.reportPath)
    if (pathError) return { ok: false, field: 'reportPath', message: pathError }
  }

  return { ok: true }
}
