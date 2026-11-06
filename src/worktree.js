/**
 * 工作区解析与 worktree 生命周期（07 §4 / §8）：worktree 该不该建、建在哪、
 * 建完怎么查、删之前怎么校验、残留怎么自愈，全部收在这一个模块里，由
 * 「发起 run 的一侧」在 `start()` 之前当场决策，而不是让第一个节点自己判断。
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
 * GIT_UNAVAILABLE / GIT_FAILED / WORKTREE_POLICY_INVALID / WORKTREE_UNAVAILABLE /
 * WORKTREE_INVALID / RUN_ID_INVALID / WORKTREE_CREATE_FAILED /
 * WORKTREE_PATH_UNSAFE / WORKTREE_REMOVE_FAILED），消息是给人看的中文。
 *
 * 「为什么失败」不靠猜：可恢复的建/删失败都额外带 `reason`
 * （not-a-repo / subdirectory / git-unavailable / empty-repo / path-exists /
 * registered-elsewhere / locked / create-failed / dirty / still-registered），
 * 调用方（engine / tools）把它写进 `run.json.worktree.reason` 与日志，界面才能
 * 给出可读原因，而不是一句「不是 git 仓库」。
 *
 * 布局（07 §4.2）：`<root>/<workspaceId>/<runId>`；分支 `<branchPrefix><runId>`
 * （真正被别的分支占用时 `-2`、`-3`…）；base 取 workspace 的 HEAD 并记进
 * baseCommit。空仓库（没有任何 commit）用 `git worktree add --orphan -b` 建，
 * baseCommit 记 `null`，不假装有 base。
 *
 * 残留在**创建前**自愈：目标路径存在 / 被 git 登记 / 被 lock / 上次失败留下的
 * 半成品，先 `git worktree remove --force --force` 再 `git worktree prune`；
 * 失败的 add 会回滚刚建的分支，重复失败不会累积 `flow/<runId>-N`。
 *
 * 收尾不自动删（保留产物）；删除只走 {@link removeWorktree}（先过路径校验，再按需要
 * `--force` / `--force --force`，删完回查 `git worktree list`，最后删掉
 * `record.branch` 对应的 `<branchPrefix>` 分支）。生命周期查询与孤儿回收走
 * {@link listWorktrees} / {@link pruneWorktrees}——它们只按本地目录判断，工作区
 * （主仓库）已经删掉时也不会抛错；prune 连孤儿条目检出的分支一起回收，分支删除
 * 失败或无法定位主仓库时目录照删，并把该条目记进 `skipped`（不抛错）。
 * 目录已被手动删掉、只剩分支时，用 {@link removeRunBranch} 单独补一刀（不改
 * removeWorktree 的 `not-found` 返回契约）。
 *
 * @module @feiyueve/dsh-flow-studio/worktree
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync,
  statSync, unlinkSync,
} from 'node:fs'
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
/** 「不是 git 仓库」的 stderr 特征（中英双语：宿主 locale 可能是 zh_CN）。 */
const NOT_A_REPO_HINT = /not a git repository|不是 git 仓库|not a git repo/i
/** 「目标路径已被某个 worktree 占用」的特征（自愈时的兜底分类）。 */
const ALREADY_EXISTS_HINT = /already exists|已经存在|已存在/i
/** 「该分支已被别的 worktree 使用」的特征。 */
const BRANCH_IN_USE_HINT = /already (?:registered|used)|已被工作区|已经被工作区|正在被工作区/i
/** 未跟踪的敏感文件：只告警，不复制（复制 node_modules / .env 是另一种错误）。 */
const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^\.credentials(\.ya?ml)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|secret|keystore)$/i,
]
/** warning 里一次列出的敏感文件上限（其余用「等 N 个」概括）。 */
const WARNING_LIST_LIMIT = 5

/** 构造带 code 的错误；extra 上的字段（如 stderr / reason）原样挂上去。 */
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

/** lstat 的容错版：不存在 / 权限问题都返回 null（诊断不抛错）。 */
function lstatSafe(target) {
  try {
    return lstatSync(target)
  } catch {
    return null
  }
}

/** 路径归一：存在就跟到真实路径，不存在就退回词法 resolve。 */
function canonicalPath(target) {
  try {
    return realpathSync(target)
  } catch {
    return resolve(target)
  }
}

/** 两个路径是否指向同一个本地位置（符号链接化简后比较）。 */
function samePath(left, right) {
  return canonicalPath(left) === canonicalPath(right)
}

/** 从 git 输出里拆「仓库相对路径」：可能是相对 cwd 的，按 base 解析。 */
function gitPathFrom(base, value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return ''
  return isAbsolute(raw) ? raw : resolve(base, raw)
}

