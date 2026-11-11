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
 * 未提交改动），然后把当前工作树的 scripts/build.mjs、scripts/verify-build.mjs、
 * package.json/锁文件、随包资源与**完整 src/** 同步进去（含删除同步：临时检出里
 * 不保留当前 src 已删除的文件），其余保持 HEAD。然后在干净检出里真实跑 `npm pack`，
 * 解开 tarball 逐项断言 —— 不是检查 package.json 里有没有 "prepack" 字符串。
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
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { BUILD_META_FILE, GENERATED_MODULES, HOST_MODULES, EXPECTED_LIB_MODULES } from '../scripts/build.mjs'

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
  deepEqual(actual, expected, message) {
    assertionCount += 1
    assert.deepEqual(actual, expected, message)
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

/**
 * 用当前工作树的目录整体替换临时检出里的同名目录：先复制全部文件，再删除
 * 目标里「当前源码已没有」的文件与空目录。
 *
 * 为什么不能只覆盖新增文件：`git archive HEAD` 的 src/ 是上次提交的旧状态，
 * 如果本阶段删过模块，只做「复制新增」会让临时检出保留已被删除的旧模块，
 * npm pack 与字节比对测到的就不是眼前这份源码。
 *
 * @param {string} from 当前工作树目录
 * @param {string} to   临时检出里的目标目录
 * @param {string} [base] 相对路径前缀（递归用）
 */
