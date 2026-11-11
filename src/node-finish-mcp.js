#!/usr/bin/env node
/**
 * `flow_finish_node` 的 **MCP stdio server** 与本地完成通道（0.13.1，A4 Codex 侧）。
 *
 * 结构（为什么不是一个进程内的对象）：
 *
 *   adapter 进程                           codex 进程树
 *   ┌──────────────────────────┐           ┌────────────────────────────────┐
 *   │ createFinishChannel()    │  unix     │ node node-finish-mcp.js        │
 *   │  · 内存里的 credential → │  socket   │  · 官方 MCP SDK stdio server   │
 *   │    gate（本进程内注册）  │◀─────────▶│  · tools/list: flow_finish_node│
 *   │  · gate.submit(args)     │  换行 JSON│  · tools/call → submit / remind│
 *   └──────────────────────────┘           └────────────────────────────────┘
 *
 * 一个 MCP server 子进程只通过环境变量拿到**一个随机凭据**（`FLOW_STUDIO_FINISH_TOKEN`）
 * 与私有 Unix socket 路径；凭据只映射到 adapter 进程内存里注册的那**一个** gate。
 * 凭据：不写日志、不进提示词、不进 argv、不落盘；跨 execution 复用会被通道拒绝并返回
 * `NODE_FINISH_CHANNEL_FAILED`（不触碰任何 gate）。socket 与凭据文件都放在 0700 的
 * `.tmp/` 私有目录里，由 adapter 在结束时清理。
 *
 * 工具调用是否发生**只以 gate 收到 submit 为准**：本模块不解析 codex stdout，也不写
 * 完成标记文件。`tools/call` 的失败一律返回结构化错误（`isError: true` + JSON 文本），
 * 错误里只有错误码、中文原因与工作区相对路径，不含文档正文 / 凭据 / 绝对私有路径。
 *
 * 协议（换行分隔 JSON，一次请求一条连接）：
 *
 *   请求  { v:1, token, op:'submit'|'remind'|'status'|'hello'|'discovery', args? }
 *   响应  { ok:true, ... } | { ok:false, error:{ code, message, details? } }
 *
 * @module @feiyueve/dsh-flow-studio/node-finish-mcp
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, promises as fsp, rmSync } from 'node:fs'
import { connect as netConnect, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { createFinishGate } from './node-finish.js'

/** 完成工具名（与 docs/design/11-node-finish-tool.md 一致，冻结）。 */
export const FINISH_TOOL_NAME = 'flow_finish_node'

/** MCP server 子进程读取凭据 / 通道地址的环境变量名（只有这两个，且都不含明文凭据在名字里）。 */
export const FINISH_CHANNEL_ENV = Object.freeze({
  /** 私有 Unix socket（或 Windows 命名管道）路径。 */
  socket: 'FLOW_STUDIO_FINISH_SOCKET',
  /** 一次 execution 一个的随机凭据（32 字节 hex）。 */
  token: 'FLOW_STUDIO_FINISH_TOKEN',
})

/** 通道层错误码（对外契约；adapter 与测试都按字符串分流）。 */
export const FINISH_CHANNEL_ERROR = Object.freeze({
  /** 凭据不匹配 / 通道不可用 / 非本 execution 的调用。 */
  FAILED: 'NODE_FINISH_CHANNEL_FAILED',
  /** 通道收到畸形的请求（缺字段 / 未知 op）。 */
  INVALID: 'NODE_FINISH_CHANNEL_INVALID',
  /** 通道请求超时（socket 在而是对端不回）。 */
  TIMEOUT: 'NODE_FINISH_CHANNEL_TIMEOUT',
})

/** 11 §3.1 的固定提醒文本（adapter 的 turn.stop hook 原样送回）。 */
export const FINISH_REMINDER_TEXT = [
  '【必须调用工具】你还没有调用 flow_finish_node，本节点没有完结，流程不会往下走。',
  '现在就调用它：variables 放后续网关要用的短变量，documents 放你写下的文件相对路径，summary 一句话。',
].join('\n')

