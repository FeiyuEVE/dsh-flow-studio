/**
 * 流程目录化（flowdir）：把「一份流程 = 一份大 JSON」改成「一份流程 = 一个目录」。
 *
 * 布局（严格，除这三类之外的文件一律 unknown-file）：
 *
 *   <dir>/flow.json              manifest：schemaVersion / id / name / description /
 *                               agentPreset / createdAt / updatedAt / nodeOrder / edges
 *   <dir>/nodes/<id>.json        该节点的全部字段，**不含 task**（否则就是两个真相源）
 *   <dir>/nodes/<id>.task.md     该节点的 task 正文（Markdown，原样存取、原样读回）
 *
 * 为什么拆：一份 9 节点流程实测 44,947 B，其中 task 正文 13,633 字。
 * 单个大 JSON 不可 diff、评审对象（Markdown）与交付物（JSON）不是同一份、
 * 错误只能在导入时暴露、改一个节点要整份重来。拆成「一个小 manifest + 每节点
 * 一个 JSON + 每节点一份 Markdown」之后，改一个节点只改两行文件、diff 直读。
 *
 * 两层：
 *   - **纯函数层** `decompileFlow` / `compileFlowFiles`：无 IO，可单测；两者都不
 *     mutate 输入，输出确定（固定键序 + 固定缩进，同样的输入逐字节相同）。
 *   - **IO 层** `readFlowDir` / `writeFlowDir`：递归读、符号链接逃逸防护、单文件
 *     大小上限、临时目录 + rename 原子替换、目录 0700 / 文件 0600。
 *
 * 校验复用既有实现：组装出 flow 之后一律交给 `model.js` 的 `normalizeFlow` +
 * `validateFlow`，本模块**不另写一套结构校验**；它们的结论再映射回具体文件路径
 * （能定位到节点的指向 nodes/<id>.json，其余指向 flow.json）。
 *
 * @module @feiyueve/dsh-flow-studio/flowdir
 */

import {
  chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { LIMITS, normalizeFlow, validateFlow } from './model.js'

/** manifest 文件名（目录布局的唯一固定文件）。 */
export const FLOWDIR_MANIFEST = 'flow.json'

/** 节点文件所在的子目录名。 */
export const FLOWDIR_NODES_DIR = 'nodes'

/** 节点 task 正文文件的固定后缀；正文本身原样存取。 */
export const FLOWDIR_TASK_SUFFIX = '.task.md'

/**
 * 单文件大小上限（字节，64 KiB）。
 *
 * 目录化的意义是「每个文件都小到能 diff、能一眼评审」；一个 task.md 涨到几十 KB
 * 时应该拆成多个节点或把长资料挪到附件，而不是让它悄悄变成新的大 JSON。
 * 读侧与写侧共用这一个上限：读得回不来的东西，写的时候就不该产出来。
 */
export const FLOWDIR_FILE_MAX_BYTES = 65536

/** 目录 / 文件权限：与 src/runstore.js 的落盘风格一致。 */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** 节点文件名（id）作为单层路径段的安全长度上限。 */
const SEGMENT_MAX_CHARS = 200

/**
 * manifest 里的固定键序。
 *
 * 顺序不是随便排的：它同时决定 decompile 写出的字节与 compile 组装回来的对象
 * 形状。**只按这张表输出已知键**，表外的键按字典序追加，保证「同样的输入两次
 * 输出逐字节相同」，不依赖对象插入顺序这种偶然性。
 */
const MANIFEST_ORDER = [
  'schemaVersion', 'id', 'name', 'description', 'agentPreset', 'createdAt', 'updatedAt',
]

/** manifest 里 reserved 的键：nodes 在 nodes/ 下，nodeOrder 与 edges 在函数里单独拼。 */
const MANIFEST_RESERVED = new Set(['nodes', 'nodeOrder', 'edges'])

/** 节点 JSON 的固定键序（**不含 task**：正文只属于 .task.md）。 */
const NODE_ORDER = [
  'id', 'kind', 'title', 'x', 'y', 'mode', 'role', 'skills', 'outputs', 'maxRounds',
  'model', 'agentPreset', 'executor', 'executorCommand', 'team', 'check', 'extras',
]

/** 组装节点时的固定键序（这里 task 是合法字段：它的值来自 .task.md）。 */
const NODE_ORDER_WITH_TASK = [
  'id', 'kind', 'title', 'x', 'y', 'mode', 'role', 'task', 'skills', 'outputs', 'maxRounds',
  'model', 'agentPreset', 'executor', 'executorCommand', 'team', 'check', 'extras',
]

/** 团队成员的固定键序。 */
const MEMBER_ORDER = ['name', 'role', 'task', 'extras']

/** 连线的固定键序。 */
const EDGE_ORDER = ['id', 'from', 'to', 'kind', 'label', 'extras']

/** 节点检查命令的固定键序。 */
const CHECK_ORDER = ['command', 'expectExitCode', 'timeoutMs', 'reportPath']

/** 一个节点文件名里 `<id>` 与后缀的分界。 */
const NODE_JSON_SUFFIX = '.json'
const NODES_PREFIX = `${FLOWDIR_NODES_DIR}/`

/** 临时目录 / 备份目录的计数器（只影响临时名，不进产物内容）。 */
let dirCounter = 0

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key)
}

/** JSON.stringify 会静默丢掉的类型；显式跳过，保证输出键集合稳定。 */
function jsonUsable(value) {
  return value !== undefined && typeof value !== 'function' && typeof value !== 'symbol'
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 节点 id 能不能当单层文件名。
 * 规则与 runBlockers 的「id 会进 run 目录」同口径，但放宽到任意 Unicode
 * （中文 id 在 Linux 上是合法文件名，不该被模型层不允许的字符集误伤）。
 */
function isSafeSegment(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > SEGMENT_MAX_CHARS) return false
  if (value === '.' || value === '..') return false
  if (value.includes('/') || value.includes('\\') || value.includes('\u0000')) return false
  return true
}

/**
 * 深拷贝 + 普通对象的键按字典序重排。
 *
 * 已知结构（manifest / 节点 / 成员 / 连线 / check）用固定模板；只有这里负责
 * 兜底（extras 与未知字段），字典序让两份语义相同的输入产出相同的字节。
 */
