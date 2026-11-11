#!/usr/bin/env node
/**
 * 实例侧客户端自检（0.13.3）：
 * - 事件按 seq 增量合并去重、未知事件降级、按 elementId 定位；
 * - 实例状态来自事件（running / waiting / completed / failed / error）；
 * - 人工任务重复完成守卫与 404 / 409 收口计划；
 * - 实例定义永远走快照接口（定义域已有 v3 也不影响 v1 画布）；
 * - 增量事件只发 `since`，不再带旧接口的 kind / order / light。
 *
 * 不发真实请求：fetch 用桩替换。
 * 运行：node test/client-instance.test.mjs
 */

import assert from 'node:assert/strict'

import { api, instanceEventsPath, instanceDefinitionPath, instancePath, instanceTasksPath, resumeInstancePath, suspendInstancePath } from '../src/client/api.js'
import {
  KNOWN_INSTANCE_EVENTS, completionFailurePlan, createInstanceProjection, createTaskCompletionGuard,
  elementStateMap, eventIdentity, latestEventForElement, mergeInstanceEvents, nextEventsQuery,
  projectElementStates, taskCompletionKey,
} from '../src/client/bpmn-state.js'

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

function deferred() {
  let resolve
  const promise = new Promise(res => { resolve = res })
  return { promise, resolve }
}

function event(seq, type, extra = {}) {
  return { seq, type, at: `2026-11-11T10:00:${String(seq).padStart(2, '0')}.000Z`, ...extra }
}

console.log('client-instance')

await check('事件合并：按 seq 去重、乱序输入排回升序、非法条目跳过', () => {
  eq(KNOWN_INSTANCE_EVENTS.includes('activity/wait'), true)

  const first = mergeInstanceEvents([], [
    event(2, 'activity/start', { elementId: 'task1', activityId: 'exec-1' }),
    event(1, 'process/start', { elementId: 'proc' }),
  ])
  eq(first.added, 2)
  deep(first.events.map(item => item.seq), [1, 2], '合并后按 seq 升序')
  eq(first.lastSeq, 2)

  const second = mergeInstanceEvents(first.events, [
    event(2, 'activity/start', { elementId: 'task1', activityId: 'exec-1' }), // 同一条重复到达
    event(4, 'activity/wait', { elementId: 'task1', activityId: 'exec-1' }),
    event(3, 'flow/taken', { flowId: 'f1', from: 'start', to: 'task1' }),
    null,
    { type: '' },
  ])
  eq(second.added, 2, '只有 seq 3、4 是新的')
  eq(second.duplicates, 1, '重复事件被去重')
  eq(second.invalid, 2, '坏条目跳过，不抛错')
  deep(second.events.map(item => item.seq), [1, 2, 3, 4])
  eq(second.lastSeq, 4)

  eq(eventIdentity(event(9, 'activity/start')), 's:9')
  ok(eventIdentity({ type: 'activity/start', elementId: 'x', at: 't' }).startsWith('k:'), '无 seq 时用内容键兜底')
})

await check('事件合并：未知 kind 保留但降级（不改图元状态）', () => {
  const merged = mergeInstanceEvents([], [
    event(1, 'activity/start', { elementId: 'task1' }),
    event(2, 'custom/telemetry', { elementId: 'task1', value: 42 }),
    event(3, 'activity/wait', { elementId: 'task1' }),
  ])
  eq(merged.unknown, 1)
  const unknown = merged.events.find(item => item.type === 'custom/telemetry')
  deep(unknown, {
    seq: 2,
    type: 'custom/telemetry',
    at: '2026-11-11T10:00:02.000Z',
    elementId: 'task1',
    activityId: '',
    known: false,
    value: 42,
  })
  const states = projectElementStates(merged.events)
  eq(states.task1.status, 'waiting', '未知事件不能把 waiting 改成别的状态')
  eq(states.task1.lastType, 'activity/wait')
  deep(states.task1.error, null)
})

