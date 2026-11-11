/**
 * HTTP connector 的目标策略：纯函数 + 可达地址判定 + 凭据引用解析 + 配置脱敏。
 *
 * 0.13.6 的安全边界（docs/plan/0.14-能力补齐与旧域退役.md §B）：
 *   - 默认只允许 HTTPS；测试台内部 HTTP 必须由宿主配置**精确到 host:port** 放行；
 *   - 拒绝 URL userinfo、非 http(s) 协议；
 *   - 默认阻断 loopback / 私网 / link-local / 云 metadata 地址；内网集成必须配置
 *     host/port/CIDR 例外；
 *   - **所有** DNS 结果都校验，并返回一个把连接固定到已验证地址的 `lookup`，
 *     避免「校验一次、连接时重新解析」的 DNS 重绑定窗口；
 *   - 关闭重定向（connector 收到 3xx 直接失败，见 http-connector）；
 *   - `authRef` 只从宿主配置解析；XML / 变量 / 事件 / 错误文本 / 日志都不保存密钥值。
 *     connector 还会对响应头 / 输出映射里的精确凭据值做脱敏或拒绝（见 http-connector）。
 *
 * 本模块不读取文件、不发网络请求（默认 resolver 除外）；`validateDestination()`
 * 的返回值就是 connector 实际连接时使用的地址清单。
 *
 * @module @feiyueve/dsh-flow-studio/http-policy
 */

import { promises as dns } from 'node:dns'

/** 结构化策略错误：`code` 是稳定契约，message 是中文可行动原因。 */
export class HttpPolicyError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'HttpPolicyError'
    this.code = code
    this.details = details !== undefined && details !== null && typeof details === 'object' ? details : undefined
  }
}

/** 允许的方法（与属性面板一致；其他方法明确拒绝，不做「任意动词」透传）。 */
export const HTTP_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** 默认 maxResponseBytes / maxRequestBytes / 时限、重试与 header 预算。 */
export const HTTP_LIMITS = Object.freeze({
  maxRequestBytes: 256 * 1024,
  defaultResponseBytes: 1024 * 1024,
  hardResponseBytes: 5 * 1024 * 1024,
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 120_000,
  maxRetries: 3,
  retryBackoffBaseMs: 200,
  retryBackoffMaxMs: 2_000,
  // m2：header 也需要独立预算（正文限额不覆盖 header）。这些是硬上限，宿主配置不能放大。
  maxRequestHeaderCount: 64,
  maxRequestHeaderValueBytes: 8 * 1024,
  maxRequestHeaderBytes: 32 * 1024,
  maxResponseHeaderCount: 64,
  maxResponseHeaderBytes: 8 * 1024,
})

/** 云 metadata 的常见 IPv4 地址（link-local 之外的显式补充）。 */
const METADATA_IPV4 = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  '168.63.129.16',
])

/** metadata 主机名：即使解析出公网地址也不许访问（防止 DNS 层面的别名）。 */
const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
])

/** 鉴权 / 会话类 header：禁止写在 XML 配置里，只允许经 authRef 解析。 */
const SECRET_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
])

const SECRET_HEADER_PATTERN = /(?:^|[-_])(?:token|secret|password|passwd|api[-_]?key|credential|credentials)(?:$|[-_])/i

/** header 名 token 规则（RFC 7230）。 */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

const AUTH_ENV_PREFIX = 'FLOW_STUDIO_HTTP_AUTH_'

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInt(value, fallback, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  const integer = Math.floor(value)
  return max !== undefined ? Math.min(integer, max) : integer
}

/* ── 宿主策略的严格校验（H2）────────────────────────────────────── */

function policyInvalid(message, details) {
  return new HttpPolicyError('HTTP_POLICY_INVALID', message, details)
}

/** 规范化 origin：协议 + 小写主机 + 显式端口（与 connector 的 validated.origin 同口径）。 */
function canonicalOriginOf(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = url.port !== ''
    ? Number(url.port)
    : (url.protocol === 'https:' ? 443 : 80)
  const hostText = host.includes(':') ? `[${host}]` : host
  return `${url.protocol}//${hostText}:${port}`
}

/**
 * 例外项严格解析：`host:port` / `[IPv6]:port`。
 *
 * H2 契约：**端口必须显式**（1–65535），接受 `*` 或省略端口都会静默扩大安全边界，
 * 因此这里直接拒绝，而不是回落到「任意端口」。
 *
 * @returns {{ host: string, port: number }}
 */
