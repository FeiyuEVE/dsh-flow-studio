#!/usr/bin/env node
/**
 * A3 自检：agent 节点执行 = **AgentAdapter + `flow_finish_node` 完结门**。
 *
 * 契约：`docs/design/11-node-finish-tool.md` §3.1 / §5 / §6 / §7；适配器冻结形状见
 * `src/agent-adapter.js`，闸门见 `src/node-finish.js`，生命周期见 `src/agent-execute.js`。
 *
 * 覆盖（11 §7 的 8 条验收）：
 *   1. 正常：工具受理 → `activity/end` 带 output/artifacts/summary，实例变量注入 verdict，
 *      网关按 verdict 路由到正确分支；
 *   2. 不调工具：reminders=3 → `NODE_FINISH_MISSING`，实例仍 ACTIVE + lastError；
 *   3. 变量超限 → `NODE_VARIABLES_INVALID`，节点不结束；
 *   4. 文档不存在 / 路径越界 → `NODE_DOCUMENT_INVALID`；
 *   5. 重复完结 → `NODE_ALREADY_FINISHED`，产物索引不重复追加（两节点同文件只登记一次）；
 *   6. 超时 → `BPMN_ACTIVITY_TIMEOUT` + adapter.cancel + dispose（不留僵尸）；
 *   7. 提醒经 handler `events[]` 出现在实例事件流（`agent/reminder`, count=1）；
 *   8. admission：非 native / probe 失败 → 零派发 + `NODE_FINISH_TOOL_UNAVAILABLE`；
 *      未知 adapter → `BPMN_AGENT_ADAPTER_UNSUPPORTED`。
 *   9. review-0136 F5：成功只认 `gate.result`——先 `finishGate.abort()` 再自报
 *      `{ok:true, record}` 必须失败；适配器自报的 record 不能覆盖受理结果；
 *      既没提交也没 abort 的「自称成功」必须 `NODE_FINISH_INVALID`（不能挂住）。
 *
 * 全程假适配器（不真起 dsh 会话 / 不跑 codex / 不发网络）；临时工作区在 `<repo>/.tmp/`。
 * 运行：node test/agent-execute.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ADAPTER_ERROR, createAdapterRegistry } from '../src/agent-adapter.js'
import {
  AGENT_EXECUTE_ERROR, admitAdapter, createAdapterProbeCache, resolveAgentTimeoutMs, runAgentNode,
} from '../src/agent-execute.js'
import { executeAgent, createBpmnRuntime } from '../src/bpmn-runtime.js'
import { flowsDir } from '../src/store.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const sandbox = mkdtempSync(join(repoRoot, '.tmp', 'agent-execute-'))

let checks = 0
let asserts = 0

/** 每条断言都计数（`A.throws` / `A.rejects` 这类也照常工作）。 */
const A = new Proxy(assert, {
  get(target, property) {
    const value = target[property]
    if (typeof value !== 'function') return value
    return (...args) => {
      asserts += 1
      return value.apply(target, args)
    }
  },
})

