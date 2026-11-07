# 流程能收外部消息，一个节点只有一个会话

外部 agent 或人往流程里发消息，消息从入口节点（需求分析）往下流；节点里的 agent 也能按配置的通道回复。一个节点无论被打回重跑、还是收到新消息，**始终复用同一个会话**。

## 消息怎么进流程

HTTP 收件箱（与 `flow_send_message` 是同一条内部逻辑）：

```
POST /api/flow-studio/runs/<runId>/messages
  { "from": "某个 agent", "text": "…", "nodeId?": "n_dev", "reply": { "kind": "session", "sessionId": "…" } }
```

目标节点解析顺序：`nodeId` 显式指定（必须是阶段节点）→ run 当前节点 → run 还没开始时取入口节点。

## 四种投递情形

- **节点没启动** → 起一个顶层节点会话把消息带进去。
- **节点正在跑** → 通过 `agent.followup` 把消息注入到**同一个会话**（上下文注入），不打断当前回合。
- **节点还没轮到** → 消息入队，引擎推进到该节点时并进提示词；入口消息在后续每个阶段节点都可见（最多 5 条、单条 ≤1200 字）。
- **run 还没开始** → 这条消息就是本次运行的启动输入。

## 一个节点一个会话

`runs/<runId>/sessions.json` 记着 `nodeId → sessionId`，二次激活（打回重跑 / 收到新消息）复用同一会话：活的走 `agents.get`，冷的或被压缩过的走 `agents.resume`，不再新开会话。run 结束或停止时统一 `dispose()` 句柄，**不删日志、不删会话文件**（仍可从列表点开 / `resume`）。

节点里的 agent 用 `flow_reply` 回消息（工具按会话反查 run / node，不用手填 id）；别的 agent 用 `flow_send_message` 往流程里发消息。运行中可以 `POST /runs/<id>/inbox` 动态改回复目标，`GET /runs/<id>/messages` 看收件箱。

## 回复通道

默认只记进运行日志；要真的回出去得配置：

| `reply.kind` | 行为 |
|---|---|
| `session` | 发回指定会话（`agents.get`/`resume` + `followup`，正文带 `[flow:… · 节点名]` 来源标记） |
| `http` | `POST` 到外部给的 URL（`Bearer` 取自配置的环境变量），body `{runId,nodeId,messageId,text}` |
| `none` / 未配置 | 只写 `message/out` 事件，工具返回「没有外部回复通道」 |

对外通道的安全约束：`tokenEnv` 只认 `FLOW_STUDIO_REPLY_TOKEN_*` 形式的专用环境变量名（只写变量名，不落盘），URL 只允许 https 或回环地址上的 http，令牌在日志 / 错误里打码。`POST /runs/<id>/events` 只收观测类事件，不能拿它伪造节点执行。

## 节点会话是顶层会话

v0.7 起节点主管会话走 `ctx.agents.create`，是**顶层会话**：session header 里没有 `parentSession` / `origin`，`delegationDepth: 0`，所以 Web 侧栏能看到、能点开接管。`team` 节点的成员才是主管委派出的子会话（header 带 `parentSession` / `origin:'subagent'`）。

判断是否顶层**看 session header，不看 `roots()`**——`resume` 之后 agent 在运行时也是 root，但持久化血缘不变。run 收尾的 `dispose()` 只关句柄、不删日志，会话仍在列表（`agentAvailable:false`）、磁盘文件仍在、之后仍可 `resume`。只 `create` 不跑 turn 的 `blank` 会话 API 有、Web 侧栏看不到；节点会话一定会跑 turn，不受影响。

为什么要这样：节点会话要能被人类点开接管、被外部消息二次激活，如果挂成子 agent，会话列表里就找不到，`resume` 语义也绑在父会话生命周期上。设计与否决记录见 [design/07 §3](../design/07-runtime-0.7.md)。

## 相关契约

- 收件箱事件（`message/in` / `message/out`）的字段与有界截断：[运行日志](../reference/run-log.md)
- `POST /runs/<id>/messages`、`POST /runs/<id>/inbox`、`GET /runs/<id>/messages` 的参数：[Host 接口](../reference/host-api.md#收件箱与回复通道)
- 会话、收件箱与 worktree 的落盘文件：[数据模型](../reference/data-model.md#run-落盘布局)

## 节点会话的 agent preset 与工具面（0.9.2）

节点会话是**顶层会话**，但顶层 ≠ 自带完整工具。0.2.2 宿主对没有
`meta.agentPreset` 的程序化会话给的是几乎没工具的裸组合（`working_directory` /
`memory_recall` 之类），所以引擎现在**永远显式**传 preset：

`node.agentPreset` > 本次 start 覆盖 > 引擎配置 > 流程级默认 > `standard`。

- **只写 `meta.agentPreset` 不会挂组合**：组合在 `agents.create` / `agents.resume`
  的 `setup` 回调里装配。引擎优先走 `sessionController.composeAgent`（与 Web 同一条
  路径），其次只挂 `agentPresets.mount`；两个服务都没有时只 warn，不静默假装挂上；
- `standard` 是 web profile 里带完整工具面（bash / 文件读写 / subagent）的那套；
  当前 profile 没有 `standard` 时，引擎兜底会退回宿主默认 preset，来源记为
  `default-fallback`（显式配置的 preset 不存在则直接报 400，不降级）；
- 节点 / 流程的 preset id 只做安全字符校验，真实存在性由宿主 registry 判断
  （插件注册的 `digital-human` / `specialist` 也能用）；
- 生效值与来源写进 `node/start.data.agentPreset` / `agentPresetSource` 与
  `run.json.agentPreset`，排障时先看这里——「节点改不了代码」通常就是 preset 丢了。

新建的节点会话还有一条**预热轮**：引擎先发一句「只回 ok」的消息，正式任务从第二轮开始。这样做是为了绕开首轮精简插件——它会把新会话第一轮的工具面裁到 `bash` + `str_replace_editor`，团队主管那一轮里就没有 `subagent` 可派了。预热轮只在新建会话时出现，打回重跑不会再发。

另外，有出向 reject 边的阶段节点会额外拿到 `flow_node_reject` 工具（等价于
verdict=reject）；没有出向 reject 边的节点不会注册它。详见
[Host 接口](../reference/host-api.md#阶段节点的打回工具flow_node_reject)。