/**
 * `tools/list` 暴露的入参 schema（11 §2）。
 *
 * 这里只描述**形状与上限**；真正的权威校验在 `node-finish.js` 的 gate 里（纯校验 +
 * 宿主侧文档校验）。两者不一致时以 gate 为准：schema 只是给模型的可读约束。
 */
export const FINISH_TOOL_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['variables', 'documents', 'summary'],
  properties: {
    variables: {
      type: 'object',
      description: '后续网关条件要用的短变量（boolean / number / 短字符串 / null）。'
        + '禁止嵌套对象、数组、文档正文或长 JSON（11 §2）。',
      maxProperties: 32,
      additionalProperties: { type: ['boolean', 'number', 'string', 'null'] },
    },
    documents: {
      type: 'array',
      description: '你写下的文件的**工作区相对路径**引用；正文在文件里，不要塞进 variables。',
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', maxLength: 1024, description: '工作区内相对路径，禁止绝对路径与 .. 段。' },
          kind: { type: 'string', maxLength: 64, description: '文档类型，例如 markdown。' },
          title: { type: 'string', maxLength: 200, description: '文档标题。' },
          summary: { type: 'string', maxLength: 200, description: '一句话说明这份文档是什么。' },
        },
      },
    },
    summary: {
      type: 'string',
      maxLength: 500,
      description: '这次节点做了什么、结论是什么（一句话，≤500 字）。',
    },
  },
})

/** `tools/list` 里的完整工具定义。 */
export const FINISH_TOOL_DEFINITION = Object.freeze({
  name: FINISH_TOOL_NAME,
  description: '完结当前流程节点并让流程继续往下走（工具名 flow_finish_node）。必须调用；不调用则本节点不算完结。'
    + 'variables 放后续网关要用的短变量，documents 放你写下的文件的工作区相对路径，summary 一句话。',
  inputSchema: FINISH_TOOL_INPUT_SCHEMA,
})

const SOCKET_NAME = 'finish.sock'
const PIPE_PREFIX = '\\\\.\\pipe\\flow-studio-finish-'

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function channelError(code, message, details) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details !== undefined && details !== null && typeof details === 'object' ? { details } : {}),
    },
  }
}

/** 只比较 sha256，长度固定且不把凭据本身放进比较分支。 */
function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest()
}

function sameCredential(expectedDigest, presented) {
  if (typeof presented !== 'string' || presented === '') return false
  const presentedDigest = digest(presented)
  return presentedDigest.length === expectedDigest.length && timingSafeEqual(presentedDigest, expectedDigest)
}

function newCredential() {
  return randomBytes(32).toString('hex')
}

/** 私有目录：不存在就建，存在也强制 0700（Unix）。 */
function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(dir, 0o700)
  return dir
}

/**
 * 适配器 / 自检的默认私有临时根。
 *
 * 顺序：`$FLOW_STUDIO_TMP` → `os.tmpdir()/flow-studio`。
 * **不能**落在插件安装目录（`node_modules/@feiyueve/dsh-flow-studio`）里：pnpm store /
 * 只读安装下 `mkdir` 会失败，崩溃后还会往 `node_modules` 里堆临时目录（m6）。
 *
 * @returns {string} 绝对路径（不创建目录）
 */
export function defaultTmpRoot() {
  const fromEnv = typeof process.env.FLOW_STUDIO_TMP === 'string' ? process.env.FLOW_STUDIO_TMP.trim() : ''
  return resolve(fromEnv !== '' ? fromEnv : join(tmpdir(), 'flow-studio'))
}

/** 自检子进程只继承这些宿主环境变量（不把宿主 secret 交给 MCP server）。 */
const BRIDGE_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SHELL',
  'LANG', 'LANGUAGE',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'WINDIR',
])
const BRIDGE_ENV_PREFIXES = Object.freeze(['LC_'])

function bridgeChildEnv(extra) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    if (BRIDGE_ENV_KEYS.includes(key) || BRIDGE_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
      env[key] = value
    }
  }
  if (isPlainObject(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === 'string') env[key] = value
    }
  }
  return env
}

function defaultSocketPath(dir) {
  if (process.platform === 'win32') return `${PIPE_PREFIX}${digest(dir).toString('hex').slice(0, 16)}`
  return join(dir, SOCKET_NAME)
}

