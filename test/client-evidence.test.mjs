#!/usr/bin/env node
/**
 * 实例证据客户端自检（0.13.12 E2）：
 *  - `GET /instances/<id>/evidence` 路径 / asOf 查询串；
 *  - fixed 无复验引用不得渲染 verified；有复验引用时徽标语义只是「引用已核对」；
 *  - 缺报告 / missing / conflicts / stub / 来源 execution 都上屏；
 *  - 不产出「优 / 良 / 差」或统一 pass / warn / fail 总评级。
 *
 * 交互用最小 hooks 探针（真实 React createElement），不发真实 fetch。
 * 运行：node test/client-evidence.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import React from 'react'

import { instanceEvidencePath } from '../src/client/api.js'
import {
  InstanceEvidencePanel, claimValueText, evidenceFailurePlan, evidenceReasonText,
  evidenceSections, evidenceStatusText, findingBadge,
} from '../src/client/instance-evidence.js'
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

const EVIDENCE = {
  ok: true,
  schema: 'flow-evidence/v1',
  instanceId: 'i-1',
  instanceStatus: 'ACTIVE',
  asOf: '2026-11-12T00:00:20.000Z',
  claims: [{
    id: 'tests', type: 'test-result', value: 'passed',
    source: 'report-claim', trust: 'report-claim', valueTrust: 'report-claim',
    executionId: 'exec-1', nodeId: 'review', attempt: 1,
    reportPath: 'evidence/report.json', reportSha256: 'a'.repeat(64),
    refs: [{ path: 'reports/tests.txt', sha256: 'b'.repeat(64), resolvedFrom: 'artifact-snapshot', verified: true }],
    refsChecked: true, verifiedRefs: [], conflict: false,
  }],
  findings: [{
    id: 'F-12', status: 'fixed', declaredStatus: 'fixed', displayStatus: 'verified', verified: true,
    refsChecked: true,
    refs: [{ path: 'reports/tests.txt', sha256: 'b'.repeat(64), resolvedFrom: 'artifact-snapshot', verified: true }],
    conclusion: 'report-claim', conclusionVerified: false,
    source: 'report-claim', trust: 'report-claim',
    executionId: 'exec-1', nodeId: 'review', attempt: 1,
    reportPath: 'evidence/report.json', reportSha256: 'a'.repeat(64), conflict: false,
  }],
  verifiedRefs: [
    { path: 'reports/tests.txt', sha256: 'b'.repeat(64), resolvedFrom: 'artifact-snapshot' },
  ],
  missing: [{ kind: 'claim', id: 'coverage', reason: 'claim-without-refs' }],
  conflicts: [{ kind: 'claim-value-conflict', id: 'tests' }],
  sourceExecutions: [{
    executionId: 'exec-1', nodeId: 'review',
    reportPaths: ['evidence/report.json'], reportSha256: ['a'.repeat(64)],
    reportHashVerified: true, source: 'host-registration',
  }],
  dataQuality: {
    evidenceStatus: 'partial', unknown: false, stub: true,
    reportCount: 1, parsedReportCount: 1, claimCount: 1, findingCount: 1,
    verifiedRefCount: 1, missingCount: 1, conflictCount: 1,
    snapshotMissing: 0, workspaceFallbacks: 0,
    reasons: ['report-stub', 'claim-value-conflict'],
    contributesToAdmission: false, injectedIntoInstanceState: false,
  },
}

test('客户端 API 路径与 asOf 查询串', () => {
  assert.equal(instanceEvidencePath('i-1'), '/instances/i-1/evidence')
  assert.equal(instanceEvidencePath('i-1', { asOf: '2026-11-12T00:00:00.000Z' }),
    '/instances/i-1/evidence?asOf=2026-11-12T00%3A00%3A00.000Z')
})

test('fixed 无复验引用不得显示 verified；有引用时徽标只表示引用已核对', () => {
  const noRefs = findingBadge({ status: 'fixed', verified: false, refsChecked: false })
  assert.equal(noRefs.tone, 'neutral')
  assert.doesNotMatch(noRefs.text, /^verified/)
  assert.match(noRefs.text, /fixed.*未复验/)
  const verified = findingBadge({ status: 'fixed', verified: true, refsChecked: true })
  assert.equal(verified.tone, 'verified')
  assert.match(verified.text, /复验引用已核对/)
  assert.equal(findingBadge({ status: 'open', verified: false }).text, 'open')
  const selfVerified = findingBadge({ status: 'verified', verified: false })
  assert.equal(selfVerified.tone, 'neutral')
  assert.match(selfVerified.text, /claimed-verified/)
  assert.doesNotMatch(selfVerified.text, /^verified/)
})

test('未知不是通过：missing / invalid / stub 文案，不含总评级', () => {
  assert.match(evidenceStatusText('missing'), /未知/)
  assert.match(evidenceStatusText('invalid'), /未知/)
  assert.match(evidenceStatusText('partial'), /部分/)
  assert.match(evidenceStatusText('present'), /已读/)
  assert.equal(evidenceReasonText('no-evidence-report'), '没有登记证据报告；质量结论未知')
  assert.equal(evidenceReasonText('custom'), 'custom')
  assert.equal(claimValueText(null), 'null')
  assert.equal(claimValueText('passed'), 'passed')
  assert.equal(claimValueText(3), '3')
  assert.equal(evidenceSections(null), null)
})

test('失败文案保留服务端原因', () => {
  assert.match(evidenceFailurePlan({ status: 400, data: { error: 'asOf 非法' } }).text, /asOf 非法/)
  assert.match(evidenceFailurePlan({ status: 404 }).text, /实例可能已被删除/)
  assert.match(evidenceFailurePlan({ status: 0, message: 'offline' }).text, /连不上 Host/)
})

test('证据面板：claims / findings / missing / conflicts / stub / 来源都上屏，且不出现总评级', async () => {
  const calls = []
  const client = {
    async readInstanceEvidence(id) {
      calls.push(id)
      return EVIDENCE
    },
  }
  const harness = createHarness(InstanceEvidencePanel, { client, instanceId: 'i-1', instanceStatus: 'ACTIVE' })
  const tree = await harness.flush()
  const text = textOfNode(tree)
  assert.equal(calls[0], 'i-1')
  assert.match(text, /证据/)
  assert.match(text, /不产出总评级/)
  assert.match(text, /部分：报告已读/)
  assert.match(text, /桩报告：不是真实质量通过/)
  assert.match(text, /tests/)
  assert.match(text, /passed/)
  assert.match(text, /报告自述/)
  assert.match(text, /F-12/)
  assert.match(text, /verified（复验引用已核对）/)
  assert.match(text, /结论：报告自述（未经宿主业务裁决）/)
  assert.match(text, /claim-without-refs/)
  assert.match(text, /claim-value-conflict/)
  assert.match(text, /来源 execution/)
  assert.match(text, /已核对引用/)
  assert.doesNotMatch(text, /优：|良：|差：/)
  assert.doesNotMatch(text, /总评级[:：]\s*(pass|warn|fail)/i)

  const verifiedBadges = findAll(tree, node => node.props && node.props['data-evidence-badge'] === 'verified')
  assert.equal(verifiedBadges.length, 1, '只有 verified=true 的 finding 显示 verified 徽标')
  const stub = findAll(tree, node => node.props && node.props['data-evidence-stub'] === 'true')
  assert.equal(stub.length, 1)
  const errorNodes = findAll(tree, node => node.props && node.props['data-evidence-error'] === 'true')
  assert.equal(errorNodes.length, 0)
})

test('缺报告面板：missing 明说未知，不渲染「全部通过」', async () => {
  const client = {
    async readInstanceEvidence() {
      return {
        ok: true,
        schema: 'flow-evidence/v1',
        claims: [],
        findings: [],
        verifiedRefs: [],
        missing: [{ kind: 'report', reason: 'no-evidence-report' }],
        conflicts: [],
        sourceExecutions: [],
        dataQuality: {
          evidenceStatus: 'missing', unknown: true, stub: false,
          reportCount: 0, parsedReportCount: 0, claimCount: 0, findingCount: 0,
          verifiedRefCount: 0, missingCount: 1, conflictCount: 0,
          snapshotMissing: 0, workspaceFallbacks: 0, reasons: ['no-evidence-report'],
        },
      }
    },
  }
  const harness = createHarness(InstanceEvidencePanel, { client, instanceId: 'i-none' })
  const text = textOfNode(await harness.flush())
  assert.match(text, /未知：没有证据报告/)
  assert.match(text, /没有 claims；空报告不等于「全部通过」/)
  assert.match(text, /没有登记证据报告；质量结论未知/)
  assert.match(text, /空报告不等于「全部通过」/)
  assert.doesNotMatch(text, /优：|良：|差：/)
})
