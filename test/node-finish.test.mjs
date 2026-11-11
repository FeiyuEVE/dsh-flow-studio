#!/usr/bin/env node
/**
 * `node-finish.js` 自检：`flow_finish_node` 的独立校验层（11 §1–§3 硬契约）。
 *
 * 覆盖（对应任务书 1–7）：
 *   1. 正常：两个文档（markdown + 二进制）+ 3 个短变量 → record 形状正确，sha256 /
 *      bytes 与 crypto 独立计算一致；
 *   2. 变量：键数 / Unicode 字符数 / UTF-8 JSON 字节数 / 嵌套结构 / 危险键 → 全部
 *      `NODE_VARIABLES_INVALID`，边界值（32 键 / 512 字符 / 8192 字节）通过；
 *   3. 文档：不存在 / 绝对路径 / `..` 逃逸 / 符号链接逃逸 / >5 MiB / 校验中被改
 *      （变长、字节数不符、mtime 变化）→ `NODE_DOCUMENT_INVALID`，且零登记（gate 未
 *      settled、result 未决议）；
 *   4. 重复与并发：并发两次 submit 恰好一个成功，产物只登记一次；
 *   5. abort：result reject（带 `aborted` 标记）、后续 submit `NODE_ALREADY_SETTLED`；
 *   6. 失败后可修正重试：纯校验失败不锁死闸门；
 *   7. 5 MiB 边界：`truncate` 造稀疏文件，读取按 ≤64 KiB 分块喂 hash，不整份读。
 *
 * 全程用项目 `.tmp/` 下的临时工作区，不碰 `~/.dsh`、不启动 dsh、不发网络请求。
 * 运行：node test/node-finish.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync,
  symlinkSync, truncateSync, utimesSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NODE_FINISH_ERROR, NODE_FINISH_LIMITS, NodeFinishError,
  createFinishGate, validateFinishArgs,
} from '../src/node-finish.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const sandbox = mkdtempSync(join(repoRoot, '.tmp', 'node-finish-'))
const FIXED_NOW = new Date('2026-11-11T12:34:56.789Z')

let checks = 0
let asserts = 0

/** 每条断言都计数（`A.throws` / `A.rejects` 这类也照常工作）。 */
const A = new Proxy(assert, {
  get(target, property) {
    const value = target[property]
    if (typeof value !== 'function') return value
    return (...args) => {
      asserts += 1
      return value.apply(target, args)
    }
  },
})

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let caseSeq = 0
/** 每个用例一个全新工作区（仍是 `.tmp/` 的子目录）。 */
function freshWorkspace() {
  const dir = join(sandbox, `case-${++caseSeq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeDoc(workspace, relativePath, content) {
  const absolute = join(workspace, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
  return absolute
}

/** 稀疏文件：只设置大小，不真写内容（避免为 >5 MiB 用例真占磁盘）。 */
function sparseFile(workspace, relativePath, size) {
  const absolute = join(workspace, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, '')
  truncateSync(absolute, size)
  return absolute
}

function makeGate(workspace, overrides = {}) {
  return createFinishGate({
    executionId: 'exec-1',
    nodeId: 'agent-1',
    attempt: 2,
    workspaceRoot: workspace,
    now: () => FIXED_NOW,
    ...overrides,
  })
}

function sha256Of(content) {
  return createHash('sha256').update(content).digest('hex')
}

/** 同步断言：错误码 + 中文原因。 */
function assertCodeSync(fn, code, label) {
  A.throws(fn, error => {
    A.equal(error?.name, 'NodeFinishError', `${label}：错误类型`)
    A.equal(error?.code, code, `${label}：错误码`)
    A.match(error?.message ?? '', /[\u4e00-\u9fa5]/, `${label}：中文可行动原因`)
    return true
  }, label)
}

/** 异步断言：错误码 + 中文原因。 */
async function assertCode(promise, code, label) {
  await A.rejects(promise, error => {
    A.equal(error?.name, 'NodeFinishError', `${label}：错误类型`)
    A.equal(error?.code, code, `${label}：错误码`)
    A.match(error?.message ?? '', /[\u4e00-\u9fa5]/, `${label}：中文可行动原因`)
    return true
  }, label)
}

/** 拿到 rejection 的错误对象（用于检查 details / 标记）。 */
async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('预期 rejection，但 Promise 成功')
}

/** Promise 在 ms 内是否仍未决议。 */
function raceState(promise, ms = 15) {
  return Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    new Promise(resolvePromise => setTimeout(() => resolvePromise('pending'), ms)),
  ])
}

/** 构造「UTF-8 JSON 序列化后恰好 N 字节」的 variables（16 个单字符键，值 ≤512 字符）。 */
function variablesOfSerializedBytes(totalBytes) {
  const keys = [...'abcdefghijklmnop']
  const count = keys.length
  const fixedBytes = count /* 键（各 1 字符） */ + 6 * count + 1 /* 引号/冒号/逗号/花括号 */
  const valueChars = totalBytes - fixedBytes
  if (valueChars < 0 || valueChars > count * 512) throw new Error('不可构造该字节数')
  const base = Math.floor(valueChars / count)
  const extra = valueChars - base * count
  const variables = {}
  keys.forEach((key, index) => {
    variables[key] = 'x'.repeat(base + (index < extra ? 1 : 0))
  })
  return variables
}

try {
  // -------------------------------------------------------------------------
  // 1. 顶层契约
  // -------------------------------------------------------------------------
  await check('顶层：只接受对象 / 未知键 / 三件套必填 / summary 有界 / 闸门参数', () => {
    const minimal = { variables: {}, documents: [], summary: '' }
    A.deepEqual(validateFinishArgs(minimal), minimal, '空对象 / 空数组 / 空串是合法输入')

    for (const bad of [null, [], 'x', 42, new Date()]) {
      assertCodeSync(() => validateFinishArgs(bad), NODE_FINISH_ERROR.INVALID, '非对象入参')
    }
    assertCodeSync(
      () => validateFinishArgs({ ...minimal, extra: 1 }),
      NODE_FINISH_ERROR.INVALID,
      '未知顶层键',
    )
    for (const missing of ['variables', 'documents', 'summary']) {
      const args = { ...minimal }
      delete args[missing]
      assertCodeSync(() => validateFinishArgs(args), NODE_FINISH_ERROR.INVALID, `缺必填键 ${missing}`)
    }
    assertCodeSync(
      () => validateFinishArgs({ ...minimal, summary: 1 }),
      NODE_FINISH_ERROR.INVALID,
      'summary 非字符串',
    )
    assertCodeSync(
      () => validateFinishArgs({ ...minimal, summary: 'x'.repeat(501) }),
      NODE_FINISH_ERROR.INVALID,
      'summary 超过 500 字符',
    )
    A.equal(validateFinishArgs({ ...minimal, summary: 'x'.repeat(500) }).summary.length, 500, 'summary 500 字符是边界内')

    // 闸门自身的参数也要明确失败，不能带病运行。
    assertCodeSync(() => createFinishGate({}), NODE_FINISH_ERROR.INVALID, '缺 options 字段')
    assertCodeSync(
      () => createFinishGate({ executionId: 'e', nodeId: 'n', attempt: 0, workspaceRoot: '/x' }),
      NODE_FINISH_ERROR.INVALID,
      'attempt 必须 ≥1',
    )
    assertCodeSync(
      () => createFinishGate({ executionId: 'e', nodeId: 'n', attempt: 1, workspaceRoot: '/x', limits: { maxVariables: 0 } }),
      NODE_FINISH_ERROR.INVALID,
      'limits 必须是正整数',
    )
  })

  // -------------------------------------------------------------------------
  // 2. variables：键数 / 字符数 / 字节数 / 类型 / 危险键
  // -------------------------------------------------------------------------
  await check('变量：32 键 / 512 字符 / 8192 字节边界通过，33 键 / 513 字符 / 8193 字节拒绝', () => {
    const args = (variables, limits) => ({ variables, documents: [], summary: '' })
    const variablesArgs = (variables, limits) => validateFinishArgs(args(variables, limits), limits)

    const keys32 = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`k${index}`, index]))
    A.equal(Object.keys(variablesArgs(keys32).variables).length, 32, '32 个键是边界内')
    const keys33 = { ...keys32, k32: 32 }
    assertCodeSync(() => variablesArgs(keys33), NODE_FINISH_ERROR.VARIABLES_INVALID, '33 个键')

    A.equal(variablesArgs({ s: 'a'.repeat(512) }).variables.s.length, 512, '512 个字符是边界内')
    assertCodeSync(
      () => variablesArgs({ s: 'a'.repeat(513) }),
      NODE_FINISH_ERROR.VARIABLES_INVALID,
      '513 个字符',
    )
    // 「字符」按 Unicode 码点算：512 个 emoji 的 UTF-16 长度是 1024，但仍应通过。
    A.equal(variablesArgs({ s: '😀'.repeat(512) }).variables.s.length, 1024, '512 个 emoji 通过（按码点计数）')
    assertCodeSync(
      () => variablesArgs({ s: '😀'.repeat(513) }),
      NODE_FINISH_ERROR.VARIABLES_INVALID,
      '513 个 emoji',
    )

    const exact = variablesOfSerializedBytes(8192)
    A.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), 8192, '夹具必须恰好 8192 字节')
    A.equal(
      Object.keys(variablesArgs(exact).variables).length,
      Object.keys(exact).length,
      'UTF-8 JSON 正好 8192 字节通过',
    )
    const over = variablesOfSerializedBytes(8193)
    assertCodeSync(() => variablesArgs(over), NODE_FINISH_ERROR.VARIABLES_INVALID, '8193 字节')

    // 不允许的标量 / 嵌套结构。
    const forbiddenValues = [
      ['嵌套对象', { nested: true }],
      ['数组', [1, 2]],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['BigInt', 1n],
      ['undefined', undefined],
      ['函数', () => 1],
      ['Date', new Date()],
    ]
    for (const [label, value] of forbiddenValues) {
      assertCodeSync(
        () => variablesArgs({ v: value }),
        NODE_FINISH_ERROR.VARIABLES_INVALID,
        `变量值 ${label}`,
      )
    }
    assertCodeSync(
      () => variablesArgs(null),
      NODE_FINISH_ERROR.VARIABLES_INVALID,
      'variables 为 null',
    )
    assertCodeSync(
      () => variablesArgs([]),
      NODE_FINISH_ERROR.VARIABLES_INVALID,
      'variables 为数组',
    )

    // 危险键（JSON.parse 才会产生真正的 own "__proto__" 属性）。
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const dangerous = JSON.parse(`{"${key}":1}`)
      assertCodeSync(
        () => variablesArgs(dangerous),
        NODE_FINISH_ERROR.VARIABLES_INVALID,
        `危险键 ${key}`,
      )
    }

    // limits 可覆盖默认上限（A4 / 测试用）。
    assertCodeSync(
      () => variablesArgs({ a: 1, b: 2, c: 3 }, { maxVariables: 2 }),
      NODE_FINISH_ERROR.VARIABLES_INVALID,
      'limits.maxVariables=2 时 3 个键',
    )
    A.equal(
      Object.keys(variablesArgs({ a: 1, b: 2 }, { maxVariables: 2 }).variables).length,
      2,
      'limits.maxVariables=2 时 2 个键通过',
    )
  })

  // -------------------------------------------------------------------------
  // 3. documents：纯校验（路径 / 元数据 / 数量）
  // -------------------------------------------------------------------------
  await check('文档纯校验：路径规则 / kind·title·summary 上限 / 数量上限', () => {
    const docArgs = documents => validateFinishArgs({ variables: {}, documents, summary: '' })

    const validDoc = { path: 'docs/plan/0.13-方案.md', kind: 'markdown', title: '方案', summary: '这份文档是什么' }
    A.deepEqual(docArgs([validDoc]).documents, [validDoc], '合法文档原样归一化')
    A.deepEqual(
      docArgs([{ path: 'a.md' }]).documents[0],
      { path: 'a.md', kind: '', title: '', summary: '' },
      'kind / title / summary 可省略，归一化为空串',
    )
    A.equal(
      Object.hasOwn(docArgs([{ path: 'a.md', mime: 'text/markdown' }]).documents[0], 'mime'),
      false,
      '未知文档键被忽略（只保留契约内的四个字段）',
    )

    const badPaths = [
      ['空串', ''],
      ['绝对路径', '/etc/passwd'],
      ['点段逃逸', '../outside.md'],
      ['中间点段逃逸', 'docs/../outside.md'],
      ['反斜杠', 'docs\\plan.md'],
      ['空段', 'docs//plan.md'],
      ['尾空段', 'docs/'],
      ['当前目录段', './plan.md'],
      ['中间当前目录段', 'docs/./plan.md'],
      ['NUL', 'docs/a\0b.md'],
      ['超过 1024 字符', 'x'.repeat(1025)],
      ['非字符串', 42],
      ['缺失', undefined],
    ]
    for (const [label, path] of badPaths) {
      assertCodeSync(
        () => docArgs([{ path }]),
        NODE_FINISH_ERROR.DOCUMENT_INVALID,
        `非法路径：${label}`,
      )
    }
    A.equal(docArgs([{ path: 'x'.repeat(1024) }]).documents[0].path.length, 1024, '1024 字符路径是边界内')

    assertCodeSync(() => docArgs([{ path: 'a.md', kind: 'k'.repeat(65) }]), NODE_FINISH_ERROR.DOCUMENT_INVALID, 'kind 65 字符')
    A.equal(docArgs([{ path: 'a.md', kind: 'k'.repeat(64) }]).documents[0].kind.length, 64, 'kind 64 字符是边界内')
    assertCodeSync(() => docArgs([{ path: 'a.md', title: 't'.repeat(201) }]), NODE_FINISH_ERROR.DOCUMENT_INVALID, 'title 201 字符')
    A.equal(docArgs([{ path: 'a.md', title: 't'.repeat(200) }]).documents[0].title.length, 200, 'title 200 字符是边界内')
    assertCodeSync(() => docArgs([{ path: 'a.md', summary: 's'.repeat(201) }]), NODE_FINISH_ERROR.DOCUMENT_INVALID, '文档 summary 201 字符')
    A.equal(docArgs([{ path: 'a.md', summary: 's'.repeat(200) }]).documents[0].summary.length, 200, '文档 summary 200 字符是边界内')
    assertCodeSync(() => docArgs([{ path: 'a.md', kind: null }]), NODE_FINISH_ERROR.DOCUMENT_INVALID, 'kind 为 null')

    const docs32 = Array.from({ length: 32 }, (_, index) => ({ path: `docs/${index}.md` }))
    A.equal(docArgs(docs32).documents.length, 32, '32 份文档是边界内')
    assertCodeSync(
      () => docArgs([...docs32, { path: 'docs/32.md' }]),
      NODE_FINISH_ERROR.DOCUMENT_INVALID,
      '33 份文档',
    )

    for (const bad of [null, 'docs/a.md', {}]) {
      assertCodeSync(() => docArgs(bad), NODE_FINISH_ERROR.DOCUMENT_INVALID, 'documents 非数组')
    }
    for (const entry of [null, 'docs/a.md', ['docs/a.md']]) {
      assertCodeSync(() => docArgs([entry]), NODE_FINISH_ERROR.DOCUMENT_INVALID, '文档项非对象')
    }
  })

  // -------------------------------------------------------------------------
  // 4. 正常提交：两文档 + 3 变量
  // -------------------------------------------------------------------------
  await check('正常：markdown + 二进制两文档、3 个短变量 → record 与独立 sha256 一致', async () => {
    const workspace = freshWorkspace()
    const markdown = '# 0.13 方案\n\n这里只写正文，不进 record。\n'
    const binary = randomBytes(257)
    writeDoc(workspace, 'docs/plan/0.13-方案.md', markdown)
    writeDoc(workspace, 'build/out.bin', binary)

    const gate = makeGate(workspace, {
      executionId: 'exec-normal',
      nodeId: 'agent-normal',
      attempt: 3,
    })
    const args = {
      variables: { verdict: 'pass', reason_code: 'OK', score: 87, needs_review: false, note: null },
      documents: [
        { path: 'docs/plan/0.13-方案.md', kind: 'markdown', title: '方案', summary: '0.13 方案文档' },
        { path: 'build/out.bin', kind: 'binary', title: '构建产物' },
      ],
      summary: '写完了方案并产出二进制',
    }
    const submitted = await gate.submit(args)
    A.equal(submitted.ok, true, 'submit 返回 ok:true')
    const { record } = submitted

    A.deepEqual(Object.keys(record).sort(), ['artifacts', 'at', 'attempt', 'executionId', 'nodeId', 'output', 'summary'], 'record 顶层键')
    A.equal(record.executionId, 'exec-normal')
    A.equal(record.nodeId, 'agent-normal')
    A.equal(record.attempt, 3)
    A.deepEqual(record.output, args.variables, 'output 是归一化的短变量')
    A.equal(record.summary, args.summary)
    A.equal(record.at, FIXED_NOW.toISOString(), 'at 来自注入的 now()')
    A.equal(record.artifacts.length, 2)

    const [markdownArtifact, binaryArtifact] = record.artifacts
    A.deepEqual(
      Object.keys(markdownArtifact).sort(),
      ['at', 'attempt', 'bytes', 'kind', 'nodeId', 'path', 'sha256', 'title'],
      'artifact 字段冻结',
    )
    A.equal(markdownArtifact.path, 'docs/plan/0.13-方案.md')
    A.equal(markdownArtifact.sha256, sha256Of(markdown), 'sha256 与 crypto 独立计算一致')
    A.equal(markdownArtifact.bytes, Buffer.byteLength(markdown), 'bytes 与真实字节数一致')
    A.equal(markdownArtifact.kind, 'markdown')
    A.equal(markdownArtifact.title, '方案')
    A.equal(markdownArtifact.nodeId, 'agent-normal')
    A.equal(markdownArtifact.attempt, 3)
    A.equal(markdownArtifact.at, record.at, 'artifact.at 与 record.at 同一时间戳')

    A.equal(binaryArtifact.path, 'build/out.bin')
    A.equal(binaryArtifact.sha256, sha256Of(binary), '二进制 sha256 与独立计算一致')
    A.equal(binaryArtifact.bytes, 257)
    A.equal(binaryArtifact.kind, 'binary')
    A.equal(binaryArtifact.title, '构建产物')

    A.equal(JSON.stringify(record).includes('这里只写正文'), false, 'record 里没有文档正文')
    A.equal(await gate.result, record, 'result resolve 的就是 submit 返回的 record')
    A.equal(gate.settled(), true)
    A.equal(gate.reason(), null)
  })

  // -------------------------------------------------------------------------
  // 5. 宿主文档校验：每种失败都零登记
  // -------------------------------------------------------------------------
  await check('文档宿主校验：不存在 / 绝对 / 逃逸 / 符号链接 / >5 MiB / 校验中被改 → 零登记', async () => {
    // 5.1 文件不存在
    {
      const workspace = freshWorkspace()
      const gate = makeGate(workspace)
      const error = await rejection(gate.submit({
        variables: { verdict: 'pass' },
        documents: [{ path: 'docs/missing.md' }],
        summary: '缺文件',
      }))
      A.equal(error.code, NODE_FINISH_ERROR.DOCUMENT_INVALID, '不存在 → DOCUMENT_INVALID')
      A.equal(error.details?.path, 'docs/missing.md', '错误 details 带相对路径')
      A.equal(error.message.includes(workspace), false, '错误信息不回显绝对路径')
      A.equal(gate.settled(), false, '失败后闸门未 settled（零登记）')
      A.equal(await raceState(gate.result), 'pending', '失败后 result 未决议')
    }

    // 5.2 绝对路径（纯校验阶段就拒绝）
    {
      const workspace = freshWorkspace()
      const existing = writeDoc(workspace, 'docs/a.md', 'a')
      const gate = makeGate(workspace)
      const error = await rejection(gate.submit({
        variables: {},
        documents: [{ path: existing }],
        summary: '绝对路径',
      }))
      A.equal(error.code, NODE_FINISH_ERROR.DOCUMENT_INVALID)
      A.equal(error.details?.reason, 'absolute')
      A.equal(gate.settled(), false)
    }

    // 5.3 `..` 逃逸
    {
      const workspace = freshWorkspace()
      const outsideDir = freshWorkspace()
      writeDoc(outsideDir, 'outside.md', '越界内容')
      const gate = makeGate(workspace)
      const error = await rejection(gate.submit({
        variables: {},
        documents: [{ path: '../outside.md' }],
        summary: '点段逃逸',
      }))
      A.equal(error.code, NODE_FINISH_ERROR.DOCUMENT_INVALID)
      A.equal(error.details?.reason, 'dot-segment')
      A.equal(gate.settled(), false)
    }

    // 5.4 符号链接指向工作区外（realpath 逃逸）
    {
      const workspace = freshWorkspace()
      const outsideDir = freshWorkspace()
      const outsideFile = writeDoc(outsideDir, 'secret.md', '工作区外的内容')
      symlinkSync(outsideFile, join(workspace, 'link.md'))
      const gate = makeGate(workspace)
      const error = await rejection(gate.submit({
        variables: {},
        documents: [{ path: 'link.md', kind: 'markdown' }],
        summary: '符号链接逃逸',
      }))
      A.equal(error.code, NODE_FINISH_ERROR.DOCUMENT_INVALID)
      A.equal(error.details?.reason, 'outside-workspace')
      A.equal(gate.settled(), false)
    }

    // 5.5 >5 MiB（稀疏文件，不真写内容；预检直接拒绝）
    {
      const workspace = freshWorkspace()
      sparseFile(workspace, 'huge.bin', NODE_FINISH_LIMITS.maxDocumentBytes + 1)
      const gate = makeGate(workspace)
      const error = await rejection(gate.submit({
        variables: {},
        documents: [{ path: 'huge.bin' }],
        summary: '超过 5 MiB',
      }))
      A.equal(error.code, NODE_FINISH_ERROR.DOCUMENT_INVALID)
      A.equal(error.details?.reason, 'too-large')
      A.equal(gate.settled(), false)
    }

    // 5.6 校验中被改：文件变长（读完注入字节后追加）
    {
      const workspace = freshWorkspace()
      const absolute = writeDoc(workspace, 'docs/a.md', 'hello')
      const gate = makeGate(workspace, {
        readFile: async (realPath) => {
          const content = readFileSync(realPath)
          appendFileSync(realPath, 'x')
          return content
        },
      })
      const error = await rejection(gate.submit({
        variables: {},
        documents: [{ path: 'docs/a.md' }],
        summary: '校验中变长',
      }))
      A.equal(error.code, NODE_FINISH_ERROR.DOCUMENT_INVALID)
      A.equal(error.details?.reason, 'changed')
      A.equal(gate.settled(), false)
      A.equal(readFileSync(absolute, 'utf8'), 'hellox', '夹具确实改了文件')
    }

    // 5.7 校验中被改：读到的字节数不符（注入实现截断）
    {
      const workspace = freshWorkspace()
      writeDoc(workspace, 'docs/a.md', 'hello')
      const gate = makeGate(workspace, {
        readFile: async realPath => readFileSync(realPath).subarray(0, 4),
      })
      const error = await rejection(gate.submit({
        variables: {},
        documents: [{ path: 'docs/a.md' }],
        summary: '字节数不符',
      }))
      A.equal(error.code, NODE_FINISH_ERROR.DOCUMENT_INVALID)
      A.equal(error.details?.reason, 'size-mismatch')
      A.equal(gate.settled(), false)
    }

    // 5.8 校验中被改：mtime 变化（内容与字节数不变）
    {
      const workspace = freshWorkspace()
      const absolute = writeDoc(workspace, 'docs/a.md', 'hello')
      const gate = makeGate(workspace, {
        readFile: async (realPath) => {
          const content = readFileSync(realPath)
          const future = new Date(Date.now() + 5000)
          utimesSync(realPath, future, future)
          return content
        },
      })
      const error = await rejection(gate.submit({
        variables: {},
        documents: [{ path: 'docs/a.md' }],
        summary: 'mtime 变化',
      }))
      A.equal(error.code, NODE_FINISH_ERROR.DOCUMENT_INVALID)
      A.equal(error.details?.reason, 'changed')
      A.equal(gate.settled(), false)
      A.equal(readFileSync(absolute, 'utf8'), 'hello')
    }
  })

  // -------------------------------------------------------------------------
  // 6. 重复与并发
  // -------------------------------------------------------------------------
  await check('重复与并发：恰好一个成功，另一个 NODE_ALREADY_FINISHED，产物只登记一次', async () => {
    const workspace = freshWorkspace()
    writeDoc(workspace, 'docs/one.md', 'one')
    const gate = makeGate(workspace)
    const args = {
      variables: { verdict: 'pass' },
      documents: [{ path: 'docs/one.md', kind: 'markdown', title: '一' }],
      summary: '第一次',
    }

    const [first, second] = await Promise.allSettled([gate.submit(args), gate.submit(args)])
    const fulfilled = [first, second].filter(item => item.status === 'fulfilled')
    const rejected = [first, second].filter(item => item.status === 'rejected')
    A.equal(fulfilled.length, 1, '并发两次恰好一个成功')
    A.equal(rejected.length, 1, '并发两次恰好一个被拒')
    A.equal(rejected[0].reason.code, NODE_FINISH_ERROR.ALREADY_FINISHED, '另一个是 NODE_ALREADY_FINISHED')
    A.equal(fulfilled[0].value.record.artifacts.length, 1, '产物只登记一次')
    A.equal(fulfilled[0].value.record.summary, '第一次')

    const record = await gate.result
    A.equal(record.artifacts.length, 1, 'result 里的产物也只有一份')
    A.equal(gate.settled(), true)

    // 成功之后同一份参数再提交：幂等拒绝，不重复登记。
    await assertCode(gate.submit(args), NODE_FINISH_ERROR.ALREADY_FINISHED, '成功后重复提交')
    A.equal((await gate.result).artifacts.length, 1, '重复提交没有追加产物')
  })

  // -------------------------------------------------------------------------
  // 7. abort
  // -------------------------------------------------------------------------
  await check('abort：result reject 带 aborted 标记、submit 抛 NODE_ALREADY_SETTLED、无产物', async () => {
    const gate = makeGate(freshWorkspace())
    A.equal(gate.abort('activity-timeout'), true, '首次 abort 生效')
    A.equal(gate.abort('再次'), false, '重复 abort 是 no-op')
    A.equal(gate.settled(), true)
    A.equal(gate.reason(), 'activity-timeout', 'reason() 返回中止原因')

    const error = await rejection(gate.result)
    A.equal(error.code, NODE_FINISH_ERROR.ABORTED)
    A.equal(error.aborted, true, 'result reject 原因带 aborted 标记')
    A.equal(error.reason, 'activity-timeout')
    A.equal(error.details?.record, undefined, 'abort 不产生 record')
    A.match(error.message, /activity-timeout/, '中止原因写进可读信息')

    await assertCode(
      gate.submit({ variables: {}, documents: [], summary: '太晚了' }),
      NODE_FINISH_ERROR.ALREADY_SETTLED,
      'abort 之后 submit',
    )
    A.equal(gate.settled(), true)

    // 文档校验进行中被 abort：不能产生 record，也不能 resolve result。
    const workspace = freshWorkspace()
    writeDoc(workspace, 'docs/a.md', 'hello')
    let signalReadStarted
    const readStarted = new Promise(resolvePromise => { signalReadStarted = resolvePromise })
    let releaseRead
    const gateWhileReading = makeGate(workspace, {
      readFile: async (realPath) => {
        signalReadStarted()
        await new Promise(resolvePromise => { releaseRead = resolvePromise })
        return readFileSync(realPath)
      },
    })
    const pending = gateWhileReading.submit({
      variables: {},
      documents: [{ path: 'docs/a.md' }],
      summary: '校验中被中止',
    })
    await readStarted
    A.equal(gateWhileReading.abort('cancelled'), true)
    releaseRead()
    const submitError = await rejection(pending)
    A.equal(submitError.code, NODE_FINISH_ERROR.ALREADY_SETTLED, '进行中的 submit 因 abort 而失败')
    const resultError = await rejection(gateWhileReading.result)
    A.equal(resultError.code, NODE_FINISH_ERROR.ABORTED)
    A.equal(resultError.aborted, true)
    A.equal(gateWhileReading.settled(), true)
  })

  // -------------------------------------------------------------------------
  // 8. 失败后可修正重试
  // -------------------------------------------------------------------------
  await check('失败后可修正重试：非法变量 / 文档失败都不锁死闸门', async () => {
    const workspace = freshWorkspace()
    writeDoc(workspace, 'docs/ok.md', 'ok')
    const gate = makeGate(workspace)

    const variableError = await rejection(gate.submit({
      variables: { nested: { a: 1 } },
      documents: [],
      summary: '非法变量',
    }))
    A.equal(variableError.code, NODE_FINISH_ERROR.VARIABLES_INVALID)
    A.equal(gate.settled(), false)
    A.equal(await raceState(gate.result), 'pending')

    const documentError = await rejection(gate.submit({
      variables: {},
      documents: [{ path: 'docs/none.md' }],
      summary: '缺文件',
    }))
    A.equal(documentError.code, NODE_FINISH_ERROR.DOCUMENT_INVALID)
    A.equal(gate.settled(), false)

    const { record } = await gate.submit({
      variables: { verdict: 'pass' },
      documents: [{ path: 'docs/ok.md', kind: 'markdown', title: '修正后' }],
      summary: '修正后成功',
    })
    A.equal(record.output.verdict, 'pass')
    A.equal(record.artifacts.length, 1)
    A.equal(record.artifacts[0].path, 'docs/ok.md')
    A.equal(gate.settled(), true, '修正后成功、闸门 settled')
  })

  // -------------------------------------------------------------------------
  // 9. 5 MiB 边界 + 流式分块读取
  // -------------------------------------------------------------------------
  await check('5 MiB 边界：稀疏文件按 ≤64 KiB 分块喂 hash，sha256 与独立计算一致', async () => {
    const workspace = freshWorkspace()
    const size = NODE_FINISH_LIMITS.maxDocumentBytes
    const absolute = sparseFile(workspace, 'big/zero.bin', size)
    const chunkSizes = []
    const gate = makeGate(workspace, {
      createHash: (algorithm) => {
        const inner = createHash(algorithm)
        return {
          update(chunk) {
            chunkSizes.push(chunk.length)
            inner.update(chunk)
            return this
          },
          digest(encoding) {
            return inner.digest(encoding)
          },
        }
      },
    })

    const { record } = await gate.submit({
      variables: {},
      documents: [{ path: 'big/zero.bin', kind: 'binary', title: '5 MiB 边界' }],
      summary: '正好 5 MiB',
    })
    const artifact = record.artifacts[0]
    A.equal(artifact.bytes, size, 'bytes 等于文件大小')
    A.equal(
      artifact.sha256,
      createHash('sha256').update(Buffer.alloc(size)).digest('hex'),
      '5 MiB 稀疏文件 sha256 与独立计算一致',
    )
    A.equal(chunkSizes.length, size / NODE_FINISH_LIMITS.chunkBytes, '按 64 KiB 一块读完（80 块）')
    A.ok(chunkSizes.every(length => length > 0 && length <= NODE_FINISH_LIMITS.chunkBytes), '每块 ≤64 KiB')
    A.ok(chunkSizes.length > 1, '不是一次性整份读')
    A.equal(readFileSync(absolute).length, size, '文件本身确实是 5 MiB')
  })
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('node-finish.test.mjs')
console.log(`\n${checks} 组通过（${asserts} 条断言）`)