function safeUnlink(path) {
  try {
    rmSync(path, { force: true })
  } catch {
    // 清理失败不影响调用结果。
  }
}

/**
 * 发出一次通道请求（一次连接一条 JSON）。
 *
 * 失败永远收敛成 `{ok:false,error}`，不抛异常——MCP 工具层需要的是结构化错误，而不是
 * 让整个 server 崩掉。
 *
 * @param {object} options
 * @param {string} options.socketPath
 * @param {string} options.credential
 * @param {string} options.op
 * @param {unknown} [options.args]
 * @param {number} [options.timeoutMs]
 */
export function invokeFinishChannel(options) {
  const {
    socketPath,
    credential,
    op,
    args,
    timeoutMs = 120_000,
    requestId = undefined,
  } = options || {}
  return new Promise(resolvePromise => {
    if (typeof socketPath !== 'string' || socketPath === ''
      || typeof credential !== 'string' || credential === '') {
      resolvePromise(channelError(
        FINISH_CHANNEL_ERROR.FAILED,
        '完成通道没有绑定（缺少本地 socket 或凭据），无法完结节点',
        { reason: 'not-configured' },
      ))
      return
    }
    let settled = false
    let buffer = ''
    let socket
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.destroy()
      } catch {
        // 关闭失败不影响结果。
      }
      resolvePromise(value)
    }
    const timer = setTimeout(() => {
      finish(channelError(
        FINISH_CHANNEL_ERROR.TIMEOUT,
        '完成通道请求超时，节点完成结果未知（不视为已完成）',
        { reason: 'timeout' },
      ))
    }, Math.max(1, timeoutMs))
    timer.unref?.()

    try {
      socket = netConnect(socketPath)
    } catch (error) {
      finish(channelError(
        FINISH_CHANNEL_ERROR.FAILED,
        '完成通道不可用（无法连接本地 socket），节点无法完结',
        { reason: 'connect-failed', cause: error && error.code ? String(error.code) : 'unknown' },
      ))
      return
    }
    socket.setEncoding?.('utf8')
    socket.on('connect', () => {
      const payload = {
        v: 1,
        token: credential,
        op,
        ...(args === undefined ? {} : { args }),
        ...(requestId === undefined ? {} : { requestId }),
      }
      socket.write(`${JSON.stringify(payload)}\n`)
    })
    socket.on('data', chunk => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index < 0) {
        if (buffer.length > 8 * 1024 * 1024) {
          finish(channelError(FINISH_CHANNEL_ERROR.FAILED, '完成通道响应过大，已中止', { reason: 'response-too-large' }))
        }
        return
      }
      let response
      try {
        response = JSON.parse(buffer.slice(0, index))
      } catch {
        finish(channelError(FINISH_CHANNEL_ERROR.FAILED, '完成通道响应不是合法 JSON', { reason: 'bad-response' }))
        return
      }
      if (!isPlainObject(response) || typeof response.ok !== 'boolean') {
        finish(channelError(FINISH_CHANNEL_ERROR.FAILED, '完成通道响应形状不合法', { reason: 'bad-response' }))
        return
      }
      finish(response)
    })
    socket.on('error', error => {
      finish(channelError(
        FINISH_CHANNEL_ERROR.FAILED,
        '完成通道不可用（连接错误），节点无法完结',
        { reason: 'socket-error', cause: error && error.code ? String(error.code) : 'unknown' },
      ))
    })
    socket.on('close', () => {
      // 没收到完整响应就断开：不能把「通道断了」当成「已完成」。
      finish(channelError(
        FINISH_CHANNEL_ERROR.FAILED,
        '完成通道在返回结果前关闭，节点完成结果未知（不视为已完成）',
        { reason: 'closed-before-response' },
      ))
    })
  })
}

/**
 * 在 adapter 进程内建一个**只服务一个 gate** 的本地完成通道。
 *
 * @param {object} options
 * @param {object} options.gate `createFinishGate()` 返回的闸门（本进程内存里唯一的绑定目标）
 * @param {string} [options.dir] 私有目录（0700）；省略时要求 `socketPath`
 * @param {string} [options.socketPath] 显式 socket 路径（测试用）
 * @param {string} [options.credential] 显式凭据（测试用；默认 32 字节随机）
 * @param {number} [options.maxReminders] 最多提醒次数（默认 3）
 * @param {string} [options.reminderText] 提醒文本（默认 11 §3.1 模板）
 * @param {(info: { count: number, maxFires: number, sessionId?: string }) => void} [options.onReminder]
 * @param {(info: { reason: string }) => void} [options.onReject]
 */
