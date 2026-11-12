#!/usr/bin/env node
/**
 * ACP 适配器的真实通道 smoke（0.15.0 / P5）。
 *
 * 单元 / 集成测试都用 fake ACP agent 证明协议与引擎语义；**真实 codex-acp 是否装了、
 * 是否接受本适配器生成的 `mcpServers`、模型是否真的能调用 `flow_finish_node`**，
 * 只能在装了 agent 的机器上验证。默认只做 probe（不发 prompt、不产生模型费用），
 * 并且如实打印四层证据：
 *
 *   ① ACP 会话 / 模式协商：initialize(protocolVersion=1) + session/new + session/set_mode
 *   ② 本地桥自检：verifyFinishBridge（initialize / tools.list / tools.call）
 *   ③ agent 自己拉起 finish MCP：firstContact(hello) + tools/list discovery
 *   ④ 模型真实调用 finish：只有 `--prompt` 才跑；未跑必须标 unverified
 *
 * 用法：
 *   node scripts/acp-smoke.mjs                 # 只做 probe
 *   node scripts/acp-smoke.mjs --prompt        # 跑一次真实模型调用（要求它调用工具）
 *   FLOW_STUDIO_ACP_CONFIG='{"command":"codex-acp"}' node scripts/acp-smoke.mjs
 *
 * 退出状态（与 claude-smoke 同口径，不把 skipped 混成通过）：
 *   - 0 + `{ok:true,skipped:true}`：本机找不到配置里的 ACP agent 可执行文件，**未验收**；
 *   - 0 + `{ok:true,skipped:false}`：probe 通过（未加 `--prompt` 时仅证明 ①②③）；
 *   - 1 + `{ok:false}`：probe / 真实调用失败。
 *
 * 临时根：`$FLOW_STUDIO_TMP`（默认 `os.tmpdir()/flow-studio`，finish.sock 受 107 字节
 * 路径上限约束，所以不放在仓库深处）。
 *
 * @module @feiyueve/dsh-flow-studio/scripts/acp-smoke
 */

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { accessSync, constants, existsSync, promises as fsp, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAcpAdapter } from '../src/agent-adapter-acp.js'
import { ACP_CONFIG_INVALID, parseAcpConfig } from '../src/acp-policy.js'
import { createFinishGate } from '../src/node-finish.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const RUN_PROMPT = argv.includes('--prompt')
const SMOKE_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.ACP_SMOKE_TIMEOUT_MS || '', 10)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 180_000
})()

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function errorText(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  }
  catch {
    return String(error)
  }
}

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

/** PATH 里找可执行文件（不执行它；不做版本探测）。 */
function findAgentCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return null
  const candidates = isAbsolute(command) || command.includes('/')
    ? [command]
    : String(process.env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, command))
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    }
    catch {
      // 继续找。
    }
  }
  return null
}

function evidenceLayers(probe, caps, promptOutcome) {
  return [
    {
      layer: 1,
      name: 'ACP 会话 / 模式协商',
      verified: probe.protocolVersion === 1,
      detail: `initialize.protocolVersion=${probe.protocolVersion}；agent=${probe.agentInfo?.name || 'unknown'}@${probe.version || 'unknown'}`,
    },
    {
      layer: 2,
      name: '本地 finish 桥自检',
      verified: probe.bridge?.ok === true,
      detail: 'verifyFinishBridge：initialize / tools.list / tools.call 往返',
    },
    {
      layer: 3,
      name: 'agent 拉起 finish MCP 并 discovery',
      verified: probe.agentMcp?.contacted === true && probe.agentMcp?.discovered === true,
      detail: `contacted=${probe.agentMcp?.contacted === true} discovered=${probe.agentMcp?.discovered === true}`,
    },
    {
      layer: 4,
      name: '模型真实调用 flow_finish_node',
      verified: promptOutcome !== null && promptOutcome.ok === true,
      detail: promptOutcome === null
        ? '未验证（没有 --prompt；fake / probe 都不能替代真实模型调用）'
        : (promptOutcome.ok === true ? '真实模型调用了 flow_finish_node' : `未通过：${promptOutcome.reason || 'unknown'}`),
    },
  ]
}