function deepSorted(value) {
  if (Array.isArray(value)) return value.map(deepSorted)
  if (isPlainObject(value)) {
    if (typeof value.toJSON === 'function') return deepSorted(value.toJSON())
    const out = {}
    for (const key of Object.keys(value).sort()) {
      const entry = deepSorted(value[key])
      if (jsonUsable(entry)) out[key] = entry
    }
    return out
  }
  return value
}

/**
 * 按固定键序复制一层对象；表外的键按字典序追加。
 * `convert(key, value)` 负责该字段的深层规范化（成员数组、check、extras）。
 */
function orderObject(source, order, convert, skip = null) {
  const out = {}
  const taken = new Set()
  for (const key of order) {
    if (skip && skip.has(key)) continue
    if (!hasOwn(source, key)) continue
    const value = source[key]
    if (!jsonUsable(value)) continue
    out[key] = convert(key, value)
    taken.add(key)
  }
  for (const key of Object.keys(source).sort()) {
    if (taken.has(key)) continue
    if (skip && skip.has(key)) continue
    const value = source[key]
    if (!jsonUsable(value)) continue
    out[key] = convert(key, value)
  }
  return out
}

/** JSON 文本的固定写法：两空格缩进 + 末尾一个换行（POSIX 文本文件）。 */
function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** task 正文的文本化：非字符串按字面量收敛，undefined / null 当空正文。 */
function taskText(value) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

function describeFsError(error) {
  if (error && typeof error.code === 'string') {
    return `${error.code}：${error.message || ''}`.trim()
  }
  return String(error)
}

/** 抛给调用方的 IO 错误：带稳定的 `code`，消息里写清「哪里错、怎么改」。 */
function flowDirFailure(code, message) {
  const error = new Error(message)
  error.name = 'FlowDirError'
  error.code = code
  return error
}

/** 错误排序：路径优先、再 code、再 field —— 同样的坏输入每次报同样的顺序。 */
function sortErrors(errors) {
  return [...errors].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    const left = a.field || ''
    const right = b.field || ''
    if (left !== right) return left < right ? -1 : 1
    if (a.message === b.message) return 0
    return a.message < b.message ? -1 : 1
  })
}

// ---------------------------------------------------------------------------
// 反编译：flow -> 文件
// ---------------------------------------------------------------------------

/** 节点的深层规范化（team 成员 / check / extras 各走自己的模板）。 */
function canonicalNodeValue(key, value) {
  if (key === 'team' && Array.isArray(value)) {
    return value.map(member => (isPlainObject(member)
      ? orderObject(member, MEMBER_ORDER, (_, entry) => deepSorted(entry))
      : deepSorted(member)))
  }
  if (key === 'check' && isPlainObject(value)) {
    return orderObject(value, CHECK_ORDER, (_, entry) => deepSorted(entry))
  }
  return deepSorted(value)
}

/**
 * 节点对象 → 写进 nodes/<id>.json 的对象。
 *
 * `includeTask` 决定 task 是「正文文件里的合法字段」还是「必须从 JSON 里剔除的
 * 重复真相源」；反编译走后者，编译走前者。
 */
function canonicalNodeObject(source, includeTask, fallbackId) {
  const order = includeTask ? NODE_ORDER_WITH_TASK : NODE_ORDER
  const skip = includeTask ? null : new Set(['task'])
  const out = {}
  const taken = new Set()
  for (const key of order) {
    if (skip && skip.has(key)) {
      taken.add(key)
      continue
    }
    let value
    if (hasOwn(source, key)) value = source[key]
    else if (key === 'id' && fallbackId !== undefined) value = fallbackId
    else continue
    if (!jsonUsable(value)) continue
    out[key] = canonicalNodeValue(key, value)
    taken.add(key)
  }
  for (const key of Object.keys(source).sort()) {
    if (taken.has(key)) continue
    // task 永远是单独的正文文件：反编译时不复制进 JSON，编译时由 .task.md 提供。
    if (key === 'task') continue
    const value = source[key]
    if (!jsonUsable(value)) continue
    out[key] = deepSorted(value)
    taken.add(key)
  }
  return out
}

/** 一条连线 → 写进 manifest.edges 的对象。 */
function canonicalEdgeObject(edge) {
  if (!isPlainObject(edge)) return deepSorted(edge)
  return orderObject(edge, EDGE_ORDER, (_, value) => deepSorted(value))
}

/** flow 里除 nodes / nodeOrder / edges 之外的字段（固定键序 + 未知键字典序）。 */
function canonicalFlowFields(flow) {
  return orderObject(
    flow,
    MANIFEST_ORDER,
    (_, value) => deepSorted(value),
    MANIFEST_RESERVED,
  )
}

/**
 * 把一份流程反编译成「相对路径 → 文件内容」。
 *
 * 逐字节确定：同样的 flow 两次调用，每个文件的内容字符串完全相等；键序由上面的
 * 固定模板决定。不修改输入（只读 flow 的字段，全部产出新对象）。
 *
 * 目录布局无法表达的东西会被拒绝（抛错，而不是悄悄丢）：
 *   - 节点 id 不能当单层文件名（含 `/`、`\`、NUL，或是 `.` / `..`）；
 *   - 同一份流程里节点 id 重复（一个 id 只能对应一组节点文件）；
 *   - nodes / edges 不是数组（传进来的不是流程对象）。
 *
 * @param {object} flow 流程对象（通常是 normalizeFlow / defaultFlow 的产物）
 * @returns {{files: Map<string, string>}} 相对路径（`/` 分隔）→ 文件内容
 */
