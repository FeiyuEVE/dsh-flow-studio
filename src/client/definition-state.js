/**
 * 定义 / 版本选择状态（0.13.3，纯逻辑，可在裸 Node import）。
 *
 * 页面规则（docs/design/10-bpmn-instance-api.md §3.1–3.3、计划书步骤 5）：
 * - 编辑区永远对应一个明确的 `definitionId`；
 * - 保存成功后**钉住**服务端返回的 `version + hash`，下一次保存/运行都以它为准；
 * - 「运行」必须显式带 `definitionVersion`，不能省略让 Host 猜最新版
 *   （否则用户在 v1 画布上点运行，实际可能启动 v2）；
 * - 有未保存修改时不允许直接运行——先保存版本，避免运行旧内容；
 * - 另一份定义的保存响应晚到，不能改写当前定义的钉住版本。
 *
 * @module @feiyueve/dsh-flow-studio/client/definition-state
 */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInt(value) {
  if (Number.isSafeInteger(value) && value >= 1) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed
  }
  return null
}

function versionRow(entry) {
  if (!isObject(entry)) return null
  const version = positiveInt(entry.version)
  if (version === null) return null
  return {
    version,
    hash: typeof entry.hash === 'string' ? entry.hash : '',
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
    bytes: Number.isSafeInteger(entry.bytes) ? entry.bytes : null,
  }
}

function normalizeVersions(list) {
  if (!Array.isArray(list)) return []
  const byVersion = new Map()
  for (const entry of list) {
    const row = versionRow(entry)
    if (row === null) continue
    byVersion.set(row.version, row)
  }
  return [...byVersion.values()].sort((a, b) => a.version - b.version)
}

/**
 * @param {object} [initial] 可选初始值（与 `select()` 同形）
 */
