# 08 状态机内核：把流程推进交给 XState v5（v0.9）

> 对应 06（执行引擎）与 07 §2（红线）。本册只定义「流程状态推进」这一件事的契约；
> run 生命周期、持久化、租约、事件流、调度、画布、指标**都不变**，也不归状态机管。

## 1 目标与非目标

**目标**

1. 用成熟状态机库（XState v5）承载「节点之间怎么走」：分支、打回、重跑上限、超时、取消。
2. 持久化与恢复有明确语义：状态可持久化成快照、可由事件流重建，且**事件流仍是唯一真相**
   （0.9.0 的进程重启仍按 0.8.x 口径把在跑 run 收成 `failed`，生产路径暂不续跑，见 §6）。
3. 为下一阶段（条件分支 `edge.when`、并行 join）留出结构位，不重建地基。

**非目标**

- 不引入服务端组件（不要 Temporal/Zeebe/Camunda 那套集群）。
- 不替换 run.json 写入、租约、事件流、supervision、会话生命周期、画布、指标。
- 不在本册做条件分支的 UI；那是 09 册的事。

## 2 为什么是 XState v5

| 判据 | 结论 |
|---|---|
| 部署 | 纯库、零运行时依赖、MIT；vendored 单文件 ESM，随插件分发 |
| 确定性要求 | 无。更适合 LLM 节点（非确定、分钟到小时级） |
| 持久化 | `getPersistedSnapshot()` / `createActor(machine,{snapshot})`，官方文档明确「恢复时 action 不重放、invoke 会重启」——正是我们要的语义 |
| 分支 | `guards` 直接表达 `pass/reject/fail/上限` |
| 定时器 | `after`；但我们**不用它的计时器**，到点仍由现有闹钟发事件（见 §5） |
| 并行 | `parallel` states，P3 用 |
| 依赖 | 零运行时依赖；vendored 后不新增 npm 依赖 |

否决记录见本册 §10。

## 3 编译规则：flow → machine

`compileFlowToMachine(flow, { engineVersion })` 是**纯函数**（无 I/O、不看 run.json），返回
`{ machine, version, meta }`。同一份 flow + 同一 engineVersion 必须得到字节一致的 machine 描述。

### 3.1 状态

| flow 元素 | 机器里的形态 |
|---|---|
| 开始节点（`kind:'start'`） | **不作为状态**；入口直接是它的 next 目标 |
| 阶段节点（`kind:'stage'`） | 一个状态，`id` 用节点 id（`n_a`），内部只有 `invoke` + `onDone/onError` |
| 结束节点（`kind:'end'`） | final state `#done`（`type:'final'`，`output` 带 `{victory:true}`） |
| 公共失败出口 | final state `#failed`（`context.reason` 说明原因） |
| 公共中止出口 | final state `#aborted`（用户 stop / 卸载） |

顶层额外状态：`#running`（初始，`initial: 入口节点 id`）、`#done`、`#failed`、`#aborted`。
所有阶段状态都是 `#running` 的子状态；`#done/#failed/#aborted` 与 `#running` 平级，保证
「结束即终态、不再接受 NODE 事件」。

### 3.2 转移

每个阶段状态 `n_x`：

```
invoke: {
  src: 'runNode',             // 引擎注入；返回节点结构化结果
  id: 'x',
  input: ({ context }) => ({ runId, nodeId, attempt: context.attempts[n_x] + 1 }),
  onDone: [
    { guard: 'outcomePassed',   target: 'n_next',        actions: 'recordOutcome' },
    { guard: 'outcomeRejected', target: 'n_rejectTo_b',  actions: 'recordReject' },
    { guard: 'outcomeRejected', target: 'n_rejectTo_a',  actions: 'recordReject' },
    { guard: 'outcomeRejected', target: 'n_leftmost',    actions: 'recordReject' },  // 未指定 rejectTarget 时
    { target: 'n_next', actions: 'recordUnknownVerdict' },                            // 兜底：按现有语义等于 fail？
  ],
  onError: [
    { guard: 'retryable', target: 'n_x', actions: 'bumpAttempt' },
    { target: '#failed', actions: 'recordFailure' }
  ]
}
```

- `onDone` 的候选顺序**决定优先级**，与现有 `selectRejectTarget` 一致：显式 `rejectTarget`
  → 命中对应目标；未指定 → 取「最靠左」的上游目标。
- **重跑上限**：打回边在转移前先过一个 `retryable` 语义的 guard：`context.attempts[target] <
  maxRounds`；超限转 `#failed`（`reason:'max-rounds'`），与现状一致（现状是「目标节点 node/end
  failed + run failed」）。
