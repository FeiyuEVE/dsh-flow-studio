#!/usr/bin/env node
/**
 * 构建 lib/：客户端走**两次显式 esbuild**打成两个产物，Host 侧模块原样复制。
 *
 *   src/client/entry.js     -> lib/client.js       （主包，factory 返回 createPlugin）
 *   src/client/bpmn/entry.js -> lib/client.bpmn.js （chunk，chunk: 'client.bpmn.js'）
 *   src/index.js            -> lib/index.js           （唯一 Host 入口：定义域 / 实例域）
 *   其余 src/*.js（BPMN 运行时、存储、适配器、工具）逐字节原样拷贝到 lib/。
 *
 * 0.14.0 起旧运行域（flows / runs / engine / xstate / executor…）已删除，
 * HOST_MODULES 只列当前仍存在的模块；LEGACY_HOST_MODULES 供打包测试做「零残留」断言。
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

import { spawnSync } from 'node:child_process'
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
  'index.js',
  'storage-contract.js',
  'node-check.js',
  'definition-store.js',
  'instance-store.js',
  'instance-owner.js',
  'instance-resources.js',
  'workspace-policy.js',
  'instance-worktree.js',
  'instance-message-store.js',
  'instance-inbox.js',
  'instance-tools.js',
  'artifact-store.js',
  'execution-limits.js',
  'process-output.js',
  'agent-cli-stream.js',
  'agent-cli-lifecycle.js',
  'host-check.js',
  'bpmn-moddle-vendor.js',
  'feelin-vendor.js',
  'zeebe-moddle-vendor.js',
  'bpmn-moddle.js',
  'bpmn-expr.js',
  'bpmn-parse.js',
  'bpmn-policy.js',
  'bpmn-state.js',
  'bpmn-runner.js',
  'bpmn-runtime.js',
  'http-policy.js',
  'http-connector.js',
  'connector-store.js',
  'node-finish.js',
  'node-finish-mcp.js',
  'instance-metrics.js',
  'instance-evidence.js',
  'agent-telemetry.js',
  'claude-usage-ledger.js',
  'agent-adapter.js',
  'agent-adapter-dsh.js',
  'agent-adapter-codex.js',
  'agent-adapter-claude.js',
  'agent-execute.js',
]

/**
 * 0.14.0 退役的旧运行域模块。它们**不得**出现在 lib/ 或 npm 包里；
 * build.test.mjs 用这份清单对 tarball 做「旧模块一个都没有」的断言。
 *
 * 只用于测试断言与文档，不参与构建拷贝。
 */
