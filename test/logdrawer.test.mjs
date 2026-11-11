#!/usr/bin/env node
/**
 * 实例事件抽屉自检（0.13.3 步骤 5）。
 *
 * 覆盖：
 *  - `?since=` 增量合并：按 seq 去重、升序、lastSeq 取最大；
 *  - 事件行：已知 kind 的中文 / 摘要、未知 kind 降级保留、坏行跳过；
 *  - `elementId` 定位：只认 BPMN 图元 id，绝不拿 activityId / executionId 顶替；
 *  - 轮询退避；
 *  - SSR：展开 / 收起结构、data-* 定位标记、选中高亮。
 *
 * 运行：node test/logdrawer.test.mjs
 */

import assert from 'node:assert/strict'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { bindReact } from '../src/client/runtime.js'

bindReact(React)

const {
  EVENT_DRAWER_HEIGHT, EVENT_POLL_HIDDEN_MS, EVENT_POLL_MAX_MS, EVENT_POLL_MS,
  InstanceEventDrawer, drawerToggleText, eventElementIdOf, eventRows, eventSummaryText,
  eventTimeText, eventTypeText, eventRowKey, focusBpmnElement, mergeInstanceEvents,
  nextEventPollDelay, unknownEventText,
} = await import('../src/client/logdrawer.js')
const { createInstanceProjection, nextEventsQuery } = await import('../src/client/bpmn-state.js')
const { CSS } = await import('../src/client/styles.js')

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

function render(element) {
  return renderToStaticMarkup(element)
}

const EVENTS = [
  { type: 'process/start', seq: 1, at: '2026-11-11T10:00:01+08:00', elementId: 'Process_1', activityId: 'p1' },
  { type: 'activity/start', seq: 2, at: '2026-11-11T10:00:02+08:00', elementId: 'Human_1', activityId: 'act-1', attempt: 1 },
  { type: 'activity/wait', seq: 3, at: '2026-11-11T10:00:03+08:00', elementId: 'Human_1', activityId: 'act-1' },
  { type: 'flow/taken', seq: 4, at: '2026-11-11T10:00:04+08:00', flowId: 'Flow_1', from: 'Start_1', to: 'Human_1' },
  { type: 'error', seq: 5, at: '2026-11-11T10:00:05+08:00', elementId: 'Agent_1', error: { code: 'BPMN_HANDLER_FAILED', message: 'adapter 不可用' } },
  { type: 'custom/unknown', seq: 6, at: '2026-11-11T10:00:06+08:00', elementId: 'Agent_1' },
]

console.log('instance events')

check('seq 增量合并：去重、升序、lastSeq 取最大、未知事件计入 unknown', () => {
  const merged = mergeInstanceEvents(
    [
      { type: 'activity/wait', seq: 3, elementId: 'Human_1' },
      { type: 'process/start', seq: 1, elementId: 'Process_1' },
    ],
    [
      { type: 'activity/start', seq: 2, elementId: 'Human_1' },
      { type: 'activity/wait', seq: 3, elementId: 'Human_1' },
      { type: 'custom/unknown', seq: 4, elementId: 'Human_1' },
      { type: 'activity/start', seq: 2, elementId: 'Human_1' },
      { nope: true },
    ],
    { baseSeq: 0 },
  )
  assert.equal(merged.added, 2, '新增 2/4 两条；3 已存在、2 重复到达')
  assert.equal(merged.duplicates, 2, '同 seq 的重复事件被去重（existing 里的 3、incoming 里重复的 2）')
  assert.equal(merged.invalid, 1, '缺少 type 的坏行被跳过')
  assert.equal(merged.unknown, 1, '未知 kind 保留并计数')
  assert.deepEqual(merged.events.map(event => event.seq), [1, 2, 3, 4], '输出按 seq 升序')
  assert.equal(merged.lastSeq, 4)

  // 有状态投影：第二次 since 只合并新事件，游标前进。
  const projection = createInstanceProjection({ events: merged.events, lastSeq: merged.lastSeq })
  const next = projection.merge([{ type: 'process/end', seq: 9, elementId: 'Process_1' }])
  assert.equal(next.added, 1)
  assert.equal(projection.lastSeq, 9)
  assert.equal(projection.since, 9)
  assert.deepEqual(nextEventsQuery(projection.since), { since: 9 }, '下一次请求只带 since')
})

