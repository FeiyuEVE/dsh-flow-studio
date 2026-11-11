/**
 * 工作区策略（0.13.7 C）：把「用户给的一个路径」收敛成**确定的工作区记录**。
 *
 * 只回答四件事：
 *   1. 路径是否存在、是否目录、真实路径是什么（符号链接归一）；
 *   2. 是否在宿主允许的根（allowlist）里；
 *   3. 是不是 Git 仓库根；linked worktree 归一到主仓库；
 *   4. 稳定的 `workspaceId` —— 同一主仓库（含 linked worktree、不同克隆路径但同一
 *      upstream remote）得到同一个 id，worktree 目录布局因此不会漂移。
 *
 * 错误码是确定性的（{@link WORKSPACE_ERROR}），调用方按 code 分流，不用解析中文：
 *   - `WORKSPACE_MISSING`：路径不存在 / 不是目录；
 *   - `WORKSPACE_NOT_ALLOWED`：落在宿主 allowlist 之外；
 *   - `WORKSPACE_NOT_GIT`：需要 Git 但不是仓库根（含子目录、空目录）；
 *   - `WORKSPACE_GIT_UNAVAILABLE`：git 可执行文件缺失 / 超时；
 *   - `WORKSPACE_GIT_FAILED`：git 失败但不是「不是仓库」这类可解释原因；
 *   - `WORKSPACE_CWD_OUTSIDE`：worktree 模式下节点 cwd 越界。
 *
 * 本模块**不**创建 / 删除 worktree（那是 `instance-worktree.js`），也不 import 旧
 * 运行域的 `worktree.js`。
 *
 * @module @feiyueve/dsh-flow-studio/workspace-policy
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** 稳定错误码（对外契约）。 */
export const WORKSPACE_ERROR = Object.freeze({
  INVALID: 'WORKSPACE_INVALID',
  MISSING: 'WORKSPACE_MISSING',
  NOT_ALLOWED: 'WORKSPACE_NOT_ALLOWED',
  NOT_GIT: 'WORKSPACE_NOT_GIT',
  GIT_UNAVAILABLE: 'WORKSPACE_GIT_UNAVAILABLE',
  GIT_FAILED: 'WORKSPACE_GIT_FAILED',
  CWD_OUTSIDE: 'WORKSPACE_CWD_OUTSIDE',
  UNAVAILABLE: 'WORKSPACE_UNAVAILABLE',
  CORRUPT: 'WORKSPACE_CORRUPT',
})

/** workspaceId：12 位小写 hex（sha256(identity) 前缀）。 */
export const WORKSPACE_ID_PATTERN = /^[0-9a-f]{12}$/
/** 宿主 allowlist 环境变量（与旧域同名，便于运维只配一处）。 */
export const WORKSPACE_ALLOWLIST_ENV = 'FLOW_STUDIO_WORKSPACE_ROOTS'

const GIT_TIMEOUT_MS = 15 * 1000
const GIT_MAX_BUFFER = 4 * 1024 * 1024
const NOT_A_REPO_HINT = /not a git repository|not a work tree|does not exist/i

/** 带 code 的确定性错误。 */
export class WorkspacePolicyError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'WorkspacePolicyError'
    this.code = code
    Object.assign(this, extra)
  }
}

function fail(code, message, extra) {
  return new WorkspacePolicyError(code, message, extra)
}

