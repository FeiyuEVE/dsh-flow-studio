/**
 * 外部 executor（07 §6 / §8）：把节点交给 codex CLI 或任意 shell 命令跑，
 * 再用与内建 dsh executor 相同的口径收口（最终文本 → 结构化判定）。
 *
 * 纯模块：不 import 任何 dsh 包，也不直接持有进程管理策略——子进程一律走注入的
 * `spawn`（默认 `node:child_process.spawn`），测试注入假 spawn，永不真跑 codex。
 *
 * ## custom executor 的 prompt 传递契约（RCE 修复后，三条通道并存）
 *
 * prompt 里可能携带外部消息、上游节点产物等不可信内容，**绝不作为 shell 文本被解析或拼接**：
 *
 *   1. **文件 + `{prompt}`（主通道）**：每次执行把 prompt 原文写进本次专用的临时目录
 *      （目录 0700）下的普通文件（0600），路径经环境变量 `FLOW_STUDIO_PROMPT_FILE` 暴露。
 *      命令模板里的 `{prompt}` 被替换成 `"$(cat -- "$FLOW_STUDIO_PROMPT_FILE")"`：
 *      外层双引号防止分词/通配符展开，命令替换只执行 `cat`，读到的是我们自己写入的
 *      文件字节，prompt 内容不参与任何 shell 解析。该文件在本次执行结束时删除——
 *      成功、非 0 退出、超时、abort、spawn 失败都用同一条 `finish()` 清理路径。
 *      注意：命令替换按 POSIX 会剥掉内容**末尾的换行**；需要逐字节原文（含结尾换行）
 *      请直接读 `$FLOW_STUDIO_PROMPT_FILE` 或 stdin。
 *   2. **环境变量直传（兼容通道）**：prompt 的 UTF-8 字节数 ≤ 64KiB 时设置
 *      `FLOW_STUDIO_PROMPT`；超过就不设置（Linux 单条 env 字符串约 128KiB 上限，
 *      超了 execve 会 E2BIG）。**大 prompt 请用 `{prompt}` 或 `"$FLOW_STUDIO_PROMPT_FILE"`。**
 *   3. **stdin（兜底通道）**：prompt 原文完整写入子进程 stdin 后 `end()`；子进程不读
 *      stdin 时的 EPIPE / 管道错误一律吞掉，不影响本次执行结果。
 *
 * 占位符位置限制：`{prompt}` 落在**单引号内**（`'{prompt}'`）是**不支持的位置**——
 * shell 不展开变量，实际传给程序的是替换产物字面量
 * `"$(cat -- "$FLOW_STUDIO_PROMPT_FILE")"`，不是 prompt 原文（也不会产生注入）。
 * 需要 prompt 原文时，请把占位符放在普通位置或双引号内。
 *
 * 替换形态按占位符所处的 shell 引号上下文选择：普通位置用自带双引号的
 * `"$(cat -- "$FLOW_STUDIO_PROMPT_FILE")"`；已经在双引号内时用不带外层引号的
 * `$(cat -- "$FLOW_STUDIO_PROMPT_FILE")`——避免 `""$(...)""` 把命令替换挤出引号，
 * 让 `"前缀 {prompt}"` 这类模板也能逐字节保真。
 *
 * 三个职责边界：
 *   1. 归一化：节点配置 → 可执行 spec（kind / command / args / model），非法组合抛
 *      `EXECUTOR_INVALID`（中文原因）；
 *   2. codex 参数：只按 `codex exec --help`（0.166.0）真实支持的写法拼 argv；
 *   3. 运行：逐行消费 JSONL、归一化事件与用量、超时 / abort / 非 0 退出各自收口。
 *
 * ## 进程组与收尾（外部 executor 的生命周期契约）
 *
 * custom 是 `sh -c <模板>`：模板里的管道 / 后台命令会派生**孙进程**，它们同样继承
 * stdout / stderr 管道。历史缺陷：timeout / abort 只对直接子进程发 SIGTERM（250ms 后
 * SIGKILL），孙进程会变成孤儿继续跑（继续改 worktree、占 CPU），遗留的管道还会让宿主
 * 进程一直持有 fd、吊住事件循环。
 *
 * 现在的做法：
 *   - spawn 时 `detached: true`（POSIX）：子进程 `setsid()` 成为新会话 / 新进程组的组长，
 *     `sh -c` 派生的所有孙进程都落在同一个进程组（pgid = 直接子进程 pid）；
 *   - abort / timeout 时 `process.kill(-child.pid, 'SIGTERM')`，`KILL_GRACE_MS` 后
 *     `process.kill(-child.pid, 'SIGKILL')`；
 *   - 无法用进程组时优雅退化（Windows、无权限、注入的非真实 ChildProcess）：只杀直接
 *     子进程，不抛错，但把降级原因记进结果（`killScope` / `orphanWarning`）与一条 warn 日志；
 *   - `finish()` 统一 `destroy()` 子进程的 stdout / stderr，任何收口路径都不把管道留给宿主。
 *
 * @module @feiyueve/dsh-flow-studio/executor
 */

