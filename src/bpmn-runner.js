/**
 * BPMN 执行器：把 `bpmn-engine` 包成我们能直接用的「单实例执行器」（0.13.0 · 只做引擎适配）。
 *
 * 边界（**只做**引擎适配）：
 *   - 不接 HTTP、不接 Web UI、不读写 `runstore` / `instance-store` / `definitions/`；
 *   - 不解析 BPMN XML（`definition` 由解析器给，形状见下）；只在「只有 definition」时
 *     **反向生成**一份最小 BPMN XML 喂给引擎（这是序列化，不是解析）；
 *   - 快照只回给调用方（`getState()` 的返回值），落不落盘、落哪、去抖策略由上层决定。
 *
 * 入参 `definition`（跨模块契约，本模块只消费、不生产）：
 * ```js
 * { id, name, startId, endIds,
 *   elements: [{ id, type, name, kind,   // kind: start|end|agent|human|http|gateway|unknown
 *                node: null | { kind, provider, adapter, skills, hooks, prompt, roleCard, team, http } }],
 *   flows: [{ id, from, to, condition: null | { expression, language: 'feel' }, isDefault }] }
 * ```
 * 也接受 `xml`（原始 BPMN 2.0 XML）：有则**优先**用 XML 执行，`definition` 仍然负责
 * 「活动 id → 节点语义 → 调哪个 handler」的派发，并在启动前核对两边一致。
 *
 * 交付 API（名字固定）：
 *   `createBpmnRunner(options)` → `{ start, recover, getState, signalTask, stop, pendingTasks, status }`
 *
 * ---------------------------------------------------------------------------
 * 九条已知坑 → 本文件的落点（改这块前先对照 `docs/plan/0.13-研究-bpmn-engine.md`）
 * ---------------------------------------------------------------------------
 * 1. 活动事件只从 listener 出来：`_attachListener()` 把 `EventEmitter` 交给
 *    `engine.execute({listener})` / `engine.resume({listener})`，**唯一**事件入口。
 * 2. `engine.on('activity.*')` 收不到：全文件没有任何 `engine.on('activity.…')`；
 *    `Engine` 只在 `end/stop/error` 上 emit，这里只用 `execute(cb)` 的 callback 兜底
 *    （`_onEngineCallback`）。
 * 3. 快照 7–18KB 不可裁剪 → 只在 `activity/wait` 与 `activity/end` 之后快照
 *    （`SNAPSHOT_TRIGGERS` + `_maybeAutoSnapshot`），且 `shouldSnapshot(evt)` 钩子可
 *    完全去抖（`_autoSnapshot`）。**不**在别的事件上 `getState()`。
 * 4. `recover()` 只能给非运行中的 engine：`recover()` 每次**新建 Engine**，运行中调用
 *    抛结构化错误 `BPMN_RECOVER_RUNNING`（`recover` 方法头部；`engine.execution.isRunning`
 *    与自身状态机双检）。另加一条实测护栏：只有 `engine.state` 为 `running` / `stopped`
 *    的 state 可恢复，`done` / `error` / `idle` 一律 `BPMN_STATE_NOT_RESUMABLE`
 *    （恢复这些 state 时 `resume()` 不产生任何事件，等静默的循环会白转到上限）。
 * 5. 变量在 definition 环境的克隆里：读变量**从不**读 `engine.environment.variables`
 *    （那里只有初始值 + 引擎塞进去的 message 垃圾），本实例维护自己的 `_variables` 账本
 *    （`_conditionVariables` / `_mergeOutput` / `_syncEngineVariables`）。
 * 6. serviceTask handler 未注册 → 引擎 fatal：构造期自检 `definition` 里每个
 *    agent/http 节点都有 handler（`_assertHandlers`），缺就抛 `BPMN_HANDLER_MISSING`。
 * 7. LRU 管活跃实例（默认 max=100，`maxActiveInstances` 覆盖）：见 `ACTIVE` / `registerActive`
 *    / `trimActive`；被淘汰的实例**必须已落过 state**，否则抛
 *    `BPMN_LRU_EVICT_UNSNAPSHOTTED`（不静默丢）。
 * 8. 超时：`limits.activityWaitMs` 对单个活动（含 handler）计时（`_armActivityTimer`），
 *    `limits.runTimeoutMs` 对整轮计时（`_armRunTimer`）；两者都发 `error` 事件，实例层
 *    只写 `lastError`（status 保持 `ACTIVE`），runner 内部转 `blocked`。
 *    handler 超时会通过 `ctx.signal`（AbortSignal）+ 回调双保险打断。
 * 9. 取消：`stop()` abort 在飞 handler（`_abortAll`）并 `engine.stop()` 停止推进
 *    （`withTimeout` 兜底，避免引擎不响应时把调用方挂死）。
 *
 * ---------------------------------------------------------------------------
 * 其它实测得出的「坑外之坑」（本模块的实现理由，别当装饰）
 * ---------------------------------------------------------------------------
 * a. `await engine.execute()` **不会**等到跑完：`Execution._execute` 返回的是 execution
 *    本身，Promise 立刻 resolve。所以「跑到第一个等待点」必须自己判：`_checkQuiescent`
 *    用 `engine.activityStatus`（`executing` / `wait` / `timer` / `idle`）+ `_sawRun` 判定
 *    静默，只有 `wait` 才认「停在等待点」。
 * b. 引擎默认把 `sequenceFlow.conditionExpression` 当字符串/路径解析：`language="feel"`
 *    的 `= false` 会被当**恒真**（研究 §5）。见下方「条件求值归属」：条件一律由本模块
 *    求值，结果必须是布尔（`_assertConditionBoolean`）。
 * c. `feelin.evaluate()` 返回的是 `{ value, warnings }`，不是布尔值：直接当条件用会
 *    **恒真**（实测 `flow.take.result = {value:false}` 仍被走）。`bpmn-expr.evaluateFeel`
 *    已经把这层收成 `{ ok, value }`，本模块只认 `value`。
 * d. `ProcessExecution.execute()` 会把整条 broker message `assignVariables()` 进
 *    process 环境，于是 `environment.variables` 里混进 `content` / `fields` /
 *    `properties`。所以条件求值**不能**直接用引擎环境变量（会脏），用本实例账本。
 * e. 我们的 `extensions` 只要给某个活动返回非空对象，引擎就不会给它挂内置
 *    `OutputExtension`（`Context.loadExtensions`），`environment.output[id]` 会空。
 *    因此 serviceTask 的输出由本模块自己写回（`_syncEngineOutput`）。
 * f. `recover()` 走的是 `deserialize(state.definitions[].source)`，**不走** `extendFn`：
 *    任何靠 `extendFn` 注入的 `behaviour.Service` 在恢复后就没了 → 必须用运行期
 *    `extensions`（本模块的做法），`Service` 会在新 Engine 加载定义时重新挂上。
 * g. `resume()` 会把停在 `activity.wait` 的活动**重新发一次** `activity.wait`（同一
 *    executionId）：待办要去重（`_onActivityWait`），上层也不能靠「收到 wait 就自动完成」
 *    做幂等——恢复出来的实例本来就没有内存里的待办表。
 * h. `engine.on('error')` 在正常失败路径上**不会**触发（`_complete` 只在 end/stop 上
 *    `engine.emit`），可靠通道是 `execute(cb)` 的 callback + listener 的
 *    `activity.error` / `process.error`。
 * i. `api.fail(err)` 把错误塞进 `inner`，`ActivityError.message` 是空的；条件求值的错误
 *    也会被引擎包成 `ActivityError`（code 丢掉）。所以 handler / 条件 / 超时三条路都各自
 *    先记一份自己的结构化错误（`_pendingHandlerErrors` / `_pendingConditionErrors` /
 *    timeout 对象），`error` 事件里报的是自己那份。
 *
 * ---------------------------------------------------------------------------
 * 条件求值归属（**不可妥协**：FEEL 绝不交给 bpmn-engine 的表达式引擎）
 * ---------------------------------------------------------------------------
 * 研究 §5 实测：引擎内置 ExpressionCondition 只会解 `${a.b.c}` 路径，不认运算，于是
 * `language="feel"` / Camunda 8 的 `= x > 1` 会被当字符串 → 恒真且不报错；而
 * `language="javascript"` 走 `node:vm`，能逃逸到 `process`。两条都不可接受。
 *
 * 本模块的做法（`_scriptsAdapter` → `_evaluateFlowCondition` → `_evaluateCondition`）：
 *   - 用自定义 `scripts.getScript(language, activity)` 接管**每一条**带
 *     `conditionExpression` 的 sequenceFlow：引擎走的是 `ScriptCondition` 分支
 *     （`SequenceFlow.getCondition` 先问 scripts，再退回内置表达式引擎），
 *     返回值**由我们给**，内置表达式引擎一次都不会被调用；
 *   - 求值统一走 `bpmn-expr.evaluateFeel(expression, variables)`（组件优先，本模块
 *     不自己实现 FEEL）：`ok:true` 取 `value`；`ok:false` → 抛
 *     `BPMN_CONDITION_INVALID` → `error` 事件 + 实例 `lastError`（**不**把非法表达式
 *     静默当 false 走去默认流）；
 *   - 结果必须是布尔：`_assertConditionBoolean` 只在 boolean（或 feelin 的
 *     `{value:boolean}` 信封）时放行，其余一律失败；这样 `= false` / `= 1 > 2`
 *     必然不通行，`= 1 + 1 = 2` 必然通行（测试里有回归锚）；
 *   - `${...}` 是引擎内置表达式语法，**一律拒绝**（`BPMN_CONDITION_LANGUAGE_UNSUPPORTED`）：
 *     只要条件表达式还交给引擎，就等于把「恒真」风险放回来；
 *   - 条件求值**不可注入**：`options.evaluateCondition` 已移除，传了直接
 *     `BPMN_OPTIONS_INVALID`（0.13 红线：条件唯一入口是本模块内的 evaluateFeel）。
 *
 * 为什么不照「把条件改写成 `${environment.services.__cond_<flowId>}`」的路线：
 * 那条路线要在**用户给的 XML** 上做字符串改写（或引入 moddle 内存模型），而 XML 模式
 * 的正本必须逐字节可信；`scripts.getScript` 是 `Environment` 的公开扩展点
 * （引擎自带 `JavaScripts` 就是它的实现），按 flow 生效、不碰 XML、XML 模式与
 * definition-only 模式同一条路径。代价是依赖 `Scripts` 接口稳定（26.0.6 实测，
 * 测试里 XML / definition-only 两种模式都覆盖）。
 *
 * ---------------------------------------------------------------------------
 * 连线通过次数上限与循环护栏（0.13 迁移必须补齐，否则带环流程会无限重跑）
 * ---------------------------------------------------------------------------
 * 新引擎只认 BPMN 通用语义：活动 / 条件连线 / 事件 / 变量。这里的两条约束都是
 * **通用**的——不假设任何业务角色或判定结果（没有专属的事件/状态/错误码）：
 *
 * 1. **单条连线通过次数上限**：`fs:maxRounds` 是模板上的属性名（历史模板沿用它，
 *    解析器/转换器不需要改），含义是「这条 sequence flow 最多被走 N 次」。
 *    `normalizeDefinition` 把它从 flow 的 `extensions` 里读出来，派生只读字段
 *    `maxTakes`（只认 ≥1 的显式整数；**不补默认值**——「未设上限」与「上限 N」不同，
 *    转换器已把历史模板的值显式写进 XML）。
 *    判定在「条件成立、即将沿这条边回去」之前：`takes >= maxTakes`（`takes` 是这条边
 *    已经走过的次数）→ `BPMN_FLOW_TAKE_LIMIT`，错误体
 *    `{ flowId, maxTakes, takes, attemptedTake }`，文案
 *    `连线 <flowId> 已被走过 <takes> 次，第 <takes+1> 次超过 fs:maxRounds=<maxTakes> 的连线次数上限`。
 *    实例 status 保持 `ACTIVE` 并写 `lastError`（实例没有 failed 状态），runner 内部转 `blocked`。
 *    → 判定在 `_takeSequenceFlow`（`SequenceFlow.take` 的包装点，见 `_createEngine`）：
 *      **take 之前**先按已走次数预判并预占额度，conditional / default / 无条件边一视同仁；
 *      `_onFlowTake` 只记录已经走出去的边，不再做兜底判定。
 *    → 历史说明（只是来源，不是引擎特性）：0.13 之前的老引擎有一套「打回上限」，
 *      迁移器把旧流程的驳回边写成一条条件连线 + `fs:maxRounds`；新引擎按通用的
 *      「连线通过次数上限」执行同一条约束，不再有专门的驳回概念（也不关心条件文本
 *      是 `= true` 还是别的 FEEL 表达式）。
 * 2. **通用循环护栏**：同一条连线在单个实例里被 take 的次数上限（默认 1000，
 *    `loopGuardMax` 覆盖，0 = 关）。超限 → `BPMN_LOOP_LIMIT`（带 `flowId` 与 `takes`）。
 *    判定同样在 `_takeSequenceFlow` 的预占阶段：先判 `maxTakes`，再判循环护栏，
 *    所以 `= true` 的死环也在 take 之前就失败，不会多驱动一次目标节点。
 *
 * 两个计数（`_attempts` / `_flowTakes`）随 `getState()` 信封走（`attempts` / `flowTakes`），
 * 恢复后继续生效——否则在环里恢复一次就能把上限「清零」重来。
 *
 * 口径说明：`ctx.attempt` 是「本实例（含恢复）第几次进入该节点」；它随快照延续，
 * 不再按新实例从 1 重算。
 *
 * 报错形状：`BpmnRunnerError`（`code` / `message` / 可选 `elementId` / `activityId` /
 * `instanceId` / `cause`）。`error` 事件里带的是可序列化的 `{ code, message }`。
 *
 * @module @feiyueve/dsh-flow-studio/bpmn-runner
 */

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'

import { Engine } from 'bpmn-engine'
import { SequenceFlow } from 'bpmn-elements'
import { LRUCache } from 'lru-cache'

import { evaluateFeel, isFeelLanguage } from './bpmn-expr.js'
import { FS_NAMESPACE } from './bpmn-parse.js'
import {
  canonicalBpmnType,
  createRejectingExpressions,
  violationForActivityType,
} from './bpmn-policy.js'
import {
  BPMN_STATE_KIND,
  BPMN_STATE_VERSION,
  assertDefinitionIdentity,
  assertDefinitionMatchesStructure,
  assertRecoveredEngineStructure,
  assertStructuresMatch,
  describeExecutionStructure,
  normalizeDefinitionIdentity,
  readTrustedExecutionStructure,
  validateStateEnvelope,
} from './bpmn-state.js'

/** runner 内部执行状态（**不是实例状态**；实例状态见 instance-store 的 ACTIVE/COMPLETED/…）。 */
export const BPMN_RUNNER_STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING: 'waiting',
  DONE: 'done',
  BLOCKED: 'blocked',
})

