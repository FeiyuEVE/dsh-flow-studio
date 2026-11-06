/**
 * 进程级 run 注册表 + 内建 supervision 调度（07 §5 / §7 / §8）。
 *
 * 权威规格：`docs/design/07-runtime-0.7.md` §5（并发）/ §7（supervision）/ §8（签名）。
 *
 * 设计要点：
 *   - **按 run 一实例**：`class Engine` 继续持有全部 per-run 字段，但一个实例只服务
 *     一个 run；不同 runId（同工作区 / 跨工作区）各自一个实例并行跑。
 *   - **唯一 409**：同一个 runId 已在跑 → `EngineError(409, '同一 run 已在运行（<runId>）')`。
 *     没有 `MAX_CONCURRENT`、没有 per-workspace 上限、没有排队。
 *   - **收尾摘除**：Engine 在 run 收尾（done/failed/aborted）时回调 `onSettled(runId)`，
 *     runtime 立刻把实例从表里摘掉并释放它的事件订阅；不轮询。run.json 仍然可读。
 *   - **跨 run 共享**：`sessionIndex`（flow_reply / 消息反查）、`startedBy`、logger、now
 *     由 runtime 持有并注入每个实例。
 *   - **Engine 门面**（v0.7）：index.js / tools.js 历史上把 `env.engine` 当「单引擎」用，
 *     runtime 补上同名成员（`engineName` / `resolveSessionOwner` / `runForSession` /
 *     `sweepStaleRuns` / `get` / `sessionIdForNode`），这样 `env.engine = runtime` 后
 *     这些调用照跑，Host 侧改动量最小。**`active` 不再提供**（并发不设上限）。
 *   - **内建 supervision**：runtime 起**唯一一个** `SupervisionScheduler`（`setInterval`
 *     用 `.unref()` 包一层，不吊住事件循环），`evaluate / wake / load / save` 全部在这里注入。
 *   - **额外键直读直写**：`workspace` / `worktree` / `supervision` / `startOptions` 是 v0.7
 *     写进 `run.json` 的字段，但 `runstore.normalizeMeta()` 只保留白名单键（会丢掉它们）。
 *     本模块因此提供 `readRunExtras()` / `patchRunJson()` / `saveSupervision()`：**只**读、
 *     只合并这几个键，绝不整份覆盖 run.json。
 *   - **向后兼容**：`createEngine({...})` / `new Engine({...})` 的既有用法不受影响；
 *     runtime 只是多包了一层注册表。
 *
 * @module @feiyueve/dsh-flow-studio/runtime
 */

import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { auditWorkflow as defaultAuditWorkflow } from './audit.js'
import { Engine, EngineError, createEngine } from './engine.js'
import { buildFollowupPayload } from './inbox.js'
import { checkRunId } from './runlog.js'
import {
  listRuns, readAllEvents, readRunMeta, runsDir, writeRunMeta,
} from './runstore.js'
import { flowsDir, readFlow } from './store.js'
import { SupervisionScheduler } from './supervise.js'

/** run.json 的权限口径与 runstore 一致（0600）。 */
const FILE_MODE = 0o600

/** runtime 自己消费、不往 Engine 透传的选项。 */
const RUNTIME_ONLY_KEYS = new Set([
  'createEngine', 'logger', 'onSettled', 'sessionIndex', 'startedBy',
  'auditWorkflow', 'intervalMs', 'supervisionIntervalMs', 'setInterval', 'clearInterval',
])