function syncTree(from, to, base = '') {
  mkdirSync(to, { recursive: true })
  const sourceEntries = readdirSync(from, { withFileTypes: true })
  const sourceNames = new Set(sourceEntries.map(entry => entry.name))
  for (const entry of sourceEntries) {
    const srcPath = join(from, entry.name)
    const destPath = join(to, entry.name)
    const rel = base === '' ? entry.name : `${base}/${entry.name}`
    if (entry.isDirectory()) {
      syncTree(srcPath, destPath, rel)
      continue
    }
    copyFileSync(srcPath, destPath)
  }
  for (const entry of readdirSync(to, { withFileTypes: true })) {
    if (sourceNames.has(entry.name)) continue
    const stalePath = join(to, entry.name)
    const rel = base === '' ? entry.name : `${base}/${entry.name}`
    rmSync(stalePath, { recursive: true, force: true })
    console.log(`    · 移除临时检出里源码已删除的 ${rel}`)
  }
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
    // 同步之前，干净检出必须是 HEAD 内容：当前工作树的未提交改动不能提前混进来。
    const headSupervise = mustRun('git', ['show', 'HEAD:src/supervise.js'], repo, 'git show HEAD:src/supervise.js').stdout
    A.equal(
      readFileSync(join(checkout, 'src/supervise.js'), 'utf8'),
      headSupervise,
      '干净检出的 src/ 是 HEAD 内容，不混入工作树未提交改动',
    )
  })

  await check('把当前工作树的 build 脚本 / 清单 / 资源与完整 src 同步进干净检出（含删除同步）', async () => {
    // 构建脚本、包清单、锁文件与随包资源：这些决定「怎么构建、包里放什么」，
    // 必须和当前交付一致，不能用 HEAD 里的旧版本。
    for (const rel of [
      'scripts/build.mjs',
      'scripts/build-bpmn-assets.mjs',
      'scripts/verify-build.mjs',
      'package.json',
      'package-lock.json',
      'icon.svg',
      'cordis.patch.yml',
      'THIRD-PARTY.md',
      'LICENSE',
    ]) {
      const source = join(repo, rel)
      if (!existsSync(source)) continue
      mkdirSync(dirname(join(checkout, rel)), { recursive: true })
      copyFileSync(source, join(checkout, rel))
      A.ok(existsSync(join(checkout, rel)), `已复制 ${rel}`)
    }
    // 资源目录（locale）同样整体同步。
    if (existsSync(join(repo, 'locale'))) syncTree(join(repo, 'locale'), join(checkout, 'locale'))

    // 0.11：开发阶段的模块改动 / 新增模块还没进 HEAD（本阶段不 commit），
    // 干净检出必须补上「当前交付的 src」才能证明 npm pack 打包的是眼前这份代码。
    // 0.13.3：改成整体替换 + 删除同步——只覆盖新增文件会让临时检出遗留 HEAD 里
    // 已删除的旧模块，测到的不是当前源码。
    // 先造一个当前 src 里不存在的探针，证明同步真的会删除而不是只覆盖新增文件。
    const staleProbe = join(checkout, 'src', '__stale_probe__.js')
    writeFileSync(staleProbe, '// stale module simulated by build.test.mjs\n')
    A.ok(existsSync(staleProbe), '已放入陈旧模块探针')
    syncTree(join(repo, 'src'), join(checkout, 'src'))
    A.ok(!existsSync(staleProbe), '删除同步移除了当前 src 已不存在的模块')

    // 逐文件核对：临时检出的 src/ 必须与当前工作树完全一致（无缺失、无多余）。
    const repoFiles = listFiles(join(repo, 'src'))
    const checkoutFiles = listFiles(join(checkout, 'src'))
    A.deepEqual(checkoutFiles, repoFiles, '临时检出 src/ 文件清单与当前工作树一致（含删除）')
    for (const rel of repoFiles) {
      const actual = readFileSync(join(checkout, 'src', rel))
      const expected = readFileSync(join(repo, 'src', rel))
      A.ok(actual.equals(expected), `临时检出 src/${rel} 与当前工作树逐字节相同`)
    }

    // esbuild 从工作树的 node_modules 解析（符号链接过去，避免干净检出里再装一遍）。
    const repoModules = join(repo, 'node_modules')
    A.ok(existsSync(repoModules), '工作树有 node_modules（esbuild 可用）')
    if (!existsSync(join(checkout, 'node_modules'))) {
      symlinkSync(repoModules, join(checkout, 'node_modules'), 'dir')
    }
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
    for (const file of GENERATED_MODULES) {
      A.ok(libJs.includes(`lib/${file}`), `tarball 含生成产物 lib/${file}`)
    }
  })

  await check('tarball 里两个产物的元数据存在，且依赖归属无泄漏', async () => {
    A.ok(files.includes(`lib/${BUILD_META_FILE}`), `tarball 含 lib/${BUILD_META_FILE}`)
    A.ok(!files.includes('lib/.build-meta.json'), 'tarball 不含旧版 lib/.build-meta.json')
    const meta = JSON.parse(readFileSync(join(packageDir, 'lib', BUILD_META_FILE), 'utf8'))
    A.equal(meta.schemaVersion, 1, '元数据 schemaVersion 为 1')
    A.match(meta.inputsHash, /^[0-9a-f]{64}$/, '元数据有合法 inputsHash')
    A.ok(Array.isArray(meta.inputs) && meta.inputs.length > 0, '元数据有非空输入清单')
    A.ok(Array.isArray(meta.outputs) && meta.outputs.length === GENERATED_MODULES.length, '元数据恰好覆盖两个生成产物')
    for (const file of GENERATED_MODULES) {
      const output = meta.outputs.find(entry => entry.file === file)
      A.ok(output, `元数据含产物 ${file}`)
      const data = readFileSync(join(packageDir, 'lib', file))
      A.equal(output.bytes, data.length, `${file} 的 bytes 与产物一致`)
      A.equal(output.sha256, sha256(data), `${file} 的 sha256 与产物一致`)
      A.equal(output.gzipBytes, gzipSync(data, { level: 9 }).length, `${file} 的 gzipBytes 与产物一致`)
      A.ok(Array.isArray(output.inputs), `${file} 的 inputs 是数组`)
    }
    const mainInputs = meta.outputs.find(entry => entry.file === 'client.js').inputs
    const chunkInputs = meta.outputs.find(entry => entry.file === 'client.bpmn.js').inputs
    A.ok(
      !mainInputs.some(input => /node_modules\/(?:bpmn-js|diagram-js|bpmn-js-properties-panel|@bpmn-io)\//.test(input)),
      '主包依赖图不含 bpmn-js / diagram-js / 官方属性面板',
    )
    A.ok(
      !chunkInputs.some(input => /node_modules\/@xyflow\//.test(input)),
      '画布 chunk 依赖图不含 React Flow',
    )
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
      A.ok(packedFile.equals(sourceFile), `tarball lib/${file} 与当前 src/${file} 逐字节相同`)
    }
    const packedSupervise = readFileSync(join(packageDir, 'lib', 'supervise.js'))
    const sourceSupervise = readFileSync(join(checkout, 'src', 'supervise.js'))
    console.log(
      `    · lib/supervise.js ${packedSupervise.length} 字节 sha256=${sha256(packedSupervise)}`
      + ` · src/supervise.js ${sourceSupervise.length} 字节 sha256=${sha256(sourceSupervise)}`,
    )
  })

  const libDir = join(checkout, 'lib')
  const metaPath = join(libDir, BUILD_META_FILE)
  const mainPath = join(libDir, 'client.js')
  const chunkPath = join(libDir, 'client.bpmn.js')

  await check('干净检出里 build 之后 verify-build 通过（输入绑定 + 产物哈希 + factory 可执行）', async () => {
    const result = mustRun('node', ['scripts/verify-build.mjs'], checkout, 'verify-build.mjs')
    A.match(result.stdout, /逐字节一致/, 'verify-build 报告逐字节一致')
    A.match(result.stdout, /main 入口存在/, 'verify-build 报告 main 入口存在')
    A.match(result.stdout, /输入绑定一致/, 'verify-build 报告输入绑定一致')
    A.match(result.stdout, /factory 可执行/, 'verify-build 报告 factory 可执行')
    A.match(result.stdout, /依赖归属/, 'verify-build 报告依赖归属')
  })

  // 反例都在这份干净产物上做，做完必须恢复，避免互相污染。
  const pristine = {
    main: readFileSync(mainPath),
    chunk: readFileSync(chunkPath),
    meta: readFileSync(metaPath),
  }

  /** 恢复两个生成产物与构建元数据。 */
  function restoreBundles() {
    writeFileSync(mainPath, pristine.main)
    writeFileSync(chunkPath, pristine.chunk)
    writeFileSync(metaPath, pristine.meta)
  }

  /** 按当前磁盘字节重算 outputs 的 bytes / sha256 / gzipBytes：模拟「篡改产物后再伪造元数据」。 */
  function forgeMeta() {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    for (const output of meta.outputs) {
      const data = readFileSync(join(libDir, output.file))
      output.bytes = data.length
      output.sha256 = sha256(data)
      output.gzipBytes = gzipSync(data, { level: 9 }).length
    }
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
  }

  /**
   * 把真实 chunk 的 bundle 主体换进主包：保留主包的注册形状（id/factory），
   * 但 factory 里跑的是 1.98MB 的真实 BPMN 代码 —— 模拟依赖泄漏。
   * 不拼接 chunk 的注册头（否则旧的「主包不能带 chunk 字段」字符串检查会先拦住，
   * 测不到泄漏判据本身）。
   * @returns {number} 注入后的主包字节数
   */
  function injectChunkIntoMain() {
    const mainSource = pristine.main.toString('utf8')
    const chunkSource = pristine.chunk.toString('utf8')
    const startMarker = 'var module = { exports: {} }; var exports = module.exports;'
    const mainStart = mainSource.indexOf(startMarker) + startMarker.length
    const chunkStart = chunkSource.indexOf(startMarker) + startMarker.length
    const mainEnd = mainSource.lastIndexOf('return module.exports.createPlugin(require);')
    const chunkEnd = chunkSource.lastIndexOf('return module.exports;')
    A.ok(mainStart > startMarker.length && chunkStart > startMarker.length, '找到两个 bundle 的主体起点')
    A.ok(mainEnd >= 0 && chunkEnd >= 0, '找到两个 bundle 的 footer 边界')
    const mixed = mainSource.slice(0, mainStart) + chunkSource.slice(chunkStart, chunkEnd) + mainSource.slice(mainEnd)
    A.ok(!mixed.includes("chunk: 'client.bpmn.js'"), '注入后主包里没有 chunk 注册字面量（旧字符串检查不会误拦截）')
    writeFileSync(mainPath, mixed)
    return Buffer.byteLength(mixed)
  }

  await check('反例一：lib/supervise.js 陈旧时 verify-build 非零退出并点名文件', async () => {
    const supervisePath = join(libDir, 'supervise.js')
    const original = readFileSync(supervisePath)
    appendFileSync(supervisePath, '\n// stale-lib-simulated\n')
    const stale = run('node', ['scripts/verify-build.mjs'], checkout)
    A.ok(!stale.ok, '陈旧 lib 让 verify-build 非零退出')
    A.match(`${stale.stdout}${stale.stderr}`, /lib\/supervise\.js/, '报错里点名陈旧文件 lib/supervise.js')
    writeFileSync(supervisePath, original)
  })

  await check('反例二：主包 factory 改成 return null（并伪造 meta 使字节自洽）必须被打回', async () => {
    const original = pristine.main.toString('utf8')
    const tampered = original.replace('return module.exports.createPlugin(require);', 'return null;')
    A.notEqual(tampered, original, '主包 factory 已被改成返回 null')
    writeFileSync(mainPath, tampered)
    forgeMeta()
    const result = run('node', ['scripts/verify-build.mjs'], checkout)
    A.ok(!result.ok, 'factory 不可用时 verify-build 非零退出')
    A.match(`${result.stdout}${result.stderr}`, /factory|插件对象/, '报错指向 factory / 插件对象')
    restoreBundles()
  })

  await check('反例三：主包混入真实 BPMN chunk 代码并删除 meta，必须同时因泄漏与缺元数据失败', async () => {
    const injectedBytes = injectChunkIntoMain()
    A.ok(injectedBytes > pristine.main.length, `主包确实混入了 chunk 字节（${injectedBytes} 字节）`)
    rmSync(metaPath, { force: true })
    const result = run('node', ['scripts/verify-build.mjs'], checkout)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, '混入 chunk 且缺 meta 时 verify-build 非零退出')
    A.match(output, /依赖泄漏/, '报错指出依赖泄漏')
    A.match(output, /build-meta\.json 缺失/, '报错指出构建元数据缺失')
    restoreBundles()
  })

  await check('反例四：混入 chunk 并伪造 meta（输出哈希自洽）仍必须因依赖泄漏被打回', async () => {
    const injectedBytes = injectChunkIntoMain()
    A.ok(injectedBytes > 1_500_000, `注入后的主包约 2MB（真实 BPMN bundle 量级，实际 ${injectedBytes} 字节）`)
    forgeMeta()
    const result = run('node', ['scripts/verify-build.mjs'], checkout)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, '伪造 meta 也不能让混入 chunk 的主包通过')
    A.match(output, /依赖泄漏/, '依赖泄漏判定不依赖可删除的 metadata 字段')
    restoreBundles()
  })

  await check('反例五：两个生成产物各自被改动都必须被点名（不能只覆盖 supervise.js）', async () => {
    for (const file of GENERATED_MODULES) {
      const path = join(libDir, file)
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]))
      const result = run('node', ['scripts/verify-build.mjs'], checkout)
      const output = `${result.stdout}${result.stderr}`
      A.ok(!result.ok, `${file} 被改动后 verify-build 非零退出`)
      A.match(output, new RegExp(`lib/${file.replace(/\./g, '\\.')}`), `报错点名 lib/${file}`)
      A.match(output, /sha256|大小/, `${file} 的字节哈希/大小不一致被报出`)
      writeFileSync(path, file === 'client.js' ? pristine.main : pristine.chunk)
    }
    const recovered = run('node', ['scripts/verify-build.mjs'], checkout)
    A.ok(recovered.ok, '恢复两个产物后 verify-build 再次通过')
  })

  await check('反例六：源码输入变化（修改 / 新增）而产物未重建必须被打回', async () => {
    const stylePath = join(checkout, 'src/client/styles.js')
    const originalStyle = readFileSync(stylePath)
    appendFileSync(stylePath, '\n/* stale-input-probe */\n')
    const changed = run('node', ['scripts/verify-build.mjs'], checkout)
    const changedOutput = `${changed.stdout}${changed.stderr}`
    A.ok(!changed.ok, '修改 src 后 verify-build 非零退出')
    A.match(changedOutput, /输入已变化/, '报错指出输入已变化')
    A.match(changedOutput, /src\/client\/styles\.js/, '报错点名被修改的源文件')
    writeFileSync(stylePath, originalStyle)

    const probePath = join(checkout, 'src/__stale_probe__.js')
    writeFileSync(probePath, '// stale input probe\n')
    const added = run('node', ['scripts/verify-build.mjs'], checkout)
    A.ok(!added.ok, '新增 src 文件后 verify-build 非零退出')
    A.match(`${added.stdout}${added.stderr}`, /新增 1 个/, '报错指出新增了输入文件')
    rmSync(probePath, { force: true })

    const recovered = run('node', ['scripts/verify-build.mjs'], checkout)
    A.ok(recovered.ok, '恢复输入后 verify-build 再次通过')
  })

  await check('反例七：没有 prepack（--ignore-scripts）就一个 js 都没有，正例断言会拦住', async () => {
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
