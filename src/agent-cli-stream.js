/**
 * 共享 CLI stdout / stderr 流读取 helper（0.14.4 / U1）。
 *
 * 修复 review-0142b 的共享缺陷 M3：
 *   - 旧适配器按 `String(chunk)` 直接拼接 Buffer，UTF-8 多字节字符跨 chunk 时出现
 *     U+FFFD（"中文" → "���文"）；
 *   - 协议缓冲同时被当作诊断 tail 裁剪（codex 的 256 KiB 窗口），600 KiB 合法单行
 *     被截断后 JSON.parse 失败，整条事件静默丢失；
 *   - 没有行长上限，畸形/超大行既不可诊断也不可控；
 *   - `exit` 时直接结算，没有 EOF flush（合法 JSON 缺尾换行就丢）；
 *   - 初始进程与 resume 进程共享半行缓冲。
 *
 * 本模块只做**分帧**，不解析 JSON（协议归适配器）。语义：
 *   1. 用 `node:string_decoder` 的 `StringDecoder('utf8')` 解码，绝不 `buf.toString()`
 *      逐块切；行缓冲区以**原始字节**为单位，行长上限也按原始字节执行。
 *   2. 超过 `maxLineBytes` 的行**整行丢弃直到下一个换行**，记一条
 *      `{ kind:'line-too-long', bytes, lineNo }` 诊断；后半段绝不再当行交付。
 *   3. `end()` 用 `decoder.end()` flush 残留半行（无尾换行的合法 JSON 交付一次）。
 *   4. BOM 剥离、CRLF 归一、空行/纯空白行跳过（与旧适配器兼容）。
 *   5. `onLine` 抛错转成诊断，不炸掉流；诊断有界（默认 200 条），只记位置 / 长度 /
 *      类型 / 脱敏摘要（≤256 字符），不写完整协议正文或凭据。
 *   6. 每个子进程应创建独立 reader；展示 tail 与协议缓冲在 `attachProcessStreams`
 *      中分离，tail 上限不影响完整行交付。
 *   7. `drained` 是**有界**的：stdout 已 end 且 reader 已 end 才是 drained；
 *      超过 `drainTimeoutMs` 返回 `{ drained:false, timedOut:true }`，绝不无限等。
 *
 * JSDoc 里给出的返回形状是与适配器接入方冻结的契约；`abort` / `diagnostics`
 * 是附加能力（不改动既有字段语义）。
 *
 * @module @feiyueve/dsh-flow-studio/agent-cli-stream
 */

import { Buffer } from 'node:buffer'
import { StringDecoder } from 'node:string_decoder'

import { redactText } from './process-output.js'

/**
 * 单行默认字节上限：32 MiB。
 *
 * Codex 长线程 / resume 时，单条 JSON 记录（含完整历史 / 大工具输出）会超过 8 MiB；
 * 8 MiB 会把合法事件整行丢掉，因此按社区常见的 32 MiB 口径放宽。
 * 测试可用小值覆盖：`createUtf8LineReader({ maxLineBytes })`。
 */
export const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024

/**
 * 行缓冲的初始容量：1 MiB。
 *
 * 常规协议事件在同一个缓冲里追加，避免每个 chunk 都重新分配 / Buffer.concat；
 * 超过初始容量时按几何增长（上限仍是 `maxLineBytes`），行交付后回落到初始容量，
 * 不让偶发的大行长期占着内存。测试可用 `initialLineBufferBytes` 覆盖。
 */
export const DEFAULT_INITIAL_LINE_BUFFER_BYTES = 1024 * 1024

/** 保留的诊断条数上限。 */
const DEFAULT_MAX_DIAGNOSTICS = 200

/** 展示用 stdout tail 默认上限（64 KiB）。 */
const DEFAULT_STDOUT_TAIL_BYTES = 64 * 1024

/** 展示用 stderr tail 默认上限（8 KiB）。 */
const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024

