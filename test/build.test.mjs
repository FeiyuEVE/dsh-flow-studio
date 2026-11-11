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
  cpSync,
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

import { build as esbuildBuild } from 'esbuild'

import {
  BUILD_META_FILE,
  GENERATED_MODULES,
  HOST_MODULES,
  EXPECTED_LIB_MODULES,
  FACTORY_CHECK_MARKER,
  collectBuildInputs,
  findLeakMarkers,
  hashInputManifest,
  parseFactoryCheckChildOutput,
  runFactoryCheckInChild,
} from '../scripts/build.mjs'

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
// 反例案例统一放 .tmp/verify-build-cases/：每个案例都是一份可独立构建的工作树，
// 只有这里的副本会被篡改，工作树与 checkout 保持原样。
const casesRoot = join(tmpRoot, 'verify-build-cases')
mkdirSync(casesRoot, { recursive: true })
const casesWork = mkdtempSync(join(casesRoot, 'build-test-'))

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
    A.equal(meta.schemaVersion, 2, '元数据 schemaVersion 为 2（含 modules 模块清单）')
    A.match(meta.inputsHash, /^[0-9a-f]{64}$/, '元数据有合法 inputsHash')
    A.ok(Array.isArray(meta.inputs) && meta.inputs.length > 0, '元数据有非空输入清单')
    A.ok(Array.isArray(meta.outputs) && meta.outputs.length === GENERATED_MODULES.length, '元数据恰好覆盖两个生成产物')
    const inputPaths = meta.inputs.map(entry => entry.path)
    A.ok(inputPaths.some(path => path.endsWith('diagram-js/assets/diagram-js.css')), '输入清单含官方 diagram-js.css')
    A.ok(inputPaths.some(path => path.endsWith('.woff2')), '输入清单含内联的 woff2 字体')
    const diagramCss = meta.inputs.find(entry => entry.path.endsWith('diagram-js/assets/diagram-js.css'))
    A.deepEqual(diagramCss.feeds, ['client.bpmn.js'], 'CSS 输入标明只喂给 client.bpmn.js')
    for (const file of GENERATED_MODULES) {
      const output = meta.outputs.find(entry => entry.file === file)
      A.ok(output, `元数据含产物 ${file}`)
      const data = readFileSync(join(packageDir, 'lib', file))
      A.equal(output.bytes, data.length, `${file} 的 bytes 与产物一致`)
      A.equal(output.sha256, sha256(data), `${file} 的 sha256 与产物一致`)
      A.equal(output.gzipBytes, gzipSync(data, { level: 9 }).length, `${file} 的 gzipBytes 与产物一致`)
      A.ok(Array.isArray(output.inputs), `${file} 的 inputs 是数组`)
      A.ok(Array.isArray(output.modules) && output.modules.length > 0, `${file} 的 modules 是非空模块清单`)
      A.ok(output.modules.every(item => typeof item.path === 'string' && Number.isInteger(item.bytes)), `${file} 的 modules 每项都有 path/bytes`)
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
    const mainModules = meta.outputs.find(entry => entry.file === 'client.js').modules
    const chunkModules = meta.outputs.find(entry => entry.file === 'client.bpmn.js').modules
    A.ok(
      !mainModules.some(item => /node_modules\/(?:bpmn-js|diagram-js|bpmn-js-properties-panel|@bpmn-io)\//.test(item.path)),
      '主包模块清单不含 bpmn-js / diagram-js / 官方属性面板',
    )
    A.ok(
      !chunkModules.some(item => /node_modules\/@xyflow\//.test(item.path)),
      '画布 chunk 模块清单不含 React Flow',
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

  /**
   * 反例案例：从 checkout 复制一份独立工作树，只在副本里构建/篡改。
   * checkout 的 node_modules 是软链；案例默认也软链到工作树依赖，只有需要改
   * diagram-js.css 的案例才复制一份本地 diagram-js（不污染共享 node_modules）。
   */
  const repoModulesDir = resolve(repo, 'node_modules')

  function makeCase(name, options = {}) {
    const dir = join(casesWork, name)
    mkdirSync(dir, { recursive: true })
    for (const rel of ['scripts', 'src', 'lib']) {
      cpSync(join(checkout, rel), join(dir, rel), { recursive: true })
    }
    for (const rel of ['package.json', 'package-lock.json', 'icon.svg', 'cordis.patch.yml', 'THIRD-PARTY.md', 'LICENSE']) {
      if (existsSync(join(checkout, rel))) copyFileSync(join(checkout, rel), join(dir, rel))
    }
    if (options.localDiagramJs) createLocalNodeModules(dir)
    else symlinkSync(repoModulesDir, join(dir, 'node_modules'), 'dir')
    return dir
  }

  /** 案例的 node_modules：除 diagram-js 外全部软链；diagram-js 复制一份，可安全改 CSS。 */
  function createLocalNodeModules(dir) {
    const local = join(dir, 'node_modules')
    mkdirSync(local)
    for (const name of readdirSync(repoModulesDir)) {
      if (name === 'diagram-js') continue
      symlinkSync(join(repoModulesDir, name), join(local, name))
    }
    cpSync(join(repoModulesDir, 'diagram-js'), join(local, 'diagram-js'), { recursive: true })
  }

  function buildCase(dir) {
    mustRun('node', ['scripts/build.mjs'], dir, '案例构建')
  }

  function verifyCase(dir) {
    return run('node', ['scripts/verify-build.mjs'], dir)
  }

  /** 在 styles.js 的模板字符串末尾插入一条真实 CSS（不是注释，会改变产物字节）。 */
  function appendStyleRule(dir, rule) {
    const path = join(dir, 'src/client/styles.js')
    const source = readFileSync(path, 'utf8')
    const index = source.lastIndexOf('`')
    A.ok(index > 0, '案例里找到 styles.js 模板字符串结尾')
    writeFileSync(path, `${source.slice(0, index)}\n${rule}\n${source.slice(index)}`)
  }

  /** 在 createPlugin 开头注入一段代码（构造恶意 / 卡死的 factory）。 */
  function injectPluginCode(dir, code) {
    const path = join(dir, 'src/client/plugin.js')
    const source = readFileSync(path, 'utf8')
    const needle = 'export function createPlugin(require) {'
    A.ok(source.includes(needle), '案例里找到 createPlugin 入口')
    writeFileSync(path, source.replace(needle, `${needle}\n  ${code}`))
  }

  /** 只重算 meta.inputsHash，保留旧 outputs / modules：伪造「输入哈希自洽」。 */
  function forgeInputsHash(dir) {
    const caseMetaPath = join(dir, 'lib', BUILD_META_FILE)
    const meta = JSON.parse(readFileSync(caseMetaPath, 'utf8'))
    const current = collectBuildInputs(dir, meta.inputs.map(entry => entry.path), { strict: false })
    meta.inputsHash = hashInputManifest(current)
    writeFileSync(caseMetaPath, `${JSON.stringify(meta, null, 2)}\n`)
  }

  /** 只更新 outputs 的 bytes / sha256 / gzipBytes，保留旧 modules：伪造「产物哈希自洽」。 */
  function forgeOutputs(dir) {
    const caseMetaPath = join(dir, 'lib', BUILD_META_FILE)
    const meta = JSON.parse(readFileSync(caseMetaPath, 'utf8'))
    for (const output of meta.outputs) {
      const data = readFileSync(join(dir, 'lib', output.file))
      output.bytes = data.length
      output.sha256 = sha256(data)
      output.gzipBytes = gzipSync(data, { level: 9 }).length
    }
    writeFileSync(caseMetaPath, `${JSON.stringify(meta, null, 2)}\n`)
  }

  /** 向主包 factory 体尾部追加一段真实代码（模拟夹带 BPMN bundle）。 */
  function injectCodeIntoMain(dir, code) {
    const caseMainPath = join(dir, 'lib/client.js')
    const source = readFileSync(caseMainPath, 'utf8')
    const footer = 'return module.exports.createPlugin(require);'
    const index = source.lastIndexOf(footer)
    A.ok(index >= 0, '案例里找到主包 footer')
    writeFileSync(caseMainPath, `${source.slice(0, index)}\n${code}\n${source.slice(index)}`)
  }

  /**
   * 直接交给 factory 校验子进程的注册源码：不经过 esbuild，用来逐条演练
   * 「factory 篡改校验器内建函数」——放大到完整构建只会让失败原因变模糊。
   */
  function registrationSource(factoryBody, chunk = false) {
    return `window.__ModuleLoader__.load({ id: '@feiyueve/dsh-flow-studio'`
      + `${chunk ? ", chunk: 'client.bpmn.js'" : ''}, factory: function (require) { ${factoryBody} } });`
  }

  /** 用 esbuild 真实打包官方 BPMN Modeling 特性（约 170KB 真实代码）。 */
  async function bundleBpmnModeling() {
    const result = await esbuildBuild({
      absWorkingDir: repo,
      bundle: true,
      entryPoints: [resolve(repo, 'node_modules/bpmn-js/lib/features/modeling/Modeling.js')],
      format: 'cjs',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      write: false,
      logLevel: 'silent',
    })
    return result.outputFiles[0].contents.toString('utf8')
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

  await check('反例二：主包 factory 返回 null（源码级改动并重建，字节自洽）必须被打回', async () => {
    const dir = makeCase('factory-null')
    injectPluginCode(dir, 'return null')
    buildCase(dir)
    const result = verifyCase(dir)
    A.ok(!result.ok, 'factory 返回 null 时 verify-build 非零退出')
    A.match(`${result.stdout}${result.stderr}`, /factory|插件对象/, '报错指向 factory / 插件对象')
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

  await check('反例七：只改官方 diagram-js.css（元数据不变）必须被独立重建打回', async () => {
    const dir = makeCase('css-change', { localDiagramJs: true })
    buildCase(dir)
    const clean = verifyCase(dir)
    A.ok(clean.ok, '案例初始状态 verify-build 通过（未改 CSS）')

    appendFileSync(
      join(dir, 'node_modules/diagram-js/assets/diagram-js.css'),
      '\n.fs-css-input-probe{outline:1px solid red}\n',
    )
    const result = verifyCase(dir)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, '只改官方 CSS 也让 verify-build 非零退出')
    A.match(output, /diagram-js\.css/, '报错点名被改的 diagram-js.css')
    A.match(output, /独立重建不一致|输入已变化/, 'CSS 变化被独立重建或输入绑定发现')
    A.match(output, /client\.bpmn\.js/, '报错指向受影响产物 client.bpmn.js')
  })

  await check('反例八：改源码、保留旧产物、只重算 inputsHash 必须被独立重建打回', async () => {
    const dir = makeCase('forge-inputs')
    buildCase(dir)
    appendStyleRule(dir, '.fs-forge-inputs-probe{color:red}')
    forgeInputsHash(dir)
    const result = verifyCase(dir)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, '伪造 inputsHash 后 verify-build 仍非零退出')
    A.ok(!output.includes('构建输入已变化'), 'inputsHash 已被伪造成自洽（输入绑定这一条不再报错）')
    A.match(output, /与独立重建不一致/, '独立重建逐字节比较抓到了旧产物')
    A.match(output, /client\.js/, '报错指向受影响产物 client.js')
  })

  await check('反例九：主包夹带真实 BPMN Modeling bundle 并伪造输出哈希必须被打回', async () => {
    const dir = makeCase('bpmn-in-main')
    buildCase(dir)
    const code = await bundleBpmnModeling()
    A.ok(code.length > 100_000, `真实 BPMN Modeling bundle 约 170KB（实际 ${code.length} 字节）`)
    A.equal(findLeakMarkers('client.js', code).length, 0, '真实 BPMN 代码不含旧字符串特征（只靠特征会漏检）')
    injectCodeIntoMain(dir, code)
    forgeOutputs(dir)
    const result = verifyCase(dir)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, '主包夹带真实 BPMN 代码后 verify-build 非零退出')
    A.ok(!output.includes('依赖泄漏'), '内容特征确实没命中（证明不能只靠字符串）')
    A.ok(!output.includes('与构建元数据不一致'), '输出 bytes/sha256 已被伪造成自洽')
    A.match(output, /与独立重建不一致/, '独立重建逐字节比较抓到了夹带代码')
    A.match(output, /client\.js/, '报错指向 client.js')
  })

  await check('反例十：factory 里 require("process").exit(0) 必须被受限沙箱拦下', async () => {
    const dir = makeCase('factory-exit')
    injectPluginCode(dir, "require('process').exit(0)")
    buildCase(dir)
    const result = verifyCase(dir)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, 'factory 试图 require("process").exit(0) 时 verify-build 非零退出')
    A.ok(!output.includes('跳过 factory 执行'), '字节检查通过后 factory 确实被执行')
    A.match(output, /未授权的宿主模块/, '受限 require 拒绝了 process 模块')
    A.match(output, /process/, '报错点名 process')
  })

  await check('反例十一：factory 里直接 process.exit(0) 必须因沙箱无 process 被打回', async () => {
    const dir = makeCase('factory-direct-exit')
    injectPluginCode(dir, 'process.exit(0)')
    buildCase(dir)
    const result = verifyCase(dir)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, 'factory 直接 process.exit(0) 时 verify-build 非零退出')
    A.ok(!output.includes('跳过 factory 执行'), '字节检查通过后 factory 确实被执行')
    A.match(output, /factory 执行失败/, '直接调用 process 被当作 factory 执行失败')
    A.match(output, /process/, '报错点名 process')
  })

  await check('反例十二：factory 死循环必须被 VM 超时中止，不能挂住校验', async () => {
    const dir = makeCase('factory-timeout')
    injectPluginCode(dir, 'while (true) {}')
    buildCase(dir)
    const result = verifyCase(dir)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, 'factory 死循环时 verify-build 非零退出')
    A.ok(!output.includes('跳过 factory 执行'), '字节检查通过后 factory 确实被执行')
    A.match(output, /factory 执行超时/, '报错指出 factory 超时')
    A.match(output, /3000ms/, '报错给出超时阈值')
  })

  await check('反例十三：不能借 host 函数构造器逃逸回 process', async () => {
    const dir = makeCase('factory-escape')
    injectPluginCode(dir, "window.__ModuleLoader__.load.constructor('return process')().exit(0)")
    buildCase(dir)
    const result = verifyCase(dir)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, '借 host 函数构造器逃逸时 verify-build 非零退出')
    A.ok(!output.includes('跳过 factory 执行'), '字节检查通过后 factory 确实被执行')
    A.match(output, /factory 执行失败/, '逃逸尝试被当作 factory 执行失败')
    A.match(output, /process/, '沙箱里 process 不可达')
  })

  await check('反例十五：globalThis.constructor 构造器逃逸后 exit(0)（子进程提前退出）必须失败', async () => {
    const dir = makeCase('factory-global-ctor')
    injectPluginCode(dir, "globalThis.constructor.constructor('return process')().exit(0)")
    buildCase(dir)
    const result = verifyCase(dir)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, 'globalThis.constructor 逃逸路径让 verify-build 非零退出')
    A.ok(!output.includes('跳过 factory 执行'), '字节检查通过后 factory 确实被执行')
    A.match(output, /factory 执行失败/, '逃逸尝试被当作 factory 执行失败')
    A.match(output, /process|动态代码生成|Code generation/, '报错说明 process 不可达 / 代码生成被禁')
  })

  await check('反例十六：window.constructor 构造器逃逸后 exit(0) 必须失败', async () => {
    const dir = makeCase('factory-window-ctor')
    injectPluginCode(dir, "window.constructor.constructor('return process')().exit(0)")
    buildCase(dir)
    const result = verifyCase(dir)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, 'window.constructor 逃逸路径让 verify-build 非零退出')
    A.ok(!output.includes('跳过 factory 执行'), '字节检查通过后 factory 确实被执行')
    A.match(output, /factory 执行失败/, '逃逸尝试被当作 factory 执行失败')
    A.match(output, /process|动态代码生成|Code generation/, '报错说明 process 不可达 / 代码生成被禁')
  })

  await check('反例十七：factory 返回带无限 getter 的对象时属性读取也必须被 VM 超时中止', async () => {
    const dir = makeCase('factory-getter-timeout')
    injectPluginCode(dir, 'return { get name() { while (true) {} } }')
    buildCase(dir)
    const result = verifyCase(dir)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, '无限 getter 让 verify-build 非零退出')
    A.ok(!output.includes('跳过 factory 执行'), '字节检查通过后 factory 确实被执行')
    A.match(output, /factory 执行超时/, '属性读取发生在受限执行范围内，超时被明确报出')
    A.match(output, /3000ms/, '报错给出 factory 超时阈值')
  })

  await check('反例十七b：factory 篡改校验器内建函数后返回 null 仍必须被判失败', async () => {
    // 对照组：同样的 return null，但不篡改任何内建函数 —— 必须报「缺少 exports 对象」。
    const plainNull = runFactoryCheckInChild('client.js', Buffer.from(registrationSource('return null')))
    A.ok(plainNull.ok, '校验子进程给出了完整结果（不是提前退出）')
    A.ok(plainNull.problems.length > 0, '未篡改时 return null 被拒绝')
    A.match(plainNull.problems.join('\n'), /exports|插件对象|null/, '报错指出缺少 exports 对象')

    // 正常路径仍通过：否则下面的反例断言只是「判据恒假」。
    const pluginOk = runFactoryCheckInChild('client.js', Buffer.from(registrationSource(
      "return { name: 'flow-studio', inject: ['slots'], apply: function () {} }",
    )))
    A.ok(pluginOk.ok, '合法插件注册能拿到完整校验结果')
    A.deepEqual(pluginOk.problems, [], '合法插件注册没有问题')
    const chunkOk = runFactoryCheckInChild('client.bpmn.js', Buffer.from(registrationSource(
      "return { mountEditor: function () {}, version: '1.0.0', BPMN_EDITOR_CSS: 'x' }",
      true,
    )))
    A.ok(chunkOk.ok, '合法 chunk 注册能拿到完整校验结果')
    A.deepEqual(chunkOk.problems, [], '合法 chunk 注册没有问题')

    // 各种内建篡改：JSON 序列化通道、数组方法、原型 toJSON、受保护通道本身。
    const tampers = [
      {
        label: '改写 JSON.stringify',
        code: `JSON.stringify = function () { return '{"problems":[]}' }; return null`,
      },
      {
        label: '改写 Object.freeze 后改写 JSON.stringify',
        code: `Object.freeze = function (value) { return value }; JSON.stringify = function () { return '{"problems":[]}' }; return null`,
      },
      {
        label: '改写数组 push 与 Object / Array 原型的 toJSON',
        code: `Array.prototype.push = function () {}; Object.prototype.toJSON = function () { return { problems: [] } }; Array.prototype.toJSON = function () { return [] }; return null`,
      },
      {
        label: '改写 Array.isArray / includes / Function.prototype.call',
        code: `Array.isArray = function () { return true }; Array.prototype.includes = function () { return true }; Function.prototype.call = function () {}; return null`,
      },
      {
        label: '替换受保护的校验通道',
        code: `globalThis.__check_caps__ = { stringify: function () { return '{"problems":[]}' }, isArray: function () { return true }, includes: function () { return true } }; return null`,
      },
      {
        label: '用 defineProperty 重新定义受保护通道',
        code: `Object.defineProperty(globalThis, '__check_caps__', { value: { stringify: function () { return '{"problems":[]}' } }, configurable: true }); return null`,
      },
    ]
    for (const tamper of tampers) {
      const result = runFactoryCheckInChild('client.js', Buffer.from(registrationSource(tamper.code)))
      A.ok(result.ok, `${tamper.label}：校验子进程仍必须给出完整结果`)
      A.ok(result.problems.length > 0, `${tamper.label}：篡改后 return null 不能变成通过`)
      A.match(result.problems.join('\n'), /exports|插件对象|null|校验|factory/,
        `${tamper.label}：失败必须指向 factory 判定，而不是被静默吞掉`)
    }
  })

  await check('反例十七c：factory 篡改 JSON.stringify 后返回 null，完整 verify 必须非零退出', async () => {
    const dir = makeCase('factory-builtin-tamper')
    injectPluginCode(dir, `JSON.stringify = function () { return '{"problems":[]}' }; return null`)
    buildCase(dir)
    const result = verifyCase(dir)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, 'factory 篡改 JSON.stringify 后 verify-build 必须非零退出')
    A.ok(!output.includes('跳过 factory 执行'), '字节检查通过后 factory 确实被执行')
    A.match(output, /factory|插件对象|exports|null/, '报错指向 factory 返回 null，而不是被篡改的判定通道')
  })

  await check('反例十八：输入清单单条 sha256 归零（aggregate hash 不变）必须失败', async () => {
    const dir = makeCase('manifest-zero-hash')
    buildCase(dir)
    const caseMetaPath = join(dir, 'lib', BUILD_META_FILE)
    const meta = JSON.parse(readFileSync(caseMetaPath, 'utf8'))
    const target = meta.inputs.find(entry => entry.path === 'src/client/page.js')
    A.ok(target !== undefined, '清单里有 src/client/page.js 的输入条目')
    target.sha256 = '0'.repeat(64)
    writeFileSync(caseMetaPath, `${JSON.stringify(meta, null, 2)}\n`)
    const result = verifyCase(dir)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, '单条 sha256 归零后 verify-build 非零退出')
    A.ok(!output.includes('构建输入已变化'), 'aggregate hash 未变，旧口径查不出这一条')
    A.match(output, /输入清单条目与磁盘不一致/, '逐条声明被拿磁盘重算结果核对')
    A.match(output, /src\/client\/page\.js/, '报错点名被伪造的输入条目')
  })

  await check('反例十九：从输入清单删掉一条依赖并重算 aggregate hash 必须失败', async () => {
    const dir = makeCase('manifest-drop-input')
    buildCase(dir)
    const caseMetaPath = join(dir, 'lib', BUILD_META_FILE)
    const meta = JSON.parse(readFileSync(caseMetaPath, 'utf8'))
    const removed = meta.inputs.find(entry => entry.path.endsWith('diagram-js/lib/command/CommandStack.js'))
    A.ok(removed !== undefined, '清单里有 diagram-js 的 CommandStack 依赖条目')
    meta.inputs = meta.inputs.filter(entry => entry !== removed)
    // 按剩余条目重算 aggregate hash：模拟「删项后把哈希也做成自洽」。
    meta.inputsHash = hashInputManifest(meta.inputs)
    writeFileSync(caseMetaPath, `${JSON.stringify(meta, null, 2)}\n`)
    const result = verifyCase(dir)
    const output = `${result.stdout}${result.stderr}`
    A.ok(!result.ok, '删掉依赖输入后 verify-build 非零退出')
    A.ok(!output.includes('构建输入已变化'), 'aggregate hash 已按剩余条目重算，旧口径自洽')
    A.match(output, /构建输入集合与独立重建不一致/, '声明集合与重建输入集合被完整比对')
    A.match(output, /CommandStack\.js/, '报错点名被删掉的依赖输入')
  })

  await check('反例二十：子进程退出码 0 但没有完整完成标记必须判失败（判据不恒假）', async () => {
    const validPayload = { marker: FACTORY_CHECK_MARKER, file: 'client.js', done: true, problems: [] }
    const earlyExit = parseFactoryCheckChildOutput('client.js', { status: 0, signal: null, stdout: '', stderr: '' })
    A.ok(!earlyExit.ok, '空输出 + 退出码 0 不算通过（子进程提前退出）')
    A.match(earlyExit.problems.join(' '), /退出码 0 不算通过|不被采信/, '报错说明退出码不被采信')

    const partial = parseFactoryCheckChildOutput('client.js', {
      status: 0,
      signal: null,
      stdout: '{"done":true,"problems":[]}',
      stderr: '',
    })
    A.ok(!partial.ok, '缺完成标记的 JSON 不算通过')

    const wrongFile = parseFactoryCheckChildOutput('client.js', {
      status: 0,
      signal: null,
      stdout: JSON.stringify({ ...validPayload, file: 'client.bpmn.js' }),
      stderr: '',
    })
    A.ok(!wrongFile.ok, '标记属于另一个产物时不算通过')

    const multiLine = parseFactoryCheckChildOutput('client.js', {
      status: 0,
      signal: null,
      stdout: `${JSON.stringify(validPayload)}\n{"trace":1}\n`,
      stderr: '',
    })
    A.ok(!multiLine.ok, '多于一行输出不算通过（拒绝以部分输出放行）')

    const timedOut = parseFactoryCheckChildOutput('client.js', {
      status: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
      error: { code: 'ETIMEDOUT' },
    })
    A.ok(!timedOut.ok, '外部硬超时必须判失败')

    const good = parseFactoryCheckChildOutput('client.js', {
      status: 0,
      signal: null,
      stdout: `${JSON.stringify(validPayload)}\n`,
      stderr: '',
    })
    A.ok(good.ok, '带完整完成标记的结构化结果才通过（确认判据不是恒假）')
  })

  await check('反例二十一：没有 prepack（--ignore-scripts）就一个 js 都没有，正例断言会拦住', async () => {
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
  rmSync(casesWork, { recursive: true, force: true })
}