check('事件行：已知 kind 中文 / 摘要；未知 kind 降级；坏行跳过', () => {
  assert.equal(eventTypeText('activity/wait'), '等待人工')
  assert.equal(eventTypeText('custom/unknown'), '')
  assert.equal(unknownEventText({ type: 'custom/unknown' }), '未知事件（custom/unknown）')
  assert.equal(unknownEventText({ type: 'activity/wait' }), '', '已知事件没有未知文案')

  const rows = eventRows(EVENTS)
  assert.equal(rows.length, 6, '六条合法事件各一行')
  assert.equal(rows[0].typeText, '流程开始')
  assert.equal(rows[4].summary, 'Agent_1 · adapter 不可用', 'error 行摘要带图元与错误信息')
  assert.match(rows[3].summary, /Start_1 → Human_1/, 'flow/taken 摘要写 from → to')
  assert.equal(rows[5].unknown, true, '未知 kind 标 unknown')
  assert.equal(rows[5].elementId, 'Agent_1', '未知事件仍保留 elementId（可定位）')
  assert.equal(rows[5].summary, '未知事件（custom/unknown）', '未知事件不猜字段')
  assert.equal(rows[2].timeText, '10:00:03')

  // 坏输入不抛错。
  assert.deepEqual(eventRows([null, 'x', 42, {}, { type: '' }]), [])
  assert.equal(eventSummaryText(null), '')
  assert.equal(eventTimeText({ at: 'nonsense' }), 'nonsense')
  assert.equal(eventElementIdOf({ elementId: 42 }), '')
  assert.equal(eventRowKey({ type: 'error', seq: 7 }), 's:7')

  // 未知事件不参与图元状态推导（elementStateMap 只看已知 kind）。
  const projection = createInstanceProjection({ events: EVENTS })
  const states = projection.elementStates()
  assert.equal(states.Human_1.status, 'waiting')
  assert.equal(states.Process_1.status, 'running')
  assert.equal(states.Agent_1.status, 'error', 'error 事件按图元状态展示')
})

check('elementId 定位：只认 BPMN 图元 id，找不到时返回 false 且不猜 activityId', () => {
  const calls = []
  const elements = new Map([['Human_1', { id: 'Human_1', type: 'bpmn:UserTask' }]])
  const fake = {
    getModeler() {
      return {
        get(name) {
          if (name === 'elementRegistry') return { get: id => elements.get(id) || null }
          if (name === 'canvas') return { scrollToElement: element => calls.push(element.id) }
          return null
        },
      }
    },
  }
  assert.equal(focusBpmnElement(fake, 'Human_1'), true)
  assert.deepEqual(calls, ['Human_1'], '按 elementId 滚动到图元')

  assert.equal(focusBpmnElement(fake, 'act-1'), false, 'activityId 不是图元 id')
  assert.equal(focusBpmnElement(fake, 'exec-1'), false, 'executionId 不是图元 id')
  assert.equal(focusBpmnElement(fake, ''), false)
  assert.equal(focusBpmnElement(fake, null), false)
  assert.equal(focusBpmnElement(null, 'Human_1'), false)
  assert.equal(focusBpmnElement({ getModeler: () => ({ get: () => null }) }, 'Human_1'), false)
  assert.equal(calls.length, 1, '失败路径不能再滚动')
})

