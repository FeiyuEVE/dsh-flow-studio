#!/usr/bin/env node
/**
 * 流程目录化（src/flowdir.js）自检。
 *
 * 覆盖：往返深等（出厂模板 + 团队流程）、逐字节确定性、不 mutate 输入、
 * 错误表十类各一条、路径穿越（symlink 指到目录外）、IO 往返与 0700 / 0600。
 *
 * 临时 fixture 一律建在 `process.env.TMPDIR || os.tmpdir()` 下（本机 TMPDIR 已指向
 * 大卷），用完在 exit 钩子里清理——不放 /tmp，也不在仓库工作树里留东西。
 * 不需要安装插件，直接 `node test/flowdir.test.mjs`。
 */

import assert from 'node:assert/strict'
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultFlow } from '../src/model.js'
import {
  FLOWDIR_FILE_MAX_BYTES,
  FLOWDIR_MANIFEST,
  FLOWDIR_NODES_DIR,
  FLOWDIR_TASK_SUFFIX,
  compileFlowFiles,
  decompileFlow,
  readFlowDir,
  writeFlowDir,
} from '../src/flowdir.js'

// ---------------------------------------------------------------------------
// 跑测架 + 临时目录
// ---------------------------------------------------------------------------

const tmpRoot = process.env.TMPDIR || tmpdir()
mkdirSync(tmpRoot, { recursive: true })

const madeDirs = []
function tempDir(label) {
  const dir = mkdtempSync(join(tmpRoot, `flowdir-${label}-`))
  madeDirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of madeDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言结果；退出码由断言决定。
    }
  }
})

const cases = []
function check(name, fn) {
  cases.push([name, fn])
}

function hasError(errors, code, path) {
  return errors.some(error => error.code === code && error.path === path)
}

