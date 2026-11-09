/**
 * 冷会话 resume 的 preset 组合挂载（0.12.1 P0 修正）。
 *
 * 踩坑结论（改这块前先看宿主源码）：
 *   - `meta.agentPreset` / `session.header.agentPreset` **只写 header**，宿主的
 *     `initializeAgent` 不读它补挂组合（`dsh-agent-loop` 的 initializeAgent）；
 *   - 组合**只在** `agents.create()` / `agents.resume()` 的 `setup` 回调里挂载
 *     （`dsh-agent-loop/lib/index.js`：`setup?.(agent.ctx, agent)`，此刻
 *     `agent.ctx.sessions.enter(session)` 已执行，`agent.session` 就是恢复出来的会话）；
 *   - 不传 `setup` 的冷 resume 只剩宿主层插件工具（blog_* / flow_* / …），
 *     bash / read / write / edit / subagent 全部「unknown tool」。
 *
 * 线上事故：supervision 唤醒冷会话时调用 `agents.resume({ resumeSessionId })` 没带
 * setup，会话被冷恢复后 request/header 只有 37 个宿主插件工具、随后推 31 条
 * tool-removal，模型每轮调 bash 都是 `Error: unknown tool "bash"`。
 *
 * 本模块把三处冷路径（supervision 唤醒 / 节点自检闹钟 / 收件箱投递）统一成一条
 * 与宿主 Web 侧同构的 resume 形状：
 *   1. **setup 回调内部**求该会话自己的有效 preset id（日志最后一条
 *      `agent-preset/selected` > `session.header.agentPreset` > 宿主默认）；
 *   2. `sessionController.composeAgent(presetId)` 拿组合并调用它的 `setup`（Web 同一条
 *      路径）；没有 sessionController 退回 `agentPresets.resolve` + `mount`；
 *   3. 组合挂载失败一律**降级不致命**：先 warn + 退回宿主默认，再失败再 warn 并让
 *      这次 resume 照常完成（绝不因为挂组合失败把唤醒 / 投递整条打死）。
 *
 * 本模块不 import 任何 `@deepseek-ai/*` 包：所有宿主能力都走 `ctx.get`，与 engine.js
 * 的 `_composeWithHostPresetServices()` 口径一致（那里**不**装 `installModelSelection`
 * 的跨包依赖，这里同样不装）。
 *
 * @module @feiyueve/dsh-flow-studio/resume
 */

/** 空实现：没有 logger 时所有 warn 静默。 */
function noopLog() {}

/** 日志实现自己抛错不该影响 resume。 */
function warnWith(log, message) {
  try {
    if (typeof log === 'function') log('warn', message)
  } catch {
    // 日志失败不该影响投递。
  }
}

function messageOf(error) {
  return error && error.message ? error.message : String(error ?? 'unknown error')
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

/**
 * 跨宿主版本读会话日志：0.1.1-rc.2 暴露 `.events`，0.1.2-rc.1 起换成
 * `snapshotEvents()`。两条线都要能读（profile 可能是任一版本），读不到就是空日志。
 *
 * @param {object | null | undefined} session 宿主 Session（或 FakeAgent 的 session）
 * @returns {object[]}
 */
function sessionLogOf(session) {
  if (!session) return []
  try {
    if (Array.isArray(session.events)) return session.events
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : []
    }
  } catch {
    // 日志读不出来按「没有日志」处理，退回 header。
  }
  return []
}

function sessionIdOf(agent) {
  const session = agent && agent.session ? agent.session : null
  if (!session) return '(未知会话)'
  return isNonEmptyString(session.id) ? session.id : '(未知会话)'
}

/**
 * 会话自己的有效 preset id：日志里**最后一条** `agent-preset/selected` 优先，
 * 其次 `session.header.agentPreset`，都没有返回 `undefined`（= 宿主默认）。
 *
 * 为什么事件优先于 header：header 只记录创建时的 stamp，会话中途换过 preset 之后
 * header 不再更新；重建时必须挂历史**实际**跑的那个组合。
 *
 * @param {{ session?: { header?: { agentPreset?: string }, events?: object[], snapshotEvents?: Function } }} agent
 * @returns {string | undefined}
 */
export function sessionPresetId(agent) {
  const session = agent && agent.session ? agent.session : null
  if (!session) return undefined
  const events = sessionLogOf(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && event.type === 'agent-preset/selected') {
      const selected = event.data && event.data.agentPreset
      return isNonEmptyString(selected) ? selected : undefined
    }
  }
  const stamp = session.header && session.header.agentPreset
  return isNonEmptyString(stamp) ? stamp : undefined
}

