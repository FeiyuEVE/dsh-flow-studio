# 14 · ACP 适配器（0.15.0）

> 本文只写 ACP 适配器的**决策、生命周期、证据分层与边界**。配置字段的唯一之家是 [Host 接口 · ACP 适配器配置](../reference/host-api.md#acp-适配器配置)；事件 `type` 与字段的唯一之家是 [10 · ACP 适配器事件](10-bpmn-instance-api.md#51-acp-适配器事件)；用量 profile、四桶与 unknown 规则在 [12 · ACP prompt profile](12-instance-metrics.md#31-acp-prompt-profile)；错误码全集与语义在 [实例域接口 · ACP 适配器错误码](../reference/instance-api.md#acp-适配器错误码)。
>
> 实现：`src/acp-client.js`（连接）、`src/acp-policy.js`（配置 / 模式 / 权限）、`src/acp-events.js`（事件投影）、`src/acp-usage-ledger.js`（用量账本）、`src/agent-adapter-acp.js`（probe / start / 完结 / 清理）。
>
> 证据边界：当前只在 **fake ACP agent（真实 MCP SDK 通道）** 与 **18 帧真实报文重放**上验收。18 帧不含 `flow_finish_node`，`session/new` 的 `mcpServers` 为空，只证明文本轮次、usage 与 commands 摘要，**不证明 MCP 完结**；真实 `codex-acp 2.6.0` 的模型调用与 finish 仍未验证，`capabilities().evidence.realChannel` 固定写「未验证」。

## 1 七项决策

1. **连接层用官方 SDK，不自写 JSON-RPC 路由。** `openAcpClient` 把 ACP agent 当子进程协议对端，用 `@agentclientprotocol/sdk@2.6.0` 的 `ndJsonStream` / `client` 完成 NDJSON 分帧、双向请求、关闭与背压；单条消息上限 32 MiB，错误正文 ≤1000 UTF-8 字节。SDK 缺失或版本不符只拒绝 ACP，不影响其它适配器。
2. **`start(req)` 返回 handle，完成只经 `handle.exited`。** 成功 resolve `{ok:true,code:'OK',record,sessionId,reminders}`，失败 resolve `{ok:false,code,message,sessionId?,reminders}`；运行期失败不 reject，避免被执行器改写成通用的适配器错误。`start` 在返回 handle 之前失败才 reject，并在错误对象上挂 `cleanup` / `cleanupFinal` 与已观测的 `usageCalls[]` / `usageSnapshots[]`。
3. **完结不抽新的共享状态机，直接复用 finish gate / channel。** 复用 `createFinishChannel` / `verifyFinishBridge` / `FINISH_REMINDER_TEXT`、进程组 supervisor、资源 registry 与共享脱敏；ACP 自己维护串行 turn 循环。`stopReason:"end_turn"` 只表示本轮结束，**只有 gate 受理才是成功**。
4. **probe 必须证明 agent 真的拉起 finish MCP。** `initialize` / `session/new` / `session/set_mode` 只是会话协商；还要本地桥自检、agent 侧 `firstContact`（hello）与 `discovered`（tools/list）都成立，才把 `capabilities().finishTool` 标成 `native`。握手不能代替 discovery。
5. **用量只按已验证 prompt profile 直接记 invocation。** `codex-acp 2.6.0` 的 prompt 响应已经是「本轮、已扣缓存」的 usage，账本直接记 `scope:'invocation'`，不再对相邻 prompt 做差分；未验证的 agent 身份 / 版本一律 unknown，缺桶是 `null`，不补 0。
6. **默认最小权限：`mode:'workspace-write'` + `permissionPolicy:'deny'`。** 目标 mode 必须出现在 `availableModes` 且 `session/set_mode` 成功才派 prompt；`deny` 只选 `reject_once`，`allow` 只选 `allow_once`，永不选 `always`，也不按选项名称推断授权。
7. **最小事件面。** 只投影 `activity/output`、`tool/start|update|end`、`agent/permission`；其它 `session/update` 变体压成有界诊断摘要，`_auth/status_update` 与 `_meta` 完全忽略。事件不走 runner 保留类型，统一由 handler 事件通道补 `at/elementId/activityId`。

## 2 连接与会话生命周期

- **进程**：`spawn(config.command, config.args, { cwd: workspace, env: 白名单 + config.env, detached: 非 Windows })`；白名单沿用 Claude 适配器的环境键与前缀（`PATH` / `HOME` / `LANG` / 代理变量 / `LC_*` / `CLAUDE_*` / `ANTHROPIC_*` 等），再叠加管理员显式 `env`。配置不允许覆盖 `FLOW_STUDIO_FINISH_*`。
- **initialize**：请求 `protocolVersion:1`；响应必须是 `protocolVersion:1` 且带非空 `agentInfo.name` / `agentInfo.version`，否则 `ACP_PROTOCOL_ERROR`。`agentCapabilities.loadSession` 与 `sessionCapabilities.close` 只作为诊断和能力记录，不承诺宿主 resume。
- **session/new**：`cwd` 为绝对工作区路径；`mcpServers` 固定一项 `{name:'flow_finish', command:process.execPath, args:[绝对 node-finish-mcp.js], env:[{name,value}]}`，不带 `type`（stdio 是默认）。finish 凭据只出现在这里，不进 argv / 提示词 / 日志。
- **模式**：从 `session/new` 的 `modes.availableModes` 精确匹配配置里的 `mode`，再发 `session/set_mode`；缺失、拒绝或设置失败都是 `ACP_MODE_UNAVAILABLE`，**永不回退到更宽的模式**，也不派 prompt。
- **finish 通道**：同一个 `session/new` 的 `mcpServers` 让 agent 自己拉起 `node-finish-mcp.js`。adapter 等 `firstContact`（hello）与 `discovered`（tools/list）都成立才进入 prompt；否则 `NODE_FINISH_TOOL_UNAVAILABLE`，节点零派发。
- **轮次**：提示词由节点的 `prompt` / `roleCard`、`description` 补充、`attempt`、`variables`、工作区路径与强制 finish 契约组成；同一 session 严格串行，提醒也是同一连接、同一 session 的新 prompt，不使用 `session/load` 或跨执行复用会话。
- **超时**：控制请求（`initialize` / `session/new` / `session/set_mode` / `session/close`）默认各 10s；等 agent 拉起 finish MCP 的 hello / discovery 也默认 10s；`session/prompt` 不设单请求超时（风险由执行器的活动 deadline 承担）；连接关闭等待 1s。这些是内部常量，不是公开配置。
- **handle**：`pid`、`sessionId`、`reminders`、`exited`、`usageCalls()`、`usageSnapshots()`、`diagnostics`、`cleanup`、`cleanupFinal`、`cancel(reason)`、`dispose()`；`usage` 恒为 `undefined`，不把 prompt usage 回填到 `handle.usage` / `outcome.usage`。

## 3 probe 的四层证据

`probe()` 先做本地桥自检，再起一个**独立临时** gate / channel 与一个临时 agent 会话；只做协商和 discovery，**不发 prompt**。四层证据按能力标记逐层收紧：

| 层 | 做什么 | 证明什么 | 失败表现 |
|---|---|---|---|
| ① ACP 会话 / 模式协商 | `initialize`（v1）+ `session/new`（绝对 cwd + 真实 finish `mcpServers`）+ `session/set_mode` | agent 能按 v1 建会话，目标 mode 真实可用 | `ADAPTER_PROBE_INVALID`，`details.reason` 取 `probe-timeout` / `mode-unavailable` / `agent-exited` / `handshake-failed` 等 |
| ② 本地桥自检 | `verifyFinishBridge`（initialize / tools.list / tools.call） | 我们自己的 MCP server 与 gate 往返正常 | `ADAPTER_PROBE_INVALID`，`details.reason:'bridge-failed'` |
| ③ agent 拉起 finish MCP 并发现工具 | agent 侧 `firstContact`（hello）+ `discovered`（tools/list） | agent 真的装载了 `flow_finish_node`，模型能看到它 | `ADAPTER_PROBE_INVALID`，`details.reason` 取 `agent-mcp-not-contacted` / `agent-mcp-not-discovered`；`start` 则表现 `NODE_FINISH_TOOL_UNAVAILABLE` |
| ④ 模型真实调用 finish | 真实模型调用一次 `flow_finish_node` 并让 gate 受理 | 只有这一层才证明「模型可用完结工具」 | **当前未验证**：需要真实 `codex-acp 2.6.0` 冒烟；fake agent 与 18 帧重放都不算 |

- 只有 ①–③ 同时成立，`capabilities().finishTool` 才是 `native`；否则是 `unsupported`，`start` 在 admission 阶段拒绝，不派 prompt。
- probe 成功结果缓存 10 分钟；缓存只保存成功且不含 session 凭据。`invalidateProbe()` 递增 generation，迟到的 probe 结果不会复活缓存；过期后能力立即降级。
- probe 返回 `{version, helpDigest, protocolVersion:1, agentInfo, loadSession, closeSupported, bridge:{ok:true}, agentMcp:{contacted:true, discovered:true}, probedAt}`；`helpDigest` 是能力 / 版本投影的 sha256 前 40 个十六进制字符，不含秘密。
- 私有目录 `0700`、socket `0600`；Unix socket 路径超限时直接 `NODE_FINISH_TOOL_UNAVAILABLE`，**不退到 `/tmp`**。
- probe 的权限回调固定按「未绑定 session」处理，任何权限请求都回 `cancelled`；probe 不消费模型，也不产生 `agent/invocation`。

## 4 完结与提醒

- **唯一成功信号是 gate 受理**。agent 自然停下、`stopReason:"end_turn"`、进程退出都不算完结；没有受理记录就按终态错误分类，不解析文本猜结论。
- `end_turn` 且 gate 未受理时，由 finish channel 的 `invoke('remind')` 计一次提醒并在同一连接 / session 再发一轮提示词，默认最多 3 次；提醒文本用 `FINISH_REMINDER_TEXT`，不需要 `session/load`。提醒计数只归 channel，adapter 只接 `reminder.onFire`。
- 提醒用尽 → `NODE_FINISH_MISSING`；channel 不可用或提醒调用失败 → `NODE_FINISH_CHANNEL_FAILED`。provider 终态错误不消耗提醒预算。
- 终态分类顺序：gate 已受理 → 成功；显式取消 → `NODE_FINISH_CANCELED`；finish 工具握手前失败 → `NODE_FINISH_TOOL_UNAVAILABLE`；握手后按错误映射（未知 `stopReason` → `ACP_PROTOCOL_ERROR`，`refusal` → `ACP_PROVIDER_ERROR`，`max_tokens` / `max_turn_requests` → `ACP_LIMIT_REACHED`，`cancelled` → `NODE_FINISH_CANCELED`）。
- 提醒耗尽之前，已受理的成功不会被迟到的 cancel 改写；取消只负责清理，不重写业务结局。
- gate 受理成功后，adapter 仍最多再等 5s 收 prompt 尾部响应以拿尾 usage；超时按 unknown 收尾，但节点仍然成功。
- `deliverMessage()` 固定返回 `{ok:false, unsupported:true, deliveryUnknown:true, code:'ACP_MESSAGE_DELIVERY_UNSUPPORTED'}`；不注册 inbox 工具，也不声称支持轮次中投递。

## 5 权限策略

- 配置默认 `mode:'workspace-write'`、`permissionPolicy:'deny'`。`mode` 只控制 agent 自己的执行策略，`session/request_permission` 是逐请求兜底，两者不能互相替代。
- `deny` 只在选项里找 `reject_once`，`allow` 只找 `allow_once`；匹配到就原样回传该 `optionId`，没有匹配、请求已取消或 session 不匹配一律回 `{outcome:{outcome:'cancelled'}}`。
- **永不**选择 `allow_always` / `reject_always`，也**不读** `option.name` 推断授权；取消态全部 `cancelled`，不等人。
- 每个权限请求恰好一次应答；每个请求 id 恰好一次有效决策（一次 `onPermission` 回调 / 一条 `agent/permission` 事件）。同一 JSON-RPC id 重复到达时仍回一条应答（避免对端 pending 悬挂），但固定回 `{outcome:{outcome:'cancelled'}}`，不再触发策略判定，只计 `permissionDuplicates` + `permission-duplicate` 诊断；去重集合有界（256 条）。
- 结局已定（gate 已受理或已 abort）或已进入关停流程后，任何权限请求一律 `{outcome:{outcome:'cancelled'}}`，`agent/permission` 事件的 `decision` 为 `cancelled`：`finishTailGrace` 尾窗内到达的请求也不会再按 `allow` / `deny` 策略授权。取消后到达的请求同样回 `cancelled`。每次决策投影成 `agent/permission` 事件，字段见 [10 · ACP 适配器事件](10-bpmn-instance-api.md#51-acp-适配器事件)。
- ACP 客户端**不是 OS 沙箱**：`deny` 不等于隔离 agent 已有配置、hooks 或自带工具；安全边界仍是受信任的启动命令 / 环境与 agent 自身的沙箱。

## 6 清理与取消

- `cancel(reason)` 幂等：先封住 gate、停止新 prompt，再发 `session/cancel` 通知；之后到达的权限请求全部回 `cancelled`，有界等 500ms 尾响应（期间继续读 update / 尾 usage），收账本，关闭连接，最后整组 `TERM → KILL`。
- **清理次序**：关连接（1s）→ destroy stdio → 进程组 TERM → 等 3s → KILL → 关 channel → 释放资源 → 删除私有 runDir。所有等待都有界，不无限挂住。
- 已受理的成功结果优先于迟到的 cancel；尚未受理的取消收 `NODE_FINISH_CANCELED`，执行器再映射成 `BPMN_ABORTED`。
- `dispose()` 幂等：未收口时先 `cancel('dispose')`，再等 `killTimeout + 1s`；仍未确认整组退出就按取消收口，并让 `cleanup.disposed=false` 如实报告，不靠 leader 退出假释放。
- `cleanup` 是资源快照：已清干净为 `{disposed:true, resources:{released:true, pending:[]}}`；未确认时为 `{disposed:false, pending, processes, resources, reason}`。`cleanupFinal` 有界盯守（默认 8s，5–60s 区间）直到整组与资源都释放或超时，槽位释放以它为准。
- 私有目录权限 `0700`、socket `0600`；路径过长直接按 finish 工具不可用拒绝，不退到 `/tmp`。

## 7 错误码索引

完整触发条件与位置见 [实例域接口 · ACP 适配器错误码](../reference/instance-api.md#acp-适配器错误码)。本文只给索引：

| 前缀 | 码 | 一眼结论 |
|---|---|---|
| 配置 | `ACP_CONFIG_INVALID` | `FLOW_STUDIO_ACP_CONFIG` 非法；不派 prompt |
| 模式 | `ACP_MODE_UNAVAILABLE` | mode 不在 `availableModes` 或 `set_mode` 失败 |
| 认证 | `ACP_AUTH_REQUIRED` | JSON-RPC `-32000`，需要先登录 |
| 会话 | `ACP_SESSION_NOT_FOUND` | JSON-RPC `-32002`，会话不存在 |
| 协议 | `ACP_PROTOCOL_ERROR` | 版本 / 外壳 / 响应形状 / 未知 `stopReason` / 超长帧 / 连接已关 |
| provider | `ACP_PROVIDER_ERROR` | 其它 RPC（含 `-32603`）或 `refusal` |
| 预算 | `ACP_LIMIT_REACHED` | `max_tokens` / `max_turn_requests` |
| 超时 | `ACP_REQUEST_TIMEOUT` | 控制请求超过时限，连接被收口 |
| 进程 | `ACP_PROCESS_EXITED` | stdio EOF / 子进程异常退出 |
| 完结 | `NODE_FINISH_CANCELED` / `NODE_FINISH_MISSING` / `NODE_FINISH_CHANNEL_FAILED` / `NODE_FINISH_TOOL_UNAVAILABLE` / `NODE_FINISH_ABORTED` | `-32800` / `cancelled`、提醒耗尽、通道失败、工具通道不可用、gate abort |
| 适配器 | `ADAPTER_INVALID` / `ADAPTER_PROBE_INVALID` | handle / 请求形状不合法；probe 失败（真实分类在 `details.reason`） |
| 消息 | `ACP_MESSAGE_DELIVERY_UNSUPPORTED` | 首发的 `deliverMessage()` 固定不支持 |

执行器的再映射：`NODE_FINISH_CANCELED` → `BPMN_ABORTED`；活动 deadline 到点 → `BPMN_ACTIVITY_TIMEOUT`；admission 的 probe 失败 → `NODE_FINISH_TOOL_UNAVAILABLE`。

## 8 明确不做

- 不实现 ACP v2，不实现 `fs` / terminal / elicitation，不做 authenticate / UI 登录，不做 `session/list` / `delete` / `resume` / `load`，不做跨执行复用会话、自动重连或自动重发 prompt，不做模型 / 思考档设置，不自动下载 agent。
- 不新增开关、灰度百分比或 CLI 预设系统；灰度入口只有节点显式 `adapter:"acp"`，默认适配器仍是 `dsh`。
- 不退役或重构 Claude / Codex，不新增共享 finish 状态机，不改 gate / schema / metrics scope 枚举，不为 ACP 猜模型调用数或价格，不从 `_meta.quota` 二次计费。
- 不做 UI adapter 下拉 / 模板改动，不新增 HTTP 配置入口或实例内秘密配置，不把 `permissionPolicy:'deny'` 宣称为宿主隔离，不假装 inbox native。
