#!/usr/bin/env node
/**
 * R5（0.11 §7）宿主检查执行器 + 节点检查配置（node-check）的自检。
 *
 * 真子进程（`sh -c` / `sleep` / `node -e`），总时长刻意压在 20s 以内：
 * 超时用例 1s、取消用例 0.1s，其余全是毫秒级命令。
 *
 * 直接 `node test/host-check.test.mjs`，不需要安装插件。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CHECK_LIMITS, normalizeNodeCheck, validateNodeCheck,
} from '../src/node-check.js'
import {
  HOST_CHECK_REASON, buildHostCheckInvocation, redactSensitiveText, runHostCheck,
} from '../src/host-check.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-host-check-'))
let dirSeq = 0
function freshCwd() {
  const dir = join(root, `case-${++dirSeq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

let checks = 0
const failures = []
async function check(name, fn) {
  try {
    await fn()
    checks += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`  ✗ ${name}`)
    console.error(error && error.stack ? error.stack : String(error))
  }
}

function assertChinese(message, where = 'message') {
  assert.equal(typeof message, 'string', `${where} 应当是可读字符串`)
  assert.match(message, /[\u4e00-\u9fa5]/, `${where} 应当是中文可行动原因：${message}`)
}

console.log('host-check.js')

await check('buildHostCheckInvocation 固定 sh -c 单 argv，不 split、不插值、不套 shell', () => {
  const command = 'echo "a b" && printf \'%s\' "$HOME" ; echo `nested`\n# 注释也不拆'
  const invocation = buildHostCheckInvocation({ command }, { cwd: '/tmp' })
  assert.equal(invocation.file, 'sh')
  assert.equal(invocation.cwd, '/tmp')
  assert.equal(invocation.shell, false, '必须显式 shell:false，防 Node 再套一层 shell')
  assert.deepEqual(invocation.argv, ['-c', command], '整条命令必须是一个 argv 元素')
  assert.equal(invocation.argv.length, 2)
  assert.equal(invocation.argv[1], command)
})

await check('buildHostCheckInvocation 对非法配置抛 HOST_CHECK_INVALID（带字段定位）', () => {
  assert.throws(
    () => buildHostCheckInvocation({ command: '   ' }),
    error => error.code === HOST_CHECK_REASON.INVALID
      && error.field === 'command'
      && /[\u4e00-\u9fa5]/.test(error.message),
  )
})

await check('真 exit 1 → fail / HOST_CHECK_EXIT', async () => {
  const result = await runHostCheck({ check: { command: 'exit 1' }, cwd: freshCwd() })
  assert.equal(result.state, 'fail')
  assert.equal(result.reasonCode, HOST_CHECK_REASON.EXIT)
  assert.equal(result.exitCode, 1)
  assert.equal(result.expectedExitCode, 0)
  assertChinese(result.message)
})

await check('exit 7 + expectExitCode 7 → pass（非零期望退出码同样支持）', async () => {
  const result = await runHostCheck({
    check: { command: 'exit 7', expectExitCode: 7 },
    cwd: freshCwd(),
  })
  assert.equal(result.state, 'pass')
  assert.equal(result.reasonCode, null)
  assert.equal(result.exitCode, 7)
  assert.equal(result.expectedExitCode, 7)
  assert.equal(result.truncated, false)
})

await check('reportPath：本次新建报告 → pass，sha256 / 字节副本正确', async () => {
  const dir = freshCwd()
  const content = '{"ok":true}'
  const result = await runHostCheck({
    check: {
      command: "mkdir -p reports && printf '{\"ok\":true}' > reports/unit.json",
      reportPath: 'reports/unit.json',
    },
    cwd: dir,
  })
  assert.equal(result.state, 'pass')
  assert.equal(result.reasonCode, null)
  assert.equal(result.reportPath, 'reports/unit.json', '结果只回配置里的相对路径')
  assert.equal(result.reportByteLength, Buffer.byteLength(content))
  assert.ok(Buffer.isBuffer(result.reportBytes), 'reportBytes 应当是报告字节的独立副本')
  assert.equal(result.reportBytes.toString('utf8'), content)
  const expected = createHash('sha256').update(content).digest('hex')
  assert.equal(result.reportSha256, expected)
  assert.equal(readFileSync(join(dir, 'reports/unit.json'), 'utf8'), content)

  // 副本语义：执行后原 cwd 文件再变，也不影响已经采集的字节与 hash。
  writeFileSync(join(dir, 'reports/unit.json'), 'changed-later')
  assert.equal(result.reportBytes.toString('utf8'), content)
  assert.equal(result.reportSha256, expected)
})

await check('F3 reportPath：公开报告副本先脱敏、再按最终副本算 hash（token canary 不外泄）', async () => {
  const dir = freshCwd()
  const canary = 'canary-report-7f3a'
  const raw = `{"token":"${canary}","note":"token=${canary}"}`
  const result = await runHostCheck({
    check: {
      command: `mkdir -p reports && printf '%s' '${raw}' > reports/secret.json`,
      reportPath: 'reports/secret.json',
    },
    cwd: dir,
  })
  assert.equal(result.state, 'pass')
  const copy = result.reportBytes.toString('utf8')
  assert.doesNotMatch(copy, /canary-report-7f3a/, '公开副本不得包含报告里的原始凭据')
  assert.match(copy, /\[REDACTED\]/, '命中凭据规则的片段必须替换为 [REDACTED]')
  assert.equal(result.reportByteLength, Buffer.byteLength(copy), '长度必须对最终副本计算')
  assert.equal(
    result.reportSha256,
    createHash('sha256').update(copy).digest('hex'),
    'hash 必须绑定脱敏后的最终副本（顺序不能反）',
  )
  // 副本语义：只脱敏内存副本，不写回调用方 cwd 的原始报告。
  assert.equal(readFileSync(join(dir, 'reports/secret.json'), 'utf8'), raw)
})

await check('F3 reportPath：正常 UTF-8 文本报告照旧脱敏，非凭据内容逐字保留', async () => {
  const dir = freshCwd()
  const raw = '{"ok":true,"note":"plain text","token":"canary-utf8-2a"}'
  const result = await runHostCheck({
    check: {
      command: `mkdir -p reports && printf '%s' '${raw}' > reports/utf8.json`,
      reportPath: 'reports/utf8.json',
    },
    cwd: dir,
  })
  assert.equal(result.state, 'pass')
  const copy = result.reportBytes.toString('utf8')
  assert.equal(copy.includes('canary-utf8-2a'), false, '文本报告里的凭据必须脱敏')
  assert.equal(copy.includes('"ok":true'), true, '非凭据字段必须原样保留')
  assert.equal(copy.includes('plain text'), true, '非凭据文本必须原样保留')
  assert.equal(result.reportByteLength, Buffer.byteLength(copy))
  assert.equal(result.reportSha256, createHash('sha256').update(copy).digest('hex'))
  assert.equal(readFileSync(join(dir, 'reports/utf8.json'), 'utf8'), raw, '不写回源报告')
})

await check('F3 reportPath：二进制 / 非法 UTF-8 报告按字节脱敏，公开副本不含 canary', async () => {
  const dir = freshCwd()
  const canary = 'canary-bin-9c1f'
  mkdirSync(join(dir, 'reports'))
  const head = Buffer.from([0xff, 0xfe, 0x00, 0x89])
  const tail = Buffer.from([0x80, 0x81, 0x82])
  const seed = Buffer.concat([
    head,
    Buffer.from(`\u0000prefix token=${canary} suffix\u0001`, 'utf8'),
    tail,
  ])
  writeFileSync(join(dir, 'seed.bin'), seed)
  const result = await runHostCheck({
    check: { command: 'cp seed.bin reports/probe.bin', reportPath: 'reports/probe.bin' },
    cwd: dir,
  })
  assert.equal(result.state, 'pass')
  assert.ok(Buffer.isBuffer(result.reportBytes), '公开副本必须是独立 Buffer')
  const copy = result.reportBytes
  assert.equal(copy.includes(Buffer.from(canary)), false, '二进制公开副本不得包含原始凭据字节')
  assert.equal(copy.includes(Buffer.from('[REDACTED]')), true, '命中的凭据字节段必须替换为 [REDACTED]')
  assert.equal(result.reportOpaque, true, '二进制报告必须标注 opaque')
  assert.equal(result.reportByteLength, copy.length, '长度必须对脱敏后的最终字节计算')
  assert.equal(
    result.reportSha256,
    createHash('sha256').update(copy).digest('hex'),
    'hash 必须绑定脱敏后的最终字节（顺序不能反）',
  )
  // 非凭据字节逐字节保留：只替换命中的凭据段，不整体重编码。
  assert.deepEqual(Array.from(copy.subarray(0, head.length)), Array.from(head))
  assert.deepEqual(Array.from(copy.subarray(copy.length - tail.length)), Array.from(tail))
  assert.equal(readFileSync(join(dir, 'reports/probe.bin')).equals(seed), true, '不写回源报告')
})

await check('reportPath：不含凭据的二进制报告逐字节原样通过（不被脱敏判坏）', async () => {
  const dir = freshCwd()
  mkdirSync(join(dir, 'reports'))
  const seed = Buffer.from([
    0xff, 0xfe, 0x00, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x80, 0x81,
  ])
  writeFileSync(join(dir, 'seed.bin'), seed)
  const result = await runHostCheck({
    check: { command: 'cp seed.bin reports/clean.bin', reportPath: 'reports/clean.bin' },
    cwd: dir,
  })
  assert.equal(result.state, 'pass', '不含凭据的二进制报告仍必须能作为证据通过验证')
  assert.equal(result.reportBytes.equals(seed), true, '非凭据二进制必须逐字节原样保留')
  assert.equal(result.reportByteLength, seed.length)
  assert.equal(result.reportSha256, createHash('sha256').update(seed).digest('hex'))
})

await check('reportPath：二进制里的 ≥32 ASCII 串（非凭据）不被启发式误伤', async () => {
  const dir = freshCwd()
  mkdirSync(join(dir, 'reports'))
  // 64 个十六进制字符：文本路径的「≥32 连续可疑串」启发式会命中，二进制路径必须放过。
  const hex = 'abcdef0123456789'.repeat(4)
  const seed = Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x00, 0x89]),
    Buffer.from(`header ${hex} tail`, 'utf8'),
    Buffer.from([0x80, 0x81]),
  ])
  writeFileSync(join(dir, 'seed.bin'), seed)
  const result = await runHostCheck({
    check: { command: 'cp seed.bin reports/hex.bin', reportPath: 'reports/hex.bin' },
    cwd: dir,
  })
  assert.equal(result.state, 'pass')
  assert.equal(
    result.reportBytes.equals(seed),
    true,
    '二进制路径不得用 ≥32 启发式改写非凭据字节（否则 sha256 与逐字节证据都会被破坏）',
  )
  assert.equal(result.reportByteLength, seed.length)
  assert.equal(result.reportSha256, createHash('sha256').update(seed).digest('hex'))
})

await check('F3 reportPath：二进制里的空格形态凭据也按字节脱敏', async () => {
  const dir = freshCwd()
  const canary = 'canary-bin-space-6d2e'
  mkdirSync(join(dir, 'reports'))
  const seed = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`\u0000curl --token ${canary} --api-key ${canary}-key --verbose http://127.0.0.1/x\u0001`, 'utf8'),
    Buffer.from([0x80, 0x81]),
  ])
  writeFileSync(join(dir, 'seed.bin'), seed)
  const result = await runHostCheck({
    check: { command: 'cp seed.bin reports/space.bin', reportPath: 'reports/space.bin' },
    cwd: dir,
  })
  assert.equal(result.state, 'pass')
  const copy = result.reportBytes
  assert.equal(copy.includes(Buffer.from(canary)), false, '二进制副本不得含空格形态凭据')
  assert.equal(copy.includes(Buffer.from(`${canary}-key`)), false)
  assert.equal(copy.includes(Buffer.from('--verbose')), true, '后面的正常参数（--verbose）不能被吞掉')
  assert.equal(copy.includes(Buffer.from('http://127.0.0.1/x')), true, '后面的 URL 不能被吞掉')
})

// 0.11 N6（复核2）：标志位的「前导分隔符」是文本假设。二进制记录里标志位前往往是
// NUL / 长度前缀 / protobuf tag 等任意字节，旧规则的字符类 `[\s"'`;|&(=,\[]` 不命中，
// `--api-key <值>` / `--password <值>` 会原样进公开副本。
await check('N6：二进制报告里标志位前是 NUL / 控制字节时也必须按字节脱敏', async () => {
  const dir = freshCwd()
  const canary = 'canary-n6-bin-5c2a'
  mkdirSync(join(dir, 'reports'))
  const seed = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from([0x1c, 0x00]),
    Buffer.from(`--api-key ${canary}`),
    Buffer.from([0x12]),
    Buffer.from(`--password ${canary}-pw`),
    Buffer.from([0x80, 0x81]),
  ])
  writeFileSync(join(dir, 'seed.bin'), seed)
  const result = await runHostCheck({
    check: { command: 'cp seed.bin reports/flags.bin', reportPath: 'reports/flags.bin' },
    cwd: dir,
  })
  assert.equal(result.state, 'pass')
  const copy = result.reportBytes
  assert.equal(copy.includes(Buffer.from(canary)), false, 'NUL 前面的 --api-key 值不得泄漏')
  assert.equal(copy.includes(Buffer.from(`${canary}-pw`)), false, '控制字节前面的 --password 值不得泄漏')
  assert.equal(copy.includes(Buffer.from('--api-key [REDACTED]')), true, '标志位与 [REDACTED] 标记必须保留')
  assert.equal(copy.includes(Buffer.from('--password [REDACTED]')), true, '标志位与 [REDACTED] 标记必须保留')
  // 非命中字节逐字节保留：0xFF/0xFE 头、前导控制字节、尾部高位字节都不许被改写。
  assert.equal(copy[0], 0xff)
  assert.equal(copy[1], 0xfe)
  assert.equal(copy.includes(Buffer.from([0x1c, 0x00])), true, '未被命中的前导字节必须原样保留')
  assert.equal(copy.includes(Buffer.from([0x12])), true)
  assert.deepEqual(Array.from(copy.subarray(copy.length - 2)), [0x80, 0x81])
  assert.equal(result.reportOpaque, true)
})

// 同一缺陷在文本路径同样存在：`\u0000--api-key <值>` 是合法 UTF-8，会走文本脱敏。
await check('N6：文本报告里标志位前是 NUL / 控制字节时也脱敏（合法 UTF-8 路径）', async () => {
  const dir = freshCwd()
  const canary = 'canary-n6-text-7b3d'
  mkdirSync(join(dir, 'reports'))
  const raw = `\u0000--api-key ${canary}\u0001 tail`
  writeFileSync(join(dir, 'seed.txt'), Buffer.from(raw, 'utf8'))
  const result = await runHostCheck({
    check: { command: 'cp seed.txt reports/flags.txt', reportPath: 'reports/flags.txt' },
    cwd: dir,
  })
  assert.equal(result.state, 'pass')
  const copy = result.reportBytes.toString('utf8')
  assert.equal(copy.includes(canary), false, 'NUL 前面的 --api-key 值不得泄漏（文本路径）')
  assert.equal(copy, `\u0000--api-key [REDACTED]\u0001 tail`,
    '只替换凭据值，前导 NUL / 后续控制字节与普通文本必须原样保留')
  assert.equal(result.reportOpaque, false, '合法 UTF-8 报告仍走文本路径')
})

// 0.11 N7（复核2）：`token=<值>` 的值字符类原本包含 NUL，会把其后的 `\0tail` 一起吞掉，
// 公开副本因此变短、丢失非凭据字节。二进制路径与文本路径都必须只替换凭据段。
await check('N7：二进制报告 token=<canary>\\0tail 只替换凭据段，尾部 NUL+tail 逐字节保留', async () => {
  const dir = freshCwd()
  const canary = 'canary-n7-bin-2f61'
  mkdirSync(join(dir, 'reports'))
  const seed = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`token=${canary}`),
    Buffer.from([0x00]),
    Buffer.from('tail'),
  ])
  writeFileSync(join(dir, 'seed.bin'), seed)
  const result = await runHostCheck({
    check: { command: 'cp seed.bin reports/nul.bin', reportPath: 'reports/nul.bin' },
    cwd: dir,
  })
  assert.equal(result.state, 'pass')
  const copy = result.reportBytes
  const expected = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('token="[REDACTED]"'),
    Buffer.from([0x00]),
    Buffer.from('tail'),
  ])
  assert.equal(copy.equals(expected), true,
    `脱敏副本必须精确等于「原字节里只把凭据值换成 [REDACTED]」：实际 ${copy.toString('hex')} / 预期 ${expected.toString('hex')}`)
  assert.equal(copy.includes(Buffer.from(canary)), false, '凭据不得泄漏')
  assert.deepEqual(Array.from(copy.subarray(copy.length - 5)), [0x00, 0x74, 0x61, 0x69, 0x6c],
    '尾部 NUL+tail 五个字节必须原样保留（不得被值规则吞掉）')
  assert.equal(copy.length, seed.length - canary.length + '"[REDACTED]"'.length,
    '长度差必须恰好是「凭据值 → "[REDACTED]"」的差值')
  assert.equal(result.reportOpaque, true)
  assert.equal(result.reportSha256, createHash('sha256').update(copy).digest('hex'))
})

await check('N7：文本报告 token=<canary>\\0tail 只替换凭据段，尾部 NUL+tail 逐字节保留', async () => {
  const dir = freshCwd()
  const canary = 'canary-n7-text-9a04'
  mkdirSync(join(dir, 'reports'))
  const seed = Buffer.from(`token=${canary}\u0000tail`, 'utf8')
  writeFileSync(join(dir, 'seed.txt'), seed)
  const result = await runHostCheck({
    check: { command: 'cp seed.txt reports/nul.txt', reportPath: 'reports/nul.txt' },
    cwd: dir,
  })
  assert.equal(result.state, 'pass')
  const copy = result.reportBytes
  const expected = Buffer.from(`token="[REDACTED]"\u0000tail`, 'utf8')
  assert.equal(copy.equals(expected), true,
    `文本路径脱敏副本必须精确等于预期：实际 ${copy.toString('hex')} / 预期 ${expected.toString('hex')}`)
  assert.equal(copy.includes(Buffer.from(canary)), false, '凭据不得泄漏')
  assert.deepEqual(Array.from(copy.subarray(copy.length - 5)), [0x00, 0x74, 0x61, 0x69, 0x6c],
    '尾部 NUL+tail 五个字节必须原样保留')
  assert.equal(result.reportOpaque, false, '合法 UTF-8 报告仍走文本路径')
})

// 反向锁：新规则把「前一个字节不是 [A-Za-z0-9_-]」当分隔判据，不能因此把
// `--token-file` / `--tokenize` 这类更长参数名当成 `--token` 并吞掉后面的文件名。
await check('N7 反向锁：二进制里的 --token-file / --tokenize 后正常文件名不被吞', async () => {
  const dir = freshCwd()
  mkdirSync(join(dir, 'reports'))
  const seed = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('\u0000cat --token-file reports/unit.json --tokenize reports/x --token-file=reports/y\u0001'),
    Buffer.from([0x80]),
  ])
  writeFileSync(join(dir, 'seed.bin'), seed)
  const result = await runHostCheck({
    check: { command: 'cp seed.bin reports/tokenfile.bin', reportPath: 'reports/tokenfile.bin' },
    cwd: dir,
  })
  assert.equal(result.state, 'pass')
  assert.equal(result.reportBytes.equals(seed), true,
    '不含独立 --token 参数的二进制报告必须逐字节不变（--token-file / --tokenize 不是凭据标志位）')
  assert.equal(result.reportSha256, createHash('sha256').update(seed).digest('hex'))
  assert.equal(result.reportOpaque, true)
})

await check('reportPath：执行前已存在且未更新 → fail / HOST_CHECK_REPORT_STALE', async () => {
  const dir = freshCwd()
  mkdirSync(join(dir, 'reports'))
  writeFileSync(join(dir, 'reports/stale.json'), 'old-report')
  const result = await runHostCheck({
    check: { command: 'true', reportPath: 'reports/stale.json' },
    cwd: dir,
  })
  assert.equal(result.state, 'fail')
  assert.equal(result.reasonCode, HOST_CHECK_REASON.REPORT_STALE)
  assertChinese(result.message)
})

await check('reportPath：重写相同内容也算更新 → pass（内容不参与新鲜性判据）', async () => {
  const dir = freshCwd()
  mkdirSync(join(dir, 'reports'))
  writeFileSync(join(dir, 'reports/same.json'), 'same-content')
  // 让旧文件落在更早的时间戳桶里：部分文件系统 mtime 粒度是毫秒/时钟 tick 级，
  // 同一 tick 内「创建 → 重写相同内容」可能看起来完全没变（真实运行不会这么紧凑）。
  await sleep(30)
  const result = await runHostCheck({
    check: { command: 'printf same-content > reports/same.json', reportPath: 'reports/same.json' },
    cwd: dir,
  })
  assert.equal(result.state, 'pass', '只改 mtime/ctime 的重写必须算更新')
  assert.equal(result.reportSha256, createHash('sha256').update('same-content').digest('hex'))
})

await check('reportPath：写坏内容但确实更新 → pass（不做 JSON 解析）', async () => {
  const dir = freshCwd()
  mkdirSync(join(dir, 'reports'))
  writeFileSync(join(dir, 'reports/garbage.json'), 'old')
  const result = await runHostCheck({
    check: { command: "printf 'not-json' > reports/garbage.json", reportPath: 'reports/garbage.json' },
    cwd: dir,
  })
  assert.equal(result.state, 'pass')
  assert.equal(result.reportSha256, createHash('sha256').update('not-json').digest('hex'))
})

await check('reportPath：符号链接 → fail / HOST_CHECK_REPORT_INVALID', async () => {
  const dir = freshCwd()
  mkdirSync(join(dir, 'reports'))
  writeFileSync(join(dir, 'reports/real.json'), 'real')
  symlinkSync(join(dir, 'reports/real.json'), join(dir, 'reports/link.json'))
  const result = await runHostCheck({
    check: { command: 'true', reportPath: 'reports/link.json' },
    cwd: dir,
  })
  assert.equal(result.state, 'fail')
  assert.equal(result.reasonCode, HOST_CHECK_REASON.REPORT_INVALID)
  assertChinese(result.message)
})

await check('reportPath：> 1MiB → fail / HOST_CHECK_REPORT_TOO_LARGE（不截短判通过）', async () => {
  const dir = freshCwd()
  mkdirSync(join(dir, 'reports'))
  const result = await runHostCheck({
    check: {
      command: 'head -c 1048577 /dev/zero > reports/big.bin',
      reportPath: 'reports/big.bin',
    },
    cwd: dir,
  })
  assert.equal(result.state, 'fail')
  assert.equal(result.reasonCode, HOST_CHECK_REASON.REPORT_TOO_LARGE)
  assert.equal(result.reportBytes, null)
  assertChinese(result.message)
})

await check('reportPath：命令没生成报告 → fail / HOST_CHECK_REPORT_MISSING', async () => {
  const result = await runHostCheck({
    check: { command: 'true', reportPath: 'reports/missing.json' },
    cwd: freshCwd(),
  })
  assert.equal(result.state, 'fail')
  assert.equal(result.reasonCode, HOST_CHECK_REASON.REPORT_MISSING)
})

await check('超时（sleep 5 + timeoutMs 1000）→ HOST_CHECK_TIMEOUT 且进程组被杀', async () => {
  const dir = freshCwd()
  const started = Date.now()
  const result = await runHostCheck({
    check: { command: 'sleep 5; touch after.txt', timeoutMs: 1000 },
    cwd: dir,
  })
  const elapsed = Date.now() - started
  assert.equal(result.state, 'fail')
  assert.equal(result.reasonCode, HOST_CHECK_REASON.TIMEOUT)
  assert.equal(result.killScope, 'group', 'POSIX 上必须按进程组终止')
  assert.ok(elapsed < 1500, `超时收口应当 <1.5s，实际 ${elapsed}ms`)
  // 孙进程（sleep 之后那条 touch）必须在同一进程组里一起被杀掉。
  await sleep(300)
  assert.equal(existsSync(join(dir, 'after.txt')), false, '进程组没杀干净：sleep 后的命令还执行了')
})

await check('取消（AbortSignal）→ skipped / HOST_CHECK_CANCELLED 且杀组', async () => {
  const dir = freshCwd()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const started = Date.now()
  const result = await runHostCheck({
    check: { command: 'sleep 5; touch after.txt' },
    cwd: dir,
    signal: controller.signal,
  })
  assert.equal(result.state, 'skipped')
  assert.equal(result.reasonCode, HOST_CHECK_REASON.CANCELLED)
  assert.ok(Date.now() - started < 1000)
  assert.equal(result.killScope, 'group')
  await sleep(300)
  assert.equal(existsSync(join(dir, 'after.txt')), false)
})

await check('启动前已取消 → skipped / HOST_CHECK_CANCELLED（不起进程）', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await runHostCheck({
    check: { command: 'touch never.txt' },
    cwd: freshCwd(),
    signal: controller.signal,
  })
  assert.equal(result.state, 'skipped')
  assert.equal(result.reasonCode, HOST_CHECK_REASON.CANCELLED)
})

await check('输出超限（maxOutputBytes 小）→ fail / OUTPUT_LIMIT + truncated', async () => {
  const result = await runHostCheck({
    check: { command: "node -e \"process.stdout.write('x'.repeat(200000))\"" },
    cwd: freshCwd(),
    maxOutputBytes: 4096,
  })
  assert.equal(result.state, 'fail')
  assert.equal(result.reasonCode, 'OUTPUT_LIMIT')
  assert.equal(result.truncated, true)
  assert.ok(result.receivedBytes > 4096, `receivedBytes 应当超过上限，实际 ${result.receivedBytes}`)
})

await check('输出恰好等于上限 → 合法（只超一个字节才 OUTPUT_LIMIT）', async () => {
  const result = await runHostCheck({
    check: { command: "node -e \"process.stdout.write('x'.repeat(1024))\"" },
    cwd: freshCwd(),
    maxOutputBytes: 1024,
  })
  assert.equal(result.state, 'pass')
  assert.equal(result.truncated, false)
  assert.equal(result.receivedBytes, 1024)
})

await check('输出含 canary token → outputTail 脱敏且不含原值', async () => {
  const dir = freshCwd()
  const sk = 'sk-secretcanary123456'
  const kv = 'CANARYTOKENVALUE0123456789'
  const long = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
  const result = await runHostCheck({
    check: { command: `printf '${sk} token=${kv} ${long}\\n'` },
    cwd: dir,
  })
  assert.equal(result.state, 'pass')
  assert.match(result.outputTail, /\[REDACTED\]/)
  for (const secret of [sk, kv, long]) {
    assert.equal(result.outputTail.includes(secret), false, `outputTail 泄漏了凭据：${secret}`)
  }
  assert.ok(Buffer.byteLength(result.outputTail, 'utf8') <= 16 * 1024, 'outputTail 必须 ≤16KiB')
})

await check('输出含 --token <value> 空格形态 → outputTail 也必须脱敏', async () => {
  const canary = 'canary-space-4b7d'
  const line = `curl --token ${canary} --api-key ${canary}-key -H "Authorization: Bearer ${canary}-bearer" http://127.0.0.1/report.json`
  const result = await runHostCheck({
    check: { command: `printf '%s\\n' '${line}'` },
    cwd: freshCwd(),
  })
  assert.equal(result.state, 'pass')
  for (const secret of [canary, `${canary}-key`, `${canary}-bearer`]) {
    assert.equal(result.outputTail.includes(secret), false, `outputTail 泄漏了空格/引号形态凭据：${secret}`)
  }
  assert.match(result.outputTail, /--token \[REDACTED\]/, '--token 的值必须替换')
  assert.match(result.outputTail, /--api-key \[REDACTED\]/, '--api-key 的值必须替换')
  assert.match(result.outputTail, /Bearer \[REDACTED\]/, 'Authorization Bearer 必须替换')
  assert.equal(
    result.outputTail.includes('http://127.0.0.1/report.json'),
    true,
    '后面的正常 URL / 文件名不能被吞掉',
  )
})

await check('脱敏规则反例：--token-file / --tokenize / 裸 --token 不吞后续正常文件名', () => {
  // 命中：等号与空格两种形态
  const equals = redactSensitiveText('--token=canary-a')
  assert.equal(equals.includes('canary-a'), false, '--token=<value> 必须脱敏')
  assert.match(equals, /--token=.*\[REDACTED\]/)
  assert.equal(redactSensitiveText('--token canary-b'), '--token [REDACTED]')
  assert.equal(redactSensitiveText('--api-key canary-c'), '--api-key [REDACTED]')
  assert.equal(
    redactSensitiveText('-H "Authorization: Bearer canary-d"'),
    '-H "Authorization: Bearer [REDACTED]"',
  )
  // 反例：--token 只是更长参数名的前缀 / 没有值 → 一律不动，后面的文件名保留
  for (const text of [
    'cat --token-file reports/unit.json',
    'npm run --tokenize reports/unit.json',
    'grep --tokens reports/unit.json',
    'printf --token',
  ]) {
    assert.equal(redactSensitiveText(text), text, `不应改动：${text}`)
  }
  // 只吃一个值：后面的 URL / 文件名原样保留
  assert.equal(
    redactSensitiveText('curl --token canary-e http://127.0.0.1/report.json'),
    'curl --token [REDACTED] http://127.0.0.1/report.json',
  )
  // 引号值（含空格）整体替换，引号保留
  assert.equal(redactSensitiveText('--password "two words" tail'), '--password "[REDACTED]" tail')
})

await check('真实 spawn 失败（PATH 不可解析 sh）→ fail / HOST_CHECK_SPAWN', async () => {
  const result = await runHostCheck({
    check: { command: 'true' },
    cwd: freshCwd(),
    env: { PATH: '/nonexistent-path-for-host-check' },
  })
  assert.equal(result.state, 'fail')
  assert.equal(result.reasonCode, HOST_CHECK_REASON.SPAWN)
  assertChinese(result.message)
})

await check('cwd 不存在 → skipped / HOST_CHECK_UNAVAILABLE', async () => {
  const result = await runHostCheck({
    check: { command: 'true' },
    cwd: join(root, 'definitely-missing'),
  })
  assert.equal(result.state, 'skipped')
  assert.equal(result.reasonCode, HOST_CHECK_REASON.UNAVAILABLE)
})

await check('非法 check（validate 失败）→ skipped / HOST_CHECK_INVALID，不抛错', async () => {
  const empty = await runHostCheck({ check: { command: '' }, cwd: freshCwd() })
  assert.equal(empty.state, 'skipped')
  assert.equal(empty.reasonCode, HOST_CHECK_REASON.INVALID)
  assertChinese(empty.message)
  assert.match(empty.message, /检查命令/)

  const shape = await runHostCheck({ check: 'npm test', cwd: freshCwd() })
  assert.equal(shape.state, 'skipped')
  assert.equal(shape.reasonCode, HOST_CHECK_REASON.INVALID)
  assert.match(shape.message, /必须是对象/)
})

console.log('\nnode-check.js')

await check('normalizeNodeCheck 默认值：expectExitCode=0 / timeoutMs=600000', () => {
  assert.equal(normalizeNodeCheck(undefined), null)
  assert.equal(normalizeNodeCheck(null), null)
  assert.deepEqual(normalizeNodeCheck({ command: 'npm test' }), {
    command: 'npm test',
    expectExitCode: 0,
    timeoutMs: 600000,
  })
  assert.deepEqual(normalizeNodeCheck({ command: 'npm test', reportPath: 'reports/unit.json' }), {
    command: 'npm test',
    expectExitCode: 0,
    timeoutMs: 600000,
    reportPath: 'reports/unit.json',
  })
})

await check('normalizeNodeCheck 边界：command 2000 / exit 0、255 / timeout 1000、1800000', () => {
  const maxCommand = 'x'.repeat(CHECK_LIMITS.commandLen)
  assert.equal(validateNodeCheck(normalizeNodeCheck({ command: maxCommand })).ok, true)
  assert.equal(validateNodeCheck(normalizeNodeCheck({ command: 'true', expectExitCode: 0 })).ok, true)
  assert.equal(validateNodeCheck(normalizeNodeCheck({ command: 'true', expectExitCode: 255 })).ok, true)
  assert.equal(validateNodeCheck(normalizeNodeCheck({ command: 'true', timeoutMs: 1000 })).ok, true)
  assert.equal(validateNodeCheck(normalizeNodeCheck({ command: 'true', timeoutMs: 1800000 })).ok, true)

  const tooLong = normalizeNodeCheck({ command: 'x'.repeat(CHECK_LIMITS.commandLen + 1) })
  assert.equal(tooLong.command.length, CHECK_LIMITS.commandLen + 1, '超长命令不能被截短后执行')
  assert.equal(validateNodeCheck(tooLong).field, 'command')
  assert.equal(validateNodeCheck({ command: 'true', expectExitCode: 256 }).field, 'expectExitCode')
  assert.equal(validateNodeCheck({ command: 'true', timeoutMs: 999 }).field, 'timeoutMs')
  assert.equal(validateNodeCheck({ command: 'true', timeoutMs: 1800001 }).field, 'timeoutMs')
})

await check('normalizeNodeCheck 诊断值 256 字符上限：错误消息有界、command 不截短', () => {
  const huge = 'x'.repeat(10000)
  // 旧实现（0.13 model.js 的 extras 收敛）把诊断字符串裁到 256；抽取后一度丢失，
  // 一条 10k 假值会把错误消息撑到 10047 字符。这里锁住与旧实现相同的上限。
  for (const field of ['timeoutMs', 'expectExitCode']) {
    const normalized = normalizeNodeCheck({ command: 'true', [field]: huge })
    assert.equal(typeof normalized[field], 'string', `${field} 应按原类型进入诊断`)
    assert.equal(normalized[field].length, 256, `${field} 诊断值应裁到 256 字符`)
    const verdict = validateNodeCheck(normalized)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.field, field)
    assert.ok(verdict.message.length <= 512, `${field} 错误消息应有界，当前 ${verdict.message.length} 字符`)
    assertChinese(verdict.message)
  }
  // 只裁诊断值，不裁实际执行命令：10k 命令照样原样保留，交给 commandLen 校验拒绝。
  const command = normalizeNodeCheck({ command: huge, timeoutMs: huge })
  assert.equal(command.command.length, huge.length, '实际执行的 command 不能被诊断裁剪')
  assert.equal(validateNodeCheck(command).field, 'command')
})

await check('normalizeNodeCheck 非法：绝对路径 / .. / NUL / 非整数 / 非对象都被诊断', () => {
  const cases = [
    { command: 'true', reportPath: '/etc/passwd' },
    { command: 'true', reportPath: 'a/../b' },
    { command: 'true', reportPath: '../outside.json' },
    { command: 'true', reportPath: 'a//b' },
    { command: 'true', reportPath: 'C:\\tmp\\x.json' },
    { command: 'true', reportPath: '\\\\server\\share\\x.json' },
    { command: 'true', reportPath: `a${String.fromCharCode(0)}b` },
    { command: 'true', reportPath: 'x'.repeat(CHECK_LIMITS.reportPathLen + 1) },
    { command: 'true', reportPath: 123 },
    { command: 'echo hi\u0000' },
    { command: 'true', expectExitCode: -1 },
    { command: 'true', expectExitCode: 1.5 },
    { command: 'true', timeoutMs: 1.5 },
  ]
  for (const raw of cases) {
    const verdict = validateNodeCheck(normalizeNodeCheck(raw))
    assert.equal(verdict.ok, false, `应当判非法：${JSON.stringify(raw)}`)
    assert.ok(['command', 'expectExitCode', 'timeoutMs', 'reportPath'].includes(verdict.field), `字段定位不明确：${verdict.field}`)
    assertChinese(verdict.message)
  }
  // 非对象 check：保留可诊断状态，不静默当未配置。
  const shape = normalizeNodeCheck('npm test')
  assert.equal(shape.command, '')
  assert.equal(typeof shape.shapeError, 'string')
  const shapeVerdict = validateNodeCheck(shape)
  assert.equal(shapeVerdict.ok, false)
  assert.equal(shapeVerdict.field, 'check')
})

await check('validateNodeCheck 错误定位：field 精确到 check 子字段', () => {
  assert.deepEqual(validateNodeCheck({ command: 'true' }), { ok: true })
  assert.equal(validateNodeCheck({ command: '' }).field, 'command')
  assert.equal(validateNodeCheck({ command: '   ' }).field, 'command')
  assert.equal(validateNodeCheck({ command: 'true', expectExitCode: 256 }).field, 'expectExitCode')
  assert.equal(validateNodeCheck({ command: 'true', timeoutMs: 999 }).field, 'timeoutMs')
  assert.equal(validateNodeCheck({ command: 'true', reportPath: '/abs' }).field, 'reportPath')
})

rmSync(root, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} 组失败`)
  for (const failure of failures) console.error(`  - ${failure.name}`)
  process.exit(1)
}
console.log(`\n${checks} 组通过`)
