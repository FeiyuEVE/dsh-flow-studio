#!/usr/bin/env node
/**
 * 共享 CLI stdout 流读取 helper 自检（0.14.4 / U1）。
 *
 * 覆盖 review-0142b 的三个共享缺陷接缝：
 *  - M3：UTF-8 跨 chunk 解码、EOF 无尾换行 flush、超长行整行丢弃、展示 tail
 *    与协议缓冲分离、每进程独立 reader、退出后 stdout 排空有界；
 *  - 真实子进程：stdout 行交付、stderr tail、后代继承 stdout 时 drained 超时。
 *
 * 关键纪律：不靠「函数被调用几次」自证 —— 每个用例断言**真实交付内容**或
 * **真实子进程 / 流状态**。同时用旧写法对照（Buffer 拼接）证明用例确实挑战了解码方式。
 *
 * 运行：node --test test/agent-cli-stream.test.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'

import {
  attachProcessStreams,
  createUtf8LineReader,
  DEFAULT_INITIAL_LINE_BUFFER_BYTES,
  DEFAULT_MAX_LINE_BYTES,
} from '../src/agent-cli-stream.js'

/** 便捷构造：收集交付行与诊断。 */
function makeReader(options = {}) {
  const lines = []
  const diagnostics = []
  const reader = createUtf8LineReader({
    ...options,
    onLine: (line, meta) => {
      lines.push({ line, meta })
    },
    onDiagnostic: diag => {
      diagnostics.push(diag)
    },
  })
  return { reader, lines, diagnostics }
}