/** 活跃实例默认上限（研究 §7：单实例 ≈450KB，1000 常驻 ≈435MB）。 */
const DEFAULT_MAX_ACTIVE_INSTANCES = 100
/** `lru-cache` 的容器上限只增不减；真正的上限由 `activeLimit` 手工裁剪执行。 */
const LRU_PHYSICAL_MAX = 100_000

/** 快照信封版本（v2：带定义身份；v1 / 裸快照一律拒绝，不做迁移）。 */
const STATE_VERSION = BPMN_STATE_VERSION
const STATE_KIND = BPMN_STATE_KIND

/**
 * 统一事件的 type 白名单（**runner 自己生成的事件只用这些**）。
 * handler 通过返回值 `events[]` 上报的适配器事件按原样透传，不走这个白名单。
 */
const EVENT_TYPES = Object.freeze([
  'process/start',
  'activity/start',
  'activity/end',
  'activity/wait',
  'flow/taken',
  'process/end',
  'error',
])

/** 只有这两类事件之后才快照（研究 §3 / #137：快照不可裁剪，别在每次事件上取）。 */
const SNAPSHOT_TRIGGERS = new Set(['activity/wait', 'activity/end'])

/** 支持的节点 kind → 生成的 BPMN 元素。unknown 一律拒绝（加载期校验）。 */
const TAG_BY_KIND = Object.freeze({
  start: 'bpmn:startEvent',
  end: 'bpmn:endEvent',
  agent: 'bpmn:serviceTask',
  http: 'bpmn:serviceTask',
  human: 'bpmn:userTask',
  gateway: 'bpmn:exclusiveGateway',
})

const SUPPORTED_KINDS = new Set(Object.keys(TAG_BY_KIND))

/** 通用循环护栏默认上限：同一条连线在单个实例里最多被 take 这么多次（0 = 关）。 */
const DEFAULT_LOOP_GUARD_MAX = 1000

/** 等引擎静默的轮询节奏：先密后疏，最多约 5 分钟。 */
const SETTLE_FAST_MS = 5
const SETTLE_SLOW_MS = 50
const SETTLE_FAST_CHECKS = 40
const MAX_SETTLE_CHECKS = 6000

/** `engine.stop()` 无响应时别把调用方挂死（研究的 26.x 行为，加个上限更稳）。 */
const STOP_TIMEOUT_MS = 1000

/**
 * BPMN 执行器错误：`code` 是稳定契约，`message` 是给人看的中文。
 *
 * 只带定位问题所需的最小信息（节点 id / 活动执行 id / 实例 id / 原始错误），
 * 不把变量或整份流程塞进错误对象——错误会进日志与事件流。
 */
export class BpmnRunnerError extends Error {
  /**
   * @param {string} code 稳定错误码（见各调用点）
   * @param {string} message 可读中文原因
   * @param {{ elementId?: string, activityId?: string, instanceId?: string, cause?: unknown, [key: string]: unknown }} [details]
   */
  constructor(code, message, details = {}) {
    super(typeof message === 'string' && message !== '' ? message : code)
    this.name = 'BpmnRunnerError'
    this.code = code
    const { elementId, activityId, instanceId, cause, ...extra } = details ?? {}
    if (elementId !== undefined) this.elementId = elementId
    if (activityId !== undefined) this.activityId = activityId
    if (instanceId !== undefined) this.instanceId = instanceId
    if (cause !== undefined) this.cause = cause
    if (Object.keys(extra).length > 0) Object.assign(this, extra)
  }

  /** 事件流用：只输出可序列化字段。 */
  toEventPayload() {
    const payload = { code: this.code, message: this.message }
    if (this.elementId !== undefined) payload.elementId = this.elementId
    if (this.activityId !== undefined) payload.activityId = this.activityId
    // 上限 / 循环类错误的可序列化定位字段（事件流消费方要能直接看出是哪条边、多少次）。
    for (const key of ['flowId', 'maxTakes', 'takes', 'attemptedTake', 'loopGuardMax', 'feelErrorCode']) {
      if (this[key] !== undefined) payload[key] = this[key]
    }
    return payload
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isThenable(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function'
}

function nowIso() {
  return new Date().toISOString()
}

function requireString(value, label, code = 'BPMN_DEFINITION_INVALID') {
  if (typeof value !== 'string' || value === '') {
    throw new BpmnRunnerError(code, `${label} 必须是非空字符串`, {})
  }
  return value
}

/** 深拷贝一串 JSON（快照要可序列化、且不能被调用方改到内部状态）。 */
function cloneJson(value, code, label) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    throw new BpmnRunnerError(code, `${label} 无法 JSON 序列化：${error?.message ?? error}`, { cause: error })
  }
}

function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 非字符串 error（引擎里偶有 undefined / 对象）也要能变成可读 message。 */
function errorMessageOf(error) {
  if (typeof error === 'string' && error !== '') return error
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  if (error && typeof error.description === 'string' && error.description !== '') return error.description
  return '未知错误'
}

/**
 * 任意错误 → `BpmnRunnerError`（已经是的原样返回，避免二次包装丢 code）。
 *
 * @param {unknown} error
 * @param {string} fallbackCode
 * @param {{ elementId?: string, activityId?: string, instanceId?: string }} [details]
 */
function asRunnerError(error, fallbackCode, details = {}) {
  if (error instanceof BpmnRunnerError) return error
  const code = error && typeof error.code === 'string' && error.code !== '' ? error.code : fallbackCode
  return new BpmnRunnerError(code, errorMessageOf(error), { ...details, cause: error })
}

/** `engine.stop()` 等可能挂住的 Promise 加一个上限；超时按「无法停止」处理。 */
function withTimeout(promise, ms, onTimeout) {
  if (!isThenable(promise)) return Promise.resolve(promise)
  return new Promise((resolve, _fail) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        if (typeof onTimeout === 'function') onTimeout()
      } catch {
        // 超时回调自己抛错不该掩盖主流程。
      }
      resolve(undefined)
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        _fail(error)
      }
    )
  })
}

/** 把多个 AbortSignal 合成一个（Node 20+ 用原生 `AbortSignal.any`，老运行时手写）。 */
function combineSignals(signals) {
  const list = signals.filter((signal) => signal && typeof signal.addEventListener === 'function')
  if (list.length === 0) return new AbortController().signal
  if (list.length === 1) return list[0]
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(list)
  }
  const controller = new AbortController()
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/**
 * 默认条件求值：`bpmn-expr.evaluateFeel`（组件优先，本模块不自己实现 FEEL）。
 *
 * `ok:false` 一律抛结构化错误（→ `error` 事件 + 实例 `lastError`），**不**降级成 false：
 * 非法条件必须暴露，不能静默走默认流。
 *
 * @param {string} expression 表达式原文（可带 `=` 前缀）
 * @param {Record<string, unknown>} variables FEEL context（本实例的变量账本）
 * @param {{ flowId?: string | null, from?: string | null, to?: string | null }} [where]
 * @returns {unknown}
 */
function defaultConditionValue(expression, variables, where = {}) {
  const outcome = evaluateFeel(expression, variables ?? {})
  if (!outcome || outcome.ok !== true) {
    const error = outcome?.error ?? null
    throw new BpmnRunnerError(
      'BPMN_CONDITION_INVALID',
      `条件求值失败：${error?.message ?? '未知错误'}（${error?.code ?? 'FEEL_UNKNOWN'}）`,
      {
        elementId: typeof where.flowId === 'string' ? where.flowId : undefined,
        expression,
        feelErrorCode: error?.code ?? null,
        from: where.from ?? null,
        to: where.to ?? null,
      }
    )
  }
  return outcome.value
}

// ---------------------------------------------------------------------------
// definition 归一化 / 校验 / 反向生成 XML
// ---------------------------------------------------------------------------

/**
 * 从 flow 的 `extensions` 里读 `fs:maxRounds` → **这条连线最多被走 N 次**（通用上限）。
 *
 * 口径：
 *   - 属性名 `fs:maxRounds` 沿用历史模板（解析器/转换器不用改），语义是通用的
 *     「sequence flow 通过次数上限」，适用于任何成环的连线；
 *   - 只认显式写在连线上的值（「未设上限」和「上限 N」不是一回事，缺省 = 不做上限判断）；
 *   - 只认 ≥1 的安全整数；非法值（0 / 负数 / 非数字 / 小数）一律当作未设。
 *
 * @param {unknown[]} extensions 解析器给的原样扩展（不改动它）
 * @returns {number | null}
 */
function readMaxTakes(extensions) {
  if (!Array.isArray(extensions)) return null
  for (const extension of extensions) {
    if (!isPlainObject(extension)) continue
    const type = typeof extension.type === 'string' ? extension.type.toLowerCase() : ''
    const name = typeof extension.name === 'string' ? extension.name.toLowerCase() : ''
    if (type !== 'fs:maxrounds' && name !== 'maxrounds') continue
    const raw = extension.value
    const value = typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN
    if (Number.isSafeInteger(value) && value >= 1) return value
  }
  return null
}

/**
 * 校验并归一化解析器给的 `definition`。
 *
 * 这里做的是**加载期校验**（计划 §3.1「编译失败即拒绝发布」的引擎侧一半）：
 *   - kind 白名单（unknown / 别的元素一律拒绝，MVP 只跑最小子集）；
 *   - 图结构闭合（start / end / flow 两端都存在、id 不重复）；
 *   - 条件只许 FEEL，并且**当场编译一次**（feelin 解析失败直接拒绝）；
 *   - 默认流不能带条件（BPMN 规范；带了就只记 warning 并在执行时忽略，不阻断运行）。
 *
 * @param {unknown} raw
 * @returns {{
 *   id: string, name: string | null, startId: string, endIds: string[],
 *   elements: Array<{ id: string, type: string, name: string | null, kind: string, node: object | null }>,
 *   flows: Array<{ id: string, from: string, to: string, condition: { expression: string, language: string } | null, isDefault: boolean, extensions: object[], maxTakes: number | null }>,
 *   elementById: Map<string, object>, flowById: Map<string, object>, flowsByFrom: Map<string, object[]>,
 *   warnings: string[],
 * }}
 */
function normalizeDefinition(raw) {
  if (!isPlainObject(raw)) {
    throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', 'definition 必须是对象（解析器的输出形状）', {})
  }
  const id = requireString(raw.id, 'definition.id')
  const warnings = []

  const rawElements = Array.isArray(raw.elements) ? raw.elements : []
  if (rawElements.length === 0) {
    throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `definition ${id} 没有 elements`, {})
  }

  const elements = []
  const elementById = new Map()
  for (const [index, entry] of rawElements.entries()) {
    if (!isPlainObject(entry)) {
      throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `definition.elements[${index}] 不是对象`, {})
    }
    const elementId = requireString(entry.id, `definition.elements[${index}].id`)
    if (elementById.has(elementId)) {
      throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `definition ${id} 里节点 id 重复：${elementId}`, { elementId })
    }
    const kind = String(entry.kind ?? 'unknown').toLowerCase()
    if (!SUPPORTED_KINDS.has(kind)) {
      throw new BpmnRunnerError(
        'BPMN_UNKNOWN_NODE_KIND',
        `节点 ${elementId} 的 kind=${kind} 不受支持；本执行器只跑 ${[...SUPPORTED_KINDS].join(' / ')}（计划 §3：其余元素加载期拒绝）`,
        { elementId }
      )
    }
    const node = entry.node === undefined ? null : entry.node
    if (node !== null && !isPlainObject(node)) {
      throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `节点 ${elementId} 的 node 必须是对象或 null`, { elementId })
    }
    // definition-only 入口先查**原始 type**，再查生成 XML：不能先把
    // parallelGateway 归一成普通 gateway，再让 buildBpmnXml 生成安全 XML。
    const declaredType = typeof entry.type === 'string' && entry.type !== '' ? entry.type : TAG_BY_KIND[kind]
    const typeViolation = violationForActivityType(declaredType, elementId)
    if (typeViolation !== null) {
      throw new BpmnRunnerError(typeViolation.code, typeViolation.message, { elementId })
    }
    if (canonicalBpmnType(declaredType) !== canonicalBpmnType(TAG_BY_KIND[kind])) {
      throw new BpmnRunnerError(
        'BPMN_DEFINITION_INVALID',
        `节点 ${elementId} 的 type=${JSON.stringify(declaredType)} 与 kind=${kind}（应为 ${TAG_BY_KIND[kind]}）不一致`,
        { elementId }
      )
    }
    const element = {
      id: elementId,
      type: declaredType,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : null,
      kind,
      node,
    }
    elements.push(element)
    elementById.set(elementId, element)
  }

  // start / end：契约里有就给，给的不一致就报错；没给就从 kind 推（容忍解析器省略）。
  const derivedStarts = elements.filter((element) => element.kind === 'start').map((element) => element.id)
  const derivedEnds = elements.filter((element) => element.kind === 'end').map((element) => element.id)
  const startId = raw.startId === undefined || raw.startId === null
    ? derivedStarts[0]
    : requireString(raw.startId, 'definition.startId')
  if (!startId) {
    throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `definition ${id} 没有 startId，也没有 kind=start 的节点`, {})
  }
  const startElement = elementById.get(startId)
  if (!startElement) {
    throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `definition.startId=${startId} 不在 elements 里`, { elementId: startId })
  }
  if (startElement.kind !== 'start') {
    throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `definition.startId=${startId} 的 kind 是 ${startElement.kind}，不是 start`, { elementId: startId })
  }
  if (derivedStarts.length > 1) {
    warnings.push(`definition ${id} 有 ${derivedStarts.length} 个 start 节点，只从 ${startId} 起跑`)
  }

  const rawEndIds = raw.endIds === undefined || raw.endIds === null ? derivedEnds : raw.endIds
  if (!Array.isArray(rawEndIds) || rawEndIds.length === 0) {
    throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `definition ${id} 没有 endIds，也没有 kind=end 的节点`, {})
  }
  const endIds = rawEndIds.map((value, index) => requireString(value, `definition.endIds[${index}]`))
  for (const endId of endIds) {
    const element = elementById.get(endId)
    if (!element) {
      throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `definition.endIds 里的 ${endId} 不在 elements 里`, { elementId: endId })
    }
    if (element.kind !== 'end') {
      throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `definition.endIds 里的 ${endId} 的 kind 是 ${element.kind}，不是 end`, { elementId: endId })
    }
  }

  // flows：两端必须存在；条件只许 FEEL；默认流不许带条件。
  const rawFlows = Array.isArray(raw.flows) ? raw.flows : []
  const flows = []
  const flowById = new Map()
  const flowsByFrom = new Map()
  const defaultCountByGateway = new Map()
  for (const [index, entry] of rawFlows.entries()) {
    if (!isPlainObject(entry)) {
      throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `definition.flows[${index}] 不是对象`, {})
    }
    const flowId = requireString(entry.id, `definition.flows[${index}].id`)
    if (flowById.has(flowId)) {
      throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `definition ${id} 里连线 id 重复：${flowId}`, {})
    }
    const from = requireString(entry.from, `definition.flows[${index}].from`)
    const to = requireString(entry.to, `definition.flows[${index}].to`)
    if (!elementById.has(from)) {
      throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `连线 ${flowId} 的 from=${from} 不在 elements 里`, { elementId: from })
    }
    if (!elementById.has(to)) {
      throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `连线 ${flowId} 的 to=${to} 不在 elements 里`, { elementId: to })
    }
    const isDefault = entry.isDefault === true
    const condition = normalizeCondition(entry.condition, flowId)
    // fs: 扩展原样留在 flow 上（上层要能拿到 fs:note / fs:maxRounds 等原文），
    // 同时派生只读语义字段 maxTakes（这条连线最多被走几次）供上限判定用。
    const extensions = Array.isArray(entry.extensions) ? entry.extensions.slice() : []
    const maxTakes = readMaxTakes(extensions)

    if (condition && isDefault) {
      // BPMN 规范：默认流无条件可用（引擎对默认流直接 evaluate=true，不看表达式）。
      // 这里只告警并按规范忽略，不阻断——否则模板作者把条件抄到默认流上会整体不可跑。
      warnings.push(`连线 ${flowId} 是默认流却带了条件，按 BPMN 语义忽略该条件`)
    }
    if (condition && !isDefault) {
      assertConditionCompilable(condition, { flowId, from, to })
    }
    if (isDefault) {
      const fromElement = elementById.get(from)
      if (fromElement.kind !== 'gateway') {
        warnings.push(`连线 ${flowId} 标了 isDefault，但源节点 ${from} 不是 gateway（仍按默认流生成）`)
      }
      const count = (defaultCountByGateway.get(from) ?? 0) + 1
      defaultCountByGateway.set(from, count)
      if (count > 1) {
        throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `网关 ${from} 有多条默认流（BPMN 只允许一条）`, { elementId: from })
      }
    }

    const flow = {
      id: flowId,
      from,
      to,
      condition: isDefault ? null : condition,
      isDefault,
      extensions,
      maxTakes,
    }
    flows.push(flow)
    flowById.set(flowId, flow)
    const list = flowsByFrom.get(from)
    if (list) list.push(flow)
    else flowsByFrom.set(from, [flow])
  }

  if (flows.length === 0) {
    throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `definition ${id} 没有 flows`, {})
  }
  // 每个非 end 节点至少要有一条出向连线，否则引擎跑到那里会「无路可走」。
  for (const element of elements) {
    if (element.kind === 'end') continue
    if (!flowsByFrom.has(element.id)) {
      throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `节点 ${element.id}（${element.kind}）没有出向连线`, { elementId: element.id })
    }
  }

  return {
    id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : null,
    startId,
    endIds,
    elements,
    flows,
    elementById,
    flowById,
    flowsByFrom,
    warnings,
  }
}

