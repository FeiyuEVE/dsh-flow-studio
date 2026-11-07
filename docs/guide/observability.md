# 可观测性：指标、日志抽屉、导出

运行中的流程在三个地方被观察：画布上的状态、底部的运行日志抽屉、以及 run 收尾后的导出与质量结论。三者读的是同一份事件流，口径由契约固定，不靠 UI 猜。

## 指标口径

指标按事件确定性聚合（`GET /runs/<runId>/summary`），口径正文在 [design/05 §4](../design/05-run-log.md) 与 [design/04](../design/04-metrics.md)：

- **token 四桶**：`input` / `cacheRead` / `cacheWrite` / `output` 互斥；`reasoning` 是 `output` 的子集，不另计。合计 `total = input + cacheRead + cacheWrite + output`。同一 `traceId + callId` 的重试用量按**替换**处理，不是累加。
- **skill 覆盖率**：`node/start.data.skills` 是声明集，`skill/load` 是实际加载集；`coverage = |声明 ∩ 已加载| / |声明|`（唯一 skill 名去重）。加载次数（成功 / 失败）单列，不与覆盖率混用。
- **findings**：按 `severity` 计数，并分「未解决（`open + accepted + fixed`）」与「已复验（`verified`）」；**采纳 ≠ 修复 ≠ 复验**。
- **打回**：按边与目标节点两个维度各出一份计数；轮次不靠多条线表示，靠节点角标 `↺n` + 线上刻度。
- **阶段进度**：`passed` 阶段数 /（总阶段数 − `skipped`）；打回发生时，从源节点上溯到目标节点的当前 attempt 的 `passed` **全部失效**，「返工后旧通过」不算数。
- **质量结论**：验收条目、测试报告、规范检查、审查结论、P0/P1 五类必要证据**齐全且可复核**才给结论；缺任一 → `unknown`（未检测），不给绿灯。任意一类证据（验收 / 测试 / 规范）**全部是自证**时，结论降为 `warn`「缺独立复核」——真实运行里要拿到 `pass`，每一类证据至少得有一条独立来源（跨节点引用上游产物算 `peer`，宿主产出算 `producer=host`）。
- **P1/P2 压住绿灯**：只剩未解决的 P1 / P2 时结论是 `warn` 并写清条数，只有 P0 才是 `fail`。
- **返工账本不缩水**：上一轮报过 10 条验收、这一轮只报 1 条不算「1/1 全过」；上一轮出现过、本轮没有复判为通过的标识一律计入未复判，指标降 `unknown`（测试套件、规则集同样）。改报「跳过」也洗不白。
- **模型自述的证据不接受**：`provenance=model-claim` 必须对得上 `artifact/write` 的 path + sha256 且文件真实存在，对不上就降级成「未检测」。

- **权威 vs 自报**：模型自报的通过率仍展示，但主结论只认权威来源。引擎自己生成的兜底报告（`extra.generatedReport`）只算 `claimed`；宿主检查（节点 `check`）写出的事件算 `authoritative`。summary 的 `claimedPassed / authoritativePassed / authorityCoverage` 就是两列数字，抽屉顶部并列显示，缺字段显示 unknown。
- **外部未验证**：外部通道追加的观测事件在时间线与导出里带「外部未验证」，不计入权威通过数、冲突索引与质量结论。
- **宿主检查**：节点运行详情能看到 `check/form`（`executor=host`）与 `producer=host` 的执行记录 / 报告副本；agent 报 pass 而宿主检查失败时，节点仍 passed，但质量结论为 fail。

`summary` 还会带 `computedAt` 与 `eventCount`，用来判断数据是否过期；长跑或事件窗口被截断时，客户端靠 `progress.nodes`（每节点 `attemptId / status / endSeq / invalidated`）而不是计数恢复画面。

## 运行日志抽屉

底部抽屉收起 40px，是一行主摘要：状态点、验收条目通过率、结论 pill；默认展开 340px，可拖动上边缘拉伸（200px 到容器高度−180px），双击拖拽条恢复默认；也支持键盘（↑↓ 24px / PgUp PgDn 96px / Home 最小 / End 最大 / Esc 默认），看 run 列表、事件流、事件详情与 token 四段合计。340 / 200 是真实浏览器量测后的值（240 时事件列表会被压成 0 高），证据见 [开发记录 §1](../plan/0.10-开发记录.md)。
- **节点会话与 preset**：节点运行详情的 facts 行可「打开节点会话」（宿主不支持跳转时降级复制 id，运行期失败也会降级）；同处显示 `preset：x（来源：y）`，run 列表行显示 run 级 preset。run 级发起会话（`supervision.wakerSessionId`）也在抽屉顶部有同样的打开 / 复制入口。
- **可用工具清单**：节点详情「节点会话可用工具（N 个）」只读 `node/tools` 事件，与「最近工具调用」是两件事；外部执行器会明确写「没有节点会话」，不冒充「宿主未提供工具枚举」。
- **失败后修复重启**：failed / aborted 的 run 在动作条出现「修复后重启」；先保存当前流程（保存失败就中止重启），成功后再 `POST /runs/<id>/restart`，切到新 run 并显示「续跑自 …」。同一旧 run 已有续跑 run 时服务端会 400，避免重复复制会话。