async function check(name, fn) {
  try {
    await fn()
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

let caseSeq = 0
function freshWorkspace() {
  const dir = join(sandbox, `case-${++caseSeq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeDoc(workspace, relativePath, content) {
  const absolute = join(workspace, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
  return absolute
}

function sha256Of(content) {
  return createHash('sha256').update(content).digest('hex')
}

function elementFor(id = 'agent-1', adapter = 'dsh') {
  return {
    id,
    name: '判定节点',
    kind: 'agent',
    node: { kind: 'agent', adapter, prompt: '判断并完结本节点。', roleCard: '你是判定专员。' },
  }
}

/**
 * 假适配器：形状对齐 `src/agent-adapter.js` 的冻结接口。
 *
 * `behavior.run(req, handle, resolveExited)` 在 `start()` 返回后异步执行，负责模拟
 * 「模型调用工具 / 停下来 / 超时不调」；`behavior.onCancel` 可覆盖取消行为。
 */
function makeFakeAdapter(behavior = {}) {
  const calls = {
    probe: 0,
    starts: 0,
    cancelReasons: [],
    dispose: 0,
    handles: [],
    startRequests: [],
  }
  const adapter = {
    id: behavior.id ?? 'dsh',
    calls,
    async probe() {
      calls.probe += 1
      if (behavior.probeError) throw behavior.probeError
      return { version: 'fake-1.0.0', helpDigest: 'fake-help-digest' }
    },
    capabilities() {
      return behavior.capabilities ?? {
        finishTool: 'native',
        hooks: { 'turn.stop': 'native' },
        evidence: { finishTool: 'fake adapter in test' },
      }
    },
    async start(request) {
      calls.starts += 1
      calls.startRequests.push(request)
      let resolveExited
      const exited = new Promise(resolvePromise => { resolveExited = resolvePromise })
      const handle = {
        exited,
        usage: behavior.usage,
        usageCalls: behavior.usageCalls,
        disposed: false,
        cancelCalls: [],
        finish: resolveExited,
      }
      calls.handles.push(handle)
      if (typeof behavior.run === 'function') {
        Promise.resolve()
          .then(() => behavior.run(request, handle, resolveExited))
          .catch(error => {
            resolveExited({
              ok: false,
              code: error && typeof error.code === 'string' ? error.code : 'FAKE_ADAPTER_FAILED',
              message: error instanceof Error ? error.message : String(error),
            })
          })
      }
      return handle
    },
    async cancel(handle, reason) {
      calls.cancelReasons.push(reason)
      if (handle && Array.isArray(handle.cancelCalls)) handle.cancelCalls.push(reason)
      if (typeof behavior.onCancel === 'function') {
        behavior.onCancel(handle, reason)
        return
      }
      handle.finish({ ok: false, code: 'NODE_FINISH_CANCELED', reminders: 0 })
    },
    async dispose(handle) {
      calls.dispose += 1
      if (handle) handle.disposed = true
    },
  }
  return adapter
}

function registryWith(...adapters) {
  const registry = createAdapterRegistry()
  for (const adapter of adapters) registry.register(adapter)
  return registry
}

/** 成功完结的适配器行为：可选提醒 + gate.submit + exited.ok。 */
function successBehavior({ variables = {}, documents = [], summary = '本节点做完了', usage, onReady } = {}) {
  return {
    usage,
    async run(request, handle, resolveExited) {
      if (typeof onReady === 'function') await onReady(request, handle)
      request.reminder.onFire({ count: 1, maxFires: 3 })
      const submitted = await request.finishGate.submit({ variables, documents, summary })
      resolveExited({ ok: true, record: submitted.record })
    },
  }
}

/** gate 拒绝了就按 gate 的错误码结束（模拟适配器把校验错误原样抛出）。 */
function gateErrorBehavior(args) {
  return {
    async run(request, handle, resolveExited) {
      try {
        await request.finishGate.submit(args)
        resolveExited({ ok: true })
      } catch (error) {
        resolveExited({
          ok: false,
          code: error && typeof error.code === 'string' ? error.code : 'NODE_FINISH_INVALID',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}

async function rejectsCode(promise, code, message) {
  await A.rejects(promise, error => {
    A.equal(error && error.code, code, `${message}（实际 ${error && error.code}：${error && error.message}）`)
    return true
  })
}

// ---------------------------------------------------------------------------
// 一、executeAgent 单元：admission / 正常 / 不调工具 / 校验错误 / 超时 / 取消
// ---------------------------------------------------------------------------

await check('正常完结：返回 output/artifacts/summary/usage/events，probe 一次，dispose 一次', async () => {
  const workspace = freshWorkspace()
  const content = '# 方案\n正文在文件里。\n'
  writeDoc(workspace, 'docs/plan.md', content)
  const adapter = makeFakeAdapter(successBehavior({
    variables: { verdict: 'pass', score: 87, needs_review: false },
    documents: [{ path: 'docs/plan.md', kind: 'markdown', title: '方案', summary: '一句话' }],
    summary: '方案已落文件',
    usage: { tokens: 42 },
  }))
  const registry = registryWith(adapter)
  const result = await executeAgent(elementFor(), {
    attempt: 1,
    executionId: 'exec-1',
    variables: {},
    timeoutMs: 1000,
  }, { adapters: registry, workspaceRoot: workspace })

  A.deepEqual(result.output, { verdict: 'pass', score: 87, needs_review: false })
  A.equal(result.artifacts.length, 1)
  A.equal(result.artifacts[0].path, 'docs/plan.md')
  A.equal(result.artifacts[0].sha256, sha256Of(content))
  A.equal(result.artifacts[0].bytes, Buffer.byteLength(content))
  A.equal(result.summary, '方案已落文件')
  A.deepEqual(result.usage, { tokens: 42 })
  const reminders = result.events.filter(event => event.type === 'agent/reminder')
  A.deepEqual(reminders, [{ type: 'agent/reminder', count: 1, maxFires: 3 }])
  const invocations = result.events.filter(event => event.type === 'agent/invocation')
  A.deepEqual(invocations.map(event => event.phase).sort(), ['reminder', 'start'],
    '一次启动 + 一次提醒续跑各记一条 agent/invocation')
  A.equal(invocations.filter(event => event.phase === 'start').length, 1)
  A.equal(invocations.filter(event => event.phase === 'reminder').length, 1)
  A.equal(adapter.calls.probe, 1, 'probe 必须调用一次')
  A.equal(adapter.calls.starts, 1, 'start 必须调用一次')
  A.equal(adapter.calls.dispose, 1, 'dispose 必须调用一次')
  A.equal(adapter.calls.cancelReasons.length, 0, '成功路径不 cancel')
})

await check('成功分支只认受理记录：先 abort 闸门再自报 ok+record → BPMN_ABORTED，不返回 forged output（F5）', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter({
    async run(request, handle, resolveExited) {
      // 复审 F5 的最小反例：先在闸门上留一条 abort，再自报一份「成功 record」。
      request.finishGate.abort('probe')
      resolveExited({ ok: true, record: { output: { canary: 'LEAKED_RECORD' } } })
    },
  })
  const registry = registryWith(adapter)
  let result = null
  let caught = null
  try {
    result = await executeAgent(elementFor('agent-f5-abort'), {
      attempt: 1,
      executionId: 'exec-forged',
      variables: {},
    }, { adapters: registry, workspaceRoot: workspace })
  } catch (error) {
    caught = error
  }
  A.equal(result, null, 'abort 之后绝不允许成功返回')
  A.ok(caught, '必须失败')
  A.equal(caught.code, AGENT_EXECUTE_ERROR.ABORTED, `失败码应为 BPMN_ABORTED（实际 ${caught.code}）`)
  A.match(caught.message, /中止|完结门/, '错误信息要说明完结门已被中止')
  A.equal(JSON.stringify(caught).includes('LEAKED_RECORD'), false, '错误里不能捎带适配器伪造的 output')
  A.equal(adapter.calls.dispose, 1, '失败也要 dispose')
})

await check('成功分支只认受理记录：适配器自报的 record 不覆盖 gate 受理的那一条（F5）', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter({
    async run(request, handle, resolveExited) {
      const submitted = await request.finishGate.submit({
        variables: { real: true },
        documents: [],
        summary: '受理的 summary',
      })
      A.ok(submitted.ok)
      // 自报一份形状合法、内容不同的 record：结果必须来自 gate.result，而不是它。
      resolveExited({ ok: true, record: { output: { canary: 'LEAKED_RECORD' }, summary: '伪造的 summary' } })
    },
  })
  const result = await executeAgent(elementFor('agent-record'), {
    attempt: 1,
    executionId: 'exec-record',
    variables: {},
  }, { adapters: registryWith(adapter), workspaceRoot: workspace })
  A.deepEqual(result.output, { real: true }, 'output 必须来自 gate 受理的 record')
  A.equal(result.summary, '受理的 summary', 'summary 必须来自 gate 受理的 record')
  A.equal(result.output.canary, undefined, '自报 record 的字段不能进入结果')
})

await check('abort 落在「入口检查之后、监听注册之前」：start 永不返回也必须及时失败（不能挂死）', async () => {
  const workspace = freshWorkspace()
  const adapter = {
    id: 'dsh',
    async probe() {
      return { version: 'fake-hang', helpDigest: 'hang' }
    },
    capabilities() {
      return { finishTool: 'native', hooks: { 'turn.stop': 'emulated' } }
    },
    start() {
      return new Promise(() => {})
    },
    async cancel() {},
    async dispose() {},
  }
  // 最窄的竞态窗口：入口检查时还没 abort；监听注册的瞬间已经 abort，且事件不再派发。
  // 旧实现会一直等 start（永不返回）→ handler 挂死；必须补一次 aborted 复查。
  const signal = {
    aborted: false,
    addEventListener() { this.aborted = true },
    removeEventListener() {},
  }
  const pending = executeAgent(elementFor('agent-abort-race'), {
    attempt: 1,
    executionId: 'exec-abort-race',
    variables: {},
    signal,
  }, { adapters: registryWith(adapter), workspaceRoot: workspace })
  let caught = null
  try {
    await Promise.race([
      pending,
      new Promise((resolveTimeout, rejectTimeout) => setTimeout(
        () => rejectTimeout(new Error('handler 挂死：abort 竞态没有被唤醒')),
        2000,
      )),
    ])
  } catch (error) {
    caught = error
  }
  A.ok(caught, '必须失败')
  A.equal(caught.code, AGENT_EXECUTE_ERROR.ABORTED, `失败码应为 BPMN_ABORTED（实际 ${caught.code}）`)
})

await check('成功分支只认受理记录：没提交也没 abort 的「自称成功」→ NODE_FINISH_INVALID，不挂住（F5）', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter({
    async run(request, handle, resolveExited) {
      resolveExited({ ok: true, record: { output: { canary: 'LEAKED_RECORD' } } })
    },
  })
  const registry = registryWith(adapter)
  let timer = null
  try {
    const raced = await Promise.race([
      executeAgent(elementFor('agent-claim'), {
        attempt: 1,
        executionId: 'exec-claim',
        variables: {},
      }, { adapters: registry, workspaceRoot: workspace }).then(
        value => ({ value }),
        error => ({ error }),
      ),
      new Promise(resolvePromise => {
        // 不 unref：实现若真的挂住，1s 后必须由这个定时器把用例判红，而不是让进程静默退出。
        timer = setTimeout(() => resolvePromise({ timedOut: true }), 1000)
      }),
    ])
    A.equal(raced.timedOut, undefined, '未受理的成功必须立刻失败，不能 await 一个永远不 settle 的闸门')
    A.ok(raced.error, '必须抛错')
    A.equal(raced.error.code, AGENT_EXECUTE_ERROR.FINISH_INVALID, `失败码应为 NODE_FINISH_INVALID（实际 ${raced.error.code}）`)
    A.equal(JSON.stringify(raced.error).includes('LEAKED_RECORD'), false, '不能使用自报 record')
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
  A.equal(adapter.calls.dispose, 1)
})

await check('不调工具：reminders=3 → NODE_FINISH_MISSING（不是成功），仍 dispose', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter({
    async run(request, handle, resolveExited) {
      resolveExited({ ok: false, code: 'NODE_FINISH_MISSING', reminders: 3 })
    },
  })
  const registry = registryWith(adapter)
  let caught = null
  try {
    await executeAgent(elementFor(), { attempt: 1, executionId: 'exec-missing', variables: {} }, {
      adapters: registry,
      workspaceRoot: workspace,
    })
  } catch (error) {
    caught = error
  }
  A.ok(caught, '必须抛错')
  A.equal(caught.code, 'NODE_FINISH_MISSING')
  A.match(caught.message, /flow_finish_node|完结/, '错误信息要能定位到没完结')
  A.equal(caught.reminders, 3, 'reminders 透传')
  A.equal(adapter.calls.dispose, 1)
  A.equal(adapter.calls.startRequests[0].finishGate.settled(), true, '未完结的闸门必须被 abort 收口')
})

await check('变量超限：9 KiB / 嵌套对象 → NODE_VARIABLES_INVALID，节点不结束', async () => {
  const workspace = freshWorkspace()
  for (const variables of [
    { big: 'x'.repeat(9000) },
    { nested: { a: 1 } },
  ]) {
    const adapter = makeFakeAdapter(gateErrorBehavior({ variables, documents: [], summary: '' }))
    const registry = registryWith(adapter)
    await rejectsCode(
      executeAgent(elementFor(), { attempt: 1, executionId: 'exec-vars', variables: {} }, {
        adapters: registry,
        workspaceRoot: workspace,
      }),
      'NODE_VARIABLES_INVALID',
      '变量超限必须是 NODE_VARIABLES_INVALID',
    )
    A.equal(adapter.calls.dispose, 1)
  }
})

await check('文档缺失 / 路径越界 → NODE_DOCUMENT_INVALID', async () => {
  const workspace = freshWorkspace()
  const cases = [
    { path: 'docs/missing.md' },
    { path: '../escape.md' },
    { path: '/etc/passwd' },
  ]
  for (const doc of cases) {
    const adapter = makeFakeAdapter(gateErrorBehavior({ variables: {}, documents: [doc], summary: '' }))
    const registry = registryWith(adapter)
    await rejectsCode(
      executeAgent(elementFor(), { attempt: 1, executionId: 'exec-doc', variables: {} }, {
        adapters: registry,
        workspaceRoot: workspace,
      }),
      'NODE_DOCUMENT_INVALID',
      `文档 ${doc.path} 必须被拒绝`,
    )
  }
})

await check('重复完结：第二次 submit → NODE_ALREADY_FINISHED，闸门只受理一次', async () => {
  const workspace = freshWorkspace()
  let secondCode = null
  const adapter = makeFakeAdapter({
    async run(request, handle, resolveExited) {
      await request.finishGate.submit({ variables: { verdict: 'pass' }, documents: [], summary: 'ok' })
      try {
        await request.finishGate.submit({ variables: { verdict: 'pass' }, documents: [], summary: 'ok' })
      } catch (error) {
        secondCode = error.code
      }
      resolveExited({ ok: false, code: secondCode, message: '重复完结' })
    },
  })
  const registry = registryWith(adapter)
  await rejectsCode(
    executeAgent(elementFor(), { attempt: 1, executionId: 'exec-dup', variables: {} }, {
      adapters: registry,
      workspaceRoot: workspace,
    }),
    'NODE_ALREADY_FINISHED',
    '重复完结必须冒泡 NODE_ALREADY_FINISHED',
  )
  A.equal(secondCode, 'NODE_ALREADY_FINISHED')
})

await check('超时：ctx.timeoutMs 到 → BPMN_ACTIVITY_TIMEOUT + cancel + dispose', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter({}) // 永不 resolve exited
  const registry = registryWith(adapter)
  const started = Date.now()
  await rejectsCode(
    executeAgent(elementFor(), {
      attempt: 1,
      executionId: 'exec-timeout',
      variables: {},
      timeoutMs: 60,
    }, { adapters: registry, workspaceRoot: workspace }),
    AGENT_EXECUTE_ERROR.ACTIVITY_TIMEOUT,
    '超时必须报 BPMN_ACTIVITY_TIMEOUT',
  )
  A.ok(Date.now() - started < 2000, '超时不能挂住 handler')
  A.equal(adapter.calls.cancelReasons.length, 1, '超时必须 cancel 适配器')
  A.match(String(adapter.calls.cancelReasons[0]), /timeout/i, 'cancel reason 要能看出是超时')
  A.equal(adapter.calls.dispose, 1, '超时后必须 dispose（不留僵尸）')
})

await check('节点 executor.timeoutMs：custom 零派发，新 adapter 按节点时限超时（review-0131 #3）', async () => {
  const workspace = freshWorkspace()
  const NODE_TIMEOUT = 25

  // 解析口径：ctx 缺省时回落到节点配置；ctx 有值时优先。
  A.equal(resolveAgentTimeoutMs({ node: { executor: { timeoutMs: NODE_TIMEOUT } } }, {}), NODE_TIMEOUT)
  A.equal(resolveAgentTimeoutMs({ node: { executor: { timeoutMs: NODE_TIMEOUT } } }, { timeoutMs: 40 }), 40)
  A.equal(resolveAgentTimeoutMs({ node: {} }, {}), 0)

  // 回归（本次修复）：custom 不再走外部 executor —— 即使注入了 executor 桩，
  // 也一次都不能被调用，错误码必须是 ADAPTER_UNSUPPORTED。
  const executorCalls = []
  const oldElement = {
    id: 'agent-old-timeout',
    node: {
      adapter: 'custom',
      executor: { kind: 'custom', command: 'echo stub', timeoutMs: NODE_TIMEOUT },
      prompt: 'x',
    },
  }
  await rejectsCode(
    executeAgent(oldElement, { attempt: 1, variables: {} }, {
      runExecutor: async options => {
        executorCalls.push(options)
        return { ok: true, text: 'cli', structured: {}, usage: {}, exitCode: 0, events: [] }
      },
    }),
    AGENT_EXECUTE_ERROR.ADAPTER_UNSUPPORTED,
    'custom 必须明确拒绝',
  )
  A.equal(executorCalls.length, 0, 'custom 的 executor 桩一次都不能被调用')

  // 没有注册表时 codex 同样零派发（不再回退旧 executor 路径）。
  await rejectsCode(
    executeAgent(
      { id: 'agent-old-codex', node: { adapter: 'codex', executor: { kind: 'codex', timeoutMs: NODE_TIMEOUT } } },
      { attempt: 1, variables: {} },
      { runExecutor: async options => { executorCalls.push(options); return { ok: true } } },
    ),
    AGENT_EXECUTE_ERROR.ADAPTER_UNAVAILABLE,
    '无注册表时 codex 必须明确拒绝',
  )
  A.equal(executorCalls.length, 0, '无注册表时 codex 的 executor 桩一次都不能被调用')

  // 新路径：没有全局活动超时时，节点自己的限时也必须生效并 cancel 适配器。
  const adapter = makeFakeAdapter({}) // exited 永不 resolve
  const registry = registryWith(adapter)
  const newElement = {
    id: 'agent-new-timeout',
    node: { adapter: 'dsh', executor: { kind: 'dsh', timeoutMs: NODE_TIMEOUT }, prompt: 'x' },
  }
  const startedAt = Date.now()
  await rejectsCode(
    executeAgent(newElement, { attempt: 1, executionId: 'exec-node-timeout', variables: {} }, {
      adapters: registry,
      workspaceRoot: workspace,
    }),
    AGENT_EXECUTE_ERROR.ACTIVITY_TIMEOUT,
    '新路径必须按节点时限超时',
  )
  A.ok(Date.now() - startedAt < 2000, '节点时限不能挂住 handler')
  A.equal(adapter.calls.startRequests[0].ctx.timeoutMs, NODE_TIMEOUT, 'adapter 收到同一有效时限')
  A.equal(adapter.calls.cancelReasons.length, 1, '节点时限到必须 cancel 适配器')
  A.equal(adapter.calls.dispose, 1, '超时后必须 dispose')
})

await check('节点 executor.timeoutMs 覆盖 probe / start 阶段（review-0131 #3）', async () => {
  const workspace = freshWorkspace()

  // probe 永不返回：有效时限用尽即报活动超时，零派发。
  const slowProbe = makeFakeAdapter(successBehavior())
  slowProbe.probe = async () => new Promise(() => {})
  const probeStarted = Date.now()
  await rejectsCode(
    executeAgent({
      id: 'agent-probe-timeout',
      node: { adapter: 'dsh', executor: { kind: 'dsh', timeoutMs: 30 }, prompt: 'x' },
    }, { attempt: 1, variables: {} }, { adapters: registryWith(slowProbe), workspaceRoot: workspace }),
    AGENT_EXECUTE_ERROR.ACTIVITY_TIMEOUT,
    'probe 阶段超时必须报活动超时',
  )
  A.ok(Date.now() - probeStarted < 2000, 'probe 超时不能挂住 handler')
  A.equal(slowProbe.calls.starts, 0, 'probe 超时零派发')

  // start 永不返回：同一个 deadline 也要覆盖启动阶段。
  const slowStart = makeFakeAdapter(successBehavior())
  slowStart.start = async () => new Promise(() => {})
  const startStarted = Date.now()
  await rejectsCode(
    executeAgent({
      id: 'agent-start-timeout',
      node: { adapter: 'dsh', executor: { kind: 'dsh', timeoutMs: 30 }, prompt: 'x' },
    }, { attempt: 1, variables: {} }, { adapters: registryWith(slowStart), workspaceRoot: workspace }),
    AGENT_EXECUTE_ERROR.ACTIVITY_TIMEOUT,
    'start 阶段超时必须报活动超时',
  )
  A.ok(Date.now() - startStarted < 2000, 'start 超时不能挂住 handler')
})

await check('ctx.signal abort → BPMN_ABORTED + cancel + dispose', async () => {

  const workspace = freshWorkspace()
  const controller = new AbortController()
  const adapter = makeFakeAdapter({
    run(request, handle, resolveExited) {
      setTimeout(() => controller.abort(), 20)
      // 不主动 finish：等 runtime 的 abort 路径 cancel。
      void request
      void handle
      void resolveExited
    },
  })
  const registry = registryWith(adapter)
  await rejectsCode(
    executeAgent(elementFor(), {
      attempt: 1,
      executionId: 'exec-abort',
      variables: {},
      signal: controller.signal,
    }, { adapters: registry, workspaceRoot: workspace }),
    AGENT_EXECUTE_ERROR.ABORTED,
    'abort 必须报 BPMN_ABORTED',
  )
  A.equal(adapter.calls.cancelReasons.length, 1, 'abort 必须 cancel 适配器')
  A.equal(adapter.calls.dispose, 1)
})

await check('admission：非 native → 零派发 + NODE_FINISH_TOOL_UNAVAILABLE', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter({
    capabilities: { finishTool: 'unsupported', hooks: { 'turn.stop': 'unsupported' }, evidence: {} },
    run: async () => {},
  })
  const registry = registryWith(adapter)
  await rejectsCode(
    executeAgent(elementFor(), { attempt: 1, variables: {} }, { adapters: registry, workspaceRoot: workspace }),
    ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
    '非 native 必须拒绝启动',
  )
  A.equal(adapter.calls.probe, 1, 'admission 必须 probe')
  A.equal(adapter.calls.starts, 0, '零派发：adapter.start 不能被调用')
})

await check('admission：probe 失败（codex 不在/未登录）→ 零派发 + 不可用', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter({
    probeError: new Error('codex not found'),
    run: async () => {},
  })
  const registry = registryWith(adapter)
  await rejectsCode(
    executeAgent(elementFor(), { attempt: 1, variables: {} }, { adapters: registry, workspaceRoot: workspace }),
    ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE,
    'probe 失败按不可用处理',
  )
  A.equal(adapter.calls.starts, 0)
})

await check('未知 adapter → BPMN_AGENT_ADAPTER_UNSUPPORTED，probe 都不跑', async () => {
  const workspace = freshWorkspace()
  const dsh = makeFakeAdapter(successBehavior())
  const registry = registryWith(dsh)
  await rejectsCode(
    executeAgent(elementFor('agent-x', 'claude'), { attempt: 1, variables: {} }, {
      adapters: registry,
      workspaceRoot: workspace,
    }),
    AGENT_EXECUTE_ERROR.ADAPTER_UNSUPPORTED,
    '未注册 adapter 必须拒绝',
  )
  A.equal(dsh.calls.probe, 0)
  A.equal(dsh.calls.starts, 0)
})

await check('probe 缓存：并发 admission 只 probe 一次（in-flight 去重）', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter(successBehavior({ variables: { ok: true } }))
  const registry = registryWith(adapter)
  const probeAdapter = createAdapterProbeCache()
  // 同时发起的两个活动：第一个 probe 还在飞，第二个必须复用它。
  await Promise.all(['exec-a', 'exec-b'].map(executionId => executeAgent(
    elementFor(),
    { attempt: 1, executionId, variables: {} },
    { adapters: registry, workspaceRoot: workspace, probeAdapter },
  )))
  A.equal(adapter.calls.probe, 1, '并发活动只能 probe 一次（in-flight 去重）')
  A.equal(adapter.calls.starts, 2)
})

await check('probe 缓存跨 TTL：runtime 不永久缓存结果，adapter TTL 到期后能重新 probe（review-0131 #2）', async () => {
  // 假 codex：probe 结果有 30ms TTL，capabilities() 只认「最近一次成功 probe」。
  // 修复前 runtime 永久缓存 probe Promise：TTL 过后 admission 仍拿旧结论 →
  // capabilities() 返回 unsupported → 节点被永久拒绝（NODE_FINISH_TOOL_UNAVAILABLE）。
  const ttlMs = 30
  let cachedAt = 0
  let probes = 0
  const adapter = {
    id: 'codex-ttl',
    get probes() { return probes },
    async probe() {
      probes += 1
      cachedAt = Date.now()
      return { version: 'fake-1.0.0', helpDigest: 'fake-help-digest' }
    },
    capabilities() {
      const fresh = cachedAt !== 0 && Date.now() - cachedAt < ttlMs
      return {
        finishTool: fresh ? 'native' : 'unsupported',
        hooks: { 'turn.stop': fresh ? 'emulated' : 'unsupported' },
        evidence: {},
      }
    },
    async start() { throw new Error('本用例不派发') },
    async cancel() {},
    async dispose() {},
  }
  const probeAdapter = createAdapterProbeCache()
  await admitAdapter(adapter, { probeAdapter })
  A.equal(probes, 1, '首次 admission 必须 probe')
  await new Promise(resolve => setTimeout(resolve, ttlMs + 15))
  // 修复前这里拿到 runtime 的旧 Promise，capabilities() 已是 unsupported → 抛错。
  await admitAdapter(adapter, { probeAdapter })
  A.equal(probes, 2, '跨过 adapter TTL 必须重新 probe（结果缓存归 adapter 自己管）')
})

await check('runAgentNode 直接调用：没有 probe 时也能工作（不经过 admission）', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter(successBehavior({ variables: { direct: true } }))
  const result = await runAgentNode({
    element: elementFor(),
    ctx: { attempt: 2, executionId: 'exec-direct', variables: {} },
    adapter,
    workspaceRoot: workspace,
  })
  A.equal(result.output.direct, true)
  A.equal(adapter.calls.dispose, 1)
})

await check('usage 遥测：超时 / 取消 / NODE_FINISH_MISSING 都保留已观测用量（不只从 activity/end 取数）', async () => {
  const workspace = freshWorkspace()
  const usageCalls = () => [{
    provider: 'dsh',
    callId: 'call-1',
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 },
  }]
  const telemetryCapabilities = {
    finishTool: 'native',
    hooks: { 'turn.stop': 'native' },
    usage: 'native',
  }

  // ① 超时：适配器永远不结算，但 usage 已经观测到。
  const timeoutAdapter = makeFakeAdapter({
    capabilities: telemetryCapabilities,
    usageCalls,
    run() { return new Promise(() => {}) },
    onCancel(handle) { handle.finish({ ok: false, code: 'NODE_FINISH_CANCELED', reminders: 0 }) },
  })
  await rejectsCode(executeAgent(elementFor(), {
    attempt: 1, executionId: 'exec-timeout', variables: {}, timeoutMs: 30,
  }, { adapters: registryWith(timeoutAdapter), workspaceRoot: workspace }), 'BPMN_ACTIVITY_TIMEOUT')
  const timeoutError = await executeAgent(elementFor(), {
    attempt: 1, executionId: 'exec-timeout-2', variables: {}, timeoutMs: 30,
  }, { adapters: registryWith(timeoutAdapter), workspaceRoot: workspace }).catch(error => error)
  A.ok(Array.isArray(timeoutError.events), '超时错误必须携带已观测事件')
  const timeoutUsage = timeoutError.events.filter(event => event.type === 'agent/usage')
  A.equal(timeoutUsage.length, 1)
  A.equal(timeoutUsage[0].trust, 'known')
  A.equal(timeoutUsage[0].usage.input, 10)
  A.equal(timeoutUsage[0].usage.cacheRead, 3)
  A.ok(timeoutError.events.some(event => event.type === 'agent/invocation'), '启动轮次必须留痕')

  // ② ctx.signal 取消：同样保留 usage。
  const cancelAdapter = makeFakeAdapter({
    capabilities: telemetryCapabilities,
    usageCalls,
    run() { return new Promise(() => {}) },
    onCancel(handle) { handle.finish({ ok: false, code: 'NODE_FINISH_CANCELED', reminders: 0 }) },
  })
  const controller = new AbortController()
  const cancelPromise = executeAgent(elementFor(), {
    attempt: 1, executionId: 'exec-cancel', variables: {}, timeoutMs: 1_000, signal: controller.signal,
  }, { adapters: registryWith(cancelAdapter), workspaceRoot: workspace }).catch(error => error)
  await new Promise(resolveSleep => setTimeout(resolveSleep, 5))
  controller.abort()
  const cancelError = await cancelPromise
  A.equal(cancelError.code, 'BPMN_ABORTED')
  A.equal(cancelError.events.filter(event => event.type === 'agent/usage')[0]?.usage?.total, 15)

  // ③ NODE_FINISH_MISSING：提醒耗尽也必须保留 usage。
  const missingAdapter = makeFakeAdapter({
    capabilities: telemetryCapabilities,
    usageCalls,
    async run(request, handle, resolveExited) {
      request.reminder.onFire({ count: 1, maxFires: 1 })
      resolveExited({ ok: false, code: 'NODE_FINISH_MISSING', reminders: 1 })
    },
  })
  const missingError = await executeAgent(elementFor(), {
    attempt: 1, executionId: 'exec-missing', variables: {}, timeoutMs: 1_000,
  }, { adapters: registryWith(missingAdapter), workspaceRoot: workspace }).catch(error => error)
  A.equal(missingError.code, 'NODE_FINISH_MISSING')
  A.equal(missingError.events.filter(event => event.type === 'agent/usage').length, 1)
  A.equal(missingError.events.filter(event => event.type === 'agent/invocation').length, 2,
    '一次启动 + 一次提醒续跑')
})

// ---------------------------------------------------------------------------
// 二、集成：真实 runner + runtime 的实例语义
// ---------------------------------------------------------------------------

function workflowXml({
  processId = 'proc-a3',
  nodes = '<bpmn:serviceTask id="agent1" name="判定"><bpmn:extensionElements><fs:node nodeType="agent" adapter="dsh" prompt="判断并完结。" /></bpmn:extensionElements></bpmn:serviceTask>',
  flows = '<bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent1"/><bpmn:sequenceFlow id="f2" sourceRef="agent1" targetRef="end"/>',
  gateways = '',
} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="defs-${processId}" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="${processId}" isExecutable="true">
    <bpmn:startEvent id="start"/>
    ${nodes}
    ${gateways}
    <bpmn:endEvent id="end"/>
    ${flows}
  </bpmn:process>
</bpmn:definitions>`
}

const API = []

async function makeRuntime(adapters, workspace, extraEnv = {}) {
  const dir = flowsDir(workspace)
  const runtime = createBpmnRuntime({
    dir,
    env: { ...extraEnv },
    adapters,
    workspaceRoot: workspace,
  })
  API.push(runtime)
  return runtime
}

async function seedAndStart(runtime, xml, definitionId = 'flow-a3', variables = {}) {
  const saved = await runtime.handle({
    method: 'POST',
    parts: ['definitions'],
    body: { id: definitionId, name: 'A3 流程', xml },
  })
  A.equal(saved.status, 201, `保存定义失败：${JSON.stringify(saved.body)}`)
  const created = await runtime.handle({
    method: 'POST',
    parts: ['instances'],
    body: { definitionId, variables },
  })
  A.equal(created.status, 201, `创建实例失败：${JSON.stringify(created.body)}`)
  return created.body
}

async function readInstance(runtime, id) {
  const detail = await runtime.handle({ method: 'GET', parts: ['instances', id] })
  A.equal(detail.status, 200, `读取实例失败：${JSON.stringify(detail.body)}`)
  return detail.body
}

function readInstanceJson(runtime, id) {
  return JSON.parse(readFileSync(join(runtime.instancesRoot, id, 'instance.json'), 'utf8'))
}

async function readEvents(runtime, id) {
  const events = await runtime.handle({ method: 'GET', parts: ['instances', id, 'events'] })
  A.equal(events.status, 200)
  return events.body.events
}

await check('集成·正常：变量注入 + 网关按 verdict 路由 + activity/end 带 output/artifacts/summary + result', async () => {
  const workspace = freshWorkspace()
  const content = '# 结论\npass\n'
  writeDoc(workspace, 'docs/verdict.md', content)
  const adapter = makeFakeAdapter(successBehavior({
    variables: { verdict: 'pass', score: 87 },
    documents: [{ path: 'docs/verdict.md', kind: 'markdown', title: '结论' }],
    summary: '判定为 pass',
  }))
  const runtime = await makeRuntime(registryWith(adapter), workspace)
  const xml = workflowXml({
    processId: 'proc-route',
    nodes: '<bpmn:serviceTask id="agent1" name="判定"><bpmn:extensionElements><fs:node nodeType="agent" adapter="dsh" prompt="判断并完结。" /></bpmn:extensionElements></bpmn:serviceTask>',
    gateways: '<bpmn:exclusiveGateway id="gw" default="f_fail"/>',
    flows: [
      '<bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent1"/>',
      '<bpmn:sequenceFlow id="f2" sourceRef="agent1" targetRef="gw"/>',
      '<bpmn:sequenceFlow id="f_pass" sourceRef="gw" targetRef="end"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="feel">= verdict = "pass"</bpmn:conditionExpression></bpmn:sequenceFlow>',
      '<bpmn:sequenceFlow id="f_fail" sourceRef="gw" targetRef="end"/>',
    ].join(''),
  })
  const created = await seedAndStart(runtime, xml, 'flow-route')
  const detail = await readInstance(runtime, created.id)
  A.equal(detail.status, 'COMPLETED', '工具受理后节点完成、流程结束')
  A.equal(detail.variables.verdict, 'pass', 'output 短变量必须合并进 instance.variables')
  A.equal(detail.variables.score, 87)
  A.deepEqual(detail.result, { verdict: 'pass', score: 87 }, 'process/end 时 result 取最后 agent output')
  const raw = readInstanceJson(runtime, created.id)
  A.equal(raw.artifacts.length, 1, 'record.artifacts 必须合并进 instance.json')
  A.equal(raw.artifacts[0].path, 'docs/verdict.md')
  A.equal(raw.artifacts[0].sha256, sha256Of(content))
  A.equal(raw.artifacts[0].nodeId, 'agent1')
  A.equal(raw.artifacts[0].attempt, 1)
  A.equal(raw.artifacts[0].kind, 'markdown')
  A.equal(typeof raw.artifacts[0].bytes, 'number')

  const events = await readEvents(runtime, created.id)
  const types = events.map(event => event.type)
  A.ok(types.includes('process/end'), '正常结束必须有 process/end')
  const ends = events.filter(event => event.type === 'activity/end' && event.elementId === 'agent1')
  A.equal(ends.length, 1)
  A.deepEqual(ends[0].output, { verdict: 'pass', score: 87 }, 'activity/end 带 output')
  A.equal(ends[0].summary, '判定为 pass', 'activity/end 带 summary')
  A.equal(ends[0].artifacts.length, 1, 'activity/end 带 artifacts 引用')
  A.equal(ends[0].artifacts[0].path, 'docs/verdict.md')
  A.equal(ends[0].artifacts[0].content, undefined, '事件里不能出现文档正文')
  const reminders = events.filter(event => event.type === 'agent/reminder')
  A.equal(reminders.length, 1, '提醒必须经 handler events[] 出现在实例事件流')
  A.equal(reminders[0].count, 1)
  A.equal(reminders[0].maxFires, 3)
  const taken = events.filter(event => event.type === 'flow/taken').map(event => event.flowId)
  A.ok(taken.includes('f_pass'), '网关必须按 verdict=pass 路由到 f_pass')
  A.ok(!taken.includes('f_fail'), '不能走默认分支 f_fail')
})

await check('集成·两个 agent 同文件：artifacts 按 path+sha256 去重，result 取最后一个 output', async () => {
  const workspace = freshWorkspace()
  writeDoc(workspace, 'docs/shared.md', '同一份产物\n')
  let nodeRuns = 0
  const adapter = makeFakeAdapter({
    async run(request, handle, resolveExited) {
      nodeRuns += 1
      const submitted = await request.finishGate.submit({
        variables: { verdict: 'pass', step: nodeRuns },
        documents: [{ path: 'docs/shared.md', kind: 'markdown', title: '共享产物' }],
        summary: `第 ${nodeRuns} 个 agent`,
      })
      resolveExited({ ok: true, record: submitted.record })
    },
  })
  const runtime = await makeRuntime(registryWith(adapter), workspace)
  const xml = workflowXml({
    processId: 'proc-two',
    nodes: [
      '<bpmn:serviceTask id="agent1" name="第一步"><bpmn:extensionElements><fs:node nodeType="agent" adapter="dsh" prompt="第一步。" /></bpmn:extensionElements></bpmn:serviceTask>',
      '<bpmn:serviceTask id="agent2" name="第二步"><bpmn:extensionElements><fs:node nodeType="agent" adapter="dsh" prompt="第二步。" /></bpmn:extensionElements></bpmn:serviceTask>',
    ].join(''),
    flows: [
      '<bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent1"/>',
      '<bpmn:sequenceFlow id="f2" sourceRef="agent1" targetRef="agent2"/>',
      '<bpmn:sequenceFlow id="f3" sourceRef="agent2" targetRef="end"/>',
    ].join(''),
  })
  const created = await seedAndStart(runtime, xml, 'flow-two')
  const detail = await readInstance(runtime, created.id)
  A.equal(detail.status, 'COMPLETED')
  const raw = readInstanceJson(runtime, created.id)
  A.equal(raw.artifacts.length, 1, '同 path+sha256 只能登记一次')
  A.deepEqual(detail.result, { verdict: 'pass', step: 2 }, 'result 取最后一个 agent 的 output')
  A.equal(detail.variables.step, 2, '变量覆盖为最后一个 output')
  A.equal(adapter.calls.probe, 2, '每个活动都会重新 probe（结果缓存归 adapter 自己管）')
  A.equal(adapter.calls.starts, 2)
  const events = await readEvents(runtime, created.id)
  const ends = events.filter(event => event.type === 'activity/end' && String(event.elementId).startsWith('agent'))
  A.equal(ends.length, 2)
  A.equal(ends[0].summary, '第 1 个 agent')
  A.equal(ends[1].summary, '第 2 个 agent')
})

await check('集成·恢复 result：agent → human → dispose/新 runtime，result 仍是最后 agent 输出（review-0131 #4）', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter(successBehavior({ variables: { verdict: 'pass' }, summary: '判定 pass' }))
  const runtimeA = await makeRuntime(registryWith(adapter), workspace)
  const xml = workflowXml({
    processId: 'proc-recover-result',
    nodes: [
      '<bpmn:serviceTask id="agent1" name="判定"><bpmn:extensionElements><fs:node nodeType="agent" adapter="dsh" prompt="判断并完结。" /></bpmn:extensionElements></bpmn:serviceTask>',
      '<bpmn:userTask id="human1" name="人工确认"/>',
    ].join(''),
    flows: [
      '<bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent1"/>',
      '<bpmn:sequenceFlow id="f2" sourceRef="agent1" targetRef="human1"/>',
      '<bpmn:sequenceFlow id="f3" sourceRef="human1" targetRef="end"/>',
    ].join(''),
  })
  const created = await seedAndStart(runtimeA, xml, 'flow-recover-result')
  A.equal(created.status, 'ACTIVE')
  const waiting = await readInstance(runtimeA, created.id)
  A.equal(waiting.pendingTasks.length, 1, '必须停在人工任务')
  A.equal(waiting.result, null, '未结束前 result 仍是 null')

  // 最后一个 agent 输出必须随实例快照持久化（内存 Map 在 dispose 后清空）。
  const rawWaiting = readInstanceJson(runtimeA, created.id)
  A.deepEqual(rawWaiting.lastAgentOutput, { nodeId: 'agent1', output: { verdict: 'pass' } },
    'instance.json 必须持久化最后 agent 输出 + 来源 nodeId')
  await runtimeA.dispose()

  // 新 runtime（模拟进程重启）：懒恢复后完成 human1，agent 不能重放。
  const adapterB = makeFakeAdapter(successBehavior({ variables: { verdict: 'from-B' } }))
  const runtimeB = await makeRuntime(registryWith(adapterB), workspace)
  const completed = await runtimeB.handle({
    method: 'POST',
    parts: ['instances', created.id, 'tasks', 'human1', 'complete'],
    body: { payload: { approved: true } },
  })
  A.equal(completed.status, 200, JSON.stringify(completed.body))
  const detail = await readInstance(runtimeB, created.id)
  A.equal(detail.status, 'COMPLETED')
  A.deepEqual(detail.result, { verdict: 'pass' }, 'result 必须仍是最后一个 agent 的 output（不能是 null / variables）')
  A.equal(detail.variables.verdict, 'pass', 'variables 仍是 agent 的短变量')
  A.equal(detail.variables.approved, true, '人工任务 payload 合并进 variables')
  A.equal(adapter.calls.starts, 1, 'agent 只执行一次（恢复不能重放）')
  A.equal(adapterB.calls.starts, 0, '新 runtime 不能重新派发已完成的 agent')
})

await check('集成·不调工具：NODE_FINISH_MISSING → 实例 ACTIVE + lastError，不发 process/end', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter({
    async run(request, handle, resolveExited) {
      request.reminder.onFire({ count: 1, maxFires: 3 })
      request.reminder.onFire({ count: 2, maxFires: 3 })
      request.reminder.onFire({ count: 3, maxFires: 3 })
      resolveExited({ ok: false, code: 'NODE_FINISH_MISSING', reminders: 3 })
    },
  })
  const runtime = await makeRuntime(registryWith(adapter), workspace)
  const created = await seedAndStart(runtime, workflowXml({ processId: 'proc-missing' }), 'flow-missing')
  const detail = await readInstance(runtime, created.id)
  A.equal(detail.status, 'ACTIVE', '不调工具不是终态：实例保持 ACTIVE')
  A.equal(detail.lastError.code, 'NODE_FINISH_MISSING', 'lastError 必须保留真实错误码')
  A.equal(detail.lastError.reminders, 3, 'lastError 带提醒次数（11 §3.1）')
  A.match(detail.lastError.message, /flow_finish_node|完结|NODE_FINISH_MISSING/, '错误信息可行动')
  A.deepEqual(detail.pendingTasks, [], '执行已停下：没有待办')
  const events = await readEvents(runtime, created.id)
  A.ok(events.some(event => event.type === 'error'), 'error 事件必须留痕')
  A.equal(events.some(event => event.type === 'process/end'), false, '不调工具不能发 process/end')
  A.equal(events.some(event => event.type === 'flow/taken' && event.flowId === 'f2'), false, '流程不能往下走')
  A.equal(events.filter(event => event.type === 'agent/reminder').length, 3, '3 次提醒都要在事件流里')
})

await check('集成·变量超限：NODE_VARIABLES_INVALID → 节点不结束、实例 ACTIVE', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter(gateErrorBehavior({
    variables: { blob: 'x'.repeat(9000) },
    documents: [],
    summary: '',
  }))
  const runtime = await makeRuntime(registryWith(adapter), workspace)
  const created = await seedAndStart(runtime, workflowXml({ processId: 'proc-vars' }), 'flow-vars')
  const detail = await readInstance(runtime, created.id)
  A.equal(detail.status, 'ACTIVE')
  A.equal(detail.lastError.code, 'NODE_VARIABLES_INVALID')
  const events = await readEvents(runtime, created.id)
  A.equal(events.some(event => event.type === 'process/end'), false)
  A.equal(events.some(event => event.type === 'flow/taken' && event.flowId === 'f2'), false, '节点不结束')
})

