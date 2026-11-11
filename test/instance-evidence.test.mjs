#!/usr/bin/env node
/**
 * 实例业务证据自检（0.13.12 E2）。
 *
 * 覆盖硬语义：
 *   1. 缺报告 = missing / unknown，不是空 claims 的「全部通过」；
 *   2. `fixed` 没有复验引用 → 不显示 verified；
 *   3. hash 不匹配 → 不进 verifiedRefs，并进 conflicts；
 *   4. 同 ID 不同 value / status → conflicts；不同 execution 各留来源；
 *   5. 报告自称 producer:"host" 不得获得宿主身份；桩报告可辨认；
 *   6. 引用优先命中 artifact 快照；工作区目录删掉后仍能读回且 hash 一致；
 *   7. `GET /instances/<id>/evidence` 纯读：不建 runner、不懒恢复；
 *      实例不存在 404、参数非法 400。
 *
 * 不真跑 agent / codex：runtime 用例用注入的假 adapter 走同一套
 * `flow_finish_node` 完结门与 artifact 快照。产物落在项目 `.tmp/`。
 *
 * 运行：node test/instance-evidence.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const {
  EVIDENCE_SCHEMA, EVIDENCE_REASON, collectInstanceEvidence, isSafeEvidencePath,
} = await import('../src/instance-evidence.js')
const { createArtifactStore } = await import('../src/artifact-store.js')

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

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

function reportText({ executionId = 'exec-1', claims = [], findings = [], extra = {} } = {}) {
  return JSON.stringify({
    schema: EVIDENCE_SCHEMA,
    executionId,
    claims,
    findings,
    ...extra,
  }, null, 2)
}

/** 报告文档登记项（与 instance.json.artifacts[] 同形状）。 */
function reportDoc(text, overrides = {}) {
  const content = Buffer.from(text, 'utf8')
  return {
    path: 'evidence/report.json',
    sha256: sha256(text),
    bytes: content.length,
    kind: 'evidence-report',
    title: '证据报告',
    executionId: 'exec-1',
    nodeId: 'review',
    attempt: 1,
    at: '2026-11-12T00:00:00.000Z',
    contentRef: `artifacts/${sha256(text)}`,
    ...overrides,
  }
}

function ref(path, text) {
  return { path, sha256: sha256(text) }
}

/** 把报告与其引用内容都放进快照索引。 */
function snapshotsFor(report, files = {}) {
  const map = new Map()
  map.set(sha256(report), Buffer.from(report, 'utf8'))
  for (const [path, text] of Object.entries(files)) map.set(sha256(text), Buffer.from(text, 'utf8'))
  return map
}

// ---------------------------------------------------------------------------
// 1. 缺报告 / 空报告：unknown，不是全绿
// ---------------------------------------------------------------------------
await check('缺报告 → missing / unknown，claims 为空但不表示全部通过', () => {
  const result = collectInstanceEvidence({
    instance: { id: 'i-1', status: 'ACTIVE' },
    documents: [],
    events: [],
  })
  eq(result.schema, EVIDENCE_SCHEMA)
  eq(result.claims.length, 0)
  eq(result.missing[0].reason, EVIDENCE_REASON.NO_REPORT)
  eq(result.dataQuality.evidenceStatus, 'missing')
  eq(result.dataQuality.unknown, true)
  ok(result.dataQuality.reasons.includes(EVIDENCE_REASON.NO_REPORT))
  eq(result.dataQuality.contributesToAdmission, false, '证据不参与 admission')
  eq(result.dataQuality.injectedIntoInstanceState, false, 'findings 不注入实例状态')
})

await check('空报告（无 claims / findings）→ report-empty，不能当成全部通过', () => {
  const text = reportText({ claims: [], findings: [] })
  const result = collectInstanceEvidence({
    documents: [reportDoc(text)],
    snapshots: snapshotsFor(text),
    workspaceAvailable: true,
  })
  eq(result.claims.length, 0)
  ok(result.missing.some(item => item.reason === EVIDENCE_REASON.REPORT_EMPTY))
  eq(result.dataQuality.evidenceStatus, 'partial')
})