await check('事件投影：running / waiting / completed / failed / error', () => {
  const stateOf = (events, elementId = 'task1') => projectElementStates(events)[elementId]

  eq(stateOf([event(1, 'activity/start', { elementId: 'task1', activityId: 'exec-1' })]).status, 'running')
  const waiting = stateOf([
    event(1, 'activity/start', { elementId: 'task1', activityId: 'exec-1' }),
    event(2, 'activity/wait', { elementId: 'task1', activityId: 'exec-1' }),
  ])
  eq(waiting.status, 'waiting')
  eq(waiting.waits, 1)
  eq(waiting.attempts, 1)

  const completed = stateOf([
    event(1, 'activity/start', { elementId: 'task1' }),
    event(2, 'activity/end', { elementId: 'task1', status: 'completed' }),
  ])
  eq(completed.status, 'completed')

  const failed = stateOf([
    event(1, 'activity/start', { elementId: 'task1' }),
    event(2, 'activity/end', { elementId: 'task1', status: 'failed', error: { code: 'X', message: '坏了' } }),
  ])
  eq(failed.status, 'failed')
  eq(failed.error.code, 'X')

  const errored = stateOf([
    event(1, 'activity/start', { elementId: 'task1' }),
    event(2, 'error', { elementId: 'task1', error: { code: 'BPMN_HANDLER_FAILED', message: 'handler 失败' } }),
  ])
  eq(errored.status, 'error')
  eq(errored.error.message, 'handler 失败')

  // 错误后重试：新的 activity/start 会清掉上一次 error。
  const retried = stateOf([
    event(1, 'error', { elementId: 'task1', error: { code: 'E', message: '失败' } }),
    event(2, 'activity/start', { elementId: 'task1' }),
  ])
  eq(retried.status, 'running')
  deep(retried.error, null)
})

await check('图元定位只认 elementId：activityId / executionId 不能当 BPMN 图元 id', () => {
  const events = [
    event(1, 'activity/start', { elementId: 'human1', activityId: 'human1_exec_9' }),
    event(2, 'activity/wait', { elementId: 'human1', activityId: 'human1_exec_9' }),
    event(3, 'activity/start', { elementId: 'agent1', activityId: 'human1_exec_9' }),
  ]
  eq(latestEventForElement(events, 'human1').type, 'activity/wait')
  eq(latestEventForElement(events, 'human1_exec_9'), null, 'activityId 不是图元 id')
  const map = elementStateMap(events)
  eq(map.has('human1'), true)
  eq(map.has('agent1'), true)
  eq(map.has('human1_exec_9'), false)
})

await check('增量投影：merge 只追新事件，since / nextEventsQuery 正确', () => {
  const projection = createInstanceProjection()
  let result = projection.merge([event(1, 'process/start', { elementId: 'proc' })])
  eq(result.added, 1)
  eq(projection.lastSeq, 1)
  deep(nextEventsQuery(projection.since), { since: 1 })

  result = projection.merge([
    event(1, 'process/start', { elementId: 'proc' }),
    event(2, 'activity/start', { elementId: 'task1' }),
  ])
  eq(result.added, 1)
  eq(result.duplicates, 1)
  eq(projection.lastSeq, 2)
  eq(projection.latestFor('task1').type, 'activity/start')
  deep(projection.eventsFor('task1').map(item => item.seq), [2])

  result = projection.merge([event(4, 'activity/wait', { elementId: 'task1' })])
  eq(projection.lastSeq, 4, 'lastSeq 取最大 seq')
  deep(nextEventsQuery(projection.since), { since: 4 })

  projection.reset()
  eq(projection.lastSeq, 0)
  eq(projection.events.length, 0)
})

