#!/usr/bin/env node
/**
 * 实例域模型工具自检（0.13.8）：`flow_instance_worktrees`。
 *
 * 覆盖：
 *  - 参数校验（action / instanceId / workspaceId / planHash / expectedHead / 布尔项）；
 *  - inspect / remove / branch / list / prune(dryRun) 的路由映射与结果形状；
 *  - prune 默认只预览、带 planHash 仍只预览、只有 dryRun:false 且带 planHash 才执行；
 *  - 409 PLAN_STALE / ACTIVE 的失败分流（保留服务端原因与 code）；
 *  - 结果裁剪（长字符串 2 KiB、数组上限）；
 *  - 与真实 BpmnRuntime.handle 的一致性（同一份实现，不复制业务逻辑）；
 *  - apply() 在没有 tools 服务时跳过注册、不炸。
 *
 * 运行：node test/instance-tools.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-instance-tools-'))
process.env.DSH_HOME = home

const { createInstanceTools } = await import('../src/instance-tools.js')
const { createBpmnRuntime } = await import('../src/bpmn-runtime.js')
const { apply } = await import('../src/index.js')

let checks = 0
let assertions = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    checks += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}`)
    console.log('    ' + String((error && error.message) || error))
  }
}

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

/** 记录每次 runtime.handle 请求；handler 返回 `{status, body}`。 */
function makeRuntime(handler) {
  const calls = []
  return {
    calls,
    async handle(request) {
      calls.push({
        method: request.method,
        parts: Array.isArray(request.parts) ? request.parts.slice() : request.parts,
        search: request.url instanceof URL ? request.url.search : String(request.url || ''),
        body: request.body,
      })
      return await handler(request)
    },
  }
}

const OK_BODY = {
  ok: true,
  configured: true,
  instanceStatus: 'COMPLETED',
  mode: 'worktree',
  id: 'i-1',
  workspaceId: 'abcdefabcdef',
  effectiveRoot: '/managed/worktrees/abcdefabcdef/i-1',
  cleanupPolicy: 'retain',
  worktree: {
    state: 'ok',
    path: '/managed/worktrees/abcdefabcdef/i-1',
    branch: 'flow-instance/i-1',
    head: 'a'.repeat(40),
    dirty: false,
    cleanable: true,
    reasons: [],
  },
  cleanable: true,
}

function toolOf(runtime) {
  const tools = createInstanceTools({ runtime })
  eq(tools.length, 13, '实例域工具：11 个既有 + E4 的挂起 / 恢复 2 个')
  const worktree = tools.find(tool => tool.name === 'flow_instance_worktrees')
  ok(worktree, '注册了 flow_instance_worktrees')
  return worktree
}