/** `refs/heads/flow/x` → `flow/x`；其它 ref（tag / 远端）原样返回。 */
function normalizeBranchRef(ref) {
  if (typeof ref !== 'string' || ref === '') return null
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

/** 转义正则元字符（分支名里可能出现点、斜杠等）。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

/** root 入参归一：必须是非空字符串；相对路径按 process.cwd() 解析。 */
function resolveRootArg(root) {
  if (typeof root !== 'string' || root === '') {
    throw fail('WORKTREE_INVALID', '需要一个非空字符串 root（worktrees 根目录）')
  }
  return isAbsolute(root) ? resolve(root) : resolve(process.cwd(), root)
}

/**
 * 解析工作区：绝对路径 → realpath → 判断它是不是 git 仓库根。
 *
 * - 路径不存在 / 不是目录 → 抛 `{ code:'WORKSPACE_NOT_FOUND' }`；
 * - `git -C <path> rev-parse --show-toplevel` 成功且结果就是它自己 → `isGit:true`；
 *   成功但结果是上层目录（子目录）→ `isGit:false` 并保留 `gitRoot`；
 *   非 0 退出且 stderr 是「不是 git 仓库」→ `isGit:false, gitRoot:null`；
 *   非 0 退出的**其它**原因（权限 / dubious ownership…）→ 抛 `{ code:'GIT_FAILED' }`，
 *   不再一律伪装成「不是 git 仓库」；
 * - git 根本起不来（ENOENT / 超时）→ 抛 `{ code:'GIT_UNAVAILABLE' }`，不静默降级。
 *
 * 工作区本身是一个 **linked worktree**（`git worktree add` 出来、从里面再开 run）时，
 * `id` 取主仓库（common dir 的父级）的 id：同一个仓库不论从主检出还是它的 worktree
 * 发起，worktree 布局都落在同一个 `<root>/<workspaceId>/` 下，不在磁盘上漂移。
 * `path` / `realpath` / `gitRoot` 仍如实保留调用方给的那份路径。
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
    throw fail('GIT_UNAVAILABLE', `无法执行 git：${summarize(collectText(probe)) || '未知错误'}`, {
      stderr: summarize(collectText(probe)),
    })
  }
  if (!probe.ok) {
    const detail = summarize(collectText(probe))
    // 只有「不是 git 仓库」才降级成 isGit:false；权限 / 仓库损坏等是另一回事。
    if (!NOT_A_REPO_HINT.test(detail)) {
      throw fail('GIT_FAILED', `git 无法解析工作区（${absolute}）：${detail || `退出码 ${probe.exitCode}`}`, {
        stderr: detail,
        exitCode: probe.exitCode,
      })
    }
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

  let id = workspaceIdFor(realpath)
  if (isGit) {
    // linked worktree 识别：git-dir ≠ common-dir 就说明这是主仓库的 worktree。
    const dirs = await callGit(git, ['-C', realpath, 'rev-parse', '--git-dir', '--git-common-dir'], realpath)
    if (dirs.ok) {
      const lines = dirs.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
      if (lines.length >= 2) {
        const gitDir = canonicalPath(gitPathFrom(realpath, lines[0]))
        const commonDir = canonicalPath(gitPathFrom(realpath, lines[1]))
        if (gitDir !== commonDir && commonDir !== '') {
          const mainRoot = dirname(commonDir)
          try {
            id = workspaceIdFor(realpathSync(mainRoot))
          } catch {
            id = workspaceIdFor(mainRoot)
          }
        }
      }
    } else if (dirs.exitCode === null) {
      // 第一次探测已经证明 git 可用；这一次失败（极罕见）不升级成 GIT_UNAVAILABLE。
    }
  }

  return { id, path: absolute, realpath, isGit, gitRoot }
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
        { reason: typeof workspace.gitRoot === 'string' && workspace.gitRoot !== '' ? 'subdirectory' : 'not-a-repo' },
      )
    }
    return { enabled: false, reason: 'not-a-git-repo' }
  }
  return { enabled: true, reason: 'git-workspace' }
}

/**
 * 解析 `git worktree list --porcelain` 的输出。
 * @param {string} text
 * @returns {{ path:string, head:string|null, branch:string|null, detached:boolean,
 *   bare:boolean, locked:boolean, lockReason:string|null, prunable:boolean }[]}
 */
function parseWorktreeList(text) {
  const entries = []
  let current = null
  const flush = () => {
    if (current && current.path !== '') entries.push(current)
    current = null
  }
  const lines = typeof text === 'string' ? text.split('\n') : []
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim() === '') {
      flush()
      continue
    }
    if (current === null) {
      current = {
        path: '', head: null, branch: null, detached: false, bare: false,
        locked: false, lockReason: null, prunable: false,
      }
    }
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    if (key === 'worktree') current.path = value
    else if (key === 'HEAD') current.head = value === '0000000000000000000000000000000000000000' ? null : value
    else if (key === 'branch') current.branch = value
    else if (key === 'detached') current.detached = true
    else if (key === 'bare') current.bare = true
    else if (key === 'locked') {
      current.locked = true
      current.lockReason = value === '' ? null : value
    } else if (key === 'prunable') {
      current.prunable = true
    }
  }
  flush()
  return entries
}

/**
 * 列出某个仓库登记的全部 worktree。
 * @returns {Promise<{ ok:boolean, entries:object[], exitCode:number|null, detail:string }>}
 */
async function listRepoWorktrees(git, repo) {
  const probe = await callGit(git, ['-C', repo, 'worktree', 'list', '--porcelain'], repo)
  if (!probe.ok) {
    return {
      ok: false,
      entries: [],
      exitCode: probe.exitCode,
      detail: summarize(collectText(probe)),
    }
  }
  return { ok: true, entries: parseWorktreeList(probe.stdout), exitCode: 0, detail: '' }
}

/** 仓库的 common dir（linked worktree 也指回主仓库的 `.git`）。 */
async function repoCommonDir(git, repo) {
  const probe = await callGit(git, ['-C', repo, 'rev-parse', '--git-common-dir'], repo)
  if (!probe.ok) return { ok: false, path: '', exitCode: probe.exitCode }
  const raw = probe.stdout.trim()
  if (raw === '') return { ok: false, path: '', exitCode: probe.exitCode }
  return { ok: true, path: canonicalPath(gitPathFrom(repo, raw)), exitCode: 0 }
}

/** 某条路径上已有的 git 产物是什么（自愈前先弄清楚，别误删别人的东西）。 */
async function inspectTargetOwner(git, repo, target) {
  const stat = lstatSafe(target)
  if (!stat) return { kind: 'missing' }
  if (stat.isSymbolicLink()) return { kind: 'symlink' }
  if (!stat.isDirectory()) return { kind: 'plain' }
  const dotGit = join(target, '.git')
  const marker = lstatSafe(dotGit)
  if (!marker) return { kind: 'plain' }
  if (marker.isDirectory()) return { kind: 'nested' }
  if (!marker.isFile()) return { kind: 'plain' }
  let content = ''
  try {
    content = readFileSync(dotGit, 'utf8')
  } catch {
    return { kind: 'plain' }
  }
  const match = content.match(/^gitdir:\s*(.+)$/m)
  if (!match) return { kind: 'plain' }
  const gitdir = canonicalPath(gitPathFrom(target, match[1].trim()))
  const common = await repoCommonDir(git, repo)
  if (!common.ok) return { kind: 'foreign', gitdir }
  const adminDir = join(common.path, 'worktrees')
  if (gitdir === adminDir || gitdir.startsWith(adminDir + sep)) return { kind: 'ours-stale', gitdir }
  return { kind: 'foreign', gitdir }
}

/** 分支名是不是这个 run 自己的（`flow/<runId>` 或 `flow/<runId>-N`）。 */
function isOwnBranch(branch, branchPrefix, runId) {
  if (typeof branch !== 'string' || branch === '') return false
  const base = `${branchPrefix}${runId}`
  if (branch === base) return true
  return new RegExp(`^${escapeRegExp(base)}-\\d+$`).test(branch)
}

/** 删一条分支：普通分支用 `branch -D`，未出生分支用 `update-ref -d` 兜底。 */
async function deleteBranch(git, repo, branch) {
  const del = await callGit(git, ['-C', repo, 'branch', '-D', branch], repo)
  if (del.ok) return true
  const unref = await callGit(git, ['-C', repo, 'update-ref', '-d', `refs/heads/${branch}`], repo)
  return unref.ok
}

