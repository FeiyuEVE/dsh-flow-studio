# 可观测性：实例事件、指标与证据

实例的运行事实分三层观察：

1. **事件流**：`GET /instances/<id>/events?since=<seq>` 增量拉取，页面事件抽屉与导出都读它；事件信封、kind 与分片规则见 [design/10](../design/10-bpmn-instance-api.md)。
2. **运行指标**：`GET /instances/<id>/metrics` 与 `GET /metrics` 按事件确定性聚合；口径唯一来源是 [design/12](../design/12-instance-metrics.md)。
3. **业务证据**：`GET /instances/<id>/evidence` 解析 `flow_finish_node` 登记的 `<evidence-report>`，核对引用与 findings；口径唯一来源是 [design/13](../design/13-instance-evidence.md)。

本页只讲怎么用；公式、阈值与判定表不在本页复制。

## 事件抽屉

- 按 `seq` 升序增量拉取；页面用「已返回事件的最大 seq」作为下一次 `since`，不用 `lastSeq` 这类预留游标（预留可能超前于已落盘事件）。
- 每条事件显示 kind、时间、活动 / 执行定位与摘要；未知 kind 保留并计入 `unknown`，不猜测语义。
- 终态实例仍可读事件；纯读接口不创建 runner。

## 指标

| 接口 | 看什么 |
|---|---|
| `GET /instances/<id>/metrics` | 单实例：墙钟 / 挂起 / 人工等待、agent 调用与 token、finish reminder、connector、活动执行数 / 当前活动 / 等待任务、数据完整性 |
| `GET /metrics` | 跨实例汇总：按定义 / 版本 / 时间 / 状态过滤，`groupBy=day`，`asOf` 用于确定性复算 |

- 可选 `asOf=ISO` 让同一份事件在任意时刻复算得到同一结果；非法时间 400。
- 「未知」不是零：缺失的用量桶、无法核对的引用都按 unknown 表达，不补 0。
- 数据完整性字段告诉调用方这份指标是否覆盖了全部事件；不要拿被截断的窗口当全量。

## 业务证据

`flow_finish_node` 可以登记 `<evidence-report>` 文档；证据接口会：

- 校验报告格式（claims / findings / refs 的边界），坏报告按可读原因拒绝，不静默当成「无证据」；
- 对 refs 指向的文件核对 sha256 与字节数；文件缺失或 hash 不一致时标为不可核对（unknown），不强行判通过；
- 保留 findings 的 `status` / `severity` 与来源，不把模型自述升级成宿主验证；
- 工作区被清理后仍可读实例内保存的证据快照。

证据的判定语义、unknown 与冲突处理见 [design/13](../design/13-instance-evidence.md)；报告示例与路由见 [实例域接口 · 证据](../reference/instance-api.md#证据)。

## 页面上的对应位置

- 右侧实例区：状态、`pendingTasks`、`lastError`、最近输出、指标 / 证据 / 收件箱 / worktree 面板。
- 底部抽屉：事件流与事件详情；按 `seq` 增量刷新。
- 运行中的实例是只读视图；要看结构打开对应定义版本。

## 相关契约

- 事件与实例语义：[design/10](../design/10-bpmn-instance-api.md)
- 指标：[design/12](../design/12-instance-metrics.md) · 路由入口：[实例域接口 · 运行指标](../reference/instance-api.md#运行指标)
- 证据：[design/13](../design/13-instance-evidence.md) · 路由入口：[实例域接口 · 证据](../reference/instance-api.md#证据)
- 旧 run 事件（历史）：[design/05](../design/05-run-log.md) · [运行日志](../reference/run-log.md)
