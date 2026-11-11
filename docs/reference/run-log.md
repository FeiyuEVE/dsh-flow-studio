# 事件契约入口与速查

> **历史资料（0.14.0 起）**：本文只解释旧 run 事件，不再描述当前实例事件；当前实例事件契约以 [design/10](../design/10-bpmn-instance-api.md) 为准。

> **契约正文只有一个家**：[`docs/design/05-run-log.md`](../design/05-run-log.md)。本页只回答三件事：契约在哪、怎么用、字段长什么样。字段定义、校验规则、聚合公式与历次补充裁决一律以 05 为准，本页不复制。

## 契约在哪

| 你要找 | 位置 |
|---|---|
| 落盘布局（run 目录、JSONL、artifacts） | [design/05 §1](../design/05-run-log.md)（目录摘要另见 [数据模型](data-model.md#run-落盘布局)） |
| 事件信封字段、kind 与 `data` 字段、校验规则 | [design/05 §2](../design/05-run-log.md) 与 §8.1 / §8.2 |
| token 四桶与替换语义 | [design/05 §3](../design/05-run-log.md) |
| `summary` 聚合口径 | [design/05 §4](../design/05-run-log.md)、[design/04](../design/04-metrics.md) |
| 收件箱、`node/status`、`node/tools`、`machine/transition` 等扩展事件 | [design/05 §8.2](../design/05-run-log.md)、[design/07 §11](../design/07-runtime-0.7.md)、[design/08 §7](../design/08-state-machine.md) |
| 代码侧的 kind 白名单 | `src/runlog.js` 的 `EVENT_KINDS` / `INBOX_EVENT_KINDS` / `NODE_STATUS_EVENT_KINDS` / `NODE_TOOLS_EVENT_KINDS` / `MACHINE_EVENT_KINDS` |

## 怎么用

**写入**有三条路：

1. **引擎自动写**（正常路径）：节点开始 / 结束、成员、模型调用、工具调用、skill 加载、产物、打回、审查、规范检查、验收与测试报告。
2. **客户端或外部追加**：`POST /api/flow-studio/runs/<runId>/events`，单条或数组（≤200 条/批），逐条校验 kind 与必填字段，非法条目**整批拒绝**并指出下标与原因；只收观测类事件。
3. **运维用 curl**：经过鉴权的写入方被视为可信（能直接写 run 目录，也能构造任意事件）。「证据对账」防的是模型自述（`extra.provenance='model-claim'`），不是防运维——这是已知边界，见 [design/05 §8.5](../design/05-run-log.md)。

**读取**：

- `GET /runs/<runId>/events`：按 `nodeId` / `attemptId` / `kind` / `since` / `order=desc` / `limit` 过滤；返回 `{events, total, truncated}`。
- `GET /runs/<runId>/summary`：确定性聚合（token / skill 覆盖率 / findings / 打回 / 进度）。0.13.12 起不再返回质量总评分（`quality` 字段已删除）。
- `GET /runs/<runId>/export`：导出 markdown。
- `GET /runs/<runId>?light=1`：轻量投影，**不读取也不解析事件**，运行中 2s 轮询用它。

写入端的实际约束（单条 8KB / 单批 200 / 单 run 200000）与错误码见 [Host 接口](host-api.md)。

## 字段速查

### 信封

每行一个 JSON 对象：

| 字段 | 必填 | 说明 |
|---|---|---|
| `v` | ✓ | 恒为 `1` |
| `ts` | ✓ | ISO-8601；服务端统一规范成 UTC `Z`，非法以服务端时间为准 |
| `kind` | ✓ | 见下方分组 |
| `runId` | ✓ | run 标识 |
| `seq` | ✓（服务端分配） | run 内单调递增，从 1 起；客户端传入的忽略 |
| `nodeId` | 节点事件必填 | 对应流程节点 |
| `attemptId` | 节点事件必填 | 正整数；打回重跑 = 新 attempt |
| `memberId` | 可选 | 主管下子 agent 身份；单 agent 为 `null` |
| `traceId` | ✓ | 一次因果链共用 |
| `data` | 按 kind | 该 kind 的负载 |
| `ref` | 可选 | `{ sessionId, logLine }` 指回 DSH 会话日志，不重复存正文 |
| `extra` | 可选 | 未识别字段兜底；键 ≤16、单串 ≤256、总字节 ≤2048 |

run 级只有 `run/start`、`run/end`；其余事件必须带 `nodeId + attemptId`（缺失 400），run 级事件带了也 400。

### kind 分组

| 组 | kind | 干什么 |
|---|---|---|
| run | `run/start`、`run/end` | 一轮运行的开始与收尾（`done` / `aborted` / `failed`） |
| 节点 | `node/start`、`node/end`、`node/status`（扩展）、`node/tools`（扩展） | 节点 attempt 的开始、结束、主管会话的结构化自审回报、节点会话可用工具快照 |
| 成员 | `member/start`、`member/end` | team 模式子 agent 的生命周期 |
| 模型 / 工具 | `model/call`、`tool/call`、`skill/load` | 用量、工具调用、skill 实际加载 |
| 内容 | `agent/message` | agent 发言（截断 + 脱敏后 ≤2000 字符） |
| 产物 | `artifact/write` | 写产物（path / bytes / sha256 / `extra.producer`） |
| 打回 | `reject/trigger` | 哪条边、从哪到哪、为什么 |
| 审查 | `review/finding`、`review/verdict` | 缺陷与审查结论 |
| 单项证据 | `acceptance/verdict`、`test/report`、`check/form` | 验收条目、测试报告、规范检查（只作单项事实，不再汇总成质量总评分） |
| 收件箱（扩展） | `message/in`、`message/out` | 外部消息进入 / 回复出去 |
| 状态机（扩展） | `machine/transition` | 转移观测，只给人看、不参与决策 |

**17 种基础事件**冻结在 [design/05 §2](../design/05-run-log.md)；`message/*`、`node/status`、`node/tools`、`machine/transition` 是扩展白名单，单独导出、不污染基础契约。

`node/tools` 回答「这个节点会话的注册表里有哪些工具」，**不是**「上一轮实际准入的工具」；字段与校验（`tools` 去重排序 ≤64、`toolsSource ∈ {session, unavailable}`、`count === tools.length`、可选 `truncated`）的临时契约住 `docs/plan/0.10-方案.md` §4.2（design/05 冻结期无法回写，解冻后迁回）。未知 kind 一律拒绝写入，不静默存。

### 用量四桶

`model/call.data.usage` 只认四个**互斥**桶：`input` / `cacheRead` / `cacheWrite` / `output`；`reasoning` 可选且是 `output` 的子集，不另计。`total = input + cacheRead + cacheWrite + output`。同一 `traceId + data.callId` 的重试按**替换**处理（`callId` 必填）；所以节点级重试必须换 `callId`（`executor:<nodeId>:<attempt>:<retryIndex>`，见 [design/06 §17.5](../design/06-execution-engine.md)），否则两次真实调用只留最后一次。run 级「有没有漏记」看 `run.json.tokenCoverage`，语义见 [design/05 §3](../design/05-run-log.md)。

## 0.11 可信扩展（版本限定）

[design/05](../design/05-run-log.md) 冻结期间，0.11「可信」六条的事件级扩展先记在这里；解冻后按迁移纪律迁回 05。

- **外部来源**：`POST /runs/<runId>/events` 追加的每条事件都由服务端强制写 `extra.source='external'`、`extra.producer='external'`、`extra.authority='unverified'`，并剥离来客自带的 `source/producer/authority/verification/terminalScope/leaseEpoch/idempotencyKey/generatedReport` 等授信字段。聚合层在任何索引之前把 external 分区：外部同 path / 同 itemId / 同 ruleSetId 的 pass/fail 不覆盖内部证据、不制造冲突、不清掉宿主失败；时间线与导出仍可看到它们，但标「外部未验证」。
- **证据权威**：模型自述（`extra.provenance='model-claim'`）仍保留计数；当报告是引擎自己刚生成的兜底（`extra.generatedReport=true`）时计入 `claimed`，**能对上产物归属**就按自证 / 独立复核正常计数（结论层按 `selfOnly` 兜底 `warn`），一条归属都对不上才判 `unknown`。只有宿主执行链路写出的事件（`extra.producer='host'`，例如节点 `check` 的 `check/form`）计 `authoritative`。
- **summary 缓存**：缓存键包含宿主证据指纹（登记记录 + 报告副本摘要）；删除 / 损坏报告副本后事件 seq 不变，但缓存会失效并重算为 unknown。
- **单项证据字段（0.13.12 起）**：三项证据指标仍各带 `claimedPassed / authoritativePassed / authoritativeTotal / coverageRatio / independentPassed`，供旧域展示与复算；`summary.quality` 汇总与 §8.4 总评分门禁已删除，业务证据改看实例域 [证据接口](instance-api.md#证据)。design/05 的 §8.4 是 0.11 期历史契约，旧运行域 0.14.0 退役前一并删除。
- **宿主检查**：节点 `check.command` 由宿主在节点收口后真实执行，结果写成 `check/form`（`ruleSetId='host:<nodeId>'`、`executor='host'`、`state ∈ pass/fail/skipped`）与 `producer=host` 的执行记录 / 报告副本产物；agent 的 verdict 与 next/reject 不受影响，宿主结果只进单项证据。开关 `FLOW_STUDIO_ALLOW_HOST_CHECKS=1`。
- **宿主执行登记（防伪）**：每次真实执行由引擎持一次性凭证写入 `verification/<executionId>/record.json`（runId / nodeId / attempt / commandDigest / exitCode / reportSha256）。事件侧的可信元数据写成扁平键 `extra.verificationId / verificationKind / reportSha256`（`extra` 有界化只保留标量，嵌套对象会被丢弃）。聚合层只有在传入 `verifyHostExecution` 且记录对得上时才承认 `producer=host`：验证器（summary、export、runtime 自审共用同一实现）会重读持久化报告副本字节核对 `reportSha256`；**没有验证器时 producer=host 一律按 claimed**，伪造 / 跨节点 / 旧 attempt 引用均不授信。

## 改契约的纪律

事件格式一改全链路跟着改：先改 [design/05](../design/05-run-log.md)（新增 kind 追加在 §8 补充裁决并说明为何不污染 17 种基础事件），再改 `src/runlog.js` 白名单与校验、聚合、客户端，最后补测试并跑 [容器测试台](../cookbook/run-container-testbed.md)。不要在 reference 或 README 里另写一份字段表。
