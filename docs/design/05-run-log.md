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
| `node/end` | `status`（`passed`/`rejected`/`failed`/`skipped`）、`durationMs`、`rejectTarget?`（判定打回时指定的上游目标节点 id；08 §6 事件重放靠它复现显式打回目标，没指定时不出现） | 引擎 |
| `machine/transition` | `from?`、`to`、`event`、`version?`、`attempt?`（`from`/`to`/`event` ≤64 字符，`version` ≤200，`attempt` 为 ≥1 的整数） | 引擎 |
| `member/start` | `name`、`role?`、`model?` | 引擎 |
| `member/end` | `status`（`passed`/`failed`/`aborted`/`partial`）、`durationMs` | 引擎 |
| `model/call` | `provider`、`model`、`usage`（见 §3）、`stopReason?` | 宿主事件归集 |
| `agent/message` | `role`（`assistant`）、`text`（≤2000 字符）、`truncated`、`provider?`、`model?` | 宿主 `assistant/message` 归集（§8.2） |
| `tool/call` | `name`、`argumentsDigest?`、`ok`、`durationMs?` | 宿主事件归集 |
| `skill/load` | `skill`（唯一名）、`ok` | `tool/call` 里 `name==='skill'` |
| `artifact/write` | `path`（相对 run 目录）、`bytes`、`kind`（`md`/`diff`/`json`/`log`）、`sha256?`、`placeholder?`（正文只剩「见文件 / 详见附件」这类一句话且 < 32 字节时为 `true`；只标记，不改写入行为，06 §13.9） | 引擎 |
| `reject/trigger` | `edgeId`、`fromNodeId`、`toNodeId`、`reason` | 引擎 |
| `review/finding` | `id`、`severity`（`P0`/`P1`/`P2`）、`category?`、`title`、`status`（`open`/`accepted`/`fixed`/`verified`/`dismissed`） | `structured_output` |
| `review/verdict` | `verdict`（`approve`/`reject`）、`findingCount` | `structured_output` |
| `check/form` | `ruleSetId`、`ruleSetVersion`、`executor`、`state`（`pass`/`fail`/`skipped`/`na`）、`passedChecks?`、`totalChecks?`、`reportRef?` | 规范检查器 |

`machine/transition` 属于 v1.6 扩展事件（08 §7），**不进**本节冻结的 17 种基础事件：它**纯观测**、不参与转移决策；与 `INBOX_EVENT_KINDS`、`NODE_STATUS_EVENT_KINDS` 同模式单独导出为 `MACHINE_EVENT_KINDS`、校验器取并集，为的是扩展不污染冻结契约。

## 3 用量（token）四桶

`data.usage` 只认宿主 `TokenUsage` 的四个**互斥**桶：

```json
{"input": 8123, "cacheRead": 40211, "cacheWrite": 0, "output": 642, "reasoning": 310}
```

- `input` = 未命中缓存的输入；`cacheRead` / `cacheWrite` 独立成桶，**不得**声称「无成本」。
- `reasoning` 可选，且必须 `≤ output`（它是 output 的子集，不另计）。
- 合计 `total = input + cacheRead + cacheWrite + output`（`reasoning` 不加）。
- 重放/重试：同一 `traceId + data.callId` 的用量按**替换**处理（后到的整条替换先到的），不是累加。正因为是「整条替换」，节点级重试必须换一个 `callId`（`executor:<nodeId>:<attempt>:<retryIndex>`，06 §17.5），否则第二次真实调用会把第一次的用量吞掉。

**run 级覆盖度 `run.json.tokenCoverage`（v1.3 起，0.12.3 实现）**：它回答「该记的调用有没有漏记」，不回答「一共多少」，因此**不参与** `total` 的计算，也不改写历史事件。

```json
{
  "complete": false,
  "missing": [{ "nodeId": "n-review", "attemptId": 1 }],
  "buckets": { "seen": ["input", "output"], "missing": ["cacheRead", "cacheWrite"] }
}
```

