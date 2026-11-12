/**
 * ACP `session/update` → DSH 事件投影（0.15 ACP P3）。
 *
 * 这个模块是**纯投影**：不 spawn、不读写文件、不接管节点生命周期。它只做三件事：
 *   1. 把少量 ACP 变体投影成业务事件（`activity/output` / `tool/*` /
 *      `agent/permission`）；
 *   2. 把其它变体压成**有界摘要**，放进 `diagnostics().logs`（绝不把 17 KB 的
 *      `available_commands_update` 原样落盘）；
 *   3. 所有出口按固定次序脱敏：显式 env 值 / finish token / socket / runDir 精确替换
 *      → 共享 `redactText` → UTF-8 字节截断。
 *
 * 设计约束（06 §13、方案 P3）：
 *   - `agent_message_chunk.text` 整轮暂存，`endTurn()` 才整段脱敏并切 ≤2 KiB 事件。
 *     先脱敏后切分，秘密不会横跨事件边界；单 execution 原始文本预算 64 KiB，超额
 *     整轮丢弃并只发一次 `truncated` 标记。
 *   - `tool_call(_update)` 按 `toolCallId` 合并；`content` / `locations` 整体替换，
 *     `null` 视作省略；内部只留计数，不保存正文；孤立 update 标 `partial` 且不伪造
 *     start；每 turn 最多 256 个 id，溢出只记计数。
 *   - 已知坏字段只诊断，不抛错、不杀连接。
 *   - `_auth/status_update` 与所有 `_meta` 完全忽略：不投影、不记日志。
 *
 * 事件形状（runner 会补 `at/elementId/activityId`）：
 *   `{type, provider:'acp', sessionId?, invocationId?}` 为共同身份；
 *   文本 `{type:'activity/output', text, messageId?, truncated?}`；
 *   工具 `{type:'tool/start'|'tool/update'|'tool/end', toolCallId, title?, toolKind?,
 *         status?, contentCount?, locationCount?, partial?, truncated?}`；
 *   权限 `{type:'agent/permission', requestId, toolCallId?, decision, optionId?}`。
 *
 * @module @feiyueve/dsh/dsh-flow-studio/acp-events
 */

import { Buffer } from 'node:buffer'

import { redactText as sharedRedactText } from './process-output.js'

/** 文本事件单条文本上限（UTF-8 字节）。 */
export const ACP_TEXT_EVENT_MAX_BYTES = 2048

/** 单 execution 可接受的原始文本预算（UTF-8 字节）。 */
export const ACP_EXECUTION_TEXT_BUDGET_BYTES = 64 * 1024

/** 单条业务事件总量上限（含身份字段），runner 的落盘上限是 8 KiB。 */
export const ACP_EVENT_MAX_BYTES = 4096

/** 每个 turn 最多跟踪的工具调用 id 数。 */
export const ACP_MAX_TOOL_IDS_PER_TURN = 256

/** 诊断日志：每连接最多条数。 */
export const ACP_LOG_MAX_ENTRIES = 50

/** 诊断日志：每连接合计字节上限。 */
export const ACP_LOG_MAX_BYTES = 16 * 1024

/** 诊断日志：单条上限。 */
export const ACP_LOG_ENTRY_MAX_BYTES = 1024

/** commands 摘要最多保留的名称数。 */
export const ACP_COMMAND_SUMMARY_NAMES = 10

/** commands 摘要单个名称的字节上限。 */
export const ACP_COMMAND_NAME_MAX_BYTES = 64

/** 事件身份字段（sessionId / invocationId / toolCallId / messageId / optionId）字节上限。 */
export const ACP_EVENT_ID_MAX_BYTES = 128

/** 事件 title 字节上限。 */
export const ACP_EVENT_TITLE_MAX_BYTES = 256

/** 模式 / kind 等短字符串字节上限。 */
export const ACP_EVENT_SHORT_MAX_BYTES = 64

const TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed'])

const TOOL_KINDS = new Set([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
])

const TRUNCATION_MARKER = '…[truncated]'
const REDACTED = '[redacted]'

/** 判定普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** UTF-8 字节数；非字符串按空串处理。 */
function byteLength(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0
}

