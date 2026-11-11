# 实例能收外部消息，一个节点只有一条执行

外部 agent 或人往**实例**里发消息；消息按目标绑定到某次活动执行，或绑定到某个活动**下一次**激活。节点里的 agent 通过回复 outbox 往白名单目标回消息。消息只承载讨论 / 附件，**不完成节点、不完成人工任务**：agent 节点仍只认 `flow_finish_node`，人工任务仍只认 `complete` 路由。

## 消息怎么进实例

```http
POST /api/flow-studio/instances/<instanceId>/messages
{
  "messageId": "m-1",
  "target": { "activityId": "human1", "executionId": "human1_…" },
  "text": "…",
  "replyTargetId": "…"
}
```

- `target` 二选一：精确目标 `{activityId, executionId}`，或未来节点 `{activityId, delivery:"nextActivation"}`。
- 精确目标必须指向仍在 live 表或落盘 `pendingTasks` 里的执行；过期回 410 `MESSAGE_TARGET_EXPIRED`，不会投到同名活动的下一轮。
- `nextActivation` 只绑定后续**第一次**激活，循环重入不广播。
- `activityId` 必须存在于实例冻结的定义里，否则 404 `MESSAGE_ACTIVITY_NOT_FOUND`。
- `messageId` 是幂等键：同 id 同内容返回原记录 + `duplicate:true`；同 id 不同内容 409 `MESSAGE_ID_CONFLICT`。
- 实例终态（`COMPLETED` / `CANCELED`）拒绝新消息（409）；`SUSPENDED` 可以受理并排队，但延迟投递（`delivery.deferred:true`）。

正文 ≤4 KiB 内联；>4 KiB 完整落盘到 `instances/<id>/inbox/bodies/`，记录只留 `body` 引用；>1 MiB 整条 413，不写任何文件。

## 消息状态

| 状态 | 含义 |
|---|---|
| `queued` | 已持久化受理，等待投递 / 等待下一次激活 |
| `injected` | 已投给本进程内的活执行 |
| `resumed` | 已投给恢复出来的冷执行 |
| `delivered` | 已投给人工任务（只作讨论 / 附件） |
| `failed` | 投递失败，或执行结束 / 实例终态导致过期 |

回复 outbox 状态：`queued` / `delivered` / `failed` / `skipped`（`skipped` 只在实例取消时出现）。

投递是否 exactly-once **不由收件箱声称**：只有适配器显式返回 `deliveryUnknown:false` 才记 `exactlyOnce:true`；dsh 与 codex 都不满足。

## 回复通道

`POST /instances/<id>/messages/<messageId>/replies`：

| 字段 | 说明 |
|---|---|
| `replyId` | 幂等键；省略时按内容确定性生成 |
| `targetId` | 回复目标 id；省略时用消息的 `replyTargetId` |
| `text` | 回复正文 |
| `document` | `{path, sha256?}`：实例冻结工作区内的普通文件，≤1 MiB |

回复目标**只能来自宿主注入的白名单**：请求里出现 `url` / `sessionId` / `session` / `target` 任一字段直接 400 `MESSAGE_REPLY_TARGET_ARBITRARY`。`session` 目标只投给宿主当前 live 的会话；`http` 目标向白名单 URL POST，超时 10 秒，带 `idempotency-key`，2xx 算成功。投递失败 502，实例已取消 / 回复被跳过 409，并发投递 409 `MESSAGE_REPLY_DISPATCH_IN_FLIGHT`。

## 一个节点一条执行

实例域没有「节点会话表」这一层：每次活动激活有独立的 `executionId`；DSH adapter 为它创建 / 恢复一个顶层会话，codex adapter 为它起一个受限 CLI 执行并挂了 MCP 完成通道。消息的目标是**执行**（`activityId + executionId`），因此不会把消息投给同名活动的下一轮。

agent 节点完结只有一条路：调用 `flow_finish_node`，提交变量、文档引用与 summary。超时 / 未调用按 `NODE_FINISH_MISSING` 失败，不伪造完成。

## 相关契约

- 收件箱路由与全部错误码：[实例域接口 · 收件箱](../reference/instance-api.md#收件箱)
- 消息状态机与投递规则：[design/10 · 收件箱状态机](../design/10-bpmn-instance-api.md)
- 完结门与 finish 工具：[design/11](../design/11-node-finish-tool.md)
- 落盘文件：[数据模型](../reference/data-model.md#实例)