- **三档高度**：默认 / 拉高 / 全屏，`Esc` 逐档还原；区域可独立展开。
- **运行详情能放大、能看清 agent 在干什么**：节点运行详情面板给出角色 / 模式、attempt、**最近几条 agent 发言**、最近工具调用、token 用量、成员活动、已写产物与失败原因，运行中随轮询实时刷新。
- **长文本**：agent 消息、错误、失败原因可展开全文或弹层看完整内容（`Esc` 关闭、可复制）。节点「节点状态」区块只读展示标题 / 状态 / 进度 / verdict / members / blockers，坏数据降级占位，超过 6 个节点内部滚动。
- **节奏**：1Hz 节流刷新，数字用 `tabular-nums` 避免横向抖动；`prefers-reduced-motion` 关掉全部流动动画。运行中抽屉自动展开，结束后停留 2 秒展示结论。
- **轻量轮询**：客户端运行中用 `GET /runs/<runId>?light=1`（run 元信息 + `live` + `nodeStatus` + 工作区 / worktree 摘要），**不读取也不解析事件**；打开抽屉或需要历史时才走完整详情。

## 导出

`GET /runs/<runId>/export` 导出 markdown（`text/markdown`）：run 头 + 节点表 + 事件时间线 + 指标小节。收起条上的「导出 md」直接下载；导出接口是唯一允许 `?token=` 的地方（方便一次性下载），其余接口只认 `Authorization: Bearer`。

## 节点闹钟与 run 级 supervision

两个调度器都在 `createRuntime()` 里创建，但各自一个 `setInterval`、各自一份状态，**不是同一个 tick**。

| | run 级 supervision | 节点闹钟 |
|---|---|---|
| 叫醒谁 | 发起这个 run 的会话（`wakerSessionId`） | 单个节点主管会话（`sessionId`） |
| 问什么 | 「整个 run 是否正常运转」，要求调 `flow_watch` | 「你这个节点现在什么状态」，要求结构化回报 |
| 回报落在哪 | `run.json.supervision` | `node/status` 事件 + `run.json.nodeStatus` + `live.nodeStatus` |
| 节奏 | healthy 180s / 异常 60s / pending 30s / 终态停 | 默认 600s 一次（每 15s 扫到点，`FLOW_STUDIO_NODE_ALARM_MS` 可覆盖） |
| 什么时候停 | run 收尾 / 连续 3 次唤醒失败 | attempt 结束就注销；run 收尾再 `unregisterRun` |
| 连续 3 次失败 | 关闭调度并写 `wake-failed` | 停摆（`enabled:false`），条目仍可查 |

节点闹钟的自审回报要求 json 代码块里的 `state / progress / summary / members / blockers / verdict`；`state=done` 只是「提前完成信号」，会与 `whenIdle` 竞速（采用时 `node/end.extra.completedBy='self-check'`），**不能**替代结构化 verdict 的合法性检查。外部 executor 节点没有会话，不挂闹钟。

**重启恢复**（0.8.2 起）：runtime 初始化时扫「本进程有 Engine 实例的 running run」，按 `run.json.nodeStatus`（非终态节点）+ `sessions.json` 的 sessionId 重新登记，首轮 `now + 10min` 排期（重启瞬间不刷一轮）；缺 sessionId 的节点跳过并计数，重复初始化幂等。两个调度器自己的状态仍是内存态：run 级 `supervision` 与节点 `nodeStatus` 落在 `run.json` 里，调度器计数不落盘。

## 相关契约

- 事件字段、kind、聚合公式：[design/05](../design/05-run-log.md)（唯一真相源）；速查见 [运行日志](../reference/run-log.md)
- 指标定义与判定表：[design/04](../design/04-metrics.md)
- 节点闹钟契约：[design/07 §11](../design/07-runtime-0.7.md)、[design/06 §19](../design/06-execution-engine.md)
- 抽屉与指标布局数值：[design/01 §3.8](../design/01-ia-interaction.md)、[design/04 §2](../design/04-metrics.md)
