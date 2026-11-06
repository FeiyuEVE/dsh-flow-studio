/**
 * 外部 executor（07 §6 / §8）：把节点交给 codex CLI 或任意 shell 命令跑，
 * 再用与内建 dsh executor 相同的口径收口（最终文本 → 结构化判定）。
 *
 * 纯模块：不 import 任何 dsh 包，也不直接持有进程管理策略——子进程一律走注入的
 * `spawn`（默认 `node:child_process.spawn`），测试注入假 spawn，永不真跑 codex。
 *
 * 三个职责边界：
 *   1. 归一化：节点配置 → 可执行 spec（kind / command / args / model），非法组合抛
 *      `EXECUTOR_INVALID`（中文原因）；
 *   2. codex 参数：只按 `codex exec --help`（0.166.0）真实支持的写法拼 argv；
 *   3. 运行：逐行消费 JSONL、归一化事件与用量、超时 / abort / 非 0 退出各自收口。
 *
 * @module @feiyueve/dsh-flow-studio/executor
 */

import { spawn as spawnProcess } from 'node:child_process'

/** 允许的 executor 种类；顺序即文档与下拉框的展示顺序。 */
export const EXECUTORS = Object.freeze(['dsh', 'codex', 'custom'])

/** codex 默认沙箱：与 07 §6 一致，允许在 workspace 内写，但不放全盘。 */
const DEFAULT_CODEX_SANDBOX = 'workspace-write'

/** `codex exec --help` 里 `-s/--sandbox` 的 possible values。 */
const CODEX_SANDBOXES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

/** stderr 只保留尾部，避免一条刷屏日志把事件数组撑爆（07 §8 要求 2000 字符）。 */
const STDERR_TAIL_MAX = 2000

/** 超时 / abort 后先 SIGTERM，再给 250ms 宽限 SIGKILL。 */
const KILL_GRACE_MS = 250

/** 构造带 code 的非法配置错误；上层按 `error.code === 'EXECUTOR_INVALID'` 分流。 */
function executorInvalid(message) {
  const error = new Error(message)
  error.name = 'ExecutorInvalidError'
  error.code = 'EXECUTOR_INVALID'
  return error
}

