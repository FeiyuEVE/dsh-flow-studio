# 事件契约入口与速查

> **契约正文只有一个家**：[`docs/design/05-run-log.md`](../design/05-run-log.md)。本页只回答三件事：契约在哪、怎么用、字段长什么样。字段定义、校验规则、聚合公式与历次补充裁决一律以 05 为准，本页不复制。

## 契约在哪

| 你要找 | 位置 |
|---|---|
| 落盘布局（run 目录、JSONL、artifacts） | [design/05 §1](../design/05-run-log.md)（目录摘要另见 [数据模型](data-model.md#run-落盘布局)） |
| 事件信封字段、kind 与 `data` 字段、校验规则 | [design/05 §2](../design/05-run-log.md) 与 §8.1 / §8.2 |
| token 四桶与替换语义 | [design/05 §3](../design/05-run-log.md) |
| `summary` 聚合口径 | [design/05 §4](../design/05-run-log.md)、[design/04](../design/04-metrics.md) |
| 收件箱、`node/status`、`machine/transition` 等扩展事件 | [design/05 §8.2](../design/05-run-log.md)、[design/07 §11](../design/07-runtime-0.7.md)、[design/08 §7](../design/08-state-machine.md) |
| 代码侧的 kind 白名单 | `src/runlog.js` 的 `EVENT_KINDS` / `INBOX_EVENT_KINDS` / `NODE_STATUS_EVENT_KINDS` / `MACHINE_EVENT_KINDS` |

## 怎么用

**写入**有三条路：

1. **引擎自动写**（正常路径）：节点开始 / 结束、成员、模型调用、工具调用、skill 加载、产物、打回、审查、规范检查、验收与测试报告。
2. **客户端或外部追加**：`POST /api/flow-studio/runs/<runId>/events`，单条或数组（≤200 条/批），逐条校验 kind 与必填字段，非法条目**整批拒绝**并指出下标与原因；只收观测类事件。
3. **运维用 curl**：经过鉴权的写入方被视为可信（能直接写 run 目录，也能构造任意事件）。「证据对账」防的是模型自述（`extra.provenance='model-claim'`），不是防运维——这是已知边界，见 [design/05 §8.5](../design/05-run-log.md)。

**读取**：

- `GET /runs/<runId>/events`：按 `nodeId` / `attemptId` / `kind` / `since` / `order=desc` / `limit` 过滤；返回 `{events, total, truncated}`。
- `GET /runs/<runId>/summary`：确定性聚合（token / skill 覆盖率 / findings / 打回 / 进度 / 质量结论）。
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
| 节点 | `node/start`、`node/end`、`node/status`（扩展） | 节点 attempt 的开始、结束、主管会话的结构化自审回报 |
| 成员 | `member/start`、`member/end` | team 模式子 agent 的生命周期 |
| 模型 / 工具 | `model/call`、`tool/call`、`skill/load` | 用量、工具调用、skill 实际加载 |
| 内容 | `agent/message` | agent 发言（截断 + 脱敏后 ≤2000 字符） |
| 产物 | `artifact/write` | 写产物（path / bytes / sha256 / `extra.producer`） |
| 打回 | `reject/trigger` | 哪条边、从哪到哪、为什么 |
| 审查 | `review/finding`、`review/verdict` | 缺陷与审查结论 |
| 质量证据 | `acceptance/verdict`、`test/report`、`check/form` | 验收条目、测试报告、规范检查 |
| 收件箱（扩展） | `message/in`、`message/out` | 外部消息进入 / 回复出去 |
| 状态机（扩展） | `machine/transition` | 转移观测，只给人看、不参与决策 |

**17 种基础事件**冻结在 [design/05 §2](../design/05-run-log.md)；`message/*`、`node/status`、`machine/transition` 是扩展白名单，单独导出、不污染基础契约。未知 kind 一律拒绝写入，不静默存。

### 用量四桶

`model/call.data.usage` 只认四个**互斥**桶：`input` / `cacheRead` / `cacheWrite` / `output`；`reasoning` 可选且是 `output` 的子集，不另计。`total = input + cacheRead + cacheWrite + output`。同一 `traceId + data.callId` 的重试按**替换**处理（`callId` 必填）。

## 改契约的纪律

事件格式一改全链路跟着改：先改 [design/05](../design/05-run-log.md)（新增 kind 追加在 §8 补充裁决并说明为何不污染 17 种基础事件），再改 `src/runlog.js` 白名单与校验、聚合、客户端，最后补测试并跑 [容器测试台](../cookbook/run-container-testbed.md)。不要在 reference 或 README 里另写一份字段表。
