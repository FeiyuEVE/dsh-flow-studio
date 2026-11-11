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
 * 构建末尾写出 lib/build-meta.json：schemaVersion + inputsHash（源码/脚本/锁文件/依赖内容
 * / 官方 CSS 与 woff2 字体）+ 每个生成产物的 bytes/gzipBytes/sha256 + 模块清单 + 输入清单。
 * verify-build.mjs 以「用同一个 buildClientBundles(write:false) 按当前源码重建 + 逐字节
 * 比较」为主判据，meta 只作交叉核对与差异定位；缺 meta 一律失败，不静默跳过。
 *
 * 门禁：lib/ 是 .gitignore 排除的构建产物，包里一个 js 都没有过、也发过陈旧 lib。
 * 所以构建末尾会核对三件事 —— 清单非空、lib/ 的 .js 集合与清单完全一致、每个
 * Host 模块与 src/ 逐字节相同；任何一项不符都非零退出。模块清单一律用下面的
 * HOST_MODULES 派生，不再写第二份（scripts/verify-build.mjs 也从这里 import）。
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildBpmnAssets, collectBpmnAssetInputs, renderBpmnAssets } from './build-bpmn-assets.mjs'

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

/** 构建元数据文件名：放在 lib/ 内（随包发布），不落到仓库根。 */
export const BUILD_META_FILE = 'build-meta.json'

/** 元数据 schema 版本；verify-build.mjs 只接受这个值，不做向后兼容猜测。 */
export const BUILD_META_SCHEMA_VERSION = 2

/** 两个生成产物的注册外壳：构建与 verify 的独立重建必须逐字节相同。 */
export const CLIENT_BANNER = '// Generated from src/client/entry.js via `node scripts/build.mjs` (esbuild). Do not edit directly.\n'
  + 'window.__ModuleLoader__.load({ id: \'@feiyueve/dsh-flow-studio\', factory: (require) => {\n'
  + 'var module = { exports: {} }; var exports = module.exports;'
export const CLIENT_FOOTER = 'return module.exports.createPlugin(require);\n} });'
export const CHUNK_BANNER = '// Generated from src/client/bpmn/entry.js via `node scripts/build.mjs` (esbuild). Do not edit directly.\n'
  + 'window.__ModuleLoader__.load({ id: \'@feiyueve/dsh-flow-studio\', chunk: \'client.bpmn.js\', factory: (require) => {\n'
  + 'var module = { exports: {} }; var exports = module.exports;'
export const CHUNK_FOOTER = 'return module.exports;\n} });'

/** 参与构建的脚本：scripts/build*.mjs 全部纳入输入哈希（新增构建助手自动覆盖）。 */
const BUILD_SCRIPT_PATTERN = /^build.*\.mjs$/

/** 参与构建的清单文件：依赖版本与锁文件内容都进输入哈希。 */
const BUILD_MANIFEST_FILES = ['package.json', 'package-lock.json']

/** 旧版构建留下的元数据（0.13.3 之前）；构建时清掉，避免旧字段混进包里。 */
const LEGACY_META_FILES = ['.build-meta.json', '.build-inputs.json']

/**
 * 依赖泄漏的**内容特征**：不依赖任何可删除的 metadata 字段，也不只是 grep 注册字符串。
 * 每条都来自真实依赖代码或官方样式；主包混入 chunk 会同时命中多条。
 *
 * 注意：0.13.3 步骤 7 之前主包仍带旧画布 React Flow（src/client 里还在用），
 * 所以主包的禁用表只列 BPMN 栈；chunk 的 React Flow 禁用不受此影响。
 */
