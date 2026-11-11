/**
 * Host 数据通道：同源 fetch 到 /api/flow-studio。
 *
 * 客户端只认 **定义域 / 实例域** 契约（docs/design/10-bpmn-instance-api.md）：
 * 定义版本（`/definitions`）、实例（`/instances`）、增量事件（`?since=`）、
 * 人工待办与实例定义快照。旧运行域（`/flows`、`/runs`）已随 0.14.0 从
 * Host 删除，客户端也不再保留任何旧 helper。
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

/** 拼查询串：省略空值，数组按重复键发送。`0` 是有效值（例如 `?since=0`）。 */
function withQuery(path, params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue
        search.append(key, String(item))
      }
      continue
    }
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? path : `${path}?${text}`
}

/** 路径段编码；id 由 Host 校验，这里只防 URL 注入。 */
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
    const failure = new Error(`连不上 Host：${error && error.message ? error.message : String(error)}`)
    failure.code = 'NETWORK_ERROR'
    failure.status = 0
    throw failure
  }
  let data = {}
  try {
    data = await response.json()
  } catch {
    data = {}
  }
  if (!response.ok || data.ok === false) {
    const error = new Error(requestFailureText(response.status, data))
    // 调用方要能区分 409（业务态）/ 404 / 405（Host 未实现）与真正的连接失败，
    // 也要能按稳定业务码分流（INSTANCE_NOT_FOUND / BPMN_TASK_NOT_FOUND…）。
    error.status = response.status
    error.code = typeof data.code === 'string' ? data.code : ''
    error.data = data
    throw error
  }
  return data
}

// ---------------------------------------------------------------------------
// 定义域 / 实例域（0.13.3 新契约）
// ---------------------------------------------------------------------------

/** `GET /definitions`。 */
export function definitionsPath() {
  return '/definitions'
}

/** `GET /definitions/<id>[?version=N]`；version 省略 = 最新版。 */
export function definitionPath(id, options = {}) {
  return withQuery(`/definitions/${segment(id)}`, {
    version: options && options.version,
  })
}

/** `GET /instances[?definitionId=&status=&limit=]`。 */
export function instancesPath(options = {}) {
  return withQuery('/instances', {
    definitionId: options && options.definitionId,
    status: options && options.status,
    limit: options && options.limit,
  })
}

/** `GET /instances/<id>`。 */
export function instancePath(id) {
  return `/instances/${segment(id)}`
}

/** `GET /instances/<id>/events[?since=N]`；只发 since，不再发旧接口的 kind/order/light。 */
export function instanceEventsPath(id, options = {}) {
  return withQuery(`${instancePath(id)}/events`, {
    since: options && options.since,
  })
}

/** `GET /instances/<id>/tasks`。 */
export function instanceTasksPath(id) {
  return `${instancePath(id)}/tasks`
}

/** `GET /instances/<id>/messages[?cursor=&limit=]`（0.13.10 收件箱）。 */
export function instanceMessagesPath(id, options = {}) {
  return withQuery(`${instancePath(id)}/messages`, {
    cursor: options && options.cursor,
    limit: options && options.limit,
  })
}

/** `POST /instances/<id>/messages`：受理一条外部消息。 */
export function instanceMessageSendPath(id) {
  return `${instancePath(id)}/messages`
}

/** `GET /instances/<id>/messages/<messageId>/body`：鉴权后读正文全文。 */
export function instanceMessageBodyPath(id, messageId) {
  return `${instanceMessagesPath(id)}/${segment(messageId)}/body`
}

/** `POST /instances/<id>/messages/<messageId>/replies`：受控回复（replyId 幂等）。 */
export function instanceMessageRepliesPath(id, messageId) {
  return `${instanceMessagesPath(id)}/${segment(messageId)}/replies`
}

/** `POST /instances/<id>/tasks/<activityId>/complete`。 */
export function completeTaskPath(id, activityId) {
  return `${instanceTasksPath(id)}/${segment(activityId)}/complete`
}

/** `POST /instances/<id>/stop`。 */
export function stopInstancePath(id) {
  return `${instancePath(id)}/stop`
}

/** `GET /instances/<id>/definition`（实例冻结快照，只读）。 */
export function instanceDefinitionPath(id) {
  return `${instancePath(id)}/definition`
}

/**
 * `GET /instances/<id>/worktree`（0.13.8：实例工作区检查）。
 * `DELETE` 同一个路径清理工作树，请求体 `{force?, removeBranch?, expectedHead?}`。
 */
export function instanceWorktreePath(id) {
  return `${instancePath(id)}/worktree`
}

/** `DELETE /instances/<id>/worktree/branch`（只删记录确属本实例的分支）。 */
export function instanceWorktreeBranchPath(id) {
  return `${instanceWorktreePath(id)}/branch`
}

