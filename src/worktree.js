/**
 * 工作区解析与 worktree 生命周期（07 §4 / §8）：worktree 该不该建、建在哪、
 * 建完怎么查、删之前怎么校验，全部收在这一个模块里，由「发起 run 的一侧」
 * 在 `start()` 之前当场决策，而不是让第一个节点自己判断。
 *
 * 纯逻辑 + 注入 runner：不 import 任何 dsh 包，只用 node:child_process /
 * node:fs / node:path / node:crypto；默认 runner 用 execFile 包一层 Promise
 * （等价 promisify），捕获 stderr，超时用 SIGKILL 杀子进程。
 *
 * runner 契约（测试注入假 runner 时照此实现）：
 *   run(argv, { cwd, timeoutMs }) → Promise<{ stdout, stderr, code }>
 *   - 正常退出 resolve，`code` 为 0；
 *   - git 非 0 退出 reject，error 带 `status`（数字退出码）与 `stdout` / `stderr`；
 *   - 连 git 都起不来（ENOENT、超时被杀）时 `status` 为 null，调用方据此区分
 *     「这不是 git 仓库」与「git 不可用」，绝不把后者静默当成前者。
 *
 * 错误一律抛 Error 并带 `code`（WORKSPACE_INVALID / WORKSPACE_NOT_FOUND /
 * GIT_UNAVAILABLE / WORKTREE_POLICY_INVALID / WORKTREE_UNAVAILABLE /
 * WORKTREE_INVALID / RUN_ID_INVALID / WORKTREE_CREATE_FAILED /
 * WORKTREE_PATH_UNSAFE / WORKTREE_REMOVE_FAILED），消息是给人看的中文。
 *
 * 布局（07 §4.2）：`<root>/<workspaceId>/<runId>`；分支 `<branchPrefix><runId>`
 * （冲突时 `-2`、`-3`…）；base 取 workspace 的 HEAD 并记进 baseCommit。
 * 收尾不自动删 worktree；删除只走 {@link removeWorktree}，且先过路径校验。
 *
 * @module @feiyueve/dsh-flow-studio/worktree
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** worktree 策略全集；`auto` 是默认（07 §4.1）。 */
const WORKTREE_POLICIES = new Set(['auto', 'on', 'off'])
/** 分支前缀默认值；最终分支是 `<branchPrefix><runId>`。 */
const DEFAULT_BRANCH_PREFIX = 'flow/'
/** 分支重名时最多向后试到 `-N`；超过视为异常（不无限试）。 */
const MAX_BRANCH_ATTEMPTS = 50
/** 错误里携带的 stderr 摘要上限（07 §8）。 */
const STDERR_LIMIT = 300
/** 单次 git 调用超时；超时按 SIGKILL 杀掉，不挂死整条流水线。 */
const DEFAULT_GIT_TIMEOUT_MS = 30_000
/** git 输出上限：worktree 相关命令输出都很小，8 MiB 足够且不会撑爆内存。 */
const MAX_GIT_BUFFER = 8 * 1024 * 1024
/** workspaceId 固定 12 位小写 hex。 */
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{12}$/
/** runId 与 runlog.checkRunId 同口径：字母/数字/点/下划线/连字符，1–64 位。 */
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
/** 分支名允许的字符集（更细的 ref 规则在 isValidRefName 里查）。 */
const REF_PATTERN = /^[A-Za-z0-9._/-]+$/

/** 构造带 code 的错误；extra 上的字段（如 stderr）原样挂上去。 */
function fail(code, message, extra) {
  const error = new Error(message)
  error.name = 'WorktreeError'
  error.code = code
  if (extra && typeof extra === 'object') Object.assign(error, extra)
  return error
}

/** 非空普通对象校验；数组与 null 都不算。 */
function requireObject(value, label, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(code, `${label} 必须是非空对象`)
  }
  return value
}

