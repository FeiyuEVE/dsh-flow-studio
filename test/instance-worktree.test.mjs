#!/usr/bin/env node
/**
 * 实例 worktree 生命周期自检（0.13.7 C）：真实临时 Git 仓库。
 *
 * 覆盖：两实例同名文件互不影响 / 冻结 baseCommit 跨节点与重读一致 / 非 Git、Git 缺失、
 * 空仓库、linked worktree、分支冲突 / 越界与 symlink / 其它仓库与用户分支不能清理 /
 * 脏树与 expectedHead / list 孤儿与 prune 保守执行 / planHash 过期失效。
 *
 * 临时仓库落在 `<repo>/.tmp/`，结束清理；不启动 agent、不发网络请求。
 * 运行：node test/instance-worktree.test.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const { resolveWorkspace } = await import('../src/workspace-policy.js')
const {
  INSTANCE_WORKTREE_ERROR, createInstanceWorktree, createPrunePlan, inspectInstanceWorktree,
  listInstanceWorktrees, planHashOf, pruneInstanceWorktrees, removeInstanceBranch,
  removeInstanceWorktree,
} = await import('../src/instance-worktree.js')
const {
  readResourceRecord, writeResourceRecord,
} = await import('../src/instance-resources.js')

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
  const sandbox = mkdtempSync(join(repoRoot, '.tmp', 'inst-wt-'))
  try {
    await fn(sandbox)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim()
}

function makeRepo(sandbox, name = 'repo', { commit = true } = {}) {
  const repo = join(sandbox, name)
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  if (commit) {
    writeFileSync(join(repo, 'README.md'), '# demo\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'init'])
  }
  return repo
}

const nonGitRunner = async () => {
  const error = new Error('fatal: not a git repository (or any parent)')
  error.status = 128
  error.exitCode = 128
  error.stderr = 'fatal: not a git repository (or any parent)\n'
  throw error
}

async function setup(sandbox, name = 'repo', { commit = true } = {}) {
  const repo = makeRepo(sandbox, name, { commit })
  const workspace = await resolveWorkspace({ path: repo })
  const worktreeRoot = join(sandbox, 'wts')
  const registryRoot = join(sandbox, 'registry')
  const instancesRoot = join(sandbox, 'instances')
  return { repo, workspace, worktreeRoot, registryRoot, instancesRoot }
}

async function create(context, instanceId, extra = {}) {
  return await createInstanceWorktree({
    instanceId,
    workspace: context.workspace,
    worktreeRoot: context.worktreeRoot,
    ...extra,
  })
}

function writeInstanceStatus(instancesRoot, instanceId, status) {
  const dir = join(instancesRoot, instanceId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'instance.json'), `${JSON.stringify({ id: instanceId, status })}\n`)
}

try {
  await check('两实例从同一仓库启动：同名文件互不影响，主工作区不变', async sandbox => {
    const context = await setup(sandbox)
    const first = await create(context, 'i-one')
    const second = await create(context, 'i-two')
    ok(first.effectiveRoot !== second.effectiveRoot, '两棵工作树路径不同')
    ok(first.effectiveRoot.endsWith(join(first.workspaceId, 'i-one')), '路径是 <root>/<workspaceId>/<instanceId>')
    eq(first.branch, 'flow-instance/i-one', '第一个实例分支')
    eq(second.branch, 'flow-instance/i-two', '第二个实例分支')
    eq(first.baseCommit, second.baseCommit, '同一 baseRef 冻结到同一 commit')
    eq((await inspectInstanceWorktree({ record: first })).state, 'ok', '第一个实例 inspect ok')
    eq((await inspectInstanceWorktree({ record: second })).state, 'ok', '第二个实例 inspect ok')

    writeFileSync(join(first.effectiveRoot, 'same.txt'), 'first\n')
    writeFileSync(join(second.effectiveRoot, 'same.txt'), 'second\n')
    eq(readFileSync(join(first.effectiveRoot, 'same.txt'), 'utf8'), 'first\n', '第一个实例读到自己的文件')
    eq(readFileSync(join(second.effectiveRoot, 'same.txt'), 'utf8'), 'second\n', '第二个实例读到自己的文件')
    ok(!existsSync(join(context.repo, 'same.txt')), '主工作区没有被写入同名文件')
    eq((await inspectInstanceWorktree({ record: first })).state, 'dirty', '写入未跟踪文件后树是 dirty')
  })

  await check('baseCommit 冻结：后续 HEAD 移动不影响记录；重新读取记录 / 新实例得到新 base', async sandbox => {
    const context = await setup(sandbox)
    const frozen = await create(context, 'i-frozen')
    const firstCommit = frozen.baseCommit
    eq(frozen.baseRef, undefined, '记录形状不额外塞 baseRef')
    appendFileSync(join(context.repo, 'README.md'), 'second\n')
    git(context.repo, ['add', '.'])
    git(context.repo, ['commit', '-m', 'second'])
    const moved = git(context.repo, ['rev-parse', 'HEAD'])
    ok(moved !== firstCommit, '主仓库 HEAD 已移动')
    eq((await inspectInstanceWorktree({ record: frozen })).head, firstCommit, '实例 worktree HEAD 仍是冻结 commit')
    eq(frozen.baseCommit, firstCommit, '内存记录 baseCommit 不变')

    await writeResourceRecord({ registryRoot: context.registryRoot, record: frozen })
    const reread = await readResourceRecord({
      registryRoot: context.registryRoot,
      workspaceId: frozen.workspaceId,
      instanceId: frozen.instanceId,
    })
    deep(reread, frozen, '记录从 registry 读回逐字段一致（重启口径）')
    eq((await inspectInstanceWorktree({ record: reread })).baseCommit, firstCommit, '重读后仍用冻结 commit')

    const later = await create(context, 'i-later')
    eq(later.baseCommit, moved, '之后创建的实例才看到新 HEAD')
  })

  await check('非 Git / Git 缺失 / 空仓库：分别有确定结果', async sandbox => {
    const plain = join(sandbox, 'plain')
    mkdirSync(plain)
    const nonGitWorkspace = await resolveWorkspace({ path: plain, runner: nonGitRunner })
    await rejectsCode(
      () => createInstanceWorktree({
        instanceId: 'i-nogit',
        workspace: { ...nonGitWorkspace, worktreeRoot: join(sandbox, 'wts') },
        worktreeRoot: join(sandbox, 'wts'),
      }),
      INSTANCE_WORKTREE_ERROR.NOT_GIT,
      '非 Git workspace 拒绝',
    )

    const empty = await setup(sandbox, 'empty', { commit: false })
    const emptyRecord = await create(empty, 'i-empty')
    eq(emptyRecord.baseCommit, null, '空仓库 baseCommit=null')
    eq(emptyRecord.branch, 'flow-instance/i-empty', '空仓库用 orphan 分支')
    const emptyInspect = await inspectInstanceWorktree({ record: emptyRecord })
    eq(emptyInspect.state, 'ok', '空仓库 worktree 可检查')
    eq((await removeInstanceWorktree({ record: emptyRecord, worktreeRoot: empty.worktreeRoot })).removed, true, '空仓库 worktree 可删')
    eq((await removeInstanceBranch({ record: emptyRecord })).reason, 'not-found', '未出生分支按 not-found 呈现')

    const context = await setup(sandbox, 'broken-git')
    const failingRunner = async () => {
      const error = new Error('spawn git ENOENT')
      error.code = 'ENOENT'
      throw error
    }
    await rejectsCode(
      () => createInstanceWorktree({
        instanceId: 'i-git-missing',
        workspace: context.workspace,
        worktreeRoot: context.worktreeRoot,
        runner: failingRunner,
      }),
      INSTANCE_WORKTREE_ERROR.GIT_UNAVAILABLE,
      'git 缺失明确报 GIT_UNAVAILABLE',
    )
  })

  await check('linked worktree 发起：归一到主仓库 workspaceId；分支冲突加 -N 后缀', async sandbox => {
    const context = await setup(sandbox)
    const linkedPath = join(sandbox, 'linked')
    git(context.repo, ['worktree', 'add', '-b', 'topic', linkedPath])
    const linkedWorkspace = await resolveWorkspace({ path: linkedPath })
    eq(linkedWorkspace.workspaceId, context.workspace.workspaceId, 'linked worktree 与主仓库同 workspaceId')
    const record = await createInstanceWorktree({
      instanceId: 'i-linked',
      workspace: linkedWorkspace,
      worktreeRoot: context.worktreeRoot,
    })
    eq(record.repositoryRoot, realpathSync(context.repo), 'repositoryRoot 是主仓库')
    eq(record.effectiveRoot, join(context.worktreeRoot, context.workspace.workspaceId, 'i-linked'), '树落在主仓库 workspaceId 下')
    eq((await inspectInstanceWorktree({ record })).state, 'ok', 'linked 发起的实例树可检查')

    git(context.repo, ['branch', 'flow-instance/i-conflict'])
    const conflicted = await create(context, 'i-conflict')
    eq(conflicted.branch, 'flow-instance/i-conflict-2', '分支冲突时用 -2 后缀')
  })

  await check('越界路径 / symlink / 其它仓库 / 用户分支：不能清理', async sandbox => {
    const context = await setup(sandbox)
    const record = await create(context, 'i-safe')

    const linkRoot = join(sandbox, 'linkroot')
    mkdirSync(join(linkRoot, record.workspaceId), { recursive: true })
    const linkPath = join(linkRoot, record.workspaceId, record.instanceId)
    symlinkSync(record.effectiveRoot, linkPath)
    await rejectsCode(
      () => removeInstanceWorktree({
        record: { ...record, effectiveRoot: linkPath },
        force: true,
        worktreeRoot: linkRoot,
      }),
      INSTANCE_WORKTREE_ERROR.PATH_UNSAFE,
      'symlink 目标拒绝',
    )
    ok(existsSync(record.effectiveRoot), '原工作树没有被删')

    const other = await setup(sandbox, 'other-repo')
    const otherRecord = await create(other, 'i-other')
    await rejectsCode(
      () => removeInstanceWorktree({
        record: { ...record, repositoryRoot: other.workspace.repositoryRoot, effectiveRoot: otherRecord.effectiveRoot, branch: otherRecord.branch },
        force: true,
        worktreeRoot: other.worktreeRoot,
      }),
      INSTANCE_WORKTREE_ERROR.PATH_UNSAFE,
      '用别的仓库记录删不能证明所有权（结构 / 路径校验先拒绝）',
    )
    ok(existsSync(otherRecord.effectiveRoot), '别的仓库工作树没有被删')

    const userBranch = await removeInstanceBranch({ record: { ...record, branch: 'main' } })
    eq(userBranch.removed, false, '用户分支不删')
    eq(userBranch.reason, 'not-owned', '原因 not-owned')
    eq(git(context.repo, ['rev-parse', '--verify', 'main']).length > 0, true, 'main 分支仍在')

    await rejectsCode(
      () => removeInstanceWorktree({
        record: { ...record, repositoryRoot: join(sandbox, 'missing-repo') },
        worktreeRoot: context.worktreeRoot,
      }),
      INSTANCE_WORKTREE_ERROR.NOT_REGISTERED,
      '主仓库不存在时无所有权证据，拒绝删除',
    )
  })

  await check('dirty / expectedHead：脏树需 force，HEAD 不符拒绝（force 不能越过乐观锁）', async sandbox => {
    const context = await setup(sandbox)
    const record = await create(context, 'i-clean')
    writeFileSync(join(record.effectiveRoot, 'untracked.txt'), 'dirty\n')
    await rejectsCode(
      () => removeInstanceWorktree({ record, worktreeRoot: context.worktreeRoot }),
      INSTANCE_WORKTREE_ERROR.DIRTY,
      '脏树默认拒绝',
    )

    const cleanRecord = await create(context, 'i-head')
    await rejectsCode(
      () => removeInstanceWorktree({ record: cleanRecord, expectedHead: 'f'.repeat(40), worktreeRoot: context.worktreeRoot }),
      INSTANCE_WORKTREE_ERROR.HEAD_MISMATCH,
      'expectedHead 不符拒绝',
    )
    await rejectsCode(
      () => removeInstanceWorktree({ record: cleanRecord, expectedHead: 'f'.repeat(40), force: true, worktreeRoot: context.worktreeRoot }),
      INSTANCE_WORKTREE_ERROR.HEAD_MISMATCH,
      'force 不能越过 expectedHead',
    )
    const removed = await removeInstanceWorktree({
      record: cleanRecord,
      expectedHead: cleanRecord.baseCommit,
      worktreeRoot: context.worktreeRoot,
    })
    eq(removed.removed, true, 'expectedHead 正确时删除')
    eq((await inspectInstanceWorktree({ record: cleanRecord })).state, 'missing', '删除后 state=missing')

    const forced = await removeInstanceWorktree({ record, force: true, worktreeRoot: context.worktreeRoot })
    eq(forced.removed, true, 'force 可删脏树')
    const branch = await removeInstanceBranch({ record })
    eq(branch.removed, true, '干净分支随后可删（目录删除不冒充分支成功）')
  })

  await check('未合并分支：removeInstanceBranch 只呈现风险，不删；合并后才删', async sandbox => {
    const context = await setup(sandbox)
    const record = await create(context, 'i-unmerged')
    writeFileSync(join(record.effectiveRoot, 'work.txt'), 'work\n')
    git(record.effectiveRoot, ['add', '.'])
    git(record.effectiveRoot, ['commit', '-m', 'branch work'])
    await removeInstanceWorktree({ record, worktreeRoot: context.worktreeRoot })
    const blocked = await removeInstanceBranch({ record })
    eq(blocked.removed, false, '未合并分支不删')
    eq(blocked.reason, 'unmerged', 'reason=unmerged')
    ok(blocked.warning.includes('HEAD'), 'warning 说明未合并进主仓库 HEAD')
    eq(git(context.repo, ['rev-parse', '--verify', `refs/heads/${record.branch}`]).length > 0, true, '分支仍在')

    git(context.repo, ['merge', '--ff-only', record.branch])
    const merged = await removeInstanceBranch({ record })
    eq(merged.removed, true, '合并后可删')
  })

  await check('list + prune：孤儿 / 损坏 / 无所有权目录；planHash 过期失效；无所有权只报告', async sandbox => {
    const context = await setup(sandbox)
    const active = await create(context, 'i-active')
    const done = await create(context, 'i-done')
    const orphan = await create(context, 'i-orphan')
    const corruptInstance = await create(context, 'i-corrupt-inst')
    writeInstanceStatus(context.instancesRoot, 'i-active', 'ACTIVE')
    writeInstanceStatus(context.instancesRoot, 'i-done', 'COMPLETED')
    mkdirSync(join(context.instancesRoot, 'i-corrupt-inst'), { recursive: true })
    writeFileSync(join(context.instancesRoot, 'i-corrupt-inst', 'instance.json'), '{bad')
    for (const record of [active, done, orphan, corruptInstance]) {
      await writeResourceRecord({ registryRoot: context.registryRoot, record })
    }
    const junk = join(context.worktreeRoot, active.workspaceId, 'i-junk')
    mkdirSync(junk, { recursive: true })
    writeFileSync(join(junk, 'keep.txt'), 'no ownership\n')
    const corruptDir = join(context.registryRoot, active.workspaceId)
    writeFileSync(join(corruptDir, 'i-bad.json'), '{bad')

    const listed = await listInstanceWorktrees({
      worktreeRoot: context.worktreeRoot,
      registryRoot: context.registryRoot,
      instancesRoot: context.instancesRoot,
    })
    const byId = Object.fromEntries(listed.entries.map(entry => [entry.instanceId, entry]))
    eq(byId['i-active'].instanceStatus, 'ACTIVE', 'ACTIVE 实例状态可见')
    eq(byId['i-active'].orphan, false, 'ACTIVE 实例不算孤儿')
    eq(byId['i-done'].instanceStatus, 'COMPLETED', 'COMPLETED 状态可见')
    eq(byId['i-orphan'].orphan, true, '实例不存在的记录标 orphan')
    ok(byId['i-orphan'].orphanReasons.includes('instance-missing'), 'orphan 原因 instance-missing')
    eq(byId['i-corrupt-inst'].instanceCorrupt, true, '损坏 instance.json 被标记')
    eq(byId['i-junk'].recordOk, false, '无记录目录 recordOk=false')
    ok(byId['i-junk'].orphanReasons.includes('no-ownership-record'), '无所有权原因')
    ok(listed.corrupt.some(item => item.instanceId === 'i-bad'), '损坏记录单列')

    const plan = createPrunePlan({ entries: listed.entries })
    const actions = Object.fromEntries(plan.entries.map(entry => [entry.instanceId, entry.action]))
    eq(actions['i-active'], 'retain', 'ACTIVE 只保留')
    eq(actions['i-done'], 'remove', 'COMPLETED 干净树可删')
    eq(actions['i-orphan'], 'remove', '实例缺失但有所有权记录可删')
    eq(actions['i-corrupt-inst'], 'report', '实例目录损坏时停止 prune（只报告）')
    eq(actions['i-junk'], 'report', '无所有权目录只报告')
    eq(actions['i-bad'], 'report', '损坏记录只报告')
    ok(/^[0-9a-f]{64}$/.test(plan.planHash), 'planHash 是 sha256')

    const tampered = JSON.parse(JSON.stringify(plan))
    tampered.entries[0].head = 'f'.repeat(40)
    ok(planHashOf(tampered) !== plan.planHash, '状态变化后重新计算的 hash 不同')
    await rejectsCode(
      () => pruneInstanceWorktrees({ plan: tampered, worktreeRoot: context.worktreeRoot }),
      INSTANCE_WORKTREE_ERROR.PLAN_STALE,
      '旧 planHash 不能执行过期删除',
    )
    ok(existsSync(done.effectiveRoot), '过期执行没有删任何树')

    const executed = await pruneInstanceWorktrees({ plan, worktreeRoot: context.worktreeRoot })
    deep(executed.removed.map(item => item.instanceId).sort(), ['i-done', 'i-orphan'], '只删有所有权的孤儿 / 终态树')
    ok(!existsSync(done.effectiveRoot), '终态树已删')
    ok(!existsSync(orphan.effectiveRoot), '孤儿树已删')
    ok(existsSync(active.effectiveRoot), 'ACTIVE 树保留')
    ok(existsSync(junk), '无所有权目录没有被删')
    ok(existsSync(corruptInstance.effectiveRoot), '实例目录损坏的树没有被删')
    ok(executed.skipped.some(item => item.instanceId === 'i-junk' && item.reason === 'no-ownership'), 'junk 进 skipped')
  })

  await check('记录形状 / 参数校验：非法实例 id、cleanupPolicy、worktreeRoot 拒绝', async sandbox => {
    const context = await setup(sandbox)
    await rejectsCode(
      () => createInstanceWorktree({ instanceId: '../evil', workspace: context.workspace, worktreeRoot: context.worktreeRoot }),
      INSTANCE_WORKTREE_ERROR.INVALID,
      '实例 id 不允许 ../',
    )
    await rejectsCode(
      () => createInstanceWorktree({
        instanceId: 'i-bad-policy',
        workspace: context.workspace,
        cleanupPolicy: 'always',
        worktreeRoot: context.worktreeRoot,
      }),
      INSTANCE_WORKTREE_ERROR.INVALID,
      'cleanupPolicy 校验',
    )
    await rejectsCode(
      () => createInstanceWorktree({
        instanceId: 'i-relative-root',
        workspace: context.workspace,
        worktreeRoot: 'relative/root',
      }),
      INSTANCE_WORKTREE_ERROR.INVALID,
      'worktreeRoot 必须是绝对路径',
    )
  })

  console.log('instance-worktree.test.mjs')
  console.log(`${checks} 组通过（${assertions} 条断言）`)
} catch (error) {
  console.error('✗ 实例 worktree 自检失败')
  console.error(error)
  process.exit(1)
}