- `missing`：配了外部 executor、跑完了却一条 `model/call` 都没留下的节点 / attempt（有界 50 条，按 `(nodeId, attemptId)` 去重）。
- `buckets.seen` / `buckets.missing`：四个桶里哪些在**原始 usage** 里报过数值（0 也算「报过」）。这是信息字段，**不压** `complete`——不支持缓存的 provider 永远没有 `cacheRead` / `cacheWrite`，把它算成「账不完整」会让这些 run 永久黄灯。
- `complete`：`(missing.length === 0) && (unkeyedCalls === 0)`，**只反映结构完整性**。`unkeyedCalls` 是去重账本里没有 `callId` 的用量条数（见 §8.1）；这类用量进不了「同 key 整条替换」的账，同样算没记全。
- 写入时机：run 收口时与 `supervision` 终态在**同一次** `writeRunMeta` 写、且都在 `run/end` 之前（06 §18.5）；重写幂等。读端（`runstore.normalizeTokenCoverage`）做有界收敛并进白名单；老 run 没有这个字段时按 `{ complete: true }` 兼容，不把「没记录」误报成「有缺口」。
- 对外投影：`GET /runs` 列表行只给 `{ complete }`（省字节）；`GET /runs/<runId>` 详情给全量 `{ complete, missing, buckets }`。
- 依据：`src/engine.js` 的 `tokenCoverageFromSeen()` / `_persistRunEndMeta()`、`src/runstore.js` 的 `normalizeTokenCoverage()`、`src/index.js` 的 `tokenCoverageOf()`。

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

### 8.2 新增 kind：让「完成质量」真的能算、让 agent 发言可见

审核确认：不补 `acceptance/verdict` / `test/report`，`quality` **永远只能是 unknown**（`pass`/`warn` 是死代码），等于用户的需求第 5 条（完成质量）没交付。v1.2 再补 `agent/message`，让运行详情能显示「agent 刚刚说了什么」。

| kind | data 字段 |
|---|---|
| `acceptance/verdict` | `itemId`（run 内唯一）、`status`（`pass`/`fail`/`skip`/`na`）、`decidedBy`（`human`/`auto`）、`evidenceRef?`、`decidedAt?` |
| `test/report` | `suite`、`executed`、`passed`、`failed`、`skipped`、`reportRef?`、`failures?`（≤50 条名称） |
| `agent/message` | `role`（目前白名单只有 `assistant`）、`text`（必填非空、≤2000 字符）、`truncated`（bool）、`provider?`、`model?` |

规则：`acceptance/verdict` 同一 `itemId` 以 `seq` 最大者为准（后判覆盖先判）；`test/report` 同一 `suite` 同样取最新。两者都绑定 `attemptId`：旧 attempt 的报告不进入当前结论。

**证据产物的归属标记（v1.3）**：`artifact/write` 除 `path` / `sha256` 外，聚合层还读两处归属信息——事件级 `nodeId`（谁写的）与 `extra.producer`（`'host'` 表示宿主生成 / 标记的产物，引擎侧写入）。没有 `producer` 的 `artifact/write` 一律按模型产物处理；**不新增证据事件 kind**。`acceptance/verdict.evidenceRef` / `test/report.reportRef` / `check/form.reportRef` 指向某条 `artifact/write` 时，即可按 §8.3 判定证据独立性（self / peer / host）。

**证据链接是硬条件**：`acceptance/verdict` 在 `status=pass` 时 `evidenceRef` 必填；`test/report` 在 `executed>0` 时 `reportRef` 必填。缺链接一律按「未检测」处理（`quality.missing` 里列出），不给绿灯——这是「质量结论必须可复核」的代价，引擎实现时必须落产物文件并写 ref。

**`agent/message` 的采集与脱敏规则（引擎侧，06 §13.12）**：

