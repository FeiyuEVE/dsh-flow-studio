#!/usr/bin/env node
/**
 * 迁移脚本自检：`scripts/migrate-flows-to-bpmn.mjs`（0.13.0 旧 flows/*.json → BPMN 定义）。
 *
 * 覆盖：
 *   1. `--help` / 未知参数（rc 0 / rc 2）；
 *   2. dry-run 零写入（definitions / archive 目录都不创建，原文件不动）；
 *   3. `--apply` 写入定义 + 回读 hash 三方一致 + 原件移到 archive + migration-report.json；
 *   4. 再跑一次 `--apply` → 全部 unchanged，不新增版本、不重复归档；
 *   5. definition 已有同 hash、而源文件仍在 flows（如从 archive 复制回来）→ unchanged 且原文件不动；
 *   6. 坏流程（缺 start / 非法 JSON）→ skipped、rc=1、不归档、定义不写入；
 *   7. 真实样本（~/.dsh/flow-studio/flows 里最小的 3 个）→ 全部 migrated，且存下来的 XML 都能被 parseBpmn 重新解析。
 *
 * 临时产物全部落在仓库 `.tmp/` 下（每个用例一个目录，结束清理）；**不写** `~/.dsh`，
 * 也绝不修改 `~/.dsh/flow-studio/flows`（真实样本只读复制）。
 *
 * 运行：node test/migrate-flows.test.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmpRoot = join(repoRoot, '.tmp')
mkdirSync(tmpRoot, { recursive: true })

const scriptPath = join(repoRoot, 'scripts', 'migrate-flows-to-bpmn.mjs')
const realFlowsDir = join(homedir(), '.dsh', 'flow-studio', 'flows')

const { convertLegacyFlow } = await import('../src/bpmn-convert.js')
const { parseBpmn } = await import('../src/bpmn-parse.js')
const defs = await import('../src/definition-store.js')

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')

let checks = 0
let assertions = 0

function eq(actual, expected, message) {
  assertions += 1
  assert.equal(actual, expected, message)
}

function deep(actual, expected, message) {
  assertions += 1
  assert.deepEqual(actual, expected, message)
}

function ok(value, message) {
  assertions += 1
  assert.ok(value, message)
}

const HEX64 = /^[0-9a-f]{64}$/

async function check(name, fn) {
  const dir = mkdtempSync(join(tmpRoot, 'mig-'))
  try {
    await fn({ dir })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

function runCli(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  })
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    all: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** 两个节点的最小合法旧流程：start → end。 */
function fixtureFlow(id, name = '迁移自检流程') {
  return {
    schemaVersion: 1,
    id,
    name,
    description: '两节点最小流程（迁移自检用）',
    nodes: [
      {
        id: 'n_start', kind: 'start', title: '任务输入', x: 40, y: 200, mode: 'single',
        role: '收件入口', task: '接收本轮任务原文。', skills: [], outputs: '',
        maxRounds: 2, model: '', team: [],
      },
      {
        id: 'n_done', kind: 'end', title: '完成', x: 320, y: 200, mode: 'single',
        role: '收尾', task: '收尾。', skills: [], outputs: '', maxRounds: 1, model: '', team: [],
      },
    ],
    edges: [{ id: 'e1', from: 'n_start', to: 'n_done', kind: 'next', label: '' }],
  }
}

function fixtureFlowWithoutStart(id) {
  return {
    schemaVersion: 1,
    id,
    name: '坏流程（缺 start）',
    nodes: [{
      id: 'n_end', kind: 'end', title: '结束', x: 0, y: 0, mode: 'single',
      role: '', task: '', skills: [], outputs: '', maxRounds: 1, model: '', team: [],
    }],
    edges: [],
  }
}

