# 10 · BPMN 实例 API（0.13）

> 本册定义 0.13.0 第一阶段交付的 **headless 引擎 + 定义/实例 HTTP API**：
> `bpmn-engine@26.0.6` 跑单实例，模板域（`definitions/`）与运行域（`instances/`）隔离，
> 新路由常开（没有灰度开关：旧路径不合规就替换，不做兼容双轨）。画布（bpmn.io）、dsh AgentAdapter、http connector、
> 新审计口径都不在本阶段。
>
> 实现：`src/bpmn-runtime.js`（路由 / 事件桥 / 懒恢复 / 服务处理器）、
> `src/bpmn-runner.js`（引擎适配）、`src/definition-store.js` / `src/instance-store.js`（存储）。
> 当前路由与字段的契约参考见 [实例域接口](../reference/instance-api.md)；本册只保留设计记录，不维护第二份字段表。
> 计划与红线见 [0.13 计划](../plan/0.13-bpmn引擎与适配器.md) §2 / §3 / §10。

## 1 目标与非目标

**目标**

1. 一条 prefix 路由（`/api/flow-studio`）下新增 10 条定义/实例 API，沿用现有鉴权、
   只读令牌与同源校验，不另写一套。
2. 模板与实例**不同目录、不同 id 空间、不同生命周期**；实例启动时冻结
   `definitionId + version + hash`，模板后续被改/被删不影响已启动实例。
3. 进程重启后能按 `state.json` 懒恢复并继续推进；状态不可恢复时**不假装成功**。
4. 事件流是观测面：每次 `process/start|activity/*|flow/taken|process/end|error`
   都落盘（按 `activityId/attempt` 分片），事件写入失败必须让请求可见。

**非目标（0.13.0）**

- 画布编辑 / 表单 / 任务认领 / assignee：只提供「谁在等人」的 `pendingTasks`。
- dsh 适配器（AgentAdapter + hooks）：0.13.1。
- http connector：0.13.4。
- 并行 / 包容网关：解析期直接拒绝（上游 #204，并行汇聚 + 成环会提前通过）。
- 新事件流接老 `audit.js`：审计口径 0.13.1 重写，0.13.0 不把新实例塞进老审计。

## 2 目录与领域隔离

传入的 `dir` 通常是老的 `flows/` 目录；运行时取它的父目录作为 flow-studio 根，
因此新目录与 `flows/`、`runs/` 平级：

```
$DSH_HOME/flow-studio/
  flows/                                  # 老模板域（0.12.x，原样保留）
  runs/                                   # 老运行域（0.12.x，原样保留）
  definitions/<definitionId>/
    meta.json                             # { id, name, versions[], latestVersion, latestHash… }
    <version>.bpmn                        # BPMN 2.0 XML 正本（sha256 进 meta）
  instances/<instanceId>/
    instance.json                         # 钉住 definitionId/version/hash + status/variables/pendingTasks
    definition.bpmn                       # 启动时复制的定义快照（只读它）
    state.json                            # bpmn-engine 快照（{savedAt, state}）
    events/<activityId>/<attempt>.jsonl   # append-only 事件分片
```

硬规则：

- **不写进老的 `flows/`**；新定义只走 `definitions/`。
- 实例只读自己的 `definition.bpmn`，不回头问定义域；定义被删仍能恢复。
- `seq` 由 `instance-store` 在实例锁内先分配再追加，跨分片全局单调（允许崩溃空洞，不重复）。

## 3 路由总表

所有路由都在 `/api/flow-studio` 下，鉴权 / 只读令牌 / 同源校验走 `route()` 开头现有逻辑：
只读令牌只能 GET；`complete` / `stop` 是写操作。开关关着时 `definitions` 与 `instances`
老路由在画布替换（0.13.3）之前暂时保留，替换后删除。

| 方法 | 路径 | 作用 | 成功状态 |
|---|---|---|---|
| GET | `/definitions` | 列定义（含每份版本列表与最新 hash） | 200 |
| POST | `/definitions` | 保存新版本 `{id?, name, xml}` | 201 |
| GET | `/definitions/<id>` | 版本元数据 + 指定版本 XML（`?version=`） | 200 |
| POST | `/instances` | 建实例并启动 `{definitionId, definitionVersion?, variables?}` | 201 |
| GET | `/instances` | 列表（`?definitionId=&status=&limit=`） | 200 |
| GET | `/instances/<id>` | 详情（状态、变量、pendingTasks、lastSeq、recovered） | 200 |
| GET | `/instances/<id>/events` | 事件流（按 seq 升序，支持 `?since=`） | 200 |
| GET | `/instances/<id>/tasks` | 当前待办人工任务 | 200 |
| GET | `/instances/<id>/definition` | 实例定义快照（冻结 XML，只读实例自己的 `definition.bpmn`） | 200 |
| POST | `/instances/<id>/tasks/<activityId>/complete` | 完成人工任务 `{payload?, decidedBy?}` | 200 |
| POST | `/instances/<id>/stop` | 中止实例 | 200 |

### 3.1 `GET /definitions`

出参：

