#!/usr/bin/env node
/**
 * 构建 lib/：client 走 esbuild 打成单文件，Host 侧模块原样复制。
 *
 *   src/client/entry.js  -> lib/client.js   （单文件，__ModuleLoader__ 包装）
 *   src/index.js         -> lib/index.js
 *   src/model.js         -> lib/model.js     （Host 与 Client 共用）
 *   src/store.js         -> lib/store.js
 *   src/runlog.js        -> lib/runlog.js    （事件契约与聚合，纯函数）
 *   src/runstore.js      -> lib/runstore.js  （run 目录读写）
 *   src/engine.js        -> lib/engine.js    （执行引擎，v0.4）
 *   src/inbox.js         -> lib/inbox.js     （流程收件箱 / 节点会话复用）
 *   src/audit.js         -> lib/audit.js     （工作流健康审计，纯函数）
 *   src/tools.js         -> lib/tools.js     （会话内启停的模型工具）
 *
 * 产物可复现：同样的 src 打出来的 lib 字节相同（除 esbuild 版本差异）。
 *
 * 门禁：lib/ 是 .gitignore 排除的构建产物，包里一个 js 都没有过、也发过陈旧 lib。
 * 所以构建末尾会核对三件事 —— 清单非空、lib/ 的 .js 集合与清单完全一致、每个
 * Host 模块与 src/ 逐字节相同；任何一项不符都非零退出。模块清单一律用下面的
 * HOST_MODULES 派生，不再写第二份（scripts/verify-build.mjs 也从这里 import）。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/**
 * Host 侧要原样拷贝的模块清单 —— 唯一定义处。
 * 拷贝循环、产物数量断言、src↔lib 字节比对、scripts/verify-build.mjs 全部从它派生。
 */
export const HOST_MODULES = [
  'xstate-vendor.js',
  'index.js',
  'model.js',
  'flowdir.js',
  'store.js',
  'runlog.js',
  'runstore.js',
  'definition-store.js',
  'instance-store.js',
  'flowmachine.js',
  'engine.js',
  'node-tools.js',
  'restart.js',
  'runtime.js',
  'resume.js',
  'admission.js',
  'worktree.js',
  'executor.js',
  'process-output.js',
  'host-check.js',
  'supervise.js',
  'inbox.js',
  'audit.js',
  'tools.js',
  'bpmn-moddle-vendor.js',
  'feelin-vendor.js',
  'zeebe-moddle-vendor.js',
  'bpmn-expr.js',
  'bpmn-parse.js',
  'bpmn-convert.js',
  'bpmn-runner.js',
  'bpmn-runtime.js',
]

/** 由 esbuild 生成、不是从 src 拷贝的产物，同样计入 lib/ 产物清单。 */
export const GENERATED_MODULES = ['client.js']

/** lib/ 下应当存在的全部 .js（Host 模块 + 生成产物）。 */
export const EXPECTED_LIB_MODULES = [...HOST_MODULES, ...GENERATED_MODULES]

/** 两个 Buffer 首个不同字节的下标；完全相同返回两者长度的最小值。 */
function firstDiffIndex(a, b) {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return i
  }
  return len
}

/**
 * 逐个 Host 模块比对 src/ 与 lib/，逐字节不同即记为 mismatch。
 * 只读、不构建、不修改任何文件；verify-build.mjs 与构建末尾共用这份逻辑。
 *
 * @param {string} [rootDir] 仓库根目录（默认本脚本所在仓库）
 * @returns {{ mismatches: Array<{file: string, srcSize: number, libSize: number, firstDiff: number}>, missing: string[] }}
 */
export function compareHostModules(rootDir = root) {
  const srcDir = resolve(rootDir, 'src')
  const libDir = resolve(rootDir, 'lib')
  const mismatches = []
  const missing = []
  for (const file of HOST_MODULES) {
    const srcPath = resolve(srcDir, file)
    const libPath = resolve(libDir, file)
    if (!existsSync(srcPath)) {
      missing.push(`src/${file}`)
      continue
    }
    if (!existsSync(libPath)) {
      missing.push(`lib/${file}`)
      continue
    }
    const source = readFileSync(srcPath)
    const built = readFileSync(libPath)
    if (!source.equals(built)) {
      mismatches.push({
        file,
        srcSize: source.length,
        libSize: built.length,
        firstDiff: firstDiffIndex(source, built),
      })
    }
  }
  return { mismatches, missing }
}

