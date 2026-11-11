#!/usr/bin/env node
/**
 * 产物快照自检（0.13.7 C）：hash 寻址 / 原子写 / 安全读取 / 篡改与越界拒绝 /
 * instance-store 的 artifact 来源字段向后兼容。
 *
 * 运行：node test/artifact-store.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

const {
  ARTIFACT_ERROR, artifactPathUnder, contentRefFor, createArtifactStore, hashFromContentRef,
} = await import('../src/artifact-store.js')
const defs = await import('../src/definition-store.js')
const store = await import('../src/instance-store.js')

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

async function rejectsCode(fn, code, message) {
  assertions += 1
  await assert.rejects(fn, error => {
    assert.equal(error && error.code, code, `${message}（实际 ${error && error.code}）`)
    return true
  }, message)
}

async function check(name, fn) {
  const sandbox = mkdtempSync(join(repoRoot, '.tmp', 'artifact-'))
  try {
    await fn(sandbox)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
  checks += 1
  console.log(`  ✓ ${name}`)
}

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

async function seedInstance(home) {
  await defs.saveDefinitionVersion('flow-art', '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d"/>', {}, {
    definitionsRoot: defs.definitionsDir(home),
  })
  return await store.createInstance({
    definitionId: 'flow-art',
    definitionsRoot: defs.definitionsDir(home),
    instancesRoot: store.instancesDir(home),
  })
}

try {
  await check('put / read：contentRef 是 artifacts/<sha256>、文件 0600、重复写幂等', async sandbox => {
    const root = join(sandbox, 'artifacts')
    const artifacts = createArtifactStore({ root })
    const content = Buffer.from('hello artifact\n', 'utf8')
    const first = await artifacts.put(content)
    eq(first.sha256, sha256(content), 'sha256 与独立计算一致')
    eq(first.bytes, content.length, 'bytes 与内容长度一致')
    eq(first.contentRef, contentRefFor(first.sha256), 'contentRef 是 artifacts/<sha256>')
    const path = artifacts.pathOf(first.sha256)
    eq(path, join(root, first.sha256), '按 hash 寻址')
    eq(statSync(path).mode & 0o777, 0o600, '快照文件 0600')
    deep(await artifacts.read(first.sha256), content, '按 hash 读回原文')
    const second = await artifacts.put(content)
    deep(second, first, '同内容第二次写入返回同一引用')
    deep(await artifacts.verify(first.sha256, content.length), { sha256: first.sha256, bytes: content.length }, 'verify 成功')
    await rejectsCode(
      () => artifacts.verify(first.sha256, content.length + 1),
      ARTIFACT_ERROR.HASH_MISMATCH,
      '字节数不符报 HASH_MISMATCH',
    )
  })

  await check('captureFile：安全读取普通文件；symlink / 目录 / 超大文件拒绝', async sandbox => {
    const root = join(sandbox, 'artifacts')
    const artifacts = createArtifactStore({ root, maxBytes: 32 })
    const file = join(sandbox, 'doc.md')
    writeFileSync(file, '# 需求\n')
    const captured = await artifacts.captureFile(file)
    eq(captured.bytes, Buffer.byteLength('# 需求\n'), 'captureFile 字节数正确')
    eq(captured.sha256, sha256(Buffer.from('# 需求\n')), 'captureFile sha256 正确')
    deep(await artifacts.read(captured.sha256), Buffer.from('# 需求\n'), '快照内容与原文一致')

    const link = join(sandbox, 'link.md')
    symlinkSync(file, link)
    await rejectsCode(() => artifacts.captureFile(link), ARTIFACT_ERROR.CAPTURE_FAILED, 'symlink 拒绝')
    const dir = join(sandbox, 'dir')
    mkdirSync(dir)
    await rejectsCode(() => artifacts.captureFile(dir), ARTIFACT_ERROR.CAPTURE_FAILED, '目录拒绝')
    const big = join(sandbox, 'big.bin')
    writeFileSync(big, Buffer.alloc(64))
    await rejectsCode(() => artifacts.captureFile(big), ARTIFACT_ERROR.TOO_LARGE, '超过上限拒绝')
  })

  await check('读失败分类：不存在 / 非法 hash / 内容被篡改', async sandbox => {
    const artifacts = createArtifactStore({ root: join(sandbox, 'artifacts') })
    const stored = await artifacts.put(Buffer.from('x'))
    await rejectsCode(() => artifacts.read('f'.repeat(64)), ARTIFACT_ERROR.NOT_FOUND, '不存在 NOT_FOUND')
    await rejectsCode(() => artifacts.read('../../etc/passwd'), ARTIFACT_ERROR.INVALID, '非法 hash INVALID')
    writeFileSync(artifacts.pathOf(stored.sha256), 'tampered')
    await rejectsCode(() => artifacts.read(stored.sha256), ARTIFACT_ERROR.HASH_MISMATCH, '篡改 HASH_MISMATCH')
  })

  await check('contentRef 解析与路径穿越防护', async sandbox => {
    const hash = 'a'.repeat(64)
    eq(hashFromContentRef(`artifacts/${hash}`), hash, 'artifacts/ 前缀可解析')
    eq(hashFromContentRef(hash), hash, '裸 hash 可解析')
    eq(hashFromContentRef(`artifacts/${hash}/../x`), null, '带 ../ 拒绝')
    eq(hashFromContentRef('artifacts/../../etc/passwd'), null, '绝对路径拒绝')
    const root = join(sandbox, 'artifacts')
    ok(artifactPathUnder(root, `artifacts/${hash}`)?.endsWith(hash), '合法引用拼出根下路径')
    eq(artifactPathUnder(root, 'artifacts/../../etc/passwd'), null, '越界引用返回 null')
  })

  await check('instance-store：artifact 来源字段（executionId/workspaceId/contentRef）可读回，旧记录兼容', async home => {
    const instance = await seedInstance(home)
    const hash = 'b'.repeat(64)
    const updated = await store.updateInstance(instance.id, {
      artifacts: [{
        path: 'docs/report.md',
        sha256: hash.toUpperCase(),
        bytes: 12,
        kind: 'report',
        executionId: 'review_execution_42',
        workspaceId: '0123456789ab',
        contentRef: `artifacts/${hash}`,
      }],
    }, { instancesRoot: store.instancesDir(home) })
    eq(updated.artifacts[0].sha256, hash, 'sha256 归一为小写')
    eq(updated.artifacts[0].executionId, 'review_execution_42', 'executionId 保留')
    eq(updated.artifacts[0].workspaceId, '0123456789ab', 'workspaceId 保留')
    eq(updated.artifacts[0].contentRef, `artifacts/${hash}`, 'contentRef 保留')
    const reread = await store.readInstance(instance.id, { instancesRoot: store.instancesDir(home) })
    deep(reread.artifacts, updated.artifacts, '落盘读回一致')

    const old = await store.updateInstance(instance.id, {
      artifacts: [{ path: 'docs/old.md', sha256: 'c'.repeat(64), bytes: 3 }],
    }, { instancesRoot: store.instancesDir(home) })
    deep(old.artifacts[0], { path: 'docs/old.md', sha256: 'c'.repeat(64), bytes: 3 }, '旧记录没有新字段也照常读')
    const invalid = await store.updateInstance(instance.id, {
      artifacts: [{ path: 'docs/bad.md', sha256: 'd'.repeat(64), contentRef: 'artifacts/../../etc/passwd' }],
    }, { instancesRoot: store.instancesDir(home) })
    eq(invalid.artifacts[0].contentRef, undefined, '非法 contentRef 被丢弃')
  })

  await check('原子写不留下临时文件', async sandbox => {
    const root = join(sandbox, 'artifacts')
    const artifacts = createArtifactStore({ root })
    await artifacts.put(Buffer.from('one'))
    await artifacts.captureFile((() => {
      const file = join(sandbox, 'two.txt')
      writeFileSync(file, 'two')
      return file
    })())
    const names = await import('node:fs').then(fs => fs.readdirSync(root))
    ok(names.every(name => !name.startsWith('.tmp-')), '没有 .tmp- 残留')
    ok(names.every(name => /^[0-9a-f]{64}$/.test(name)), '根下只有 hash 文件')
    eq(readFileSync(join(root, names[0])).length > 0, true, '快照文件有内容')
  })

  console.log('artifact-store.test.mjs')
  console.log(`${checks} 组通过（${assertions} 条断言）`)
} catch (error) {
  console.error('✗ 产物快照自检失败')
  console.error(error)
  process.exit(1)
}