await check('报告 schema 不匹配 → missing，不静默接受', () => {
  const text = JSON.stringify({ schema: 'other/v9', executionId: 'x', claims: [], findings: [] })
  const result = collectInstanceEvidence({
    documents: [reportDoc(text)],
    snapshots: snapshotsFor(text),
    workspaceAvailable: true,
  })
  eq(result.dataQuality.evidenceStatus, 'invalid')
  ok(result.missing.some(item => item.reason === EVIDENCE_REASON.REPORT_SCHEMA_MISMATCH))
})

// ---------------------------------------------------------------------------
// 2. fixed ≠ verified
// ---------------------------------------------------------------------------
await check('fixed 没有复验引用 → 不显示 verified（缺引用可见）', () => {
  const text = reportText({
    claims: [{
      id: 'tests', type: 'test-result', value: 'passed',
      refs: [ref('reports/tests.txt', '34 tests passed\n')],
    }],
    findings: [{ id: 'F-12', status: 'fixed', refs: [] }],
  })
  const result = collectInstanceEvidence({
    documents: [reportDoc(text)],
    snapshots: snapshotsFor(text, { 'reports/tests.txt': '34 tests passed\n' }),
    workspaceAvailable: true,
  })
  eq(result.findings.length, 1)
  eq(result.findings[0].status, 'fixed')
  eq(result.findings[0].verified, false, '无复验引用的 fixed 不能 verified')
  eq(result.findings[0].displayStatus, 'fixed')
  ok(result.missing.some(item => item.reason === EVIDENCE_REASON.FIXED_WITHOUT_REFS))
})

await check('fixed 带复验引用但只命中工作区回落 → 不算复验，不显示 verified', () => {
  const tests = '34 tests passed\n'
  const text = reportText({
    claims: [{ id: 'tests', type: 'test-result', value: 'passed', refs: [ref('reports/tests.txt', tests)] }],
    findings: [{ id: 'F-12', status: 'fixed', refs: [ref('reports/tests.txt', tests)] }],
  })
  const result = collectInstanceEvidence({
    documents: [reportDoc(text)],
    snapshots: snapshotsFor(text),
    workspaceFiles: new Map([['reports/tests.txt', tests]]),
    workspaceAvailable: true,
  })
  eq(result.findings[0].refs[0].resolvedFrom, 'workspace')
  eq(result.findings[0].verified, false, '只靠工作区回落不算复验引用')
  eq(result.findings[0].displayStatus, 'fixed')
  ok(result.missing.some(item => item.reason === EVIDENCE_REASON.FIXED_REFS_UNVERIFIED))
})

await check('报告自称 finding status=verified → 不显示 verified（claimed-verified）', () => {
  const text = reportText({
    claims: [],
    findings: [{ id: 'F-self', status: 'verified', refs: [] }],
  })
  const result = collectInstanceEvidence({
    documents: [reportDoc(text)],
    snapshots: snapshotsFor(text),
    workspaceAvailable: true,
  })
  eq(result.findings[0].verified, false)
  eq(result.findings[0].displayStatus, 'claimed-verified')
  ok(result.missing.some(item => item.reason === EVIDENCE_REASON.SELF_VERIFIED_CLAIM))
})

await check('fixed 带复验引用且命中归档快照 → verified=true，但结论仍是 report-claim', () => {
  const tests = '34 tests passed\n'
  const text = reportText({
    claims: [{ id: 'tests', type: 'test-result', value: 'passed', refs: [ref('reports/tests.txt', tests)] }],
    findings: [{ id: 'F-12', status: 'fixed', refs: [ref('reports/tests.txt', tests)] }],
  })
  const result = collectInstanceEvidence({
    documents: [reportDoc(text)],
    snapshots: snapshotsFor(text, { 'reports/tests.txt': tests }),
    workspaceAvailable: true,
  })
  eq(result.findings[0].verified, true)
  eq(result.findings[0].displayStatus, 'verified')
  eq(result.findings[0].refsChecked, true)
  eq(result.findings[0].conclusion, 'report-claim', 'hash 核对不改变结论来源')
  eq(result.findings[0].conclusionVerified, false, '文件一致不证明结论正确')
  eq(result.claims[0].refsChecked, true)
  eq(result.claims[0].valueTrust, 'report-claim')
  eq(result.dataQuality.verifiedRefCount, 2)
})

