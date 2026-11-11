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
  AGENT_EXECUTE_ERROR, createAdapterProbeCache, runAgentNode,
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
  A.deepEqual(result.events, [{ type: 'agent/reminder', count: 1, maxFires: 3 }])
  A.equal(adapter.calls.probe, 1, 'probe 必须调用一次')
  A.equal(adapter.calls.starts, 1, 'start 必须调用一次')
  A.equal(adapter.calls.dispose, 1, 'dispose 必须调用一次')
  A.equal(adapter.calls.cancelReasons.length, 0, '成功路径不 cancel')
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

await check('probe 缓存：同一 runtime 的多个活动只 probe 一次', async () => {
  const workspace = freshWorkspace()
  const adapter = makeFakeAdapter(successBehavior({ variables: { ok: true } }))
  const registry = registryWith(adapter)
  const probeAdapter = createAdapterProbeCache()
  for (const executionId of ['exec-a', 'exec-b']) {
    await executeAgent(elementFor(), { attempt: 1, executionId, variables: {} }, {
      adapters: registry,
      workspaceRoot: workspace,
      probeAdapter,
    })
  }
  A.equal(adapter.calls.probe, 1, '同一 adapter id 只 probe 一次')
  A.equal(adapter.calls.starts, 2)
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

await check('集成·两个 agent 同文件：artifacts 按 path+sha256 去重，result 取最后一个 output，probe 只一次', async () => {
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
  A.equal(adapter.calls.probe, 1, '同一 runtime 里 probe 只跑一次')
  A.equal(adapter.calls.starts, 2)
  const events = await readEvents(runtime, created.id)
  const ends = events.filter(event => event.type === 'activity/end' && String(event.elementId).startsWith('agent'))
  A.equal(ends.length, 2)
  A.equal(ends[0].summary, '第 1 个 agent')
  A.equal(ends[1].summary, '第 2 个 agent')
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