/**
 * 核对 lib/ 的 .js 集合是否与清单一致：不该缺，也不该有清单没声明的多余文件。
 * 多余文件只报告、不删除（可能是另一个 agent 的产物，得人来判断）。
 *
 * @param {string} [rootDir] 仓库根目录（默认本脚本所在仓库）
 * @returns {{ actual: string[], expected: string[], absent: string[], extras: string[] }}
 */
export function auditLibModules(rootDir = root) {
  const libDir = resolve(rootDir, 'lib')
  const actual = existsSync(libDir)
    ? readdirSync(libDir).filter(name => name.endsWith('.js')).sort()
    : []
  const expected = [...EXPECTED_LIB_MODULES].sort()
  const absent = expected.filter(name => !actual.includes(name))
  const extras = actual.filter(name => !expected.includes(name))
  return { actual, expected, absent, extras }
}

/**
 * 真正跑构建：esbuild 打 client，其余 Host 模块原样拷贝，最后做打包门禁自检。
 * 用 process.exit 而不是 throw：npm 生命周期把非零退出码当失败，日志要能一眼看出是哪一项。
 */
export async function buildPlugin() {
  const libDir = resolve(root, 'lib')
  mkdirSync(libDir, { recursive: true })

  const require = createRequire(import.meta.url)
  const { build } = require('esbuild')

  const result = await build({
    entryPoints: [resolve(root, 'src/client/entry.js')],
    outfile: resolve(libDir, 'client.js'),
    bundle: true,
    // closure-factory：整个模块图（含 @xyflow/react）都在 factory 体内求值，
    // 依赖里的 require('react') 才能拿到宿主模块表；format 用 cjs 让 module.exports
    // 在 factory 内可见，banner/footer 负责包成 __ModuleLoader__ 的注册形状。
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    // React 由宿主模块表提供（createPlugin 里 bindReact(require('react'))）。
    // esbuild 的 external 会连 `react` 的子路径一起外置，所以 react/jsx-runtime 必须用
    // alias 指到真实文件再打进产物 —— 宿主模块表不保证有 jsx-runtime。
    external: ['react', 'react-dom'],
    alias: {
      'react/jsx-runtime': require.resolve('react/jsx-runtime'),
    },
    minify: true,
    keepNames: true,
    legalComments: 'none',
    charset: 'utf8',
    banner: {
      js: '// Generated from src/client/* via `node scripts/build.mjs` (esbuild). Do not edit directly.\n'
        + 'window.__ModuleLoader__.load({ id: \'@feiyueve/dsh-flow-studio\', factory: (require) => {\n'
        + 'var module = { exports: {} }; var exports = module.exports;',
    },
    footer: { js: 'return module.exports.createPlugin(require);\n} });' },
    metafile: true,
    logLevel: 'warning',
  })

  const clientSize = statSync(resolve(libDir, 'client.js')).size
  console.log(`src/client/entry.js -> lib/client.js ${clientSize} bytes`)
  // 上限证据（2026-11 实测）：把 lib/client.js 填到 428,792 字节后，宿主仍以
  // HTTP 200 完整下发 428,875 字节（combo 路由 /plugins/??<pkg>/client.js&rev=...）。
  // 所以 262144 是自设门槛而不是宿主硬上限；这里留 512 KiB 的余量并保留告警。
  const CLIENT_LIMIT = 524288
  const CLIENT_WARN = 409600
  if (clientSize > CLIENT_LIMIT) {
    console.error(`✗ lib/client.js 超过 ${CLIENT_LIMIT} 字节（${clientSize}），宿主 bundle 与加载耗时都不适合再涨`)
    process.exit(1)
  }
  if (clientSize > CLIENT_WARN) {
    console.warn(`⚠ lib/client.js ${clientSize} 字节，已超过 400 KB 警戒线（上限 ${CLIENT_LIMIT}）`)
  }
  console.log(`✓ lib/client.js 在单文件上限（${CLIENT_LIMIT}）内`)

  for (const file of HOST_MODULES) {
    copyFileSync(resolve(root, 'src', file), resolve(libDir, file))
    const size = statSync(resolve(libDir, file)).size
    console.log(`✓ lib/${file} ${size} bytes`)
  }

  // 构建后做一次最基本的自检：产物里必须含注册 id，否则浏览器端整棵插件图会挂。
  const client = readFileSync(resolve(libDir, 'client.js'), 'utf8')
  if (!client.includes('@feiyueve/dsh-flow-studio')) {
    console.error('✗ lib/client.js 里找不到注册 id @feiyueve/dsh-flow-studio')
    process.exit(1)
  }
  if (!client.includes('__ModuleLoader__')) {
    console.error('✗ lib/client.js 里找不到 __ModuleLoader__ 调用')
    process.exit(1)
  }
  // React Flow 的类名前缀是「真的打进去了」的最便宜特征；被 tree-shake 掉或外置都会在这里暴露。
  if (!client.includes('react-flow__')) {
    console.error('✗ lib/client.js 里找不到 React Flow 特征串 react-flow__')
    process.exit(1)
  }
  console.log('✓ client bundle 含 __ModuleLoader__、正确的注册 id 与 React Flow')

  // 产物自检：lib/ 里所有相对 import 必须能在 lib/ 内解析。
  // 0.5.0 就是因为漏拷 audit.js / tools.js，插件在容器里直接 404 —— 那次靠 e2e 才发现，
  // 这里在构建期就拦住：新增 src 模块却忘了加进上面的拷贝清单，构建立刻失败。
  const hostModules = readdirSync(libDir).filter(name => name.endsWith('.js'))
  const missing = []
  for (const name of hostModules) {
    const source = readFileSync(resolve(libDir, name), 'utf8')
    for (const match of source.matchAll(/from\s+'\.\/([\w.-]+)'/g)) {
      if (!existsSync(resolve(libDir, match[1]))) missing.push(`${name} → ./${match[1]}`)
    }
  }
  if (missing.length > 0) {
    console.error(`✗ lib/ 里有解析不了的相对 import（漏拷模块？）：\n  ${missing.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`✓ lib/ 内 ${hostModules.length} 个 Host 模块的相对 import 全部可解析`)

  // ---- 发布门禁 ①：清单不能为空，lib/ 的 .js 集合必须与清单一一对应 -------------
  if (HOST_MODULES.length === 0) {
    console.error('✗ Host 模块清单为空，拒绝产出「一个 js 都没有」的包')
    process.exit(1)
  }
  const audit = auditLibModules(root)
  const auditProblems = []
  if (audit.absent.length > 0) {
    auditProblems.push(`清单里有但 lib/ 缺失：${audit.absent.join(', ')}`)
  }
  if (audit.extras.length > 0) {
    // 只报告，不悄悄删：遗留产物可能是别人正在用的文件，删不删得由人判断。
    auditProblems.push(`lib/ 里有清单未声明的多余文件（请人工确认是否遗留，本脚本不会自动删除）：${audit.extras.join(', ')}`)
  }
  if (audit.actual.length !== EXPECTED_LIB_MODULES.length) {
    auditProblems.push(`lib/ 下 .js 数量 ${audit.actual.length} ≠ 清单 ${EXPECTED_LIB_MODULES.length}（Host ${HOST_MODULES.length} + 生成 ${GENERATED_MODULES.length}）`)
  }
  if (auditProblems.length > 0) {
    console.error(`✗ lib/ 产物与模块清单不一致：\n  ${auditProblems.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`✓ lib/ 下 .js 数量 ${audit.actual.length} 与清单一致（Host ${HOST_MODULES.length} + 生成 ${GENERATED_MODULES.length}）`)

  // ---- 发布门禁 ②：src ↔ lib 逐字节比对，陈旧的 lib 不许流进包里 ----------------
  // 工作树直接发（npm pack / npm publish）拿到了旧 lib 就是这一条要拦的事：
  // 源码改了、lib 没重建，字节比对会在这里非零退出并点名文件。
  const comparison = compareHostModules(root)
  if (comparison.missing.length > 0 || comparison.mismatches.length > 0) {
    const lines = []
    for (const item of comparison.missing) lines.push(`${item} 缺失`)
    for (const item of comparison.mismatches) {
      lines.push(
        `lib/${item.file} 与 src/${item.file} 不一致`
        + `（src ${item.srcSize} 字节 / lib ${item.libSize} 字节，首个不同字节 @${item.firstDiff}）`,
      )
    }
    console.error(`✗ 构建产物与源码逐字节不一致，包会带着旧行为发出去：\n  ${lines.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`✓ src ↔ lib 逐字节一致（${HOST_MODULES.length} 个 Host 模块）`)

  // 打包输入清单留个痕，便于核对产物由哪些源文件构成。
  const inputs = Object.keys(result.metafile.inputs)
  writeFileSync(resolve(libDir, '.build-inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`)
  console.log(`✓ 记录了 ${inputs.length} 个打包输入`)
}

// 只在被直接执行时构建；被 verify-build.mjs / 测试 import 时保持纯函数，不产生副作用。
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  await buildPlugin()
}