export const LEAK_MARKERS = {
  'client.js': [
    ['bpmn-js 包名', /bpmn-js/],
    ['diagram-js 包名', /diagram-js/],
    ['官方属性面板包名', /bpmn-js-properties-panel/],
    ['@bpmn-io 作用域', /@bpmn-io/],
    ['bio-properties-panel 类名', /bio-properties-panel/],
    ['BPMN 主题桥接样式 --bio-surface', /--bio-surface/],
    ['内联 woff2 字体', /data:font\/woff2;base64,/],
  ],
  'client.bpmn.js': [
    ['React Flow 样式类名 react-flow__', /react-flow__/],
    ['@xyflow 依赖标记', /@xyflow\//],
  ],
}

/** 按文件类型返回命中的泄漏特征标签；无泄漏返回空数组。 */
export function findLeakMarkers(file, source) {
  const markers = LEAK_MARKERS[file] ?? []
  return markers.filter(([, pattern]) => pattern.test(source)).map(([label]) => label)
}

/** 统一成正斜杠，保证 Windows / Linux 的输入清单路径写法一致。 */
function toPosixPath(file) {
  return file.split('\\').join('/')
}

/** 一个 Buffer 的 sha256（十六进制小写）。 */
function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** 递归列出目录下全部文件（相对 rootDir，正斜杠），调用方负责排序。 */
function walkFiles(rootDir, relDir) {
  const absDir = resolve(rootDir, relDir)
  if (!existsSync(absDir)) return []
  const out = []
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const relPath = `${relDir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walkFiles(rootDir, relPath))
    else out.push(relPath)
  }
  return out
}

/**
 * 收集一次构建的完整输入清单，并逐文件算 sha256。
 *
 * 覆盖四部分：
 *   1. 源码树 + 构建脚本 + package.json / package-lock.json（目录整体扫描，新增/删除都变）；
 *   2. 生成画布资源的官方输入：四份 CSS + CSS 里实际引用的 woff2 字体
 *      （build-bpmn-assets.mjs 读取的文件；只绑生成后的 assets.generated.js 会漏检）；
 *   3. esbuild 自身的 package.json（构建工具版本）；
 *   4. esbuild metafile 记录的实际打包输入（含 node_modules 里的依赖文件内容）。
 *
 * 每条 entry 带 `feeds`：这份输入最终进入哪条产物（client.js / client.bpmn.js /
 * lib/<host 模块> / build 本身）。它只用于人工核对，不参与 inputsHash。
 * 这样 CSS / 字体被换掉时，清单能说清影响的是 chunk，而不是只报「某个文件变了」。
 *
 * strict=true 时缺文件直接抛错（构建路径）；verify 传 false，把缺失记成 sha256='missing'
 * 由它给出可读错误。
 *
 * @param {string} [rootDir] 仓库根目录
 * @param {string[]} [bundledPaths] esbuild metafile 的 inputs 键
 * @param {{strict?: boolean, outputInputs?: Record<string, string[]>}} [options]
 * @returns {Array<{path: string, bytes: number, sha256: string, feeds: string[]}>} 按 path 排序
 */
export function collectBuildInputs(rootDir = root, bundledPaths = [], options = {}) {
  const { strict = true, outputInputs = {} } = options
  const entries = new Map()
  const bundled = new Set(bundledPaths.map(toPosixPath))
  const assetInputs = new Set(collectBpmnAssetInputs(rootDir))
  const mainInputs = new Set((outputInputs['client.js'] ?? []).map(toPosixPath))
  const chunkInputs = new Set((outputInputs['client.bpmn.js'] ?? []).map(toPosixPath))
  const hostModulePaths = new Set(HOST_MODULES.map(name => `src/${name}`))

  /** 这份输入属于哪条产物；同一文件可能同时喂多个产物，所以返回数组。 */
  const feedsFor = relPath => {
    const feeds = new Set()
    if (assetInputs.has(relPath) || relPath === 'src/client/bpmn/assets.generated.js') {
      feeds.add('client.bpmn.js')
    }
    if (mainInputs.has(relPath)) feeds.add('client.js')
    if (chunkInputs.has(relPath)) feeds.add('client.bpmn.js')
    if (hostModulePaths.has(relPath)) feeds.add(`lib/${relPath.slice('src/'.length)}`)
    if (feeds.size === 0) feeds.add('build')
    return [...feeds].sort()
  }

  const addEntry = relPath => {
    const normalized = toPosixPath(relPath)
    const feeds = feedsFor(normalized)
    const existing = entries.get(normalized)
    if (existing !== undefined) {
      existing.feeds = [...new Set([...existing.feeds, ...feeds])].sort()
      return
    }
    const abs = resolve(rootDir, normalized)
    if (!existsSync(abs)) {
      if (strict) throw new Error(`构建输入缺失：${normalized}`)
      entries.set(normalized, { path: normalized, bytes: -1, sha256: 'missing', feeds })
      return
    }
    const data = readFileSync(abs)
    entries.set(normalized, { path: normalized, bytes: data.length, sha256: sha256Hex(data), feeds })
  }

  // 1) 源码树 / 构建脚本 / 清单：按目录整体扫描，新增文件也会改变 inputsHash。
  for (const rel of walkFiles(rootDir, 'src').sort()) addEntry(rel)
  const scriptsDir = resolve(rootDir, 'scripts')
  if (existsSync(scriptsDir)) {
    const buildScripts = readdirSync(scriptsDir)
      .filter(name => BUILD_SCRIPT_PATTERN.test(name))
      .sort()
    for (const name of buildScripts) addEntry(`scripts/${name}`)
  }
  for (const rel of BUILD_MANIFEST_FILES) addEntry(rel)

  // 2) 画布资源的官方输入：CSS 与 woff2 字体（资源生成链的上游，不是生成后的 JS）。
  for (const rel of assetInputs) addEntry(rel)

  // 3) 构建工具本身：esbuild 版本变了，产物可能变，输入哈希必须跟着变。
  try {
    const esbuildPkg = createRequire(import.meta.url).resolve('esbuild/package.json')
    addEntry(relative(rootDir, esbuildPkg))
  } catch {
    // esbuild 没装时构建本来就跑不起来；这里不掩盖构建路径的错误。
  }

  // 4) esbuild 实际读过的依赖文件（metafile inputs，含 src 与 node_modules）。
  for (const raw of [...bundled].sort()) addEntry(raw)

  // 没有 per-output 信息时（例如只拿旧清单重算），bundled 输入至少标到两条产物上。
  if (mainInputs.size === 0 && chunkInputs.size === 0) {
    for (const rel of bundled) {
      const entry = entries.get(toPosixPath(rel))
      if (entry !== undefined && entry.feeds.length === 1 && entry.feeds[0] === 'build') {
        entry.feeds = ['client.bpmn.js', 'client.js']
      }
    }
  }

  return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** 输入清单的稳定哈希：path + 字节数 + 内容 sha256，排序后逐行喂给 sha256。 */
export function hashInputManifest(entries) {
  const hash = createHash('sha256')
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${entry.path}\0${entry.bytes}\0${entry.sha256}\n`)
  }
  return hash.digest('hex')
}

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
 * 从 esbuild metafile 取「真正进入该产物」的模块清单与字节数。
 * metafile.inputs 是整次构建的输入并集；outputs[*].inputs 才是每个产物的依赖图，
 * 泄漏断言必须看后者，否则被 tree-shake 掉的模块会被误判。
 *
 * 构建期生成的 CSS/字体模块是内存里的虚拟模块（namespace 'bpmn-assets'），
 * 不是磁盘依赖；这里排除掉，避免输入清单去解析一个不存在的路径。
 *
 * @param {object} metafile esbuild 构建结果里的 metafile
 * @returns {Array<{path: string, bytes: number}>} 按 path 排序
 */