/** 轮询到 predicate 返回真值；超时抛错（不使用裸 sleep 固定时长）。 */
async function waitFor(predicate, timeoutMs = 3000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return once(child, 'exit')
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

test('默认行长上限是 32 MiB，初始行缓冲至少 1 MiB', () => {
  assert.equal(DEFAULT_MAX_LINE_BYTES, 32 * 1024 * 1024)
  assert.ok(DEFAULT_INITIAL_LINE_BUFFER_BYTES >= 1024 * 1024)
})

test('UTF-8 多字节字符逐字节 write 仍完整交付；旧 Buffer 拼接会乱码（对照）', () => {
  const { reader, lines } = makeReader()
  const payload = Buffer.from('{"text":"中文"}\n', 'utf8')
  // 逐字节写入：每个中文字符的 3 个字节都跨 write 边界。
  for (const byte of payload) reader.write(Buffer.from([byte]))
  reader.end()

  assert.equal(lines.length, 1)
  assert.equal(lines[0].line, '{"text":"中文"}')
  assert.deepEqual(JSON.parse(lines[0].line), { text: '中文' })
  assert.equal(lines[0].meta.lineNo, 1)
  assert.equal(lines[0].meta.bytes, Buffer.byteLength('{"text":"中文"}'))

  // 对照：M3 的旧写法（每个 chunk 各自 toString 再拼接）。
  let legacy = ''
  for (const byte of payload) legacy += Buffer.from([byte]).toString('utf8')
  assert.notEqual(legacy, '{"text":"中文"}\n', '旧写法不应得到完整字符')
  assert.ok(legacy.includes('\uFFFD'), '旧写法应出现 U+FFFD 替换字符，证明本用例确实挑战解码方式')
})

test('EOF flush：无尾换行的合法 JSON 在 end() 后交付一次，end() 幂等', () => {
  const { reader, lines, diagnostics } = makeReader()
  reader.write(Buffer.from('{"a":1}'))
  assert.equal(lines.length, 0, 'end() 之前不得交付半行')

  reader.end()
  assert.equal(lines.length, 1, '无尾换行的最后一行必须被 flush 一次')
  assert.deepEqual(JSON.parse(lines[0].line), { a: 1 })

  reader.end()
  assert.equal(lines.length, 1, '重复 end() 不得重复交付')
  assert.equal(diagnostics.length, 0)
})

test('600 KiB 合法单行：整块写入与 32 KiB 分块写入都完整交付', () => {
  const filler = 'x'.repeat(600 * 1024)
  const line = JSON.stringify({ payload: filler, n: 7 })
  assert.ok(Buffer.byteLength(line) > 600 * 1024)

  for (const mode of ['whole', 'chunked']) {
    const { reader, lines, diagnostics } = makeReader()
    const buffer = Buffer.from(`${line}\n`, 'utf8')
    if (mode === 'whole') {
      reader.write(buffer)
    } else {
      for (let offset = 0; offset < buffer.length; offset += 32 * 1024) {
        reader.write(buffer.subarray(offset, offset + 32 * 1024))
      }
    }
    reader.end()

    assert.equal(lines.length, 1, `${mode}：合法大行必须交付一次`)
    assert.equal(lines[0].meta.bytes, Buffer.byteLength(line))
    assert.equal(JSON.parse(lines[0].line).payload.length, filler.length, `${mode}：JSON 必须完整可解析`)
    assert.equal(diagnostics.length, 0, `${mode}：合法行不得产生诊断`)
  }
})

test('小上限下：小于上限的长行完整读回，初始缓冲可被覆盖', () => {
  const line = JSON.stringify({ payload: 'x'.repeat(300), n: 1 })
  assert.ok(Buffer.byteLength(line) > 256, '夹具必须明显长于常见 chunk')
  for (const options of [
    { maxLineBytes: 512 },
    { maxLineBytes: 512, initialLineBufferBytes: 16 },
  ]) {
    const { reader, lines, diagnostics } = makeReader(options)
    // 分块写入，确保跨多次 append、需要增长缓冲。
    for (let offset = 0; offset < line.length; offset += 64) {
      reader.write(line.slice(offset, offset + 64))
    }
    reader.write('\n')
    reader.end()

    assert.equal(lines.length, 1)
    assert.equal(lines[0].line, line, '小于上限的长行必须完整读回')
    assert.equal(diagnostics.length, 0, '合法行不得产生诊断')
  }
})

test('超长行整行丢弃、只记一条诊断，后续行不受污染', () => {
  const { reader, lines, diagnostics } = makeReader({ maxLineBytes: 1024 })
  const overlong = 'a'.repeat(2000)
  // 分块写入并跨越上限：后半段绝不能被当成新行继续解析。
  reader.write(Buffer.from(overlong.slice(0, 512)))
  reader.write(Buffer.from(overlong.slice(512)))
  reader.write(Buffer.from('\n{"ok":true}\n'))
  reader.end()

  assert.deepEqual(lines.map(entry => entry.line), ['{"ok":true}'])
  assert.equal(diagnostics.length, 1, '整条超长行只记一条诊断')
  assert.equal(diagnostics[0].kind, 'line-too-long')
  assert.equal(diagnostics[0].lineNo, 1)
  assert.equal(diagnostics[0].bytes, 2000, '诊断应报告被丢弃行的真实字节数')
  assert.ok(!lines.some(entry => entry.line.includes('aaaa')), '超长行后半段不得作为 JSON 行交付')
})

test('超长行丢弃后读取器继续：连续多个超长行之后仍能读后续行', () => {
  const { reader, lines, diagnostics } = makeReader({ maxLineBytes: 64 })
  reader.write('a'.repeat(40))
  reader.write('a'.repeat(40)) // 跨 write 累计到 80 > 64
  reader.write('\n{"after":1}\n')
  reader.write(`${'b'.repeat(200)}\n`)
  reader.write('{"after":2}\n')
  reader.end()

  assert.deepEqual(lines.map(entry => entry.line), ['{"after":1}', '{"after":2}'])
  assert.deepEqual(
    diagnostics.map(diag => [diag.kind, diag.lineNo, diag.bytes]),
    [['line-too-long', 1, 80], ['line-too-long', 3, 200]],
    '每条超长行各记一条诊断，行号与字节数准确',
  )
  assert.equal(reader.stats().droppedLines, 2)
})

test('BOM 剥离、CRLF 归一、空行 / 纯空白行跳过', () => {
  const { reader, lines, diagnostics } = makeReader()
  reader.write(Buffer.from('\uFEFF{"a":1}\r\n\r\n   \r\n{"b":2}\r\n', 'utf8'))
  reader.end()

  assert.deepEqual(lines.map(entry => entry.line), ['{"a":1}', '{"b":2}'])
  assert.equal(lines[1].meta.lineNo, 4, 'lineNo 是物理行号，跳过的空行也占行号')
  assert.equal(diagnostics.length, 0)
  assert.ok(lines.every(entry => !entry.line.includes('\r')), 'CRLF 的 \\r 必须剥掉')

  // EOF flush 路径同样要剥 CRLF 的 \r（最后一行没有尾换行）。
  const eof = makeReader()
  eof.reader.write('{"c":3}\r\n{"d":4}\r')
  eof.reader.end()
  assert.deepEqual(eof.lines.map(entry => entry.line), ['{"c":3}', '{"d":4}'])
  assert.ok(eof.lines.every(entry => !entry.line.includes('\r')), 'EOF flush 也不得带 \\r')
})

test('两个 reader 实例互不污染（初始进程 + resume 进程）', () => {
  const first = makeReader()
  const second = makeReader()

  first.reader.write(Buffer.from('{"first":1'))
  second.reader.write(Buffer.from('{"second":2}\n'))
  first.reader.write(Buffer.from('}\n'))
  second.reader.end()
  first.reader.end()

  assert.deepEqual(first.lines.map(entry => entry.line), ['{"first":1}'])
  assert.deepEqual(second.lines.map(entry => entry.line), ['{"second":2}'], 'resume reader 不得拼上一进程的半行')
})

test('onLine 抛错转成诊断，流继续交付后续行', () => {
  const seen = []
  const diagnostics = []
  const reader = createUtf8LineReader({
    onLine: line => {
      if (line === 'boom') throw new Error('handler failed: token=sk-should-not-leak')
      seen.push(line)
    },
    onDiagnostic: diag => diagnostics.push(diag),
  })

  reader.write('boom\nafter\n')
  reader.end()

  assert.deepEqual(seen, ['after'])
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].kind, 'on-line-error')
  assert.equal(diagnostics[0].lineNo, 1)
  assert.match(diagnostics[0].message, /handler failed/)
  assert.ok(!diagnostics[0].message.includes('sk-should-not-leak'), '诊断摘要必须脱敏')
  assert.ok(diagnostics[0].message.length <= 256)
})

