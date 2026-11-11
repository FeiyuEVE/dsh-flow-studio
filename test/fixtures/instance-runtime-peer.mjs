#!/usr/bin/env node
/**
 * 真正的「另一个进程」BPMN runtime 对端（0.14.4 双进程测试 fixture）。
 *
 * 用法：`node test/fixtures/instance-runtime-peer.mjs <flowStudioDir> [wait|slow]`
 *
 *   1. 建定义 `flow-peer` 并启动一个实例；
 *   2. 在 stdout 打一行 `{"event":"ready", instanceId, executionId, mode}`；
 *   3. 从 stdin 逐行读 JSON 命令，执行 `runtime.handle()` 后回一行
 *      `{"id": <命令 id>, "status": <httpStatus>, "body": <响应体>}`：
 *        - `get` / `events`：只读
 *        - `suspend` / `resume`：生命周期（args.reason 可选）
 *        - `complete`：完成人工任务（args.activityId / executionId / payload）
 *        - `finishAgent`：slow 模式下放行 agent（让它推进到人工等待点）
 *        - `exit`：dispose 后退出
 *
 * `wait` 模式：实例直接停在 `human1`（人工等待），runner 常驻并持有执行所有权。
 * `slow` 模式：`agent1` 的 adapter 停在 `exited` Promise 上，进程活着、runner 在跑、
 * 执行所有权已登记——用来验证另一个进程不能替它挂起。
 *
 * 本文件只被测试用；不连网络、不跑真实 adapter（用进程内假 adapter）。
 */

import readline from 'node:readline'

const { createBpmnRuntime } = await import('../../src/bpmn-runtime.js')

const dataDir = process.argv[2]
const mode = process.argv[3] === 'slow' ? 'slow' : 'wait'
if (typeof dataDir !== 'string' || dataDir === '') {
  process.stderr.write('usage: instance-runtime-peer.mjs <flowStudioDir> [wait|slow]\n')
  process.exit(2)
}

const url = new URL('http://localhost/')

const WAIT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="defs-peer" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-peer" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:userTask id="human1" name="人工审批"/>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="human1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="human1" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`

const SLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="defs-peer-agent" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-peer-agent" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="agent1" name="慢节点">
      <bpmn:extensionElements>
        <fs:node nodeType="agent" adapter="dsh"></fs:node>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:userTask id="human1"/>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="agent1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="agent1" targetRef="human1"/>
    <bpmn:sequenceFlow id="f3" sourceRef="human1" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`

let pendingGate = null
let resolveExited = null

const immediateAdapter = {
  id: 'dsh',
  async probe() {
    return { version: 'peer-stub', helpDigest: 'peer-stub' }
  },
  capabilities() {
    return { finishTool: 'native', hooks: { 'turn.stop': 'emulated' } }
  },
  async start(request) {
    const submitted = await request.finishGate.submit({
      variables: { ok: true },
      documents: [],
      summary: 'peer-agent-done',
    })
    return {
      exited: Promise.resolve({ ok: true, record: submitted.record, usage: { input: 1, output: 1, total: 2 } }),
    }
  },
  async cancel() {},
  async dispose() {},
}

const slowAdapter = {
  id: 'dsh',
  async probe() {
    return { version: 'peer-stub', helpDigest: 'peer-stub' }
  },
  capabilities() {
    return { finishTool: 'native', hooks: { 'turn.stop': 'emulated' } }
  },
  async start(request) {
    pendingGate = request.finishGate
    return { exited: new Promise(resolve => { resolveExited = resolve }) }
  },
  async cancel() {},
  async dispose() {},
}

const adapter = mode === 'slow' ? slowAdapter : immediateAdapter
const adapters = {
  get(id) {
    return id === adapter.id ? adapter : undefined
  },
  list() {
    return [adapter]
  },
}