/** `condition` 归一化：null / 对象 / 字符串都接受，语言只许 FEEL。 */
function normalizeCondition(raw, flowId) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null
    return { expression: raw, language: 'feel' }
  }
  if (!isPlainObject(raw)) {
    throw new BpmnRunnerError('BPMN_DEFINITION_INVALID', `连线 ${flowId} 的 condition 必须是对象或 null`, {})
  }
  const expression = requireString(raw.expression, `连线 ${flowId} 的 condition.expression`)
  const language = typeof raw.language === 'string' ? raw.language.trim().toLowerCase() : 'feel'
  if (!isFeelLanguage(language)) {
    throw new BpmnRunnerError(
      'BPMN_CONDITION_LANGUAGE_UNSUPPORTED',
      `连线 ${flowId} 的条件语言是 ${language || '(空)'}；本执行器只支持 FEEL（javascript 走 node:vm，实测可逃逸到 process，计划 §3.1 禁用）`,
      { elementId: flowId }
    )
  }
  return { expression, language }
}

/** 加载期编译一次条件：语法错 / 可疑内容就直接拒绝，别等到运行时把分支走错。 */
function assertConditionCompilable(condition, { flowId }) {
  const outcome = evaluateFeel(condition.expression, {})
  if (!outcome || outcome.ok !== true) {
    const error = outcome?.error ?? null
    throw new BpmnRunnerError(
      'BPMN_CONDITION_INVALID',
      `连线 ${flowId} 的条件表达式无法求值：${condition.expression}（${error?.code ?? 'FEEL_UNKNOWN'}：${error?.message ?? '未知错误'}）`,
      { elementId: flowId, feelErrorCode: error?.code ?? null }
    )
  }
}

/**
 * 把归一化后的 definition 反向生成最小 BPMN 2.0 XML（只有 definition 时用）。
 *
 * 不产出 `fs:` 扩展（本模块的派发靠 `definition.elements`，不靠 XML 里的扩展）；
 * 产出顺序固定，保证同一份 definition 生成的 XML 逐字节稳定。
 *
 * @param {ReturnType<typeof normalizeDefinition>} definition
 * @returns {string}
 */
function buildBpmnXml(definition) {
  const lines = []
  for (const element of definition.elements) {
    const tag = TAG_BY_KIND[element.kind]
    const attrs = [`id="${escapeXmlText(element.id)}"`]
    if (element.name !== null) attrs.push(`name="${escapeXmlText(element.name)}"`)
    if (element.kind === 'gateway') {
      const defaultFlow = (definition.flowsByFrom.get(element.id) ?? []).find((flow) => flow.isDefault)
      if (defaultFlow) attrs.push(`default="${escapeXmlText(defaultFlow.id)}"`)
    }
    const incoming = definition.flows
      .filter((flow) => flow.to === element.id)
      .map((flow) => `<bpmn:incoming>${escapeXmlText(flow.id)}</bpmn:incoming>`)
      .join('')
    const outgoing = (definition.flowsByFrom.get(element.id) ?? [])
      .map((flow) => `<bpmn:outgoing>${escapeXmlText(flow.id)}</bpmn:outgoing>`)
      .join('')
    const body = `${incoming}${outgoing}`
    lines.push(`    <${tag} ${attrs.join(' ')}>${body}</${tag}>`)
  }
  for (const flow of definition.flows) {
    const attrs = [
      `id="${escapeXmlText(flow.id)}"`,
      `sourceRef="${escapeXmlText(flow.from)}"`,
      `targetRef="${escapeXmlText(flow.to)}"`,
    ]
    const conditionXml = flow.condition
      ? `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" ` +
        `language="${escapeXmlText(flow.condition.language)}">${escapeXmlText(flow.condition.expression)}` +
        '</bpmn:conditionExpression>'
      : ''
    // 连线次数上限必须进 XML：runtime 恢复时重新 `parseBpmn(definition.bpmn)` 建 definition，
    // 不写进 XML 的话定义-only 实例一旦恢复就会把 fs:maxRounds 丢掉（上限被清零）。
    const maxRoundsXml = flow.maxTakes === null || flow.maxTakes === undefined
      ? ''
      : `<bpmn:extensionElements><fs:maxRounds>${flow.maxTakes}</fs:maxRounds></bpmn:extensionElements>`
    if (conditionXml !== '' || maxRoundsXml !== '') {
      lines.push(`    <bpmn:sequenceFlow ${attrs.join(' ')}>${conditionXml}${maxRoundsXml}</bpmn:sequenceFlow>`)
    } else {
      lines.push(`    <bpmn:sequenceFlow ${attrs.join(' ')} />`)
    }
  }
  const processAttrs = [`id="${escapeXmlText(definition.id)}"`]
  if (definition.name !== null) processAttrs.push(`name="${escapeXmlText(definition.name)}"`)
  processAttrs.push('isExecutable="true"')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"',
    '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    `  xmlns:fs="${FS_NAMESPACE}"`,
    `  id="Definitions_${escapeXmlText(definition.id)}" targetNamespace="http://dsh.local/bpmn">`,
    `  <bpmn:process ${processAttrs.join(' ')}>`,
    ...lines,
    '  </bpmn:process>',
    '</bpmn:definitions>',
    '',
  ].join('\n')
}

/**
 * 把解析器给的 definition 直接转成 BPMN XML（给上层做「模板正本」或测试夹具用）。
 *
 * 这是 `buildBpmnXml` 的公开包装：同样做加载期校验（kind 白名单 / 图闭合 / 条件编译）。
 *
 * @param {unknown} definition
 * @returns {string}
 */
export function bpmnXmlFromDefinition(definition) {
  return buildBpmnXml(normalizeDefinition(definition))
}

/**
 * XML 模式下的**粗粒度**一致性与红线自检（不解析 XML，只做文本扫描）。
 *
 * 这里查三件事：
 *   1. definition 里需要 handler / 人工完成的节点 id 必须在 XML 里出现（否则派发不到）；
 *   2. 出现 `parallelGateway` / `inclusiveGateway` → 拒绝（研究红线 2：并行汇聚 + 成环 #204）；
 *   3. 出现 `language="javascript"` → 拒绝（研究红线 1：node:vm 不是沙箱）。
 */
