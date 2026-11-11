#!/usr/bin/env node
/**
 * 把 bpmn-moddle / feelin / zeebe-bpmn-moddle 编译成单文件 ESM 并 vendor 进仓库。
 *
 * 为什么 vendor 而不是装依赖：这个插件保持「运行时依赖只有 bpmn-engine 栈，其余第三方
 * 代码一律 vendor」的形态，多一个 npm 依赖就多一条供应链与版本漂移面。vendored 产物带
 * 完整溯源（版本 / npm pack shasum / integrity / 依赖闭包 / 重新生成方式），升级只要改
 * 本脚本顶部的 VENDORED 常量再跑一次。
 *
 * 一个脚本产出三个文件：
 *   src/bpmn-moddle-vendor.js   —— BPMN 2.0 元模型与 XML 读写（bpmn-moddle + moddle 栈）
 *   src/feelin-vendor.js        —— FEEL 表达式求值（feelin + lezer + temporal-polyfill）
 *   src/zeebe-moddle-vendor.js  —— Camunda/Zeebe 扩展描述符（纯 JSON，导出 zeebeModdle）
 *
 * 用法：
 *   node scripts/vendor-bpmn.mjs                   # 用 VENDORED 里的版本
 *   node scripts/vendor-bpmn.mjs --check           # 只校验已提交产物是否与脚本一致（CI 用）
 *
 * 幂等：同样的包版本 + 同样的依赖闭包 + 同样的 esbuild 版本 → 输出字节一致；
 * 内容相同则打印「已是最新」不重写。临时文件全部落在 <repo>/.tmp/vendor/（不提交）。
 *
 * 依赖闭包锁精确版本：顶层包自己的 package.json 里是 caret range（如 `^8.2.1`），
 * 直接 `npm install` 会随上游发版漂移，--check 就不可能在别的机器上复现。所以这里
 * 把闭包里每个包都写成 name@精确版本，并校验装出来的集合与常量完全一致。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(REPO, '.tmp', 'vendor')
const STAGE = join(WORK, 'stage')
const NODE_MODULES = join(STAGE, 'node_modules')

/**
 * 被 vendor 的顶层包 —— 每个对应一个提交进仓库的产物。
 * `entry` 是这个包的 ESM 入口代码（有的包没有 default 导出，有的只有 JSON 资源）。
 * `expect` 是冒烟断言：产物必须导出的符号（default 用 'default' 表示）。
 */
const VENDORED = [
  {
    name: 'bpmn-moddle',
    version: '10.3.1',
    out: 'bpmn-moddle-vendor.js',
    homepage: 'https://github.com/bpmn-io/bpmn-moddle',
    entry: "export * from 'bpmn-moddle'\n",
    expect: ['BpmnModdle'],
  },
  {
    name: 'feelin',
    version: '8.2.0',
    out: 'feelin-vendor.js',
    homepage: 'https://github.com/camunda/feelin',
    entry: "export * from 'feelin'\n",
    expect: ['evaluate'],
  },
  {
    name: 'zeebe-bpmn-moddle',
    version: '2.0.0',
    out: 'zeebe-moddle-vendor.js',
    homepage: 'https://github.com/camunda/zeebe-bpmn-moddle',
    // 这个包没有 JS 入口，发布物只有 resources/zeebe.json；把它内联成 ESM 常量。
    entry: [
      "import zeebeModdle from 'zeebe-bpmn-moddle/resources/zeebe.json'",
      'export { zeebeModdle }',
      'export default zeebeModdle',
      '',
    ].join('\n'),
    expect: ['zeebeModdle', 'default'],
  },
]

/**
 * 完整依赖闭包（顶层包 + 它们的传递依赖），全部锁精确版本。
 * 顺序无关；构建前会校验 node_modules 里的安装集合与这份清单完全一致 —— 上游改依赖
 * 而这里没跟上时会直接失败，而不是静默把某个版本打进产物。
 */
const CLOSURE = [
  { name: 'bpmn-moddle', version: '10.3.1' },
  { name: 'feelin', version: '8.2.0' },
  { name: 'zeebe-bpmn-moddle', version: '2.0.0' },
  // bpmn-moddle 的依赖
  { name: 'min-dash', version: '5.1.0' },
  { name: 'moddle', version: '8.2.1' },
  { name: 'moddle-xml', version: '12.3.2' },
  { name: 'saxen', version: '11.2.0' },
  // feelin 的依赖
  { name: '@lezer/common', version: '1.5.5' },
  { name: '@lezer/highlight', version: '1.2.5' },
  { name: '@lezer/lr', version: '1.4.12' },
  { name: 'lezer-feel', version: '3.0.1' },
  { name: 'temporal-polyfill', version: '1.0.8' },
  { name: 'temporal-spec', version: '1.0.1' },
  { name: 'temporal-utils', version: '1.0.4' },
]

const checkOnly = process.argv.includes('--check')

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * `npm pack` 一个精确版本到 .tmp/vendor/，返回 tarball 路径与 npm 口径的
 * shasum（sha1）/ integrity（sha512 base64）—— 两者都直接从 tarball 字节算出，
 * 不依赖 `npm view` 的返回形状。
 */