test('诊断摘要剥掉 C0 控制字符（保留 \\t / \\n），且不切断 UTF-8 多字节字符', () => {
  const diagnostics = []
  let call = 0
  const reader = createUtf8LineReader({
    onLine: () => {
      call += 1
      if (call === 1) throw new Error('bad\u0000\u0007\u001b\tline\nend')
      // 255 个 ASCII + 一个 emoji（代理对）+ 1 个字符：按码元截断会留下半个 emoji。
      throw new Error(`${'x'.repeat(255)}😀y`)
    },
    onDiagnostic: diag => diagnostics.push(diag),
  })
  reader.write('boom\nalso\n')
  reader.end()

  assert.equal(diagnostics.length, 2)
  const [controls, astral] = diagnostics.map(diag => diag.message)
  assert.equal(controls, 'bad\tline\nend', 'C0 控制字符剥掉，\\t 与 \\n 保留')
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(controls))

  assert.ok([...astral].length <= 256, '摘要按码点有界')
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(astral), '不得留下孤立高代理')
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(astral), '不得留下孤立低代理')
  assert.equal(Buffer.from(astral, 'utf8').toString('utf8'), astral, '诊断串必须能原样编码回 UTF-8')
  assert.ok(!astral.includes('\uFFFD'), '不得出现替换字符（半个多字节字符）')
})

test('诊断摘要剥掉裸 \\r 与其它 C0（只保留 \\t / \\n）', () => {
  const diagnostics = []
  const reader = createUtf8LineReader({
    onLine: () => {
      // 裸 CR（0x0D）不在旧的 C0 范围里，会原样进日志；BEL / ESC 一并验证。
      throw new Error('a\tb\nc\rd\u0007e\u001bf')
    },
    onDiagnostic: diag => diagnostics.push(diag),
  })
  reader.write('boom\n')
  reader.end()

  assert.equal(diagnostics.length, 1)
  const message = diagnostics[0].message
  assert.equal(message, 'a\tb\ncdef', '只保留 \\t / \\n，裸 CR 与其它 C0 一起剥掉')
  assert.ok(!message.includes('\r'), '不得残留裸 CR')
  assert.ok(!/[\u0000-\u0008\u000B-\u001F]/.test(message), '除 \\t / \\n 外的 C0 必须全部剥掉')
})