/** 字符串归一（Buffer / undefined 都落成 ''）。 */
function textOf(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

/** 从 runner 抛出的错误里取退出码；null 表示「git 根本没跑起来」。 */
function exitCodeOf(error) {
  if (!error || typeof error !== 'object') return null
  if (Number.isInteger(error.status)) return error.status
  if (Number.isInteger(error.exitCode)) return error.exitCode
  if (Number.isInteger(error.code)) return error.code
  return null
}

/** 默认 runner：execFile('git', argv) 的 Promise 包装（不额外依赖 node:util）。 */
function defaultRun(argv, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== 'string')) {
      rejectRun(fail('WORKTREE_INVALID', 'run(argv) 需要一个非空字符串数组'))
      return
    }
    const cwd = options && typeof options.cwd === 'string' ? options.cwd : undefined
    const timeoutMs = options && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_GIT_TIMEOUT_MS
    execFile('git', argv, {
      cwd,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_GIT_BUFFER,
      encoding: 'utf8',
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const out = textOf(stdout)
      const err = textOf(stderr)
      if (!error) {
        resolveRun({ stdout: out, stderr: err, code: 0 })
        return
      }
      const wrapped = new Error(`git ${argv.join(' ')} 执行失败`)
      wrapped.name = 'GitRunError'
      wrapped.code = typeof error.code === 'string' ? error.code : 'GIT_EXIT'
      wrapped.status = typeof error.code === 'number' ? error.code : null
      wrapped.exitCode = wrapped.status
      wrapped.stdout = out
      wrapped.stderr = err
      wrapped.signal = error.signal ?? null
      wrapped.killed = error.killed === true
      wrapped.cause = error
      rejectRun(wrapped)
    })
  })
}

/** run 必须是函数；不传就用默认 execFile 包装。 */
function resolveRunner(run) {
  if (run === undefined || run === null) return defaultRun
  if (typeof run !== 'function') throw fail('WORKTREE_INVALID', 'run 必须是函数')
  return run
}

/**
 * 调一次 git，把成功/失败统一成可读结构，不往外抛（由调用方决定怎么翻译）。
 * @returns {Promise<{ ok:boolean, argv:string[], cwd?:string, error:Error|null,
 *   exitCode:number|null, stdout:string, stderr:string }>}
 */
async function callGit(run, argv, cwd) {
  let result
  try {
    result = await run(argv, { cwd, timeoutMs: DEFAULT_GIT_TIMEOUT_MS })
  } catch (error) {
    return {
      ok: false,
      argv,
      cwd,
      error: error instanceof Error ? error : new Error(String(error)),
      exitCode: exitCodeOf(error),
      stdout: textOf(error && error.stdout),
      stderr: textOf(error && error.stderr),
    }
  }
  const stdout = typeof result === 'string' ? result : textOf(result && result.stdout)
  const stderr = typeof result === 'string' ? '' : textOf(result && result.stderr)
  const code = result !== null && typeof result === 'object' && Number.isInteger(result.code)
    ? result.code
    : 0
  return { ok: code === 0, argv, cwd, error: null, exitCode: code, stdout, stderr }
}

/** 失败信息优先用 stderr，其次 stdout，再次 error.message。 */
function collectText(probe) {
  if (!probe) return ''
  if (typeof probe.stderr === 'string' && probe.stderr.trim() !== '') return probe.stderr
  if (typeof probe.stdout === 'string' && probe.stdout.trim() !== '') return probe.stdout
  if (probe.error && typeof probe.error.message === 'string') return probe.error.message
  return ''
}

/** stderr 摘要：去首尾空白，硬截到 300 字符（07 §8）。 */
function summarize(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  return raw.length <= STDERR_LIMIT ? raw : raw.slice(0, STDERR_LIMIT)
}

/**
 * workspaceId：`sha256(realpath)` 前 12 位 hex，纯函数、稳定、不碰 fs。
 * @param {string} realpath 工作区真实路径
 * @returns {string} 12 位小写 hex
 */
export function workspaceIdFor(realpath) {
  if (typeof realpath !== 'string' || realpath === '') {
    throw fail('WORKSPACE_INVALID', 'workspaceIdFor 需要非空字符串 realpath')
  }
  return createHash('sha256').update(realpath, 'utf8').digest('hex').slice(0, 12)
}

/** 取 workspace 的绝对路径 / 真实路径 / id；坏输入抛 WORKSPACE_INVALID。 */
function workspaceInfoOf(workspace) {
  requireObject(workspace, 'workspace', 'WORKSPACE_INVALID')
  const raw = typeof workspace.realpath === 'string' && workspace.realpath !== ''
    ? workspace.realpath
    : workspace.path
  if (typeof raw !== 'string' || raw === '') {
    throw fail('WORKSPACE_INVALID', 'workspace 缺少 path / realpath')
  }
  if (!isAbsolute(raw)) {
    throw fail('WORKSPACE_INVALID', `workspace 路径必须是绝对路径：${raw}`)
  }
  const realpath = typeof workspace.realpath === 'string' && workspace.realpath !== ''
    ? resolve(workspace.realpath)
    : resolve(raw)
  const id = typeof workspace.id === 'string' && WORKSPACE_ID_PATTERN.test(workspace.id)
    ? workspace.id
    : workspaceIdFor(realpath)
  return { path: resolve(raw), realpath, id }
}