try {
  console.log('instance-tools')

  await check('createInstanceTools 需要 runtime / getRuntime', () => {
    assert.throws(() => createInstanceTools({}), /runtime/)
    assertions += 1
    const runtime = makeRuntime(async () => ({ status: 200, body: { ok: true } }))
    ok(createInstanceTools({ getRuntime: () => runtime }).length === 13)
  })

  await check('参数：缺少 / 非法 action 在调用 runtime 前就失败', async () => {
    const runtime = makeRuntime(async () => ({ status: 200, body: { ok: true } }))
    const tool = toolOf(runtime)
    const missing = await tool.execute({})
    eq(missing.ok, false)
    ok(/缺少必填参数 action/.test(missing.error))
    ok(typeof missing.hint === 'string' && missing.hint.length > 0)
    const invalid = await tool.execute({ action: 'delete' })
    eq(invalid.ok, false)
    ok(/action/.test(invalid.error))
    eq(runtime.calls.length, 0, '参数错误不能发请求')
  })

  await check('参数：inspect / remove / branch 必须带合法 instanceId', async () => {
    const runtime = makeRuntime(async () => ({ status: 200, body: { ok: true } }))
    const tool = toolOf(runtime)
    for (const action of ['inspect', 'remove', 'branch']) {
      const result = await tool.execute({ action })
      eq(result.ok, false, `${action} 缺 instanceId`)
      ok(/需要 instanceId/.test(result.error))
      const bad = await tool.execute({ action, instanceId: '../etc/passwd' })
      eq(bad.ok, false)
      ok(/instanceId 不合法/.test(bad.error))
    }
    eq(runtime.calls.length, 0)
  })

  await check('参数：workspaceId / planHash / expectedHead / 布尔项格式', async () => {
    const runtime = makeRuntime(async () => ({ status: 200, body: { ok: true } }))
    const tool = toolOf(runtime)
    eq((await tool.execute({ action: 'list', workspaceId: 'XYZ' })).ok, false)
    eq((await tool.execute({ action: 'prune', planHash: 'abc' })).ok, false)
    eq((await tool.execute({ action: 'remove', instanceId: 'i-1', expectedHead: 'abc' })).ok, false)
    eq((await tool.execute({ action: 'remove', instanceId: 'i-1', force: 'yes' })).ok, false)
    eq(runtime.calls.length, 0)
  })

  await check('inspect：GET /instances/<id>/worktree，结果保持 Host 形状', async () => {
    const runtime = makeRuntime(async () => ({ status: 200, body: { ...OK_BODY } }))
    const tool = toolOf(runtime)
    const result = await tool.execute({ action: 'inspect', instanceId: 'i-1' })
    eq(result.ok, true)
    eq(result.action, 'inspect')
    eq(result.status, 200)
    eq(result.configured, true)
    eq(result.worktree.state, 'ok')
    eq(result.worktree.branch, 'flow-instance/i-1')
    deep(runtime.calls[0].parts, ['instances', 'i-1', 'worktree'])
    eq(runtime.calls[0].method, 'GET')
    eq(runtime.calls[0].body, undefined)
  })

  await check('remove：DELETE + {force, removeBranch, expectedHead}', async () => {
    const runtime = makeRuntime(async () => ({
      status: 200,
      body: { ok: true, id: 'i-1', removed: true, path: '/x', branch: 'flow-instance/i-1', branchRemoval: { removed: true } },
    }))
    const tool = toolOf(runtime)
    const result = await tool.execute({
      action: 'remove',
      instanceId: 'i-1',
      force: true,
      removeBranch: true,
      expectedHead: 'b'.repeat(40),
    })
    eq(result.ok, true)
    eq(result.removed, true)
    eq(runtime.calls[0].method, 'DELETE')
    deep(runtime.calls[0].body, {
      force: true, removeBranch: true, expectedHead: 'b'.repeat(40),
    })
  })

  await check('branch：DELETE /instances/<id>/worktree/branch，不带请求体', async () => {
    const runtime = makeRuntime(async () => ({
      status: 200,
      body: { ok: true, id: 'i-1', branchRemoval: { removed: true, branch: 'flow-instance/i-1' } },
    }))
    const tool = toolOf(runtime)
    const result = await tool.execute({ action: 'branch', instanceId: 'i-1' })
    eq(result.ok, true)
    deep(runtime.calls[0].parts, ['instances', 'i-1', 'worktree', 'branch'])
    eq(runtime.calls[0].method, 'DELETE')
    eq(runtime.calls[0].body, undefined)
  })

  await check('list：GET /instance-worktrees[?workspaceId=]，包含 orphan 清单', async () => {
    const runtime = makeRuntime(async () => ({
      status: 200,
      body: {
        ok: true,
        worktrees: [{ instanceId: 'i-1', orphan: false }, { instanceId: 'i-2', orphan: true }],
        orphans: [{ instanceId: 'i-2' }],
        corrupt: [],
        scannedAt: '2026-11-12T00:00:00.000Z',
      },
    }))
    const tool = toolOf(runtime)
    const result = await tool.execute({ action: 'list', workspaceId: 'abcdefabcdef' })
    eq(result.ok, true)
    eq(result.worktrees.length, 2)
    eq(result.orphans.length, 1)
    eq(result.worktreeCount, 2, '未裁剪时计数等于清单长度')
    eq(result.orphanCount, 1)
    eq(result.truncated, false)
    deep(runtime.calls[0].parts, ['instance-worktrees'])
    eq(runtime.calls[0].method, 'GET')
    eq(runtime.calls[0].search, '?workspaceId=abcdefabcdef')
  })

  await check('MINOR：数组裁剪后计数仍用裁剪前的真实数量', async () => {
    const many = Array.from({ length: 250 }, (_, index) => ({
      instanceId: `i-${index}`, orphan: false, path: `/managed/worktrees/abcdefabcdef/i-${index}`,
    }))
    const listRuntime = makeRuntime(async () => ({
      status: 200,
      body: {
        ok: true,
        worktrees: many,
        orphans: [{ instanceId: 'i-0' }],
        corrupt: [],
        scannedAt: '2026-11-12T00:00:00.000Z',
      },
    }))
    const listTool = toolOf(listRuntime)
    const listed = await listTool.execute({ action: 'list' })
    eq(listed.worktreeCount, 250, '裁剪前总数')
    eq(listed.orphanCount, 1, '孤儿数来自裁剪前数组')
    eq(listed.worktrees.length, 201, '展示数组仍是 200 项 + 一条省略提示')
    const listText = listTool.output.render(listed)[0].text
    ok(listText.includes('共 250 个'), '文本报告 250（不是 201）')
    ok(!listText.includes('共 201 个'), '不再把省略提示计作资源')

    const removed = Array.from({ length: 250 }, (_, index) => ({ instanceId: `i-${index}` }))
    const skipped = Array.from({ length: 210 }, (_, index) => ({ instanceId: `s-${index}` }))
    const pruneRuntime = makeRuntime(async () => ({
      status: 200,
      body: { ok: true, dryRun: false, planHash: 'c'.repeat(64), removed, skipped },
    }))
    const pruneTool = toolOf(pruneRuntime)
    const executed = await pruneTool.execute({ action: 'prune', planHash: 'c'.repeat(64), dryRun: false })
    eq(executed.removedCount, 250, '删除数用裁剪前数组')
    eq(executed.skippedCount, 210, '跳过数用裁剪前数组')
    eq(executed.removed.length, 201, '删除数组被裁剪')
    eq(executed.skipped.length, 201, '跳过数组被裁剪')
    const pruneText = pruneTool.output.render(executed)[0].text
    ok(pruneText.includes('删除 250 个、跳过 210 个'), '文本计数不再多算省略提示')
  })

  await check('F8 省略 dryRun：带 planHash 也只预览；只有 dryRun:false 才执行删除', async () => {
    const runtime = makeRuntime(async request => ({
      status: 200,
      body: request.body && request.body.dryRun === false
        ? { ok: true, dryRun: false, planHash: 'c'.repeat(64), removed: [], skipped: [] }
        : {
          ok: true,
          dryRun: true,
          planHash: 'c'.repeat(64),
          plan: { v: 1, entries: [] },
          removable: 0,
          reported: 0,
        },
    }))
    const tool = toolOf(runtime)

    const preview = await tool.execute({ action: 'prune' })
    eq(preview.ok, true)
    eq(preview.dryRun, true)
    deep(runtime.calls[0].body, { dryRun: true })

    // 复审 F8：planHash 只证明「计划身份」，不能代替执行意图；省略 dryRun 仍是预览。
    const hashOnly = await tool.execute({ action: 'prune', planHash: 'c'.repeat(64) })
    eq(hashOnly.ok, true)
    eq(hashOnly.dryRun, true, '只带 planHash 不能执行删除（默认 dryRun:true）')
    deep(runtime.calls[1].body, { dryRun: true, planHash: 'c'.repeat(64) }, '省略 dryRun 时请求体必须 dryRun:true')

    const explicitPreview = await tool.execute({ action: 'prune', planHash: 'c'.repeat(64), dryRun: true })
    eq(explicitPreview.dryRun, true)
    deep(runtime.calls[2].body, { dryRun: true, planHash: 'c'.repeat(64) })

    // 只有显式 dryRun:false（且带 planHash）才是执行意图。
    const executed = await tool.execute({ action: 'prune', planHash: 'c'.repeat(64), dryRun: false })
    eq(executed.ok, true)
    eq(executed.dryRun, false)
    deep(runtime.calls[3].body, { dryRun: false, planHash: 'c'.repeat(64) }, '只有显式 dryRun:false 才请求执行')
  })

  await check('prune：dryRun:false 缺 planHash 在本地拒绝，不发请求', async () => {
    const runtime = makeRuntime(async () => ({ status: 200, body: { ok: true } }))
    const tool = toolOf(runtime)
    const result = await tool.execute({ action: 'prune', dryRun: false })
    eq(result.ok, false)
    ok(/必须带预览返回的 planHash/.test(result.error))
    eq(result.retryable, false)
    eq(runtime.calls.length, 0)
  })

  await check('失败分流：409 PLAN_STALE → 保留 code、提示重新预览', async () => {
    const runtime = makeRuntime(async () => ({
      status: 409,
      body: { ok: false, code: 'INSTANCE_WORKTREE_PLAN_STALE', error: '工作区状态已变化，旧 planHash 失效，请重新预览' },
    }))
    const tool = toolOf(runtime)
    const result = await tool.execute({ action: 'prune', planHash: 'd'.repeat(64), dryRun: false })
    eq(result.ok, false)
    eq(result.status, 409)
    eq(result.code, 'INSTANCE_WORKTREE_PLAN_STALE')
    eq(result.retryable, false)
    ok(result.error.includes('旧 planHash 失效'))
    ok(/重新调 action:"prune"|重新/.test(result.hint))
    ok(result.hint.includes('planHash'))
  })

  await check('失败分流：ACTIVE 409 → force 不能越过实例状态', async () => {
    const runtime = makeRuntime(async () => ({
      status: 409,
      body: { ok: false, code: 'INSTANCE_WORKTREE_INSTANCE_ACTIVE', error: '实例 i-1 当前是 ACTIVE：禁止清理工作树（force 不能越过此限制）' },
    }))
    const tool = toolOf(runtime)
    const result = await tool.execute({ action: 'remove', instanceId: 'i-1', force: true })
    eq(result.ok, false)
    eq(result.code, 'INSTANCE_WORKTREE_INSTANCE_ACTIVE')
    ok(result.hint.includes('ACTIVE'))
    ok(result.error.includes('force 不能越过'))
    // 0.14.1：停止实例的正确入口是 POST /instances/<id>/stop / flow_instance_cancel，
    // 不是已删除的 flow_stop，也不是返回 405 的 DELETE。
    ok(result.hint.includes('POST /instances/<id>/stop'))
    ok(result.hint.includes('flow_instance_cancel'))
    eq(result.hint.includes('flow_stop'), false)
    eq(result.hint.includes('DELETE '), false)
  })

  await check('结果裁剪：长字符串截到 2 KiB，数组上限 200 项', async () => {
    const long = '长'.repeat(3000)
    const runtime = makeRuntime(async () => ({
      status: 200,
      body: {
        ok: true,
        warning: long,
        worktree: { state: 'ok', reasons: [long] },
        items: Array.from({ length: 250 }, (_, index) => ({ index })),
      },
    }))
    const tool = toolOf(runtime)
    const result = await tool.execute({ action: 'inspect', instanceId: 'i-1' })
    eq(result.ok, true)
    ok(Buffer.byteLength(result.warning, 'utf8') <= 2 * 1024 + 200, '长字段不超过 2 KiB（含截断标记）')
    ok(result.warning.includes('已截断'))
    ok(result.worktree.reasons[0].includes('已截断'))
    eq(result.items.length, 201, '数组保留 200 项 + 一条省略说明')
    ok(/省略/.test(result.items[200]))
    // 输出必须仍是可 JSON 往返的纯数据。
    deep(JSON.parse(JSON.stringify(result)), result)
  })

  await check('与真实 BpmnRuntime 一致：list / inspect 走同一份实现', async () => {
    const runtime = createBpmnRuntime({ dir: join(home, 'flow-studio'), env: {} })
    const tools = createInstanceTools({ runtime })
    try {
      const toolList = await tools.find(tool => tool.name === 'flow_instance_worktrees').execute({ action: 'list' })
      eq(toolList.ok, true)
      const routeList = await runtime.handle({
        method: 'GET',
        parts: ['instance-worktrees'],
        url: new URL('http://localhost/'),
      })
      eq(routeList.status, 200)
      deep(toolList.worktrees, routeList.body.worktrees, '工具与路由返回同一份清单')
      deep(toolList.orphans, routeList.body.orphans)

      const routeMissing = await runtime.handle({
        method: 'GET',
        parts: ['instances', 'i-missing', 'worktree'],
        url: new URL('http://localhost/'),
      })
      const toolMissing = await tools.find(tool => tool.name === 'flow_instance_worktrees').execute({ action: 'inspect', instanceId: 'i-missing' })
      eq(toolMissing.ok, false)
      eq(toolMissing.status, routeMissing.status)
      eq(toolMissing.code, routeMissing.body.code)
      eq(toolMissing.error, routeMissing.body.error)
    } finally {
      await runtime.dispose()
    }
  })

  await check('E4 suspend / resume：注册、参数校验、路由映射与会话绑定', async () => {
    const calls = []
    const runtime = makeRuntime(async request => {
      calls.push(request)
      const suspend = request.parts[2] === 'suspend'
      return {
        status: 200,
        body: {
          ok: true,
          id: 'i-1',
          status: suspend ? 'SUSPENDED' : 'ACTIVE',
          reason: request.body && request.body.reason !== undefined ? request.body.reason : null,
          lastSeq: 12,
          ...(suspend ? { suspendedAt: '2026-11-12T00:00:00.000Z' } : { resumedAt: '2026-11-12T00:00:01.000Z' }),
        },
      }
    })
    const tools = createInstanceTools({ runtime })
    eq(tools.length, 13)
    const suspendTool = tools.find(tool => tool.name === 'flow_instance_suspend')
    const resumeTool = tools.find(tool => tool.name === 'flow_instance_resume')
    ok(suspendTool, '注册了 flow_instance_suspend')
    ok(resumeTool, '注册了 flow_instance_resume')

    const suspended = await suspendTool.execute({ instanceId: 'i-1', reason: '窗口维护' })
    eq(suspended.ok, true, JSON.stringify(suspended))
    eq(suspended.action, 'suspend')
    eq(suspended.status, 'SUSPENDED')
    eq(suspended.reason, '窗口维护')
    eq(suspended.lastSeq, 12)
    eq(suspended.suspendedAt, '2026-11-12T00:00:00.000Z')
    deep(calls[0].parts, ['instances', 'i-1', 'suspend'])
    eq(calls[0].method, 'POST')
    deep(calls[0].body, { reason: '窗口维护' })

    const resumed = await resumeTool.execute({ instanceId: 'i-1' })
    eq(resumed.ok, true, JSON.stringify(resumed))
    eq(resumed.status, 'ACTIVE')
    deep(calls[1].parts, ['instances', 'i-1', 'resume'])
    deep(calls[1].body, {}, '省略 reason 时只发空对象')

    // 参数错误在本地拒绝，不发请求。
    const badId = await suspendTool.execute({ instanceId: '../etc/passwd' })
    eq(badId.ok, false)
    ok(/instanceId 不合法/.test(badId.error))
    const longReason = await suspendTool.execute({ instanceId: 'i-1', reason: '长'.repeat(201) })
    eq(longReason.ok, false)
    ok(/200/.test(longReason.error))
    eq(calls.length, 2, '本地参数错误不发请求')

    // 绑定会话：省略 instanceId 用绑定值，显式改成别的实例被本地拒绝。
    const boundTools = createInstanceTools({ runtime, binding: { instanceId: 'i-bound' } })
    const boundSuspend = boundTools.find(tool => tool.name === 'flow_instance_suspend')
    const bound = await boundSuspend.execute({})
    eq(bound.ok, true)
    deep(calls[2].parts, ['instances', 'i-bound', 'suspend'])
    const cross = await boundSuspend.execute({ instanceId: 'i-other' })
    eq(cross.ok, false)
    ok(/不能通过改 instanceId/.test(cross.error))
    eq(calls.length, 3, '跨实例参数不发请求')
  })

  await check('E4 suspend：INSTANCE_SUSPEND_BUSY 保留 activities[] 与可读 hint', async () => {
    const runtime = makeRuntime(async () => ({
      status: 409,
      body: {
        ok: false,
        code: 'INSTANCE_SUSPEND_BUSY',
        error: '实例 i-1 还有未结束的活动，不能挂起：agent 活动 agent1 正在执行。等活动结束后再挂起。',
        activities: [{ kind: 'agent', activityId: 'agent1', executionId: 'agent1_1', state: 'running' }],
      },
    }))
    const tool = createInstanceTools({ runtime }).find(item => item.name === 'flow_instance_suspend')
    const result = await tool.execute({ instanceId: 'i-1' })
    eq(result.ok, false)
    eq(result.status, 409)
    eq(result.code, 'INSTANCE_SUSPEND_BUSY')
    eq(result.retryable, false)
    eq(result.activities.length, 1)
    eq(result.activities[0].kind, 'agent')
    ok(/未结束的活动/.test(result.error))
    ok(result.hint.includes('等活动结束'))
  })

  await check('E4 resume / complete_task：SUSPENDED 状态错误码映射到中文 hint', async () => {
    const runtime = makeRuntime(async request => {
      if (request.parts[2] === 'resume') {
        return {
          status: 409,
          body: { ok: false, code: 'INSTANCE_NOT_SUSPENDED', error: '实例 i-1 当前状态是 ACTIVE，只有 SUSPENDED 才能恢复' },
        }
      }
      return {
        status: 409,
        body: { ok: false, code: 'INSTANCE_SUSPENDED', error: '实例 i-1 已挂起（SUSPENDED），挂起期间不能完成人工任务' },
      }
    })
    const tools = createInstanceTools({ runtime })
    const resume = await tools.find(tool => tool.name === 'flow_instance_resume').execute({ instanceId: 'i-1' })
    eq(resume.ok, false)
    eq(resume.code, 'INSTANCE_NOT_SUSPENDED')
    ok(resume.hint.includes('SUSPENDED') || resume.hint.includes('挂起'))

    const done = await tools.find(tool => tool.name === 'flow_instance_complete_task')
      .execute({ instanceId: 'i-1', activityId: 'human1' })
    eq(done.ok, false)
    eq(done.code, 'INSTANCE_SUSPENDED')
    ok(done.hint.includes('flow_instance_resume'), '挂起时完成任务的 hint 指向 resume')
  })

  await check('apply()：没有 tools 服务时跳过注册，路由照常挂载', () => {
    const registered = []
    const routes = []
    const ctx = {
      routes,
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
      effect(fn) {
        return fn()
      },
      logger: { warn() {}, info() {}, error() {} },
      get() { return undefined },
    }
    apply(ctx)
    eq(routes.length, 1, '/api/flow-studio 前缀路由照常注册')
    eq(registered.length, 0, '没有 tools 服务时没有工具被注册')
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 组失败：`)
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error && failure.error.stack ? failure.error.stack : failure.error}`)
  process.exit(1)
}
console.log(`\n${checks} 组通过（${assertions} 条断言）`)
