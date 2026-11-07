#!/usr/bin/env node
/**
 * 状态机内核自检（08-state-machine.md §3 / §4 / §6）。
 *
 * 全部是纯函数 + 内存里的 XState actor：不起进程、不写盘、不碰 dsh。
 * 机器里的 guard / action 都是字符串名，测试用 `flowMachineImplementations(meta)`
 * 注入参考实现；其中一组专门用「假的」实现，证明编译产物真的能被 `provide` 接管。
 *
 * 只跑：node test/flowmachine.test.mjs
 *
 * ⚠️ 安全事故备忘（2026-11-07）：**不要用 A.equal / A.deepEqual 直接比较 XState 的
 * StateNode / StateMachine / TransitionDefinition**。上一版测试写了
 * `A.equal(machine.states.running.initial, 'n_a')`——XState v5 的 `.initial` 是
 * **TransitionDefinition**（不是 config 里的字符串）；断言失败后 Node 24 的
 * assert diff（inspect depth=1000 / getters=true + Myers diff）会顺着
 * `source`/`target` 遍历整张状态图，外部内存无界增长（实测 inspect 文本 27.7 MB，
 * 进程 45 秒涨到 22 GB 被 OOM）。比较方式：先压成 string / 普通对象（见
 * targetIds / actionTypes），或读 `.config.initial`。下面的 A.equal / A.deepEqual
 * 已加前置护栏，命中这类对象会立刻抛清晰错误而不是触发 Node 的 diff。
 */

import assert from 'node:assert/strict'
import { createActor } from '../src/xstate-vendor.js'
import {
  compileFlowToMachine,
  FLOW_EVENTS,
  FLOW_MACHINE_INVALID,
  FlowMachineInvalidError,
  flowMachineImplementations,
  machineEventsFromRun,
  machineVersion,
  replayMachine,
} from '../src/flowmachine.js'

let checks = 0
/** 手写断言计数（回报用）：每个 A.* 记一条。 */
let assertionCount = 0

/**
 * 识别「不能直接进 Node assert diff」的 XState 对象（只读自身/原型，不遍历）。
 * Node 24 的 assert 在失败时用 inspect(depth=1000, getters=true) 看 actual/expected，
 * 对 StateNode/TransitionDefinition 会遍历整张机器图并跑 Myers diff，内存无界。
 */
function unsafeMachineObject(value) {
  if (!value || typeof value !== 'object') return null
  const ctorName = Object.getPrototypeOf(value)?.constructor?.name
  if (ctorName === 'StateNode' || ctorName === 'StateMachine') return ctorName
  if ('eventType' in value && 'source' in value && Array.isArray(value.target)) return 'TransitionDefinition'
  return null
}

function guardUnsafeAssert(actual, expected, message) {
  const unsafe = unsafeMachineObject(actual) || unsafeMachineObject(expected)
  if (unsafe === null) return
  throw new Error(
    `拒绝直接断言 XState 的 ${unsafe}（${message || '无消息'}）：`
    + 'Node 24 的 assert diff 会遍历整张状态图导致无界内存；请先压成 string / 普通对象'
    + '（见 targetIds / actionTypes），或读 .config.initial。',
  )
}

