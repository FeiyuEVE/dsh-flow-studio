/**
 * Host 数据通道：同源 fetch 到 /api/flow-studio。
 *
 * 0.13.3 起客户端只认 **定义域 / 实例域** 契约（docs/design/10-bpmn-instance-api.md）：
 * 定义版本（`/definitions`）、实例（`/instances`）、增量事件（`?since=`）、
 * 人工待办与实例定义快照。旧运行域（`/flows`、`/runs`）的请求函数暂时留在
 * `legacyApi` 里——页面接线在下一阶段（步骤 5 后半），本阶段不改 page.js /
 * logdrawer.js，不能先删掉它们仍在调用的方法。
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

/**
 * 0.10 R8：`POST /runs/<id>/restart` 的失败文案。202 成功；失败按 HTTP 分流：
 *  - 400：Host 原文（起点不在 next 路径 / 结构不合法 / run 还在跑…）；
 *  - 404：run 或流程已不存在；
 *  - 500：执行引擎未启用 / 不支持 restart；
 *  - 503：有可继承会话但宿主 agents 不可用；
 *  - 网络错误（没有 status）：用 error.message。
 *
 * @deprecated 0.13.3 步骤 7 删除（旧运行域）。
 */
export function restartFailureText(status, data, message) {
  const detail = data && typeof data.error === 'string' ? data.error.trim() : ''
  if (status === 400) {
    // 0.10 审查 F5：page.js 会把 api 抛出的通用错误文案（请求失败（HTTP 400））当 message
    // 传进来；400 且 Host 没给 detail 时不能用它覆盖可行动兜底。
    const generic = typeof message === 'string' && /^请求失败（HTTP \d+）/.test(message)
    return '重启失败：' + (detail || (!generic && message) || '请求不合法，刷新后重试')
  }
  if (status === 404) return '重启失败：run 或流程已不存在，刷新后重试'
  if (status === 500) return '重启失败：执行引擎未启用或版本不匹配'
  if (status === 503) return '重启失败：宿主 agents 不可用，无法在原会话续跑'
  if (typeof status === 'number' && status > 0) {
    return '重启失败：' + (detail || message || ('Host 返回 HTTP ' + status))
  }
  return '重启失败：' + (message || '连不上 Host 或响应不可读')
}

/**
 * 运行控制失败文案（06 §10/§11）。409 是**业务态**而不是故障：
 *  - `start` 撞上全局运行锁 → 「已有 run 在运行」；
 *  - `stop` 时目标已经不在跑 → 「不在运行中」。
 * 两种都把 Host 的原始原因附在后面，但先说人话——用户不需要读 HTTP 码。
 *
 * @deprecated 0.13.3 步骤 7 删除（旧运行域）。
 */
export function runActionFailureText(action, status, data) {
  const detail = data && typeof data.error === 'string' ? data.error.trim() : ''
  const suffix = detail === '' ? '' : '（Host：' + detail + '）'
  // 0.10 R8：restart 的文案与上面同一套 HTTP 口径，不再复述 start/stop 的 409 分支。
  if (action === 'restart') return restartFailureText(status, data, detail)
  const prefix = action === 'stop' ? '停止失败：' : '开始失败：'
  if (status === 409) {
    if (action === 'stop') {
      return '停止失败：这个 run 已经不在运行中，不需要再停。刷新后确认当前状态。' + suffix
    }
    // start 的 409 有两种来源：全局运行锁（要先去停）与「这个 run 已开始过 / 已结束」。
    const locked = /已有运行中|已有 run 正在运行|只允许一个/.test(detail)
    if (locked) return '开始失败：已有 run 正在运行。先停止它，再开始新的运行。' + suffix
    if (detail !== '') return '开始失败：' + detail + '。请新建一个 run 后再开始。'
    return '开始失败：当前不能开始这个 run（可能已有 run 在跑，或它已经结束）。' + suffix
  }
  if (status === 404) return prefix + 'run 不存在（可能已被删除），刷新运行记录后重试。' + suffix
  if (status === 401) return requestFailureText(status, data)
  if (status === 403) return prefix + '请求被拒绝（跨站或权限不足）。' + suffix
  if (status === 405) return prefix + 'Host 还没有提供运行控制接口（执行引擎未启用或版本不匹配）。' + suffix
  if (detail !== '') return prefix + detail
  if (typeof status === 'number' && status > 0) return prefix + `Host 返回 HTTP ${status}`
  return prefix + '连不上 Host 或响应不可读。'
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
}

// ---------------------------------------------------------------------------
// 旧运行域（/flows、/runs）——0.13.3 步骤 7 删除
// ---------------------------------------------------------------------------