check('轮询退避：2s → 4s → 8s → 16s → 30s；后台 15s', () => {
  assert.equal(EVENT_POLL_MS, 2000)
  assert.equal(EVENT_POLL_MAX_MS, 30000)
  assert.equal(EVENT_POLL_HIDDEN_MS, 15000)
  assert.equal(nextEventPollDelay({ failures: 0 }), 2000)
  assert.equal(nextEventPollDelay({ failures: 1 }), 4000)
  assert.equal(nextEventPollDelay({ failures: 2 }), 8000)
  assert.equal(nextEventPollDelay({ failures: 3 }), 16000)
  assert.equal(nextEventPollDelay({ failures: 4 }), 30000)
  assert.equal(nextEventPollDelay({ failures: 9 }), 30000)
  assert.equal(nextEventPollDelay({ failures: 0, hidden: true }), 15000)
  assert.equal(nextEventPollDelay({ failures: 2, hidden: true }), 15000)
  assert.equal(nextEventPollDelay({ failures: -1 }), 2000)
})

check('SSR 展开态：计数、seq、elementId、未知事件降级、选中高亮', () => {
  assert.equal(EVENT_DRAWER_HEIGHT, 240)
  assert.equal(drawerToggleText(true, 6), '收起实例事件（6）')
  assert.equal(drawerToggleText(false, 2), '展开实例事件（2）')

  const html = render(React.createElement(InstanceEventDrawer, {
    open: true,
    events: EVENTS,
    lastSeq: 6,
    instanceId: 'i-1',
    selectedElementId: 'Human_1',
    onToggle() {},
    onSelectEvent() {},
  }))
  assert.ok(html.includes('data-open="true"'), '展开态标记')
  assert.ok(html.includes('data-event-count="6"'), '事件计数')
  assert.ok(html.includes('seq 6'), '游标')
  assert.ok(html.includes('data-event-seq="3"'), '行上带 seq')
  assert.ok(html.includes('data-element-id="Human_1"'), '行上带 elementId')
  assert.ok(html.includes('data-event-type="custom/unknown"'), '未知 kind 原样保留')
  assert.ok(html.includes('data-unknown="true"'), '未知事件标记')
  assert.ok(html.includes('未知事件（custom/unknown）'), '未知事件降级文案')
  assert.match(html, /class="fs-event-row selected"/, '选中图元的行高亮')
  assert.ok(html.includes('等待人工'), '已知 kind 有中文')
  assert.ok(html.includes('Start_1 → Human_1'), 'flow/taken 摘要')
  assert.ok(html.includes('aria-expanded="true"'), '开关 aria-expanded')
  assert.ok(!html.includes('undefined'), '未知 / 缺字段不能渲染成 undefined')

  const collapsed = render(React.createElement(InstanceEventDrawer, {
    open: false, events: EVENTS, lastSeq: 6, onToggle() {},
  }))
  assert.ok(collapsed.includes('data-open="false"'))
  assert.ok(collapsed.includes('aria-expanded="false"'))
  assert.ok(!collapsed.includes('data-event-seq="3"'), '收起态不渲染事件行')
  assert.ok(collapsed.includes('展开实例事件（6）'), '收起态给出可操作标题')
})

check('SSR 空态 / 错误态 / 样式挂点', () => {
  const empty = render(React.createElement(InstanceEventDrawer, {
    open: true, events: [], lastSeq: 0, onToggle() {},
  }))
  assert.ok(empty.includes('还没有事件'), '空态给出下一步')
  const error = render(React.createElement(InstanceEventDrawer, {
    open: true, events: [], lastSeq: 0, error: '读取实例事件失败：boom', onToggle() {},
  }))
  assert.ok(error.includes('读取实例事件失败：boom'))
  assert.ok(error.includes('role="alert"'))
  for (const selector of [
    '.fs-event-drawer', '.fs-event-bar', '.fs-event-toggle', '.fs-event-body',
    '.fs-event-rows', '.fs-event-row.selected', '.fs-event-row.unknown', '.fs-event-summary',
  ]) {
    assert.ok(CSS.includes(selector), 'styles.js 缺少 ' + selector)
  }
})

console.log(`\n${checks} 组通过`)
