# 05 · 运行日志与指标数据契约

> 本册定义 **v0.3 日志骨架**：run 目录、事件格式、Host 接口、聚合口径、客户端展示。
> 实现前先定格式——执行引擎（v0.4）与指标看板都从这份日志派生，格式一改全跟着改。
> 与 `04-metrics.md` 的关系：04 定义**指标怎么算**，本册定义**原始记录长什么样**。

## 1 落盘布局

```
$DSH_HOME/flow-studio/runs/
  <runId>/
    run.jsonl                      # run 级事件：开始 / 结束 / 状态变更
    run.json                       # run 元数据（可变，原子写）：名字、flowId、状态、计数
    <nodeId>/
      <attemptId>.jsonl            # 该节点这一次执行的全部事件
      artifacts/                   # 该次执行的产物（需求清单 / 方案 / diff / 报告）
    .index                         # 可选：run 目录的 mtime 快速索引（实现可省，读时扫描兜底）
```

- **append-only**：`.jsonl` 只追加、不重写；修正在于追加新事件（同一 `traceId` 的后续事件覆盖语义由读取方按 §4 处理）。
- **run.json 例外**：只有元数据（名字、状态、计数）可被原子重写；事件永不改写。
- 目录权限 `0700`，文件 `0600`；`runId / nodeId / attemptId` 一律过 `^[A-Za-z0-9._-]{1,64}$` 校验，防路径穿越。

## 2 事件格式

每行一个 JSON 对象，字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `v` | ✓ | 恒为 `1` |
| `ts` | ✓ | ISO-8601 带偏移，服务端补齐（客户端可给，非法则以服务端时间为准） |
| `kind` | ✓ | 见下表 |
| `runId` | ✓ | |
| `nodeId` | 节点事件必填 | 对应流程节点 id |
| `attemptId` | 节点事件必填 | 正整数，打回重跑 = 新 attempt |
| `memberId` | 可选 | 主管下子 agent 身份，单 agent 为 `null` |
| `traceId` | ✓ | 一次因果链（发起 → 工具 → 结论）共用同一个 id |
| `data` | 按 kind | 该 kind 的负载 |
| `ref` | 可选 | `{ sessionId, logLine }` 指回 DSH 原生会话日志，不重复存正文 |
| `extra` | 可选 | 未识别字段兜底（有界：键 ≤16、单串 ≤256、总字节 ≤2048） |

`kind` 取值（未知 kind 一律拒绝写入，不静默存）：

| kind | data 关键字段 | 来源 |
|---|---|---|
| `run/start` | `flowId`、`flowName`、`nodeTotal` | 引擎 |
| `run/end` | `status`（`done`/`aborted`/`failed`）、`reason?` | 引擎 |
| `node/start` | `title`、`mode`（`single`/`team`）、`model?`、`skills[]` | 引擎 |
| `node/end` | `status`（`passed`/`rejected`/`failed`/`skipped`）、`durationMs` | 引擎 |
| `member/start` | `name`、`role?`、`model?` | 引擎 |
| `member/end` | `status`（`passed`/`failed`/`aborted`/`partial`）、`durationMs` | 引擎 |
| `model/call` | `provider`、`model`、`usage`（见 §3）、`stopReason?` | 宿主事件归集 |
| `tool/call` | `name`、`argumentsDigest?`、`ok`、`durationMs?` | 宿主事件归集 |
| `skill/load` | `skill`（唯一名）、`ok` | `tool/call` 里 `name==='skill'` |
| `artifact/write` | `path`（相对 run 目录）、`bytes`、`kind`（`md`/`diff`/`json`/`log`） | 引擎 |
| `reject/trigger` | `edgeId`、`fromNodeId`、`toNodeId`、`reason` | 引擎 |
| `review/finding` | `id`、`severity`（`P0`/`P1`/`P2`）、`category?`、`title`、`status`（`open`/`accepted`/`fixed`/`verified`/`dismissed`） | `structured_output` |
| `review/verdict` | `verdict`（`approve`/`reject`）、`findingCount` | `structured_output` |
| `check/form` | `ruleSetId`、`ruleSetVersion`、`executor`、`state`（`pass`/`fail`/`skipped`/`na`）、`passedChecks?`、`totalChecks?`、`reportRef?` | 规范检查器 |