- 来源：宿主 `assistant/message` 事件的 `message`。真形状是 `AssistantMessage.content: [{ type:'text', text }]`（同时兼容 `content` 为字符串、`message.text`）；**只取 `type:'text'` 块，reasoning/thinking 不算**。提不到文本就不发事件，绝不发空串。
- 截断：`text` 先按 Unicode 码点截到 **≤2000 字符**（不切断代理对），再用 UTF-8 **4 KiB** 兜底，保证序列化后仍 < 单条事件 8KB；发生截断时 `truncated=true`。
- 脱敏：文本先过 `redactArguments`（`Bearer …` / `sk-…` / `token|password|secret|api_key` 的值 / 超长串），凭据原文不落日志。`provider`/`model` 来自同一条消息的 `source`，没有就省略。
- 事件级 `memberId` 必填（lead 为 `null`，成员为 `<nodeId>:<序号>`）；同一会话连续两条文本完全相同（重放 / 心跳）只写一条，去重表按会话记 hash、上限 64 条。

### 8.3 聚合口径修正

- **progress 按打回失效**：`reject/trigger` 发生时，从 `fromNodeId` 上溯到 `toNodeId`（含两端在路径上的节点）的**当前 attempt 的 passed** 全部失效，计入 `invalidated`；`ratio = 有效 passed / (总阶段 − skipped)`，并强制 `≤ 1`。旧 attempt 的结论不计。
- **`progress.nodes` 必须下发（B1）**：`summary.progress` / `GET /runs` / `GET /runs/<id>` 都要带 `nodes: { <nodeId>: { attemptId, status, endSeq, invalidated } }` 与 `invalidatedNodes[]`，不能只回计数。长跑或事件窗口被截断（`since`/尾部读）时，客户端只剩这份每节点状态可用；只回计数会让已通过的节点退化成「未开始」。
- **findings**：
  - `id` 在 **run 内全局唯一**（跨节点不得复用，否则合并）；
  - `total` = 去重后的唯一 finding 数（取每条最新状态），`reportedCount` = 原始事件数，两者都要返回；
  - `bySeverity` = 唯一 finding 最新状态的 severity 分布；另给 `unresolvedBySeverity` / `verifiedBySeverity` / `dismissedBySeverity`；
  - `unresolved` = `open + accepted + fixed`（**采纳 ≠ 修复 ≠ 复验**）；`verified` 与 `dismissed` 单列。
  - `unresolvedBySeverity.P0` 进 §8.4 的 fail 级门禁；`.P1` / `.P2` 进 warn 级门禁（未解决即压住绿灯）。
- **证据独立性（v1.3）**：三条证据指标的**通过条目**按被引用产物的归属分级——`artifact/write.nodeId` 与声明者相同 → `self`（自证）；不同 → `peer`（独立复核）；`artifact/write.extra.producer === 'host'` → `host`（宿主生成 / 标记）。
  - 指标对象暴露 `selfCertified`（自证通过条目数）、`independentPassed`（peer / host 独立通过的条目数）与 `selfOnly`（有通过条目、且**全部**为自证）。
  - 指标层不因此降级：自证仍是证据，不是「缺证据 / 数据自相矛盾」（那是 `unknown` 的语义）；独立性不足交给 §8.4 结论层用 `warn` 兜底。
  - 查不到产物归属的 ref（可信写入方直接给的路径）不计入自证、也不计入 `independentPassed`，沿用 §8.5 的信任边界——只有能证明是同一节点写的才算自证，能证明是别的节点 / 宿主写的才算独立。
  - 引擎自写的兜底报告（`extra.generatedReport=true`）：能对上产物归属就按 `self` / `independent` 正常计数（结论层按 `selfOnly` 兜底 `warn`）；一条归属都对不上才整条判 `unknown`。