import { ChildProcess, spawn as spawnProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { createBoundedOutput, redactDeep, redactText } from './process-output.js'

/** 允许的 executor 种类；顺序即文档与下拉框的展示顺序。 */
export const EXECUTORS = Object.freeze(['dsh', 'codex', 'custom'])

/** codex 默认沙箱：与 07 §6 一致，允许在 workspace 内写，但不放全盘。 */
const DEFAULT_CODEX_SANDBOX = 'workspace-write'

/** `codex exec --help` 里 `-s/--sandbox` 的 possible values。 */
const CODEX_SANDBOXES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

/** stderr 只保留尾部，避免一条刷屏日志把事件数组撑爆（07 §8 要求 2000 字符）。 */
const STDERR_TAIL_MAX = 2000

/**
 * stderr 在脱敏之前的原始保留上限（**字节**）。
 *
 * 为什么不是直接保留 2000 字符：脱敏必须看到完整凭据才能替换（例如 `token=...` 的值跨
 * chunk，或 Bearer 前缀在更早的数据里）。先保留一段有界原文，整体脱敏后再裁到
 * `STDERR_TAIL_MAX`，避免「先裁出 token 前缀再脱敏」把后缀漏出去。
 * 65536 字节本身有界，且与 stdout 共享 maxBytes 预算（见 appendStderr），不会随输出
 * 无限增长，也不会让结果里的 retainedBytes 超过配置上限。
 */
const STDERR_RETAIN_BYTES = 64 * 1024

/** 诊断 tail 上限（结果里的 `tail` 字段），同时也是 createBoundedOutput 的 maxTail 默认。 */
const OUTPUT_TAIL_MAX = 16 * 1024

/** 输出字节上限默认值：stdout + stderr 原始输入字节（0.11 R3）。 */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** 规范化事件条数默认上限（0.11 R3）。 */
const DEFAULT_MAX_EVENTS = 5000

/** 部署侧覆盖输出字节上限的环境变量名。 */
const MAX_OUTPUT_BYTES_ENV = 'FLOW_STUDIO_EXECUTOR_MAX_OUTPUT_BYTES'

/** 部署侧覆盖事件条数上限的环境变量名。 */
const MAX_EVENTS_ENV = 'FLOW_STUDIO_EXECUTOR_MAX_EVENTS'

/** 超时 / abort 后先 SIGTERM，再给 250ms 宽限 SIGKILL。 */
const KILL_GRACE_MS = 250

/**
 * 完整字符串校验的正整数上限：`/^\d+$/` 且 > 0。
 *
 * 刻意不用 `parseInt`：`parseInt('2x') === 2` 会让拼错的部署配置静默生效，比回默认更危险。
 * 数字选项同样要求安全正整数；`0` / 负数 / 小数 / NaN 都不合法。
 */
function positiveLimit(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

/** 非法配置回默认并留一条 warning；返回值永远是可用的正整数。 */
function resolveOutputLimit(optionValue, envKey, fallback, label) {
  if (optionValue !== undefined && optionValue !== null) {
    const parsed = positiveLimit(optionValue)
    if (parsed !== null) return parsed
    warnInvalidLimit(label, optionValue, fallback)
    return fallback
  }
  const envValue = process.env[envKey]
  if (envValue !== undefined) {
    const parsed = positiveLimit(envValue)
    if (parsed !== null) return parsed
    warnInvalidLimit(label, envValue, fallback)
    return fallback
  }
  return fallback
}

/** 非法上限的 warn：不抛错，也不让一次配置笔误改变执行语义（回默认继续跑）。 */
function warnInvalidLimit(label, value, fallback) {
  const message = `${label}「${String(value)}」不是 >0 的正整数（要求完整匹配 /^\\d+$/），已回落到默认值 ${fallback}。`
  if (typeof process.emitWarning === 'function') {
    process.emitWarning(message, 'ExecutorOutputLimitWarning')
    return
  }
  console.warn(message)
}


/**
 * 是否用 `detached: true` 让子进程成为新进程组的组长。
 *
 * POSIX：`detached` 让子进程 `setsid()`，`sh -c` 派生的孙进程全部继承同一个 pgid，
 * 终止时 `process.kill(-pid, …)` 才能一次杀干净整组。
 * Windows：没有 POSIX 进程组语义，`detached` 只会另开控制台窗口，反而改变行为；
 * 这里显式退化——只杀直接子进程，并在结果里记 `orphanWarning`。
 */
const CAN_DETACH = process.platform !== 'win32'

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

/**
 * 把 codex 的 usage 对象归一化成四桶 `{ input, cacheRead, cacheWrite, output, total }`；
 * 认不出返回 null。
 *
 * **口径（05 §3）**：codex 的 `input_tokens` 是「命中缓存 + 未命中」的总和，
 * `cached_input_tokens` / `cache_write_input_tokens` 是其中的子集，不是额外增量。
 * 所以必须**从 input 里扣掉**再独立成桶：
 *   - `cacheRead  = cached_input_tokens`（或 cachedInputTokens / cache_read_input_tokens）
 *   - `cacheWrite = cache_write_input_tokens`（或 cacheWriteInputTokens）
 *   - `input      = max(0, input_tokens − cacheRead − cacheWrite)`
 *   - `total      = input_tokens + output_tokens`（显式给了 total_tokens 就用它）
 * 这样四桶之和恒等于旧口径的 total（`input_tokens + output`），`tokenTotal` 不变；
 * 缓存桶只是把原来记进 input 的那部分挪到正确的桶里。
 *
 * 防御：上游若给出 cached > input 这类矛盾数据，两个缓存桶按 raw input 上限截断
 * （先读后写），保证「四桶之和 === total」这条不变量不被坏数据破坏。
 *
 * @param {object} raw
 * @returns {{input:number, cacheRead:number, cacheWrite:number, output:number, total:number}|null}
 */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rawInput = nonNegativeInt(raw.input_tokens ?? raw.inputTokens ?? raw.input)
  const output = nonNegativeInt(raw.output_tokens ?? raw.outputTokens ?? raw.output)
  const explicitTotal = raw.total_tokens ?? raw.totalTokens ?? raw.total
  const hasTokens = ['input_tokens', 'inputTokens', 'output_tokens', 'outputTokens', 'input', 'output']
    .some(key => Number.isFinite(raw[key]))
  if (!hasTokens) return null
  const cached = nonNegativeInt(
    raw.cached_input_tokens ?? raw.cachedInputTokens ?? raw.cache_read_input_tokens,
  )
  const cacheWriteRaw = nonNegativeInt(raw.cache_write_input_tokens ?? raw.cacheWriteInputTokens)
  // 矛盾数据（缓存比 input 还大）按 raw input 截断，守住四桶之和 === total。
  const cacheRead = Math.min(cached, rawInput)
  const cacheWrite = Math.min(cacheWriteRaw, rawInput - cacheRead)
  const input = Math.max(0, rawInput - cacheRead - cacheWrite)
  const total = Number.isFinite(explicitTotal) ? nonNegativeInt(explicitTotal) : rawInput + output
  return { input, cacheRead, cacheWrite, output, total }
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
 * @returns {{kind:'ignore'}|{kind:'log',text:string,level?:string,itemType?:string}|{kind:'final',text:string}|{kind:'usage',usage:{input:number,cacheRead:number,cacheWrite:number,output:number,total:number}}}
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

/** POSIX shell 安全转义：单引号包裹 + 内部单引号写成 '\''。只用于 schema / cwd。 */
function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, `'\\''`)}'`
}

