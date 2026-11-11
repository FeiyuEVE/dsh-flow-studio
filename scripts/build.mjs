#!/usr/bin/env node
/**
 * 构建 lib/：客户端走**两次显式 esbuild**打成两个产物，Host 侧模块原样复制。
 *
 *   src/client/entry.js     -> lib/client.js       （主包，factory 返回 createPlugin）
 *   src/client/bpmn/entry.js -> lib/client.bpmn.js （chunk，chunk: 'client.bpmn.js'）
 *   src/index.js            -> lib/index.js
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
 * 体积只报数（raw / gzip），不设自设上限；结构错误（缺文件、依赖错位、陈旧产物）仍硬失败。
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
import { gzipSync } from 'node:zlib'
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
  'bpmn-moddle.js',
  'bpmn-expr.js',
  'bpmn-parse.js',
  'bpmn-convert.js',
  'bpmn-policy.js',
  'bpmn-state.js',
  'bpmn-runner.js',
  'bpmn-runtime.js',
  'node-finish.js',
  'node-finish-mcp.js',
  'agent-adapter.js',
  'agent-adapter-dsh.js',
  'agent-adapter-codex.js',
  'agent-execute.js',
]

/** 由 esbuild 生成、不是从 src 拷贝的产物，同样计入 lib/ 产物清单。 */
export const GENERATED_MODULES = ['client.js', 'client.bpmn.js']

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

  /**
   * 两次产物共用同一套编译配置：都是 closure-factory 里的 CJS bundle，React 由宿主
   * 模块表提供。主包与 chunk 分开构建、分别包装，不启用会生成第三个匿名共享文件的
   * ESM splitting —— 宿主只认固定文件名 client.js / client.bpmn.js。
   */
  const common = {
    bundle: true,
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
    metafile: true,
    logLevel: 'warning',
  }

  // 主包：保持既有语义，factory 返回 createPlugin(require)。
  const mainResult = await build({
    ...common,
    entryPoints: [resolve(root, 'src/client/entry.js')],
    outfile: resolve(libDir, 'client.js'),
    banner: {
      js: '// Generated from src/client/entry.js via `node scripts/build.mjs` (esbuild). Do not edit directly.\n'
        + 'window.__ModuleLoader__.load({ id: \'@feiyueve/dsh-flow-studio\', factory: (require) => {\n'
        + 'var module = { exports: {} }; var exports = module.exports;',
    },
    footer: { js: 'return module.exports.createPlugin(require);\n} });' },
  })

  // 画布 chunk：宿主协议要求 chunk 字段为**固定文件名**，且由 `require.async('./client.bpmn.js')` 加载。
  // factory 返回 chunk 的 exports（后续阶段接入 Modeler / 属性面板）。
  const chunkResult = await build({
    ...common,
    entryPoints: [resolve(root, 'src/client/bpmn/entry.js')],
    outfile: resolve(libDir, 'client.bpmn.js'),
    banner: {
      js: '// Generated from src/client/bpmn/entry.js via `node scripts/build.mjs` (esbuild). Do not edit directly.\n'
        + 'window.__ModuleLoader__.load({ id: \'@feiyueve/dsh-flow-studio\', chunk: \'client.bpmn.js\', factory: (require) => {\n'
        + 'var module = { exports: {} }; var exports = module.exports;',
    },
    footer: { js: 'return module.exports;\n} });' },
  })

  /** 只报体积：raw / gzip 都打出来，不再用自设上限硬失败。 */
  const reportSize = (label, file) => {
    const data = readFileSync(resolve(libDir, file))
    const raw = data.length
    const gzip = gzipSync(data, { level: 9 }).length
    console.log(`✓ lib/${file} raw=${raw} gzip=${gzip}`)
    return { raw, gzip }
  }
  const mainSize = reportSize('client', 'client.js')
  const chunkSize = reportSize('client.bpmn', 'client.bpmn.js')

  for (const file of HOST_MODULES) {
    copyFileSync(resolve(root, 'src', file), resolve(libDir, file))
    const size = statSync(resolve(libDir, file)).size
    console.log(`✓ lib/${file} ${size} bytes`)
  }

  // 构建后做一次最基本的自检：两个产物必须按宿主协议注册，否则浏览器端整棵插件图会挂。
  const client = readFileSync(resolve(libDir, 'client.js'), 'utf8')
  const chunk = readFileSync(resolve(libDir, 'client.bpmn.js'), 'utf8')
  if (!client.includes('@feiyueve/dsh-flow-studio')) {
    console.error('✗ lib/client.js 里找不到注册 id @feiyueve/dsh-flow-studio')
    process.exit(1)
  }
  if (!client.includes('__ModuleLoader__')) {
    console.error('✗ lib/client.js 里找不到 __ModuleLoader__ 调用')
    process.exit(1)
  }
  if (!/factory:\s*\(require\)/.test(client) || client.includes("chunk: 'client.bpmn.js'")) {
    console.error('✗ lib/client.js 的主包注册形状不对（必须只有 factory，不能带 chunk 字段）')
    process.exit(1)
  }
  if (!chunk.includes('@feiyueve/dsh-flow-studio')) {
    console.error('✗ lib/client.bpmn.js 里找不到注册 id @feiyueve/dsh-flow-studio')
    process.exit(1)
  }
  if (!chunk.includes("chunk: 'client.bpmn.js'")) {
    console.error("✗ lib/client.bpmn.js 的注册字段不是 chunk: 'client.bpmn.js'")
    process.exit(1)
  }
  if (!/factory:\s*\(require\)/.test(chunk)) {
    console.error('✗ lib/client.bpmn.js 缺少 factory')
    process.exit(1)
  }
  // 0.13.3 步骤 2 仍保留旧 React Flow 画布（步骤 7 删除）；被 tree-shake 掉或外置都会在这里暴露。
  if (!client.includes('react-flow__')) {
    console.error('✗ lib/client.js 里找不到 React Flow 特征串 react-flow__（步骤 2 尚未退役，应有）')
    process.exit(1)
  }
  console.log('✓ client.js 主包注册形状正确，client.bpmn.js 带 chunk 字段与 factory')

  // 主包依赖图不得包含 bpmn-js / 官方属性面板：它们属于 chunk，不能拖慢每次打开 GUI 的首屏。
  const mainInputs = Object.keys(mainResult.metafile.inputs)
  const chunkInputs = Object.keys(chunkResult.metafile.inputs)
  const heavyInMain = mainInputs.filter(input => /node_modules\/(?:bpmn-js|diagram-js|bpmn-js-properties-panel|@bpmn-io)\//.test(input))
  if (heavyInMain.length > 0) {
    console.error(`✗ 主包依赖图里混进了画布重依赖（应只进 chunk）：\n  ${heavyInMain.join('\n  ')}`)
    process.exit(1)
  }
  const xyflowInChunk = chunkInputs.filter(input => /node_modules\/@xyflow\//.test(input))
  if (xyflowInChunk.length > 0) {
    console.error(`✗ 画布 chunk 里混进了 React Flow（旧画布不属于 chunk）：\n  ${xyflowInChunk.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`✓ 主包不含 bpmn-js / @bpmn-io 重依赖；chunk 不含 React Flow`)

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

  // 打包输入清单留个痕，便于核对产物由哪些源文件构成；按产物分别记录归属。
  const inputs = [...new Set([...mainInputs, ...chunkInputs])]
  writeFileSync(resolve(libDir, '.build-inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`)
  writeFileSync(resolve(libDir, '.build-meta.json'), `${JSON.stringify({
    'client.js': { raw: mainSize.raw, gzip: mainSize.gzip, inputs: mainInputs },
    'client.bpmn.js': { raw: chunkSize.raw, gzip: chunkSize.gzip, inputs: chunkInputs },
  }, null, 2)}\n`)
  console.log(`✓ 记录了 ${inputs.length} 个打包输入（按产物区分写进 lib/.build-meta.json）`)
}
// 只在被直接执行时构建；被 verify-build.mjs / 测试 import 时保持纯函数，不产生副作用。
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  await buildPlugin()
}