/**
 * v0.7 写进 run.json 的运行绑定键（engine 写 workspace/worktree/sessionMode，runtime 写 supervision）。
 *
 * **单一读写路径**：`runstore.normalizeMeta()` 已经把 `workspace` / `worktree` /
 * `sessionMode` / `supervision` 纳入白名单（形状收敛、超长截断），所以这四个键一律
 * 走 `readRunMeta` / `writeRunMeta`，不再自己「读原文 → 合并 → 改写」。
 *
 * 唯一的例外是 `startOptions`：它是建 run 时记下的「发起参数」（workspace / worktree），
 * runstore 不认识这个键，只能直读写原文；它的生命周期只到 `POST /runs/<id>/start`
 * 把参数交给 engine.start 为止（之后 engine 写权威 workspace / worktree）。留在这里是
 * 为了「创建时保存发起参数」这条契约，不是第二条 supervision 写路径。
 *
 * 字段契约（与 engine 对齐）：
 *   - `workspace`   `{ id, path, realpath, isGit, gitRoot }`（id = sha256(realpath) 前 12 hex）
 *   - `worktree`    `{ enabled, reason, decidedBy:'initiator', path, branch, baseCommit, createdAt }`
 *   - `sessionMode` `'top-level' | 'legacy-subagent' | 'injected' | 'stub' | 'unavailable'`
 *   - `supervision` `{ enabled, wakerSessionId, lastWokeAt, nextDueAt, wakes, failures, reason }`
 */
export const RUN_EXTRA_KEYS = Object.freeze([
  'workspace', 'worktree', 'sessionMode', 'supervision', 'startOptions',
])

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function runJsonPath(runsRoot, runId) {
  return join(runsRoot, runId, 'run.json')
}

// 同一进程内对同一份 run.json 的「读-改-写」串行化（只服务 startOptions 这一条 raw 路径）。
const runJsonLocks = new Map()

async function withRunJsonLock(runId, task) {
  const previous = runJsonLocks.get(runId) || Promise.resolve()
  let release
  const gate = new Promise(resolve => { release = resolve })
  runJsonLocks.set(runId, gate)
  await previous.catch(() => {})
  try {
    return await task()
  } finally {
    release()
    if (runJsonLocks.get(runId) === gate) runJsonLocks.delete(runId)
  }
}

/**
 * 读建 run 时记下的发起参数（`run.json.startOptions`，runstore 白名单之外，只能读原文）。
 * 坏文件 / 缺字段一律 null，绝不抛错。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @returns {Promise<{ workspace?: string, worktree?: string } | null>}
 */
export async function readStartOptions(runsRoot, runId) {
  if (!checkRunId(runId)) return null
  try {
    const raw = JSON.parse(await readFile(runJsonPath(runsRoot, runId), 'utf8'))
    return isPlainObject(raw) && isPlainObject(raw.startOptions) ? raw.startOptions : null
  } catch {
    return null
  }
}

let tmpCounter = 0

/**
 * **只合并** `startOptions` 这一条 raw 键到 run.json（白名单之外的兜底路径）。
 *
 * 注意用途边界：`workspace` / `worktree` / `sessionMode` / `supervision` 一律走
 * `runstore.writeRunMeta()`（已进白名单），**不要**用本函数写它们，避免两条写路径。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {Record<string, any>} patch 值为 `undefined` 表示删除该键
 * @returns {Promise<object|null>} 写入后的完整原始对象；run 不存在返回 null
 */
export async function patchRunJson(runsRoot, runId, patch = {}) {
  if (!checkRunId(runId)) return null
  return withRunJsonLock(runId, async () => {
    let raw
    try {
      raw = JSON.parse(await readFile(runJsonPath(runsRoot, runId), 'utf8'))
    } catch {
      return null
    }
    if (!isPlainObject(raw)) return null
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete raw[key]
      else raw[key] = value
    }
    const path = runJsonPath(runsRoot, runId)
    const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
    await writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE })
    try {
      await rename(tmp, path)
    } catch (error) {
      await unlink(tmp).catch(() => {})
      throw error
    }
    await chmod(path, FILE_MODE).catch(() => {})
    return raw
  })
}

/**
 * 读 run 的 v0.7 绑定字段（**统一走 runstore 白名单**）。
 * 缺字段一律 null，run 不存在整体返回 null。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @returns {Promise<{ workspace: object|null, worktree: object|null,
 *   sessionMode: string|null, supervision: object|null,
 *   startOptions: object|null } | null>}
 */
