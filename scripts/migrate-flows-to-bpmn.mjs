#!/usr/bin/env node
/**
 * 旧流程模板 → BPMN 定义的一次性迁移 CLI（0.13.0）。
 *
 * 输入：`<DSH_HOME>/flow-studio/flows/<id>.json`（0.12 及更早的旧模板）。
 * 输出：`<DSH_HOME>/flow-studio/definitions/<id>/<version>.bpmn`（不可变版本域），
 * 以及归档目录里的原 JSON + 一份 `migration-report.json`。
 *
 * 口径（与 `src/bpmn-convert.js` / `src/bpmn-parse.js` / `src/definition-store.js` 对齐）：
 * - definition id **就是**旧流程文件名去 `.json`（稳定、可追溯）；
 * - 每个文件先 `convertLegacyFlow()`，再 `parseBpmn()` 复核；任一步失败 → `skipped`，
 *   原文件留在 flows 目录（坏流程等人看，绝不猜、不归档）；
 * - 保存后 `readDefinition` + `readDefinitionVersion` 回读，要求「meta 记录 hash =
 *   parseBpmn 的 definition.hash = sha256(xml)」三者一致，否则记 `failed`；
 * - definition 里已有**同 hash** 版本 → `unchanged`：不新增版本、不重复归档；
 * - 归档只 rename，不删除；同名冲突退 `*.json.bak-<时间戳>`，绝不覆盖。
 *
 * 默认 **dry-run**：只读 + 打印计划，不建目录、不移动文件、不写 store。
 * 只有显式 `--apply` 才真的迁移。
 *
 * 退出码：0 = 全部成功（含 unchanged）；1 = 有 skipped / failed；2 = 参数或路径错误。
 *
 * 运行：node scripts/migrate-flows-to-bpmn.mjs [--flows <dir>] [--definitions <dir>]
 *         [--archive <dir>] [--apply]
 *
 * @module scripts/migrate-flows-to-bpmn
 */

import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  mkdir, readFile, readdir, rename, stat, unlink, writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { convertLegacyFlow } from '../src/bpmn-convert.js'
import { parseBpmn } from '../src/bpmn-parse.js'
import {
  readDefinition, readDefinitionVersion, saveDefinitionVersion,
} from '../src/definition-store.js'
import { checkRunId } from '../src/runlog.js'
import { flowsDir, resolveHome } from '../src/store.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const TOOL = 'migrate-flows-to-bpmn'
const REPORT_FILE = 'migration-report.json'
const DEFAULT_ARCHIVE_DIRNAME = 'flows-archive-0.12'
const REPORT_VERSION = 1

/** 与 definition-store 的 meta 上限同口径（超长时截断并记 warning）。 */
const MAX_NAME_CHARS = 200
const MAX_DESCRIPTION_CHARS = 2000

const STATUSES = ['migrated', 'unchanged', 'skipped', 'failed']

const USAGE = `用法：node scripts/migrate-flows-to-bpmn.mjs [选项]

把旧流程模板（<DSH_HOME>/flow-studio/flows/<id>.json）一次性迁移成 BPMN 定义：
每个 JSON → convertLegacyFlow() → parseBpmn() 复核 → 存成
<definitions>/<id>/<版本>.bpmn（definition id = 旧流程文件名去 .json）。
迁移成功后再把原 JSON 移到归档目录，并写一份 ${REPORT_FILE}。

默认 dry-run：只读 + 打印计划，不创建目录、不移动文件、不写定义域。

选项：
  --flows <dir>        旧流程 JSON 目录（默认 <DSH_HOME>/flow-studio/flows）
  --definitions <dir>  定义域根目录（默认与 flows 同级的 definitions/）
  --archive <dir>      旧 JSON 归档目录（默认与 flows 同级的 ${DEFAULT_ARCHIVE_DIRNAME}/；
                       dry-run 时不创建）
  --apply              真的执行迁移（写定义、移动原文件、写报告）
  -h, --help           显示本帮助

报告：每次 --apply 都会重写 <archive>/migration-report.json（记录**本次**运行）；
历次迁移的定义版本与归档 JSON 本身都不受影响。

环境变量：
  DSH_HOME             未给 --flows 时的根目录（默认 ~/.dsh）

文件状态：
  migrated   已写入新版本并归档
  unchanged  definition 里已有同 hash 版本（不新增版本、不重复归档）
  skipped    无法转换/解析（原文件留在 flows 目录，需要人处理）
  failed     保存/回读校验/归档失败（原文件不会被删除）

退出码：0 全部成功（含 unchanged）；1 有 skipped 或 failed；2 参数/路径错误。
`

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