test('诊断有界：超过上限后只计数不再保留', () => {
  const diagnostics = []
  const reader = createUtf8LineReader({
    maxLineBytes: 8,
    maxDiagnostics: 2,
    onLine: () => {},
    onDiagnostic: diag => diagnostics.push(diag),
  })
  for (let index = 0; index < 5; index += 1) reader.write(`${'z'.repeat(16)}\n`)
  reader.end()

  assert.equal(diagnostics.length, 2)
  const stats = reader.stats()
  assert.equal(stats.droppedLines, 5)
  assert.equal(stats.diagnostics, 5)
  assert.equal(stats.diagnosticsDropped, 3)
})

test('abort 后不再交付行，stats 标记 aborted', () => {
  const { reader, lines } = makeReader()
  reader.write('{"before":1}\n')
  reader.abort('test-abort')
  reader.write('{"after":2}\n')
  reader.end()

  assert.deepEqual(lines.map(entry => entry.line), ['{"before":1}'])
  const stats = reader.stats()
  assert.equal(stats.aborted, true)
  assert.equal(stats.abortReason, 'test-abort')
})

test('真实子进程：stdout 行交付、stderr tail 独立、drained 在 stdout end 后完成', async () => {
  const { reader, lines } = makeReader()
  const script = "process.stdout.write('{\"a\":1}\\n{\"b\":2}\\n'); process.stderr.write('stderr-line\\n')"
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  const attach = attachProcessStreams(child, { stdoutReader: reader, drainTimeoutMs: 3000 })
  try {
    const drained = await attach.drained
    assert.deepEqual(drained, { drained: true, timedOut: false })

    assert.deepEqual(lines.map(entry => entry.line), ['{"a":1}', '{"b":2}'])
    assert.equal(attach.stdoutTail(), '{"a":1}\n{"b":2}\n')
    assert.match(attach.stderrTail(), /stderr-line/)
    // 展示 tail 与协议缓冲分离：reader 的行不受 tail 上限影响（见下一个用例）。
    assert.equal(attach.diagnostics().length, 0)
  } finally {
    attach.dispose()
    await waitExit(child)
  }
})

test('展示 tail 有界且 UTF-8 安全，完整行交付不受 tail 上限影响', async () => {
  const { reader, lines } = makeReader()
  const payload = JSON.stringify({ big: '汉'.repeat(2000) })
  const script = `process.stdout.write(${JSON.stringify(`${payload}\n`)})`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  const attach = attachProcessStreams(child, {
    stdoutReader: reader,
    stdoutTailBytes: 128,
    stderrTailBytes: 32,
    drainTimeoutMs: 3000,
  })
  try {
    const drained = await attach.drained
    assert.deepEqual(drained, { drained: true, timedOut: false })
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0].line).big.length, 2000, '完整行必须交付，不受 tail 上限影响')

    const tail = attach.stdoutTail()
    assert.ok(tail.length > 0)
    assert.ok(Buffer.byteLength(tail, 'utf8') <= 128, `tail 应按字节有界，实际 ${Buffer.byteLength(tail)}`)
    assert.ok(!tail.includes('\uFFFD'), 'tail 解码不得产生替换字符（UTF-8 安全）')
    assert.ok(`${payload}\n`.endsWith(tail), 'tail 应是输出末尾的后缀')
  } finally {
    attach.dispose()
    await waitExit(child)
  }
})

test('tail 先整段脱敏再截尾：键名落在展示上限之外也不得泄漏（0.15.1）', async () => {
  const { reader } = makeReader()
  // 键名（password=）离输出末尾约 1.5 KiB，旧实现先切 64 字节再脱敏时键名已被切掉，
  // 值里的 hunter2 会原样出现在 tail 里。新实现保留「上限 + 余量」的原始窗口再脱敏。
  const stdoutPayload = `${'x'.repeat(2000)} password="${'y'.repeat(1500)}; hunter2"`
  const stderrPayload = `${'z'.repeat(1200)} password="${'w'.repeat(900)}; hunter2"`
  const script = `process.stdout.write(${JSON.stringify(stdoutPayload)}); process.stderr.write(${JSON.stringify(stderrPayload)})`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  const attach = attachProcessStreams(child, {
    stdoutReader: reader,
    stdoutTailBytes: 64,
    stderrTailBytes: 32,
    drainTimeoutMs: 3000,
  })
  try {
    assert.deepEqual(await attach.drained, { drained: true, timedOut: false })
    const stdoutTail = attach.stdoutTail()
    const stderrTail = attach.stderrTail()
    assert.ok(!stdoutTail.includes('hunter2'), `stdout tail 不得泄漏（实际 ${JSON.stringify(stdoutTail)}）`)
    assert.match(stdoutTail, /\[REDACTED\]/, 'stdout tail 应包含脱敏标记')
    assert.ok(Buffer.byteLength(stdoutTail, 'utf8') <= 64, 'stdout tail 仍按展示上限有界')
    assert.ok(!stderrTail.includes('hunter2'), `stderr tail 不得泄漏（实际 ${JSON.stringify(stderrTail)}）`)
    assert.match(stderrTail, /\[REDACTED\]/, 'stderr tail 应包含脱敏标记')
    assert.ok(Buffer.byteLength(stderrTail, 'utf8') <= 32, 'stderr tail 仍按展示上限有界')
  } finally {
    attach.dispose()
    await waitExit(child)
  }
})