export const LEGACY_HOST_MODULES = [
  'engine',
  'runtime',
  'tools',
  'supervise',
  'worktree',
  'inbox',
  'runlog',
  'runstore',
  'flowmachine',
  'xstate-vendor',
  'node-tools',
  'restart',
  'resume',
  'admission',
  'audit',
  'executor',
  'model',
  'store',
  'flowdir',
  'bpmn-convert',
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
 * 0.14.0：旧 React Flow 画布已删除，主包与 chunk 都不得再出现 React Flow / @xyflow。
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
    ['React Flow 样式类名 react-flow__', /react-flow__/],
    ['@xyflow 依赖标记', /@xyflow\//],
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

// ---- factory 隔离执行（verify-build.mjs 专用） ---------------------------------
// 背景（0.13.6 复审 F4）：factory 是不可信代码。0.13.5 在**当前进程**里用 vm 跑它，
// 于是有两个洞：
//   ① `vm.createContext({})` 的全局对象继承宿主 Object.prototype，
//      `globalThis.constructor.constructor('return process')()` 拿到了真实 process；
//   ② 形状检查 / 属性读取 / JSON 序列化都在 vm 之外做，一个无限循环的 `name`
//      getter 就能越过 vm 的 3s 超时把整个校验挂住。
// 现在改成**独立子进程**：父进程把产物源码通过 stdin 交给子进程，子进程在自己的
// 硬超时（SIGKILL）内用无宿主对象的 VM realm 完成「注册 → factory → 返回值检查 →
// 序列化」，只往 stdout 写一行带完成标记的 JSON。父进程只认这一行结构化结果：
// 子进程退出码 0 本身（例如逃逸后 process.exit(0)）一律判失败。

/** 完整完成标记：父进程只接受带它的一行 JSON，退出码不构成通过。 */
export const FACTORY_CHECK_MARKER = 'dsh-flow-studio.factory-check.v1'
/** 注册代码求值超时（子进程内 VM，只覆盖同步代码）。 */
export const FACTORY_REGISTRATION_TIMEOUT_MS = 10000
/** factory 调用 + 返回值属性读取 + 序列化，整体受同一个 VM 超时保护。 */
export const FACTORY_CALL_TIMEOUT_MS = 3000
/** 子进程外部硬超时：VM 超时失效或进程卡死时由父进程 SIGKILL。 */
export const FACTORY_CHILD_TIMEOUT_MS = 15000
/** factory 允许访问的模块白名单；process / 文件系统 / 子进程一律不在里面。 */
export const FACTORY_ALLOWED_MODULES = ['react', 'react-dom', 'react/jsx-runtime']

/**
 * factory 校验子进程入口。**必须以函数源码形式**在子进程 `node -e` 里执行
 * （见 runFactoryCheckInChild）：只从 stdin 读 JSON 请求、往 stdout 写一行 JSON，
 * 不引用父进程的任何对象，也不 import 本模块。
 */
function factoryCheckChildMain() {
  const fs = require('node:fs')
  const vm = require('node:vm')

  /** 同步写 stdout 后立即退出：factory 残留的微任务 / 定时器挂不住进程。 */
  const write = payload => {
    fs.writeSync(1, JSON.stringify(payload) + '\n')
    process.exit(0)
  }

  /**
   * 子进程宿主侧的错误只可能来自 vm 本身（语法错误 / 超时）。
   * 其他错误对象属于 realm，一律不在宿主侧读属性 —— 那会绕过超时。
   */
  const describeHostError = error => {
    if (error instanceof SyntaxError) return error.message
    return '无法安全格式化子进程异常（已拒绝访问跨 realm 错误对象）'
  }

  let request
  try {
    request = JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch {
    write({ marker: 'invalid-request', file: null, done: false, problems: ['子进程读不到合法的 JSON 请求'] })
    return
  }

  const reply = extra => write({
    marker: request.marker,
    file: request.file,
    done: true,
    problems: [],
    ...extra,
  })

  /**
   * 在 VM realm 内执行：所有对象（window / console / loader / require / 模块表）
   * 都由 realm 自己创建，绝不把宿主对象或宿主函数放进 context —— 宿主函数被
   * `fn.constructor('return process')()` 借道正是 0.13.5 的逃逸面。
   *
   * 额外关闭动态代码生成（eval / new Function / 各种构造器），把「用字符串造函数」
   * 这条路也从根上封死。
   */
  function bootstrap(allowed) {
    // 在被校验代码（注册源码 / factory）运行之前捕获判定要用的内建函数，放进
    // 不可写、不可配置、已冻结的全局通道。之后 factory 改写 JSON.stringify /
    // Array.isArray / Function.prototype.call 或替换这个全局属性，都影响不到
    // 判定与结果通道（复审 N2）。
    var caps = Object.create(null)
    caps.stringify = JSON.stringify
    caps.isArray = Array.isArray
    caps.includes = Function.prototype.call.bind(Array.prototype.includes)
    Object.freeze(caps)
    Object.defineProperty(globalThis, '__check_caps__', {
      value: caps,
      writable: false,
      configurable: false,
      enumerable: false,
    })
    globalThis.window = globalThis
    globalThis.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} }
    globalThis.__definition__ = null
    globalThis.window.__ModuleLoader__ = {
      load(definition) { globalThis.__definition__ = definition },
    }
    var modules = Object.create(null)
    modules.react = { createElement(tag) { return tag } }
    modules['react-dom'] = Object.create(null)
    modules['react/jsx-runtime'] = Object.create(null)
    globalThis.__hostModules__ = modules
    globalThis.__factoryRequire__ = function (name) {
      if (typeof name === 'string' && name in modules) return modules[name]
      throw new Error('未授权的宿主模块 ' + String(name) + '（白名单：' + allowed + '；process / 文件系统不可用）')
    }
  }

  /**
   * 在 realm 内完成全部判定：读注册对象、调 factory、读返回对象属性。
   *
   * 判定与结果通道只用 bootstrap 提前捕获的引用，且**只返回原始字符串**：
   * `''` = 没有发现问题，非空 = 逐行问题。不在这里做 JSON 序列化，也不把问题
   * 数组交给任何可被 factory 改写的方法 —— factory 改 JSON.stringify /
   * Array.prototype.toJSON / 全局 JSON 都伪造不出「通过」（复审 N2）。
   * 无限 getter / 恶意 Proxy 仍由同一个 VM 超时覆盖。
   */
  function checker(kind) {
    var caps = globalThis.__check_caps__
    if (caps === null || typeof caps !== 'object') {
      return '校验通道缺失（bootstrap 未建立受保护的内建函数引用）'
    }
    var problemsText = ''
    var addProblem = function (message) {
      problemsText += (problemsText === '' ? '' : '\n') + message
    }
    var describe = function (error) {
      try {
        if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
      } catch (_) {}
      return '无法格式化的异常'
    }
    var safeJson = function (value) {
      try { return caps.stringify(value) } catch (_) { return '[不可序列化]' }
    }
    var withHint = function (error, message) {
      try {
        if (error !== null && typeof error === 'object' && error.name === 'EvalError') {
          return message + '（VM 沙箱禁止动态代码生成，process 不可达）'
        }
      } catch (_) {}
      return message
    }
    try {
      var definition = globalThis.__definition__
      if (definition === null || typeof definition !== 'object') {
        addProblem('没有调用 window.__ModuleLoader__.load（或传入的不是对象）')
        return problemsText
      }
      try {
        if (definition.id !== '@feiyueve/dsh-flow-studio') {
          addProblem('注册 id 是 ' + safeJson(definition.id) + '，应为 @feiyueve/dsh-flow-studio')
        }
      } catch (error) {
        addProblem('读取注册 id 失败：' + describe(error))
      }
      var factory
      try {
        factory = definition.factory
      } catch (error) {
        addProblem('读取 factory 失败：' + describe(error))
      }
      if (typeof factory !== 'function') {
        addProblem('factory 不是函数')
        return problemsText
      }
      try {
        if (kind === 'plugin') {
          if ('chunk' in definition) {
            addProblem('不应带 chunk 字段（它是主包，chunk=' + safeJson(definition.chunk) + '）')
          }
        } else if (definition.chunk !== 'client.bpmn.js') {
          addProblem('注册字段不是 chunk: \'client.bpmn.js\'（实际：' + safeJson(definition.chunk) + '）')
        }
      } catch (error) {
        addProblem('读取 chunk 字段失败：' + describe(error))
      }
      var result
      try {
        result = factory(globalThis.__factoryRequire__)
      } catch (error) {
        addProblem(withHint(error, 'factory 执行失败：' + describe(error)))
        return problemsText
      }
      if (kind === 'plugin') {
        if (result === null || typeof result !== 'object') {
          addProblem('factory 返回的不是插件对象（实际：' + safeJson(result) + '）')
          return problemsText
        }
        try {
          if (result.name !== 'flow-studio') {
            addProblem('返回的插件 name 是 ' + safeJson(result.name) + '，应为 flow-studio')
          }
          if (typeof result.apply !== 'function') addProblem('返回的插件缺少 apply 方法')
          if (caps.isArray(result.inject) !== true || caps.includes(result.inject, 'slots') !== true) {
            addProblem('返回的插件 inject 不是 [\'slots\']（实际：' + safeJson(result.inject) + '）')
          }
        } catch (error) {
          addProblem('检查插件返回值失败：' + describe(error))
        }
      } else {
        if (result === null || typeof result !== 'object') {
          addProblem('factory 没有返回 exports 对象（实际：' + safeJson(result) + '）')
          return problemsText
        }
        try {
          if (typeof result.mountEditor !== 'function') addProblem('factory 返回的 exports 缺少 mountEditor 函数')
          if (typeof result.version !== 'string' || result.version === '') {
            addProblem('factory 返回的 exports 缺少非空 version 字符串')
          }
          if (typeof result.BPMN_EDITOR_CSS !== 'string' || result.BPMN_EDITOR_CSS === '') {
            addProblem('factory 返回的 exports 缺少 BPMN_EDITOR_CSS 样式字符串')
          }
        } catch (error) {
          addProblem('检查 exports 返回值失败：' + describe(error))
        }
      }
      return problemsText
    } catch (error) {
      return '注册检查异常：' + describe(error)
    }
  }

  const timeoutCode = 'ERR_SCRIPT_EXECUTION_TIMEOUT'
  const isTimeout = error => error !== null && typeof error === 'object' && error.code === timeoutCode

  // null 原型 context：全局对象的原型链不再挂到宿主 Object.prototype 上，
  // `globalThis.constructor.constructor` 只能拿到 realm 自己的 Function（且被禁用）。
  const context = vm.createContext(Object.create(null), {
    name: 'lib/' + request.file,
    codeGeneration: { strings: false, wasm: false },
  })

  try {
    vm.runInContext(
      '(' + bootstrap.toString() + ')(' + JSON.stringify(request.allowed.join(', ')) + ')',
      context,
      { filename: 'lib/' + request.file + '#sandbox', timeout: request.registrationTimeoutMs },
    )
  } catch (error) {
    reply({ problems: ['沙箱初始化失败：' + describeHostError(error)] })
    return
  }

  // 产物源码整段包进 realm 内的 try/catch：注册阶段抛错也由 realm 自己格式化。
  // 注册阶段的错误也只用原始字符串回传：不经过可被注册源码改写的 JSON.stringify。
  const registrationScript = '(function () {\n'
    + 'var describe = function (error) {\n'
    + '  try { if (error !== null && typeof error === "object" && typeof error.message === "string") return error.message } catch (_) {}\n'
    + '  return "[无法格式化的异常]"\n'
    + '}\n'
    + 'try {\n'
    + request.source
    + '\n} catch (error) {\n'
    + 'return describe(error)\n'
    + '}\n'
    + 'return null\n'
    + '})()'

  let registrationMessage = null
  try {
    const registrationReport = vm.runInContext(registrationScript, context, {
      filename: 'lib/' + request.file,
      timeout: request.registrationTimeoutMs,
    })
    if (typeof registrationReport === 'string') registrationMessage = registrationReport
  } catch (error) {
    if (isTimeout(error)) {
      reply({ problems: ['注册代码求值超时（>' + request.registrationTimeoutMs + 'ms），已中止校验'] })
      return
    }
    reply({ problems: ['求值失败（注册形状不可用）：' + describeHostError(error)] })
    return
  }
  if (registrationMessage !== null) {
    reply({ problems: ['求值失败（注册形状不可用）：' + registrationMessage] })
    return
  }

  let rawReport
  try {
    rawReport = vm.runInContext('(' + checker.toString() + ')(' + JSON.stringify(request.kind) + ')', context, {
      filename: 'lib/' + request.file + '#factory',
      timeout: request.factoryTimeoutMs,
    })
  } catch (error) {
    if (isTimeout(error)) {
      reply({ problems: ['factory 执行超时（>' + request.factoryTimeoutMs + 'ms），已中止校验'] })
      return
    }
    reply({ problems: ['注册检查异常：' + describeHostError(error)] })
    return
  }

  // 校验结果通道只接受原始字符串：'' = 通过，非空 = 逐行问题。
  // 这里用宿主自己的 split / JSON.stringify 组装输出，realm 里的篡改影响不到。
  if (typeof rawReport !== 'string') {
    reply({ problems: ['校验结果通道被篡改：期望原始字符串，实际是 ' + typeof rawReport] })
    return
  }
  const problems = rawReport === ''
    ? []
    : rawReport.split('\n').filter(item => item !== '')
  if (rawReport !== '' && problems.length === 0) {
    reply({ problems: ['校验结果通道被篡改：非空结果里没有可读问题'] })
    return
  }
  reply({ problems })
}

/**
 * 判定子进程结果：只接受**恰好一行**带完成标记的 JSON。
 * 退出码 0 不是判据 —— 子进程被逃逸代码 process.exit(0) 提前结束、
 * 或只输出半截内容，都按失败处理。
 *
 * @param {string} file 产物文件名
 * @param {object} result spawnSync 的返回值（测试可传等价对象）
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function parseFactoryCheckChildOutput(file, result) {
  if (result === null || typeof result !== 'object') {
    return { ok: false, problems: ['factory 检查子进程没有返回结果'] }
  }
  if (result.error !== undefined && result.error !== null) {
    if (result.error.code === 'ETIMEDOUT') {
      return {
        ok: false,
        problems: [`factory 检查子进程超时（>${FACTORY_CHILD_TIMEOUT_MS}ms），已强制终止并判定失败`],
      }
    }
    const reason = typeof result.error.message === 'string' ? result.error.message : String(result.error.code)
    return { ok: false, problems: [`factory 检查子进程启动/运行失败：${reason}`] }
  }
  if (result.signal) {
    return { ok: false, problems: [`factory 检查子进程被信号 ${result.signal} 终止，没有完成校验`] }
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const trimmed = stdout.trim()
  if (trimmed === '') {
    return {
      ok: false,
      problems: [`factory 检查子进程没有输出校验结果（退出码 ${String(result.status)} 不被采信；退出码 0 不算通过）`],
    }
  }
  if (trimmed.includes('\n')) {
    return { ok: false, problems: ['factory 检查子进程输出多于一行，拒绝以部分输出判定通过'] }
  }
  let payload
  try {
    payload = JSON.parse(trimmed)
  } catch {
    return { ok: false, problems: ['factory 检查子进程输出不是合法 JSON（没有完整校验标记）'] }
  }
  if (payload === null || typeof payload !== 'object'
    || payload.marker !== FACTORY_CHECK_MARKER
    || payload.done !== true
    || payload.file !== file
    || !Array.isArray(payload.problems)
    || payload.problems.some(item => typeof item !== 'string')) {
    return { ok: false, problems: ['factory 检查子进程缺少完整的校验结果标记（退出码 0 不算通过）'] }
  }
  return { ok: true, problems: payload.problems }
}

/**
 * 在独立子进程里执行一次 factory 校验，返回结构化判定。
 * 子进程带外部硬超时（FACTORY_CHILD_TIMEOUT_MS，超时 SIGKILL），
 * 父进程只解析 stdout 上的完成标记，不看退出码。
 *
 * 返回的 `ok` 表示「子进程给出了可信的完整结果」，不是「factory 检查通过」：
 * 检查发现的问题在 problems 里，调用方必须把它们一律当作失败。
 *
 * @param {string} file 产物文件名
 * @param {Buffer} buffer 产物字节
 * @param {{rootDir?: string}} [options]
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function runFactoryCheckInChild(file, buffer, options = {}) {
  const { rootDir = root } = options
  const request = JSON.stringify({
    marker: FACTORY_CHECK_MARKER,
    file,
    kind: file === 'client.js' ? 'plugin' : 'chunk',
    allowed: FACTORY_ALLOWED_MODULES,
    registrationTimeoutMs: FACTORY_REGISTRATION_TIMEOUT_MS,
    factoryTimeoutMs: FACTORY_CALL_TIMEOUT_MS,
    source: buffer.toString('utf8'),
  })
  const child = spawnSync(process.execPath, ['-e', `(${factoryCheckChildMain.toString()})()`], {
    cwd: rootDir,
    input: request,
    encoding: 'utf8',
    // 外部截止时间：VM 超时失效时（例如宿主侧属性访问被挂住）也一定能收场。
    timeout: FACTORY_CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    // 父进程的 NODE_OPTIONS（可能带 --require 之类）不能钻进隔离进程。
    env: { ...process.env, NODE_OPTIONS: '' },
  })
  return parseFactoryCheckChildOutput(file, child)
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
  // 0.14.0：旧 React Flow 画布已退役，主包里再出现它的特征串就是回潮。
  if (client.includes('react-flow__')) {
    console.error('✗ lib/client.js 里出现了已退役的 React Flow 特征串 react-flow__')
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
