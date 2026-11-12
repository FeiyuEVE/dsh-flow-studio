# 实例域接口

本页是 BPMN 定义域（`definitions/`）与实例域（`instances/`）的 HTTP 路由、参数、响应字段与当前行为契约，也是这些事实的唯一参考页。实现分布在 `src/bpmn-runtime.js`（路由 / 懒恢复 / 服务处理器）、`src/definition-store.js`、`src/instance-store.js`、`src/instance-inbox.js`、`src/instance-message-store.js`、`src/instance-worktree.js`、`src/connector-store.js`、`src/http-connector.js` 与 `src/instance-evidence.js`。设计记录与阶段边界见 [design/10](../design/10-bpmn-instance-api.md)、[design/13](../design/13-instance-evidence.md)。0.14.0 起旧运行域（`/flows`、`/runs`、`/worktrees`）已删除，已认证请求返回 404；本页是当前运行域的唯一路由参考。

## 前缀与鉴权

所有路由都挂在 `/api/flow-studio` 下，由一条 prefix 路由分发（`src/index.js`）。`definitions`、`instances`、`instance-worktrees`、`metrics` 四个第一段进入本页描述的 BPMN 处理器；`/health` 与 `/skills` 由 Host 层处理。旧 `/flows`、`/runs`、`/worktrees` 已删除：通过鉴权后返回 404，不做兼容跳转。在 BPMN 处理器内部，未知子路径返回 404 `BPMN_ROUTE_NOT_FOUND`，方法不匹配返回 405 `BPMN_METHOD_NOT_ALLOWED`。

