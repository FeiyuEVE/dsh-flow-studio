#!/usr/bin/env node
/**
 * 外部 executor 自检（07 §6 / §8）。
 *
 * 前半部分走注入的假 spawn：手动 emit `data` / `close`，验证跨 chunk 半行、
 * 未知事件、usage、超时、abort 与非 0 退出。末尾用真 `sh -c` 子进程跑 `.tmp/`
 * 下的临时目录，端到端验证 custom executor 的 prompt 注入修复与三条传递通道：
 *   1. 临时文件 + `FLOW_STUDIO_PROMPT_FILE`（`{prompt}` 主通道）；
 *   2. `FLOW_STUDIO_PROMPT` 环境变量（仅 ≤64KiB 的兼容通道）；
 *   3. stdin（全文兜底）。
 * 另验证 prompt 临时文件在成功 / 失败 / 超时路径都被清理。
 * **任何一组都不会真的调用 codex，也不联网**。
 *
 * 跑：`node test/executor.test.mjs`
 */

import assert from 'node:assert/strict'
import { spawn as realSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
    // stdin 只记录写入内容：fake 场景不验证真实管道，端到端用例才用真子进程。
    child.stdin = new EventEmitter()
    child.stdin.writes = []
    child.stdin.ended = false
    child.stdin.write = (chunk) => {
      child.stdin.writes.push(String(chunk))
      return true
    }
    child.stdin.end = (chunk) => {
      if (chunk !== undefined && chunk !== null) child.stdin.writes.push(String(chunk))
      child.stdin.ended = true
    }
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

/** 在 `.tmp/` 下建唯一临时目录；调用方负责删除。 */
function makeTmpDir(label) {
  return mkdtempSync(join(repoRoot, '.tmp', `${label}-`))
}

/** 测试内部拼绝对路径用的 POSIX 单引号引用。 */
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** 用真实 `sh -c` 跑一次 custom executor（不 mock child_process）。 */
function runCustom(command, prompt, extra = {}) {
  return runExternalExecutor({
    spec: { kind: 'custom', command },
    prompt,
    cwd: repoRoot,
    ...extra,
  })
}

/** 给「不应挂起」的用例兜底：超时即失败，避免测试进程被挂死。 */
async function within(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}：超过 ${ms}ms 仍未结束`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 真实 spawn 的观测包装：记下执行器传给子进程的 prompt 临时文件路径。 */
function capturePromptFileSpawn() {
  const state = { file: null, dir: null }
  const spawn = (command, args, options) => {
    const env = options && options.env ? options.env : {}
    if (typeof env.FLOW_STUDIO_PROMPT_FILE === 'string') {
      state.file = env.FLOW_STUDIO_PROMPT_FILE
      state.dir = dirname(state.file)
    }
    return realSpawn(command, args, options)
  }
  return { state, spawn }
}

/**
 * 构造恰好 256KiB（UTF-8 字节）的 prompt：
 * 含换行、`$`、反引号、单双引号、反斜杠，以及三类注入载荷；
 * 末尾是 `END-MARKER`（不带换行，避免命令替换剥尾换行影响逐字节断言）。
 */
function largePrompt(sentinel, dir) {
  const target = 256 * 1024
  const head = [
    'BEGIN 256KiB payload',
    "单引号 'x' 双引号 \"y\" 反斜杠 \\ 美元 $HOME 感叹 !",
    '反引号 `id -u` 与 $(id -u)',
    `$(touch ${sentinel})`,
    `"; touch ${sentinel}; echo "`,
    `$(rm -rf ${dir})`,
    '第二段：$$$ `echo pwned` "quoted"',
  ].join('\n') + '\n'
  const tail = 'END-MARKER'
  const pad = target - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8')
  if (pad <= 0) throw new Error('largePrompt：固定头部已超过目标大小')
  return head + 'A'.repeat(pad) + tail
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
  // codex 行为保持不变：prompt 走 argv 位置参数，不写 stdin、不注入 PROMPT 环境变量。
  A.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
  A.equal(calls[0].options.env, undefined)
  A.equal(calls[0].args[calls[0].args.length - 1], '把事做完')
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

await check('runExternalExecutor：custom 的 {prompt} 替换成读 prompt 文件，prompt 原文不进命令文本', async () => {
  const { promise, child, calls } = startFake({
    spec: { kind: 'custom', command: 'agent --schema {schema} --cwd {cwd} --prompt {prompt}', schemaPath: '/tmp/x schema.json' },
    prompt: "it's ok",
    cwd: '/repo',
  })
  A.equal(calls[0].command, 'sh')
  A.equal(calls[0].args[0], '-c')
  A.equal(
    calls[0].args[1],
    `agent --schema '/tmp/x schema.json' --cwd '/repo' --prompt "$(cat -- "$FLOW_STUDIO_PROMPT_FILE")"`,
  )
  A.ok(!calls[0].args[1].includes("it's ok"), 'prompt 原文绝不能出现在 sh -c 脚本里')
  A.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe'])
  A.equal(calls[0].options.env.FLOW_STUDIO_PROMPT, "it's ok")
  const promptFile = calls[0].options.env.FLOW_STUDIO_PROMPT_FILE
  A.ok(typeof promptFile === 'string' && promptFile !== '', '必须用 FLOW_STUDIO_PROMPT_FILE 暴露文件路径')
  A.equal(existsSync(promptFile), true, '执行期间 prompt 文件应存在')
  A.equal(readFileSync(promptFile, 'utf8'), "it's ok", 'prompt 文件内容必须是原文')
  A.equal(child.stdin.writes.join(''), "it's ok")
  A.equal(child.stdin.ended, true)
  child.emit('close', 0, null)
  const result = await promise
  A.equal(result.ok, true)
  A.equal(existsSync(promptFile), false, '执行结束后 prompt 文件必须被清理')
  A.equal(existsSync(dirname(promptFile)), false, '执行结束后 prompt 临时目录必须被清理')
})

await check('runExternalExecutor：custom 无占位符时不改命令文本，prompt 走文件 + env + stdin', async () => {
  const { promise, child, calls } = startFake({
    spec: { kind: 'custom', command: 'my-agent --json' },
    prompt: "say 'hi'",
    cwd: '/repo',
  })
  A.equal(calls[0].args[1], 'my-agent --json', '没有 {prompt} 时命令文本必须保持原样')
  A.equal(calls[0].options.env.FLOW_STUDIO_PROMPT, "say 'hi'")
  const promptFile = calls[0].options.env.FLOW_STUDIO_PROMPT_FILE
  A.ok(typeof promptFile === 'string' && promptFile !== '')
  A.equal(readFileSync(promptFile, 'utf8'), "say 'hi'")
  A.equal(child.stdin.writes.join(''), "say 'hi'", 'prompt 原文应完整写进 stdin')
  A.equal(child.stdin.ended, true)
  child.emit('close', 0, null)
  const result = await promise
  A.equal(result.ok, true)
  A.equal(result.text, '')
  A.equal(existsSync(promptFile), false, '执行结束后 prompt 文件必须被清理')
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

// ---------------------------------------------------------------------------
// 真实 `sh -c` 端到端：prompt 注入回归（RCE 修复证据，不 mock child_process）
// ---------------------------------------------------------------------------

await check('真实 sh -c：echo "{prompt}" 里的 $(id -u) 保持字面量，不再执行', async () => {
  const result = await runCustom('echo "{prompt}"', '$(id -u)')
  A.equal(result.ok, true)
  A.equal(result.exitCode, 0)
  A.equal(result.text, '$(id -u)', '双引号内的占位符必须只做变量展开，输出 prompt 原文')
  A.ok(!/\b1000\b/.test(result.text), '不得出现 id -u 的真实输出（1000）')
})

await check('真实 sh -c：反引号 / 引号逃逸 / $(rm -rf) 三类载荷都不执行', async () => {
  const dir = makeTmpDir('executor-inject')
  const sentinel = join(dir, 'pwned')
  try {
    const escaped = `"; touch ${sentinel}; echo "`
    const payloads = [
      '`id -u`',
      escaped,
      `$(rm -rf ${dir})`,
    ]
    for (const prompt of payloads) {
      const result = await runCustom('echo "{prompt}"', prompt)
      A.equal(result.ok, true)
      A.equal(result.text, prompt, `载荷必须原样输出：${prompt}`)
    }
    A.equal(existsSync(sentinel), false, '引号逃逸载荷不得创建哨兵文件')
    A.equal(existsSync(dir), true, '$(rm -rf …) 载荷不得删除哨兵目录')
    A.equal(existsSync(sentinel), false, '整轮结束后哨兵文件仍不得存在')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('真实 sh -c：无引号位置的 {prompt} 同样安全（替换产物自带双引号）', async () => {
  const dir = makeTmpDir('executor-bare')
  const sentinel = join(dir, 'pwned')
  try {
    const payload = `pre$(id -u)post;touch ${sentinel};`
    const result = await runCustom('echo {prompt}', payload)
    A.equal(result.ok, true)
    A.equal(result.text, payload, '无引号位置也只做变量展开，载荷原样输出')
    A.equal(existsSync(sentinel), false, '无引号位置不得执行;分隔出的命令')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('真实 sh -c：单引号内的 {prompt} 是「不支持的位置」——输出替换产物字面量，无展开无注入', async () => {
  const dir = makeTmpDir('executor-single')
  const sentinel = join(dir, 'pwned')
  try {
    const payload = `$(touch ${sentinel})`
    const result = await runCustom("echo '{prompt}'", payload)
    A.equal(result.ok, true)
    A.equal(
      result.text,
      '"$(cat -- "$FLOW_STUDIO_PROMPT_FILE")"',
      '单引号内 shell 不展开变量：输出的是替换产物字面量（不是 prompt，也不会执行 payload）',
    )
    A.equal(existsSync(sentinel), false, '单引号位置不得产生注入')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('真实 sh -c：复杂 prompt（空格/换行/引号/$/!/反斜杠/中文）逐字节到达 env 与 stdin', async () => {
  const dir = makeTmpDir('executor-roundtrip')
  const envFile = join(dir, 'env.bin')
  const stdinFile = join(dir, 'stdin.bin')
  // 首尾都带空白（前导空格 + 结尾换行）：证明原样传递、没有被 trim 或改写。
  const prompt = ' 第一行：空格  两个  制表\t制表\n'
    + "第二行 '单引号' \"双引号\" $HOME ${USER} ! !!\n"
    + '反斜杠 \\ 与 \\\\ 两道\n'
    + '$(id -u) `id -u` & ; | > < * ? ~ % 中文结束\n'
  try {
    const command = `cat > ${shq(stdinFile)}; printf '%s' "$FLOW_STUDIO_PROMPT" > ${shq(envFile)}`
    const result = await within(runCustom(command, prompt), 15000, 'prompt 往返')
    A.equal(result.ok, true)
    A.equal(result.exitCode, 0)
    const stdinBytes = readFileSync(stdinFile)
    A.ok(
      Buffer.compare(stdinBytes, Buffer.from(prompt, 'utf8')) === 0,
      'stdin 必须逐字节等于 prompt 原文',
    )
    A.equal(stdinBytes.length, Buffer.byteLength(prompt), 'stdin 长度必须与原文一致')
    A.equal(readFileSync(envFile, 'utf8'), prompt, 'FLOW_STUDIO_PROMPT 必须逐字节等于 prompt 原文')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('真实 sh -c：子进程不读 stdin（true）不失败、不挂起', async () => {
  const small = await within(runCustom('true', 'ignored'), 15000, 'true 小 prompt')
  A.equal(small.ok, true)
  A.equal(small.exitCode, 0)
  A.equal(small.text, '')

  // 100KB 超过 Linux 管道默认缓冲（64KB）：压测子进程提前退出时的 stdin 写失败路径。
  const bigPrompt = 'x'.repeat(100_000)
  const big = await within(runCustom('true', bigPrompt), 15000, 'true 大 prompt')
  A.equal(big.ok, true, 'stdin 写失败不得把成功的执行变成失败')
  A.equal(big.exitCode, 0)
  A.equal(big.text, '')
})

await check('真实 sh -c：stdin 管道报错（EPIPE）被吞掉，不影响执行结果', async () => {
  const stdinErrors = []
  let observed = null
  // 真实 spawn 的观测包装：给子进程 stdin 注入一次 EPIPE，验证执行器自己挂的
  // error 处理器会吞掉它——否则未捕获的 error 事件会带崩整个进程。
  const spawn = (command, args, options) => {
    const child = realSpawn(command, args, options)
    observed = child
    child.stdin.on('error', error => stdinErrors.push(error.code || error.message))
    const pipeError = new Error('write EPIPE')
    pipeError.code = 'EPIPE'
    child.stdin.destroy(pipeError)
    return child
  }
  const promise = runExternalExecutor({
    spec: { kind: 'custom', command: 'true' },
    prompt: 'hello',
    cwd: repoRoot,
    spawn,
  })
  // runExternalExecutor 起进程是同步的：此刻执行器必须已经挂上自己的 stdin error 处理器。
  A.ok(observed && observed.stdin.listenerCount('error') >= 2, '执行器必须自己监听 stdin error')
  const result = await within(promise, 15000, 'stdin 错误注入')
  A.equal(result.ok, true, 'stdin 写失败不得把成功的执行变成失败')
  A.equal(result.exitCode, 0)
  A.deepEqual(stdinErrors, ['EPIPE'], '注入的 EPIPE 必须被观测到且被吞掉')
})

await check('真实 sh -c：256KiB prompt 经 {prompt} 通道逐字节到达且无注入', async () => {
  const dir = makeTmpDir('executor-large-file')
  const sentinel = join(dir, 'pwned')
  const outFile = join(dir, 'out.bin')
  try {
    const prompt = largePrompt(sentinel, dir)
    A.equal(Buffer.byteLength(prompt, 'utf8'), 256 * 1024, '用例 prompt 必须精确为 256KiB')
    // 放在双引号内：替换器应按引号上下文去掉多余外层引号，仍逐字节保真。
    const command = `printf '%s' "{prompt}" > ${shq(outFile)}`
    const result = await within(runCustom(command, prompt), 30000, '256KiB {prompt}')
    A.equal(result.ok, true, '256KiB prompt 不得触发 E2BIG 或执行失败')
    A.equal(result.exitCode, 0)
    const got = readFileSync(outFile)
    A.equal(got.length, 256 * 1024, '文件通道输出字节数必须等于 256KiB')
    A.ok(Buffer.compare(got, Buffer.from(prompt, 'utf8')) === 0, '文件通道输出必须逐字节等于 prompt 原文')
    A.equal(existsSync(sentinel), false, '256KiB prompt 内的 touch 载荷不得执行')
    A.equal(existsSync(dir), true, '256KiB prompt 内的 rm -rf 载荷不得执行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('真实 sh -c：256KiB prompt 经 stdin 通道逐字节到达', async () => {
  const dir = makeTmpDir('executor-large-stdin')
  const sentinel = join(dir, 'pwned')
  const outFile = join(dir, 'stdin.bin')
  try {
    const prompt = largePrompt(sentinel, dir)
    A.equal(Buffer.byteLength(prompt, 'utf8'), 256 * 1024)
    const result = await within(runCustom(`cat > ${shq(outFile)}`, prompt), 30000, '256KiB stdin')
    A.equal(result.ok, true)
    A.equal(result.exitCode, 0)
    const got = readFileSync(outFile)
    A.equal(got.length, 256 * 1024, 'stdin 通道收到字节数必须等于 256KiB')
    A.ok(Buffer.compare(got, Buffer.from(prompt, 'utf8')) === 0, 'stdin 通道必须逐字节等于 prompt 原文')
    A.equal(existsSync(sentinel), false, '256KiB prompt 内的载荷经 stdin 也不得执行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('真实 sh -c：256KiB prompt 时 FLOW_STUDIO_PROMPT 不设置，FLOW_STUDIO_PROMPT_FILE 逐字节相等', async () => {
  const dir = makeTmpDir('executor-large-env')
  const sentinel = join(dir, 'pwned')
  const envDump = join(dir, 'env.txt')
  const fileCopy = join(dir, 'file.bin')
  const previous = process.env.FLOW_STUDIO_PROMPT
  // 模拟父进程残留同名变量：大 prompt 时必须被显式删除，不能泄漏旧值。
  process.env.FLOW_STUDIO_PROMPT = 'stale-parent-value'
  try {
    const prompt = largePrompt(sentinel, dir)
    A.equal(Buffer.byteLength(prompt, 'utf8'), 256 * 1024)
    const command = `env > ${shq(envDump)}; cat -- "$FLOW_STUDIO_PROMPT_FILE" > ${shq(fileCopy)}`
    const result = await within(runCustom(command, prompt), 30000, '256KiB env 探测')
    A.equal(result.ok, true, '大 prompt 不得触发 E2BIG')
    const envLines = readFileSync(envDump, 'utf8').split('\n')
    A.ok(envLines.some(line => line.startsWith('FLOW_STUDIO_PROMPT_FILE=')), '必须暴露 prompt 文件路径')
    A.equal(
      envLines.some(line => line.startsWith('FLOW_STUDIO_PROMPT=')),
      false,
      '大 prompt 时 FLOW_STUDIO_PROMPT 必须未设置（含父进程残留值）',
    )
    const got = readFileSync(fileCopy)
    A.equal(got.length, 256 * 1024, 'FLOW_STUDIO_PROMPT_FILE 内容字节数必须是 256KiB')
    A.ok(Buffer.compare(got, Buffer.from(prompt, 'utf8')) === 0, 'FLOW_STUDIO_PROMPT_FILE 内容必须逐字节相等')
    A.equal(existsSync(sentinel), false, '文件通道载荷不得执行')
  } finally {
    if (previous === undefined) delete process.env.FLOW_STUDIO_PROMPT
    else process.env.FLOW_STUDIO_PROMPT = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('真实 sh -c：prompt 临时文件在成功路径清理（目录 0700 / 文件 0600）', async () => {
  const prompt = 'success-path prompt'
  const { state, spawn } = capturePromptFileSpawn()
  const promise = runExternalExecutor({
    spec: { kind: 'custom', command: 'printf ok' },
    prompt,
    cwd: repoRoot,
    spawn,
  })
  A.ok(state.file, 'spawn 前必须写好 FLOW_STUDIO_PROMPT_FILE')
  A.equal(existsSync(state.file), true, '执行期间 prompt 文件应存在')
  A.equal(readFileSync(state.file, 'utf8'), prompt)
  A.equal(statSync(state.file).mode & 0o777, 0o600, 'prompt 文件权限必须是 0600')
  A.equal(statSync(state.dir).mode & 0o777, 0o700, 'prompt 临时目录权限必须是 0700')
  const result = await within(promise, 15000, '成功路径清理')
  A.equal(result.ok, true)
  A.equal(existsSync(state.file), false, '成功后 prompt 文件必须被清理')
  A.equal(existsSync(state.dir), false, '成功后 prompt 临时目录必须被清理')
})

await check('真实 sh -c：prompt 临时文件在失败路径清理（exit 3）', async () => {
  const { state, spawn } = capturePromptFileSpawn()
  const result = await within(runExternalExecutor({
    spec: { kind: 'custom', command: 'exit 3' },
    prompt: 'failure-path prompt',
    cwd: repoRoot,
    spawn,
  }), 15000, '失败路径清理')
  A.equal(result.ok, false)
  A.equal(result.reason, 'exit')
  A.equal(result.exitCode, 3)
  A.ok(state.file, '失败前必须创建过 prompt 临时文件')
  A.equal(existsSync(state.file), false, '失败后 prompt 文件必须被清理')
  A.equal(existsSync(state.dir), false, '失败后 prompt 临时目录必须被清理')
})

await check('真实 sh -c：prompt 临时文件在超时路径清理', async () => {
  const { state, spawn } = capturePromptFileSpawn()
  const result = await within(runExternalExecutor({
    spec: { kind: 'custom', command: 'exec sleep 5' },
    prompt: 'timeout-path prompt',
    cwd: repoRoot,
    timeoutMs: 60,
    spawn,
  }), 15000, '超时路径清理')
  A.equal(result.ok, false)
  A.equal(result.reason, 'timeout')
  A.ok(state.file, '超时前必须创建过 prompt 临时文件')
  A.equal(existsSync(state.file), false, '超时后 prompt 文件必须被清理')
  A.equal(existsSync(state.dir), false, '超时后 prompt 临时目录必须被清理')
})

// ---------------------------------------------------------------------------
// 进程组缺陷回归（审计实测：custom 的 sh -c 孙进程曾活过 abort，宿主还被管道吊住）
// 下面全部用真进程 / 真 /proc，不 mock child_process。
// ---------------------------------------------------------------------------

/** 进程是否还存在（EPERM 说明存在但没权限，仍算存活）。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

/** 从 /proc/<pid>/stat 读 pgid（Linux）；拿不到返回 null。 */
function readPgid(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm 字段可能含空格 / 括号：从最后一个 ')' 之后开始切。
    // 字段序：state(3) ppid(4) pgrp(5) session(6) …，切完 rest[0]=state、rest[1]=ppid、rest[2]=pgrp。
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const pgid = Number(rest[2])
    return Number.isInteger(pgid) ? pgid : null
  } catch {
    return null
  }
}

/** 轮询等待进程消失；超时返回 false。 */
async function waitGone(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return !isAlive(pid)
}

/** 兜底清理：只杀 cmdline 里确认是 sleep 的进程，避免 pid 复用误伤。 */
function killLeftover(pid) {
  if (!isAlive(pid)) return
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    if (!cmdline.includes('sleep')) return
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已退出 / 非 Linux：放弃兜底。
  }
}

/** 真实 spawn 的观测包装：记下子进程对象，用来核对 pgid 与 stdout/stderr 状态。 */
function captureChildSpawn() {
  const state = { child: null }
  const spawn = (command, args, options) => {
    state.child = realSpawn(command, args, options)
    return state.child
  }
  return { state, spawn }
}

/** 带 destroy 追踪的假流：验证 finish() 是否真的 destroy 了 stdout / stderr。 */
function trackedStream() {
  const stream = new EventEmitter()
  stream.destroyed = false
  stream.setEncoding = () => {}
  stream.destroy = () => {
    stream.destroyed = true
  }
  return stream
}

/** 假 spawn（仅用于「收尾 / 降级可观测」用例）：流带 destroy 追踪。 */
function trackedFakeSpawn() {
  const calls = []
  const children = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = trackedStream()
    child.stderr = trackedStream()
    child.stdin = new EventEmitter()
    child.stdin.write = () => true
    child.stdin.end = () => {}
    child.pid = 5300 + children.length
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

/** 派生孙进程的命令：后台 sleep 600 + 打印它的 pid，然后 wait 把它挂住。 */
const GRANDCHILD_COMMAND = 'sleep 600 & echo "grandchild:$!"; wait'

/** 从执行器事件里抓 `grandchild:<pid>`。 */
function makeGrandchildTracker() {
  const state = { pid: null }
  const onEvent = (event) => {
    const text = event && typeof event.text === 'string' ? event.text : ''
    const matched = /grandchild:(\d+)/.exec(text)
    if (matched) state.pid = Number(matched[1])
  }
  return { state, onEvent }
}

await check('真实进程组：abort 杀掉 sh -c 派生的孙进程（sleep 600），killScope=group', async () => {
  const controller = new AbortController()
  const { state: spawnState, spawn } = captureChildSpawn()
  const tracker = makeGrandchildTracker()
  let aliveBeforeAbort = null
  let pgidBeforeAbort = null
  let result = null
  const run = runExternalExecutor({
    spec: { kind: 'custom', command: GRANDCHILD_COMMAND },
    prompt: '进程组 abort 用例',
    cwd: repoRoot,
    signal: controller.signal,
    spawn,
    onEvent: tracker.onEvent,
  })
  const abortTimer = setTimeout(() => {
    // 证据必须在 abort 之前取：abort 之后进程组可能已经消失，读不到 pgid。
    aliveBeforeAbort = tracker.state.pid !== null && isAlive(tracker.state.pid)
    pgidBeforeAbort = tracker.state.pid === null ? null : readPgid(tracker.state.pid)
    controller.abort()
  }, 300)
  try {
    result = await within(run, 15000, '进程组 abort')
    const grandchildPid = tracker.state.pid
    const directPid = spawnState.child ? spawnState.child.pid : null
    A.equal(result.ok, false)
    A.equal(result.reason, 'aborted')
    A.equal(result.killScope, 'group', 'abort 必须按进程组终止（整组）')
    A.equal(result.orphanWarning, null, 'POSIX 真实子进程不该有降级告警')
    A.ok(Number.isInteger(grandchildPid), '必须从 stdout 拿到孙进程 pid')
    A.equal(aliveBeforeAbort, true, `孙进程 ${grandchildPid} 在 abort 前必须存活`)
    A.equal(pgidBeforeAbort, directPid, '孙进程必须与直接子进程（sh）同属一个进程组（pgid = sh pid）')
    A.equal(await waitGone(grandchildPid, 3000), true, `abort 后孙进程 ${grandchildPid} 必须不存在`)
    console.log(`    · 孙进程 pid=${grandchildPid}：abort 前存活 → abort 后不存在（pgid=${pgidBeforeAbort}）`)
  } finally {
    clearTimeout(abortTimer)
    killLeftover(tracker.state.pid)
  }
})

await check('真实进程组：timeout 同样按整组终止（孙进程一并消失）', async () => {
  const tracker = makeGrandchildTracker()
  const result = await within(runExternalExecutor({
    spec: { kind: 'custom', command: GRANDCHILD_COMMAND },
    prompt: '进程组 timeout 用例',
    cwd: repoRoot,
    timeoutMs: 300,
    onEvent: tracker.onEvent,
  }), 15000, '进程组 timeout')
  try {
    A.equal(result.ok, false)
    A.equal(result.reason, 'timeout')
    A.equal(result.killScope, 'group', 'timeout 必须按进程组终止（整组）')
    A.equal(result.orphanWarning, null)
    A.ok(Number.isInteger(tracker.state.pid), '必须拿到孙进程 pid')
    A.equal(await waitGone(tracker.state.pid, 3000), true, `timeout 后孙进程 ${tracker.state.pid} 必须不存在`)
    console.log(`    · timeout 后孙进程 pid=${tracker.state.pid} 已不存在`)
  } finally {
    killLeftover(tracker.state.pid)
  }
})

await check('真实进程：abort 后宿主能自然退出（无遗留 fd），stdout/stderr 已 destroy', async () => {
  const dir = makeTmpDir('executor-nohang')
  const helper = join(dir, 'no-hang.mjs')
  const evidenceFile = join(dir, 'evidence.json')
  const executorUrl = pathToFileURL(join(repoRoot, 'src', 'executor.js')).href
  // 宿主脚本：真跑一次 custom executor，300ms 后 abort，把证据写文件后什么都不做。
  // 故意不调用 process.exit()——「能不能自然退出」本身就是被测行为：
  // 孙进程继承的 stdout/stderr 管道若没被 destroy，脚本会被吊住直到 sleep 600 结束。
  const helperSource = [
    "import { spawn as realSpawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    `import { runExternalExecutor } from ${JSON.stringify(executorUrl)}`,
    '',
    'const [outFile, cwd] = process.argv.slice(2)',
    'const controller = new AbortController()',
    'let grandchildPid = null',
    'let observed = null',
    'const spawn = (command, args, options) => {',
    '  observed = realSpawn(command, args, options)',
    '  return observed',
    '}',
    'const run = runExternalExecutor({',
    `  spec: { kind: 'custom', command: ${JSON.stringify(GRANDCHILD_COMMAND)} },`,
    "  prompt: '宿主退出用例',",
    '  cwd,',
    '  signal: controller.signal,',
    '  spawn,',
    '  onEvent: (event) => {',
    "    const matched = /grandchild:(\\d+)/.exec(event && typeof event.text === 'string' ? event.text : '')",
    '    if (matched) grandchildPid = Number(matched[1])',
    '  },',
    '})',
    'setTimeout(() => controller.abort(), 300)',
    'const result = await run',
    'writeFileSync(outFile, JSON.stringify({',
    '  grandchildPid,',
    '  ok: result.ok,',
    '  reason: result.reason,',
    '  killScope: result.killScope,',
    '  orphanWarning: result.orphanWarning,',
    '  stdoutDestroyed: !!(observed && observed.stdout && observed.stdout.destroyed),',
    '  stderrDestroyed: !!(observed && observed.stderr && observed.stderr.destroyed),',
    '}))',
    '// 不 process.exit()：自然退出即通过。',
    '',
  ].join('\n')

  let helperChild = null
  let grandchildPid = null
  let output = ''
  try {
    writeFileSync(helper, helperSource)
    helperChild = realSpawn(process.execPath, [helper, evidenceFile, repoRoot], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    helperChild.stdout.setEncoding('utf8')
    helperChild.stderr.setEncoding('utf8')
    const collect = (chunk) => {
      output += chunk
      const matched = /grandchild:(\d+)/.exec(output)
      if (matched) grandchildPid = Number(matched[1])
    }
    helperChild.stdout.on('data', collect)
    helperChild.stderr.on('data', collect)

    const started = Date.now()
    const exit = await within(new Promise((resolve) => {
      helperChild.on('exit', (code, signal) => resolve({ code, signal }))
    }), 8000, '宿主脚本自然退出')
    const elapsedMs = Date.now() - started
    A.equal(exit.code, 0, '宿主脚本必须自己退出（exit 0），不能被遗留管道吊住')
    A.ok(elapsedMs < 8000, `宿主脚本应在超时前退出（实际 ${elapsedMs}ms）`)

    const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'))
    A.equal(evidence.reason, 'aborted')
    A.equal(evidence.killScope, 'group')
    A.equal(evidence.orphanWarning, null)
    A.equal(evidence.stdoutDestroyed, true, 'abort 收口时 stdout 必须被 destroy')
    A.equal(evidence.stderrDestroyed, true, 'abort 收口时 stderr 必须被 destroy')
    if (Number.isInteger(evidence.grandchildPid)) grandchildPid = evidence.grandchildPid
    A.equal(await waitGone(grandchildPid, 3000), true, `孙进程 ${grandchildPid} 必须不存在`)
    console.log(`    · 宿主脚本 ${elapsedMs}ms 自然退出；孙进程 pid=${grandchildPid} 已消失；stdout/stderr destroyed=true`)
  } finally {
    if (helperChild && helperChild.exitCode === null && helperChild.signalCode === null) {
      try {
        helperChild.kill('SIGKILL')
      } catch {
        // 已退出。
      }
    }
    killLeftover(grandchildPid)
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('codex 路径语义不变：argv / stdio / env 保持，成功收口 killScope=null 且管道已 destroy', async () => {
  const fake = trackedFakeSpawn()
  const promise = runExternalExecutor({
    spec: { kind: 'codex', command: 'codex', model: 'gpt-5.1-codex', schemaPath: '/repo/schema.json' },
    prompt: '把事做完',
    cwd: '/repo',
    spawn: fake.spawn,
  })
  const child = fake.children[0]
  const call = fake.calls[0]
  A.equal(call.command, 'codex')
  A.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'], 'codex 的 stdio 语义必须保持不变')
  A.equal(call.options.env, undefined, 'codex 不注入 custom 的环境变量')
  A.equal(call.options.detached, true, 'POSIX 上必须用 detached 建立进程组')
  A.equal(call.args[call.args.length - 1], '把事做完')
  A.deepEqual(call.args.slice(0, 5), ['exec', '--json', '--output-schema', '/repo/schema.json', '-C'])

  child.stdout.emit('data', '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n')
  child.emit('close', 0, null)
  const result = await promise
  A.equal(result.ok, true)
  A.equal(result.killScope, null, '没有发生终止时 killScope 必须是 null')
  A.equal(result.orphanWarning, null, '真实子进程的 POSIX 路径不该有降级告警')
  A.equal(child.stdout.destroyed, true, '正常完成也必须 destroy stdout')
  A.equal(child.stderr.destroyed, true, '正常完成也必须 destroy stderr')
})

await check('降级路径可观测：无真实进程组时只杀直接子进程（killScope=process + orphanWarning）', async () => {
  const controller = new AbortController()
  const fake = trackedFakeSpawn()
  const promise = runExternalExecutor({
    spec: { kind: 'custom', command: 'sleep 600 & wait' },
    prompt: 'p',
    cwd: '/repo',
    signal: controller.signal,
    spawn: fake.spawn,
  })
  const child = fake.children[0]
  controller.abort()
  const result = await promise
  A.equal(result.ok, false)
  A.equal(result.reason, 'aborted')
  A.equal(result.killScope, 'process', '没有可信进程组时只能标成「只杀直接子进程」')
  A.match(result.orphanWarning, /ChildProcess|进程组/, '必须明确写出降级原因')
  A.equal(child.killSignals[0], 'SIGTERM', '降级路径仍要对直接子进程发 SIGTERM')
  A.ok(
    result.events.some(event => event.kind === 'log' && event.level === 'warn'),
    '降级必须留一条 warn 日志',
  )
  A.equal(child.stdout.destroyed, true, '降级收口也必须 destroy stdout')
  A.equal(child.stderr.destroyed, true, '降级收口也必须 destroy stderr')
})

await check('真实进程组：忽略 SIGTERM 的孙进程在宽限期后被 SIGKILL（整组）', async () => {
  const tracker = makeGrandchildTracker()
  // 孙进程 sh 忽略 SIGTERM 并无限循环：SIGTERM 之后仍活着，只有宽限期后的组 SIGKILL 能收掉它。
  const command = 'sh -c \'trap "" TERM; while :; do sleep 1; done\' & echo "grandchild:$!"; wait'
  const result = await within(runExternalExecutor({
    spec: { kind: 'custom', command },
    prompt: 'SIGKILL 宽限用例',
    cwd: repoRoot,
    timeoutMs: 300,
    onEvent: tracker.onEvent,
  }), 15000, 'SIGKILL 宽限')
  try {
    A.equal(result.reason, 'timeout')
    A.equal(result.killScope, 'group')
    A.ok(Number.isInteger(tracker.state.pid), '必须拿到孙进程 pid')
    A.equal(
      await waitGone(tracker.state.pid, 3000),
      true,
      `忽略 SIGTERM 的孙进程 ${tracker.state.pid} 必须在 SIGKILL 后消失`,
    )
    console.log(`    · 忽略 SIGTERM 的孙进程 pid=${tracker.state.pid} 已被组 SIGKILL 收掉`)
  } finally {
    killLeftover(tracker.state.pid)
  }
})

console.log(`\n${checks} 组通过，${assertionCount} 条断言`)
