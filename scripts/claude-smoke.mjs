#!/usr/bin/env node
/**
 * Claude Code 适配器的**真实通道** smoke（0.14.2 G）。
 *
 * 单测（`test/agent-adapter-claude.test.mjs`）用假 CLI 覆盖协议与失败语义，但真实
 * `claude` CLI 是否真的接受本适配器生成的 `--mcp-config`、是否会在 `-p` 非交互运行里
 * 拉起 MCP server 并让模型调用 `flow_finish_node`，只能在**装了 CLI 的机器**上验证。
 *
 * 用法：
 *   node scripts/claude-smoke.mjs
 *   CLAUDE_BIN=/path/to/claude node scripts/claude-smoke.mjs
 *
 * 退出状态（可辨识，不把「跳过」和「失败」混在一起）：
 *   - 0 + `{"ok":true,"skipped":true,...}`：本机没有 claude CLI，**没有验收**，不是通过；
 *   - 0 + `{"ok":true,"skipped":false,...}`：真实通道走通（probe + 真模型调用工具完结）；
 *   - 1 + `{"ok":false,...}`：真实通道失败（probe 不可用 / 超时 / 没调工具 / 其它错误）。
 *
 * 产物与临时工作区都放仓库 `.tmp/`（不写 /tmp），结束时删除。
 *
 * @module @feiyueve/dsh-flow-studio/scripts/claude-smoke
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, promises as fsp } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClaudeAdapter } from '../src/agent-adapter-claude.js'
import { createFinishGate } from '../src/node-finish.js'
import { discoverClaudeCli } from './claude-cli-discovery.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SMOKE_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.CLAUDE_SMOKE_TIMEOUT_MS || '', 10)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 180_000
})()

/** 打印一行 JSON（机器可读；不打印任何凭据）。 */
function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/** CLI 发现走共享 helper（CLAUDE_BIN 优先 → PATH 搜索并校验可执行，m6）。 */
function findClaudeBin() {
  return discoverClaudeCli()
}

/** 给 Promise 加超时；超时返回 `{timedOut:true}`，不抛。 */
function withTimeout(promise, timeoutMs) {
  return new Promise(resolveWait => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolveWait({ timedOut: true })
    }, timeoutMs)
    Promise.resolve(promise).then(
      value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveWait({ timedOut: false, value })
      },
      error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveWait({ timedOut: false, error })
      },
    )
  })
}

function errorText(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

async function main() {
  const discovered = findClaudeBin()
  const claudeBin = discovered.found ? discovered.bin : null
  if (claudeBin === null) {
    emit({
      ok: true,
      skipped: true,
      adapter: 'claude',
      reason: 'claude-not-installed',
      // m6：把「查过哪些路径、为什么不算」一起打出来；skipped 只代表没找到 CLI。
      attempts: discovered.attempts,
      message: '本机没有 claude CLI（CLAUDE_BIN 与 PATH 都没有可执行文件）：'
        + '真实通道 smoke 未运行（单元测试不能替代真实验收）',
    })
    return 0
  }

  const tmpRoot = join(repoRoot, '.tmp')
  mkdirSync(tmpRoot, { recursive: true })
  const sandbox = await fsp.mkdtemp(join(tmpRoot, 'claude-smoke-'))
  const workspace = join(sandbox, 'workspace')
  await fsp.mkdir(workspace, { recursive: true })

  const startedAt = Date.now()
  const adapter = createClaudeAdapter({
    claudeBin,
    tmpRoot: sandbox,
    reminderLimit: 1,
    postFinishGraceMs: 2_000,
    killTimeoutMs: 3_000,
    helloTimeoutMs: 60_000,
    probeTimeoutMs: 60_000,
    selfTest: true,
  })

  let handle = null
  try {
    // 1) probe：版本 / 参数面 / MCP 桥（这一步不需要模型认证）。
    const probe = await adapter.probe()
    const caps = adapter.capabilities()

    // 2) 真实非交互运行：让模型调用 flow_finish_node 完结。
    const gate = createFinishGate({
      executionId: `smoke-${randomUUID()}`,
      nodeId: 'claude-smoke',
      attempt: 1,
      workspaceRoot: workspace,
    })
    const reminders = []
    handle = await adapter.start({
      element: {
        id: 'claude-smoke',
        name: 'Claude 真实通道 smoke',
        node: {
          prompt: [
            '这是 flow-studio 的 Claude Code 真实通道 smoke。',
            '现在只做一件事：调用 MCP 工具 flow_finish_node，参数为',
            '  variables: {"smoke": true, "provider": "claude"}',
            '  documents: []',
            '  summary: "claude smoke ok"',
            '不要写文件、不要跑命令；调用工具后立即结束。',
          ].join('\n'),
        },
      },
      ctx: { attempt: 1, variables: {} },
      finishGate: gate,
      workspaceRoot: workspace,
      reminder: { onFire: info => reminders.push(info.count) },
    })

    const outcome = await withTimeout(handle.exited, SMOKE_TIMEOUT_MS)
    const usageCalls = typeof handle.usageCalls === 'function' ? handle.usageCalls() : []
    if (outcome.timedOut) {
      emit({
        ok: false,
        skipped: false,
        adapter: 'claude',
        phase: 'await-exit',
        reason: 'smoke-timeout',
        timeoutMs: SMOKE_TIMEOUT_MS,
        version: probe.version,
        durationMs: Date.now() - startedAt,
        message: `真实通道在 ${SMOKE_TIMEOUT_MS}ms 内没有给出结局（可能没调用工具，或一直没有退出）`,
      })
      return 1
    }
    if (outcome.error) throw outcome.error
    const exited = outcome.value
    const ok = exited && exited.ok === true && gate.settled() === true
    emit({
      ok,
      skipped: false,
      adapter: 'claude',
      claudeBin,
      claudeBinSource: discovered.source,
      version: probe.version,
      helpDigest: probe.helpDigest,
      capabilities: {
        finishTool: caps.finishTool,
        turnStop: caps.hooks && caps.hooks['turn.stop'],
        messages: caps.messages,
        usage: caps.usage,
      },
      exit: {
        ok: exited ? exited.ok === true : false,
        code: exited ? exited.code : undefined,
        reminders: exited ? exited.reminders : undefined,
        sessionId: exited ? exited.sessionId : undefined,
        summary: exited && exited.record ? exited.record.summary : undefined,
      },
      reminders,
      usageCalls: usageCalls.map(call => ({ provider: call.provider, callId: call.callId, source: call.source })),
      durationMs: Date.now() - startedAt,
      ...(ok ? {} : {
        reason: exited && exited.ok === false ? exited.code : 'finish-not-settled',
        message: '真实通道没有通过：只有真正调用 flow_finish_node 才算完结（退出码 / 自然语言不算）',
      }),
    })
    return ok ? 0 : 1
  } catch (error) {
    emit({
      ok: false,
      skipped: false,
      adapter: 'claude',
      claudeBin,
      claudeBinSource: discovered.source,
      reason: error && typeof error.code === 'string' ? error.code : 'smoke-failed',
      message: errorText(error),
      durationMs: Date.now() - startedAt,
    })
    return 1
  } finally {
    if (handle !== null) {
      try {
        await adapter.dispose(handle)
      } catch {
        // 清理失败不影响 smoke 结论；临时目录下面还会尽量删。
      }
    }
    await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => {})
  }
}

main().then(code => process.exit(code), error => {
  emit({
    ok: false,
    skipped: false,
    adapter: 'claude',
    reason: 'smoke-crashed',
    message: errorText(error),
  })
  process.exit(1)
})