/**
 * 分支删除的前置闸门：只删本流程前缀（默认 `flow/`）下的合法 ref。
 *
 * 这一步是「别删用户分支」的红线：`record.branch` / worktree 当前分支都来自
 * 磁盘上的记录，名字不可信；不以 `<branchPrefix>` 开头的一律拒绝。
 *
 * @returns {{ ok:boolean, warning?:string }}
 */
function branchDeletionGuard(branch, branchPrefix) {
  if (typeof branch !== 'string' || branch === '') {
    return { ok: false, warning: '没有可删除的分支名（记录/目录里读不到 branch），跳过分支删除' }
  }
  if (!isValidRefName(branch)) {
    return { ok: false, warning: `分支名 ${branch} 不是合法 git ref，拒绝删除` }
  }
  if (!branch.startsWith(branchPrefix)) {
    return {
      ok: false,
      warning: `分支 ${branch} 不以 ${branchPrefix} 开头，拒绝删除（只删本流程创建的分支）`,
    }
  }
  return { ok: true }
}

/**
 * 删分支并把结果讲清楚（删不掉不算失败：worktree 已经删了）。
 *
 * - 分支不存在 → `{ removed:false, warning }`（不是错误）；
 * - `branch -D` 失败 / 删后 ref 仍在 → `{ removed:false, warning: 原始 stderr }`；
 * - 删成功 → `{ removed:true }`。
 */
async function tryDeleteBranch(git, repo, branch) {
  const before = await callGit(
    git,
    ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    repo,
  )
  if (!before.ok) {
    if (before.exitCode === null) {
      return { removed: false, warning: `git 不可用，分支 ${branch} 未删除` }
    }
    return { removed: false, warning: `分支 ${branch} 不存在，未删除（worktree 已删，不影响结果）` }
  }
  const del = await callGit(git, ['-C', repo, 'branch', '-D', branch], repo)
  const after = await callGit(
    git,
    ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    repo,
  )
  if (!after.ok && after.exitCode !== null) return { removed: true }
  const detail = summarize(collectText(del) || collectText(after))
  return { removed: false, warning: `分支 ${branch} 删除失败：${detail || '未知错误'}` }
}

/**
 * 读一个 worktree 目录当前检出的分支名（prune 在删目录**之前**调用）。
 * 目录不是 git worktree / 主仓库已删 / detached HEAD → 拿不到可删分支。
 */
async function readWorktreeBranch(git, target) {
  const symbolic = await callGit(
    git,
    ['-C', target, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
    target,
  )
  if (symbolic.ok) {
    const name = symbolic.stdout.trim()
    if (name !== '') return { ok: true, branch: name }
  }
  const rev = await callGit(git, ['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'], target)
  if (rev.ok) {
    const name = rev.stdout.trim()
    if (name !== '' && name !== 'HEAD') return { ok: true, branch: name }
    return { ok: true, branch: null }
  }
  return {
    ok: false,
    branch: null,
    warning: '无法读取该目录的分支名（目录不是 git worktree，或主仓库已删除）',
  }
}

/**
 * 创建前自愈：目标路径上的残留（目录 / 被 git 登记的 worktree / locked /
 * 半成品）先安全清掉，再交给 `git worktree add`。
 *
 * 拒绝自动删的两种情况（返回 `registered-elsewhere`，绝不静默）：
 *   1. 目标路径里是一个**别的仓库**的 linked worktree（`.git` 的 gitdir 不在本仓库
 *      `<common>/worktrees/` 下）；
 *   2. 目标路径里是一个**独立仓库**（`.git` 是目录）。
 */
async function healResidualWorktree({ git, repo, targetPath, branchPrefix, runId, warnings }) {
  const exists = lstatSafe(targetPath) !== null
  const listing = await listRepoWorktrees(git, repo)
  if (!listing.ok && listing.exitCode === null) {
    throw fail('WORKTREE_CREATE_FAILED', `无法列出 worktree（git 不可用）：${listing.detail || '未知错误'}`, {
      reason: 'git-unavailable',
      stderr: listing.detail,
    })
  }
  const registered = listing.ok
    ? listing.entries.find(entry => samePath(entry.path, targetPath)) || null
    : null
  if (!exists && !registered) return

  // 目标路径上的东西不是「我们这棵仓库树的 worktree」时，不删。
  if (exists && !registered) {
    const owner = await inspectTargetOwner(git, repo, targetPath)
    if (owner.kind === 'foreign' || owner.kind === 'nested') {
      throw fail(
        'WORKTREE_CREATE_FAILED',
        `目标路径已存在且不属于本仓库的 worktree（registered-elsewhere）：${targetPath}`,
        { reason: 'registered-elsewhere', path: targetPath },
      )
    }
    if (owner.kind === 'symlink') {
      // 只是一个符号链接：删链接本身，不跟进去。
      try {
        unlinkSync(targetPath)
      } catch (error) {
        throw fail('WORKTREE_CREATE_FAILED', `目标路径是一个删不掉的符号链接（path-exists）：${error.message}`, {
          reason: 'path-exists',
          path: targetPath,
        })
      }
      warnings.push(`目标路径上的残留符号链接已被清理：${targetPath}`)
    }
  }

  if (registered) {
    // `--force --force` 能一并覆盖 locked / 脏 worktree（07 §4.2 审计结论）。
    const remove = await callGit(
      git,
      ['-C', repo, 'worktree', 'remove', '--force', '--force', targetPath],
      repo,
    )
    if (!remove.ok) {
      const detail = summarize(collectText(remove))
      const reason = registered.locked ? 'locked' : 'path-exists'
      throw fail(
        'WORKTREE_CREATE_FAILED',
        `目标路径已被 git 登记且清理失败（${reason}）：${detail || '未知错误'}`,
        { reason, path: targetPath, stderr: detail, branch: normalizeBranchRef(registered.branch) },
      )
    }
    const branchName = normalizeBranchRef(registered.branch)
    if (branchName && isOwnBranch(branchName, branchPrefix, runId)) {
      if (await deleteBranch(git, repo, branchName)) {
        warnings.push(`清理了上次残留的分支 ${branchName}（其中的提交/修改未保留）`)
      }
    } else if (branchName) {
      warnings.push(`目标路径原有 worktree 使用的分支 ${branchName} 不属于本 run，已保留该分支`)
    }
    warnings.push(`目标路径上的残留 worktree 已清理：${targetPath}`)
  } else if (exists) {
    try {
      rmSync(targetPath, { recursive: true, force: true })
    } catch (error) {
      const detail = summarize(error && error.message)
      throw fail('WORKTREE_CREATE_FAILED', `目标路径已被占用且清理失败（path-exists）：${detail || '未知错误'}`, {
        reason: 'path-exists',
        path: targetPath,
        stderr: detail,
      })
    }
    warnings.push(`目标路径上的残留目录/文件已清理：${targetPath}`)
  }

  await callGit(git, ['-C', repo, 'worktree', 'prune', '--expire', 'now'], repo)
  if (existsSync(targetPath)) {
    throw fail('WORKTREE_CREATE_FAILED', `目标路径清理后仍然存在（path-exists）：${targetPath}`, {
      reason: 'path-exists',
      path: targetPath,
    })
  }
  if (listing.ok) {
    const after = await listRepoWorktrees(git, repo)
    const leftover = after.ok
      ? after.entries.find(entry => samePath(entry.path, targetPath))
      : null
    if (leftover) {
      throw fail('WORKTREE_CREATE_FAILED', `目标路径仍被 git 登记（registered-elsewhere）：${targetPath}`, {
        reason: 'registered-elsewhere',
        path: targetPath,
      })
    }
  }
}

/**
 * add 失败后的回滚：删掉本次刚建的分支 + 清掉本次 add 留下的半成品目录，
 * 保证「5 次失败 → 不留 5 个 `flow/<runId>-N`」。
 */
async function rollbackWorktreeAttempt({ git, repo, targetPath, branch, baseCommit }) {
  try {
    const listing = await listRepoWorktrees(git, repo)
    if (listing.ok) {
      const entry = listing.entries.find(item => samePath(item.path, targetPath))
      if (entry && normalizeBranchRef(entry.branch) === branch) {
        await callGit(git, ['-C', repo, 'worktree', 'remove', '--force', '--force', targetPath], repo)
      }
    }
    if (baseCommit) {
      // 只有「分支仍停在 baseCommit」才敢删：那一定是本次 `-B` 建的。
      const tip = await callGit(
        git,
        ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        repo,
      )
      if (tip.ok && tip.stdout.trim() === baseCommit) {
        await deleteBranch(git, repo, branch)
      }
    } else {
      // 空仓库：分支还没有 commit，`branch -D` 删不掉，用 update-ref 兜底。
      await deleteBranch(git, repo, branch)
    }
    await callGit(git, ['-C', repo, 'worktree', 'prune', '--expire', 'now'], repo)
    if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true })
  } catch {
    // 回滚失败不掩盖原始错误：调用方拿到的是 add 的真实失败原因。
  }
}

