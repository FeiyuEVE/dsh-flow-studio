/**
 * 外部进程输出的共享有界保留与脱敏原语（0.11 R3 / S2；0.15.1 转义感知）。
 *
 * 这个模块只做三件事，且刻意保持**零业务依赖**（除 `node:buffer` 外不 import 任何
 * src 内模块，也不 import fs / child_process）：
 *   1. `redactText`：共享的凭据脱敏规则（规则 0–5）。规则 4 / 2 的取值用线性扫描器，
 *      能识别 JSON / shell 转义、三引号、词内拼接、全角分隔符、箭头、YAML 块标量与
 *      反斜杠续行；不靠正则描述「值在哪里结束」。
 *   2. `isSensitiveKeyName` / `redactStructured`（0.15.2）：文本赋值与结构化对象的**同一套**
 *      键名判据（分词 + 敏感词表 + 误伤豁免），敏感键名下的值整体替换成 `[REDACTED]`；
 *      三个 CLI 适配器都走这一实现，不再各自维护「只对字符串脱敏」的本地副本。
 *      `redactDeep` 是保留 0.15.1 导出契约（`[TRUNCATED]` 占位符）的兼容包装。
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
 * 与 `host-check.js` 的关系（0.15.1 起）：**本模块不再 import host-check**（那会造成
 * 反向依赖且名单分叉）。敏感键名以 {@link SENSITIVE_KEY_NAME_SOURCE} 为唯一来源，
 * 由 host-check 反向复用来构造它的命令行标志位规则。
 *
 * @module @feiyueve/dsh-flow-studio/process-output
 */

import { Buffer } from 'node:buffer'

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

/** ≤1 MiB 的字符串不做「≥64 KiB 连续串预抹」的阈值（见 redactStringValue）。 */
const REDACT_OVERSIZE_TEXT_BYTES = 1024 * 1024

/** 递归遇到循环引用 / 超深对象时的占位符（绝不把未脱敏的深层对象原样透出）。 */
const REDACT_TRUNCATED = '[TRUNCATED]'

