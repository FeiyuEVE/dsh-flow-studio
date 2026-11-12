# 11 · 节点完成工具与产物约定（0.13.1 硬契约）

> 用户 2026-11-11 定调：**agent 节点必须调用约定工具才算结束**；通过这个工具给实例注入后续网关要用的变量；**节点产出的文档落文件，不要用大 JSON 或长文本字段变量**。本文把这个约定写成可实现的契约，`09-agent-adapter-hooks.md` 的 `AgentAdapter` 与它配合。

## 1 硬约定

1. **agent 节点要完结自己、让流程往后流转，只能通过调用工具 `flow_finish_node`。** 自然语言收尾、进程退出、token 用尽都不算完结——节点会一直等（直到活动超时/取消）。
2. 这个约定**与 `endEvent` 无关**：`endEvent` 是 BPMN 的结束事件，照旧由引擎处理，不要求调用任何工具。
3. 一次活动执行只接受**一次**成功调用；重复调用返回 `NODE_ALREADY_FINISHED`（幂等：同参数重放也返回该错误，不重复写产物）。
4. agent 停下来（本轮结束、进程退出）但没调用过工具 → **默认先唤醒提醒**，不是立刻失败：每个 agent 节点默认挂一个内置 `turn.stop` hook（`finish_reminder`，默认最多 3 次），由 adapter 把它唤醒并明确要求调用 `flow_finish_node`；提醒用尽仍未调用 → 节点以 `NODE_FINISH_MISSING` 停下，实例 `status` **保持 `ACTIVE`**、写 `lastError{code:'NODE_FINISH_MISSING',reminders}`，发 `error` 事件；要不要重试/终止由业务或人决定（引擎不设 failed、也不设「卡住」状态）。**禁止**把「模型说了完成」当成完成。
5. 工具调用是**流转的触发器**：`executeAgent` 拿到工具参数后返回，runner 才把该活动标记完成并评估出向连线（网关条件读的就是这次注入的变量）。
6. adapter 若无法向该 agent 暴露工具（能力表 `capabilities.finishTool` ≠ `native`），**在 admission 阶段拒绝**该节点，不允许静默降级成「看输出文本猜结论」。

## 2 工具入参

```jsonc
{
  "variables": { "verdict": "pass", "reason_code": "OK", "score": 87, "needs_review": false },
  "documents": [
    { "path": "docs/plan/0.13-方案.md", "kind": "markdown", "title": "方案", "summary": "≤200 字说明这份文档是什么" }
  ],
  "summary": "这次节点做了什么、结论是什么（≤500 字）"
}
```

- **`variables` 是后续网关条件唯一的数据来源**（FEEL 直接读实例变量）。硬限制：键 ≤32 个；值只允许 `boolean | number | string(≤512 字符) | null`；序列化后 ≤8 KiB。超限 → `NODE_VARIABLES_INVALID`，整次调用失败，节点不结束。
- **禁止**在 `variables` 里放大对象、数组、base64、文档正文、长 JSON。需要给下游看的内容一律落文件，用 `documents` 引用。
- `documents` 最多 32 份；`path` 必须是**工作区内的相对路径**（禁止绝对路径、`..` 段、反斜杠、空段，≤1024 字符——沿用 `src/runlog.js` 的 artifact 路径规则）；`kind` ≤64、`title` ≤200、`summary` ≤200。宿主用**同一文件句柄**有界读取校验：普通文件且 `nlink === 1`（硬链接一律拒绝，见下）、`realpath` 落在工作区内（防符号链接逃逸）、≤5 MiB、读到字节数与 stat 一致（校验中被改则拒），计算 `sha256` 与 `bytes`。
- `documents[].summary` 只是给人看的一句话，不承载正文；校验后**持久化进 artifact**（超 200 码点整次拒绝，不静默截断），`flow_finish_node` 返回与 `activity/end` 都能看到。
- 硬链接（`stat.nlink > 1`）一律 `NODE_DOCUMENT_INVALID`：「文档必须是工作区内的独立文件，不接受硬链接」——工作区内的路径不应指向工作区外内容的 inode。