- 未知 verdict / 结构不合法的输出**不得**当 pass（沿用 06 §13 的严格口径）：转 `#failed`。

### 3.3 上下文（context）只放可序列化数据

```
context = {
  attempts: { [nodeId]: number },   // 已用 attempt 次数（0 起）
  lastVerdict: 'pass' | 'reject' | 'fail' | null,
  rejectTarget: string | null,
  currentNodeId: string | null,
  finishedBy: 'pass' | 'fail' | 'max-rounds' | 'aborted' | 'timeout' | null,
  reason: string | null,
}
```

**不许**放会话对象、Promise、Buffer、Date 实例（XState 的 snapshot 必须 JSON 可序列化）。

## 4 事件表

| 事件 | 谁发 | 载荷 | 说明 |
|---|---|---|---|
| `NODE_STARTED` | 引擎 | `{nodeId, attempt}` | 仅观测（invoke 已经开始） |
| `PASS` / `REJECT` / `FAIL` | 引擎（由 `invoke` 的返回值驱动） | `{nodeId, verdict, rejectTarget?, summary}` | 由 `onDone` 内部产生，外部不直接发 |
| `CLOCK_TIMEOUT` | 引擎（现有闹钟 / run 墙钟） | `{kind:'run'|'node', nodeId?}` | 到点；机器只负责转到 `#failed` |
| `CANCEL` | 引擎（stop / 卸载 / abort） | `{reason}` | 转 `#aborted`，在飞 invoke 由引擎 abort |
| `INBOX` | 引擎（外部消息） | `{messageId, text}` | **不改变状态**，只交给 `runNode` 的下一轮提示词；机器上挂 `on: { INBOX: { actions: 'queueInbox' } }` 需要放行（XState 默认忽略未知事件，所以这条只为可观测） |
| `SELF_CHECK` | 引擎（节点自审回报） | `{state, progress, verdict}` | 只更新 context 里的观测字段，**不**触发转移（提前完成仍由引擎侧判定后发 PASS/REJECT） |

## 5 副作用边界（这是本册最重要的一节）

1. **机器里没有 I/O**。所有 `assign` 只写 §3.3 的 context；所有 `actions` 只往引擎的
   「待办队列」里塞条目（引擎每 tick drain 一次），不允许 `actions` 里发事件或写文件。
   XState 的 action 在恢复时不会重放，所以它们本来就不能承载「不可重复的副作用」。
2. **节点执行走 `invoke`**：引擎提供 `runNode(input)`，内部就是现有的「建会话 / 发提示词 /
   等 whenIdle / 解析结构化输出」。返回 `{verdict, rejectTarget?, summary, structured, evidence}`。
   `invoke` 在恢复时会被**重新启动**——所以引擎必须能判断「这个 attempt 是否已经有结论」：
   有结论就直接 `{verdict}` 返回（读 `run.json.nodeStatus` 或事件流），不重复执行。
3. **计时器不用 XState 的**：`after` 在实现里由引擎注入的 `clock` 驱动，或者干脆不写 `after`，
   由闹钟发 `CLOCK_TIMEOUT`。选后者：少一个时间语义来源，恢复时也不会重排一堆 timer。
4. **停止/卸载**：引擎 `abort` 在飞的 `invoke`，再 `send({type:'CANCEL'})`。

## 6 持久化、版本与恢复

`run.json.machine = { version, snapshot, savedAt }`（runstore 白名单 + 24 KiB 预算，超限裁剪并置
`machineTruncated`）。

`version` 的构成（**只包含影响转移的东西**）：

```
machineVersion = hash(
  'v1' + engineVersion +
  nodes.map(n => [n.id, n.kind, n.maxRounds ?? '']).join('|') +
  edges.map(e => [e.from, e.to, e.kind]).join('|')
)
```

不含标题、坐标、角色文案、skills、模型 —— 改这些不该让快照失效。

**恢复算法**（优先级从高到低）：

1. `machine.version === 本地编译出的 version` → `createActor(machine, { snapshot })`。
   若 XState 抛错（版本内部字段不兼容）→ 走 2。
2. **事件重放**：从事件流里取「转移类事件」（`node/end` 的 passed/rejected/failed、`run/start`、
   用户 stop），从初态依次 `send()` 出等价事件。重放到与事件流末尾一致的状态即可。
3. 都失败 → 该 run 收成 `failed`（`reason:'machine-restore-failed'`），**不要**假装继续跑。
   这条要写进 run/end 与日志，让 `flow_watch` 能看出来。

