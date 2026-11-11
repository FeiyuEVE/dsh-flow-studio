#!/usr/bin/env node
/**
 * 发布前校验（只读）：lib/ 必须是 src/ 的逐字节副本，且 .js 集合与 build.mjs 的模块清单一致。
 *
 *   node scripts/verify-build.mjs [repoRoot]
 *
 * 它与 `node scripts/build.mjs` 末尾的门禁共用同一份清单与同一套比对逻辑
 * （都从 scripts/build.mjs import），所以不会出现「两份清单各自漂移」。
 * 用途：不重建、只核对当前 lib 是不是陈旧产物；退出码 0 = 一致，1 = 有问题。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import {
  HOST_MODULES,
  GENERATED_MODULES,
  EXPECTED_LIB_MODULES,
  auditLibModules,
  compareHostModules,
} from './build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '..')

const problems = []

if (HOST_MODULES.length === 0) {
  problems.push('build.mjs 的 Host 模块清单为空')
}

// ① lib/ 的 .js 集合与清单一一对应（缺失 / 多余都算问题；多余文件只报告不删除）。
const audit = auditLibModules(root)
if (audit.absent.length > 0) problems.push(`清单里有但 lib/ 缺失：${audit.absent.join(', ')}`)
if (audit.extras.length > 0) {
  problems.push(`lib/ 里有清单未声明的多余文件（请人工确认是否遗留）：${audit.extras.join(', ')}`)
}
if (audit.actual.length !== EXPECTED_LIB_MODULES.length) {
  problems.push(
    `lib/ 下 .js 数量 ${audit.actual.length} ≠ 清单 ${EXPECTED_LIB_MODULES.length}`
    + `（Host ${HOST_MODULES.length} + 生成 ${GENERATED_MODULES.length}）`,
  )
}

// ② src ↔ lib 逐字节比对。
const comparison = compareHostModules(root)
for (const item of comparison.missing) problems.push(`${item} 缺失`)
for (const item of comparison.mismatches) {
  problems.push(
    `lib/${item.file} 与 src/${item.file} 不一致`
    + `（src ${item.srcSize} 字节 / lib ${item.libSize} 字节，首个不同字节 @${item.firstDiff}）`,
  )
}

// ③ 两个生成产物必须按宿主协议注册：主包是 factory，chunk 带固定 chunk 名。
//    这一步不重建，只核对眼前这份 lib —— 防止「构建脚本改了、产物还是旧形状」。
const generated = {}
for (const file of GENERATED_MODULES) {
  const path = resolve(root, 'lib', file)
  if (!existsSync(path)) {
    problems.push(`lib/${file} 缺失（生成产物）`)
    continue
  }
  generated[file] = readFileSync(path, 'utf8')
}
const clientSource = generated['client.js']
if (clientSource !== undefined) {
  if (!clientSource.includes('@feiyueve/dsh-flow-studio')) problems.push('lib/client.js 缺注册 id')
  if (!/factory:\s*\(require\)/.test(clientSource)) problems.push('lib/client.js 缺 factory')
  if (clientSource.includes("chunk: 'client.bpmn.js'")) problems.push('lib/client.js 不应带 chunk 字段（它是主包）')
}
const chunkSource = generated['client.bpmn.js']
if (chunkSource !== undefined) {
  if (!chunkSource.includes('@feiyueve/dsh-flow-studio')) problems.push('lib/client.bpmn.js 缺注册 id')
  if (!chunkSource.includes("chunk: 'client.bpmn.js'")) problems.push("lib/client.bpmn.js 的注册字段不是 chunk: 'client.bpmn.js'")
  if (!/factory:\s*\(require\)/.test(chunkSource)) problems.push('lib/client.bpmn.js 缺 factory')
}

// ④ 依赖归属：主包不得含 bpmn-js / 官方属性面板，chunk 不得含 React Flow。
//    优先读构建留下的 .build-meta.json（按产物记录 inputs）；没有 meta 时退回特征串。
const metaPath = resolve(root, 'lib/.build-meta.json')
if (existsSync(metaPath)) {
  let meta = null
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (error) {
    problems.push(`lib/.build-meta.json 不是合法 JSON：${error.message}`)
  }
  if (meta) {
    const mainInputs = meta['client.js']?.inputs ?? []
    const chunkInputs = meta['client.bpmn.js']?.inputs ?? []
    const heavyInMain = mainInputs.filter(input => /node_modules\/(?:bpmn-js|diagram-js|bpmn-js-properties-panel|@bpmn-io)\//.test(input))
    if (heavyInMain.length > 0) problems.push(`主包混入画布重依赖：${heavyInMain.join(', ')}`)
    const xyflowInChunk = chunkInputs.filter(input => /node_modules\/@xyflow\//.test(input))
    if (xyflowInChunk.length > 0) problems.push(`画布 chunk 混入 React Flow：${xyflowInChunk.join(', ')}`)
  }
}

// ⑤ 体积只报数，不再有自设上限。
for (const file of GENERATED_MODULES) {
  const path = resolve(root, 'lib', file)
  if (!existsSync(path)) continue
  const data = readFileSync(path)
  console.log(`  · lib/${file} raw=${data.length} gzip=${gzipSync(data, { level: 9 }).length}`)
}

// ⑥ package.json 的 main 入口必须真的在 lib/ 里（否则装机后 import 直接失败）。
const pkgPath = resolve(root, 'package.json')
if (!existsSync(pkgPath)) {
  problems.push('package.json 缺失')
} else {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const mainEntry = typeof pkg.main === 'string' ? pkg.main : ''
  if (mainEntry === '') {
    problems.push('package.json 没有 main 字段')
  } else if (!existsSync(resolve(root, mainEntry))) {
    problems.push(`package.json 的 main 入口 ${mainEntry} 在产物里不存在`)
  }
}

if (problems.length > 0) {
  console.error(`✗ 发布前校验失败：\n  ${problems.join('\n  ')}`)
  process.exit(1)
}

console.log(`✓ src ↔ lib 逐字节一致（${HOST_MODULES.length} 个 Host 模块）`)
console.log(`✓ lib/ 下 .js 数量 ${audit.actual.length} 与清单一致（Host ${HOST_MODULES.length} + 生成 ${GENERATED_MODULES.length}）`)
console.log('✓ package.json 的 main 入口存在')