## 3 产物怎么落

沿用平台既有约定（`src/runlog.js` 的 `artifact/write`：相对路径 + `sha256`），实例域落盘形态：

```
$DSH_HOME/flow-studio/instances/<id>/
  instance.json          # artifacts[] 索引：{ path, sha256, bytes, kind, title, nodeId, attempt, at }
  events/<shard>/<n>.jsonl
  state.json
```

- 文档正文由 agent 自己写进工作区文件（这是它本来就要做的事），宿主只登记引用。
- `flow_finish_node` 的 record 与 `activity/end` 事件的 `artifacts[]` 带引用（path/hash/bytes/kind/title/summary），事件里**不出现**文档正文；`instance.json.artifacts[]` 由运行时维护，沿用既有稳定字段投影（`summary` 只在 record / 事件里，不写进实例索引）。
- 产物校验失败（路径越界、不存在、符号链接逃逸、硬链接、超 5 MiB、校验中被改）→ `NODE_DOCUMENT_INVALID`，节点不结束；错误信息带 `path` 与原因，不打印文件内容。

## 3.1 默认的「停下来但没调工具」hook

- 节点配置里 agent 节点**默认注入**一条 hook：`{ event: 'turn.stop', kind: 'finish_reminder', maxFires: 3 }`；可由节点配置覆盖次数或关闭（关闭后行为退化为「停下来即 `NODE_FINISH_MISSING`」）。
- 触发点 = agent 本轮结束时（不是流结束、不是 token 用尽）。
- 动作 = 把提醒文本作为**新的一轮输入**送回同一个 agent 会话，让它继续调用工具；提醒轮不算节点完成，也不重置活动超时。
- 提醒文本（固定模板，可加节点上下文）：
  ```
  【必须调用工具】你还没有调用 flow_finish_node，本节点没有完结，流程不会往下走。
  现在就调用它：variables 放后续网关要用的短变量，documents 放你写下的文件相对路径，summary 一句话。
  ```
- 每次提醒写一条 handler 事件 `{ type: 'agent/reminder', count, maxFires }`（经 runner 的 handler `events[]` 透传，不是新的一等 kind），便于审计与 UI 展示。
- 提醒次数用尽 → 实例 `status` 保持 `ACTIVE`，`lastError={code:'NODE_FINISH_MISSING', reminders, sessionId?, processId?}`；是否重试/终止由业务决定。

## 4 各 adapter 怎么提供工具

| adapter | 工具通道 | 校验「必须调用」的方式 | 能力标记 |
|---|---|---|---|
| `dsh` | 子 agent 会话注册模型工具 `flow_finish_node`（`agents.create` 的 `setup` 里 `agentCtx.tools.register`，会话级可见） | 工具 handler 记一次完成；`agent/turn-stopping` 时未完成 → `agent.steer(提醒)` 唤醒（native）；提醒用尽 → `NODE_FINISH_MISSING` | `finishTool: native`，`hooks['turn.stop']: native` |
| `codex` | 插件自带 MCP stdio server 暴露同名工具，`codex exec` 配置 `mcp_servers` 指向它 | 工具调用记完成；原生 `Stop` hook（0.167+）注入提醒（native）；无 hook 能力时用 `codex exec resume <session>` 重发提醒（emulated，进程级）；**握手之后 CLI 报 `turn.failed` / 异常退出 / 非零退出码 / 被信号终止 → `CODEX_CLI_TURN_FAILED` / `CODEX_CLI_ERROR` / `CODEX_CLI_EXIT_NONZERO` / `CODEX_CLI_SIGNALED`，不消耗提醒预算**；提醒用尽 → `NODE_FINISH_MISSING` | `finishTool: native`（probe 必须实测 MCP），`hooks['turn.stop']: native/emulated` |
| `claude` | 同一个插件自带 MCP stdio server，`claude -p` 用本次进程的 `--mcp-config <0600 文件>` + `--strict-mcp-config` 加载它；凭据只在该文件与子进程 env 里 | 工具调用记完成；默认 `claude -p --resume <session-id>` 进程级续跑（emulated，与 native Stop hook 共用同一个提醒计数）；**握手之后 CLI 自己给出终态错误（认证失败 / result `is_error` / 非零退出码 / 被信号终止）→ `CLAUDE_PROVIDER_ERROR`，`error.code` 形如 `cli-result-error` / `cli-assistant-error` / `cli-exit-nonzero` / `cli-signaled`，不消耗提醒预算**；提醒用尽 → `NODE_FINISH_MISSING` | `finishTool: native`（probe 必须实测参数面 + 桥自检），`hooks['turn.stop']: native/emulated`，`usage: native`（调用走 `claude-usage-ledger`，`result.usage` 是范围级结算快照） |
| 其它/旧版 | 无 | admission 拒绝 | `finishTool: unsupported` |

