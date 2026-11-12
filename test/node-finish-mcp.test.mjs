#!/usr/bin/env node
/**
 * `node-finish-mcp.js` 自检：官方 MCP SDK 的 **真实 stdio 往返** + 本地完成通道。
 *
 * 覆盖（对应任务书 1 / 5）：
 *   1. 起真实 `node src/node-finish-mcp.js` 子进程，用官方 SDK 的 `Client`（stdio）走
 *      `initialize → tools/list → tools/call`：工具名 / schema / 成功写入 gate /
 *      非法参数返回结构化错误且 gate 未 settled / 重复调用 NODE_ALREADY_FINISHED；
 *   2. 跨 execution 复用凭据：拿 A execution 的凭据去连 B execution 的通道 → 
 *      `NODE_FINISH_CHANNEL_FAILED`，B 的 gate submit 调用数 0，且错误文本里没有凭据；
 *   3. 通道不可用（socket 不存在）→ 结构化 `NODE_FINISH_CHANNEL_FAILED`，不抛崩溃；
 *   4. 缺环境变量启动 → 进程以非零码退出，且不在 stdout 输出任何协议外内容。
 *
 * 全程用项目 `.tmp/` 下的临时工作区，不碰 `~/.dsh`、不启动 dsh、不发网络请求。
 * 运行：node test/node-finish-mcp.test.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { createFinishGate } from '../src/node-finish.js'
import {
  FINISH_CHANNEL_ENV, FINISH_CHANNEL_ERROR, FINISH_TOOL_NAME, FINISH_REMINDER_TEXT,
  createFinishChannel, defaultTmpRoot, verifyFinishBridge,
} from '../src/node-finish-mcp.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_PATH = join(repoRoot, 'src', 'node-finish-mcp.js')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
// 前缀刻意短：finish.sock 是 unix socket，路径总长必须留在 sockaddr_un 的 108 字节以内。
const sandbox = mkdtempSync(join(repoRoot, '.tmp', 'nm-'))

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
async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

let caseSeq = 0
function freshWorkspace() {
  const dir = join(sandbox, `case-${++caseSeq}`)
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o700)
  return dir
}

function makeGate(workspace, overrides = {}) {
  return createFinishGate({
    executionId: 'exec-1',
    nodeId: 'agent-1',
    attempt: 2,
    workspaceRoot: workspace,
    now: () => new Date('2026-11-11T12:34:56.789Z'),
    ...overrides,
  })
}

/** 打开一个真实 MCP stdio client（起 node-finish-mcp.js 子进程）。 */
async function openClient(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: { ...process.env, ...env },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'node-finish-mcp-test', version: '1.0.0' })
  const stderrChunks = []
  transport.stderr?.on('data', chunk => stderrChunks.push(String(chunk)))
  await client.connect(transport)
  return {
    client,
    transport,
    stderr: () => stderrChunks.join(''),
    async close() {
      try {
        await client.close()
      } catch {
        // ignore
      }
    },
  }
}

function parseResult(result) {
  A.equal(result.isError, undefined, '成功调用不应是 isError')
  A.equal(result.content?.[0]?.type, 'text', '结果第一块是 text')
  return JSON.parse(result.content[0].text)
}

function parseError(result) {
  A.equal(result.isError, true, '失败调用必须 isError:true')
  const payload = JSON.parse(result.content[0].text)
  A.equal(payload.ok, false, '错误体 ok=false')
  A.equal(typeof payload.error.code, 'string', '错误体有 code')
  A.equal(typeof payload.error.message, 'string', '错误体有中文 message')
  return payload.error
}

const opened = []
const channels = []

async function openChannel(options) {
  const channel = await createFinishChannel(options)
  channels.push(channel)
  return channel
}

