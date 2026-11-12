#!/usr/bin/env node
/**
 * 可编程 ACP v1 fake agent（0.15.0 / P4 测试夹具）。
 *
 * 它不是「假 finish 通道」：`session/new` 收到的 `mcpServers` 会由**官方 MCP SDK**
 * `Client` + `StdioClientTransport` 真正拉起，`tools/list` / `tools/call` 都走
 * 真实 MCP 协议回 `node-finish-mcp.js`；测试从不直接调用 channel / gate 自证。
 *
 * 用法：
 *   node test/fixtures/fake-acp-agent.mjs --config <config.json> [--log <events.ndjson>]
 *
 * config 关键字段（都有默认值）：
 *   sessionId / agentName / agentVersion
 *   modes: {availableModes, currentModeId} | null      session/new 的 modes
 *   setMode: 'ok' | 'error' | 'hang'
 *   close: 'ok' | 'error-32002' | 'hang'
 *   mcp: 'full' | 'hello' | 'none'                     none=不拉起；hello=只连不 list
 *   startupDelayMs / resultDelayMs / cancelReplyDelayMs
 *   ignoreCancel / ignoreTerm / pauseStdinOnPrompt / spawnStubbornChild
 *   stubbornPidFile
 *   usage: prompt result 的 usage（不稳定字段）| null
 *   prompts: 每轮脚本（见 runPromptStep）
 *
 * 日志是 NDJSON，测试按 event 类型断言真实发生的协议行为。
 */

import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const argv = process.argv.slice(2)
function argValue(name) {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : ''
}

const configPath = argValue('--config')
let config = {}
if (configPath !== '') {
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  }
  catch {
    config = {}
  }
}
const logPath = argValue('--log') || (typeof config.logPath === 'string' ? config.logPath : '')

const state = {
  sessionId: typeof config.sessionId === 'string' && config.sessionId !== ''
    ? config.sessionId
    : 'session-acp-test-1',
  mcp: typeof config.mcp === 'string' ? config.mcp : 'full',
  currentModeId: typeof config.currentModeId === 'string' ? config.currentModeId : 'agent',
  prompts: [],
  mcpClients: new Map(),
  pendingAgentRequests: new Map(),
  nextRequestId: 900,
  cancelled: false,
  cancelHook: null,
  exited: false,
}

