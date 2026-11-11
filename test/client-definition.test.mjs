#!/usr/bin/env node
/**
 * 定义侧客户端自检（0.13.3）：
 * - definitions/instances 新 API 契约（URL / 方法 / 请求体 / 错误结构）；
 * - `definition-state`：版本钉住、运行必须显式 definitionVersion、dirty 语义；
 * - 保存队列：去抖、保存顺序、乱序响应丢弃、失败保 dirty；
 * - 三个初始模板都能被 `parseBpmn()` 解析通过并带 DI。
 *
 * 不发真实请求：fetch 用桩替换；模板解析直接 import 服务端解析器。
 * 运行：node test/client-definition.test.mjs
 */

import assert from 'node:assert/strict'

import { parseBpmn } from '../src/bpmn-parse.js'
import {
  api, definitionPath, definitionsPath, instanceDefinitionPath, instanceEventsPath, instancePath,
  instanceTasksPath, instancesPath, completeTaskPath, resumeInstancePath, stopInstancePath,
  suspendInstancePath,
} from '../src/client/api.js'
import { createDefinitionState } from '../src/client/definition-state.js'
import { createEditRevision, createSaveQueue } from '../src/client/bpmn-state.js'
import { BPMN_TEMPLATES, getTemplate, listTemplates, templateXml } from '../src/client/templates.js'

let checks = 0
let assertions = 0

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
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

/** 用桩 fetch 跑一段：handler(url, init) 返回 Response 形状。 */
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

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 假定时器：只用于保存队列的去抖断言。 */
function fakeTimer() {
  let now = 0
  let seq = 0
  const queue = new Map()
  return {
    now: () => now,
    pending: () => queue.size,
    setTimeout(fn, ms) {
      const id = ++seq
      queue.set(id, { at: now + Math.max(0, Number(ms) || 0), fn })
      return id
    },
    clearTimeout(id) { queue.delete(id) },
    advance(ms) {
      const target = now + Math.max(0, Number(ms) || 0)
      for (;;) {
        let dueId = 0
        let due = null
        for (const [id, item] of queue) {
          if (item.at > target) continue
          if (!due || item.at < due.at || (item.at === due.at && id < dueId)) {
            dueId = id
            due = item
          }
        }
        if (!due) break
        queue.delete(dueId)
        now = due.at
        due.fn()
      }
      now = target
    },
  }
}

console.log('client-definition')

await check('新 API 路径：definitions / instances 契约，不再拼旧 /flows、/runs', () => {
  eq(definitionsPath(), '/definitions')
  eq(definitionPath('flow demo', { version: 2 }), '/definitions/flow%20demo?version=2')
  eq(definitionPath('a/b'), '/definitions/a%2Fb', 'id 必须编码')
  eq(instancesPath({ definitionId: 'd 1', status: 'ACTIVE', limit: 5 }), '/instances?definitionId=d+1&status=ACTIVE&limit=5')
  eq(instancePath('i/1'), '/instances/i%2F1')
  eq(instanceEventsPath('i1', { since: 0 }), '/instances/i1/events?since=0', 'since=0 必须发出去')
  eq(instanceEventsPath('i1', { since: 12 }), '/instances/i1/events?since=12')
  eq(instanceTasksPath('i1'), '/instances/i1/tasks')
  eq(completeTaskPath('i1', 'task/a'), '/instances/i1/tasks/task%2Fa/complete')
  eq(stopInstancePath('i1'), '/instances/i1/stop')
  eq(suspendInstancePath('i1'), '/instances/i1/suspend')
  eq(resumeInstancePath('i1'), '/instances/i1/resume')
  eq(instanceDefinitionPath('i1'), '/instances/i1/definition')
})

