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

/**
 * 文本脱敏（0.11 R3）。
 *
 * **与 `src/engine.js` 的 `redactArguments` 同源**：下面四条规则逐字复用，改动任一
 * 规则时必须同步两侧，避免「engine 日志已脱敏、executor 错误链仍漏 token」的分叉。
 * （不直接 import engine：engine 依赖 fs / runlog，executor 与 host-check 都需要保持
 * Host 侧窄依赖，反向 import 会形成环。）
 *
 * 覆盖：
 *   1. `Authorization: Bearer <token>`；
 *   2. `sk-...` API key（保留前缀，值抹掉）；
 *   3. `key: value` / `key=value` / `"key": "value"`（token / password / secret / api_key / authorization）；
 *   4. ≥32 个连续可疑字符（哈希 / JWT 片段 / 裸 token）。
 *
 * **规则 4 与 engine 的已知兼容差异（0.11 R3，需同步知晓）**：
 * engine 对任意 ≥32 的连续可疑字符一律脱敏；这里额外要求该串**同时包含至少两类字符**
 * （大写 / 小写 / 数字 / 符号 `_+/=.-`），并且对「路径形态」（含 `/` 且每段只含
 * `A-Za-z0-9._~-`，绝对 / 相对都算）的连续串放行。原因是既有 executor 自检同时依赖两件事：
 *   - `'x'.repeat(1500) + 'y'.repeat(1000)` 这种纯同类填充串验证 stderr 尾部裁剪；
 *   - `echo {prompt}` 原样回显 `/…/.tmp/…/pwned` 这类 ≥32 字符绝对路径，验证 prompt
 *     注入载荷没有被执行。
 * 若按 engine 原规则，前者被整体替换成 `[REDACTED]` 让尾部长度断言失去意义，后者会把
 * 路径中间整段抹掉、让「载荷原样输出」变成误报；连带 custom 答案里的 `src/…/长文件名.ts`
 * 也会被破坏。真实凭据（Bearer / sk- / key=value / 大小写数字混合的哈希、JWT 片段）仍然
 * 由规则 1–3 或「多类字符」覆盖；纯小写 / 纯数字 / 纯符号长填充串不按秘密处理。
 * 规则 1–3 与 engine 逐字一致，规则 4 的 `[A-Za-z0-9_+/=.-]{32,}` 候选范围也一致，只在
 * 替换前多做了「字符类别」与「路径形态」两次判断。**改 engine 规则 4 时必须同步这里
 * （或反向收敛为共享实现）。**
 *
 * @param {unknown} raw
 * @returns {string}
 */
/** 敏感标志位规则实例（`replace` 会重置 `lastIndex`，模块内串行调用安全）。 */
const SECRET_FLAG = new RegExp(SECRET_FLAG_PATTERN, 'gi')

export function redactText(raw) {
  let text = typeof raw === 'string' ? raw : String(raw ?? '')
  // 1) Authorization: Bearer <token>
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer [REDACTED]')
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
    /(["']?(?:token|password|passwd|secret|api[_-]?key|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}；，]+)/gi,
    (match, prefix, value) => {
      if (/^Bearer$/i.test(String(value).replace(/["']/g, ''))) return match
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