test('drained 有界：后代继承 stdout 时超时返回 timedOut，而不是无限等待', async () => {
  const { reader } = makeReader()
  // 父进程把 stdout 继承给一个长期存活的后代后自己退出：pipe 不会 close。
  const script = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] })",
    'child.unref()',
    "process.stderr.write('grandchild=' + child.pid + '\\n')",
  ].join(';')
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })
  const attach = attachProcessStreams(child, { stdoutReader: reader, drainTimeoutMs: 250 })
  let grandchildPid = null
  try {
    grandchildPid = await waitFor(() => {
      const match = /grandchild=(\d+)/.exec(stderr)
      return match ? Number(match[1]) : null
    }, 3000)

    const startedAt = Date.now()
    const drained = await attach.drained
    const elapsed = Date.now() - startedAt

    assert.deepEqual(drained, { drained: false, timedOut: true })
    assert.ok(elapsed >= 200, `应等到排空期限，实际 ${elapsed}ms`)
    assert.ok(elapsed < 3000, `排空必须有限，实际 ${elapsed}ms`)
  } finally {
    if (grandchildPid) {
      try {
        process.kill(grandchildPid, 'SIGKILL')
      } catch {
        // 已经退出
      }
    }
    attach.dispose()
    await waitExit(child)
  }
})

test('resume 场景：上一进程无尾换行的半行不得拼进下一进程的完整行', async () => {
  const first = makeReader()
  const second = makeReader()

  const firstChild = spawn(process.execPath, ['-e', "process.stdout.write('{\"first\":1')"], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const firstAttach = attachProcessStreams(firstChild, { stdoutReader: first.reader, drainTimeoutMs: 3000 })
  try {
    assert.deepEqual(await firstAttach.drained, { drained: true, timedOut: false })
    assert.deepEqual(first.lines.map(entry => entry.line), ['{"first":1'], 'EOF flush 应交付上一进程的残留半行')

    const secondChild = spawn(process.execPath, ['-e', "process.stdout.write('{\"second\":2}\\n')"], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const secondAttach = attachProcessStreams(secondChild, { stdoutReader: second.reader, drainTimeoutMs: 3000 })
    try {
      assert.deepEqual(await secondAttach.drained, { drained: true, timedOut: false })
      assert.deepEqual(second.lines.map(entry => entry.line), ['{"second":2}'])
    } finally {
      secondAttach.dispose()
      await waitExit(secondChild)
    }
  } finally {
    firstAttach.dispose()
    await waitExit(firstChild)
  }
})

test('真实子进程：超长协议行被整行丢弃，非法 JSON 内容不进入 reader', async () => {
  const { reader, lines, diagnostics } = makeReader({ maxLineBytes: 1024 })
  const script = [
    `process.stdout.write('x'.repeat(4096) + '\\n')`,
    `process.stdout.write('{"ok":true}\\n')`,
  ].join(';')
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  const attach = attachProcessStreams(child, { stdoutReader: reader, drainTimeoutMs: 3000 })
  try {
    assert.deepEqual(await attach.drained, { drained: true, timedOut: false })
    assert.deepEqual(lines.map(entry => entry.line), ['{"ok":true}'])
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].kind, 'line-too-long')
  } finally {
    attach.dispose()
    await waitExit(child)
  }
  assert.equal(isAlive(child.pid), false)
})
