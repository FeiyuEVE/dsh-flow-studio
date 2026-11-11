#!/usr/bin/env node
/**
 * 实例工作区客户端自检（0.13.8）：
 *  - 客户端 API 的路径 / 查询串 / 请求体（worktree 检查、删除、只删分支、全局列表、
 *    prune 预览与执行、资源事件）；
 *  - 面板渲染与交互：配置 / 未配置、ACTIVE 禁用清理并给出原因、二次确认、
 *    409 保留服务端原因、prune 预览 → 确认 → PLAN_STALE 重新预览的闭环。
 *
 * 交互用最小 hooks 探针（与 test/client-page-wiring.test.mjs 同思路）：真实 React
 * createElement，hooks 换成同步可观测实现，不挂 DOM。请求全部用桩，不发真实 fetch。
 *
 * 运行：node test/client-worktree.test.mjs
 */

import assert from 'node:assert/strict'

import React from 'react'

import {
  api, instanceWorktreePath, instanceWorktreeBranchPath, instanceWorktreesPath,
  instanceWorktreesPrunePath, instanceResourceEventsPath,
} from '../src/client/api.js'
import {
  InstanceWorktreePanel, cleanupDisabledReason, prunePlanSummary, worktreeFailurePlan,
  worktreeModeText, worktreeStateText,
} from '../src/client/instance-worktree.js'
import { bindReact } from '../src/client/runtime.js'

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

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return await handler(String(url), init)
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

function bodyOf(call) {
  return call.init && typeof call.init.body === 'string' ? JSON.parse(call.init.body) : undefined
}

// ---------------------------------------------------------------------------
// 最小 hooks 探针（真实 React createElement，hooks 同步执行、可重复 flush）
// ---------------------------------------------------------------------------

let activeProbe = null
let currentCtx = null
const treeContexts = new WeakMap()

const probeReact = {
  createElement: React.createElement,
  useState(initial) { return activeProbe.useState(initial) },
  useRef(initial) { return activeProbe.useRef(initial) },
  useMemo(factory) { return factory() },
  useCallback(fn) { return fn },
  useEffect(fn, deps) { return activeProbe.useEffect(fn, deps) },
}
bindReact(probeReact)