Claude 的非交互调用在 probe 确认 `--disallowedTools` 后，argv 会带 `--disallowedTools AskUserQuestion`（`-p` 运行没有人能回答提问）；CLI 不支持时**不传**该参数，`capabilities().evidence.nonInteractive` 如实标注「未禁用」，不谎称支持。它是可选探测，不进必需参数表。

### 4.1 终态错误分类（0.14.6）

退出分类有严格顺序，先看**闸门是否已受理**，再看取消：

1. `finishGate` 已受理 → 成功。已经受理的结果优先于迟到的 `cancel`；`cancel` 只负责清理进程，不把业务结局改写成 `NODE_FINISH_CANCELED`。
2. 闸门被 abort 且实例已取消 → `NODE_FINISH_CANCELED`。
3. 没有受理记录、且失败发生在**握手之前** → `NODE_FINISH_TOOL_UNAVAILABLE`（保留原原因）。
4. 握手之后 CLI 给出终态错误 → provider 错误码，**不消耗提醒预算**：
   - Claude：`CLAUDE_PROVIDER_ERROR`，`error:{code, subtype?, message}`；`code` 形如 `cli-result-error`（`result.errors[0]` / assistant 错误）、`cli-assistant-error`（只有 assistant 消息带 `error`、没有 result 事件、退出码 0，如 `authentication_failed`）、`cli-exit-nonzero`、`cli-signaled`（SIGKILL / OOM / 外部 kill），`subtype` 是 CLI 的 result subtype 或 assistant 错误名。
   - Codex：`CODEX_CLI_TURN_FAILED` / `CODEX_CLI_ERROR`（`turn.failed` / 异常退出）、`CODEX_CLI_EXIT_NONZERO`、`CODEX_CLI_SIGNALED`；`errorDetails:{kind, cliCode}` 保留分类与脱敏后的 CLI 原始码。
5. 只有正常停下、通道可用、没有终态错误才提醒 / 续跑；提醒预算耗尽才是 `NODE_FINISH_MISSING`。

被信号终止的 CLI 不会被当成「没调用 finish」：Claude 被 SIGKILL 是 `CLAUDE_PROVIDER_ERROR` + `error.code:"cli-signaled"`、0 次提醒；Codex 是 `CODEX_CLI_SIGNALED`。

### 4.2 终态错误的脱敏与 1000 字节上限（0.14.6）

provider 错误文本不可信（CLI 可能把凭据或 12 KB 文本塞进 `errors[0]` / `code` / `subtype` / `result`）。终态错误的唯一出口是：