/** 分支名已经被占用时依次试 `-2`、`-3`…（与历史契约一致）。 */
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
        reason: 'git-unavailable',
        stderr: summarize(collectText(probe)),
      })
    }
    return branch
  }
  throw fail(
    'WORKTREE_CREATE_FAILED',
    `分支名连续 ${MAX_BRANCH_ATTEMPTS} 个都被占用：${baseBranch}`,
    { reason: 'create-failed' },
  )
}

/**
 * 读 base 提交；空仓库（没有任何 commit）返回 `{ commit:null, empty:true }`。
 *
 * 只把「HEAD 本身不可解析 + HEAD 是 symbolic ref」判成空仓库：这样
 * `baseRef` 写错（仓库其实有提交）仍按 create-failed 报错，不会被误判。
 */
async function readBaseInfo(git, repo, baseRef) {
  const probe = await callGit(git, ['-C', repo, 'rev-parse', baseRef], repo)
  if (probe.ok) {
    const commit = probe.stdout.trim().split(/\s+/)[0]
    if (commit) return { commit, empty: false }
  }
  if (probe.exitCode === null) {
    const detail = summarize(collectText(probe))
    throw fail('WORKTREE_CREATE_FAILED', `读取 baseCommit 失败（${baseRef}）：${detail || 'git 不可用'}`, {
      reason: 'git-unavailable',
      stderr: detail,
    })
  }

  const head = await callGit(git, ['-C', repo, 'rev-parse', '--verify', '--quiet', 'HEAD'], repo)
  if (!head.ok && head.exitCode !== null) {
    const symbolic = await callGit(git, ['-C', repo, 'symbolic-ref', '--quiet', 'HEAD'], repo)
    if (symbolic.ok) return { commit: null, empty: true }
  }

  const detail = summarize(collectText(probe) || collectText(head))
  throw fail('WORKTREE_CREATE_FAILED', `读取 baseCommit 失败（${baseRef}）：${detail || '未知错误'}`, {
    reason: 'create-failed',
    stderr: detail,
  })
}

/**
 * 创建前的「可能丢东西」检查（07 §4.2 审计结论）：只告警，不复制。
 *
 * - 工作区 dirty（含未跟踪）→ 一条说明「worktree 从 base 检出，这些改动不会带过去」；
 * - 未跟踪的 `.env` / `*.key` 等敏感文件 → 点名，避免用户以为隔离副本里有凭据；
 * - 未跟踪的 `node_modules/` → 说明不会复制、需要重装依赖（**不做**复制）。
 *
 * `git status` 本身失败时静默返回（创建不该因为「查不了脏」而失败）。
 */
async function collectWorkspaceWarnings(git, repo, baseRef) {
  const warnings = []
  const probe = await callGit(git, ['-C', repo, 'status', '--porcelain'], repo)
  if (!probe.ok) return warnings
  const lines = probe.stdout.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.trim() !== '')
  if (lines.length === 0) return warnings

  warnings.push(
    `工作区有 ${lines.length} 项未提交修改；worktree 只从 ${baseRef} 检出，这些改动不会带进隔离副本`,
  )
  const untracked = lines.filter(line => line.startsWith('??'))
  const sensitive = []
  let hasNodeModules = false
  for (const line of untracked) {
    const rawPath = line.slice(2).trim().replace(/^"|"$/g, '')
    if (rawPath === '') continue
    const cleaned = rawPath.replace(/\/$/, '')
    const base = cleaned.split('/').pop() || cleaned
    if (base === 'node_modules' || cleaned.endsWith('/node_modules')) {
      hasNodeModules = true
      continue
    }
    if (SENSITIVE_FILE_PATTERNS.some(pattern => pattern.test(base))) sensitive.push(cleaned)
  }
  if (sensitive.length > 0) {
    const shown = sensitive.slice(0, WARNING_LIST_LIMIT).join('、')
    const rest = sensitive.length > WARNING_LIST_LIMIT ? ` 等 ${sensitive.length} 个` : ''
    warnings.push(`未跟踪的敏感文件不会复制进 worktree：${shown}${rest}`)
  }
  if (hasNodeModules) {
    warnings.push('未跟踪的 node_modules 不会复制进 worktree，隔离副本里需要重新安装依赖')
  }
  return warnings
}