function parseStrictHostRule(rule, field) {
  if (typeof rule !== 'string') {
    throw policyInvalid(`${field} 的每一项都必须是字符串（host:port）。`, { field })
  }
  const text = rule.trim()
  if (text === '') throw policyInvalid(`${field} 不允许空字符串。`, { field })
  if (text.includes('*')) {
    throw policyInvalid(`${field} 不接受通配符：请逐项写死 host:port。`, { field, rule: text })
  }

  let host
  let portText
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end < 0) throw policyInvalid(`${field} 的 IPv6 例外必须写成 [地址]:端口。`, { field, rule: text })
    host = text.slice(1, end)
    const rest = text.slice(end + 1)
    if (!rest.startsWith(':')) {
      throw policyInvalid(`${field} 的例外必须显式写端口（[地址]:端口），省略端口不再表示任意端口。`, { field, rule: text })
    }
    portText = rest.slice(1)
    if (parseIPv6(host) === null) {
      throw policyInvalid(`${field} 的 IPv6 地址不合法：${text}。`, { field, rule: text })
    }
  } else {
    if ((text.match(/:/g) ?? []).length > 1) {
      throw policyInvalid(`${field} 的 IPv6 例外必须写方括号（[地址]:端口）。`, { field, rule: text })
    }
    const colon = text.lastIndexOf(':')
    if (colon <= 0) {
      throw policyInvalid(`${field} 的例外必须显式写端口（host:port），省略端口不再表示任意端口。`, { field, rule: text })
    }
    host = text.slice(0, colon)
    portText = text.slice(colon + 1)
    if (/^[0-9.]+$/.test(host) && parseIPv4(host) === null) {
      throw policyInvalid(`${field} 的主机不是合法 IPv4：${text}。`, { field, rule: text })
    }
    if (!/^[a-z0-9._-]+$/i.test(host)) {
      throw policyInvalid(`${field} 的主机名不合法：${text}。`, { field, rule: text })
    }
  }
  if (!/^\d{1,5}$/.test(portText)) {
    throw policyInvalid(`${field} 的端口必须是 1–65535 的十进制整数：${text}。`, { field, rule: text })
  }
  const port = Number(portText)
  if (port < 1 || port > 65535) {
    throw policyInvalid(`${field} 的端口必须在 1–65535 之间：${text}。`, { field, rule: text })
  }
  const lowerHost = host.toLowerCase()
  return { host: lowerHost, port }
}

function normalizeHostRules(raw, field) {
  if (raw === undefined || raw === null) return []
  const list = typeof raw === 'string' ? [raw] : raw
  if (!Array.isArray(list)) {
    throw policyInvalid(`${field} 必须是字符串数组（host:port）。`, { field })
  }
  return list.map(rule => {
    const parsed = parseStrictHostRule(rule, field)
    const hostText = parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host
    return `${hostText}:${parsed.port}`
  })
}

/** CIDR 例外严格解析：前缀必须是非空十进制数字，网络地址必须合法。 */
function normalizeCidrRules(raw, field) {
  if (raw === undefined || raw === null) return []
  const list = typeof raw === 'string' ? [raw] : raw
  if (!Array.isArray(list)) {
    throw policyInvalid(`${field} 必须是字符串数组（IPv4/IPv6 CIDR）。`, { field })
  }
  return list.map(rule => {
    if (typeof rule !== 'string') {
      throw policyInvalid(`${field} 的每一项都必须是字符串（CIDR）。`, { field })
    }
    const text = rule.trim()
    if (text === '' || text.includes('*')) {
      throw policyInvalid(`${field} 不接受空串或通配符：${JSON.stringify(text)}。`, { field, rule: text })
    }
    const slash = text.lastIndexOf('/')
    if (slash <= 0) {
      throw policyInvalid(`${field} 的 CIDR 缺少 /前缀长度：${text}。`, { field, rule: text })
    }
    const networkText = text.slice(0, slash).trim()
    const prefixText = text.slice(slash + 1).trim()
    if (!/^\d{1,3}$/.test(prefixText)) {
      // H2 的实测反例：Number('') === 0 会把 10.0.0.0/ 静默变成 /0（放行一切）。
      throw policyInvalid(`${field} 的 CIDR 前缀长度必须是非空十进制数字：${text}。`, { field, rule: text })
    }
    const prefix = Number(prefixText)
    const family = networkText.includes(':') ? 6 : 4
    const max = family === 4 ? 32 : 128
    if (prefix < 0 || prefix > max) {
      throw policyInvalid(`${field} 的 CIDR 前缀长度必须在 0–${max} 之间：${text}。`, { field, rule: text })
    }
    const network = family === 4 ? parseIPv4(networkText) : parseIPv6(networkText)
    if (network === null) {
      throw policyInvalid(`${field} 的网络地址不合法：${text}。`, { field, rule: text })
    }
    return `${networkText}/${prefix}`
  })
}

/**
 * 本地 NAT64 前缀（RFC 8215）显式配置：只接受 `64:ff9b:1::/48` 内、**固定 /96** 的前缀。
 *
 * RFC 6052 §2.2 的映射位置随前缀长度变化：只有 /96 把 IPv4 放在最低 32 位，
 * /32、/40、/48、/56、/64 的 IPv4 分别落在高位或中间（例如 /64 的
 * `64:ff9b:1:0:a:0:100:0` 实际映射 10.0.0.1，而不是低 32 位读出的 1.0.0.0）。
 * 本版分类与内嵌 IPv4 提取只实现 /96，其他长度直接拒绝，避免用错误位段做安全判定
 * （复审 R1）。默认列表为空 = 全部阻断。
 */