async function runPrompt(adapter) {
  const sandbox = await fsp.mkdtemp(join(process.env.TMPDIR || tmpdir(), 'acp-smoke-'))
  const workspace = join(sandbox, 'workspace')
  await fsp.mkdir(workspace, { recursive: true })
  let handle = null
  try {
    const gate = createFinishGate({
      executionId: `acp-smoke-${randomUUID()}`,
      nodeId: 'acp-smoke',
      attempt: 1,
      workspaceRoot: workspace,
    })
    const reminders = []
    handle = await adapter.start({
      element: {
        id: 'acp-smoke',
        name: 'ACP 真实通道 smoke',
        node: {
          prompt: [
            '这是 flow-studio 的 ACP 真实通道 smoke。',
            '现在只做一件事：调用 MCP 工具 flow_finish_node，参数为',
            '  variables: {"smoke": true, "provider": "acp"}',
            '  documents: []',
            '  summary: "acp smoke ok"',
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
    if (outcome.timedOut) {
      return {
        ok: false,
        reason: 'smoke-timeout',
        message: `真实通道在 ${SMOKE_TIMEOUT_MS}ms 内没有给出结局`,
        reminders,
        cleanup: await disposeSafely(adapter, handle),
      }
    }
    if (outcome.error) throw outcome.error
    const exited = outcome.value
    const ok = exited && exited.ok === true && gate.settled() === true
    const record = exited && exited.record ? exited.record : null
    return {
      ok,
      reason: ok ? undefined : (exited && exited.ok === false ? exited.code : 'finish-not-settled'),
      exit: {
        ok: exited ? exited.ok === true : false,
        code: exited ? exited.code : undefined,
        reminders: exited ? exited.reminders : undefined,
        sessionId: exited ? exited.sessionId : undefined,
      },
      summary: record ? record.summary : undefined,
      output: record ? record.output : undefined,
      reminders,
      cleanup: await disposeSafely(adapter, handle),
    }
  }
  finally {
    if (handle !== null) {
      // dispose 已在返回路径里做过；这里只兜底临时目录。
    }
    await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => {})
  }
}

async function disposeSafely(adapter, handle) {
  try {
    await adapter.dispose(handle)
    return 'disposed'
  }
  catch {
    return 'dispose-failed'
  }
}

async function main() {
  const parsed = parseAcpConfig()
  if (!parsed.ok) {
    emit({
      ok: false,
      skipped: false,
      adapter: 'acp',
      reason: ACP_CONFIG_INVALID,
      message: parsed.message,
      prompt: RUN_PROMPT,
    })
    return 1
  }
  const command = findAgentCommand(parsed.config.command)
  if (command === null) {
    emit({
      ok: true,
      skipped: true,
      adapter: 'acp',
      reason: 'acp-agent-not-installed',
      command: parsed.config.command,
      mode: parsed.config.mode,
      permissionPolicy: parsed.config.permissionPolicy,
      prompt: RUN_PROMPT,
      message: `本机 PATH / 配置里找不到 ACP agent 可执行文件「${parsed.config.command}」：`
        + '真实通道 smoke 未运行（probe / fake agent 都不能替代真实验收）',
    })
    return 0
  }

  const startedAt = Date.now()
  const adapter = createAcpAdapter()
  let probe
  try {
    probe = await adapter.probe()
  }
  catch (error) {
    emit({
      ok: false,
      skipped: false,
      adapter: 'acp',
      command,
      prompt: RUN_PROMPT,
      phase: 'probe',
      reason: error && typeof error.code === 'string' ? error.code : 'probe-failed',
      cause: error && error.details ? error.details.reason : undefined,
      message: errorText(error),
      durationMs: Date.now() - startedAt,
    })
    return 1
  }

  const caps = adapter.capabilities()
  const probeEvidence = {
    version: probe.version,
    helpDigest: probe.helpDigest,
    protocolVersion: probe.protocolVersion,
    agentInfo: probe.agentInfo,
    bridge: probe.bridge,
    agentMcp: probe.agentMcp,
    finishTool: caps.finishTool,
  }

  if (!RUN_PROMPT) {
    emit({
      ok: true,
      skipped: false,
      adapter: 'acp',
      command,
      prompt: false,
      probe: probeEvidence,
      evidence: evidenceLayers(probe, caps, null),
      capabilities: {
        finishTool: caps.finishTool,
        messages: caps.messages,
        usage: caps.usage,
        resume: caps.resume,
        cancel: caps.cancel,
      },
      cleanup: 'probe-cleanup',
      durationMs: Date.now() - startedAt,
      message: 'probe 只证明 ①②③；④ 模型调用 finish 需要 --prompt，未跑不算通过',
    })
    return caps.finishTool === 'native' ? 0 : 1
  }

  const promptResult = await runPrompt(adapter)
  emit({
    ok: promptResult.ok === true,
    skipped: false,
    adapter: 'acp',
    command,
    prompt: true,
    probe: probeEvidence,
    evidence: evidenceLayers(probe, caps, promptResult),
    promptResult,
    cleanup: promptResult.cleanup,
    durationMs: Date.now() - startedAt,
    ...(promptResult.ok === true ? {} : {
      message: '真实通道没有通过：只有真正调用 flow_finish_node 才算完结（退出码 / 自然语言不算）',
    }),
  })
  return promptResult.ok === true ? 0 : 1
}

main().then(code => process.exit(code), error => {
  emit({
    ok: false,
    skipped: false,
    adapter: 'acp',
    prompt: RUN_PROMPT,
    reason: 'smoke-crashed',
    message: errorText(error),
  })
  process.exit(1)
})