/**
 * 按 UTF-8 字节截断；用码点迭代，绝不留半个多字节字符。
 *
 * @param {unknown} raw
 * @param {number} limit
 * @param {{marker?: string}} [options]
 * @returns {string}
 */
export function truncateAcpUtf8(raw, limit, { marker = '' } = {}) {
  const text = typeof raw === 'string' ? raw : String(raw ?? '')
  if (limit <= 0) return ''
  if (byteLength(text) <= limit) return text
  const suffix = typeof marker === 'string' && byteLength(marker) < limit ? marker : ''
  const budget = limit - byteLength(suffix)
  let output = ''
  let used = 0
  for (const char of text) {
    const size = byteLength(char)
    if (used + size > budget) break
    output += char
    used += size
  }
  return `${output}${suffix}`
}

/** 把文本按 UTF-8 字节切成不超过 `limit` 的片段（保持码点完整）。 */
export function splitAcpUtf8(text, limit) {
  const value = typeof text === 'string' ? text : ''
  if (value === '') return []
  if (limit <= 0) return []
  const parts = []
  let current = ''
  let used = 0
  for (const char of value) {
    const size = byteLength(char)
    if (current !== '' && used + size > limit) {
      parts.push(current)
      current = ''
      used = 0
    }
    current += char
    used += size
  }
  if (current !== '') parts.push(current)
  return parts
}