// ---------------------------------------------------------------------------
// 3. hash 不匹配
// ---------------------------------------------------------------------------
await check('hash 不匹配 → 不进 verifiedRefs，并进 conflicts', () => {
  const tests = '34 tests passed\n'
  const fakeSha = 'f'.repeat(64)
  const text = reportText({
    claims: [{
      id: 'tests', type: 'test-result', value: 'passed',
      refs: [{ path: 'reports/tests.txt', sha256: fakeSha }],
    }],
    findings: [{ id: 'F-1', status: 'fixed', refs: [{ path: 'reports/tests.txt', sha256: fakeSha }] }],
  })
  const snapshots = new Map()
  snapshots.set(sha256(text), Buffer.from(text, 'utf8'))
  // 快照索引里存在这个 key，但内容 hash 与声明值不一致。
  snapshots.set(fakeSha, Buffer.from(tests, 'utf8'))
  const result = collectInstanceEvidence({
    documents: [reportDoc(text)],
    snapshots,
    workspaceAvailable: false,
  })
  eq(result.verifiedRefs.length, 1, '只有报告自身的引用通过核对')
  ok(result.verifiedRefs.every(item => item.path !== 'reports/tests.txt'), 'hash 不匹配的引用不得进 verifiedRefs')
  ok(result.conflicts.some(item => item.kind === EVIDENCE_REASON.REF_HASH_MISMATCH))
  eq(result.findings[0].verified, false)
  eq(result.findings[0].refsChecked, false)
})

// ---------------------------------------------------------------------------
// 4. 同 ID 冲突 / 不同 execution 各留来源
// ---------------------------------------------------------------------------
await check('同一 execution 内同 ID 不同 value → conflicts，两个 claim 都标冲突', () => {
  const text = reportText({
    claims: [
      { id: 'tests', type: 'test-result', value: 'passed', refs: [] },
      { id: 'tests', type: 'test-result', value: 'failed', refs: [] },
    ],
    findings: [],
  })
  const result = collectInstanceEvidence({
    documents: [reportDoc(text)],
    snapshots: snapshotsFor(text),
    workspaceAvailable: true,
  })
  eq(result.claims.length, 2)
  ok(result.claims.every(item => item.conflict === true))
  ok(result.conflicts.some(item => item.kind === EVIDENCE_REASON.CLAIM_VALUE_CONFLICT))
})

await check('不同 execution 同 ID 不同 value → 两条来源都保留，并记录跨执行分歧', () => {
  const textA = reportText({
    executionId: 'exec-A',
    claims: [{ id: 'tests', type: 'test-result', value: 'passed', refs: [] }],
    findings: [],
  })
  const textB = reportText({
    executionId: 'exec-B',
    claims: [{ id: 'tests', type: 'test-result', value: 'failed', refs: [] }],
    findings: [],
  })
  const result = collectInstanceEvidence({
    documents: [
      reportDoc(textA, { path: 'evidence/a.json', executionId: 'exec-A' }),
      reportDoc(textB, { path: 'evidence/b.json', executionId: 'exec-B' }),
    ],
    snapshots: new Map([
      [sha256(textA), Buffer.from(textA, 'utf8')],
      [sha256(textB), Buffer.from(textB, 'utf8')],
    ]),
    workspaceAvailable: true,
  })
  eq(result.claims.length, 2, '不同循环的证据不互相失效')
  deep(result.sourceExecutions.map(item => item.executionId).sort(), ['exec-A', 'exec-B'])
  ok(result.conflicts.some(item => item.kind === EVIDENCE_REASON.CROSS_EXECUTION_CLAIM_DIVERGENCE))
})

await check('同一 execution 内同 ID finding 不同 status → conflicts', () => {
  const text = reportText({
    claims: [],
    findings: [
      { id: 'F-9', status: 'fixed', refs: [] },
      { id: 'F-9', status: 'open', refs: [] },
    ],
  })
  const result = collectInstanceEvidence({
    documents: [reportDoc(text)],
    snapshots: snapshotsFor(text),
    workspaceAvailable: true,
  })
  eq(result.findings.length, 2)
  ok(result.findings.every(item => item.conflict === true))
  ok(result.conflicts.some(item => item.kind === EVIDENCE_REASON.FINDING_STATUS_CONFLICT))
})

