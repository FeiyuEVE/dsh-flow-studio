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
 * resume 形状：
 *   1. **setup 回调内部**求该会话自己的有效 preset id：优先读宿主投影
 *      `agentPresets.presetForSession(session)`（受支持的读面，语义就是
 *      header + 最后一条 `agent-preset/selected`），投影服务缺失 / 抛错才退回兼容的
 *      日志扫描（`snapshotEvents()` / 老宿主的 `.events`）；
 *   2. 挂载走 `agentPresets.resolve` + `mount` —— 这是 0.2.2 上**唯一可达**的路径。
 *      `sessionController.composeAgent` 是 `ApiSessionAgentController` 的方法，
 *      `SessionController`（即 `ctx.get('sessionController')`）只对外暴露
 *      `resolveAgent`，所以下面那个 composeAgent 分支在生产上不可达；它只作宿主将来
 *      真把它放上 sessionController 时的兼容路径，并且**必须校验 composition.agentPreset**
 *      （无 preset 注册表的 profile 会返回 `{ setup: installModelSelection }`，
 *      setup 存在但 presetId 被静默忽略）。真要走 Web 路径请用
 *      `sessionController.resolveAgent(sessionId)`；
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
 * 注意：这是**被宿主标为「禁止新调用」的兼容读面**（`core/session` 的
 * `snapshotEvents()` / 已移除的 `.events`），只作 `presetForSession` 投影不可用时的
 * 兜底，不要在新代码里直接依赖它。
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
 * 会话自己的有效 preset id。
 *
 * 优先用宿主投影 `agentPresets.presetForSession(session)`（`string | null`）：
 * 非空字符串直接用；`null` 代表「确实没有」→ 返回 `undefined`（= 宿主默认）。
 * 只有投影服务不存在或调用抛错时，才退回兼容的日志扫描：
 * 日志里**最后一条** `agent-preset/selected` 优先，其次 `session.header.agentPreset`，
 * 都没有返回 `undefined`。
 *
 * 为什么事件优先于 header：header 只记录创建时的 stamp，会话中途换过 preset 之后
 * header 不再更新；重建时必须挂历史**实际**跑的那个组合。投影的语义与此完全一致，
 * 所以有投影时不需要再扫日志。
 *
 * @param {{ session?: { header?: { agentPreset?: string }, events?: object[], snapshotEvents?: Function } }} agent
 * @param {{ presetForSession?: (session: object) => (string | null) } | null | undefined} [presets]
 *   宿主 `agentPresets` 服务（可选；调用点应提前取出来复用）
 * @returns {string | undefined}
 */