/** 非负整数归一化；非有限数字一律当 0。 */
function nonNegativeInt(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * 归一化节点上的 executor 配置。
 *
 * @param {object} node 节点（`executor` / `executorCommand` / `model` / `mode`）
 * @returns {{kind:'dsh'}|{kind:'codex',command:string,args:string[],model:string}|{kind:'custom',command:string,args:string[],model:string}}
 *   codex 的 `args` 只是基础 argv（`exec --json`）提示；cwd / schema / prompt 是每次运行的
 *   运行时参数，由 `runExternalExecutor` 调 `buildCodexArgs` 重算完整 argv。
 * @throws {{code:'EXECUTOR_INVALID', message:string}}
 */
export function normalizeExecutor(node) {
  const src = node && typeof node === 'object' ? node : {}
  const raw = src.executor
  const kind = raw === undefined || raw === null || raw === ''
    ? 'dsh'
    : typeof raw === 'string' ? raw.trim().toLowerCase() : String(raw)
  if (!EXECUTORS.includes(kind)) {
    throw executorInvalid(`不支持的 executor「${kind}」：只允许 dsh / codex / custom。`)
  }

  // team 模式需要引擎观察成员会话（07 §6），外部进程没有会话可观察，只能拒绝。
  const mode = typeof src.mode === 'string' ? src.mode.trim().toLowerCase() : 'single'
  if (kind !== 'dsh' && mode === 'team') {
    throw executorInvalid(`executor 为「${kind}」时执行方式必须是 single：team 模式需要引擎观察成员会话，外部进程做不到。`)
  }

  const model = typeof src.model === 'string' ? src.model.trim() : ''
  const command = typeof src.executorCommand === 'string' ? src.executorCommand.trim() : ''

  if (kind === 'dsh') return { kind: 'dsh' }
  if (kind === 'codex') {
    // 固定可执行名 codex；executorCommand 只作为「换个路径」的覆盖（如 ~/.local/bin/codex）。
    return { kind: 'codex', command: command || 'codex', args: ['exec', '--json'], model }
  }
  if (!command) {
    throw executorInvalid('executor 为 custom 时必须填写 executorCommand（要执行的命令模板）。')
  }
  return { kind: 'custom', command, args: [], model }
}

/**
 * 把一份「宽松」的 JSON Schema 改写成 codex `--output-schema` 能接受的严格形态。
 *
 * 为什么必须转：codex 0.166 把 `--output-schema` 当成 OpenAI 的 **strict structured
 * outputs** 用，服务端要求**每个 object 都带 `additionalProperties:false`，且 required
 * 必须列全所有 properties**。引擎自己的节点输出 schema 是宽松的（一堆 optional、
 * `additionalProperties:true`），原样传过去会被 400 拒掉：
 *   Invalid schema for response_format 'codex_output_schema': 'schema.additionalProperties'
 *   is required to be supplied and to be false when strict is true.
 * （2026-11-06 真 codex 实测，见 docs/design/06-execution-engine.md §17。）
 *
 * 转换规则（只严格化、不改语义）：
 *   - 有 `properties` 的 object：`additionalProperties:false` + `required` = 全部键；
 *     optional 字段于是变成「必须给（空数组 / 空串 / 0 / na）」——strict 模式的硬要求；
 *   - array：递归处理 `items`；
 *   - 带 `oneOf` / `anyOf` 的属性整条丢弃（strict 对联合类型支持不稳，宁缺勿炸）；
 *   - 其余关键字原样保留。
 *
 * @param {any} schema
 * @returns {any} 严格化后的新对象（不修改入参）
 */
export function toStrictOutputSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'required' || key === 'additionalProperties' || key === 'properties') continue
    if (Array.isArray(value)) out[key] = value.map(item => (item && typeof item === 'object' ? toStrictOutputSchema(item) : item))
    else out[key] = value && typeof value === 'object' ? toStrictOutputSchema(value) : value
  }
  if (schema.type === 'array') {
    out.items = toStrictOutputSchema(schema.items)
    return out
  }
  if (schema.properties && typeof schema.properties === 'object') {
    const properties = {}
    for (const [name, sub] of Object.entries(schema.properties)) {
      if (sub && typeof sub === 'object' && (sub.oneOf !== undefined || sub.anyOf !== undefined)) continue
      properties[name] = toStrictOutputSchema(sub)
    }
    out.properties = properties
    out.required = Object.keys(properties)
    out.additionalProperties = false
  }
  return out
}

/**
 * 拼 codex exec 的 argv。
 *
 * 依据：本机 codex 0.166.0 的 `codex exec --help`：
 *   - `--json`                 Print events to stdout as JSONL
 *   - `--output-schema <FILE>` Path to a JSON Schema file describing the final response shape
 *   - `-C, --cd <DIR>`         working root
 *   - `--skip-git-repo-check`  Allow running outside a Git repository
 *   - `-s, --sandbox <MODE>`   possible values: read-only / workspace-write / danger-full-access
 *   - `-m, --model <MODEL>`    Model the agent should use
 *   - `[PROMPT]`               positional，放在所有选项之后
 * 因此顺序是：exec → 输出格式 → schema → 工作目录 → git 检查 → 沙箱 → 模型 → prompt。
 *
 * @param {{cwd:string, schemaPath?:string, model?:string, sandbox?:string, prompt:string}} options
 * @returns {string[]}
 * @throws {{code:'EXECUTOR_INVALID', message:string}}
 */
export function buildCodexArgs({ cwd, schemaPath, model, sandbox = DEFAULT_CODEX_SANDBOX, prompt } = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw executorInvalid('codex 需要非空的工作目录 cwd。')
  }
  if (typeof prompt !== 'string') {
    throw executorInvalid('codex 需要字符串 prompt。')
  }
  const dir = cwd.trim()
  const mode = typeof sandbox === 'string' && sandbox.trim() !== '' ? sandbox.trim() : DEFAULT_CODEX_SANDBOX
  if (!CODEX_SANDBOXES.includes(mode)) {
    throw executorInvalid(`不支持的 codex sandbox「${mode}」：只允许 read-only / workspace-write / danger-full-access。`)
  }

  const args = ['exec', '--json']
  if (typeof schemaPath === 'string' && schemaPath.trim() !== '') {
    args.push('--output-schema', schemaPath.trim())
  }
  args.push('-C', dir, '--skip-git-repo-check', '-s', mode)
  if (typeof model === 'string' && model.trim() !== '') {
    args.push('-m', model.trim())
  }
  args.push(prompt)
  return args
}