class UsageError extends Error {}

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')

const shortHash = hash => (typeof hash === 'string' ? `${hash.slice(0, 12)}…` : '—')

/** 归档备份后缀用的本地时间戳：`20261111-181945`。 */
function stampNow(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 按码点截断（不劈裂代理对）；超长时返回 `{ value, truncated }`。 */
function truncateChars(value, max) {
  const chars = [...String(value)]
  if (chars.length <= max) return { value: String(value), truncated: false }
  return { value: chars.slice(0, max).join(''), truncated: true }
}

function isInside(child, parent) {
  const rel = relative(parent, child)
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** 统一成 `{ code, message, ...可选定位字段 }`，报告里不塞未知形状。 */
function toDiagnostic(item) {
  if (!item || typeof item !== 'object') return { code: 'UNKNOWN', message: String(item) }
  const diagnostic = {
    code: typeof item.code === 'string' ? item.code : 'UNKNOWN',
    message: typeof item.message === 'string' ? item.message : JSON.stringify(item),
  }
  for (const key of ['nodeId', 'edgeId', 'flowId', 'field']) {
    if (typeof item[key] === 'string') diagnostic[key] = item[key]
  }
  return diagnostic
}

function formatDiagnostics(items, limit = 3) {
  const shown = items.slice(0, limit).map(item => `${item.code}: ${item.message}`)
  const rest = items.length - shown.length
  return rest > 0 ? `${shown.join('；')}（另有 ${rest} 条）` : shown.join('；')
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

async function readPluginVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* 参数与路径                                                                  */
/* -------------------------------------------------------------------------- */

/** @returns {{ help: boolean, apply: boolean, flows: string|null, definitions: string|null, archive: string|null }} */
function parseArgs(argv) {
  const parsed = { help: false, apply: false, flows: null, definitions: null, archive: null }
  const takeValue = (name, inline, argvList, index) => {
    if (inline !== null) {
      if (inline.trim() === '') throw new UsageError(`${name} 需要一个非空目录参数`)
      return { value: inline, nextIndex: index }
    }
    const next = argvList[index + 1]
    if (next === undefined || next.startsWith('--')) throw new UsageError(`${name} 需要一个目录参数`)
    return { value: next, nextIndex: index + 1 }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    let name = raw
    let inline = null
    if (raw.startsWith('--') && raw.includes('=')) {
      const at = raw.indexOf('=')
      name = raw.slice(0, at)
      inline = raw.slice(at + 1)
    }
    switch (name) {
      case '--help':
      case '-h':
        if (inline !== null) throw new UsageError(`${name} 不接受参数值`)
        parsed.help = true
        break
      case '--apply':
        if (inline !== null) throw new UsageError('--apply 不接受参数值')
        parsed.apply = true
        break
      case '--flows':
      case '--definitions':
      case '--archive': {
        const { value, nextIndex } = takeValue(name, inline, argv, index)
        index = nextIndex
        parsed[name.slice(2)] = value
        break
      }
      default:
        throw new UsageError(`未知参数：${raw}`)
    }
  }
  return parsed
}

function resolveConfig(parsed) {
  const home = resolveHome(process.env)
  const flowsPath = resolve(parsed.flows || flowsDir(home))
  const sibling = dirname(flowsPath)
  const definitionsRoot = resolve(parsed.definitions || join(sibling, 'definitions'))
  const archiveDir = resolve(parsed.archive || join(sibling, DEFAULT_ARCHIVE_DIRNAME))

  if (flowsPath === definitionsRoot || flowsPath === archiveDir) {
    throw new UsageError('--flows 不能与 --definitions / --archive 是同一个目录')
  }
  if (definitionsRoot === archiveDir) {
    throw new UsageError('--definitions 与 --archive 不能是同一个目录')
  }
  if (isInside(archiveDir, flowsPath)) {
    throw new UsageError('--archive 不能放在 flows 目录里面（否则下次运行会把归档当成旧流程再迁一遍）')
  }
  if (isInside(definitionsRoot, flowsPath)) {
    throw new UsageError('--definitions 不能放在 flows 目录里面')
  }
  if (isInside(flowsPath, definitionsRoot) || isInside(flowsPath, archiveDir)) {
    throw new UsageError('--flows 不能放在 --definitions / --archive 目录里面')
  }
  return {
    home,
    flowsPath,
    definitionsRoot,
    archiveDir,
    apply: parsed.apply === true,
  }
}

/* -------------------------------------------------------------------------- */
/* 目录扫描                                                                    */
/* -------------------------------------------------------------------------- */

async function listFlowFiles(flowsPath) {
  let info
  try {
    info = await stat(flowsPath)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new UsageError(`flows 目录不存在：${flowsPath}`)
    }
    throw error
  }
  if (!info.isDirectory()) throw new UsageError(`flows 路径不是目录：${flowsPath}`)

  const names = await readdir(flowsPath)
  const files = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (!name.endsWith('.json')) continue
    const filePath = join(flowsPath, name)
    const fileInfo = await stat(filePath)
    if (!fileInfo.isFile()) continue
    files.push(filePath)
  }
  files.sort((a, b) => a.localeCompare(b, 'en'))
  return files
}

/** 归档目录里的旧 JSON（排除迁移报告与 `*.json.bak-*` 备份），用于重跑时识别「已迁移」。 */
async function listArchiveFiles(archiveDir) {
  let names
  try {
    names = await readdir(archiveDir)
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (name === REPORT_FILE) continue
    if (!name.endsWith('.json')) continue
    const filePath = join(archiveDir, name)
    const fileInfo = await stat(filePath)
    if (!fileInfo.isFile()) continue
    files.push(filePath)
  }
  files.sort((a, b) => a.localeCompare(b, 'en'))
  return files
}

/* -------------------------------------------------------------------------- */
/* 单个文件的迁移计划                                                          */
/* -------------------------------------------------------------------------- */

function metaFor(legacy, id, warnings) {
  const rawName = typeof legacy.name === 'string' ? legacy.name.trim() : ''
  const nameSource = rawName === '' ? id : rawName
  const name = truncateChars(nameSource, MAX_NAME_CHARS)
  if (name.truncated) {
    warnings.push({
      code: 'NAME_TRUNCATED',
      message: `旧流程 name 超过 ${MAX_NAME_CHARS} 字符，已截断后写入 meta`,
    })
  }
  const meta = { name: name.value }
  const rawDescription = typeof legacy.description === 'string' ? legacy.description.trim() : ''
  if (rawDescription !== '') {
    const description = truncateChars(rawDescription, MAX_DESCRIPTION_CHARS)
    if (description.truncated) {
      warnings.push({
        code: 'DESCRIPTION_TRUNCATED',
        message: `旧流程 description 超过 ${MAX_DESCRIPTION_CHARS} 字符，已截断后写入 meta`,
      })
    }
    meta.description = description.value
  }
  return { meta, name: name.value }
}

/**
 * 读一个旧 JSON 并给出迁移计划（不做任何写入）。
 *
 * @param {{ filePath: string, source: 'flows'|'archive', definitionsRoot: string }} input
 */
async function planRecord({ filePath, source, definitionsRoot }) {
  const file = basename(filePath)
  const id = file.slice(0, -'.json'.length)
  const record = {
    id,
    file,
    source,
    path: filePath,
    status: 'skipped',
    legacyName: null,
    hash: null,
    bytes: null,
    version: null,
    warnings: [],
    errors: [],
    archivedTo: null,
    archivedAs: null,
    note: null,
    // 只在内存里用，不写进报告。
    xml: null,
    metaSpec: null,
  }

  if (!checkRunId(id)) {
    record.errors.push({
      code: 'INVALID_ID',
      message: `「${id}」不是合法的 definition id（只允许字母/数字/点/下划线/连字符，不以点开头，≤64 字符），无法作为定义 id。`,
    })
    return record
  }

  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    record.status = 'failed'
    record.errors.push({ code: 'FLOW_READ_FAILED', message: `读取旧流程失败：${error.message}` })
    return record
  }
  record.bytes = Buffer.byteLength(text, 'utf8')

  let legacy
  try {
    legacy = JSON.parse(text)
  } catch (error) {
    record.errors.push({ code: 'LEGACY_JSON_INVALID', message: `旧流程不是合法 JSON：${error.message}` })
    return record
  }
  record.legacyName = typeof legacy?.name === 'string' ? legacy.name : null

  const converted = convertLegacyFlow(legacy)
  for (const warning of converted.warnings || []) record.warnings.push(toDiagnostic(warning))
  if (!converted.ok) {
    for (const error of converted.errors || []) record.errors.push(toDiagnostic(error))
    if (record.errors.length === 0) {
      record.errors.push({ code: 'LEGACY_CONVERT_FAILED', message: 'convertLegacyFlow 返回 ok:false 但没有给出错误明细。' })
    }
    return record
  }

  const parsed = await parseBpmn(converted.xml)
  for (const warning of parsed.warnings || []) record.warnings.push(toDiagnostic(warning))
  if (!parsed.ok) {
    for (const error of parsed.errors || []) record.errors.push(toDiagnostic(error))
    if (record.errors.length === 0) {
      record.errors.push({ code: 'BPMN_PARSE_FAILED', message: 'parseBpmn 返回 ok:false 但没有给出错误明细。' })
    }
    return record
  }

  const hash = sha256(converted.xml)
  record.hash = hash
  record.xml = converted.xml
  if (parsed.definition?.hash !== hash) {
    record.status = 'failed'
    record.errors.push({
      code: 'HASH_MISMATCH',
      message: `parseBpmn 给出的 definition.hash（${parsed.definition?.hash}）与 sha256(xml)（${hash}）不一致。`,
    })
    return record
  }

  const { meta, name } = metaFor(legacy, id, record.warnings)
  record.metaSpec = meta
  record.legacyName = name

  let existing
  try {
    existing = await readDefinition(id, { definitionsRoot })
  } catch (error) {
    record.status = 'failed'
    record.errors.push({
      code: error?.code || 'DEFINITION_READ_FAILED',
      message: `读取定义 ${id} 失败：${error?.reason || error?.message || String(error)}`,
    })
    return record
  }

  const match = existing?.versions.find(item => item.hash === hash) || null
  if (match) {
    record.status = 'unchanged'
    record.version = match.version
    record.note = source === 'archive'
      ? '原文件已不在 flows 目录（已在 archive 目录）；definition 已有同 hash 版本，不重复归档'
      : 'definition 里已有同 hash 版本；不新增版本、不归档'
    return record
  }

  record.status = 'migrated'
  return record
}

