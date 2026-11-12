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
 * 假 AgentAdapter（走 flow_finish_node 完结门）；无注册表 / custom 只验证「明确失败」。
 *
 * 产物落在项目 `.tmp/` 下（每个用例一个新 home，结束清理），不占系统 /tmp。
 * 运行：node test/bpmn-runtime.test.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const {
  createBpmnRuntime, executeAgent, executeHttp, BPMN_ENGINE_VERSION,
} = await import('../src/bpmn-runtime.js')
const { createHandler } = await import('../src/index.js')
const { createInstanceTools } = await import('../src/instance-tools.js')
const instStore = await import('../src/instance-store.js')
const { createBpmnRunner } = await import('../src/bpmn-runner.js')
const { createConnectorStore } = await import('../src/connector-store.js')
const { resolveWorkspace, defaultGitRunner } = await import('../src/workspace-policy.js')

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

const sleep = ms => new Promise(resolveSleep => { setTimeout(resolveSleep, ms) })

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(10)
  }
  return false
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

/**
 * 桩 agent adapter：不真跑 codex / custom，只证明 handler 走的是
 * AgentAdapter + flow_finish_node 完结门（BPMN 域已不接受外部 CLI 直出）。
 *
 * `behavior({ element, ctx, finishGate })` 可选：返回自定义 handle（慢节点 / 失败 /
 * 大输出），返回 null 时走默认「提交一个成功完结记录」。
 */
function makeFakeAdapter(behavior = null) {
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
      if (typeof behavior === 'function') {
        const custom = await behavior(request)
        if (custom !== null && custom !== undefined) return custom
      }
      const submitted = await request.finishGate.submit({
        variables: { ok: true },
        documents: [],
        summary: 'agent-stub-result',
      })
      return {
        exited: Promise.resolve({
          ok: true,
          record: submitted.record,
          usage: { input: 3, cacheRead: 0, cacheWrite: 0, output: 2, total: 5 },
        }),
      }
    },
    async cancel() {},
    async dispose() {},
  }
  return adapter
}

/** 桩注册表：id 固定 dsh（fixture 里的 agent 节点都用 adapter="dsh"）。 */
function makeFakeAdapters(adapter = makeFakeAdapter()) {
  return {
    get(id) {
      return id === adapter.id ? adapter : undefined
    },
    list() {
      return [adapter]
    },
  }
}

/**
 * 慢 agent 适配器 + 收件箱能力（0.13.10 路由用例）：
 * `finishGate` 由测试显式提交，用来在 agent 还在跑时投递消息。
 */
function makeSlowMessageAdapter() {
  const calls = []
  const delivered = []
  let finishGate = null
  let resolveExited = null
  const adapter = {
    id: 'dsh',
    calls,
    delivered,
    async probe() {
      return { version: 'stub', helpDigest: 'stub' }
    },
    capabilities() {
      return { finishTool: 'native', hooks: { 'turn.stop': 'emulated' }, messages: 'native' }
    },
    async start(request) {
      calls.push(request)
      finishGate = request.finishGate
      return {
        exited: new Promise(resolve => { resolveExited = resolve }),
      }
    },
    async deliverMessage(handle, message) {
      delivered.push({ handle, message })
      return { ok: true, deliveryUnknown: true }
    },
    async cancel() {},
    async dispose() {},
  }
  adapter.finish = async () => {
    const submitted = await finishGate.submit({
      variables: { ok: true },
      documents: [],
      summary: 'slow-agent-done',
    })
    resolveExited({ ok: true, record: submitted.record })
  }
  return adapter
}

function makeEnv(home, opts = {}) {
  return {
    dir: join(home, 'flow-studio'),
    ctx: makeCtx(),
    engine: { engineName: 'stub' },
    startOptions: new Map(),
    // fixture 的 agent 节点用 adapter="dsh"；默认给一个假的 dsh 适配器注册表。
    // 需要验证「没有注册表」的用例显式传 bpmnAdapters: null。
    bpmnAdapters: makeFakeAdapters(),
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
        <fs:node nodeType="agent" adapter="dsh">
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

/** 在 home 下建一个真实临时 Git 仓库（测试项目产物仍在 .tmp/）。 */
function gitCmd(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeGitRepo(home, name = 'repo') {
  const repo = join(home, name)
  mkdirSync(repo, { recursive: true })
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  git(['add', '.'])
  git(['commit', '-m', 'init'])
  return repo
}

/** agent → end 的流程（不经过人工任务，创建后直接 COMPLETED）。 */
function agentOnlyXml(processId = 'proc-agent-only', executorCwd = null) {
  const executor = executorCwd === null
    ? ''
    : `<fs:executor kind="dsh" cwd="${executorCwd}"/>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="defs-${processId}" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="${processId}" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="agent1" name="写产物">
      <bpmn:extensionElements>
        <fs:node nodeType="agent" adapter="dsh">${executor}</fs:node>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="agent1" targetRef="end"/>
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
        <fs:node nodeType="agent" adapter="dsh">
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

/**
 * 起一个真正的独立 Node 进程 BPMN runtime 对端（`test/fixtures/instance-runtime-peer.mjs`）。
 *
 * 行协议：子进程 stdout 一行 JSON 一条消息；`ready` 事件带 instanceId / executionId，
 * 其余是命令响应 `{id, status, body}`。父进程用 `send(cmd, args)` 调它。
 */
function startPeer(dataDir, mode = 'wait') {
  const child = spawn(process.execPath, [join(repoRoot, 'test', 'fixtures', 'instance-runtime-peer.mjs'), dataDir, mode], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const pending = new Map()
  let nextId = 1
  let exited = false
  let markReady
  let failReady
  const ready = new Promise((resolveReady, rejectReady) => {
    markReady = resolveReady
    failReady = rejectReady
  })
  const reader = createInterface({ input: child.stdout })
  reader.on('line', line => {
    const trimmed = line.trim()
    if (trimmed === '') return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      return
    }
    if (message.event === 'ready') {
      markReady(message)
      return
    }
    const waiter = pending.get(String(message.id))
    if (waiter !== undefined) {
      pending.delete(String(message.id))
      waiter.resolve(message)
    }
  })
  const exitPromise = new Promise(resolveExit => {
    child.once('exit', (code, signal) => {
      exited = true
      failReady(new Error(`peer 提前退出（code=${code} signal=${signal}）：${stderr}`))
      for (const waiter of pending.values()) {
        waiter.resolve({ status: 503, body: { ok: false, code: 'PEER_EXITED', error: stderr } })
      }
      pending.clear()
      resolveExit({ code, signal })
    })
  })
  const send = (cmd, args = {}, timeoutMs = 8000) => {
    if (exited) return Promise.reject(new Error('peer 已退出'))
    const id = String(nextId)
    nextId += 1
    return new Promise((resolveSend, rejectSend) => {
      pending.set(id, { resolve: resolveSend })
      child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`)
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          rejectSend(new Error(`peer 命令 ${cmd} 超时`))
        }
      }, timeoutMs)
      timer.unref()
    })
  }
  const stop = async ({ kill = false } = {}) => {
    if (!exited && !kill) {
      try {
        await send('exit', {}, 3000)
      } catch {
        // 退出命令失败就退回 SIGKILL。
      }
    }
    if (!exited) {
      child.kill('SIGKILL')
      await Promise.race([exitPromise, sleep(3000)])
    }
    reader.close()
    return await exitPromise
  }
  return { child, ready, send, stop }
}

