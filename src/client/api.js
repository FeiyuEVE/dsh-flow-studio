/**
 * Host 数据通道：同源 fetch 到 /api/flow-studio。
 *
 * 浏览器端没有 remote/host builtin，HTTP 是唯一的跨进程通道；
 * 同源请求会自动带上 dsh 的鉴权 cookie。
 *
 * @module @feiyueve/dsh-flow-studio/client/api
 */

const BASE = '/api/flow-studio'

/** 可选鉴权（05 §8.5）：URL 里带的访问令牌只读一次，存进 sessionStorage。 */
export const FS_TOKEN_STORAGE_KEY = 'dsh-flow-studio.fs_token'

/** 从 `?fs_token=...` 里取令牌；空 / 非法 / 未配置一律返回空串。 */
export function extractFsToken(search) {
  if (typeof search !== 'string' || search.trim() === '') return ''
  try {
    const raw = search.startsWith('?') ? search.slice(1) : search
    const token = new URLSearchParams(raw).get('fs_token')
    return typeof token === 'string' ? token.trim() : ''
  } catch {
    return ''
  }
}

/** 有令牌才带请求头；没有令牌保持默认行为（同源请求，不加 Authorization）。 */
export function authorizationHeader(token) {
  return typeof token === 'string' && token !== '' ? { Authorization: 'Bearer ' + token } : {}
}

/** URL 里的令牌存一次到 sessionStorage；返回取到的令牌，供调用方直接用。 */
export function captureFsToken(search, storage) {
  const token = extractFsToken(search)
  if (token !== '' && storage && typeof storage.setItem === 'function') {
    try {
      storage.setItem(FS_TOKEN_STORAGE_KEY, token)
    } catch {
      // 隐私模式 / 存储被禁用：令牌仍可本次使用，不值得让页面崩掉。
    }
  }
  return token
}

let cachedToken = null

function browserStorage() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage
    if (typeof sessionStorage !== 'undefined') return sessionStorage
  } catch {
    return null
  }
  return null
}

function browserSearch() {
  try {
    if (typeof window !== 'undefined' && window.location) return window.location.search || ''
    if (typeof location !== 'undefined') return location.search || ''
  } catch {
    return ''
  }
  return ''
}

/** 解析一次后缓存：URL 优先，其次 sessionStorage 里上次存下的令牌。 */
function resolveToken() {
  if (cachedToken !== null) return cachedToken
  const storage = browserStorage()
  const fromUrl = captureFsToken(browserSearch(), storage)
  if (fromUrl !== '') {
    cachedToken = fromUrl
    return cachedToken
  }
  try {
    const stored = storage && typeof storage.getItem === 'function'
      ? storage.getItem(FS_TOKEN_STORAGE_KEY)
      : ''
    cachedToken = typeof stored === 'string' ? stored.trim() : ''
  } catch {
    cachedToken = ''
  }
  return cachedToken
}

/** 失败文案：401 给出可操作的令牌提示，其余保留 Host 的可读错误。 */
export function requestFailureText(status, data) {
  if (status === 401) return '需要访问令牌：用 ?fs_token=… 打开一次'
  return (data && data.error) || `请求失败（HTTP ${status}）`
}

/** 拼查询串：省略空值，数组按重复键发送。 */
function withQuery(path, params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? path : `${path}?${text}`
}

/** 路径段编码；runId 由 Host 校验，这里只防 URL 注入。 */
function segment(value) {
  return encodeURIComponent(String(value))
}

async function request(method, path, body) {
  const headers = { ...authorizationHeader(resolveToken()) }
  const init = { method, credentials: 'same-origin', headers }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let response
  try {
    response = await fetch(BASE + path, init)
  } catch (error) {
    throw new Error(`连不上 Host：${error && error.message ? error.message : String(error)}`)
  }
  let data = {}
  try {
    data = await response.json()
  } catch {
    data = {}
  }
  if (!response.ok || data.ok === false) {
    throw new Error(requestFailureText(response.status, data))
  }
  return data
}

export const api = {
  health: () => request('GET', '/health'),
  listFlows: () => request('GET', '/flows'),
  createFlow: body => request('POST', '/flows', body || {}),
  readFlow: id => request('GET', `/flows/${encodeURIComponent(id)}`),
  saveFlow: (id, flow) => request('PUT', `/flows/${encodeURIComponent(id)}`, flow),
  deleteFlow: id => request('DELETE', `/flows/${encodeURIComponent(id)}`),
  listSkills: () => request('GET', '/skills'),

  // ── 运行日志（docs/design/05-run-log.md §5）────────────────────────────
  // 返回值保持 Host 原样信封；绘制层统一走 logdrawer.js 里的归一化函数，
  // 这样 Host 换信封（runs / list / data.runs）时客户端不会白屏。
  listRuns: (limit = 20) => request('GET', withQuery('/runs', { limit })),
  createRun: body => request('POST', '/runs', body || {}),
  readRun: id => request('GET', `/runs/${segment(id)}`),
  readEvents: (id, options) => request('GET', withQuery(`/runs/${segment(id)}/events`, {
    nodeId: options && options.nodeId,
    attemptId: options && options.attemptId,
    kind: options && options.kind,
    since: options && options.since,
    limit: options && options.limit !== undefined ? options.limit : 200,
    order: (options && options.order) || 'desc',
  })),
  readSummary: id => request('GET', `/runs/${segment(id)}/summary`),
  deleteRun: id => request('DELETE', `/runs/${segment(id)}`),
}

/**
 * 导出链接：浏览器直接下载 `text/markdown`，不经过 fetch，因此带不了
 * Authorization 头；可选鉴权模式下用 Host 支持的 `?token=` 形式（05 §8.5）。
 */
export function exportUrl(runId) {
  const token = resolveToken()
  const base = `${BASE}/runs/${segment(runId)}/export`
  return token === '' ? base : `${base}?token=${encodeURIComponent(token)}`
}