/**
 * 事件查询路径（旧 `/runs` 契约，纯函数，便于单测 `since` + `kind` 形态）。
 *
 * @deprecated 0.13.3 步骤 7 删除（新实例事件走 {@link instanceEventsPath}）。
 */
export function readEventsPath(id, options = {}) {
  const kinds = []
  if (options && Array.isArray(options.kinds)) {
    for (const kind of options.kinds) {
      if (typeof kind === 'string' && kind !== '') kinds.push(kind)
    }
  }
  if (options && typeof options.kind === 'string' && options.kind !== '') kinds.push(options.kind)
  return withQuery(`/runs/${segment(id)}/events`, {
    nodeId: options && options.nodeId,
    attemptId: options && options.attemptId,
    // Host 读的是重复的 `kind` 参数；数组在这里展开成同一个 key。
    kind: kinds,
    since: options && options.since,
    limit: options && options.limit !== undefined ? options.limit : 200,
    order: (options && options.order) || 'desc',
  })
}

/**
 * G5-a：run 详情路径。`light: true` 只取运行元信息。
 *
 * @deprecated 0.13.3 步骤 7 删除（旧运行域）。
 */
export function readRunPath(id, options = {}) {
  return withQuery(`/runs/${segment(id)}`, {
    light: options && options.light === true ? 1 : undefined,
  })
}

/** G5-a：只有「Host 不认这个接口」才算能力降级；网络错误 / 5xx 照常抛。 @deprecated 步骤 7 删除 */
export function isLightPollUnsupported(error) {
  return Boolean(error && (error.status === 400 || error.status === 404))
}

/** G5-a：降级一次的提示文案。 @deprecated 步骤 7 删除 */
export const LIGHT_POLL_FALLBACK_NOTICE =
  'Host 不支持轻量轮询（GET /runs/<id>?light=1），已回退到完整详情接口；本次会话不再尝试 light=1。'

/**
 * G5-a：轻量轮询读取器（旧运行域）。
 *
 * @deprecated 0.13.3 步骤 7 删除。
 */
export function createLightRunReader(options = {}) {
  const readRun = typeof options.readRun === 'function'
    ? options.readRun
    : (id, readOptions) => api.readRun(id, readOptions)
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  let supported = true
  let warned = false

  return {
    async read(id) {
      if (supported) {
        try {
          const data = await readRun(id, { light: true })
          return { data, light: true, degraded: false }
        } catch (error) {
          if (!isLightPollUnsupported(error)) throw error
          supported = false
          if (!warned) {
            warned = true
            warn(LIGHT_POLL_FALLBACK_NOTICE)
          }
        }
      }
      const data = await readRun(id)
      return { data, light: false, degraded: true }
    },
    get lightSupported() {
      return supported
    },
    get warned() {
      return warned
    },
  }
}

/** G5-d：无运行中 run 时的列表轮询间隔（降频，不是完全停）。 @deprecated 步骤 7 删除 */
export const RUNS_IDLE_POLL_MS = 15000
/** G5-d：列表轮询失败后的退避上限。 @deprecated 步骤 7 删除 */
export const RUNS_MAX_BACKOFF_MS = 60000

/**
 * G5-d：共享 runs 数据源（旧运行域）。
 *
 * @deprecated 0.13.3 步骤 7 删除。
 */