function assertXmlConsistent(xml, definition) {
  for (const element of definition.elements) {
    if (element.kind === 'start' || element.kind === 'end' || element.kind === 'gateway') continue
    const pattern = new RegExp(`(?:^|[\\s<])id\\s*=\\s*["']${escapeRegExp(element.id)}["']`)
    if (!pattern.test(xml)) {
      throw new BpmnRunnerError(
        'BPMN_XML_ELEMENT_MISSING',
        `definition 里的节点 ${element.id}（${element.kind}）在 xml 里找不到 id="${element.id}"：definition 与 xml 不是同一版`,
        { elementId: element.id }
      )
    }
  }
  const forbiddenElement = /<(?:[A-Za-z_][\w.-]*:)?(?:parallelGateway|inclusiveGateway|complexGateway)[\s/>]/.exec(xml)
  if (forbiddenElement) {
    throw new BpmnRunnerError(
      'BPMN_GATEWAY_UNSUPPORTED',
      `xml 里出现 ${forbiddenElement[0].replace(/[<>\s/]/g, '')}：MVP 禁用 parallel / inclusive / complex 网关（研究红线 2：并行汇聚 + 成环会提前通过，#204）`,
      {}
    )
  }
  if (/language\s*=\s*["'](?:javascript|js)["']/i.test(xml)) {
    throw new BpmnRunnerError(
      'BPMN_CONDITION_LANGUAGE_UNSUPPORTED',
      'xml 里出现 language="javascript"：node:vm 不是安全沙箱（实测可逃逸到 process），计划 §3.1 禁用',
      {}
    )
  }
}

// ---------------------------------------------------------------------------
// 活跃实例 LRU
// ---------------------------------------------------------------------------

/**
 * 活跃实例容器：**用它管 recency / 集合**，淘汰动作由 `trimActive` 手工执行。
 *
 * 为什么不用 `lru-cache` 的自动淘汰（`dispose`）：
 * 约定是「被淘汰的实例必须已落过 state，否则报错」；`dispose` 无法阻止条目被移除，
 * 只能做事后补偿，而我们要的是**淘汰前**校验并保持集合不变（拒绝静默丢）。
 * 所以：自动 max 只增不减（不会触发自动淘汰），真正的上限由 `activeLimit` 裁剪。
 */
const ACTIVE = new LRUCache({ max: LRU_PHYSICAL_MAX, updateAgeOnGet: false, updateAgeOnHas: false })

/** 当前生效的活跃实例上限（`maxActiveInstances` 显式传入时更新）。 */
let activeLimit = DEFAULT_MAX_ACTIVE_INSTANCES

/** 只增加物理上限，永不缩小（缩小会触发 lru-cache 的自动淘汰）。 */
function applyActiveLimit(limit) {
  if (limit > ACTIVE.max) ACTIVE.max = limit
  activeLimit = limit
}

/** 取当前最久未使用的 key（`rkeys()` 是 LRU → MRU 顺序）。 */
function leastRecentlyUsedKey() {
  for (const key of ACTIVE.rkeys()) return key
  return undefined
}

/**
 * 把活跃实例裁到上限以内（为新实例腾位置）。
 *
 * 被淘汰者必须 `_canEvict()`：已落过 state，或已到终态（done/blocked），或从未启动。
 * 否则抛 `BPMN_LRU_EVICT_UNSNAPSHOTTED`，并且**不**动集合里的任何实例。
 */
function trimActive() {
  while (ACTIVE.size >= activeLimit) {
    const victimId = leastRecentlyUsedKey()
    if (victimId === undefined) return
    const victim = ACTIVE.peek(victimId)
    if (!victim) {
      ACTIVE.delete(victimId)
      continue
    }
    if (!victim._canEvict()) {
      throw new BpmnRunnerError(
        'BPMN_LRU_EVICT_UNSNAPSHOTTED',
        `活跃实例已达上限 ${activeLimit}，需要淘汰 ${victimId}，但它还没落过 state（未到 activity/wait 或 activity/end，或 shouldSnapshot 一直返回 false）。拒绝静默丢弃：先 getState() 落盘，或调高 maxActiveInstances`,
        { instanceId: victimId }
      )
    }
    ACTIVE.delete(victimId)
    victim._markEvicted()
  }
}

/**
 * 当前活跃实例数（活跃 = 还挂在 LRU 里的实例；已 `stop()` 或已淘汰的不算）。
 *
 * @returns {number}
 */
export function activeInstanceCount() {
  return ACTIVE.size
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

/** 生成实例 id（只用于 LRU key / 日志，不参与业务主键）。 */
function newInstanceId() {
  const random = Math.random().toString(36).slice(2, 10)
  return `bi-${Date.now().toString(36)}-${random}`
}

/**
 * 创建一个 BPMN 执行器实例（一次运行一个实例；定义是冻结的，实例状态各自独立）。
 *
 * @param {{
 *   definition: object,
 *   xml?: string | Buffer,
 *   services?: {
 *     executeAgent?: (element: object, ctx: object) => Promise<{ output?: unknown, usage?: object, events?: object[], artifacts?: unknown[] } | undefined>,
 *     executeHttp?: (element: object, ctx: object) => Promise<{ output?: unknown, status?: number, headers?: object } | undefined>,
 *     onEvent?: (event: object) => void,
 *     onTaskWait?: (task: object) => void,
 *     onTaskDone?: (taskResult: object) => void,
 *     onError?: (error: BpmnRunnerError) => void,
 *   },
 *   limits?: { activityWaitMs?: number, runTimeoutMs?: number },
 *   variables?: object,
 *   // 通用循环护栏：同一条连线在单个实例里最多被 take 多少次（默认 1000，0 = 关）。
 *   // 这是「防死环」的最后一道保险，和 fs:maxRounds 的连线次数上限互不替代。
 *   loopGuardMax?: number,
 *   shouldSnapshot?: (event: object) => boolean | Promise<boolean>,
 *   // 定义身份（必填）：state 信封 v2 用它确认「恢复的确实是同一份定义」。
 *   definitionIdentity: { id: string, version: string | number, hash: string },
 *   maxActiveInstances?: number,
 *   instanceId?: string,
 * }} options
 * @returns {BpmnRunner}
 */
export function createBpmnRunner(options = {}) {
  if (!isPlainObject(options)) {
    throw new BpmnRunnerError('BPMN_OPTIONS_INVALID', 'createBpmnRunner(options) 需要一个对象', {})
  }
  const runner = new BpmnRunner(options)
  registerActive(runner)
  return runner
}

/** 注册到活跃实例表：先按上限腾位置（可能抛错），再插入。 */
function registerActive(runner) {
  if (runner.maxActiveInstances !== null) applyActiveLimit(runner.maxActiveInstances)
  trimActive()
  if (ACTIVE.has(runner.instanceId)) {
    throw new BpmnRunnerError('BPMN_INSTANCE_ID_CONFLICT', `实例 id ${runner.instanceId} 已被占用`, { instanceId: runner.instanceId })
  }
  ACTIVE.set(runner.instanceId, runner)
}

class BpmnRunner {
  constructor(options) {
    this.definition = normalizeDefinition(options.definition)
    this.xml = normalizeXml(options.xml)
    this.services = normalizeServices(options.services)
    this.limits = normalizeLimits(options.limits)
    this.variables = isPlainObject(options.variables)
      ? cloneJson(options.variables, 'BPMN_OPTIONS_INVALID', 'options.variables')
      : {}
    this.instanceId = options.instanceId === undefined
      ? newInstanceId()
      : requireString(options.instanceId, 'options.instanceId', 'BPMN_OPTIONS_INVALID')
    this.maxActiveInstances = normalizeMaxActive(options.maxActiveInstances)
    this.loopGuardMax = normalizeLoopGuardMax(options.loopGuardMax)
    this.shouldSnapshotHook = typeof options.shouldSnapshot === 'function' ? options.shouldSnapshot : null
    if (options.shouldSnapshot !== undefined && options.shouldSnapshot !== null && this.shouldSnapshotHook === null) {
      throw new BpmnRunnerError('BPMN_OPTIONS_INVALID', 'options.shouldSnapshot 必须是函数', { instanceId: this.instanceId })
    }
    // 条件求值只有一个入口：bpmn-expr.evaluateFeel。生产入口不再接受自定义求值器
    // （传了就报错，避免上层悄悄把条件交回引擎/别的实现）。
    if (options.evaluateCondition !== undefined) {
      throw new BpmnRunnerError(
        'BPMN_OPTIONS_INVALID',
        'options.evaluateCondition 已移除：条件只允许经 bpmn-expr.evaluateFeel 求值（0.13 红线）',
        { instanceId: this.instanceId }
      )
    }
    this.warnings = [...this.definition.warnings]
    if (this.xml !== null) assertXmlConsistent(this.xml, this.definition)

    /** 传给引擎的 XML：有 xml 用 xml，没有就用 definition 反向生成。 */
    this.sourceXml = this.xml ?? buildBpmnXml(this.definition)

    // 定义身份（存储域 definitionId + 版本 + XML 原文 sha256）：start 与 recover 都要对，
    // state v2 信封把它当必填字段；runtime 从实例快照自己重算 hash，不信请求自报。
    try {
      this.identity = normalizeDefinitionIdentity(options.definitionIdentity)
      this._sourceHash = assertDefinitionIdentity(this.identity, {
        sourceXml: this.sourceXml,
        definition: this.definition,
      }).sourceHash
    } catch (error) {
      throw asRunnerError(error, 'BPMN_OPTIONS_INVALID', { instanceId: this.instanceId })
    }
    /** 可信 XML 的执行结构（恢复时用来对照 state 里的实际来源）。 */
    this._trustedStructure = null
    /** 拒绝型内置表达式解析器（Environment.clone / recover 后必须还是它）。 */
    this._rejectExpressions = createRejectingExpressions()
    this._expressionsGuardChecked = false

    // 运行态
    this._status = 'idle'
    this._engine = null
    this._listener = null
    this._started = false
    this._evicted = false
    this._stopping = false
    this._sawRun = false
    this._fatal = null
    /** 执行代次：每次 start / recover / stop / fail / evict 自增，作废在飞的 Promise 回调。 */
    this._generation = 0
    this._lastState = null
    this._deferred = null
    this._settleTimer = null
    this._settleChecks = 0
    this._checkingSettle = false
    this._snapshotChain = Promise.resolve()
    this._instanceAbort = new AbortController()
    this._activityAborts = new Map()
    this._activityTimers = new Map()
    this._runTimer = null
    this._engineStopScheduled = false
    this._attempts = new Map()
    /** 每条连线在本实例里被 take 的次数（通用循环护栏）。 */
    this._flowTakes = new Map()
    this._startedAt = new Map()
    this._pending = new Map()
    this._completing = new Map()
    this._handlerResults = new Map()
    this._pendingHandlerErrors = new Map()
    /** 条件求值错误：engine 会把它包成 ActivityError（code/message 都会变），
     *  所以按「源活动 executionId」先存一份自己的结构化错误，事件里报自己的。 */
    this._pendingConditionErrors = new Map()
    /** 每条连线最近一次求值的表达式原文（XML 模式专用：definition 可能没带 condition）。 */
    this._evaluatedConditions = new Map()

    this._assertHandlers(options.services)
  }

  // -------------------------------------------------------------------------
  // 公开 API
  // -------------------------------------------------------------------------

  /** `'idle' | 'running' | 'waiting' | 'done' | 'blocked'`（淘汰后回到 idle）。 */
  status() {
    return this._status
  }

  /** 阻塞原因（runner 侧 `status()==='blocked'` 时才有）；实例层据此写 `lastError`。 */
  failure() {
    return this._fatal
  }

  /** 当前执行代次是否还活着（没停 / 没阻塞 / 没淘汰 / 没换代）。 */
  _isLive(generation) {
    return generation === this._generation
      && !this._evicted
      && !this._stopping
      && this._fatal === null
  }

  /**
   * 谁在等人：按进入等待的先后顺序。
   *
   * @returns {Array<{ activityId: string, elementId: string, name: string | null, since: string, executionId: string }>}
   */
  pendingTasks() {
    return [...this._pending.values()].map((task) => ({
      activityId: task.activityId,
      elementId: task.elementId,
      name: task.name,
      since: task.since,
      executionId: task.executionId,
    }))
  }

  /**
   * 启动并跑到**第一个等待点或结束**。
   *
   * 失败（handler 抛错 / 超时 / 引擎 fatal）时这个 Promise 会**失败**（`BpmnRunnerError`），
   * 同时 `status()==='blocked'`、`onError` 被调用、`error` 事件已发。
   *
   * @returns {Promise<{ state: 'waiting' | 'done' | 'running' | 'idle' }>}
   */
  async start() {
    this._assertUsable('start')
    if (this._started) {
      throw new BpmnRunnerError(
        'BPMN_ALREADY_STARTED',
        `实例 ${this.instanceId} 已经启动过；要接着跑请用 recover(state)`,
        { instanceId: this.instanceId }
      )
    }
    // 启动前先过执行白名单 + 与 definition 的形状对照：任何 handler 都还没机会执行。
    await this._prepareTrustedStructure('start')

    this._generation += 1
    const generation = this._generation
    this._started = true
    this._status = 'running'
    this._fatal = null
    this._engine = this._createEngine()
    this._listener = this._attachListener()
    this._armRunTimer()
    this._syncEngineVariables()
    this._assertEngineExpressionsGuarded()

    const settled = this._wait()
    try {
      // 坑 1：活动事件只从 listener 出来；callback 只兜底 end/stop/error。
      const result = this._engine.execute(
        { listener: this._listener },
        (error) => this._onEngineCallback(error, generation)
      )
      if (isThenable(result)) result.catch((error) => this._onEngineCallback(error, generation))
    } catch (error) {
      this._fail(asRunnerError(error, 'BPMN_ENGINE_ERROR', { instanceId: this.instanceId }))
    }
    this._scheduleSettle()
    return settled
  }

  /**
   * 可信 XML → 执行结构（含执行白名单），并核对调用方给的 definition。
   *
   * 只读、可缓存在实例上；失败时 handler 一次都不会被派发。
   *
   * @param {'start'|'recover'} phase 错误文案用
   * @returns {Promise<object>}
   */
  async _prepareTrustedStructure(phase) {
    if (this._trustedStructure !== null) {
      assertDefinitionMatchesStructure(this.definition, this._trustedStructure, phase)
      return this._trustedStructure
    }
    try {
      const structure = await readTrustedExecutionStructure(this.sourceXml)
      assertDefinitionMatchesStructure(this.definition, structure, phase)
      this._trustedStructure = structure
      return structure
    } catch (error) {
      throw asRunnerError(error, 'BPMN_DEFINITION_INVALID', { instanceId: this.instanceId })
    }
  }

  /**
   * 从 state 恢复（坑 4：内部一定新建 Engine + `recover(state)` + `resume({listener})`）。
   *
   * 接受 `getState()` 返回的信封，也接受裸的 `bpmn-engine` state（兼容手工落的 state）。
   * 注意：裸 state 不带本模块的变量账本，恢复后条件求值拿不到运行期变量；生产路径请用
   * `getState()` 的信封。
   *
   * **运行中调用会抛 `BPMN_RECOVER_RUNNING`**，不会静默重建。
   *
   * @param {object} state
   * @returns {Promise<void>}
   */
  async recover(state) {
    this._assertUsable('recover')
    if (this._engine?.execution?.isRunning) {
      throw new BpmnRunnerError(
        'BPMN_RECOVER_RUNNING',
        `实例 ${this.instanceId} 的引擎还在运行，不能 recover（bpmn-engine 只允许给非运行中的 engine 恢复）。先 stop()，或等它停在等待点并落盘后再用新实例恢复`,
        { instanceId: this.instanceId }
      )
    }
    if (this._status === 'running' || this._status === 'waiting') {
      throw new BpmnRunnerError(
        'BPMN_RECOVER_RUNNING',
        `实例 ${this.instanceId} 状态是 ${this._status}，还有未收尾的运行；recover 只能给非运行中的实例用`,
        { instanceId: this.instanceId }
      )
    }

    // 恢复顺序固定：信封 + 身份 → 有界解析 source → 实际结构对照 → engine.recover
    // → 恢复后 context 复核 → 最后才挂监听 / 计时器 / resume。
    // 前面任何一步失败都不会创建活动、不会派发 handler。
    let validated
    let trusted
    try {
      validated = validateStateEnvelope(state, {
        identity: this.identity,
        definition: this.definition,
        instanceId: this.instanceId,
      })
      trusted = await this._prepareTrustedStructure('recover')
      assertStructuresMatch(
        trusted,
        describeExecutionStructure(validated.sourceContext),
        'state.engine.definitions[0].source'
      )
    } catch (error) {
      throw asRunnerError(error, 'BPMN_STATE_INVALID', { instanceId: this.instanceId })
    }

    // 只有「running / stopped」的 state 有可推进的点。实测：恢复 done / error / idle 的
    // state 时 `resume()` 不会产生任何事件，等静默的循环会白白转满上限（调用方挂住）。
    const resumableState = validated.engineState.state
    if (resumableState !== 'running' && resumableState !== 'stopped') {
      throw new BpmnRunnerError(
        'BPMN_STATE_NOT_RESUMABLE',
        `这份 state 的引擎状态是 ${typeof resumableState === 'string' ? resumableState : '(缺失)'}，只有 running / stopped 能恢复（done / error / idle 没有可推进的点，实例已卡住（blocked））`,
        { instanceId: this.instanceId }
      )
    }

    // 新的一条命：清计时器 / 重开 abort / 清待办与错误 / 作废旧代次的回调。
    this._generation += 1
    const generation = this._generation
    this._clearAllTimers()
    this._instanceAbort = new AbortController()
    this._activityAborts.clear()
    this._pending.clear()
    this._completing.clear()
    this._handlerResults.clear()
    this._pendingHandlerErrors.clear()
    this._pendingConditionErrors.clear()
    this._evaluatedConditions.clear()
    this._fatal = null
    this._lastState = null
    this._sawRun = false
    this._started = true
    this._status = 'running'
    this.variables = { ...this.variables, ...validated.variables }

    // 计数跨恢复延续：否则在环里恢复一次就能把已用掉的次数「清零」重来。
    this._attempts = restoreCounts(validated.attempts)
    this._flowTakes = restoreCounts(validated.flowTakes)

    this._engine = this._createEngine()
    try {
      this._engine.recover(validated.engineState)
      // 复核的是引擎**实际**加载出来的执行来源，不是再次相信传入的 XML。
      assertRecoveredEngineStructure(this._engine, trusted)
      this._assertEngineExpressionsGuarded()
      this._assertDefinitionExpressionsGuarded()
    } catch (error) {
      this._status = 'idle'
      this._started = false
      this._engine = null
      this._listener = null
      this._generation += 1
      this._clearAllTimers()
      this._abortAll()
      this._pending.clear()
      this._completing.clear()
      this._handlerResults.clear()
      this._pendingHandlerErrors.clear()
      this._pendingConditionErrors.clear()
      this._startedAt.clear()
      throw asRunnerError(error, 'BPMN_STATE_RECOVER_FAILED', { instanceId: this.instanceId })
    }

    this._listener = this._attachListener()
    this._armRunTimer()
    this._syncEngineVariables()

    const settled = this._wait()
    try {
      const result = this._engine.resume(
        { listener: this._listener },
        (error) => this._onEngineCallback(error, generation)
      )
      if (isThenable(result)) result.catch((error) => this._onEngineCallback(error, generation))
    } catch (error) {
      this._fail(asRunnerError(error, 'BPMN_ENGINE_ERROR', { instanceId: this.instanceId }))
    }
    this._scheduleSettle()
    await settled
  }

  /**
   * 取快照（信封：`{ v, kind, definitionId, instanceId, status, variables, pendingTasks, engine }`）。
   *
   * 这是**显式**取快照，不受 `shouldSnapshot` 去抖影响；`engine` 字段是
   * `bpmn-engine` 的原始 state（7–18KB，不可裁剪）。
   *
   * @returns {Promise<object>}
   */
  async getState() {
    if (this._engine === null) {
      if (this._lastState !== null) return cloneJson(this._lastState, 'BPMN_STATE_UNSERIALIZABLE', 'state')
      return cloneJson(this._buildEnvelope(null, 'empty'), 'BPMN_STATE_UNSERIALIZABLE', 'state')
    }
    return this._snapshotNow('explicit')
  }

  /**
   * 人工任务完成（坑：userTask 就是永久 wait 的 signal task，推进只能外部 signal）。
   *
   * @param {{ activityId?: string, executionId?: string, payload?: object }} request
   * @returns {Promise<void>} 等到「下一个等待点 / 结束 / 失败」
   */
  async signalTask(request = {}) {
    this._assertUsable('signalTask')
    if (this._status === 'blocked') {
      throw new BpmnRunnerError(
        'BPMN_INSTANCE_BLOCKED',
        `实例 ${this.instanceId} 已阻塞（blocked），不能再完成任务：${this._fatal?.message ?? ''}`,
        { instanceId: this.instanceId, cause: this._fatal ?? undefined }
      )
    }
    if (!isPlainObject(request)) {
      throw new BpmnRunnerError('BPMN_TASK_NOT_FOUND', 'signalTask 需要一个对象：{ activityId | executionId, payload }', { instanceId: this.instanceId })
    }
    const activityId = typeof request.activityId === 'string' && request.activityId !== '' ? request.activityId : null
    const executionId = typeof request.executionId === 'string' && request.executionId !== '' ? request.executionId : null
    if (activityId === null && executionId === null) {
      throw new BpmnRunnerError('BPMN_TASK_NOT_FOUND', 'signalTask 需要 activityId（BPMN 活动 id）或 executionId', { instanceId: this.instanceId })
    }
    const task = this._findPendingTask({ activityId, executionId })
    if (!task) {
      const waiting = this.pendingTasks().map((entry) => entry.activityId).join('、')
      throw new BpmnRunnerError(
        'BPMN_TASK_NOT_FOUND',
        `没有在等待的任务 ${activityId ?? executionId}；当前等待：${waiting === '' ? '无' : waiting}`,
        { instanceId: this.instanceId, elementId: activityId ?? undefined }
      )
    }

    const payload = isPlainObject(request.payload) ? request.payload : {}
    const settled = this._wait()
    this._status = 'running'

    // 载荷就是活动 output（引擎侧 activity.end 会给同一份），先并进变量账本，
    // 这样紧接着的条件求值能立刻看到。
    this._mergeOutput(payload, task.elementId)
    this._syncEngineVariables()

    // 先把任务从待办挪到「正在完成」，**再** signal：引擎的 broker 可能是同步投递的，
    // 放在 signal 之后会错过紧随其后的 activity/end（onTaskDone 就永远不回调）。
    this._pending.delete(task.executionId)
    this._completing.set(task.executionId, task)
    const message = { ...payload, id: task.elementId, executionId: task.executionId }
    try {
      this._engine.execution.signal(message)
    } catch (error) {
      this._pending.set(task.executionId, task)
      this._completing.delete(task.executionId)
      throw asRunnerError(error, 'BPMN_ENGINE_ERROR', { elementId: task.elementId, activityId: task.executionId })
    }

    this._scheduleSettle()
    await settled
    return undefined
  }

  /**
   * 停止：abort 在飞 handler + 停止引擎推进（坑 9），并从活跃实例表摘除。
   *
   * 幂等；实例层取消（→ `CANCELED`）由 runtime 负责，这里只负责让执行停下。
   * 停止后 `status()` 是 `idle`。
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._evicted) return undefined
    this._stopping = true
    // 作废在飞回调：stop 之后到达的 handler 结果 / 引擎回调都不许回写。
    this._generation += 1
    // 先收状态再停引擎：引擎停下来的过程会触发 execute 的 callback，那里会 resolve 在等的
    // start()/signalTask()；状态先摆好，调用方看到的才是真实终态（idle）。
    if (this._status !== 'done' && this._status !== 'blocked') this._status = 'idle'
    this._clearAllTimers()
    this._abortAll()
    this._pending.clear()
    this._completing.clear()
    this._handlerResults.clear()
    this._pendingHandlerErrors.clear()
    this._pendingConditionErrors.clear()
    this._startedAt.clear()

    const engine = this._engine
    if (engine?.execution?.isRunning) {
      try {
        await withTimeout(engine.stop(), STOP_TIMEOUT_MS)
      } catch {
        // 引擎没能优雅停下不算致命：状态已经收成 idle，调用方可以继续用 state 恢复。
      }
    }
    this._finishSettle(this._status)
    ACTIVE.delete(this.instanceId)
    this._stopping = false
    return undefined
  }

  // -------------------------------------------------------------------------
  // 构造期校验
  // -------------------------------------------------------------------------

  /** 坑 6：agent / http 节点必须有 handler，否则引擎会在跑到那里时 fatal（启动前就报）。 */
  _assertHandlers(rawServices) {
    const services = isPlainObject(rawServices) ? rawServices : {}
    for (const element of this.definition.elements) {
      if (element.kind === 'agent' && typeof services.executeAgent !== 'function') {
        throw new BpmnRunnerError(
          'BPMN_HANDLER_MISSING',
          `节点 ${element.id} 是 agent，但 services.executeAgent 未提供（引擎跑到这里会 fatal <${element.id}> service not defined）`,
          { elementId: element.id, instanceId: this.instanceId }
        )
      }
      if (element.kind === 'http' && typeof services.executeHttp !== 'function') {
        throw new BpmnRunnerError(
          'BPMN_HANDLER_MISSING',
          `节点 ${element.id} 是 http，但 services.executeHttp 未提供（引擎跑到这里会 fatal <${element.id}> service not defined）`,
          { elementId: element.id, instanceId: this.instanceId }
        )
      }
    }
  }

  // -------------------------------------------------------------------------
  // 引擎与监听器
  // -------------------------------------------------------------------------

  /**
   * 新 Engine（每次 start / recover 都是新的，绝不复用上一轮的对象）。
   *
   * 关键选项的理由：
   *   - `extensions`：在**运行期**挂 `behaviour.Service`（坑 f：`extendFn` 在 recover
   *     路径上不生效，靠它挂的 handler 恢复后会消失）；
   *   - `scripts`：把条件求值接管成 FEEL（坑 b/c）；
   *   - `settings.assignOutput:'id'`：让未被我们 extension 覆盖的活动（userTask 等）
   *     把输出写进 `environment.output[id]`；
   *   - `variables`：初始变量（运行期账本仍是 `this.variables`，坑 5）。
   */
  _createEngine() {
    const runner = this
    /**
     * `elements` 是 bpmn-engine 的元素构造注入点（`TypeResolver({...Elements, ...opts.elements})`）。
     * 包住 `SequenceFlow` 的**原 `take`**：在发布 take、推动目标之前统一检查并预占
     * `flowTakes`——覆盖条件边、默认边、无条件边（依赖源码与全局 prototype 都不改）。
     *
     * @param {object} flowDef 序列化后的连线定义
     * @param {object} context Elements.Context
     */
    function RunnerSequenceFlow(flowDef, context) {
      const flow = new SequenceFlow(flowDef, context)
      flow.take = function take(content) {
        return runner._takeSequenceFlow(flow, content)
      }
      return flow
    }
    RunnerSequenceFlow.prototype = SequenceFlow.prototype

    const engine = new Engine({
      name: `${this.definition.id}:${this.instanceId}`,
      source: this.sourceXml,
      variables: { ...this.variables },
      settings: { assignOutput: 'id' },
      extensions: { dshRunner: (activity) => this._extendActivity(activity) },
      scripts: this._scriptsAdapter(),
      // 内置表达式入口设为拒绝：白名单已经挡住条件事件/标准循环/实现表达式，
      // 这层保证「即使漏了某个入口」，引擎也不会用内置 resolveExpression 求值。
      expressions: this._rejectExpressions,
      elements: { SequenceFlow: RunnerSequenceFlow },
    })
    return engine
  }

  /**
   * 确认拒绝型表达式解析器在 `Environment.clone()` / `recover()` 之后仍在
   * （引擎在 clone 时显式带 `expressions`，recover 只合并变量/输出，不会替换它）。
   */
  _assertEngineExpressionsGuarded() {
    const environment = this._engine?.environment
    if (!environment) {
      throw new BpmnRunnerError('BPMN_OPTIONS_INVALID', '引擎没有 environment，无法确认内置表达式已被拒绝', {
        instanceId: this.instanceId,
      })
    }
    if (environment.expressions?.resolveExpression !== this._rejectExpressions.resolveExpression) {
      throw new BpmnRunnerError(
        'BPMN_BUILTIN_EXPRESSION_FORBIDDEN',
        '引擎的 expressions.resolveExpression 不是拒绝型解析器：内置表达式入口没有被封闭',
        { instanceId: this.instanceId }
      )
    }
    this._expressionsGuardChecked = true
  }

  /** 恢复后逐个定义环境再查一遍（每个 Definition 的 environment 都是 clone 出来的）。 */
  _assertDefinitionExpressionsGuarded() {
    const definitions = this._engine?.execution?.definitions
    if (!Array.isArray(definitions) || definitions.length === 0) return
    for (const definition of definitions) {
      const environment = definition?.environment
      if (!environment) continue
      if (environment.expressions?.resolveExpression !== this._rejectExpressions.resolveExpression) {
        throw new BpmnRunnerError(
          'BPMN_BUILTIN_EXPRESSION_FORBIDDEN',
          '定义环境的 expressions.resolveExpression 不是拒绝型解析器：clone/recover 把防线丢了',
          { instanceId: this.instanceId }
        )
      }
    }
    this._expressionsGuardChecked = true
  }

  /**
   * 给 serviceTask 挂 handler。
   *
   * 返回非空对象会让引擎认为「这个活动已经有用户 extension」，于是不挂内置
   * OutputExtension（坑 e）——所以 serviceTask 的输出由 `_syncEngineOutput` 自己写。
   *
   * @param {any} activity
   * @returns {{} | undefined}
   */
  _extendActivity(activity) {
    if (activity?.type !== 'bpmn:ServiceTask') return undefined
    const runner = this
    activity.behaviour.Service = class RunnerService {
      constructor(elementActivity) {
        this.activity = elementActivity
      }

      execute(message, callback) {
        this.executionId = message?.content?.executionId
        runner._runServiceTask(this.activity, message, callback)
      }

      /** 引擎侧 stop/discard：abort 这个活动的 handler（坑 9，按活动执行 id 定位）。 */
      stop() {
        runner._abortActivity(this.executionId)
      }

      discard() {
        runner._abortActivity(this.executionId)
      }
    }
    return {}
  }

  /**
   * 条件脚本适配器（坑 b/c）：FEEL 交给本模块，其余语言**显式失败**。
   *
   * `getScript(language, activity)` 被两处调用：
   *   - `SequenceFlow.getCondition()`：语言来自 `conditionExpression.language`；
   *   - `ScriptTaskBehaviour.execute()`：语言来自 `scriptFormat`。
   * 两者都不支持 javascript —— 直接给一个会抛错的脚本，让引擎 fatal（响亮），
   * 而不是退化成「字符串恒真」（研究 §5 实测的静默错误）。
   */
  _scriptsAdapter() {
    const runner = this
    /** 明确失败的脚本对象（**绝不返回 undefined**——那会触发引擎内置表达式 fallback）。 */
    const failingScript = (error) => ({
      execute(scope, callback) {
        callback(error)
      },
    })
    return {
      register() {},
      getScript(language, activity) {
        const activityType = activity?.type
        const condition = activity?.behaviour?.conditionExpression
        if (activityType !== 'bpmn:SequenceFlow' || !condition) {
          // 只有 sequenceFlow 的条件由我们接管；scriptTask / 条件事件定义 / 其它脚本
          // 一律明确失败，不能返回 undefined 让引擎退回内置表达式。
          return failingScript(new BpmnRunnerError(
            'BPMN_SCRIPT_UNSUPPORTED',
            `活动 ${activity?.id ?? '?'} 使用了脚本/非连线条件（${language || '无 language'}）；执行器只支持 sequenceFlow 的 FEEL 条件表达式`,
            { elementId: activity?.id }
          ))
        }
        const normalizedLanguage = typeof language === 'string' ? language.trim().toLowerCase() : ''
        if (normalizedLanguage !== '' && !isFeelLanguage(normalizedLanguage)) {
          return failingScript(new BpmnRunnerError(
            'BPMN_CONDITION_LANGUAGE_UNSUPPORTED',
            `连线 ${activity?.id ?? '?'} 的条件语言是 ${normalizedLanguage}；只支持 FEEL（javascript 走 node:vm，实测可逃逸到 process）`,
            { elementId: activity?.id }
          ))
        }
        return {
          execute(scope, callback) {
            runner._evaluateFlowCondition(scope, activity, callback)
          },
        }
      },
    }
  }

  /**
   * 真正求值一条连线条件（**本模块求值，内置表达式引擎不参与**）。
   *
   * 结果必须是布尔；`${...}` 这类引擎内置表达式语法直接拒绝，因为一旦把条件交回引擎，
   * 就等于把「路径解析 → 恒真」的风险放回来（研究 §5）。
   */
  _evaluateFlowCondition(scope, activity, callback) {
    const conditionExpression = activity?.behaviour?.conditionExpression
    const body = typeof conditionExpression?.body === 'string' ? conditionExpression.body.trim() : ''
    const flowId = typeof activity?.id === 'string' ? activity.id : null
    const content = isPlainObject(scope?.content) ? scope.content : {}
    const failWith = (error) => {
      const structured = asRunnerError(error, 'BPMN_CONDITION_INVALID', { elementId: flowId ?? undefined })
      const sourceExecutionId = typeof content.executionId === 'string' ? content.executionId : null
      if (sourceExecutionId !== null) this._pendingConditionErrors.set(sourceExecutionId, structured)
      callback(structured)
    }
    const done = (value) => {
      // 条件只判真假；连线次数上限 / 循环护栏的唯一权威在 SequenceFlow.take 之前
      // （`_takeSequenceFlow`）——那里覆盖条件边、默认边、无条件边。
      const decided = this._assertConditionBoolean(value, flowId, body)
      if (flowId !== null) this._evaluatedConditions.set(flowId, { expression: body, value: decided })
      callback(null, decided)
    }

    if (body === '') {
      failWith(new BpmnRunnerError(
        'BPMN_CONDITION_INVALID',
        `连线 ${flowId ?? '?'} 的 conditionExpression 是空的（要么删掉它，要么写 FEEL）`,
        { elementId: flowId ?? undefined }
      ))
      return
    }

    if (body.startsWith('${')) {
      failWith(new BpmnRunnerError(
        'BPMN_CONDITION_LANGUAGE_UNSUPPORTED',
        `连线 ${flowId ?? '?'} 用了引擎内置表达式语法 ${body}；本执行器只跑 FEEL（内置解析器只认路径，实测会把 FEEL 条件当恒真）`,
        { elementId: flowId ?? undefined }
      ))
      return
    }

    const language = typeof conditionExpression?.language === 'string' ? conditionExpression.language.trim() : ''
    if (language !== '' && !isFeelLanguage(language)) {
      failWith(new BpmnRunnerError(
        'BPMN_CONDITION_LANGUAGE_UNSUPPORTED',
        `连线 ${flowId ?? '?'} 的条件语言是 ${language}；只支持 FEEL（javascript 走 node:vm，实测可逃逸到 process）`,
        { elementId: flowId ?? undefined }
      ))
      return
    }

    let value
    try {
      value = defaultConditionValue(body, this._conditionVariables(), {
        flowId,
        from: typeof content.sourceId === 'string' ? content.sourceId : null,
        to: typeof content.targetId === 'string' ? content.targetId : null,
      })
    } catch (error) {
      failWith(error)
      return
    }
    if (isThenable(value)) {
      value.then(
        (resolved) => {
          try {
            done(this._normalizeConditionOutcome(resolved, flowId, body))
          } catch (error) {
            failWith(error)
          }
        },
        (error) => failWith(error)
      )
      return
    }
    try {
      done(this._normalizeConditionOutcome(value, flowId, body))
    } catch (error) {
      failWith(error)
    }
  }

  /**
   * `evaluateFeel()` 的结果形状是 `{ ok, value, error }`：这里解包；`ok:false` 与抛错
   * 同样处理（→ 实例写 `lastError`、runner 转 `blocked`，不静默当 false）。
   */
  _normalizeConditionOutcome(value, flowId, expression) {
    if (isPlainObject(value) && typeof value.ok === 'boolean') {
      if (!value.ok) {
        const error = value.error ?? null
        throw new BpmnRunnerError(
          'BPMN_CONDITION_INVALID',
          `连线 ${flowId ?? '?'} 的条件求值失败：${error?.message ?? '未知错误'}（${error?.code ?? 'FEEL_UNKNOWN'}）`,
          { elementId: flowId ?? undefined, expression, feelErrorCode: error?.code ?? null }
        )
      }
      return value.value
    }
    return value
  }

  /**
   * 条件结果必须是布尔（坑 c：feelin 返回 `{value,warnings}` 会被当恒真；非布尔一律报错）。
   */
  _assertConditionBoolean(value, flowId, expression) {
    if (typeof value === 'boolean') return value
    const wrapped = isPlainObject(value) && typeof value.value === 'boolean' ? value.value : null
    if (wrapped !== null) return wrapped
    throw new BpmnRunnerError(
      'BPMN_CONDITION_NOT_BOOLEAN',
      `连线 ${flowId ?? '?'} 的条件 ${expression === '' ? '（空）' : expression} 求值结果不是布尔值（${value === null ? 'null' : typeof value}）；拒绝按真值处理（防「恒真」）`,
      { elementId: flowId ?? undefined }
    )
  }

  /**
   * 坑 1/2：活动事件只从 listener 出来。这里一个 EventEmitter 收全部需要的 routing key，
   * 绝不依赖 `engine.on('activity.*')`。
   */
  _attachListener() {
    const listener = new EventEmitter()
    listener.on('process.start', (api) => this._onProcessStart(api))
    listener.on('process.end', (api) => this._onProcessEnd(api))
    listener.on('activity.start', (api) => this._onActivityStart(api))
    listener.on('activity.end', (api) => this._onActivityEnd(api))
    listener.on('activity.wait', (api) => this._onActivityWait(api))
    listener.on('flow.take', (api) => this._onFlowTake(api))
    listener.on('activity.error', (api) => this._onActivityError(api))
    listener.on('process.error', (api) => this._onProcessError(api))
    return listener
  }

  // -------------------------------------------------------------------------
  // 引擎事件 → 统一事件 / 待办 / 快照
  // -------------------------------------------------------------------------

  _onProcessStart(api) {
    if (this._evicted || this._stopping || this._fatal !== null) return
    this._sawRun = true
    const content = isPlainObject(api?.content) ? api.content : {}
    this._status = 'running'
    this._emit({
      type: 'process/start',
      at: nowIso(),
      elementId: typeof content.id === 'string' ? content.id : this.definition.id,
      activityId: typeof content.executionId === 'string' ? content.executionId : undefined,
    })
    this._scheduleSettle()
  }

  _onActivityStart(api) {
    // blocked 之后不得再出现 activity/start（审查实测的回归点）。
    if (this._evicted || this._stopping || this._fatal !== null) return
    this._sawRun = true
    const content = isPlainObject(api?.content) ? api.content : {}
    const elementId = typeof content.id === 'string' ? content.id : null
    const executionId = typeof content.executionId === 'string' ? content.executionId : null
    if (elementId !== null) {
      this._attempts.set(elementId, (this._attempts.get(elementId) ?? 0) + 1)
    }
    if (executionId !== null) {
      this._startedAt.set(executionId, Date.now())
      this._armActivityTimer(executionId, elementId)
    }
    this._emit({
      type: 'activity/start',
      at: nowIso(),
      elementId: elementId ?? undefined,
      activityId: executionId ?? undefined,
    })
  }

  _onActivityEnd(api) {
    // 终态/停止之后到达的 activity/end：不合并输出、不发事件、不回调 onTaskDone。
    if (this._evicted || this._stopping || this._fatal !== null) return
    const content = isPlainObject(api?.content) ? api.content : {}
    const elementId = typeof content.id === 'string' ? content.id : null
    const executionId = typeof content.executionId === 'string' ? content.executionId : null
    const output = content.output
    const handlerResult = executionId === null ? null : this._handlerResults.get(executionId) ?? null
    if (executionId !== null) {
      this._handlerResults.delete(executionId)
      this._clearActivityTimer(executionId)
      this._activityAborts.delete(executionId)
    }

    const completedTask = executionId === null ? null : this._completing.get(executionId) ?? null
    if (completedTask !== null) this._completing.delete(executionId)

    const startedAt = executionId === null ? null : this._startedAt.get(executionId) ?? null
    if (executionId !== null) this._startedAt.delete(executionId)
    const since = completedTask?.since ? Date.parse(completedTask.since) : null
    const durationMs = startedAt !== null
      ? Math.max(0, Date.now() - startedAt)
      : since !== null && Number.isFinite(since)
        ? Math.max(0, Date.now() - since)
        : null

    // 输出写回：变量账本（条件用）+ 引擎环境（`${...}` 模板用，坑 e）。
    if (elementId !== null && output !== undefined) {
      this._mergeOutput(output, elementId)
      this._syncEngineOutput(elementId, output)
    }
    this._syncEngineVariables()

    const event = {
      type: 'activity/end',
      at: nowIso(),
      elementId: elementId ?? undefined,
      activityId: executionId ?? undefined,
      durationMs: durationMs ?? undefined,
      output,
    }
    if (handlerResult?.usage !== undefined) event.usage = handlerResult.usage
    // 可选透传（不进固定契约，消费方可忽略）：agent 的产物 / http 的响应元信息。
    if (handlerResult?.artifacts !== undefined) event.artifacts = handlerResult.artifacts
    if (handlerResult?.status !== undefined) event.status = handlerResult.status
    if (handlerResult?.headers !== undefined) event.headers = handlerResult.headers
    this._emit(event)

    if (completedTask !== null) {
      this._safeCall(this.services.onTaskDone, {
        activityId: completedTask.activityId,
        elementId: completedTask.elementId,
        name: completedTask.name,
        since: completedTask.since,
        executionId: completedTask.executionId,
        at: event.at,
        durationMs: durationMs ?? null,
        output,
      })
    }

    this._maybeAutoSnapshot(event)
    this._scheduleSettle()
  }

  _onActivityWait(api) {
    // activity/wait 不得把 blocked 改回 waiting。
    if (this._evicted || this._stopping || this._fatal !== null) return
    this._sawRun = true
    const content = isPlainObject(api?.content) ? api.content : {}
    const elementId = typeof content.id === 'string' ? content.id : null
    const executionId = typeof content.executionId === 'string' ? content.executionId : null
    if (elementId === null || executionId === null) return
    const element = this.definition.elementById.get(elementId) ?? null

    // recover 后 resume 会把同一个 executionId 的 wait 重放一遍：别重复建待办
    // （否则 onTaskWait 会被叫两次、pendingTasks 出现重复项）。
    if (!this._pending.has(executionId)) {
      const task = {
        activityId: elementId,
        elementId,
        name: element?.name ?? (typeof content.name === 'string' && content.name !== '' ? content.name : null),
        since: nowIso(),
        executionId,
        accepts: Array.isArray(content.accepts) ? [...content.accepts] : [],
      }
      this._pending.set(executionId, task)
      this._safeCall(this.services.onTaskWait, {
        activityId: task.activityId,
        elementId: task.elementId,
        name: task.name,
        since: task.since,
        executionId: task.executionId,
        accepts: [...task.accepts],
      })
    }

    // 恢复出来的 wait 没有 activity/start：这里补一次计时器（含超时）。
    this._armActivityTimer(executionId, elementId)

    this._status = 'waiting'
    const event = {
      type: 'activity/wait',
      at: nowIso(),
      elementId,
      activityId: executionId,
    }
    this._emit(event)
    this._maybeAutoSnapshot(event)
    this._scheduleSettle()
  }

  /**
   * `SequenceFlow.take` 的包装（`_createEngine` 注入）：**先检查并预占** `flowTakes`，
   * 再调用原 `take` 发布事件 / 推动目标。
   *
   * 这是连线次数上限与循环护栏的**唯一权威**：
   *   - 覆盖条件边（条件求值只判真假）、默认边（条件求值通道根本管不到）、无条件边；
   *   - 超限时返回 false 且**不调用原 take**：目标活动不会被驱动，
   *     `_fail()` 同步锁定阻塞态并 abort 在飞活动；
   *   - `_onFlowTake` 只记录「已经成功走过的边」，不再自增计数。
   *
   * @param {object} flow 引擎里的 SequenceFlow 实例
   * @param {object} content 引擎的 take 消息内容
   * @returns {boolean}
   */
  _takeSequenceFlow(flow, content) {
    const flowId = typeof flow?.id === 'string' && flow.id !== '' ? flow.id : null
    if (this._evicted || this._stopping || this._fatal !== null) return false
    const definitionFlow = flowId === null ? null : this.definition.flowById.get(flowId) ?? null
    if (flowId === null) return false

    const takes = this._flowTakes.get(flowId) ?? 0
    const attemptedTake = takes + 1
    // 两者都检查；都触发时优先报告明确的边上限（fs:maxRounds）。
    const limitError = this._flowTakeLimitError(definitionFlow, flowId, takes, attemptedTake)
    const error = limitError ?? this._loopGuardError(flowId, takes, attemptedTake)
    if (error !== null) {
      this._fail(error)
      return false
    }

    this._flowTakes.set(flowId, attemptedTake)
    try {
      return SequenceFlow.prototype.take.call(flow, content)
    } catch (cause) {
      // 原 take 失败：把预占还回去（错误本身交引擎处理）。
      if (this._flowTakes.get(flowId) === attemptedTake) this._flowTakes.set(flowId, takes)
      throw cause
    }
  }

  _flowTakeLimitError(flow, flowId, takes, attemptedTake) {
    if (!flow || flow.maxTakes === null || flow.maxTakes === undefined) return null
    if (attemptedTake <= flow.maxTakes) return null
    return new BpmnRunnerError(
      'BPMN_FLOW_TAKE_LIMIT',
      `连线 ${flowId} 已被走过 ${takes} 次，第 ${attemptedTake} 次超过 fs:maxRounds=${flow.maxTakes} 的连线次数上限`,
      {
        elementId: flowId,
        flowId,
        maxTakes: flow.maxTakes,
        takes,
        attemptedTake,
        instanceId: this.instanceId,
      }
    )
  }

  _loopGuardError(flowId, takes, attemptedTake) {
    const limit = this.loopGuardMax
    if (!(limit > 0)) return null
    if (attemptedTake <= limit) return null
    return new BpmnRunnerError(
      'BPMN_LOOP_LIMIT',
      `连线 ${flowId} 已走过 ${takes} 次，第 ${attemptedTake} 次超过循环护栏（上限 ${limit}）；疑似没有上限的成环，请给环上的连线加 fs:maxRounds 或检查条件`,
      { flowId, takes, attemptedTake, loopGuardMax: limit, instanceId: this.instanceId }
    )
  }

  /** `flow/taken` 只记录已经成功走过的边（计数已在 `_takeSequenceFlow` 预占）。 */
  _onFlowTake(api) {
    if (this._evicted || this._stopping || this._fatal !== null) return
    const content = isPlainObject(api?.content) ? api.content : {}
    const flowId = typeof content.id === 'string' ? content.id : null
    if (flowId === null) return
    const flow = this.definition.flowById.get(flowId) ?? null
    this._emit({
      type: 'flow/taken',
      at: nowIso(),
      flowId,
      from: typeof content.sourceId === 'string' ? content.sourceId : flow?.from,
      to: typeof content.targetId === 'string' ? content.targetId : flow?.to,
      // 条件：带条件的连线给 `{ expression, value }`（value 是我们求值出来的布尔，
      // 不是引擎的结果）；默认流 / 无条件流给 null。
      condition: buildFlowCondition(flow, this._evaluatedConditions.get(flowId) ?? null, content.result),
    })
  }

  _onActivityError(api) {
    if (this._evicted || this._stopping || this._fatal !== null) return
    const content = isPlainObject(api?.content) ? api.content : {}
    const executionId = typeof content.executionId === 'string' ? content.executionId : null
    const elementId = typeof content.id === 'string' ? content.id : null
    const handlerError = executionId === null ? null : this._pendingHandlerErrors.get(executionId) ?? null
    if (executionId !== null) this._pendingHandlerErrors.delete(executionId)
    const conditionError = executionId === null ? null : this._takePendingConditionError(executionId)
    const fatal = handlerError ?? conditionError ?? new BpmnRunnerError(
      'BPMN_ENGINE_ERROR',
      `活动 ${elementId ?? '?'} 失败：${errorMessageOf(content.error)}`,
      { elementId: elementId ?? undefined, activityId: executionId ?? undefined, instanceId: this.instanceId, cause: content.error }
    )
    this._fail(fatal)
  }

  _onProcessError(api) {
    if (this._evicted || this._stopping || this._fatal !== null) return
    if (this._fatal !== null) return
    const content = isPlainObject(api?.content) ? api.content : {}
    const conditionError = this._takeAnyPendingConditionError()
    if (conditionError !== null) {
      this._fail(conditionError)
      return
    }
    this._fail(new BpmnRunnerError(
      'BPMN_ENGINE_ERROR',
      `流程失败：${errorMessageOf(content.error)}`,
      {
        elementId: typeof content.id === 'string' ? content.id : undefined,
        activityId: typeof content.executionId === 'string' ? content.executionId : undefined,
        instanceId: this.instanceId,
        cause: content.error,
      }
    ))
  }

  _onProcessEnd(api) {
    if (this._evicted || this._stopping || this._fatal !== null) return
    const content = isPlainObject(api?.content) ? api.content : {}
    if (this._status !== 'blocked') this._status = 'done'
    this._clearAllTimers()
    this._emit({
      type: 'process/end',
      at: nowIso(),
      elementId: typeof content.id === 'string' ? content.id : this.definition.id,
      activityId: typeof content.executionId === 'string' ? content.executionId : undefined,
    })
    // 不在 process/end 快照（契约只允许 wait/end 两类触发点）；done 实例不需要 state。
    this._finishSettle(this._status)
  }

  /**
   * `execute(cb)` / `resume(cb)` 的兜底：引擎只在 end/stop/error 上回调。
   *
   * `generation` 是注册回调时的执行代次：stop / fail / recover / evict 之后旧代次的
   * 迟到回调一律丢弃（否则慢 handler 的晚到完成会把实例改回 done）。
   */
  _onEngineCallback(error, generation) {
    if (this._evicted) return
    if (typeof generation === 'number' && generation !== this._generation) return
    // stop() 期间引擎也会回调（stop/end）：这段窗口里的错误属于「被我们停掉」，不是失败。
    if (this._stopping) {
      this._finishSettle(this._status)
      return
    }
    if (error) {
      if (this._fatal !== null) return
      const conditionError = this._takeAnyPendingConditionError()
      this._fail(conditionError ?? asRunnerError(error, 'BPMN_ENGINE_ERROR', { instanceId: this.instanceId }))
      return
    }
    if (this._fatal !== null) return
    if (this._status !== 'done') this._status = 'done'
    this._clearAllTimers()
    this._finishSettle(this._status)
  }

  // -------------------------------------------------------------------------
  // serviceTask handler 派发
  // -------------------------------------------------------------------------

  /**
   * 引擎调 serviceTask 的入口：按 definition 里的 kind 派发给 agent / http handler。
   *
   * handler 契约见 `createBpmnRunner` 的 options 注释；`ctx.variables` 是**快照拷贝**，
   * 返回值里的 `output` 才会并回变量账本。
   */
  _runServiceTask(activity, message, callback) {
    const content = isPlainObject(message?.content) ? message.content : {}
    const elementId = typeof activity?.id === 'string' ? activity.id : null
    const executionId = typeof content.executionId === 'string' ? content.executionId : null
    const generation = this._generation

    let settled = false
    const finish = (error, output) => {
      if (settled) return
      settled = true
      // 晚到的结果（stop / fail / recover / evict 之后）不回调引擎、不写回任何状态。
      if (!this._isLive(generation)) return
      // handler 成功后立刻收掉活动计时器：活动到此完成，剩下的推进归 runTimeoutMs 管；
      // 否则「48ms 完成、50ms 计时器才到」会被判成假超时。
      if (!error && executionId !== null) this._clearActivityTimer(executionId)
      callback(error, output)
    }

    if (this._evicted || this._stopping || this._fatal !== null || !this._isLive(generation)) {
      finish(new BpmnRunnerError('BPMN_STOPPED', `实例 ${this.instanceId} 已停止/被淘汰，活动 ${elementId ?? '?'} 不再执行`, {
        elementId: elementId ?? undefined,
        activityId: executionId ?? undefined,
        instanceId: this.instanceId,
      }))
      return
    }

    const element = elementId === null ? null : this.definition.elementById.get(elementId) ?? null
    if (element === null) {
      const error = new BpmnRunnerError(
        'BPMN_UNKNOWN_ACTIVITY',
        `引擎跑了活动 ${elementId ?? '?'}，但 definition 里没有这个节点（xml 与 definition 不是同一版，或 XML 里混进了不支持的 serviceTask）`,
        { elementId: elementId ?? undefined, instanceId: this.instanceId }
      )
      finish(error)
      return
    }
    const handler = element.kind === 'agent'
      ? this.services.executeAgent
      : element.kind === 'http'
        ? this.services.executeHttp
        : null
    if (typeof handler !== 'function') {
      const error = new BpmnRunnerError(
        'BPMN_HANDLER_MISSING',
        `节点 ${element.id} 的 kind=${element.kind} 没有对应 handler（agent→executeAgent / http→executeHttp）`,
        { elementId: element.id, activityId: executionId ?? undefined, instanceId: this.instanceId }
      )
      finish(error)
      return
    }

    // 单活动计时器（坑 8）：handler 在飞时把 finish 记进计时器记录，超时直接回错误。
    if (executionId !== null) {
      const timerEntry = this._activityTimers.get(executionId)
      if (timerEntry) timerEntry.finish = (error) => finish(error)
    }

    const activityAbort = new AbortController()
    if (executionId !== null) this._activityAborts.set(executionId, activityAbort)
    const signal = combineSignals([this._instanceAbort.signal, activityAbort.signal])
    const ctx = {
      activityId: element.id,
      executionId: executionId ?? null,
      definitionId: this.definition.id,
      instanceId: this.instanceId,
      attempt: this._attempts.get(element.id) ?? 1,
      variables: { ...this.variables },
      timeoutMs: this.limits.activityWaitMs > 0 ? this.limits.activityWaitMs : null,
      signal,
    }

    let pending
    try {
      pending = handler(element, ctx)
    } catch (error) {
      this._handlerFailed(element, executionId, error, finish)
      return
    }
    Promise.resolve(pending).then(
      (result) => {
        if (!this._isLive(generation)) {
          finish(null, undefined)
          return
        }
        const normalized = normalizeHandlerResult(result)
        if (executionId !== null) this._handlerResults.set(executionId, normalized)
        for (const rawEvent of normalized.events) {
          this._emitHandlerEvent(rawEvent, element.id, executionId)
        }
        finish(null, normalized.output)
      },
      (error) => {
        if (!this._isLive(generation)) {
          finish(null, undefined)
          return
        }
        this._handlerFailed(element, executionId, error, finish)
      }
    )
  }

  /** handler 抛错：记一份自己的结构化错误（引擎的 ActivityError 会弄丢 message），再回错误。 */
  _handlerFailed(element, executionId, error, finish) {
    if (!this._isLive(this._generation)) {
      finish(null, undefined)
      return
    }
    const fatal = new BpmnRunnerError(
      'BPMN_HANDLER_FAILED',
      `节点 ${element.id} 的 handler 失败：${errorMessageOf(error)}`,
      {
        elementId: element.id,
        activityId: executionId ?? undefined,
        instanceId: this.instanceId,
        cause: error,
      }
    )
    if (executionId !== null) this._pendingHandlerErrors.set(executionId, fatal)
    finish(fatal)
  }

  // -------------------------------------------------------------------------
  // 超时 / 取消
  // -------------------------------------------------------------------------

  _armActivityTimer(executionId, elementId) {
    if (this._activityTimers.has(executionId)) return
    const waitMs = this.limits.activityWaitMs
    if (!(waitMs > 0)) return
    const entry = { timer: null, elementId: elementId ?? null, finish: null }
    entry.timer = setTimeout(() => this._onActivityTimeout(executionId), waitMs)
    this._activityTimers.set(executionId, entry)
  }

  _clearActivityTimer(executionId) {
    const entry = this._activityTimers.get(executionId)
    if (!entry) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    this._activityTimers.delete(executionId)
  }

  _clearAllTimers() {
    for (const entry of this._activityTimers.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer)
    }
    this._activityTimers.clear()
    if (this._runTimer !== null) {
      clearTimeout(this._runTimer)
      this._runTimer = null
    }
    if (this._settleTimer !== null) {
      clearTimeout(this._settleTimer)
      this._settleTimer = null
    }
  }

  _armRunTimer() {
    if (this._runTimer !== null) clearTimeout(this._runTimer)
    const runTimeoutMs = this.limits.runTimeoutMs
    if (!(runTimeoutMs > 0)) {
      this._runTimer = null
      return
    }
    this._runTimer = setTimeout(() => this._onRunTimeout(), runTimeoutMs)
  }

  _onRunTimeout() {
    if (this._evicted) return
    this._runTimer = null
    const runTimeoutMs = this.limits.runTimeoutMs
    this._fail(new BpmnRunnerError(
      'BPMN_RUN_TIMEOUT',
      `实例 ${this.instanceId} 超过 ${runTimeoutMs}ms 仍未结束（limits.runTimeoutMs）`,
      { instanceId: this.instanceId, timeoutMs: runTimeoutMs }
    ))
  }

  _onActivityTimeout(executionId) {
    if (this._evicted) return
    const entry = this._activityTimers.get(executionId)
    if (!entry) return
    this._activityTimers.delete(executionId)
    const waitMs = this.limits.activityWaitMs
    const fatal = new BpmnRunnerError(
      'BPMN_ACTIVITY_TIMEOUT',
      `活动 ${entry.elementId ?? executionId} 超过 ${waitMs}ms 未完成（limits.activityWaitMs）`,
      { elementId: entry.elementId ?? undefined, activityId: executionId, instanceId: this.instanceId, timeoutMs: waitMs }
    )
    // 先自己锁死失败态（发 error / 调 onError / 让在等的 Promise 失败），再驱动引擎失败，
    // 这样引擎侧那条错误不会盖掉我们这份更精确的错误。
    this._fail(fatal)
    if (typeof entry.finish === 'function') {
      const finish = entry.finish
      entry.finish = null
      try {
        finish(fatal)
      } catch {
        // 引擎已经收尾时回调可能抛：不影响已锁定的失败态。
      }
      return
    }
    const api = this._postponedApi(executionId)
    if (api) {
      try {
        api.fail(fatal)
      } catch {
        // 同上：引擎侧失败只是补充信号。
      }
    }
  }

  _abortActivity(activityId) {
    if (typeof activityId !== 'string' || activityId === '') return
    const controller = this._activityAborts.get(activityId)
    if (!controller) return
    try {
      controller.abort(new BpmnRunnerError('BPMN_STOPPED', '活动被取消', { activityId }))
    } catch {
      // abort 本身不该抛；包一层避免影响引擎收尾。
    }
    this._activityAborts.delete(activityId)
  }

  _abortAll() {
    try {
      this._instanceAbort.abort(new BpmnRunnerError('BPMN_STOPPED', `实例 ${this.instanceId} 被停止`, { instanceId: this.instanceId }))
    } catch {
      // 同上。
    }
    for (const [executionId, controller] of this._activityAborts) {
      try {
        controller.abort(new BpmnRunnerError('BPMN_STOPPED', '活动被取消', { activityId: executionId }))
      } catch {
        // 同上。
      }
    }
    this._activityAborts.clear()
  }

  /** 失败收尾：状态、事件、onError、在等的 Promise、引擎停止（幂等）。 */
  _fail(error) {
    // 幂等：第一个 fatal 就是唯一终态；stop 期间的错误不升级成阻塞。
    if (this._fatal !== null) return this._fatal
    if (this._stopping || this._evicted) return null
    const fatal = asRunnerError(error, 'BPMN_ENGINE_ERROR', { instanceId: this.instanceId })
    this._fatal = fatal
    this._status = 'blocked'
    // 同步作废在飞 Promise 的回调（执行代次），再 abort 活动并拒绝等待者。
    this._generation += 1
    this._clearAllTimers()
    this._abortAll()
    this._pending.clear()
    this._completing.clear()
    this._handlerResults.clear()
    this._pendingHandlerErrors.clear()
    this._pendingConditionErrors.clear()
    this._startedAt.clear()
    this._emit({
      type: 'error',
      at: nowIso(),
      elementId: fatal.elementId,
      activityId: fatal.activityId,
      error: fatal.toEventPayload(),
    })
    this._safeCall(this.services.onError, fatal)
    this._failSettle(fatal)
    this._scheduleEngineStop()
    return fatal
  }

  _scheduleEngineStop() {
    if (this._engineStopScheduled) return
    this._engineStopScheduled = true
    setImmediate(() => {
      this._engineStopScheduled = false
      if (this._evicted) return
      const engine = this._engine
      if (!engine || !engine.execution?.isRunning) return
      this._stopEngineQuietly()
    })
  }

  _stopEngineQuietly() {
    const engine = this._engine
    if (!engine) return
    try {
      const stopping = engine.stop()
      if (isThenable(stopping)) stopping.catch(() => {})
    } catch {
      // 引擎已经死了 / 已停止：没有再要做的。
    }
  }

  _takePendingConditionError(executionId) {
    const error = this._pendingConditionErrors.get(executionId)
    if (!error) return null
    this._pendingConditionErrors.delete(executionId)
    return error
  }

  _takeAnyPendingConditionError() {
    if (this._pendingConditionErrors.size === 0) return null
    const [error] = this._pendingConditionErrors.values()
    this._pendingConditionErrors.clear()
    return error
  }

  _postponedApi(executionId) {
    const execution = this._engine?.execution
    if (!execution || typeof execution.getPostponed !== 'function') return null
    for (const api of execution.getPostponed()) {
      if (isPlainObject(api?.content) && api.content.executionId === executionId) return api
    }
    return null
  }

  // -------------------------------------------------------------------------
  // 静默判定 / settle / 快照
  // -------------------------------------------------------------------------

  /**
   * 等「跑到第一个等待点或结束」。
   *
   * 坑 a：`execute()` 的 Promise 立刻 resolve，所以只能靠 `activityStatus` 判定静默：
   *   - `wait` → 停在等待点，返回 `{ state: 'waiting' }`；
   *   - `executing` / 刚启动还没事件 → 继续等；
   *   - 引擎不再 running 且已经见过事件 → 收尾（done/idle）。
   * 判定前先等挂着的快照完成，保证调用方拿到的 state 是最新的。
   */
  async _checkQuiescent() {
    if (this._checkingSettle) return
    this._checkingSettle = true
    try {
      if (this._deferred === null) return
      if (this._fatal !== null) return
      if (this._shouldFinishSettle()) {
        this._finishSettle(this._status)
        return
      }
      await this._snapshotChain.catch(() => {})
      if (this._deferred === null || this._fatal !== null) return
      if (this._shouldFinishSettle()) {
        this._finishSettle(this._status)
        return
      }
      this._retrySettle()
    } finally {
      this._checkingSettle = false
    }
  }

  _shouldFinishSettle() {
    if (this._status === 'done' || this._status === 'blocked') return true
    const execution = this._engine?.execution
    if (!execution) return false
    if (execution.isRunning) {
      if (this._engine.activityStatus === 'wait') {
        this._status = 'waiting'
        return true
      }
      return false
    }
    // 引擎停了但没收到 process.end（被外部 stop / 没有可执行流程）：只认「已经开始过」。
    if (!this._sawRun) return false
    this._status = this._pending.size > 0 ? 'waiting' : 'idle'
    return true
  }

  _retrySettle() {
    if (this._settleChecks >= MAX_SETTLE_CHECKS) {
      this._status = this._pending.size > 0 ? 'waiting' : 'running'
      this._finishSettle(this._status)
      return
    }
    this._settleChecks += 1
    const delay = this._settleChecks <= SETTLE_FAST_CHECKS ? SETTLE_FAST_MS : SETTLE_SLOW_MS
    if (this._settleTimer !== null) clearTimeout(this._settleTimer)
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null
      void this._checkQuiescent().catch(() => {})
    }, delay)
  }

  _scheduleSettle() {
    if (this._deferred === null) return
    if (this._settleTimer !== null) return
    this._settleChecks = 0
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null
      void this._checkQuiescent().catch(() => {})
    }, 0)
  }

  _wait() {
    if (this._deferred !== null) return this._deferred.promise
    let resolve
    let fail
    const promise = new Promise((res, rej) => {
      resolve = res
      fail = rej
    })
    this._deferred = { promise, resolve, fail }
    return promise
  }

  _finishSettle(state) {
    if (this._settleTimer !== null) {
      clearTimeout(this._settleTimer)
      this._settleTimer = null
    }
    const deferred = this._deferred
    this._deferred = null
    if (deferred !== null) deferred.resolve({ state })
  }

  _failSettle(error) {
    if (this._settleTimer !== null) {
      clearTimeout(this._settleTimer)
      this._settleTimer = null
    }
    const deferred = this._deferred
    this._deferred = null
    if (deferred !== null) deferred.fail(error)
  }

  /** 坑 3：只在 wait/end 之后、且 shouldSnapshot 同意时取快照；串行化避免并发取。 */
  _maybeAutoSnapshot(event) {
    if (!SNAPSHOT_TRIGGERS.has(event.type)) return
    this._snapshotChain = this._snapshotChain
      .then(() => this._autoSnapshot(event))
      .catch(() => {})
  }

  async _autoSnapshot(event) {
    if (this._evicted || this._engine === null) return
    const hook = this.shouldSnapshotHook
    if (hook !== null) {
      let decision
      try {
        decision = hook(event)
        if (isThenable(decision)) decision = await decision
      } catch {
        // 去抖钩子自己抛错不能丢状态：退回「照常快照」，但绝不让异常打断引擎推进。
        decision = true
      }
      if (!decision) return
    }
    await this._snapshotNow('auto', event.type)
  }

  async _snapshotNow(trigger, eventType) {
    const engine = this._engine
    if (engine === null) return cloneJson(this._buildEnvelope(null, trigger, eventType), 'BPMN_STATE_UNSERIALIZABLE', 'state')
    let engineState
    try {
      engineState = await engine.getState()
    } catch (error) {
      throw new BpmnRunnerError('BPMN_STATE_FAILED', `取引擎状态失败：${errorMessageOf(error)}`, {
        instanceId: this.instanceId,
        cause: error,
      })
    }
    const envelope = this._buildEnvelope(engineState, trigger, eventType)
    const cloned = cloneJson(envelope, 'BPMN_STATE_UNSERIALIZABLE', 'state')
    this._lastState = cloned
    return cloneJson(cloned, 'BPMN_STATE_UNSERIALIZABLE', 'state')
  }

  _buildEnvelope(engineState, trigger, eventType) {
    return {
      v: STATE_VERSION,
      kind: STATE_KIND,
      // 身份：definitionId 是存储域定义 id，processId 才是 XML process.id；
      // definitionHash 是执行 XML 原文的 sha256（runtime 从实例快照重算，不信请求自报）。
      definitionId: this.identity.id,
      version: this.identity.version,
      definitionHash: this.identity.hash,
      processId: this.definition.id,
      instanceId: this.instanceId,
      sourceHash: this._sourceHash,
      engineVersion: typeof engineState?.engineVersion === 'string' ? engineState.engineVersion : null,
      status: this._status,
      takenAt: nowIso(),
      trigger: trigger ?? 'explicit',
      ...(typeof eventType === 'string' ? { triggerEvent: eventType } : {}),
      variables: { ...this.variables },
      pendingTasks: this.pendingTasks(),
      // 连线次数上限 / 循环护栏的计数：随快照走，恢复后继续生效。
      attempts: [...this._attempts.entries()],
      flowTakes: [...this._flowTakes.entries()],
      warnings: [...this.warnings],
      engine: engineState ?? null,
    }
  }

  // -------------------------------------------------------------------------
  // 事件输出
  // -------------------------------------------------------------------------

  /** runner 自己生成的事件：type 必在白名单里，字段按契约逐个构造（别乱加）。 */
  _emit(event) {
    if (!EVENT_TYPES.includes(event.type)) return
    if (this._evicted) return
    // 阻塞之后只允许 error 事件本身（事实留痕），其余事件不能再出现。
    if (this._fatal !== null && event.type !== 'error') return
    this._safeCall(this.services.onEvent, event)
  }

  /** handler 通过 `events[]` 上报的适配器事件：原样透传，只补 at/elementId/activityId。 */
  _emitHandlerEvent(rawEvent, elementId, executionId) {
    if (this._evicted || this._stopping || this._fatal !== null) return
    if (!isPlainObject(rawEvent) || typeof rawEvent.type !== 'string' || rawEvent.type === '') return
    // 保留类型只能由 runner 发（否则事件流里会出现两条 process/end / 假 error）。
    if (EVENT_TYPES.includes(rawEvent.type)) return
    const event = { ...rawEvent }
    if (typeof event.at !== 'string' || event.at === '') event.at = nowIso()
    if (event.elementId === undefined) event.elementId = elementId
    if (event.activityId === undefined && executionId !== null) event.activityId = executionId
    this._safeCall(this.services.onEvent, event)
  }

  /** 回调抛错不能把引擎推进打断（事件流是观测面，不是控制面）。 */
  _safeCall(fn, arg) {
    if (typeof fn !== 'function') return
    try {
      fn(arg)
    } catch {
      // 观测面抛错：吞掉，引擎继续跑。
    }
  }

  // -------------------------------------------------------------------------
  // 变量账本
  // -------------------------------------------------------------------------

  /** 条件求值用的变量视图：**只**来自本实例账本（坑 5 / d，不读引擎环境变量）。 */
  _conditionVariables() {
    return { ...this.variables }
  }

  /** 活动输出并入账本：对象按 key 合并（扁平常量），标量/数组以活动 id 为 key。 */
  _mergeOutput(output, elementId) {
    if (this._fatal !== null || this._stopping || this._evicted) return
    if (output === undefined) return
    if (isPlainObject(output)) {
      Object.assign(this.variables, output)
      return
    }
    if (typeof elementId === 'string' && elementId !== '') {
      this.variables[elementId] = output
    }
  }

  /** 把账本写进引擎环境（`${...}` 模板 / 引擎侧表达式用）；失败不影响运行。 */
  _syncEngineVariables() {
    if (this._fatal !== null || this._stopping || this._evicted) return
    const environment = this._definitionEnvironment()
    if (!environment) return
    const variables = environment.variables
    if (!isPlainObject(variables)) return
    for (const [key, value] of Object.entries(this.variables)) variables[key] = value
  }

  /** 坑 e：serviceTask 没挂内置 OutputExtension，自己补 `environment.output[id]`。 */
  _syncEngineOutput(elementId, output) {
    if (this._fatal !== null || this._stopping || this._evicted) return
    const environment = this._definitionEnvironment()
    if (!environment) return
    const target = environment.output
    if (!isPlainObject(target)) return
    try {
      target[elementId] = output
    } catch {
      // 只读环境（理论上不会）就跳过：变量账本已经拿到同一份输出。
    }
  }

  _definitionEnvironment() {
    const definitions = this._engine?.execution?.definitions
    if (!Array.isArray(definitions) || definitions.length === 0) return null
    const definition = definitions[0]
    return definition?.environment ?? null
  }

  // -------------------------------------------------------------------------
  // 待办 / 状态辅助
  // -------------------------------------------------------------------------

  _findPendingTask({ activityId, executionId }) {
    if (executionId !== null) {
      const exact = this._pending.get(executionId)
      if (exact) return exact
    }
    if (activityId !== null) {
      const matches = [...this._pending.values()].filter((task) => task.elementId === activityId)
      if (matches.length === 1) return matches[0]
      if (matches.length > 1) {
        throw new BpmnRunnerError(
          'BPMN_TASK_AMBIGUOUS',
          `活动 ${activityId} 同时有 ${matches.length} 个在等待的执行（成环/并行）；请改传 executionId：${matches.map((task) => task.executionId).join('、')}`,
          { elementId: activityId, instanceId: this.instanceId }
        )
      }
    }
    return null
  }

  _assertUsable(action) {
    if (this._evicted) {
      throw new BpmnRunnerError(
        'BPMN_INSTANCE_EVICTED',
        `实例 ${this.instanceId} 已从活跃实例表淘汰（state 已由上次 getState() 落过）；${action} 只能用新实例通过 recover(state) 继续`,
        { instanceId: this.instanceId }
      )
    }
  }

  /** 坑 7：能被淘汰 = 已落过 state / 终态 / 从未启动（没有东西可丢）。 */
  _canEvict() {
    if (this._status === 'done' || this._status === 'blocked') return true
    if (!this._started) return true
    return this._lastState !== null
  }

  _markEvicted() {
    if (this._evicted) return
    this._evicted = true
    this._generation += 1
    this._clearAllTimers()
    this._abortAll()
    this._pending.clear()
    this._completing.clear()
    this._handlerResults.clear()
    this._pendingHandlerErrors.clear()
    this._pendingConditionErrors.clear()
    this._startedAt.clear()
    this._status = 'idle'
    const engine = this._engine
    this._engine = null
    this._listener = null
    this._failSettle(new BpmnRunnerError(
      'BPMN_INSTANCE_EVICTED',
      `实例 ${this.instanceId} 在等待期间被 LRU 淘汰`,
      { instanceId: this.instanceId }
    ))
    if (engine) {
      try {
        const stopping = engine.execution?.isRunning ? engine.stop() : null
        if (isThenable(stopping)) stopping.catch(() => {})
      } catch {
        // 淘汰是清理动作，停不下来也不该让注册流程失败（引擎对象马上就没引用了）。
      }
    }
  }
}

