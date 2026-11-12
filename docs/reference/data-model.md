# 数据模型

0.14.0 起只有两类数据：**BPMN 定义**（用户画的流程，按版本不可变）与**实例**（一次运行，钉住启动时的定义版本）。两者都在 `$DSH_HOME/flow-studio/` 下，目录 0700、文件 0600；没有另外的覆盖变量。

旧运行域的 `flows/<id>.json`、`runs/<runId>/`、`run.json` 与旧 worktree 布局属于历史数据：代码不再读取，磁盘上的旧目录也不会被自动删除（清理由独立维护动作负责）。当前定义 / 实例的目录布局、事件 kind 与字段的**唯一真相源**是 [design/10](../design/10-bpmn-instance-api.md)；本页只给当前落盘布局与字段速查。

## 根目录

```text
$DSH_HOME/flow-studio/
  definitions/<definitionId>/          # BPMN 定义，按版本不可变
  instances/<instanceId>/              # 实例（运行时 / 事件 / 收件箱 / 资源 / connector）
  instances/.locks/<instanceId>.lock   # 执行所有权 claim / release 的 flock 锚点（常驻，放在实例目录外）
  worktrees/<workspaceId>/<instanceId>/ # 实例级 git worktree
  worktree-registry/<workspaceId>/<instanceId>.json
  .tmp/                                # adapter 每次执行的私有临时目录（可回收）
```

## 定义

```text
definitions/<definitionId>/
  meta.json              # {id, name, description, tags, createdAt, updatedAt, latestVersion, latestHash, versions[]}
  v<version>.bpmn        # 该版本的原始 BPMN XML（写入后永不覆盖）
```

- 定义 id 与实例 id 走同一套路径 id 规则：`^[A-Za-z0-9._-]{1,64}$`，不是 `.` / `..`、不以点开头。
- 每次 `POST /definitions` 产生**新版本**；实例启动时把 `definitionId + definitionVersion + definitionHash` 钉进 `instance.json`，并复制一份 `definition.bpmn` 快照。定义改版不会改写已有实例。
- 同一 `(id, version)` 换内容会被存储层拒绝（409 `DEFINITION_VERSION_IMMUTABLE`）；当前 HTTP 路由不接受显式版本，版本号由存储层分配。
- 存储层提供 `deleteDefinition`（归档到 `definitions/.deleted/`，默认拒绝被实例引用的定义，`force` 后仍保留实例内的定义快照）；**当前 HTTP 路由不暴露删除入口**，定义不能通过 API 删除。