await check('集成·文档缺失：NODE_DOCUMENT_INVALID → 节点不结束、实例 ACTIVE', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter(gateErrorBehavior({
    variables: { verdict: 'pass' },
    documents: [{ path: 'docs/nope.md' }],
    summary: '',
  }))
  const runtime = await makeRuntime(registryWith(adapter), workspace)
  const created = await seedAndStart(runtime, workflowXml({ processId: 'proc-doc' }), 'flow-doc')
  const detail = await readInstance(runtime, created.id)
  A.equal(detail.status, 'ACTIVE')
  A.equal(detail.lastError.code, 'NODE_DOCUMENT_INVALID')
  A.match(detail.lastError.message, /docs\/nope\.md/, '错误里要点名缺失的路径')
})

await check('集成·admission 非 native：零派发 + NODE_FINISH_TOOL_UNAVAILABLE + ACTIVE', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter({
    capabilities: { finishTool: 'unsupported', hooks: { 'turn.stop': 'unsupported' }, evidence: {} },
    run: async () => {},
  })
  const runtime = await makeRuntime(registryWith(adapter), workspace)
  const created = await seedAndStart(runtime, workflowXml({ processId: 'proc-admission' }), 'flow-admission')
  const detail = await readInstance(runtime, created.id)
  A.equal(detail.status, 'ACTIVE', 'admission 拒绝不改实例 status')
  A.equal(detail.lastError.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE)
  // 创建响应里的 error.code 必须和落盘 lastError 同一口径（不能是 BPMN_HANDLER_FAILED 包装码）。
  A.equal(created.error?.code, ADAPTER_ERROR.NODE_FINISH_TOOL_UNAVAILABLE, '创建响应 error.code 与 lastError 一致')
  A.equal(adapter.calls.starts, 0, '零派发')
  A.equal(adapter.calls.probe, 1, 'admission 必须 probe（且失败要留痕）')
})

