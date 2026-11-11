# 10 · BPMN 实例 API（0.13）

> 本册定义 0.13.0 第一阶段交付的 **headless 引擎 + 定义/实例 HTTP API**：
> `bpmn-engine@26.0.6` 跑单实例，模板域（`definitions/`）与运行域（`instances/`）隔离，
> 新路由常开（没有灰度开关：旧路径不合规就替换，不做兼容双轨）。画布（bpmn.io）、dsh AgentAdapter、http connector、
> 新审计口径都不在本阶段。
>
> 实现：`src/bpmn-runtime.js`（路由 / 事件桥 / 懒恢复 / 服务处理器）、
> `src/bpmn-runner.js`（引擎适配）、`src/definition-store.js` / `src/instance-store.js`（存储）。
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

### 3.7 `GET /instances/<id>/events`

- 出参：`{ok:true, id, events:[…], lastSeq, skipped, shards}`。
- `events[]` 每条带全局 `seq`；`?since=N` 只返回 `seq > N` 的事件。
- 读侧宽容：坏行跳过并计入 `skipped`，不因一条坏事件让整条流 500。
- 错误：400（since 非整数）、404（实例不存在）。

### 3.8 `GET /instances/<id>/tasks`

- 内存里有 runner → 以 `runner.pendingTasks()` 为准；没有 → 以 `instance.json` 的
  `pendingTasks` 为准。
- 出参：`{ok:true, id, status, tasks:[{activityId, elementId, name, since, executionId}],
  recovered, recovery?}`。
- **GUI 与外部系统同一入口**；0.13.0 没有 assignee / 认领 / 表单，只有「谁在等人」。

### 3.9 `POST /instances/<id>/tasks/<activityId>/complete`

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

### 3.10 `POST /instances/<id>/stop`

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
| `SUSPENDED` | 被挂起（本轮只保留取值，suspend/resume 操作后续再加） |
| `CANCELED` | 被取消（`POST /instances/<id>/stop`） |

- **没有 `failed`，也没有 `blocked`/「卡住」状态**。用户口径（2026-11-11）：卡住不具备通用性，属于业务自己判别，引擎不做这个状态。
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

`instance.json` 字段：`status` / `pendingTasks[]` / `lastError|null` / `variables` / `result` / `artifacts[]`。

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

请求碰到一个不在内存里的实例时（`GET /instances/<id>`、`/tasks`、`complete` 等）：

1. 读 `instance.json`；终态 → **不恢复**，返回 `recovered:false` + 终态原因。
2. 读 `state.json`；缺失/空 → 返回 `recovered:false` + `BPMN_STATE_MISSING` 原因
   （GET 200；写操作 409 `BPMN_INSTANCE_NOT_RECOVERABLE`）。
3. 读实例自己的 `definition.bpmn`，重新 `parseBpmn` 得到 definition；
   快照损坏 → 500，不拿定义域的最新版来冒充。
4. 新建 `createBpmnRunner({definition, xml, instanceId, services, …})` 并 `recover(state)`；
   `state` 不是 `running/stopped` → `BPMN_STATE_NOT_RESUMABLE`，返回不可恢复原因。
5. 恢复成功后：事件流、`pendingTasks`、变量、状态都回到磁盘上的事实；
   `recovered:true` 只表示**本次请求**重建了 runner；后续请求命中内存注册表返回 `false`。

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
| `adapter:"codex"/"custom"` | 复用 `src/executor.js` 的 `runExternalExecutor`；`ctx.signal` / `attempt` / `variables` / `timeoutMs` 透传 | 失败时 `EXECUTOR_*` / `BPMN_ABORTED`（runner 外层包成 `BPMN_HANDLER_FAILED`） |
| http connector | **不实现真实 HTTP**（0.13.4） | `BPMN_HTTP_NOT_IMPLEMENTED` |
| parallel / inclusive 网关、多实例 | 解析期拒绝 | `PARALLEL_GATEWAY_FORBIDDEN` / `INCLUSIVE_GATEWAY_FORBIDDEN` / `MULTI_INSTANCE_FORBIDDEN` |
| 人工任务 TTL | 0.13.0 不做超时策略（不自动失败） | — |

`executeAgent` / `executeHttp` 签名固定为 **`(element, ctx)`** 两个参数；runner 的 ctx 是
变量快照（`attempt` / `variables` / `signal` / `timeoutMs`）。测试注入的桩 executor
只存在于 `createBpmnRuntime({executorRunner})` / createHandler env 的 `bpmnExecutor`，
生产路径默认 `runExternalExecutor`。

## 9 错误码与 HTTP 语义

| 状态 | 典型 code | 场景 |
|---|---|---|
| 400 | `BPMN_XML_INVALID` / `BPMN_DEFINITION_ID_INVALID` / `BPMN_BODY_INVALID` / `BPMN_VERSION_INVALID` / `BPMN_PAYLOAD_INVALID` / `INSTANCE_INVALID_ID` | 入参或 XML 不合法 |
| 404 | `DEFINITION_NOT_FOUND` / `DEFINITION_VERSION_NOT_FOUND` / `INSTANCE_NOT_FOUND` / `BPMN_TASK_NOT_FOUND` / `BPMN_ROUTE_NOT_FOUND` | 开关关着 / 资源不存在 |
| 405 | `BPMN_METHOD_NOT_ALLOWED` | 方法不匹配 |
| 409 | `BPMN_INSTANCE_TERMINAL` / `BPMN_INSTANCE_NOT_WAITING` / `BPMN_INSTANCE_FAILED` / `BPMN_INSTANCE_NOT_RECOVERABLE` / `DEFINITION_VERSION_IMMUTABLE` / `DEFINITION_STALE` / `INSTANCE_VERSION_CONFLICT` | 版本/并发/状态冲突 |
| 500 | `BPMN_EVENT_WRITE_FAILED` / `BPMN_STATE_WRITE_FAILED` / `BPMN_DEFINITION_INVALID` / `INSTANCE_CORRUPT` | 落盘或数据损坏（不静默） |
| 503 | `BPMN_HANDLER_MISSING` / `BPMN_LRU_EVICT_UNSNAPSHOTTED` / `BPMN_INSTANCE_ACTIVE_ELSEWHERE` / `BPMN_RUNTIME_DISPOSED` | 引擎不可用 |

开关关着时即使请求带只读令牌也返回 404（不是 403）：功能不存在，不是权限问题。
