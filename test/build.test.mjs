#!/usr/bin/env node
/**
 * 发布链门禁自检（可重跑）：证明「干净检出 + npm pack」拿到的是当前 src 的构建产物。
 *
 * 背景（实测过的两个坑）：
 *   1. lib/ 被 .gitignore 排除，package.json 又没有 prepack —— 干净检出发包得到
 *      「一个 js 都没有」的包；
 *   2. 工作树直接 npm publish / npm pack 拿到的是旧 lib（源码改了、lib 没重建）。
 *
 * 做法：在 .tmp/ 下用 `git archive HEAD` 造一份干净检出（不碰工作树里其它 agent 的
 * 未提交改动），只把当前工作树的 scripts/build.mjs、scripts/verify-build.mjs、
 * package.json 覆盖进去，其余保持 HEAD。然后在干净检出里真实跑 `npm pack`，解开
 * tarball 逐项断言 —— 不是检查 package.json 里有没有 "prepack" 字符串。
 *
 * 反例也当场验：没有 prepack（--ignore-scripts）时 tarball 里 lib/*.js 为 0，
 * 说明上面「数量 == 清单」「逐字节相同」这两条断言确实会拦住漏代码的包。
 *
 * 临时目录一律在 <repo>/.tmp/，用 mkdtempSync 建、finally 里清理；全程不在工作树
 * 里构建或打包（工作树的 lib/ 归其它 agent 正在改的 src 所有）。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HOST_MODULES, GENERATED_MODULES, EXPECTED_LIB_MODULES } from '../scripts/build.mjs'

let checks = 0
/** 统计断言数（用户要求回报断言数）。 */
let assertionCount = 0
const A = {
  equal(actual, expected, message) {
    assertionCount += 1
    assert.equal(actual, expected, message)
  },
  notEqual(actual, expected, message) {
    assertionCount += 1
    assert.notEqual(actual, expected, message)
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

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

/** 跑一条命令，非零退出也不抛，把 stdout / stderr 带回来给断言看。 */
function run(command, args, cwd) {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? -1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }
  }
}