// ---------------------------------------------------------------------------
// options 归一化
// ---------------------------------------------------------------------------

function normalizeXml(xml) {
  if (xml === undefined || xml === null) return null
  if (typeof xml !== 'string' && !Buffer.isBuffer(xml)) {
    throw new BpmnRunnerError('BPMN_OPTIONS_INVALID', 'options.xml 必须是字符串或 Buffer', {})
  }
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : xml
  if (text.trim() === '') {
    throw new BpmnRunnerError('BPMN_OPTIONS_INVALID', 'options.xml 是空字符串', {})
  }
  return text
}

function normalizeServices(raw) {
  const services = isPlainObject(raw) ? raw : {}
  const pick = (name) => (typeof services[name] === 'function' ? services[name] : null)
  return {
    executeAgent: pick('executeAgent'),
    executeHttp: pick('executeHttp'),
    onEvent: pick('onEvent'),
    onTaskWait: pick('onTaskWait'),
    onTaskDone: pick('onTaskDone'),
    onError: pick('onError'),
  }
}

function normalizeLimits(raw) {
  const limits = isPlainObject(raw) ? raw : {}
  return {
    activityWaitMs: normalizeDuration(limits.activityWaitMs, 'limits.activityWaitMs'),
    runTimeoutMs: normalizeDuration(limits.runTimeoutMs, 'limits.runTimeoutMs'),
  }
}