export function decompileFlow(flow) {
  if (!isPlainObject(flow)) {
    throw new TypeError('decompileFlow 需要一份流程对象（含 nodes / edges 数组），当前是'
      + `${flow === null ? 'null' : Array.isArray(flow) ? '数组' : typeof flow}。`)
  }
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : []
  const edges = Array.isArray(flow.edges) ? flow.edges : []

  const ids = []
  const seen = new Set()
  for (const [index, node] of nodes.entries()) {
    if (!isPlainObject(node)) {
      throw new TypeError(`nodes[${index}] 不是节点对象：反编译需要每个节点都能落成 nodes/<id>.json。`)
    }
    const id = node.id
    if (!isSafeSegment(id)) {
      throw new Error(`节点 id「${String(id)}」不能当作文件名：nodes/<id>.json 只接受单层路径段`
        + `（不能含 /、\\、NUL，不能是 . 或 ..，长度 1–${SEGMENT_MAX_CHARS}）。`
        + `改 id，或先跑一遍 normalizeFlow。`)
    }
    if (seen.has(id)) {
      throw new Error(`节点 id「${id}」重复：目录布局里一个 id 只能有一组 nodes/${id}.json + `
        + `nodes/${id}.task.md，重复会让后写的覆盖先写的。请先去掉重复节点。`)
    }
    seen.add(id)
    ids.push(id)
  }

  const manifest = canonicalFlowFields(flow)
  manifest.nodeOrder = ids
  manifest.edges = edges.map(canonicalEdgeObject)

  const files = new Map()
  files.set(FLOWDIR_MANIFEST, stringifyJson(manifest))
  for (const node of nodes) {
    const id = node.id
    files.set(`${NODES_PREFIX}${id}${NODE_JSON_SUFFIX}`, stringifyJson(canonicalNodeObject(node, false)))
    files.set(`${NODES_PREFIX}${id}${FLOWDIR_TASK_SUFFIX}`, taskText(node.task))
  }
  return { files }
}

// ---------------------------------------------------------------------------
// 编译：文件 -> flow
// ---------------------------------------------------------------------------

/** 统一成 Map；普通对象也接受（`Map<relPath, string>` 是主口径）。 */
function toFileMap(files) {
  if (files instanceof Map) {
    const out = new Map()
    for (const [key, value] of files) out.set(key, value)
    return out
  }
  if (isPlainObject(files)) {
    const out = new Map()
    for (const [key, value] of Object.entries(files)) out.set(key, value)
    return out
  }
  return null
}

/** 相对路径的安全性检查；返回 null = 合法，否则是中文原因。 */
function describeUnsafePath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return '路径必须是非空字符串'
  if (relPath.includes('\u0000')) return '路径不能包含 NUL 字符'
  if (relPath.includes('\\')) return '路径必须用 / 分隔，不能出现反斜杠'
  if (relPath.startsWith('/')) return '不能是绝对路径'
  if (/^[A-Za-z]:/.test(relPath)) return '不能是 Windows 盘符路径'
  const parts = relPath.split('/')
  for (const part of parts) {
    if (part === '') return '不能出现空路径段（不要以 / 开头或结尾，也不要用 a//b）'
    if (part === '.' || part === '..') return `不能包含「${part}」路径段`
  }
  return null
}

/**
 * 相对路径 → 布局里的角色。
 *   manifest | node(id) | task(id) | unknown
 * `nodes/` 下只要不是 `<id>.json` / `<id>.task.md` 形状的都算 unknown
 * （包括 `nodes/a.md`、`nodes/sub/x.json`、`nodes/notes.txt`）。
 */
function classifyPath(relPath) {
  if (relPath === FLOWDIR_MANIFEST) return { kind: 'manifest' }
  if (!relPath.startsWith(NODES_PREFIX)) return { kind: 'unknown' }
  const rest = relPath.slice(NODES_PREFIX.length)
  if (rest.length === 0 || rest.includes('/')) return { kind: 'unknown' }
  if (rest.endsWith(FLOWDIR_TASK_SUFFIX)) {
    const id = rest.slice(0, rest.length - FLOWDIR_TASK_SUFFIX.length)
    if (isSafeSegment(id)) return { kind: 'task', id }
    return { kind: 'unknown' }
  }
  if (rest.endsWith(NODE_JSON_SUFFIX)) {
    const id = rest.slice(0, rest.length - NODE_JSON_SUFFIX.length)
    if (isSafeSegment(id)) return { kind: 'node', id }
    return { kind: 'unknown' }
  }
  return { kind: 'unknown' }
}

/** manifest 的已知字段 + 未知字段 → 组装后的 flow（字典序兜底）。 */
function assembleFlow(manifest, nodes) {
  const out = {}
  const taken = new Set(['nodes', 'edges', 'nodeOrder'])
  for (const key of MANIFEST_ORDER) {
    if (!hasOwn(manifest, key)) continue
    const value = manifest[key]
    if (!jsonUsable(value)) continue
    out[key] = deepSorted(value)
    taken.add(key)
  }
  for (const key of Object.keys(manifest).sort()) {
    if (taken.has(key)) continue
    const value = manifest[key]
    if (!jsonUsable(value)) continue
    out[key] = deepSorted(value)
    taken.add(key)
  }
  out.nodes = nodes
  out.edges = Array.isArray(manifest.edges)
    ? manifest.edges.map(canonicalEdgeObject)
    : []
  return out
}

/**
 * `normalizeFlow` 静默丢弃了哪些内容（节点 / 连线）。
 *
 * 这不是「第二套结构校验」：判据全部来自 normalizeFlow 的产出（数量与顺序），
 * 目的只是把「导入时被悄悄丢掉」变成一条可定位的错误。字段值被 clip 这类
 * 无损收敛不在此列。
 *
 * @returns {Array<{code:string, path:string, field?:string, message:string}>}
 */