/** record.path 必须是非空、绝对的字符串；不然明确报错。 */
function recordPathOf(record) {
  requireObject(record, 'record', 'WORKTREE_INVALID')
  if (typeof record.path !== 'string' || record.path === '') {
    throw fail('WORKTREE_INVALID', 'record.path 必须是非空字符串')
  }
  if (!isAbsolute(record.path)) {
    throw fail('WORKTREE_INVALID', `record.path 必须是绝对路径：${record.path}`)
  }
  return resolve(record.path)
}

/** runId 会进目录名与分支名，按 runlog.checkRunId 的口径挡掉穿越。 */
function assertRunId(runId) {
  if (typeof runId !== 'string' || runId === '') {
    throw fail('RUN_ID_INVALID', 'runId 必须是非空字符串')
  }
  if (!RUN_ID_PATTERN.test(runId) || runId === '.' || runId === '..'
    || runId.startsWith('.') || runId.includes('/') || runId.includes('..')) {
    throw fail(
      'RUN_ID_INVALID',
      `runId「${runId}」不合法：只允许字母/数字/点/下划线/连字符，且不能是 . / .. 或含「..」`,
    )
  }
  return runId
}

/** 分支名是否满足 git ref 的基本约束（保守：宁拒勿错）。 */
function isValidRefName(name) {
  if (typeof name !== 'string' || name === '' || name.length > 200) return false
  if (!REF_PATTERN.test(name)) return false
  if (name.startsWith('/') || name.startsWith('-') || name.endsWith('/') || name.endsWith('.')) return false
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false
  return name.split('/').every(segment => (
    segment !== ''
    && segment !== '.'
    && segment !== '..'
    && !segment.startsWith('.')
    && !segment.startsWith('-')
    && !segment.endsWith('.lock')
  ))
}

/** branchPrefix 单独校验：允许以 `/` 结尾（默认 `flow/`）。 */
function assertBranchPrefix(prefix) {
  if (typeof prefix !== 'string' || prefix === '') {
    throw fail('WORKTREE_INVALID', 'branchPrefix 必须是非空字符串')
  }
  if (prefix.length > 120) {
    throw fail('WORKTREE_INVALID', 'branchPrefix 超过 120 字符')
  }
  if (!REF_PATTERN.test(prefix) || prefix.startsWith('/') || prefix.includes('..')
    || prefix.includes('//') || prefix.endsWith('.')) {
    throw fail('WORKTREE_INVALID', `branchPrefix「${prefix}」不是合法的 ref 片段`)
  }
}

/** baseRef 只进 argv，不经过 shell；挡掉空白与「看起来像选项」的输入。 */
function assertBaseRef(baseRef) {
  if (typeof baseRef !== 'string' || baseRef === '' || baseRef !== baseRef.trim()) {
    throw fail('WORKTREE_INVALID', 'baseRef 必须是非空、无首尾空白的字符串')
  }
  if (baseRef.length > 200 || baseRef.startsWith('-') || /[\s\0]/.test(baseRef)) {
    throw fail('WORKTREE_INVALID', `baseRef「${baseRef}」不合法`)
  }
}

/**
 * 解析工作区：绝对路径 → realpath → 判断它是不是 git 仓库根。
 *
 * - 路径不存在 / 不是目录 → 抛 `{ code:'WORKSPACE_NOT_FOUND' }`；
 * - `git -C <path> rev-parse --show-toplevel` 成功且结果就是它自己 → `isGit:true`；
 *   成功但结果是上层目录（子目录）→ `isGit:false` 并保留 `gitRoot`；
 *   非 0 退出（不是 git 仓库）→ `isGit:false, gitRoot:null`；
 * - git 根本起不来（ENOENT / 超时）→ 抛 `{ code:'GIT_UNAVAILABLE' }`，不静默降级。
 *
 * @param {{ cwd?:string, path?:string, run?:Function }} [options]
 * @returns {Promise<{ id:string, path:string, realpath:string, isGit:boolean, gitRoot:string|null }>}
 */