- **跨 attempt 账本（v1.3，B4 扩展）**：三个证据指标各自维护**全 attempt 出现过的标识集合**（`itemId` / `suite` / `ruleSetId`）。凡在**更早 attempt** 出现过、当前 attempt 没有**复判为 `pass`** 的标识，一律计入未复判（stale）：
  - 当前 attempt 出现 `fail` → 走正常 fail 路径，不重复记 stale；
  - 出现 `skip` / `na`，或干脆不再提 → 该指标 `unknown`，reason 写「上一轮出现过、本轮没有复判为通过」并列出条数（`staleFails[]`）；
  - 只在当前 attempt 首次出现的新标识不受影响。
  这样返工后「上一轮报 10 条、本轮只报 1 条」的分母不会缩水成 1，历史条目也不能靠不再提被洗白。
- **审查一致性（review）**：取**最后一次有效 `review/verdict`**（`seq` 最大）判定；之前的 `reject` 不永久判死（返工后 `approve` 可以救回）。`findingCount` 与 finding 事件不一致的两种情况必须判 `unknown`：`findingCount > 0` 但该节点无任何 `review/finding` 事件；或记录到的 finding 数 > `findingCount`。
- **采纳率**：`acceptedRate = (accepted + fixed + verified) / (total − dismissed − na)`；分母为 0 → `unknown`（不是 0% 也不是 100%）。
- **规范 `check/form`**：`state=pass` 只有在 `passedChecks`、`totalChecks` 都是整数且 `total > 0`、`passed === total`、且 `executedAt` 与 `reportRef` 至少有一个时才成立；缺任一 → `unknown`。`fail`/`na`/`skipped` 原样透出。
- **`nodeDone`**：只数当前有效 `passed` 的阶段节点（不含 skipped）；`GET /runs` 与 `GET /runs/<id>` 必须同口径、同数值。
- **agent 活动（`summary.activity`）**：`computeAgentActivity(events)` 按 `nodeId` 聚合最近的 `agent/message`，形状为
  `activity: { nodes: { <nodeId>: [{ text, at, memberId }] } }`；每节点最多 **5** 条、全局最多 **200** 条，
  超限时保留全局最新的事件（组内仍按时间升序）。`at` 取事件 `ts`，`memberId` 没有则 `null`。
  这是纯展示数据，**不进入 token / skill / findings / reject / progress / quality 任何口径**。

### 8.4 quality 判定（按 04 §3.9.3 落地，不许再硬编码）

必要证据五项：`acceptance`、`tests`、`checks`、`review`、`p0p1`。

- 任一项 `unknown`（缺事件、计数缺失、证据链接缺失、更早 attempt 的标识未复判）→ `state=unknown`，`missing` 列出缺项；**不得**给绿灯。
- 任一项 `fail` → `state=fail`；`fail` 压过 `unknown`。
- `p0p1` 的 fail 级门禁只认**未解决 P0**（`open + accepted + fixed`）；`p0p1` 的证据文案相应收窄为「P0 缺陷」。
- **未解决 P1 / P2 压住绿灯（v1.3）**：P1/P2 不判 fail，而是把 `evidence.p0p1` 置为 `warn`；五项全过 + `progress.ratio === 1` 时，只要有未解决 P1/P2，结论 `warn`，label 写「可：…、遗留 N 个 P1 / M 个 P2 未解决」（只列非零项）。
  依据：P1/P2 是质量问题而非「结论不成立」，但「首轮通过 + 遗留 3 个 P1」不能是「优」。