## 3 用量（token）四桶

`data.usage` 只认宿主 `TokenUsage` 的四个**互斥**桶：

```json
{"input": 8123, "cacheRead": 40211, "cacheWrite": 0, "output": 642, "reasoning": 310}
```

- `input` = 未命中缓存的输入；`cacheRead` / `cacheWrite` 独立成桶，**不得**声称「无成本」。
- `reasoning` 可选，且必须 `≤ output`（它是 output 的子集，不另计）。
- 合计 `total = input + cacheRead + cacheWrite + output`（`reasoning` 不加）。
- 重放/重试：同一 `traceId + data.callId` 的用量按**替换**处理（后到的整条替换先到的），不是累加。

## 4 聚合口径（`GET /runs/<runId>/summary`）

确定性计算，不猜：

- `tokens`：按 `nodeId` 与 `memberId` 分组累计四桶 + `total`；`run` 合计。
- `skillUsage`：`node/start.data.skills` 是**声明集**，`skill/load` 是**实际加载集**；`coverage = |声明 ∩ 已加载| / |声明|`（唯一名去重）；加载次数（成功/失败）单列，不与覆盖率混用。
- `findings`：`review/finding` 按 `severity` 计数，并分 `open+accepted+fixed`（未解决）与 `verified`（已复验）；**采纳 ≠ 修复 ≠ 复验**。
- `rejects`：`reject/trigger` 计数，按边与目标节点两个维度各出一份。
- `progress`：`node/end` 里 `passed` 节点数 / 总阶段数；`skipped` 单列不计入分母。
- `quality`：所有必要证据（验收条目、测试、规范、审查一致性、P0/P1 未解决）**齐全且通过**才给结论；缺任一证据 → `unknown`（未检测），**不给绿灯**。
- 所有聚合返回 `computedAt` 与 `eventCount`，便于判断数据是否过期。

## 5 Host 接口