字段级契约见 [实例域接口 · 定义域](instance-api.md#定义域)。

## 实例

```text
instances/<instanceId>/
  instance.json          # 可变元数据（原子写；乐观锁 revision）
  definition.bpmn        # 启动时冻结的定义快照
  state.json             # BPMN 引擎状态快照（懒恢复用）
  owner.json             # 执行所有权记录（内部；见「内部字段与文件」）
  events/                # 执行事件分片（append-only；seq 单调）
  workspace.json         # 实例冻结的工作区快照
  resources/
    events.jsonl         # 资源事件（独立 resourceSeq）
    state.json           # { v, resourceSeq }
  inbox/
    messages.jsonl       # 入站消息
    replies.jsonl        # 回复 outbox
    bodies/<messageId>.<sha16>.txt
    .lock
  connector/
    <sha256>.json        # 每次逻辑激活的 connector 调用记录
    audit.jsonl          # 人工处置审计
```

`instance.json` 的稳定字段：

| 字段 | 含义 |
|---|---|
| `id` | 实例 id（与目录名一致） |
| `definitionId` / `definitionVersion` / `definitionHash` | 启动时钉住的定义版本与内容哈希 |
| `status` | `ACTIVE` / `COMPLETED` / `SUSPENDED` / `CANCELED`；**没有** `failed` / `blocked` |
| `variables` / `result` | 启动变量 / 最终结果（JSON 对象） |
| `artifacts[]` | `flow_finish_node` 登记的产物引用（`path` / `sha256` / `bytes` / `kind` / `title` / `nodeId` / `attempt`）；只存引用不存正文 |
| `lastError` | 执行错误 `{code, message, nodeId?, activityId?, retries?, reminders?}`；错误不是状态 |
| `executionFailure` | 已确认执行失败、禁止自动恢复的标记 `{code, message, at}`；**内部字段**，HTTP 响应不投影，对外用 `lastError` 与 `recovery.reason`（见「内部字段与文件」） |
| `lastAgentOutput` | 最近一次 agent 输出摘要（有界） |
| `pendingTasks[]` | 人工待办（`activityId` / `elementId` / `name` / `since` / `executionId`） |
| `revision` | 乐观锁版本；每次元数据写入 +1 |
| `eventCount` / `lastSeq` | 已落盘事件数 / 已分配的最大 seq（`lastSeq ≥ eventCount`） |
| `createdAt` / `updatedAt` / `completedAt` | 生命周期时间 |
| `startedBy` | 启动来源（人工 / 模型工具等，形状见 `src/instance-store.js`） |

实例状态只有四个；人工等待用 `pendingTasks` 表达，执行失败用 `lastError` 表达，**不伪造 failed 状态**（[design/10 · 实例状态](instance-api.md#实例状态)）。

## 内部字段与文件（不承诺对外稳定）

下面这些落盘字段 / 文件是**实现内部事实**，不参与 HTTP 契约的兼容承诺：字段名、形状与文件位置可能随版本调整，排障时按当前源码核对，不要把脚本钉死在这些形状上。

```text
instances/<instanceId>/
  owner.json             # 执行所有权：{pid, host, bootId, startTime, runtimeId, since}
  events/<activityId>/<attempt>.jsonl   # 事件正文（同一目录下可能出现已分配 seq 的空洞）
  state.json             # 引擎快照；执行失败停机时是 {kind, unrecoverable:{code,message,at}, engine:null} 的墓碑
instances/.locks/<instanceId>.lock      # claim / release 的跨进程 flock 临界区（常驻）
```

| 事实 | 落盘位置 | 形状与语义 |
|---|---|---|
| 执行所有权 | `owner.json`（0600，原子写）+ `instances/.locks/<instanceId>.lock` | `{pid, host, bootId, startTime, runtimeId, since}`。谁建出 runner（首次启动或懒恢复）谁登记；**登记 / 释放整段在 `instances/.locks/<instanceId>.lock` 的内核 `flock` 临界区里**（复用 `instance-resources.js` 的宿主 fd 实现，helper 死亡 fail-closed），所以两个进程不会同时从「没有 owner」各写一份。实例进入终态或 runtime `dispose` 时只删 `runtimeId` 相同的记录；`runtimeId` 不同不删。进程崩溃会留下记录：`pid` 不在 / 同 pid 但 starttime 或 bootId 变了 → 判定为 `gone`，允许接管；跨主机、旧格式、坏 JSON → `unknown`，保守拒绝（不按时间猜）；pid 存活但读不到 starttime 按 `alive` 保守处理。对手是活进程 → 内部 409 `INSTANCE_OWNED_ELSEWHERE`，无法确认 → 409 `INSTANCE_OWNER_UNKNOWN`；锁最多等 10 秒，拿不到就 fail-closed |
| 执行失败禁止恢复 | `instance.json.executionFailure` | `{code, message, at}`（`at` 是 ISO 时间）。挂起期间发生的失败也会写它，`resume` 不清除；存在时懒恢复直接拒绝重建 runner（先摘掉缓存 runner 并交还所有权），`recovery.code` 取 `lastError.code`（缺省 `executionFailure.code`）。`complete` 冷路径（`resume` 之后）409 `BPMN_INSTANCE_BLOCKED` + `recoveryCode`（与热 runner 同口径；仍 `SUSPENDED` 时先 `INSTANCE_SUSPENDED`）；其它无法重建 runner 的情形（state 缺失 / 墓碑 / 定义损坏）才是 409 `BPMN_INSTANCE_NOT_RECOVERABLE` + `recoveryCode` |
| 不可恢复墓碑 | `state.json` 的 `unrecoverable` | `{unrecoverable:{code,message,at}, engine:null}`；懒恢复遇到它零派发并给明确错误码。`clear-tombstone` 只删墓碑（并把 `executionFailure` 置 `null`），不恢复引擎 |
| 生命周期时间 | `instance.json.completedAt` | 只有终态才有值；挂起 / 恢复提交时写 `null`。`suspendedAt` / `resumedAt` **不落盘**，它们是响应字段，等于对应事件的 `at` |
| 事件水位 | `instance.json.lastSeq` / `eventCount` | 已分配的 seq 上限 / 已提交的事件条数；生命周期切换与事件追加都先提交这两个值，再追加事件正文，所以磁盘上 `lastSeq` 可能大于可见事件数（读侧报 `eventLogGap`）。读侧游标只到**连续可见水位**（第一个缺口之前），不是本批可见事件的最大 seq；`eventLogGap{allocated, visible, missing?, skipped?, unstable?, retries}` 由 `readInstanceSnapshot()` 固定已分配水位、分片 size/mtime 复核与 3 次有界重试后给出 |
| 消息投递权 | `inbox/replies.jsonl` 的 `dispatch` | `{token, at, attempt, owner:{pid, host, bootId, startTime, at}}`；接管判据与执行所有权同一套（`instance-owner.js` 的 `ownerState()`），确认不了就保持 in-flight，不按 TTL 猜 |

## 事件与收件箱

实例事件与资源事件的 kind、信封、分片与顺序规则在 [design/10](../design/10-bpmn-instance-api.md)。本页不复述 kind 表；只强调三条落盘约束：

- 单条事件 ≤ 8 KiB、单批 ≤ 200 条（`src/storage-contract.js` 的 `MAX_EVENT_BYTES` / `MAX_BATCH_EVENTS`），超限 400。
- `seq` 在实例锁内先写 `lastSeq` 再追加事件；进程崩溃 / 追加失败会留下「已分配但不可见」的 seq。读侧按**连续可见水位**（第一个缺口之前）推进游标，并把缺口报成 `eventLogGap{allocated, visible, missing?, skipped?, unstable?, retries}`（`GET /instances/<id>/events`）；缺口之后仍可见的事件会照常返回，所以 `?since=lastSeq` 可能重复返回它们，但不会跳过缺失 seq。
- 收件箱正文 > 阈值时只存头部并物化全文到 `inbox/bodies/`；`bodyPath` 是实例目录内的安全相对路径。

## Worktree

实例 worktree 根是 `$DSH_HOME/flow-studio/worktrees/<workspaceId>/<instanceId>`，所有权记录在 `worktree-registry/`。

- 实例创建 / 启动时按 `worktree` 策略决定是否创建；创建失败如实记录原因，不假装已隔离。
- 收尾**不自动删**：用户可能还要进去看产物。删除走 `DELETE /instances/<id>/worktree`（可连带删分支），孤儿清理走 `GET/POST /instance-worktrees` 的 list / prune。
- 路径必须落在 `<root>/<workspaceId>/` 下；prune 只碰 `flow/` 前缀分支，绝不碰用户分支。

完整路由、参数与孤儿判定见 [实例域接口 · worktree](instance-api.md#实例-worktree)。

## 延伸阅读

- 定义 / 实例接口：[实例域接口](instance-api.md)
- 设计契约：[design/10](../design/10-bpmn-instance-api.md) · [design/11](../design/11-node-finish-tool.md) · [design/12](../design/12-instance-metrics.md) · [design/13](../design/13-instance-evidence.md)
- 旧运行域（历史资料）：[design/05](../design/05-run-log.md) · [design/06](../design/06-execution-engine.md)