export async function readRunExtras(runsRoot, runId) {
  const meta = await readRunMeta(runsRoot, runId)
  if (!meta) return null
  return {
    workspace: isPlainObject(meta.workspace) ? meta.workspace : null,
    worktree: isPlainObject(meta.worktree) ? meta.worktree : null,
    sessionMode: typeof meta.sessionMode === 'string' && meta.sessionMode !== '' ? meta.sessionMode : null,
    supervision: isPlainObject(meta.supervision) ? meta.supervision : null,
    startOptions: await readStartOptions(runsRoot, runId),
  }
}

/**
 * 合并写入 `run.json.supervision`（07 §7）：先读现有对象，再只覆盖给定字段。
 *
 * 走 `runstore.writeRunMeta()`（supervision 已进白名单，局部合并不互相覆盖
 * workspace / worktree / sessionMode）——不自己改写原文，避免两条写路径打架。
 *
 * @param {string} runsRoot
 * @param {string} runId
 * @param {object} patch
 * @returns {Promise<object|null>} 写入后的 supervision 对象；run 不存在返回 null
 */
export async function saveSupervision(runsRoot, runId, patch = {}) {
  const meta = await readRunMeta(runsRoot, runId)
  if (!meta) return null
  const previous = isPlainObject(meta.supervision) ? meta.supervision : {}
  const next = { ...previous, ...(isPlainObject(patch) ? patch : {}) }
  await writeRunMeta(runsRoot, runId, { supervision: next })
  return next
}

// ---------------------------------------------------------------------------
// supervision 的唤醒提示词（原文见交付说明；只写 runId，不写环境事实）
// ---------------------------------------------------------------------------

/**
 * 内建 supervision 到点唤醒发起会话时的提示词。
 * 必须包含三要素：runId、`flow_watch`、以及「不要重复挂手动闹钟」。
 */
export function supervisionWakePrompt(runId) {
  return [
    `【工作流自动复查】runId=${runId} 到了定时审查点（这是内置 supervision 调度发起的唤醒，`,
    '不需要你再手动挂 proactive_set 闹钟）。请调用 flow_watch（runId="' + runId + '"）审查这个 run 是否在正常运转：',
    '① 若 verdict 表示运行正常且没有停滞，直接结束本轮，不要打扰主人；',
    '② 只有出现异常（节点停滞、打回过多、节点失败）或整个流程已经跑完（done/failed/aborted），'
      + '才把结论、异常点和需要主人决策的地方通知主人；',
    '③ 之后仍由内置调度按 60 / 180 秒的间隔继续唤醒你，直到这个 run 收尾为止。',
  ].join('')
}

// ---------------------------------------------------------------------------
// createRuntime
// ---------------------------------------------------------------------------

/**
 * 创建进程级运行时。
 *
 * @param {{
 *   ctx?: any, runsRoot?: string, flowsRoot?: string,
 *   logger?: (level: string, message: string) => void,
 *   log?: (level: string, message: string) => void,
 *   now?: () => Date,
 *   stub?: boolean,
 *   createEngine?: (options: object) => object,
 *   onSettled?: (runId: string) => void,
 *   auditWorkflow?: Function,
 *   intervalMs?: number,
 *   setInterval?: Function, clearInterval?: Function,
 *   [key: string]: any,
 * }} [options] 其余字段原样透传给 Engine（activate / nodeTimeoutMs / staleMs / ...）
 */