/**
 * 建 worktree（07 §4.2）：路径 `<root>/<workspaceId>/<runId>`，分支
 * `<branchPrefix><runId>`（真正被占用时加 `-2`、`-3`…），base 取 `baseRef`
 * （默认 HEAD）。
 *
 * **自愈**：目标路径已存在 / 已被 git 登记 / 被 lock / 上次失败留下的半成品，
 * 先 `worktree remove --force --force`（再 `prune`）清掉；别人的仓库树不删，
 * 抛 `reason:'registered-elsewhere'`。**空仓库**用 `--orphan -b` 建，
 * baseCommit 记 `null`。
 *
 * 成功返回
 * `{ enabled:true, reason:'git-workspace', path, branch, baseCommit, createdAt, root, warnings }`；
 * `warnings` 是创建前检测到的「不会带过去的改动」（dirty / 敏感文件 / node_modules /
 * 清理了残留），由调用方写进 `run/start.data` 与日志。
 *
 * 失败抛 `{ code:'WORKTREE_CREATE_FAILED', reason, stderr }`（`reason` 见模块头），
 * 或 `{ code:'WORKTREE_UNAVAILABLE', reason:'not-a-repo'|'subdirectory' }`。
 *
 * @param {{ workspace:object, runId:string, root:string, branchPrefix?:string,
 *   baseRef?:string, run?:Function }} [options]
 * @returns {Promise<{ enabled:true, reason:string, path:string, branch:string,
 *   baseCommit:string|null, createdAt:string, root:string, warnings:string[] }>}
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
  requireObject(workspace, 'workspace', 'WORKSPACE_INVALID')
  if (workspace.isGit === false) {
    const isSubdir = typeof workspace.gitRoot === 'string' && workspace.gitRoot !== ''
    const reason = isSubdir ? 'subdirectory' : 'not-a-repo'
    const message = isSubdir
      ? `工作区是 git 仓库的子目录（仓库根：${workspace.gitRoot}），请以仓库根为工作区再建 worktree：${info.realpath}`
      : `工作区不是 git 仓库，无法建 worktree：${info.realpath}`
    throw fail('WORKTREE_UNAVAILABLE', message, { reason, path: info.realpath })
  }
  const safeRunId = assertRunId(runId)
  const rootAbsolute = resolveRootArg(root)
  assertBranchPrefix(branchPrefix)
  assertBaseRef(baseRef)

  const branchBase = `${branchPrefix}${safeRunId}`
  if (!isValidRefName(branchBase)) {
    throw fail('WORKTREE_INVALID', `分支名「${branchBase}」不是合法的 git ref`)
  }
  const targetPath = join(rootAbsolute, info.id, safeRunId)

  // 1. 先把「会丢什么」说清楚（只告警，不复制）。
  const warnings = await collectWorkspaceWarnings(git, info.realpath, baseRef)

  // 2. 自愈：清掉目标路径上的残留（含上次失败留下的 worktree / 分支）。
  await healResidualWorktree({
    git,
    repo: info.realpath,
    targetPath,
    branchPrefix,
    runId: safeRunId,
    warnings,
  })

  // 3. 选分支、读 base（空仓库走 --orphan）。
  const branch = await pickBranch(git, info.realpath, branchBase)
  const base = await readBaseInfo(git, info.realpath, baseRef)
  if (base.empty) {
    warnings.push('空仓库（还没有任何提交）：隔离副本建在未出生的分支上，baseCommit 为空')
  }

  try {
    mkdirSync(dirname(targetPath), { recursive: true })
  } catch (error) {
    const detail = summarize(error && error.message)
    throw fail('WORKTREE_CREATE_FAILED', `创建 worktree 父目录失败：${detail || '未知错误'}`, {
      reason: 'create-failed',
      stderr: detail,
      path: targetPath,
      branch,
      baseCommit: base.commit,
    })
  }

  const addArgv = base.empty
    ? ['-C', info.realpath, 'worktree', 'add', '--orphan', '-b', branch, targetPath]
    : ['-C', info.realpath, 'worktree', 'add', '-B', branch, targetPath, base.commit]
  const add = await callGit(git, addArgv, info.realpath)
  if (!add.ok) {
    // 不泄漏分支：本次 `-B`/`--orphan` 刚建的分支与半成品目录一并回滚。
    await rollbackWorktreeAttempt({
      git,
      repo: info.realpath,
      targetPath,
      branch,
      baseCommit: base.commit,
    })
    const detail = summarize(collectText(add))
    if (add.exitCode === null) {
      throw fail('WORKTREE_CREATE_FAILED', `git worktree add 失败（git-unavailable）：${detail || 'git 不可用'}`, {
        reason: 'git-unavailable',
        stderr: detail,
        path: targetPath,
        branch,
        baseCommit: base.commit,
      })
    }
    let reason = 'create-failed'
    if (base.empty) reason = 'empty-repo'
    else if (ALREADY_EXISTS_HINT.test(detail)) reason = 'path-exists'
    else if (BRANCH_IN_USE_HINT.test(detail)) reason = 'registered-elsewhere'
    throw fail('WORKTREE_CREATE_FAILED', `git worktree add 失败（${reason}）：${detail || '未知错误'}`, {
      reason,
      stderr: detail,
      path: targetPath,
      branch,
      baseCommit: base.commit,
    })
  }

  // git 说成功但目录不在：绝不返回「已隔离」。
  if (!existsSync(targetPath)) {
    await rollbackWorktreeAttempt({
      git,
      repo: info.realpath,
      targetPath,
      branch,
      baseCommit: base.commit,
    })
    throw fail('WORKTREE_CREATE_FAILED', `git worktree add 返回成功但目标目录不存在（create-failed）：${targetPath}`, {
      reason: 'create-failed',
      path: targetPath,
      branch,
      baseCommit: base.commit,
    })
  }

  return {
    enabled: true,
    reason: 'git-workspace',
    path: targetPath,
    branch,
    baseCommit: base.commit,
    createdAt: new Date().toISOString(),
    root: rootAbsolute,
    warnings,
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
    // 空仓库（HEAD 还是未出生的 symbolic ref）不是「坏 worktree」：不附加 error。
    let unborn = false
    if (!headProbe.ok && statusProbe.ok) {
      const symbolic = await callGit(git, ['-C', target, 'symbolic-ref', '--quiet', 'HEAD'], target)
      unborn = symbolic.ok
    }
    if (!unborn) {
      const detail = summarize([collectText(headProbe), collectText(statusProbe)].filter(Boolean).join(' / '))
      if (detail) result.error = detail
    }
  }
  return result
}

/**
 * 删除前的路径校验：必须是 `<root>/<workspaceId>/<runId>` 这种形状。
 *
 * 有 `explicitRoot` 时做**真实**前缀校验：both sides 先 realpath 化简，目标必须
 * 恰好落在 `<root>/<workspaceId>/<runId>`（符号链接、`root2` 前缀混淆、往上跳一层
 * 都拒绝）；没给 root 时退回结构校验（父目录名 === workspaceId 且 runId 合法）。
 */