function textOf(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

function summary(text, max = 300) {
  const raw = typeof text === 'string' ? text.trim() : ''
  return raw.length <= max ? raw : raw.slice(0, max)
}

/** 默认 git runner：`execFile('git', argv, { cwd })`。 */
export function defaultGitRunner(argv, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== 'string')) {
      rejectRun(fail(WORKSPACE_ERROR.INVALID, 'runner(argv) 需要非空字符串数组'))
      return
    }
    execFile('git', argv, {
      cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolveRun({ stdout: textOf(stdout), stderr: textOf(stderr), code: 0 })
        return
      }
      const wrapped = new Error(`git ${argv.join(' ')} 执行失败`)
      wrapped.name = 'GitRunError'
      wrapped.code = typeof error.code === 'string' ? error.code : 'GIT_EXIT'
      wrapped.status = typeof error.code === 'number' ? error.code : null
      wrapped.stdout = textOf(stdout)
      wrapped.stderr = textOf(stderr)
      wrapped.signal = error.signal ?? null
      wrapped.killed = error.killed === true
      wrapped.cause = error
      rejectRun(wrapped)
    })
  })
}

/**
 * 调一次 git，不抛：统一成 `{ ok, stdout, stderr, exitCode }`。
 * `exitCode === null` 表示 git 根本没跑起来（ENOENT / 超时）。
 */
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

/** 路径归一到 realpath；不存在时退回词法 resolve。 */
export function canonicalPath(target) {
  try {
    return realpathSync(target)
  } catch {
    return resolve(target)
  }
}