/* -------------------------------------------------------------------------- */
/* 执行（--apply）                                                             */
/* -------------------------------------------------------------------------- */

/** 回读校验：meta 记录 hash = definition.hash = 磁盘 sha256，且回读 XML 仍能解析。 */
async function verifyReadback({ id, hash, version, definitionsRoot }) {
  const meta = await readDefinition(id, { definitionsRoot })
  if (!meta) throw new Error(`回读失败：定义 ${id} 在保存后不存在`)
  const entry = meta.versions.find(item => item.version === version)
  if (!entry) throw new Error(`回读失败：定义 ${id} 的 meta 里没有 v${version}`)
  if (entry.hash !== hash) {
    throw new Error(`回读 hash 不一致：meta 记录 ${entry.hash}，期望 ${hash}`)
  }
  if (meta.latestVersion === version && meta.latestHash !== hash) {
    throw new Error(`回读 hash 不一致：meta.latestHash ${meta.latestHash}，期望 ${hash}`)
  }

  const read = await readDefinitionVersion(id, version, { definitionsRoot })
  if (!read) throw new Error(`回读失败：定义 ${id} 的 v${version} 读不到`)
  if (read.hash !== hash) throw new Error(`回读 hash 不一致：readDefinitionVersion 返回 ${read.hash}，期望 ${hash}`)
  const diskHash = sha256(read.xml)
  if (diskHash !== hash) throw new Error(`回读 hash 不一致：磁盘 XML sha256 ${diskHash}，期望 ${hash}`)

  const reparsed = await parseBpmn(read.xml)
  if (!reparsed.ok) {
    throw new Error(`回读的 XML 无法被 parseBpmn 重新解析：${formatDiagnostics(reparsed.errors.map(toDiagnostic))}`)
  }
  if (reparsed.definition?.hash !== hash) {
    throw new Error(`回读的 XML 重新解析 hash ${reparsed.definition?.hash} 与期望 ${hash} 不一致`)
  }
}

