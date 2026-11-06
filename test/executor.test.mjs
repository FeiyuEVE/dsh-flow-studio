#!/usr/bin/env node
/**
 * 外部 executor 自检（07 §6 / §8）。
 *
 * 除最后一组外全部走注入的假 spawn：手动 emit `data` / `close`，验证跨 chunk 半行、
 * 未知事件、usage、超时、abort 与非 0 退出。最后一组用真 node 子进程跑 `.tmp/` 下的
 * 桩脚本做端到端验证；**任何一组都不会真的调用 codex，也不联网**。
 *
 * 跑：`node test/executor.test.mjs`
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EXECUTORS, buildCodexArgs, normalizeExecutor, parseCodexLine, runExternalExecutor,
} from '../src/executor.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

let checks = 0
let assertionCount = 0
const A = {
  equal(actual, expected, message) {
    assertionCount += 1
    assert.equal(actual, expected, message)
  },
  deepEqual(actual, expected, message) {
    assertionCount += 1
    assert.deepEqual(actual, expected, message)
  },
  ok(value, message) {
    assertionCount += 1
    assert.ok(value, message)
  },
  match(value, pattern, message) {
    assertionCount += 1
    assert.match(value, pattern, message)
  },
}

/** 断言「抛 EXECUTOR_INVALID 且原因是中文」。 */
function throwsExecutor(fn, pattern, label) {
  assertionCount += 1
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'EXECUTOR_INVALID', `${label}：错误码应是 EXECUTOR_INVALID`)
    if (pattern) assert.match(error.message, pattern, `${label}：错误原因`)
    return true
  }, label)
}

/** async 版本的 EXECUTOR_INVALID 断言。 */
async function rejectsExecutor(promise, pattern, label) {
  assertionCount += 1
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, 'EXECUTOR_INVALID', `${label}：错误码应是 EXECUTOR_INVALID`)
    if (pattern) assert.match(error.message, pattern, `${label}：错误原因`)
    return true
  }, label)
}

/** 假 spawn：返回 EventEmitter 形状的子进程，测试手动 emit data / close / error。 */
function fakeSpawn() {
  const calls = []
  const children = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 4300 + children.length
    child.killed = false
    child.killSignals = []
    child.kill = (signal) => {
      child.killed = true
      child.killSignals.push(signal || 'SIGTERM')
      return true
    }
    calls.push({ command, args, options })
    children.push(child)
    return child
  }
  return { spawn, calls, children }
}