export async function createFinishChannel(options) {
  if (!isPlainObject(options)) throw new TypeError('createFinishChannel 需要 options 对象')
  const gate = options.gate
  if (!gate || typeof gate.submit !== 'function' || typeof gate.settled !== 'function') {
    throw new TypeError('createFinishChannel 的 gate 必须提供 submit() 与 settled()')
  }
  let socketPath
  if (typeof options.socketPath === 'string' && options.socketPath !== '') {
    socketPath = options.socketPath
  } else {
    if (typeof options.dir !== 'string' || options.dir === '') {
      throw new TypeError('createFinishChannel 需要 dir 或 socketPath（私有目录 0700）')
    }
    socketPath = defaultSocketPath(ensurePrivateDir(options.dir))
  }
  const credential = typeof options.credential === 'string' && options.credential !== ''
    ? options.credential
    : newCredential()
  const credentialDigest = digest(credential)
  const maxReminders = Number.isSafeInteger(options.maxReminders) && options.maxReminders >= 0
    ? options.maxReminders
    : 3
  const reminderText = typeof options.reminderText === 'string' && options.reminderText !== ''
    ? options.reminderText
    : FINISH_REMINDER_TEXT
  const onReminder = typeof options.onReminder === 'function' ? options.onReminder : null
  const onReject = typeof options.onReject === 'function' ? options.onReject : null

  let reminders = 0
  let closed = false
  let mismatch = false
  let discovered = false
  let firstContactResolve
  let firstContactSeen = false
  const firstContact = new Promise(resolveFirst => {
    firstContactResolve = resolveFirst
  })
  const sockets = new Set()

  const notify = (fn, payload) => {
    if (!fn) return
    try {
      fn(payload)
    } catch {
      // 回调异常不能影响通道本身。
    }
  }

  async function handleRequest(request) {
    if (!isPlainObject(request)) {
      return channelError(FINISH_CHANNEL_ERROR.INVALID, '完成通道请求必须是 JSON 对象', { reason: 'not-object' })
    }
    if (!sameCredential(credentialDigest, request.token)) {
      mismatch = true
      notify(onReject, { reason: 'credential-mismatch' })
      return channelError(
        FINISH_CHANNEL_ERROR.FAILED,
        '完成通道凭据不匹配：该通道只接受本 execution 注册的凭据，节点不能通过它完结',
        { reason: 'credential-mismatch' },
      )
    }
    if (!firstContactSeen) {
      firstContactSeen = true
      firstContactResolve?.()
    }
    const op = request.op
    if (op === 'hello') return { ok: true }
    if (op === 'discovery') {
      discovered = true
      return { ok: true }
    }
    if (op === 'status') {
      return { ok: true, settled: gate.settled(), reminders, maxReminders, discovered }
    }
    if (op === 'remind') {
      if (gate.settled()) return { ok: true, action: 'none' }
      if (reminders >= maxReminders) return { ok: true, action: 'exhausted', count: reminders }
      reminders += 1
      const sessionId = isPlainObject(request.args) && typeof request.args.sessionId === 'string'
        ? request.args.sessionId
        : undefined
      notify(onReminder, { count: reminders, maxFires: maxReminders, ...(sessionId ? { sessionId } : {}) })
      return { ok: true, action: 'remind', count: reminders, maxFires: maxReminders, text: reminderText }
    }
    if (op === 'submit') {
      try {
        const result = await gate.submit(request.args)
        return { ok: true, result: result && typeof result === 'object' ? result : {} }
      } catch (error) {
        if (error && typeof error.code === 'string') {
          return channelError(error.code, typeof error.message === 'string' ? error.message : '节点完成提交被拒绝', error.details)
        }
        return channelError(
          FINISH_CHANNEL_ERROR.FAILED,
          '节点完成提交失败（通道内部错误），节点未完结',
          { reason: 'submit-failed' },
        )
      }
    }
    return channelError(FINISH_CHANNEL_ERROR.INVALID, `完成通道不认识 op=${String(op)}`, { reason: 'unknown-op' })
  }

  const server = createNetServer(socket => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let answered = false
    const reply = response => {
      if (answered) return
      answered = true
      try {
        socket.write(`${JSON.stringify(response)}\n`)
      } catch {
        // 对端已断开：结果由调用方按「无响应」处理。
      } finally {
        try {
          socket.end()
        } catch {
          // ignore
        }
      }
    }
    socket.on('data', async chunk => {
      if (answered) return
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index < 0) {
        if (buffer.length > 1024 * 1024) {
          reply(channelError(FINISH_CHANNEL_ERROR.INVALID, '完成通道请求过大', { reason: 'request-too-large' }))
        }
        return
      }
      let request
      try {
        request = JSON.parse(buffer.slice(0, index))
      } catch {
        reply(channelError(FINISH_CHANNEL_ERROR.INVALID, '完成通道请求不是合法 JSON', { reason: 'bad-json' }))
        return
      }
      reply(await handleRequest(request))
    })
    socket.on('error', () => {
      // 单个连接错误不关停整个通道。
    })
    socket.on('close', () => sockets.delete(socket))
  })

  const ready = new Promise((resolveReady, rejectReady) => {
    server.once('error', rejectReady)
    server.listen(socketPath, () => {
      server.removeListener('error', rejectReady)
      if (process.platform !== 'win32') {
        try {
          chmodSync(socketPath, 0o600)
        } catch {
          // 权限收不上不影响协议；目录本身已经是 0700。
        }
      }
      resolveReady()
    })
  })
  try {
    await ready
  } catch (error) {
    safeUnlink(socketPath)
    throw error
  }
  server.on('error', () => {
    // 监听之后的错误不再让进程崩溃；调用方会从「无响应」得到 FAILED。
  })

  async function close() {
    if (closed) return
    closed = true
    for (const socket of sockets) {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
    }
    sockets.clear()
    await new Promise(resolveClose => {
      try {
        server.close(() => resolveClose())
      } catch {
        resolveClose()
      }
    })
    if (process.platform !== 'win32') safeUnlink(socketPath)
  }

  return {
    socketPath,
    /** 只在 adapter / server 子进程之间通过环境变量传递；不要写日志。 */
    credential,
    /** 传给 MCP server 子进程的环境变量（凭据只在这里出现）。 */
    env: Object.freeze({
      [FINISH_CHANNEL_ENV.socket]: socketPath,
      [FINISH_CHANNEL_ENV.token]: credential,
    }),
    maxReminders,
    /**
     * MCP server 子进程第一次连上通道（说明 codex 已经把它拉起来）时 resolve。
     * 只用于启动就绪判断；完结与否不看它。
     */
    firstContact,
    get contacted() {
      return firstContactSeen
    },
    get reminders() {
      return reminders
    },
    get mismatch() {
      return mismatch
    },
    get discovered() {
      return discovered
    },
    invoke: (op, args, extra) => invokeFinishChannel({
      socketPath,
      credential,
      op,
      args,
      ...(extra || {}),
    }),
    close,
  }
}