await check('集成·超时：BPMN_ACTIVITY_TIMEOUT + cancel + dispose，无 process/end', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter({}) // exited 永不 resolve
  const runtime = await makeRuntime(registryWith(adapter), workspace, {
    FLOW_STUDIO_BPMN_ACTIVITY_TIMEOUT_MS: '80',
  })
  const created = await seedAndStart(runtime, workflowXml({ processId: 'proc-timeout' }), 'flow-timeout')
  const detail = await readInstance(runtime, created.id)
  A.equal(detail.status, 'ACTIVE', '活动超时后实例仍是 ACTIVE（lastError 承载事实）')
  A.equal(detail.lastError.code, 'BPMN_ACTIVITY_TIMEOUT')
  A.equal(adapter.calls.starts, 1)
  A.ok(adapter.calls.cancelReasons.length >= 1, '超时必须 cancel 适配器')
  A.equal(adapter.calls.dispose, 1, '超时后必须 dispose')
  const events = await readEvents(runtime, created.id)
  A.equal(events.some(event => event.type === 'process/end'), false)
})

try {
  console.log(`agent-execute.test.mjs`)
  console.log(`A3 · ${checks} 组通过（${asserts} 条断言）`)
} finally {
  for (const runtime of API) {
    try {
      await runtime.dispose()
    } catch {
      // 测试收尾失败不影响断言结论。
    }
  }
  rmSync(sandbox, { recursive: true, force: true })
}
