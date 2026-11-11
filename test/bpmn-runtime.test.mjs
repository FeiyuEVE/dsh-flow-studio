#!/usr/bin/env node
/**
 * BPMN 运行时自检（0.13.0）：灰度开关 / 定义版本 / 实例推进 / 人工任务 /
 * 并发完成 / 中止 / 懒恢复 / handler 边界。
 *
 * 全部走真实 HTTP 路由夹具（照 `test/host.test.mjs` 的 createHandler + Readable 做法），
 * 唯一例外是「进程重启」用例：直接建两个 runtime 实例，验证内存注册表丢掉后能从
 * state.json 恢复（这正是新引擎的关键可靠性）。
 *
 * 禁止：不真跑 codex、不起 dsh 子会话、不发真实 HTTP。serviceTask 一律用注入的
 * 桩 executor；dsh adapter 只验证「明确失败」。
 *
 * 产物落在项目 `.tmp/` 下（每个用例一个新 home，结束清理），不占系统 /tmp。
 * 运行：node test/bpmn-runtime.test.mjs
 */

import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const {
  createBpmnRuntime, executeAgent, executeHttp, BPMN_ENGINE_VERSION,
} = await import('../src/bpmn-runtime.js')
const { createHandler } = await import('../src/index.js')
const store = await import('../src/store.js')
const runstore = await import('../src/runstore.js')

let checks = 0
let assertions = 0

function eq(actual, expected, message) {
  assertions += 1
  assert.equal(actual, expected, message)
}

function ok(value, message) {
  assertions += 1
  assert.ok(value, message)
}

function deep(actual, expected, message) {
  assertions += 1
  assert.deepEqual(actual, expected, message)
}

async function rejects(fn, predicate, message) {
  assertions += 1
  await assert.rejects(fn, predicate, message)
}