function collectBundleModules(metafile) {
  const output = Object.values(metafile.outputs)[0] ?? { inputs: {} }
  return Object.entries(output.inputs)
    .filter(([path]) => !path.startsWith('bpmn-assets:'))
    .map(([path, info]) => ({ path: toPosixPath(path), bytes: info.bytesInOutput }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * 构建两个客户端包（主包 + BPMN chunk）。
 *
 * 这是 `npm run build` 与 verify「独立重建」共用的唯一实现：
 *   - write=true：写 lib/client.js、lib/client.bpmn.js（正常构建）；
 *   - write=false：esbuild `write:false`，只返回内存字节，不碰工作树（verify 用）。
 *
 * 生成资源（src/client/bpmn/assets.generated.js）通过虚拟模块注入 esbuild：
 * 调用方传 `assetSource`（renderBpmnAssets 的结果），重建时就不会读到工作树上
 * 可能陈旧/被篡改的生成文件。不传时现场在内存渲染一份。
 *
 * @param {{rootDir?: string, write?: boolean, assetSource?: string}} [options]
 * @returns {Promise<{
 *   outputs: Record<string, Buffer>,
 *   metafiles: Record<string, object>,
 *   modules: Record<string, Array<{path: string, bytes: number}>>,
 *   inputs: Record<string, string[]>,
 * }>}
 */
export async function buildClientBundles(options = {}) {
  const { rootDir = root, write = true, assetSource } = options
  const libDir = resolve(rootDir, 'lib')
  if (write) mkdirSync(libDir, { recursive: true })

  const require = createRequire(import.meta.url)
  const { build } = require('esbuild')
  const assetsSource = assetSource ?? renderBpmnAssets(rootDir).source

  /** 把构建期生成的 CSS/字体模块当成内存文件交给 esbuild。 */
  const assetPlugin = {
    name: 'bpmn-assets-in-memory',
    setup(buildApi) {
      buildApi.onResolve({ filter: /(^|\/)assets\.generated\.js$/ }, () => ({
        path: 'bpmn-assets.generated.js',
        namespace: 'bpmn-assets',
      }))
      buildApi.onLoad({ filter: /.*/, namespace: 'bpmn-assets' }, () => ({
        contents: assetsSource,
        loader: 'js',
      }))
    },
  }

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
    // metafile 里的输入路径固定相对仓库根，输入哈希才能跨 cwd 稳定复现。
    absWorkingDir: rootDir,
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
    write,
    plugins: [assetPlugin],
  }

  const [mainResult, chunkResult] = await Promise.all([
    build({
      ...common,
      entryPoints: [resolve(rootDir, 'src/client/entry.js')],
      outfile: resolve(libDir, 'client.js'),
      banner: { js: CLIENT_BANNER },
      footer: { js: CLIENT_FOOTER },
    }),
    build({
      ...common,
      entryPoints: [resolve(rootDir, 'src/client/bpmn/entry.js')],
      outfile: resolve(libDir, 'client.bpmn.js'),
      banner: { js: CHUNK_BANNER },
      footer: { js: CHUNK_FOOTER },
    }),
  ])

  const readResult = (file, result) => (
    write ? readFileSync(resolve(libDir, file)) : Buffer.from(result.outputFiles[0].contents)
  )
  return {
    outputs: {
      'client.js': readResult('client.js', mainResult),
      'client.bpmn.js': readResult('client.bpmn.js', chunkResult),
    },
    metafiles: {
      'client.js': mainResult.metafile,
      'client.bpmn.js': chunkResult.metafile,
    },
    modules: {
      'client.js': collectBundleModules(mainResult.metafile),
      'client.bpmn.js': collectBundleModules(chunkResult.metafile),
    },
    inputs: {
      'client.js': Object.keys(mainResult.metafile.inputs).filter(path => !path.startsWith('bpmn-assets:')),
      'client.bpmn.js': Object.keys(chunkResult.metafile.inputs).filter(path => !path.startsWith('bpmn-assets:')),
    },
  }
}

/**
 * 真正跑构建：esbuild 打 client，其余 Host 模块原样拷贝，最后做打包门禁自检。
 * 用 process.exit 而不是 throw：npm 生命周期把非零退出码当失败，日志要能一眼看出是哪一项。
 */
export async function buildPlugin() {
  const libDir = resolve(root, 'lib')
  mkdirSync(libDir, { recursive: true })

  // 旧版构建留下的元数据不再使用：不清掉的话它会被 npm pack 一起带进包里。
  for (const name of LEGACY_META_FILES) {
    rmSync(resolve(libDir, name), { force: true })
  }

  // 步骤 4：先内联官方 CSS/字体，生成 chunk 可 import 的样式字符串。
  // 生成物是构建产物（src/client/bpmn/assets.generated.js，.gitignore 排除）。
  const assets = buildBpmnAssets(root)
  console.log(
    `✓ bpmn 资源：${assets.files.length} 个官方样式表，${assets.fontCount} 个 woff2 base64，`
    + `CSS ${assets.cssBytes} 字节`,
  )

  // 两个客户端包统一由 buildClientBundles() 构建；verify 用同一个函数 write:false 重建。
  const bundles = await buildClientBundles({
    rootDir: root,
    write: true,
    assetSource: assets.generatedSource,
  })

  /** 只报体积：raw / gzip 都打出来，不再用自设上限硬失败。 */
  const reportSize = (label, file) => {
    const data = bundles.outputs[file]
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
  // 步骤 4：官方 CSS + 内联字体只能进 chunk；主包一个字节都不该有。
  if (client.includes('data:font/woff2;base64,')) {
    console.error('✗ lib/client.js 里混进了 bpmn 字体（应只进 chunk）')
    process.exit(1)
  }
  if (!chunk.includes('data:font/woff2;base64,')) {
    console.error('✗ lib/client.bpmn.js 里没有内联 woff2 字体（步骤 4 要求自包含）')
    process.exit(1)
  }
  if (!chunk.includes('--bio-surface') || !chunk.includes('.bio-theme-parent')) {
    console.error('✗ lib/client.bpmn.js 里没有主题桥接样式（--bio-* → --dsw-*）')
    process.exit(1)
  }
  if (/url\(\s*['"]?(?:\.\.?\/|https?:)/.test(chunk)) {
    console.error('✗ lib/client.bpmn.js 里残留外部 url()（CSS/字体必须内联，不能额外请求）')
    process.exit(1)
  }
  console.log('✓ client.js 主包注册形状正确，client.bpmn.js 带 chunk 字段、自包含样式与内联字体')

  // 主包依赖图不得包含 bpmn-js / 官方属性面板：它们属于 chunk，不能拖慢每次打开 GUI 的首屏。
  const mainInputs = bundles.inputs['client.js']
  const chunkInputs = bundles.inputs['client.bpmn.js']
  const heavyPattern = /node_modules\/(?:bpmn-js|diagram-js|bpmn-js-properties-panel|@bpmn-io)\//
  const heavyInMain = mainInputs.filter(input => heavyPattern.test(input))
  if (heavyInMain.length > 0) {
    console.error(`✗ 主包依赖图里混进了画布重依赖（应只进 chunk）：\n  ${heavyInMain.join('\n  ')}`)
    process.exit(1)
  }
  // 模块级判据（metafile outputs[*].inputs）：只看真正进入产物的模块与字节数，
  // 不依赖可被删除/篡改的字符串特征。
  const heavyModulesInMain = bundles.modules['client.js'].filter(item => heavyPattern.test(item.path))
  if (heavyModulesInMain.length > 0) {
    console.error(
      '✗ 主包模块清单里混进了画布重依赖（应只进 chunk）：\n  '
      + heavyModulesInMain.map(item => `${item.path} (${item.bytes} 字节)`).join('\n  '),
    )
    process.exit(1)
  }
  const xyflowInChunk = bundles.modules['client.bpmn.js'].filter(item => /node_modules\/@xyflow\//.test(item.path))
  if (xyflowInChunk.length > 0) {
    console.error(`✗ 画布 chunk 里混进了 React Flow（旧画布不属于 chunk）：\n  ${xyflowInChunk.map(item => item.path).join('\n  ')}`)
    process.exit(1)
  }
  // 依赖图之外再做一层内容特征检查：即使 metafile 被换掉，混进来的真实代码也会命中这些串。
  const mainLeaks = findLeakMarkers('client.js', client)
  if (mainLeaks.length > 0) {
    console.error(`✗ 主包内容命中画布依赖特征（应只进 chunk）：${mainLeaks.join('、')}`)
    process.exit(1)
  }
  const chunkLeaks = findLeakMarkers('client.bpmn.js', chunk)
  if (chunkLeaks.length > 0) {
    console.error(`✗ 画布 chunk 内容命中 React Flow 特征：${chunkLeaks.join('、')}`)
    process.exit(1)
  }
  console.log(`✓ 主包不含 bpmn-js / @bpmn-io 重依赖；chunk 不含 React Flow（依赖图 + 内容特征双重检查）`)

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

  // ---- 构建元数据：把「这份产物」和「产出它的输入」一起钉死 ----------------------
  // verify-build.mjs 用**独立重建 + 逐字节比较**作为主判据；这份元数据提供：
  //   ① 输入清单与 inputsHash（人工核对 / 差异定位）；
  //   ② 每个产物的 sha256（兼容旧口径的快速绑定）；
  //   ③ modules：metafile 里真正进入该产物的模块与字节数 —— verify 会拿重建的
  //      metafile 交叉核对，字符串特征只作为辅助。
  const outputs = [
    {
      file: 'client.js',
      bytes: mainSize.raw,
      gzipBytes: mainSize.gzip,
      sha256: sha256Hex(bundles.outputs['client.js']),
      inputs: mainInputs,
      modules: bundles.modules['client.js'],
    },
    {
      file: 'client.bpmn.js',
      bytes: chunkSize.raw,
      gzipBytes: chunkSize.gzip,
      sha256: sha256Hex(bundles.outputs['client.bpmn.js']),
      inputs: chunkInputs,
      modules: bundles.modules['client.bpmn.js'],
    },
  ]
  const inputEntries = collectBuildInputs(
    root,
    [...new Set([...mainInputs, ...chunkInputs])],
    { outputInputs: { 'client.js': mainInputs, 'client.bpmn.js': chunkInputs } },
  )
  const inputsHash = hashInputManifest(inputEntries)
  writeFileSync(resolve(libDir, BUILD_META_FILE), `${JSON.stringify({
    schemaVersion: BUILD_META_SCHEMA_VERSION,
    generator: 'scripts/build.mjs',
    generatedAt: new Date().toISOString(),
    inputsHash,
    inputs: inputEntries,
    outputs,
  }, null, 2)}\n`)
  console.log(
    `✓ 写出 lib/${BUILD_META_FILE}：inputsHash=${inputsHash.slice(0, 12)}…（${inputEntries.length} 个输入文件），`
    + `2 个产物已绑定字节数与 sha256`,
  )
}
// 只在被直接执行时构建；被 verify-build.mjs / 测试 import 时保持纯函数，不产生副作用。
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  await buildPlugin()
}
