/**
 * 实例域 worktree（0.13.7 C）：一个实例一棵树，生命周期由宿主掌握。
 *
 * 契约（计划 C）：
 *   - 路径 `<worktreeRoot>/<workspaceId>/<instanceId>`；
 *   - 分支 `flow-instance/<instanceId>`（被占用时 `-2`、`-3`…）；
 *   - `baseRef` 缺省 `HEAD`，创建时冻结成 `baseCommit`，后续不重读移动的 HEAD；
 *   - 记录形状 `{v:1, instanceId, workspaceId, repositoryRoot, effectiveRoot, branch,
 *     baseCommit, cleanupPolicy, resourceState, createdAt}`；
 *   - **不自动** commit / merge / push；删除只删「记录 + Git 登记」都证明属于本实例的树；
 *   - 所有 Git 调用走可注入 `runner`（默认 `git -C <path> ...`）。
 *
 * 失败码见 {@link INSTANCE_WORKTREE_ERROR}；`inspect` 不抛「未分类错误」，一律返回
 * 确定性 `state` / `reasons`，方便路由与 GUI 直接展示。
 *
 * @module @feiyueve/dsh-flow-studio/instance-worktree
 */

import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync,
} from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { defaultGitRunner } from './workspace-policy.js'
import {
  CLEANUP_POLICY_SET,
  RESOURCE_RECORD_VERSION,
  RESOURCE_STATE,
  normalizeResourceRecord,
  scanResourceRecords,
} from './instance-resources.js'

/** 分支前缀：只删这个前缀下、且确属本实例的分支。 */
export const INSTANCE_BRANCH_PREFIX = 'flow-instance/'
/** 缺省 baseRef（创建时冻结成 baseCommit）。 */
export const DEFAULT_WORKTREE_BASE_REF = 'HEAD'
/** 分支后缀最多尝试次数。 */
export const MAX_BRANCH_ATTEMPTS = 20
/** 实例 id 规则（与 instance-store 同口径）。 */
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{12}$/
const HEAD_PATTERN = /^[0-9a-f]{40,64}$/i

/** 对外错误码。 */
export const INSTANCE_WORKTREE_ERROR = Object.freeze({
  INVALID: 'INSTANCE_WORKTREE_INVALID',
  NOT_GIT: 'INSTANCE_WORKTREE_NOT_GIT',
  GIT_UNAVAILABLE: 'INSTANCE_WORKTREE_GIT_UNAVAILABLE',
  CREATE_FAILED: 'INSTANCE_WORKTREE_CREATE_FAILED',
  EMPTY_REPOSITORY: 'INSTANCE_WORKTREE_EMPTY_REPOSITORY',
  NOT_FOUND: 'INSTANCE_WORKTREE_NOT_FOUND',
  PATH_UNSAFE: 'INSTANCE_WORKTREE_PATH_UNSAFE',
  NOT_REGISTERED: 'INSTANCE_WORKTREE_NOT_REGISTERED',
  DIRTY: 'INSTANCE_WORKTREE_DIRTY',
  LOCKED: 'INSTANCE_WORKTREE_LOCKED',
  HEAD_MISMATCH: 'INSTANCE_WORKTREE_HEAD_MISMATCH',
  REMOVE_FAILED: 'INSTANCE_WORKTREE_REMOVE_FAILED',
  BRANCH_NOT_OWNED: 'INSTANCE_WORKTREE_BRANCH_NOT_OWNED',
  BRANCH_UNMERGED: 'INSTANCE_WORKTREE_BRANCH_UNMERGED',
  BRANCH_REMOVE_FAILED: 'INSTANCE_WORKTREE_BRANCH_REMOVE_FAILED',
  REGISTRY_CORRUPT: 'INSTANCE_WORKTREE_REGISTRY_CORRUPT',
  PLAN_INVALID: 'INSTANCE_WORKTREE_PLAN_INVALID',
  PLAN_STALE: 'INSTANCE_WORKTREE_PLAN_STALE',
})

const GIT_TIMEOUT_MS = 20 * 1000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const ALREADY_EXISTS_HINT = /already exists|already checked out|is a worktree/i
const BRANCH_IN_USE_HINT = /already checked out|is already used by worktree/i
const DIRTY_HINT = /contains modified or untracked files|is dirty|has local changes/i
const LOCKED_HINT = /is locked|locked working tree/i
const NOT_REGISTERED_HINT = /is not a working tree|not a valid worktree|is not a worktree/i

/** 带 code 的确定性错误。 */
export class InstanceWorktreeError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'InstanceWorktreeError'
    this.code = code
    Object.assign(this, extra)
  }

  toPayload() {
    return { ok: false, code: this.code, error: this.message }
  }
}

function fail(code, message, extra) {
  return new InstanceWorktreeError(code, message, extra)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

function summarize(text, max = 300) {
  const raw = typeof text === 'string' ? text.trim() : ''
  return raw.length <= max ? raw : raw.slice(0, max)
}

async function callGit(runner, argv, cwd) {
  let result
  try {
    result = await runner(argv, { cwd, timeoutMs: GIT_TIMEOUT_MS })
  } catch (error) {
    const exitCode = error && Number.isInteger(error.status)
      ? error.status
      : error && Number.isInteger(error.exitCode)
        ? error.exitCode
        : null
    return {
      ok: false,
      stdout: textOf(error && error.stdout),
      stderr: textOf(error && error.stderr),
      exitCode,
      error,
    }
  }
  const stdout = typeof result === 'string' ? result : textOf(result && result.stdout)
  const stderr = typeof result === 'string' ? '' : textOf(result && result.stderr)
  const code = result !== null && typeof result === 'object' && Number.isInteger(result.code)
    ? result.code
    : 0
  return { ok: code === 0, stdout, stderr, exitCode: code, error: null }
}

function requireInstanceId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!INSTANCE_ID_PATTERN.test(text) || text === '.' || text === '..' || text.startsWith('.')) {
    throw fail(INSTANCE_WORKTREE_ERROR.INVALID, `instanceId 非法：${String(value)}`)
  }
  return text
}

function requireWorkspaceId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!WORKSPACE_ID_PATTERN.test(text)) {
    throw fail(INSTANCE_WORKTREE_ERROR.INVALID, `workspaceId 必须是 12 位小写十六进制：${String(value)}`)
  }
  return text
}

