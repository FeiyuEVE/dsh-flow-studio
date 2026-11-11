#!/usr/bin/env node
/**
 * 流程定义域存储自检：版本不可变 / 版本号分配 / list+read / 删除引用检查 / 权限 / 坏形状。
 *
 * 产物落在项目 `.tmp/` 下（每个用例一个新 home，结束清理），不占系统 /tmp；不启动 dsh。
 * 运行：node test/definition-store.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const defs = await import('../src/definition-store.js')
const instances = await import('../src/instance-store.js')

const DIR_MODE = 0o700
const FILE_MODE = 0o600

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

async function rejects(fn, predicate, message) {
  assertions += 1
  await assert.rejects(fn, predicate, message)
}

/** 一个用例一个全新 home；用 { home } 让两个 store 指向同一套目录。 */
async function check(name, fn) {
  const home = mkdtempSync(join(repoRoot, '.tmp', 'home-def-'))
  try {
    await fn({ home })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

function bpmn(tag) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="${tag}">`
    + `<bpmn:process id="p-${tag}" isExecutable="true"/></bpmn:definitions>\n`
}

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')
const modeOf = path => statSync(path).mode & 0o777

try {
  await check('版本号分配：不传 version 递增，显式 version 被尊重，latest 取最大', async ({ home }) => {
    const root = defs.definitionsDir(home)
    const first = await defs.saveDefinitionVersion('flow-a', bpmn('v1'), { name: '流程 A' }, { home })
    eq(first.version, 1, '首次写入必须分配 v1')
    eq(first.created, true, '首次写入 created=true')
    eq(first.hash, sha256(bpmn('v1')), 'hash 必须是 XML 内容的 sha256')
    eq(first.bytes, Buffer.byteLength(bpmn('v1'), 'utf8'), 'bytes 必须是 UTF-8 字节数')

    const second = await defs.saveDefinitionVersion('flow-a', bpmn('v2'), {}, { home })
    eq(second.version, 2, '不传 version 时在 max 上 +1')

    const explicit = await defs.saveDefinitionVersion('flow-a', bpmn('v7'), {
      version: 7,
      tags: ['demo', 'demo', ' review '],
    }, { home })
    eq(explicit.version, 7, '调用方显式给的 version 必须被采用')

    const meta = await defs.readDefinition('flow-a', { home })
    eq(meta.id, 'flow-a', 'readDefinition 返回目录 id')
    eq(meta.name, '流程 A', '未传 name 时保留已有名字')
    deep(meta.versions.map(item => item.version), [1, 2, 7], 'versions 必须按版本升序')
    eq(meta.latestVersion, 7, 'latestVersion 取最大版本')
    eq(meta.latestHash, explicit.hash, 'latestHash 与最大版本一致')
    deep(meta.tags, ['demo', 'review'], 'tags 去重 + trim')
    ok(existsSync(join(root, 'flow-a', '7.bpmn')), '版本正本落在 <version>.bpmn')

    const v2 = await defs.readDefinitionVersion('flow-a', 2, { home })
    eq(v2.hash, second.hash, 'readDefinitionVersion 的 hash 与写入一致')
    eq(v2.xml, bpmn('v2'), 'readDefinitionVersion 返回 XML 正本')
    eq(await defs.readDefinition('nope', { home }), null, '不存在的定义返回 null')
    eq(await defs.readDefinitionVersion('flow-a', 3, { home }), null, '不存在的版本返回 null')
  })

  await check('不可变性：同版本同 hash 幂等，不同 hash 409 且文件一个字节都不动', async ({ home }) => {
    const root = defs.definitionsDir(home)
    const xmlA = bpmn('v1-a')
    const first = await defs.saveDefinitionVersion('flow-immutable', xmlA, { name: '不可变' }, { home })
    const before = await defs.readDefinition('flow-immutable', { home })
    const filePath = join(root, 'flow-immutable', '1.bpmn')

    const again = await defs.saveDefinitionVersion('flow-immutable', xmlA, { version: 1 }, { home })
    eq(again.created, false, '同版本同 hash 必须幂等成功（created=false）')
    eq(again.hash, first.hash, '幂等写入的 hash 不变')
    const afterIdempotent = await defs.readDefinition('flow-immutable', { home })
    eq(afterIdempotent.updatedAt, before.updatedAt, '幂等写入不得改 meta.updatedAt')
    eq(readFileSync(filePath, 'utf8'), xmlA, '幂等写入后版本文件内容不变')

    const xmlB = bpmn('v1-b')
    await rejects(
      () => defs.saveDefinitionVersion('flow-immutable', xmlB, { version: 1 }, { home }),
      error => error.status === 409 && error.code === 'DEFINITION_VERSION_IMMUTABLE'
        && error.expectedHash === first.hash && error.actualHash === sha256(xmlB),
      '同版本不同 hash 必须 409 DEFINITION_VERSION_IMMUTABLE',
    )
    eq(readFileSync(filePath, 'utf8'), xmlA, '拒绝覆盖后版本文件仍是第一次的内容')
    const after = await defs.readDefinition('flow-immutable', { home })
    eq(after.versions.length, 1, '被拒绝的写入不得往 meta.versions 里加条目')
    eq(after.latestHash, first.hash, 'meta 记录的仍是第一次的 hash')
  })

  await check('实例钉住定义：定义改版后实例的 hash / 版本 / 快照都不变', async ({ home }) => {
    const root = defs.definitionsDir(home)
    const xmlA = bpmn('pinned-v1')
    const definition = await defs.saveDefinitionVersion('flow-pinned', xmlA, { name: '钉住' }, { home })
    const instance = await instances.createInstance({
      definitionId: 'flow-pinned',
      definitionVersion: 1,
      variables: { env: 'test' },
      home,
    })
    eq(instance.definitionId, 'flow-pinned', '实例记录 definitionId')
    eq(instance.definitionVersion, 1, '实例记录 definitionVersion')
    eq(instance.definitionHash, definition.hash, '实例钉住创建时的 definitionHash')
    eq(instance.status, 'pending', '新实例初始状态 pending')
    eq(instance.revision, 1, '新实例 revision=1')
    eq(instance.variables.env, 'test', 'variables 被保存')

    // 定义改版（v2），甚至内容完全不同
    const changed = bpmn('pinned-v2')
    await defs.saveDefinitionVersion('flow-pinned', changed, {}, { home })
    eq(readFileSync(join(root, 'flow-pinned', '2.bpmn'), 'utf8'), changed, '定义域确实写入了 v2')

    const pinned = await instances.readInstance(instance.id, { home })
    eq(pinned.definitionHash, definition.hash, '定义改版后实例的 definitionHash 不变')
    eq(pinned.definitionVersion, 1, '定义改版后实例仍指向 v1')

    const snapshot = await instances.readInstanceDefinition(instance.id, { home })
    eq(snapshot.xml, xmlA, '实例读到的定义正文是创建时的快照，而不是 v2')
    eq(snapshot.definitionHash, definition.hash, '快照 hash 与 instance.json 一致')
    const copy = readFileSync(join(instances.instancesDir(home), instance.id, 'definition.bpmn'), 'utf8')
    eq(copy, xmlA, '实例目录里的 definition.bpmn 是创建时的正本')
  })

  await check('删除：默认拒删被实例引用的定义，force 后归档，实例快照仍可读', async ({ home }) => {
    const root = defs.definitionsDir(home)
    const xml = bpmn('delete-me')
    await defs.saveDefinitionVersion('flow-del', xml, { name: '待删' }, { home })
    const instance = await instances.createInstance({ definitionId: 'flow-del', definitionVersion: 1, home })

    await rejects(
      () => defs.deleteDefinition('flow-del', { home }),
      error => error.status === 409 && error.code === 'DEFINITION_IN_USE'
        && Array.isArray(error.references) && error.references.includes(instance.id),
      '被实例引用时默认必须 409 DEFINITION_IN_USE',
    )
    ok(existsSync(join(root, 'flow-del')), '被拒绝的删除不得动目录')

    const removed = await defs.deleteDefinition('flow-del', { home, force: true })
    eq(removed.deleted, true, 'force 删除成功')
    eq(removed.forced, true, '返回值带 forced=true')
    eq(existsSync(join(root, 'flow-del')), false, 'force 后活动目录消失')
    ok(existsSync(join(root, '.deleted')), '删除是归档而不是彻底抹掉')
    deep(await defs.listDefinitions({ home }), [], '删除后列表为空')
    eq((await defs.readDefinition('flow-del', { home })), null, '删除后 readDefinition 返回 null')

    const snapshot = await instances.readInstanceDefinition(instance.id, { home })
    eq(snapshot.xml, xml, '定义被删后实例仍从自己的快照读到正文')

    await rejects(
      () => defs.deleteDefinition('flow-del', { home }),
      error => error.status === 404 && error.code === 'DEFINITION_NOT_FOUND',
      '重复删除返回 404',
    )
  })

  await check('listDefinitions：摘要字段 + 坏定义跳过', async ({ home }) => {
    await defs.saveDefinitionVersion('flow-1', bpmn('one'), { name: '一号', tags: ['a'] }, { home })
    await defs.saveDefinitionVersion('flow-2', bpmn('two'), { name: '二号' }, { home })
    await defs.saveDefinitionVersion('flow-2', bpmn('two-b'), {}, { home })
    // 手改坏一份 meta：列表必须跳过它而不是整张 500
    const brokenDir = join(defs.definitionsDir(home), 'broken-def')
    mkdirSync(brokenDir, { recursive: true, mode: DIR_MODE })
    writeFileSync(join(brokenDir, 'meta.json'), '{ not json', { mode: FILE_MODE })

    const list = await defs.listDefinitions({ home })
    eq(list.length, 2, '坏定义被跳过')
    const byId = new Map(list.map(item => [item.id, item]))
    eq(byId.get('flow-1').name, '一号', '摘要带 name')
    deep(byId.get('flow-1').tags, ['a'], '摘要带 tags')
    eq(byId.get('flow-2').versionCount, 2, '摘要带版本数')
    eq(byId.get('flow-2').latestVersion, 2, '摘要带最新版本')
    ok(!('versions' in byId.get('flow-1')), '列表摘要不塞整份 versions')
  })

  await check('权限：definitions 根 / 定义目录 0700，meta 与版本文件 0600', async ({ home }) => {
    await defs.saveDefinitionVersion('flow-mode', bpmn('mode'), { name: '权限' }, { home })
    const root = defs.definitionsDir(home)
    const dir = join(root, 'flow-mode')
    eq(modeOf(root), DIR_MODE, 'definitions 根目录 0700')
    eq(modeOf(dir), DIR_MODE, 'definition 目录 0700')
    eq(modeOf(join(dir, 'meta.json')), FILE_MODE, 'meta.json 0600')
    eq(modeOf(join(dir, '1.bpmn')), FILE_MODE, '1.bpmn 0600')
    eq(existsSync(join(root, '.lock')), false, '操作结束后不残留 .lock 文件')
  })

  await check('坏 JSON / 坏形状：读报 CORRUPT，写被拒绝且原文件不被改', async ({ home }) => {
    const root = defs.definitionsDir(home)
    const dir = join(root, 'bad-json')
    mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    const garbage = '{ this is not json'
    writeFileSync(join(dir, 'meta.json'), garbage, { mode: FILE_MODE })

    await rejects(
      () => defs.readDefinition('bad-json', { home }),
      error => error.status === 500 && error.code === 'DEFINITION_CORRUPT',
      '坏 JSON 读侧必须是 500 DEFINITION_CORRUPT',
    )
    await rejects(
      () => defs.saveDefinitionVersion('bad-json', bpmn('heal'), {}, { home }),
      error => error.status === 500 && error.code === 'DEFINITION_CORRUPT',
      '坏 meta 存在时拒绝写入（不能悄悄重建）',
    )
    eq(readFileSync(join(dir, 'meta.json'), 'utf8'), garbage, '被拒绝的写入不得改坏 meta 的原始字节')
    eq(existsSync(join(dir, '1.bpmn')), false, '被拒绝的写入不得先写出一份 XML 半成品')

    const shapeDir = join(root, 'bad-shape')
    mkdirSync(shapeDir, { recursive: true, mode: DIR_MODE })
    const badShape = JSON.stringify({ id: 'bad-shape', name: '坏', versions: 'nope' })
    writeFileSync(join(shapeDir, 'meta.json'), badShape, { mode: FILE_MODE })
    await rejects(
      () => defs.readDefinition('bad-shape', { home }),
      error => error.status === 500 && error.code === 'DEFINITION_CORRUPT',
      'versions 不是数组必须报 CORRUPT',
    )
    await rejects(
      () => defs.saveDefinitionVersion('bad-shape', bpmn('x'), {}, { home }),
      error => error.status === 500 && error.code === 'DEFINITION_CORRUPT',
      '坏形状存在时同样拒绝写入',
    )
    eq(readFileSync(join(shapeDir, 'meta.json'), 'utf8'), badShape, '坏形状原文件不被覆盖')

    await rejects(
      () => defs.saveDefinitionVersion('../escape', bpmn('x'), {}, { home }),
      error => error.status === 400 && error.code === 'DEFINITION_INVALID_ID',
      '路径穿越型 id 必须 400',
    )
    await rejects(
      () => defs.saveDefinitionVersion('flow-x', '', {}, { home }),
      error => error.status === 400 && error.code === 'DEFINITION_XML_INVALID',
      '空 XML 必须 400',
    )
    await rejects(
      () => defs.saveDefinitionVersion('flow-x', bpmn('x'), { version: 0 }, { home }),
      error => error.status === 400 && error.code === 'DEFINITION_INVALID_VERSION',
      '显式 version=0 必须 400',
    )
  })

  await check('并发保存：同一定义的两笔无版本号写入不会撞到同一个版本', async ({ home }) => {
    const results = await Promise.all([
      defs.saveDefinitionVersion('flow-race', bpmn('race-a'), { name: '竞态' }, { home }),
      defs.saveDefinitionVersion('flow-race', bpmn('race-b'), {}, { home }),
    ])
    const versions = results.map(item => item.version).sort((a, b) => a - b)
    deep(versions, [1, 2], '并发写入必须各自分配到不同版本')
    deep(results.map(item => item.created), [true, true], '两笔都真实写入（各自一个新版本）')
    const meta = await defs.readDefinition('flow-race', { home })
    eq(meta.versions.length, 2, 'meta 里恰好两个版本')
    eq(meta.latestVersion, 2, 'latestVersion=2')
  })

  await check('过期锁可被接管，不会把定义永久锁死', async ({ home }) => {
    await defs.saveDefinitionVersion('flow-lock', bpmn('lock-v1'), { name: '锁' }, { home })
    const lockPath = join(defs.definitionsDir(home), '.lock')
    writeFileSync(lockPath, 'stale-holder\n', { mode: FILE_MODE })
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath, old, old)

    const written = await defs.saveDefinitionVersion('flow-lock', bpmn('lock-v2'), {}, { home })
    eq(written.version, 2, '陈旧锁被接管后写入成功')
    eq(existsSync(lockPath), false, '成功写入后陈旧锁被清掉')
  })
} finally {
  // 每个用例自己清理 home；这里只兜底删掉可能残留的 .tmp 根（不要删别人的）。
}

console.log(`\n${checks} 组通过（${assertions} 条断言）`)