/** 归档目标名：绝不覆盖；同名退 `*.json.bak-<时间戳>`。 */
async function nextArchiveName(archiveDir, name) {
  if (!(await pathExists(join(archiveDir, name)))) return name
  const stamp = stampNow()
  let candidate = `${name}.bak-${stamp}`
  for (let counter = 1; await pathExists(join(archiveDir, candidate)); counter += 1) {
    if (counter > 100) throw new Error(`归档目录里 ${name} 的备份文件过多，停止自动取名`)
    candidate = `${name}.bak-${stamp}-${counter}`
  }
  return candidate
}

async function archiveFlowFile(flowPath, archiveDir) {
  const name = basename(flowPath)
  await mkdir(archiveDir, { recursive: true, mode: 0o700 })
  const targetName = await nextArchiveName(archiveDir, name)
  const target = join(archiveDir, targetName)
  await rename(flowPath, target)
  return { target, targetName }
}

async function applyRecord(record, config) {
  if (record.status === 'skipped' || record.status === 'failed') {
    return record
  }

  // unchanged：仍然回读校验，确认 definition 里那份真的可读且 hash 对得上。
  if (record.status === 'unchanged') {
    try {
      await verifyReadback({
        id: record.id,
        hash: record.hash,
        version: record.version,
        definitionsRoot: config.definitionsRoot,
      })
    } catch (error) {
      record.status = 'failed'
      record.note = null
      record.errors.push({ code: 'VERIFY_FAILED', message: error.message })
    }
    return record
  }

  let saved
  try {
    saved = await saveDefinitionVersion(record.id, record.xml, record.metaSpec, {
      definitionsRoot: config.definitionsRoot,
    })
    record.version = saved.version
    if (saved.hash !== record.hash) {
      throw new Error(`saveDefinitionVersion 返回的 hash ${saved.hash} 与 sha256(xml) ${record.hash} 不一致`)
    }
    await verifyReadback({
      id: record.id,
      hash: record.hash,
      version: saved.version,
      definitionsRoot: config.definitionsRoot,
    })
  } catch (error) {
    record.status = 'failed'
    record.errors.push({
      code: error?.code || 'SAVE_FAILED',
      message: `写入定义 ${record.id} 失败：${error?.reason || error?.message || String(error)}`,
    })
    return record
  }

  // 归档来源（flows 里已经没有这份 JSON）只补写/修复定义，绝不再移动归档文件本身。
  if (record.source === 'archive') {
    record.note = '源文件已在 archive 目录，本次只补写 definition，不再移动归档文件'
    return record
  }

  try {
    const { target, targetName } = await archiveFlowFile(record.path, config.archiveDir)
    record.archivedTo = target
    record.archivedAs = targetName
  } catch (error) {
    record.status = 'failed'
    record.errors.push({
      code: 'ARCHIVE_FAILED',
      message: `定义已写入 v${record.version}，但原文件归档失败（原文件仍在 flows 目录）：${error?.reason || error?.message || String(error)}`,
    })
  }
  return record
}

