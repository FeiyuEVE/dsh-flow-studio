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
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
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
const instStore = await import('../src/instance-store.js')
const { createBpmnRunner } = await import('../src/bpmn-runner.js')

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
  // 1. 新路由常开（没有灰度开关）：/definitions、/instances 直接可用；health 报现算计数
  // -------------------------------------------------------------------------
  await check('新路由常开：/definitions 与 /instances 直接可用，health.bpmn 带现算计数', async home => {
    const route = { handler: createHandler(makeEnv(home)) }

    const defs = await call(route, 'GET', `${API}/definitions`)
    eq(defs.status, 200, '/definitions 必须直接可用（没有开关）')
    eq(defs.json.ok, true)
    ok(Array.isArray(defs.json.definitions), 'definitions 是数组')

    const insts = await call(route, 'GET', `${API}/instances`)
    eq(insts.status, 200, '/instances 必须直接可用')
    ok(Array.isArray(insts.json.instances), 'instances 是数组')

    const health = await call(route, 'GET', `${API}/health`)
    eq(health.status, 200)
    eq(health.json.bpmn.enabled, true, 'health.bpmn.enabled 恒为 true')
    eq(health.json.bpmn.engine, '26.0.6')
    eq(health.json.bpmn.definitions, 0, '计数现算')
    eq(health.json.bpmn.instances, 0, '计数现算')

    const flows = await call(route, 'GET', `${API}/flows`)
    eq(flows.status, 200, '老 /flows 暂时仍在（画布 0.13.3 之前）')
  })

  await check('路由里不存在 BPMN_DISABLED / FLOW_STUDIO_BPMN 开关', async home => {
    const route = { handler: createHandler(makeEnv(home)) }
    process.env.FLOW_STUDIO_BPMN = '0'
    try {
      const res = await call(route, 'GET', `${API}/definitions`)
      eq(res.status, 200, '把 FLOW_STUDIO_BPMN 设成 0 也不该影响路由（开关已删除）')
    } finally {
      delete process.env.FLOW_STUDIO_BPMN
    }
    const src = readFileSync(new URL('../src/bpmn-runtime.js', import.meta.url), 'utf8')
    ok(!src.includes('BPMN_DISABLED'), '源码里不该再有 BPMN_DISABLED')
    ok(!src.includes('isBpmnEnabled'), '源码里不该再有 isBpmnEnabled')
  })

  // -------------------------------------------------------------------------
  // 2. 定义域：版本递增 / 同 XML 新版本 / 坏 XML 400
  // -------------------------------------------------------------------------
  await check('定义域：保存版本、同 XML 再存是新版本、坏 XML 400 且不落盘', async home => {
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
    const calls = []
    const route = { handler: createHandler(makeEnv(home, { bpmnExecutor: makeFakeExecutor(calls) })) }
    await seed(route)

    const instance = await startInstance(route)
    eq(instance.status, 'ACTIVE')
    eq(instance.pendingTasks.length, 1, '必须停在人工任务上')
    eq(instance.pendingTasks[0].activityId, 'human1')
    ok(instance.lastSeq > 0, '事件必须已经落盘')
    eq(calls.length, 1, 'serviceTask 必须调用一次外部 executor 桩')

    const raw = readInstanceJson(home, instance.id)
    eq(raw.status, 'ACTIVE')
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

    const list = await call(route, 'GET', `${API}/instances?definitionId=flow-demo&status=ACTIVE`)
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
    const route = { handler: createHandler(makeEnv(home, { bpmnExecutor: makeFakeExecutor() })) }
    await seed(route)
    const instance = await startInstance(route)

    const done = await call(route, 'POST', `${API}/instances/${instance.id}/tasks/human1/complete`, {
      payload: { approved: true },
      decidedBy: 'tester',
    })
    eq(done.status, 200, JSON.stringify(done.json))
    eq(done.json.status, 'COMPLETED')
    deep(done.json.pendingTasks, [], '完成后没有待办')
    eq(done.json.decidedBy, 'tester')

    const raw = readInstanceJson(home, instance.id)
    eq(raw.status, 'COMPLETED')
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
    eq(raw.status, 'COMPLETED')
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
    const route = { handler: createHandler(makeEnv(home, { bpmnExecutor: makeFakeExecutor() })) }
    await seed(route)
    const instance = await startInstance(route)

    const before = await call(route, 'GET', `${API}/instances/${instance.id}/events`)
    const beforeTypes = eventTypes(before.json.events)

    const stopped = await call(route, 'POST', `${API}/instances/${instance.id}/stop`)
    eq(stopped.status, 200, JSON.stringify(stopped.json))
    eq(stopped.json.status, 'CANCELED')
    eq(stopped.json.alreadyTerminal, false)

    const after = await call(route, 'GET', `${API}/instances/${instance.id}/events`)
    eq(after.json.lastSeq, before.json.lastSeq, 'stop 不该追加事件（尤其不能伪造 process/end）')
    deep(eventTypes(after.json.events), beforeTypes, 'stop 不能让事件重复')
    eq(countType(after.json.events, 'process/end'), 0, 'aborted 不是 done，不能有 process/end')

    const detail = await call(route, 'GET', `${API}/instances/${instance.id}`)
    eq(detail.json.status, 'CANCELED')
    eq(detail.json.recovered, false)
    eq(detail.json.recovery.code, null, '终态实例不需要恢复，原因只说终态')
    ok(detail.json.recovery.reason.includes('CANCELED'))

    const raw = readInstanceJson(home, instance.id)
    eq(raw.status, 'CANCELED')
    deep(raw.pendingTasks, [], '中止后待办必须清空')
    ok(typeof raw.completedAt === 'string' && raw.completedAt !== '', '终态要写 completedAt')

    const again = await call(route, 'POST', `${API}/instances/${instance.id}/stop`)
    eq(again.status, 200)
    eq(again.json.alreadyTerminal, true)
    eq(again.json.status, 'CANCELED')
  })

  // -------------------------------------------------------------------------
  // 7. 懒恢复（关键可靠性）：丢掉内存注册表后从 state.json 恢复并继续到 done
  // -------------------------------------------------------------------------
  await check('懒恢复：新 runtime 丢掉注册表后 GET 能 recovered:true，并继续 complete 到 done', async home => {
    const env = {}
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
    eq(detail.body.status, 'ACTIVE')
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
    eq(done.body.status, 'COMPLETED')
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
    eq(raw.status, 'COMPLETED')
    deep(raw.pendingTasks, [])
    await runtimeB.dispose()
  })

  // -------------------------------------------------------------------------
  // 7.1 恢复校验不能把业务变量误当 BPMN 引用（codex 复审回归）
  // -------------------------------------------------------------------------
  await check('恢复校验：人工任务 payload 里的 id/activityId 等业务键不影响恢复', async home => {
    const env = {}
    const dir = store.flowsDir(home)
    const url = new URL('http://localhost/')
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://x">
  <bpmn:process id="p-business" isExecutable="true">
    <bpmn:startEvent id="s"/>
    <bpmn:userTask id="h1"/>
    <bpmn:userTask id="h2"/>
    <bpmn:endEvent id="e"/>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="h1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="h1" targetRef="h2"/>
    <bpmn:sequenceFlow id="f3" sourceRef="h2" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`
    const runtimeA = createBpmnRuntime({ dir, env })
    let res = await runtimeA.handle({ method: 'POST', parts: ['definitions'], url, body: { id: 'flow-business', name: '业务键', xml } })
    eq(res.status, 201, JSON.stringify(res.body))
    res = await runtimeA.handle({ method: 'POST', parts: ['instances'], url, body: { definitionId: 'flow-business' } })
    eq(res.status, 201, JSON.stringify(res.body))
    const instanceId = res.body.id
    // 业务 payload 的键名恰好与结构引用同名：它们会进 execution.environment.output，
    // 不是 BPMN 元素引用，恢复时不能被误判成「来自另一份引擎」。
    const payload = {
      id: 'business-id',
      activityId: 'biz-activity',
      elementId: 'biz-element',
      flowId: 'biz-flow',
      executionId: 'biz-exec',
      sourceId: 'biz-source',
      targetId: 'biz-target',
      customer: { id: 'customer-42' },
    }
    const done = await runtimeA.handle({
      method: 'POST', parts: ['instances', instanceId, 'tasks', 'h1', 'complete'], url, body: { payload },
    })
    eq(done.status, 200, JSON.stringify(done.body))
    eq(done.body.status, 'ACTIVE', '还有 h2 等待，实例没结束')
    await runtimeA.dispose()

    const runtimeB = createBpmnRuntime({ dir, env })
    const detail = await runtimeB.handle({ method: 'GET', parts: ['instances', instanceId], url })
    eq(detail.status, 200, JSON.stringify(detail.body))
    eq(detail.body.recovered, true, '业务变量名不能导致恢复被拒')
    eq(detail.body.pendingTasks[0].activityId, 'h2')
    eq(detail.body.variables.customer.id, 'customer-42')
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
  // 8b. 通过实例验证 dsh adapter：实例 status 仍 ACTIVE，lastError 保留真实原因
  // -------------------------------------------------------------------------
  await check('实例里的 dsh adapter：ACTIVE + lastError.code = BPMN_AGENT_ADAPTER_UNAVAILABLE', async home => {
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
    eq(created.json.status, 'ACTIVE', '出错不改 status：实例继续 ACTIVE')
    eq(calls.length, 0, '不得偷偷跑外部 executor')

    const detail = await call(route, 'GET', `${API}/instances/${created.json.id}`)
    eq(detail.status, 200)
    eq(detail.json.status, 'ACTIVE', '出错后 status 仍是 ACTIVE（不判死）')
    eq(detail.json.lastError.code, 'BPMN_AGENT_ADAPTER_UNAVAILABLE', 'lastError 必须保留 handler 的真实错误码')
    ok(detail.json.lastError.message.includes('0.13.1'), '文案说明 dsh adapter 在 0.13.1 提供')
    const events = await call(route, 'GET', `${API}/instances/${created.json.id}/events`)
    ok(events.json.events.some(event => event.type === 'error'), 'error 事件必须留痕')
    ok(!events.json.events.some(event => event.type === 'process/end'), '出错不发 process/end')
  })

  // -------------------------------------------------------------------------
  // 9. 大输出：事件单条上限 8KB，桥接层必须裁剪而不是让实例失败
  // -------------------------------------------------------------------------
  await check('大输出：activity/end 超过 8KB 时事件被裁剪并标 truncated，实例仍能完成', async home => {
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
    eq(instance.status, 'ACTIVE', '大输出不能把实例打挂')

    const events = await call(route, 'GET', `${API}/instances/${instance.id}/events`)
    const agentEnd = events.json.events.find(event => event.type === 'activity/end' && event.elementId === 'agent1')
    ok(agentEnd !== undefined, 'agent 的 activity/end 必须存在')
    eq(agentEnd.truncated, true, '超限事件必须显式标记 truncated')
    ok(Buffer.byteLength(JSON.stringify(agentEnd), 'utf8') <= 8192, '落盘事件不能超过 store 的 8KB 上限')

    const done = await call(route, 'POST', `${API}/instances/${instance.id}/tasks/human1/complete`, { payload: { approved: true } })
    eq(done.status, 200, JSON.stringify(done.json))
    eq(done.json.status, 'COMPLETED')
  })


  // -------------------------------------------------------------------------
  // 10. A1 · 恢复失败映射：409 + 实例仍 ACTIVE + lastError（handler 调用数不变）
  // -------------------------------------------------------------------------
  await check('恢复失败：裸快照 / 结构篡改 → 409 + ACTIVE + lastError，不派发 handler', async home => {
    const calls = []
    const dir = store.flowsDir(home)
    const env = {}
    const url = new URL('http://localhost/')
    const runtimeA = createBpmnRuntime({ dir, env, executorRunner: makeFakeExecutor(calls) })
    let res = await runtimeA.handle({ method: 'POST', parts: ['definitions'], url, body: { id: 'flow-demo', name: '演示流程', xml: workflowXml() } })
    eq(res.status, 201, JSON.stringify(res.body))
    res = await runtimeA.handle({ method: 'POST', parts: ['instances'], url, body: { definitionId: 'flow-demo', variables: { amount: 7 } } })
    eq(res.status, 201, JSON.stringify(res.body))
    const instanceId = res.body.id
    const callsAfterStart = calls.length
    ok(callsAfterStart >= 1, '首次启动确实跑过一次 executor')
    await runtimeA.dispose()

    const statePath = join(home, 'flow-studio', 'instances', instanceId, 'state.json')
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    const envelope = saved.state
    eq(envelope.v, 2, '落盘信封是 v2')
    for (const field of ['definitionId', 'definitionHash', 'version', 'processId', 'instanceId', 'kind']) {
      ok(envelope[field] !== undefined, `state 信封必须带 ${field}`)
    }

    const newRuntime = () => createBpmnRuntime({ dir, env, executorRunner: makeFakeExecutor(calls) })
    const writeState = (state) => writeFileSync(statePath, `${JSON.stringify({ savedAt: new Date().toISOString(), state }, null, 2)}\n`)

    // (a) 裸 bpmn-engine 快照（里面塞一个 parallelGateway）：版本不支持。
    const bare = JSON.parse(JSON.stringify(envelope.engine))
    const bareSource = JSON.parse(bare.definitions[0].source)
    bareSource.activities.push({
      id: 'pg',
      type: 'bpmn:ParallelGateway',
      parent: { id: bareSource.processes[0].id, type: 'bpmn:Process' },
      behaviour: { $type: 'bpmn:ParallelGateway', id: 'pg' },
    })
    bare.definitions[0].source = JSON.stringify(bareSource)
    writeState(bare)
    {
      const runtime = newRuntime()
      const detail = await runtime.handle({ method: 'GET', parts: ['instances', instanceId], url })
      eq(detail.status, 200)
      eq(detail.body.status, 'ACTIVE', '恢复失败不改 status')
      eq(detail.body.recovery.code, 'BPMN_STATE_VERSION_UNSUPPORTED', '裸快照必须报版本不支持')
      eq(detail.body.lastError.code, 'BPMN_STATE_VERSION_UNSUPPORTED', '恢复失败写 lastError')
      const complete = await runtime.handle({
        method: 'POST', parts: ['instances', instanceId, 'tasks', 'human1', 'complete'], url, body: { payload: {} },
      })
      eq(complete.status, 409, '恢复失败的写操作返回 409')
      eq(complete.body.recoveryCode, 'BPMN_STATE_VERSION_UNSUPPORTED')
      eq(calls.length, callsAfterStart, '恢复失败不得派发 handler')
      await runtime.dispose()
    }

    // (b) 合法 v2 身份 + 篡改条件：身份对得上，结构对不上。
    {
      const tampered = JSON.parse(JSON.stringify(envelope))
      const source = JSON.parse(tampered.engine.definitions[0].source)
      source.sequenceFlows.find(flow => flow.id === 'f2').behaviour.conditionExpression = {
        $type: 'bpmn:FormalExpression',
        language: 'feel',
        body: '= true',
      }
      tampered.engine.definitions[0].source = JSON.stringify(source)
      writeState(tampered)
      const runtime = newRuntime()
      const detail = await runtime.handle({ method: 'GET', parts: ['instances', instanceId], url })
      eq(detail.body.status, 'ACTIVE')
      eq(detail.body.recovery.code, 'BPMN_STATE_DEFINITION_MISMATCH', '篡改条件必须报定义不匹配')
      eq(detail.body.lastError.code, 'BPMN_STATE_DEFINITION_MISMATCH')
      const complete = await runtime.handle({
        method: 'POST', parts: ['instances', instanceId, 'tasks', 'human1', 'complete'], url, body: { payload: {} },
      })
      eq(complete.status, 409)
      eq(complete.body.recoveryCode, 'BPMN_STATE_DEFINITION_MISMATCH')
      eq(calls.length, callsAfterStart, '结构不匹配不得派发 handler')
      await runtime.dispose()
    }

    // 恢复合法状态仍然正常（不要为了封闭入口把正常恢复一起打死）。
    writeState(envelope)
    {
      const runtime = newRuntime()
      const detail = await runtime.handle({ method: 'GET', parts: ['instances', instanceId], url })
      eq(detail.body.recovered, true, '合法 state 必须能恢复')
      eq(detail.body.status, 'ACTIVE')
      await runtime.dispose()
    }
  })

  // -------------------------------------------------------------------------
  // 11. A1 · 正常 sequenceFlow 条件仍按变量走对分支
  // -------------------------------------------------------------------------
  await check('正常 sequenceFlow 条件：true / false 走不同分支（ACTIVE → COMPLETED）', async home => {
    const route = { handler: createHandler(makeEnv(home, { bpmnExecutor: makeFakeExecutor() })) }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="defs-cond" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-cond" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:userTask id="human1"/>
    <bpmn:exclusiveGateway id="gw" default="f_no"/>
    <bpmn:endEvent id="end_yes"/>
    <bpmn:endEvent id="end_no"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="human1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="human1" targetRef="gw"/>
    <bpmn:sequenceFlow id="f_yes" sourceRef="gw" targetRef="end_yes">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="feel">= approved = true</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_no" sourceRef="gw" targetRef="end_no"/>
  </bpmn:process>
</bpmn:definitions>`
    const saved = await call(route, 'POST', `${API}/definitions`, { id: 'flow-cond', name: '条件', xml })
    eq(saved.status, 201, JSON.stringify(saved.json))

    const instance = await call(route, 'POST', `${API}/instances`, { definitionId: 'flow-cond' })
    eq(instance.status, 201, JSON.stringify(instance.json))
    eq(instance.json.status, 'ACTIVE')
    const doneYes = await call(route, 'POST', `${API}/instances/${instance.json.id}/tasks/human1/complete`, { payload: { approved: true } })
    eq(doneYes.status, 200, JSON.stringify(doneYes.json))
    eq(doneYes.json.status, 'COMPLETED')
    const eventsYes = await call(route, 'GET', `${API}/instances/${instance.json.id}/events`)
    const flowsYes = eventTypes(eventsYes.json.events).length > 0
      ? eventsYes.json.events.filter(event => event.type === 'flow/taken').map(event => event.flowId)
      : []
    ok(flowsYes.includes('f_yes'), 'approved=true 必须走 f_yes')
    ok(!flowsYes.includes('f_no'), 'approved=true 不能走默认边')

    const instance2 = await call(route, 'POST', `${API}/instances`, { definitionId: 'flow-cond' })
    const doneNo = await call(route, 'POST', `${API}/instances/${instance2.json.id}/tasks/human1/complete`, { payload: { approved: false } })
    eq(doneNo.status, 200, JSON.stringify(doneNo.json))
    eq(doneNo.json.status, 'COMPLETED')
    const eventsNo = await call(route, 'GET', `${API}/instances/${instance2.json.id}/events`)
    const flowsNo = eventsNo.json.events.filter(event => event.type === 'flow/taken').map(event => event.flowId)
    ok(flowsNo.includes('f_no'), 'approved=false 必须走默认边 f_no')
    ok(!flowsNo.includes('f_yes'), 'approved=false 不能走 f_yes')
  })

  // -------------------------------------------------------------------------
  // 12. A2 · 慢 handler 在飞时并发 stop：stop 不被 complete 挡住，先 abort
  // -------------------------------------------------------------------------
  await check('慢 complete 在飞时 stop：立即 CANCELED、先 abort，晚到结果不回写', async home => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="defs-slow" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-slow" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="agent1">
      <bpmn:extensionElements><fs:node nodeType="agent" adapter="custom"><fs:executor kind="custom" command="echo a"/></fs:node></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:userTask id="human1"/>
    <bpmn:serviceTask id="agent2">
      <bpmn:extensionElements><fs:node nodeType="agent" adapter="custom"><fs:executor kind="custom" command="echo b"/></fs:node></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="agent1" targetRef="human1"/>
    <bpmn:sequenceFlow id="f3" sourceRef="human1" targetRef="agent2"/>
    <bpmn:sequenceFlow id="f4" sourceRef="agent2" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
    let releaseSlow = null
    let slowAborted = false
    let slowStarted = false
    const slowExecutor = async (options) => {
      if (String(options.prompt).includes('agent2')) {
        slowStarted = true
        options.signal?.addEventListener('abort', () => { slowAborted = true }, { once: true })
        await new Promise((resolve) => { releaseSlow = resolve })
        return { ok: true, text: 'late', structured: { late: true }, usage: {}, exitCode: 0, events: [] }
      }
      return { ok: true, text: 'fast', structured: {}, usage: {}, exitCode: 0, events: [] }
    }
    const route = { handler: createHandler(makeEnv(home, { bpmnExecutor: slowExecutor })) }
    const saved = await call(route, 'POST', `${API}/definitions`, { id: 'flow-slow', name: '慢节点', xml })
    eq(saved.status, 201, JSON.stringify(saved.json))
    const created = await call(route, 'POST', `${API}/instances`, { definitionId: 'flow-slow' })
    eq(created.status, 201, JSON.stringify(created.json))
    const id = created.json.id
    eq(created.json.status, 'ACTIVE')

    // complete 在飞：它会停在 agent2 的慢 executor 上并持有实例锁。
    const completePromise = call(route, 'POST', `${API}/instances/${id}/tasks/human1/complete`, { payload: { approved: true } })
    for (let index = 0; index < 200 && !slowStarted; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    ok(slowStarted, 'agent2 的慢 executor 必须已经在飞')

    // stop 不能排在慢 complete 的锁后面。
    const stopped = await Promise.race([
      call(route, 'POST', `${API}/instances/${id}/stop`),
      new Promise((resolve) => setTimeout(() => resolve({ status: 0, json: null, timedOut: true }), 3000)),
    ])
    eq(stopped.timedOut, undefined, 'stop 不能被慢 complete 挡住（3s 内返回）')
    eq(stopped.status, 200, JSON.stringify(stopped.json))
    eq(stopped.json.status, 'CANCELED')
    eq(slowAborted, true, 'stop 先发 abort 信号（在 handler 释放之前）')

    const lastSeqAtStop = stopped.json.lastSeq
    releaseSlow()
    const completed = await completePromise
    // 盘上已是 CANCELED：complete 必须明确 409，不能返回 200 + ACTIVE（假阳性成功）。
    eq(completed.status, 409, `并发的 complete 必须 409，实际 ${completed.status}`)
    eq(completed.json?.code, 'INSTANCE_TERMINAL_IMMUTABLE')
    await new Promise((resolve) => setTimeout(resolve, 100))

    const raw = readInstanceJson(home, id)
    eq(raw.status, 'CANCELED', '终态不可逆：晚到的 complete 不能把实例改回 ACTIVE')
    eq(raw.lastError, null, 'stop 不是错误：不应写 lastError')
    eq(raw.variables.late, undefined, '晚到 agent2 的输出（late）不得写回 variables')
    const events = await call(route, 'GET', `${API}/instances/${id}/events`)
    eq(events.json.lastSeq, lastSeqAtStop, 'stop 之后不得再追加事件')
  })

  // -------------------------------------------------------------------------
  // 12.3 启动/恢复竞态：异步准备期间 stop 已返回 CANCELED → 不得再派发
  // -------------------------------------------------------------------------
  await check('启动竞态：定义快照读取期间 stop → 不建 runner、零派发、实例 CANCELED', async home => {
    const calls = []
    const dir = store.flowsDir(home)
    const env = {}
    const runtime = createBpmnRuntime({ dir, env, executorRunner: makeFakeExecutor(calls) })
    const url = new URL('http://localhost/')
    try {
      const saved = await runtime.handle({
        method: 'POST',
        parts: ['definitions'],
        url,
        body: { id: 'flow-start-race', name: '启动竞态', xml: workflowXml('proc-start-race') },
      })
      eq(saved.status, 201, JSON.stringify(saved.body))

      // 暂停点：定义快照读取完成之后、runner 创建之前（review-0131 #1 的窗口）。
      let releaseRead
      const readGate = new Promise(resolveGate => { releaseRead = resolveGate })
      let markReadStarted
      const readStarted = new Promise(resolve => { markReadStarted = resolve })
      runtime._readDefinitionSnapshot = async id => {
        markReadStarted()
        await readGate
        return await instStore.readInstanceDefinition(id, { instancesRoot: runtime.instancesRoot })
      }

      const createPromise = runtime.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: { definitionId: 'flow-start-race', variables: { amount: 7 } },
      })
      await readStarted

      const listed = await instStore.listInstances({ instancesRoot: runtime.instancesRoot })
      eq(listed.length, 1)
      const id = listed[0].id
      const stopped = await runtime.handle({ method: 'POST', parts: ['instances', id, 'stop'], url })
      eq(stopped.status, 200, JSON.stringify(stopped.body))
      eq(stopped.body.status, 'CANCELED')
      eq(calls.length, 0, 'stop 返回时不得有派发')

      releaseRead()
      const created = await createPromise
      eq(created.status, 201, JSON.stringify(created.body))
      eq(created.body.status, 'CANCELED', '实例必须保持 CANCELED')
      eq(created.body.error?.code, 'BPMN_INSTANCE_STOPPING', '启动必须返回明确的 stopped 结果')
      eq(calls.length, 0, '放行后也不得派发 agent（外部副作用为零）')
      eq(runtime.activeCount, 0, '不得残留 runner')

      const events = await runtime.handle({ method: 'GET', parts: ['instances', id, 'events'], url })
      eq(countType(events.body.events, 'activity/start'), 0, '不得出现 activity/start 事件')
      const raw = readInstanceJson(home, id)
      eq(raw.status, 'CANCELED')
      eq(raw.lastError, null, 'stop 不是错误：不写 lastError')
    } finally {
      await runtime.dispose()
    }
  })

  await check('恢复竞态：定义快照读取期间 stop → 不建 runner、不重放 agent、实例 CANCELED', async home => {
    const dir = store.flowsDir(home)
    const url = new URL('http://localhost/')
    const callsA = []
    const runtimeA = createBpmnRuntime({ dir, env: {}, executorRunner: makeFakeExecutor(callsA) })
    let id
    try {
      let res = await runtimeA.handle({
        method: 'POST',
        parts: ['definitions'],
        url,
        body: { id: 'flow-recover-race', name: '恢复竞态', xml: workflowXml('proc-recover-race') },
      })
      eq(res.status, 201, JSON.stringify(res.body))
      res = await runtimeA.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: { definitionId: 'flow-recover-race', variables: { amount: 7 } },
      })
      eq(res.status, 201, JSON.stringify(res.body))
      id = res.body.id
      eq(callsA.length, 1, '首次启动执行一次 agent，然后停在人工任务')
      eq(res.body.status, 'ACTIVE')
    } finally {
      await runtimeA.dispose()
    }

    const instancesRoot = join(home, 'flow-studio', 'instances')
    const beforeEvents = (await instStore.readInstanceEvents(id, { instancesRoot })) ?? []
    const beforeLastSeq = readInstanceJson(home, id).lastSeq

    // 新 runtime（模拟进程重启）：GET 触发懒恢复，在定义快照读取处暂停。
    const callsB = []
    const runtimeB = createBpmnRuntime({ dir, env: {}, executorRunner: makeFakeExecutor(callsB) })
    try {
      let releaseRead
      const readGate = new Promise(resolveGate => { releaseRead = resolveGate })
      let markReadStarted
      const readStarted = new Promise(resolve => { markReadStarted = resolve })
      runtimeB._readDefinitionSnapshot = async instanceId => {
        markReadStarted()
        await readGate
        return await instStore.readInstanceDefinition(instanceId, { instancesRoot: runtimeB.instancesRoot })
      }

      const getPromise = runtimeB.handle({ method: 'GET', parts: ['instances', id], url })
      await readStarted
      const stopped = await runtimeB.handle({ method: 'POST', parts: ['instances', id, 'stop'], url })
      eq(stopped.status, 200, JSON.stringify(stopped.body))
      eq(stopped.body.status, 'CANCELED')
      releaseRead()

      const detail = await getPromise
      eq(detail.status, 200, JSON.stringify(detail.body))
      eq(detail.body.status, 'CANCELED')
      eq(detail.body.recovered, false, '恢复必须失败（stop 已接管）')
      eq(detail.body.recovery?.code, 'BPMN_INSTANCE_STOPPING', '恢复入口必须覆盖「尚未登记 runner」阶段')
      eq(callsB.length, 0, '恢复不得重放 agent')
      eq(runtimeB.activeCount, 0, '不得残留 runner')

      const raw = readInstanceJson(home, id)
      eq(raw.status, 'CANCELED')
      eq(raw.lastSeq, beforeLastSeq, 'stop 之后不得再追加事件')
      const afterEvents = (await instStore.readInstanceEvents(id, { instancesRoot })) ?? []
      eq(afterEvents.length, beforeEvents.length, '事件流不得新增')
    } finally {
      await runtimeB.dispose()
    }
  })

  // -------------------------------------------------------------------------
  // 12.4 F1 · 异构 execution/broker：GET 不卡、快速标记不可恢复、零派发
  // -------------------------------------------------------------------------
  await check('F1：source 相同但 execution/broker 异构 → GET <2s 拒绝，ACTIVE + lastError，无待办', async home => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="defs-f1" targetNamespace="http://x">
  <bpmn:process id="proc-f1" isExecutable="true">
    <bpmn:startEvent id="start"/><bpmn:userTask id="human1"/><bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="human1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="human1" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
    const foreignXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="defs-foreign" targetNamespace="http://x">
  <bpmn:process id="proc-foreign" isExecutable="true">
    <bpmn:startEvent id="fs"/><bpmn:userTask id="fh"/><bpmn:endEvent id="fe"/>
    <bpmn:sequenceFlow id="ff1" sourceRef="fs" targetRef="fh"/>
    <bpmn:sequenceFlow id="ff2" sourceRef="fh" targetRef="fe"/>
  </bpmn:process>
</bpmn:definitions>`
    const dir = store.flowsDir(home)
    const url = new URL('http://localhost/')
    const runtimeA = createBpmnRuntime({ dir, env: {}, executorRunner: makeFakeExecutor() })
    let res = await runtimeA.handle({ method: 'POST', parts: ['definitions'], url, body: { id: 'flow-f1', name: 'F1', xml } })
    eq(res.status, 201, JSON.stringify(res.body))
    res = await runtimeA.handle({ method: 'POST', parts: ['instances'], url, body: { definitionId: 'flow-f1' } })
    eq(res.status, 201, JSON.stringify(res.body))
    const id = res.body.id
    const statePath = join(home, 'flow-studio', 'instances', id, 'state.json')
    const wrapper = JSON.parse(readFileSync(statePath, 'utf8'))
    await runtimeA.dispose()

    // 另一份引擎的执行状态（id 全不同），只替换 execution/broker，source 保持可信。
    const foreignRunner = createBpmnRunner({
      definition: {
        id: 'proc-foreign', startId: 'fs', endIds: ['fe'],
        elements: [
          { id: 'fs', type: 'bpmn:StartEvent', kind: 'start' },
          { id: 'fh', type: 'bpmn:UserTask', kind: 'human' },
          { id: 'fe', type: 'bpmn:EndEvent', kind: 'end' },
        ],
        flows: [{ id: 'ff1', from: 'fs', to: 'fh' }, { id: 'ff2', from: 'fh', to: 'fe' }],
      },
      xml: foreignXml,
      definitionIdentity: { id: 'defs-foreign', version: 1, hash: createHash('sha256').update(foreignXml, 'utf8').digest('hex') },
      services: { executeAgent: async () => ({}), onEvent() {} },
    })
    await foreignRunner.start()
    const foreign = await foreignRunner.getState()
    await foreignRunner.stop()
    wrapper.state.engine.definitions[0].execution = foreign.engine.definitions[0].execution
    wrapper.state.engine.definitions[0].broker = foreign.engine.definitions[0].broker
    await instStore.writeInstanceState(id, wrapper.state, { home })

    const runtimeB = createBpmnRuntime({ dir, env: {}, executorRunner: makeFakeExecutor() })
    const startedAt = Date.now()
    const detail = await Promise.race([
      runtimeB.handle({ method: 'GET', parts: ['instances', id], url }),
      new Promise(resolve => setTimeout(() => resolve({ status: 'TIMEOUT' }), 2000)),
    ])
    const elapsed = Date.now() - startedAt
    ok(elapsed < 2000, `GET 不能卡住（实测 ${elapsed}ms）`)
    eq(detail.status, 200, JSON.stringify(detail.body))
    eq(detail.body.status, 'ACTIVE', '异构 state 不改实例状态')
    eq(detail.body.recovered, false)
    eq(detail.body.runnerStatus, null)
    deep(detail.body.pendingTasks, [], '不得恢复旧执行位置')
    eq(detail.body.recovery.code, 'BPMN_STATE_INVALID', '恢复路径给出明确错误码')
    eq(detail.body.lastError.code, 'BPMN_STATE_INVALID', 'lastError 记下事实')
    const complete = await runtimeB.handle({
      method: 'POST', parts: ['instances', id, 'tasks', 'human1', 'complete'], url, body: { payload: {} },
    })
    eq(complete.status, 409, '异构 state 不可恢复，不能 complete')
    eq(complete.body.code, 'BPMN_INSTANCE_NOT_RECOVERABLE')
    await runtimeB.dispose()
  })

  // -------------------------------------------------------------------------
  // 12.5 MAJOR-2 · 失败停机后快照不可恢复：重启 GET 不复活执行位置
  // -------------------------------------------------------------------------
  await check('失败停机：重启后 GET 无 pendingTasks/无执行位置，complete 明确 409', async home => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="defs-fail" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-fail" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="agent1"><bpmn:extensionElements><fs:node nodeType="agent" adapter="custom"><fs:executor kind="custom" command="echo a"/></fs:node></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:userTask id="human1"/>
    <bpmn:serviceTask id="agent2"><bpmn:extensionElements><fs:node nodeType="agent" adapter="custom"><fs:executor kind="custom" command="echo b"/></fs:node></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="agent1" targetRef="human1"/>
    <bpmn:sequenceFlow id="f3" sourceRef="human1" targetRef="agent2"/>
    <bpmn:sequenceFlow id="f4" sourceRef="agent2" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
    const env = {}
    const dir = store.flowsDir(home)
    const url = new URL('http://localhost/')
    let calls = 0
    const executor = async () => {
      calls += 1
      if (calls === 1) {
        return { ok: true, text: 'a', structured: {}, usage: {}, exitCode: 0, events: [] }
      }
      return { ok: false, error: 'boom', exitCode: 1, events: [] }
    }
    const runtimeA = createBpmnRuntime({ dir, env, executorRunner: executor })
    let res = await runtimeA.handle({ method: 'POST', parts: ['definitions'], url, body: { id: 'flow-fail', name: '失败停机', xml } })
    eq(res.status, 201, JSON.stringify(res.body))
    res = await runtimeA.handle({ method: 'POST', parts: ['instances'], url, body: { definitionId: 'flow-fail' } })
    eq(res.status, 201, JSON.stringify(res.body))
    const id = res.body.id
    eq(res.body.pendingTasks.length, 1, 'agent1 成功后停在 human1')

    const completed = await runtimeA.handle({
      method: 'POST', parts: ['instances', id, 'tasks', 'human1', 'complete'], url, body: { payload: { approved: true } },
    })
    eq(completed.status, 503, 'agent2 失败必须显式报错')
    const raw = readInstanceJson(home, id)
    eq(raw.status, 'ACTIVE', '失败不改实例状态（仍是 ACTIVE）')
    ok(typeof raw.lastError?.code === 'string' && raw.lastError.code !== '', '失败写 lastError')
    deep(raw.pendingTasks, [], '失败后待办清空')

    // 持久化快照必须被标记为不可恢复（不是留着旧的 waiting 快照）。
    const stateRaw = JSON.parse(readFileSync(join(home, 'flow-studio', 'instances', id, 'state.json'), 'utf8'))
    ok(stateRaw.state.unrecoverable, '失败停机后 state.json 必须有不可恢复标记')
    eq(stateRaw.state.unrecoverable.code, raw.lastError.code, '标记里保留失败 code')
    eq(typeof stateRaw.state.unrecoverable.at, 'string', '标记里带时间')
    eq(stateRaw.state.pendingTasks, undefined, '墓碑快照不再带执行位置')

    await runtimeA.dispose()
    const runtimeB = createBpmnRuntime({ dir, env, executorRunner: makeFakeExecutor() })
    const detail = await runtimeB.handle({ method: 'GET', parts: ['instances', id], url })
    eq(detail.status, 200, JSON.stringify(detail.body))
    eq(detail.body.status, 'ACTIVE', 'GET 仍返回 ACTIVE')
    eq(detail.body.lastError.code, raw.lastError.code, 'GET 仍返回 lastError')
    eq(detail.body.recovered, false, '不得再从旧快照自动恢复')
    eq(detail.body.runnerStatus, null)
    deep(detail.body.pendingTasks, [], '无执行位置、无待办')
    eq(detail.body.recovery.code, raw.lastError.code, '恢复路径给出明确错误码')

    const replay = await runtimeB.handle({
      method: 'POST', parts: ['instances', id, 'tasks', 'human1', 'complete'], url, body: { payload: { approved: true } },
    })
    eq(replay.status, 409, '不可恢复实例不能再 complete（不能重放失败前的工作）')
    eq(replay.body.code, 'BPMN_INSTANCE_NOT_RECOVERABLE')
    await runtimeB.dispose()
  })

  // -------------------------------------------------------------------------
  // 13. 防回潮：新域代码不把 failed / blocked 当实例状态字面量
  // -------------------------------------------------------------------------
  await check('防回潮：instance-store / bpmn-runtime 不出现 failed/blocked 实例状态字面量', async () => {
    const inst = await import('../src/instance-store.js')
    deep(inst.INSTANCE_STATUSES, ['ACTIVE', 'COMPLETED', 'SUSPENDED', 'CANCELED'], '实例状态集合对齐 Camunda 8')
    for (const file of ['instance-store.js', 'bpmn-runtime.js']) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      ok(!source.includes("'failed'"), `${file} 不得再把 'failed' 当实例状态字面量`)
      ok(!source.includes("'blocked'"), `${file} 不得再把 'blocked' 当实例状态字面量`)
    }
  })

  console.log('bpmn-runtime.test.mjs')
  console.log(`BPMN ${BPMN_ENGINE_VERSION} · ${checks} 组通过（${assertions} 条断言）`)
} catch (error) {
  console.error('✗ BPMN 运行时自检失败')
  console.error(error)
  process.exit(1)
}