- **证据独立性门禁（v1.3，0.12.3 实现与本节对齐）**：**每个有通过条目的证据指标至少要有一条 `peer` / `host` 级独立证据**。
  - 任一指标 `selfOnly === true`（该指标通过条目全部是 `self`）→ 结论不得 `pass`，降为 `warn`，label 写「可：<指标名> 全部为自证证据（N 条），缺独立复核」；
  - 有通过条目、但**找不到产物归属**（`evidenceRef` / `reportRef` 对不上 `artifact/write`）→ 同样不得 `pass`，降为 `warn`，label 写「可：<指标名> 共 N 条通过条目找不到产物归属，缺独立复核」。这类条目既证明不了自证、也证明不了独立复核；同指标里另有 peer / host 条目也不能把这条抹掉（实现按「通过数 − 自证数 − 独立数」逐指标统计，`src/runlog.js` 的 `unattributedMetrics`）；
  - 只要每个指标都至少有 1 条 peer/host 级证据、且没有无归属的通过条目，其余自证条目可以共存，结论仍可 `pass`，自证总数在 `quality.selfCertified` 里体现（不改「优 / 良」文案）；
  - 依据：自证只能证明「模型写过这个产物」，不能证明「结论正确」，指标整体全自证就是闭环，必须 warn；但 `unknown` 的语义是「缺证据 / 数据自相矛盾」，自证是「有证据但不独立」，用 `warn` 才诚实。若改成「一条自证都不许有」，真实运行的验收通常全是模型自写，quality 会永久黄灯，指标失去意义。
- **不再有的三道旧门（0.12.3 删除）**：`claimedOnly`（三项都 `claimed>0` 且 `authoritativePassed===0` → `unknown`）、`unverifiedMix`（任何 claimed 通过 → `unknown`）、以及「权威覆盖 < 100% → `unknown`」。它们与本节 v1.3 的独立性口径冲突，且会让 `pass` / `warn` 在真实 run 上不可达（0.11.0 的 G-E 已记录该后果）。`authorityCoverage` 仍如实返回，但**只用于展示**；独立性门禁只看 `selfOnly` / 无归属，五项 `unknown`、任一项 `fail`、进度未完成、未解决 P1/P2、返工不达标仍按本节前面的规则各自压住绿灯。
- 五项全 `pass` 且 `progress.ratio === 1`、无未解决 P1/P2、无 `selfOnly`、且不存在无归属的通过条目时：
  - 返工轮次 0 → `state=pass`、`label=优：首轮通过`；
  - 返工 1 且 P1=P2=0 且 `acceptedRate ≥ 0.6` → `state=pass`、`label=良：返工 1 轮后达标`；
  - 否则 → `state=warn`、`label=可：返工 <n> 轮`（**不是绿灯**）。
- `progress.ratio < 1` → 至少 `warn`，即使其它证据全过（半成品不许绿）。
- 多条 warn 原因（进度 / 返工 / P1-P2 遗留 / 自证）同时成立时**全部写进同一个 label**，不丢原因。
- **旧条目必须复判（B4 → v1.3 跨 attempt 账本）**：三类证据指标只在当前 attempt 里聚合，于是「上一轮判过、这一轮不再提这条」会被静默洗掉；更糟的是**改个说法就能洗白**——上一轮 `R1=fail`，这一轮把同一条改成 `skip`/`na`，按「取最新判定」它就不再是 fail，而 skip 只记 `notApplicable`，其余条目 pass 就给了绿灯；同理上一轮 10 条、本轮只报 1 条时，分母缩水也会白洗。
  所以判据按标识（`itemId` / `suite` / `ruleSetId`）**全量回放**：`seenEarlier`（更早 attempt 出现过，顺序无关）× `passInCurrent`（当前 attempt 出现过 **pass**——这是唯一能清账的复判）× `failInCurrent`（当前 attempt 也 fail，交给正常 `fail` 路径）。
  即 `seenEarlier && !passInCurrent && !failInCurrent` → 该指标强制 `unknown`（理由写「上一轮出现过、本轮没有复判为通过」，并列 `staleFails[]`）。
  **skip / na / 干脆不提都不算复判**；反过来，当前 attempt 里真实的 `fail` 不会被 stale 降级成 `unknown`（「任一项 fail → fail」优先）。

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