/** 必须成功的命令；失败时把两路输出都抛出来，便于定位。 */
function mustRun(command, args, cwd, label) {
  const result = run(command, args, cwd)
  if (!result.ok) {
    throw new Error(`${label} 失败（exit ${result.status}）\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result
}

/**
 * 在 cwd 里真实打包（会触发 prepack），返回 tarball 路径。
 * 不用 `--json`：npm 会把构建脚本的 stdout 混进 --json 输出里；filename 直接取
 * stdout 最后一行，断言全部落在解出来的 tarball 内容上。
 */
function pack(cwd, packDir, extraArgs = []) {
  const result = mustRun(
    'npm',
    ['pack', '--pack-destination', packDir, ...extraArgs],
    cwd,
    `npm pack ${extraArgs.join(' ')}`.trim(),
  )
  const matches = [...result.stdout.matchAll(/([\w.-]+\.tgz)/g)]
  const filename = matches.length > 0 ? matches[matches.length - 1][1] : ''
  if (filename === '') {
    throw new Error(`npm pack 没报出 tarball 文件名：\n${result.stdout}\n${result.stderr}`)
  }
  const tgz = join(packDir, filename)
  if (!existsSync(tgz)) {
    throw new Error(`npm pack 报出 ${filename}，但文件不在 ${packDir}`)
  }
  return { filename, tgz }
}

/** 解开 tarball，返回解出来的 package/ 目录。 */
function extract(tgz, dest) {
  mkdirSync(dest, { recursive: true })
  mustRun('tar', ['-xzf', tgz, '-C', dest], repo, 'tar 解包')
  return join(dest, 'package')
}

/** 递归列出目录下所有文件的相对路径（正斜杠），即 tarball 里的真实文件清单。 */
function listFiles(dir, base = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

const tmpRoot = resolve(repo, '.tmp')
mkdirSync(tmpRoot, { recursive: true })
const work = mkdtempSync(join(tmpRoot, 'build-test-'))

try {
  const checkout = join(work, 'checkout')

  await check('git archive HEAD 造出干净检出（不含被 .gitignore 排除的 lib/）', async () => {
    const headTar = join(work, 'head.tar')
    mustRun('git', ['archive', '--format=tar', '-o', headTar, 'HEAD'], repo, 'git archive HEAD')
    mkdirSync(checkout, { recursive: true })
    mustRun('tar', ['-xf', headTar, '-C', checkout], repo, '解包 HEAD')
    A.ok(existsSync(join(checkout, 'package.json')), '干净检出含 package.json')
    A.ok(existsSync(join(checkout, 'src/supervise.js')), '干净检出含 src/supervise.js')
    A.ok(!existsSync(join(checkout, 'lib')), '干净检出里没有 lib/（被 .gitignore 排除，只能靠构建生成）')
    A.ok(!existsSync(join(checkout, 'node_modules')), '干净检出里没有 node_modules（不依赖工作树依赖目录）')
    // 干净检出必须是 HEAD 内容：工作树里 src/supervise.js 正被别的 agent 改，不能混进来。
    const headSupervise = mustRun('git', ['show', 'HEAD:src/supervise.js'], repo, 'git show HEAD:src/supervise.js').stdout
    A.equal(
      readFileSync(join(checkout, 'src/supervise.js'), 'utf8'),
      headSupervise,
      '干净检出的 src/ 是 HEAD 内容，不混入工作树未提交改动',
    )
  })

  await check('把当前工作树的 build 脚本 / package.json 与 src 模块覆盖进干净检出', async () => {
    for (const rel of ['scripts/build.mjs', 'scripts/verify-build.mjs', 'package.json']) {
      copyFileSync(join(repo, rel), join(checkout, rel))
      A.ok(existsSync(join(checkout, rel)), `已复制 ${rel}`)
    }
    // 0.11：开发阶段的模块改动 / 新增模块还没进 HEAD（本阶段不 commit），
    // 干净检出必须补上「当前交付的 src」才能证明 npm pack 打包的是眼前这份代码。
    // supervise.js 这类本阶段未改的文件仍是 HEAD 内容（上一组的断言继续成立）。
    for (const file of HOST_MODULES) {
      const source = join(repo, 'src', file)
      if (!existsSync(source)) continue
      copyFileSync(source, join(checkout, 'src', file))
    }
    // esbuild 从工作树的 node_modules 解析（符号链接过去，避免干净检出里再装一遍）。
    const repoModules = join(repo, 'node_modules')
    A.ok(existsSync(repoModules), '工作树有 node_modules（esbuild 可用）')
    symlinkSync(repoModules, join(checkout, 'node_modules'), 'dir')
  })

  const pkg = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'))
  const mainEntry = pkg.main
  const packDir = join(work, 'pack')
  mkdirSync(packDir, { recursive: true })
  const packed = pack(checkout, packDir)
  const packageDir = extract(packed.tgz, join(work, 'extracted'))
  const files = listFiles(packageDir)
  const libJs = files.filter(path => /^lib\/[^/]+\.js$/.test(path))
  console.log(`    · ${packed.filename}（解出 ${files.length} 个文件，其中 lib/*.js ${libJs.length} 个）`)

  await check('tarball 里 lib/*.js 数量 == build 清单模块数', async () => {
    A.equal(libJs.length, EXPECTED_LIB_MODULES.length, `lib/*.js 数量 ${libJs.length} 应等于清单 ${EXPECTED_LIB_MODULES.length}`)
    for (const file of HOST_MODULES) {
      A.ok(libJs.includes(`lib/${file}`), `tarball 含清单模块 lib/${file}`)
    }
    A.ok(libJs.includes(`lib/${GENERATED_MODULES[0]}`), `tarball 含生成产物 lib/${GENERATED_MODULES[0]}`)
  })

  await check('tarball 里 main 入口存在，且源码 src/ 不进包（lib 只能是构建产物）', async () => {
    A.equal(typeof mainEntry, 'string', 'package.json 有 main 字段')
    A.ok(files.includes(mainEntry), `tarball 含 main 入口 ${mainEntry}`)
    A.ok(!files.some(path => path.startsWith('src/')), 'tarball 不含 src/（files 白名单不含源码）')
  })

  await check('tarball 里 lib/supervise.js 与干净检出 src/supervise.js 逐字节相同', async () => {
    A.ok(files.includes('lib/supervise.js'), '解出的包里含 lib/supervise.js')
    for (const file of HOST_MODULES) {
      const packedFile = readFileSync(join(packageDir, 'lib', file))
      const sourceFile = readFileSync(join(checkout, 'src', file))
      A.ok(packedFile.equals(sourceFile), `tarball lib/${file} 与 HEAD src/${file} 逐字节相同`)
    }
    const packedSupervise = readFileSync(join(packageDir, 'lib', 'supervise.js'))
    const sourceSupervise = readFileSync(join(checkout, 'src', 'supervise.js'))
    console.log(
      `    · lib/supervise.js ${packedSupervise.length} 字节 sha256=${sha256(packedSupervise)}`
      + ` · src/supervise.js ${sourceSupervise.length} 字节 sha256=${sha256(sourceSupervise)}`,
    )
  })

  await check('干净检出里 build 之后 verify-build 通过（src ↔ lib 一致 + main 入口存在）', async () => {
    const result = mustRun('node', ['scripts/verify-build.mjs'], checkout, 'verify-build.mjs')
    A.match(result.stdout, /逐字节一致/, 'verify-build 报告逐字节一致')
    A.match(result.stdout, /main 入口存在/, 'verify-build 报告 main 入口存在')
  })

  await check('反例一：lib 陈旧时 verify-build 非零退出并点名文件', async () => {
    appendFileSync(join(checkout, 'lib', 'supervise.js'), '\n// stale-lib-simulated\n')
    const stale = run('node', ['scripts/verify-build.mjs'], checkout)
    A.ok(!stale.ok, '陈旧 lib 让 verify-build 非零退出')
    A.match(`${stale.stdout}${stale.stderr}`, /lib\/supervise\.js/, '报错里点名陈旧文件 lib/supervise.js')
  })

  await check('反例二：没有 prepack（--ignore-scripts）就一个 js 都没有，正例断言会拦住', async () => {
    rmSync(join(checkout, 'lib'), { recursive: true, force: true })
    const packDir2 = join(work, 'pack-no-scripts')
    mkdirSync(packDir2, { recursive: true })
    const packed2 = pack(checkout, packDir2, ['--ignore-scripts'])
    const packageDir2 = extract(packed2.tgz, join(work, 'extracted-no-scripts'))
    const files2 = listFiles(packageDir2)
    const libJs2 = files2.filter(path => /^lib\/[^/]+\.js$/.test(path))
    A.ok(files2.includes('package.json'), '免脚本打包仍有 package.json（包本身在，只是没代码）')
    A.equal(libJs2.length, 0, '没有 prepack 的包 lib/*.js 数量为 0')
    A.notEqual(libJs2.length, EXPECTED_LIB_MODULES.length, '正例断言「数量 == 清单」确实会拦住这种包')
  })

  console.log(`\nbuild/pack 门禁自检：${checks} 组通过（${assertionCount} 条断言）`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
