/**
 * 外部进程输出的共享有界保留与脱敏原语（0.11 R3 / S2）。
 *
 * 这个模块只做三件事，且刻意保持零业务依赖（除 `node:buffer` 外，仅共享
 * `host-check.js` 导出的**纯字符串** `SECRET_FLAG_PATTERN`，不引入该模块的任何
 * 执行路径 —— 它导出的是模式常量，不是函数或单例）：
 *   1. `redactText`：与 `host-check.redactSensitiveText` 同源的凭据脱敏规则，但第 4 条
 *      （≥32 超长串）保留了下方注释里说明的两处精化。放在这里是为了让 executor 等
 *      Host 侧模块共享同一套规则，而不反向 import engine（engine 依赖 fs / runlog，
 *      浏览器侧也会间接加载）。
 *   2. `redactDeep`：对事件对象 / 数组 / 字符串做递归脱敏；键数、深度、循环引用都有界，
 *      保证 onEvent、结果、错误消息里不会出现未脱敏的字符串。
 *   3. `createBoundedOutput`：按 **原始 UTF-8 字节**（decode 之前）累计收到多少字节，
 *      只保留前 `maxBytes` 个字节的文本；事件条数受 `maxEvents` 约束。累计计数
 *      `receivedBytes` 单调递增，不因保留字符被淘汰而回退。超过上限时只接受剩余部分
 *      并置 `limit` / `truncated`，由调用方（executor）决定杀进程与收口。
 *
 * 设计约束（06 §13 / 0.11 方案 §5）：
 *   - 不 spawn、不读文件、不发业务事件；纯函数 + 一个小状态机；
 *   - 保留文本是**前缀**（不是 ring 尾），并按 UTF-8 字符边界裁剪，绝不产生半个多字节
 *     字符；
 *   - 恰好等于上限是合法的（`limit === null`）；只有真正越过上限才截断；
 *   - 方法/属性只暴露上层收口需要的部分：`addRaw` / `pushEvent` / `text` / `tail`，
 *     以及只读 `truncated` / `limit` / `receivedBytes` / `retainedBytes` / `eventCount`；
 *     `eventList()` 返回事件快照副本（调用方不能绕过额度直接改内部数组）。
 *
 * @module @feiyueve/dsh-flow-studio/process-output
 */

import { Buffer } from 'node:buffer'

// 0.11 N3 接线：敏感标志位（`--token <值>` 这类空格/引号分隔形态）的**模式字符串**
// 只在 host-check.js 维护一份，这里复用而不是再抄一遍。导入的是常量字符串，不会把
// host-check 的执行路径（spawn / fs）带进本模块的调用链。
import { SECRET_FLAG_PATTERN } from './host-check.js'

/** 默认输出字节上限：8 MiB（stdout + stderr 原始输入字节）。 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** 默认规范化事件条数上限。 */
const DEFAULT_MAX_EVENTS = 5000

/** 默认 tail 上限：16 KiB（诊断信息只需要尾部）。 */
const DEFAULT_MAX_TAIL = 16 * 1024

/** 单个对象最多保留的键数（递归脱敏时防止宽对象把预算撑爆）。 */
const REDACT_MAX_KEYS = 64

/** 递归脱敏的最大深度。 */
const REDACT_MAX_DEPTH = 8

/** 递归遇到循环引用 / 超深对象时的占位符（绝不把未脱敏的深层对象原样透出）。 */
const REDACT_TRUNCATED = '[TRUNCATED]'