/** `GET /instance-worktrees[?workspaceId=]`（实例资源列表，含 orphan）。 */
export function instanceWorktreesPath(options = {}) {
  return withQuery('/instance-worktrees', {
    workspaceId: options && options.workspaceId,
  })
}

/** `POST /instance-worktrees/prune`（默认 dryRun；执行必须带预览的 planHash）。 */
export function instanceWorktreesPrunePath() {
  return '/instance-worktrees/prune'
}

/** `GET /instances/<id>/metrics[?asOf=ISO]`（0.13.10 实例运行指标，纯读）。 */
export function instanceMetricsPath(id, options = {}) {
  return withQuery(`${instancePath(id)}/metrics`, {
    asOf: options && options.asOf,
  })
}

/** `GET /metrics?definitionId=&definitionVersion=&from=&to=&status=&groupBy=day[&asOf=]`。 */
export function metricsPath(options = {}) {
  return withQuery('/metrics', {
    definitionId: options && options.definitionId,
    definitionVersion: options && options.definitionVersion,
    from: options && options.from,
    to: options && options.to,
    status: options && options.status,
    groupBy: options && options.groupBy,
    asOf: options && options.asOf,
  })
}

/** `GET /instances/<id>/evidence[?asOf=ISO]`（0.13.12 业务证据，纯读）。 */
export function instanceEvidencePath(id, options = {}) {
  return withQuery(`${instancePath(id)}/evidence`, {
    asOf: options && options.asOf,
  })
}

/** `GET /instances/<id>/resource-events[?since=N]`（worktree / 产物资源事件）。 */
export function instanceResourceEventsPath(id, options = {}) {
  return withQuery(`${instancePath(id)}/resource-events`, {
    since: options && options.since,
  })
}

/**
 * 0.13.3 主契约：定义 / 实例。页面只用这些方法，不再走「先建 run 再 /start」。
 * 所有方法返回 Host 原样信封（`{ok:true, …}`），失败抛带 `status/code/data` 的 Error。
 */
export const api = {
  health: () => request('GET', '/health'),

  // ── 定义域 ────────────────────────────────────────────────────────────
  listDefinitions: () => request('GET', definitionsPath()),
  readDefinition: (id, options) => request('GET', definitionPath(id, options)),
  saveDefinition: body => request('POST', definitionsPath(), body || {}),

  // ── 实例域 ────────────────────────────────────────────────────────────
  createInstance: body => request('POST', instancesPath(), body || {}),
  listInstances: options => request('GET', instancesPath(options)),
  readInstance: id => request('GET', instancePath(id)),
  readInstanceEvents: (id, options) => request('GET', instanceEventsPath(id, options)),
  readInstanceTasks: id => request('GET', instanceTasksPath(id)),
  completeInstanceTask: (id, activityId, body) => request('POST', completeTaskPath(id, activityId), body || {}),
  stopInstance: id => request('POST', stopInstancePath(id)),
  readInstanceDefinition: id => request('GET', instanceDefinitionPath(id)),

  // ── 实例收件箱（0.13.10）──────────────────────────────────────────────
  readInstanceMessages: (id, options) => request('GET', instanceMessagesPath(id, options)),
  sendInstanceMessage: (id, body) => request('POST', instanceMessageSendPath(id), body || {}),
  readInstanceMessageBody: (id, messageId) => request('GET', instanceMessageBodyPath(id, messageId)),
  replyInstanceMessage: (id, messageId, body) => request('POST', instanceMessageRepliesPath(id, messageId), body || {}),

  // ── 实例工作区（0.13.8）────────────────────────────────────────────────
  readInstanceWorktree: id => request('GET', instanceWorktreePath(id)),
  removeInstanceWorktree: (id, body) => request('DELETE', instanceWorktreePath(id), body || {}),
  removeInstanceWorktreeBranch: id => request('DELETE', instanceWorktreeBranchPath(id)),
  listInstanceWorktrees: options => request('GET', instanceWorktreesPath(options)),
  pruneInstanceWorktrees: body => request('POST', instanceWorktreesPrunePath(), body || {}),
  readInstanceResourceEvents: (id, options) => request('GET', instanceResourceEventsPath(id, options)),

  // ── 运行指标（0.13.10 E1）──────────────────────────────────────────────
  readInstanceMetrics: (id, options) => request('GET', instanceMetricsPath(id, options)),
  readMetrics: options => request('GET', metricsPath(options)),

  // ── 业务证据（0.13.12 E2）──────────────────────────────────────────────
  readInstanceEvidence: (id, options) => request('GET', instanceEvidencePath(id, options)),
}
