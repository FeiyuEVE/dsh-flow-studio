/**
 * 本地 XML 草稿（0.13.3）。
 *
 * 去抖自动保存**只落本地草稿**：每次服务端保存都会创建新版本，不能按每次输入
 * 建版本。草稿形状固定为：
 *
 * ```js
 * { definitionId, baseVersion, baseHash, xml, savedAt }
 * ```
 *
 * - `definitionId` 是定义域 id（新定义还没有服务端 id 时由页面给临时 id）；
 * - `baseVersion` / `baseHash` 记录草稿基于的服务端版本，用于提示「服务器上已有
 *   新版本」；尚未保存过的定义用 `null` / `''`；
 * - 使用**新的 storage key**（`flow-studio:bpmn-draft:`），不读取 0.12 的 JSON
 *   flow 草稿（旧记录里的 `flow` 字段直接判为无效）。
 *
 * localStorage 在 SSR / 测试环境可能不存在，也可能被隐私模式禁写：
 * 这里做能力探测，写失败退化为内存草稿，任何路径都不抛错。
 *
 * @module @feiyueve/dsh-flow-studio/client/drafts
 */

const PREFIX = 'flow-studio:bpmn-draft:'

/** 草稿记录形状版本（文档用；记录本身不写这个字段，避免多一份真相）。 */
export const XML_DRAFT_SHAPE = 2

/** localStorage 键名。 */
export function draftKey(definitionId) {
  return PREFIX + String(definitionId == null ? '' : definitionId)
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

function positiveVersion(value) {
  if (Number.isSafeInteger(value) && value >= 1) return value
  return null
}

/**
 * 校验 / 归一化一条 XML 草稿记录。
 * 旧 JSON flow 草稿（记录里有 `flow` 字段或没有 `xml`）一律返回 null。
 */
export function normalizeDraft(value, definitionId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.flow !== undefined) return null
  const id = typeof value.definitionId === 'string' ? value.definitionId.trim() : ''
  if (id === '') return null
  if (definitionId !== undefined && definitionId !== null && id !== String(definitionId)) return null
  if (typeof value.xml !== 'string' || value.xml.trim() === '') return null
  return {
    definitionId: id,
    baseVersion: positiveVersion(value.baseVersion),
    baseHash: typeof value.baseHash === 'string' ? value.baseHash : '',
    xml: value.xml,
    savedAt: typeof value.savedAt === 'string' ? value.savedAt : '',
  }
}

/**
 * 创建一个草稿仓库：storage 只负责持久化，读不到时回落到内存。
 * @param {Storage|null} storage
 */
export function createDraftStore(storage) {
  const memory = new Map()

  const persist = record => {
    memory.set(record.definitionId, record)
    if (!storage) return
    try {
      storage.setItem(draftKey(record.definitionId), JSON.stringify(record))
    } catch {
      // 配额满 / 隐私模式：内存副本已经在了，不抛错。
    }
  }

  const read = definitionId => {
    const id = String(definitionId == null ? '' : definitionId)
    if (!id) return null
    if (storage) {
      try {
        const raw = storage.getItem(draftKey(id))
        if (raw) {
          const parsed = normalizeDraft(JSON.parse(raw), id)
          if (parsed !== null) return parsed
        }
      } catch {
        // 坏 JSON / 读被禁：落到内存。
      }
    }
    const cached = memory.get(id)
    return normalizeDraft(cached, id)
  }

  const clear = definitionId => {
    const id = String(definitionId == null ? '' : definitionId)
    if (!id) return
    memory.delete(id)
    if (!storage) return
    try {
      storage.removeItem(draftKey(id))
    } catch {
      // 删不掉也不影响内存副本已清空。
    }
  }

  /**
   * 写一条草稿。返回落盘记录（含 savedAt）；非法输入返回 null。
   * `baseVersion` / `baseHash` 省略时保留为 null / ''。
   */
  const write = (draft, options = {}) => {
    if (!draft || typeof draft !== 'object') return null
    const record = normalizeDraft({
      definitionId: draft.definitionId,
      baseVersion: draft.baseVersion,
      baseHash: draft.baseHash,
      xml: draft.xml,
      savedAt: options.savedAt || draft.savedAt || new Date().toISOString(),
    }, draft.definitionId)
    if (record === null) return null
    persist(record)
    return record
  }

  return { key: draftKey, write, read, clear }
}

const defaultStore = createDraftStore(detectStorage())

/** 写入本地 XML 草稿；返回记录（含 savedAt），非法输入返回 null。 */
export function writeDraft(draft, options) {
  return defaultStore.write(draft, options)
}

/** 读某份定义的本地草稿；没有 / 已损坏 / 旧 flow 草稿返回 null。 */
export function readDraft(definitionId) {
  return defaultStore.read(definitionId)
}

