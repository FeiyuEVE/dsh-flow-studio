#!/usr/bin/env node
/**
 * 实例域模型工具面自检（E3 / 0.13.13）：在对话里驱动流程。
 *
 * 覆盖：
 *  1. run → 人工任务 → complete_task → agent → finish → COMPLETED 全链路只用工具完成，
 *     不建 HTTP 服务、不碰 createHandler；
 *  2. 越权与拒绝：跨实例绑定、任意 workspace、超限变量、终态 cancel、重复 complete、
 *     未知 definition / instance / task；
 *  3. 读类工具在 runner 未启动时可用（GET 语义），调用后 `_runners.size === 0`；
 *  4. 会话绑定：startedBy 来自调用上下文，重启（新 runtime 指同一存储根）后仍可查询；
 *  5. 与 GUI 并发：同一实例同一任务同时提交，只有一次成功。
 *
 * 只用真实 BpmnRuntime + 假 AgentAdapter（照 bpmn-runtime.test.mjs 的写法），
 * 不真跑 codex / dsh 子会话、不发真实 HTTP。产物在项目 `.tmp/` 下，结束清理。
 *
 * 运行：node test/instance-tools-model.test.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const home = mkdtempSync(join(repoRoot, '.tmp', 'home-instance-model-'))
process.env.DSH_HOME = home

const { createBpmnRuntime } = await import('../src/bpmn-runtime.js')
const { createInstanceTools } = await import('../src/instance-tools.js')
const { saveDefinitionVersion } = await import('../src/definition-store.js')
const { appendInstanceEvents } = await import('../src/instance-store.js')

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

/** 人工任务 → agent → end：实例启动后停在 human1，complete 后由假适配器 finish。 */
function humanThenAgentXml(processId = 'proc-chain') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="defs-${processId}" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="${processId}" name="人工→agent" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:userTask id="human1" name="人工审批"/>
    <bpmn:serviceTask id="agent1" name="写草稿">
      <bpmn:extensionElements>
        <fs:node nodeType="agent" adapter="dsh"></fs:node>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="human1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="human1" targetRef="agent1"/>
    <bpmn:sequenceFlow id="f3" sourceRef="agent1" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
}

function agentThenHumanXml(processId = 'proc-flow') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="defs-${processId}" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="${processId}" name="agent→人工" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="agent1" name="写草稿">
      <bpmn:extensionElements>
        <fs:node nodeType="agent" adapter="dsh"></fs:node>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:userTask id="human1" name="人工审批"/>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="agent1" targetRef="human1"/>
    <bpmn:sequenceFlow id="f3" sourceRef="human1" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
}

function gitCmd(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeGitRepo(name = 'repo') {
  const repo = join(home, name)
  mkdirSync(repo, { recursive: true })
  gitCmd(repo, ['init', '-b', 'main'])
  gitCmd(repo, ['config', 'user.email', 'test@example.com'])
  gitCmd(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  gitCmd(repo, ['add', '.'])
  gitCmd(repo, ['commit', '-m', 'init'])
  return repo
}

/** 桩适配器：start 时直接通过 finishGate 提交（与 bpmn-runtime.test.mjs 同口径）。 */
function makeFakeAdapter() {
  const calls = []
  const adapter = {
    id: 'dsh',
    calls,
    async probe() {
      return { version: 'stub', helpDigest: 'stub' }
    },
    capabilities() {
      return { finishTool: 'native', hooks: { 'turn.stop': 'emulated' } }
    },
    async start(request) {
      calls.push(request)
      const submitted = await request.finishGate.submit({
        variables: { agentOk: true },
        documents: [],
        summary: 'agent-stub-result',
      })
      return { exited: Promise.resolve({ ok: true, record: submitted.record }) }
    },
    async cancel() {},
    async dispose() {},
  }
  return adapter
}

function makeFakeAdapters(adapter) {
  return {
    get(id) {
      return id === adapter.id ? adapter : undefined
    },
    list() {
      return [adapter]
    },
  }
}

function byName(tools, name) {
  const tool = tools.find(item => item.name === name)
  assert.ok(tool, `缺少工具 ${name}`)
  return tool
}

function toolsFor(runtime, extras = {}) {
  return createInstanceTools({ runtime, ...extras })
}

function execWith(sessionId) {
  return { agent: { session: { id: sessionId } } }
}

function makeRuntime(adapters, options = {}) {
  return createBpmnRuntime({
    dir: join(home, 'flow-studio'),
    env: {},
    adapters,
    ...options,
  })
}

async function seed(runtime, id, xml, name = id) {
  return await saveDefinitionVersion(id, xml, { name }, { definitionsRoot: runtime.definitionsRoot })
}

function eventTypes(events) {
  return events.map(event => event.type)
}

/** 记录 handle 调用的假 runtime（参数错误必须在发出请求前失败）。 */
function makeCountingRuntime() {
  const calls = []
  const runtime = {
    calls,
    async handle(request) {
      calls.push(request)
      return { status: 200, body: { ok: true } }
    },
    workspaceCapabilities() {
      return { workspace: true, worktree: true }
    },
  }
  return runtime
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolveSleep => { setTimeout(resolveSleep, 10) })
  }
  return false
}

