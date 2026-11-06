#!/usr/bin/env node
/**
 * 真 codex 冒烟（07 §6 / 06 §17.9）：建一条「start → codex 节点 → end」的流程，真跑一次
 * `codex exec`，然后打印 run 状态、节点判定、usage 与事件链。
 *
 * 用法：node scripts/codex-smoke.mjs
 * 前提：本机已装 codex CLI 并登录（`codex login status`）；会真的调模型、产生 token 消耗。
 * 产物落在 `<repo>/.tmp/codex-smoke-run-*`（不写 /tmp），跑完可自行删除。
 */
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const model = await import('../src/model.js')
const store = await import('../src/runstore.js')
const flowStore = await import('../src/store.js')
const { createEngine } = await import('../src/engine.js')

mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const root = mkdtempSync(join(repoRoot, '.tmp', 'codex-smoke-run-'))
const home = join(root, 'home')
const runsRoot = store.runsDir(home)
const flowsRoot = flowStore.flowsDir(home)
const ws = join(root, 'ws')
mkdirSync(ws, { recursive: true })

const flow = {
  id: 'flow-codex-smoke',
  name: 'codex 冒烟',
  nodes: [
    { id: 'n_start', kind: 'start', title: '任务输入', x: 0, y: 200, mode: 'single', role: '', task: '接任务', outputs: '', skills: [], maxRounds: 2, team: [], model: '' },
    {
      id: 'n_codex', kind: 'stage', title: '外部编码', x: 300, y: 200, mode: 'single',
      role: '资深工程师', task: '用一句话说明 1+1 等于几，并给出 verdict=pass', outputs: '结论',
      skills: [], maxRounds: 2, team: [], model: '',
      executor: 'codex', executorCommand: '',
    },
    { id: 'n_end', kind: 'end', title: '完成', x: 900, y: 200, mode: 'single', role: '', task: '', outputs: '', skills: [], maxRounds: 2, team: [], model: '' },
  ],
  edges: [
    { id: 'e1', from: 'n_start', to: 'n_codex', kind: 'next', label: '' },
    { id: 'e2', from: 'n_codex', to: 'n_end', kind: 'next', label: '' },
  ],
}

const normalized = model.normalizeFlow(flow)
await flowStore.saveFlow(flowsRoot, normalized.id, normalized)
const run = await store.createRun(runsRoot, { flowId: normalized.id, flowName: normalized.name, nodeTotal: 1 })
const engine = createEngine({ runsRoot, flowsRoot })
const startedAt = Date.now()
try {
  await engine.start(run.id, { workspace: ws, worktree: 'off' })
  const final = await engine.wait(run.id)
  const all = await store.readAllEvents(runsRoot, run.id)
  const events = all ? all.events : []
  const nodeEnd = events.find(event => event.kind === 'node/end' && event.nodeId === 'n_codex')
  const calls = events.filter(event => event.kind === 'model/call')
  const usage = calls.reduce((acc, call) => ({
    input: acc.input + (call.data.usage.input || 0),
    output: acc.output + (call.data.usage.output || 0),
  }), { input: 0, output: 0 })
  const schemaPath = join(runsRoot, run.id, 'executors', '1.schema.json')

  console.log('run.status      =', final.status, '| elapsedMs =', Date.now() - startedAt)
  console.log('node/end.status =', nodeEnd && nodeEnd.data.status)
  console.log('node/end.extra  =', JSON.stringify(nodeEnd && nodeEnd.extra ? nodeEnd.extra : {}))
  console.log('model/call      =', calls.length, '| provider =', calls[0] ? calls[0].data.provider : '-', '| usage 合计 =', JSON.stringify(usage))
  console.log('schema 严格化   =', existsSync(schemaPath) && JSON.parse(readFileSync(schemaPath, 'utf8')).additionalProperties === false)
  console.log('事件 kind       =', JSON.stringify([...new Set(events.map(event => event.kind))]))
  const ok = final.status === 'done' && nodeEnd && nodeEnd.data.status === 'passed' && usage.input > 0
  console.log(ok ? '\n✓ 真 codex 冒烟通过' : '\n✗ 真 codex 冒烟失败')
  process.exitCode = ok ? 0 : 1
} finally {
  await engine.dispose?.()
  if (process.env.KEEP_SMOKE !== '1') rmSync(root, { recursive: true, force: true })
  else console.log('现场保留：', root)
}