function findNormalizationLoss(assembled, normalized) {
  const issues = []

  let normalizedIndex = 0
  for (const [index, node] of assembled.nodes.entries()) {
    const id = isPlainObject(node) ? node.id : undefined
    const next = normalized.nodes[normalizedIndex]
    if (next && next.id === id) {
      normalizedIndex += 1
      continue
    }
    issues.push({
      code: 'invalid-flow',
      path: `${NODES_PREFIX}${String(id)}${NODE_JSON_SUFFIX}`,
      field: `nodes[${index}]`,
      message: `节点「${String(id)}」在归一化时被丢弃（id 与前面的节点重复，或节点数超过上限 ${LIMITS.nodes}）：`
        + `它不会进入流程，等于内容丢了。请去掉重复节点，或拆成多份流程。`,
    })
  }

  let edgeIndex = 0
  for (const [index, edge] of assembled.edges.entries()) {
    if (!isPlainObject(edge)) {
      issues.push({
        code: 'invalid-flow',
        path: FLOWDIR_MANIFEST,
        field: `edges[${index}]`,
        message: `edges[${index}] 不是对象（当前是${Array.isArray(edge) ? '数组' : typeof edge}）：`
          + '连线必须是 {"from":"节点 id","to":"节点 id","kind":"next|reject"} 形状，否则导入时会被丢弃。',
      })
      continue
    }
    const next = normalized.edges[edgeIndex]
    if (next && next.from === edge.from && next.to === edge.to) {
      edgeIndex += 1
      continue
    }
    issues.push({
      code: 'invalid-flow',
      path: FLOWDIR_MANIFEST,
      field: `edges[${index}]`,
      message: `edges[${index}]（${String(edge.from)} → ${String(edge.to)}）在归一化时被丢弃：`
        + '端点不是本流程的节点、自连（from 等于 to）、或这条连线重复。它不会进入流程，等于内容丢了。',
    })
  }

  return issues
}

/** validateFlow 的一条结论 → 目录里的一份文件。 */
function mapValidationError(item, assembled) {
  const message = `结构校验未通过：${item.message}`
  if (item.nodeId) {
    const index = assembled.nodes.findIndex(node => isPlainObject(node) && node.id === item.nodeId)
    const mapped = { code: 'invalid-flow', path: `${NODES_PREFIX}${item.nodeId}${NODE_JSON_SUFFIX}`, message }
    if (index >= 0) mapped.field = `nodes[${index}]`
    return mapped
  }
  if (item.edgeId) {
    const index = assembled.edges.findIndex(edge => isPlainObject(edge) && edge.id === item.edgeId)
    const mapped = { code: 'invalid-flow', path: FLOWDIR_MANIFEST, message }
    if (index >= 0) mapped.field = `edges[${index}]`
    return mapped
  }
  return { code: 'invalid-flow', path: FLOWDIR_MANIFEST, message }
}

/**
 * 把目录里的文件编译回一份流程。
 *
 * 返回的 `flow` 是「文件里写了什么就是什么」的组装结果：不补默认值、不改写字段，
 * 所以 `compileFlowFiles(decompileFlow(flow).files)` 能与原 flow 深等。结构校验在
 * 内部用 `normalizeFlow` + `validateFlow` 做（不另写一套），校验用的归一化产物不
 * 会替换返回的组装结果——否则「文件里没写的键」会凭空多出来，往返就不再深等。
 *
 * `errors` 里的每一项都是 `{ code, path, field?, message }`：`path` 是**文件相对
 * 路径**（没有文件可指时是 `flow.json`），`field` 精确到字段（如 `nodes[3]`、
 * `nodeOrder[1]`、`edges[2]`），`message` 说清哪里错、怎么改。
 *
 * 只要有任何一条 error，`flow` 就是 `null`（宁可让调用方停下来改文件，也不要
 * 交出一份「缺了几块但看起来能用」的流程）。
 *
 * @param {Map<string, string>|Record<string, string>} files 相对路径 → 文件内容
 * @returns {{flow: object|null, errors: Array<{code:string, path:string, field?:string, message:string}>}}
 */
