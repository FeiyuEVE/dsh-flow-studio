# 09 · Agent 适配器与生命周期 hook 抽象（0.13 §4 研究交付）

> 状态：研究稿，供 `docs/plan/0.13-bpmn引擎与适配器.md` §4 定稿；不改任何代码。
> 证据口径：本机 `codex 0.167.0` 的 `--help` / 实跑 / 二进制字符串；Claude Code 本机未安装（`which claude` = 127），只引官方文档；DSH 引本仓库 file:line。
> **关键更正**：codex 0.167 已有原生 hook（`hooks.json` / `[hooks]`），「codex 无 hook」的前提已过期；差异在事件面、阻断/改写能力与信任模型，不在有无。

## A 实测事实

| 能力 | Codex CLI | Claude Code | DSH（宿主） |
|---|---|---|---|
| 非交互执行 | 支持 `codex exec`（别名 `e`）：prompt 走 argv 或 stdin，`-C`、`-s read-only\|workspace-write\|danger-full-access`、`-a never\|on-request`、`-m`、`-p <profile>`、`-c k=v`、`--ephemeral`、`--skip-git-repo-check`、`--ignore-user-config`、`--add-dir`、`-i` | 支持 `claude -p`；`--permission-mode`、`--allowedTools/--disallowedTools/--tools`、`--add-dir`、`--max-turns`、`--settings`、`--setting-sources`、`--agents`、`--plugin-dir`、`--bare` | 支持 `ctx.agents.create()/resume()`（`packages/core/agent/src/index.ts:416/435`），节点即 agent 会话 |
| 结构化输出 | 支持 `--output-schema <FILE>`（strict JSON Schema，须补 `additionalProperties:false`；本仓库 `executor.js:220` 已做归一化）+ `-o` | 支持 `-p --json-schema`，schema 无效即报错退出 | 部分：无 schema 约束解码，现有引擎靠提示词约定 + 解析（`engine.js:1531`） |
| 流式事件 | 支持 `--json` JSONL：`thread.started` / `turn.started` / `item.completed` / `turn.completed`（实测）；item.type 有 `agent_message`、`error`、`command_execution`、`file_change`、`mcp_tool_call`（二进制 `ThreadItemPayload`） | 支持 `-p --output-format stream-json`（`--verbose`、`--include-partial-messages`、`--include-hook-events`、`--forward-subagent-text`） | 支持 `agent/assistant-stream`、`agent/status`、`agent/inbox/*`（`packages/core/agent/src/runtime-types.ts:309-340`） |
| 会话续跑 | 支持 `codex exec resume --last\|<SESSION_ID>`（`thread.started.thread_id` 即 key）；另有交互式 `codex resume`、`codex fork` | 支持 `-c/--continue`、`-r/--resume <id\|name>`、`--fork-session`、`--session-id` | 支持 `agents.resume({resumeSessionId, setup})`；`sessionId` 即 key |
| 系统提示 / 角色注入 | 支持 `-c developer_instructions="…"`（实测注入为 developer message）；AGENTS.md 作为 user message 注入；profile 文件 `~/.codex/<name>.config.toml` | 支持 `--system-prompt(-file)`、`--append-system-prompt(-file)`、`--append-subagent-system-prompt`；`CLAUDE.md`、output styles | 支持 `ctx.systemPrompt.section({...})`（`packages/core/system-prompt/src/index.ts:485`）；`setup` 里注册 |
| skills 注入 | 支持：prompt 里注入 skill 目录表（实测 `r0=~/.codex/skills`、`r1=~/.agents/skills`），按需读 `SKILL.md`，初始列表默认 ≤2% 上下文；`[[skills.config]]` 可禁用；插件可带 skills | 支持：`~/.claude/skills/<name>/SKILL.md`、`.claude/skills/…`、插件 `skills/`；SKILL.md frontmatter + 渐进披露 | 支持：`ctx.skills` 注册表 + `dsh-skill-filesystem` + `dsh-tool-skill`（`packages/skill/skill/README.md`） |
| 生命周期 hook | 支持（0.167 原生）：`SessionStart/End`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`Stop`、`SubagentStart/Stop`、`Pre/PostModelRequest`、`Interrupt`；源 `~/.codex/hooks.json`、`[hooks]`、`<repo>/.codex/`、managed、plugin | 支持（原生）：`SessionStart/End`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse(+Failure)`、`PostToolBatch`、`Stop(+Failure)`、`SubagentStart/Stop`、`Pre/PostCompact`、`Notification`、`InstructionsLoaded`、`FileChanged`、`TeammateIdle` 等 | 支持（宿主扩展点）：`agent/created`、`agent/pre-step`、`agent/turn-stopping`、`tools/pre-execute`、`tools/post-execute`、`agent/error` 等；且已有 codex/claude 桥参考实现（见 A-3） |
| hook 阻断 | 支持：exit 2 + stderr；`PreToolUse` 返回 `permissionDecision:"deny"`；`UserPromptSubmit` 返回 `decision:"block"` | 支持：exit 2；`PreToolUse.permissionDecision` = deny/ask/defer | 支持：`agent/pre-step` 返回 reject、`tools/pre-execute` 返回 deny/ask（`packages/core/tools/src/events.ts:18`） |
| hook 改写入参 | 支持：`PreToolUse` 的 `updatedInput`（须配 `allow`） | 支持：`PreToolUse.updatedInput` | **不支持**：`HookOutput.updatedInput` 仅解析不生效（`packages/experimental/hook-protocol/README.md` 限制节） |
| hook 改写输出 | 部分：`PostToolUse` 的 `decision:"block"` 可替换工具结果并让模型继续 | 部分：`PostToolUse` 可阻断并附加 `additionalContext`；MCP 输出改写未支持 | 部分：`tools/post-execute` 可阻断并附反馈，无输出替换原语 |
| hook 异步 / 超时 | 支持 `async:true`（后台，8 并发/会话）；默认 600s，`SessionEnd`/`Interrupt` 1s（上限 3s） | 支持 `async`/`asyncRewake`；默认 600s，`UserPromptSubmit` 30s，`SessionEnd` 共享 1.5s 预算 | 同步为主；桥只跑同步 command hook；`hook-protocol` 超时经 `dsh-shell` 执行器 |
| 子 agent / 团队 | 支持原生多 agent：`spawn_agent`/`send_input`/`resume_agent`/`close_agent`/`list_agents`，`multi_agent_mode` 控制主动委派（实测 prompt 注入 + 二进制工具面） | 支持 subagents（`.claude/agents/*.md`、`--agents` JSON、Agent 工具）；agent teams 实验特性（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`），编排由主 agent 决定 | 支持：`subagent` 工具族 + 实验 `agent-team`（Lead + 具名 teammate + 任务板） |
| token 用量 | 支持：`turn.completed.usage{input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens}`；注意 input 含缓存（`executor.js:308` 口径） | 支持（stream-json 结果携带 usage；成本另有 `--max-budget-usd` 估算） | 支持：`assistant/message` 携带 `usage`（`packages/core/session/src/types.ts:355`） |
| 取消 / 中止 | 部分：`exec` 无文档化中途 API，靠进程组信号；app-server 有 `turn/interrupt`（二进制协议） | 部分：`-p` 靠进程信号；SDK 有取消能力，CLI 未列 flag | 支持：`agent.cancel(cause)`（`runtime-types.ts:212`） |
| 工具面裁剪 | 支持 `-s`、`-a`、`--ignore-rules`；无逐工具 allowlist flag | 支持 `--tools`、`--allowedTools/--disallowedTools`、`--permission-mode` | 支持：`setup` 里 `agentCtx` 注册/`restrict()` 裁剪 |

**A-1 Codex 补充**：hook 配置为三层（event → matcher group → handlers），`matcher` 恒为**不加锚的正则**；handler 只支持 `command`/`mcp_tool`（`prompt`/`agent` 解析后跳过）；非 managed hook 必须按 hash 信任，自动化可 `--dangerously-bypass-hook-trust`；项目 `.codex/` 仅在该 project 被 trust 时加载。来源：<https://learn.chatgpt.com/docs/hooks.md>、本机 `codex exec --help`、`codex debug prompt-input` 实测。
**A-2 Claude 补充**：hook 位置 `~/.claude/settings.json`、`.claude/settings.json`、`.claude/settings.local.json`、managed、插件 `hooks/hooks.json`、skill/subagent frontmatter；`matcher` 在「仅字母数字`_-,|`空格」时按精确/`|`列表，否则按 JS 正则（未锚）；exec-form（`args`）不走 shell；`SessionEnd` 不能阻断。来源：<https://code.claude.com/docs/zh-CN/hooks.md>、<https://code.claude.com/docs/zh-CN/cli-reference.md>。
**A-3 DSH 参考实现（只借语义，不 import）**：本仓库 fork（`deepseek-harness/packages/experimental/`）里已经有两套方言的桥，共享协议层——`hook-protocol/`（匹配/执行/解码/合并/`hook/*` 事件）、`hooks-codex/src/index.ts:187-262`（5 事件）、`hooks-claude-code/src/index.ts:208-296`（7 事件）。桥的映射即本设计的现实基线：`SessionStart→agent/created`、`UserPromptSubmit/PreToolUse→agent/pre-step / tools/pre-execute`、`PostToolUse→tools/post-execute`、`Stop→agent/turn-stopping`、`SubagentStart/Stop→subagent/start|end`；**`updatedInput` 不生效、`continue:false` 无 run 级效果、非 command handler 跳过**。
**但这些包没有随宿主发布**：运行中的 `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 里没有任何 `hooks-*` / `hook-protocol`（实测 `ls | grep -i hook` 为空），web profile 也没依赖它们。所以 flow-studio **不能 import**，只能照这套语义自己实现一层薄桥（协议形状照抄、事件映射照抄，代码独立）。

## B 抽象设计

### B-1 接口签名

```ts
type Support = 'native' | 'emulated' | 'unsupported'
type NormEvent = 'session.start' | 'session.end' | 'prompt.submit'
  | 'tool.pre' | 'tool.post' | 'turn.stop' | 'error' | 'before_compact'

interface Capability {
  level: Support
  /** 证据：--help 摘要 / 文档 URL / 宿主 file:line；进运行日志，禁止留空 */
  evidence: string
  /** 原生不支持时，谁在哪一层补（emulated 必填） */
  fallback?: string
}