**事件流永远是真相**：`run.json.machine.snapshot` 只是缓存/加速。任何冲突以事件流为准；
这与 0.8.2 的「封口 + 事件 seq 单调 + repairRunCounters」口径一致。

**现实口径（0.9.0）**：当前引擎在**进程重启**时会把在跑的 run 收成 `failed`（0.8.x 既有语义，
本次不改），因此快照恢复 / 事件重放在生产路径上基本不会被触发，主要是模块级与单测覆盖
（`test/engine-machine.test.mjs`）；将来若支持重启续跑，恢复顺序按本节执行。

## 7 与现有实现的映射（谁改、谁不改）

| 层 | 变化 |
|---|---|
| `src/engine.js` 的 `_loop`（while + switch 推进） | **改**：换成 actor 驱动；节点执行仍调用现有函数（`_runNode` / `_promptNodeSession` / `_runExternalNode`） |
| `src/engine.js` 的 `_writeStructured` / 证据落盘 / 打回上下文 | 不变（由 `runNode` 的返回值照旧驱动） |
| `src/runstore.js` | **改**：`machine` 白名单（另一个 agent 在做） |
| 事件 kind | 不变。新增可选 `machine/transition` 事件（`from`/`to`/`event`/`version`），只作观测 |
| supervision / 节点闹钟 / 订阅 | 不变 |
| 画布 / 指标 / 收件箱 / 外部 executor | 不变 |

**灰度开关**：`FLOW_STUDIO_FLOW_MACHINE=0` 时回退旧 `_loop`（保留一个版本的逃生门），
默认开。等老 loop 在 0.9.x 里稳定一个发布周期后再删。

## 8 迁移步骤

1. **P1（本次）**：vendor xstate → `compileFlowToMachine` 纯函数 + 单测 → 引擎接 actor →
   `machine` 落盘与恢复（含不兼容走重放）→ 全量回归 + 容器 e2e。
2. **P2**：`edge.when`（条件分支）在编译期变成多条 guard 转移；画布出边标签与条件编辑器；
   `runlog` 增加 `edge/chosen` 事件；指标按分支聚合。
3. **P3**：并行 join（`parallel` states）：fork 到多个节点、join 时合并产物；失败聚合规则单独设计。
4. **P4（可选）**：BPMN 单向导出（只给业务方看，不引入运行时耦合）。

回滚点：P1 的灰度开关；P2/P3 各自的数据字段（`edge.when` 缺省无行为、`machine.version` 变则重放）。

## 9 验收

- `npm test` 全绿（基线 20 文件 / 713 组），其中 `engine.test.mjs`（97 组）是主回归。
- 新增 `test/flowmachine.test.mjs`：编译纯函数、版本哈希、守卫优先级、打回与上限、未知 verdict。
- 新增引擎用例：① 快照可恢复（中途停、恢复后继续到 done）；② 快照 version 不兼容 → 事件重放后
  仍到 done；③ 重放也失败 → `failed` + `reason:'machine-restore-failed'`；④ 灰度开关关掉 → 旧 loop 行为。
- 容器 e2e（0.8.x/0.9.0）：现有全部断言 + `run.json.machine` 存在且 `version` 与 flow 匹配。
- **证据必须来自真实文件**（run.json / 事件流），不接受只断言返回值。

## 10 否决记录

| 候选 | 否决理由 |
|---|---|
| Temporal | 要服务端 + 确定性重放；LLM 节点适配层比状态机本身重 |
| Camunda 8 / Flowable / Zeebe | JVM + 集群 + BPMN XML，只为网关付整套引擎代价 |
| `bpmn-engine`（Node） | BPMN 2.0 子集 + XML 建模，收益同 Camunda 但维护面更小 |
| LangGraph JS | 依赖 LangChain 栈；checkpointer 与 run.json 重叠；要拿走执行循环 |
| 自研小状态机 | 分支/并行/持久化/重放都要自己补，等于重写 XState 的一个子集 |
| robot3 / javascript-state-machine | 无 `invoke`/`parallel`/持久化 |

## 11 风险

1. **XState v6 已进 beta**：锁 `^5`（vendored 固定 5.33.3），升级前必须重跑本册 §9 全套。
2. **actor 模型心智成本**：所有 I/O 必须留在 `invoke` 里；代码评审要盯「机器里有没有副作用」。
3. **快照与机器版本耦合**：靠 §6 的重放兜底；任何 `machine.version` 输入项变更都要在 CHANGELOG 里写明。
4. **调试**：XState 的 `inspect` API 可以接进日志抽屉做状态转移可视化（P2 可做）。