前缀 `/api/flow-studio`，同源校验同 v0.2（`Origin` 与 `Host` 不一致 → 403）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/runs` | 最近 run 列表（`limit` 默认 20，按 `startedAt` 倒序）：`{id,name,flowId,flowName,status,startedAt,endedAt,nodeDone,nodeTotal,tokenTotal}` |
| POST | `/runs` | 新建 run：`{flowId, name?}` → `{run}`；`nodeTotal` 取流程的阶段节点数 |
| GET | `/runs/<runId>` | run 元数据 + 节点/attempt 索引（含每个 attempt 的事件数与首末时间） |
| GET | `/runs/<runId>/events` | 事件流：`nodeId`、`attemptId`、`kind`、`since`（seq/ts）、`limit`（默认 200，上限 1000）、`order=desc`；返回 `{events,total,truncated}` |
| POST | `/runs/<runId>/events` | 追加事件：单条或数组（≤200 条/次）；逐条校验 kind 与必填字段，非法条目**整批拒绝**并指出下标与原因 |
| GET | `/runs/<runId>/summary` | §4 聚合结果 |
| GET | `/runs/<runId>/export` | 导出 markdown（`text/markdown`）：run 头 + 节点表 + 事件时间线 + 指标小节 |
| DELETE | `/runs/<runId>` | 删除整个 run 目录（软删不做，日志本就是证据） |

错误：`400` 参数/校验失败（附 `field`、`reason`），`404` 不存在，`403` 跨站。

## 6 客户端

底部抽屉（总案 §7）：收起 40px 一行摘要，展开 200px 三栏。

- 收起条：`run 名 · 状态点 · 四段 token 合计 · 结论 pill`；无 run 时显示「还没有运行记录」。
- 展开：`run 列表`（左，最近 20）｜`事件流`（中，时间倒序，可按节点与 kind 过滤，200 条/页）｜`事件详情`（右，原始 JSON + `ref` 链接 + 该节点聚合数字）。
- 顶部动作：`刷新`、`导出 md`（下载 `/export`）、`复制 runId`。
- 只用宿主 token 与既有 `fs-` 类；正文 12px 地板；事件类型用形状/文字而非颜色区分，颜色只作加速。
- 键盘：抽屉可用 `Ctrl/Cmd+J` 开合；事件流可 Tab 进入、↑↓ 选择、`Enter` 展开详情（与画布快捷键不冲突）。

## 7 本册不做（留给 v0.4）

- 真正的执行引擎（起子 agent 会话、产物在节点间传递、真打回重跑）——本版本只保证**日志格式、写入、读取、聚合、展示**这条链能跑通，事件由引擎接上后自然产生；测试期用 API 手工写入的事件验证。
- 跨 run 对比、趋势图、团队汇总。这些等有真实数据再说。

---

## 8 v1.1 补充裁决（独立审核后追加，优先于上文冲突处）

审核（2026-11-06）判定「驳回」，以下逐条把缺口补成可实现的规格。**与上文冲突时以本节为准。**

### 8.1 字段补齐

- **`seq`**：服务端在追加时按 run 单调分配（整数，从 1 起），写入事件行；客户端传入的 `seq` 一律忽略。`since` 支持按 `seq` 或 ISO 时间过滤。
- **`data.callId`**：`model/call` **必填**（同一次调用的重试共用同一个 `callId`）。没有 `callId` 的用量事件按逐条累加处理，且 `summarize` 统计 `usage.unkeyedCalls` 供核对。
- **`ref.url`**：可选；没有就只显示文字引用，不假装是可点击链接。
- **`ts`**：允许客户端给，服务端统一规范成 UTC `Z`；缺失或非法一律用服务端时间，不报错。
- **run 级 vs 节点级**：只有 `run/start`、`run/end` 是 run 级事件；**其余全部**（含 `reject/trigger`）必须带 `nodeId` + `attemptId`，缺失即 400。反之，run 级事件**带 `nodeId`/`attemptId` 也 400**（防止污染节点索引）。
- **`member/start`、`member/end` 的 `memberId` 必填**；`member/end.data.status` 只接受 `passed` / `failed` / `aborted` / `partial`。`partial` = 成员确实跑过、但没有可信结论（06 §13.10：宿主观察不到成员自己上报的结论，**不得**由 lead 的 verdict 反推成员 passed/failed，宁可不写也不编造）。
- **`extra`**：键**数量** ≤16，单值字符串 ≤256，总字节 ≤2048；超限丢弃不报错。
- **`artifact/write.data.path`**：相对 run 目录，禁止绝对路径、`..`、反斜杠、空段，长度 ≤512；写入方必须在事件里同时给 `bytes` 与 `sha256`（可选但推荐），没有 `sha256` 时摘要标注「未校验」。
- **`skill/load.data.ok=false`**：不计入 `loaded`，计入 `loads.failed`；`missing` = 声明集 − 成功加载集（因此失败项也会出现在 missing 里）。

### 8.2 新增两个 kind：让「完成质量」真的能算

审核确认：不补这两类事件，`quality` **永远只能是 unknown**（`pass`/`warn` 是死代码），等于用户的需求第 5 条（完成质量）没交付。

| kind | data 字段 |
|---|---|
| `acceptance/verdict` | `itemId`（run 内唯一）、`status`（`pass`/`fail`/`skip`/`na`）、`decidedBy`（`human`/`auto`）、`evidenceRef?`、`decidedAt?` |
| `test/report` | `suite`、`executed`、`passed`、`failed`、`skipped`、`reportRef?`、`failures?`（≤50 条名称） |

规则：`acceptance/verdict` 同一 `itemId` 以 `seq` 最大者为准（后判覆盖先判）；`test/report` 同一 `suite` 同样取最新。两者都绑定 `attemptId`：旧 attempt 的报告不进入当前结论。

**证据链接是硬条件**：`acceptance/verdict` 在 `status=pass` 时 `evidenceRef` 必填；`test/report` 在 `executed>0` 时 `reportRef` 必填。缺链接一律按「未检测」处理（`quality.missing` 里列出），不给绿灯——这是「质量结论必须可复核」的代价，引擎实现时必须落产物文件并写 ref。

### 8.3 聚合口径修正

- **progress 按打回失效**：`reject/trigger` 发生时，从 `fromNodeId` 上溯到 `toNodeId`（含两端在路径上的节点）的**当前 attempt 的 passed** 全部失效，计入 `invalidated`；`ratio = 有效 passed / (总阶段 − skipped)`，并强制 `≤ 1`。旧 attempt 的结论不计。
- **`progress.nodes` 必须下发（B1）**：`summary.progress` / `GET /runs` / `GET /runs/<id>` 都要带 `nodes: { <nodeId>: { attemptId, status, endSeq, invalidated } }` 与 `invalidatedNodes[]`，不能只回计数。长跑或事件窗口被截断（`since`/尾部读）时，客户端只剩这份每节点状态可用；只回计数会让已通过的节点退化成「未开始」。
- **findings**：
  - `id` 在 **run 内全局唯一**（跨节点不得复用，否则合并）；
  - `total` = 去重后的唯一 finding 数（取每条最新状态），`reportedCount` = 原始事件数，两者都要返回；
  - `bySeverity` = 唯一 finding 最新状态的 severity 分布；另给 `unresolvedBySeverity` / `verifiedBySeverity` / `dismissedBySeverity`；
  - `unresolved` = `open + accepted + fixed`（**采纳 ≠ 修复 ≠ 复验**）；`verified` 与 `dismissed` 单列。
- **审查一致性（review）**：取**最后一次有效 `review/verdict`**（`seq` 最大）判定；之前的 `reject` 不永久判死（返工后 `approve` 可以救回）。`findingCount` 与 finding 事件不一致的两种情况必须判 `unknown`：`findingCount > 0` 但该节点无任何 `review/finding` 事件；或记录到的 finding 数 > `findingCount`。
- **采纳率**：`acceptedRate = (accepted + fixed + verified) / (total − dismissed − na)`；分母为 0 → `unknown`（不是 0% 也不是 100%）。
- **规范 `check/form`**：`state=pass` 只有在 `passedChecks`、`totalChecks` 都是整数且 `total > 0`、`passed === total`、且 `executedAt` 与 `reportRef` 至少有一个时才成立；缺任一 → `unknown`。`fail`/`na`/`skipped` 原样透出。
- **`nodeDone`**：只数当前有效 `passed` 的阶段节点（不含 skipped）；`GET /runs` 与 `GET /runs/<id>` 必须同口径、同数值。

### 8.4 quality 判定（按 04 §3.9.3 落地，不许再硬编码）

必要证据五项：`acceptance`、`tests`、`checks`、`review`、`p0p1`。

- 任一项 `unknown`（缺事件、计数缺失、证据链接缺失）→ `state=unknown`，`missing` 列出缺项；**不得**给绿灯。
- 任一项 `fail` → `state=fail`。
- 五项全 `pass` 且 `progress.ratio === 1` 且 `unresolved P0 === 0`：
  - 返工轮次 0 → `state=pass`、`label=优：首轮通过`；
  - 返工 1 且 P1=0 且 `acceptedRate ≥ 0.6` → `state=pass`、`label=良：返工 1 轮后达标`；
  - 否则 → `state=warn`、`label=可：返工 <n> 轮`（**不是绿灯**）。
- `progress.ratio < 1` → 至少 `warn`，即使其它证据全过（半成品不许绿）。
- **旧失败必须复判（B4）**：三类证据指标只在当前 attempt 里聚合，于是「上一轮判 `fail`、这一轮不再提这条」会被静默洗成绿灯；更糟的是**改个说法就能洗白**——上一轮 `R1=fail`，这一轮把同一条改成 `skip`/`na`，按「取最新判定」它就不再是 fail，而 skip 只记 `notApplicable`，其余条目 pass 就给了绿灯。
  所以判据按标识（`itemId` / `suite` / `ruleSetId`）**全量回放**：`failEver`（任何 attempt 出现过 fail，顺序无关）× `passInCurrent`（当前 attempt 出现过 **pass**——这是唯一能清账的复判）× `failInCurrent`（当前 attempt 也 fail，交给正常 `fail` 路径）。
  即 `failEver && !passInCurrent && !failInCurrent` → 该指标强制 `unknown`（理由写「上一轮判未通过、本轮没有复判为通过」，并列 `staleFails[]`）。
  **skip / na / 干脆不提都不算复判**；反过来，`fail` 不会被 stale 降级成 `unknown`（§8.4「任一项 fail → fail」优先）。

### 8.5 安全（B2）—— 诚实的两层

1. **第一层（必做）**：插件路由与 `/api` **同一道门**——每个 handler 入口调宿主 `ctx.get('connection')?.requestRejection(req)`，把它返回的 401/403 原样透出；拿不到 connection 服务时 **fail-closed 503**，绝不放行。这把 DNS rebinding / 跨站 fetch / 未登录直连一并挡在门外（宿主自带的同源 + 登录 cookie 校验）。
2. **第二层（可选）**：设置 `FLOW_STUDIO_TOKEN`（≥16 字符）后，`/api/flow-studio/*` 另外要求 `Authorization: Bearer <token>`；**只有导出接口**允许 `?token=<token>`（方便一次性下载）。客户端支持从 `location.search` 的 `fs_token` 读一次存 `sessionStorage` 并在请求头里带上；没配 token 时只走第一层。
3. **信任边界要写明**：经过鉴权的写入方（引擎进程、运维用 curl）**被视为可信**——它们能直接写 run 目录，也能构造任意事件。所以「证据对账」（§13.7）防的是**模型自述**（`extra.provenance='model-claim'`），不是防运维；不带 `provenance` 的事件会被当作可信事件直接采纳（实测带一个不存在的 `evidenceRef` 也能 pass），这是已知边界，不是漏洞。要更严就把 `provenance` 列为必填并默认降级为 unknown。
4. **`GET /health` 增补字段**：`auth`（`connection` = 只走宿主登录门；`token` = 另配了 `FLOW_STUDIO_TOKEN`）、`runsDir`、`version`、`engine`（`real` / `stub`），让运维一眼看出当前档位；未鉴权时**不返回** `dir/runsDir`。
5. **错误响应不得带内部绝对路径**：500 只回通用文案 + `traceId`，详细错误写进程日志。

### 8.6 性能与鲁棒性

- `GET /runs` **不得**为每个 run 读全量事件：`run.json` 里维护 `eventCount`、`tokenTotal`、`nodeDone`、`lastSeq` 等计数器（追加时原子更新）；列表只读 `run.json`。
- 坏 run 目录（`run.json` 不可读 / 是目录 / 权限拒绝）**不得**让整个列表 500：跳过并在响应里返回 `skipped: [{id, reason}]`。
- `GET /runs/<id>/events` 支持 `order=desc` 从尾部读；summary 允许全量但必须声明 `eventCount` 与 `truncated`。
- 超过单条 8KB / 单批 200 / 总量 200000 的上限一律 400，并给出当前用量。
- 请求体超限返回**可读的 413**，不允许直接断连（`ECONNRESET`）。
