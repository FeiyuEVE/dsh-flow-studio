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
 *   C. 输入绑定：meta.inputs 的**每一条**都要与磁盘重算的 {bytes, sha256} 一致，
 *      inputsHash 必须等于当前磁盘输入重算的哈希；声明集合还必须与「重建 metafile
 *      的实际打包输入 + 资源输入」完全相同（缺项 / 多项都失败）。输入集合 =
 *      src/**、scripts/build*.mjs、package.json / package-lock.json、esbuild 版本、
 *      官方 CSS 与 woff2 字体、以及 esbuild metafile 的打包输入（含 node_modules）。
 *   D. 注册与 factory：**前面的字节/元数据检查全部通过后**，才在**独立子进程**里
 *      求值两个产物并执行 factory。子进程内用无宿主对象的 VM realm（null 原型
 *      context + 禁止动态代码生成），自定义 require 只暴露受控模块（react 等），
 *      process / require('process') 不可用；属性读取、序列化、错误格式化全在
 *      该 realm 内完成。子进程带外部硬超时（超时 SIGKILL），父进程只认 stdout 上
 *      带完成标记的完整 JSON —— 退出码 0 本身不算通过（逃逸后 process.exit(0)
 *      会被判失败）。
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
  runFactoryCheckInChild,
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

/**
 * 求值注册 + 形状检查 + 执行 factory —— 全部在**独立子进程**里完成（0.13.6 复审 F4）。
 *
 * 父进程只拿到子进程 stdout 上的一行结构化 JSON：属性读取、序列化、错误格式化
 * 都在子进程的受限 VM realm 里发生（无限 getter 因此同样受 VM 超时保护），
 * 子进程本身还有外部硬超时（超时 SIGKILL）。最终判定只认带完成标记的完整
 * 结果 —— 子进程退出码 0（例如逃逸后 process.exit(0)）一律不算通过。
 *
 * @param {string} file 产物文件名
 * @param {Buffer} buffer 产物字节
 */