function requireAbsolute(value, field) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '' || !isAbsolute(text)) {
    throw fail(INSTANCE_WORKTREE_ERROR.INVALID, `${field} 必须是绝对路径：${String(value)}`)
  }
  return resolve(text)
}

function assertBaseRef(baseRef) {
  const text = typeof baseRef === 'string' ? baseRef : ''
  if (text === '' || text !== text.trim() || text.length > 200 || text.startsWith('-') || /[\s\0]/.test(text)) {
    throw fail(INSTANCE_WORKTREE_ERROR.INVALID, `baseRef 非法：${String(baseRef)}`)
  }
  return text
}

function isValidRefName(name) {
  if (typeof name !== 'string' || name === '' || name.length > 200) return false
  if (/[~^:?*[\]\\\s\0]/.test(name)) return false
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 分支是不是本实例的所有物（`flow-instance/<id>` 或 `-N`）。 */
export function isOwnedByInstance(branch, instanceId) {
  if (typeof branch !== 'string' || branch === '' || !isValidRefName(branch)) return false
  const id = requireInstanceId(instanceId)
  const base = `${INSTANCE_BRANCH_PREFIX}${id}`
  if (branch === base) return true
  return new RegExp(`^${escapeRegExp(base)}-\\d+$`).test(branch)
}

/** 宽松版所有权判断：记录损坏时不抛错，只返回 false。 */
function safeOwnedBranch(branch, instanceId) {
  try {
    return isOwnedByInstance(branch, instanceId)
  } catch {
    return false
  }
}

/** 路径结构校验：`<anything>/<workspaceId>/<instanceId>` 的直接子项，且不是符号链接。 */
function assertSafePath({ target, workspaceId, instanceId, worktreeRoot }) {
  const unsafe = reason => fail(INSTANCE_WORKTREE_ERROR.PATH_UNSAFE, `拒绝操作工作树：${reason}（${target}）`, { path: target })
  if (!isAbsolute(target)) throw unsafe('目标不是绝对路径')
  if (basename(target) !== instanceId) throw unsafe(`目录名不是实例 id「${instanceId}」`)
  const parent = dirname(target)
  if (basename(parent) !== workspaceId) throw unsafe(`父目录不是 workspaceId「${workspaceId}」`)
  let info = null
  try {
    info = lstatSync(target)
  } catch {
    info = null
  }
  if (info && info.isSymbolicLink()) throw unsafe('目标路径是符号链接')
  if (worktreeRoot !== undefined && worktreeRoot !== null && worktreeRoot !== '') {
    const root = requireAbsolute(worktreeRoot, 'worktreeRoot')
    const parentReal = realpathOrSelf(parent)
    const expected = join(realpathOrSelf(root), workspaceId)
    if (parentReal !== expected) {
      throw unsafe(`不在 <worktreeRoot>/<workspaceId>/ 下（期望 ${expected}，实际 ${parentReal}）`)
    }
    const rel = relative(expected, join(parentReal, instanceId))
    if (rel !== instanceId) throw unsafe(`目标不是 <worktreeRoot>/<workspaceId>/<instanceId>（rel=${rel || '(空)'}）`)
  }
}

function realpathOrSelf(target) {
  try {
    return existsSync(target) ? realpathSyncSafe(target) : resolve(target)
  } catch {
    return resolve(target)
  }
}

function realpathSyncSafe(target) {
  try {
    return realpathSync(target)
  } catch {
    return resolve(target)
  }
}

function normalizeRecord(raw) {
  try {
    return normalizeResourceRecord(raw)
  } catch (error) {
    throw fail(
      INSTANCE_WORKTREE_ERROR.INVALID,
      `worktree 记录非法：${error?.message ?? error}`,
      { cause: error },
    )
  }
}

/** 空仓库判断：HEAD 不可解析但 HEAD 还是 symbolic ref。 */
async function repositoryIsEmpty(git, repo) {
  const head = await callGit(git, ['-C', repo, 'rev-parse', '--verify', '--quiet', 'HEAD'], repo)
  if (head.ok) return false
  if (head.exitCode === null) {
    throw fail(INSTANCE_WORKTREE_ERROR.GIT_UNAVAILABLE, `无法执行 git：${summarize(head.stderr || head.error?.message)}`)
  }
  const symbolic = await callGit(git, ['-C', repo, 'symbolic-ref', '--quiet', 'HEAD'], repo)
  return symbolic.ok
}

/** 读 base 提交；空仓库返回 `{empty:true, commit:null}`。 */
async function readBaseInfo(git, repo, baseRef) {
  const probe = await callGit(git, ['-C', repo, 'rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], repo)
  if (probe.ok) {
    const commit = probe.stdout.trim().split(/\s+/)[0]
    if (commit && HEAD_PATTERN.test(commit)) return { empty: false, commit: commit.toLowerCase() }
  }
  if (probe.exitCode === null) {
    throw fail(
      INSTANCE_WORKTREE_ERROR.GIT_UNAVAILABLE,
      `读取 baseCommit 失败（${baseRef}）：${summarize(probe.stderr || probe.error?.message) || 'git 不可用'}`,
    )
  }
  if (baseRef === DEFAULT_WORKTREE_BASE_REF && await repositoryIsEmpty(git, repo)) {
    return { empty: true, commit: null }
  }
  throw fail(
    INSTANCE_WORKTREE_ERROR.CREATE_FAILED,
    `读取 baseCommit 失败（${baseRef}）：${summarize(probe.stderr || probe.stdout) || '未知错误'}`,
    { baseRef, reason: 'base-ref-not-found' },
  )
}

/** 选一个空闲分支：`flow-instance/<id>` 或 `-2`…`-N`。 */
async function pickBranch(git, repo, instanceId) {
  const base = `${INSTANCE_BRANCH_PREFIX}${instanceId}`
  for (let attempt = 1; attempt <= MAX_BRANCH_ATTEMPTS; attempt += 1) {
    const branch = attempt === 1 ? base : `${base}-${attempt}`
    if (!isValidRefName(branch)) {
      throw fail(INSTANCE_WORKTREE_ERROR.INVALID, `分支名不是合法 ref：${branch}`)
    }
    const probe = await callGit(git, ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo)
    if (probe.ok) continue
    if (probe.exitCode === null) {
      throw fail(INSTANCE_WORKTREE_ERROR.GIT_UNAVAILABLE, `探测分支失败：${summarize(probe.stderr || probe.error?.message)}`)
    }
    return branch
  }
  throw fail(
    INSTANCE_WORKTREE_ERROR.CREATE_FAILED,
    `分支名连续 ${MAX_BRANCH_ATTEMPTS} 个都被占用：${base}`,
    { reason: 'branch-conflict' },
  )
}

/**
 * 解析 `git worktree list --porcelain`。
 * @returns {Array<{path:string, head:string|null, branch:string|null, detached:boolean,
 *   locked:boolean, prunable:boolean}>}
 */
export function parseWorktreeList(text) {
  const entries = []
  let current = null
  const flush = () => {
    if (current && current.path !== '') entries.push(current)
    current = null
  }
  for (const rawLine of (typeof text === 'string' ? text.split('\n') : [])) {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim() === '') {
      flush()
      continue
    }
    if (current === null) {
      current = { path: '', head: null, branch: null, detached: false, locked: false, prunable: false }
    }
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    if (key === 'worktree') current.path = value
    else if (key === 'HEAD') current.head = value === '0000000000000000000000000000000000000000' ? null : value
    else if (key === 'branch') current.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value
    else if (key === 'detached') current.detached = true
    else if (key === 'locked') current.locked = true
    else if (key === 'prunable') current.prunable = true
  }
  flush()
  return entries
}

async function listRepoWorktrees(git, repo) {
  const probe = await callGit(git, ['-C', repo, 'worktree', 'list', '--porcelain'], repo)
  if (!probe.ok) {
    return { ok: false, entries: [], exitCode: probe.exitCode, detail: summarize(probe.stderr || probe.stdout) }
  }
  return { ok: true, entries: parseWorktreeList(probe.stdout), exitCode: 0, detail: '' }
}

function samePath(left, right) {
  return realpathOrSelf(left) === realpathOrSelf(right)
}

async function entryForPath(git, repo, target) {
  const listing = await listRepoWorktrees(git, repo)
  if (!listing.ok) return { listed: false, entry: null, detail: listing.detail }
  return { listed: true, entry: listing.entries.find(item => samePath(item.path, target)) || null, detail: '' }
}

/**
 * 建实例 worktree。
 *
 * `workspace` 是 `workspace-policy.resolveWorkspace()` 的结果（含 `workspaceId` /
 * `repositoryRoot`）；测试 / 嵌入方也可传等价对象。`worktreeRoot` 可显式给，也可由
 * `workspace.worktreeRoot` 提供。
 *
 * @param {{
 *   instanceId: string,
 *   workspace: object,
 *   baseRef?: string,
 *   cleanupPolicy?: 'retain'|'on-terminal-clean',
 *   worktreeRoot?: string,
 *   runner?: Function,
 *   now?: () => Date,
 * }} options
 * @returns {Promise<object>} 资源记录
 */
export async function createInstanceWorktree(options = {}) {
  if (!isPlainObject(options)) {
    throw fail(INSTANCE_WORKTREE_ERROR.INVALID, 'createInstanceWorktree 需要对象参数')
  }
  const instanceId = requireInstanceId(options.instanceId)
  const workspace = options.workspace
  if (!isPlainObject(workspace)) {
    throw fail(INSTANCE_WORKTREE_ERROR.INVALID, 'createInstanceWorktree 需要已解析的 workspace')
  }
  if (workspace.isGit === false) {
    throw fail(
      INSTANCE_WORKTREE_ERROR.NOT_GIT,
      `工作区不是 Git 仓库根，无法建立 worktree：${workspace.realpath ?? workspace.path ?? '(未知)'}`,
      { reason: workspace.gitRoot ? 'subdirectory' : 'not-a-repo' },
    )
  }
  const workspaceId = requireWorkspaceId(workspace.workspaceId)
  const repositoryRoot = requireAbsolute(workspace.repositoryRoot, 'workspace.repositoryRoot')
  const worktreeRoot = requireAbsolute(
    options.worktreeRoot ?? workspace.worktreeRoot,
    'worktreeRoot',
  )
  const baseRef = assertBaseRef(options.baseRef ?? DEFAULT_WORKTREE_BASE_REF)
  const cleanupPolicy = options.cleanupPolicy === undefined
    ? 'retain'
    : options.cleanupPolicy
  if (typeof cleanupPolicy !== 'string' || !CLEANUP_POLICY_SET.has(cleanupPolicy)) {
    throw fail(INSTANCE_WORKTREE_ERROR.INVALID, `cleanupPolicy 非法：${String(cleanupPolicy)}`)
  }
  const git = typeof options.runner === 'function' ? options.runner : defaultGitRunner
  const now = typeof options.now === 'function' ? options.now : () => new Date()

  if (!existsSync(repositoryRoot)) {
    throw fail(INSTANCE_WORKTREE_ERROR.NOT_FOUND, `主仓库不存在：${repositoryRoot}`, { path: repositoryRoot })
  }
  const probe = await callGit(git, ['-C', repositoryRoot, 'rev-parse', '--git-common-dir'], repositoryRoot)
  if (!probe.ok) {
    if (probe.exitCode === null) {
      throw fail(INSTANCE_WORKTREE_ERROR.GIT_UNAVAILABLE, `无法执行 git：${summarize(probe.stderr || probe.error?.message)}`)
    }
    throw fail(INSTANCE_WORKTREE_ERROR.NOT_GIT, `主仓库不是 Git 仓库：${repositoryRoot}`, { repositoryRoot })
  }

  const base = await readBaseInfo(git, repositoryRoot, baseRef)
  const branch = await pickBranch(git, repositoryRoot, instanceId)
  const target = join(worktreeRoot, workspaceId, instanceId)
  assertSafePath({ target, workspaceId, instanceId, worktreeRoot })

  if (existsSync(target)) {
    throw fail(
      INSTANCE_WORKTREE_ERROR.CREATE_FAILED,
      `目标路径已存在，拒绝覆盖：${target}`,
      { reason: 'path-exists', path: target },
    )
  }
  try {
    await mkdir(dirname(target), { recursive: true })
  } catch (error) {
    throw fail(
      INSTANCE_WORKTREE_ERROR.CREATE_FAILED,
      `创建 worktree 父目录失败：${error?.message ?? error}`,
      { reason: 'mkdir-failed', path: target, cause: error },
    )
  }

  const addArgv = base.empty
    ? ['-C', repositoryRoot, 'worktree', 'add', '--orphan', '-b', branch, target]
    : ['-C', repositoryRoot, 'worktree', 'add', '-b', branch, target, base.commit]
  const add = await callGit(git, addArgv, repositoryRoot)
  if (!add.ok || !existsSync(target)) {
    const detail = summarize(add.stderr || add.stdout || add.error?.message)
    // 回滚本次刚建的分支与半成品目录（不碰别人的分支）。
    await callGit(git, ['-C', repositoryRoot, 'worktree', 'remove', '--force', '--force', target], repositoryRoot)
    await callGit(git, ['-C', repositoryRoot, 'worktree', 'prune', '--expire', 'now'], repositoryRoot)
    if (existsSync(target)) {
      try {
        // 只删本次创建路径；失败就让错误信息带上残留位置。
        rmSyncSafe(target)
      } catch {
        // 残留位置已在错误里给出。
      }
    }
    if (branch.startsWith(INSTANCE_BRANCH_PREFIX)) {
      await callGit(git, ['-C', repositoryRoot, 'branch', '-D', branch], repositoryRoot)
    }
    let reason = 'create-failed'
    if (base.empty) reason = 'empty-repository'
    else if (ALREADY_EXISTS_HINT.test(detail)) reason = 'path-exists'
    else if (BRANCH_IN_USE_HINT.test(detail)) reason = 'branch-conflict'
    throw fail(
      INSTANCE_WORKTREE_ERROR.CREATE_FAILED,
      `git worktree add 失败（${reason}）：${detail || '未知错误'}`,
      { reason, path: target, branch, baseCommit: base.commit, stderr: detail },
    )
  }

  const createdAt = now() instanceof Date ? now().toISOString() : new Date().toISOString()
  return {
    v: RESOURCE_RECORD_VERSION,
    instanceId,
    workspaceId,
    repositoryRoot,
    effectiveRoot: target,
    branch,
    baseCommit: base.commit,
    cleanupPolicy,
    resourceState: RESOURCE_STATE.READY,
    createdAt,
  }
}

function rmSyncSafe(target) {
  // 只删已经过 assertSafePath / Git 登记校验的路径。
  rmSync(target, { recursive: true, force: true })
}

/**
 * 检查实例 worktree；**不抛**预期失败，返回确定性状态。
 *
 * `state`：`ok` / `missing` / `unregistered` / `dirty` / `head-mismatch` /
 * `branch-mismatch` / `repository-missing` / `path-unsafe` / `invalid-record` /
 * `git-unavailable` / `error`。
 *
 * @param {{record:object, runner?:Function, worktreeRoot?:string, expectedHead?:string}} options
 */
export async function inspectInstanceWorktree(options = {}) {
  const base = {
    ok: false,
    state: 'error',
    instanceId: null,
    workspaceId: null,
    path: null,
    branch: null,
    baseCommit: null,
    exists: false,
    registered: null,
    head: null,
    currentBranch: null,
    branchMatches: null,
    dirty: null,
    cleanable: false,
    reasons: [],
  }
  let record
  try {
    record = normalizeRecord(options.record)
  } catch (error) {
    return { ...base, state: 'invalid-record', reasons: [error.message], code: error.code }
  }
  const git = typeof options.runner === 'function' ? options.runner : defaultGitRunner
  const result = {
    ...base,
    ok: true,
    instanceId: record.instanceId,
    workspaceId: record.workspaceId,
    path: record.effectiveRoot,
    branch: record.branch,
    baseCommit: record.baseCommit,
    repositoryRoot: record.repositoryRoot,
    cleanupPolicy: record.cleanupPolicy,
    resourceState: record.resourceState,
  }
  try {
    assertSafePath({
      target: record.effectiveRoot,
      workspaceId: record.workspaceId,
      instanceId: record.instanceId,
      worktreeRoot: options.worktreeRoot,
    })
  } catch (error) {
    return { ...result, state: 'path-unsafe', reasons: [error.message], code: error.code }
  }

  result.exists = existsSync(record.effectiveRoot)
  if (!existsSync(record.repositoryRoot)) {
    return { ...result, state: 'repository-missing', reasons: ['主仓库目录不存在'], registered: null }
  }

  const listing = await listRepoWorktrees(git, record.repositoryRoot)
  if (!listing.ok) {
    return {
      ...result,
      state: 'git-unavailable',
      reasons: [listing.detail || 'git worktree list 失败'],
      registered: null,
    }
  }
  const entry = listing.entries.find(item => samePath(item.path, record.effectiveRoot)) || null
  result.registered = entry !== null
  if (entry !== null) {
    result.head = entry.head
    result.currentBranch = entry.branch
    result.locked = entry.locked === true
    result.branchMatches = entry.branch === record.branch
  }

  if (!result.exists) {
    return { ...result, state: 'missing', reasons: ['工作树目录不存在'] }
  }

  const headProbe = await callGit(git, ['-C', record.effectiveRoot, 'rev-parse', 'HEAD'], record.effectiveRoot)
  if (headProbe.ok) {
    const head = headProbe.stdout.trim().split(/\s+/)[0]
    if (head && HEAD_PATTERN.test(head)) result.head = head.toLowerCase()
  } else if (headProbe.exitCode === null) {
    return { ...result, state: 'git-unavailable', reasons: ['git 不可用'] }
  }
  const statusProbe = await callGit(git, ['-C', record.effectiveRoot, 'status', '--porcelain'], record.effectiveRoot)
  if (statusProbe.ok) {
    result.dirty = statusProbe.stdout.trim() !== ''
  } else if (statusProbe.exitCode === null) {
    return { ...result, state: 'git-unavailable', reasons: ['git 不可用'] }
  }
  if (result.currentBranch === null) {
    const symbolic = await callGit(git, ['-C', record.effectiveRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD'], record.effectiveRoot)
    if (symbolic.ok) result.currentBranch = symbolic.stdout.trim()
  }
  if (result.currentBranch !== null) {
    result.branchMatches = result.currentBranch === record.branch
  }
  if (options.expectedHead !== undefined && options.expectedHead !== null && options.expectedHead !== '') {
    const expected = String(options.expectedHead).toLowerCase()
    result.expectedHead = expected
    if (result.head !== expected) {
      return { ...result, state: 'head-mismatch', reasons: [`HEAD ${result.head ?? '(未知)'} 与期望 ${expected} 不一致`] }
    }
  }
  if (result.registered !== true) {
    return { ...result, state: 'unregistered', reasons: ['目录存在但未被主仓库登记（无所有权证据）'] }
  }
  if (result.branchMatches === false) {
    return { ...result, state: 'branch-mismatch', reasons: [`当前分支 ${result.currentBranch ?? '(detached)'} 与记录 ${record.branch} 不一致`] }
  }
  if (result.dirty !== false) {
    return { ...result, state: 'dirty', reasons: ['工作树有未提交改动'] }
  }
  return { ...result, state: 'ok', cleanable: true, reasons: [] }
}

/**
 * 删除实例 worktree（不删分支；分支用 {@link removeInstanceBranch}）。
 *
 * - ACTIVE / SUSPENDED 由调用方拒绝（本函数不持有实例状态）；
 * - `expectedHead` 不一致 → HEAD_MISMATCH（`force` 不能越过乐观并发校验）；
 * - 脏树且 `force !== true` → DIRTY；
 * - 目录存在但未在记录的主仓库登记 → NOT_REGISTERED（不删别人的目录）；
 * - 分支不是本实例的 → BRANCH_NOT_OWNED；
 * - 成功后才 `rm -rf` 残留目录，并回查 Git 登记。
 *
 * @param {{record:object, force?:boolean, expectedHead?:string, runner?:Function, worktreeRoot?:string}} options
 */
export async function removeInstanceWorktree(options = {}) {
  if (!isPlainObject(options)) {
    throw fail(INSTANCE_WORKTREE_ERROR.INVALID, 'removeInstanceWorktree 需要对象参数')
  }
  const record = normalizeRecord(options.record)
  const git = typeof options.runner === 'function' ? options.runner : defaultGitRunner
  assertSafePath({
    target: record.effectiveRoot,
    workspaceId: record.workspaceId,
    instanceId: record.instanceId,
    worktreeRoot: options.worktreeRoot,
  })

  if (!existsSync(record.repositoryRoot)) {
    throw fail(
      INSTANCE_WORKTREE_ERROR.NOT_REGISTERED,
      `主仓库目录不存在，无法证明工作树所有权，拒绝删除：${record.effectiveRoot}`,
      { path: record.effectiveRoot, reason: 'repository-missing' },
    )
  }
  const listing = await listRepoWorktrees(git, record.repositoryRoot)
  if (!listing.ok) {
    throw fail(
      listing.exitCode === null ? INSTANCE_WORKTREE_ERROR.GIT_UNAVAILABLE : INSTANCE_WORKTREE_ERROR.REMOVE_FAILED,
      `无法读取主仓库的 worktree 登记：${listing.detail || '未知错误'}`,
      { path: record.effectiveRoot },
    )
  }
  const entry = listing.entries.find(item => samePath(item.path, record.effectiveRoot)) || null

  if (!existsSync(record.effectiveRoot)) {
    await callGit(git, ['-C', record.repositoryRoot, 'worktree', 'prune', '--expire', 'now'], record.repositoryRoot)
    return {
      removed: false,
      reason: 'not-found',
      path: record.effectiveRoot,
      branch: record.branch,
      registered: entry !== null,
    }
  }

  if (entry === null) {
    throw fail(
      INSTANCE_WORKTREE_ERROR.NOT_REGISTERED,
      `目录存在但未在主仓库登记，拒绝删除（可能是别的仓库 / 用户目录）：${record.effectiveRoot}`,
      { path: record.effectiveRoot, reason: 'not-registered' },
    )
  }
  if (entry.branch === null || !isOwnedByInstance(entry.branch, record.instanceId)) {
    throw fail(
      INSTANCE_WORKTREE_ERROR.BRANCH_NOT_OWNED,
      `工作树当前分支不是本实例的分支，拒绝删除：${entry.branch ?? '(detached)'}`,
      { path: record.effectiveRoot, branch: entry.branch, expectedBranch: record.branch },
    )
  }
  if (entry.branch !== record.branch) {
    throw fail(
      INSTANCE_WORKTREE_ERROR.BRANCH_NOT_OWNED,
      `工作树分支 ${entry.branch} 与记录 ${record.branch} 不一致，拒绝删除`,
      { path: record.effectiveRoot, branch: entry.branch, expectedBranch: record.branch },
    )
  }

  if (options.expectedHead !== undefined && options.expectedHead !== null && options.expectedHead !== '') {
    const expected = String(options.expectedHead).toLowerCase()
    const headProbe = await callGit(git, ['-C', record.effectiveRoot, 'rev-parse', 'HEAD'], record.effectiveRoot)
    const actual = headProbe.ok ? headProbe.stdout.trim().split(/\s+/)[0].toLowerCase() : null
    if (actual !== expected) {
      throw fail(
        INSTANCE_WORKTREE_ERROR.HEAD_MISMATCH,
        `HEAD 已变化：期望 ${expected}，实际 ${actual ?? '(未知)'}`,
        { expectedHead: expected, actualHead: actual, path: record.effectiveRoot },
      )
    }
  }

  const status = await callGit(git, ['-C', record.effectiveRoot, 'status', '--porcelain'], record.effectiveRoot)
  const dirty = status.ok ? status.stdout.trim() !== '' : null
  if (dirty !== false && options.force !== true) {
    throw fail(
      INSTANCE_WORKTREE_ERROR.DIRTY,
      `工作树有未提交改动，拒绝清理（force=true 才能删）：${record.effectiveRoot}`,
      { path: record.effectiveRoot, reason: 'dirty', dirty },
    )
  }

  let remove = await callGit(
    git,
    ['-C', record.repositoryRoot, 'worktree', 'remove', ...(options.force === true ? ['--force'] : []), record.effectiveRoot],
    record.repositoryRoot,
  )
  if (!remove.ok && (entry.locked || options.force === true)) {
    remove = await callGit(
      git,
      ['-C', record.repositoryRoot, 'worktree', 'remove', '--force', '--force', record.effectiveRoot],
      record.repositoryRoot,
    )
  }
  if (!remove.ok) {
    const detail = summarize(remove.stderr || remove.stdout)
    let code = INSTANCE_WORKTREE_ERROR.REMOVE_FAILED
    let reason = 'remove-failed'
    if (DIRTY_HINT.test(detail)) {
      code = INSTANCE_WORKTREE_ERROR.DIRTY
      reason = 'dirty'
    } else if (LOCKED_HINT.test(detail)) {
      code = INSTANCE_WORKTREE_ERROR.LOCKED
      reason = 'locked'
    } else if (NOT_REGISTERED_HINT.test(detail)) {
      code = INSTANCE_WORKTREE_ERROR.NOT_REGISTERED
      reason = 'not-registered'
    } else if (remove.exitCode === null) {
      code = INSTANCE_WORKTREE_ERROR.GIT_UNAVAILABLE
      reason = 'git-unavailable'
    }
    throw fail(code, `git worktree remove 失败（${reason}）：${detail || '未知错误'}`, {
      path: record.effectiveRoot,
      reason,
      stderr: detail,
    })
  }

  // Git 注销成功后再清残留目录（例如未跟踪文件残留）；只删已校验路径。
  if (existsSync(record.effectiveRoot)) {
    try {
      rmSyncSafe(record.effectiveRoot)
    } catch (error) {
      throw fail(
        INSTANCE_WORKTREE_ERROR.REMOVE_FAILED,
        `worktree 已注销但目录清理失败：${error?.message ?? error}`,
        { path: record.effectiveRoot, reason: 'cleanup-failed', cause: error },
      )
    }
  }
  const still = await entryForPath(git, record.repositoryRoot, record.effectiveRoot)
  if (still.listed && still.entry !== null) {
    await callGit(git, ['-C', record.repositoryRoot, 'worktree', 'prune', '--expire', 'now'], record.repositoryRoot)
    const after = await entryForPath(git, record.repositoryRoot, record.effectiveRoot)
    if (after.listed && after.entry !== null) {
      throw fail(
        INSTANCE_WORKTREE_ERROR.REMOVE_FAILED,
        `worktree 已删除但 Git 仍登记着它：${record.effectiveRoot}`,
        { path: record.effectiveRoot, reason: 'still-registered' },
      )
    }
  }
  return {
    removed: true,
    reason: 'removed',
    path: record.effectiveRoot,
    branch: record.branch,
    baseCommit: record.baseCommit,
  }
}

/**
 * 只删分支（不碰目录）。规则：
 *   - 记录里的 branch 必须确属本实例、且前缀是 `flow-instance/`；
 *   - 未合并进 `baseCommit` 的分支**不删**，返回 `reason:'unmerged'`（风险要人看）；
 *   - 不存在 / 删除失败返回结构化结果，不抛预期失败。
 *
 * @param {{record:object, runner?:Function}} options
 * @returns {Promise<{removed:boolean, branch:string|null, reason:string, warning:string|null}>}
 */
export async function removeInstanceBranch(options = {}) {
  const record = normalizeRecord(options.record)
  const git = typeof options.runner === 'function' ? options.runner : defaultGitRunner
  const branch = record.branch
  const result = { removed: false, branch, reason: 'not-removed', warning: null }
  if (!isOwnedByInstance(branch, record.instanceId)) {
    return {
      ...result,
      reason: 'not-owned',
      warning: `分支 ${branch} 不是 ${INSTANCE_BRANCH_PREFIX}${record.instanceId} 的所有物，拒绝删除`,
    }
  }
  if (!existsSync(record.repositoryRoot)) {
    return {
      ...result,
      reason: 'repository-missing',
      warning: `主仓库不存在，无法删除分支 ${branch}：${record.repositoryRoot}`,
    }
  }
  const exists = await callGit(git, ['-C', record.repositoryRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], record.repositoryRoot)
  if (!exists.ok) {
    if (exists.exitCode === null) {
      return { ...result, reason: 'git-unavailable', warning: 'git 不可用，分支未删除' }
    }
    return { ...result, reason: 'not-found', warning: `分支 ${branch} 不存在` }
  }
  if (record.baseCommit !== null) {
    // 以主仓库当前 HEAD 判断「已合并」：baseCommit 只记录创建时的基点，主仓库后续
    // 前进后旧基点不能代表当前主线。
    const merged = await callGit(
      git,
      ['-C', record.repositoryRoot, 'merge-base', '--is-ancestor', branch, 'HEAD'],
      record.repositoryRoot,
    )
    if (!merged.ok && merged.exitCode === 1) {
      return {
        ...result,
        reason: 'unmerged',
        warning: `分支 ${branch} 尚未合并进主仓库 HEAD，拒绝删除（需人工确认）`,
      }
    }
    if (!merged.ok && merged.exitCode === null) {
      return { ...result, reason: 'git-unavailable', warning: 'git 不可用，无法判断分支是否已合并' }
    }
  }
  const del = await callGit(git, ['-C', record.repositoryRoot, 'branch', '-D', branch], record.repositoryRoot)
  if (!del.ok) {
    return {
      ...result,
      reason: 'delete-failed',
      warning: `分支 ${branch} 删除失败：${summarize(del.stderr || del.stdout) || '未知错误'}`,
    }
  }
  const after = await callGit(git, ['-C', record.repositoryRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], record.repositoryRoot)
  if (after.ok) {
    return { ...result, reason: 'delete-failed', warning: `分支 ${branch} 删除后仍存在` }
  }
  return { removed: true, branch, reason: 'removed', warning: null }
}

/** 扫描 `<worktreeRoot>/<workspaceId>/<instanceId>`；返回纯目录事实。 */
function scanWorktreeDirs(root) {
  const entries = []
  let workspaceIds = []
  try {
    workspaceIds = readdirSync(root, { withFileTypes: true })
      .filter(item => item.isDirectory() && WORKSPACE_ID_PATTERN.test(item.name))
      .map(item => item.name)
  } catch {
    return entries
  }
  for (const workspaceId of workspaceIds) {
    const wsDir = join(root, workspaceId)
    let instanceIds = []
    try {
      instanceIds = readdirSync(wsDir, { withFileTypes: true })
        .filter(item => item.isDirectory() && INSTANCE_ID_PATTERN.test(item.name) && !item.name.startsWith('.'))
        .map(item => item.name)
    } catch {
      continue
    }
    for (const instanceId of instanceIds) {
      entries.push({ workspaceId, instanceId, path: join(wsDir, instanceId) })
    }
  }
  return entries
}

/** 读实例目录的元数据（只读；损坏单独标记）。 */
function readInstanceFacts(instancesRoot, instanceId) {
  if (typeof instancesRoot !== 'string' || instancesRoot.trim() === '') {
    return { instanceExists: null, instanceStatus: null, instanceCorrupt: false }
  }
  const dir = join(resolve(instancesRoot), instanceId)
  const file = join(dir, 'instance.json')
  if (!existsSync(file)) return { instanceExists: false, instanceStatus: null, instanceCorrupt: false }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const status = parsed && typeof parsed.status === 'string' ? parsed.status : null
    return { instanceExists: true, instanceStatus: status, instanceCorrupt: false }
  } catch {
    return { instanceExists: true, instanceStatus: null, instanceCorrupt: true }
  }
}

function isActiveStatus(status) {
  return status === 'ACTIVE' || status === 'SUSPENDED'
}

/**
 * 列实例 worktree：扫描 registry + 目录，标记 orphan。
 *
 * orphan 依据完整持久化实例集合 + 宿主所有权记录，不依赖内存 LRU：
 *   - 实例不存在 / instance.json 损坏；
 *   - 目录缺失；
 *   - 记录损坏；
 *   - 目录存在但没有任何所有权记录（`unregistered-directory`，只报告不删）。
 *
 * @param {{worktreeRoot:string, registryRoot:string, instancesRoot?:string,
 *   runner?:Function, workspaceId?:string}} options
 */
export async function listInstanceWorktrees(options = {}) {
  const worktreeRoot = requireAbsolute(options.worktreeRoot, 'worktreeRoot')
  const registryRoot = requireAbsolute(options.registryRoot, 'registryRoot')
  const git = typeof options.runner === 'function' ? options.runner : defaultGitRunner
  const { records, corrupt } = await scanResourceRecords({
    registryRoot,
    ...(typeof options.workspaceId === 'string' && options.workspaceId !== ''
      ? { workspaceId: requireWorkspaceId(options.workspaceId) }
      : {}),
  })

  const byKey = new Map()
  for (const record of records) {
    byKey.set(`${record.workspaceId}/${record.instanceId}`, { record, corrupt: null })
  }
  for (const item of corrupt) {
    byKey.set(`${item.workspaceId}/${item.instanceId ?? '(unknown)'}`, { record: null, corrupt: item })
  }

  const dirs = scanWorktreeDirs(worktreeRoot)
  const dirKeys = new Set()
  const entries = []
  for (const dir of dirs) {
    const key = `${dir.workspaceId}/${dir.instanceId}`
    dirKeys.add(key)
    const found = byKey.get(key) ?? { record: null, corrupt: null }
    entries.push(await buildListEntry({
      git,
      dir,
      record: found.record,
      corrupt: found.corrupt,
      instancesRoot: options.instancesRoot,
      worktreeRoot,
      workspaceId: options.workspaceId,
    }))
    byKey.delete(key)
  }
  // 有记录但目录缺失 / 记录损坏的条目同样列出来（否则 prune 看不见）。
  for (const [, found] of byKey) {
    const record = found.record
    const item = found.corrupt
    const dir = record !== null
      ? { workspaceId: record.workspaceId, instanceId: record.instanceId, path: record.effectiveRoot }
      : {
        workspaceId: item.workspaceId,
        instanceId: typeof item.instanceId === 'string' ? item.instanceId : '(unknown)',
        path: null,
      }
    if (typeof options.workspaceId === 'string' && options.workspaceId !== ''
      && dir.workspaceId !== requireWorkspaceId(options.workspaceId)) continue
    entries.push(await buildListEntry({
      git,
      dir,
      record,
      corrupt: found.corrupt,
      instancesRoot: options.instancesRoot,
      worktreeRoot,
      workspaceId: options.workspaceId,
    }))
  }

  entries.sort((left, right) => (
    left.workspaceId === right.workspaceId
      ? String(left.instanceId).localeCompare(String(right.instanceId))
      : left.workspaceId.localeCompare(right.workspaceId)
  ))
  const orphans = entries.filter(entry => entry.orphan)
  return {
    entries,
    orphans,
    corrupt: corrupt.map(item => ({ ...item })),
    scannedAt: new Date().toISOString(),
  }
}

async function buildListEntry({ git, dir, record, corrupt, instancesRoot, worktreeRoot, workspaceId }) {
  const facts = record !== null && typeof dir.instanceId === 'string'
    ? readInstanceFacts(instancesRoot, dir.instanceId)
    : (typeof dir.instanceId === 'string'
      ? readInstanceFacts(instancesRoot, dir.instanceId)
      : { instanceExists: null, instanceStatus: null, instanceCorrupt: false })
  const reasons = []
  let inspected = null
  if (record !== null) {
    inspected = await inspectInstanceWorktree({ record, runner: git, worktreeRoot })
  }
  if (corrupt !== null) reasons.push('record-corrupt')
  if (facts.instanceExists === false) reasons.push('instance-missing')
  if (facts.instanceCorrupt) reasons.push('instance-corrupt')
  if (record !== null && !existsSync(record.effectiveRoot)) reasons.push('directory-missing')
  if (record === null && corrupt === null) reasons.push('unregistered-directory', 'no-ownership-record')
  if (inspected !== null && inspected.state !== 'ok' && inspected.state !== 'missing') {
    reasons.push(`worktree-${inspected.state}`)
  }
  const orphan = reasons.length > 0
  return {
    instanceId: dir.instanceId,
    workspaceId: dir.workspaceId,
    path: record !== null ? record.effectiveRoot : dir.path,
    record: record !== null ? { ...record } : null,
    recordOk: record !== null,
    corrupt,
    instanceExists: facts.instanceExists,
    instanceStatus: facts.instanceStatus,
    instanceCorrupt: facts.instanceCorrupt,
    directoryExists: record !== null ? existsSync(record.effectiveRoot) : Boolean(dir.path && existsSync(dir.path)),
    inspected,
    registered: inspected === null ? null : inspected.registered,
    head: inspected === null ? null : inspected.head,
    branch: inspected === null ? null : inspected.currentBranch,
    dirty: inspected === null ? null : inspected.dirty,
    branchMatches: inspected === null ? null : inspected.branchMatches,
    cleanable: inspected === null ? false : inspected.cleanable === true,
    orphan,
    orphanReasons: reasons,
  }
}

/** 稳定 JSON（对象键递归排序），用于 planHash。 */
export function stableStringify(value) {
  const walk = item => {
    if (Array.isArray(item)) return `[${item.map(walk).join(',')}]`
    if (isPlainObject(item)) {
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${walk(item[key])}`).join(',')}}`
    }
    return JSON.stringify(item === undefined ? null : item)
  }
  return walk(value)
}

/** 计算 prune plan 的 hash。 */
export function planHashOf(plan) {
  if (!isPlainObject(plan) || !Array.isArray(plan.entries)) {
    throw fail(INSTANCE_WORKTREE_ERROR.PLAN_INVALID, 'prune plan 必须包含 entries 数组')
  }
  return createHash('sha256')
    .update(stableStringify({ v: RESOURCE_RECORD_VERSION, entries: plan.entries }), 'utf8')
    .digest('hex')
}

/**
 * 由 listInstanceWorktrees 的结果生成**只读预览** plan。
 *
 * - 实例 ACTIVE / SUSPENDED：`retain`；
 * - 无所有权记录 / 记录损坏 / 未登记 / 脏树：`report`（保守，不自动删）；
 * - 终态或实例缺失、记录完整、目录已登记且干净：`remove`。
 */
export function createPrunePlan({ entries, now } = {}) {
  if (!Array.isArray(entries)) {
    throw fail(INSTANCE_WORKTREE_ERROR.PLAN_INVALID, 'createPrunePlan 需要 entries 数组')
  }
  const planned = entries.map(entry => {
    const record = entry && isPlainObject(entry.record) ? entry.record : null
    const base = {
      instanceId: entry?.instanceId ?? null,
      workspaceId: entry?.workspaceId ?? null,
      path: entry?.path ?? null,
      record: record === null ? null : { ...record },
      branch: record?.branch ?? null,
      baseCommit: record?.baseCommit ?? null,
      instanceStatus: entry?.instanceStatus ?? null,
      instanceCorrupt: entry?.instanceCorrupt === true,
      head: entry?.head ?? null,
      dirty: entry?.dirty ?? null,
      registered: entry?.registered ?? null,
      action: 'report',
      reason: 'no-ownership',
    }
    if (record === null) return { ...base, reason: 'no-ownership' }
    if (!safeOwnedBranch(record.branch, record.instanceId)) {
      return { ...base, reason: 'branch-not-owned' }
    }
    // 实例目录损坏 / 列表不完整时 stop prune（只报告，不猜实例是否终态）。
    if (entry.instanceCorrupt === true) return { ...base, reason: 'instance-corrupt' }
    if (isActiveStatus(entry.instanceStatus)) {
      return { ...base, action: 'retain', reason: 'instance-active' }
    }
    if (entry.directoryExists === false) return { ...base, reason: 'directory-missing' }
    if (entry.registered !== true) return { ...base, reason: 'not-registered' }
    if (entry.dirty !== false) return { ...base, reason: entry.dirty === null ? 'dirty-unknown' : 'dirty' }
    return { ...base, action: 'remove', reason: 'owned-terminal-clean' }
  })
  const plan = {
    v: RESOURCE_RECORD_VERSION,
    createdAt: (typeof now === 'function' && now() instanceof Date ? now() : new Date()).toISOString(),
    entries: planned,
  }
  return { ...plan, planHash: planHashOf(plan) }
}

/**
 * 只按预览 plan 执行；没有所有权证据的条目只报告不删。
 *
 * @param {{plan:object, runner?:Function, worktreeRoot?:string}} options
 * @returns {Promise<{removed:object[], skipped:object[], planHash:string}>}
 */
export async function pruneInstanceWorktrees(options = {}) {
  const plan = options.plan
  if (!isPlainObject(plan) || plan.v !== RESOURCE_RECORD_VERSION || !Array.isArray(plan.entries)) {
    throw fail(INSTANCE_WORKTREE_ERROR.PLAN_INVALID, 'prune 需要 v=1 且含 entries 的预览 plan')
  }
  const actualHash = planHashOf(plan)
  const declared = typeof plan.planHash === 'string' ? plan.planHash : actualHash
  if (declared !== actualHash) {
    throw fail(INSTANCE_WORKTREE_ERROR.PLAN_STALE, 'prune plan 的 planHash 与内容不一致（plan 已过期或被修改）', {
      expected: declared,
      actual: actualHash,
    })
  }
  const git = typeof options.runner === 'function' ? options.runner : defaultGitRunner
  const removed = []
  const skipped = []
  for (const entry of plan.entries) {
    if (!isPlainObject(entry) || entry.action !== 'remove') {
      skipped.push({ ...entry, executed: false, reason: entry?.reason ?? 'not-remove' })
      continue
    }
    const record = isPlainObject(entry.record) ? entry.record : null
    if (record === null || !isOwnedByInstance(record.branch, record.instanceId)) {
      skipped.push({ ...entry, executed: false, reason: 'no-ownership' })
      continue
    }
    try {
      const result = await removeInstanceWorktree({
        record,
        force: entry.force === true,
        ...(typeof entry.head === 'string' && HEAD_PATTERN.test(entry.head) ? { expectedHead: entry.head } : {}),
        runner: git,
        worktreeRoot: options.worktreeRoot,
      })
      if (result.removed === true) removed.push({ ...entry, ...result })
      else skipped.push({ ...entry, executed: false, reason: result.reason })
    } catch (error) {
      skipped.push({
        ...entry,
        executed: false,
        reason: error?.code ?? INSTANCE_WORKTREE_ERROR.REMOVE_FAILED,
        warning: error?.message ?? String(error),
      })
    }
  }
  return { removed, skipped, planHash: actualHash, executedAt: new Date().toISOString() }
}
