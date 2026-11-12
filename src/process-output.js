/**
 * 外部进程输出的共享有界保留与脱敏原语（0.11 R3 / S2；0.15.1 转义感知）。
 *
 * 这个模块只做三件事，且刻意保持**零业务依赖**（除 `node:buffer` 外不 import 任何
 * src 内模块，也不 import fs / child_process）：
 *   1. `redactText`：共享的凭据脱敏规则（规则 0–5）。规则 4 / 2 的取值用线性扫描器，
 *      能识别 JSON / shell 转义、三引号、词内拼接、全角分隔符、箭头、YAML 块标量与
 *      反斜杠续行；不靠正则描述「值在哪里结束」。
 *   2. `redactDeep`：对事件对象 / 数组 / 字符串做递归脱敏；键数、深度、循环引用都有界。
 *      敏感键名（token / password / apiKey…）的值不再只看形态，未知值直接抹成
 *      `[REDACTED]`。
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
 * 规则 4（赋值）使用的键名子集：比标志位名单窄，避免把 `AWS_SECRET_ACCESS_KEY=…`
 * 这类**复合名**里的 `ACCESS_KEY` 当成独立键（0.15.0 之前就是这样，短占位值不会被抹）。
 * 标志位走 `FLAG_NAME_SOURCE`，两者共用 {@link SENSITIVE_KEY_NAME_SOURCE} 的命名口径。
 */
const ASSIGNED_KEY_NAME_SOURCE = '(?:token|password|passwd|secret|api[_-]?key|authorization)'

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
 * 敏感键赋值的取值与替换（线性扫描，见规则 4 的说明）。
 *
 * @param {string} text
 * @returns {string}
 */
function redactAssignedValues(text) {
  const pattern = new RegExp(
    `(["']?(${ASSIGNED_KEY_NAME_SOURCE})["']?\\s*(?:=>|->|[:=＝：])\\s*)`,
    'gi',
  )
  let out = ''
  let cursor = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1]
    const valueStart = match.index + prefix.length
    const parsed = parseAssignedValue(text, valueStart, { key: normalizeKeyName(match[2]) })
    if (parsed === null) continue
    out += text.slice(cursor, match.index) + prefix
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
    while (index < text.length) {
      if (text[index] === '\\') {
        if (text[index + 1] === quote) {
          return { end: index + 2, bodyEnd: index, closed: true }
        }
        // `\n` / `\t` / `\\` / `\"`（非收尾）都按两个字符的转义序列跳过。
        index += 2
        continue
      }
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
 * `Authorization: ApiKey <credential>` / `SSWS <credential>` 这类裸方案名。
 *
 * 已知方案（Bearer / Basic / Token）由规则 1 先处理；这里覆盖规则 1 不认识的方案名，
 * 保留方案名、只把凭据抹掉。凭据已经是完整脱敏产物时原样放行（保持幂等）。
 *
 * @param {string} text
 * @param {number} start
 * @returns {null | {end:number, keep:boolean, quote:null, replacement?:string}}
 */
function parseAuthorizationValue(text, start) {
  const first = text[start]
  if (first === '"' || first === "'" || first === '\\' || first === '|' || first === '>') return null
  let cursor = start
  while (cursor < text.length && !isValueDelimiter(text[cursor])) cursor += 1
  const scheme = text.slice(start, cursor)
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(scheme)) return null
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
 * 覆盖（0.15.1）：
 *   - 普通引号 / 单引号，允许跨行、TAB、反斜杠转义；
 *   - 转义引号开头（`\"` / `\'`，JSON 序列化后的文本），按转义序列理解 `\n` / `\t` / `\\`；
 *   - 三引号（`"""` / `'''`）；
 *   - 引号闭合后的词内拼接（shell / SQL 双写单引号）；
 *   - YAML 块标量；
 *   - 反斜杠续行；
 *   - `Authorization:` 的裸方案名。
 *
 * @param {string} text
 * @param {number} start
 * @param {{key?:string}} [options]
 * @returns {null | {end:number, keep:boolean, quote:string|null, escaped?:boolean, replacement?:string}}
 */
function parseAssignedValue(text, start, options = {}) {
  if (start >= text.length) return null
  const yaml = parseYamlBlockValue(text, start)
  if (yaml !== null) return yaml
  if (options.key === 'authorization') {
    const authorization = parseAuthorizationValue(text, start)
    if (authorization !== null) return authorization
  }

  const first = text[start]
  if (first === '"' || first === "'") {
    if (text.startsWith(first.repeat(3), start)) {
      const closeAt = text.indexOf(first.repeat(3), start + 3)
      const end = closeAt === -1 ? text.length : closeAt + 3
      const inner = closeAt === -1 ? text.slice(start + 3) : text.slice(start + 3, closeAt)
      return { end, keep: isFullyRedactedValue(inner), quote: first }
    }
    const segment = scanQuotedValue(text, start + 1, first, false)
    const wordEnd = consumeWordTail(text, segment.end)
    const inner = text.slice(start + 1, segment.bodyEnd)
    const keep = wordEnd === segment.end && (isFullyRedactedValue(inner) || isAuthSchemeWord(inner))
    return { end: wordEnd, keep, quote: first }
  }
  if (first === '\\' && (text[start + 1] === '"' || text[start + 1] === "'")) {
    const quote = text[start + 1]
    const segment = scanQuotedValue(text, start + 2, quote, true)
    const inner = text.slice(start + 2, segment.bodyEnd)
    const keep = isFullyRedactedValue(inner) || isAuthSchemeWord(inner)
    return { end: segment.end, keep, quote, escaped: true }
  }

  const end = scanBareValue(text, start, options.header === true)
  if (end === start) return null
  const value = text.slice(start, end)
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

/**
 * 敏感键名的后缀判据（camelCase / snake_case / kebab-case 归一后比较）。
 *
 * 0.15.1：`redactDeep` 不再只看值形态——`{ token: 'opaque-value' }` 这种键名明确、
 * 值却不像凭据的字段也必须脱敏。归一化会去掉 `_` / `-` / `.`，因此 `apiKey`、
 * `api_key`、`API-KEY` 得到同一个 `apikey`。
 */
const SENSITIVE_KEY_SUFFIXES = [
  'token', 'tokens', 'password', 'passwd', 'secret', 'apikey', 'credentials',
  'cookie', 'authorization', 'authkey', 'accesskey', 'secretkey', 'privatekey',
  'sshkey', 'sessionkey',
]

/**
 * 判断对象键名是否敏感（按键名而不是按值）。
 *
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveObjectKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalized === '') return false
  return SENSITIVE_KEY_SUFFIXES.some(suffix => normalized === suffix || normalized.endsWith(suffix))
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
      if (isSensitiveObjectKey(key)) {
        // 键名已经声明这是凭据：值再像普通文本也不放行；仅保留已知的完整脱敏形态。
        out[key] = typeof item === 'string' && isFullyRedactedValue(item) ? item : '[REDACTED]'
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
