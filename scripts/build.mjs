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
 *
 * 产物可复现：同样的 src 打出来的 lib 字节相同（除 esbuild 版本差异）。
 */

import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
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

for (const file of ['index.js', 'model.js', 'store.js', 'runlog.js', 'runstore.js', 'engine.js']) {
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

// 打包输入清单留个痕，便于核对产物由哪些源文件构成。
const inputs = Object.keys(result.metafile.inputs)
writeFileSync(resolve(libDir, '.build-inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`)
console.log(`✓ 记录了 ${inputs.length} 个打包输入`)