function normalizeDuration(value, label) {
  if (value === undefined || value === null || value === 0) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BpmnRunnerError('BPMN_OPTIONS_INVALID', `${label} 必须是 ≥0 的毫秒数（0 = 不设限）`, {})
  }
  return Math.floor(value)
}

function normalizeMaxActive(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new BpmnRunnerError('BPMN_OPTIONS_INVALID', 'options.maxActiveInstances 必须是 ≥1 的安全整数', {})
  }
  return value
}

/** 循环护栏上限：≥0 的安全整数，缺省 1000，0 = 关闭。 */
function normalizeLoopGuardMax(value) {
  if (value === undefined || value === null) return DEFAULT_LOOP_GUARD_MAX
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BpmnRunnerError('BPMN_OPTIONS_INVALID', 'options.loopGuardMax 必须是 ≥0 的整数（0 = 关闭循环护栏）', {})
  }
  return value
}

/** 从快照的 `[[key, count], …]` 还原计数表（坏形状一律忽略，不让恢复失败）。 */
function restoreCounts(raw) {
  const counts = new Map()
  if (!Array.isArray(raw)) return counts
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue
    const [key, value] = entry
    if (typeof key !== 'string' || !Number.isSafeInteger(value) || value < 0) continue
    counts.set(key, value)
  }
  return counts
}

