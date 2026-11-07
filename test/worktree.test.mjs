#!/usr/bin/env node
/**
 * worktree 模块自检（07-runtime-0.7.md §4 / §8）。
 *
 * 两组测试：
 *   1. 假 runner —— 不真跑 git，只断言 argv / cwd / timeout 与分支冲突探测；
 *   2. 真 git —— 在 `.tmp/` 下自己 `git init` + commit，跑通建/查/删与路径越界，
 *      绝不碰插件仓库本身。
 *
 * 临时目录全部落在项目 `.tmp/` 下，结束 rmSync；git 配置隔离到临时 HOME，
 * 不读宿主全局 gitconfig。
 */

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-wt-'))

const {
  workspaceIdFor, resolveWorkspace, decideWorktree, createWorktree, inspectWorktree, removeWorktree,
  listWorktrees, pruneWorktrees, removeRunBranch,
} = await import('../src/worktree.js')

let checks = 0
/** 统计断言数（交付时回报）。 */
let assertionCount = 0
const A = {
  equal(actual, expected, message) {
    assertionCount += 1
    assert.equal(actual, expected, message)
  },
  notEqual(actual, expected, message) {
    assertionCount += 1
    assert.notEqual(actual, expected, message)
  },
  deepEqual(actual, expected, message) {
    assertionCount += 1
    assert.deepEqual(actual, expected, message)
  },
  ok(value, message) {
    assertionCount += 1
    assert.ok(value, message)
  },
  match(value, pattern, message) {
    assertionCount += 1
    assert.match(value, pattern, message)
  },
  async code(expected, fn, message) {
    assertionCount += 1
    const error = await capture(fn)
    assert.ok(error, `${message}：预期抛错，实际没有抛`)
    assert.equal(
      error.code,
      expected,
      `${message}：code 期望 ${expected}，实际 ${error.code}（${error.message}）`,
    )
  },
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

/** 跑 fn 并返回它抛出的错误（没抛返回 null），供 code 断言复用。 */
async function capture(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error
  }
}

// ---------------------------------------------------------------------------
// 隔离的 git 配置：不读宿主 /etc/gitconfig 与 ~/.gitconfig
// ---------------------------------------------------------------------------

const previousEnv = {
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
}
const isolatedGlobalConfig = join(home, 'gitconfig')
writeFileSync(isolatedGlobalConfig, '')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = isolatedGlobalConfig
process.env.GIT_TERMINAL_PROMPT = '0'

/** 真 git 调用的同步小助手（只给测试自己用，与被测模块的 runner 无关）。 */
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** 真 git 的异步 runner：与模块默认 runner 同契约，可包一层做「创建瞬间失败」注入。 */
function realGitRun(hook) {
  return (argv, options = {}) => new Promise((resolveRun, rejectRun) => {
    if (typeof hook === 'function') hook(argv, options)
    execFile('git', argv, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 30000,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolveRun({ stdout, stderr, code: 0 })
        return
      }
      const wrapped = new Error(`git ${argv.join(' ')} 执行失败`)
      wrapped.status = typeof error.code === 'number' ? error.code : null
      wrapped.exitCode = wrapped.status
      wrapped.stdout = stdout
      wrapped.stderr = stderr
      rejectRun(wrapped)
    })
  })
}

