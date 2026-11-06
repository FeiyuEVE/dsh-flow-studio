/**
 * 本地草稿：保存失败或切页时，把整份流程落到 `flow-studio:draft:<flowId>`。
 *
 * 承诺的文案必须与实现一致：只有服务器确认保存成功才叫「已保存」；
 * 失败时写本地副本，界面显示「保存失败 · 本地副本」，下次打开该流程可恢复。
 *
 * localStorage 在 SSR / 测试环境可能不存在，也可能被隐私模式禁写：
 * 这里做能力探测，写失败退化为内存草稿，任何路径都不抛错。
 *
 * @module @feiyueve/dsh-flow-studio/client/drafts
 */

const PREFIX = 'flow-studio:draft:'

/** localStorage 键名。 */
export function draftKey(flowId) {
  return PREFIX + String(flowId == null ? '' : flowId)
}

/**
 * 探测可用的 localStorage。不可用（不存在 / 抛 SecurityError / 配额已满）返回 null。
 * @returns {Storage|null}
 */
export function detectStorage() {
  try {
    const candidate = typeof globalThis === 'undefined' ? undefined : globalThis.localStorage
    if (!candidate || typeof candidate.setItem !== 'function' || typeof candidate.getItem !== 'function') return null
    const probe = PREFIX + '__probe__'
    candidate.setItem(probe, '1')
    candidate.removeItem(probe)
    return candidate
  } catch {
    return null
  }
}

function isDraftRecord(value, flowId) {
  return Boolean(value
    && typeof value === 'object'
    && value.flow
    && typeof value.flow === 'object'
    && typeof value.flow.id === 'string'
    && value.flow.id === flowId)
}

/**
 * 创建一个草稿仓库：storage 只负责持久化，读不到时回落到内存。
 * @param {Storage|null} storage
 */
export function createDraftStore(storage) {
  const memory = new Map()

  const persist = record => {
    memory.set(record.flow.id, record)
    if (!storage) return
    try {
      storage.setItem(draftKey(record.flow.id), JSON.stringify(record))
    } catch {
      // 配额满 / 隐私模式：内存副本已经在了，不抛错。
    }
  }

  const read = flowId => {
    const id = String(flowId == null ? '' : flowId)
    if (!id) return null
    if (storage) {
      try {
        const raw = storage.getItem(draftKey(id))
        if (raw) {
          const parsed = JSON.parse(raw)
          if (isDraftRecord(parsed, id)) return parsed
        }
      } catch {
        // 坏 JSON / 读被禁：落到内存。
      }
    }
    const cached = memory.get(id)
    return isDraftRecord(cached, id) ? cached : null
  }

  const clear = flowId => {
    const id = String(flowId == null ? '' : flowId)
    if (!id) return
    memory.delete(id)
    if (!storage) return
    try {
      storage.removeItem(draftKey(id))
    } catch {
      // 删不掉也不影响内存副本已清空。
    }
  }

  const write = (flow, options = {}) => {
    if (!flow || typeof flow.id !== 'string' || flow.id === '') return null
    const record = {
      flow,
      savedAt: options.savedAt || new Date().toISOString(),
      baseSavedAt: options.baseSavedAt || flow.updatedAt || '',
    }
    persist(record)
    return record
  }

  return { key: draftKey, write, read, clear }
}

const defaultStore = createDraftStore(detectStorage())

/** 写入本地草稿；返回记录（含 savedAt / baseSavedAt），无 id 的流程返回 null。 */
export function writeDraft(flow, options) {
  return defaultStore.write(flow, options)
}

/** 读某份流程的本地草稿；没有或已损坏返回 null。 */
export function readDraft(flowId) {
  return defaultStore.read(flowId)
}

/** 丢掉某份流程的本地草稿（保存成功 / 用户选择丢弃时）。 */
export function clearDraft(flowId) {
  defaultStore.clear(flowId)
}

/** 草稿落盘的默认去抖窗：连续输入时每个字符不各写一次。 */
export const DRAFT_DEBOUNCE_MS = 600
/** 连续输入的上限等待：一直不停手也必须在这个时间内落一次盘。 */
export const DRAFT_MAX_WAIT_MS = 2000