export function createRuntime(options = {}) {
  const runs = new Map()
  const sessionIndex = new Map()
  const startedBy = new Map()
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const logger = typeof options.logger === 'function'
    ? options.logger
    : (typeof options.log === 'function' ? options.log : null)
  const runsRoot = typeof options.runsRoot === 'string' && options.runsRoot !== ''
    ? options.runsRoot
    : runsDir()
  const flowsRoot = typeof options.flowsRoot === 'string' && options.flowsRoot !== ''
    ? options.flowsRoot
    : flowsDir()
  const settledHook = typeof options.onSettled === 'function' ? options.onSettled : null
  const makeEngine = typeof options.createEngine === 'function'
    ? options.createEngine
    : engineOptions => createEngine(engineOptions)
  const auditFn = typeof options.auditWorkflow === 'function' ? options.auditWorkflow : defaultAuditWorkflow
  // 与 Engine 同一口径：显式 stub 优先，否则只看 env（index.js 会显式传判定结果）。
  const stub = options.stub === undefined
    ? process.env.FLOW_STUDIO_STUB_ENGINE === '1'
    : options.stub === true
  const engineName = stub ? 'stub' : 'real'

  const log = (level, message) => {
    if (!logger) return
    try {
      logger(level, message)
    } catch {
      // 日志实现抛错不该影响调度。
    }
  }

  // engineDeps：除 runtime 自己消费的键之外，全部透传（activate / stub / 超时 / ...）。
  const engineDeps = {}
  for (const [key, value] of Object.entries(options)) {
    if (RUNTIME_ONLY_KEYS.has(key)) continue
    engineDeps[key] = value
  }
  engineDeps.runsRoot = runsRoot
  engineDeps.flowsRoot = flowsRoot
  if (logger) engineDeps.log = logger

  // ── supervision：唯一一个调度器（07 §7） ────────────────────────────────

  /**
   * 到点唤醒发起会话：`agents.get` 优先，冷会话 `agents.resume`，再 `followup`。
   * 失败一律抛错 / 返回 false——连续 3 次由 scheduler 降级并停止调度。
   */
  async function wakeRun(runId, { wakerSessionId } = {}) {
    const ctx = options.ctx
    let agents = null
    try {
      agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : (ctx && ctx.agents)
    } catch {
      agents = null
    }
    if (!agents || (typeof agents.get !== 'function' && typeof agents.resume !== 'function')) {
      throw new Error('agents 服务不可用，无法唤醒发起会话')
    }
    if (typeof wakerSessionId !== 'string' || wakerSessionId === '') {
      throw new Error('run.json 里没有 wakerSessionId，无法唤醒发起会话')
    }
    let agent = null
    try {
      if (typeof agents.get === 'function') agent = agents.get(wakerSessionId) || null
    } catch {
      agent = null
    }
    if (!agent) {
      if (typeof agents.resume !== 'function') {
        throw new Error(`发起会话 ${wakerSessionId} 不在线，且 agents.resume 不可用`)
      }
      const resumed = await agents.resume({ resumeSessionId: wakerSessionId })
      agent = resumed && resumed.agent ? resumed.agent : null
    }
    if (!agent || typeof agent.followup !== 'function') {
      throw new Error(`发起会话 ${wakerSessionId} 无法接收消息（没有 followup）`)
    }
    agent.followup(buildFollowupPayload({
      text: supervisionWakePrompt(runId),
      runId,
      nodeId: null,
      from: 'flow-studio',
    }))
    return true
  }

  /** 审计一个 run：readRunMeta + 全量事件 + 流程模板 → { verdict, run }。 */
  async function evaluateRun(runId) {
    const meta = await readRunMeta(runsRoot, runId)
    if (!meta) return { verdict: null, run: null }
    let events = []
    try {
      const all = await readAllEvents(runsRoot, runId)
      if (all && Array.isArray(all.events)) events = all.events
    } catch {
      events = []
    }
    let flow = null
    if (typeof meta.flowId === 'string' && meta.flowId !== '') {
      try {
        flow = await readFlow(flowsRoot, meta.flowId)
      } catch {
        flow = null
      }
    }
    let audited = null
    try {
      audited = auditFn({ flow, events, run: meta, now: now() })
    } catch (error) {
      log('warn', `supervision: 审计 run ${runId} 失败：${error && error.message ? error.message : String(error)}`)
      audited = null
    }
    return {
      verdict: audited && typeof audited.verdict === 'string' ? audited.verdict : null,
      run: { status: meta.status, startedAt: meta.startedAt },
    }
  }

  const defaultSetInterval = (fn, ms) => {
    const timer = setInterval(fn, ms)
    // 07 §7：别吊住事件循环（测试台 / dsh 退出时不因为 supervision 定时器卡住）。
    if (timer && typeof timer.unref === 'function') timer.unref()
    return timer
  }
  const intervalMs = Number.isFinite(options.supervisionIntervalMs) && options.supervisionIntervalMs > 0
    ? options.supervisionIntervalMs
    : (Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : undefined)

  const supervision = new SupervisionScheduler({
    now,
    intervalMs,
    setInterval: typeof options.setInterval === 'function' ? options.setInterval : defaultSetInterval,
    clearInterval: typeof options.clearInterval === 'function' ? options.clearInterval : undefined,
    log,
    evaluate: evaluateRun,
    wake: wakeRun,
    load: async runId => {
      const meta = await readRunMeta(runsRoot, runId)
      return meta && isPlainObject(meta.supervision) ? meta.supervision : null
    },
    save: async (runId, next) => {
      await saveSupervision(runsRoot, runId, next)
    },
  })

  // 07 §7：runtime 起来就把调度器挂上（唯一一个 interval，幂等）。
  supervision.start()

  /** 摘掉已收尾的实例（只摘自己那一份，避免误删后来者）。 */
  function settleInstance(runId, engine) {
    if (runId !== null && runs.get(runId) !== engine) return
    if (runId !== null) runs.delete(runId)
    // 收尾后不再需要 session/event 订阅；不释放会让每个结束的 run 继续缓冲全局会话事件。
    try {
      engine.dispose()
    } catch {
      // 释放失败不该影响收尾。
    }
    if (runId !== null) {
      // 07 §7：终态立刻停调度并落盘 enabled=false（重启后也不会再唤醒已结束的 run）。
      try {
        supervision.unregister(runId)
      } catch {
        // 调度器状态清理失败不该影响收尾。
      }
      saveSupervision(runsRoot, runId, { enabled: false, reason: 'terminal' }).catch(error => {
        log('warn', `flow-studio: runtime 收尾写 supervision 失败（${runId}）：${error.message}`)
      })
    }
    if (runId !== null && settledHook) {
      try {
        settledHook(runId)
      } catch (error) {
        if (logger) logger('warn', `flow-studio: runtime onSettled 失败（${runId}）：${error.message}`)
      }
    }
  }

  /** 为一次 run 创建 Engine 实例；onSettled 捕获实例引用，便于精确摘除。 */
  function newEngine(runId) {
    let engine = null
    engine = makeEngine({
      ...engineDeps,
      sessionIndex,
      startedBy,
      now,
      onSettled: settledRunId => settleInstance(settledRunId, engine),
    })
    return engine
  }

  async function start(runId, startOptions = {}) {
    if (!checkRunId(runId)) throw new EngineError(400, 'runId 不合法')
    // 07 §5：唯一 409 就是「同一个 runId 已在跑」。
    if (runs.has(runId)) throw new EngineError(409, `同一 run 已在运行（${runId}）`)
    const engine = newEngine(runId)
    runs.set(runId, engine)
    try {
      return await engine.start(runId, startOptions)
    } catch (error) {
      // 启动失败：把实例从表里摘掉（调用方拿到的错误照原样抛）。
      if (runs.get(runId) === engine) runs.delete(runId)
      try {
        engine.dispose()
      } catch {
        // 忽略释放失败。
      }
      throw error
    }
  }

  function requireRunning(runId) {
    if (!checkRunId(runId)) throw new EngineError(400, 'runId 不合法')
    const engine = runs.get(runId)
    if (!engine) throw new EngineError(409, '该 run 不在运行中')
    return engine
  }

  async function stop(runId) {
    const engine = requireRunning(runId)
    return engine.stop(runId)
  }

  /** 等指定 run 收尾：在跑就等它，已收尾（或没在本进程跑过）就读 run.json 终态。 */
  async function wait(runId) {
    if (!checkRunId(runId)) throw new EngineError(400, 'runId 不合法')
    const engine = runs.get(runId)
    if (engine) return engine.wait(runId)
    return readRunMeta(runsRoot, runId)
  }

  /**
   * 对所有实例跑崩溃残留清理。顺序执行：前一个实例把残留 run 标成 failed 后，
   * 后一个实例重读 run.json 会跳过它，不会重复写 run/end。
   */
  async function sweep() {
    const live = [...runs.values()]
    if (live.length === 0) {
      const temp = newEngine(null)
      try {
        return await temp.sweepStaleRuns()
      } finally {
        temp.dispose()
      }
    }
    const recovered = new Set()
    for (const engine of live) {
      try {
        const swept = await engine.sweepStaleRuns()
        for (const id of swept) recovered.add(id)
      } catch (error) {
        if (logger) logger('warn', `flow-studio: sweep 失败：${error.message}`)
      }
    }
    return [...recovered]
  }

  function get(runId) {
    return runs.get(runId) || null
  }

  /** 当前在跑的 runId 列表。 */
  function list() {
    return [...runs.keys()]
  }

  /** 当前活的 Engine 实例（与 list() 同序）。 */
  function engines() {
    return [...runs.values()]
  }

  // ── Engine 门面（让 index.js / tools.js 把 runtime 当单引擎用） ───────────

  /** 06 §16：sessionId → { runId, nodeId, firstAttempt, lastAttempt }；读共享 sessionIndex。 */
  function resolveSessionOwner(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const owner = sessionIndex.get(sessionId)
    return owner ? { ...owner } : null
  }

  /** flow_send_message：省略 runId 时取「当前会话启动的最新 run」。 */
  function runForSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const started = startedBy.get(sessionId)
    if (typeof started === 'string' && started !== '') return started
    const owner = sessionIndex.get(sessionId)
    return owner && typeof owner.runId === 'string' && owner.runId !== '' ? owner.runId : null
  }

  /** 节点会话查找：在跑就路由到对应实例，否则返回 null（inbox 会回落到 sessions.json）。 */
  function sessionIdForNode(runId, nodeId) {
    const engine = runs.get(runId)
    if (!engine || typeof engine.sessionIdForNode !== 'function') return null
    try {
      return engine.sessionIdForNode(runId, nodeId) || null
    } catch {
      return null
    }
  }

  /** 终态 run 再开调度没有意义（scheduler 的 planWake 也直接停）。 */
  const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'aborted'])

  /**
   * 07 §7 的**唯一开关实现**：HTTP `POST /runs/<id>/supervision` 与模型工具（flow_start
   * 自动开启、flow_supervise 手动开关）都走它，避免登记 / 落盘两条逻辑漂移。
   *
   * @param {string} runId
   * @param {{ enabled?: boolean, wakerSessionId?: string }} [options]
   * @returns {Promise<{ runId: string, enabled: boolean, supervision: object|null,
   *   scheduler: object }>}
   * @throws {EngineError} 400（runId 非法 / run 已收尾却要开启）或 404（run 不存在）
   */
  async function enableSupervision(runId, options = {}) {
    if (!checkRunId(runId)) throw new EngineError(400, 'runId 不合法')
    const enabled = options.enabled !== false
    const wakerSessionId = typeof options.wakerSessionId === 'string' && options.wakerSessionId.trim() !== ''
      ? options.wakerSessionId.trim()
      : null
    const meta = await readRunMeta(runsRoot, runId)
    if (!meta) throw new EngineError(404, `run 不存在（${runId}）`)
    if (enabled && TERMINAL_RUN_STATUSES.has(meta.status)) {
      throw new EngineError(400, `run 已结束（${meta.status}），不能开启 supervision；要定时自审请对运行中的 run 开启`)
    }
    if (enabled) {
      supervision.register(runId, wakerSessionId === null ? {} : { wakerSessionId })
      const saved = await saveSupervision(runsRoot, runId, {
        enabled: true,
        ...(wakerSessionId === null ? {} : { wakerSessionId }),
        reason: null,
        failures: 0,
      })
      return { runId, enabled: true, supervision: saved, scheduler: supervision.status(runId) }
    }
    supervision.unregister(runId)
    const saved = await saveSupervision(runsRoot, runId, { enabled: false, reason: 'disabled-by-caller' })
    return { runId, enabled: false, supervision: saved, scheduler: supervision.status(runId) }
  }

  /** 07 §7：停止调度并释放所有实例（插件卸载 / 测试收尾）。 */
  function dispose() {
    try {
      supervision.stop()
    } catch {
      // 停止定时器失败不该影响卸载。
    }
    for (const engine of [...runs.values()]) {
      try {
        engine.dispose()
      } catch {
        // 忽略释放失败。
      }
    }
    runs.clear()
  }

  /**
   * 07 §7：重启恢复——对 `status ∈ {pending, running}` 且
   * `supervision.enabled !== false` 的 run 自动 register（wakerSessionId 从 run.json 取）。
   * 只登记，不立刻唤醒（第一次唤醒由调度器的 nextDueAt 决定）。
   */
  const supervisionReady = (async () => {
    let listed
    try {
      listed = await listRuns(runsRoot, { limit: 100 })
    } catch (error) {
      log('warn', `supervision: 恢复扫描失败：${error && error.message ? error.message : String(error)}`)
      return []
    }
    const registered = []
    const skipped = []
    for (const run of listed.runs || []) {
      if (run.status !== 'pending' && run.status !== 'running') continue
      const meta = await readRunMeta(runsRoot, run.id).catch(() => null)
      const state = meta && isPlainObject(meta.supervision) ? meta.supervision : null
      // 只有「显式开启过 + 知道唤醒谁」才恢复；没 waker 的 run 登记进去只会连续 3 次唤醒失败
      // 被写成 wake-failed（纯噪音），而用户之后仍可用 flow_supervise 手动开启。
      const wakerSessionId = state && typeof state.wakerSessionId === 'string'
        ? state.wakerSessionId.trim()
        : ''
      if (!state || state.enabled !== true || wakerSessionId === '') {
        skipped.push(run.id)
        continue
      }
      try {
        supervision.register(run.id, { wakerSessionId })
        registered.push(run.id)
      } catch (error) {
        log('warn', `supervision: 恢复登记 ${run.id} 失败：${error && error.message ? error.message : String(error)}`)
      }
    }
    if (skipped.length > 0) {
      log('info', `supervision: 跳过 ${skipped.length} 个没有开启记录 / 缺 wakerSessionId 的 run（可之后用 flow_supervise 手动开启）：${skipped.join(', ')}`)
    }
    if (registered.length > 0) {
      log('info', `supervision: 已恢复 ${registered.length} 个 run 的定时自审：${registered.join(', ')}`)
    }
    return registered
  })()

  return {
    runs,
    start,
    stop,
    wait,
    sweep,
    get,
    list,
    engines,
    sessionIndex,
    startedBy,
    supervision,
    supervisionReady,
    enableSupervision,
    dispose,
    // ── Engine 门面：`env.engine = runtime` 后旧调用照跑 ──────────────────
    /** 供 /health 使用：'stub' / 'real'（与 Engine 同一口径）。 */
    get engineName() {
      return engineName
    },
    /** 供 inbox.js 的 `deps.engine.ctx` 回落使用。 */
    get ctx() {
      return options.ctx ?? null
    },
    resolveSessionOwner,
    runForSession,
    sessionIdForNode,
    /** 旧名字：index.js 启动清理调 `engine.sweepStaleRuns()`。 */
    sweepStaleRuns: sweep,
  }
}

export { Engine }
