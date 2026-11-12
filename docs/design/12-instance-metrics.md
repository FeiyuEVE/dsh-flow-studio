# 12 · 实例域运行指标（0.13.10）

> 本册是**实例域运行指标口径的唯一之家**：哪些数字能算、怎么算、什么时候是「未知」、汇总怎么选 cohort。
> 事件字段与实例 API 的落地位置在 `src/instance-metrics.js` / `src/agent-telemetry.js` / `src/bpmn-runtime.js`；
> 路由与查询参数归 [实例域接口 · 运行指标](../reference/instance-api.md#运行指标)。
> 旧运行域（`/runs`）的指标口径在 [04](04-metrics.md) 与 [05](05-run-log.md)，两者**不互相复用**：实例域按 `executionId` 计时，旧域按节点 attempt 计时。

## 1 目标与非目标

**目标**：回答四个确定性问题——运行了多久、调用了多少、在哪里等待、发生了什么错误。

**非目标**（本阶段明确不做）：

- 不做价格 / 费用推算：没有单价表，也没有按 token 计价的字段；
- 不做固定阈值「健康判决」：不输出绿 / 黄 / 红，也不替人工判定流程好坏；
- 不保留「流程完成百分比」：分支与循环下百分比没有唯一分母；只给已执行节点数、当前活动、等待任务；
- 不把业务变量当流程进度：只有显式标量变量可以作为业务指标展示，并必须标注「业务指标」。

## 2 身份与事件

指标只从实例事件流、实例事实、connector 记录、资源记录派生。公共事件信封（`seq` / `at` / `elementId` / `activityId`）的字段契约归 [10 · BPMN 实例 API](10-bpmn-instance-api.md#38-get-instancesidevents)；下表定义的是本阶段新增的 **agent 遥测事件 type 与指标消费方式**（这些事件没有旧域对应物）。新增遥测由适配器观测、`agent-execute` 在**任何结局**（成功 / 超时 / 取消 / 未 finish）收尾时写入：

| 事件 `type` | 关键字段 | 含义 |
|---|---|---|
| `agent/invocation` | `invocationId`、`provider`、`phase`（`start` / `reminder`）、`count?`、`attempt?` | 一次真实启动或提醒续跑轮次；初始轮 `invocationId=<executionId>:invoke-1`，第 N 次提醒续跑 `<executionId>:invoke-rN` |
| `agent/usage` | `provider`、`callId`、`trust`（`known` / `unknown`）、`usage?`、`reason?`、`invocationId?`、`source?`、`observedBuckets?`、`provisional?`、`synthetic?` | 一条模型调用观测；同一 `provider + callId` 后到的事件**替换**前一条 |
| `agent/usage-snapshot` | `provider`、`snapshotId`、`scope`（`invocation` / `session-cumulative` / `unknown`）、`usage`、`observedBuckets`、`invocationId?`、`sessionScopeId?`、`agentScope?`、`provenance` | **范围级结算**（如 Claude `result.usage`）：不是一次模型调用、不增加 `modelCalls`；去重键是 **`provider + snapshotId`**（0.14.6；`snapshotId` 只在单账本内唯一，跨 provider / 跨执行会撞名）。resume 后范围不可证明时 `scope=unknown`，指标只能标未知，不按数值猜 sum / max；unknown 的 `snapshotId` 带执行作用域 + 账本 nonce，不再每份都叫 `unknown:1` |
| `agent/reminder` | `count`、`maxFires?` | `turn.stop` 每次实际触发一次提醒（0.13.1 已有事件） |
| `http/attempt` | `invocationId`、`attempt`、`method`、`origin`、`path` | HTTP connector 真正发出请求前 |
| `http/result` | `invocationId`、`attempt?`、`status?`、`durationMs?`、`reused?` | 单次 HTTP 尝试的结果 / 复用结果 |

调用身份固定为 **`provider + callId`**：

- `provider` 小写归一（`Dsh` → `dsh`）；无法识别时按 `unknown` 处理，不猜 provider 语义。
- `callId` 由适配器分配：codex 每轮 `turn.completed` 一个，dsh 每个 `attemptId` 一个；Claude 由 `claude-usage-ledger.js` 给出稳定身份 `claude-message-v1:<sha256(session|agentScope|message.id)>`（同一 `message.id` 的并行工具块是**同一个**模型响应，重复上报替换而不相加；没有 `message.id` 时标 `synthetic`，不伪造确定调用数）。真实的新调用必须有新 `callId`；同一次调用的重复上报是替换，不是第二次调用。
- **调用与结算分开**：调用记录只描述模型响应与已观测桶；`result.usage` 这类范围级累计值走 `agent/usage-snapshot`，不塞进调用列表（否则会虚增 `modelCalls` 或制造错误归属）。同一范围、同一桶只选一个来源：有效结算快照覆盖该范围对应桶，没有结算桶时才用去重后的 assistant 观测。
- **快照必须自证范围**：`provenance.realCliVerified` 只有真实 CLI 实测才允许为 `true`；Claude 账本当前固定写 `false`（**真实 Claude CLI 未验证**，见 design/09 的证据层次），快照的作用域不因此被当作已知。
- **迟到的 session 身份要重键合并（0.14.6）**：Claude 的 `session_id` 可能晚于第一个 assistant 事件到达。账本在第一次确定 session 身份时，把此前按未绑定 session 记录的调用**重键**到确定身份；同一 `message.id` 与后到记录合并成一条（保留后到值，旧记录只补未观测桶），不会因为 init 晚到就算两次调用。
- **失败也要落用量（0.14.6）**：`start()` 在返回 handle 之前失败时，适配器把已观测调用 / 快照挂在错误载体的 `usageCalls` / `usageSnapshots` 上；`agent-execute` 从 `failure.cause` 读取同一份载体，照常写 `agent/usage` / `agent/usage-snapshot`。只有拿到 handle 的轮次才在「宣称能观测却一条都没有」时写 unknown 占位，握手前失败不伪造调用事实。
- `executionId` 是节点计时 / 人工等待 / 消息投递的主键；`attempt`（元素第几次激活）不承担计时职责。

## 3 四桶归一化

四桶固定 `{ input, cacheRead, cacheWrite, output, total }`，`total = input + cacheRead + cacheWrite + output`。**reasoning 是 output 的子集**：只记录 `0 ≤ reasoning ≤ output`，绝不另加进 `total`。

不同 provider 的语义不同，必须先归一：

| provider | 原始字段 | 处理 |
|---|---|---|
| codex / OpenAI 风格 | `input_tokens`、`cached_input_tokens`、`cache_write_input_tokens`、`output_tokens` | `input_tokens` **已包含**缓存子集：先拆出 `cacheRead` / `cacheWrite`，再从 `input` 里扣掉；`total` 仍等于原始 `input_tokens + output_tokens` |
| dsh / DeepSeek TokenUsage | `inputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens`（互斥） | 不再拆；`cacheRead` 单独成桶，不能加回 input |
| claude / Anthropic 风格 | `input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`、`output_tokens`（互斥） | 与 dsh 同口径，不拆 input；`claude-usage-ledger.js`（0.14.5）解释调用身份与结算作用域，适配器不再自己按事件计数、也不再把 `result.usage` 当第 N 次调用 |
| 已有四桶的输入 | `input` / `cacheRead` / `cacheWrite` / `output` | 视为已归一，不二次拆分 |
| acp / codex-acp 2.6.0 prompt usage | `inputTokens`、`cachedReadTokens`、`cachedWriteTokens`、`outputTokens`、`totalTokens`、`thoughtTokens` | agent 已按**本轮**差分并扣掉缓存：直接记 `scope:'invocation'`，不再对相邻 prompt 做差分；只有已验证 profile 才解释数值 |

数据矛盾（`cached > input`）时按原始 input 截断（先读后写），守住「四桶之和 === total」这条不变量；坏数值（负数、字符串、NaN）整条 usage 标 `unknown`，不把坏值当 0。

**观测掩码是权威（0.14.6）**：事件带 `observedBuckets` 时，不在掩码里的桶即使 `usage` 对象里有 `0` 也是**未观测**（输出 `null`），不能把补零当真实值；只有历史事件缺掩码时才从数值反推，并标 `usage-history-mask-missing`。`provisional:true`（assistant 的 `output` 可能只是响应开始时的占位值、还没有 `result` 结算）时，桶值可以展示，但该调用 / 范围不计「完整」，完整 total 为 `null` 并带 `usage-output-provisional`。

### 3.1 ACP prompt profile

ACP 适配器只在 agent 身份**精确匹配** `agentInfo.name === '@agentclientprotocol/codex-acp'` 且 `agentInfo.version === '2.6.0'` 时解释 prompt usage；其它版本 / 身份一律 unknown，不猜累计、不猜 invocation、不做差分。

- **不差分**：`codex-acp 2.6.0` 在每次 `session/prompt` 开始时记下 `session.totalTokenUsage`，返回时用 `latest − startTotal` 得到本轮用量；`inputTokens` 也已经扣掉缓存。因此账本把 prompt 响应当作**本次 invocation** 直接结算，再对相邻 prompt 做差分会二次扣减。
- **四桶映射**：`inputTokens → input`、`cachedReadTokens → cacheRead`、`cachedWriteTokens → cacheWrite`、`outputTokens → output`，`canonical:1`；`thoughtTokens` 只是 `output` 的子集，只有 `0 ≤ thought ≤ output` 时记为 `reasoning`，绝不加进 `total`。四桶全部上报时 `total` 取四桶之和；agent 上报的 `totalTokens` 与四桶之和矛盾 → 整轮 `usage-malformed`，不取 max、不修正。
- **缺桶 null**：字段缺失或显式 `null` 是**未观测**，对应桶为 `null` 且不出现在 `observedBuckets`；只有明确上报的 `0` 才算观测值。没有任何桶（例如只有 `totalTokens`）→ `usage-malformed`。
- **结算快照**：有效数值记一条 `agent/usage-snapshot`：`provider:'acp'`、`scope:'invocation'`、`snapshotId:'acp-prompt:' + sha256(executionId + '\0' + invocationId)`、`invocationId`、`sessionScopeId`、`agentScope:'main'`、`observedBuckets`、`provenance:{contract:'acp-codex-2.6.0-prompt-v1', realCliVerified:false}`。`realCliVerified:false` 表示真实多轮 CLI 尚未验收，不能拿单轮录制冒充；ACP 不使用 `session-cumulative` 或数值型 `unknown` 快照。
- **unknown 不是零**：profile 未验证、prompt 响应缺 `usage`、只有 `usage_update`、取消 / 断线后尾窗内没有响应 → 不为该轮造 0，只记一条 synthetic 调用：`provider:'acp'`、`callId:'acp-unknown:' + sha256(executionId + '\0' + invocationId)`、`usage:null`、`observedBuckets:[]`、`synthetic:true`、`source:'acp-prompt'`、`invocationId`、`sessionScopeId`、`agentScope:'main'`、`reason:'usage-unavailable'`。形状坏（负数、非安全整数、四桶与 total 矛盾、`thought > output`）用 `reason:'usage-malformed'`。原因只复用这两个稳定字符串。
- **同一次 invocation 只结算一次**：snapshot 与 unknown 调用二选一，重复 `end` / `sealUnknown` 只记诊断，不重复计数；取消也先等尾窗收完，再对没有响应的轮次落 unknown。
- **`usage_update.used/size` 只进诊断**，不当 token、不当基线、不参与计费；`used/size` 不是 token 桶。`capabilities().usage` 固定为 `unknown`，prompt 也不冒充一次模型调用，所以 ACP 的 `agent.modelCalls` 在没有其它已知调用时为 `null`；`agent.invocations` 仍按 `agent/invocation` 计。

## 4 指标表

| 指标 | JSON 位置 | 口径 | 未知语义 |
|---|---|---|---|
| 实例墙钟耗时 | `duration.wallMs` | `createdAt → completedAt`（终态）；`createdAt → asOf`（非终态）。含挂起时间，用 `wallIncludesSuspended:true` 明示 | 时间戳不可解析 → `null` + `invalid-timestamps` |
| 挂起耗时 | `duration.suspendedMs` | 只算显式 `instance/suspended` → `instance/resumed` 区间；终点按 `completedAt/asOf` 收口；单列，不混入执行耗时。区间内的 `error` 事件（挂起期间允许落错误事实）**不结束区间** | 只有 `SUSPENDED` 状态、没有区间 → `null` + `suspend-timeline-unavailable`；磁盘已是 `ACTIVE` 但事件流最后一条生命周期事件仍是 `instance/suspended`（缺 resume，典型来源是「恢复的元数据已提交、事件正文追加失败」）→ 恢复时刻不可知，整个时长 `null` + 同一 reason，**不能**把此后到 `asOf` 的时间继续累计成挂起；从未挂起 → `0` |
| 节点耗时 | `nodes.executions[].durationMs` | 按 `executionId`：`activity/start → activity/end`；事件带 `durationMs` 时以事件为准；循环两次 / 同节点不同 execution 各自独立 | 缺 start 或缺 end → `null` |
| 节点状态 | `nodes.{completed,errored,canceled,interrupted,running,waiting}` | `activity/end` = completed；`error` 事件 = error；终态实例里未结束的 execution = canceled / interrupted。**不把错误 / 取消 / 中断算成 completed** | 状态只有以上几种，不造 `failed` 实例状态 |
| 已执行 / 当前活动 | `nodes.executed`、`nodes.active` | 已执行 execution 数、当前 `running/waiting` 的 execution；不输出完成百分比 | 空实例 → `0` / `[]` |
| 人工等待 | `human.completedWaitMs`、`human.currentWaitMs` | 同一 execution **首次** `activity/wait` → `activity/end` / `cancel` / `asOf`；恢复重放不重置起点；无新事件时按 `asOf` 继续增长 | 没有等待 → `0`；时间戳坏 → 对应项不累加 |
| 取消 / 中断等待 | `human.canceledWaitMs`、`human.interruptedWaitMs` | 等待没有正常完成时的区间单列，不混进 completed | 同上 |
| agent 调用次数 | `agent.invocations` | `agent/invocation` 去重计数；提醒续跑计调用、不算新 BPMN attempt | 旧事件流没有调用身份 → `null` + `agent-invocation-unavailable`；真的一次 agent 都没有 → `0` |
| 模型调用数 | `agent.modelCalls` | 观测到的 `agent/usage` callId 去重数 | 有 agent 但无 usage 观测 → `null` |
| token | `agent.observedTokens` | 按 callId 去重后四桶求和；`total` 恒等于四桶之和 | 一条 known 都没有 → `null`，**不给 0** |
| usage 覆盖 | `agent.usageCoverage` | `known` = 有四桶的调用数；`unknown` = 明确未知的调用 / 轮次数 | 有 agent 无 usage → `unknown ≥ 1` + `usage-unavailable` |
| 四桶覆盖 | `agent.buckets.{seen,missing}` | 真正上报过数值的桶；缺桶是信息，不把缺桶当 0 | 无观测 → 四个桶都 missing |
| finish_reminder | `finishReminder.fires` | 每次实际触发各计一次（同一 `executionId + count` 去重，防重复落盘） | 没有提醒 → `0` |
| 未完结执行 | `finishReminder.missingExecutions` | `NODE_FINISH_MISSING` 错误事实 + execution 去重；`lastError` 只补没有 error 事件的同一 execution，不反复扫 `lastError` 累加 | 没有 → `0` |
| connector 执行成功率 | `connector.successRate` | `succeeded / (succeeded + errored + canceled)`；`inFlight`、`unknown` 单列，不进分母 | 分母为 0 → `null`（不是 0%） |
| connector attempt 成功率 | `connector.attempts.successRate` | `http/result` 里 2xx 尝试数 / 已观测结果数；attempt 总数另列 | 没有结果样本 → `null` |
| connector 单次请求延迟 | `connector.latency.request` | `http/result.durationMs` 样本的 `min/p50/p95/max` | 无样本 → `null` |
| connector 含退避总耗时 | `connector.latency.total` | 调用记录 `createdAt → completedAt` 的样本；含重试退避 | 无样本 → `null`；`totalIncludesBackoff:true` |
| 数据完整性 | `dataQuality.{skippedEvents,skippedResources,reasons}` | 坏行 / 事件缺口 / 未知 usage 等原因逐条列出；`complete` 由 `throughSeq ≥ lastSeq` 且无跳过决定 | `null` 字段一律配一条 reason，不静默 |
| 业务指标 | `business.scalars` | 只读实例 `variables` 里的显式标量（number / boolean / 短 string）；`source:"instance.variables"` | 没有标量 → `{}`；不推断完成度 |

`complete` 只表示**事件读取完整性**，不表示业务质量通过；`activity/end` 与 `process/end` 也不表示业务质量通过。

## 5 去重与不双计

1. **usage 按 `provider + callId` 替换**：同一调用重试 / 后到的更完整 usage 覆盖前值；不同 callId 才累加。
2. **范围键包含 `provider + sessionScopeId + agentScope`（+ `invocationId`）**：不同范围不互相覆盖。同一 `invocationId` 出现 main / subagent 两份快照、或同一 `sessionScopeId` 出现不同 provider 的累计快照时，覆盖关系不可证明：保留全部事实、各自成范围，并整体降级为 `partial` + `usage-scope-unknown`，不能把「最后到达」当成完整总量。
3. **快照按 `provider + snapshotId` 去重**：同 `snapshotId` 的不同 provider 是两条事实；scope=unknown 的快照用带执行作用域 / 账本 nonce 的 id，跨执行不覆盖。
4. **调用事件与 `activity/end.usage` 只取一处**：某个 execution 已有 `agent/usage` 事件时，`activity/end.usage` 一律忽略；只有该 execution 完全没有调用事件时才兜底，并在 `dataQuality.reasons` 记 `legacy-usage-fallback`。
5. **reminder 每次触发计一次**：`agent/reminder` 是事实；`agent/invocation` 的 reminder 轮次只用于 agent 调用次数，不重复算 token。
6. **NODE_FINISH_MISSING 按 execution 去重**：重复 `error` 事件、`lastError` 与事件同时存在，都只算一个 execution。

## 6 汇总

`GET /metrics` 的汇总口径：

- **cohort 按实例 `createdAt` 选择**：`from` / `to` 是闭区间，不是事件时间；`definitionId` / `definitionVersion` / `status` 也按实例事实过滤。
- **遍历全部实例**：运行时直接扫 `instances/` 目录，不用 `listInstances()` 的默认 limit 分页，避免漏计；损坏实例计入 `dataQuality.skippedInstances`。
- **分位数从样本合并**：每个实例保留延迟原始样本（有上限），汇总时把样本合并后重算 `p50/p95`，**不平均各实例的 p95**。
- **比率重算不平均**：成功率用汇总后的分子 / 分母重算；没有分母就是 `null`。
- **未知传播**：任一维度的已观测值求和，但 `null` 实例数单独记 `invocationUnknown` / `modelCallsUnknown` / `wallUnknown`；全部未知时总和为 `null`，不变成 0。

## 7 缓存与读取边界

- 缓存只缓存**事件侧归约**，指纹 = `schemaVersion + usageSchema + lastSeq + revision + 事件集合内容指纹 + usage 指纹`（另加 connector 记录指纹与 `resourceSeq`）。事件或实例事实一变，指纹变 → 自动重算；缓存可整体清空并重建，权威永远是事件与实例事实。
- 事件集合内容指纹（0.14.6）是**规范化事件全文的 sha256**：键排序后的整条事件都进来（`seq` / `type` / `at` / `activityId` / `elementId` / `from` / `to` / `status` / `error` / `usage` / `observedBuckets` / `provisional` / `scope` 等），不再只取 `(seq|type|at)`。同一 `seq` / `type` / `at` 但 `elementId`、桶值或快照 scope 被修正时 key 必须变。它专门覆盖「元数据没变、事件正文被补写 / 修正」：生命周期 / 执行事件都是先提交 `lastSeq` / `revision` 再追加正文，只按元数据做 key 会命中事件尚不完整时算出的旧值。
- usage 还有一层独立的正文指纹（`usageFingerprint`，0.14.5 起）：调用身份、桶值、观测掩码、快照 scope / provider 一起摘要，作为事件全文指纹的补充，不替代它。
- 归约自己报告 `complete:false`（缺已公布 seq、或有坏行）时**不写入缓存**：补写之后即使 key 相同也必须重算，不能返回窗口期算出的残缺值。
- 指标读侧仍按 `readInstanceEvents()` 读全部事件，用 `instance.lastSeq` 与 `throughSeq` / 坏行数判 `complete`；它不消费 `GET /events` 的连续可见游标。`GET /events` 的固定已分配水位 / 有界重试 / `eventLogGap` 口径归 [实例域接口 · events](../reference/instance-api.md#get-instancesidevents)。
- `asOf` 只参与最终投影（墙钟终点、当前等待、活跃 execution 的 `elapsedMs`），所以**没有新事件时人工等待仍会按 `asOf` 增长**，不会冻结在最后一个事件时间。
- 两个指标 GET 都是**纯读**：不调用 `_ensureRunner()`、不恢复 runner、不因看页面推进实例。
- `?asOf=` 是给离线复算 / 测试对账用的确定性入口；不传则用请求时刻。

## 8 与旧域指标的区别

| 维度 | 旧运行域（04 / 05） | 实例域（本册） |
|---|---|---|
| 计时主键 | 节点 + `attemptId` | `executionId`（同节点循环两次独立） |
| 进度 | 节点完成百分比（`progress`） | 已执行节点数 / 当前活动 / 等待任务；**没有百分比** |
| token 来源 | `model/call` 事件（宿主 `session/event` 归集） | 适配器在调用发生/结束时上报的 `agent/usage`；超时 / 取消 / 未 finish 也保留 |
| 质量结论 | 审查 findings / 质量总评分 | 不做质量判定；只报事实与完整性 |
| 成本 | 有独立估算入口 | 不做价格 / 费用推算 |
| 汇总 | runId 单 run | 按实例 `createdAt` cohort 的跨实例汇总 + `groupBy=day` |
| 事件流 | `runs/<runId>/*.jsonl` | `instances/<instanceId>/events/`（`seq` 全局单调、终态封口） |

## 9 验收对照

- 循环两次 / 同节点不同 execution：计时和次数独立 → `test/instance-metrics.test.mjs`「节点耗时按 executionId」。
- 挂起时间轴缺失（`ACTIVE` + 缺 `resumed`）、补写后重算、残缺归约不入缓存 → `test/instance-metrics.test.mjs`「MINOR-1」三组用例。
- 重复 usage 更新 / resume 重放 / 提醒续跑：替换不双计、不漏计 → `test/agent-telemetry.test.mjs` 与 `test/instance-metrics.test.mjs`。
- 缺 usage / 坏事件 / 截断：明确降完整性，不给伪零 → 同上「未知不是零」与 `dataQuality.reasons`。
- API 与离线纯函数一致、追加事件后缓存失效、GET 不启动 runner → `test/instance-metrics.test.mjs` 最后一个用例。
- 无新事件时人工等待继续增长 → `test/instance-metrics.test.mjs`「人工等待」。
- 汇总分页不漏计、分位数从样本合并 → `test/instance-metrics.test.mjs`「汇总」与运行时 `_allInstanceIds()`。
- 客户端未知 / 无样本不渲染成 0 → `test/client-metrics.test.mjs`。