export function compileFlowFiles(files) {
  const input = toFileMap(files)
  if (!input) {
    return {
      flow: null,
      errors: [{
        code: 'bad-input',
        path: '',
        message: 'compileFlowFiles 需要 Map<相对路径, 文件内容>（也接受普通对象）；'
          + `当前是${files === null ? 'null' : typeof files}。`,
      }],
    }
  }

  const errors = []
  const entries = []
  for (const [rawPath, content] of input) {
    if (typeof content !== 'string') {
      errors.push({
        code: 'bad-file-content',
        path: String(rawPath),
        message: `文件「${String(rawPath)}」的内容必须是字符串（当前是${typeof content}）：`
          + '目录化流程只收文本文件（.json / .md），读文件要用 utf8。',
      })
      continue
    }
    const problem = describeUnsafePath(rawPath)
    if (problem) {
      errors.push({
        code: 'unsafe-path',
        path: String(rawPath),
        message: `文件路径不安全（${problem}）：「${String(rawPath)}」。`
          + `流程目录只接受目录内的相对路径，如 ${FLOWDIR_MANIFEST}、`
          + `${NODES_PREFIX}<id>${NODE_JSON_SUFFIX}；不允许 ..、绝对路径、盘符或反斜杠。`,
      })
      continue
    }
    entries.push({ path: rawPath, content, ...classifyPath(rawPath) })
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const finish = (flow) => ({ flow: flow || null, errors: sortErrors(errors) })

  for (const entry of entries) {
    if (entry.kind !== 'unknown') continue
    errors.push({
      code: 'unknown-file',
      path: entry.path,
      message: `目录里出现了布局之外的文件「${entry.path}」。目录化流程只允许 ${FLOWDIR_MANIFEST}、`
        + `${NODES_PREFIX}<id>${NODE_JSON_SUFFIX}、${NODES_PREFIX}<id>${FLOWDIR_TASK_SUFFIX} 三类路径；`
        + '这里既不会读它，也不会写它，留着只会让人以为它生效（或者丢内容）。请删掉，或并入上述三种文件。',
    })
  }

  const manifestEntry = entries.find(entry => entry.kind === 'manifest')
  if (!manifestEntry) {
    errors.push({
      code: 'missing-manifest',
      path: FLOWDIR_MANIFEST,
      message: `缺少 ${FLOWDIR_MANIFEST}：流程骨架（名称、描述、nodeOrder、edges）都在它里面，`
        + `没有它就无法知道 nodes/ 下哪些文件属于这份流程。请补一个形如 `
        + '{"schemaVersion":1,"name":"…","nodeOrder":["n_start"],"edges":[]} 的 manifest。',
    })
    return finish(null)
  }

  let manifest
  try {
    manifest = JSON.parse(manifestEntry.content)
  } catch (error) {
    errors.push({
      code: 'bad-manifest-json',
      path: FLOWDIR_MANIFEST,
      message: `${FLOWDIR_MANIFEST} 不是合法 JSON（${error && error.message ? error.message : String(error)}）。`
        + '请检查括号、逗号、引号与末尾多余字符；JSON 不允许注释与尾逗号。',
    })
    return finish(null)
  }
  if (!isPlainObject(manifest)) {
    errors.push({
      code: 'bad-manifest-json',
      path: FLOWDIR_MANIFEST,
      message: `${FLOWDIR_MANIFEST} 顶层必须是 JSON 对象（当前是${Array.isArray(manifest) ? '数组' : typeof manifest}）。`
        + '形如 {"schemaVersion":1,"name":"…","nodeOrder":["n_start"],"edges":[]}。',
    })
    return finish(null)
  }

  // manifest 里写 nodes 就是第二个真相源：节点正文只属于 nodes/<id>.json。
  if (hasOwn(manifest, 'nodes')) {
    errors.push({
      code: 'invalid-flow',
      path: FLOWDIR_MANIFEST,
      field: 'nodes',
      message: `${FLOWDIR_MANIFEST} 里不要写 nodes：节点必须放在 ${NODES_PREFIX}<id>${NODE_JSON_SUFFIX}，`
        + '名字由 nodeOrder 决定。两处都写会不知道以谁为准。请从 manifest 里删掉 nodes。',
    })
    return finish(null)
  }

  if (!Array.isArray(manifest.nodeOrder)) {
    errors.push({
      code: 'invalid-flow',
      path: FLOWDIR_MANIFEST,
      field: 'nodeOrder',
      message: `${FLOWDIR_MANIFEST} 缺少 nodeOrder 数组：它决定节点的顺序与「哪些 nodes/ 文件属于这份流程」。`
        + '请写成 ["n_start","n_req",…]，顺序与画布上的节点顺序一致。',
    })
    return finish(null)
  }
  if (manifest.edges !== undefined && !Array.isArray(manifest.edges)) {
    errors.push({
      code: 'invalid-flow',
      path: FLOWDIR_MANIFEST,
      field: 'edges',
      message: `${FLOWDIR_MANIFEST} 的 edges 必须是数组（当前是${typeof manifest.edges}）：`
        + '每条写成 {"id":"e_…","from":"节点 id","to":"节点 id","kind":"next|reject","label":"…"}；没有连线就写 []。',
    })
    return finish(null)
  }

  const orderIds = []
  const listed = new Set()
  for (const [index, id] of manifest.nodeOrder.entries()) {
    if (!isSafeSegment(id)) {
      errors.push({
        code: 'invalid-flow',
        path: FLOWDIR_MANIFEST,
        field: `nodeOrder[${index}]`,
        message: `nodeOrder[${index}] 的值「${String(id)}」不能当节点 id：它要拼成 ${NODES_PREFIX}<id>${NODE_JSON_SUFFIX}，`
          + `只接受单层路径段（不能含 /、\\、NUL，不能是 . 或 ..，长度 1–${SEGMENT_MAX_CHARS}）。`,
      })
      continue
    }
    if (listed.has(id)) {
      errors.push({
        code: 'invalid-flow',
        path: FLOWDIR_MANIFEST,
        field: `nodeOrder[${index}]`,
        message: `nodeOrder[${index}] 的「${id}」重复了：一个节点只能列一次，否则节点文件会被同一份数据读两遍。`,
      })
      continue
    }
    listed.add(id)
    orderIds.push(id)
  }
  if (errors.length > 0) return finish(null)

  const nodeFiles = new Map()
  const taskFiles = new Map()
  for (const entry of entries) {
    if (entry.kind === 'node') nodeFiles.set(entry.id, entry)
    else if (entry.kind === 'task') taskFiles.set(entry.id, entry)
  }

  const nodes = []
  for (const [index, id] of orderIds.entries()) {
    const nodePath = `${NODES_PREFIX}${id}${NODE_JSON_SUFFIX}`
    const taskPath = `${NODES_PREFIX}${id}${FLOWDIR_TASK_SUFFIX}`
    const nodeEntry = nodeFiles.get(id)
    const taskEntry = taskFiles.get(id)

    if (!nodeEntry) {
      errors.push({
        code: 'missing-node',
        path: nodePath,
        field: `nodeOrder[${index}]`,
        message: `nodeOrder[${index}] 列了「${id}」，但 ${nodePath} 不存在（${taskPath} `
          + `${taskEntry ? '倒是在' : '也没有'}）。请补上节点文件，或把这个 id 从 nodeOrder 里删掉。`,
      })
      continue
    }
    if (!taskEntry) {
      errors.push({
        code: 'missing-task',
        path: taskPath,
        field: 'task',
        message: `节点「${id}」缺少 ${taskPath}：task 正文是独立 Markdown，不能空着文件、也不能塞进 `
          + `${nodePath}。没有正文就写一个 0 字节的 ${taskPath}（开始 / 结束节点常常是空的）。`,
      })
    }

    let body
    try {
      body = JSON.parse(nodeEntry.content)
    } catch (error) {
      errors.push({
        code: 'bad-node-json',
        path: nodePath,
        message: `${nodePath} 不是合法 JSON（${error && error.message ? error.message : String(error)}）。`
          + '请检查括号、逗号、引号；节点正文（task）不在这里，它在 '
          + `${taskPath}。`,
      })
      continue
    }
    if (!isPlainObject(body)) {
      errors.push({
        code: 'bad-node-json',
        path: nodePath,
        message: `${nodePath} 顶层必须是 JSON 对象（当前是${Array.isArray(body) ? '数组' : typeof body}）。`
          + '形如 {"id":"' + id + '","kind":"stage","title":"…"}。',
      })
      continue
    }
    if (hasOwn(body, 'task')) {
      errors.push({
        code: 'task-duplicated',
        path: nodePath,
        field: 'task',
        message: `${nodePath} 里出现了 task 字段：正文只能放在 ${taskPath}，两处都写就是两个真相源，`
          + '导入时不知道听谁的（而且改一处忘一处必然对不上）。请从节点 JSON 里删掉 task。',
      })
    }
    if (hasOwn(body, 'id') && body.id !== id) {
      errors.push({
        code: 'invalid-flow',
        path: nodePath,
        field: 'id',
        message: `${nodePath} 里的 id 是「${String(body.id)}」，与文件名里的「${id}」不一致：`
          + '文件名（nodeOrder）是唯一真相源，请改文件内容或改 nodeOrder，两者对齐。',
      })
      continue
    }

    const task = taskEntry ? taskEntry.content : ''
    const node = canonicalNodeObject({ ...body, task }, true, id)
    nodes.push(node)
  }

  // 目录里有、nodeOrder 没列：这些文件既不会进流程，也不会被覆盖，属于静默丢内容。
  const unlisted = new Set()
  for (const id of nodeFiles.keys()) if (!listed.has(id)) unlisted.add(id)
  for (const id of taskFiles.keys()) if (!listed.has(id)) unlisted.add(id)
  for (const id of [...unlisted].sort()) {
    const path = nodeFiles.has(id)
      ? `${NODES_PREFIX}${id}${NODE_JSON_SUFFIX}`
      : `${NODES_PREFIX}${id}${FLOWDIR_TASK_SUFFIX}`
    errors.push({
      code: 'unlisted-node',
      path,
      message: `目录里出现了节点「${id}」的文件，但 ${FLOWDIR_MANIFEST} 的 nodeOrder 没列它：`
        + '这份节点不会被导入，等于内容丢了。要么把 id 加进 nodeOrder，要么删掉这两个文件。',
    })
  }

  if (errors.length > 0) return finish(null)

  const flow = assembleFlow(manifest, nodes)
  // 结构校验复用 model.js：本模块不另写一套。
  const normalized = normalizeFlow(flow)
  const lossErrors = findNormalizationLoss(flow, normalized)
  const report = validateFlow(normalized)
  for (const item of report.errors) errors.push(mapValidationError(item, flow))

  if (lossErrors.length > 0 || errors.length > 0) {
    errors.push(...lossErrors)
    return finish(null)
  }
  return { flow, errors: [] }
}

// ---------------------------------------------------------------------------
// IO 读：目录 -> 文件（递归 + 符号链接逃逸防护 + 单文件上限）
// ---------------------------------------------------------------------------

/** target 的 realpath 是否落在 root 的 realpath 之内（含 root 自身）。 */
function isInsideRoot(rootReal, targetReal) {
  if (targetReal === rootReal) return true
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
  return targetReal.startsWith(prefix)
}

/**
 * 递归读一个流程目录。
 *
 * 只做 IO 层的事：读得到就进 `files`（键是 `/` 分隔的相对路径），读不了就进
 * `errors`。布局与结构校验不在这里做——交给 `compileFlowFiles`，两边职责不混。
 *
 * 防护：
 *   - 每个读到的路径都核对 realpath 在根目录之内（符号链接指向目录外 → unsafe-path）；
 *   - 单文件上限 `FLOWDIR_FILE_MAX_BYTES`（超过 → file-too-large，且不读内容）；
 *   - 目录环（符号链接指回已读目录）→ unsafe-path，不递归下去；
 *   - 非普通文件（管道 / 设备 / 套接字）→ unknown-file，避免 readFile 卡住。
 *
 * @param {string} dir 目录路径
 * @returns {Promise<{files: Map<string, string>, errors: Array<{code:string, path:string, message:string}>}>}
 */
export async function readFlowDir(dir) {
  const files = new Map()
  const errors = []
  if (typeof dir !== 'string' || dir.trim() === '') {
    return {
      files,
      errors: [{
        code: 'io-error',
        path: '',
        message: 'readFlowDir 需要一个目录路径（非空字符串）。',
      }],
    }
  }

  const rootAbs = resolve(dir)
  let rootReal
  try {
    rootReal = await realpath(rootAbs)
  } catch (error) {
    return {
      files,
      errors: [{
        code: 'io-error',
        path: '',
        message: `读不到目录「${dir}」（${describeFsError(error)}）：请确认路径存在、且当前用户有读权限。`,
      }],
    }
  }
  let rootInfo
  try {
    rootInfo = await stat(rootReal)
  } catch (error) {
    return {
      files,
      errors: [{
        code: 'io-error',
        path: '',
        message: `读不到目录「${dir}」（${describeFsError(error)}）。`,
      }],
    }
  }
  if (!rootInfo.isDirectory()) {
    return {
      files,
      errors: [{
        code: 'io-error',
        path: '',
        message: `「${dir}」不是目录：readFlowDir 要读的是一个流程目录（含 ${FLOWDIR_MANIFEST} 与 ${FLOWDIR_NODES_DIR}/）。`,
      }],
    }
  }

  const visitedDirs = new Set([rootReal])

  async function readOneFile(absPath, relPath) {
    let info
    try {
      info = await stat(absPath)
    } catch (error) {
      errors.push({
        code: 'io-error',
        path: relPath,
        message: `读「${relPath}」的信息失败（${describeFsError(error)}）。`,
      })
      return
    }
    if (info.size > FLOWDIR_FILE_MAX_BYTES) {
      errors.push({
        code: 'file-too-large',
        path: relPath,
        message: `「${relPath}」有 ${info.size} 字节，超过单文件上限 ${FLOWDIR_FILE_MAX_BYTES} 字节（64 KiB）：`
          + '目录化流程要求每个文件都小到能 diff / 能评审，请把长正文拆成多个节点，或把大段资料挪出流程目录。',
      })
      return
    }
    let text
    try {
      text = await readFile(absPath, 'utf8')
    } catch (error) {
      errors.push({
        code: 'io-error',
        path: relPath,
        message: `读「${relPath}」失败（${describeFsError(error)}）。`,
      })
      return
    }
    // 递归读期间文件可能被改大：按实际读到的字节再判一次。
    if (Buffer.byteLength(text, 'utf8') > FLOWDIR_FILE_MAX_BYTES) {
      errors.push({
        code: 'file-too-large',
        path: relPath,
        message: `「${relPath}」读取后超过单文件上限 ${FLOWDIR_FILE_MAX_BYTES} 字节（64 KiB）：`
          + '请把长正文拆小。',
      })
      return
    }
    files.set(relPath, text)
  }

  async function walk(currentAbs, prefix) {
    let entries
    try {
      entries = await readdir(currentAbs, { withFileTypes: true })
    } catch (error) {
      errors.push({
        code: 'io-error',
        path: prefix,
        message: `列目录「${prefix || '.'}」失败（${describeFsError(error)}）。`,
      })
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of entries) {
      const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absPath = join(currentAbs, entry.name)

      if (entry.isSymbolicLink()) {
        let targetReal
        try {
          targetReal = await realpath(absPath)
        } catch (error) {
          errors.push({
            code: 'unsafe-path',
            path: relPath,
            message: `符号链接「${relPath}」指向的目标不存在或读不到（${describeFsError(error)}）：`
              + '流程目录不允许符号链接，请换成真实文件。',
          })
          continue
        }
        if (!isInsideRoot(rootReal, targetReal)) {
          errors.push({
            code: 'unsafe-path',
            path: relPath,
            message: `符号链接「${relPath}」指向目录外（${targetReal}）：拒绝读取，否则会把流程目录之外的内容带进流程。`
              + '请删掉链接、换成目录内的真实文件。',
          })
          continue
        }
        let targetInfo
        try {
          targetInfo = await stat(targetReal)
        } catch (error) {
          errors.push({
            code: 'io-error',
            path: relPath,
            message: `读符号链接「${relPath}」的目标失败（${describeFsError(error)}）。`,
          })
          continue
        }
        if (targetInfo.isDirectory()) {
          if (visitedDirs.has(targetReal)) {
            errors.push({
              code: 'unsafe-path',
              path: relPath,
              message: `符号链接「${relPath}」指回了已经读过的目录（${targetReal}）：递归会绕圈，已跳过。`
                + '流程目录不允许符号链接。',
            })
            continue
          }
          visitedDirs.add(targetReal)
          await walk(targetReal, relPath)
          continue
        }
        if (targetInfo.isFile()) {
          await readOneFile(targetReal, relPath)
          continue
        }
        errors.push({
          code: 'unknown-file',
          path: relPath,
          message: `「${relPath}」指向的不是普通文件也不是目录：读不了，请删掉。`,
        })
        continue
      }

      if (entry.isDirectory()) {
        let childReal
        try {
          childReal = await realpath(absPath)
        } catch (error) {
          errors.push({
            code: 'io-error',
            path: relPath,
            message: `解析目录「${relPath}」失败（${describeFsError(error)}）。`,
          })
          continue
        }
        if (!isInsideRoot(rootReal, childReal)) {
          errors.push({
            code: 'unsafe-path',
            path: relPath,
            message: `目录「${relPath}」的真实路径在流程目录之外（${childReal}）：拒绝递归。`,
          })
          continue
        }
        if (visitedDirs.has(childReal)) {
          errors.push({
            code: 'unsafe-path',
            path: relPath,
            message: `目录「${relPath}」指向已经读过的目录（${childReal}）：递归会绕圈，已跳过。`,
          })
          continue
        }
        visitedDirs.add(childReal)
        await walk(absPath, relPath)
        continue
      }

      if (entry.isFile()) {
        await readOneFile(absPath, relPath)
        continue
      }

      errors.push({
        code: 'unknown-file',
        path: relPath,
        message: `「${relPath}」不是普通文件也不是目录（可能是管道 / 设备 / 套接字）：流程目录只收文本文件，请删掉。`,
      })
    }
  }

  await walk(rootReal, '')
  return { files, errors: sortErrors(errors) }
}

// ---------------------------------------------------------------------------
// IO 写：flow -> 目录（临时目录 + rename 原子替换）
// ---------------------------------------------------------------------------

/**
 * 看一眼目标路径：不存在 / 空目录 / 本模块产物 / 别的东西。
 * 只有「不存在、空目录、本模块产物」三种允许写入。
 */
async function inspectTarget(target) {
  let info
  try {
    info = await lstat(target)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'absent' }
    throw flowDirFailure('flowdir-stat-failed', `检查目标「${target}」失败（${describeFsError(error)}）。`)
  }
  if (info.isSymbolicLink()) return { kind: 'symlink' }
  if (!info.isDirectory()) return { kind: 'file' }

  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch (error) {
    throw flowDirFailure('flowdir-read-failed', `列出目标目录「${target}」失败（${describeFsError(error)}）。`)
  }
  if (entries.length === 0) return { kind: 'empty' }
  const foreignReason = await describeForeignDir(target, entries)
  if (foreignReason === null) return { kind: 'product' }
  return { kind: 'foreign', reason: foreignReason }
}