/** custom executor 接收 prompt 原文的环境变量名（兼容通道，仅 ≤64KiB 时设置）。 */
const CUSTOM_PROMPT_ENV = 'FLOW_STUDIO_PROMPT'

/** custom executor 接收 prompt 临时文件路径的环境变量名（主通道）。 */
const CUSTOM_PROMPT_FILE_ENV = 'FLOW_STUDIO_PROMPT_FILE'

/**
 * `FLOW_STUDIO_PROMPT` 直传的字节上限。
 *
 * Linux 单条环境变量字符串上限约 128KiB（MAX_ARG_STRLEN），超了 execve 会 E2BIG；
 * 这里取 64KiB 留余量，超过就只走文件 / stdin 通道（见模块顶部契约）。
 */
const CUSTOM_PROMPT_ENV_MAX_BYTES = 64 * 1024

/**
 * `{prompt}` 的替换产物：读本次执行专用的 prompt 文件。
 *
 * `"$(cat -- "$FLOW_STUDIO_PROMPT_FILE")"`：外层双引号防止分词 / 通配符展开；
 * 命令替换只执行 `cat`，读的是我们自己写入的普通文件字节，prompt 内容不参与任何
 * shell 解析。命令替换按 POSIX 会剥掉末尾换行——要逐字节原文请读文件或 stdin。
 *
 * 不支持的位置：占位符落在**单引号内**（`'{prompt}'`）时 shell 不展开，传给程序的
 * 是替换产物字面量（见模块顶部契约），不会产生注入。
 */
const CUSTOM_PROMPT_REFERENCE = '"$(cat -- "$' + CUSTOM_PROMPT_FILE_ENV + '")"'

/**
 * 双引号内使用的替换产物：外层引号已经存在，不能再自带一层。
 * 否则 `"{prompt}"` 会变成 `""$(...)""`，命令替换落到引号外被分词 / 通配符展开。
 */
const CUSTOM_PROMPT_REFERENCE_IN_QUOTES = '$(cat -- "$' + CUSTOM_PROMPT_FILE_ENV + '")'

/**
 * 把模板里的 `{prompt}` 换成读文件命令，并按占位符所处的 shell 引号上下文选形态：
 *   - 普通位置：`CUSTOM_PROMPT_REFERENCE`（自带双引号）；
 *   - 双引号内：`CUSTOM_PROMPT_REFERENCE_IN_QUOTES`（外层引号已存在）；
 *   - 单引号内：照常替换，但 shell 不展开，属于「不支持的位置」。
 *
 * 扫描只跟踪单 / 双引号（以及双引号内的反斜杠转义），足以覆盖命令模板的常见写法；
 * 误判不会引入注入——两种形态都只是 cat 我们自己写的文件，prompt 内容不参与解析。
 */
function replacePromptPlaceholders(template) {
  const text = String(template)
  const token = '{prompt}'
  let out = ''
  let quote = ''
  let index = 0
  while (index < text.length) {
    const ch = text[index]
    if (quote === "'") {
      if (ch === "'") {
        quote = ''
        out += ch
        index += 1
        continue
      }
      if (text.startsWith(token, index)) {
        // 单引号内不做特殊处理：替换产物在这里只是普通字符，不会被展开。
        out += CUSTOM_PROMPT_REFERENCE
        index += token.length
        continue
      }
      out += ch
      index += 1
      continue
    }
    if (quote === '"') {
      if (ch === '\\' && index + 1 < text.length) {
        out += text.slice(index, index + 2)
        index += 2
        continue
      }
      if (ch === '"') {
        quote = ''
        out += ch
        index += 1
        continue
      }
      if (text.startsWith(token, index)) {
        out += CUSTOM_PROMPT_REFERENCE_IN_QUOTES
        index += token.length
        continue
      }
      out += ch
      index += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      out += ch
      index += 1
      continue
    }
    if (ch === '\\' && index + 1 < text.length) {
      out += text.slice(index, index + 2)
      index += 2
      continue
    }
    if (text.startsWith(token, index)) {
      out += CUSTOM_PROMPT_REFERENCE
      index += token.length
      continue
    }
    out += ch
    index += 1
  }
  return out
}