// ---------------------------------------------------------------------------
// 5. 来源与可信级别
// ---------------------------------------------------------------------------
await check('报告自称 producer:"host" 不获得宿主身份；source 固定 report-claim', () => {
  const text = reportText({
    claims: [{ id: 'tests', type: 'test-result', value: 'passed', refs: [] }],
    findings: [{ id: 'F-1', status: 'fixed', refs: [] }],
    extra: { producer: 'host', authority: 'host', trust: 'host' },
  })
  const result = collectInstanceEvidence({
    documents: [reportDoc(text)],
    snapshots: snapshotsFor(text),
    workspaceAvailable: true,
  })
  eq(result.claims[0].source, 'report-claim')
  eq(result.claims[0].trust, 'report-claim')
  eq(result.findings[0].source, 'report-claim')
  ok(result.dataQuality.producerSelfClaims.length >= 1)
  ok(result.dataQuality.reasons.includes(EVIDENCE_REASON.PRODUCER_SELF_CLAIM_IGNORED))
  eq(result.dataQuality.stub, false, '自称 host 不是桩，但也不会变成宿主证据')
})

await check('桩报告可辨认：dataQuality.stub=true + report-stub 原因', () => {
  const text = reportText({
    claims: [{ id: 'tests', type: 'test-result', value: 'passed', refs: [] }],
    findings: [],
    extra: { stub: true },
  })
  const result = collectInstanceEvidence({
    documents: [reportDoc(text)],
    snapshots: snapshotsFor(text),
    workspaceAvailable: true,
  })
  eq(result.dataQuality.stub, true)
  ok(result.dataQuality.reasons.includes(EVIDENCE_REASON.REPORT_STUB))
  eq(result.claims[0].source, 'report-claim')
})

// ---------------------------------------------------------------------------
// 6. 快照优先 / 工作区清理
// ---------------------------------------------------------------------------
await check('引用优先命中 artifact 快照，不读同路径工作区内容', () => {
  const tests = '34 tests passed\n'
  const text = reportText({
    claims: [{ id: 'tests', type: 'test-result', value: 'passed', refs: [ref('reports/tests.txt', tests)] }],
    findings: [],
  })
  const result = collectInstanceEvidence({
    documents: [reportDoc(text)],
    snapshots: snapshotsFor(text, { 'reports/tests.txt': tests }),
    workspaceFiles: new Map([['reports/tests.txt', 'different content\n']]),
    workspaceAvailable: true,
  })
  eq(result.claims[0].refsChecked, true)
  eq(result.claims[0].refs[0].resolvedFrom, 'artifact-snapshot')
  eq(result.dataQuality.workspaceFallbacks, 0)
})

await check('快照缺失才回落工作区，并在 dataQuality 标 workspace-fallback', () => {
  const tests = '34 tests passed\n'
  const text = reportText({
    claims: [{ id: 'tests', type: 'test-result', value: 'passed', refs: [ref('reports/tests.txt', tests)] }],
    findings: [],
  })
  const result = collectInstanceEvidence({
    documents: [reportDoc(text)],
    snapshots: snapshotsFor(text),
    workspaceFiles: new Map([['reports/tests.txt', tests]]),
    workspaceAvailable: true,
  })
  eq(result.claims[0].refsChecked, true)
  eq(result.claims[0].refs[0].resolvedFrom, 'workspace')
  eq(result.dataQuality.workspaceFallbacks, 1)
  ok(result.dataQuality.reasons.includes(EVIDENCE_REASON.SNAPSHOT_MISSING))
  ok(result.dataQuality.reasons.includes(EVIDENCE_REASON.WORKSPACE_FALLBACK))
})