/**
 * 目标目录不是本模块产物时，返回一句可读原因；是产物（含 flow.json + nodes/ 且
 * 布局吻合）返回 null。
 *
 * 判据刻意保守：只要出现布局外的名字、符号链接、nodeOrder 没列的节点文件，
 * 就当成「别人的目录」拒写——目录化产物的价值在于它可重建，而误覆盖别人的目录不可逆。
 */
async function describeForeignDir(dir, entries) {
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      return `里面有一个符号链接「${entry.name}」，流程目录不允许符号链接`
    }
    if (entry.name === FLOWDIR_MANIFEST) {
      if (!entry.isFile()) return `${FLOWDIR_MANIFEST} 不是普通文件`
      continue
    }
    if (entry.name === FLOWDIR_NODES_DIR) {
      if (!entry.isDirectory()) return `${FLOWDIR_NODES_DIR}/ 不是目录`
      continue
    }
    return `里面还有布局之外的内容「${entry.name}」`
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(join(dir, FLOWDIR_MANIFEST), 'utf8'))
  } catch (error) {
    return `${FLOWDIR_MANIFEST} 读不出来或不是合法 JSON（${describeFsError(error)}）`
  }
  if (!isPlainObject(manifest)) return `${FLOWDIR_MANIFEST} 不是 JSON 对象`
  if (!Array.isArray(manifest.nodeOrder)) return `${FLOWDIR_MANIFEST} 没有 nodeOrder 数组`

  const listed = new Set(manifest.nodeOrder.filter(id => isSafeSegment(id)))
  let nodeEntries = []
  try {
    nodeEntries = await readdir(join(dir, FLOWDIR_NODES_DIR), { withFileTypes: true })
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) return `${FLOWDIR_NODES_DIR}/ 列不出来（${describeFsError(error)}）`
  }
  for (const entry of nodeEntries) {
    if (entry.isSymbolicLink()) return `${FLOWDIR_NODES_DIR}/ 里有符号链接「${entry.name}」`
    if (!entry.isFile()) return `${FLOWDIR_NODES_DIR}/${entry.name} 不是普通文件`
    const role = classifyPath(`${NODES_PREFIX}${entry.name}`)
    if (role.kind === 'unknown') return `${NODES_PREFIX}${entry.name} 不在布局里`
    if (!listed.has(role.id)) return `${NODES_PREFIX}${entry.name} 的「${role.id}」不在 nodeOrder 里`
  }
  return null
}