export function sessionPresetId(agent, presets) {
  const session = agent && agent.session ? agent.session : null
  if (!session) return undefined
  if (presets && typeof presets.presetForSession === 'function') {
    try {
      const projected = presets.presetForSession(session)
      if (isNonEmptyString(projected)) return projected
      // null = 投影明确表示「该会话没有 preset」→ 宿主默认，不必再扫日志。
      if (projected === null) return undefined
    } catch {
      // 投影不可用（老宿主 / 临时故障）才退回下面的兼容扫描。
    }
  }
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
    const sessionId = sessionIdOf(agent)
    // 只取一次 agentPresets：既用于投影读 preset，也用于下面的 resolve + mount。
    const presets = serviceOf(ctx, 'agentPresets')
    const presetId = sessionPresetId(agent, presets)
    const requested = presetId === undefined ? '(宿主默认)' : presetId
    const warn = message => warnWith(log, message)

    const sessionController = serviceOf(ctx, 'sessionController')
    if (sessionController && typeof sessionController.composeAgent === 'function') {
      // 兼容分支：0.2.2 的 `SessionController` 只暴露 `resolveAgent`，没有
      // `composeAgent`（后者是 `ApiSessionAgentController` 的方法），所以这里
      // **生产上不可达**。真要沿 Web 路径恢复请用
      // `sessionController.resolveAgent(sessionId)`；保留本分支只为宿主将来改形状时
      // 能接上，而且必须防「presetId 被静默忽略」。
      let failure = null
      try {
        const composition = await sessionController.composeAgent(presetId)
        if (!composition || typeof composition.setup !== 'function') {
          failure = new Error('composeAgent 没有返回可调用的 setup')
        } else if (presetId !== undefined && !isNonEmptyString(composition.agentPreset)) {
          // 无 preset 注册表的 profile 会返回 `{ setup: installModelSelection }`：
          // setup 存在、但 presetId 被静默忽略。当成成功就又是一次「挂不上却报成功」。
          failure = new Error('composeAgent 没有返回 agentPreset，presetId 被静默忽略'
            + '（该 profile 可能没有 preset 注册表）')
        } else {
          await composition.setup(agentCtx, agent)
          return
        }
      } catch (error) {
        failure = error
      }
      const recordedNote = presetId === undefined
        ? '本次冷恢复挂的是宿主默认 preset'
        : `本次冷恢复实际挂的是宿主默认而不是记录的「${presetId}」`
      let fallbackFailure = null
      try {
        const fallback = await sessionController.composeAgent(undefined)
        if (fallback && typeof fallback.setup === 'function') {
          await fallback.setup(agentCtx, agent)
          // 降级只挂当前进程里的组合，**不写** `agent-preset/selected`：header 仍是
          // 记录的 id，所以只要那个 preset 一直不可用，每次冷唤醒都会重付一次
          // 「失败 + 降级」。
          warn(`flow-studio: 会话 ${sessionId} 的 preset「${requested}」组合挂载失败`
            + `（${messageOf(failure)}）；${recordedNote}`
            + '（降级不写 agent-preset/selected，header 与组合会持续分叉，每次冷唤醒都会重付一次失败+降级）')
          return
        }
        fallbackFailure = new Error('宿主默认 preset 也没有返回可调用的 setup')
      } catch (error) {
        fallbackFailure = error
      }
      warn(`flow-studio: 会话 ${sessionId} 的 preset「${requested}」组合挂载失败`
        + `（${messageOf(failure)}），改挂宿主默认 preset`)
      warn(`flow-studio: 会话 ${sessionId} 的宿主默认 preset 也挂载失败`
        + `（${messageOf(fallbackFailure)}）；本次 resume 照常继续，该会话可能没有 preset 工具面`
        + `（bash/read/write 等可能报 unknown tool）`)
      return
    }

    if (presets && typeof presets.resolve === 'function') {
      // 0.2.2 上唯一可达的挂载路径：agentPresets.resolve(id) + mount(agentCtx, resolvedId)。
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
      const failureNote = `flow-studio: 会话 ${sessionId} 的 preset「${requested}」组合挂载失败`
        + `（${messageOf(failure)}）`
      try {
        const fallbackId = await mountPreset(undefined)
        // 降级只挂当前进程里的组合，**不写** `agent-preset/selected`：header 仍是
        // 记录的 id，所以只要那个 preset 一直不可用，每次冷唤醒都会重付一次
        // 「失败 + 降级」。把「实际挂的是宿主默认」写进同一条 warn，便于诊断分叉。
        const actual = presetId === undefined
          ? `本次冷恢复挂的是宿主默认 preset「${fallbackId}」`
          : `本次冷恢复实际挂的是宿主默认「${fallbackId}」而不是 header 记录的「${presetId}」`
        warn(`${failureNote}，改挂宿主默认 preset；${actual}`
          + '（降级不写 agent-preset/selected，header 与组合会持续分叉，每次冷唤醒都会重付一次失败+降级）')
        return
      } catch (error) {
        failure = error
      }
      warn(`${failureNote}，改挂宿主默认 preset`)
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
 *   - `agents.resume` 抛 `SessionAlreadyOwnedError`（宿主写锁：同进程另一条路径刚把
 *     同一会话 resume 起来）时，先 `agents.get(sessionId)` 复用那个活 agent，只有拿
 *     不到才把错误原样抛出——否则 supervision 会把这个可恢复的竞态记成一次失败；
 *   - `agents.resume` 不可用 → 抛错（由调用方翻译成 503 / 自己的错误文案）。
 *
 * @param {object | null | undefined} ctx 宿主 Cordis ctx
 * @param {{ resume?: Function, get?: Function }} agents 宿主 agents 服务
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
  try {
    return await agents.resume(resumeOptions)
  } catch (error) {
    if (error && error.name === 'SessionAlreadyOwnedError') {
      // 宿主写锁互斥：同进程另一条路径可能刚把同一会话 resume 起来。拿到活 agent 就
      // 直接复用（对调用方等价于 resume 成功），拿不到再原样抛。
      const live = await liveAgentOf(agents, sessionId)
      if (live) return { agent: live }
    }
    throw error
  }
}

/** 宿主 `agents.get(sessionId)`：没有 / 抛错都当拿不到。 */
async function liveAgentOf(agents, sessionId) {
  if (!agents || typeof agents.get !== 'function') return undefined
  try {
    const live = await agents.get(sessionId)
    return live || undefined
  } catch {
    return undefined
  }
}