function fetchTarball(name, version) {
  const tag = `${name}@${version}`
  const filename = run('npm', ['pack', tag, '--pack-destination', WORK, '--silent']).trim().split('\n').pop()
  const tgz = join(WORK, filename)
  if (!existsSync(tgz)) throw new Error(`npm pack ${tag} 没产出 ${filename}`)
  const bytes = readFileSync(tgz)
  return {
    tgz,
    shasum: createHash('sha1').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  }
}

/** 解开一个 tarball 到 stage/node_modules/<name>（扁平布局，模拟 npm 的 hoist 结果）。 */
function extractIntoStage(tgz, name) {
  const dest = join(NODE_MODULES, name)
  const tmp = join(WORK, '.extract')
  rmSync(dest, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  mkdirSync(dirname(dest), { recursive: true })
  run('tar', ['-xzf', tgz, '-C', tmp])
  renameSync(join(tmp, 'package'), dest)
  rmSync(tmp, { recursive: true, force: true })
  return dest
}

/** 递归列出已安装的包名（含 scoped 包）。 */
function installedPackages() {
  const names = []
  for (const entry of readdirSync(NODE_MODULES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      for (const sub of readdirSync(join(NODE_MODULES, entry.name), { withFileTypes: true })) {
        if (sub.isDirectory()) names.push(`${entry.name}/${sub.name}`)
      }
    } else {
      names.push(entry.name)
    }
  }
  return names.sort()
}

/** 校验 stage 里的安装集合与 CLOSURE 完全一致（不多不少、版本精确）。 */
function verifyClosure() {
  const actual = installedPackages()
  const expected = [...new Set(CLOSURE.map(item => item.name))].sort()
  if (actual.join('\n') !== expected.join('\n')) {
    const extra = actual.filter(name => !expected.includes(name))
    const missing = expected.filter(name => !actual.includes(name))
    throw new Error(
      `依赖闭包装出来的集合与 CLOSURE 不一致：\n`
      + `  多出：${extra.join(', ') || '(无)'}\n`
      + `  缺少：${missing.join(', ') || '(无)'}\n`
      + '  上游依赖变了？更新 scripts/vendor-bpmn.mjs 里的 CLOSURE 常量。',
    )
  }
  for (const { name, version } of CLOSURE) {
    const pkg = JSON.parse(readFileSync(join(NODE_MODULES, name, 'package.json'), 'utf8'))
    if (pkg.version !== version) {
      throw new Error(`${name} 安装版本 ${pkg.version} != CLOSURE 里的 ${version}`)
    }
  }
  return CLOSURE
}

/** 读包里的 LICENSE（有的包叫 LICENSE.md）；拿不到返回空串。 */
function readLicense(pkgDir) {
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    const path = join(pkgDir, file)
    if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  }
  return ''
}

/** 从 package.json 的 dependencies 真正递归出某个顶层包的依赖闭包（不含它自己）。 */
function closureOf(target) {
  const seen = new Set()
  const stack = Object.keys(JSON.parse(readFileSync(join(NODE_MODULES, target.name, 'package.json'), 'utf8')).dependencies || {})
  while (stack.length > 0) {
    const name = stack.pop()
    if (seen.has(name)) continue
    seen.add(name)
    const deps = JSON.parse(readFileSync(join(NODE_MODULES, name, 'package.json'), 'utf8')).dependencies || {}
    stack.push(...Object.keys(deps))
  }
  return [...seen].sort()
}

async function bundleTarget(target, esbuildVersion) {
  mkdirSync(STAGE, { recursive: true })
  const entryPath = join(STAGE, `entry-${target.name.replace(/[^a-zA-Z0-9]+/g, '-')}.mjs`)
  writeFileSync(entryPath, target.entry)

  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
    absWorkingDir: STAGE,
  })
  const code = result.outputFiles[0].text

  const pkgDir = join(NODE_MODULES, target.name)
  const license = readLicense(pkgDir)
  const deps = closureOf(target)
    .map(name => {
      const depPkg = JSON.parse(readFileSync(join(NODE_MODULES, name, 'package.json'), 'utf8'))
      return `${name}@${depPkg.version}（${depPkg.license || '未知许可'}）`
    })
    .join('、')

  const header = [
    '/**',
    ` * vendored: ${target.name} —— 这是第三方代码，**不要手改**。`,
    ' *',
    ` * 版本：${target.name}@${target.version}`,
    ` * 许可：${JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).license || 'MIT'}`
      + '（完整文本见仓库根 THIRD-PARTY.md，随包分发）',
    ` * 来源：npm pack ${target.name}@${target.version}（${target.homepage}）`,
    ` * tarball shasum：${target.meta.shasum}`,
    ` * tarball integrity：${target.meta.integrity}`,
    ` * 打包：esbuild@${esbuildVersion} --bundle --format=esm --platform=neutral（未压缩）`,
    ` * 依赖闭包（版本已锁定；各包许可与版权见 THIRD-PARTY.md）：${deps}`,
    ' *',
    ` * 重新生成：node scripts/vendor-bpmn.mjs（升级改脚本顶部的 VENDORED / CLOSURE 常量）`,
    ' * 校验产物：node scripts/vendor-bpmn.mjs --check',
    ' *',
    ' * 本仓库对它只做 bundle，未修改其逻辑；如需打补丁，请在此头部写明 patch 内容，',
    ' * 并同步更新 scripts/vendor-bpmn.mjs，保证「重新生成」仍能复现。',
    ' */',
    '',
  ]
  if (license !== '') {
    header.push(license.split('\n').map(line => (line ? `// ${line}` : '//')).join('\n'), '')
  }
  return { content: [...header, code].join('\n') }
}