/**
 * tail 的**原始窗口余量**（0.15.1）。
 *
 * 旧实现按上限边收边切，导出时才脱敏：切点落在敏感值中间时键名已经被切掉，值就裸奔。
 * 现在收流时保留 `上限 + 余量` 的原始窗口，导出时先对整段窗口脱敏、再按上限截尾。
 * 余量取与上限相同（至少 4 KiB），覆盖「键名刚落在窗口外一点」的常见情形；真正超长的
 * 值还有规则 5 的超长串兜底。
 */
const TAIL_REDACT_MARGIN_MIN_BYTES = 4 * 1024

/**
 * 计算 tail 的原始保留窗口。
 *
 * @param {number} limit
 * @returns {number}
 */
function tailRetentionBytes(limit) {
  return limit + Math.max(TAIL_REDACT_MARGIN_MIN_BYTES, limit)
}

/** 退出后等待 stdout 排空的默认上限（5s）。 */
const DEFAULT_DRAIN_TIMEOUT_MS = 5000

/** 诊断摘要最大字符数（含脱敏后）。 */
const DIAGNOSTIC_SUMMARY_MAX = 256

function positiveIntOr(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeIntOr(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/**
 * C0 控制字符（保留 `\t` 与 `\n`）。
 *
 * 诊断串来自子进程 / 任意错误对象，可能带 NUL、BEL、ESC、裸 CR 等控制字节；原样写进
 * 日志会污染终端、也会让结构化输出的阅读者（人 / 模型）看到乱码。除 `\t`（0x09）与
 * `\n`（0x0A）外的 C0 一律剥掉；裸 CR（0x0D）会让同一行在不同终端里被覆盖显示，必须
 * 一并去掉。
 */
const C0_CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F]/g

/**
 * 去掉孤立代理项。
 *
 * JS 字符串按 UTF-16 码元存储；`String.prototype.slice` 可能把 emoji 的代理对切成
 * 一半，编码成 UTF-8 时变成 U+FFFD（半个多字节字符）。诊断摘要必须保证 UTF-8 合法，
 * 因此先清掉落单的代理项。
 *
 * @param {string} text
 * @returns {string}
 */
function stripLoneSurrogates(text) {
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[index] + text[index + 1]
        index += 1
      }
      // 孤立高代理：丢弃。
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // 孤立低代理：丢弃。
    } else {
      out += text[index]
    }
  }
  return out
}

/**
 * 按**码点**截断（不按码元），保证不切断代理对。
 *
 * @param {string} text
 * @param {number} maxCodePoints
 * @returns {string}
 */
function truncateCodePoints(text, maxCodePoints) {
  let out = ''
  let count = 0
  for (const char of text) {
    if (count >= maxCodePoints) break
    out += char
    count += 1
  }
  return out
}

/** 脱敏 + 清洗控制字符 + 按码点截断，诊断里只允许出现这个摘要。 */
function sanitizeSummary(value) {
  const text = value === undefined || value === null ? '' : String(value)
  const cleaned = stripLoneSurrogates(text.replace(C0_CONTROL_PATTERN, ''))
  return truncateCodePoints(redactText(cleaned), DIAGNOSTIC_SUMMARY_MAX)
}

/** 按**字节**上限裁剪字符串尾部，且不切断代理对 / 多字节字符。 */
function trimTextToBytes(text, maxBytes) {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let bytes = 0
  let index = text.length
  while (index > 0) {
    let codePoint = text.charCodeAt(index - 1)
    let step = 1
    if (codePoint >= 0xdc00 && codePoint <= 0xdfff && index >= 2) {
      const high = text.charCodeAt(index - 2)
      if (high >= 0xd800 && high <= 0xdbff) {
        codePoint = (high - 0xd800) * 0x400 + (codePoint - 0xdc00) + 0x10000
        step = 2
      }
    }
    const size = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4
    if (bytes + size > maxBytes) break
    bytes += size
    index -= step
  }
  return text.slice(index)
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  if (typeof input === 'string') return Buffer.from(input, 'utf8')
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  return null
}