```json
{ "ok": true, "definitions": [{
  "id": "flow-demo", "name": "演示流程", "description": "", "tags": [],
  "createdAt": "…", "updatedAt": "…",
  "versionCount": 2, "latestVersion": 2, "latestHash": "…",
  "versions": [{ "version": 1, "hash": "…", "createdAt": "…", "bytes": 2048 }]
}]}
```

错误：400（store 查询参数异常）、500（内部错误）。

### 3.2 `POST /definitions`

入参：

```json
{ "id": "flow-demo", "name": "演示流程", "xml": "<?xml …?>" }
```

- `id` 可省略：从 `bpmn:process@id` 或 `name` 推导小写 slug；显式 `id` 必须是
  `checkRunId` 能接受的字符（字母/数字/点/下划线/连字符，≤64，不以点开头）。
- 先 `parseBpmn(xml)` 校验；`ok:false` 直接 400，**不落盘**：
  `400 {ok:false, code:'BPMN_XML_INVALID', error, errors:[{code,message,…}], warnings:[]}`。
- 同一份 XML 再存一次是**新版本**（不传 version 时 store 在最大版本上 +1），
  只有显式 `version` 相同且 hash 不同才 409 `DEFINITION_VERSION_IMMUTABLE`。
- 出参：`{ok:true, id, version, hash, created, warnings}`。

错误：400（body / xml / id 非法）、409（显式版本不可变）、500/503（存储/引擎侧）。

### 3.3 `GET /definitions/<id>`

- 不带 `?version=`：返回 `latestVersion` 对应的元数据 + XML。
- 带 `?version=1`：返回该版本 XML；不存在 404 `DEFINITION_VERSION_NOT_FOUND`。
- 出参：`{ok:true, id, name, description, tags, createdAt, updatedAt, latestVersion,
  latestHash, versions, version, hash, bytes, xml}`。
- 错误：400（id/version 非法）、404（定义或版本不存在）、500（hash 对不上等损坏）。

### 3.4 `POST /instances`

入参：

```json
{ "definitionId": "flow-demo", "definitionVersion": 2, "variables": { "amount": 7 } }
```

- `definitionVersion` 省略 = 最新版；启动时把 `definitionId + version + hash` 钉进
  `instance.json`，并复制 `definition.bpmn`。
- 启动后跑到第一个等待点或结束。成功出参：

```json
{ "ok": true, "id": "i-…", "status": "waiting",
  "pendingTasks": [{ "activityId": "human1", "elementId": "human1", "name": "人工审批",
                     "since": "…", "executionId": "human1_…" }],
  "lastSeq": 9, "definitionId": "flow-demo", "definitionVersion": 1,
  "definitionHash": "…", "recovered": false }
```

- 若 start 阶段 handler 失败 / 条件非法，实例已存在，仍返回 201，`status:"ACTIVE"`（错误记进 `lastError`）并在
  `error` 里带 `{code,message}`（进程失败不是「接口没建成」）；实例详情的
  `result.error.code` 保留 handler 的真实错误码（如 `BPMN_AGENT_ADAPTER_UNAVAILABLE`），
  不让 runner 外层的 `BPMN_HANDLER_FAILED` 盖掉。
- 引擎不可用（handler 注册缺失 / 活跃表冲突 / LRU 淘汰未快照）→ 503。

错误：400（body/definitionId/version/variables 非法）、404（定义或版本不存在）、
409（definitionHash 与调用方声明不一致 = `DEFINITION_STALE`）、500/503。

### 3.5 `GET /instances`

- `?definitionId=`、`?status=`（`ACTIVE|COMPLETED|SUSPENDED|CANCELED`）、`?limit=`
  （默认 200，封顶 1000）。
- 出参：`{ok:true, instances:[{…instance.json, active:boolean}], skipped:[…]}`。
- `active` = 当前内存注册表里是否还有该实例的 runner。

### 3.6 `GET /instances/<id>`

- 内存里没有 runner 且实例非终态时**懒恢复**（见 §7），出参：

```json
{ "ok": true, "id": "i-…", "status": "waiting", "variables": {…},
  "pendingTasks": [{…}], "lastSeq": 9, "eventCount": 9, "revision": 18,
  "runnerStatus": "waiting", "recovered": true,
  "recovery": { "reason": "…", "code": null } }
```

- 终态或无法恢复时不报 500：`recovered:false` + `recovery.reason`（可读原因）。
- 错误：400（instanceId 非法）、404（不存在）、500（state/定义快照损坏）。

### 3.7 `GET /instances/<id>/definition`

- 返回实例启动时复制的定义快照，供实例画布（只读 `NavigatedViewer`）渲染。
- 只读实例目录里的 `definition.bpmn`：**不读定义域**，因此定义新增版本、被删除、
  甚至定义域目录缺失都不影响结果；也不能拿定义域最新版冒充实例快照。
- 出参：

```json
{ "ok": true, "id": "i-…", "definitionId": "flow-demo",
  "definitionVersion": 1, "definitionHash": "…", "xml": "<?xml …?>" }
```

- 这是只读请求：不创建 runner、不触发懒恢复、不改实例状态（终态实例同样可读）。
- 错误：400（instanceId 非法 = `BPMN_INSTANCE_ID_INVALID`）、
  404（实例不存在 = `INSTANCE_NOT_FOUND`）、405（非 GET = `BPMN_METHOD_NOT_ALLOWED`）、
  500（快照缺失 / 损坏 = `INSTANCE_SNAPSHOT_MISSING` / `INSTANCE_SNAPSHOT_CORRUPT`）。
  快照读取不产生 409；若 store 以后为它引入 409，沿用既有业务码，不另造新码。