/**
 * 建本次执行专用的 prompt 临时文件：唯一临时目录（0700）+ 普通文件（0600）。
 * 写失败时自己清理刚建的目录再把错误抛出去，避免半成品残留。
 *
 * @param {string} prompt
 * @returns {{dir:string,file:string}}
 */
function createPromptFile(prompt) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-studio-prompt-'))
  try {
    const file = join(dir, 'prompt.txt')
    writeFileSync(file, prompt, { encoding: 'utf8', mode: 0o600 })
    return { dir, file }
  } catch (error) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不改变错误语义。
    }
    throw error
  }
}

/** 删除 prompt 临时文件；任何清理失败都吞掉，清理不能改变本次执行结果。 */
function removePromptFile(state) {
  if (!state || typeof state.dir !== 'string') return
  try {
    rmSync(state.dir, { recursive: true, force: true })
  } catch {
    // 同上：清理是尽力而为。
  }
}

/**
 * custom executor 的命令模板：替换 {prompt} / {schema} / {cwd}。
 *
 * - `{prompt}` → 读 `FLOW_STUDIO_PROMPT_FILE` 的命令替换（按所在引号上下文选择形态，
 *   见 `replacePromptPlaceholders`），prompt 原文不进命令文本；
 * - `{schema}` / `{cwd}` → POSIX 单引号转义（它们来自节点配置，不是 prompt 通道）；
 * - 命令里没有 `{prompt}` 时**不改命令文本**：prompt 走 `FLOW_STUDIO_PROMPT_FILE` /
 *   `FLOW_STUDIO_PROMPT`（小 prompt）/ stdin。
 */
function buildCustomScript(template, { schemaPath, cwd } = {}) {
  return replacePromptPlaceholders(template)
    .replace(/\{schema\}/g, () => shellQuote(schemaPath || ''))
    .replace(/\{cwd\}/g, () => shellQuote(cwd || ''))
}

/**
 * 把 prompt 原文写进 custom 子进程的 stdin，然后 `end()`。
 *
 * 子进程不一定读 stdin（例如 `true`）：此时写管道会拿到 EPIPE / ECONNRESET，
 * 这是预期行为，必须吞掉——否则一次成功的执行会被 stdin 的未捕获 error 事件带崩。
 */