/* -------------------------------------------------------------------------- */
/* 输出与报告                                                                  */
/* -------------------------------------------------------------------------- */

function summarize(records) {
  const summary = { total: records.length }
  for (const status of STATUSES) summary[status] = 0
  for (const record of records) {
    summary[record.status] = (summary[record.status] || 0) + 1
  }
  return summary
}

const LINE_LABELS = {
  apply: { migrated: '迁移成功', unchanged: '未变', skipped: '跳过', failed: '失败' },
  dryRun: { migrated: '计划迁移', unchanged: '未变', skipped: '跳过', failed: '失败' },
}

function lineFor(record, { apply }) {
  const warnings = record.warnings.length > 0 ? `，警告 ${record.warnings.length} 条` : ''
  const labels = apply ? LINE_LABELS.apply : LINE_LABELS.dryRun
  const label = labels[record.status] || record.status

  switch (record.status) {
    case 'migrated': {
      const name = record.metaSpec ? `「${record.metaSpec.name}」` : ''
      const version = record.version ? ` v${record.version}` : ''
      const archive = record.archivedTo
        ? ` → 归档 ${record.archivedAs}`
        : (apply ? '' : '（apply 时归档）')
      const note = record.note ? `（${record.note}）` : ''
      return `[${label}] ${record.file} → 定义 ${record.id}${version}${name}（hash ${shortHash(record.hash)}${warnings}）${archive}${note}`
    }
    case 'unchanged': {
      const where = record.source === 'archive' ? '（源文件不在 flows，已在 archive）' : '（原文件仍在 flows，保持不动）'
      return `[${label}] ${record.file} → 定义 ${record.id} 已有同 hash v${record.version}，不新增版本、不归档${where}`
    }
    case 'skipped':
      return `[${label}] ${record.file} — ${formatDiagnostics(record.errors)}（原文件保留在 ${record.source === 'flows' ? 'flows' : 'archive'} 目录，未归档）`
    case 'failed':
      return `[${label}] ${record.file} — ${formatDiagnostics(record.errors)}`
    default:
      return `[${record.status}] ${record.file}`
  }
}