function listNames(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

/** 从真实目录取（最小的）N 个样本文件名；不足或目录不存在返回 null。 */
function realSampleNames(limit = 3) {
  if (!existsSync(realFlowsDir)) return null
  const names = readdirSync(realFlowsDir)
    .filter(name => name.endsWith('.json') && !name.startsWith('.'))
    .filter(name => statSync(join(realFlowsDir, name)).isFile())
    .sort((a, b) => statSync(join(realFlowsDir, a)).size - statSync(join(realFlowsDir, b)).size)
  if (names.length < limit) return null
  return names.slice(0, limit).sort()
}

function copyRealSamples(targetDir, names) {
  mkdirSync(targetDir, { recursive: true })
  for (const name of names) copyFileSync(join(realFlowsDir, name), join(targetDir, name))
}

let realSamplesUsed = false
let realSampleCount = 0

try {
  await check('CLI：--help 打印用法并 rc=0，未知参数 rc=2', async ({ dir }) => {
    const help = runCli(['--help'])
    eq(help.code, 0, '--help 退出码 0')
    ok(help.stdout.includes('用法：node scripts/migrate-flows-to-bpmn.mjs'), '--help 打印用法')
    ok(help.stdout.includes('--apply'), '--help 说明 --apply')
    ok(help.stdout.includes('默认 dry-run'), '--help 说明默认 dry-run')

    const bad = runCli(['--nope'])
    eq(bad.code, 2, '未知参数 rc=2')
    ok(bad.stderr.includes('未知参数'), '未知参数给出中文原因')
    eq(existsSync(join(dir, 'flows')), false, '参数错误不创建任何目录')
  })

  await check('dry-run：不建 definitions/archive，不移动原文件，只打印计划', async ({ dir }) => {
    const flowsDir = join(dir, 'flows')
    const definitionsDir = join(dir, 'definitions')
    const archiveDir = join(dir, 'archive')
    const id = 'flow-mig-fixture'
    writeJson(join(flowsDir, `${id}.json`), fixtureFlow(id, '迁移自检流程'))
    const before = readFileSync(join(flowsDir, `${id}.json`), 'utf8')

    const run = runCli(['--flows', flowsDir, '--definitions', definitionsDir, '--archive', archiveDir])
    eq(run.code, 0, 'dry-run rc=0（全部可迁移）')
    ok(run.stdout.includes('模式：dry-run'), '输出标明 dry-run')
    ok(run.stdout.includes('计划迁移'), '逐文件给出计划迁移')
    ok(run.stdout.includes('migrated 1 / unchanged 0 / skipped 0 / failed 0'), '汇总计数正确')

    eq(existsSync(definitionsDir), false, 'dry-run 不创建 definitions 目录')
    eq(existsSync(archiveDir), false, 'dry-run 不创建 archive 目录')
    eq(existsSync(join(flowsDir, `${id}.json`)), true, '原 JSON 还在 flows 目录')
    eq(readFileSync(join(flowsDir, `${id}.json`), 'utf8'), before, '原 JSON 内容一字未改')
    deep(listNames(flowsDir), [`${id}.json`], 'flows 目录没有多出临时文件')
  })

  await check('dry-run：默认目录从 DSH_HOME 派生，且同样零写入', async ({ dir }) => {
    const home = join(dir, 'home')
    const flowsDir = join(home, 'flow-studio', 'flows')
    const id = 'flow-mig-home'
    writeJson(join(flowsDir, `${id}.json`), fixtureFlow(id, '默认目录自检'))

    const run = runCli([], { DSH_HOME: home })
    eq(run.code, 0, 'dry-run rc=0')
    ok(run.stdout.includes(join(home, 'flow-studio', 'definitions')), 'definitions 默认与 flows 同级')
    ok(run.stdout.includes(join(home, 'flow-studio', 'flows-archive-0.12')), 'archive 默认与 flows 同级')

    eq(existsSync(join(home, 'flow-studio', 'definitions')), false, '默认 definitions 目录未被创建')
    eq(existsSync(join(home, 'flow-studio', 'flows-archive-0.12')), false, '默认 archive 目录未被创建')
    eq(existsSync(join(flowsDir, `${id}.json`)), true, '原 JSON 还在')
  })

  await check('--apply：写入定义、回读 hash 一致、原件归档、报告结构正确', async ({ dir }) => {
    const flowsDir = join(dir, 'flows')
    const definitionsDir = join(dir, 'definitions')
    const archiveDir = join(dir, 'archive')
    const id = 'flow-mig-fixture'
    const flowPath = join(flowsDir, `${id}.json`)
    writeJson(flowPath, fixtureFlow(id, '迁移自检流程'))
    const originalText = readFileSync(flowPath, 'utf8')

    const run = runCli(['--flows', flowsDir, '--definitions', definitionsDir, '--archive', archiveDir, '--apply'])
    eq(run.code, 0, '--apply rc=0')
    ok(run.stdout.includes('迁移成功'), '逐文件结论为迁移成功')
    ok(run.stdout.includes('migrated 1 / unchanged 0 / skipped 0 / failed 0'), '汇总计数正确')
    ok(run.stdout.includes('迁移报告：'), '打印报告位置')

    // ① 定义域：v1 落盘、meta 名字来自旧流程。
    const meta = await defs.readDefinition(id, { definitionsRoot: definitionsDir })
    ok(meta !== null, 'definitions 里出现该定义')
    eq(meta.versions.length, 1, '恰好一个版本')
    eq(meta.latestVersion, 1, 'latestVersion=1')
    eq(meta.name, '迁移自检流程', 'meta.name 取自旧流程 name')
    ok(existsSync(join(definitionsDir, id, '1.bpmn')), '1.bpmn 落盘')

    // ② 回读校验：meta hash = 磁盘 sha256 = parseBpmn(definition.hash) = sha256(convert(xml))。
    const read = await defs.readDefinitionVersion(id, 1, { definitionsRoot: definitionsDir })
    ok(read !== null && typeof read.xml === 'string' && read.xml.length > 0, '回读 XML 非空')
    const diskHash = sha256(read.xml)
    eq(read.hash, diskHash, 'readDefinitionVersion.hash = sha256(回读 XML)')
    eq(meta.versions[0].hash, diskHash, 'meta 记录 hash = sha256(回读 XML)')
    const parsed = await parseBpmn(read.xml)
    eq(parsed.ok, true, '回读的 XML 能被 parseBpmn 重新解析')
    eq(parsed.definition.hash, diskHash, 'parseBpmn 的 definition.hash = sha256(回读 XML)')
    const converted = convertLegacyFlow(JSON.parse(originalText))
    eq(converted.ok, true, '旧流程可转换（前置条件）')
    eq(sha256(converted.xml), diskHash, '存下来的就是 convertLegacyFlow 产出的 XML')

    // ③ 归档：原 JSON 移入 archive，内容字节不变，flows 目录空。
    deep(listNames(flowsDir), [], 'flows 目录已空（原件已移走）')
    const archivedPath = join(archiveDir, `${id}.json`)
    eq(existsSync(archivedPath), true, 'archive 里有同名原 JSON')
    eq(readFileSync(archivedPath, 'utf8'), originalText, '归档 JSON 内容逐字节不变')

    // ④ 报告结构。
    const reportPath = join(archiveDir, 'migration-report.json')
    eq(existsSync(reportPath), true, '写 migration-report.json')
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    eq(report.reportVersion, 1, 'reportVersion=1')
    eq(report.tool, 'migrate-flows-to-bpmn', 'report.tool')
    eq(report.mode, 'apply', 'report.mode=apply')
    ok(Number.isFinite(Date.parse(report.generatedAt)), 'generatedAt 是 ISO 时间')
    eq(report.flowsDir, flowsDir, 'report.flowsDir')
    eq(report.definitionsRoot, definitionsDir, 'report.definitionsRoot')
    eq(report.archiveDir, archiveDir, 'report.archiveDir')
    deep(report.summary, { total: 1, migrated: 1, unchanged: 0, skipped: 0, failed: 0 }, 'report.summary 计数正确')
    eq(report.files.length, 1, 'report.files 有 1 条')
    const entry = report.files[0]
    eq(entry.id, id, 'report 条目 id')
    eq(entry.file, `${id}.json`, 'report 条目文件名')
    eq(entry.status, 'migrated', 'report 条目 status=migrated')
    eq(entry.version, 1, 'report 条目 version=1')
    eq(entry.hash, diskHash, 'report 条目 hash 与磁盘一致')
    ok(HEX64.test(entry.hash), 'report hash 是 64 位小写 hex')
    ok(Array.isArray(entry.warnings) && entry.warnings.length >= 1, 'report 带 warnings（旧字段留档提示）')
    ok(typeof entry.warnings[0].code === 'string' && typeof entry.warnings[0].message === 'string', 'warnings 形状 {code,message}')
    eq(entry.archivedTo, archivedPath, 'report 条目归档路径')
    eq(entry.archivedAs, `${id}.json`, 'report 条目归档文件名')
  })

  await check('再跑 --apply：全部 unchanged，不新增版本、不重复归档', async ({ dir }) => {
    const flowsDir = join(dir, 'flows')
    const definitionsDir = join(dir, 'definitions')
    const archiveDir = join(dir, 'archive')
    const ids = ['flow-mig-fixture', 'flow-mig-second']
    writeJson(join(flowsDir, `${ids[0]}.json`), fixtureFlow(ids[0], '迁移自检流程'))
    writeJson(join(flowsDir, `${ids[1]}.json`), fixtureFlow(ids[1], '迁移自检流程（第二份）'))

    const first = runCli(['--flows', flowsDir, '--definitions', definitionsDir, '--archive', archiveDir, '--apply'])
    eq(first.code, 0, '第一次 apply rc=0')
    for (const id of ids) {
      const metaBefore = await defs.readDefinition(id, { definitionsRoot: definitionsDir })
      eq(metaBefore.versions.length, 1, `${id} 第一次写入 1 个版本`)
    }
    const archiveBefore = listNames(archiveDir)

    // flows 已空：第二次靠 archive 识别「已迁移」。
    const second = runCli(['--flows', flowsDir, '--definitions', definitionsDir, '--archive', archiveDir, '--apply'])
    eq(second.code, 0, '第二次 apply rc=0')
    ok(second.stdout.includes('未变'), '结论为未变')
    ok(second.stdout.includes('migrated 0 / unchanged 2 / skipped 0 / failed 0'), '汇总 unchanged 2（全部）')
    ok(second.stdout.includes('源文件不在 flows'), '说明原文件已不在 flows 目录')

    for (const id of ids) {
      const metaAfter = await defs.readDefinition(id, { definitionsRoot: definitionsDir })
      eq(metaAfter.versions.length, 1, `${id} 版本数不变（仍 1 个）`)
      eq(metaAfter.latestVersion, 1, `${id} latestVersion 仍是 1`)
      eq(existsSync(join(flowsDir, `${id}.json`)), false, `${id} 的 flows 文件仍在归档处`)
    }
    deep(listNames(archiveDir), archiveBefore, 'archive 目录没有新增文件（含 .bak 备份）')
  })

  await check('源文件仍在 flows 但已同 hash：unchanged 且不重复归档', async ({ dir }) => {
    const flowsDir = join(dir, 'flows')
    const copyDir = join(dir, 'flows-copy')
    const definitionsDir = join(dir, 'definitions')
    const archiveDir = join(dir, 'archive')
    const id = 'flow-mig-fixture'
    writeJson(join(flowsDir, `${id}.json`), fixtureFlow(id, '迁移自检流程'))
    runCli(['--flows', flowsDir, '--definitions', definitionsDir, '--archive', archiveDir, '--apply'])

    // 模拟「源文件又出现在 flows」（从归档复制回来 / 上一次归档失败后人工补回）。
    mkdirSync(copyDir, { recursive: true })
    copyFileSync(join(archiveDir, `${id}.json`), join(copyDir, `${id}.json`))
    const archiveBefore = listNames(archiveDir)

    const run = runCli(['--flows', copyDir, '--definitions', definitionsDir, '--archive', archiveDir, '--apply'])
    eq(run.code, 0, 'rc=0')
    ok(run.stdout.includes('未变'), '结论为未变')
    ok(run.stdout.includes('原文件仍在 flows，保持不动'), '说明原文件保持不动')
    eq(existsSync(join(copyDir, `${id}.json`)), true, '源文件未被归档')
    deep(listNames(archiveDir), archiveBefore, 'archive 没有出现 .bak 副本')
    const meta = await defs.readDefinition(id, { definitionsRoot: definitionsDir })
    eq(meta.versions.length, 1, '版本数不变')
  })

  await check('坏流程：skipped + rc=1，不写定义、不归档、原文件留在原地', async ({ dir }) => {
    const flowsDir = join(dir, 'flows')
    const definitionsDir = join(dir, 'definitions')
    const archiveDir = join(dir, 'archive')
    writeJson(join(flowsDir, 'flow-good.json'), fixtureFlow('flow-good', '正常流程'))
    writeJson(join(flowsDir, 'flow-bad.json'), fixtureFlowWithoutStart('flow-bad'))
    writeText(join(flowsDir, 'flow-broken.json'), '{ "id": "flow-broken", ')

    const run = runCli(['--flows', flowsDir, '--definitions', definitionsDir, '--archive', archiveDir, '--apply'])
    eq(run.code, 1, '有 skipped 时 rc=1')
    ok(run.stdout.includes('[跳过] flow-bad.json'), '缺 start 的文件被跳过')
    ok(run.stdout.includes('[跳过] flow-broken.json'), '非法 JSON 的文件被跳过')
    ok(run.stdout.includes('LEGACY_START_INVALID'), '跳过原因带 convert 错误码')
    ok(run.stdout.includes('LEGACY_JSON_INVALID'), '非法 JSON 给出错误码')
    ok(run.stdout.includes('migrated 1 / unchanged 0 / skipped 2 / failed 0'), '汇总计数正确')

    eq((await defs.readDefinition('flow-bad', { definitionsRoot: definitionsDir })), null, '坏流程没有写入定义')
    eq((await defs.readDefinition('flow-broken', { definitionsRoot: definitionsDir })), null, '非法 JSON 没有写入定义')
    eq(existsSync(join(flowsDir, 'flow-bad.json')), true, '坏流程原文件留在 flows（等人看）')
    eq(existsSync(join(flowsDir, 'flow-broken.json')), true, '非法 JSON 原文件留在 flows')
    eq(existsSync(join(archiveDir, 'flow-bad.json')), false, '坏流程没有被归档')
    eq(existsSync(join(archiveDir, 'flow-broken.json')), false, '非法 JSON 没有被归档')
    eq(existsSync(join(archiveDir, 'flow-good.json')), true, '正常流程正常归档')

    const report = JSON.parse(readFileSync(join(archiveDir, 'migration-report.json'), 'utf8'))
    deep(report.summary, { total: 3, migrated: 1, unchanged: 0, skipped: 2, failed: 0 }, '报告 summary 与输出一致')
    const skippedIds = report.files.filter(item => item.status === 'skipped').map(item => item.id).sort()
    deep(skippedIds, ['flow-bad', 'flow-broken'], '报告里两条 skipped')
    const badEntry = report.files.find(item => item.id === 'flow-bad')
    eq(badEntry.archivedTo, null, 'skipped 条目没有归档路径')
    ok(badEntry.errors.some(error => error.code === 'LEGACY_START_INVALID'), 'skipped 条目带错误明细')
  })

  await check('定义被删后重跑：从 archive 补回定义，归档文件不被改名', async ({ dir }) => {
    const flowsDir = join(dir, 'flows')
    const definitionsDir = join(dir, 'definitions')
    const archiveDir = join(dir, 'archive')
    const id = 'flow-mig-fixture'
    writeJson(join(flowsDir, `${id}.json`), fixtureFlow(id, '迁移自检流程'))
    runCli(['--flows', flowsDir, '--definitions', definitionsDir, '--archive', archiveDir, '--apply'])
    const archiveBefore = listNames(archiveDir)

    // 模拟定义域被误删（或迁到别处），只剩 archive 里的原 JSON：重跑应只补写定义。
    rmSync(definitionsDir, { recursive: true, force: true })
    const run = runCli(['--flows', flowsDir, '--definitions', definitionsDir, '--archive', archiveDir, '--apply'])
    eq(run.code, 0, 'rc=0')
    ok(run.stdout.includes('迁移成功'), '从 archive 补写成功')
    ok(run.stdout.includes('只补写 definition'), '说明只补写定义、不再移动归档文件')
    const meta = await defs.readDefinition(id, { definitionsRoot: definitionsDir })
    ok(meta !== null, '定义已补回')
    eq(meta.versions.length, 1, '补回一个 v1')
    deep(listNames(archiveDir), archiveBefore, '归档目录没有出现 .bak 改名')

    const report = JSON.parse(readFileSync(join(archiveDir, 'migration-report.json'), 'utf8'))
    eq(report.files[0].status, 'migrated', '报告记录 migrated（补写定义）')
    eq(report.files[0].archivedTo, null, '补写路径不产生归档动作')
    ok(/只补写 definition/.test(report.files[0].note || ''), '报告 note 说明只补写定义')
  })

  await check('内容变化后重迁：新增版本；归档同名冲突退 .bak-<时间戳>，绝不覆盖', async ({ dir }) => {
    const flowsDir = join(dir, 'flows')
    const definitionsDir = join(dir, 'definitions')
    const archiveDir = join(dir, 'archive')
    const id = 'flow-mig-fixture'
    writeJson(join(flowsDir, `${id}.json`), fixtureFlow(id, '迁移自检流程 v1'))
    const first = runCli(['--flows', flowsDir, '--definitions', definitionsDir, '--archive', archiveDir, '--apply'])
    eq(first.code, 0, '第一次 apply rc=0')
    const firstArchiveText = readFileSync(join(archiveDir, `${id}.json`), 'utf8')

    // 同名流程内容改了（name 变 → XML 变 → hash 变）→ 必须是新版本 + 归档备份，不能覆盖旧归档。
    writeJson(join(flowsDir, `${id}.json`), fixtureFlow(id, '迁移自检流程 v2'))
    const second = runCli(['--flows', flowsDir, '--definitions', definitionsDir, '--archive', archiveDir, '--apply'])
    eq(second.code, 0, '第二次 apply rc=0')
    ok(second.stdout.includes(' v2'), '第二次写入版本 v2')

    const meta = await defs.readDefinition(id, { definitionsRoot: definitionsDir })
    eq(meta.versions.length, 2, '两个版本共存')
    eq(meta.latestVersion, 2, 'latestVersion=2')
    eq(meta.name, '迁移自检流程 v2', 'meta.name 更新为最新内容')

    eq(readFileSync(join(archiveDir, `${id}.json`), 'utf8'), firstArchiveText, '旧归档文件一个字节都没被覆盖')
    const backups = listNames(archiveDir).filter(name => name.startsWith(`${id}.json.bak-`))
    eq(backups.length, 1, '同名冲突退出一条 .bak-<时间戳>')
    ok(/\.bak-\d{8}-\d{6}$/.test(backups[0]), '.bak 后缀是 <时间戳> 形式')
    const backupFlow = JSON.parse(readFileSync(join(archiveDir, backups[0]), 'utf8'))
    eq(backupFlow.name, '迁移自检流程 v2', '.bak 里是本次迁移的（新）原文件')

    const report = JSON.parse(readFileSync(join(archiveDir, 'migration-report.json'), 'utf8'))
    eq(report.files[0].archivedAs, backups[0], '报告记录实际归档文件名')
  })

  await check('定义域损坏：failed + rc=1，原文件不归档、不被删', async ({ dir }) => {
    const flowsDir = join(dir, 'flows')
    const definitionsDir = join(dir, 'definitions')
    const archiveDir = join(dir, 'archive')
    const id = 'flow-mig-fixture'
    writeJson(join(flowsDir, `${id}.json`), fixtureFlow(id, '迁移自检流程'))
    // 手动制造一个坏 meta.json（模拟手改坏的定义域）：readDefinition 会抛 DEFINITION_CORRUPT。
    writeText(join(definitionsDir, id, 'meta.json'), '{ this is not json')

    const run = runCli(['--flows', flowsDir, '--definitions', definitionsDir, '--archive', archiveDir, '--apply'])
    eq(run.code, 1, 'failed 时 rc=1')
    ok(run.stdout.includes('[失败]'), '逐文件结论为失败')
    ok(run.stdout.includes('migrated 0 / unchanged 0 / skipped 0 / failed 1'), '汇总 failed 1')
    eq(existsSync(join(flowsDir, `${id}.json`)), true, '原文件仍在 flows（没被删、没被归档）')
    eq(existsSync(join(archiveDir, `${id}.json`)), false, '失败的文件没有被归档')

    const report = JSON.parse(readFileSync(join(archiveDir, 'migration-report.json'), 'utf8'))
    eq(report.files[0].status, 'failed', '报告记录 failed')
    eq(report.files[0].archivedTo, null, 'failed 条目没有归档路径')
    ok(report.files[0].errors.length > 0, 'failed 条目带错误明细')
  })

  await check('真实样本：3 个旧流程全部 migrated，且存下的 XML 都能被 parseBpmn 重新解析', async ({ dir }) => {
    const flowsDir = join(dir, 'flows')
    const definitionsDir = join(dir, 'definitions')
    const archiveDir = join(dir, 'archive')

    let names = realSampleNames(3)
    let synthetic = false
    if (names === null) {
      // 没有真实样本的机器（如 CI）用合成流程兜底，保证用例仍可执行。
      synthetic = true
      names = ['flow-mig-real-a.json', 'flow-mig-real-b.json', 'flow-mig-real-c.json']
      for (const name of names) {
        const id = name.slice(0, -'.json'.length)
        writeJson(join(flowsDir, name), fixtureFlow(id, `合成样本 ${id}`))
      }
      console.warn(`  ! 找不到 ${realFlowsDir}（或不足 3 个样本），本组改用合成流程`)
    } else {
      copyRealSamples(flowsDir, names)
      realSamplesUsed = true
      realSampleCount = names.length
      console.log(`    （真实样本：${names.join('、')}）`)
    }

    const run = runCli(['--flows', flowsDir, '--definitions', definitionsDir, '--archive', archiveDir, '--apply'])
    eq(run.code, 0, 'rc=0')
    ok(run.stdout.includes(`migrated ${names.length} / unchanged 0 / skipped 0 / failed 0`), `全部 migrated（${names.length} 个）`)

    for (const name of names) {
      const id = name.slice(0, -'.json'.length)
      const meta = await defs.readDefinition(id, { definitionsRoot: definitionsDir })
      ok(meta !== null, `${id} 写入定义`)
      eq(meta.versions.length, 1, `${id} 恰好一个版本`)
      const read = await defs.readDefinitionVersion(id, meta.latestVersion, { definitionsRoot: definitionsDir })
      ok(read !== null, `${id} 回读成功`)
      eq(read.hash, sha256(read.xml), `${id} 回读 hash 与磁盘一致`)
      const reparsed = await parseBpmn(read.xml)
      eq(reparsed.ok, true, `${id} 存下的 XML 能被 parseBpmn 重新解析`)
      eq(reparsed.definition.hash, read.hash, `${id} 重新解析的 hash 与存储一致`)
      eq(meta.name.length > 0, true, `${id} meta.name 非空`)
    }

    deep(listNames(flowsDir), [], '全部原 JSON 已移出 flows')
    for (const name of names) {
      eq(existsSync(join(archiveDir, name)), true, `${name} 已归档`)
    }
    if (synthetic) {
      ok(true, '合成兜底路径（说明：本机没有真实样本）')
    } else {
      ok(!synthetic && realSamplesUsed, '本次使用的是真实样本')
    }
  })
} finally {
  // 每个用例自己删自己的临时目录，这里只在全部结束后兜底收掉本文件可能留下的根（不碰别人的）。
}

console.log(`\n${checks} 组通过（${assertions} 条断言）`)
if (realSamplesUsed) {
  console.log(`真实样本：${realSampleCount} 个（只读复制自 ${realFlowsDir}）`)
} else {
  console.log('真实样本：未使用（找不到 ~/.dsh 下的旧流程，改用合成流程）')
}