/** target 是否落在 root 之内（含 root 自身）。 */
export function isPathInside(root, target) {
  const rel = relative(canonicalPath(root), canonicalPath(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * allowlist 归一：null / 空数组 = 不限制；字符串按 `path.delimiter`（POSIX `:`）拆。
 * 非绝对路径条目忽略（与旧域 env 解析同口径：错配不升级成「全部允许」）。
 *
 * @param {string[]|string|{roots?:string[]}|null|undefined} allowlist
 * @returns {string[]} 绝对路径根（去重）
 */
export function normalizeAllowlist(allowlist) {
  const raw = []
  if (typeof allowlist === 'string') {
    const delimiter = process.platform === 'win32' ? ';' : ':'
    raw.push(...allowlist.split(delimiter))
  } else if (Array.isArray(allowlist)) {
    raw.push(...allowlist)
  } else if (allowlist && typeof allowlist === 'object' && Array.isArray(allowlist.roots)) {
    raw.push(...allowlist.roots)
  }
  const roots = []
  const seen = new Set()
  for (const entry of raw) {
    const text = typeof entry === 'string' ? entry.trim() : ''
    if (text === '' || !isAbsolute(text)) continue
    const canonical = canonicalPath(text)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    roots.push(canonical)
  }
  return roots
}

function assertAllowed(targetReal, allowlist) {
  const roots = Array.isArray(allowlist) ? allowlist : normalizeAllowlist(allowlist)
  if (roots.length === 0) return
  if (roots.some(root => isPathInside(root, targetReal))) return
  throw fail(
    WORKSPACE_ERROR.NOT_ALLOWED,
    `工作区不在宿主允许的根内：${targetReal}（allowlist：${roots.join('、')}）`,
    { path: targetReal, allowlist: roots },
  )
}

/**
 * Git URL 归一：去凭据、scheme、末尾斜杠与 `.git`，把 SCP 形式
 * `git@host:path` 折成 `host/path`，这样同一仓库的 ssh / https 地址得到同一身份。
 */
export function normalizeGitUrl(raw) {
  let text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return ''
  text = text.replace(/^([a-z+.-]+:\/\/)[^@/]+@/i, '$1')
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(text)
  if (scp !== null) text = `${scp[1]}/${scp[2]}`
  else text = text.replace(/^[a-z+.-]+:\/\//i, '')
  text = text.replace(/\/+$/, '')
  text = text.replace(/\.git$/i, '')
  const host = /^([^/\s]+)\/(.*)$/.exec(text)
  if (host !== null) text = `${host[1].toLowerCase()}/${host[2]}`
  return text
}

/** sha256(identity) 前 12 位 hex；纯函数。 */
export function workspaceIdForIdentity(identity) {
  const text = typeof identity === 'string' ? identity.trim() : ''
  if (text === '') throw fail(WORKSPACE_ERROR.INVALID, 'workspaceIdForIdentity 需要非空 identity')
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
}

/**
 * 解析工作区。
 *
 * @param {{
 *   cwd?: string,
 *   path?: string,
 *   allowlist?: string[]|string|{roots?:string[]}|null,
 *   requireGit?: boolean,
 *   runner?: Function,
 * }} [options]
 * @returns {Promise<{
 *   workspaceId: string, id: string, path: string, realpath: string,
 *   isGit: boolean, gitRoot: string|null, repositoryRoot: string|null,
 *   isLinkedWorktree: boolean, identity: string, identityKind: 'remote'|'path',
 * }>}
 */
export async function resolveWorkspace(options = {}) {
  if (!options || typeof options !== 'object') {
    throw fail(WORKSPACE_ERROR.INVALID, 'resolveWorkspace 需要对象参数')
  }
  const runner = typeof options.runner === 'function' ? options.runner : defaultGitRunner
  const raw = options.path === undefined || options.path === null ? options.cwd : options.path
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw fail(WORKSPACE_ERROR.MISSING, 'resolveWorkspace 需要 path 或 cwd')
  }
  const base = typeof options.cwd === 'string' && options.cwd.trim() !== ''
    ? resolve(options.cwd.trim())
    : process.cwd()
  const absolute = isAbsolute(raw.trim()) ? resolve(raw.trim()) : resolve(base, raw.trim())

  let realpath
  try {
    if (!statSync(absolute).isDirectory()) {
      throw fail(WORKSPACE_ERROR.MISSING, `工作区不存在或不是目录：${absolute}`)
    }
    realpath = realpathSync(absolute)
  } catch (error) {
    if (error instanceof WorkspacePolicyError) throw error
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw fail(WORKSPACE_ERROR.MISSING, `工作区不存在：${absolute}`, { path: absolute })
    }
    throw error
  }

  const allowlist = normalizeAllowlist(options.allowlist)
  assertAllowed(realpath, allowlist)

  const top = await callGit(runner, ['-C', realpath, 'rev-parse', '--show-toplevel'], realpath)
  if (!top.ok && top.exitCode === null) {
    throw fail(
      WORKSPACE_ERROR.GIT_UNAVAILABLE,
      `无法执行 git 解析工作区：${summary(top.stderr || top.error?.message) || '未知错误'}`,
      { path: realpath },
    )
  }
  let isGit = false
  let gitRoot = null
  if (top.ok) {
    const rawTop = top.stdout.trim()
    if (rawTop !== '') {
      const topAbsolute = isAbsolute(rawTop) ? resolve(rawTop) : resolve(realpath, rawTop)
      gitRoot = canonicalPath(topAbsolute)
      isGit = gitRoot === realpath
    }
  } else {
    const detail = summary(top.stderr || top.stdout)
    if (!NOT_A_REPO_HINT.test(detail)) {
      throw fail(
        WORKSPACE_ERROR.GIT_FAILED,
        `git 无法解析工作区（${realpath}）：${detail || `退出码 ${top.exitCode}`}`,
        { path: realpath, exitCode: top.exitCode },
      )
    }
  }

  if (options.requireGit === true && !isGit) {
    const reason = gitRoot !== null ? 'subdirectory' : 'not-a-repo'
    throw fail(
      WORKSPACE_ERROR.NOT_GIT,
      reason === 'subdirectory'
        ? `工作区是 Git 仓库的子目录（仓库根：${gitRoot}）：${realpath}`
        : `工作区不是 Git 仓库根：${realpath}`,
      { path: realpath, reason, gitRoot },
    )
  }

  let repositoryRoot = isGit ? realpath : null
  let isLinkedWorktree = false
  if (isGit) {
    const dirs = await callGit(runner, ['-C', realpath, 'rev-parse', '--git-dir', '--git-common-dir'], realpath)
    if (dirs.ok) {
      const lines = dirs.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
      if (lines.length >= 2) {
        const gitDir = canonicalPath(isAbsolute(lines[0]) ? lines[0] : resolve(realpath, lines[0]))
        const commonDir = canonicalPath(isAbsolute(lines[1]) ? lines[1] : resolve(realpath, lines[1]))
        if (gitDir !== commonDir && commonDir !== '') {
          // linked worktree：主仓库根 = common dir 的父级（`.git` 的上一级）。
          const mainRoot = resolve(commonDir, '..')
          repositoryRoot = canonicalPath(mainRoot)
          isLinkedWorktree = true
        }
      }
    }
  }

  let identityKind = 'path'
  let identity = `path:${repositoryRoot ?? realpath}`
  if (repositoryRoot !== null) {
    const remote = await callGit(runner, ['-C', realpath, 'remote', 'get-url', 'origin'], realpath)
    const url = remote.ok ? normalizeGitUrl(remote.stdout.trim()) : ''
    if (url !== '') {
      identityKind = 'remote'
      identity = `remote:${url}`
    }
  }
  const workspaceId = workspaceIdForIdentity(identity)
  return {
    workspaceId,
    id: workspaceId,
    path: absolute,
    realpath,
    isGit,
    gitRoot,
    repositoryRoot,
    isLinkedWorktree,
    identity,
    identityKind,
  }
}

/**
 * 节点 cwd → 绝对路径（worktree 模式只允许树内相对子目录）。
 *
 * @param {{
 *   workspace: {effectiveRoot: string, mode?: string, realpath?: string},
 *   cwd?: string,
 * }} input
 * @returns {string}
 */
export function resolveNodeCwd({ workspace, cwd } = {}) {
  if (!workspace || typeof workspace !== 'object') {
    throw fail(WORKSPACE_ERROR.INVALID, 'resolveNodeCwd 需要已解析的工作区记录')
  }
  const root = typeof workspace.effectiveRoot === 'string' && workspace.effectiveRoot !== ''
    ? resolve(workspace.effectiveRoot)
    : ''
  if (root === '') {
    throw fail(WORKSPACE_ERROR.UNAVAILABLE, '工作区记录缺少 effectiveRoot')
  }
  if (!existsSync(root)) {
    throw fail(WORKSPACE_ERROR.UNAVAILABLE, `工作区目录不存在：${root}`, { path: root })
  }
  const inWorktree = workspace.mode === 'worktree' || workspace.isWorktree === true
  const raw = typeof cwd === 'string' ? cwd.trim() : ''
  let target
  if (raw === '') {
    target = root
  } else if (isAbsolute(raw)) {
    if (inWorktree) {
      throw fail(
        WORKSPACE_ERROR.CWD_OUTSIDE,
        `worktree 模式下节点 cwd 只允许树内相对子目录：${raw}`,
        { path: raw, root },
      )
    }
    target = resolve(raw)
  } else {
    target = resolve(root, raw)
  }
  // 非 worktree 模式保持旧 `fs:executor@cwd` 语义：绝对路径直接使用，不做树内约束。
  if (!inWorktree) return target
  const rel = relative(root, target)
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw fail(
      WORKSPACE_ERROR.CWD_OUTSIDE,
      `节点 cwd 越出工作区：${raw}（根：${root}）`,
      { path: target, root },
    )
  }
  // realpath 越界（符号链接逃逸）同样拒绝；目标尚不存在时只做词法校验，
  // 由 finish gate 在登记文档时再按真实路径兜一次。
  if (existsSync(target)) {
    const realTarget = canonicalPath(target)
    const realRoot = canonicalPath(root)
    if (!isPathInside(realRoot, realTarget)) {
      throw fail(
        WORKSPACE_ERROR.CWD_OUTSIDE,
        `节点 cwd 的真实路径越出工作区（符号链接逃逸）：${realTarget}`,
        { path: realTarget, root: realRoot },
      )
    }
  }
  return target
}
