# 在会话里启动 / 查看 / 取消实例

不打开页面也能工作：会话里用实例域模型工具读定义、启动实例、看事件、完成人工待办、取消实例、清理 worktree。工具直接调用与 HTTP 相同的 runtime 处理器，字段与业务码一致。

## 一次典型闭环

1. **找定义**：`flow_definition_list` 列出定义与最新版本；需要看 XML 时用 `flow_definition_get`。
2. **启动实例**：`flow_instance_run` 传 `definitionId`（可选 `version`、`variables`、`workspace`、`worktree`）。实例启动后返回 `id` 与 `status`。
3. **看进展**：`flow_instance_get` 看状态 / 待办 / `lastError`；`flow_instance_events` 按 `since=seq` 增量拉事件。
4. **人工环节**：`flow_instance_get` 返回 `pendingTasks[]`；用 `flow_instance_complete_task` 提交 `activityId` + `payload` 后实例继续流转。
5. **收尾 / 干预**：`flow_instance_cancel` 中止实例；`flow_instance_worktrees` 查看 / 清理 worktree；收件箱用 `flow_instance_send_message` / `flow_instance_reply`。

## 工具一览

| 工具 | 作用 |
|---|---|
| `flow_definition_list` | 列定义（含版本摘要） |
| `flow_definition_get` | 读定义元数据与指定版本 XML |
| `flow_instance_run` | 启动实例 |
| `flow_instance_list` | 列实例（可按定义 / 状态过滤） |
| `flow_instance_get` | 实例详情（状态、待办、`lastError`、最近输出） |
| `flow_instance_events` | 增量事件（`since` 游标） |
| `flow_instance_cancel` | 取消 `ACTIVE` 实例 |
| `flow_instance_complete_task` | 完成人工待办 |
| `flow_instance_worktrees` | 实例 worktree 的 list / inspect / remove / branch / prune |
| `flow_instance_send_message` | 往实例收件箱发消息 |
| `flow_instance_reply` | 回复「把消息发进实例的来源」 |

参数与返回字段的完整契约见 [实例域接口 · 模型工具](../reference/instance-api.md#模型工具)。

agent 节点会话里另有一个 `flow_finish_node`：由当前 adapter 提供，节点必须调用它提交结论与证据才能完结。它不是全局注册的 11 个工具之一。

## 工作区与 worktree

- 启动实例时可以显式给 `workspace`（绝对路径）；配置了 `FLOW_STUDIO_WORKSPACE_ROOTS` 时必须落在允许的根内（realpath 比较）。
- `worktree` 策略决定是否为本次实例创建独立 git worktree；创建失败会如实记录原因，不假装已隔离。
- 实例收尾**不自动删 worktree**；删除走 `DELETE /instances/<id>/worktree` 或 `flow_instance_worktrees` 的 remove / prune。路径与孤儿判定见 [数据模型 · Worktree](../reference/data-model.md#worktree)。

## 失败与恢复

- 实例执行失败不改 `status`，错误写 `lastError`（含 `code` / `message` / 节点与活动定位）。
- `ACTIVE` 但进程已重启的实例在读取详情 / 待办时懒恢复（可能写 `state.json` 与事件）；`/events`、`/metrics`、`/evidence` 等纯读接口不创建 runner。
- 实例进入终态后不可逆；取消 / 完成后不能补写事件或修改元数据。

## 相关契约

- 路由、字段与错误码：[实例域接口](../reference/instance-api.md)
- 事件信封与 kind：[design/10](../design/10-bpmn-instance-api.md)
- 收件箱投递语义：[收件箱与节点会话](inbox-and-sessions.md)
