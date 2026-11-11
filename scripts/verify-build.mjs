#!/usr/bin/env node
/**
 * 发布前校验（只读，不重建）：lib/ 必须是当前 src/ 的构建产物，且依赖归属正确。
 *
 *   node scripts/verify-build.mjs [repoRoot]
 *
 * 三类判据（缺一不可，没有 --allow-stale 之类的放水开关）：
 *   A. 输入绑定：lib/build-meta.json 记录的 inputsHash，必须等于**当前磁盘输入**重算的哈希。
 *      输入集合 = src/**、scripts/build*.mjs、package.json / package-lock.json、esbuild
 *      自身版本、以及构建时 esbuild metafile 记录的实际打包输入（含 node_modules）。
 *   B. 产物绑定：meta 里每个生成产物的 bytes / sha256，必须与磁盘上的字节完全一致。
 *      字节被换一个、构建后源码又改过，都会在这里失败并点名文件。
 *   C. 行为与归属：在 vm 沙箱里真实求值两个产物，执行 factory 检查返回值；
 *      再按**内容特征**检查依赖泄漏（不依赖可删除的 metadata 字段）。
 *
 * meta 缺失、字段缺失、schemaVersion 不符一律失败 —— 不允许静默跳过。
 * 与 `node scripts/build.mjs` 共用清单与输入哈希实现（都从 scripts/build.mjs import）。
 * 退出码 0 = 通过，1 = 有问题。
 */

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import vm from 'node:vm'

import {
  HOST_MODULES,
  GENERATED_MODULES,
  EXPECTED_LIB_MODULES,
  BUILD_META_FILE,
  BUILD_META_SCHEMA_VERSION,
  auditLibModules,
  compareHostModules,
  collectBuildInputs,
  hashInputManifest,
  findLeakMarkers,
} from './build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '..')
const nodeRequire = createRequire(import.meta.url)

const problems = []
const HEX64 = /^[0-9a-f]{64}$/
/** 输入差异最多点几个文件，避免一次改动刷屏。 */
const MAX_INPUT_DIFF = 8

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** 读取 lib/ 下的生成产物；缺失时记一条可读问题并返回 undefined。 */
function readGenerated(file) {
  const path = resolve(root, 'lib', file)
  if (!existsSync(path)) {
    problems.push(`lib/${file} 缺失（生成产物）`)
    return undefined
  }
  return readFileSync(path)
}

// ① lib/ 的 .js 集合与清单一一对应（缺失 / 多余都算问题；多余文件只报告不删除）。
const audit = auditLibModules(root)
if (HOST_MODULES.length === 0) problems.push('build.mjs 的 Host 模块清单为空')
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

// ② src ↔ lib 逐字节比对（Host 模块的输入绑定）。
const comparison = compareHostModules(root)
for (const item of comparison.missing) problems.push(`${item} 缺失`)
for (const item of comparison.mismatches) {
  problems.push(
    `lib/${item.file} 与 src/${item.file} 不一致`
    + `（src ${item.srcSize} 字节 / lib ${item.libSize} 字节，首个不同字节 @${item.firstDiff}）`,
  )
}

// ③ 真实求值两个产物：注册字段、factory 是否可执行、返回值是不是宿主期望的形状。
//    「只 grep 注册字符串」在这里不成立 —— factory 被改成 return null 也会先通过字符串检查。
function loadRegistration(source, file) {
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition } } },
    console,
  }
  vm.runInNewContext(source, sandbox, { filename: `lib/${file}`, timeout: 10000 })
  return captured
}

