/**
 * R5（0.11 §7）宿主检查执行器：把**保存的**节点检查命令变成一次可核验的宿主执行。
 *
 * 职责边界：
 *   1. 静态命令 → 固定 argv：`sh -c <保存的完整 command>`。整条命令是**一个 argv 元素**，
 *      不 split、不做 `{prompt}` 模板替换、不读 stdin、不插值、不拼 run inputs；
 *   2. 起进程 + 有界输出 + 超时 / 取消 / 杀进程组；
 *   3. 报告采集：执行前 fingerprint、执行后要求新建 / 更新、安全打开（O_NOFOLLOW、
 *      非阻塞、fstat 确认普通文件）、有界读（limit+1）、前后 fstat 一致，算 sha256；
 *   4. 返回**已脱敏、有界**的纯数据结果；不写事件、不写 run 目录、不碰存储。
 *
 * 依赖：`node:child_process` / `node:fs` / `node:path` / `node:crypto`，外加纯函数
 * `model.js` 的配置归一化 / 校验。**不 import** engine / runtime / index / runstore /
 * evidence，也不直接 append 日志或产物。
 *
 * 配置非法时的选择（两种都明确写在契约里，这里选「skipped + HOST_CHECK_INVALID」）：
 *   - `buildHostCheckInvocation`：抛 `Error`，`code='HOST_CHECK_INVALID'`、带 `field`；
 *   - `runHostCheck`：**不抛**，返回 `state='skipped', reasonCode='HOST_CHECK_INVALID'`，
 *     `message` 是中文可行动原因。这样引擎无需在 await 两侧包 try/catch，也不会把
 *     「配置错」误记成「执行失败」。
 *
 * 结果对象（字段稳定，调用方可以直接持久化执行记录）：
 * ```
 * {
 *   state: 'pass'|'fail'|'skipped',
 *   reasonCode: string|null, exitCode: number|null, expectedExitCode: number,
 *   durationMs: number, truncated: boolean, outputTail: string,
 *   receivedBytes: number,
 *   reportPath: string|null,          // 保存配置里的相对路径（不回显绝对路径）
 *   reportSha256: string|null,        // 绑定下面这份**已脱敏**最终副本字节（F3）
 *   reportBytes: Buffer|null,         // 报告字节的**已脱敏独立副本**（可直接写进公开目录）
 *   reportByteLength: number,         // 最终副本字节数（脱敏后长度）
 *   reportOpaque: boolean,            // true = 非 UTF-8/二进制报告：副本已按字节脱敏，但不可当文本解析
 *   killScope: 'group'|'process'|null, orphanWarning: string|null,
 *   startedAt: string, finishedAt: string, message: string|null,
 * }
 * ```
 * `reportBytes` 是 Buffer 而不是数字：报告采集器只返回「内容 + fingerprint」，
 * 由 Engine / runstore 决定写到哪里；`reportSha256` 永远对这份副本计算。
 *
 * 本模块防的是「事件 / 产物自报洗白」，不是同 uid 敌对进程隔离：宿主与模型同 OS 用户，
 * 文件权限不构成安全边界（见 0.11 §7.3）。
 *
 * @module @feiyueve/dsh-flow-studio/host-check
 */

import { ChildProcess, spawn as spawnProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { CHECK_LIMITS, normalizeNodeCheck, validateNodeCheck } from './model.js'

/** 检查结果三态：pass / fail / skipped（skipped 在聚合里按 unknown 处理）。 */
export const HOST_CHECK_STATE = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  SKIPPED: 'skipped',
})

/**
 * reasonCode 的唯一枚举。与 0.11 §7.4 的错误码表同口径：
 * - fail：EXIT / SPAWN / TIMEOUT / OUTPUT_LIMIT / REPORT_MISSING / REPORT_STALE /
 *   REPORT_INVALID / REPORT_TOO_LARGE；
 * - skipped：CANCELLED / UNAVAILABLE / INVALID。
 */
export const HOST_CHECK_REASON = Object.freeze({
  EXIT: 'HOST_CHECK_EXIT',
  SPAWN: 'HOST_CHECK_SPAWN',
  TIMEOUT: 'HOST_CHECK_TIMEOUT',
  OUTPUT_LIMIT: 'OUTPUT_LIMIT',
  CANCELLED: 'HOST_CHECK_CANCELLED',
  UNAVAILABLE: 'HOST_CHECK_UNAVAILABLE',
  INVALID: 'HOST_CHECK_INVALID',
  REPORT_MISSING: 'HOST_CHECK_REPORT_MISSING',
  REPORT_STALE: 'HOST_CHECK_REPORT_STALE',
  REPORT_INVALID: 'HOST_CHECK_REPORT_INVALID',
  REPORT_TOO_LARGE: 'HOST_CHECK_REPORT_TOO_LARGE',
})

