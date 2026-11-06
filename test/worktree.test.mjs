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
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-wt-'))

const {
  workspaceIdFor, resolveWorkspace, decideWorktree, createWorktree, inspectWorktree, removeWorktree,
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

/** 模拟 git 非 0 退出：error.status 是数字退出码。 */
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

/** 假 runner 的 createWorktree 行为：探测分支 → 读 HEAD → worktree add。 */
function createFakeGit({ taken = [], addStderr = null } = {}) {
  return fakeGit(argv => {
    const args = argv.slice(2).join(' ')
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
      ['baseCommit', 'branch', 'createdAt', 'enabled', 'path', 'reason'],
      '返回字段必须与 07 §8 契约一致（不多不少）',
    )
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
