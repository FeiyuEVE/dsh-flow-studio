#!/usr/bin/env node
/**
 * 发布前校验（不写工作树，但会**独立重建**）：lib/ 必须是当前 src/ 的构建产物，
 * 且依赖归属正确。
 *
 *   node scripts/verify-build.mjs [repoRoot]
 *
 * 判据（缺一不可，没有 --allow-stale 之类的放水开关）：
 *   A. 独立重建 + 逐字节比较（主判据）：用 esbuild `write:false` 按当前源码
 *      （官方 CSS/字体在内存渲染）重建两个客户端包，与 lib/ 里的字节逐一比较。
 *      不一致即失败并指出首个不同字节。构建元数据与字符串特征都不能替代这一条。
 *   B. 依赖归属（模块级）：重建时的 esbuild metafile 记录每个产物真正包含的模块与
 *      字节数；主包不得出现 bpmn-js / diagram-js / @bpmn-io，chunk 不得出现 @xyflow。
 *      同时与 lib/build-meta.json 的 modules 清单交叉核对。
 *   C. 输入绑定：meta.inputsHash 必须等于当前磁盘输入重算的哈希。输入集合 =
 *      src/**、scripts/build*.mjs、package.json / package-lock.json、esbuild 版本、
 *      官方 CSS 与 woff2 字体、以及 esbuild metafile 的打包输入（含 node_modules）。
 *   D. 注册与 factory：**前面的字节/元数据检查全部通过后**，才在受限沙箱里求值
 *      两个产物并执行 factory。自定义 require 只暴露受控模块（react 等），
 *      process / require('process') 不可用；整个 factory 调用带 VM 超时。
 *      提前退出、抛错、超时一律按失败处理，不看进程退出码。
 *
 * meta 缺失、字段缺失、schemaVersion 不符一律失败 —— 不允许静默跳过。
 * 与 `node scripts/build.mjs` 共用构建实现（都从 scripts/build.mjs import）。
 * 退出码 0 = 通过，1 = 有问题。
 */

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
  buildClientBundles,
  compareHostModules,
  collectBuildInputs,
  hashInputManifest,
  findLeakMarkers,
} from './build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '..')

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

// ③ 读取两个生成产物（只读取；factory 要等字节/元数据检查全部通过后才执行）。
const generated = {}
for (const file of GENERATED_MODULES) {
  const buffer = readGenerated(file)
  if (buffer === undefined) continue
  generated[file] = buffer
}

// ④ 依赖归属的内容特征（辅助判据）。模块级判据在独立重建后用 metafile 做，
//    真实 BPMN Modeling 代码可能不含 "bpmn-js" 之类字符串，不能只靠 grep。
//    主包混入 chunk 会命中 bpmn-js / diagram-js / @bpmn-io / --bio-surface / woff2 字体等；
//    chunk 混入旧画布会命中 react-flow__ / @xyflow。
for (const file of GENERATED_MODULES) {
  if (generated[file] === undefined) continue
  const leaks = findLeakMarkers(file, generated[file].toString('utf8'))
  if (leaks.length > 0) problems.push(`lib/${file} 依赖泄漏：命中 ${leaks.join('、')}`)
}

/** 注册代码求值超时：只覆盖同步代码。 */
const REGISTRATION_TIMEOUT_MS = 10000
/** factory 执行超时：VM timeout 覆盖整个同步调用，卡死也按失败处理。 */
const FACTORY_TIMEOUT_MS = 3000
/** factory 允许访问的模块白名单；process / 文件系统 / 子进程一律不在里面。 */
const FACTORY_ALLOWED_MODULES = ['react', 'react-dom', 'react/jsx-runtime']

/**
 * 构造一个**全部对象都由 VM realm 自己创建**的沙箱。
 *
 * 不把任何 host 函数 / 对象传进 context：host 函数可以被
 * `fn.constructor('return process')()` 拿来逃逸回宿主。所以 window、
 * __ModuleLoader__、console、require、React 占位全部在 context 内脚本里创建。
 *
 * @param {string} file 产物文件名（用于错误信息）
 * @returns {object} vm context
 */