try {
  console.log('instance-tools-model')

  const adapter = makeFakeAdapter()
  const runtime = makeRuntime(makeFakeAdapters(adapter))
  await seed(runtime, 'flow-chain', humanThenAgentXml(), '人工→agent 链')
  await seed(runtime, 'flow-two', agentThenHumanXml(), 'agent→人工')
  const tools = toolsFor(runtime)

  await check('注册 11 个实例域工具（3 个既有 + 8 个 E3）', () => {
    const names = tools.map(tool => tool.name).sort()
    deep(names, [
      'flow_definition_get', 'flow_definition_list',
      'flow_instance_cancel', 'flow_instance_complete_task', 'flow_instance_events',
      'flow_instance_get', 'flow_instance_list', 'flow_instance_reply',
      'flow_instance_run', 'flow_instance_send_message', 'flow_instance_worktrees',
    ])
  })

  await check('definition_list：keyword / limit / 短摘要，不返回 XML', async () => {
    const listTool = byName(tools, 'flow_definition_list')
    const all = await listTool.execute({})
    eq(all.ok, true)
    eq(all.total >= 2, true, '至少两个定义')
    ok(all.definitions.every(item => item.id && item.xml === undefined), '列表不带 XML')

    const byKeyword = await listTool.execute({ keyword: 'agent→人工' })
    eq(byKeyword.total, 1)
    eq(byKeyword.definitions[0].id, 'flow-two')

    const limited = await listTool.execute({ limit: 1 })
    eq(limited.count, 1)
    eq(limited.hasMore, true)
    eq(limited.total >= 2, true)
    const bad = await listTool.execute({ limit: 0 })
    eq(bad.ok, false)
    ok(/limit/.test(bad.error))
  })

  await check('definition_get：默认最新版 + 指定版本 + 未知版本/定义', async () => {
    const getTool = byName(tools, 'flow_definition_get')
    const latest = await getTool.execute({ definitionId: 'flow-chain' })
    eq(latest.ok, true)
    eq(latest.definitionVersion, 1)
    eq(latest.definitionId, 'flow-chain')
    ok(latest.xml.includes('id="human1"'), '返回该版本 XML')
    eq(latest.xmlTruncated, false)
    eq(latest.xmlBytes > 0, true)

    const versioned = await getTool.execute({ definitionId: 'flow-chain', version: 1 })
    eq(versioned.ok, true)
    eq(versioned.definitionVersion, 1)

    const missingVersion = await getTool.execute({ definitionId: 'flow-chain', version: 99 })
    eq(missingVersion.ok, false)
    eq(missingVersion.code, 'DEFINITION_VERSION_NOT_FOUND')
    eq(missingVersion.retryable, false)

    const missing = await getTool.execute({ definitionId: 'nope' })
    eq(missing.ok, false)
    eq(missing.code, 'DEFINITION_NOT_FOUND')
  })

  // ---------------------------------------------------------------------
  // 1. 全链路只用工具
  // ---------------------------------------------------------------------
  let chainInstanceId = null
  await check('全链路：run → 人工任务 → complete_task → agent → finish → COMPLETED', async () => {
    const runTool = byName(tools, 'flow_instance_run')
    const run = await runTool.execute(
      { definitionId: 'flow-chain', variables: { amount: 7, note: 'hi' } },
      execWith('session-e3-a'),
    )
    eq(run.ok, true, JSON.stringify(run))
    eq(run.status, 'ACTIVE')
    eq(run.definitionId, 'flow-chain')
    eq(run.definitionVersion, 1)
    eq(run.startedBy, 'session-e3-a', 'startedBy 绑定调用方会话')
    ok(typeof run.instanceId === 'string' && run.instanceId.startsWith('i-'), '返回实例 id')
    eq(run.pendingTasks.length, 1)
    eq(run.pendingTasks[0].activityId, 'human1')
    chainInstanceId = run.instanceId

    const getTool = byName(tools, 'flow_instance_get')
    const paused = await getTool.execute({ instanceId: chainInstanceId, include: ['tasks', 'lastError'] })
    eq(paused.ok, true)
    eq(paused.status, 'ACTIVE')
    eq(paused.startedBy, 'session-e3-a')
    deep(paused.tasks.map(task => task.activityId), ['human1'])
    eq(paused.lastError, null)
    eq(paused.variables.amount, 7)

    const eventsTool = byName(tools, 'flow_instance_events')
    const before = await eventsTool.execute({ instanceId: chainInstanceId })
    eq(before.ok, true)
    ok(eventTypes(before.events).includes('activity/wait'), '人工等待写 activity/wait')
    eq(before.events.at(-1).seq, before.nextSince)
    eq(before.lastSeq >= before.nextSince, true)

    const completeTool = byName(tools, 'flow_instance_complete_task')
    const completed = await completeTool.execute({
      instanceId: chainInstanceId,
      activityId: 'human1',
      payload: { approved: true, amount: 8 },
    })
    eq(completed.ok, true, JSON.stringify(completed))
    eq(completed.status, 'COMPLETED', 'agent 通过 finish gate 完成流程')
    deep(completed.pendingTasks, [])
    eq(adapter.calls.length, 1, 'agent 真的被调用一次')

    const after = await getTool.execute({ instanceId: chainInstanceId, include: ['tasks', 'artifacts', 'lastError'] })
    eq(after.status, 'COMPLETED')
    eq(after.variables.approved, true)
    eq(after.variables.agentOk, true, 'agent finish 变量并入实例')
    deep(after.tasks, [])
    deep(after.artifacts, [])
    eq(after.lastError, null)

    const eventsAfter = await eventsTool.execute({ instanceId: chainInstanceId, since: before.nextSince })
    ok(eventTypes(eventsAfter.events).includes('process/end'), '完成写 process/end')
    eq(eventsAfter.nextSince, eventsAfter.lastSeq)
    ok(eventsAfter.events.every(event => event.seq > before.nextSince))
  })

  // ---------------------------------------------------------------------
  // 2. 越权与拒绝
  // ---------------------------------------------------------------------
  await check('参数：超限 variables 在发请求前拒绝（键 / 单串 / 总量）', async () => {
    const counting = makeCountingRuntime()
    const runTool = byName(toolsFor(counting), 'flow_instance_run')

    const tooManyKeys = {}
    for (let index = 0; index < 33; index += 1) tooManyKeys[`k${index}`] = index
    const keys = await runTool.execute({ definitionId: 'flow-chain', variables: tooManyKeys })
    eq(keys.ok, false)
    eq(keys.code, 'NODE_VARIABLES_INVALID')
    ok(/32/.test(keys.error))

    const longString = await runTool.execute({ definitionId: 'flow-chain', variables: { text: 'x'.repeat(513) } })
    eq(longString.ok, false)
    eq(longString.code, 'NODE_VARIABLES_INVALID')
    ok(/512/.test(longString.error))

    const tooBig = {}
    for (let index = 0; index < 20; index += 1) tooBig[`k${index}`] = 'y'.repeat(500)
    const bytes = await runTool.execute({ definitionId: 'flow-chain', variables: tooBig })
    eq(bytes.ok, false)
    eq(bytes.code, 'NODE_VARIABLES_INVALID')
    ok(/8192/.test(bytes.error))

    const nested = await runTool.execute({ definitionId: 'flow-chain', variables: { deep: { a: 1 } } })
    eq(nested.ok, false)
    ok(/boolean \/ number \/ null/.test(nested.error))
    eq(counting.calls.length, 0, '参数错误不能发请求')
  })

  await check('workspace：allowlist 外拒绝；worktree 缺 workspace 拒绝；能力缺失明确拒绝', async () => {
    const repo = makeGitRepo('ws-repo')
    const allowedRuntime = makeRuntime(makeFakeAdapters(adapter), { workspaceAllowlist: [repo] })
    try {
      const runTool = byName(toolsFor(allowedRuntime), 'flow_instance_run')
      const outside = await runTool.execute({ definitionId: 'flow-chain', workspace: home })
      eq(outside.ok, false)
      eq(outside.code, 'WORKSPACE_NOT_ALLOWED')

      const missing = await runTool.execute({ definitionId: 'flow-chain', workspace: join(home, 'missing-dir') })
      eq(missing.ok, false)
      eq(missing.code, 'WORKSPACE_MISSING')

      const worktreeWithoutWorkspace = await runTool.execute({ definitionId: 'flow-chain', worktree: 'on' })
      eq(worktreeWithoutWorkspace.ok, false)
      ok(/需要同时给 workspace/.test(worktreeWithoutWorkspace.error))

      const relative = await runTool.execute({ definitionId: 'flow-chain', workspace: 'relative/path' })
      eq(relative.ok, false)
      ok(/绝对路径/.test(relative.error))

      const created = await runTool.execute({
        definitionId: 'flow-chain',
        workspace: repo,
        worktree: { mode: 'on', cleanup: 'retain' },
      })
      eq(created.ok, true, JSON.stringify(created))
      eq(created.workspace.mode, 'worktree')
      await byName(toolsFor(allowedRuntime), 'flow_instance_cancel').execute({ instanceId: created.instanceId })
    } finally {
      await allowedRuntime.dispose()
    }

    // 能力缺失：不静默忽略 workspace，明确 WORKSPACE_POLICY_MISSING。
    const noCapability = { async handle() { throw new Error('不应发出请求') } }
    const noCapTools = toolsFor(noCapability)
    const noCap = await byName(noCapTools, 'flow_instance_run').execute({ definitionId: 'flow-chain', workspace: repo })
    eq(noCap.ok, false)
    eq(noCap.code, 'WORKSPACE_POLICY_MISSING')
    ok(/没有 workspace/.test(noCap.error))
  })

  await check('拒绝：未知 definition / 未知 instance / 未知 task', async () => {
    const runTool = byName(tools, 'flow_instance_run')
    const unknownDefinition = await runTool.execute({ definitionId: 'no-such-def' })
    eq(unknownDefinition.ok, false)
    eq(unknownDefinition.code, 'DEFINITION_NOT_FOUND')

    const getTool = byName(tools, 'flow_instance_get')
    const unknownGet = await getTool.execute({ instanceId: 'i-missing' })
    eq(unknownGet.ok, false)
    eq(unknownGet.code, 'INSTANCE_NOT_FOUND')

    const unknownEvents = await byName(tools, 'flow_instance_events').execute({ instanceId: 'i-missing' })
    eq(unknownEvents.ok, false)
    eq(unknownEvents.code, 'INSTANCE_NOT_FOUND')

    const unknownCancel = await byName(tools, 'flow_instance_cancel').execute({ instanceId: 'i-missing' })
    eq(unknownCancel.ok, false)
    eq(unknownCancel.code, 'INSTANCE_NOT_FOUND')

    const unknownComplete = await byName(tools, 'flow_instance_complete_task')
      .execute({ instanceId: 'i-missing', activityId: 'human1' })
    eq(unknownComplete.ok, false)
    eq(unknownComplete.code, 'INSTANCE_NOT_FOUND')

    // 两个 ACTIVE 实例：在 A 的绑定里做 B 的任务会被本地拒绝；未知 task 不被误报成「已完成」。
    const second = await runTool.execute({ definitionId: 'flow-chain' }, execWith('session-e3-b'))
    eq(second.ok, true)
    const boundTools = toolsFor(runtime, { binding: { instanceId: second.instanceId } })
    const cross = await byName(boundTools, 'flow_instance_complete_task')
      .execute({ instanceId: chainInstanceId, activityId: 'human1' })
    eq(cross.ok, false)
    ok(/工具绑定实例/.test(cross.error), '绑定实例不能通过改 instanceId 跨实例写入')

    const crossCancel = await byName(boundTools, 'flow_instance_cancel').execute({ instanceId: chainInstanceId })
    eq(crossCancel.ok, false)
    ok(/工具绑定实例/.test(crossCancel.error))

    const crossGet = await byName(boundTools, 'flow_instance_get').execute({ instanceId: chainInstanceId })
    eq(crossGet.ok, false)
    ok(/工具绑定实例/.test(crossGet.error))

    const unknownTask = await byName(tools, 'flow_instance_complete_task')
      .execute({ instanceId: second.instanceId, activityId: 'no-such-task' })
    eq(unknownTask.ok, false)
    eq(unknownTask.code, 'BPMN_TASK_NOT_FOUND', '未知 task 不冒充 TASK_ALREADY_COMPLETED')

    await byName(tools, 'flow_instance_cancel').execute({ instanceId: second.instanceId })
  })

  await check('拒绝：终态 cancel 不产生新事件；重复 complete → TASK_ALREADY_COMPLETED', async () => {
    const eventsTool = byName(tools, 'flow_instance_events')
    const cancelTool = byName(tools, 'flow_instance_cancel')
    const completeTool = byName(tools, 'flow_instance_complete_task')

    const beforeCancel = await eventsTool.execute({ instanceId: chainInstanceId })
    const canceled = await cancelTool.execute({ instanceId: chainInstanceId, reason: '已经完成，不该再取消' })
    eq(canceled.ok, false)
    eq(canceled.code, 'INSTANCE_ALREADY_TERMINAL')
    eq(canceled.retryable, false)
    const afterCancel = await eventsTool.execute({ instanceId: chainInstanceId })
    eq(afterCancel.lastSeq, beforeCancel.lastSeq, '终态 cancel 一个事件都不追加')

    const duplicate = await completeTool.execute({ instanceId: chainInstanceId, activityId: 'human1' })
    eq(duplicate.ok, false)
    eq(duplicate.code, 'TASK_ALREADY_COMPLETED')
    eq(duplicate.retryable, false)
    const afterDuplicate = await eventsTool.execute({ instanceId: chainInstanceId })
    eq(afterDuplicate.lastSeq, beforeCancel.lastSeq, '重复 complete 不产生新事件')
  })

  // ---------------------------------------------------------------------
  // 3. 读类工具在 runner 未启动时可用
  // ---------------------------------------------------------------------
  await check('读类工具：runner 未启动可读，且调用后 _runners.size === 0', async () => {
    // 一个仍停在人工任务的 ACTIVE 实例（旧 runtime 建好后释放，模拟进程重启）。
    const active = await byName(tools, 'flow_instance_run')
      .execute({ definitionId: 'flow-chain' }, execWith('session-e3-restart'))
    eq(active.ok, true)
    eq(active.status, 'ACTIVE')
    await runtime.dispose()

    const restarted = makeRuntime(makeFakeAdapters(makeFakeAdapter()))
    try {
      eq(restarted._runners.size, 0, '新 runtime 没有内存 runner')
      const readTools = toolsFor(restarted)
      const getTool = byName(readTools, 'flow_instance_get')
      const eventsTool = byName(readTools, 'flow_instance_events')

      const definitions = await byName(readTools, 'flow_definition_list').execute({})
      eq(definitions.ok, true)
      const definition = await byName(readTools, 'flow_definition_get').execute({ definitionId: 'flow-chain' })
      eq(definition.ok, true)

      const detail = await getTool.execute({ instanceId: active.instanceId, include: ['tasks'] })
      eq(detail.ok, true)
      eq(detail.status, 'ACTIVE')
      eq(detail.startedBy, 'session-e3-restart', '重启后仍能读到启动会话（落盘，不依赖内存）')
      deep(detail.tasks.map(task => task.activityId), ['human1'])
      eq(restarted._runners.size, 0, 'GET 语义的实例详情不能懒恢复')

      const events = await eventsTool.execute({ instanceId: active.instanceId })
      eq(events.ok, true)
      eq(events.lastSeq > 0, true)
      eq(restarted._runners.size, 0, '读事件不创建 runner')

      const listed = await byName(readTools, 'flow_instance_list').execute({ status: 'ACTIVE' })
      eq(listed.ok, true)
      ok(listed.instances.some(item => item.instanceId === active.instanceId))
      const found = listed.instances.find(item => item.instanceId === active.instanceId)
      eq(found.startedBy, 'session-e3-restart')
      eq(restarted._runners.size, 0, '读列表不创建 runner')

      // 完成后的实例在冷 runtime 里同样可读。
      const completedDetail = await getTool.execute({ instanceId: chainInstanceId })
      eq(completedDetail.status, 'COMPLETED')
      const completedEvents = await eventsTool.execute({ instanceId: chainInstanceId })
      ok(eventTypes(completedEvents.events).includes('process/end'))
      eq(restarted._runners.size, 0)

      // 长正文事件：工具只给 bodyRef，不把大文本塞进结果。
      await appendInstanceEvents(
        active.instanceId,
        'agent1',
        1,
        [{ type: 'agent/log', at: new Date().toISOString(), elementId: 'agent1', note: '长'.repeat(2000) }],
        { instancesRoot: restarted.instancesRoot },
      )
      eq(restarted._runners.size, 0)
      const withLong = await eventsTool.execute({ instanceId: active.instanceId, limit: 200 })
      const longEvent = withLong.events.find(event => event.type === 'agent/log')
      ok(longEvent, '读到长正文事件')
      ok(typeof longEvent.note.bodyRef === 'string', '长正文给 bodyRef')
      ok(longEvent.note.truncated === true)
      ok(longEvent.note.bytes > 1024)
      ok(!JSON.stringify(longEvent).includes('长长长'), '不返回大文本本体')
      eq(restarted._runners.size, 0, 'append / 读事件都不创建 runner')
    } finally {
      await restarted.dispose()
    }
  })

  await check('events：since 游标 / limit / 未知实例', async () => {
    const restarted = makeRuntime(makeFakeAdapters(makeFakeAdapter()))
    try {
      const eventsTool = byName(toolsFor(restarted), 'flow_instance_events')
      const first = await eventsTool.execute({ instanceId: chainInstanceId, limit: 2 })
      eq(first.ok, true)
      eq(first.count, 2)
      eq(first.hasMore, true)
      ok(first.nextSince > 0)
      const next = await eventsTool.execute({ instanceId: chainInstanceId, since: first.nextSince, limit: 2 })
      eq(next.ok, true)
      ok(next.events.every(event => event.seq > first.nextSince))

      const invalid = await eventsTool.execute({ instanceId: chainInstanceId, since: -1 })
      eq(invalid.ok, false)
      ok(/since/.test(invalid.error))
    } finally {
      await restarted.dispose()
    }
  })

  await check('instance_list：cursor 分页不重不漏，非法 cursor 明确拒绝', async () => {
    const pagedRuntime = makeRuntime(makeFakeAdapters(makeFakeAdapter()))
    try {
      const localTools = toolsFor(pagedRuntime)
      const runTool = byName(localTools, 'flow_instance_run')
      const started = []
      for (let index = 0; index < 2; index += 1) {
        const created = await runTool.execute({ definitionId: 'flow-chain' }, execWith(`session-page-${index}`))
        eq(created.ok, true)
        started.push(created.instanceId)
      }
      const listTool = byName(localTools, 'flow_instance_list')
      const first = await listTool.execute({ status: 'ACTIVE', limit: 1 })
      eq(first.ok, true)
      eq(first.count, 1)
      eq(first.hasMore, true)
      ok(typeof first.nextCursor === 'string')
      const second = await listTool.execute({ status: 'ACTIVE', limit: 1, cursor: first.nextCursor })
      eq(second.ok, true)
      const ids = [...first.instances, ...second.instances].map(item => item.instanceId)
      eq(new Set(ids).size, ids.length, '分页不重复')
      ok(started.every(id => ids.includes(id)), '分页覆盖两个新建实例')

      const invalid = await listTool.execute({ status: 'ACTIVE', cursor: 'i-not-in-page' })
      eq(invalid.ok, false)
      eq(invalid.code, 'CURSOR_INVALID')
      eq(invalid.retryable, false)
    } finally {
      await pagedRuntime.dispose()
    }
  })

  // ---------------------------------------------------------------------
  // 5. 与 GUI 并发：同一实例同一任务同时提交，只有一次成功
  // ---------------------------------------------------------------------
  await check('并发：同一实例同一人工任务（工具 + GUI 路由）只有一次成功', async () => {
    const concurrentRuntime = makeRuntime(makeFakeAdapters(makeFakeAdapter()))
    try {
      const localTools = toolsFor(concurrentRuntime)
      const run = await byName(localTools, 'flow_instance_run')
        .execute({ definitionId: 'flow-chain' }, execWith('session-e3-race'))
      eq(run.ok, true)
      const completeTool = byName(localTools, 'flow_instance_complete_task')

      const [toolA, gui, toolB] = await Promise.all([
        completeTool.execute({ instanceId: run.instanceId, activityId: 'human1', payload: { by: 'toolA' } }),
        concurrentRuntime.handle({
          method: 'POST',
          parts: ['instances', run.instanceId, 'tasks', 'human1', 'complete'],
          url: new URL('http://localhost/'),
          body: { payload: { by: 'gui' } },
        }),
        completeTool.execute({ instanceId: run.instanceId, activityId: 'human1', payload: { by: 'toolB' } }),
      ])

      const toolSuccesses = [toolA, toolB].filter(result => result.ok === true).length
      const guiSuccesses = gui.status === 200 && gui.body.ok === true ? 1 : 0
      eq(toolSuccesses + guiSuccesses, 1, '同一任务只能成功一次')
      for (const result of [toolA, toolB]) {
        if (result.ok !== true) {
          ok(['TASK_ALREADY_COMPLETED', 'BPMN_TASK_NOT_FOUND', 'BPMN_INSTANCE_TERMINAL', 'BPMN_INSTANCE_NOT_WAITING']
            .includes(result.code), `失败方给出可定位的 code（收到 ${result.code}）`)
        }
      }

      const events = await byName(localTools, 'flow_instance_events').execute({ instanceId: run.instanceId, limit: 200 })
      const humanEnds = events.events.filter(event => event.type === 'activity/end' && event.elementId === 'human1')
      eq(humanEnds.length, 1, '人工任务只完成一次（activity/end 只有一条）')
      const instance = await byName(localTools, 'flow_instance_get').execute({ instanceId: run.instanceId })
      eq(instance.status, 'COMPLETED')
    } finally {
      await concurrentRuntime.dispose()
    }
  })

  // 收尾：等待可能还在收口的 runner，避免删除 home 时报 ENOTEMPTY。
  await waitUntil(() => runtime._runners.size === 0, 500)
  await runtime.dispose()
} finally {
  rmSync(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 组失败：`)
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error && failure.error.stack ? failure.error.stack : failure.error}`)
  process.exit(1)
}
console.log(`\n${checks} 组通过（${assertions} 条断言）`)