/** 把 codex 的 usage 对象归一化成 `{ input, output, total }`；认不出返回 null。 */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = nonNegativeInt(raw.input_tokens ?? raw.inputTokens ?? raw.input)
  const output = nonNegativeInt(raw.output_tokens ?? raw.outputTokens ?? raw.output)
  const explicitTotal = raw.total_tokens ?? raw.totalTokens ?? raw.total
  const hasTokens = ['input_tokens', 'inputTokens', 'output_tokens', 'outputTokens', 'input', 'output']
    .some(key => Number.isFinite(raw[key]))
  if (!hasTokens) return null
  const total = Number.isFinite(explicitTotal) ? nonNegativeInt(explicitTotal) : input + output
  return { input, output, total }
}

/** 从事件里取一段可读文本，供 log 事件使用。 */
function textOf(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    for (const key of ['text', 'message', 'aggregated_output', 'output', 'command', 'reason']) {
      if (typeof value[key] === 'string') return value[key]
    }
  }
  return ''
}

/**
 * 容错解析一行 codex `--json` JSONL。绝不抛错：
 *   - 非 JSON / 空行 → log（空行 ignore）；
 *   - `item.completed` + `item.type==='agent_message'` → final；
 *   - `turn.completed` / `type==='usage'` 里的 usage → usage（归一化）；
 *   - 命令执行 / 推理 / 文件改动 → log；
 *   - 其余未知事件 → ignore（带可读文本时退化成 log）。
 *
 * @param {string} line
 * @returns {{kind:'ignore'}|{kind:'log',text:string,level?:string,itemType?:string}|{kind:'final',text:string}|{kind:'usage',usage:{input:number,output:number,total:number}}}
 */
export function parseCodexLine(line) {
  if (typeof line !== 'string') return { kind: 'ignore' }
  const raw = line.replace(/\r$/, '').trim()
  if (raw === '') return { kind: 'ignore' }

  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return { kind: 'log', text: raw }
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { kind: 'log', text: raw }

  const item = event.item && typeof event.item === 'object' && !Array.isArray(event.item)
    ? event.item
    : event.msg && typeof event.msg === 'object' && !Array.isArray(event.msg) ? event.msg : null
  const type = typeof event.type === 'string'
    ? event.type
    : typeof item?.type === 'string' ? item.type : ''

  // 用量：turn.completed 带 usage，或独立 usage 事件。
  const usage = normalizeUsage(event.usage) || (type === 'usage' ? normalizeUsage(event) : null)
  if (usage) return { kind: 'usage', usage }

  // 最终回答：新版本 codex 是 item.completed + agent_message；旧版本直接是 agent_message。
  const isAgentMessage = (type === 'item.completed' && item?.type === 'agent_message')
    || (type === 'agent_message' && (!item || item.type === 'agent_message'))
  if (isAgentMessage) {
    const text = item ? textOf(item) : textOf(event)
    return typeof text === 'string' && text !== '' ? { kind: 'final', text } : { kind: 'ignore' }
  }

  // 会话内的过程事件：命令执行 / 推理 / 文件改动，转成节点日志。
  if (type === 'item.completed' && item) {
    const itemType = typeof item.type === 'string' ? item.type : ''
    if (itemType === 'error') {
      const text = textOf(item)
      // codex 会把「你的 config.toml 里有不认识的键」这种告警发成 error 事件；
      // 它对结果没有任何影响，写进节点日志只会让人误以为执行出错。
      if (/unrecognized configuration setting/i.test(text)) return { kind: 'ignore' }
      return text !== '' ? { kind: 'log', text, level: 'error' } : { kind: 'ignore' }
    }
    if (itemType === 'command_execution' || itemType === 'reasoning'
      || itemType === 'file_change' || itemType === 'mcp_tool_call' || itemType === 'web_search') {
      const text = textOf(item)
      return text !== '' ? { kind: 'log', text, itemType } : { kind: 'ignore' }
    }
  }

  // 显式失败事件：当错误日志，别让上层误以为成功。
  if (type === 'error' || type === 'turn.failed' || type === 'item.failed') {
    const text = textOf(event.error) || textOf(event)
    return text !== '' ? { kind: 'log', text, level: 'error' } : { kind: 'ignore' }
  }

  // 带可读文本的未知事件退化成日志；其余（started / updated / thread.started …）忽略。
  const fallback = textOf(event)
  return fallback !== '' ? { kind: 'log', text: fallback } : { kind: 'ignore' }
}