/**
 * UTF-8 安全、按行分帧、EOF flush、有界诊断的流读取器。
 *
 * @param {object} [options]
 * @param {number} [options.maxLineBytes=33554432] 单行原始字节上限；超限整行丢弃。
 * @param {number} [options.initialLineBufferBytes=1048576] 行缓冲初始容量（按需增长）。
 * @param {number} [options.maxDiagnostics=200] 保留的诊断条数上限（超出只计数）。
 * @param {(line: string, meta: { lineNo: number, bytes: number }) => void} [options.onLine]
 *   每交付一行调用一次；`lineNo` 是物理行号（空行也占号），`bytes` 是原始字节数。
 * @param {(diag: object) => void} [options.onDiagnostic] 诊断回调；自身抛错被忽略。
 * @returns {{
 *   write(bufferOrString: Buffer|string|ArrayBufferView): void,
 *   end(): void,
 *   abort(reason?: string): void,
 *   stats(): object,
 *   diagnostics(): object[],
 * }}
 */
export function createUtf8LineReader(options = {}) {
  const maxLineBytes = positiveIntOr(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES)
  const maxDiagnostics = positiveIntOr(options.maxDiagnostics, DEFAULT_MAX_DIAGNOSTICS)
  const onLine = typeof options.onLine === 'function' ? options.onLine : () => {}
  const onDiagnostic = typeof options.onDiagnostic === 'function' ? options.onDiagnostic : () => {}

  const decoder = new StringDecoder('utf8')

  // 行缓冲：单块可增长 Buffer，初始容量取 min(选项, maxLineBytes)。常规事件在同一块里
  // 追加，避免每个 chunk 一次 realloc；只有超长行才需要增长。
  const initialLineBufferBytes = Math.min(
    positiveIntOr(options.initialLineBufferBytes, DEFAULT_INITIAL_LINE_BUFFER_BYTES),
    maxLineBytes,
  )
  const EMPTY_BUFFER = Buffer.alloc(0)
  let lineBuffer = null // 容量 >= lineBytes；行交付后可能保留以便复用
  let lineBytes = 0 // 当前行已累计的原始字节数（不含换行）
  let lineNo = 0 // 已结束的物理行数；当前行号 = lineNo + 1
  let overlong = false // 当前行已超限，正在丢弃直到下一个换行
  let overlongBytes = 0 // 超限行被丢弃的总字节数
  let ended = false
  let aborted = false

  const diagnostics = []
  const stats = {
    bytesReceived: 0,
    lines: 0,
    droppedLines: 0,
    diagnostics: 0,
    diagnosticsDropped: 0,
    pendingBytes: 0,
    aborted: false,
    ended: false,
    abortReason: null,
  }

  function recordDiagnostic(entry) {
    stats.diagnostics += 1
    if (diagnostics.length >= maxDiagnostics) {
      stats.diagnosticsDropped += 1
      return
    }
    const safe = { ...entry }
    if (typeof safe.message === 'string') safe.message = sanitizeSummary(safe.message)
    diagnostics.push(safe)
    try {
      onDiagnostic(safe)
    } catch {
      // 诊断回调自身失败不影响流。
    }
  }

  function resetLine() {
    lineBytes = 0
    overlong = false
    overlongBytes = 0
    stats.pendingBytes = 0
    // 偶发大行把容量撑大后回收，避免长进程长期占着几十 MiB。
    if (lineBuffer !== null && lineBuffer.length > initialLineBufferBytes) lineBuffer = null
  }

  function dropOverlongLine() {
    recordDiagnostic({ kind: 'line-too-long', bytes: overlongBytes, lineNo: lineNo + 1 })
    stats.droppedLines += 1
    lineNo += 1
    resetLine()
  }

  function deliverLine(text, bytes) {
    if (text.trim() === '') return
    stats.lines += 1
    try {
      onLine(text, { lineNo, bytes })
    } catch (error) {
      recordDiagnostic({
        kind: 'on-line-error',
        lineNo,
        message: error && typeof error.message === 'string' ? error.message : String(error),
      })
    }
  }

  /** 归一化并交付已完整读取的一行原始字节。 */
  function finishLine(raw) {
    let text = decoder.write(raw)
    if (text.endsWith('\r')) text = text.slice(0, -1)
    if (lineNo === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const bytes = raw.length
    lineNo += 1
    resetLine()
    deliverLine(text, bytes)
  }

  /** 当前行已累计字节的只读视图（空行返回共享空 Buffer）。 */
  function currentLineBuffer() {
    return lineBytes === 0 ? EMPTY_BUFFER : lineBuffer.subarray(0, lineBytes)
  }

  function pushSegment(segment) {
    if (segment.length === 0) return
    if (overlong) {
      overlongBytes += segment.length
      stats.pendingBytes = overlongBytes
      return
    }
    const needed = lineBytes + segment.length
    if (needed > maxLineBytes) {
      // 超限：丢掉已累计片段，后续字节只计数、不再进入行缓冲；下一个换行后恢复。
      overlong = true
      overlongBytes = needed
      lineBytes = 0
      lineBuffer = null
      stats.pendingBytes = overlongBytes
      return
    }
    if (lineBuffer === null) lineBuffer = Buffer.allocUnsafe(initialLineBufferBytes)
    if (needed > lineBuffer.length) {
      // 几何增长，但不超过 maxLineBytes；needed 必然 <= maxLineBytes。
      const grown = Math.min(maxLineBytes, Math.max(needed, lineBuffer.length * 2))
      const next = Buffer.allocUnsafe(grown)
      lineBuffer.copy(next, 0, 0, lineBytes)
      lineBuffer = next
    }
    segment.copy(lineBuffer, lineBytes)
    lineBytes = needed
    stats.pendingBytes = lineBytes
  }

  function scan(chunk) {
    let start = 0
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue
      pushSegment(chunk.subarray(start, index))
      if (overlong) {
        dropOverlongLine()
      } else {
        finishLine(currentLineBuffer())
      }
      start = index + 1
    }
    if (start < chunk.length) pushSegment(chunk.subarray(start))
  }

  return {
    write(input) {
      if (ended || aborted) return
      const chunk = toBuffer(input)
      if (!chunk) throw new TypeError('createUtf8LineReader.write 只接受 Buffer / string / ArrayBufferView')
      stats.bytesReceived += chunk.length
      scan(chunk)
    },

    end() {
      if (ended || aborted) {
        ended = true
        return
      }
      ended = true
      if (overlong) {
        dropOverlongLine()
      } else if (lineBytes > 0) {
        const raw = currentLineBuffer()
        let text = decoder.write(raw)
        text += decoder.end()
        if (text.endsWith('\r')) text = text.slice(0, -1)
        if (lineNo === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
        const bytes = raw.length
        lineNo += 1
        resetLine()
        deliverLine(text, bytes)
      } else {
        // 没有残留行；仍要释放 decoder 里可能残留的非法尾字节，但不交付空行。
        decoder.end()
      }
      stats.ended = true
      stats.pendingBytes = 0
    },

    /** 附加能力：停止交付（例如 handle 被 abort）。已交付的行不受影响。 */
    abort(reason) {
      if (aborted) return
      aborted = true
      stats.aborted = true
      stats.abortReason = reason === undefined || reason === null ? null : sanitizeSummary(reason)
      resetLine()
    },

    /** 只读统计快照。 */
    stats() {
      return { ...stats }
    },

    /** 已保留的诊断副本（调用方不能改内部数组）。 */
    diagnostics() {
      return diagnostics.map(entry => ({ ...entry }))
    },
  }
}

/**
 * 把子进程的 stdout/stderr 接到 reader，并提供**独立、有界、脱敏展示用**的 tail。
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {object} [options]
 * @param {ReturnType<typeof createUtf8LineReader>} [options.stdoutReader] 协议行读取器；
 *   省略时内部创建一个（建议每个初始/resume 进程传入独立实例）。
 * @param {ReturnType<typeof createUtf8LineReader>} [options.stderrReader] 可选；stderr
 *   通常只做 tail 诊断，需要结构化诊断时才传。
 * @param {number} [options.stdoutTailBytes=65536] 展示 tail 上限（按字节）；内部保留
 *   `上限 + 余量` 的原始窗口，导出时**先脱敏再截尾**。
 * @param {number} [options.stderrTailBytes=8192] 展示 tail 上限（按字节）。
 * @param {number} [options.drainTimeoutMs=5000] 子进程退出后等待 stdout 排空的上限；
 *   `0` 表示退出即刻判定（仍然有界）。
 * @returns {{
 *   drained: Promise<{ drained: boolean, timedOut: boolean }>,
 *   stdoutTail(): string,
 *   stderrTail(): string,
 *   diagnostics(): object[],
 *   dispose(): void,
 * }}
 */
export function attachProcessStreams(child, options = {}) {
  if (!child || typeof child !== 'object') {
    throw new TypeError('attachProcessStreams 需要一个子进程对象')
  }
  const stdoutReader = options.stdoutReader || createUtf8LineReader(options)
  const stderrReader = options.stderrReader || null
  const stdoutTailBytes = positiveIntOr(options.stdoutTailBytes, DEFAULT_STDOUT_TAIL_BYTES)
  const stderrTailBytes = positiveIntOr(options.stderrTailBytes, DEFAULT_STDERR_TAIL_BYTES)
  // 收流时保留「上限 + 余量」的原始窗口；导出时再脱敏并截到展示上限。
  const stdoutRetentionBytes = tailRetentionBytes(stdoutTailBytes)
  const stderrRetentionBytes = tailRetentionBytes(stderrTailBytes)
  const drainTimeoutMs = nonNegativeIntOr(options.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS)

  const stdoutTailDecoder = new StringDecoder('utf8')
  const stderrTailDecoder = new StringDecoder('utf8')
  let stdoutTailText = ''
  let stderrTailText = ''
  const ownDiagnostics = []

  let settled = false
  let disposed = false
  let drainTimer = null
  let resolveDrained
  const drained = new Promise(resolve => {
    resolveDrained = resolve
  })

  function recordOwnDiagnostic(entry) {
    if (ownDiagnostics.length >= DEFAULT_MAX_DIAGNOSTICS) return
    const safe = { ...entry, source: 'attach' }
    if (typeof safe.message === 'string') safe.message = sanitizeSummary(safe.message)
    ownDiagnostics.push(safe)
  }

  function settle(payload) {
    if (settled) return
    settled = true
    if (drainTimer) {
      clearTimeout(drainTimer)
      drainTimer = null
    }
    resolveDrained(payload)
  }

  function startDrainTimer() {
    if (settled || drainTimer || disposed) return
    drainTimer = setTimeout(() => {
      drainTimer = null
      if (settled) return
      // stdout 没有 end（常见原因：后代进程继承并持有 stdout pipe），
      // 有界收口并标记输出不完整；不在这里 reader.end()，避免之后又收到数据。
      recordOwnDiagnostic({
        kind: 'drain-timeout',
        timeoutMs: drainTimeoutMs,
        message: '子进程退出后 stdout 未在期限内排空（可能有后代继承 stdout）',
      })
      settle({ drained: false, timedOut: true })
    }, drainTimeoutMs)
    drainTimer.unref?.()
  }

  function onStdoutData(chunk) {
    if (disposed) return
    try {
      // 展示 tail 用独立的 decoder，按字节有界；与协议缓冲完全分离。
      stdoutTailText = trimTextToBytes(
        stdoutTailText + stdoutTailDecoder.write(chunk),
        stdoutRetentionBytes,
      )
    } catch (error) {
      recordOwnDiagnostic({ kind: 'tail-error', message: String(error && error.message) })
    }
    try {
      stdoutReader.write(chunk)
    } catch (error) {
      recordOwnDiagnostic({ kind: 'reader-error', message: String(error && error.message) })
    }
  }

  function onStderrData(chunk) {
    if (disposed) return
    try {
      stderrTailText = trimTextToBytes(
        stderrTailText + stderrTailDecoder.write(chunk),
        stderrRetentionBytes,
      )
    } catch (error) {
      recordOwnDiagnostic({ kind: 'tail-error', message: String(error && error.message) })
    }
    if (stderrReader) {
      try {
        stderrReader.write(chunk)
      } catch (error) {
        recordOwnDiagnostic({ kind: 'reader-error', message: String(error && error.message) })
      }
    }
  }

  function finishStdout() {
    if (disposed) return
    try {
      stdoutTailText = trimTextToBytes(stdoutTailText + stdoutTailDecoder.end(), stdoutRetentionBytes)
    } catch {
      // decoder.end() 不应失败；展示 tail 失败不影响协议行。
    }
    try {
      stdoutReader.end()
    } catch (error) {
      recordOwnDiagnostic({ kind: 'reader-error', message: String(error && error.message) })
    }
    settle({ drained: true, timedOut: false })
  }

  function finishStderr() {
    if (disposed) return
    try {
      stderrTailText = trimTextToBytes(stderrTailText + stderrTailDecoder.end(), stderrRetentionBytes)
    } catch {
      // 同上
    }
    if (stderrReader) {
      try {
        stderrReader.end()
      } catch (error) {
        recordOwnDiagnostic({ kind: 'reader-error', message: String(error && error.message) })
      }
    }
  }

  const onStreamError = stream => error => {
    recordOwnDiagnostic({
      kind: 'stream-error',
      stream,
      message: String(error && error.message ? error.message : error),
    })
    if (stream === 'stdout') settle({ drained: false, timedOut: false })
  }

  const onStdoutClose = () => {
    // close 先于 end（stream 被销毁）时按「未排空」收口，不谎报 drained。
    if (settled) return
    recordOwnDiagnostic({ kind: 'stdout-closed-early', message: 'stdout 在 end 之前被关闭' })
    settle({ drained: false, timedOut: false })
  }
  const onStdoutStreamError = onStreamError('stdout')
  const onStderrStreamError = onStreamError('stderr')

  const stdout = child.stdout || null
  const stderr = child.stderr || null

  if (stdout) {
    stdout.on('data', onStdoutData)
    stdout.on('end', finishStdout)
    stdout.on('close', onStdoutClose)
    stdout.on('error', onStdoutStreamError)
  }
  if (stderr) {
    stderr.on('data', onStderrData)
    stderr.on('end', finishStderr)
    stderr.on('error', onStderrStreamError)
  }

  const onChildExit = () => {
    startDrainTimer()
  }
  child.once('exit', onChildExit)

  // 子进程可能在 attach 之前就已退出（同步极快）：立刻启动排空期限。
  if (child.exitCode !== null || child.signalCode !== null) {
    startDrainTimer()
  }
  if (!stdout) {
    // 没有 stdout 可等：视为已排空（并让 reader 收尾）。
    try {
      stdoutReader.end()
    } catch {
      // 忽略
    }
    settle({ drained: true, timedOut: false })
  } else if (stdout.readableEnded) {
    finishStdout()
  }

  return {
    drained,
    stdoutTail() {
      // 先整段脱敏、再截到展示上限：切点落在值中间也不会露出裸值。
      return trimTextToBytes(redactText(stdoutTailText), stdoutTailBytes)
    },
    stderrTail() {
      return trimTextToBytes(redactText(stderrTailText), stderrTailBytes)
    },
    diagnostics() {
      const merged = ownDiagnostics.map(entry => ({ ...entry }))
      const pushReader = (reader, source) => {
        if (!reader || typeof reader.diagnostics !== 'function') return
        for (const entry of reader.diagnostics()) {
          merged.push(source ? { ...entry, source } : { ...entry })
        }
      }
      pushReader(stdoutReader, null)
      pushReader(stderrReader, 'stderr')
      return merged
    },
    /** 停止监听并让 `drained` 有界收口；不删除已交付的行。 */
    dispose() {
      if (disposed) return
      disposed = true
      if (drainTimer) {
        clearTimeout(drainTimer)
        drainTimer = null
      }
      try {
        stdout?.off('data', onStdoutData)
        stdout?.off('end', finishStdout)
        stdout?.off('close', onStdoutClose)
        stdout?.off('error', onStdoutStreamError)
        stderr?.off('data', onStderrData)
        stderr?.off('end', finishStderr)
        stderr?.off('error', onStderrStreamError)
        child.off('exit', onChildExit)
      } catch {
        // 老版本 EventEmitter 兼容：忽略
      }
      settle({ drained: false, timedOut: false })
    },
  }
}