function checkRegistration(file, buffer) {
  const source = buffer.toString('utf8')

  let definition
  try {
    definition = loadRegistration(source, file)
  } catch (error) {
    problems.push(`lib/${file} 求值失败（注册形状不可用）：${error.message}`)
    return
  }
  if (definition === null || typeof definition !== 'object') {
    problems.push(`lib/${file} 没有调用 window.__ModuleLoader__.load（或传入的不是对象）`)
    return
  }
  if (definition.id !== '@feiyueve/dsh-flow-studio') {
    problems.push(`lib/${file} 注册 id 是 ${JSON.stringify(definition.id)}，应为 @feiyueve/dsh-flow-studio`)
  }
  if (typeof definition.factory !== 'function') {
    problems.push(`lib/${file} 的 factory 不是函数`)
    return
  }

  if (file === 'client.js') {
    if ('chunk' in definition) {
      problems.push(`lib/client.js 不应带 chunk 字段（它是主包，chunk=${JSON.stringify(definition.chunk)}）`)
    }
    let plugin
    try {
      plugin = definition.factory(nodeRequire)
    } catch (error) {
      problems.push(`lib/client.js 的 factory 执行失败：${error.message}`)
      return
    }
    if (plugin === null || typeof plugin !== 'object') {
      problems.push(`lib/client.js 的 factory 返回的不是插件对象（实际：${String(plugin)}）`)
      return
    }
    if (plugin.name !== 'flow-studio') {
      problems.push(`lib/client.js 返回的插件 name 是 ${JSON.stringify(plugin.name)}，应为 flow-studio`)
    }
    if (typeof plugin.apply !== 'function') problems.push('lib/client.js 返回的插件缺少 apply 方法')
    if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots')) {
      problems.push(`lib/client.js 返回的插件 inject 不是 ['slots']（实际：${JSON.stringify(plugin.inject)}）`)
    }
    return
  }

  if (definition.chunk !== 'client.bpmn.js') {
    problems.push(`lib/client.bpmn.js 的注册字段不是 chunk: 'client.bpmn.js'（实际：${JSON.stringify(definition.chunk)}）`)
  }
  let chunkExports
  try {
    chunkExports = definition.factory(nodeRequire)
  } catch (error) {
    problems.push(`lib/client.bpmn.js 的 factory 执行失败：${error.message}`)
    return
  }
  if (chunkExports === null || typeof chunkExports !== 'object') {
    problems.push(`lib/client.bpmn.js 的 factory 没有返回 exports 对象（实际：${String(chunkExports)}）`)
    return
  }
  if (typeof chunkExports.mountEditor !== 'function') problems.push('lib/client.bpmn.js 的 exports 缺少 mountEditor 函数')
  if (typeof chunkExports.version !== 'string' || chunkExports.version === '') {
    problems.push('lib/client.bpmn.js 的 exports 缺少非空 version 字符串')
  }
  if (typeof chunkExports.BPMN_EDITOR_CSS !== 'string' || chunkExports.BPMN_EDITOR_CSS === '') {
    problems.push('lib/client.bpmn.js 的 exports 缺少 BPMN_EDITOR_CSS 样式字符串')
  }
}

const generated = {}
for (const file of GENERATED_MODULES) {
  const buffer = readGenerated(file)
  if (buffer === undefined) continue
  generated[file] = buffer
  checkRegistration(file, buffer)
}

// ④ 依赖归属（基于真实内容特征，不使用 metadata 作为唯一判据）。
//    主包混入 chunk 会命中 bpmn-js / diagram-js / @bpmn-io / --bio-surface / woff2 字体等；
//    chunk 混入旧画布会命中 react-flow__ / @xyflow。
for (const file of GENERATED_MODULES) {
  if (generated[file] === undefined) continue
  const leaks = findLeakMarkers(file, generated[file].toString('utf8'))
  if (leaks.length > 0) problems.push(`lib/${file} 依赖泄漏：命中 ${leaks.join('、')}`)
}

// ⑤ 构建元数据：输入绑定 + 产物绑定。任何字段缺失都不静默跳过。
const metaPath = resolve(root, 'lib', BUILD_META_FILE)
let meta = null
if (!existsSync(metaPath)) {
  problems.push(
    `lib/${BUILD_META_FILE} 缺失：无法证明产物新鲜（构建成功才会写出它）；请先 npm run build，不接受无元数据的产物`,
  )
} else {
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (error) {
    problems.push(`lib/${BUILD_META_FILE} 不是合法 JSON：${error.message}`)
  }
}

