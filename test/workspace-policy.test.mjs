#!/usr/bin/env node
/**
 * 工作区策略自检（0.13.7 C）：主仓库身份 / linked worktree 归一 / allowlist /
 * 非 Git 与缺失路径的确定性错误码 / 节点 cwd 的 worktree 越界规则。
 *
 * 真实临时 Git 仓库落在 `<repo>/.tmp/`，结束清理；不启动 agent、不发网络请求。
 * 运行：node test/workspace-policy.test.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const {
  WORKSPACE_ERROR, normalizeAllowlist, normalizeGitUrl, resolveNodeCwd, resolveWorkspace,
} = await import('../src/workspace-policy.js')

let checks = 0
let assertions = 0

function eq(actual, expected, message) {
  assertions += 1
  assert.equal(actual, expected, message)
}

function deep(actual, expected, message) {
  assertions += 1
  assert.deepEqual(actual, expected, message)
}

function ok(value, message) {
  assertions += 1
  assert.ok(value, message)
}

async function rejectsCode(fn, code, message) {
  assertions += 1
  await assert.rejects(fn, error => {
    assert.equal(error && error.code, code, `${message}（实际 ${error && error.code}）`)
    return true
  }, message)
}

async function check(name, fn) {
  const sandbox = mkdtempSync(join(repoRoot, '.tmp', 'ws-policy-'))
  try {
    await fn(sandbox)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** 伪造「不是 Git 仓库」的 runner：临时目录都在仓库 .tmp 下，真实 git 会向上找到
 * flow-studio 仓库，无法模拟独立非 Git 工作区。 */
const nonGitRunner = async () => {
  const error = new Error('fatal: not a git repository (or any parent)')
  error.status = 128
  error.exitCode = 128
  error.stdout = ''
  error.stderr = 'fatal: not a git repository (or any parent)\n'
  throw error
}