function createSandboxContext(file) {
  const context = vm.createContext({}, { name: `lib/${file}` })
  const allowed = FACTORY_ALLOWED_MODULES.join(', ')
  vm.runInContext(`
    globalThis.window = globalThis
    globalThis.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} }
    globalThis.__definition__ = null
    globalThis.window.__ModuleLoader__ = {
      load(definition) { globalThis.__definition__ = definition },
    }
    globalThis.__hostModules__ = {
      react: { createElement: (...args) => args[0] },
      'react-dom': {},
      'react/jsx-runtime': {},
    }
    globalThis.__factoryRequire__ = function (name) {
      if (Object.prototype.hasOwnProperty.call(globalThis.__hostModules__, name)) {
        return globalThis.__hostModules__[name]
      }
      throw new Error(
        ${JSON.stringify(`lib/${file} 的 factory 请求了未授权的宿主模块 `)}
        + JSON.stringify(name)
        + ${JSON.stringify(`（白名单：${allowed}；process / 文件系统不可用）`)},
      )
    }
  `, context, { filename: `lib/${file}#sandbox` })
  return context
}

/**
 * 在独立 VM context 里求值产物，捕获注册定义。
 * 返回 context 供后续 factory 调用复用（同一 context，timeout 才覆盖得到 factory 代码）。
 *
 * @param {string} source 产物源码
 * @param {string} file 产物文件名
 * @returns {{ context: object, definition: object|null }}
 */
function loadRegistration(source, file) {
  const context = createSandboxContext(file)
  vm.runInContext(source, context, { filename: `lib/${file}`, timeout: REGISTRATION_TIMEOUT_MS })
  const definition = vm.runInContext('globalThis.__definition__', context, {
    filename: `lib/${file}#definition`,
  })
  return { context, definition }
}

/** 检查 client.js factory 返回值是不是宿主期望的插件对象。 */
function checkPluginShape(file, plugin) {
  if (plugin === null || typeof plugin !== 'object') {
    problems.push(`lib/${file} 的 factory 返回的不是插件对象（实际：${String(plugin)}）`)
    return
  }
  if (plugin.name !== 'flow-studio') {
    problems.push(`lib/${file} 返回的插件 name 是 ${JSON.stringify(plugin.name)}，应为 flow-studio`)
  }
  if (typeof plugin.apply !== 'function') problems.push(`lib/${file} 返回的插件缺少 apply 方法`)
  if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots')) {
    problems.push(`lib/${file} 返回的插件 inject 不是 ['slots']（实际：${JSON.stringify(plugin.inject)}）`)
  }
}

/** 检查 chunk factory 返回值是不是宿主期望的 exports 形状。 */
function checkChunkShape(file, chunkExports) {
  if (chunkExports === null || typeof chunkExports !== 'object') {
    problems.push(`lib/${file} 的 factory 没有返回 exports 对象（实际：${String(chunkExports)}）`)
    return
  }
  if (typeof chunkExports.mountEditor !== 'function') problems.push(`lib/${file} 的 exports 缺少 mountEditor 函数`)
  if (typeof chunkExports.version !== 'string' || chunkExports.version === '') {
    problems.push(`lib/${file} 的 exports 缺少非空 version 字符串`)
  }
  if (typeof chunkExports.BPMN_EDITOR_CSS !== 'string' || chunkExports.BPMN_EDITOR_CSS === '') {
    problems.push(`lib/${file} 的 exports 缺少 BPMN_EDITOR_CSS 样式字符串`)
  }
}

/**
 * 求值注册 + 形状检查 + 在受限沙箱里执行 factory。
 *
 * factory 的调用被放进 `vm.runInContext('__definition__.factory(__factoryRequire__)')`：
 *   - 同步部分受 timeout 保护（while(true) 会在超时后中止）；
 *   - require 是 context 内创建的函数，只返回白名单占位模块，
 *     `require('process').exit(0)` 会抛错，`process` 在沙箱里不存在；
 *   - 提前退出 / 抛错 / 超时都记成 problems，最终由本脚本非零退出，
 *     不依赖 factory 自己的进程退出码。
 *
 * @param {string} file 产物文件名
 * @param {Buffer} buffer 产物字节
 */