/** 丢掉某份定义的本地草稿（保存成功 / 用户选择丢弃时）。 */
export function clearDraft(definitionId) {
  defaultStore.clear(definitionId)
}

/** 草稿落盘的默认去抖窗：连续输入时每个字符不各写一次。 */
export const DRAFT_DEBOUNCE_MS = 600
/** 连续输入的上限等待：一直不停手也必须在这个时间内落一次盘。 */
export const DRAFT_MAX_WAIT_MS = 2000

/**
 * 草稿写盘调度器：去抖 + maxWait，外加可显式 flush（切页 / 页面隐藏 / 卸载）。
 *
 * 设计约束：
 *  - 去抖窗（默认 600ms）内连续变更只写最后一次；
 *  - 从本轮第一次变更起最多等 maxWait（默认 2s），避免用户一直编辑永不落盘；
 *  - `flush()` 立即写掉待写内容并清定时器，重复调用不会重复写；
 *  - 写盘抛错时**保留待写内容**（不丢用户输入），下次 schedule / flush 会重试；
 *    但不在失败后自动重排，避免配额满时无限重试。
 *
 * 定时器与写盘函数都可注入，测试用假 timer + 假 storage 断言写入次数，
 * 不依赖真实 setTimeout / localStorage。
 *
 * @param {object} [options]
 * @param {(draft: object) => any} [options.write] 实际写盘函数（接收草稿快照）
 * @param {number} [options.debounceMs] 去抖窗，默认 {@link DRAFT_DEBOUNCE_MS}
 * @param {number} [options.maxWaitMs] 上限等待，默认 {@link DRAFT_MAX_WAIT_MS}
 * @param {(fn: Function, ms: number) => any} [options.setTimeout]
 * @param {(id: any) => void} [options.clearTimeout]
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

  let pendingDraft = null
  let debounceTimer = null
  let maxWaitTimer = null
  let lastError = null

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
    if (!pendingDraft) return null
    const draft = pendingDraft
    try {
      const result = write(draft)
      pendingDraft = null
      lastError = null
      return result
    } catch (error) {
      // 写盘失败不能反向打断输入；保留待写内容，等下一次 flush / schedule 重试。
      lastError = error
      return null
    }
  }

  /**
   * 记一次待写变更。同一轮里的重复调用只更新快照，不增加写盘次数。
   * 切到另一份定义时先把上一份立即写掉，避免跨定义串稿。
   */
  const schedule = draft => {
    if (!draft || typeof draft.definitionId !== 'string' || draft.definitionId === '') return false
    if (pendingDraft && pendingDraft.definitionId !== draft.definitionId) run()
    if (!pendingDraft) {
      pendingDraft = draft
      maxWaitTimer = setTimer(run, maxWaitMs)
    } else {
      pendingDraft = draft
    }
    if (debounceTimer !== null) clearTimer(debounceTimer)
    debounceTimer = setTimer(run, debounceMs)
    return true
  }

  /** 立即写掉待写内容；没有待写内容时返回 null。 */
  const flush = () => run()

  /** 丢弃待写内容（保存成功 / 删除定义时）。传 definitionId 时只取消同一份定义。 */
  const cancel = definitionId => {
    if (definitionId != null && pendingDraft && pendingDraft.definitionId !== definitionId) return false
    clearTimers()
    pendingDraft = null
    return true
  }

  return {
    schedule,
    flush,
    cancel,
    pending: () => pendingDraft,
    get lastError() {
      return lastError
    },
    debounceMs,
    maxWaitMs,
  }
}

/** XML 比较前的归一化：BOM / 换行 / 首尾空白不制造「有未保存草稿」。 */
export function normalizeXml(xml) {
  if (typeof xml !== 'string') return ''
  return xml.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
}

/**
 * 草稿是否值得打扰用户。
 *
 * @param {object|null} record 草稿记录
 * @param {string|{xml?: string, hash?: string}|null} current
 *        当前服务器内容：可传 XML 字符串，或 `{xml, hash}`。
 *        - 有 xml 时按归一化 XML 比较（内容相同就是相同，与时间戳无关）；
 *        - 只有 hash 时，草稿的 `baseHash` 相同即视为同一内容。
 */
export function draftDiffers(record, current) {
  const draft = normalizeDraft(record)
  if (draft === null) return false
  if (typeof current === 'string') {
    return normalizeXml(draft.xml) !== normalizeXml(current)
  }
  if (!current || typeof current !== 'object') return false
  if (typeof current.xml === 'string') {
    return normalizeXml(draft.xml) !== normalizeXml(current.xml)
  }
  if (typeof current.hash === 'string' && current.hash !== '') {
    return draft.baseHash !== current.hash
  }
  return false
}