function normalizeNat64Prefixes(raw) {
  const field = 'nat64Prefixes'
  return normalizeCidrRules(raw, field).map(rule => {
    const [networkText, prefixText] = rule.split('/')
    const family = networkText.includes(':') ? 6 : 4
    const prefix = Number(prefixText)
    if (family !== 6 || prefix !== 96 || !addressInCidr(networkText, '64:ff9b:1::/48')) {
      throw policyInvalid(
        'nat64Prefixes 只接受 64:ff9b:1::/48 内、前缀长度固定为 /96 的本地 NAT64 前缀'
        + '（IPv4 内嵌在最低 32 位；其他长度的映射位置按 RFC 6052 不同，本版不支持）。',
        { field, rule },
      )
    }
    return rule
  })
}

/** authRef → 允许的目标 origin 列表（H3：凭据不能跟着被改写的 URL 去别的 origin）。 */
function normalizeAuthOrigins(raw) {
  const field = 'authOrigins'
  if (raw === undefined || raw === null) return {}
  if (!isPlainObject(raw)) {
    throw policyInvalid(`${field} 必须是 { authRef: ['https://host:port'] } 对象。`, { field })
  }
  const output = {}
  for (const [authRef, list] of Object.entries(raw)) {
    if (typeof authRef !== 'string' || authRef.trim() === '' || authRef.length > 128) {
      throw policyInvalid(`${field} 的键必须是非空 authRef（≤128 字符）。`, { field })
    }
    const items = typeof list === 'string' ? [list] : list
    if (!Array.isArray(items) || items.length === 0) {
      throw policyInvalid(`${field}[${authRef}] 必须是非空 origin 数组。`, { field, authRef })
    }
    const origins = items.map(item => {
      if (typeof item !== 'string' || item.trim() === '') {
        throw policyInvalid(`${field}[${authRef}] 的每一项都必须是 origin 字符串。`, { field, authRef })
      }
      if (item.includes('*')) {
        throw policyInvalid(`${field}[${authRef}] 不接受通配符 origin。`, { field, authRef })
      }
      let url
      try {
        url = new URL(item.trim())
      } catch {
        throw policyInvalid(`${field}[${authRef}] 的 origin 不是合法 URL：${item}。`, { field, authRef })
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw policyInvalid(`${field}[${authRef}] 的 origin 只允许 http(s)。`, { field, authRef })
      }
      if (url.username !== '' || url.password !== '') {
        throw policyInvalid(`${field}[${authRef}] 的 origin 不允许包含 userinfo。`, { field, authRef })
      }
      if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
        throw policyInvalid(`${field}[${authRef}] 只能写 origin（协议 + 主机 + 端口），不能带路径 / 查询 / 片段。`, { field, authRef })
      }
      return canonicalOriginOf(url)
    })
    output[authRef.trim()] = [...new Set(origins)]
  }
  return output
}

/**
 * 归一化宿主传入的策略对象。未知键忽略；**非法 / 会扩权的值直接报
 * `HTTP_POLICY_INVALID`**，不再静默回落（H2）。
 *
 * 例外配置（都要求宿主显式写死，不接受通配符、不接受省略端口）：
 *   - `allowInsecureOrigins`: ['host:port', '[v6]:port']，同时放行 http 与私网判定；
 *   - `allowedHosts`: ['host:port']，允许 https 访问私网/回环地址；
 *   - `allowedCidrs`: ['10.0.0.0/8', '2001:db8::/32']，按**已解析地址**放行；
 *   - `nat64Prefixes`: ['64:ff9b:1::/96']（仅 /96），显式启用本地 NAT64；内嵌 IPv4 仍必须是公网；
 *   - `authOrigins`: { authRef: ['https://host:port'] }，把凭据绑定到允许的目标 origin；
 *   - `allowMetadata`: true 才允许 metadata 地址（默认 false，通常不该开）。
 *
 * `resolver(hostname) -> [{address, family}] | string[]` 只给测试/嵌入方注入；
 * 生产默认走系统 DNS（`dns.lookup(..., { all: true })`）。
 */