/** 起一次假执行；runExternalExecutor 在返回 Promise 前就同步调用了 spawn，所以 child 立即可用。 */
function startFake(options) {
  const fake = fakeSpawn()
  const promise = runExternalExecutor({ ...options, spawn: fake.spawn })
  return { ...fake, promise, child: fake.children[0] }
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

console.log('executor.js')

await check('normalizeExecutor：dsh 默认 / codex / custom / codex 路径覆盖', () => {
  A.deepEqual(normalizeExecutor({}), { kind: 'dsh' })
  A.deepEqual(normalizeExecutor({ executor: 'dsh', executorCommand: 'ignored' }), { kind: 'dsh' })
  A.equal(EXECUTORS.join(','), 'dsh,codex,custom')

  const codex = normalizeExecutor({ executor: 'codex', model: ' gpt-5.1-codex ' })
  A.equal(codex.kind, 'codex')
  A.equal(codex.command, 'codex')
  A.deepEqual(codex.args, ['exec', '--json'])
  A.equal(codex.model, 'gpt-5.1-codex')

  const overridden = normalizeExecutor({ executor: 'codex', executorCommand: ' /home/u/.local/bin/codex ' })
  A.equal(overridden.command, '/home/u/.local/bin/codex')

  const custom = normalizeExecutor({ executor: 'custom', executorCommand: ' my-agent --prompt {prompt} ', mode: 'single' })
  A.equal(custom.kind, 'custom')
  A.equal(custom.command, 'my-agent --prompt {prompt}')
})

await check('normalizeExecutor：非法组合抛 EXECUTOR_INVALID（中文原因）', () => {
  throwsExecutor(() => normalizeExecutor({ executor: 'gemini' }), /不支持/, '未知 executor')
  throwsExecutor(() => normalizeExecutor({ executor: 'custom' }), /executorCommand/, 'custom 缺命令')
  throwsExecutor(() => normalizeExecutor({ executor: 'custom', executorCommand: '   ' }), /executorCommand/, 'custom 空白命令')
  throwsExecutor(() => normalizeExecutor({ executor: 'codex', mode: 'team' }), /single/, 'codex + team')
})

await check('buildCodexArgs：基础顺序 / model 有无 / sandbox 覆盖', () => {
  const base = buildCodexArgs({ cwd: '/repo', schemaPath: '/repo/schema.json', prompt: '做点事' })
  A.deepEqual(base, [
    'exec', '--json', '--output-schema', '/repo/schema.json', '-C', '/repo',
    '--skip-git-repo-check', '-s', 'workspace-write', '做点事',
  ])

  const withModel = buildCodexArgs({ cwd: '/repo', schemaPath: '/s.json', model: 'gpt-5.1-codex', prompt: 'p' })
  A.deepEqual(withModel, [
    'exec', '--json', '--output-schema', '/s.json', '-C', '/repo',
    '--skip-git-repo-check', '-s', 'workspace-write', '-m', 'gpt-5.1-codex', 'p',
  ])

  const readOnly = buildCodexArgs({ cwd: '/repo', schemaPath: '/s.json', sandbox: 'read-only', prompt: 'p' })
  A.deepEqual(readOnly, [
    'exec', '--json', '--output-schema', '/s.json', '-C', '/repo',
    '--skip-git-repo-check', '-s', 'read-only', 'p',
  ])
  A.equal(base[base.length - 1], '做点事')

  throwsExecutor(() => buildCodexArgs({ cwd: '/repo', schemaPath: '/s.json', sandbox: 'yolo', prompt: 'p' }), /sandbox/, '非法 sandbox')
  throwsExecutor(() => buildCodexArgs({ cwd: '', schemaPath: '/s.json', prompt: 'p' }), /cwd/, '缺 cwd')
})

await check('parseCodexLine：final / usage / 过程 / 未知 / 非 JSON 都不抛错', () => {
  A.deepEqual(
    parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"最终答复"}}'),
    { kind: 'final', text: '最终答复' },
  )
  A.deepEqual(
    parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":30,"total_tokens":150}}'),
    { kind: 'usage', usage: { input: 120, output: 30, total: 150 } },
  )
  A.deepEqual(
    parseCodexLine('{"type":"usage","input_tokens":5,"output_tokens":7}'),
    { kind: 'usage', usage: { input: 5, output: 7, total: 12 } },
  )

  const command = parseCodexLine('{"type":"item.completed","item":{"type":"command_execution","command":"ls","aggregated_output":"a.txt"}}')
  A.equal(command.kind, 'log')
  A.equal(command.text, 'a.txt')

  A.deepEqual(parseCodexLine('{"type":"turn.started"}'), { kind: 'ignore' })
  A.deepEqual(parseCodexLine('{"type":"agent_message","message":"旧形状"}'), { kind: 'final', text: '旧形状' })
  A.deepEqual(
    parseCodexLine('{"id":"0","msg":{"type":"agent_message","message":"更旧的形状"}}'),
    { kind: 'final', text: '更旧的形状' },
  )
  A.deepEqual(parseCodexLine('{"type":"future.event","payload":{"x":1}}'), { kind: 'ignore' })
  A.deepEqual(parseCodexLine('not json at all'), { kind: 'log', text: 'not json at all' })
  A.deepEqual(parseCodexLine('   '), { kind: 'ignore' })
  A.deepEqual(parseCodexLine(null), { kind: 'ignore' })
  A.equal(parseCodexLine('{"type":"turn.failed","error":{"message":"boom"}}').level, 'error')
})