function assertWorktreePathSafe({ target, workspaceId, explicitRoot }) {
  const unsafe = reason => fail('WORKTREE_PATH_UNSAFE', `拒绝删除：${reason}（path=${target}）`)
  if (!isAbsolute(target)) throw unsafe('record.path 不是绝对路径')
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw unsafe(`workspaceId「${workspaceId}」不合法`)
  const runId = basename(target)
  if (!RUN_ID_PATTERN.test(runId) || runId.startsWith('.') || runId === '.' || runId === '..') {
    throw unsafe(`runId 段「${runId}」不合法`)
  }
  const parent = dirname(target)
  if (basename(parent) !== workspaceId) {
    throw unsafe(`父目录不是 workspaceId「${workspaceId}」`)
  }
  const stat = lstatSafe(target)
  if (stat && stat.isSymbolicLink()) throw unsafe('目标路径是符号链接（可能指向 root 之外）')
  if (explicitRoot !== null) {
    const rootReal = canonicalPath(explicitRoot)
    const parentReal = canonicalPath(parent)
    const expectedParent = join(rootReal, workspaceId)
    if (parentReal !== expectedParent) {
      throw unsafe(`不在 <root>/<workspaceId>/ 前缀下（期望 ${expectedParent}，实际 ${parentReal}）`)
    }
    const targetReal = stat ? canonicalPath(target) : join(parentReal, runId)
    const rel = relative(expectedParent, targetReal)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel !== runId) {
      throw unsafe(`目标不是 <root>/<workspaceId>/<runId> 的直接子项（rel=${rel || '(空)'}）`)
    }
  }
}

/** 删除后回查：`git worktree list` 里是否还登记着目标路径。 */
async function stillRegistered(git, repo, target) {
  const listing = await listRepoWorktrees(git, repo)
  if (!listing.ok) return null
  return listing.entries.some(entry => samePath(entry.path, target))
}

/** 取 record / workspace 上可能带的 root（用于严格的删除路径校验）。 */
function explicitRootOf({ root, record, workspace }) {
  const candidates = [root, record && record.root, workspace && workspace.worktreeRoot]
  for (const value of candidates) {
    if (typeof value === 'string' && value !== '') {
      return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value)
    }
  }
  return null
}

/**
 * 删 worktree（07 §4.2）：
 *
 * 1. 先校验 `record.path` 落在 `<root>/<workspaceId>/<runId>` 下（`record.root` /
 *    `workspace.worktreeRoot` / 显式 `root` 任一存在就做严格前缀校验），越界或
 *    符号链接 → `{ code:'WORKTREE_PATH_UNSAFE' }`；
 * 2. 目录不存在 → `{ removed:false, reason:'not-found' }`（顺手 prune 掉可能残留的
 *    登记，但不假装删过）；
 * 3. `git worktree remove`；`force:true` 先 `--force`，仍失败（例如被 lock）再
 *    `--force --force`——locked 残留也能删干净；
 * 4. 删完回查 `git worktree list`，仍登记就 prune / 报 `WORKTREE_REMOVE_FAILED`；
 * 5. 尝试删除 `record.branch` 对应分支（只删 `<branchPrefix>` 前缀，默认 `flow/`）：
 *    删不掉**不算删除失败**——`removed:true` 不变，结果里给
 *    `branchRemoved:false` + `branchWarning`（分支不存在 / 未合并保护 / 不是 git 仓库）。
 *
 * @param {{ workspace:object, record:object, run?:Function, force?:boolean,
 *   root?:string, branchPrefix?:string }} [options]
 * @returns {Promise<{ removed:boolean, reason:string, path?:string,
 *   branch?:string, branchRemoved?:boolean, branchWarning?:string }>}
 */
export async function removeWorktree({
  workspace, record, run, force, root, branchPrefix = DEFAULT_BRANCH_PREFIX,
} = {}) {
  const git = resolveRunner(run)
  const info = workspaceInfoOf(workspace)
  const target = recordPathOf(record)
  assertBranchPrefix(branchPrefix)
  const explicitRoot = explicitRootOf({ root, record, workspace })

  assertWorktreePathSafe({ target, workspaceId: info.id, explicitRoot })

  if (!existsSync(target)) {
    // 目录已经没了：如果 git 还登记着，顺手清掉登记（prune 语义），但仍返回 not-found。
    await callGit(git, ['-C', info.realpath, 'worktree', 'remove', '--force', '--force', target], info.realpath)
    await callGit(git, ['-C', info.realpath, 'worktree', 'prune', '--expire', 'now'], info.realpath)
    return { removed: false, reason: 'not-found' }
  }

  const removeArgv = ['-C', info.realpath, 'worktree', 'remove']
  if (force === true) removeArgv.push('--force')
  removeArgv.push(target)
  let probe = await callGit(git, removeArgv, info.realpath)

  if (!probe.ok) {
    const listing = await listRepoWorktrees(git, info.realpath)
    const entry = listing.ok
      ? listing.entries.find(item => samePath(item.path, target)) || null
      : null
    // 被 lock 的 worktree 必须 `--force --force`；`force:true` 时也再补一次双 force，
    // 覆盖「锁了 + 脏」这类一次 force 不够的组合。
    const shouldRetry = (entry && entry.locked) || force === true
    if (shouldRetry) {
      probe = await callGit(
        git,
        ['-C', info.realpath, 'worktree', 'remove', '--force', '--force', target],
        info.realpath,
      )
    }
  }

  if (!probe.ok) {
    const detail = summarize(collectText(probe))
    const listing = await listRepoWorktrees(git, info.realpath)
    const entry = listing.ok
      ? listing.entries.find(item => samePath(item.path, target)) || null
      : null
    const reason = entry && entry.locked ? 'locked' : 'remove-failed'
    throw fail('WORKTREE_REMOVE_FAILED', `git worktree remove 失败（${reason}）：${detail || '未知错误'}`, {
      reason,
      stderr: detail,
      path: target,
    })
  }

  const registered = await stillRegistered(git, info.realpath, target)
  if (registered === true) {
    await callGit(git, ['-C', info.realpath, 'worktree', 'prune', '--expire', 'now'], info.realpath)
    const after = await stillRegistered(git, info.realpath, target)
    if (after === true) {
      throw fail('WORKTREE_REMOVE_FAILED', `worktree 已删除但 git 仍登记着它（still-registered）：${target}`, {
        reason: 'still-registered',
        path: target,
      })
    }
  }
  if (existsSync(target)) {
    throw fail('WORKTREE_REMOVE_FAILED', `worktree 已从 git 注销但目录仍然存在（path-exists）：${target}`, {
      reason: 'path-exists',
      path: target,
    })
  }

  // 5. 分支：worktree 已经删掉，这一步失败不改写 removed:true。
  const result = { removed: true, reason: 'removed', path: target }
  const branch = normalizeBranchRef(record && record.branch)
  if (branch) result.branch = branch
  const guard = branchDeletionGuard(branch, branchPrefix)
  if (!guard.ok) {
    result.branchRemoved = false
    result.branchWarning = guard.warning
    return result
  }
  const branchResult = await tryDeleteBranch(git, info.realpath, branch)
  result.branchRemoved = branchResult.removed === true
  if (branchResult.removed !== true) result.branchWarning = branchResult.warning
  return result
}