function checkRegistration(file, buffer) {
  const source = buffer.toString('utf8')
  let context
  let definition
  try {
    ({ context, definition } = loadRegistration(source, file))
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
      problems.push(`lib/${file} 不应带 chunk 字段（它是主包，chunk=${JSON.stringify(definition.chunk)}）`)
    }
  } else if (definition.chunk !== 'client.bpmn.js') {
    problems.push(`lib/${file} 的注册字段不是 chunk: 'client.bpmn.js'（实际：${JSON.stringify(definition.chunk)}）`)
  }

  let result
  try {
    result = vm.runInContext('__definition__.factory(__factoryRequire__)', context, {
      filename: `lib/${file}#factory`,
      timeout: FACTORY_TIMEOUT_MS,
    })
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      problems.push(`lib/${file} 的 factory 执行超时（>${FACTORY_TIMEOUT_MS}ms），已中止校验`)
    } else {
      const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
        ? error.message
        : String(error)
      problems.push(`lib/${file} 的 factory 执行失败：${message}`)
    }
    return
  }

  if (file === 'client.js') checkPluginShape(file, result)
  else checkChunkShape(file, result)
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
      if (!Array.isArray(output.modules) || output.modules.length === 0) {
        problems.push(`lib/${BUILD_META_FILE} 的 ${output.file} 缺少 modules 模块清单（依赖归属必须能按模块与字节数核对）`)
      } else {
        const malformedModules = output.modules.filter(item => (
          item === null
          || typeof item !== 'object'
          || typeof item.path !== 'string'
          || item.path === ''
          || !Number.isInteger(item.bytes)
          || item.bytes < 0
        ))
        if (malformedModules.length > 0) {
          problems.push(`lib/${BUILD_META_FILE} 的 ${output.file} modules 有 ${malformedModules.length} 条格式不合法（缺 path/bytes）`)
        }
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

// ⑤ 独立重建 + 逐字节比较（主判据）：不信任 meta 自报的 inputsHash / sha256。
//    用与 npm run build 相同的 buildClientBundles() 在内存里按当前源码重建
//    （官方 CSS/字体现场渲染，不读工作树上可能陈旧的 assets.generated.js），
//    再与 lib/ 的字节逐一比较。改 CSS / 改源码 / 只改 inputsHash / 往主包夹带
//    真实 BPMN 代码，都会在这里变红。
/** 两个 Buffer 首个不同字节的下标；完全相同返回两者长度的最小值。 */
function firstDiffIndex(a, b) {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return i
  }
  return len
}

/** 比较 meta 声明的模块清单与重建 metafile 的模块清单。 */
function diffModuleLists(declared, rebuiltModules) {
  const declaredMap = new Map(declared.map(item => [item.path, item.bytes]))
  const rebuiltMap = new Map(rebuiltModules.map(item => [item.path, item.bytes]))
  return {
    onlyInMeta: [...declaredMap.keys()].filter(path => !rebuiltMap.has(path)).sort(),
    onlyInRebuild: [...rebuiltMap.keys()].filter(path => !declaredMap.has(path)).sort(),
    bytesChanged: [...declaredMap.keys()]
      .filter(path => rebuiltMap.has(path) && rebuiltMap.get(path) !== declaredMap.get(path))
      .sort(),
  }
}

const HEAVY_MODULE_PATTERN = /node_modules\/(?:bpmn-js|diagram-js|bpmn-js-properties-panel|@bpmn-io)\//
const XYFLOW_MODULE_PATTERN = /node_modules\/@xyflow\//