/** 写一个文件：父目录 0700，文件 0600。 */
async function writeOneFile(rootDir, relPath, content) {
  const segments = relPath.split('/')
  const absPath = join(rootDir, ...segments)
  await mkdir(dirname(absPath), { recursive: true, mode: DIR_MODE })
  await writeFile(absPath, content, { encoding: 'utf8', mode: FILE_MODE })
  await chmod(absPath, FILE_MODE).catch(() => {})
}

/** 旧目录先挪成备份、新目录再 rename 就位、最后删备份；任一步失败都尝试恢复。 */
async function swapDir(target, tmpDir, parent, base, stamp) {
  const backup = join(parent, `.${base}.old-${stamp}`)
  try {
    await rename(target, backup)
  } catch (error) {
    throw flowDirFailure('flowdir-swap-failed',
      `把旧目录「${target}」挪到一边失败（${describeFsError(error)}）：目标可能被占用或没有父目录写权限。`)
  }
  try {
    await rename(tmpDir, target)
  } catch (error) {
    await rename(backup, target).catch(() => {})
    throw flowDirFailure('flowdir-swap-failed',
      `新目录替换「${target}」失败（${describeFsError(error)}）；已尝试把旧目录恢复原位。`)
  }
  await rm(backup, { recursive: true, force: true }).catch(() => {})
}