/**
 * 草稿写盘调度器：去抖 + maxWait，外加可显式 flush（切页 / 页面隐藏 / 卸载）。
 *
 * 设计约束（缺陷 8）：
 *  - 去抖窗（默认 600ms）内连续变更只写最后一次；
 *  - 从本轮第一次变更起最多等 maxWait（默认 2s），避免用户一直打字永不落盘；
 *  - `flush()` 立即写掉待写内容并清定时器，重复调用不会重复写。
 *
 * 定时器与写盘函数都可注入，测试用假 timer + 假 storage 断言写入次数，
 * 不依赖真实 setTimeout / localStorage。
 *
 * @param {object} [options]
 * @param {(flow: object) => any} [options.write] 实际写盘函数（接收整份流程快照）
 * @param {number} [options.debounceMs] 去抖窗，默认 {@link DRAFT_DEBOUNCE_MS}
 * @param {number} [options.maxWaitMs] 上限等待，默认 {@link DRAFT_MAX_WAIT_MS}
 * @param {(fn: Function, ms: number) => any} [options.setTimeout]
 * @param {(id: any) => void} [options.clearTimeout]
 * @returns {{ schedule: Function, flush: Function, cancel: Function, pending: Function }}
 */
export function createDraftScheduler(options = {}) {
  const write = typeof options.write === 'function' ? options.write : () => null
  const debounceMs = Number.isFinite(options.debounceMs)
    ? Math.max(0, options.debounceMs)
    : DRAFT_DEBOUNCE_MS
  const maxWaitMs = Number.isFinite(options.maxWaitMs)
    ? Math.max(debounceMs, options.maxWaitMs)
    : DRAFT_MAX_WAIT_MS
  const setTimer = typeof options.setTimeout === 'function'
    ? options.setTimeout
    : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof options.clearTimeout === 'function'
    ? options.clearTimeout
    : id => clearTimeout(id)

  let pendingFlow = null
  let debounceTimer = null
  let maxWaitTimer = null

  const clearTimers = () => {
    if (debounceTimer !== null) {
      clearTimer(debounceTimer)
      debounceTimer = null
    }
    if (maxWaitTimer !== null) {
      clearTimer(maxWaitTimer)
      maxWaitTimer = null
    }
  }

  const run = () => {
    clearTimers()
    if (!pendingFlow) return null
    const flow = pendingFlow
    pendingFlow = null
    try {
      return write(flow)
    } catch {
      // 写盘失败不能反向打断输入；内存副本由 createDraftStore 负责。
      return null
    }
  }

  /**
   * 记一次待写变更。同一轮里的重复调用只更新快照，不增加写盘次数。
   * 切到另一份流程时先把上一份立即写掉，避免跨流程串稿。
   */
  const schedule = flow => {
    if (!flow || typeof flow.id !== 'string' || flow.id === '') return false
    if (pendingFlow && pendingFlow.id !== flow.id) run()
    if (!pendingFlow) {
      pendingFlow = flow
      maxWaitTimer = setTimer(run, maxWaitMs)
    } else {
      pendingFlow = flow
    }
    if (debounceTimer !== null) clearTimer(debounceTimer)
    debounceTimer = setTimer(run, debounceMs)
    return true
  }

  /** 立即写掉待写内容；没有待写内容时返回 null。 */
  const flush = () => run()

  /** 丢弃待写内容（保存成功 / 删除流程时）。传 flowId 时只取消同一份流程。 */
  const cancel = flowId => {
    if (flowId != null && pendingFlow && pendingFlow.id !== flowId) return false
    clearTimers()
    pendingFlow = null
    return true
  }

  return {
    schedule,
    flush,
    cancel,
    pending: () => pendingFlow,
    debounceMs,
    maxWaitMs,
  }
}

/** 稳定序列化：键排序，忽略 null/undefined 差异，用于「内容是否相同」判定。 */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

/**
 * 内容指纹：只比流程内容，不比 createdAt / updatedAt。
 * 服务器版本与草稿内容相同就不必打扰用户。
 */
export function contentSignature(flow) {
  if (!flow || typeof flow !== 'object') return ''
  return canonical({
    id: flow.id || '',
    name: flow.name || '',
    description: flow.description || '',
    nodes: Array.isArray(flow.nodes) ? flow.nodes : [],
    edges: Array.isArray(flow.edges) ? flow.edges : [],
  })
}

/**
 * 草稿是否值得打扰用户：内容与服务器版本不同才提示「发现未保存的本地副本」。
 * 只有时间戳不同（例如同一份内容被重新保存）不算。
 */
export function draftDiffers(flow, record) {
  if (!record || !record.flow || !flow) return false
  return contentSignature(record.flow) !== contentSignature(flow)
}
