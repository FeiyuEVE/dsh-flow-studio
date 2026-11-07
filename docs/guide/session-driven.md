# 在会话里开流程，让主 agent 自己盯着

不用先去画布点运行：在任意会话里让主 agent 直接开跑，它自己定时醒来自查「整条流水线是否正常运转」。

## 一次典型闭环

1. **列模板**：`flow_list` 看有哪些流程（返回 id / 名字 / 节点数 / 连线数，按更新时间倒序）。重名时用 id。
2. **开跑**：`flow_start` 在**当前会话**里启动 run。工具用当前会话的 Agent 作父会话（`request.parent = 当前会话`），节点会话因此继承本会话的工作区，不需要也不应该再选目录。启动成功后**自动开启内建 supervision**（`supervision.enabled=true`），到点由 runtime 唤醒本会话。
3. **被唤醒后审查**：调 `flow_watch`（`runId=返回的 runId`）读 run.json + 事件 + 流程模板，覆盖偏航 / 卡死 / 打回死循环 / 并发乱序 / 超时风险 / 质量结论，拿 `verdict / headline / progress / plan / currentNode / rejects / anomalies / quality / tokens / idleMs / recommended`。
4. **按结论收尾**：`verdict=healthy` 就安静结束本轮；出现异常或跑完（`done` / `failed` / `aborted`）才通知人。终态时 `supervision.nextCheckSeconds=null`，`alarmPrompt` 会写明不必再挂闹钟。
5. **需要干预时**：`flow_send_message` 往节点会话发消息、`flow_stop` 停止、`flow_supervise` 手动开关 supervision，`flow_worktrees` 清理孤儿 worktree。

## 工具一览

| 工具 | 作用 | 关键参数 / 返回 |
|---|---|---|
| `flow_list` | 列流程模板 | `limit`（默认 20，最大 100）；返回 `flows[]`，按更新时间倒序 |
| `flow_start` | 在当前会话里启动 run | `flowId` / `flowName` 二选一；`task` / `name`；`workspace`；`worktree`（`auto` / `on` / `off`）；`runTimeoutMs` / `nodeTimeoutMs`。返回 `runId`、`supervision`、`workspace` |
| `flow_watch` | 审查整个工作流（只读，不修复不停止） | `runId` 或 `runIds`（`runIds: string[]`，≤20，去重；二选一）。多 run 模式返回每个 run 一份结论 + 一份 `merged` 合并建议，同一次调用里每个 run 的事件只读一次 |
| `flow_stop` | 停掉这次运行 | `runId`；写 `run/end aborted`，不在运行中会返回可读原因 |
| `flow_restart` | 把失败 / 中止的 run 重启为**新 run** 并在原会话续跑 | `runId`（旧 run，必须 failed / aborted）、`note?`；返回 `newRunId` + `restart{fromRunId, attempt, startNodeId, skippedNodeIds, inheritedNodeIds}` |
| `flow_supervise` | 手动开 / 关某个 run 的内建定时自审 | `runId` + `enabled`；已收尾的 run 开启会被拒 |
| `flow_send_message` | 往流程收件箱发外部消息 | `runId?`、`nodeId?`、`text`（≤4000 字符）、`reply?`；返回投递方式 `injected` / `resumed` / `started` / `queued` |
| `flow_reply` | 节点里的 agent 回复「把消息发进流程的来源」 | `text`、`inReplyTo?`；按会话反查 run / node，不用手填 id |
| `flow_worktrees` | 列孤儿 worktree / 按 `keepRunIds` 回收 | `action: 'list' \| 'prune'`；连 `flow/<runId>` 分支一起删（只碰 `flow/` 前缀） |