const runtime = createBpmnRuntime({ dir: dataDir, env: {}, adapters })

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ id, status: result.status, body: result.body })}\n`)
}

async function handle(command, args = {}) {
  const call = (method, parts, body) => runtime.handle({
    method,
    parts,
    url,
    ...(body === undefined ? {} : { body }),
  })
  if (command === 'get') return await call('GET', ['instances', args.instanceId])
  if (command === 'events') return await call('GET', ['instances', args.instanceId, 'events'])
  if (command === 'suspend') {
    return await call('POST', ['instances', args.instanceId, 'suspend'], args.reason === undefined ? {} : { reason: args.reason })
  }
  if (command === 'resume') {
    return await call('POST', ['instances', args.instanceId, 'resume'], args.reason === undefined ? {} : { reason: args.reason })
  }
  if (command === 'complete') {
    return await call('POST', ['instances', args.instanceId, 'tasks', args.activityId ?? 'human1', 'complete'], {
      ...(args.payload === undefined ? {} : { payload: args.payload }),
      ...(args.executionId === undefined ? {} : { executionId: args.executionId }),
    })
  }
  if (command === 'finishAgent') {
    if (pendingGate === null || resolveExited === null) {
      return { status: 409, body: { ok: false, code: 'PEER_AGENT_NOT_RUNNING', error: 'agent 尚未开始' } }
    }
    const submitted = await pendingGate.submit({
      variables: { ok: true },
      documents: [],
      summary: 'peer-agent-done',
    })
    resolveExited({ ok: true, record: submitted.record })
    return await creatingRequest
  }
  return { status: 400, body: { ok: false, code: 'PEER_COMMAND_UNKNOWN', error: `未知命令 ${command}` } }
}

let creatingRequest = null

async function bootstrap() {
  // 每个对端进程一个唯一 definitionId：同一个数据根上可能有多个 peer / 历史实例，
  // 不能靠「列表第一个」猜自己刚建的那个。
  const definitionId = mode === 'slow' ? `flow-peer-agent-${process.pid}` : `flow-peer-${process.pid}`
  const saved = await runtime.handle({
    method: 'POST',
    parts: ['definitions'],
    url,
    body: { id: definitionId, name: 'peer', xml: mode === 'slow' ? SLOW_XML : WAIT_XML },
  })
  if (saved.status !== 201) {
    throw new Error(`peer 定义保存失败：${saved.status} ${JSON.stringify(saved.body)}`)
  }
  const created = runtime.handle({
    method: 'POST',
    parts: ['instances'],
    url,
    body: { definitionId },
  })
  creatingRequest = created
  if (mode === 'slow') {
    // 创建请求会卡在慢 agent 里：拿 id 要用列表。
    let instanceId = null
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && instanceId === null) {
      const listed = await runtime.handle({ method: 'GET', parts: ['instances'], url })
      const own = Array.isArray(listed.body?.instances)
        ? listed.body.instances.filter(item => item.definitionId === definitionId)
        : []
      const first = own[0]
      if (first !== undefined && first !== null) instanceId = first.id
      else await new Promise(resolveSleep => setTimeout(resolveSleep, 10))
    }
    if (instanceId === null) throw new Error('peer 实例未出现')
    // 实例可见 ≠ agent 已派发：再等 adapter.start 真的被调用（此时 owner.json 已登记）。
    const startDeadline = Date.now() + 10_000
    while (Date.now() < startDeadline && pendingGate === null) {
      await new Promise(resolveSleep => setTimeout(resolveSleep, 10))
    }
    if (pendingGate === null) throw new Error('peer 的慢 agent 未开始')
    return { instanceId, executionId: null }
  }
  const result = await created
  if (result.status !== 201) {
    throw new Error(`peer 实例创建失败：${result.status} ${JSON.stringify(result.body)}`)
  }
  const pending = Array.isArray(result.body.pendingTasks) ? result.body.pendingTasks[0] : null
  return { instanceId: result.body.id, executionId: pending?.executionId ?? null }
}

const rl = readline.createInterface({ input: process.stdin })

async function main() {
  const info = await bootstrap()
  process.stdout.write(`${JSON.stringify({ event: 'ready', mode, ...info })}\n`)
  for await (const line of rl) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      process.stderr.write(`peer 收到非法 JSON：${trimmed}\n`)
      continue
    }
    if (message.cmd === 'exit') {
      await runtime.dispose()
      rl.close()
      process.exit(0)
    }
    try {
      const result = await handle(message.cmd, message.args)
      reply(message.id, result)
    } catch (error) {
      reply(message.id, {
        status: 500,
        body: { ok: false, code: error?.code ?? 'PEER_COMMAND_FAILED', error: String(error?.message ?? error) },
      })
    }
  }
  await runtime.dispose()
}

await main()