await check('新 API 请求：方法 / URL / 请求体 / 事件参数', async () => {
  await withFetch(
    (url, init) => {
      if (url.endsWith('/definitions')) {
        if (init.method === 'POST') return response(201, { ok: true, id: 'flow-demo', version: 1, hash: 'h1' })
        return response(200, { ok: true, definitions: [] })
      }
      if (url.endsWith('/definitions/flow-demo?version=2')) {
        return response(200, { ok: true, id: 'flow-demo', version: 2, xml: '<xml/>' })
      }
      if (url.endsWith('/instances') && init.method === 'POST') {
        return response(201, { ok: true, id: 'i-1', status: 'ACTIVE', definitionVersion: 2 })
      }
      if (url.endsWith('/instances?definitionId=flow-demo&status=ACTIVE')) {
        return response(200, { ok: true, instances: [] })
      }
      if (url.endsWith('/instances/i-1/events?since=3')) {
        return response(200, { ok: true, events: [], lastSeq: 3 })
      }
      if (url.endsWith('/instances/i-1/tasks/t1/complete')) {
        return response(200, { ok: true, status: 'ACTIVE' })
      }
      if (url.endsWith('/instances/i-1/stop')) return response(200, { ok: true, status: 'CANCELED' })
      if (url.endsWith('/instances/i-1/definition')) {
        return response(200, { ok: true, id: 'i-1', definitionId: 'flow-demo', definitionVersion: 2, definitionHash: 'h2', xml: '<xml/>' })
      }
      if (url.endsWith('/instances/i-1/tasks')) return response(200, { ok: true, tasks: [] })
      if (url.endsWith('/instances/i-1')) return response(200, { ok: true, id: 'i-1' })
      return response(404, { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口：' + url })
    },
    async calls => {
      const list = await api.listDefinitions()
      eq(list.ok, true)
      const saved = await api.saveDefinition({ id: 'flow-demo', name: '演示', xml: '<xml/>' })
      eq(saved.version, 1)
      const detail = await api.readDefinition('flow-demo', { version: 2 })
      eq(detail.version, 2)
      const created = await api.createInstance({ definitionId: 'flow-demo', definitionVersion: 2, variables: {} })
      eq(created.id, 'i-1')
      await api.listInstances({ definitionId: 'flow-demo', status: 'ACTIVE' })
      await api.readInstanceEvents('i-1', { since: 3 })
      await api.readInstanceTasks('i-1')
      await api.completeInstanceTask('i-1', 't1', { payload: { approved: true }, decidedBy: 'alice' })
      await api.stopInstance('i-1')
      await api.readInstanceDefinition('i-1')
      await api.readInstance('i-1')

      const urls = calls.map(call => call.url)
      ok(urls.every(url => url.startsWith('/api/flow-studio/')), '所有请求都走 /api/flow-studio 前缀')
      ok(!urls.some(url => /\/api\/flow-studio\/(flows|runs)\b/.test(url)), '新 API 不得再请求旧 /flows、/runs')
      const complete = calls.find(call => call.url.endsWith('/tasks/t1/complete'))
      deep(JSON.parse(complete.init.body), { payload: { approved: true }, decidedBy: 'alice' })
      const create = calls.find(call => call.url.endsWith('/instances') && call.init.method === 'POST')
      deep(JSON.parse(create.init.body), { definitionId: 'flow-demo', definitionVersion: 2, variables: {} })
    },
  )
})

await check('错误结构：保留 status + 稳定 code + Host 可读 message（含 401 / 404 / 409）', async () => {
  await withFetch(
    () => response(404, { ok: false, code: 'INSTANCE_NOT_FOUND', error: '实例 i-x 不存在' }),
    async () => {
      await assert.rejects(() => api.readInstance('i-x'), error => {
        eq(error.status, 404)
        eq(error.code, 'INSTANCE_NOT_FOUND')
        eq(error.message, '实例 i-x 不存在')
        eq(error.data.code, 'INSTANCE_NOT_FOUND')
        return true
      })
    },
  )
  await withFetch(
    () => response(409, { ok: false, code: 'BPMN_TASK_NOT_FOUND', error: '任务已被处理' }),
    async () => {
      await assert.rejects(() => api.completeInstanceTask('i-x', 't1', {}), error => {
        eq(error.status, 409)
        eq(error.code, 'BPMN_TASK_NOT_FOUND')
        return true
      })
    },
  )
  await withFetch(
    () => response(401, { ok: false, error: 'unauthorized' }),
    async () => {
      await assert.rejects(() => api.listDefinitions(), error => {
        eq(error.status, 401)
        eq(error.message, '需要访问令牌：用 ?fs_token=… 打开一次')
        return true
      })
    },
  )
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline') }
  try {
    await assert.rejects(() => api.listDefinitions(), error => {
      eq(error.code, 'NETWORK_ERROR')
      eq(error.status, 0)
      ok(error.message.includes('连不上 Host'))
      return true
    })
  } finally {
    globalThis.fetch = original
  }
})

await check('定义状态：保存成功后钉住 version + hash，「运行」必须显式 definitionVersion', () => {
  const state = createDefinitionState()
  eq(state.runPayload({}).ok, false, '没有定义时不能运行')

  state.select({
    id: 'flow-demo',
    name: '演示',
    version: 1,
    hash: 'h1',
    latestVersion: 1,
    latestHash: 'h1',
    versions: [{ version: 1, hash: 'h1', createdAt: '2026-11-01T00:00:00.000Z', bytes: 100 }],
  })
  eq(state.definitionId, 'flow-demo')
  eq(state.version, 1)
  eq(state.hash, 'h1')
  deep(state.runPayload({ amount: 7 }), {
    ok: true,
    body: { definitionId: 'flow-demo', definitionVersion: 1, variables: { amount: 7 } },
  })

  // 保存成功后钉住新版本；运行必须用刚保存的版本，而不是省略让 Host 猜最新。
  const pinned = state.pinSaved({ id: 'flow-demo', version: 2, hash: 'h2' })
  eq(pinned.pinned, true)
  eq(state.version, 2)
  eq(state.hash, 'h2')
  deep(state.runPayload(), {
    ok: true,
    body: { definitionId: 'flow-demo', definitionVersion: 2, variables: {} },
  })
})

await check('定义状态：list 只更新 latest，不改当前钉住版本', () => {
  const state = createDefinitionState({
    id: 'flow-demo', version: 1, hash: 'h1', latestVersion: 1, latestHash: 'h1', versions: [],
  })
  eq(state.applyList({
    definitions: [{
      id: 'flow-demo',
      name: '演示（新）',
      latestVersion: 5,
      latestHash: 'h5',
      versions: [{ version: 1, hash: 'h1' }, { version: 5, hash: 'h5' }],
    }],
  }), true)
  eq(state.state.latestVersion, 5)
  eq(state.state.latestHash, 'h5')
  eq(state.state.name, '演示（新）')
  eq(state.version, 1, '钉住的仍是打开时的 v1')
  eq(state.runPayload().body.definitionVersion, 1)
})

await check('定义状态：另一份定义的保存响应晚到，不得改写当前版本', () => {
  const state = createDefinitionState({ id: 'flow-a', version: 3, hash: 'ha3' })
  const result = state.pinSaved({ id: 'flow-b', version: 9, hash: 'hb9' })
  eq(result.pinned, false)
  eq(state.definitionId, 'flow-a')
  eq(state.version, 3)
})

await check('定义状态：新建定义首次保存后采用返回 id；dirty 阻止运行', () => {
  const fresh = createDefinitionState()
  const saved = fresh.pinSaved({ id: 'flow-new', version: 1, hash: 'hn1' })
  eq(saved.pinned, true)
  eq(fresh.definitionId, 'flow-new')
  eq(fresh.runPayload().ok, true)

  fresh.markDirty()
  const blocked = fresh.runPayload()
  eq(blocked.ok, false)
  ok(blocked.reason.includes('未保存'))
})

await check('定义状态：保存只清「提交时 revision」的 dirty（提交后继续改仍是 dirty）', () => {
  const revisions = createEditRevision()
  const state = createDefinitionState({ id: 'flow-demo', version: 1, hash: 'h1' })
  revisions.markChanged() // revision 1
  revisions.markChanged() // revision 2
  state.markDirty()
  const submitted = revisions.revision
  eq(submitted, 2)

  // 提交后用户又改了一次 → revision 3。
  revisions.markChanged()
  state.markDirty()
  const result = state.pinSaved(
    { id: 'flow-demo', version: 2, hash: 'h2' },
    { revision: revisions.revision, savedRevision: submitted },
  )
  eq(result.pinned, true)
  eq(state.version, 2, '版本照样钉住刚保存的 v2')
  eq(revisions.isDirty(), true, '提交后的修改仍是 dirty')
  eq(state.dirty, true)
  eq(state.runPayload().ok, false, '有未保存修改时禁止运行旧版本')

  // 只有当前修订与提交修订一致时才清 dirty。
  const clean = createEditRevision()
  clean.markChanged()
  clean.markSaved(clean.revision)
  eq(clean.isDirty(), false)
})

await check('保存队列：去抖窗内多次编辑只发一次，maxWait 兜底', () => {
  const timer = fakeTimer()
  const saves = []
  const queue = createSaveQueue({
    save: async snapshot => { saves.push(snapshot); return { ok: true } },
    debounceMs: 300,
    maxWaitMs: 1000,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
  })
  queue.schedule({ definitionId: 'd', revision: 1, xml: '<1/>' })
  timer.advance(100)
  queue.schedule({ definitionId: 'd', revision: 2, xml: '<2/>' })
  timer.advance(100)
  queue.schedule({ definitionId: 'd', revision: 3, xml: '<3/>' })
  eq(saves.length, 0)
  timer.advance(300)
  eq(saves.length, 1, '去抖窗内只发最后一次')
  eq(saves[0].revision, 3)
  timer.advance(10000)
  eq(saves.length, 1)
  eq(timer.pending(), 0)
})

await check('保存队列：乱序响应丢弃——旧请求晚到不覆盖新版本 / 不清新 dirty', async () => {
  const requests = []
  const applied = []
  const queue = createSaveQueue({
    save: snapshot => {
      const pending = deferred()
      requests.push({ snapshot, pending })
      return pending.promise
    },
    debounceMs: 100000, // 用 flush 手动发，避免去抖干扰
    maxWaitMs: 100000,
    onSaved: (result, snapshot) => applied.push({ result, snapshot }),
  })

  queue.schedule({ definitionId: 'd', revision: 1, xml: '<v1/>' })
  const first = queue.flush()
  queue.schedule({ definitionId: 'd', revision: 2, xml: '<v2/>' })
  const second = queue.flush()
  eq(requests.length, 2, '两次保存各自发出（保存顺序 = 触发顺序）')
  eq(requests[0].snapshot.xml, '<v1/>')
  eq(requests[1].snapshot.xml, '<v2/>')

  // 新请求先回：v2 生效。
  requests[1].pending.resolve({ ok: true, id: 'd', version: 2, hash: 'h2' })
  const secondResult = await second
  eq(secondResult.ok, true)
  eq(secondResult.stale, false)
  eq(applied.length, 1)
  eq(applied[0].snapshot.revision, 2)

  // 旧请求晚到：必须标 stale，不能再次 onSaved。
  requests[0].pending.resolve({ ok: true, id: 'd', version: 1, hash: 'h1' })
  const firstResult = await first
  eq(firstResult.ok, true)
  eq(firstResult.stale, true, '旧响应必须被丢弃')
  eq(applied.length, 1, '旧响应不得覆盖新状态')
  eq(queue.lastResult.version, 2)
})

await check('保存队列：失败保留 dirty，下一次成功才钉版本', async () => {
  const revisions = createEditRevision()
  const state = createDefinitionState({ id: 'flow-demo', version: 1, hash: 'h1' })
  revisions.markChanged()
  state.markDirty()

  const queue = createSaveQueue({
    save: async () => { throw new Error('host down') },
    debounceMs: 100000,
    maxWaitMs: 100000,
    onSaved: (result, snapshot) => {
      state.pinSaved(result, { revision: snapshot.revision, savedRevision: snapshot.savedRevision })
      revisions.markSaved(snapshot.savedRevision)
    },
  })
  queue.schedule({
    definitionId: 'flow-demo',
    revision: revisions.revision,
    savedRevision: revisions.revision,
    xml: '<v1/>',
  })
  const failed = await queue.flush()
  eq(failed.ok, false)
  eq(revisions.isDirty(), true, '失败后 dirty 必须保留')
  eq(state.dirty, true)
  eq(state.version, 1, '失败不得推进钉住版本')
  ok(queue.lastError instanceof Error)

  // 重试成功：版本推进、dirty 清掉。
  const retry = createSaveQueue({
    save: async snapshot => ({ ok: true, id: 'flow-demo', version: 2, hash: 'h2', snapshot }),
    debounceMs: 100000,
    maxWaitMs: 100000,
    onSaved: (result, snapshot) => {
      state.pinSaved(result, { revision: snapshot.revision, savedRevision: snapshot.savedRevision })
      revisions.markSaved(snapshot.savedRevision)
    },
  })
  retry.schedule({
    definitionId: 'flow-demo',
    revision: revisions.revision,
    savedRevision: revisions.revision,
    xml: '<v2/>',
  })
  const saved = await retry.flush()
  eq(saved.ok, true)
  eq(state.version, 2)
  eq(revisions.isDirty(), false)
})

await check('模板：三个模板都能被 parseBpmn() 解析通过并带 BPMN DI', async () => {
  eq(BPMN_TEMPLATES.length, 3)
  deep(listTemplates().map(item => item.id), ['manual', 'agent-human', 'exclusive-gateway'])
  eq(getTemplate('nope'), null)
  eq(templateXml('nope'), null)

  for (const template of BPMN_TEMPLATES) {
    const parsed = await parseBpmn(template.xml)
    ok(parsed.ok, `${template.id} 必须能解析：${JSON.stringify(parsed.errors)}`)
    eq(parsed.definition.id, template.processId)
    ok(template.xml.includes('bpmndi:BPMNDiagram'), `${template.id} 必须带 DI`)
    ok(template.xml.includes('dc:Bounds'), `${template.id} 必须有图元坐标`)
    ok(template.xml.includes('di:waypoint'), `${template.id} 必须有连线坐标`)
    ok(template.xml.includes('isExecutable="true"'), `${template.id} 必须是可执行流程`)
  }

  const agent = BPMN_TEMPLATES.find(template => template.id === 'agent-human')
  const agentParsed = await parseBpmn(agent.xml)
  const service = agentParsed.definition.elements.find(element => element.type === 'serviceTask')
  ok(service, 'agent-human 必须有 serviceTask')
  eq(service.kind, 'agent')
  eq(service.node.adapter, 'dsh')

  const gateway = BPMN_TEMPLATES.find(template => template.id === 'exclusive-gateway')
  const gatewayParsed = await parseBpmn(gateway.xml)
  const gatewayElement = gatewayParsed.definition.elements.find(element => element.type === 'exclusiveGateway')
  ok(gatewayElement, 'exclusive-gateway 必须有排他网关')
  const condition = gatewayParsed.definition.flows.find(flow => flow.condition)
  ok(condition, '网关必须有一条带 FEEL 条件的分支')
  eq(condition.condition.language, 'feel')
})

await check('模板元数据不包含 XML，process id 与 XML 一致', () => {
  for (const meta of listTemplates()) {
    eq('xml' in meta, false, '下拉菜单元数据不带整份 XML')
    ok(meta.name.length > 0)
    ok(getTemplate(meta.id).xml.includes(`id="${meta.processId}"`))
  }
})

console.log(`\n${checks} 组通过（${assertions} 条断言）`)
