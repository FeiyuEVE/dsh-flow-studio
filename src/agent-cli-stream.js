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

/** 单行默认字节上限：8 MiB。 */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024

/** 保留的诊断条数上限。 */
const DEFAULT_MAX_DIAGNOSTICS = 200

/** 展示用 stdout tail 默认上限（64 KiB）。 */
const DEFAULT_STDOUT_TAIL_BYTES = 64 * 1024

/** 展示用 stderr tail 默认上限（8 KiB）。 */
const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024

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

/** 脱敏 + 截断，诊断里只允许出现这个摘要。 */
function sanitizeSummary(value) {
  const text = value === undefined || value === null ? '' : String(value)
  return redactText(text).slice(0, DIAGNOSTIC_SUMMARY_MAX)
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
 * @param {number} [options.maxLineBytes=8388608] 单行原始字节上限；超限整行丢弃。
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

  // 当前行（尚未遇到换行）的原始字节片段。
  let lineChunks = []
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
    lineChunks = []
    lineBytes = 0
    overlong = false
    overlongBytes = 0
    stats.pendingBytes = 0
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

  function pushSegment(segment) {
    if (segment.length === 0) return
    if (overlong) {
      overlongBytes += segment.length
      stats.pendingBytes = overlongBytes
      return
    }
    lineBytes += segment.length
    if (lineBytes > maxLineBytes) {
      // 超限：丢掉已累计片段，后续字节只计数、不再进入行缓冲。
      overlong = true
      overlongBytes = lineBytes
      lineChunks = []
      lineBytes = 0
      stats.pendingBytes = overlongBytes
      return
    }
    lineChunks.push(Buffer.from(segment))
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
        const raw = lineChunks.length === 1
          ? lineChunks[0]
          : Buffer.concat(lineChunks, lineBytes)
        finishLine(raw)
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
      } else if (lineBytes > 0 || lineChunks.length > 0) {
        const raw = lineChunks.length === 1
          ? lineChunks[0]
          : Buffer.concat(lineChunks, lineBytes)
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
 * @param {number} [options.stdoutTailBytes=65536] 展示 tail 上限（按字节）。
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
        stdoutTailBytes,
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
        stderrTailBytes,
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
      stdoutTailText = trimTextToBytes(stdoutTailText + stdoutTailDecoder.end(), stdoutTailBytes)
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
      stderrTailText = trimTextToBytes(stderrTailText + stderrTailDecoder.end(), stderrTailBytes)
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
      return stdoutTailText
    },
    stderrTail() {
      return stderrTailText
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
