# 常见问题

每个答案只保留最短结论与出处；细节在各自 owner 文档里。

## 实例状态为什么没有 failed / blocked？

实例只有四个状态：`ACTIVE` / `COMPLETED` / `SUSPENDED` / `CANCELED`（Camunda 8 口径）。执行错误写在 `lastError`（带 `code` / 节点 / 活动定位），人工等待写在 `pendingTasks`；把失败做成状态会让「重试后恢复」和「人工等待」都失去表达空间。

细节与事件语义：[实例域接口 · 实例状态](reference/instance-api.md#实例状态)、[design/10](design/10-bpmn-instance-api.md)。

## 定义改了，正在跑的实例会跟着变吗？

不会。实例启动时把 `definitionId + definitionVersion + definitionHash` 钉进 `instance.json`，并复制一份 `definition.bpmn` 快照。已有实例永远按启动时那一版执行；要换结构就启动新实例。

字段与布局：[数据模型 · 定义](reference/data-model.md#定义)。

## worktree 建在哪？为什么不自动删？

路径是 `$DSH_HOME/flow-studio/worktrees/<workspaceId>/<instanceId>`，分支 `flow-instance/<instanceId>`（被占用时依次 `-2`…）。实例收尾默认保留（`retain`），因为用户可能还要进去看产物；只有 `on-terminal-clean` 策略且树干净时才自动清理。删除入口是 `DELETE /instances/<id>/worktree`；孤儿清理用 `GET /instance-worktrees` 看清单，`POST /instance-worktrees/prune` 预览（`dryRun` 默认 `true`，返回 `planHash`），再带 `planHash` 执行。

路径校验、所有权记录与清理顺序：[数据模型 · Worktree](reference/data-model.md#worktree)、[实例域接口 · worktree](reference/instance-api.md#实例-worktree)。

## 旧版本升级后，磁盘上的 flows / runs 还能读吗？

不能。0.14.0 起旧运行域代码、路由与模型工具已删除；`flows/`、`runs/` 与旧 worktree 只是**历史数据**，不再被加载，也不会被自动删除。要保留旧结果请自行归档；新的定义 / 实例落在 `definitions/` 与 `instances/`。

## 为什么用 BPMN，而不是自研节点图？

BPMN 2.0 提供了可执行语义（网关、边界事件、子流程、userTask）与成熟引擎，Zeebe 扩展属性又能直接表达 agent 节点的 adapter / prompt / team / skills；把「流程语义」交给标准、把「agent 执行」交给适配器与 finish 门，比自研状态机更容易验证与替换。

## 消息能完成节点或人工任务吗？

不能。收件箱只承载讨论与附件；agent 节点必须调用 `flow_finish_node`，人工任务必须走 `complete` 路由。消息目标绑定到具体执行（`activityId + executionId`），不会误投到同名活动的下一轮。

[收件箱与节点会话](guide/inbox-and-sessions.md)。

## 怎么在会话里启动实例？

用 13 个实例域工具里的 `flow_definition_list` / `flow_instance_run` / `flow_instance_get` / `flow_instance_events` / `flow_instance_complete_task` / `flow_instance_cancel` 等；旧 `flow_start` / `flow_watch` / `flow_stop` 已删除。

[会话驱动](guide/session-driven.md)、[Host 接口 · 模型工具](reference/host-api.md#模型工具)。