参数与返回字段的完整契约见 [Host 接口](../reference/host-api.md#模型工具)；收件箱投递语义见 [收件箱与节点会话](inbox-and-sessions.md)。

## supervision 的默认值与回退

`flow_start` 启动成功后**默认开启内建 supervision**，到点由 runtime 唤醒发起会话，不需要再挂 `proactive_set`。返回值里的 `supervision.alarmPrompt` / `nextCheckSeconds` 从 0.5.0 保留，只在 `supervision.enabled=false`（引擎不支持 / 登记失败）时作为手动回退：用 `proactive_set` 的 `after_seconds=supervision.nextCheckSeconds` 挂上 `alarmPrompt`。

调度节奏（run 级）：`healthy 180s` / 异常 `60s` / `pending 30s`，终态停；连续 3 次唤醒失败关闭调度并写 `wake-failed`。同一发起会话的多个 run 会**合并成一次唤醒**（10 个 run 只发 1 条 followup），每会话 30 次/小时 + 最小间隔 120s，被限流的 run 保留 due 不丢。这些属于运行观察面，细节与节点闹钟的对比见 [可观测性](observability.md)。

## 工作区：不用手填，但必须能确定

- 模板存在 `$DSH_HOME/flow-studio/flows/`（全局）；`flow_start` 默认取当前会话的 `header.cwd` 作工作区，`engine.start` 再按 `worktree` 策略决定是否建隔离副本，最终写进 `run.json.workspace / worktree`。
- **工作区是必填的**（0.8.1 起）：`POST /runs`、`POST /runs/<id>/start`、`flow_start` 都要求显式给出，引擎不再回落服务进程的 `process.cwd()`；显式值与会话 cwd 都拿不到时 `flow_start` 直接失败。配置了 `FLOW_STUDIO_WORKSPACE_ROOTS` 时还必须落在允许的根目录内（realpath 比较）。
- **时限**：`flow_start` 与 `POST /start` 都可传 `runTimeoutMs` / `nodeTimeoutMs`（默认 2 小时 / 20 分钟），生效值写进 `run.json.limits`。长任务（>2 小时）必须显式调大 `runTimeoutMs`，否则开局就注定被超时收掉。
- **节点会话是顶层会话**（不是挂在父会话下的子 agent），它的 `cwd` 用 worktree 路径或工作区路径；外部 executor 同理。判据与释放规则见 [收件箱与节点会话](inbox-and-sessions.md#节点会话是顶层会话)。

## 失败后重启：新 run + 原会话续跑

`flow_restart`（HTTP 等价入口 `POST /runs/<runId>/restart`）不把旧 run 改回
running，而是**新建一个续跑 run**：

- 只接受 `failed` / `aborted`；`pending` / `running` 先等收尾或 `flow_stop`，
  `done` 不需要重启；
- 新 run 继承旧 run 的节点会话（同一个 node 复用原 sessionId，冷会话靠
  `agents.resume` 续跑），从旧 run 失败 / 中止的节点继续；
- 已完成节点不重跑，它们的 summary 与产物路径作为上游上下文注入；
- 旧 run 保持终态、事件一条不改；新 run 的 `restart.fromRunId` /
  `restart.attempt` / `startNodeId` / `skippedNodeIds` 可在 `run.json` 与
  `run/start.data.restart` 里核对（`attempt` = 第几次续跑）；
- 重启时按**当前流程结构**重算每节点工具集：结构加边 → 补挂
  `flow_node_reject`，删边 → 撤掉。

失败原因都可诊断：非终态 run、已成功 run、当前流程结构不合法、续跑起点被删、
宿主 `agents` 服务不可用（无法继承会话）都会返回中文 4xx / 503，而不是静默从零重跑。

## 节点会话的模型与 agent preset

节点会话走 `agents.create()` 时，引擎**永远显式**传成对的
`agentOptions = {provider, model}` 与 `meta.agentPreset`：

- 模型路由：节点显式 provider / model 优先，缺的一项由宿主 `agentDefaultModel`
  补齐；两边都拿不到 → 开跑前 503（文案说明「宿主未提供 agentDefaultModel，
  且节点未配置 provider/model」），不会创建注定首轮失败的会话；
- preset：节点 `agentPreset` > 本次 start 覆盖 > 引擎配置 > 流程级默认 >
  **`standard`** 兜底。0.2.2 宿主对没有 preset 的程序化会话给的是几乎没有工具的
  裸组合，所以这里不能留空；
- 生效值与来源写在 `node/start.data.agentPreset` / `agentPresetSource` 与
  `run.json.agentPreset`（`{value, source}`），画布 / 详情页可直接显示。

## 常见坑

- **同名流程**：`flowName` 精确匹配优先，再退不区分大小写；同名多份会失败并列出候选 id，改用 `flowId`。
- **同一个 runId**：0.7 起并发不设上限（不同 run 可以同时跑），唯一 409 是同一个 runId 已在跑。
- **structure 不合法**：流程不存在 / 不合法会在建 run 之前失败，不会建出半成品 run。
- **`flow_watch` 的 `runId` 省略**：取最近一次 run（按 `startedAt` 倒序）；想审多个 run 用 `runIds`，不要循环调单 run。
- **想知道节点此刻在干什么**：`flow_watch` 返回的 `nodeStatus` 是各节点最新自审状态（`state=blocked` 且连续两次进度不变时，`recommended` 里会多一句提示），不是原始事件。

## 延伸阅读

- HTTP 等价入口与令牌：[Host 接口](../reference/host-api.md)
- 事件与审计口径：[运行日志](../reference/run-log.md)、[design/06 §14](../design/06-execution-engine.md)
- 运行模型设计：[design/07](../design/07-runtime-0.7.md)