export function normalizeHttpPolicy(raw = {}) {
  const source = isPlainObject(raw) ? raw : {}
  const maxTimeoutMs = positiveInt(source.maxTimeoutMs, HTTP_LIMITS.maxTimeoutMs)
  return {
    allowInsecureOrigins: normalizeHostRules(source.allowInsecureOrigins, 'allowInsecureOrigins'),
    allowedHosts: normalizeHostRules(source.allowedHosts, 'allowedHosts'),
    allowedCidrs: normalizeCidrRules(source.allowedCidrs, 'allowedCidrs'),
    nat64Prefixes: normalizeNat64Prefixes(source.nat64Prefixes),
    authOrigins: normalizeAuthOrigins(source.authOrigins),
    allowMetadata: source.allowMetadata === true,
    allowRedirects: false,
    maxRequestBytes: positiveInt(source.maxRequestBytes, HTTP_LIMITS.maxRequestBytes),
    defaultResponseBytes: positiveInt(
      source.defaultResponseBytes,
      HTTP_LIMITS.defaultResponseBytes,
      HTTP_LIMITS.hardResponseBytes,
    ),
    hardResponseBytes: positiveInt(
      source.hardResponseBytes,
      HTTP_LIMITS.hardResponseBytes,
      HTTP_LIMITS.hardResponseBytes,
    ),
    // 默认时限不能超过宿主配置的上限（避免一个宽泛默认值绕过 maxTimeoutMs）。
    defaultTimeoutMs: Math.min(positiveInt(source.defaultTimeoutMs, HTTP_LIMITS.defaultTimeoutMs), maxTimeoutMs),
    maxTimeoutMs,
    maxRetries: Math.min(positiveInt(source.maxRetries, HTTP_LIMITS.maxRetries), HTTP_LIMITS.maxRetries),
    retryBackoffBaseMs: positiveInt(source.retryBackoffBaseMs, HTTP_LIMITS.retryBackoffBaseMs),
    retryBackoffMaxMs: positiveInt(source.retryBackoffMaxMs, HTTP_LIMITS.retryBackoffMaxMs),
    resolver: typeof source.resolver === 'function' ? source.resolver : null,
    env: isPlainObject(source.env) ? source.env : null,
    authResolver: typeof source.authResolver === 'function' ? source.authResolver : null,
  }
}

/** `host` / `host:port` 例外项解析（输入已由 normalize 严格校验）。 */
function parseHostRule(rule) {
  if (typeof rule !== 'string' || rule.trim() === '') return null
  const text = rule.trim().toLowerCase()
  // IPv6 字面量：[::1]:8443
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end < 0) return null
    const host = text.slice(1, end)
    const rest = text.slice(end + 1)
    if (!rest.startsWith(':')) return null
    const port = /^\d+$/.test(rest.slice(1)) ? Number(rest.slice(1)) : null
    if (port === null) return null
    return { host, port }
  }
  const lastColon = text.lastIndexOf(':')
  if (lastColon <= 0) return null
  const port = /^\d+$/.test(text.slice(lastColon + 1)) ? Number(text.slice(lastColon + 1)) : null
  if (port === null) return null
  return { host: text.slice(0, lastColon), port }
}

function hostMatchesRule(host, port, rule) {
  const parsed = parseHostRule(rule)
  if (!parsed) return false
  // H2：不接受通配符主机（`*` 已在 normalize 阶段拒绝，这里再兜一层）。
  if (parsed.host === '*') return false
  if (parsed.host !== host) return false
  return parsed.port === port
}

/* ── IP 解析 / 分类 ─────────────────────────────────────────────── */

function parseIPv4(text) {
  if (typeof text !== 'string') return null
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const bytes = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    bytes.push(value)
  }
  return bytes
}

function classifyIPv4(bytes) {
  const [a, b, c] = bytes
  const text = bytes.join('.')
  if (METADATA_IPV4.has(text)) return 'metadata'
  if (a === 0) return 'reserved'
  if (a === 10) return 'private'
  if (a === 100 && b >= 64 && b <= 127) return 'private'
  if (a === 127) return 'loopback'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 0 && c === 0) return 'reserved'
  if (a === 192 && b === 0 && c === 2) return 'documentation'
  if (a === 192 && b === 88 && c === 99) return 'reserved'
  if (a === 192 && b === 168) return 'private'
  if (a === 198 && (b === 18 || b === 19)) return 'benchmark'
  if (a === 198 && b === 51 && c === 100) return 'documentation'
  if (a === 203 && b === 0 && c === 113) return 'documentation'
  if (a === 255 && b === 255 && c === 255 && bytes[3] === 255) return 'broadcast'
  if (a >= 224 && a <= 239) return 'multicast'
  if (a >= 240) return 'reserved'
  return 'public'
}