export async function resolveWorkspace({ cwd, path, run } = {}) {
  const git = resolveRunner(run)
  const raw = path === undefined || path === null ? cwd : path
  if (typeof raw !== 'string' || raw === '') {
    throw fail('WORKSPACE_INVALID', 'resolveWorkspace 需要 path 或 cwd')
  }
  const base = typeof cwd === 'string' && cwd !== '' ? resolve(cwd) : process.cwd()
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)

  let realpath
  try {
    if (!statSync(absolute).isDirectory()) {
      throw fail('WORKSPACE_NOT_FOUND', `工作区不存在或不是目录：${absolute}`)
    }
    realpath = realpathSync(absolute)
  } catch (error) {
    if (error && error.code === 'WORKSPACE_NOT_FOUND') throw error
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw fail('WORKSPACE_NOT_FOUND', `工作区不存在：${absolute}`)
    }
    throw error
  }

  const probe = await callGit(git, ['-C', realpath, 'rev-parse', '--show-toplevel'], realpath)
  if (!probe.ok && probe.exitCode === null) {
    throw fail('GIT_UNAVAILABLE', `无法执行 git：${summarize(collectText(probe)) || '未知错误'}`)
  }

  let isGit = false
  let gitRoot = null
  if (probe.ok) {
    const top = probe.stdout.trim()
    if (top !== '') {
      const topAbsolute = isAbsolute(top) ? resolve(top) : resolve(realpath, top)
      try {
        gitRoot = realpathSync(topAbsolute)
      } catch {
        // git 给的路径理论上已存在；万一解析失败就退回词法路径，不让解析本身变成失败点。
        gitRoot = topAbsolute
      }
      isGit = gitRoot === realpath
    }
  }

  return { id: workspaceIdFor(realpath), path: absolute, realpath, isGit, gitRoot }
}

/**
 * worktree 决策（纯函数，07 §4.1）：策略 `auto | on | off`。
 *
 * - `off` → `{ enabled:false, reason:'disabled-by-initiator' }`（不看是否 git）；
 * - 非 git 仓库根 + `auto` → `{ enabled:false, reason:'not-a-git-repo' }`；
 * - 非 git 仓库根 + `on` → 抛 `{ code:'WORKTREE_UNAVAILABLE' }`（不许静默降级）；
 * - git 仓库根 + `auto` / `on` → `{ enabled:true, reason:'git-workspace' }`。
 *
 * @param {{ workspace:object, policy?:'auto'|'on'|'off' }} [options]
 * @returns {{ enabled:boolean, reason:string }}
 */
export function decideWorktree({ workspace, policy } = {}) {
  requireObject(workspace, 'workspace', 'WORKSPACE_INVALID')
  const chosen = policy === undefined || policy === null ? 'auto' : policy
  if (!WORKTREE_POLICIES.has(chosen)) {
    throw fail('WORKTREE_POLICY_INVALID', `worktree 策略「${String(chosen)}」不合法：只允许 auto / on / off`)
  }
  if (chosen === 'off') {
    return { enabled: false, reason: 'disabled-by-initiator' }
  }
  if (workspace.isGit !== true) {
    if (chosen === 'on') {
      throw fail(
        'WORKTREE_UNAVAILABLE',
        `工作区不是 git 仓库根，无法按 on 建 worktree：${workspace.path || workspace.realpath || '(未知)'}`,
      )
    }
    return { enabled: false, reason: 'not-a-git-repo' }
  }
  return { enabled: true, reason: 'git-workspace' }
}