/**
 * 建一个 MCP stdio server（协议用官方 SDK，不手写）。
 *
 * @param {object} options
 * @param {(request: {op: string, args?: unknown}) => Promise<object>} options.invoke 通道调用实现
 * @param {string} [options.name]
 * @param {string} [options.version]
 */
export function createFinishMcpServer(options) {
  const invoke = options && typeof options.invoke === 'function' ? options.invoke : null
  if (!invoke) throw new TypeError('createFinishMcpServer 需要 invoke 函数')

  const server = new Server(
    {
      name: (options && options.name) || 'flow-studio-finish',
      version: (options && options.version) || '0.13.1',
    },
    { capabilities: { tools: {} } },
  )

  // 拿到 tools/list 就说明 codex 客户端已经完成 handshake 并发现了工具；只作为诊断信号，
  // 完结与否仍然只看 gate.submit 是否成功。
  let discoveryNotified = false
  const notifyDiscovery = async () => {
    if (discoveryNotified) return
    discoveryNotified = true
    try {
      await invoke({ op: 'discovery' })
    } catch {
      // 诊断信号失败不影响 tools/list。
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await notifyDiscovery()
    return { tools: [FINISH_TOOL_DEFINITION] }
  })

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request && request.params && request.params.name
    if (name !== FINISH_TOOL_NAME) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify(channelError(
            FINISH_CHANNEL_ERROR.INVALID,
            `这个完成通道只提供工具 ${FINISH_TOOL_NAME}，没有工具 ${String(name)}`,
            { reason: 'unknown-tool' },
          )),
        }],
      }
    }
    const args = request.params && request.params.arguments !== undefined ? request.params.arguments : {}
    let response
    try {
      response = await invoke({ op: 'submit', args })
    } catch {
      response = channelError(
        FINISH_CHANNEL_ERROR.FAILED,
        '完成通道调用失败，节点未完结',
        { reason: 'invoke-threw' },
      )
    }
    if (response && response.ok) {
      const result = response.result !== undefined ? response.result : {}
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      }
    }
    const error = response && isPlainObject(response.error)
      ? response.error
      : { code: FINISH_CHANNEL_ERROR.FAILED, message: '完成通道没有返回结构化错误' }
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error }) }],
    }
  })

  return server
}