### 3.8 `GET /instances/<id>/events`

- 出参：`{ok:true, id, events:[…], lastSeq, skipped, shards}`。
- `events[]` 每条带全局 `seq`；`?since=N` 只返回 `seq > N` 的事件。
- 读侧宽容：坏行跳过并计入 `skipped`，不因一条坏事件让整条流 500。
- 错误：400（since 非整数）、404（实例不存在）。

### 3.9 `GET /instances/<id>/tasks`

- 内存里有 runner → 以 `runner.pendingTasks()` 为准；没有 → 以 `instance.json` 的
  `pendingTasks` 为准。
- 出参：`{ok:true, id, status, tasks:[{activityId, elementId, name, since, executionId}],
  recovered, recovery?}`。
- **GUI 与外部系统同一入口**；0.13.0 没有 assignee / 认领 / 表单，只有「谁在等人」。

### 3.10 `POST /instances/<id>/tasks/<activityId>/complete`

入参：

```json
{ "payload": { "approved": true }, "decidedBy": "alice", "executionId": "可选，用于同 activity 多执行时消歧" }
```

- `payload` 是人工任务输出，会并入实例变量；`decidedBy` 是审计字段，若 payload 里没有
  `decidedBy` 就自动并入（不另造事件）。
- 出参：`{ok:true, id, status, pendingTasks, lastSeq, activityId, executionId, decidedBy, recovered}`。
- 完成 = `runner.signalTask({activityId, executionId, payload})`；返回时已跑到下一个
  等待点 / 终态。
- 错误：400（activityId/payload 非法）、404（实例/任务不存在 = `BPMN_TASK_NOT_FOUND`）、
  409（实例终态 / 非 waiting / 失败 / 无法恢复）、500（事件或快照写入失败）。

### 3.11 `POST /instances/<id>/stop`

- 中止在飞 handler + 停引擎，实例收成 `aborted`，清空 `pendingTasks`，写 `completedAt`。
- **不追加伪造事件**：不会写 `process/end`，也不会重复已有的 `activity/wait`。
- 重复 stop 幂等：200 + `alreadyTerminal:true`，返回当前终态。
- 错误：400（instanceId 非法）、404（不存在）、500/503（收口失败 / 引擎不可用）。

## 4 实例状态（对齐 Camunda，只有 4 个）

新引擎**没有状态机**，`instance.json.status` 只是普通持久字段，由 runtime 按事件直接写。