if (meta !== null) {
  if (meta.schemaVersion !== BUILD_META_SCHEMA_VERSION) {
    problems.push(`lib/${BUILD_META_FILE} 的 schemaVersion=${JSON.stringify(meta.schemaVersion)}，应为 ${BUILD_META_SCHEMA_VERSION}（请重新构建）`)
  }
  if (typeof meta.inputsHash !== 'string' || !HEX64.test(meta.inputsHash)) {
    problems.push(`lib/${BUILD_META_FILE} 缺少合法的 inputsHash（64 位十六进制 sha256）`)
  }
  if (!Array.isArray(meta.inputs) || meta.inputs.length === 0) {
    problems.push(`lib/${BUILD_META_FILE} 缺少 inputs 输入清单（不允许省略后静默跳过新鲜度检查）`)
  }
  if (!Array.isArray(meta.outputs) || meta.outputs.length === 0) {
    problems.push(`lib/${BUILD_META_FILE} 缺少 outputs 产物清单`)
  }

  // 产物绑定：meta 必须覆盖两个生成产物，且字节数 / sha256 与磁盘一致。
  if (Array.isArray(meta.outputs)) {
    const declared = new Set()
    for (const output of meta.outputs) {
      if (output === null || typeof output !== 'object' || typeof output.file !== 'string') {
        problems.push(`lib/${BUILD_META_FILE} 的 outputs 里有缺少 file 字段的条目`)
        continue
      }
      if (!GENERATED_MODULES.includes(output.file)) {
        problems.push(`lib/${BUILD_META_FILE} 声明了清单外的产物 ${output.file}`)
        continue
      }
      declared.add(output.file)
      if (!Number.isInteger(output.bytes) || output.bytes < 0) {
        problems.push(`lib/${BUILD_META_FILE} 的 ${output.file} 缺少合法的 bytes`)
      }
      if (typeof output.sha256 !== 'string' || !HEX64.test(output.sha256)) {
        problems.push(`lib/${BUILD_META_FILE} 的 ${output.file} 缺少合法的 sha256`)
      }
      if (!Number.isInteger(output.gzipBytes) || output.gzipBytes < 0) {
        problems.push(`lib/${BUILD_META_FILE} 的 ${output.file} 缺少合法的 gzipBytes`)
      }
      if (!Array.isArray(output.inputs)) {
        problems.push(`lib/${BUILD_META_FILE} 的 ${output.file} 缺少 inputs 依赖清单（不允许省略后静默跳过依赖归属检查）`)
      }

      const buffer = generated[output.file]
      if (buffer === undefined) continue
      const actualSha = sha256Hex(buffer)
      if (buffer.length !== output.bytes) {
        problems.push(
          `lib/${output.file} 大小 ${buffer.length} 字节 ≠ 构建元数据 ${output.bytes} 字节`
          + '（产物被替换，或构建后又被改动）',
        )
      }
      if (actualSha !== output.sha256) {
        problems.push(
          `lib/${output.file} sha256 ${actualSha} 与构建元数据不一致`
          + '（产物不是这份输入构建出来的那一份）',
        )
      }
      const actualGzip = gzipSync(buffer, { level: 9 }).length
      if (actualGzip !== output.gzipBytes) {
        // zlib 实现随 Node 版本可能变，gzip 只作参考；字节与 sha256 一致即产物本身没变。
        console.warn(
          `  ! lib/${output.file} gzip=${actualGzip} 与元数据 ${output.gzipBytes} 不同`
          + '（zlib 版本差异，仅提示；raw 与 sha256 已一致）',
        )
      }
      // 依赖图交叉核对：metadata 里的 input 名单不能出现重依赖（内容特征仍是主判据）。
      if (output.file === 'client.js') {
        const heavy = output.inputs.filter(input => /node_modules\/(?:bpmn-js|diagram-js|bpmn-js-properties-panel|@bpmn-io)\//.test(input))
        if (heavy.length > 0) problems.push(`主包依赖图混入画布重依赖：${heavy.join(', ')}`)
      } else {
        const xyflow = output.inputs.filter(input => /node_modules\/@xyflow\//.test(input))
        if (xyflow.length > 0) problems.push(`画布 chunk 依赖图混入 React Flow：${xyflow.join(', ')}`)
      }
    }
    for (const file of GENERATED_MODULES) {
      if (!declared.has(file)) problems.push(`lib/${BUILD_META_FILE} 的 outputs 缺少产物 ${file}`)
    }
  }

  // 输入绑定：用 meta 记录的输入清单（build 阶段实际读过的文件）重算当前哈希。
  if (Array.isArray(meta.inputs) && meta.inputs.length > 0) {
    const malformed = meta.inputs.filter(entry => (
      entry === null
      || typeof entry !== 'object'
      || typeof entry.path !== 'string'
      || !Number.isInteger(entry.bytes)
      || typeof entry.sha256 !== 'string'
    ))
    if (malformed.length > 0) {
      problems.push(`lib/${BUILD_META_FILE} 的 inputs 有 ${malformed.length} 条格式不合法（缺 path/bytes/sha256）`)
    } else {
      const currentInputs = collectBuildInputs(
        root,
        meta.inputs.map(entry => entry.path),
        { strict: false },
      )
      for (const entry of currentInputs) {
        if (entry.sha256 === 'missing') {
          problems.push(`构建输入缺失：${entry.path}（构建元数据记录过它，磁盘上已不存在）`)
        }
      }
      const currentHash = hashInputManifest(currentInputs)
      if (currentHash !== meta.inputsHash) {
        const expectedMap = new Map(meta.inputs.map(entry => [entry.path, entry]))
        const actualMap = new Map(currentInputs.map(entry => [entry.path, entry]))
        const changed = [...expectedMap.keys()]
          .filter(path => actualMap.has(path) && actualMap.get(path).sha256 !== 'missing' && actualMap.get(path).sha256 !== expectedMap.get(path).sha256)
          .sort()
        const added = [...actualMap.keys()].filter(path => !expectedMap.has(path)).sort()
        const removed = [...expectedMap.keys()]
          .filter(path => !actualMap.has(path) || actualMap.get(path).sha256 === 'missing')
          .sort()
        const detail = []
        if (changed.length > 0) detail.push(`修改 ${changed.length} 个：${changed.slice(0, MAX_INPUT_DIFF).join(', ')}${changed.length > MAX_INPUT_DIFF ? ' …' : ''}`)
        if (added.length > 0) detail.push(`新增 ${added.length} 个：${added.slice(0, MAX_INPUT_DIFF).join(', ')}${added.length > MAX_INPUT_DIFF ? ' …' : ''}`)
        if (removed.length > 0) detail.push(`删除 ${removed.length} 个：${removed.slice(0, MAX_INPUT_DIFF).join(', ')}${removed.length > MAX_INPUT_DIFF ? ' …' : ''}`)
        problems.push(
          `构建输入已变化（inputsHash 不匹配：当前 ${currentHash.slice(0, 12)}… / 元数据 ${meta.inputsHash.slice(0, 12)}…）；`
          + `${detail.length > 0 ? detail.join('；') : '输入清单内容不同'}；产物已过期，请重新 npm run build`,
        )
      }
    }
  }
}

// ⑥ 体积只报数，不设自设上限（判据是 sha256 与内容特征，不是阈值）。
for (const file of GENERATED_MODULES) {
  const buffer = generated[file]
  if (buffer === undefined) continue
  console.log(`  · lib/${file} raw=${buffer.length} gzip=${gzipSync(buffer, { level: 9 }).length} sha256=${sha256Hex(buffer)}`)
}

// ⑦ package.json 的 main 入口必须真的在 lib/ 里（否则装机后 import 直接失败）。
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

console.log(`✓ 构建元数据完整：schemaVersion=${meta.schemaVersion} inputsHash=${meta.inputsHash}`)
console.log(`✓ 输入绑定一致（${meta.inputs.length} 个输入文件，含 src/scripts/锁文件/依赖文件内容）`)
for (const output of meta.outputs) {
  console.log(`✓ lib/${output.file} 与元数据逐字节绑定（${output.bytes} 字节 sha256=${output.sha256.slice(0, 12)}…）`)
}
console.log('✓ 注册形状与 factory 可执行：client.js → flow-studio 插件；client.bpmn.js → exports(mountEditor/version/BPMN_EDITOR_CSS)')
console.log('✓ 依赖归属：主包无 bpmn-js/官方属性面板内容特征；chunk 无 React Flow 内容特征')
console.log(`✓ src ↔ lib 逐字节一致（${HOST_MODULES.length} 个 Host 模块）`)
console.log(`✓ lib/ 下 .js 数量 ${audit.actual.length} 与清单一致（Host ${HOST_MODULES.length} + 生成 ${GENERATED_MODULES.length}）`)
console.log('✓ package.json 的 main 入口存在')