/**
 * 用环境变量里的凭据/通道启动 stdio server。
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<boolean>} 是否成功启动（缺配置 / 启动失败返回 false，由 CLI 设非零退出码）
 */
export async function runStdioServer(options) {
  const env = (options && options.env) || process.env
  const socketPath = env[FINISH_CHANNEL_ENV.socket]
  const credential = env[FINISH_CHANNEL_ENV.token]
  if (typeof socketPath !== 'string' || socketPath === ''
    || typeof credential !== 'string' || credential === '') {
    process.stderr.write(
      'node-finish-mcp: 缺少完成通道配置（需要私有的 socket 与一次性的随机凭据），拒绝启动\n',
    )
    return false
  }
  const server = createFinishMcpServer({
    invoke: request => invokeFinishChannel({
      socketPath,
      credential,
      op: request.op,
      args: request.args,
    }),
  })
  // 告诉 adapter「MCP server 已经起来了」。这是就绪信号，不是完成信号。
  invokeFinishChannel({ socketPath, credential, op: 'hello', timeoutMs: 5_000 }).catch(() => {})
  await server.connect(new StdioServerTransport())
  return true
}

/**
 * 自检 / probe 用：在 `verify` 里起一个真实 MCP 子进程，跑
 * initialize → tools/list → tools/call（成功的空完成），证明整条桥可用。
 *
 * 每一步都带**独立超时**（m9）：MCP 子进程挂住时自检必须在有限时间内失败并收掉
 * 子进程，不能把 `probe()` / admission / 启动路径一起挂死。
 * 子进程环境只从白名单继承（M5），再叠加 `channel.env` 与调用方显式给的 `options.env`。
 *
 * 临时目录默认 `$FLOW_STUDIO_TMP` 或 `os.tmpdir()/flow-studio`（0700，m6），
 * 用完即删。
 *
 * @param {object} [options]
 * @param {string} [options.tmpRoot] 临时根目录（默认见 {@link defaultTmpRoot}）
 * @param {string} [options.serverPath] node-finish-mcp.js 的绝对路径（默认按本模块定位）
 * @param {number} [options.timeoutMs] 每一步的超时（默认 30000）
 * @param {NodeJS.ProcessEnv} [options.env] 额外注入自检子进程的环境变量（测试 / 特殊接线）
 */