状态取值与 [Camunda 8 的 `ProcessInstanceState`](https://raw.githubusercontent.com/camunda/camunda/main/search/search-domain/src/main/java/io/camunda/search/entities/ProcessInstanceEntity.java) 一致：

| 状态 | 含义 |
|---|---|
| `ACTIVE` | 活着：正在跑、停在人工任务、或出错后停住等人处理，**都是 ACTIVE** |
| `COMPLETED` | 走到结束事件、正常完成 |
| `SUSPENDED` | 被 `POST /instances/<id>/suspend` 挂起：没有在飞活动，不推进、不派发；`POST /instances/<id>/resume` 回到 `ACTIVE` |
| `CANCELED` | 被取消（`POST /instances/<id>/stop`，`SUSPENDED` 上同样可用） |

- **没有 `failed`，也没有 `blocked`/「卡住」状态**。用户口径（2026-11-11）：卡住不具备通用性，属于业务自己判别，引擎不做这个状态。
- `SUSPENDED` 的进入条件（0.14.3 引入 quiesce 式软挂起，0.14.4 扩到「准备窗口 / 未完成事件提交 / 跨进程执行所有权」）：实例 `ACTIVE` 且没有在飞活动——没有在跑 agent、runner 不在执行、没有排队中的事件提交、实例不在首次创建 / 工作区准备窗口、connector 记录里没有 `started` / `sent` / `unknown`、也没有另一个活进程持有执行所有权。任一未结算 → 409 `INSTANCE_SUSPEND_BUSY`，不改状态、不写事件。挂起写 `instance/suspended`（含 `reason`），保留 `pendingTasks`，不杀 runner、不重放；之后 `_ensureRunner()` 跳过、`complete` 409 `INSTANCE_SUSPENDED`、入站消息排队、`GET` 不因读而恢复。字段级契约（`activities[]` 的 kind / 字段）归 [实例域接口 · 挂起 / 恢复](../reference/instance-api.md#挂起与恢复)。
- `SUSPENDED` 的离开条件：`POST /instances/<id>/resume` 置回 `ACTIVE` + 写 `instance/resumed`（不主动跑，下一次推进沿用懒恢复；只翻磁盘事实、不检查执行所有权）；`POST /instances/<id>/stop` 直接收成 `CANCELED`。`SUSPENDED` 是受保护状态：期间执行事件追加、引擎快照写入、`COMPLETED` 收口都被拒，状态也不能被晚到写入改回 `ACTIVE`（错误事实通道除外，见 [§10](#10-并发模型01440146)）。终态不可逆，`COMPLETED` / `CANCELED` 上挂起 / 恢复一律 409。
- `running` / `waiting` 不是状态：它们是 runner 的内部执行态，不写进 `instance.json.status`；「在等人」用 `ACTIVE` + `pendingTasks` 非空表达。
- 引擎内部出错（条件求值错、活动/整轮超时、handler 失败、adapter 不可用、提醒用尽、连线超限/循环护栏）时：`status` **保持 `ACTIVE` 不变**，同时写 `lastError{code,message,nodeId?,activityId?,retries?}` 并发 `error` 事件；是否重试/终止/继续，由业务或人决定，引擎不替它判「卡住」。
- 终态只有 `COMPLETED` 与 `CANCELED`。

runner 内部执行态（不对外当实例状态）：

| runner.status() | 实例 status |
|---|---|
| `idle` | `ACTIVE`（未启动或已停住） |
| `running` | `ACTIVE` |
| `waiting` | `ACTIVE` + `pendingTasks` 非空 |
| `done` | `COMPLETED` |
| `blocked`（内部错误态） | `ACTIVE` + `lastError` |

`instance.json` 字段：`status` / `startedBy|null` / `pendingTasks[]` / `lastError|null` / `variables` / `result` / `artifacts[]`。

## 5 事件 kind 表

> 归属：本表是 **0.13.0 新增的实例事件流**（`instances/`）的唯一真相源；老的 run 事件契约仍以 `05-run-log.md` 为准（描述 `runs/`），两者覆盖不同目录、不重叠。等 0.13.x 收口时再决定是否合并成一份。

| kind | 源 | 关键字段 | 落盘 / 副作用 |
|---|---|---|---|
| `process/start` | runner | `at, elementId(processId), activityId` | 事件 + 实例 running |
| `activity/start` | runner | `at, elementId, activityId, attempt?` | 事件 + 实例 running；attempt +1 |
| `activity/end` | runner | `at, elementId, activityId, durationMs, output?, usage?, artifacts?, status?, headers?` | 事件 + 实例 running + 刷新 `pendingTasks` |
| `activity/wait` | runner | `at, elementId, activityId` | 事件 + 实例 waiting + `pendingTasks` |
| `flow/taken` | runner | `at, flowId, from, to, condition:{expression,value}\|null` | 事件（不含状态写入） |
| `process/end` | runner | `at, elementId, activityId` | 事件 + `status=COMPLETED` |
| `instance/suspended` | runtime（挂起路由） | `at, status:"SUSPENDED", reason?` | 事件 + `status=SUSPENDED`；状态与本次的 seq / `eventCount` / `revision` 在同一次 `instance.json` 写入里提交，事件正文随后追加 |
| `instance/resumed` | runtime（恢复路由） | `at, status:"ACTIVE", reason?` | 事件 + `status=ACTIVE`；同样是元数据先提交、正文随后追加（恢复不推进、不派发） |
| `error` | runner | `at, elementId?, activityId?, error:{code,message,elementId?,activityId?}` | 事件 + 实例 `lastError`（**status 仍是 ACTIVE**） |
| `agent/log` 等 | handler `events[]` | handler 自定义 | 原样透传（runner 禁止保留类型） |

落盘规则：

- 分片路径 `events/<shardActivityId>/<attempt>.jsonl`；`shardActivityId` 取
  `elementId`（没有则 `flowId`、再退 `process`），非法字符替换为 `_`，≤64。
- `attempt` 按「本实例内该 element 的 activity/start 次数」计；非活动事件用当前 element
  的 attempt，没有则 1。恢复后的新实例从 1 重新计（只影响分片命名，不影响路由）。
- 每条事件由 store 分配全局 `seq`；事件写入是**逐条串行链**，失败记进 `_eventFailures`，
  操作收口时以 `BPMN_EVENT_WRITE_FAILED` 返回（runner 的 `_safeCall` 会吞异常，这里不能吞）。
- 单条事件上限 8KB（store 硬约束）。超过时桥接层递归裁剪字符串、丢掉可选字段并标
  `truncated:true`；仍超限则退化成只保留 `type/at/elementId/activityId` 的最小事件。
  事件流是观测面，不能因为 agent 输出大就让实例失败。
- 0.13.0 **不写** `task/wait` 事件：人工任务等待就是 `activity/wait`，避免同一事实两条记录。

## 6 环境变量与 health

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `FLOW_STUDIO_BPMN_MAX_ACTIVE` | `100` | 活跃实例 LRU 上限（透传 runner `maxActiveInstances`） |
| `FLOW_STUDIO_BPMN_ACTIVITY_TIMEOUT_MS` | 不设 | 单活动超时；不设则只受 run 时限 / signal 控制 |

开关关着：


- `GET /health` 只回 `bpmn: { enabled: false }`，**不创建运行时、不建新目录**；
- 老 `/flows`、`/runs`、`/health` 等行为不变。

开关打开后 `GET /health`：

```json
"bpmn": { "enabled": true, "engine": "26.0.6", "definitions": 2, "instances": 5, "active": 1 }
```

计数**每次现算**（`listDefinitions` + `listInstances` + 内存注册表），不缓存常量；
`active` 只算 runner 处于 `running` / `waiting` 的实例，终态与已淘汰的不算。

## 7 懒恢复语义

请求碰到一个不在内存里的实例时（`GET /instances/<id>`、`/tasks`、`complete` 等；`GET /instances/<id>/definition` 只读快照，**不触发恢复**）：

1. 读 `instance.json`；终态 → **不恢复**，返回 `recovered:false` + 终态原因。
2. `status:"SUSPENDED"` → **不恢复**，返回 `recovered:false` + `BPMN_STATE_SUSPENDED`、`runnerStatus:null`；
   `pendingTasks` 仍按磁盘事实返回。读挂起实例不会创建 runner，更不会推进（0.14.3）。
3. 读 `owner.json`：被另一个**活着**的进程持有 → **不恢复**，`recovered:false` +
   `BPMN_INSTANCE_ACTIVE_ELSEWHERE`；所有权记录读不出 / 无法确认（跨主机、坏 JSON、`state:"unknown"`）→
   `BPMN_OWNER_UNKNOWN`。两种情况都保守拒绝，不靠时间猜（0.14.4）。
4. **claim 执行所有权**（0.14.6）：除非磁盘记录已属于本 runtime 且 `alive`，否则调用
   `claimInstanceOwner()` 在 `instances/.locks/<instanceId>.lock` 的内核 `flock` 临界区里
   重新读旧记录、判定、原子替换；拿不到就按 `INSTANCE_OWNED_ELSEWHERE` /
   `INSTANCE_OWNER_UNKNOWN` 拒绝，投影成第 3 步的两个恢复码。claim 在读 state / 定义、
   建 runner、`recover` **之前**完成；此时还没有任何派发。
5. `instance.json.executionFailure` 存在 → **不恢复**：先摘掉并停止缓存 runner，再交还本进程的
   `owner.json`（失败标记落盘后缓存 runner 不能再当一致缓存），返回 `blocked:true`；
   `recovery.code` 取 `lastError.code`（缺省 `executionFailure.code`）。实例 `resume` 之后，`complete`
   冷路径 409 `BPMN_INSTANCE_BLOCKED` + `recoveryCode`，与热 runner 同口径（仍 `SUSPENDED` 时先返回 `INSTANCE_SUSPENDED`）。
6. 到此才看内存缓存：`_runners` 里有非 `idle` 的 runner → 直接复用（不再读 state / 定义、不 `recover`）。
7. 读 `state.json`；缺失/空 → 返回 `recovered:false` + `BPMN_STATE_MISSING` 原因
   （GET 200；写操作 409 `BPMN_INSTANCE_NOT_RECOVERABLE`），并交还所有权。
8. `state.json` 带 `unrecoverable` 墓碑 → 不恢复，`recovery.code` 取墓碑错误码（缺省
   `BPMN_STATE_UNRECOVERABLE`）；交还所有权。
9. 读实例自己的 `definition.bpmn`，重新 `parseBpmn` 得到 definition；
   快照损坏 → 500，不拿定义域的最新版来冒充。
10. 准备完成、建 runner / `recover` **之前**，从磁盘重新读一次 `instance.json` 准入（0.14.6）：
    终态 → 不恢复、不派发（交还所有权）；`SUSPENDED` → 不恢复、不派发，
    `BPMN_STATE_SUSPENDED`（交还所有权）。准备期间别的进程提交的挂起 / 终态在这里被拦下。
11. 新建 `createBpmnRunner({definition, xml, instanceId, services, …})` 并 `recover(state)`；
    `state` 不是 `running/stopped` → `BPMN_STATE_NOT_RESUMABLE`，返回不可恢复原因并交还所有权。
12. 恢复成功后：事件流、`pendingTasks`、变量、状态都回到磁盘上的事实；
    `recovered:true` 只表示**本次请求**重建了 runner；后续请求命中内存注册表返回 `false`。
    所有权已在第 4 步登记，不再写第二遍。

`resume` 只改状态 + 写事件，**不建 runner**；恢复后的第一次 `complete` / `GET` 推进才走上面的懒恢复。

关键细节：

- `recover` 会把停在 `activity/wait` 的活动**重放一次** `activity/wait`（runner 已知坑 g）。
  运行时按 state 里的 `pendingTasks[].executionId` 去重，事件流不会出现重复 wait。
- 恢复点由运行时在每次操作收口后显式 `getState()` 一次并写 `state.json`（wait/end 后），
  runner 的自动快照关掉，避免同一点取两次 7–18KB 快照；`getState()` 仍会更新 runner
  内部的 `_lastState`，LRU 淘汰检查照常能拒绝「未快照就被淘汰」。
- 同一实例的 complete / stop / 懒恢复走同一把进程内异步锁，`_eventChains` 再保证事件
  逐条串行；两个并发 complete 只有一个成功，另一个拿到 409。

## 8 0.13.0 边界（明确失败，不伪造能力）

| 能力 | 0.13.0 行为 | 错误码 |
|---|---|---|
| `adapter:"dsh"` 或缺失 | 明确失败；不创建子会话、不造假 handler | `BPMN_AGENT_ADAPTER_UNAVAILABLE`（文案说明 0.13.1 提供 AgentAdapter + hooks） |
| 未知 adapter | 明确失败 | `BPMN_AGENT_ADAPTER_UNSUPPORTED` |
| `adapter:"dsh"/"codex"` | 注册过的适配器走 AgentAdapter + `flow_finish_node` 完结门 | 未注册 / 无注册表：`BPMN_AGENT_ADAPTER_UNAVAILABLE`（节点零派发） |
| `adapter:"custom"` | 明确失败；custom 外部 executor 不再是 agent 完结路径 | `BPMN_AGENT_ADAPTER_UNSUPPORTED`（节点零派发） |
| http connector | **不实现真实 HTTP**（0.13.4） | `BPMN_HTTP_NOT_IMPLEMENTED` |
| parallel / inclusive 网关、多实例 | 解析期拒绝 | `PARALLEL_GATEWAY_FORBIDDEN` / `INCLUSIVE_GATEWAY_FORBIDDEN` / `MULTI_INSTANCE_FORBIDDEN` |
| 人工任务 TTL | 0.13.0 不做超时策略（不自动失败） | — |

`executeAgent` / `executeHttp` 签名固定为 **`(element, ctx)`** 两个参数；runner 的 ctx 是
变量快照（`attempt` / `variables` / `signal` / `timeoutMs`）。测试注入的假 adapter 只存在于
`createBpmnRuntime({adapters})` / createHandler env 的 `bpmnAdapters`；BPMN 域没有外部
executor 回退路径（`custom` 与缺注册表都明确失败）。

## 9 错误码与 HTTP 语义

| 状态 | 典型 code | 场景 |
|---|---|---|
| 400 | `BPMN_XML_INVALID` / `BPMN_DEFINITION_ID_INVALID` / `BPMN_BODY_INVALID` / `BPMN_VERSION_INVALID` / `BPMN_PAYLOAD_INVALID` / `INSTANCE_INVALID_ID` | 入参或 XML 不合法 |
| 404 | `DEFINITION_NOT_FOUND` / `DEFINITION_VERSION_NOT_FOUND` / `INSTANCE_NOT_FOUND` / `BPMN_TASK_NOT_FOUND` / `BPMN_ROUTE_NOT_FOUND` | 开关关着 / 资源不存在 |
| 405 | `BPMN_METHOD_NOT_ALLOWED` | 方法不匹配 |
| 409 | `BPMN_INSTANCE_TERMINAL` / `BPMN_INSTANCE_NOT_WAITING` / `BPMN_INSTANCE_NOT_RECOVERABLE` / `BPMN_INSTANCE_BLOCKED` / `BPMN_INSTANCE_ACTIVE_ELSEWHERE` / `BPMN_OWNER_UNKNOWN` / `DEFINITION_VERSION_IMMUTABLE` / `DEFINITION_STALE` / `INSTANCE_VERSION_CONFLICT` / `INSTANCE_SUSPEND_BUSY` / `INSTANCE_SUSPENDED` / `INSTANCE_LIFECYCLE_CONFLICT` | 版本 / 并发 / 状态冲突；挂起、执行所有权与冷恢复语义见 [§10](#10-并发模型01440146) |
| 500 | `BPMN_EVENT_WRITE_FAILED` / `BPMN_STATE_WRITE_FAILED` / `BPMN_DEFINITION_INVALID` / `INSTANCE_CORRUPT` / `INSTANCE_SNAPSHOT_MISSING` / `INSTANCE_SNAPSHOT_CORRUPT` | 落盘或数据损坏（不静默） |
| 503 | `BPMN_HANDLER_MISSING` / `BPMN_LRU_EVICT_UNSNAPSHOTTED` / `BPMN_INSTANCE_ACTIVE_ELSEWHERE` / `BPMN_RUNTIME_DISPOSED` | 引擎不可用 |

开关关着时即使请求带只读令牌也返回 404（不是 403）：功能不存在，不是权限问题。

## 10 并发模型（0.14.4–0.14.6）

0.14.3 的挂起只解决了「单 runtime、正常收口」这一条路径；0.14.4 补的是**多进程 / 交错提交**下的账户一致。四条机制各管一件事，不能互相替代。

### 10.1 条件提交（CAS）

- 生命周期迁移（`instance/suspended` / `instance/resumed`）必须带**期望状态**：`appendInstanceEvents(..., {status, expectedStatus})`。带 `status` 不带 `expectedStatus` → 400 `INSTANCE_EXPECTED_STATUS_REQUIRED`（内部约束）；锁内比对失败 → 409 `INSTANCE_LIFECYCLE_CONFLICT`（带 `expectedStatus` / `actualStatus`），**零写入**：不分配 seq、不写事件行、不涨 `revision`。0.14.6 起路由把这两个字段都原样投影进 409 响应（此前 store 有 `expectedStatus`、路由只回 `actualStatus`）。
- 为什么不能「读一次状态再写」：写锁只覆盖单次写入，读—判断—写在两个进程之间仍有窗口。把期望状态带进同一次锁内比对，才能保证「一个迁移只发生一次」。两个进程同时挂起，只有一个赢；`stop` 抢先收口成终态时挂起拿 `BPMN_INSTANCE_TERMINAL` 而不是写一条挂起事件。
- 状态迁移只走生命周期路由：`updateInstance` 把 `SUSPENDED` 改回 `ACTIVE` → `INSTANCE_SUSPENDED_IMMUTABLE`；把非挂起实例改成 `SUSPENDED` → `INSTANCE_LIFECYCLE_USE_ROUTE`。这条限制没有「调用方自觉」的余地——绕过路由直接写 store 也会被拒。

### 10.2 执行所有权（跨进程）

- 谁建出 runner（首次启动或懒恢复）谁在实例目录写 `owner.json`（`{pid, host, bootId, startTime, runtimeId, since}`）；实例进入终态或 runtime `dispose` 时只删 `runtimeId` 相同的记录。本地锁、计数、内存集合都只覆盖单进程，**不能**当作跨进程执行互斥。
- **0.14.6 起 claim / release 本身是跨进程互斥的**：`claimInstanceOwner()` / `releaseInstanceOwner()` 的「读旧记录 → 判定 → 原子 rename / 删除」整段跑在 `instances/.locks/<instanceId>.lock` 的内核 `flock` 临界区里（复用 `instance-resources.js` 的宿主 fd 原语；helper 死亡 fail-closed），最多等 10 秒。0.14.4 的「读一遍再无条件写」正是审查里两个进程各写一份 owner、各派发一次的根因。
- **登记时机**：`POST /instances` 在 `createInstance()` 返回后、workspace 准备与首次启动**之前** claim，准备失败 / 首次启动被拒时在 `finally` 里交还；懒恢复在读 state / 定义、建 runner、`recover` **之前** claim，准备完成后还要从磁盘重读一次准入（§10.6）。因此准备窗口内的跨进程挂起看到的是活 owner，不再依赖对方进程内的 `preparing` 计数。`createInstance()` 落盘到 `owner.json` 落盘之间的极短窗口不在保证内。
- 存活判定按可验证事实分三态：`alive`（同主机 + pid 存活 + `/proc/<pid>/stat` 的 starttime 对得上；pid 存活但读不到 starttime 也按 `alive` 保守处理）、`gone`（pid 不存在 / starttime 变了 / 同 pid 但 bootId 不同）、`unknown`（跨主机、旧格式、坏 JSON、pid 非法）。只有 `gone` 允许接管；`unknown` 一律保守拒绝——**不按时间 TTL 猜**，因为「过了 N 秒」不能证明对方真的不在了。
- 拿不到所有权时：活进程持有 → 内部 409 `INSTANCE_OWNED_ELSEWHERE`，投影成 `BPMN_INSTANCE_ACTIVE_ELSEWHERE`；记录无法确认 → 409 `INSTANCE_OWNER_UNKNOWN`，投影成 `BPMN_OWNER_UNKNOWN`。两条路径都在 `recover` / `signalTask` / adapter 之前退出。同进程其它 runtime 允许接管（`runtimeId` 不同但 `pid` 相同），由进程内活跃表的 `BPMN_INSTANCE_ID_CONFLICT` → 503 兜底。
- 效果：别的活进程持有时，挂起 409（`activities[]` 的 `kind:"owner"` 点名 pid / host / since），懒恢复拒绝建第二个 runner（`recovery.code` = `BPMN_INSTANCE_ACTIVE_ELSEWHERE` / `BPMN_OWNER_UNKNOWN`）。这解决的是「A 在跑、B 挂起成功，随后 A 继续推进」的原始缺陷：B 现在根本挂不上；即使挂上了，A 的事件写入也会被 store 闸门挡掉（§10.3）。
- 限定：同机、本地文件系统、所有进程都使用 0.14.6 及以后（claim 互斥）的协议。跨主机、NFS / SMB 共享目录、不写 `owner.json` 的旧进程都在保证外；没有 util-linux `flock` 的平台降级为进程内队列，跨进程互斥不成立。非 Linux 平台读不到 starttime，只剩 pid 存活判定（pid 复用可能误判 `alive`，方向偏保守）。

### 10.3 事件提交闸门（`SUSPENDED` 是受保护状态）

挂起提交后，下面三条写入路径在 store 层被拒，且都是**零写入**：

| 路径 | 挂起下的行为 |
|---|---|
| 执行事件追加（无 `status`、非错误事实） | 409 `INSTANCE_SUSPENDED`，零写入；运行时把已排队事件撞上的这次拒绝捕获后**丢弃**，并在 `_eventDiagnostics` 记一条有界诊断（不补写、不伪造） |
| 引擎快照写入（`state.json`） | 409 `INSTANCE_SUSPENDED`；唯一例外是 `{kind, unrecoverable:{…}, engine:null}` 形状的错误墓碑（`allowWhileSuspended` 只认这个形状） |
| 收口成 `COMPLETED` | 409 `INSTANCE_SUSPENDED`；`CANCELED`（stop）始终可用 |

错误事实通道是**唯一的**写穿口：`recordExecutionFailure()` 用 `allowWhileSuspended` + 强制 `type:"error"`，一次提交写 error 事件 + `lastError` + 清空 `pendingTasks` + `executionFailure`。理由：挂起期间发生的失败已经发生，把它丢掉会让实例在恢复后带着**失效的待办**继续，比「挂起期间多了一条事实」危险得多。`resume` 只解除挂起，不清 `executionFailure`，所以恢复后完成人工任务会得到 `BPMN_INSTANCE_BLOCKED`。

### 10.4 部分提交语义

- `appendInstanceEvents` 是两阶段写入：**①** 在实例锁内把状态 / `lastSeq` / `eventCount` / `revision` / `metaPatch` 一次原子写进 `instance.json`；**②** 再追加事件正文到分片。两步之间崩溃或失败只会留下「已分配 seq、正文缺失」的空洞（不重复、不覆盖）。
- 生命周期路由遇到第 ② 步失败时**不用 500 撒谎**，也不用「磁盘最终状态 == 目标状态」推断提交：store 用两个内部错误码自证阶段——`INSTANCE_EVENT_APPEND_FAILED`（`committed:true` / `eventLogPending:true` / `firstSeq` / `lastSeq` / `status` / `revision` / `eventLogError`）与 `INSTANCE_METADATA_WRITE_FAILED`（`committed:false`）。路由**只认 `error.committed === true`**，返回 200 + `committed:true` + `eventLogPending:true` + `eventLogError`，`lastSeq` 取错误里的本次已分配水位；没有本次提交事实就照常抛错，绝不把别的请求的提交认成自己的。
- 缺失正文不自动补写：补写会把「重试」变成「重放」，而生命周期迁移已经生效。读侧用**连续可见水位**（`lastSeq`）与 `eventLogGap{allocated, visible, missing?, skipped?, unstable?, retries}` 暴露空洞，指标用 `event-log-gap` / `events-skipped` 降完整性。
- 崩溃语义的边界：实例写入没有 fsync，这里保证的是**进程崩溃**留下的 seq 空洞语义，不承诺整机断电后的持久性。

### 10.5 软挂起的边界

`SUSPENDED` 保证的是「不再推进、不再派发、不再接人工完成、不再追加执行事件」，**不是**「平台侧完全静止」：

- 不杀 runner、不做新快照、不冻结引擎内部状态；恢复依赖最后在等待点 / 运行中收口时写的 `state.json`。
- **不暂停计时器**：活动超时 / 整轮超时照常计时并触发，走错误事实通道。
- 不冻结平台侧 I/O：已进入 adapter 的消息投递无法回滚（如实记 `delivered` 并标 `deliveredWhileSuspended`），回复外发走 outbox、不在执行闸门内，HTTP connector 也没有跨进程派发屏障。
- 判忙是**检查点判定**：锁外先判、锁内复核，但「判忙通过」与「提交挂起」之间仍可能刚好开始一个活动。首次创建在 workspace 准备前先登记所有权，所以跨进程在准备窗口看到的是 `kind:"owner"`，不再依赖对方的 `preparing` 计数；`createInstance()` 落盘到 `owner.json` 落盘之间仍有极短窗口，极端交错下挂起仍可能插进首次创建，恢复后实例没有可恢复快照（`BPMN_STATE_MISSING`），需要人工处置。
- 字段级契约与「保证 / 不保证」清单归 [实例域接口 · 挂起能保证什么 / 不保证什么](../reference/instance-api.md#挂起能保证什么--不保证什么)；这里只记录机制与取舍。

### 10.6 派发前准入与冷恢复错误口径（0.14.6）

0.14.4 的所有权检查发生在 runner 建好之后，且 `_ensureRunner` 用进入时的旧快照继续 recover / 派发；准备窗口里别的进程提交的 `SUSPENDED` 只挡事件写入，挡不住下游 agent。0.14.6 把准入前置并补了最后一公里：

- **claim 先于准备**：懒恢复在读 state / 定义、建 runner、`recover` 之前完成跨进程 claim（§10.2）；创建路径在 workspace 准备之前 claim。拿不到所有权直接返回，不进入 handler。
- **准备完成后重读磁盘**：解析完定义、建 runner 之前重新 `readInstance()`；终态 → 不恢复、不派发并交还所有权；`SUSPENDED` → `BPMN_STATE_SUSPENDED`、不恢复、不派发并交还所有权。准备期间别的进程提交的挂起 / 终态在这里被拦下。
- **`complete` 的最后一道准入**：真正 `runner.signalTask()` 之前再从磁盘读一次；`SUSPENDED` → 409 `INSTANCE_SUSPENDED`，同时摘掉并停止缓存 runner、交还所有权；`_stopping` → 409 `BPMN_INSTANCE_STOPPING`；终态 → 409 `BPMN_INSTANCE_TERMINAL`。本轮零派发。
- **失败事实优先于缓存 runner**：`_ensureRunner` 先 claim，再看 `executionFailure`；一旦落盘，缓存 runner 会被摘掉并停止，`complete` 返回 409 `BPMN_INSTANCE_BLOCKED` + `recoveryCode`（取 `lastError.code` / `executionFailure.code`）。冷恢复路径与热 runner 同码，不再退化成 `BPMN_INSTANCE_NOT_RECOVERABLE`。其它不可恢复情形（state 缺失、墓碑、定义损坏、外部所有权）仍返回 `BPMN_INSTANCE_NOT_RECOVERABLE` + `recoveryCode`。
- **读侧同时收紧**：`GET /events` 用固定已分配水位 + 分片 size/mtime 复核 + 3 次有界重试；`lastSeq` 是连续可见水位（不是本批最大 seq），缺口带 `eventLogGap{allocated, visible, missing?, skipped?, unstable?, retries}`。字段级契约归 [实例域接口 · events](../reference/instance-api.md#get-instancesidevents)。