export function createRunsSource(options = {}) {
  const read = typeof options.read === 'function' ? options.read : () => api.listRuns(20)
  const configuredIdle = Number(options.idleMs)
  const idleMs = Number.isFinite(configuredIdle) && configuredIdle >= 1000
    ? Math.floor(configuredIdle)
    : RUNS_IDLE_POLL_MS
  const maxBackoffMs = Number.isFinite(Number(options.maxBackoffMs)) && Number(options.maxBackoffMs) >= idleMs
    ? Math.floor(Number(options.maxBackoffMs))
    : RUNS_MAX_BACKOFF_MS
  const setTimer = typeof options.setTimeout === 'function'
    ? options.setTimeout
    : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof options.clearTimeout === 'function'
    ? options.clearTimeout
    : id => clearTimeout(id)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const minRefreshMs = Number.isFinite(Number(options.minRefreshMs)) && Number(options.minRefreshMs) >= 0
    ? Math.floor(Number(options.minRefreshMs))
    : 1000

  /** 快照不可变：每次更新换一个新对象，订阅方按引用比较就能判断是否同一 tick。 */
  let snapshot = { payload: null, loaded: false, error: '', tick: 0, updatedAt: 0 }
  const listeners = new Set()
  let inflight = null
  let timer = null
  let running = false
  let failures = 0

  function emit() {
    const current = snapshot
    for (const listener of [...listeners]) {
      try {
        listener(current)
      } catch {
        // 单个订阅方渲染出错不能拖垮其它订阅方（也不该让轮询停止）。
      }
    }
  }

  function clearScheduled() {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  function schedule() {
    clearScheduled()
    if (!running) return
    const delay = Math.min(maxBackoffMs, idleMs * 2 ** Math.min(failures, 3))
    timer = setTimer(() => {
      timer = null
      void refresh({ force: true })
    }, delay)
  }

  function refresh(refreshOptions = {}) {
    if (inflight) return inflight
    const force = refreshOptions && refreshOptions.force === true
    if (!force && snapshot.updatedAt > 0 && now() - snapshot.updatedAt < minRefreshMs) {
      return Promise.resolve(snapshot)
    }
    inflight = (async () => {
      try {
        const payload = await read()
        failures = 0
        snapshot = {
          payload,
          loaded: true,
          error: '',
          tick: snapshot.tick + 1,
          updatedAt: now(),
        }
      } catch (error) {
        failures += 1
        snapshot = {
          ...snapshot,
          loaded: true,
          error: error && error.message ? error.message : String(error),
          tick: snapshot.tick + 1,
          updatedAt: now(),
        }
      } finally {
        inflight = null
        emit()
        schedule()
      }
      return snapshot
    })()
    return inflight
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      if (snapshot.loaded) {
        try {
          listener(snapshot)
        } catch {
          // 首帧回调失败不影响后续 tick。
        }
      }
      return () => listeners.delete(listener)
    },
    refresh,
    start() {
      if (running) return
      running = true
      void refresh({ force: true })
    },
    stop() {
      running = false
      clearScheduled()
    },
    foreground() {
      if (!running) return
      void refresh({ force: true })
    },
    get running() {
      return running
    },
    get idleMs() {
      return idleMs
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

/**
 * 旧运行域 API 的临时出口（**0.13.3 步骤 7 删除**）。
 *
 * page.js / logdrawer.js 尚未迁移到 definitions/instances（页面接线在下一阶段），
 * 现有测试也仍按 `api.readRun` / `api.startRun` 取用；本阶段只能保留这些方法，
 * 否则会先弄断旧页面而不是完成迁移。新代码禁止调用它们。
 */
export const legacyApi = {
  listFlows: () => request('GET', '/flows'),
  createFlow: body => request('POST', '/flows', body || {}),
  readFlow: id => request('GET', `/flows/${encodeURIComponent(id)}`),
  saveFlow: (id, flow) => request('PUT', `/flows/${encodeURIComponent(id)}`, flow),
  deleteFlow: id => request('DELETE', `/flows/${encodeURIComponent(id)}`),
  listSkills: () => request('GET', '/skills'),

  // ── 运行日志（docs/design/05-run-log.md §5）────────────────────────────
  listRuns: (limit = 20) => request('GET', withQuery('/runs', { limit })),
  createRun: body => request('POST', '/runs', body || {}),
  readRun: (id, options) => request('GET', readRunPath(id, options)),
  readEvents: (id, options) => request('GET', readEventsPath(id, options)),
  readSummary: id => request('GET', `/runs/${segment(id)}/summary`),
  deleteRun: id => request('DELETE', `/runs/${segment(id)}`),

  // ── 运行控制（docs/design/06-execution-engine.md §10）────────────────────
  // 202 `{run}`；run 带 live 字段。运行中 start → 409，不在跑 stop → 409，
  // 两种业务态由调用方用 runActionFailureText 转成人话。
  // F2：start 也带请求体 {workspace}（后端缺 workspace 会 400，不再回落到进程 cwd）。
  startRun: (id, body) => request('POST', `/runs/${segment(id)}/start`, body),
  stopRun: id => request('POST', `/runs/${segment(id)}/stop`),
  // 0.10 R8：202 `{ok, run, restart, plan, hint}`；非幂等，调用方不得自动重试。
  restartRun: (id, body) => request('POST', `/runs/${segment(id)}/restart`, body || {}),
}

// 旧页面与旧测试还按 `api.listFlows` / `api.readRun` 取用；保留到步骤 7 一起删。
Object.assign(api, legacyApi)

/**
 * 导出链接（旧运行域）：浏览器直接下载 `text/markdown`，不经过 fetch，因此带不了
 * Authorization 头；可选鉴权模式下用 Host 支持的 `?token=` 形式（05 §8.5）。
 *
 * @deprecated 0.13.3 步骤 7 删除。
 */
export function exportUrl(runId) {
  const token = resolveToken()
  const base = `${BASE}/runs/${segment(runId)}/export`
  return token === '' ? base : `${base}?token=${encodeURIComponent(token)}`
}