/** 非正 / 非安全整数一律回落到默认值。 */
function positiveIntOr(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** 敏感标志位规则实例（`replace` 会重置 `lastIndex`，模块内串行调用安全）。 */
const SECRET_FLAG = new RegExp(SECRET_FLAG_PATTERN, 'gi')

/**
 * 文本脱敏（0.11 R3；0.14.8 起支持超大输入）。
 *
 * 保持纯函数：host-check 等调用方都需要它不依赖 fs / 存储层，反向 import 会形成环。
 *
 * 实现分两层：{@link redactSegment} 是完整的规则管线（只在有界片段上跑）；本函数负责
 * **分段**——按行切分（行是语义完整的单位，quoted 值 / Authorization 头通常在同一行），
 * 每段 ≤ {@link REDACT_MAX_SEGMENT}。单行本身就超长时，退一步按「引号外的空白」切词；
 * 仍超长的无空白串整段判成 `[REDACTED]`（这类串本来就会命中规则 4 的多类字符判定）。
 *
 * 为什么不能只按空白切：`password="…; hunter2"` 这种引号内含空白的值会被劈成两半，
 * 后半段逃过 key=value 规则（0.14.8 复审实测泄漏）。所以词法上只在**引号未被打开**
 * 时把空白当分隔符；引号打开的前提是紧跟在 `=` / `:` 后面（值开头）。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function redactText(raw) {
  const text = typeof raw === 'string' ? raw : String(raw ?? '')
  if (text.length <= REDACT_MAX_SEGMENT) return redactSegment(text)
  let out = ''
  let buffer = ''
  const flush = () => {
    if (buffer !== '') {
      out += redactSegment(buffer)
      buffer = ''
    }
  }
  let index = 0
  while (index < text.length) {
    const newline = text.indexOf('\n', index)
    const lineEnd = newline === -1 ? text.length : newline + 1
    const line = text.slice(index, lineEnd)
    index = lineEnd
    if (line.length > REDACT_MAX_SEGMENT) {
      flush()
      let lineBuffer = ''
      const lineFlush = () => {
        if (lineBuffer !== '') {
          out += redactSegment(lineBuffer)
          lineBuffer = ''
        }
      }
      for (const piece of splitOversizeLine(line)) {
        if (piece === '[REDACTED]') {
          lineFlush()
          out += '[REDACTED]'
          continue
        }
        if (lineBuffer.length + piece.length > REDACT_MAX_SEGMENT) lineFlush()
        lineBuffer += piece
      }
      lineFlush()
      continue
    }
    if (buffer.length + line.length > REDACT_MAX_SEGMENT) flush()
    buffer += line
  }
  flush()
  return out
}

/**
 * 把「单行超长」的文本切成词（引号内的空白不算分隔符）。
 *
 * 唯一会返回 `'[REDACTED]'` 的情况是某个词本身超过 {@link REDACT_MAX_SEGMENT}——
 * 这种无空白超长串按规则 4 的语义就该整体抹掉，同时避开正则在超长匹配上爆栈。
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitOversizeLine(line) {
  const pieces = []
  let index = 0
  while (index < line.length) {
    const start = index
    let quote = null
    while (index < line.length) {
      const code = line.charCodeAt(index)
      if (quote === null && isWhitespaceCode(code)) break
      const char = line[index]
      if (char === '"' || char === "'") {
        if (quote === null) {
          const previous = index > 0 ? line[index - 1] : ''
          if (previous === '=' || previous === ':') quote = char
        } else if (quote === char) {
          quote = null
        }
      }
      index += 1
    }
    if (index === start) {
      let wsEnd = index
      while (wsEnd < line.length && isWhitespaceCode(line.charCodeAt(wsEnd))) wsEnd += 1
      pieces.push(line.slice(start, wsEnd))
      index = wsEnd
      continue
    }
    const token = line.slice(start, index)
    pieces.push(token.length > REDACT_MAX_SEGMENT ? '[REDACTED]' : token)
  }
  return pieces
}

/**
 * 超大文本的分段阈值（UTF-16 码元数，0.14.8）。
 *
 * 动机：V8 的正则在**单次超长匹配**上会抛 `RangeError: Maximum call stack size exceeded`
 * （实测：一条 ≥6 MiB、不含空白的连续串，`/[A-Za-z0-9_+/=.-]{32,}/` 直接爆栈）。0.14.7
 * 把单行上限提到 32 MiB 之后，一段约 9 MiB、没有空白的事件正文就能在脱敏阶段把适配器
 * 打崩，进而被误报成通道失败。分段后每次只让正则在 ≤256 KiB 的片段上工作。
 */
const REDACT_MAX_SEGMENT = 256 * 1024

/** 与分段边界一致的空白判定（不含 Unicode 全角空格，保持与既有词法口径一致）。 */
function isWhitespaceCode(code) {
  return code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d || code === 0x20
}

/**
 * 「值**整体**已是脱敏产物」的形态：可选的已知前缀 + `[REDACTED]`，此外什么都不许有。
 *
 * MAJOR-2（0.14.8）：旧实现只看 `value.includes('[REDACTED]')`，于是部分脱敏的值
 * （`ghp_[REDACTED];hunter2`）也被当成「已脱敏」整值放行，标记之后的残余秘密泄漏。
 * 前缀上限 24 字符覆盖既有产物（`github_pat_` / `glpat-` / `xoxb-` / `AIza` / `sk-` 等）。
 */
const FULLY_REDACTED_PATTERN = /^[A-Za-z0-9_-]{0,24}\[REDACTED\]$/

/**
 * 判断一个值（可能带外层单 / 双引号）是否**完整**的脱敏产物。
 *
 * 只放行 `[REDACTED]` / `ghp_[REDACTED]` 这类完整形态；标记前后还有任何其它字符
 * 都算「部分脱敏」，调用方必须按敏感值整值处理。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isFullyRedactedValue(value) {
  let text = String(value)
  const quote = text[0]
  if ((quote === '"' || quote === "'") && text.length >= 2 && text.endsWith(quote)) {
    text = text.slice(1, -1)
  }
  return FULLY_REDACTED_PATTERN.test(text)
}

/**
 * 有界片段上的完整脱敏规则（规则 0–5）。
 *
 * @param {unknown} raw
 * @returns {string}
 */
function redactSegment(raw) {
  let text = typeof raw === 'string' ? raw : String(raw ?? '')
  // 0) 显式凭据形态（0.14.7）。这类规则必须先于通用规则执行，否则会被规则 5 的
  //    「≥32 连续可疑字符」整段替换成 `[REDACTED]`、丢掉可识别前缀。输出统一保留前缀
  //    （`ghp_[REDACTED]` / `AKIA[REDACTED]` 等），便于排障；且二次执行不再匹配，保持幂等。
  //    PEM 私钥块：保留 BEGIN/END 头（能看出密钥类型），块体整体抹掉。
  text = text.replace(
    /-----BEGIN ((?:[A-Z0-9]+ )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    '-----BEGIN $1-----\n[REDACTED]\n-----END $1-----',
  )
  // AWS Access Key ID：`AKIA` + 固定 16 位大写/数字；两侧词边界防止把更长标识切一半。
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]')
  // AWS secret access key：只认显式 `…secret…access…key=` 形态，值限 base64 字符且
  // 至少 32 位（真实值 40 位），避免把 `too-short` 这类占位文本当凭据。
  text = text.replace(
    /\b((?:aws[_-]?)?secret[_-]?access[_-]?key)\b(\s*[:=]\s*)("[A-Za-z0-9/+=]{32,}"|'[A-Za-z0-9/+=]{32,}'|[A-Za-z0-9/+=]{32,})(?![A-Za-z0-9/+=])/gi,
    (match, name, separator) => `${name}${separator}"[REDACTED]"`,
  )
  // GitHub：经典 5 种前缀 + fine-grained PAT；长度下限按真实令牌留余量。
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, match => `${match.slice(0, 4)}[REDACTED]`)
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_[REDACTED]')
  // Slack：xox[bporase]- 与 xapp-。
  text = text.replace(/\b(xox[bporase]|xapp)-[A-Za-z0-9-]{10,}\b/g, '$1-[REDACTED]')
  // GitLab personal access token。
  text = text.replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, 'glpat-[REDACTED]')
  // Google API key：`AIza` + 35 位；两侧排除同类字符，不把更长串切一半。
  text = text.replace(/(?<![0-9A-Za-z_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, 'AIza[REDACTED]')
  // Stripe live secret / restricted key。
  text = text.replace(/\b((?:sk|rk)_live_)[A-Za-z0-9]{16,}\b/g, '$1[REDACTED]')
  // JWT：三段 base64url，保留 header 的 `eyJ` 前缀。
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    'eyJ[REDACTED]',
  )
  // 连接串：只抹 user:pass，保留 scheme / host / port 便于排障。
  text = text.replace(
    /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/)[^\s:/@]+:[^\s/@]+@/g,
    '$1[REDACTED]@',
  )
  // 1) Authorization 头的认证方案 + 凭据（Bearer / Basic / Token）。
  //    N9（复核2）：原先只认 Bearer，`Authorization: Basic <base64>` 会走到下面第 4 条
  //    的 key:value 规则——那条只把 `Basic` 当值抹掉，真正的 base64 凭据反而原样留下，
  //    还把外层字符串改坏。现在与 host-check.redactSensitiveText 同口径。
  //    规则 0 已把凭据换成 `ghp_[REDACTED]` 这类带前缀的标记；这里把标记形态纳入
  //    候选并放行，否则只吃掉 `ghp_`、把之前保留的前缀二次抹掉。引号形态允许标记
  //    之后还有残余字符（`"ghp_[REDACTED];hunter2"`），这样「部分脱敏」能被整值
  //    覆盖，而不是只匹配到标记、把残余秘密留在引号里。
  text = text.replace(
    /\b(Bearer|Basic|Token)\s+((?:"[A-Za-z0-9._~+/=-]*\[REDACTED\][^"]*"|'[A-Za-z0-9._~+/=-]*\[REDACTED\][^']*'|[A-Za-z0-9._~+/=-]*\[REDACTED\]|"[A-Za-z0-9._~+/=-]{4,}"|'[A-Za-z0-9._~+/=-]{4,}'|[A-Za-z0-9._~+/=-]{4,}))/gi,
    (match, scheme, credential) => (isFullyRedactedValue(credential) ? match : `${scheme} [REDACTED]`),
  )
  // 2) 敏感标志位：`--token <值>` / `--api-key=<值>` 等空格或等号分隔形态
  //    （N3 接线）。参数名必须完整（名字后只接受空白或 `=`），所以 `--token-file` /
  //    `--tokenize` 的后续正常文件名不会被吞；值只吃一个 shell 词，引号内可含空格。
  text = text.replace(SECRET_FLAG, (match, lead, flag, separator, doubleQuoted, singleQuoted) => {
    if (doubleQuoted !== undefined) return `${lead}${flag}${separator}"[REDACTED]"`
    if (singleQuoted !== undefined) return `${lead}${flag}${separator}'[REDACTED]'`
    return `${lead}${flag}${separator}[REDACTED]`
  })
  // 3) sk- 开头的 API key（保留前缀给排查看，值抹掉）
  text = text.replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-[REDACTED]')
  // 4) key: value / key=value / "key": "value" 形式（；，也算分隔符，中文句子里的多组凭据才不会漏）
  text = text.replace(
    // N7（复核2）：值必须排除 NUL / C0 控制字节 / DEL，否则 `token=<canary>\0tail`
    // 会把 `\0tail` 一起吞进 [REDACTED]，输出因此丢失非凭据字节。
    /(["']?(?:token|password|passwd|secret|api[_-]?key|authorization)["']?\s*[:=]\s*)("[^"\x00-\x1F\x7F]*"|'[^'\x00-\x1F\x7F]*'|[^\s,;&}；，\x00-\x1F\x7F]+)/gi,
    (match, prefix, value) => {
      if (/^(?:Bearer|Basic|Token)$/i.test(String(value).replace(/["']/g, ''))) return match
      // 规则 0 产出的带前缀标记（`ghp_[REDACTED]`、`glpat-[REDACTED]`）原样放行，
      // 避免 key=value 规则把前缀二次抹掉，也保证整体幂等。只放行**整体**脱敏的
      // 形态：标记之后还有残余字符（部分脱敏）必须继续按敏感值整值处理（MAJOR-2）。
      if (isFullyRedactedValue(value)) return match
      return `${prefix}"[REDACTED]"`
    },
  )
  // 5) 超长连续串（哈希 / JWT 片段 / 裸 token）：≥32 个不含空白的可疑字符。
  //    与 host-check.redactSensitiveText 的兼容差异：
  //      a. 必须至少跨两类字符才判敏感（见上方说明）；
  //      b. 路径形态（含 `/`，且每段都是 `[A-Za-z0-9._~-]+`）放行——custom executor
  //         的答案里经常出现 `/repo/.tmp/…/pwned`、`src/client/very-long-file-name.ts`
  //         这类 ≥32 字符的真实路径，按 engine 原规则会把路径中间整段替换成
  //         [REDACTED]，既破坏答案也不属于凭据泄露。真实凭据（Bearer / sk- /
  //         key=value / 混合类哈希、JWT）仍会被脱敏。
  text = text.replace(/[A-Za-z0-9_+/=.-]{32,}/g, (match) => {
    if (isPathLikeRun(match)) return match
    let classes = 0
    if (/[A-Z]/.test(match)) classes += 1
    if (/[a-z]/.test(match)) classes += 1
    if (/[0-9]/.test(match)) classes += 1
    if (/[^A-Za-z0-9]/.test(match)) classes += 1
    return classes >= 2 ? '[REDACTED]' : match
  })
  return text
}

/**
 * 判断规则 5 的候选串是否是路径（而非凭据）。
 *
 * 只看形态：至少一个 `/`，每段非空且只含 `A-Za-z0-9._~-`（绝对路径的首段为空，
 * 跳过）。URL 的 `//` 会产生空段，因此不会被误判成路径；JWT / 哈希通常不含 `/`。
 *
 * @param {string} match
 * @returns {boolean}
 */
function isPathLikeRun(match) {
  if (!match.includes('/')) return false
  const parts = match.split('/')
  if (parts.length < 2) return false
  if (parts[0] === '') parts.shift()
  return parts.length > 0 && parts.every(part => part !== '' && /^[A-Za-z0-9._~-]+$/.test(part))
}

/** 递归脱敏的内部实现：`seen` 只在当前路径上标记，离开时删除（共享引用不算环）。 */
function redactWalk(value, depth, seen) {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  // 深度 / 循环：返回占位符，绝不把更深的对象原样透出。
  if (depth >= REDACT_MAX_DEPTH) return REDACT_TRUNCATED
  if (seen.has(value)) return REDACT_TRUNCATED
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const out = []
      const max = Math.min(value.length, REDACT_MAX_KEYS)
      for (let index = 0; index < max; index += 1) {
        out.push(redactWalk(value[index], depth + 1, seen))
      }
      return out
    }
    const out = {}
    const keys = Object.keys(value)
    const max = Math.min(keys.length, REDACT_MAX_KEYS)
    for (let index = 0; index < max; index += 1) {
      const key = keys[index]
      let item
      try {
        item = value[key]
      } catch {
        // getter 抛错：跳过这一项，不把执行器带崩。
        continue
      }
      out[key] = redactWalk(item, depth + 1, seen)
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/**
 * 递归脱敏任意事件对象 / 数组 / 字符串。
 *
 * 约束：键数 ≤ `REDACT_MAX_KEYS`（64）、深度 ≤ `REDACT_MAX_DEPTH`（8）、循环引用安全
 * （WeakSet，按当前路径检测）；数字 / 布尔 / null 等非字符串原样返回。
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactDeep(value) {
  return redactWalk(value, 0, new WeakSet())
}

/** 找到一个 Buffer 里「完整的 UTF-8 前缀」长度：末尾不完整的多字节序列会被裁掉。 */
function completeUtf8PrefixLength(buffer) {
  const length = buffer.length
  if (length === 0) return 0
  let index = length - 1
  let continuation = 0
  // 从末尾往回最多跨 4 个字节找引导字节（UTF-8 单字符最长 4 字节）。
  while (index >= 0 && continuation < 4 && (buffer[index] & 0xc0) === 0x80) {
    index -= 1
    continuation += 1
  }
  if (index < 0) return length
  const lead = buffer[index]
  let need = 0
  if (lead >= 0xc2 && lead <= 0xdf) need = 2
  else if (lead >= 0xe0 && lead <= 0xef) need = 3
  else if (lead >= 0xf0 && lead <= 0xf4) need = 4
  else return length
  const available = length - index
  return available < need ? index : length
}

/** 从尾部切 `maxBytes` 字节的 UTF-8 文本；开头若落在半个字符上就向后对齐。 */
function utf8Tail(text, maxBytes) {
  if (text === '') return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  const tail = buffer.subarray(buffer.length - maxBytes)
  let start = 0
  // 丢掉开头的续字节（0b10xxxxxx），最多 3 个，保证不从字符中间开始。
  while (start < tail.length && start < 4 && (tail[start] & 0xc0) === 0x80) start += 1
  return tail.subarray(start).toString('utf8')
}

/**
 * 创建一份有界输出保留器。
 *
 * @param {{maxBytes?:number, maxEvents?:number, maxTail?:number}} [options]
 *   maxBytes：保留 / 接收字节上限（默认 8 MiB）；maxEvents：事件条数上限（默认 5000）；
 *   maxTail：`tail()` 默认上限（默认 16 KiB，且不会超过 maxBytes）。
 * @returns {{
 *   addRaw: (chunk: Buffer|string) => boolean,
 *   pushEvent: (event: unknown) => boolean,
 *   text: () => string,
 *   tail: (max?: number) => string,
 *   eventList: () => unknown[],
 *   readonly truncated: boolean,
 *   readonly limit: null|'bytes'|'events',
 *   readonly receivedBytes: number,
 *   readonly retainedBytes: number,
 *   readonly eventCount: number,
 * }}
 */
export function createBoundedOutput({ maxBytes, maxEvents, maxTail } = {}) {
  const byteLimit = positiveIntOr(maxBytes, DEFAULT_MAX_BYTES)
  const eventLimit = positiveIntOr(maxEvents, DEFAULT_MAX_EVENTS)
  const tailLimit = Math.min(positiveIntOr(maxTail, DEFAULT_MAX_TAIL), byteLimit)

  /** 已接收的原始字节数：单调递增，不因保留淘汰回退。 */
  let receivedBytes = 0
  /**
   * 保留的原始字节（前缀，最多 byteLimit 个）。按几何增长分配、只 copy 已保留部分，
   * 避免大量小 chunk 时 `Buffer.concat` 造成的 O(n²) 拷贝；容量上限就是 byteLimit。
   */
  let retained = Buffer.alloc(0)
  /** `retained[0, retainedRawBytes)` 是真实数据，其余是未使用的容量。 */
  let retainedRawBytes = 0
  /** 解码后的保留文本缓存；追加时失效。 */
  let decoded = null
  /** 解码文本的 UTF-8 字节数缓存。 */
  let decodedBytes = -1
  /**
   * 首个越界维度：`null` 未越界；`'bytes'` 字节超限；`'events'` 事件超限。
   * 恰好等于上限仍为 null（合法）。
   */
  let limit = null
  let truncated = false
  const events = []

  const invalidate = () => {
    decoded = null
    decodedBytes = -1
  }

  const appendRetained = (chunk) => {
    if (chunk.length === 0) return
    const needed = retainedRawBytes + chunk.length
    if (retained.length < needed) {
      // 惰性 + 几何增长：空 buffer 先给 4 KiB；之后翻倍，但绝不超过 byteLimit。
      const floor = Math.min(byteLimit, 4096)
      const target = Math.min(byteLimit, Math.max(needed, retained.length === 0 ? floor : retained.length * 2))
      const next = Buffer.allocUnsafe(target)
      retained.copy(next, 0, 0, retainedRawBytes)
      retained = next
    }
    chunk.copy(retained, retainedRawBytes)
    retainedRawBytes += chunk.length
    invalidate()
  }

  /**
   * 追加一段原始输出。
   *
   * 先按 Buffer / string 的原始 UTF-8 字节计数，再只保留剩余额度内的前缀；超过额度的
   * chunk 只接受剩余部分，并置 `limit='bytes'` / `truncated=true`。返回 false 表示
   * 本次追加越过了字节上限（调用方应转入 OUTPUT_LIMIT 收口）。
   *
   * @param {Buffer|string} chunk
   * @returns {boolean}
   */
  const addRaw = (chunk) => {
    if (chunk === undefined || chunk === null) return true

    if (typeof chunk === 'string') {
      if (chunk === '') return true
      const total = Buffer.byteLength(chunk, 'utf8')
      receivedBytes += total
      if (limit !== null) return false
      const remaining = byteLimit - retainedRawBytes
      if (remaining <= 0) {
        limit = 'bytes'
        truncated = true
        return false
      }
      if (total <= remaining) {
        appendRetained(Buffer.from(chunk, 'utf8'))
        return true
      }
      // 超大 chunk 不整段复制：先按字符数截到 remaining（每码元至少 1 字节，必然覆盖
      // remaining 个 UTF-8 字节），再按字节切到剩余额度。
      let partial = Buffer.from(chunk.slice(0, remaining), 'utf8')
      if (partial.length > remaining) partial = partial.subarray(0, remaining)
      appendRetained(partial)
      limit = 'bytes'
      truncated = true
      return false
    }

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (buffer.length === 0) return true
    receivedBytes += buffer.length
    if (limit !== null) return false
    const remaining = byteLimit - retainedRawBytes
    if (remaining <= 0) {
      limit = 'bytes'
      truncated = true
      return false
    }
    if (buffer.length <= remaining) {
      appendRetained(buffer)
      return true
    }
    appendRetained(buffer.subarray(0, remaining))
    limit = 'bytes'
    truncated = true
    return false
  }

  /**
   * 追加一条已规范化的输出事件。
   *
   * 恰好等于 `maxEvents` 仍合法；再多一条时置 `limit='events'`、不再入队并返回 false。
   *
   * @param {unknown} event
   * @returns {boolean}
   */
  const pushEvent = (event) => {
    if (limit !== null) return false
    if (events.length >= eventLimit) {
      limit = 'events'
      truncated = true
      return false
    }
    events.push(event)
    return true
  }

  /**
   * 保留的前缀文本。末尾不完整的多字节字符会被裁掉，因此永远不会返回半个字符，
   * 且 `Buffer.byteLength(text()) <= maxBytes`。
   *
   * @returns {string}
   */
  const text = () => {
    if (decoded !== null) return decoded
    const view = retained.subarray(0, retainedRawBytes)
    const complete = completeUtf8PrefixLength(view)
    decoded = view.subarray(0, complete).toString('utf8')
    decodedBytes = Buffer.byteLength(decoded, 'utf8')
    return decoded
  }

  /**
   * 保留文本的尾部，默认最多 `maxTail` 字节（不超过 `maxBytes`）。
   * 起点落在半个多字节字符上时会向后对齐，不会产生替换字符以外的噪音。
   *
   * @param {number} [max]
   * @returns {string}
   */
  const tail = (max) => {
    if (max === 0) return ''
    const requested = positiveIntOr(max, tailLimit)
    const effective = Math.max(0, Math.min(requested, tailLimit, byteLimit))
    if (effective === 0) return ''
    return utf8Tail(text(), effective)
  }

  /** 事件列表快照：返回副本，调用方不能通过 push/splice 绕过额度。 */
  const eventList = () => events.slice()

  return {
    addRaw,
    pushEvent,
    text,
    tail,
    eventList,
    get truncated() {
      return truncated
    },
    get limit() {
      return limit
    },
    get receivedBytes() {
      return receivedBytes
    },
    get retainedBytes() {
      // 用解码后的完整前缀字节数：不会把末尾半个字符算进保留额度。
      if (decodedBytes < 0) text()
      return decodedBytes
    },
    get eventCount() {
      return events.length
    },
  }
}