/**
 * 只删一个 run 的分支（**不碰目录**）：给「worktree 目录已经被人手动删掉、
 * 但 `flow/<runId>` 分支还留着」的收尾路径用——`removeWorktree` 的
 * `not-found` 分支为了保住返回契约不删分支，路由可在它之后补这一刀。
 *
 * 规则：
 * - 复用 {@link branchDeletionGuard} + {@link tryDeleteBranch}：只删 `<branchPrefix>`
 *   （默认 `flow/`）下的合法 ref，前缀不符 / 非法 ref / 空名绝不删用户分支；
 * - 分支本来就不存在 / 删除失败 → `removed:false` + 可读 `warning`，**不抛错**；
 * - 工作区路径不存在、不是 git 仓库、git 不可用 → `removed:false` + `warning`，不抛错；
 * - `workspace` 允许只给 `{ path }` 或 `{ realpath }`（路由手里是 run.json.workspace）。
 *
 * @param {{ workspace:{path?:string, realpath?:string}, branch:string,
 *   branchPrefix?:string, run?:Function }} [options]
 * @returns {Promise<{ removed:boolean, branch:string|null, warning:string|null }>}
 */
export async function removeRunBranch({
  workspace, branch, branchPrefix = DEFAULT_BRANCH_PREFIX, run,
} = {}) {
  const git = resolveRunner(run)
  assertBranchPrefix(branchPrefix)
  const info = workspaceInfoOf(workspace)
  const normalized = normalizeBranchRef(branch)
  const result = { removed: false, branch: normalized || null, warning: null }

  // 1. 先过红线：非本流程前缀 / 非法 ref / 空名一律不碰。
  const guard = branchDeletionGuard(normalized, branchPrefix)
  if (!guard.ok) {
    result.warning = guard.warning
    return result
  }

  // 2. 工作区路径已经不在（主仓库被手动删掉）→ 不抛错，只报原因。
  let stat = null
  try {
    stat = statSync(info.realpath)
  } catch {
    stat = null
  }
  if (!stat || !stat.isDirectory()) {
    result.warning = `工作区不存在或不是目录：${info.realpath}（分支 ${normalized} 未删除）`
    return result
  }

  // 3. 路径在但不是 git 仓库（或主仓库已删到 git 不认）→ 同样只报原因。
  const probe = await callGit(
    git,
    ['-C', info.realpath, 'rev-parse', '--git-common-dir'],
    info.realpath,
  )
  if (!probe.ok) {
    const detail = summarize(collectText(probe))
    result.warning = probe.exitCode === null
      ? `git 不可用，无法删除分支 ${normalized}：${detail || '未知错误'}`
      : `工作区不是 git 仓库（或主仓库已删除），无法删除分支 ${normalized}：${detail || '未知错误'}`
    return result
  }

  // 4. 真正删（不存在 / 删失败都不抛，统一走 warning）。
  //    目录被手动删过时 `.git/worktrees` 里可能还留着登记，会挡住 `branch -D`；
  //    先 prune 掉失联登记（失败也不影响后面的判断）。
  await callGit(git, ['-C', info.realpath, 'worktree', 'prune', '--expire', 'now'], info.realpath)
  const deleted = await tryDeleteBranch(git, info.realpath, normalized)
  result.removed = deleted.removed === true
  result.warning = result.removed ? null : (deleted.warning || `分支 ${normalized} 删除失败`)
  return result
}

// ---------------------------------------------------------------------------
// 生命周期：列表 / 孤儿回收（只按本地目录判断，工作区已删也能用）
// ---------------------------------------------------------------------------