function checkRegistration(file, buffer) {
  const result = runFactoryCheckInChild(file, buffer, { rootDir: root })
  for (const problem of result.problems) problems.push(`lib/${file} ${problem}`)
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
      || entry.path === ''
      || !Number.isInteger(entry.bytes)
      || entry.bytes < 0
      || typeof entry.sha256 !== 'string'
      || !HEX64.test(entry.sha256)
    ))
    if (malformed.length > 0) {
      problems.push(`lib/${BUILD_META_FILE} 的 inputs 有 ${malformed.length} 条格式不合法（缺 path/bytes/64 位 sha256）`)
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

      // 条目自校验（0.13.6 复审 f1）：每条声明都必须和**从磁盘重算**的
      // {bytes, sha256} 一致。只比对 aggregate hash 会漏掉「改单条哈希、
      // 保留旧 inputsHash」这种伪造。
      const currentMap = new Map(currentInputs.map(entry => [entry.path, entry]))
      const declaredPaths = meta.inputs.map(entry => entry.path)
      const duplicates = [...new Set(declaredPaths.filter((path, index) => declaredPaths.indexOf(path) !== index))]
      if (duplicates.length > 0) {
        problems.push(
          `lib/${BUILD_META_FILE} 的 inputs 有重复条目：${duplicates.slice(0, MAX_INPUT_DIFF).join(', ')}`
          + `${duplicates.length > MAX_INPUT_DIFF ? ' …' : ''}`,
        )
      }
      const checked = new Set()
      for (const entry of meta.inputs) {
        if (checked.has(entry.path)) continue
        checked.add(entry.path)
        const actual = currentMap.get(entry.path)
        if (actual === undefined || actual.sha256 === 'missing') continue
        if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
          problems.push(
            `输入清单条目与磁盘不一致：${entry.path}`
            + `（声明 ${entry.bytes} 字节 / sha256 ${entry.sha256.slice(0, 12)}…，`
            + `实际 ${actual.bytes} 字节 / sha256 ${actual.sha256.slice(0, 12)}…）；`
            + '逐条声明必须由构建真实写出，不能事后伪造',
          )
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

  // 输入清单完整性（0.13.6 复审 f1）：声明的输入集合必须与「重建 metafile 的
  // 实际打包输入 + 资源输入 + 源码/脚本/清单扫描」完全一致；缺项 / 多项都失败。
  // 只重算 aggregate hash 不够 —— 删掉一条依赖输入再重算哈希，旧口径仍然自洽。
  if (Array.isArray(meta?.inputs) && meta.inputs.length > 0) {
    const declaredPaths = meta.inputs
      .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
      .map(entry => entry.path)
    const bundled = [...new Set([...rebuilt.inputs['client.js'], ...rebuilt.inputs['client.bpmn.js']])]
    const authoritative = collectBuildInputs(root, bundled, { outputInputs: rebuilt.inputs })
    const authoritativePaths = new Set(authoritative.map(entry => entry.path))
    const declaredSet = new Set(declaredPaths)
    const missing = [...authoritativePaths].filter(path => !declaredSet.has(path)).sort()
    const extra = [...declaredSet].filter(path => !authoritativePaths.has(path)).sort()
    if (missing.length > 0 || extra.length > 0) {
      const detail = []
      if (missing.length > 0) {
        detail.push(
          `清单缺少 ${missing.length} 个：${missing.slice(0, MAX_INPUT_DIFF).join(', ')}`
          + `${missing.length > MAX_INPUT_DIFF ? ' …' : ''}`,
        )
      }
      if (extra.length > 0) {
        detail.push(
          `清单多出 ${extra.length} 个：${extra.slice(0, MAX_INPUT_DIFF).join(', ')}`
          + `${extra.length > MAX_INPUT_DIFF ? ' …' : ''}`,
        )
      }
      problems.push(
        `构建输入集合与独立重建不一致（meta.inputs 不可信）：${detail.join('；')}；`
        + '声明集合必须与「重建 metafile 实际输入 + 资源输入」完全一致',
      )
    }
  }
} catch (error) {
  problems.push(`独立重建失败（无法用当前源码验证 lib/，可能是 esbuild/依赖不可用）：${error.message}`)
}

// ⑥ 注册形状与 factory：只有前面的字节 / 元数据 / 模块检查全部通过后才执行。
//    子进程只在这是「干净的当前构建」时才拿到产物源码；即使它被逃逸代码
//    process.exit(0) 提前结束，也拿不到完成标记，父进程仍然判失败。
if (problems.length === 0) {
  for (const file of GENERATED_MODULES) {
    if (generated[file] === undefined) continue
    try {
      checkRegistration(file, generated[file])
    } catch (error) {
      // 例如子进程根本起不来（spawn 失败）：一律按失败处理。
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
console.log(`✓ 输入绑定一致（${meta.inputs.length} 个输入文件逐条与磁盘一致，且与重建输入集合完全相同；含 src/scripts/锁文件/官方 CSS/字体/依赖文件内容）`)
console.log('✓ 独立重建与 lib/ 逐字节一致：client.js / client.bpmn.js（按当前源码在内存重建，不信任自报哈希）')
for (const output of meta.outputs) {
  console.log(`✓ lib/${output.file} 与元数据逐字节绑定（${output.bytes} 字节 sha256=${output.sha256.slice(0, 12)}…，${output.modules.length} 个模块）`)
}
console.log('✓ 注册形状与 factory 可执行：client.js → flow-studio 插件；client.bpmn.js → exports(mountEditor/version/BPMN_EDITOR_CSS)')
console.log('✓ factory 在独立子进程里执行：require 只暴露白名单模块、process 不可达、属性读取/序列化同受 VM 超时，父进程只认带完成标记的结构化结果')
console.log('✓ 依赖归属：主包模块清单无 bpmn-js / diagram-js / @bpmn-io；chunk 模块清单无 @xyflow（内容特征为辅助）')
console.log(`✓ src ↔ lib 逐字节一致（${HOST_MODULES.length} 个 Host 模块）`)
console.log(`✓ lib/ 下 .js 数量 ${audit.actual.length} 与清单一致（Host ${HOST_MODULES.length} + 生成 ${GENERATED_MODULES.length}）`)
console.log('✓ package.json 的 main 入口存在')