await check('实例详情 / 事件 / 待办 / 停止：只走新实例路由', async () => {
  await withFetch(
    url => {
      if (url.endsWith('/instances/i-1')) {
        return response(200, { ok: true, id: 'i-1', status: 'ACTIVE', pendingTasks: [] })
      }
      if (url.endsWith('/instances/i-1/events?since=7')) {
        return response(200, { ok: true, id: 'i-1', events: [], lastSeq: 7 })
      }
      if (url.endsWith('/instances/i-1/tasks')) {
        return response(200, { ok: true, id: 'i-1', tasks: [{ activityId: 'human1', executionId: 'e1' }] })
      }
      if (url.endsWith('/instances/i-1/stop')) {
        return response(200, { ok: true, id: 'i-1', status: 'CANCELED', alreadyTerminal: false })
      }
      return response(404, { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口' })
    },
    async calls => {
      const detail = await api.readInstance('i-1')
      eq(detail.status, 'ACTIVE')
      const events = await api.readInstanceEvents('i-1', { since: 7 })
      eq(events.lastSeq, 7)
      const tasks = await api.readInstanceTasks('i-1')
      eq(tasks.tasks.length, 1)
      const stopped = await api.stopInstance('i-1')
      eq(stopped.status, 'CANCELED')
      deep(calls.map(call => call.url), [
        '/api/flow-studio/instances/i-1',
        '/api/flow-studio/instances/i-1/events?since=7',
        '/api/flow-studio/instances/i-1/tasks',
        '/api/flow-studio/instances/i-1/stop',
      ])
    },
  )
})

await check('挂起 / 恢复：POST 路径、可选 reason 请求体、409 BUSY 带出 activities', async () => {
  eq(suspendInstancePath('i/1'), '/instances/i%2F1/suspend')
  eq(resumeInstancePath('i/1'), '/instances/i%2F1/resume')
  await withFetch(
    (url, init) => {
      if (url.endsWith('/instances/i-1/suspend')) {
        const body = JSON.parse(init.body)
        return response(200, {
          ok: true, id: 'i-1', status: 'SUSPENDED', reason: body.reason ?? null,
          lastSeq: 13, suspendedAt: '2026-11-12T00:00:00.000Z',
        })
      }
      if (url.endsWith('/instances/i-1/resume')) {
        return response(200, {
          ok: true, id: 'i-1', status: 'ACTIVE', reason: null,
          lastSeq: 14, resumedAt: '2026-11-12T00:05:00.000Z',
        })
      }
      return response(404, { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口' })
    },
    async calls => {
      const suspended = await api.suspendInstance('i-1', ' 窗口维护 ')
      eq(suspended.status, 'SUSPENDED')
      eq(suspended.reason, '窗口维护', 'reason 客户端 trim 后发送，Host 再按契约落事件')
      eq(suspended.lastSeq, 13)
      const resumed = await api.resumeInstance('i-1')
      eq(resumed.status, 'ACTIVE')
      eq(resumed.lastSeq, 14)
      deep(calls.map(call => [call.init.method, call.url]), [
        ['POST', '/api/flow-studio/instances/i-1/suspend'],
        ['POST', '/api/flow-studio/instances/i-1/resume'],
      ])
      deep(JSON.parse(calls[0].init.body), { reason: '窗口维护' }, '挂起必须带 reason')
      deep(JSON.parse(calls[1].init.body), {}, '省略 reason 时发空对象，不夹带 undefined')
    },
  )

  const busyBody = {
    ok: false,
    code: 'INSTANCE_SUSPEND_BUSY',
    error: '实例 i-1 还有未结束的活动，不能挂起',
    activities: [
      { kind: 'agent', activityId: 'agent-a', state: 'running' },
      { kind: 'http', activityId: 'http-b', state: 'sent' },
    ],
  }
  await withFetch(
    () => response(409, busyBody),
    async () => {
      await assert.rejects(api.suspendInstance('i-1'), error => {
        eq(error.status, 409)
        eq(error.code, 'INSTANCE_SUSPEND_BUSY')
        eq(error.data.activities.length, 2, 'BUSY 的 activities 必须随错误带出，供页面说明原因')
        return true
      })
    },
  )
})

await check('快照隔离：实例画布读 /definition，不读定义域最新版本', async () => {
  const frozenXml = '<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="frozen-v1"/>'
  await withFetch(
    url => {
      if (url.endsWith('/instances/i-1/definition')) {
        return response(200, {
          ok: true,
          id: 'i-1',
          definitionId: 'flow-demo',
          definitionVersion: 1,
          definitionHash: 'hash-v1',
          xml: frozenXml,
        })
      }
      if (url.endsWith('/definitions/flow-demo')) {
        return response(200, {
          ok: true,
          id: 'flow-demo',
          version: 3,
          hash: 'hash-v3',
          xml: '<?xml version="1.0"?><new/>',
        })
      }
      return response(404, { ok: false, code: 'BPMN_ROUTE_NOT_FOUND', error: '未知接口' })
    },
    async calls => {
      const snapshot = await api.readInstanceDefinition('i-1')
      eq(snapshot.definitionVersion, 1)
      eq(snapshot.definitionHash, 'hash-v1')
      eq(snapshot.xml, frozenXml, '实例画布必须拿到 v1 冻结 XML')
      eq(calls.length, 1, '只请求实例快照，不请求定义域')
      eq(calls[0].url, '/api/flow-studio' + instanceDefinitionPath('i-1'))
      ok(!calls.some(call => call.url.includes('/definitions/')), '不得回查定义域最新版本')
    },
  )
})

await check('重复完成：同一任务提交期间第二次被守卫挡住，只发一次请求', async () => {
  const guard = createTaskCompletionGuard()
  const task = { activityId: 'human1', executionId: 'human1_exec_1' }
  eq(taskCompletionKey(task), 'human1::human1_exec_1')

  const pending = deferred()
  let calls = 0
  await withFetch(
    () => {
      calls += 1
      return pending.promise
    },
    async () => {
      const key = guard.begin(task)
      ok(key !== null)
      const firstRequest = api.completeInstanceTask('i-1', task.activityId, {
        payload: { approved: true },
        decidedBy: 'alice',
        executionId: task.executionId,
      })
      eq(guard.begin(task), null, '提交期间重复点击必须被挡住')
      eq(calls, 1, '不能发第二次完成请求')
      pending.resolve(response(200, { ok: true, status: 'ACTIVE', pendingTasks: [] }))
      await firstRequest
      guard.end(key)
    },
  )
  eq(guard.has(task), false)
  ok(guard.begin(task) !== null, '上一次提交结束后才允许再次提交（例如任务仍在等待）')
})

await check('完成失败收口：404 / 409 刷新待办，其它错误不改本地状态', () => {
  const notFound = completionFailurePlan(404, { code: 'BPMN_TASK_NOT_FOUND', error: '任务已被处理' })
  eq(notFound.refresh, true)
  eq(notFound.terminal, false)
  ok(notFound.message.includes('任务已被处理'))

  const terminal = completionFailurePlan(409, { code: 'BPMN_INSTANCE_TERMINAL', error: '实例已结束' })
  eq(terminal.refresh, true)
  eq(terminal.terminal, true)

  const conflict = completionFailurePlan(409, { code: 'BPMN_INSTANCE_NOT_WAITING', error: '不在等待' })
  eq(conflict.refresh, true)
  eq(conflict.terminal, false)

  const offline = completionFailurePlan(0, null)
  eq(offline.refresh, false)
  ok(offline.message.includes('连不上'))
})

await check('实例路径：since 只出现一次且不夹带旧参数', () => {
  const path = instanceEventsPath('i 1', { since: 0 })
  eq(path, '/instances/i%201/events?since=0')
  ok(!path.includes('kind='))
  ok(!path.includes('order='))
  ok(!path.includes('light='))
  eq(instancePath('i-1'), '/instances/i-1')
  eq(instanceTasksPath('i-1'), '/instances/i-1/tasks')
})

console.log(`\n${checks} 组通过（${assertions} 条断言）`)