/** 非正 / 非安全整数一律回落到默认值。 */
function positiveIntOr(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * 敏感键名的**唯一名单**（不含 `--` 前缀）。
 *
 * `host-check.js` 反向 import 这一份构造它的命令行标志位规则，避免两处名单分叉
 * （0.15.1 之前 process-output 从 host-check import `SECRET_FLAG_PATTERN`，但只拿来
 * 构造了一个从未使用的 RegExp，属于死依赖）。
 */
export const SENSITIVE_KEY_NAME_SOURCE = '(?:token|password|passwd|secret|api[_-]?key|access[_-]?(?:token|key)|auth[_-]?token|secret[_-]?key|private[_-]?key|credentials?|authorization|cookie|session[_-]?key|ssh[_-]?key)'

/** 命令行标志位前缀 + 键名（`--token` / `-password` 等）。 */
const FLAG_NAME_SOURCE = `--?${SENSITIVE_KEY_NAME_SOURCE}`

/**
 * 赋值分隔符：`=` / `:` / 全角 `＝` `：` / 箭头 `=>` `->`（前后允许空白）。
 * 箭头必须排在单字符之前，否则 `=>` 只会吃掉 `=`，`>` 会变成值的一部分。
 */
const ARROW_SEPARATOR_SOURCE = '\\s*(?:=>|->)\\s*'
const ASSIGN_SEPARATOR_SOURCE = '\\s*[:=＝：]\\s*'

/**
 * 文本脱敏（0.11 R3；0.14.8 起支持超大输入；0.15.1 转义感知）。
 *
 * 保持纯函数：host-check 等调用方都需要它不依赖 fs / 存储层。
 *
 * 超大输入不切语义：先把「长度超过 {@link REDACT_MAX_RUN} 的可疑字符连续串」整体替换成
 * `[REDACTED]`（线性扫描，零正则），再让完整规则管线 {@link redactSegment} 在**整段文本**
 * 上跑一次。
 *
 * 为什么不能分段：分段必须选切点，而任何切点都可能落在一个敏感值里面
 * （`password= "…; hunter2"`、引号未闭合的值、跨行赋值……），0.14.8 / 0.14.9 两轮复审
 * 各抓到一种切法泄漏。现在不切：正则始终能看到完整上下文，代价只是把超长串提前抹掉
 * （它本来就会命中规则 4，同时这一步也避开了 V8 正则在超长匹配上爆栈）。
 *
 * @param {unknown} raw
 * @param {{capOversize?:boolean}} [options] `capOversize=false` 时不做 ≥64 KiB 连续串
 *   预抹（规则 5 仍会按「跨类字符」判敏感）。只给**有界**事件文本用：600 KiB 的合法
 *   `x…x` 输出不能被预抹成 `[REDACTED]`；超大输入仍走默认路径避开 V8 爆栈。
 * @returns {string}
 */
export function redactText(raw, options = {}) {
  const text = typeof raw === 'string' ? raw : String(raw ?? '')
  return redactSegment(options.capOversize === false ? text : capOversizeRuns(text))
}

/** 单次正则匹配允许的最大可疑串长度；超出的串先被整段抹掉，避免 V8 爆栈。 */
const REDACT_MAX_RUN = 64 * 1024

/**
 * 判断字符是否属于规则 4 的「可疑连续串」字符集 `[A-Za-z0-9_+/=.-]`。
 *
 * 只认 ASCII：与规则 4 的正则字符集逐字一致，避免中文 / emoji 把串切碎造成覆盖差异。
 *
 * @param {number} code
 * @returns {boolean}
 */
function isSuspiciousCode(code) {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x5f
    || code === 0x2b
    || code === 0x2f
    || code === 0x3d
    || code === 0x2e
    || code === 0x2d
}

/**
 * 抹掉超长可疑串（线性扫描，零正则）。
 *
 * 只处理长度 > {@link REDACT_MAX_RUN} 的连续串：它们必然命中规则 4，也正是会让 V8 正则
 * 爆栈的输入；其余文本原样保留，不做任何切分。
 *
 * @param {string} text
 * @returns {string}
 */
function capOversizeRuns(text) {
  if (text.length <= REDACT_MAX_RUN) return text
  let out = ''
  let cursor = 0
  let index = 0
  while (index < text.length) {
    if (!isSuspiciousCode(text.charCodeAt(index))) {
      index += 1
      continue
    }
    let end = index
    while (end < text.length && isSuspiciousCode(text.charCodeAt(end))) end += 1
    if (end - index > REDACT_MAX_RUN) {
      out += text.slice(cursor, index) + '[REDACTED]'
      cursor = end
    }
    index = end
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}

/**
 * 「值**整体**已是脱敏产物」的形态：`[REDACTED]` 本身，或**已知方案前缀 + 标记**。
 *
 * MAJOR-2（0.14.8）之后又发现另一个方向的漏洞（0.15.1）：旧实现放行任意 ≤24 字符的
 * 前缀，于是 `password="hunter2[REDACTED]"` 被当成「已脱敏」整值保留，`hunter2` 裸奔。
 * 现在只认规则 0/1 自己产出的前缀（`ghp_` / `glpat-` / `AKIA` / `Bearer ` 等）；前缀
 * 之外多一个字符都不算完整脱敏。
 */
const FULLY_REDACTED_PATTERN = new RegExp(
  '^(?:\\[REDACTED\\]'
  + '|(?:gh[pousr]_|github_pat_|glpat-|xox[bporase]-|xapp-|AIza|sk-|sk_live_|rk_live_|AKIA|eyJ)\\s*\\[REDACTED\\]'
  + '|(?:Bearer|Basic|Token|SSWS)\\s+\\[REDACTED\\])$',
)

/**
 * 判断一个值（可能带外层单 / 双引号）是否**完整**的脱敏产物。
 *
 * 只放行 `[REDACTED]` / `ghp_[REDACTED]` / `Bearer [REDACTED]` 这类完整形态；标记前后
 * 还有任何其它字符都算「部分脱敏」，调用方必须按敏感值整值处理。
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
 * PEM 私钥块的**有界**替换（0.15.2 / M5）。
 *
 * 0.15.1 用非贪婪正则 `-----BEGIN …-----[\s\S]*?-----END …-----`：`END` 不存在时每个
 * `BEGIN` 都一路扫到文末再失败，重复 N 个 `BEGIN` 就是 O(N²)（7 KiB 1 ms → 105 KiB
 * 100 ms → 1 MiB 约 10 s）。不可信子进程输出能借此长时间阻塞事件循环。
 *
 * 现在只在 BEGIN 头之后 {@link PEM_END_WINDOW} 字节内找 END：
 *   - 窗口内找到：块体替换成 `[REDACTED]`，保留可识别的 BEGIN/END 头；
 *   - 窗口内没有：认定这是残缺 / 伪造块，**从该 BEGIN 到文末整段替换成 `[REDACTED]`
 *     并停止扫描**（安全方向，同时保证整体线性）；
 *   - 非私钥类型（PUBLIC KEY / CERTIFICATE / 其它）跳过，不误伤。
 *
 * 复杂度：每处理一个完整块只做一次 ≤8 KiB 的 `indexOf`，所有块的扫描区间不重叠，
 * 最坏 O(n)；无 END 的输入在第一个 BEGIN 处就收口。
 *
 * @param {string} text
 * @returns {string}
 */
const PEM_BEGIN_MARKER = '-----BEGIN '
const PEM_PRIVATE_TYPE_PATTERN = /^(?:[A-Z0-9]+ )?PRIVATE KEY$/
const PEM_END_WINDOW = 8 * 1024

function redactPemBlocks(text) {
  let index = text.indexOf(PEM_BEGIN_MARKER)
  if (index === -1) return text
  let out = ''
  let cursor = 0
  while (index !== -1) {
    const typeStart = index + PEM_BEGIN_MARKER.length
    const typeEnd = text.indexOf('-----', typeStart)
    if (typeEnd === -1) break
    const type = text.slice(typeStart, typeEnd)
    if (type.length === 0 || type.length > 64 || !PEM_PRIVATE_TYPE_PATTERN.test(type)) {
      index = text.indexOf(PEM_BEGIN_MARKER, typeEnd + 5)
      continue
    }
    const endMarker = `-----END ${type}-----`
    const windowStart = typeEnd + 5
    const hit = text.indexOf(endMarker, windowStart)
    const end = hit !== -1 && hit + endMarker.length <= Math.min(text.length, windowStart + PEM_END_WINDOW)
      ? hit + endMarker.length
      : -1
    if (end === -1) {
      // 窗口内没有 END：残缺 / 伪造块，整段到文末替换并停止（安全方向 + 线性）。
      return out + text.slice(cursor, index) + '[REDACTED]'
    }
    out += text.slice(cursor, index) + `-----BEGIN ${type}-----\n[REDACTED]\n${endMarker}`
    cursor = end
    index = text.indexOf(PEM_BEGIN_MARKER, end)
  }
  return out === '' ? text : out + text.slice(cursor)
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
  //    PEM 私钥块：保留 BEGIN/END 头（能看出密钥类型），块体整体抹掉；有界线性扫描（M5）。
  text = redactPemBlocks(text)
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
  //    裸方案名（`ApiKey` / `SSWS` / 其它）由规则 4 的 Authorization 分支处理。
  text = text.replace(
    /\b(Bearer|Basic|Token)\s+((?:"[A-Za-z0-9._~+/=-]*\[REDACTED\][^"]*"|'[A-Za-z0-9._~+/=-]*\[REDACTED\][^']*'|[A-Za-z0-9._~+/=-]*\[REDACTED\]|"[A-Za-z0-9._~+/=-]{4,}"|'[A-Za-z0-9._~+/=-]{4,}'|[A-Za-z0-9._~+/=-]{4,}))/gi,
    (match, scheme, credential) => (isFullyRedactedValue(credential) ? match : `${scheme} [REDACTED]`),
  )
  // 2) 敏感标志位：`--token <值>` / `--api-key=<值>`。参数名必须完整（名字后只接受
  //    空白或 `=` / 全角分隔符 / 箭头），所以 `--token-file` / `--tokenize` 的后续正常
  //    文件名不会被吞。值同样交给扫描器：引号内可以跨行 / 含 TAB / 带转义引号 /
  //    没有收尾引号，正则版会在这里各截断一种（与规则 4 同源问题）。
  text = redactFlagValues(text)
  // 3) sk- 开头的 API key（保留前缀给排查看，值抹掉）
  text = text.replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-[REDACTED]')
  // 4) 敏感键赋值：`token=…` / `password: …` / `"api_key": "…"`。
  //    这里**不用正则**完成取值：敏感值可能带引号、引号内可能跨行 / 带 TAB / 含转义引号，
  //    也可能根本没收尾；还可能是 JSON / shell 转义、三引号、YAML 块标量、反斜杠续行。
  //    扫描器按「键 + 分隔符 + 值」逐段取值，整值替换成 `"[REDACTED]"`。
  text = redactAssignedValues(text)
  // 4b) JSON 键值对数组：`["password","hunter2"]`（m1）。没有 `=` / `:`，单独一遍。
  text = redactJsonPairValues(text)
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

/**
 * 值结束判据（不带引号时）：空白 / `,` / `;` / `&` / `}` / 中文标点。
 *
 * @param {string} char
 * @returns {boolean}
 */
function isValueDelimiter(char) {
  if (char === undefined) return true
  if (char.charCodeAt(0) <= 0x20) return true
  return char === ',' || char === ';' || char === '&' || char === '}' || char === '；' || char === '，'
}

/**
 * 从一个值的起点找「键名」上下文：只有 `authorization` 需要把 `方案名 + 凭据` 当整体。
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeKeyName(name) {
  return String(name ?? '').replace(/["'\s]/g, '').toLowerCase()
}

// ---------------------------------------------------------------------------
// 敏感键名判定（0.15.2：文本赋值与结构化键名共用同一实现）
// ---------------------------------------------------------------------------

/**
 * 键名里不携带语义的字符：零宽空格 / 零宽连接符 / 方向控制 / BOM / 软连字符。
 * 攻击者可以把 `pass\u200Bword` 写成「看起来一样但正则不命中」的键名。
 */
const KEY_IGNORABLE_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g

/** 中文 / 日文里直接成词的敏感键（在归一化后的整串上做子串判定）。 */
const SENSITIVE_CJK_WORDS = [
  '密码', '密碼', '密钥', '金钥', '金鑰', '令牌', '口令', '凭证', '憑證', '凭据',
]

/**
 * 逐词命中表（归一化后的小写 ASCII 词）。
 *
 * 0.15.1 的 `SENSITIVE_KEY_SUFFIXES` 只做后缀匹配，`credential` / `auth` / `pwd` /
 * `passphrase` / `token2` / `passwordHash` / 中文键全部绕过（复审 M3）。这里改成
 * 「分词 + 词表」：`passwordHash` 先被拆成 `password` / `hash`，`token2` 拆成
 * `token` / `2`，`pass_word` 拆成 `pass` / `word` 后仍按子串判据命中 `password`。
 */
const SENSITIVE_KEY_WORDS = new Set([
  'password', 'passwords', 'passwd', 'pwd', 'passphrase', 'passphrases', 'passcode',
  'secret', 'secrets', 'token', 'tokens', 'apikey', 'credential', 'credentials',
  'cred', 'auth', 'authorization', 'authorisation', 'privatekey', 'accesskey',
  'secretkey', 'authkey', 'sessionkey', 'sshkey', 'cookie', 'cookies', 'bearer',
  'jwt', 'otp', 'key',
])

/**
 * 子串判据：词里只要出现这些片段就按凭据处理。`apikey` / `privatekey` 这类
 * 全小写连写词靠它命中；单独一个 `key` 词则连同 `_` / `-` / camelCase 分词后的
 * `api_key` / `access-key` / `secretKey` 一起命中。
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'credential',
  'apikey', 'privatekey', 'accesskey', 'secretkey', 'authkey', 'sessionkey',
  'sshkey', 'key',
]

/**
 * 误伤豁免词（复审要求显式列出并写进测试）。
 *
 * 这些词里含 `key` / `token` / `secret` 片段，但都不是凭据：
 *   - 输入设备 / 键盘布局 / 文档概念：`keyboard`、`keyspace`、`keyword`、`keynote`、
 *     `keystone`、`keyframe`、`keypress`、`keydown`、`keyup`、`hotkey`、`keycode`、
 *     `keymap`；
 *   - 动物 / 饮品等英文常用词：`monkey`、`donkey`、`turkey`、`hockey`、`whiskey`；
 *   - 公开材料：`publickey`、`pubkey`（公钥不是秘密）；
 *   - 解析器术语：`tokenizer`、`tokenizers`、`tokenize`、`tokenized`、`tokenizing`、
 *     `tokenization`；
 *   - 其它常见非凭据词：`secretary`、`secretaries`、`secretion`、`passwordless`。
 *
 * 注意豁免是**逐词**生效：`monkeyToken` 拆成 `monkey` + `token`，`monkey` 被豁免后
 * 仍会被 `token` 命中——豁免不会给复合键开后门。
 */
const SENSITIVE_KEY_EXEMPT_WORDS = new Set([
  'keyboard', 'keyboards', 'keyspace', 'keyspaces', 'keyword', 'keywords',
  'keynote', 'keynotes', 'keystone', 'keyframe', 'keyframes', 'keypress', 'keydown',
  'keyup', 'hotkey', 'hotkeys', 'keycode', 'keymap',
  'monkey', 'monkeys', 'donkey', 'donkeys', 'turkey', 'turkeys', 'hockey', 'whiskey',
  'publickey', 'pubkey',
  'tokenizer', 'tokenizers', 'tokenize', 'tokenized', 'tokenizing', 'tokenization',
  'secretary', 'secretaries', 'secretion', 'passwordless',
])

/** 解码 `\u0070` / `\x70` / `&#112;` / `&#x70;` / `&quot;` 形式的键名。 */
function decodeEscapedKeyName(raw) {
  const decodeCodePoint = (text, hex, radix) => {
    const codePoint = Number.parseInt(hex, radix)
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return text
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return text
    }
  }
  return String(raw ?? '')
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (match, hex) => decodeCodePoint(match, hex, 16))
    .replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => decodeCodePoint(match, hex, 16))
    .replace(/\\x([0-9a-fA-F]{2})/g, (match, hex) => decodeCodePoint(match, hex, 16))
    .replace(/&#x([0-9a-fA-F]{1,6});/gi, (match, hex) => decodeCodePoint(match, hex, 16))
    .replace(/&#([0-9]{1,7});/g, (match, dec) => decodeCodePoint(match, dec, 10))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
}

/**
 * 键名分词：camelCase / PascalCase / snake_case / kebab-case / 数字边界。
 *
 * @param {string} name
 * @returns {string[]}
 */
function splitKeyNameWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
}

/**
 * 判断对象键名 / 赋值左侧的键名是否敏感（**唯一实现**，文本规则与结构化规则共用）。
 *
 * 0.15.2 之前有两套口径：文本赋值只认 6 个键名（M1），`redactDeep` 只做后缀匹配
 * （M3），三个适配器的本地 `redactValue` 则完全不看键名（B1）。三处现在都走这里。
 *
 * 判定顺序：
 *   1. 解码转义（`\u0070assword`）、NFKC 归一（全角 → 半角）、去掉零宽控制字符；
 *   2. 中文敏感词直接子串命中（`用户密码` 这类复合词）；
 *   3. 分词后逐词判：豁免词跳过 → 词表精确命中 → 敏感片段子串命中。
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSensitiveKeyName(name) {
  const decoded = decodeEscapedKeyName(name)
    .replace(KEY_IGNORABLE_PATTERN, '')
    .normalize('NFKC')
    .toLowerCase()
  if (decoded === '') return false
  for (const word of SENSITIVE_CJK_WORDS) {
    if (decoded.includes(word)) return true
  }
  const words = splitKeyNameWords(decoded)
  // 整串豁免（`publicKey` 分词后是 `public` + `key`，但它是公开材料，不是秘密）。
  if (SENSITIVE_KEY_EXEMPT_WORDS.has(words.join(''))) return false
  for (const word of words) {
    if (SENSITIVE_KEY_EXEMPT_WORDS.has(word)) continue
    if (SENSITIVE_KEY_WORDS.has(word)) return true
    for (const fragment of SENSITIVE_KEY_FRAGMENTS) {
      if (word.includes(fragment)) return true
    }
  }
  // 分隔符把敏感词切断的复合键（`pass_word` / `secret_key` / `access-key`）：
  // 把「非豁免词」重新拼起来再判一次，这样 `keyboard_layout` 不会因为 `key` 被误伤。
  const significant = words.filter(word => !SENSITIVE_KEY_EXEMPT_WORDS.has(word))
  if (significant.length > 1) {
    const compact = significant.join('')
    for (const fragment of SENSITIVE_KEY_FRAGMENTS) {
      if (compact.includes(fragment)) return true
    }
  }
  return false
}

/**
 * 命令行标志位取值与替换（线性扫描，见规则 2 的说明）。
 *
 * 与规则 4 共用 {@link parseAssignedValue}：带引号时允许跨行 / TAB / 转义，没闭合就把
 * 剩余文本都算作值；替换时保留原来的引号风格。
 *
 * @param {string} text
 * @returns {string}
 */
function redactFlagValues(text) {
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_-])(${FLAG_NAME_SOURCE})(${ARROW_SEPARATOR_SOURCE}|${ASSIGN_SEPARATOR_SOURCE}|\\s+)`,
    'gi',
  )
  let out = ''
  let cursor = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    const prefix = `${match[1]}${match[2]}${match[3]}`
    const valueStart = match.index + prefix.length
    const parsed = parseAssignedValue(text, valueStart, { key: normalizeKeyName(match[2]) })
    if (parsed === null) continue
    out += text.slice(cursor, match.index) + prefix
    if (parsed.keep) {
      out += text.slice(valueStart, parsed.end)
    } else if (parsed.replacement !== undefined) {
      out += parsed.replacement
    } else if (parsed.quote === '"') {
      out += parsed.escaped ? '\\"[REDACTED]\\"' : '"[REDACTED]"'
    } else if (parsed.quote === "'") {
      out += parsed.escaped ? "\\'[REDACTED]\\'" : "'[REDACTED]'"
    } else {
      out += '[REDACTED]'
    }
    cursor = parsed.end
    pattern.lastIndex = Math.max(parsed.end, pattern.lastIndex)
  }
  return out + text.slice(cursor)
}

/**
 * 赋值分隔符：`=>` / `->` 必须排在 `=` 前（否则只会吃掉 `=`，`>` 变成值的一部分）。
 * `g` 正则用于**从左到右**找分隔符；键名/值都交给扫描器，不再由正则描述。
 */
const ASSIGN_SEPARATOR_GLOBAL = /=>|->|[:=＝：]/g

/** 键名字符（ASCII）：字母 / 数字 / `_` / `-` / `.` / `$`。 */
function isAsciiKeyNameChar(char) {
  const code = char.charCodeAt(0)
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || char === '_'
    || char === '-'
    || char === '.'
    || char === '$'
}

/** 键名反向扫描的最大长度：超过这个长度的「键」必然不是配置键，直接放弃。 */
const KEY_NAME_SCAN_MAX = 128

/** 命令行标志位是否由规则 2 全权处理（要求**完整**名字，`token-file` 不算 `token`）。 */
const FULL_SENSITIVE_FLAG_PATTERN = new RegExp(`^(?:${SENSITIVE_KEY_NAME_SOURCE})$`, 'i')

/** 去掉键名两侧的引号与 JSON 转义（`\"password\"` / `['password']`）。 */
function stripKeyNameWrapping(raw) {
  let text = String(raw ?? '').trim()
  text = text.replace(/^\\*["']/, '').replace(/["']\\*$/, '')
  return text.trim()
}

/**
 * 从一个赋值分隔符**向左**读键名，并判定它是否敏感（0.15.2：与结构化键名同一判据）。
 *
 * 覆盖形态：
 *   - `password=` / `pass_word=` / `passwordHash=` / `token2=` / `密码：`；
 *   - `"password":` / `'password':`；
 *   - JSON 转义 `\"password\":` 与双重转义 `\\\"password\\\":`（B3：键名容错反斜杠）；
 *   - 方括号索引 `config["password"]=`（m1）；
 *   - `\u0070assword=` / `&#112;assword=` / 零宽 / 全角键名（m1）。
 *
 * 命令行标志位（`--token=`）不在这里处理：规则 2 的输出形态不同，而且
 * `--token-file=` 这类**更长**的参数名不能被当成 `--token`（既有反例锁）。
 *
 * @param {string} text
 * @param {number} separatorStart
 * @returns {null|{key:string}}
 */
function readSensitiveKeyBefore(text, separatorStart) {
  let keyEnd = separatorStart - 1
  while (keyEnd >= 0 && (text[keyEnd] === ' ' || text[keyEnd] === '\t')) keyEnd -= 1
  if (keyEnd < 0) return null

  // 方括号索引：config["password"] / obj['pass_word'] / config[\"password\"]
  if (text[keyEnd] === ']') {
    // 有界回扫：不用 `lastIndexOf`——恶意输入里大量 `]=` 会让每次回扫都走到文首（O(n²)）。
    let open = -1
    for (let cursor = keyEnd - 1, steps = 0; cursor >= 0 && steps < KEY_NAME_SCAN_MAX; cursor -= 1, steps += 1) {
      if (text[cursor] === '[') {
        open = cursor
        break
      }
      if (text[cursor] === '\n' || text[cursor] === ']') break
    }
    if (open === -1) return null
    const inner = stripKeyNameWrapping(text.slice(open + 1, keyEnd))
    if (inner === '' || inner.length > KEY_NAME_SCAN_MAX) return null
    return isSensitiveKeyName(inner) ? { key: inner } : null
  }

  // 值侧收尾引号（含 JSON 的 `\"` / `\\\"`）：跳过引号与紧挨着的反斜杠。
  if (text[keyEnd] === '"' || text[keyEnd] === "'") {
    keyEnd -= 1
    while (keyEnd >= 0 && text[keyEnd] === '\\') keyEnd -= 1
  }

  let scan = keyEnd
  let scanned = 0
  while (scan >= 0 && scanned < KEY_NAME_SCAN_MAX) {
    const char = text[scan]
    if (isAsciiKeyNameChar(char) || char.charCodeAt(0) >= 0x80) {
      scan -= 1
      scanned += 1
      continue
    }
    // 键名里的 Unicode 转义：`\u0070assword`（反斜杠不是普通键名字符，只认 \u / \x）。
    if (char === '\\' && (text[scan + 1] === 'u' || text[scan + 1] === 'x')) {
      scan -= 1
      scanned += 1
      continue
    }
    break
  }
  if (scan === keyEnd) return null
  let rawKey = text.slice(scan + 1, keyEnd + 1)

  // 开引号 + 前面的反斜杠（JSON 转义）不参与键名判定。
  let beforeKey = scan
  if (text[beforeKey] === '"' || text[beforeKey] === "'") {
    beforeKey -= 1
    while (beforeKey >= 0 && text[beforeKey] === '\\') beforeKey -= 1
  }

  // CLI 标志位：`-password` / `--password` 交给规则 2（输出形态不同）；
  // `--token-file` 这类更长参数名既不归规则 2、也不能按 `token` 吞掉后面的值。
  const dashes = /^-+/.exec(rawKey)
  if (dashes !== null) {
    const flagName = rawKey.slice(dashes[0].length)
    if (flagName === '') return null
    if (FULL_SENSITIVE_FLAG_PATTERN.test(flagName)) return null
    if (flagName.includes('-')) return null
    rawKey = flagName
  } else if (beforeKey >= 0 && text[beforeKey] === '-') {
    return null
  }

  if (rawKey === '' || rawKey.length > KEY_NAME_SCAN_MAX) return null
  return isSensitiveKeyName(rawKey) ? { key: rawKey } : null
}

/**
 * 敏感键赋值的取值与替换（线性扫描，见规则 4 的说明）。
 *
 * 0.15.2：键名判定从「6 个键名的正则」改成 {@link readSensitiveKeyBefore} +
 * {@link isSensitiveKeyName}，与结构化脱敏共用同一份词表；因此 `secret_key` /
 * `access_key` / `private_key` / `pwd` / `pass_word` / `passphrase` / `credential` /
 * `auth` / `token2` / `passwordHash` 与中文键都能命中（M1 / M3）。
 *
 * @param {string} text
 * @returns {string}
 */
function redactAssignedValues(text) {
  const pattern = ASSIGN_SEPARATOR_GLOBAL
  pattern.lastIndex = 0
  let out = ''
  let cursor = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    const separatorStart = match.index
    const separatorEnd = separatorStart + match[0].length
    if (separatorEnd <= cursor) {
      pattern.lastIndex = cursor
      continue
    }
    const keyInfo = readSensitiveKeyBefore(text, separatorStart)
    if (keyInfo === null) continue
    let valueStart = separatorEnd
    while (valueStart < text.length && (text[valueStart] === ' ' || text[valueStart] === '\t')) valueStart += 1
    if (valueStart >= text.length) continue
    const parsed = parseAssignedValue(text, valueStart)
    if (parsed === null || parsed.end <= valueStart) continue
    out += text.slice(cursor, valueStart)
    if (parsed.keep) {
      out += text.slice(valueStart, parsed.end)
    } else if (parsed.replacement !== undefined) {
      out += parsed.replacement
    } else if (parsed.escaped && parsed.quote === '"') {
      out += '\\"[REDACTED]\\"'
    } else if (parsed.escaped && parsed.quote === "'") {
      out += "\\'[REDACTED]\\'"
    } else {
      out += '"[REDACTED]"'
    }
    cursor = parsed.end
    // 从值后面继续：值内部即使再出现 `password=` 也不重复处理（保持一次替换的语义）。
    pattern.lastIndex = Math.max(parsed.end, pattern.lastIndex)
  }
  return out + text.slice(cursor)
}

/**
 * JSON 键值对数组：`["password","hunter2"]` / `[\"password\",\"hunter2\"]`（m1）。
 *
 * 这种形态没有 `=` / `:`，走不到赋值扫描器；只替换值字符串，键保留（结构不变）。
 * 反斜杠前缀与引号必须成对：`[\"key\", \"value\"]` 的收尾引号也带同样的反斜杠前缀。
 */
const JSON_PAIR_PREFIX_PATTERN = /\[\s*(\\*)(["'])([^"'\\]{1,80})\1\2\s*,\s*/g
const JSON_PAIR_VALUE_OPEN_PATTERN = /(\s*)(\\*)(["'])/y

function redactJsonPairValues(text) {
  if (text.indexOf('[') === -1) return text
  const pattern = JSON_PAIR_PREFIX_PATTERN
  pattern.lastIndex = 0
  let out = ''
  let cursor = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    const key = match[3]
    if (!isSensitiveKeyName(key)) continue
    JSON_PAIR_VALUE_OPEN_PATTERN.lastIndex = pattern.lastIndex
    const open = JSON_PAIR_VALUE_OPEN_PATTERN.exec(text)
    if (open === null) continue
    const quote = open[3]
    const escape = open[2]
    let index = JSON_PAIR_VALUE_OPEN_PATTERN.lastIndex
    let close = -1
    while (index < text.length) {
      if (text[index] !== quote) {
        index += 1
        continue
      }
      let run = 0
      while (index - run - 1 >= 0 && text[index - run - 1] === '\\') run += 1
      if (run === escape.length) {
        close = index
        break
      }
      index += 1
    }
    if (close === -1) break
    const trailing = close + 1
    let after = trailing
    while (after < text.length && (text[after] === ' ' || text[after] === '\t')) after += 1
    if (text[after] !== ']') {
      pattern.lastIndex = trailing
      continue
    }
    out += text.slice(cursor, JSON_PAIR_VALUE_OPEN_PATTERN.lastIndex) + '[REDACTED]'
    // 收尾引号自己的反斜杠前缀（`\"` 里的 `\`）要保留，cursor 回退 escape.length。
    cursor = close - escape.length
    pattern.lastIndex = trailing
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}


/**
 * 扫描一个带引号的值（`start` 是引号后的第一个字符）。
 *
 * 两种模式：
 *   - 普通引号：`\` 转义下一个字符（`\"` 不是收尾），同种未转义引号收尾；
 *   - **转义引号开头**（`\"` / `\'`，即 JSON 序列化后的文本）：收尾标记也是 `\"` /
 *     `\'`；值内的 `\n` / `\t` / `\\` 只是转义序列，不会被当成真正的换行 / 反斜杠。
 *
 * @param {string} text
 * @param {number} start
 * @param {string} quote
 * @param {boolean} escapedOpen
 * @returns {{end:number, bodyEnd:number, closed:boolean}}
 */
function scanQuotedValue(text, start, quote, escapedOpen) {
  let index = start
  if (escapedOpen) {
    // B3：转义引号开头的值是**一层 JSON 序列化之后**的字符串。收尾引号不能只看
    // 「`\` + 引号」——值里可能还有 `\\\"`（转义反斜杠 + 转义引号），1 个反斜杠的
    // 收尾标记和 3 个反斜杠的内嵌引号必须靠**连续反斜杠奇偶**区分（奇数 = 转义）。
    let backslashes = 0
    while (index < text.length) {
      const char = text[index]
      if (char === '\\') {
        const next = text[index + 1]
        if (next === undefined) {
          return { end: text.length, bodyEnd: text.length, closed: false }
        }
        // `\uXXXX` 按一个「解码后的字符」处理：它可能解码成引号或反斜杠。
        if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
          const decoded = String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16))
          if (decoded === '\\') {
            backslashes += 1
            index += 6
            continue
          }
          if (decoded === quote) {
            if (backslashes % 2 === 1) {
              backslashes = 0
              index += 6
              continue
            }
            return { end: index + 6, bodyEnd: index, closed: true }
          }
          backslashes = 0
          index += 6
          continue
        }
        if (next === '\\') {
          backslashes += 1
          index += 2
          continue
        }
        if (next === quote) {
          if (backslashes % 2 === 1) {
            backslashes = 0
            index += 2
            continue
          }
          return { end: index + 2, bodyEnd: index, closed: true }
        }
        backslashes = 0
        index += 2
        continue
      }
      if (char === quote && backslashes % 2 === 0) {
        return { end: index + 1, bodyEnd: index, closed: true }
      }
      backslashes = 0
      index += 1
    }
    return { end: text.length, bodyEnd: text.length, closed: false }
  }
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) {
      return { end: index + 1, bodyEnd: index, closed: true }
    }
    index += 1
  }
  return { end: text.length, bodyEnd: text.length, closed: false }
}

/**
 * 引号闭合后继续吃「词内拼接」：shell 的 `"abc"hunter2` / `""hunter2` / SQL 的
 * `'it''s hunter2'` 都是同一个词，必须整体当作一个值。
 *
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
function consumeWordTail(text, from) {
  let index = from
  while (index < text.length) {
    const char = text[index]
    if (isValueDelimiter(char)) break
    if (char === '"' || char === "'") {
      const segment = scanQuotedValue(text, index + 1, char, false)
      index = segment.end
      continue
    }
    if (char === '\\' && (text[index + 1] === '"' || text[index + 1] === "'" || text[index + 1] === '\\')) {
      index += 2
      continue
    }
    index += 1
  }
  return index
}

/**
 * 扫描不带引号的值：遇到真分隔符停止；`\` + 换行是**续行**，续行后的缩进与同一行的
 * 剩余部分仍属于这个值（0.15.1 复审的 `password= \\<换行>  hunter2`）。
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function scanBareValue(text, start, stopAtQuote = false) {
  let index = start
  while (index < text.length) {
    const char = text[index]
    if (stopAtQuote && (char === '"' || char === "'")) break
    if (char === '\\') {
      const next = text[index + 1]
      if (next === '\r' || next === '\n') {
        index += 1
        while (index < text.length && (text[index] === '\r' || text[index] === '\n'
          || text[index] === ' ' || text[index] === '\t')) {
          index += 1
        }
        continue
      }
      if (next === undefined) {
        index += 1
        continue
      }
      // `\n` / `\t` / `\\` / `\"` 都是转义序列，不让被转义的字符充当分隔符。
      index += 2
      continue
    }
    if (isValueDelimiter(char)) break
    index += 1
  }
  return index
}

/**
 * YAML 块标量（`password: |` / `password: >-` + 缩进后续行）。
 *
 * 块体可以含任意内容（包括空行与更深的缩进），一直吃到第一个「非空且不缩进」的行为止；
 * 到文本末尾仍未结束就整段算值（安全方向）。
 *
 * @param {string} text
 * @param {number} start
 * @returns {null | {end:number, keep:boolean, quote:null}}
 */
function parseYamlBlockValue(text, start) {
  const indicator = text[start]
  if (indicator !== '|' && indicator !== '>') return null
  let cursor = start + 1
  if (text[cursor] === '+' || text[cursor] === '-') cursor += 1
  const lineEnd = text.indexOf('\n', cursor)
  if (lineEnd === -1) {
    // 只有 `|` 没有换行：指示符本身就是全部值。
    return text.slice(cursor).trim() === '' ? { end: text.length, keep: false, quote: null } : null
  }
  const restOfLine = text.slice(cursor, lineEnd).replace(/\r$/, '')
  if (!/^[ \t]*$/.test(restOfLine)) return null
  let end = lineEnd + 1
  while (end < text.length) {
    const next = text.indexOf('\n', end)
    const stop = next === -1 ? text.length : next
    const line = text.slice(end, stop).replace(/\r$/, '')
    if (line.trim() !== '' && !/^[ \t]/.test(line)) break
    end = next === -1 ? text.length : next + 1
    if (next === -1) break
  }
  // 保留块尾的换行：替换文本紧挨下一个键会变成「词内拼接」，二次脱敏把下一个键吞掉。
  if (end > 0 && text[end - 1] === '\n') end -= 1
  if (end > 0 && text[end - 1] === '\r') end -= 1
  return { end, keep: false, quote: null }
}

/**
 * 已知认证方案词（大小写不敏感）。
 *
 * 规则 1 只覆盖 `Bearer` / `Basic` / `Token`；赋值右侧仍可能出现 `ApiKey` / `SSWS`
 * 这类方案词（m1：`token=ApiKey hunter2`）。认出来以后保留方案名、只抹凭据，
 * 而不是把 `ApiKey` 当值替换掉、把真正的 `hunter2` 留在后面。
 */
const AUTH_SCHEME_WORDS = new Set([
  'bearer', 'basic', 'token', 'apikey', 'ssws', 'digest', 'negotiate', 'ntlm',
  'hawk', 'oauth', 'oauth2', 'aws4-hmac-sha256', 'sigv4',
])

/**
 * YAML 值修饰符：`&anchor` / `!!tag` / `!tag` / `# 注释`（M2）。
 *
 * `password: &pw hunter2` / `password: !!str hunter2` 的真实值在修饰符之后；
 * `password: # note\n  hunter2` 的值在**下一行缩进**里。返回真实值的起点；
 * 只有注释且后面没有缩进行时返回 `null`（没有值，不改动）。
 *
 * @param {string} text
 * @param {number} start
 * @returns {null|number}
 */
function skipYamlValueModifiers(text, start) {
  let index = start
  while (index < text.length) {
    const char = text[index]
    if (char === ' ' || char === '\t') {
      index += 1
      continue
    }
    if (char === '&' || char === '!') {
      // 只跳过真正的 YAML 修饰符（`&pw` / `!!str` / `!tag`）；`&#34;` 是 HTML 实体，
      // 不是 anchor，必须留给 HTML 实体引号解析（m1）。
      const rest = text.slice(index, index + 2)
      if (char === '&' && (rest[1] === '#' || rest[1] === undefined || /\s/.test(rest[1]))) break
      if (char === '!' && (rest[1] === '=' || rest[1] === undefined)) break
      index += 1
      while (index < text.length && !isValueDelimiter(text[index])) index += 1
      continue
    }
    if (char === '#') {
      const lineEnd = text.indexOf('\n', index)
      if (lineEnd === -1) return null
      let next = lineEnd + 1
      let indent = 0
      while (next < text.length && (text[next] === ' ' || text[next] === '\t')) {
        next += 1
        indent += 1
      }
      // 没有缩进 = 下一行是同级键，注释后面根本没有值。
      if (indent === 0) return null
      index = next
      continue
    }
    break
  }
  return index
}

/** HTML 实体引号（`&#34;` / `&quot;` 等）。 */
const HTML_QUOTE_ENTITIES = [
  { quote: '"', tokens: ['&#34;', '&#x22;', '&quot;'] },
  { quote: "'", tokens: ['&#39;', '&#x27;', '&apos;'] },
]
const HTML_QUOTE_ENTITY_PATTERN = /^(?:&#34;|&#x22;|&quot;|&#39;|&#x27;|&apos;)/i

/**
 * 解析 HTML 实体引号包裹的值（m1：`password=&#34;hunter2&#34;`）。
 *
 * @param {string} text
 * @param {number} start
 * @returns {null | {end:number, keep:boolean, quote:string}}
 */
function parseHtmlEntityQuotedValue(text, start) {
  const open = HTML_QUOTE_ENTITY_PATTERN.exec(text.slice(start, start + 8))
  if (open === null) return null
  const entity = HTML_QUOTE_ENTITIES.find(entry => entry.tokens.some(
    token => token.toLowerCase() === open[0].toLowerCase(),
  ))
  if (entity === undefined) return null
  const bodyStart = start + open[0].length
  const closing = new RegExp(entity.tokens.join('|'), 'gi')
  closing.lastIndex = bodyStart
  const hit = closing.exec(text)
  const end = hit === null ? text.length : hit.index + hit[0].length
  const inner = hit === null ? text.slice(bodyStart) : text.slice(bodyStart, hit.index)
  return { end, keep: isFullyRedactedValue(inner), quote: entity.quote }
}

/**
 * `Authorization: ApiKey <credential>` / `token=SSWS <credential>` 这类裸方案名。
 *
 * 已知方案（Bearer / Basic / Token）由规则 1 先处理；这里覆盖规则 1 不认识的方案名，
 * 保留方案名、只把凭据抹掉。凭据已经是完整脱敏产物时原样放行（保持幂等）。
 *
 * @param {string} text
 * @param {number} start
 * @returns {null | {end:number, keep:boolean, quote:null, replacement?:string}}
 */
function parseSchemeValue(text, start) {
  const first = text[start]
  if (first === '"' || first === "'" || first === '\\' || first === '|' || first === '>') return null
  let cursor = start
  while (cursor < text.length && !isValueDelimiter(text[cursor])) cursor += 1
  const scheme = text.slice(start, cursor)
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(scheme) || !AUTH_SCHEME_WORDS.has(scheme.toLowerCase())) return null
  if (cursor >= text.length) return null
  let credentialStart = cursor
  while (credentialStart < text.length && (text[credentialStart] === ' ' || text[credentialStart] === '\t')) {
    credentialStart += 1
  }
  if (credentialStart >= text.length) return null
  const credential = parseAssignedValue(text, credentialStart, { header: true })
  if (credential === null || credential.end <= credentialStart) return null
  const credentialText = text.slice(credentialStart, credential.end)
  if (credential.keep && isFullyRedactedValue(credentialText)) {
    return { end: credential.end, keep: true, quote: null }
  }
  return { end: credential.end, keep: false, quote: null, replacement: `${scheme} [REDACTED]` }
}

/**
 * 解析一个敏感键后面的值，返回值的结束位置与「是否可以原样保留」。
 *
 * 覆盖（0.15.2）：
 *   - YAML 修饰符 `&anchor` / `!!tag` / `!tag` / `# 注释` + 下一行缩进值（M2）；
 *   - 普通引号 / 单引号，允许跨行、TAB、反斜杠转义；
 *   - 转义引号开头（`\"` / `\'`，JSON 序列化后的文本），收尾按连续反斜杠奇偶判定（B3）；
 *   - HTML 实体引号（`&#34;` / `&quot;`，m1）；
 *   - 三引号（`"""` / `'''`）；
 *   - 引号闭合后的词内拼接（shell / SQL 双写单引号）；
 *   - YAML 块标量；
 *   - 反斜杠续行；
 *   - 裸方案名（`ApiKey` / `SSWS` 等，m1；不再是只有 `authorization` 键才处理）。
 *
 * @param {string} text
 * @param {number} start
 * @param {{header?:boolean}} [options]
 * @returns {null | {end:number, keep:boolean, quote:string|null, escaped?:boolean, replacement?:string}}
 */
function parseAssignedValue(text, start, options = {}) {
  if (start >= text.length) return null
  // HTML 实体引号先判：`&#34;` 以 `&` 开头，不能先被 YAML anchor 跳过（m1）。
  const htmlAtStart = parseHtmlEntityQuotedValue(text, start)
  if (htmlAtStart !== null) return htmlAtStart
  const afterModifiers = skipYamlValueModifiers(text, start)
  if (afterModifiers === null) return null
  const valueStart = afterModifiers
  const yaml = parseYamlBlockValue(text, valueStart)
  if (yaml !== null) {
    // YAML 块标量的结束位置相对真实值；把起点之外的修饰符也算进替换区间。
    return { ...yaml, end: yaml.end }
  }
  const scheme = parseSchemeValue(text, valueStart)
  if (scheme !== null) return scheme

  const first = text[valueStart]
  if (first === '"' || first === "'") {
    if (text.startsWith(first.repeat(3), valueStart)) {
      const closeAt = text.indexOf(first.repeat(3), valueStart + 3)
      const end = closeAt === -1 ? text.length : closeAt + 3
      const inner = closeAt === -1 ? text.slice(valueStart + 3) : text.slice(valueStart + 3, closeAt)
      return { end, keep: isFullyRedactedValue(inner), quote: first }
    }
    const segment = scanQuotedValue(text, valueStart + 1, first, false)
    const wordEnd = consumeWordTail(text, segment.end)
    const inner = text.slice(valueStart + 1, segment.bodyEnd)
    const keep = wordEnd === segment.end && (isFullyRedactedValue(inner) || isAuthSchemeWord(inner))
    return { end: wordEnd, keep, quote: first }
  }
  if (first === '\\' && (text[valueStart + 1] === '"' || text[valueStart + 1] === "'")) {
    const quote = text[valueStart + 1]
    const segment = scanQuotedValue(text, valueStart + 2, quote, true)
    const inner = text.slice(valueStart + 2, segment.bodyEnd)
    const keep = isFullyRedactedValue(inner) || isAuthSchemeWord(inner)
    return { end: segment.end, keep, quote, escaped: true }
  }
  const html = parseHtmlEntityQuotedValue(text, valueStart)
  if (html !== null) return html

  const end = scanBareValue(text, valueStart, options.header === true)
  if (end === valueStart) return null
  const value = text.slice(valueStart, end)
  return { end, keep: isFullyRedactedValue(value) || isAuthSchemeWord(value), quote: null }
}

/**
 * `Authorization: Bearer` / `Basic` / `Token` 这类「方案词」不是凭据本身，留给规则 1 处理。
 *
 * @param {string} value
 * @returns {boolean}
 */
function isAuthSchemeWord(value) {
  return /^(?:Bearer|Basic|Token)$/i.test(String(value).replace(/["']/g, ''))
}

/** 不是普通对象（Map / Set / Buffer / Date / TypedArray / 类实例）的叶子原样返回。 */
function isPlainObject(value) {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * 单个字符串的脱敏：共享文本规则 +（可选）本 execution 的精确秘密替换。
 *
 * `capOversize` 默认按字符串长度决定：≤1 MiB 关闭「≥64 KiB 连续串预抹」——
 * 那是为超大输入避开 V8 爆栈的兜底，但会把 600 KiB 的合法 `x…x` 长串整段替换；
 * 规则 5 仍按跨类字符判敏感。传入 true / false 可强制打开 / 关闭。
 *
 * @param {string} text
 * @param {{capOversize?:boolean|'auto', secrets?:string[]}} options
 * @returns {string}
 */
function redactStringValue(text, options) {
  const capOversize = options.capOversize === true || options.capOversize === false
    ? options.capOversize
    : text.length > REDACT_OVERSIZE_TEXT_BYTES
  let out = redactText(text, { capOversize })
  for (const secret of options.secrets) {
    if (typeof secret === 'string' && secret !== '') out = out.split(secret).join('[redacted]')
  }
  return out
}

/** 递归脱敏的内部实现：`seen` 只在当前路径上标记，离开时删除（共享引用不算环）。 */
function redactStructuredWalk(value, depth, seen, options) {
  if (typeof value === 'string') return redactStringValue(value, options)
  if (value === null || typeof value !== 'object') return value
  // 深度 / 循环：返回占位符，绝不把更深的对象原样透出。
  if (depth >= options.maxDepth) return options.placeholder
  if (seen.has(value)) return options.placeholder
  // 非普通对象是**非字符串叶子**：Map / Set / Buffer / Date / TypedArray / 类实例一律
  // 原样返回（不做深拷贝、也不遍历）。只有数组与普通对象会被递归。
  if (!Array.isArray(value) && !isPlainObject(value)) return value
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const out = []
      const max = Math.min(value.length, options.maxKeys)
      for (let index = 0; index < max; index += 1) {
        out.push(redactStructuredWalk(value[index], depth + 1, seen, options))
      }
      return out
    }
    const out = {}
    const keys = Object.keys(value)
    const max = Math.min(keys.length, options.maxKeys)
    for (let index = 0; index < max; index += 1) {
      const key = keys[index]
      let item
      try {
        item = value[key]
      } catch {
        // getter 抛错：跳过这一项，不把执行器带崩。
        continue
      }
      if (isSensitiveKeyName(key)) {
        // 键名已经声明这是凭据：值再像普通文本也不放行，**整体**替换成 [REDACTED]
        // （不保留 `ghp_[REDACTED]` 之类的值形态，避免下游误以为还能看到部分凭据）。
        out[key] = '[REDACTED]'
        continue
      }
      out[key] = redactStructuredWalk(item, depth + 1, seen, options)
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/**
 * 递归脱敏任意事件对象 / 数组 / 字符串（三个适配器的**唯一**结构化脱敏出口）。
 *
 * 行为：
 *   - 字符串：走 {@link redactText}（转义 / 引号 / 键值 / 超长串）；
 *   - 敏感键名（{@link isSensitiveKeyName}）：值**整体**替换成 `[REDACTED]`，不递归、
 *     不保留值形态——`{ env: { password: { nested: 'x' } } }` 也是 `[REDACTED]`；
 *   - 数组 / 普通对象：深拷贝并递归；键数 ≤ `maxKeys`（默认 64）；
 *   - 非字符串叶子：数字 / 布尔 / null / Map / Set / Buffer / Date / TypedArray /
 *     类实例**原样返回**（不拷贝、不遍历；Buffer 内容不会当文本脱敏）；
 *   - 深度达到 `maxDepth`（默认 8）或循环引用：`[redacted:depth]`；
 *   - `capOversize`：`true` / `false` 强制开 / 关文本预抹；省略时按单串 >1 MiB 自动开启；
 *   - `secrets`：本 execution 的精确秘密（通道凭据 / socket 路径 / runDir / 显式 env），
 *     在共享文本规则之后做字面量替换。
 *
 * @param {unknown} value
 * @param {{capOversize?:boolean, maxDepth?:number, maxKeys?:number, secrets?:string[]}} [options]
 * @returns {unknown}
 */
export function redactStructured(value, options = {}) {
  return redactStructuredWalk(value, 0, new WeakSet(), {
    maxDepth: Number.isSafeInteger(options.maxDepth) && options.maxDepth > 0
      ? options.maxDepth
      : REDACT_MAX_DEPTH,
    maxKeys: Number.isSafeInteger(options.maxKeys) && options.maxKeys > 0
      ? options.maxKeys
      : REDACT_MAX_KEYS,
    placeholder: '[redacted:depth]',
    capOversize: options.capOversize,
    secrets: Array.isArray(options.secrets)
      ? options.secrets.filter(secret => typeof secret === 'string' && secret !== '')
      : [],
  })
}

/**
 * 递归脱敏任意事件对象 / 数组 / 字符串（0.15.1 的兼容出口）。
 *
 * 与 {@link redactStructured} 共用同一实现与键名判据（0.15.2 起 `credential` / `auth` /
 * `pwd` / `passphrase` / `token2` / `passwordHash` / 中文键都命中），差别只有两点：
 * 占位符沿用 `[TRUNCATED]`（既有导出契约），且文本预抹保持 `redactText` 默认口径。
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactDeep(value) {
  return redactStructuredWalk(value, 0, new WeakSet(), {
    maxDepth: REDACT_MAX_DEPTH,
    maxKeys: REDACT_MAX_KEYS,
    placeholder: REDACT_TRUNCATED,
    capOversize: true,
    secrets: [],
  })
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