await check('runExternalExecutor：跨 chunk 半行 / usage / stderr 尾部 / onEvent', async () => {
  const seen = []
  const { promise, child, calls } = startFake({
    spec: { kind: 'codex', command: 'codex', model: 'gpt-5.1-codex', schemaPath: '/repo/schema.json' },
    prompt: '把事做完',
    cwd: '/repo',
    onEvent: event => seen.push(event),
  })

  A.equal(calls[0].command, 'codex')
  A.equal(calls[0].options.cwd, '/repo')
  A.deepEqual(calls[0].args.slice(0, 5), ['exec', '--json', '--output-schema', '/repo/schema.json', '-C'])

  const finalLine = `${JSON.stringify({
    type: 'item.completed',
    item: { id: 'i1', type: 'agent_message', text: '```json\n{"verdict":"pass"}\n```' },
  })}\n`
  const split = Math.floor(finalLine.length / 2)
  child.stdout.emit('data', finalLine.slice(0, split))
  child.stdout.emit('data', finalLine.slice(split))
  child.stdout.emit('data', `${JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'ls', aggregated_output: 'ok' },
  })}\n`)
  child.stdout.emit('data', `${JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
  })}\n`)
  // 未知事件必须被静默忽略，不能污染 final / usage，也不能抛错。
  child.stdout.emit('data', '{"type":"future.event","payload":{}}\n')
  child.stderr.emit('data', 'x'.repeat(1500))
  child.stderr.emit('data', 'y'.repeat(1000))
  child.emit('close', 0, null)

  const result = await promise
  A.equal(result.ok, true)
  A.equal(result.exitCode, 0)
  A.match(result.text, /verdict/)
  A.deepEqual(result.structured, { verdict: 'pass' })
  A.deepEqual(result.usage, { input: 9, output: 4, total: 13 })
  A.ok(!result.events.some(event => event.kind === 'ignore'), '未知事件不应进 events')
  A.ok(result.events.some(event => event.kind === 'final'), '事件里应有 final')
  A.ok(
    result.events.some(event => event.kind === 'log' && event.itemType === 'command_execution'),
    '事件里应有命令执行日志',
  )
  const stderrEvent = result.events.find(event => event.kind === 'stderr')
  A.equal(stderrEvent.text.length, 2000)
  A.equal(stderrEvent.text, `${'x'.repeat(1500)}${'y'.repeat(1000)}`.slice(-2000))
  A.ok(seen.length >= 4, 'onEvent 应逐条回调')
})

await check('runExternalExecutor：custom 占位符替换与 shell 安全转义', async () => {
  const { promise, child, calls } = startFake({
    spec: { kind: 'custom', command: 'agent --schema {schema} --cwd {cwd} --prompt {prompt}', schemaPath: '/tmp/x schema.json' },
    prompt: "it's ok",
    cwd: '/repo',
  })
  A.equal(calls[0].command, 'sh')
  A.equal(calls[0].args[0], '-c')
  A.equal(
    calls[0].args[1],
    "agent --schema '/tmp/x schema.json' --cwd '/repo' --prompt 'it'\\''s ok'",
  )
  child.emit('close', 0, null)
  const result = await promise
  A.equal(result.ok, true)
})

await check('runExternalExecutor：custom 无占位符时 prompt 追加为最后一个参数', async () => {
  const { promise, child, calls } = startFake({
    spec: { kind: 'custom', command: 'my-agent --json' },
    prompt: "say 'hi'",
    cwd: '/repo',
  })
  A.equal(calls[0].args[1], "my-agent --json 'say '\\''hi'\\'''")
  child.emit('close', 0, null)
  const result = await promise
  A.equal(result.ok, true)
  A.equal(result.text, '')
})

await check('runExternalExecutor：custom 裸 JSON 输出回退成 text / structured', async () => {
  const { promise, child } = startFake({
    spec: { kind: 'custom', command: 'my-agent --prompt {prompt}' },
    prompt: 'p',
    cwd: '/repo',
  })
  child.stdout.emit('data', '{"verdict":"reject","findings":[]}\n')
  child.emit('close', 0, null)
  const result = await promise
  A.equal(result.ok, true)
  A.equal(result.text, '{"verdict":"reject","findings":[]}')
  A.deepEqual(result.structured, { verdict: 'reject', findings: [] })
})