/** POSIX shell 安全转义：单引号包裹 + 内部单引号写成 '\''。 */
function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, `'\\''`)}'`
}

/**
 * custom executor 的命令模板：替换 {prompt} / {schema} / {cwd}；
 * 三个占位符都没有时，把 prompt 作为最后一个参数追加（同样做 shell 转义）。
 */
function buildCustomScript(template, { prompt, schemaPath, cwd }) {
  let replaced = false
  let script = String(template).replace(/\{prompt\}/g, () => {
    replaced = true
    return shellQuote(prompt)
  }).replace(/\{schema\}/g, () => {
    replaced = true
    return shellQuote(schemaPath || '')
  }).replace(/\{cwd\}/g, () => {
    replaced = true
    return shellQuote(cwd || '')
  })
  if (!replaced) script = `${script} ${shellQuote(prompt)}`
  return script
}

/**
 * 与引擎 `parseAssistantStructured` 同一口径（不 import engine，避免把 fs 拉进来）：
 * 先试整段，再试 ```json 围栏，最后取首个 `{` 到末个 `}`；只有普通对象算数，
 * 解析不出返回 null（不在这里抛错，由上层决定要不要报结构化失败）。
 */
function parseStructured(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const text = raw.trim()
  const candidates = [text]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced) candidates.push(fenced[1].trim())
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // 换下一个候选。
    }
  }
  return null
}

/** 只留尾部 N 个字符（按 UTF-16 码元，与事件日志的长度口径一致）。 */
function tailOf(value, max) {
  return value.length > max ? value.slice(-max) : value
}

/**
 * 跑一个外部 executor。
 *
 * custom 一律 `sh -c <模板>`；codex 直接 argv 执行，不经过 shell。
 * 返回 `{ ok, text, structured, exitCode, usage, events }`；失败时追加
 * `reason`（timeout / aborted / exit / spawn），非 0 退出再带 `tail`。
 *
 * @param {{
 *   spec: {kind:string, command?:string, model?:string, schemaPath?:string, sandbox?:string},
 *   prompt: string,
 *   cwd?: string,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   spawn?: Function,
 *   onEvent?: (event: object) => void,
 * }} options
 * @returns {Promise<{ok:boolean, text:string, structured:object|null, exitCode:number|null,
 *   usage:{input:number,output:number,total:number}|null, events:object[], reason?:string,
 *   tail?:string, message?:string}>}
 */