/** handler 返回值归一化（允许直接返回 output、允许 undefined）。 */
function normalizeHandlerResult(result) {
  const normalized = { output: undefined, usage: undefined, artifacts: undefined, status: undefined, headers: undefined, events: [] }
  if (result === undefined || result === null) return normalized
  if (!isPlainObject(result)) {
    normalized.output = result
    return normalized
  }
  if (result.output !== undefined) normalized.output = result.output
  if (isPlainObject(result.usage)) normalized.usage = { ...result.usage }
  if (Array.isArray(result.artifacts)) normalized.artifacts = [...result.artifacts]
  if (typeof result.status === 'number' || typeof result.status === 'string') normalized.status = result.status
  if (isPlainObject(result.headers)) normalized.headers = { ...result.headers }
  if (Array.isArray(result.events)) normalized.events = result.events
  return normalized
}

/** 引擎 flow 求值结果 → 布尔 / undefined（`true` 或 `{ value }`，别把对象当条件结果透出去）。 */
function normalizeFlowResult(result) {
  if (typeof result === 'boolean') return result
  if (isPlainObject(result) && typeof result.value === 'boolean') return result.value
  return undefined
}

/**
 * `flow/taken` 的 `condition` 字段：
 *   - 我们求过值 → `{ expression, value }`（value 是布尔）；
 *   - definition 里带条件但没走我们的求值（理论上不会发生）→ 用 definition 的原文 + 引擎结果；
 *   - 默认流 / 无条件流 → null。
 */
function buildFlowCondition(flow, evaluated, engineResult) {
  if (evaluated && typeof evaluated.expression === 'string') {
    return { expression: evaluated.expression, value: evaluated.value === true }
  }
  if (flow && flow.condition && typeof flow.condition.expression === 'string') {
    const value = normalizeFlowResult(engineResult)
    return { expression: flow.condition.expression, value: value === undefined ? null : value }
  }
  return null
}