try {
  const rebuilt = await buildClientBundles({ rootDir: root, write: false })
  for (const file of GENERATED_MODULES) {
    const built = rebuilt.outputs[file]
    const actual = generated[file]
    if (actual === undefined) continue
    if (!actual.equals(built)) {
      problems.push(
        `lib/${file} 与独立重建不一致（当前源码重建 ${built.length} 字节 / lib ${actual.length} 字节，`
        + `首个不同字节 @${firstDiffIndex(actual, built)}）；产物不是当前源码的构建结果，或产物被替换`,
      )
    }

    // 模块清单交叉核对：meta.outputs[].modules 必须与重建 metafile 完全一致。
    const declaredOutput = Array.isArray(meta?.outputs)
      ? meta.outputs.find(output => output !== null && typeof output === 'object' && output.file === file)
      : undefined
    if (Array.isArray(declaredOutput?.modules)) {
      const diff = diffModuleLists(declaredOutput.modules, rebuilt.modules[file])
      if (diff.onlyInMeta.length > 0 || diff.onlyInRebuild.length > 0 || diff.bytesChanged.length > 0) {
        const detail = []
        if (diff.onlyInMeta.length > 0) detail.push(`元数据多出 ${diff.onlyInMeta.length} 个：${diff.onlyInMeta.slice(0, MAX_INPUT_DIFF).join(', ')}`)
        if (diff.onlyInRebuild.length > 0) detail.push(`元数据缺少 ${diff.onlyInRebuild.length} 个：${diff.onlyInRebuild.slice(0, MAX_INPUT_DIFF).join(', ')}`)
        if (diff.bytesChanged.length > 0) detail.push(`${diff.bytesChanged.length} 个字节数不同：${diff.bytesChanged.slice(0, MAX_INPUT_DIFF).join(', ')}`)
        problems.push(
          `lib/${file} 的模块清单与独立重建不一致（meta.outputs.modules 不可信）：${detail.join('；')}`,
        )
      }
    }

    // 模块级泄漏断言：用重建 metafile（真正进入产物的模块与字节数），不信任字符串。
    if (file === 'client.js') {
      const heavy = rebuilt.modules[file].filter(item => HEAVY_MODULE_PATTERN.test(item.path))
      if (heavy.length > 0) {
        problems.push(
          `主包重建模块清单含画布重依赖（应只进 chunk）：${heavy
            .slice(0, MAX_INPUT_DIFF)
            .map(item => `${item.path} (${item.bytes} 字节)`)
            .join(', ')}`,
        )
      }
    } else {
      const xyflow = rebuilt.modules[file].filter(item => XYFLOW_MODULE_PATTERN.test(item.path))
      if (xyflow.length > 0) {
        problems.push(`画布 chunk 重建模块清单含 React Flow（旧画布不属于 chunk）：${xyflow.slice(0, MAX_INPUT_DIFF).map(item => item.path).join(', ')}`)
      }
    }
  }
} catch (error) {
  problems.push(`独立重建失败（无法用当前源码验证 lib/，可能是 esbuild/依赖不可用）：${error.message}`)
}

// ⑥ 注册形状与 factory：只有前面的字节 / 元数据 / 模块检查全部通过后才执行。
//    这样损坏或恶意产物没机会用 factory 里的 process.exit(0) 提前结束校验。
if (problems.length === 0) {
  for (const file of GENERATED_MODULES) {
    if (generated[file] === undefined) continue
    try {
      checkRegistration(file, generated[file])
    } catch (error) {
      // 注册对象/返回值若是恶意 Proxy，属性访问也可能抛错；一律按失败处理。
      const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
        ? error.message
        : String(error)
      problems.push(`lib/${file} 注册检查异常：${message}`)
    }
  }
} else {
  console.log('  · 已有阻断问题，跳过 factory 执行（不运行不可信产物）')
}

// ⑦ 体积只报数，不设自设上限（判据是重建字节与模块清单，不是阈值）。
for (const file of GENERATED_MODULES) {
  const buffer = generated[file]
  if (buffer === undefined) continue
  console.log(`  · lib/${file} raw=${buffer.length} gzip=${gzipSync(buffer, { level: 9 }).length} sha256=${sha256Hex(buffer)}`)
}

// ⑧ package.json 的 main 入口必须真的在 lib/ 里（否则装机后 import 直接失败）。
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
console.log(`✓ 输入绑定一致（${meta.inputs.length} 个输入文件，含 src/scripts/锁文件/官方 CSS/字体/依赖文件内容）`)
console.log('✓ 独立重建与 lib/ 逐字节一致：client.js / client.bpmn.js（按当前源码在内存重建，不信任自报哈希）')
for (const output of meta.outputs) {
  console.log(`✓ lib/${output.file} 与元数据逐字节绑定（${output.bytes} 字节 sha256=${output.sha256.slice(0, 12)}…，${output.modules.length} 个模块）`)
}
console.log('✓ 注册形状与 factory 可执行：client.js → flow-studio 插件；client.bpmn.js → exports(mountEditor/version/BPMN_EDITOR_CSS)')
console.log('✓ factory 在受限沙箱执行：require 只暴露白名单模块、process 不可用、带 VM 超时')
console.log('✓ 依赖归属：主包模块清单无 bpmn-js / diagram-js / @bpmn-io；chunk 模块清单无 @xyflow（内容特征为辅助）')
console.log(`✓ src ↔ lib 逐字节一致（${HOST_MODULES.length} 个 Host 模块）`)
console.log(`✓ lib/ 下 .js 数量 ${audit.actual.length} 与清单一致（Host ${HOST_MODULES.length} + 生成 ${GENERATED_MODULES.length}）`)
console.log('✓ package.json 的 main 入口存在')