1. 共享 `process-output.redactText()`：`Authorization: Bearer / Basic / Token`、`--token` / `--api-key` 标志位、`sk-` 前缀、`key: value` / `key=value`、超长可疑串；
2. 本 execution 的**精确秘密替换**：通道凭据、socket 路径、runDir → `[redacted]`；
3. UTF-8 **字节**截断（不是 UTF-16 `slice`），带 `…[truncated]` 标记；Claude 的 `code` / `subtype` 各 ≤200 字节、`message` ≤1000 字节；Codex 的 `cliCode` ≤200 字节、`reason` ≤300 字节、最终 `message` ≤1000 字节。

覆盖 `handle.exited` 的 `error` / `errorDetails`、`handle.terminalError` 与 diagnostics 里的终态错误。runtime 的 8 KiB 事件裁剪是另一层（更宽、不脱敏），不能替代这里的脱敏与字节上限；`handle` / executor 拿到的异常本身也已是有界、脱敏的。

### 4.3 启动失败：清理与已观测用量（0.14.6）

- **资源所有权边界**：Codex 的 runDir 一创建就登记进资源 registry；写 hook、建完成通道与 listener、构造参数、**同步 `spawn`**、MCP 握手都在保护块内。启动失败统一 abort 闸门 → 整组 TERM→KILL 并确认 → 关 channel / 撤 listener / 删 runDir，并在错误对象上挂 `cleanup` / `cleanupFinal`。不再出现「start 抛错但临时目录 / MCP server 残留」。
- **命令行过长 ≠ 没有工具通道**：Claude 启动时 Linux `E2BIG`（或 Windows `ERROR_FILENAME_EXCED_RANGE` / errno 206，Windows 未实测）是输入规模问题 → 独立 `CLAUDE_ARGV_TOO_LARGE`（`details.reason='argv-too-large'`，带 prompt / argv 字节数与「改用 `documents` / 缩短输入」hint），清理路径与其它启动失败相同；ENOENT / EACCES 等普通 spawn 失败仍是 `NODE_FINISH_TOOL_UNAVAILABLE`。
- **失败载体带用量**：`start()` 在返回 handle 之前失败时，适配器把已观测的调用 / 结算快照挂到错误对象上：`error.usageCalls[]` / `error.usageSnapshots[]`（`readAdapterUsageCalls` / `readAdapterUsageSnapshots` 同时接受数组和函数）。`agent-execute` 在 `finally` 里从 `failure.cause` 取同一份载体，落成 `agent/usage` / `agent/usage-snapshot` 事件；一条都没有就不挂空账本。
- **不伪造调用事实**：只有已经拿到 handle 的轮次，才在「适配器宣称能观测却一条 usage 都没有」时写 unknown 占位；握手前失败没有真实启动轮次，不补 synthetic 调用。

### 4.4 `sessionId` 的诚实性（0.14.6）

Claude 适配器对外返回的 `handle.sessionId` / `exited.sessionId` 只能是：CLI 自己在事件里报过的 `session_id`，或**本次确实拼进 `--session-id`** 的 UUID（probe 确认该参数可用时才生成）。probe 不支持 `--session-id`、CLI 也不报 session 时返回 `undefined`，不会对外暴露一个从未传给 CLI 的随机 UUID；没有可续跑的 session id 时不假装续跑，按 `NODE_FINISH_MISSING` 收口。Codex 的 session id 来自 `thread.started` 的 `thread_id`。

**证据层次（0.14.5 N1，别把这三层混为一谈）**

| 层次 | 做什么 | 归谁 | Claude 当前状态 |
|---|---|---|---|
| ① 参数探测 | `claude --version` / `--help`，用**唯一参数要求表**核对 `-p` / `--output-format` / `--verbose` / `--mcp-config` / `--strict-mcp-config` / `--permission-mode` / `--allowedTools`（或 `--allowed-tools`）/ `--resume` | `probe()`，缺任一项直接拒绝 | 已用假 CLI 夹具验证探测与拒绝逻辑 |
| ② 桥自检 | `verifyFinishBridge()`：官方 MCP SDK 跑一次**我们自己的** stdio server（initialize / tools.list / tools.call） | `probe()`（`selfTest`） | 已验（真实 MCP 往返） |
| ③ 真实 CLI 握手 + finish | 真实 `claude -p` 是否拉起本插件的 MCP server、模型是否真的调用 `flow_finish_node` | `scripts/claude-smoke.mjs`（有 CLI 的机器） | **未验证**：本机没有 claude CLI，smoke 明确 `skipped:true`，不代表通过 |