/** 扫 `<root>/<workspaceId>/<runId>`；返回纯目录事实，不碰 runstore。 */
function scanWorktreeDirs(rootAbsolute) {
  const result = { workspaceDirs: [], entries: [] }
  let dirents = []
  try {
    dirents = readdirSync(rootAbsolute, { withFileTypes: true })
  } catch {
    return result
  }
  for (const workspaceDirent of dirents) {
    if (!workspaceDirent.isDirectory() || !WORKSPACE_ID_PATTERN.test(workspaceDirent.name)) continue
    const workspaceDir = join(rootAbsolute, workspaceDirent.name)
    result.workspaceDirs.push(workspaceDir)
    let runDirents = []
    try {
      runDirents = readdirSync(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const runDirent of runDirents) {
      const runId = runDirent.name
      if (!runDirent.isDirectory() || !RUN_ID_PATTERN.test(runId) || runId.startsWith('.')) continue
      result.entries.push({
        path: join(workspaceDir, runId),
        workspaceId: workspaceDirent.name,
        runId,
      })
    }
  }
  return result
}

/** 查一条 worktree 在它的主仓库里是否仍被登记（仓库没了 → null，不报错）。 */
async function registeredInRepo(git, target, cache) {
  const common = await repoCommonDir(git, target)
  if (!common.ok) return null
  const repo = dirname(common.path)
  let paths = cache.get(repo)
  if (!paths) {
    const listing = await listRepoWorktrees(git, repo)
    if (!listing.ok) return null
    paths = new Set(listing.entries.map(entry => canonicalPath(entry.path)))
    cache.set(repo, paths)
  }
  return paths.has(canonicalPath(target))
}

/**
 * 列出 worktrees 根目录下的全部条目（07 §4.2 生命周期）。
 *
 * 扫 `<root>/<workspaceId>/<runId>`，逐条给出
 * `{ path, workspaceId, runId, exists, dirty, head, registered }`：
 * - `dirty` / `head`：在条目目录里跑 `git status --porcelain` / `rev-parse HEAD`，
 *   git 不可用（例如主仓库已删）时是 `null`；
 * - `registered`：该目录是否仍被它的主仓库登记（查不到主仓库 → `null`）。
 *
 * 全程只读，任何单条的 git 失败都降级成 null，不抛错；root 不存在 → `[]`。
 *
 * @param {{ root:string, run?:Function }} [options]
 * @returns {Promise<object[]>}
 */
export async function listWorktrees({ root, run } = {}) {
  const git = resolveRunner(run)
  const rootAbsolute = resolveRootArg(root)
  const { entries } = scanWorktreeDirs(rootAbsolute)
  const cache = new Map()
  const listed = []
  for (const entry of entries) {
    const exists = lstatSafe(entry.path) !== null
    if (!exists) {
      listed.push({ ...entry, exists: false, dirty: null, head: null, registered: null })
      continue
    }
    const headProbe = await callGit(git, ['-C', entry.path, 'rev-parse', 'HEAD'], entry.path)
    const statusProbe = await callGit(git, ['-C', entry.path, 'status', '--porcelain'], entry.path)
    const head = headProbe.ok ? (headProbe.stdout.trim().split(/\s+/)[0] || null) : null
    const dirty = statusProbe.ok ? statusProbe.stdout.trim() !== '' : null
    const registered = await registeredInRepo(git, entry.path, cache)
    listed.push({ ...entry, exists: true, dirty, head, registered })
  }
  return listed
}

/** 从一条孤儿目录里取回主仓库（worktree 的 common dir 父级）；取不到返回 null。 */
async function ownerRepoOf(git, target) {
  const common = await repoCommonDir(git, target)
  if (!common.ok) return null
  return dirname(common.path)
}

/**
 * 回收孤儿 worktree（07 §4.2 生命周期）：`<root>/<workspaceId>/<runId>` 里
 * runId 不在 `keepRunIds` 中的条目即孤儿。
 *
 * - 优先让主仓库 `git worktree remove --force --force` 注销并删除；
 * - 主仓库已经删了（没有 `.git` / git 不认）→ 直接删本地目录，不抛错；
 * - 删完仍存在 → 进 `skipped`（带 `reason`），不假装删掉；
 * - 删目录**之前**读它检出的分支，删完目录后尝试 `git -C <主仓库> branch -D <branch>`：
 *   只删 `<branchPrefix>`（默认 `flow/`）前缀；主仓库已删 / 读不到分支 / 删分支失败 →
 *   目录照删，但该条目额外进 `skipped`（`reason:'branch-skipped'` + 可读 `branchWarning`），
 *   不抛错；
 * - 顺手删空掉的 `<root>/<workspaceId>/` 目录。
 *
 * `run` 是注入的 git runner；`keepRunIds` 省略时按「一个都不保留」处理；
 * `branchPrefix` 可注入（默认 `flow/`），非该前缀的分支一律不删。
 *
 * @param {{ root:string, run?:Function, keepRunIds?:string[]|Set<string>,
 *   branchPrefix?:string }} [options]
 * @returns {Promise<{ removed: object[], skipped: object[] }>}
 */
export async function pruneWorktrees({
  root, run, keepRunIds, branchPrefix = DEFAULT_BRANCH_PREFIX,
} = {}) {
  const git = resolveRunner(run)
  const rootAbsolute = resolveRootArg(root)
  assertBranchPrefix(branchPrefix)
  const keep = new Set()
  if (keepRunIds !== undefined && keepRunIds !== null) {
    if (!Array.isArray(keepRunIds) && !(keepRunIds instanceof Set)) {
      throw fail('WORKTREE_INVALID', 'keepRunIds 必须是数组或 Set（里面是 runId 字符串）')
    }
    for (const runId of keepRunIds) {
      if (typeof runId === 'string' && runId !== '') keep.add(runId)
    }
  }

  const { workspaceDirs, entries } = scanWorktreeDirs(rootAbsolute)
  const removed = []
  const skipped = []
  for (const entry of entries) {
    if (keep.has(entry.runId)) continue
    // 分支名必须在删目录之前读；主仓库路径（ownerRepo）也先算好。
    const branchInfo = await readWorktreeBranch(git, entry.path)
    const ownerRepo = await ownerRepoOf(git, entry.path)
    let detail = ''
    if (ownerRepo) {
      const remove = await callGit(
        git,
        ['-C', ownerRepo, 'worktree', 'remove', '--force', '--force', entry.path],
        ownerRepo,
      )
      if (!remove.ok) detail = summarize(collectText(remove))
    }
    if (existsSync(entry.path)) {
      try {
        rmSync(entry.path, { recursive: true, force: true })
      } catch (error) {
        detail = summarize(error && error.message) || detail
      }
    }
    if (ownerRepo) {
      await callGit(git, ['-C', ownerRepo, 'worktree', 'prune', '--expire', 'now'], ownerRepo)
    }
    if (existsSync(entry.path)) {
      skipped.push({ ...entry, reason: 'remove-failed', error: detail })
      continue
    }

    const removedEntry = { ...entry, branchRemoved: false }
    if (branchInfo.branch) removedEntry.branch = branchInfo.branch
    let branchIssue = null
    if (!branchInfo.ok) {
      branchIssue = branchInfo.warning
    } else {
      const guard = branchDeletionGuard(branchInfo.branch, branchPrefix)
      if (!guard.ok) {
        branchIssue = guard.warning
      } else if (!ownerRepo) {
        branchIssue = '主仓库已删除或不是 git 仓库，无法删除分支（目录已清掉）'
      } else {
        const deleted = await tryDeleteBranch(git, ownerRepo, branchInfo.branch)
        if (deleted.removed === true) {
          removedEntry.branchRemoved = true
        } else {
          branchIssue = deleted.warning
        }
      }
    }
    if (branchIssue) {
      // 目录已经删掉，但分支没清：不抛错，记进 skipped 让人能看见。
      skipped.push({
        ...entry,
        reason: 'branch-skipped',
        branch: branchInfo.branch || null,
        branchWarning: branchIssue,
      })
    }
    removed.push(removedEntry)
  }

  // 空掉的 workspace 目录一并回收（只删空目录，非空的一律不动）。
  for (const workspaceDir of workspaceDirs) {
    if (!existsSync(workspaceDir)) continue
    try {
      const left = readdirSync(workspaceDir)
      if (left.length === 0) rmdirSync(workspaceDir)
    } catch {
      // 目录不可读 / 非空：忽略。
    }
  }

  return { removed, skipped }
}