/** 输出 / 报告默认上限（0.11 §7.4：1MiB）。 */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_MAX_REPORT_BYTES = 1024 * 1024

/** outputTail 的硬上限：16KiB（脱敏后再裁剪）。 */
const OUTPUT_TAIL_BYTES = 16 * 1024

/** SIGTERM → SIGKILL 的宽限期，与 executor.js 一致。 */
const KILL_GRACE_MS = 250

/** Windows 没有 POSIX 进程组；显式降级并留 orphanWarning。 */
const CAN_DETACH = process.platform !== 'win32'

/**
 * 环境变量里视为「认证凭据」的键：只剔除这些，保留 PATH / 项目变量与
 * DSH_* / FLOW_STUDIO_*（0.11 §7.1 明确要求不粗暴删除全部）。
 */
const SENSITIVE_ENV_KEY = /^(?:.*_)?(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY(?:_ID)?|SECRET_KEY|PRIVATE_KEY|CREDENTIALS?|AUTHORIZATION|COOKIE|SESSION_KEY|SSH_KEY)$/i

/** 构造带 code 的非法配置错误（与 executor 的 EXECUTOR_INVALID 同一风格）。 */
function hostCheckInvalid(field, message) {
  const error = new Error(`检查配置不合法（check.${field}）：${message}`)
  error.name = 'HostCheckInvalidError'
  error.code = HOST_CHECK_REASON.INVALID
  error.field = field
  return error
}

/**
 * 命令行里「带值」的敏感参数名（`--token <value>` / `--api-key=<value>` 等）。
 *
 * 参数名必须是**完整**的：名字后面只接受空白或 `=`，因此 `--token-file`、`--tokenize`、
 * `--tokens` 不会被当成 `--token`，它们后面的普通文件名/参数也不会被吞掉。值只吃
 * 一个 shell 词（引号内可含空格），后面的正常参数（URL、report.json 等）原样保留。
 *
 * 导出 pattern 字符串（而不是带 `g` 的 RegExp 实例）供同源规则复用：带 `g` 的对象
 * 在 `test`/`exec` 之间共享 `lastIndex`，跨模块复用会埋并发/顺序 bug。
 */
export const SECRET_FLAG_PATTERN = `(^|[\\s"'\`;|&(=,\\[])(--?(?:token|password|passwd|secret|api[_-]?key|access[_-]?(?:token|key)|auth[_-]?token|secret[_-]?key|private[_-]?key|credentials?|authorization|cookie|session[_-]?key|ssh[_-]?key))(\\s*=\\s*|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s"'\`;|&)]+))`

/** 本模块内部使用的敏感参数规则（`replace` 会重置 `lastIndex`，模块内单线程安全）。 */
const SECRET_FLAG = new RegExp(SECRET_FLAG_PATTERN, 'gi')

/**
 * 高置信凭据规则（1–4）：Bearer / Basic / Token + sk- + 敏感命令行参数 + key:value。
 *
 * 这些规则都基于**明确的凭据形态**，不是长度启发式，因此可以安全地作用在不可判读的
 * 二进制字节上（按 latin1 逐字节映射后只替换命中的 ASCII 段，其余字节不变）。
 *
 * @param {string} text
 * @returns {string}
 */