/**
 * 把一份流程写成目录化产物。
 *
 * 写法：先在**同级**建临时目录（同一个文件系统，rename 才是原子的）→ 逐个写文件
 * → 目标已存在时「旧目录挪成备份 → 新目录 rename 就位 → 删备份」。目录 0700、
 * 文件 0600；命名与 src/runstore.js 的落盘风格一致。
 *
 * 防误覆盖：目标存在且非空、又不是本模块产物（见 describeForeignDir）时直接抛错，
 * 一个字节都不写；符号链接与普通文件同理。**允许**重写自己之前写出的目录（幂等）。
 *
 * 另有一层与读侧同口径的自检：任何文件超过 `FLOWDIR_FILE_MAX_BYTES` 就抛
 * `file-too-large`——写出去读不回来的产物没有意义。
 *
 * @param {string} dir 目标目录（不存在 = 新建；空目录 = 允许；产物目录 = 覆盖）
 * @param {object} flow 流程对象
 * @returns {Promise<{dir: string, files: string[], bytes: number}>} 绝对路径、相对路径（升序）、总字节数
 */
export async function writeFlowDir(dir, flow) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw flowDirFailure('flowdir-bad-target', 'writeFlowDir 需要一个目标目录路径（非空字符串）。')
  }
  const target = resolve(dir)
  const { files } = decompileFlow(flow)

  let totalBytes = 0
  for (const [relPath, content] of files) {
    const size = Buffer.byteLength(content, 'utf8')
    if (size > FLOWDIR_FILE_MAX_BYTES) {
      throw flowDirFailure('file-too-large',
        `「${relPath}」有 ${size} 字节，超过单文件上限 ${FLOWDIR_FILE_MAX_BYTES} 字节（64 KiB）：`
        + '写出去也读不回来。请把长正文拆成多个节点，或把大段资料挪出流程目录。')
    }
    totalBytes += size
  }

  const existing = await inspectTarget(target)
  if (existing.kind === 'symlink') {
    throw flowDirFailure('flowdir-not-a-directory',
      `目标「${target}」是一个符号链接：writeFlowDir 不跟随符号链接（可能写到目录外），请换一个真实路径。`)
  }
  if (existing.kind === 'file') {
    throw flowDirFailure('flowdir-not-a-directory',
      `目标「${target}」已存在且是普通文件：writeFlowDir 只写目录。请换一个目录名，或先删掉这个文件。`)
  }
  if (existing.kind === 'foreign') {
    throw flowDirFailure('flowdir-not-ours',
      `目标目录「${target}」不是流程目录产物：${existing.reason}。`
      + `为避免误覆盖，writeFlowDir 只写空目录或自己产出的目录（含 ${FLOWDIR_MANIFEST} 与 `
      + `${FLOWDIR_NODES_DIR}/、且布局完全吻合）。请换一个空目录，或先手工移走该目录。`)
  }

  const parent = dirname(target)
  await mkdir(parent, { recursive: true, mode: DIR_MODE })
  const base = basename(target) || 'flow'
  const stamp = `${process.pid}-${dirCounter++}`
  const tmpDir = join(parent, `.${base}.tmp-${stamp}`)

  await mkdir(tmpDir, { recursive: false, mode: DIR_MODE })
  try {
    for (const relPath of [...files.keys()].sort()) {
      await writeOneFile(tmpDir, relPath, files.get(relPath))
    }
    if (existing.kind === 'absent') {
      try {
        await rename(tmpDir, target)
      } catch (error) {
        throw flowDirFailure('flowdir-swap-failed',
          `把新目录 rename 到「${target}」失败（${describeFsError(error)}）：`
          + '如果目标在写入期间被别人创建，请确认后重试；否则检查父目录权限与磁盘空间。')
      }
    } else {
      await swapDir(target, tmpDir, parent, base, stamp)
    }
  } catch (error) {
    // 任何一步失败都把刚写的临时目录收掉，不在父目录里留半成品。
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  // umask 不保证：显式兜底一次目录权限（文件在 writeOneFile 里已 chmod）。
  await chmod(target, DIR_MODE).catch(() => {})

  return { dir: target, files: [...files.keys()].sort(), bytes: totalBytes }
}