function recordToReport(record) {
  return {
    id: record.id,
    file: record.file,
    source: record.source,
    status: record.status,
    version: record.version,
    hash: record.hash,
    bytes: record.bytes,
    warnings: record.warnings,
    errors: record.errors,
    archivedTo: record.archivedTo,
    archivedAs: record.archivedAs,
    note: record.note,
  }
}

function buildReport({ config, records, startedAt, pluginVersion }) {
  return {
    reportVersion: REPORT_VERSION,
    tool: TOOL,
    pluginVersion,
    generatedAt: new Date().toISOString(),
    startedAt,
    mode: 'apply',
    flowsDir: config.flowsPath,
    definitionsRoot: config.definitionsRoot,
    archiveDir: config.archiveDir,
    summary: summarize(records),
    files: records.map(recordToReport),
  }
}

async function writeReport(archiveDir, report) {
  await mkdir(archiveDir, { recursive: true, mode: 0o700 })
  const target = join(archiveDir, REPORT_FILE)
  const tmp = `${target}.tmp-${process.pid}`
  try {
    await writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, target)
  } finally {
    await unlink(tmp).catch(() => {})
  }
  return target
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

async function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    console.error(`参数错误：${error.message}`)
    console.error('')
    console.error(USAGE)
    return 2
  }
  if (parsed.help) {
    console.log(USAGE)
    return 0
  }

  let config
  try {
    config = resolveConfig(parsed)
  } catch (error) {
    console.error(`参数错误：${error.message}`)
    console.error('')
    console.error(USAGE)
    return 2
  }

  const startedAt = new Date().toISOString()
  const apply = config.apply
  console.log(`${apply ? '模式：--apply（会写定义、移动原文件、写报告）' : '模式：dry-run（只读计划；加 --apply 才会真的迁移）'}`)
  console.log(`  flows:       ${config.flowsPath}`)
  console.log(`  definitions: ${config.definitionsRoot}`)
  console.log(`  archive:     ${config.archiveDir}`)
  console.log('')

  let flowFiles
  try {
    flowFiles = await listFlowFiles(config.flowsPath)
  } catch (error) {
    console.error(`无法扫描 flows 目录：${error.message}`)
    return 2
  }
  const archiveFiles = await listArchiveFiles(config.archiveDir)

  const seenIds = new Set(flowFiles.map(filePath => basename(filePath).slice(0, -'.json'.length)))
  const records = []
  for (const filePath of flowFiles) {
    records.push(await planRecord({ filePath, source: 'flows', definitionsRoot: config.definitionsRoot }))
  }
  // 重跑时的另一半：flows 已经空了，但 archive 里还有上次归档的 JSON。
  for (const filePath of archiveFiles) {
    const id = basename(filePath).slice(0, -'.json'.length)
    if (seenIds.has(id)) continue
    records.push(await planRecord({ filePath, source: 'archive', definitionsRoot: config.definitionsRoot }))
  }

  if (apply) {
    for (const record of records) {
      await applyRecord(record, config)
    }
  }

  if (records.length === 0) {
    console.log('没有找到任何旧流程 JSON（flows 与 archive 目录都是空的）。')
  } else if (flowFiles.length === 0) {
    console.log('flows 目录里没有 JSON；下面是对 archive 目录中已归档文件的复核：')
  }
  for (const record of records) console.log(lineFor(record, { apply }))

  const summary = summarize(records)
  console.log('')
  console.log(`汇总：migrated ${summary.migrated} / unchanged ${summary.unchanged} / skipped ${summary.skipped} / failed ${summary.failed}（共 ${summary.total} 个）`)
  if (!apply) {
    console.log('dry-run：未写任何文件（未创建目录、未移动文件、未写 store）。')
  } else {
    const pluginVersion = await readPluginVersion()
    const report = buildReport({ config, records, startedAt, pluginVersion })
    const reportPath = await writeReport(config.archiveDir, report)
    console.log(`迁移报告：${reportPath}`)
  }

  return summary.skipped > 0 || summary.failed > 0 ? 1 : 0
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = code
}).catch(error => {
  console.error(`迁移中断：${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
})