function redactHighConfidence(text) {
  let out = text
  // 1) Authorization 头里的认证方案 + 凭据（凭据两侧的引号必须成对，不能吞掉外层引号）
  out = out.replace(
    /\b(Bearer|Basic|Token)\s+(?:"[A-Za-z0-9._~+/=-]{4,}"|'[A-Za-z0-9._~+/=-]{4,}'|[A-Za-z0-9._~+/=-]{4,})/gi,
    '$1 [REDACTED]',
  )
  // 2) sk- 开头的 API key（保留前缀给排查看，值抹掉）
  out = out.replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-[REDACTED]')
  // 3) 空格/等号分隔的命令行参数：--token <value> / --api-key=<value> / -H ... 等。
  //    参数名后必须是空白或 =，所以 --token-file 不会被误判；值只吃一个 shell 词。
  out = out.replace(SECRET_FLAG, (match, lead, flag, separator, doubleQuoted, singleQuoted) => {
    if (doubleQuoted !== undefined) return `${lead}${flag}${separator}"[REDACTED]"`
    if (singleQuoted !== undefined) return `${lead}${flag}${separator}'[REDACTED]'`
    return `${lead}${flag}${separator}[REDACTED]`
  })
  // 4) key: value / key=value / "key": "value" 形式（；，也算分隔符，中文句子里的多组凭据才不会漏）
  out = out.replace(
    /(["']?(?:token|password|passwd|secret|api[_-]?key|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}；，]+)/gi,
    (match, prefix, value) => {
      if (/^(?:Bearer|Basic|Token)$/i.test(String(value).replace(/["']/g, ''))) return match
      return `${prefix}"[REDACTED]"`
    },
  )
  return out
}

/**
 * 与环境无关的保守脱敏：高置信规则 + ≥32 连续可疑串。
 *
 * 与 engine 的 `redactArguments` 同源的文本规则，额外补齐「空格 / 引号」形态：
 *   - `--token <value>`、`--api-key <value>`、`--token=<value>`（值可带引号）；
 *   - `-H "Authorization: Bearer <value>"` / `Authorization: Basic <value>`。
 *
 * 只用于**可判读文本**（outputTail / 文本报告副本）。二进制报告只跑
 * `redactHighConfidence`，不要用这里第 5 条的 ≥32 启发式——它在 PDF / 图片 /
 * 长十六进制头这类不可判读字节上会大量假阳性，把「无凭据二进制逐字节不变」的前提
 * 直接打破。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function redactSensitiveText(raw) {
  const text = typeof raw === 'string' ? raw : String(raw ?? '')
  // 5) 超长连续串（哈希 / JWT 片段 / 裸 token）：≥32 个不含空白的可疑字符。
  return redactHighConfidence(text).replace(/[A-Za-z0-9_+/=.-]{32,}/g, '[REDACTED]')
}

/**
 * 应用脱敏函数（内置规则**总是**再跑一遍）。
 *
 * `redact` 由调用方（engine 传入 `redactArguments`）提供；它是同源规则的旧副本，
 * 不认识 `--token <value>` 这类空格形态。这里在调用方规则之后**再叠加**内置规则，
 * 保证即使调用方规则较旧，outputTail / 报告副本也不会漏掉空格形态凭据。
 * 调用方函数自身抛错时只跳过它，内置规则照跑（绝不让脱敏失败带崩执行）。
 */
function applyRedact(text, redact) {
  if (typeof text !== 'string') return text
  let out = text
  if (typeof redact === 'function') {
    try {
      const value = redact(out)
      out = typeof value === 'string' ? value : String(value ?? '')
    } catch {
      out = text
    }
  }
  return redactSensitiveText(out)
}

/** 按 UTF-8 字节安全截尾：不写出半个多字节字符。 */
function tailBytes(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  return bytes.subarray(bytes.length - maxBytes).toString('utf8').replace(/^\uFFFD+/, '')
}

/** 滚动输出窗口 → 脱敏后的 outputTail（先脱敏再裁剪，避免裁出 token 前缀）。 */
function decodeOutputTail(buffer, redact) {
  if (!buffer || buffer.length === 0) return ''
  let text = buffer.toString('utf8').replace(/^\uFFFD+/, '')
  text = applyRedact(text, redact)
  return tailBytes(text, OUTPUT_TAIL_BYTES)
}

/**
 * 0.11 · F3：公开报告副本的脱敏 + 最终副本 hash。
 *
 * 报告原文件不可信（可能带 `token=canary`），本函数只在内存里处理独立副本：
 *   1. 能无损 UTF-8 往返的报告按文本脱敏（全套规则，含 ≥32 启发式）；二进制 / 非法
 *      UTF-8 报告**不原样复制**，而是把 buffer 按 latin1（1 字节 = 1 字符，完全可逆）
 *      映射后**只跑高置信规则**（Bearer/Basic/Token、sk-、`--token <值>`、key:value），
 *      把命中的凭据字节段替换成 `[REDACTED]`。**不跑** ≥32 启发式，也不用调用方的
 *      文本 redact（engine 的旧副本同样含该启发式）——PDF / 图片 / 长十六进制头在
 *      启发式下会大量假阳性，破坏「非命中字节逐字节保留」的证据前提。非命中的字节
 *      逐字节保留，因此「不含凭据的二进制报告」仍是逐字节相同的证据（sha256 不变、
 *      验证器照常通过）；公开副本同时以 `opaque:true` 标注「不可当文本解析」。
 *   2. 脱敏后的副本若与原文不同，**先**重新编码成最终副本，**再**对这份最终
 *      字节算 sha256 / 长度（顺序反了会得到源文件 hash，验证器会判不符）；
 *   3. 不写回原文件，保留调用方 cwd 里的原始报告。
 *
 * @param {Buffer|null} buffer 报告采集到的独立字节副本
 * @param {(text: string) => string} [redact]
 * @returns {{ buffer: Buffer|null, sha256: string|null, bytes: number, opaque: boolean }}
 */
function redactReportCopy(buffer, redact) {
  if (!Buffer.isBuffer(buffer)) return { buffer: null, sha256: null, bytes: 0, opaque: false }
  const finalize = (bytes, opaque = false) => ({
    buffer: bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    opaque,
  })
  if (buffer.length === 0) return finalize(buffer)
  const text = buffer.toString('utf8')
  if (Buffer.from(text, 'utf8').equals(buffer)) {
    const redacted = applyRedact(text, redact)
    if (redacted === text) return finalize(buffer)
    return finalize(Buffer.from(redacted, 'utf8'))
  }
  // 二进制 / 非法 UTF-8：latin1 1:1 映射保证除凭据段外的字节完全不变。
  // 只用高置信规则：任何长度启发式都会在真实二进制上误伤非凭据字节。
  const latin1 = buffer.toString('latin1')
  const redacted = redactHighConfidence(latin1)
  if (redacted === latin1) return finalize(buffer, true)
  return finalize(Buffer.from(redacted, 'latin1'), true)
}

/** 单行消息的兜底长度，避免把整段 stderr / 异常栈塞进结果。 */
function clipMessage(text, max = 400) {
  const chars = Array.from(String(text ?? ''))
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** 错误文本（脱敏前的原始形态；脱敏在 finish 统一做）。 */
function errorText(error) {
  if (!error) return '未知错误'
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/** 过滤环境变量：保留 PATH / 项目变量，只剔除认证凭据类键。 */
export function filterHostCheckEnv(env = process.env) {
  const out = {}
  if (!env || typeof env !== 'object') return out
  for (const key of Object.keys(env)) {
    if (SENSITIVE_ENV_KEY.test(key)) continue
    const value = env[key]
    if (typeof value !== 'string') continue
    out[key] = value
  }
  return out
}

/**
 * 静态命令 → 固定 argv（R5 / 0.11 §7.1）。
 *
 * 返回 `{ file:'sh', argv:['-c', command], cwd, shell:false }`。命令是**一个** argv
 * 元素：`echo a; rm -rf b` 不会被本函数拆成两条命令、也不会被插值——它只是原样交给
 * `sh -c` 的脚本文本（配置本身就是「全权命令」，shell 语义是它明确的能力，不是沙箱）。
 *
 * @param {unknown} check 归一化或原始 check
 * @param {{cwd?: string}} [options]
 * @returns {{file:'sh', argv:['-c', string], cwd: string, shell: false}}
 * @throws {{code:'HOST_CHECK_INVALID', field:string, message:string}}
 */
export function buildHostCheckInvocation(check, options = {}) {
  const normalized = check && typeof check === 'object' && typeof check.shapeError === 'string'
    ? check
    : normalizeNodeCheck(check)
  const verdict = validateNodeCheck(normalized)
  if (!verdict.ok) throw hostCheckInvalid(verdict.field, verdict.message)
  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd()
  return { file: 'sh', argv: ['-c', normalized.command], cwd, shell: false }
}

/** 解析 reportPath：必须落在 root 内，否则返回 null。 */
function containedTarget(root, reportPath) {
  const target = resolve(root, reportPath)
  const rel = relative(root, target)
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
  return { target, rel }
}

/**
 * 拒绝全路径链上的软链（中间目录与最终文件都查）。
 * @returns {string|null} null = 路径链干净
 */
function symlinkChainError(root, rel) {
  let current = root
  for (const part of rel.split('/')) {
    current = join(current, part)
    let st
    try {
      st = lstatSync(current)
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      return `无法检查报告路径「${rel}」：${error && error.code ? String(error.code) : '读取失败'}。`
    }
    if (st.isSymbolicLink()) {
      return `报告路径「${rel}」经过符号链接「${part}」：只接受工作区内真实的普通文件路径。`
    }
  }
  return null
}

/** 安全打开报告：O_NOFOLLOW 防最终段软链，O_NONBLOCK 防 FIFO 永久挂住。 */
function openReportFile(target) {
  let flags = constants.O_RDONLY
  if (constants.O_NOFOLLOW) flags |= constants.O_NOFOLLOW
  if (constants.O_NONBLOCK) flags |= constants.O_NONBLOCK
  return openSync(target, flags)
}

/**
 * 有界读：最多读 limit+1 字节。超过 limit 返回 tooLarge（不截短后判通过）。
 * @returns {{buffer?:Buffer, bytes?:number, tooLarge?:boolean, error?:unknown}}
 */
function readBounded(fd, limit) {
  const capacity = limit + 1
  let buffer
  try {
    buffer = Buffer.allocUnsafe(capacity)
  } catch (error) {
    return { error }
  }
  let total = 0
  while (total < capacity) {
    let read
    try {
      read = readSync(fd, buffer, total, capacity - total, null)
    } catch (error) {
      return { error }
    }
    if (read <= 0) break
    total += read
  }
  if (total > limit) return { tooLarge: true, bytes: total }
  return { buffer: Buffer.from(buffer.subarray(0, total)), bytes: total }
}

/**
 * 报告 fingerprint：普通文件、非软链、size/mtimeNs/ctimeNs/inode + sha256。
 * 文件缺失是允许的（`exists:false`，本次执行可以新建它）。
 *
 * @returns {{
 *   exists:boolean, error:string|null, tooLarge:boolean,
 *   ino:bigint|null, size:bigint, mtimeNs:bigint|null, ctimeNs:bigint|null,
 *   sha256:string|null, buffer:Buffer|null, bytes:number,
 * }}
 */
function fingerprintReport(root, reportPath, maxBytes) {
  const result = {
    exists: false,
    error: null,
    tooLarge: false,
    ino: null,
    size: 0n,
    mtimeNs: null,
    ctimeNs: null,
    sha256: null,
    buffer: null,
    bytes: 0,
  }
  const info = containedTarget(root, reportPath)
  if (!info) {
    result.error = `报告路径「${reportPath}」越出了工作目录：只接受工作区内真实的普通文件路径。`
    return result
  }
  const chainError = symlinkChainError(root, info.rel)
  if (chainError) {
    result.error = chainError
    return result
  }

  let lstat
  try {
    lstat = lstatSync(info.target, { bigint: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return result
    result.error = `无法读取报告文件「${reportPath}」：${error && error.code ? String(error.code) : '读取失败'}。`
    return result
  }
  if (lstat.isSymbolicLink()) {
    result.error = `报告路径「${reportPath}」是符号链接：只接受真实的普通文件。`
    return result
  }
  if (!lstat.isFile()) {
    result.error = `报告路径「${reportPath}」不是普通文件：拒绝目录 / FIFO / socket / 设备。`
    return result
  }

  let fd = null
  try {
    fd = openReportFile(info.target)
  } catch (error) {
    result.error = `无法安全打开报告文件「${reportPath}」：${error && error.code ? String(error.code) : '打开失败'}。`
    return result
  }
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile()) {
      result.error = `报告路径「${reportPath}」在打开时不是普通文件：拒绝特殊文件。`
      return result
    }
    const read = readBounded(fd, maxBytes)
    if (read.error) {
      result.error = `读取报告文件「${reportPath}」失败：${read.error && read.error.code ? String(read.error.code) : '读取失败'}。`
      return result
    }
    const after = fstatSync(fd, { bigint: true })
    if (before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs) {
      result.error = `读取报告文件「${reportPath}」时文件发生变化：拒绝把不确定的字节当作报告。`
      return result
    }
    result.exists = true
    result.ino = after.ino
    result.size = after.size
    result.mtimeNs = after.mtimeNs
    result.ctimeNs = after.ctimeNs
    result.bytes = read.bytes
    if (read.tooLarge) {
      result.tooLarge = true
      return result
    }
    result.buffer = read.buffer
    result.sha256 = createHash('sha256').update(read.buffer).digest('hex')
    return result
  } catch (error) {
    result.error = `统计报告文件「${reportPath}」失败：${error && error.code ? String(error.code) : '读取失败'}。`
    return result
  } finally {
    try {
      closeSync(fd)
    } catch {
      // 已经关闭 / 不可关闭都不影响结果。
    }
  }
}

/** 非负整数上限；非法值退回默认。 */
function boundLimit(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/**
 * 执行一次保存的宿主检查。
 *
 * 只返回结果，不抛配置错误（非法配置 → skipped + HOST_CHECK_INVALID）。进程生命周期：
 *   - POSIX `detached:true` + `process.kill(-pid)` 杀整组（`sh -c` 派生的孙进程一起）；
 *   - Windows / 非真实 ChildProcess 降级为只杀直接子进程，并把原因写进 `killScope` /
 *     `orphanWarning`，绝不假装杀干净了；
 *   - 超时 / 取消 / 输出超限先 SIGTERM，250ms 后 SIGKILL；promise 在发起终止后立即收口，
 *     不把宿主事件循环挂在管道上。
 *
 * @param {{
 *   check: unknown,
 *   cwd?: string,
 *   spawn?: Function,
 *   signal?: AbortSignal,
 *   env?: Record<string,string>,
 *   timeoutMs?: number,
 *   maxOutputBytes?: number,
 *   maxReportBytes?: number,
 *   now?: () => number,
 *   redact?: (text: string) => string,
 * }} [options]
 * @returns {Promise<object>} 见模块头部的结果字段
 */
export async function runHostCheck(options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const {
    check,
    cwd,
    signal,
    env,
    timeoutMs,
    now = Date.now,
    redact,
  } = opts
  const spawn = typeof opts.spawn === 'function' ? opts.spawn : spawnProcess
  const maxOutputBytes = boundLimit(opts.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)
  const maxReportBytes = boundLimit(opts.maxReportBytes, DEFAULT_MAX_REPORT_BYTES)

  const clockNow = () => {
    const value = typeof now === 'function' ? now() : Date.now()
    return Number.isFinite(value) ? value : Date.now()
  }
  const startedMs = clockNow()
  const startedAt = new Date(startedMs).toISOString()
  // 配置校验通过后填真实期望值；校验失败时保持 0（结果里仍有稳定字段）。
  let resolvedExpectedExitCode = CHECK_LIMITS.exitMin

  const baseResult = () => ({
    state: HOST_CHECK_STATE.FAIL,
    reasonCode: null,
    exitCode: null,
    expectedExitCode: resolvedExpectedExitCode,
    durationMs: 0,
    truncated: false,
    outputTail: '',
    receivedBytes: 0,
    reportPath: null,
    reportSha256: null,
    reportBytes: null,
    reportByteLength: 0,
    reportOpaque: false,
    killScope: null,
    orphanWarning: null,
    startedAt,
    finishedAt: startedAt,
    message: null,
  })
  const settle = (state, reasonCode, extra = {}) => {
    const finishedMs = clockNow()
    return {
      ...baseResult(),
      state,
      reasonCode,
      durationMs: Math.max(0, finishedMs - startedMs),
      finishedAt: new Date(finishedMs).toISOString(),
      ...extra,
    }
  }

  // 1) 配置：非法配置不抛，明确记 skipped / HOST_CHECK_INVALID。
  const normalized = check && typeof check === 'object' && typeof check.shapeError === 'string'
    ? check
    : normalizeNodeCheck(check)
  const verdict = validateNodeCheck(normalized)
  if (!verdict.ok) {
    return settle(HOST_CHECK_STATE.SKIPPED, HOST_CHECK_REASON.INVALID, {
      message: `检查配置不合法（check.${verdict.field}）：${verdict.message}`,
    })
  }
  const expectedExitCode = normalized.expectExitCode
  resolvedExpectedExitCode = expectedExitCode
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : normalized.timeoutMs
  const reportPath = normalized.reportPath || null
  const workdir = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()

  // 2) 不可执行环境：没有 POSIX sh / cwd 不存在 → skipped，绝不伪造成功。
  if (process.platform === 'win32') {
    return settle(HOST_CHECK_STATE.SKIPPED, HOST_CHECK_REASON.UNAVAILABLE, {
      reportPath,
      message: '当前平台没有 POSIX sh：无法执行保存的检查命令。',
    })
  }
  try {
    if (!statSync(workdir).isDirectory()) throw new Error('not a directory')
  } catch {
    return settle(HOST_CHECK_STATE.SKIPPED, HOST_CHECK_REASON.UNAVAILABLE, {
      reportPath,
      message: '检查工作目录不可用：目录不存在或不是目录。',
    })
  }
  if (signal && signal.aborted) {
    return settle(HOST_CHECK_STATE.SKIPPED, HOST_CHECK_REASON.CANCELLED, {
      reportPath,
      message: '检查在启动前已被取消。',
    })
  }

  // 3) 执行前 fingerprint：缺失允许；软链 / 非普通文件直接失败。
  let preReport = null
  if (reportPath) {
    if (!containedTarget(workdir, reportPath)) {
      return settle(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.REPORT_INVALID, {
        reportPath,
        message: `报告路径「${reportPath}」越出了工作目录：只接受工作区内真实的普通文件路径。`,
      })
    }
    preReport = fingerprintReport(workdir, reportPath, maxReportBytes)
    if (preReport.error) {
      return settle(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.REPORT_INVALID, {
        reportPath,
        message: preReport.error,
      })
    }
  }

  let invocation
  try {
    invocation = buildHostCheckInvocation(normalized, { cwd: workdir })
  } catch (error) {
    return settle(HOST_CHECK_STATE.SKIPPED, HOST_CHECK_REASON.INVALID, {
      reportPath,
      message: clipMessage(errorText(error)),
    })
  }

  const childEnv = filterHostCheckEnv(env && typeof env === 'object' ? env : process.env)

  return await new Promise((resolvePromise) => {
    let settled = false
    let child = null
    let timer = null
    let spawnError = null
    let spawnSeen = false
    let interruptReason = null
    let receivedBytes = 0
    let truncated = false
    let tail = Buffer.alloc(0)
    let killScope = null
    let orphanWarning = CAN_DETACH
      ? null
      : '当前平台（Windows）不支持 POSIX 进程组：超时 / 取消只能终止直接子进程，孙进程可能残留。'

    function destroyStdio() {
      if (!child) return
      for (const stream of [child.stdout, child.stderr]) {
        if (stream && typeof stream.destroy === 'function') {
          try {
            stream.destroy()
          } catch {
            // 已关闭的流再 destroy 无害。
          }
        }
      }
    }

    function finish(state, reasonCode, extra = {}) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
      destroyStdio()
      const merged = {
        truncated,
        outputTail: decodeOutputTail(tail, redact),
        receivedBytes,
        reportPath,
        killScope,
        orphanWarning,
        ...extra,
      }
      if (typeof merged.message === 'string') merged.message = applyRedact(merged.message, redact)
      resolvePromise(settle(state, reasonCode, merged))
    }

    function onAbort() {
      if (settled) return
      interrupt('cancel')
    }

    /**
     * 本次子进程能否按「整组」终止：POSIX + detached + 真实 ChildProcess + 有效 pid。
     * 注入的假 spawn（EventEmitter 形状）没有真实进程组，贸然 kill(-pid) 可能误伤无关进程组。
     */
    const groupKillCapable = () => CAN_DETACH
      && child instanceof ChildProcess
      && Number.isInteger(child.pid)
      && child.pid > 0

    const signalGroup = (signalName) => {
      try {
        process.kill(-child.pid, signalName)
        return { ok: true, code: null }
      } catch (error) {
        return { ok: false, code: error && error.code ? String(error.code) : 'UNKNOWN' }
      }
    }

    function killChild() {
      if (!child || typeof child.kill !== 'function') return
      // 没有真实 pid = 进程根本没建起来（execve 失败）：没有可杀的东西，别记成「杀了直接子进程」。
      if (!Number.isInteger(child.pid) || child.pid <= 0) return
      let groupOk = false
      if (groupKillCapable()) {
        const term = signalGroup('SIGTERM')
        if (term.ok) {
          groupOk = true
          killScope = 'group'
        } else if (term.code !== 'ESRCH') {
          orphanWarning = `无法按进程组发送 SIGTERM（${term.code}）：已降级为只终止直接子进程，孙进程可能残留。`
        }
      } else if (!orphanWarning) {
        orphanWarning = '子进程不是真实的 ChildProcess：无法按进程组终止，只能终止直接子进程，孙进程可能残留。'
      }
      if (!groupOk) {
        killScope = 'process'
        try {
          child.kill('SIGTERM')
        } catch {
          // 已退出就忽略。
        }
      }
      // 升级 SIGKILL 的计时器不随 finish 清理：promise 收口后仍要保证进程组真的死掉。
      const killer = setTimeout(() => {
        if (groupOk) {
          const hard = signalGroup('SIGKILL')
          if (!hard.ok) {
            try {
              child.kill('SIGKILL')
            } catch {
              // 已退出就忽略。
            }
          }
          return
        }
        try {
          child.kill('SIGKILL')
        } catch {
          // 已退出就忽略。
        }
      }, KILL_GRACE_MS)
      if (killer && typeof killer.unref === 'function') killer.unref()
    }

    /** 内部中断：先记原因再杀进程（close 回调不能把 timeout/取消误记成正常退出）。 */
    function interrupt(reason) {
      if (settled || interruptReason) return
      interruptReason = reason
      killChild()
      if (reason === 'timeout') {
        finish(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.TIMEOUT, {
          exitCode: null,
          message: `检查命令超时（${effectiveTimeout}ms）：已终止进程。`,
        })
        return
      }
      if (reason === 'cancel') {
        finish(HOST_CHECK_STATE.SKIPPED, HOST_CHECK_REASON.CANCELLED, {
          exitCode: null,
          message: '检查已被取消：已终止进程。',
        })
        return
      }
      finish(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.OUTPUT_LIMIT, {
        exitCode: null,
        message: `检查输出超过上限 ${maxOutputBytes} 字节：已按 OUTPUT_LIMIT 终止。`,
      })
    }

    function pushChunk(chunk) {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (buffer.length === 0) return
      receivedBytes += buffer.length
      tail = tail.length === 0 ? buffer : Buffer.concat([tail, buffer])
      if (tail.length > OUTPUT_TAIL_BYTES) {
        tail = Buffer.from(tail.subarray(tail.length - OUTPUT_TAIL_BYTES))
      }
      if (!truncated && receivedBytes > maxOutputBytes) {
        truncated = true
        interrupt('output')
      }
    }

    /** 正常结束：pass 必须同时满足真实 spawn + 收到 close + 退出码匹配 + 报告条件。 */
    function handleClose(code) {
      if (settled) return
      if (interruptReason) return
      if (spawnError) {
        finish(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.SPAWN, {
          exitCode: Number.isInteger(code) ? code : null,
          message: `检查进程启动失败：${clipMessage(errorText(spawnError))}`,
        })
        return
      }
      if (!spawnSeen) {
        finish(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.SPAWN, {
          exitCode: Number.isInteger(code) ? code : null,
          message: '没有收到 spawn 事件：不能确认检查进程真正启动过。',
        })
        return
      }
      const exitCode = Number.isInteger(code) ? code : null
      if (exitCode !== expectedExitCode) {
        finish(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.EXIT, {
          exitCode,
          message: exitCode === null
            ? `检查命令被信号终止，没有正常退出码；期望 ${expectedExitCode}。`
            : `检查命令退出码是 ${exitCode}，期望 ${expectedExitCode}。`,
        })
        return
      }
      if (!reportPath) {
        finish(HOST_CHECK_STATE.PASS, null, { exitCode })
        return
      }

      // 报告新鲜性：必须新建或更新（inode / mtimeNs / ctimeNs / size 之一变化）。
      const postReport = fingerprintReport(workdir, reportPath, maxReportBytes)
      if (!postReport.exists) {
        finish(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.REPORT_MISSING, {
          exitCode,
          message: `检查命令通过了，但报告文件「${reportPath}」没有生成。`,
        })
        return
      }
      if (postReport.error) {
        finish(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.REPORT_INVALID, {
          exitCode,
          message: postReport.error,
        })
        return
      }
      if (postReport.tooLarge) {
        finish(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.REPORT_TOO_LARGE, {
          exitCode,
          message: `报告文件「${reportPath}」超过 ${maxReportBytes} 字节上限：拒绝截断后判通过。`,
        })
        return
      }
      const updated = !preReport.exists
        || postReport.ino !== preReport.ino
        || postReport.mtimeNs !== preReport.mtimeNs
        || postReport.ctimeNs !== preReport.ctimeNs
        || postReport.size !== preReport.size
      if (!updated) {
        finish(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.REPORT_STALE, {
          exitCode,
          message: `报告文件「${reportPath}」在执行期间没有被新建或更新：不能拿旧文件判通过。`,
        })
        return
      }
      // F3：公开副本先脱敏，再按最终字节算 hash；哈希与副本必须一一对应。
      const publicReport = redactReportCopy(postReport.buffer, redact)
      finish(HOST_CHECK_STATE.PASS, null, {
        exitCode,
        reportSha256: publicReport.sha256,
        reportBytes: publicReport.buffer,
        reportByteLength: publicReport.bytes,
        reportOpaque: publicReport.opaque,
      })
    }

    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        finish(HOST_CHECK_STATE.SKIPPED, HOST_CHECK_REASON.CANCELLED, {
          exitCode: null,
          message: '检查在启动前已被取消。',
        })
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      child = spawn(invocation.file, invocation.argv, {
        cwd: invocation.cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: CAN_DETACH,
        shell: false,
      })
    } catch (error) {
      finish(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.SPAWN, {
        exitCode: null,
        message: `检查进程启动失败：${clipMessage(errorText(error))}`,
      })
      return
    }
    if (!child || !child.stdout || !child.stderr) {
      try {
        if (child && typeof child.kill === 'function') child.kill('SIGKILL')
      } catch {
        // 已经退出就忽略。
      }
      finish(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.SPAWN, {
        exitCode: null,
        message: '检查进程创建后拿不到 stdout / stderr 管道：已终止进程。',
      })
      return
    }

    child.on('spawn', () => {
      spawnSeen = true
    })
    child.on('error', (error) => {
      spawnError = error
      if (settled) return
      if (child && typeof child.kill === 'function') killChild()
      finish(HOST_CHECK_STATE.FAIL, HOST_CHECK_REASON.SPAWN, {
        exitCode: null,
        message: `检查进程启动失败：${clipMessage(errorText(error))}`,
      })
    })
    child.stdout.on('data', pushChunk)
    child.stderr.on('data', pushChunk)
    child.on('close', handleClose)

    // spawn 之后复查一次取消，避免「注册监听 → 起进程」窗口漏掉 abort。
    if (signal && signal.aborted) {
      interrupt('cancel')
      return
    }
    if (Number.isFinite(effectiveTimeout) && effectiveTimeout > 0) {
      timer = setTimeout(() => interrupt('timeout'), effectiveTimeout)
    }
  })
}
