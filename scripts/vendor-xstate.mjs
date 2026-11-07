#!/usr/bin/env node
/**
 * 把 xstate 编译成单文件 ESM 并 vendor 进仓库（08 §2）。
 *
 * 为什么 vendor 而不是装依赖：这个插件是「零运行时依赖 + lib 全部由 build 拷贝」的形态，
 * 多一个 npm 依赖就多一条供应链与版本漂移面。vendored 产物带完整溯源（版本 / shasum /
 * sha512 / 重新生成方式），升级只要改一个常量再跑一次本脚本。
 *
 * 用法：
 *   node scripts/vendor-xstate.mjs                 # 用 DEFAULT_VERSION
 *   node scripts/vendor-xstate.mjs --version=5.33.3
 *   node scripts/vendor-xstate.mjs --check          # 只校验已提交产物是否与脚本一致（CI 用）
 *
 * 幂等：同样的版本 + 同样的 esbuild 版本 → 输出字节一致；内容相同则打印「已是最新」不重写。
 * 临时文件全部落在 <repo>/.tmp/vendor/（不提交）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_VERSION = '5.33.3'
const OUT = join(REPO, 'src', 'xstate-vendor.js')
const WORK = join(REPO, '.tmp', 'vendor')
const ENTRY = join(WORK, 'entry.mjs')

function argOf(name, fallback) {
  const hit = process.argv.slice(2).find(item => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const checkOnly = process.argv.includes('--check')
const version = argOf('version', DEFAULT_VERSION)

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function distMeta() {
  // `npm view <pkg> <field> --json` 对点号字段返回的是 [{ 'dist.shasum': … }]（数组 + 原名 key），
  // 不是嵌套对象 —— 这里两种形状都兜住，拿不到就留空（不阻塞 vendor，头部会写「未知」）。
  const raw = run('npm', ['view', `xstate@${version}`, 'dist.shasum', 'dist.integrity', '--json'])
  const parsed = JSON.parse(raw)
  const flat = Array.isArray(parsed) ? parsed[0] || {} : parsed
  const pick = key => flat[key] || (flat.dist && flat.dist[key.split('.')[1]]) || ''
  return { shasum: String(pick('dist.shasum')), integrity: String(pick('dist.integrity')) }
}

async function bundle(meta) {
  mkdirSync(WORK, { recursive: true })
  // 1) 取 tarball 并解到 .tmp/vendor/node_modules/xstate（不写进仓库依赖树）
  const tgz = run('npm', ['pack', `xstate@${version}`, '--pack-destination', WORK, '--silent']).trim().split('\n').pop()
  const tgzPath = join(WORK, tgz)
  const pkgDir = join(WORK, 'node_modules', 'xstate')
  rmSync(pkgDir, { recursive: true, force: true })
  mkdirSync(join(WORK, 'node_modules'), { recursive: true })
  run('tar', ['-xzf', tgzPath, '-C', WORK])
  rmSync(pkgDir, { recursive: true, force: true })
  execFileSync('mv', [join(WORK, 'package'), pkgDir], { cwd: REPO })

  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  if (pkg.version !== version) throw new Error(`tarball 版本 ${pkg.version} != ${version}`)
  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
    throw new Error(`xstate@${version} 竟然有运行时依赖：${Object.keys(pkg.dependencies).join(',')}`)
  }

  writeFileSync(ENTRY, "export * from 'xstate'\n")

  // 2) 用仓库自己的 esbuild 打成单文件 ESM（不压缩，保留可读性便于按需打补丁）
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
    absWorkingDir: REPO,
  })
  const code = result.outputFiles[0].text
  const esbuildVersion = JSON.parse(readFileSync(join(REPO, 'node_modules', 'esbuild', 'package.json'), 'utf8')).version

  const license = readFileSync(join(pkgDir, 'LICENSE'), 'utf8').trim()
  const header = [
    '/**',
    ' * vendored: xstate —— 这是第三方代码，**不要手改**。',
    ' *',
    ` * 版本：xstate@${version}`,
    ` * 许可：MIT（完整文本见仓库根 THIRD-PARTY.md，随包分发）`,
    ` * 来源：npm pack xstate@${version}（https://github.com/statelyai/xstate）`,
    ` * tarball shasum：${meta.shasum || '(未知)'}`,
    ` * tarball integrity：${meta.integrity || '(未知)'}`,
    ` * 打包：esbuild@${esbuildVersion} --bundle --format=esm --platform=neutral（未压缩）`,
    ' *',
    ' * 重新生成：node scripts/vendor-xstate.mjs（升级改脚本顶部的 DEFAULT_VERSION）',
    ' * 校验产物：node scripts/vendor-xstate.mjs --check',
    ' *',
    ' * 本仓库对它只做 bundle，未修改其逻辑；如需打补丁，请在此头部写明 patch 内容，',
    ' * 并同步更新 scripts/vendor-xstate.mjs，保证「重新生成」仍能复现。',
    ' */',
    '',
    license.split('\n').map(line => (line ? `// ${line}` : '//')).join('\n'),
    '',
    code,
  ].join('\n')

  return { content: header, esbuildVersion, license }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

const meta = distMeta()
const { content, esbuildVersion } = await bundle(meta)
const hash = sha256(content)
const existed = existsSync(OUT)
const previous = existed ? readFileSync(OUT, 'utf8') : null

if (checkOnly) {
  if (!existed) {
    console.error(`✗ ${OUT} 不存在：先跑 node scripts/vendor-xstate.mjs`)
    process.exit(1)
  }
  if (previous !== content) {
    console.error(`✗ vendored 产物与脚本输出不一致（local sha256=${sha256(previous)} / expected=${hash}）`)
    console.error('  跑 node scripts/vendor-xstate.mjs 重新生成；不要手改 src/xstate-vendor.js')
    process.exit(1)
  }
  console.log(`✓ vendored xstate@${version} 与脚本输出一致（sha256=${hash}）`)
  process.exit(0)
}

if (previous === content) {
  console.log(`已是最新：xstate@${version}（sha256=${hash}，${content.length} 字节）`)
} else {
  writeFileSync(OUT, content)
  console.log(`✓ 写入 ${OUT}`)
}

const mod = await import(`${OUT}?t=${Date.now()}`)
const exports = Object.keys(mod)
console.log(`  xstate@${version} · esbuild@${esbuildVersion} · ${content.length} 字节 · sha256=${hash} · 导出 ${exports.length} 个符号`)
if (exports.length < 40) {
  console.error(`✗ 导出符号只有 ${exports.length} 个（期望 ≥40），bundle 可能不完整`)
  process.exit(1)
}

// 顺手清掉解包目录，避免 .tmp 里躺一整棵 npm 包（tarball 保留，下次可直接复用）
rmSync(join(WORK, 'node_modules'), { recursive: true, force: true })
rmSync(join(WORK, 'entry.mjs'), { force: true })
const keep = readdirSync(WORK).filter(name => name.endsWith('.tgz'))
console.log(`  .tmp/vendor 保留：${keep.join(', ') || '(空)'}`)