function sameDeps(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return false
  if (previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

function createProbe(Component, props) {
  const ctx = { nodes: new Map(), rendered: new WeakMap(), seen: new Set(), current: null, dirty: true, mounted: true }
  let rootNode = null
  let rootTree = null

  const makeNode = path => ({ path, hooks: [], hookIndex: 0, pendingEffects: [], mounted: true, children: [] })

  const hooksApi = node => ({
    useState(initial) {
      const index = node.hookIndex++
      if (!node.hooks[index]) node.hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      const hook = node.hooks[index]
      return [hook.value, next => {
        if (!ctx.mounted || !node.mounted) return
        const value = typeof next === 'function' ? next(hook.value) : next
        if (Object.is(value, hook.value)) return
        hook.value = value
        ctx.dirty = true
      }]
    },
    useRef(initial) {
      const index = node.hookIndex++
      if (!node.hooks[index]) node.hooks[index] = { kind: 'ref', current: initial }
      return node.hooks[index]
    },
    useEffect(fn, deps) {
      const index = node.hookIndex++
      node.pendingEffects.push({ index, fn, deps: Array.isArray(deps) ? deps.slice() : null })
    },
  })

  const renderOutput = (node, path) => {
    if (node === null || node === undefined || typeof node === 'boolean'
      || typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) {
      const out = node.map((child, index) => renderOutput(child, `${path}.${index}`))
      ctx.rendered.set(node, out)
      return out
    }
    if (typeof node !== 'object' || !node.type) return node
    if (typeof node.type === 'function') {
      const element = node
      let componentNode = ctx.nodes.get(path)
      if (!componentNode || componentNode.type !== element.type) {
        if (componentNode) runCleanups(componentNode)
        componentNode = makeNode(path)
        componentNode.type = element.type
        ctx.nodes.set(path, componentNode)
      }
      const target = componentNode
      ctx.seen.add(target)
      target.hookIndex = 0
      target.pendingEffects = []
      target.children = []
      const parent = ctx.current
      if (parent) parent.children.push(target)
      else rootNode = target
      ctx.current = target
      const previous = activeProbe
      activeProbe = hooksApi(target)
      let output
      try {
        output = element.type(element.props || {})
      } finally {
        activeProbe = previous
      }
      const rendered = renderOutput(output, `${path}>`)
      ctx.current = parent
      ctx.rendered.set(element, rendered)
      return element
    }
    if (node.props && node.props.children !== undefined) {
      ctx.rendered.set(node, renderOutput(node.props.children, path))
    }
    return node
  }

  const commitEffects = node => {
    for (const child of node.children) commitEffects(child)
    for (const effect of node.pendingEffects) {
      const previous = node.hooks[effect.index]
      if (previous && effect.deps !== null && sameDeps(previous.deps, effect.deps)) continue
      if (previous && typeof previous.cleanup === 'function') previous.cleanup()
      const hook = previous || {}
      hook.deps = effect.deps
      node.hooks[effect.index] = hook
      const cleanup = effect.fn()
      hook.cleanup = typeof cleanup === 'function' ? cleanup : null
    }
  }

  function runCleanups(node) {
    for (const child of node.children) runCleanups(child)
    node.mounted = false
    for (const hook of node.hooks) {
      if (hook && typeof hook.cleanup === 'function') {
        try { hook.cleanup() } catch { /* 清理失败不阻断 */ }
        hook.cleanup = null
      }
    }
  }

  const handle = {
    mounted: true,
    get tree() { return rootTree },
    flush() {
      let guard = 0
      do {
        ctx.dirty = false
        ctx.seen = new Set()
        ctx.current = null
        rootNode = null
        const root = React.createElement(Component, props)
        rootTree = renderOutput(root, '/')
        treeContexts.set(rootTree, ctx)
        currentCtx = ctx
        for (const node of [...ctx.nodes.values()]) {
          if (!ctx.seen.has(node)) {
            runCleanups(node)
            ctx.nodes.delete(node.path)
          }
        }
        commitEffects(rootNode)
      } while (ctx.dirty && (guard += 1) < 50)
    },
    unmount() {
      handle.mounted = false
      ctx.mounted = false
      if (rootNode) runCleanups(rootNode)
      ctx.nodes.clear()
    },
  }
  return handle
}

async function settle(probe, rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    if (probe.mounted) probe.flush()
    await new Promise(resolve => setImmediate(resolve))
  }
  if (probe.mounted) probe.flush()
}

function walk(node, visit, ctx) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, ctx)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  let children = node.props ? node.props.children : undefined
  if (ctx && ctx.rendered.has(node)) children = ctx.rendered.get(node)
  walk(children, visit, ctx)
}

function ctxOf(tree) {
  return treeContexts.get(tree) || currentCtx
}

function findElement(tree, predicate) {
  let found = null
  walk(tree, node => {
    if (found === null && predicate(node)) found = node
  }, ctxOf(tree))
  return found
}

function textOf(node, ctx = currentCtx) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(child => textOf(child, ctx)).join('')
  if (!node) return ''
  if (ctx && ctx.rendered.has(node)) return textOf(ctx.rendered.get(node), ctx)
  if (node.props) return textOf(node.props.children, ctx)
  return ''
}

function button(tree, action) {
  return findElement(tree, node => node.type === 'button'
    && node.props && node.props['data-action'] === action)
}