function parseIPv6(text) {
  if (typeof text !== 'string') return null
  let value = text.trim().toLowerCase()
  const zone = value.indexOf('%')
  if (zone >= 0) value = value.slice(0, zone)
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  if (value === '') return null

  // 末尾内嵌 IPv4（::ffff:127.0.0.1 / 2002:7f00:1::1 之类）。
  let tailV4 = null
  const lastColon = value.lastIndexOf(':')
  if (lastColon >= 0 && value.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(value.slice(lastColon + 1))
    if (v4 === null) return null
    tailV4 = v4
    value = value.slice(0, lastColon + 1) + '0:0'
    // 上面插入两个占位组，下面统一按 8 组补零后替换最后两组。
  }

  const doubleColon = value.indexOf('::')
  if (doubleColon >= 0 && value.indexOf('::', doubleColon + 1) >= 0) return null
  let groups = []
  if (doubleColon >= 0) {
    const head = value.slice(0, doubleColon)
    const tail = value.slice(doubleColon + 2)
    const headParts = head === '' ? [] : head.split(':')
    const tailParts = tail === '' ? [] : tail.split(':')
    const missing = 8 - headParts.length - tailParts.length
    if (missing < 1) return null
    groups = [...headParts, ...Array(missing).fill('0'), ...tailParts]
  } else {
    groups = value.split(':')
  }
  if (groups.length !== 8) return null
  const bytes = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    const number = parseInt(group, 16)
    bytes.push((number >> 8) & 0xff, number & 0xff)
  }

  if (tailV4 !== null) {
    bytes[12] = tailV4[0]
    bytes[13] = tailV4[1]
    bytes[14] = tailV4[2]
    bytes[15] = tailV4[3]
  }
  return bytes
}

/** IPv6 地址低 32 位按 IPv4 分类（NAT64 / 6to4 / IPv4-compatible 的内嵌地址）。 */
function embeddedIPv4Kind(bytes) {
  return classifyIPv4(bytes.slice(12, 16))
}

function embeddedIPv4Text(bytes) {
  return bytes.slice(12, 16).join('.')
}

function classifyIPv6(bytes) {
  if (bytes.every(byte => byte === 0)) return 'unspecified'
  if (bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1) return 'loopback'

  // IPv4-mapped ::ffff:a.b.c.d
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return embeddedIPv4Kind(bytes)
  }
  // NAT64 64:ff9b::/96（well-known prefix）：内嵌 IPv4 直接进入分类。
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
    && bytes.slice(4, 12).every(byte => byte === 0)) {
    return embeddedIPv4Kind(bytes)
  }
  // 本地 NAT64 64:ff9b:1::/48（RFC 8215）：默认不是公网；显式配置 nat64Prefixes 才放行，
  // 且内嵌 IPv4 仍须是公网地址（见 isAddressAllowed）。
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
    && bytes[4] === 0x00 && bytes[5] === 0x01) {
    return 'nat64-local'
  }
  // IPv4-compatible ::a.b.c.d（已废弃）：按内嵌 IPv4 分类，避免 ::7f00:1 被当成公网。
  if (bytes.slice(0, 12).every(byte => byte === 0)) return embeddedIPv4Kind(bytes)
  // 6to4 2002::/16
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    const v4 = [bytes[2], bytes[3], bytes[4], bytes[5]]
    return classifyIPv4(v4)
  }
  // 2001:db8::/32 文档地址
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return 'documentation'
  // 2001:2::/48 基准测试地址
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x02) return 'benchmark'
  // 2001:10::/28 / 2001:20::/28 ORCHID / ORCHIDv2：不可路由的特殊用途。
  // /28 只固定第 3 字节的高 4 位（2001:10xx::/28 与 2001:20xx::/28），
  // 不能用整字节相等判断：2001:11::1、2001:2f::1 等同样落在这些前缀内（复审 R1）。
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00
    && ((bytes[3] & 0xf0) === 0x10 || (bytes[3] & 0xf0) === 0x20)) return 'reserved'
  // 2001::/32 Teredo：隧道内容不可见，按保留地址处理。
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return 'reserved'
  // 100::/64 丢弃前缀（RFC 6666）
  if (bytes[0] === 0x01 && bytes.slice(1, 8).every(byte => byte === 0)) return 'reserved'
  // 3fff::/20 文档地址（RFC 9637）
  if (bytes[0] === 0x3f && (bytes[1] & 0xf0) === 0xf0) return 'documentation'
  // 5f00::/16 SRv6 SID（RFC 9602）
  if (bytes[0] === 0x5f && bytes[1] === 0x00) return 'reserved'
  // fc00::/7 唯一本地地址
  if ((bytes[0] & 0xfe) === 0xfc) return 'private'
  // fec0::/10 站点本地地址（RFC 3879 已废弃，仍属特殊用途）
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return 'site-local'
  // fe80::/10 链路本地
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'link-local'
  // ff00::/8 组播
  if (bytes[0] === 0xff) return 'multicast'
  return 'public'
}

/** 分类一个 IP 字面量；非法返回 null。 */
export function classifyAddress(address) {
  const v4 = parseIPv4(address)
  if (v4 !== null) return { family: 4, kind: classifyIPv4(v4) }
  const v6 = parseIPv6(address)
  if (v6 !== null) return { family: 6, kind: classifyIPv6(v6) }
  return null
}