const A = {
  equal(actual, expected, message) {
    assertionCount += 1
    guardUnsafeAssert(actual, expected, message)
    assert.equal(actual, expected, message)
  },
  deepEqual(actual, expected, message) {
    assertionCount += 1
    guardUnsafeAssert(actual, expected, message)
    assert.deepEqual(actual, expected, message)
  },
  ok(value, message) {
    assertionCount += 1
    assert.ok(value, message)
  },
  match(value, pattern, message) {
    assertionCount += 1
    assert.match(value, pattern, message)
  },
  /** 断言抛 FLOW_MACHINE_INVALID，并返回捕获到的错误（顺带回报一句文案）。 */
  throwsInvalid(fn, message) {
    assertionCount += 1
    let caught = null
    try {
      fn()
    } catch (error) {
      caught = error
    }
    assert.ok(caught, message ? `${message}（应当抛错）` : '应当抛错')
    assert.equal(caught.code, FLOW_MACHINE_INVALID, `错误码应为 ${FLOW_MACHINE_INVALID}`)
    return caught
  },
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function baseNode(id, kind, x, extra) {
  return {
    id,
    kind,
    title: `${id} 的标题`,
    x,
    y: 200,
    mode: 'single',
    role: '',
    task: '',
    outputs: '',
    skills: [],
    maxRounds: 2,
    team: [],
    model: '',
    executor: 'dsh',
    executorCommand: '',
    ...extra,
  }
}

const startNode = (x = 0) => baseNode('n_start', 'start', x)
const endNode = (x = 900, id = 'n_end') => baseNode(id, 'end', x)
const stageNode = (id, x, extra) => baseNode(id, 'stage', x, extra)

const nextEdge = (from, to) => ({ id: `next-${from}-${to}`, from, to, kind: 'next' })
const rejectEdge = (from, to) => ({ id: `reject-${from}-${to}`, from, to, kind: 'reject' })

function flowOf(nodes, edges) {
  return {
    schemaVersion: 1,
    id: 'flow-machine-test',
    name: '状态机测试流程',
    description: '',
    createdAt: '2026-11-07T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z',
    nodes,
    edges,
  }
}

/** start → n_a → n_b → n_c → end，打回边 c → a / c → b。 */
function tripleFlow(overrides = {}) {
  return flowOf(
    [
      startNode(0),
      stageNode('n_a', 200, overrides.n_a),
      stageNode('n_b', 500, overrides.n_b),
      stageNode('n_c', 800, overrides.n_c),
      endNode(1100),
    ],
    [
      nextEdge('n_start', 'n_a'),
      nextEdge('n_a', 'n_b'),
      nextEdge('n_b', 'n_c'),
      nextEdge('n_c', 'n_end'),
      rejectEdge('n_c', 'n_b'),
      rejectEdge('n_c', 'n_a'),
    ],
  )
}

/** start → n_a → n_b → end，打回 b → a（专测重跑上限）。 */
function loopFlow(aExtra) {
  return flowOf(
    [startNode(0), stageNode('n_a', 200, aExtra), stageNode('n_b', 500), endNode(800)],
    [
      nextEdge('n_start', 'n_a'),
      nextEdge('n_a', 'n_b'),
      nextEdge('n_b', 'n_end'),
      rejectEdge('n_b', 'n_a'),
    ],
  )
}

function compileAndProvide(flow, options) {
  const compiled = compileFlowToMachine(flow, options)
  const implementations = flowMachineImplementations(compiled.meta)
  const provided = compiled.machine.provide(implementations)
  return { compiled, implementations, provided }
}

/** 建 actor 并启动；默认注入参考实现，可换成假实现。 */
function startActor(compiled, implementations) {
  const provided = compiled.machine.provide(implementations || flowMachineImplementations(compiled.meta))
  const actor = createActor(provided)
  actor.start()
  return { actor, provided }
}

/** 当前阶段节点 id（在 running 里时）；终态返回 'done' / 'failed' / 'aborted'。 */
function where(actor) {
  const value = actor.getSnapshot().value
  return typeof value === 'string' ? value : value.running
}

function send(actor, type, extra = {}) {
  actor.send({ type, ...extra })
  return actor.getSnapshot()
}

/** 把 TransitionDefinition 列表压成 [目标状态 id] / [action 名]。 */
function targetIds(transitions) {
  return transitions.map(transition => transition.target.map(node => node.id).join('|'))
}

function actionTypes(transitions) {
  return transitions.map(transition => transition.actions.map(action => (action && action.type) || String(action)))
}

/**
 * 08 §6 恢复算法（这里按规格实现一遍，用来验收流机器模块给的两块积木够不够用）：
 *   1. 快照 version 与本地编译 version 一致 → `createActor(machine, { snapshot })`；
 *      若 XState 拒绝该快照（内部字段不兼容）→ 落到 2；
 *   2. 事件重放（事件流是唯一真相）；
 *   3. 重放也起不来 → `{via:'failed'}`，调用方必须把 run 收成 failed，不能假装恢复成功。
 * `via` 用来断言「版本不匹配时没有假装快照可用」。
 */
function restorePerSpec(compiled, { snapshot, snapshotVersion, events }) {
  const provided = compiled.machine.provide(flowMachineImplementations(compiled.meta))
  let restoreError = null
  if (snapshot && snapshotVersion === compiled.version) {
    const actor = createActor(provided, { snapshot })
    // XState 把恢复失败塞进 snapshot.status='error' 并通过 error 通道上报；
    // 不订阅的话它会在 setTimeout 里 rethrow，把测试进程直接带走。
    actor.subscribe({ error: error => { restoreError = error } })
    actor.start()
    if (restoreError === null && actor.getSnapshot().status === 'active') {
      return { via: 'snapshot', actor, restoreError: null, replayed: 0 }
    }
  }
  try {
    const replay = replayMachine(provided, events)
    return { via: 'replay', actor: replay.actor, restoreError, replayed: replay.replayed }
  } catch (error) {
    return { via: 'failed', actor: null, restoreError: restoreError || error, replayed: 0 }
  }
}

// ---------------------------------------------------------------------------

try {
  await check('G1：machineVersion 顺序无关、只含影响转移的字段', () => {
    const forward = tripleFlow()
    // 同一份图，节点 / 连线数组都倒着写；标题、坐标、role、skills、model、task 全部改掉。
    const shuffled = flowOf(
      [
        { ...endNode(12345), title: '换个标题', task: '换个任务' },
        {
          ...stageNode('n_c', -900, { maxRounds: 2 }),
          title: 'C 换了标题',
          role: '换角色',
          skills: ['x', 'y'],
          model: 'other-model',
          task: '另一段任务',
        },
        { ...stageNode('n_b', 42, { maxRounds: 2 }), role: 'b-role', x: 42, y: -7 },
        { ...stageNode('n_a', 777, { maxRounds: 2 }), skills: ['z'] },
        { ...startNode(-50), title: '开始换个名字' },
      ],
      [
        rejectEdge('n_c', 'n_a'),
        nextEdge('n_c', 'n_end'),
        rejectEdge('n_c', 'n_b'),
        nextEdge('n_b', 'n_c'),
        nextEdge('n_a', 'n_b'),
        nextEdge('n_start', 'n_a'),
      ],
    )
    const version = machineVersion(forward)
    A.match(version, /^[0-9a-f]{16}$/, 'version 是 16 位小写 hex')
    A.equal(machineVersion(shuffled), version, '数组顺序 / 标题 / 坐标 / role / skills / model / task 都不进哈希')

    // 加一条边 → 变。
    const withExtraReject = tripleFlow()
    withExtraReject.edges.push(rejectEdge('n_b', 'n_a'))
    A.ok(machineVersion(withExtraReject) !== version, '加一条边 version 必须变')

    // 删一条边 → 变。
    const withoutReject = tripleFlow()
    withoutReject.edges = withoutReject.edges.filter(edge => edge.id !== 'reject-n_c-n_a')
    A.ok(machineVersion(withoutReject) !== version, '删一条边 version 必须变')

    // 改 maxRounds → 变。
    const changedRounds = tripleFlow({ n_b: { maxRounds: 3 } })
    A.ok(machineVersion(changedRounds) !== version, '改 maxRounds version 必须变')

    // 改节点 id（边也同步改）→ 变。
    const renamed = tripleFlow()
    renamed.nodes.find(node => node.id === 'n_b').id = 'n_b_renamed'
    for (const edge of renamed.edges) {
      if (edge.from === 'n_b') edge.from = 'n_b_renamed'
      if (edge.to === 'n_b') edge.to = 'n_b_renamed'
    }
    A.ok(machineVersion(renamed) !== version, '改节点 id version 必须变')

    // 改节点 kind → 变。
    const retyped = tripleFlow()
    retyped.nodes.find(node => node.id === 'n_c').kind = 'end'
    A.ok(machineVersion(retyped) !== version, '改节点 kind version 必须变')

    // 改边的 from / to / kind → 变。
    const changedFrom = tripleFlow()
    changedFrom.edges.find(edge => edge.id === 'reject-n_c-n_a').from = 'n_b'
    A.ok(machineVersion(changedFrom) !== version, '改边 from version 必须变')
    const changedTo = tripleFlow()
    changedTo.edges.find(edge => edge.id === 'reject-n_c-n_a').to = 'n_start'
    A.ok(machineVersion(changedTo) !== version, '改边 to version 必须变')
    const changedKind = tripleFlow()
    changedKind.edges.find(edge => edge.id === 'next-n_a-n_b').kind = 'reject'
    A.ok(machineVersion(changedKind) !== version, '改边 kind version 必须变')

    // 改 engineVersion → 变；默认值 '1' 与显式 '1' 同。
    A.ok(machineVersion(forward, { engineVersion: '2' }) !== version, '改 engineVersion version 必须变')
    A.equal(machineVersion(forward, { engineVersion: '1' }), version, "默认 engineVersion 就是 '1'")
  })

  await check('G2：编译出的状态集 / 边集与 flow 一致（含多上游打回、无打回出边）', () => {
    const flow = tripleFlow()
    const { compiled } = compileAndProvide(flow)
    const { machine, meta, version } = compiled

    A.deepEqual(
      Object.keys(machine.states).sort(),
      ['aborted', 'done', 'failed', 'running'],
      '顶层只有 running + 三个终态',
    )
    A.deepEqual(
      Object.keys(machine.states.running.states).sort(),
      ['n_a', 'n_b', 'n_c'],
      'stage 节点各是一个状态；start / end 不是状态',
    )
    A.ok(!Object.keys(machine.states.running.states).includes('n_start'), '开始节点不作为状态')
    A.ok(!Object.keys(machine.states.running.states).includes('n_end'), '结束节点不作为状态')
    A.equal(machine.id, 'flow', '机器 id')
    A.equal(machine.states.running.config.initial, 'n_a', 'running 的 initial 是入口阶段')
    A.equal(machine.states.running.states.n_a.id, 'n_a', '阶段状态 id 用节点 id')
    A.equal(machine.states.done.type, 'final', '#done 是 final')
    A.equal(machine.states.failed.type, 'final', '#failed 是 final')
    A.equal(machine.states.aborted.type, 'final', '#aborted 是 final')
    A.equal(machine.states.done.id, 'done', '#done 的机器 id')
    A.deepEqual(machine.states.done.output, { victory: true }, '#done 的 output 带 victory')

    // §3.3 context：只放可序列化数据，初值全空。
    A.deepEqual(machine.config.context, {
      attempts: {},
      lastVerdict: null,
      rejectTarget: null,
      currentNodeId: null,
      finishedBy: null,
      reason: null,
      inbox: [],
    }, 'context 初值符合 §3.3')
    A.equal(
      JSON.stringify(machine.config.context),
      '{"attempts":{},"lastVerdict":null,"rejectTarget":null,"currentNodeId":null,"finishedBy":null,"reason":null,"inbox":[]}',
      'context 可以 JSON 序列化（snapshot 的要求）',
    )

    // §5.3：不用 XState 的 after 定时器（超时由引擎发 CLOCK_TIMEOUT）。
    const afterTransitions = state => (Array.isArray(state.after) ? state.after.length : 0)
    A.equal(afterTransitions(machine.states.running), 0, 'running 上没有 after')
    for (const stageId of ['n_a', 'n_b', 'n_c']) {
      A.equal(afterTransitions(machine.states.running.states[stageId]), 0, `${stageId} 上没有 after`)
    }

    // §3：纯函数——同一份 flow 编两次，版本与机器描述一致。
    const again = compileFlowToMachine(flow)
    A.equal(again.version, version, '同一份 flow 两次编译 version 相同')
    A.equal(
      JSON.stringify(again.machine.config),
      JSON.stringify(machine.config),
      '同一份 flow 两次编译的机器描述一致（函数被 JSON 掉，只比结构）',
    )

    // 正常流转：每个 stage 的 PASS 恰好一条，目标就是 flow 的 next 目标（end → #done）。
    const passA = machine.states.running.states.n_a.on.PASS
    const passC = machine.states.running.states.n_c.on.PASS
    A.deepEqual(targetIds(passA), ['n_b'], 'n_a 的 PASS 指向 n_b')
    A.deepEqual(targetIds(passC), ['done'], 'n_c 的 PASS 指向 #done（结束节点收敛到 #done）')
    A.deepEqual(actionTypes(passA), [['recordPass']], 'PASS 带 recordPass')

    // 多上游打回：c → b、c → a，守卫按「最靠左」排；超限兜底 #failed；最后一条是裸兜底。
    const rejectC = machine.states.running.states.n_c.on.REJECT
    A.deepEqual(targetIds(rejectC), ['n_a', 'n_b', 'failed', 'n_a'], 'REJECT 候选顺序：显式命中 → 超限失败 → 最左兜底')
    A.equal(typeof rejectC[0].guard, 'function', '带 and() 的复合 guard')
    A.equal(typeof rejectC[1].guard, 'function', '第二个目标同样带复合 guard')
    A.equal(rejectC[2].guard, 'maxRoundsExceeded', '超限落到单一 maxRoundsExceeded guard')
    A.equal(rejectC[3].guard, undefined, '最后一条是无 guard 的兜底')
    A.deepEqual(actionTypes(rejectC), [['recordReject'], ['recordReject'], ['recordMaxRounds'], ['recordReject']])

    // 没有打回出边的节点：REJECT 直接收成 failed。
    const plain = compileAndProvide(flowOf(
      [startNode(0), stageNode('n_a', 200), endNode(900)],
      [nextEdge('n_start', 'n_a'), nextEdge('n_a', 'n_end')],
    )).compiled
    const rejectA = plain.machine.states.running.states.n_a.on.REJECT
    A.deepEqual(targetIds(rejectA), ['failed'], '无 reject 出边 → #failed')
    A.deepEqual(actionTypes(rejectA), [['recordRejectWithoutTarget']], '无 reject 出边用 recordRejectWithoutTarget')

    // FAIL / INBOX / SELF_CHECK，以及 running 上的超时 / 取消。
    const onA = machine.states.running.states.n_a.on
    A.deepEqual(targetIds(onA.FAIL), ['failed'], 'FAIL → #failed')
    A.deepEqual(actionTypes(onA.FAIL), [['recordFail']])
    A.deepEqual(actionTypes(onA.INBOX), [['queueInbox']], 'INBOX 只挂 action、不转移')
    A.equal(onA.INBOX[0].target, undefined, 'INBOX 不改变状态')
    A.deepEqual(actionTypes(onA.SELF_CHECK), [['recordSelfCheck']], 'SELF_CHECK 只挂 action')
    A.equal(onA.SELF_CHECK[0].target, undefined, 'SELF_CHECK 不改变状态')
    A.deepEqual(targetIds(machine.states.running.on.CLOCK_TIMEOUT), ['failed'], 'CLOCK_TIMEOUT → #failed')
    A.deepEqual(actionTypes(machine.states.running.on.CLOCK_TIMEOUT), [['recordTimeout']])
    A.deepEqual(targetIds(machine.states.running.on.CANCEL), ['aborted'], 'CANCEL → #aborted')
    A.deepEqual(actionTypes(machine.states.running.on.CANCEL), [['recordCancel']])
    A.match(version, /^[0-9a-f]{16}$/)

    // meta 契约。
    A.equal(meta.entryNodeId, 'n_a', 'meta.entryNodeId = start 唯一 next 边的目标')
    A.deepEqual(meta.stageIds, ['n_a', 'n_b', 'n_c'], 'meta.stageIds')
    A.deepEqual(meta.rejectEdges, { n_c: ['n_a', 'n_b'] }, 'meta.rejectEdges 按最靠左排序')
    A.deepEqual(meta.maxRounds, { n_a: 2, n_b: 2, n_c: 2 }, 'meta.maxRounds')
    A.equal(meta.runTimeoutMs, null, '不传 runTimeoutMs 时为 null（不生成 XState after）')
  })

  await check('G3：真 actor 跑通 pass 链 / 显式打回目标 / 未指定取最靠左 / 无出边收 failed', () => {
    const { compiled } = compileAndProvide(tripleFlow())

    // pass 链一路到 #done。
    {
      const { actor } = startActor(compiled)
      A.equal(where(actor), 'n_a', '初始停在入口阶段')
      send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
      A.equal(where(actor), 'n_b')
      send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 1 })
      A.equal(where(actor), 'n_c')
      send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_c', attempt: 1 })
      const snapshot = actor.getSnapshot()
      A.equal(snapshot.value, 'done', 'pass 链走到 #done')
      A.equal(snapshot.status, 'done', 'agent 进入 done status')
      A.equal(snapshot.context.finishedBy, 'pass', 'finishedBy=pass')
      A.equal(snapshot.context.lastVerdict, 'pass')
      A.equal(snapshot.context.currentNodeId, 'n_c', 'currentNodeId 记最后一个出结论的节点')
      A.deepEqual(snapshot.context.attempts, {}, '正常通过不消耗重跑次数')
    }

    // 显式 rejectTarget 命中。
    {
      const { actor } = startActor(compiled)
      send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
      send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 1 })
      send(actor, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 1, rejectTarget: 'n_b', reason: '证据不完整' })
      const snapshot = actor.getSnapshot()
      A.equal(where(actor), 'n_b', '显式 rejectTarget=n_b 命中 n_b')
      A.equal(snapshot.context.rejectTarget, 'n_b')
      A.equal(snapshot.context.reason, '证据不完整', '打回理由写进 context.reason')
      A.deepEqual(snapshot.context.attempts, { n_b: 1 }, 'attempts 记在被打回的目标上')
      A.equal(snapshot.context.lastVerdict, 'reject')
      A.equal(snapshot.context.currentNodeId, 'n_c', 'currentNodeId 是最近出结论的节点')

      // 目标节点重新通过后，上一轮的打回痕迹要清掉。
      send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 2 })
      const passed = actor.getSnapshot()
      A.equal(where(actor), 'n_c', 'n_b 重新通过后继续前进')
      A.equal(passed.context.rejectTarget, null, 'PASS 清掉 rejectTarget')
      A.equal(passed.context.reason, null, 'PASS 清掉 reason')
      A.equal(passed.context.lastVerdict, 'pass')
      A.deepEqual(passed.context.attempts, { n_b: 1 }, '清的是打回痕迹，不是已用的重跑次数')
    }

    // 未指定 rejectTarget → 最靠左（n_a 的 x 比 n_b 小）。
    {
      const { actor } = startActor(compiled)
      send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
      send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 1 })
      send(actor, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 1 })
      A.equal(where(actor), 'n_a', '未指定 rejectTarget 时取最靠左的上游目标 n_a')
      A.deepEqual(actor.getSnapshot().context.attempts, { n_a: 1 })
      A.equal(actor.getSnapshot().context.rejectTarget, null, '未指定时 context.rejectTarget 为 null')
    }

    // 有 reject 边但明确指向一个不存在的上游 → 仍然按兜底目标走（不崩）。
    {
      const { actor } = startActor(compiled)
      send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
      send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 1 })
      send(actor, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 1, rejectTarget: 'n_nope' })
      A.equal(where(actor), 'n_a', '非法 rejectTarget 退回最靠左目标，与 selectRejectTarget 同口径')
    }

    // 无 reject 出边：打回直接 failed。
    {
      const plain = compileAndProvide(flowOf(
        [startNode(0), stageNode('n_a', 200), endNode(900)],
        [nextEdge('n_start', 'n_a'), nextEdge('n_a', 'n_end')],
      )).compiled
      const { actor } = startActor(plain)
      send(actor, FLOW_EVENTS.REJECT, { nodeId: 'n_a', attempt: 1 })
      const snapshot = actor.getSnapshot()
      A.equal(snapshot.value, 'failed', '没有 reject 边 → #failed')
      A.equal(snapshot.context.finishedBy, 'fail')
      A.equal(snapshot.context.lastVerdict, 'reject')
      A.match(snapshot.context.reason, /没有配置任何 reject 边/, 'reason 说明原因')
    }

    // start 直接连 end（结束节点没有状态）→ 机器一开始就是 #done。
    {
      const direct = compileAndProvide(flowOf(
        [startNode(0), stageNode('n_s', 200), endNode(500, 'n_end'), endNode(900, 'n_end2')],
        [
          nextEdge('n_start', 'n_end'),
          nextEdge('n_end', 'n_s'),
          nextEdge('n_s', 'n_end2'),
        ],
      )).compiled
      A.equal(direct.machine.config.initial, 'done', '入口是结束节点时机器直接进入 #done')
      A.equal(direct.meta.entryNodeId, 'n_end')
      const { actor } = startActor(direct)
      A.equal(actor.getSnapshot().value, 'done', '直接进入终态')
      A.equal(actor.getSnapshot().status, 'done')
      A.equal(actor.getSnapshot().context.finishedBy, 'pass', '#done 的 entry 记下 finishedBy=pass')
    }

    // 编译产物是纯数据：同一个 provided machine 上的两个 actor 不共享 context。
    {
      const provided = compiled.machine.provide(flowMachineImplementations(compiled.meta))
      const first = createActor(provided); first.start()
      const second = createActor(provided); second.start()
      send(first, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
      send(first, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 1 })
      send(first, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 1 })
      A.deepEqual(first.getSnapshot().context.attempts, { n_a: 1 }, '第一个 actor 有 attempts')
      A.deepEqual(second.getSnapshot().context.attempts, {}, '第二个 actor 的 context 不受影响')
      A.deepEqual(second.getSnapshot().context.inbox, [], 'inbox 也不共享')
    }
  })

  await check('G4：打回上限——maxRounds:1 的节点被打回 2 次，第 2 次落 #failed 且 finishedBy=max-rounds', () => {
    const { compiled } = compileAndProvide(loopFlow({ maxRounds: 1 }))
    const { actor } = startActor(compiled)

    send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
    A.equal(where(actor), 'n_b')
    send(actor, FLOW_EVENTS.REJECT, { nodeId: 'n_b', attempt: 1 })
    A.equal(where(actor), 'n_a', '第 1 次打回：目标还有余量，回到 n_a')
    A.deepEqual(actor.getSnapshot().context.attempts, { n_a: 1 })

    send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 2 })
    A.equal(where(actor), 'n_b')
    send(actor, FLOW_EVENTS.REJECT, { nodeId: 'n_b', attempt: 2 })
    const snapshot = actor.getSnapshot()
    A.equal(snapshot.value, 'failed', '第 2 次打回：超 maxRounds:1 → #failed')
    A.equal(snapshot.context.finishedBy, 'max-rounds', 'finishedBy=max-rounds')
    A.equal(snapshot.context.lastVerdict, 'reject')
    A.equal(snapshot.context.rejectTarget, 'n_a', '超限时也记下本要打回的目标')
    A.match(snapshot.context.reason, /超打回上限/, 'reason 说明超限')
    A.deepEqual(snapshot.context.attempts, { n_a: 1 }, '超限被拦下，不再加 attempt')

    // 对照：maxRounds:2 时同样的两次打回都合法，第 3 次才超限。
    {
      const loose = startActor(compileAndProvide(loopFlow({ maxRounds: 2 })).compiled).actor
      send(loose, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
      send(loose, FLOW_EVENTS.REJECT, { nodeId: 'n_b', attempt: 1 })
      send(loose, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 2 })
      send(loose, FLOW_EVENTS.REJECT, { nodeId: 'n_b', attempt: 2 })
      send(loose, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 3 })
      A.equal(where(loose), 'n_b', 'maxRounds:2 时第 2 次打回仍然合法')
      send(loose, FLOW_EVENTS.REJECT, { nodeId: 'n_b', attempt: 3 })
      A.equal(loose.getSnapshot().value, 'failed', '第 3 次打回才超限')
      A.equal(loose.getSnapshot().context.finishedBy, 'max-rounds')
    }
  })

  await check('G5：未知 verdict → FAIL；终态吸收后续 PASS/REJECT', () => {
    const { compiled } = compileAndProvide(tripleFlow())
    const { actor } = startActor(compiled)
    send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
    send(actor, FLOW_EVENTS.FAIL, { nodeId: 'n_b', attempt: 1, reason: '结构不合法的输出，按失败处理' })
    const failed = actor.getSnapshot()
    A.equal(failed.value, 'failed', 'FAIL → #failed（未知 verdict 不当 pass）')
    A.equal(failed.context.finishedBy, 'fail')
    A.equal(failed.context.lastVerdict, 'fail')
    A.equal(failed.context.reason, '结构不合法的输出，按失败处理')

    const contextBefore = failed.context
    send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_c', attempt: 2 })
    send(actor, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 2, rejectTarget: 'n_a' })
    const after = actor.getSnapshot()
    A.equal(after.value, 'failed', '终态后 PASS/REJECT 不改变状态')
    A.deepEqual(after.context, contextBefore, '终态后 context 也不变')

    // done 也一样吸收。
    {
      const healthy = startActor(compiled).actor
      send(healthy, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
      send(healthy, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 1 })
      send(healthy, FLOW_EVENTS.PASS, { nodeId: 'n_c', attempt: 1 })
      const doneContext = healthy.getSnapshot().context
      send(healthy, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 2 })
      send(healthy, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 2, rejectTarget: 'n_a' })
      A.equal(healthy.getSnapshot().value, 'done', '#done 之后不再接受 NODE 事件')
      A.deepEqual(healthy.getSnapshot().context, doneContext)
    }
  })

  await check('G6：CLOCK_TIMEOUT → #failed(timeout)；CANCEL → #aborted', () => {
    const { compiled } = compileAndProvide(tripleFlow())

    {
      const { actor } = startActor(compiled)
      send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
      send(actor, FLOW_EVENTS.CLOCK_TIMEOUT, { kind: 'run' })
      const snapshot = actor.getSnapshot()
      A.equal(snapshot.value, 'failed', '超时 → #failed')
      A.equal(snapshot.context.finishedBy, 'timeout')
      A.match(snapshot.context.reason, /墙钟到点/, 'reason 说明是墙钟到点')
      A.equal(snapshot.status, 'done')
    }

    // 节点墙钟：kind='node' 时 reason 是节点到点；显式 reason 优先。
    {
      const { actor } = startActor(compiled)
      send(actor, FLOW_EVENTS.CLOCK_TIMEOUT, { kind: 'node', nodeId: 'n_a' })
      A.equal(actor.getSnapshot().value, 'failed', '节点超时也收 #failed')
      A.equal(actor.getSnapshot().context.finishedBy, 'timeout')
      A.match(actor.getSnapshot().context.reason, /节点墙钟到点/)
    }
    {
      const { actor } = startActor(compiled)
      send(actor, FLOW_EVENTS.CLOCK_TIMEOUT, { kind: 'run', reason: '自定义超时原因' })
      A.equal(actor.getSnapshot().context.reason, '自定义超时原因', '事件显式 reason 优先')
    }

    {
      const { actor } = startActor(compiled)
      send(actor, FLOW_EVENTS.CANCEL, { reason: '用户停止' })
      const snapshot = actor.getSnapshot()
      A.equal(snapshot.value, 'aborted', 'CANCEL → #aborted')
      A.equal(snapshot.context.finishedBy, 'aborted')
      A.equal(snapshot.context.reason, '用户停止')
      send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
      A.equal(actor.getSnapshot().value, 'aborted', 'aborted 之后不再接受 NODE 事件')
    }
  })

  await check('G7：持久化往返——恢复后 value/context 一致，且能继续走到 #done（action 不重放）', () => {
    const flow = tripleFlow()
    const { compiled } = compileAndProvide(flow)
    const { actor } = startActor(compiled)
    send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
    send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 1 })
    send(actor, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 1, rejectTarget: 'n_b' })
    A.equal(where(actor), 'n_b')

    const persisted = actor.getPersistedSnapshot()
    const roundTripped = JSON.parse(JSON.stringify(persisted))
    A.deepEqual(roundTripped.context, actor.getSnapshot().context, '快照 context 可以 JSON 往返')
    A.equal(roundTripped.status, 'active', '运行中的快照 status 是 active（不是 XState 的机器状态 done/running）')

    // 重新编译一份同版本的机器再恢复：真实场景是进程重启后重算 machine。
    const recompiled = compileAndProvide(flow)
    A.equal(recompiled.compiled.version, compiled.version, '同一份 flow 重编译 version 不变')

    let actionCalls = 0
    const impl = flowMachineImplementations(recompiled.compiled.meta)
    const spy = {
      guards: impl.guards,
      actions: { ...impl.actions, recordPass: () => { actionCalls += 1 } },
    }
    const restoredActor = createActor(recompiled.compiled.machine.provide(spy), { snapshot: roundTripped })
    restoredActor.start()
    A.equal(actionCalls, 0, '恢复时 action 不重放（XState 官方语义）')
    A.deepEqual(restoredActor.getSnapshot().value, actor.getSnapshot().value, '恢复后的 value 一致')
    A.deepEqual(restoredActor.getSnapshot().context, actor.getSnapshot().context, '恢复后的 context 一致')

    send(restoredActor, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 2 })
    A.equal(actionCalls, 1, '恢复后继续推进时 action 才执行')
    send(restoredActor, FLOW_EVENTS.PASS, { nodeId: 'n_c', attempt: 1 })
    A.equal(restoredActor.getSnapshot().value, 'done', '恢复后能继续走到 #done')
  })

  await check('G8：machineEventsFromRun 映射 + replayMachine 与逐条 send 等价', () => {
    const { compiled } = compileAndProvide(loopFlow({ maxRounds: 2 }))

    // 真实 runlog 形状（含 extra.rejectTarget / 顶层 rejectTarget / extra.reason）。
    const runlog = [
      { v: 1, seq: 1, kind: 'run/start', data: { flowId: 'f', flowName: '流程', nodeTotal: 3 } },
      { v: 1, seq: 2, kind: 'node/start', nodeId: 'n_a', attemptId: 1, data: { title: 'A', mode: 'single', skills: [] } },
      { v: 1, seq: 3, kind: 'node/end', nodeId: 'n_a', attemptId: 1, data: { status: 'passed', durationMs: 5 } },
      { v: 1, seq: 4, kind: 'node/start', nodeId: 'n_b', attemptId: 1, data: { title: 'B', mode: 'single', skills: [] } },
      {
        v: 1, seq: 5, kind: 'node/end', nodeId: 'n_b', attemptId: 1,
        data: { status: 'rejected', durationMs: 5 },
        extra: { rejectTarget: 'n_a' },
      },
      { v: 1, seq: 6, kind: 'reject/trigger', nodeId: 'n_b', attemptId: 1, data: { edgeId: 'e1', toNodeId: 'n_a' } },
      { v: 1, seq: 7, kind: 'node/start', nodeId: 'n_a', attemptId: 2, data: { title: 'A', mode: 'single', skills: [] } },
      { v: 1, seq: 8, kind: 'node/end', nodeId: 'n_a', attemptId: 2, data: { status: 'passed', durationMs: 5 } },
      { v: 1, seq: 9, kind: 'node/start', nodeId: 'n_b', attemptId: 2, data: { title: 'B', mode: 'single', skills: [] } },
      {
        v: 1, seq: 10, kind: 'node/end', nodeId: 'n_b', attemptId: 2,
        data: { status: 'failed', durationMs: 5 },
        extra: { reason: '结构化输出不合法' },
      },
      { v: 1, seq: 11, kind: 'run/end', data: { status: 'failed', reason: '结构化输出不合法' } },
    ]

    const mapped = machineEventsFromRun(runlog)
    A.deepEqual(mapped, [
      { type: 'PASS', nodeId: 'n_a', attempt: 1 },
      { type: 'REJECT', nodeId: 'n_b', attempt: 1, rejectTarget: 'n_a' },
      { type: 'PASS', nodeId: 'n_a', attempt: 2 },
      { type: 'FAIL', nodeId: 'n_b', attempt: 2, reason: '结构化输出不合法' },
    ], 'passed/rejected/failed 映射正确；run/start、node/start、reject/trigger、run/end failed 被忽略')

    // rejectTarget 的两种嵌套位置都要认，且顶层优先。
    A.deepEqual(
      machineEventsFromRun([
        { kind: 'node/end', nodeId: 'n_b', attemptId: 1, data: { status: 'rejected', extra: { rejectTarget: 'n_a' } } },
      ]),
      [{ type: 'REJECT', nodeId: 'n_b', attempt: 1, rejectTarget: 'n_a' }],
      'data.extra.rejectTarget 也认',
    )
    A.deepEqual(
      machineEventsFromRun([
        { kind: 'node/end', nodeId: 'n_b', attemptId: 1, data: { status: 'rejected', rejectTarget: 'n_b_top', extra: { rejectTarget: 'n_a' } } },
      ]),
      [{ type: 'REJECT', nodeId: 'n_b', attempt: 1, rejectTarget: 'n_b_top' }],
      '顶层 data.rejectTarget 优先于嵌套',
    )
    // 其它 kind / status 一律忽略（skipped、run/end done）。
    A.deepEqual(
      machineEventsFromRun([
        { kind: 'node/end', nodeId: 'n_a', attemptId: 1, data: { status: 'skipped' } },
        { kind: 'run/end', data: { status: 'done' } },
        { kind: 'model/call', data: {} },
      ]),
      [],
      'skipped / run/end done / 其它 kind 都忽略',
    )
    // aborted 只在 run/end 上映射成 CANCEL。
    A.deepEqual(
      machineEventsFromRun([
        { kind: 'node/end', nodeId: 'n_a', attemptId: 1, data: { status: 'passed' } },
        { kind: 'run/end', data: { status: 'aborted', reason: '用户停止' } },
      ]),
      [{ type: 'PASS', nodeId: 'n_a', attempt: 1 }, { type: 'CANCEL' }],
      'run/end aborted → CANCEL',
    )

    // 重放 == 逐条 send。
    const replay = replayMachine(compiled.machine.provide(flowMachineImplementations(compiled.meta)), mapped)
    A.equal(replay.replayed, mapped.length, 'replayed = 实际发送的事件数')
    A.equal(replay.finalValue, 'failed', '按事件流重放到 #failed')

    const manual = startActor(compiled).actor
    for (const event of mapped) manual.send(event)
    const replayedSnapshot = replay.actor.getSnapshot()
    const manualSnapshot = manual.getSnapshot()
    A.deepEqual(replayedSnapshot.value, manualSnapshot.value, '重放与逐条 send 的 value 一致')
    A.deepEqual(replayedSnapshot.context, manualSnapshot.context, '重放与逐条 send 的 context 一致')
    A.equal(replayedSnapshot.status, manualSnapshot.status, '重放与逐条 send 的 status 一致')
    A.equal(replayedSnapshot.context.attempts.n_a, 1, '打回次数在重放里被还原')

    // aborted 段的重放：直接吃 runlog 事件也能认（convenience）。
    const abortRunlog = [
      { kind: 'run/start', data: {} },
      { kind: 'node/end', nodeId: 'n_a', attemptId: 1, data: { status: 'passed' } },
      { kind: 'run/end', data: { status: 'aborted' } },
    ]
    const abortReplay = replayMachine(compiled.machine.provide(flowMachineImplementations(compiled.meta)), abortRunlog)
    A.equal(abortReplay.finalValue, 'aborted', '重放 runlog 的 aborted 段 → #aborted')
    A.equal(abortReplay.replayed, 2, 'run/start 不产生事件')
  })

  await check('G9：INBOX 只进观测队列（≤20 截尾、不改状态）；SELF_CHECK 只更新观测字段', () => {
    const { compiled } = compileAndProvide(tripleFlow())
    const { actor } = startActor(compiled)
    const fresh = actor.getSnapshot()

    // 25 条外部消息：只留最近 20 条（截尾），状态不前进。
    for (let index = 1; index <= 25; index += 1) {
      send(actor, FLOW_EVENTS.INBOX, { messageId: `m${index}`, text: `第 ${index} 条` })
    }
    let snapshot = actor.getSnapshot()
    A.deepEqual(snapshot.value, fresh.value, 'INBOX 不改变状态')
    A.equal(snapshot.context.inbox.length, 20, 'inbox 上限 20 条')
    A.equal(snapshot.context.inbox[0].messageId, 'm6', '截尾保留最近的：第 1 条是 m6')
    A.equal(snapshot.context.inbox[19].messageId, 'm25', '最后一条是 m25')
    A.equal(snapshot.context.inbox[0].text, '第 6 条', '正文按序保留')
    A.deepEqual(snapshot.context.attempts, {}, 'INBOX 不动 attempts')
    A.equal(snapshot.context.lastVerdict, null, 'INBOX 不动 lastVerdict')
    A.equal(snapshot.context.currentNodeId, null, 'INBOX 不动 currentNodeId')

    // 非字符串正文 / 缺 messageId 也要可序列化，不把事件对象原样塞进 context。
    send(actor, FLOW_EVENTS.INBOX, { messageId: 'm26', text: 42 })
    send(actor, FLOW_EVENTS.INBOX, { text: '没有 id' })
    snapshot = actor.getSnapshot()
    A.equal(snapshot.context.inbox.length, 20, '仍然最多 20 条')
    A.equal(snapshot.context.inbox[19].messageId, null, '缺 messageId 记 null')
    A.equal(snapshot.context.inbox[19].text, '没有 id', '缺 id 的消息也保留正文')
    A.equal(snapshot.context.inbox[18].messageId, 'm26', 'm26 在前一条')
    A.equal(snapshot.context.inbox[18].text, '', '非字符串正文归一成空串')
    A.deepEqual(JSON.parse(JSON.stringify(snapshot.context)), snapshot.context, 'context 可以 JSON 往返')

    // SELF_CHECK：只更新观测字段，不转移、不消耗 attempts、不动打回目标。
    send(actor, FLOW_EVENTS.SELF_CHECK, { state: 'working', progress: 0.6, verdict: 'reject' })
    snapshot = actor.getSnapshot()
    A.deepEqual(snapshot.value, fresh.value, 'SELF_CHECK 不改变状态')
    A.equal(snapshot.context.lastVerdict, 'reject', 'SELF_CHECK 的 verdict 只更新观测字段')
    A.deepEqual(snapshot.context.attempts, fresh.context.attempts, 'SELF_CHECK 不动 attempts')
    A.equal(snapshot.context.rejectTarget, null, 'SELF_CHECK 不写 rejectTarget')
    A.equal(snapshot.context.currentNodeId, fresh.context.currentNodeId, 'SELF_CHECK 不动 currentNodeId')
    send(actor, FLOW_EVENTS.SELF_CHECK, { state: 'working', progress: 0.9, verdict: 'something-else' })
    A.equal(actor.getSnapshot().context.lastVerdict, 'reject', '非法 verdict 不改 lastVerdict')
    A.deepEqual(actor.getSnapshot().value, fresh.value, '非法 verdict 也不转移')
    send(actor, FLOW_EVENTS.SELF_CHECK, { verdict: 'pass' })
    A.equal(actor.getSnapshot().context.lastVerdict, 'pass', '合法 verdict 更新 lastVerdict')

    // 终态之后 INBOX / SELF_CHECK 也不接受（机器已经结束）。
    send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
    send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 1 })
    send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_c', attempt: 1 })
    const doneContext = actor.getSnapshot().context
    send(actor, FLOW_EVENTS.INBOX, { messageId: 'late', text: '迟到消息' })
    send(actor, FLOW_EVENTS.SELF_CHECK, { verdict: 'fail' })
    A.equal(actor.getSnapshot().value, 'done', '终态仍是 done')
    A.deepEqual(actor.getSnapshot().context, doneContext, '终态后 INBOX / SELF_CHECK 不改 context')
  })

  await check('G10：REJECT 优先级——显式目标超限优先判失败 / attempts 按目标分别累计 / 同列按 y 取最左', () => {
    // 1) 显式 rejectTarget 命中 n_b，而 n_b 已超限：必须收成 #failed，
    //    不能因为另一个目标 n_a 还有余量就改道打回。
    const strict = compileAndProvide(tripleFlow({ n_a: { maxRounds: 5 }, n_b: { maxRounds: 1 } }))
    const { actor } = startActor(strict.compiled)
    send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
    send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 1 })
    send(actor, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 1, rejectTarget: 'n_b' })
    A.equal(where(actor), 'n_b', '第 1 次显式打回 n_b 合法')
    A.deepEqual(actor.getSnapshot().context.attempts, { n_b: 1 })
    send(actor, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 2 })
    send(actor, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 2, rejectTarget: 'n_b' })
    const limited = actor.getSnapshot()
    A.equal(limited.value, 'failed', '显式目标超限 → #failed（不改道 n_a）')
    A.equal(limited.context.finishedBy, 'max-rounds')
    A.equal(limited.context.rejectTarget, 'n_b', '超限时 context.rejectTarget 是显式目标')
    A.match(limited.context.reason, /超打回上限：目标「n_b」已重跑 1 次/, 'reason 带目标与上限')
    A.deepEqual(limited.context.attempts, { n_b: 1 }, '超限不增加 attempt')

    // 2) 不同目标的 attempts 分别累计，互不影响。
    const multi = startActor(compileAndProvide(tripleFlow()).compiled).actor
    send(multi, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
    send(multi, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 1 })
    send(multi, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 1, rejectTarget: 'n_a' })
    send(multi, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 2 })
    send(multi, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 2 })
    send(multi, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 2, rejectTarget: 'n_b' })
    A.deepEqual(multi.getSnapshot().context.attempts, { n_a: 1, n_b: 1 }, '每个目标的 attempts 各自累加')

    // 3) 反向对照：另一个目标已超限，但显式指定的目标还有余量 → 按显式目标走，不判失败。
    const picky = startActor(compileAndProvide(tripleFlow({ n_a: { maxRounds: 1 }, n_b: { maxRounds: 5 } })).compiled).actor
    send(picky, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
    send(picky, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 1 })
    send(picky, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 1, rejectTarget: 'n_a' })
    A.deepEqual(picky.getSnapshot().context.attempts, { n_a: 1 }, 'n_a 用掉唯一一次重跑')
    send(picky, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 2 })
    send(picky, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 2 })
    send(picky, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 2, rejectTarget: 'n_b' })
    A.equal(where(picky), 'n_b', 'n_a 超限不影响显式指定的 n_b')
    A.equal(picky.getSnapshot().context.finishedBy, null, '没有误判 max-rounds')
    A.deepEqual(picky.getSnapshot().context.attempts, { n_a: 1, n_b: 1 })

    // 4) 同列（x 相同）的兜底目标按 y 再按 id 取最左，与 engine.leftmost 同口径。
    const tie = compileAndProvide(flowOf(
      [
        startNode(0),
        stageNode('n_x', 400, { y: 200 }),
        stageNode('n_y', 400, { y: 100 }),
        stageNode('n_z', 800),
        endNode(1100),
      ],
      [
        nextEdge('n_start', 'n_x'),
        nextEdge('n_x', 'n_y'),
        nextEdge('n_y', 'n_z'),
        nextEdge('n_z', 'n_end'),
        rejectEdge('n_z', 'n_x'),
        rejectEdge('n_z', 'n_y'),
      ],
    ))
    A.deepEqual(tie.compiled.meta.rejectEdges, { n_z: ['n_y', 'n_x'] }, '同 x 时 y 小的排前面')
    const tieActor = startActor(tie.compiled).actor
    send(tieActor, FLOW_EVENTS.PASS, { nodeId: 'n_x', attempt: 1 })
    send(tieActor, FLOW_EVENTS.PASS, { nodeId: 'n_y', attempt: 1 })
    send(tieActor, FLOW_EVENTS.REJECT, { nodeId: 'n_z', attempt: 1 })
    A.equal(where(tieActor), 'n_y', '未指定 rejectTarget 时取最靠左（y 更小）的 n_y')
    A.deepEqual(tieActor.getSnapshot().context.attempts, { n_y: 1 })
  })

  await check('G11：版本不匹配走事件重放、快照结构不兼容也不假装可用（§6 恢复算法）', () => {
    const flow = tripleFlow()
    const { compiled } = compileAndProvide(flow)
    const run = startActor(compiled).actor
    send(run, FLOW_EVENTS.PASS, { nodeId: 'n_a', attempt: 1 })
    send(run, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 1 })
    send(run, FLOW_EVENTS.REJECT, { nodeId: 'n_c', attempt: 1, rejectTarget: 'n_b' })
    A.equal(where(run), 'n_b')
    const snapshot = JSON.parse(JSON.stringify(run.getPersistedSnapshot()))
    A.deepEqual(snapshot.context.attempts, { n_b: 1 }, '快照里有打回次数')

    // 事件流比快照多走了两步：快照是缓存，事件流才是真相。
    const events = [
      { type: FLOW_EVENTS.PASS, nodeId: 'n_a', attempt: 1 },
      { type: FLOW_EVENTS.PASS, nodeId: 'n_b', attempt: 1 },
      { type: FLOW_EVENTS.REJECT, nodeId: 'n_c', attempt: 1, rejectTarget: 'n_b' },
      { type: FLOW_EVENTS.PASS, nodeId: 'n_b', attempt: 2 },
      { type: FLOW_EVENTS.PASS, nodeId: 'n_c', attempt: 1 },
    ]

    // 1) 版本一致 → 用快照（缓存），恢复后能接着走完。
    const same = restorePerSpec(compiled, { snapshot, snapshotVersion: compiled.version, events })
    A.equal(same.via, 'snapshot', '版本一致时走快照恢复')
    A.equal(where(same.actor), 'n_b', '快照恢复停在打回后的 n_b')
    A.deepEqual(same.actor.getSnapshot().context.attempts, { n_b: 1 }, '快照 context 恢复')

    // 快照与「重放到同一时间点」必须是同一个结论（事件流是真相，快照只是缓存）。
    const provided = compiled.machine.provide(flowMachineImplementations(compiled.meta))
    const replayToSnapshot = replayMachine(provided, events.slice(0, 3))
    A.deepEqual(
      replayToSnapshot.actor.getSnapshot().value,
      same.actor.getSnapshot().value,
      '重放到快照点与快照路径的 value 一致',
    )
    A.deepEqual(
      replayToSnapshot.actor.getSnapshot().context,
      same.actor.getSnapshot().context,
      '重放到快照点与快照路径的 context 一致',
    )

    send(same.actor, FLOW_EVENTS.PASS, { nodeId: 'n_b', attempt: 2 })
    send(same.actor, FLOW_EVENTS.PASS, { nodeId: 'n_c', attempt: 1 })
    A.equal(same.actor.getSnapshot().value, 'done', '快照恢复后能接着走到 #done')

    // 2) 版本不一致 → 不许用快照，走事件重放；事件流末尾是 done。
    const recompiled = compileFlowToMachine(flow, { engineVersion: '2' })
    A.ok(recompiled.version !== compiled.version, 'engineVersion 变 → machine.version 变')
    const mismatched = restorePerSpec(recompiled, { snapshot, snapshotVersion: compiled.version, events })
    A.equal(mismatched.via, 'replay', '版本不匹配时走事件重放')
    A.equal(mismatched.actor.getSnapshot().value, 'done', '重放到事件流末尾的 #done')
    A.deepEqual(mismatched.actor.getSnapshot().context.attempts, { n_b: 1 }, '重放还原 attempts')
    A.equal(mismatched.replayed, events.length, '事件全部重放')

    // 3) 版本号相同但快照结构不可用（模拟 XState 内部字段不兼容）→ 明确报错后重放。
    const tampered = JSON.parse(JSON.stringify(snapshot))
    tampered.value = { running: 'n_ghost' }
    const fallback = restorePerSpec(compiled, { snapshot: tampered, snapshotVersion: compiled.version, events })
    A.equal(fallback.via, 'replay', '快照被 XState 拒绝后走事件重放')
    A.ok(fallback.restoreError instanceof Error, '快照错误被明确捕获，而不是假装可用')
    A.match(fallback.restoreError.message, /n_ghost/, '错误信息指出坏的节点')
    A.equal(fallback.actor.getSnapshot().value, 'done', '重放仍然到 #done')
  })

  await check('G12：非法 flow 矩阵——每条编译规则各一例，全部 error.code=FLOW_MACHINE_INVALID', () => {
    // 1) 多 next 出边：n_a 有两条 next 出边（不取最左，直接判非法）。
    const multipleNext = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n_a', 200), stageNode('n_b', 500), endNode(900)],
      [nextEdge('n_start', 'n_a'), nextEdge('n_a', 'n_b'), nextEdge('n_a', 'n_end'), nextEdge('n_b', 'n_end')],
    )), '多 next 出边')
    A.match(multipleNext.message, /「n_a」有 2 条 next 出边/, '命中的是多出边规则')

    // 2) 断头路：n_b 没有 next 出边（不是「从 start 到不了 end」）。
    const deadEnd = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n_a', 200), stageNode('n_b', 500), endNode(900)],
      [nextEdge('n_start', 'n_a'), nextEdge('n_a', 'n_b')],
    )), '断头路')
    A.match(deadEnd.message, /「n_b」没有 next 出边/, '命中的是断头路规则')

    // 3) next 边成环：a → b → a。
    const cycle = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n_a', 200), stageNode('n_b', 500), endNode(900)],
      [nextEdge('n_start', 'n_a'), nextEdge('n_a', 'n_b'), nextEdge('n_b', 'n_a')],
    )), 'next 成环')
    A.match(cycle.message, /next 边成环：n_a → n_b → n_a/, '命中的是成环规则')

    // 4) 孤立节点：n_b 从 start 沿 next 走不到。
    const isolated = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n_a', 200), stageNode('n_b', 500), endNode(900)],
      [nextEdge('n_start', 'n_a'), nextEdge('n_a', 'n_end'), nextEdge('n_b', 'n_end')],
    )), '孤立节点')
    A.match(isolated.message, /「n_b」从开始节点沿 next 走不到/, '命中的是孤立节点规则')

    // 5) 阶段沿 next 到不了任何 end。
    //    说明：规则 2/3/4（恰好一条 next 出边、next 是 DAG、所有节点可达）同时成立
    //    时，从任一阶段沿唯一 next 链必然终止在 end 上，因此这条规则在实现里被前三条
    //    完全遮蔽，构造不出「只违反它、不违反前三条」的 flow。这里用「阶段被卷进 next
    //    环、end 也不可达」的 flow 覆盖同一语义：仍然必须是 FLOW_MACHINE_INVALID。
    const unreachableEnd = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n_a', 200), stageNode('n_b', 500), stageNode('n_c', 700), endNode(900)],
      [nextEdge('n_start', 'n_a'), nextEdge('n_a', 'n_b'), nextEdge('n_b', 'n_c'), nextEdge('n_c', 'n_b')],
    )), '阶段到不了 end')
    A.match(unreachableEnd.message, /「n_end」从开始节点沿 next 走不到|next 边成环/, '被前序规则拦下，同样是 FLOW_MACHINE_INVALID')

    // 6) 打回目标不在上游：a 打回到下游的 b。
    const notUpstream = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n_a', 200), stageNode('n_b', 500), endNode(900)],
      [nextEdge('n_start', 'n_a'), nextEdge('n_a', 'n_b'), nextEdge('n_b', 'n_end'), rejectEdge('n_a', 'n_b')],
    )), '打回指向非上游')
    A.match(notUpstream.message, /「n_a → n_b」的目标不在上游/, '命中的是打回上游规则')

    // 7) 打回线两端必须是阶段节点。
    const rejectToEnd = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n_a', 200), endNode(900)],
      [nextEdge('n_start', 'n_a'), nextEdge('n_a', 'n_end'), rejectEdge('n_a', 'n_end')],
    )), '打回线指向 end')
    A.match(rejectToEnd.message, /两端都必须是阶段节点/)

    // 8) 节点 id 非法（会进 run 目录 / 状态 id，先挡住路径穿越）。
    const badId = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('../escape', 200), endNode(900)],
      [nextEdge('n_start', '../escape'), nextEdge('../escape', 'n_end')],
    )), '节点 id 非法')
    A.match(badId.message, /节点 id 不合法/)
    // 与 runId 同口径：'.' / '..' / 点开头也要挡住（只校验字符集会漏）。
    for (const id of ['.', '..', '.hidden']) {
      const error = A.throwsInvalid(() => compileFlowToMachine(flowOf(
        [startNode(0), stageNode(id, 200), endNode(900)],
        [nextEdge('n_start', id), nextEdge(id, 'n_end')],
      )), `节点 id「${id}」非法`)
      A.match(error.message, /节点 id 不合法/)
    }
    // 中间带点的合法 id 不受影响。
    A.equal(compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n..a', 200), endNode(900)],
      [nextEdge('n_start', 'n..a'), nextEdge('n..a', 'n_end')],
    )).meta.stageIds[0], 'n..a', '「n..a」这类 id 仍然合法')

    // 9) 节点 id 重复。
    const duplicateId = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n_a', 200), stageNode('n_a', 500), endNode(900)],
      [nextEdge('n_start', 'n_a'), nextEdge('n_a', 'n_end')],
    )), '节点 id 重复')
    A.match(duplicateId.message, /节点 id 重复：「n_a」/)

    // 10) 阶段节点用了保留状态名。
    const reservedId = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('failed', 200), endNode(900)],
      [nextEdge('n_start', 'failed'), nextEdge('failed', 'n_end')],
    )), '保留状态名')
    A.match(reservedId.message, /保留状态名冲突/)

    // 11) 节点类型不合法。
    const badKind = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), baseNode('n_x', 'gateway', 200), endNode(900)],
      [nextEdge('n_start', 'n_x'), nextEdge('n_x', 'n_end')],
    )), '节点类型非法')
    A.match(badKind.message, /类型「gateway」不合法/)

    // 12) 连线类型不合法。
    const badEdgeKind = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n_a', 200), endNode(900)],
      [nextEdge('n_start', 'n_a'), nextEdge('n_a', 'n_end'), { id: 'e-loop', from: 'n_a', to: 'n_end', kind: 'loop' }],
    )), '连线类型非法')
    A.match(badEdgeKind.message, /类型「loop」不合法/)

    // 13) 连线端点不存在。
    const missingEndpoint = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n_a', 200), endNode(900)],
      [nextEdge('n_start', 'n_a'), { id: 'e-missing', from: 'n_a', to: 'n_missing', kind: 'next' }],
    )), '连线终点不存在')
    A.match(missingEndpoint.message, /终点 n_missing 不存在/)

    // 14) start 数量：0 个 / 2 个。
    const noStart = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [stageNode('n_a', 200), endNode(900)],
      [nextEdge('n_a', 'n_end')],
    )), '没有开始节点')
    A.match(noStart.message, /必须恰好有一个「开始」节点（当前 0 个）/)
    const twoStarts = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), baseNode('n_start2', 'start', 100), stageNode('n_a', 200), endNode(900)],
      [nextEdge('n_start', 'n_a'), nextEdge('n_start2', 'n_a'), nextEdge('n_a', 'n_end')],
    )), '两个开始节点')
    A.match(twoStarts.message, /必须恰好有一个「开始」节点（当前 2 个）/)

    // 15) start 没有 next 出边（与断头路同一条规则，但入口节点单列）。
    const startDeadEnd = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n_a', 200), endNode(900)],
      [nextEdge('n_a', 'n_end')],
    )), 'start 没有 next 出边')
    A.match(startDeadEnd.message, /「n_start」没有 next 出边/)

    // 16) end 数量：0 个。
    const noEnd = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n_a', 200)],
      [nextEdge('n_start', 'n_a'), nextEdge('n_a', 'n_a')],
    )), '没有结束节点')
    A.match(noEnd.message, /没有「结束」节点/)

    // 17) 错误是真正的 Error，并带 code。
    const error = A.throwsInvalid(() => compileFlowToMachine(flowOf(
      [startNode(0), stageNode('n_a', 200), stageNode('n_b', 500), endNode(900)],
      [nextEdge('n_start', 'n_a'), nextEdge('n_a', 'n_b'), nextEdge('n_b', 'n_a')],
    )))
    A.ok(error instanceof Error, '抛的是 Error')
    A.ok(error instanceof FlowMachineInvalidError, '抛的是 FlowMachineInvalidError')
    A.equal(error.code, 'FLOW_MACHINE_INVALID', 'code 常量与类一致')
  })
} finally {
  // 本测试不落盘，没有需要清理的临时目录。
}

console.log(`\n${checks} 组通过（${assertionCount} 条断言）`)