> **真实 Claude CLI 未验证。** 当前证据来自合成 stream-json、真实子进程、真实 MCP/gate 往返；真实 CLI 的 stream-json 版本差异、`--resume` 的用量范围、native Stop hook 的装载与时序、以及 Windows 清理行为都还没有实测。协议或作用域不符合预期时，适配器保留诊断并把相关指标降级为部分观测或未知，不推测完成或完整用量。

工具调用与活动生命周期的关系：`executeAgent` **不返回**直到工具被调用（或失败/超时/取消）。因此 runner 的活动超时照常生效，超时 → `BPMN_ACTIVITY_TIMEOUT`，同时 abort 会话。

## 5 与 runner / 运行时接口的关系

- runner 侧不需要知道工具：`executeAgent(element, ctx)` 的返回值携带 `{ output, usage, artifacts, events }`（现有契约已支持 `artifacts`），其中 `output` **只含短变量**，`artifacts` 只含引用。
- 运行时把它们合并：`variables` 只合并 `output`（短标量），`artifacts` 写进 `instance.json.artifacts[]`；`instance.result` 在 `process/end` 时取最后一次 agent 节点的 `output`（`endEvent` 不产生输出）。
- 网关条件只读 `variables`，因此条件里永远不可能出现文档正文——这也是「大 JSON 不进变量」这条约定在引擎侧的自然结果。

## 6 与会话提示词的配合

adapter 必须把「怎么完结当前节点」写进节点提示词（不是可选项）：

```
做完本节点的活、要往下流转时，必须调用工具 flow_finish_node：
  variables  后续网关要用的短变量（标量）
  documents  你写下的文件的相对路径清单（正文在文件里，不要塞进 variables）
  summary    一句话说明本节点做了什么
不调用该工具就不算完结，流程不会往下走。
```

## 7 验收（0.13.1 必须有的）

1. 正常：agent 调工具 → 节点完结、`activity/end` 带 `output` 与 `artifacts`，实例变量里能看到注入的 `verdict`，网关按它路由到正确的下一条连线；
2. 不调工具：会话正常结束（提醒用尽）→ 实例 `status==='ACTIVE'` 且 `lastError.code==='NODE_FINISH_MISSING'`（既不 done，也没有 failed/blocked 状态可判）；
3. 变量超限：塞 9 KiB 或嵌套对象 → `NODE_VARIABLES_INVALID`，节点不结束；
4. 文档不存在 / 路径越界 / 符号链接逃逸 / 硬链接 / 超 5 MiB → `NODE_DOCUMENT_INVALID`；
5. 重复调用 → `NODE_ALREADY_FINISHED`，产物索引不重复；
6. 超时中断：工具从未调用且活动超时 → `BPMN_ACTIVITY_TIMEOUT` 且会话被 abort（不是挂住）。
7. 提醒：agent 停下来没调工具 → 收到一次提醒并被唤醒；调用后正常完结，事件流里有 `agent/reminder`（count=1），实例状态不变（不 blocked、不 failed）。
8. 提醒用尽：前 3 次停下各发 1 条 `agent/reminder`（count=1..3）；**3 次提醒用尽后的下一次停下**（第 4 次）才以 `NODE_FINISH_MISSING` 停下，实例仍 `ACTIVE`、`lastError.code='NODE_FINISH_MISSING'`（`reminders:3`）；把 maxFires 配成 0 时，第一次停下就直接记 lastError。