function makeRepo(root, { commit = true } = {}) {
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  if (commit) {
    writeFileSync(join(repo, 'README.md'), '# demo\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'init'])
  }
  return commit ? realpathSync(repo) : repo
}

try {
  await check('Git 仓库根：workspaceId 稳定、repositoryRoot = realpath、identity 是 path', async sandbox => {
    const repo = makeRepo(sandbox)
    const first = await resolveWorkspace({ path: repo })
    const second = await resolveWorkspace({ path: `${repo}/.` })
    eq(first.isGit, true, '仓库根 isGit=true')
    eq(first.repositoryRoot, repo, 'repositoryRoot 是真实仓库根')
    eq(first.isLinkedWorktree, false, '主检出不是 linked worktree')
    ok(/^[0-9a-f]{12}$/.test(first.workspaceId), 'workspaceId 是 12 位 hex')
    eq(second.workspaceId, first.workspaceId, '同一路径的 workspaceId 稳定')
    eq(first.identityKind, 'path', '没有 remote 时 identity 用 path')
  })

  await check('allowlist：根内允许、根外 WORKSPACE_NOT_ALLOWED、空列表不限制、非法条目忽略', async sandbox => {
    const repo = makeRepo(sandbox)
    const outside = join(sandbox, 'outside')
    mkdirSync(outside)
    const inside = await resolveWorkspace({ path: repo, allowlist: [sandbox] })
    eq(inside.isGit, true, 'allowlist 内正常解析')
    await rejectsCode(
      () => resolveWorkspace({ path: outside, allowlist: [repo] }),
      WORKSPACE_ERROR.NOT_ALLOWED,
      '根外路径被拒绝',
    )
    const unrestricted = await resolveWorkspace({ path: outside, allowlist: [], runner: nonGitRunner })
    eq(unrestricted.isGit, false, '空 allowlist 不限制，非 Git 路径返回 isGit=false')
    deep(normalizeAllowlist(['relative/path', repo]), [repo], '非绝对路径条目被忽略，绝对路径归一')
  })

  await check('缺失路径 / 非目录：WORKSPACE_MISSING', async sandbox => {
    await rejectsCode(
      () => resolveWorkspace({ path: join(sandbox, 'missing') }),
      WORKSPACE_ERROR.MISSING,
      '不存在路径',
    )
    const file = join(sandbox, 'file.txt')
    writeFileSync(file, 'x')
    await rejectsCode(() => resolveWorkspace({ path: file }), WORKSPACE_ERROR.MISSING, '普通文件不是工作区')
    await rejectsCode(() => resolveWorkspace({}), WORKSPACE_ERROR.MISSING, '缺 path/cwd')
  })

  await check('非 Git / 子目录：默认 isGit=false；requireGit 给 WORKSPACE_NOT_GIT + reason', async sandbox => {
    const plain = join(sandbox, 'plain')
    mkdirSync(plain)
    const nonGit = await resolveWorkspace({ path: plain, runner: nonGitRunner })
    eq(nonGit.isGit, false, '非 Git 目录默认不抛错')
    eq(nonGit.repositoryRoot, null, '非 Git 没有 repositoryRoot')
    await rejectsCode(
      () => resolveWorkspace({ path: plain, requireGit: true, runner: nonGitRunner }),
      WORKSPACE_ERROR.NOT_GIT,
      'requireGit 时非 Git 明确失败',
    )
    try {
      await resolveWorkspace({ path: plain, requireGit: true, runner: nonGitRunner })
    } catch (error) {
      eq(error.reason, 'not-a-repo', 'reason 区分 not-a-repo')
    }

    const repo = makeRepo(sandbox)
    const sub = join(repo, 'sub')
    mkdirSync(sub)
    const subdir = await resolveWorkspace({ path: sub })
    eq(subdir.isGit, false, '仓库子目录不是工作区根')
    eq(subdir.gitRoot, repo, '子目录保留 gitRoot')
    try {
      await resolveWorkspace({ path: sub, requireGit: true })
    } catch (error) {
      eq(error.code, WORKSPACE_ERROR.NOT_GIT)
      eq(error.reason, 'subdirectory', 'reason 区分 subdirectory')
    }
  })

  await check('linked worktree：同一 workspaceId、repositoryRoot 指回主仓库', async sandbox => {
    const repo = makeRepo(sandbox)
    const linked = join(sandbox, 'linked')
    git(repo, ['worktree', 'add', '-b', 'topic', linked])
    const main = await resolveWorkspace({ path: repo })
    const fromLinked = await resolveWorkspace({ path: linked })
    eq(fromLinked.isGit, true, 'linked worktree 是 Git 仓库根')
    eq(fromLinked.isLinkedWorktree, true, '识别为 linked worktree')
    eq(fromLinked.repositoryRoot, repo, 'repositoryRoot 归一到主仓库')
    eq(fromLinked.workspaceId, main.workspaceId, '从 linked worktree 发起得到同一 workspaceId')
    eq(fromLinked.path, realpathSync(linked), 'path 保留调用方给的检出位置')
  })

  await check('upstream remote 身份：同一 origin 的不同检出得到同一 workspaceId', async sandbox => {
    const repoA = makeRepo(join(sandbox, 'a'))
    const repoB = makeRepo(join(sandbox, 'b'))
    git(repoA, ['remote', 'add', 'origin', 'git@github.com:example/shared.git'])
    git(repoB, ['remote', 'add', 'origin', 'https://github.com/example/shared.git'])
    const a = await resolveWorkspace({ path: repoA })
    const b = await resolveWorkspace({ path: repoB })
    eq(a.identityKind, 'remote', '有 origin 时 identity 用 remote')
    eq(a.workspaceId, b.workspaceId, '同一远端的不同本地路径共享 workspaceId')
    eq(normalizeGitUrl('https://user:pass@example.com/a.git'), 'example.com/a', 'URL 归一去掉凭据 / scheme / .git')
    eq(
      normalizeGitUrl('git@GitHub.com:Example/Shared.git'),
      normalizeGitUrl('https://github.com/Example/Shared'),
      'ssh 与 https 地址归一成同一身份',
    )
  })

  await check('symlink 路径按 realpath 归一，allowlist 按真实路径判断', async sandbox => {
    const repo = makeRepo(sandbox)
    const link = join(sandbox, 'repo-link')
    symlinkSync(repo, link)
    const viaLink = await resolveWorkspace({ path: link, allowlist: [repo] })
    eq(viaLink.realpath, repo, 'realpath 指回仓库')
    eq(viaLink.workspaceId, (await resolveWorkspace({ path: repo })).workspaceId, 'symlink 不改变 workspaceId')
  })

  await check('节点 cwd：worktree 模式只允许树内相对子目录；绝对路径 / ../ / symlink 越界拒绝', async sandbox => {
    const root = join(sandbox, 'tree')
    const sub = join(root, 'sub')
    mkdirSync(sub, { recursive: true })
    const outside = join(sandbox, 'outside')
    mkdirSync(outside)
    const workspace = { effectiveRoot: root, mode: 'worktree' }
    eq(resolveNodeCwd({ workspace, cwd: 'sub' }), sub, '相对子目录允许')
    eq(resolveNodeCwd({ workspace, cwd: '' }), root, '空 cwd 用树根')
    for (const cwd of ['../outside', join(outside, 'x')]) {
      assertions += 1
      assert.throws(() => resolveNodeCwd({ workspace, cwd }), error => error.code === WORKSPACE_ERROR.CWD_OUTSIDE)
    }
    const escape = join(root, 'escape')
    symlinkSync(outside, escape)
    assertions += 1
    assert.throws(() => resolveNodeCwd({ workspace, cwd: 'escape' }), error => error.code === WORKSPACE_ERROR.CWD_OUTSIDE)

    const off = { effectiveRoot: root, mode: 'off' }
    eq(resolveNodeCwd({ workspace: off, cwd: outside }), outside, '非 worktree 模式保留绝对 cwd 行为')
  })

  await check('Git 不可用：注入 runner 抛 ENOENT → WORKSPACE_GIT_UNAVAILABLE', async sandbox => {
    const repo = makeRepo(sandbox)
    const runner = async () => {
      const error = new Error('spawn git ENOENT')
      error.code = 'ENOENT'
      throw error
    }
    await rejectsCode(
      () => resolveWorkspace({ path: repo, runner }),
      WORKSPACE_ERROR.GIT_UNAVAILABLE,
      'git 起不来时明确报不可用',
    )
  })

  console.log('workspace-policy.test.mjs')
  console.log(`${checks} 组通过（${assertions} 条断言）`)
} catch (error) {
  console.error('✗ 工作区策略自检失败')
  console.error(error)
  process.exit(1)
}
