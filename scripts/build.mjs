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
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  keepNames: true,
  legalComments: 'none',
  charset: 'utf8',
  banner: { js: '// Generated from src/client/* via `node scripts/build.mjs` (esbuild). Do not edit directly.' },
  metafile: true,
  logLevel: 'warning',
})

const clientSize = statSync(resolve(libDir, 'client.js')).size
console.log(`src/client/entry.js -> lib/client.js ${clientSize} bytes`)
if (clientSize > 262144) {
  console.error(`✗ lib/client.js 超过 262144 字节（${clientSize}），DSH 的 STORE 单文件上限装不下`)
  process.exit(1)
}
console.log('✓ lib/client.js 在 DSH STORE 单文件上限（262144）内')

for (const file of ['index.js', 'model.js', 'store.js', 'runlog.js', 'runstore.js']) {
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
console.log('✓ client bundle 含 __ModuleLoader__ 与正确的注册 id')

// 打包输入清单留个痕，便于核对产物由哪些源文件构成。
const inputs = Object.keys(result.metafile.inputs)
writeFileSync(resolve(libDir, '.build-inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`)
console.log(`✓ 记录了 ${inputs.length} 个打包输入`)