function log(event, data = {}) {
  if (logPath === '') return
  try {
    appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), event, ...data })}\n`)
  }
  catch {
    // 日志写失败不能改变协议行为。
  }
}

function send(message) {
  if (state.exited) return
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function notify(update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: state.sessionId, update } })
}

function sleep(ms) {
  return new Promise(resolveSleep => { setTimeout(resolveSleep, ms) })
}

const DEFAULT_MODES = {
  currentModeId: 'agent',
  availableModes: [
    { id: 'read-only', name: 'Read-only', description: 'Requires approval to edit files.' },
    { id: 'workspace-write', name: 'Workspace access', description: 'Edit workspace files.' },
    { id: 'agent', name: 'Auto review', description: 'Ask before unsafe actions.' },
    { id: 'agent-full-access', name: 'Full access', description: 'Unrestricted access.' },
  ],
}

const DEFAULT_USAGE = {
  totalTokens: 18666,
  inputTokens: 6501,
  cachedReadTokens: 12160,
  cachedWriteTokens: 0,
  outputTokens: 5,
  thoughtTokens: 0,
}

const DEFAULT_FINISH_ARGS = {
  variables: { done: true },
  documents: [],
  summary: 'fake acp agent 完成节点',
}

const INVALID_FINISH_ARGS = {
  variables: { nested: { bad: true } },
  documents: [],
  summary: 'invalid shape',
}

/** 官方 MCP SDK 客户端调用 finish 工具（唯一完结路径）。 */
async function callFinish(args) {
  const client = state.mcpClients.get('flow_finish')
  if (!client) {
    log('mcp-call-skipped', { reason: 'not-connected' })
    return { isError: true, content: [] }
  }
  try {
    const result = await client.callTool({ name: 'flow_finish_node', arguments: args })
    const text = Array.isArray(result?.content) && result.content[0] && typeof result.content[0].text === 'string'
      ? result.content[0].text.slice(0, 200)
      : ''
    log('mcp-call', { isError: result?.isError === true, text })
    return result
  }
  catch (error) {
    log('mcp-call', { isError: true, error: error && error.code ? String(error.code) : 'call-failed' })
    return { isError: true, content: [] }
  }
}

/** 连接 session/new 里的 MCP server（stdio）；hello 模式只连不 list。 */
async function connectMcpServers(servers) {
  const mode = state.mcp
  if (mode === 'none') {
    log('mcp-skipped', { count: Array.isArray(servers) ? servers.length : 0 })
    return
  }
  const list = Array.isArray(servers) ? servers : []
  for (const server of list) {
    if (!server || typeof server !== 'object' || typeof server.name !== 'string') continue
    const env = {}
    if (Array.isArray(server.env)) {
      for (const entry of server.env) {
        if (entry && typeof entry.name === 'string' && typeof entry.value === 'string') env[entry.name] = entry.value
      }
    }
    const transport = new StdioClientTransport({
      command: server.command,
      args: Array.isArray(server.args) ? server.args : [],
      env,
      stderr: 'pipe',
    })
    const client = new Client({ name: 'fake-acp-agent', version: '1.0.0' })
    try {
      await client.connect(transport)
      state.mcpClients.set(server.name, client)
      log('mcp-connected', { server: server.name, pid: transport.pid ?? null })
      if (mode === 'hello') {
        log('mcp-hello-only', { server: server.name })
        continue
      }
      const listed = await client.listTools()
      const tools = Array.isArray(listed?.tools) ? listed.tools.map(tool => tool && tool.name).filter(Boolean) : []
      log('mcp-discovered', { server: server.name, tools })
    }
    catch (error) {
      log('mcp-connect-failed', {
        server: server.name,
        error: error && error.code ? String(error.code) : 'connect-failed',
      })
    }
  }
}

/** 权限请求参数（步骤可覆盖选项 / toolCallId）。 */
function permissionParams(step) {
  const options = Array.isArray(step.options) && step.options.length > 0
    ? step.options
    : [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
    ]
  return {
    sessionId: state.sessionId,
    toolCall: {
      toolCallId: step.toolCallId || 'perm-tool-1',
      title: 'Run a command',
      kind: 'execute',
      status: 'pending',
    },
    options,
  }
}

/**
 * 发请求给 client（权限等），返回 client 的响应。
 *
 * 显式传 `explicitId` 可复用同一个 JSON-RPC id（重复 id 探针）；
 * 同一 id 的多个 waiter 按响应到达顺序逐个结算，便于分别观察每条应答。
 */
function sendClientRequest(method, params, explicitId) {
  const id = explicitId === undefined ? state.nextRequestId : explicitId
  if (explicitId === undefined) state.nextRequestId += 1
  return new Promise(resolveRequest => {
    const waiters = state.pendingAgentRequests.get(id)
    if (Array.isArray(waiters)) waiters.push(resolveRequest)
    else state.pendingAgentRequests.set(id, [resolveRequest])
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function outcomeOf(response) {
  const outcome = response && response.outcome ? response.outcome : {}
  return {
    outcome: typeof outcome.outcome === 'string' ? outcome.outcome : 'unknown',
    optionId: typeof outcome.optionId === 'string' ? outcome.optionId : null,
  }
}

async function requestPermission(step, explicitId) {
  const id = explicitId === undefined ? state.nextRequestId : explicitId
  const response = await sendClientRequest('session/request_permission', permissionParams(step), explicitId)
  const outcome = outcomeOf(response)
  log('permission-response', {
    requestId: id,
    outcome: outcome.outcome,
    optionId: outcome.optionId,
  })
  return response
}

function promptUsage(step) {
  if (step.usage === null) return undefined
  if (step.usage !== undefined) return step.usage
  if (config.usage === null) return undefined
  return config.usage !== undefined ? config.usage : DEFAULT_USAGE
}

/**
 * 一轮 prompt 的脚本：
 *   finish / finish-invalid-then-valid / text / toolcall-fake / permission /
 *   permission-after-cancel / permission-after-finish / permission-duplicate /
 *   cancel-tail / cancel-ignore / provider-error / refusal / max-tokens / hang
 */
async function runPromptStep(id, step) {
  const usage = promptUsage(step)
  const finishWithUsage = stopReason => {
    reply(id, {
      stopReason,
      ...(usage === undefined ? {} : { usage }),
    })
  }

  if (typeof step.text === 'string' && step.text !== '') {
    notify({ sessionUpdate: 'agent_message_chunk', messageId: step.messageId || `msg-${step.index}`, content: { type: 'text', text: step.text } })
  }
  if (step.usageUpdate && typeof step.usageUpdate === 'object') {
    notify({ sessionUpdate: 'usage_update', used: step.usageUpdate.used, size: step.usageUpdate.size })
  }
  if (step.toolCallUpdate) {
    notify({
      sessionUpdate: 'tool_call',
      toolCallId: step.toolCallUpdate.toolCallId || 'tool-1',
      title: step.toolCallUpdate.title || 'fake tool',
      kind: step.toolCallUpdate.kind || 'other',
      status: 'in_progress',
      content: [],
    })
    notify({
      sessionUpdate: 'tool_call_update',
      toolCallId: step.toolCallUpdate.toolCallId || 'tool-1',
      status: 'completed',
    })
  }

  if (config.pauseStdinOnPrompt === true) {
    try {
      process.stdin.pause()
      log('stdin-paused')
    }
    catch {
      // ignore
    }
  }

  switch (step.kind) {
    case 'finish': {
      await callFinish(step.finishArgs === undefined ? DEFAULT_FINISH_ARGS : step.finishArgs)
      await sleep(Number.isSafeInteger(step.resultDelayMs) ? step.resultDelayMs : (config.resultDelayMs || 0))
      if (step.stopReasonAfterFinish) finishWithUsage(step.stopReasonAfterFinish)
      else finishWithUsage('end_turn')
      return
    }
    case 'finish-invalid-then-valid': {
      await callFinish(INVALID_FINISH_ARGS)
      await callFinish(DEFAULT_FINISH_ARGS)
      await sleep(config.resultDelayMs || 0)
      finishWithUsage('end_turn')
      return
    }
    case 'text': {
      finishWithUsage('end_turn')
      return
    }
    case 'toolcall-fake': {
      finishWithUsage('end_turn')
      return
    }
    case 'permission': {
      await requestPermission(step)
      if (step.waitForCancel === true) {
        state.cancelHook = async () => {
          if (step.afterCancelPermission === true) {
            await requestPermission({ ...step, toolCallId: 'perm-after-cancel' })
          }
          await sleep(Number.isSafeInteger(step.cancelReplyDelayMs) ? step.cancelReplyDelayMs : 50)
          finishWithUsage('cancelled')
        }
        return
      }
      if (step.then === 'finish') await callFinish(DEFAULT_FINISH_ARGS)
      finishWithUsage('end_turn')
      return
    }
    case 'permission-after-cancel': {
      // 进入等待：由 session/cancel 触发「取消后到达的权限请求」。
      state.cancelHook = async () => {
        await requestPermission(step)
        await sleep(Number.isSafeInteger(step.cancelReplyDelayMs) ? step.cancelReplyDelayMs : 50)
        if (usage !== undefined) notify({ sessionUpdate: 'usage_update', used: 999, size: 100000 })
        finishWithUsage('cancelled')
      }
      return
    }
    case 'permission-after-finish': {
      // gate 已受理（finish 工具成功）后的关停窗口内再发权限请求：
      // 结局已定，任何请求都必须回 cancelled，不得按策略授权。
      const result = await callFinish(DEFAULT_FINISH_ARGS)
      log('finish-tool-result', { isError: result?.isError === true })
      await sleep(Number.isSafeInteger(step.permissionDelayMs) ? step.permissionDelayMs : 50)
      const response = await requestPermission({ ...step, toolCallId: 'perm-after-finish' })
      log('permission-after-finish-response', outcomeOf(response))
      await sleep(Number.isSafeInteger(step.resultDelayMs) ? step.resultDelayMs : (config.resultDelayMs || 0))
      finishWithUsage('end_turn')
      return
    }
    case 'permission-duplicate': {
      // 同一个 JSON-RPC id 连发两条权限请求：对端等两条应答，客户端必须都回，
      // 但同一 id 只允许一次有效决策（第二次固定 cancelled）。
      const requestId = Number.isSafeInteger(step.requestId) ? step.requestId : 4242
      const params = permissionParams({ ...step, toolCallId: 'perm-duplicate' })
      const [first, second] = await Promise.all([
        sendClientRequest('session/request_permission', params, requestId),
        sendClientRequest('session/request_permission', params, requestId),
      ])
      log('permission-duplicate-response', {
        requestId,
        outcomes: [outcomeOf(first), outcomeOf(second)],
      })
      await sleep(Number.isSafeInteger(step.resultDelayMs) ? step.resultDelayMs : 0)
      finishWithUsage('end_turn')
      return
    }
    case 'cancel-tail': {
      state.cancelHook = async () => {
        await sleep(Number.isSafeInteger(step.cancelReplyDelayMs)
          ? step.cancelReplyDelayMs
          : (Number.isSafeInteger(config.cancelReplyDelayMs) ? config.cancelReplyDelayMs : 100))
        if (step.tailText) {
          notify({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-tail', content: { type: 'text', text: step.tailText } })
        }
        if (step.tailUsage !== undefined && step.tailUsage !== null) {
          reply(id, { stopReason: 'cancelled', usage: step.tailUsage })
        }
        else {
          reply(id, { stopReason: 'cancelled' })
        }
      }
      return
    }
    case 'cancel-ignore': {
      state.cancelHook = () => {
        log('cancel-ignored', { promptId: id })
      }
      return
    }
    case 'provider-error': {
      replyError(id, Number.isInteger(step.code) ? step.code : -32603, 'fake provider failure')
      return
    }
    case 'refusal': {
      finishWithUsage('refusal')
      return
    }
    case 'max-tokens': {
      finishWithUsage('max_tokens')
      return
    }
    case 'stop-unknown': {
      reply(id, { stopReason: 'weird-future-stop-reason' })
      return
    }
    case 'hang': {
      state.cancelHook = null
      return
    }
    default: {
      await callFinish(DEFAULT_FINISH_ARGS)
      finishWithUsage('end_turn')
    }
  }
}

async function handlePrompt(id, params) {
  const index = state.prompts.length + 1
  const prompt = Array.isArray(params.prompt) ? params.prompt : []
  const text = prompt
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  state.prompts.push({ index, text })
  log('prompt', { index, text: text.slice(0, 200) })
  const script = Array.isArray(config.prompts) ? config.prompts : []
  const step = script.length >= index && script[index - 1] && typeof script[index - 1] === 'object'
    ? script[index - 1]
    : { kind: 'finish' }
  try {
    await runPromptStep(id, { ...step, index })
  }
  catch (error) {
    log('prompt-handler-failed', { error: error && error.message ? error.message.slice(0, 120) : 'unknown' })
    replyError(id, -32603, 'fake agent prompt handler failed')
  }
}

async function handleRequest(message) {
  const method = message.method
  log('request', { method })
  switch (method) {
    case 'initialize': {
      const delay = Number.isSafeInteger(config.startupDelayMs) ? config.startupDelayMs : 0
      if (delay > 0) await sleep(delay)
      const closeSupported = config.close !== 'not-supported'
      reply(message.id, {
        protocolVersion: Number.isInteger(config.protocolVersion) ? config.protocolVersion : 1,
        agentInfo: {
          name: typeof config.agentName === 'string' ? config.agentName : '@agentclientprotocol/codex-acp',
          title: 'Codex',
          version: typeof config.agentVersion === 'string' ? config.agentVersion : '2.6.0',
        },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true, image: true },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: closeSupported ? { close: {}, resume: {}, list: {} } : { resume: {} },
        },
        authMethods: [],
      })
      return
    }
    case 'session/new': {
      if (Number.isInteger(config.failNew)) {
        replyError(message.id, config.failNew, 'fake session/new failure')
        return
      }
      const modes = config.modes === null ? null : (config.modes || DEFAULT_MODES)
      reply(message.id, {
        sessionId: state.sessionId,
        ...(modes === null ? {} : { modes }),
      })
      log('session-new', {
        cwd: typeof message.params?.cwd === 'string' ? message.params.cwd : null,
        mcpCount: Array.isArray(message.params?.mcpServers) ? message.params.mcpServers.length : 0,
      })
      // 回复之后再拉起 MCP（真实 agent 的常见顺序）；probe 会在后面等 discovery。
      void connectMcpServers(message.params?.mcpServers)
      return
    }
    case 'session/set_mode': {
      if (config.setMode === 'hang') {
        log('set-mode-hang', { modeId: message.params?.modeId })
        return
      }
      if (config.setMode === 'error') {
        replyError(message.id, -32601, 'session/set_mode not supported')
        return
      }
      state.currentModeId = typeof message.params?.modeId === 'string' ? message.params.modeId : state.currentModeId
      reply(message.id, {})
      return
    }
    case 'session/prompt': {
      void handlePrompt(message.id, message.params || {})
      return
    }
    case 'session/close': {
      if (config.close === 'hang') {
        log('close-hang')
        return
      }
      if (config.close === 'error-32002') {
        replyError(message.id, -32002, 'session not found')
        return
      }
      reply(message.id, {})
      return
    }
    case 'session/load': {
      // 不声明 loadSession 的适配器不该调用它；调用就留下证据（提醒必须同 session）。
      replyError(message.id, -32601, 'session/load not supported by fake agent')
      return
    }
    default: {
      replyError(message.id, -32601, `method not found: ${String(method).slice(0, 64)}`)
    }
  }
}

function handleNotification(message) {
  const method = message.method
  log('notification', { method })
  if (method === 'session/cancel') {
    state.cancelled = true
    const hook = state.cancelHook
    if (config.ignoreCancel === true || hook === null) {
      log('cancel-ignored', { sessionId: message.params?.sessionId ?? null })
      return
    }
    void Promise.resolve().then(hook).catch(() => {})
    return
  }
  if (method === '$/cancel_request') return
}

function dispatch(message) {
  if (!message || typeof message !== 'object') {
    log('protocol-error', { reason: 'not-object' })
    return
  }
  if (typeof message.method === 'string') {
    if (Object.hasOwn(message, 'id')) void handleRequest(message)
    else handleNotification(message)
    return
  }
  if (Object.hasOwn(message, 'id')) {
    const waiter = state.pendingAgentRequests.get(message.id)
    if (waiter) {
      // 同一 id 可能登记了多个 waiter（重复 id 探针）：按到达顺序一次结算一个。
      const waiters = Array.isArray(waiter) ? waiter : [waiter]
      const next = waiters.shift()
      if (waiters.length === 0) state.pendingAgentRequests.delete(message.id)
      else state.pendingAgentRequests.set(message.id, waiters)
      next(message.result !== undefined ? message.result : { error: message.error })
    }
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() !== '') {
      let message
      try {
        message = JSON.parse(line)
      }
      catch {
        log('protocol-error', { reason: 'invalid-json' })
        message = null
      }
      if (message !== null) dispatch(message)
    }
    index = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => {
  log('stdin-eof')
  for (const client of state.mcpClients.values()) {
    try {
      void client.close()
    }
    catch {
      // ignore
    }
  }
  // 正常 EOF：退出（stubborn child 若存在会留在进程组里，交给适配器的整组清理）。
  if (config.ignoreTerm !== true) process.exit(0)
})

if (config.ignoreTerm === true) {
  process.on('SIGTERM', () => {
    log('sigterm-ignored')
  })
  // 「忽略 TERM」的 agent 同时不因 stdin EOF / 事件循环排空而自然退出：
  // 保留一个活跃句柄，只有 SIGKILL（或测试自己收尾）才能让它消失。
  setInterval(() => {}, 1000)
}

if (config.spawnStubbornChild === true) {
  const child = spawn(process.execPath, [
    '-e',
    'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)',
  ], { stdio: 'ignore' })
  if (Number.isSafeInteger(child.pid)) {
    log('stubborn-child', { pid: child.pid })
    if (typeof config.stubbornPidFile === 'string' && config.stubbornPidFile !== '') {
      try {
        writeFileSync(config.stubbornPidFile, String(child.pid))
      }
      catch {
        // ignore
      }
    }
  }
}

log('started', { pid: process.pid, mcp: state.mcp })