await check('runExternalExecutor：超时 kill 并返回 reason=timeout', async () => {
  const { promise, child } = startFake({
    spec: { kind: 'codex', command: 'codex' },
    prompt: 'p',
    cwd: '/repo',
    timeoutMs: 15,
  })
  const result = await promise
  A.equal(result.ok, false)
  A.equal(result.reason, 'timeout')
  A.equal(child.killed, true)
  A.equal(child.killSignals[0], 'SIGTERM')
})

await check('runExternalExecutor：abort 与「起进程前已 abort」', async () => {
  const controller = new AbortController()
  const live = startFake({
    spec: { kind: 'codex', command: 'codex' },
    prompt: 'p',
    cwd: '/repo',
    signal: controller.signal,
  })
  controller.abort()
  const aborted = await live.promise
  A.equal(aborted.ok, false)
  A.equal(aborted.reason, 'aborted')
  A.equal(live.child.killed, true)

  const early = new AbortController()
  early.abort()
  const fake = fakeSpawn()
  const earlyResult = await runExternalExecutor({
    spec: { kind: 'codex', command: 'codex' },
    prompt: 'p',
    cwd: '/repo',
    signal: early.signal,
    spawn: fake.spawn,
  })
  A.equal(earlyResult.reason, 'aborted')
  A.equal(fake.calls.length, 0)
})

await check('runExternalExecutor：非 0 退出返回 exit / exitCode / tail', async () => {
  const { promise, child } = startFake({
    spec: { kind: 'codex', command: 'codex' },
    prompt: 'p',
    cwd: '/repo',
  })
  child.stderr.emit('data', 'boom: schema mismatch')
  child.stdout.emit('data', 'partial output')
  child.emit('close', 2, null)
  const result = await promise
  A.equal(result.ok, false)
  A.equal(result.reason, 'exit')
  A.equal(result.exitCode, 2)
  A.equal(result.tail, 'boom: schema mismatch')
  A.ok(result.events.some(event => event.kind === 'stderr'))
})

await check('runExternalExecutor：spawn 报错与非法 spec 都不炸调用方', async () => {
  const fake = fakeSpawn()
  const promise = runExternalExecutor({
    spec: { kind: 'codex', command: 'codex' },
    prompt: 'p',
    cwd: '/repo',
    spawn: fake.spawn,
  })
  fake.children[0].emit('error', new Error('ENOENT: codex not found'))
  const crashed = await promise
  A.equal(crashed.ok, false)
  A.equal(crashed.reason, 'spawn')
  A.match(crashed.message, /ENOENT/)

  await rejectsExecutor(
    runExternalExecutor({ spec: { kind: 'dsh' }, prompt: 'p', spawn: fake.spawn }),
    /dsh/,
    'dsh spec',
  )
  await rejectsExecutor(
    runExternalExecutor({ spec: { kind: 'gemini' }, prompt: 'p', spawn: fake.spawn }),
    /不支持/,
    '未知 spec',
  )
})

await check('runExternalExecutor：真 node 子进程端到端，structured 解析成功', async () => {
  const dir = mkdtempSync(join(repoRoot, '.tmp', 'executor-real-'))
  const stub = join(dir, 'stub.mjs')
  writeFileSync(stub, [
    'const fence = String.fromCharCode(96).repeat(3)',
    "console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: fence + 'json\\n{\"verdict\":\"pass\",\"files\":2}\\n' + fence } }))",
    "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } }))",
  ].join('\n'))

  try {
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(stub)}`
    const result = await runExternalExecutor({
      spec: { kind: 'custom', command },
      prompt: '真子进程任务',
      cwd: repoRoot,
    })
    A.equal(result.ok, true)
    A.equal(result.exitCode, 0)
    A.match(result.text, /verdict/)
    A.deepEqual(result.structured, { verdict: 'pass', files: 2 })
    A.deepEqual(result.usage, { input: 11, output: 7, total: 18 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n${checks} 组通过，${assertionCount} 条断言`)