/** 地址是否落在 CIDR 内（支持 IPv4 / IPv6）。前缀长度必须是**非空十进制数字**。 */
export function addressInCidr(address, cidr) {
  if (typeof cidr !== 'string') return false
  const slash = cidr.lastIndexOf('/')
  if (slash <= 0) return false
  const networkText = cidr.slice(0, slash).trim()
  const prefixText = cidr.slice(slash + 1).trim()
  // H2：Number('') === 0 会把 `10.0.0.0/` 静默变成 /0（匹配一切），必须显式拒绝。
  if (!/^\d{1,3}$/.test(prefixText)) return false
  const prefix = Number(prefixText)
  const family = networkText.includes(':') ? 6 : 4
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) return false
  const network = family === 4 ? parseIPv4(networkText) : parseIPv6(networkText)
  const target = family === 4 ? parseIPv4(address) : parseIPv6(address)
  if (network === null || target === null) return false
  let bits = prefix
  for (let index = 0; index < network.length && bits > 0; index += 1) {
    const take = Math.min(8, bits)
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff
    if ((network[index] & mask) !== (target[index] & mask)) return false
    bits -= take
  }
  return true
}

/* ── 目标校验 ─────────────────────────────────────────────────── */

async function defaultResolve(hostname) {
  const results = await dns.lookup(hostname, { all: true, verbatim: true })
  return results.map(item => ({ address: item.address, family: item.family }))
}

function normalizeAddressList(raw) {
  if (!Array.isArray(raw)) return []
  const output = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const classified = classifyAddress(item)
      if (classified !== null) output.push({ address: item, family: classified.family })
      continue
    }
    if (!isPlainObject(item) || typeof item.address !== 'string') continue
    const classified = classifyAddress(item.address)
    if (classified === null) continue
    output.push({ address: item.address, family: typeof item.family === 'number' ? item.family : classified.family })
  }
  return output
}

/**
 * 地址是否被例外规则放行（metadata 例外必须 allowMetadata=true）。
 *
 * `nat64-local` 是 64:ff9b:1::/48 本地转换前缀：默认阻断；只有宿主显式配置了覆盖它的
 * `nat64Prefixes`（配置侧只接受 /96，IPv4 确实在最低 32 位），并且内嵌的 IPv4 本身
 * 分类为公网时才放行。这样即使部署了转换路由，也不能用本地 NAT64 地址绕过
 * 私网 / metadata 分类。
 */
function isAddressAllowed(address, kind, host, port, policy) {
  if (kind === 'public') return true
  if (kind === 'metadata') return policy.allowMetadata === true
  if (kind === 'nat64-local') {
    const covered = policy.nat64Prefixes.some(cidr => addressInCidr(address, cidr))
    if (!covered) return false
    const v6 = parseIPv6(address)
    if (v6 === null) return false
    const embedded = classifyAddress(embeddedIPv4Text(v6))
    return embedded !== null && embedded.kind === 'public'
  }
  const hostException = policy.allowedHosts.some(rule => hostMatchesRule(host, port, rule))
    || policy.allowInsecureOrigins.some(rule => hostMatchesRule(host, port, rule))
  if (hostException) return true
  return policy.allowedCidrs.some(cidr => addressInCidr(address, cidr))
}

/**
 * 校验目标 URL，并返回连接时要固定使用的地址。
 *
 * @param {string} rawUrl
 * @param {object} [rawPolicy] 宿主策略（normalizeHttpPolicy 之前/之后都接受）
 * @param {{ resolve?: (hostname: string) => Promise<Array<{address: string, family: number}>> }} [deps]
 * @returns {Promise<{
 *   ok: true,
 *   url: URL,
 *   protocol: 'https:' | 'http:',
 *   hostname: string,
 *   port: number,
 *   origin: string,
 *   insecure: boolean,
 *   addresses: Array<{address: string, family: number}>,
 *   lookup: Function,
 * }>}
 */