/** 建一个真 git 仓库（隔离 git config，避免读宿主配置），返回 base HEAD。 */
function initRepo(dir, label = 'base') {
  mkdirSync(dir, { recursive: true })
  git(['init'], dir)
  git(['config', 'user.email', 'worktree-test@example.com'], dir)
  git(['config', 'user.name', 'worktree test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  git(['config', 'gc.auto', '0'], dir)
  writeFileSync(join(dir, 'README.md'), `# ${label}\n`)
  git(['add', 'README.md'], dir)
  git(['commit', '-m', label], dir)
  return git(['rev-parse', 'HEAD'], dir)
}

/** 当前仓库里以给定名字开头的分支（用于断言「没有累积 flow/<runId>-N」）。 */
function branchesOf(repo) {
  const raw = git(['branch', '--format=%(refname:short)'], repo)
  return raw === '' ? [] : raw.split('\n')
}

/** 模拟 git 非 0 退出：error.status 是数字退出码。 */
/**
 * 当前 git 是否支持 `git worktree add --orphan`（git 2.42+）。
 *
 * 真跑一次探测而不是解析版本号（发行版可能回移开关）。缓存结果，避免每条用例 fork。
 * 不支持时相关用例**明示跳过**：旧 git 上「空仓库也能开隔离副本」不可能成立，
 * 产品会走 `WORKTREE_CREATE_FAILED(empty-repo)` + 降级，那是另一条已覆盖的路径。
 */
let orphanSupport = null
function supportsOrphanWorktree() {
  if (orphanSupport !== null) return orphanSupport
  const probe = mkdtempSync(join(repoRoot, '.tmp', 'orphan-probe-'))
  try {
    const gitHome = mkdtempSync(join(repoRoot, '.tmp', 'orphan-probe-home-'))
    const run = args => execFileSync('git', args, {
      cwd: probe,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: gitHome, GIT_CONFIG_NOSYSTEM: '1' },
    })
    run(['init', '-q'])
    run(['worktree', 'add', '--orphan', join(probe, 'wt')])
    orphanSupport = true
    rmSync(gitHome, { recursive: true, force: true })
  } catch {
    orphanSupport = false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
  return orphanSupport
}

function gitFailure(stderr, status = 1) {
  const error = new Error(stderr || `git exit ${status}`)
  error.code = status
  error.status = status
  error.exitCode = status
  error.stdout = ''
  error.stderr = stderr
  return error
}

/** 假 runner：记录每次 argv / cwd / timeout，行为由 handler 决定。 */
function fakeGit(handler) {
  const calls = []
  const run = async (argv, options = {}) => {
    const call = { argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs }
    calls.push(call)
    return handler(argv, call, calls)
  }
  return { run, calls }
}

/** 假 runner 的 createWorktree 行为：status 探测 → 分支探测 → 读 HEAD → worktree add。 */
function createFakeGit({ taken = [], addStderr = null } = {}) {
  return fakeGit(argv => {
    const args = argv.slice(2).join(' ')
    if (args.startsWith('status --porcelain')) {
      return { stdout: '', stderr: '', code: 0 }
    }
    if (args.startsWith('worktree list --porcelain')) {
      return { stdout: '', stderr: '', code: 0 }
    }
    if (args.startsWith('worktree prune')) {
      return { stdout: '', stderr: '', code: 0 }
    }
    if (args.startsWith('rev-parse --verify --quiet ')) {
      const ref = argv[argv.length - 1]
      if (taken.some(branch => ref === `refs/heads/${branch}`)) {
        return { stdout: 'deadbeef\n', stderr: '', code: 0 }
      }
      throw gitFailure('', 1)
    }
    if (args.startsWith('rev-parse ')) {
      return { stdout: 'abc1234def5678\n', stderr: '', code: 0 }
    }
    if (args.startsWith('worktree add ')) {
      if (addStderr) throw gitFailure(addStderr, 128)
      // 假 git 也要「真的把目录建出来」：createWorktree 会复核 existsSync。
      const target = argv[argv.length - 2]
      mkdirSync(target, { recursive: true })
      return { stdout: '', stderr: '', code: 0 }
    }
    throw gitFailure(`unexpected git 参数：${argv.join(' ')}`, 127)
  })
}

try {
  // -------------------------------------------------------------------------
  console.log('worktree · workspaceIdFor')

  await check('workspaceIdFor：sha256 前 12 位、稳定、不同路径不同', async () => {
    const a = workspaceIdFor('/repo/one')
    const b = workspaceIdFor('/repo/one')
    const c = workspaceIdFor('/repo/two')
    A.match(a, /^[0-9a-f]{12}$/, '必须是 12 位小写 hex')
    A.equal(a, b, '同一 realpath 必须稳定')
    A.notEqual(a, c, '不同 realpath 必须不同')
    A.equal(
      a,
      createHash('sha256').update('/repo/one', 'utf8').digest('hex').slice(0, 12),
      '必须等于 sha256 前 12 位',
    )
    await A.code('WORKSPACE_INVALID', () => workspaceIdFor(null), 'null realpath')
    await A.code('WORKSPACE_INVALID', () => workspaceIdFor(''), '空 realpath')
  })

  // -------------------------------------------------------------------------
  console.log('worktree · resolveWorkspace')

  const repo = join(home, 'repo')
  mkdirSync(repo, { recursive: true })
  git(['init'], repo)
  git(['config', 'user.email', 'worktree-test@example.com'], repo)
  git(['config', 'user.name', 'worktree test'], repo)
  git(['config', 'commit.gpgsign', 'false'], repo)
  git(['config', 'gc.auto', '0'], repo)
  writeFileSync(join(repo, 'README.md'), '# base\n')
  git(['add', 'README.md'], repo)
  git(['commit', '-m', 'base'], repo)
  const baseHead = git(['rev-parse', 'HEAD'], repo)
  const repoReal = realpathSync(repo)

  await check('resolveWorkspace（真 git）：仓库根 → isGit true、id 对得上', async () => {
    const workspace = await resolveWorkspace({ path: repo })
    A.equal(workspace.isGit, true)
    A.equal(workspace.realpath, repoReal)
    A.equal(workspace.gitRoot, repoReal)
    A.equal(workspace.id, workspaceIdFor(repoReal))
    A.equal(workspace.path, resolve(repo))
  })

  const subdir = join(repo, 'src')
  mkdirSync(subdir, { recursive: true })

  await check('resolveWorkspace（真 git）：子目录 → isGit false 但保留 gitRoot', async () => {
    const workspace = await resolveWorkspace({ cwd: repo, path: 'src' })
    A.equal(workspace.isGit, false)
    A.equal(workspace.gitRoot, repoReal)
    A.equal(workspace.realpath, realpathSync(subdir))
  })

  const plain = join(home, 'plain')
  mkdirSync(plain, { recursive: true })

  await check('resolveWorkspace（真 git）：非 git 目录 → isGit false、gitRoot null', async () => {
    // `.tmp/` 在插件仓库内部，向上总能发现外层 .git；把 git 的向上搜索封顶在
    // `.tmp` 才能拿到真正的「不是 git 仓库」（临时目录仍然不离开项目）。
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = join(repoRoot, '.tmp')
    try {
      const workspace = await resolveWorkspace({ path: plain })
      A.equal(workspace.isGit, false)
      A.equal(workspace.gitRoot, null)
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling
    }
  })

  await check('resolveWorkspace：路径不存在 → WORKSPACE_NOT_FOUND', async () => {
    await A.code('WORKSPACE_NOT_FOUND', () => resolveWorkspace({ path: join(home, 'nope') }), '不存在')
    await A.code('WORKSPACE_INVALID', () => resolveWorkspace({}), '什么都没给')
  })

  await check('resolveWorkspace（假 runner）：区分「非 git」与「git 不可用」', async () => {
    const notRepo = fakeGit(() => {
      throw gitFailure('fatal: not a git repository (or any of the parent directories)')
    })
    const workspace = await resolveWorkspace({ path: plain, run: notRepo.run })
    A.equal(workspace.isGit, false, '非 git 仓库不是错误')
    A.equal(workspace.gitRoot, null)
    A.deepEqual(
      notRepo.calls[0].argv,
      ['-C', workspace.realpath, 'rev-parse', '--show-toplevel'],
      'git 探测必须走 -C <realpath>',
    )

    const noGit = fakeGit(() => {
      const error = new Error('spawn git ENOENT')
      error.code = 'ENOENT'
      throw error
    })
    await A.code('GIT_UNAVAILABLE', () => resolveWorkspace({ path: plain, run: noGit.run }), 'git 起不来')
  })

  // -------------------------------------------------------------------------
  console.log('worktree · decideWorktree')

  const gitWorkspace = { id: workspaceIdFor(repoReal), path: repo, realpath: repoReal, isGit: true }
  const plainWorkspace = { id: workspaceIdFor(realpathSync(plain)), path: plain, realpath: realpathSync(plain), isGit: false }

  await check('decideWorktree：auto / on / off 四种组合', async () => {
    A.deepEqual(
      decideWorktree({ workspace: gitWorkspace, policy: 'auto' }),
      { enabled: true, reason: 'git-workspace' },
    )
    A.deepEqual(
      decideWorktree({ workspace: gitWorkspace, policy: 'on' }),
      { enabled: true, reason: 'git-workspace' },
    )
    A.deepEqual(
      decideWorktree({ workspace: plainWorkspace, policy: 'auto' }),
      { enabled: false, reason: 'not-a-git-repo' },
    )
    A.deepEqual(
      decideWorktree({ workspace: plainWorkspace, policy: 'off' }),
      { enabled: false, reason: 'disabled-by-initiator' },
    )
    A.deepEqual(
      decideWorktree({ workspace: gitWorkspace, policy: 'off' }),
      { enabled: false, reason: 'disabled-by-initiator' },
    )
    A.deepEqual(
      decideWorktree({ workspace: gitWorkspace }),
      { enabled: true, reason: 'git-workspace' },
      'policy 省略时默认 auto',
    )
    await A.code(
      'WORKTREE_UNAVAILABLE',
      () => decideWorktree({ workspace: plainWorkspace, policy: 'on' }),
      'on + 非 git 必须拒绝，不许静默降级',
    )
    await A.code(
      'WORKTREE_POLICY_INVALID',
      () => decideWorktree({ workspace: gitWorkspace, policy: 'strict' }),
      '未知策略',
    )
    await A.code('WORKSPACE_INVALID', () => decideWorktree({ workspace: null }), 'null workspace')
  })

  // -------------------------------------------------------------------------
  console.log('worktree · createWorktree（假 runner）')

  const root = join(home, 'worktrees')
  const fakeWorkspace = {
    id: workspaceIdFor('/fake/repo'),
    path: '/fake/repo',
    realpath: '/fake/repo',
    isGit: true,
  }

  await check('createWorktree：目录/分支/baseCommit 正确，worktree add 参数完整', async () => {
    const fake = createFakeGit()
    const record = await createWorktree({
      workspace: fakeWorkspace,
      runId: 'r-fake',
      root,
      run: fake.run,
    })
    A.equal(record.enabled, true)
    A.equal(record.reason, 'git-workspace')
    A.equal(record.path, join(root, fakeWorkspace.id, 'r-fake'))
    A.equal(record.branch, 'flow/r-fake')
    A.equal(record.baseCommit, 'abc1234def5678')
    A.deepEqual(
      Object.keys(record).sort(),
      ['baseCommit', 'branch', 'createdAt', 'enabled', 'path', 'reason', 'root', 'warnings'],
      '返回字段必须与契约一致（新增 root / warnings 只增不减，仍要「不多不少」）',
    )
    A.equal(record.root, root, 'root 必须随记录返回，删除时才能做严格前缀校验')
    A.deepEqual(record.warnings, [], '干净的假工作区不该有 warning')
    A.ok(!Number.isNaN(Date.parse(record.createdAt)), 'createdAt 必须是合法 ISO 时间')

    const addCall = fake.calls.find(call => call.argv.includes('worktree') && call.argv.includes('add'))
    A.ok(addCall, '必须调用 git worktree add')
    A.deepEqual(
      addCall.argv,
      ['-C', fakeWorkspace.realpath, 'worktree', 'add', '-B', 'flow/r-fake', record.path, 'abc1234def5678'],
      'worktree add 参数必须与 07 §4.2 一致',
    )
    A.equal(addCall.cwd, fakeWorkspace.realpath)
    A.equal(addCall.timeoutMs, 30000, '每次 git 调用都要带超时')
  })

  await check('createWorktree：分支已存在 → -2', async () => {
    const fake = createFakeGit({ taken: ['flow/r-taken'] })
    const record = await createWorktree({
      workspace: fakeWorkspace,
      runId: 'r-taken',
      root,
      run: fake.run,
    })
    A.equal(record.branch, 'flow/r-taken-2')
    const probes = fake.calls
      .filter(call => call.argv.includes('--verify'))
      .map(call => call.argv[call.argv.length - 1])
    A.deepEqual(
      probes,
      ['refs/heads/flow/r-taken', 'refs/heads/flow/r-taken-2'],
      '先探测基础名，被占用再探测 -2',
    )
  })

  await check('createWorktree：失败 → WORKTREE_CREATE_FAILED + ≤300 字符 stderr', async () => {
    const stderr = `fatal: worktree add 失败 ${'x'.repeat(400)}`
    const fake = createFakeGit({ addStderr: stderr })
    const error = await capture(() => createWorktree({
      workspace: fakeWorkspace,
      runId: 'r-fail',
      root,
      run: fake.run,
    }))
    A.ok(error, '必须抛错')
    A.equal(error.code, 'WORKTREE_CREATE_FAILED')
    A.equal(error.stderr, stderr.slice(0, 300), 'stderr 摘要必须截到 300 字符')
  })

  // -------------------------------------------------------------------------
  console.log('worktree · createWorktree / inspectWorktree（真 git）')

  const workspace = await resolveWorkspace({ path: repo })
  let first = null
  let second = null

  await check('createWorktree（真 git）：worktree 真的落在 <root>/<id>/<runId>', async () => {
    const record = await createWorktree({ workspace, runId: 'r-real-1', root })
    first = record
    A.equal(record.enabled, true)
    A.equal(record.path, join(root, workspace.id, 'r-real-1'))
    A.equal(record.branch, 'flow/r-real-1')
    A.equal(record.baseCommit, baseHead)
    A.ok(existsSync(record.path), '目录必须存在')
    A.ok(existsSync(join(record.path, 'README.md')), '必须 checkout 出 base 的内容')
    A.equal(git(['rev-parse', 'HEAD'], record.path), baseHead)
    A.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], record.path), 'flow/r-real-1')
    A.ok(
      git(['worktree', 'list', '--porcelain'], repo).includes(`worktree ${record.path}`),
      '主仓库必须登记这个 worktree',
    )
  })

  await check('inspectWorktree（真 git）：clean → dirty=false，写文件后 dirty=true', async () => {
    const clean = await inspectWorktree({ workspace, record: first })
    A.deepEqual(clean, { exists: true, head: baseHead, dirty: false })
    writeFileSync(join(first.path, 'dirty.txt'), 'changed\n')
    const dirty = await inspectWorktree({ workspace, record: first })
    A.equal(dirty.exists, true)
    A.equal(dirty.head, baseHead)
    A.equal(dirty.dirty, true)
  })

  await check('createWorktree（真 git）：分支已存在 → flow/r-conflict-2', async () => {
    git(['branch', 'flow/r-conflict'], repo)
    const record = await createWorktree({ workspace, runId: 'r-conflict', root })
    second = record
    A.equal(record.branch, 'flow/r-conflict-2')
    A.equal(record.path, join(root, workspace.id, 'r-conflict'))
    A.equal(git(['rev-parse', 'HEAD'], record.path), baseHead)
  })

  await check('inspectWorktree：目录不存在 → exists:false', async () => {
    const missing = await inspectWorktree({
      workspace,
      record: { path: join(root, workspace.id, 'r-missing') },
    })
    A.deepEqual(missing, { exists: false, head: null, dirty: null })
  })

  // -------------------------------------------------------------------------
  console.log('worktree · removeWorktree（真 git）')

  await check('removeWorktree（真 git）：脏 worktree 不加 force 拒绝，加 force 正常删除', async () => {
    const error = await capture(() => removeWorktree({ workspace, record: first }))
    A.ok(error, '脏 worktree 不加 --force 必须失败')
    A.equal(error.code, 'WORKTREE_REMOVE_FAILED')
    A.ok(typeof error.stderr === 'string' && error.stderr.length <= 300, 'stderr 摘要 ≤300 字符')
    A.ok(existsSync(first.path), '删除失败时目录不能被删')

    const result = await removeWorktree({ workspace, record: first, force: true })
    A.equal(result.removed, true)
    A.equal(result.reason, 'removed')
    A.equal(result.path, first.path)
    A.equal(existsSync(first.path), false, '目录必须被删掉')
    A.ok(
      !git(['worktree', 'list', '--porcelain'], repo).includes(`worktree ${first.path}`),
      '主仓库不能再登记这个 worktree',
    )
  })

  await check('removeWorktree：路径越界 → WORKTREE_PATH_UNSAFE', async () => {
    const otherId = workspace.id === '000000000000' ? '111111111111' : '000000000000'
    await A.code(
      'WORKTREE_PATH_UNSAFE',
      () => removeWorktree({ workspace, record: { path: join(home, 'outside', 'r-x') } }),
      '完全不在 worktrees 根下',
    )
    await A.code(
      'WORKTREE_PATH_UNSAFE',
      () => removeWorktree({ workspace, record: { path: join(root, otherId, 'r-x') } }),
      'workspaceId 段对不上',
    )
    await A.code(
      'WORKTREE_PATH_UNSAFE',
      () => removeWorktree({ workspace, record: second, root: join(home, 'other-root') }),
      '传了 root 就必须严格落在 <root>/<id>/ 下',
    )
    await A.code(
      'WORKTREE_PATH_UNSAFE',
      () => removeWorktree({ workspace, record: { path: join(root, workspace.id) } }),
      '不能删到 <root>/<id> 这一层',
    )
    await A.code(
      'WORKTREE_PATH_UNSAFE',
      () => removeWorktree({ workspace, record: { path: join(root, workspace.id, 'a', 'b') } }),
      'runId 层不允许再嵌套',
    )
    A.ok(existsSync(second.path), '越界调用不能顺手动到真 worktree')
  })

  await check('removeWorktree：目录不存在 → not-found（不假装删过）', async () => {
    const result = await removeWorktree({
      workspace,
      record: { path: join(root, workspace.id, 'r-never-created') },
    })
    A.deepEqual(result, { removed: false, reason: 'not-found' })
  })

  await check('removeWorktree（真 git）：收尾删掉第二个 worktree', async () => {
    const result = await removeWorktree({ workspace, record: second })
    A.equal(result.removed, true)
    A.equal(existsSync(second.path), false)
  })

  // -------------------------------------------------------------------------
  console.log('worktree · 坏输入')

  await check('runId 含 ../ 或 / 被拒（RUN_ID_INVALID）', async () => {
    await A.code(
      'RUN_ID_INVALID',
      () => createWorktree({ workspace, runId: '../escape', root }),
      '../escape',
    )
    await A.code('RUN_ID_INVALID', () => createWorktree({ workspace, runId: 'a/b', root }), 'a/b')
    await A.code('RUN_ID_INVALID', () => createWorktree({ workspace, runId: 42, root }), '非字符串 runId')
    await A.code('RUN_ID_INVALID', () => createWorktree({ workspace, runId: '..', root }), '裸 ..')
  })

  await check('其他 bad input：null workspace / null record / 非法前缀与 baseRef', async () => {
    await A.code(
      'WORKSPACE_INVALID',
      () => createWorktree({ workspace: null, runId: 'r-x', root }),
      'null workspace',
    )
    await A.code(
      'WORKSPACE_INVALID',
      () => inspectWorktree({ workspace: null, record: { path: join(root, workspace.id, 'r-x') } }),
      'inspect 的 null workspace',
    )
    await A.code(
      'WORKTREE_INVALID',
      () => inspectWorktree({ workspace, record: null }),
      'null record',
    )
    await A.code(
      'WORKTREE_INVALID',
      () => removeWorktree({ workspace, record: second, run: 'not-a-function' }),
      'run 不是函数',
    )
    await A.code(
      'WORKTREE_INVALID',
      () => createWorktree({ workspace, runId: 'r-x', root, branchPrefix: 'bad prefix/' }),
      'branchPrefix 含空格',
    )
    await A.code(
      'WORKTREE_INVALID',
      () => createWorktree({ workspace, runId: 'r-x', root, baseRef: '-x' }),
      'baseRef 像选项',
    )
  })

  // -------------------------------------------------------------------------
  console.log('worktree · 残留路径自愈（真 git）')

  await check('残留目录自愈：目标路径已有非空目录 → 清理后重建成功', async () => {
    const target = join(root, workspace.id, 'r-heal-dir')
    mkdirSync(join(target, 'nested'), { recursive: true })
    writeFileSync(join(target, 'junk.txt'), 'leftover\n')
    writeFileSync(join(target, 'nested', 'deep.txt'), 'deep\n')

    const record = await createWorktree({ workspace, runId: 'r-heal-dir', root })
    A.equal(record.path, target)
    A.equal(record.branch, 'flow/r-heal-dir')
    A.ok(existsSync(join(target, 'README.md')), '重建后必须 checkout 出 base 内容')
    A.ok(!existsSync(join(target, 'junk.txt')), '残留文件必须被清掉')
    A.ok(!existsSync(join(target, 'nested')), '残留子目录必须被清掉')
    A.ok(record.warnings.some(text => /残留/.test(text)), '清理残留必须给出可读 warning')
    const listed = git(['worktree', 'list', '--porcelain'], repo)
      .split('\n').filter(line => line === `worktree ${target}`)
    A.equal(listed.length, 1, '重建后必须登记且只登记一次')
    await removeWorktree({ workspace, record, force: true })
  })

  await check('已登记 worktree 自愈（locked + 外来分支）→ 清理后重建，固定分支名不被占用', async () => {
    const target = join(root, workspace.id, 'r-heal-reg')
    mkdirSync(dirname(target), { recursive: true })
    git(['worktree', 'add', '-b', 'manual-branch', target, 'HEAD'], repo)
    git(['worktree', 'lock', '--reason', '残留锁', target], repo)

    const record = await createWorktree({ workspace, runId: 'r-heal-reg', root })
    A.equal(record.branch, 'flow/r-heal-reg', '清理残留后必须复用固定分支名（不是 -2）')
    A.ok(existsSync(join(target, 'README.md')))
    A.equal(
      branchesOf(repo).filter(branch => branch === 'flow/r-heal-reg').length,
      1,
      '同一 run 只能有一个 flow/<runId> 分支',
    )
    A.ok(branchesOf(repo).includes('manual-branch'), '不属于本 run 的分支不能删')
    A.ok(record.warnings.some(text => /残留/.test(text)), '清理残留必须给出可读 warning')
    const listed = git(['worktree', 'list', '--porcelain'], repo)
      .split('\n').filter(line => line === `worktree ${target}`)
    A.equal(listed.length, 1, '旧登记必须被替换掉，不能出现两条')
    await removeWorktree({ workspace, record, force: true })
  })

  await check('目标路径登记在别的仓库 → registered-elsewhere，且不删别人的 worktree', async () => {
    const otherRepo = join(home, 'repo-other')
    const otherBase = initRepo(otherRepo, 'other base')
    A.ok(otherBase)
    const target = join(root, workspace.id, 'r-foreign')
    mkdirSync(dirname(target), { recursive: true })
    git(['worktree', 'add', '-b', 'other-branch', target, 'HEAD'], otherRepo)

    const error = await capture(() => createWorktree({ workspace, runId: 'r-foreign', root }))
    A.ok(error, '别人的 worktree 必须拒绝，不能静默覆盖')
    A.equal(error.code, 'WORKTREE_CREATE_FAILED')
    A.equal(error.reason, 'registered-elsewhere')
    A.ok(existsSync(join(target, 'README.md')), '别人的 worktree 文件不能被删')
    A.ok(
      git(['worktree', 'list', '--porcelain'], otherRepo).includes(`worktree ${target}`),
      '别的仓库的登记不能被我们动',
    )
    git(['worktree', 'remove', '--force', '--force', target], otherRepo)
  })

  // -------------------------------------------------------------------------
  console.log('worktree · 分支不累积（真 git）')

  await check('连续 5 次 add 失败 → 不留 flow/<runId>-N，随后复用固定名成功', async () => {
    const runId = 'r-retry'
    const target = join(root, workspace.id, runId)
    // 注入「创建瞬间目标路径被占」：真实 git 会先建分支、再因路径非空而失败。
    const occupiedRun = realGitRun(argv => {
      const args = argv.slice(2)
      if (args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(target, { recursive: true })
        writeFileSync(join(target, 'race.txt'), 'occupied\n')
      }
    })

    const failures = []
    for (let index = 0; index < 5; index += 1) {
      failures.push(await capture(() => createWorktree({ workspace, runId, root, run: occupiedRun })))
    }
    for (const error of failures) {
      A.ok(error, '每次都必须失败（注入的路径占用）')
      A.equal(error.code, 'WORKTREE_CREATE_FAILED')
      A.match(
        error.stderr,
        /存在|exists/i,
        '失败必须来自真实 git（目标路径被占），证明分支确实先被创建过、回滚才不是空跑',
      )
    }
    const leaked = branchesOf(repo).filter(branch => /^flow\/r-retry(?:-\d+)?$/.test(branch))
    A.deepEqual(leaked, [], '失败创建不能留下 flow/r-retry / flow/r-retry-2 …')
    A.ok(!existsSync(target), '失败后不能留下半成品目录')

    const record = await createWorktree({ workspace, runId, root })
    A.equal(record.branch, 'flow/r-retry', '固定分支名可复用，不是 -6')
    A.ok(existsSync(join(target, 'README.md')))
    await removeWorktree({ workspace, record, force: true })
  })

  // -------------------------------------------------------------------------
  console.log('worktree · 删除 locked 残留（真 git）')

  await check('removeWorktree：locked worktree 不带 force 也能删干净', async () => {
    const record = await createWorktree({ workspace, runId: 'r-locked', root })
    git(['worktree', 'lock', '--reason', 'locked by test', record.path], repo)

    const result = await removeWorktree({ workspace, record })
    A.equal(result.removed, true)
    A.equal(result.reason, 'removed')
    A.equal(existsSync(record.path), false, 'locked 目录必须被删掉')
    A.ok(
      !git(['worktree', 'list', '--porcelain'], repo).includes(`worktree ${record.path}`),
      '删完不能再登记在 git worktree list 里',
    )
  })

  // -------------------------------------------------------------------------
  console.log('worktree · 删除分支（真 git）')

  await check('removeWorktree：成功后连 flow/<runId> 分支一起删，branchRemoved:true', async () => {
    const record = await createWorktree({ workspace, runId: 'r-branch', root })
    A.ok(branchesOf(repo).includes('flow/r-branch'), '前置：分支必须已经建出来')

    const result = await removeWorktree({ workspace, record })
    A.equal(result.removed, true)
    A.equal(result.branchRemoved, true, '成功删除后必须连分支一起清')
    A.equal(result.branch, 'flow/r-branch')
    A.equal(result.branchWarning, undefined, '删干净时不该有 warning')
    A.ok(!branchesOf(repo).includes('flow/r-branch'), 'git branch 里不能再有 flow/r-branch')
  })

  await check('removeWorktree：非 flow/ 分支不删 / 分支不存在不算失败 / branchPrefix 可注入', async () => {
    // 1. 分支名被手改成 master：不以 flow/ 开头 → 拒绝删除，用户分支必须还在。
    const guardRecord = await createWorktree({ workspace, runId: 'r-guard', root })
    const guarded = await removeWorktree({
      workspace,
      record: { ...guardRecord, branch: 'master' },
      force: true,
    })
    A.equal(guarded.removed, true, 'worktree 已经删了就是成功')
    A.equal(guarded.branchRemoved, false)
    A.match(guarded.branchWarning, /不以 flow\/ 开头/, '必须说明为什么不删')
    A.ok(branchesOf(repo).includes('master'), '非 flow/ 的用户分支必须原样保留')
    // 实际检出的 flow/r-guard 分支没被删（record.branch 被改过），手动清掉。
    A.ok(branchesOf(repo).includes('flow/r-guard'))
    git(['branch', '-D', 'flow/r-guard'], repo)

    // 2. 分支不存在：不是删除失败，给 warning 但 removed 仍为 true。
    const missingRecord = await createWorktree({ workspace, runId: 'r-missing-branch', root })
    const missing = await removeWorktree({
      workspace,
      record: { ...missingRecord, branch: 'flow/r-ghost' },
      force: true,
    })
    A.equal(missing.removed, true)
    A.equal(missing.branchRemoved, false)
    A.match(missing.branchWarning, /不存在/)
    git(['branch', '-D', 'flow/r-missing-branch'], repo)

    // 3. 前缀可注入：agent/ 分支用 agent/ 前缀删。
    const customRecord = await createWorktree({
      workspace, runId: 'r-prefix', root, branchPrefix: 'agent/',
    })
    A.equal(customRecord.branch, 'agent/r-prefix')
    const custom = await removeWorktree({ workspace, record: customRecord, branchPrefix: 'agent/' })
    A.equal(custom.branchRemoved, true)
    A.ok(!branchesOf(repo).includes('agent/r-prefix'))
  })

  // -------------------------------------------------------------------------
  console.log('worktree · removeRunBranch（真 git）')

  await check('removeRunBranch：只删 flow/ 分支（path / realpath 两种 workspace 形状）', async () => {
    git(['branch', 'flow/r-only'], repo)
    const byPath = await removeRunBranch({ workspace: { path: repo }, branch: 'flow/r-only' })
    A.deepEqual(byPath, { removed: true, branch: 'flow/r-only', warning: null })
    A.ok(!branchesOf(repo).includes('flow/r-only'), 'flow/r-only 必须从 git branch 里消失')

    // 真实缺口场景：worktree 目录被手动删掉，只剩分支。
    const manual = await createWorktree({ workspace, runId: 'r-manual-gone', root })
    rmSync(manual.path, { recursive: true, force: true })
    A.ok(branchesOf(repo).includes('flow/r-manual-gone'), '前置：目录没了分支还在')
    const byRealpath = await removeRunBranch({
      workspace: { realpath: realpathSync(repo) },
      branch: manual.branch,
    })
    A.equal(byRealpath.removed, true)
    A.equal(byRealpath.branch, 'flow/r-manual-gone')
    A.equal(byRealpath.warning, null)
    A.ok(!branchesOf(repo).includes('flow/r-manual-gone'), '只剩分支的残留也必须清掉')
  })

  await check('removeRunBranch：非 flow/ 不删（master 还在）；分支不存在给 warning 不抛', async () => {
    const guarded = await removeRunBranch({ workspace, branch: 'master' })
    A.equal(guarded.removed, false)
    A.equal(guarded.branch, 'master')
    A.match(guarded.warning, /不以 flow\//, '必须说明为什么不删')
    A.ok(branchesOf(repo).includes('master'), '用户分支 master 必须原样保留')

    const ghost = await removeRunBranch({ workspace, branch: 'flow/r-ghost' })
    A.equal(ghost.removed, false)
    A.equal(ghost.branch, 'flow/r-ghost')
    A.match(ghost.warning, /不存在/)

    const empty = await removeRunBranch({ workspace, branch: '' })
    A.equal(empty.removed, false)
    A.equal(empty.branch, null)
    A.match(empty.warning, /没有可删除的分支名/)
  })

  await check('removeRunBranch：工作区不存在 / 不是 git 仓库 → removed:false + warning，不抛', async () => {
    const goneRepo = join(home, 'repo-branch-gone')
    initRepo(goneRepo, 'branch gone base')
    rmSync(goneRepo, { recursive: true, force: true })
    const goneResult = await removeRunBranch({ workspace: { path: goneRepo }, branch: 'flow/r-x' })
    A.equal(goneResult.removed, false)
    A.equal(goneResult.branch, 'flow/r-x')
    A.match(goneResult.warning, /工作区不存在|不是目录/)

    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = join(repoRoot, '.tmp')
    try {
      const plainResult = await removeRunBranch({ workspace: { realpath: realpathSync(plain) }, branch: 'flow/r-x' })
      A.equal(plainResult.removed, false)
      A.match(plainResult.warning, /不是 git 仓库|无法删除/)
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling
    }
  })

  // -------------------------------------------------------------------------
  console.log('worktree · 路径越界（root 前缀真的生效）')

  await check('removeWorktree：record.root / 前缀混淆 / 符号链接 都拒绝', async () => {
    const record = await createWorktree({ workspace, runId: 'r-safety', root })

    await A.code(
      'WORKTREE_PATH_UNSAFE',
      () => removeWorktree({ workspace, record: { ...record, root: join(home, 'wrong-root') } }),
      'record.root 对不上',
    )
    await A.code(
      'WORKTREE_PATH_UNSAFE',
      () => removeWorktree({ workspace, record, root: join(home, 'other-root-3') }),
      '显式 root 对不上',
    )

    // root 前缀混淆：.../worktrees2/<id>/<runId> 不能被当成 .../worktrees 下的条目。
    const confusion = join(home, 'worktrees2', workspace.id, 'r-confusion')
    mkdirSync(confusion, { recursive: true })
    await A.code(
      'WORKTREE_PATH_UNSAFE',
      () => removeWorktree({ workspace, record: { path: confusion }, root }),
      'root 前缀混淆',
    )

    // 符号链接：路径形状对，但实际指向 root 之外。
    const outside = join(home, 'outside-target')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'keep.txt'), 'keep\n')
    const linkPath = join(root, workspace.id, 'r-link')
    symlinkSync(outside, linkPath)
    await A.code(
      'WORKTREE_PATH_UNSAFE',
      () => removeWorktree({ workspace, record: { path: linkPath }, root }),
      '符号链接',
    )
    A.ok(existsSync(join(outside, 'keep.txt')), '越界拒绝不能动到 root 之外的文件')
    A.equal(existsSync(record.path), true, '被拒绝的调用不能顺手动到真 worktree')

    await removeWorktree({ workspace, record, force: true })
    rmSync(linkPath, { force: true })
  })

  // -------------------------------------------------------------------------
  console.log('worktree · dirty 告警（真 git）')

  await check('工作区有未提交修改 / 敏感文件 → 创建返回可读 warning，且不复制', async () => {
    const dirtyRepo = join(home, 'repo-dirty')
    initRepo(dirtyRepo, 'dirty base')
    writeFileSync(join(dirtyRepo, 'tracked.txt'), 'base\n')
    git(['add', 'tracked.txt'], dirtyRepo)
    git(['commit', '-m', 'tracked'], dirtyRepo)
    writeFileSync(join(dirtyRepo, 'tracked.txt'), 'CHANGED\n')
    writeFileSync(join(dirtyRepo, '.env'), 'SECRET=1\n')
    mkdirSync(join(dirtyRepo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dirtyRepo, 'node_modules', 'pkg', 'index.js'), 'x\n')

    const dirtyWorkspace = await resolveWorkspace({ path: dirtyRepo })
    const record = await createWorktree({
      workspace: dirtyWorkspace,
      runId: 'r-dirty',
      root: join(home, 'dirty-worktrees'),
    })
    A.ok(record.warnings.some(text => /未提交修改/.test(text)), 'dirty 必须给出 warning')
    A.ok(record.warnings.some(text => /\.env/.test(text)), '未跟踪的 .env 必须点名')
    A.ok(record.warnings.some(text => /node_modules/.test(text)), 'node_modules 必须说明不会复制')
    A.equal(
      readFileSync(join(record.path, 'tracked.txt'), 'utf8'),
      'base\n',
      'worktree 只从 HEAD 检出，未提交修改不能带过去',
    )
    A.ok(!existsSync(join(record.path, '.env')), '敏感文件不能复制进 worktree')
    A.ok(!existsSync(join(record.path, 'node_modules')), 'node_modules 不能复制进 worktree')
    await removeWorktree({ workspace: dirtyWorkspace, record, force: true })
  })

  // -------------------------------------------------------------------------
  console.log('worktree · listWorktrees / pruneWorktrees（真 git）')

  await check('列出 worktree、按 keepRunIds 回收孤儿、幂等', async () => {
    const lifeRepo = join(home, 'repo-life')
    initRepo(lifeRepo, 'life base')
    const lifeWorkspace = await resolveWorkspace({ path: lifeRepo })
    const lifeRoot = join(home, 'life-worktrees')
    await createWorktree({ workspace: lifeWorkspace, runId: 'r-keep', root: lifeRoot })
    await createWorktree({ workspace: lifeWorkspace, runId: 'r-orphan', root: lifeRoot })

    const listed = await listWorktrees({ root: lifeRoot })
    A.equal(listed.length, 2)
    const keepEntry = listed.find(entry => entry.runId === 'r-keep')
    A.ok(keepEntry, '必须能列出保留的 run')
    A.equal(keepEntry.workspaceId, lifeWorkspace.id)
    A.equal(keepEntry.exists, true)
    A.equal(keepEntry.dirty, false)
    A.match(keepEntry.head, /^[0-9a-f]{40}$/)
    A.equal(keepEntry.registered, true)

    // 「目录存在但对应 run 已不存在」：keepRunIds 里没有 r-orphan。
    const pruned = await pruneWorktrees({ root: lifeRoot, keepRunIds: ['r-keep'] })
    A.equal(pruned.removed.length, 1)
    A.equal(pruned.removed[0].runId, 'r-orphan')
    A.deepEqual(pruned.skipped, [])
    A.equal(pruned.removed[0].branchRemoved, true, 'prune 必须连孤儿分支一起回收')
    A.equal(pruned.removed[0].branch, 'flow/r-orphan')
    A.ok(!branchesOf(lifeRepo).includes('flow/r-orphan'), '孤儿分支必须从 git branch 里消失')
    A.ok(branchesOf(lifeRepo).includes('flow/r-keep'), '保留的 run 分支必须还在')
    A.equal(existsSync(keepEntry.path), true, 'keepRunIds 里的条目不能被删')
    A.ok(!existsSync(join(lifeRoot, lifeWorkspace.id, 'r-orphan')), '孤儿目录必须被删掉')
    A.ok(
      !git(['worktree', 'list', '--porcelain'], lifeRepo).includes(`worktree ${join(lifeRoot, lifeWorkspace.id, 'r-orphan')}`),
      '孤儿必须从 git 登记里消失',
    )

    const again = await pruneWorktrees({ root: lifeRoot, keepRunIds: ['r-keep'] })
    A.equal(again.removed.length, 0, 'prune 必须幂等')
    A.equal(again.skipped.length, 0)

    await removeWorktree({
      workspace: lifeWorkspace,
      record: { path: keepEntry.path, root: lifeRoot },
      force: true,
    })
  })

  await check('主仓库已删（工作区没了）时 list / prune 不抛错，能删孤儿', async () => {
    const goneRepo = join(home, 'repo-gone')
    initRepo(goneRepo, 'gone base')
    const goneWorkspace = await resolveWorkspace({ path: goneRepo })
    const goneRoot = join(home, 'gone-worktrees')
    const goneRecord = await createWorktree({ workspace: goneWorkspace, runId: 'r-gone', root: goneRoot })

    rmSync(goneRepo, { recursive: true, force: true })

    const remaining = await listWorktrees({ root: goneRoot })
    A.equal(remaining.length, 1)
    A.equal(remaining[0].runId, 'r-gone')
    A.equal(remaining[0].exists, true)
    A.equal(remaining[0].head, null, '主仓库没了，head 只能是 null')
    A.equal(remaining[0].dirty, null, '主仓库没了，dirty 只能是 null')
    A.equal(remaining[0].registered, null, '主仓库没了，登记情况只能是 null')

    const result = await pruneWorktrees({ root: goneRoot })
    A.equal(result.removed.length, 1)
    A.equal(result.removed[0].runId, 'r-gone')
    A.equal(result.removed[0].branchRemoved, false, '主仓库没了，分支删不掉')
    A.equal(existsSync(goneRecord.path), false, '孤儿目录必须被删掉')
    A.equal(existsSync(join(goneRoot, goneWorkspace.id)), false, '空掉的 workspaceId 目录也要回收')
    A.equal(result.skipped.length, 1, '分支删除跳过必须记进 skipped')
    A.equal(result.skipped[0].runId, 'r-gone')
    A.equal(result.skipped[0].reason, 'branch-skipped')
    A.match(result.skipped[0].branchWarning, /主仓库|无法读取|无法删除/, 'reason 必须可读')
  })

  // -------------------------------------------------------------------------
  console.log('worktree · 空仓库（真 git）')

  await check('没有 commit 的空仓库：用 --orphan 建出 worktree，baseCommit 为 null', async () => {
    if (!supportsOrphanWorktree()) {
      console.log('  · 当前 git 不支持 `worktree add --orphan`（需 ≥2.42），明示跳过该用例')
      return
    }
    const emptyRepo = join(home, 'repo-empty')
    mkdirSync(emptyRepo, { recursive: true })
    git(['init'], emptyRepo)
    git(['config', 'user.email', 'worktree-test@example.com'], emptyRepo)
    git(['config', 'user.name', 'worktree test'], emptyRepo)

    const emptyWorkspace = await resolveWorkspace({ path: emptyRepo })
    A.equal(emptyWorkspace.isGit, true)
    const emptyRoot = join(home, 'empty-worktrees')
    const record = await createWorktree({ workspace: emptyWorkspace, runId: 'r-empty', root: emptyRoot })

    A.equal(record.baseCommit, null, '空仓库没有 baseCommit，不许编一个')
    A.equal(record.branch, 'flow/r-empty')
    A.ok(existsSync(record.path), '空仓库也必须真的建出目录')
    A.ok(existsSync(join(record.path, '.git')), 'worktree 的 .git 文件必须存在')
    A.ok(record.warnings.some(text => /空仓库/.test(text)), '空仓库必须给出可读 warning')
    A.equal(git(['status', '--porcelain'], record.path), '', '空仓库 worktree 的 git 是活的')
    A.ok(
      git(['worktree', 'list', '--porcelain'], emptyRepo).includes(`worktree ${record.path}`),
      '空仓库主仓库必须登记这个 worktree',
    )

    const inspected = await inspectWorktree({ workspace: emptyWorkspace, record })
    A.equal(inspected.exists, true)
    A.equal(inspected.head, null)
    A.equal(inspected.dirty, false)
    A.equal(inspected.error, undefined, '空仓库不是坏 worktree，不该错误告警')
    await removeWorktree({ workspace: emptyWorkspace, record, force: true })
  })

  // -------------------------------------------------------------------------
  console.log('worktree · 错误分类')

  await check('subdirectory / not-a-repo / git-unavailable / empty-repo / GIT_FAILED', async () => {
    const subWorkspace = await resolveWorkspace({ path: subdir })
    const subError = await capture(() => createWorktree({ workspace: subWorkspace, runId: 'r-sub', root }))
    A.ok(subError)
    A.equal(subError.code, 'WORKTREE_UNAVAILABLE')
    A.equal(subError.reason, 'subdirectory', '子目录必须是 subdirectory，不是笼统的 not-a-git-repo')

    const notRepoError = await capture(() => createWorktree({ workspace: plainWorkspace, runId: 'r-norepo', root }))
    A.ok(notRepoError)
    A.equal(notRepoError.code, 'WORKTREE_UNAVAILABLE')
    A.equal(notRepoError.reason, 'not-a-repo')

    const noGit = fakeGit(() => {
      const error = new Error('spawn git ENOENT')
      error.code = 'ENOENT'
      throw error
    })
    const downError = await capture(() => createWorktree({
      workspace: gitWorkspace, runId: 'r-down', root, run: noGit.run,
    }))
    A.ok(downError)
    A.equal(downError.code, 'WORKTREE_CREATE_FAILED')
    A.equal(downError.reason, 'git-unavailable', 'git 起不来不能被说成不是 git 仓库')

    // 空仓库 + 老 git（不认 --orphan）：必须明确给 empty-repo，而不是静默失败。
    const fakeEmpty = fakeGit(argv => {
      const args = argv.slice(2).join(' ')
      if (args.startsWith('status --porcelain')) return { stdout: '', stderr: '', code: 0 }
      if (args.startsWith('worktree list --porcelain')) return { stdout: '', stderr: '', code: 0 }
      if (args.startsWith('worktree prune')) return { stdout: '', stderr: '', code: 0 }
      if (args.startsWith('worktree add ')) throw gitFailure('error: unknown option `orphan\'', 129)
      if (args.startsWith('rev-parse --verify --quiet ')) throw gitFailure('', 1)
      if (args.startsWith('rev-parse ')) throw gitFailure('fatal: 未知的版本或路径', 128)
      if (args.startsWith('symbolic-ref --quiet HEAD')) return { stdout: 'refs/heads/master\n', stderr: '', code: 0 }
      if (args.startsWith('branch -D ')) throw gitFailure('', 1)
      if (args.startsWith('update-ref -d ')) return { stdout: '', stderr: '', code: 0 }
      throw gitFailure(`unexpected git 参数：${argv.join(' ')}`, 127)
    })
    const fakeEmptyWorkspace = {
      id: workspaceIdFor('/fake/empty'),
      path: '/fake/empty',
      realpath: '/fake/empty',
      isGit: true,
    }
    const emptyError = await capture(() => createWorktree({
      workspace: fakeEmptyWorkspace,
      runId: 'r-empty-fail',
      root: join(home, 'fake-empty-worktrees'),
      run: fakeEmpty.run,
    }))
    A.ok(emptyError)
    A.equal(emptyError.code, 'WORKTREE_CREATE_FAILED')
    A.equal(emptyError.reason, 'empty-repo')

    // 权限 / dubious ownership 之类不再伪装成「不是 git 仓库」。
    const dubious = fakeGit(() => {
      throw gitFailure('fatal: detected dubious ownership in repository at /x', 128)
    })
    const failed = await capture(() => resolveWorkspace({ path: plain, run: dubious.run }))
    A.ok(failed)
    A.equal(failed.code, 'GIT_FAILED')
  })

  // -------------------------------------------------------------------------
  console.log('worktree · workspaceId 不漂移（真 git）')

  await check('从 worktree 里再开 run：workspaceId 与目录都不漂移', async () => {
    const firstRecord = await createWorktree({ workspace, runId: 'r-drift-a', root })
    const fromWorktree = await resolveWorkspace({ path: firstRecord.path })
    A.equal(fromWorktree.isGit, true)
    A.equal(fromWorktree.id, workspace.id, 'worktree 里解析出的 workspaceId 必须回到主仓库')
    A.equal(fromWorktree.realpath, realpathSync(firstRecord.path))

    const secondRecord = await createWorktree({ workspace: fromWorktree, runId: 'r-drift-b', root })
    A.equal(secondRecord.path, join(root, workspace.id, 'r-drift-b'), '不能漂到另一个 workspaceId 目录')
    A.ok(existsSync(secondRecord.path))
    A.equal(secondRecord.baseCommit, git(['rev-parse', 'HEAD'], firstRecord.path))

    await removeWorktree({ workspace: fromWorktree, record: secondRecord, force: true })
    await removeWorktree({ workspace, record: firstRecord, force: true })
  })
} finally {
  process.env.GIT_CONFIG_NOSYSTEM = previousEnv.GIT_CONFIG_NOSYSTEM ?? ''
  process.env.GIT_CONFIG_GLOBAL = previousEnv.GIT_CONFIG_GLOBAL ?? ''
  process.env.GIT_TERMINAL_PROMPT = previousEnv.GIT_TERMINAL_PROMPT ?? ''
  if (process.env.GIT_CONFIG_NOSYSTEM === '') delete process.env.GIT_CONFIG_NOSYSTEM
  if (process.env.GIT_CONFIG_GLOBAL === '') delete process.env.GIT_CONFIG_GLOBAL
  if (process.env.GIT_TERMINAL_PROMPT === '') delete process.env.GIT_TERMINAL_PROMPT
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${checks} 组通过（${assertionCount} 条断言）`)