/** pid 是否仍存在（测试侧判「子进程真的没了」）。 */
function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
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
    eq(flows.status, 404, '旧 /flows 已随 0.14.0 退役（认证后 404）')
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
  // 3. 实例定义快照：冻结 XML / 定义域新增版本或缺失都不影响 / 404 / 405
  // -------------------------------------------------------------------------
  await check('实例定义快照：定义新增版本、定义域被删后仍返回冻结 XML', async home => {
    const route = { handler: createHandler(makeEnv(home)) }
    const v1 = await seed(route)
    const instance = await startInstance(route)

    const first = await call(route, 'GET', `${API}/instances/${instance.id}/definition`)
    eq(first.status, 200, JSON.stringify(first.json))
    eq(first.json.ok, true)
    eq(first.json.id, instance.id)
    eq(first.json.definitionId, 'flow-demo')
    eq(first.json.definitionVersion, 1)
    eq(first.json.definitionHash, v1.hash)
    eq(first.json.xml, workflowXml(), '返回的必须是实例自己的冻结快照')

    // 定义域新增 v2：实例快照不能跟着变。
    const v2Xml = workflowXml().replace('name="演示流程"', 'name="演示流程 v2"')
    const v2 = await call(route, 'POST', `${API}/definitions`, {
      id: 'flow-demo',
      name: '演示流程 v2',
      xml: v2Xml,
    })
    eq(v2.status, 201, JSON.stringify(v2.json))
    eq(v2.json.version, 2)
    ok(v2.json.hash !== v1.hash, 'v2 的 hash 必须与 v1 不同')
    const latest = await call(route, 'GET', `${API}/definitions/flow-demo`)
    eq(latest.json.version, 2)
    eq(latest.json.xml, v2Xml, '定义域确实已经有 v2')

    const frozen = await call(route, 'GET', `${API}/instances/${instance.id}/definition`)
    eq(frozen.status, 200, JSON.stringify(frozen.json))
    eq(frozen.json.definitionVersion, 1, '实例仍钉住 v1')
    eq(frozen.json.definitionHash, v1.hash)
    eq(frozen.json.xml, workflowXml(), '新增版本后实例画布仍拿到 v1 冻结 XML')

    // 定义域整个删掉也不能影响实例画布。
    rmSync(join(home, 'flow-studio', 'definitions'), { recursive: true, force: true })
    const afterDelete = await call(route, 'GET', `${API}/instances/${instance.id}/definition`)
    eq(afterDelete.status, 200, JSON.stringify(afterDelete.json))
    eq(afterDelete.json.xml, workflowXml(), '定义域缺失时仍从实例快照读')
    eq(afterDelete.json.definitionVersion, 1)

    const missing = await call(route, 'GET', `${API}/instances/i-not-exist/definition`)
    eq(missing.status, 404)
    eq(missing.json.code, 'INSTANCE_NOT_FOUND')

    const badId = await call(route, 'GET', `${API}/instances/${encodeURIComponent('bad id')}/definition`)
    eq(badId.status, 400)
    eq(badId.json.code, 'BPMN_INSTANCE_ID_INVALID')

    const wrongMethod = await call(route, 'POST', `${API}/instances/${instance.id}/definition`, {})
    eq(wrongMethod.status, 405)
    eq(wrongMethod.json.code, 'BPMN_METHOD_NOT_ALLOWED')

    // 快照被篡改：不能拿实例元数据冒充成功（沿用 store 的既有 500 码）。
    writeFileSync(join(home, 'flow-studio', 'instances', instance.id, 'definition.bpmn'), 'tampered', 'utf8')
    const corrupt = await call(route, 'GET', `${API}/instances/${instance.id}/definition`)
    eq(corrupt.status, 500)
    eq(corrupt.json.code, 'INSTANCE_SNAPSHOT_CORRUPT')
  })

  // -------------------------------------------------------------------------
  // 4. 建实例 → serviceTask → userTask waiting + pendingTasks + 事件
  // -------------------------------------------------------------------------
  await check('实例：跑到 userTask 变 waiting，instance.json 有 pendingTasks，事件流三类齐全', async home => {
    const agents = makeFakeAdapter()
    const route = { handler: createHandler(makeEnv(home, { bpmnAdapters: makeFakeAdapters(agents) })) }
    await seed(route)

    const instance = await startInstance(route)
    eq(instance.status, 'ACTIVE')
    eq(instance.pendingTasks.length, 1, '必须停在人工任务上')
    eq(instance.pendingTasks[0].activityId, 'human1')
    ok(instance.lastSeq > 0, '事件必须已经落盘')
    eq(agents.calls.length, 1, 'serviceTask 必须派发一次 agent adapter')

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
    const route = { handler: createHandler(makeEnv(home)) }
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
    const route = { handler: createHandler(makeEnv(home)) }
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
    const route = { handler: createHandler(makeEnv(home)) }
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
  // 6.1 E4（0.14.3）：quiesce 式挂起 / 恢复
  // -------------------------------------------------------------------------

  /** 建 definition + 跑到 human1 等待点的实例；返回 {runtime, instanceId, task}。 */
  async function setupWaitingInstance(home, env = {}, adapters = makeFakeAdapters()) {
    const runtime = createBpmnRuntime({ dir: join(home, 'flow-studio'), env, adapters })
    const url = new URL('http://localhost/')
    let res = await runtime.handle({
      method: 'POST',
      parts: ['definitions'],
      url,
      body: { id: 'flow-demo', name: '演示流程', xml: workflowXml('proc-suspend') },
    })
    eq(res.status, 201, JSON.stringify(res.body))
    res = await runtime.handle({
      method: 'POST', parts: ['instances'], url, body: { definitionId: 'flow-demo', variables: { amount: 7 } },
    })
    eq(res.status, 201, JSON.stringify(res.body))
    return { runtime, url, instanceId: res.body.id, instance: res.body, task: res.body.pendingTasks[0] }
  }

  async function readEvents(runtime, url, instanceId) {
    const res = await runtime.handle({ method: 'GET', parts: ['instances', instanceId, 'events'], url })
    eq(res.status, 200, JSON.stringify(res.body))
    return res.body
  }

  await check('E4 挂起：wait 点 → SUSPENDED + 事件；complete 409；消息排队；读不推进', async home => {
    const { runtime, url, instanceId, task } = await setupWaitingInstance(home)
    const seqBefore = (await readEvents(runtime, url, instanceId)).lastSeq

    // reason 契约：非字符串 / 超 200 字符在路由层 400，且零事件。
    let res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: 7 },
    })
    eq(res.status, 400, JSON.stringify(res.body))
    eq(res.body.code, 'BPMN_REASON_INVALID')
    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: '长'.repeat(201) },
    })
    eq(res.status, 400, JSON.stringify(res.body))
    eq(res.body.code, 'BPMN_REASON_INVALID')
    eq((await readEvents(runtime, url, instanceId)).lastSeq, seqBefore, 'reason 非法不能写事件')

    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: '窗口维护' },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.status, 'SUSPENDED')
    eq(res.body.reason, '窗口维护')
    ok(res.body.lastSeq > seqBefore, '挂起必须写一条事件')

    const raw = readInstanceJson(home, instanceId)
    eq(raw.status, 'SUSPENDED', 'instance.json 必须落成 SUSPENDED')
    eq(raw.pendingTasks.length, 1, '挂起不清人工待办（恢复后还能完成）')
    eq(raw.completedAt, null, '挂起不是终态')

    let events = await readEvents(runtime, url, instanceId)
    const suspended = events.events.filter(event => event.type === 'instance/suspended')
    eq(suspended.length, 1, '挂起事件只能有一条')
    eq(suspended[0].reason, '窗口维护', 'reason 必须回显进事件')
    const seqAtSuspend = events.lastSeq

    // 挂起期间完成人工任务：409 INSTANCE_SUSPENDED，且零事件。
    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'tasks', 'human1', 'complete'],
      url,
      body: { payload: { approved: true } },
    })
    eq(res.status, 409, JSON.stringify(res.body))
    eq(res.body.code, 'INSTANCE_SUSPENDED')
    events = await readEvents(runtime, url, instanceId)
    eq(events.lastSeq, seqAtSuspend, '拒绝完成不能产生事件')
    eq(readInstanceJson(home, instanceId).status, 'SUSPENDED', '拒绝完成后仍是 SUSPENDED')

    // 入站消息沿用 D 的 SUSPENDED 语义：受理并排队，不投递。
    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'messages'],
      url,
      body: {
        messageId: 'm-suspended',
        target: { activityId: 'human1', executionId: task.executionId },
        text: '挂起期间的讨论',
      },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.message.status, 'queued', '挂起期间消息只能排队')
    eq(res.body.delivery.deferred, true, '投递必须明确标 deferred')
    eq(res.body.delivery.reason, 'instance-suspended')

    // 读不推进：换一个没有内存 runner 的 runtime，GET / GET tasks 都不得懒恢复。
    await runtime.dispose()
    const runtimeB = createBpmnRuntime({ dir: join(home, 'flow-studio'), env: {}, adapters: makeFakeAdapters() })
    const detail = await runtimeB.handle({ method: 'GET', parts: ['instances', instanceId], url })
    eq(detail.status, 200, JSON.stringify(detail.body))
    eq(detail.body.status, 'SUSPENDED')
    eq(detail.body.runnerStatus, null, '挂起实例不得因读而创建 runner')
    eq(detail.body.recovery.code, 'BPMN_STATE_SUSPENDED')
    eq(detail.body.pendingTasks.length, 1, '待办仍可读')
    eq(runtimeB._runners.size, 0, 'GET 不得把 SUSPENDED 实例加进 _runners')
    const tasks = await runtimeB.handle({ method: 'GET', parts: ['instances', instanceId, 'tasks'], url })
    eq(tasks.status, 200)
    eq(tasks.body.status, 'SUSPENDED')
    eq(runtimeB._runners.size, 0, 'GET /tasks 也不得懒恢复')
    const eventsAfterRead = await readEvents(runtimeB, url, instanceId)
    eq(eventsAfterRead.lastSeq, seqAtSuspend, '读不能推进事件流')
    eq(countType(eventsAfterRead.events, 'activity/wait'), 1, '读不能重放 wait')
    await runtimeB.dispose()
  })

  await check('E4 恢复：ACTIVE + 事件，恢复不主动跑；之后 complete 推进到 COMPLETED', async home => {
    const { runtime, url, instanceId, task } = await setupWaitingInstance(home)
    let res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: '部署切换' },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    const seqAtSuspend = (await readEvents(runtime, url, instanceId)).lastSeq

    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: { reason: '切换完成' },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.status, 'ACTIVE')
    eq(res.body.reason, '切换完成')
    eq(res.body.lastSeq, seqAtSuspend + 1, '恢复只写一条 instance/resumed 事件')
    eq(readInstanceJson(home, instanceId).status, 'ACTIVE')

    let events = await readEvents(runtime, url, instanceId)
    const resumed = events.events.filter(event => event.type === 'instance/resumed')
    eq(resumed.length, 1)
    eq(resumed[0].reason, '切换完成')
    eq(events.lastSeq, seqAtSuspend + 1, '恢复不主动推进（不多写 activity/end / process/end）')
    eq(countType(events.events, 'process/end'), 0)

    // 恢复后人工任务可完成，且不会重放已完成的节点。
    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'tasks', 'human1', 'complete'],
      url,
      body: { payload: { approved: true }, decidedBy: 'e4-resume' },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.status, 'COMPLETED')
    events = await readEvents(runtime, url, instanceId)
    eq(countType(events.events, 'activity/wait'), 1, '恢复后 complete 不能重放 wait')
    eq(countType(events.events, 'process/end'), 1)
    eq(countType(events.events, 'instance/suspended'), 1)
    eq(countType(events.events, 'instance/resumed'), 1)
    eq(readInstanceJson(home, instanceId).variables.approved, true)
  })

  await check('E4 在飞 agent：挂起 409 INSTANCE_SUSPEND_BUSY，状态与事件不变', async home => {
    const slow = makeSlowMessageAdapter()
    const runtime = createBpmnRuntime({
      dir: join(home, 'flow-studio'), env: {}, adapters: makeFakeAdapters(slow),
    })
    const url = new URL('http://localhost/')
    let res = await runtime.handle({
      method: 'POST',
      parts: ['definitions'],
      url,
      body: { id: 'flow-demo', name: '演示流程', xml: workflowXml('proc-busy') },
    })
    eq(res.status, 201, JSON.stringify(res.body))
    // 创建请求会卡在慢 agent 里，所以不 await；从列表拿 instance id。
    const creating = runtime.handle({
      method: 'POST', parts: ['instances'], url, body: { definitionId: 'flow-demo' },
    })
    eq(await waitUntil(() => slow.calls.length > 0, 3000), true, 'agent 已开始执行')
    const listed = await runtime.handle({ method: 'GET', parts: ['instances'], url })
    const instanceId = listed.body.instances[0].id
    eq(await waitUntil(() => runtime._executionBusy(instanceId), 3000), true, '_executionBusy 已置位')
    const seqBefore = (await readEvents(runtime, url, instanceId)).lastSeq

    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: '抢挂' },
    })
    eq(res.status, 409, JSON.stringify(res.body))
    eq(res.body.code, 'INSTANCE_SUSPEND_BUSY')
    ok(typeof res.body.error === 'string' && res.body.error.includes('agent'), '409 必须可读地说出在飞活动')
    ok(Array.isArray(res.body.activities) && res.body.activities.length > 0, 'activities[] 列出未结束活动')
    eq(res.body.activities[0].kind, 'agent')
    eq(readInstanceJson(home, instanceId).status, 'ACTIVE', '忙时挂起不能改状态')
    const busyEvents = await readEvents(runtime, url, instanceId)
    eq(countType(busyEvents.events, 'instance/suspended'), 0, '忙时挂起不能写挂起事件')
    eq(countType(busyEvents.events, 'instance/resumed'), 0, '忙时挂起不能写恢复事件')
    ok(busyEvents.lastSeq >= seqBefore, '在飞活动自己的事件可以继续落盘（挂起没有额外写事件）')

    await slow.finish()
    const created = await creating
    eq(created.status, 201, JSON.stringify(created.body))
    eq(created.body.status, 'ACTIVE', 'agent 结束后停在人工任务')
    eq(runtime._executionBusy(instanceId), false)
  })

  await check('E4 未结算 HTTP：挂起 409 INSTANCE_SUSPEND_BUSY 并点名调用记录', async home => {
    const { runtime, url, instanceId } = await setupWaitingInstance(home)
    const store = createConnectorStore({
      root: join(home, 'flow-studio', 'instances', instanceId, 'connector'),
    })
    const key = { instanceId, elementId: 'call1', executionId: 'call1_attempt_1' }
    await store.beginInvocation({ ...key, invocationId: 'inv-call1', requestHash: 'a'.repeat(64) })
    const seqBefore = (await readEvents(runtime, url, instanceId)).lastSeq

    let res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: '抢挂' },
    })
    eq(res.status, 409, JSON.stringify(res.body))
    eq(res.body.code, 'INSTANCE_SUSPEND_BUSY')
    const httpActivity = res.body.activities.find(item => item.kind === 'http')
    ok(httpActivity, 'activities[] 必须点名未结算的 HTTP 调用')
    eq(httpActivity.activityId, 'call1')
    eq(httpActivity.executionId, 'call1_attempt_1')
    eq(httpActivity.state, 'started')
    eq(readInstanceJson(home, instanceId).status, 'ACTIVE')
    eq((await readEvents(runtime, url, instanceId)).lastSeq, seqBefore, '忙时挂起不能产生事件')

    // 结算（succeeded）后不再算在飞，可以挂起。
    await store.commitResult(key, { state: 'succeeded', result: { status: 200, headers: {}, output: {} } })
    res = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: {} })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.status, 'SUSPENDED')
  })

  await check('E4 终态 / 未挂起 / 重复挂起：各自 409 且零事件', async home => {
    const { runtime, url, instanceId } = await setupWaitingInstance(home)

    // 未挂起就恢复。
    let seq = (await readEvents(runtime, url, instanceId)).lastSeq
    let res = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: {} })
    eq(res.status, 409, JSON.stringify(res.body))
    eq(res.body.code, 'INSTANCE_NOT_SUSPENDED')
    eq((await readEvents(runtime, url, instanceId)).lastSeq, seq, '未挂起恢复不产生事件')

    // 重复挂起。
    res = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: {} })
    eq(res.status, 200, JSON.stringify(res.body))
    seq = (await readEvents(runtime, url, instanceId)).lastSeq
    res = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: {} })
    eq(res.status, 409, JSON.stringify(res.body))
    eq(res.body.code, 'INSTANCE_ALREADY_SUSPENDED')
    eq((await readEvents(runtime, url, instanceId)).lastSeq, seq, '重复挂起不产生事件')

    // 恢复并完成 → 终态；终态上挂起 / 恢复都 409 且零事件。
    res = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: {} })
    eq(res.status, 200)
    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'tasks', 'human1', 'complete'], url, body: { payload: {} },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.status, 'COMPLETED')
    seq = (await readEvents(runtime, url, instanceId)).lastSeq
    for (const action of ['suspend', 'resume']) {
      res = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, action], url, body: {} })
      eq(res.status, 409, `${action} 在终态上必须 409`)
      eq(res.body.code, 'BPMN_INSTANCE_TERMINAL')
    }
    eq((await readEvents(runtime, url, instanceId)).lastSeq, seq, '终态上的拒绝不产生事件')
  })

  await check('E4 重启后仍是 SUSPENDED：不自动恢复、不推进；恢复后可继续', async home => {
    const { runtime, url, instanceId } = await setupWaitingInstance(home)
    let res = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: {} })
    eq(res.status, 200, JSON.stringify(res.body))
    const seqAtSuspend = (await readEvents(runtime, url, instanceId)).lastSeq
    await runtime.dispose()

    // 新 runtime：SUSPENDED 不是终态，但绝不能自动恢复。
    const runtimeB = createBpmnRuntime({ dir: join(home, 'flow-studio'), env: {}, adapters: makeFakeAdapters() })
    const detail = await runtimeB.handle({ method: 'GET', parts: ['instances', instanceId], url })
    eq(detail.status, 200, JSON.stringify(detail.body))
    eq(detail.body.status, 'SUSPENDED')
    eq(detail.body.recovery.code, 'BPMN_STATE_SUSPENDED')
    eq(runtimeB._runners.size, 0)
    await sleep(50)
    eq((await readEvents(runtimeB, url, instanceId)).lastSeq, seqAtSuspend, '重启后不得自己往前跑')

    res = await runtimeB.handle({ method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: { reason: '重启后恢复' } })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.status, 'ACTIVE')
    eq(runtimeB._runners.size, 0, 'resume 本身不建 runner')
    res = await runtimeB.handle({
      method: 'POST', parts: ['instances', instanceId, 'tasks', 'human1', 'complete'], url, body: { payload: { approved: true } },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.status, 'COMPLETED')
    const events = await readEvents(runtimeB, url, instanceId)
    eq(countType(events.events, 'activity/wait'), 1, '恢复后 complete 不重放 wait')
    eq(countType(events.events, 'process/end'), 1)
    await runtimeB.dispose()
  })

  await check('E4 SUSPENDED 上 stop 仍可用；终态不可逆', async home => {
    const { runtime, url, instanceId } = await setupWaitingInstance(home)
    let res = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: {} })
    eq(res.status, 200, JSON.stringify(res.body))
    const seqAtSuspend = (await readEvents(runtime, url, instanceId)).lastSeq

    res = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'stop'], url })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.status, 'CANCELED')
    eq(res.body.alreadyTerminal, false)
    eq(readInstanceJson(home, instanceId).status, 'CANCELED')
    const seqAfterStop = (await readEvents(runtime, url, instanceId)).lastSeq
    eq(seqAfterStop, seqAtSuspend, 'stop 不追加伪造事件')

    res = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: {} })
    eq(res.status, 409)
    eq(res.body.code, 'BPMN_INSTANCE_TERMINAL')
    res = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: {} })
    eq(res.status, 409)
    eq(res.body.code, 'BPMN_INSTANCE_TERMINAL')
    eq((await readEvents(runtime, url, instanceId)).lastSeq, seqAfterStop, '终态不可逆且零事件')
  })

  await check('E4 指标：挂起区间 ≥ N，wallMs 继续增长', async home => {
    const { runtime, url, instanceId } = await setupWaitingInstance(home)
    const before = await runtime.handle({ method: 'GET', parts: ['instances', instanceId, 'metrics'], url })
    eq(before.status, 200, JSON.stringify(before.body))
    eq(before.body.duration.suspendedMs, 0, '从未挂起时挂起耗时为 0')
    const wallBefore = before.body.duration.wallMs

    const res = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: {} })
    eq(res.status, 200, JSON.stringify(res.body))
    const sleepMs = 120
    await sleep(sleepMs)

    const during = await runtime.handle({ method: 'GET', parts: ['instances', instanceId, 'metrics'], url })
    eq(during.status, 200, JSON.stringify(during.body))
    eq(during.body.status, 'SUSPENDED')
    ok(during.body.duration.suspendedMs >= 100, `挂起区间应 ≥100ms（实际 ${during.body.duration.suspendedMs}）`)
    ok(during.body.duration.wallMs > wallBefore, '挂起期间墙钟继续增长（含挂起时间）')

    // 恢复后区间收口；再读时挂起耗时不再无限增长。
    await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: {} })
    const suspendedClosed = (await runtime.handle({
      method: 'GET', parts: ['instances', instanceId, 'metrics'], url,
    })).body.duration.suspendedMs
    await sleep(60)
    const after = (await runtime.handle({ method: 'GET', parts: ['instances', instanceId, 'metrics'], url })).body
    eq(after.duration.suspendedMs, suspendedClosed, '恢复后挂起区间不再增长')
    ok(after.duration.wallMs > during.body.duration.wallMs, '恢复后墙钟继续增长')
  })

  // -------------------------------------------------------------------------
  // 7. 懒恢复（关键可靠性）：丢掉内存注册表后从 state.json 恢复并继续到 done
  // -------------------------------------------------------------------------
  await check('懒恢复：新 runtime 丢掉注册表后 GET 能 recovered:true，并继续 complete 到 done', async home => {
    const env = {}
    const dir = join(home, 'flow-studio')
    const agents = makeFakeAdapter()
    const fakeAdapters = makeFakeAdapters(agents)
    const url = new URL('http://localhost/')

    const runtimeA = createBpmnRuntime({ dir, env, adapters: fakeAdapters })
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

    const runtimeB = createBpmnRuntime({ dir, env, adapters: fakeAdapters })
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
    const dir = join(home, 'flow-studio')
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
  // 8. handler 边界：无注册表明确失败 / custom 零派发 / http 明确未实现
  // -------------------------------------------------------------------------
  await check('handler 边界：无注册表明确失败；custom 与 codex 零派发；http 走受控目标校验', async home => {
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

    // 0.13.6：http 不再是占位实现；直接调用也必须过目标策略（这里用回环地址证明
    // 校验发生在任何网络动作之前）。
    await rejects(
      () => executeHttp(
        { id: 'http-1', node: { http: { method: 'GET', url: 'https://127.0.0.1/' } } },
        ctx,
        { storeRoot: join(home, 'connector-store') },
      ),
      error => error.code === 'HTTP_DESTINATION_BLOCKED',
      'http 走真实 connector，默认阻断回环地址',
    )

    // 回归（本次修复）：custom 不再是 agent 完结路径，executor 桩一次都不能被调用。
    const executorCalls = []
    const executorStub = async options => {
      executorCalls.push(options)
      return { ok: true, text: 'cli', structured: { cli: true }, usage: {}, exitCode: 0, events: [] }
    }
    await rejects(
      () => executeAgent(
        { id: 'agent-custom', name: '自定义', node: { adapter: 'custom', executor: { kind: 'custom', command: 'echo stub' } } },
        { attempt: 2, variables: { amount: 7 }, signal: new AbortController().signal, timeoutMs: 1234 },
        { runExecutor: executorStub },
      ),
      error => {
        eq(error.code, 'BPMN_AGENT_ADAPTER_UNSUPPORTED', 'custom 必须报 ADAPTER_UNSUPPORTED')
        ok(error.message.includes('不再是 agent 完结路径'), '文案要说明 custom 不是完结路径')
        ok(error.message.includes('flow_finish_node'), '文案要指向 flow_finish_node')
        return true
      },
      'custom 必须明确拒绝',
    )
    eq(executorCalls.length, 0, 'custom 的 executor 桩一次都不能被调用')

    // 回归（本次修复）：没有注册表时 codex 也不再回退外部 executor。
    await rejects(
      () => executeAgent(
        { id: 'agent-codex', node: { adapter: 'codex', executor: { kind: 'codex', timeoutMs: 99 } } },
        ctx,
        { runExecutor: executorStub },
      ),
      error => {
        eq(error.code, 'BPMN_AGENT_ADAPTER_UNAVAILABLE', 'codex 无注册表必须报 ADAPTER_UNAVAILABLE')
        ok(error.message.includes('flow_finish_node'), '文案要指向 flow_finish_node')
        return true
      },
      '没有注册表时 codex 必须明确失败',
    )
    eq(executorCalls.length, 0, '无注册表时 codex 的 executor 桩一次都不能被调用')

    // 没有注册表时未知 id 同样明确失败（不会掉进任何外部 CLI 分支）。
    await rejects(
      () => executeAgent({ id: 'agent-x', node: { adapter: 'claude' } }, ctx, { runExecutor: executorStub }),
      error => error.code === 'BPMN_AGENT_ADAPTER_UNSUPPORTED',
      '未知 adapter 必须报 ADAPTER_UNSUPPORTED',
    )
    eq(executorCalls.length, 0, '未知 adapter 也不能碰 executor 桩')

    // 注册过的 dsh adapter 走完结门：输出来自闸门受理的 record，而不是 CLI 文本。
    const counter = { starts: 0 }
    const adapter = makeFakeAdapter(async ({ finishGate }) => {
      counter.starts += 1
      const submitted = await finishGate.submit({ variables: { via: 'finish' }, documents: [], summary: 'ok' })
      return {
        exited: Promise.resolve({ ok: true, record: submitted.record, usage: { total: 5 } }),
      }
    })
    const result = await executeAgent(dshElement, ctx, { adapters: makeFakeAdapters(adapter) })
    eq(counter.starts, 1, '注册过的 adapter 必须被派发一次')
    deep(result.output, { via: 'finish' })
    eq(result.usage.total, 5)

    // 已 abort 的 signal 必须尽快返回，不进入 adapter。
    const aborted = new AbortController()
    aborted.abort()
    await rejects(
      () => executeAgent(dshElement, { attempt: 1, variables: {}, signal: aborted.signal }, { adapters: makeFakeAdapters(adapter) }),
      error => error.code === 'BPMN_ABORTED',
      'abort 必须优先于 adapter 判定',
    )
    eq(counter.starts, 1, 'abort 之后不能再派发 adapter')
  })

  // -------------------------------------------------------------------------
  // 8b. 通过实例验证无注册表：实例 status 仍 ACTIVE，lastError 保留真实原因
  // -------------------------------------------------------------------------
  await check('实例里的 dsh adapter：ACTIVE + lastError.code = BPMN_AGENT_ADAPTER_UNAVAILABLE', async home => {
    const route = { handler: createHandler(makeEnv(home, { bpmnAdapters: null })) }
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

    const detail = await call(route, 'GET', `${API}/instances/${created.json.id}`)
    eq(detail.status, 200)
    eq(detail.json.status, 'ACTIVE', '出错后 status 仍是 ACTIVE（不判死）')
    eq(detail.json.lastError.code, 'BPMN_AGENT_ADAPTER_UNAVAILABLE', 'lastError 必须保留 handler 的真实错误码')
    ok(detail.json.lastError.message.includes('没有适配器注册表'), '文案说明缺注册表，且不退回外部 CLI')
    const events = await call(route, 'GET', `${API}/instances/${created.json.id}/events`)
    ok(events.json.events.some(event => event.type === 'error'), 'error 事件必须留痕')
    ok(!events.json.events.some(event => event.type === 'activity/end' && event.output !== undefined), '零派发：不得把任何 agent 输出写回事件')
    ok(!events.json.events.some(event => event.type === 'process/end'), '出错不发 process/end')
  })

  // -------------------------------------------------------------------------
  // 9. 大输出：事件单条上限 8KB，桥接层必须裁剪而不是让实例失败
  // -------------------------------------------------------------------------
  await check('大输出：activity/end 超过 8KB 时事件被裁剪并标 truncated，实例仍能完成', async home => {
    const hugeAdapter = makeFakeAdapter(async ({ finishGate }) => {
      const submitted = await finishGate.submit({
        variables: { ok: true },
        documents: [],
        summary: 'ok',
      })
      return {
        // 完结门的 variables 有 8KB 上限；这里用 adapter 透传的 usage 制造大事件，
        // 验证桥接层对 activity/end 的 8KB 裁剪（不是让实例失败）。
        exited: Promise.resolve({
          ok: true,
          record: submitted.record,
          usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, total: 2, blob: 'y'.repeat(20000) },
        }),
      }
    })
    const route = { handler: createHandler(makeEnv(home, { bpmnAdapters: makeFakeAdapters(hugeAdapter) })) }
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
    const agents = makeFakeAdapter()
    const fakeAdapters = makeFakeAdapters(agents)
    const dir = join(home, 'flow-studio')
    const env = {}
    const url = new URL('http://localhost/')
    const runtimeA = createBpmnRuntime({ dir, env, adapters: fakeAdapters })
    let res = await runtimeA.handle({ method: 'POST', parts: ['definitions'], url, body: { id: 'flow-demo', name: '演示流程', xml: workflowXml() } })
    eq(res.status, 201, JSON.stringify(res.body))
    res = await runtimeA.handle({ method: 'POST', parts: ['instances'], url, body: { definitionId: 'flow-demo', variables: { amount: 7 } } })
    eq(res.status, 201, JSON.stringify(res.body))
    const instanceId = res.body.id
    const callsAfterStart = agents.calls.length
    ok(callsAfterStart >= 1, '首次启动确实派发过一次 adapter')
    await runtimeA.dispose()

    const statePath = join(home, 'flow-studio', 'instances', instanceId, 'state.json')
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    const envelope = saved.state
    eq(envelope.v, 2, '落盘信封是 v2')
    for (const field of ['definitionId', 'definitionHash', 'version', 'processId', 'instanceId', 'kind']) {
      ok(envelope[field] !== undefined, `state 信封必须带 ${field}`)
    }

    const newRuntime = () => createBpmnRuntime({ dir, env, adapters: fakeAdapters })
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
      eq(agents.calls.length, callsAfterStart, '恢复失败不得派发 handler')
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
      eq(agents.calls.length, callsAfterStart, '结构不匹配不得派发 handler')
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
    const route = { handler: createHandler(makeEnv(home)) }
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
      <bpmn:extensionElements><fs:node nodeType="agent" adapter="dsh"></fs:node></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:userTask id="human1"/>
    <bpmn:serviceTask id="agent2">
      <bpmn:extensionElements><fs:node nodeType="agent" adapter="dsh"></fs:node></bpmn:extensionElements>
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
    const slowAdapter = makeFakeAdapter(async request => {
      if (request.element?.id === 'agent2') {
        slowStarted = true
        request.ctx.signal?.addEventListener('abort', () => { slowAborted = true }, { once: true })
        await new Promise((resolve) => { releaseSlow = resolve })
        const submitted = await request.finishGate.submit({ variables: { late: true }, documents: [], summary: 'late' })
        return { exited: Promise.resolve({ ok: true, record: submitted.record }) }
      }
      return null
    })
    const route = { handler: createHandler(makeEnv(home, { bpmnAdapters: makeFakeAdapters(slowAdapter) })) }
    const saved = await call(route, 'POST', `${API}/definitions`, { id: 'flow-slow', name: '慢节点', xml })
    eq(saved.status, 201, JSON.stringify(saved.json))
    const created = await call(route, 'POST', `${API}/instances`, { definitionId: 'flow-slow' })
    eq(created.status, 201, JSON.stringify(created.json))
    const id = created.json.id
    eq(created.json.status, 'ACTIVE')

    // complete 在飞：它会停在 agent2 的慢 adapter 上并持有实例锁。
    const completePromise = call(route, 'POST', `${API}/instances/${id}/tasks/human1/complete`, { payload: { approved: true } })
    for (let index = 0; index < 200 && !slowStarted; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    ok(slowStarted, 'agent2 的慢 adapter 必须已经在飞')

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
    const agents = makeFakeAdapter()
    const dir = join(home, 'flow-studio')
    const env = {}
    const runtime = createBpmnRuntime({ dir, env, adapters: makeFakeAdapters(agents) })
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
      eq(agents.calls.length, 0, 'stop 返回时不得有派发')

      releaseRead()
      const created = await createPromise
      eq(created.status, 201, JSON.stringify(created.body))
      eq(created.body.status, 'CANCELED', '实例必须保持 CANCELED')
      eq(created.body.error?.code, 'BPMN_INSTANCE_STOPPING', '启动必须返回明确的 stopped 结果')
      eq(agents.calls.length, 0, '放行后也不得派发 agent（外部副作用为零）')
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
    const dir = join(home, 'flow-studio')
    const url = new URL('http://localhost/')
    const agentsA = makeFakeAdapter()
    const runtimeA = createBpmnRuntime({ dir, env: {}, adapters: makeFakeAdapters(agentsA) })
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
      eq(agentsA.calls.length, 1, '首次启动执行一次 agent，然后停在人工任务')
      eq(res.body.status, 'ACTIVE')
    } finally {
      await runtimeA.dispose()
    }

    const instancesRoot = join(home, 'flow-studio', 'instances')
    const beforeEvents = (await instStore.readInstanceEvents(id, { instancesRoot })) ?? []
    const beforeLastSeq = readInstanceJson(home, id).lastSeq

    // 新 runtime（模拟进程重启）：GET 触发懒恢复，在定义快照读取处暂停。
    const agentsB = makeFakeAdapter()
    const runtimeB = createBpmnRuntime({ dir, env: {}, adapters: makeFakeAdapters(agentsB) })
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
      eq(agentsB.calls.length, 0, '恢复不得重放 agent')
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
    const dir = join(home, 'flow-studio')
    const url = new URL('http://localhost/')
    const runtimeA = createBpmnRuntime({ dir, env: {}, adapters: makeFakeAdapters() })
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

    const runtimeB = createBpmnRuntime({ dir, env: {}, adapters: makeFakeAdapters() })
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
    <bpmn:serviceTask id="agent1"><bpmn:extensionElements><fs:node nodeType="agent" adapter="dsh"></fs:node></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:userTask id="human1"/>
    <bpmn:serviceTask id="agent2"><bpmn:extensionElements><fs:node nodeType="agent" adapter="dsh"></fs:node></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="agent1" targetRef="human1"/>
    <bpmn:sequenceFlow id="f3" sourceRef="human1" targetRef="agent2"/>
    <bpmn:sequenceFlow id="f4" sourceRef="agent2" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
    const env = {}
    const dir = join(home, 'flow-studio')
    const url = new URL('http://localhost/')
    let calls = 0
    const failingAdapter = makeFakeAdapter(async () => {
      calls += 1
      if (calls === 1) return null
      return { exited: Promise.resolve({ ok: false, code: 'NODE_FINISH_FAILED', message: 'boom' }) }
    })
    const runtimeA = createBpmnRuntime({ dir, env, adapters: makeFakeAdapters(failingAdapter) })
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
    const runtimeB = createBpmnRuntime({ dir, env, adapters: makeFakeAdapters() })
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
    // MAJOR-3 残余（契约）：executionFailure 是「执行已确认停下」的事实，冷恢复与热 runner
    // 同口径返回 BPMN_INSTANCE_BLOCKED（带 recoveryCode），不再是 NOT_RECOVERABLE。
    eq(replay.body.code, 'BPMN_INSTANCE_BLOCKED')
    eq(replay.body.recoveryCode, raw.lastError.code, 'recoveryCode 保留失败码')
    await runtimeB.dispose()
  })

  // -------------------------------------------------------------------------
  // 12.4 0.13.6 HTTP connector：start → http → exclusiveGateway → human → end
  // -------------------------------------------------------------------------
  await check('HTTP connector：502→200 重试共享幂等键，网关按映射结果分支到人工', async home => {
    const requests = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        if (requests.length === 1) {
          res.writeHead(502, { 'content-type': 'text/plain' })
          res.end('bad gateway')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-42' })
        res.end(JSON.stringify({ accepted: true }))
      })
    })
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const port = server.address().port
    const secret = 'integration-secret-must-not-leak'
    const previousAuth = process.env.FLOW_STUDIO_HTTP_AUTH_ORDERS_API
    process.env.FLOW_STUDIO_HTTP_AUTH_ORDERS_API = secret
    try {
      const route = {
        handler: createHandler(makeEnv(home, {
          bpmnHttpPolicy: {
            allowInsecureOrigins: [`fixture.test:${port}`],
            resolver: async hostname => {
              if (hostname !== 'fixture.test') throw new Error(`unexpected host ${hostname}`)
              return [{ address: '127.0.0.1', family: 4 }]
            },
            retryBackoffBaseMs: 1,
            retryBackoffMaxMs: 5,
          },
        })),
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="defs-http" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-http" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="submit" name="提交订单">
      <bpmn:extensionElements>
        <fs:node nodeType="http">
          <fs:http method="POST" url="http://fixture.test:${port}/orders" headers="{&quot;content-type&quot;:&quot;application/json&quot;}" retries="2" timeoutMs="5000" authRef="orders-api" idempotencyMode="remote-key" idempotencyHeader="Idempotency-Key"/>
        </fs:node>
        <zeebe:ioMapping>
          <zeebe:input source="= { orderId: order_id }" target="body"/>
          <zeebe:output source="= response.status" target="http_status"/>
          <zeebe:output source="= response.body.accepted" target="accepted"/>
        </zeebe:ioMapping>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:exclusiveGateway id="gw" default="f_no"/>
    <bpmn:userTask id="review" name="人工复核"/>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="submit"/>
    <bpmn:sequenceFlow id="f2" sourceRef="submit" targetRef="gw"/>
    <bpmn:sequenceFlow id="f_yes" sourceRef="gw" targetRef="review">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="feel">= accepted = true</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f_no" sourceRef="gw" targetRef="end"/>
    <bpmn:sequenceFlow id="f_end" sourceRef="review" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
      const saved = await call(route, 'POST', `${API}/definitions`, { id: 'flow-http', name: 'HTTP 集成', xml })
      eq(saved.status, 201, JSON.stringify(saved.json))
      const created = await call(route, 'POST', `${API}/instances`, {
        definitionId: 'flow-http',
        variables: { order_id: 'o-42' },
      })
      eq(created.status, 201, JSON.stringify(created.json))
      eq(created.json.status, 'ACTIVE', 'http 成功后流程停在人工节点')
      const instanceId = created.json.id

      // fixture 对账：两次请求（502 → 200），同一幂等键，body 来自局部输入映射。
      eq(requests.length, 2, '502 后按配置重试一次')
      eq(requests[0].method, 'POST')
      eq(requests[0].url, '/orders')
      eq(requests[0].body, '{"orderId":"o-42"}')
      eq(requests[1].body, '{"orderId":"o-42"}')
      ok(typeof requests[0].headers['idempotency-key'] === 'string' && requests[0].headers['idempotency-key'] !== '')
      eq(requests[1].headers['idempotency-key'], requests[0].headers['idempotency-key'], '重试共享同一个幂等键')
      eq(requests[0].headers.authorization, `Bearer ${secret}`, 'authRef 从宿主配置解析')
      eq(requests[0].headers.host, `fixture.test:${port}`, '连接使用已验证地址但保留原 Host')

      const detail = await call(route, 'GET', `${API}/instances/${instanceId}`)
      eq(detail.status, 200)
      eq(detail.json.status, 'ACTIVE')
      eq(detail.json.lastError, null, '成功调用不写 lastError')
      eq(detail.json.variables.http_status, 200, '输出映射写回状态码')
      eq(detail.json.variables.accepted, true, '输出映射写回业务字段')
      eq(detail.json.variables.order_id, 'o-42', '输入映射不覆盖实例变量')
      const pending = detail.json.pendingTasks
      eq(pending.length, 1, '网关 accepted=true 分支到人工节点')
      eq(pending[0].activityId, 'review')

      const events = await call(route, 'GET', `${API}/instances/${instanceId}/events`)
      const list = events.json.events
      eq(countType(list, 'http/attempt'), 2, '502 + 200 各一次尝试')
      eq(countType(list, 'http/result'), 2, '502 的失败尝试与最终 200 各记一条 result')
      ok(countType(list, 'activity/end') >= 1, 'http 活动完成')
      const submitEnd = list.find(event => event.type === 'activity/end' && event.elementId === 'submit')
      ok(submitEnd !== undefined, 'submit 的 activity/end 必须存在')
      eq(submitEnd.status, 200)
      deep(submitEnd.output, { http_status: 200, accepted: true }, 'activity/end 只带显式输出映射')
      const serialized = JSON.stringify(list)
      ok(!serialized.includes(secret), '事件流里不得出现鉴权值')
      ok(!serialized.includes('"authorization"'), '事件流里不得出现鉴权头')
      ok(!list.some(event => event.type === 'process/end'), '流程还没结束（停在人工节点）')
      const flowIds = list.filter(event => event.type === 'flow/taken').map(event => event.flowId)
      ok(flowIds.includes('f_yes'), 'accepted=true 走 f_yes 到人工节点')
      ok(!flowIds.includes('f_no'), '不得走默认边')

      const done = await call(route, 'POST', `${API}/instances/${instanceId}/tasks/review/complete`, {
        payload: { approved: true },
      })
      eq(done.status, 200, JSON.stringify(done.json))
      eq(done.json.status, 'COMPLETED', '人工完成后流程结束')
    } finally {
      if (previousAuth === undefined) delete process.env.FLOW_STUDIO_HTTP_AUTH_ORDERS_API
      else process.env.FLOW_STUDIO_HTTP_AUTH_ORDERS_API = previousAuth
      await new Promise(resolveClose => server.close(() => resolveClose()))
    }
  })

  // -------------------------------------------------------------------------
  // 12.5 HTTP connector 失败语义：ACTIVE + lastError + error，不走出向连线
  // -------------------------------------------------------------------------
  await check('HTTP 失败：实例保持 ACTIVE + lastError + error 事件，不产生 activity/end / process/end', async home => {
    const server = http.createServer((req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
    })
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const port = server.address().port
    try {
      const route = {
        handler: createHandler(makeEnv(home, {
          bpmnHttpPolicy: {
            allowInsecureOrigins: [`fixture.test:${port}`],
            resolver: async () => [{ address: '127.0.0.1', family: 4 }],
            retryBackoffBaseMs: 1,
          },
        })),
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="defs-http-fail" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-http-fail" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="submit">
      <bpmn:extensionElements>
        <fs:node nodeType="http"><fs:http method="GET" url="http://fixture.test:${port}/fail" timeoutMs="3000"/></fs:node>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="submit"/>
    <bpmn:sequenceFlow id="f2" sourceRef="submit" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
      const saved = await call(route, 'POST', `${API}/definitions`, { id: 'flow-http-fail', name: 'HTTP 失败', xml })
      eq(saved.status, 201, JSON.stringify(saved.json))
      const created = await call(route, 'POST', `${API}/instances`, { definitionId: 'flow-http-fail' })
      eq(created.status, 201, JSON.stringify(created.json))
      eq(created.json.status, 'ACTIVE', 'handler 失败不得把实例判成 FAILED/STUCK')

      const detail = await call(route, 'GET', `${API}/instances/${created.json.id}`)
      eq(detail.json.status, 'ACTIVE', 'GET 仍是 ACTIVE')
      eq(detail.json.lastError.code, 'HTTP_STATUS_NOT_ACCEPTABLE', 'lastError 保留 connector 的错误码')
      ok(detail.json.lastError.message.includes('500'), 'lastError 说明远端状态码')
      deep(detail.json.pendingTasks, [], '失败后没有可继续的待办')

      const events = await call(route, 'GET', `${API}/instances/${created.json.id}/events`)
      const list = events.json.events
      ok(list.some(event => event.type === 'error'), 'error 事件必须留痕')
      ok(!list.some(event => event.type === 'activity/end' && event.elementId === 'submit'), '失败不得产生正常 activity/end')
      ok(!list.some(event => event.type === 'process/end'), '失败不得产生 process/end')
      ok(!list.some(event => event.type === 'flow/taken' && event.from === 'submit'), '失败不得走出向连线')
      const raw = readInstanceJson(home, created.json.id)
      eq(raw.status, 'ACTIVE', '落盘实例仍是 ACTIVE')
      eq(raw.lastError.code, 'HTTP_STATUS_NOT_ACCEPTABLE')
    } finally {
      await new Promise(resolveClose => server.close(() => resolveClose()))
    }
  })

  // -------------------------------------------------------------------------
  // 12. 0.13.7 实例域 worktree：路由 / 终态清理 / 产物快照 / 只读不启动 runner
  // -------------------------------------------------------------------------
  await check('实例 worktree 路由：建立 / ACTIVE 409 / 终态删除 / 只读不启动 runner', async home => {
    const repo = makeGitRepo(home)
    const url = new URL('http://localhost/')
    const makeRuntime = () => createBpmnRuntime({
      dir: join(home, 'flow-studio'),
      env: {},
      adapters: makeFakeAdapters(),
    })
    const runtimeA = makeRuntime()
    const runtimeB = makeRuntime()
    try {
      const saved = await runtimeA.handle({
        method: 'POST',
        parts: ['definitions'],
        url,
        body: { id: 'flow-wt', name: 'worktree', xml: workflowXml('proc-wt') },
      })
      eq(saved.status, 201, JSON.stringify(saved.body))

      const created = await runtimeA.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: { definitionId: 'flow-wt', workspace: { path: repo, worktree: { mode: 'on', cleanup: 'retain' } } },
      })
      eq(created.status, 201, JSON.stringify(created.body))
      eq(created.body.status, 'ACTIVE', '停在人工任务，实例 ACTIVE')
      eq(created.body.workspace.mode, 'worktree', '响应带工作区模式')
      const id = created.body.id

      const inspected = await runtimeA.handle({ method: 'GET', parts: ['instances', id, 'worktree'], url })
      eq(inspected.status, 200, JSON.stringify(inspected.body))
      eq(inspected.body.configured, true, 'worktree 已配置')
      eq(inspected.body.worktree.state, 'ok', '工作树检查 ok')
      eq(inspected.body.cleanable, false, 'ACTIVE 不可清理')

      const blocked = await runtimeA.handle({
        method: 'DELETE',
        parts: ['instances', id, 'worktree'],
        url,
        body: { force: true },
      })
      eq(blocked.status, 409, 'ACTIVE 清理 409')
      eq(blocked.body.code, 'INSTANCE_WORKTREE_INSTANCE_ACTIVE', 'force 不能越过 ACTIVE')
      eq((await runtimeA.handle({ method: 'PUT', parts: ['instances', id, 'worktree'], url })).status, 405, 'worktree 只支持 GET / DELETE')

      // 新 runtime：GET / 列表 / prune 预览都是只读，不能懒恢复出 runner。
      eq(runtimeB._runners.size, 0, '新 runtime 没有 runner')
      const listed = await runtimeB.handle({ method: 'GET', parts: ['instance-worktrees'], url })
      eq(listed.status, 200, JSON.stringify(listed.body))
      ok(listed.body.worktrees.some(entry => entry.instanceId === id), '列表能看到实例 worktree')
      eq(runtimeB._runners.size, 0, '列表不启动 runner')
      // 0.13.8：flow_instance_worktrees 与 HTTP 路由共用 runtime.handle，返回同一份清单。
      const instanceTool = createInstanceTools({ runtime: runtimeB })[0]
      const toolList = await instanceTool.execute({ action: 'list' })
      eq(toolList.ok, true, JSON.stringify(toolList))
      deep(toolList.worktrees, listed.body.worktrees, '模型工具与路由的一致性')
      deep(toolList.orphans, listed.body.orphans)
      const getB = await runtimeB.handle({ method: 'GET', parts: ['instances', id, 'worktree'], url })
      eq(getB.status, 200, JSON.stringify(getB.body))
      eq(runtimeB._runners.size, 0, 'GET worktree 不启动 runner')
      const dry = await runtimeB.handle({
        method: 'POST',
        parts: ['instance-worktrees', 'prune'],
        url,
        body: { dryRun: true },
      })
      eq(dry.status, 200, JSON.stringify(dry.body))
      eq(runtimeB._runners.size, 0, 'prune 预览不启动 runner')
      eq(dry.body.plan.entries.find(entry => entry.instanceId === id).action, 'retain', 'ACTIVE 实例在预览里只保留')
      eq((await runtimeB.handle({ method: 'GET', parts: ['instance-worktrees', 'prune'], url })).status, 405, 'prune 只支持 POST')
      eq((await runtimeB.handle({ method: 'GET', parts: ['instance-worktrees'], url: new URL(`http://localhost/?workspaceId=nope`) })).status, 400, 'workspaceId 校验')

      const stopped = await runtimeB.handle({ method: 'POST', parts: ['instances', id, 'stop'], url })
      eq(stopped.status, 200, JSON.stringify(stopped.body))
      eq(stopped.body.status, 'CANCELED', '停止后终态')

      const deleted = await runtimeB.handle({
        method: 'DELETE',
        parts: ['instances', id, 'worktree'],
        url,
        body: { removeBranch: true },
      })
      eq(deleted.status, 200, JSON.stringify(deleted.body))
      eq(deleted.body.removed, true, '终态可删')
      eq(deleted.body.branchRemoval.removed, true, '目录删除与分支删除独立返回')
      const after = await runtimeB.handle({ method: 'GET', parts: ['instances', id, 'worktree'], url })
      eq(after.status, 200, JSON.stringify(after.body))
      eq(after.body.worktree.state, 'missing', '删除后 state=missing')
      eq(after.body.cleanable, false, '已删不可清理')

      const resourceEvents = await runtimeB.handle({ method: 'GET', parts: ['instances', id, 'resource-events'], url })
      eq(resourceEvents.status, 200, JSON.stringify(resourceEvents.body))
      const types = resourceEvents.body.events.map(event => event.type)
      ok(types.includes('worktree/ready'), '资源事件记录建立')
      ok(types.includes('worktree/removed'), '资源事件记录删除')
      ok(types.includes('worktree/branch-removed'), '资源事件记录分支删除')
      eq(resourceEvents.body.resourceSeq >= 3, true, 'resourceSeq 独立递增')

      const branchAgain = await runtimeB.handle({ method: 'DELETE', parts: ['instances', id, 'worktree', 'branch'], url })
      eq(branchAgain.status, 200, '分支删除幂等返回 200')
      eq(branchAgain.body.branchRemoval.removed, false, '分支已不存在')
      eq(branchAgain.body.branchRemoval.reason, 'not-found', '分支不存在按 not-found 呈现')

      // SUSPENDED 与 ACTIVE 一样禁止清理（force 不能越过）。
      const suspended = await runtimeA.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: { definitionId: 'flow-wt', workspace: { path: repo, worktree: { mode: 'on' } } },
      })
      eq(suspended.status, 201, JSON.stringify(suspended.body))
      // 0.14.4：状态迁移只走生命周期路由（updateInstance 直接改 SUSPENDED 会被拒）。
      const suspendRes = await runtimeA.handle({
        method: 'POST',
        parts: ['instances', suspended.body.id, 'suspend'],
        url,
        body: { reason: 'worktree-cleanup-guard' },
      })
      eq(suspendRes.status, 200, JSON.stringify(suspendRes.body))
      eq(suspendRes.body.status, 'SUSPENDED')
      const suspendedDelete = await runtimeB.handle({
        method: 'DELETE',
        parts: ['instances', suspended.body.id, 'worktree'],
        url,
        body: { force: true },
      })
      eq(suspendedDelete.status, 409, 'SUSPENDED 清理 409')
      eq(suspendedDelete.body.code, 'INSTANCE_WORKTREE_INSTANCE_ACTIVE', 'SUSPENDED 同样被挡')

      // 冻结记录缺失：所有权记录还在 → WORKSPACE_UNAVAILABLE，绝不回退宿主目录。
      const lost = await runtimeA.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: { definitionId: 'flow-wt', workspace: { path: repo, worktree: { mode: 'on' } } },
      })
      eq(lost.status, 201, JSON.stringify(lost.body))
      rmSync(join(home, 'flow-studio', 'instances', lost.body.id, 'workspace.json'))
      const unavailable = await runtimeB.handle({ method: 'GET', parts: ['instances', lost.body.id, 'worktree'], url })
      eq(unavailable.status, 409, '缺冻结记录 409')
      eq(unavailable.body.code, 'WORKSPACE_UNAVAILABLE', '错误码 WORKSPACE_UNAVAILABLE（不静默回退）')
    } finally {
      await runtimeA.dispose()
      await runtimeB.dispose()
    }
  })

  await check('prune：dryRun 预览 / planHash 过期 409 / 无所有权目录只报告', async home => {
    const repo = makeGitRepo(home)
    const url = new URL('http://localhost/')
    const runtime = createBpmnRuntime({ dir: join(home, 'flow-studio'), env: {}, adapters: makeFakeAdapters() })
    try {
      const saved = await runtime.handle({
        method: 'POST',
        parts: ['definitions'],
        url,
        body: { id: 'flow-terminal', name: 'terminal', xml: agentOnlyXml('proc-terminal') },
      })
      eq(saved.status, 201, JSON.stringify(saved.body))
      const created = await runtime.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: { definitionId: 'flow-terminal', workspace: { path: repo, worktree: { mode: 'on', cleanup: 'retain' } } },
      })
      eq(created.status, 201, JSON.stringify(created.body))
      eq(created.body.status, 'COMPLETED', 'agent→end 正常完成')
      const id = created.body.id
      const workspaceId = created.body.workspace.workspaceId
      const worktreePath = created.body.workspace.effectiveRoot
      const junk = join(home, 'flow-studio', 'worktrees', workspaceId, 'i-junk')
      mkdirSync(junk, { recursive: true })
      writeFileSync(join(junk, 'keep.txt'), 'no ownership\n')

      const inspected = await runtime.handle({ method: 'GET', parts: ['instances', id, 'worktree'], url })
      eq(inspected.status, 200, JSON.stringify(inspected.body))
      eq(inspected.body.cleanable, true, '终态干净树可清理')

      const dry = await runtime.handle({ method: 'POST', parts: ['instance-worktrees', 'prune'], url, body: { dryRun: true } })
      eq(dry.status, 200, JSON.stringify(dry.body))
      ok(/^[0-9a-f]{64}$/.test(dry.body.planHash), '预览返回 planHash')
      eq(dry.body.plan.entries.find(entry => entry.instanceId === id).action, 'remove', '终态实例计划删除')
      eq(dry.body.plan.entries.find(entry => entry.instanceId === 'i-junk').action, 'report', '无所有权目录只报告')

      writeFileSync(join(worktreePath, 'dirty.txt'), 'changed\n')
      const stale = await runtime.handle({
        method: 'POST',
        parts: ['instance-worktrees', 'prune'],
        url,
        body: { dryRun: false, planHash: dry.body.planHash },
      })
      eq(stale.status, 409, '状态变化后旧 planHash 失效')
      eq(stale.body.code, 'INSTANCE_WORKTREE_PLAN_STALE', '错误码说明 plan 过期')
      ok(existsSync(worktreePath), '过期执行没有删树')

      const missingHash = await runtime.handle({ method: 'POST', parts: ['instance-worktrees', 'prune'], url, body: { dryRun: false } })
      eq(missingHash.status, 400, '执行必须带 planHash')

      rmSync(join(worktreePath, 'dirty.txt'))
      const fresh = await runtime.handle({ method: 'POST', parts: ['instance-worktrees', 'prune'], url, body: { dryRun: true } })
      eq(fresh.status, 200, JSON.stringify(fresh.body))
      eq(fresh.body.plan.entries.find(entry => entry.instanceId === id).action, 'remove', '恢复干净后重新可删')
      const executed = await runtime.handle({
        method: 'POST',
        parts: ['instance-worktrees', 'prune'],
        url,
        body: { dryRun: false, planHash: fresh.body.planHash },
      })
      eq(executed.status, 200, JSON.stringify(executed.body))
      ok(executed.body.removed.some(entry => entry.instanceId === id), '按计划删掉终态树')
      ok(executed.body.skipped.some(entry => entry.instanceId === 'i-junk' && entry.reason === 'no-ownership'), '无所有权目录进 skipped')
      ok(!existsSync(worktreePath), '终态树已删')
      ok(existsSync(junk), '无所有权目录没有被删')
      const replay = await runtime.handle({
        method: 'POST',
        parts: ['instance-worktrees', 'prune'],
        url,
        body: { dryRun: false, planHash: fresh.body.planHash },
      })
      eq(replay.status, 409, '同一 planHash 不能重放')
    } finally {
      await runtime.dispose()
    }
  })

  await check('workspace 策略：auto 非 Git 回退 / on 400 / allowlist 403 / 终态清理保留产物快照', async home => {
    const repo = makeGitRepo(home)
    const sub = join(repo, 'sub')
    mkdirSync(sub)
    const url = new URL('http://localhost/')
    const plainRuntime = createBpmnRuntime({
      dir: join(home, 'flow-studio'),
      env: {},
      adapters: makeFakeAdapters(),
      workspaceAllowlist: [repo],
    })
    try {
      const saved = await plainRuntime.handle({
        method: 'POST',
        parts: ['definitions'],
        url,
        body: { id: 'flow-ws', name: 'ws', xml: workflowXml('proc-ws') },
      })
      eq(saved.status, 201, JSON.stringify(saved.body))

      const onNonGit = await plainRuntime.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: { definitionId: 'flow-ws', workspace: { path: sub, worktree: { mode: 'on' } } },
      })
      eq(onNonGit.status, 400, 'on 必须建立成功')
      eq(onNonGit.body.code, 'WORKSPACE_NOT_GIT', '非 Git 明确报 WORKSPACE_NOT_GIT')

      const auto = await plainRuntime.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: { definitionId: 'flow-ws', workspace: { path: sub, worktree: { mode: 'auto' } } },
      })
      eq(auto.status, 201, JSON.stringify(auto.body))
      eq(auto.body.workspace.mode, 'off', 'auto 非 Git 回退原目录')
      eq(auto.body.workspace.worktree, null, '回退时没有 worktree 记录')

      const outside = await plainRuntime.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: { definitionId: 'flow-ws', workspace: { path: home } },
      })
      eq(outside.status, 403, 'allowlist 外 403')
      eq(outside.body.code, 'WORKSPACE_NOT_ALLOWED', '错误码 WORKSPACE_NOT_ALLOWED')

      const missing = await plainRuntime.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: { definitionId: 'flow-ws', workspace: { path: join(home, 'missing') } },
      })
      eq(missing.status, 400, '不存在路径 400')
      eq(missing.body.code, 'WORKSPACE_MISSING', '错误码 WORKSPACE_MISSING')
    } finally {
      await plainRuntime.dispose()
    }

    // 终态清理 + artifact 快照：agent 在树里写文档，gate 先保存快照，随后树被清理。
    const adapter = makeFakeAdapter(async request => {
      writeFileSync(join(request.workspaceRoot, 'out.md'), '# 产物\n')
      // agent 自己把产物提交进它的分支：终态清理只处理「树干净」的工作树。
      execFileSync('git', ['add', 'out.md'], { cwd: request.workspaceRoot, stdio: 'ignore' })
      execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'artifact'], {
        cwd: request.workspaceRoot,
        stdio: 'ignore',
      })
      const submitted = await request.finishGate.submit({
        variables: { ok: true },
        documents: [{ path: 'out.md', kind: 'markdown', title: '产物' }],
        summary: 'artifact',
      })
      return { exited: Promise.resolve({ ok: true, record: submitted.record }) }
    })
    const artifactRuntime = createBpmnRuntime({
      dir: join(home, 'flow-studio'),
      env: {},
      adapters: makeFakeAdapters(adapter),
      workspaceAllowlist: [repo],
    })
    try {
      const saved = await artifactRuntime.handle({
        method: 'POST',
        parts: ['definitions'],
        url,
        body: { id: 'flow-artifact', name: 'artifact', xml: agentOnlyXml('proc-artifact') },
      })
      eq(saved.status, 201, JSON.stringify(saved.body))
      const created = await artifactRuntime.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: {
          definitionId: 'flow-artifact',
          workspace: { path: repo, worktree: { mode: 'on', cleanup: 'on-terminal-clean' } },
        },
      })
      eq(created.status, 201, JSON.stringify(created.body))
      eq(created.body.status, 'COMPLETED', 'agent→end 完成')
      eq(created.body.workspace.mode, 'worktree', '使用 worktree')
      const id = created.body.id
      const worktreePath = created.body.workspace.effectiveRoot
      ok(!existsSync(worktreePath), 'on-terminal-clean 在终态后清理了工作树（产物已先落快照）')
      ok(!existsSync(join(repo, 'out.md')), '主工作区没有产物文件')

      const detail = await artifactRuntime.handle({ method: 'GET', parts: ['instances', id], url })
      eq(detail.status, 200, JSON.stringify(detail.body))
      eq(detail.body.artifacts.length, 1, '产物引用仍登记')
      const artifact = detail.body.artifacts[0]
      eq(artifact.path, 'out.md', '对外仍保持 path + sha256 + bytes 契约')
      eq(typeof artifact.sha256, 'string', 'sha256 可读')
      eq(artifact.bytes, Buffer.byteLength('# 产物\n'), 'bytes 可读')
      ok(artifact.contentRef.startsWith('artifacts/'), 'artifact 带 contentRef')
      eq(artifact.executionId !== undefined, true, 'artifact 带 executionId')
      eq(artifact.workspaceId, created.body.workspace.workspaceId, 'artifact 带 workspaceId')
      const content = await artifactRuntime.artifactStore.read(artifact.sha256)
      eq(content.toString('utf8'), '# 产物\n', '清理后仍能按原 hash 读回产物正文')

      const after = await artifactRuntime.handle({ method: 'GET', parts: ['instances', id, 'worktree'], url })
      eq(after.body.worktree.state, 'missing', 'GET 显示树已清理')
      const events = await artifactRuntime.handle({ method: 'GET', parts: ['instances', id, 'resource-events'], url })
      ok(events.body.events.some(event => event.type === 'worktree/removed'), '资源事件记录终态清理')

      // worktree 模式下节点 cwd 越界：零派发，实例 ACTIVE + lastError 码，不回退宿主目录。
      const cwdAdapter = makeFakeAdapter()
      const cwdRuntime = createBpmnRuntime({
        dir: join(home, 'flow-studio'),
        env: {},
        adapters: makeFakeAdapters(cwdAdapter),
        workspaceAllowlist: [repo],
      })
      try {
        const cwdSaved = await cwdRuntime.handle({
          method: 'POST',
          parts: ['definitions'],
          url,
          body: { id: 'flow-cwd', name: 'cwd', xml: agentOnlyXml('proc-cwd', '../outside') },
        })
        eq(cwdSaved.status, 201, JSON.stringify(cwdSaved.body))
        const cwdCreated = await cwdRuntime.handle({
          method: 'POST',
          parts: ['instances'],
          url,
          body: { definitionId: 'flow-cwd', workspace: { path: repo, worktree: { mode: 'on' } } },
        })
        eq(cwdCreated.status, 201, JSON.stringify(cwdCreated.body))
        eq(cwdCreated.body.error.code, 'WORKSPACE_CWD_OUTSIDE', '越界 cwd 明确失败')
        eq(cwdAdapter.calls.length, 0, '零派发：adapter.start 未被调用')
        eq(cwdCreated.body.status, 'ACTIVE', '失败不判死，实例仍 ACTIVE')
      } finally {
        await cwdRuntime.dispose()
      }
    } finally {
      await artifactRuntime.dispose()
    }
  })

  // -------------------------------------------------------------------------
  // 12.5 W4 · 物理执行生命周期：handler 结束 != agent 进程退出
  // -------------------------------------------------------------------------
  await check('W4 agent 进程未退出：槽位不释放、worktree 不清理；确认退出后才释放', async home => {
    const repo = makeGitRepo(home)
    const url = new URL('http://localhost/')
    const runtime = createBpmnRuntime({
      dir: join(home, 'flow-studio'),
      env: {},
      adapters: makeFakeAdapters(makeFakeAdapter()),
      workspaceAllowlist: [repo],
    })
    try {
      const saved = await runtime.handle({
        method: 'POST',
        parts: ['definitions'],
        url,
        body: { id: 'flow-w4', name: 'w4', xml: workflowXml('proc-w4') },
      })
      eq(saved.status, 201, JSON.stringify(saved.body))
      const created = await runtime.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: { definitionId: 'flow-w4', workspace: { path: repo, worktree: { mode: 'on', cleanup: 'on-terminal-clean' } } },
      })
      eq(created.status, 201, JSON.stringify(created.body))
      const id = created.body.id
      eq(created.body.status, 'ACTIVE', '停在人工任务')
      const worktreePath = created.body.workspace.effectiveRoot
      ok(existsSync(worktreePath), 'worktree 已建立')

      // start 一直不返回：模拟 agent 进程还没有退出。
      let resolveStart = null
      const hanging = {
        id: 'dsh',
        async probe() {
          return { version: 'stub', helpDigest: 'stub' }
        },
        capabilities() {
          return { finishTool: 'native', hooks: { 'turn.stop': 'emulated' } }
        },
        start() {
          return new Promise(resolveStarted => { resolveStart = resolveStarted })
        },
        async cancel() {},
        async dispose() {},
      }
      runtime.adapters = makeFakeAdapters(hanging)
      const controller = new AbortController()
      const element = { id: 'agent-direct', node: { adapter: 'dsh' } }
      const running = runtime._executeAgentFor(id, element, {
        attempt: 1,
        executionId: 'exec-w4',
        signal: controller.signal,
        variables: {},
      })
      ok(await waitUntil(() => runtime._activeAgents.get(id) === 1), 'start 阶段已占用槽位')
      eq(runtime.executionLimits.active, 1, '执行槽位已占用')
      controller.abort()
      await rejects(
        running,
        error => error && error.code === 'BPMN_ABORTED',
        'start 阶段 abort → BPMN_ABORTED',
      )

      // 关键断言：handler 已结束，但 start 尚未返回 → 物理执行仍在，槽位不释放。
      eq(runtime._activeAgents.get(id), 1, 'start 未返回时 activeAgents 仍为 1')
      eq(runtime.executionLimits.active, 1, 'start 未返回时执行槽位不释放')
      eq(await runtime._waitAgentsReleased(id, 30), false, '清理等待判定为「未释放」')

      // 实例转终态后触发终态清理：应该跳过并保留目录。
      await instStore.completeInstance(id, 'CANCELED', { instancesRoot: runtime.instancesRoot })
      await runtime._maybeTerminalCleanup(id, { waitMs: 30 })
      ok(existsSync(worktreePath), '进程未退出时终态清理不删 worktree')
      const events = await runtime.handle({ method: 'GET', parts: ['instances', id, 'resource-events'], url })
      ok(
        events.body.events.some(event => event.type === 'worktree/cleanup-skipped' && event.reason === 'agent-still-running'),
        '资源事件记录 agent-still-running',
      )

      // 迟到的 start 返回句柄 → 后台 cancel+dispose 完成 → 这时才允许释放。
      resolveStart({ exited: Promise.resolve({ ok: true }) })
      ok(await waitUntil(() => runtime._activeAgents.get(id) === undefined), '确认退出后才释放 activeAgents')
      eq(runtime.executionLimits.active, 0, '确认退出后才释放执行槽位')

      // dispose 抛错同样不能当成已退出。
      const disposeBoom = {
        id: 'dsh',
        async probe() {
          return { version: 'stub', helpDigest: 'stub' }
        },
        capabilities() {
          return { finishTool: 'native', hooks: { 'turn.stop': 'emulated' } }
        },
        start() {
          let resolveExited
          const exited = new Promise(resolvePromise => { resolveExited = resolvePromise })
          return {
            exited,
            cancel() {
              resolveExited({ ok: false, code: 'NODE_FINISH_CANCELED' })
            },
          }
        },
        async cancel(handle) {
          handle.cancel()
        },
        async dispose() {
          throw new Error('dispose failed: host still alive')
        },
      }
      runtime.adapters = makeFakeAdapters(disposeBoom)
      const controller2 = new AbortController()
      const running2 = runtime._executeAgentFor(id, element, {
        attempt: 2,
        executionId: 'exec-w4-dispose',
        signal: controller2.signal,
        variables: {},
      })
      await sleep(20)
      controller2.abort()
      await rejects(
        running2,
        error => error && error.code === 'BPMN_ABORTED',
        'dispose 抛错时 handler 仍以 ABORTED 结束',
      )
      eq(runtime._activeAgents.get(id), 1, 'dispose 抛错 → 不释放 activeAgents')
      eq(runtime.executionLimits.active, 1, 'dispose 抛错 → 不释放槽位')
      await runtime._maybeTerminalCleanup(id, { waitMs: 30 })
      ok(existsSync(worktreePath), '退出未确认时仍不清理 worktree')
    } finally {
      await runtime.dispose()
    }
  })

  await check('N2 resume 进程未确认退出：cleanup.disposed=false 时槽位 / _executionBusy 保持占用', async home => {
    const repo = makeGitRepo(home)
    const url = new URL('http://localhost/')
    const runtime = createBpmnRuntime({
      dir: join(home, 'flow-studio'),
      env: {},
      adapters: makeFakeAdapters(),
      workspaceAllowlist: [repo],
    })
    try {
      const saved = await runtime.handle({
        method: 'POST',
        parts: ['definitions'],
        url,
        body: { id: 'flow-n2', name: 'n2', xml: workflowXml('proc-n2') },
      })
      eq(saved.status, 201, JSON.stringify(saved.body))
      const created = await runtime.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: { definitionId: 'flow-n2', workspace: { path: repo, worktree: { mode: 'on', cleanup: 'on-terminal-clean' } } },
      })
      eq(created.status, 201, JSON.stringify(created.body))
      const id = created.body.id
      const worktreePath = created.body.workspace.effectiveRoot

      // 适配器如实报告：逻辑结局已收口，但 resume 子进程仍未确认退出。
      const resumeAlive = {
        id: 'dsh',
        async probe() {
          return { version: 'stub', helpDigest: 'stub' }
        },
        capabilities() {
          return { finishTool: 'native', hooks: { 'turn.stop': 'emulated' } }
        },
        start() {
          return {
            exited: Promise.resolve({
              ok: false,
              code: 'NODE_FINISH_CANCELED',
              message: 'resume 子进程未确认退出',
            }),
            cleanup: { disposed: false, reason: '仍有 1 个 codex 子进程未确认退出（resume）' },
          }
        },
        async cancel() {},
        async dispose() {},
      }
      runtime.adapters = makeFakeAdapters(resumeAlive)
      const element = { id: 'agent-n2', node: { adapter: 'dsh' } }
      await rejects(
        runtime._executeAgentFor(id, element, {
          attempt: 1,
          executionId: 'exec-n2-resume',
          variables: {},
        }),
        error => error && error.code === 'BPMN_ABORTED',
        'N2：resume 未确认退出 → handler 以 ABORTED 结束',
      )
      eq(runtime._activeAgents.get(id), 1, 'N2：cleanup.disposed=false 时 activeAgents 仍占用')
      eq(runtime.executionLimits.active, 1, 'N2：cleanup.disposed=false 时执行槽位仍占用')
      ok(runtime._executionBusy(id), 'N2：_executionBusy 仍为 true')
      await instStore.completeInstance(id, 'CANCELED', { instancesRoot: runtime.instancesRoot })
      await runtime._maybeTerminalCleanup(id, { waitMs: 30 })
      ok(existsSync(worktreePath), 'N2：退出未确认时终态清理不删 worktree')
    } finally {
      await runtime.dispose()
    }
  })

  await check('M1 最终清理 Promise：settle 前不释放槽位，settle 后才释放', async home => {
    const repo = makeGitRepo(home)
    let finalSettledAt = 0
    const adapter = makeFakeAdapter(async request => {
      const submitted = await request.finishGate.submit({
        variables: { ok: true },
        documents: [],
        summary: 'late-final',
      })
      const cleanupFinal = new Promise(resolveFinal => {
        setTimeout(() => {
          finalSettledAt = Date.now()
          resolveFinal({ disposed: true })
        }, 150).unref?.()
      })
      return {
        exited: Promise.resolve({ ok: true, record: submitted.record }),
        cleanup: { disposed: false, reason: '进程组仍在退出' },
        cleanupFinal,
      }
    })
    const runtime = createBpmnRuntime({
      dir: join(home, 'flow-studio'),
      env: {},
      adapters: makeFakeAdapters(adapter),
      workspaceRoot: repo,
      cleanupFinalWaitMs: 2_000,
    })
    try {
      const id = 'i-m1-final'
      const startedAt = Date.now()
      await runtime._executeAgentFor(id, { id: 'agent-m1-final', node: { adapter: 'dsh' } }, {
        attempt: 1,
        executionId: 'exec-m1-final',
        variables: {},
      })
      ok(finalSettledAt > 0, '最终清理 Promise 已执行')
      ok(Date.now() - startedAt >= 120, 'dispose 等到最终清理 settle 才返回')
      eq(runtime._activeAgents.get(id), undefined, 'settle 后释放 activeAgents')
      eq(runtime.executionLimits.active, 0, 'settle 后释放执行槽位')
      ok(!runtime._executionBusy(id), 'settle 后 _executionBusy 为 false')
    } finally {
      await runtime.dispose()
    }
  })

  await check('M1 最终清理超时：如实保留占用并给出超时诊断', async home => {
    const repo = makeGitRepo(home)
    const adapter = makeFakeAdapter(async request => {
      const submitted = await request.finishGate.submit({
        variables: { ok: true },
        documents: [],
        summary: 'never-final',
      })
      return {
        exited: Promise.resolve({ ok: true, record: submitted.record }),
        cleanup: { disposed: false, reason: '进程组仍在退出' },
        // 永不 settle：runtime 必须按 cleanupFinalWaitMs 有界放弃并保留占用。
        cleanupFinal: new Promise(() => {}),
      }
    })
    const runtime = createBpmnRuntime({
      dir: join(home, 'flow-studio'),
      env: {},
      adapters: makeFakeAdapters(adapter),
      workspaceRoot: repo,
      cleanupFinalWaitMs: 100,
    })
    try {
      const id = 'i-m1-timeout'
      const startedAt = Date.now()
      await runtime._executeAgentFor(id, { id: 'agent-m1-timeout', node: { adapter: 'dsh' } }, {
        attempt: 1,
        executionId: 'exec-m1-timeout',
        variables: {},
      })
      ok(Date.now() - startedAt >= 80, '等满 cleanupFinalWaitMs 才放弃')
      eq(runtime._activeAgents.get(id), 1, '超时未确认清理：activeAgents 保持占用')
      eq(runtime.executionLimits.active, 1, '超时未确认清理：执行槽位保持占用')
      ok(runtime._executionBusy(id), '超时未确认清理：_executionBusy 仍为 true')
    } finally {
      await runtime.dispose()
    }
  })

  await check('F1 创建后元数据失败回滚：零仓库级 prune，移走 / 替换的目标不被删', async home => {
    const repo = makeGitRepo(home)
    const commands = []
    let target = null
    let variant = 'moved'
    const runner = async (argv, options) => {
      commands.push(argv.join(' '))
      const result = await defaultGitRunner(argv, options)
      if (argv.includes('branch') && argv.includes('-m') && target !== null) {
        renameSync(target, `${target}-moved`)
        if (variant === 'replaced') {
          mkdirSync(target, { recursive: true })
          writeFileSync(join(target, 'keep.txt'), 'other-owner\n')
        }
      }
      return result
    }
    const runtime = createBpmnRuntime({
      dir: join(home, 'flow-studio'),
      env: {},
      adapters: makeFakeAdapters(makeFakeAdapter()),
      workspaceAllowlist: [repo],
      worktreeRunner: runner,
    })
    try {
      const resolved = await resolveWorkspace({ path: repo, allowlist: [repo] })
      mkdirSync(runtime.instancesRoot, { recursive: true })
      const option = { worktree: { mode: 'on', baseRef: 'HEAD', cleanup: 'retain' } }

      // 1) 目标被移走。用普通文件占住 instances/<id>，使 workspace 快照写入确定性失败。
      const movedId = 'i-f1-runtime-moved'
      writeFileSync(join(runtime.instancesRoot, movedId), 'block snapshot write\n')
      target = join(runtime.worktreeRoot, resolved.workspaceId, movedId)
      variant = 'moved'
      const moved = await runtime._prepareInstanceWorkspace(movedId, option, resolved)
      eq(moved.workspace, null, '快照失败时工作区不假装就绪')
      ok(moved.error !== null, '返回可读错误')
      deep(commands.filter(command => command.includes('worktree prune')), [], '回滚链没有仓库级 prune')
      ok(existsSync(`${target}-moved`), '被移走的目标目录仍在')
      eq(gitCmd(repo, ['rev-parse', '--verify', `refs/heads/flow-instance/${movedId}`]).length > 0, true, '分支仍保留（所有权不明确时不删）')

      // 2) 目标被普通目录替换：无 .git 标记，回滚不得删替换目录。
      const replacedId = 'i-f1-runtime-replaced'
      writeFileSync(join(runtime.instancesRoot, replacedId), 'block snapshot write\n')
      target = join(runtime.worktreeRoot, resolved.workspaceId, replacedId)
      variant = 'replaced'
      const replaced = await runtime._prepareInstanceWorkspace(replacedId, option, resolved)
      eq(replaced.workspace, null, '替换场景同样失败')
      eq(readFileSync(join(target, 'keep.txt'), 'utf8'), 'other-owner\n', '替换目录里的文件未被删')
      ok(existsSync(`${target}-moved`), '被移走的原树仍在')
      deep(commands.filter(command => command.includes('worktree prune')), [], '整个回滚链零 prune')
    } finally {
      await runtime.dispose()
    }
  })

  await check('F3 DELETE / prune：物理执行未确认退出时拒绝，归零后才允许', async home => {
    const repo = makeGitRepo(home)
    const url = new URL('http://localhost/')
    const runtime = createBpmnRuntime({
      dir: join(home, 'flow-studio'),
      env: {},
      adapters: makeFakeAdapters(makeFakeAdapter()),
      workspaceAllowlist: [repo],
    })
    try {
      const saved = await runtime.handle({
        method: 'POST',
        parts: ['definitions'],
        url,
        body: { id: 'flow-f3', name: 'f3', xml: agentOnlyXml('proc-f3') },
      })
      eq(saved.status, 201, JSON.stringify(saved.body))
      const created = await runtime.handle({
        method: 'POST',
        parts: ['instances'],
        url,
        body: { definitionId: 'flow-f3', workspace: { path: repo, worktree: { mode: 'on' } } },
      })
      eq(created.status, 201, JSON.stringify(created.body))
      eq(created.body.status, 'COMPLETED', 'agent-only 流程已结束')
      const id = created.body.id
      const worktreePath = created.body.workspace.effectiveRoot
      ok(existsSync(worktreePath), 'worktree 已建立')

      // 模拟 handler 已结束但物理进程 / 清理未确认：_activeAgents 仍占用。
      runtime._activeAgents.set(id, 1)
      const blocked = await runtime.handle({ method: 'DELETE', parts: ['instances', id, 'worktree'], url })
      eq(blocked.status, 409, '手动 DELETE 被拒绝')
      eq(blocked.body.code, 'INSTANCE_WORKTREE_EXECUTION_ACTIVE')
      ok(existsSync(worktreePath), '拒绝时树还在')

      const branchBlocked = await runtime.handle({ method: 'DELETE', parts: ['instances', id, 'worktree', 'branch'], url })
      eq(branchBlocked.status, 409, '分支删除同样被拒绝')
      eq(branchBlocked.body.code, 'INSTANCE_WORKTREE_EXECUTION_ACTIVE')

      const dry = await runtime.handle({
        method: 'POST', parts: ['instance-worktrees', 'prune'], url, body: { dryRun: true },
      })
      eq(dry.status, 200, JSON.stringify(dry.body))
      const pruneBlocked = await runtime.handle({
        method: 'POST',
        parts: ['instance-worktrees', 'prune'],
        url,
        body: { dryRun: false, planHash: dry.body.planHash },
      })
      eq(pruneBlocked.status, 409, 'prune 执行被拒绝')
      eq(pruneBlocked.body.code, 'INSTANCE_WORKTREE_EXECUTION_ACTIVE')
      ok(existsSync(worktreePath), 'prune 拒绝时树还在')

      // 确认退出后，同一个删除入口恢复可用。
      runtime._activeAgents.delete(id)
      const removed = await runtime.handle({ method: 'DELETE', parts: ['instances', id, 'worktree'], url })
      eq(removed.status, 200, JSON.stringify(removed.body))
      eq(removed.body.removed, true, '归零后可以删')
      ok(!existsSync(worktreePath), '归零后树被删')
    } finally {
      await runtime.dispose()
    }
  })

  // -------------------------------------------------------------------------
  // 12.6 H5 · 崩溃恢复：同一逻辑激活必须复用同一 invocation / 幂等键
  // -------------------------------------------------------------------------
  await check('H5：恢复旧快照后重放 HTTP 活动复用同一调用记录，不产生第二次请求', async home => {
    const requests = []
    const server = http.createServer((req, res) => {
      requests.push({ headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"accepted":true}')
    })
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const port = server.address().port
    const httpPolicy = {
      allowInsecureOrigins: [`fixture.test:${port}`],
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="defs-h5" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-h5" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:userTask id="approve"/>
    <bpmn:serviceTask id="submit">
      <bpmn:extensionElements>
        <fs:node nodeType="http"><fs:http method="POST" url="http://fixture.test:${port}/orders" timeoutMs="5000" idempotencyMode="remote-key" idempotencyHeader="Idempotency-Key"/></fs:node>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:userTask id="review"/>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="approve"/>
    <bpmn:sequenceFlow id="f2" sourceRef="approve" targetRef="submit"/>
    <bpmn:sequenceFlow id="f3" sourceRef="submit" targetRef="review"/>
    <bpmn:sequenceFlow id="f4" sourceRef="review" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
    const dir = join(home, 'flow-studio')
    const url = new URL('http://localhost/')
    let runtime = createBpmnRuntime({ dir, env: {}, adapters: null, httpPolicy })
    try {
      let res = await runtime.handle({ method: 'POST', parts: ['definitions'], url, body: { id: 'flow-h5', name: 'H5', xml } })
      eq(res.status, 201, JSON.stringify(res.body))
      res = await runtime.handle({ method: 'POST', parts: ['instances'], url, body: { definitionId: 'flow-h5' } })
      eq(res.status, 201, JSON.stringify(res.body))
      const instanceId = res.body.id
      const instanceDir = join(home, 'flow-studio', 'instances', instanceId)
      const connectorDir = join(instanceDir, 'connector')
      const stateBefore = readFileSync(join(instanceDir, 'state.json'))
      const instanceBefore = readFileSync(join(instanceDir, 'instance.json'))

      // 模拟「HTTP 已成功落盘调用记录，但引擎新快照尚未写入时崩溃」：跳过 state 落盘。
      runtime._persistState = async () => {}
      res = await runtime.handle({
        method: 'POST', parts: ['instances', instanceId, 'tasks', 'approve', 'complete'], url, body: { payload: {} },
      })
      eq(res.status, 200, JSON.stringify(res.body))
      eq(requests.length, 1, '第一次审批完成后发送一次 HTTP')
      const firstKey = requests[0].headers['idempotency-key']
      ok(typeof firstKey === 'string' && firstKey !== '', '第一次请求带幂等键')
      const recordsAfterFirst = readdirSync(connectorDir).filter(name => name.endsWith('.json') && !name.startsWith('.'))
      eq(recordsAfterFirst.length, 1, '第一次成功后只有 1 条调用记录')
      const firstRecord = JSON.parse(readFileSync(join(connectorDir, recordsAfterFirst[0]), 'utf8'))
      eq(firstRecord.state, 'succeeded')
      eq(firstRecord.executionId, 'submit_attempt_1', '记录键使用稳定激活身份（elementId + ctx.attempt）')
      ok(String(firstRecord.engineExecutionId).startsWith('submit_'), '记录保留引擎随机 executionId 便于排障')
      eq(firstRecord.idempotencyKey, firstKey)

      // 崩溃：丢弃新快照，恢复旧引擎状态与旧实例元数据（保留 connector 记录）。
      await runtime.dispose()
      writeFileSync(join(instanceDir, 'state.json'), stateBefore)
      writeFileSync(join(instanceDir, 'instance.json'), instanceBefore)

      runtime = createBpmnRuntime({ dir, env: {}, adapters: null, httpPolicy })
      res = await runtime.handle({
        method: 'POST', parts: ['instances', instanceId, 'tasks', 'approve', 'complete'], url, body: { payload: {} },
      })
      eq(res.status, 200, JSON.stringify(res.body))
      eq(res.body.status, 'ACTIVE')
      eq(res.body.pendingTasks.length, 1)
      eq(res.body.pendingTasks[0].activityId, 'review', '恢复重放后仍推进到下一人工任务')
      eq(requests.length, 1, '恢复重放必须复用成功记录，绝不产生第二次请求')
      const recordsAfterReplay = readdirSync(connectorDir).filter(name => name.endsWith('.json') && !name.startsWith('.'))
      eq(recordsAfterReplay.length, 1, '恢复后仍只有 1 条 succeeded 记录')
      const replayRecord = JSON.parse(readFileSync(join(connectorDir, recordsAfterReplay[0]), 'utf8'))
      eq(replayRecord.state, 'succeeded')
      eq(replayRecord.idempotencyKey, firstKey, '恢复重放引用同一幂等键')
      const events = (await instStore.readInstanceEvents(instanceId, { instancesRoot: join(home, 'flow-studio', 'instances') })) ?? []
      ok(
        events.some(event => event.type === 'http/result' && event.reused === true),
        '恢复重放的 http/result 事件标记 reused=true',
      )
    } finally {
      await runtime.dispose()
      await new Promise(resolveClose => server.close(() => resolveClose()))
    }
  })

  // -------------------------------------------------------------------------
  // 12.7 H3 · 远端回显凭据时：变量 / 事件 / 调用记录都不出现该值
  // -------------------------------------------------------------------------
  await check('H3：响应体回显 Authorization → HTTP_RESPONSE_SECRET_LEAK，变量与事件不含凭据值', async home => {
    const secret = 'SYNTHETIC_RUNTIME_SECRET'
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ leaked: `Bearer ${secret}` }))
    })
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const port = server.address().port
    const previousAuth = process.env.FLOW_STUDIO_HTTP_AUTH_ECHO_API
    process.env.FLOW_STUDIO_HTTP_AUTH_ECHO_API = secret
    try {
      const route = {
        handler: createHandler(makeEnv(home, {
          bpmnHttpPolicy: {
            allowInsecureOrigins: [`fixture.test:${port}`],
            resolver: async () => [{ address: '127.0.0.1', family: 4 }],
          },
        })),
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="defs-h3" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-h3" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="submit">
      <bpmn:extensionElements>
        <fs:node nodeType="http"><fs:http method="GET" url="http://fixture.test:${port}/echo" authRef="echo-api" timeoutMs="3000"/></fs:node>
        <zeebe:ioMapping><zeebe:output source="= response.body.leaked" target="leaked"/></zeebe:ioMapping>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="submit"/>
    <bpmn:sequenceFlow id="f2" sourceRef="submit" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
      let res = await call(route, 'POST', `${API}/definitions`, { id: 'flow-h3', name: 'H3', xml })
      eq(res.status, 201, JSON.stringify(res.json))
      res = await call(route, 'POST', `${API}/instances`, { definitionId: 'flow-h3' })
      eq(res.status, 201, JSON.stringify(res.json))
      const instanceId = res.json.id
      eq(res.json.status, 'ACTIVE', '泄漏被拒绝后实例保持 ACTIVE')
      const detail = await call(route, 'GET', `${API}/instances/${instanceId}`)
      eq(detail.status, 200)
      eq(detail.json.lastError.code, 'HTTP_RESPONSE_SECRET_LEAK')
      ok(!JSON.stringify(detail.json.variables).includes(secret), '实例变量不含凭据值')
      eq(detail.json.variables.leaked, undefined, '输出映射没有写入变量')
      const events = await call(route, 'GET', `${API}/instances/${instanceId}/events`)
      ok(!JSON.stringify(events.json.events).includes(secret), '事件流不含凭据值')
      const instanceDir = join(home, 'flow-studio', 'instances', instanceId, 'connector')
      const recordText = readdirSync(instanceDir)
        .filter(name => name.endsWith('.json') && !name.startsWith('.'))
        .map(name => readFileSync(join(instanceDir, name), 'utf8'))
        .join('\n')
      ok(recordText !== '', '必须留下失败调用记录')
      ok(!recordText.includes(secret), '调用记录不含凭据值')
    } finally {
      if (previousAuth === undefined) delete process.env.FLOW_STUDIO_HTTP_AUTH_ECHO_API
      else process.env.FLOW_STUDIO_HTTP_AUTH_ECHO_API = previousAuth
      await new Promise(resolveClose => server.close(() => resolveClose()))
    }
  })

  // -------------------------------------------------------------------------
  // 12.8 m1 · connector 调用记录人工处置：鉴权 / 幂等 / 审计 / 实例保持 ACTIVE
  // -------------------------------------------------------------------------
  await check('m1：connector resolve 路由鉴权、幂等、审计，处置后实例仍 ACTIVE 且不伪造活动', async home => {
    const server = http.createServer((req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
    })
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const port = server.address().port
    const token = 'k1-connector-token-16chars'
    const previousToken = process.env.FLOW_STUDIO_TOKEN
    process.env.FLOW_STUDIO_TOKEN = token
    try {
      const route = {
        handler: createHandler(makeEnv(home, {
          bpmnHttpPolicy: {
            allowInsecureOrigins: [`fixture.test:${port}`],
            resolver: async () => [{ address: '127.0.0.1', family: 4 }],
          },
        })),
      }
      const auth = { authorization: `Bearer ${token}` }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="defs-m1" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-m1" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="submit">
      <bpmn:extensionElements>
        <fs:node nodeType="http"><fs:http method="GET" url="http://fixture.test:${port}/fail" timeoutMs="3000"/></fs:node>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="submit"/>
    <bpmn:sequenceFlow id="f2" sourceRef="submit" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
      let res = await call(route, 'POST', `${API}/definitions`, { id: 'flow-m1', name: 'm1', xml }, auth)
      eq(res.status, 201, JSON.stringify(res.json))
      res = await call(route, 'POST', `${API}/instances`, { definitionId: 'flow-m1' }, auth)
      eq(res.status, 201, JSON.stringify(res.json))
      const instanceId = res.json.id
      eq(res.json.status, 'ACTIVE')
      const detailBefore = await call(route, 'GET', `${API}/instances/${instanceId}`, undefined, auth)
      eq(detailBefore.json.lastError.code, 'HTTP_STATUS_NOT_ACCEPTABLE')
      const eventsBefore = await call(route, 'GET', `${API}/instances/${instanceId}/events`, undefined, auth)
      const eventCountBefore = eventsBefore.json.events.length

      const connectorDir = join(home, 'flow-studio', 'instances', instanceId, 'connector')
      const recordName = readdirSync(connectorDir).find(name => name.endsWith('.json') && !name.startsWith('.'))
      ok(typeof recordName === 'string', '失败调用必须留下记录')
      const record = JSON.parse(readFileSync(join(connectorDir, recordName), 'utf8'))
      eq(record.executionId, 'submit_attempt_1')
      eq(record.state, 'failed')
      const resolveUrl = `${API}/instances/${instanceId}/connector/${record.executionId}/resolve`

      // 鉴权：缺 token / 错 token 都拒绝（路由在统一的 /instances 鉴权之后）。
      res = await call(route, 'POST', resolveUrl, { action: 'mark-succeeded', evidence: 'x' })
      eq(res.status, 401, '缺少 Bearer token 必须 401')
      res = await call(route, 'POST', resolveUrl, { action: 'mark-succeeded', evidence: 'x' }, { authorization: 'Bearer wrong-token-value' })
      eq(res.status, 401, '错误 token 必须 401')

      // 参数校验。
      res = await call(route, 'POST', resolveUrl, { action: 'mark-succeeded' }, auth)
      eq(res.status, 400, '缺 evidence 必须 400')
      eq(res.json.code, 'HTTP_RESOLVE_INVALID')
      res = await call(route, 'POST', `${API}/instances/${instanceId}/connector/nope/resolve`, {
        action: 'mark-succeeded', evidence: 'x',
      }, auth)
      eq(res.status, 404)
      eq(res.json.code, 'HTTP_INVOCATION_NOT_FOUND')

      // 正常处置：只改记录 + 审计，实例仍 ACTIVE，绝不补 activity/end 或 process/end。
      res = await call(route, 'POST', resolveUrl, {
        action: 'mark-succeeded',
        evidence: '远端工单 #42 确认已入账',
        operator: 'ops-k1',
        result: { status: 200, headers: { 'content-type': 'application/json' }, output: { accepted: true } },
      }, auth)
      eq(res.status, 200, JSON.stringify(res.json))
      eq(res.json.ok, true)
      eq(res.json.status, 'ACTIVE')
      eq(res.json.idempotent, false)
      ok(typeof res.json.auditId === 'string' && res.json.auditId !== '')
      eq(res.json.record.state, 'succeeded')
      eq(res.json.record.result.manual, true)
      const detailAfter = await call(route, 'GET', `${API}/instances/${instanceId}`, undefined, auth)
      eq(detailAfter.json.status, 'ACTIVE', '处置后实例仍保持 ACTIVE 语义')
      eq(detailAfter.json.lastError.code, 'HTTP_STATUS_NOT_ACCEPTABLE', '处置不改写 lastError（不伪造已恢复）')
      const eventsAfter = await call(route, 'GET', `${API}/instances/${instanceId}/events`, undefined, auth)
      eq(eventsAfter.json.events.length, eventCountBefore, '处置不追加 activity/end 等引擎事件')
      ok(!eventsAfter.json.events.some(event => event.type === 'process/end'), '处置不得伪造流程结束')

      const auditLines = readFileSync(join(connectorDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      eq(auditLines.length, 1, '审计追加一条')
      eq(auditLines[0].action, 'mark-succeeded')
      eq(auditLines[0].evidence, '远端工单 #42 确认已入账')
      eq(auditLines[0].operator, 'ops-k1')
      eq(auditLines[0].executionId, record.executionId)
      eq(auditLines[0].idempotent, false)

      // 幂等：同一动作重复提交不再改记录、不再追加审计。
      res = await call(route, 'POST', resolveUrl, {
        action: 'mark-succeeded',
        evidence: '重复提交',
        operator: 'ops-k1',
      }, auth)
      eq(res.status, 200)
      eq(res.json.idempotent, true)
      eq(readFileSync(join(connectorDir, 'audit.jsonl'), 'utf8').trim().split('\n').length, 1)
      const detailFinal = await call(route, 'GET', `${API}/instances/${instanceId}`, undefined, auth)
      eq(detailFinal.json.status, 'ACTIVE')

      // ── m1（0.13.9）：不可恢复墓碑的受控清除 ──────────────────────────────
      const statePath = join(home, 'flow-studio', 'instances', instanceId, 'state.json')
      ok(existsSync(statePath), '失败实例必须留下 state.json 墓碑快照')
      const tombstone = JSON.parse(readFileSync(statePath, 'utf8'))
      ok(tombstone.state && tombstone.state.unrecoverable, '墓碑里必须带 unrecoverable 标记')
      // 模拟进程重启：内存里的 runner 仍是 blocked，墓碑只在磁盘快照里。
      const restarted = { handler: createHandler(makeEnv(home)) }
      const blocked = await call(restarted, 'GET', `${API}/instances/${instanceId}`, undefined, auth)
      ok(typeof blocked.json.recovery?.reason === 'string' && blocked.json.recovery.reason.includes('不可恢复'),
        '墓碑阻断必须给出可读原因')
      ok(blocked.json.recovery.reason.includes('clear-tombstone'),
        '墓碑原因必须说明 clear-tombstone 处置入口与「清除后仍不能自动继续」')
      ok(blocked.json.recovery.reason.includes('retry'),
        '墓碑原因必须说明 retry 只解除记录限制')

      // 鉴权 / 参数校验：失败时不得动墓碑。
      res = await call(restarted, 'POST', resolveUrl, { action: 'clear-tombstone', evidence: 'x' })
      eq(res.status, 401, 'clear-tombstone 缺 token 必须 401')
      res = await call(restarted, 'POST', resolveUrl, { action: 'clear-tombstone' }, auth)
      eq(res.status, 400, 'clear-tombstone 缺 evidence 必须 400')
      eq(res.json.code, 'HTTP_RESOLVE_INVALID')
      ok(existsSync(statePath), '参数非法时不得清除墓碑')

      const recordBeforeClear = JSON.parse(readFileSync(join(connectorDir, recordName), 'utf8'))
      const auditBeforeClear = readFileSync(join(connectorDir, 'audit.jsonl'), 'utf8').trim().split('\n').length
      res = await call(restarted, 'POST', resolveUrl, {
        action: 'clear-tombstone',
        evidence: '运维确认远端已失败，放弃本实例并清除墓碑',
        operator: 'ops-k1',
      }, auth)
      eq(res.status, 200, JSON.stringify(res.json))
      eq(res.json.ok, true)
      eq(res.json.tombstoneCleared, true, '首次处置必须真的清除墓碑')
      eq(res.json.idempotent, false)
      eq(res.json.status, 'ACTIVE', '清墓碑不改实例状态')
      eq(res.json.lastError.code, 'HTTP_STATUS_NOT_ACCEPTABLE', '清墓碑不改 lastError（不伪造恢复）')
      ok(!existsSync(statePath), '墓碑快照必须被删除')
      const afterClear = await call(restarted, 'GET', `${API}/instances/${instanceId}`, undefined, auth)
      eq(afterClear.json.recovery?.code, 'BPMN_STATE_MISSING',
        '清墓碑后剩余原因应是「没有可恢复快照」，而不是不可恢复墓碑')
      const eventsAfterClear = await call(restarted, 'GET', `${API}/instances/${instanceId}/events`, undefined, auth)
      eq(eventsAfterClear.json.events.length, eventCountBefore, '清墓碑不得追加任何引擎事件（不重放）')
      ok(!eventsAfterClear.json.events.some(item => item.type === 'process/end'), '不得伪造 process/end')
      // 不重放副作用：调用记录状态 / attempts 保持原样（clear-tombstone 不重置发送）。
      const recordAfterClear = JSON.parse(readFileSync(join(connectorDir, recordName), 'utf8'))
      eq(recordAfterClear.state, recordBeforeClear.state, 'clear-tombstone 不改调用记录状态（不重放 / 不伪造结果）')
      eq(recordAfterClear.attempts, recordBeforeClear.attempts, 'clear-tombstone 不重置发送尝试次数')
      const auditAfterClear = readFileSync(join(connectorDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      eq(auditAfterClear.length, auditBeforeClear + 1, 'clear-tombstone 真实变更追加一条审计')
      const clearAudit = auditAfterClear[auditAfterClear.length - 1]
      eq(clearAudit.action, 'clear-tombstone')
      eq(clearAudit.evidence, '运维确认远端已失败，放弃本实例并清除墓碑')
      eq(clearAudit.tombstoneCleared, true)
      eq(clearAudit.instanceId, instanceId)

      // 幂等：重复提交不再改记录、不再追加审计、不再重复清墓碑。
      res = await call(restarted, 'POST', resolveUrl, { action: 'clear-tombstone', evidence: '重复提交' }, auth)
      eq(res.status, 200)
      eq(res.json.idempotent, true)
      eq(res.json.tombstoneCleared, false, '没有墓碑时重复处置返回 false')
      eq(readFileSync(join(connectorDir, 'audit.jsonl'), 'utf8').trim().split('\n').length, auditAfterClear.length,
        '幂等重复不得追加审计')
      ok(!existsSync(statePath), '墓碑保持已清除状态')
    } finally {
      if (previousToken === undefined) delete process.env.FLOW_STUDIO_TOKEN
      else process.env.FLOW_STUDIO_TOKEN = previousToken
      await new Promise(resolveClose => server.close(() => resolveClose()))
    }
  })

  // -------------------------------------------------------------------------
  // 12b. 0.13.10 实例收件箱：消息路由 / 正文 / 回复 / 工具一致性 / 只读
  // -------------------------------------------------------------------------
  await check('实例收件箱路由：live agent / 人工 / 未来节点 / 幂等 / 正文 / 回复 / 工具一致', async home => {
    const slow = makeSlowMessageAdapter()
    const sessionCalls = []
    const runtime = createBpmnRuntime({
      dir: join(home, 'flow-studio'),
      env: {},
      adapters: makeFakeAdapters(slow),
      inboxReplyTargets: {
        'operator-session': { kind: 'session', sessionId: 'approved-session' },
      },
      inboxSessionDeliver: async payload => {
        sessionCalls.push(payload)
        return { ok: true, deliveryUnknown: true }
      },
    })
    const url = new URL('http://localhost/')
    const saved = await runtime.handle({
      method: 'POST',
      parts: ['definitions'],
      url,
      body: { id: 'flow-inbox', name: '收件箱', xml: workflowXml('proc-inbox') },
    })
    eq(saved.status, 201, JSON.stringify(saved.body))

    // agent1 卡在慢适配器里：创建请求挂起，直到测试提交 finishGate。
    const creating = runtime.handle({
      method: 'POST',
      parts: ['instances'],
      url,
      body: { definitionId: 'flow-inbox' },
    })
    const started = await waitUntil(() => slow.calls.length > 0, 3000)
    eq(started, true, 'agent 已开始执行')
    const agentCtx = slow.calls[0].ctx
    const agentExecutionId = agentCtx.executionId
    ok(typeof agentExecutionId === 'string' && agentExecutionId !== '', '拿到 agent executionId')

    // 精确目标：live agent，投递并幂等。
    let res = await runtime.handle({
      method: 'POST',
      parts: ['instances', 'missing-instance', 'messages'],
      url,
      body: { messageId: 'm-x', target: { activityId: 'agent1', executionId: agentExecutionId }, text: 'x' },
    })
    eq(res.status, 404, '未知实例 404')
    const instanceId = String((await runtime.handle({
      method: 'GET', parts: ['instances'], url,
    })).body.instances[0].id)
    ok(instanceId.startsWith('i-'), '列表里能拿到实例 id')
    // adapter.start 已返回，但宿主的 live 登记是在 runAgentNode 的 onStart 里异步完成的：
    // 等它真登记后再投，避免测试自己制造竞态。
    const liveRegistered = await waitUntil(() => runtime.inbox.liveExecutions(instanceId)
      .some(entry => entry.executionId === agentExecutionId), 3000)
    eq(liveRegistered, true, 'agent execution 已登记 live')

    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'messages'],
      url,
      body: {
        messageId: 'm-live',
        target: { activityId: 'agent1', executionId: agentExecutionId },
        text: '请补充兼容性说明。',
        replyTargetId: 'operator-session',
      },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.message.status, 'injected', '发到 live agent')
    eq(res.body.message.delivery.deliveryUnknown, true, 'DSH 不承诺 exactly-once')
    eq(slow.delivered.length, 1, '适配器收到一次投递')
    eq(slow.delivered[0].message.messageId, 'm-live')

    const duplicate = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'messages'],
      url,
      body: {
        messageId: 'm-live',
        target: { activityId: 'agent1', executionId: agentExecutionId },
        text: '请补充兼容性说明。',
        replyTargetId: 'operator-session',
      },
    })
    eq(duplicate.status, 200)
    eq(duplicate.body.duplicate, true, '重复入站幂等')
    eq(slow.delivered.length, 1, '重复入站不重复投递')
    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'messages'],
      url,
      body: {
        messageId: 'm-live',
        target: { activityId: 'agent1', executionId: agentExecutionId },
        text: '不同内容',
      },
    })
    eq(res.status, 409, '同 id 不同内容 409')
    eq(res.body.code, 'MESSAGE_ID_CONFLICT')

    // 正文接口：短消息内联直接可读。
    res = await runtime.handle({
      method: 'GET', parts: ['instances', instanceId, 'messages', 'm-live', 'body'], url,
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.text, '请补充兼容性说明。')

    // 已结束 / 不存在的 execution：410。
    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'messages'],
      url,
      body: { messageId: 'm-gone', target: { activityId: 'agent1', executionId: 'exec-gone' }, text: 'x' },
    })
    eq(res.status, 410)
    eq(res.body.code, 'MESSAGE_TARGET_EXPIRED')

    await slow.finish()
    const created = await creating
    eq(created.status, 201, JSON.stringify(created.body))
    eq(created.body.status, 'ACTIVE', '继续走到人工任务')

    // 人工任务进入 wait：等收件箱 live 表登记后再投。
    const humanTask = (await runtime.handle({
      method: 'GET', parts: ['instances', instanceId, 'tasks'], url,
    })).body.tasks[0]
    ok(humanTask && humanTask.executionId, '人工任务有 executionId')
    await waitUntil(() => runtime.inbox.liveExecutions(instanceId)
      .some(entry => entry.kind === 'human' && entry.executionId === humanTask.executionId), 3000)

    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'messages'],
      url,
      body: {
        messageId: 'm-human',
        target: { activityId: 'human1', executionId: humanTask.executionId },
        text: '人工任务的讨论消息',
      },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.message.status, 'delivered', '人工任务可投递')
    eq(res.body.message.delivery.kind, 'human')

    // 未来节点：只排队，不投当前。
    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'messages'],
      url,
      body: { messageId: 'm-next', target: { activityId: 'agent1', delivery: 'nextActivation' }, text: '下一轮' },
    })
    eq(res.status, 200)
    eq(res.body.message.status, 'queued', '未来节点未激活前排队')

    // 带冒号的 messageId 走 URL 路径时由客户端 encode，运行时负责解码。
    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'messages'],
      url,
      body: { messageId: 'ext:42', target: { activityId: 'agent1', delivery: 'nextActivation' }, text: '冒号 id' },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    res = await runtime.handle({
      method: 'GET', parts: ['instances', instanceId, 'messages', 'ext%3A42', 'body'], url,
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.text, '冒号 id', '路径段解码后能读回正文')

    // 超 4 KiB：落盘 + 正文接口逐字节一致。
    const longText = `长正文：${'兼容性'.repeat(2000)}`
    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'messages'],
      url,
      body: { messageId: 'm-long', target: { activityId: 'human1', executionId: humanTask.executionId }, text: longText },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.message.body.kind, 'file')
    res = await runtime.handle({
      method: 'GET', parts: ['instances', instanceId, 'messages', 'm-long', 'body'], url,
    })
    eq(res.status, 200)
    eq(res.body.text, longText, '正文接口逐字节一致')

    // 回复：宿主白名单 session；任意 URL / 非白名单目标被拒。
    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'messages', 'm-live', 'replies'],
      url,
      body: { replyId: 'r-1', text: '已收到。' },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.delivered, true)
    eq(sessionCalls.length, 1)
    eq(sessionCalls[0].sessionId, 'approved-session')
    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'messages', 'm-live', 'replies'],
      url,
      body: { replyId: 'r-2', url: 'https://evil.example/hook', text: 'x' },
    })
    eq(res.status, 400)
    eq(res.body.code, 'MESSAGE_REPLY_TARGET_ARBITRARY', '任意 URL 被拒')
    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'messages', 'm-live', 'replies'],
      url,
      body: { replyId: 'r-3', targetId: 'evil-target', text: 'x' },
    })
    eq(res.status, 403, '非白名单目标 403')
    eq(res.body.code, 'MESSAGE_REPLY_TARGET_UNKNOWN')

    // 工具与路由一致性：未绑定工具写到同一个 inbox，GET 列表能看到。
    const tools = createInstanceTools({ runtime })
    const sendTool = tools.find(tool => tool.name === 'flow_instance_send_message')
    const replyTool = tools.find(tool => tool.name === 'flow_instance_reply')
    ok(sendTool && replyTool, '注册了 send / reply 工具')
    const toolResult = await sendTool.execute({
      instanceId,
      messageId: 'm-tool',
      target: { activityId: 'human1', executionId: humanTask.executionId },
      text: '工具投递',
    })
    eq(toolResult.ok, true, JSON.stringify(toolResult))
    eq(toolResult.message.status, 'delivered')
    res = await runtime.handle({
      method: 'GET', parts: ['instances', instanceId, 'messages'], url: new URL('http://localhost/?limit=100'),
    })
    eq(res.status, 200)
    const listed = res.body.messages.find(item => item.messageId === 'm-tool')
    ok(listed, '工具写入与路由列表一致')
    eq(listed.status, 'delivered')
    const replyResult = await replyTool.execute({
      instanceId,
      messageId: 'm-live',
      replyId: 'r-tool',
      text: '工具回复',
    })
    eq(replyResult.ok, true, JSON.stringify(replyResult))
    eq(replyResult.reply.status, 'delivered')
    eq(sessionCalls.length, 2)

    // 只读：新 runtime 读消息 / 正文不启动 runner。
    const runtimeB = createBpmnRuntime({
      dir: join(home, 'flow-studio'),
      env: {},
      adapters: makeFakeAdapters(),
    })
    eq(runtimeB._runners.size, 0, '新 runtime 没有 runner')
    res = await runtimeB.handle({
      method: 'GET', parts: ['instances', instanceId, 'messages'], url,
    })
    eq(res.status, 200)
    ok(res.body.messages.length >= 5)
    eq(runtimeB._runners.size, 0, 'GET messages 不启动 runner')
    res = await runtimeB.handle({
      method: 'GET', parts: ['instances', instanceId, 'messages', 'm-long', 'body'], url,
    })
    eq(res.status, 200)
    eq(runtimeB._runners.size, 0, 'GET body 不启动 runner')

    // 完成人工任务 → COMPLETED：拒绝新消息，但消息仍可读。
    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'tasks', 'human1', 'complete'],
      url,
      body: { payload: {} },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.status, 'COMPLETED')
    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'messages'],
      url,
      body: { messageId: 'm-after', target: { activityId: 'agent1', delivery: 'nextActivation' }, text: '终态消息' },
    })
    eq(res.status, 409, 'COMPLETED 拒绝新消息')
    eq(res.body.code, 'MESSAGE_INSTANCE_TERMINAL')
    res = await runtime.handle({
      method: 'GET', parts: ['instances', instanceId, 'messages'], url,
    })
    eq(res.status, 200)
    eq(res.body.messages.find(item => item.messageId === 'm-next').status, 'failed', '终态收尾把未投递消息标失败')
  })

  // -------------------------------------------------------------------------
  // 12c. 默认 session 回复：仅附件也要传递可读取引用，不能标成功却收到空文本
  // -------------------------------------------------------------------------
  await check('默认 session 回复：仅附件传递 path/sha256 引用，不静默丢内容', async home => {
    const { writeWorkspaceSnapshot } = await import('../src/instance-resources.js')
    const instancesRoot = join(home, 'instances')
    const instanceId = 'i-doc-reply'
    const workspace = join(home, 'workspace')
    mkdirSync(join(instancesRoot, instanceId), { recursive: true })
    mkdirSync(workspace, { recursive: true })
    const at = new Date().toISOString()
    writeFileSync(join(instancesRoot, instanceId, 'instance.json'), JSON.stringify({
      id: instanceId,
      definitionId: 'flow-doc',
      definitionVersion: 1,
      definitionHash: 'a'.repeat(64),
      status: 'ACTIVE',
      variables: {},
      result: null,
      artifacts: [],
      lastError: null,
      pendingTasks: [],
      revision: 1,
      eventCount: 0,
      lastSeq: 0,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      definitionSnapshot: 'definition.bpmn',
    }), 'utf8')
    writeFileSync(join(workspace, 'answer.md'), 'report content', 'utf8')
    await writeWorkspaceSnapshot({ instancesRoot, instanceId, snapshot: { effectiveRoot: workspace } })
    const received = []
    const runtime = createBpmnRuntime({
      dir: home,
      instancesRoot,
      // 默认 session 通道（不注入 inboxSessionDeliver）：从 ctx.agents 取 live 会话。
      ctx: { get: () => ({ get: () => ({ followup: message => received.push(message) }) }) },
      inboxReplyTargets: { dest: { kind: 'session', sessionId: 's' } },
    })
    try {
      await runtime.inbox.registerExecution({ instanceId, activityId: 'human', executionId: 'e', kind: 'human' })
      await runtime.inbox.acceptInstanceMessage({
        instanceId,
        messageId: 'm',
        target: { activityId: 'human', executionId: 'e' },
        text: 'request',
        replyTargetId: 'dest',
      })
      const res = await runtime.handle({
        method: 'POST',
        parts: ['instances', instanceId, 'messages', 'm', 'replies'],
        body: { replyId: 'doc', document: { path: 'answer.md' } },
      })
      eq(res.status, 200)
      eq(res.body.ok, true)
      eq(res.body.reply.status, 'delivered')
      eq(received.length, 1)
      const text = received[0].content[0].text
      ok(typeof text === 'string' && text.trim() !== '', 'delivered 的正文不能为空')
      ok(text.includes('answer.md'), '附件 path 进入会话正文（可读取引用）')
      ok(text.includes(res.body.reply.document.sha256), '附件 sha256 进入会话正文')
      ok(text.includes(String(res.body.reply.document.bytes)), '附件字节数进入会话正文')
      eq(received[0].source.meta.untrusted, true, '外部回复在 source.meta 标不可信')
      eq(received[0].source.flowStudio.documentPath, 'answer.md', '附件 path 也进 provenance')
    } finally {
      await runtime.dispose()
    }
  })

  // -------------------------------------------------------------------------
  // 12.9 0.14.4：挂起 / 恢复的并发与事实持久化加固
  // -------------------------------------------------------------------------

  await check('0.14.4 父探针改写：SUSPENDED 下 updateInstance(ACTIVE) 被拒；未完成事件提交让挂起 BUSY；晚到事件不能复活', async home => {
    const { runtime, url, instanceId } = await setupWaitingInstance(home)
    const instancesRoot = instStore.instancesDir(home)

    // 探针 A：挂起后一次无条件 updateInstance({status:'ACTIVE'}) 不得抹掉 SUSPENDED。
    let res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: 'probe' },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    const before = readInstanceJson(home, instanceId)
    await rejects(
      () => instStore.updateInstance(instanceId, { status: 'ACTIVE' }, { instancesRoot }),
      error => error.status === 409 && error.code === 'INSTANCE_SUSPENDED_IMMUTABLE',
      'store 层无条件 ACTIVE 写必须被拒（不能抹掉挂起）',
    )
    const afterRejected = readInstanceJson(home, instanceId)
    eq(afterRejected.status, 'SUSPENDED', '挂起仍是磁盘事实')
    eq(afterRejected.revision, before.revision, '被拒的写不涨 revision')
    eq(afterRejected.lastSeq, before.lastSeq, '被拒的写不分配 seq')

    // 恢复，进入探针 B。
    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: {},
    })
    eq(res.status, 200, JSON.stringify(res.body))
    const seqBefore = readInstanceJson(home, instanceId).lastSeq

    // 探针 B：截获「已出队」的事件写入任务，挂起必须看到未完成提交并 409。
    const originalEnqueue = runtime._enqueueEvent.bind(runtime)
    let captured = null
    runtime._enqueueEvent = (_instanceId, work) => {
      captured = work
      return Promise.resolve()
    }
    runtime._onRunnerEvent(instanceId, {
      type: 'activity/start', elementId: 'human1', activityId: 'exec-race-1', at: new Date().toISOString(),
    })
    runtime._enqueueEvent = originalEnqueue
    ok(typeof captured === 'function', '应截获到事件队列任务')

    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: 'race' },
    })
    eq(res.status, 409, JSON.stringify(res.body))
    eq(res.body.code, 'INSTANCE_SUSPEND_BUSY')
    const queueActivity = res.body.activities.find(item => item.kind === 'event-queue')
    ok(queueActivity !== undefined, 'activities[] 必须点名未完成的事件提交')
    ok(Number.isSafeInteger(queueActivity.pending) && queueActivity.pending >= 1, 'event-queue.pending 是未完成数')
    eq(readInstanceJson(home, instanceId).status, 'ACTIVE', 'BUSY 时不能改状态')

    // 放行队内任务：它按当时（ACTIVE）事实落盘，然后在 finally 里减计数。
    await captured()
    eq(readInstanceJson(home, instanceId).lastSeq, seqBefore + 1, '放行后事件正常落盘')

    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: 'race-2' },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    const seqAtSuspend = readInstanceJson(home, instanceId).lastSeq

    // 挂起成功后，真实事件桥入口收到一条晚到的推进事件：必须丢弃、记诊断、不复活。
    runtime._onRunnerEvent(instanceId, {
      type: 'activity/start', elementId: 'human1', activityId: 'exec-late', at: new Date().toISOString(),
    })
    await runtime._flushEvents(instanceId)
    const late = readInstanceJson(home, instanceId)
    eq(late.status, 'SUSPENDED', '晚到任务不得把状态写回 ACTIVE')
    eq(late.lastSeq, seqAtSuspend, '晚到任务不得追加事件')
    const lateEvents = await readEvents(runtime, url, instanceId)
    ok(!lateEvents.events.some(event => event.activityId === 'exec-late'), '晚到事件不能进事件流')
    const diagnostics = runtime._eventDiagnostics.get(instanceId) ?? []
    ok(diagnostics.some(item => item.reason === 'suspended' && item.type === 'activity/start'), '丢弃必须留下诊断')
  })

  await check('0.14.4 准备窗口：慢 _prepareInstanceWorkspace 期间 suspend 409 preparing；放行后创建成功并可完成', async home => {
    const runtime = createBpmnRuntime({ dir: join(home, 'flow-studio'), env: {}, adapters: makeFakeAdapters() })
    const url = new URL('http://localhost/')
    let res = await runtime.handle({
      method: 'POST',
      parts: ['definitions'],
      url,
      body: { id: 'flow-demo', name: '演示流程', xml: workflowXml('proc-prepare') },
    })
    eq(res.status, 201, JSON.stringify(res.body))

    const originalPrepare = runtime._prepareInstanceWorkspace.bind(runtime)
    let releasePrepare
    const gate = new Promise(resolveGate => { releasePrepare = resolveGate })
    let markPreparing
    const preparingStarted = new Promise(resolvePreparing => { markPreparing = resolvePreparing })
    runtime._prepareInstanceWorkspace = async (...args) => {
      markPreparing()
      await gate
      return await originalPrepare(...args)
    }

    const creating = runtime.handle({
      method: 'POST',
      parts: ['instances'],
      url,
      body: {
        definitionId: 'flow-demo',
        variables: { amount: 7 },
        workspace: { path: home, worktree: { mode: 'off' } },
      },
    })
    await preparingStarted
    const listed = await runtime.handle({ method: 'GET', parts: ['instances'], url })
    const instanceId = listed.body.instances.find(item => item.definitionId === 'flow-demo').id
    ok(typeof instanceId === 'string' && instanceId !== '', '准备中的实例已经可见')

    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: 'during-prepare' },
    })
    eq(res.status, 409, JSON.stringify(res.body))
    eq(res.body.code, 'INSTANCE_SUSPEND_BUSY')
    ok(res.body.activities.some(item => item.kind === 'preparing'), 'activities[] 必须点名准备窗口')
    eq(readInstanceJson(home, instanceId).status, 'ACTIVE', '准备期间不能被挂起')

    releasePrepare()
    const created = await creating
    eq(created.status, 201, JSON.stringify(created.body))
    eq(created.body.status, 'ACTIVE')
    const task = created.body.pendingTasks[0]
    ok(task, '准备放行后首次启动必须跑到人工任务')

    res = await runtime.handle({
      method: 'POST',
      parts: ['instances', instanceId, 'tasks', task.activityId, 'complete'],
      url,
      body: { payload: { approved: true } },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.status, 'COMPLETED', '准备窗口被正确保护后实例可用')
    const events = await readEvents(runtime, url, instanceId)
    eq(countType(events.events, 'instance/suspended'), 0, '被拒的挂起不能写事件')
  })

  await check('C2 准备阶段抛异常：实例收成 CANCELED + lastError；owner / preparing 归零；返回错误分支不回退', async home => {
    const runtime = createBpmnRuntime({ dir: join(home, 'flow-studio'), env: {}, adapters: makeFakeAdapters() })
    const url = new URL('http://localhost/')
    let res = await runtime.handle({
      method: 'POST',
      parts: ['definitions'],
      url,
      body: { id: 'flow-demo', name: '演示流程', xml: workflowXml('proc-prepare-throw') },
    })
    eq(res.status, 201, JSON.stringify(res.body))
    const body = {
      definitionId: 'flow-demo',
      variables: { amount: 7 },
      workspace: { path: home, worktree: { mode: 'off' } },
    }
    try {
      // 1) 准备函数**抛异常**（不是返回 {error}）：基线会留一个 ACTIVE 空壳。
      runtime._prepareInstanceWorkspace = async () => {
        throw new Error('准备探针抛异常')
      }
      res = await runtime.handle({ method: 'POST', parts: ['instances'], url, body })
      eq(res.status, 500, JSON.stringify(res.body))
      eq(res.body.ok, false)
      eq(res.body.code, 'BPMN_WORKSPACE_OPERATION_FAILED', '无 code 的异常收成统一工作区错误码')
      ok(String(res.body.error).includes('准备探针抛异常'), '响应保留原始原因')
      const thrownId = res.body.id
      ok(typeof thrownId === 'string' && thrownId !== '', '响应带回实例 id')
      const thrownRaw = readInstanceJson(home, thrownId)
      eq(thrownRaw.status, 'CANCELED', '准备抛异常必须收成 CANCELED（基线：实例留 ACTIVE）')
      eq(thrownRaw.lastError?.code, 'BPMN_WORKSPACE_OPERATION_FAILED')
      ok(String(thrownRaw.lastError?.message).includes('准备探针抛异常'), 'lastError 保留原因')
      eq(runtime._preparing.size, 0, 'preparing 计数归零')
      eq(runtime._ownedInstances.size, 0, 'owner 已交还')
      eq(existsSync(join(instStore.instancesDir(home), thrownId, 'owner.json')), false, 'owner.json 已释放')
      eq(runtime._runners.has(thrownId), false, '零派发')

      // 2) 返回错误分支（原有行为）不得改变：同样的响应形状 + CANCELED + lastError。
      runtime._prepareInstanceWorkspace = async () => ({
        workspace: null,
        error: { status: 400, code: 'BPMN_WORKSPACE_INVALID', message: '准备返回错误探针' },
      })
      res = await runtime.handle({ method: 'POST', parts: ['instances'], url, body })
      eq(res.status, 400, JSON.stringify(res.body))
      eq(res.body.ok, false)
      eq(res.body.code, 'BPMN_WORKSPACE_INVALID')
      ok(typeof res.body.id === 'string' && res.body.id !== '')
      const returnedRaw = readInstanceJson(home, res.body.id)
      eq(returnedRaw.status, 'CANCELED', '返回错误分支仍是 CANCELED')
      eq(returnedRaw.lastError?.code, 'BPMN_WORKSPACE_INVALID')
      eq(runtime._preparing.size, 0)
      eq(runtime._ownedInstances.size, 0)
    } finally {
      await runtime.dispose()
    }
  })

  await check('0.14.4 挂起期间超时：错误事实落盘、待办清空、error 恰好一条；resume 后 complete 明确 BLOCKED', async home => {
    const { runtime, url, instanceId } = await setupWaitingInstance(home, {
      FLOW_STUDIO_BPMN_ACTIVITY_TIMEOUT_MS: '500',
    })
    let res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: 'timeout-window' },
    })
    eq(res.status, 200, JSON.stringify(res.body))

    const recorded = await waitUntil(() => readInstanceJson(home, instanceId).lastError !== null, 4000)
    eq(recorded, true, '挂起期间发生的超时必须把 lastError 落盘')
    const raw = readInstanceJson(home, instanceId)
    eq(raw.status, 'SUSPENDED', '超时事实不改变挂起状态')
    eq(raw.lastError.code, 'BPMN_ACTIVITY_TIMEOUT')
    deep(raw.pendingTasks, [], '失效待办必须清空')
    const events = await readEvents(runtime, url, instanceId)
    eq(countType(events.events, 'error'), 1, '恰好一条 error 事件')
    ok(events.events.some(event => event.type === 'error' && event.error?.code === 'BPMN_ACTIVITY_TIMEOUT'))

    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: {},
    })
    eq(res.status, 200, JSON.stringify(res.body))
    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'tasks', 'human1', 'complete'], url, body: { payload: {} },
    })
    eq(res.status, 409, JSON.stringify(res.body))
    eq(res.body.code, 'BPMN_INSTANCE_BLOCKED', 'resume 只解除挂起，不伪造可执行待办')
  })

  await check('0.14.4/0.14.6 部分提交：事件分片写失败只认 store 的提交事实（契约在→200 committed/pending；不在→显式失败）', async home => {
    const { runtime, url, instanceId } = await setupWaitingInstance(home)
    const instancesRoot = instStore.instancesDir(home)
    let res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: 'commit-fault' },
    })
    eq(res.status, 200, JSON.stringify(res.body))

    const shard = join(instancesRoot, instanceId, 'events', 'process', '1.jsonl')
    ok(existsSync(shard), '挂起事件分片存在')
    const backup = readFileSync(shard)
    const seqBeforeResume = readInstanceJson(home, instanceId).lastSeq
    rmSync(shard, { force: true })
    mkdirSync(shard, { recursive: true })

    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: { reason: 'commit-fault' },
    })
    // 跨单元契约（U3，`appendInstanceEvents` 在「元数据已提交、事件正文追加失败」时抛
    // `InstanceError{committed:true, eventLogPending:true, lastSeq}`）：
    //   - 契约在：只凭 error.committed 返回 200 + committed/pending + lastSeq；
    //   - 契约不在（本 worktree 的基线 store）：运行时不拿「磁盘最终状态等于目标状态」
    //     替 store 认领提交（复审 NEW-2），显式 500，绝不 200/committed。
    if (res.status === 200) {
      eq(res.body.committed, true, '状态已提交必须如实返回 committed:true')
      eq(res.body.eventLogPending, true, '事件正文缺失必须标 eventLogPending')
      eq(res.body.lastSeq, seqBeforeResume + 1, 'lastSeq 取自 store 报告的本次提交事实')
    } else {
      eq(res.status, 500, 'store 未报告本次提交时不得谎报 200')
      eq(res.body.committed, undefined, '没有 store 提交事实就不能返回 committed')
      eq(res.body.ok, false)
    }
    const committed = readInstanceJson(home, instanceId)
    eq(committed.status, 'ACTIVE', '磁盘状态以最后一次成功写入为准')
    eq(committed.lastSeq, seqBeforeResume + 1, 'seq 已分配（事件行缺失）')

    // 修复分片路径后重试：状态已经是 ACTIVE，不再写第二条 resume 事件。
    rmSync(shard, { recursive: true, force: true })
    writeFileSync(shard, backup, { mode: 0o600 })
    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: {},
    })
    eq(res.status, 409, JSON.stringify(res.body))
    eq(res.body.code, 'INSTANCE_NOT_SUSPENDED')
    eq(readInstanceJson(home, instanceId).lastSeq, committed.lastSeq, '重试不重复分配 / 不重复写事件')

    const events = await readEvents(runtime, url, instanceId)
    eq(countType(events.events, 'instance/resumed'), 0, '缺失的 resume 事件不能被重试补写')
    eq(events.lastSeq, seqBeforeResume, '读侧游标只到可见事件')
    eq(events.eventLogGap.allocated, committed.lastSeq, 'eventLogGap 暴露已分配未可见')
    eq(events.eventLogGap.visible, seqBeforeResume)

    // 实例仍可用：状态 ACTIVE、runner 仍在等待，人工任务可以完成。
    res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'tasks', 'human1', 'complete'], url, body: { payload: { approved: true } },
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(res.body.status, 'COMPLETED')
  })

  await check('0.14.4 读取游标：分配了 seq 但事件行未落盘时 lastSeq 不越过可见事件，并带 eventLogGap', async home => {
    const { runtime, url, instanceId } = await setupWaitingInstance(home)
    const instancesRoot = instStore.instancesDir(home)
    const beforeEvents = await instStore.readInstanceEvents(instanceId, { instancesRoot })
    const visible = beforeEvents.reduce((max, event) => (Number.isSafeInteger(event.seq) ? Math.max(max, event.seq) : max), 0)
    const beforeRaw = readInstanceJson(home, instanceId)
    eq(visible, beforeRaw.lastSeq, '前置条件：当前没有缺口')

    // 用真实 store 写入路径制造「元数据已分配、事件行写不进」的窗口。
    const blockedShard = join(instancesRoot, instanceId, 'events', 'cursor-probe', '1.jsonl')
    mkdirSync(blockedShard, { recursive: true })
    await rejects(
      () => instStore.appendInstanceEvents(instanceId, 'cursor-probe', 1, [{
        type: 'activity/wait', at: new Date().toISOString(),
      }], { instancesRoot }),
      () => true,
      '故障注入：分片路径被目录占住 → 事件行写入失败',
    )
    const afterRaw = readInstanceJson(home, instanceId)
    eq(afterRaw.lastSeq, visible + 1, '元数据已经分配了 seq（模拟两阶段写入窗口）')

    const res = await readEvents(runtime, url, instanceId)
    eq(res.lastSeq, visible, 'GET events 的 lastSeq 必须是可见事件的最大 seq')
    eq(res.eventLogGap.allocated, visible + 1)
    eq(res.eventLogGap.visible, visible)
    deep(res.eventLogGap.missing, [visible + 1])
  })

  await check('0.14.4 stop/suspend 交错：最终 CANCELED、无挂起事件、resume 409，且无挂起闩残留', async home => {
    const { runtime, url, instanceId } = await setupWaitingInstance(home)
    const originalBusy = runtime._suspendBusy.bind(runtime)
    let calls = 0
    let releaseSecond
    const gate = new Promise(resolveGate => { releaseSecond = resolveGate })
    let markSecond
    const secondStarted = new Promise(resolveSecond => { markSecond = resolveSecond })
    runtime._suspendBusy = async instance => {
      calls += 1
      if (calls === 2) {
        markSecond()
        await gate
      }
      return await originalBusy(instance)
    }

    const suspending = runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: 'stop-race' },
    })
    await secondStarted
    const stopped = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'stop'], url })
    eq(stopped.status, 200, JSON.stringify(stopped.body))
    eq(stopped.body.status, 'CANCELED')
    releaseSecond()

    const suspendResult = await suspending
    eq(suspendResult.status, 409, JSON.stringify(suspendResult.body))
    eq(readInstanceJson(home, instanceId).status, 'CANCELED', '终态不可逆')
    const events = await readEvents(runtime, url, instanceId)
    eq(countType(events.events, 'instance/suspended'), 0, 'stop 赢后不得残留挂起事件')
    ok(runtime._suspended === undefined, '内存挂起闩已删除（不再有集合残留）')
    eq(runtime._preparing.size, 0, '准备计数无残留')

    const resumed = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: {},
    })
    eq(resumed.status, 409)
    eq(resumed.body.code, 'BPMN_INSTANCE_TERMINAL')
  })

  await check('0.14.4 双进程所有权：A 持 owner 时 B suspend 409（kind owner），B 直写状态被拒；A 退出后 owner 可接管', async home => {
    const dataDir = join(home, 'flow-studio')
    const instancesRoot = instStore.instancesDir(home)
    const peer = startPeer(dataDir, 'slow')
    let peerPid = null
    let instanceId = null
    try {
      const ready = await peer.ready
      instanceId = ready.instanceId
      peerPid = peer.child.pid
      eq(ready.mode, 'slow')

      const runtimeB = createBpmnRuntime({ dir: dataDir, env: {}, adapters: makeFakeAdapters() })
      const url = new URL('http://localhost/')
      try {
        // peer 的 `ready` 在 adapter.start 里就发了，启动事件可能还没 flush 完：先等它落盘，
        // 否则 eventsBefore 会读到 0 条，把 peer 自己的 wait 事件误当成「被拒的挂起写了事件」。
        let eventsBefore = []
        const eventsDeadline = Date.now() + 5000
        while (Date.now() < eventsDeadline) {
          eventsBefore = (await instStore.readInstanceEvents(instanceId, { instancesRoot })) ?? []
          if (eventsBefore.some(event => event.type === 'activity/start')) break
          await sleep(10)
        }
        ok(eventsBefore.some(event => event.type === 'activity/start'), '前置条件：peer 的 activity/start 已落盘')
        const res = await runtimeB.handle({
          method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: 'cross-process' },
        })
        eq(res.status, 409, JSON.stringify(res.body))
        eq(res.body.code, 'INSTANCE_SUSPEND_BUSY')
        const ownerActivity = res.body.activities.find(item => item.kind === 'owner')
        ok(ownerActivity !== undefined, 'activities[] 必须点名外部执行所有权')
        eq(ownerActivity.pid, peerPid, 'owner.pid 是子进程')
        eq(ownerActivity.state, 'alive')
        ok(typeof ownerActivity.since === 'string' && ownerActivity.since !== '', 'owner.since 可用于排障')

        const eventsAfter = (await instStore.readInstanceEvents(instanceId, { instancesRoot })) ?? []
        // 只比「挂起事件」：peer 的 agent 仍在跑，期间可能继续落事件（agent/invocation 等），
        // 拿总条数判定会把 peer 的正常事件误判成被拒挂起的副作用。
        eq(countType(eventsBefore, 'instance/suspended'), 0, '前置条件：还没有挂起事件')
        eq(countType(eventsAfter, 'instance/suspended'), 0, '被拒的挂起不能写挂起事件')
        eq(readInstanceJson(home, instanceId).status, 'ACTIVE')

        // 绕过生命周期路由直接抢状态：必须被 store 拒绝。
        await rejects(
          () => instStore.updateInstance(instanceId, { status: 'SUSPENDED' }, { instancesRoot }),
          error => error.status === 409 && error.code === 'INSTANCE_LIFECYCLE_USE_ROUTE',
          'B 直接改状态必须失败（状态迁移只走生命周期路由）',
        )

        // 跨进程所有权同样阻止 B 懒恢复出第二个 runner。
        const detail = await runtimeB.handle({ method: 'GET', parts: ['instances', instanceId], url })
        eq(detail.status, 200, JSON.stringify(detail.body))
        eq(detail.body.recovery?.code, 'BPMN_INSTANCE_ACTIVE_ELSEWHERE')
        eq(runtimeB._runners.size, 0, 'B 不得为别人持有的实例创建 runner')
      } finally {
        await runtimeB.dispose()
      }
    } finally {
      // 强杀：模拟执行进程崩溃（owner.json 留着，但 pid 已经不在）。
      await peer.stop({ kill: true })
    }

    eq(await waitUntil(() => !pidIsAlive(peerPid), 3000), true, '子进程已经退出')

    // owner 记录还在但 pid 已不在：state=gone，允许接管（不按 TTL，按可验证事实）。
    const runtimeC = createBpmnRuntime({ dir: dataDir, env: {}, adapters: makeFakeAdapters() })
    const url = new URL('http://localhost/')
    try {
      const res = await runtimeC.handle({
        method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: 'takeover' },
      })
      eq(res.status, 200, JSON.stringify(res.body))
      eq(res.body.status, 'SUSPENDED', '原 owner 进程确认退出后可以挂起')
    } finally {
      await runtimeC.dispose()
    }
  })

  await check('0.14.4 双进程 resume 可见性：A 自挂起、B resume、A 下一次读不再 SUSPENDED 且能 complete', async home => {
    const dataDir = join(home, 'flow-studio')
    const peer = startPeer(dataDir, 'wait')
    try {
      const ready = await peer.ready
      const instanceId = ready.instanceId
      ok(typeof ready.executionId === 'string' && ready.executionId !== '', 'ready 带人工任务 executionId')

      const suspended = await peer.send('suspend', { instanceId, reason: 'peer-suspend' })
      eq(suspended.status, 200, JSON.stringify(suspended.body))
      eq(suspended.body.status, 'SUSPENDED')

      // B（父进程里的另一个 runtime）resume：只翻磁盘事实，不创建 runner。
      const runtimeB = createBpmnRuntime({ dir: dataDir, env: {}, adapters: makeFakeAdapters() })
      const url = new URL('http://localhost/')
      try {
        const resumed = await runtimeB.handle({
          method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: { reason: 'by-parent' },
        })
        eq(resumed.status, 200, JSON.stringify(resumed.body))
        eq(resumed.body.status, 'ACTIVE')
        eq(runtimeB._runners.size, 0, 'resume 本身不建 runner')
      } finally {
        await runtimeB.dispose()
      }

      // A 的下一次读必须只认磁盘 ACTIVE，不能被自己旧的挂起状态覆盖。
      const got = await peer.send('get', { instanceId })
      eq(got.status, 200, JSON.stringify(got.body))
      eq(got.body.status, 'ACTIVE', 'A 读到 B 写入的 ACTIVE')
      ok(got.body.recovery?.code !== 'BPMN_STATE_SUSPENDED', 'A 不得再报 BPMN_STATE_SUSPENDED')
      eq(got.body.lastError ?? null, null, '这里没有错误事实')

      const completed = await peer.send('complete', {
        instanceId,
        activityId: 'human1',
        executionId: ready.executionId,
        payload: { approved: true },
      })
      eq(completed.status, 200, JSON.stringify(completed.body))
      eq(completed.body.status, 'COMPLETED', 'A 在 B resume 之后可以完成人工任务')

      const events = await peer.send('events', { instanceId })
      eq(events.status, 200)
      eq(countType(events.body.events, 'instance/suspended'), 1)
      eq(countType(events.body.events, 'instance/resumed'), 1)
      eq(countType(events.body.events, 'activity/wait'), 1, '跨进程 resume 不得重放 wait')
    } finally {
      await peer.stop()
    }
  })

  // -------------------------------------------------------------------------
  // 12.6 0.14.6 所有权 / 准入 / 提交事实（复审 0145 的 NEW-1 / NEW-3 / NEW-2 残余）
  // -------------------------------------------------------------------------
  await check('0.14.6 NEW-3：executionFailure 落盘后缓存 runner 不得继续使用（complete 409 BLOCKED）', async home => {
    const { runtime, url, instanceId } = await setupWaitingInstance(home)
    const instancesRoot = instStore.instancesDir(home)
    eq(runtime._runners.size, 1, '前置条件：waiting runner 在内存缓存里')
    await instStore.recordExecutionFailure(instanceId, {
      instancesRoot,
      lastError: { code: 'BPMN_PROBE_FAILURE', message: 'probe: 已确认失败' },
    })
    eq(readInstanceJson(home, instanceId).status, 'ACTIVE', '失败事实不改实例状态')
    const res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'tasks', 'human1', 'complete'], url, body: { payload: {} },
    })
    eq(res.status, 409, JSON.stringify(res.body))
    eq(res.body.code, 'BPMN_INSTANCE_BLOCKED', 'NEW-3：失败事实优先于缓存 runner')
    eq(res.body.recoveryCode, 'BPMN_PROBE_FAILURE')
    eq(runtime._runners.size, 0, 'NEW-3：已确认失败的 runner 不能再当缓存')
    eq(runtime._ownedInstances.size, 0, '没有 runner 就不占所有权')
  })

  await check('0.14.6 MAJOR-3 契约：挂起期间超时 + 冷恢复 → 409 BPMN_INSTANCE_BLOCKED + recoveryCode', async home => {
    const { runtime, url, instanceId } = await setupWaitingInstance(home, {
      FLOW_STUDIO_BPMN_ACTIVITY_TIMEOUT_MS: '300',
    })
    let res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: {},
    })
    eq(res.status, 200, JSON.stringify(res.body))
    eq(await waitUntil(() => readInstanceJson(home, instanceId).lastError !== null, 4000), true, '超时事实已落盘')
    // 原 owner 退出（dispose 释放所有权）后由新 runtime 冷恢复。
    await runtime.dispose()
    const runtimeB = createBpmnRuntime({ dir: join(home, 'flow-studio'), env: {}, adapters: makeFakeAdapters() })
    try {
      res = await runtimeB.handle({ method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: {} })
      eq(res.status, 200, JSON.stringify(res.body))
      res = await runtimeB.handle({
        method: 'POST', parts: ['instances', instanceId, 'tasks', 'human1', 'complete'], url, body: { payload: {} },
      })
      eq(res.status, 409, JSON.stringify(res.body))
      eq(res.body.code, 'BPMN_INSTANCE_BLOCKED', '冷恢复与热 runner 同口径（复审 MAJOR-3 残余）')
      eq(res.body.recoveryCode, 'BPMN_ACTIVITY_TIMEOUT', 'recoveryCode 保留失败码')
    } finally {
      await runtimeB.dispose()
    }
  })

  await check('0.14.6 NEW-2：生命周期 200 只认 store 的本次提交事实，不拿磁盘状态替别人认领', async home => {
    const { runtime, url, instanceId } = await setupWaitingInstance(home)
    let res = await runtime.handle({
      method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: {},
    })
    eq(res.status, 200, JSON.stringify(res.body))
    const original = runtime._appendLifecycleEvent.bind(runtime)
    try {
      // A) 跨单元契约（U3 已冻结，commit 5ff4292）：store 报「元数据已提交、事件正文追加失败」
      //    → `InstanceError(500,'INSTANCE_EVENT_APPEND_FAILED',{committed:true,eventLogPending:true,
      //    firstSeq,lastSeq,status,revision,activityId,attempt,eventLogError})` → 必须如实 200。
      runtime._appendLifecycleEvent = async () => {
        const error = new Error('injected: metadata committed, event body append failed')
        Object.assign(error, {
          code: 'INSTANCE_EVENT_APPEND_FAILED',
          committed: true,
          eventLogPending: true,
          firstSeq: 4242,
          lastSeq: 4242,
          status: 'ACTIVE',
          revision: 100,
          activityId: 'process',
          attempt: 1,
          eventLogError: 'EISDIR',
        })
        throw error
      }
      res = await runtime.handle({
        method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: { reason: 'injected-contract' },
      })
      eq(res.status, 200, JSON.stringify(res.body))
      eq(res.body.committed, true)
      eq(res.body.eventLogPending, true)
      eq(res.body.lastSeq, 4242, 'lastSeq 来自 store 报告的本次提交')
      eq(res.body.reason, 'injected-contract')
      eq(readInstanceJson(home, instanceId).status, 'SUSPENDED', '注入的「提交」没写盘：证明 200 不是读磁盘推出来的')

      // B) NEW-2 反例：别的请求提交了同一次迁移，本请求失败且没有 committed 事实 →
      // 磁盘状态恰好等于目标，也绝不能 200（旧实现会把它认成自己的提交）。
      runtime._appendLifecycleEvent = async (id, event, options) => {
        // 模拟「另一个请求提交了同一次迁移」。
        await original(id, event, options)
        // 本请求的元数据没写成：store 契约是 committed:false（INSTANCE_METADATA_WRITE_FAILED）。
        const error = new Error('injected: 本请求的元数据写入失败（committed:false）')
        Object.assign(error, {
          code: 'INSTANCE_METADATA_WRITE_FAILED',
          committed: false,
          eventLogPending: false,
          lastSeq: readInstanceJson(home, instanceId).lastSeq - 1,
        })
        throw error
      }
      res = await runtime.handle({
        method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: { reason: 'A-not-committed' },
      })
      eq(res.status, 500, JSON.stringify(res.body))
      eq(res.body.committed, undefined, '没有本次提交事实就不能返回 committed')
      eq(readInstanceJson(home, instanceId).status, 'ACTIVE', '磁盘已是目标状态（那是对端请求的提交）')
    } finally {
      runtime._appendLifecycleEvent = original
    }
    // 恢复真实路径：状态已是 ACTIVE，resume 409 且不重复写事件。
    const lastSeq = readInstanceJson(home, instanceId).lastSeq
    res = await runtime.handle({ method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: {} })
    eq(res.status, 409, JSON.stringify(res.body))
    eq(res.body.code, 'INSTANCE_NOT_SUSPENDED')
    eq(readInstanceJson(home, instanceId).lastSeq, lastSeq, '失败请求没有留下 seq 空洞')
  })

  await check('0.14.6 MAJOR-1 残余：派发前复查磁盘 SUSPENDED → 零派发、摘掉 runner、409 INSTANCE_SUSPENDED', async home => {
    const dir = join(home, 'flow-studio')
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="defs-admission" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-admission" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:userTask id="human1"/>
    <bpmn:serviceTask id="agent1"><bpmn:extensionElements><fs:node nodeType="agent" adapter="dsh"></fs:node></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="human1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="human1" targetRef="agent1"/>
    <bpmn:sequenceFlow id="f3" sourceRef="agent1" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
    const adapter = makeFakeAdapter()
    const runtimeA = createBpmnRuntime({ dir, env: {}, adapters: makeFakeAdapters(adapter) })
    const url = new URL('http://localhost/')
    const runtimeB = createBpmnRuntime({ dir, env: {}, adapters: makeFakeAdapters() })
    try {
      let res = await runtimeA.handle({ method: 'POST', parts: ['definitions'], url, body: { id: 'flow-admission', xml } })
      eq(res.status, 201, JSON.stringify(res.body))
      res = await runtimeA.handle({ method: 'POST', parts: ['instances'], url, body: { definitionId: 'flow-admission' } })
      eq(res.status, 201, JSON.stringify(res.body))
      const instanceId = res.body.id
      eq(adapter.calls.length, 0, '前置条件：agent1 还没派发')
      eq(runtimeA._runners.size, 1, '前置条件：waiting runner 在 A 的缓存里')

      // 让 A 的 complete 在「取到缓存 runner（入口已读 ACTIVE）」与「真正派发」之间停下：
      // 这段时间里同进程另一个 runtime 提交挂起（owner 是同 pid，不算 foreign）。
      let markEnsure
      const ensureReached = new Promise(resolveReached => { markEnsure = resolveReached })
      let releaseSuspend
      const suspendGate = new Promise(resolveGate => { releaseSuspend = resolveGate })
      const originalEnsure = runtimeA._ensureRunner.bind(runtimeA)
      runtimeA._ensureRunner = async instance => {
        const ensured = await originalEnsure(instance)
        markEnsure()
        await suspendGate
        return ensured
      }
      const completing = runtimeA.handle({
        method: 'POST', parts: ['instances', instanceId, 'tasks', 'human1', 'complete'], url, body: { payload: {} },
      })
      await ensureReached
      res = await runtimeB.handle({
        method: 'POST', parts: ['instances', instanceId, 'suspend'], url, body: { reason: 'hot-suspend' },
      })
      eq(res.status, 200, JSON.stringify(res.body))
      eq(readInstanceJson(home, instanceId).status, 'SUSPENDED')
      releaseSuspend()
      res = await completing
      eq(res.status, 409, JSON.stringify(res.body))
      eq(res.body.code, 'INSTANCE_SUSPENDED', '真正派发之前必须发现磁盘挂起')
      eq(adapter.calls.length, 0, 'MAJOR-1：零派发')
      eq(runtimeA._runners.size, 0, 'MAJOR-1：已恢复 / 缓存的 runner 收回，不再当缓存')
      eq(readInstanceJson(home, instanceId).pendingTasks.length, 1, '磁盘待办保持不变')

      // resume 之后同一 runtime 重新取得准入并正常完成（一次派发）。
      res = await runtimeB.handle({ method: 'POST', parts: ['instances', instanceId, 'resume'], url, body: {} })
      eq(res.status, 200, JSON.stringify(res.body))
      res = await runtimeA.handle({
        method: 'POST', parts: ['instances', instanceId, 'tasks', 'human1', 'complete'], url, body: { payload: {} },
      })
      eq(res.status, 200, JSON.stringify(res.body))
      eq(res.body.status, 'COMPLETED')
      eq(adapter.calls.length, 1, 'resume 后正常派发一次')
      eq(readInstanceJson(home, instanceId).status, 'COMPLETED')
    } finally {
      await runtimeB.dispose()
      await runtimeA.dispose()
    }
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