export async function validateDestination(rawUrl, rawPolicy = {}, deps = {}) {
  const policy = rawPolicy && rawPolicy.__normalized === true ? rawPolicy : normalizeHttpPolicy(rawPolicy)
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new HttpPolicyError('HTTP_URL_INVALID', 'http 节点的 url 为空；必须配置完整的目标地址。')
  }
  let url
  try {
    url = new URL(rawUrl.trim())
  } catch {
    throw new HttpPolicyError('HTTP_URL_INVALID', 'http 节点的 url 不是合法 URL。')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpPolicyError(
      'HTTP_PROTOCOL_FORBIDDEN',
      `只允许 http(s) 目标，收到 ${url.protocol}`,
      { protocol: url.protocol },
    )
  }
  if (url.username !== '' || url.password !== '') {
    throw new HttpPolicyError(
      'HTTP_URL_USERINFO_FORBIDDEN',
      '目标 URL 不允许包含用户名/密码（userinfo）；鉴权值只能经 authRef 从宿主配置解析。',
    )
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === '') {
    throw new HttpPolicyError('HTTP_URL_INVALID', '目标 URL 缺少主机名。')
  }
  if (METADATA_HOSTNAMES.has(hostname)) {
    throw new HttpPolicyError(
      'HTTP_DESTINATION_METADATA',
      `拒绝访问云 metadata 主机名：${hostname}`,
      { host: hostname },
    )
  }
  const port = url.port !== ''
    ? Number(url.port)
    : (url.protocol === 'https:' ? 443 : 80)
  const originHost = hostname.includes(':') ? `[${hostname}]` : hostname
  const origin = `${url.protocol}//${originHost}:${port}`

  const insecure = url.protocol === 'http:'
  if (insecure && !policy.allowInsecureOrigins.some(rule => hostMatchesRule(hostname, port, rule))) {
    throw new HttpPolicyError(
      'HTTP_INSECURE_FORBIDDEN',
      `默认只允许 HTTPS；明文 http 目标 ${origin} 必须在宿主策略的 allowInsecureOrigins 里精确放行。`,
      { origin },
    )
  }

  let addresses
  if (classifyAddress(hostname) !== null) {
    const classified = classifyAddress(hostname)
    addresses = [{ address: hostname, family: classified.family }]
  } else {
    const resolver = typeof deps.resolve === 'function'
      ? deps.resolve
      : (policy.resolver ?? defaultResolve)
    let resolved
    try {
      resolved = await resolver(hostname)
    } catch (error) {
      throw new HttpPolicyError(
        'HTTP_DNS_FAILED',
        `无法解析目标主机 ${hostname}：${error && error.code ? error.code : '解析失败'}`,
        { host: hostname },
      )
    }
    addresses = normalizeAddressList(resolved)
    if (addresses.length === 0) {
      throw new HttpPolicyError('HTTP_DNS_EMPTY', `目标主机 ${hostname} 没有解析到任何地址。`, { host: hostname })
    }
  }

  const blocked = []
  for (const item of addresses) {
    const classified = classifyAddress(item.address)
    if (classified === null) {
      blocked.push({ address: item.address, kind: 'invalid' })
      continue
    }
    if (!isAddressAllowed(item.address, classified.kind, hostname, port, policy)) {
      blocked.push({ address: item.address, kind: classified.kind })
    }
  }
  if (blocked.length > 0) {
    const first = blocked[0]
    const code = first.kind === 'metadata' ? 'HTTP_DESTINATION_METADATA' : 'HTTP_DESTINATION_BLOCKED'
    throw new HttpPolicyError(
      code,
      `目标 ${origin} 解析到被禁止的地址 ${first.address}（${first.kind}）；内网集成请在宿主策略里配置 host/port 或 CIDR 例外。`,
      { origin, blocked },
    )
  }

  // 固定连接地址：所有已解析结果都通过了上面的校验；这里只按 family 过滤后选第一个。
  const lookup = (lookupHostname, options, callback) => {
    const opts = typeof options === 'function' ? {} : (options || {})
    const cb = typeof options === 'function' ? options : callback
    if (typeof cb !== 'function') return
    const family = typeof opts.family === 'number' && opts.family !== 0 ? opts.family : null
    const list = family === null ? addresses : addresses.filter(item => item.family === family)
    if (list.length === 0) {
      cb(new HttpPolicyError('HTTP_DNS_EMPTY', `没有 family=${family} 的已验证地址`))
      return
    }
    if (opts.all === true) {
      cb(null, list.map(item => ({ address: item.address, family: item.family })))
      return
    }
    cb(null, list[0].address, list[0].family)
  }

  return {
    ok: true,
    url,
    protocol: url.protocol,
    hostname,
    port,
    origin,
    insecure,
    addresses,
    lookup,
  }
}

/* ── 凭据引用 / 脱敏 ───────────────────────────────────────────── */

/** `authRef` → 环境变量名（只做名字映射，不读值）。 */
export function authRefEnvName(authRef) {
  const normalized = String(authRef).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `${AUTH_ENV_PREFIX}${normalized}`
}

function assertHeaderName(name) {
  if (typeof name !== 'string' || !HEADER_NAME.test(name)) {
    throw new HttpPolicyError('HTTP_AUTH_REF_INVALID', 'authRef 解析结果里的 header 名不合法（不是合法 HTTP header token）。')
  }
}

function valueHeader(name, value) {
  assertHeaderName(name)
  if (typeof value !== 'string' || value === '' || /[\r\n]/.test(value)) {
    throw new HttpPolicyError('HTTP_AUTH_REF_INVALID', `authRef 解析结果里的 header ${name} 值不合法（空值或含换行）。`)
  }
  return { [name.toLowerCase()]: value }
}

/**
 * 从宿主配置解析 `authRef` 对应的鉴权 header。
 *
 * 接口（宿主侧接线点）：
 *   - `options.resolve(authRef)`：宿主注入的解析器，返回 header 对象；
 *   - 否则读环境变量 `FLOW_STUDIO_HTTP_AUTH_<REF>`：
 *       * 普通字符串 → `Authorization: Bearer <值>`；
 *       * JSON `{type:'bearer',token}` / `{type:'basic',username,password}` /
 *         `{type:'header',name,value}`。
 *
 * 返回对象只含 header；密钥值不进入 message / details。缺失或非法时抛
 * `HTTP_AUTH_REF_UNRESOLVED` / `HTTP_AUTH_REF_INVALID`。
 */