/** 一个用例一个全新 home；`fn` 负责自己建 handler / runtime。 */
async function check(name, fn) {
  const home = mkdtempSync(join(repoRoot, '.tmp', 'home-bpmn-'))
  try {
    await fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

/** 伪造的 Cordis 上下文：只实现 createHandler / apply 用到的那几个成员。 */
function makeCtx() {
  return {
    webServer: { register() { return () => {} } },
    effect(fn) { return fn() },
    logger: { warn() {}, error() {}, info() {} },
    get(name) {
      if (name === 'connection') return { requestRejection: () => undefined }
      return undefined
    },
  }
}

/** 桩 executor：不真跑 codex / custom，只证明 handler 路径被调用。 */
function makeFakeExecutor(calls = []) {
  return async options => {
    calls.push(options)
    return {
      ok: true,
      text: 'agent-stub-result',
      structured: { ok: true },
      usage: { input: 3, cacheRead: 0, cacheWrite: 0, output: 2, total: 5 },
      exitCode: 0,
      events: [],
    }
  }
}

function makeEnv(home, opts = {}) {
  return {
    dir: store.flowsDir(home),
    runsRoot: runstore.runsDir(home),
    ctx: makeCtx(),
    engine: { engineName: 'stub' },
    startOptions: new Map(),
    ...opts,
  }
}

/** 发一个请求给路由，返回 { status, headers, body, json }。 */
function call(route, method, url, body, headers = {}) {
  return new Promise(resolveCall => {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = Readable.from(payload)
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', ...headers }
    req.socket = { remoteAddress: '127.0.0.1' }
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      headersSent: false,
      writeHead(code, extra) {
        this.statusCode = code
        this.headers = extra || {}
        this.headersSent = true
        return this
      },
      end(chunk) {
        if (chunk) this.body += String(chunk)
        let json = null
        try {
          json = JSON.parse(this.body)
        } catch {
          json = null
        }
        resolveCall({ status: this.statusCode, headers: this.headers, body: this.body, json })
      },
    }
    void route.handler(req, res)
  })
}

const API = '/api/flow-studio'

function workflowXml(processId = 'proc-demo') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="defs-${processId}" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="${processId}" name="演示流程" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="agent1" name="写草稿">
      <bpmn:extensionElements>
        <fs:node nodeType="agent" adapter="custom">
          <fs:executor kind="custom" command="echo stub"/>
        </fs:node>
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

function noProcessXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="defs-empty" targetNamespace="http://example.com/flow-studio"/>`
}

function badFeelXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="defs-bad-feel" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-bad-feel" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="agent1">
      <bpmn:extensionElements>
        <fs:node nodeType="agent" adapter="custom">
          <fs:executor kind="custom" command="echo stub"/>
        </fs:node>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:userTask id="human1"/>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="agent1" targetRef="human1">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="javascript">amount &gt; 1</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f3" sourceRef="human1" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
}

async function seed(route, body = {}) {
  const saved = await call(route, 'POST', `${API}/definitions`, {
    id: 'flow-demo',
    name: '演示流程',
    xml: workflowXml(),
    ...body,
  })
  eq(saved.status, 201, JSON.stringify(saved.json))
  return saved.json
}

async function startInstance(route, extra = {}) {
  const created = await call(route, 'POST', `${API}/instances`, {
    definitionId: 'flow-demo',
    variables: { amount: 7 },
    ...extra,
  })
  eq(created.status, 201, JSON.stringify(created.json))
  return created.json
}

function readInstanceJson(home, id) {
  return JSON.parse(readFileSync(join(home, 'flow-studio', 'instances', id, 'instance.json'), 'utf8'))
}

function eventTypes(events) {
  return events.map(event => event.type)
}

function countType(events, type) {
  return events.filter(event => event.type === type).length
}

try {
  // -------------------------------------------------------------------------
  // 1. 灰度开关默认关：新路由 404 + BPMN_DISABLED，老路由不受影响
  // -------------------------------------------------------------------------
  await check('开关关闭：/definitions 与 /instances 404 + BPMN_DISABLED，/health 与 /flows 正常', async home => {
    process.env.FLOW_STUDIO_BPMN = '0'
    const route = { handler: createHandler(makeEnv(home)) }

    for (const path of ['/definitions', '/instances']) {
      const res = await call(route, 'GET', `${API}${path}`)
      eq(res.status, 404, `${path} 关闭时必须 404`)
      eq(res.json.code, 'BPMN_DISABLED', `${path} 关闭时必须带 BPMN_DISABLED`)
      ok(typeof res.json.hint === 'string' && res.json.hint.includes('FLOW_STUDIO_BPMN=1'), 'hint 告诉怎么开')
    }

    const health = await call(route, 'GET', `${API}/health`)
    eq(health.status, 200, 'health 不受开关影响')
    deep(health.json.bpmn, { enabled: false }, '关着时 health 只回 enabled:false，不创建运行时')
    eq(health.json.ok, true)

    const flows = await call(route, 'GET', `${API}/flows`)
    eq(flows.status, 200, '老 /flows 不受影响')
    ok(Array.isArray(flows.json.flows) && flows.json.flows.length >= 1, '老流程列表照常返回')
    ok(!existsSync(join(home, 'flow-studio', 'definitions')), '关着时不该创建 definitions/')
  })

  // -------------------------------------------------------------------------
  // 2. 定义域：版本递增 / 同 XML 新版本 / 坏 XML 400
  // -------------------------------------------------------------------------
  await check('定义域：保存版本、同 XML 再存是新版本、坏 XML 400 且不落盘', async home => {
    process.env.FLOW_STUDIO_BPMN = '1'
    const route = { handler: createHandler(makeEnv(home)) }

    const first = await seed(route)
    eq(first.created, true)
    eq(first.version, 1)
    eq(typeof first.hash, 'string')
    eq(first.hash.length, 64, 'hash 必须是 sha256')

    const second = await seed(route)
    eq(second.created, true, '同样的 XML 再存一次必须新建一版，而不是幂等覆盖')
    eq(second.version, 2, '新版本号递增')
    eq(second.hash, first.hash, '同内容 hash 相同')

    const list = await call(route, 'GET', `${API}/definitions`)
    eq(list.status, 200)
    const entry = list.json.definitions.find(item => item.id === 'flow-demo')
    eq(entry.versionCount, 2)
    eq(entry.latestVersion, 2)
    eq(entry.latestHash, first.hash)
    deep(entry.versions.map(item => item.version), [1, 2], '版本列表升序')

    const detail = await call(route, 'GET', `${API}/definitions/flow-demo?version=1`)
    eq(detail.status, 200)
    eq(detail.json.version, 1)
    eq(detail.json.xml, workflowXml(), '按 ?version= 返回指定版本正本')
    const latest = await call(route, 'GET', `${API}/definitions/flow-demo`)
    eq(latest.json.version, 2, '不带 version 时返回最新版')
    const missingV = await call(route, 'GET', `${API}/definitions/flow-demo?version=99`)
    eq(missingV.status, 404)
    eq(missingV.json.code, 'DEFINITION_VERSION_NOT_FOUND')

    const noProcess = await call(route, 'POST', `${API}/definitions`, { id: 'bad-empty', name: '空', xml: noProcessXml() })
    eq(noProcess.status, 400)
    eq(noProcess.json.code, 'BPMN_XML_INVALID')
    ok(noProcess.json.errors.some(item => item.code === 'BPMN_NO_PROCESS'), '缺 process 必须报 BPMN_NO_PROCESS')

    const badFeel = await call(route, 'POST', `${API}/definitions`, { id: 'bad-feel', name: '坏 FEEL', xml: badFeelXml() })
    eq(badFeel.status, 400, '非 FEEL 条件必须 400')
    eq(badFeel.json.code, 'BPMN_XML_INVALID')
    ok(badFeel.json.errors.some(item => item.code === 'CONDITION_LANGUAGE_NOT_FEEL'), '必须点名条件语言问题')

    const afterBad = await call(route, 'GET', `${API}/definitions`)
    ok(!afterBad.json.definitions.some(item => item.id === 'bad-empty' || item.id === 'bad-feel'), '坏 XML 不得落盘')
    eq(afterBad.json.definitions.length, 1, '定义域里仍然只有一份合法定义')
  })

  // -------------------------------------------------------------------------
  // 3. 建实例 → serviceTask → userTask waiting + pendingTasks + 事件
  // -------------------------------------------------------------------------
  await check('实例：跑到 userTask 变 waiting，instance.json 有 pendingTasks，事件流三类齐全', async home => {
    process.env.FLOW_STUDIO_BPMN = '1'
    const calls = []
    const route = { handler: createHandler(makeEnv(home, { bpmnExecutor: makeFakeExecutor(calls) })) }
    await seed(route)

    const instance = await startInstance(route)
    eq(instance.status, 'waiting')
    eq(instance.pendingTasks.length, 1, '必须停在人工任务上')
    eq(instance.pendingTasks[0].activityId, 'human1')
    ok(instance.lastSeq > 0, '事件必须已经落盘')
    eq(calls.length, 1, 'serviceTask 必须调用一次外部 executor 桩')

    const raw = readInstanceJson(home, instance.id)
    eq(raw.status, 'waiting')
    eq(raw.pendingTasks.length, 1, 'instance.json 必须真的带 pendingTasks')
    eq(raw.pendingTasks[0].activityId, 'human1')
    eq(raw.pendingTasks[0].executionId, instance.pendingTasks[0].executionId)

    const events = await call(route, 'GET', `${API}/instances/${instance.id}/events`)
    eq(events.status, 200)
    const types = eventTypes(events.json.events)
    ok(types.includes('process/start'), '事件流必须含 process/start')
    ok(types.includes('activity/start'), '事件流必须含 activity/start')
    ok(types.includes('activity/wait'), '事件流必须含 activity/wait')
    eq(types.filter(type => type === 'activity/wait').length, 1, 'wait 只能有一条')
    const seqs = events.json.events.map(event => event.seq)
    deep(seqs, [...seqs].sort((a, b) => a - b), '事件按 seq 升序')

    const tasks = await call(route, 'GET', `${API}/instances/${instance.id}/tasks`)
    eq(tasks.status, 200)
    eq(tasks.json.tasks.length, 1)
    eq(tasks.json.tasks[0].activityId, 'human1')

    const list = await call(route, 'GET', `${API}/instances?definitionId=flow-demo&status=waiting`)
    eq(list.status, 200)
    eq(list.json.instances.length, 1)
    eq(list.json.instances[0].active, true, '内存里有 runner 时 active=true')

    const health = await call(route, 'GET', `${API}/health`)
    eq(health.status, 200)
    eq(health.json.bpmn.enabled, true)
    eq(health.json.bpmn.engine, BPMN_ENGINE_VERSION)
    eq(health.json.bpmn.definitions, 1, 'health 里的定义数必须现算')
    eq(health.json.bpmn.instances, 1, 'health 里的实例数必须现算')
    eq(health.json.bpmn.active, 1, '等待人工任务算活跃')

    const missing = await call(route, 'GET', `${API}/instances/i-not-exist`)
    eq(missing.status, 404)
    eq(missing.json.code, 'INSTANCE_NOT_FOUND')

    // 目录隔离：定义域在 flow-studio/definitions，不在老的 flows/ 下。
    ok(existsSync(join(home, 'flow-studio', 'definitions', 'flow-demo', '1.bpmn')), '定义正本落在 definitions/')
    ok(!existsSync(join(home, 'flow-studio', 'flows', 'definitions')), '不许写进老的 flows 目录')
    ok(existsSync(join(home, 'flow-studio', 'instances', instance.id, 'state.json')), 'wait 点必须落 state.json')
  })

  // -------------------------------------------------------------------------
  // 4. 完成人工任务 → done + activity/end / flow/taken / process/end
  // -------------------------------------------------------------------------
  await check('人工任务完成：推进到 done，事件流含 activity/end、flow/taken、process/end', async home => {
    process.env.FLOW_STUDIO_BPMN = '1'
    const route = { handler: createHandler(makeEnv(home, { bpmnExecutor: makeFakeExecutor() })) }
    await seed(route)
    const instance = await startInstance(route)

    const done = await call(route, 'POST', `${API}/instances/${instance.id}/tasks/human1/complete`, {
      payload: { approved: true },
      decidedBy: 'tester',
    })
    eq(done.status, 200, JSON.stringify(done.json))
    eq(done.json.status, 'done')
    deep(done.json.pendingTasks, [], '完成后没有待办')
    eq(done.json.decidedBy, 'tester')

    const raw = readInstanceJson(home, instance.id)
    eq(raw.status, 'done')
    deep(raw.pendingTasks, [], '完成后的 instance.json 不能留下待办')
    eq(raw.variables.approved, true, 'payload 必须写回变量')
    eq(raw.variables.decidedBy, 'tester', 'decidedBy 进变量留审计')

    const events = await call(route, 'GET', `${API}/instances/${instance.id}/events`)
    const types = eventTypes(events.json.events)
    ok(types.includes('activity/end'), '必须含 activity/end')
    ok(types.includes('flow/taken'), '必须含 flow/taken')
    ok(types.includes('process/end'), '必须含 process/end')
    eq(countType(events.json.events, 'process/end'), 1, 'process/end 只能有一条')
    eq(countType(events.json.events, 'activity/wait'), 1, 'wait 不能重复')
  })

  // -------------------------------------------------------------------------
  // 5. 并发 complete：一个成功、一个 409，pendingTasks 不被写坏
  // -------------------------------------------------------------------------
  await check('并发完成：恰好一个成功、另一个 409，pendingTasks 不被写坏', async home => {
    process.env.FLOW_STUDIO_BPMN = '1'
    const route = { handler: createHandler(makeEnv(home, { bpmnExecutor: makeFakeExecutor() })) }
    await seed(route)
    const instance = await startInstance(route)

    const results = await Promise.all([
      call(route, 'POST', `${API}/instances/${instance.id}/tasks/human1/complete`, { payload: { by: 'A' } }),
      call(route, 'POST', `${API}/instances/${instance.id}/tasks/human1/complete`, { payload: { by: 'B' } }),
    ])
    const fulfilled = results.filter(item => item.status === 200)
    const conflicts = results.filter(item => item.status === 409)
    eq(fulfilled.length, 1, '只允许一个赢家')
    eq(conflicts.length, 1, '输家必须收到 409')
    ok(['BPMN_INSTANCE_TERMINAL', 'BPMN_TASK_NOT_FOUND'].includes(conflicts[0].json.code), '输家要有稳定错误码')
    ok(typeof conflicts[0].json.error === 'string' && conflicts[0].json.error !== '', '409 必须可读')

    const raw = readInstanceJson(home, instance.id)
    eq(raw.status, 'done')
    deep(raw.pendingTasks, [], '并发不能让 pendingTasks 残留 / 半写')
    const detail = await call(route, 'GET', `${API}/instances/${instance.id}`)
    deep(detail.json.pendingTasks, [])
    const events = await call(route, 'GET', `${API}/instances/${instance.id}/events`)
    eq(countType(events.json.events, 'process/end'), 1, '并发完成不能产生两条 process/end')
  })

  // -------------------------------------------------------------------------
  // 6. stop：aborted 终态、事件不重复、幂等
  // -------------------------------------------------------------------------
  await check('中止实例：aborted 终态，事件不新增不重复，重复 stop 幂等', async home => {
    process.env.FLOW_STUDIO_BPMN = '1'
    const route = { handler: createHandler(makeEnv(home, { bpmnExecutor: makeFakeExecutor() })) }
    await seed(route)
    const instance = await startInstance(route)

    const before = await call(route, 'GET', `${API}/instances/${instance.id}/events`)
    const beforeTypes = eventTypes(before.json.events)

    const stopped = await call(route, 'POST', `${API}/instances/${instance.id}/stop`)
    eq(stopped.status, 200, JSON.stringify(stopped.json))
    eq(stopped.json.status, 'aborted')
    eq(stopped.json.alreadyTerminal, false)

    const after = await call(route, 'GET', `${API}/instances/${instance.id}/events`)
    eq(after.json.lastSeq, before.json.lastSeq, 'stop 不该追加事件（尤其不能伪造 process/end）')
    deep(eventTypes(after.json.events), beforeTypes, 'stop 不能让事件重复')
    eq(countType(after.json.events, 'process/end'), 0, 'aborted 不是 done，不能有 process/end')

    const detail = await call(route, 'GET', `${API}/instances/${instance.id}`)
    eq(detail.json.status, 'aborted')
    eq(detail.json.recovered, false)
    eq(detail.json.recovery.code, null, '终态实例不需要恢复，原因只说终态')
    ok(detail.json.recovery.reason.includes('aborted'))

    const raw = readInstanceJson(home, instance.id)
    eq(raw.status, 'aborted')
    deep(raw.pendingTasks, [], '中止后待办必须清空')
    ok(typeof raw.completedAt === 'string' && raw.completedAt !== '', '终态要写 completedAt')

    const again = await call(route, 'POST', `${API}/instances/${instance.id}/stop`)
    eq(again.status, 200)
    eq(again.json.alreadyTerminal, true)
    eq(again.json.status, 'aborted')
  })

  // -------------------------------------------------------------------------
  // 7. 懒恢复（关键可靠性）：丢掉内存注册表后从 state.json 恢复并继续到 done
  // -------------------------------------------------------------------------
  await check('懒恢复：新 runtime 丢掉注册表后 GET 能 recovered:true，并继续 complete 到 done', async home => {
    const env = { FLOW_STUDIO_BPMN: '1' }
    const dir = store.flowsDir(home)
    const fake = makeFakeExecutor()
    const url = new URL('http://localhost/')

    const runtimeA = createBpmnRuntime({ dir, env, executorRunner: fake })
    let res = await runtimeA.handle({ method: 'POST', parts: ['definitions'], url, body: { id: 'flow-demo', name: '演示流程', xml: workflowXml() } })
    eq(res.status, 201, JSON.stringify(res.body))
    res = await runtimeA.handle({ method: 'POST', parts: ['instances'], url, body: { definitionId: 'flow-demo', variables: { amount: 7 } } })
    eq(res.status, 201, JSON.stringify(res.body))
    const instanceId = res.body.id
    const executionId = res.body.pendingTasks[0].executionId
    const waitsBefore = (await runtimeA.handle({ method: 'GET', parts: ['instances', instanceId, 'events'], url })).body
      .events.filter(event => event.type === 'activity/wait').length
    eq(waitsBefore, 1)

    // 模拟进程重启：释放 A 的内存注册表（磁盘 state.json 保留）。
    await runtimeA.dispose()

    const runtimeB = createBpmnRuntime({ dir, env, executorRunner: fake })
    const detail = await runtimeB.handle({ method: 'GET', parts: ['instances', instanceId], url })
    eq(detail.status, 200, JSON.stringify(detail.body))
    eq(detail.body.recovered, true, '新 runtime 必须从 state 恢复')
    eq(detail.body.status, 'waiting')
    eq(detail.body.runnerStatus, 'waiting')
    eq(detail.body.pendingTasks.length, 1)
    eq(detail.body.pendingTasks[0].executionId, executionId, '恢复后 executionId 必须一致')

    // 第二次 GET 已经命中内存注册表，不再重复 recover。
    const detailAgain = await runtimeB.handle({ method: 'GET', parts: ['instances', instanceId], url })
    eq(detailAgain.body.recovered, false, '已恢复的 runner 不应每次 GET 都重放 recover')

    const done = await runtimeB.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'tasks', 'human1', 'complete'],
      url,
      body: { payload: { approved: true }, decidedBy: 'recover-test' },
    })
    eq(done.status, 200, JSON.stringify(done.body))
    eq(done.body.status, 'done')
    eq(done.body.recovered, false, 'GET 已把 runner 恢复进内存，complete 命中同一 runner')

    const events = await runtimeB.handle({ method: 'GET', parts: ['instances', instanceId, 'events'], url })
    const types = eventTypes(events.body.events)
    eq(countType(events.body.events, 'activity/wait'), 1, 'recover 重放的 wait 必须去重')
    ok(types.slice(-4).includes('activity/end'), '恢复后继续推进必须产生 activity/end')
    ok(types.includes('flow/taken'))
    eq(countType(events.body.events, 'process/end'), 1, '恢复后只能有一条 process/end')
    const seqs = events.body.events.map(event => event.seq)
    deep(seqs, [...seqs].sort((a, b) => a - b), '恢复后 seq 仍严格递增')

    const raw = readInstanceJson(home, instanceId)
    eq(raw.status, 'done')
    deep(raw.pendingTasks, [])
    await runtimeB.dispose()
  })

  // -------------------------------------------------------------------------
  // 8. handler 边界：dsh 明确失败 / http 明确未实现 / custom 传上下文
  // -------------------------------------------------------------------------
  await check('handler 边界：dsh 报 BPMN_AGENT_ADAPTER_UNAVAILABLE，http 报 BPMN_HTTP_NOT_IMPLEMENTED', async () => {
    const dshElement = { id: 'agent-dsh', node: { adapter: 'dsh', prompt: 'hi' } }
    const missingAdapter = { id: 'agent-none', node: { prompt: 'hi' } }
    const ctx = { attempt: 1, variables: { a: 1 }, signal: new AbortController().signal }

    for (const element of [dshElement, missingAdapter]) {
      await rejects(
        () => executeAgent(element, ctx),
        error => error.code === 'BPMN_AGENT_ADAPTER_UNAVAILABLE',
        'dsh / 缺失 adapter 必须明确失败，不能伪造 handler',
      )
    }

    await rejects(
      () => executeHttp({ id: 'http-1', node: { http: { method: 'GET', url: 'https://example.com' } } }, ctx),
      error => error.code === 'BPMN_HTTP_NOT_IMPLEMENTED',
      '0.13.0 不得实现真实 HTTP',
    )

    // custom 走注入桩：证明 ctx.attempt / variables 被带进 prompt，且没有真跑子进程。
    const calls = []
    const result = await executeAgent(
      { id: 'agent-custom', name: '自定义', node: { adapter: 'custom', executor: { kind: 'custom', command: 'echo stub' } } },
      { attempt: 2, variables: { amount: 7 }, signal: new AbortController().signal, timeoutMs: 1234 },
      { runExecutor: makeFakeExecutor(calls) },
    )
    eq(calls.length, 1)
    ok(calls[0].prompt.includes('attempt=2'), 'attempt 必须传进下游')
    ok(calls[0].prompt.includes('amount'), 'variables 必须传进下游')
    eq(calls[0].timeoutMs, 1234, '超时必须透传')
    deep(result.output, { ok: true })
    eq(result.usage.total, 5)

    // 已 abort 的 signal 必须尽快返回，不进入 executor。
    const aborted = new AbortController()
    aborted.abort()
    await rejects(
      () => executeAgent(dshElement, { attempt: 1, variables: {}, signal: aborted.signal }),
      error => error.code === 'BPMN_ABORTED',
      'abort 必须优先于 adapter 判定',
    )
  })

  // -------------------------------------------------------------------------
  // 8b. 通过实例验证 dsh adapter：实例 failed，result.error.code 保留真实原因
  // -------------------------------------------------------------------------
  await check('实例里的 dsh adapter：failed + result.error.code = BPMN_AGENT_ADAPTER_UNAVAILABLE', async home => {
    process.env.FLOW_STUDIO_BPMN = '1'
    const calls = []
    const route = { handler: createHandler(makeEnv(home, { bpmnExecutor: makeFakeExecutor(calls) })) }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="defs-dsh" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-dsh" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="agent-dsh">
      <bpmn:extensionElements><fs:node nodeType="agent" adapter="dsh"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent-dsh"/>
    <bpmn:sequenceFlow id="f2" sourceRef="agent-dsh" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
    const saved = await call(route, 'POST', `${API}/definitions`, { id: 'flow-dsh', name: 'dsh 节点', xml })
    eq(saved.status, 201, JSON.stringify(saved.json))
    const created = await call(route, 'POST', `${API}/instances`, { definitionId: 'flow-dsh' })
    eq(created.status, 201, JSON.stringify(created.json))
    eq(created.json.status, 'failed', 'dsh adapter 必须让实例明确失败')
    eq(calls.length, 0, '不得偷偷跑外部 executor')

    const detail = await call(route, 'GET', `${API}/instances/${created.json.id}`)
    eq(detail.status, 200)
    eq(detail.json.status, 'failed')
    eq(detail.json.result.error.code, 'BPMN_AGENT_ADAPTER_UNAVAILABLE', '实例 result 必须保留 handler 的真实错误码')
    ok(detail.json.result.error.message.includes('0.13.1'), '文案说明 dsh adapter 在 0.13.1 提供')
  })

  // -------------------------------------------------------------------------
  // 9. 大输出：事件单条上限 8KB，桥接层必须裁剪而不是让实例失败
  // -------------------------------------------------------------------------
  await check('大输出：activity/end 超过 8KB 时事件被裁剪并标 truncated，实例仍能完成', async home => {
    process.env.FLOW_STUDIO_BPMN = '1'
    const hugeExecutor = async () => ({
      ok: true,
      text: 'x'.repeat(20000),
      structured: { blob: 'y'.repeat(20000) },
      usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, total: 2 },
      events: [],
    })
    const route = { handler: createHandler(makeEnv(home, { bpmnExecutor: hugeExecutor })) }
    await seed(route)
    const instance = await startInstance(route)
    eq(instance.status, 'waiting', '大输出不能把实例打挂')

    const events = await call(route, 'GET', `${API}/instances/${instance.id}/events`)
    const agentEnd = events.json.events.find(event => event.type === 'activity/end' && event.elementId === 'agent1')
    ok(agentEnd !== undefined, 'agent 的 activity/end 必须存在')
    eq(agentEnd.truncated, true, '超限事件必须显式标记 truncated')
    ok(Buffer.byteLength(JSON.stringify(agentEnd), 'utf8') <= 8192, '落盘事件不能超过 store 的 8KB 上限')

    const done = await call(route, 'POST', `${API}/instances/${instance.id}/tasks/human1/complete`, { payload: { approved: true } })
    eq(done.status, 200, JSON.stringify(done.json))
    eq(done.json.status, 'done')
  })

  console.log('bpmn-runtime.test.mjs')
  console.log(`BPMN ${BPMN_ENGINE_VERSION} · ${checks} 组通过（${assertions} 条断言）`)
} catch (error) {
  console.error('✗ BPMN 运行时自检失败')
  console.error(error)
  process.exit(1)
}
