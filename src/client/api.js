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

/**
 * 运行控制失败文案（06 §10/§11）。409 是**业务态**而不是故障：
 *  - `start` 撞上全局运行锁 → 「已有 run 在运行」；
 *  - `stop` 时目标已经不在跑 → 「不在运行中」。
 * 两种都把 Host 的原始原因附在后面，但先说人话——用户不需要读 HTTP 码。
 */
export function runActionFailureText(action, status, data) {
  const detail = data && typeof data.error === 'string' ? data.error.trim() : ''
  const suffix = detail === '' ? '' : '（Host：' + detail + '）'
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

/** 拼查询串：省略空值，数组按重复键发送（事件的 kind 过滤用得到）。 */
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
    const error = new Error(requestFailureText(response.status, data))
    // 运行控制需要区分 409（业务态）/ 404 / 405（Host 未实现）与真正的连接失败。
    error.status = response.status
    error.data = data
    throw error
  }
  return data
}

/**
 * 事件查询路径（纯函数，便于单测 M5 的 `since` + `kind` 形态）：
 * kinds 数组按重复 `kind` 发送；单值 kind 保留给旧调用方。
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
 * G5-a：run 详情路径。`light: true` 只取运行元信息（live / nodeStatus / workspace /
 * worktree 摘要），Host 侧**不读、不解析事件文件**——运行中 2s 轮询用它，
 * 避免长 run（实测 20k 事件约 113ms/次）把单线程 Host 拖住。
 *
 * 需要完整事件明细（打开日志抽屉、节点标题）时不要带 light，仍走原来的详情接口。
 */
export function readRunPath(id, options = {}) {
  return withQuery(`/runs/${segment(id)}`, {
    light: options && options.light === true ? 1 : undefined,
  })
}

/** G5-a：只有「Host 不认这个接口」才算能力降级；网络错误 / 5xx 照常抛。 */
export function isLightPollUnsupported(error) {
  return Boolean(error && (error.status === 400 || error.status === 404))
}

/** G5-a：降级一次的提示文案（给用户看，不是控制台静默）。 */
export const LIGHT_POLL_FALLBACK_NOTICE =
  'Host 不支持轻量轮询（GET /runs/<id>?light=1），已回退到完整详情接口；本次会话不再尝试 light=1。'

/**
 * G5-a：轻量轮询读取器。第一次撞上 400/404 就永久降级到旧详情接口，并只警告一次；
 * 之后每一轮直接走旧接口（不会每轮再先试一次 light、也不会无限重试）。
 *
 * @param {object} [options]
 * @param {(id: string, options?: object) => Promise<object>} [options.readRun]
 * @param {(message: string) => void} [options.warn]
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

/** G5-d：无运行中 run 时的列表轮询间隔（降频，不是完全停）。 */
export const RUNS_IDLE_POLL_MS = 15000
/** G5-d：列表轮询失败后的退避上限；避免 Host 抖动时把 15s 档打成 0.5s 档。 */
export const RUNS_MAX_BACKOFF_MS = 60000

/**
 * G5-d：共享 runs 数据源。
 *
 * 左栏「运行记录」和日志抽屉里的 run 列表必须吃**同一份轮询结果 + 同一个 tick**：
 *  - `subscribe(fn)` 的所有订阅方拿到同一个快照对象，不会各拉各的；
 *  - 并发 `refresh()` 共用同一个在飞 promise（两处同时挂载只发一次请求）；
 *  - `start()` 立即刷新一次，之后按 `idleMs`（默认 15s）定时刷新；
 *  - `foreground()` 供切回前台 / 重新打开面板时立即刷新一次；
 *  - 失败按 2 倍退避（15s→30s→60s），成功后清零。
 *
 * 纯逻辑 + 注入 reader / 定时器，SSR 与单测都能直接使用。
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