export async function resolveAuthRef(authRef, options = {}) {
  if (typeof authRef !== 'string' || authRef.trim() === '') {
    throw new HttpPolicyError('HTTP_AUTH_REF_UNRESOLVED', 'http 节点声明了 authRef，但 authRef 是空值。')
  }
  if (typeof options.resolve === 'function') {
    const resolved = await options.resolve(authRef)
    if (resolved === null || resolved === undefined) {
      throw new HttpPolicyError(
        'HTTP_AUTH_REF_UNRESOLVED',
        `authRef「${authRef}」在宿主凭据配置里不存在。`,
        { authRef },
      )
    }
    if (!isPlainObject(resolved)) {
      throw new HttpPolicyError('HTTP_AUTH_REF_INVALID', `authRef「${authRef}」的解析结果必须是 header 对象。`, { authRef })
    }
    const headers = {}
    for (const [name, value] of Object.entries(resolved)) {
      Object.assign(headers, valueHeader(name, String(value)))
    }
    return headers
  }

  const env = options.env ?? process.env
  const envName = authRefEnvName(authRef)
  const raw = env ? env[envName] : undefined
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new HttpPolicyError(
      'HTTP_AUTH_REF_UNRESOLVED',
      `authRef「${authRef}」没有宿主凭据：需要配置环境变量 ${envName}（或注入 authResolver）。`,
      { authRef, envName },
    )
  }

  const text = raw.trim()
  if (!text.startsWith('{')) {
    return { authorization: `Bearer ${text}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpPolicyError(
      'HTTP_AUTH_REF_INVALID',
      `authRef「${authRef}」的宿主凭据不是合法 JSON（值不会被记录）。`,
      { authRef, envName },
    )
  }
  if (!isPlainObject(parsed)) {
    throw new HttpPolicyError('HTTP_AUTH_REF_INVALID', `authRef「${authRef}」的宿主凭据必须是对象或字符串。`, { authRef })
  }

  const type = typeof parsed.type === 'string' ? parsed.type.trim().toLowerCase() : 'bearer'
  if (type === 'bearer') {
    if (typeof parsed.token !== 'string' || parsed.token === '') {
      throw new HttpPolicyError('HTTP_AUTH_REF_INVALID', `authRef「${authRef}」缺少 token。`, { authRef })
    }
    return valueHeader('authorization', `Bearer ${parsed.token}`)
  }
  if (type === 'basic') {
    if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
      throw new HttpPolicyError('HTTP_AUTH_REF_INVALID', `authRef「${authRef}」缺少 username/password。`, { authRef })
    }
    const encoded = Buffer.from(`${parsed.username}:${parsed.password}`, 'utf8').toString('base64')
    return valueHeader('authorization', `Basic ${encoded}`)
  }
  if (type === 'header') {
    return valueHeader(parsed.name, parsed.value)
  }
  throw new HttpPolicyError(
    'HTTP_AUTH_REF_INVALID',
    `authRef「${authRef}」的凭据 type=${JSON.stringify(type)} 不支持（bearer/basic/header）。`,
    { authRef },
  )
}

/** header 名是否是密钥 / 鉴权头（禁止出现在 XML 配置与事件里）。 */
export function isSecretHeaderName(name) {
  if (typeof name !== 'string') return false
  const lower = name.trim().toLowerCase()
  return SECRET_HEADER_NAMES.has(lower) || SECRET_HEADER_PATTERN.test(lower)
}

/** URL 里像密钥的查询参数（脱敏时替换值）。 */
function redactUrl(urlText) {
  if (typeof urlText !== 'string' || urlText === '') return urlText
  try {
    const url = new URL(urlText)
    for (const key of [...url.searchParams.keys()]) {
      if (isSecretHeaderName(key)) url.searchParams.set(key, '[redacted]')
    }
    return url.toString()
  } catch {
    return urlText
  }
}

/**
 * 返回一份可安全进日志 / 事件 / 错误详情的配置副本。
 * 密钥 header 的值替换为 `[redacted]`，authRef 只保留引用名（不是密钥值）。
 */
export function redactHttpConfig(config) {
  if (!isPlainObject(config)) return config
  const output = { ...config }
  if (isPlainObject(config.headers)) {
    const headers = {}
    for (const [name, value] of Object.entries(config.headers)) {
      headers[name] = isSecretHeaderName(name) ? '[redacted]' : value
    }
    output.headers = headers
  }
  if (typeof config.url === 'string') output.url = redactUrl(config.url)
  if (config.authRef !== undefined) output.authRef = String(config.authRef)
  return output
}