interface Capabilities {
  hooks: Record<NormEvent, Capability & {
    canBlock: boolean; canRewriteInput: boolean; canRewriteOutput: boolean; canAsync: boolean
  }>
  systemPrompt: Capability & { mechanism: 'developer-instructions' | 'append-flag' | 'prompt-section' }
  skills: Capability & { mechanism: 'prompt-catalog' | 'filesystem' | 'registry' }
  structuredOutput: Capability
  resume: Capability & { keyKind: 'thread-id' | 'session-id' | 'none' }
  stream: Capability
  usage: Capability
  cancel: Capability
  team: Capability & { mode: 'native' | 'process-fanout' | 'none' }
  toolPolicy: Capability
  /** agent 节点完结工具 flow_finish_node 的提供能力（见 11-node-finish-tool.md） */
  finishTool: Capability
}

interface AgentAdapter {
  readonly id: string                       // 'dsh' | 'codex' | 'claude' | 'custom'
  probe(): Promise<{ version: string; helpDigest: string }>   // 启动/定时探测，缓存 TTL
  capabilities(): Capabilities
  /** 严格模式：节点要求了 unsupported 能力就直接拒绝启动（admission 阶段） */
  plan(node: NodeConfig, hooks: HookSpec[]): AdapterPlan
  start(req: StartRequest): Promise<SessionHandle>
  resume(req: ResumeRequest): Promise<SessionHandle>
  /** 把统一的 AgentInputs 落成该适配器认识的文件/参数；返回可审计的物化清单 */
  materialize(inputs: AgentInputs, plan: AdapterPlan): Promise<Materialized>
  events(h: SessionHandle): AsyncIterable<NormalizedEvent>
  cancel(h: SessionHandle, reason: string): Promise<void>
}