/** 探测分支名：`<prefix><runId>` 被占用就依次试 `-2`、`-3`…。 */
async function pickBranch(git, cwd, baseBranch) {
  for (let attempt = 1; attempt <= MAX_BRANCH_ATTEMPTS; attempt += 1) {
    const branch = attempt === 1 ? baseBranch : `${baseBranch}-${attempt}`
    if (!isValidRefName(branch)) {
      throw fail('WORKTREE_INVALID', `分支名「${branch}」不是合法的 git ref`)
    }
    const probe = await callGit(git, ['-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd)
    if (probe.ok) continue // 已存在，换下一个后缀
    if (probe.exitCode === null) {
      throw fail('WORKTREE_CREATE_FAILED', `探测分支失败：${summarize(collectText(probe)) || 'git 不可用'}`, {
        stderr: summarize(collectText(probe)),
      })
    }
    return branch
  }
  throw fail(
    'WORKTREE_CREATE_FAILED',
    `分支名连续 ${MAX_BRANCH_ATTEMPTS} 个都被占用：${baseBranch}`,
  )
}

/** 读取 baseCommit；失败一律翻译成 WORKTREE_CREATE_FAILED 并带 stderr 摘要。 */
async function readBaseCommit(git, cwd, baseRef) {
  const probe = await callGit(git, ['-C', cwd, 'rev-parse', baseRef], cwd)
  if (!probe.ok) {
    const detail = summarize(collectText(probe))
    throw fail('WORKTREE_CREATE_FAILED', `读取 baseCommit 失败（${baseRef}）：${detail || '未知错误'}`, {
      stderr: detail,
    })
  }
  const commit = probe.stdout.trim().split(/\s+/)[0]
  if (!commit) {
    throw fail('WORKTREE_CREATE_FAILED', `读取 baseCommit 失败（${baseRef}）：git 没有返回 commit`)
  }
  return commit
}

/**
 * 建 worktree（07 §4.2）：路径 `<root>/<workspaceId>/<runId>`，分支
 * `<branchPrefix><runId>`（冲突加 `-2`、`-3`…），base 取 `baseRef`（默认 HEAD）。
 *
 * 成功返回 `{ enabled:true, reason:'git-workspace', path, branch, baseCommit,
 * createdAt }`；失败抛
 * `{ code:'WORKTREE_CREATE_FAILED' }`，`error.stderr` 是 ≤300 字符的原始摘要。
 * 注意：这里只信任 `git worktree add` 的退出码，不额外「假装建好」——
 * 退出码 0 之后目录不存在属于 git 自身异常，由调用方/验收测试兜底。
 *
 * @param {{ workspace:object, runId:string, root:string, branchPrefix?:string,
 *   baseRef?:string, run?:Function }} [options]
 * @returns {Promise<{ enabled:true, reason:string, path:string, branch:string,
 *   baseCommit:string, createdAt:string }>}
 */
export async function createWorktree({
  workspace,
  runId,
  root,
  branchPrefix = DEFAULT_BRANCH_PREFIX,
  baseRef = 'HEAD',
  run,
} = {}) {
  const git = resolveRunner(run)
  const info = workspaceInfoOf(workspace)
  if (workspace.isGit === false) {
    throw fail(
      'WORKTREE_UNAVAILABLE',
      `工作区不是 git 仓库根，无法建 worktree：${info.realpath}`,
    )
  }
  const safeRunId = assertRunId(runId)
  if (typeof root !== 'string' || root === '') {
    throw fail('WORKTREE_INVALID', 'createWorktree 需要 root（worktrees 根目录）')
  }
  const rootAbsolute = isAbsolute(root) ? resolve(root) : resolve(process.cwd(), root)
  assertBranchPrefix(branchPrefix)
  assertBaseRef(baseRef)

  const branchBase = `${branchPrefix}${safeRunId}`
  if (!isValidRefName(branchBase)) {
    throw fail('WORKTREE_INVALID', `分支名「${branchBase}」不是合法的 git ref`)
  }
  const targetPath = join(rootAbsolute, info.id, safeRunId)
  const branch = await pickBranch(git, info.realpath, branchBase)
  const baseCommit = await readBaseCommit(git, info.realpath, baseRef)

  try {
    mkdirSync(dirname(targetPath), { recursive: true })
  } catch (error) {
    const detail = summarize(error && error.message)
    throw fail('WORKTREE_CREATE_FAILED', `创建 worktree 父目录失败：${detail || '未知错误'}`, {
      stderr: detail,
      path: targetPath,
      branch,
      baseCommit,
    })
  }

  const add = await callGit(
    git,
    ['-C', info.realpath, 'worktree', 'add', '-B', branch, targetPath, baseCommit],
    info.realpath,
  )
  if (!add.ok) {
    const detail = summarize(collectText(add))
    throw fail('WORKTREE_CREATE_FAILED', `git worktree add 失败：${detail || '未知错误'}`, {
      stderr: detail,
      path: targetPath,
      branch,
      baseCommit,
    })
  }

  return {
    enabled: true,
    reason: 'git-workspace',
    path: targetPath,
    branch,
    baseCommit,
    createdAt: new Date().toISOString(),
  }
}

/**
 * 查看 worktree 现状：`{ exists, head, dirty }`。
 * 目录不存在 → `{ exists:false, head:null, dirty:null }`；git 命令失败时对应字段
 * 为 null，并附 `error` 摘要（只读诊断，不抛错）。
 *
 * @param {{ workspace:object, record:object, run?:Function }} [options]
 * @returns {Promise<{ exists:boolean, head:string|null, dirty:boolean|null, error?:string }>}
 */
export async function inspectWorktree({ workspace, record, run } = {}) {
  const git = resolveRunner(run)
  workspaceInfoOf(workspace) // 校验 workspace；inspect 只用 record.path 跑 git
  const target = recordPathOf(record)
  if (!existsSync(target)) {
    return { exists: false, head: null, dirty: null }
  }

  const headProbe = await callGit(git, ['-C', target, 'rev-parse', 'HEAD'], target)
  const statusProbe = await callGit(git, ['-C', target, 'status', '--porcelain'], target)
  const head = headProbe.ok ? (headProbe.stdout.trim().split(/\s+/)[0] || null) : null
  const dirty = statusProbe.ok ? statusProbe.stdout.trim() !== '' : null
  const result = { exists: true, head, dirty }
  if (!headProbe.ok || !statusProbe.ok) {
    const detail = summarize([collectText(headProbe), collectText(statusProbe)].filter(Boolean).join(' / '))
    if (detail) result.error = detail
  }
  return result
}

/** 删除前的路径校验：必须是 `<root>/<workspaceId>/<runId>` 这种形状。 */
function assertWorktreePathSafe({ target, workspaceId, explicitRoot }) {
  const unsafe = reason => fail('WORKTREE_PATH_UNSAFE', `拒绝删除：${reason}（path=${target}）`)
  if (!isAbsolute(target)) throw unsafe('record.path 不是绝对路径')
  const parent = dirname(target)
  if (basename(parent) !== workspaceId) {
    throw unsafe(`父目录不是 workspaceId「${workspaceId}」`)
  }
  const rel = relative(parent, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) {
    throw unsafe('必须直接位于 <root>/<workspaceId>/ 下')
  }
  if (explicitRoot !== null) {
    const expectedParent = join(resolve(explicitRoot), workspaceId)
    if (parent !== expectedParent) {
      throw unsafe(`不在 <root>/<workspaceId>/ 前缀下（期望 ${expectedParent}）`)
    }
  }
}

/**
 * 删 worktree（07 §4.2）：先校验 `record.path` 落在 `<root>/<workspaceId>/`
 * 下（不满足 → `{ code:'WORKTREE_PATH_UNSAFE' }`），再
 * `git -C <workspace> worktree remove [--force] <path>`；目录不存在则
 * `{ removed:false, reason:'not-found' }`（不假装删过）。
 *
 * `root` 可选：调用方传了（或 record.root）就按严格前缀校验；没传则按
 * 「父目录名 === workspaceId 且 path 是它的直接子项」做结构校验。
 * 删除失败抛 `{ code:'WORKTREE_REMOVE_FAILED' }` 并带 stderr 摘要。
 *
 * @param {{ workspace:object, record:object, run?:Function, force?:boolean,
 *   root?:string }} [options]
 * @returns {Promise<{ removed:boolean, reason:string, path?:string }>}
 */
export async function removeWorktree({ workspace, record, run, force, root } = {}) {
  const git = resolveRunner(run)
  const info = workspaceInfoOf(workspace)
  const target = recordPathOf(record)

  let explicitRoot = null
  if (typeof root === 'string' && root !== '') {
    explicitRoot = isAbsolute(root) ? resolve(root) : resolve(process.cwd(), root)
  } else if (typeof record.root === 'string' && record.root !== '') {
    explicitRoot = isAbsolute(record.root) ? resolve(record.root) : resolve(process.cwd(), record.root)
  } else if (typeof workspace.worktreeRoot === 'string' && workspace.worktreeRoot !== '') {
    explicitRoot = isAbsolute(workspace.worktreeRoot)
      ? resolve(workspace.worktreeRoot)
      : resolve(process.cwd(), workspace.worktreeRoot)
  }

  assertWorktreePathSafe({ target, workspaceId: info.id, explicitRoot })

  if (!existsSync(target)) {
    return { removed: false, reason: 'not-found' }
  }

  const argv = ['-C', info.realpath, 'worktree', 'remove']
  if (force === true) argv.push('--force')
  argv.push(target)
  const probe = await callGit(git, argv, info.realpath)
  if (!probe.ok) {
    const detail = summarize(collectText(probe))
    throw fail('WORKTREE_REMOVE_FAILED', `git worktree remove 失败：${detail || '未知错误'}`, {
      stderr: detail,
      path: target,
    })
  }
  return { removed: true, reason: 'removed', path: target }
}