export async function runExternalExecutor({
  spec,
  prompt = '',
  cwd = process.cwd(),
  timeoutMs = 0,
  signal,
  spawn = spawnProcess,
  onEvent,
} = {}) {
  if (!spec || typeof spec !== 'object') {
    throw executorInvalid('缺少 executor spec：先用 normalizeExecutor(node) 归一化。')
  }
  if (spec.kind === 'dsh') {
    throw executorInvalid('dsh 是内建 executor，不需要外部进程；runExternalExecutor 只接收 codex / custom。')
  }
  if (spec.kind !== 'codex' && spec.kind !== 'custom') {
    throw executorInvalid(`不支持的外部 executor「${spec.kind}」：只允许 codex / custom。`)
  }
  if (typeof spawn !== 'function') {
    throw executorInvalid('runExternalExecutor 需要可注入的 spawn 函数。')
  }

  const events = []
  let stdoutAll = ''
  let stdoutBuffer = ''
  let stderrTail = ''
  let stderrEmitted = false
  let finalText = ''
  let usage = null
  let settled = false
  let interruptReason = null
  let child = null
  let timer = null

  const emit = (event) => {
    events.push(event)
    if (typeof onEvent === 'function') {
      try {
        onEvent(event)
      } catch {
        // 消费方自己的异常不能带崩执行器。
      }
    }
  }

  const emitStderr = () => {
    if (stderrEmitted || stderrTail === '') return
    stderrEmitted = true
    emit({ kind: 'stderr', text: stderrTail })
  }

  const currentText = () => finalText || (spec.kind === 'custom' ? stdoutAll.trim() : '')

  const snapshot = () => {
    const text = currentText()
    return {
      text,
      structured: parseStructured(text),
      usage,
      events,
    }
  }

  const killChild = () => {
    if (!child || typeof child.kill !== 'function') return
    try {
      child.kill('SIGTERM')
    } catch {
      // 已经退出就忽略。
    }
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 同上。
      }
    }, KILL_GRACE_MS)
    if (killer && typeof killer.unref === 'function') killer.unref()
  }

  // 先把命令与 argv 算好：配置错误在起进程之前就以 EXECUTOR_INVALID 抛出。
  let command
  let args
  if (spec.kind === 'codex') {
    command = spec.command || 'codex'
    args = buildCodexArgs({
      cwd,
      schemaPath: spec.schemaPath,
      model: spec.model,
      sandbox: spec.sandbox,
      prompt,
    })
  } else {
    command = 'sh'
    args = ['-c', buildCustomScript(spec.command, { prompt, schemaPath: spec.schemaPath, cwd })]
  }

  const consumeLine = (line) => {
    const parsed = parseCodexLine(line)
    if (parsed.kind === 'ignore') return
    emit(parsed)
    if (parsed.kind === 'final') finalText = parsed.text
    if (parsed.kind === 'usage') usage = parsed.usage
  }

  const flushCompleteLines = () => {
    let index = stdoutBuffer.indexOf('\n')
    while (index >= 0) {
      const line = stdoutBuffer.slice(0, index)
      stdoutBuffer = stdoutBuffer.slice(index + 1)
      consumeLine(line)
      index = stdoutBuffer.indexOf('\n')
    }
  }

  return await new Promise((resolve) => {
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
      resolve(result)
    }

    const failWith = (reason, extra = {}) => {
      emitStderr()
      finish({
        ok: false,
        reason,
        exitCode: Object.prototype.hasOwnProperty.call(extra, 'exitCode') ? extra.exitCode : null,
        ...snapshot(),
        ...extra,
      })
    }

    const succeed = (exitCode) => {
      emitStderr()
      finish({ ok: true, exitCode, ...snapshot() })
    }

    /**
     * 超时 / abort / spawn 失败：先记下终止原因再 kill。某些桩 spawn 的 kill 会同步
     * emit close，若不先记原因，close 会把 timeout/abort 误记成 exit。
     */
    const interrupt = (reason) => {
      if (settled) return
      interruptReason = reason
      killChild()
      failWith(reason)
    }

    const onAbort = () => {
      interrupt('aborted')
    }

    // 已经 abort 的 signal 不再起进程。
    if (signal && signal.aborted) {
      failWith('aborted')
      return
    }

    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      failWith('spawn', { message: error && error.message ? error.message : String(error) })
      return
    }
    if (!child || !child.stdout || !child.stderr || typeof child.on !== 'function') {
      failWith('spawn', { message: '子进程没有可用的 stdout / stderr 通道。' })
      return
    }

    if (typeof child.stdout.setEncoding === 'function') child.stdout.setEncoding('utf8')
    if (typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      stdoutAll += text
      stdoutBuffer += text
      flushCompleteLines()
    })
    child.stderr.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      stderrTail = tailOf(stderrTail + text, STDERR_TAIL_MAX)
    })
    child.on('error', (error) => {
      if (settled) return
      interruptReason = 'spawn'
      killChild()
      failWith('spawn', { message: error && error.message ? error.message : String(error) })
    })
    child.on('close', (code) => {
      if (settled) return
      if (interruptReason) {
        failWith(interruptReason)
        return
      }
      // 半行在 EOF 处也算一行（某些桩命令不补换行）。
      if (stdoutBuffer.trim() !== '') consumeLine(stdoutBuffer)
      stdoutBuffer = ''
      const exitCode = Number.isInteger(code) ? code : null
      if (exitCode === 0) {
        succeed(0)
        return
      }
      emitStderr()
      const tail = stderrTail !== '' ? stderrTail : tailOf(stdoutAll, STDERR_TAIL_MAX)
      finish({
        ok: false,
        reason: 'exit',
        exitCode,
        ...snapshot(),
        tail,
      })
    })

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        interrupt('timeout')
      }, timeoutMs)
    }
  })
}