interface AgentInputs {
  systemPrompt?: string
  roleCard?: string
  skills: Array<{ name: string; source: 'repo' | 'node' | 'plugin'; digest: string }>
  context: string[]                        // 上游节点摘要 / 变量
}
```

### B-2 规范事件 ↔ 三种原生事件（映射表一）

| 规范事件 | Claude Code 原生 | Codex 原生 | DSH 宿主 |
|---|---|---|---|
| `session.start` | `SessionStart`（matcher: startup/resume/clear/compact/fork） | `SessionStart`（source 同左）；`thread.started` 事件可旁证 | `agent/created`（`runtime-types.ts:290`） |
| `session.end` | `SessionEnd`（reason，1.5s 预算，不可阻断） | `SessionEnd`（reason 恒 other，1s） | `agent/disposed`（`runtime-types.ts:299`） |
| `prompt.submit` | `UserPromptSubmit`（可 block） | `UserPromptSubmit`（可 block） | `agent/pre-step`（可 reject/换 messages，`runtime-types.ts:350`） |
| `tool.pre` | `PreToolUse`（deny/ask/defer/allow + `updatedInput`） | `PreToolUse`（deny + `updatedInput`）；`PermissionRequest` 管审批 | `tools/pre-execute`（deny/ask，`events.ts:18`） |
| `tool.post` | `PostToolUse` / `PostToolUseFailure` | `PostToolUse`（可 block 替换结果） | `tools/post-execute`（block/反馈，`events.ts:41`） |
| `turn.stop` | `Stop` / `StopFailure`（可 `decision:block` 继续） | `Stop`（继续 = 注入 continuation prompt） | `agent/turn-stopping`（serial；`agent.steer()` 续跑，`runtime-types.ts:417`） |
| `error` | `StopFailure`、hook 失败日志 | `turn.failed` / `item.completed.item.type=error` | `agent/error`、`agent/request-error` |
| `before_compact` | `PreCompact`（可 `continue:false` 阻止） | `PreCompact`（可阻止） | **无**：只有事后 `compaction/start` 会话事件（`known-event-types.ts:34`），只能观察 |

补充：`session.start/end` 在 Claude/Codex 里是**会话级**（跨 turn），在 DSH 里 `agent/created|disposed` 语义对齐；`SubagentStart/Stop` 不属八个规范事件，团队章节单列。

### B-3 能力降级映射表（映射表二）

| 语义 | Codex | Claude Code | DSH 宿主 | 统一降级策略 |
|---|---|---|---|---|
| 逐工具 hook | 原生（shell/apply_patch/MCP/本地函数；托管工具 WebSearch 不覆盖） | 原生（除 `@` 引用注入、EndConversation） | 原生（`tools/pre-execute`） | 不支持则只能进程级；**不得声称 tool.pre 生效** |
| 改写工具入参 | 原生 `updatedInput` | 原生 `updatedInput` | **不支持**（仅解析） | 降级为 deny+原因，或 `passthrough` 并记 `hook/degraded` |
| 阻断并让模型看到原因 | 原生 | 原生 | 原生 | 统一 `decision`：`deny \| ask \| allow` |
| hook 异步旁路 | 原生（8 并发） | 原生（async/asyncRewake） | 桥只跑同步 | 需要异步的 hook 由 flow-studio 自己的 `after` 阶段执行，不塞进适配器 |
| `before_compact` 阻断 | 原生 | 原生 | 不支持 | 仅观察 + 记降级；要阻断只能在适配器侧预检上下文预算 |
| 会话内 hook 可见性 | 协议层有 `HookStarted/HookCompleted`；`exec --json` 是否逐条输出待真跑确认（部分） | 需 `stream-json`+`--include-hook-events`（部分事件不产生） | `hook/*` 会话事件 | 可见性属 `partial`，UI 只显示「已上报」而非「全部」 |
| 团队 | 原生 `spawn_agent` 或 N 进程 fan-out | 原生 subagents；teams 实验、编排不可编程 | 原生 subagent/agent-team | 见 B-6；external CLI 一律 `process-fanout` |

**Codex 无原生 hook（<0.167 或 `[features] hooks=false`）时的合成路径**（能力从高到低，均需在能力表标 `emulated`）：

1. **进程级**：`start` 前跑 `session.start`，进程退出后跑 `session.end`；拿不到 turn/tool 边界，只能做环境准备与产物收集。
2. **事件流旁路**：解析 `--json`，把 `item.completed`（`command_execution`/`file_change`/`mcp_tool_call`）合成为 `tool.post`，`turn.completed` 合成 `turn.stop`；**无法合成 `tool.pre`**——事件到达时工具已执行。
3. **MCP 代理**：把工具调用收口到自建 MCP server 做 pre/post，只覆盖 MCP 工具，不覆盖 shell/apply_patch。
4. 因此旧版 codex 的 `tool.pre` 只能「拒绝整个节点/整轮」，不能逐工具阻断；不得把它宣传成逐工具门禁。

### B-4 hook 执行契约

- **脚本来源**：节点内联 > 仓库 `.flow-studio/hooks/<nodeId>/*` > 插件市场包；三者都带 `source`/`digest`，市场包必须 pin 版本 + 校验 digest。
- **传参**：stdin JSON（规范字段 `sessionKey`、`turn`、`tool{name,input}`、`adapter`、`cwd`、`raw`）+ 白名单 env（`FLOW_STUDIO_RUN_ID`、`FLOW_STUDIO_NODE_ID`、`FLOW_STUDIO_HOOK_EVENT`）；不注入宿主密钥。
- **超时**：阻断型 `tool.pre/prompt.submit` 默认 30s（可配 ≤120s）；观察型默认 60s；`session.end` 固定 ≤3s（对齐 Codex/Claude 的短预算）。
- **失败策略**：`strict`（失败即失败节点，用于安全门禁）/ `record`（默认，记 `hook/result` 继续）/ `retry`（仅观察型，最多 2 次）；超时永远按 `record` + 告警，不静默 `allow`。
- **能否阻断 / 改写**：只有 `canBlock` 的事件可返回 deny；改写仅在 `canRewriteInput` 时接受，否则写 `hook/degraded{reason:'adapter-no-rewrite'}` 并退化为 deny 或原样放行（由节点策略决定）。
- **产物**：每次调用写 `hook/invoked` + `hook/result`（复用 DSH 的 `hook/*` 形状：handlerId、exitCode、decision、stderr 摘要、时长）；大输出落 `runs/<runId>/hooks/<seq>.txt`，只回摘要。
- **顺序与并发**：flow-studio 侧串行（config 顺序），原生侧可能并发；合并规则固定 `deny > ask > allow`、`continue:false` 粘滞，文档明确不保证跨原生 hook 的顺序。

### B-5 skills / 提示词物化

| 输入 | Codex | Claude Code | DSH |
|---|---|---|---|
| `systemPrompt` | `-c developer_instructions="<text>"`（实测为 developer message）；长文本落临时 profile | `--append-system-prompt-file <tmp>`（保留默认安全提示） | `setup` 中 `ctx.systemPrompt.section({order, content})` |
| `roleCard` | 并入 `developer_instructions` 末尾（或 profile 的 `developer_instructions`） | 同上；不要用 `--system-prompt` 整体替换 | 独立 section（角色卡与系统约束分节，便于审计） |
| `skills[]` | 生成每-run `$CODEX_HOME/skills/<name>/SKILL.md`（或指向已有目录），prompt 自动注入目录表；禁用用 `[[skills.config]]` | 生成 `$cwd/.claude/skills/<name>/SKILL.md`，或 `--plugin-dir <generated>`；无需改用户配置 | `ctx.skills.registerProvider()` 或挂 `dsh-skill-filesystem`，模型经 `skill` 工具按需加载 |
| `context[]` | 追加到 prompt 的 `<stdin>`/正文前置块 | 追加到 prompt 正文（或 `--append-system-prompt`，二选一） | `agent.steer()`/inbox 注入，或 `agent/pre-step` 拼 messages |

物化清单（`Materialized`）必须回传：写出的文件路径、命令行参数、被替换的占位符、清理动作；节点结束后按清单回收，避免污染用户 `~/.codex` / `~/.claude`。

### B-6 团队（主 agent + N 成员）

| 适配器 | 实现 | 限制 |
|---|---|---|
| DSH | Lead + `subagent` 工具 / 实验 `agent-team`（具名 teammate + 任务板）；flow-studio 可观察成员会话事件 | 成员 = 同进程 agent，可编排、可观测 |
| Codex | 原生 `spawn_agent`（要求 prompts/AGENTS.md 显式要求，`multi_agent_mode` 会压制主动委派）；或 flow-studio 起 N 个 `codex exec` 进程 by 成员 | 进程 fan-out 时 flow-studio 是唯一协调者；成员间不能直接对话（除非 app-server 多线程） |
| Claude Code | 原生 subagents（`.claude/agents/*.md` / `--agents` JSON / Agent 工具）；teams 需实验开关 | 编排由 Claude 自己决定，flow-studio 不能编程点名成员；`SubagentStart` 可加 context，`SubagentStop` 只观察 |

**硬规则**：现有 `executor.js:202` 已禁止外部 executor 走 team（`executor 为 codex 时执行方式必须是 single`）。新模型下保留这条：`dsh` 可 `native`，`codex`/`claude` 只能 `process-fanout` 且由 flow-studio 聚合，不允许假装能观测成员内部会话。

## C 迁移与风险

### C-1 从 `executor.js` 演进

1. **抽基类**：把 `runExternalExecutor`（`executor.js:640`）的进程组、超时、字节/事件上限、临时文件回收抽成 `ProcessAdapter`；codex = `CodexAdapter`（拼 argv `executor.js:266`、解析 JSONL `executor.js:359`、usage 归一化 `:308`），claude = `ClaudeAdapter`（argv + `stream-json`），custom = `CustomAdapter`（模板 + 三通道，`executor.js:577`）。
2. **dsh 收编**：`DshAdapter.start/resume` 直接调 `agents.create/resume` + `setup`，把现在散在 `engine.js:2298-2420` 的会话/路由逻辑移进适配器；`agentOptions` 归一化留在 runstore 侧。
3. **兼容层**：`EXECUTORS`（`executor.js:69`）保留为 legacy 枚举；节点新字段 `adapter` 优先，旧 `executor` 经 `normalizeExecutor` 映射到 adapter id；`custom` 永久保留为逃生门，能力表如实声明「无 tool 级 hook」。
4. **能力探测**：启动时 `probe()` 记录 codex/claude 版本与 `--help` 摘要；节点要求的能力与 `capabilities()` 不符 → `plan()` 拒绝（strict）或降级（record），UI 显示降级原因。
5. **测试**：每个适配器跑同一套 conformance（事件顺序、阻断、超时、取消、usage 口径、降级留痕）；用录制 JSONL fixture，不依赖真模型。

### C-2 安全边界（hook = 任意代码执行）

- **同沙箱**：hook 进程继承节点的沙箱/权限（codex `-s`、claude `--permission-mode`、DSH sandbox），**绝不为 hook 放宽**到宿主。
- **信任**：仓库/市场 hook 按 digest 信任（对齐 Codex 的 hash-trust）；`--dangerously-bypass-hook-trust` 只允许用于 flow-studio 自己生成、来源可证的 hook，禁止对用户提供的仓库 hook 使用。
- **最小暴露**：白名单 env、stdin 不含密钥；输出落盘 0600 + 只回摘要；hook 不能改宿主配置。
- **资源**：超时 + 进程组 kill + 输出上限 + 并发上限（避免 hook 拖垮 run）。
- **不越权**：flow-studio 进程**不**因为节点配置去执行 hook；所有执行都必须经过适配器/沙箱，且 `runId/nodeId` 进审计。

### C-3 风险清单

| 级别 | 风险 | 为什么 | 缓解 |
|---|---|---|---|
| 阻断 | 节点配置 = 宿主 RCE | hook 脚本任意执行，模板可来自仓库/市场 | 同沙箱 + digest 信任 + 白名单 env + 超时；默认 `record` 不默认放行 |
| 阻断 | 误用 `--dangerously-bypass-hook-trust` | 绕过 codex 信任审查 = 静默执行项目 hook | 该 flag 只由适配器在「hook 由本 run 生成」时加，且写审计 |
| 高 | 把 codex「无 hook」写死 | 0.167 已原生支持；按旧假设设计会重复造桥、语义冲突 | 以 `probe()/capabilities()` 为准，文档与 UI 不写死版本能力 |
| 高 | 双份 hook 同时生效 | 用户 `~/.codex` / `~/.claude` 的 hook 与 flow hook 都会跑 | 每 run 隔离 `CODEX_HOME` / `--setting-sources`，并声明「用户 hook 仍可能生效」 |
| 高 | 宣称支持改写但宿主不支持 | DSH 的 `updatedInput` 只解析不生效 | 能力表标 `unsupported`，改写请求降级 deny + `hook/degraded` |
| 高 | 团队模式不可观测 | 外部 CLI 的成员会话在进程内，flow-studio 拿不到 | 只允许 `process-fanout` 或 `single`；`executor.js:202` 的禁令保留 |
| 中 | 事件/用量口径漂移 | codex 的 `input_tokens` 含缓存；claude 只给结果级 usage | 每个适配器一个 usage 归一化函数 + 黄金样例测试 |
| 中 | 版本漂移导致 argv 失效 | CLI flag 随版本变（0.166→0.167 已变） | `probe()` 记录版本/帮助摘要；启动自检失败即拒绝该 adapter |
| 中 | 原生 hook 并发/顺序不确定 | Claude 并行、Codex 并发、DSH 串行 | 合并规则幂等（`deny>ask>allow`），不依赖顺序 |
| 中 | hook 输出污染上下文 | 大段 stdout 直接进模型 | 输出上限 + 落盘摘要（对齐 Codex spilling、DSH `hook/*`） |

### C-4 验收（填 0.13 §7 的 hook 行）

- codex：`SessionStart` 注入 context、`PreToolUse` 能 deny 一条命令、`Stop` 能续跑一次，JSONL 里能看到对应事件。
- Claude：`PreToolUse` deny + `updatedInput` 改写各一条；`SessionEnd` 不被阻断验证。
- DSH：`agent/pre-step` reject 一条、`tools/pre-execute` deny 一条；`before_compact` 明确显示「仅观察」。
- 降级：构造一个要求 `updatedInput` 的 DSH 节点，断言 `plan()` 拒绝（strict）或 `hook/degraded` 落盘（record）。