鉴权、同源校验与令牌档位是 Host 层统一的一套：宿主 `connection.requestRejection` 先判 401 / 403（拿不到该服务时 fail-closed 503 `AUTH_SERVICE_UNAVAILABLE`），随后判同源，再进插件自己的令牌闸。这些判定不在 `src/bpmn-runtime.js` 里，而由 `src/index.js` 的 `route()` 在分发前统一完成；口径见 [Host 接口 · 鉴权](host-api.md#鉴权)，本页不复制。

只读令牌只按 HTTP 方法判定：任何非 GET 请求一律 403 `READ_ONLY_TOKEN`。这个边界不保证读接口零副作用：`GET /instances/<id>` 与 `GET /instances/<id>/tasks` 会触发懒恢复（`SUSPENDED` 除外：挂起实例的读只返回磁盘事实，不创建 runner；执行所有权被另一个活进程持有时同样不建 runner，见 [挂起能保证什么 / 不保证什么](#挂起能保证什么--不保证什么)），可能写 `state.json` 与事件；`/definition`、`/events`、`/worktree`、`/resource-events`、`/messages`、`/metrics`、`/evidence` 的 GET 只读磁盘或收件箱，不创建 runner。

请求体上限 2 MiB，达到即 413；原始路径出现空段或 `.` / `..` 段在进路由前就 400。成功响应一律是 `{ok:true, …}` 信封；业务失败一般是 `{ok:false, code, error}`，不过鉴权 / 同源 / 请求体解析这类入口级拒绝可能只有 `{ok:false, error}`（与 [Host 接口](host-api.md) 同口径）。部分失败额外带 `hint`、`recoveryCode`、`tasks` 等定位字段。

实例 id、定义 id 走同一套路径 id 规则：匹配 `^[A-Za-z0-9._-]{1,64}$`，且不是 `.` / `..`、不以点开头；BPMN 的 `activityId` 不参与落盘路径，只要求非空且 ≤128 字符。路径里的实例 id 不合法统一 400 `BPMN_INSTANCE_ID_INVALID`，定义 id 不合法统一 400 `BPMN_DEFINITION_ID_INVALID`（`POST /instances` 的 `definitionId` 用 `INSTANCE_INVALID_ID`，见下）。

## 路由总表

| 方法 | 路径 | 成功 | 作用 |
|---|---|---|---|
| GET | `/definitions` | 200 | 定义列表（含每份的版本摘要与最新 hash） |
| POST | `/definitions` | 201 / 200 | 保存 XML 为新版本 |
| GET | `/definitions/<id>` | 200 | 定义元数据与指定版本 XML |
| POST | `/instances` | 201 | 建实例并从定义快照启动 |
| GET | `/instances` | 200 | 实例列表 |
| GET | `/instances/<id>` | 200 | 实例详情（必要时懒恢复） |
| GET | `/instances/<id>/definition` | 200 | 实例冻结的 BPMN 定义快照 |
| GET | `/instances/<id>/events` | 200 | 执行事件流 |
| GET | `/instances/<id>/tasks` | 200 | 当前待办人工任务 |
| POST | `/instances/<id>/tasks/<activityId>/complete` | 200 | 完成人工任务 |
| POST | `/instances/<id>/stop` | 200 | 中止实例 |
| POST | `/instances/<id>/suspend` | 200 | 挂起实例（quiesce 式软挂起） |
| POST | `/instances/<id>/resume` | 200 | 恢复挂起实例（不主动推进） |
| GET | `/instances/<id>/metrics` | 200 | 单实例运行指标 |
| GET | `/metrics` | 200 | 跨实例指标汇总 |
| GET | `/instances/<id>/evidence` | 200 | 实例业务证据（claims / findings / 引用核对） |
| GET | `/instances/<id>/worktree` | 200 | 实例工作区 / worktree 检查结果 |
| DELETE | `/instances/<id>/worktree` | 200 | 删除实例 worktree（可连带删分支） |
| DELETE | `/instances/<id>/worktree/branch` | 200 | 只删实例分支 |
| GET | `/instance-worktrees` | 200 | 全部实例 worktree 清单（含孤儿） |
| POST | `/instance-worktrees/prune` | 200 | 预览 / 执行孤儿 worktree 清理 |
| GET | `/instances/<id>/resource-events` | 200 | 实例资源事件流 |
| POST | `/instances/<id>/messages` | 200 | 受理一条入站消息 |
| GET | `/instances/<id>/messages` | 200 | 收件箱分页 |
| GET | `/instances/<id>/messages/<messageId>/body` | 200 | 读消息正文全文 |
| POST | `/instances/<id>/messages/<messageId>/replies` | 200 / 409 / 502 | 写入并投递一条回复 |
| POST | `/instances/<id>/connector/<recordId>/resolve` | 200 | 人工处置一条 connector 调用记录 |

当前没有删除实例、列出回复 outbox、或读取 connector 调用记录的 HTTP 路由；对应能力只通过上表这些入口暴露。挂起 / 恢复是 0.14.3 新增的两条写路由（见 [挂起 / 恢复](#挂起与恢复)）。

## 定义域

### `GET /definitions`

实现：`src/bpmn-runtime.js` 的 `_listDefinitions()`。

不接受查询参数。响应：

```json
{ "ok": true, "definitions": [{
  "id": "flow-demo", "name": "演示流程", "description": "", "tags": [],
  "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z",
  "versionCount": 2, "latestVersion": 2, "latestHash": "…",
  "versions": [{ "version": 1, "hash": "…", "createdAt": "…", "bytes": 2048 }]
}]}
```

定义域扫描阶段读不出 `meta.json` 的定义会被直接跳过、不出现在列表里；列表阶段再读 detail 失败时，该条目仍出现，`latestHash` 为 `null`、`versions` 为空数组。两种情况都不会让整张列表 500。错误只有 500 `BPMN_INTERNAL_ERROR`（根目录不可读等）。

### `POST /definitions`

实现：`src/bpmn-runtime.js` 的 `_saveDefinition()`；版本写入在 `src/definition-store.js` 的 `saveDefinitionVersion()`。

请求字段只有三个，其它字段不生效：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `id` | string | 否 | 路径 id 规则；省略时从 `bpmn:process@id` 或 `name` 推导小写 slug（非小写字母 / 数字转 `-`、去首尾 `-`、截 60），仍推不出就用 `def-<base36 时间>` |
| `name` | string | 否 | 空串或省略时取解析出的定义名，再退 `id` |
| `xml` | string | 是 | 非空 BPMN 2.0 XML；保存前过 `parseBpmn()`，失败不落盘 |

保存语义：每次成功保存都是**新版本**，版本号取 `max(meta 里的最大版本, 磁盘上的最大版本文件) + 1`，旧版本的 XML 永不覆盖。同一份 XML 重复保存会得到一个新的版本号，不是幂等更新。响应：

```json
{ "ok": true, "id": "flow-demo", "version": 2, "hash": "…", "created": true, "warnings": [] }
```

`created:false`（HTTP 200）只出现在「同版本文件已在磁盘、内容一致，被本次写入认领」的恢复场景；正常新版本是 201。

失败：

| 状态 | code | 触发 |
|---|---|---|
| 400 | `BPMN_BODY_INVALID` | 请求体不是 JSON 对象 |
| 400 | `BPMN_XML_REQUIRED` | 缺 `xml` 或为空白 |
| 400 | `BPMN_XML_INVALID` | XML 解析 / BPMN 子集校验失败；响应带 `errors[]` 与 `warnings[]` |
| 400 | `BPMN_DEFINITION_ID_INVALID` | 显式 `id` 不合法 |
| 409 | `DEFINITION_LOCK_TIMEOUT` | 定义目录锁等待超时（另一个进程正在写） |
| 500 | `DEFINITION_CORRUPT` / `BPMN_INTERNAL_ERROR` | `meta.json` 与版本文件不一致、或落盘失败 |

当前路由不接受显式 `version`、`description`、`tags`，因此「同一版本换内容」的 409 `DEFINITION_VERSION_IMMUTABLE` 不由此入口产生；它是 `saveDefinitionVersion()` 的存储层约束。

### `GET /definitions/<id>`

实现：`src/bpmn-runtime.js` 的 `_readDefinition()`。

| 查询参数 | 类型 | 说明 |
|---|---|---|
| `version` | 整数 ≥1（字符串） | 省略或空串时取 `latestVersion`；非法 400 |

响应：

```json
{ "ok": true, "id": "flow-demo", "name": "演示流程", "description": "", "tags": [],
  "createdAt": "…", "updatedAt": "…", "latestVersion": 2, "latestHash": "…",
  "versions": [{ "version": 1, "hash": "…", "createdAt": "…", "bytes": 2048 }],
  "version": 2, "hash": "…", "bytes": 2048, "xml": "<?xml …?>" }
```

定义存在但一个版本都没有时，`version` / `hash` / `bytes` / `xml` 都是 `null`。错误：400 `BPMN_DEFINITION_ID_INVALID` / `BPMN_VERSION_INVALID`，404 `DEFINITION_NOT_FOUND` / `DEFINITION_VERSION_NOT_FOUND`，500 `DEFINITION_CORRUPT`。

## 实例域

### `POST /instances`

实现：`src/bpmn-runtime.js` 的 `_createInstance()`；实例元数据与快照由 `src/instance-store.js` 的 `createInstance()` 写入。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `definitionId` | string | 是 | 路径 id 规则；非法 400 `INSTANCE_INVALID_ID` |
| `definitionVersion` | 整数 ≥1 或数字字符串 | 否 | 省略 = 最新版本；非法 400 `BPMN_VERSION_INVALID` |
| `variables` | object | 否 | 默认 `{}`；非对象 400 `BPMN_VARIABLES_INVALID`，超过 256 KiB 400 `INSTANCE_SHAPE_INVALID` |
| `startedBy` | string | 否 | 启动实例的调用方会话 id（工具面自动填，≤200、无控制字符）；GUI 不传时落盘为 `null` |
| `workspace` | object | 否 | 省略 = 不建 worktree，节点用宿主默认工作区；字段见下 |

`workspace` 的形状：

| 字段 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `path` | string | 必填 | 非空、≤4096；按 `FLOW_STUDIO_WORKSPACE_ROOTS` 做 realpath allowlist 校验 |
| `worktree.mode` | `auto` / `on` / `off` | `auto` | `auto`：Git 仓库建树、非 Git 用原目录；`on`：非 Git 直接 400 `WORKSPACE_NOT_GIT`；`off`：用原目录 |
| `worktree.baseRef` | string | `HEAD` | 非空、≤200、无空白、不以 `-` 开头；创建时解析成 `baseCommit` 并冻结 |
| `worktree.cleanup` | `retain` / `on-terminal-clean` | `retain` | 见 [worktree 生命周期](#worktree-生命周期) |

实例先解析工作区、再建实例目录、再建 worktree，最后才启动；`mode:"on"` 的非 Git 工作区在实例创建之前就 400，不会留下一个起不来的实例。启动会一直推进到第一个等待点或终态。

成功响应：

```json
{ "ok": true, "id": "i-…", "status": "ACTIVE",
  "pendingTasks": [{ "activityId": "human1", "elementId": "human1", "name": "人工审批",
                     "since": "…", "executionId": "human1_…" }],
  "lastSeq": 9, "definitionId": "flow-demo", "definitionVersion": 1,
  "definitionHash": "…", "startedBy": "session-…", "recovered": false,
  "workspace": { "mode": "worktree", "workspaceId": "…", "effectiveRoot": "…",
                 "repositoryRoot": "…", "isGit": true, "isLinkedWorktree": false,
                 "cleanupPolicy": "retain",
                 "worktree": { "branch": "flow-instance/i-…", "baseCommit": "…",
                               "cleanupPolicy": "retain", "resourceState": "ready" } } }
```

`workspace` 仅在请求带了 `workspace` 时出现；`worktree` 在 `mode` 不是 `worktree` 时为 `null`。

启动阶段的 handler 失败不是「接口没建成」：实例已存在，仍返回 201，`status` 保持 `ACTIVE`，`lastError` 落盘，响应额外带 `error:{code,message}`（code 是 handler 的真实业务码，不是 runner 的包装码）。工作区建立失败则相反：实例被收成 `CANCELED` 并保留 `lastError`，响应是失败状态码与 `{ok:false, id, definitionId, code, error}`。

失败：

| 状态 | code | 触发 |
|---|---|---|
| 400 | `BPMN_BODY_INVALID` / `INSTANCE_INVALID_ID` / `BPMN_VERSION_INVALID` / `BPMN_VARIABLES_INVALID` / `BPMN_WORKSPACE_INVALID` / `BPMN_STARTED_BY_INVALID` | 请求体或字段非法 |
| 400 | `WORKSPACE_INVALID` / `WORKSPACE_MISSING` / `WORKSPACE_NOT_GIT` | `workspace.path` 解析失败 |
| 400 | `BPMN_DEFINITION_INVALID` | 实例快照未通过 BPMN 校验 |
| 403 | `WORKSPACE_NOT_ALLOWED` | 工作区不在 allowlist |
| 404 | `DEFINITION_NOT_FOUND` / `INSTANCE_WORKTREE_NOT_FOUND` | 定义 / 版本不存在，或主仓库目录不存在 |
| 409 | `INSTANCE_WORKTREE_CREATE_FAILED`（`path-exists` / `branch-conflict`） | worktree 路径或分支冲突 |
| 409 | `BPMN_INSTANCE_ACTIVE_ELSEWHERE` / `BPMN_OWNER_UNKNOWN` | 同一实例 id 已被另一个活进程启动并持有执行所有权 / `owner.json` 无法确认（claim 在 workspace 准备之前；实例已建但未启动，准备失败会释放） |
| 500 | `BPMN_STATE_WRITE_FAILED` / `BPMN_EVENT_WRITE_FAILED` / `BPMN_WORKSPACE_OPERATION_FAILED` / `INSTANCE_WORKTREE_CREATE_FAILED`（其它原因）/ `RESOURCE_*` / `BPMN_INTERNAL_ERROR` | 落盘、记录写入或建树失败 |
| 503 | `WORKSPACE_GIT_UNAVAILABLE` / `WORKSPACE_GIT_FAILED` / `INSTANCE_WORKTREE_GIT_UNAVAILABLE` / `BPMN_HANDLER_MISSING` / `BPMN_LRU_EVICT_UNSNAPSHOTTED` / `BPMN_INSTANCE_ACTIVE_ELSEWHERE` | Git 或引擎不可用 |

### `GET /instances`

实现：`src/bpmn-runtime.js` 的 `_listInstances()`。

| 查询参数 | 类型 | 说明 |
|---|---|---|
| `definitionId` | string | 精确过滤；非法 400 `INSTANCE_INVALID_ID` |
| `status` | `ACTIVE` / `COMPLETED` / `SUSPENDED` / `CANCELED` | 精确过滤；其它值 400 `INSTANCE_FILTER_INVALID` |
| `limit` | 正整数 | 默认 200，封顶 1000；非法 400 `BPMN_LIMIT_INVALID` |

响应：

```json
{ "ok": true,
  "instances": [{ "id": "i-…", "definitionId": "flow-demo", "definitionVersion": 1,
                  "definitionHash": "…", "status": "ACTIVE", "startedBy": "session-…", "variables": {},
                  "result": null, "artifacts": [], "lastError": null,
                  "pendingTasks": [], "revision": 4, "eventCount": 9, "lastSeq": 9,
                  "createdAt": "…", "updatedAt": "…", "completedAt": null,
                  "definitionSnapshot": "definition.bpmn", "active": true }],
  "skipped": ["i-broken"] }
```

列表按 `createdAt` 倒序。`active` 只看当前进程内存里是否登记了该实例的 runner，不读磁盘。读不出的实例目录进 `skipped[]`，不让整张列表 500。

### `GET /instances/<id>`

实现：`src/bpmn-runtime.js` 的 `_readInstance()`；懒恢复规则见 [读接口与懒恢复](#读接口与懒恢复)。

响应：

```json
{ "ok": true, "id": "i-…", "definitionId": "flow-demo", "definitionVersion": 1,
  "definitionHash": "…", "status": "ACTIVE", "startedBy": "session-…", "variables": { "amount": 7 },
  "result": null, "artifacts": [], "lastError": null, "pendingTasks": [{ "…": "…" }],
  "lastSeq": 9, "eventCount": 9, "revision": 18, "createdAt": "…",
  "updatedAt": "…", "completedAt": null, "runnerStatus": "waiting",
  "recovered": true }
```

`runnerStatus` 是 runner 内部执行态（`idle` / `running` / `waiting` / `done` / `blocked`），不是实例状态；没有 runner 时为 `null`。`recovered:true` 只表示本次请求重新建了 runner。终态、不可恢复、`SUSPENDED`、或执行所有权在另一个活进程手里时仍返回 200，`recovered:false` 并带 `recovery.reason`（可能带 `recovery.code`；挂起是 `BPMN_STATE_SUSPENDED`，外部所有权是 `BPMN_INSTANCE_ACTIVE_ELSEWHERE` / `BPMN_OWNER_UNKNOWN`）。

失败：400 `BPMN_INSTANCE_ID_INVALID`，404 `INSTANCE_NOT_FOUND`，500 `BPMN_STATE_READ_FAILED` / `INSTANCE_CORRUPT` / `BPMN_DEFINITION_INVALID` / `BPMN_STATE_WRITE_FAILED`。

### `GET /instances/<id>/definition`

实现：`src/bpmn-runtime.js` 的 `_readInstanceDefinitionSnapshot()`。

只读实例目录里的 `definition.bpmn`，核对它与 `instance.json.definitionHash` 一致后返回；不读定义域，不创建 runner，不触发懒恢复，不改实例状态（终态实例同样可读）。响应：

```json
{ "ok": true, "id": "i-…", "definitionId": "flow-demo",
  "definitionVersion": 1, "definitionHash": "…", "xml": "<?xml …?>" }
```

失败：400 `BPMN_INSTANCE_ID_INVALID`，404 `INSTANCE_NOT_FOUND`，405 `BPMN_METHOD_NOT_ALLOWED`，500 `INSTANCE_SNAPSHOT_MISSING` / `INSTANCE_SNAPSHOT_CORRUPT`。

### `GET /instances/<id>/events`

实现：`src/bpmn-runtime.js` 的 `_readEvents()`；读取器在 `src/instance-store.js` 的 `readInstanceEvents()`。

| 查询参数 | 类型 | 说明 |
|---|---|---|
| `since` | 非负整数 | 只返回 `seq > since` 的事件；非法 400 `BPMN_SEQ_INVALID` |

响应：

```json
{ "ok": true, "id": "i-…", "events": [{ "type": "activity/start", "seq": 3, "at": "…", "…": "…" }],
  "lastSeq": 9, "skipped": 0, "shards": 2, "eventsHash": "…" }
```

事件按全局 `seq` 升序；`skipped` 是坏行 / 读不出的分片计数，`shards` 是参与合并的分片文件数。

**读侧一致性（0.14.6）**：读取器 `readInstanceSnapshot()` 在开始读取时固定 `allocated = instance.json.lastSeq`，只返回 `seq <= allocated` 的事件；读分片前后各 `stat()` 一次，`size` / `mtimeMs` 变化、或分片里出现 `seq > allocated`、或 `allocated` 范围内有缺失，都会在 3 次有界重试内重读。因此返回的 `events` 不会混进读取期间新分配（`seq > allocated`）的事件；`allocated` 范围内迟到补写的正文若在复核窗口内出现，会触发重读，直到稳定或重试耗尽。

`lastSeq` 是**连续可见水位**（第一个缺口之前的最大 seq），不是 `instance.json.lastSeq` 这个「已分配」水位，也不是本批 `events` 里的最大 seq：生命周期切换与执行事件都是「先在实例锁里把 `lastSeq` / `eventCount` 提交进 `instance.json`，再追加事件正文」，两步之间、或正文永久缺失时，都会出现水位高于连续可见事件。响应在 `lastSeq < allocated`、有坏行、重试后仍不稳定时额外带 `eventLogGap`：

| 字段 | 含义 |
|---|---|
| `allocated` | 本次快照固定的已分配水位（`instance.json.lastSeq`） |
| `visible` | 实际可见事件的最大 seq（诊断用；可能大于 `lastSeq`） |
| `missing` | `allocated` 范围内读不到的 seq 列表（有缺口才出现） |
| `skipped` | 坏行 / 读不出的分片数（>0 才出现） |
| `unstable` | 3 次重试后分片仍在变 / 水位仍在推进（`true` 才出现） |
| `retries` | 本次实读的重试次数（0 表示第一次就一致） |

`events` 数组仍会包含缺口之后已可见的事件（例如 `[1..6, 8]` 而 `lastSeq=6`），所以用 `?since=lastSeq` 重读**不会跳过**缺失的 `7`，但会**重复返回**已经看过的 `8`。调用方应把 `lastSeq` 当可消费游标，把 `eventLogGap` 当「6 之后不可安全消费」的显式信号；缺口不会自动补写，持久缺口要人工核对分片。

`eventsHash` 是**规范化事件全文**的 sha256（键排序后的整条事件，覆盖 `seq` / `type` / `at` / `activityId` / `elementId` / `usage` / `observedBuckets` / `error` 等所有字段），供对账与指标缓存指纹使用；同一 `seq` / `type` / `at` 但正文被修正时 hash 也会变。它不是「事件正文完整」的证明——正文是否完整看 `eventLogGap` 与指标里的 `event-log-gap` / `events-skipped` reason。

事件 kind、字段与落盘分片规则的唯一真相源是 [design/10 §5](../design/10-bpmn-instance-api.md#5-事件-kind-表)，本页不复制。失败：400 `BPMN_INSTANCE_ID_INVALID` / `BPMN_SEQ_INVALID`，404 `INSTANCE_NOT_FOUND`。

### `GET /instances/<id>/tasks`

实现：`src/bpmn-runtime.js` 的 `_readTasks()`。

内存里有 runner 时以 `runner.pendingTasks()` 为准，否则以 `instance.json.pendingTasks` 为准；实例非终态且内存无 runner 时会尝试懒恢复（`SUSPENDED` 除外：挂起实例只返回磁盘待办，不创建 runner）。响应：

```json
{ "ok": true, "id": "i-…", "status": "ACTIVE",
  "tasks": [{ "activityId": "human1", "elementId": "human1", "name": "人工审批",
              "since": "…", "executionId": "human1_…" }],
  "recovered": false }
```

不可恢复时响应仍 200，带 `recovery:{reason, code}`。当前没有 assignee / 认领 / 表单 / TTL：这里只回答「谁在等人」。失败：400 `BPMN_INSTANCE_ID_INVALID`，404 `INSTANCE_NOT_FOUND`，500 `BPMN_STATE_READ_FAILED` / `INSTANCE_CORRUPT` / `BPMN_DEFINITION_INVALID` / `BPMN_STATE_WRITE_FAILED`。

### `POST /instances/<id>/tasks/<activityId>/complete`

实现：`src/bpmn-runtime.js` 的 `_completeTask()`。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `payload` | object | 否 | 人工任务输出，并入实例 `variables`；非对象 400 `BPMN_PAYLOAD_INVALID` |
| `decidedBy` | string | 否 | 审计字段；非空时在 `payload.decidedBy` 缺失时自动并入（不另造事件） |
| `executionId` | string | 否 | 同一 `activityId` 有多个待办时用于消歧 |

路径里的 `activityId` 非空且 ≤128，否则 400 `BPMN_ACTIVITY_ID_INVALID`。成功响应：

```json
{ "ok": true, "id": "i-…", "status": "ACTIVE", "pendingTasks": [],
  "lastSeq": 12, "activityId": "human1", "executionId": "human1_…",
  "decidedBy": "alice", "recovered": false }
```

返回时实例已经跑到下一个等待点或终态。

`recoveryCode` 是 409 拒绝时的失败原因（事件桥 / runner 的失败码），0.14.6 起热 runner 与冷恢复同一口径：

- `BPMN_INSTANCE_BLOCKED` + `recoveryCode`：runner 已 `blocked`（热路径），或磁盘上已有 `executionFailure` 且实例已 `resume` / 不在 `SUSPENDED`（冷路径，见[读接口与懒恢复](#读接口与懒恢复)）。冷路径不再返回 `BPMN_INSTANCE_NOT_RECOVERABLE`，失败原因不会因为进程重启而换码；实例仍 `SUSPENDED` 时先拿 409 `INSTANCE_SUSPENDED`，`resume` 之后才是 `BPMN_INSTANCE_BLOCKED`。
- `BPMN_INSTANCE_NOT_RECOVERABLE` + `recoveryCode`：`state.json` 缺失 / 空、不可恢复墓碑、定义快照损坏 / 不可反序列化、或执行所有权在别的活进程手里等「不能重建 runner」的情形。

真正进入 `runner.signalTask` 之前还有**最后一道磁盘准入**（0.14.6）：重新读 `instance.json`，`SUSPENDED` → 409 `INSTANCE_SUSPENDED`，stop 已置停止闩 → 409 `BPMN_INSTANCE_STOPPING`，终态 → 409 `BPMN_INSTANCE_TERMINAL`。这条准入命中时本轮零派发：不会进入下游 agent，也不会把缓存 runner 当成与磁盘一致。命中 `INSTANCE_SUSPENDED` 时还会摘掉并停止缓存 runner、交还执行所有权。

失败：404 `INSTANCE_NOT_FOUND` / `BPMN_TASK_NOT_FOUND`，409 `BPMN_INSTANCE_STOPPING` / `BPMN_INSTANCE_TERMINAL` / `INSTANCE_SUSPENDED`（实例已挂起，先 resume）/ `BPMN_INSTANCE_NOT_RECOVERABLE`（带 `recoveryCode`）/ `BPMN_INSTANCE_BLOCKED`（带 `recoveryCode`）/ `BPMN_INSTANCE_NOT_WAITING` / `INSTANCE_TERMINAL_IMMUTABLE`，500 `BPMN_EVENT_WRITE_FAILED` / `BPMN_STATE_WRITE_FAILED`。

### `POST /instances/<id>/stop`

实现：`src/bpmn-runtime.js` 的 `_stopInstance()`。

停止闩在实例写锁之外先置位，再 `runner.stop()` 中止在飞 handler，最后把实例落成 `CANCELED`：清空 `pendingTasks`、写 `completedAt`。停止**不追加伪造事件**（不写 `process/end`，也不重复已有的 `activity/wait`）。重复停止幂等：200 + `alreadyTerminal:true`，返回当前终态。

```json
{ "ok": true, "id": "i-…", "status": "CANCELED", "alreadyTerminal": false,
  "pendingTasks": [], "lastSeq": 12 }
```

终止时同时收尾收件箱：未投递的入站消息标 `failed`，未发送的回复标 `skipped`（见 [收件箱状态机](#收件箱状态机)；该收尾在 `COMPLETED` 时也会发生，但已受理的回复在 `COMPLETED` 后仍可投递）。失败：400 `BPMN_INSTANCE_ID_INVALID`，404 `INSTANCE_NOT_FOUND`，500 落盘失败。

### 挂起与恢复

实现：`src/bpmn-runtime.js` 的 `_suspendInstance()` / `_resumeInstance()` / `_commitLifecycleStatus()`；状态提交在 `src/instance-store.js` 的 `appendInstanceEvents(..., {status, expectedStatus})`；执行所有权在 `src/instance-owner.js`。

0.14.3 引入 **quiesce 式软挂起**（路线 1）：`bpmn-engine@26` 没有 pause 原语，所以挂起不碰引擎，只在**没有在飞活动**时改状态并写事件；不做「状态写 SUSPENDED、活动照跑」的半挂起。0.14.4 把提交改成**条件提交**、把 `SUSPENDED` 变成**受保护状态**，并把跨进程执行所有权纳入判忙。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `reason` | string | 否 | 短说明（≤200 字符、不含控制字符），原样写进 `instance/suspended` / `instance/resumed` 事件；省略 / 空串 → `null` |

挂起成功（200）：

```json
{ "ok": true, "id": "i-…", "status": "SUSPENDED", "reason": "窗口维护",
  "lastSeq": 13, "suspendedAt": "2026-11-12T00:00:00.000Z",
  "committed": true, "eventLogPending": false }
```

恢复成功（200）：`{ "ok": true, "id", "status": "ACTIVE", "reason", "lastSeq", "resumedAt", "committed": true, "eventLogPending": false }`。

语义：

- **挂起前置**：实例必须是 `ACTIVE`。以下任一成立 → 409 `INSTANCE_SUSPEND_BUSY`，响应带 `activities[]` 逐项点名：
  - `kind:"agent"`（`activityId` / `executionId` / `state:"running"`）：本进程有在飞 agent；
  - `kind:"engine"`：runner 正在执行；
  - `kind:"event-queue"`（`pending` / `state:"pending"`）：还有事件在排队 / 写盘——不能把「已出队」当成「已完成」；
  - `kind:"preparing"`（`pending` / `state:"preparing"`）：**本进程**仍在首次创建 / 工作区准备窗口（这段窗口挂起会打断首次启动，恢复后既没有 runner 也没有可恢复快照）。跨进程的同一窗口由 `kind:"owner"` 覆盖：实例目录一建好就先写 `owner.json`，再去准备 workspace；
  - `kind:"http"`（`activityId` / `executionId` / `state` / `attempts`）：connector 记录仍是 `started` / `sent` / `unknown`；记录读不出来时 `state:"unreadable"` 并带 `error`，按未结算处理（不把「无法确认」说成可以安全挂起）；
  - `kind:"owner"`（`pid` / `host` / `since` / `state`）：另一个持有执行所有权的进程。`state` 取 `alive` / `gone` / `unknown` / `unreadable`；`owner.json` 读不出来时 `state:"unreadable"` 并带 `error`。只有 `alive` 的外进程才算「有人正在执行」，否则按下面的所有权规则判。
  判忙在实例写锁**之外**先做一次（避免排在慢 agent / HTTP 请求后面，变成「活动结束后才挂起」），进锁后再复核一次；两次之间状态或活动变了，以锁内那次为准。
- **条件提交（CAS）**：生命周期提交必须带期望状态，在实例锁内与磁盘状态比对；期望不符 → 409 `INSTANCE_LIFECYCLE_CONFLICT`，带 `expectedStatus` / `actualStatus`，**一个字节都不写**（不分配 seq、不追加事件）。因此两个请求并发挂起时只有一个成功，另一个拿到冲突，不会产生两条 `instance/suspended`；`stop` 抢先收成终态时挂起返回 409 `BPMN_INSTANCE_TERMINAL`，不残留挂起事件。
- **一次元数据写入，事件正文随后追加**：`status` 与本次事件的 seq 区间、`eventCount`、`revision`（以及可选的 `lastError` / `pendingTasks` / `executionFailure` 补丁）在同一次 `instance.json` 原子写入里提交；事件正文随后追加到分片。所以这不是「状态与事件正文原子提交」：两步之间崩溃 / 写盘失败会留下已分配但不可见的 seq，读侧按水位与空洞处理（见 [`GET /instances/<id>/events`](#get-instancesidevents)）。
- **挂起动作**：状态置 `SUSPENDED` + 写 `instance/suspended`（含 `reason`），`pendingTasks` 保留；不杀 runner、不推进、不重放，之后不再派发活动，也不写新的引擎快照。
- **挂起期间是受保护状态**：
  - `GET /instances/<id>` / `GET .../tasks` 仍 200：`_ensureRunner()` 直接跳过（`recovery.code:"BPMN_STATE_SUSPENDED"`、`runnerStatus:null`），读不会懒恢复 / 推进；
  - 人工任务完成 → 409 `INSTANCE_SUSPENDED`（`COMPLETED` 收口同样被拒）；`stop` 仍可用，直接收成 `CANCELED`；
  - 执行事件追加 → 409 `INSTANCE_SUSPENDED`，同样一个字节都不写；运行时里已经排队的事件会被这道闸门拒绝，捕获后丢弃并记一条有界诊断（`_eventDiagnostics`，每实例最近 20 条），不补写、不伪造；
  - 引擎快照（`state.json`）写入 → 409 `INSTANCE_SUSPENDED`，唯一例外是下面的错误墓碑；
  - 元数据写入只走生命周期路由：把 `SUSPENDED` 改回 `ACTIVE` 被拒（`INSTANCE_SUSPENDED_IMMUTABLE`），把非挂起实例改成 `SUSPENDED` 也被拒（`INSTANCE_LIFECYCLE_USE_ROUTE`）；`lastError` / `pendingTasks` / `executionFailure` 等执行事实仍可写。
- **错误事实通道（唯一例外）**：挂起期间发生的执行失败（如活动超时）仍然落一条 `error` 事件 + `lastError` + 清空 `pendingTasks` + 记不可恢复标记 `executionFailure{code,message,at}`，并把引擎快照写成不可恢复墓碑。这道通道只放行 `type:"error"`，其它事件照旧被拒。`resume` 只解除挂起，**不清** `executionFailure`：此后完成人工任务 → 409 `BPMN_INSTANCE_BLOCKED`，恢复后不能接着跑；错误事实不会被静默丢弃，也不会因为 resume 而「看起来恢复正常」。
- **不暂停计时器（明确边界）**：挂起不冻结平台侧计时——活动超时 / 整轮超时照常触发，并走上面的错误事实通道。挂起期间发生的超时意味着实例恢复后不可继续。需要「绝对静默」的场景不适用软挂起。
- **恢复**：只允许 `SUSPENDED` → `ACTIVE`，写 `instance/resumed`；**不主动跑**（不建 / 不恢复 runner、不 drain 队列），下一次推进沿用既有懒恢复，wait 点不重放。恢复**不检查执行所有权**：它只翻磁盘事实，所以另一个进程也可以把挂起实例拉回 `ACTIVE`；原持有者下一次请求只认磁盘状态，不在内存里留「挂起闩」。
- **跨进程执行所有权（0.14.6 起互斥）**：谁建出 runner 谁在实例目录写 `owner.json`（`{pid, host, bootId, startTime, runtimeId, since}`），终态收口或 `dispose` 时只删自己写的那份（`runtimeId` 不符不删）。`claimInstanceOwner()` / `releaseInstanceOwner()` 的「读旧记录 → 判定 → 原子替换 / 删除」整段跑在 `instances/.locks/<instanceId>.lock` 的内核 `flock` 临界区里（复用资源锁的宿主 fd 实现）；拿不到锁最多等 10 秒后 fail-closed，不再出现「两个进程都读到空 owner、各写一份、各派发一次」。存活判定三态：`alive`（同主机、pid 存活且 starttime 对得上；pid 存活但读不到 starttime 也按 `alive` 保守处理）、`gone`（pid 不存在 / starttime 变了 / 同 pid 但 bootId 不同）、`unknown`（跨主机、旧格式 / 坏 JSON、pid 非法）；只有 `gone` 允许接管，`unknown` 保守拒绝。
  - **对手是活进程**：claim 直接抛 409 `INSTANCE_OWNED_ELSEWHERE`（不写盘、不派发）。runtime 把它投影成 `BPMN_INSTANCE_ACTIVE_ELSEWHERE`：挂起仍是 `INSTANCE_SUSPEND_BUSY`（`kind:"owner"`），懒恢复 `GET` 仍 200 并带 `recovery.code`，写操作（如 `complete`）409 `BPMN_INSTANCE_NOT_RECOVERABLE` + `recoveryCode`。
  - **记录无法确认**：坏 JSON / 跨主机抛 409 `INSTANCE_OWNER_UNKNOWN`（`state:"unknown"`），投影成 `BPMN_OWNER_UNKNOWN`，同样零派发；人工核对 / 删除 `owner.json` 后才能重新登记。
  - **同进程其它 runtime**：`owner.json` 的 `pid` 相同、`runtimeId` 不同时允许接管；进程内 runner 活跃表冲突仍由 `BPMN_INSTANCE_ID_CONFLICT` → 503 `BPMN_INSTANCE_ACTIVE_ELSEWHERE` 兜底，不构成跨进程双执行。
  - **创建即登记**：`POST /instances` 在 `createInstance()` 返回后、workspace 准备与首次启动**之前**就 claim；准备失败 / 首次启动被拒时在 `finally` 里交还自己写的那份。懒恢复也在读 state / 定义、建 runner、recover **之前** claim，准备完成后再从磁盘重读一次准入（见[读接口与懒恢复](#读接口与懒恢复)）。
  - **过期记录接管**：判定为 `gone` 时直接覆盖并返回 `previous`；同一 `runtimeId` 重复 claim 保留原 `since`，不制造时间漂移。
  - 已提交的 `SUSPENDED` 由 store 闸门兜底：即使某个进程手里还攥着旧 runner，它的推进事件与状态写回也会被拒（丢事件 + 记诊断），状态不会被悄悄写回 `ACTIVE`。
- **生命周期部分提交（0.14.6 只认本次提交事实）**：`appendInstanceEvents()` 的两阶段写入用 store 的 `InstanceError` 自证提交阶段——元数据已提交、事件正文追加失败时是 `INSTANCE_EVENT_APPEND_FAILED`（`committed:true` / `eventLogPending:true` / `firstSeq` / `lastSeq` / `status` / `revision` / `eventLogError`）；元数据本身没写成时是 `INSTANCE_METADATA_WRITE_FAILED`（`committed:false`）。路由**只在 `error.committed === true` 时**返回 200 + `committed:true` + `eventLogPending:true` + `eventLogError`（值为 store 错误码，如 `INSTANCE_EVENT_APPEND_FAILED`），`lastSeq` 取错误里的本次已分配水位；`committed:false` 或没有提交事实的错误照常抛 500，**绝不因为「磁盘最终状态恰好等于目标状态」就认领别的请求的提交**。重试不会补写那条缺失事件（状态已经切过去，重试拿到 409 `INSTANCE_NOT_SUSPENDED`），缺失由读侧 `eventLogGap` 暴露。

失败：

| 状态 | code | 触发 |
|---|---|---|
| 400 | `BPMN_BODY_INVALID` / `BPMN_REASON_INVALID` | 请求体不是对象 / `reason` 不是短字符串（含控制字符或超过 200 字符） |
| 404 | `INSTANCE_NOT_FOUND` | 实例不存在 |
| 409 | `INSTANCE_SUSPEND_BUSY` | 还有未结算的活动、准备窗口，或另一个活进程持有执行所有权（带 `activities[]`） |
| 409 | `INSTANCE_LIFECYCLE_CONFLICT` | 判忙之后、提交之前状态被别处改过（带 `expectedStatus` / `actualStatus`，零写入、无新事件） |
| 409 | `INSTANCE_ALREADY_SUSPENDED` | 对已 `SUSPENDED` 的实例再次挂起 |
| 409 | `INSTANCE_NOT_SUSPENDED` | 对非 `SUSPENDED` 实例恢复 |
| 409 | `BPMN_INSTANCE_TERMINAL` | 实例已 `COMPLETED` / `CANCELED`（终态不可挂起 / 恢复） |
| 409 | `BPMN_INSTANCE_STOPPING` | stop 已置停止闩、但实例还没收成终态 |
| 500 | `BPMN_INTERNAL_ERROR`（或 store 自己的 `InstanceError` 码） | 状态元数据写入失败；事件正文失败但状态已提交时不是 500，见「生命周期部分提交」 |

### 挂起能保证什么 / 不保证什么

**保证**

- 挂起提交后，**执行事件追加**、**引擎快照写入**、**人工任务完成（`COMPLETED`）**都被 store 拒绝；状态不会被晚到的写入改成 `ACTIVE`。同一实例并发挂起 / 恢复由条件提交收敛，输的一方拿 409，不产生重复生命周期事件。
- 挂起期间的读（`GET /instances/<id>`、`/tasks`、`/events`、`/metrics`…）不会因为读而恢复 / 推进；执行所有权在另一个活进程手里时，`GET` 也不会建第二个 runner。执行所有权的 claim / release 在跨进程 `flock` 临界区里完成，配合「准备完成 / `signalTask` 之前重读磁盘准入」，派发前看到 `SUSPENDED` / 终态时零派发。
- 挂起 / 恢复的响应如实区分「状态已提交」与「事件正文待补」（`committed` / `eventLogPending`）；只有 store 明确报告本次元数据已提交时才回 200。
- 挂起期间发生的执行失败事实（`error` 事件 + `lastError` + `executionFailure`）不会丢失，也不会被 `resume` 抹掉；冷恢复的 `complete`（`resume` 之后）与热 runner 同口径返回 `BPMN_INSTANCE_BLOCKED` + `recoveryCode`。

**不保证**

- 不杀 runner、不做新的引擎快照、不冻结引擎内部状态；恢复依赖最后在等待点 / 运行中收口时写的 `state.json`。软挂起不提供「精确续跑」的快照。
- **不暂停计时器**：活动超时 / 整轮超时照常计时并触发（见错误事实通道）。「挂起多久就多多少时间预算」不成立。
- 不冻结平台侧 I/O：已经进入 adapter 的消息投递无法回滚（见[收件箱状态机](#收件箱状态机)的投递门禁），已受理的回复外发仍可能完成（回复走 outbox，不在实例执行闸门内），HTTP connector 的发送也没有跨进程派发屏障。
- 判忙是**检查点判定**，不是派发前的硬栅栏：判忙在锁外先做、进锁再复核，「通过判忙」与「提交挂起」之间另一进程仍可能刚好开始一个活动。首次创建在 workspace 准备前先登记所有权，所以跨进程在准备窗口看到的是 `kind:"owner"`，不再依赖对方进程内的 `preparing` 计数；但 `createInstance()` 落盘到 `owner.json` 落盘之间仍有一次极短窗口（claim 之前），本页不承诺这段窗口不被挂起插进。极端交错下挂起仍可能让首次启动收口在 `INSTANCE_NOT_ACTIVE`，恢复后实例可能没有可恢复快照（`BPMN_STATE_MISSING`），需要人工处置。
- 跨主机不支持：`owner.json` 与 `.locks/` 只在**同机、本地文件系统、所有进程都使用 0.14.6 及以后协议**时构成互斥依据。`host` 不同、NFS / SMB 共享目录、以及仍按 0.14.3 / 0.14.4 协议运行（不写 `owner.json`，或 claim 不互斥）的进程都落在保证外；后一种情况只会被当成「没有所有权记录」。没有 util-linux `flock`（Windows / macOS / 部分沙箱）时 `withResourceLock` 降级为**进程内队列**，跨进程互斥不成立。非 Linux 平台读不到 `/proc` 的 starttime：pid 存活但 starttime 不可读时按 `alive` 保守处理（方向是拒绝接管，不是抢占；pid 复用可能误判 `alive`）。
- 所有权锁最多等 10 秒，拿不到就 fail-closed（不接管、不派发）；锁文件常驻、不删除，`instances/.locks/` 应放本地盘并视为 Host 私有目录。
- 恢复不主动 drain 排队消息；进程重启后没有 live execution 登记时，排队消息不会自动投递（既有收件箱行为）。

## 运行指标

只读接口，**不调用 `_ensureRunner()`**：看指标不会恢复 / 推进实例。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/instances/<id>/metrics` | 单实例指标：墙钟 / 挂起 / 人工等待、agent 调用与 token、finish_reminder、connector、节点执行数 / 当前活动 / 等待任务、数据完整性。`?asOf=ISO` 可选，用于确定性复算；非法时间 400 `METRICS_AS_OF_INVALID`。实例不存在 404 `INSTANCE_NOT_FOUND`。挂起时长只认 `instance/suspended` → `instance/resumed` 区间；磁盘状态与事件时间轴对不上（如状态已是 `ACTIVE` 但缺 `resumed` 事件）时是 `null` + `suspend-timeline-unavailable`，不是 0，口径见 [design/12](../design/12-instance-metrics.md) |
| GET | `/metrics` | 跨实例汇总。查询参数 `definitionId`、`definitionVersion`（≥1）、`from` / `to`（按实例 `createdAt` 的闭区间）、`status`（`ACTIVE` / `COMPLETED` / `SUSPENDED` / `CANCELED`）、`groupBy=day`、`asOf`。参数非法 400 `METRICS_FILTER_INVALID` / `METRICS_AS_OF_INVALID` |

口径（未知不是零、按 `callId` 去重、四桶归一化、cohort 与分位数、缓存失效）唯一来源是 [design/12-instance-metrics.md](../design/12-instance-metrics.md)；本表只列入口与参数。

`GET /metrics` 遍历 `instances/` 下全部实例，不用 `listInstances()` 的默认 limit；损坏实例计入 `totals.dataQuality.skippedInstances`，不中断整张汇总。

## 证据

实现：`src/bpmn-runtime.js` 的 `_readInstanceEvidence()`；解析与引用核对在 `src/instance-evidence.js` 的 `collectInstanceEvidence()`（纯函数）。语义唯一来源是 [design/13-instance-evidence.md](../design/13-instance-evidence.md)：什么算 `verified`、`fixed` 与 `verified` 的区别、来源与可信级别如何由宿主登记决定。

### `GET /instances/<id>/evidence`

只读，**不调用 `_ensureRunner()`**：查看证据不会恢复 / 推进实例。`?asOf=ISO` 可选，用于确定性观测；非法时间 400 `EVIDENCE_AS_OF_INVALID`。实例不存在 404 `INSTANCE_NOT_FOUND`。

证据报告由 `flow_finish_node.documents[]` 以 `kind:"evidence-report"` 登记；报告正文在文件里，`instance.json.artifacts[]` 只存 `path + sha256`。响应：

```json
{
  "ok": true,
  "schema": "flow-evidence/v1",
  "instanceId": "i-demo",
  "instanceStatus": "ACTIVE",
  "asOf": "2026-11-12T00:00:00.000Z",
  "claims": [{
    "id": "tests", "type": "test-result", "value": "passed",
    "source": "report-claim", "trust": "report-claim", "valueTrust": "report-claim",
    "executionId": "review_execution_7", "nodeId": "review", "attempt": 1,
    "reportPath": "evidence/report.json", "reportSha256": "…",
    "refs": [{ "path": "reports/tests.txt", "sha256": "…", "resolvedFrom": "artifact-snapshot", "verified": true }],
    "refsChecked": true, "conflict": false
  }],
  "findings": [{
    "id": "F-12", "status": "fixed", "declaredStatus": "fixed", "displayStatus": "verified",
    "verified": true, "refsChecked": true, "conclusion": "report-claim", "conclusionVerified": false,
    "executionId": "review_execution_7", "nodeId": "review", "attempt": 1,
    "refs": [{ "path": "reports/tests.txt", "sha256": "…", "resolvedFrom": "artifact-snapshot", "verified": true }],
    "conflict": false
  }],
  "verifiedRefs": [{ "path": "reports/tests.txt", "sha256": "…", "resolvedFrom": "artifact-snapshot", "claimIds": ["tests"], "findingIds": ["F-12"], "reportPaths": ["evidence/report.json"] }],
  "missing": [],
  "conflicts": [],
  "sourceExecutions": [{ "executionId": "review_execution_7", "nodeId": "review", "reportPaths": ["evidence/report.json"], "reportHashVerified": true, "source": "host-registration" }],
  "dataQuality": {
    "evidenceStatus": "present", "unknown": false, "stub": false,
    "reportCount": 1, "parsedReportCount": 1, "claimCount": 1, "findingCount": 1,
    "verifiedRefCount": 1, "missingCount": 0, "conflictCount": 0,
    "snapshotMissing": 0, "workspaceFallbacks": 0,
    "reasons": [], "producerSelfClaims": [],
    "contributesToAdmission": false, "injectedIntoInstanceState": false
  }
}
```

| 字段 | 含义 |
|---|---|
| `schema` | 恒为 `flow-evidence/v1` |
| `claims[]` | 报告声明的业务结论。`value` 永远是 `source:"report-claim"`；`refsChecked` 只表示引用是否全部核对 |
| `findings[]` | 报告声明的缺陷 / 修复状态。`status` 原样保留；`fixed` 只有复验引用全部命中归档快照并核对通过时 `verified:true`，`displayStatus:"verified"`；只靠工作区回落不算 |
| `verifiedRefs[]` | 内容 sha256 与快照 / 工作区一致（**只证明内容一致，不证明结论正确**），含 `resolvedFrom` |
| `missing[]` | 缺报告、报告不可读、schema 不符、缺引用、引用读不到、`fixed` 无复验引用等，每项带 `kind` / `reason` |
| `conflicts[]` | hash 不匹配、同 execution 同 ID 不同 value / status、跨 execution 分歧、报告自称 execution 与登记不一致等 |
| `sourceExecutions[]` | 报告来源 execution（宿主登记；不同循环各留一条，不互相失效） |
| `dataQuality.evidenceStatus` | `missing` / `invalid` / `partial` / `present` 四个事实状态，不是质量评级 |
| `dataQuality.unknown` | 缺报告 / 报告不可读时为 `true`；空 claims 不代表全部通过 |
| `dataQuality.stub` | 报告自报 `stub:true` / `synthetic:true` 时为 `true` |
| `dataQuality.reasons` | 稳定原因串清单（如 `artifact-snapshot-missing`、`workspace-fallback`、`fixed-without-verification-refs`） |
| `dataQuality.producerSelfClaims` | 报告自称 `producer` / `authority` / `trust` 的记录；这些自报被忽略，不授予宿主身份 |

引用解析顺序：先按 `sha256` 命中 `artifacts/<sha256>` 快照；快照缺失才回落到工作区相对路径，并在 `dataQuality.reasons` 记 `artifact-snapshot-missing` 与 `workspace-fallback`。worktree / 工作区被清理后，已登记快照仍可读、hash 仍一致；从未登记过快照的引用才会变成 `missing`。

本接口不产出「优 / 良 / 差」或统一 pass / warn / fail 总评级；findings 不写入实例状态、不参与 admission、不会自动触发节点完成。`activity/end` 只负责把本 execution 的 artifacts 关联到报告，不替报告做业务裁决。

失败：400 `BPMN_INSTANCE_ID_INVALID` / `EVIDENCE_AS_OF_INVALID`，404 `INSTANCE_NOT_FOUND`，405 `BPMN_METHOD_NOT_ALLOWED`，500 `INSTANCE_CORRUPT` / `BPMN_INTERNAL_ERROR`。

## 实例 worktree

### `GET /instances/<id>/worktree`

实现：`src/bpmn-runtime.js` 的 `_readInstanceWorktree()`；检查逻辑在 `src/instance-worktree.js` 的 `inspectInstanceWorktree()`。

不创建 runner、不触发懒恢复。三种响应形状：

未配置工作区：

```json
{ "ok": true, "id": "i-…", "configured": false, "instanceStatus": "ACTIVE",
  "mode": null, "worktree": null, "cleanable": false }
```

配置了工作区但用原目录（`mode:"off"` 或非 Git 回退）：

```json
{ "ok": true, "id": "i-…", "configured": true, "instanceStatus": "COMPLETED",
  "mode": "off", "workspaceId": "…", "effectiveRoot": "…",
  "cleanupPolicy": "retain", "worktree": null, "cleanable": false }
```

有 worktree：

```json
{ "ok": true, "id": "i-…", "configured": true, "instanceStatus": "COMPLETED",
  "mode": "worktree", "workspaceId": "…", "cleanupPolicy": "retain",
  "worktree": {
    "ok": true, "state": "ok", "instanceId": "i-…", "workspaceId": "…",
    "path": "…/worktrees/<workspaceId>/<instanceId>", "branch": "flow-instance/i-…",
    "baseCommit": "…", "repositoryRoot": "…", "cleanupPolicy": "retain",
    "resourceState": "ready", "exists": true, "registered": true,
    "head": "…", "currentBranch": "flow-instance/i-…",
    "branchMatches": true, "dirty": false, "cleanable": true, "reasons": []
  },
  "cleanable": true }
```

`worktree.state` 的确定性取值：`ok`（已登记、分支与记录一致、干净）、`missing`（目录不存在）、`dirty`、`unregistered`（目录在但主仓库没登记）、`branch-mismatch`、`head-mismatch`（本路由不传 `expectedHead`，不会出现）、`path-unsafe`、`repository-missing`、`git-unavailable`、`invalid-record`、`error`。顶层 `cleanable` 只在实例处于终态（`COMPLETED` / `CANCELED`）且检查结果 `cleanable:true` 时为 `true`；`ACTIVE` / `SUSPENDED` 一律 `false`。

失败：400 `BPMN_INSTANCE_ID_INVALID`，404 `INSTANCE_NOT_FOUND`，409 `WORKSPACE_UNAVAILABLE`（快照损坏，或所有权记录存在但快照缺失），500 `INSTANCE_CORRUPT` / `BPMN_INTERNAL_ERROR`。

### `DELETE /instances/<id>/worktree`

实现：`src/bpmn-runtime.js` 的 `_deleteInstanceWorktree()`；删除规则在 `src/instance-worktree.js` 的 `removeInstanceWorktree()`。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `force` | boolean | `false` | 允许删脏树、允许解除 Git locked 保护；**不能**越过实例 `ACTIVE` / `SUSPENDED` 或 `expectedHead` |
| `removeBranch` | boolean | `false` | 删目录后是否同时删本实例分支；结果单独放在 `branchRemoval`，不以目录删除冒充分支成功 |
| `expectedHead` | string | 无 | 40–64 位十六进制；与当前 HEAD 不一致 → 409，`force` 不能绕过 |

规则：实例 `ACTIVE` / `SUSPENDED` 一律 409；目录存在但主仓库未登记 → 409；当前分支不是本实例的 `flow-instance/<instanceId>`（或与记录不一致）→ 409；脏树且没有 `force:true` → 409；目录本来就不存在时只做**定向注销**：`git worktree remove --force <path>` 仅作用于这一条已核对过路径与分支所有权的登记，不跑仓库级 `git worktree prune`（那会顺带清掉别的缺失路径登记）；注销成功返回 `removed:true, registrationRemoved:true`，注销失败返回 `removed:false, reason:"not-found"` 并带 `warning`。响应：

```json
{ "ok": true, "id": "i-…", "removed": true, "reason": "removed",
  "path": "…", "branch": "flow-instance/i-…",
  "branchRemoval": { "removed": false, "branch": "flow-instance/i-…",
                     "reason": "unmerged", "warning": "…", "forced": false } }
```

`branchRemoval` 只在请求带 `removeBranch:true` 时出现；分支未合并、未证明合并或删除失败都会让 `removed:false` 并带原因，但目录删除结果仍是 200。

失败：400 `BPMN_BODY_INVALID` / `BPMN_EXPECTED_HEAD_INVALID`，404 `INSTANCE_NOT_FOUND` / `INSTANCE_WORKTREE_NOT_CONFIGURED`，409 `INSTANCE_WORKTREE_INSTANCE_ACTIVE` / `INSTANCE_WORKTREE_EXECUTION_ACTIVE` / `INSTANCE_WORKTREE_DIRTY` / `INSTANCE_WORKTREE_LOCKED` / `INSTANCE_WORKTREE_NOT_REGISTERED` / `INSTANCE_WORKTREE_BRANCH_NOT_OWNED` / `INSTANCE_WORKTREE_HEAD_MISMATCH`，500 `INSTANCE_WORKTREE_REMOVE_FAILED` / `BPMN_INTERNAL_ERROR`，503 `INSTANCE_WORKTREE_GIT_UNAVAILABLE`。

### `DELETE /instances/<id>/worktree/branch`

实现：`src/bpmn-runtime.js` 的 `_deleteInstanceWorktreeBranch()`；分支规则在 `src/instance-worktree.js` 的 `removeInstanceBranch()`。

请求体可带 `{force?:boolean}`。只删记录里确属本实例、且前缀是 `flow-instance/` 的分支，不碰目录；实例 `ACTIVE` / `SUSPENDED` → 409。默认只在 `merge-base --is-ancestor <branch> HEAD` 成功（明确证明已合并）时删除；未合并、空仓库无基点、检查异常都拒绝，显式 `force:true` 才删并标 `forced:true`。删除用 `update-ref -d <ref> <tip>` 做 compare-and-delete。

响应 200：

```json
{ "ok": true, "id": "i-…",
  "branchRemoval": { "removed": false, "branch": "flow-instance/i-…",
                     "reason": "unmerged", "warning": "…", "forced": false } }
```

分支不属于本实例（`not-owned`）时 409 `INSTANCE_WORKTREE_BRANCH_NOT_OWNED`；未配置 worktree 404；分支不存在 / 未合并不改变状态码（200 + `removed:false`）；Git 不可用同样返回 200，但 `branchRemoval.reason:"git-unavailable"`。失败：400 `BPMN_BODY_INVALID`，404 `INSTANCE_NOT_FOUND` / `INSTANCE_WORKTREE_NOT_CONFIGURED`，409 `INSTANCE_WORKTREE_INSTANCE_ACTIVE` / `INSTANCE_WORKTREE_EXECUTION_ACTIVE` / `INSTANCE_WORKTREE_BRANCH_NOT_OWNED`，500 `INSTANCE_CORRUPT` / `BPMN_INTERNAL_ERROR`。

### `GET /instance-worktrees`

实现：`src/bpmn-runtime.js` 的 `_listInstanceWorktrees()`；清单与孤儿判定在 `src/instance-worktree.js` 的 `listInstanceWorktrees()`。

| 查询参数 | 类型 | 说明 |
|---|---|---|
| `workspaceId` | 12 位小写十六进制 | 只看某个主仓库下的树；非法 400 `BPMN_WORKSPACE_ID_INVALID` |

响应：

```json
{ "ok": true, "worktrees": [{ "instanceId": "i-…", "workspaceId": "…", "path": "…",
                              "record": { "…": "…" }, "recordOk": true, "corrupt": null,
                              "instanceExists": true, "instanceStatus": "COMPLETED",
                              "instanceCorrupt": false, "instanceState": "terminal",
                              "directoryExists": true, "inspected": { "…": "…" },
                              "registered": true, "head": "…", "branch": "…",
                              "dirty": false, "branchMatches": true,
                              "cleanable": true, "orphan": false, "orphanReasons": [] }],
  "orphans": [], "corrupt": [], "scannedAt": "…" }
```

孤儿判定不依赖内存 LRU，只看持久化事实；`instanceState` 取 `not-configured` / `missing` / `active` / `terminal` / `unknown`。`orphanReasons` 的取值包括 `instance-missing`、`instance-corrupt`、`instance-unknown`、`directory-missing`、`record-corrupt`、`unregistered-directory`、`no-ownership-record`、`worktree-<state>`。没有所有权记录的目录只报告、不参与自动删除。`corrupt[]` 是坏掉的所有权记录；读不出的记录不会从清单里消失。失败：400 `BPMN_WORKSPACE_ID_INVALID`，500 `BPMN_INTERNAL_ERROR`（registry 读取异常）。

### `POST /instance-worktrees/prune`

实现：`src/bpmn-runtime.js` 的 `_pruneInstanceWorktrees()`；计划生成与执行在 `src/instance-worktree.js` 的 `createPrunePlan()` / `pruneInstanceWorktrees()`。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dryRun` | boolean | `true` | 只有显式 `dryRun:false` 才执行删除；省略或 `true` 只生成预览 |
| `planHash` | string | 无 | 64 位小写十六进制；执行时必须带，且必须与本次新扫描生成的计划一致 |
| `workspaceId` | string | 无 | 12 位小写十六进制，限定扫描范围 |

预览响应（200）：

```json
{ "ok": true, "dryRun": true, "planHash": "…",
  "plan": { "v": 1, "createdAt": "…", "entries": [{ "…": "…" }], "planHash": "…" },
  "removable": 1, "reported": 2 }
```

执行响应（200）：

```json
{ "ok": true, "dryRun": false, "planHash": "…",
  "removed": [{ "…": "…" }], "skipped": [{ "…": "…", "executed": false, "reason": "…" }] }
```

计划条目的 `action` 只有三种：`remove`（实例终态或实例确实不存在、记录完整、分支属于本实例、目录已登记且干净）、`retain`（实例 `ACTIVE` / `SUSPENDED`）、`report`（无所有权记录、记录损坏 / 实例状态未知、分支不属于本实例、目录缺失、未登记、脏树或脏状态未知）。执行只处理 `action:"remove"` 的条目；其余条目原样进 `skipped`。删目录后会尝试删本实例分支（未证明合并则不删，记录进资源事件），并删除对应的所有权记录。

执行前还会核对**物理退出**：计划里 `action:"remove"` 的实例若仍有 agent 执行未确认退出（进程活着、或清理未完成），整次执行 409 `INSTANCE_WORKTREE_EXECUTION_ACTIVE`，响应带 `instanceIds`，一条都不删。

`planHash` 的约束：预览返回的计划在服务端缓存 10 分钟；执行时会重新扫描并与缓存的计划比较，超过 10 分钟、服务已重启、或工作区状态变化导致 hash 不一致，都返回 409 `INSTANCE_WORKTREE_PLAN_STALE`。缺少 / 格式错误的 `planHash` 返回 400 `INSTANCE_WORKTREE_PLAN_INVALID`，`workspaceId` 非法 400 `BPMN_WORKSPACE_ID_INVALID`，body 非对象 400 `BPMN_BODY_INVALID`，单条删除失败进 `skipped`，扫描或执行的整体失败 500。

## 资源事件

### `GET /instances/<id>/resource-events`

实现：`src/bpmn-runtime.js` 的 `_readResourceEvents()`；存储在 `src/instance-resources.js`。

| 查询参数 | 类型 | 说明 |
|---|---|---|
| `since` | 非负整数 | 只返回 `seq > since` 的事件；非法 400 `BPMN_SEQ_INVALID` |

响应：

```json
{ "ok": true, "id": "i-…",
  "events": [{ "type": "worktree/ready", "seq": 1, "at": "…", "workspaceId": "…" }],
  "resourceSeq": 3, "skipped": 0 }
```

资源事件流与执行事件流是两条独立的流，序号 `resourceSeq` 独立分配。写入的事件类型：

| type | 触发 |
|---|---|
| `worktree/ready` | 实例 worktree 创建并登记成功 |
| `worktree/removed` / `worktree/remove-skipped` | 删除 worktree 的成功 / 跳过 |
| `worktree/branch-removed` / `worktree/branch-remove-skipped` | 删除分支的成功 / 跳过 |
| `worktree/cleanup-skipped` | `on-terminal-clean` 自动清理被跳过（agent 未释放、树不干净等） |
| `inbox/message-accepted` / `inbox/message-bound` / `inbox/message-delivered` / `inbox/message-failed` | 入站消息受理 / 绑定后续激活 / 投递成功 / 失败 |
| `inbox/reply-enqueued` / `inbox/reply-delivered` / `inbox/reply-failed` / `inbox/reply-skipped` | 回复 outbox 的入队 / 投递 / 失败 / 跳过 |

单条资源事件上限 8 KiB；除实例创建时的 `worktree/ready` 外（这条写失败会回滚建树并让 `POST /instances` 报错），其余资源事件写失败不改变业务操作结论，坏行在读取时跳过并计入 `skipped`。失败：400 `BPMN_INSTANCE_ID_INVALID` / `BPMN_SEQ_INVALID`，404 `INSTANCE_NOT_FOUND`。

## 收件箱

### `POST /instances/<id>/messages`

实现：`src/bpmn-runtime.js` 的 `_acceptInstanceMessage()`；受理与投递在 `src/instance-inbox.js` 的 `acceptInstanceMessage()`，持久化在 `src/instance-message-store.js`。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `messageId` | string | 是 | 1–128 个安全字符（字母 / 数字开头，只含字母、数字、点、下划线、冒号、连字符）；幂等键 |
| `target` | object | 是 | 精确目标 `{activityId, executionId}`，或未来节点 `{activityId, delivery:"nextActivation"}` |
| `text` | string | 是 | 非空；UTF-8 ≤1 MiB |
| `replyTargetId` | string | 否 | 宿主白名单里的回复目标 id（不是 URL / session） |

两种目标互斥：`delivery:"nextActivation"` 不能同时带 `executionId`；精确目标必须带 `executionId`，且该执行仍在 live 表或落盘的 `pendingTasks` 里，否则 410 `MESSAGE_TARGET_EXPIRED`（不会投到同名节点的下一轮）；`SUSPENDED` 实例例外，允许先排队、不校验执行是否还活着。`nextActivation` 只绑定**后续第一次**激活，循环重入不会广播；`activityId` 必须存在于实例冻结定义里，否则 404 `MESSAGE_ACTIVITY_NOT_FOUND`。

`COMPLETED` / `CANCELED` 拒绝新消息（409 `MESSAGE_INSTANCE_TERMINAL`）；`SUSPENDED` 可以受理并排队，但不唤起 agent（响应 `delivery.deferred:true`）。人工任务收消息只当讨论 / 附件：不写完成变量、不调 `signalTask`。

响应：

```json
{ "ok": true, "id": "i-…", "duplicate": false,
  "message": { "v": 1, "messageId": "m-1", "seq": 1,
               "target": { "activityId": "human1", "executionId": "human1_…" },
               "replyTargetId": null, "bytes": 12, "preview": "…",
               "body": { "kind": "inline", "bytes": 12 }, "status": "queued",
               "delivery": null, "binding": null, "createdAt": "…", "updatedAt": "…" },
  "delivery": { "confirmed": ["m-1"], "failed": [], "remaining": 0, "skipped": false } }
```

消息正文阈值：≤4 KiB 内联在 `messages.jsonl`；>4 KiB 先完整落盘到 `inbox/bodies/<messageId>.<sha16>.txt`，记录里只留 `body:{kind:"file", path, sha256, bytes}` 引用；>1 MiB 整条拒绝（413 `MESSAGE_BODY_TOO_LARGE`），不写任何文件。`preview` 是前 200 字符。

journal 尾部修复：追加写之前（`inbox/.lock` 内）检查 `messages.jsonl` / `replies.jsonl` 最后一行是否以换行结束；不完整尾部原样（base64）转存到 `<journal>.torn` 后，把主 journal 截断到最后一个完整行再追加。这样崩溃遗留的半行不会吞掉下一条已受理记录，`seq` 与幂等语义不变。

幂等：同一实例下 `messageId` 相同且内容指纹（`target` + `text` + `replyTargetId` 的稳定 JSON sha256）相同，返回原记录 + `duplicate:true`（即使实例随后终态、回复目标随后被移除也照常返回）；内容不同 409 `MESSAGE_ID_CONFLICT`。

`replyTargetId` 只能来自宿主注入的白名单（默认空；形状 `{kind:"session", sessionId}` 或 `{kind:"http", url, authRef?}`）。不在白名单 → 403 `MESSAGE_REPLY_TARGET_UNKNOWN`。

失败：400 `BPMN_BODY_INVALID` / `MESSAGE_INVALID`，403 `MESSAGE_REPLY_TARGET_UNKNOWN`，404 `MESSAGE_INSTANCE_NOT_FOUND` / `MESSAGE_ACTIVITY_NOT_FOUND`，409 `MESSAGE_INSTANCE_TERMINAL` / `MESSAGE_ID_CONFLICT`，410 `MESSAGE_TARGET_EXPIRED`，413 `MESSAGE_BODY_TOO_LARGE`，500 `MESSAGE_WRITE_FAILED` / `MESSAGE_BODY_CORRUPT`。journal 写失败时消息会按「可能已投递」显式收口：`delivery.code:"MESSAGE_DELIVERY_STATE_WRITE_FAILED"` + `deliveryUnknown:true` + `delivery.reason:"delivery-state-write-failed"`，**不自动重发**。

### `GET /instances/<id>/messages`

实现：`src/bpmn-runtime.js` 的 `_readInstanceMessages()`；分页在 `src/instance-message-store.js` 的 `listMessages()`。

| 查询参数 | 类型 | 说明 |
|---|---|---|
| `cursor` | 非负整数 | 上一页最后一条的 `seq`（不含）；默认 0；非法 400 `MESSAGE_CURSOR_INVALID` |
| `limit` | 正整数 | 默认 50，服务端封顶 100；非法 400 `MESSAGE_LIMIT_INVALID` |

响应：

```json
{ "ok": true, "id": "i-…", "messages": [{ "messageId": "m-1", "seq": 1, "status": "injected" }],
  "total": 3, "nextCursor": 1, "cursor": 0, "limit": 50,
  "liveExecutions": [{ "activityId": "human1", "executionId": "human1_…",
                       "kind": "human", "attempt": 1, "cold": false,
                       "registeredAt": "…" }] }
```

消息按 `seq` 升序。`messages[]` 是存储层投影，字段与 `POST /messages` 的 `message` 基本一致，另含 `contentHash` 与 `rev`（受理响应的投影不含这两个字段）。`liveExecutions` 只列当前进程内存里登记的活执行，供 GUI 选精确目标。失败：400 `MESSAGE_CURSOR_INVALID` / `MESSAGE_LIMIT_INVALID`，404 `MESSAGE_INSTANCE_NOT_FOUND`。

### `GET /instances/<id>/messages/<messageId>/body`

实现：`src/bpmn-runtime.js` 的 `_readInstanceMessageBody()`；正文读取在 `src/instance-inbox.js` 的 `readMessageBody()`。

响应：

```json
{ "ok": true, "id": "i-…", "messageId": "m-1", "text": "……",
  "bytes": 12, "sha256": "…", "bodyRef": null }
```

内联正文直接返回，`bodyRef:null`；落盘正文读回后会重算 sha256 与字节数，和记录不一致 → 500 `MESSAGE_BODY_CORRUPT`，文件丢失 → 404 `MESSAGE_NOT_FOUND`。`messageId` 非法 400 `MESSAGE_INVALID`，实例不存在 404 `MESSAGE_INSTANCE_NOT_FOUND`。

### `POST /instances/<id>/messages/<messageId>/replies`

实现：`src/bpmn-runtime.js` 的 `_postInstanceReply()`；outbox 与投递在 `src/instance-inbox.js` 的 `enqueueReply()` / `dispatchReply()`。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `replyId` | string | 否 | 1–128 个安全字符；省略时按内容确定性生成 `reply-<sha256 前 16 位>` |
| `targetId` | string | 否 | 回复目标 id；省略时用这条消息的 `replyTargetId` |
| `text` | string | 否 | 回复正文；与 `document` 至少给一项 |
| `document` | object | 否 | `{path, sha256?}`；`path` 必须是实例冻结工作区内的相对路径 |

回复请求里出现 `url`、`sessionId`、`session`、`target` 任何一个字段都直接 400 `MESSAGE_REPLY_TARGET_ARBITRARY`：目标只能来自宿主白名单的 id。没有可用 `targetId` → 400 `MESSAGE_REPLY_TARGET_REQUIRED`；`targetId` 不在白名单 → 403 `MESSAGE_REPLY_TARGET_UNKNOWN`。

附件规则：路径经 realpath 校验必须在 `workspace.json.effectiveRoot` 内、必须是普通文件、≤1 MiB；`sha256` 可选，给了就必须与文件一致；否则 400 `MESSAGE_DOCUMENT_UNSAFE`（超 1 MiB 为 413 `MESSAGE_BODY_TOO_LARGE`）。没有冻结工作区时不能引用附件。

幂等：同一 `replyId` + 同一内容指纹返回原 outbox 记录 + `duplicate:true`；不同内容 409 `MESSAGE_REPLY_ID_CONFLICT`。

行为：先写 outbox（`replies.jsonl`），再同步投递一次；`CANCELED` 实例拒绝新回复（409），已受理但未发送的回复在实例取消时标 `skipped`；`COMPLETED` 后仍可投递已受理的回复。

响应状态由投递结果决定：投递成功 200；实例已取消、回复被跳过 409（`code:"MESSAGE_INSTANCE_TERMINAL"`）；同一回复已在另一个进程投递中 409（`code:"MESSAGE_REPLY_DISPATCH_IN_FLIGHT"`；若 Host 无法确认旧领取者是否仍存活，错误文案会说明「归属无法确认、需人工处理」，不会按时间猜）；投递失败 502（`code` 取 `reply.lastError.code`，如 `MESSAGE_REPLY_HTTP_STATUS` / `MESSAGE_REPLY_DELIVERY_UNSUPPORTED`）。

```json
{ "ok": true, "id": "i-…", "messageId": "m-1", "duplicate": false,
  "enqueued": true, "delivered": true,
  "reply": { "replyId": "reply-…", "status": "delivered", "attempts": 1,
             "delivery": { "kind": "http", "status": 200, "deliveryUnknown": false },
             "lastError": null } }
```

## connector

### `POST /instances/<id>/connector/<recordId>/resolve`

实现：`src/bpmn-runtime.js` 的 `_resolveConnectorInvocation()`；记录处置在 `src/connector-store.js` 的 `resolveInvocation()`。

路径里的 `recordId` 可以是调用记录的 `executionId`（激活键）、`invocationId` 或引擎原始 `engineExecutionId`，1–256 个 `[A-Za-z0-9._-]` 字符，否则 400 `HTTP_RESOLVE_INVALID`。请求字段：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `action` | `mark-succeeded` / `mark-failed` / `retry` / `clear-tombstone` | 是 | 其它值 400 `HTTP_RESOLVE_INVALID` |
| `evidence` | string | 是 | 非空、≤2000 字符（远端对账依据 / 工单号） |
| `operator` | string | 否 | ≤128 字符 |
| `result` | object | 否 | 只用于 `mark-succeeded`：`{status?:0–599, headers?:object, output?:object}`，序列化后 ≤64 KiB |

动作语义：

| action | 效果 |
|---|---|
| `mark-succeeded` | 把记录标成 `succeeded` 并写入人工补录结果（缺省 `status:0`）；已成功则幂等返回 |
| `mark-failed` | 把记录标成 `failed`，错误码 `HTTP_MANUAL_FAILED`；已由人工标失败则幂等 |
| `retry` | 只把未成功的记录重置为 `started` / `attempts:0` 并推进世代；已 `succeeded` 的记录拒绝（409 `HTTP_RESOLVE_CONFLICT`，避免重发已成功的副作用） |
| `clear-tombstone` | 只删除实例 `state.json` 里的不可恢复墓碑并给记录打处置标记；不改记录状态、不重放任何前序副作用 |

调用记录的写盘按「同一记录」串行化：进程内共享队列 + 跨进程 `.locks/<digest>.lock` 文件锁，`generation` 的读—检查—落盘整个在锁内完成；旧 fence 的迟到写入不会覆盖新世代的终态。

处置**只改调用记录与审计**：不调用 runner、不写 `activity/end`、不改实例状态，也不让实例自动继续。所有真实变更追加 `connector/audit.jsonl`（含 evidence / operator / 前后状态）。实例终态 → 409 `BPMN_INSTANCE_TERMINAL`；实例正在停止 → 409 `BPMN_INSTANCE_STOPPING`；记录不存在 → 404 `HTTP_INVOCATION_NOT_FOUND`；动作非法 / 冲突 → 400 / 409；其它存储错误统一 500 `BPMN_INTERNAL_ERROR`。

响应：

```json
{ "ok": true, "id": "i-…", "status": "ACTIVE", "tombstoneCleared": true,
  "executionId": "…", "invocationId": "inv-…", "engineExecutionId": null,
  "action": "clear-tombstone", "idempotent": false, "auditId": "…",
  "record": { "…": "…" }, "lastSeq": 12, "pendingTasks": [], "lastError": null,
  "note": "…" }
```

`tombstoneCleared` 只在 `action:"clear-tombstone"` 时出现；`record` 是处置后的调用记录（含 `generation` 与 `resolution`，后者带 `lastAuditId`）。`note` 说明「处置不推进引擎」的边界。

当前没有 `GET /instances/<id>/connector` 这类读取调用记录的路由：调用记录只能通过 `connector/<digest>.json` 落盘文件、`connector/audit.jsonl` 与执行事件里的 `http/result` 核对。

## 语义

### 实例状态

`instance.json.status` 只有四个取值（设计口径见 [design/10](../design/10-bpmn-instance-api.md)）：

| 状态 | 含义 |
|---|---|
| `ACTIVE` | 活着：正在跑、停在人工任务、或出错后停住等人处理 |
| `COMPLETED` | 走到结束事件，正常完成 |
| `SUSPENDED` | 被 `POST /instances/<id>/suspend` 挂起：没有在飞活动、不推进、不派发；期间执行事件追加 / 引擎快照写入 / `COMPLETED` 收口都被拒（错误事实通道除外），`POST /instances/<id>/resume` 回到 `ACTIVE`（见 [挂起 / 恢复](#挂起与恢复)） |
| `CANCELED` | 被 `POST /instances/<id>/stop` 取消，或创建阶段工作区建立失败被收口 |

没有 `failed`、没有 `blocked`。引擎执行出错（条件求值错、活动超时、handler 失败、adapter 不可用、connector 不知结果等）时 `status` 保持 `ACTIVE`，只写 `lastError{code,message,nodeId?,activityId?,retries?,reminders?}` 并发一条 `error` 事件；是否重试、终止或继续由人 / 业务决定。终态只有 `COMPLETED` 与 `CANCELED`，终态不可逆：之后任何状态 / 变量 / 任务 / `lastError` 写入都被拒绝。

runner 内部执行态不写进 `status`：`idle` / `running` / `waiting` 都映射为 `ACTIVE`（`waiting` 另有非空 `pendingTasks`），`done` 映射为 `COMPLETED`，`blocked` 映射为 `ACTIVE` + `lastError`。

### 读接口与懒恢复

`GET /instances/<id>`、`GET /instances/<id>/tasks` 与写操作 `complete` 在内存里没有该实例的 runner 且实例非终态时，会按磁盘懒恢复：

1. 读 `instance.json`；终态 → 不恢复，返回 `recovered:false` + 终态原因。
2. `status:"SUSPENDED"` → **不恢复、不推进**，返回 `recovered:false` + `recovery.code:"BPMN_STATE_SUSPENDED"`、`runnerStatus:null`；`pendingTasks` 仍按磁盘事实返回。`GET` 不会因为读而创建 runner。
3. 读 `owner.json`：被另一个**活着**的进程持有 → **不恢复、不派发**，返回 `recovered:false` + `recovery.code:"BPMN_INSTANCE_ACTIVE_ELSEWHERE"`（`GET` 仍 200；写操作 409 `BPMN_INSTANCE_NOT_RECOVERABLE` 并带 `recoveryCode`）。记录是坏 JSON / 跨主机 / `state:"unknown"` → `recovery.code:"BPMN_OWNER_UNKNOWN"`，同样保守拒绝，不靠时间猜。
4. **claim 执行所有权**（除非磁盘记录已经属于本 runtime 且 `alive`）：`claimInstanceOwner()` 在 `instances/.locks/<instanceId>.lock` 的内核 `flock` 临界区里重新读旧记录、判定、原子替换；拿到才继续。竞争失败抛 409 `INSTANCE_OWNED_ELSEWHERE` / `INSTANCE_OWNER_UNKNOWN` 并投影成上一步的两个 `recovery.code`；此刻还没有读 state / 定义，也没有建 runner。本请求随后在**任何异步准备之前**已完成登记（`owner.json`）。
5. `instance.json.executionFailure` 存在 → 不恢复：这是「已确认执行失败」的恢复禁止标记（见 [数据模型](data-model.md#内部字段与文件不承诺对外稳定)）。它会先摘掉并停止缓存 runner（失败标记落盘后缓存 runner 不能再被当成与磁盘一致），再交还本进程的 `owner.json`，返回 `recovered:false` + `blocked:true`。`GET` 仍 200，`recovery.code` 取 `lastError.code`（缺省 `executionFailure.code`）；`complete` 409 `BPMN_INSTANCE_BLOCKED` + `recoveryCode`（0.14.6 与热 runner 同口径）。墓碑可能还没来得及写，所以不能把可靠性押在快照上。
6. 到此才看内存缓存：`_runners` 里有非 `idle` 的 runner → 直接复用（不再 claim、不再读盘）。
7. 读 `state.json`；缺失 / 空 → `recovery.code:"BPMN_STATE_MISSING"`（GET 仍 200；写操作 409 `BPMN_INSTANCE_NOT_RECOVERABLE`），并交还所有权。
8. `state.json` 带 `unrecoverable` 墓碑 → 不恢复，`recovery.code` 取墓碑里的错误码（缺省 `BPMN_STATE_UNRECOVERABLE`）；这是执行失败停机时写下的快照，防止重启后重放失败前的工作。交还所有权。
9. 读实例自己的 `definition.bpmn` 并重新解析；快照损坏 → 500，不拿定义域的最新版冒充。
10. 准备完成、真正建 runner / recover **之前**，从磁盘重新读一次 `instance.json` 准入：终态 → 不恢复、不派发（`recovered:false`，交还所有权）；`SUSPENDED` → 不恢复、不派发，`recovery.code:"BPMN_STATE_SUSPENDED"`（交还所有权）。准备期间别的进程提交的挂起 / 终态在这里被拦下，不会进入 `recover` / adapter。
11. `runner.recover(state)`；state 不可反序列化 / 版本不符 / 定义不一致 → `recovered:false` + 具体恢复码，并写 `lastError`、交还所有权；不把实例判成 failed。
12. 恢复成功后，事件流、`pendingTasks`、变量与状态都回到磁盘上的事实；`recovered:true` 只代表本次请求重建了 runner。所有权已在第 4 步登记，不需要再写一次。

`clear-tombstone` 只删除墓碑快照，不恢复引擎；删除后同一实例的懒恢复会变成 `BPMN_STATE_MISSING`，仍不能自动继续，需要新建实例。

同一实例的 `complete` 与懒恢复走同一把进程内异步锁，事件写入再逐条串行；两个并发 complete 只有一个成功，另一个拿到 409。`stop` 故意在锁外先置停止闩并中止 runner（避免排在慢 complete 后面），再靠终态写保护与写操作竞争：竞争失败的一方按实际结果拿到 409 `INSTANCE_TERMINAL_IMMUTABLE` 或幂等的 `alreadyTerminal`。`GET /instances/<id>/definition`、`/events`、`/worktree`、`/resource-events`、`/messages`、`/metrics`、`/evidence` 不触发恢复。

### 收件箱状态机

入站消息状态：

| 状态 | 含义 |
|---|---|
| `queued` | 已持久化受理，等待投递（或等待 `nextActivation` 绑定） |
| `injected` | 已投给本进程内的活 agent 执行 |
| `resumed` | 已投给冷会话（恢复出来的执行） |
| `delivered` | 已投给人工任务（只作为讨论 / 附件，不完成节点） |
| `failed` | 投递失败或执行结束 / 实例终态导致消息过期 |

回复 outbox 状态：`queued` / `delivered` / `failed` / `skipped`。`skipped` 只在实例 `CANCELED` 时出现。

收件箱消息只承载讨论与附件，**不完成节点、不完成人工任务**：agent 节点仍只认 `flow_finish_node`，人工任务仍只认 `complete` 路由。

投递规则：

- 实例 `SUSPENDED` 时：新消息仍受理并落盘为 `queued`，但**不投递**，响应 `delivery:{deferred:true, reason:"instance-suspended"}`；挂起期间 `deliverQueued` 直接跳过该实例。恢复后新消息 / 下一次投递触发会继续消费队列；恢复本身不主动外发消息。
- **投递门禁（0.14.4）**：每次真正领取投递权（进入 adapter / 写 `delivered`）之前都重读一次实例状态——`ACTIVE` 放行；`SUSPENDED`、终态、实例缺失、`instance.json` 读不出来 → 一律**不投递、不标 `failed`**（消息保持 `queued`，drain 停止）。原因写在 drain 结果的 `deliveryBlocked`：`instance-suspended` / `instance-terminal` / `instance-missing` / `instance-unreadable` / `instance-not-active`，必要时附 `blockedStatus` / `blockedCode`；因挂起停止时另带 `suspended:true`。这样「扫描队列」与「真正投递」之间的挂起提交不会漏过。**已经进入 adapter 的投递无法回滚**：投递完成后才发现已挂起时，如实记 `delivered`（消息状态仍是 `injected` / `resumed` / `delivered`），并在 drain 结果标 `deliveredWhileSuspended:true`——那是诊断标记，不是「没投递」的意思。
- 单次 drain（每个 execution）在**同一个激活内持续推进**：按 `INBOX_DRAIN_BATCH`（5 条）分批，直到队列空或达到本次总上限 `INBOX_DRAIN_ACTIVATION_LIMIT`（100 条）。达到上限时未处理的消息留在 `queued` 并在 `remaining` 里如实报数；「只取 5 条」不是永久停止条件。同一 execution 的并发 drain 不丢弃唤醒：后来者返回 `{skipped:true, pending:true, reason:"drain-in-progress"}` 并在运行中的 drain 上置待处理标志；正在跑的 drain 在释放所有权前（队列空 / 达到上限时）重新确认队列并再消费一轮，因此「旧 drain 读到空快照 → 新消息受理 → 旧 drain 退出」不会留下永久 `queued`。
- agent 执行必须有原生消息能力（`capabilities().messages === "native"` 且实现 `deliverMessage`）；否则消息标 `failed`，投递记录 `deliveryUnknown:true`、`code:"MESSAGE_DELIVERY_UNSUPPORTED"`，**不假装成功**。
- DSH 适配器实现了 `deliverMessage`：成功返回 `{ok:true, deliveryUnknown:true}`（只保证排进会话队列，不保证模型在完结前读到），会话已完结 / 取消 / 通道未就绪则返回 `{ok:false, deliveryUnknown:true}` 与 `DSH_SESSION_NOT_ACTIVE` / `DSH_DELIVERY_UNAVAILABLE` / `DSH_INBOX_DELIVERY_FAILED`。
- codex 适配器明确不支持：`capabilities().messages` 为 `"unsupported"`，投递在能力检查处就失败；它自己的 `deliverMessage()` 也只会返回 `{ok:false, unsupported:true, deliveryUnknown:true, code:"CODEX_MESSAGE_DELIVERY_UNSUPPORTED"}`，绝不返回 `ok:true`。
- 只有适配器显式返回 `deliveryUnknown:false` 时，投递记录才带 `exactlyOnce:true`；DSH 与 codex 都不满足，因此收件箱不声称 exactly-once。
- 正文超过内联阈值时，投递会把全文物化到 agent 有效工作区的 `.flow-studio-inbox/<instanceId>/<messageId>.<sha16>.md`：路径含实例身份（共用工作区的不同实例不串正文）与内容 hash（同一 messageId 重复投递复用同一不可变路径）。Linux 上写入位置固定在**受信父目录 FD** 上：工作区根先 `realpath` 固定，再对 `.flow-studio-inbox`、`<instanceId>` 逐级 `O_DIRECTORY|O_NOFOLLOW` 打开，再以 `/proc/self/fd/<fd>/<name>`（等价 `openat`）创建 / 校验 / 清理文件；父目录在写入期间被替换或换回都不会改变写入落点，写后还要求交付路径的真实 inode 与固定 FD 一致、且 `realpath` 在工作区内。文件本身用 `O_CREAT|O_EXCL|O_NOFOLLOW` 创建；同名位置已有不同内容时换名（`-1`、`-2`…），绝不覆盖。任何一步不满足 → 消息标 `failed`、`code:"MESSAGE_BODY_UNSAFE"`，不投递、清理本次新建的文件、不留半文件。执行没有可用工作区 → 消息标 `failed`，`code:"MESSAGE_WORKSPACE_UNAVAILABLE"`。
- **非 Linux 残余窗口（如实标注）**：没有 `/proc/self/fd` 的平台退回「实例隔离路径 + 逐级 `lstat` 拒绝软链 + 写前 / 写后父目录 dev/ino 身份校验 + `O_CREAT|O_EXCL|O_NOFOLLOW`」的降级路径。该平台缺少 openat / 受信 dirfd 原语，`lstat` 校验与 `open()` 之间仍存在一个**无法彻底消除的父目录替换竞态窗口**；这是降级路径，不等价于 Linux 的 FD 固定保证。
- 执行结束（`activity/end` 等）时仍未投递的消息标 `failed`，`delivery.reason:"execution-ended"`；实例进入 `COMPLETED` / `CANCELED` 时 `queued` 消息同样收尾为 `failed`（reason `instance-completed` / `instance-canceled`）。过期与终态收尾都是**条件更新**：store 在 `inbox/.lock` 内重放最新记录后判断，只有仍为 `queued` 才改成 `failed`；已 `injected` / `resumed` / `delivered` 的消息不会被迟到的过期 / 收尾请求覆盖（store 层还有一道状态回归保护，拒绝把已投递改成 `failed` / `skipped`）。受理在落盘后会复核 execution（live 表身份 / `ended` 集合），若等待期间执行已结束，立即按同一过期语义收口，不留无人消费的 `queued` 孤儿。
- 取消 / 终态遇到**在飞投递**时的语义：回复有 `dispatch.token`（正在外发）时收尾不写 `skipped`，保留领取权让投递方用 token 写回真实结果（可能已 `delivered`）；已 `delivered` 的回复永不回退。入站消息没有跨进程 claim，收尾只会把仍 `queued` 的改成 `failed`，同进程正在外发的消息成功后会升级为 `injected` / `resumed`；若进程在这两步之间崩溃，状态可能显示 `failed` 而实际已送达，这是消息路径的已知残余（回复路径用 dispatch token 避免同类问题）。
- 回复的投递是另一条路径：`session` 目标只投给宿主当前 live 的会话（没有则 `MESSAGE_REPLY_SESSION_NOT_LIVE`），`http` 目标向白名单 URL POST，超时 10 秒，请求头带 `idempotency-key: <replyId>`，2xx 算成功；非 2xx 记 `MESSAGE_REPLY_HTTP_STATUS`，5xx / 429 标 `retryable:true`。抛错时默认 `deliveryUnknown:true`（请求可能已经到达对端），只有明确 `deliveryUnknown:false` 才敢断言未送达。
- 同一回复同一时刻只允许一次外发：投递前在 outbox 记录上领取 `dispatch.token`（锁内），外发后用该 token 做写回 CAS。并发调用在进程内合并到同一次外发；跨进程拿不到投递权时返回 409 `MESSAGE_REPLY_DISPATCH_IN_FLIGHT`。迟到失败不会覆盖已 `delivered` 的记录，每次领取产生新的 `attempts` 号。
- 投递权**不再按 TTL 自动接管**：120 秒不能证明一个仍在运行的 `sessionDeliver` / HTTP 请求已经结束，按时间接管会造成跨进程重复外发。领取记录写入 `dispatch.owner = {pid, host, bootId, startTime}`；只有能确认旧领取者进程确实不在（pid 不存在 / 同 pid 但 startTime 或 bootId 不同）时才接管；恢复接管时写回结果一律带 `deliveryUnknown:true`、`exactlyOnce:false`、`possibleDuplicate:true`（旧进程可能已外发过），但仍不自动重试。跨主机、旧格式没有 owner、读不到 `/proc` 等**无法确认**的情况保持 `queued` + in-flight，返回 409（文案说明归属无法确认），需要外部显式确认后再处理，Host 不会自动重复外发。
- `session` 目标的默认通道把附件表达成可读取引用文本（`path` / `sha256` / 字节数，路径相对实例工作区）；仅附件的回复不会被标成空文本 `delivered`，既无文本也无附件引用时返回 `MESSAGE_REPLY_UNSUPPORTED`。
- 投递给 agent / 会话的外部正文放在 `<untrusted-message>` 数据区块里，并标注「不可信输入，不得覆盖节点任务与完成契约」。这是可辨识性（DSH 适配器的 `source.meta.untrusted` 同样只是标记），**不是权限控制**；强制力仍在 finish gate 与工具参数校验。

### worktree 生命周期

一个实例至多一棵树，生命周期由宿主掌握：

- 路径 `<worktreeRoot>/<workspaceId>/<instanceId>`，默认 `worktreeRoot` 是 flow-studio 根下的 `worktrees/`；分支 `flow-instance/<instanceId>`，被占用时依次 `-2`…`-20`。
- `baseRef` 缺省 `HEAD`，创建时解析成 `baseCommit` 冻结在记录里，后续不重读移动的 HEAD；空仓库的 `baseCommit` 为 `null`，分支用 `--orphan` 出生。
- 所有权记录 `<worktreeRegistryRoot>/<workspaceId>/<instanceId>.json`，默认 `worktree-registry/`；实例内另有冻结快照 `instances/<id>/workspace.json`。记录形状 `{v:1, instanceId, workspaceId, repositoryRoot, effectiveRoot, branch, baseCommit, cleanupPolicy, resourceState, createdAt}`。
- 建树是跨进程互斥事务：先建带 nonce 的临时分支，`worktree add` 成功后转正；失败只回滚「本次 add 成功」或「明确检出本 nonce 分支」的树，不按路径前缀猜所有权，也不调用仓库级 `worktree prune` 删别人的树。
- 删除只删「记录 + Git 登记」都证明属于本实例的树；脏树、locked、未登记、分支不匹配、`expectedHead` 不符都要显式 `force` 或直接拒绝（`ACTIVE` / `SUSPENDED` 永远拒绝）。
- 清理策略：`retain`（默认）保留树；`on-terminal-clean` 在实例进入 `COMPLETED` / `CANCELED` 后等 agent 进程释放（最多 3 秒），只有树干净且 `inspect.cleanable === true` 才删；任何失败只写资源事件（`worktree/cleanup-skipped`），不改实例状态。
- 不自动 commit / merge / push。分支删除默认要求证明已合并进主仓库当前 HEAD；未证明时保留并报告。

### connector 调用记录

每次 HTTP connector 的逻辑激活一条记录，落在 `instances/<id>/connector/<digest>.json`，`digest = sha256(instanceId \0 elementId \0 executionId)`（这里的 `executionId` 是下面的激活键）；审计追加到同目录 `audit.jsonl`。记录只放定位、hash、幂等键与已校验的短结果，不放请求 / 响应正文，也不放密钥值。

- 激活身份：`executionId` 取 `<elementId>_attempt_<ctx.attempt>`（`ctx.attempt` 随引擎快照持久化）；没有 attempt 时退回引擎的 `engineExecutionId`。`invocationId` 是 `inv-<sha256 前 16 位>`。
- 幂等键：只有节点配置了 `idempotency.mode:"remote-key"` 才生成 `Idempotency-Key` 头，值为 `fs-<sha256(instanceId \0 elementId \0 activationKey \0 method \0 url) 前 40 位>`；同一逻辑激活的所有重试共享该键，循环的下一轮激活换键。
- 记录状态：`started`（发送前登记，`attempts:0`）→ `sent`（每次真正请求前落盘 `attempts:N`）→ `succeeded` / `failed` / `unknown`（终态或结果不明）。写入用 tmp + fsync + rename，并带 `generation`：旧世代的迟到写入返回 `HTTP_STORE_STALE`，不覆盖新调用。
- 恢复语义：已有 `succeeded` 结果 → 直接复用，不再请求远端；有 `attempts` 但没有成功结果 → `HTTP_OUTCOME_UNKNOWN`，**不自动重发**；只有 `started` 且 `attempts:0`（确定没发出）才允许重新发送。
- `HTTP_OUTCOME_UNKNOWN` 是 handler 失败码，会让实例保持 `ACTIVE` + `lastError` + `error` 事件，并写入不可恢复墓碑；要处置只能经 `POST /instances/<id>/connector/<recordId>/resolve`（`mark-succeeded` / `mark-failed` / `retry` / `clear-tombstone`）。`retry` 只重置记录、不推进引擎；`clear-tombstone` 只删墓碑，不恢复执行。
- 网络边界：重定向**不跟随**（策略里 `allowRedirects` 恒为 `false`，3xx 返回 `HTTP_REDIRECT_FORBIDDEN`）；整体 deadline 默认 10 秒，节点的 `timeoutMs` 受宿主策略 `maxTimeoutMs` 封顶（默认 120 秒），覆盖凭据解析 / DNS / 记录写入 / 发送 / 重试；请求体默认上限 256 KiB（宿主策略可调），响应体默认 1 MiB、硬上限 5 MiB（不可调高），响应头 64 条 / 8 KiB；重试最多 3 次、退避 200–2000ms，只对 `GET` / `HEAD` 或带幂等键的请求生效，瞬时状态只认 `429` / `502` / `503` / `504`。

### 落盘位置

基础布局（`instance.json` / `definition.bpmn` / `state.json` / `events/`）见 [design/10 §2](../design/10-bpmn-instance-api.md#2-目录与领域隔离)。本页新增能力产生的文件：

```text
<flow-studio 根>/
  instances/<instanceId>/
    owner.json                     # 执行所有权记录（0600，原子写；见「挂起与恢复」）
    workspace.json                 # 实例冻结的工作区快照
    resources/
      events.jsonl                 # 资源事件（独立 resourceSeq，append-only）
      state.json                   # { v, resourceSeq }
    inbox/
      messages.jsonl               # 入站消息记录（同一 messageId 以最后一条为准）
      replies.jsonl                # 回复 outbox（replyId 为键）
      messages.jsonl.torn          # 崩溃遗留半行的旁路存档（出现坏尾行后才存在；完整 JSON 缺 LF 只补换行、不转存）
      replies.jsonl.torn           # 同上（回复 journal）
      bodies/<messageId>.<sha16>.txt
      .lock                        # 跨进程互斥
    connector/
      <sha256>.json                # 每个逻辑激活一条调用记录
      audit.jsonl                  # 人工处置审计（append-only）
  instances/.locks/<instanceId>.lock  # 执行所有权 claim / release 的 flock 锚点（常驻，放在实例目录之外）
  worktrees/<workspaceId>/<instanceId>/   # 实例 worktree
  worktree-registry/<workspaceId>/<instanceId>.json  # 所有权记录
```

目录 0700、文件 0600；记录写入走临时文件 + fsync + rename，读者不会看到半截 JSON。

### 锁与平台

- **适用范围**：本节描述的是**资源锁**（`resources/.lock` 与 worktree 创建等资源临界区）、**收件箱锁**（`inbox/.lock`）和**执行所有权锁**（`instances/.locks/<instanceId>.lock`），它们复用 `instance-resources.js` 的 `flock` 实现。定义 / 实例元数据的写入锁是**另一套**：`definitions/` 根与每个 `instances/<id>/` 下的 `.lock` 由 `definition-store.js` / `instance-store.js` 用 `O_EXCL` 锁文件 + nonce 复核 + 过期 `rename` 接管实现，不是 `flock`；两者的平台降级与错误码不同，不要混为一谈。
- 跨进程互斥用 util-linux `flock`：锁由**宿主进程自己的 fd** 持有（helper 进程只是持锁代理，fd 3 是同一打开文件描述的副本），因此 helper 单独死亡不等于失锁；持有期间 helper 退出会让临界区收到 `RESOURCE_LOCK_LOST` 并 **fail-closed 中止**，第二持有者在内核层被挡住。
- 没有 `flock`（或 fd 形式不生效）的平台——Windows、macOS 无 util-linux、部分沙箱——降级为**进程内队列**：只保证同进程串行，**跨进程互斥不成立**；降级路径同样尊重 `waitMs`，超时返回 `RESOURCE_LOCK_TIMEOUT` 且不进入临界区。
- 锁文件常驻、不删除：它是 inode 锚点，运行期外部 `unlink` / `rename` 锁文件会让两个进程持有不同 inode 的锁，破坏互斥。锁目录应放在本地盘（NFS / SMB 的 flock 语义不保证），并视为 Host 私有目录。
- 正文物化文件（`.flow-studio-inbox/…`）与锁文件都**不做在线自动回收**：正文在实例结束后仍可能被 agent 读取，删早了会让已经交付的路径失效；需要回收时按实例目录整体清理（维护动作），不在投递路径里做 TTL 删除。

`messages.jsonl` / `replies.jsonl` 的尾部修复在**锁内、replay / 幂等判断 / seq 分配之前**完成：完整 JSON 只是缺末尾 `\n` 的记录补一个换行正规化（不能当坏尾转存或丢弃，否则已受理记录会在下一次追加时消失）；只有真正不完整的尾行才转存到 `.torn` 并截断主 journal；追加写按 `bytesWritten` 循环补齐短写。

### 模型工具

实例域注册十三个会话工具，参数与返回以 `src/instance-tools.js` 的 schema 为准；全部直接调用上表的 HTTP 处理器（同一个 runtime 实例），因此字段与业务码与本页一致。旧运行域的 `flow_*` 工具已在 0.14.0 删除，不再注册。

| 工具 | 对应路由 | 参数 | 返回 |
|---|---|---|---|
| `flow_instance_worktrees` | `inspect` → `GET /instances/<id>/worktree`；`remove` → `DELETE /instances/<id>/worktree`；`branch` → `DELETE /instances/<id>/worktree/branch`；`list` → `GET /instance-worktrees`；`prune` → `POST /instance-worktrees/prune` | `action`（必填，`inspect` / `remove` / `branch` / `list` / `prune`）、`instanceId`（前三项必填）、`workspaceId`（`list` / `prune`）、`force`、`removeBranch`、`dryRun`、`planHash`、`expectedHead` | 路由响应体 + `action` + `status`；`list` 另加 `worktreeCount` / `orphanCount` / `truncated` |
| `flow_instance_send_message` | `POST /instances/<id>/messages` | `instanceId`（绑定会话里可省略且不能改）、`messageId`、`target`、`text`、`replyTargetId?` | `duplicate`、`message`、`delivery` |
| `flow_instance_reply` | `POST /instances/<id>/messages/<messageId>/replies` | `instanceId`（同上）、`messageId`、`replyId?`、`text?`、`document?` | `duplicate`、`reply` |
| `flow_definition_list` | `GET /definitions` | `keyword?`、`limit?`（默认 50，封顶 200） | `definitions[]`（短摘要，不含 XML）、`total`、`count`、`hasMore` |
| `flow_definition_get` | `GET /definitions/<id>[?version=]` | `definitionId`、`version?` | 元数据 + `xml`（≤64 KiB；超出 `xmlTruncated:true`，真实字节数在 `xmlBytes`）+ `versions[]` |
| `flow_instance_run` | `POST /instances` | `definitionId`、`version?`、`variables?`、`workspace?`、`worktree?` | `instanceId`、`definitionId`、`definitionVersion`、`status`、`startedBy`、`pendingTasks`、`lastSeq`、`workspace?`、`startError?` |
| `flow_instance_list` | `GET /instances` | `definitionId?`、`status?`、`limit?`（默认 50，封顶 200）、`cursor?` | `instances[]`（短摘要）、`hasMore`、`nextCursor`、`skipped[]` |
| `flow_instance_get` | `GET /instances`（纯读列表，不懒恢复） | `instanceId`（绑定会话可省略且不能改）、`include?`（`tasks` / `artifacts` / `lastError`） | 实例事实 + `include` 展开的区块；基础结果带 `pendingTaskCount` / `lastErrorCode` |
| `flow_instance_events` | `GET /instances/<id>/events?since=` | `instanceId`（同上）、`since?`、`limit?`（默认 50，封顶 200） | `events[]`（短字段；长正文给 `bodyRef`）、`lastSeq`（连续可见水位）、`nextSince`、`hasMore`、`skipped`、`shards` |
| `flow_instance_cancel` | `POST /instances/<id>/stop` | `instanceId`（同上）、`reason?` | `status`（`CANCELED`）、`alreadyTerminal`、`pendingTasks`、`lastSeq`、`reason` |
| `flow_instance_complete_task` | `POST /instances/<id>/tasks/<activityId>/complete` | `instanceId`（同上）、`activityId`、`payload?` | `activityId`、`executionId`、`status`、`pendingTasks`、`lastSeq`、`decidedBy`、`recovered` |
| `flow_instance_suspend` | `POST /instances/<id>/suspend` | `instanceId`（同上）、`reason?`（≤200） | `status`（`SUSPENDED`）、`reason`、`lastSeq`、`suspendedAt`、`httpStatus`；409 时 `code` + `error` / `hint`，`INSTANCE_SUSPEND_BUSY` 另带 `activities[]`；`expectedStatus` / `actualStatus` 只在 HTTP 响应体里，工具面不投影 |
| `flow_instance_resume` | `POST /instances/<id>/resume` | `instanceId`（同上）、`reason?`（≤200） | `status`（`ACTIVE`）、`reason`、`lastSeq`、`resumedAt`、`httpStatus` |

- 在 agent 节点会话里，工具带 `{instanceId, executionId?, activityId?}` 绑定：省略 `instanceId` 就用绑定实例，显式传成别的实例会被参数校验拒绝（防止跨实例投递 / 跨实例取消 / 跨实例完成任务）。
- `prune` 的执行意图与计划是两件事：省略 `dryRun` 一律按 `true` 预览；只有显式 `dryRun:false` 且带 `planHash` 才执行。
- `flow_instance_reply` 要求 `text` 与 `document` 至少给一项（与 HTTP 路由一致）；`document` 的 `path` 按实例冻结工作区的相对路径解析。
- 读类工具是 **GET 语义**：`flow_instance_get` 读 `GET /instances` 的磁盘列表（不调用 `_ensureRunner()`），`flow_instance_events` 读事件文件；查询不会懒恢复、不会创建 runner、不派发工作。`flow_instance_get` 单次扫描上限 1000 个实例（与路由 `limit` 一致）。
- `flow_instance_run` 的 `variables` 与 `flow_finish_node` 同口径：只接受 boolean / number / null / 短字符串，键 ≤32、单串 ≤512 Unicode 字符、序列化 ≤8 KiB；嵌套对象 / 数组 / 超限直接返回 `NODE_VARIABLES_INVALID`，不发请求。
- `workspace` 是宿主 allowlist 内的绝对路径；`worktree` 复用 `POST /instances` 的启动契约（`auto` / `on` / `off`，或 `{mode, cleanup, baseRef}`；给 `worktree` 必须同时给 `workspace`）。当前 runtime 没有 workspace / worktree 能力时明确返回 `WORKSPACE_POLICY_MISSING`，不静默忽略参数。
- `startedBy` 绑定本次调用的会话 id（`exec.agent.session.id`，兜底 `session.header.id`），落盘在 `instance.json`，重启后仍可读；没有会话上下文时为 `null`，不推断「最近一次启动」。
- 成功结果里 `status` 是**实例状态**，路由的 HTTP 语义状态在 `httpStatus`。失败结果里只有 `flow_instance_suspend` / `flow_instance_resume` 用同一口径：HTTP 状态进 `httpStatus:number`，`status` 只在响应体确实带实例状态字符串时才出现（0.14.4 起，工具自己的 output schema 把 `status` 声明为 string）；其余 11 个工具沿用旧契约——失败结果的 `status` 是 HTTP 错误状态。
- `flow_instance_complete_task` 与 GUI 的 `POST /tasks/<activityId>/complete` 共用同一份实现与校验；重复完成返回 `TASK_ALREADY_COMPLETED` 且不产生新事件。终态实例的 `flow_instance_cancel` 返回 `INSTANCE_ALREADY_TERMINAL`，同样不产生事件；`reason` 只随结果回显，stop 路由不落盘业务原因。
- `flow_instance_list` 的 `cursor` 是上一页返回的 `nextCursor`（实例 id），只在该结果集内有效；结果集变化或超出单次扫描上限时返回 `CURSOR_INVALID`，从第一页重新开始。
- `flow_instance_events` 只返回短字段：单条事件里的 `output` / `condition` / `artifacts` 或超长字符串超过 1 KiB 时替换为 `{bodyRef, bytes, truncated}`，`bodyRef` 指向读取原始事件的 `GET /instances/<id>/events?since=` 路径。它的 `lastSeq` 与路由同口径（连续可见水位，不是本批最大 seq），但工具面**不投影** `eventLogGap` / `eventsHash`：要判断事件正文是否有缺口，走 HTTP `GET /instances/<id>/events`。
- `flow_instance_suspend` / `flow_instance_resume` 与路由同一份实现：挂起只在无在飞活动 / 无准备窗口 / 无外部执行所有权时成功（`INSTANCE_SUSPEND_BUSY` 带 `activities[]`，`kind` 可能是 `agent` / `engine` / `event-queue` / `preparing` / `http` / `owner`），状态刚被别处改过时映射 `INSTANCE_LIFECYCLE_CONFLICT`；工具结果只带 `code` / `error` / `hint`（`activities[]` 仅 BUSY），不投影 HTTP 响应体的 `expectedStatus` / `actualStatus`。挂起期间 `flow_instance_complete_task` 返回 `INSTANCE_SUSPENDED`；恢复不主动跑。两者 `reason` 上限 200 字符（与路由一致），重复挂起 / 未挂起恢复分别映射 `INSTANCE_ALREADY_SUSPENDED` / `INSTANCE_NOT_SUSPENDED` 并带中文 hint。成功返回**不投影**路由的 `committed` / `eventLogPending`（要判断事件正文是否补写，走 HTTP 响应）。不提供 watch / 定时唤醒 / 自动重试类工具；需要外部触发时由调用方轮询 `flow_instance_events` 或发消息。
- 工具结果有界裁剪：字符串字段 2 KiB、数组 200 项、深度 8（`flow_definition_get` 的 XML 与 `flow_instance_events` 的短字段投影按各自上限处理）。超时：worktree 工具 60 秒、消息 / 回复 / 读类工具 30 秒、`flow_instance_run` 与 `flow_instance_complete_task` 10 分钟（可能等在飞 agent）。
- 失败时工具返回 `{ok:false, error, hint, retryable, code?, status?}`（生命周期工具用 `httpStatus` 代替 `status`，见上）；参数错误、404、409、`INSTANCE_WORKTREE_PLAN_STALE`、`TASK_ALREADY_COMPLETED`、`INSTANCE_ALREADY_TERMINAL`、`CURSOR_INVALID`、`WORKSPACE_POLICY_MISSING` 都不标 `retryable`。

## 错误码

### HTTP 状态与业务码

| 状态 | code | 触发 / 来源 |
|---|---|---|
| 400 | `BPMN_BODY_INVALID` | 请求体不是 JSON 对象（多处写路由） |
| 400 | `BPMN_XML_REQUIRED` / `BPMN_XML_INVALID` | `POST /definitions` 缺 XML / XML 或 BPMN 子集校验失败 |
| 400 | `BPMN_DEFINITION_ID_INVALID` | 定义 id 非法 |
| 400 | `BPMN_VERSION_INVALID` | `?version=` 或 `definitionVersion` 非法 |
| 400 | `BPMN_VARIABLES_INVALID` | `variables` 不是对象 |
| 400 | `INSTANCE_SHAPE_INVALID` | `variables` 超 256 KiB 等实例形状非法 |
| 400 | `INSTANCE_EVENTS_LIMIT` | 单实例事件总数达到上限，拒绝继续追加（`instance-store.js` 的硬上限） |
| 400 / 500 | `INSTANCE_STATE_INVALID` / `INSTANCE_STATE_CORRUPT` | 引擎快照形状非法（超上限 / 不是对象）/ 读不出来（坏 JSON） |
| 400 | `INSTANCE_INVALID_ID` | `definitionId` 非法（创建 / 列表过滤） |
| 400 | `INSTANCE_FILTER_INVALID` | `status` 过滤值非法 |
| 400 | `BPMN_LIMIT_INVALID` | `limit` 不是正整数 |
| 400 | `BPMN_INSTANCE_ID_INVALID` | 路径里的实例 id 非法 |
| 400 | `BPMN_ACTIVITY_ID_INVALID` | 路径里的 `activityId` 为空或超 128 字符 |
| 400 | `BPMN_PAYLOAD_INVALID` | 人工任务 `payload` 不是对象 |
| 400 | `BPMN_REASON_INVALID` | 挂起 / 恢复的 `reason` 不是 ≤200 字符的短字符串（含控制字符） |
| 400 | `BPMN_SEQ_INVALID` | `since` 不是非负整数 |
| 400 / 500 | `BPMN_DEFINITION_INVALID` | 实例定义快照未通过 BPMN 校验（启动时 400；懒恢复时 500） |
| 400 | `BPMN_WORKSPACE_INVALID` | `workspace` 选项形状或取值非法 |
| 400 | `BPMN_STARTED_BY_INVALID` | `startedBy` 不是短字符串（含控制字符 / 超过 200 字符） |
| 400 | `BPMN_WORKSPACE_ID_INVALID` | `workspaceId` 不是 12 位小写十六进制 |
| 400 | `BPMN_EXPECTED_HEAD_INVALID` | `expectedHead` 不是 40–64 位十六进制 |
| 400 | `WORKSPACE_INVALID` / `WORKSPACE_MISSING` / `WORKSPACE_NOT_GIT` | 工作区解析 / 使用失败（`WORKSPACE_CWD_OUTSIDE` 只出现在节点执行的 `lastError`） |
| 400 | `INSTANCE_WORKTREE_INVALID` / `INSTANCE_WORKTREE_NOT_GIT` | worktree 参数非法 / 工作区不是 Git 仓库根 |
| 400 | `INSTANCE_WORKTREE_PLAN_INVALID` | 执行 prune 缺 `planHash` 或格式错误 |
| 400 | `MESSAGE_INVALID` | 消息 / 回复的 id、target、text、document 等参数非法 |
| 400 | `MESSAGE_CURSOR_INVALID` / `MESSAGE_LIMIT_INVALID` | 收件箱分页参数非法 |
| 400 | `MESSAGE_REPLY_TARGET_REQUIRED` | 回复没有可用的 `targetId` |
| 400 | `MESSAGE_REPLY_TARGET_ARBITRARY` | 回复请求试图自带 `url` / `sessionId` / `session` / `target` |
| 400 | `MESSAGE_DOCUMENT_UNSAFE` | 附件路径越界、不存在、不是普通文件、sha256 不符、或没有冻结工作区 |
| 400 | `HTTP_RESOLVE_INVALID` | connector 处置的 action / evidence / operator / result 非法 |
| 401 | `UNAUTHORIZED` | 宿主鉴权拒绝（见 [Host 接口 · 鉴权](host-api.md#鉴权)） |
| 403 | `FORBIDDEN` / `READ_ONLY_TOKEN` | 同源拒绝 / 只读令牌执行写操作 |
| 403 | `WORKSPACE_NOT_ALLOWED` | 工作区不在 `FLOW_STUDIO_WORKSPACE_ROOTS` 内 |
| 403 | `MESSAGE_REPLY_TARGET_UNKNOWN` | `replyTargetId` / `targetId` 不在宿主白名单 |
| 404 | `DEFINITION_NOT_FOUND` / `DEFINITION_VERSION_NOT_FOUND` | 定义或指定版本不存在 |
| 404 | `INSTANCE_NOT_FOUND` | 实例不存在 |
| 404 | `BPMN_TASK_NOT_FOUND` | 人工任务不存在或不在等待 |
| 404 | `BPMN_ROUTE_NOT_FOUND` | BPMN 处理器内的子路径未知 |
| 404 | `INSTANCE_WORKTREE_NOT_CONFIGURED` / `INSTANCE_WORKTREE_NOT_FOUND` | 实例没有登记 worktree / 主仓库不存在 |
| 404 | `MESSAGE_INSTANCE_NOT_FOUND` / `MESSAGE_ACTIVITY_NOT_FOUND` / `MESSAGE_NOT_FOUND` | 收件箱路由的实例 / 节点 / 消息不存在 |
| 404 | `HTTP_INVOCATION_NOT_FOUND` | connector 记录不存在 |
| 405 | `BPMN_METHOD_NOT_ALLOWED` | 方法不匹配 |
| 409 | `DEFINITION_LOCK_TIMEOUT` | 定义目录锁等待超时 |
| 409 | `INSTANCE_LOCK_TIMEOUT` | 实例目录锁等待超时（另一个进程正在写这个实例） |
| 409 | `WORKSPACE_UNAVAILABLE` / `WORKSPACE_CORRUPT` | 工作区快照缺失 / 损坏（不静默回退宿主目录） |
| 409 | `BPMN_INSTANCE_TERMINAL` / `BPMN_INSTANCE_STOPPING` | 实例已终态 / 正在停止 |
| 409 | `INSTANCE_SUSPEND_BUSY` | 挂起时有未结算的活动 / 准备窗口 / 另一个活进程持有执行所有权（响应带 `activities[]`，`kind` 见 [挂起 / 恢复](#挂起与恢复)） |
| 409 | `INSTANCE_ALREADY_SUSPENDED` / `INSTANCE_NOT_SUSPENDED` | 重复挂起 / 对非 `SUSPENDED` 实例恢复 |
| 409 | `INSTANCE_SUSPENDED` | 实例已挂起时：完成人工任务 / 收口成 `COMPLETED` / 追加执行事件 / 写引擎快照（先 resume；唯一例外是错误事实通道的 `error` 事件与不可恢复墓碑） |
| 409 | `INSTANCE_LIFECYCLE_CONFLICT` | 挂起 / 恢复的条件提交发现状态已被别处改过（带 `expectedStatus` / `actualStatus`，零写入、无新事件） |
| 409 | `BPMN_INSTANCE_ACTIVE_ELSEWHERE` / `BPMN_OWNER_UNKNOWN` | 懒恢复 / 首次启动 / claim 竞争时发现执行所有权在另一个活进程手里，或记录无法确认；`GET` 仍 200 + `recovery.code`，写操作通常投影成 `BPMN_INSTANCE_NOT_RECOVERABLE` + `recoveryCode` |
| 409 | `BPMN_INSTANCE_BLOCKED` | runner 已停机（热路径）或磁盘已有 `executionFailure`（冷路径）；带 `recoveryCode`（取 `lastError.code` / `executionFailure.code`） |
| 409 | `BPMN_INSTANCE_NOT_WAITING` / `BPMN_INSTANCE_NOT_RECOVERABLE` | 没有等待中的人工任务 / 无法重建 runner（state 缺失、墓碑、定义损坏等）；后者带 `recoveryCode` |
| 409 | `INSTANCE_TERMINAL_IMMUTABLE` | 写操作与 stop / 终态收口竞争失败 |
| 409 | `MESSAGE_INSTANCE_TERMINAL` / `MESSAGE_ID_CONFLICT` / `MESSAGE_REPLY_ID_CONFLICT` | 实例终态拒绝消息 / 幂等键内容冲突 |
| 409 | `MESSAGE_REPLY_DISPATCH_IN_FLIGHT` | 同一回复已在另一个进程投递中（或无法确认旧领取者是否存活），不允许并发重复外发；Host 不按时间自动接管 |
| 409 | `INSTANCE_WORKTREE_INSTANCE_ACTIVE` | 实例 `ACTIVE` / `SUSPENDED` 时清理 worktree 或分支 |
| 409 | `INSTANCE_WORKTREE_DIRTY` / `INSTANCE_WORKTREE_LOCKED` / `INSTANCE_WORKTREE_NOT_REGISTERED` / `INSTANCE_WORKTREE_HEAD_MISMATCH` / `INSTANCE_WORKTREE_BRANCH_NOT_OWNED` / `INSTANCE_WORKTREE_PLAN_STALE` | 脏树、locked、未登记、HEAD 变化、分支不属于实例、plan 过期 |
| 409 | `INSTANCE_WORKTREE_CREATE_FAILED` | 目标路径已存在 / 分支冲突（其它原因 500） |
| 409 | `HTTP_RESOLVE_CONFLICT` | connector 处置动作与记录状态冲突（如 retry 已成功记录） |
| 410 | `MESSAGE_TARGET_EXPIRED` | 精确目标的 execution 已结束或不属于该实例 |
| 413 | `MESSAGE_BODY_TOO_LARGE` | 消息 / 回复 / 附件超过 1 MiB |
| 500 | `BPMN_INTERNAL_ERROR` | 未分类内部错误（包括 connector 存储写失败等未映射错误） |
| 500 | `DEFINITION_CORRUPT` / `INSTANCE_CORRUPT` | `meta.json` / `instance.json` 结构损坏或 hash 不一致 |
| 500 | `INSTANCE_ID_EXHAUSTED` | 创建实例时连续生成的新 id 都撞车（重试即可） |
| 500 | `INSTANCE_SNAPSHOT_MISSING` / `INSTANCE_SNAPSHOT_CORRUPT` | 实例定义快照缺失 / 与 `definitionHash` 不一致 |
| 500 | `BPMN_STATE_READ_FAILED` / `BPMN_STATE_WRITE_FAILED` / `BPMN_EVENT_WRITE_FAILED` / `BPMN_EVENT_UNSERIALIZABLE` / `INSTANCE_VANISHED` | 状态或事件落盘失败、实例启动过程中消失（不静默吞掉） |
| 500 | `INSTANCE_WORKTREE_REMOVE_FAILED` / `INSTANCE_WORKTREE_PATH_UNSAFE` / `INSTANCE_WORKTREE_CREATE_FAILED`（非冲突） | worktree 删除 / 路径 / 建树失败 |
| 500 | `MESSAGE_BODY_CORRUPT` / `MESSAGE_WRITE_FAILED` | 收件箱正文或 journal 损坏 / 写失败 |
| 502 | `MESSAGE_REPLY_HTTP_STATUS` / `MESSAGE_REPLY_DELIVERY_UNSUPPORTED` / `MESSAGE_REPLY_SESSION_NOT_LIVE` 等 | 回复投递失败；`code` 取 `reply.lastError.code` |
| 503 | `AUTH_SERVICE_UNAVAILABLE` | 拿不到宿主 `connection` 服务（fail-closed） |
| 503 | `BPMN_RUNTIME_DISPOSED` | runtime 已 dispose |
| 503 | `BPMN_INSTANCE_ACTIVE_ELSEWHERE` | 同进程活跃表已有该实例的 runner（`BPMN_INSTANCE_ID_CONFLICT`）；跨进程所有权竞争见 409 行 |
| 503 | `BPMN_HANDLER_MISSING` / `BPMN_HANDLER_FAILED` / `BPMN_LRU_EVICT_UNSNAPSHOTTED` | 引擎侧 handler / 活跃表 / LRU 快照问题 |
| 503 | `WORKSPACE_GIT_UNAVAILABLE` / `WORKSPACE_GIT_FAILED` / `INSTANCE_WORKTREE_GIT_UNAVAILABLE` | Git 不可用或调用失败 |

### 非 HTTP 失败码

以下码不单独决定 HTTP 状态，而是出现在 `lastError.code`、`error` 事件、`recovery.code`、`message.delivery` 或 `reply.lastError` 里：

| 位置 | code | 含义 |
|---|---|---|
| `recovery.code` | `BPMN_STATE_MISSING` / `BPMN_STATE_STOPPING` / `BPMN_STATE_SUSPENDED` / `BPMN_STATE_UNRECOVERABLE` / `BPMN_STATE_NOT_RESUMABLE` / `BPMN_STATE_RECOVER_FAILED` / `BPMN_INSTANCE_ACTIVE_ELSEWHERE` / `BPMN_OWNER_UNKNOWN` | 不可恢复 / 正在停止 / 已挂起（读不恢复）/ 墓碑 / state 不能续跑 / 恢复失败 / 执行所有权被另一个活进程持有 / 所有权无法确认；也可能带 runner 侧的 `BPMN_STATE_DEFINITION_MISMATCH`、`BPMN_STATE_VERSION_UNSUPPORTED` 等 |
| `lastError.code` | `BPMN_AGENT_ADAPTER_UNSUPPORTED` / `BPMN_AGENT_ADAPTER_UNAVAILABLE` / `BPMN_ACTIVITY_TIMEOUT` / `BPMN_ABORTED` / `BPMN_AGENT_HANDLE_INVALID` / `NODE_FINISH_INVALID` / `WORKSPACE_UNAVAILABLE` / `WORKSPACE_CWD_OUTSIDE` | agent 节点执行失败（`src/agent-execute.js` 的 `AGENT_EXECUTE_ERROR`）；创建实例时同一码也出现在响应的 `error.code` |
| `lastError.code` | `NODE_FINISH_MISSING` / `NODE_FINISH_FAILED` / `NODE_FINISH_CHANNEL_FAILED` / `NODE_FINISH_TOOL_UNAVAILABLE` / `NODE_FINISH_ABORTED` / `NODE_FINISH_BRIDGE_TIMEOUT` / `DSH_AGENT_FAILED` / `DRAIN_FAILED` / `CLAUDE_PROVIDER_ERROR` / `CODEX_CLI_TURN_FAILED` / `CODEX_CLI_ERROR` / `CODEX_CLI_EXIT_NONZERO` / `CODEX_CLI_SIGNALED` 等 | agent 节点的未完结 / 终态错误。`NODE_FINISH_CANCELED` 在 executor 里转成 `BPMN_ABORTED`，不原样进 `lastError`；provider 错误的 `error.code` / `subtype` / `message` / `errorDetails` 口径见 [design/11 §4.1](../design/11-node-finish-tool.md#41-终态错误分类0146) |
| `lastError.code` | `BPMN_ENGINE_ERROR` / `BPMN_HANDLER_FAILED` / `EXECUTION_LIMIT_UNAVAILABLE` | 引擎执行 / 执行槽位获取失败的兜底码（没有更具体的业务码时） |
| `lastError.code` | `HTTP_OUTCOME_UNKNOWN` / `HTTP_REDIRECT_FORBIDDEN` / `HTTP_TIMEOUT` / `HTTP_REQUEST_TOO_LARGE` / `HTTP_RESPONSE_TOO_LARGE` / `HTTP_REQUEST_CONFLICT` / `HTTP_STORE_STALE` 等 | connector 调用失败或结果不明 |
| `message.delivery.code` | `MESSAGE_DELIVERY_UNSUPPORTED` / `MESSAGE_DELIVERY_FAILED` / `MESSAGE_WORKSPACE_UNAVAILABLE` / `MESSAGE_BODY_UNSAFE` / `MESSAGE_DELIVERY_STATE_WRITE_FAILED` / `DSH_SESSION_NOT_ACTIVE` / `DSH_DELIVERY_UNAVAILABLE` / `DSH_INBOX_DELIVERY_FAILED` / `CODEX_MESSAGE_DELIVERY_UNSUPPORTED` / `CLAUDE_MESSAGE_DELIVERY_UNSUPPORTED` | 入站消息投递失败；消息状态为 `failed`，`deliveryUnknown` 视情况为 `true`。`MESSAGE_BODY_UNSAFE` 表示物化路径含软链 / 非普通文件 / 父目录被替换 / 写失败，已拒绝且未投递。`MESSAGE_DELIVERY_STATE_WRITE_FAILED` 表示适配器已接收但成功状态写不回 journal：`deliveryUnknown:true`（**可能已投递**），不自动重发 |
| `reply.lastError.code` | `MESSAGE_REPLY_DELIVERY_UNSUPPORTED` / `MESSAGE_REPLY_SESSION_NOT_LIVE` / `MESSAGE_REPLY_HTTP_STATUS` / `MESSAGE_REPLY_TIMEOUT` / `MESSAGE_REPLY_UNSUPPORTED` / `MESSAGE_INSTANCE_TERMINAL` / `MESSAGE_REPLY_TARGET_UNKNOWN` | 回复 outbox 投递失败 / 跳过；`MESSAGE_REPLY_UNSUPPORTED` 表示既无文本也无附件引用 |
| connector 记录 | `HTTP_MANUAL_FAILED` / `HTTP_NOT_SENT` | `mark-failed` 写入的记录级错误码；`HTTP_NOT_SENT` 表示请求在真正发出前就被取消 / 超时，远端没有收到 |

`DEFINITION_VERSION_IMMUTABLE` 是 `saveDefinitionVersion()` 的存储层约束（同一 `(id,version)` 换内容即 409），当前 HTTP 路由不接受显式版本，因此不把它列为路由可触发的业务码。

`src/instance-store.js` 还有一组**只对内部调用方**（生命周期路由 / 运行时）生效的约束码，HTTP 路由不会直接把它们抛给调用方：`INSTANCE_SUSPENDED_IMMUTABLE`（挂起期间用 `updateInstance` 写回 `ACTIVE`）、`INSTANCE_LIFECYCLE_USE_ROUTE`（用 `updateInstance` 把非挂起实例改成 `SUSPENDED`，状态迁移只走生命周期路由）、`INSTANCE_EXPECTED_STATUS_REQUIRED`（`appendInstanceEvents` 带 `status` 却没带 `expectedStatus`）、`INSTANCE_PATCH_INVALID`（`metaPatch` 只允许 `lastError` / `pendingTasks` / `executionFailure`）、`INSTANCE_EVENT_APPEND_FAILED`（元数据已提交、事件正文追加失败，带 `committed:true` / `eventLogPending:true` / `firstSeq` / `lastSeq` / `status` / `revision` / `eventLogError`）、`INSTANCE_METADATA_WRITE_FAILED`（元数据本身没写成，`committed:false`）。生命周期路由会把 CAS 冲突翻译成 409 `INSTANCE_LIFECYCLE_CONFLICT`、把 `committed:true` 翻译成 200 + `eventLogPending`；其余照常抛。`src/instance-owner.js` 的 `INSTANCE_OWNED_ELSEWHERE` / `INSTANCE_OWNER_UNKNOWN` 同样只在内部使用，runtime 把它们投影成上表的 `BPMN_INSTANCE_ACTIVE_ELSEWHERE` / `BPMN_OWNER_UNKNOWN`。另外 `INSTANCE_NOT_ACTIVE`（409）只出现在挂起 / 首次启动的防御路径里：四个状态中 `SUSPENDED` 走 `INSTANCE_ALREADY_SUSPENDED`、终态走 `BPMN_INSTANCE_TERMINAL`，正常协议不会触发它。

## 延伸阅读

- 设计记录与阶段边界：[design/10 · BPMN 实例 API](../design/10-bpmn-instance-api.md)
- Host 层鉴权与安全开关：[Host 接口](host-api.md)
- 定义 / 实例的落盘布局与字段：[数据模型](data-model.md)
- 实例事件 kind 与分片规则：[design/10 §5](../design/10-bpmn-instance-api.md#5-事件-kind-表)