/** 宿主服务：拿不到 / `ctx.get` 抛错一律当未加载。 */
function serviceOf(ctx, name) {
  if (!ctx || typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * 构造 `agents.resume()` 的 `setup` 回调：在 setup 内部（`agent.session` 已恢复）
 * 求有效 preset 并挂载组合，失败按「宿主默认 → 放弃挂载但 resume 照常」降级。
 *
 * @param {object | null | undefined} ctx 宿主 Cordis ctx（插件 ctx，支持 `ctx.get`）
 * @param {(level: string, message: string) => void} [log] 插件 logger（`log('warn', …)`）
 * @returns {((agentCtx: object, agent: object) => Promise<void>) | undefined} 没有 ctx 时返回 undefined
 */
export function buildResumeSetup(ctx, log = noopLog) {
  if (!ctx) return undefined
  return async function resumeSetup(agentCtx, agent) {
    const presetId = sessionPresetId(agent)
    const sessionId = sessionIdOf(agent)
    const requested = presetId === undefined ? '(宿主默认)' : presetId
    const warn = message => warnWith(log, message)

    const sessionController = serviceOf(ctx, 'sessionController')
    if (sessionController && typeof sessionController.composeAgent === 'function') {
      // 首选：与 Web（dsh-api-session-controller）完全同一条路径。
      let failure = null
      try {
        const composition = await sessionController.composeAgent(presetId)
        if (composition && typeof composition.setup === 'function') {
          await composition.setup(agentCtx, agent)
          return
        }
        failure = new Error('composeAgent 没有返回可调用的 setup')
      } catch (error) {
        failure = error
      }
      warn(`flow-studio: 会话 ${sessionId} 的 preset「${requested}」组合挂载失败`
        + `（${messageOf(failure)}），改挂宿主默认 preset`)
      try {
        const fallback = await sessionController.composeAgent(undefined)
        if (fallback && typeof fallback.setup === 'function') {
          await fallback.setup(agentCtx, agent)
          return
        }
        failure = new Error('宿主默认 preset 也没有返回可调用的 setup')
      } catch (error) {
        failure = error
      }
      warn(`flow-studio: 会话 ${sessionId} 的宿主默认 preset 也挂载失败`
        + `（${messageOf(failure)}）；本次 resume 照常继续，该会话可能没有 preset 工具面`
        + `（bash/read/write 等可能报 unknown tool）`)
      return
    }

    const presets = serviceOf(ctx, 'agentPresets')
    if (presets && typeof presets.resolve === 'function') {
      // 次选：agentPresets.resolve(id) + mount(agentCtx, resolvedId)。
      const mountPreset = async requestedId => {
        const resolved = await presets.resolve(requestedId)
        const resolvedId = resolved && isNonEmptyString(resolved.id) ? resolved.id : requestedId
        if (typeof presets.mount !== 'function') throw new Error('agentPresets.mount 不可用')
        await presets.mount(agentCtx, resolvedId)
        return resolvedId
      }
      let failure = null
      try {
        await mountPreset(presetId)
        return
      } catch (error) {
        failure = error
      }
      warn(`flow-studio: 会话 ${sessionId} 的 preset「${requested}」组合挂载失败`
        + `（${messageOf(failure)}），改挂宿主默认 preset`)
      try {
        await mountPreset(undefined)
        return
      } catch (error) {
        failure = error
      }
      warn(`flow-studio: 会话 ${sessionId} 的宿主默认 preset 也挂载失败`
        + `（${messageOf(failure)}）；本次 resume 照常继续，该会话可能没有 preset 工具面`
        + `（bash/read/write 等可能报 unknown tool）`)
      return
    }

    // 两个服务都没有：不抛错，留一条可诊断的 warn（否则又会掉回裸工具面且无迹可查）。
    warn(`flow-studio: 宿主没有 sessionController / agentPresets 服务，会话 ${sessionId}`
      + ` 冷恢复后无法挂载 preset「${requested}」的工具面；`
      + '请升级宿主或检查 agentPresets 服务是否加载')
  }
}

/**
 * 统一的冷会话 resume：`{ resumeSessionId, agentOptions?, setup? }` → `agents.resume()`。
 *
 * 三处冷路径（runtime 的 supervision 唤醒 / 节点自检闹钟、inbox 的收件箱投递）都走
 * 这里，避免以后再各写一份 `agents.resume({ resumeSessionId })` 漏掉 setup。
 *
 * 语义：
 *   - `agentOptions` 只在有值时带上（与旧调用逐字一致）；
 *   - `setup` 由 {@link buildResumeSetup} 构造；拿不到 setup（没有 ctx）时打 warn
 *     并**不传 setup**，保持旧的「先恢复再说」行为；
 *   - `agents.resume` 不可用 → 抛错（由调用方翻译成 503 / 自己的错误文案）。
 *
 * @param {object | null | undefined} ctx 宿主 Cordis ctx
 * @param {{ resume?: Function }} agents 宿主 agents 服务
 * @param {string} sessionId 要恢复的会话 id
 * @param {{ agentOptions?: object, log?: Function }} [options]
 * @returns {Promise<{ agent?: object } & Record<string, unknown>>}
 */
export async function resumeCold(ctx, agents, sessionId, { agentOptions, log = noopLog } = {}) {
  if (!agents || typeof agents.resume !== 'function') {
    throw new Error(`会话 ${sessionId} 不在线，且 agents.resume 不可用`)
  }
  const resumeOptions = { resumeSessionId: sessionId }
  if (agentOptions) resumeOptions.agentOptions = agentOptions
  const setup = buildResumeSetup(ctx, log)
  if (typeof setup === 'function') {
    resumeOptions.setup = setup
  } else {
    warnWith(log, `flow-studio: 会话 ${sessionId} 冷恢复时构造不出 preset setup（缺少宿主 ctx），`
      + '本次不传 setup，该会话恢复后可能没有 preset 工具面')
  }
  return agents.resume(resumeOptions)
}