/** 只保留安全整数，避免 NaN / Infinity 进事件。 */
function safeInt(value) {
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * 精确替换显式秘密。
 *
 * 完整出现一律替换；当 `tail` 为真时，还会把「文本尾部恰好是某个秘密的未完整
 * 前缀」抹掉（轮末半截）。前缀至少 4 个字符才动手，避免把普通短词当秘密。
 */
function replaceExplicitSecrets(raw, secrets, { tail = false } = {}) {
  let text = typeof raw === 'string' ? raw : String(raw ?? '')
  if (!Array.isArray(secrets) || secrets.length === 0) return text
  const list = secrets
    .filter(secret => typeof secret === 'string' && secret !== '')
    .sort((a, b) => b.length - a.length)
  for (const secret of list) text = text.split(secret).join(REDACTED)
  if (tail && list.length > 0 && text !== '') {
    let matched = ''
    for (const secret of list) {
      const max = Math.min(secret.length - 1, text.length)
      for (let length = max; length >= 4; length -= 1) {
        if (text.endsWith(secret.slice(0, length))) {
          if (length > matched.length) matched = secret.slice(0, length)
          break
        }
      }
    }
    if (matched !== '') text = `${text.slice(0, text.length - matched.length)}${REDACTED}`
  }
  return text
}

/**
 * 收集显式秘密：支持字符串、字符串数组，以及 `{token,socket,runDir,env}` 这类
 * 浅层对象（只取字符串值，不把键名当秘密）。去重后按长度降序替换，避免短秘密
 * 先替换破坏长秘密。
 */
function collectSecretStrings(value) {
  const out = []
  const walk = (item, depth) => {
    if (typeof item === 'string') {
      if (item !== '') out.push(item)
      return
    }
    if (item === null || typeof item !== 'object' || depth >= 2) return
    if (Array.isArray(item)) {
      for (const child of item) walk(child, depth + 1)
      return
    }
    for (const child of Object.values(item)) walk(child, depth + 1)
  }
  walk(value, 0)
  return [...new Set(out)].sort((a, b) => b.length - a.length)
}

/**
 * 创建一个 ACP 事件投影器。
 *
 * @param {{
 *   emit?: (event: object) => void,
 *   redact?: (text: string) => string,
 *   secrets?: string[],
 * }} [options]
 *   `emit` 是业务事件出口；`redact` 默认用共享 `redactText`；`secrets` 是本
 *   execution 的显式秘密（env 值 / finish token / socket / runDir）。
 * @returns {{
 *   bindSession: (id: string) => boolean,
 *   beginTurn: (invocationId?: string) => void,
 *   apply: (input: object) => {ok: boolean, emitted: number, ignored?: string},
 *   applyPermission: (input: object) => {ok: boolean, emitted: number},
 *   endTurn: () => {emitted: number, truncated: boolean},
 *   diagnostics: () => object,
 *   dispose: () => void,
 * }}
 */
export function createAcpEventMapper({ emit, redact: redactOption, secrets } = {}) {
  const emitEvent = typeof emit === 'function' ? emit : null
  const redact = typeof redactOption === 'function' ? redactOption : sharedRedactText
  const explicitSecrets = collectSecretStrings(secrets)

  let disposed = false
  /** 绑定后的精确 sessionId（用于比较，不先截断）。 */
  let boundSessionId = null
  let invocationId = null

  let turnActive = false
  let turnDropped = false
  let textChunks = []
  let textBytes = 0
  const textMessageIds = new Set()

  /** toolCallId → 有界摘要状态（不含 content/rawInput/rawOutput 正文）。 */
  let toolStates = new Map()
  let toolOverflow = 0

  let executionTextBytes = 0
  let receivedTextBytes = 0
  let outputTruncated = false
  let outputTruncatedEmitted = false

  let logs = []
  let logBytes = 0
  let droppedLogs = 0

  let emitErrors = 0

  const counters = {
    updates: 0,
    ignored: 0,
    malformed: 0,
    sessionMismatch: 0,
    unbound: 0,
    authStatusUpdates: 0,
    textChunks: 0,
    outputEvents: 0,
    toolStarts: 0,
    toolUpdates: 0,
    toolEnds: 0,
    partialToolUpdates: 0,
    permissionEvents: 0,
    unknownUpdates: 0,
    droppedTurns: 0,
  }

  /** 显式秘密 + 共享脱敏；不截断。 */
  function sanitizeText(raw, { tail = false } = {}) {
    const replaced = replaceExplicitSecrets(raw, explicitSecrets, { tail })
    try {
      return redact(replaced)
    } catch {
      // 脱敏函数本身异常时不能把原文透出去。
      return '[unavailable]'
    }
  }

  /** 出口字段：显式秘密 → 共享脱敏 → 字节截断。 */
  function boundText(raw, limit, { tail = false, marker = '' } = {}) {
    return truncateAcpUtf8(sanitizeText(raw, { tail }), limit, { marker })
  }

  /** 共同身份字段；sessionId / invocationId 也过脱敏与限长。 */
  function identity() {
    const event = { provider: 'acp' }
    if (boundSessionId !== null) event.sessionId = boundText(boundSessionId, ACP_EVENT_ID_MAX_BYTES)
    if (invocationId !== null) event.invocationId = boundText(invocationId, ACP_EVENT_ID_MAX_BYTES)
    return event
  }

  /**
   * 业务事件出口：补齐身份、逐字段脱敏/限长，并保证单条 ≤4 KiB。
   * 观测面抛错一律吞掉（不能让适配器因为事件订阅者异常而失败）。
   */
  function pushEvent(event) {
    if (disposed) return false
    const shaped = { ...identity(), ...event, provider: 'acp' }
    for (const key of ['sessionId', 'invocationId', 'toolCallId', 'messageId', 'optionId']) {
      if (typeof shaped[key] === 'string') shaped[key] = boundText(shaped[key], ACP_EVENT_ID_MAX_BYTES)
    }
    if (typeof shaped.title === 'string') {
      shaped.title = boundText(shaped.title, ACP_EVENT_TITLE_MAX_BYTES)
    }
    if (typeof shaped.toolKind === 'string') {
      shaped.toolKind = truncateAcpUtf8(sanitizeText(shaped.toolKind), ACP_EVENT_SHORT_MAX_BYTES)
    }
    if (typeof shaped.requestId === 'string') {
      shaped.requestId = boundText(shaped.requestId, ACP_EVENT_ID_MAX_BYTES)
    }
    if (typeof shaped.text === 'string') {
      shaped.text = truncateAcpUtf8(sanitizeText(shaped.text), ACP_TEXT_EVENT_MAX_BYTES)
    }
    // 最后一道闸：身份/字段都限长后一般远小于 4 KiB；万一仍超，逐步裁掉可选字段。
    let bytes = 0
    try {
      bytes = Buffer.byteLength(JSON.stringify(shaped), 'utf8')
    } catch {
      return false
    }
    if (bytes > ACP_EVENT_MAX_BYTES) {
      for (const key of ['title', 'messageId', 'toolKind', 'status', 'contentCount', 'locationCount', 'partial', 'truncated', 'optionId']) {
        if (bytes <= ACP_EVENT_MAX_BYTES) break
        if (key in shaped) {
          delete shaped[key]
          bytes = Buffer.byteLength(JSON.stringify(shaped), 'utf8')
        }
      }
    }
    if (bytes > ACP_EVENT_MAX_BYTES && typeof shaped.text === 'string') {
      shaped.text = truncateAcpUtf8(shaped.text, Math.max(0, shaped.text.length - (bytes - ACP_EVENT_MAX_BYTES)), {
        marker: TRUNCATION_MARKER,
      })
      shaped.truncated = true
      bytes = Buffer.byteLength(JSON.stringify(shaped), 'utf8')
    }
    if (bytes > ACP_EVENT_MAX_BYTES) {
      shaped.sessionId = boundSessionId === null ? undefined : boundText(boundSessionId, 32)
      shaped.invocationId = invocationId === null ? undefined : boundText(invocationId, 32)
      if (shaped.sessionId === undefined) delete shaped.sessionId
      if (shaped.invocationId === undefined) delete shaped.invocationId
    }
    counters.outputEvents = event.type === 'activity/output' ? counters.outputEvents + 1 : counters.outputEvents
    try {
      if (emitEvent !== null) emitEvent(shaped)
    } catch {
      emitErrors += 1
    }
    return true
  }

  /**
   * 诊断日志入队：单条 ≤1 KiB、最多 50 条 / 合计 16 KiB。满了只计数。
   * 日志只放白名单字段，不接收任意对象。
   */
  function pushLog(entry) {
    if (disposed) return false
    const shaped = { kind: boundText(entry.kind, ACP_EVENT_SHORT_MAX_BYTES) }
    if (entry.names !== undefined) {
      shaped.names = (Array.isArray(entry.names) ? entry.names : [])
        .slice(0, ACP_COMMAND_SUMMARY_NAMES)
        .map(name => boundText(name, ACP_COMMAND_NAME_MAX_BYTES))
    }
    for (const key of ['count', 'used', 'size']) {
      const value = safeInt(entry[key])
      if (value !== undefined) shaped[key] = value
    }
    if (typeof entry.mode === 'string') shaped.mode = boundText(entry.mode, ACP_EVENT_SHORT_MAX_BYTES)
    if (typeof entry.updateKind === 'string') shaped.updateKind = boundText(entry.updateKind, ACP_EVENT_SHORT_MAX_BYTES)
    if (typeof entry.count === 'number' && !Number.isSafeInteger(entry.count)) shaped.count = 0
    if (typeof entry.truncated === 'boolean') shaped.truncated = entry.truncated
    // 瘦身到单条上限：先丢 names 尾部，再降级成最小条目。
    let bytes = Buffer.byteLength(JSON.stringify(shaped), 'utf8')
    while (bytes > ACP_LOG_ENTRY_MAX_BYTES && Array.isArray(shaped.names) && shaped.names.length > 0) {
      shaped.names.pop()
      if (shaped.names.length === 0) delete shaped.names
      bytes = Buffer.byteLength(JSON.stringify(shaped), 'utf8')
    }
    if (bytes > ACP_LOG_ENTRY_MAX_BYTES) {
      const minimal = { kind: truncateAcpUtf8(shaped.kind, ACP_EVENT_SHORT_MAX_BYTES) }
      if (shaped.count !== undefined) minimal.count = shaped.count
      const minimalBytes = Buffer.byteLength(JSON.stringify(minimal), 'utf8')
      if (minimalBytes > ACP_LOG_ENTRY_MAX_BYTES) return false
      if (logs.length >= ACP_LOG_MAX_ENTRIES || logBytes + minimalBytes > ACP_LOG_MAX_BYTES) {
        droppedLogs += 1
        return false
      }
      logs.push(minimal)
      logBytes += minimalBytes
      return true
    }
    if (logs.length >= ACP_LOG_MAX_ENTRIES || logBytes + bytes > ACP_LOG_MAX_BYTES) {
      droppedLogs += 1
      return false
    }
    logs.push(shaped)
    logBytes += bytes
    return true
  }

  /** 已知坏字段 / 坏变体：只诊断，不计业务事件。 */
  function diagnose(kind, extra = {}) {
    counters.malformed += 1
    pushLog({ kind: `bad_${kind}`, ...extra })
  }

  /** 取字符串字段；空串/非字符串返回 null。 */
  function stringField(value) {
    return typeof value === 'string' && value !== '' ? value : null
  }

  // -------------------------------------------------------------------------
  // 文本
  // -------------------------------------------------------------------------

  function onAgentMessageChunk(update) {
    counters.updates += 1
    const content = update.content
    if (!isPlainObject(content) || content.type !== 'text' || typeof content.text !== 'string') {
      diagnose('agent_message_chunk')
      return 0
    }
    if (!turnActive) beginTurn(invocationId === null ? undefined : invocationId)
    const chunk = content.text
    const chunkBytes = byteLength(chunk)
    receivedTextBytes += chunkBytes
    counters.textChunks += 1
    const messageId = stringField(update.messageId)
    if (messageId !== null) textMessageIds.add(messageId)

    if (outputTruncated || turnDropped) {
      // 预算已耗尽：后续轮次同样丢弃，只保留已发过的那一次标记。
      turnDropped = true
      textChunks = []
      textBytes = 0
      return 0
    }
    if (executionTextBytes + textBytes + chunkBytes > ACP_EXECUTION_TEXT_BUDGET_BYTES) {
      // 整轮丢弃：把本轮已暂存的文本全部清掉，避免只发一半。
      outputTruncated = true
      turnDropped = true
      counters.droppedTurns += 1
      textChunks = []
      textBytes = 0
      return 0
    }
    textChunks.push(chunk)
    textBytes += chunkBytes
    executionTextBytes += chunkBytes
    return 0
  }

  // -------------------------------------------------------------------------
  // 工具调用
  // -------------------------------------------------------------------------

  function toolSummary(state) {
    const summary = {
      toolCallId: state.id,
      title: state.title,
      toolKind: state.toolKind,
      status: state.status,
      contentCount: state.contentCount,
      locationCount: state.locationCount,
    }
    for (const key of Object.keys(summary)) {
      if (summary[key] === undefined || summary[key] === null) delete summary[key]
    }
    return summary
  }

  /** 合并一个有界摘要；绝不读取/保存 content 正文、name、rawInput、rawOutput。 */
  function mergeToolFields(state, update) {
    if (typeof update.title === 'string' && update.title !== '') {
      state.title = boundText(update.title, ACP_EVENT_TITLE_MAX_BYTES)
    }
    if (typeof update.kind === 'string' && TOOL_KINDS.has(update.kind)) {
      state.toolKind = update.kind
    }
    if (typeof update.status === 'string' && TOOL_STATUSES.has(update.status)) {
      state.status = update.status
    }
    // v1：content / locations 一旦出现即整体替换；null 等同省略。
    if (update.content !== undefined && update.content !== null) {
      if (Array.isArray(update.content)) state.contentCount = update.content.length
      else diagnose('tool_content')
    }
    if (update.locations !== undefined && update.locations !== null) {
      if (Array.isArray(update.locations)) state.locationCount = update.locations.length
      else diagnose('tool_locations')
    }
  }

  function emitTool(type, state, extra = {}) {
    const event = { type, ...toolSummary(state), ...extra }
    pushEvent(event)
    if (type === 'tool/start') counters.toolStarts += 1
    else if (type === 'tool/update') counters.toolUpdates += 1
    else if (type === 'tool/end') counters.toolEnds += 1
  }

  function onToolCall(update, initial) {
    counters.updates += 1
    const id = stringField(update.toolCallId)
    if (id === null) {
      diagnose('tool_call')
      return 0
    }
    let state = toolStates.get(id)
    if (state === undefined) {
      if (toolStates.size >= ACP_MAX_TOOL_IDS_PER_TURN) {
        toolOverflow += 1
        return 0
      }
      state = {
        id: boundText(id, ACP_EVENT_ID_MAX_BYTES),
        started: false,
        ended: false,
        orphan: !initial,
        status: undefined,
        title: undefined,
        toolKind: undefined,
        contentCount: undefined,
        locationCount: undefined,
      }
      toolStates.set(id, state)
    }
    mergeToolFields(state, update)

    let emitted = 0
    if (initial && !state.started) {
      state.started = true
      state.orphan = false
      emitTool('tool/start', state)
      emitted += 1
    } else {
      if (!state.started) {
        state.orphan = true
        counters.partialToolUpdates += 1
      }
      emitTool('tool/update', state, state.started ? {} : { partial: true })
      emitted += 1
    }
    if ((state.status === 'completed' || state.status === 'failed') && !state.ended) {
      state.ended = true
      emitTool('tool/end', state, state.started ? {} : { partial: true })
      emitted += 1
    }
    return emitted
  }

  // -------------------------------------------------------------------------
  // 其它变体 → 有界摘要
  // -------------------------------------------------------------------------

  function onAvailableCommands(update) {
    const list = Array.isArray(update.availableCommands) ? update.availableCommands : []
    const names = []
    let nameTruncated = false
    for (const item of list.slice(0, ACP_COMMAND_SUMMARY_NAMES)) {
      const raw = isPlainObject(item) && typeof item.name === 'string' ? item.name : ''
      const safe = boundText(raw, ACP_COMMAND_NAME_MAX_BYTES)
      if (safe !== raw) nameTruncated = true
      names.push(safe)
    }
    pushLog({
      kind: 'available_commands_update',
      count: list.length,
      names,
      truncated: list.length > names.length || nameTruncated,
    })
  }

  function handleUpdate(update) {
    const variant = update.sessionUpdate
    switch (variant) {
      case 'agent_message_chunk':
        onAgentMessageChunk(update)
        return
      case 'tool_call':
        onToolCall(update, true)
        return
      case 'tool_call_update':
        onToolCall(update, false)
        return
      case 'agent_thought_chunk':
      case 'user_message_chunk':
        // 非文本 / 思考 / 用户消息绝不冒充 agent 文本。
        counters.updates += 1
        pushLog({ kind: variant, count: 1 })
        return
      case 'plan': {
        counters.updates += 1
        const entries = Array.isArray(update.entries) ? update.entries.length : 0
        pushLog({ kind: 'plan', count: entries })
        return
      }
      case 'available_commands_update':
        counters.updates += 1
        onAvailableCommands(update)
        return
      case 'current_mode_update': {
        counters.updates += 1
        const mode = stringField(update.currentModeId)
        pushLog({ kind: 'current_mode_update', ...(mode === null ? {} : { mode }) })
        return
      }
      case 'config_option_update': {
        counters.updates += 1
        const count = Array.isArray(update.configOptions) ? update.configOptions.length : 0
        pushLog({ kind: 'config_option_update', count })
        return
      }
      case 'usage_update': {
        counters.updates += 1
        const used = safeInt(update.used)
        const size = safeInt(update.size)
        pushLog({ kind: 'usage_update', ...(used === undefined ? {} : { used }), ...(size === undefined ? {} : { size }) })
        return
      }
      case 'session_info_update':
        // title 也不进日志；只记发生了哪类更新（_meta 完全忽略）。
        counters.updates += 1
        pushLog({ kind: 'session_info_update' })
        return
      case 'notice':
      case 'compaction_update':
        counters.updates += 1
        pushLog({ kind: variant, count: 1 })
        return
      case 'compaction_summary_chunk':
        // summary 正文不落盘：只记一条更新。
        counters.updates += 1
        pushLog({ kind: variant, count: 1 })
        return
      default:
        counters.updates += 1
        counters.unknownUpdates += 1
        pushLog({
          kind: 'unknown_update',
          updateKind: truncateAcpUtf8(sanitizeText(String(variant ?? '')), ACP_EVENT_SHORT_MAX_BYTES),
          count: 1,
        })
    }
  }

  // -------------------------------------------------------------------------
  // 权限事件
  // -------------------------------------------------------------------------

  function onPermission(input) {
    const body = isPlainObject(input.params) ? input.params : input
    if (typeof body.sessionId === 'string' && boundSessionId !== null && body.sessionId !== boundSessionId) {
      counters.sessionMismatch += 1
      counters.ignored += 1
      return { ok: true, emitted: 0, ignored: 'session_mismatch' }
    }
    if (boundSessionId === null) {
      counters.unbound += 1
      counters.ignored += 1
      return { ok: true, emitted: 0, ignored: 'session_unbound' }
    }
    // requestId 优先用显式字段；JSON-RPC 外壳直接把 id 放在顶层时也接受。
    const rawRequestId = input.requestId !== undefined ? input.requestId : input.id
    const requestId = typeof rawRequestId === 'string' || Number.isSafeInteger(rawRequestId)
      ? String(rawRequestId)
      : null
    if (requestId === null || requestId === '') {
      diagnose('permission_request')
      return { ok: true, emitted: 0, ignored: 'malformed' }
    }
    const decision = input.decision === 'allow' || input.decision === 'deny' ? input.decision : 'cancelled'
    const toolCall = isPlainObject(body.toolCall) ? body.toolCall : {}
    const toolCallId = stringField(toolCall.toolCallId)
    const event = { type: 'agent/permission', requestId, decision }
    if (toolCallId !== null) event.toolCallId = toolCallId
    if (decision !== 'cancelled' && typeof input.optionId === 'string' && input.optionId !== '') {
      event.optionId = input.optionId
    }
    pushEvent(event)
    counters.permissionEvents += 1
    return { ok: true, emitted: 1 }
  }

  // -------------------------------------------------------------------------
  // 公开方法
  // -------------------------------------------------------------------------

  function bindSession(id) {
    if (typeof id !== 'string' || id === '') return false
    boundSessionId = id
    return true
  }

  function beginTurn(nextInvocationId) {
    if (disposed) return
    // 上一轮未 flush 的文本直接丢弃：调用顺序由 P4 保证，这里只做防御。
    textChunks = []
    textBytes = 0
    textMessageIds.clear()
    turnDropped = false
    turnActive = true
    toolStates = new Map()
    toolOverflow = 0
    invocationId = typeof nextInvocationId === 'string' && nextInvocationId !== '' ? nextInvocationId : null
  }

  function apply(input) {
    if (disposed) return { ok: false, emitted: 0, ignored: 'disposed' }
    if (!isPlainObject(input)) {
      diagnose('envelope')
      return { ok: true, emitted: 0, ignored: 'malformed' }
    }
    // `_auth/status_update` 完全忽略：连摘要都不记（裸 params 形状也识别）。
    if (input.method === '_auth/status_update'
      || (input.update === undefined && input.authStatus !== undefined)) {
      counters.authStatusUpdates += 1
      counters.ignored += 1
      return { ok: true, emitted: 0, ignored: 'auth_status_update' }
    }
    // 支持三种入口：session/update 的 params、`{method, params}` 外壳、裸 update。
    let body = input
    if (isPlainObject(input.params) && typeof input.method === 'string') {
      if (input.method === 'session/request_permission') {
        return onPermission(input)
      }
      if (input.method !== 'session/update') {
        counters.ignored += 1
        return { ok: true, emitted: 0, ignored: 'not_session_update' }
      }
      body = input.params
    } else if (input.kind === 'permission') {
      return onPermission(input)
    } else if (input.update === undefined && typeof input.sessionUpdate === 'string') {
      body = { update: input }
    } else if (input.requestId !== undefined
      && (input.options !== undefined || input.toolCall !== undefined || input.decision !== undefined)) {
      return onPermission(input)
    }
    if (!isPlainObject(body.update)) {
      diagnose('session_update')
      return { ok: true, emitted: 0, ignored: 'malformed' }
    }
    const update = body.update
    if (typeof update.sessionUpdate !== 'string' || update.sessionUpdate === '') {
      diagnose('session_update')
      return { ok: true, emitted: 0, ignored: 'malformed' }
    }
    if (boundSessionId === null) {
      counters.unbound += 1
      counters.ignored += 1
      return { ok: true, emitted: 0, ignored: 'session_unbound' }
    }
    if (body.sessionId !== undefined) {
      if (typeof body.sessionId !== 'string' || body.sessionId === '') {
        diagnose('session_update')
        return { ok: true, emitted: 0, ignored: 'malformed' }
      }
      if (body.sessionId !== boundSessionId) {
        counters.sessionMismatch += 1
        counters.ignored += 1
        return { ok: true, emitted: 0, ignored: 'session_mismatch' }
      }
    }
    const before = counters.outputEvents + counters.toolStarts + counters.toolUpdates
      + counters.toolEnds + counters.permissionEvents
    try {
      handleUpdate(update)
    } catch {
      // 坏字段（包括 getter 抛错）只诊断，不杀连接。
      diagnose('session_update_throw')
    }
    const after = counters.outputEvents + counters.toolStarts + counters.toolUpdates
      + counters.toolEnds + counters.permissionEvents
    return { ok: true, emitted: after - before }
  }

  function applyPermission(input) {
    if (disposed) return { ok: false, emitted: 0 }
    if (!isPlainObject(input)) return { ok: true, emitted: 0 }
    return onPermission(input)
  }

  function endTurn() {
    if (disposed) return { emitted: 0, truncated: false }
    const wasActive = turnActive
    const wasDropped = turnDropped
    const chunks = textChunks
    const messageId = textMessageIds.size === 1 ? [...textMessageIds][0] : null
    textChunks = []
    textBytes = 0
    textMessageIds.clear()
    turnActive = false
    turnDropped = false
    if (!wasActive) return { emitted: 0, truncated: false }

    if (wasDropped || outputTruncated) {
      if (outputTruncatedEmitted) return { emitted: 0, truncated: true }
      outputTruncatedEmitted = true
      const event = { type: 'activity/output', text: TRUNCATION_MARKER, truncated: true }
      if (messageId !== null) event.messageId = messageId
      pushEvent(event)
      return { emitted: 1, truncated: true }
    }

    const raw = chunks.join('')
    if (raw === '') return { emitted: 0, truncated: false }
    const safe = sanitizeText(raw, { tail: true })
    if (safe === '') return { emitted: 0, truncated: false }
    const parts = splitAcpUtf8(safe, ACP_TEXT_EVENT_MAX_BYTES)
    let emitted = 0
    for (const part of parts) {
      const event = { type: 'activity/output', text: part }
      if (messageId !== null) event.messageId = messageId
      pushEvent(event)
      emitted += 1
    }
    return { emitted, truncated: false }
  }

  function diagnostics() {
    const payload = {
      provider: 'acp',
      sessionId: boundSessionId === null ? null : boundText(boundSessionId, ACP_EVENT_ID_MAX_BYTES),
      invocationId: invocationId === null ? null : boundText(invocationId, ACP_EVENT_ID_MAX_BYTES),
      turnActive,
      disposed,
      output: {
        budgetBytes: ACP_EXECUTION_TEXT_BUDGET_BYTES,
        acceptedBytes: executionTextBytes,
        receivedBytes: receivedTextBytes,
        events: counters.outputEvents,
        truncated: outputTruncated,
        droppedTurns: counters.droppedTurns,
      },
      tools: {
        ids: toolStates.size,
        overflow: toolOverflow,
        starts: counters.toolStarts,
        updates: counters.toolUpdates,
        ends: counters.toolEnds,
        partial: counters.partialToolUpdates,
      },
      logs: logs.map(entry => ({ ...entry, ...(entry.names === undefined ? {} : { names: [...entry.names] }) })),
      logBytes,
      droppedLogs,
      counters: { ...counters },
      emitErrors,
    }
    // 深拷贝：调用方改返回值不能影响投影器内部状态。
    return JSON.parse(JSON.stringify(payload))
  }

  function dispose() {
    if (disposed) return
    disposed = true
    textChunks = []
    textBytes = 0
    textMessageIds.clear()
    toolStates = new Map()
    turnActive = false
    turnDropped = false
    // 未提交的日志/文本/工具摘要全部丢弃，避免在取消路径上继续持有凭据。
    logs = []
    logBytes = 0
  }

  return { bindSession, beginTurn, apply, applyPermission, endTurn, diagnostics, dispose }
}