export function createDefinitionState(initial = {}) {
  let state = {
    definitionId: '',
    name: '',
    description: '',
    tags: [],
    /** 当前钉住的版本（可运行 / 可再次保存的依据）。 */
    version: null,
    hash: '',
    /** 定义域里的最新版本（只用于提示「有新版本」，不参与运行）。 */
    latestVersion: null,
    latestHash: '',
    versions: [],
    /** 编辑区是否有未保存修改；运行前必须为 false。 */
    dirty: false,
  }

  const snapshot = () => ({
    ...state,
    tags: state.tags.slice(),
    versions: state.versions.map(row => ({ ...row })),
  })

  const adopt = payload => {
    if (!isObject(payload)) return null
    const id = typeof payload.id === 'string' ? payload.id.trim() : ''
    if (id === '') return null
    const version = positiveInt(payload.version) ?? positiveInt(payload.latestVersion)
    const latestVersion = positiveInt(payload.latestVersion) ?? version
    state = {
      definitionId: id,
      name: typeof payload.name === 'string' ? payload.name : '',
      description: typeof payload.description === 'string' ? payload.description : '',
      tags: Array.isArray(payload.tags) ? payload.tags.filter(tag => typeof tag === 'string') : [],
      version,
      hash: typeof payload.hash === 'string' && payload.hash !== ''
        ? payload.hash
        : (typeof payload.latestHash === 'string' ? payload.latestHash : ''),
      latestVersion,
      latestHash: typeof payload.latestHash === 'string' && payload.latestHash !== ''
        ? payload.latestHash
        : (typeof payload.hash === 'string' ? payload.hash : ''),
      versions: normalizeVersions(payload.versions),
      dirty: false,
    }
    return snapshot()
  }

  if (isObject(initial) && typeof initial.id === 'string') adopt(initial)

  return {
    /** 打开一份定义（GET /definitions/<id> 信封）：钉住返回的 version + hash。 */
    select(payload) {
      return adopt(payload)
    },

    /**
     * 用 `GET /definitions` 列表更新元数据 / 最新版本提示，但**不改当前钉住版本**。
     * 返回是否找到当前定义。
     */
    applyList(payload) {
      const definitions = Array.isArray(payload)
        ? payload
        : (isObject(payload) && Array.isArray(payload.definitions) ? payload.definitions : [])
      let found = null
      for (const entry of definitions) {
        if (isObject(entry) && entry.id === state.definitionId) {
          found = entry
          break
        }
      }
      if (found === null) return false
      const latestVersion = positiveInt(found.latestVersion)
      if (latestVersion !== null && (state.latestVersion === null || latestVersion > state.latestVersion)) {
        state.latestVersion = latestVersion
      }
      if (typeof found.latestHash === 'string' && found.latestHash !== '') state.latestHash = found.latestHash
      if (typeof found.name === 'string' && found.name !== '') state.name = found.name
      const versions = normalizeVersions(found.versions)
      if (versions.length > 0) state.versions = versions
      return true
    },

    /** 编辑区发生一次真实修改。 */
    markDirty() {
      state.dirty = true
      return snapshot()
    },

    /**
     * 保存成功（POST /definitions 返回值）后钉住版本。
     *
     * @param {{id?: string, version?: number, hash?: string}} result
     * @param {{revision?: number, savedRevision?: number}} [options]
     *        `revision` 是当前编辑修订号，`savedRevision` 是提交时的修订号：
     *        只有两者相等才清 dirty；提交后继续改的仍算未保存。
     * @returns {{pinned: boolean, reason: string, state: object}}
     */
    pinSaved(result, options = {}) {
      if (!isObject(result)) {
        return { pinned: false, reason: '保存结果不是对象', state: snapshot() }
      }
      const id = typeof result.id === 'string' ? result.id.trim() : ''
      const version = positiveInt(result.version)
      if (id === '' || version === null) {
        return { pinned: false, reason: '保存结果缺少 id / version', state: snapshot() }
      }
      if (state.definitionId !== '' && state.definitionId !== id) {
        return { pinned: false, reason: '保存结果属于另一份定义，未钉住版本', state: snapshot() }
      }
      // 新建定义：第一次保存后把结果 id 作为当前定义。
      state.definitionId = id
      state.version = version
      state.hash = typeof result.hash === 'string' ? result.hash : ''
      if (state.latestVersion === null || version > state.latestVersion) state.latestVersion = version
      if (state.latestVersion === version) state.latestHash = state.hash
      if (!state.versions.some(row => row.version === version)) {
        state.versions = [...state.versions, {
          version,
          hash: state.hash,
          createdAt: '',
          bytes: null,
        }].sort((a, b) => a.version - b.version)
      }
      // 只清「提交时那一版」的 dirty。
      if (Number.isSafeInteger(options.revision)) {
        const savedRevision = Number.isSafeInteger(options.savedRevision)
          ? options.savedRevision
          : options.revision
        state.dirty = options.revision > savedRevision
      } else {
        state.dirty = false
      }
      return { pinned: true, reason: '', state: snapshot() }
    },

    /**
     * 运行参数：必须带明确 `definitionVersion`，且不能有未保存修改。
     * @param {object} [variables]
     * @returns {{ok: true, body: object} | {ok: false, reason: string}}
     */
    runPayload(variables) {
      if (state.definitionId === '') {
        return { ok: false, reason: '还没有保存过定义，先保存一个版本再运行。' }
      }
      if (state.version === null) {
        return { ok: false, reason: '没有已保存的版本，先保存版本再运行。' }
      }
      if (state.dirty) {
        return { ok: false, reason: '有未保存的修改：先保存版本，再运行。' }
      }
      return {
        ok: true,
        body: {
          definitionId: state.definitionId,
          definitionVersion: state.version,
          variables: isObject(variables) ? variables : {},
        },
      }
    },

    /** 关闭 / 切换前清空。 */
    reset() {
      state = {
        definitionId: '',
        name: '',
        description: '',
        tags: [],
        version: null,
        hash: '',
        latestVersion: null,
        latestHash: '',
        versions: [],
        dirty: false,
      }
      return snapshot()
    },

    get definitionId() {
      return state.definitionId
    },
    get version() {
      return state.version
    },
    get hash() {
      return state.hash
    },
    get dirty() {
      return state.dirty
    },
    get state() {
      return snapshot()
    },
  }
}
