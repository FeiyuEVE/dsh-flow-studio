#!/usr/bin/env node
/**
 * 实例指标客户端自检（0.13.10 E1）：
 *  - 路径 / 查询串（单实例、汇总）；
 *  - 未知不是零：null → 「未知 / 无样本」，不渲染 0；
 *  - 单实例面板：墙钟 / 挂起 / 人工等待 / agent / connector / 原因；
 *  - 汇总面板：总数、状态、每日分组；
 *  - 失败文案保留服务端原因。
 *
 * 交互用最小 hooks 探针（真实 React createElement），不发真实 fetch。
 * 运行：node test/client-metrics.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import React from 'react'

import { instanceMetricsPath, metricsPath } from '../src/client/api.js'
import {
  InstanceMetricsPanel, MetricsSummaryPanel, coverageText, formatDurationMs, formatTokens,
  latencyText, metricsFailurePlan, metricsReasonText, metricsShouldPoll, metricsSections,
  successRateText, tokenBreakdownText,
} from '../src/client/instance-metrics.js'
import { bindReact } from '../src/client/runtime.js'

let currentRender = null
const probeReact = {
  createElement: React.createElement,
  useState(initial) { return currentRender.useState(initial) },
  useEffect(fn, deps) { return currentRender.useEffect(fn, deps) },
  useCallback(fn) { return fn },
}
bindReact(probeReact)

function createHarness(Component, props) {
  const hooks = []
  const effectCache = new Map()
  let tree = null
  let needsRender = false
  let hookIndex = 0

  const ctx = {
    useState(initial) {
      const index = hookIndex++
      if (!hooks[index]) hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      const hook = hooks[index]
      return [hook.value, next => {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (Object.is(value, hook.value)) return
        hook.value = value
        needsRender = true
      }]
    },
    useEffect(fn, deps) {
      const index = hookIndex++
      const previous = effectCache.get(index)
      const list = Array.isArray(deps) ? deps.slice() : null
      const changed = previous === undefined || previous.deps === null || list === null
        || previous.deps.length !== list.length || previous.deps.some((value, i) => !Object.is(value, list[i]))
      if (!changed) return
      effectCache.set(index, { deps: list, cleanup: null })
      queueMicrotask(() => {
        const stored = effectCache.get(index)
        if (!stored) return
        try {
          const cleanup = fn()
          stored.cleanup = typeof cleanup === 'function' ? cleanup : null
        } catch (error) {
          stored.error = error
        }
      })
      return () => {
        const stored = effectCache.get(index)
        if (stored && typeof stored.cleanup === 'function') stored.cleanup()
      }
    },
  }

  function renderNode(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map(renderNode)
    if (typeof node.type === 'function') {
      hookIndex = 0
      const previous = currentRender
      currentRender = ctx
      try {
        return renderNode(node.type(node.props || {}))
      } finally {
        currentRender = previous
      }
    }
    const children = Array.isArray(node.props.children)
      ? node.props.children.map(renderNode)
      : [renderNode(node.props.children)]
    return { type: node.type, props: node.props, children: children.flat(Infinity) }
  }

  async function render() {
    needsRender = false
    tree = renderNode(React.createElement(Component, props))
    await Promise.resolve()
  }

  async function flush(rounds = 5) {
    await render()
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve()
      if (needsRender) await render()
      else await Promise.resolve()
      await new Promise(resolveTick => setTimeout(resolveTick, 0))
      if (needsRender) await render()
    }
    return tree
  }

  return { flush, get tree() { return tree } }
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) findAll(child, predicate, out)
  return out
}

function textOfNode(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOfNode).join('')
  return (node.children || []).map(textOfNode).join('')
}

const INSTANCE_METRICS = {
  ok: true,
  schemaVersion: 1,
  instanceId: 'i-1',
  status: 'ACTIVE',
  asOf: '2026-11-12T00:00:20.000Z',
  throughSeq: 12,
  complete: true,
  duration: { wallMs: 20_000, suspendedMs: null },
  agent: {
    invocations: 2,
    modelCalls: null,
    observedTokens: null,
    usageCoverage: { known: 0, unknown: 2 },
    buckets: { seen: [], missing: ['input', 'cacheRead', 'cacheWrite', 'output'] },
  },
  human: { completedWaitMs: 0, currentWaitMs: 12_000, canceledWaitMs: 0, interruptedWaitMs: 0 },
  finishReminder: { fires: 3, missingExecutions: 1 },
  connector: {
    succeeded: 2, errored: 1, canceled: 0, inFlight: 0, unknown: 0,
    successRate: 0.666667,
    attempts: { total: 3, results: 2, succeeded: 1, successRate: 0.5 },
    latency: {
      request: { samples: 2, p50Ms: 100, p95Ms: 300, minMs: 100, maxMs: 300, values: [100, 300] },
      total: { samples: 2, p50Ms: 1_000, p95Ms: 2_000, minMs: 1_000, maxMs: 2_000, values: [1_000, 2_000] },
    },
  },
  nodes: {
    executed: 2,
    completed: 1,
    errored: 1,
    canceled: 0,
    interrupted: 0,
    running: 0,
    waiting: 1,
    executions: [],
    active: [{ executionId: 'e2', elementId: 'human1', status: 'waiting' }],
    waitingTasks: [{ executionId: 'e2', elementId: 'human1', since: '2026-11-12T00:00:08.000Z', waitedMs: 12_000 }],
  },
  business: { source: 'instance.variables', note: '业务指标', scalars: { progress: 3 } },
  dataQuality: { skippedEvents: 0, skippedResources: 0, reasons: ['usage-unavailable'] },
}

test('客户端 API 路径与查询串', () => {
  assert.equal(instanceMetricsPath('i-1'), '/instances/i-1/metrics')
  assert.equal(instanceMetricsPath('i-1', { asOf: '2026-11-12T00:00:00.000Z' }),
    '/instances/i-1/metrics?asOf=2026-11-12T00%3A00%3A00.000Z')
  assert.equal(metricsPath({ groupBy: 'day' }), '/metrics?groupBy=day')
  assert.equal(metricsPath({ definitionId: 'flow-a', definitionVersion: 2, status: 'COMPLETED', groupBy: 'day' }),
    '/metrics?definitionId=flow-a&definitionVersion=2&status=COMPLETED&groupBy=day')
})

test('未知不是零：null 显示未知 / 无样本，0 显示 0', () => {
  assert.equal(formatDurationMs(null), '未知')
  assert.equal(formatDurationMs(undefined), '未知')
  assert.equal(formatDurationMs(0), '0ms')
  assert.equal(formatDurationMs(1_500), '1.5s')
  assert.equal(formatDurationMs(65_000), '1m5s')

  assert.equal(formatTokens(null), '未知')
  assert.equal(formatTokens({ total: 0 }), '0')
  assert.equal(tokenBreakdownText(null), '')

  assert.equal(successRateText(null), '无样本')
  assert.equal(successRateText(0), '0%')
  assert.equal(successRateText(0.666667), '66.7%')

  assert.equal(coverageText({ known: 0, unknown: 2 }), '已观测 0 · 未知 2')
  assert.equal(latencyText({ request: null, total: null }), '请求 无样本；总耗时 无样本')
  assert.equal(metricsReasonText('usage-unavailable'), '没有可观测的 usage（token 未知，不是 0）')
  assert.equal(metricsReasonText('custom-reason'), 'custom-reason')
  assert.equal(metricsShouldPoll('ACTIVE'), true)
  assert.equal(metricsShouldPoll('COMPLETED'), false)
  assert.equal(metricsSections(null), null)
})

test('单实例指标面板：未知 token / 覆盖率 / 等待 / connector / 原因都上屏', async () => {
  const calls = []
  const client = {
    async readInstanceMetrics(id) {
      calls.push(id)
      return INSTANCE_METRICS
    },
  }
  const harness = createHarness(InstanceMetricsPanel, { client, instanceId: 'i-1', instanceStatus: 'ACTIVE' })
  const tree = await harness.flush()
  const text = textOfNode(tree)
  assert.equal(calls[0], 'i-1')
  assert.match(text, /运行指标/)
  assert.match(text, /墙钟耗时20s/)
  assert.match(text, /挂起耗时未知/)
  assert.match(text, /当前人工等待12s/)
  assert.match(text, /观测 token未知/)
  assert.match(text, /已观测 0 · 未知 2/)
  assert.match(text, /connector 执行成功率66\.7%/)
  assert.match(text, /connector attempt 成功率50%/)
  assert.match(text, /没有可观测的 usage/)
  assert.match(text, /业务指标/)
  assert.ok(text.includes('"progress":3'))
  const errorNodes = findAll(tree, node => node.props && node.props['data-metrics-error'] === 'true')
  assert.equal(errorNodes.length, 0)
})

test('汇总面板：实例数 / 状态 / 每日分组', async () => {
  const calls = []
  const client = {
    async readMetrics(options) {
      calls.push(options)
      return {
        ok: true,
        schemaVersion: 1,
        generatedAt: '2026-11-12T00:00:20.000Z',
        cohort: { createdAt: 'instance.createdAt', groupBy: 'day' },
        totals: {
          instances: 3,
          byStatus: { ACTIVE: 1, COMPLETED: 2, SUSPENDED: 0, CANCELED: 0 },
          duration: { wallMs: 30_000, suspendedMs: 0 },
          agent: { observedTokens: null },
          connector: { successRate: null },
          dataQuality: { skippedInstances: 1 },
        },
        groups: [
          {
            key: '2026-11-12',
            instances: 2,
            duration: { wallMs: 20_000 },
            agent: { observedTokens: null },
            connector: { successRate: 0.5 },
          },
        ],
      }
    },
  }
  const harness = createHarness(MetricsSummaryPanel, { client })
  const tree = await harness.flush()
  const text = textOfNode(tree)
  assert.deepEqual(calls, [{ groupBy: 'day' }])
  assert.match(text, /指标汇总/)
  assert.match(text, /实例数3/)
  assert.match(text, /活跃 1 · 完成 2/)
  assert.match(text, /token 合计未知/)
  assert.match(text, /connector 成功率无样本/)
  assert.match(text, /2026-11-12/)
  assert.match(text, /2 个实例/)
})

test('失败文案保留服务端原因；客户端缺接口时面板不崩', async () => {
  const plan = metricsFailurePlan('instance', {
    status: 400,
    data: { error: 'asOf 必须是可解析的 ISO 时间' },
  })
  assert.equal(plan.kind, 'error')
  assert.match(plan.text, /asOf 必须是可解析的 ISO 时间/)

  const network = metricsFailurePlan('summary', { status: 0, message: 'fetch failed' })
  assert.equal(network.kind, 'error')
  assert.match(network.text, /连不上 Host/)

  const harness = createHarness(InstanceMetricsPanel, { client: {}, instanceId: 'i-1' })
  const tree = await harness.flush()
  assert.match(textOfNode(tree), /当前客户端没有指标接口/)
})