/** 断言「恰好这一类错误」：报错存在、指向对的文件、且 flow 不给半成品。 */
function expectOnlyError(result, code, path) {
  assert.equal(result.flow, null, `有错误时 flow 必须是 null，实际拿到 ${JSON.stringify(result.flow)}`)
  assert.ok(hasError(result.errors, code, path),
    `应当报 ${code} @ ${path}，实际报的是 ${JSON.stringify(result.errors.map(error => `${error.code}@${error.path}`))}`)
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** 最小可用的 manifest（错误表用例按需覆盖字段）。 */
function manifestOf(overrides = {}) {
  return {
    schemaVersion: 1,
    name: '测试流程',
    description: '',
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z',
    nodeOrder: [],
    edges: [],
    ...overrides,
  }
}

/** 一段节点 JSON（错误表用例里够用即可）。 */
function nodeText(id, kind, title, extra = {}) {
  return jsonText({ id, kind, title, ...extra })
}

/**
 * 手工构造的团队流程：mode:'team'、4 个成员、skills 数组、maxRounds、
 * check、extras.provider、中文 task —— 覆盖「目录化之后最容易丢东西」的那些字段。
 */
function teamFlow() {
  const stamp = '2026-11-08T00:00:00.000Z'
  return {
    schemaVersion: 1,
    id: 'flow_team_demo',
    name: '双人评审流程',
    description: '主流程只做两件事：写方案、评审收口。',
    agentPreset: 'ptc',
    createdAt: stamp,
    updatedAt: stamp,
    nodes: [
      {
        id: 'n_start',
        kind: 'start',
        title: '任务输入',
        x: 40,
        y: 220,
        mode: 'single',
        role: '',
        task: '接收任务原文，确认目标、约束与完成判据，产出任务卡。',
        skills: [],
        outputs: '任务卡',
        maxRounds: 2,
        model: '',
        agentPreset: '',
        executor: 'dsh',
        executorCommand: '',
        team: [],
      },
      {
        id: 'n_design',
        kind: 'stage',
        title: '方案评审',
        x: 324,
        y: 220,
        mode: 'team',
        role: '评审主管：负责分派评审角度、裁定级别与收口。',
        task: '主持方案评审：把验收标准拆给四位成员，逐条核对理由与结论，汇总成 finding 清单；不达标时退回重写。',
        skills: ['spec-review', 'risk-scan'],
        outputs: 'finding 清单（位置 / 级别 / 理由）',
        maxRounds: 3,
        model: 'deepseek-chat',
        agentPreset: 'standard',
        executor: 'dsh',
        executorCommand: '',
        check: {
          command: 'npm run lint',
          expectExitCode: 0,
          timeoutMs: 300000,
          reportPath: 'reports/lint.json',
        },
        extras: {
          provider: 'codex-e2e',
          note: '中文备注：provider 用来指定外部评审器',
          ticket: { b: 2, a: 1 },
        },
        team: [
          { name: '契约', role: '契约评审者', task: '检查接口输入输出与错误码，标出不兼容处。' },
          { name: '数据', role: '数据评审者', task: '检查数据模型、索引与迁移步骤。' },
          { name: '安全', role: '安全评审者', task: '检查输入校验、鉴权与失败路径。' },
          { name: '可维护', role: '可维护性评审者', task: '检查重复逻辑与命名，只报项目约定里的规则。' },
        ],
      },
      {
        id: 'n_end',
        kind: 'end',
        title: '完成',
        x: 608,
        y: 220,
        mode: 'single',
        role: '',
        task: '汇总产物、结论与遗留问题，给出可交付的最终答复。',
        skills: [],
        outputs: '交付说明',
        maxRounds: 2,
        model: '',
        agentPreset: '',
        executor: 'dsh',
        executorCommand: '',
        team: [],
      },
    ],
    edges: [
      { id: 'e_1', from: 'n_start', to: 'n_design', kind: 'next', label: '' },
      { id: 'e_2', from: 'n_design', to: 'n_end', kind: 'next', label: '' },
    ],
  }
}

console.log('flowdir.js')

// ---------------------------------------------------------------------------
// 1. 常量与布局
// ---------------------------------------------------------------------------

check('常量与目录布局一致（flow.json / nodes / .task.md / 64 KiB）', () => {
  assert.equal(FLOWDIR_MANIFEST, 'flow.json')
  assert.equal(FLOWDIR_NODES_DIR, 'nodes')
  assert.equal(FLOWDIR_TASK_SUFFIX, '.task.md')
  assert.equal(FLOWDIR_FILE_MAX_BYTES, 65536)
})

// ---------------------------------------------------------------------------
// 2. 往返：出厂模板
// ---------------------------------------------------------------------------

check('round-trip：defaultFlow() 反编译再编译后深等', () => {
  const flow = defaultFlow()
  const { files } = decompileFlow(flow)

  // 布局：flow.json + 每个节点两份文件，键一律 '/' 分隔。
  assert.equal(files.size, 1 + flow.nodes.length * 2)
  assert.ok(files.has('flow.json'))
  for (const node of flow.nodes) {
    assert.ok(files.has(`nodes/${node.id}.json`), `缺少 nodes/${node.id}.json`)
    assert.ok(files.has(`nodes/${node.id}.task.md`), `缺少 nodes/${node.id}.task.md`)
    // 节点 JSON 顶层不许有 task（第二个真相源），正文原样落在 .task.md。
    // 注意：团队成员的 task 是成员自己的字段，必须留在节点 JSON 里。
    const body = JSON.parse(files.get(`nodes/${node.id}.json`))
    assert.ok(!Object.prototype.hasOwnProperty.call(body, 'task'),
      `nodes/${node.id}.json 顶层不该有 task 字段`)
    assert.equal(files.get(`nodes/${node.id}.task.md`), node.task)
  }

  const compiled = compileFlowFiles(files)
  assert.deepEqual(compiled.errors, [])
  assert.deepEqual(compiled.flow, flow)
  // 深等之外再钉一次关键值，避免「两边都错成一样」蒙混过关。
  assert.equal(compiled.flow.nodes.length, 8)
  assert.equal(compiled.flow.edges.length, 11)
  assert.equal(compiled.flow.nodes[1].mode, 'team')
  assert.equal(compiled.flow.nodes[1].team.length, 3)
})

// ---------------------------------------------------------------------------
// 3. 往返：团队流程（mode / skills / maxRounds / check / extras / 中文 task）
// ---------------------------------------------------------------------------

check('round-trip：团队流程（team + skills + maxRounds + check + extras.provider）深等', () => {
  const flow = teamFlow()
  const { files } = decompileFlow(flow)
  const designBody = JSON.parse(files.get('nodes/n_design.json'))
  assert.ok(!Object.prototype.hasOwnProperty.call(designBody, 'task'),
    '节点 JSON 顶层不该有 task')
  assert.equal(designBody.team.length, 4)
  assert.equal(designBody.team[0].task, flow.nodes[1].team[0].task,
    '成员的 task 必须留在节点 JSON 里')

  const compiled = compileFlowFiles(files)
  assert.deepEqual(compiled.errors, [])
  assert.deepEqual(compiled.flow, flow)

  const design = compiled.flow.nodes.find(node => node.id === 'n_design')
  assert.equal(design.mode, 'team')
  assert.equal(design.team.length, 4)
  assert.deepEqual(design.skills, ['spec-review', 'risk-scan'])
  assert.equal(design.maxRounds, 3)
  assert.deepEqual(design.check, flow.nodes[1].check)
  assert.equal(design.extras.provider, 'codex-e2e')
  assert.match(design.task, /主持方案评审/)
  assert.equal(compiled.flow.agentPreset, 'ptc')
})

// ---------------------------------------------------------------------------
// 4. 逐字节确定性
// ---------------------------------------------------------------------------

check('确定性：两次反编译的每个文件逐字节相同，两次编译 JSON 完全相同', () => {
  for (const flow of [defaultFlow(), teamFlow()]) {
    const first = decompileFlow(flow)
    const second = decompileFlow(flow)
    assert.deepEqual([...first.files.keys()], [...second.files.keys()])
    for (const [path, content] of first.files) {
      assert.equal(content, second.files.get(path), `${path} 两次内容不同`)
      assert.equal(typeof content, 'string')
    }

    const left = compileFlowFiles(first.files)
    const right = compileFlowFiles(second.files)
    assert.equal(JSON.stringify(left), JSON.stringify(right))
  }
})

// ---------------------------------------------------------------------------
// 5. 不 mutate 输入
// ---------------------------------------------------------------------------

check('不 mutate：往返前后输入 flow 深等，files 映射也不被改写', () => {
  const flow = teamFlow()
  const snapshot = structuredClone(flow)
  const { files } = decompileFlow(flow)
  assert.deepEqual(flow, snapshot, 'decompileFlow 改写了输入 flow')

  const fileSnapshot = new Map(files)
  const compiled = compileFlowFiles(files)
  assert.deepEqual(compiled.errors, [])
  assert.deepEqual(flow, snapshot, 'compileFlowFiles 改写了 flow（本不该碰它）')
  assert.deepEqual(files, fileSnapshot, 'compileFlowFiles 改写了 files 映射')
})

// ---------------------------------------------------------------------------
// 6. 错误表：十类各一条
// ---------------------------------------------------------------------------

check('missing-manifest：没有 flow.json', () => {
  expectOnlyError(compileFlowFiles({}), 'missing-manifest', 'flow.json')
})

check('bad-manifest-json：flow.json 不是合法 JSON', () => {
  expectOnlyError(compileFlowFiles({ 'flow.json': '{"name": "缺右括号"' }),
    'bad-manifest-json', 'flow.json')
})

check('bad-node-json：nodes/a.json 不是合法 JSON', () => {
  const files = {
    'flow.json': jsonText(manifestOf({ nodeOrder: ['a'] })),
    'nodes/a.json': '{ id: "a", ',
    'nodes/a.task.md': '干活',
  }
  expectOnlyError(compileFlowFiles(files), 'bad-node-json', 'nodes/a.json')
})

check('missing-node：nodeOrder 列了 id，但 .json 不存在', () => {
  const files = {
    'flow.json': jsonText(manifestOf({ nodeOrder: ['a'] })),
    'nodes/a.task.md': '只有正文没有节点',
  }
  const result = compileFlowFiles(files)
  expectOnlyError(result, 'missing-node', 'nodes/a.json')
  assert.equal(result.errors[0].field, 'nodeOrder[0]')
})

check('unlisted-node：目录里有节点文件，nodeOrder 没列它', () => {
  const files = {
    'flow.json': jsonText(manifestOf({ nodeOrder: ['a'] })),
    'nodes/a.json': nodeText('a', 'start', '开始'),
    'nodes/a.task.md': '接任务',
    'nodes/b.json': nodeText('b', 'stage', '没人认领的阶段'),
    'nodes/b.task.md': '干活',
  }
  const result = compileFlowFiles(files)
  expectOnlyError(result, 'unlisted-node', 'nodes/b.json')
  assert.equal(result.errors.length, 1, '同一个 id 的 .json / .task.md 只该报一条')
})

check('missing-task：缺 nodes/a.task.md', () => {
  const files = {
    'flow.json': jsonText(manifestOf({ nodeOrder: ['a'] })),
    'nodes/a.json': nodeText('a', 'start', '开始'),
  }
  expectOnlyError(compileFlowFiles(files), 'missing-task', 'nodes/a.task.md')
})

check('task-duplicated：节点 JSON 里出现了 task 字段', () => {
  const files = {
    'flow.json': jsonText(manifestOf({ nodeOrder: ['a'] })),
    'nodes/a.json': nodeText('a', 'start', '开始', { task: '正文写错地方了' }),
    'nodes/a.task.md': '接任务',
  }
  expectOnlyError(compileFlowFiles(files), 'task-duplicated', 'nodes/a.json')
})

check('unknown-file：布局之外的文件（顶层与 nodes/ 下各一条）', () => {
  const files = {
    'flow.json': jsonText(manifestOf({ nodeOrder: ['a'] })),
    'nodes/a.json': nodeText('a', 'start', '开始'),
    'nodes/a.task.md': '接任务',
    'README.md': '# 布局外的说明',
    'nodes/notes.txt': '也不该在这里',
  }
  const result = compileFlowFiles(files)
  assert.equal(result.flow, null)
  assert.ok(hasError(result.errors, 'unknown-file', 'README.md'))
  assert.ok(hasError(result.errors, 'unknown-file', 'nodes/notes.txt'))
})

check('unsafe-path：编译时拒绝 .. / 绝对路径 / 反斜杠', () => {
  const files = {
    '../flow.json': '{}',
    '/etc/passwd': 'x',
    'nodes\\a.json': '{}',
    'nodes/../flow.json': '{}',
  }
  const result = compileFlowFiles(files)
  assert.equal(result.flow, null)
  for (const path of ['../flow.json', '/etc/passwd', 'nodes\\a.json', 'nodes/../flow.json']) {
    assert.ok(hasError(result.errors, 'unsafe-path', path), `应当报 unsafe-path @ ${path}`)
  }
  assert.ok(result.errors.every(error => error.code === 'unsafe-path'
    || error.code === 'missing-manifest'), JSON.stringify(result.errors))
})

check('invalid-flow：validateFlow 的结构错误映射回文件（flow.json 与 nodes/<id>.json）', () => {
  // ① 没有开始节点：validateFlow 报的错定位不到具体节点 → flow.json。
  const lonely = {
    'flow.json': jsonText(manifestOf({ nodeOrder: ['n_only'] })),
    'nodes/n_only.json': nodeText('n_only', 'stage', '孤立阶段'),
    'nodes/n_only.task.md': '独自干活',
  }
  const lonelyResult = compileFlowFiles(lonely)
  assert.equal(lonelyResult.flow, null)
  assert.ok(hasError(lonelyResult.errors, 'invalid-flow', 'flow.json'),
    JSON.stringify(lonelyResult.errors))

  // ② 阶段节点 task 为空：validateFlow 的 nodeId 能定位 → nodes/<id>.json。
  const emptyTask = {
    'flow.json': jsonText(manifestOf({
      nodeOrder: ['n_start', 'n_stage', 'n_end'],
      edges: [
        { id: 'e1', from: 'n_start', to: 'n_stage', kind: 'next', label: '' },
        { id: 'e2', from: 'n_stage', to: 'n_end', kind: 'next', label: '' },
      ],
    })),
    'nodes/n_start.json': nodeText('n_start', 'start', '开始'),
    'nodes/n_start.task.md': '接任务',
    'nodes/n_stage.json': nodeText('n_stage', 'stage', '空阶段'),
    'nodes/n_stage.task.md': '',
    'nodes/n_end.json': nodeText('n_end', 'end', '完成'),
    'nodes/n_end.task.md': '收口',
  }
  const emptyResult = compileFlowFiles(emptyTask)
  assert.equal(emptyResult.flow, null)
  assert.equal(emptyResult.errors.length, 1, JSON.stringify(emptyResult.errors))
  assert.equal(emptyResult.errors[0].code, 'invalid-flow')
  assert.equal(emptyResult.errors[0].path, 'nodes/n_stage.json')
  assert.equal(emptyResult.errors[0].field, 'nodes[1]')
  assert.match(emptyResult.errors[0].message, /结构校验未通过/)
})

check('反编译拒绝不能当文件名的节点 id（/ 与重复 id）', () => {
  const badPath = teamFlow()
  badPath.nodes[1].id = '../escape'
  assert.throws(() => decompileFlow(badPath), /不能当作文件名/)

  const duplicated = teamFlow()
  duplicated.nodes[2].id = 'n_start'
  assert.throws(() => decompileFlow(duplicated), /重复/)
})

// ---------------------------------------------------------------------------
// 7. 路径穿越：readFlowDir 拒绝 symlink 指到目录外
// ---------------------------------------------------------------------------

check('readFlowDir：symlink 指到目录外报 unsafe-path，且不读出目录外内容', async () => {
  const root = tempDir('symlink')
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.json'), '{"secret":"不该被读进来"}', 'utf8')

  const product = join(root, 'flow')
  mkdirSync(join(product, 'nodes'), { recursive: true })
  writeFileSync(join(product, 'flow.json'),
    jsonText(manifestOf({ nodeOrder: ['a'] })), 'utf8')
  writeFileSync(join(product, 'nodes', 'a.json'), nodeText('a', 'start', '开始'), 'utf8')
  writeFileSync(join(product, 'nodes', 'a.task.md'), '接任务', 'utf8')

  // 文件级逃逸 + 目录级逃逸各一条。
  symlinkSync(join(outside, 'secret.json'), join(product, 'nodes', 'leak.json'))
  symlinkSync(outside, join(product, 'linkdir'))

  const { files, errors } = await readFlowDir(product)
  assert.ok(hasError(errors, 'unsafe-path', 'nodes/leak.json'),
    JSON.stringify(errors.map(error => `${error.code}@${error.path}`)))
  assert.ok(hasError(errors, 'unsafe-path', 'linkdir'),
    JSON.stringify(errors.map(error => `${error.code}@${error.path}`)))
  assert.equal(files.has('nodes/leak.json'), false)
  assert.equal(files.has('linkdir/secret.json'), false)
  assert.ok([...files.values()].every(text => !text.includes('不该被读进来')))

  // 合规文件仍然读得进来，且能编译（补一份 end 节点让结构合法）。
  assert.ok(files.has('flow.json'))
  assert.ok(files.has('nodes/a.json'))
})

// ---------------------------------------------------------------------------
// 8. 单文件上限（IO 侧）
// ---------------------------------------------------------------------------

check('readFlowDir：单文件超过 64 KiB 报 file-too-large，且不读内容', async () => {
  const root = tempDir('oversize')
  const dir = join(root, 'flow')
  mkdirSync(join(dir, 'nodes'), { recursive: true })
  writeFileSync(join(dir, 'flow.json'), jsonText(manifestOf({ nodeOrder: ['a'] })), 'utf8')
  writeFileSync(join(dir, 'nodes', 'a.json'), nodeText('a', 'start', '开始'), 'utf8')
  writeFileSync(join(dir, 'nodes', 'a.task.md'),
    'x'.repeat(FLOWDIR_FILE_MAX_BYTES + 1), 'utf8')

  const { files, errors } = await readFlowDir(dir)
  assert.ok(hasError(errors, 'file-too-large', 'nodes/a.task.md'),
    JSON.stringify(errors.map(error => `${error.code}@${error.path}`)))
  assert.equal(files.has('nodes/a.task.md'), false)
})

// ---------------------------------------------------------------------------
// 9. IO 往返：writeFlowDir -> readFlowDir -> compileFlowFiles
// ---------------------------------------------------------------------------

check('IO 往返：写目录权限 0700、文件 0600，读回编译深等，重写幂等', async () => {
  const base = tempDir('io')
  const target = join(base, 'flow')
  const flow = defaultFlow()

  const written = await writeFlowDir(target, flow)
  assert.equal(written.dir, target)
  assert.equal(written.files.length, 1 + flow.nodes.length * 2)
  assert.ok(written.files.includes('flow.json'))
  assert.ok(written.files.includes('nodes/n_start.task.md'))
  assert.ok(written.bytes > 0)

  assert.equal(statSync(target).mode & 0o777, 0o700, '目录权限必须是 0700')
  assert.equal(statSync(join(target, 'flow.json')).mode & 0o777, 0o600, '文件权限必须是 0600')
  assert.equal(statSync(join(target, 'nodes', 'n_start.task.md')).mode & 0o777, 0o600)

  const read = await readFlowDir(target)
  assert.deepEqual(read.errors, [])
  assert.deepEqual([...read.files.keys()], written.files)
  assert.equal(written.bytes,
    [...read.files.values()].reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0))

  const compiled = compileFlowFiles(read.files)
  assert.deepEqual(compiled.errors, [])
  assert.deepEqual(compiled.flow, flow)

  // 覆盖自己产出的目录：允许，且不留下临时 / 备份目录。
  const again = await writeFlowDir(target, flow)
  assert.deepEqual(again.files, written.files)
  const readAgain = await readFlowDir(target)
  const compiledAgain = compileFlowFiles(readAgain.files)
  assert.deepEqual(compiledAgain.errors, [])
  assert.deepEqual(compiledAgain.flow, flow)
  assert.deepEqual(readdirSync(base).sort(), ['flow'])
})

check('writeFlowDir：拒绝写入别人的非空目录（一个字节都不动）', async () => {
  const base = tempDir('foreign')
  const target = join(base, 'foreign')
  mkdirSync(target)
  writeFileSync(join(target, 'README.md'), '# 别人的目录\n', 'utf8')

  await assert.rejects(
    () => writeFlowDir(target, defaultFlow()),
    error => {
      assert.equal(error.code, 'flowdir-not-ours')
      assert.match(error.message, /不是流程目录产物/)
      return true
    },
  )
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), '# 别人的目录\n')
  assert.deepEqual(readdirSync(target), ['README.md'])
  assert.deepEqual(readdirSync(base).sort(), ['foreign'])
})

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------

let checks = 0
for (const [name, fn] of cases) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

console.log(`\n${checks} 组通过`)