await check('工作区目录删掉后，artifact 快照仍可读且 hash 一致', async () => {
  const home = mkdtempSync(join(repoRoot, '.tmp', 'evidence-snapshot-'))
  try {
    const workspace = join(home, 'ws')
    mkdirSync(join(workspace, 'reports'), { recursive: true })
    const tests = '34 tests passed\n'
    writeFileSync(join(workspace, 'reports', 'tests.txt'), tests)
    const store = createArtifactStore({ root: join(home, 'artifacts') })
    const captured = await store.captureFile(join(workspace, 'reports', 'tests.txt'))
    eq(captured.sha256, sha256(tests), '快照 hash 与文件内容一致')

    const text = reportText({
      claims: [{ id: 'tests', type: 'test-result', value: 'passed', refs: [{ path: 'reports/tests.txt', sha256: captured.sha256 }] }],
      findings: [{ id: 'F-1', status: 'fixed', refs: [{ path: 'reports/tests.txt', sha256: captured.sha256 }] }],
    })
    const reportCaptured = await store.put(Buffer.from(text, 'utf8'))
    // 清理工作区：原文件与目录都不在了。
    rmSync(workspace, { recursive: true, force: true })

    const snapshots = new Map([
      [reportCaptured.sha256, await store.read(reportCaptured.sha256)],
      [captured.sha256, await store.read(captured.sha256)],
    ])
    const result = collectInstanceEvidence({
      documents: [reportDoc(text, {
        sha256: reportCaptured.sha256,
        contentRef: reportCaptured.contentRef,
        executionId: 'exec-1',
      })],
      snapshots,
      workspaceFiles: new Map(),
      workspaceAvailable: false,
    })
    eq(result.claims[0].refsChecked, true, 'worktree 清理后引用仍能核对')
    eq(result.claims[0].refs[0].resolvedFrom, 'artifact-snapshot')
    eq(result.verifiedRefs.length, 2)
    eq(result.dataQuality.workspaceFallbacks, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('路径安全校验拒绝绝对路径 / .. / 反斜杠', () => {
  eq(isSafeEvidencePath('reports/tests.txt'), true)
  eq(isSafeEvidencePath('/etc/passwd'), false)
  eq(isSafeEvidencePath('../secret'), false)
  eq(isSafeEvidencePath('a/../b'), false)
  eq(isSafeEvidencePath('a\\b'), false)
  eq(isSafeEvidencePath('a//b'), false)
})

// ---------------------------------------------------------------------------
// 7. HTTP 路由：纯读、404、400
// ---------------------------------------------------------------------------
const { createBpmnRuntime } = await import('../src/bpmn-runtime.js')
const storeModule = await import('../src/store.js')

function makeFakeAdapter(writeReport) {
  return {
    id: 'dsh',
    async probe() { return { version: 'stub', helpDigest: 'stub' } },
    capabilities() { return { finishTool: 'native', hooks: { 'turn.stop': 'emulated' } } },
    async start(request) {
      const documents = await writeReport({
        workspaceRoot: request.workspaceRoot,
        executionId: request.ctx?.executionId ?? null,
      })
      const submitted = await request.finishGate.submit({
        variables: { evidence_done: true },
        documents,
        summary: 'evidence-report-stub',
      })
      return { exited: Promise.resolve({ ok: true, record: submitted.record }) }
    },
    async cancel() {},
    async dispose() {},
  }
}

function adaptersFor(adapter) {
  return { get: id => (id === adapter.id ? adapter : undefined), list: () => [adapter] }
}

function workflowXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:fs="http://feiyueve.dev/schema/bpmn/fs/1.0" id="defs-e2" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="proc-e2" name="证据流程" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="review" name="审查">
      <bpmn:extensionElements>
        <fs:node nodeType="agent" adapter="dsh"></fs:node>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:userTask id="human1" name="人工确认"/>
    <bpmn:endEvent id="end"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="review"/>
    <bpmn:sequenceFlow id="f2" sourceRef="review" targetRef="human1"/>
    <bpmn:sequenceFlow id="f3" sourceRef="human1" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`
}

await check('GET /instances/<id>/evidence 纯读：hash 一致、快照优先、清理工作区仍可读、不建 runner', async () => {
  const home = mkdtempSync(join(repoRoot, '.tmp', 'evidence-route-'))
  try {
    const ws = join(home, 'ws')
    mkdirSync(ws, { recursive: true })
    const tests = '34 tests passed\n'
    const adapter = makeFakeAdapter(async ({ workspaceRoot, executionId }) => {
      const report = reportText({
        executionId: executionId ?? 'exec-unknown',
        claims: [{ id: 'tests', type: 'test-result', value: 'passed', refs: [ref('reports/tests.txt', tests)] }],
        findings: [{ id: 'F-12', status: 'fixed', refs: [ref('reports/tests.txt', tests)] }],
      })
      mkdirSync(join(workspaceRoot, 'reports'), { recursive: true })
      writeFileSync(join(workspaceRoot, 'reports', 'tests.txt'), tests)
      mkdirSync(join(workspaceRoot, 'evidence'), { recursive: true })
      writeFileSync(join(workspaceRoot, 'evidence', 'report.json'), report)
      return [
        { path: 'reports/tests.txt', kind: 'test-result', title: '测试输出' },
        { path: 'evidence/report.json', kind: 'evidence-report', title: '证据报告' },
      ]
    })
    const makeRuntime = () => createBpmnRuntime({
      dir: storeModule.flowsDir(home),
      env: {},
      adapters: adaptersFor(adapter),
    })
    const runtimeA = makeRuntime()
    const url = new URL('http://localhost/')
    const saved = await runtimeA.handle({
      method: 'POST', parts: ['definitions'], url,
      body: { id: 'flow-e2', name: '证据', xml: workflowXml() },
    })
    eq(saved.status, 201, JSON.stringify(saved.body))
    const created = await runtimeA.handle({
      method: 'POST', parts: ['instances'], url,
      body: { definitionId: 'flow-e2', workspace: { path: ws, worktree: { mode: 'off' } } },
    })
    eq(created.status, 201, JSON.stringify(created.body))
    eq(created.body.status, 'ACTIVE')
    const instanceId = created.body.id
    await runtimeA.dispose()

    // 工作区目录整个删掉：只能靠 artifact 快照。
    rmSync(ws, { recursive: true, force: true })
    const runtimeB = makeRuntime()
    eq(runtimeB._runners.size, 0, '新 runtime 没有 runner')
    const evidence = await runtimeB.handle({ method: 'GET', parts: ['instances', instanceId, 'evidence'], url })
    eq(evidence.status, 200, JSON.stringify(evidence.body))
    eq(runtimeB._runners.size, 0, 'GET evidence 不建 runner / 不懒恢复')
    eq(evidence.body.ok, true)
    eq(evidence.body.schema, EVIDENCE_SCHEMA)
    eq(evidence.body.dataQuality.evidenceStatus, 'present')
    eq(evidence.body.dataQuality.workspaceFallbacks, 0)
    eq(evidence.body.claims.length, 1)
    eq(evidence.body.claims[0].refsChecked, true)
    eq(evidence.body.claims[0].refs[0].resolvedFrom, 'artifact-snapshot')
    eq(evidence.body.findings[0].verified, true)
    ok(evidence.body.verifiedRefs.length >= 2, '报告与测试输出引用都可核对')
    eq(evidence.body.sourceExecutions.length, 1)
    ok(typeof evidence.body.sourceExecutions[0].executionId === 'string'
      && evidence.body.sourceExecutions[0].executionId !== '', '来源 execution 由宿主登记')

    const missing = await runtimeB.handle({
      method: 'GET', parts: ['instances', 'i-does-not-exist', 'evidence'], url,
    })
    eq(missing.status, 404)
    eq(missing.body.code, 'INSTANCE_NOT_FOUND')

    const badAsOf = await runtimeB.handle({
      method: 'GET', parts: ['instances', instanceId, 'evidence'], url: new URL('http://localhost/?asOf=not-a-time'),
    })
    eq(badAsOf.status, 400)
    eq(badAsOf.body.code, 'EVIDENCE_AS_OF_INVALID')

    const wrongMethod = await runtimeB.handle({
      method: 'POST', parts: ['instances', instanceId, 'evidence'], url, body: {},
    })
    eq(wrongMethod.status, 405)
    eq(runtimeB._runners.size, 0)
    await runtimeB.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

console.log(`\ninstance-evidence: ${checks} checks / ${assertions} assertions passed`)