function feedPromptToStdin(child, prompt) {
  const stdin = child && child.stdin
  if (!stdin || typeof stdin.write !== 'function' || typeof stdin.end !== 'function') return
  if (typeof stdin.on === 'function') stdin.on('error', () => {})
  try {
    // 一次写入 + 关闭：prompt 保持原文字节，不做任何编码/转义变换。
    stdin.end(prompt)
  } catch {
    // 子进程已退出等原因写不进去，同样不影响本次执行的结果。
  }
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
 * custom 的 prompt 原文只走三条数据通道：临时文件（`FLOW_STUDIO_PROMPT_FILE`，主）/
 * 小 prompt 的 `FLOW_STUDIO_PROMPT`（≤64KiB 兼容）/ 子进程 stdin（全文兜底）；
 * 命令模板里只有读文件的命令替换 `"$(cat -- "$FLOW_STUDIO_PROMPT_FILE")"`，
 * 绝无 prompt 文本参与 shell 解析。临时文件在本次执行收口时删除。
 * 返回 `{ ok, text, structured, exitCode, usage, events, killScope, orphanWarning }`；
 * 失败时追加 `reason`（timeout / aborted / exit / spawn / OUTPUT_LIMIT），非 0 退出再带 `tail`。
 * 输出越界时统一返回：
 *   `{ ok:false, reason:'OUTPUT_LIMIT', code:'OUTPUT_LIMIT', truncated:true,
 *      receivedBytes, retainedBytes, eventCount, tail, ... }`，并已终止进程组。
 * `killScope`：`'group'` = 按进程组终止（孙进程一起），`'process'` = 只终止了直接子进程，
 * `null` = 本次没有发生终止；`orphanWarning`：非 null 时说明进程组不可用、孙进程可能残留。
 *
 * 输出上限（0.11 R3）：`maxOutputBytes` / `maxEvents` 选项优先，其次环境变量
 * `FLOW_STUDIO_EXECUTOR_MAX_OUTPUT_BYTES` / `FLOW_STUDIO_EXECUTOR_MAX_EVENTS`，最后默认
 * 8 MiB / 5000。非法值（非 `/^\d+$/` 或 ≤0）回默认并 warn，绝不用 parseInt 接受 "2x"。
 * stdout + stderr 的原始字节在 decode / 保留之前累计；事件、text、tail、message 在对外
 * 可见之前都会先脱敏（`process-output.redactText` / `redactDeep`）。
 *
 * @param {{
 *   spec: {kind:string, command?:string, model?:string, schemaPath?:string, sandbox?:string},
 *   prompt: string,
 *   cwd?: string,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   spawn?: Function,
 *   onEvent?: (event: object) => void,
 *   maxOutputBytes?: number|string,
 *   maxEvents?: number|string,
 * }} options
 * @returns {Promise<{ok:boolean, text:string, structured:object|null, exitCode:number|null,
 *   usage:{input:number,cacheRead:number,cacheWrite:number,output:number,total:number}|null, events:object[], reason?:string,
 *   code?:string, truncated?:boolean, receivedBytes?:number, retainedBytes?:number,
 *   eventCount?:number, tail?:string, message?:string,
 *   killScope:'group'|'process'|null, orphanWarning:string|null}>}
 */
export async function runExternalExecutor({
  spec,
  prompt = '',
  cwd = process.cwd(),
  timeoutMs = 0,
  signal,
  spawn = spawnProcess,
  onEvent,
  maxOutputBytes,
  maxEvents,
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

  // 上限解析放在起进程之前：配置笔误只影响保留额度，不影响 spawn 参数。
  const outputByteLimit = resolveOutputLimit(
    maxOutputBytes,
    MAX_OUTPUT_BYTES_ENV,
    DEFAULT_MAX_OUTPUT_BYTES,
    '外部 executor 输出字节上限',
  )
  const outputEventLimit = resolveOutputLimit(
    maxEvents,
    MAX_EVENTS_ENV,
    DEFAULT_MAX_EVENTS,
    '外部 executor 事件条数上限',
  )

  /**
   * 全路径共享的有界保留器：stdout 文本、事件队列都在这里。
   *
   * 不再保留 `stdoutAll` / 无界 `events` 第二份副本；stdout 的半行缓冲
   * （`stdoutBuffer`）只会累积「已接受进保留额度」的文本，因此同样 ≤ maxBytes。
   */
  const output = createBoundedOutput({
    maxBytes: outputByteLimit,
    maxEvents: outputEventLimit,
    maxTail: Math.min(OUTPUT_TAIL_MAX, outputByteLimit),
  })
  /** stdout 未闭合的半行（有界：只接收 output 接受了的前缀）。 */
  let stdoutBuffer = ''
  /**
   * stderr 的原始保留尾部（脱敏前）。它本身有界，且与 stdout 共享 maxBytes 预算：
   * 上限按「剩余字节 / 3」折算成 UTF-16 码元数（每个码元最多编码 3 个 UTF-8 字节），
   * 因此 `Buffer.byteLength(stderrTail)` 不会超过剩余预算。
   */
  let stderrTail = ''
  /** stderr 累计接收的原始字节（与 stdout 一起计入 maxBytes）。 */
  let stderrReceivedBytes = 0
  let stderrEmitted = false
  let finalText = ''
  let usage = null
  let settled = false
  /**
   * 输出越界 / 收口后置 true：此后不再处理 data、不再 emit，迟到的 close/error
   * 也不能改写结论（与 settled 一起构成唯一收口闸门）。
   */
  let writeClosed = false
  let interruptReason = null
  let child = null
  let timer = null
  /**
   * 输出越界时由 Promise 内部的 `interrupt('OUTPUT_LIMIT')` 接手；emit 在越界后
   * 可能仍被 killChild 的告警路径调用，所以用回调而不是直接引用内部闭包。
   */
  let onOutputLimit = null

  const emit = (event) => {
    if (settled || writeClosed || !event || typeof event !== 'object') return false
    // 事件对象先递归脱敏（数组 / 嵌套字符串都覆盖），再进有界队列与 onEvent。
    const safe = redactDeep(event)
    if (!output.pushEvent(safe)) {
      // 事件条数越界：交给统一 OUTPUT_LIMIT 收口（先置原因再杀进程组）。
      if (typeof onOutputLimit === 'function') onOutputLimit()
      return false
    }
    if (typeof onEvent === 'function') {
      try {
        onEvent(safe)
      } catch {
        // 消费方自己的异常不能带崩执行器。
      }
    }
    return true
  }

  const emitStderr = () => {
    if (stderrEmitted || stderrTail === '' || writeClosed) return
    stderrEmitted = true
    // 先对整段 stderr 脱敏，再裁到事件上限：避免先裁出 token 前缀导致后缀漏网。
    emit({ kind: 'stderr', text: tailOf(redactText(stderrTail), STDERR_TAIL_MAX) })
  }

  const currentText = () => {
    if (finalText !== '') return finalText
    if (spec.kind !== 'custom') return ''
    // custom 的最终文本仍受 maxBytes 约束（output.text() 就是有界前缀）。
    return redactText(output.text().trim())
  }

  const snapshot = () => {
    const text = currentText()
    return {
      text,
      structured: parseStructured(text),
      usage,
      events: output.eventList(),
    }
  }

  /** stdout + stderr 的原始接收字节（用于 OUTPUT_LIMIT 结果的自证）。 */
  const totalReceivedBytes = () => output.receivedBytes + stderrReceivedBytes

  /**
   * stderr 还能保留多少 UTF-16 码元：按剩余字节预算折算（每码元最多 3 字节）。
   * stdout 每接受一段，剩余预算就变小，stderr 会跟着从头部收缩（见 trimStderr）。
   */
  const stderrRetainedCharLimit = () => {
    const remaining = Math.max(0, outputByteLimit - output.retainedBytes)
    return Math.floor(Math.min(STDERR_RETAIN_BYTES, remaining) / 3)
  }

  /** 按当前共享预算裁掉 stderr 多出来的头部（保留尾部，尾部才是诊断与脱敏需要的）。 */
  const trimStderr = () => {
    const limit = stderrRetainedCharLimit()
    if (limit === 0) {
      stderrTail = ''
      return
    }
    if (stderrTail.length > limit) stderrTail = tailOf(stderrTail, limit)
  }

  /** 追加 stderr 文本：先按预算粗切 chunk，再保留整体尾部，避免大 chunk 全量拼接。 */
  const appendStderr = (text) => {
    if (text === '') return
    const limit = stderrRetainedCharLimit()
    if (limit === 0) {
      stderrTail = ''
      return
    }
    const piece = text.length > limit ? text.slice(-limit) : text
    stderrTail = tailOf(stderrTail + piece, limit)
  }

  /** 保留文本 + stderr 保留字节；两侧共享预算，合计不超过 maxBytes。 */
  const totalRetainedBytes = () => output.retainedBytes + Buffer.byteLength(stderrTail, 'utf8')

  /**
   * 诊断 tail：优先 stderr（失败原因通常在那里），否则取 stdout 尾部。
   * 全部先脱敏再裁剪；上限 min(OUTPUT_TAIL_MAX / STDERR_TAIL_MAX, maxBytes)。
   */
  const outputTail = () => {
    if (stderrTail !== '') return tailOf(redactText(stderrTail), STDERR_TAIL_MAX)
    return tailOf(redactText(output.tail()), Math.min(STDERR_TAIL_MAX, outputByteLimit))
  }

  /**
   * 本次终止的范围：`'group'` = 杀了整组（含孙进程），`'process'` = 只杀了直接子进程，
   * `null` = 没有发生终止（成功 / 非 0 退出等自然收口）。结果对象里原样透出。
   */
  let killScope = null
  /**
   * 进程组不可用时的降级说明（中文，null 表示本次执行对整组有把握）。
   * Windows / 注入的非真实 ChildProcess / 组信号失败都会记在这里，绝不抛错。
   */
  let orphanWarning = CAN_DETACH
    ? null
    : '当前平台（Windows）不支持 POSIX 进程组：abort / 超时只能终止直接子进程，孙进程可能残留。'

  /**
   * 本次子进程能否按「整组」终止。
   *
   * 三个条件缺一不可：
   *   1. POSIX 且 spawn 时传了 `detached: true`（子进程才是新会话 / 进程组组长）；
   *   2. `pid` 是有效正整数；
   *   3. 是真 `ChildProcess`——注入的测试桩（EventEmitter 形状）没有真实进程组，
   *      贸然 `process.kill(-pid)` 可能误伤同号的无关系进程组。
   */
  const groupKillCapable = () => CAN_DETACH
    && Boolean(child)
    && Number.isInteger(child.pid)
    && child.pid > 0
    && child instanceof ChildProcess

  /** 向子进程所在进程组发信号；只回报结果，绝不抛错。 */
  const signalGroup = (signalName) => {
    try {
      process.kill(-child.pid, signalName)
      return { ok: true, code: null }
    } catch (error) {
      return {
        ok: false,
        code: error && error.code ? String(error.code) : 'UNKNOWN',
        message: error && error.message ? String(error.message) : String(error),
      }
    }
  }

  const killChild = () => {
    if (!child || typeof child.kill !== 'function') return
    // 先按整组杀：custom 是 `sh -c`，孙进程和直接子进程在同一个 pgid 里。
    let groupOk = false
    if (groupKillCapable()) {
      const term = signalGroup('SIGTERM')
      if (term.ok) {
        groupOk = true
        killScope = 'group'
      } else if (term.code !== 'ESRCH') {
        // ESRCH = 组已经不存在（子进程先一步退出），不算降级；其余（EPERM / EINVAL …）
        // 才说明进程组不可用，退回只杀直接子进程并明确记下来。
        orphanWarning = `无法按进程组发送 SIGTERM（${term.code}）：已降级为只终止直接子进程，孙进程可能残留。`
        emit({ kind: 'log', text: orphanWarning, level: 'warn' })
      }
    } else if (!orphanWarning) {
      // 平台能 detach、但拿到的不是真实 ChildProcess（例如注入了自定义 spawn 桩）：
      // 没有可信的进程组可杀，只能退化并留痕。
      orphanWarning = '子进程不是真实的 ChildProcess（注入了自定义 spawn）：无法按进程组终止，只能终止直接子进程，孙进程可能残留。'
      emit({ kind: 'log', text: orphanWarning, level: 'warn' })
    }

    if (!groupOk) {
      killScope = 'process'
      try {
        child.kill('SIGTERM')
      } catch {
        // 已经退出就忽略。
      }
    }
    const killer = setTimeout(() => {
      if (groupOk) {
        const hard = signalGroup('SIGKILL')
        // 组信号失败时仍兜底打直接子进程（尽力而为，不改变已经记下的 killScope）。
        if (!hard.ok) {
          try {
            child.kill('SIGKILL')
          } catch {
            // 已经退出就忽略。
          }
        }
        return
      }
      try {
        child.kill('SIGKILL')
      } catch {
        // 同上。
      }
    }, KILL_GRACE_MS)
    if (killer && typeof killer.unref === 'function') killer.unref()
  }

  /**
   * 收尾时断开子进程的 stdout / stderr 管道。
   *
   * 为什么必须做：管道读端是宿主的 fd。孙进程若还活着（降级路径）或进程组信号尚未落地，
   * 一直开着的读端会让宿主的事件循环无法退出（实测能吊住 60s+）。destroy 之后宿主不再
   * 持有这些 fd，与子进程 / 孙进程是否仍在完全解耦。
   */
  const destroyStdio = () => {
    if (!child) return
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream || typeof stream.destroy !== 'function') continue
      try {
        stream.destroy()
      } catch {
        // 已经关闭的流再 destroy 无害，失败也不影响结果。
      }
    }
  }

  // 先把命令与 argv 算好：配置错误在起进程之前就以 EXECUTOR_INVALID 抛出。
  let command
  let args
  /** custom 专属：prompt 原文只通过临时文件 + env + stdin 传给子进程，不进命令文本。 */
  let customPrompt = null
  /** custom 专属：本次执行的 prompt 临时文件（成功 / 失败 / 超时 / abort 统一在 finish 清理）。 */
  let promptFile = null
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
    customPrompt = typeof prompt === 'string' ? prompt : String(prompt ?? '')
    args = ['-c', buildCustomScript(spec.command, { schemaPath: spec.schemaPath, cwd })]
  }

  const consumeLine = (line) => {
    const parsed = parseCodexLine(line)
    if (parsed.kind === 'ignore') return
    // emit 会做事件对象递归脱敏；事件条数越界时 emit 返回 false 并触发统一收口。
    if (!emit(parsed)) return
    // finalText 是后续 text / structured / message 的来源，进入前先脱敏。
    if (parsed.kind === 'final') finalText = redactText(parsed.text)
    if (parsed.kind === 'usage') usage = parsed.usage
  }

  const flushCompleteLines = () => {
    let index = stdoutBuffer.indexOf('\n')
    while (index >= 0 && !settled && !writeClosed) {
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
      writeClosed = true
      if (timer) clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
      // 所有收口路径都经过这里：成功 / 非 0 退出 / 超时 / abort / spawn 失败 / 输出越界。
      // 先断开 stdout / stderr 管道，再删 prompt 临时文件，最后 resolve：
      // 任何路径都不把子进程的 fd 留给宿主事件循环（见 destroyStdio 注释）。
      destroyStdio()
      removePromptFile(promptFile)
      promptFile = null
      // killScope / orphanWarning 是本次执行的可观测结论：杀的是整组还是只杀了直接
      // 子进程、有没有可能残留孙进程。调用方（及日志）据此判断收尾是否彻底。
      resolve({ ...result, killScope, orphanWarning })
    }

    /** 输出越界的唯一结果形状：reason / code 同值、truncated=true，并自证累计/保留量。 */
    const outputLimitResult = () => ({
      ok: false,
      reason: 'OUTPUT_LIMIT',
      code: 'OUTPUT_LIMIT',
      truncated: true,
      exitCode: null,
      ...snapshot(),
      tail: outputTail(),
      receivedBytes: totalReceivedBytes(),
      retainedBytes: totalRetainedBytes(),
      eventCount: output.eventCount,
    })

    /**
     * 唯一 OUTPUT_LIMIT 收口：先原子固定原因 + 关写闸门，再杀进程组，最后 settle。
     * 顺序不能反——某些桩 spawn 的 kill 会同步 emit close，close 分支只能看到
     * OUTPUT_LIMIT，不能把这次收口改判成 exit / 成功。
     */
    const settleOutputLimit = () => {
      if (settled) return
      interruptReason = 'OUTPUT_LIMIT'
      writeClosed = true
      killChild()
      finish(outputLimitResult())
    }

    // emit 发现事件条数越界时回调到这里（emit 定义在 Promise 外，无法直接读闭包）。
    onOutputLimit = settleOutputLimit

    const failWith = (reason, extra = {}) => {
      if (settled) return
      emitStderr()
      // message / tail 同样可能在错误链里带出凭据（例如命令回显），对外前先脱敏。
      const safeExtra = { ...extra }
      if (typeof safeExtra.message === 'string') safeExtra.message = redactText(safeExtra.message)
      if (typeof safeExtra.tail === 'string') safeExtra.tail = redactText(safeExtra.tail)
      finish({
        ok: false,
        reason,
        exitCode: Object.prototype.hasOwnProperty.call(safeExtra, 'exitCode') ? safeExtra.exitCode : null,
        ...snapshot(),
        ...safeExtra,
      })
    }

    const succeed = (exitCode) => {
      if (settled) return
      emitStderr()
      finish({ ok: true, exitCode, ...snapshot() })
    }

    /**
     * 超时 / abort / spawn 失败 / 输出越界：先记下终止原因再 kill。某些桩 spawn 的 kill
     * 会同步 emit close，若不先记原因，close 会把 timeout/abort 误记成 exit。
     */
    const interrupt = (reason) => {
      if (settled) return
      if (reason === 'OUTPUT_LIMIT') {
        settleOutputLimit()
        return
      }
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

    // custom：先把 prompt 原文落到本次执行专用的临时文件。
    // 它是 `{prompt}` 主通道的数据源，也通过 FLOW_STUDIO_PROMPT_FILE 暴露给命令模板。
    if (spec.kind === 'custom') {
      try {
        promptFile = createPromptFile(customPrompt)
      } catch (error) {
        failWith('spawn', {
          message: `无法写入 prompt 临时文件：${error && error.message ? error.message : String(error)}`,
        })
        return
      }
    }

    try {
      if (spec.kind === 'custom') {
        // 三段式传参：文件（主）+ env 直传（小 prompt 兼容）+ stdin（全文兜底）。
        const env = { ...process.env, [CUSTOM_PROMPT_FILE_ENV]: promptFile.file }
        if (Buffer.byteLength(customPrompt, 'utf8') <= CUSTOM_PROMPT_ENV_MAX_BYTES) {
          env[CUSTOM_PROMPT_ENV] = customPrompt
        } else {
          // 大 prompt 不设 FLOW_STUDIO_PROMPT：Linux 单条 env 字符串约 128KiB 上限，
          // 超了 execve E2BIG。模板应改用 {prompt} 或 "$FLOW_STUDIO_PROMPT_FILE"。
          // 这里显式 delete，防止父进程同名变量泄漏进来。
          delete env[CUSTOM_PROMPT_ENV]
        }
        // detached：POSIX 上把子进程变成新进程组组长，`sh -c` 派生的孙进程共享
        // 这个 pgid，abort / timeout 时才能真正「杀整组」（见模块顶部进程组契约）。
        child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: CAN_DETACH })
      } else {
        // codex 行为保持不变：prompt 走 argv，不写 stdin、不注入 custom 的环境变量；
        // 只额外加 detached（进程组）与统一的管道收尾。
        child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: CAN_DETACH })
      }
    } catch (error) {
      failWith('spawn', { message: error && error.message ? error.message : String(error) })
      return
    }
    if (!child || !child.stdout || !child.stderr || typeof child.on !== 'function') {
      failWith('spawn', { message: '子进程没有可用的 stdout / stderr 通道。' })
      return
    }
    if (spec.kind === 'custom') feedPromptToStdin(child, customPrompt)

    // 不用 stream.setEncoding：解码交给 StringDecoder，这样 data 拿到的是原始 Buffer，
    // 可以在 decode / 复制之前按原始字节计量（跨 chunk 的多字节字符也不会被拆坏）。
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const decodeChunk = (chunk, decoder) => {
      if (typeof chunk === 'string') return chunk
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      return decoder.write(buffer)
    }
    const rawChunkBytes = (chunk) => {
      if (typeof chunk === 'string') return Buffer.byteLength(chunk, 'utf8')
      if (Buffer.isBuffer(chunk)) return chunk.length
      if (ArrayBuffer.isView(chunk)) return chunk.byteLength
      return Buffer.byteLength(String(chunk), 'utf8')
    }

    child.stdout.on('data', (chunk) => {
      if (settled || writeClosed) return
      // 先按原始字节计量并保留前缀；越过 maxBytes 立刻进入唯一 OUTPUT_LIMIT 收口。
      const accepted = output.addRaw(chunk)
      // stdout 占用了共享预算，stderr 的保留上限随之收缩（只影响尾部长度，不影响已收字节）。
      trimStderr()
      if (!accepted || output.limit === 'bytes') {
        interrupt('OUTPUT_LIMIT')
        return
      }
      const text = decodeChunk(chunk, stdoutDecoder)
      if (text === '') return
      stdoutBuffer += text
      flushCompleteLines()
    })
    child.stderr.on('data', (chunk) => {
      if (settled || writeClosed) return
      const text = decodeChunk(chunk, stderrDecoder)
      stderrReceivedBytes += rawChunkBytes(chunk)
      // stderr 是诊断流：先保留有界原文（供整体脱敏），结果里只出尾部 2000 字符。
      appendStderr(text)
      // stdout 与 stderr 共享总接收预算：任一维度越界都进入同一个 OUTPUT_LIMIT 通道。
      if (totalReceivedBytes() > outputByteLimit) interrupt('OUTPUT_LIMIT')
    })
    child.on('error', (error) => {
      if (settled || writeClosed || interruptReason) return
      interruptReason = 'spawn'
      killChild()
      failWith('spawn', { message: error && error.message ? error.message : String(error) })
    })
    child.on('close', (code) => {
      if (settled) return
      if (interruptReason === 'OUTPUT_LIMIT') {
        finish(outputLimitResult())
        return
      }
      if (interruptReason) {
        failWith(interruptReason)
        return
      }
      if (writeClosed) return
      // 冲刷解码器里可能残留的半个多字节序列，再处理 EOF 处没有换行的半行。
      const stdoutRest = stdoutDecoder.end()
      if (stdoutRest !== '') stdoutBuffer += stdoutRest
      const stderrRest = stderrDecoder.end()
      if (stderrRest !== '') appendStderr(stderrRest)
      if (stdoutBuffer.trim() !== '') consumeLine(stdoutBuffer)
      stdoutBuffer = ''
      // 事件条数可能在 EOF 半行这里越界（consumeLine 会触发收口），不能再走成功分支。
      if (settled || writeClosed) return
      const exitCode = Number.isInteger(code) ? code : null
      if (exitCode === 0) {
        succeed(0)
        return
      }
      emitStderr()
      finish({
        ok: false,
        reason: 'exit',
        exitCode,
        ...snapshot(),
        tail: outputTail(),
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