export async function verifyFinishBridge(options) {
  const opts = options && typeof options === 'object' ? options : {}
  const selfPath = fileURLToPath(import.meta.url)
  const tmpRoot = resolve(
    typeof opts.tmpRoot === 'string' && opts.tmpRoot !== '' ? opts.tmpRoot : defaultTmpRoot(),
  )
  const serverPath = typeof opts.serverPath === 'string' && opts.serverPath !== '' ? opts.serverPath : selfPath
  const stepTimeoutMs = Number.isSafeInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000
  const cleanupTimeoutMs = Math.min(stepTimeoutMs, 3_000)

  /** 给任意 Promise 加超时；超时抛带 `code` / `step` 的错误（不吞掉原错误）。 */
  const withTimeout = (promise, step) => new Promise((resolveStep, rejectStep) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const error = new Error(`完成桥自检的 ${step} 超时（${stepTimeoutMs}ms）`)
      error.code = 'NODE_FINISH_BRIDGE_TIMEOUT'
      error.step = step
      rejectStep(error)
    }, stepTimeoutMs)
    Promise.resolve(promise).then(value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveStep(value)
    }, error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectStep(error)
    })
  })

  ensurePrivateDir(tmpRoot)
  const dir = await fsp.mkdtemp(join(tmpRoot, 'fs-bridge-'))
  ensurePrivateDir(dir)
  const gate = createFinishGate({
    executionId: 'self-test',
    nodeId: 'self-test',
    attempt: 1,
    workspaceRoot: dir,
  })
  const channel = await createFinishChannel({ gate, dir })
  let client
  let transport
  try {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: bridgeChildEnv({ ...channel.env, ...(isPlainObject(opts.env) ? opts.env : {}) }),
      stderr: 'pipe',
    })
    client = new Client({ name: 'flow-studio-probe', version: '0.13.1' })
    await withTimeout(client.connect(transport), 'connect')
    const listed = await withTimeout(client.listTools(), 'tools/list')
    const tools = Array.isArray(listed.tools) ? listed.tools : []
    if (!tools.some(tool => tool && tool.name === FINISH_TOOL_NAME)) {
      return { ok: false, reason: 'tool-missing', tools: tools.map(tool => tool && tool.name) }
    }
    const called = await withTimeout(client.callTool({
      name: FINISH_TOOL_NAME,
      arguments: { variables: { probe: true }, documents: [], summary: 'flow-studio finish bridge probe' },
    }), 'tools/call')
    if (!called || called.isError === true) {
      return { ok: false, reason: 'call-failed' }
    }
    let payload
    try {
      payload = JSON.parse(called.content[0].text)
    } catch {
      return { ok: false, reason: 'bad-result' }
    }
    if (!gate.settled()) return { ok: false, reason: 'gate-not-settled' }
    const record = payload && payload.record ? payload.record : payload
    return { ok: true, toolName: FINISH_TOOL_NAME, record }
  } catch (error) {
    const timedOut = Boolean(error && error.code === 'NODE_FINISH_BRIDGE_TIMEOUT')
    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'bridge-error',
      ...(error && typeof error.step === 'string' ? { step: error.step } : {}),
      message: error && error.message ? String(error.message).slice(0, 200) : 'unknown',
    }
  } finally {
    // 先抓住 pid：SDK 的 `close()` 会立刻把内部 `_process` 置空，之后再读 `pid` 就是 null，
    // 自检就会把 MCP server 留成孤儿。
    const bridgePid = transport && typeof transport.pid === 'number' ? transport.pid : null
    if (bridgePid !== null) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/T', '/F', '/PID', String(bridgePid)], { stdio: 'ignore', windowsHide: true })
        } else {
          process.kill(bridgePid, 'SIGKILL')
        }
      } catch {
        // 已经退出
      }
    }
    // 清理也必须有限：挂住的自检不能反过来卡住 probe。
    const cleanup = promise => new Promise(resolveCleanup => {
      const timer = setTimeout(resolveCleanup, cleanupTimeoutMs)
      Promise.resolve(promise).then(
        () => { clearTimeout(timer); resolveCleanup() },
        () => { clearTimeout(timer); resolveCleanup() },
      )
    })
    await cleanup(client?.close())
    await cleanup(transport?.close())
    await cleanup(channel.close())
    try {
      await fsp.rm(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

/** 判断是否作为脚本直接运行（Codex 的 MCP stdio 启动路径）。 */
function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) {
  runStdioServer().then(ok => {
    if (!ok) process.exitCode = 1
  }).catch(error => {
    process.stderr.write(`node-finish-mcp: 启动失败（${error && error.code ? error.code : 'unknown'}）\n`)
    process.exitCode = 1
  })
}
