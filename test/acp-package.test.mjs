#!/usr/bin/env node
/**
 * ACP 生产安装验收（0.15.0 / P5）。
 *
 * 单测能证明协议，但证明不了「宿主装的是这个包时，SDK / zod 能被解析」。
 * 这个测试把发布链完整跑一遍：
 *
 *   1. `node scripts/build.mjs` → `node scripts/verify-build.mjs`（构建产物的当前性）；
 *   2. `npm pack` → 在 `<repo>/.tmp/pack-<随机>/app` 里**只装生产依赖**
 *      （`--omit=dev --ignore-scripts`，npm cache / prefix 也在沙箱内）；
 *   3. 断言包内容：五个 ACP Host 模块存在且与 src 逐字节相同、lib 无多余文件、
 *      SDK/zod 在 `node_modules` 里且不在 `lib/`、devDependencies 没被装进来；
 *   4. 在 **bubblewrap 密封环境**（隐藏仓库与各级上级 `node_modules`、清 `NODE_PATH`）
 *      里导入已安装副本的 `lib/agent-adapter-acp.js`，用复制进副本的 fake ACP agent
 *      真正跑一次 probe（真实 MCP finish 桥 + discovery）；
 *   5. 变异：删掉副本里的 SDK / zod / 任一 host 模块后，同一份验收必须失败——
 *      证明它没有向上借用仓库的依赖。
 *
 * 运行：`node test/acp-package.test.mjs`（需要 bubblewrap；本仓库的验收机器已装）。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GENERATED_MODULES, HOST_MODULES } from '../scripts/build.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
const sandbox = mkdtempSync(join(repoRoot, '.tmp', 'pack-'))
const installRoot = join(sandbox, 'app')
const tmpBase = process.env.TMPDIR && isAbsolute(process.env.TMPDIR) ? process.env.TMPDIR : tmpdir()

let checks = 0
let asserts = 0
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

function check(name, fn) {
  try {
    fn()
    checks += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${error && error.message ? error.message : error}`)
    throw error
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    timeout: options.timeoutMs || 300_000,
    env: {
      ...process.env,
      ...(options.env || {}),
      TMPDIR: tmpBase,
    },
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} 失败（status=${result.status}）：\n`
      + `stdout:\n${String(result.stdout || '').slice(-3000)}\n`
      + `stderr:\n${String(result.stderr || '').slice(-3000)}`,
    )
  }
  return result
}

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function installedPackageRoot() {
  return join(installRoot, 'node_modules', '@feiyueve', 'dsh-flow-studio')
}

function installedModulePath(relative) {
  return join(installedPackageRoot(), relative)
}

/** 收集会向上“借用”的仓库级 node_modules（含软链解析后的真实目录）。 */
function repoNodeModulePaths() {
  const found = []
  let current = repoRoot
  for (;;) {
    const candidate = join(current, 'node_modules')
    if (existsSync(candidate)) {
      try {
        found.push(realpathSync(candidate))
      }
      catch {
        found.push(candidate)
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return [...new Set(found)]
}

function sealedRun(harness) {
  const hide = repoNodeModulePaths().flatMap(path => ['--tmpfs', path])
  const args = [
    '--dev-bind', '/', '/',
    ...hide,
    '--setenv', 'NODE_PATH', '',
    '--setenv', 'NODE_OPTIONS', '',
    '--setenv', 'TMPDIR', tmpBase,
    '--setenv', 'P5_INSTALL_ROOT', installRoot,
    '--setenv', 'P5_FAKE_AGENT', join(installRoot, 'fake', 'fake-acp-agent.mjs'),
    process.execPath, harness,
  ]
  return spawnSync('bwrap', args, {
    cwd: installRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: sandbox },
  })
}

const HARNESS = `#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const installRoot = process.env.P5_INSTALL_ROOT
const fixture = process.env.P5_FAKE_AGENT
const tmpBase = process.env.TMPDIR || tmpdir()
const shortRoot = mkdtempSync(join(tmpBase, 'p5i-'))

function fail(message) {
  process.stderr.write(String(message) + '\\n')
  process.exit(1)
}

const sdkUrl = await import.meta.resolve('@agentclientprotocol/sdk')
const zodUrl = await import.meta.resolve('zod')
const sdkPath = fileURLToPath(sdkUrl)
const zodPath = fileURLToPath(zodUrl)
const inside = path => path.startsWith(installRoot + '/')
if (!inside(sdkPath)) fail('SDK_NOT_INSIDE_INSTALL: ' + sdkPath)
if (!inside(zodPath)) fail('ZOD_NOT_INSIDE_INSTALL: ' + zodPath)

const sdkPkg = JSON.parse(readFileSync(join(installRoot, 'node_modules/@agentclientprotocol/sdk/package.json'), 'utf8'))
const zodPkg = JSON.parse(readFileSync(join(installRoot, 'node_modules/zod/package.json'), 'utf8'))

const configPath = join(shortRoot, 'agent.json')
const logPath = join(shortRoot, 'agent.log')
writeFileSync(configPath, JSON.stringify({ logPath, prompts: [{ kind: 'finish' }] }))
process.env.FLOW_STUDIO_ACP_CONFIG = JSON.stringify({
  command: process.execPath,
  args: [fixture, '--config', configPath],
  env: {},
  mode: 'workspace-write',
  permissionPolicy: 'deny',
})

const adapterUrl = pathToFileURL(join(installRoot, 'node_modules/@feiyueve/dsh-flow-studio/lib/agent-adapter-acp.js')).href
const { createAcpAdapter } = await import(adapterUrl)
const adapter = createAcpAdapter({ tmpRoot: shortRoot, controlTimeoutMs: 8000, helloTimeoutMs: 8000 })
const probe = await adapter.probe()
const log = readFileSync(logPath, 'utf8')
if (!log.includes('mcp-discovered')) fail('MCP_DISCOVERY_MISSING')
const out = {
  marker: '__P5_INSTALLED_OK__',
  installRoot,
  sdk: { version: sdkPkg.version, license: sdkPkg.license, path: sdkPath },
  zod: { version: zodPkg.version, license: zodPkg.license, path: zodPath },
  probe: {
    version: probe.version,
    protocolVersion: probe.protocolVersion,
    contacted: probe.agentMcp && probe.agentMcp.contacted,
    discovered: probe.agentMcp && probe.agentMcp.discovered,
  },
  cleanup: 'probe-cleanup',
}
process.stdout.write(JSON.stringify(out) + '\\n')
`

try {
  // -------------------------------------------------------------------------
  // 1. 构建 + verify（构建产物必须是当前源码）
  // -------------------------------------------------------------------------
  run(process.execPath, ['scripts/build.mjs'])
  run(process.execPath, ['scripts/verify-build.mjs'])
  console.log('  · build + verify-build 通过')

  // -------------------------------------------------------------------------
  // 2. npm pack → 隔离目录只装生产依赖
  // -------------------------------------------------------------------------
  const packResult = run('npm', ['pack', '--json', '--pack-destination', sandbox, '--silent'])
  // prepack 会把构建日志打到同一个 stdout；JSON 数组从第一个 `[` 开始（数组之后没有别的输出）。
  const packStdout = String(packResult.stdout || '')
  const jsonStart = packStdout.search(/\n\{\n\s{2}"[^"]+":\s*\{/)
  A.ok(jsonStart >= 0, `npm pack --json 输出里找不到 JSON 对象：\n${packStdout.slice(-1000)}`)
  const packedEntry = Object.values(JSON.parse(packStdout.slice(jsonStart + 1).trim()))
  A.equal(packedEntry.length, 1, 'npm pack 必须只产出一个 tarball')
  const packed = packedEntry[0]
  const tarball = join(sandbox, packed.filename)
  A.ok(existsSync(tarball), `npm pack 必须产出 tarball（${packed.filename}）`)
  A.ok(Array.isArray(packed.files), 'npm pack --json 必须给出文件清单')
  const packedFiles = packed.files.map(entry => entry.path)
  A.ok(!packedFiles.some(path => path.startsWith('node_modules/')), 'tarball 不得带 node_modules')
  A.ok(!packedFiles.some(path => path.startsWith('src/')), 'tarball 不得带 src/（lib 才是产物）')
  A.ok(packedFiles.includes('THIRD-PARTY.md'), 'tarball 必须带 THIRD-PARTY.md（许可告知义务）')

  mkdirSync(installRoot, { recursive: true })
  writeFileSync(join(installRoot, 'package.json'), `${JSON.stringify({ name: 'p5-install-check', private: true }, null, 2)}\n`)
  run('npm', [
    'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', tarball,
  ], {
    cwd: installRoot,
    env: {
      NODE_PATH: '',
      npm_config_cache: join(sandbox, 'npm-cache'),
      npm_config_prefix: join(sandbox, 'npm-prefix'),
    },
  })

  // -------------------------------------------------------------------------
  // 3. 包内容 / 依赖归属
  // -------------------------------------------------------------------------
  const pkgRoot = installedPackageRoot()
  A.ok(existsSync(pkgRoot), '安装副本里必须有 @feiyueve/dsh-flow-studio')

  const localPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const installedPkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
  A.equal(installedPkg.version, localPkg.version, '安装副本版本必须与当前 package.json 一致')
  A.equal(installedPkg.dependencies?.['@agentclientprotocol/sdk'], '2.6.0', 'SDK 必须是生产依赖（精确版本）')
  A.equal(installedPkg.dependencies?.zod, '4.6.7', 'zod 必须是生产依赖（精确版本）')
  A.equal(installedPkg.devDependencies?.['@agentclientprotocol/sdk'], undefined, 'SDK 不得放在 devDependencies')
  A.equal(installedPkg.devDependencies?.zod, undefined, 'zod 不得放在 devDependencies')

  const libDir = join(pkgRoot, 'lib')
  const libJs = readdirSync(libDir).filter(name => name.endsWith('.js')).sort()
  A.equal(libJs.length, HOST_MODULES.length + GENERATED_MODULES.length, `lib/*.js 数量必须等于构建清单（实际 ${libJs.length}）`)
  for (const file of HOST_MODULES) {
    const installed = join(libDir, file)
    A.ok(existsSync(installed), `安装副本缺失 Host 模块 lib/${file}`)
    const source = readFileSync(join(repoRoot, 'src', file))
    A.equal(sha256Of(readFileSync(installed)), sha256Of(source), `lib/${file} 必须与 src 逐字节相同`)
  }
  for (const file of GENERATED_MODULES) {
    A.ok(existsSync(join(libDir, file)), `安装副本缺失生成产物 lib/${file}`)
  }
  for (const acp of ['acp-client.js', 'acp-usage-ledger.js', 'acp-events.js', 'acp-policy.js', 'agent-adapter-acp.js']) {
    A.ok(HOST_MODULES.includes(acp), `${acp} 必须在 HOST_MODULES 里`)
    A.ok(existsSync(join(libDir, acp)), `安装副本必须带 lib/${acp}`)
  }

  const sdkPkg = JSON.parse(readFileSync(join(installRoot, 'node_modules', '@agentclientprotocol', 'sdk', 'package.json'), 'utf8'))
  const zodPkg = JSON.parse(readFileSync(join(installRoot, 'node_modules', 'zod', 'package.json'), 'utf8'))
  A.equal(sdkPkg.version, '2.6.0', '生产安装必须装到 SDK 2.6.0')
  A.equal(sdkPkg.license, 'Apache-2.0', 'SDK 许可必须是 Apache-2.0')
  A.equal(zodPkg.version, '4.6.7', '生产安装必须装到 zod 4.6.7')
  A.equal(zodPkg.license, 'MIT', 'zod 许可必须是 MIT')

  // SDK / zod 不能被拷进 lib，也不能被 bundle 进产物（依赖必须在 node_modules 解析）。
  A.ok(!existsSync(join(libDir, 'node_modules')), 'lib/ 不得出现 node_modules')
  const bundleText = readFileSync(join(libDir, 'acp-client.js'), 'utf8')
  A.ok(bundleText.includes("@agentclientprotocol/sdk"), 'acp-client 必须走运行时 import（不内联 SDK）')
  A.ok(!readdirSync(libDir).some(name => /agentclientprotocol|^zod/.test(name)), 'lib/ 不得 vendor SDK/zod')

  // 只装生产依赖：devDependencies 一个都不能出现。
  for (const dev of ['esbuild', 'playwright-core', 'bpmn-js']) {
    A.ok(!existsSync(join(installRoot, 'node_modules', dev)), `--omit=dev 不得安装 devDependency ${dev}`)
  }

  // -------------------------------------------------------------------------
  // 4. 密封环境里导入已安装副本并打开 fake ACP 连接（真实 MCP finish）
  // -------------------------------------------------------------------------
  const fixtureCopy = join(installRoot, 'fake', 'fake-acp-agent.mjs')
  mkdirSync(dirname(fixtureCopy), { recursive: true })
  cpSync(join(repoRoot, 'test', 'fixtures', 'fake-acp-agent.mjs'), fixtureCopy)
  const harness = join(installRoot, 'verify-installed.mjs')
  writeFileSync(harness, HARNESS)

  const bwrapCheck = spawnSync('bwrap', ['--version'], { encoding: 'utf8' })
  if (bwrapCheck.status !== 0) {
    throw new Error('需要 bubblewrap 来隐藏仓库/上级 node_modules（agent-sandbox skill 的 fast 档）；本机 bwrap 不可用')
  }
  A.ok(repoNodeModulePaths().length > 0, '本机应存在至少一个仓库级 node_modules 供遮蔽（否则测试证明不了“不向上借用”）')

  const baseline = sealedRun(harness)
  A.equal(baseline.status, 0, `密封环境 baseline 必须成功：\nstdout:\n${baseline.stdout}\nstderr:\n${baseline.stderr}`)
  A.ok(String(baseline.stdout).includes('__P5_INSTALLED_OK__'), 'baseline 必须产出完成标记')
  const evidence = JSON.parse(String(baseline.stdout).trim().split('\n').at(-1))
  A.ok(evidence.sdk.path.startsWith(join(installRoot, 'node_modules')), 'SDK 必须从安装副本解析')
  A.ok(evidence.zod.path.startsWith(join(installRoot, 'node_modules')), 'zod 必须从安装副本解析')
  A.equal(evidence.probe.contacted, true, 'agent 必须真的拉起 finish MCP（hello）')
  A.equal(evidence.probe.discovered, true, 'agent 必须真的完成 tools/list discovery')

  // -------------------------------------------------------------------------
  // 5. 变异：删依赖 / 删 host 模块后必须失败（不许向上借用）
  // -------------------------------------------------------------------------
  function mutationMustFail(label, relativePath) {
    const target = join(installRoot, relativePath)
    const backup = `${target}.p5-bak`
    A.ok(existsSync(target), `变异前置：${relativePath} 必须存在`)
    renameSync(target, backup)
    try {
      const mutated = sealedRun(harness)
      A.notEqual(mutated.status, 0, `${label}：密封验收必须以非零退出失败`)
      A.ok(
        !String(mutated.stdout).includes('__P5_INSTALLED_OK__'),
        `${label}：不能被判为通过`,
      )
      const message = `${mutated.stdout}\n${mutated.stderr}`
      A.ok(
        /Cannot find module|ERR_MODULE_NOT_FOUND|SDK_NOT_INSIDE_INSTALL|ZOD_NOT_INSIDE_INSTALL/.test(message),
        `${label}：失败原因必须是模块解析失败（实际：${message.slice(-500)}）`,
      )
    }
    finally {
      renameSync(backup, target)
    }
    const restored = sealedRun(harness)
    A.equal(restored.status, 0, `${label}：恢复后必须重新通过（证明变异本身有效）`)
  }

  check('打包：删掉安装副本的 SDK → 密封验收必须失败', () => {
    mutationMustFail('删 SDK', 'node_modules/@agentclientprotocol/sdk')
  })
  check('打包：删掉安装副本的 zod → 密封验收必须失败', () => {
    mutationMustFail('删 zod', 'node_modules/zod')
  })
  check('打包：删掉安装副本的 ACP host 模块（acp-policy.js）→ 密封验收必须失败', () => {
    mutationMustFail('删 host 模块', 'node_modules/@feiyueve/dsh-flow-studio/lib/acp-policy.js')
  })

  console.log(`✓ acp-package：${checks} 组检查，${asserts} 条断言`)
}
finally {
  rmSync(sandbox, { recursive: true, force: true })
}