function fullText(probe) {
  return textOf(probe.tree)
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const HEAD = 'a'.repeat(40)
const PLAN_HASH = 'f'.repeat(64)

function worktreePayload(overrides = {}) {
  return {
    ok: true,
    id: 'i-1',
    configured: true,
    instanceStatus: 'COMPLETED',
    mode: 'worktree',
    workspaceId: 'abcdefabcdef',
    effectiveRoot: '/managed/worktrees/abcdefabcdef/i-1',
    cleanupPolicy: 'retain',
    worktree: {
      state: 'ok',
      path: '/managed/worktrees/abcdefabcdef/i-1',
      branch: 'flow-instance/i-1',
      head: HEAD,
      dirty: false,
      cleanable: true,
      reasons: [],
    },
    cleanable: true,
    ...overrides,
  }
}

function prunePair() {
  return {
    list: {
      ok: true,
      worktrees: [
        { instanceId: 'i-1', workspaceId: 'abcdefabcdef', instanceStatus: 'COMPLETED', path: '/w/i-1', orphan: false },
        { instanceId: 'i-orphan', workspaceId: 'abcdefabcdef', instanceStatus: null, path: '/w/i-orphan', orphan: true },
      ],
      orphans: [{ instanceId: 'i-orphan' }],
      corrupt: [],
      scannedAt: '2026-11-12T00:00:00.000Z',
    },
    preview: {
      ok: true,
      dryRun: true,
      planHash: PLAN_HASH,
      removable: 1,
      reported: 1,
      plan: {
        v: 1,
        entries: [
          { instanceId: 'i-1', workspaceId: 'abcdefabcdef', action: 'remove', reason: 'owned-terminal-clean', path: '/w/i-1', dirty: false, instanceStatus: 'COMPLETED' },
          { instanceId: 'i-orphan', workspaceId: 'abcdefabcdef', action: 'report', reason: 'no-ownership', path: '/w/i-orphan', dirty: null, instanceStatus: null },
        ],
      },
    },
  }
}

function fakeClient(options = {}) {
  const calls = []
  const client = {
    calls,
    async readInstanceWorktree(id) {
      calls.push(['read', id])
      if (options.readError) throw options.readError
      return options.payload || worktreePayload()
    },
    async removeInstanceWorktree(id, body) {
      calls.push(['remove', id, body])
      if (options.removeError) throw options.removeError
      return { ok: true, id, removed: true, branchRemoval: { removed: true, branch: 'flow-instance/i-1' } }
    },
    async removeInstanceWorktreeBranch(id) {
      calls.push(['branch', id])
      if (options.branchError) throw options.branchError
      return { ok: true, id, branchRemoval: { removed: true, branch: 'flow-instance/i-1' } }
    },
    async listInstanceWorktrees(query) {
      calls.push(['list', query])
      if (options.listError) throw options.listError
      return options.list || prunePair().list
    },
    async pruneInstanceWorktrees(body) {
      calls.push(['prune', body])
      if (options.pruneError) throw options.pruneError
      return options.pruneResult || prunePair().preview
    },
  }
  return client
}

function apiError(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  error.data = { ok: false, code, error: message }
  return error
}

try {
  console.log('client-worktree')

  // ── A. 客户端 API ───────────────────────────────────────────────────────
  await check('路径 helper：worktree / branch / 全局列表 / prune / 资源事件', () => {
    eq(instanceWorktreePath('i 1'), '/instances/i%201/worktree')
    eq(instanceWorktreeBranchPath('i-1'), '/instances/i-1/worktree/branch')
    eq(instanceWorktreesPath(), '/instance-worktrees')
    eq(instanceWorktreesPath({ workspaceId: 'abcdefabcdef' }), '/instance-worktrees?workspaceId=abcdefabcdef')
    eq(instanceWorktreesPrunePath(), '/instance-worktrees/prune')
    eq(instanceResourceEventsPath('i-1', { since: 0 }), '/instances/i-1/resource-events?since=0')
  })

  await check('API：read / remove / branch / list / prune / resource-events 的请求形状', async () => {
    await withFetch(
      url => response(200, { ok: true, url }),
      async calls => {
        await api.readInstanceWorktree('i-1')
        await api.removeInstanceWorktree('i-1', { force: true, removeBranch: true, expectedHead: HEAD })
        await api.removeInstanceWorktreeBranch('i-1')
        await api.listInstanceWorktrees({ workspaceId: 'abcdefabcdef' })
        await api.listInstanceWorktrees()
        await api.pruneInstanceWorktrees({ dryRun: true })
        await api.readInstanceResourceEvents('i-1', { since: 0 })

        deep(calls.map(call => call.url), [
          '/api/flow-studio/instances/i-1/worktree',
          '/api/flow-studio/instances/i-1/worktree',
          '/api/flow-studio/instances/i-1/worktree/branch',
          '/api/flow-studio/instance-worktrees?workspaceId=abcdefabcdef',
          '/api/flow-studio/instance-worktrees',
          '/api/flow-studio/instance-worktrees/prune',
          '/api/flow-studio/instances/i-1/resource-events?since=0',
        ])
        deep(calls.map(call => call.init.method), ['GET', 'DELETE', 'DELETE', 'GET', 'GET', 'POST', 'GET'])
        eq(bodyOf(calls[0]), undefined, 'GET 不带请求体')
        deep(bodyOf(calls[1]), { force: true, removeBranch: true, expectedHead: HEAD })
        eq(bodyOf(calls[2]), undefined, '只删分支不带请求体')
        deep(bodyOf(calls[5]), { dryRun: true })
        eq(bodyOf(calls[6]), undefined)
      },
    )
  })

  await check('API：失败按 ApiError 风格抛（status / code / data / 服务端原因）', async () => {
    await withFetch(
      () => response(409, { ok: false, code: 'INSTANCE_WORKTREE_PLAN_STALE', error: '旧 planHash 失效' }),
      async () => {
        let caught = null
        try {
          await api.pruneInstanceWorktrees({ dryRun: false, planHash: PLAN_HASH })
        } catch (error) {
          caught = error
        }
        ok(caught !== null)
        eq(caught.status, 409)
        eq(caught.code, 'INSTANCE_WORKTREE_PLAN_STALE')
        eq(caught.data.error, '旧 planHash 失效')
        ok(caught.message.includes('旧 planHash 失效'))
      },
    )
  })

  // ── B. 面板纯函数 ───────────────────────────────────────────────────────
  await check('面板纯函数：模式 / 状态 / 清理禁用原因 / 预览计数', () => {
    eq(worktreeModeText(worktreePayload()), 'worktree 隔离')
    eq(worktreeModeText({ configured: true, worktree: null, mode: 'off' }), '原目录')
    eq(worktreeModeText({ configured: false }), '未配置')
    eq(worktreeModeText(null), '未配置')
    eq(worktreeStateText('ok'), '正常')
    eq(worktreeStateText('dirty'), '有未提交改动')
    eq(worktreeStateText('weird'), 'weird')

    eq(cleanupDisabledReason(worktreePayload()), '')
    ok(cleanupDisabledReason(worktreePayload({ instanceStatus: 'ACTIVE' })).includes('ACTIVE'))
    ok(cleanupDisabledReason(worktreePayload({ instanceStatus: 'SUSPENDED' })).includes('SUSPENDED'))
    ok(cleanupDisabledReason({ configured: false }).includes('没有登记'))

    const summary = prunePlanSummary(prunePair().preview.plan)
    deep(summary, { remove: 1, retain: 0, report: 1, total: 2 })

    const stale = worktreeFailurePlan('prune', apiError(409, 'INSTANCE_WORKTREE_PLAN_STALE', '旧 planHash 失效'))
    eq(stale.kind, 'warn')
    eq(stale.stale, true)
    ok(stale.text.includes('重新预览'))
    ok(stale.text.includes('旧 planHash 失效'))
  })

  // ── C. 面板渲染 / 交互 ──────────────────────────────────────────────────
  await check('面板：配置 worktree 时显示模式 / 路径 / 分支 / HEAD / dirty / 可清理', async () => {
    const client = fakeClient()
    const probe = createProbe(InstanceWorktreePanel, { client, instanceId: 'i-1' })
    try {
      probe.flush()
      await settle(probe)
      const text = fullText(probe)
      ok(text.includes('worktree 隔离'))
      ok(text.includes('/managed/worktrees/abcdefabcdef/i-1'))
      ok(text.includes('flow-instance/i-1'))
      ok(text.includes('aaaaaaaaaaaa'), 'HEAD 显示前 12 位')
      ok(text.includes('工作树干净'))
      ok(text.includes('可清理'))
      ok(button(probe.tree, 'worktree-remove') !== null)
      ok(button(probe.tree, 'worktree-branch') !== null)
      eq(client.calls[0][0], 'read')
    } finally {
      probe.unmount()
    }
  })

  await check('面板：未配置 / 原目录分别给出可读空态', async () => {
    const unconfigured = createProbe(InstanceWorktreePanel, {
      client: fakeClient({ payload: { ok: true, id: 'i-1', configured: false, instanceStatus: 'COMPLETED' } }),
      instanceId: 'i-1',
    })
    try {
      unconfigured.flush()
      await settle(unconfigured)
      ok(fullText(unconfigured).includes('未配置工作区'))
    } finally {
      unconfigured.unmount()
    }

    const directory = createProbe(InstanceWorktreePanel, {
      client: fakeClient({
        payload: {
          ok: true, id: 'i-1', configured: true, instanceStatus: 'COMPLETED', mode: 'off',
          effectiveRoot: '/repo/project', cleanupPolicy: 'retain', worktree: null, cleanable: false,
        },
      }),
      instanceId: 'i-1',
    })
    try {
      directory.flush()
      await settle(directory)
      const text = fullText(directory)
      ok(text.includes('原目录'))
      ok(text.includes('/repo/project'))
      ok(text.includes('没有独立工作树'))
    } finally {
      directory.unmount()
    }
  })

  await check('面板：ACTIVE 时清理按钮禁用并给出原因', async () => {
    const probe = createProbe(InstanceWorktreePanel, {
      client: fakeClient({
        payload: worktreePayload({ instanceStatus: 'ACTIVE', cleanable: false }),
      }),
      instanceId: 'i-1',
    })
    try {
      probe.flush()
      await settle(probe)
      const remove = button(probe.tree, 'worktree-remove')
      const branch = button(probe.tree, 'worktree-branch')
      ok(remove !== null && branch !== null)
      eq(remove.props.disabled, true)
      eq(branch.props.disabled, true)
      ok(/ACTIVE/.test(remove.props.title))
      const blocked = findElement(probe.tree, node => node.props && node.props['data-wt-blocked'] === 'true')
      ok(blocked !== null)
      ok(textOf(blocked).includes('禁止清理工作树'))
    } finally {
      probe.unmount()
    }
  })

  await check('面板：危险操作二次确认，请求带 expectedHead / removeBranch，409 保留服务端原因', async () => {
    const notices = []
    const client = fakeClient({
      removeError: apiError(409, 'INSTANCE_WORKTREE_INSTANCE_ACTIVE', '实例 i-1 当前是 ACTIVE：禁止清理工作树'),
    })
    const probe = createProbe(InstanceWorktreePanel, {
      client,
      instanceId: 'i-1',
      notice: (kind, text) => notices.push({ kind, text }),
      onChanged: () => notices.push({ kind: 'changed', text: '' }),
    })
    try {
      probe.flush()
      await settle(probe)
      ok(button(probe.tree, 'worktree-remove-confirm') === null, '未确认前不出现确认按钮')

      button(probe.tree, 'worktree-remove').props.onClick()
      probe.flush()
      const confirm = findElement(probe.tree, node => node.props && node.props['data-wt-confirm'] === 'remove')
      ok(confirm !== null)
      ok(textOf(confirm).includes('不可撤销'))
      ok(textOf(confirm).includes('未合并提交'), '危险确认文案覆盖强删未合并提交')

      // 取消 removeBranch 勾选，验证请求体跟随 UI。
      const option = findElement(probe.tree, node => node.props && node.props['data-action'] === 'worktree-remove-branch-option')
      option.props.onChange({ target: { checked: false } })
      probe.flush()
      button(probe.tree, 'worktree-remove-confirm').props.onClick()
      await settle(probe)

      const removeCall = client.calls.find(call => call[0] === 'remove')
      ok(removeCall !== undefined)
      eq(removeCall[2].removeBranch, false)
      eq(removeCall[2].expectedHead, HEAD)
      ok(!('force' in removeCall[2]))

      const warned = notices.find(item => item.kind === 'warn')
      ok(warned !== undefined)
      ok(warned.text.includes('禁止清理工作树'), '保留服务端原因')
      ok(warned.text.includes('ACTIVE'))
      ok(!notices.some(item => item.kind === 'changed'), '失败不刷新列表')
    } finally {
      probe.unmount()
    }
  })

  await check('面板：删除成功后发 notice 并刷新实例列表', async () => {
    const notices = []
    const client = fakeClient()
    const probe = createProbe(InstanceWorktreePanel, {
      client,
      instanceId: 'i-1',
      notice: (kind, text) => notices.push({ kind, text }),
      onChanged: () => notices.push({ kind: 'changed', text: '' }),
    })
    try {
      probe.flush()
      await settle(probe)
      button(probe.tree, 'worktree-remove').props.onClick()
      probe.flush()
      button(probe.tree, 'worktree-remove-confirm').props.onClick()
      await settle(probe)
      ok(notices.some(item => item.kind === 'success' && item.text.includes('工作树已删除')))
      ok(notices.some(item => item.kind === 'changed'), '成功后刷新实例 / 列表')
      const reads = client.calls.filter(call => call[0] === 'read').length
      ok(reads >= 2, '删除后重新检查工作区')
    } finally {
      probe.unmount()
    }
  })

  await check('面板：prune 先列清单 + dryRun 预览，确认后才带 planHash 执行', async () => {
    const notices = []
    const pair = prunePair()
    const client = fakeClient({ list: pair.list, pruneResult: pair.preview })
    let executed = null
    const original = client.pruneInstanceWorktrees
    client.pruneInstanceWorktrees = async body => {
      if (body && body.dryRun === false) {
        executed = body
        return { ok: true, dryRun: false, planHash: PLAN_HASH, removed: [{ instanceId: 'i-1' }], skipped: [] }
      }
      return await original(body)
    }
    const probe = createProbe(InstanceWorktreePanel, {
      client,
      instanceId: '',
      notice: (kind, text) => notices.push({ kind, text }),
    })
    try {
      probe.flush()
      await settle(probe)
      ok(button(probe.tree, 'worktree-prune-open') !== null, '未选实例也能进入全局清理')

      button(probe.tree, 'worktree-prune-open').props.onClick()
      await settle(probe)
      const text = fullText(probe)
      ok(text.includes('共 2 个实例工作树，其中孤儿 1 个'))
      ok(text.includes('孤儿'))
      ok(text.includes('将删除'))
      ok(text.includes('保留') || text.includes('仅报告'))
      ok(text.includes(PLAN_HASH), '展示 planHash')
      const previewCall = client.calls.find(call => call[0] === 'prune')
      eq(previewCall[1].dryRun, true)

      button(probe.tree, 'worktree-prune-exec').props.onClick()
      await settle(probe)
      deep(executed, { dryRun: false, planHash: PLAN_HASH })
      const success = notices.find(item => item.kind === 'success')
      ok(success !== undefined && success.text.includes('删除 1 个'))
    } finally {
      probe.unmount()
    }
  })

  await check('面板：执行时 409 PLAN_STALE → 提示重新预览、清掉旧 planHash', async () => {
    const notices = []
    const pair = prunePair()
    const client = fakeClient({ list: pair.list, pruneResult: pair.preview })
    let executed = null
    let execCount = 0
    const original = client.pruneInstanceWorktrees
    client.pruneInstanceWorktrees = async body => {
      if (body && body.dryRun === false) {
        executed = body
        execCount += 1
        throw apiError(409, 'INSTANCE_WORKTREE_PLAN_STALE', '工作区状态已变化，旧 planHash 失效，请重新预览')
      }
      return await original(body)
    }
    const probe = createProbe(InstanceWorktreePanel, {
      client,
      instanceId: '',
      notice: (kind, text) => notices.push({ kind, text }),
    })
    try {
      probe.flush()
      await settle(probe)
      button(probe.tree, 'worktree-prune-open').props.onClick()
      await settle(probe)
      ok(button(probe.tree, 'worktree-prune-exec') !== null)

      button(probe.tree, 'worktree-prune-exec').props.onClick()
      await settle(probe)
      deep(executed, { dryRun: false, planHash: PLAN_HASH })
      const warned = notices.find(item => item.kind === 'warn')
      ok(warned !== undefined)
      ok(warned.text.includes('旧 planHash 失效'), '保留服务端原因')
      ok(warned.text.includes('重新预览'))

      eq(button(probe.tree, 'worktree-prune-exec'), null, '旧 planHash 已清除，不能重发')
      const stale = findElement(probe.tree, node => node.props && node.props['data-prune-stale'] === 'true')
      ok(stale !== null, '给出重新预览入口')
      eq(execCount, 1, '不自动重试旧 planHash')
      ok(button(probe.tree, 'worktree-prune-preview') !== null)
    } finally {
      probe.unmount()
    }
  })
} finally {
  // 本文件不写盘；保持 finally 结构，便于以后加 fixture 时集中清理。
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 组失败：`)
  for (const failure of failures) {
    console.error(`- ${failure.name}: ${failure.error && failure.error.stack ? failure.error.stack : failure.error}`)
  }
  process.exit(1)
}
console.log(`\n${checks} 组通过（${assertions} 条断言）`)