async function main() {
  console.log('node-finish-mcp：真实 MCP stdio 往返 + 完成通道')
  try {

  await check('initialize / tools/list：工具名与 11 §2 schema', async () => {
    const ws = freshWorkspace()
    const gate = makeGate(ws)
    const channel = await openChannel({ gate, dir: ws })
    const session = await openClient(channel.env)
    opened.push(session)
    // initialize 已完成（SDK client.connect 内部走完 initialize + initialized）。
    A.equal(session.client.getServerVersion().name, 'flow-studio-finish')
    const listed = await session.client.listTools()
    A.equal(listed.tools.length, 1, '只暴露一个工具')
    const tool = listed.tools[0]
    A.equal(tool.name, FINISH_TOOL_NAME, '工具名冻结为 flow_finish_node')
    A.match(tool.description, /flow_finish_node/, 'description 说明必须调用')
    A.equal(tool.inputSchema.type, 'object')
    A.equal(tool.inputSchema.additionalProperties, false)
    A.deepEqual([...tool.inputSchema.required].sort(), ['documents', 'summary', 'variables'])
    A.equal(tool.inputSchema.properties.variables.maxProperties, 32)
    A.equal(tool.inputSchema.properties.documents.maxItems, 32)
    A.equal(tool.inputSchema.properties.documents.items.required[0], 'path')
    A.equal(tool.inputSchema.properties.summary.maxLength, 500)
    // tools/list 记一次 discovery（诊断信号，不是完成信号）。
    A.equal(channel.discovered, true, 'tools/list 已发生')
    await session.close()
    await channel.close()
  })

  await check('tools/call：非法参数返回结构化错误且 gate 未 settled', async () => {
    const ws = freshWorkspace()
    const gate = makeGate(ws)
    const channel = await openChannel({ gate, dir: ws })
    const session = await openClient(channel.env)
    opened.push(session)

    const badTop = parseError(await session.client.callTool({
      name: FINISH_TOOL_NAME,
      arguments: { variables: {}, documents: [], summary: 'x', extra: 1 },
    }))
    A.equal(badTop.code, 'NODE_FINISH_INVALID')
    A.equal(gate.settled(), false, '顶层非法不占用闸门')

    const badSummary = parseError(await session.client.callTool({
      name: FINISH_TOOL_NAME,
      arguments: { variables: {}, documents: [], summary: 42 },
    }))
    A.equal(badSummary.code, 'NODE_FINISH_INVALID')

    const badVars = parseError(await session.client.callTool({
      name: FINISH_TOOL_NAME,
      arguments: { variables: { nested: { a: 1 } }, documents: [], summary: 'x' },
    }))
    A.equal(badVars.code, 'NODE_VARIABLES_INVALID')
    A.equal(badVars.details.field, 'variables.nested')

    const badDoc = parseError(await session.client.callTool({
      name: FINISH_TOOL_NAME,
      arguments: { variables: {}, documents: [{ path: '../escape.md' }], summary: 'x' },
    }))
    A.equal(badDoc.code, 'NODE_DOCUMENT_INVALID')
    A.equal(gate.settled(), false, '连续非法调用后闸门仍未 settled')

    // 修正后可成功；错误信息里不出现文档正文 / 凭据。
    A.equal(badDoc.message.includes(channel.credential), false, '错误不泄漏凭据')
    A.match(badDoc.message, /[\u4e00-\u9fa5]/, '错误是中文可行动原因')

    writeFileSync(join(ws, 'plan.md'), '# 方案\n正文\n')
    const ok = parseResult(await session.client.callTool({
      name: FINISH_TOOL_NAME,
      arguments: {
        variables: { verdict: 'pass', score: 87, needs_review: false, note: null },
        documents: [{ path: 'plan.md', kind: 'markdown', title: '方案', summary: '一句话' }],
        summary: '节点完成',
      },
    }))
    A.equal(ok.ok, true)
    A.deepEqual(ok.record.output, { verdict: 'pass', score: 87, needs_review: false, note: null })
    A.equal(ok.record.artifacts.length, 1)
    A.equal(ok.record.artifacts[0].path, 'plan.md')
    A.equal(ok.record.artifacts[0].bytes, Buffer.byteLength('# 方案\n正文\n'))
    A.equal(
      ok.record.artifacts[0].sha256,
      createHash('sha256').update('# 方案\n正文\n').digest('hex'),
    )
    A.equal(gate.settled(), true, 'gate 已 settled')
    A.deepEqual(await gate.result, ok.record, 'gate.result 与工具结果一致')

    const duplicate = parseError(await session.client.callTool({
      name: FINISH_TOOL_NAME,
      arguments: { variables: {}, documents: [], summary: 'again' },
    }))
    A.equal(duplicate.code, 'NODE_ALREADY_FINISHED')

    await session.close()
    await channel.close()
  })

  await check('跨 execution 复用凭据：NODE_FINISH_CHANNEL_FAILED，gate 调用数 0', async () => {
    const wsA = freshWorkspace()
    const wsB = freshWorkspace()
    const gateA = makeGate(wsA, { executionId: 'exec-A' })
    const channelA = await openChannel({ gate: gateA, dir: wsA })
    const gateB = makeGate(wsB, { executionId: 'exec-B' })
    let submitCalls = 0
    const spyGateB = {
      submit: args => {
        submitCalls += 1
        return gateB.submit(args)
      },
      settled: () => gateB.settled(),
      result: gateB.result,
      abort: gateB.abort,
      reason: gateB.reason,
    }
    const channelB = await openChannel({ gate: spyGateB, dir: wsB })

    // 用 A 的凭据 + B 的通道（模拟另一 execution 的进程偷用旧凭据）。
    const session = await openClient({
      [FINISH_CHANNEL_ENV.socket]: channelB.socketPath,
      [FINISH_CHANNEL_ENV.token]: channelA.credential,
    })
    opened.push(session)
    const error = parseError(await session.client.callTool({
      name: FINISH_TOOL_NAME,
      arguments: { variables: { verdict: 'pass' }, documents: [], summary: 'cross-exec' },
    }))
    A.equal(error.code, FINISH_CHANNEL_ERROR.FAILED)
    A.equal(error.details.reason, 'credential-mismatch')
    A.equal(submitCalls, 0, 'B 的 gate 一次都没被调用')
    A.equal(gateB.settled(), false)
    A.equal(channelB.mismatch, true)
    A.equal(error.message.includes(channelA.credential), false, '错误信息不含凭据')
    A.equal(error.message.includes(channelB.credential), false, '错误信息不含本通道凭据')

    // B 通道本身没坏：用正确凭据仍然能完结。
    const correct = await channelB.invoke('submit', {
      variables: { verdict: 'pass' }, documents: [], summary: 'correct',
    })
    A.equal(correct.ok, true)
    A.equal(submitCalls, 1)
    A.equal(gateB.settled(), true)

    await session.close()
    await channelA.close()
    await channelB.close()
  })

  await check('通道不可用（socket 不存在）：结构化失败，不崩', async () => {
    const session = await openClient({
      [FINISH_CHANNEL_ENV.socket]: join(sandbox, 'no-such.sock'),
      [FINISH_CHANNEL_ENV.token]: 'f'.repeat(64),
    })
    opened.push(session)
    const error = parseError(await session.client.callTool({
      name: FINISH_TOOL_NAME,
      arguments: { variables: {}, documents: [], summary: 'x' },
    }))
    A.equal(error.code, FINISH_CHANNEL_ERROR.FAILED)
    A.match(error.message, /[\u4e00-\u9fa5]/)
    await session.close()
  })

  await check('缺环境变量启动：非零退出，stdout 无协议外内容', async () => {
    const result = await new Promise(resolveRun => {
      const child = spawn(process.execPath, [SERVER_PATH], {
        env: { PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('exit', code => resolveRun({ code, stdout, stderr }))
    })
    A.notEqual(result.code, 0, '缺配置必须非零退出')
    A.equal(result.stdout, '', 'stdout 只承载 MCP 协议，这里应为空')
    A.match(result.stderr, /完成通道/, 'stderr 说明拒绝启动原因')
  })

  await check('通道提醒计数：onFire / exhausted / settled 后不再提醒', async () => {
    const ws = freshWorkspace()
    const gate = makeGate(ws)
    const fires = []
    const channel = await openChannel({
      gate,
      dir: ws,
      maxReminders: 2,
      onReminder: info => fires.push(info.count),
    })
    const first = await channel.invoke('remind')
    A.deepEqual(first, { ok: true, action: 'remind', count: 1, maxFires: 2, text: FINISH_REMINDER_TEXT })
    const second = await channel.invoke('remind')
    A.equal(second.action, 'remind')
    A.equal(second.count, 2)
    const exhausted = await channel.invoke('remind')
    A.equal(exhausted.action, 'exhausted')
    A.deepEqual(fires, [1, 2])
    const ok = await channel.invoke('submit', { variables: {}, documents: [], summary: '' })
    A.equal(ok.ok, true)
    A.equal(gate.settled(), true)
    const after = await channel.invoke('remind')
    A.equal(after.action, 'none', '完结之后不再提醒')
    await channel.close()
  })

  await check('verifyFinishBridge：自检真实走通 initialize → list → call', async () => {
    const result = await verifyFinishBridge({ tmpRoot: join(repoRoot, '.tmp') })
    A.equal(result.ok, true, `自检失败：${JSON.stringify(result)}`)
    A.equal(result.toolName, FINISH_TOOL_NAME)
    A.equal(result.record.output.probe, true)
  })

  await check('m6：默认临时根是 $FLOW_STUDIO_TMP / os.tmpdir()/flow-studio，目录 0700 且用完清理', async () => {
    const previous = process.env.FLOW_STUDIO_TMP
    try {
      delete process.env.FLOW_STUDIO_TMP
      // C3：TMPDIR 指向仓库下的临时子目录（本项目约定的 .tmp/）是合法配置，不能假红。
      // 真正要拦的回归是「默认根退化成仓库根 / 插件安装目录（两者在本仓库同路径）」。
      const defaultRoot = resolve(defaultTmpRoot())
      A.notEqual(defaultRoot, repoRoot, '默认根不能恰好是仓库根 / 插件安装目录')
      A.equal(defaultRoot, resolve(join(tmpdir(), 'flow-studio')), '无环境变量时用 os.tmpdir()/flow-studio')
      // 用一个**短**根：Unix socket 路径有 108 字节上限（含结尾 NUL），深层 worktree
      // 下 TMPDIR 本身就可能接近上限。前缀压到最短，保证 `<root>/fs-bridge-*/finish.sock`
      // 仍能 listen；长中文仓库路径 + 长前缀会直接 EINVAL。
      const customRoot = mkdtempSync(join(tmpdir(), 't-'))
      try {
        process.env.FLOW_STUDIO_TMP = customRoot
        A.equal(defaultTmpRoot(), resolve(customRoot), 'FLOW_STUDIO_TMP 覆盖默认根')
        const result = await verifyFinishBridge()
        A.equal(result.ok, true, `自检失败：${JSON.stringify(result)}`)
        A.equal(existsSync(customRoot), true)
        A.equal(statSync(customRoot).mode & 0o777, 0o700, '临时根必须是 0700')
        A.deepEqual(
          readdirSync(customRoot).filter(name => name.startsWith('fs-bridge-')),
          [],
          '自检目录用完即删',
        )
      } finally {
        rmSync(customRoot, { recursive: true, force: true })
      }
    } finally {
      if (previous === undefined) delete process.env.FLOW_STUDIO_TMP
      else process.env.FLOW_STUDIO_TMP = previous
    }
  })

  await check('M5：verifyFinishBridge 子进程只继承白名单 env（宿主 secret 不泄漏）', async () => {
    const envOut = join(sandbox, 'bridge-env.json')
    const fakeServer = join(sandbox, 'fake-mcp-server.mjs')
    writeFileSync(fakeServer, [
      "import { writeFileSync } from 'node:fs'",
      'writeFileSync(process.env.PROBE_ENV_OUT, JSON.stringify(Object.keys(process.env).sort()))',
      'process.exit(1)',
      '',
    ].join('\n'))
    process.env.HOST_SECRET_SENTINEL = `sentinel-${Math.random().toString(16).slice(2)}`
    const shortRoot = mkdtempSync(join(tmpdir(), 'e-'))
    try {
      const result = await verifyFinishBridge({
        tmpRoot: shortRoot,
        serverPath: fakeServer,
        timeoutMs: 3_000,
        env: { PROBE_ENV_OUT: envOut },
      })
      A.equal(result.ok, false, '假 server 退出 → 自检必须失败')
      A.equal(existsSync(envOut), true, '假 server 确实跑到了')
      const names = JSON.parse(readFileSync(envOut, 'utf8'))
      A.equal(names.includes('HOST_SECRET_SENTINEL'), false, 'M5：宿主 secret 不得继承给自检子进程')
      A.equal(names.includes('PROBE_ENV_OUT'), true, '调用方显式 env 仍透传')
      A.equal(names.includes(FINISH_CHANNEL_ENV.token), true, '通道 env 必须透传')
      A.equal(names.includes('PATH'), true)
    } finally {
      delete process.env.HOST_SECRET_SENTINEL
      rmSync(shortRoot, { recursive: true, force: true })
    }
  })

  await check('m9：verifyFinishBridge 对挂住的 MCP server 有超时（不挂死调用方）', async () => {
    const hangServer = join(sandbox, 'hang-mcp-server.mjs')
    writeFileSync(hangServer, 'setInterval(() => {}, 1000)\n')
    const shortRoot = mkdtempSync(join(tmpdir(), 'h-'))
    try {
      const started = Date.now()
      const result = await verifyFinishBridge({ tmpRoot: shortRoot, serverPath: hangServer, timeoutMs: 800 })
      A.equal(result.ok, false)
      A.equal(result.reason, 'timeout')
      A.equal(result.step, 'connect')
      A.ok(Date.now() - started < 8_000, '自检必须在有限时间内失败')
      A.deepEqual(
        readdirSync(shortRoot).filter(name => name.startsWith('fs-bridge-')),
        [],
        '超时路径也要清理自检目录',
      )
    } finally {
      rmSync(shortRoot, { recursive: true, force: true })
    }
  })

  } finally {
    // 兜底清理：任何 client / 通道没关掉都不留子进程。
    for (const session of opened) {
      try {
        await session.close()
      } catch {
        // ignore
      }
    }
    for (const channel of channels) {
      try {
        await channel.close()
      } catch {
        // ignore
      }
    }
    rmSync(sandbox, { recursive: true, force: true })
  }
  console.log(`\n${checks} 组 / ${asserts} 条断言全部通过`)
}

main().then(() => {
  process.exit(0)
}, error => {
  console.error(error)
  process.exit(1)
})
