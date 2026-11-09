# 2026-11-09：冷恢复没挂 preset 组合，一个会话掉了 31 个工具

> 事故记录。时间线与工具数取自事故会话的 `session.v4.jsonl.zstd`（`~/.dsh/sessions/…/session-61dbcd8b…/`），宿主契约取自 `deepseek-harness` 源码；推断处已标注。

## 摘要

supervision 到点唤醒一个**冷**会话时，本插件调 `agents.resume({ resumeSessionId })` 没带 `setup`。宿主只在 `setup` 回调里挂 agent preset 组合，于是恢复出来的 agent 只剩宿主层插件工具：`bash` / `read` / `write` / `edit` / `subagent` 等 31 个预设工具被 `tool-registry` 当成「已移除」宣布给模型，模型此后每轮调 `bash` 都是 `Error: unknown tool "bash"`。

`37 + 31 = 68`：不是工具被删，是**恢复出来的 agent 从来没挂上预设组合**，注册表只是照着新工具面把差额宣布成移除。

## 影响面

- 会话 `session-61dbcd8b…`（`~/文档/auto-my` 的主工作会话，828 轮）从 13:53 起瘫痪，之后的 4 轮唤醒全部继承这个 37 工具的活 agent——活 agent 不会自己变好，`agents.get()` 命中就直接复用，不校验工具面。直到它被 dispose，下一次冷恢复才会重新组合。
- 该会话 38 次冷恢复里只有这 1 次失败：同类冷唤醒由 `dsh-proactive` 做时是好的，差在调用形状而不是环境。
- 抽查 72 小时内 279 个会话日志，另有 4 个 flow 节点会话历史命中同一形态（例如 `5a5c18a6…`：11-06 21:48 创建时 62 工具含 `bash`，21:50 一次 `resume` 后掉到 33 个）。
- 同批交叉审计在 `dsh-notify-owner` 的 `deliverToSession()`（`dispatch_to_session` 冷恢复）找到同一处缺陷，已单独修。

## 现象

| 时间（+08） | 日志 | 事实 |
|---|---|---|
| 13:49:43 | `seq=54643 session/end-seed` → `seq=54650 request/header` | 冷恢复 #1，`dsh-proactive` 闹钟唤醒；`reason=resume`，**68 个工具，含 bash** |
| 13:53:26 | `seq=54685 session/end-seed` | 再次冷恢复 |
| 13:53:28 | `seq=54686 agent/inbox/spliced`，`source.kind='flow-studio'`，正文 `【工作流自动复查】runId=r-mw8udy25-45v1` | 本次冷恢复由本插件的 supervision 唤醒触发 |
| 13:53:28 | `seq=54692 request/header` | `reason=resume`，**37 个工具，无 bash** |
| 13:53:28 | `seq=54693 developer/message`（`source.kind='tool-registry'`） | 一次推 31 条 `tool-removal`，与预设工具面逐一对应 |
| 13:53:37 | `seq=54697 tool/result` | `Error: unknown tool "bash"` |

## 根因链

1. **组合只在 `setup` 里挂**：`dsh-agent-loop` 的 `initializeAgent` 调 `setup?.(agent.ctx, agent)`，引擎**不读** `session.header.agentPreset` 补挂。
2. **`meta.agentPreset` / `header.agentPreset` 只写持久化**，供鉴权与投影用；写它 ≠ 挂组合。
3. **不传 `setup` 不报错**：宿主照常恢复会话与日志，只是工具面掉成宿主层插件那一份——所以这是一次静默降级。
4. **三处宿主侧冷路径都漏了**：`runtime.js` 的 `wakeRun()`（supervision 唤醒发起会话，本次事故点）、节点自检闹钟、`inbox.js` 的 `deliverToAgentSession()`（`flow_send_message`、`POST /runs/<id>/messages`、reply 的 session 目标）。本插件此前只在 `engine.js` 的节点主管会话 resume 里传了组合（v0.9.2 P0 修正），宿主侧这三处一直没跟上。
5. **`tool-registry` 把差额宣布成移除**，模型看到的是「这些工具被拿走了」，而不是「这次恢复没挂组合」——错误信号指向了错误的方向。

## 修复（0.12.1）

新增 `src/resume.js`，三处冷路径统一走 `resumeCold(ctx, agents, sessionId, { agentOptions, log })`：

- **`setup` 内部**求该会话自己的有效 preset：日志最后一条 `agent-preset/selected` > `header.agentPreset` > 宿主默认（header 只记创建时的 stamp，中途换过 preset 后不再更新，所以事件优先）。
- `sessionController.composeAgent(presetId)` → 调它返回的 `setup`（与 Web 同一条路径）；没有 `sessionController` 则退回 `agentPresets.resolve(id)` + `mount(agentCtx, resolvedId)`。
- **降级不致命**：记录的 preset 已不存在 / 挂载抛错 → warn 后改挂宿主默认；再失败 → 再 warn 并让本次 resume 照常完成。挂组合失败不能把唤醒或投递整条打死。
- 宿主两个服务都没有 → 只 warn（点名会话与后果），不抛错。

## 为什么不早发现

- **没有「恢复后工具面」的判据**：测试只验证了「resume 被调用」「消息投递成功」，没有一条断言恢复出来的工具面完整。
- **活 agent 掩盖了问题**：第一次失败的 agent 一直活着，后续唤醒直接复用它，看起来「消息都送到了」。
- **同类调用分散在三个模块**，各写一份 `agents.resume({ resumeSessionId })`，没有一个共同入口来保证形状一致。

离线复算（现成的判据）：对每个 `session/end-seed` 取它前一条 `request/header` 的工具集当基线，要求后第一条 `request/header` 仍包含「基线 ∩ 预设工具白名单」且 `bash` 在位；丢掉的其他工具（`mcp__*`、插件启停、跨版本）只记 WARN。该判据在事故会话上只命中 13:53:26 那一次，13:49:43 判 PASS。

## 遗留

- 宿主自带的 ACP / headless / SDK 三条 resume 路径都有 `setup` 但**不挂 preset**（`packages/acp`、`packages/bundle/headless`、`packages/sdk/server`）。跨 profile 共用 `~/.dsh/sessions` 时，同一会话在这三条通道续跑会换一套工具面。属于宿主行为，本插件不越权修。
- 「有 `setup`」不等于「挂了组合」：以后任何新的 resume 调用点都要按 `src/resume.js` 的形状写。
- 冷恢复失败只掉工具面、不报错。要更早发现，只能靠外部金丝雀（`dsh-preset-rescue` 已按这个口径落成，未部署）在 `request/header` 落盘时比对必需工具。