const { build } = await import('esbuild')
const esbuildVersion = JSON.parse(readFileSync(join(REPO, 'node_modules', 'esbuild', 'package.json'), 'utf8')).version

mkdirSync(WORK, { recursive: true })
// 每次重建都从干净的 stage 开始，避免上一次的残留包混进产物。
rmSync(STAGE, { recursive: true, force: true })
mkdirSync(NODE_MODULES, { recursive: true })

// 1) 抓取并解开完整依赖闭包（版本全部锁死）
const metaByName = new Map()
for (const item of CLOSURE) {
  const version = item.version
  const meta = fetchTarball(item.name, version)
  extractIntoStage(meta.tgz, item.name)
  metaByName.set(item.name, meta)
  const installed = JSON.parse(readFileSync(join(NODE_MODULES, item.name, 'package.json'), 'utf8'))
  if (installed.version !== version) throw new Error(`${item.name} tarball 版本 ${installed.version} != ${version}`)
}
const closure = verifyClosure()

// 2) 逐个打成单文件 ESM
const results = []
for (const target of VENDORED) {
  const bundle = await bundleTarget({ ...target, meta: metaByName.get(target.name) }, esbuildVersion)
  results.push({ target, ...bundle })
}

// 3) 写盘 / 校验
const summary = []
let failed = false
for (const { target, content } of results) {
  const out = join(REPO, 'src', target.out)
  const hash = sha256(content)
  const existed = existsSync(out)
  const previous = existed ? readFileSync(out, 'utf8') : null
  summary.push({
    file: `src/${target.out}`,
    tag: `${target.name}@${target.version}`,
    bytes: Buffer.byteLength(content),
    hash,
    changed: previous !== content,
  })

  if (checkOnly) {
    if (!existed) {
      console.error(`✗ ${out} 不存在：先跑 node scripts/vendor-bpmn.mjs`)
      failed = true
    } else if (previous !== content) {
      console.error(`✗ ${out} 与脚本重建结果不一致（local sha256=${sha256(previous)} / expected=${hash}）`)
      console.error(`  跑 node scripts/vendor-bpmn.mjs 重新生成；不要手改 src/${target.out}`)
      failed = true
    }
  } else if (previous === content) {
    console.log(`已是最新：${target.name}@${target.version}（sha256=${hash}，${Buffer.byteLength(content)} 字节）`)
  } else {
    writeFileSync(out, content)
    console.log(`✓ 写入 ${out}`)
  }
}

// 4) 冒烟：产物能 import、关键导出都在（--check 也跑，避免「字节一致但根本加载不了」）
for (const { target } of results) {
  const out = join(REPO, 'src', target.out)
  if (!existsSync(out)) {
    failed = true
    continue
  }
  let mod
  try {
    mod = await import(`${out}?t=${Date.now()}-${target.out}`)
  } catch (error) {
    console.error(`✗ import ${target.out} 失败：${error.message}`)
    failed = true
    continue
  }
  const absent = target.expect.filter(name => (name === 'default' ? mod.default === undefined : mod[name] === undefined))
  if (absent.length > 0) {
    console.error(`✗ ${target.out} 缺少导出：${absent.join(', ')}`)
    failed = true
    continue
  }
  console.log(`  ${target.out} 可加载，导出 ${Object.keys(mod).length} 个符号（校验 ${target.expect.join(', ')}）`)
}

if (failed) process.exit(1)

for (const item of summary) {
  console.log(`  ${item.tag} → ${item.file} · ${item.bytes} 字节 · sha256=${item.hash}${item.changed ? '' : '（未变）'}`)
}
if (checkOnly) {
  console.log(`✓ vendored 产物与脚本输出一致（${summary.length} 个文件）`)
}

// 5) 清掉解包目录，避免 .tmp 里躺一整棵 npm 包（tarball 保留，下次可直接复用）
rmSync(STAGE, { recursive: true, force: true })
const keep = readdirSync(WORK).filter(name => name.endsWith('.tgz')).sort()
console.log(`  .tmp/vendor 保留 tarball ${keep.length} 个：${keep.join(', ') || '(空)'}`)
console.log(`  依赖闭包：${closure.map(item => `${item.name}@${item.version}`).join('、')}`)
